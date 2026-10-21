import { messageBoardConfig } from "./config.js";
import { readStoredSession, storeSession } from "./auth.js";

const unconfirmedMessage = "Could not confirm whether the email was sent. Check the recipient’s inbox before sending again.";

function emailAddress(value, label) {
  const email = typeof value === "string" ? value.trim() : "";
  if (email.length > 254 || /[\x00-\x1f\x7f]/.test(email) ||
    !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) {
    throw new Error(`Enter a valid ${label} email address.`);
  }
  return email;
}

export async function sendMarketingEmail(input, fetcher = fetch) {
  const session = readStoredSession();
  if (!session) throw new Error("Your session has expired. Log in again to send a test email.");
  if (session.user.email.trim().toLowerCase() !== "oneone@gmail.com") {
    throw new Error("You don’t have permission to send marketing emails.");
  }
  const to = emailAddress(input?.to, "recipient");
  const from = emailAddress(input?.from, "sender");
  const subj = typeof input?.subj === "string" ? input.subj.trim() : "";
  if (!subj || subj.length > 998 || /[\x00-\x1f\x7f]/.test(input.subj)) {
    throw new Error("Enter a subject of 1–998 characters without line breaks.");
  }
  if (typeof input?.message !== "string" || !input.message.trim() || input.message.length > 100_000) {
    throw new Error("Enter an email body of 1–100,000 characters.");
  }
  let response;
  try {
    response = await fetcher(new URL("/api/send-marketing-email", messageBoardConfig.apiOrigin), {
      method: "POST", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ to, from, subj, message: input.message, fancy: true }),
    });
  } catch {
    throw new Error(unconfirmedMessage);
  }
  if (response.status === 401) {
    if (readStoredSession()?.token === session.token) storeSession(null);
    throw new Error("Your session has expired. Log in again to send a test email.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const messages = {
      400: "Check the recipient, sender, subject, and body and try again.",
      403: "You don’t have permission to send marketing emails.",
      404: "Email sending is not available on this server yet.",
      409: "This recipient has unsubscribed from marketing emails.",
      413: "This email is too large. Shorten the body and try again.",
      429: "Email sending limit reached. Please try again later.",
      502: "The email service could not send this email. Please try again later.",
      503: payload?.error === "email_preferences_unavailable"
        ? "Could not check this recipient’s email preferences. No email was sent."
        : "Email sending is unavailable. Please try again later.",
    };
    throw new Error(messages[response.status] || unconfirmedMessage);
  }
  if (response.status !== 202 || payload?.ok !== true ||
    typeof payload.messageId !== "string" || !payload.messageId.trim()) {
    throw new Error(unconfirmedMessage);
  }
  return payload;
}
