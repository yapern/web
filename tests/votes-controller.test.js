import assert from "node:assert/strict";
import test from "node:test";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
    this.isConnected = true;
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.parentElement = null;
  }
  append(...children) {
    for (const child of children) {
      child.remove?.();
      child.parentElement = this;
      child.setConnected?.(this.isConnected);
      this.children.push(child);
    }
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
    this.setConnected(false);
  }
  setConnected(connected) {
    this.isConnected = connected;
    for (const child of this.children) child.setConnected?.(connected);
  }
  matches(selector) { return selector.startsWith(".") && this.className.split(/\s+/).includes(selector.slice(1)); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) ?? []),
    ]);
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === "[hidden]" && node.hidden) return node;
    }
    return null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { if (!this.disabled) this.listeners.get("click")?.(); }
  find(className) {
    if (this.className.split(/\s+/).includes(className)) return this;
    for (const child of this.children) {
      const found = child.find?.(className);
      if (found) return found;
    }
    return null;
  }
}

const windowListeners = new Map();
globalThis.window = {
  addEventListener(name, listener) {
    const listeners = windowListeners.get(name) ?? [];
    listeners.push(listener);
    windowListeners.set(name, listeners);
  },
};
globalThis.document = {
  createElement: name => new FakeElement(name),
  createElementNS: (_namespace, name) => new FakeElement(name),
};
const { createVoteControl, syncVoteControls } = await import("../src/votes.js");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function disconnectAfter(t, control, container = new FakeElement("section")) {
  t.after(() => { control.remove(); syncVoteControls(container); });
}

test("vote controls update confirmed contribution, enforce button caps, and undo toward zero", async t => {
  const session = { token: "test-token", user: { id: "voter" } };
  let row = { id: "message-1", type: "message", score: 1, user_vote: 1 };
  const writes = [];
  const control = createVoteControl({ type: "message", id: row.id }, {
    initialRow: row,
    getSession: () => session,
    api: { setVote: async (_target, value) => {
      writes.push(value);
      row = { ...row, score: row.score + value - row.user_vote, user_vote: value };
      return row;
    } },
  });
  disconnectAfter(t, control);
  const up = control.find("live-message-vote-button");
  const down = control.children[0].children[2];
  const count = control.find("live-message-vote-count");
  assert.equal(up.disabled, true, "the seeded author vote cannot be increased again");
  assert.equal(count.textContent, "1");

  down.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(row.score, 0, "one downvote removes the seeded contribution");
  assert.equal(row.user_vote, 0);
  assert.equal(count.textContent, "0");

  up.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(row.score, 1);
  up.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writes.length, 2, "repeated upvotes at the cap do not send another write");

  down.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  down.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(row.user_vote, -1);
  assert.equal(row.score, -1);
  assert.equal(down.disabled, true, "downvote is disabled at the negative cap");
  up.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(row.user_vote, 0, "the opposite arrow first returns the contribution to zero");
  assert.deepEqual(writes, [0, 1, 0, -1, 0]);
});

test("cached controls resume after an interrupted read and ignore its stale response without refetching on every sync", async t => {
  const container = new FakeElement("section");
  const firstRead = deferred();
  const row = { id: "reply-read", type: "reply", score: 9, user_vote: 0 };
  let reads = 0;
  const control = createVoteControl({ type: "reply", id: row.id }, {
    getSession: () => null,
    api: {
      fetchVotes: async () => ++reads === 1 ? firstRead.promise : [row],
      setVote: async () => assert.fail("a read-only control should not write"),
    },
  });
  disconnectAfter(t, control, container);
  container.append(control);
  syncVoteControls(container);
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 1);

  control.remove();
  syncVoteControls(container);
  assert.equal(control.children[0].getAttribute("aria-busy"), "false");
  container.append(control);
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 2);
  assert.equal(control.find("live-message-vote-count").textContent, "9");
  firstRead.resolve([{ ...row, score: 1 }]);
  await tick();
  assert.equal(control.find("live-message-vote-count").textContent, "9", "the old detached generation cannot overwrite the resumed read");
  syncVoteControls(container);
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 2, "sync preserves still-visible vote state and does not issue another read");
});

