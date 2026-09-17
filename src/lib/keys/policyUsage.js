/**
 * Server-side usage snapshot for API key policies.
 *
 * Token/cost budgets count successful requests; rate limits count every attempt.
 * Aggregates come from usageHistory (which already stores the key, provider,
 * model, connection, tokens, cost and status per request). Live provider quota
 * percentages are fetched through the same usage service the quota page uses,
 * cached and time-boxed because some providers rate-limit that endpoint.
 */

import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnections } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { PERIODS } from "./policy.js";

const PERIOD_MS = {
  "5h": 5 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  lifetime: null,
};

const SUCCESS_STATUSES = ["ok", "success"];

const quotaCache = new Map(); // provider -> { at, data }
const QUOTA_TTL_MS = 5 * 60 * 1000;
const QUOTA_TIMEOUT_MS = 5000;

function periodStart(period, now = Date.now()) {
  const ms = PERIOD_MS[period];
  if (!ms) return null;
  return new Date(now - ms).toISOString();
}

function emptyAggregate() {
  return { requests: 0, tokens: 0, costUsd: 0 };
}

function addTo(target, row) {
  target.requests += row.requests || 0;
  target.tokens += row.tokens || 0;
  target.costUsd += row.costUsd || 0;
}

/** Periods referenced by a policy's budget rules (defaults to month). */
export function periodsNeeded(policy) {
  const periods = new Set();
  const consider = (rule) => {
    if (rule && (rule.tokens !== null || rule.costUsd !== null || rule.percentOfBudget !== null || rule.percentOfQuota !== null)) {
      periods.add(PERIODS.includes(rule.period) ? rule.period : "month");
    }
  };
  consider(policy?.budgets?.total);
  for (const rule of Object.values(policy?.budgets?.perProvider || {})) consider(rule);
  for (const rule of Object.values(policy?.budgets?.perModel || {})) consider(rule);
  for (const rule of Object.values(policy?.budgets?.perConnection || {})) consider(rule);
  if (periods.size === 0) periods.add("month");
  return [...periods];
}

export function policyNeedsUsage(policy) {
  if (!policy?.enabled) return false;
  const limits = policy.rateLimits || {};
  const hasRate = limits.requestsPerMinute !== null || limits.requestsPerHour !== null;
  const hasBudgets =
    (policy.budgets?.total && (policy.budgets.total.tokens !== null || policy.budgets.total.costUsd !== null)) ||
    Object.keys(policy.budgets?.perProvider || {}).length > 0 ||
    Object.keys(policy.budgets?.perModel || {}).length > 0 ||
    Object.keys(policy.budgets?.perConnection || {}).length > 0;
  return hasRate || hasBudgets;
}

async function aggregatePeriod(db, keyValue, period, now) {
  const start = periodStart(period, now);
  const conditions = ["apiKey = ?", "(status IS NULL OR status IN ('ok', 'success'))"];
  const params = [keyValue];
  if (start) {
    conditions.push("timestamp >= ?");
    params.push(start);
  }
  const rows = db.all(
    `SELECT provider, model, connectionId,
            COUNT(*) AS requests,
            SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)) AS tokens,
            SUM(COALESCE(cost, 0)) AS costUsd
     FROM usageHistory
     WHERE ${conditions.join(" AND ")}
     GROUP BY provider, model, connectionId`,
    params
  );

  const aggregate = {
    total: emptyAggregate(),
    byProvider: {},
    byModel: {},
    byConnection: {},
  };

  for (const row of rows) {
    const entry = {
      requests: row.requests || 0,
      tokens: row.tokens || 0,
      costUsd: row.costUsd || 0,
    };
    addTo(aggregate.total, entry);
    const providerKey = row.provider || "unknown";
    aggregate.byProvider[providerKey] = aggregate.byProvider[providerKey] || emptyAggregate();
    addTo(aggregate.byProvider[providerKey], entry);
    const modelKey = `${row.provider || "unknown"}/${row.model || "unknown"}`;
    aggregate.byModel[modelKey] = aggregate.byModel[modelKey] || emptyAggregate();
    addTo(aggregate.byModel[modelKey], entry);
    if (row.connectionId) {
      aggregate.byConnection[row.connectionId] = aggregate.byConnection[row.connectionId] || emptyAggregate();
      addTo(aggregate.byConnection[row.connectionId], entry);
    }
  }
  return aggregate;
}

