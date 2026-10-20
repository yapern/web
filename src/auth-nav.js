import { readStoredSession } from "./auth.js";

const header = document.querySelector(".site-header");
const headerMenu = document.querySelector("#header-menu");
const headerToggle = document.querySelector("#header-toggle");
const notificationsToggle = document.querySelector("#notifications-toggle");
const notificationsPanel = document.querySelector("#notifications-panel");
const mobileNavigation = window.matchMedia("(max-width: 900px)");

function setNotificationsOpen(open, restoreFocus = false) {
  if (!notificationsToggle || !notificationsPanel) return;
  notificationsPanel.hidden = !open;
  notificationsToggle.setAttribute("aria-expanded", String(open));
  if (!open && restoreFocus) notificationsToggle.focus();
}

function setMobileMenuOpen(open, restoreFocus = false) {
  if (!headerMenu || !headerToggle) return;
  if (!open) setNotificationsOpen(false);
  const wasOpen = !headerMenu.hidden;
  headerMenu.hidden = !open;
  headerToggle.setAttribute("aria-expanded", String(open));
  headerToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  if (!open && restoreFocus && (wasOpen || headerMenu.contains(document.activeElement))) {
    headerToggle.focus();
  }
}

export function closeHeaderMenu(restoreFocus = false) {
  if (mobileNavigation.matches) setMobileMenuOpen(false, restoreFocus);
}

function syncNavigationMode() {
  if (!headerMenu || !headerToggle) return;
  setNotificationsOpen(false);
  const activeWasInMenu = headerMenu.contains(document.activeElement);
  const toggleHadFocus = document.activeElement === headerToggle;
  if (mobileNavigation.matches) {
    setMobileMenuOpen(false);
    header?.classList.add("navigation-ready");
    if (activeWasInMenu) headerToggle.focus();
  } else {
    headerMenu.hidden = false;
    headerToggle.setAttribute("aria-expanded", "false");
    headerToggle.setAttribute("aria-label", "Open menu");
    header?.classList.add("navigation-ready");
    if (toggleHadFocus) headerMenu.querySelector("nav a")?.focus();
  }
}

export function syncSession() {
  const signedIn = Boolean(readStoredSession());
  document.querySelectorAll("[data-login-link]").forEach(link => {
    const label = link.querySelector("[data-login-label]");
    if (label) label.textContent = signedIn ? "Account" : "Login";
    else link.textContent = signedIn ? "Account" : "Login";
    link.href = signedIn ? "/account/" : "/login/";
    if (signedIn) {
      link.dataset.signedIn = "true";
      link.setAttribute("aria-label", "Account");
      link.title = "Account";
    } else {
      delete link.dataset.signedIn;
      link.removeAttribute("aria-label");
      link.removeAttribute("title");
    }
    if (signedIn && location.pathname.startsWith("/account")) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-auth-only]").forEach(element => { element.hidden = !signedIn; });
  if (!signedIn) {
    setNotificationsOpen(false);
    closeHeaderMenu();
  }
}

notificationsToggle?.addEventListener("click", () => {
  setNotificationsOpen(notificationsPanel.hidden);
});
document.addEventListener("pointerdown", event => {
  if (notificationsPanel && !notificationsPanel.hidden && !document.querySelector(".notification-control")?.contains(event.target)) {
    setNotificationsOpen(false);
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && notificationsPanel && !notificationsPanel.hidden) {
    event.preventDefault();
    event.stopImmediatePropagation();
    setNotificationsOpen(false, true);
  }
});
notificationsToggle?.addEventListener("focusout", event => {
  if (!event.relatedTarget || !event.currentTarget.parentElement.contains(event.relatedTarget)) {
    setNotificationsOpen(false);
  }
});
headerToggle?.addEventListener("click", () => {
  if (!mobileNavigation.matches) return;
  setMobileMenuOpen(headerMenu.hidden);
});
document.addEventListener("pointerdown", event => {
  if (mobileNavigation.matches && headerMenu && !headerMenu.hidden && !header?.contains(event.target)) {
    closeHeaderMenu();
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && mobileNavigation.matches && headerMenu && !headerMenu.hidden) {
    event.preventDefault();
    closeHeaderMenu(true);
  }
});
header?.addEventListener("focusout", event => {
  if (mobileNavigation.matches && headerMenu && !headerMenu.hidden && !headerMenu.contains(event.relatedTarget) && event.relatedTarget !== headerToggle) {
    closeHeaderMenu();
  }
});
headerMenu?.querySelectorAll("nav a").forEach(link => link.addEventListener("click", () => closeHeaderMenu()));
mobileNavigation.addEventListener("change", syncNavigationMode);
window.addEventListener("pageshow", syncSession);
window.addEventListener("focus", syncSession);
window.addEventListener("storage", syncSession);
syncNavigationMode();
syncSession();
