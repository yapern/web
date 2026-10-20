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

async function capturePreviewLogs(action) {
  const entries = [];
  const original = { info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => entries.push({ level, event: args[1], details: args[2] });
  }
  try {
    return { result: await action(), entries };
  } finally {
    Object.assign(console, original);
  }
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

test("terminal no-image failures log curated diagnostics and retain source and target", async t => {
  signIn(t);
  const payload = {
    image: null, source: "placeholder", status: "failed", error: "preview_blank_page",
    diagnostics: { metadata: { code: "preview_metadata_missing", message: "Metadata did not contain a usable image." } },
  };
  const { result, entries } = await capturePreviewLogs(() => fetchOgImage("https://example.com/path?secret=hidden", async () => Response.json(payload)));
  assert.equal(result, null);
  const response = entries.find(entry => entry.event === "response received");
  const empty = entries.find(entry => entry.event === "terminal response has no usable image");
  for (const entry of [response, empty]) {
    assert.equal(entry.details.source, payload.source);
    assert.equal(entry.details.error, payload.error);
    assert.deepEqual(entry.details.diagnostics, payload.diagnostics);
    assert.equal(entry.details.target, "https://example.com/path");
    assert.equal(entry.details.httpStatus, 200);
    assert.equal(typeof entry.details.elapsedMs, "number");
  }
});

test("diagnostics from a pending response and terminal failure survive polling logs", async t => {
  signIn(t);
  const previewId = "b7e4cf02-cdb8-47b0-87ed-942c09ce5025";
  const statusUrl = `${messageBoardConfig.apiOrigin}/previews/${previewId}`;
  const { result, entries } = await capturePreviewLogs(() => fetchOgImage("https://example.com", async (url, options) => {
    if (options.method === "POST") {
      return Response.json({
        image: null, source: "placeholder", status: "pending", previewId, statusUrl,
        diagnostics: { metadata: { code: "preview_metadata_missing", message: "No usable metadata image." } },
      }, { status: 202, headers: { "retry-after": "0" } });
    }
    assert.equal(url.href, statusUrl);
    return Response.json({
      image: null, source: "placeholder", status: "failed", previewId, error: "preview_blank_page",
      diagnostics: { screenshot: { code: "preview_blank_page", message: "Screenshot was blank." } },
    });
  }));
  assert.equal(result, null);
  const responses = entries.filter(entry => entry.event === "response received");
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0].details.diagnostics, {
    metadata: { code: "preview_metadata_missing", message: "No usable metadata image." },
  });
  assert.deepEqual(responses[1].details.diagnostics, {
    screenshot: { code: "preview_blank_page", message: "Screenshot was blank." },
  });
  assert.equal(responses[1].details.previewId, previewId);
  assert.equal(responses[1].details.httpStatus, 200);
});

test("failed status still returns a usable favicon image", async t => {
  signIn(t);
  const image = await fetchOgImage("https://example.com", async () => Response.json({
    image: "https://cdn.example/favicon.ico", source: "favicon", status: "failed",
    error: "preview_http_error", diagnostics: { screenshot: { code: "preview_http_error", message: "The website returned an unsuccessful HTTP status.", httpStatus: 403 } },
  }));
  assert.equal(image, "https://cdn.example/favicon.ico");
});

test("HTTP API errors preserve their curated error code in logs", async t => {
  signIn(t);
  const { entries } = await capturePreviewLogs(() => assert.rejects(
    fetchOgImage("https://example.com", async () => Response.json({ error: "preview_limit" }, { status: 429 })),
  ));
  const failure = entries.find(entry => entry.event === "API request failed");
  assert.equal(failure.details.reason, "api-error");
  assert.equal(failure.details.error, "preview_limit");
  assert.equal(failure.details.httpStatus, 429);
});

test("transport and invalid response failures log distinct reasons and exception details", async t => {
  signIn(t);
  for (const [fetcher, expectedReason] of [
    [async () => { throw new TypeError("network disconnected"); }, "network-or-cors"],
    [async () => Response.json({ status: "mystery" }), "invalid-response-status"],
    [async () => new Response("not-json"), "malformed-json"],
  ]) {
    const { entries } = await capturePreviewLogs(() => assert.rejects(fetchOgImage("https://example.com", fetcher)));
    const failure = entries.find(entry => entry.event === "lookup failed");
    assert.equal(failure.details.reason, expectedReason);
    assert.equal(typeof failure.details.exceptionName, "string");
    assert.equal(typeof failure.details.exceptionMessage, "string");
    assert.equal(failure.details.target, "https://example.com/");
    if (expectedReason === "malformed-json") {
      assert.equal(failure.details.httpStatus, 200);
      assert.equal(failure.details.endpoint, "/og-image");
    }
  }
});

