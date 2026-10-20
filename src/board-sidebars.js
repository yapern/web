import { fetchBoards, fetchMessages } from "./messages-api.js";
import { boardHref, messageHref } from "./board-routes.js";

export function mountBoardSidebars(activeSlug, recentLimit = 20) {
  const navigation = document.querySelector("#board-navigation");
  const boardStatus = document.querySelector("#boards-status");
  const boardRetry = document.querySelector("#boards-retry");
  const recentList = document.querySelector("#recent-posts");
  const recentStatus = document.querySelector("#recent-status");
  const recentRetry = document.querySelector("#recent-retry");
  const boardInfo = document.querySelector(".detail-board-info");
  const boardInfoTitle = document.querySelector("#board-info-title");
  const boardInfoDescription = document.querySelector("#board-info-description");
  const boardInfoStatus = document.querySelector("#board-info-status");
  const boardInfoRetry = document.querySelector("#board-info-retry");
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  let boards = [];
  let recentMessages = [];
  let recentLoaded = false;
  let boardsSettled = false;

  const menu = document.querySelector(".detail-board-menu");
  const showingBoardInfo = Boolean(activeSlug && boardInfo);
  if (boardInfo) boardInfo.hidden = !showingBoardInfo;
  if (recentList?.closest(".detail-recent-posts")) {
    recentList.closest(".detail-recent-posts").hidden = showingBoardInfo;
  }
  const narrowScreen = window.matchMedia("(max-width: 700px)");
  menu.open = !narrowScreen.matches;
  narrowScreen.addEventListener("change", event => { menu.open = !event.matches; });

  function renderBoards() {
    navigation.replaceChildren(...boards.map(board => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "detail-nav-link detail-board-link";
      link.href = boardHref(board.slug);
      link.title = `y/${board.slug}`;
      if (board.slug === activeSlug) link.setAttribute("aria-current", "page");
      const icon = document.createElement("span");
      icon.className = "detail-board-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = board.slug.charAt(0).toUpperCase();
      const label = document.createElement("span");
      label.className = "detail-board-label";
      label.textContent = `y/${board.slug}`;
      link.append(icon, label);
      item.append(link);
      return item;
    }));
    boardStatus.textContent = boards.length ? "" : "No sub-yaps yet.";
  }

  function renderBoardInfo() {
    const board = boards.find(candidate => candidate.slug === activeSlug);
    if (board) {
      boardInfoTitle.textContent = board.name;
      boardInfoDescription.textContent = board.description ?? "";
      boardInfoStatus.textContent = "";
      boardInfoRetry.hidden = true;
    } else {
      boardInfoTitle.textContent = "";
      boardInfoDescription.textContent = "";
      boardInfoStatus.textContent = boardsSettled ? "Sub-yap unavailable." : "Loading sub-yap…";
      boardInfoRetry.hidden = !boardsSettled || boards.length > 0;
    }
  }

  function renderRecent() {
    const byId = new Map(boards.map(board => [board.id, board]));
    recentList.replaceChildren(...recentMessages.slice(0, 5).map(message => {
      const board = byId.get(message.board_id);
      const item = document.createElement("li");
      const meta = document.createElement("div");
      meta.className = "detail-recent-meta";
      const boardLabel = document.createElement(board ? "a" : "span");
      boardLabel.textContent = board ? `y/${board.slug}` : boardsSettled ? "Sub-yap unavailable" : "Loading sub-yap…";
      if (board) boardLabel.href = boardHref(board.slug);
      const time = document.createElement("time");
      time.dateTime = message.created_at;
      time.textContent = dateFormat.format(new Date(message.created_at));
      meta.append(boardLabel, time);
      const post = document.createElement(board ? "a" : "div");
      post.className = "detail-recent-post";
      if (board) post.href = messageHref(board.slug, message.id);
      const title = document.createElement("span");
      title.className = "detail-recent-title";
      title.textContent = message.title;
      const preview = document.createElement("span");
      preview.className = "detail-recent-preview";
      preview.textContent = message.body;
      post.append(title, preview);
      item.append(meta, post);
      return item;
    }));
    recentStatus.textContent = recentMessages.length ? "" : "No messages yet.";
  }

  async function loadBoards() {
    navigation.setAttribute("aria-busy", "true");
    boardRetry.hidden = true;
    boardStatus.textContent = "Loading sub-yaps…";
    if (showingBoardInfo) {
      boardInfoStatus.textContent = "Loading sub-yap…";
      boardInfoRetry.hidden = true;
    }
    try {
      boards = await fetchBoards();
      boardsSettled = true;
      renderBoards();
      if (showingBoardInfo) renderBoardInfo();
      if (recentLoaded) renderRecent();
    } catch {
      boardsSettled = true;
      boardStatus.textContent = "Sub-yaps are unavailable.";
      boardRetry.hidden = false;
      if (showingBoardInfo) {
        boardInfoStatus.textContent = "Sub-yap details are unavailable.";
        boardInfoRetry.hidden = false;
      }
      if (recentLoaded) renderRecent();
    } finally {
      navigation.setAttribute("aria-busy", "false");
    }
  }

  async function loadRecent() {
    recentList.setAttribute("aria-busy", "true");
    recentRetry.hidden = true;
    recentStatus.textContent = "Loading posts…";
    try {
      recentMessages = await fetchMessages(undefined, { limit: recentLimit });
      recentLoaded = true;
      renderRecent();
    } catch {
      recentStatus.textContent = "Recent posts are unavailable.";
      recentRetry.hidden = false;
    } finally {
      recentList.setAttribute("aria-busy", "false");
    }
  }

  boardRetry.addEventListener("click", loadBoards);
  boardInfoRetry?.addEventListener("click", loadBoards);
  recentRetry.addEventListener("click", loadRecent);
  loadBoards();
  if (!showingBoardInfo) loadRecent();
}
