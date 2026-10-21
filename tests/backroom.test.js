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

const settle = () => new Promise(resolve => setImmediate(resolve));
function user(id = "member", overrides = {}) {
  return { id, name: "A user", email: "member@example.com", created_at: "2026-10-21T10:00:00.000Z", ...overrides };
}
function userPage(items = [], total = items.length, offset = 0) {
  return Response.json({ items, total, offset, limit: 25 });
}

async function openBackroom(t, saved, hash = "#sub-yaps", fetcher = () => assert.fail("Unexpected API request")) {
  const previous = ["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  function element(textContent = "") {
    const attributes = new Map();
    const listeners = new Map();
    return { hidden: true, textContent, value: "", disabled: false, listeners, children: [],
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener: (name, listener) => listeners.set(name, listener),
      reportValidity: () => true,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      getAttribute: name => attributes.get(name) ?? null };
  }
  const elements = Object.fromEntries(["layout", "access", "status", "login", "content",
    "users-view", "users-search-form", "users-search", "users-search-submit", "users-status", "users-error",
    "users-retry", "users-table", "users-rows", "users-pagination", "users-previous", "users-next",
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
    createElement: tag => ({ ...element(), tagName: tag.toUpperCase() }),
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
  await settle();
  return { ...elements, links, window, timers, dispatch: name => listeners.get(name)(),
    trigger: (name, event = "click") => elements[name].listeners.get(event)({ preventDefault() {} }),
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

test("menu selection follows URL fragments and shows only the selected view", async t => {
  const page = await openBackroom(t, session(), "#sub-yaps", () => userPage());
  assert.equal(page.links[1].getAttribute("aria-current"), "page");
  assert.equal(page.content.getAttribute("aria-label"), "Sub-Yaps");
  for (const [hash, label] of [["#email", "Email"], ["#replies", "Replies"], ["#users", "Users"], ["#unknown", "Users"]]) {
    page.window.location.hash = hash;
    page.dispatch("hashchange");
    const current = page.links.filter(link => link.getAttribute("aria-current") === "page");
    assert.equal(current.length, 1);
    assert.equal(current[0].textContent, label);
    assert.equal(page["email-view"].hidden, hash !== "#email");
    assert.equal(page["users-view"].hidden, label !== "Users");
  }
  await settle();
});

test("sending blocks duplicate submits, preserves the draft across navigation, and confirms acceptance", async t => {
  let finish;
  let requests = 0;
  const page = await openBackroom(t, session(), "#email", url => {
    if (url.pathname === "/admin/tables/users") return userPage();
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

test("Users lists safe text, missing values, signup dates, and loads only when selected", async t => {
  let requests = 0;
  const page = await openBackroom(t, session(), "#email", () => {
    requests++;
    return userPage([user("member", { name: "<img src=x onerror=alert(1)>" }), user("unnamed", { name: " ", email: null })]);
  });
  assert.equal(requests, 0);
  page.window.location.hash = "#users";
  page.dispatch("hashchange");
  await settle();
  assert.equal(requests, 1);
  assert.equal(page["users-status"].textContent, "1–2 of 2 users");
  assert.equal(page["users-table"].hidden, false);
  assert.equal(page["users-pagination"].hidden, true);
  const rows = page["users-rows"].children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].children[0].tagName, "SPAN");
  assert.equal(rows[0].children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(rows[0].children[0].children[1].textContent, "member");
  assert.equal(rows[0].children[2].children[0].dateTime, "2026-10-21T10:00:00.000Z");
  assert.equal(rows[1].children[0].children[0].textContent, "Unnamed user");
  assert.equal(rows[1].children[1].textContent, "No email");
  page.dispatch("focus");
  page.dispatch("pageshow");
  assert.equal(requests, 1);
});

test("Users pages on the server and searching resets the offset while preserving the filter", async t => {
  const requests = [];
  const page = await openBackroom(t, session(), "", url => {
    const offset = Number(url.searchParams.get("offset"));
    const q = url.searchParams.get("q");
    requests.push({ offset, q });
    const total = q ? 27 : 30;
    return userPage(Array.from({ length: Math.min(25, total - offset) }, (_, index) => user(`member-${offset + index}`)), total, offset);
  });
  assert.equal(page["users-status"].textContent, "1–25 of 30 users");
  assert.equal(page["users-previous"].disabled, true);
  assert.equal(page["users-next"].disabled, false);
  page.trigger("users-next");
  await settle();
  assert.equal(page["users-status"].textContent, "26–30 of 30 users");
  assert.equal(page["users-previous"].disabled, false);
  assert.equal(page["users-next"].disabled, true);
  page["users-search"].value = "  %_person  ";
  page.trigger("users-search-form", "submit");
  await settle();
  page.trigger("users-next");
  await settle();
  page.trigger("users-previous");
  await settle();
  assert.deepEqual(requests, [
    { offset: 0, q: null }, { offset: 25, q: null }, { offset: 0, q: "%_person" },
    { offset: 25, q: "%_person" }, { offset: 0, q: "%_person" },
  ]);
});

test("Users handles loading, errors, retry, empty data, and no search results", async t => {
  let finish;
  let requests = 0;
  const page = await openBackroom(t, session(), "#users", () => {
    requests++;
    if (requests === 1) return new Promise(resolve => { finish = resolve; });
    return userPage();
  });
  assert.equal(page["users-status"].textContent, "Loading users…");
  assert.equal(page["users-table"].getAttribute("aria-busy"), "true");
  assert.equal(page["users-search-submit"].disabled, true);
  page.dispatch("focus");
  page.trigger("users-search-form", "submit");
  assert.equal(requests, 1);
  finish(new Response(null, { status: 503 }));
  await settle();
  assert.match(page["users-error"].textContent, /Could not load users/);
  assert.equal(page["users-retry"].hidden, false);
  assert.equal(page["users-table"].getAttribute("aria-busy"), "false");
  assert.equal(page["users-search-submit"].disabled, false);
  page.dispatch("focus");
  assert.equal(requests, 1);
  page.trigger("users-retry");
  await settle();
  assert.equal(page["users-error"].textContent, "");
  assert.equal(page["users-status"].textContent, "No users yet.");
  assert.equal(page["users-table"].hidden, true);
  page["users-search"].value = "unknown";
  page.trigger("users-search-form", "submit");
  await settle();
  assert.equal(page["users-status"].textContent, "No users match your search.");
});

test("Users discards old responses when sessions change and clears profiles on logout", async t => {
  let finishOld;
  let requests = 0;
  const page = await openBackroom(t, session(), "#users", () => {
    requests++;
    if (requests === 1) return new Promise(resolve => { finishOld = resolve; });
    return userPage([user("new-session-user")]);
  });
  storeSession({ ...session(), token: `bff_us_${"b".repeat(64)}` });
  page.dispatch("storage");
  await settle();
  finishOld(userPage([user("old-session-user")]));
  await settle();
  assert.equal(requests, 2);
  assert.equal(page["users-rows"].children[0].children[0].children[1].textContent, "new-session-user");
  storeSession(null);
  page.dispatch("storage");
  assert.equal(page.layout.hidden, true);
  assert.equal(page["users-rows"].children.length, 0);
  assert.equal(page["users-status"].textContent, "");
  assert.equal(page["users-table"].hidden, true);
});

test("a rejected user-list session closes the backroom and offers login", async t => {
  const page = await openBackroom(t, session(), "#users", () => new Response(null, { status: 401 }));
  assert.equal(page.layout.hidden, true);
  assert.equal(page.login.hidden, false);
  assert.equal(page["users-rows"].children.length, 0);
});
