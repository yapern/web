import assert from "node:assert/strict";
import test from "node:test";
import { createReply, fetchReplies, fetchReplyPage, fetchReplyContext } from "../src/messages-api.js";
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
    parent_reply_id: null,
    user_id: "alice",
    body: "A reply",
    created_at: "2026-10-18T12:00:00.000Z",
    direct_reply_count: 0,
    ...overrides,
  };
}

test("root reply pages fetch only the requested page without following branches or cursors", async () => {
  let calls = 0;
  const roots = [reply({ direct_reply_count: 12000 })];
  const page = await fetchReplyPage("parent-1", {}, async (url, options) => {
    calls++;
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.pathname, "/messages/parent-1/replies");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("sort"), "new");
    assert.equal(url.searchParams.has("parent_reply_id"), false);
    assert.equal(url.searchParams.has("cursor"), false);
    assert.deepEqual(options.headers, {});
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: roots, meta: { next_cursor: "opaque-next-cursor" } });
  });
  assert.deepEqual(page, { replies: roots, nextCursor: "opaque-next-cursor" });
  assert.equal(calls, 1);
});

test("branch pages keep the exact root, parent and opaque cursor with a bounded size", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const messageId = "root / post?";
  const parentReplyId = "parent / reply?";
  const rows = [reply({ message_id: messageId, parent_reply_id: parentReplyId, direct_reply_count: 500, author_name: "Author name" })];
  const page = await fetchReplyPage(messageId, { parentReplyId, cursor: "opaque_current-cursor", limit: 3, sort: "top" }, async (url, options) => {
    assert.equal(url.pathname, "/messages/root%20%2F%20post%3F/replies");
    assert.equal(url.searchParams.get("parent_reply_id"), parentReplyId);
    assert.equal(url.searchParams.get("cursor"), "opaque_current-cursor");
    assert.equal(url.searchParams.get("limit"), "3");
    assert.equal(url.searchParams.get("sort"), "top");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    return Response.json({ data: rows, meta: { next_cursor: null } });
  });
  assert.deepEqual(page, { replies: rows, nextCursor: null });
});

test("invalid branch page inputs never send a read", async () => {
  const neverFetch = () => assert.fail("must reject before sending a request");
  for (const messageId of ["", " ", null, 12]) {
    await assert.rejects(fetchReplyPage(messageId, {}, neverFetch));
  }
  for (const options of [
    { parentReplyId: "" }, { parentReplyId: " " }, { parentReplyId: 12 },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "3" },
    { sort: "anything" }, { sort: null },
    { cursor: "" }, { cursor: " " }, { cursor: 12 }, { cursor: "x".repeat(8193) },
  ]) {
    await assert.rejects(fetchReplyPage("parent-1", options, neverFetch));
  }
});

test("branch pages reject wrong branches, malformed counts, duplicates and invalid cursors", async () => {
  const valid = reply({ parent_reply_id: "requested-parent" });
  const validPayload = { data: [valid], meta: { next_cursor: null } };
  for (const payload of [
    null, {}, { data: [] }, { ...validPayload, meta: {} },
    { ...validPayload, meta: { next_cursor: 12 } },
    { ...validPayload, meta: { next_cursor: "" } },
    { ...validPayload, meta: { next_cursor: "current-cursor" } },
    { ...validPayload, meta: { next_cursor: "x".repeat(8193) } },
    { data: [], meta: { next_cursor: "next" } },
    { ...validPayload, data: [valid, valid] },
    ...[
      { message_id: "other-message" }, { parent_reply_id: "other-parent" }, { parent_reply_id: null },
      { parent_reply_id: valid.id }, { direct_reply_count: undefined }, { direct_reply_count: -1 }, { direct_reply_count: "1" },
      { author_name: 12 },
    ].map(overrides => ({ ...validPayload, data: [{ ...valid, ...overrides }] })),
    { ...validPayload, data: [valid, reply({ id: "another", parent_reply_id: "requested-parent" })] },
  ]) {
    await assert.rejects(fetchReplyPage("parent-1", { parentReplyId: "requested-parent", cursor: "current-cursor", limit: 1 },
      async () => Response.json(payload)), /Invalid replies/);
  }
});

test("branch read errors do not retry and malformed JSON cannot report success", async () => {
  for (const [status, expected] of [[404, /no longer available/], [400, /unavailable/], [503, /unavailable/]]) {
    let calls = 0;
    await assert.rejects(fetchReplyPage("parent-1", {}, async () => {
      calls++;
      return new Response(null, { status });
    }), expected);
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchReplyPage("parent-1", {}, async () => new Response("bad JSON")), /Invalid replies/);
});

