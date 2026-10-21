import { createReply, fetchReplyPage, fetchReplyContext } from "./messages-api.js";
import { readStoredSession } from "./auth.js";
import { mergeReplyIds, replyAnchor } from "./reply-tree.js";
import { syncVoteControls } from "./votes.js";

const visibleLevels = 5;

export function mountReplies(messageId, renderReply, onReplyCreated) {
  const section = document.querySelector("#message-replies-section");
  if (!section) return;
  section.hidden = false;
  const events = new AbortController();
  const listen = (target, name, handler) => target.addEventListener(name, handler, { signal: events.signal });
  const form = document.querySelector("#reply-form");
  const home = document.createComment("reply composer");
  form.before(home);
  const editor = document.querySelector("#reply-editor");
  const label = document.querySelector("#reply-label");
  const body = document.querySelector("#reply-body");
  const controls = document.querySelector("#reply-controls");
  const cancel = document.querySelector("#reply-cancel");
  const submit = document.querySelector("#reply-submit");
  const auth = document.querySelector("#reply-auth");
  const error = document.querySelector("#reply-error");
  const feedback = document.querySelector("#reply-feedback");
  const list = document.querySelector("#message-replies");
  const status = document.querySelector("#replies-status");
  const retry = document.querySelector("#replies-retry");
  const back = document.querySelector("#replies-back");
  const sort = document.querySelector("#replies-sort");
  const refresh = document.querySelector("#replies-refresh");
  const replies = new Map();
  const authors = new Map();
  const branches = new Map();
  const collapsed = new Set();
  const rendered = new Map();
  const rows = new Map();
  let saving = false;
  let targetId = null;
  let focusedId = null;
  let focusPath = [];
  let fullDiscussionAnchor = null;
  let contextLoading = false;
  let contextError = "";
  let contextRequest = 0;
  let writeAttempt = null;
  let mutation = 0;
  const locallyUpdated = new Map();
  const unobservedWrites = new Set();
  const confirmedWrites = new Set();
  const replyTotal = count => `${count} ${count === 1 ? "reply" : "replies"}`;
  const authorName = reply => authors.get(reply.user_id) ?? "Name unavailable";

  function updateFocusedUrl(id) {
    const url = new URL(window.location.href);
    if (id !== null) url.hash = replyAnchor(id);
    else if (url.hash.startsWith("#reply-")) url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }

  function branchFor(parentId) {
    const key = JSON.stringify([sort.value, parentId]);
    if (!branches.has(key)) branches.set(key, {
      parentId, sort: sort.value, ids: [], nextCursor: null, loaded: false,
      expanded: parentId === null, loading: false, error: "", generation: 0,
    });
    return branches.get(key);
  }

  function remember(rows, startedAt = mutation) {
    for (const row of rows) {
      const existing = replies.get(row.id);
      const hasPendingChild = [...unobservedWrites].some(id => replies.get(id)?.parent_reply_id === row.id);
      const count = existing && ((locallyUpdated.get(row.id) ?? 0) > startedAt || hasPendingChild)
        ? Math.max(existing.direct_reply_count, row.direct_reply_count) : row.direct_reply_count;
      replies.set(row.id, { ...row, direct_reply_count: count });
      if (typeof row.author_name === "string" && row.author_name.trim()) authors.set(row.user_id, row.author_name.trim());
    }
  }

  function syncForm() {
    const signedIn = Boolean(readStoredSession());
    submit.disabled = saving || !signedIn || !body.value.trim() || body.value.length > 2000;
    cancel.disabled = saving;
    body.readOnly = saving;
    auth.hidden = signedIn || controls.hidden;
    submit.textContent = saving ? "Yapping…" : "Yap";
    form.setAttribute("aria-busy", String(saving));
    sort.disabled = saving;
    refresh.disabled = saving;
  }

  function setExpanded(expanded) {
    editor.classList.toggle("is-expanded", expanded);
    controls.hidden = !expanded;
    if (!expanded) body.style.removeProperty("height");
    syncForm();
  }

  function placeComposer() {
    const row = rendered.get(targetId);
    const inline = row && !collapsed.has(targetId);
    if (inline) row.article.after(form);
    else home.after(form);
    form.classList.toggle("reply-form-inline", Boolean(inline));
    label.textContent = targetId && replies.has(targetId)
      ? `Replying to ${authorName(replies.get(targetId))}` : "Reply to this message";
  }

  function openComposer(reply = null) {
    if (saving) return;
    targetId = reply?.id ?? null;
    if (targetId === null && focusedId !== null) {
      focusedId = null;
      focusPath = [];
      updateFocusedUrl(null);
      if (!branchFor(null).loaded) void loadBranch(null);
    }
    if (targetId) collapsed.delete(targetId);
    render();
    error.textContent = "";
    feedback.textContent = "";
    setExpanded(true);
    body.focus();
  }

  function focusRow(id) {
    const row = rendered.get(id) ?? (focusedId === null ? rendered.values().next().value : null);
    if (!row) return;
    row.toggle.focus({ preventScroll: true });
    row.item.scrollIntoView({ block: "start" });
  }

  async function loadBranch(parentId, { reset = false } = {}) {
    const branch = branchFor(parentId);
    if (branch.loading && !reset) return;
    if (!reset && branch.loaded && branch.nextCursor === null) return;
    const generation = ++branch.generation;
    const startedAt = mutation;
    const cursor = reset ? null : branch.nextCursor;
    branch.loading = true;
    branch.error = "";
    render();
    try {
      const page = await fetchReplyPage(messageId, {
        parentReplyId: parentId, cursor, sort: branch.sort, limit: parentId === null ? 20 : 3,
      });
      if (events.signal.aborted || generation !== branch.generation) return;
      remember(page.replies, startedAt);
      const previous = reset ? branch.ids.filter(id => unobservedWrites.has(id) || (locallyUpdated.get(id) ?? 0) > startedAt) : branch.ids;
      // Keep the server's sibling order. Vote changes take effect on explicit refresh.
      branch.ids = [...new Set([...previous, ...page.replies.map(reply => reply.id)])];
      for (const row of page.replies) unobservedWrites.delete(row.id);
      branch.nextCursor = page.nextCursor;
      branch.loaded = true;
    } catch (cause) {
      if (!events.signal.aborted && generation === branch.generation) {
        branch.error = cause instanceof Error ? cause.message : "Replies unavailable. Please try again.";
      }
    } finally {
      if (!events.signal.aborted && generation === branch.generation) {
        branch.loading = false;
        render();
      }
    }
  }

  async function focusThread(id) {
    if (saving) return;
    const request = ++contextRequest;
    if (!focusedId) fullDiscussionAnchor = id;
    focusedId = id;
    updateFocusedUrl(id);
    focusPath = [];
    collapsed.delete(id);
    contextError = "";
    if (!replies.has(id) || (replies.get(id).parent_reply_id && !replies.has(replies.get(id).parent_reply_id))) {
      contextLoading = true;
      render();
      try {
        const context = await fetchReplyContext(messageId, id, { limit: 3 });
        if (events.signal.aborted || request !== contextRequest) return;
        remember(context.replies);
      } catch (cause) {
        if (events.signal.aborted || request !== contextRequest) return;
        contextError = cause instanceof Error ? cause.message : "This reply is unavailable.";
      } finally {
        if (!events.signal.aborted && request === contextRequest) contextLoading = false;
      }
    }
    if (events.signal.aborted || request !== contextRequest) return;
    let ancestor = replies.get(id);
    while (ancestor && focusPath.length < 3) {
      focusPath.unshift(ancestor.id);
      collapsed.delete(ancestor.id);
      ancestor = replies.get(ancestor.parent_reply_id);
    }
    if (replies.has(id)) branchFor(id).expanded = true;
    render();
    focusRow(id);
    if (replies.has(id)) {
      const branch = branchFor(id);
      if (replies.get(id).direct_reply_count > 0 && !branch.loaded) void loadBranch(id);
    }
  }

  function appendBranchControls(destination, parentId) {
    const branch = branchFor(parentId);
    if (branch.loaded && !branch.nextCursor && !branch.error && !branch.loading) return;
    const item = document.createElement("li");
    item.className = "reply-branch-controls";
    if (branch.error) {
      const message = document.createElement("p");
      message.className = "reply-branch-error";
      message.setAttribute("role", "status");
      message.textContent = branch.error;
      item.append(message);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reply-load-more";
    button.disabled = branch.loading;
    button.textContent = branch.loading ? "Loading replies…" : branch.error ? "Retry replies"
      : branch.loaded ? "More replies" : "Show replies";
    button.addEventListener("click", () => void loadBranch(parentId));
    item.append(button);
    destination.append(item);
  }

  function renderNode(reply, destination, depth) {
    const contentKey = JSON.stringify([reply.body, reply.user_id, reply.created_at, authorName(reply)]);
    let cached = rows.get(reply.id);
    const existingVotes = cached?.article.querySelector(".live-message-vote-control");
    if (cached?.contentKey !== contentKey) cached = null;
    const item = cached?.item ?? renderReply(reply, authors, { onReply: openComposer });
    if (!cached && existingVotes) item.querySelector(".live-message-vote-control")?.replaceWith(existingVotes);
    item.id = replyAnchor(reply.id);
    item.classList.add("reply-thread");
    const article = item.querySelector("article");
    const meta = article.querySelector(".live-message-meta");
    const content = cached?.content ?? document.createElement("div");
    content.className = "reply-thread-content";
    content.id = `${item.id}-content`;
    if (!cached) {
      for (const child of [...article.children]) if (child !== meta) content.append(child);
      article.append(content);
    }
    let parentContext = cached?.parentContext;
    if (!cached && reply.parent_reply_id) {
      parentContext = document.createElement("span");
      const parent = document.createElement("button");
      parent.type = "button";
      parent.className = "reply-parent";
      parent.textContent = "View parent reply";
      parent.addEventListener("click", () => void focusThread(reply.parent_reply_id));
      parentContext.append(document.createTextNode(" · "), parent);
      meta.append(parentContext);
    }
    if (parentContext) parentContext.hidden = depth !== 0;
    const isCollapsed = collapsed.has(reply.id);
    const summary = cached?.summary ?? document.createElement("span");
    summary.className = "reply-collapsed-summary";
    summary.textContent = reply.direct_reply_count
      ? ` · ${reply.direct_reply_count} direct ${reply.direct_reply_count === 1 ? "reply" : "replies"}` : " · collapsed";
    summary.hidden = !isCollapsed;
    if (!cached) meta.append(summary);
    const children = cached?.children ?? document.createElement("ul");
    children.replaceChildren();
    children.className = "reply-children";
    children.id = `${item.id}-children`;
    children.setAttribute("aria-label", `Replies to ${authorName(reply)}`);
    const toggle = cached?.toggle ?? document.createElement("button");
    toggle.type = "button";
    toggle.className = "reply-thread-toggle";
    toggle.setAttribute("aria-controls", `${content.id} ${children.id}`);
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    toggle.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} reply by ${authorName(reply)}`);
    if (!cached) {
      const icon = document.createElement("span");
      icon.className = "reply-thread-toggle-icon";
      icon.setAttribute("aria-hidden", "true");
      toggle.append(icon);
      toggle.addEventListener("click", () => {
        if (collapsed.has(reply.id)) collapsed.delete(reply.id);
        else collapsed.add(reply.id);
        render();
        focusRow(reply.id);
      });
      item.prepend(toggle);
      item.append(children);
      const refreshBranch = document.createElement("button");
      refreshBranch.type = "button";
      refreshBranch.className = "live-message-action reply-refresh-branch";
      refreshBranch.setAttribute("aria-label", "Refresh replies");
      refreshBranch.title = "Refresh replies";
      const unusedRepost = article.querySelector('[aria-label="Reposting unavailable"]');
      if (unusedRepost) {
        refreshBranch.append(...unusedRepost.childNodes);
        unusedRepost.replaceWith(refreshBranch);
      }
      refreshBranch.addEventListener("click", () => {
        branchFor(reply.id).expanded = true;
        void loadBranch(reply.id, { reset: true });
      });
      rows.set(reply.id, { item, article, content, summary, children, toggle, parentContext, refreshBranch, contentKey });
    }
    const action = article.querySelector(".live-message-reply");
    action.querySelector(".live-message-reply-count").textContent = String(reply.direct_reply_count);
    action.setAttribute("aria-label", `Reply; ${replyTotal(reply.direct_reply_count)}`);
    content.hidden = isCollapsed;
    children.hidden = isCollapsed;
    item.classList.toggle("is-collapsed", isCollapsed);
    item.querySelector(":scope > .reply-thread-line")?.remove();
    rendered.set(reply.id, { item, article, toggle, depth });
    const branch = branchFor(reply.id);
    rows.get(reply.id).refreshBranch.disabled = branch.loading;
    const pathIndex = focusPath.indexOf(reply.id);
    const contextChild = pathIndex >= 0 ? focusPath[pathIndex + 1] : undefined;
    if (!isCollapsed && (reply.direct_reply_count > 0 || branch.ids.length)) {
      const line = document.createElement("button");
      line.type = "button";
      line.className = "reply-thread-line";
      line.tabIndex = -1;
      line.setAttribute("aria-hidden", "true");
      line.title = "Collapse thread";
      line.addEventListener("click", () => toggle.click());
      item.insertBefore(line, children);
      if (depth === visibleLevels - 1) {
        const continuation = document.createElement("li");
        continuation.className = "reply-continuation";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Continue this thread →";
        button.addEventListener("click", () => void focusThread(reply.id));
        continuation.append(button);
        children.append(continuation);
      } else if (branch.expanded || contextChild) {
        const visibleIds = contextChild ? [...new Set([contextChild, ...branch.ids])] : branch.ids;
        for (const id of visibleIds) if (replies.has(id)) renderNode(replies.get(id), children, depth + 1);
        if (branch.loaded || visibleIds.length < reply.direct_reply_count) appendBranchControls(children, reply.id);
      } else {
        const placeholder = document.createElement("li");
        placeholder.className = "reply-branch-controls";
        const button = document.createElement("button");
        button.className = "reply-load-more";
        button.type = "button";
        button.textContent = `Show ${replyTotal(reply.direct_reply_count)}`;
        button.addEventListener("click", () => {
          branch.expanded = true;
          if (!branch.loaded) void loadBranch(reply.id);
          else render();
        });
        placeholder.append(button);
        children.append(placeholder);
      }
    }
    destination.append(item);
  }

  function render() {
    const editing = document.activeElement === body;
    const selection = [body.selectionStart, body.selectionEnd];
    home.after(form);
    rendered.clear();
    list.replaceChildren();
    back.hidden = focusedId === null;
    const root = branchFor(null);
    if (focusedId !== null) {
      const reply = replies.get(focusPath[0] ?? focusedId);
      if (reply) renderNode(reply, list, 0);
    } else {
      for (const id of root.ids) if (replies.has(id)) renderNode(replies.get(id), list, 0);
      appendBranchControls(list, null);
    }
    status.textContent = contextLoading ? "Loading conversation…" : contextError ||
      (focusedId === null && root.loaded && !root.ids.length ? "No replies yet." : "");
    retry.hidden = !contextError;
    list.setAttribute("aria-busy", String(contextLoading || (focusedId === null && root.loading)));
    placeComposer();
    syncVoteControls(list);
    if (editing) {
      body.focus({ preventScroll: true });
      body.setSelectionRange(...selection);
    }
    syncForm();
  }

  function revealHash() {
    let anchor;
    try { anchor = decodeURIComponent(window.location.hash.slice(1)); }
    catch { return; }
    if (anchor.startsWith("reply-")) void focusThread(anchor.slice(6));
  }

  listen(body, "focus", () => setExpanded(true));
  listen(body, "input", () => {
    error.textContent = "";
    feedback.textContent = "";
    syncForm();
  });
  listen(cancel, "click", () => {
    if (saving) return;
    form.reset();
    targetId = null;
    writeAttempt = null;
    placeComposer();
    error.textContent = "";
    feedback.textContent = "";
    body.focus();
    setExpanded(false);
  });
  listen(form, "submit", async event => {
    event.preventDefault();
    syncForm();
    if (submit.disabled) return;
    const session = readStoredSession();
    const fingerprint = JSON.stringify([session.user.id, messageId, targetId, body.value.trim()]);
    if (writeAttempt?.fingerprint !== fingerprint) writeAttempt = {
      fingerprint, key: crypto.randomUUID(), parentCount: replies.get(targetId)?.direct_reply_count ?? 0,
    };
    saving = true;
    error.textContent = "";
    feedback.textContent = "";
    syncForm();
    try {
      const reply = await createReply(messageId, body.value, undefined, {
        parentReplyId: targetId, idempotencyKey: writeAttempt.key,
      });
      if (events.signal.aborted) return;
      mutation++;
      remember([reply]);
      unobservedWrites.add(reply.id);
      locallyUpdated.set(reply.id, mutation);
      if (!confirmedWrites.has(reply.id)) {
        if (targetId && replies.has(targetId)) {
          const parent = replies.get(targetId);
          // A branch read may have observed this write before its response.
          // Reuse the original baseline across retries instead of adding twice.
          parent.direct_reply_count = Math.max(parent.direct_reply_count, writeAttempt.parentCount + 1);
          locallyUpdated.set(targetId, mutation);
        }
        confirmedWrites.add(reply.id);
        onReplyCreated?.();
      }
      authors.set(session.user.id, session.user.name || session.user.display_name || "You");
      const branch = branchFor(targetId);
      branch.ids = mergeReplyIds(branch.ids, [reply.id], replies, branch.sort);
      branch.expanded = true;
      collapsed.delete(targetId);
      if (targetId === null) {
        focusedId = null;
        focusPath = [];
        updateFocusedUrl(null);
      } else if (rendered.get(targetId)?.depth === visibleLevels - 1) {
        if (focusedId === null) fullDiscussionAnchor = targetId;
        focusedId = targetId;
        focusPath = [targetId];
        updateFocusedUrl(targetId);
      }
      // The write is confirmed; subsequent reads cannot make it disappear.
      form.reset();
      writeAttempt = null;
      render();
      focusRow(reply.id);
      feedback.textContent = "Reply posted.";
      setExpanded(false);
    } catch (cause) {
      if (!events.signal.aborted) error.textContent = cause instanceof Error ? cause.message : "Could not save your reply. Please try again.";
    } finally {
      if (!events.signal.aborted) {
        saving = false;
        syncForm();
      }
    }
  });
  listen(back, "click", async () => {
    if (saving) return;
    contextRequest++;
    contextLoading = false;
    contextError = "";
    focusedId = null;
    focusPath = [];
    updateFocusedUrl(null);
    render();
    if (!branchFor(null).loaded) await loadBranch(null);
    if (!events.signal.aborted && focusedId === null) focusRow(fullDiscussionAnchor);
  });
  listen(sort, "change", () => {
    render();
    const parentId = focusedId;
    if (parentId !== null) branchFor(parentId).expanded = true;
    if (!branchFor(parentId).loaded) void loadBranch(parentId);
  });
  listen(refresh, "click", () => void loadBranch(focusedId, { reset: true }));
  const rootAction = document.querySelector("#live-messages .live-message-reply");
  if (rootAction) listen(rootAction, "click", event => {
    event.preventDefault();
    openComposer();
  });
  listen(retry, "click", () => focusedId !== null && void focusThread(focusedId));
  listen(window, "hashchange", revealHash);
  for (const event of ["pageshow", "focus", "storage"]) listen(window, event, syncForm);
  list.replaceChildren();
  form.reset();
  sort.value = "new";
  placeComposer();
  setExpanded(false);
  if (window.location.hash.startsWith("#reply-")) revealHash();
  else void loadBranch(null);
  return () => {
    events.abort();
    home.after(form);
    home.remove();
  };
}
