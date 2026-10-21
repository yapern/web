import assert from "node:assert/strict";
import test from "node:test";
import { storeSession } from "../src/auth.js";

let moduleId = 0;
function session(email = "oneone@gmail.com", expiresAt = Date.now() + 3600000) {
  return {
    token: `bff_us_${"a".repeat(64)}`,
    session: { id: "session", user_id: "user", expires_at: new Date(expiresAt).toISOString() },
    user: { id: "user", email },
  };
}

async function openBackroom(t, saved, hash = "") {
  const previous = ["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  function element(textContent = "") {
    const attributes = new Map();
    return { hidden: true, textContent,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      getAttribute: name => attributes.get(name) ?? null };
  }
  const elements = Object.fromEntries(["layout", "access", "status", "login", "content"]
    .map(name => [name, element()]));
  const links = ["Users", "Sub-Yaps", "Messages", "Replies"].map(label => ({
    ...element(label), hash: `#${label.toLowerCase()}`,
  }));
  const window = {
    location: { hash },
    addEventListener: (name, listener) => listeners.set(name, listener),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    querySelector: selector => elements[selector.replace("#backroom-", "")],
    querySelectorAll: () => links,
  } });
  t.after(() => {
    storeSession(null);
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  t.mock.method(globalThis, "fetch", () => assert.fail("Backroom must not call an API"));
  storeSession(saved);
  await import(`../src/backroom.js?test=${++moduleId}`);
  return { ...elements, links, window, timers, dispatch: name => listeners.get(name)() };
}

test("only the allowed email with a valid session can see the admin shell, without API requests", async t => {
  const page = await openBackroom(t, session());
  assert.equal(page.layout.hidden, false);
  assert.equal(page.access.hidden, true);
  assert.equal(page.timers.size, 1);
  for (const saved of [null, session("someone@example.com"), session("oneone@gmail.com.evil.example"),
    session("oneone@gmail.com", Date.now() - 1000), { ...session(), token: "invalid" }]) {
    storeSession(saved);
    page.dispatch("storage");
    assert.equal(page.layout.hidden, true);
    assert.equal(page.access.hidden, false);
    assert.equal(page.timers.size, 0);
  }
  storeSession(session("ONEONE@gmail.com"));
  page.dispatch("focus");
  assert.equal(page.layout.hidden, false);
});

test("signed-out users get a login link and other users get an access-denied message", async t => {
  const page = await openBackroom(t, null);
  assert.equal(page.login.hidden, false);
  assert.match(page.status.textContent, /Log in/);
  storeSession(session("other@example.com"));
  page.dispatch("pageshow");
  assert.equal(page.layout.hidden, true);
  assert.equal(page.login.hidden, true);
  assert.match(page.status.textContent, /don’t have access/);
});

test("the shell closes when its session expires, and long sessions use a safe timeout", async t => {
  const saved = session("oneone@gmail.com", Date.now() + 30 * 86400000);
  const page = await openBackroom(t, saved);
  const timer = [...page.timers.values()][0];
  assert.ok(timer.delay > 0 && timer.delay <= 2_147_483_647);
  saved.session.expires_at = "2000-01-01";
  timer.callback();
  assert.equal(page.layout.hidden, true);
  assert.equal(page.login.hidden, false);
});

test("menu selection follows URL fragments and leaves both content columns empty", async t => {
  const page = await openBackroom(t, session(), "#sub-yaps");
  assert.equal(page.links[1].getAttribute("aria-current"), "page");
  assert.equal(page.content.getAttribute("aria-label"), "Sub-Yaps");
  for (const hash of ["#replies", "#users", "#unknown"]) {
    page.window.location.hash = hash;
    page.dispatch("hashchange");
    const current = page.links.filter(link => link.getAttribute("aria-current") === "page");
    assert.equal(current.length, 1);
    assert.equal(current[0].textContent, hash === "#replies" ? "Replies" : "Users");
    assert.equal(page.content.textContent, "");
  }
});
