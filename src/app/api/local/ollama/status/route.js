import { NextResponse } from "next/server";
import { fetchJsonWithTimeout, resolveOllamaBase } from "@/lib/local/servers";

export const dynamic = "force-dynamic";

/**
 * GET /api/local/ollama/status?host=…
 * Local Ollama server state: version, installed models (/api/tags) and running
 * models with VRAM usage (/api/ps).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const host = resolveOllamaBase(request, searchParams.get("host"));

    const [version, tags, running] = await Promise.all([
      fetchJsonWithTimeout(`${host}/api/version`),
      fetchJsonWithTimeout(`${host}/api/tags`),
      fetchJsonWithTimeout(`${host}/api/ps`),
    ]);

    const models = Array.isArray(tags?.models) ? tags.models : null;
    return NextResponse.json({
      host,
      online: models !== null,
      version: version?.version || null,
      models: models ?? [],
      running: Array.isArray(running?.models) ? running.models : [],
    });
  } catch (error) {
    console.error("[local] ollama status failed:", error);
    return NextResponse.json({ error: "Failed to read Ollama status" }, { status: 500 });
  }
}
