import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Workspace tunnel manager: runs `code tunnel` on this machine so a VS Code
// client (desktop or vscode.dev) connects to a remote workspace here. The
// extension host — including the chat harness, tools and MCP servers — runs on
// this machine, and extensions installed on the remote can serve its models.

const REMOTE_DIR = path.join(os.homedir(), ".9router", "remote");
const STATE_FILE = path.join(REMOTE_DIR, "tunnel.json");
const LOG_FILE = path.join(REMOTE_DIR, "tunnel.log");

const EXTRA_BINS = [
  path.join(os.homedir(), ".local", "bin"),
  "/usr/local/bin",
  "/usr/bin",
];
const EXTENDED_PATH = [...EXTRA_BINS, process.env.PATH || ""].filter(Boolean).join(path.delimiter);

function ensureDir() {
  fs.mkdirSync(REMOTE_DIR, { recursive: true });
}

async function findCli() {
  for (const candidate of ["code-insiders", "code"]) {
    for (const dir of EXTRA_BINS) {
      const direct = path.join(dir, candidate);
      if (fs.existsSync(direct)) {
        return direct;
      }
    }
    try {
      await execFileAsync("which", [candidate], { timeout: 2000, env: { ...process.env, PATH: EXTENDED_PATH } });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
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

function sanitizeName(value) {
  return String(value || os.hostname())
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "9router";
}

/** Parse the vscode.dev tunnel URL, machine name and device code out of tunnel logs. */
export function parseTunnelLog(text) {
  const result = { url: null, name: null, deviceCode: null };
  if (typeof text !== "string") {
    return result;
  }
  const urlMatch = text.match(/https:\/\/vscode\.dev\/tunnel\/([a-zA-Z0-9._-]+)/);
  if (urlMatch) {
    result.url = urlMatch[0];
    result.name = urlMatch[1];
  } else {
    const nameMatch = text.match(/tunnel\/([a-zA-Z0-9._-]+)\s*$/m);
    if (nameMatch) {
      result.name = nameMatch[1];
      result.url = `https://vscode.dev/tunnel/${nameMatch[1]}`;
    }
  }
  const codeMatch = text.match(/use code\s+([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/i);
  if (codeMatch) {
    result.deviceCode = codeMatch[1].toUpperCase();
  }
  return result;
}

export function readTunnelState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const log = readTunnelLogs(200);
    const parsed = parseTunnelLog(log);
    return {
      ...raw,
      ...(parsed.url ? { url: parsed.url } : {}),
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.deviceCode ? { deviceCode: parsed.deviceCode } : {}),
      running: isAlive(raw.pid),
    };
  } catch {
    return { running: false, pid: null, name: null, url: null, deviceCode: null, cli: null, startedAt: null };
  }
}

export function readTunnelLogs(lines = 200) {
  try {
    return fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Start `code tunnel` (VS Code Server + tunnel) on this machine. `service: true`
 * installs it as a background service so the tunnel survives restarts.
 */
export async function startWorkspaceTunnel({ name, service = false } = {}) {
  const current = readTunnelState();
  if (current.running) {
    return current;
  }
  const cli = await findCli();
  if (!cli) {
    const error = new Error("VS Code CLI not found (code-insiders/code)");
    error.code = "NO_CLI";
    throw error;
  }
  ensureDir();
  const machineName = sanitizeName(name);
  const args = service
    ? ["tunnel", "service", "install", "--name", machineName, "--accept-server-license-terms"]
    : ["tunnel", "--name", machineName, "--accept-server-license-terms"];

  const outFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(cli, args, {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, PATH: EXTENDED_PATH },
  });
  child.unref();
  fs.closeSync(outFd);

  if (!child.pid) {
    const error = new Error(`${cli} tunnel could not be started`);
    error.code = "SPAWN_FAILED";
    throw error;
  }

  const state = {
    pid: child.pid,
    cli,
    name: machineName,
    service,
    url: `https://vscode.dev/tunnel/${machineName}`,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return { ...state, running: true };
}

export function stopWorkspaceTunnel() {
  const state = readTunnelState();
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
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
  return { ...state, running: false };
}
