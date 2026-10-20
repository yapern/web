import assert from "node:assert/strict";
import test from "node:test";
import { createReply, fetchReplies } from "../src/messages-api.js";
import { messageBoardConfig } from "../src/config.js";
import { storeSession } from "../src/auth.js";

const session = {
  token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "real-user", expires_at: new Date(Date.now() + 3600000).toISOString() },
  user: { id: "real-user", email: "person@example.com" },
};

function reply(overrides = {}) {
  return {
    id: "reply-1",
    message_id: "parent-1",
    user_id: "alice",
    body: "A reply",
    created_at: "2026-10-18T12:00:00.000Z",
    ...overrides,
  };
}

test("reads replies for the exact parent in ascending paginated order", async () => {
  const parentId = "older / post?";
  const firstPage = Array.from({ length: 100 }, (_, i) => reply({
    id: `reply-${i}`,
    message_id: parentId,
    created_at: new Date(Date.UTC(2026, 9, 18, 12, 0, i)).toISOString(),
  }));
  const secondPage = [reply({ id: "reply-100", message_id: parentId })];
  const replies = await fetchReplies(parentId, async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.ok(url.pathname.endsWith("/tables/replies"));
    assert.equal(url.searchParams.get("select"), "id,message_id,user_id,body,created_at");
    assert.equal(url.searchParams.get("message_id"), `eq.${parentId}`);
    assert.equal(url.searchParams.get("order"), "created_at.asc");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.deepEqual(options.headers, {});
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: url.searchParams.get("offset") === "0" ? firstPage : secondPage });
  });
  assert.equal(replies.length, 101);
  assert.equal(replies[0].id, "reply-0");
  assert.equal(replies[100].id, "reply-100");
});

test("reply reads reject bad parent IDs, malformed rows, and rows from another thread", async () => {
  const neverFetch = () => assert.fail("must reject before sending a request");
  for (const parentId of ["", "  ", null, 12]) await assert.rejects(fetchReplies(parentId, neverFetch));
  for (const row of [
    { ...reply(), id: " " },
    { ...reply(), message_id: "other-parent" },
    { ...reply(), user_id: "" },
    { ...reply(), body: "   " },
    { ...reply(), body: "a".repeat(2001) },
    { ...reply(), created_at: "invalid" },
  ]) {
    await assert.rejects(fetchReplies("parent-1", async () => Response.json({ data: [row] })), /Invalid replies/);
  }
  await assert.rejects(fetchReplies("parent-1", async () => new Response(null, { status: 403 })), /unavailable/);
});

test("reply creation trims the body, keeps the exact parent ID, and confirms the authenticated author", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const parentId = "older / post?";
  const saved = reply({ message_id: parentId, user_id: "real-user", body: "My reply" });
  const result = await createReply(parentId, "  My reply  ", async (url, options) => {
    assert.ok(url.pathname.endsWith("/tables/replies"));
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.headers.apikey, undefined);
    assert.equal(options.headers["content-type"], "application/json");
    assert.equal(options.credentials, "omit");
    assert.equal(options.mode, "cors");
    assert.equal(options.redirect, "error");
    const data = JSON.parse(options.body);
    assert.deepEqual(data, { message_id: parentId, body: "My reply", user_id: "real-user" });
    return Response.json({ data: [saved] }, { status: 201 });
  });
  assert.deepEqual(result, saved);
});

test("invalid reply input and missing or expired sessions never send a write", async t => {
  t.after(() => storeSession(null));
  const neverFetch = () => assert.fail("must reject before sending a request");
  storeSession(session);
  for (const [parentId, body] of [
    ["", "reply"], ["  ", "reply"], ["parent", " "], ["parent", "a".repeat(2001)], [null, "reply"], ["parent", null],
  ]) await assert.rejects(createReply(parentId, body, neverFetch));
  for (const saved of [null, { ...session, session: { ...session.session, expires_at: "2000-01-01" } }]) {
    storeSession(saved);
    await assert.rejects(createReply("parent", "reply", neverFetch), /session has expired/);
  }
});

test("reply writes report permission failures and do not retry uncertain or unconfirmed results", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  await assert.rejects(createReply("parent", "reply", async () => new Response(null, { status: 403 })), /permission to reply/);
  let calls = 0;
  await assert.rejects(createReply("parent", "reply", async () => {
    calls++;
    throw new TypeError("network failure");
  }), /Could not confirm creation/);
  assert.equal(calls, 1);
  for (const row of [
    reply({ user_id: "someone-else" }),
    reply({ message_id: "different-parent" }),
    reply({ body: "different body" }),
    reply({ created_at: "invalid" }),
  ]) {
    await assert.rejects(createReply("parent", "reply", async () => Response.json({ data: [row] })), /Could not confirm creation/);
  }
  for (const payload of [{}, { data: [] }, { data: [reply(), reply()] }]) {
    await assert.rejects(createReply("parent", "reply", async () => Response.json(payload)), /Could not confirm creation/);
  }
});
