import { NextResponse } from "next/server";
import { getProviderConnections, getProviderNodes } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { AI_PROVIDERS, USAGE_SUPPORTED_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import { analyzeSubscriptionUsage, buildMonths, buildSubscriptionReport } from "@/lib/usage/subscriptionUsage";

export const dynamic = "force-dynamic";

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function providerLabels(nodes) {
  const labels = {};
  for (const node of nodes || []) {
    if (node?.id && node?.name) labels[node.id] = node.name;
  }
  for (const [id, config] of Object.entries(AI_PROVIDERS || {})) {
    if (config?.name && !labels[id]) labels[id] = config.name;
  }
  return labels;
}

/**
 * GET /api/usage/subscriptions?months=3
 * Subscription utilization per provider connection over the last N months,
 * with optimization recommendations for underused/idle connections.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const monthCount = clampInt(searchParams.get("months"), 3, 1, 12);
    const months = buildMonths(monthCount);
    const rangeStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth() - (monthCount - 1),
      1
    ).toISOString();

    const [connections, nodes] = await Promise.all([
      getProviderConnections().catch(() => []),
      getProviderNodes().catch(() => []),
    ]);

    // Plan-based providers (live usage API support) plus any provider with
    // several connections (pools are subscription seats too).
    const perProviderCount = new Map();
    for (const connection of connections || []) {
      if (!connection?.provider) continue;
      perProviderCount.set(connection.provider, (perProviderCount.get(connection.provider) || 0) + 1);
    }
    const supported = new Set(USAGE_SUPPORTED_PROVIDERS || []);
    const relevant = (connections || []).filter((connection) => {
      if (!connection?.provider) return false;
      if (connection.provider.endsWith("-local")) return false;
      return supported.has(connection.provider) || (perProviderCount.get(connection.provider) || 0) > 1;
    });

    const db = await getAdapter();
    const [usageRows, providerRows] = await Promise.all([
      db.all(
        `SELECT connectionId,
                substr(timestamp, 1, 7) AS month,
                COUNT(*) AS requests,
                COUNT(DISTINCT substr(timestamp, 1, 10)) AS activeDays,
                SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)) AS tokens
         FROM usageHistory
         WHERE timestamp >= ? AND connectionId IS NOT NULL
         GROUP BY connectionId, month`,
        [rangeStart]
      ),
      db.all(
        `SELECT provider, substr(timestamp, 1, 7) AS month, COUNT(*) AS requests
         FROM usageHistory
         WHERE timestamp >= ?
         GROUP BY provider, month`,
        [rangeStart]
      ),
    ]);

    const labels = providerLabels(nodes);
    const analysis = analyzeSubscriptionUsage({
      connections: relevant,
      usageRows: usageRows.map((row) => ({
        connectionId: row.connectionId,
        month: row.month,
        requests: row.requests || 0,
        activeDays: row.activeDays || 0,
        tokens: row.tokens || 0,
      })),
      providerRows: providerRows.map((row) => ({
        provider: row.provider,
        month: row.month,
        requests: row.requests || 0,
      })),
      months,
      providerLabels: labels,
    });

    // Unknown-but-relevant providers keep a readable label.
    for (const provider of analysis.providers) {
      if (!provider.providerLabel) {
        provider.providerLabel = getProviderByAlias(provider.provider)?.name || provider.provider;
      }
    }

    const includeReport = searchParams.get("report") === "1";

    return NextResponse.json(
      {
        ...analysis,
        generatedAt: new Date().toISOString(),
        ...(includeReport ? { report: buildSubscriptionReport(analysis) } : {}),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to analyze subscriptions:", error);
    return NextResponse.json({ error: "Failed to analyze subscriptions" }, { status: 500 });
  }
}
