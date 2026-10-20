import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationsApi, isNotificationSnapshot } from "../src/notifications-api.js";

const session = { token: "token-one", user: { id: "user-one" } };
const item = {
  id: 3, reply_id: "reply-3", message_id: "message-1", board_slug: "general",
  message_title: "A post", actor_name: "Taylor", created_at: "2026-10-19T12:00:00.000Z", read_at: null,
};
const snapshot = { type: "notifications", version: 4, unread_count: 1, last_id: 3, notifications: [item] };

test("validates notification snapshots and rejects malformed entries", () => {
  assert.equal(isNotificationSnapshot(snapshot), true);
  assert.equal(isNotificationSnapshot({ ...snapshot, unread_count: -1 }), false);
  assert.equal(isNotificationSnapshot({ ...snapshot, notifications: [{ ...item, board_slug: "../general" }] }), false);
  assert.equal(isNotificationSnapshot({ ...snapshot, notifications: [{ ...item, read_at: "not a date" }] }), false);
});

test("reads snapshots, marks a cutoff read, and requests a short lived socket ticket", async () => {
  const calls = [];
  const api = createNotificationsApi({
    apiOrigin: "https://api.example.test",
    getSession: () => session,
    fetcher: async (url, options) => {
      calls.push({ url: String(url), options });
      const payload = String(url).endsWith("/ticket") ? { ticket: "a".repeat(64), user_id: "user-one" } : snapshot;
      return Response.json(payload);
    },
  });
  assert.deepEqual(await api.snapshot(), snapshot);
  assert.deepEqual(await api.markRead(3), snapshot);
  assert.equal((await api.ticket()), "a".repeat(64));
  assert.deepEqual(calls.map(call => [new URL(call.url).pathname, call.options.method]), [
    ["/notifications", "GET"], ["/notifications/read", "POST"], ["/notifications/ticket", "POST"],
  ]);
  assert.equal(calls[1].options.body, JSON.stringify({ through_id: 3 }));
  assert.equal(calls[1].options.headers.authorization, "Bearer token-one");
  assert.equal(new URL(api.socketUrl("user one", "a".repeat(64))).href,
    "wss://api.example.test/notifications/socket?user_id=user+one&ticket=" + "a".repeat(64));
});

test("a 401 clears only the session that made the request", async () => {
  let cleared = false;
  const api = createNotificationsApi({
    apiOrigin: "https://api.example.test", getSession: () => ({ token: "switched-token", user: { id: "other" } }),
    clearSession: () => { cleared = true; }, fetcher: async () => new Response(null, { status: 401 }),
  });
  await assert.rejects(api.snapshot(session), { status: 401 });
  assert.equal(cleared, false);
});

test("rejects ticket payloads for another user", async () => {
  const api = createNotificationsApi({
    apiOrigin: "https://api.example.test", getSession: () => session,
    fetcher: async () => Response.json({ ticket: "a".repeat(64), user_id: "other" }),
  });
  await assert.rejects(api.ticket(), /live notifications/);
});
