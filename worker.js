import { boardLogoUrl } from "./src/board-logo.js";
import { parseBoardRoute } from "./src/board-routes.js";
import { messageBoardConfig } from "./src/config.js";

export async function fetchBoardMetadata(slug, {
  apiOrigin = messageBoardConfig.apiOrigin, fetcher = fetch, cache, waitUntil,
} = {}) {
  let board;
  try {
    const url = new URL("/tables/boards", apiOrigin);
    url.search = new URLSearchParams({ select: "slug,name,description,logo_url", slug: `eq.${slug}`, limit: "1" });
    const cached = await cache?.match(url);
    const response = cached || await fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const result = await response.json();
      const candidate = result?.data?.[0];
      if (Array.isArray(result?.data) && result.data.length === 1 && candidate?.slug === slug &&
        typeof candidate.name === "string" && typeof candidate.description === "string") {
        board = candidate;
        if (!cached && cache) {
          const saving = cache.put(url, Response.json({ data: [board] }, {
            headers: { "Cache-Control": "public, max-age=60" },
          })).catch(() => {});
          if (waitUntil) waitUntil(saving);
          else await saving;
        }
      }
    }
  } catch { /* Keep the page usable when the API is unavailable. */ }

  const name = board?.name.trim() || `y/${slug}`;
  const image = boardLogoUrl(board?.logo_url, apiOrigin);
  return {
    title: `${name} · Yapern`,
    description: board?.description.trim() || `Messages in y/${slug} on Yapern.`,
    url: `https://yapern.com/y/${slug}`,
    image: image || "https://yapern.com/images/logo.png",
    imageAlt: image ? `${name} logo` : "Yapern logo",
  };
}

export default {
  async fetch(request, env, ctx) {
    const route = parseBoardRoute(new URL(request.url).pathname);
    if (!route || route.messageId !== undefined || !["GET", "HEAD"].includes(request.method)) {
      return env.ASSETS.fetch(request);
    }

    // Do not reuse the shell's conditional or range response for dynamic HTML.
    const asset = await env.ASSETS.fetch(new Request(new URL("/board", request.url), { method: request.method }));
    if (asset.status !== 200 || !asset.headers.get("content-type")?.includes("text/html")) return asset;
    const response = new Response(asset.body, asset);
    for (const header of ["etag", "last-modified", "content-length"]) response.headers.delete(header);
    response.headers.set("Cache-Control", "no-store");
    if (request.method === "HEAD") return response;

    const metadata = await fetchBoardMetadata(route.slug, {
      apiOrigin: env.API_ORIGIN, cache: caches.default, waitUntil: promise => ctx.waitUntil(promise),
    });
    const content = {
      description: metadata.description,
      "og:title": metadata.title, "twitter:title": metadata.title,
      "og:description": metadata.description, "twitter:description": metadata.description,
      "og:image": metadata.image, "twitter:image": metadata.image,
      "og:image:alt": metadata.imageAlt, "twitter:image:alt": metadata.imageAlt,
    };
    return new HTMLRewriter()
      .on("title", { element(element) { element.setInnerContent(metadata.title); } })
      .on("head", {
        element(element) {
          element.append(`<link rel="canonical" href="${metadata.url}" /><meta property="og:url" content="${metadata.url}" /><meta name="twitter:url" content="${metadata.url}" />`, { html: true });
        },
      })
      .on("meta", {
        element(element) {
          const key = element.getAttribute("property") || element.getAttribute("name");
          if (Object.hasOwn(content, key)) element.setAttribute("content", content[key]);
        },
      })
      .transform(response);
  },
};
