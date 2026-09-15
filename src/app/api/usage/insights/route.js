import { NextResponse } from "next/server";
import { getRequestDetailsInRange, getUsageHistory } from "@/lib/usageDb";
import { analyzeRequestDetails } from "@/lib/usage/insights";
import { mergeUsageRows } from "@/lib/usage/mergeDetails";
import { getPricingForModel, calculateCostFromTokens } from "open-sse/providers/pricing.js";

const PERIOD_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function startDateFor(period) {
  if (!period || period === "all") return null;
  if (period === "today") {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  const ms = PERIOD_MS[period];
  if (!ms) return null;
  return new Date(Date.now() - ms).toISOString();
}

// Estimated cost for one stored request. Unknown models fall back to $0.
function estimateCost(row) {
  try {
    const pricing = getPricingForModel(row.provider, row.model);
    return pricing ? calculateCostFromTokens(row.tokens, pricing) : 0;
  } catch {
    return 0;
  }
}

/**
 * GET /api/usage/insights
 * Query: period (today|1h|24h|7d|30d|all), provider, model, limit (<=2000), startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const provider = searchParams.get("provider") || undefined;
    const model = searchParams.get("model") || undefined;
    const limitRaw = parseInt(searchParams.get("limit"), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 500;

    const startDate = searchParams.get("startDate") || startDateFor(period);
    const endDate = searchParams.get("endDate") || undefined;

    const filter = { provider, model, startDate: startDate || undefined, endDate };
    const [details, history] = await Promise.all([
      getRequestDetailsInRange(filter, limit),
      getUsageHistory(filter),
    ]);

    // Merge so requests made while observability was off still count.
    const rows = mergeUsageRows(details, history).slice(0, Math.max(limit, 2000));
    const insights = analyzeRequestDetails(rows, { costEstimator: estimateCost });

    return NextResponse.json(
      {
        period,
        startDate,
        endDate: endDate || null,
        sampled: rows.length,
        sources: { details: details.length, history: history.length },
        ...insights,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to build usage insights:", error);
    return NextResponse.json({ error: "Failed to build usage insights" }, { status: 500 });
  }
}
