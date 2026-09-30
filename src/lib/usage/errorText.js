/**
 * Client-side error text flattening.
 *
 * Providers report failures as objects — `{ message }`, `{ error: { message } }`,
 * `{ detail }`, or a bare payload with no message field. React renders any
 * non-string in a `title` or text node via `String(value)`, which produces
 * `[object Object]`. This unwraps the usual envelopes and only falls back to
 * JSON when there is nothing readable left.
 *
 * Shared by the usage UI (request details, routing canvas) so the same provider
 * error always reads the same way wherever it is displayed.
 *
 * @param {unknown} value
 * @returns {string} Plain text, `""` when nothing usable is present
 */
export function errorText(value) {
  return flatten(value, 0);
}

// Envelope keys, most descriptive first.
const ENVELOPE_KEYS = ["message", "error", "detail", "reason", "description", "msg"];
// Bound the walk: upstream payloads can nest arbitrarily, and a cycle would
// otherwise recurse until the stack blows.
const MAX_DEPTH = 5;

function flatten(value, depth) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return value.message || "";
  if (depth >= MAX_DEPTH) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = flatten(item, depth + 1);
      if (text) return text;
    }
    return "";
  }

  if (typeof value === "object") {
    for (const key of ENVELOPE_KEYS) {
      const nested = value[key];
      if (nested == null || nested === value) continue; // self-reference guard
      const text = flatten(nested, depth + 1);
      if (text) return text;
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}") return json;
    } catch { /* circular — nothing readable left */ }
    return "";
  }

  return String(value);
}
