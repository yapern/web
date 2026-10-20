import assert from "node:assert/strict";
import test from "node:test";
import { createVotesApi, nextVote } from "../src/votes-api.js";
import { storeSession } from "../src/auth.js";

const session = {
  token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "real-user", expires_at: new Date(Date.now() + 3600000).toISOString() },
  user: { id: "real-user", email: "person@example.com" },
};

test("vote reads batch message and reply IDs and validate only requested rows", async () => {
  const api = createVotesApi({ apiOrigin: "https://api.example.test", getSession: () => session,
    fetcher: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/votes");
      assert.equal(parsed.searchParams.get("message_ids"), "message-1,message-2");
      assert.equal(parsed.searchParams.get("reply_ids"), "reply-1");
      assert.equal(options.headers.authorization, `Bearer ${session.token}`);
      assert.equal(options.credentials, "omit");
      return Response.json({ data: [
        { id: "message-1", type: "message", score: 1, user_vote: 1 },
        { id: "reply-1", type: "reply", score: -2, user_vote: 0 },
      ] });
    } });
  assert.deepEqual(await api.fetchVotes([
    { type: "message", id: "message-1" }, { type: "message", id: "message-2" }, { type: "reply", id: "reply-1" },
  ]), [
    { id: "message-1", type: "message", score: 1, user_vote: 1 },
    { id: "reply-1", type: "reply", score: -2, user_vote: 0 },
  ]);
});

test("vote reads reject invalid targets, excessive counts, duplicate and malformed rows", async () => {
  const neverFetch = () => assert.fail("must reject before requesting");
  const api = createVotesApi({ apiOrigin: "https://api.example.test", fetcher: neverFetch });
  for (const targets of [null, [{ type: "other", id: "x" }], [{ type: "reply", id: "x,y" }],
    [{ type: "message", id: "duplicate" }, { type: "message", id: "duplicate" }],
    Array.from({ length: 101 }, (_, id) => ({ type: "message", id: `message-${id}` }))]) {
    await assert.rejects(api.fetchVotes(targets));
  }
  const target = [{ type: "message", id: "message-1" }];
  for (const data of [null, [{ id: "message-1", type: "message", score: 1.2, user_vote: 0 }],
    [{ id: "elsewhere", type: "message", score: 1, user_vote: 0 }],
    [{ id: "message-1", type: "message", score: 1, user_vote: 0 }, { id: "message-1", type: "message", score: 1, user_vote: 0 }]]) {
    const invalidApi = createVotesApi({ apiOrigin: "https://api.example.test", fetcher: async () => Response.json({ data }) });
    await assert.rejects(invalidApi.fetchVotes(target), /invalid response/);
  }
});

test("vote writes send one target and accept only its confirmed contribution", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const api = createVotesApi({ apiOrigin: "https://api.example.test", fetcher: async (url, options) => {
    assert.equal(new URL(url).pathname, "/votes");
    assert.equal(options.method, "PUT");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.deepEqual(JSON.parse(options.body), { reply_id: "reply-1", value: -1 });
    return Response.json({ data: [{ id: "reply-1", type: "reply", score: 0, user_vote: -1 }] });
  } });
  assert.deepEqual(await api.setVote({ type: "reply", id: "reply-1" }, -1),
    { id: "reply-1", type: "reply", score: 0, user_vote: -1 });
  await assert.rejects(api.setVote({ type: "message", id: "message-1" }, 2), /valid vote/);
  const invalidApi = createVotesApi({ apiOrigin: "https://api.example.test", fetcher: async () =>
    Response.json({ data: [{ id: "reply-1", type: "reply", score: 0, user_vote: 0 }] }) });
  await assert.rejects(invalidApi.setVote({ type: "reply", id: "reply-1" }, 1), /confirm your vote/);
});

test("only an upvote/downvote click changes a contribution one step within its cap", () => {
  assert.deepEqual([
    nextVote(0, 1), nextVote(1, 1), nextVote(1, -1), nextVote(0, -1), nextVote(-1, -1), nextVote(-1, 1),
  ], [1, 1, 0, -1, -1, 0]);
});

test("expired vote requests clear only the session that made the request and report invalid transitions", async () => {
  let cleared = false;
  const switchedSession = { ...session, token: "other-token", user: { ...session.user, id: "other-user" } };
  let currentSession = session;
  const switchedApi = createVotesApi({ apiOrigin: "https://api.example.test", getSession: () => currentSession,
    clearSession: () => { cleared = true; }, fetcher: async () => {
      currentSession = switchedSession;
      return new Response(null, { status: 401 });
    } });
  await assert.rejects(switchedApi.setVote({ type: "message", id: "message-1" }, 1), { status: 401 });
  assert.equal(cleared, false);
  storeSession(session);
  const conflictApi = createVotesApi({ apiOrigin: "https://api.example.test", fetcher: async () =>
    Response.json({ error: "invalid_vote_transition" }, { status: 409 }) });
  await assert.rejects(conflictApi.setVote({ type: "message", id: "message-1" }, -1), /could not be changed/);
  storeSession(null);
});
