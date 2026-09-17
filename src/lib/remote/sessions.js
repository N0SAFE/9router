import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Service environments often miss the user bin dirs (uv/opencode/claude shims),
// so resolution and spawning use an extended PATH.
const EXTRA_BINS = [
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".opencode", "bin"),
  path.join(os.homedir(), ".bun", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];
const EXTENDED_PATH = [...EXTRA_BINS, process.env.PATH || ""].filter(Boolean).join(path.delimiter);

// 9Router cloud agent sessions: a session runs a harness CLI (Claude Code by
// default) on this machine, inside a prepared workspace copy, with the CLI
// pointed at the local 9Router instance for models. Sessions are persisted so
// they survive client disconnects and can be listed/forked from VS Code.

const REMOTE_DIR = path.join(os.homedir(), ".9router", "remote");
const SESSIONS_DIR = path.join(REMOTE_DIR, "sessions");
const WORKSPACES_DIR = path.join(REMOTE_DIR, "workspaces");
const INDEX_FILE = path.join(SESSIONS_DIR, "index.json");

const runningProcesses = new Map(); // sessionId → ChildProcess

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(entries) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
}

function readSession(id) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
  } catch {
    return null;
  }
}

function writeSession(session) {
  ensureDirs();
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionFile(session.id), JSON.stringify(session, null, 2));
  const index = readIndex().filter((entry) => entry.id !== session.id);
  index.unshift({
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.messages.length,
  });
  writeIndex(index);
}

