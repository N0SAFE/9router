import { NextResponse } from "next/server";
import { fetchJsonWithTimeout, resolveServerBase } from "@/lib/local/servers";
import { readServerState } from "@/lib/local/processManager";

export const dynamic = "force-dynamic";

const DEFAULTS = {
  llamacpp: "http://localhost:8080",
  vllm: "http://localhost:8000",
  "ollama-local": "http://localhost:11434",
};

/**
 * GET /api/local/server/status?provider=llamacpp|vllm|ollama-local&baseUrl=…
 * Health, currently served model(s), managed-process state and llama.cpp
 * context size for local OpenAI-compatible servers.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = (searchParams.get("provider") || "").trim();
    const baseUrl = resolveServerBase(request, searchParams.get("baseUrl"), DEFAULTS[provider] || "");
    const connectionId = searchParams.get("connectionId") || "";
    if (!baseUrl) {
      return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
    }

    let processState = await readServerState(provider);
    if (provider === "ollama-local") {
      const version = await fetchJsonWithTimeout(`${baseUrl}/api/version`);
      const online = version !== null;
      if (online && !processState.running) {
        processState = { ...processState, running: true, source: "external" };
      }
      if (connectionId) {
        void import("@/lib/local/autoProvision")
          .then(({ syncConnectionHealth }) => syncConnectionHealth(connectionId, online))
          .catch(() => {});
      }
      return NextResponse.json({
        provider,
        baseUrl,
        online,
        version: version?.version || null,
        models: [],
        process: processState,
      });
    }

    const [modelsPayload, props] = await Promise.all([
      fetchJsonWithTimeout(`${baseUrl}/v1/models`),
      provider === "llamacpp" ? fetchJsonWithTimeout(`${baseUrl}/props`) : null,
    ]);
    const models = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];
    const online = modelsPayload !== null;
    if (online && !processState.running) {
      processState = { ...processState, running: true, source: "external" };
    }
    if (connectionId) {
      void import("@/lib/local/autoProvision")
        .then(({ syncConnectionHealth }) => syncConnectionHealth(connectionId, online))
        .catch(() => {});
    }

    return NextResponse.json({
      provider,
      baseUrl,
      online,
      models: models.map((model) => ({ id: model.id, name: model.id })),
      contextLength: props?.default_generation_settings?.n_ctx ?? null,
      modelPath: props?.model_path ?? null,
      process: processState,
    });
  } catch (error) {
    console.error("[local] server status failed:", error);
    return NextResponse.json({ error: "Failed to read the local server status" }, { status: 500 });
  }
}

/**
 * POST /api/local/server/status { provider, model?, port?, extraArgs? }
 * Spawns the local inference server detached; logs go to ~/.9router/local.
 */
export async function POST(request) {
  try {
    const { startServer } = await import("@/lib/local/processManager");
    const body = await request.json().catch(() => ({}));
    const provider = String(body.provider || "").trim();
    const state = startServer({
      provider,
      model: body.model,
      port: Number.isInteger(body.port) ? body.port : null,
      extraArgs: body.extraArgs,
    });
    return NextResponse.json({ process: await state });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to start the server" }, { status: 400 });
  }
}

/**
 * DELETE /api/local/server/status { provider }
 * Stops the managed local server process.
 */
export async function DELETE(request) {
  try {
    const { stopServer } = await import("@/lib/local/processManager");
    const body = await request.json().catch(() => ({}));
    const provider = String(body.provider || "").trim();
    const state = stopServer(provider);
    return NextResponse.json({ process: await state });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to stop the server" }, { status: 400 });
  }
}
