import { fetchMessages, fetchMessagesPage, fetchBoards, fetchBoardPage, fetchMessageAuthors, deleteMessage } from "./messages-api.js";
import { readStoredSession } from "./auth.js";
import { boardHref, messageHref, parseBoardRoute } from "./board-routes.js";
import { mountBoardSidebars } from "./board-sidebars.js";
import { parseMessageText } from "./message-text.js";
import { externalLinkHref } from "./external-links.js";
import { mountReplies } from "./replies.js";
import { createVoteControl } from "./votes.js";
import { replyAnchor } from "./reply-tree.js";
import { messageCaption, messageVideoElement } from "./message-video.js";

const list = document.querySelector("#live-messages");
const status = document.querySelector("#messages-status");
const retry = document.querySelector("#messages-retry");
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const heading = document.querySelector("#messages-title");
const isBoardPage = document.body.classList.contains("board-page");
const isAllPage = /^\/all\/?$/.test(window.location.pathname);
let route = isBoardPage ? parseBoardRoute(window.location.pathname) : null;
let messageLoad = 0;
let disposeReplies;
const requestedPage = Number(new URLSearchParams(window.location.search).get("page"));
const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
const pagination = document.querySelector("#messages-pagination");

function renderPagination(hasNext) {
  if (!isAllPage) return;
  const previous = document.createElement(page > 1 ? "a" : "span");
  previous.textContent = "Previous";
  if (page > 1) {
    previous.href = page === 2 ? "/all" : `/all?page=${page - 1}`;
    previous.rel = "prev";
  } else {
    previous.setAttribute("aria-disabled", "true");
  }
  const current = document.createElement("span");
  current.textContent = `Page ${page}`;
  const next = document.createElement(hasNext ? "a" : "span");
  next.textContent = "Next";
  if (hasNext) {
    next.href = `/all?page=${page + 1}`;
    next.rel = "next";
  } else {
    next.setAttribute("aria-disabled", "true");
  }
  pagination.replaceChildren(previous, current, next);
  pagination.hidden = page === 1 && !hasNext;
}

function syncDeleteAction() {
  const button = list.querySelector(".live-message-delete");
  if (button) button.hidden = readStoredSession()?.session.user_id !== button.dataset.authorId;
}

