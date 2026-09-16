import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createProviderConnection,
  getProviderConnectionById,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/localDb";

const execFileAsync = promisify(execFile);

// Local tools get a default connection the moment they are installed on the
// machine, so the dashboard always has something to talk to and the user can
// simply deactivate/remove it if they do not want it.

const CACHE_TTL_MS = 60_000;
let lastCheck = 0;
let lastResult = { created: [] };

const LOCAL_TOOLS = [
  {
    provider: "ollama-local",
    bin: "ollama",
    name: "Ollama Local",
    baseUrl: "http://localhost:11434",
    onlinePath: "/api/version",
  },
  {
    provider: "llamacpp",
    bin: "llama-server",
    name: "llama.cpp",
    baseUrl: "http://localhost:8080",
    onlinePath: "/v1/models",
  },
  {
    provider: "vllm",
    bin: "vllm",
    name: "vLLM",
    baseUrl: "http://localhost:8000",
    onlinePath: "/v1/models",
  },
];

async function hasBinary(bin) {
  try {
    await execFileAsync("which", [bin], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function isReachable(baseUrl, path) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Create a default connection for every local tool that is installed (binary
 * in PATH) or already listening on its default port, when the provider has no
 * connection yet. Cached for a minute so dashboard requests stay cheap.
 */
export async function autoProvisionLocalConnections({ force = false } = {}) {
  if (!force && Date.now() - lastCheck < CACHE_TTL_MS) {
    return lastResult;
  }
  const created = [];
  try {
    const connections = await getProviderConnections().catch(() => []);
    for (const tool of LOCAL_TOOLS) {
      if (connections.some((connection) => connection.provider === tool.provider)) {
        continue;
      }
      const online = await isReachable(tool.baseUrl, tool.onlinePath);
      const installed = online || (await hasBinary(tool.bin));
      if (!installed) {
        continue;
      }
      try {
        await createProviderConnection({
          provider: tool.provider,
          authType: "apikey",
          name: `${tool.name} (auto)`,
          apiKey: "",
          isActive: true,
          priority: 1,
          providerSpecificData: { baseUrl: tool.baseUrl, auto: true },
          testStatus: online ? "active" : "unknown",
        });
        created.push(tool.provider);
      } catch {
        // A provisioning failure must never break the caller.
      }
    }
  } catch {
    // ignore — provisioning is best effort
  }
  lastCheck = Date.now();
  lastResult = { created };
  return lastResult;
}

/** Keep a connection's health badge in sync with the live server probe. */
export async function syncConnectionHealth(connectionId, online) {
  if (!connectionId) {
    return;
  }
  try {
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return;
    }
    const desired = online ? "active" : "unavailable";
    if (connection.testStatus === desired) {
      return;
    }
    await updateProviderConnection(connectionId, {
      testStatus: desired,
      lastTested: new Date().toISOString(),
    });
  } catch {
    // best effort
  }
}
