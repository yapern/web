import assert from "node:assert/strict";
import test from "node:test";
import { fetchMessages, fetchMessagesPage, fetchBoards, fetchBoardPage, fetchMessageAuthors } from "../src/messages-api.js";
import { messageBoardConfig } from "../src/config.js";
import { boardHref, messageHref, parseBoardRoute } from "../src/board-routes.js";

const message = {
  id: "welcome",
  board_id: "general",
  user_id: "alice",
  title: "Welcome",
  body: "Hello from Yapern!",
  created_at: "2026-10-17T06:19:23.111Z",
  reply_count: 0,
};

test("reads the production API's newest 20 messages directly using CORS", async () => {
  const messages = await fetchMessages(async (url, options) => {
    assert.equal(url.origin, "https://api.yapern.com");
    assert.equal(url.pathname, "/tables/messages");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      select: "id,board_id,user_id,title,body,created_at,reply_count,video",
      order: "created_at.desc",
      limit: "20",
    });
    assert.deepEqual(options.headers, {});
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: [message] });
  });
  assert.deepEqual(messages, [message]);
});

test("message reads preserve stored reply totals and reject invalid counts", async () => {
  for (const reply_count of [0, 1, 250, 1000000]) {
    const row = { ...message, reply_count };
    assert.deepEqual(await fetchMessages(async () => Response.json({ data: [row] })), [row]);
  }
  for (const reply_count of [-1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fetchMessages(async () => Response.json({ data: [{ ...message, reply_count }] })), /Invalid messages/);
  }
});

test("all-message pagination includes every message once across full and partial pages", async () => {
  const messages = Array.from({ length: 45 }, (_, index) => ({ ...message, id: `message-${index}` }));
  const requests = [];
  const fetcher = async url => {
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    assert.equal(url.searchParams.get("board_id"), null);
    assert.equal(url.searchParams.get("order"), "created_at.desc");
    requests.push({ limit, offset });
    return Response.json({ data: messages.slice(offset, offset + limit) });
  };
  const pages = [];
  for (const page of [1, 2, 3]) pages.push(await fetchMessagesPage(page, fetcher));
  assert.deepEqual(pages.map(page => page.messages.length), [20, 20, 5]);
  assert.deepEqual(pages.map(page => page.hasNext), [true, true, false]);
  assert.deepEqual(pages.flatMap(page => page.messages), messages);
  assert.deepEqual(requests, [
    { limit: 20, offset: 0 }, { limit: 1, offset: 20 },
    { limit: 20, offset: 20 }, { limit: 1, offset: 40 },
    { limit: 20, offset: 40 },
  ]);
});

test("pagination stops at a full final page and supports empty or out-of-range pages", async () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({ ...message, id: String(index) }));
  const fetcher = async url => {
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return Response.json({ data: messages.slice(offset, offset + limit) });
  };
  assert.deepEqual(await fetchMessagesPage(2, fetcher), { messages: messages.slice(20), hasNext: false });
  assert.deepEqual(await fetchMessagesPage(3, fetcher), { messages: [], hasNext: false });
  assert.deepEqual(await fetchMessagesPage(1, async () => Response.json({ data: [] })), { messages: [], hasNext: false });
});

test("invalid page numbers never fetch, and pagination failures remain retryable", async () => {
  for (const page of [0, -1, 1.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fetchMessagesPage(page, async () => assert.fail("Unexpected request")));
  }
  await assert.rejects(fetchMessagesPage(1, async () => new Response(null, { status: 503 })));
  await assert.rejects(fetchMessagesPage(1, async url => Number(url.searchParams.get("limit")) === 20
    ? Response.json({ data: Array(20).fill(message) })
    : new Response(null, { status: 503 })));
});

test("homepage previews can still request only three messages", async () => {
  const messages = await fetchMessages(async url => {
    assert.equal(url.searchParams.get("limit"), "3");
    assert.equal(url.searchParams.get("offset"), null);
    return Response.json({ data: [message] });
  }, { limit: 3 });
  assert.deepEqual(messages, [message]);
});

const board = { id: "general", slug: "general", name: "General", description: "General discussion." };

test("message authors use current account names and look up each distinct ID only once", async () => {
  const id = "c0e15e07-e744-4cf9-a2c8-e5fe7e9ee82e";
  const messages = [message, { ...message, user_id: id }, { ...message, user_id: id }];
  let calls = 0;
  let currentName = "andrew";
  const fetcher = async (url, options) => {
    calls++;
    assert.ok(url.pathname.endsWith("/tables/users"));
    assert.equal(url.searchParams.get("select"), "id,name");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(options.headers.apikey, undefined);
    assert.equal(options.credentials, "omit");
    const userId = url.searchParams.get("id").slice(3);
    assert.ok(["alice", id].includes(userId));
    return Response.json({ data: [{ id: userId, name: userId === "alice" ? "Alice" : currentName }] });
  };
  const authors = await fetchMessageAuthors(messages, fetcher);
  assert.equal(calls, 2);
  assert.equal(authors.get("alice"), "Alice");
  assert.equal(authors.get(id), "andrew");
  currentName = "Updated account name";
  assert.equal((await fetchMessageAuthors(messages, fetcher)).get(id), currentName);
});

