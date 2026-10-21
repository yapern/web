import assert from "node:assert/strict";
import test from "node:test";
import { fetchAdminUsers } from "../src/admin-api.js";
import { readStoredSession, storeSession } from "../src/auth.js";
import { messageBoardConfig } from "../src/config.js";

const profile = { id: "member", name: "Member", email: null, dob: null,
  created_at: "2026-10-21T00:00:00.000Z", marketing_email_unsubscribed: 0 };
const page = { items: [profile], offset: 25, limit: 25, total: 26 };
function signIn(t, email = "oneone@gmail.com") {
  const saved = { token: `bff_us_${"a".repeat(64)}`,
    session: { id: "session", user_id: "admin", expires_at: new Date(Date.now() + 3600000).toISOString() },
    user: { id: "admin", email } };
  storeSession(saved);
  t.after(() => storeSession(null));
  return saved;
}

test("user lists use the existing paginated admin endpoint, search, and current bearer", async t => {
  const saved = signIn(t, " ONEONE@gmail.com ");
  assert.deepEqual(await fetchAdminUsers({ offset: 25, q: "  a%_&b  " }, async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.pathname, "/admin/tables/users");
    assert.equal(url.searchParams.get("offset"), "25");
    assert.equal(url.searchParams.get("q"), "a%_&b");
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.mode, "cors");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { authorization: `Bearer ${saved.token}` });
    return Response.json(page);
  }), page);
});

test("signed-out, expired, and non-admin sessions cannot request user profiles", async t => {
  const saved = signIn(t);
  for (const value of [null, { ...saved, user: { ...saved.user, email: "other@example.com" } },
    { ...saved, session: { ...saved.session, expires_at: "2000-01-01" } }]) {
    storeSession(value);
    await assert.rejects(fetchAdminUsers({}, () => assert.fail("must not request users")), /expired|permission/);
  }
});

test("invalid search and pagination options are rejected before requesting users", async t => {
  signIn(t);
  for (const options of [{ offset: -1 }, { offset: 1.5 }, { offset: 1_000_001 }, { offset: "25" }, { q: "x".repeat(101) }, { q: null }]) {
    await assert.rejects(fetchAdminUsers(options, () => assert.fail("must not request users")), /valid page/);
  }
});

test("user-list 401 clears only the rejected session", async t => {
  const saved = signIn(t);
  await assert.rejects(fetchAdminUsers({}, async () => new Response(null, { status: 401 })), /Log in again/);
  assert.equal(readStoredSession(), null);
  storeSession(saved);
  const newer = { ...saved, token: `bff_us_${"b".repeat(64)}` };
  await assert.rejects(fetchAdminUsers({}, async () => {
    storeSession(newer);
    return new Response(null, { status: 401 });
  }), /Log in again/);
  assert.deepEqual(readStoredSession(), newer);
});

test("user-list failures have readable errors without leaking server details", async t => {
  signIn(t);
  await assert.rejects(fetchAdminUsers({}, async () => Response.json({ error: "forbidden" }, { status: 403 })), /permission/);
  for (const fetcher of [
    async () => { throw new TypeError("private network details"); },
    async () => Response.json({ error: "private database details" }, { status: 503 }),
    async () => new Response("not JSON"),
    ...[null, {}, { ...page, offset: 0 }, { ...page, limit: 100 }, { ...page, total: -1 },
      { ...page, items: [profile, profile] }, { ...page, items: [{ ...profile, created_at: "bad" }] },
      { ...page, items: [{ ...profile, email: 123 }] }].map(payload => async () => Response.json(payload)),
  ]) await assert.rejects(fetchAdminUsers({ offset: 25 }, fetcher), { message: "Could not load users. Please try again." });
});
