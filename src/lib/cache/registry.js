/**
 * Cache surfaces the settings page can clear.
 *
 * Two kinds live here:
 *  - "memory": in-process caches. Clearing costs one refetch; nothing is lost.
 *  - "stored": rows in the local SQLite database. Clearing is permanent.
 *
 * Every surface reports what it holds (entries/rows) so the UI can show what a
 * clean will actually run on before it runs.
 */

import { getAdapter } from "@/lib/db/driver.js";
import { clearProviderQuotaCache, providerQuotaCacheSize } from "@/lib/keys/policyUsage.js";
import { clearKeyRuntimeState, keyRuntimeSize } from "@/lib/keys/concurrency.js";
import { clearLoginLockouts, loginLockoutSize } from "@/lib/auth/loginLimiter.js";
import { clearLiveSessions, liveSessionCount } from "@/lib/usage/liveSessions.js";
import { clearLiveRequests, liveRequestCount } from "@/lib/usage/liveRouting.js";
import { clearLiveTurns, liveTurnCount } from "@/lib/usage/liveContent.js";
import { clearProjectIdCache, projectIdCacheSize } from "open-sse/services/projectId.js";
import { clearCursorModelCache } from "open-sse/services/cursorModels.js";
import { clearSessionStore } from "open-sse/utils/sessionManager.js";
import { clearKiroSessionReplayStore } from "open-sse/utils/kiroSessionReplay.js";
import { resetComboRotation } from "open-sse/services/combo.js";

export const CACHE_GROUPS = [
  {
    id: "memory",
    label: "In-memory",
    description: "Rebuilt automatically from the next request — clearing only costs one refetch.",
  },
  {
    id: "stored",
    label: "Stored history",
    description: "Rows in the local database. Clearing removes them for good.",
  },
];

const TABLES = {
  requestDetails: "requestDetails",
  usageHistory: "usageHistory",
  usageDaily: "usageDaily",
};

async function countRows(table) {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(row?.c) || 0;
}

async function dropRows(table) {
  const db = await getAdapter();
  const before = await countRows(table);
  db.run(`DELETE FROM ${table}`);
  return before;
}

export async function databaseSizeBytes() {
  try {
    const db = await getAdapter();
    const pageCount = Number(db.get("PRAGMA page_count")?.page_count) || 0;
    const pageSize = Number(db.get("PRAGMA page_size")?.page_size) || 0;
    return pageCount * pageSize;
  } catch {
    return null;
  }
}

