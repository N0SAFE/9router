import { NextResponse } from "next/server";
import { getCombos } from "@/lib/localDb";
import { firstApiKey } from "@/lib/remote/apiAuth";
import {
  configureHarnesses,
  getHarnessConfigStatus,
  routerBaseV1,
} from "@/lib/remote/harnessConfig";

export const dynamic = "force-dynamic";

/**
 * GET /api/remote/harness-config
 * Harness wiring status (Claude Code / Codex / opencode) plus the combos that
 * make good defaults for remote sessions.
 */
export async function GET() {
  let apiKey = "";
  let suggested = [];
  try {
    apiKey = await firstApiKey();
  } catch {
    apiKey = "";
  }
  try {
    const combos = await getCombos();
    if (Array.isArray(combos)) {
      suggested = combos
        .map((combo) => (typeof combo === "string" ? combo : combo?.name))
        .filter((name) => typeof name === "string" && name.length > 0)
        .slice(0, 30);
    }
  } catch {
    suggested = [];
  }
  return NextResponse.json({
    baseUrl: routerBaseV1(),
    apiKeySet: Boolean(apiKey),
    harnesses: getHarnessConfigStatus(),
    suggestedModels: suggested,
  });
}

/**
 * POST /api/remote/harness-config { model, subagentModel?, harnesses?, baseUrl?, apiKey? }
 * Writes the harness configs so harnesses running on this machine (agent host,
 * handoff sessions) use this 9Router instance for models.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) {
      return NextResponse.json({ error: "A model (combo alias or provider/model) is required" }, { status: 400 });
    }
    let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      try {
        apiKey = await firstApiKey();
      } catch {
        apiKey = "";
      }
    }
    const result = configureHarnesses({
      model,
      subagentModel: typeof body.subagentModel === "string" ? body.subagentModel.trim() : undefined,
      harnesses: Array.isArray(body.harnesses) ? body.harnesses : undefined,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : undefined,
      apiKey,
    });
    return NextResponse.json({ ...result, harnesses: getHarnessConfigStatus() });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to configure harnesses" },
      { status: error?.message?.includes("required") ? 400 : 500 }
    );
  }
}
