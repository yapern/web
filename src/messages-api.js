import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

const isMessage = (message) => message &&
  ["id", "board_id", "user_id", "title", "body", "created_at"].every(key => typeof message[key] === "string") &&
  Number.isFinite(Date.parse(message.created_at));
const isReply = (reply) => reply &&
  ["id", "message_id", "user_id", "body", "created_at"].every(key => typeof reply[key] === "string") &&
  reply.id.trim().length > 0 && reply.message_id.trim().length > 0 && reply.user_id.trim().length > 0 &&
  Number.isFinite(Date.parse(reply.created_at)) && reply.body.trim().length > 0 && reply.body.length <= 2000;
const isBoard = (board) => board && typeof board.id === "string" &&
  typeof board.slug === "string" && /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(board.slug) &&
  typeof board.name === "string" && typeof board.description === "string";

// The browser calls the Yapern API directly; the Worker handles CORS.
async function readRows(table, params, fetcher) {
  const { apiOrigin } = messageBoardConfig;
  const url = new URL(
    `/tables/${encodeURIComponent(table)}`,
    apiOrigin,
  );
  url.search = new URLSearchParams(params).toString();
  const session = readStoredSession();
  const response = await fetcher(url, {
    headers: session ? { authorization: `Bearer ${session.token}` } : {},
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Sub-yap unavailable");
  const payload = await response.json();
  if (!Array.isArray(payload?.data) || payload.data.length > Number(params.limit)) {
    throw new Error("Invalid sub-yap data");
  }
  return payload.data;
}

const previewRequestTimeoutMs = 45_000;
const previewIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function previewLog(level, event, details = {}) {
  console[level]("[link-preview]", event, details);
}

function previewFailureKind(error) {
  if (error?.name === "TimeoutError") return "timeout";
  if (error?.name === "TypeError") return "network-or-cors";
  return "request-error";
}

function validatedImage(value) {
  if (typeof value !== "string") return null;
  try {
    const image = new URL(value);
    if (["http:", "https:"].includes(image.protocol) && !image.username && !image.password) return image.href;
  } catch {}
  return null;
}

function validatedPreviewUrl(value, previewId) {
  if (typeof value !== "string") return null;
  try {
    const statusUrl = new URL(value);
    const apiOrigin = new URL(messageBoardConfig.apiOrigin);
    if (
      statusUrl.origin === apiOrigin.origin &&
      !statusUrl.username && !statusUrl.password &&
      statusUrl.pathname === `/previews/${previewId}` &&
      !statusUrl.search && !statusUrl.hash
    ) return statusUrl;
  } catch {}
  return null;
}

function retryDelay(response) {
  const header = response.headers.get("retry-after");
  if (header && /^\d+(?:\.\d+)?$/.test(header.trim())) {
    return Math.min(Number(header) * 1000, previewRequestTimeoutMs);
  }
  return 1000;
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchOgImage(value, fetcher = fetch, { signal } = {}) {
  const session = readStoredSession();
  if (!session) {
    previewLog("info", "lookup skipped", { reason: "missing-or-expired-session" });
    return null;
  }
  let target;
  try {
    target = new URL(value.trim());
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      previewLog("warn", "lookup skipped", { reason: "invalid-url" });
      return null;
    }
    target.hash = "";
  } catch {
    previewLog("warn", "lookup skipped", { reason: "invalid-url" });
    return null;
  }
  const url = new URL("/og-image", messageBoardConfig.apiOrigin);
  const timeoutController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    timeoutController.abort(new DOMException("The link preview request timed out.", "TimeoutError"));
  }, previewRequestTimeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  try {
    combinedSignal.throwIfAborted();
    previewLog("info", "request started", { method: "POST", endpoint: url.pathname, target: target.href });
    const requestOptions = {
      mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { authorization: `Bearer ${session.token}` },
      signal: combinedSignal,
    };
    let response = await fetcher(url, {
      ...requestOptions,
      method: "POST",
      headers: { ...requestOptions.headers, "content-type": "application/json" },
      body: JSON.stringify({ url: target.href }),
    });
    let payload;
    let statusUrl = null;
    let previewId = null;
    while (true) {
      combinedSignal.throwIfAborted();
      if (response.status !== 200 && response.status !== 202) throw new Error("Link preview unavailable.");
      payload = await response.json();
      previewLog("info", "response received", { httpStatus: response.status, status: payload?.status });
      if (response.status === 200) {
        if (!["ready", "failed"].includes(payload?.status)) return null;
        const image = validatedImage(payload.image);
        if (!image) previewLog("info", "terminal response has no usable image");
        return image;
      }

      if (payload?.status !== "pending" || typeof payload.previewId !== "string" || !previewIdPattern.test(payload.previewId)) {
        throw new Error("Link preview unavailable.");
      }
      if (previewId !== null && payload.previewId !== previewId) throw new Error("Link preview unavailable.");
      previewId = payload.previewId;
      const validatedUrl = validatedPreviewUrl(payload.statusUrl, previewId);
      if (!validatedUrl || (statusUrl && validatedUrl.href !== statusUrl.href)) throw new Error("Link preview unavailable.");
      statusUrl = validatedUrl;
      await waitForRetry(retryDelay(response), combinedSignal);
      response = await fetcher(statusUrl, { ...requestOptions, method: "GET" });
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      previewLog("info", "lookup cancelled");
    } else {
      previewLog("warn", "lookup failed", { reason: previewFailureKind(error) });
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export async function fetchMessages(fetcher = fetch, { boardId, messageId } = {}) {
  const params = {
    select: "id,board_id,user_id,title,body,created_at",
    order: "created_at.desc",
    limit: messageId === undefined ? "20" : "1",
  };
  if (boardId !== undefined) params.board_id = `eq.${boardId}`;
  if (messageId !== undefined) params.id = `eq.${messageId}`;
  const messages = await readRows(messageBoardConfig.table, params, fetcher);
  if (
    !messages.every(
      (message) =>
        isMessage(message) &&
        (boardId === undefined || message.board_id === boardId) &&
        (messageId === undefined || message.id === messageId),
    )
  ) {
    throw new Error("Invalid messages");
  }
  return messages;
}

export async function fetchReplies(messageId, fetcher = fetch) {
  if (typeof messageId !== "string" || !messageId.trim()) throw new Error("Choose a message to view replies.");
  const replies = [];
  for (let offset = 0; ; offset += 100) {
    const page = await readRows("replies", {
      select: "id,message_id,user_id,body,created_at",
      message_id: `eq.${messageId}`,
      order: "created_at.asc",
      limit: "100",
      offset: String(offset),
    }, fetcher);
    if (!page.every(reply => isReply(reply) && reply.message_id === messageId)) {
      throw new Error("Invalid replies");
    }
    replies.push(...page);
    if (page.length < 100) return replies;
  }
}

export async function fetchMessageAuthors(messages, fetcher = fetch) {
  const ids = [...new Set(messages.map(message => message.user_id))];
  // Look up each distinct author once using equality filters.
  const authors = await Promise.all(ids.map(async id => {
    const users = await readRows("users", { select: "id,name", id: `eq.${id}`, limit: "1" }, fetcher);
    const user = users[0];
    if (user && (user.id !== id || typeof user.name !== "string")) {
      throw new Error("Invalid message author");
    }
    return [id, user?.name.trim() || "Unknown user"];
  }));
  return new Map(authors);
}

async function readBoards(params, fetcher) {
  const boards = await readRows("boards", {
    select: "id,slug,name,description", ...params,
  }, fetcher);
  if (!boards.every(isBoard)) {
    throw new Error("Invalid sub-yaps");
  }
  return boards;
}

export async function fetchBoards(fetcher = fetch) {
  const boards = [];
  for (let offset = 0; ; offset += 100) {
    const page = await readBoards({ order: "slug.asc", limit: "100", offset: String(offset) }, fetcher);
    boards.push(...page);
    if (page.length < 100) return boards;
  }
}

export async function fetchBoardPage(slug, messageId, fetcher = fetch) {
  const boards = await readBoards({ slug: `eq.${slug}`, limit: "1" }, fetcher);
  const board = boards[0];
  if (!board) return null;
  if (board.slug !== slug) throw new Error("Unexpected sub-yap");
  const messages = await fetchMessages(fetcher, { boardId: board.id, messageId });
  if (messageId !== undefined && !messages.length) return null;
  return { board, messages };
}

async function insertRow(table, values, validate, fetcher) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Open Account and sign in again to continue.");
  const { apiOrigin } = messageBoardConfig;
  const url = new URL(`/tables/${encodeURIComponent(table)}`, apiOrigin);
  let response;
  try {
    response = await fetcher(url, {
      method: "POST", mode: "cors", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...values, user_id: session.session.user_id }),
    });
  } catch {
    throw new Error("Could not confirm creation. Check your connection and the sub-yap before trying again.");
  }
  if (response.status === 401) throw new Error("Your session has expired. Open Account and sign in again to continue.");
  if (response.status === 403) throw new Error(table === "boards"
    ? "You don’t have permission to create sub-yaps."
    : table === "replies"
      ? "You don’t have permission to reply to this message."
      : "You don’t have permission to post to this sub-yap.");
  if (response.status === 409 && table === "boards") throw new Error("A sub-yap with that name already exists. Choose another name.");
  if (!response.ok) throw new Error("Could not create this right now. Please try again.");
  const payload = await response.json().catch(() => null);
  const row = payload?.data?.[0];
  if (!Array.isArray(payload?.data) || payload.data.length !== 1 || !validate(row) || !row.id ||
    row.user_id !== session.session.user_id || Object.entries(values).some(([key, value]) => row[key] !== value)) {
    throw new Error("Could not confirm creation. Check the sub-yap before trying again.");
  }
  return row;
}

export async function createBoard(name, description, fetcher = fetch) {
  const cleanName = name.trim();
  const cleanDescription = description.trim();
  if (!cleanName || cleanName.length > 80) throw new Error("Enter a sub-yap name of 1–80 characters.");
  if (cleanDescription.length > 2000) throw new Error("Enter a description of at most 2000 characters.");
  const slug = cleanName.toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error("Use letters (a–z), numbers, spaces, or hyphens in the sub-yap name, starting and ending with a letter or number.");
  }
  return insertRow("boards", { slug, name: cleanName, description: cleanDescription }, isBoard, fetcher);
}

