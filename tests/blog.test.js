import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BLOG_PAGE_SIZE, blogPageCount, getBlogPage, renderBlogPage } from "../src/blog.js";

const template = readFileSync(new URL("../blog/index.html", import.meta.url), "utf8");
const posts = Array.from({ length: BLOG_PAGE_SIZE * 2 + 1 }, (_, index) => ({
  slug: `post-${index + 1}`,
  title: `Post ${index + 1}`,
  published: "2026-10-19",
  author: "Yapern",
  summary: `Summary ${index + 1}`,
}));

test("pagination includes every article once, in order, including a partially filled last page", () => {
  assert.equal(blogPageCount(posts), 3);
  const pages = [1, 2, 3].map(page => getBlogPage(posts, page));
  assert.deepEqual(pages.map(page => page.posts.length), [6, 6, 1]);
  assert.deepEqual(pages.flatMap(page => page.posts), posts);
  for (const page of [0, -1, 4, 1.5, NaN, Infinity, "2"]) assert.equal(getBlogPage(posts, page), null);
  assert.deepEqual(getBlogPage([]), { page: 1, pageCount: 1, posts: [] });
});

test("pagination links point only to available pages, with the first page at /blog/", () => {
  const first = renderBlogPage(template, 1, posts);
  assert.match(first, /href="\/blog\/page\/2\/" rel="next"/);
  assert.doesNotMatch(first, /rel="prev"/);
  const middle = renderBlogPage(template, 2, posts);
  assert.match(middle, /href="\/blog\/" rel="prev"/);
  assert.match(middle, /href="\/blog\/page\/3\/" rel="next"/);
  const last = renderBlogPage(template, 3, posts);
  assert.match(last, /href="\/blog\/page\/2\/" rel="prev"/);
  assert.doesNotMatch(last, /rel="next"/);
  assert.match(last, /Page 3 of 3/);
  const single = renderBlogPage(template, 1, posts.slice(0, BLOG_PAGE_SIZE));
  assert.match(single, /Page 1 of 1/);
  assert.doesNotMatch(single, /rel="(?:prev|next)"/);
  assert.equal(renderBlogPage(template, 4, posts), null);
});

test("generated pages replace existing content and update search and sharing metadata", () => {
  const first = renderBlogPage(template, 1, posts);
  const second = renderBlogPage(first, 2, posts);
  assert.match(second, /<title>Blog · Page 2 · Yapern<\/title>/);
  for (const tag of ['rel="canonical" href', 'property="og:url" content', 'name="twitter:url" content']) {
    assert.ok(second.includes(`${tag}="https://yapern.com/blog/page/2/"`));
  }
  for (const tag of ['property="og:title" content', 'name="twitter:title" content']) {
    assert.ok(second.includes(`${tag}="Blog · Page 2 · Yapern"`));
  }
  assert.match(second, /href="\/blog\/post-7\/"/);
  assert.doesNotMatch(second, /href="\/blog\/post-1\/"/);
  assert.match(second, /<time datetime="2026-10-19">October 19, 2026<\/time>/);
});

test("article data is escaped in static HTML and slugs cannot introduce markup", () => {
  const html = renderBlogPage(template, 1, [{ ...posts[0], slug: '../"<article>',
    title: '<script>alert("title")</script>', author: "A & B", summary: '<img src=x onerror="alert(1)">' }]);
  assert.match(html, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /href="\/blog\/\.\.%2F%22%3Carticle%3E\/"/);
  assert.doesNotMatch(html, /<img src=x|<script>alert/);
});
