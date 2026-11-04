import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

export function normalizeCrawlerUrl(value) {
  try {
    const clean = typeof value === "string" ? value.trim() : "";
    const url = new URL(clean);
    if (!/^https?:\/\//i.test(clean) || !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || clean.length > 2048 || url.href.length > 2048) throw new Error();
    return url.href;
  } catch {
    throw new Error("Enter a full http:// or https:// URL without login details, up to 2048 characters.");
  }
}

const isCrawlerUrl = (row, board) => row && typeof row.id === "string" && row.id.trim() &&
  row.board_id === board.id && typeof row.url === "string" && typeof row.created_at === "string" &&
  Number.isFinite(Date.parse(row.created_at)) && (() => {
    try { return normalizeCrawlerUrl(row.url) === row.url; } catch { return false; }
  })();

async function request(board, method, { url, id } = {}, fetcher) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Log in again to edit this sub-yap.");
  if (!board || typeof board.id !== "string" || !board.id.trim()) throw new Error("Choose a sub-yap to edit.");
  if (board.user_id !== session.user.id) throw new Error("You can only edit sub-yaps you created.");
  const path = `/boards/${encodeURIComponent(board.id)}/crawler-urls${id ? `/${encodeURIComponent(id)}` : ""}`;
  let response;
  try {
    response = await fetcher(new URL(path, messageBoardConfig.apiOrigin), {
      method, headers: { authorization: `Bearer ${session.token}`, ...(url ? { "content-type": "application/json" } : {}) },
      ...(url ? { body: JSON.stringify({ url }) } : {}),
      mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not confirm the crawler URLs. Check your connection and reload before trying again.");
  }
  if (response.status === 401) {
    if (readStoredSession()?.token === session.token) storeSession(null);
    throw new Error("Your session has expired. Log in again to edit this sub-yap.");
  }
  if (response.status === 403) throw new Error("You don’t have permission to edit this sub-yap.");
  if (response.status === 404) throw new Error("This sub-yap or URL is no longer available. Reload to check the list.");
  if (response.status === 409) throw new Error("This URL is already in the list.");
  if (response.status === 400) throw new Error("Enter a valid http:// or https:// URL, up to 2048 characters.");
  if (!response.ok) throw new Error("Crawler URLs are unavailable. Please try again.");
  const payload = await response.json().catch(() => null);
  const rows = payload?.data;
  if (!Array.isArray(rows) || !rows.every(row => isCrawlerUrl(row, board)) ||
    new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.url)).size !== rows.length ||
    (method !== "GET" && (rows.length !== 1 || (url && rows[0].url !== url) || (id && rows[0].id !== id)))) {
    throw new Error("Could not confirm the crawler URLs. Reload to check the list.");
  }
  return rows;
}

export function fetchCrawlerUrls(board, fetcher = fetch) {
  return request(board, "GET", {}, fetcher);
}

export async function addCrawlerUrl(board, value, fetcher = fetch) {
  const rows = await request(board, "POST", { url: normalizeCrawlerUrl(value) }, fetcher);
  return rows[0];
}

export async function deleteCrawlerUrl(board, id, fetcher = fetch) {
  if (typeof id !== "string" || !id.trim()) throw new Error("Choose a URL to remove.");
  await request(board, "DELETE", { id }, fetcher);
}
