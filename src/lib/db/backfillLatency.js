/**
 * One-time backfill of latency columns on usageHistory.
 *
 * Latency (ttft/total) used to live only in requestDetails, which keeps a short
 * ring of the newest requests. New requests now write latency straight into
 * usageHistory; this backfill copies what the stored details still hold so
 * throughput metrics work for the period before that change.
 *
 * Matching uses the same 5-second overlap key as the usage views (provider +
 * model + connection + rounded timestamp), so a detail and its history row are
 * paired even though the two tables timestamp writes independently.
 */

import { getAdapter } from "./driver.js";
import { getMeta, setMeta } from "./helpers/metaStore.js";
import { parseJson } from "./helpers/jsonCol.js";
import { usageOverlapKey } from "../usage/mergeDetails.js";

const META_KEY = "usageLatencyBackfillV1";
const MAX_ROWS = 10000;

export async function backfillUsageLatency({ limit = MAX_ROWS } = {}) {
  const db = await getAdapter();

  let done = null;
  try {
    done = await getMeta(META_KEY, null);
  } catch {
    done = null;
  }
  if (done === "done") {
    return { skipped: true };
  }

  const details = db
    .all(`SELECT data FROM requestDetails ORDER BY timestamp DESC LIMIT ?`, [limit])
    .map((row) => parseJson(row.data, {}));

  const latencyByKey = new Map();
  for (const detail of details) {
    const total = Number(detail?.latency?.total) || 0;
    const ttft = Number(detail?.latency?.ttft) || 0;
    if (total <= 0) continue;
    latencyByKey.set(usageOverlapKey(detail), { ttft: ttft > 0 ? Math.round(ttft) : null, total: Math.round(total) });
  }
  if (latencyByKey.size === 0) {
    await setMeta(META_KEY, "done");
    return { skipped: true, reason: "no_latency_details" };
  }

  const rows = db.all(
    `SELECT id, timestamp, provider, model, connectionId
     FROM usageHistory
     WHERE (latencyTotal IS NULL OR latencyTotal = 0)
     ORDER BY id DESC LIMIT ?`,
    [limit]
  );

  let updated = 0;
  db.transaction(() => {
    for (const row of rows) {
      const hit = latencyByKey.get(usageOverlapKey(row));
      if (!hit) continue;
      db.run(`UPDATE usageHistory SET latencyTtft = ?, latencyTotal = ? WHERE id = ?`, [
        hit.ttft,
        hit.total,
        row.id,
      ]);
      updated += 1;
    }
  });

  await setMeta(META_KEY, "done");
  return { updated, candidates: rows.length, details: details.length };
}
