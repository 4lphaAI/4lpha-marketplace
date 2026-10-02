/**
 * TRADFI-LLM-CMC-REQUEST (Revision 3, NORMATIVE) — coverage not already placed
 * alongside an existing file's fixtures: the durable per-window counter
 * (R2.4/R3.1), `classifyLlmDataRequestTicker` (§3/R2.5/R2.7), the probe
 * script's argument guard (R2.6/R3.5, never executed), and the
 * `refreshProbeOnce` unreachability pin (R3.5/R3.10 L4).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { MemoryTradeCmcStore, readCmcLlmRequestsLease, type CmcNewsLease } from "../src/store/tradeCmc.js";
import { classifyLlmDataRequestTicker } from "../src/trade/cmcUsEquity.js";
import { parseProbeArgs } from "../scripts/live-cmc-probe-skill.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AGENT = "llm-request-agent";
const NOW_MS = Date.UTC(2026, 8, 23, 21, 0);
const WINDOW_A = Date.UTC(2026, 8, 23, 20, 30); // this window's 16:30-ET start
const WINDOW_B = Date.UTC(2026, 8, 24, 20, 30); // the next trading day's window start
const CAP = 10;

describe("TRADFI-LLM-CMC-REQUEST R2.4/R3.1: the durable per-window claim counter", () => {
  it("claims 1..10, refuses the 11th in the same window", async () => {
    const store = new MemoryTradeCmcStore(() => NOW_MS);
    for (let i = 0; i < CAP; i += 1) {
      const claimed = await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: `op${i}`,
        nowMs: NOW_MS + i * 3_700_000, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
      assert.equal(claimed, true, `claim ${i} should succeed`);
      await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: `op${i}`, nowMs: NOW_MS + i * 3_700_000 });
    }
    const eleventh = await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "op10",
      nowMs: NOW_MS + CAP * 3_700_000, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
    assert.equal(eleventh, false, "the 11th claim in the same window must be refused");
  });

  it("a new window resets the count to 0", async () => {
    const store = new MemoryTradeCmcStore(() => NOW_MS);
    for (let i = 0; i < CAP; i += 1) {
      await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: `op${i}`,
        nowMs: NOW_MS + i * 3_700_000, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
      await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: `op${i}`, nowMs: NOW_MS + i * 3_700_000 });
    }
    const nextWindowClaim = await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "opB0",
      nowMs: WINDOW_B + 1_000, llmRequest: { windowStartMs: WINDOW_B, cap: CAP } });
    assert.equal(nextWindowClaim, true, "a new window's first claim must succeed even though the old window was exhausted");
    const lease = await store.getNewsLease(AGENT, OWNER);
    assert.deepEqual(readCmcLlmRequestsLease(lease), { windowStartMs: WINDOW_B, count: 1 });
  });

  it("restart (a fresh store reading the same snapshot) keeps the count", async () => {
    const store = new MemoryTradeCmcStore(() => NOW_MS);
    await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "op0", nowMs: NOW_MS, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
    await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "op0", nowMs: NOW_MS });
    const snapshot = store.snapshot(AGENT);
    const restored = new MemoryTradeCmcStore(() => NOW_MS);
    restored.restore(snapshot, new Map());
    const lease = await restored.getNewsLease(AGENT, OWNER);
    assert.deepEqual(readCmcLlmRequestsLease(lease), { windowStartMs: WINDOW_A, count: 1 });
  });

  it("a corrupt/legacy lease value reads as {windowStartMs:0,count:0}, never disabling the cap", async () => {
    const store = new MemoryTradeCmcStore(() => NOW_MS);
    // No llmRequests field at all (legacy row).
    await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "legacy", nowMs: NOW_MS });
    await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "legacy", nowMs: NOW_MS });
    const legacyLease = await store.getNewsLease(AGENT, OWNER);
    assert.deepEqual(readCmcLlmRequestsLease(legacyLease), { windowStartMs: 0, count: 0 });
    // A hand-corrupted value (string count, NaN windowStartMs) must fail closed to 0, not unlimited.
    const corrupt = { ...legacyLease, llmRequests: { windowStartMs: Number.NaN, count: "not-a-number" as unknown as number } } as CmcNewsLease;
    assert.deepEqual(readCmcLlmRequestsLease(corrupt), { windowStartMs: 0, count: 0 });
    // AUDIT L-4: a negative stored count (e.g. -1000) must ALSO fail closed to
    // 0 — otherwise `count >= cap` never trips and the only surviving bound is
    // the hourly slot (~24 calls/window instead of 10).
    const negative = { ...legacyLease, llmRequests: { windowStartMs: WINDOW_A, count: -1000 } } as CmcNewsLease;
    assert.deepEqual(readCmcLlmRequestsLease(negative), { windowStartMs: 0, count: 0 });
  });

  it("an unpaid post-claim exit still counts (under-spend direction, R2.4/L4)", async () => {
    const store = new MemoryTradeCmcStore(() => NOW_MS);
    // Claim then immediately finish without any payment progress — models the
    // `authorize`/`challenge_mismatch`/`budget_reservation_refused` exits, all
    // of which claim the slot before failing.
    const claimed = await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "unpaid",
      nowMs: NOW_MS, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
    assert.equal(claimed, true);
    await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "unpaid", nowMs: NOW_MS });
    const lease = await store.getNewsLease(AGENT, OWNER);
    assert.deepEqual(readCmcLlmRequestsLease(lease), { windowStartMs: WINDOW_A, count: 1 }, "the claim alone must count, whether or not payment ever completed");
  });

  it("R3.1: a scheduled claim (no llmRequest) NEVER resets or touches the counter", async () => {
    const store = new MemoryTradeCmcStore(() => NOW_MS);
    await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "llm-1", nowMs: NOW_MS, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
    await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "llm-1", nowMs: NOW_MS });
    // A scheduled claim (macro/sector/scanner/planning) an hour later.
    const scheduledAt = NOW_MS + 3_700_000;
    const scheduledClaimed = await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "scheduled-1", nowMs: scheduledAt });
    assert.equal(scheduledClaimed, true);
    await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "scheduled-1", nowMs: scheduledAt });
    assert.deepEqual(readCmcLlmRequestsLease(await store.getNewsLease(AGENT, OWNER)), { windowStartMs: WINDOW_A, count: 1 }, "the scheduled claim must carry the LLM counter unchanged");
    // A stale-lease reclaim (an expired in-flight operation) also goes through
    // the SAME single lease write — must not touch the counter either.
    const staleClaimed = await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "held",
      nowMs: scheduledAt + 3_700_000 });
    assert.equal(staleClaimed, true);
    // Do not finish "held" — simulate an abandoned in-flight op, then reclaim
    // after BOTH its 310s lease expiry AND the hourly throttle have passed.
    const reclaimAt = scheduledAt + 3_700_000 + 3_700_000;
    const reclaimed = await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "reclaim",
      nowMs: reclaimAt });
    assert.equal(reclaimed, true, "a stale, undisclosed lease must be reclaimable");
    assert.deepEqual(readCmcLlmRequestsLease(await store.getNewsLease(AGENT, OWNER)), { windowStartMs: WINDOW_A, count: 1 }, "the stale-lease reclaim write must also carry the LLM counter unchanged");
  });

  it("per-agent isolation: each agent has its own counter", async () => {
    const store = new MemoryTradeCmcStore(() => NOW_MS);
    const AGENT_B = "llm-request-agent-b";
    for (let i = 0; i < CAP; i += 1) {
      await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: `a${i}`, nowMs: NOW_MS + i * 3_700_000, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
      await store.finishNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: `a${i}`, nowMs: NOW_MS + i * 3_700_000 });
    }
    const bClaimed = await store.claimNewsSlot({ agentId: AGENT_B, ownerAddress: OWNER, operationId: "b0", nowMs: NOW_MS, llmRequest: { windowStartMs: WINDOW_A, cap: CAP } });
    assert.equal(bClaimed, true, "agent B's own counter must start at 0 regardless of agent A's exhausted cap");
  });
});

describe("TRADFI-LLM-CMC-REQUEST §3/R2.5/R2.7: classifyLlmDataRequestTicker", () => {
  it("no-ticker: an empty ticker", () => {
    assert.equal(classifyLlmDataRequestTicker("", "planning", true), "no-ticker");
  });
  it("unmapped: a ticker outside the static pin", () => {
    assert.equal(classifyLlmDataRequestTicker("ZZZZ", "planning", true), "unmapped");
  });
  it("not-stock: a mapped ETF", () => {
    assert.equal(classifyLlmDataRequestTicker("SPY", "planning", true), "not-stock");
  });
  it("ok: the events skill for a mapped stock since the G0 follow-up enabled the event calendar", () => {
    assert.equal(classifyLlmDataRequestTicker("NVDA", "events", true), "ok");
  });
  it("cmc-disabled: dataRequestsEnabled is false", () => {
    assert.equal(classifyLlmDataRequestTicker("NVDA", "planning", false), "cmc-disabled");
  });
  it("ok: a mapped stock ticker, planning skill, enabled", () => {
    assert.equal(classifyLlmDataRequestTicker("nvda", "planning", true), "ok", "must also normalize case");
  });
});

describe("TRADFI-LLM-CMC-REQUEST R2.6/R3.5: the probe script never runs in tests", () => {
  it("parseProbeArgs refuses without --yes-spend-0.01", () => {
    assert.throws(() => parseProbeArgs(["agent-1", "AAPL"]), /--yes-spend-0\.01/u);
  });
  it("parseProbeArgs refuses without both positional arguments", () => {
    assert.throws(() => parseProbeArgs(["--yes-spend-0.01"]), /Usage:/u);
    assert.throws(() => parseProbeArgs(["agent-1", "--yes-spend-0.01"]), /Usage:/u);
  });
  it("parseProbeArgs accepts a well-formed, confirmed call and never touches the network", () => {
    assert.deepEqual(parseProbeArgs(["agent-1", "aapl", "--yes-spend-0.01"]), { agentId: "agent-1", symbol: "AAPL" });
  });
  it("AUDIT L-2: parseProbeArgs refuses a symbol that is not a plain ticker shape (e.g. a path-traversal segment)", () => {
    for (const bad of ["../../etc", "AAPL/../../x", "1AAPL", "TOOLONGTICKERNAME", "AA PL"]) {
      assert.throws(() => parseProbeArgs(["agent-1", bad, "--yes-spend-0.01"]), /must match/u, `expected ${JSON.stringify(bad)} to be refused`);
    }
    assert.deepEqual(parseProbeArgs(["agent-1", "brk.b", "--yes-spend-0.01"]), { agentId: "agent-1", symbol: "BRK.B" });
  });
});

describe("TRADFI-LLM-CMC-REQUEST R3.5/R3.10 L4: refreshProbeOnce is reachable only from the probe script", () => {
  it("no file under src/ or scripts/ other than scripts/live-cmc-probe-skill.ts names refreshProbeOnce", async () => {
    const offenders: string[] = [];
    async function scan(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "tmp") continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { await scan(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        if (full === "scripts/live-cmc-probe-skill.ts") continue;
        // The definition site itself is allowed to name it once (the `export
        // async function refreshProbeOnce` declaration and its own doc comment).
        if (full === "src/trade/cmcNews.ts") continue;
        const text = await readFile(full, "utf8");
        if (text.includes("refreshProbeOnce")) offenders.push(full);
      }
    }
    await scan("src");
    await scan("scripts");
    assert.deepEqual(offenders, [], `refreshProbeOnce must be named only by its definition and the probe script: ${offenders.join(", ")}`);
  });
});