const SURFACES = [
  {
    id: "modelCatalog",
    group: "memory",
    label: "Model catalog",
    description: "Provider model lists fetched from upstream (Cursor and compatible endpoints). Refetched on the next sync.",
    clear: async () => {
      clearCursorModelCache();
      return { detail: "catalog entries dropped" };
    },
  },
  {
    id: "providerQuota",
    group: "memory",
    label: "Provider quota snapshots",
    description: "Cached quota/usage responses behind the Quota Tracker and key budgets. Fetched again on demand.",
    stats: async () => ({ entries: providerQuotaCacheSize() }),
    clear: async () => ({ removed: clearProviderQuotaCache() }),
  },
  {
    id: "projectIds",
    group: "memory",
    label: "Cloud project ids",
    description: "Resolved Google Cloud project ids for antigravity / gemini-cli connections. Re-resolved per connection.",
    stats: async () => ({ entries: projectIdCacheSize() }),
    clear: async () => ({ removed: clearProjectIdCache() }),
  },
  {
    id: "providerSessions",
    group: "memory",
    label: "Provider session ids",
    description:
      "Session ids reused so providers keep their prompt cache warm (Claude/Kiro replay, continuation ids). Clearing makes the next request look like a new conversation.",
    clear: async () => {
      clearSessionStore();
      clearKiroSessionReplayStore();
      return { detail: "session stores dropped" };
    },
  },
  {
    id: "comboRotation",
    group: "memory",
    label: "Combo rotation state",
    description: "Which model a combo served last, used for sticky and round-robin strategies. Resets to the first model.",
    clear: async () => {
      resetComboRotation();
      return { detail: "rotation state reset" };
    },
  },
  {
    id: "liveTraces",
    group: "memory",
    label: "Live traces",
    description:
      "In-flight session, routing and message registries that power the Sessions tab while a request runs. Clearing drops stale rows; running requests re-register on their next event.",
    stats: async () => ({ entries: liveSessionCount() + liveRequestCount() + liveTurnCount() }),
    clear: async () => ({
      removed: clearLiveSessions() + clearLiveRequests() + clearLiveTurns(),
    }),
  },
  {
    id: "keyRuntime",
    group: "memory",
    label: "Rate windows & concurrency",
    description:
      "In-memory RPM/RPH stamps and active request counters per API key. Clearing resets rate-limit windows — use it when testing limits.",
    stats: async () => ({ entries: keyRuntimeSize() }),
    clear: async () => ({ removed: clearKeyRuntimeState() }),
  },
  {
    id: "loginLockouts",
    group: "memory",
    label: "Sign-in lockouts",
    description: "Progressive lockouts recorded for failed dashboard sign-ins. Clearing unlocks every client immediately.",
    stats: async () => ({ entries: loginLockoutSize() }),
    clear: async () => ({ removed: clearLoginLockouts() }),
  },
  {
    id: "requestDetails",
    group: "stored",
    label: "Request & session history",
    description:
      "The rows behind the Sessions tab: prompts, replies, tool calls, routing traces and per-request metrics.",
    warning: "The Sessions tab empties out; transcripts copied earlier are unaffected.",
    stats: async () => ({ entries: await countRows(TABLES.requestDetails) }),
    clear: async () => ({ removed: await dropRows(TABLES.requestDetails) }),
  },
  {
    id: "usageAggregates",
    group: "stored",
    label: "Usage aggregates",
    description: "Per-day and per-request usage counters behind the Overview, Performance and Details tabs.",
    warning: "Charts and totals start over from the next request.",
    stats: async () => ({ entries: (await countRows(TABLES.usageHistory)) + (await countRows(TABLES.usageDaily)) }),
    clear: async () => ({ removed: (await dropRows(TABLES.usageHistory)) + (await dropRows(TABLES.usageDaily)) }),
  },
  {
    id: "sessionMonitors",
    group: "stored",
    label: "Watched sessions & budgets",
    description: "The watch list with its spend and token budgets (stored under the sessionMonitors scope).",
    stats: async () => {
      const db = await getAdapter();
      const row = db.get("SELECT COUNT(*) AS c FROM kv WHERE scope = ?", ["sessionMonitors"]);
      return { entries: Number(row?.c) || 0 };
    },
    clear: async () => {
      const db = await getAdapter();
      const row = db.get("SELECT COUNT(*) AS c FROM kv WHERE scope = ?", ["sessionMonitors"]);
      db.run("DELETE FROM kv WHERE scope = ?", ["sessionMonitors"]);
      return { removed: Number(row?.c) || 0 };
    },
  },
];

/** Every surface with its current size, grouped for the settings UI. */
export async function listCacheSurfaces() {
  const surfaces = [];
  for (const surface of SURFACES) {
    let stats = null;
    try {
      stats = surface.stats ? await surface.stats() : null;
    } catch (error) {
      stats = { error: String(error?.message || error) };
    }
    surfaces.push({
      id: surface.id,
      group: surface.group,
      label: surface.label,
      description: surface.description,
      warning: surface.warning || null,
      stats,
    });
  }
  return {
    groups: CACHE_GROUPS,
    surfaces,
    databaseBytes: await databaseSizeBytes(),
    generatedAt: new Date().toISOString(),
  };
}

/** Clear the selected surfaces; returns what was removed, per surface. */
export async function clearCacheSurfaces(ids = []) {
  const wanted = new Set(ids);
  const cleared = [];
  const errors = [];
  for (const surface of SURFACES) {
    if (!wanted.has(surface.id)) continue;
    try {
      const result = (await surface.clear()) || {};
      cleared.push({ id: surface.id, label: surface.label, removed: result.removed ?? null, detail: result.detail || null });
    } catch (error) {
      errors.push({ id: surface.id, label: surface.label, error: String(error?.message || error) });
    }
  }
  return { cleared, errors, unknown: ids.filter((id) => !SURFACES.some((surface) => surface.id === id)) };
}

/**
 * Reclaim disk space after clearing stored history: SQLite keeps the pages of
 * deleted rows until VACUUM rewrites the file.
 */
export async function compactDatabase() {
  const db = await getAdapter();
  const before = await databaseSizeBytes();
  db.run("VACUUM");
  const after = await databaseSizeBytes();
  return { before, after, savedBytes: before !== null && after !== null ? Math.max(0, before - after) : null };
}