function messageTextLink(part) {
  const link = document.createElement("a");
  link.href = externalLinkHref(part.href, window.location.origin);
  link.textContent = part.text;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function updateReplyCount(action, count) {
  action.querySelector(".live-message-reply-count").textContent = String(count);
  const total = `${count} ${count === 1 ? "reply" : "replies"}`;
  action.setAttribute("aria-label", action.tagName === "BUTTON" ? `Reply; ${total}` : `${total}${action.href ? "" : "; reply unavailable"}`);
}

function messageRow(message, board, authors, { onReply } = {}) {
  const item = document.createElement("li");
  const article = document.createElement("article");
  const title = message.title === undefined ? null : document.createElement(isBoardPage ? "h2" : "h3");
  if (title) {
    title.className = "live-message-title";
    if (board) {
      const link = document.createElement("a");
      link.href = messageHref(board.slug, message.id);
      link.textContent = message.title;
      title.append(link);
    } else {
      title.textContent = message.title;
    }
  }
  const meta = document.createElement("p");
  meta.className = "live-message-meta";
  if (board) {
    const link = document.createElement("a");
    link.className = "live-message-board";
    link.href = boardHref(board.slug);
    link.textContent = `y/${board.slug}`;
    meta.append(link, document.createTextNode(" · "));
  }
  const author = document.createElement("span");
  author.className = "live-message-author";
  author.textContent = authors.get(message.user_id) ?? "Name unavailable";
  const date = document.createElement("time");
  date.dateTime = message.created_at;
  date.textContent = dateFormat.format(new Date(message.created_at));
  meta.append(author, document.createTextNode(" · "), date);
  const body = document.createElement("p");
  body.className = "live-message-body";
  const youtubeParts = [];
  for (const part of parseMessageText(messageCaption(message))) {
    if (part.youtubeEmbed) {
      youtubeParts.push(part);
    } else if (part.imageUrl) {
      const image = document.createElement("img");
      image.className = "live-message-image";
      image.referrerPolicy = "no-referrer";
      image.src = part.imageUrl;
      image.alt = "Shared image";
      image.loading = "lazy";
      image.decoding = "async";
      let imageContainer = image;
      if (board) {
        const link = document.createElement("a");
        link.href = route?.slug === board.slug && route?.messageId === message.id
          ? part.imageUrl
          : messageHref(board.slug, message.id);
        link.append(image);
        imageContainer = link;
      }
      image.addEventListener("error", () => imageContainer.replaceWith(messageTextLink(part)), { once: true });
      body.append(imageContainer);
    } else if (part.href) {
      body.append(messageTextLink(part));
    } else {
      body.append(document.createTextNode(part.text));
    }
  }
  article.append(meta);
  if (title) article.append(title);
  article.append(body);
  if (message.video) {
    const video = messageVideoElement(message.video, message.title);
    if (video) article.append(video);
    if (!body.childNodes.length) body.hidden = true;
  }
  for (const part of youtubeParts) {
    const video = document.createElement("iframe");
    video.className = "live-message-video";
    video.width = 560;
    video.height = 315;
    video.src = part.youtubeEmbed;
    video.title = "YouTube video player";
    video.setAttribute("frameborder", "0");
    video.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
    video.referrerPolicy = "strict-origin-when-cross-origin";
    video.allowFullscreen = true;
    video.loading = "lazy";
    article.append(video);
  }
  const boardSlug = board?.slug ?? route?.slug;
  const actions = document.createElement("div");
  actions.className = "live-message-actions";

  const votes = createVoteControl({ type: message.message_id ? "reply" : "message", id: message.id });

  const reply = document.createElement(onReply ? "button" : boardSlug ? "a" : "span");
  reply.className = `live-message-action live-message-reply${boardSlug ? "" : " live-message-action-static"}`;
  if (onReply) {
    reply.type = "button";
    reply.addEventListener("click", () => onReply(message));
  } else if (boardSlug) reply.href = `${messageHref(boardSlug, message.message_id ?? message.id)}#message-replies-section`;
  const replyCount = document.createElement("span");
  replyCount.className = "live-message-reply-count";
  reply.append(actionIcon("message", ""), replyCount);
  updateReplyCount(reply, message.reply_count ?? message.direct_reply_count ?? 0);

  const repost = document.createElement("span");
  repost.className = "live-message-action live-message-action-static";
  repost.setAttribute("aria-label", "Reposting unavailable");
  repost.append(actionIcon("repost", ""));

  const share = document.createElement("button");
  share.className = "live-message-action live-message-share";
  share.type = "button";
  share.disabled = !boardSlug;
  share.setAttribute("aria-label", "Share message");
  share.title = "Share message";
  const shareLabel = document.createElement("span");
  shareLabel.className = "live-message-share-label";
  shareLabel.textContent = "Share";
  share.append(actionIcon("share", ""), shareLabel);
  const shareStatus = document.createElement("span");
  shareStatus.className = "live-message-action-status";
  shareStatus.setAttribute("role", "status");
  shareStatus.setAttribute("aria-live", "polite");
  share.addEventListener("click", async () => {
    shareStatus.textContent = "";
    const url = new URL(messageHref(boardSlug, message.message_id ?? message.id), window.location.origin);
    if (message.message_id) url.hash = replyAnchor(message.id);
    if (navigator.share) {
      try {
        await navigator.share({ title: message.title || "Yapern message", url: url.href });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url.href);
      shareStatus.textContent = "Link copied.";
    } catch {
      shareStatus.textContent = "Sharing is unavailable.";
    }
  });
  actions.append(votes, reply);
  if (onReply) actions.append(repost);
  actions.append(share, shareStatus);
  article.append(actions);
  if (board && route?.messageId === message.id) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "live-message-action live-message-delete";
    remove.textContent = "Delete";
    remove.dataset.authorId = message.user_id;
    remove.hidden = true;
    const error = document.createElement("p");
    error.className = "create-error live-message-delete-error";
    error.setAttribute("role", "alert");
    remove.addEventListener("click", async () => {
      syncDeleteAction();
      if (remove.hidden || remove.disabled) return;
      if (!window.confirm("Delete this message and all its replies? This cannot be undone.")) return;
      remove.disabled = true;
      remove.textContent = "Deleting…";
      remove.setAttribute("aria-busy", "true");
      error.textContent = "";
      try {
        await deleteMessage(message);
        window.location.replace(boardHref(board.slug));
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : "Could not delete this message right now. Please try again.";
      } finally {
        remove.disabled = false;
        remove.textContent = "Delete";
        remove.setAttribute("aria-busy", "false");
        syncDeleteAction();
      }
    });
    actions.insertBefore(remove, shareStatus);
    article.append(error);
  }
  item.append(article);
  return item;
}

