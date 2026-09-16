import { NextResponse } from "next/server";
import { resolveOllamaBase } from "@/lib/local/servers";

export const dynamic = "force-dynamic";

/**
 * POST /api/local/ollama/unload { host?, model }
 * Unload a running model immediately (keep_alive: 0) to free VRAM.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) {
      return NextResponse.json({ error: "model is required" }, { status: 400 });
    }
    const host = resolveOllamaBase(request, body.host);

    const upstream = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: text || `Ollama refused to unload the model (${upstream.status})` },
        { status: upstream.status || 502 }
      );
    }
    return NextResponse.json({ unloaded: model });
  } catch (error) {
    console.error("[local] ollama unload failed:", error);
    return NextResponse.json({ error: "Failed to unload the model" }, { status: 500 });
  }
}
