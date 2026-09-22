// Unit tests for the local upgrade agent (dashboard button → opencode run).
// Only the pure parts are covered here: prompt, argv and config generation.
// The spawn path needs a real container (opencode + a mounted checkout).
import { describe, expect, it } from "vitest";
import {
  buildOpencodeArgs,
  buildUpgradePrompt,
  isGitCheckout,
  UPGRADE_PROVIDER_ID,
} from "../../src/lib/upgrade/agent.js";

describe("upgrade agent — prompt", () => {
  const prompt = buildUpgradePrompt({ repoPath: "/workspace/9router", reportFile: "/app/data/upgrade/last-report.md" });

  it("points the agent at the upgrade skill", () => {
    expect(prompt).toContain("skills/9router-upgrade/SKILL.md");
  });

  it("asks for a rebase onto the upstream default branch with a backup branch", () => {
    expect(prompt).toContain("git rebase");
    expect(prompt).toMatch(/upstream default branch|origin\/master/);
    expect(prompt).toContain("backup/pre-rebase-");
  });

  it("forbids pushing and asks for focused commits", () => {
    expect(prompt).toMatch(/Do NOT push/i);
    expect(prompt).toContain("conventional commits");
  });

  it("requires the build + regression gate before finishing", () => {
    expect(prompt).toContain("npm run build");
    expect(prompt).toContain("tests/__baseline__/run-gate.mjs");
    expect(prompt).toMatch(/pass->fail|pass→fail/);
  });

  it("writes a report and rebuilds the stack last", () => {
    expect(prompt).toContain("/app/data/upgrade/last-report.md");
    expect(prompt).toContain("docker compose up -d --build");
    expect(prompt).toMatch(/must be last/i);
  });

  it("prefers aborting over guessing when the rebase goes wrong", () => {
    expect(prompt).toContain("git rebase --abort");
  });
});

describe("upgrade agent — opencode invocation", () => {
  it("runs standalone, auto-approved, with the router model", () => {
    const args = buildOpencodeArgs({ model: "opencode-go/deepseek-v4.1-flash", prompt: "P" });
    expect(args.slice(0, 6)).toEqual([
      "run",
      "--standalone",
      "--auto",
      "--model",
      `${UPGRADE_PROVIDER_ID}/opencode-go/deepseek-v4.1-flash`,
      "P",
    ]);
  });

  it("keeps combos usable as the model", () => {
    const args = buildOpencodeArgs({ model: "free", prompt: "P" });
    expect(args).toContain(`${UPGRADE_PROVIDER_ID}/free`);
  });
});

describe("upgrade agent — repo detection", () => {
  it("reports a missing checkout instead of throwing", () => {
    expect(isGitCheckout("/definitely/not/a/repo")).toBe(false);
  });
});

describe("upgrade agent — status route", () => {
  it("returns install/repo state plus model suggestions", async () => {
    const { GET } = await import("../../src/app/api/upgrade/status/route.js");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("installed");
    expect(body).toHaveProperty("repoPresent");
    expect(body).toHaveProperty("running");
    expect(Array.isArray(body.suggestions)).toBe(true);
  });
});
