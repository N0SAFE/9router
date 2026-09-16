import { AI_PROVIDERS } from "@/shared/constants/providers";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";

// Provider model lists should come from the provider whenever it exposes one.
// A provider opts in through its registry entry:
//
//   modelsFetcher: { url: "…", type: "…", auth: "bearer" | "api-key" }
//
// `auth` is optional: when set, the fetch carries the connection's own
// credential (never a global one). Results are cached in memory and fail-open
// so callers fall back to the registry's static list.

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const cache = new Map();

export function modelsFetcherFor(providerId) {
  return AI_PROVIDERS[providerId]?.modelsFetcher || null;
}

function authHeaders(fetcher, connection) {
  const headers = { Accept: "application/json" };
  const token = connection?.apiKey || connection?.accessToken || "";
  if (!token) {
    return headers;
  }
  if (fetcher.auth === "api-key") {
    headers["x-api-key"] = token;
  } else if (fetcher.auth === "bearer") {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Parse a provider's model list payload into `{ id, name }` entries.
 * Types with a dashboard filter reuse the same parser; provider-specific
 * shapes are handled here.
 */
export function parseFetcherPayload(type, json) {
  const filter = FILTERS[type];
  if (filter) {
    const raw = json?.data ?? json?.models ?? json;
    return filter(Array.isArray(raw) ? raw : []);
  }

  if (type === "ollama-tags") {
    const raw = Array.isArray(json?.models) ? json.models : [];
    return raw
      .map((model) => ({
        id: model?.model || model?.name,
        name: model?.name || model?.model,
      }))
      .filter((model) => typeof model.id === "string" && model.id.trim() !== "");
  }

  // Full OpenRouter catalog: keep chat models, flag free ones (pricing 0/0).
  if (type === "openrouter-all") {
    const raw = Array.isArray(json?.data) ? json.data : [];
    return raw
      .filter((model) => {
        const outputs = model?.architecture?.output_modalities;
        return Array.isArray(outputs) && outputs.length > 0
          ? outputs.includes("text")
          : true;
      })
      .map((model) => ({
        id: model?.id,
        name: model?.name || model?.id,
        free: model?.pricing?.prompt === "0" && model?.pricing?.completion === "0",
        contextLength: model?.context_length,
      }))
      .filter((model) => typeof model.id === "string" && model.id.trim() !== "");
  }

  if (type === "openai") {
    const raw = Array.isArray(json?.data) ? json.data : [];
    return raw
      .map((model) => ({ id: model?.id, name: model?.name || model?.id }))
      .filter((model) => typeof model.id === "string" && model.id.trim() !== "");
  }

  return [];
}

function cacheKey(providerId, fetcher, connection) {
  const fingerprint = (connection?.apiKey || connection?.accessToken || "").slice(-8);
  return [providerId, connection?.id || "", fetcher.url, fingerprint].join("|");
}

/**
 * Fetch a provider's live model list for one connection. Authenticated with
 * that connection's credential when the fetcher requires it. Returns [] on any
 * failure (caller keeps the static registry list).
 */
export async function fetchConnectionModels(providerId, connection, options = {}) {
  const fetcher = options.fetcher || modelsFetcherFor(providerId);
  if (!fetcher?.url || !fetcher?.type) {
    return [];
  }

  const key = cacheKey(providerId, fetcher, connection);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.models;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
    const response = await fetch(fetcher.url, {
      headers: authHeaders(fetcher, connection),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!response.ok) {
      return [];
    }
    const models = parseFetcherPayload(fetcher.type, await response.json());
    if (models.length > 0) {
      cache.set(key, { models, expiresAt: Date.now() + (options.ttlMs ?? CACHE_TTL_MS) });
    }
    return models;
  } catch {
    return [];
  }
}
