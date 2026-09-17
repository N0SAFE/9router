/**
 * In-process concurrency counter per API key. Used by the policy engine's
 * `maxConcurrent` rule. Entries are pruned when they drop to zero so the map
 * cannot grow unbounded.
 */

const globalStore = globalThis;
if (!globalStore._keyConcurrency) {
  globalStore._keyConcurrency = new Map();
}
const counters = globalStore._keyConcurrency;

export function beginKeyRequest(keyId) {
  if (!keyId) return 0;
  const entry = counters.get(keyId) || { count: 0, lastTouch: 0 };
  entry.count += 1;
  entry.lastTouch = Date.now();
  counters.set(keyId, entry);
  return entry.count;
}

export function endKeyRequest(keyId) {
  if (!keyId) return 0;
  const entry = counters.get(keyId);
  if (!entry) return 0;
  entry.count = Math.max(0, entry.count - 1);
  entry.lastTouch = Date.now();
  if (entry.count === 0) {
    counters.delete(keyId);
    return 0;
  }
  return entry.count;
}

export function getKeyConcurrency(keyId) {
  if (!keyId) return 0;
  return counters.get(keyId)?.count || 0;
}

/* ----------------------------- rate windows ------------------------------ */

if (!globalStore._keyRateWindows) {
  globalStore._keyRateWindows = new Map();
}
const rateWindows = globalStore._keyRateWindows;
const WINDOW_MS = 60 * 60 * 1000;

/** Record a request start so RPM/RPH limits see bursts before DB rows land. */
export function recordKeyRequestStart(keyId, now = Date.now()) {
  if (!keyId) return;
  const stamps = rateWindows.get(keyId) || [];
  stamps.push(now);
  const cutoff = now - WINDOW_MS;
  const pruned = stamps.filter((stamp) => stamp >= cutoff);
  rateWindows.set(keyId, pruned);
}

/** In-memory starts per key for the last minute / hour. */
export function getKeyRecentStarts(keyId, now = Date.now()) {
  if (!keyId) return { rpm: 0, rph: 0 };
  const stamps = (rateWindows.get(keyId) || []).filter((stamp) => stamp >= now - WINDOW_MS);
  return {
    rpm: stamps.filter((stamp) => stamp >= now - 60 * 1000).length,
    rph: stamps.length,
  };
}
