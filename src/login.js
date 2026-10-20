import { createAuthClient, readStoredSession } from "./auth.js";

const auth = createAuthClient();
const page = document.querySelector(".login-content");
const status = document.querySelector(".login-status");
const error = document.querySelector(".login-error");
const form = document.querySelector(".email-login-form");
const email = document.querySelector("#login-email");
const password = document.querySelector("#login-password");
const submit = document.querySelector(".email-login-submit");
const signedIn = document.querySelector(".login-signed-in");
const identity = document.querySelector(".login-identity");
const signOut = document.querySelector(".login-sign-out");
let session = null;
let pending = true;

function showState() {
  form.hidden = Boolean(session);
  signedIn.hidden = !session;
  status.textContent = session ? "You’re signed in." : "Continue with your email and password.";
  identity.textContent = session?.user.email || "";
}

function setPending(value) {
  pending = value;
  page.setAttribute("aria-busy", String(value));
  for (const control of [email, password, submit, signOut]) control.disabled = value;
}

function showError(cause) {
  error.textContent = cause.message;
  error.hidden = false;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (pending || !form.reportValidity()) return;
  error.hidden = true;
  setPending(true);
  status.textContent = "Signing in…";
  submit.textContent = "Continuing…";
  try {
    session = await auth.signInWithEmail(email.value, password.value);
    password.value = "";
    showState();
    document.querySelector(".login-signed-in a").focus();
  } catch (cause) {
    showState();
    showError(cause);
  } finally {
    setPending(false);
    submit.textContent = "Continue with email";
  }
});

signOut.addEventListener("click", async () => {
  if (pending) return;
  error.hidden = true;
  setPending(true);
  status.textContent = "Signing out…";
  try {
    await auth.signOut();
    session = null;
    showState();
  } catch (cause) {
    showState();
    showError(cause);
  } finally {
    setPending(false);
    if (!session) email.focus();
  }
});

try {
  session = await auth.readSession();
  showState();
} catch (cause) {
  session = readStoredSession();
  showState();
  showError(cause);
} finally {
  setPending(false);
}
