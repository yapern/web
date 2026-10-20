import { fetchSearch, readSearchOptions, searchHref } from "./search-api.js";
import { boardHref, messageHref } from "./board-routes.js";

const field = document.querySelector("#site-search");
const status = document.querySelector("#search-status");
const list = document.querySelector("#search-results");
const retry = document.querySelector("#search-retry");
const pagination = document.querySelector("#search-pagination");
const sort = document.querySelector("#search-sort");
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
let options;
let loading = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderResult(result) {
  const item = element("li", "search-result");
  const article = document.createElement("article");
  const meta = element("div", "search-result-meta");
  const board = element("a", "search-result-board", `y/${result.type === "board" ? result.slug : result.board_slug}`);
  board.href = boardHref(result.type === "board" ? result.slug : result.board_slug);
  meta.append(board);
  if (result.type === "message") meta.append(element("span", "", result.author_name.trim() || "Unknown user"));
  const time = element("time", "", dateFormat.format(new Date(result.created_at)));
  time.dateTime = result.created_at;
  meta.append(time);
  const heading = document.createElement("h2");
  const link = element("a", "", result.type === "board" ? result.name : result.title);
  link.href = result.type === "board" ? boardHref(result.slug) : messageHref(result.board_slug, result.id);
  heading.append(link);
  article.append(meta, heading);
  // Snippets are untrusted public text. Never interpret them as HTML.
  if (result.snippet) article.append(element("p", "search-result-snippet", result.snippet));
  item.append(article);
  return item;
}

function renderPagination(hasMore) {
  pagination.replaceChildren();
  if (options.page > 1) {
    const previous = element("a", "", "Previous");
    previous.href = searchHref({ ...options, page: options.page - 1 });
    previous.rel = "prev";
    pagination.append(previous);
  }
  if (options.page > 1 || hasMore) pagination.append(element("span", "", `Page ${options.page}`));
  if (hasMore && options.page < 51) {
    const next = element("a", "", "Next");
    next.href = searchHref({ ...options, page: options.page + 1 });
    next.rel = "next";
    pagination.append(next);
  }
  pagination.hidden = !pagination.childElementCount;
}

async function load() {
  if (loading || !options.q) return;
  loading = true;
  list.setAttribute("aria-busy", "true");
  retry.hidden = true;
  status.textContent = "Searching…";
  try {
    const payload = await fetchSearch(options);
    list.replaceChildren(...payload.data.map(renderResult));
    status.textContent = payload.data.length ? "" : options.page > 1
      ? "No more results." : `No results for “${options.q}”.`;
    renderPagination(payload.meta.has_more);
  } catch (error) {
    status.textContent = error.message;
    retry.hidden = false;
  } finally {
    list.setAttribute("aria-busy", "false");
    loading = false;
  }
}

// Preserve even an invalid query so it can be corrected in the header.
field.value = new URLSearchParams(location.search).get("q") ?? "";
try {
  options = readSearchOptions(new URLSearchParams(location.search));
  document.title = options.q ? `${options.q} · Search · Yapern` : "Search · Yapern";
  for (const link of document.querySelectorAll("[data-search-type]")) {
    link.href = searchHref({ ...options, type: link.dataset.searchType, page: 1 });
    if (link.dataset.searchType === options.type) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  sort.value = options.sort;
  window.addEventListener("pageshow", () => {
    field.value = options.q;
    sort.value = options.sort;
  });
  sort.addEventListener("change", () => {
    const nextSort = sort.value;
    // Keep the previous page's control consistent when restored from history.
    sort.value = options.sort;
    location.assign(searchHref({ ...options, sort: nextSort, page: 1 }));
  });
  if (options.board) {
    const scope = document.querySelector("#search-scope");
    scope.hidden = false;
    scope.querySelector("span").textContent = `In y/${options.board}`;
    scope.querySelector("a").href = searchHref({ ...options, board: "", page: 1 });
  }
  status.textContent = options.q ? "Searching…" : "Search messages and sub-yaps using the field above.";
  retry.addEventListener("click", load);
  void load();
} catch (error) {
  status.textContent = error.message;
  sort.disabled = true;
}
