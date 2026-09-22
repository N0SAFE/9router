import { NextResponse } from "next/server";
import { getApiKeys, getSettings } from "@/lib/localDb";
import { DEFAULT_REPO_PATH, startUpgrade } from "@/lib/upgrade/agent";

export const dynamic = "force-dynamic";

const ERROR_STATUS = {
  ALREADY_RUNNING: 409,
  NO_MODEL: 400,
  NOT_INSTALLED: 501,
  NO_REPO: 400,
  SPAWN_FAILED: 500,
  EARLY_EXIT: 500,
};

async function resolveInternalApiKey() {
  try {
    const keys = await getApiKeys();
    const active = (keys || []).find((k) => k?.key && k.isActive !== false);
    return active?.key || "local";
  } catch {
    return "local";
  }
}

// Start the upgrade agent: `opencode run --model 9router/<model>` in the mounted
// fork checkout, following skills/9router-upgrade/SKILL.md.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();
    const model = String(body?.model ?? settings.upgradeModel ?? "").trim();
    const baseUrl =
      process.env.BASE_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      `http://127.0.0.1:${process.env.PORT || 20128}`;
    const apiKey = await resolveInternalApiKey();

    const result = await startUpgrade({
      model,
      baseUrl,
      apiKey,
      repoPath: process.env.UPGRADE_REPO_PATH || DEFAULT_REPO_PATH,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Error starting upgrade agent:", error);
    return NextResponse.json(
      { error: error.message, code: error.code || "UPGRADE_FAILED" },
      { status: ERROR_STATUS[error.code] || 500 }
    );
  }
}
