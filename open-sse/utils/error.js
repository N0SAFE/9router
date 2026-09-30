import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";

// Provider error bodies are capped so one pathological upstream payload can't
// flood the client, the log, or the request-detail row.
const MAX_ERROR_MESSAGE_LEN = 4000;
const MAX_ERROR_DEPTH = 4;

/**
 * Coerce any error-ish value into plain text.
 *
 * Upstreams report failures in wildly different shapes: a bare string,
 * `{ message }`, `{ error: { message } }`, `{ detail: "..." }`, an array of
 * candidates, or a structured object with no message at all. Interpolating any
 * non-string into a template literal or JSON `error.message` field degrades to
 * `[object Object]` for the client, so every error path funnels through here.
 *
 * @param {unknown} value - Raw error/message value
 * @param {string} [fallback] - Returned when nothing usable is found
 * @param {number} [depth] - Internal recursion guard
 * @returns {string} Plain-text message (never an object)
 */
export function toPlainErrorMessage(value, fallback = "", depth = 0) {
  if (value == null) return fallback;

  if (typeof value === "string") {
    const text = value.trim();
    return text || fallback;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (value instanceof Error) {
    return toPlainErrorMessage(value.message, fallback, depth + 1);
  }

  if (depth >= MAX_ERROR_DEPTH) return fallback;

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = toPlainErrorMessage(item, "", depth + 1);
      if (text) return text;
    }
    return fallback;
  }

  if (typeof value === "object") {
    // Common upstream envelopes, in order of usefulness.
    for (const key of ["message", "error", "detail", "reason", "description", "msg"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = value[key];
      if (nested === value) continue; // self-reference guard
      const text = toPlainErrorMessage(nested, "", depth + 1);
      if (text) return text;
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}") {
        return json.length > MAX_ERROR_MESSAGE_LEN ? `${json.slice(0, MAX_ERROR_MESSAGE_LEN)}…` : json;
      }
    } catch { /* circular or non-serialisable — fall through */ }
    return fallback;
  }

  return fallback;
}

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message (coerced to plain text)
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: toPlainErrorMessage(message, DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred"),
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const fallback = DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        return {
          statusCode: parsed.status || response.status,
          message: toPlainErrorMessage(parsed.message, fallback),
          resetsAtMs: parsed.resetsAtMs
        };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    // Prefer the upstream's own message field; anything else falls back to the
    // raw body so nothing useful is lost, and is coerced to plain text below.
    message = toPlainErrorMessage(json?.error ?? json?.message ?? json, "", 1);
  } catch { /* not JSON — use the raw body */ }

  if (!message) message = toPlainErrorMessage(bodyText, "");

  const finalMessage = message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null) {
  const text = toPlainErrorMessage(message, DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred");
  return {
    success: false,
    status: statusCode,
    error: text,
    resetsAtMs,
    response: errorResponse(statusCode, text, extraHeaders)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${toPlainErrorMessage(message, "Unavailable")} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error?.code || "FETCH_FAILED";
  const message = toPlainErrorMessage(error?.message ?? error, "Unknown error");
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error?.cause?.code;
  const causeMsg = error?.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