test("timeouts while parsing a response remain timeout failures", async t => {
  signIn(t);
  const response = Response.json({ status: "ready" });
  Object.defineProperty(response, "json", {
    value: async () => { throw new DOMException("response read timed out", "TimeoutError"); },
  });
  const { entries } = await capturePreviewLogs(() => assert.rejects(
    fetchOgImage("https://example.com", async () => response),
  ));
  const failure = entries.find(entry => entry.event === "lookup failed");
  assert.equal(failure.details.reason, "timeout");
  assert.equal(failure.details.exceptionName, "TimeoutError");
  assert.equal(failure.details.httpStatus, 200);
});

test("the preview deadline is reported as a timeout even when fetch rejects with AbortError", async t => {
  signIn(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { entries } = await capturePreviewLogs(async () => {
    const lookup = fetchOgImage("https://example.com", (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const rejected = assert.rejects(lookup, { name: "TimeoutError" });
    t.mock.timers.tick(45_000);
    await rejected;
  });
  assert.equal(entries.find(entry => entry.event === "lookup failed").details.reason, "timeout");
  assert.ok(!entries.some(entry => entry.event === "lookup cancelled"));
});

test("exception logs omit session tokens and URL queries", async t => {
  signIn(t);
  const { entries } = await capturePreviewLogs(() => assert.rejects(fetchOgImage("https://example.com", async () => {
    throw new TypeError(`${session.token} ${session.token} https://user:pass@example.com/path?secret=hidden#fragment`);
  })));
  const logged = JSON.stringify(entries);
  for (const secret of [session.token, "secret=hidden", "user:pass", "fragment"]) assert.ok(!logged.includes(secret));
  assert.match(logged, /https:\/\/example.com\/path/);
});

test("terminal responses with missing or unsafe images return null", async t => {
  signIn(t);
  for (const payload of [{ image: null, status: "failed" }, { image: null, status: "ready" },
    { image: "data:image/png;base64,AA==", status: "ready" },
    { image: "javascript:alert(1)", status: "ready" },
    { image: "https://user:pass@example.com/image", status: "ready" }]) {
    assert.equal(await fetchOgImage("https://example.com", async () => Response.json(payload)), null);
  }
  await assert.rejects(fetchOgImage("https://example.com", async () => Response.json(null)), { previewReason: "invalid-response" });
  await assert.rejects(fetchOgImage("https://example.com", async () => Response.json({})), { previewReason: "invalid-response-status" });
  await assert.rejects(fetchOgImage("https://example.com", async () => Response.json({
    image: "https://example.com/image.jpg", status: "pending",
  })), { previewReason: "invalid-response-status" });
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

test("valid queued responses poll their same-origin preview endpoint", async t => {
  signIn(t);
  const previewId = "b7e4cf02-cdb8-47b0-87ed-942c09ce5025";
  const statusUrl = `${messageBoardConfig.apiOrigin}/previews/${previewId}`;
  let calls = 0;
  const image = await fetchOgImage("https://example.com", async (url, options) => {
    calls++;
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.mode, "cors");
    assert.ok(options.signal instanceof AbortSignal);
    if (calls === 1) {
      assert.equal(url.pathname, "/og-image");
      assert.equal(options.method, "POST");
      return Response.json({ image: null, source: "placeholder", status: "pending", previewId, statusUrl }, {
        status: 202, headers: { "retry-after": "0" },
      });
    }
    assert.equal(url.href, statusUrl);
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    return Response.json({ image: `${messageBoardConfig.apiOrigin}/preview-images/${previewId}.jpg`, source: "screenshot", status: "ready" });
  });
  assert.equal(image, `${messageBoardConfig.apiOrigin}/preview-images/${previewId}.jpg`);
  assert.equal(calls, 2);
});

test("pending responses reject unsafe or inconsistent status URLs before polling", async t => {
  signIn(t);
  const previewId = "b7e4cf02-cdb8-47b0-87ed-942c09ce5025";
  for (const [id, statusUrl] of [
    [previewId, "https://attacker.example/steal-token"],
    [previewId, `${messageBoardConfig.apiOrigin}/other/${previewId}`],
    [previewId, `${messageBoardConfig.apiOrigin}/previews/${previewId}?token=bad`],
    ["b7e4cf02-cdb8-47b0-87ed-942c09ce5026", `${messageBoardConfig.apiOrigin}/previews/${previewId}`],
  ]) {
    let calls = 0;
    await assert.rejects(fetchOgImage("https://example.com", async () => {
      calls++;
      return Response.json({ status: "pending", previewId: id, statusUrl }, { status: 202 });
    }), error => ["unsafe-polling-url", "invalid-response-status"].includes(error.previewReason));
    assert.equal(calls, 1);
  }
});

test("caller cancellation stops polling before another request", async t => {
  signIn(t);
  const controller = new AbortController();
  const previewId = "b7e4cf02-cdb8-47b0-87ed-942c09ce5025";
  let calls = 0;
  await assert.rejects(fetchOgImage("https://example.com", async () => {
    calls++;
    controller.abort();
    return Response.json({
      status: "pending", previewId,
      statusUrl: `${messageBoardConfig.apiOrigin}/previews/${previewId}`,
    }, { status: 202, headers: { "retry-after": "0" } });
  }, { signal: controller.signal }), { name: "AbortError" });
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
