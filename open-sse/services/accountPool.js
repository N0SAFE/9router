/**
 * Generic provider account pool.
 *
 * A provider may have N active connections ("accounts"). The chat loop already
 * picks one via getProviderCredentials() and retries the next one on failure;
 * this module supplies the two pieces that were missing to make that pool
 * behave well for every provider and every request format:
 *
 *  1. Error classification — decide whether an upstream error is worth
 *     rotating accounts for. Rate limits / quota / transient 5xx rotate;
 *     permanent client errors (malformed request) stop immediately;
 *     "model not available for this account" retires that account+model for
 *     the session and moves on to the next account.
 *
 *  2. A session-scoped failure cache — remember which account already failed
 *     (for which model) in the current logical conversation so a follow-up
 *     request never retries it before its cooldown expires. The cache is a
 *     fast, in-memory complement to the durable modelLock_* state written by
 *     markAccountUnavailable(); it does not replace it.
 *
 * Nothing provider-specific lives here: opencode-go, anthropic, openai, ... all
 * share the same pool semantics. No credentials are ever stored or logged.
 */

import { checkFallbackError, matchFallbackRule } from "./accountFallback.js";
import { resolveSessionId } from "../utils/sessionManager.js";

export const POOL_ACTIONS = {
  FALLBACK: "fallback",
  NON_FALLBACK: "non-fallback",
  CAPABILITY: "capability",
};

// Account+model is treated as ineligible for this long. The durable DB model
// lock is capped separately by markAccountUnavailable(); this value bounds the
// in-memory session exclusion.
export const MODEL_INELIGIBLE_MS = 30 * 60 * 1000;

const SESSION_FAILURE_MIN_MS = 5 * 1000;
const SESSION_FAILURE_MAX_MS = 30 * 60 * 1000;
const SESSION_CACHE_MAX_ENTRIES = 10_000;
const ENTRY_SEPARATOR = "\u0000";

