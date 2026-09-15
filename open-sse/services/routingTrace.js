/**
 * Per-request routing trace.
 *
 * Records the full decision path for one logical client request so the
 * dashboard can explain what actually happened:
 *   - was it a combo (and which models were tried, in order)?
 *   - did the capacity adapter add fallback models?
 *   - which provider/model was resolved?
 *   - which account pool was used and why was this account picked?
 *   - every failed attempt (rate limit / quota / capability), its action and
 *     where traffic was redirected next
 *   - the winning account
 *
 * The object is mutated in place while the request is being routed and is
 * persisted with the request detail (see buildRequestDetail). Everything is
 * clipped/capped so a pathological request cannot bloat storage.
 */

const MAX_ATTEMPTS = 30;
const MAX_MODELS = 40;
const MAX_TEXT = 220;
const MAX_ACCOUNTS = 30;

function clip(value) {
  const text = value == null ? "" : String(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export function createRoutingTrace({ requestedModel, sourceFormat, comboName = null, comboStrategy = null, adapterAdded = [], kind = null } = {}) {
  const trace = {
    requestedModel: clip(requestedModel) || null,
    sourceFormat: clip(sourceFormat) || null,
    combo: null,
    provider: null,
    model: null,
    pool: null,
    attempts: [],
    selected: null,
  };
  if (comboName) ensureCombo(trace, { name: comboName, strategy: comboStrategy, adapterAdded, kind });
  return trace;
}

/** Attach/refresh combo metadata (idempotent). */
export function ensureCombo(trace, { name, strategy = "fallback", adapterAdded = [], kind = null } = {}) {
  if (!trace || !name) return trace;
  trace.combo = {
    name: clip(name),
    strategy: clip(strategy) || "fallback",
    kind: kind ? clip(kind) : null,
    adapterModels: Array.isArray(adapterAdded) ? adapterAdded.slice(0, 10).map(clip) : [],
    models: trace.combo?.models || [],
  };
  return trace;
}

export function recordComboModel(trace, model, { status = "unknown", error = null } = {}) {
  if (!trace?.combo) return;
  const entry = { model: clip(model), status: clip(status) || "unknown", error: error ? clip(error) : null };
  const existing = trace.combo.models.findIndex((m) => m.model === entry.model && m.status === "pending");
  if (existing >= 0) trace.combo.models[existing] = entry;
  else if (trace.combo.models.length < MAX_MODELS) trace.combo.models.push(entry);
}

export function recordModelSelection(trace, { provider, model, reason = null } = {}) {
  if (!trace) return;
  trace.provider = clip(provider) || trace.provider;
  trace.model = clip(model) || trace.model;
  if (reason) trace.selectionReason = clip(reason);
}

export function recordPool(trace, { provider, strategy = null, total = null, available = null, accounts = null } = {}) {
  if (!trace) return;
  trace.pool = {
    provider: clip(provider) || trace.provider,
    strategy: strategy ? clip(strategy) : trace.pool?.strategy || null,
    total: Number.isFinite(total) ? total : trace.pool?.total ?? (Array.isArray(accounts) ? accounts.length : null),
    available: Number.isFinite(available) ? available : trace.pool?.available ?? null,
    accounts: Array.isArray(accounts)
      ? accounts.slice(0, MAX_ACCOUNTS).map((account) => ({
          connectionId: clip(account?.id || account?.connectionId),
          name: clip(account?.name || account?.connectionName || account?.displayName),
        }))
      : trace.pool?.accounts,
  };
}

export function recordAccountSelected(trace, { connectionId, connectionName, reason = null } = {}) {
  if (!trace) return;
  trace.selected = {
    connectionId: clip(connectionId) || null,
    name: clip(connectionName) || null,
    reason: reason ? clip(reason) : trace.selected?.reason || null,
  };
}

function lastAttempt(trace) {
  return trace?.attempts?.[trace.attempts.length - 1] || null;
}

/**
 * Record one failed/attempted account. Links the previous attempt to this
 * account as its redirect target so the drawer can draw the chain.
 */
export function recordAccountAttempt(trace, { connectionId, name, status = null, error = null, action = null, cooldownMs = 0 } = {}) {
  if (!trace) return;
  const previous = lastAttempt(trace);
  if (previous && !previous.redirectTo && connectionId) previous.redirectTo = clip(connectionId);
  if (trace.attempts.length >= MAX_ATTEMPTS) trace.attempts.shift();
  trace.attempts.push({
    connectionId: clip(connectionId) || null,
    name: clip(name) || null,
    status: status == null ? null : (Number.isFinite(Number(status)) ? Number(status) : clip(status)),
    error: error ? clip(error) : null,
    action: action ? clip(action) : null,
    cooldownMs: Number(cooldownMs) || 0,
    at: new Date().toISOString(),
  });
}

export function recordRoutingNote(trace, note) {
  if (trace) trace.note = clip(note);
}

/** Compact one-line summary for logs / usage history. */
export function routingSummary(trace) {
  if (!trace) return "";
  const parts = [];
  if (trace.combo) {
    const ok = trace.combo.models.filter((m) => m.status === "success").length;
    const label = trace.combo.kind === "capacity" ? "adapter" : "combo";
    parts.push(`${label}:${trace.combo.name}(${ok}/${trace.combo.models.length})`);
  } else if (trace.pool || trace.provider) {
    parts.push(`pool:${trace.provider}`);
  }
  if (trace.attempts.length > 0) {
    parts.push(trace.attempts.map((a) => `${a.name || a.connectionId || "account"}:${a.status ?? a.action ?? "?"}`).join("→"));
  }
  if (trace.selected?.name) parts.push(`used:${trace.selected.name}`);
  return clip(parts.join(" | "));
}
