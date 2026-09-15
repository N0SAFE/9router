import { buildModelsList } from "../models/route";
import { getCombos, getProviderConnections, getSettings } from "@/lib/localDb";
import {
  bridgeJson,
  bridgeOptions,
  buildManifestPayload,
  parseKinds,
} from "@/lib/bridge/discovery";

export async function OPTIONS() {
  return bridgeOptions();
}

/**
 * GET /v1/bridge
 * One-call manifest for bridge clients: modes (providers/combos/pools) plus the
 * three datasets inline, so a picker can render without extra round-trips.
 * Query: kind (default llm)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const kinds = parseKinds(searchParams.get("kind"));
    const [models, connections, combos, settings] = await Promise.all([
      buildModelsList(kinds),
      getProviderConnections().catch(() => []),
      getCombos().catch(() => []),
      getSettings().catch(() => ({})),
    ]);

    return bridgeJson(
      buildManifestPayload({ models, connections, combos, settings })
    );
  } catch (error) {
    console.error("[bridge] manifest failed:", error);
    return bridgeJson({ error: { message: error.message, type: "server_error" } }, 500);
  }
}
