import assert from "node:assert/strict";
import test from "node:test";
import { createAuthClient, isSession, readStoredSession, storeSession } from "../src/auth.js";
import { messageBoardConfig } from "../src/config.js";
import { fetchMessages } from "../src/messages-api.js";

function session() {
  return {
    token: `bff_us_${"a".repeat(64)}`,
    session: { id: "session", user_id: "real-user", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() },
    user: { id: "real-user", email: "person@example.com" }, created: true,
  };
}

test("email login uses Yapern auth without a browser key or cookies, and reuses its bearer for board data", async t => {
  t.after(() => storeSession(null));
  const saved = session();
  const auth = createAuthClient(async (url, options) => {
    assert.equal(url, `https://api.yapern.com/auth/email`);
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.apikey, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(options.body), { email: "person@example.com", password: " Exact password " });
    return Response.json(saved, { status: 201 });
  });
  assert.deepEqual(await auth.signInWithEmail(" Person@Example.COM ", " Exact password "), saved);
  assert.deepEqual(readStoredSession(), saved);
  await fetchMessages(async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${saved.token}`);
    assert.equal(options.credentials, "omit");
    return Response.json({ data: [] });
  });
});

test("session checks discard revoked sessions; sign-out revokes the exact session token", async t => {
  t.after(() => storeSession(null));
  const saved = session();
  storeSession(saved);
  const auth = createAuthClient(async (url, options) => {
    assert.ok(url.endsWith("/auth/session"));
    assert.equal(options.headers.authorization, `Bearer ${saved.token}`);
    assert.equal(options.credentials, "omit");
    if (options.method === "DELETE") return Response.json({ revoked: true });
    return Response.json({ session: saved.session, user: saved.user });
  });
  assert.deepEqual(await auth.readSession(), { token: saved.token, session: saved.session, user: saved.user });
  await auth.signOut();
  assert.equal(readStoredSession(), null);
  storeSession(saved);
  assert.equal(await createAuthClient(async () => new Response(null, { status: 401 })).readSession(), null);
  assert.equal(readStoredSession(), null);
});

test("expired, malformed, and mismatched sessions cannot be stored as authenticated users", async t => {
  t.after(() => storeSession(null));
  for (const invalid of [null, {}, { ...session(), token: "owner-token" },
    { ...session(), user: { id: "someone-else", email: "other@example.com" } }]) {
    assert.equal(isSession(invalid), false);
  }
  const expired = session();
  expired.session.expires_at = "2000-01-01";
  storeSession(expired);
  assert.equal(readStoredSession(), null);
  await assert.rejects(createAuthClient(async () => Response.json(expired)).signInWithEmail("a@example.com", "password"));
});

test("auth reports useful errors and retains the session when logout fails", async t => {
  t.after(() => storeSession(null));
  for (const [code, message] of [["invalid_credentials", /incorrect/], ["weak_password", /8 characters/], ["rate_limited", /Too many attempts/]]) {
    const auth = createAuthClient(async () => Response.json({ error: code }, { status: 400 }));
    await assert.rejects(auth.signInWithEmail("person@example.com", "password"), message);
  }
  const auth = createAuthClient(async () => { throw new TypeError("network"); });
  await assert.rejects(auth.signInWithEmail("person@example.com", "password"), /Check your connection/);
  const saved = session();
  storeSession(saved);
  await assert.rejects(auth.signOut());
  assert.deepEqual(readStoredSession(), saved);
});

const storageKey = `yapern-session:${messageBoardConfig.apiOrigin}`;
let moduleId = 0;
const freshAuth = () => import(`../src/auth.js?storage-test=${++moduleId}`);

function storage() {
  const entries = new Map();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
  };
}

function browser(t, localStorage = storage(), sessionStorage = storage()) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const window = { localStorage, sessionStorage };
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  });
  return window;
}

test("sessions survive page reloads, new tabs, and browser restarts using persistent storage", async t => {
  const window = browser(t);
  const saved = session();
  (await freshAuth()).storeSession(saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(storageKey)), saved);
  assert.equal(window.sessionStorage.getItem(storageKey), null);
  assert.deepEqual((await freshAuth()).readStoredSession(), saved);
  window.sessionStorage = storage(); // A new tab/browser session has empty tab storage.
  assert.deepEqual((await freshAuth()).readStoredSession(), saved);
});

test("existing tab sessions migrate without extending their expiry", async t => {
  const window = browser(t);
  const saved = session();
  window.sessionStorage.setItem(storageKey, JSON.stringify(saved));
  assert.deepEqual((await freshAuth()).readStoredSession(), saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(storageKey)), saved);
  assert.equal(window.sessionStorage.getItem(storageKey), null);
});

test("visiting in an empty tab does not prevent migration from a signed-in tab", async t => {
  const window = browser(t);
  assert.equal((await freshAuth()).readStoredSession(), null);
  assert.equal(window.localStorage.getItem(storageKey), null);
  const saved = session();
  window.sessionStorage.setItem(storageKey, JSON.stringify(saved));
  assert.deepEqual((await freshAuth()).readStoredSession(), saved);
});

test("sessions from the old BFF and other API origins are not reused", async t => {
  const window = browser(t);
  const saved = session();
  for (const key of ["yapern-session:90da3093-84b6-4cd7-a39a-a8afc39403b8", "yapern-session:http://localhost:8787"]) {
    window.localStorage.setItem(key, JSON.stringify(saved));
    window.sessionStorage.setItem(key, JSON.stringify(saved));
  }
  const auth = await freshAuth();
  let requests = 0;
  assert.equal(await auth.createAuthClient(async () => { requests++; }).readSession(), null);
  assert.equal(requests, 0);
  auth.storeSession(saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(storageKey)), saved);
});

test("logout propagates to other tabs and prevents old tab sessions from returning", async t => {
  const window = browser(t);
  const firstTab = await freshAuth();
  const otherTab = await freshAuth();
  const saved = session();
  firstTab.storeSession(saved);
  assert.deepEqual(otherTab.readStoredSession(), saved);
  await firstTab.createAuthClient(async () => Response.json({ revoked: true })).signOut();
  window.sessionStorage.setItem(storageKey, JSON.stringify(saved)); // An unmigrated older tab.
  assert.equal(otherTab.readStoredSession(), null);
  assert.equal(window.sessionStorage.getItem(storageKey), null);
  assert.equal((await freshAuth()).readStoredSession(), null);
});

test("malformed and expired persistent sessions are discarded", async t => {
  const window = browser(t);
  const expired = session();
  expired.session.expires_at = "2000-01-01";
  for (const value of ["invalid json", "{}", JSON.stringify(expired)]) {
    window.localStorage.setItem(storageKey, value);
    assert.equal((await freshAuth()).readStoredSession(), null);
    assert.equal(window.localStorage.getItem(storageKey), "null");
  }
});

test("blocked persistent storage falls back to tab storage, then memory", async t => {
  const blocked = {
    getItem() { throw new Error("Storage blocked"); },
    setItem() { throw new Error("Storage blocked"); },
    removeItem() { throw new Error("Storage blocked"); },
  };
  const window = browser(t, blocked);
  const saved = session();
  (await freshAuth()).storeSession(saved);
  assert.deepEqual((await freshAuth()).readStoredSession(), saved);
  window.sessionStorage = blocked;
  const auth = await freshAuth();
  auth.storeSession(saved);
  assert.deepEqual(auth.readStoredSession(), saved);
  auth.storeSession(null);
  assert.equal(auth.readStoredSession(), null);
});

test("temporary session-check failures preserve the persistent login", async t => {
  browser(t);
  const saved = session();
  const auth = await freshAuth();
  auth.storeSession(saved);
  for (const fetcher of [
    async () => { throw new TypeError("offline"); },
    async () => new Response(null, { status: 502 }),
    async () => new Response(null, { status: 503 }),
    async () => new Response("invalid json"),
    async () => Response.json({}),
  ]) {
    await assert.rejects(auth.createAuthClient(fetcher).readSession());
    assert.deepEqual((await freshAuth()).readStoredSession(), saved);
  }
});
