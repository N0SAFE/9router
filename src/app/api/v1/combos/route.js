import { getCombos, getProviderConnections } from "@/lib/localDb";
import { withNoAuthProviders } from "@/lib/providers/noAuthProviders";
import { bridgeJson, bridgeOptions, buildCombosPayload } from "@/lib/bridge/discovery";

export async function OPTIONS() {
  return bridgeOptions();
}

/**
 * GET /v1/combos
 * Configured combos with their models; each model carries `available` when its
 * provider currently has an active connection.
 */
export async function GET() {
  try {
    const [combos, rawConnections] = await Promise.all([
      getCombos().catch(() => []),
      getProviderConnections().catch(() => []),
    ]);
    const connections = withNoAuthProviders(rawConnections);

    return bridgeJson({
      object: "list",
      data: buildCombosPayload({ combos, connections }),
    });
  } catch (error) {
    console.error("[bridge] combos failed:", error);
    return bridgeJson({ error: { message: error.message, type: "server_error" } }, 500);
  }
}
