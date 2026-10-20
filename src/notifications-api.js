import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

const isNonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = value => Number.isSafeInteger(value) && value > 0;

export function isNotificationSnapshot(value) {
  return Boolean(value && value.type === "notifications" &&
    Number.isSafeInteger(value.version) && value.version > 0 &&
    isNonnegativeInteger(value.unread_count) && isNonnegativeInteger(value.last_id) &&
    Array.isArray(value.notifications) && value.notifications.length <= 50 &&
    value.notifications.every(notification => notification &&
      isPositiveInteger(notification.id) &&
      ["reply_id", "message_id", "board_slug", "message_title", "actor_name"].every(key => typeof notification[key] === "string") &&
      notification.reply_id.length > 0 && notification.message_id.length > 0 &&
      /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(notification.board_slug) &&
      Number.isFinite(Date.parse(notification.created_at)) &&
      (notification.read_at === null || (typeof notification.read_at === "string" && Number.isFinite(Date.parse(notification.read_at))))));
}

function sameSession(left, right) {
  return Boolean(left && right && left.token === right.token && left.user?.id === right.user?.id);
}

export function createNotificationsApi({ fetcher = fetch, getSession = readStoredSession, clearSession = storeSession,
  apiOrigin = messageBoardConfig.apiOrigin } = {}) {
  const base = `${apiOrigin}/notifications`;

  async function request(path, session, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetcher(`${base}${path}`, {
        method, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${session.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error("Notifications are unavailable. Check your connection and try again.");
    }
    if (response.status === 401 && sameSession(getSession(), session)) clearSession(null);
    if (!response.ok) throw Object.assign(new Error(response.status === 401
      ? "Your session has expired. Please sign in again."
      : "Notifications are unavailable. Please try again."), { status: response.status });
    const payload = await response.json().catch(() => null);
    return payload;
  }

  async function snapshot(session = getSession()) {
    if (!session) throw new Error("Sign in to view notifications.");
    const result = await request("", session);
    if (!isNotificationSnapshot(result)) throw new Error("Notifications returned an invalid response.");
    return result;
  }

  async function markRead(throughId, session = getSession()) {
    if (!session || !isNonnegativeInteger(throughId)) throw new Error("Could not mark notifications as read.");
    const result = await request("/read", session, { method: "POST", body: { through_id: throughId } });
    if (!isNotificationSnapshot(result)) throw new Error("Notifications returned an invalid response.");
    return result;
  }

  async function ticket(session = getSession()) {
    if (!session) throw new Error("Sign in to view notifications.");
    const result = await request("/ticket", session, { method: "POST" });
    if (!result || typeof result.ticket !== "string" || !/^[a-f0-9]{64}$/.test(result.ticket) || result.user_id !== session.user.id) {
      throw new Error("Could not connect to live notifications.");
    }
    return result.ticket;
  }

  function socketUrl(userId, ticketValue) {
    const url = new URL("/notifications/socket", apiOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ user_id: userId, ticket: ticketValue }).toString();
    return url.href;
  }

  return { snapshot, markRead, ticket, socketUrl };
}
