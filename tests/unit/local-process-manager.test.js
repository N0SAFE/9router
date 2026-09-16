import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseProcessList } from "@/lib/local/processManager.js";

const PS_OUTPUT = [
  "  123  3600 /usr/bin/ollama serve",
  "  456   120 /usr/local/bin/llama-server -hf ggml-org/gemma-3-4b-it-GGUF --port 8080",
  "  789    45 python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-8B",
  "  999     5 /usr/bin/node cli.js",
].join("\n");

describe("local process detection", () => {
  it("detects a system ollama serve process", () => {
    const found = parseProcessList(PS_OUTPUT, "ollama");
    assert.equal(found.pid, 123);
    assert.equal(found.source, "system");
    assert.equal(found.running, true);
    assert.match(found.command, /ollama serve/);
    assert.ok(found.startedAt, "startedAt is derived from etimes");
  });

  it("detects llama-server and vLLM processes", () => {
    assert.equal(parseProcessList(PS_OUTPUT, "llamacpp").pid, 456);
    assert.equal(parseProcessList(PS_OUTPUT, "vllm").pid, 789);
  });

  it("does not match unrelated processes", () => {
    assert.equal(parseProcessList(PS_OUTPUT, "unknown-provider"), null);
    assert.equal(parseProcessList("  321 10 ollama run llama3.2", "ollama"), null);
    assert.equal(parseProcessList("", "ollama"), null);
    assert.equal(parseProcessList("not ps output\nat all", "llamacpp"), null);
  });

  it("matches ollama serve for the ollama-local provider id", () => {
    assert.equal(parseProcessList(PS_OUTPUT, "ollama-local").pid, 123);
  });
});
