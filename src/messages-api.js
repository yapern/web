import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";
import { serializeMessageBody } from "./message-text.js";
import { isMessageVideo } from "./videos-api.js";
import { boardLogoPathPattern } from "./board-logo.js";
export { boardLogoUrl } from "./board-logo.js";

const isMessage = (message) => message &&
  ["id", "board_id", "user_id", "title", "body", "created_at"].every(key => typeof message[key] === "string") &&
  Number.isFinite(Date.parse(message.created_at)) &&
  (message.reply_count === undefined || (Number.isSafeInteger(message.reply_count) && message.reply_count >= 0)) &&
  (message.video == null || isMessageVideo(message.video));
const isReply = (reply) => reply &&
  ["id", "message_id", "user_id", "body", "created_at"].every(key => typeof reply[key] === "string") &&
  reply.id.trim().length > 0 && reply.message_id.trim().length > 0 && reply.user_id.trim().length > 0 &&
  Number.isFinite(Date.parse(reply.created_at)) && reply.body.trim().length > 0 && reply.body.length <= 2000 &&
  (reply.parent_reply_id == null || (typeof reply.parent_reply_id === "string" &&
    reply.parent_reply_id.trim().length > 0 && reply.parent_reply_id !== reply.id)) &&
  (reply.author_name === undefined || reply.author_name === null || typeof reply.author_name === "string") &&
  (reply.direct_reply_count === undefined || (Number.isSafeInteger(reply.direct_reply_count) && reply.direct_reply_count >= 0));
const acceptedBoardLogoTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const maxBoardLogoBytes = 5 * 1024 * 1024;
const messageImagePathPattern = /^\/board-messages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/;

export function messageImageError(file) {
  if (!(file instanceof File) || !acceptedBoardLogoTypes.has(file.type) || file.size < 1) {
    return "Choose a PNG, JPEG, WebP, or GIF image.";
  }
  return file.size > maxBoardLogoBytes ? "Choose an image smaller than 5 MB." : "";
}

export function messageBodyLength(text, image) {
  if (!image) return text.trim().length;
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image.type];
  const url = new URL(`/board-messages/00000000-0000-0000-0000-000000000000.${extension}`, messageBoardConfig.apiOrigin);
  return serializeMessageBody(text, "", url.href).trim().length;
}
const isBoard = (board) => board && typeof board.id === "string" &&
  typeof board.slug === "string" && /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(board.slug) &&
  typeof board.name === "string" && typeof board.description === "string" &&
  (board.logo_url === undefined || board.logo_url === null ||
    (typeof board.logo_url === "string" && boardLogoPathPattern.test(board.logo_url)));

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

function safeUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function safeException(error, token) {
  const rawMessage = typeof error?.message === "string" ? error.message : "";
  const redactedMessage = rawMessage
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .split(token).join("[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => safeUrl(value) ?? "[redacted URL]");
  const message = redactedMessage.slice(0, 240) || undefined;
  return { exceptionName: error?.name || "Error", ...(message ? { exceptionMessage: message } : {}) };
}

function previewFailureKind(error) {
  if (typeof error?.previewReason === "string") return error.previewReason;
  if (error?.name === "TimeoutError") return "timeout";
  if (error?.name === "TypeError") return "network-or-cors";
  return "request-error";
}

function previewDetails(payload, target, previewId, httpStatus, startedAt) {
  return {
    target: safeUrl(target.href),
    ...(typeof payload?.source === "string" ? { source: payload.source } : {}),
    ...(typeof payload?.error === "string" ? { error: payload.error.slice(0, 160) } : {}),
    ...(payload?.diagnostics && typeof payload.diagnostics === "object" ? { diagnostics: payload.diagnostics } : {}),
    ...(typeof (payload?.previewId ?? previewId) === "string" ? { previewId: payload.previewId ?? previewId } : {}),
    httpStatus,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

async function responsePayload(response) {
  try {
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw Object.assign(new Error("Preview API returned an invalid response shape."), { previewReason: "invalid-response" });
    }
    return payload;
  } catch (error) {
    if (error?.previewReason || error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    throw Object.assign(new Error("Preview API returned malformed JSON."), { previewReason: "malformed-json", cause: error });
  }
}

function previewError(message, reason) {
  return Object.assign(new Error(message), { previewReason: reason });
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
  const startedAt = performance.now();
  let previewId = null;
  let lastHttpStatus;
  let lastEndpoint = url.pathname;
  try {
    combinedSignal.throwIfAborted();
    previewLog("info", "request started", { method: "POST", endpoint: url.pathname, target: safeUrl(target.href) });
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
    while (true) {
      combinedSignal.throwIfAborted();
      lastHttpStatus = response.status;
      lastEndpoint = response.url ? safeUrl(response.url) : (statusUrl?.pathname ?? url.pathname);
      if (response.status !== 200 && response.status !== 202) {
        let errorPayload = null;
        try { errorPayload = await responsePayload(response); } catch {}
        const details = previewDetails(errorPayload, target, previewId, response.status, startedAt);
        previewLog("warn", "API request failed", { reason: "api-error", ...details });
        throw previewError("Link preview API request failed.", "api-error");
      }
      payload = await responsePayload(response);
      const details = previewDetails(payload, target, previewId, response.status, startedAt);
      previewLog("info", "response received", { status: payload.status, ...details });
      if (response.status === 200) {
        if (!["ready", "failed"].includes(payload.status)) {
          throw previewError("Preview API returned an invalid terminal status.", "invalid-response-status");
        }
        const image = validatedImage(payload.image);
        if (!image) previewLog("info", "terminal response has no usable image", {
          reason: payload.image == null ? "missing-image" : "invalid-image-url", ...details,
        });
        return image;
      }

      if (payload.status !== "pending" || typeof payload.previewId !== "string" || !previewIdPattern.test(payload.previewId)) {
        throw previewError("Preview API returned an invalid pending response.", "invalid-response-status");
      }
      if (previewId !== null && payload.previewId !== previewId) throw previewError("Preview API changed the preview ID while polling.", "invalid-response-status");
      previewId = payload.previewId;
      const validatedUrl = validatedPreviewUrl(payload.statusUrl, previewId);
      if (!validatedUrl || (statusUrl && validatedUrl.href !== statusUrl.href)) {
        const unsafeDetails = previewDetails(payload, target, previewId, response.status, startedAt);
        previewLog("warn", "polling URL rejected", { reason: "unsafe-polling-url", ...unsafeDetails });
        throw previewError("Preview API returned an unsafe polling URL.", "unsafe-polling-url");
      }
      statusUrl = validatedUrl;
      await waitForRetry(retryDelay(response), combinedSignal);
      lastEndpoint = statusUrl.pathname;
      lastHttpStatus = undefined;
      response = await fetcher(statusUrl, { ...requestOptions, method: "GET" });
    }
  } catch (error) {
    const failure = timeoutController.signal.aborted && !signal?.aborted ? timeoutController.signal.reason : error;
    if (signal?.aborted || failure?.name === "AbortError") {
      previewLog("info", "lookup cancelled");
    } else {
      previewLog("warn", "lookup failed", {
        reason: previewFailureKind(failure), target: safeUrl(target.href), endpoint: lastEndpoint,
        ...(lastHttpStatus === undefined ? {} : { httpStatus: lastHttpStatus }),
        ...(previewId ? { previewId } : {}), elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...safeException(failure, session.token),
      });
    }
    throw failure;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export async function fetchMessages(fetcher = fetch, { boardId, messageId, limit = 20, offset, order = "created_at.desc" } = {}) {
  const params = {
    select: "id,board_id,user_id,title,body,created_at,reply_count,video",
    order,
    limit: messageId === undefined ? String(limit) : "1",
  };
  if (boardId !== undefined) params.board_id = `eq.${boardId}`;
  if (messageId !== undefined) params.id = `eq.${messageId}`;
  if (offset !== undefined) params.offset = String(offset);
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

export const messageSortOrders = {
  "votes-desc": "votes.desc,created_at.desc",
  "votes-asc": "votes.asc,created_at.desc",
  "date-desc": "created_at.desc",
  "date-asc": "created_at.asc",
};

export async function fetchMessagesPage(page = 1, fetcher = fetch, { sort = "votes-desc" } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid message page");
  if (!Object.hasOwn(messageSortOrders, sort)) throw new Error("Invalid message sort");
  const limit = 20;
  const offset = (page - 1) * limit;
  const order = messageSortOrders[sort];
  const messages = await fetchMessages(fetcher, { limit, offset, order });
  // Check for another row so a full final page doesn't lead to an empty page.
  const next = messages.length === limit
    ? await fetchMessages(fetcher, { limit: 1, offset: offset + limit, order })
    : [];
  return { messages, hasNext: next.length > 0 };
}

async function readReplyPayload(url, fetcher) {
  const session = readStoredSession();
  const response = await fetcher(url, {
    headers: session ? { authorization: `Bearer ${session.token}` } : {},
    mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) throw new Error("This message or reply is no longer available.");
  if (!response.ok) throw new Error("Replies unavailable. Please try again.");
  return response.json().catch(() => null);
}

export async function fetchReplyPage(messageId, { parentReplyId = null, cursor = null, limit = 20, sort = "new" } = {}, fetcher = fetch) {
  if (typeof messageId !== "string" || !messageId.trim()) throw new Error("Choose a message to view replies.");
  if (parentReplyId !== null && (typeof parentReplyId !== "string" || !parentReplyId.trim())) {
    throw new Error("Choose a valid reply to view.");
  }
  if (!["new", "old", "top"].includes(sort) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
    (cursor !== null && (typeof cursor !== "string" || !cursor.trim() || cursor.length > 8192))) {
    throw new Error("Invalid reply page");
  }
  const url = new URL(`/messages/${encodeURIComponent(messageId)}/replies`, messageBoardConfig.apiOrigin);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", sort);
  if (parentReplyId !== null) url.searchParams.set("parent_reply_id", parentReplyId);
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  const payload = await readReplyPayload(url, fetcher);
  const replies = payload?.data;
  const nextCursor = payload?.meta?.next_cursor;
  if (!Array.isArray(replies) || replies.length > limit ||
    !replies.every(reply => isReply(reply) && reply.message_id === messageId &&
      (reply.parent_reply_id ?? null) === parentReplyId && Number.isSafeInteger(reply.direct_reply_count)) ||
    new Set(replies.map(reply => reply.id)).size !== replies.length ||
    !(nextCursor === null || (typeof nextCursor === "string" && nextCursor.trim() && nextCursor.length <= 8192 &&
      nextCursor !== cursor && replies.length > 0))) {
    throw new Error("Invalid replies");
  }
  return { replies, nextCursor };
}

export async function fetchReplyContext(messageId, replyId, { limit = 6 } = {}, fetcher = fetch) {
  if (typeof messageId !== "string" || !messageId.trim() || typeof replyId !== "string" || !replyId.trim()) {
    throw new Error("Choose a message and reply to view.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid reply context");
  const url = new URL(`/messages/${encodeURIComponent(messageId)}/replies/${encodeURIComponent(replyId)}/context`, messageBoardConfig.apiOrigin);
  url.searchParams.set("limit", String(limit));
  const payload = await readReplyPayload(url, fetcher);
  const replies = payload?.data;
  const hasMore = payload?.meta?.has_more;
  if (!Array.isArray(replies) || replies.length < 1 || replies.length > limit || typeof hasMore !== "boolean" ||
    !replies.every((reply, index) => isReply(reply) && reply.message_id === messageId && Number.isSafeInteger(reply.direct_reply_count) &&
      (index === 0 || reply.parent_reply_id === replies[index - 1].id)) ||
    replies.at(-1).id !== replyId || new Set(replies.map(reply => reply.id)).size !== replies.length ||
    (hasMore ? replies[0].parent_reply_id == null || replies.some(reply => reply.id === replies[0].parent_reply_id)
      : replies[0].parent_reply_id != null)) {
    throw new Error("Invalid replies");
  }
  return { replies, hasMore };
}

export async function fetchReplies(messageId, fetcher = fetch) {
  if (typeof messageId !== "string" || !messageId.trim()) throw new Error("Choose a message to view replies.");
  const replies = [];
  for (let offset = 0; ; offset += 100) {
    const page = await readRows("replies", {
      select: "id,message_id,parent_reply_id,user_id,body,created_at,direct_reply_count",
      message_id: `eq.${messageId}`,
      order: "created_at.asc",
      limit: "100",
      offset: String(offset),
    }, fetcher);
    if (!page.every(reply => isReply(reply) && reply.message_id === messageId)) {
      throw new Error("Invalid replies");
    }
    replies.push(...page);
    if (page.length < 100) break;
  }
  // Validate after pagination: a parent can arrive on a later page. Walking
  // iteratively keeps deep threads safe without imposing a nesting limit.
  const byId = new Map(replies.map(reply => [reply.id, reply]));
  if (byId.size !== replies.length) throw new Error("Invalid replies");
  const resolved = new Set();
  for (const reply of replies) {
    let current = reply;
    const path = new Set();
    while (!resolved.has(current.id)) {
      if (path.has(current.id)) throw new Error("Invalid replies");
      path.add(current.id);
      if (current.parent_reply_id == null) break;
      current = byId.get(current.parent_reply_id);
      if (!current) throw new Error("Invalid replies");
    }
    for (const id of path) resolved.add(id);
  }
  return replies;
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
    select: "id,slug,name,description,user_id,logo_url", ...params,
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

async function insertRow(table, values, validate, fetcher, { image, video, idempotencyKey } = {}) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Open Account and sign in again to continue.");
  const { apiOrigin } = messageBoardConfig;
  const url = new URL(`/tables/${encodeURIComponent(table)}`, apiOrigin);
  const headers = { authorization: `Bearer ${session.token}` };
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  let body;
  if (image) {
    body = new FormData();
    for (const [key, value] of Object.entries({ ...values, user_id: session.session.user_id })) body.set(key, value);
    body.set("image", image);
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ ...values, user_id: session.session.user_id });
  }
  let response;
  try {
    response = await fetcher(url, {
      method: "POST", mode: "cors", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers, body,
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
  if (response.status === 409 && table === "replies") throw new Error("This reply changed during a retry. Edit your reply and try again.");
  if (video && response.status === 409) throw new Error("This video is still processing or was already posted. Check the sub-yap before trying again.");
  if (response.status === 404 && table === "replies") throw new Error("This message or reply is no longer available. Reload the thread before trying again.");
  if (image && response.status === 404) throw new Error("This sub-yap is no longer available.");
  if (image && response.status === 413) throw new Error("Choose an image smaller than 5 MB.");
  if (image && response.status === 415) throw new Error("Choose a valid PNG, JPEG, WebP, or GIF image.");
  if (image && response.status === 503) throw new Error("Image uploads are unavailable right now. Please try again.");
  if (!response.ok) throw new Error("Could not create this right now. Please try again.");
  const payload = await response.json().catch(() => null);
  const row = payload?.data?.[0];
  let expected = values;
  if (image) {
    if (typeof row?.image_url !== "string" || !messageImagePathPattern.test(row.image_url)) {
      throw new Error("Could not confirm creation. Check the sub-yap before trying again.");
    }
    expected = { ...values, body: serializeMessageBody(values.body, "", new URL(row.image_url, apiOrigin).href).trim() };
  }
  if (video) {
    const { attachment_id, ...textValues } = values;
    expected = { ...textValues, body: `${video.watch_url}${values.body ? `\n${values.body}` : ""}` };
    if (row?.video?.id !== attachment_id) throw new Error("Could not confirm creation. Check the sub-yap before trying again.");
  }
  if (!Array.isArray(payload?.data) || payload.data.length !== 1 || !validate(row) || !row.id ||
    row.user_id !== session.session.user_id || Object.entries(expected).some(([key, value]) => row[key] !== value)) {
    throw new Error("Could not confirm creation. Check the sub-yap before trying again.");
  }
  return row;
}

export async function createBoard(name, description, fetcher = fetch) {
  const cleanName = name.trim();
  const cleanDescription = description.replace(/\r\n?/g, "\n").trim();
  if (!cleanName || cleanName.length > 80) throw new Error("Enter a sub-yap name of 1–80 characters.");
  if (cleanDescription.length > 2000) throw new Error("Enter a description of at most 2000 characters.");
  const slug = cleanName.toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error("Use letters (a–z), numbers, spaces, or hyphens in the sub-yap name, starting and ending with a letter or number.");
  }
  return insertRow("boards", { slug, name: cleanName, description: cleanDescription }, isBoard, fetcher);
}

export async function updateBoard(board, { description, logo, removeLogo = false } = {}, fetcher = fetch) {
  if (!isBoard(board) || !board.id.trim() || typeof board.user_id !== "string" || !board.user_id.trim()) {
    throw new Error("Choose a sub-yap to edit.");
  }
  // Multipart uploads normalize newlines to CRLF; compare and keep LF text.
  const cleanDescription = typeof description === "string" ? description.replace(/\r\n?/g, "\n").trim() : null;
  if (cleanDescription === null || cleanDescription.length > 2000) {
    throw new Error("Enter a description of at most 2000 characters.");
  }
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Log in again to edit this sub-yap.");
  if (board.user_id !== session.user.id) throw new Error("You can only edit sub-yaps you created.");
  if (logo && removeLogo) throw new Error("Choose a logo to upload or remove, not both.");
  if (logo && (!acceptedBoardLogoTypes.has(logo.type) || !Number.isFinite(logo.size) || logo.size < 1)) {
    throw new Error("Choose a PNG, JPEG, WebP, or GIF logo.");
  }
  if (logo?.size > maxBoardLogoBytes) throw new Error("Choose a logo smaller than 5 MB.");
  const url = new URL("/tables/boards", messageBoardConfig.apiOrigin);
  url.searchParams.set("id", `eq.${board.id}`);
  url.searchParams.set("user_id", `eq.${session.user.id}`);
  let response;
  let headers = { authorization: `Bearer ${session.token}` };
  let body;
  if (logo) {
    body = new FormData();
    body.set("description", cleanDescription);
    body.set("logo", logo);
  } else {
    body = JSON.stringify(removeLogo
      ? { description: cleanDescription, remove_logo: true }
      : { description: cleanDescription });
    headers["content-type"] = "application/json";
  }
  try {
    response = await fetcher(url, {
      method: "PATCH", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers,
      body,
    });
  } catch {
    throw new Error("Could not confirm your changes. Check your connection and reload the sub-yap before trying again.");
  }
  if (response.status === 401) {
    storeSession(null);
    throw new Error("Your session has expired. Log in again to edit this sub-yap.");
  }
  if (response.status === 403) throw new Error("You don’t have permission to edit this sub-yap.");
  if (response.status === 404) throw new Error("This sub-yap is no longer available.");
  if (response.status === 409) throw new Error("This sub-yap changed while you were editing. Reload it and try again.");
  if (response.status === 413) throw new Error("Choose a logo smaller than 5 MB.");
  if (response.status === 415) throw new Error("Choose a valid PNG, JPEG, WebP, or GIF image.");
  if (!response.ok) throw new Error("Could not save your changes. Please try again.");
  const payload = await response.json().catch(() => null);
  const updated = payload?.data?.[0];
  if (!Array.isArray(payload?.data) || payload.data.length !== 1 || !isBoard(updated) ||
    updated.id !== board.id || updated.user_id !== session.user.id || updated.slug !== board.slug ||
    updated.name !== board.name || updated.description.replace(/\r\n?/g, "\n").trim() !== cleanDescription ||
    (removeLogo && updated.logo_url != null) ||
    (logo && (typeof updated.logo_url !== "string" || !boardLogoPathPattern.test(updated.logo_url)))) {
    throw new Error("Could not confirm your changes. Reload the sub-yap to check it.");
  }
  return { ...updated, description: cleanDescription };
}

export async function updateBoardDescription(board, description, fetcher = fetch) {
  return updateBoard(board, { description }, fetcher);
}

export async function createMessage(boardId, title, body, fetcher = fetch, { image, video } = {}) {
  const cleanTitle = title.trim();
  const cleanBody = body.replace(/\r\n?/g, "\n").trim();
  if (!boardId.trim()) throw new Error("Choose a sub-yap for your message.");
  if (!cleanTitle || cleanTitle.length > 200) throw new Error("Enter a title of 1–200 characters.");
  if (image && messageImageError(image)) throw new Error(messageImageError(image));
  if (video && (image || !isMessageVideo(video) || !["ready", "processing"].includes(video.status) || !video.watch_url)) {
    throw new Error("Wait for your video upload to finish before posting.");
  }
  const length = video ? video.watch_url.length + (cleanBody ? cleanBody.length + 1 : 0) : messageBodyLength(cleanBody, image);
  if ((!cleanBody && !image && !video) || length > 2000) throw new Error(video
    ? "Shorten your message to make room for the video." : "Enter a message of 1–2000 characters, including its image URL.");
  return insertRow(messageBoardConfig.table, { board_id: boardId, title: cleanTitle, body: cleanBody,
    ...(video ? { attachment_id: video.id } : {}) }, isMessage, fetcher, { image, video });
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

export async function createReply(messageId, body, fetcher = fetch, { parentReplyId = null, idempotencyKey } = {}) {
  if (typeof messageId !== "string" || typeof body !== "string") {
    throw new Error("Enter a message and reply.");
  }
  const cleanBody = body.trim();
  if (!messageId.trim()) throw new Error("Choose a message to reply to.");
  if (parentReplyId !== null && (typeof parentReplyId !== "string" || !parentReplyId.trim())) {
    throw new Error("Choose a valid reply to respond to.");
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey))) {
    throw new Error("Invalid reply request. Reload the thread before trying again.");
  }
  if (!cleanBody || cleanBody.length > 2000) throw new Error("Enter a reply of 1–2000 characters.");
  const values = { message_id: messageId, body: cleanBody };
  if (parentReplyId !== null) values.parent_reply_id = parentReplyId;
  return insertRow("replies", values,
    reply => isReply(reply) && (reply.parent_reply_id ?? null) === parentReplyId, fetcher, { idempotencyKey });
}
