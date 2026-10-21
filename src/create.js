import { readStoredSession } from "./auth.js";
import { closeHeaderMenu } from "./auth-nav.js";
import { fetchBoards, createBoard, createMessage, fetchOgImage, messageImageError, messageBodyLength } from "./messages-api.js";
import { boardHref, messageHref, parseBoardRoute } from "./board-routes.js";
import { serializeMessageBody } from "./message-text.js";
import { cancelVideoUpload, completeVideoUpload, createVideoUpload, messageVideoError, uploadVideoFile, maxVideoSeconds } from "./videos-api.js";

const menu = document.querySelector("#create-menu");
const toggle = document.querySelector("#create-toggle");
const options = document.querySelector("#create-options");
const mobileNavigation = window.matchMedia("(max-width: 900px)");
const items = [...options.querySelectorAll("[role=menuitem]")];
const createActions = [...document.querySelectorAll("[data-create]")];
const messageDialog = document.querySelector("#create-message-dialog");
const boardDialog = document.querySelector("#create-board-dialog");
const messageForm = document.querySelector("#create-message-form");
const boardForm = document.querySelector("#create-board-form");
const boardSelect = document.querySelector("#create-board");
const boardsStatus = document.querySelector("#create-boards-status");
const boardsRetry = document.querySelector("#create-boards-retry");
const title = document.querySelector("#create-title");
const body = document.querySelector("#create-body");
const linkToggle = document.querySelector("#create-link-toggle");
const linkPanel = document.querySelector("#create-link-panel");
const linkUrl = document.querySelector("#create-link-url");
const linkRemove = document.querySelector("#create-link-remove");
const linkError = document.querySelector("#create-link-error");
const linkPreviewLoading = document.querySelector("#create-link-loading");
const linkPreview = document.querySelector("#create-link-preview");
const bodyRequirement = document.querySelector("#create-body-requirement");
const imageInput = document.querySelector("#create-image");
const imageChoose = document.querySelector("#create-image-choose");
const imageDraft = document.querySelector("#create-image-draft");
const imagePreview = document.querySelector("#create-image-preview");
const imageStatus = document.querySelector("#create-image-status");
const imageError = document.querySelector("#create-image-error");
const imageReplace = document.querySelector("#create-image-replace");
const imageRemove = document.querySelector("#create-image-remove");
const videoInput = document.querySelector("#create-video");
const videoChoose = document.querySelector("#create-video-choose");
const videoDraft = document.querySelector("#create-video-draft");
const videoPreview = document.querySelector("#create-video-preview");
const videoStatus = document.querySelector("#create-video-status");
const videoError = document.querySelector("#create-video-error");
const videoRemove = document.querySelector("#create-video-remove");
const videoProgress = document.querySelector("#create-video-progress");
const name = document.querySelector("#new-board-name");
const description = document.querySelector("#new-board-description");
let boards = [];
let boardRequest = 0;
let boardsLoading = false;
let boardsFailed = false;
let saving = false;
let previousOverflow = "";
let linkTouched = false;
let linkPreviewTimer;
let linkPreviewController;
let linkPreviewLookupPending = false;
let linkPreviewPromise = null;
let linkPreviewUrl = "";
let fetchedImageUrl = "";
let pickedImage = null;
let imagePreviewUrl = null;
let pickedVideo = null;
let videoPreviewUrl = null;
let videoUpload = null;

function clearVideoDraft() {
  if (videoUpload) void cancelVideoUpload(videoUpload.id).catch(() => {});
  videoUpload = null;
  pickedVideo = null;
  if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
  videoPreviewUrl = null;
  videoInput.value = "";
  videoPreview.pause();
  videoPreview.removeAttribute("src");
  videoPreview.load();
  videoDraft.hidden = true;
  videoProgress.hidden = true;
  videoStatus.textContent = "";
  videoError.textContent = "";
  videoChoose.setAttribute("aria-label", "Add video");
  videoChoose.title = "Add video";
}

function clearImageDraft() {
  if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  imagePreviewUrl = null;
  pickedImage = null;
  imageInput.value = "";
  imagePreview.removeAttribute("src");
  imageDraft.hidden = true;
  imageStatus.textContent = "";
  imageError.textContent = "";
  imageChoose.setAttribute("aria-label", "Add image");
  imageChoose.title = "Add image";
}

function logLinkPreview(level, event, details = {}) {
  console[level]("[link-preview]", event, details);
}

