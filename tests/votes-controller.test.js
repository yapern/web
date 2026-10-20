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
  }
  append(...children) { this.children.push(...children); }
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

test("vote controls update confirmed contribution, enforce button caps, and undo toward zero", async () => {
  globalThis.window = { addEventListener() {} };
  globalThis.document = {
    createElement: name => new FakeElement(name),
    createElementNS: (_namespace, name) => new FakeElement(name),
  };
  const { createVoteControl } = await import("../src/votes.js");
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
