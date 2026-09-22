#!/usr/bin/env node
// Suite runner + failure-set comparator for this fork.
//
// Why this exists instead of only the upstream gate:
//   * verify-no-regression.mjs derives test identities with
//     `testResult.name.split("/app/")[1]`, which only resolves on a checkout
//     whose absolute path contains "/app/" (upstream CI / docker). Everywhere
//     else each known failure looks like a regression.
//   * the committed known-fails.txt catalogue is stale for this fork (dozens of
//     pre-existing failures are not listed), so it is informational, not a gate.
//
// After a rebase the authoritative question is: which tests passed *before*
// (pre-rebase branch / upstream) and fail *now*? That is --compare.
//
// Usage:
//   node tests/__baseline__/run-gate.mjs --run [results.json] [extra vitest args…]
//   node tests/__baseline__/run-gate.mjs --compare <before.json> <after.json>
//
// Upgrade flow:
//   node tests/__baseline__/run-gate.mjs --run /tmp/9router-after.json
//   git worktree add --detach /tmp/9router-pre backup/pre-rebase-YYYYmmdd-HHMMSS
//   ln -sfn "$PWD/node_modules" /tmp/9router-pre/node_modules
//   ln -sfn "$PWD/tests/node_modules" /tmp/9router-pre/tests/node_modules
//   node /tmp/9router-pre/tests/__baseline__/run-gate.mjs --run /tmp/9router-pre.json
//   node tests/__baseline__/run-gate.mjs --compare /tmp/9router-pre.json /tmp/9router-after.json
//
// Exit codes: 0 no pass->fail transitions, 1 regressions found, 2 usage error.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url)); // tests/__baseline__
const testsDir = resolve(here, "..");
const repoRoot = resolve(testsDir, "..");

function usage() {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 24).join("\n"));
  process.exit(2);
}

// "/abs/path/repo/tests/unit/x.test.js" -> "tests/unit/x.test.js"
function norm(fileName) {
  const i = fileName.lastIndexOf("/tests/");
  return i >= 0 ? fileName.slice(i + 1) : fileName;
}

function loadFailures(file) {
  const results = JSON.parse(readFileSync(file, "utf8"));
  const fails = new Map(); // "path :: test" -> status
  let total = 0;
  for (const f of results.testResults || []) {
    const path = norm(f.name);
    for (const a of f.assertionResults || []) {
      total += 1;
      fails.set(`${path} :: ${a.fullName}`, a.status);
    }
  }
  return { fails, total };
}

function run(outFile, extraArgs = []) {
  if (!existsSync(join(testsDir, "node_modules", "vitest"))) {
    console.error(`[gate] vitest not installed — run: cd ${testsDir} && npm install`);
    process.exit(2);
  }
  const target = outFile || join(tmpdir(), "9router-results.json");
  console.log(`[gate] running vitest in ${repoRoot}`);
  const runRes = spawnSync(
    "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${target}`, ...extraArgs],
    { cwd: testsDir, stdio: "inherit", shell: process.platform === "win32" }
  );
  if (!existsSync(target)) {
    console.error("[gate] vitest produced no JSON results — see the output above");
    process.exit(runRes.status || 1);
  }

  const { fails, total } = loadFailures(target);
  const knownFile = join(here, "known-fails.txt");
  const known = existsSync(knownFile)
    ? new Set(readFileSync(knownFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean))
    : new Set();
  const failed = [...fails].filter(([, status]) => status === "failed").map(([name]) => name);
  const catalogued = failed.filter((name) => known.has(name));

  console.log(`\n[gate] ${failed.length} failing of ${total} tests → results: ${target}`);
  console.log(`[gate] ${catalogued.length}/${known.size} catalogued known-fails are failing (informational — the catalogue is stale)`);
  console.log("[gate] authoritative check: --compare against a pre-rebase / upstream run");
  process.exit(0);
}

function compare(beforeFile, afterFile) {
  const before = loadFailures(beforeFile);
  const after = loadFailures(afterFile);
  const beforeFailed = new Set([...before.fails].filter(([, s]) => s === "failed").map(([n]) => n));
  const afterFailed = new Set([...after.fails].filter(([, s]) => s === "failed").map(([n]) => n));

  const regressions = [...afterFailed].filter((n) => !beforeFailed.has(n)).sort();
  const fixed = [...beforeFailed].filter((n) => !afterFailed.has(n)).sort();

  console.log(`[gate] before: ${before.total} tests, ${beforeFailed.size} failing  (${beforeFile})`);
  console.log(`[gate] after:  ${after.total} tests, ${afterFailed.size} failing  (${afterFile})`);

  if (fixed.length) {
    console.log(`\n✅ fixed by this change: ${fixed.length}`);
    for (const name of fixed.slice(0, 10)) console.log("  +", name);
    if (fixed.length > 10) console.log(`  ... +${fixed.length - 10} more`);
  }

  if (regressions.length) {
    console.error(`\n❌ REGRESSION: ${regressions.length} test(s) passed before and fail now:\n`);
    for (const name of regressions) console.error("  -", name);
    process.exit(1);
  }

  console.log("\n✅ No test passed before and fails now.");
  process.exit(0);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "--run") run(args[0], args.slice(1));
else if (mode === "--compare" && args.length === 2) compare(args[0], args[1]);
else usage();