function linkPreviewErrorKind(error) {
  if (typeof error?.previewReason === "string") return error.previewReason;
  if (error?.name === "TimeoutError") return "timeout";
  if (error?.name === "TypeError") return "network-or-cors";
  return "request-error";
}

function safeLogUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function safeExceptionMessage(error) {
  if (typeof error?.message !== "string") return undefined;
  const token = readStoredSession()?.token;
  let message = error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  if (token) message = message.split(token).join("[redacted]");
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => safeLogUrl(value) ?? "[redacted URL]")
    .slice(0, 240);
}

function linkUrlError() {
  const value = linkUrl.value.trim();
  if (!/^https?:\/\//i.test(value)) return "Enter a full URL starting with http:// or https://.";
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) return "";
  } catch {}
  return "Enter a full URL starting with http:// or https://.";
}

function clearLinkPreview() {
  const cancelled = Boolean(linkPreviewTimer || linkPreviewLookupPending || !linkPreviewLoading.hidden);
  clearTimeout(linkPreviewTimer);
  linkPreviewTimer = undefined;
  linkPreviewController?.abort();
  linkPreviewController = null;
  linkPreviewLookupPending = false;
  linkPreviewPromise = null;
  if (cancelled) logLinkPreview("info", "lookup cancelled", { reason: "link-changed-or-dialog-closed" });
  linkPreviewUrl = "";
  fetchedImageUrl = "";
  linkPreviewLoading.hidden = true;
  linkPreview.setAttribute("aria-busy", "false");
  linkPreview.hidden = true;
  linkPreview.replaceChildren();
}

function scheduleLinkPreview() {
  const value = linkUrl.value.trim();
  if (!messageDialog.open || linkPanel.hidden || pickedImage || pickedVideo) {
    clearLinkPreview();
    return;
  }
  if (!value) {
    clearLinkPreview();
    logLinkPreview("info", "lookup skipped", { reason: "empty-url" });
    return;
  }
  if (linkUrlError()) {
    clearLinkPreview();
    logLinkPreview("warn", "lookup skipped", { reason: "invalid-url" });
    return;
  }
  if (value === linkPreviewUrl) return;
  clearLinkPreview();
  linkPreviewUrl = value;
  const controller = new AbortController();
  linkPreviewController = controller;
  logLinkPreview("info", "lookup scheduled", { debounceMs: 400 });
  linkPreviewLoading.hidden = false;
  linkPreview.setAttribute("aria-busy", "true");
  linkPreviewTimer = setTimeout(startLinkPreview, 400);
}

