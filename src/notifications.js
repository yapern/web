import { mountBoardSidebars } from "./board-sidebars.js";
import { messageHref } from "./board-routes.js";
import { readStoredSession } from "./auth.js";
import { notificationsApi, notificationsLive } from "./notifications-live.js";
import { replyAnchor } from "./reply-tree.js";

mountBoardSidebars();

const status = document.querySelector("#notifications-status");
const list = document.querySelector("#notifications-list");
const retry = document.querySelector("#notifications-retry");
const login = document.querySelector("#notifications-login");
const readStatus = document.querySelector("#notifications-read-status");
const readRetry = document.querySelector("#notifications-read-retry");
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
let renderedSession = null;
let sessionGeneration = 0;
let lastAttemptedThrough = 0;
let lastReadThrough = 0;
let pendingReadThrough = 0;
let readErrorThrough = 0;
let markingRead = false;

function renderSnapshot(snapshot) {
  list.replaceChildren(...snapshot.notifications.map(notification => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "notification-item-link";
    const messageLink = messageHref(notification.board_slug, notification.message_id);
    link.href = notification.kind === "upvote" && !notification.reply_id
      ? messageLink
      : `${messageLink}#${encodeURIComponent(replyAnchor(notification.reply_id))}`;
    const heading = document.createElement("span");
    heading.className = "notification-item-heading";
    const actor = notification.actor_name || "Someone";
    if (notification.kind === "upvote") {
      const title = notification.message_title || "your message";
      heading.textContent = notification.reply_id
        ? `${actor} upvoted your reply to “${title}”`
        : `${actor} upvoted “${title}”`;
    } else {
      heading.textContent = `${actor} replied to “${notification.message_title || "your message"}”`;
    }
    const time = document.createElement("time");
    time.dateTime = notification.created_at;
    time.textContent = dateFormat.format(new Date(notification.created_at));
    link.append(heading, time);
    item.append(link);
    return item;
  }));
  list.hidden = snapshot.notifications.length === 0;
  list.setAttribute("aria-busy", "false");
  retry.hidden = true;
  login.hidden = true;
  if (snapshot.notifications.length) status.textContent = "";
  else status.textContent = "No notifications yet.";
}

function render(state) {
  const sessionKey = state.session ? `${state.session.user.id}:${state.session.token}` : null;
  if (renderedSession !== sessionKey) {
    renderedSession = sessionKey;
    sessionGeneration++;
    lastAttemptedThrough = 0;
    lastReadThrough = 0;
    pendingReadThrough = 0;
    readErrorThrough = 0;
    markingRead = false;
    readStatus.hidden = true;
    readStatus.textContent = "";
    readRetry.hidden = true;
  }
  if (!state.session) {
    list.hidden = true;
    list.replaceChildren();
    list.setAttribute("aria-busy", "false");
    status.textContent = "Log in to see your notifications.";
    retry.hidden = true;
    login.hidden = false;
    readStatus.hidden = true;
    readRetry.hidden = true;
    return;
  }
  login.hidden = true;
  if (state.snapshot) renderSnapshot(state.snapshot);
  else if (state.loading) {
    status.textContent = "Loading notifications…";
    list.hidden = true;
    list.setAttribute("aria-busy", "true");
    retry.hidden = true;
  } else if (state.error) {
    status.textContent = state.error;
    list.hidden = true;
    list.setAttribute("aria-busy", "false");
    retry.hidden = false;
  }
  if (state.snapshot && state.error && !state.snapshot.notifications.length) status.textContent = state.error;
  if (state.snapshot) {
    if (state.snapshot.unread_count > 0 && state.snapshot.last_id > lastReadThrough) {
      pendingReadThrough = Math.max(pendingReadThrough, state.snapshot.last_id);
    } else if (state.snapshot.unread_count === 0) {
      lastReadThrough = Math.max(lastReadThrough, state.snapshot.last_id);
      if (readErrorThrough <= lastReadThrough) readErrorThrough = 0;
    }
    if (!document.hidden) processReadQueue();
  }
  updateReadFeedback();
}

function updateReadFeedback() {
  const failed = readErrorThrough > lastReadThrough;
  readStatus.hidden = !failed;
  readStatus.textContent = failed ? "Couldn’t mark notifications as read." : "";
  readRetry.hidden = !failed;
}

function processReadQueue(forceRetry = false) {
  if (markingRead || document.hidden || !renderedSession) return;
  const throughId = Math.max(pendingReadThrough, forceRetry ? readErrorThrough : 0);
  if (throughId <= lastReadThrough || (!forceRetry && throughId <= lastAttemptedThrough)) return;
  const session = readStoredSession();
  const sessionKey = session ? `${session.user.id}:${session.token}` : null;
  if (!session || sessionKey !== renderedSession) return;
  const operationGeneration = sessionGeneration;
  lastAttemptedThrough = Math.max(lastAttemptedThrough, throughId);
  readErrorThrough = 0;
  markingRead = true;
  updateReadFeedback();
  void finishReadRequest(throughId, session, sessionKey, operationGeneration);
}

async function finishReadRequest(throughId, session, sessionKey, operationGeneration) {
  try {
    const updated = await notificationsApi.markRead(throughId, session);
    if (operationGeneration !== sessionGeneration || renderedSession !== sessionKey) return;
    const currentSession = readStoredSession();
    if (!currentSession || `${currentSession.user.id}:${currentSession.token}` !== sessionKey) return;
    lastReadThrough = Math.max(lastReadThrough, throughId);
    notificationsLive.acceptSnapshot(updated);
  } catch (cause) {
    if (operationGeneration !== sessionGeneration || renderedSession !== sessionKey) return;
    if (cause?.status === 401) {
      notificationsLive.syncSession(readStoredSession());
      return;
    }
    readErrorThrough = Math.max(readErrorThrough, throughId);
  } finally {
    if (operationGeneration === sessionGeneration && renderedSession === sessionKey) {
      markingRead = false;
      updateReadFeedback();
      processReadQueue();
    }
  }
}

retry.addEventListener("click", () => { void notificationsLive.refresh(); });
readRetry.addEventListener("click", () => processReadQueue(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden) processReadQueue(); });

notificationsLive.subscribe(render);
notificationsLive.start(readStoredSession());
