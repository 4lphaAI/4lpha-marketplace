/** Independent FIX3 clock boundaries; all reads and pricing are offline seams. */
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import { previewG2Worker } from "../scripts/live-quant-rebalance.js";
import { loadG2FileProfiles } from "../src/quant/rebalanceSelftest.js";
import { E18, REBALANCE_USDC, REBALANCE_WBNB, rebalanceJobPolicyDigest, rebalanceTierForProfile } from "../src/quant/rebalancePolicy.js";
import { runQuantRebalanceWorkerOnce, type QuantRebalanceWorkerDeps, type RebalancePortfolioObservation } from "../src/quant/rebalanceWorker.js";
import type { QuantRebalanceJobRow, QuantRebalanceCheckRow } from "../src/quant/rebalanceTypes.js";
import type { QuantRebalanceStore } from "../src/store/quantRebalance.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import { encodeJsonbParam } from "../src/store/codec.js";

const START = 1_900_000_000_000;
const READ_DONE = START + 1_879;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const WALLET = getAddress("0x1000000000000000000000000000000000000001");
const PAIR = getAddress("0x2000000000000000000000000000000000000001");

function fixture(markAtMs: number) {
  const profile = loadG2FileProfiles().capability;
  const selected = rebalanceTierForProfile(10n * E18, profile.id);
  assert.equal(selected.ok, true);
  if (!selected.ok) throw new Error("audit-tier-unavailable");
  const tier = selected.tier;
  // The read crosses into slot 2; this decision must retain slot 1.
  const startedAtMs = START - 2 * tier.intervalMs + 1;
  const endsAtMs = START + 2 * 86_400_000;
  const managed = { USDC: 5n * E18, WBNB: E18, ETH: 0n, CAKE: 0n };
  const wire: QuantJobRecord = { id: "audit-fix3", strategyId: "self-test-rebalance-g2", status: "ACTIVE",
    tradingWalletAddress: WALLET, allocationUWei: 10n * E18, dailyCapUWei: 20n * E18,
    termDays: 2, startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs, revokedAtMs: null };
  // Only admitted read/plan branches are reachable; pricing returns a hold before insertion.
  const job = { jobId: wire.id, strategyId: wire.strategyId, tradingWallet: WALLET,
    allocationWei: wire.allocationUWei, startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs,
    revokedAtMs: null, status: "admitted", managed, claimGeneration: 1n, accountingRev: 1n,
    policyDigest: rebalanceJobPolicyDigest({ capabilityProfileId: profile.id, jobId: wire.id,
      strategyId: wire.strategyId, allocationWei: wire.allocationUWei, tier,
      startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs }),
    protectedBaselineJson: encodeJsonbParam({ USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }),
    nextEligibleSlot: 1, bootstrapComplete: true, holdCode: null, createdAtMs: startedAtMs,
  } as QuantRebalanceJobRow;
  const observation: RebalancePortfolioObservation = {
    blockNumber: 100n, blockHash: HASH, observedAtMs: START,
    actualBalances: { ...managed, USDT: 0n }, values: { ...managed, WBNB: 4n * E18 },
    marks: [{ asset: "WBNB", quantityWei: E18, usdcOutWei: 4n * E18,
      path: [REBALANCE_WBNB, REBALANCE_USDC], blockNumber: 100n, blockHash: HASH,
      observedAtMs: markAtMs, pairAddresses: [PAIR], referenceEvidenceDigest: HASH }],
    nativeBalanceWei: E18, gasPriceWei: 50_000_000n,
  };
  let clock = START;
  const reads: number[] = [];
  const checks: { slot: number; nowMs: number }[] = [];
  const prices: { slot: number; nowMs: number }[] = [];
  const store = {
    async listWorkableJobs() { return [job]; },
    async discoverJob() { return job; },
    async listUnresolvedActions() { return []; },
    async listChecks() { return []; },
    async beginCheck(input: Parameters<QuantRebalanceStore["beginCheck"]>[0]) {
      checks.push({ slot: input.slot, nowMs: input.nowMs });
      const record: QuantRebalanceCheckRow = { checkId: "audit-check", jobId: job.jobId,
        kind: input.kind, slot: input.slot, state: input.state, evidenceJson: null,
        takenAssets: [], rowVersion: 1, createdAtMs: input.nowMs, updatedAtMs: input.nowMs };
      return { kind: "ok" as const, record };
    },
  };
  const deps = {
    store, claims: { async migrationInstalled() { return true; } },
    transport: { async inbox() { return { ok: true, data: { items: [], nextCursor: null } }; },
      async job() { return { ok: true, data: wire }; } },
    strategyId: job.strategyId, capabilityProfile: profile, nowMs: () => clock,
    async readPortfolio(input: Parameters<QuantRebalanceWorkerDeps["readPortfolio"]>[0]) {
      reads.push(input.nowMs);
      await Promise.resolve();
      clock = READ_DONE;
      return { ok: true as const, observation };
    },
    async priceLeg(input: Parameters<QuantRebalanceWorkerDeps["priceLeg"]>[0]) {
      prices.push({ slot: input.check.slot, nowMs: input.nowMs });
      return { hold: "audit-pricing-reached" };
    },
  } as unknown as QuantRebalanceWorkerDeps;
  return { deps, job, reads, checks, prices };
}

for (const sample of [
  { name: "mark after cycle start", age: 0, accepted: true },
  { name: "exactly 30 seconds old", age: 30_000, accepted: true },
  { name: "30 seconds plus one millisecond old", age: 30_001, accepted: false },
  { name: "one millisecond in the future", age: -1, accepted: false },
]) {
  test(`audit FIX3 worker: ${sample.name}; slot stays at cycle start`, async () => {
    const f = fixture(READ_DONE - sample.age);
    const result = await runQuantRebalanceWorkerOnce(f.deps);
    assert.equal(result.errors, 0);
    assert.equal(result.actions, 0);
    assert.deepEqual(f.reads, [START]);
    assert.deepEqual(result.notes, [`audit-fix3:${sample.accepted ? "audit-pricing-reached" : "portfolio-mark-mismatch"}`]);
    assert.deepEqual(f.checks, sample.accepted ? [{ slot: 1, nowMs: START }] : []);
    assert.deepEqual(f.prices, sample.accepted ? [{ slot: 1, nowMs: READ_DONE }] : []);
  });

  test(`audit FIX3 preview: ${sample.name}; pricing uses valuation time`, async () => {
    const f = fixture(READ_DONE - sample.age);
    const result = await previewG2Worker({ jobId: f.job.jobId, job: f.job, actions: [], allocation: 10,
      deps: f.deps, listChecks: async () => [], nowMs: START });
    assert.equal(result["phase"], "scheduled-check");
    assert.deepEqual(result["plan"], sample.accepted ? { kind: "hold", reason: "audit-pricing-reached" } : null);
    assert.deepEqual(f.reads, [START]);
    assert.deepEqual(f.checks, []);
    assert.deepEqual(f.prices, sample.accepted ? [{ slot: 1, nowMs: READ_DONE }] : []);
  });
}
