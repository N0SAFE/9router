/**
 * Merge rich request details (latency, content, pxpipe) with the long-lived
 * usage history (tokens, cost, status) so the Usage views stay complete even
 * when observability was off or a buffered detail was lost.
 *
 * Request details win on overlap; history rows fill the gaps.
 */

const OVERLAP_WINDOW_MS = 5000;

function roundWindow(ms) {
  return Math.round(ms / OVERLAP_WINDOW_MS) * OVERLAP_WINDOW_MS;
}

export function overlapKey(row) {
  const time = row?.timestamp ? new Date(row.timestamp).getTime() : 0;
  return `${row?.provider || ""}|${row?.model || ""}|${row?.connectionId || ""}|${roundWindow(time)}`;
}

/** Public alias: filter detail rows whose history match was filtered out. */
export const usageOverlapKey = overlapKey;

/** Map a usageHistory row into the request-detail shape. */
export function mapHistoryRow(row) {
  const tokens = row?.tokens && typeof row.tokens === "object" ? row.tokens : {};
  const status = !row?.status || row.status === "ok" ? "success" : String(row.status);
  return {
    id: `history:${row?.timestamp || ""}:${row?.model || ""}`,
    timestamp: row?.timestamp || null,
    provider: row?.provider || null,
    model: row?.model || null,
    connectionId: row?.connectionId || null,
    status,
    tokens: {
      prompt_tokens: tokens.prompt_tokens ?? row?.promptTokens,
      completion_tokens: tokens.completion_tokens ?? row?.completionTokens,
      cached_tokens: tokens.cached_tokens,
      cache_creation_input_tokens: tokens.cache_creation_input_tokens,
      reasoning_tokens: tokens.reasoning_tokens,
    },
    latency: {},
    cost: typeof row?.cost === "number" ? row.cost : 0,
    routingSummary: row?.routingSummary || row?.meta?.routing || null,
    source: "history",
  };
}

/**
 * @param {Array<object>} details - from requestDetails
 * @param {Array<object>} history - from usageHistory (already mapped or raw)
 * @returns {Array<object>} merged, newest first
 */
export function mergeUsageRows(details = [], history = []) {
  const merged = (Array.isArray(details) ? details : []).map((d) => ({ ...d, source: "detail" }));
  const seen = new Set(merged.map(overlapKey));

  for (const raw of Array.isArray(history) ? history : []) {
    const row = raw && raw.source ? raw : mapHistoryRow(raw);
    const key = overlapKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }

  merged.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  return merged;
}
