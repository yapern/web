import assert from "node:assert/strict";
import test from "node:test";
import { readStoredSession, storeSession } from "../src/auth.js";
import { deleteMessage } from "../src/messages-api.js";
import { messageBoardConfig } from "../src/config.js";

const session = {
  token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "real-user", expires_at: new Date(Date.now() + 3600000).toISOString() },
  user: { id: "real-user", email: "person@example.com" },
};
const message = { id: "older / post?&id=eq.other", board_id: "general", user_id: "real-user" };

test("deletion targets the exact message, board, and authenticated author using the production API", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  let calls = 0;
  await deleteMessage(message, async (url, options) => {
    calls++;
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.pathname, `/tables/messages`);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      id: `eq.${message.id}`, board_id: "eq.general", user_id: "eq.real-user",
    });
    assert.equal(options.method, "DELETE");
    assert.deepEqual(options.headers, { authorization: `Bearer ${session.token}` });
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return Response.json({ data: [], meta: { changes: 1 } });
  });
  assert.equal(calls, 1);
});

test("invalid identifiers, missing sessions, and other authors never send a deletion request", async t => {
  t.after(() => storeSession(null));
  const neverFetch = () => assert.fail("must reject before sending a request");
  storeSession(session);
  for (const input of [null, {}, ...["id", "board_id", "user_id"].flatMap(key =>
    ["", "  ", null, 12].map(value => ({ ...message, [key]: value })))]) {
    await assert.rejects(deleteMessage(input, neverFetch), /Choose a message/);
  }
  await assert.rejects(deleteMessage({ ...message, user_id: "someone-else" }, neverFetch), /only delete your own/);
  for (const saved of [null, { ...session, session: { ...session.session, expires_at: "2000-01-01" } }]) {
    storeSession(saved);
    await assert.rejects(deleteMessage(message, neverFetch), /session has expired/);
  }
});

test("a successful response must confirm exactly one deletion before navigation is allowed", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  for (const payload of [
    {}, { data: [] }, { data: [], meta: { changes: 0 } }, { data: [], meta: { changes: 2 } },
    { data: [], meta: { changes: "1" } }, { data: [message], meta: { changes: 1 } },
    { meta: { changes: 1 } },
  ]) {
    await assert.rejects(deleteMessage(message, async () => Response.json(payload)), /Could not confirm deletion/);
  }
  await assert.rejects(deleteMessage(message, async () => new Response("invalid JSON")), /Could not confirm deletion/);
});

test("deletion errors stay human readable, and a rejected session is cleared", async t => {
  t.after(() => storeSession(null));
  for (const [status, pattern] of [[401, /session has expired/], [403, /permission to delete/], [500, /Could not delete/]]) {
    storeSession(session);
    let calls = 0;
    await assert.rejects(deleteMessage(message, async () => {
      calls++;
      return Response.json({ error: "private SQL details" }, { status });
    }), pattern);
    assert.equal(calls, 1);
    if (status === 401) assert.equal(readStoredSession(), null);
  }
});

test("network failures and timeouts do not retry an uncertain deletion", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  for (const cause of [new TypeError("network failure"), new DOMException("timeout", "TimeoutError")]) {
    let calls = 0;
    await assert.rejects(deleteMessage(message, async () => {
      calls++;
      throw cause;
    }), /Could not confirm deletion.*reload the page/);
    assert.equal(calls, 1);
  }
});
