/**
 * Live routing registry.
 *
 * One entry per logical client request, fed by the routing trace as decisions
 * happen: combo → model → pool → account selection, every failed attempt with
 * its action, fallbacks, context/limit errors and completion. The Sessions tab
 * streams these so a running request can be attached to and watched while it is
 * being routed across providers, models and accounts.
 */

import { EventEmitter } from "events";

const globalStore = globalThis;
if (!globalStore._liveRouting) {
  globalStore._liveRouting = { map: new Map(), emitter: new EventEmitter() };
  globalStore._liveRouting.emitter.setMaxListeners(200);
}

const requests = globalStore._liveRouting.map;
export const liveRoutingEmitter = globalStore._liveRouting.emitter;

const KEEP_FINISHED_MS = 5 * 60 * 1000;
const MAX_EVENTS = 200;
const MAX_TEXT = 240;

// Status/error text that means the context window (or a limit) was exceeded.
const CONTEXT_PATTERNS = [
  /context[ _-]?length/i,
  /maximum context/i,
  /context window/i,
  /too many tokens/i,
  /token limit/i,
  /prompt is too long/i,
  /input length/i,
  /reduce the length/i,
  /exceeds? .*tokens?/i,
];

function clip(value) {
  const text = value == null ? "" : String(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function prune(now = Date.now()) {
  for (const [id, entry] of requests) {
    if (entry.finishedAt && now - entry.finishedAt > KEEP_FINISHED_MS) {
      requests.delete(id);
    } else if (!entry.finishedAt && now - entry.startedAtMs > 30 * 60 * 1000) {
      requests.delete(id);
    }
  }
}

function detectContextProblem(text) {
  const haystack = String(text || "");
  return CONTEXT_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function startLiveRequest({
  id,
  sessionId = null,
  liveKey = null,
  requestedModel = null,
  provider = null,
  model = null,
  apiKey = null,
  label = null,
  combo = null,
  connectionId = null,
  connectionName = null,
} = {}) {
  if (!id) return null;
  prune();
  const entry = {
    id,
    sessionId,
    liveKey,
    requestedModel: clip(requestedModel) || null,
    provider: clip(provider) || null,
    model: clip(model) || null,
    apiKey: apiKey || null,
    label: clip(label) || null,
    combo: combo ? clip(combo) : null,
    status: "routing",
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    finishedAtMs: null,
    events: [],
    attempts: [],
    selectedAccount: null,
    connectionId: connectionId || null,
    connectionName: connectionName || null,
    error: null,
    contextProblem: false,
  };
  requests.set(id, entry);
  liveRoutingEmitter.emit("request", { type: "start", request: entry });
  return entry;
}

export function pushRoutingEvent(id, event = {}) {
  const entry = requests.get(id);
  if (!entry) return null;
  const at = Date.now();
  const normalized = {
    at,
    atIso: new Date(at).toISOString(),
    type: clip(event.type) || "note",
    message: event.message ? clip(event.message) : null,
    ...event,
    type: clip(event.type) || "note",
    message: event.message ? clip(event.message) : null,
  };
  if (entry.events.length < MAX_EVENTS) entry.events.push(normalized);

  if (normalized.type === "attempt") {
    const attempt = {
      at,
      provider: clip(event.provider || entry.provider),
      model: clip(event.model || entry.model),
      account: clip(event.account || event.connectionName || null),
      connectionId: event.connectionId || null,
      status: event.status ?? null,
      error: event.error ? clip(event.error) : null,
      action: event.action ? clip(event.action) : null,
      cooldownMs: event.cooldownMs || 0,
    };
    if (entry.attempts.length < MAX_EVENTS) entry.attempts.push(attempt);
    if (detectContextProblem(`${attempt.error || ""} ${attempt.status || ""}`)) {
      entry.contextProblem = true;
    }
  }
  if (normalized.type === "error") {
    entry.status = "error";
    entry.error = clip(event.error || event.message || `HTTP ${event.status ?? "?"}`);
    if (detectContextProblem(`${event.error || ""} ${event.status || ""} ${event.message || ""}`)) {
      entry.contextProblem = true;
    }
  }
  if (normalized.type === "combo") {
    entry.combo = clip(event.combo || event.message) || null;
  }
  if (normalized.type === "model") {
    if (event.provider) entry.provider = clip(event.provider);
    if (event.model) entry.model = clip(event.model);
  }
  if (normalized.type === "account" || normalized.connectionId || normalized.connectionName) {
    entry.selectedAccount = clip(event.connectionName || event.connectionId || entry.selectedAccount) || null;
    if (event.connectionId) entry.connectionId = event.connectionId;
    if (event.connectionName) entry.connectionName = clip(event.connectionName);
  }
  if (normalized.type === "streaming" || normalized.type === "complete") {
    entry.status = normalized.type === "complete" ? "completed" : "streaming";
  }
  if (normalized.type === "fallback") {
    entry.status = "fallback";
  }

  liveRoutingEmitter.emit("request", { type: "event", request: entry, event: normalized });
  return normalized;
}

export function updateLiveRequestUsage(id, { provider = null, model = null, tokens = null, costUsd = null, connectionId = null, connectionName = null } = {}) {
  const entry = requests.get(id);
  if (!entry) return null;
  if (provider) entry.provider = clip(provider);
  if (model) entry.model = clip(model);
  if (tokens) entry.tokens = tokens;
  if (Number.isFinite(costUsd)) entry.costUsd = costUsd;
  if (connectionId) entry.connectionId = connectionId;
  if (connectionName) entry.connectionName = clip(connectionName);
  liveRoutingEmitter.emit("request", { type: "usage", request: entry });
  return entry;
}

export function finishLiveRequest(id, { status = "completed", provider = null, model = null, error = null, tokens = null, costUsd = null, connectionId = null, connectionName = null } = {}) {
  const entry = requests.get(id);
  if (!entry) return null;
  const at = Date.now();
  entry.status = status;
  entry.finishedAtMs = at;
  entry.finishedAt = new Date(at).toISOString();
  entry.durationMs = at - entry.startedAtMs;
  if (provider) entry.provider = clip(provider);
  if (model) entry.model = clip(model);
  if (connectionId) entry.connectionId = connectionId;
  if (connectionName) entry.connectionName = clip(connectionName);
  if (error) entry.error = clip(error);
  if (tokens) entry.tokens = tokens;
  if (Number.isFinite(costUsd)) entry.costUsd = costUsd;
  liveRoutingEmitter.emit("request", { type: "finish", request: entry });
  return entry;
}

export function getLiveRequest(id) {


  prune();
  return requests.get(id) || null;
}

export function listLiveRequests({ withinMs = KEEP_FINISHED_MS } = {}) {
  const now = Date.now();
  prune(now);
  return [...requests.values()]
    .filter((entry) => !entry.finishedAt || now - entry.finishedAtMs <= withinMs)
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
}

/** Drop the live routing traces. */
export function clearLiveRequests() {
  const removed = requests.size;
  requests.clear();
  return removed;
}

export function liveRequestCount() {
  return requests.size;
}

