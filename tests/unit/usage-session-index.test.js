import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

function detail(id, user, timestamp) {
  return {
    id,
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    connectionId: "connection-1",
    timestamp,
    status: "success",
    latency: { ttft: 10, total: 20 },
    tokens: { prompt_tokens: 10, completion_tokens: 2 },
    request: { messages: [{ role: "user", content: user }] },
    response: { content: "ok" },
  };
}

async function save(value) {
  await db.saveRequestDetail(value);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-index-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await import("@/lib/db/driver.js").then((module) => module.getAdapter());
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("request detail session indexes", () => {
  it("stores lookup keys and retrieves only the matching implicit conversation", async () => {
    await save(detail("implicit-a-1", "same question", "2026-09-24T10:00:00.000Z"));
    await save(detail("implicit-a-2", "same question", "2026-09-24T10:01:00.000Z"));
    await save(detail("implicit-b-1", "other question", "2026-09-24T10:02:00.000Z"));

    const { liveKeyForDetail, mergeKeyForDetail } = await import("../../src/lib/usage/sessions.js");
    const first = detail("probe", "same question", "2026-09-24T10:03:00.000Z");
    const implicitKey = mergeKeyForDetail(first);
    const liveKey = liveKeyForDetail(first);

    const indexed = await db.getDetailsByImplicitKey(implicitKey);
    expect(indexed.map((entry) => entry.id)).toEqual(["implicit-a-1", "implicit-a-2"]);
    expect((await db.getDetailsByLiveKey(liveKey)).map((entry) => entry.id)).toEqual(["implicit-a-1", "implicit-a-2"]);

    const columns = adapter.all("PRAGMA table_info(requestDetails)").map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["implicitKey", "liveKey", "label"]));
    const stored = adapter.get("SELECT implicitKey, liveKey, label FROM requestDetails WHERE id = ?", ["implicit-a-1"]);
    expect(stored.implicitKey).toBe(implicitKey);
    expect(stored.liveKey).toBe(liveKey);
    expect(stored.label).toBe("same question");
  });
});
