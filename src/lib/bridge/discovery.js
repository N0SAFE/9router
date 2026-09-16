import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { AI_PROVIDERS, getProviderAlias, getProviderByAlias } from "@/shared/constants/providers";

// Bridge discovery: read-only, secret-free views of the routing catalog.
// A VS Code (or any) client can build provider/combos/pools pickers without a
// dashboard session. Account identifiers never leave this module — pools are
// reported as counts only.

export const BRIDGE_KINDS = [
  "llm",
  "image",
  "tts",
  "stt",
  "embedding",
  "imageToText",
  "video",
  "webSearch",
  "webFetch",
];

export const BRIDGE_MODES = [
  {
    id: "providers",
    label: "Providers",
    endpoint: "/v1/providers",
    description: "Active providers with their routable models, grouped by provider",
  },
  {
    id: "combos",
    label: "Combos",
    endpoint: "/v1/combos",
    description: "Configured combos with their models and per-model availability",
  },
  {
    id: "pools",
    label: "Pools",
    endpoint: "/v1/pools",
    description: "Per-provider account pool health (counts only, no credentials)",
  },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

export function bridgeJson(data, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export function bridgeOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export function parseKinds(value) {
  if (!value) return ["llm"];
  const kinds = String(value)
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind) => BRIDGE_KINDS.includes(kind));
  return kinds.length > 0 ? kinds : ["llm"];
}

export function activeConnections(connections = []) {
  return connections.filter((conn) => conn && conn.isActive !== false);
}

// Same precedence the /v1/models catalog uses, so a bridge can map an alias
// back to the provider it belongs to (custom nodes may override via prefix).
export function outputAliasForConnection(connection) {
  const providerId = connection?.provider || "";
  const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  const alias =
    connection?.providerSpecificData?.prefix ||
    getProviderAlias(providerId) ||
    staticAlias ||
    providerId;
  return String(alias).trim();
}

export function summarizePool(connections, providerId, settings, now = Date.now()) {
  const pool = activeConnections(connections).filter(
    (conn) => conn.provider === providerId && !conn.noAuth
  );
  let cooling = 0;
  let unavailable = 0;
  let locks = 0;
  let lastActivity = null;

  for (const conn of pool) {
    const until = conn.rateLimitedUntil ? Date.parse(conn.rateLimitedUntil) : NaN;
    if (Number.isFinite(until) && until > now) cooling += 1;
    if (conn.testStatus === "unavailable") unavailable += 1;
    locks += Object.keys(conn).filter((key) => key.startsWith("modelLock_") && conn[key]).length;
    const stamp = conn.lastTested || conn.updatedAt || null;
    if (stamp && (!lastActivity || stamp > lastActivity)) lastActivity = stamp;
  }

  const override = (settings?.providerStrategies || {})[providerId] || {};

  return {
    connections: pool.length,
    ready: Math.max(0, pool.length - cooling - unavailable),
    cooling,
    unavailable,
    locks,
    last_activity: lastActivity,
    strategy: override.fallbackStrategy || settings?.fallbackStrategy || "fill-first",
  };
}

function providerInfoFor(providerId, alias) {
  const info = getProviderByAlias(alias) || AI_PROVIDERS[providerId] || {};
  return {
    id: providerId,
    alias: info.alias || alias,
    name: info.name || alias,
    color: info.color || null,
    text_icon: info.textIcon || null,
    no_auth: info.noAuth === true,
  };
}

export function listProviderGroups(connections, settings, now = Date.now()) {
  const pool = activeConnections(connections);
  const byProvider = new Map();
  for (const conn of pool) {
    if (!byProvider.has(conn.provider)) byProvider.set(conn.provider, []);
    byProvider.get(conn.provider).push(conn);
  }

  return [...byProvider.entries()].map(([providerId, poolConns]) => {
    const alias = outputAliasForConnection(poolConns[0]);
    return {
      ...providerInfoFor(providerId, alias),
      pool: summarizePool(pool, providerId, settings, now),
    };
  });
}

function staticNamesForProvider(providerId) {
  const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return new Map((PROVIDER_MODELS[staticAlias] || []).map((model) => [model.id, model.name]));
}

export function groupModelsByProvider(providers, models) {
  const groups = new Map(
    providers.map((provider) => [
      provider.alias,
      { ...provider, models: [], names: staticNamesForProvider(provider.id) },
    ])
  );

  for (const model of models) {
    const group = groups.get(model.owned_by);
    if (!group) continue;
    const bareId = String(model.id).includes("/")
      ? String(model.id).slice(String(model.id).indexOf("/") + 1)
      : model.id;
    const name = group.names.get(bareId);
    group.models.push(name ? { ...model, name } : model);
  }

  return [...groups.values()]
    .map(({ names, ...group }) => group)
    .filter((group) => group.models.length > 0);
}

export function buildProvidersPayload({
  models = [],
  connections = [],
  settings = {},
  now = Date.now(),
} = {}) {
  const groups = listProviderGroups(connections, settings, now);
  return groupModelsByProvider(groups, models).map((group) => ({
    object: "provider",
    ...group,
  }));
}

export function buildPoolsPayload({
  models = [],
  connections = [],
  settings = {},
  now = Date.now(),
} = {}) {
  const modelCounts = new Map();
  for (const model of models) {
    modelCounts.set(model.owned_by, (modelCounts.get(model.owned_by) || 0) + 1);
  }

  return listProviderGroups(connections, settings, now)
    .filter((group) => group.no_auth !== true)
    .map((group) => ({
    object: "pool",
    provider: group.id,
    alias: group.alias,
    name: group.name,
    color: group.color,
    text_icon: group.text_icon,
    no_auth: group.no_auth,
    ...group.pool,
    ...(models.length > 0 ? { model_count: modelCounts.get(group.alias) || 0 } : {}),
  }));
}

export function buildCombosPayload({ combos = [], connections = [] } = {}) {
  const activeAliases = new Set(activeConnections(connections).map(outputAliasForConnection));

  return combos.map((combo) => {
    const models = (combo.models || []).map((id) => ({
      id,
      available: activeAliases.has(String(id).split("/")[0]),
    }));
    return {
      object: "combo",
      id: combo.id,
      name: combo.name,
      kind: combo.kind || null,
      models,
      model_count: models.length,
      available_model_count: models.filter((model) => model.available).length,
    };
  });
}

export function buildManifestPayload({
  models = [],
  connections = [],
  combos = [],
  settings = {},
  now = Date.now(),
} = {}) {
  const providers = buildProvidersPayload({ models, connections, settings, now });
  const pools = buildPoolsPayload({ models, connections, settings, now });
  const comboList = buildCombosPayload({ combos, connections });

  return {
    object: "9router.bridge",
    version: 1,
    modes: BRIDGE_MODES,
    counts: {
      providers: providers.length,
      pools: pools.length,
      combos: comboList.length,
      models: models.length,
    },
    providers,
    pools,
    combos: comboList,
  };
}
