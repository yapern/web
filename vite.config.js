import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blogPageCount, blogPosts, blogPagePath, renderBlogPage } from "./src/blog.js";

export function staticBlogPlugin(posts = blogPosts) {
  function pageRoutes(server, preview = false) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/blog/page" && !url.pathname.startsWith("/blog/page/")) return next();
      const match = url.pathname.match(/^\/blog\/page\/([1-9]\d*)\/?$/);
      const page = match ? Number(match[1]) : NaN;
      if (!Number.isInteger(page) || page < 2 || page > blogPageCount(posts)) {
        response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        response.end(readFileSync(new URL("./public/404.html", import.meta.url), "utf8"));
        return;
      }
      if (!url.pathname.endsWith("/")) {
        response.writeHead(308, { Location: `${blogPagePath(page)}${url.search}` });
        response.end();
        return;
      }
      if (preview) return next();
      try {
        const template = readFileSync(new URL("./blog/index.html", import.meta.url), "utf8");
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await server.transformIndexHtml(url.pathname, template));
      } catch (error) {
        next(error);
      }
    });
  }
  return {
    name: "static-blog",
    configureServer(server) { pageRoutes(server); },
    configurePreviewServer(server) { pageRoutes(server, true); },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        if (!html.includes("<!-- BLOG_LIST_START -->")) return html;
        const match = context.path.match(/^\/blog\/page\/(\d+)\/?$/);
        return renderBlogPage(html, match ? Number(match[1]) : 1, posts);
      },
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const index = bundle["blog/index.html"];
        if (!index || index.type !== "asset") throw new Error("Blog index was not emitted");
        for (let page = 2; page <= blogPageCount(posts); page += 1) {
          this.emitFile({ type: "asset", fileName: `blog/page/${page}/index.html`, source: renderBlogPage(String(index.source), page, posts) });
        }
      },
    },
  };
}

function boardPageRoutes(server) {
  server.middlewares.use((request, response, next) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/y/")) {
      request.url = `/board.html${url.search}`;
    }
    next();
  });
}

function pageRedirects(server) {
  server.middlewares.use((request, response, next) => {
    const match = request.url?.match(/^\/(privacy|terms|download|login|account|blog|blog\/building-yapern|blog\/turso-vs-layerbase-free-plan-sqlite-systems)(\?.*)?$/);
    if (!match) {
      next();
      return;
    }
    response.writeHead(308, {
      Location: `/${match[1]}/${match[2] ?? ""}`,
    });
    response.end();
  });
}

export default defineConfig({
  base: "/",
  publicDir: "public",
  plugins: [
    {
      name: "shared-site-header",
      transformIndexHtml(html, context) {
        if (!html.includes("<!-- site-header -->")) return html;
        let header = readFileSync(new URL("./src/site-header.html", import.meta.url), "utf8");
        if (context.path.startsWith("/blog/")) header = header.replace('href="/blog/"', 'href="/blog/" aria-current="page"');
        return html.replace("    <!-- site-header -->\n", header);
      },
    },
    {
      name: "board-page-routes",
      configureServer: boardPageRoutes,
      configurePreviewServer: boardPageRoutes,
    },
    {
      name: "page-redirects",
      configureServer: pageRedirects,
      configurePreviewServer: pageRedirects,
    },
    staticBlogPlugin(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        login: fileURLToPath(new URL("./login/index.html", import.meta.url)),
        account: fileURLToPath(new URL("./account/index.html", import.meta.url)),
        board: fileURLToPath(new URL("./board.html", import.meta.url)),
        download: fileURLToPath(new URL("./download/index.html", import.meta.url)),
        privacy: fileURLToPath(new URL("./privacy/index.html", import.meta.url)),
        terms: fileURLToPath(new URL("./terms/index.html", import.meta.url)),
        blog: fileURLToPath(new URL("./blog/index.html", import.meta.url)),
        blogArticle: fileURLToPath(new URL("./blog/building-yapern/index.html", import.meta.url)),
        blogTursoLayerbase: fileURLToPath(new URL("./blog/turso-vs-layerbase-free-plan-sqlite-systems/index.html", import.meta.url)),
      },
    },
  },
});
