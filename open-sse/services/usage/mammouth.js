/**
 * Mammouth AI usage — https://api.mammouth.ai is a LiteLLM proxy.
 *
 * Primary: GET /key/info with the API key returns that key's spend and budget
 * (`info.spend`, `info.max_budget`, `info.budget_reset_at`), which maps to the
 * credit usage shown for the connection.
 *
 * Fallback: if /key/info is unavailable, read the standard rate-limit headers
 * from GET /v1/models. If neither works, report that clearly instead of
 * pretending usage is zero.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime, toFiniteNumber, U } from "./shared.js";

const KEY_INFO_URL = U("mammouth").url || "https://api.mammouth.ai/key/info";
const MODELS_URL = "https://api.mammouth.ai/v1/models";

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function quotasFromKeyInfo(info) {
  if (!info || typeof info !== "object") return {};

  const spend = toFiniteNumber(info.spend, null);
  const maxBudget = toFiniteNumber(info.max_budget, null);
  const quotas = {};

  if (spend !== null && maxBudget !== null && maxBudget > 0) {
    const used = Math.max(0, Math.min(100, (spend / maxBudget) * 100));
    quotas["API credits"] = {
      used,
      total: 100,
      remaining: 100 - used,
      remainingPercentage: 100 - used,
      resetAt: parseResetTime(info.budget_reset_at || info.budget_reset),
      unlimited: false,
    };
  }

  // Pay-as-you-go keys can have no max_budget: report spend without a ceiling.
  if (spend !== null && (maxBudget === null || maxBudget <= 0)) {
    quotas["API credits"] = {
      used: 0,
      total: 0,
      remaining: 0,
      remainingPercentage: 100,
      unlimited: true,
      resetAt: null,
    };
  }

  return quotas;
}

function quotasFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return {};

  const limitRaw = headers.get("x-ratelimit-limit-requests");
  const remainingRaw = headers.get("x-ratelimit-remaining-requests");
  const limit = toFiniteNumber(limitRaw, null);
  const remaining = toFiniteNumber(remainingRaw, null);
  if (limit === null || remaining === null || limit <= 0) return {};

  const used = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  return {
    "Requests (window)": {
      used,
      total: 100,
      remaining: 100 - used,
      remainingPercentage: 100 - used,
      resetAt: parseResetTime(headers.get("x-ratelimit-reset-requests")),
      unlimited: false,
    },
  };
}

export async function getMammouthUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Mammouth API key not available. Add a key to view usage." };
  }
  const key = apiKey.trim();

  try {
    const response = await proxyAwareFetch(
      KEY_INFO_URL,
      { method: "GET", headers: authHeaders(key) },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return { plan: "Mammouth AI", message: "Mammouth authentication failed. Check the API key." };
    }

    if (response.ok) {
      const data = await response.json().catch(() => null);
      const info = data?.info && typeof data.info === "object" ? data.info : data;
      const quotas = quotasFromKeyInfo(info);
      if (Object.keys(quotas).length > 0) {
        return { plan: "Mammouth AI", quotas };
      }
      return {
        plan: "Mammouth AI",
        message: "Mammouth key info did not include a credit budget for this key.",
      };
    }

    // Fallback: rate-limit headers on the models endpoint.
    const modelsResponse = await proxyAwareFetch(
      MODELS_URL,
      { method: "GET", headers: authHeaders(key) },
      proxyOptions,
    );
    if (modelsResponse.status === 401 || modelsResponse.status === 403) {
      return { plan: "Mammouth AI", message: "Mammouth authentication failed. Check the API key." };
    }
    if (modelsResponse.ok) {
      const quotas = quotasFromHeaders(modelsResponse.headers);
      if (Object.keys(quotas).length > 0) {
        return { plan: "Mammouth AI", quotas };
      }
    }

    return {
      plan: "Mammouth AI",
      message: "Mammouth does not expose usage for this key. Check mammouth.ai → Account → API for live credits.",
    };
  } catch (error) {
    return { message: `Mammouth error: ${error.message}` };
  }
}
