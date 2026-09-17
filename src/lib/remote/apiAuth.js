import { getApiKeys, getSettings, validateApiKey } from "@/lib/localDb";

/**
 * API-key auth for the /api/v1 remote + agent session endpoints (the /v1
 * prefix is public, so handlers validate the key themselves, honoring the
 * requireApiKey setting like the chat endpoint does).
 */
export async function authorizeApiKey(request) {
  let settings = {};
  try {
    settings = await getSettings();
  } catch {
    settings = {};
  }
  if (settings.requireApiKey === false) {
    return true;
  }
  const header = request.headers.get("Authorization") || "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) {
    return false;
  }
  try {
    if (await validateApiKey(key)) {
      return true;
    }
  } catch {
    // fall back to the key list
  }
  try {
    const keys = await getApiKeys();
    return keys.some((entry) => entry.isActive !== false && entry.key === key);
  } catch {
    return false;
  }
}

/**
 * Base URL the harness CLIs should use for models. Loopback when the request
 * comes through localhost; otherwise assume the default local port.
 */
export function resolveRouterRoot(request) {
  try {
    const url = new URL(request.url);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
      return url.origin;
    }
  } catch {
    // fall through
  }
  return `http://127.0.0.1:${process.env.PORT || 20128}`;
}

/** First active API key (for harness env when the caller is local). */
export async function firstApiKey() {
  try {
    const keys = await getApiKeys();
    return keys.find((entry) => entry.isActive !== false)?.key || "";
  } catch {
    return "";
  }
}
