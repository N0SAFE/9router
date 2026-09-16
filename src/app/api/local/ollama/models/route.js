import { NextResponse } from "next/server";
import { resolveOllamaBase } from "@/lib/local/servers";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/local/ollama/models { host?, model }
 * Remove an installed model from the local Ollama server.
 */
export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) {
      return NextResponse.json({ error: "model is required" }, { status: 400 });
    }
    const host = resolveOllamaBase(request, body.host);

    const upstream = await fetch(`${host}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: text || `Ollama refused to delete the model (${upstream.status})` },
        { status: upstream.status || 502 }
      );
    }
    return NextResponse.json({ deleted: model });
  } catch (error) {
    console.error("[local] ollama delete failed:", error);
    return NextResponse.json({ error: "Failed to delete the model" }, { status: 500 });
  }
}
