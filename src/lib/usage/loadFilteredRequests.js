/**
 * Load usage rows (request details merged with history) for the insights and
 * fix-prompt endpoints, with the full global filter set applied.
 *
 * History rows can be filtered in SQL for provider/model/connection/status/date
 * and API key; endpoint and free-text search are applied in JS. Detail rows do
 * not carry a key or endpoint, so when those filters are active they are kept
 * only when their history twin (same provider/model/connection/time) survived.
 */

import { getRequestDetailsInRange, getUsageHistory } from "@/lib/usageDb";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { mergeUsageRows, usageOverlapKey } from "./mergeDetails.js";
import { LOCAL_NO_KEY, matchesJsFilters, resolvePeriodStart } from "./usageFilters.js";

export const MAX_REQUEST_ROWS = 2000;

/** Resolve a key id (or name) to the raw key value used in usageHistory. */
export async function resolveApiKeyRaw(apiKeyId) {
  if (!apiKeyId || apiKeyId === LOCAL_NO_KEY) return null;
  try {
    const keys = await getApiKeys();
    const found = keys.find((key) => key.id === apiKeyId || key.name === apiKeyId);
    return found?.key || null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ rows: Array<object>, details: number, history: number,
 *             apiKeyRaw: string|null, startDate: string|null, endDate: string|null }}
 */
export async function loadFilteredUsageRequests({ period = "7d", startDate, endDate, filters = {}, limit = 500 } = {}) {
  const rangeStart = startDate || resolvePeriodStart(period) || undefined;
  const rangeEnd = endDate || filters.endDate || undefined;
  const baseFilter = {
    provider: filters.provider,
    model: filters.model,
    connectionId: filters.connectionId,
    status: filters.status,
    startDate: rangeStart,
    endDate: rangeEnd,
  };

  const apiKeyRaw = await resolveApiKeyRaw(filters.apiKeyId);
  const historyFilter = apiKeyRaw ? { ...baseFilter, apiKey: apiKeyRaw } : baseFilter;

  const [details, history, connections] = await Promise.all([
    getRequestDetailsInRange(baseFilter, limit),
    getUsageHistory(historyFilter),
    getProviderConnections().catch(() => []),
  ]);

  const connectionNames = new Map(
    (connections || []).map((conn) => [
      conn.id,
      conn.displayName || conn.name || conn.email || conn.id,
    ])
  );

  const historyRows = history.filter((row) => matchesJsFilters(row, { endpoint: filters.endpoint, q: filters.q }));
  const needsOverlapFilter = Boolean(filters.endpoint || filters.q || apiKeyRaw);
  const detailRows = needsOverlapFilter
    ? details.filter((row) => new Set(historyRows.map(usageOverlapKey)).has(usageOverlapKey(row)))
    : details;

  const merged = mergeUsageRows(detailRows, historyRows)
    .map((row) =>
      row.connectionId && !row.connectionName
        ? { ...row, connectionName: connectionNames.get(row.connectionId) || null }
        : row
    )
    .slice(0, Math.min(Math.max(limit, 200), MAX_REQUEST_ROWS));

  return {
    rows: merged,
    details: detailRows.length,
    history: historyRows.length,
    apiKeyRaw,
    startDate: rangeStart || null,
    endDate: rangeEnd || null,
  };
}
