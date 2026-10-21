import { readStoredSession } from "./auth.js";
import { sendMarketingEmail } from "./marketing-email-api.js";

const layout = document.querySelector("#backroom-layout");
const access = document.querySelector("#backroom-access");
const status = document.querySelector("#backroom-status");
const login = document.querySelector("#backroom-login");
const content = document.querySelector("#backroom-content");
const links = [...document.querySelectorAll("#backroom-menu a")];
const emailView = document.querySelector("#backroom-email-view");
const emailForm = document.querySelector("#backroom-email-form");
const emailTo = document.querySelector("#backroom-email-to");
const emailFrom = document.querySelector("#backroom-email-from");
const emailSubject = document.querySelector("#backroom-email-subj");
const emailBody = document.querySelector("#backroom-email-body");
const emailSubmit = document.querySelector("#backroom-email-submit");
const emailStatus = document.querySelector("#backroom-email-status");
const emailError = document.querySelector("#backroom-email-error");
let accessTimer;
let sendingEmail = false;

function syncAccess() {
  window.clearTimeout(accessTimer);
  // The shell checks access locally; the email endpoint also authorizes the current admin session.
  const session = readStoredSession();
  const allowed = session?.user.email.trim().toLowerCase() === "oneone@gmail.com";
  layout.hidden = !allowed;
  access.hidden = allowed;
  login.hidden = Boolean(session);
  status.textContent = session ? "You don’t have access to the backroom." : "Log in to access the backroom.";
  if (allowed) {
    accessTimer = window.setTimeout(syncAccess,
      Math.min(Date.parse(session.session.expires_at) - Date.now(), 2_147_483_647));
  }
}

function syncMenu() {
  const active = links.find(link => link.hash === window.location.hash) || links[0];
  for (const link of links) {
    if (link === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  content.setAttribute("aria-label", active.textContent);
  emailView.hidden = active.hash !== "#email";
}

emailForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (sendingEmail || layout.hidden || emailView.hidden || !emailForm.reportValidity()) return;
  const input = { to: emailTo.value, from: emailFrom.value, subj: emailSubject.value, message: emailBody.value };
  sendingEmail = true;
  emailForm.setAttribute("aria-busy", "true");
  for (const control of emailForm.elements) control.disabled = true;
  emailSubmit.textContent = "Sending…";
  emailStatus.textContent = "Sending test email…";
  emailError.textContent = "";
  try {
    await sendMarketingEmail(input);
    emailStatus.textContent = `Email accepted for delivery to ${input.to.trim()}.`;
  } catch (cause) {
    emailStatus.textContent = "";
    emailError.textContent = cause.message;
  } finally {
    sendingEmail = false;
    emailForm.setAttribute("aria-busy", "false");
    for (const control of emailForm.elements) control.disabled = false;
    emailSubmit.textContent = "Send test email";
    syncAccess();
  }
});

window.addEventListener("pageshow", syncAccess);
window.addEventListener("focus", syncAccess);
window.addEventListener("storage", syncAccess);
window.addEventListener("hashchange", syncMenu);
syncAccess();
syncMenu();