test("focused context loads only bounded ancestry and permits an unloaded older parent", async () => {
  let calls = 0;
  const rows = [
    reply({ id: "parent", parent_reply_id: "unloaded-ancestor", direct_reply_count: 200 }),
    reply({ id: "target / reply?", parent_reply_id: "parent", direct_reply_count: 12 }),
  ];
  const context = await fetchReplyContext("parent-1", "target / reply?", { limit: 2 }, async (url, options) => {
    calls++;
    assert.equal(url.pathname, "/messages/parent-1/replies/target%20%2F%20reply%3F/context");
    assert.equal(url.searchParams.get("limit"), "2");
    assert.equal(options.credentials, "omit");
    return Response.json({ data: rows, meta: { has_more: true } });
  });
  assert.deepEqual(context, { replies: rows, hasMore: true });
  assert.equal(calls, 1);
  const root = reply();
  assert.deepEqual(await fetchReplyContext("parent-1", root.id, {}, async url => {
    assert.equal(url.searchParams.get("limit"), "6");
    return Response.json({ data: [root], meta: { has_more: false } });
  }), { replies: [root], hasMore: false });
});

test("focused context validates its exact target and complete returned parent chain", async () => {
  const rows = [reply({ id: "root" }), reply({ id: "target", parent_reply_id: "root" })];
  const validPayload = { data: rows, meta: { has_more: false } };
  for (const payload of [
    {}, { data: [], meta: { has_more: false } }, { ...validPayload, meta: {} },
    { ...validPayload, meta: { has_more: "false" } },
    { ...validPayload, meta: { has_more: true } },
    { ...validPayload, data: [rows[1], rows[0]] },
    { ...validPayload, data: [rows[0], rows[0]] },
    { ...validPayload, data: [{ ...rows[0], parent_reply_id: "unloaded" }, rows[1]] },
    { ...validPayload, data: [rows[0], { ...rows[1], parent_reply_id: "missing" }] },
    { ...validPayload, data: [rows[0], { ...rows[1], message_id: "other-message" }] },
    { ...validPayload, data: [rows[0], { ...rows[1], direct_reply_count: undefined }] },
    { data: [{ ...rows[0], parent_reply_id: "target" }, rows[1]], meta: { has_more: true } },
  ]) {
    await assert.rejects(fetchReplyContext("parent-1", "target", { limit: 2 }, async () => Response.json(payload)), /Invalid replies/);
  }
  await assert.rejects(fetchReplyContext("parent-1", "target", { limit: 1 }, async () => Response.json(validPayload)), /Invalid replies/);
  const neverFetch = () => assert.fail("must reject before sending a request");
  for (const [messageId, replyId, options] of [
    ["", "target", {}], ["parent-1", "", {}], [null, "target", {}], ["parent-1", 12, {}],
    ["parent-1", "target", { limit: 0 }], ["parent-1", "target", { limit: 101 }], ["parent-1", "target", { limit: 2.5 }],
  ]) await assert.rejects(fetchReplyContext(messageId, replyId, options, neverFetch));
});

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
    assert.equal(url.searchParams.get("select"), "id,message_id,parent_reply_id,user_id,body,created_at,direct_reply_count");
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
    { ...reply(), parent_reply_id: "" },
    { ...reply(), parent_reply_id: "  " },
    { ...reply(), parent_reply_id: 12 },
    { ...reply(), parent_reply_id: "reply-1" },
    { ...reply(), direct_reply_count: -1 },
    { ...reply(), direct_reply_count: 1.5 },
    { ...reply(), direct_reply_count: "1" },
    { ...reply(), direct_reply_count: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await assert.rejects(fetchReplies("parent-1", async () => Response.json({ data: [row] })), /Invalid replies/);
  }
  await assert.rejects(fetchReplies("parent-1", async () => new Response(null, { status: 403 })), /unavailable/);
});

test("reply reads preserve parent links across pages and accept legacy roots", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => reply({
    id: `reply-${index}`,
    parent_reply_id: index === 100 ? null : `reply-${index + 1}`,
    direct_reply_count: index,
  }));
  const replies = await fetchReplies("parent-1", async url => {
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ data: rows.slice(offset, offset + 100) });
  });
  assert.deepEqual(replies, rows);
  const legacy = reply();
  delete legacy.parent_reply_id;
  delete legacy.direct_reply_count;
  assert.deepEqual(await fetchReplies("parent-1", async () => Response.json({ data: [legacy] })), [legacy]);
});

