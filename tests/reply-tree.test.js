import assert from "node:assert/strict";
import test from "node:test";
import { mergeReplyIds } from "../src/reply-tree.js";

test("new replies merge once in chronological order with stable ID tie breaks", () => {
  const replies = new Map([
    ["older", { created_at: "2026-10-20T12:00:00.000Z" }],
    ["new-a", { created_at: "2026-10-21T12:00:00.000Z" }],
    ["new-b", { created_at: "2026-10-21T12:00:00.000Z" }],
    ["newest", { created_at: "2026-10-21T12:01:00.000Z" }],
  ]);
  const loaded = ["new-a", "older"];
  const incoming = ["newest", "new-b", "new-a"];
  assert.deepEqual(mergeReplyIds(loaded, incoming, replies, "new"), ["newest", "new-b", "new-a", "older"]);
  assert.deepEqual(loaded, ["new-a", "older"]);
  assert.deepEqual(incoming, ["newest", "new-b", "new-a"]);
});

test("posting in Top keeps the visible ranking and shows the confirmed reply once", () => {
  const loaded = ["highest-ranked", "second-ranked", "previous-post"];
  assert.deepEqual(mergeReplyIds(loaded, ["just-posted"], new Map(), "top"),
    ["just-posted", "highest-ranked", "second-ranked", "previous-post"]);
  assert.deepEqual(mergeReplyIds(loaded, ["previous-post"], new Map(), "top"),
    ["previous-post", "highest-ranked", "second-ranked"]);
  assert.deepEqual(loaded, ["highest-ranked", "second-ranked", "previous-post"]);
});
