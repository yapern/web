import assert from "node:assert/strict";
import test from "node:test";
import { readStoredSession, storeSession } from "../src/auth.js";
import { addCrawlerUrl, deleteCrawlerUrl, fetchCrawlerUrls, normalizeCrawlerUrl } from "../src/board-crawler-api.js";
import { messageBoardConfig } from "../src/config.js";

const session = {
  token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "creator", expires_at: new Date(Date.now() + 3600000).toISOString() },
  user: { id: "creator", email: "creator@example.com" },
};
const board = { id: "board /?other=1", user_id: "creator" };
const row = { id: "url /?other=2", board_id: board.id, url: "https://example.com/", created_at: "2026-11-04T00:00:00.000Z" };

test("crawler URL input accepts one full HTTP(S) URL and rejects unsupported or invalid values", () => {
  assert.equal(normalizeCrawlerUrl(" HTTPS://EXAMPLE.COM "), "https://example.com/");
  for (const input of [null, 12, "", "example.com", "https:example.com", "https:///", "javascript:alert(1)", "ftp://example.com", "https://user:password@example.com", "https://example.com/\nhttps://other.com", "https://example.com/a b", `https://example.com/${"a".repeat(2048)}`]) {
    assert.throws(() => normalizeCrawlerUrl(input), /Enter a full/);
  }
});

test("crawler URL requests scope IDs, authorize the owner, and confirm stored and deleted rows", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const fetcher = async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.mode, "cors");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(url.pathname, `/boards/${encodeURIComponent(board.id)}/crawler-urls${options.method === "DELETE" ? `/${encodeURIComponent(row.id)}` : ""}`);
    if (options.method === "POST") assert.deepEqual(JSON.parse(options.body), { url: row.url });
    else assert.equal(options.body, undefined);
    return Response.json({ data: [row] });
  };
  assert.deepEqual(await fetchCrawlerUrls(board, fetcher), [row]);
  assert.deepEqual(await addCrawlerUrl(board, " HTTPS://EXAMPLE.COM ", fetcher), row);
  await deleteCrawlerUrl(board, row.id, fetcher);
  assert.deepEqual(await fetchCrawlerUrls(board, async () => Response.json({ data: [] })), []);
});

test("invalid URLs, missing sessions, and other owners do not send requests", async t => {
  t.after(() => storeSession(null));
  const never = () => assert.fail("must not send a request");
  storeSession(session);
  await assert.rejects(addCrawlerUrl(board, "example.com", never), /Enter a full/);
  await assert.rejects(fetchCrawlerUrls({ ...board, user_id: "someone-else" }, never), /only edit/);
  await assert.rejects(fetchCrawlerUrls({}, never), /Choose a sub-yap/);
  await assert.rejects(deleteCrawlerUrl(board, "", never), /Choose a URL/);
  storeSession(null);
  await assert.rejects(fetchCrawlerUrls(board, never), /session has expired/);
});

test("crawler responses must confirm the exact board, URL, and deletion", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  for (const data of [null, [], [row, row], [{ ...row, board_id: "other" }], [{ ...row, url: "javascript:alert(1)" }], [{ ...row, url: "https://other.com/" }]]) {
    await assert.rejects(addCrawlerUrl(board, row.url, async () => Response.json({ data })), /Could not confirm/);
  }
  await assert.rejects(deleteCrawlerUrl(board, row.id, async () => Response.json({ data: [{ ...row, id: "other" }] })), /Could not confirm/);
  await assert.rejects(fetchCrawlerUrls(board, async () => new Response("not JSON")), /Could not confirm/);
});

test("crawler failures show safe errors, never retry, and clear rejected sessions", async t => {
  t.after(() => storeSession(null));
  for (const [status, pattern] of [[400, /valid http/], [401, /session has expired/], [403, /permission/], [404, /no longer available/], [409, /already in the list/], [500, /unavailable/]]) {
    storeSession(session);
    let calls = 0;
    await assert.rejects(addCrawlerUrl(board, row.url, async () => {
      calls++;
      return Response.json({ error: "private SQL details" }, { status });
    }), pattern);
    assert.equal(calls, 1);
    assert.deepEqual(readStoredSession(), status === 401 ? null : session);
  }
  await assert.rejects(fetchCrawlerUrls(board, async () => { throw new TypeError("network"); }), /Check your connection/);
});
