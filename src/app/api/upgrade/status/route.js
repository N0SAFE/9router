import { NextResponse } from "next/server";
import { getCombos, getSettings } from "@/lib/localDb";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getUpgradeState } from "@/lib/upgrade/agent";

export const dynamic = "force-dynamic";

// Model/combo ids the router can serve, for the upgrade-model datalist.
function buildModelSuggestions() {
  const out = [];
  // AI_PROVIDERS is a map keyed by provider id.
  for (const [providerId, provider] of Object.entries(AI_PROVIDERS || {})) {
    const id = provider?.id || providerId;
    if (!id) continue;
    let models = [];
    try {
      models = getModelsByProviderId(id) || [];
    } catch {
      models = [];
    }
    for (const model of models) {
      if (model?.id) out.push(`${id}/${model.id}`);
    }
  }
  return out;
}

async function buildSuggestions() {
  let combos = [];
  try {
    combos = (await getCombos()) || [];
  } catch {
    combos = [];
  }
  const comboIds = combos.map((combo) => combo?.name).filter(Boolean);
  return [...comboIds, ...buildModelSuggestions()];
}

// Status of the local upgrade agent (opencode) for the dashboard button.
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({
      success: true,
      model: settings.upgradeModel || "",
      suggestions: await buildSuggestions(),
      ...getUpgradeState(),
    });
  } catch (error) {
    console.error("Error reading upgrade state:", error);
    return NextResponse.json({ error: "Failed to read upgrade state" }, { status: 500 });
  }
}
