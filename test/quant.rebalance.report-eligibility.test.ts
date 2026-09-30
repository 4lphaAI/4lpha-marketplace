/** Worker report eligibility: decided from persisted state before the outward call. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";
import { runQuantRebalanceWorkerOnce, type QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import type { QuantRebalanceStore } from "../src/store/quantRebalance.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";

const NOW = 1_800_000_000_000;
const HASH = `0x${"98".repeat(32)}` as Hex;
const WALLET = getAddress(`0x${"65".repeat(20)}`);

function harness(input: {
  readonly listed: Partial<QuantRebalanceJobRow>;
  readonly persisted: Partial<QuantRebalanceJobRow>;
  readonly actions: readonly QuantRebalanceActionRow[];
}) {
  const base = { jobId: "eligibility", strategyId: "eligibility", tradingWallet: WALLET,
    status: "admitted", platformStatus: "ACTIVE", allocationWei: 10n ** 19n, dailyCapWei: 10n ** 19n,
    termDays: 30, startedAtMs: NOW - 100_000, endsAtMs: NOW + 100_000, sessionExpiresAtMs: NOW + 100_000, revokedAtMs: null,
    claimGeneration: 1n, reportAttempts: 0, reportedAtMs: null, rowVersion: 1, createdAtMs: NOW - 100_000,
  } as unknown as QuantRebalanceJobRow;
  const listed = { ...base, ...input.listed } as QuantRebalanceJobRow;
  let persisted = { ...base, ...input.persisted } as QuantRebalanceJobRow;
  const calls = { report: 0, release: 0, attempts: 0 };
  const store = {
    async listWorkableJobs() { return [listed]; },
    async listUnresolvedActions() { return []; },
    async discoverJob() { return listed; },
    async markEnded(end: { readonly unresolved: boolean }) {
      // Models the fenced PG recheck finding an action the caller did not see.
      persisted = { ...persisted, status: end.unresolved ? "ended-unresolved" : persisted.status, rowVersion: persisted.rowVersion + 1 };
    },
    async getJob() { return persisted; },
    async listActions() { return input.actions; },
    async recordReportAttempt() { calls.attempts += 1; return { kind: "inconsistent", code: "action-unresolved" }; },
  } as unknown as QuantRebalanceStore;
  const deps = { store,
    claims: { migrationInstalled: async () => true, releaseTerminal: async () => { calls.release += 1; return false; } },
    strategyId: listed.strategyId, agentId: "offline", nowMs: () => NOW, intervalMs: 60_000,
    transport: {
      async inbox() { return { ok: true, data: { items: [], nextCursor: null } }; },
      async job() { return { ok: true, data: { id: listed.jobId, strategyId: listed.strategyId,
        tradingWalletAddress: WALLET, allocationUWei: listed.allocationWei, dailyCapUWei: listed.dailyCapWei,
        termDays: listed.termDays, startedAtMs: listed.startedAtMs, endsAtMs: listed.endsAtMs,
        sessionExpiresAtMs: listed.sessionExpiresAtMs, revokedAtMs: null, status: "ACTIVE" } }; },
    },
    async reportJob() { calls.report += 1; return { ok: true, payloadDigest: HASH, responseStatus: 200, notesApplied: 1 }; },
  } as unknown as QuantRebalanceWorkerDeps;
  return { deps, calls };
}

const settled = { actionId: "settled", jobId: "eligibility", state: "settled", side: "buy", asset: "WBNB", txHash: HASH } as QuantRebalanceActionRow;
const intended = { actionId: "late", jobId: "eligibility", state: "intended" } as QuantRebalanceActionRow;

test("term end: a fenced ended-unresolved result neither releases the claim nor reports", async () => {
  const { deps, calls } = harness({ listed: { endsAtMs: NOW - 1 }, persisted: { status: "ended-unresolved" }, actions: [settled, intended] });
  await runQuantRebalanceWorkerOnce(deps);
  assert.deepEqual(calls, { report: 0, release: 0, attempts: 0 });
});

test("ended retry: a stale ended row is re-read before the outward call", async () => {
  const { deps, calls } = harness({ listed: { status: "ended" }, persisted: { status: "ended-unresolved" }, actions: [settled] });
  await runQuantRebalanceWorkerOnce(deps);
  assert.deepEqual(calls, { report: 0, release: 0, attempts: 0 });
});

test("ended retry: any non-definitive action refuses the report even when the row reads ended", async () => {
  const { deps, calls } = harness({ listed: { status: "ended" }, persisted: { status: "ended" }, actions: [settled, intended] });
  await runQuantRebalanceWorkerOnce(deps);
  assert.deepEqual(calls, { report: 0, release: 0, attempts: 0 });
});

test("ended retry: all actions definitive sends the one final report", async () => {
  const { deps, calls } = harness({ listed: { status: "ended" }, persisted: { status: "ended" }, actions: [settled] });
  await runQuantRebalanceWorkerOnce(deps);
  assert.equal(calls.report, 1);
  assert.equal(calls.attempts, 1);
});

test("ended-unresolved retry: a fenced end that stays unresolved neither releases the claim nor reports", async () => {
  const { deps, calls } = harness({ listed: { status: "ended-unresolved" }, persisted: { status: "ended-unresolved" }, actions: [settled, intended] });
  await runQuantRebalanceWorkerOnce(deps);
  assert.deepEqual(calls, { report: 0, release: 0, attempts: 0 });
});
