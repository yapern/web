export function externalLinkHref(href, siteOrigin) {
  const url = new URL(href);
  if (!["http:", "https:"].includes(url.protocol) || url.origin === siteOrigin ||
      url.searchParams.getAll("source").includes("yapern")) return href;

  // Append without re-encoding existing query parameters; keep fragments last.
  url.search += `${url.search ? "&" : "?"}source=yapern`;
  return url.href;
}
