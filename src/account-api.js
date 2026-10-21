import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

async function requestProfile(name, fetcher) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Log in again to update your name.");
  const { apiOrigin } = messageBoardConfig;
  const url = new URL("/tables/users", apiOrigin);
  url.searchParams.set("id", `eq.${session.user.id}`);
  if (name === undefined) {
    url.searchParams.set("select", "id,name");
    url.searchParams.set("limit", "1");
  }
  let response;
  try {
    response = await fetcher(url, {
      method: name === undefined ? "GET" : "PATCH",
      mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${session.token}`,
        ...(name === undefined ? {} : { "content-type": "application/json" }) },
      ...(name === undefined ? {} : { body: JSON.stringify({ name }) }),
    });
  } catch {
    throw new Error("Could not reach your account. Check your connection and try again.");
  }
  if (response.status === 401) {
    storeSession(null);
    throw new Error("Your session has expired. Log in again to update your name.");
  }
  if (response.status === 403) throw new Error("You don’t have permission to access or update this profile.");
  if (!response.ok) throw new Error("Could not load or save your name. Please try again.");
  const payload = await response.json().catch(() => null);
  const user = payload?.data?.[0];
  if (!Array.isArray(payload?.data) || payload.data.length !== 1 ||
    user?.id !== session.user.id || typeof user.name !== "string" ||
    (name !== undefined && user.name !== name)) {
    throw new Error("Could not confirm your name. Please reload your account and try again.");
  }
  return user;
}

export function fetchProfile(fetcher = fetch) {
  return requestProfile(undefined, fetcher);
}

export function updateName(name, fetcher = fetch) {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 80) throw new Error("Enter a name of 1–80 characters.");
  return requestProfile(cleanName, fetcher);
}

export const emailPreferenceKeys = ["email_notify_replies", "email_notify_votes", "email_notify_sub_yap_messages"];

async function requestEmailPreferences(preferences, fetcher) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Log in again to manage email notifications.");
  let response;
  try {
    response = await fetcher(new URL("/account/email-notifications", messageBoardConfig.apiOrigin), {
      method: preferences === undefined ? "GET" : "PATCH",
      mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${session.token}`,
        ...(preferences === undefined ? {} : { "content-type": "application/json" }) },
      ...(preferences === undefined ? {} : { body: JSON.stringify(preferences) }),
    });
  } catch {
    throw new Error("Could not reach your account. Check your connection and try again.");
  }
  if (response.status === 401) {
    if (readStoredSession()?.token === session.token) storeSession(null);
    throw new Error("Your session has expired. Log in again to manage email notifications.");
  }
  if (response.status === 403) throw new Error("You don’t have permission to manage these email preferences.");
  if (!response.ok) throw new Error("Could not load or save your email preferences. Please try again.");
  const result = await response.json().catch(() => null);
  if (!result || !emailPreferenceKeys.every(key => typeof result[key] === "boolean" &&
      (preferences === undefined || result[key] === preferences[key]))) {
    throw new Error("Could not confirm your email preferences. Please reload your account and try again.");
  }
  return result;
}

export function fetchEmailPreferences(fetcher = fetch) {
  return requestEmailPreferences(undefined, fetcher);
}

export function updateEmailPreferences(preferences, fetcher = fetch) {
  if (!preferences || Object.keys(preferences).length !== emailPreferenceKeys.length ||
      !emailPreferenceKeys.every(key => typeof preferences[key] === "boolean")) {
    throw new Error("Choose an option for each email notification preference.");
  }
  return requestEmailPreferences(preferences, fetcher);
}
