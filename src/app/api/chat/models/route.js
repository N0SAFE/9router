import { NextResponse } from "next/server";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/models
 * The live LLM catalog exactly as the API serves it: provider models (active
 * providers + free/no-auth ones), combos, names, capabilities and free flags.
 */
export async function GET() {
  try {
    const models = await buildModelsList(["llm"]);
    const data = models.map((model) => {
      if (model.owned_by === "combo") {
        return { ...model, kind: "combo", provider_name: "Combo" };
      }
      const provider = getProviderByAlias(model.owned_by) || AI_PROVIDERS[model.owned_by];
      return {
        ...model,
        provider_name: provider?.name || model.owned_by,
        color: provider?.color || null,
        text_icon: provider?.textIcon || null,
      };
    });
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[chat] models failed:", error);
    return NextResponse.json({ error: "Failed to load the model catalog" }, { status: 500 });
  }
}
