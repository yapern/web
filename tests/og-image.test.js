import assert from "node:assert/strict";
import test from "node:test";
import { fetchOgImage } from "../src/messages-api.js";
import { readStoredSession, storeSession } from "../src/auth.js";
import { messageBoardConfig } from "../src/config.js";

const session = {
  token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "real-user", expires_at: new Date(Date.now() + 3600000).toISOString() },
  user: { id: "real-user", email: "person@example.com" },
};

function signIn(t) {
  storeSession(session);
  t.after(() => storeSession(null));
}

test("posts only a fragment-free URL to Yapern with the bearer session and no cookies", async t => {
  signIn(t);
  const image = await fetchOgImage("https://example.com/a?x=1#section", async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.pathname, "/og-image");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.headers, {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    });
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { url: "https://example.com/a?x=1" });
    return Response.json({ image: "https://cdn.example/image.jpg", source: "og", status: "ready" });
  });
  assert.equal(image, "https://cdn.example/image.jpg");
});

test("metadata and favicon results finish in one request", async t => {
  signIn(t);
  for (const source of ["og", "twitter", "favicon"]) {
    for (const status of ["ready", "failed"]) {
      let calls = 0;
      const image = await fetchOgImage("https://example.com", async () => {
        calls++;
        return Response.json({ image: "https://cdn.example/image.jpg", source, status });
      });
      assert.equal(image, "https://cdn.example/image.jpg");
      assert.equal(calls, 1);
    }
  }
});

test("missing, malformed, unsafe, and unknown-state images return null", async t => {
  signIn(t);
  for (const payload of [null, {}, { image: null, status: "failed" }, { image: null, status: "ready" },
    { image: "https://example.com/image.jpg", status: "pending" },
    { image: "data:image/png;base64,AA==", status: "ready" },
    { image: "javascript:alert(1)", status: "ready" },
    { image: "https://user:pass@example.com/image", status: "ready" }]) {
    assert.equal(await fetchOgImage("https://example.com", async () => Response.json(payload)), null);
  }
});

test("missing or expired sessions and invalid input skip the request", async t => {
  t.after(() => storeSession(null));
  const neverFetch = () => assert.fail("must not request a preview");
  storeSession(null);
  assert.equal(await fetchOgImage("https://example.com", neverFetch), null);
  storeSession({ ...session, session: { ...session.session, expires_at: "2000-01-01" } });
  assert.equal(await fetchOgImage("https://example.com", neverFetch), null);
  storeSession(session);
  for (const input of ["", " example.com ", "ftp://example.com", "javascript:alert(1)",
    "https://user:pass@example.com", "https://example.com:bad"]) {
    assert.equal(await fetchOgImage(input, neverFetch), null, input);
  }
});

test("unexpected pending responses never poll or follow a server-provided status URL", async t => {
  signIn(t);
  let calls = 0;
  await assert.rejects(fetchOgImage("https://example.com", async () => {
    calls++;
    return Response.json({ status: "pending", statusUrl: "https://attacker.example/steal-token" }, { status: 202 });
  }), /preview unavailable/);
  assert.equal(calls, 1);
});

test("HTTP, network, and malformed response failures preserve the session", async t => {
  signIn(t);
  for (const fetcher of [
    ...[400, 401, 403, 502].map(status => async () => new Response(null, { status })),
    async () => new Response("not json"),
    async () => { throw new TypeError("network"); },
    async () => { throw new DOMException("timeout", "TimeoutError"); },
  ]) {
    await assert.rejects(fetchOgImage("https://example.com", fetcher));
    assert.deepEqual(readStoredSession(), session);
  }
});

test("caller cancellation reaches the metadata request", async t => {
  signIn(t);
  const controller = new AbortController();
  let calls = 0;
  const lookup = fetchOgImage("https://example.com", (_url, options) => {
    calls++;
    assert.equal(options.signal.aborted, false);
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(lookup, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("already-cancelled lookups do not issue a request", async t => {
  signIn(t);
  await assert.rejects(fetchOgImage("https://example.com", () => assert.fail("must not request"), {
    signal: AbortSignal.abort(),
  }), { name: "AbortError" });
});
