import { isLocalRequest } from "@/dashboardGuard";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard";
import { OLLAMA_LOCAL_DEFAULT_HOST } from "open-sse/config/providers.js";

/**
 * Validate a target URL for the local-management APIs. Self-hosted targets
 * (loopback/private) are allowed for local dashboard requests; remote callers
 * must target a public URL, matching the provider-nodes validation guard.
 */
export function guardTargetUrl(request, rawUrl) {
  const url = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }
  if (!isLocalRequest(request)) {
    try {
      assertPublicUrl(url);
    } catch {
      return null;
    }
  }
  return url;
}

export function resolveOllamaBase(request, rawHost) {
  return guardTargetUrl(request, rawHost) || OLLAMA_LOCAL_DEFAULT_HOST;
}

export function resolveServerBase(request, rawBase, fallback) {
  return guardTargetUrl(request, rawBase) || fallback;
}

export async function fetchJsonWithTimeout(url, { timeoutMs = 6000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
