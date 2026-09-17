import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstApiKey } from "./apiAuth.js";
import { routerBaseV1, routerRoot } from "./harnessConfig.js";

const execFileAsync = promisify(execFile);

// Remote agent host manager: drives VS Code's Agent Host (AHP over a dev
// tunnel) on this machine so 9Router can act as a remote agent backend for
// VS Code clients (desktop Agents window and insiders.vscode.dev/agents).
//
//   code agent host --tunnel --name <host>   → standalone agent host + tunnel
//   code agent endpoints                     → live endpoints incl. tokens
//   code agent ps                            → active sessions
//
// The harnesses running next to the workspace use the local 9Router endpoint
// (ANTHROPIC_BASE_URL/OPENAI_BASE_URL → http://127.0.0.1:20128), configured via
// the CLI tools writers.

const REMOTE_DIR = path.join(os.homedir(), ".9router", "remote");
const STATE_FILE = path.join(REMOTE_DIR, "agent-host.json");
const LOG_FILE = path.join(REMOTE_DIR, "agent-host.log");
const WORKSPACES_DIR = path.join(REMOTE_DIR, "workspaces");
const AGENT_CLI_DIR = path.join(REMOTE_DIR, "agent-cli");

function ensureDir() {
  fs.mkdirSync(REMOTE_DIR, { recursive: true });
  fs.mkdirSync(AGENT_CLI_DIR, { recursive: true });
}

async function findCli() {
  for (const candidate of ["code-insiders", "code"]) {
    try {
      await execFileAsync("which", [candidate], { timeout: 2000 });
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

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...raw, running: isAlive(raw.pid) };
  } catch {
    return { running: false, pid: null, name: null, cli: null, startedAt: null };
  }
}

/**
 * Live agent host state. The CLI wrapper detaches into a supervisor, so pid
 * liveness alone is not enough: a registered standalone endpoint means the
 * host is up even after the spawned process exits.
 */
export async function getAgentHostState() {
  const raw = readState();
  const endpoints = await listAgentEndpoints();
  const standalone = endpoints.find((endpoint) => endpoint?.type === "standalone");
  const wrapperAlive = isAlive(raw.pid);
  const supervisorPid = standalone?.pid || null;
  return {
    ...raw,
    running: wrapperAlive || Boolean(standalone),
    pid: wrapperAlive ? raw.pid : supervisorPid || raw.pid,
    wrapperPid: raw.pid,
    supervisorPid,
  };
}

/**
 * Start a standalone agent host exposed through a dev tunnel. Auth (GitHub or
 * Microsoft) happens interactively in the CLI on first use; its output is
 * streamed to ~/.9router/remote/agent-host.log for the dashboard to show.
 */
function spawnAgentHost(cli, args, env) {
  const outFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(cli, args, {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env,
  });
  child.unref();
  fs.closeSync(outFd);
  return child;
}

