import assert from "node:assert/strict";
import test from "node:test";
import { fetchProfile, updateName } from "../src/account-api.js";
import { readStoredSession, storeSession } from "../src/auth.js";
import { messageBoardConfig } from "../src/config.js";

function signIn(t) {
  const session = {
    token: `bff_us_${"a".repeat(64)}`,
    session: { id: "session", user_id: "real-user", expires_at: new Date(Date.now() + 3600000).toISOString() },
    user: { id: "real-user", email: "person@example.com" },
  };
  storeSession(session);
  t.after(() => storeSession(null));
  return session;
}

test("account reads the signed-in user's existing users.name with the bearer session", async t => {
  const session = signIn(t);
  const user = { id: session.user.id, name: "Existing Name" };
  assert.deepEqual(await fetchProfile(async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.pathname, `/tables/users`);
    assert.deepEqual(Object.fromEntries(url.searchParams), { id: "eq.real-user", select: "id,name", limit: "1" });
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers.apikey, undefined);
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    return Response.json({ data: [user] });
  }), user);
});

test("saving a name patches only the signed-in user's name and confirms the persisted value", async t => {
  const session = signIn(t);
  const user = { id: session.user.id, name: "Zoë 王" };
  assert.deepEqual(await updateName("  Zoë 王  ", async (url, options) => {
    assert.equal(url.pathname, `/tables/users`);
    assert.deepEqual(Object.fromEntries(url.searchParams), { id: "eq.real-user" });
    assert.equal(options.method, "PATCH");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.deepEqual(JSON.parse(options.body), { name: user.name });
    return Response.json({ data: [user] });
  }), user);
});

test("blank and oversized names and missing or expired sessions never issue a profile request", async t => {
  const session = signIn(t);
  const noRequest = async () => assert.fail("must not request the API");
  for (const name of ["", "   ", "a".repeat(81)]) {
    assert.throws(() => updateName(name, noRequest), /1–80 characters/);
  }
  session.session.expires_at = "2000-01-01";
  storeSession(session);
  await assert.rejects(updateName("New name", noRequest), /session has expired/);
  await assert.rejects(fetchProfile(noRequest), /session has expired/);
});

test("unauthorized profile requests clear revoked sessions", async t => {
  signIn(t);
  await assert.rejects(updateName("New name", async () => new Response(null, { status: 401 })), /Log in again/);
  assert.equal(readStoredSession(), null);
});

test("failed name changes keep the session and report useful errors", async t => {
  const session = signIn(t);
  await assert.rejects(updateName("New name", async () => new Response(null, { status: 403 })), /permission/);
  await assert.rejects(updateName("New name", async () => new Response(null, { status: 503 })), /try again/);
  await assert.rejects(updateName("New name", async () => { throw new Error("offline"); }), /Check your connection/);
  assert.deepEqual(readStoredSession(), session);
});

test("a missing profile, another user's row, or an unconfirmed name cannot report success", async t => {
  signIn(t);
  for (const data of [[], [{ id: "other-user", name: "New name" }],
    [{ id: "real-user", name: "Old name" }], [{ id: "real-user" }],
    [{ id: "real-user", name: "New name" }, { id: "other-user", name: "New name" }]]) {
    await assert.rejects(updateName("New name", async () => Response.json({ data })), /Could not confirm/);
  }
  await assert.rejects(fetchProfile(async () => Response.json({ data: [{ id: "other-user", name: "Other" }] })), /Could not confirm/);
});
