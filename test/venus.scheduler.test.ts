/**
 * PHASE4 — the daemon scheduler, and the eternal-sleep bug the FIRST real
 * daemon run found (2026-08-24).
 *
 * `sleepUntilNextVenusCycle` recomputed "the next boundary from now" on every
 * iteration, and `nextVenusCycleDelayMs`'s overrun branch never answers <= 0 —
 * so after one sleep landed ON a boundary, the recomputation named the NEXT
 * boundary, forever. One cycle ran; the daemon then slept eternally while the
 * process sat alive and healthy-looking. `--once` never touches this function,
 * which is why two live rescues landed without exposing it, and why the suite
 * was green: NOTHING tested the loop. These tests are that nothing, closed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  nextVenusCycleDelayMs,
  sleepUntilNextVenusCycle,
} from "../src/venus/worker.js";

const INTERVAL = 30_000;

describe("nextVenusCycleDelayMs", () => {
  it("a fast cycle waits out the remainder of its interval", () => {
    assert.equal(nextVenusCycleDelayMs(0, 5_000, INTERVAL), 25_000);
  });

  it("an overrun SKIPS to the next boundary — R3.10's skip-on-overrun", () => {
    // Cycle took 42s against a 30s interval: the missed tick is skipped and
    // the next boundary is t=60s, so 18s remain.
    assert.equal(nextVenusCycleDelayMs(0, 42_000, INTERVAL), 18_000);
  });

  it("landing EXACTLY on a boundary names the one after — this is why the caller must FIX its target", () => {
    // The function's contract: it always names a boundary strictly ahead of
    // `now`. At t=30_000 it answers 30_000 (target t=60_000), never 0. A
    // caller that recomputes after sleeping therefore chases boundaries
    // forever; the fixed-target loop below is the required shape.
    assert.equal(nextVenusCycleDelayMs(0, 30_000, INTERVAL), 30_000);
    assert.equal(nextVenusCycleDelayMs(0, 60_000, INTERVAL), 30_000);
  });
});

describe("sleepUntilNextVenusCycle: the fixed target", () => {
  it("sleeps ONCE to the boundary and RETURNS — the eternal-sleep regression", async () => {
    // A fake clock that advances exactly by each requested sleep — the
    // real-world case where the sleep lands ON the boundary. The buggy loop
    // never returned here; the runner's test timeout was the only exit.
    let nowMs = 5_000;
    const sleeps: number[] = [];
    await sleepUntilNextVenusCycle({
      cycleStartedAtMs: 0,
      intervalMs: INTERVAL,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
        // The tripwire that makes the regression VISIBLE instead of a hang:
        assert.ok(
          sleeps.length <= 3,
          `the scheduler slept ${sleeps.length} times chasing a moving boundary: ${sleeps.join(", ")}`,
        );
      },
    });
    assert.deepEqual(sleeps, [25_000]);
    assert.equal(nowMs, 30_000);
  });

  it("an overrun cycle sleeps to the SKIPPED-to boundary, not interval-from-now", async () => {
    let nowMs = 42_000;
    const sleeps: number[] = [];
    await sleepUntilNextVenusCycle({
      cycleStartedAtMs: 0,
      intervalMs: INTERVAL,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
        assert.ok(sleeps.length <= 3);
      },
    });
    assert.deepEqual(sleeps, [18_000]);
    assert.equal(nowMs, 60_000);
  });

  it("a sleep that wakes EARLY re-sleeps toward the SAME target rather than drifting", async () => {
    let nowMs = 5_000;
    const sleeps: number[] = [];
    let woke = false;
    await sleepUntilNextVenusCycle({
      cycleStartedAtMs: 0,
      intervalMs: INTERVAL,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        // First wake is 10s early; the loop must re-aim at the ORIGINAL
        // t=30_000 target, not compute a fresh boundary.
        nowMs += woke ? ms : ms - 10_000;
        woke = true;
        assert.ok(sleeps.length <= 3);
      },
    });
    assert.deepEqual(sleeps, [25_000, 10_000]);
    assert.equal(nowMs, 30_000);
  });

  it("stopped() exits immediately without sleeping", async () => {
    const sleeps: number[] = [];
    await sleepUntilNextVenusCycle({
      cycleStartedAtMs: 0,
      intervalMs: INTERVAL,
      now: () => 5_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      stopped: () => true,
    });
    assert.equal(sleeps.length, 0);
  });
});
