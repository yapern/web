import { readStoredSession } from "./auth.js";
import { fetchVotes, nextVote, setVote } from "./votes-api.js";

const controllers = new Set();
const controllersByRoot = new WeakMap();
let queued = new Set();
let flushScheduled = false;

function sessionKey(session = readStoredSession()) {
  return session ? `${session.user.id}:${session.token}` : null;
}

function isVisible(controller) {
  return controller.root.isConnected && !controller.root.closest?.("[hidden]");
}

function icon(direction) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", direction === "up" ? "M12 3 5 10h4v11h6V10h4L12 3Z" : "m12 21 7-7h-4V3H9v11H5l7 7Z");
  svg.append(path);
  return svg;
}

function enqueue(controller) {
  queued.add(controller);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => { void flushQueue(); });
}

async function flushQueue() {
  flushScheduled = false;
  const pending = [...queued];
  queued = new Set();
  const batch = pending.filter(controller => {
    if (!isVisible(controller)) { controller.pause(); return false; }
    return controller.loading;
  });
  if (!batch.length) return;
  // Split by target type so each query parameter stays within the API's 100 ID limit.
  const chunks = [];
  for (const readVotes of new Set(batch.map(controller => controller.readVotes))) {
    for (const type of ["message", "reply"]) {
      const typed = batch.filter(controller => controller.readVotes === readVotes && controller.target.type === type);
      for (let offset = 0; offset < typed.length; offset += 100) chunks.push(typed.slice(offset, offset + 100));
    }
  }
  await Promise.all(chunks.map(async chunk => {
    const generations = new Map(chunk.map(controller => [controller, controller.generation]));
    const sessions = new Map(chunk.map(controller => [controller, sessionKey(controller.getSession())]));
    try {
      const rows = await chunk[0].readVotes(chunk.map(controller => controller.target));
      const byId = new Map(rows.map(row => [row.id, row]));
      for (const controller of chunk) {
        if (generations.get(controller) !== controller.generation) continue;
        if (!isVisible(controller)) { controller.pause(); continue; }
        if (sessionKey(controller.getSession()) !== sessions.get(controller)) { controller.refresh(); continue; }
        if (!controller.loading) continue;
        const row = byId.get(controller.target.id);
        if (row) controller.receive(row);
        else controller.fail("Vote count unavailable.");
      }
    } catch (error) {
      for (const controller of chunk) {
        if (generations.get(controller) !== controller.generation) continue;
        if (!isVisible(controller)) { controller.pause(); continue; }
        const session = controller.getSession();
        if (sessionKey(session) !== sessions.get(controller) && !(error?.status === 401 && !session)) {
          controller.refresh();
        } else if (controller.loading) {
          controller.fail(error?.status === 401 ? "Your session expired." :
            error?.message || "Votes are unavailable. Please try again.");
        }
      }
    }
  }));
}

