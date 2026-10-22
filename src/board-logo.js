import { messageBoardConfig } from "./config.js";

export const boardLogoPathPattern = /^\/board-logos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/i;

export function boardLogoUrl(value, apiOrigin = messageBoardConfig.apiOrigin) {
  if (typeof value !== "string" || !boardLogoPathPattern.test(value)) return null;
  try {
    const origin = new URL(apiOrigin);
    const url = new URL(value, origin);
    return url.origin === origin.origin && url.pathname === value && !url.search && !url.hash ? url.href : null;
  } catch {
    return null;
  }
}
