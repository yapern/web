import assert from "node:assert/strict";
import test from "node:test";
import { readStoredSession, storeSession } from "../src/auth.js";
import { boardLogoUrl, fetchBoards, updateBoard, updateBoardDescription } from "../src/messages-api.js";
import { messageBoardConfig } from "../src/config.js";

const session = {
  token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "creator", expires_at: new Date(Date.now() + 3600000).toISOString() },
  user: { id: "creator", email: "creator@example.com" },
};
const board = { id: "board / ?&id=eq.other", slug: "my-board", name: "My Board", description: "Original", user_id: "creator" };

test("board reads include the creator and allow boards with no creator", async () => {
  const boards = [board, { ...board, id: "general", slug: "general", user_id: null }];
  assert.deepEqual(await fetchBoards(async url => {
    assert.equal(url.searchParams.get("select"), "id,slug,name,description,user_id,logo_url");
    return Response.json({ data: boards });
  }), boards);
});

test("board logo URLs accept only trusted API logo paths", () => {
  assert.equal(boardLogoUrl("/board-logos/123e4567-e89b-12d3-a456-426614174000.webp"),
    `${messageBoardConfig.apiOrigin}/board-logos/123e4567-e89b-12d3-a456-426614174000.webp`);
  for (const value of [
    "https://elsewhere.example/board-logos/123e4567-e89b-12d3-a456-426614174000.webp",
    "/board-logos/not-a-uuid.webp", "/board-logos/123e4567-e89b-12d3-a456-426614174000.svg",
  ]) assert.equal(boardLogoUrl(value), null);
});

test("editing patches only the description of the exact board and authenticated creator", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  for (const description of [" Updated description. ", ""]) {
    const saved = { ...board, description: description.trim() };
    assert.deepEqual(await updateBoardDescription(board, description, async (url, options) => {
      assert.equal(url.origin, messageBoardConfig.apiOrigin);
      assert.equal(url.pathname, "/tables/boards");
      assert.deepEqual(Object.fromEntries(url.searchParams), { id: `eq.${board.id}`, user_id: "eq.creator" });
      assert.equal(options.method, "PATCH");
      assert.equal(options.headers.authorization, `Bearer ${session.token}`);
      assert.equal(options.headers["content-type"], "application/json");
      assert.equal(options.mode, "cors");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), { description: saved.description });
      return Response.json({ data: [saved] });
    }), saved);
  }
});

test("invalid descriptions, other creators, and expired sessions never send an edit", async t => {
  t.after(() => storeSession(null));
  const neverFetch = () => assert.fail("must reject before sending a request");
  storeSession(session);
  for (const value of [null, 12, "a".repeat(2001)]) {
    await assert.rejects(updateBoardDescription(board, value, neverFetch), /at most 2000/);
  }
  for (const value of [null, {}, { ...board, user_id: null }, { ...board, id: " " }]) {
    await assert.rejects(updateBoardDescription(value, "Updated", neverFetch), /Choose a sub-yap/);
  }
  await assert.rejects(updateBoardDescription({ ...board, user_id: "someone-else" }, "Updated", neverFetch), /only edit sub-yaps you created/);
  for (const value of [null, { ...session, session: { ...session.session, expires_at: "2000-01-01" } }]) {
    storeSession(value);
    await assert.rejects(updateBoardDescription(board, "Updated", neverFetch), /session has expired/);
  }
});

test("edits require confirmation of the description and unchanged identity, name, and creator", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const saved = { ...board, description: "Updated" };
  for (const data of [[], [saved, saved], ...[
    { id: "wrong" }, { user_id: "wrong" }, { name: "Changed" }, { slug: "changed" }, { description: "Original" },
  ].map(override => [{ ...saved, ...override }])]) {
    await assert.rejects(updateBoardDescription(board, "Updated", async () => Response.json({ data })), /Could not confirm/);
  }
  await assert.rejects(updateBoardDescription(board, "Updated", async () => new Response("invalid JSON")), /Could not confirm/);
});

