/**
 * Headroom pipeline transport.
 *
 * 9Router's default Headroom integration calls the compression-only endpoint
 * (POST /v1/compress), which by design handles messages only — system prompts,
 * tool schemas and output shaping are out of scope there.
 *
 * This module adds a full-pipeline mode: inference requests that match a wire
 * format Headroom natively serves (/v1/chat/completions, /v1/responses,
 * /v1/messages) are routed through the Headroom proxy instead of the provider,
 * with `x-headroom-base-url` telling Headroom where to forward. Headroom then
 * runs its whole pipeline — messages + tools + system compaction, output
 * shaping, cache alignment — and streams the provider response back.
 *
 * Stock Headroom supports this per-request override, so no Headroom fork is
 * needed. The routing is scoped to `executor.execute()` via AsyncLocalStorage
 * (see proxyFetch.js), so token refreshes, usage calls and non-inference
 * requests keep going direct. Connection failures fail open (direct retry).
 *
 * URL contract (verified against Headroom handlers):
 *   original              upstream base header            Headroom re-appends
 *   /v1/chat/completions  strip "/v1/chat/completions"    /v1/chat/completions
 *   /v1/responses         strip "/v1/responses"           /v1/responses
 *   /v1/messages          strip "/v1/messages"            /v1/messages (request path)
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

// Standard versioned inference paths: base keeps its prefix (e.g. /zen/go).
const VERSIONED_ENDPOINTS = [
  { suffix: "/v1/chat/completions", path: "/v1/chat/completions" },
  { suffix: "/v1/responses", path: "/v1/responses" },
  { suffix: "/v1/messages", path: "/v1/messages" },
];

// Non-versioned paths (custom gateways): keep the original path via
// x-headroom-original-path and use the origin as the base.
const UNVERSIONED_ENDPOINTS = [
  { suffix: "/chat/completions", path: "/v1/chat/completions" },
  { suffix: "/responses", path: "/v1/responses" },
];

const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Trim whitespace and trailing slashes from a Headroom proxy URL. */
export function normalizeHeadroomUrl(url) {
  return typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}

/**
 * Run `fn` with the Headroom pipeline active. All proxyAwareFetch calls made
 * inside `fn` that match a supported inference path are routed through Headroom.
 * Returns fn() directly when no usable URL is configured.
 */
export function runWithHeadroomPipeline(config, fn) {
  const url = normalizeHeadroomUrl(config?.url);
  if (!url) return fn();
  return storage.run({ url }, fn);
}

/** Active pipeline context, or null outside a wrapped executor call. */
export function getHeadroomPipelineContext() {
  return storage.getStore() || null;
}

/**
 * Headroom's upstream guard rejects private/loopback targets (SSRF). Keep those
 * connections direct so local providers (Ollama, LM Studio, local nodes) keep
 * working instead of being routed to the proxy's fallback upstream.
 */
export function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host.endsWith(".local")) return true;
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Compute the Headroom request and the upstream override for an outbound
 * inference URL. Returns null for anything Headroom doesn't natively serve.
 *
 * @returns {{ url: string, upstreamBaseUrl: string, originalPath: string|null }|null}
 */
export function buildHeadroomTarget(originalUrl, headroomBaseUrl) {
  const base = normalizeHeadroomUrl(headroomBaseUrl);
  if (!base || typeof originalUrl !== "string") return null;

  let parsed;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (isLocalOrPrivateHost(parsed.hostname)) return null;

  for (const endpoint of VERSIONED_ENDPOINTS) {
    if (!parsed.pathname.endsWith(endpoint.suffix)) continue;
    const prefix = parsed.pathname.slice(0, -endpoint.suffix.length);
    return {
      url: `${base}${endpoint.path}${parsed.search}`,
      upstreamBaseUrl: `${parsed.origin}${prefix}`,
      originalPath: null,
    };
  }

  for (const endpoint of UNVERSIONED_ENDPOINTS) {
    if (!parsed.pathname.endsWith(endpoint.suffix)) continue;
    return {
      url: `${base}${endpoint.path}${parsed.search}`,
      upstreamBaseUrl: parsed.origin,
      originalPath: parsed.pathname,
    };
  }

  return null;
}

/**
 * True when an error means the Headroom hop itself couldn't connect, so the
 * caller may safely retry the original URL directly (fail-open). Aborts are
 * never retried, and HTTP-level errors are not connect failures.
 */
export function isHeadroomConnectError(error) {
  if (!error || error.name === "AbortError") return false;
  const code = error.cause?.code || error.code || "";
  if (CONNECT_ERROR_CODES.has(code)) return true;
  const message = String(error.cause?.message || error.message || "");
  return message.includes("ECONNREFUSED") || message.includes("fetch failed");
}

/** Headers instance/array/object → plain object (for merging). */
export function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function") {
    try {
      return Object.fromEntries(headers.entries());
    } catch {
      return {};
    }
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}
