import { FREE_PROVIDERS } from "@/shared/constants/providers";

// No-auth (public/free) providers have no connection row, so every catalog that
// iterates provider connections would silently drop them. These helpers add a
// synthetic, credential-free connection for each usable free provider. Their
// model lists come from the provider's `modelsFetcher` (liveModels.js) exactly
// like credentialed providers.

export function noAuthProviderEntries() {
  return Object.entries(FREE_PROVIDERS)
    .filter(([, provider]) => provider?.noAuth === true && !provider.hidden)
    .map(([id, provider]) => ({
      id,
      name: provider.name || id,
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
      providerSpecificData: {},
    }));
  return [...(connections || []), ...synthetic];
}