test("reply reads reject duplicate IDs, missing parents, and cycles instead of losing branches", async () => {
  for (const rows of [
    [reply(), reply()],
    [reply({ parent_reply_id: "missing" })],
    [reply({ parent_reply_id: "reply-2" }), reply({ id: "reply-2", parent_reply_id: "reply-1" })],
    [
      reply({ parent_reply_id: "reply-2" }),
      reply({ id: "reply-2", parent_reply_id: "reply-3" }),
      reply({ id: "reply-3", parent_reply_id: "reply-1" }),
    ],
  ]) {
    await assert.rejects(fetchReplies("parent-1", async () => Response.json({ data: rows })), /Invalid replies/);
  }
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

test("nested reply creation preserves the root message and exact parent reply", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const messageId = "root / post?";
  const parentReplyId = "reply / parent?";
  const saved = reply({ message_id: messageId, parent_reply_id: parentReplyId, user_id: "real-user", body: "Nested reply" });
  const result = await createReply(messageId, "  Nested reply  ", async (url, options) => {
    assert.equal(url.pathname, "/tables/replies");
    assert.deepEqual(JSON.parse(options.body), {
      message_id: messageId, body: "Nested reply", parent_reply_id: parentReplyId, user_id: "real-user",
    });
    return Response.json({ data: [saved] }, { status: 201 });
  }, { parentReplyId });
  assert.deepEqual(result, saved);
});

test("idempotent reply retries reuse the caller's key without adding it to the saved data", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const idempotencyKey = "d22c8ffc-48c8-4671-9f17-036c1e72063e";
  const saved = reply({ parent_reply_id: "parent-reply", user_id: "real-user", body: "My reply" });
  const sent = [];
  const fetcher = async (url, options) => {
    sent.push({ key: options.headers["idempotency-key"], values: JSON.parse(options.body) });
    if (sent.length === 1) throw new TypeError("Connection lost after the server saved the reply");
    return Response.json({ data: [saved] }, { status: 201 });
  };
  const options = { parentReplyId: "parent-reply", idempotencyKey };
  await assert.rejects(createReply("parent-1", "My reply", fetcher, options), /Could not confirm creation/);
  assert.equal(sent.length, 1);
  assert.deepEqual(await createReply("parent-1", "My reply", fetcher, options), saved);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].key, idempotencyKey);
  assert.deepEqual(sent[0].values, { message_id: "parent-1", body: "My reply", parent_reply_id: "parent-reply", user_id: "real-user" });
  await assert.rejects(createReply("parent-1", "Changed reply", async () => new Response(null, { status: 409 }), options), /changed during a retry/);
});

test("top-level reply creation still accepts a legacy root response", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const saved = reply({ user_id: "real-user", body: "My reply" });
  delete saved.parent_reply_id;
  delete saved.direct_reply_count;
  assert.deepEqual(await createReply("parent-1", "My reply", async () => Response.json({ data: [saved] })), saved);
});

test("invalid reply input and missing or expired sessions never send a write", async t => {
  t.after(() => storeSession(null));
  const neverFetch = () => assert.fail("must reject before sending a request");
  storeSession(session);
  for (const [parentId, body] of [
    ["", "reply"], ["  ", "reply"], ["parent", " "], ["parent", "a".repeat(2001)], [null, "reply"], ["parent", null],
  ]) await assert.rejects(createReply(parentId, body, neverFetch));
  for (const parentReplyId of ["", "  ", 12, false, {}, []]) {
    await assert.rejects(createReply("parent", "reply", neverFetch, { parentReplyId }), /valid reply/);
  }
  for (const idempotencyKey of [null, 12, "", "short", " invalid-key", "invalid/key", "x".repeat(129)]) {
    await assert.rejects(createReply("parent", "reply", neverFetch, { idempotencyKey }), /Invalid reply request/);
  }
  for (const saved of [null, { ...session, session: { ...session.session, expires_at: "2000-01-01" } }]) {
    storeSession(saved);
    await assert.rejects(createReply("parent", "reply", neverFetch), /session has expired/);
  }
});

test("reply writes report permission failures and do not retry uncertain or unconfirmed results", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  await assert.rejects(createReply("parent", "reply", async () => new Response(null, { status: 403 })), /permission to reply/);
  await assert.rejects(createReply("parent", "reply", async () => new Response(null, { status: 404 }), {
    parentReplyId: "deleted-parent",
  }), /no longer available/);
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

test("reply writes reject changed parent links and invalid direct reply counts without retrying", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  for (const parentReplyId of [null, "requested-parent"]) {
    const saved = reply({ message_id: "message", user_id: "real-user", body: "reply", parent_reply_id: parentReplyId });
    const invalidRows = [
      { ...saved, parent_reply_id: "different-parent" },
      { ...saved, parent_reply_id: 12 },
      { ...saved, direct_reply_count: -1 },
      ...(parentReplyId === null ? [] : [
        { ...saved, parent_reply_id: null },
        { ...saved, parent_reply_id: undefined },
        { ...saved, id: parentReplyId },
      ]),
    ];
    for (const row of invalidRows) {
      let calls = 0;
      await assert.rejects(createReply("message", "reply", async () => {
        calls++;
        return Response.json({ data: [row] }, { status: 201 });
      }, { parentReplyId }), /Could not confirm creation/);
      assert.equal(calls, 1);
    }
  }
});
