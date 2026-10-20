import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

const isVoteValue = value => value === -1 || value === 0 || value === 1;
const isId = value => typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\s,]/.test(value);

export function nextVote(current, direction) {
  if (!isVoteValue(current) || (direction !== -1 && direction !== 1)) return current;
  return Math.max(-1, Math.min(1, current + direction));
}

function sameSession(left, right) {
  return Boolean(left && right && left.token === right.token && left.user?.id === right.user?.id);
}

function validTarget(target) {
  return Boolean(target && (target.type === "message" || target.type === "reply") && isId(target.id));
}

function validVote(row) {
  return Boolean(row && (row.type === "message" || row.type === "reply") && isId(row.id) &&
    Number.isSafeInteger(row.score) && isVoteValue(row.user_vote));
}

export function createVotesApi({ fetcher = fetch, getSession = readStoredSession, clearSession = storeSession,
  apiOrigin = messageBoardConfig.apiOrigin } = {}) {
  const base = `${apiOrigin}/votes`;

  async function request(path, { session = getSession(), method = "GET", body } = {}, fetcherOverride) {
    let response;
    try {
      response = await (fetcherOverride ?? fetcher)(`${base}${path}`, {
        method, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        headers: { ...(session ? { authorization: `Bearer ${session.token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(method === "PUT" ? "Could not confirm your vote. Refresh the count and try again." :
        "Votes are unavailable. Check your connection and try again.");
    }
    if (response.status === 401 && session && sameSession(getSession(), session)) clearSession(null);
    if (!response.ok) {
      const errorPayload = await response.clone().json().catch(() => null);
      let message;
      if (response.status === 401) message = "Your session has expired. Please sign in again.";
      else if (response.status === 403) message = "You don’t have permission to vote.";
      else if (response.status === 409 && errorPayload?.error === "invalid_vote_transition") {
        message = "That vote could not be changed. Refresh the count and try again.";
      } else message = method === "PUT" ? "Could not save your vote. Please try again." : "Votes are unavailable. Please try again.";
      throw Object.assign(new Error(message), { status: response.status, code: errorPayload?.error });
    }
    return response.json().catch(() => null);
  }

  async function fetchVotes(targets, fetcherOverride) {
    if (!Array.isArray(targets) || targets.length > 200 || targets.some(target => !validTarget(target))) {
      throw new Error("Could not load votes for these messages.");
    }
    const unique = new Set();
    let messageIds = [];
    let replyIds = [];
    for (const target of targets) {
      const key = `${target.type}:${target.id}`;
      if (unique.has(key)) throw new Error("Could not load votes for these messages.");
      unique.add(key);
      (target.type === "message" ? messageIds : replyIds).push(target.id);
    }
    if (messageIds.length > 100 || replyIds.length > 100) throw new Error("Could not load votes for these messages.");
    if (!targets.length) return [];
    const params = new URLSearchParams();
    if (messageIds.length) params.set("message_ids", messageIds.join(","));
    if (replyIds.length) params.set("reply_ids", replyIds.join(","));
    const payload = await request(`?${params}`, { session: getSession() }, fetcherOverride);
    if (!Array.isArray(payload?.data) || payload.data.length > targets.length || !payload.data.every(validVote)) {
      throw new Error("Votes returned an invalid response.");
    }
    const wanted = new Set(unique);
    const received = new Set();
    for (const row of payload.data) {
      const key = `${row.type}:${row.id}`;
      if (!wanted.has(key) || received.has(key)) throw new Error("Votes returned an invalid response.");
      received.add(key);
    }
    return payload.data;
  }

  async function setVote(target, value, fetcherOverride) {
    if (!validTarget(target) || !isVoteValue(value)) throw new Error("Choose a valid vote.");
    const session = getSession();
    if (!session) throw new Error("Your session has expired. Please sign in again.");
    const body = target.type === "message" ? { message_id: target.id, value } : { reply_id: target.id, value };
    const payload = await request("", { session, method: "PUT", body }, fetcherOverride);
    if (!Array.isArray(payload?.data) || payload.data.length !== 1 || !validVote(payload.data[0]) ||
      payload.data[0].id !== target.id || payload.data[0].type !== target.type || payload.data[0].user_vote !== value) {
      throw new Error("Could not confirm your vote. Refresh the count and try again.");
    }
    return payload.data[0];
  }

  return { fetchVotes, setVote };
}

const api = createVotesApi();
export const fetchVotes = (...args) => api.fetchVotes(...args);
export const setVote = (...args) => api.setVote(...args);
