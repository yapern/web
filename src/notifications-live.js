import { readStoredSession } from "./auth.js";
import { createNotificationsApi, isNotificationSnapshot } from "./notifications-api.js";

const retryBaseMs = 1000;
const retryMaxMs = 30_000;
const heartbeatMs = 25_000;
const deadSocketMs = 55_000;

export function createNotificationsLive({ api = createNotificationsApi(), getSession = readStoredSession,
  WebSocketImpl = globalThis.WebSocket, online = () => globalThis.navigator?.onLine !== false,
  random = Math.random, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const subscribers = new Set();
  let session = null;
  let snapshot = null;
  let error = "";
  let loading = false;
  let generation = 0;
  let active = false;
  let socket = null;
  let retryTimer = null;
  let heartbeatTimer = null;
  let connecting = false;
  let connectingGeneration = null;
  let refreshInFlight = null;
  let attempts = 0;
  let lastPongAt = 0;

  function state() { return { session, snapshot, error, loading }; }
  function publish() { for (const subscriber of [...subscribers]) subscriber(state()); }
  function clearTimers() {
    if (retryTimer !== null) clearTimer(retryTimer);
    if (heartbeatTimer !== null) clearTimer(heartbeatTimer);
    retryTimer = heartbeatTimer = null;
  }
  function closeSocket() {
    const current = socket;
    socket = null;
    if (current && current.readyState < 2) {
      current.onopen = current.onmessage = current.onerror = current.onclose = null;
      try { current.close(); } catch { /* A closed socket needs no cleanup. */ }
    }
  }
  function applySnapshot(value, currentGeneration = generation) {
    if (currentGeneration !== generation) return;
    if (!snapshot || value.version >= snapshot.version) snapshot = value;
    error = "";
    loading = false;
    publish();
  }
  function retry(currentGeneration) {
    if (!active || !online() || currentGeneration !== generation || retryTimer !== null) return;
    const base = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts++, 5));
    const delay = Math.min(retryMaxMs, Math.round(base * (0.75 + random() * 0.5)));
    retryTimer = setTimer(() => {
      retryTimer = null;
      void connect(currentGeneration);
    }, delay);
  }
  function retireSocket(current, currentGeneration) {
    if (socket !== current) return;
    socket = null;
    if (heartbeatTimer !== null) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
    current.onopen = current.onmessage = current.onerror = current.onclose = null;
    try { current.close(); } catch { /* The retry below does not depend on a close handshake. */ }
    retry(currentGeneration);
  }
  function startHeartbeat(current, currentGeneration) {
    lastPongAt = now();
    const beat = () => {
      heartbeatTimer = null;
      if (!active || currentGeneration !== generation || socket !== current || current.readyState !== 1) return;
      if (now() - lastPongAt > deadSocketMs) {
        retireSocket(current, currentGeneration);
        return;
      }
      try { current.send("ping"); }
      catch { retireSocket(current, currentGeneration); return; }
      heartbeatTimer = setTimer(beat, heartbeatMs);
    };
    heartbeatTimer = setTimer(beat, heartbeatMs);
  }
  async function connect(currentGeneration = generation) {
    if (!active || !online() || currentGeneration !== generation || connecting || socket || !session || !WebSocketImpl) return;
    connecting = true;
    connectingGeneration = currentGeneration;
    try {
      const ticket = await api.ticket(session);
      if (!active || currentGeneration !== generation || !sameSession(session, getSession())) return;
      const current = new WebSocketImpl(api.socketUrl(session.user.id, ticket));
      socket = current;
      current.onopen = () => {
        if (currentGeneration !== generation || socket !== current) return;
        attempts = 0;
        startHeartbeat(current, currentGeneration);
      };
      current.onmessage = event => {
        if (currentGeneration !== generation || socket !== current) return;
        if (event.data === "pong") { lastPongAt = now(); return; }
        try {
          const value = JSON.parse(event.data);
          if (isNotificationSnapshot(value)) applySnapshot(value, currentGeneration);
        } catch { /* Ignore malformed frames and keep the live connection. */ }
      };
      current.onerror = () => retireSocket(current, currentGeneration);
      current.onclose = event => {
        if (socket !== current) return;
        socket = null;
        current.onopen = current.onmessage = current.onerror = current.onclose = null;
        if (heartbeatTimer !== null) clearTimer(heartbeatTimer);
        heartbeatTimer = null;
        if (event?.code === 4001) {
          void refresh(currentGeneration).then(() => {
            if (active && currentGeneration === generation && session) retry(currentGeneration);
          });
        } else retry(currentGeneration);
      };
    } catch (cause) {
      if (currentGeneration === generation) {
        if (cause?.status === 401) syncSession(getSession());
        else if (!snapshot) { error = "Live notifications are unavailable. Retry to check again."; publish(); }
      }
      retry(currentGeneration);
    } finally {
      if (connectingGeneration === currentGeneration) {
        connecting = false;
        connectingGeneration = null;
      }
    }
  }
  function refresh(currentGeneration = generation) {
    if (!session || !active || !online()) return Promise.resolve();
    if (refreshInFlight?.generation === currentGeneration) return refreshInFlight.promise;
    loading = !snapshot;
    publish();
    const promise = (async () => {
      try {
        const value = await api.snapshot(session);
        applySnapshot(value, currentGeneration);
      } catch (cause) {
        if (currentGeneration !== generation) return;
        loading = false;
        error = cause?.status === 401 ? "Your session has expired. Please sign in again." : "Notifications are unavailable. Check your connection and retry.";
        publish();
        if (cause?.status === 401) syncSession(getSession());
      }
    })();
    refreshInFlight = { generation: currentGeneration, promise };
    const clearRefresh = () => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    };
    void promise.then(clearRefresh, clearRefresh);
    return promise;
  }
  function sameSession(left, right) {
    return Boolean(left && right && left.token === right.token && left.user?.id === right.user?.id);
  }
  function syncSession(nextSession = getSession()) {
    if (sameSession(session, nextSession)) return;
    generation++;
    clearTimers();
    closeSocket();
    connecting = false;
    connectingGeneration = null;
    refreshInFlight = null;
    attempts = 0;
    session = nextSession;
    snapshot = null;
    error = "";
    loading = Boolean(session);
    publish();
    if (session && active && online()) {
      const currentGeneration = generation;
      void refresh(currentGeneration).then(() => connect(currentGeneration));
    }
  }
  function start(nextSession = getSession()) {
    active = true;
    const beforeSync = generation;
    syncSession(nextSession);
    if (generation === beforeSync && session && online() && !socket && retryTimer === null && !connecting) {
      const currentGeneration = generation;
      void refresh(currentGeneration).then(() => connect(currentGeneration));
    }
  }
  function stop() {
    active = false;
    clearTimers();
    closeSocket();
  }
  function subscribe(listener) {
    subscribers.add(listener);
    listener(state());
    return () => subscribers.delete(listener);
  }
  function handleOnline() {
    if (!session) return;
    active = true;
    const currentGeneration = generation;
    void refresh(currentGeneration).then(() => connect(currentGeneration));
  }
  function handleOffline() {
    clearTimers();
    closeSocket();
  }
  return { subscribe, syncSession, start, stop, refresh: () => refresh(), acceptSnapshot: applySnapshot,
    handleOnline, handleOffline, getState: state };
}

export const notificationsApi = createNotificationsApi();
export const notificationsLive = createNotificationsLive({ api: notificationsApi });

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => notificationsLive.stop());
  window.addEventListener("pageshow", () => notificationsLive.start());
  window.addEventListener("online", () => notificationsLive.handleOnline());
  window.addEventListener("offline", () => notificationsLive.handleOffline());
}
