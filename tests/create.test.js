import assert from "node:assert/strict";
import test from "node:test";
import { storeSession } from "../src/auth.js";
import { createBoard, createMessage, messageBodyLength } from "../src/messages-api.js";
import { messageBoardConfig } from "../src/config.js";

const session = {
  token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "real-user", expires_at: new Date(Date.now() + 3600000).toISOString() },
  user: { id: "real-user", email: "person@example.com" },
};
const row = { id: "new-id", user_id: "real-user", created_at: "2026-10-18T12:00:00.000Z" };

test("creation uses the current session's bearer, trims input, and confirms the saved row", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const fetcher = async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.ok(url.pathname.startsWith(`/tables/`));
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.headers.apikey, undefined);
    assert.equal(options.headers["content-type"], "application/json");
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    const data = JSON.parse(options.body);
    assert.equal(data.user_id, "real-user");
    if (url.pathname.endsWith("/boards")) {
      assert.deepEqual(data, { name: "Weekend Builds", slug: "weekend-builds", description: "Share projects.", user_id: "real-user" });
    } else {
      assert.deepEqual(data, { board_id: "general", title: "My project", body: "Made a shelf!", user_id: "real-user" });
    }
    return Response.json({ data: [{ ...row, ...data }] }, { status: 201 });
  };
  assert.equal((await createBoard(" Weekend Builds ", " Share projects. ", fetcher)).slug, "weekend-builds");
  assert.equal((await createMessage("general", " My project ", " Made a shelf! ", fetcher)).body, "Made a shelf!");
});

test("invalid input and missing or expired sessions never send a write", async t => {
  t.after(() => storeSession(null));
  const neverFetch = () => assert.fail("must reject before sending a request");
  storeSession(session);
  for (const [name, description] of [[" ", ""], ["a".repeat(81), ""], ["Invalid!", ""], ["-invalid", ""], ["Valid", "a".repeat(2001)]]) {
    await assert.rejects(createBoard(name, description, neverFetch));
  }
  for (const args of [["", "title", "body"], ["general", " ", "body"], ["general", "a".repeat(201), "body"], ["general", "title", " "], ["general", "title", "a".repeat(2001)]]) {
    await assert.rejects(createMessage(...args, neverFetch));
  }
  for (const saved of [null, { ...session, session: { ...session.session, expires_at: "2000-01-01" } }]) {
    storeSession(saved);
    await assert.rejects(createBoard("Valid", "", neverFetch), /session has expired/);
    await assert.rejects(createMessage("general", "title", "body", neverFetch), /session has expired/);
  }
});

test("write errors are useful, never expose backend details, and do not automatically retry", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  for (const [status, pattern] of [[401, /session has expired/], [403, /permission to create sub-yaps/], [409, /already exists/], [500, /Could not create/]]) {
    let calls = 0;
    await assert.rejects(createBoard("Valid", "", async () => {
      calls++;
      return Response.json({ error: "private SQL details" }, { status });
    }), pattern);
    assert.equal(calls, 1);
  }
  await assert.rejects(createMessage("general", "title", "body", async () => new Response(null, { status: 403 })), /permission to post/);
  await assert.rejects(createBoard("Valid", "", async () => { throw new TypeError("network"); }), /Check your connection/);
});

test("successful HTTP responses must confirm the exact row and author before navigating", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const board = { ...row, slug: "valid", name: "Valid", description: "" };
  const message = { ...row, board_id: "general", title: "Title", body: "Body" };
  for (const payload of [{}, { data: [] }, { data: [board, board] }, { data: [{ ...board, user_id: "someone-else" }] }, { data: [{ ...board, slug: "wrong" }] }]) {
    await assert.rejects(createBoard("Valid", "", async () => Response.json(payload)), /confirm creation/);
  }
  for (const override of [{ board_id: "wrong" }, { title: "Wrong" }, { body: "Wrong" }, { user_id: "wrong" }, { created_at: "invalid" }]) {
    await assert.rejects(createMessage("general", "Title", "Body", async () => Response.json({ data: [{ ...message, ...override }] })), /confirm creation/);
  }
});

test("message image uploads use multipart and confirm the exact saved image and normalized body", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const image = new File(["png"], "photo.png", { type: "image/png" });
  const imagePath = "/board-messages/123e4567-e89b-12d3-a456-426614174000.png";
  for (const text of ["", "  First\r\n\r\nLast  "]) {
    const cleanBody = text.replace(/\r\n?/g, "\n").trim();
    const savedBody = `${messageBoardConfig.apiOrigin}${imagePath}${cleanBody ? `\n${cleanBody}` : ""}`;
    const message = await createMessage("general", " Photo ", text, async (url, options) => {
      assert.equal(url.pathname, "/tables/messages");
      assert.equal(options.headers.authorization, `Bearer ${session.token}`);
      assert.equal(options.headers["content-type"], undefined);
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get("board_id"), "general");
      assert.equal(options.body.get("title"), "Photo");
      assert.equal(options.body.get("body"), cleanBody);
      assert.equal(options.body.get("user_id"), "real-user");
      assert.equal(await options.body.get("image").text(), "png");
      return Response.json({ data: [{ ...row, board_id: "general", title: "Photo", body: savedBody, image_url: imagePath }] }, { status: 201 });
    }, { image });
    assert.equal(message.body, savedBody);
    assert.equal(messageBodyLength(cleanBody, image), savedBody.length);
  }
});

test("message image validation prevents invalid files and oversized final bodies from uploading", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const neverFetch = () => assert.fail("must validate before uploading");
  for (const image of [
    new File([], "empty.png", { type: "image/png" }),
    new File(["svg"], "unsafe.svg", { type: "image/svg+xml" }),
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    { type: "image/png", size: 1 },
  ]) await assert.rejects(createMessage("general", "Photo", "", neverFetch, { image }), /Choose/);
  const image = new File(["png"], "photo.png", { type: "image/png" });
  await assert.rejects(createMessage("general", "Photo", "a".repeat(1990), neverFetch, { image }), /including its image URL/);
});

test("image errors preserve the draft and untrusted upload confirmations cannot report success", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const image = new File(["png"], "photo.png", { type: "image/png" });
  for (const [status, pattern] of [[404, /no longer available/], [413, /smaller than 5 MB/], [415, /valid PNG/], [503, /unavailable/]]) {
    await assert.rejects(createMessage("general", "Photo", "", async () => new Response(null, { status }), { image }), pattern);
  }
  for (const image_url of [null, "https://other.example/photo.png", "/board-logos/123e4567-e89b-12d3-a456-426614174000.png", "/board-messages/../../photo.png"]) {
    await assert.rejects(createMessage("general", "Photo", "", async () => Response.json({ data: [{
      ...row, board_id: "general", title: "Photo", body: "", image_url,
    }] }), { image }), /confirm creation/);
  }
});
