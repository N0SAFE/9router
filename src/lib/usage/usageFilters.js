/**
 * Usage filtering + aggregation helpers.
 *
 * The Usage page filters (provider, model, connection, status, API key,
 * endpoint, text search) are used by both the API routes and the UI. Daily
 * rollups cannot answer status/search filters, so when any filter is active the
 * aggregates are rebuilt from raw usageHistory rows with these helpers.
 */

export const PERIOD_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "60d": 60 * 24 * 60 * 60 * 1000,
};

export const LOCAL_NO_KEY = "local-no-key";

const FILTER_KEYS = ["provider", "model", "connectionId", "status", "apiKeyId", "endpoint", "q"];

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return `${key.charAt(0)}***`;
  return `${key.slice(0, 8)}***`;
}

/** Extract the supported usage filters from URLSearchParams / an object. */
export function parseUsageFilters(source) {
  const get = typeof source?.get === "function" ? (key) => source.get(key) : (key) => source?.[key];
  const filters = {};
  for (const key of FILTER_KEYS) {
    const value = get(key);
    if (typeof value === "string" && value.trim()) {
      filters[key] = value.trim();
    }
  }
  // Allow the app to pass the raw key directly when it already resolved it.
  const apiKey = get("apiKey");
  if (typeof apiKey === "string" && apiKey.trim()) {
    filters.apiKey = apiKey.trim();
  }
  return filters;
}

export function hasActiveFilters(filters) {
  if (!filters || typeof filters !== "object") return false;
  return FILTER_KEYS.some((key) => typeof filters[key] === "string" && filters[key].length > 0);
}

/** ISO start for a period key ("today", "24h", "7d", …); null means all time. */
export function resolvePeriodStart(period, now = Date.now()) {
  if (!period || period === "all") return null;
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  const ms = PERIOD_MS[period];
  return ms ? new Date(now - ms).toISOString() : null;
}

/** Normalize a usageHistory DB row into the shape used by the aggregators. */
export function normalizeHistoryRow(row) {
  const tokens = row?.tokens && typeof row.tokens === "object" ? row.tokens : {};
  return {
    timestamp: row?.timestamp || null,
    provider: row?.provider || null,
    model: row?.model || null,
    connectionId: row?.connectionId || null,
    apiKey: typeof row?.apiKey === "string" ? row.apiKey : null,
    endpoint: row?.endpoint || null,
    status: row?.status || "success",
    promptTokens: tokens.prompt_tokens ?? row?.promptTokens ?? 0,
    completionTokens: tokens.completion_tokens ?? row?.completionTokens ?? 0,
    cachedTokens: tokens.cached_tokens ?? tokens.cache_read_input_tokens ?? 0,
    cost: typeof row?.cost === "number" ? row.cost : 0,
  };
}

/**
 * Filters that cannot be expressed in SQL (masked key lookup, endpoint and
 * free-text search). `apiKeyRaw` is the resolved key for filters.apiKeyId.
 */
