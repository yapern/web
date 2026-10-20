import assert from "node:assert/strict";
import test from "node:test";
import { fetchSearch, readSearchOptions, searchHref } from "../src/search-api.js";

const row = {
  type: "message", id: "post-1", title: "SQLite indexes", snippet: "A useful database guide.",
  created_at: "2026-10-20T00:00:00.000Z", board_id: "general", board_slug: "general", board_name: "General",
  author_id: "author", author_name: "Taylor",
};
const payload = { data: [row], meta: { has_more: false, limit: 20, offset: 0 } };

test("search links round trip Unicode text, scope, sort, type and page", () => {
  const options = { q: "Café & SQLite", type: "boards", board: "general", sort: "newest", page: 3 };
  const href = searchHref(options);
  assert.ok(href.startsWith("/search/?q="));
  assert.deepEqual(readSearchOptions(new URL(href, "https://yapern.com").searchParams), options);
  assert.deepEqual(readSearchOptions(new URLSearchParams()), { q: "", type: "messages", board: "", sort: "relevance", page: 1 });
  assert.equal(searchHref(), "/search/");
  assert.equal(searchHref({ q: "word" }), "/search/?q=word");
  assert.equal(readSearchOptions(new URLSearchParams({ q: "  SQLite  " })).q, "SQLite");
});

test("invalid search links cannot generate unbounded or malformed requests", () => {
  for (const value of ["q=x&q=y", "type=users", "sort=random", "board=../x", "page=0", "page=-1", "page=52", "page=1.5", "page=01",
    new URLSearchParams({ q: "a".repeat(201) }).toString(), new URLSearchParams({ q: Array(21).fill("a").join(" ") }).toString()]) {
    assert.throws(() => readSearchOptions(new URLSearchParams(value)), Error, value);
  }
});

test("search requests use public CORS reads and bounded pagination", async () => {
  const actual = await fetchSearch({ q: "sqlite", board: "general", page: 2 }, async (url, options) => {
    assert.equal(url.origin, "https://api.yapern.com");
    assert.equal(url.pathname, "/search");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      q: "sqlite", type: "messages", sort: "relevance", limit: "20", offset: "20", board: "general",
    });
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers, undefined);
    return Response.json({ ...payload, meta: { ...payload.meta, offset: 20 } });
  });
  assert.deepEqual(actual.data, [row]);
});

test("empty queries skip the network and board results have their own schema", async () => {
  assert.deepEqual((await fetchSearch({ q: "  " }, () => assert.fail("unexpected request"))).data, []);
  const board = { type: "board", id: "general", slug: "general", name: "General", snippet: "A board", created_at: row.created_at };
  assert.deepEqual((await fetchSearch({ q: "general", type: "boards" }, async () => Response.json({ ...payload, data: [board] }))).data, [board]);
});

test("malformed search responses and mismatched scopes never render as results", async () => {
  for (const invalid of [null, {}, { ...payload, data: Array(21).fill(row) }, { ...payload, data: [row, row] },
    { ...payload, data: [{ ...row, created_at: "invalid" }] }, { ...payload, data: [{ ...row, board_slug: "../outside" }] },
    { ...payload, data: [{ ...row, type: "board" }] }, { ...payload, meta: { ...payload.meta, has_more: "yes" } },
    { ...payload, meta: { ...payload.meta, offset: 20 } }, { ...payload, data: [{ ...row, author_name: null }] }]) {
    await assert.rejects(fetchSearch({ q: "sqlite" }, async () => Response.json(invalid)), /invalid results/);
  }
  await assert.rejects(fetchSearch({ q: "sqlite", board: "other" }, async () => Response.json(payload)), /invalid results/);
});

test("network and response failures produce human readable retry messages", async () => {
  await assert.rejects(fetchSearch({ q: "sqlite" }, async () => { throw new TypeError("Failed to fetch"); }), /unavailable/);
  await assert.rejects(fetchSearch({ q: "sqlite" }, async () => new Response(null, { status: 503 })), /unavailable/);
  await assert.rejects(fetchSearch({ q: "sqlite" }, async () => new Response(null, { status: 400 })), /invalid/);
  await assert.rejects(fetchSearch({ q: "sqlite" }, async () => new Response("broken json")), /invalid results/);
});
