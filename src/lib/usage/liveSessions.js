/**
 * In-flight session registry.
 *
 * Request details are written when a request finishes, so a session that is
 * currently generating has no row yet. This registry lets the proxy announce
 * "session started / still generating" the moment a request enters routing, so
 * the Sessions tab can list and attach to running sessions immediately.
 *
 * Entries are pruned by inactivity; a session stops being "generating" once a
 * persisted detail newer than its start lands (computed by the list route).
 */

import { EventEmitter } from "events";

const globalStore = globalThis;
if (!globalStore._liveSessions) {
  globalStore._liveSessions = { map: new Map(), emitter: new EventEmitter() };
  globalStore._liveSessions.emitter.setMaxListeners(200);
}

const entries = globalStore._liveSessions.map;
export const liveSessionsEmitter = globalStore._liveSessions.emitter;

const MAX_AGE_MS = 10 * 60 * 1000;

function prune(now = Date.now()) {
  for (const [id, entry] of entries) {
    if (now - entry.lastEventAt > MAX_AGE_MS) {
      entries.delete(id);
    }
  }
}

/**
 * Register a request start. Explicit sessions key on their session id; implicit
 * ones key on the loose identity (api key + first user message) until the
 * persisted session exists.
 */
export function registerSessionStart({ sessionId, liveKey, provider, model, label, apiKey, timestamp } = {}) {
  const id = sessionId || (liveKey ? `live:${liveKey}` : null);
  if (!id) return null;

  const now = Date.now();
  prune(now);
  const existing = entries.get(id);
  const entry = {
    id,
    sessionId: sessionId || null,
    liveKey: liveKey || existing?.liveKey || null,
    kind: sessionId ? "explicit" : "implicit",
    provider: provider || existing?.provider || null,
    model: model || existing?.model || null,
    label: label || existing?.label || null,
    apiKey: apiKey || existing?.apiKey || null,
    startedAt: existing?.startedAt || timestamp || new Date(now).toISOString(),
    lastEventAt: now,
    requests: (existing?.requests || 0) + 1,
    generating: true,
  };
  entries.set(id, entry);
  liveSessionsEmitter.emit("session", { type: "start", session: entry });
  return entry;
}

export function listLiveSessions({ withinMs = MAX_AGE_MS } = {}) {


  const now = Date.now();
  prune(now);
  return [...entries.values()]
    .filter((entry) => now - entry.lastEventAt <= withinMs)
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
}

export function getLiveSession(id) {
  prune();
  return entries.get(id) || null;
}

/** Is this session (explicit id or loose key) currently generating? */
export function findGeneratingSession({ sessionId, liveKey } = {}) {
  const now = Date.now();
  prune(now);
  for (const entry of entries.values()) {
    if (sessionId && entry.sessionId === sessionId) return entry;
    if (liveKey && entry.liveKey === liveKey) return entry;
  }
  return null;
}

/** Drop the in-flight session registry (stale "live" rows disappear). */
export function clearLiveSessions() {
  const removed = entries.size;
  entries.clear();
  return removed;
}

export function liveSessionCount() {
  return entries.size;
}

