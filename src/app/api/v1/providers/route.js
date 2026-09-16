import { buildModelsList } from "../models/route";
import { getProviderConnections, getSettings } from "@/lib/localDb";
import { withNoAuthProviders } from "@/lib/providers/noAuthProviders";
import {
  bridgeJson,
  bridgeOptions,
  buildProvidersPayload,
  parseKinds,
} from "@/lib/bridge/discovery";

export async function OPTIONS() {
  return bridgeOptions();
}

/**
 * GET /v1/providers
 * Active providers only, each with its routable models grouped underneath.
 * Query: kind (default llm), e.g. /v1/providers?kind=image
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const kinds = parseKinds(searchParams.get("kind"));
    const [models, rawConnections, settings] = await Promise.all([
      buildModelsList(kinds),
      getProviderConnections().catch(() => []),
      getSettings().catch(() => ({})),
    ]);
    const connections = withNoAuthProviders(rawConnections);

    return bridgeJson({
      object: "list",
      kinds,
      data: buildProvidersPayload({ models, connections, settings }),
    });
  } catch (error) {
    console.error("[bridge] providers failed:", error);
    return bridgeJson({ error: { message: error.message, type: "server_error" } }, 500);
  }
}
