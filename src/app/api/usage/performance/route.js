import { NextResponse } from "next/server";
import { getUsagePerformanceRows } from "@/lib/usageDb";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { matchesJsFilters, parseUsageFilters, resolvePeriodStart } from "@/lib/usage/usageFilters.js";
import { resolveApiKeyRaw } from "@/lib/usage/loadFilteredRequests";
import { PERFORMANCE_DIMENSIONS, aggregatePerformance } from "@/lib/usage/performance.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/performance
 * Query: period, dimension (model|provider|connection|apiKey|endpoint), key
 *        (restrict the trend chart to one dimension value) plus the shared
 *        usage filters (provider, model, connectionId, status, apiKeyId,
 *        endpoint, q, startDate, endDate).
 *
 * Returns throughput/latency metrics per dimension and a time series.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const dimension = PERFORMANCE_DIMENSIONS.some((entry) => entry.id === searchParams.get("dimension"))
      ? searchParams.get("dimension")
      : "model";
    const seriesKey = searchParams.get("key") || null;
    const filters = parseUsageFilters(searchParams);

    const startDate = searchParams.get("startDate") || resolvePeriodStart(period);
    const endDate = searchParams.get("endDate") || undefined;
    const apiKeyRaw = await resolveApiKeyRaw(filters.apiKeyId);

    const filter = {
      provider: filters.provider,
      model: filters.model,
      connectionId: filters.connectionId,
      status: filters.status,
      startDate: startDate || undefined,
      endDate,
    };
    if (apiKeyRaw) filter.apiKey = apiKeyRaw;

    const rows = await getUsagePerformanceRows(filter);
    const filtered = rows.filter((row) =>
      matchesJsFilters(row, { endpoint: filters.endpoint, q: filters.q, apiKeyId: filters.apiKeyId }, { apiKeyRaw })
    );

    const [connections, keys] = await Promise.all([
      getProviderConnections().catch(() => []),
      getApiKeys().catch(() => []),
    ]);
    const connectionNames = Object.fromEntries(
      (connections || []).map((connection) => [
        connection.id,
        connection.displayName || connection.name || connection.email || connection.id,
      ])
    );
    const apiKeyNames = Object.fromEntries((keys || []).map((key) => [key.key, key.name]));

    const payload = aggregatePerformance(filtered, {
      dimension,
      connectionNames,
      apiKeyNames,
      period,
      seriesKey,
      seriesDimension: dimension,
    });

    return NextResponse.json(
      {
        period,
        startDate: startDate || null,
        endDate: endDate || null,
        dimensions: PERFORMANCE_DIMENSIONS,
        ...payload,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to build performance metrics:", error);
    return NextResponse.json({ error: "Failed to build performance metrics" }, { status: 500 });
  }
}
