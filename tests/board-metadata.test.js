import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { fetchBoardMetadata } from "../worker.js";

const logo = "/board-logos/123e4567-e89b-12d3-a456-426614174000.webp";
const board = { slug: "cats", name: "Cat People", description: "Talk about cats.", logo_url: logo };
const mainLogo = "https://yapern.com/images/logo.png";

test("social metadata reads only the requested public board and resolves its logo", async () => {
  const metadata = await fetchBoardMetadata("cats", { fetcher: async (url, options) => {
    assert.equal(url.origin, "https://api.yapern.com");
    assert.equal(url.pathname, "/tables/boards");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      select: "slug,name,description,logo_url", slug: "eq.cats", limit: "1",
    });
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: [board] });
  } });
  assert.deepEqual(metadata, {
    title: "Cat People · Yapern", description: board.description,
    url: "https://yapern.com/y/cats", image: `https://api.yapern.com${logo}`, imageAlt: "Cat People logo",
  });
});

test("missing or unsafe logos use the homepage logo without losing the board's text", async () => {
  for (const logo_url of [undefined, null, "", "https://elsewhere.example/logo.png", "/board-logos/../private.png"]) {
    const metadata = await fetchBoardMetadata("cats", { fetcher: async () => Response.json({ data: [{ ...board, logo_url }] }) });
    assert.equal(metadata.title, "Cat People · Yapern");
    assert.equal(metadata.description, board.description);
    assert.equal(metadata.image, mainLogo);
    assert.equal(metadata.imageAlt, "Yapern logo");
  }
});

test("unavailable, missing, mismatched, or malformed boards keep safe route-specific fallback metadata", async () => {
  const responses = [
    () => { throw new Error("Network error"); },
    () => Response.json({ error: "Internal details" }, { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }),
    () => new Response("Invalid JSON"),
    ...[null, {}, { data: [] }, { data: [board, board] }, { data: [{ ...board, slug: "dogs" }] },
      { data: [{ ...board, description: null }] }].map(result => () => Response.json(result)),
  ];
  for (const fetcher of responses) {
    const metadata = await fetchBoardMetadata("cats", { fetcher });
    assert.equal(metadata.title, "y/cats · Yapern");
    assert.equal(metadata.description, "Messages in y/cats on Yapern.");
    assert.equal(metadata.url, "https://yapern.com/y/cats");
    assert.equal(metadata.image, mainLogo);
  }
});

test("public metadata is cached by board for 60 seconds and failures are not cached", async () => {
  const entries = new Map();
  const cache = {
    async match(url) { return entries.get(String(url))?.clone(); },
    async put(url, response) {
      assert.equal(response.headers.get("cache-control"), "public, max-age=60");
      entries.set(String(url), response.clone());
    },
  };
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ data: [board] }); };
  const first = await fetchBoardMetadata("cats", { fetcher, cache });
  assert.deepEqual(await fetchBoardMetadata("cats", { fetcher, cache }), first);
  assert.equal(calls, 1);
  await fetchBoardMetadata("dogs", { fetcher, cache });
  await fetchBoardMetadata("dogs", { fetcher, cache });
  assert.equal(calls, 3);
  assert.equal(entries.size, 1);
});

test("Worker returns crawler-ready HTML using Cloudflare's real HTMLRewriter", { timeout: 60_000 }, async t => {
  const assets = await mkdtemp(join(tmpdir(), "yapern-metadata-"));
  let worker;
  let api;
  t.after(async () => {
    await worker?.dispose();
    if (api?.listening) await new Promise(resolve => api.close(resolve));
    await rm(assets, { recursive: true, force: true });
  });
  await Promise.all([
    copyFile(new URL("../board.html", import.meta.url), join(assets, "board.html")),
    copyFile(new URL("../public/_redirects", import.meta.url), join(assets, "_redirects")),
    writeFile(join(assets, "index.html"), "<!doctype html><title>Static homepage</title>"),
  ]);
  const apiCalls = new Map();
  api = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const slug = url.searchParams.get("slug")?.slice(3);
    apiCalls.set(slug, (apiCalls.get(slug) || 0) + 1);
    if (slug === "unavailable") { response.writeHead(503); response.end(); return; }
    const data = slug === "unsafe" ? { ...board, slug, name: '</title><script>alert(1)</script>', description: '" onmouseover="alert(2)' }
      : { ...board, slug, logo_url: slug === "no-logo" ? null : logo };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [data] }));
  });
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    assets,
    bindings: { API_ORIGIN: { type: "plain_text", value: apiOrigin } },
    dev: { watch: false, persist: false, remote: false, server: { hostname: "127.0.0.1", port: 0 } },
  });
  await worker.ready;
  const fetchPage = (pathname, options) => worker.fetch(new URL(pathname, "https://yapern.com"), options);

  for (const pathname of ["/y/cats", "/y/cats/"]) {
    const response = await fetchPage(`${pathname}?page=2`, {
      headers: { "if-none-match": '"shell-etag"', range: "bytes=0-10", "user-agent": "Twitterbot/1.0" },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(html, /<title>Cat People · Yapern<\/title>/);
    assert.match(html, /rel="canonical" href="https:\/\/yapern.com\/y\/cats"/);
    for (const prefix of ['property="og:', 'name="twitter:']) {
      assert.ok(html.includes(`${prefix}title" content="Cat People · Yapern"`));
      assert.ok(html.includes(`${prefix}description" content="Talk about cats."`));
      assert.ok(html.includes(`${prefix}url" content="https://yapern.com/y/cats"`));
      assert.ok(html.includes(`${prefix}image" content="${apiOrigin}${logo}"`));
      assert.ok(html.includes(`${prefix}image:alt" content="Cat People logo"`));
    }
    assert.match(html, /name="description" content="Talk about cats\."/);
    assert.match(html, /name="twitter:card" content="summary"/);
  }
  assert.equal(apiCalls.get("cats"), 1);
  for (const slug of ["no-logo", "unavailable"]) {
    const html = await (await fetchPage(`/y/${slug}`)).text();
    assert.ok(html.includes(`property="og:image" content="${mainLogo}"`));
    assert.ok(html.includes(`name="twitter:image" content="${mainLogo}"`));
  }
  const unsafe = await (await fetchPage("/y/unsafe")).text();
  assert.match(unsafe, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; · Yapern<\/title>/);
  assert.doesNotMatch(unsafe, /" onmouseover="alert\(2\)/);
  const head = await fetchPage("/y/cats", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const message = await (await fetchPage("/y/cats/message-id")).text();
  assert.match(message, /<title>Sub-yap · Yapern<\/title>/);
  assert.doesNotMatch(message, /rel="canonical"/);
  assert.equal(await (await fetchPage("/")).text(), "<!doctype html><title>Static homepage</title>");
});
