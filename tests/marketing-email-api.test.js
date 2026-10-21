import assert from "node:assert/strict";
import test from "node:test";
import { sendMarketingEmail } from "../src/marketing-email-api.js";
import { readStoredSession, storeSession } from "../src/auth.js";
import { messageBoardConfig } from "../src/config.js";

const input = { to: "recipient@example.com", from: "hello@yapern.com", subj: "An update", message: "Hello <friends>\n\nLine two. " };
function signIn(t, email = "oneone@gmail.com") {
  const session = {
    token: `bff_us_${"a".repeat(64)}`,
    session: { id: "session", user_id: "admin", expires_at: new Date(Date.now() + 3600000).toISOString() },
    user: { id: "admin", email },
  };
  storeSession(session);
  t.after(() => storeSession(null));
  return session;
}

test("test sends use the admin bearer and backend contract with a branded template and intact body", async t => {
  const session = signIn(t, " ONEONE@gmail.com ");
  const result = { ok: true, messageId: "message-123" };
  assert.deepEqual(await sendMarketingEmail({ ...input, to: " recipient@example.com ", from: " hello@yapern.com ", subj: " An update " }, async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.pathname, "/api/send-marketing-email");
    assert.equal(options.method, "POST");
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { authorization: `Bearer ${session.token}`, "content-type": "application/json" });
    assert.deepEqual(JSON.parse(options.body), { ...input, fancy: true });
    return Response.json(result, { status: 202 });
  }), result);
});

test("missing, expired, and non-admin sessions never send email", async t => {
  const session = signIn(t);
  const neverFetch = () => assert.fail("must not send");
  for (const value of [null, { ...session, user: { ...session.user, email: "other@example.com" } },
    { ...session, session: { ...session.session, expires_at: "2000-01-01" } }]) {
    storeSession(value);
    await assert.rejects(sendMarketingEmail(input, neverFetch), /session has expired|permission/);
  }
});

test("invalid fields and header injection fail before sending", async t => {
  signIn(t);
  const neverFetch = () => assert.fail("must not send");
  for (const invalid of [null, {},
    ...["", "bad", "a@example.com,b@example.com", "A <a@example.com>", "a\u0000@example.com", `${"a".repeat(250)}@example.com`]
      .flatMap(value => [{ ...input, to: value }, { ...input, from: value }]),
    ...["", "   ", "x".repeat(999), "Hi\r\nBcc: other@example.com"].map(subj => ({ ...input, subj })),
    ...["", "   ", null, "x".repeat(100001)].map(message => ({ ...input, message })),
  ]) await assert.rejects(sendMarketingEmail(invalid, neverFetch), /Enter a/);
});

test("backend rejections have useful messages and retain the session without retries", async t => {
  const session = signIn(t);
  for (const [status, error, pattern] of [
    [400, "invalid_request", /Check the recipient/], [403, "forbidden", /permission/],
    [404, "not_found", /not available/], [409, "recipient_unsubscribed", /unsubscribed/],
    [413, "request_too_large", /too large/], [429, "email_rate_limited", /limit reached/],
    [502, "email_send_failed", /could not send/], [503, "email_sending_unavailable", /unavailable/],
    [503, "email_preferences_unavailable", /No email was sent/],
  ]) {
    let requests = 0;
    await assert.rejects(sendMarketingEmail(input, async () => {
      requests++;
      return Response.json({ error }, { status });
    }), pattern);
    assert.equal(requests, 1);
    assert.deepEqual(readStoredSession(), session);
  }
});

test("401 clears the rejected session while preserving a newer login", async t => {
  const session = signIn(t);
  await assert.rejects(sendMarketingEmail(input, async () => new Response(null, { status: 401 })), /Log in again/);
  assert.equal(readStoredSession(), null);
  storeSession(session);
  const newerSession = { ...session, token: `bff_us_${"b".repeat(64)}` };
  await assert.rejects(sendMarketingEmail(input, async () => {
    storeSession(newerSession);
    return new Response(null, { status: 401 });
  }), /Log in again/);
  assert.deepEqual(readStoredSession(), newerSession);
});

test("unconfirmed responses and network failures never report acceptance or retry", async t => {
  signIn(t);
  for (const fetcher of [
    ...[{}, { ok: true }, { ok: true, messageId: "" }, { ok: true, messageId: 7 }, { ok: false, messageId: "message" }]
      .map(payload => async () => Response.json(payload, { status: 202 })),
    async () => Response.json({ ok: true, messageId: "message" }),
    async () => new Response("invalid JSON", { status: 202 }),
    async () => new Response(null, { status: 504 }),
    async () => { throw new TypeError("network failure"); },
    async () => { throw new DOMException("timeout", "TimeoutError"); },
  ]) {
    let requests = 0;
    await assert.rejects(sendMarketingEmail(input, async (...args) => { requests++; return fetcher(...args); }), /Check the recipient’s inbox/);
    assert.equal(requests, 1);
  }
});