test("missing author names use a neutral label and empty lists skip profile requests", async () => {
  assert.deepEqual(await fetchMessageAuthors([], async () => assert.fail("Unexpected request")), new Map());
  for (const data of [[], [{ id: "alice", name: "  " }]]) {
    assert.equal((await fetchMessageAuthors([message], async () => Response.json({ data }))).get("alice"), "Unknown user");
  }
});

test("author lookups reject failed requests and mismatched or malformed profiles", async () => {
  for (const data of [[{ id: "bob", name: "Bob" }], [{ id: "alice", name: null }],
    [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }]]) {
    await assert.rejects(fetchMessageAuthors([message], async () => Response.json({ data })));
  }
  await assert.rejects(fetchMessageAuthors([message], async () => new Response(null, { status: 403 })));
});

test("board lookups paginate so messages can link to boards beyond the first 100", async () => {
  const boards = await fetchBoards(async url => {
    assert.ok(url.pathname.endsWith("/tables/boards"));
    assert.equal(url.searchParams.get("limit"), "100");
    const offset = url.searchParams.get("offset");
    assert.ok(["0", "100"].includes(offset));
    return Response.json({ data: offset === "0" ? Array.from({ length: 100 }, (_, i) => ({
      ...board, id: String(i), slug: `board-${i}`,
    })) : [board] });
  });
  assert.equal(boards.length, 101);
  assert.deepEqual(boards[100], board);
});

test("board pages filter messages by the looked-up board before applying the limit", async () => {
  const result = await fetchBoardPage("general", undefined, async url => {
    if (url.pathname.endsWith("/tables/boards")) {
      assert.equal(url.searchParams.get("slug"), "eq.general");
      assert.equal(url.searchParams.get("limit"), "1");
      return Response.json({ data: [board] });
    }
    assert.equal(url.searchParams.get("board_id"), "eq.general");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("order"), "created_at.desc");
    return Response.json({ data: [message] });
  });
  assert.deepEqual(result, { board, messages: [message] });
});

test("message pages filter by both board and message ID, including older messages", async () => {
  const id = "older / post?";
  const result = await fetchBoardPage("general", id, async url => {
    if (url.pathname.endsWith("/tables/boards")) return Response.json({ data: [board] });
    assert.equal(url.searchParams.get("board_id"), "eq.general");
    assert.equal(url.searchParams.get("id"), `eq.${id}`);
    assert.equal(url.searchParams.get("limit"), "1");
    return Response.json({ data: [{ ...message, id }] });
  });
  assert.equal(result.messages[0].id, id);
});

test("missing boards and missing messages return null, while empty boards remain valid", async () => {
  assert.equal(await fetchBoardPage("missing", undefined, async () => Response.json({ data: [] })), null);
  const fetcher = async url => Response.json({ data: url.pathname.endsWith("/tables/boards") ? [board] : [] });
  assert.equal(await fetchBoardPage("general", "missing", fetcher), null);
  assert.deepEqual(await fetchBoardPage("general", undefined, fetcher), { board, messages: [] });
});

test("rejects a mismatched board, message ID, or messages belonging to another board", async () => {
  await assert.rejects(() => fetchBoardPage("other", undefined, async () => Response.json({ data: [board] })));
  for (const wrong of [{ ...message, board_id: "other" }, { ...message, id: "other" }]) {
    await assert.rejects(() => fetchBoardPage("general", "welcome", async url => Response.json({
      data: url.pathname.endsWith("/tables/boards") ? [board] : [wrong],
    })));
  }
});

test("links use root board routes and encode message IDs", () => {
  assert.equal(boardHref("video-games"), "/y/video-games");
  assert.equal(messageHref("general", "older / post?"), "/y/general/older%20%2F%20post%3F");
  assert.deepEqual(parseBoardRoute("/y/general"), { slug: "general", messageId: undefined });
  assert.deepEqual(parseBoardRoute("/y/general/"), { slug: "general", messageId: undefined });
  assert.deepEqual(parseBoardRoute(messageHref("general", "older / post?")), { slug: "general", messageId: "older / post?" });
  for (const path of ["/y/", "/y/-invalid", "/y/general/id/extra", "/y/general/%ZZ"]) {
    assert.equal(parseBoardRoute(path), null);
  }
});

test("returns an empty list for a site with no messages", async () => {
  assert.deepEqual(await fetchMessages(async () => Response.json({ data: [] })), []);
});

test("rejects network, permission, redirect, and malformed data failures", async () => {
  const failures = [
    async () => { throw new TypeError("Failed to fetch"); },
    async () => new Response("Forbidden", { status: 403 }),
    async () => new Response(null, { status: 302, headers: { Location: "https://other.example" } }),
    async () => new Response("not json"),
    async () => Response.json({ data: null }),
    async () => Response.json({ data: [{ ...message, created_at: "invalid" }] }),
    async () => Response.json({ data: [{ ...message, body: null }] }),
    async () => Response.json({ data: Array(21).fill(message) }),
  ];
  for (const fetcher of failures) await assert.rejects(() => fetchMessages(fetcher));
});
