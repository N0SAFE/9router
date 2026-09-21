import { describe, expect, it } from "vitest";
import { describeModelParameters, getModelParameters } from "../../open-sse/providers/modelParameters.js";

describe("model parameter descriptor", () => {
  it("marks temperature unsupported where the provider drops it (Claude)", () => {
    const { parameters } = getModelParameters("claude", "claude-sonnet-5");
    expect(parameters.temperature.supported).toBe(false);
    expect(parameters.reasoning_effort.supported).toBe(true);
    expect(parameters.reasoning_effort.values).toContain("max");
  });

  it("uses per-model thinking levels (codex gpt-5.6-sol exposes ultra)", () => {
    const { parameters } = getModelParameters("codex", "gpt-5.6-sol");
    expect(parameters.reasoning_effort.values).toContain("ultra");
    expect(parameters.thinking.format).toBe("openai");
  });

  it("reports non-reasoning models as effort/thinking unsupported", () => {
    const { parameters } = getModelParameters("openrouter", "meta-llama/llama-3.3-70b-instruct");
    expect(parameters.reasoning_effort.supported).toBe(false);
    expect(parameters.thinking.supported).toBe(false);
    expect(parameters.temperature.supported).toBe(true);
  });

  it("caps max_tokens at the effective output ceiling", () => {
    const { parameters } = getModelParameters("opencode-go", "deepseek-v4.1-flash", { maxOutput: 100_000 });
    expect(parameters.max_tokens.max).toBe(100_000);
    const { parameters: withoutOverride } = getModelParameters("opencode-go", "deepseek-v4.1-flash");
    expect(withoutOverride.max_tokens.max).toBeGreaterThanOrEqual(100_000);
  });

  it("summarizes settings for tooltips and pickers", () => {
    const summary = describeModelParameters("claude", "claude-sonnet-5");
    expect(summary).toContain("effort:");
    expect(summary).toContain("temp ✕");
  });
});
