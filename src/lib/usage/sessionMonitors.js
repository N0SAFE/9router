/**
 * Session watch list + per-session budgets, stored in the shared kv table
 * (scope "sessionMonitors"). Dashboard-only.
 */

import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";

const SCOPE = "sessionMonitors";

export async function listSessionMonitors() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const row of rows) {
    const parsed = parseJson(row.value, null);
    if (parsed) out[row.key] = parsed;
  }
  return out;
}

export async function getSessionMonitor(sessionId) {
  if (!sessionId) return null;
  const all = await listSessionMonitors();
  return all[sessionId] || null;
}

export async function upsertSessionMonitor(sessionId, patch = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  const db = await getAdapter();
  const existing = (await getSessionMonitor(sessionId)) || {};
  const next = {
    sessionId,
    label: typeof patch.label === "string" && patch.label ? patch.label : existing.label || null,
    pinned: patch.pinned === undefined ? existing.pinned !== false : patch.pinned === true,
    budgetUsd: patch.budgetUsd === undefined ? existing.budgetUsd ?? null : (Number.isFinite(Number(patch.budgetUsd)) ? Number(patch.budgetUsd) : null),
    budgetTokens: patch.budgetTokens === undefined ? existing.budgetTokens ?? null : (Number.isFinite(Number(patch.budgetTokens)) ? Number(patch.budgetTokens) : null),
    updatedAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, sessionId, stringifyJson(next)]
  );
  return next;
}

export async function deleteSessionMonitor(sessionId) {
  if (!sessionId) return false;
  const db = await getAdapter();
  const result = db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, sessionId]);
  return (result?.changes ?? 0) > 0;
}