test("a control reopened during a pending save waits for the write before reading its confirmed vote", async t => {
  const container = new FakeElement("section");
  const save = deferred();
  const session = { token: "save-token", user: { id: "save-voter" } };
  let row = { id: "reply-save", type: "reply", score: 4, user_vote: 0 };
  let reads = 0;
  const control = createVoteControl({ type: "reply", id: row.id }, {
    initialRow: row, getSession: () => session,
    api: { fetchVotes: async () => { reads++; return [row]; }, setVote: () => save.promise },
  });
  disconnectAfter(t, control, container);
  container.append(control);
  syncVoteControls(container);
  control.find("live-message-vote-button").click();
  assert.equal(control.children[0].getAttribute("aria-busy"), "true");
  control.remove();
  syncVoteControls(container);
  assert.equal(control.children[0].getAttribute("aria-busy"), "false", "hidden controls do not stay stuck in a save state");
  container.append(control);
  syncVoteControls(container);
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 0, "a read before the pending write commits could return the previous contribution");
  assert.equal(control.children[0].getAttribute("aria-busy"), "true");
  row = { ...row, score: 5, user_vote: 1 };
  save.resolve(row);
  await tick();
  assert.equal(reads, 1);
  assert.equal(control.children[0].getAttribute("aria-busy"), "false");
  assert.equal(control.find("live-message-vote-count").textContent, "5");
  assert.equal(control.find("live-message-vote-button").getAttribute("aria-pressed"), "true");
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 1);
});

test("a failed save while hidden can be resumed and an ancestor's hidden state pauses cached controls", async t => {
  const container = new FakeElement("section");
  const content = new FakeElement("div");
  container.append(content);
  const save = deferred();
  const session = { token: "failed-token", user: { id: "failed-voter" } };
  const row = { id: "reply-failed", type: "reply", score: 3, user_vote: 0 };
  let reads = 0;
  const control = createVoteControl({ type: "reply", id: row.id }, {
    initialRow: row, getSession: () => session,
    api: { fetchVotes: async () => { reads++; return [row]; }, setVote: () => save.promise },
  });
  disconnectAfter(t, control, container);
  content.append(control);
  syncVoteControls(container);
  control.find("live-message-vote-button").click();
  content.hidden = true;
  syncVoteControls(container);
  assert.equal(control.isConnected, true, "a collapsed parent can keep its vote control connected");
  assert.equal(control.children[0].getAttribute("aria-busy"), "false");
  save.reject(new Error("Connection interrupted"));
  await tick();
  assert.equal(reads, 0);
  content.hidden = false;
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 1);
  assert.equal(control.children[0].getAttribute("aria-busy"), "false");
  assert.equal(control.find("live-message-vote-count").textContent, "3");
});

test("session changes refresh connected controls and cached controls pruned while hidden resume for the new account", async t => {
  const container = new FakeElement("section");
  const content = new FakeElement("div");
  container.append(content);
  let session = { token: "first-token", user: { id: "first-voter" } };
  let row = { id: "reply-session", type: "reply", score: 7, user_vote: 1 };
  let reads = 0;
  const control = createVoteControl({ type: "reply", id: row.id }, {
    initialRow: row, getSession: () => session,
    api: { fetchVotes: async () => { reads++; return [row]; }, setVote: async () => row },
  });
  disconnectAfter(t, control, container);
  content.append(control);
  syncVoteControls(container);
  for (const listener of windowListeners.get("storage")) listener();
  await tick();
  assert.equal(reads, 1, "connected controls still refresh on account events");
  content.hidden = true;
  for (const listener of windowListeners.get("storage")) listener();
  session = { token: "second-token", user: { id: "second-voter" } };
  row = { ...row, user_vote: -1 };
  for (const listener of windowListeners.get("storage")) listener();
  await tick();
  assert.equal(reads, 1, "hidden controls are removed from active refreshes");
  content.hidden = false;
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 2);
  assert.equal(control.children[0].children[2].getAttribute("aria-pressed"), "true");
  assert.equal(control.find("live-message-vote-button").getAttribute("aria-pressed"), "false");
  session = null;
  row = { ...row, user_vote: 0 };
  syncVoteControls(container);
  await tick();
  assert.equal(reads, 3, "sync also detects a session change when an account event was missed");
});
