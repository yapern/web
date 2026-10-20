import { readStoredSession } from "./auth.js";
import { updateBoardDescription } from "./messages-api.js";
import { boardHref, parseBoardRoute } from "./board-routes.js";

export function mountBoardEditor(getBoard, onSave) {
  const edit = document.querySelector("#board-edit");
  if (!edit) return () => {};
  const browseNavigation = document.querySelector("#board-browse-navigation");
  const editNavigation = document.querySelector("#edit-board-navigation");
  const basics = document.querySelector("#edit-board-basics");
  const messages = document.querySelector("#board-messages-view");
  const view = document.querySelector("#edit-board-view");
  const boardInfo = document.querySelector(".detail-board-info");
  const actions = document.querySelector("#edit-board-actions");
  const exit = document.querySelector("#edit-board-exit");
  const form = document.querySelector("#edit-board-form");
  const description = document.querySelector("#edit-board-description");
  const error = document.querySelector("#edit-board-error");
  const feedback = document.querySelector("#edit-board-feedback");
  const submit = form.querySelector("[type=submit]");
  let saving = false;
  let editing = false;
  let editingUserId;

  function canEdit() {
    const user = readStoredSession()?.user;
    return Boolean(user && getBoard()?.user_id === user.id);
  }

  function updateSubmit() {
    submit.disabled = saving || !canEdit() || description.value.length > 2000 ||
      description.value.trim() === getBoard()?.description;
  }

  function syncSession() {
    const board = getBoard();
    const userId = readStoredSession()?.user.id;
    const url = new URL(window.location.href);
    const route = parseBoardRoute(url.pathname);
    edit.hidden = !canEdit();
    if (board) edit.href = `${boardHref(board.slug)}?edit=true`;
    const showEditor = !edit.hidden && route?.slug === board.slug &&
      route.messageId === undefined && url.searchParams.get("edit") === "true";
    if (showEditor && (!editing || editingUserId !== userId)) {
      description.value = board.description;
      error.textContent = "";
      feedback.textContent = "";
    }
    editing = showEditor;
    editingUserId = editing ? userId : undefined;
    browseNavigation.hidden = editing;
    editNavigation.hidden = !editing;
    messages.hidden = editing;
    view.hidden = !editing;
    actions.hidden = !editing;
    if (board) boardInfo.hidden = editing;
    basics.href = url.pathname + url.search + url.hash;
    url.searchParams.delete("edit");
    exit.href = url.pathname + url.search + url.hash;
    document.body.classList.toggle("is-editing-board", editing);
    updateSubmit();
  }

  description.addEventListener("input", () => {
    error.textContent = "";
    feedback.textContent = "";
    updateSubmit();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    syncSession();
    if (!editing || submit.disabled || !form.reportValidity()) return;
    saving = true;
    error.textContent = "";
    feedback.textContent = "";
    form.setAttribute("aria-busy", "true");
    form.querySelectorAll("button, textarea").forEach(control => { control.disabled = true; });
    submit.textContent = "Saving…";
    try {
      const updated = await updateBoardDescription(getBoard(), description.value);
      onSave(updated);
      description.value = updated.description;
      feedback.textContent = "Description updated.";
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Could not save your description. Please try again.";
    } finally {
      saving = false;
      form.setAttribute("aria-busy", "false");
      form.querySelectorAll("button, textarea").forEach(control => { control.disabled = false; });
      submit.textContent = "Save changes";
      syncSession();
    }
  });
  for (const event of ["pageshow", "focus", "storage"]) window.addEventListener(event, syncSession);
  syncSession();
  return syncSession;
}