// Upstream phrasings that mean "this account cannot serve this model". Kept
// deliberately shape-based (provider-neutral) so future model ids and new
// providers work without any registry entry.
const CAPABILITY_PATTERNS = [
  /model[_\- ]?(?:not[_\- ]?)?(?:found|supported|available|exist)/i,
  /(?:unsupported|unknown|invalid|unavailable|unrecognized|nonexistent)[_\- ]model/i,
  /model[^\n]{0,100}(?:is not|isn't|not)\s+(?:supported|available|enabled|accessible|registered|found)/i,
  /model[^\n]{0,100}(?:does not|doesn't|do not)\s+(?:exist|support|recognize)/i,
  /model[^\n]{0,100}(?:not have|no)\s+access/i,
  /(?:does not|doesn't|do not|don't)\s+(?:support|recognize|know|have access to)\s+(?:this|the)?\s*model/i,
  /no\s+(?:such|access to (?:this|the))\s+model/i,
  /unsupported_api_for_model/i,
  /model_not_(?:found|supported)/i,
  /\bnot_found_error\b/i,
  /\bmodel_is_not_available\b/i,
];

// Upstream phrasings for request-scoped (client) faults. Rotating accounts
// cannot fix these, so they must surface to the caller immediately.
const REQUEST_SCOPED_PATTERNS = [
  /\binvalid[_ ]request\b/i,
  /\bmalformed\b/i,
  /\b(cannot|can't|failed to|unable to)\s+(parse|decode|process)\b/i,
  /\bunexpected\s+(token|character|end of|eof)\b/i,
  /\binvalid\s+(json|parameter|argument|schema|field|type|value|tool|function|message|content|body|payload)\b/i,
  /\b(arguments|parameters)\b[^.\n]{0,40}\b(json|parse|invalid|malformed)\b/i,
  /\bmust be valid (json|yaml)\b/i,
  /\bmissing\s+(required|field|parameter|property|argument)\b/i,
  /\brequired\b[^.\n]{0,40}\bmissing\b/i,
  /\bcontext[_ ](length|window)\b[^.\n]{0,40}\b(exceed|too|limit|maximum|max)\b/i,
  /\b(maximum|max)\s+(context|token|tokens)\b/i,
  /\btoo\s+many\s+tokens\b/i,
  /\bprompt\s+is\s+too\s+long\b/i,
  /\brequest\s+too\s+large\b/i,
  /\bpayload\s+too\s+large\b/i,
];

// Transient statuses that look like 4xx request errors but are retryable.
const TRANSIENT_4XX = new Set([408, 409, 425, 429]);

function normalizeErrorText(errorText) {
  if (!errorText) return "";
  if (typeof errorText === "string") return errorText;
  try {
    return JSON.stringify(errorText);
  } catch {
    return String(errorText);
  }
}

/**
 * True when the error means the selected account cannot serve this model.
 */
export function isModelCapabilityError(status, errorText) {
  const text = normalizeErrorText(errorText);
  if (!text) return false;
  if (CAPABILITY_PATTERNS.some((re) => re.test(text))) return true;
  // A 404/406 from a chat endpoint with a "model" body but no other signal
  // (e.g. Anthropic's `{"type":"not_found_error","message":"model: x"}`) still
  // means this account cannot serve the model.
  return (status === 404 || status === 406) && /\bmodel\b/i.test(text);
}

/**
 * True when the error is caused by the request itself (bad payload, context
 * overflow, malformed tool call) and retrying another account would only add
 * latency. Only permanent 4xx statuses qualify.
 */
export function isRequestScopedError(status, errorText) {
  if (!(status >= 400 && status < 500) || TRANSIENT_4XX.has(status)) return false;
  const text = normalizeErrorText(errorText);
  if (!text) return false;
  return REQUEST_SCOPED_PATTERNS.some((re) => re.test(text));
}

/**
 * Classify an upstream failure into an account-pool action.
 *
 * - capability:    account+model ineligible → retire pair, try next account
 * - non-fallback:  permanent request error → return to client, do not rotate
 * - fallback:      rate limit / quota / transient error → cooldown + next account
 *
 * Reuses accountFallback.js rules; capability detection runs first so
 * "model not found" is never mistaken for a generic 4xx.
 *
 * @returns {{ action: string, cooldownMs: number, newBackoffLevel?: number }}
 */
export function classifyPoolError(status, errorText, backoffLevel = 0) {
  if (isModelCapabilityError(status, errorText)) {
    return { action: POOL_ACTIONS.CAPABILITY, cooldownMs: MODEL_INELIGIBLE_MS, newBackoffLevel: 0 };
  }

  const rule = matchFallbackRule(status, errorText);

  // An explicit ERROR_RULES match (rate limit / quota / auth / 5xx...) always
  // keeps its existing fallback semantics — even when the text also looks like
  // a malformed request.
  if (rule) return { ...checkFallbackError(status, errorText, backoffLevel), action: POOL_ACTIONS.FALLBACK };

  if (isRequestScopedError(status, errorText)) {
    return { action: POOL_ACTIONS.NON_FALLBACK, cooldownMs: 0, newBackoffLevel: backoffLevel };
  }

  const fallback = checkFallbackError(status, errorText, backoffLevel);
  return {
    action: fallback.shouldFallback ? POOL_ACTIONS.FALLBACK : POOL_ACTIONS.NON_FALLBACK,
    cooldownMs: fallback.cooldownMs,
    newBackoffLevel: fallback.newBackoffLevel ?? backoffLevel,
  };
}

// ---------------------------------------------------------------------------
// Session-scoped failure cache
// ---------------------------------------------------------------------------

// sessionKey -> Map("<connectionId>\0<model>" -> { until, model, status, action, at })
const sessionFailures = new Map();

function pruneExpired(now) {
  for (const [sessionKey, entries] of sessionFailures) {
    for (const [key, entry] of entries) {
      if (!entry || entry.until <= now) entries.delete(key);
    }
    if (entries.size === 0) sessionFailures.delete(sessionKey);
  }
}

function clampFailureMs(cooldownMs) {
  const value = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : SESSION_FAILURE_MIN_MS;
  return Math.min(Math.max(value, SESSION_FAILURE_MIN_MS), SESSION_FAILURE_MAX_MS);
}

/**
 * Resolve a stable conversation key shared by every account of a provider.
 * An explicit client session id (header/metadata) is preferred; otherwise the
 * accumulated assistant-text hash is used. When neither exists the derived id
 * is one-shot, which simply means no cross-request reuse for the first turn.
 *
 * connectionId is intentionally NOT passed: the whole point is that the pool
 * key survives an account switch.
 */
export function resolvePoolSessionKey({ provider, headers, body } = {}) {
  if (!provider) return null;
  let sessionId = null;
  try {
    sessionId = resolveSessionId({ headers, body, connectionId: null, scope: `pool:${provider}` });
  } catch {
    sessionId = null;
  }
  return sessionId ? `${provider}${ENTRY_SEPARATOR}${sessionId}` : null;
}

function entryKey(connectionId, model) {
  return `${connectionId}${ENTRY_SEPARATOR}${model || ""}`;
}

/**
 * Record an account failure for the current session.
 * @param {string} sessionKey - From resolvePoolSessionKey()
 * @param {string} connectionId
 * @param {{ model?: string|null, status?: number|null, cooldownMs?: number, action?: string }} info
 */
export function recordAccountFailure(sessionKey, connectionId, { model = null, status = null, cooldownMs = 0, action = POOL_ACTIONS.FALLBACK } = {}) {
  if (!sessionKey || !connectionId) return;
  const now = Date.now();
  pruneExpired(now);

  let entries = sessionFailures.get(sessionKey);
  if (!entries) {
    if (sessionFailures.size >= SESSION_CACHE_MAX_ENTRIES) {
      sessionFailures.delete(sessionFailures.keys().next().value);
    }
    entries = new Map();
    sessionFailures.set(sessionKey, entries);
  }

  const key = entryKey(connectionId, model);
  const existing = entries.get(key);
  const until = now + clampFailureMs(cooldownMs);
  entries.set(key, {
    until: existing && existing.until > until ? existing.until : until,
    model: model || null,
    status: status ?? existing?.status ?? null,
    action,
    at: now,
  });
}

/**
 * Forget cached failures for this account in the session (used on success).
 * Only the succeeded model and account-wide entries are cleared; a capability
 * block recorded for a different model must survive — the account can be fine
 * for model B while still ineligible for model A.
 */
export function recordAccountSuccess(sessionKey, connectionId, model = null) {
  if (!sessionKey || !connectionId) return;
  const entries = sessionFailures.get(sessionKey);
  if (!entries) return;
  for (const key of entries.keys()) {
    if (key === `${connectionId}${ENTRY_SEPARATOR}` || key === entryKey(connectionId, model)) {
      entries.delete(key);
    }
  }
  if (entries.size === 0) sessionFailures.delete(sessionKey);
}

/**
 * Connection ids that already failed for this session+model and are still in
 * cooldown. Includes capability blocks (account permanently ineligible for
 * that model within the session).
 * @returns {Set<string>}
 */
export function getSessionExcludedAccountIds(sessionKey, model = null) {
  const excluded = new Set();
  if (!sessionKey) return excluded;
  const now = Date.now();
  const entries = sessionFailures.get(sessionKey);
  if (!entries) return excluded;

  for (const [key, entry] of entries) {
    if (!entry || entry.until <= now) continue;
    const sep = key.indexOf(ENTRY_SEPARATOR);
    if (sep < 0) continue;
    const connectionId = key.slice(0, sep);
    const entryModel = key.slice(sep + 1);
    // Account-wide failures (no model) apply to every model; model-scoped
    // failures only block that model.
    if (!entryModel || !model || entryModel === model) excluded.add(connectionId);
  }
  return excluded;
}

/**
 * Earliest moment the session cache frees at least one account for this model.
 * Capability blocks are excluded: they describe model ineligibility, not a
 * temporary cooldown, so an all-capability failure should surface the upstream
 * error instead of a retry-after.
 * @returns {string|null} ISO timestamp
 */
export function getSessionRetryAt(sessionKey, model = null) {
  if (!sessionKey) return null;
  const now = Date.now();
  const entries = sessionFailures.get(sessionKey);
  if (!entries) return null;

  let earliest = null;
  for (const [key, entry] of entries) {
    if (!entry || entry.until <= now || entry.action === POOL_ACTIONS.CAPABILITY) continue;
    const sep = key.indexOf(ENTRY_SEPARATOR);
    if (sep < 0) continue;
    const entryModel = key.slice(sep + 1);
    if (entryModel && model && entryModel !== model) continue;
    if (!earliest || entry.until < earliest) earliest = entry.until;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Number of live entries (test/debug helper, never logs credentials).
 */
export function getAccountPoolSize() {
  pruneExpired(Date.now());
  let total = 0;
  for (const entries of sessionFailures.values()) total += entries.size;
  return total;
}

/**
 * Drop all session failure state. Tests and explicit resets only.
 */
export function clearAccountPoolCache() {
  sessionFailures.clear();
}
