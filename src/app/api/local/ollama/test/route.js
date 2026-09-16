import { NextResponse } from "next/server";
import { resolveOllamaBase } from "@/lib/local/servers";

export const dynamic = "force-dynamic";

/**
 * POST /api/local/ollama/test { host?, model }
 * Loads the model with a minimal generation and reports latency, so users can
 * verify a freshly installed model before wiring it into a combo.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) {
      return NextResponse.json({ error: "model is required" }, { status: 400 });
    }
    const host = resolveOllamaBase(request, body.host);
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let upstream;
    try {
      upstream = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "Reply with the single word: ok",
          stream: false,
          options: { num_predict: 4 },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const elapsedMs = Date.now() - startedAt;
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { ok: false, ms: elapsedMs, error: text || `Ollama returned ${upstream.status}` },
        { status: 200 }
      );
    }
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json({
      ok: true,
      ms: elapsedMs,
      response: String(data.response || "").trim().slice(0, 120),
    });
  } catch (error) {
    console.error("[local] ollama test failed:", error);
    return NextResponse.json({ error: "Failed to run the model" }, { status: 500 });
  }
}
