import { fetchVideo, isMessageVideo } from "./videos-api.js";

export function messageCaption(message) {
  if (!message.video) return message.body;
  // The first line is retained by the API for older clients. Structured media
  // drives this renderer, so do not render that line as an image or duplicate link.
  return message.body.replace(/^https:\/\/(?:customer-[a-z0-9-]+\.cloudflarestream\.com|videodelivery\.net)\/[a-f0-9]{32}\/watch(?:\n|$)/, "");
}

export function messageVideoElement(initialVideo, title = "Video") {
  if (!isMessageVideo(initialVideo)) return null;
  const container = document.createElement("div");
  container.className = "stream-message-video";
  let checks = 0;

  function render(video) {
    if (video.status === "ready") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stream-video-poster";
      button.setAttribute("aria-label", `Play video: ${title}`);
      const portrait = video.height > video.width;
      container.classList.toggle("is-portrait", portrait);
      container.style.setProperty("--video-ratio", `${video.width} / ${video.height}`);
      const poster = document.createElement("img");
      poster.alt = "";
      poster.src = video.thumbnail_url;
      poster.width = video.width;
      poster.height = video.height;
      poster.loading = "lazy";
      poster.decoding = "async";
      const label = document.createElement("span");
      label.className = "stream-video-play";
      const seconds = Math.ceil(video.duration);
      label.textContent = `▶ Play · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      button.append(poster, label);
      button.addEventListener("click", () => {
        const player = document.createElement("iframe");
        const url = new URL(video.player_url);
        url.searchParams.set("autoplay", "true");
        url.searchParams.set("preload", "none");
        player.src = url.href;
        player.title = title;
        player.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
        player.allowFullscreen = true;
        player.referrerPolicy = "strict-origin-when-cross-origin";
        container.replaceChildren(player);
        player.focus();
      });
      container.replaceChildren(button);
      return;
    }
    const status = document.createElement("p");
    status.className = "stream-video-status";
    status.setAttribute("role", "status");
    status.textContent = video.status === "failed" ? "Video unavailable." : "Video is processing…";
    container.replaceChildren(status);
    if (video.status === "failed") return;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "stream-video-retry";
    retry.textContent = "Check again";
    let checking = false;
    async function check() {
      if (checking || !container.isConnected) return;
      checking = true;
      retry.disabled = true;
      try { render(await fetchVideo(video.id)); }
      catch {
        status.textContent = "Video status is unavailable. Check again.";
        retry.disabled = false;
      } finally { checking = false; }
    }
    retry.addEventListener("click", check);
    container.append(retry);
    if (checks++ < 12) setTimeout(() => { if (document.visibilityState !== "hidden") void check(); }, 5000);
  }
  render(initialVideo);
  return container;
}
