import { buildModelsList } from "../models/route";
import { getProviderConnections, getSettings } from "@/lib/localDb";
import { withNoAuthProviders } from "@/lib/providers/noAuthProviders";
import { bridgeJson, bridgeOptions, buildPoolsPayload } from "@/lib/bridge/discovery";

export async function OPTIONS() {
  return bridgeOptions();
}

/**
 * GET /v1/pools
 * Per-provider account pool health: counts only (connections/ready/cooling/
 * unavailable/locks), selection strategy and last activity. No account ids,
 * names or credentials are exposed.
 * Query: models=1 to also include model_count (slower: resolves live catalogs).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeModels = searchParams.get("models") === "1";
    const [models, rawConnections, settings] = await Promise.all([
      includeModels ? buildModelsList(["llm"]) : [],
      getProviderConnections().catch(() => []),
      getSettings().catch(() => ({})),
    ]);
    const connections = withNoAuthProviders(rawConnections);

    return bridgeJson({
      object: "list",
      data: buildPoolsPayload({ models, connections, settings }),
    });
  } catch (error) {
    console.error("[bridge] pools failed:", error);
    return bridgeJson({ error: { message: error.message, type: "server_error" } }, 500);
  }
}
