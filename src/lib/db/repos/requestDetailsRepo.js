import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { EventEmitter } from "events";
import { labelForDetail, liveKeyForDetail, mergeKeyForDetail } from "@/lib/usage/sessions.js";

// Live session monitoring: listeners (SSE routes) get told when a detail lands.
if (!global._detailsEmitter) {
  global._detailsEmitter = new EventEmitter();
  global._detailsEmitter.setMaxListeners(200);
}
export const detailsEmitter = global._detailsEmitter;

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 64 * 1024;
const DEFAULT_PROVIDER_MAX_JSON_SIZE = 8 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "64", 10)) * 1024,
        providerMaxJsonSize: (settings.observabilityProviderMaxJsonSize || parseInt(process.env.OBSERVABILITY_PROVIDER_MAX_JSON_SIZE || "8", 10)) * 1024,
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "64", 10)) * 1024,
      providerMaxJsonSize: (settings.observabilityProviderMaxJsonSize || parseInt(process.env.OBSERVABILITY_PROVIDER_MAX_JSON_SIZE || "8", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
      providerMaxJsonSize: DEFAULT_PROVIDER_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

// Older request-detail rows predate the derived session columns. Backfill them
// once, lazily, so the first dashboard read pays the old full-ring parse and all
// later implicit-session reads use the indexes. New rows always populate these
// columns in flushToDatabase().
let implicitKeyBackfillPromise = null;

export async function ensureImplicitSessionKeys() {
  if (!implicitKeyBackfillPromise) {
    implicitKeyBackfillPromise = (async () => {
      const db = await getAdapter();
      const rows = db.all(
        `SELECT id, data
         FROM requestDetails
         WHERE sessionId IS NULL AND (implicitKey IS NULL OR liveKey IS NULL)`
      );
      if (rows.length === 0) return 0;

      db.transaction(() => {
        for (const row of rows) {
          const detail = parseJson(row.data, null);
          if (!detail) continue;
          const implicitKey = mergeKeyForDetail(detail);
          const liveKey = liveKeyForDetail(detail);
          db.run(
            `UPDATE requestDetails
             SET implicitKey = COALESCE(implicitKey, ?), liveKey = COALESCE(liveKey, ?)
             WHERE id = ?`,
            [implicitKey || null, liveKey || null, row.id]
          );
        }
      });
      return rows.length;
    })().catch((error) => {
      // Do not permanently suppress a retry after a transient DB/reset failure.
      implicitKeyBackfillPromise = null;
      throw error;
    });
  }
  return implicitKeyBackfillPromise;
}

// Old rows can also predate the total-size guarantee in slimRequest. Compact
// those rows once, lazily, instead of letting a large historical transcript slow
// every session view. The original request is intentionally not reconstructed:
// observability storage is bounded evidence, not a second source of truth.
let detailMaintenancePromise = null;

export async function ensureRequestDetailMaintenance() {
  if (!detailMaintenancePromise) {
    detailMaintenancePromise = (async () => {
      await ensureImplicitSessionKeys();
      const config = await getObservabilityConfig();
      const db = await getAdapter();
      const sizeThreshold = Math.max(128 * 1024, config.maxJsonSize * 2);
      const rows = db.all(
        `SELECT id, data FROM requestDetails WHERE length(data) > ?`,
        [sizeThreshold]
      );
      if (rows.length === 0) return 0;

      let compacted = 0;
      db.transaction(() => {
        for (const row of rows) {
          const detail = parseJson(row.data, null);
          if (!detail) continue;
          const next = {
            ...detail,
            request: slimRequest(detail.request, config.maxJsonSize),
            providerRequest: truncateField(detail.providerRequest, config.providerMaxJsonSize || config.maxJsonSize),
            providerResponse: truncateField(detail.providerResponse, config.providerMaxJsonSize || config.maxJsonSize),
            response: truncateField(detail.response, config.maxJsonSize),
            ...(detail.routing ? { routing: truncateField(detail.routing, config.maxJsonSize) } : {}),
          };
          const serialized = stringifyJson(next);
          if (serialized.length >= row.data.length) continue;
          db.run("UPDATE requestDetails SET data = ? WHERE id = ?", [serialized, row.id]);
          compacted += 1;
        }
      });
      return compacted;
    })().catch((error) => {
      detailMaintenancePromise = null;
      throw error;
    });
  }
  return detailMaintenancePromise;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

function capContent(content, cap) {
  if (typeof content === "string") {
    return content.length > cap ? `${content.slice(0, cap)}…[truncated]` : content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return capContent(part, cap);
      if (!part || typeof part !== "object") return part;
      if (part.type === "text" && typeof part.text === "string") {
        return { ...part, text: part.text.length > cap ? `${part.text.slice(0, cap)}…[truncated]` : part.text };
      }
      if (part.type === "tool_result") return { ...part, content: capContent(part.content, cap) };
      if (part.type === "image" || part.type === "image_url") return { type: part.type, truncated: true };
      return part;
    });
  }
  return content;
}

function buildSlimRequest(request, cap, originalSize, maxMessages = Number.POSITIVE_INFINITY) {
  const { messages, ...rest } = request || {};
  delete rest.tools;
  delete rest.functions;
  const sourceMessages = Array.isArray(messages) ? messages : null;
  let keptMessages = sourceMessages;
  let omittedMessages = 0;
  if (sourceMessages && sourceMessages.length > maxMessages) {
    const headCount = Math.ceil(maxMessages / 2);
    const tailCount = Math.floor(maxMessages / 2);
    keptMessages = [
      ...sourceMessages.slice(0, headCount),
      ...(tailCount > 0 ? sourceMessages.slice(-tailCount) : []),
    ];
    omittedMessages = sourceMessages.length - keptMessages.length;
  }
  return {
    ...rest,
    ...(keptMessages
      ? {
          messages: keptMessages.map((message) => ({
            role: message?.role,
            ...(message?.name ? { name: message.name } : {}),
            ...(message?.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(Array.isArray(message?.tool_calls)
              ? {
                  tool_calls: message.tool_calls.map((call) => ({
                    id: call?.id || null,
                    function: {
                      name: call?.function?.name || call?.name || null,
                      arguments:
                        typeof call?.function?.arguments === "string"
                          ? call.function.arguments.slice(0, Math.min(1000, Math.max(32, cap * 4)))
                          : call?.function?.arguments ?? null,
                    },
                  })),
                }
              : {}),
            ...(message?.content !== undefined ? { content: capContent(message.content, cap) } : {}),
          })),
          ...(omittedMessages > 0 ? { _omittedMessages: omittedMessages } : {}),
        }
      : {}),
    _truncated: true,
    _originalSize: originalSize,
  };
}

/**
 * Requests over the storage cap used to be dropped wholesale (only a 200-char
 * preview survived), which left the chat unable to show the user's message or
 * the tool results. Keep the messages instead, with capped text.
 */
export function slimRequest(request, maxSize) {
  const str = JSON.stringify(request || {});
  if (str.length <= maxSize) return request || {};

  const messageCount = Array.isArray(request?.messages) ? request.messages.length : 0;
  for (const cap of [4000, 1000, 250, 120, 60]) {
    for (const maxMessages of [messageCount, 1000, 500, 250, 100, 50, 20, 1]) {
      if (maxMessages > messageCount && maxMessages !== messageCount) continue;
      const slim = buildSlimRequest(request, cap, str.length, maxMessages);
      if (JSON.stringify(slim).length <= maxSize) return slim;
    }
  }

  // The final fallback keeps one message only. It is preferable to storing an
  // oversized row that blocks every future session rebuild.
  return buildSlimRequest(request, 24, str.length, 1);
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  const saved = [];
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const sessionId =
            (typeof item.sessionId === "string" && item.sessionId.trim()) ||
            (typeof item.request?.metadata?.sessionId === "string" && item.request.metadata.sessionId.trim()) ||
            (typeof item.request?.metadata?.conversationId === "string" && item.request.metadata.conversationId.trim()) ||
            null;

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            sessionId,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: slimRequest(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.providerMaxJsonSize || config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.providerMaxJsonSize || config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
            // Combo/pool/account decision trace (metadata, already capped).
            routing: item.routing ? truncateField(item.routing, config.maxJsonSize) : undefined,
          };
          const label = labelForDetail(record);
          const liveKey = liveKeyForDetail(record);
          const implicitKey = sessionId ? null : mergeKeyForDetail(record);

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, sessionId, implicitKey, liveKey, label, data)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               timestamp = excluded.timestamp,
               provider = excluded.provider,
               model = excluded.model,
               connectionId = excluded.connectionId,
               status = excluded.status,
               sessionId = excluded.sessionId,
               implicitKey = excluded.implicitKey,
               liveKey = excluded.liveKey,
               label = excluded.label,
               data = excluded.data`,
            [
              record.id,
              record.timestamp,
              record.provider,
              record.model,
              record.connectionId,
              record.status,
              record.sessionId,
              implicitKey,
              liveKey,
              label,
              stringifyJson(record),
            ]
          );
          saved.push({
            id: record.id,
            sessionId: record.sessionId,
            implicitKey,
            liveKey,
            provider: record.provider,
            model: record.model,
            timestamp: record.timestamp,
            // Placeholder rows are written when a stream starts; the final row
            // (same id, upserted) carries the real content.
            streaming: item.response?.type === "streaming",
          });
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }

    // Notify live session streams after the rows are committed.
    for (const entry of saved) {
      try {
        detailsEmitter.emit("detail", entry);
      } catch {
        // listener errors must never break detail writes
      }
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {

  writeBuffer.push(detail);

  // Persist on the next tick instead of waiting for the batch/timer window.
  // Buffered rows were previously lost whenever the server restarted inside the
  // flush interval, which silently left gaps in the details view. The
  // isFlushing guard coalesces concurrent saves into one transaction.
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  queueMicrotask(() => {
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  });
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

/**
 * Fetch recent request details in a time range (no pagination) for the insight
 * engine. Bounded to keep the hot path light.
 */
export async function getRequestDetailsInRange(filter = {}, limit = 500) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const capped = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ?`,
    [...params, capped]
  );
  return rows.map((r) => parseJson(r.data, {}));
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

/**
 * All details for one explicit session id, oldest first (chat/timeline order).
 */
export async function getDetailsBySession(sessionId, limit = 500) {
  if (!sessionId) return [];
  const db = await getAdapter();
  const capped = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const rows = db.all(
    `SELECT data FROM requestDetails WHERE sessionId = ? ORDER BY timestamp ASC LIMIT ?`,
    [sessionId, capped]
  );
  return rows.map((row) => parseJson(row.data, null)).filter(Boolean);
}

/** Recent detail rows (newest first), parsed — used for implicit session grouping. */
export async function getRecentDetailRows(limit = 500) {
  const db = await getAdapter();
  const capped = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const rows = db.all(`SELECT data FROM requestDetails ORDER BY timestamp DESC LIMIT ?`, [capped]);
  return rows.map((row) => parseJson(row.data, null)).filter(Boolean);
}

/**
 * Details belonging to one implicit grouping key. The indexed path avoids
 * loading unrelated request bodies when a session view is opened.
 */
export async function getDetailsByImplicitKey(implicitKey, limit = 1000) {
  if (!implicitKey) return [];
  await ensureRequestDetailMaintenance();
  const db = await getAdapter();
  const capped = Math.max(1, Math.min(Number(limit) || 1000, 2000));
  const rows = db.all(
    `SELECT data FROM requestDetails
     WHERE sessionId IS NULL AND implicitKey = ?
     ORDER BY timestamp ASC LIMIT ?`,
    [implicitKey, capped]
  );
  return rows.map((row) => parseJson(row.data, null)).filter(Boolean);
}

/** Details matching an in-flight/live first-user identity. */
export async function getDetailsByLiveKey(liveKey, limit = 1000) {
  if (!liveKey) return [];
  await ensureRequestDetailMaintenance();
  const db = await getAdapter();
  const capped = Math.max(1, Math.min(Number(limit) || 1000, 2000));
  const rows = db.all(
    `SELECT data FROM requestDetails
     WHERE sessionId IS NULL AND liveKey = ?
     ORDER BY timestamp ASC LIMIT ?`,
    [liveKey, capped]
  );
  return rows.map((row) => parseJson(row.data, null)).filter(Boolean);
}

/** One detail row by id (already exposed through usageDb, kept here for symmetry). */
export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

/**
 * Last detail pushed through saveRequestDetail (in-memory). The dashboard chat
 * proxy uses it to append the routing trace to the stream it just finished.
 * `sinceMs` guards against returning a detail from a previous request.
 */
export function getLastRequestDetail(sinceMs = 0) {
  const entry = global._lastRequestDetail;
  if (!entry?.detail) {
    return null;
  }
  if (sinceMs && entry.savedAt < sinceMs) {
    return null;
  }
  return entry.detail;
}

/**
 * Find the stored detail for a dashboard chat request by its client request id
 * (sent in the request body's `metadata`). Scans only the newest rows.
 */
export async function getRequestDetailByClientRequestId(clientRequestId, limit = 50) {
  if (!clientRequestId) {
    return null;
  }
  const db = await getAdapter();
  const rows = db.all(
    `SELECT data FROM requestDetails ORDER BY timestamp DESC LIMIT ?`,
    [limit]
  );
  for (const row of rows) {
    const detail = parseJson(row.data, null);
    if (detail?.request?.metadata?.clientRequestId === clientRequestId) {
      return detail;
    }
  }
  return null;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
