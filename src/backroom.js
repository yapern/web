import { readStoredSession } from "./auth.js";
import { sendMarketingEmail } from "./marketing-email-api.js";
import { ADMIN_PAGE_SIZE, fetchAdminUsers } from "./admin-api.js";

const layout = document.querySelector("#backroom-layout");
const access = document.querySelector("#backroom-access");
const status = document.querySelector("#backroom-status");
const login = document.querySelector("#backroom-login");
const content = document.querySelector("#backroom-content");
const links = [...document.querySelectorAll("#backroom-menu a")];
const usersView = document.querySelector("#backroom-users-view");
const usersSearchForm = document.querySelector("#backroom-users-search-form");
const usersSearch = document.querySelector("#backroom-users-search");
const usersSearchSubmit = document.querySelector("#backroom-users-search-submit");
const usersStatus = document.querySelector("#backroom-users-status");
const usersError = document.querySelector("#backroom-users-error");
const usersRetry = document.querySelector("#backroom-users-retry");
const usersTable = document.querySelector("#backroom-users-table");
const usersRows = document.querySelector("#backroom-users-rows");
const usersPagination = document.querySelector("#backroom-users-pagination");
const usersPrevious = document.querySelector("#backroom-users-previous");
const usersNext = document.querySelector("#backroom-users-next");
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
let usersSessionToken = null;
let usersRequest = 0;
let usersRequested = false;
let usersLoading = false;
let usersOptions = { offset: 0, q: "" };
let usersPage = null;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function resetUsers() {
  usersRequest++;
  usersRequested = false;
  usersLoading = false;
  usersOptions = { offset: 0, q: "" };
  usersPage = null;
  usersSearch.value = "";
  usersRows.replaceChildren();
  usersStatus.textContent = "";
  usersError.textContent = "";
  usersTable.hidden = true;
  usersTable.setAttribute("aria-busy", "false");
  usersPagination.hidden = true;
  usersRetry.hidden = true;
  usersSearchSubmit.disabled = false;
  usersPrevious.disabled = true;
  usersNext.disabled = true;
}

function syncAccess() {
  window.clearTimeout(accessTimer);
  // Each backend endpoint also authorizes the current admin session.
  const session = readStoredSession();
  const allowed = session?.user.email.trim().toLowerCase() === "oneone@gmail.com";
  const token = allowed ? session.token : null;
  if (token !== usersSessionToken) {
    usersSessionToken = token;
    resetUsers();
  }
  layout.hidden = !allowed;
  access.hidden = allowed;
  login.hidden = Boolean(session);
  status.textContent = session ? "You don’t have access to the backroom." : "Log in to access the backroom.";
  if (allowed) {
    accessTimer = window.setTimeout(syncMenu,
      Math.min(Date.parse(session.session.expires_at) - Date.now(), 2_147_483_647));
  }
}

function syncMenu() {
  syncAccess();
  const active = links.find(link => link.hash === window.location.hash) || links[0];
  for (const link of links) {
    if (link === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  content.setAttribute("aria-label", active.textContent);
  usersView.hidden = active.hash !== "#users";
  emailView.hidden = active.hash !== "#email";
  if (!layout.hidden && !usersView.hidden && !usersRequested) void loadUsers();
}

function renderUser(user) {
  const row = document.createElement("tr");
  const identity = document.createElement("td");
  const name = document.createElement("span");
  name.className = "backroom-user-name";
  name.textContent = user.name.trim() || "Unnamed user";
  const id = document.createElement("span");
  id.className = "backroom-user-id";
  id.textContent = user.id;
  identity.append(name, id);
  const email = document.createElement("td");
  email.textContent = user.email?.trim() || "No email";
  const joined = document.createElement("td");
  const time = document.createElement("time");
  time.dateTime = user.created_at;
  time.textContent = dateFormat.format(new Date(user.created_at));
  joined.append(time);
  row.append(identity, email, joined);
  return row;
}

async function loadUsers() {
  if (layout.hidden || usersView.hidden || usersLoading) return;
  const request = ++usersRequest;
  const token = usersSessionToken;
  usersLoading = true;
  usersRequested = true;
  usersSearchSubmit.disabled = true;
  usersPrevious.disabled = true;
  usersNext.disabled = true;
  usersTable.hidden = false;
  usersTable.setAttribute("aria-busy", "true");
  usersRows.replaceChildren();
  usersStatus.textContent = "Loading users…";
  usersError.textContent = "";
  usersRetry.hidden = true;
  try {
    const page = await fetchAdminUsers(usersOptions);
    if (request !== usersRequest || readStoredSession()?.token !== token) return;
    usersPage = page;
    usersRows.replaceChildren(...page.items.map(renderUser));
    usersTable.hidden = !page.items.length;
    usersStatus.textContent = page.items.length
      ? `${page.offset + 1}–${page.offset + page.items.length} of ${page.total} ${page.total === 1 ? "user" : "users"}`
      : usersOptions.q ? "No users match your search." : page.offset ? "No more users." : "No users yet.";
    usersPagination.hidden = page.offset === 0 && page.total <= page.limit;
  } catch (cause) {
    if (request !== usersRequest || readStoredSession()?.token !== token) return;
    usersPage = null;
    usersTable.hidden = true;
    usersPagination.hidden = true;
    usersStatus.textContent = "";
    usersError.textContent = cause.message;
    usersRetry.hidden = false;
  } finally {
    if (request === usersRequest) {
      usersLoading = false;
      usersSearchSubmit.disabled = false;
      usersTable.setAttribute("aria-busy", "false");
      usersPrevious.disabled = !usersPage || usersPage.offset === 0;
      usersNext.disabled = !usersPage || usersPage.offset + usersPage.limit >= usersPage.total ||
        usersPage.offset + usersPage.limit > 1_000_000;
      syncMenu();
    }
  }
}

usersSearchForm.addEventListener("submit", event => {
  event.preventDefault();
  if (usersLoading || layout.hidden || usersView.hidden || !usersSearchForm.reportValidity()) return;
  usersOptions = { offset: 0, q: usersSearch.value.trim() };
  void loadUsers();
});
usersRetry.addEventListener("click", () => { void loadUsers(); });
usersPrevious.addEventListener("click", () => {
  if (usersPrevious.disabled) return;
  usersOptions = { ...usersOptions, offset: Math.max(0, usersOptions.offset - ADMIN_PAGE_SIZE) };
  void loadUsers();
});
usersNext.addEventListener("click", () => {
  if (usersNext.disabled) return;
  usersOptions = { ...usersOptions, offset: usersOptions.offset + ADMIN_PAGE_SIZE };
  void loadUsers();
});

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

window.addEventListener("pageshow", syncMenu);
window.addEventListener("focus", syncMenu);
window.addEventListener("storage", syncMenu);
window.addEventListener("hashchange", syncMenu);
syncMenu();