export async function createMessage(boardId, title, body, fetcher = fetch) {
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (!boardId.trim()) throw new Error("Choose a sub-yap for your message.");
  if (!cleanTitle || cleanTitle.length > 200) throw new Error("Enter a title of 1–200 characters.");
  if (!cleanBody || cleanBody.length > 2000) throw new Error("Enter a message of 1–2000 characters.");
  return insertRow(messageBoardConfig.table, { board_id: boardId, title: cleanTitle, body: cleanBody }, isMessage, fetcher);
}

export async function deleteMessage(message, fetcher = fetch) {
  if (!["id", "board_id", "user_id"].every(key => typeof message?.[key] === "string" && message[key].trim())) {
    throw new Error("Choose a message to delete.");
  }
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Open Account and sign in again to continue.");
  if (message.user_id !== session.session.user_id) throw new Error("You can only delete your own messages.");
  const { apiOrigin, table } = messageBoardConfig;
  const url = new URL(`/tables/${encodeURIComponent(table)}`, apiOrigin);
  for (const key of ["id", "board_id", "user_id"]) url.searchParams.set(key, `eq.${message[key]}`);
  let response;
  try {
    response = await fetcher(url, {
      method: "DELETE", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${session.token}` },
    });
  } catch {
    throw new Error("Could not confirm deletion. Check your connection and reload the page before trying again.");
  }
  if (response.status === 401) {
    storeSession(null);
    throw new Error("Your session has expired. Open Account and sign in again to continue.");
  }
  if (response.status === 403) throw new Error("You don’t have permission to delete this message.");
  if (!response.ok) throw new Error("Could not delete this message right now. Please try again.");
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.data) || payload.data.length !== 0 || payload?.meta?.changes !== 1) {
    throw new Error("Could not confirm deletion. Reload the page to check whether the message still exists.");
  }
}

export async function createReply(messageId, body, fetcher = fetch) {
  if (typeof messageId !== "string" || typeof body !== "string") {
    throw new Error("Enter a message and reply.");
  }
  const cleanBody = body.trim();
  if (!messageId.trim()) throw new Error("Choose a message to reply to.");
  if (!cleanBody || cleanBody.length > 2000) throw new Error("Enter a reply of 1–2000 characters.");
  return insertRow("replies", { message_id: messageId, body: cleanBody }, isReply, fetcher);
}
