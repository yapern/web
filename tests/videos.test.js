import assert from "node:assert/strict";
import test from "node:test";
import { storeSession } from "../src/auth.js";
import { messageBoardConfig } from "../src/config.js";
import { createMessage, fetchMessages } from "../src/messages-api.js";
import { createVideoUpload, uploadVideoFile, completeVideoUpload, fetchVideo, isMessageVideo, messageVideoError } from "../src/videos-api.js";
import { messageCaption } from "../src/message-video.js";

const id = "123e4567-e89b-12d3-a456-426614174000";
const uid = "a".repeat(32);
const base = `https://customer-testing.cloudflarestream.com/${uid}`;
const session = { token: `bff_us_${"a".repeat(64)}`,
  session: { id: "session", user_id: "owner", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
  user: { id: "owner", email: "owner@example.com" } };
const video = { id, status: "ready", duration: 30, width: 1080, height: 1920,
  watch_url: `${base}/watch`, playback_url: `${base}/manifest/video.m3u8`, player_url: `${base}/iframe`,
  thumbnail_url: `${base}/thumbnails/thumbnail.jpg`, error: null };
const file = () => new File(["video"], "clip.mov", { type: "video/quicktime" });
const reservation = () => ({ id, upload_url: `https://upload.videodelivery.net/tus/${uid}`,
  expires_at: new Date(Date.now() + 60_000).toISOString(), max_duration_seconds: 120 });
function signedIn(t) { storeSession(session); t.after(() => storeSession(null)); }

function multipartReservation(overrides = {}) {
  return { ...reservation(), upload_protocol: "multipart", upload_url: `https://upload.cloudflarestream.com/${uid}`, ...overrides };
}

test("video reservations use the app session and validate the direct upload destination", async t => {
  signedIn(t);
  const record = await createVideoUpload("general", file(), async (url, options) => {
    assert.equal(url.origin, messageBoardConfig.apiOrigin);
    assert.equal(url.pathname, "/videos");
    assert.equal(options.headers.authorization, `Bearer ${session.token}`);
    assert.equal(options.credentials, "omit");
    assert.deepEqual(JSON.parse(options.body), { board_id: "general", size_bytes: 5 });
    return Response.json({ data: reservation() }, { status: 201 });
  });
  assert.equal(record.id, id);
  assert.equal(record.upload_protocol, "tus", "older servers default to the resumable protocol");
  const multipart = await createVideoUpload("general", file(), async () => Response.json({ data: { ...multipartReservation(), expires_at: new Date(Date.now() + 60_000).toISOString() } }));
  assert.equal(multipart.upload_protocol, "multipart");
  const unsafeUploads = ["upload.cloudflarestream.com", "upload.videodelivery.net"].flatMap(host => {
    const upload_protocol = host === "upload.cloudflarestream.com" ? "multipart" : "tus";
    return [
      `http://${host}/upload`,
      `https://${host}.evil.example/upload`,
      `https://user:pass@${host}/upload`,
    ].map(upload_url => ({ upload_protocol, upload_url }));
  });
  for (const unsafe of [{ upload_url: "https://evil.example/upload" }, ...unsafeUploads]) {
    await assert.rejects(createVideoUpload("general", file(), async () => Response.json({ data: { ...reservation(), ...unsafe } })), /safe video upload destination/);
  }
  await assert.rejects(createVideoUpload("general", file(), async () => Response.json({ data: { ...reservation(), upload_protocol: "other" } })), /safe video upload destination/);
});

test("resumable uploads use constrained chunks, resume the same URL and never send the app bearer", async () => {
  let attempts = 0;
  const progress = [];
  const record = reservation();
  const createUpload = (uploadFile, options) => {
    assert.equal(uploadFile.name, "clip.mov");
    assert.equal(options.uploadUrl, record.upload_url);
    assert.equal(options.chunkSize, 5 * 1024 * 1024);
    assert.deepEqual(options.headers, {});
    assert.equal(options.storeFingerprintForResuming, false);
    assert.ok(options.retryDelays.length > 1);
    return { start() {
      attempts++;
      if (attempts === 1) options.onError(new Error("network error containing an unsafe URL"));
      else { options.onProgress(5, 5); options.onSuccess(); }
    } };
  };
  await assert.rejects(uploadVideoFile(file(), record, { createUpload }), /posting again to resume/);
  await uploadVideoFile(file(), record, { createUpload, onProgress: value => progress.push(value) });
  assert.deepEqual(progress, [100]);
  await assert.rejects(uploadVideoFile(file(), { ...record, expires_at: "2000-01-01" }, { createUpload }), /expired/);
  assert.equal(attempts, 2);
});

test("multipart uploads send the file without credentials and report progress", async t => {
  signedIn(t);
  const progress = [];
  let request;
  await uploadVideoFile(file(), multipartReservation(), {
    onProgress: value => progress.push(value),
    createRequest: () => request = {
      upload: { addEventListener(type, callback) { assert.equal(type, "progress"); this.progress = callback; } },
      open(method, url) { this.method = method; this.url = url; },
      send(body) {
        this.body = body;
        this.upload.progress({ lengthComputable: true, loaded: 2, total: 4 });
        this.status = 201;
        this.onload();
      },
    },
  });
  assert.equal(request.method, "POST");
  assert.equal(request.url, multipartReservation().upload_url);
  assert.equal(request.withCredentials, false);
  assert.equal(request.timeout, 10 * 60 * 1000);
  assert.equal(request.setRequestHeader, undefined);
  assert.equal(request.body instanceof FormData, true);
  assert.equal(request.body.get("file").name, "clip.mov");
  assert.deepEqual(progress, [50, 100]);
});

test("multipart upload failures are sanitized and expired URLs never start a request", async () => {
  for (const failure of [
    { status: 403, trigger: "load" },
    { trigger: "error" },
    { trigger: "timeout" },
    { trigger: "abort" },
  ]) {
    await assert.rejects(uploadVideoFile(file(), multipartReservation(), {
      createRequest: () => ({
        upload: { addEventListener() {} },
        open() {},
        send() {
          if (failure.status) this.status = failure.status;
          this[`on${failure.trigger}`]();
        },
      }),
    }), { message: "The video upload failed. Try posting again." });
  }
  let created = false;
  await assert.rejects(uploadVideoFile(file(), multipartReservation({ expires_at: "2000-01-01" }), {
    createRequest: () => { created = true; throw new Error("must not start"); },
  }), /expired/);
  assert.equal(created, false);
});

test("video metadata rejects unsafe, mismatched and incomplete player URLs", async () => {
  assert.equal(isMessageVideo(video), true);
  assert.equal(isMessageVideo({ ...video, status: "processing", playback_url: null, player_url: null, thumbnail_url: null }), true);
  for (const changed of [
    { player_url: "javascript:alert(1)" }, { player_url: `https://evil.example/${uid}/iframe` },
    { player_url: `${base}/iframe?autoplay=true` }, { player_url: `${base}/iframe#evil` },
    { player_url: `https://customer-testing.cloudflarestream.com/${"b".repeat(32)}/iframe` },
    { width: -1 }, { status: "surprise" }, { playback_url: null }, { duration: NaN },
  ]) {
    assert.equal(isMessageVideo({ ...video, ...changed }), false, JSON.stringify(changed));
    await assert.rejects(fetchMessages(async () => Response.json({ data: [{ id: "message", board_id: "general", user_id: "owner", title: "Video", body: "Text", created_at: new Date().toISOString(), video: { ...video, ...changed } }] })), /Invalid messages/);
  }
});

test("video-only posts and captions confirm the saved attachment and preserve fallback links", async t => {
  signedIn(t);
  for (const caption of ["", "  First\r\nLast  "]) {
    const clean = caption.replace(/\r\n?/g, "\n").trim();
    const result = await createMessage("general", " Clip ", caption, async (url, options) => {
      assert.equal(url.pathname, "/tables/messages");
      assert.deepEqual(JSON.parse(options.body), { board_id: "general", title: "Clip", body: clean, attachment_id: id, user_id: "owner" });
      return Response.json({ data: [{ id: "message", board_id: "general", user_id: "owner", title: "Clip",
        body: `${video.watch_url}${clean ? `\n${clean}` : ""}`, created_at: new Date().toISOString(), video }] }, { status: 201 });
    }, { video });
    assert.equal(messageCaption(result), clean);
  }
  await assert.rejects(createMessage("general", "Clip", "x".repeat(2000), () => assert.fail("must validate first"), { video }), /Shorten/);
  await assert.rejects(createMessage("general", "Clip", "", async () => Response.json({ data: [{ id: "message", board_id: "general", user_id: "owner", title: "Clip", body: video.watch_url, created_at: new Date().toISOString(), video: { ...video, id: "123e4567-e89b-12d3-a456-426614174001" } }] }), { video }), /confirm creation/);
});

test("status and completion validate identity, preserve processing states, and explain service errors", async t => {
  signedIn(t);
  const processing = { ...video, status: "processing", playback_url: null, player_url: null, thumbnail_url: null };
  assert.deepEqual(await completeVideoUpload(id, async (url, options) => {
    assert.equal(url.pathname, `/videos/${id}/complete`);
    assert.equal(options.method, "POST");
    return Response.json({ data: processing });
  }), processing);
  assert.deepEqual(await fetchVideo(id, async () => Response.json({ data: video })), video);
  for (const [status, message] of [[401, /session has expired/], [429, /upload limit/], [503, /unavailable/]]) {
    await assert.rejects(createVideoUpload("general", file(), async () => new Response(null, { status })), message);
  }
  await assert.rejects(fetchVideo(id, async () => Response.json({ data: { ...video, id: "wrong" } })), /Invalid video status/);
});

test("video validation rejects empty, non-video and oversized files before reserving storage", () => {
  assert.equal(messageVideoError(file()), "");
  assert.equal(messageVideoError(new File(["video"], "clip.mp4")), "");
  for (const invalid of [new File([], "clip.mp4", { type: "video/mp4" }), new File(["svg"], "x.svg", { type: "image/svg+xml" }),
    new File([new Uint8Array(100 * 1024 * 1024 + 1)], "large.mp4", { type: "video/mp4" })]) assert.ok(messageVideoError(invalid));
});
