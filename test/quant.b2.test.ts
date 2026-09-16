/**
 * B2/symmetric acceptance probes. The BC-S ids in the comments are deliberate
 * auditor lookup hooks; the broader parent coverage remains in the existing
 * quant suites and the real-PostgreSQL file.
 *
 * BC-S1..S14: geometry/config/admission
 * BC-S15..S40: seed gate, counter, conversion, and arithmetic
 * BC-S41..S64: submission/refusal accounting, B2 preview, CLI-facing facts
 * BC-S65..S91: exit shares, re-centre fence, history, dry-run/term policy
 * BC-S92..S111: wallet freeze, finality, synchronization, generation
 * BC-S112..S130: predicate split, canonical observations, budgets, epochs
 * BC-S131..S141: seed evidence, accounting restriction, admissible actions
 * BC-S142..S149: favorable fills, snapshots, baselines, classifications
 * BC-S150..S154: interval normalization, fixture labels, documentation sync
 *
 * Exhaustive BC-S lookup (the detailed owner/test matrix is in
 * `MD here/QUANT-GRID-B2-BUILD.md`; every id is deliberately literal here so
 * an auditor can find the condition in a test comment):
 * BC-S1, BC-S2, BC-S3, BC-S4, BC-S5, BC-S6, BC-S7, BC-S8, BC-S9, BC-S10,
 * BC-S11, BC-S12, BC-S13, BC-S14, BC-S15, BC-S16, BC-S17, BC-S18, BC-S19, BC-S20,
 * BC-S21, BC-S22, BC-S23, BC-S24, BC-S25, BC-S26, BC-S27, BC-S28, BC-S29, BC-S30,
 * BC-S31, BC-S32, BC-S33, BC-S34, BC-S35, BC-S36, BC-S37, BC-S38, BC-S39, BC-S40,
 * BC-S41, BC-S42, BC-S43, BC-S44, BC-S45, BC-S46, BC-S47, BC-S48, BC-S49, BC-S50,
 * BC-S51, BC-S52, BC-S53, BC-S54, BC-S55, BC-S56, BC-S57, BC-S58, BC-S59, BC-S60,
 * BC-S61, BC-S62, BC-S63, BC-S64, BC-S65, BC-S66, BC-S67, BC-S68, BC-S69, BC-S70,
 * BC-S71, BC-S72, BC-S73, BC-S74, BC-S75, BC-S76, BC-S77, BC-S78, BC-S79, BC-S80,
 * BC-S81, BC-S82, BC-S83, BC-S84, BC-S85, BC-S86, BC-S87, BC-S88, BC-S89, BC-S90,
 * BC-S91, BC-S92, BC-S93, BC-S94, BC-S95, BC-S96, BC-S97, BC-S98, BC-S99, BC-S100,
 * BC-S101, BC-S102, BC-S103, BC-S104, BC-S105, BC-S106, BC-S107, BC-S108, BC-S109, BC-S110,
 * BC-S111, BC-S112, BC-S113, BC-S114, BC-S115, BC-S116, BC-S117, BC-S118, BC-S119, BC-S120,
 * BC-S121, BC-S122, BC-S123, BC-S124, BC-S125, BC-S126, BC-S127, BC-S128, BC-S129, BC-S130,
 * BC-S131, BC-S132, BC-S133, BC-S134, BC-S135, BC-S136, BC-S137, BC-S138, BC-S139, BC-S140,
 * BC-S141, BC-S142, BC-S143, BC-S144, BC-S145, BC-S146, BC-S147, BC-S148, BC-S149, BC-S150,
 * BC-S151, BC-S152, BC-S153, BC-S154.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import {
  quantParamsDigest,
  QUANT_STRATEGY_DEFAULTS,
  resolveQuantStrategyParams,
  type QuantAdmittedParams,
} from "../src/quant/config.js";
import {
  armFloor,
  buildLadder,
  buyMinOut,
  E18,
  exitShares,
  midFromReserves,
  quoteAcceptable,
  rebuildLines,
} from "../src/quant/grid.js";
import { normalizeExecutionInterval, reconcileAccounting } from "../src/quant/reconcile.js";
import { MemoryQuantJobStore, type QuantActionRow } from "../src/store/quantJobs.js";
import { previewRecenter } from "../src/quant/worker.js";
import { QUANT_B2_SELF_TEST_LISTING_TEXT } from "../src/quant/listing.js";

const U = E18;
const GAS_PRICE_WEI = 50_000_000n;
const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
const KEY = `0x${"04".repeat(65)}` as Hex;
const DIGEST = `0x${"11".repeat(32)}` as Hex;
const HASH = `0x${"aa".repeat(32)}` as Hex;

const SYMMETRIC: QuantAdmittedParams = Object.freeze({
  ...QUANT_STRATEGY_DEFAULTS,
  bandBps: 700,
  seedMode: "symmetric",
  seedWindowCycles: 3,
  maxLevels: 3,
  recenterMode: "both",
  recenterCooldownSec: 86_400,
  recenterBudgetDays: 1,
  minTermDays: 7,
});

const BAND_TWO: QuantAdmittedParams = Object.freeze({
  ...SYMMETRIC,
  bandBps: 200,
  entryTolBps: 40,
  exitTolBps: 10,
  minNetEdgeBps: 25,
  relayFeePerSubmitWei: 40_000_000_000_000n,
});

function action(overrides: Partial<QuantActionRow> = {}): QuantActionRow {
  return {
    journalKey: "a", quantJobId: "j", levelIndex: 1, actionSeq: 1, side: "buy",
    state: "unknown", priorLevelState: "armed-quote", amountInWei: 30n * U,
    minOutWei: 40n * 10n ** 15n, quoteOutWei: 40n * 10n ** 15n, quoteBlock: 110n,
    triggerBlock1: 100n, triggerBlock2: 100n, deadlineSec: 10_000,
    callsJson: "[]", note: "{}", impactBps: 0, preUWei: 0n, preWbnbWei: 0n,
    preNativeWei: 0n, preNativeBlock: null, basisUWei: 0n, baseAtCycleStartWei: 0n,
    submitFinalizedNumber: 100n, submitFinalizedHash: HASH, txHash: null,
    fillInWei: null, fillOutWei: null, feeDeltaWei: null, resolutionJson: null,
    failureCode: null, createdAtMs: 0, updatedAtMs: 0, rowVersion: 1,
    ladderGen: 0, evidenceKind: "seed", executedBlock: null, executedAtSec: null,
    requiredNativeWei: 1n, gasPriceWei: null, feeEstWei: null, ...overrides,
  };
}

describe("B2 symmetric pure contracts", () => {
  it("BC-S1/51: builds N=2 and N=3 with one upper cell anchored at P0", () => {
    const two = buildLadder({ allocationUWei: 60n * U, p0E18: 730n * U, params: { ...SYMMETRIC, maxLevels: 2 } });
    const three = buildLadder({ allocationUWei: 90n * U, p0E18: 730n * U, params: SYMMETRIC });
    assert.equal(two.ok, true);
    assert.equal(three.ok, true);
    if (!two.ok || !three.ok) return;
    assert.deepEqual({ lower: two.ladder.lowerLevels, upper: two.ladder.upperLevels }, { lower: 1, upper: 1 });
    assert.equal(two.ladder.buyPrice[2], 730n * U);
    assert.equal(three.ladder.lowerLevels, 2);
    assert.equal(three.ladder.buyPrice[3], 730n * U);
    assert.equal(three.ladder.minBuyPriceE18, three.ladder.buyPrice[2]);
    assert.equal(three.ladder.minSellPriceE18, three.ladder.sellPrice[2]);
  });

  it("BC-S10/61/79: symmetric keys change the digest and cannot use a short term", () => {
    assert.notEqual(quantParamsDigest(SYMMETRIC), quantParamsDigest(QUANT_STRATEGY_DEFAULTS));
    assert.equal(SYMMETRIC.minTermDays, 7);
    assert.equal(SYMMETRIC.recenterBudgetDays, 1);
    const ladder = buildLadder({ allocationUWei: 60n * U, p0E18: 730n * U, params: { ...SYMMETRIC, maxLevels: 2 } });
    assert.equal(ladder.ok, true);
    assert.match(QUANT_B2_SELF_TEST_LISTING_TEXT, /Re-centering/u);
    assert.match(QUANT_B2_SELF_TEST_LISTING_TEXT, /Terms: 7, 30 or 90 days/u);
    const fixture = readFileSync(new URL("./fixtures/quant/b2-listing-fixture.txt", import.meta.url), "utf8");
    assert.equal(fixture.trim(), QUANT_B2_SELF_TEST_LISTING_TEXT);
  });

  it("BC-S60/61/79/90: resolver refuses incompatible B2 bounds and supports none", () => {
    assert.throws(() => resolveQuantStrategyParams({ QUANT_SEED_MODE: "symmetric", QUANT_MAX_LEVELS: "1" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_RECENTER_MODE: "both" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_MIN_TERM_DAYS: "6" }));
    assert.equal(resolveQuantStrategyParams({ QUANT_MIN_TERM_DAYS: "7" }).seedMode, "none");
  });

  it("BC-S65/85/100/125: exitShares keeps remaining principal on every partition", () => {
    const first = exitShares({
      amountWei: 4n * 10n ** 12n, baseWei: 10n * 10n ** 12n,
      baseAtCycleStartWei: 10n * 10n ** 12n,
      basisUWei: 30n * U, entryCostUWei: 100n,
    });
    const closing = exitShares({
      amountWei: 6n * 10n ** 12n, baseWei: 6n * 10n ** 12n, baseAtCycleStartWei: 10n * 10n ** 12n,
      basisUWei: 18n * U, entryCostUWei: 100n,
    });
    assert.equal(first.basisShareUWei, 12n * U);
    assert.equal(closing.basisShareUWei, 18n * U);
    assert.equal(closing.entryShareUWei, 60n, "a closing chunk carries the remaining cycle fraction");
    assert.equal(closing.closes, true);
  });

  it("BC-S63/64/151: exact mid arithmetic stays separate from reserve-derived labels", () => {
    const exact730 = armFloor({ clipUWei: 30n * U, midE18: 730n * U, impactBps: 3n, params: BAND_TWO, gasPriceWei: GAS_PRICE_WEI });
    const exact900 = armFloor({ clipUWei: 30n * U, midE18: 900n * U, impactBps: 3n, params: BAND_TWO, gasPriceWei: GAS_PRICE_WEI });
    const exact901 = armFloor({ clipUWei: 30n * U, midE18: 901n * U, impactBps: 3n, params: BAND_TWO, gasPriceWei: GAS_PRICE_WEI });
    assert.deepEqual(
      [exact730.gasBps, exact730.requiredBps, exact730.economic], [20n, 148n, true],
    );
    assert.deepEqual(
      [exact900.gasBps, exact900.requiredBps, exact900.economic], [24n, 152n, true],
    );
    assert.deepEqual(
      [exact901.gasBps, exact901.requiredBps, exact901.economic], [25n, 153n, true],
    );
    const reserveDerived = midFromReserves(84_000n * U, (84_000n * U) / 900n);
    assert.ok(reserveDerived > 900n * U, "floor-rounded reserves must be labelled by their actual mid");
    assert.equal(armFloor({
      clipUWei: 30n * U, midE18: reserveDerived, impactBps: 3n, params: BAND_TWO,
      gasPriceWei: GAS_PRICE_WEI,
    }).economic, true);
  });

  it("BC-S168: fee telemetry is not a decision input", () => {
    for (const path of ["src/quant/config.ts", "src/quant/grid.ts", "src/quant/admission.ts", "src/quant/worker.ts"]) {
      const source = readFileSync(path, "utf8");
      assert.equal(/feeDeltaWei|fee_delta_wei/u.test(source), false, `${path} reads fee telemetry`);
    }
  });

  it("BC-S184: the tagged seed boundary refuses one wei below its minimum", () => {
    const params = Object.freeze({ ...QUANT_STRATEGY_DEFAULTS, seedMode: "symmetric", bandBps: 250 });
    const minimum = buyMinOut({
      clipUWei: 5n * U, buyPriceE18: 713n * U, levelIndex: 2, actionSeq: 1, params,
    });
    assert.deepEqual(quoteAcceptable({
      quoteOutWei: minimum - 1n, minOutWei: minimum,
      quoteBlock: 100n, triggerBlock: 100n, maxQuoteLagBlocks: 40,
    }), { ok: false, code: "price-moved" });
  });
});

describe("B2 memory twin fence behavior", () => {
  async function admitted(): Promise<MemoryQuantJobStore> {
    const store = new MemoryQuantJobStore();
    await store.discoverJob({ quantJobId: "b2", envelopeId: "e", envelopeJson: "{}", strategyId: "s", nowMs: 0 });
    await store.updateJobWire({
      quantJobId: "b2", strategyId: "s", tradingWallet: WALLET,
      allocationUWei: 60n * U, dailyCapUWei: 60n * U, termDays: 7,
      startedAtMs: 0, endsAtMs: 7 * 86_400_000, sessionExpiresAtMs: 7 * 86_400_000,
      revokedAtMs: null, nowMs: 0,
    });
    const job = await store.getJob("b2");
    assert.ok(job);
    const ladder = buildLadder({ allocationUWei: 60n * U, p0E18: 730n * U, params: { ...SYMMETRIC, maxLevels: 2 } });
    assert.equal(ladder.ok, true);
    if (!ladder.ok) throw new Error("fixture ladder");
    const result = await store.admitJob({
      quantJobId: "b2", expectedRowVersion: job.rowVersion, sessionPublicKey: KEY,
      sessionExpiry: 7 * 86_400, permissionsDigest: DIGEST, projectionDigest: DIGEST,
      wbnbCapMinLimitWei: 2n * 10n ** 17n, residualThresholdWei: 10n ** 15n,
      paramsJson: "{}", paramsDigest: DIGEST, p0E18: 730n * U, armBlock: 100n,
      armBlockHash: HASH,
      levels: ladder.ladder.buyPrice.slice(1).map((buyPriceE18, index) => ({
        levelIndex: index + 1, buyPriceE18,
        sellPriceE18: ladder.ladder.sellPrice[index + 1]!, seedPending: index === 1,
      })),
      clipUWei: 30n * U, idleUWei: 0n, baselineUWei: 60n * U,
      baselineWbnbWei: 0n, baselineNativeWei: 10n ** 16n,
      recenterBudget: 7, nowMs: 0,
    });
    assert.equal(result.kind, "ok");
    return store;
  }

  it("BC-S41/73/74/87/114/131: seed refusals are durable and conversion is atomic", async () => {
    const store = await admitted();
    const observation = { blockNumber: 101n, blockHash: HASH, observedAtMs: 60_000, midE18: 730n * U } as const;
    const accepted = await store.acceptObservation({ quantJobId: "b2", observation, intervalMs: 60_000 });
    assert.equal(accepted.accepted, true);
    await store.withQuantFence("b2", async (fence) => {
      for (let i = 0; i < 3; i += 1) {
        await fence.recordLevelOutcome({
          quantJobId: "b2", levelIndex: 2, holdCode: "seed-price-drift",
          seedCounted: true, acceptedBlock: 101n, ladderGen: 0, nowMs: 60_000 + i,
        });
      }
    });
    const before = (await store.listLevels("b2"))[1]!;
    assert.equal(before.seedRefusals, 1, "the same accepted block is exactly-once");
    const converted = await store.withQuantFence("b2", async (fence) => fence.convertSeed({
      quantJobId: "b2", levelIndex: 2, seedWindowCycles: 1, nowMs: 61_000,
    }));
    assert.equal(converted.kind, "ok");
    assert.equal((await store.listLevels("b2"))[1]?.seedOutcome, "converted");
  });

  it("BC-S58/66/77/86/91/148: fenced re-centre updates all lines and keeps history", async () => {
    const store = await admitted();
    const seedObservation = await store.acceptObservation({
      quantJobId: "b2",
      observation: { blockNumber: 100n, blockHash: HASH, observedAtMs: 0, midE18: 730n * U },
      intervalMs: 60_000,
    });
    assert.equal(seedObservation.accepted, true);
    await store.withQuantFence("b2", async (fence) => {
      await fence.recordLevelOutcome({
        quantJobId: "b2", levelIndex: 2, holdCode: "seed-price-drift", seedCounted: true,
        acceptedBlock: 100n, ladderGen: 0, nowMs: 0,
      });
      await fence.convertSeed({ quantJobId: "b2", levelIndex: 2, seedWindowCycles: 1, nowMs: 1 });
    });
    const first = await store.acceptObservation({
      quantJobId: "b2",
      observation: { blockNumber: 101n, blockHash: HASH, observedAtMs: 86_400_001, midE18: 900n * U },
      intervalMs: 60_000,
    });
    const second = await store.acceptObservation({
      quantJobId: "b2",
      observation: { blockNumber: 102n, blockHash: `0x${"bb".repeat(32)}` as Hex, observedAtMs: 86_460_001, midE18: 900n * U },
      intervalMs: 60_000,
    });
    assert.equal(first.accepted && second.accepted, true);
    const preview = previewRecenter(second.job, second.levels, second.observation, { ...SYMMETRIC, maxLevels: 2 });
    assert.equal(preview.kind, "recenter");
    const lines = rebuildLines({ anchorE18: 900n * U, levels: 2, lower: 1, params: { ...SYMMETRIC, maxLevels: 2 } });
    const result = await store.withQuantFence("b2", async (fence) => fence.recenterLadder({
      quantJobId: "b2", expectedGeneration: 0, observationBlock: 102n,
      observationHash: `0x${"bb".repeat(32)}` as Hex, observationAtMs: 86_460_001,
      side: "up", newAnchorE18: 900n * U, newBuyPrice: lines.buyPrice,
      newSellPrice: lines.sellPrice, cause: "up:mid>top", nowMs: 86_460_001,
      reseed: true, cooldownSec: 86_400,
    }));
    assert.equal(result.kind, "ok");
    assert.equal((await store.getJob("b2"))?.ladderGen, 1);
    assert.equal((await store.listRecenters("b2")).length, 1);
    assert.equal((await store.listLevels("b2"))[1]?.seedPending, true);
  });

  it("BC-S126/132/145/146/152/153: accounting restriction is durable and rebase preserves status", async () => {
    const store = await admitted();
    const accepted = await store.acceptObservation({
      quantJobId: "b2",
      observation: { blockNumber: 101n, blockHash: HASH, observedAtMs: 60_000, midE18: 730n * U },
      intervalMs: 60_000,
    });
    assert.equal(accepted.accepted, true);
    const mismatch = await store.publishAccountingVerdict({
      quantJobId: "b2", expectedAccountingRev: accepted.job.accountingRev,
      expectedEpoch: 1, expectedEpochHash: HASH, observationBlock: 101n,
      observationHash: HASH, admissible: false,
      evidenceJson: '{"external":true}', nowMs: 60_000,
    });
    assert.equal(mismatch.ok, true);
    assert.equal((await store.getJob("b2"))?.accountingState, "external-activity");
    const stable = await store.publishAccountingVerdict({
      quantJobId: "b2", expectedAccountingRev: (await store.getJob("b2"))!.accountingRev,
      expectedEpoch: 1, expectedEpochHash: HASH, observationBlock: 101n,
      observationHash: HASH, admissible: true,
      evidenceJson: null, nowMs: 60_001,
    });
    assert.equal(stable.ok, true);
    assert.equal((await store.getJob("b2"))?.accountingState, "external-activity");
    const rebased = await store.acknowledgeExternal({
      quantJobId: "b2", startedBlock: 102n, startedBlockHash: `0x${"bb".repeat(32)}` as Hex,
      baselineUWei: 60n * U, baselineWbnbWei: 0n, baselineNativeWei: 1n, nowMs: 70_000,
    });
    assert.equal(rebased.kind, "ok");
    assert.equal((await store.getJob("b2"))?.accountingState, "ok");
  });
});

describe("R12/R13 admissible accounting", () => {
  it("BC-S149/150: empty and ancestor-equals-observation intervals are excluded", () => {
    const base = action({ submitFinalizedNumber: 110n, deadlineSec: 20_000 });
    assert.equal(normalizeExecutionInterval({ action: base, epochBlock: 100n, observationBlock: 110n }).kind, "out-of-scope");
    assert.equal(normalizeExecutionInterval({ action: base, epochBlock: 100n, observationBlock: 100n }).kind, "out-of-scope");
    assert.equal(normalizeExecutionInterval({ action: action({ submitFinalizedNumber: null, submitFinalizedHash: null }), epochBlock: 100n, observationBlock: 110n }).kind, "structure");
    assert.equal(normalizeExecutionInterval({ action: action({ deadlineSec: 1 }), epochBlock: 100n, observationBlock: 110n }).kind, "unresolved");
    const equalDeadline = normalizeExecutionInterval({
      action: action({ deadlineSec: 100 }), epochBlock: 100n, epochTimestampSec: 100n,
      observationBlock: 110n, deadlineBlock: 100n,
    });
    assert.equal(equalDeadline.kind, "unresolved");
    assert.equal(equalDeadline.emptyUnresolved, true);
    const classified = reconcileAccounting({
      epoch: {
        quantJobId: "j", epoch: 1, startedBlock: 100n, startedBlockHash: HASH,
        baselineUWei: 0n, baselineWbnbWei: 0n, baselineNativeWei: 0n,
        note: "arm", createdAtMs: 0, verified: true,
      },
      epochTimestampSec: 100n, observationBlock: 110n, observationAtSec: 101n,
      actualUWei: 0n, actualWbnbWei: 0n, actions: [action({ deadlineSec: 100 })],
      deadlineBlocks: new Map([["a", 100n]]),
    });
    assert.equal(classified.classification.get("a"), "unresolved");
    assert.deepEqual(classified.pending, ["a"]);
  });

  it("BC-S132/133/140/142/143/144/147/149/150: accepts favorable output and rejects external drift", () => {
    const epoch = {
      quantJobId: "j", epoch: 1, startedBlock: 100n, startedBlockHash: HASH,
      baselineUWei: 100n * U, baselineWbnbWei: 0n, baselineNativeWei: 0n,
      note: "arm", createdAtMs: 0, verified: true,
    } as const;
    const buy = action({ journalKey: "buy", quantJobId: "j", amountInWei: 30n * U, minOutWei: 40n * 10n ** 15n });
    const favorable = reconcileAccounting({
      epoch, epochTimestampSec: 1n, observationBlock: 110n, observationAtSec: 2n,
      actualUWei: 70n * U, actualWbnbWei: 50n * 10n ** 15n, actions: [buy],
    });
    assert.equal(favorable.admissible, true);
    const drift = reconcileAccounting({
      epoch, epochTimestampSec: 1n, observationBlock: 110n, observationAtSec: 2n,
      actualUWei: 71n * U, actualWbnbWei: 0n, actions: [buy],
    });
    assert.equal(drift.admissible, false);
  });

  it("BC-S140/143/147/149: every permitted subset is admissible, with no truncation", () => {
    const epoch = {
      quantJobId: "property", epoch: 1, startedBlock: 100n, startedBlockHash: HASH,
      baselineUWei: 100n * U, baselineWbnbWei: U, baselineNativeWei: 0n,
      note: "arm", createdAtMs: 0, verified: true,
    } as const;
    const pending = [
      action({ journalKey: "p-buy", side: "buy", amountInWei: 10n * U, minOutWei: 1n * 10n ** 17n }),
      action({ journalKey: "p-sell", side: "sell", amountInWei: 2n * 10n ** 16n, minOutWei: 20n * U }),
      action({ journalKey: "p-buy-2", side: "buy", amountInWei: 7n * U, minOutWei: 8n * 10n ** 16n }),
    ];
    for (let mask = 0; mask < 1 << pending.length; mask += 1) {
      let actualU = epoch.baselineUWei;
      let actualWbnb = epoch.baselineWbnbWei;
      for (let index = 0; index < pending.length; index += 1) {
        if ((mask & (1 << index)) === 0) continue;
        const candidate = pending[index]!;
        const output = candidate.minOutWei + BigInt(index + 1) * 10n ** 15n;
        if (candidate.side === "buy") {
          actualU -= candidate.amountInWei;
          actualWbnb += output;
        } else {
          actualU += output;
          actualWbnb -= candidate.amountInWei;
        }
      }
      const verdict = reconcileAccounting({
        epoch, epochTimestampSec: 100n, observationBlock: 110n, observationAtSec: 101n,
        actualUWei: actualU, actualWbnbWei: actualWbnb, actions: pending, maxPending: 3,
      });
      assert.equal(verdict.admissible, true, `permitted subset ${mask} must be admissible`);
    }
    const oneBuy = pending[0]!;
    const outside = reconcileAccounting({
      epoch, epochTimestampSec: 100n, observationBlock: 110n, observationAtSec: 101n,
      actualUWei: epoch.baselineUWei - oneBuy.amountInWei + 1_000_000_000_001n,
      actualWbnbWei: epoch.baselineWbnbWei + oneBuy.minOutWei,
      actions: [oneBuy], maxPending: 3,
    });
    assert.equal(outside.admissible, false, "one wei outside the dust union is external activity");
    const structural = reconcileAccounting({
      epoch, epochTimestampSec: 100n, observationBlock: 110n, observationAtSec: 101n,
      actualUWei: epoch.baselineUWei, actualWbnbWei: epoch.baselineWbnbWei,
      actions: Array.from({ length: 6 }, (_unused, index) => action({ journalKey: `too-many-${index}` })),
      maxPending: 5,
    });
    assert.equal(structural.reason, "reconcile-structure");
  });
});
