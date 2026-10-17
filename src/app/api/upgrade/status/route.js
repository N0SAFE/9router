import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getUpgradeState } from "@/lib/upgrade/agent";

export const dynamic = "force-dynamic";

// Status of the local upgrade agent (opencode) for the dashboard button.
// The model list itself comes from the shared picker (/api/providers,
// /api/models/alias, /api/combos) — not from here — so the ids stay aligned
// with what the router actually serves (`alias/model`, never the raw provider id).
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({
      success: true,
      model: settings.upgradeModel || "",
      ...getUpgradeState(),
    });
  } catch (error) {
    console.error("Error reading upgrade state:", error);
    return NextResponse.json({ error: "Failed to read upgrade state" }, { status: 500 });
  }
}