export function createVoteControl(target, { api = { setVote }, getSession = readStoredSession, initialRow } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "live-message-vote-control";
  const root = document.createElement("div");
  root.className = "live-message-votes";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", target.type === "reply" ? "Reply votes" : "Message votes");
  root.setAttribute("aria-busy", "true");

  const up = document.createElement("button");
  up.className = "live-message-vote-button";
  up.type = "button";
  up.setAttribute("aria-label", "Upvote");
  up.setAttribute("aria-pressed", "false");
  up.append(icon("up"));

  const count = document.createElement("span");
  count.className = "live-message-vote-count";
  count.textContent = "…";
  count.setAttribute("aria-label", "Vote count loading");

  const down = document.createElement("button");
  down.className = "live-message-vote-button";
  down.type = "button";
  down.setAttribute("aria-label", "Downvote");
  down.setAttribute("aria-pressed", "false");
  down.append(icon("down"));

  const feedback = document.createElement("span");
  feedback.className = "live-message-vote-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");

  const login = document.createElement("a");
  login.href = "/login/";
  login.textContent = "log in to vote";
  login.className = "live-message-vote-login";
  login.hidden = true;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "live-message-vote-retry";
  retry.textContent = "Retry";
  retry.hidden = true;

  root.append(up, count, down);
  wrapper.append(root, feedback, login, retry);

  const controller = {
    root: wrapper, pill: root, target, up, down, count, feedback, login, retry,
    getSession, readVotes: api.fetchVotes ?? fetchVotes,
    loading: !initialRow, saving: false, row: initialRow ?? null, generation: 0, showLogin: false,
    paused: false, needsRefresh: false, pendingSave: false, observedSession: sessionKey(getSession()),
    render() {
      const busy = this.loading || this.saving;
      root.setAttribute("aria-busy", String(busy));
      up.disabled = busy || !this.row || this.row.user_vote === 1;
      down.disabled = busy || !this.row || this.row.user_vote === -1;
      up.setAttribute("aria-pressed", String(this.row?.user_vote === 1));
      down.setAttribute("aria-pressed", String(this.row?.user_vote === -1));
      if (this.row) {
        count.textContent = String(this.row.score);
        count.setAttribute("aria-label", `${this.row.score} ${this.row.score === 1 ? "vote" : "votes"}`);
      } else if (this.loading) {
        count.textContent = "…";
        count.setAttribute("aria-label", "Vote count loading");
      }
      retry.hidden = !this.feedback.textContent || this.showLogin;
      login.hidden = Boolean(getSession()) || !this.showLogin;
    },
    pause() {
      if (this.paused) return;
      this.generation++;
      this.paused = true;
      this.needsRefresh = true;
      this.loading = false;
      this.saving = false;
      queued.delete(this);
      controllers.delete(this);
      this.render();
    },
    refresh() {
      if (!isVisible(this)) { this.pause(); return; }
      this.generation++;
      this.paused = false;
      this.needsRefresh = false;
      this.observedSession = sessionKey(getSession());
      this.loading = true;
      this.saving = false;
      this.row = null;
      count.textContent = "…";
      count.setAttribute("aria-label", "Vote count loading");
      this.feedback.textContent = "";
      this.showLogin = false;
      this.login.hidden = true;
      this.render();
      // A resumed control must read after its pending write has settled.
      if (!this.pendingSave) enqueue(this);
    },
    receive(row) {
      this.row = row;
      this.loading = false;
      this.saving = false;
      this.showLogin = false;
      this.feedback.textContent = "";
      this.render();
    },
    fail(message) {
      this.loading = false;
      this.saving = false;
      this.feedback.textContent = message;
      this.showLogin = message.toLowerCase().includes("expired") && !getSession();
      if (!this.row) {
        count.textContent = "—";
        count.setAttribute("aria-label", "Vote count unavailable");
      }
      this.render();
    },
    async vote(direction) {
      if (!isVisible(this) || this.paused || this.loading || this.saving || !this.row) return;
      const session = getSession();
      if (!session) {
        this.feedback.textContent = "Please ";
        this.showLogin = true;
        this.render();
        return;
      }
      const value = nextVote(this.row.user_vote, direction);
      if (value === this.row.user_vote) return;
      const key = sessionKey(session);
      const generation = this.generation;
      this.saving = true;
      this.pendingSave = true;
      this.feedback.textContent = "";
      this.render();
      try {
        const updated = await api.setVote(this.target, value);
        if (!isVisible(this)) { this.pause(); return; }
        if (generation !== this.generation) return;
        if (sessionKey(getSession()) !== key) { this.refresh(); return; }
        this.receive(updated);
      } catch (error) {
        if (!isVisible(this)) { this.pause(); return; }
        if (generation !== this.generation) return;
        if (sessionKey(getSession()) !== key && !(error?.status === 401 && !getSession())) { this.refresh(); return; }
        this.saving = false;
        if (!getSession() && error?.status === 401) {
          this.feedback.textContent = "Your session expired. Please ";
          this.showLogin = true;
        } else this.feedback.textContent = error?.message || "Could not save your vote. Please try again.";
        this.render();
      } finally {
        this.pendingSave = false;
        if (generation !== this.generation && isVisible(this)) this.refresh();
      }
    },
  };
  up.addEventListener("click", () => { void controller.vote(1); });
  down.addEventListener("click", () => { void controller.vote(-1); });
  retry.addEventListener("click", () => controller.refresh());
  controllers.add(controller);
  controllersByRoot.set(wrapper, controller);
  controller.render();
  if (!initialRow) enqueue(controller);
  return wrapper;
}

// Reply rows may be detached and reused while their branches are collapsed.
// Keep active controls intact, and recover cached controls without retaining
// every detached row in the active controller set.
export function syncVoteControls(container) {
  for (const controller of controllers) if (!isVisible(controller)) controller.pause();
  const wrappers = [...container.querySelectorAll(".live-message-vote-control")];
  if (container.matches?.(".live-message-vote-control")) wrappers.unshift(container);
  for (const wrapper of wrappers) {
    const controller = controllersByRoot.get(wrapper);
    if (!controller || !isVisible(controller)) continue;
    controllers.add(controller);
    if (controller.paused || controller.needsRefresh || controller.observedSession !== sessionKey(controller.getSession())) {
      controller.refresh();
    }
  }
}

function refreshConnected() {
  for (const controller of controllers) {
    if (!isVisible(controller)) controller.pause();
    else controller.refresh();
  }
}

for (const event of ["pageshow", "focus", "storage"]) window.addEventListener(event, refreshConnected);