function randomId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function findHarness() {
  const candidates = [
    { bin: "claude", harness: "claude" },
    { bin: "opencode", harness: "opencode" },
  ];
  for (const candidate of candidates) {
    for (const dir of EXTRA_BINS) {
      const direct = path.join(dir, candidate.bin);
      if (fs.existsSync(direct)) {
        return { ...candidate, bin: direct };
      }
    }
    try {
      await execFileAsync("which", [candidate.bin], {
        timeout: 2000,
        env: { ...process.env, PATH: EXTENDED_PATH },
      });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function listSessions() {
  return readIndex();
}

export function getSession(id) {
  return readSession(id);
}

export function createSession({ workspace, model, title } = {}) {
  ensureDirs();
  const workspacePath = String(workspace || "").trim() || path.join(WORKSPACES_DIR, "scratch");
  fs.mkdirSync(workspacePath, { recursive: true });

  const session = {
    id: randomId(),
    title: String(title || "New session").slice(0, 120),
    workspace: workspacePath,
    model: String(model || "").trim() || null,
    harness: null,
    harnessSessionId: null,
    forkFrom: null,
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  writeSession(session);
  return session;
}

export function deleteSession(id) {
  stopSession(id);
  try {
    fs.unlinkSync(sessionFile(id));
  } catch {
    // ignore
  }
  writeIndex(readIndex().filter((entry) => entry.id !== id));
  return { deleted: id };
}

export function stopSession(id) {
  const child = runningProcesses.get(id);
  if (!child) {
    return { stopped: false };
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  runningProcesses.delete(id);
  const session = readSession(id);
  if (session) {
    session.status = "stopped";
    writeSession(session);
  }
  return { stopped: true };
}

/**
 * Fork a session: the transcript is copied and the harness conversation is
 * forked on its next message (--resume <parent> --fork-session).
 */
export function forkSession(id, { title } = {}) {
  const parent = readSession(id);
  if (!parent) {
    throw new Error("Session not found");
  }
  const forked = {
    ...parent,
    id: randomId(),
    title: String(title || `${parent.title} (fork)`).slice(0, 120),
    forkFrom: parent.id,
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeSession(forked);
  return forked;
}

function buildHarnessArgs({ harness, prompt, session, resumeId, fork, permissionMode }) {
  const args = [];
  if (harness === "claude") {
    args.push("-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages");
    if (resumeId) {
      args.push("--resume", resumeId);
    }
    if (fork) {
      args.push("--fork-session");
    }
    if (session.model) {
      args.push("--model", session.model);
    }
    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }
  } else {
    // opencode run <prompt> [--model provider/model]
    args.push("run", prompt);
    if (session.model) {
      args.push("--model", session.model);
    }
    if (resumeId) {
      args.push("--session", resumeId);
    }
  }
  return args;
}

function harnessEnv(root, apiKey) {
  return {
    ...process.env,
    PATH: EXTENDED_PATH,
    ANTHROPIC_BASE_URL: root,
    ANTHROPIC_API_KEY: apiKey || process.env.ANTHROPIC_API_KEY || "9router",
    OPENAI_BASE_URL: `${root}/v1`,
    OPENAI_API_KEY: apiKey || process.env.OPENAI_API_KEY || "9router",
  };
}

function parseClaudeLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") {
    return null;
  }
  if (event.type === "system" && event.session_id) {
    return { type: "session", harnessSessionId: event.session_id, model: event.model || null };
  }
  if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
    const delta = event.event.delta;
    if (delta?.type === "text_delta" && delta.text) {
      return { type: "text", text: delta.text };
    }
    if (delta?.type === "thinking_delta" && delta.thinking) {
      return { type: "thinking", text: delta.thinking };
    }
    return null;
  }
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const parts = [];
    for (const block of event.message.content) {
      if (block?.type === "tool_use") {
        parts.push({ type: "tool_use", name: block.name, input: block.input });
      } else if (block?.type === "text" && block.text) {
        parts.push({ type: "text", text: block.text, full: true });
      }
    }
    return parts.length > 0 ? { type: "blocks", blocks: parts } : null;
  }
  if (event.type === "result") {
    return {
      type: "result",
      text: typeof event.result === "string" ? event.result : null,
      sessionId: event.session_id || null,
      costUsd: event.total_cost_usd ?? null,
      usage: event.usage || null,
      isError: event.is_error === true,
    };
  }
  return null;
}

/**
 * Send a prompt to a session and stream harness events. Resolves when the
 * harness finishes; the caller can forward events to clients as they arrive.
 */
export async function sendMessage(id, prompt, { onEvent, root, apiKey, permissionMode, model } = {}) {
  const session = readSession(id);
  if (!session) {
    throw new Error("Session not found");
  }
  if (runningProcesses.has(id)) {
    throw new Error("Session is already running");
  }
  const harnessInfo = await findHarness();
  if (!harnessInfo) {
    throw new Error("No agent harness installed (claude/opencode)");
  }
  if (model && model !== session.model) {
    session.model = model;
  }

  const resumeId = session.harnessSessionId || null;
  const fork = !resumeId && session.forkFrom ? true : false;
  const args = buildHarnessArgs({
    harness: harnessInfo.harness,
    prompt: String(prompt),
    session,
    resumeId,
    fork: fork && session.forkFrom ? true : false,
    permissionMode,
  });

  session.messages.push({ role: "user", content: String(prompt), ts: new Date().toISOString() });
  session.status = "running";
  session.harness = harnessInfo.harness;
  writeSession(session);

  const child = spawn(harnessInfo.bin, args, {
    cwd: session.workspace,
    env: harnessEnv(root, apiKey),
    stdio: ["ignore", "pipe", "pipe"],
  });
  runningProcesses.set(id, child);

  let buffer = "";
  let assistantText = "";

  const handleLine = (line) => {
    if (!line.trim()) {
      return;
    }
    const event = harnessInfo.harness === "claude"
      ? parseClaudeLine(line)
      : line.startsWith("{")
        ? (() => {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "text" && parsed.text) {
                return { type: "text", text: parsed.text };
              }
              return null;
            } catch {
              return null;
            }
          })()
        : { type: "text", text: line };

    if (!event) {
      return;
    }
    if (event.type === "session" && event.harnessSessionId) {
      const current = readSession(id);
      if (current) {
        current.harnessSessionId = event.harnessSessionId;
        writeSession(current);
      }
      onEvent?.({ type: "session", harnessSessionId: event.harnessSessionId });
      return;
    }
    if (event.type === "text") {
      assistantText += event.text;
      onEvent?.({ type: "text", text: event.text });
      return;
    }
    if (event.type === "thinking") {
      onEvent?.({ type: "thinking", text: event.text });
      return;
    }
    if (event.type === "blocks") {
      for (const block of event.blocks) {
        if (block.type === "tool_use") {
          onEvent?.({ type: "tool", name: block.name, input: block.input });
        } else if (block.type === "text" && block.full) {
          // Full assistant message arrives after streamed deltas; keep only
          // the delta-built text to avoid duplicates, but forward tool blocks.
        }
      }
      return;
    }
    if (event.type === "result") {
      onEvent?.({
        type: "result",
        isError: event.isError,
        costUsd: event.costUsd,
        usage: event.usage,
        sessionId: event.sessionId,
      });
    }
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      onEvent?.({ type: "stderr", text: text.slice(0, 2000) });
    }
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(-1));
  });
  runningProcesses.delete(id);

  const final = readSession(id);
  if (final) {
    final.status = exitCode === 0 ? "completed" : "failed";
    if (assistantText.trim()) {
      final.messages.push({ role: "assistant", content: assistantText.trim(), ts: new Date().toISOString() });
    }
    writeSession(final);
  }
  onEvent?.({ type: "done", exitCode });
  return { exitCode, text: assistantText };
}
