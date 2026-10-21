import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

export const ADMIN_PAGE_SIZE = 25;
const unavailable = "Could not load users. Please try again.";

export async function fetchAdminUsers({ offset = 0, q = "" } = {}, fetcher = fetch) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Log in again to view users.");
  if (session.user.email.trim().toLowerCase() !== "oneone@gmail.com") {
    throw new Error("You don’t have permission to view users.");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || typeof q !== "string" || q.trim().length > 100) {
    throw new Error("Search using up to 100 characters and a valid page.");
  }
  const url = new URL("/admin/tables/users", messageBoardConfig.apiOrigin);
  url.search = new URLSearchParams({ offset: String(offset), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  let response;
  try {
    response = await fetcher(url, {
      method: "GET", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${session.token}` },
    });
  } catch {
    throw new Error(unavailable);
  }
  if (response.status === 401) {
    if (readStoredSession()?.token === session.token) storeSession(null);
    throw new Error("Your session has expired. Log in again to view users.");
  }
  if (!response.ok) {
    throw new Error(response.status === 403 ? "You don’t have permission to view users." : unavailable);
  }
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.items) || payload.items.length > ADMIN_PAGE_SIZE ||
      !payload.items.every(user => user && typeof user.id === "string" && user.id.trim() &&
        typeof user.name === "string" && (user.email === null || typeof user.email === "string") &&
        typeof user.created_at === "string" && Number.isFinite(Date.parse(user.created_at))) ||
      new Set(payload.items.map(user => user.id)).size !== payload.items.length ||
      !Number.isSafeInteger(payload.total) || payload.total < payload.items.length ||
      payload.offset !== offset || payload.limit !== ADMIN_PAGE_SIZE) {
    throw new Error(unavailable);
  }
  return payload;
}
