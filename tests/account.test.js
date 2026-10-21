import assert from "node:assert/strict";
import test from "node:test";
import { fetchProfile, updateName, fetchEmailPreferences, updateEmailPreferences } from "../src/account-api.js";
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

const enabled = { email_notify_replies: true, email_notify_votes: true, email_notify_sub_yap_messages: true };

test("email preferences are fetched privately using the current bearer session", async t => {
  const session = signIn(t);
  assert.deepEqual(await fetchEmailPreferences(async (url, options) => {
    assert.equal(url.pathname, "/account/email-notifications");
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.search, "");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    return Response.json(enabled);
  }), enabled);
});

test("email saves send explicit true and false values and confirm the server saved each one", async t => {
  const session = signIn(t);
  const preferences = { ...enabled, email_notify_replies: false, email_notify_sub_yap_messages: false };
  assert.deepEqual(await updateEmailPreferences(preferences, async (url, options) => {
    assert.equal(url.pathname, "/account/email-notifications");
    assert.equal(options.method, "PATCH");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), preferences);
    return Response.json(preferences);
  }), preferences);
  await assert.rejects(updateEmailPreferences(preferences, async () => Response.json(enabled)), /Could not confirm/);
});

test("email preferences reject missing or nonboolean values and cannot silently default a failed read", async t => {
  signIn(t);
  for (const invalid of [null, {}, { ...enabled, email_notify_votes: 1 }, { ...enabled, email_notify_replies: "false" },
    { ...enabled, email_notify_sub_yap_messages: undefined }, { ...enabled, user_id: "other-user" }]) {
    assert.throws(() => updateEmailPreferences(invalid, async () => assert.fail("must not request")), /Choose an option/);
  }
  for (const invalid of [null, {}, { ...enabled, email_notify_votes: 1 }]) {
    await assert.rejects(fetchEmailPreferences(async () => Response.json(invalid)), /Could not confirm/);
  }
  await assert.rejects(fetchEmailPreferences(async () => new Response("not JSON")), /Could not confirm/);
});

test("email preference errors retain the session except when revoked", async t => {
  const session = signIn(t);
  await assert.rejects(fetchEmailPreferences(async () => new Response(null, { status: 503 })), /try again/);
  await assert.rejects(updateEmailPreferences(enabled, async () => { throw new Error("offline"); }), /Check your connection/);
  assert.deepEqual(readStoredSession(), session);
  await assert.rejects(updateEmailPreferences(enabled, async () => new Response(null, { status: 401 })), /Log in again/);
  assert.equal(readStoredSession(), null);
  await assert.rejects(fetchEmailPreferences(async () => assert.fail("must not request")), /session has expired/);
});

test("a delayed unauthorized email request cannot sign out a newer session", async t => {
  const previous = signIn(t);
  const current = { ...previous, token: `bff_us_${"b".repeat(64)}` };
  await assert.rejects(fetchEmailPreferences(async () => {
    storeSession(current);
    return new Response(null, { status: 401 });
  }), /Log in again/);
  assert.deepEqual(readStoredSession(), current);
});
