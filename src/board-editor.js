import { readStoredSession } from "./auth.js";
import { updateBoardDescription } from "./messages-api.js";

export function mountBoardEditor(getBoard, onSave) {
  const edit = document.querySelector("#board-edit");
  if (!edit) return () => {};
  const dialog = document.querySelector("#edit-board-dialog");
  const form = document.querySelector("#edit-board-form");
  const description = document.querySelector("#edit-board-description");
  const error = document.querySelector("#edit-board-error");
  const submit = form.querySelector("[type=submit]");
  let saving = false;
  let previousOverflow = "";

  function canEdit() {
    const user = readStoredSession()?.user;
    return Boolean(user && getBoard()?.user_id === user.id);
  }

  function updateSubmit() {
    submit.disabled = saving || !canEdit() || description.value.length > 2000 ||
      description.value.trim() === getBoard()?.description;
  }

  function syncSession() {
    edit.hidden = !canEdit();
    if (edit.hidden && dialog.open && !saving) dialog.close();
    updateSubmit();
  }

  edit.addEventListener("click", () => {
    syncSession();
    if (edit.hidden) return;
    description.value = getBoard().description;
    error.textContent = "";
    updateSubmit();
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
  });
  description.addEventListener("input", updateSubmit);
  dialog.querySelectorAll("[data-close-edit]").forEach(button => {
    button.addEventListener("click", () => { if (!saving) dialog.close(); });
  });
  dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    document.documentElement.style.overflow = previousOverflow;
    if (!edit.hidden) edit.focus();
    else document.querySelector("[data-login-link]")?.focus();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    updateSubmit();
    if (submit.disabled || !form.reportValidity()) return;
    saving = true;
    error.textContent = "";
    form.setAttribute("aria-busy", "true");
    dialog.querySelectorAll("button, textarea").forEach(control => { control.disabled = true; });
    submit.textContent = "Saving…";
    try {
      const updated = await updateBoardDescription(getBoard(), description.value);
      onSave(updated);
      dialog.close();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Could not save your description. Please try again.";
    } finally {
      saving = false;
      form.setAttribute("aria-busy", "false");
      dialog.querySelectorAll("button, textarea").forEach(control => { control.disabled = false; });
      submit.textContent = "Save changes";
      syncSession();
    }
  });
  for (const event of ["pageshow", "focus", "storage"]) window.addEventListener(event, syncSession);
  syncSession();
  return syncSession;
}
