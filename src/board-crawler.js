import { readStoredSession } from "./auth.js";
import { addCrawlerUrl, deleteCrawlerUrl, fetchCrawlerUrls, normalizeCrawlerUrl, startSiteCrawl, fetchSiteCrawl } from "./board-crawler-api.js";

export function mountBoardCrawler(getBoard, syncSession) {
  const form = document.querySelector("#crawler-url-form");
  const input = document.querySelector("#crawler-url");
  const add = form.querySelector("[type=submit]");
  const list = document.querySelector("#crawler-urls");
  const status = document.querySelector("#crawler-status");
  const error = document.querySelector("#crawler-error");
  const retry = document.querySelector("#crawler-retry");
  let key = null;
  let generation = 0;
  let urls = [];
  let loading = false;
  let loaded = false;
  let saving = false;
  let pollTimer = null;
  const starting = new Set();
  const crawlErrors = new Map();
  const rowElements = new Map();
  const active = job => job && ["queued", "running"].includes(job.state);
  const failureMessages = {
    robots_blocked: "Crawling is blocked by robots.txt.", robots_unavailable: "Could not read robots.txt. Try again later.",
    no_articles: "No article feed, sitemap entries, or article links found.", unsafe_url: "This URL cannot be crawled.",
    unsafe_redirect: "The site redirected to an unsupported URL.", site_unavailable: "The site is unavailable. Try again later.",
    crawl_timeout: "The crawl timed out. Try again.", crawl_limit: "The crawl reached its request limit. Try a more specific feed URL.",
    crawl_dns_failed: "The site's hostname could not be resolved.", crawl_tls_failed: "Could not establish a secure HTTPS connection to the site.",
    crawl_connection_failed: "Could not connect to the site. Try again later.",
    document_too_large: "The site's response is too large. Try a feed URL.", invalid_feed: "The site returned an unsupported feed.",
  };

  function crawlStatus(row) {
    if (crawlErrors.has(row.id)) return crawlErrors.get(row.id);
    if (starting.has(row.id)) return "Queueing crawl…";
    const job = row.crawl;
    if (!job) return "";
    if (job.state === "queued") return "Crawl queued…";
    if (job.state === "running") return "Checking for new articles…";
    if (job.state === "succeeded") return job.added_count ? `Added ${job.added_count} article${job.added_count === 1 ? "" : "s"}.` : "No new articles.";
    return failureMessages[job.error] ?? "The crawl failed. Try again.";
  }

  function currentKey() {
    const board = getBoard();
    const session = readStoredSession();
    return session && board?.user_id === session.user.id ? `${board.id}:${session.token}` : null;
  }

  function current(version) {
    return version === generation && key !== null && key === currentKey();
  }

  function updateControls() {
    const disabled = !key || key !== currentKey() || loading || saving || !loaded;
    input.disabled = disabled;
    add.disabled = disabled || !input.value.trim();
    for (const row of urls) {
      const controls = rowElements.get(row.id);
      if (!controls) continue;
      const busy = starting.has(row.id) || active(row.crawl);
      controls.crawl.disabled = disabled || busy;
      controls.remove.disabled = disabled || busy;
      controls.crawl.textContent = busy ? "Crawling…" : "Crawl";
      controls.status.textContent = crawlStatus(row);
    }
    form.setAttribute("aria-busy", String(saving));
    list.setAttribute("aria-busy", String(loading));
    add.textContent = saving ? "Saving…" : "Add URL";
  }

  function render() {
    rowElements.clear();
    list.replaceChildren(...urls.map(row => {
      const item = document.createElement("li");
      const content = document.createElement("div");
      content.className = "crawler-url-content";
      const link = document.createElement("a");
      link.href = row.url;
      link.textContent = row.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const rowStatus = document.createElement("p");
      rowStatus.className = "crawler-row-status";
      rowStatus.setAttribute("role", "status");
      content.append(link, rowStatus);
      const crawl = document.createElement("button");
      crawl.type = "button";
      crawl.className = "crawler-url-crawl create-secondary";
      crawl.textContent = "Crawl";
      crawl.setAttribute("aria-label", `Crawl ${row.url}`);
      crawl.addEventListener("click", () => crawlSite(row));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "crawler-url-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${row.url}`);
      remove.addEventListener("click", () => removeUrl(row, remove));
      rowElements.set(row.id, { crawl, remove, status: rowStatus });
      item.append(content, crawl, remove);
      return item;
    }));
    updateControls();
    schedulePoll();
  }

  function schedulePoll(delay = 1500) {
    if (!key || pollTimer !== null || !urls.some(row => active(row.crawl))) return;
    pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    pollTimer = null;
    const version = generation;
    let retryDelay = 1500;
    for (const row of urls.filter(row => active(row.crawl))) {
      if (!current(version)) break;
      try {
        const job = await fetchSiteCrawl(getBoard(), row.id);
        if (!current(version)) return;
        row.crawl = job;
        crawlErrors.delete(row.id);
        if (job?.state === "succeeded" && job.added_count > 0) {
          window.dispatchEvent(new CustomEvent("boardmessageschange", { detail: { slug: getBoard().slug } }));
        }
      } catch {
        if (!current(version)) { syncSession(); return; }
        crawlErrors.set(row.id, "Crawl status unavailable. Retrying…");
        retryDelay = 5000;
      }
      updateControls();
    }
    if (current(version)) schedulePoll(retryDelay);
  }

  async function crawlSite(row) {
    if (!current(generation) || saving || starting.has(row.id) || active(row.crawl)) return;
    const version = generation;
    starting.add(row.id);
    crawlErrors.delete(row.id);
    updateControls();
    try {
      const job = await startSiteCrawl(getBoard(), row.id);
      if (!current(version)) return;
      row.crawl = job;
      schedulePoll();
    } catch (cause) {
      if (current(version)) crawlErrors.set(row.id, cause.message);
    } finally {
      if (version === generation) {
        starting.delete(row.id);
        updateControls();
        if (key !== currentKey()) syncSession();
      }
    }
  }

  async function load() {
    const version = generation;
    loading = true;
    loaded = false;
    error.textContent = "";
    status.textContent = "Loading URLs…";
    retry.hidden = true;
    updateControls();
    try {
      const rows = await fetchCrawlerUrls(getBoard());
      if (!current(version)) return;
      urls = rows;
      loaded = true;
      status.textContent = urls.length ? "" : "No URLs added yet.";
      render();
    } catch (cause) {
      if (!current(version)) return;
      status.textContent = "";
      error.textContent = cause.message;
      retry.hidden = false;
    } finally {
      if (version === generation) {
        loading = false;
        updateControls();
        if (key !== currentKey()) syncSession();
      }
    }
  }

  async function removeUrl(row, button) {
    if (saving || !loaded || !key || key !== currentKey()) return;
    const version = generation;
    const index = urls.findIndex(item => item.id === row.id);
    saving = true;
    error.textContent = "";
    status.textContent = "";
    button.textContent = "…";
    updateControls();
    try {
      await deleteCrawlerUrl(getBoard(), row.id);
      if (!current(version)) return;
      urls = urls.filter(item => item.id !== row.id);
      saving = false;
      render();
      status.textContent = urls.length ? "URL removed." : "No URLs added yet.";
      // Keep keyboard focus near the row that was removed.
      (list.querySelectorAll(".crawler-url-remove")[Math.min(index, urls.length - 1)] ?? input).focus();
    } catch (cause) {
      if (current(version)) error.textContent = cause.message;
    } finally {
      if (version === generation) {
        saving = false;
        button.textContent = "×";
        updateControls();
        if (key !== currentKey()) syncSession();
      }
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (add.disabled || !form.reportValidity()) return;
    const version = generation;
    error.textContent = "";
    status.textContent = "";
    try {
      const url = normalizeCrawlerUrl(input.value);
      if (urls.some(row => row.url === url)) throw new Error("This URL is already in the list.");
      saving = true;
      updateControls();
      const row = await addCrawlerUrl(getBoard(), url);
      if (!current(version)) return;
      urls.push(row);
      input.value = "";
      status.textContent = "URL added.";
      render();
    } catch (cause) {
      if (current(version)) error.textContent = cause.message;
    } finally {
      if (version === generation) {
        saving = false;
        updateControls();
        if (current(version)) input.focus();
        else if (key !== currentKey()) syncSession();
      }
    }
  });
  input.addEventListener("input", () => { error.textContent = ""; updateControls(); });
  retry.addEventListener("click", load);

  return active => {
    const nextKey = active ? currentKey() : null;
    if (nextKey !== key) {
      key = nextKey;
      generation++;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      starting.clear();
      crawlErrors.clear();
      urls = [];
      loading = false;
      loaded = false;
      saving = false;
      input.value = "";
      error.textContent = "";
      status.textContent = "";
      retry.hidden = true;
      render();
      if (key) load();
    }
    updateControls();
  };
}
