import { NextResponse } from "next/server";
import { resolveServerBase } from "@/lib/local/servers";
import { parseVllmMetrics } from "@/lib/local/processManager";

export const dynamic = "force-dynamic";

const DEFAULTS = {
  vllm: "http://localhost:8000",
  llamacpp: "http://localhost:8080",
};

/**
 * GET /api/local/server/metrics?provider=vllm&baseUrl=…
 * Parses the vLLM Prometheus /metrics endpoint into the gauges the UI shows
 * (running/waiting requests, GPU cache usage, token totals).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = (searchParams.get("provider") || "vllm").trim();
    const baseUrl = resolveServerBase(request, searchParams.get("baseUrl"), DEFAULTS[provider] || "");
    if (!baseUrl) {
      return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let response;
    try {
      response = await fetch(`${baseUrl}/metrics`, { signal: controller.signal, cache: "no-store" });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      return NextResponse.json({ online: false, metrics: null });
    }
    const text = await response.text();
    return NextResponse.json({ online: true, metrics: parseVllmMetrics(text) });
  } catch {
    return NextResponse.json({ online: false, metrics: null });
  }
}
