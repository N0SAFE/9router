import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTOML, stringifyTOML } from "confbox";

// Wire the harness CLIs that run next to a remote session (Claude Code, Codex,
// opencode) to this 9Router instance. This is what makes the VS Code agent
// handoff path ("Continue In" / Agents window → remote agent host) consume
// 9Router providers, combos and pools instead of the harness vendors' clouds.
//
// The same files are written by the CLI Tools page; this module mirrors that
// behavior for the Remote page so the agent host can be made 9Router-ready in
// one click, right where the host is started.

const BACKUP_SUFFIX = ".bak-9router-remote";

export const HARNESSES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex CLI" },
  { id: "opencode", label: "opencode" },
];

const claudeFile = () => path.join(os.homedir(), ".claude", "settings.json");
const codexFile = () => path.join(os.homedir(), ".codex", "config.toml");
const opencodeFile = () => path.join(os.homedir(), ".config", "opencode", "opencode.json");

/** Loopback root of this 9Router instance, without a trailing slash. */
export function routerRoot() {
  return `http://127.0.0.1:${process.env.PORT || 20128}`;
}

/** OpenAI-compatible base URL (`/v1`) used by the harness configs. */
export function routerBaseV1() {
  return `${routerRoot()}/v1`;
}

function normalizeV1(url) {
  const trimmed = String(url || routerBaseV1()).replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Back up the file once (never overwrite a previous backup). */
function backupFile(file) {
  try {
    if (fs.existsSync(file)) {
      const backup = `${file}${BACKUP_SUFFIX}`;
      if (!fs.existsSync(backup)) {
        fs.copyFileSync(file, backup);
      }
    }
  } catch {
    // best effort
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  backupFile(file);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function readToml(file) {
  try {
    return parseTOML(fs.readFileSync(file, "utf8")) || {};
  } catch {
    return {};
  }
}

// Set a nested TOML key from a flat dotted path, creating intermediates.
function setNested(obj, dottedKey, value) {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deleteNested(obj, dottedKey) {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur == null) {
      return;
    }
  }
  delete cur[keys[keys.length - 1]];
}

function writeClaude({ baseUrl, apiKey, model }) {
  const file = claudeFile();
  const settings = readJson(file);
  const env = { ...(settings.env || {}) };
  env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  }
  // One 9Router model for every Claude slot; the CLI Tools page can refine
  // per-alias mappings afterwards.
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
  settings.env = env;
  if (!settings.$schema) {
    settings.$schema = "https://json.schemastore.org/claude-code-settings.json";
  }
  return { file: writeJson(file, settings) };
}

function writeCodex({ baseUrl, apiKey, model, subagentModel }) {
  const file = codexFile();
  const parsed = readToml(file);
  parsed.model = model;
  parsed.model_provider = "9router";
  // Custom providers read the key from a static header (not auth.json).
  const provider = {
    name: "9Router",
    base_url: baseUrl,
    wire_api: "responses",
  };
  if (apiKey) {
    provider.http_headers = { Authorization: `Bearer ${apiKey}` };
  }
  setNested(parsed, "model_providers.9router", provider);
  deleteNested(parsed, "agents.subagent");
  setNested(parsed, "agents.default_subagent_model", subagentModel || model);
  ensureDir(path.dirname(file));
  backupFile(file);
  fs.writeFileSync(file, stringifyTOML(parsed));
  return { file };
}

function writeOpencode({ baseUrl, apiKey, model, subagentModel }) {
  const file = opencodeFile();
  const config = readJson(file);
  if (!config.provider) {
    config.provider = {};
  }
  const existing = config.provider["9router"] || {
    npm: "@ai-sdk/openai-compatible",
    options: {},
    models: {},
  };
  existing.options = {
    ...(existing.options || {}),
    baseURL: baseUrl,
    ...(apiKey ? { apiKey } : {}),
  };
  existing.models = {
    ...(existing.models || {}),
    [model]: { name: model, modalities: { input: ["text", "image"], output: ["text"] } },
  };
  config.provider["9router"] = existing;
  config.model = `9router/${model}`;
  if (!config.agent) {
    config.agent = {};
  }
  config.agent.explorer = {
    ...(config.agent.explorer || {}),
    description: "Fast explorer subagent for codebase exploration",
    mode: "subagent",
    model: `9router/${subagentModel || model}`,
  };
  return { file: writeJson(file, config) };
}

const WRITERS = {
  claude: writeClaude,
  codex: writeCodex,
  opencode: writeOpencode,
};

/**
 * Point the requested harness configs at 9Router.
 *
 * @param {{ model: string, subagentModel?: string, harnesses?: string[],
 *           baseUrl?: string, apiKey?: string }} options
 */
export function configureHarnesses({ model, subagentModel, harnesses, baseUrl, apiKey } = {}) {
  const target = String(model || "").trim();
  if (!target) {
    throw new Error("A model (combo alias or provider/model) is required");
  }
  const wanted = new Set(
    Array.isArray(harnesses) && harnesses.length > 0 ? harnesses : HARNESSES.map((item) => item.id)
  );
  const v1 = normalizeV1(baseUrl);
  const key = String(apiKey || "").trim();

  const results = [];
  for (const def of HARNESSES) {
    if (!wanted.has(def.id)) {
      continue;
    }
    try {
      const out = WRITERS[def.id]({ baseUrl: v1, apiKey: key, model: target, subagentModel });
      results.push({ id: def.id, label: def.label, file: out.file, ok: true });
    } catch (error) {
      results.push({ id: def.id, label: def.label, ok: false, error: error?.message || String(error) });
    }
  }
  return { baseUrl: v1, model: target, results };
}

/** Which harnesses are currently pointed at a 9Router endpoint. */
export function getHarnessConfigStatus() {
  const status = [];

  {
    const file = claudeFile();
    const env = readJson(file).env || {};
    status.push({
      id: "claude",
      label: "Claude Code",
      file,
      configured: Boolean(env.ANTHROPIC_BASE_URL),
      model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
      baseUrl: env.ANTHROPIC_BASE_URL || null,
    });
  }

  {
    const file = codexFile();
    const parsed = readToml(file);
    const provider = parsed?.model_providers?.["9router"];
    status.push({
      id: "codex",
      label: "Codex CLI",
      file,
      configured: Boolean(provider?.base_url),
      model: parsed?.model || null,
      baseUrl: provider?.base_url || null,
    });
  }

  {
    const file = opencodeFile();
    const config = readJson(file);
    const provider = config?.provider?.["9router"];
    const active = typeof config?.model === "string" && config.model.startsWith("9router/")
      ? config.model.slice("9router/".length)
      : null;
    status.push({
      id: "opencode",
      label: "opencode",
      file,
      configured: Boolean(provider?.options?.baseURL),
      model: active,
      baseUrl: provider?.options?.baseURL || null,
    });
  }

  return status;
}
