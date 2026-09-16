import { resolveOllamaBase } from "@/lib/local/servers";

export const dynamic = "force-dynamic";

/**
 * POST /api/local/ollama/pull { host?, model }
 * Proxies Ollama's NDJSON progress stream from /api/pull straight through, so
 * the dashboard can render a live progress bar while a model downloads.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) {
      return Response.json({ error: "model is required" }, { status: 400 });
    }
    const host = resolveOllamaBase(request, body.host);

    const upstream = await fetch(`${host}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return Response.json(
        { error: text || `Ollama refused the pull (${upstream.status})` },
        { status: upstream.status || 502 }
      );
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[local] ollama pull failed:", error);
    return Response.json({ error: "Failed to start the model download" }, { status: 500 });
  }
}
