import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";
import { PATTERN_META, analyzeRequest, analyzeRequestDetails } from "@/lib/usage/insights";
import { loadFilteredUsageRequests } from "@/lib/usage/loadFilteredRequests";
import { buildFixPrompt } from "@/lib/usage/fixPrompt";
import { parseUsageFilters } from "@/lib/usage/usageFilters.js";
import { getSettings } from "@/lib/localDb";
import { getPricingForModel, calculateCostFromTokens } from "open-sse/providers/pricing.js";

function estimateCost(row) {
  try {
    const pricing = getPricingForModel(row.provider, row.model);
    return pricing ? calculateCostFromTokens(row.tokens, pricing) : 0;
  } catch {
    return 0;
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function toSample(row, flags = []) {
  return {
    id: row.id || null,
    timestamp: row.timestamp || null,
    provider: row.provider || null,
    model: row.model || null,
    connectionId: row.connectionId || null,
    connectionName: row.connectionName || null,
    account: row.connectionName || row.account || null,
    status: row.status || "success",
    tokens: row.tokens || {},
    latency: row.latency || {},
    cost: typeof row.cost === "number" && row.cost > 0 ? row.cost : estimateCost(row),
    flags,
    routingSummary: row.routingSummary || null,
    routing: row.routing || null,
    pxpipe: row.pxpipe || null,
    request: row.request || null,
    providerRequest: row.providerRequest || null,
    providerResponse: row.providerResponse || null,
    response: row.response || null,
  };
}

function patternFromFlag(flag, { occurrences, wastedTokens, wastedUsd, row }) {
  const meta = PATTERN_META[flag.id] || { title: flag.id, severity: "low", explanation: "", tip: "" };
  const label = (value) => (value ? [{ name: value, count: occurrences }] : []);
  return {
    id: flag.id,
    ...meta,
    occurrences,
    wastedTokens,
    wastedUsd,
    dimensions: {
      providers: label(row?.provider),
      models: label(row?.model),
      accounts: label(row?.connectionName || row?.connectionId),
    },
    sampleIds: row?.id ? [row.id] : [],
  };
}

async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return {};
  }
}

/**
 * GET /api/usage/insights/fix-prompt
 * Query: pattern (required) OR requestId (single-request prompt), period,
 *        provider, model, connectionId, status, apiKeyId, endpoint, q,
 *        samples (1-5), limit, startDate, endDate
 *
 * Builds a complete LLM prompt for one detected token-leak pattern, including
 * raw request/response payloads when observability kept them.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get("requestId");

    // Single request: prompt scoped to that request's own flags.
    if (requestId) {
      const detail = await getRequestDetailById(requestId);
      if (!detail) {
        return NextResponse.json({ error: "Request not found" }, { status: 404 });
      }
      const analysis = analyzeRequest(detail, { costEstimator: estimateCost });
      const flag = (analysis.flags || [])[0];
      if (!flag) {
        return NextResponse.json({ error: "No token leak flagged on this request" }, { status: 400 });
      }
      const cost = typeof detail.cost === "number" && detail.cost > 0 ? detail.cost : analysis.cost;
      const pattern = patternFromFlag(flag, {
        occurrences: 1,
        wastedTokens: analysis.wastedTokens,
        wastedUsd: analysis.total > 0 ? Number(((analysis.wastedTokens / analysis.total) * cost).toFixed(6)) : 0,
        row: detail,
      });
      const samples = [toSample(detail, analysis.flags)];
      const prompt = buildFixPrompt({
        pattern,
        overview: {
          requests: 1,
          inputTokens: analysis.input,
          cachedTokens: analysis.cached,
          outputTokens: analysis.output,
          reasoningTokens: analysis.reasoning,
          totalTokens: analysis.total,
          totalCost: cost,
          cacheHitRate: analysis.input > 0 ? analysis.cached / analysis.input : 0,
        },
        samples,
        settings: await loadSettings(),
        window: {
          period: "single request",
          startDate: detail.timestamp || null,
          endDate: detail.timestamp || null,
          filters: { requestId },
          sampled: 1,
        },
      });
      return NextResponse.json(
        {
          requestId,
          patternId: flag.id,
          prompt,
          meta: {
            samples: 1,
            bytes: prompt.length,
            approxTokens: Math.round(prompt.length / 4),
            rawPayloads: Boolean(detail.request || detail.response),
          },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const patternId = searchParams.get("pattern");
    if (!patternId) {
      return NextResponse.json({ error: "A pattern id or requestId is required" }, { status: 400 });
    }

    const period = searchParams.get("period") || "7d";
    const samplesWanted = clampInt(searchParams.get("samples"), 3, 1, 5);
    const limit = clampInt(searchParams.get("limit"), 500, 100, 2000);
    const filters = parseUsageFilters(searchParams);

    const loaded = await loadFilteredUsageRequests({
      period,
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      filters,
      limit,
    });
    const { rows } = loaded;
    const insights = analyzeRequestDetails(rows, { costEstimator: estimateCost });
    const pattern = insights.patterns.find((entry) => entry.id === patternId);
    if (!pattern) {
      return NextResponse.json(
        { error: "Pattern not found in this window", available: insights.patterns.map((entry) => entry.id) },
        { status: 404 }
      );
    }

    const flagged = rows
      .map((row) => ({ row, analysis: analyzeRequest(row, { costEstimator: estimateCost }) }))
      .filter(({ analysis }) => analysis.flags.some((flag) => flag.id === patternId))
      .map(({ row, analysis }) => ({ row, flags: analysis.flags, wastedTokens: analysis.wastedTokens }))
      .sort((a, b) => b.wastedTokens - a.wastedTokens);

    // Prefer samples that still carry raw payloads; fill up with metadata-only rows.
    const withPayloads = flagged.filter(({ row }) => row.request || row.providerRequest || row.providerResponse || row.response);
    const chosen = [...withPayloads, ...flagged.filter((entry) => !withPayloads.includes(entry))].slice(0, samplesWanted);
    const samples = chosen.map(({ row, flags }) => toSample(row, flags));

    const prompt = buildFixPrompt({
      pattern,
      overview: insights.overview,
      samples,
      settings: await loadSettings(),
      window: {
        period,
        startDate: loaded.startDate,
        endDate: loaded.endDate,
        filters,
        sampled: rows.length,
      },
    });

    return NextResponse.json(
      {
        patternId,
        pattern: {
          id: pattern.id,
          title: pattern.title,
          severity: pattern.severity,
          occurrences: pattern.occurrences,
          wastedTokens: pattern.wastedTokens,
          wastedUsd: pattern.wastedUsd,
        },
        prompt,
        meta: {
          samples: samples.length,
          bytes: prompt.length,
          approxTokens: Math.round(prompt.length / 4),
          rawPayloads: samples.some((sample) => sample.request || sample.response),
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to build fix prompt:", error);
    return NextResponse.json({ error: "Failed to build fix prompt" }, { status: 500 });
  }
}
