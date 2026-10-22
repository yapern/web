import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardPageRoutes, renderBoardMetadata } from "../vite.config.js";

const template = readFileSync(new URL("../board.html", import.meta.url), "utf8");
const logo = "/board-logos/81a1073e-95c9-4cc0-b745-afd29122d5b5.jpg";

test("Vite development and preview return dynamic metadata from their corresponding API", async t => {
  const root = await mkdtemp(join(tmpdir(), "yapern-vite-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await Promise.all([
    writeFile(join(root, "board.html"), template),
    writeFile(join(root, "dist", "board.html"), template),
  ]);
  for (const preview of [false, true]) {
    let middleware;
    let transformed = 0;
    const server = {
      config: { root, build: { outDir: "dist" } },
      middlewares: { use(handler) { middleware = handler; } },
      async transformIndexHtml(pathname, html) {
        assert.equal(pathname, "/y/test/");
        transformed++;
        return html.replace("<!-- site-header -->", "<header>Shared header</header>");
      },
    };
    const apiOrigin = preview ? "https://api.yapern.com" : "http://localhost:8787";
    let withLogo = true;
    boardPageRoutes(server, preview, async url => {
      assert.equal(url.origin, apiOrigin);
      assert.equal(url.searchParams.get("slug"), "eq.test");
      return Response.json({ data: [{ slug: "test", name: "Test Sub", description: "test123", logo_url: withLogo ? logo : null }] });
    });
    for (const hasLogo of [true, false]) {
      withLogo = hasLogo;
      let body;
      await middleware({ url: "/y/test/?page=2", method: "GET" }, {
        writeHead(status, headers) {
          assert.equal(status, 200);
          assert.equal(headers["Cache-Control"], "no-store");
        },
        end(html) { body = html; },
      }, error => { throw error || new Error("Expected a rendered board page"); });
      assert.match(body, /<title>Test Sub · Yapern<\/title>/);
      assert.match(body, /name="description" content="test123"/);
      assert.match(body, /rel="canonical" href="https:\/\/yapern.com\/y\/test"/);
      const image = hasLogo ? `${apiOrigin}${logo}` : "https://yapern.com/images/logo.png";
      for (const prefix of ['property="og:', 'name="twitter:']) {
        assert.ok(body.includes(`${prefix}image" content="${image}"`));
        assert.ok(body.includes(`${prefix}title" content="Test Sub · Yapern"`));
        assert.ok(body.includes(`${prefix}description" content="test123"`));
      }
      assert.equal(body.includes("<header>Shared header</header>"), !preview);
    }
    assert.equal(transformed, preview ? 0 : 2);
    const request = { url: "/y/test/message-id?page=2", method: "GET" };
    let continued = false;
    await middleware(request, {}, () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(request.url, "/board.html?page=2");
  }
});

test("Vite metadata escapes user text and preserves literal replacement characters", () => {
  const html = renderBoardMetadata(template, {
    title: '</title><script>alert(1)</script> $&',
    description: '" onmouseover="alert(2) & $&',
    image: "https://yapern.com/images/logo.png", imageAlt: '" test',
    url: "https://yapern.com/y/test",
  });
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; \$&amp;/);
  assert.match(html, /content="&quot; onmouseover=&quot;alert\(2\) &amp; \$&amp;"/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>|" onmouseover="/);
});
