import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Agentic golden Altana: loop timing and arguments survive a blocked or throwing independent lane", async () => {
  const script = readFileSync(new URL("../scripts/trade-worker.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = script.indexOf("  for (;;) {", script.indexOf("console.log(`[trade-worker] chain=56"));
  const end = script.indexOf("  readiness.stop();", start);
  assert.ok(start >= 0 && end > start);
  const loop = script.slice(start, end);
  assert.equal(createHash("sha256").update(loop).digest("hex"), "4bd07eafe8e73896b5e1ea22e32fc596326a99183e0783eccf384cdbf3d80504");
  for (const lane of ["blocked", "throwing"] as const) {
    let now = 1_000;
    let release!: () => void;
    let failures = 0;
    const block = new Promise<void>(resolve => { release = resolve; });
    const agentic = Promise.resolve().then(async () => {
      if (lane === "blocked") await block;
      else throw new Error("Offline lane failure.");
    }).catch(() => { failures += 1; });
    const calls: unknown[] = [];
    const logs: string[] = [];
    const deps = Object.freeze({ marker: "Altana" });
    const run = new Function("runTradeWorkerOnce", "deps", "args", "Date", "setTimeout", "console", "sanitizeMessage",
      `return (async () => { let stopping = false; ${loop.replace("new Promise<void>", "new Promise")} })();`) as (...inputs: readonly unknown[]) => Promise<void>;
    await run(async (received: unknown, args: unknown) => {
      assert.equal(received, deps);
      calls.push({ at: now, args });
      return { outcomes: [{ agentId: "Altana" }], skippedNotReady: false };
    }, deps, { intervalMs: 60_000, dryRun: false, get once() { return calls.length === 3; } },
    { now: () => now }, (resolve: () => void, ms: number) => { now += ms; resolve(); },
    { log: (line: string) => logs.push(line), error: (line: string) => logs.push(line) }, (message: string) => message);
    assert.deepEqual(calls, [1_000, 61_000, 121_000].map(at => ({ at, args: { dryRun: false } })));
    assert.deepEqual(logs, Array.from({ length: 3 }, () => "[trade-worker] cycle done agents=1 ready=true"));
    release();
    await agentic;
    assert.equal(failures, lane === "throwing" ? 1 : 0);
  }
});
