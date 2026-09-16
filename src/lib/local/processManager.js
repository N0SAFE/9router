import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Local inference server process manager: start/stop llama.cpp and vLLM with a
// chosen model, capture logs and report state. Commands and model ids are
// strictly validated because spawn() runs through a shell.

const STATE_DIR = path.join(os.homedir(), ".9router", "local");
const PROVIDERS = ["llamacpp", "vllm", "ollama"];

const SAFE_TOKEN = /^[A-Za-z0-9._:@/+,=-]+$/;

function stateFile(provider) {
  return path.join(STATE_DIR, `${provider}.json`);
}

function logFile(provider) {
  return path.join(STATE_DIR, `${provider}.log`);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readServerState(provider) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(provider), "utf8"));
    return { ...raw, running: isAlive(raw.pid) };
  } catch {
    return { provider, running: false, pid: null, command: null, model: null, startedAt: null };
  }
}

export function validateToken(value) {
  const token = String(value || "").trim();
  if (!token || !SAFE_TOKEN.test(token)) {
    return null;
  }
  return token;
}

export function buildCommand({ provider, model, port, extraArgs = [] }) {
  const safePort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
  const safeArgs = (Array.isArray(extraArgs) ? extraArgs : [])
    .map(validateToken)
    .filter(Boolean);

  if (provider === "ollama") {
    return { command: "ollama", args: ["serve", ...(safePort ? ["--port", String(safePort)] : [])] };
  }

  const safeModel = validateToken(model);
  if (!safeModel) {
    throw new Error("A valid model id or path is required");
  }

  if (provider === "llamacpp") {
    const isRepo = safeModel.includes("/");
    const args = isRepo ? ["-hf", safeModel] : ["-m", safeModel];
    if (safePort) {
      args.push("--port", String(safePort));
    }
    return { command: "llama-server", args: [...args, ...safeArgs] };
  }

  if (provider === "vllm") {
    const args = ["serve", safeModel];
    if (safePort) {
      args.push("--port", String(safePort));
    }
    return { command: "vllm", args: [...args, ...safeArgs] };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

export function startServer({ provider, model, port, extraArgs }) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  const current = readServerState(provider);
  if (current.running) {
    return current;
  }

  const { command, args } = buildCommand({ provider, model, port, extraArgs });
  ensureStateDir();

  const log = fs.openSync(logFile(provider), "a");
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);

  if (!child.pid) {
    throw new Error(`${command} could not be started — is it installed and in PATH?`);
  }

  const state = {
    provider,
    pid: child.pid,
    command: [command, ...args].join(" "),
    model: model || null,
    port: Number.isInteger(port) ? port : null,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile(provider), JSON.stringify(state, null, 2));
  return { ...state, running: true };
}

export function stopServer(provider) {
  const state = readServerState(provider);
  if (!state.running || !state.pid) {
    return { ...state, running: false };
  }
  try {
    process.kill(-state.pid, "SIGTERM");
  } catch {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  try {
    fs.unlinkSync(stateFile(provider));
  } catch {
    // ignore
  }
  return { ...state, running: false };
}

export function readServerLogs(provider, lines = 120) {
  try {
    const content = fs.readFileSync(logFile(provider), "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export function clearServerLogs(provider) {
  try {
    fs.writeFileSync(logFile(provider), "");
  } catch {
    // ignore
  }
}

/** Parse the interesting pieces of a vLLM Prometheus /metrics payload. */
export function parseVllmMetrics(text) {
  const metrics = {};
  const patterns = {
    requestsRunning: /^vllm:num_requests_running(?:\{[^}]*\})?\s+([\d.]+)/m,
    requestsWaiting: /^vllm:num_requests_waiting(?:\{[^}]*\})?\s+([\d.]+)/m,
    gpuCacheUsage: /^vllm:gpu_cache_usage_perc(?:\{[^}]*\})?\s+([\d.]+)/m,
    cpuCacheUsage: /^vllm:cpu_cache_usage_perc(?:\{[^}]*\})?\s+([\d.]+)/m,
    promptTokensTotal: /^vllm:prompt_tokens_total(?:\{[^}]*\})?\s+([\d.]+)/m,
    generationTokensTotal: /^vllm:generation_tokens_total(?:\{[^}]*\})?\s+([\d.]+)/m,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) {
      metrics[key] = Number(match[1]);
    }
  }
  return metrics;
}