function actionIcon(name, label) {
  const paths = {
    "arrow-up": '<path d="M12 3 5 10h4v11h6V10h4L12 3Z"/>',
    "arrow-down": '<path d="m12 21 7-7h-4V3H9v11H5l7 7Z"/>',
    message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/>',
    repost: '<path d="M20 11a8 8 0 0 0-14-5L4 8m0 0V4m0 4h4M4 13a8 8 0 0 0 14 5l2-2m0 0v4m0-4h-4"/>',
    share: '<path d="M14 3v5C7 8 3 12 3 21c3-5 7-7 11-7v5l8-8-8-8Z"/>'
  };
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  if (label) {
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", label);
  } else {
    icon.setAttribute("aria-hidden", "true");
  }
  icon.innerHTML = paths[name];
  return icon;
}

async function loadMessages() {
  const load = ++messageLoad;
  const requestedRoute = route;
  list.setAttribute("aria-busy", "true");
  retry.hidden = true;
  if (pagination) pagination.hidden = true;
  status.textContent = "Loading messages…";
  try {
    let data;
    let boards;
    let hasNext = false;
    if (isAllPage) {
      const [result, allBoards] = await Promise.all([fetchMessagesPage(page), fetchBoards()]);
      data = result.messages;
      hasNext = result.hasNext;
      boards = allBoards;
    } else if (isBoardPage) {
      const result = requestedRoute && await fetchBoardPage(requestedRoute.slug, requestedRoute.messageId);
      if (load !== messageLoad) return;
      if (!result) {
        const resource = route?.messageId === undefined ? "Sub-yap" : "Message";
        heading.textContent = `${resource} not found`;
        document.title = `${resource} not found · Yapern`;
        status.textContent = `We couldn't find that ${resource.toLowerCase()}.`;
        list.replaceChildren();
        return;
      }
      data = result.messages;
      boards = [result.board];
      heading.textContent = `y/${result.board.slug}`;
      document.title = `${route.messageId === undefined ? `y/${result.board.slug}` : data[0].title} · Yapern`;
    } else {
      [data, boards] = await Promise.all([
        fetchMessages(undefined, { limit: 3, order: "votes.desc,created_at.desc" }),
        fetchBoards(),
      ]);
    }
    // Keep posts readable if profile lookups are temporarily unavailable.
    const authors = await fetchMessageAuthors(data).catch(() => new Map());
    if (load !== messageLoad) return;
    const byId = new Map(boards.map(board => [board.id, board]));
    disposeReplies?.();
    disposeReplies = null;
    list.replaceChildren(...data.map(message => messageRow(message, byId.get(message.board_id), authors)));
    syncDeleteAction();
    status.textContent = data.length ? "" : isAllPage && page > 1 ? "No messages on this page." : "No messages yet.";
    renderPagination(hasNext);
    const showingMessage = route?.messageId !== undefined && data.length > 0;
    const replies = document.querySelector("#message-replies-section");
    if (replies) replies.hidden = !showingMessage;
    if (showingMessage) {
      const message = data[0];
      disposeReplies = mountReplies(message.id, (reply, replyAuthors, options) => messageRow(reply, null, replyAuthors, options), () => {
        message.reply_count = (message.reply_count ?? 0) + 1;
        const action = list.querySelector(".live-message-reply");
        if (action) updateReplyCount(action, message.reply_count);
      });
    }
  } catch {
    if (load !== messageLoad) return;
    status.textContent = "Messages are unavailable right now. Please try again.";
    retry.hidden = false;
  } finally {
    if (load === messageLoad) list.setAttribute("aria-busy", "false");
  }
}

function syncBoardRoute() {
  if (!isBoardPage || isAllPage) return;
  const nextRoute = parseBoardRoute(window.location.pathname);
  if (nextRoute?.slug === route?.slug && nextRoute?.messageId === route?.messageId) return;
  route = nextRoute;
  disposeReplies?.();
  disposeReplies = null;
  list.replaceChildren();
  document.querySelector("#message-replies-section").hidden = true;
  loadMessages();
}

for (const event of ["boardroutechange", "popstate"]) window.addEventListener(event, syncBoardRoute);
retry.addEventListener("click", loadMessages);
for (const event of ["pageshow", "focus", "storage"]) window.addEventListener(event, syncDeleteAction);
if (route) heading.textContent = `y/${route.slug}`;
if (isAllPage) {
  heading.textContent = "All messages";
  document.title = `All messages${page > 1 ? ` · Page ${page}` : ""} · Yapern`;
  document.querySelector('.detail-nav-link[href="/all"]').setAttribute("aria-current", "page");
}
mountBoardSidebars(route?.slug, isBoardPage ? 20 : 3);
loadMessages();
