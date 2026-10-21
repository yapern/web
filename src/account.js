import { createAuthClient, readStoredSession } from "./auth.js";
import { emailPreferenceKeys, fetchProfile, updateName, fetchEmailPreferences, updateEmailPreferences } from "./account-api.js";

const auth = createAuthClient();
const page = document.querySelector(".account-content");
const status = document.querySelector(".login-status");
const error = document.querySelector(".login-error");
const identity = document.querySelector(".account-email");
const form = document.querySelector("#account-name-form");
const name = document.querySelector("#account-name");
const submit = form.querySelector("button");
const retry = document.querySelector("#account-retry");
const login = document.querySelector(".account-login");
const signOut = document.querySelector(".login-sign-out");
const emailForm = document.querySelector("#account-email-notifications");
const emailInputs = emailPreferenceKeys.map(key => emailForm.elements.namedItem(key));
const emailSubmit = emailForm.querySelector("button");
const emailStatus = document.querySelector("#account-email-status");
const emailError = document.querySelector("#account-email-error");
let pending = false;

function setPending(value) {
  pending = value;
  page.setAttribute("aria-busy", String(value));
  for (const control of [name, submit, retry, signOut, ...emailInputs, emailSubmit]) control.disabled = value;
}

function showSignedOut() {
  form.hidden = emailForm.hidden = identity.hidden = signOut.hidden = retry.hidden = true;
  login.hidden = false;
  status.textContent = "Log in to manage your account.";
}

function showError(cause, target = error) {
  target.textContent = cause.message;
  target.hidden = false;
  if (!readStoredSession()) showSignedOut();
}

async function loadAccount() {
  if (pending) return;
  error.hidden = emailError.hidden = retry.hidden = true;
  status.textContent = "Loading your account…";
  setPending(true);
  try {
    const session = await auth.readSession();
    if (!session) { showSignedOut(); return; }
    identity.textContent = session.user.email;
    identity.hidden = signOut.hidden = false;
    const [profile, preferences] = await Promise.all([fetchProfile(), fetchEmailPreferences()]);
    name.value = profile.name;
    for (const input of emailInputs) input.checked = preferences[input.name];
    form.hidden = emailForm.hidden = false;
    login.hidden = true;
    status.textContent = "";
  } catch (cause) {
    retry.hidden = false;
    status.textContent = "";
    showError(cause);
  } finally {
    setPending(false);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (pending || !form.reportValidity()) return;
  error.hidden = true;
  setPending(true);
  submit.textContent = "Saving…";
  status.textContent = "";
  try {
    const profile = await updateName(name.value);
    name.value = profile.name;
    status.textContent = "Name saved.";
  } catch (cause) {
    showError(cause);
  } finally {
    setPending(false);
    submit.textContent = "Save name";
  }
});

emailForm.addEventListener("change", () => { emailStatus.textContent = ""; });
emailForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (pending) return;
  emailError.hidden = true;
  emailStatus.textContent = "";
  const preferences = Object.fromEntries(emailInputs.map(input => [input.name, input.checked]));
  setPending(true);
  emailSubmit.textContent = "Saving…";
  try {
    const saved = await updateEmailPreferences(preferences);
    for (const input of emailInputs) input.checked = saved[input.name];
    emailStatus.textContent = "Email preferences saved.";
  } catch (cause) {
    showError(cause, emailError);
  } finally {
    setPending(false);
    emailSubmit.textContent = "Save email preferences";
  }
});

retry.addEventListener("click", loadAccount);
signOut.addEventListener("click", async () => {
  if (pending) return;
  error.hidden = true;
  setPending(true);
  status.textContent = "Signing out…";
  try {
    await auth.signOut();
    window.location.assign("/");
  } catch (cause) {
    status.textContent = "";
    showError(cause);
  } finally {
    setPending(false);
  }
});

await loadAccount();
