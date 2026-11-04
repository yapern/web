import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

export function normalizeCrawlerUrl(value) {
  try {
    const clean = typeof value === "string" ? value.trim() : "";
    const url = new URL(clean);
    if (!/^https?:\/\//i.test(clean) || /[\s\u0000-\u001f\u007f]/.test(clean) || !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || clean.length > 2048 || url.href.length > 2048) throw new Error();
    return url.href;
  } catch {
    throw new Error("Enter a full http:// or https:// URL without login details, up to 2048 characters.");
  }
}

const isCrawlerUrl = (row, board) => row && typeof row.id === "string" && row.id.trim() &&
  row.board_id === board.id && typeof row.url === "string" && typeof row.created_at === "string" &&
  (row.crawl === undefined || isCrawlJob(row.crawl, board, row.id)) &&
  Number.isFinite(Date.parse(row.created_at)) && (() => {
    try { return normalizeCrawlerUrl(row.url) === row.url; } catch { return false; }
  })();

const isCrawlJob = (job, board, sourceId) => job && typeof job.id === "string" && job.id.trim() &&
  job.board_id === board.id && job.source_id === sourceId &&
  ["queued", "running", "succeeded", "blocked", "failed"].includes(job.state) &&
  Number.isSafeInteger(job.added_count) && job.added_count >= 0 &&
  Number.isSafeInteger(job.skipped_count) && job.skipped_count >= 0 &&
  (job.error === null || typeof job.error === "string") && Number.isFinite(Date.parse(job.created_at)) &&
  (job.finished_at === null || Number.isFinite(Date.parse(job.finished_at)));

async function request(board, method, { url, id, crawl = false } = {}, fetcher) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Log in again to edit this sub-yap.");
  if (!board || typeof board.id !== "string" || !board.id.trim()) throw new Error("Choose a sub-yap to edit.");
  if (board.user_id !== session.user.id) throw new Error("You can only edit sub-yaps you created.");
  const path = `/boards/${encodeURIComponent(board.id)}/crawler-urls${id ? `/${encodeURIComponent(id)}` : ""}${crawl ? "/crawl" : ""}`;
  let response;
  try {
    response = await fetcher(new URL(path, messageBoardConfig.apiOrigin), {
      method, headers: { authorization: `Bearer ${session.token}`, ...(url ? { "content-type": "application/json" } : {}) },
      ...(url ? { body: JSON.stringify({ url }) } : {}),
      mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(crawl ? "Could not confirm the crawl job. Check your connection and reload to check its status." : "Could not confirm the crawler URLs. Check your connection and reload before trying again.");
  }
  if (response.status === 401) {
    if (readStoredSession()?.token === session.token) storeSession(null);
    throw new Error("Your session has expired. Log in again to edit this sub-yap.");
  }
  if (response.status === 403) throw new Error("You don’t have permission to edit this sub-yap.");
  if (response.status === 404) throw new Error("This sub-yap or URL is no longer available. Reload to check the list.");
  if (response.status === 409) throw new Error("This URL is already in the list.");
  if (response.status === 400) throw new Error(crawl ? "Crawling requires a public website URL without a custom port." : "Enter a valid http:// or https:// URL, up to 2048 characters.");
  if (response.status === 429) throw new Error("The daily crawl limit has been reached. Try again tomorrow.");
  if (!response.ok) throw new Error("Crawler URLs are unavailable. Please try again.");
  const payload = await response.json().catch(() => null);
  if (crawl) {
    if ((method === "GET" && payload?.data === null) || isCrawlJob(payload?.data, board, id)) return payload.data;
    throw new Error("Could not confirm the crawl job. Reload to check its status.");
  }
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

export async function startSiteCrawl(board, id, fetcher = fetch) {
  if (typeof id !== "string" || !id.trim()) throw new Error("Choose a site to crawl.");
  return request(board, "POST", { id, crawl: true }, fetcher);
}

export async function fetchSiteCrawl(board, id, fetcher = fetch) {
  if (typeof id !== "string" || !id.trim()) throw new Error("Choose a site to crawl.");
  return request(board, "GET", { id, crawl: true }, fetcher);
}