function startLinkPreview() {
  clearTimeout(linkPreviewTimer);
  linkPreviewTimer = undefined;
  if (linkPreviewPromise) return linkPreviewPromise;
  const controller = linkPreviewController;
  const value = linkPreviewUrl;
  if (!controller || controller.signal.aborted) return;
  linkPreviewLookupPending = true;
  linkPreviewPromise = (async () => {
    const startedAt = performance.now();
    try {
      const imageUrl = await fetchOgImage(value, fetch, { signal: controller.signal });
      if (controller.signal.aborted || linkPreviewController !== controller) return;
      if (!imageUrl) {
        logLinkPreview("info", "lookup completed without image", {
          target: safeLogUrl(value), elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
        linkPreviewLoading.hidden = true;
        linkPreview.setAttribute("aria-busy", "false");
        return;
      }
      fetchedImageUrl = imageUrl;
      updateForms();
      const image = document.createElement("img");
      image.alt = "Link preview";
      image.referrerPolicy = "no-referrer";
      image.decoding = "async";
      image.addEventListener("load", () => {
        if (!controller.signal.aborted && linkPreviewController === controller) {
          logLinkPreview("info", "image loaded", { target: safeLogUrl(value), imageUrl: safeLogUrl(imageUrl) });
          linkPreviewLoading.hidden = true;
          linkPreview.setAttribute("aria-busy", "false");
          linkPreview.hidden = false;
        }
      }, { once: true });
      image.addEventListener("error", () => {
        if (!controller.signal.aborted && linkPreviewController === controller) {
          logLinkPreview("warn", "image failed to load", {
            reason: "image-load-failed", target: safeLogUrl(value), imageUrl: safeLogUrl(imageUrl),
          });
          linkPreviewLoading.hidden = true;
          linkPreview.setAttribute("aria-busy", "false");
          linkPreview.replaceChildren();
        }
      }, { once: true });
      linkPreview.replaceChildren(image);
      image.src = imageUrl;
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        logLinkPreview("info", "lookup cancelled", { reason: "request-aborted" });
      } else if (linkPreviewController === controller) {
        logLinkPreview("warn", "lookup exception", {
          reason: linkPreviewErrorKind(error), target: safeLogUrl(value),
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
          exceptionName: error?.name || "Error",
          ...(safeExceptionMessage(error) ? { exceptionMessage: safeExceptionMessage(error) } : {}),
        });
      }
      if (linkPreviewController === controller) {
        linkPreviewLoading.hidden = true;
        linkPreview.setAttribute("aria-busy", "false");
      }
    } finally {
      if (linkPreviewController === controller) linkPreviewLookupPending = false;
    }
  })();
  return linkPreviewPromise;
}

function serializedMessageBody() {
  return serializeMessageBody(body.value, linkPanel.hidden ? "" : linkUrl.value, pickedImage || pickedVideo ? "" : fetchedImageUrl);
}

function syncLinkValidation() {
  const error = linkPanel.hidden ? "" : linkUrlError();
  linkUrl.setCustomValidity(error);
  linkUrl.setAttribute("aria-invalid", linkTouched && error ? "true" : "false");
  linkError.textContent = linkTouched ? error : "";
  return error;
}

function setLinkPanelOpen(open) {
  linkPanel.hidden = !open;
  linkToggle.setAttribute("aria-expanded", String(open));
  linkUrl.required = open;
  if (!open) {
    clearLinkPreview();
    linkUrl.value = "";
    linkTouched = false;
    syncLinkValidation();
    updateForms();
    body.focus();
    return;
  }
  syncLinkValidation();
  updateForms();
  linkUrl.focus();
}

function closeMenu(restoreFocus = false) {
  options.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  if (restoreFocus) toggle.focus();
}

function syncSession() {
  menu.hidden = !readStoredSession();
  if (menu.hidden) closeMenu();
}

function openMenu(index = 0) {
  syncSession();
  if (menu.hidden) return;
  options.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  items[index].focus();
}

toggle.addEventListener("click", () => options.hidden ? openMenu() : closeMenu(true));
toggle.addEventListener("keydown", event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    openMenu(event.key === "ArrowUp" ? items.length - 1 : 0);
  }
});
options.addEventListener("keydown", event => {
  const index = items.indexOf(document.activeElement);
  const next = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[event.key];
  if (next !== undefined) {
    event.preventDefault();
    items[next].focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
  }
});
document.addEventListener("pointerdown", event => { if (!menu.contains(event.target)) closeMenu(); });
menu.addEventListener("focusout", event => { if (!menu.contains(event.relatedTarget)) closeMenu(); });
mobileNavigation.addEventListener("change", () => closeMenu());
window.addEventListener("pageshow", syncSession);
window.addEventListener("focus", syncSession);
syncSession();

