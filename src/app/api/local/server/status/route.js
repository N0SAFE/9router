import { NextResponse } from "next/server";
import { fetchJsonWithTimeout, resolveServerBase } from "@/lib/local/servers";

export const dynamic = "force-dynamic";

const DEFAULTS = {
  llamacpp: "http://localhost:8080",
  vllm: "http://localhost:8000",
};

/**
 * GET /api/local/server/status?provider=llamacpp|vllm&baseUrl=…
 * Health + currently served model(s) for local OpenAI-compatible servers.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = (searchParams.get("provider") || "").trim();
    const baseUrl = resolveServerBase(request, searchParams.get("baseUrl"), DEFAULTS[provider] || "");
    if (!baseUrl) {
      return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
    }

    const [modelsPayload, props] = await Promise.all([
      fetchJsonWithTimeout(`${baseUrl}/v1/models`),
      provider === "llamacpp" ? fetchJsonWithTimeout(`${baseUrl}/props`) : null,
    ]);
    const models = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];

    return NextResponse.json({
      provider,
      baseUrl,
      online: modelsPayload !== null,
      models: models.map((model) => ({ id: model.id, name: model.id })),
      contextLength: props?.default_generation_settings?.n_ctx ?? null,
    });
  } catch (error) {
    console.error("[local] server status failed:", error);
    return NextResponse.json({ error: "Failed to read the local server status" }, { status: 500 });
  }
}
