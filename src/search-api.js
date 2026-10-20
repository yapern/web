import { messageBoardConfig } from "./config.js";

export const SEARCH_PAGE_SIZE = 20;
const boardSlug = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/;

export function readSearchOptions(params) {
  for (const key of ["q", "type", "sort", "board", "page"]) {
    if (params.getAll(key).length > 1) throw new Error("This search link is invalid. Try a new search.");
  }
  const q = (params.get("q") ?? "").trim();
  const type = params.get("type") ?? "messages";
  const sort = params.get("sort") ?? "relevance";
  const board = params.get("board") ?? "";
  const pageValue = params.get("page") ?? "1";
  const page = Number(pageValue);
  if (q.length > 200 || (q.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? []).length > 20) {
    throw new Error("Use up to 200 characters and 20 words in your search.");
  }
  if (!["messages", "boards"].includes(type) || !["relevance", "newest"].includes(sort) ||
      (board && (board.length > 80 || !boardSlug.test(board))) ||
      !/^[1-9][0-9]*$/.test(pageValue) || !Number.isSafeInteger(page) || page > 51) {
    throw new Error("This search link is invalid. Try a new search.");
  }
  return { q, type, sort, board, page };
}

export function searchHref({ q = "", type = "messages", sort = "relevance", board = "", page = 1 } = {}) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (type !== "messages") params.set("type", type);
  if (sort !== "relevance") params.set("sort", sort);
  if (board) params.set("board", board);
  if (page !== 1) params.set("page", String(page));
  return `/search/${params.size ? `?${params}` : ""}`;
}

function isResult(row, type) {
  if (!row || typeof row.id !== "string" || !row.id.trim() || typeof row.snippet !== "string" ||
      typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) return false;
  if (type === "boards") {
    return row.type === "board" && typeof row.slug === "string" && boardSlug.test(row.slug) && typeof row.name === "string";
  }
  return row.type === "message" && ["title", "board_id", "board_slug", "board_name", "author_id", "author_name"]
    .every(key => typeof row[key] === "string") && boardSlug.test(row.board_slug);
}

export async function fetchSearch(options, fetcher = fetch) {
  const query = readSearchOptions(new URLSearchParams(options));
  if (!query.q) return { data: [], meta: { has_more: false, limit: SEARCH_PAGE_SIZE, offset: 0 } };
  const offset = (query.page - 1) * SEARCH_PAGE_SIZE;
  const url = new URL("/search", messageBoardConfig.apiOrigin);
  url.search = new URLSearchParams({
    q: query.q, type: query.type, sort: query.sort,
    limit: String(SEARCH_PAGE_SIZE), offset: String(offset), ...(query.board ? { board: query.board } : {}),
  }).toString();
  let response;
  try {
    response = await fetcher(url, {
      mode: "cors", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Search is unavailable right now. Please try again.");
  }
  if (!response.ok) throw new Error(response.status === 400
    ? "This search is invalid. Try a shorter query."
    : "Search is unavailable right now. Please try again.");
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Search returned invalid results. Please try again."); }
  if (!Array.isArray(payload?.data) || payload.data.length > SEARCH_PAGE_SIZE ||
      !payload.data.every(row => isResult(row, query.type)) ||
      new Set(payload.data.map(row => row.id)).size !== payload.data.length ||
      typeof payload.meta?.has_more !== "boolean" || payload.meta.limit !== SEARCH_PAGE_SIZE || payload.meta.offset !== offset ||
      (query.board && payload.data.some(row => (query.type === "boards" ? row.slug : row.board_slug) !== query.board))) {
    throw new Error("Search returned invalid results. Please try again.");
  }
  return payload;
}