async function countSince(db, keyValue, sinceIso) {
  const row = db.get(
    `SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
    [keyValue, sinceIso]
  );
  return row?.c || 0;
}

async function providerTotalsSince(db, sinceIso) {
  const rows = db.all(
    `SELECT provider, SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)) AS tokens
     FROM usageHistory
     WHERE timestamp >= ? AND (status IS NULL OR status IN ('ok', 'success'))
     GROUP BY provider`,
    [sinceIso]
  );
  return Object.fromEntries(rows.map((row) => [row.provider || "unknown", { tokens: row.tokens || 0 }]));
}

/**
 * Load the usage snapshot used by evaluateBudgets()/evaluateRateLimits().
 * @param {string} keyValue - the raw API key value
 * @param {object} policy - normalized policy
 */
export async function loadKeyUsage(keyValue, policy, { now = Date.now(), concurrency = 0 } = {}) {
  const db = await getAdapter();
  const periods = periodsNeeded(policy);
  const periodUsage = {};
  for (const period of periods) {
    periodUsage[period] = await aggregatePeriod(db, keyValue, period, now);
  }

  const rate = {
    rpm: await countSince(db, keyValue, new Date(now - 60 * 1000).toISOString()),
    rph: await countSince(db, keyValue, new Date(now - 60 * 60 * 1000).toISOString()),
  };

  // Live quota percentages are only needed when a rule asks for them.
  const needsQuota = Object.values(policy?.budgets?.perProvider || {}).some((rule) => rule.percentOfQuota !== null);
  const liveQuota = {};
  let providerTotals = {};
  if (needsQuota) {
    const providers = [...new Set(Object.entries(policy.budgets.perProvider)
      .filter(([, rule]) => rule.percentOfQuota !== null)
      .map(([provider]) => provider))];
    const quotaPeriod = "month";
    const quotaStart = periodStart(quotaPeriod, now);
    providerTotals = await providerTotalsSince(db, quotaStart);
    for (const provider of providers) {
      liveQuota[provider] = await getProviderQuotaSnapshot(provider);
    }
  }

  return { periods: periodUsage, rate, concurrent: concurrency, liveQuota, providerTotals };
}

/** Highest used-% across a provider's active connections (cached, fail-open). */
export async function getProviderQuotaSnapshot(provider, { ttlMs = QUOTA_TTL_MS, timeoutMs = QUOTA_TIMEOUT_MS } = {}) {
  const cached = quotaCache.get(provider);
  if (cached && Date.now() - cached.at < ttlMs) return cached.data;

  let usedPct = null;
  let source = null;
  let detail = null;

  try {
    const connections = (await getProviderConnections()).filter(
      (connection) => connection.provider === provider && connection.isActive !== false
    );
    for (const connection of connections.slice(0, 3)) {
      try {
        const usage = await Promise.race([
          getUsageForProvider({
            provider,
            accessToken: connection.accessToken,
            apiKey: connection.apiKey,
            providerSpecificData: connection.providerSpecificData,
            projectId: connection.projectId,
          }),
          new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs)),
        ]);
        if (!usage || usage.__timeout) continue;
        const percentages = Object.values(usage.quotas || {})
          .map((quota) => {
            const total = Number(quota?.total);
            const used = Number(quota?.used);
            if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) return (used / total) * 100;
            if (Number.isFinite(Number(quota?.remainingPercentage))) return 100 - Number(quota.remainingPercentage);
            return null;
          })
          .filter((value) => value !== null);
        if (percentages.length > 0) {
          usedPct = Math.max(...percentages);
          source = "live";
          detail = usage.plan || null;
          break;
        }
      } catch {
        // try the next connection
      }
    }
  } catch {
    // provider without usage support / DB error: leave unknown
  }

  const data = { provider, usedPct, source, plan: detail, fetchedAt: new Date().toISOString() };
  quotaCache.set(provider, { at: Date.now(), data });
  return data;
}
