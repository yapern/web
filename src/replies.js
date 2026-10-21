import { createReply, fetchReplies, fetchMessageAuthors } from "./messages-api.js";
import { readStoredSession } from "./auth.js";

let mounted = false;

export function mountReplies(messageId, renderReply, onReplyCreated) {
  const section = document.querySelector("#message-replies-section");
  if (!section || mounted) return;
  mounted = true;
  section.hidden = false;

  const form = document.querySelector("#reply-form");
  const editor = document.querySelector("#reply-editor");
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
  let saving = false;
  let loading = false;
  let replies = [];
  let authors = new Map();

  function syncForm() {
    const signedIn = Boolean(readStoredSession());
    submit.disabled = saving || !signedIn || !body.value.trim() || body.value.length > 2000;
    cancel.disabled = saving;
    body.readOnly = saving;
    auth.hidden = signedIn || controls.hidden;
    submit.textContent = saving ? "Yapping…" : "Yap";
    form.setAttribute("aria-busy", String(saving));
  }

  function setExpanded(expanded) {
    editor.classList.toggle("is-expanded", expanded);
    controls.hidden = !expanded;
    if (!expanded) body.style.removeProperty("height");
    syncForm();
  }

  function renderReplies() {
    list.replaceChildren(...replies.map(reply => renderReply(reply, authors)));
  }

  async function loadReplies() {
    if (loading) return;
    loading = true;
    list.setAttribute("aria-busy", "true");
    retry.hidden = true;
    status.textContent = "Loading replies…";
    try {
      const loaded = await fetchReplies(messageId);
      const loadedAuthors = await fetchMessageAuthors(loaded).catch(() => new Map());
      // A reply saved while this request was in flight must stay visible.
      const byId = new Map(loaded.map(reply => [reply.id, reply]));
      for (const reply of replies) byId.set(reply.id, reply);
      replies = [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      authors = new Map([...loadedAuthors, ...authors]);
      renderReplies();
      status.textContent = replies.length ? "" : "No replies yet.";
    } catch {
      status.textContent = "Replies are unavailable right now. Please try again.";
      retry.hidden = false;
    } finally {
      loading = false;
      list.setAttribute("aria-busy", "false");
    }
  }

  body.addEventListener("focus", () => setExpanded(true));
  body.addEventListener("input", () => {
    error.textContent = "";
    feedback.textContent = "";
    syncForm();
  });
  cancel.addEventListener("click", () => {
    if (saving) return;
    form.reset();
    error.textContent = "";
    feedback.textContent = "";
    // Keep keyboard focus on the field without reopening it until the next visit.
    body.focus();
    setExpanded(false);
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    syncForm();
    if (submit.disabled) return;
    saving = true;
    error.textContent = "";
    feedback.textContent = "";
    syncForm();
    try {
      const reply = await createReply(messageId, body.value);
      replies.push(reply);
      onReplyCreated?.();
      const replyAuthors = await fetchMessageAuthors([reply]).catch(() => new Map());
      for (const [id, name] of replyAuthors) authors.set(id, name);
      renderReplies();
      if (!loading && retry.hidden) status.textContent = "";
      form.reset();
      body.focus();
      setExpanded(false);
      feedback.textContent = "Reply posted.";
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Could not save your reply. Please try again.";
    } finally {
      saving = false;
      syncForm();
    }
  });
  retry.addEventListener("click", loadReplies);
  for (const event of ["pageshow", "focus", "storage"]) window.addEventListener(event, syncForm);
  syncForm();
  void loadReplies();
}
