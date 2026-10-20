const posts = [
  {
    id: "small-web",
    community: "technology",
    user: "pixelwanderer",
    age: "2h",
    votes: 248,
    comments: 42,
    type: "Discussion",
    title: "What’s a tiny corner of the internet you still love?",
    excerpt:
      "Personal websites, weird little tools, forums that never changed. Share your favorites.",
    reply:
      "The little forums where someone has been answering the same niche question for twenty years. Absolute legends.",
    author: "quietlycurious",
  },
  {
    id: "weekend-build",
    community: "making",
    user: "sawdustandcoffee",
    age: "4h",
    votes: 186,
    comments: 28,
    type: "Show & tell",
    title: "A weekend, some scrap wood, and a very wonky bookshelf.",
    excerpt: "First real project. It’s not perfectly straight, but it’s mine.",
    reply:
      "The best part is that you made it. My first shelf still has pride of place ten years later.",
    author: "measuretwice",
  },
  {
    id: "one-more-chapter",
    community: "books",
    user: "one_more_chapter",
    age: "1h",
    votes: 94,
    comments: 36,
    type: "Question",
    title: "Which book made you forget to check your phone?",
    excerpt:
      "Looking for the kind of story that makes “one more chapter” a terrible promise.",
    reply:
      "Piranesi. Go in knowing as little as possible, and give yourself a quiet afternoon.",
    author: "marginnotes",
  },
  {
    id: "balcony-garden",
    community: "gardening",
    user: "growing_slowly",
    age: "30m",
    votes: 72,
    comments: 19,
    type: "Discussion",
    title: "Small balcony gardeners: what actually survived your first summer?",
    excerpt:
      "My basil has opinions about the sun. I’m ready to listen to yours.",
    reply:
      "Rosemary and thyme have survived everything I’ve thrown at them. Start with one pot and go from there.",
    author: "rootsandall",
  },
];
const state = {
  community: "all",
  sort: "top",
  query: "",
  votes: new Map(),
  saved: new Set(),
  expanded: new Set(),
};
const container = document.querySelector("#posts");
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#${name}"/></svg>`;
const status = (message) => {
  document.querySelector("#preview-status").textContent = message;
};
function render() {
  let visible = posts.filter(
    (post) =>
      (state.community === "all" || post.community === state.community) &&
      `${post.title} ${post.excerpt} ${post.community}`
        .toLowerCase()
        .includes(state.query) &&
      (state.sort !== "saved" || state.saved.has(post.id)),
  );
  if (state.sort === "new")
    visible.sort(
      (a, b) =>
        ({
          "balcony-garden": 0,
          "one-more-chapter": 1,
          "small-web": 2,
          "weekend-build": 3,
        })[a.id] -
        {
          "balcony-garden": 0,
          "one-more-chapter": 1,
          "small-web": 2,
          "weekend-build": 3,
        }[b.id],
    );
  else
    visible.sort(
      (a, b) =>
        b.votes +
        (state.votes.get(b.id) || 0) -
        a.votes -
        (state.votes.get(a.id) || 0),
    );
  visible = visible.slice(0, 3);
  container.innerHTML = visible.length
    ? visible
        .map((post) => {
          const vote = state.votes.get(post.id) || 0;
          const saved = state.saved.has(post.id);
          const expanded = state.expanded.has(post.id);
          return `<article class="post" data-post="${post.id}"><div class="post-votes"><button class="vote-button" type="button" data-action="upvote" aria-label="Upvote: ${post.title}" aria-pressed="${vote === 1}">${icon("up")}</button><span class="vote-count">${post.votes + vote}</span><button class="vote-button" type="button" data-action="downvote" aria-label="Downvote: ${post.title}" aria-pressed="${vote === -1}">${icon("down")}</button></div><div><p class="post-meta"><span class="post-community">y/${post.community}</span><span>· ${post.user} · ${post.age}</span></p><h3>${post.title}</h3><p class="post-excerpt">${post.excerpt}</p><div class="post-actions"><button type="button" data-action="comments" aria-expanded="${expanded}" aria-controls="comments-${post.id}">${icon("chat")}${post.comments} replies</button><button type="button" data-action="save" aria-pressed="${saved}" aria-label="${saved ? "Unsave" : "Save"}: ${post.title}">${icon("bookmark")}${saved ? "Saved" : "Save"}</button><span class="post-type">${post.type}</span></div><div class="comment-preview" id="comments-${post.id}" ${expanded ? "" : "hidden"}><strong>${post.author}</strong><p>${post.reply}</p></div></div></article>`;
        })
        .join("")
    : `<p class="empty-message">${state.sort === "saved" ? "No saved posts here yet. Save a post to come back to it." : "No posts found. Try another search or sub-yap."}</p>`;
}
function updatePreservingFocus(action) {
  const button = document.activeElement;
  const postId = button.closest("[data-post]")?.dataset.post;
  const actionName = button.dataset.action;
  action();
  render();
  if (postId && actionName)
    container
      .querySelector(`[data-post="${postId}"] [data-action="${actionName}"]`)
      ?.focus({ preventScroll: true });
}
container.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = button.closest("[data-post]").dataset.post;
  const action = button.dataset.action;
  updatePreservingFocus(() => {
    if (action === "upvote" || action === "downvote") {
      const value = action === "upvote" ? 1 : -1;
      state.votes.set(id, state.votes.get(id) === value ? 0 : value);
      status("Preview vote updated.");
    } else if (action === "save") {
      state.saved.has(id) ? state.saved.delete(id) : state.saved.add(id);
      status(
        state.saved.has(id)
          ? "Post saved in this preview."
          : "Post removed from saved.",
      );
    } else {
      state.expanded.has(id)
        ? state.expanded.delete(id)
        : state.expanded.add(id);
    }
  });
});
document.querySelectorAll("[data-community]").forEach((button) =>
  button.addEventListener("click", () => {
    state.community = button.dataset.community;
    document.querySelectorAll("[data-community]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    document.querySelector("#feed-title").textContent =
      state.community === "all"
        ? "The conversation starts here."
        : `y/${state.community}`;
    render();
    status(
      state.community === "all"
        ? "Showing all sample sub-yaps."
        : `Showing ${state.community} sample posts.`,
    );
  }),
);
document.querySelectorAll("[data-sort]").forEach((button) =>
  button.addEventListener("click", () => {
    state.sort = button.dataset.sort;
    document.querySelectorAll("[data-sort]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    render();
    status(`Showing ${state.sort} sample posts.`);
  }),
);
document.querySelector("#post-search").addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});
render();
