import { NextResponse } from "next/server";
import { getRequestDetailsInRange, getUsageHistory } from "@/lib/usageDb";
import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getPricingForModel, calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { mergeUsageRows } from "@/lib/usage/mergeDetails";
import { loadFilteredUsageRequests } from "@/lib/usage/loadFilteredRequests";
import { buildContentDigest } from "@/lib/usage/contentDigest";

const MAX_ROWS = 2000;

// Estimated cost per request (metadata only — no payload content involved).
function estimateCost(detail) {
  try {
    const pricing = getPricingForModel(detail.provider, detail.model);
    return pricing ? calculateCostFromTokens(detail.tokens, pricing) : 0;
  } catch {
    return 0;
  }
}

const REDACTED_KEYS = ["request", "providerRequest", "providerResponse", "response"];

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId,
 *   status, apiKeyId, endpoint, q, startDate, endDate
 *
 * Merges rich request details with the long-lived usage history so rows are not
 * lost when observability was off, and attaches a bounded content digest
 * (message roles/sizes/previews) instead of the full payload.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;

    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json({ error: "PageSize must be between 1 and 100" }, { status: 400 });
    }

    const filter = {};
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const apiKeyId = searchParams.get("apiKeyId");
    const endpoint = searchParams.get("endpoint");
    const q = searchParams.get("q");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const usesJsFilters = Boolean(apiKeyId || endpoint || q);

    const [settings, connections, loaded] = await Promise.all([
      getSettings(),
      getProviderConnections().catch(() => []),
      usesJsFilters
        ? loadFilteredUsageRequests({
            period: "all",
            startDate,
            endDate,
            filters: { ...filter, apiKeyId, endpoint, q },
            limit: MAX_ROWS,
          })
        : (async () => {
            const [details, history] = await Promise.all([
              getRequestDetailsInRange(filter, MAX_ROWS),
              getUsageHistory(filter),
            ]);
            return {
              rows: mergeUsageRows(details, history).slice(0, MAX_ROWS),
              details: details.length,
              history: history.length,
            };
          })(),
    ]);

    // id -> account display name (one query, applied to every row).
    const connectionNames = new Map(
      (connections || []).map((conn) => [
        conn.id,
        conn.displayName || conn.name || conn.email || conn.id,
      ])
    );

    const merged = loaded.rows;
    const contentMode = settings.observabilityContentMode === "none" ? "none" : "digest";

    const enriched = merged.map((row) => {
      const out = {
        ...row,
        cost: row.cost && row.cost > 0 ? row.cost : estimateCost(row),
        connectionName: row.connectionId ? connectionNames.get(row.connectionId) || null : null,
      };
      if (contentMode === "digest") out.contentDigest = buildContentDigest(row);
      for (const key of REDACTED_KEYS) {
        if (out[key] !== undefined) out[key] = { redacted: true };
      }
      return out;
    });

    const totalItems = enriched.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const offset = (page - 1) * pageSize;

    return NextResponse.json({
      details: enriched.slice(offset, offset + pageSize),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      sources: { details: loaded.details, history: loaded.history },
      contentMode,
    });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json({ error: "Failed to fetch request details" }, { status: 500 });
  }
}