function updateForms() {
  const selected = boards.find(board => board.id === boardSelect.value);
  const serializedBody = serializedMessageBody();
  const bodyLength = videoUpload?.video?.watch_url
    ? videoUpload.video.watch_url.length + (serializedBody ? serializedBody.length + 1 : 0)
    : messageBodyLength(serializedBody, pickedImage);
  const linkInvalid = !linkPanel.hidden && Boolean(syncLinkValidation());
  body.required = linkPanel.hidden && !pickedImage && !pickedVideo;
  bodyRequirement.textContent = body.required ? "(required)" : "(optional)";
  boardSelect.disabled = saving || boardsLoading || boardsFailed || !boards.length;
  linkUrl.disabled = saving || linkPanel.hidden;
  messageForm.querySelector("[type=submit]").disabled = saving || boardsLoading || boardsFailed || !selected ||
    !title.value.trim() || title.value.length > 200 || (!linkPanel.hidden && linkInvalid) ||
    (body.required && !body.value.trim()) || bodyLength > 2000;
  boardForm.querySelector("[type=submit]").disabled = saving || !name.value.trim() || name.value.length > 80 || description.value.length > 2000;
  const bodyCount = document.querySelector("#create-body-count");
  const tooLong = bodyLength > 2000;
  bodyCount.textContent = `${bodyLength}/2000${tooLong ? " · Shorten the message or link" : ""}`;
  bodyCount.classList.toggle("is-over-limit", tooLong);
  body.setAttribute("aria-invalid", String(tooLong));
  document.querySelector("#create-selected-board").hidden = !selected || boardsLoading || boardsFailed;
  document.querySelector("#create-selected-name").textContent = selected?.name ?? "";
  document.querySelector("#create-selected-description").textContent = selected?.description ?? "";
}
messageForm.addEventListener("input", updateForms);
for (const button of [imageChoose, imageReplace]) {
  button.addEventListener("click", () => { if (!saving) imageInput.click(); });
}
imageInput.addEventListener("change", () => {
  if (saving) return;
  const file = imageInput.files?.[0];
  if (!file) return;
  const error = messageImageError(file);
  if (error) {
    imageInput.value = "";
    imageError.textContent = error;
    return;
  }
  clearImageDraft();
  clearVideoDraft();
  pickedImage = file;
  imagePreviewUrl = URL.createObjectURL(file);
  imagePreview.src = imagePreviewUrl;
  imageDraft.hidden = false;
  imageStatus.textContent = file.name;
  imageChoose.setAttribute("aria-label", "Replace image");
  imageChoose.title = "Replace image";
  clearLinkPreview();
  updateForms();
});
imageRemove.addEventListener("click", () => {
  if (saving) return;
  clearImageDraft();
  scheduleLinkPreview();
  updateForms();
  imageChoose.focus();
});
videoChoose.addEventListener("click", () => { if (!saving) videoInput.click(); });
videoInput.addEventListener("change", () => {
  if (saving) return;
  const file = videoInput.files?.[0];
  if (!file) return;
  const error = messageVideoError(file);
  if (error) {
    videoInput.value = "";
    videoError.textContent = error;
    return;
  }
  clearImageDraft();
  clearVideoDraft();
  pickedVideo = file;
  videoPreviewUrl = URL.createObjectURL(file);
  videoPreview.src = videoPreviewUrl;
  videoDraft.hidden = false;
  videoStatus.textContent = `${file.name} · Up to two minutes, 100 MB`;
  videoChoose.setAttribute("aria-label", "Replace video");
  videoChoose.title = "Replace video";
  clearLinkPreview();
  updateForms();
});
videoPreview.addEventListener("loadedmetadata", () => {
  if (pickedVideo && Number.isFinite(videoPreview.duration) && videoPreview.duration > maxVideoSeconds) {
    clearVideoDraft();
    videoError.textContent = "Choose a video no longer than two minutes.";
    updateForms();
  }
});
videoRemove.addEventListener("click", () => {
  if (saving) return;
  clearVideoDraft();
  scheduleLinkPreview();
  updateForms();
  videoChoose.focus();
});
linkToggle.addEventListener("click", () => setLinkPanelOpen(true));
linkRemove.addEventListener("click", () => setLinkPanelOpen(false));
linkUrl.addEventListener("input", scheduleLinkPreview);
linkUrl.addEventListener("blur", () => {
  linkTouched = true;
  syncLinkValidation();
  updateForms();
});
messageForm.addEventListener("reset", () => {
  clearLinkPreview();
  clearImageDraft();
  clearVideoDraft();
  linkPanel.hidden = true;
  linkToggle.setAttribute("aria-expanded", "false");
  linkUrl.required = false;
  body.required = true;
  bodyRequirement.textContent = "(required)";
  linkTouched = false;
  linkError.textContent = "";
  linkUrl.setCustomValidity("");
  linkUrl.setAttribute("aria-invalid", "false");
});
boardForm.addEventListener("input", updateForms);
boardSelect.addEventListener("change", updateForms);

async function loadBoards() {
  const request = ++boardRequest;
  boardsLoading = true;
  boardsFailed = false;
  boardsStatus.textContent = "Loading sub-yaps…";
  boardsRetry.hidden = true;
  updateForms();
  try {
    const result = await fetchBoards();
    if (request !== boardRequest) return;
    const previous = boardSelect.value;
    boards = result;
    boardSelect.replaceChildren(...(boards.length
      ? boards.map(board => new Option(`y/${board.slug}`, board.id))
      : [new Option("No sub-yaps available", "")]));
    const routeBoard = boards.find(board => board.slug === parseBoardRoute(window.location.pathname)?.slug);
    if (routeBoard) boardSelect.value = routeBoard.id;
    else if (boards.some(board => board.id === previous)) boardSelect.value = previous;
    boardsStatus.textContent = boards.length ? "" : "There are no sub-yaps to post to yet. Create a sub-yap from the Create menu.";
  } catch {
    if (request !== boardRequest) return;
    boardsFailed = true;
    boardsStatus.textContent = "Sub-yaps are unavailable right now. Please try again.";
    boardSelect.replaceChildren(new Option("Sub-yaps unavailable", ""));
    boardsRetry.hidden = false;
  } finally {
    if (request === boardRequest) {
      boardsLoading = false;
      updateForms();
    }
  }
}
boardsRetry.addEventListener("click", loadBoards);

