import { readStoredSession } from "./auth.js";
import { messageBoardConfig } from "./config.js";

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const states = new Set(["uploading", "processing", "ready", "failed"]);
export const maxVideoBytes = 100 * 1024 * 1024;
export const maxVideoSeconds = 120;
const uploadHosts = new Set(["upload.cloudflarestream.com", "upload.videodelivery.net"]);

function streamUrl(value, suffix) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^(?:customer-[a-z0-9-]+\.cloudflarestream\.com|videodelivery\.net)$/.test(url.hostname) &&
      new RegExp(`^/[a-f0-9]{32}/${suffix}$`).test(url.pathname)) return url;
  } catch {}
  return null;
}

export function isMessageVideo(video) {
  if (!video || !idPattern.test(video.id) || !states.has(video.status)) return false;
  if (![video.width, video.height].every(value => value === null || (Number.isSafeInteger(value) && value > 0))) return false;
  if (video.duration !== null && (!Number.isFinite(video.duration) || video.duration < 0)) return false;
  if (video.error !== null && typeof video.error !== "string") return false;
  const suffixes = { watch_url: "watch", playback_url: "manifest/video\\.m3u8", player_url: "iframe", thumbnail_url: "thumbnails/thumbnail\\.jpg" };
  const urls = {};
  for (const [key, suffix] of Object.entries(suffixes)) {
    if (video[key] === null) continue;
    const url = streamUrl(video[key], suffix);
    if (!url) return false;
    urls[key] = url;
  }
  if (video.status === "ready" && (Object.keys(urls).length !== 4 || !video.duration || !video.width || !video.height)) return false;
  const bases = Object.values(urls).map(url => `${url.origin}/${url.pathname.split("/")[1]}`);
  return bases.every(base => base === bases[0]);
}

export function messageVideoError(file) {
  if (!(file instanceof File) || file.size < 1 ||
    !(file.type.startsWith("video/") || (!file.type && /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name)))) {
    return "Choose a video file, such as MP4, MOV, or WebM.";
  }
  return file.size > maxVideoBytes ? "Choose a video of at most 100 MB and two minutes." : "";
}

async function videoRequest(path, method, fetcher, body) {
  const session = readStoredSession();
  if (method !== "GET" && !session) throw new Error("Your session has expired. Sign in again to upload a video.");
  const response = await fetcher(new URL(path, messageBoardConfig.apiOrigin), {
    method, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { ...(session ? { authorization: `Bearer ${session.token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) throw new Error("Your session has expired. Sign in again to upload a video.");
  if (response.status === 429) throw new Error("You’ve reached the video upload limit. Finish pending uploads or try again tomorrow.");
  if (response.status === 404) throw new Error("This video or sub-yap is no longer available.");
  if (response.status === 409) throw new Error("This video is already attached to a message.");
  if (response.status === 503) throw new Error("Video uploads are unavailable right now. Please try again later.");
  if (!response.ok) throw new Error("Could not update the video. Please try again.");
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") throw new Error("Could not confirm the video upload. Please try again.");
  return payload;
}

export async function createVideoUpload(boardId, file, fetcher = fetch) {
  const error = messageVideoError(file);
  if (error) throw new Error(error);
  const { data } = await videoRequest("/videos", "POST", fetcher, { board_id: boardId, size_bytes: file.size });
  const uploadProtocol = data?.upload_protocol ?? "tus";
  if (uploadProtocol !== "multipart" && uploadProtocol !== "tus") throw new Error("Could not confirm a safe video upload destination.");
  let url;
  try { url = new URL(data?.upload_url); } catch {}
  if (!idPattern.test(data?.id) || !url || url.protocol !== "https:" || !uploadHosts.has(url.hostname) ||
    url.username || url.password || url.port || url.hash || !Number.isFinite(Date.parse(data.expires_at)) ||
    Date.parse(data.expires_at) <= Date.now()) throw new Error("Could not confirm a safe video upload destination.");
  return { ...data, upload_protocol: uploadProtocol };
}

const multipartUploadError = "The video upload failed. Try posting again.";

function uploadMultipartVideo(file, reservation, onProgress, createRequest) {
  return new Promise((resolve, reject) => {
    try {
      const request = createRequest();
      const form = new FormData();
      form.append("file", file);
      request.upload.addEventListener("progress", event => {
        if (event.lengthComputable && event.total > 0) onProgress(Math.max(0, Math.min(99, Math.floor(event.loaded / event.total * 100))));
      });
      request.open("POST", reservation.upload_url);
      request.withCredentials = false;
      request.timeout = 10 * 60 * 1000;
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          onProgress(100);
          resolve();
        } else reject(new Error(multipartUploadError));
      };
      request.onerror = () => reject(new Error(multipartUploadError));
      request.ontimeout = () => reject(new Error(multipartUploadError));
      request.onabort = () => reject(new Error(multipartUploadError));
      request.send(form);
    } catch {
      reject(new Error(multipartUploadError));
    }
  });
}

export async function uploadVideoFile(file, reservation, { onProgress = () => {}, createUpload, createRequest = () => new XMLHttpRequest() } = {}) {
  if (Date.parse(reservation.expires_at) <= Date.now()) throw new Error("This video upload expired. Remove the video and choose it again.");
  onProgress(0);
  if (reservation.upload_protocol === "multipart") return uploadMultipartVideo(file, reservation, onProgress, createRequest);
  // Load the protocol client only when somebody uploads a video. It handles
  // offsets and retries so a dropped connection can resume the same upload.
  const factory = createUpload ?? ((file, options) => new tus.Upload(file, options));
  const tus = createUpload ? null : await import("tus-js-client");
  await new Promise((resolve, reject) => {
    const upload = factory(file, {
      uploadUrl: reservation.upload_url, uploadSize: file.size,
      chunkSize: 5 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000],
      storeFingerprintForResuming: false,
      headers: {},
      onProgress: (sent, total) => onProgress(total ? Math.max(0, Math.min(99, Math.floor(sent / total * 100))) : 0),
      onSuccess: () => { onProgress(100); resolve(); },
      onError: () => reject(new Error("The video upload paused. Try posting again to resume it.")),
    });
    upload.start();
  });
}

export async function fetchVideo(id, fetcher = fetch) {
  if (!idPattern.test(id)) throw new Error("Choose a video to view.");
  const { data } = await videoRequest(`/videos/${id}`, "GET", fetcher);
  if (!isMessageVideo(data) || data.id !== id) throw new Error("Invalid video status.");
  return data;
}

export async function completeVideoUpload(id, fetcher = fetch) {
  if (!idPattern.test(id)) throw new Error("Choose a video to upload.");
  const { data } = await videoRequest(`/videos/${id}/complete`, "POST", fetcher);
  if (!isMessageVideo(data) || data.id !== id) throw new Error("Invalid video status.");
  return data;
}

export async function cancelVideoUpload(id, fetcher = fetch) {
  if (!idPattern.test(id)) return;
  await videoRequest(`/videos/${id}`, "DELETE", fetcher);
}