export function matchesJsFilters(row, filters, { apiKeyRaw } = {}) {
  if (!filters) return true;
  if (filters.endpoint && (row.endpoint || "Unknown") !== filters.endpoint) {
    return false;
  }
  if (filters.apiKeyId) {
    if (filters.apiKeyId === LOCAL_NO_KEY) {
      if (row.apiKey) return false;
    } else if (typeof apiKeyRaw === "string" && apiKeyRaw.length > 0) {
      if (row.apiKey !== apiKeyRaw) return false;
    } else {
      return false;
    }
  }
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = [row.model, row.provider, row.connectionName, row.endpoint, row.id]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

const emptyBucket = () => ({ requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 });

function bump(map, key, row, providerDisplayName, extra = {}) {
  if (!map[key]) {
    map[key] = { ...emptyBucket(), ...extra };
  }
  const entry = map[key];
  entry.requests += 1;
  entry.promptTokens += row.promptTokens;
  entry.completionTokens += row.completionTokens;
  entry.cachedTokens += row.cachedTokens;
  entry.cost += row.cost;
  if (row.timestamp && (!entry.lastUsed || new Date(row.timestamp) > new Date(entry.lastUsed))) {
    entry.lastUsed = row.timestamp;
  }
  return entry;
}

/**
 * Build the same aggregate shape as getUsageStats() from normalized rows.
 */
export function aggregateUsageStats(rows, { connectionMap = {}, apiKeyMap = {}, providerNodeNameMap = {} } = {}) {
  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
  };

  for (const row of rows) {
    const providerName = providerNodeNameMap[row.provider] || row.provider || "";
    stats.totalPromptTokens += row.promptTokens;
    stats.totalCompletionTokens += row.completionTokens;
    stats.totalCachedTokens += row.cachedTokens;
    stats.totalCost += row.cost;

    bump(stats.byProvider, row.provider || "unknown", row, providerName);

    const modelKey = row.provider ? `${row.model} (${row.provider})` : row.model;
    bump(stats.byModel, modelKey, row, providerName, {
      rawModel: row.model,
      provider: providerName,
    });

    if (row.connectionId) {
      const accountName = connectionMap[row.connectionId] || `Account ${String(row.connectionId).slice(0, 8)}...`;
      const accountKey = `${row.model} (${row.provider} - ${accountName})`;
      bump(stats.byAccount, accountKey, row, providerName, {
        rawModel: row.model,
        provider: providerName,
        connectionId: row.connectionId,
        accountName,
      });
    }

    if (row.apiKey) {
      const keyInfo = apiKeyMap[row.apiKey];
      const keyName = keyInfo?.name || `${row.apiKey.slice(0, 8)}...`;
      const apiKeyMasked = maskApiKey(row.apiKey);
      const apiKeyKey = `${apiKeyMasked}|${row.model}|${row.provider || "unknown"}`;
      bump(stats.byApiKey, apiKeyKey, row, providerName, {
        rawModel: row.model,
        provider: providerName,
        apiKeyMasked,
        keyName,
        apiKeyKey: apiKeyMasked,
      });
    } else {
      bump(stats.byApiKey, LOCAL_NO_KEY, row, providerName, {
        rawModel: row.model,
        provider: providerName,
        apiKeyMasked: null,
        keyName: "Local (No API Key)",
        apiKeyKey: LOCAL_NO_KEY,
      });
    }

    const endpoint = row.endpoint || "Unknown";
    const endpointKey = `${endpoint}|${row.model}|${row.provider || "unknown"}`;
    bump(stats.byEndpoint, endpointKey, row, providerName, {
      endpoint,
      rawModel: row.model,
      provider: providerName,
    });
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

/** Sum a set of normalized rows (totals only), used for filtered overviews. */
export function sumRowTotals(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.requests += 1;
      acc.promptTokens += row.promptTokens;
      acc.completionTokens += row.completionTokens;
      acc.cachedTokens += row.cachedTokens;
      acc.cost += row.cost;
      return acc;
    },
    { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 }
  );
}

/**
 * Bucket normalized rows for the usage chart, mirroring getChartData():
 * today/24h → 24 hourly buckets; 7d/30d/60d → daily buckets ending today.
 */
export function bucketChartRows(rows, { period = "7d", now = Date.now() } = {}) {
  const hourly = period === "today" || period === "24h";
  const bucketCount = hourly ? 24 : period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const bucketMs = hourly ? 3600000 : 86400000;

  let startTime;
  let labelForIndex;
  if (hourly) {
    const startOfDay = new Date(now);
    if (period === "today") {
      startOfDay.setHours(0, 0, 0, 0);
      startTime = startOfDay.getTime();
    } else {
      startTime = now - bucketCount * bucketMs;
    }
    labelForIndex = (index) =>
      new Date(startTime + index * bucketMs).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  } else {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    startTime = end.getTime() - (bucketCount - 1) * bucketMs;
    labelForIndex = (index) =>
      new Date(startTime + index * bucketMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    label: labelForIndex(index),
    tokens: 0,
    cost: 0,
    requests: 0,
  }));

  for (const row of rows) {
    if (!row.timestamp) continue;
    const time = new Date(row.timestamp).getTime();
    if (!Number.isFinite(time) || time < startTime) continue;
    const index = hourly
      ? Math.min(Math.floor((time - startTime) / bucketMs), bucketCount - 1)
      : Math.min(Math.floor((time - startTime) / bucketMs), bucketCount - 1);
    if (index < 0 || index >= bucketCount) continue;
    buckets[index].tokens += row.promptTokens + row.completionTokens;
    buckets[index].cost += row.cost;
    buckets[index].requests += 1;
  }

  return buckets;
}

/** Top N map entries by a numeric field, as [{ key, value }]. */
export function topEntries(map, field, limit = 5) {
  return Object.entries(map || {})
    .map(([key, entry]) => ({ key, value: entry?.[field] || 0, label: entry?.rawModel || entry?.keyName || key }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
