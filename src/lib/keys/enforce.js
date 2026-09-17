/**
 * Policy enforcement orchestrator (server only).
 *
 * Loads a key's policy, evaluates a request against every rule category and
 * returns a decision: allow, block (with an OpenAI-shaped error), warn-only
 * (dry run) or downgrade to a cheaper allowed target.
 */

import { getApiKeyByKey } from "@/lib/db/index.js";
import { getDefaultModel } from "open-sse/config/providerModels.js";
import {
  evaluateBudgets,
  evaluateContent,
  evaluateFeatures,
  evaluateNetwork,
  evaluateRateLimits,
  evaluateRequestCaps,
  evaluateSchedule,
  filterModelsByPolicy,
  isComboAllowed,
  isConnectionAllowed,
  isEndpointAllowed,
  isModelAllowed,
  isProviderAllowed,
  normalizePolicy,
} from "./policy.js";
import { loadKeyUsage, policyNeedsUsage } from "./policyUsage.js";
import { getKeyConcurrency, getKeyRecentStarts, recordKeyRequestStart } from "./concurrency.js";

const DOWNGRADEABLE = new Set([
  "budget_tokens",
  "budget_cost",
  "budget_percent",
  "budget_provider_quota",
  "rate_rpm",
  "rate_rph",
  "rate_concurrent",
  "model_denied",
  "provider_denied",
]);

/** Load the key row + normalized policy; returns null when unrestricted. */
export async function loadKeyPolicy(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  try {
    const row = await getApiKeyByKey(apiKey);
    if (!row) return null;
    const policy = normalizePolicy(row.policies);
    if (!policy.enabled) return null;
    return { row, policy };
  } catch {
    return null;
  }
}

export function getClientIp(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") || headers.get("cf-connecting-ip") || null;
}

export function policyErrorResponse(status, message, details = []) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "policy_violation",
        code: status === 429 ? "rate_limit_exceeded" : "access_denied",
        engine: "policy-engine-v2",
        policy: details.map((violation) => ({ code: violation.code, scope: violation.scope || null, message: violation.message })),
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "x-9router-policy": "blocked",
      },
    }
  );
}

function parseProviderModel(modelStr) {
  if (typeof modelStr !== "string") return null;
  const slash = modelStr.indexOf("/");
  if (slash <= 0) return null;
  return { provider: modelStr.slice(0, slash), model: modelStr.slice(slash + 1) };
}

/** True when violations should actually block (not dry-run / warn-only). */
export function policyBlocks(policy) {
  return Boolean(policy?.enabled) && !policy.dryRun && policy.onExceed?.mode !== "warn";
}

/** Resolve the first configured downgrade target allowed by the policy. */
export function resolveDowngradeTarget(policy, requestedModel) {
  if (!policy || policy.onExceed?.mode !== "downgrade") return null;
  const targets = [
    ...(policy.onExceed.downgradeTo?.models || []),
    ...(policy.onExceed.downgradeTo?.providers || []).map((provider) => {
      const fallbackModel = getDefaultModel(provider);
      return fallbackModel ? `${provider}/${fallbackModel}` : null;
    }),
  ].filter(Boolean);

  for (const target of targets) {
    if (target === requestedModel) continue;
    const parsed = parseProviderModel(target);
    if (!parsed) return target; // bare model/combo name: let the router resolve it
    if (!isProviderAllowed(policy, parsed.provider)) continue;
    if (!isModelAllowed(policy, parsed.provider, parsed.model)) continue;
    return target;
  }
  return null;
}

export function checkModelAccess(policy, provider, model) {
  if (!policy?.enabled || !policyBlocks(policy)) return [];
  const violations = [];
  if (provider && !isProviderAllowed(policy, provider)) {
    violations.push({
      code: "provider_denied",
      message: `The provider “${provider}” is not allowed for this API key.`,
    });
  }
  if (provider && model && !isModelAllowed(policy, provider, model)) {
    violations.push({
      code: "model_denied",
      message: `The model “${provider}/${model}” is not allowed for this API key.`,
    });
  }
  return violations;
}

/** Filter a combo's candidate models through the policy. */
export function filterComboModels(policy, comboName, models) {
  if (!policy?.enabled || !policyBlocks(policy)) return models;
  const filtered = isComboAllowed(policy, comboName) ? filterModelsByPolicy(policy, models) : [];
  return filtered;
}

/**
 * Pre-flight evaluation for one request.
 * @returns {Promise<{ok: boolean, status?: number, message?: string,
 *   details?: Array, warnings?: Array, downgradeTarget?: string|null,
 *   clampedMaxTokens?: number|null}>}
 */
export async function enforceKeyPolicy({ row, policy, request, endpoint, body, modelStr = null, isCombo = false }) {
  if (!policy?.enabled) return { ok: true, clampedMaxTokens: null };

  const violations = [];
  violations.push(...evaluateSchedule(policy, new Date()));
  violations.push(...evaluateNetwork(policy, getClientIp(request)));
  violations.push(...evaluateContent(policy, body));
  violations.push(...evaluateFeatures(policy, { body, endpoint }));
  const caps = evaluateRequestCaps(policy, { body });
  violations.push(...caps.violations);

  if (endpoint && !isEndpointAllowed(policy, endpoint)) {
    violations.push({ code: "endpoint_denied", message: `The endpoint “${endpoint}” is not allowed for this API key.` });
  }

  if (!isCombo && modelStr) {
    const parsed = parseProviderModel(modelStr);
    if (parsed) {
      violations.push(...checkModelAccess(policy, parsed.provider, parsed.model));
    }
  }

  if (policyNeedsUsage(policy)) {
    try {
      const usage = await loadKeyUsage(row.key, policy, { concurrency: getKeyConcurrency(row.id) });
      // In-memory starts cover the window before the request row is written
      // (streaming requests land in usageHistory only when they finish).
      const recent = getKeyRecentStarts(row.id);
      usage.rate = {
        rpm: Math.max(usage.rate.rpm, recent.rpm),
        rph: Math.max(usage.rate.rph, recent.rph),
      };
      violations.push(
        ...evaluateRateLimits(policy, {
          rpm: usage.rate.rpm,
          rph: usage.rate.rph,
          concurrent: usage.concurrent,
        })
      );
      violations.push(...evaluateBudgets(policy, usage));
    } catch (error) {
      // Fail open: a broken accounting query must not take the gateway down.
      console.error("[policy] usage snapshot failed:", error?.message || error);
    }
  }

  if (violations.length === 0) {
    recordKeyRequestStart(row.id);
    return { ok: true, clampedMaxTokens: caps.clampedMaxTokens };
  }

  if (policy.dryRun || policy.onExceed?.mode === "warn") {
    recordKeyRequestStart(row.id);
    return { ok: true, warnings: violations, clampedMaxTokens: caps.clampedMaxTokens };
  }

  if (policy.onExceed?.mode === "downgrade" && violations.every((violation) => DOWNGRADEABLE.has(violation.code))) {
    // Budget/rate/access denial → try a cheaper allowed target first.
    const target = resolveDowngradeTarget(policy, modelStr);
    if (target) {
      recordKeyRequestStart(row.id);
      return { ok: true, downgradeTarget: target, warnings: violations, clampedMaxTokens: caps.clampedMaxTokens };
    }
  }

  const isRateOrBudget = violations.some(
    (violation) => violation.code.startsWith("rate_") || violation.code.startsWith("budget_")
  );
  return {
    ok: false,
    status: isRateOrBudget ? 429 : 403,
    message: violations[0].message,
    details: violations,
    clampedMaxTokens: caps.clampedMaxTokens,
  };
}