function tailLog(lines = 40) {
  try {
    return fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export async function startAgentHost({ name } = {}) {
  const current = readState();
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
  const machineName = String(name || "9router-agent")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 40) || "9router-agent";

  // Harnesses spawned by the agent host inherit this environment, so Claude
  // Code / Codex / opencode resolve models through 9Router. Persisted configs
  // (Remote page → "Wire harnesses") cover the case where the host is started
  // from a plain shell instead.
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: routerRoot(),
    OPENAI_BASE_URL: routerBaseV1(),
  };
  try {
    const apiKey = await firstApiKey();
    if (apiKey) {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
      env.ANTHROPIC_API_KEY = apiKey;
      env.OPENAI_API_KEY = apiKey;
    }
  } catch {
    // no key available; harness configs / public endpoint still apply
  }

  const args = [
    // Separate CLI data dir: the workspace tunnel and the agent host tunnel
    // would otherwise fight over the same persisted tunnel (name takeover
    // shuts the other host down). The endpoint registry stays shared.
    "--cli-data-dir",
    AGENT_CLI_DIR,
    "agent",
    "host",
    "--tunnel",
    "--name",
    machineName,
  ];
  let child = spawnAgentHost(cli, args, env);
  // The CLI exits when another agent host is registered without a tunnel
  // (e.g. an editor's local host): take it over and retry once.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (!isAlive(child.pid) && /already running|conflicts with the running supervisor/i.test(tailLog())) {
    child = spawnAgentHost(cli, [...args, "--replace"], env);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  if (!child.pid) {
    const error = new Error(`${cli} agent host could not be started`);
    error.code = "SPAWN_FAILED";
    throw error;
  }

  const state = {
    pid: child.pid,
    cli,
    name: machineName,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return { ...state, running: isAlive(child.pid) };
}

export async function stopAgentHost() {
  const state = await getAgentHostState();
  if (!state.running) {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // ignore
    }
    return { ...state, running: false };
  }
  const cli = state.cli || (await findCli());
  if (cli) {
    try {
      // Stops standalone supervisors only; an editor's own agent host is kept.
      await execFileAsync(cli, ["agent", "kill"], { timeout: 10000 });
    } catch {
      // fall through to signals
    }
  }
  const targetPid = state.supervisorPid || state.pid;
  if (isAlive(targetPid)) {
    try {
      process.kill(targetPid, "SIGTERM");
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

export function readAgentHostLogs(lines = 200) {
  try {
    return fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Live endpoints published by any agent host (includes connection tokens). */
export async function listAgentEndpoints() {
  const cli = await findCli();
  if (!cli) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(cli, ["agent", "endpoints"], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed?.endpoints) ? parsed.endpoints : [];
  } catch {
    return [];
  }
}

/** Active sessions on the running host (code agent ps). */
export async function listAgentSessions() {
  const cli = await findCli();
  if (!cli) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(cli, ["agent", "ps", "--json"], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

export function listRemoteWorkspaces() {
  try {
    return fs
      .readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(WORKSPACES_DIR, entry.name);
        let size = null;
        try {
          const stat = fs.statSync(path.join(full, ".git"));
          size = stat.isDirectory() ? "git" : null;
        } catch {
          size = null;
        }
        return { name: entry.name, path: full, git: size === "git" };
      });
  } catch {
    return [];
  }
}

/**
 * Prepare a workspace copy on this machine (the remote session folder): clone
 * a git URL or copy an existing local folder into ~/.9router/remote/workspaces.
 */
export async function prepareWorkspace({ repo, branch, name, copyFrom } = {}) {
  ensureDir();
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  const folderName = String(
    name ||
      (repo ? repo.split("/").pop().replace(/\.git$/, "") : copyFrom ? path.basename(copyFrom) : "")
  )
    .replace(/[^A-Za-z0-9._-]/g, "-");
  if (!folderName) {
    throw new Error("repo, copyFrom or name is required");
  }
  const target = path.join(WORKSPACES_DIR, folderName);
  if (fs.existsSync(target)) {
    return { created: false, path: target, reason: "exists" };
  }

  if (repo) {
    if (!/^(https:\/\/|git@)[A-Za-z0-9._:@/~-]+$/.test(repo)) {
      throw new Error("Invalid repository URL");
    }
    const args = ["clone", "--depth", "1"];
    if (branch) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
        throw new Error("Invalid branch name");
      }
      args.push("--branch", branch);
    }
    args.push(repo, target);
    await execFileAsync("git", args, { timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    return { created: true, path: target, repo, branch: branch || null };
  }

  if (copyFrom) {
    const source = path.resolve(String(copyFrom));
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error("copyFrom folder does not exist");
    }
    await execFileAsync("cp", ["-a", source, target], { timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    return { created: true, path: target, copiedFrom: source };
  }

  fs.mkdirSync(target, { recursive: true });
  return { created: true, path: target, empty: true };
}
