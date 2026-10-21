export function replyAnchor(id) {
  return `reply-${id}`;
}

// Branch pages may overlap replies posted locally while a request was in flight.
export function mergeReplyIds(ids, incoming, replies, sort = "new") {
  const merged = [...new Set([...ids, ...incoming])];
  if (sort === "top") return [...new Set([...incoming, ...ids])];
  return merged.sort((a, b) =>
    Date.parse(replies.get(b).created_at) - Date.parse(replies.get(a).created_at) || (a === b ? 0 : a > b ? -1 : 1));
}
