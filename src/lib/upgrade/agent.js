import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawn } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

// The upgrade agent: runs the opencode CLI inside this container against the
// fork's git checkout (mounted at UPGRADE_REPO_PATH) and follows
// skills/9router-upgrade/SKILL.md to rebase onto upstream.
//
// State and logs live in DATA_DIR so they survive container recreates and are
// readable from the dashboard.

const UPGRADE_DIR = path.join(DATA_DIR, "upgrade");
const STATE_FILE = path.join(UPGRADE_DIR, "state.json");
const LOG_FILE = path.join(UPGRADE_DIR, "run.log");
const REPORT_FILE = path.join(UPGRADE_DIR, "last-report.md");
const OPENCODE_DIR = process.env.OPENCODE_CONFIG_DIR || path.join(DATA_DIR, "opencode");
const OPENCODE_CONFIG = process.env.OPENCODE_CONFIG || path.join(OPENCODE_DIR, "opencode.json");

export const DEFAULT_REPO_PATH = process.env.UPGRADE_REPO_PATH || "/workspace/9router";
export const UPGRADE_PROVIDER_ID = "9router";

const STARTUP_PROBE_MS = 1500;

function ensureDir() {
  fs.mkdirSync(UPGRADE_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// PATH extension mirroring the headroom detector: a packaged/launchd/container
// PATH may not include the install dirs opencode uses.
function extendedPath() {
  const extra = ["/usr/local/bin", "/usr/bin", "/bin", path.join(os.homedir(), ".opencode", "bin")];
  return [...extra, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
}

export function findOpencodeBinary() {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["opencode"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      env: { ...process.env, PATH: extendedPath() },
    }).trim();
    return out ? out.split(/\r?\n/)[0].trim() : null;
  } catch {
    return null;
  }
}

export function isGitCheckout(repoPath) {
  try {
    return fs.existsSync(path.join(repoPath, ".git"));
  } catch {
    return false;
  }
}

// Prompt handed to `opencode run`. Kept here (not in the dashboard) so the
// wording travels with the feature and stays in sync with the skill.
export function buildUpgradePrompt({ repoPath = DEFAULT_REPO_PATH, reportFile = REPORT_FILE } = {}) {
  return [
    "You are the 9Router upgrade agent running inside the self-hosted container.",
    "",
    "Goal: upgrade this fork of 9Router to the latest upstream by REBASING the local changes onto the upstream default branch, exactly as the fork's upgrade skill prescribes.",
    "",
    `Working directory: ${repoPath}`,
    "1. Read skills/9router-upgrade/SKILL.md and treat it as the source of truth.",
    "2. Record the current HEAD, then create a backup branch: backup/pre-rebase-$(date +%Y%m%d-%H%M%S).",
    "3. git fetch origin --prune, verify the upstream remote and default branch (git remote -v, git symbolic-ref refs/remotes/origin/HEAD), then git rebase onto it.",
    "4. Resolve conflicts by keeping both sides - never drop a fork feature. The skill lists the recurring hot spots (routing/translation, provider registry index collisions, the Docker stack).",
    "5. Run npm install only if package.json moved. `npm run build` must pass.",
    "6. Run the regression gate the skill describes (node tests/__baseline__/run-gate.mjs --run /tmp/9router-after.json, compared against a pre-rebase worktree and an upstream worktree) and fix every pass->fail regression before finishing.",
    "7. Commit the work as focused conventional commits (fix(scope): ..., feat(scope): ...). Do NOT push and do NOT rewrite published history.",
    `8. Write a short report to ${reportFile}: upstream base commit, conflicts resolved, gate result, commits created, anything left to do.`,
    `9. Final step, after committing and writing the report: cd ${repoPath} && docker compose up -d --build - this rebuilds the image and recreates the container you are running in, so it must be last.`,
    "",
    "If the rebase cannot be completed safely, run `git rebase --abort`, leave the working tree clean, and report why instead of guessing.",
  ].join("\n");
}

// `opencode run` invocation: standalone server (no background service in the
// container), auto-approved permissions (unattended run), model pinned to this
// router so the agent uses the model configured in the dashboard.
export function buildOpencodeArgs({ model, prompt }) {
  return ["run", "--standalone", "--auto", "--model", `${UPGRADE_PROVIDER_ID}/${model}`, prompt];
}

// Keep the opencode config in the data volume pointing at this router, so the
// agent works even when the CLI-tools card was never opened.
export function ensureOpencodeConfig({ baseUrl, apiKey, model }) {
  ensureDir();
  fs.mkdirSync(OPENCODE_DIR, { recursive: true });
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(OPENCODE_CONFIG, "utf8"));
  } catch {
    config = {};
  }
  config.$schema = config.$schema || "https://opencode.ai/config.json";
  if (!config.provider) config.provider = {};
  const provider = config.provider[UPGRADE_PROVIDER_ID] || {
    npm: "@ai-sdk/openai-compatible",
    name: "9Router",
    options: {},
    models: {},
  };
  provider.options = { ...(provider.options || {}), baseURL: `${String(baseUrl).replace(/\/$/, "")}/v1` };
  if (apiKey) provider.options.apiKey = apiKey;
  provider.models = { ...(provider.models || {}) };
  if (model && !provider.models[model]) provider.models[model] = { name: model };
  config.provider[UPGRADE_PROVIDER_ID] = provider;
  fs.writeFileSync(OPENCODE_CONFIG, JSON.stringify(config, null, 2));
  return OPENCODE_CONFIG;
}

