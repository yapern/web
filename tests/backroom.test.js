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

async function openBackroom(t, saved, hash = "", fetcher = () => assert.fail("Unexpected API request")) {
  const previous = ["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  function element(textContent = "") {
    const attributes = new Map();
    const listeners = new Map();
    return { hidden: true, textContent, value: "", disabled: false, listeners,
      addEventListener: (name, listener) => listeners.set(name, listener),
      reportValidity: () => true,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      getAttribute: name => attributes.get(name) ?? null };
  }
  const elements = Object.fromEntries(["layout", "access", "status", "login", "content",
    "email-view", "email-form", "email-to", "email-from", "email-subj", "email-body", "email-submit", "email-status", "email-error"]
    .map(name => [name, element()]));
  elements["email-to"].value = "oneone@gmail.com";
  elements["email-from"].value = "hello@yapern.com";
  elements["email-subj"].value = "A test email";
  elements["email-body"].value = "Hello, Yapern.\nSecond line.";
  elements["email-form"].elements = ["to", "from", "subj", "body", "submit"].map(name => elements[`email-${name}`]);
  const links = ["Users", "Sub-Yaps", "Messages", "Replies", "Email"].map(label => ({
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
  t.mock.method(globalThis, "fetch", fetcher);
  storeSession(saved);
  await import(`../src/backroom.js?test=${++moduleId}`);
  return { ...elements, links, window, timers, dispatch: name => listeners.get(name)(),
    submitEmail: () => elements["email-form"].listeners.get("submit")({ preventDefault() {} }) };
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

test("menu selection follows URL fragments and shows the email form only in Email", async t => {
  const page = await openBackroom(t, session(), "#sub-yaps");
  assert.equal(page.links[1].getAttribute("aria-current"), "page");
  assert.equal(page.content.getAttribute("aria-label"), "Sub-Yaps");
  for (const [hash, label] of [["#email", "Email"], ["#replies", "Replies"], ["#users", "Users"], ["#unknown", "Users"]]) {
    page.window.location.hash = hash;
    page.dispatch("hashchange");
    const current = page.links.filter(link => link.getAttribute("aria-current") === "page");
    assert.equal(current.length, 1);
    assert.equal(current[0].textContent, label);
    assert.equal(page["email-view"].hidden, hash !== "#email");
  }
});

test("sending blocks duplicate submits, preserves the draft across navigation, and confirms acceptance", async t => {
  let finish;
  let requests = 0;
  const page = await openBackroom(t, session(), "#email", () => {
    requests++;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = page.submitEmail();
  assert.equal(page["email-form"].getAttribute("aria-busy"), "true");
  assert.ok(page["email-form"].elements.every(control => control.disabled));
  await page.submitEmail();
  assert.equal(requests, 1);
  page.window.location.hash = "#users";
  page.dispatch("hashchange");
  page.window.location.hash = "#email";
  page.dispatch("hashchange");
  assert.equal(page["email-body"].value, "Hello, Yapern.\nSecond line.");
  finish(Response.json({ ok: true, messageId: "test-message" }, { status: 202 }));
  await pending;
  assert.match(page["email-status"].textContent, /accepted for delivery to oneone@gmail.com/);
  assert.equal(page["email-error"].textContent, "");
  assert.equal(page["email-form"].getAttribute("aria-busy"), "false");
  assert.ok(page["email-form"].elements.every(control => !control.disabled));
});

test("failed sends preserve the draft and show inline errors without retrying", async t => {
  let requests = 0;
  const page = await openBackroom(t, session(), "#email", () => {
    requests++;
    return Response.json({ error: "recipient_unsubscribed" }, { status: 409 });
  });
  await page.submitEmail();
  assert.equal(requests, 1);
  assert.match(page["email-error"].textContent, /unsubscribed/);
  assert.equal(page["email-status"].textContent, "");
  assert.equal(page["email-subj"].value, "A test email");
  assert.equal(page["email-body"].value, "Hello, Yapern.\nSecond line.");
  assert.ok(page["email-form"].elements.every(control => !control.disabled));
});

test("hidden, invalid, and signed-out forms cannot issue a send request", async t => {
  const page = await openBackroom(t, session());
  await page.submitEmail();
  page.window.location.hash = "#email";
  page.dispatch("hashchange");
  page["email-form"].reportValidity = () => false;
  await page.submitEmail();
  page["email-form"].reportValidity = () => true;
  storeSession(null);
  await page.submitEmail();
  assert.equal(page.layout.hidden, true);
  assert.equal(page.login.hidden, false);
});
