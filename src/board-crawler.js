import { readStoredSession } from "./auth.js";
import { addCrawlerUrl, deleteCrawlerUrl, fetchCrawlerUrls, normalizeCrawlerUrl } from "./board-crawler-api.js";

export function mountBoardCrawler(getBoard) {
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
    list.querySelectorAll("button").forEach(button => { button.disabled = disabled; });
    form.setAttribute("aria-busy", String(saving));
    list.setAttribute("aria-busy", String(loading));
    add.textContent = saving ? "Saving…" : "Add URL";
  }

  function render() {
    list.replaceChildren(...urls.map(row => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = row.url;
      link.textContent = row.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "crawler-url-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${row.url}`);
      remove.addEventListener("click", () => removeUrl(row, remove));
      item.append(link, remove);
      return item;
    }));
    updateControls();
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
      (list.querySelectorAll("button")[Math.min(index, urls.length - 1)] ?? input).focus();
    } catch (cause) {
      if (current(version)) error.textContent = cause.message;
    } finally {
      if (version === generation) {
        saving = false;
        button.textContent = "×";
        updateControls();
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
