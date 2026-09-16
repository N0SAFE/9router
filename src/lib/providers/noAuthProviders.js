import { FREE_PROVIDERS } from "@/shared/constants/providers";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";

// No-auth (public/free) providers have no connection row, so every catalog that
// iterates provider connections would silently drop them. These helpers add a
// synthetic, credential-free connection for each usable free provider and fetch
// their live model list when the provider declares a modelsFetcher.

const FETCH_TTL_MS = 10 * 60 * 1000;
const fetchCache = new Map();

export function noAuthProviderEntries() {
  return Object.entries(FREE_PROVIDERS)
    .filter(([, provider]) => provider?.noAuth === true && !provider.hidden)
    .map(([id, provider]) => ({
      id,
      name: provider.name || id,
      fetcher: provider.modelsFetcher || null,
    }));
}

/**
 * Append a synthetic active "connection" for every no-auth provider that has
 * no real connection yet. The shape matches a provider connection record with
 * `noAuth: true` so pool aggregation can ignore it while catalogs include it.
 */
export function withNoAuthProviders(connections = []) {
  const present = new Set((connections || []).map((conn) => conn?.provider));
  const synthetic = noAuthProviderEntries()
    .filter((entry) => !present.has(entry.id))
    .map((entry) => ({
      id: `noauth:${entry.id}`,
      provider: entry.id,
      name: entry.name,
      isActive: true,
      noAuth: true,
      providerSpecificData: entry.fetcher ? { modelsFetcher: entry.fetcher } : {},
    }));
  return [...(connections || []), ...synthetic];
}

/**
 * Fetch a no-auth provider's live model list through its modelsFetcher config,
 * reusing the same per-type parsers as the dashboard's suggested-models API.
 * Cached in memory, fail-open to [].
 */
export async function fetchNoAuthModels(fetcher) {
  if (!fetcher?.url || !fetcher?.type) {
    return [];
  }
  const cached = fetchCache.get(fetcher.url);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  const filter = FILTERS[fetcher.type];
  if (!filter) {
    return [];
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(fetcher.url, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!response.ok) {
      return [];
    }
    const json = await response.json();
    const raw = json?.data ?? json?.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    fetchCache.set(fetcher.url, { data, expiresAt: Date.now() + FETCH_TTL_MS });
    return data;
  } catch {
    return [];
  }
}
