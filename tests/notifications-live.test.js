import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationsLive } from "../src/notifications-live.js";
import { isNotificationSnapshot } from "../src/notifications-api.js";

const session = { token: "token-one", user: { id: "user-one" } };
const reply = {
  id: 3, reply_id: "reply-3", message_id: "message-1", board_slug: "general", message_title: "A post",
  actor_name: "Taylor", created_at: "2026-10-19T12:00:00.000Z", read_at: null,
};
const snapshot = { type: "notifications", version: 4, unread_count: 1, last_id: 3, notifications: [reply] };

class FakeSocket {
  static opened = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeSocket.opened.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
  serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  send(value) { this.lastSent = value; }
}

test("loads persisted unread state, then applies validated live snapshots", async () => {
  FakeSocket.opened = [];
  const received = [];
  let reads = 0;
  const client = createNotificationsLive({
    getSession: () => session,
    api: {
      snapshot: async () => { reads++; return snapshot; },
      ticket: async () => "a".repeat(64),
      socketUrl: (userId, ticket) => `wss://api.example.test/notifications/socket?user_id=${userId}&ticket=${ticket}`,
      isSnapshot: () => true,
    },
    WebSocketImpl: FakeSocket,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  client.subscribe(state => received.push(state));
  client.start(session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(client.getState().snapshot.unread_count, 1);
  assert.equal(FakeSocket.opened.length, 1);
  assert.match(FakeSocket.opened[0].url, /ticket=a{64}$/);
  FakeSocket.opened[0].open();
  FakeSocket.opened[0].message({ ...snapshot, version: 5, unread_count: 2 });
  FakeSocket.opened[0].message({ ...snapshot, version: 6, unread_count: -1 });
  assert.equal(client.getState().snapshot.version, 5);
  assert.equal(client.getState().snapshot.unread_count, 2);
  assert.ok(received.length >= 3);
  client.stop();
});

test("a 4001 close revalidates the session and clears private state when it was revoked", async () => {
  FakeSocket.opened = [];
  let currentSession = session;
  let snapshotReads = 0;
  const timers = new Map();
  let timerId = 0;
  const client = createNotificationsLive({
    getSession: () => currentSession,
    api: {
      snapshot: async () => {
        snapshotReads++;
        if (snapshotReads > 1) {
          currentSession = null;
          throw Object.assign(new Error("Unauthorized"), { status: 401 });
        }
        return snapshot;
      },
      ticket: async () => "a".repeat(64), socketUrl: () => "wss://api.example.test/socket",
    },
    WebSocketImpl: FakeSocket,
    setTimer: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id),
  });
  client.start(session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState().snapshot.unread_count, 1);
  FakeSocket.opened[0].serverClose(4001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshotReads, 2);
  assert.equal(client.getState().session, null);
  assert.equal(client.getState().snapshot, null);
  assert.equal(timers.size, 0);
  client.stop();
});

test("a dead heartbeat retires a socket without waiting for its close handshake", async () => {
  FakeSocket.opened = [];
  const timers = new Map();
  let timerId = 0;
  let now = 100;
  const client = createNotificationsLive({
    getSession: () => session,
    api: { snapshot: async () => snapshot, ticket: async () => "a".repeat(64), socketUrl: () => "wss://api.example.test/socket" },
    WebSocketImpl: FakeSocket,
    now: () => now,
    random: () => 1,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  client.start(session);
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeSocket.opened[0];
  socket.open();
  const heartbeat = [...timers.values()].find(timer => timer.delay === 25_000);
  assert.ok(heartbeat);
  now = 60_000;
  heartbeat.callback();
  assert.equal(socket.readyState, 3);
  assert.equal(socket.onclose, null);
  assert.equal([...timers.values()].some(timer => timer.delay === 1250), true);
  client.stop();
});

test("a WebSocket error detaches the failed socket and schedules a bounded reconnect", async () => {
  FakeSocket.opened = [];
  const timers = new Map();
  let timerId = 0;
  const client = createNotificationsLive({
    getSession: () => session,
    api: { snapshot: async () => snapshot, ticket: async () => "a".repeat(64), socketUrl: () => "wss://api.example.test/socket" },
    WebSocketImpl: FakeSocket,
    random: () => 1,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  client.start(session);
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeSocket.opened[0];
  socket.onerror();
  assert.equal(socket.readyState, 3);
  assert.equal(socket.onclose, null);
  assert.equal([...timers.values()].some(timer => timer.delay === 1250), true);
  assert.ok([...timers.values()].every(timer => timer.delay <= 30_000));
  client.stop();
});

test("ignores late snapshots from an earlier session generation", async () => {
  let releaseSnapshot;
  const nextSession = { token: "token-two", user: { id: "user-two" } };
  const client = createNotificationsLive({
    getSession: () => nextSession,
    api: {
      snapshot: current => current === session ? new Promise(resolve => { releaseSnapshot = resolve; }) : Promise.resolve({ ...snapshot, version: 8 }),
      ticket: async () => "b".repeat(64), socketUrl: () => "wss://api.example.test/socket", isSnapshot: isNotificationSnapshot,
    },
    WebSocketImpl: FakeSocket,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  client.start(session);
  client.syncSession(nextSession);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState().session.user.id, "user-two");
  assert.equal(client.getState().snapshot.version, 8);
  releaseSnapshot(snapshot);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState().snapshot.version, 8);
  client.stop();
});