test("failed edits show useful errors, clear rejected sessions, and never retry", async t => {
  t.after(() => storeSession(null));
  for (const [status, pattern] of [[401, /session has expired/], [403, /permission/], [404, /no longer available/], [500, /Could not save/]]) {
    storeSession(session);
    let calls = 0;
    await assert.rejects(updateBoardDescription(board, "Updated", async () => {
      calls++;
      return Response.json({ error: "private SQL details" }, { status });
    }), pattern);
    assert.equal(calls, 1);
    assert.deepEqual(readStoredSession(), status === 401 ? null : session);
  }
  await assert.rejects(updateBoardDescription(board, "Updated", async () => { throw new TypeError("network"); }), /Check your connection/);
});

test("logo uploads use multipart form data and confirm the returned logo", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const file = new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });
  const logoUrl = "/board-logos/123e4567-e89b-12d3-a456-426614174000.png";
  const saved = { ...board, description: "Updated", logo_url: logoUrl };
  assert.deepEqual(await updateBoard(board, { description: " Updated ", logo: file }, async (url, options) => {
    assert.deepEqual(Object.fromEntries(url.searchParams), { id: `eq.${board.id}`, user_id: "eq.creator" });
    assert.equal(options.method, "PATCH");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.headers["content-type"], undefined);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get("description"), "Updated");
    assert.equal(options.body.get("logo").name, "logo.png");
    return Response.json({ data: [saved] });
  }), saved);
  await assert.rejects(updateBoard(board, { description: "Updated", logo: file }, async () => Response.json({ data: [{ ...saved, logo_url: null }] })), /Could not confirm/);
});

test("logo removal uses JSON and confirms the returned removal", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const withLogo = { ...board, logo_url: "/board-logos/123e4567-e89b-12d3-a456-426614174000.gif" };
  const saved = { ...withLogo, description: "Updated", logo_url: null };
  assert.deepEqual(await updateBoard(withLogo, { description: "Updated", removeLogo: true }, async (_url, options) => {
    assert.equal(options.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), { description: "Updated", remove_logo: true });
    return Response.json({ data: [saved] });
  }), saved);
});

test("multipart newline normalization does not report a successful logo save as unconfirmed", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const description = "First line\nSecond line\n\nLast line";
  const logo = new File(["image"], "logo.png", { type: "image/png" });
  const logoUrl = "/board-logos/123e4567-e89b-12d3-a456-426614174000.png";
  const updated = await updateBoard(board, { description, logo }, async (url, options) => {
    const form = await new Request(url, options).formData();
    assert.equal(form.get("description"), description.replaceAll("\n", "\r\n"));
    return Response.json({ data: [{ ...board, description: form.get("description"), logo_url: logoUrl }] });
  });
  assert.equal(updated.description, description);
  assert.equal(updated.logo_url, logoUrl);
});

test("description saves accept the current logo if another edit changed it", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  for (const logoUrl of [null, "/board-logos/123e4567-e89b-12d3-a456-426614174000.png"]) {
    const saved = { ...board, description: "Updated", logo_url: logoUrl };
    assert.deepEqual(await updateBoardDescription(board, "Updated", async () => Response.json({ data: [saved] })), saved);
  }
});

test("logo upload limits and API rejection statuses preserve safe errors", async t => {
  t.after(() => storeSession(null));
  storeSession(session);
  const neverFetch = () => assert.fail("must reject before sending a request");
  for (const logo of [
    new File(["x"], "bad.svg", { type: "image/svg+xml" }),
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
  ]) await assert.rejects(updateBoard(board, { description: "Updated", logo }, neverFetch), /logo|Choose/i);
  for (const [status, pattern] of [[409, /changed while/], [413, /smaller than 5 MB/], [415, /valid PNG/]]) {
    await assert.rejects(updateBoard(board, { description: "Updated", removeLogo: true }, async () =>
      Response.json({ error: "private details" }, { status })), pattern);
  }
});
