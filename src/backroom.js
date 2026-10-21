import { readStoredSession } from "./auth.js";

const layout = document.querySelector("#backroom-layout");
const access = document.querySelector("#backroom-access");
const status = document.querySelector("#backroom-status");
const login = document.querySelector("#backroom-login");
const content = document.querySelector("#backroom-content");
const links = [...document.querySelectorAll("#backroom-menu a")];
let accessTimer;

function syncAccess() {
  window.clearTimeout(accessTimer);
  // This gates the empty shell locally; future admin APIs must enforce access on the server.
  const session = readStoredSession();
  const allowed = session?.user.email.toLowerCase() === "oneone@gmail.com";
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
}

window.addEventListener("pageshow", syncAccess);
window.addEventListener("focus", syncAccess);
window.addEventListener("storage", syncAccess);
window.addEventListener("hashchange", syncMenu);
syncAccess();
syncMenu();
