export const BLOG_PAGE_SIZE = 6;

export const blogPosts = [
  {
    slug: "aivs-the-ai-video-studio",
    title: "aivs - the ai video studio",
    published: "2026-10-25",
    author: "Andrew Arrow",
    summary: "Sue and Joe belong to the screenplay. Ava and Eli are the cast. Building a local AI video studio around that distinction, and the gap between assigning a performer and getting the model to follow directions.",
  },
  {
    slug: "my-wellbeing-does-not-depend-on-my-project",
    title: "my wellbeing does not depend on my project",
    published: "2026-10-25",
    author: "Andrew Arrow",
    summary: "I’d love for people to use what I build. After seventeen projects, I’m trying to stop making my wellbeing depend on whether they do.",
  },
  {
    slug: "my-17-projects-looking-for-number-18",
    title: "My 17 projects, looking for number 18",
    published: "2026-10-23",
    author: "Andrew Arrow",
    summary: "Each commit used to bring me closer to the day people would discover what I built. After enough quiet launches, I’m trying to understand why starting over still feels better than going back.",
  },
  {
    slug: "hosted-videos-with-cloudflare-images-streams",
    title: "Hosted Videos with Cloudflare Images & Streams",
    published: "2026-10-22",
    author: "Yapern",
    summary: "Why we kept images in R2 and chose Stream over Mux, Bunny, and our own video pipeline, plus the upload and cleanup work a managed service still leaves us.",
  },
  {
    slug: "not-a-tavern-a-yapern",
    title: "Not a tavern, a yapern",
    published: "2026-10-21",
    author: "Yapern",
    summary: "How Yapern runs on Cloudflare, from SQLite search and reply trees to live notifications, and why we’re building an open source Reddit.",
  },
  {
    slug: "turso-vs-layerbase-free-plan-sqlite-systems",
    title: "Turso vs Layerbase Free Plan sqlite Systems",
    published: "2026-10-19",
    author: "Yapern",
    summary: "Layerbase completed the write test after its sqld fix. Turso still led reads; fresh connection bursts and batched writes exposed remaining limits.",
  },
  {
    slug: "building-yapern",
    title: "A live message board in a static site",
    published: "2026-10-19",
    author: "Yapern",
    summary: "Yapern started with a local preview. The commits show how real posts, accounts, and replies arrived, and why the site’s API proxy disappeared.",
  },
];

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function blogPageCount(posts = blogPosts) {
  return Math.max(1, Math.ceil(posts.length / BLOG_PAGE_SIZE));
}

export function getBlogPage(posts = blogPosts, page = 1) {
  const pageCount = blogPageCount(posts);
  if (!Number.isInteger(page) || page < 1 || page > pageCount) return null;
  const start = (page - 1) * BLOG_PAGE_SIZE;
  return { page, pageCount, posts: posts.slice(start, start + BLOG_PAGE_SIZE) };
}

export function blogPagePath(page) {
  return page === 1 ? "/blog/" : `/blog/page/${page}/`;
}

export function blogPostPath(slug) {
  return `/blog/${encodeURIComponent(slug)}/`;
}

export function renderBlogPosts(posts) {
  if (!posts.length) return '<li class="blog-entry">No articles yet.</li>';
  return posts.map(({ slug, title, published, author, summary }) => `
    <li class="blog-entry">
      <h2><a href="${escapeHTML(blogPostPath(slug))}">${escapeHTML(title)}</a></h2>
      <p class="blog-meta"><time datetime="${escapeHTML(published)}">${escapeHTML(new Date(`${published}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }))}</time> · ${escapeHTML(author)}</p>
      <p>${escapeHTML(summary)}</p>
    </li>`).join("");
}

export function renderBlogPagination({ page, pageCount }) {
  if (pageCount === 1) return '<p class="blog-page-count">Page 1 of 1</p>';
  const previous = page > 1
    ? `<a href="${blogPagePath(page - 1)}" rel="prev">Previous</a>`
    : '<span aria-disabled="true">Previous</span>';
  const next = page < pageCount
    ? `<a href="${blogPagePath(page + 1)}" rel="next">Next</a>`
    : '<span aria-disabled="true">Next</span>';
  return `<div class="blog-pagination">${previous}<span>Page ${page} of ${pageCount}</span>${next}</div>`;
}

export function renderBlogPage(html, page = 1, posts = blogPosts) {
  const result = getBlogPage(posts, page);
  if (!result) return null;
  const title = page === 1 ? "Blog · Yapern" : `Blog · Page ${page} · Yapern`;
  const url = `https://yapern.com${blogPagePath(page)}`;
  return html
    .replace(/<!-- BLOG_LIST_START -->[\s\S]*?<!-- BLOG_LIST_END -->/, `<!-- BLOG_LIST_START -->${renderBlogPosts(result.posts)}<!-- BLOG_LIST_END -->`)
    .replace(/<!-- BLOG_PAGINATION_START -->[\s\S]*?<!-- BLOG_PAGINATION_END -->/, `<!-- BLOG_PAGINATION_START -->${renderBlogPagination(result)}<!-- BLOG_PAGINATION_END -->`)
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${url}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/>/, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/>/, `<meta property="og:url" content="${url}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*"\s*\/>/, `<meta name="twitter:title" content="${title}" />`)
    .replace(/<meta name="twitter:url" content="[^"]*"\s*\/>/, `<meta name="twitter:url" content="${url}" />`)
    .replace(/<h1>Blog(?: <span class="blog-page-heading">Page \d+<\/span>)?<\/h1>/,
      `<h1>Blog${page === 1 ? "" : ` <span class="blog-page-heading">Page ${page}</span>`}</h1>`);
}
