import { NextResponse } from "next/server";
import { getUsageHistory, getRequestDetailsInRange } from "@/lib/usageDb";
import { getProviderConnections } from "@/lib/localDb";
import { getProviderByAlias, AI_PROVIDERS } from "@/shared/constants/providers";

/**
 * GET /api/usage/routing
 * Query: period (today|1h|24h|7d|30d|all), provider
 *
 * End-to-end routing picture:
 *  - providers: requests/tokens/cost/failures with a per-connection breakdown
 *    (last used + cooldown state) so a pool is visible as an entity.
 *  - redirects: how often a request moved to another account and why
 *    (fallback / capability / non-fallback), from the stored routing traces.
 *  - combos: which combos ran, their models and per-model success/failure.
 */

const PERIOD_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function startDateFor(period) {
  if (!period || period === "all") return undefined;
  if (period === "today") {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  const ms = PERIOD_MS[period];
  return ms ? new Date(Date.now() - ms).toISOString() : undefined;
}

function providerName(id) {
  const provider = getProviderByAlias(id) || AI_PROVIDERS[id];
  return provider?.name || id;
}

function tokensOf(row) {
  const tokens = row?.tokens || {};
  return (tokens.prompt_tokens || tokens.input_tokens || 0) + (tokens.completion_tokens || tokens.output_tokens || 0);
}

function isFailure(status) {
  return Boolean(status) && status !== "ok" && status !== "success";
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const providerFilter = searchParams.get("provider") || undefined;
    const startDate = startDateFor(period);

    const [history, details, connections] = await Promise.all([
      getUsageHistory({ provider: providerFilter, startDate }),
      getRequestDetailsInRange({ provider: providerFilter, startDate }, 1000),
      getProviderConnections().catch(() => []),
    ]);

    const connectionNames = new Map(
      (connections || []).map((conn) => [conn.id, conn.displayName || conn.name || conn.email || conn.id])
    );
    const connectionState = new Map((connections || []).map((conn) => [conn.id, conn]));

    // --- provider + connection aggregation from usage history ---
    const providerMap = new Map();
    for (const row of history) {
      const key = row.provider || "unknown";
      const entry = providerMap.get(key) || {
        provider: key,
        name: providerName(key),
        requests: 0,
        tokens: 0,
        cost: 0,
        failures: 0,
        connections: new Map(),
      };
      const tokens = tokensOf(row);
      const failed = isFailure(row.status);
      entry.requests += 1;
      entry.tokens += tokens;
      entry.cost += row.cost || 0;
      if (failed) entry.failures += 1;

      const connKey = row.connectionId || "unknown";
      const connEntry = entry.connections.get(connKey) || {
        connectionId: row.connectionId || null,
        name: row.connectionId ? connectionNames.get(row.connectionId) || row.connectionId.slice(0, 8) : "unknown",
        requests: 0,
        tokens: 0,
        cost: 0,
        failures: 0,
        lastUsed: row.timestamp || null,
      };
      connEntry.requests += 1;
      connEntry.tokens += tokens;
      connEntry.cost += row.cost || 0;
      if (failed) connEntry.failures += 1;
      if (!connEntry.lastUsed || row.timestamp > connEntry.lastUsed) connEntry.lastUsed = row.timestamp;
      entry.connections.set(connKey, connEntry);
      providerMap.set(key, entry);
    }

    const providers = [...providerMap.values()]
      .map((entry) => ({
        ...entry,
        connections: [...entry.connections.values()]
          .map((conn) => {
            const record = connectionState.get(conn.connectionId);
            const locks = record
              ? Object.entries(record).filter(([k, v]) => k.startsWith("modelLock_") && v).length
              : 0;
            return {
              ...conn,
              testStatus: record?.testStatus || null,
              cooldownUntil: record?.rateLimitedUntil || null,
              lockCount: locks,
            };
          })
          .sort((a, b) => b.requests - a.requests),
      }))
      .sort((a, b) => b.requests - a.requests);

    // --- redirects + combos from stored routing traces ---
    const actionCounts = new Map();
    const redirectsByProvider = new Map();
    const comboMap = new Map();
    let redirectTotal = 0;
    let traceCount = 0;

    for (const detail of details) {
      const routing = detail.routing;
      if (!routing) continue;
      traceCount += 1;
      for (const attempt of routing.attempts || []) {
        redirectTotal += 1;
        const action = attempt.action || "unknown";
        actionCounts.set(action, (actionCounts.get(action) || 0) + 1);
        const key = detail.provider || "unknown";
        const entry = redirectsByProvider.get(key) || { provider: key, name: providerName(key), count: 0 };
        entry.count += 1;
        redirectsByProvider.set(key, entry);
      }
      if (routing.combo?.name) {
        const entry = comboMap.get(routing.combo.name) || {
          name: routing.combo.name,
          kind: routing.combo.kind || "combo",
          strategy: routing.combo.strategy || "fallback",
          attempts: 0,
          models: new Map(),
        };
        entry.attempts += 1;
        for (const model of routing.combo.models || []) {
          const modelEntry = entry.models.get(model.model) || { model: model.model, ok: 0, failed: 0 };
          if (model.status === "success") modelEntry.ok += 1;
          else if (String(model.status || "").startsWith("failed")) modelEntry.failed += 1;
          entry.models.set(model.model, modelEntry);
        }
        comboMap.set(routing.combo.name, entry);
      }
    }

    return NextResponse.json(
      {
        period,
        startDate: startDate || null,
        providers,
        redirects: {
          total: redirectTotal,
          tracedRequests: traceCount,
          byAction: [...actionCounts.entries()]
            .map(([action, count]) => ({ action, count }))
            .sort((a, b) => b.count - a.count),
          byProvider: [...redirectsByProvider.values()].sort((a, b) => b.count - a.count),
        },
        combos: [...comboMap.values()].map((combo) => ({
          ...combo,
          models: [...combo.models.values()].sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed)),
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to build routing stats:", error);
    return NextResponse.json({ error: "Failed to build routing stats" }, { status: 500 });
  }
}
