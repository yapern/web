// Web equivalent of Groupicorn's MessageLinkParser: preserve the text and
// make detected web addresses clickable, allowing only HTTP and HTTPS.
const linkPattern = /[a-z][a-z\d+.-]*:\/\/[^\s<>"'`“”‘’]+|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?![\p{L}\p{N}_-])(?::\d+)?(?:[/?#][^\s<>"'`“”‘’]*)?/giu;

function trimLink(candidate) {
  const brackets = { ")": "(", "]": "[", "}": "{" };
  let value = candidate;
  while (value) {
    const last = value.at(-1);
    if (/[.,!?;:]/.test(last)) {
      value = value.slice(0, -1);
    } else if (brackets[last] && value.split(last).length > value.split(brackets[last]).length) {
      // Keep balanced parentheses in URLs, but leave prose punctuation outside.
      value = value.slice(0, -1);
    } else {
      break;
    }
  }
  return value;
}

export function serializeMessageBody(text, linkUrl, imageUrl = "") {
  const url = linkUrl.trim();
  const body = text.trim();
  const linkedBody = url ? (body ? `${url}\n\n${body}` : url) : body;
  return imageUrl ? `${imageUrl}\n${linkedBody}` : linkedBody;
}

export function parseMessageText(text) {
  const parts = [];
  const firstLineEnd = text.indexOf("\n");
  let position = 0;
  for (const match of text.matchAll(linkPattern)) {
    const start = match.index;
    // Avoid matching inside email addresses, paths, or another URL scheme.
    if (start > 0 && /[\p{L}\p{N}_@./\\:+-]/u.test(text[start - 1])) continue;
    const value = trimLink(match[0]);
    let url;
    try {
      url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      continue;
    }
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) continue;
    if (start > position) parts.push({ text: text.slice(position, start) });
    const part = { text: value, href: url.href };
    const youtubeHost = ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname.toLowerCase());
    const videoId = url.pathname === "/watch" ? url.searchParams.get("v") : null;
    if (youtubeHost && videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      part.youtubeEmbed = `https://www.youtube.com/embed/${videoId}`;
    }
    // Fetched previews can use extensionless CDN URLs or favicon URLs. A
    // standalone first line is an image candidate; the renderer restores the
    // text link if it cannot load as an image.
    const isPreviewLine = start === 0 && firstLineEnd >= 0 &&
      value === text.slice(0, firstLineEnd).trimEnd() && /^https?:\/\//i.test(value);
    if (!part.youtubeEmbed && (/\.(?:png|gif|jpe?g|webp)$/i.test(url.pathname) || isPreviewLine)) {
      part.imageUrl = url.href;
    }
    parts.push(part);
    position = start + value.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position) });
  return parts;
}
