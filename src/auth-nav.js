import { readStoredSession } from "./auth.js";
import { notificationsLive } from "./notifications-live.js";

const header = document.querySelector(".site-header");
const headerMenu = document.querySelector("#header-menu");
const headerToggle = document.querySelector("#header-toggle");
const mobileNavigation = window.matchMedia("(max-width: 900px)");
const notificationLink = document.querySelector('.header-icon-button[href="/notifications/"]');
const notificationDot = notificationLink?.querySelector("[data-notification-unread-dot]");

notificationsLive.subscribe(({ snapshot }) => {
  const unread = Number.isSafeInteger(snapshot?.unread_count) && snapshot.unread_count > 0;
  if (notificationDot) notificationDot.hidden = !unread;
  if (notificationLink) {
    notificationLink.setAttribute("aria-label", unread ? "Notifications (unread replies)" : "Notifications");
    notificationLink.title = unread ? "Notifications (unread replies)" : "Notifications";
  }
});

function setMobileMenuOpen(open, restoreFocus = false) {
  if (!headerMenu || !headerToggle) return;
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
    if (toggleHadFocus) headerMenu.querySelector("[data-login-link]")?.focus();
  }
}

export function syncSession() {
  const session = readStoredSession();
  const signedIn = Boolean(session);
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
  if (signedIn) notificationsLive.start(session);
  else {
    notificationsLive.syncSession(null);
    notificationsLive.stop();
  }
  if (!signedIn) closeHeaderMenu();
}

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
headerMenu?.querySelectorAll("a").forEach(link => link.addEventListener("click", () => closeHeaderMenu()));
mobileNavigation.addEventListener("change", syncNavigationMode);
window.addEventListener("pageshow", syncSession);
window.addEventListener("focus", syncSession);
window.addEventListener("storage", syncSession);
syncNavigationMode();
syncSession();