createActions.forEach(item => item.addEventListener("click", () => {
  closeMenu(false);
  closeHeaderMenu();
  syncSession();
  if (menu.hidden) return;
  const dialog = item.dataset.create === "message" ? messageDialog : boardDialog;
  previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
  dialog.showModal();
  if (dialog === messageDialog) {
    void loadBoards();
    scheduleLinkPreview();
  }
  updateForms();
}));

for (const dialog of [messageDialog, boardDialog]) {
  dialog.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => {
    if (!saving) dialog.close();
  }));
  dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (dialog === messageDialog) {
      boardRequest++;
      clearLinkPreview();
    }
    document.documentElement.style.overflow = previousOverflow;
    syncSession();
    const mobileToggle = document.querySelector("#header-toggle");
    const focusTarget = window.matchMedia("(max-width: 900px)").matches
      ? mobileToggle
      : (menu.hidden ? document.querySelector("[data-login-link]") : toggle);
    focusTarget?.focus();
  });
}

async function submit(event, dialog, action, pendingLabel, defaultLabel) {
  event.preventDefault();
  if (saving || event.currentTarget.querySelector("[type=submit]").disabled) return;
  const form = event.currentTarget;
  const error = form.querySelector(".create-error");
  const submitButton = form.querySelector("[type=submit]");
  saving = true;
  error.textContent = "";
  form.setAttribute("aria-busy", "true");
  dialog.querySelectorAll("button, input, select, textarea").forEach(control => { control.disabled = true; });
  submitButton.textContent = pendingLabel;
  try {
    const href = await action();
    form.reset();
    dialog.close();
    window.location.assign(href);
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Could not create this right now. Please try again.";
  } finally {
    saving = false;
    form.setAttribute("aria-busy", "false");
    dialog.querySelectorAll("button, input, select, textarea").forEach(control => { control.disabled = false; });
    submitButton.textContent = defaultLabel;
    updateForms();
  }
}

messageForm.addEventListener("submit", event => void submit(event, messageDialog, async () => {
  const board = boards.find(row => row.id === boardSelect.value);
  // Finish the current lookup, including a queued debounce, before saving.
  if (!linkPanel.hidden && !pickedImage && !pickedVideo) await startLinkPreview();
  let video;
  if (pickedVideo) {
    const owner = readStoredSession()?.user.id;
    if (!videoUpload || videoUpload.boardId !== board.id || videoUpload.owner !== owner) {
      if (videoUpload) void cancelVideoUpload(videoUpload.id).catch(() => {});
      videoUpload = null;
      videoStatus.textContent = "Preparing video upload…";
      videoUpload = { ...await createVideoUpload(board.id, pickedVideo), boardId: board.id, owner, complete: false };
    }
    if (!videoUpload.complete) {
      videoProgress.hidden = false;
      await uploadVideoFile(pickedVideo, videoUpload, { onProgress: percent => {
        videoProgress.value = percent;
        videoStatus.textContent = `Uploading video… ${percent}%`;
      } });
      videoUpload.complete = true;
    }
    videoProgress.hidden = true;
    videoStatus.textContent = "Processing video…";
    for (let attempt = 0; attempt < 7; attempt++) {
      video = await completeVideoUpload(videoUpload.id);
      videoUpload.video = video;
      if (video.status === "failed") throw new Error("This video could not be processed. Remove it and choose another video.");
      if (["ready", "processing"].includes(video.status) && video.watch_url) break;
      if (attempt === 6) throw new Error("Your video is still processing. Try posting again in a moment.");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  const message = await createMessage(board.id, title.value, serializedMessageBody(), fetch, { image: pickedImage, video });
  // A successful post owns the asset; resetting the draft must not cancel it.
  videoUpload = null;
  return messageHref(board.slug, message.id);
}, "Posting…", "Post"));
boardForm.addEventListener("submit", event => void submit(event, boardDialog, async () => {
  const board = await createBoard(name.value, description.value);
  return boardHref(board.slug);
}, "Creating…", "Create sub-yap"));