export function getUpgradeLogTail(maxLines = 200) {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

export function getUpgradeReport() {
  try {
    return fs.readFileSync(REPORT_FILE, "utf8");
  } catch {
    return "";
  }
}

export function getUpgradeState() {
  const state = readState();
  const running = Boolean(state?.pid && isPidAlive(state.pid) && state.status === "running");
  if (state && state.status === "running" && !running) {
    // Process died between polls (container restart, crash) - record it once.
    state.status = "finished";
    state.finishedAt = state.finishedAt || new Date().toISOString();
    state.exitCode = state.exitCode ?? null;
    writeState(state);
  }
  return {
    installed: Boolean(findOpencodeBinary()),
    running,
    repoPath: state?.repoPath || DEFAULT_REPO_PATH,
    repoPresent: isGitCheckout(state?.repoPath || DEFAULT_REPO_PATH),
    model: state?.model || null,
    startedAt: state?.startedAt || null,
    finishedAt: state?.finishedAt || null,
    exitCode: state?.exitCode ?? null,
    status: state?.status || "idle",
    logFile: LOG_FILE,
    reportFile: REPORT_FILE,
    logTail: getUpgradeLogTail(),
    report: getUpgradeReport(),
  };
}

export async function startUpgrade({ model, baseUrl, apiKey, repoPath = DEFAULT_REPO_PATH } = {}) {
  const current = readState();
  if (current?.pid && isPidAlive(current.pid) && current.status === "running") {
    const err = new Error("An upgrade run is already in progress");
    err.code = "ALREADY_RUNNING";
    throw err;
  }
  if (!model) {
    const err = new Error("No upgrade model configured");
    err.code = "NO_MODEL";
    throw err;
  }
  const binary = findOpencodeBinary();
  if (!binary) {
    const err = new Error("opencode CLI is not installed in this container");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  if (!isGitCheckout(repoPath)) {
    const err = new Error(`No git checkout at ${repoPath} - mount the fork into the container`);
    err.code = "NO_REPO";
    throw err;
  }

  const configPath = ensureOpencodeConfig({ baseUrl, apiKey, model });
  ensureDir();
  fs.writeFileSync(LOG_FILE, "");

  const prompt = buildUpgradePrompt({ repoPath });
  const args = buildOpencodeArgs({ model, prompt });
  const outFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(binary, args, {
    cwd: repoPath,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: {
      ...process.env,
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: OPENCODE_DIR,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(OPENCODE_DIR, "share"),
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(OPENCODE_DIR, "cache"),
      // The app runs as `node` with HOME=/root in the image; give the agent a
      // writable home so the CLI never trips over a read-only path.
      HOME: process.env.UPGRADE_AGENT_HOME || path.join(OPENCODE_DIR, "home"),
      DOCKER_HOST: process.env.DOCKER_HOST || "unix:///var/run/docker.sock",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  if (!child.pid) {
    fs.closeSync(outFd);
    const err = new Error("Failed to spawn opencode");
    err.code = "SPAWN_FAILED";
    throw err;
  }
  child.unref();

  const state = {
    pid: child.pid,
    model,
    repoPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    status: "running",
    logFile: LOG_FILE,
    reportFile: REPORT_FILE,
  };
  writeState(state);

  // Fail fast when the CLI exits immediately (bad model, bad config, missing
  // binary in the container PATH).
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fs.closeSync(outFd);
      if (isPidAlive(child.pid)) resolve();
      else reject(Object.assign(new Error("opencode exited during startup - see the run log"), { code: "EARLY_EXIT" }));
    }, STARTUP_PROBE_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      try { fs.closeSync(outFd); } catch { /* already closed */ }
      const finished = { ...state, status: "finished", exitCode: code, finishedAt: new Date().toISOString() };
      writeState(finished);
      reject(Object.assign(new Error(`opencode exited early (code=${code}) - see the run log`), { code: "EARLY_EXIT" }));
    });
  });

  return { pid: child.pid, model, logFile: LOG_FILE };
}

export function stopUpgrade() {
  const state = readState();
  if (!state?.pid || !isPidAlive(state.pid)) {
    return { stopped: false, reason: "not_running" };
  }
  const pid = state.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  const finished = { ...state, status: "stopped", finishedAt: new Date().toISOString() };
  writeState(finished);
  return { stopped: true, pid };
}
