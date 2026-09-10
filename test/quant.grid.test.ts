/**
 * The pure grid: geometry, triggers, executable-price guards, the cost floor,
 * the exit partition and the native reservation (QUANT-GRID W5, §9, BC30, BC25).
 *
 * Everything here is integer arithmetic with no clock and no chain, so a
 * property that holds is a property of the SHIPPED code rather than of a
 * fixture that happens to agree with it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { QUANT_STRATEGY_DEFAULTS, type QuantStrategyParams } from "../src/quant/config.js";
import {
  actionDeadlineSec,
  actionTag,
  advanceTrigger,
  armFloor,
  BPS,
  buildLadder,
  buyMinOut,
  ceilDiv,
  DUST_WEI,
  E18,
  economicMinSellWei,
  feeEst,
  feeEstInU,
  levelTriggerSide,
  midFromReserves,
  partitionExit,
  quantPriceImpactBps,
  quoteAcceptable,
  requiredNativeWei,
  sellFloor,
  tagMinOut,
  triggerArmed,
} from "../src/quant/grid.js";
import { priceImpactBps } from "../src/trade/route.js";

const U = 10n ** 18n;
const PARAMS: QuantStrategyParams = QUANT_STRATEGY_DEFAULTS;

/** The measured pool (memory `termix-quant-u-liquidity`): 113.57 WBNB / 84,140 U. */
const RESERVE_WBNB = 113_570_000_000_000_000_000n;
const RESERVE_U = 84_140n * U;

describe("quant geometry", () => {
  it("prices from the pair's own reserves, floored", () => {
    const mid = midFromReserves(RESERVE_U, RESERVE_WBNB);
    assert.equal(mid, (RESERVE_U * E18) / RESERVE_WBNB);
    // ~740 U per WBNB, which is the measured price.
    assert.ok(mid > 740n * E18 && mid < 742n * E18, `${mid}`);
  });

  it("refuses a pair with a zero reserve rather than dividing by it", () => {
    assert.throws(() => midFromReserves(0n, RESERVE_WBNB));
    assert.throws(() => midFromReserves(RESERVE_U, 0n));
  });

  it("10 U is ONE level with a 10 U clip and no idle remainder", () => {
    const result = buildLadder({ allocationUWei: 10n * U, p0E18: 740n * E18, params: PARAMS });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.ladder.levels, 1);
    assert.equal(result.ladder.clipUWei, 10n * U);
    assert.equal(result.ladder.idleUWei, 0n);
  });

  it("35 U is THREE levels of 11 U with 2 U idle", () => {
    const result = buildLadder({ allocationUWei: 35n * U, p0E18: 740n * E18, params: PARAMS });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.ladder.levels, 3);
    assert.equal(result.ladder.clipUWei, (35n * U) / 3n);
    assert.equal(result.ladder.idleUWei, 35n * U - ((35n * U) / 3n) * 3n);
  });

  it("clamps to maxLevels however large the allocation", () => {
    const result = buildLadder({ allocationUWei: 5_000n * U, p0E18: 740n * E18, params: PARAMS });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.ladder.levels, PARAMS.maxLevels);
  });

  it("refuses an allocation below the minimum clip, permanently and by name", () => {
    const result = buildLadder({ allocationUWei: 9n * U, p0E18: 740n * E18, params: PARAMS });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "below-minimum");
  });

  it("compounds buy prices DOWN and rounds sell prices UP", () => {
    const p0 = 740n * E18;
    const result = buildLadder({ allocationUWei: 35n * U, p0E18: p0, params: PARAMS });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { buyPrice, sellPrice } = result.ladder;
    assert.equal(buyPrice[0], p0);
    for (let index = 1; index <= result.ladder.levels; index += 1) {
      const previous = buyPrice[index - 1]!;
      // FLOOR on the way down: a buy level never claims a better price than
      // the arithmetic gives it.
      assert.equal(buyPrice[index], (previous * (BPS - BigInt(PARAMS.bandBps))) / BPS);
      assert.ok(buyPrice[index]! < previous);
      // CEILING on the way up: a sell level never claims a worse one.
      assert.equal(
        sellPrice[index],
        ceilDiv(buyPrice[index]! * (BPS + BigInt(PARAMS.bandBps)), BPS),
      );
      assert.ok(sellPrice[index]! > buyPrice[index]!);
    }
  });
});

describe("quant triggers", () => {
  const level = { buyPriceE18: 700n * E18, sellPriceE18: 750n * E18 };

  it("a TOUCH is never a fill — strictly beyond, on both sides", () => {
    assert.equal(
      levelTriggerSide({ midE18: level.buyPriceE18, ...level, holdingBase: false }), null,
    );
    assert.equal(
      levelTriggerSide({ midE18: level.buyPriceE18 - 1n, ...level, holdingBase: false }), "buy",
    );
    assert.equal(
      levelTriggerSide({ midE18: level.sellPriceE18, ...level, holdingBase: true }), null,
    );
    assert.equal(
      levelTriggerSide({ midE18: level.sellPriceE18 + 1n, ...level, holdingBase: true }), "sell",
    );
  });

  it("a level holding base can only SELL and one in quote can only BUY", () => {
    assert.equal(
      levelTriggerSide({ midE18: level.buyPriceE18 - 1n, ...level, holdingBase: true }), null,
    );
    assert.equal(
      levelTriggerSide({ midE18: level.sellPriceE18 + 1n, ...level, holdingBase: false }), null,
    );
  });

  it("needs TWO consecutive readings, and resets when the condition fails", () => {
    let evidence = advanceTrigger({ consecutive: 0, side: null }, "buy");
    assert.equal(triggerArmed(evidence), false);
    evidence = advanceTrigger(evidence, "buy");
    assert.equal(triggerArmed(evidence), true);
    evidence = advanceTrigger(evidence, null);
    assert.deepEqual(evidence, { consecutive: 0, side: null });
  });

  it("a SIDE FLIP restarts the count rather than inheriting it", () => {
    let evidence = advanceTrigger({ consecutive: 0, side: null }, "buy");
    evidence = advanceTrigger(evidence, "sell");
    assert.deepEqual(evidence, { consecutive: 1, side: "sell" });
    assert.equal(triggerArmed(evidence), false);
  });
});

describe("quant executable-price guards", () => {
  it("tags minOut so two non-terminal actions of a job never share calldata", () => {
    const floor = 13_551_363_807_546_408n;
    const tagged = tagMinOut(floor, 2, 7);
    assert.ok(tagged >= floor, "a tag may only make a floor STRICTER");
    assert.ok(tagged - floor < 1000n, "a tag adds at most 999 wei");
    assert.equal(Number(tagged % 1000n), actionTag(2, 7));
  });

  it("is injective over the non-terminal actions of one job", () => {
    // At most one action per level is non-terminal and `action_seq` is per
    // level, so `(level, seq mod 100)` is unique across them.
    const seen = new Set<number>();
    for (let level = 1; level <= 5; level += 1) {
      for (let seq = 0; seq < 100; seq += 1) {
        const tag = actionTag(level, seq);
        assert.equal(seen.has(tag), false, `collision at L${level}#${seq}`);
        seen.add(tag);
      }
    }
  });

  it("gives each level its own deadline offset", () => {
    assert.equal(actionDeadlineSec(1_000, 1), 1_601);
    assert.equal(actionDeadlineSec(1_000, 4), 1_604);
  });

  it("anchors a buy's minOut to the LEVEL price plus the entry tolerance", () => {
    const clip = 10n * U;
    const buyPrice = 700n * E18;
    const minOut = buyMinOut({ clipUWei: clip, buyPriceE18: buyPrice, levelIndex: 1, actionSeq: 1, params: PARAMS });
    const floor = ceilDiv(clip * E18 * BPS, buyPrice * (BPS + BigInt(PARAMS.entryTolBps)));
    assert.ok(minOut >= floor);
    // The ceiling this expresses: the buy fills at no worse than
    // buyPrice × (1 + entryTol), so a finalized-96 / latest-105 divergence
    // REFUSES rather than filling at 105.
    const executedPrice = (clip * E18) / minOut;
    assert.ok(
      executedPrice <= (buyPrice * (BPS + BigInt(PARAMS.entryTolBps))) / BPS,
      `${executedPrice} vs ${buyPrice}`,
    );
  });

  it("compares a quote against the FINAL TAGGED minimum, not the raw floor (BC16)", () => {
    const minOut = 1_000_123n;
    assert.deepEqual(
      quoteAcceptable({
        quoteOutWei: minOut - 1n, minOutWei: minOut,
        quoteBlock: 100n, triggerBlock: 100n, maxQuoteLagBlocks: 40,
      }),
      { ok: false, code: "price-moved" },
    );
    assert.deepEqual(
      quoteAcceptable({
        quoteOutWei: minOut, minOutWei: minOut,
        quoteBlock: 100n, triggerBlock: 100n, maxQuoteLagBlocks: 40,
      }),
      { ok: true },
    );
  });

  it("refuses a quote read BEFORE the trigger, or too far after it", () => {
    const base = { quoteOutWei: 10n, minOutWei: 1n, maxQuoteLagBlocks: 40 };
    assert.deepEqual(
      quoteAcceptable({ ...base, quoteBlock: 99n, triggerBlock: 100n }),
      { ok: false, code: "quote-stale" },
    );
    assert.deepEqual(
      quoteAcceptable({ ...base, quoteBlock: 141n, triggerBlock: 100n }),
      { ok: false, code: "quote-stale" },
    );
  });

  it("a sell's floor is the HIGHER of the band and the actual basis plus costs", () => {
    const base = 13_500_000_000_000_000n;
    const floor = sellFloor({
      amountWei: base,
      baseAtCycleStartWei: base,
      basisUWei: 10n * U,
      entryCostUWei: feeEstInU(PARAMS, 740n * E18),
      sellPriceE18: 752n * E18,
      midE18: 752n * E18,
      levelIndex: 1,
      actionSeq: 1,
      params: PARAMS,
    });
    assert.equal(floor.floorWei, floor.levelFloorWei > floor.basisFloorWei
      ? floor.levelFloorWei : floor.basisFloorWei);
    // H9: a sell that clears its BASIS is admitted even when nominal band
    // arithmetic would hold it, and vice versa — whichever is higher wins.
    assert.ok(floor.minOutWei >= floor.floorWei);
  });

  it("rounds the BAND floor UP, like every other lower-output bound (A3)", () => {
    // An amount chosen so the division has a remainder: a floor here would be
    // a lower-output bound that rounds DOWN, which is the one direction R3.5
    // forbids. Worth < 1 wei — pinned because the exception is what gets copied.
    const amountWei = 3n;
    const sellPriceE18 = 752n * E18;
    const floor = sellFloor({
      amountWei, baseAtCycleStartWei: amountWei, basisUWei: 0n, entryCostUWei: 0n,
      sellPriceE18, midE18: sellPriceE18, levelIndex: 1, actionSeq: 1, params: PARAMS,
    });
    const exact = amountWei * sellPriceE18 * (BPS - BigInt(PARAMS.exitTolBps));
    const truncated = exact / (BPS * E18);
    assert.equal(floor.levelFloorWei, ceilDiv(exact, BPS * E18));
    assert.equal(floor.levelFloorWei, truncated + 1n, "this case must have a remainder");
  });

  it("re-values the exit-fee bound at the CURRENT mid on every intent (BC29)", () => {
    const base = 13_500_000_000_000_000n;
    const common = {
      amountWei: base, baseAtCycleStartWei: base, basisUWei: 10n * U,
      entryCostUWei: feeEstInU(PARAMS, 740n * E18),
      sellPriceE18: 752n * E18, levelIndex: 1, actionSeq: 1, params: PARAMS,
    };
    const atLowMid = sellFloor({ ...common, midE18: 740n * E18 });
    const atHighMid = sellFloor({ ...common, midE18: 794n * E18 });
    // A rise in BNB against U raises the U value of one relay fee, so the
    // freshly valued floor is STRICTLY higher. Freezing it is what REVIEW7's
    // condition 3 forbids.
    assert.ok(
      atHighMid.basisFloorWei > atLowMid.basisFloorWei,
      `${atHighMid.basisFloorWei} vs ${atLowMid.basisFloorWei}`,
    );
  });

  it("pro-rates basis and entry cost across a partial exit", () => {
    const base = 12_000_000_000_000_000n;
    const half = base / 2n;
    const full = sellFloor({
      amountWei: base, baseAtCycleStartWei: base, basisUWei: 10n * U,
      entryCostUWei: 100n, sellPriceE18: 752n * E18, midE18: 752n * E18,
      levelIndex: 1, actionSeq: 1, params: PARAMS,
    });
    const partial = sellFloor({
      amountWei: half, baseAtCycleStartWei: base, basisUWei: 10n * U,
      entryCostUWei: 100n, sellPriceE18: 752n * E18, midE18: 752n * E18,
      levelIndex: 1, actionSeq: 1, params: PARAMS,
    });
    assert.ok(partial.levelFloorWei * 2n <= full.levelFloorWei + 2n);
    assert.ok(partial.basisFloorWei < full.basisFloorWei);
  });
});

describe("quant cost floor", () => {
  it("uses the SAME 3x pad the native reservation uses (R3.5, REVIEW2 C8)", () => {
    const mid = midFromReserves(RESERVE_U, RESERVE_WBNB);
    const floor = armFloor({ clipUWei: 10n * U, midE18: mid, impactBps: 4n, params: PARAMS });
    // gasBps = ceilDiv(2 * 3 * fee * mid * BPS, clip * 1e18). At 10 U on the
    // measured pool that is ~447 bps, which is exactly why the band default is
    // 700 and not the body's 300.
    assert.ok(floor.gasBps > 400n && floor.gasBps < 500n, `${floor.gasBps}`);
    assert.equal(
      floor.gasBps,
      ceilDiv(2n * 3n * PARAMS.relayFeePerSubmitWei * mid * BPS, 10n * U * E18),
    );
    assert.equal(floor.economic, true);
    assert.ok(floor.requiredBps <= BigInt(PARAMS.bandBps));
  });

  it("refuses a 5 U clip on the same pool", () => {
    const mid = midFromReserves(RESERVE_U, RESERVE_WBNB);
    const floor = armFloor({ clipUWei: 5n * U, midE18: mid, impactBps: 2n, params: PARAMS });
    assert.equal(floor.economic, false, `required ${floor.requiredBps} bps`);
  });

  it("gets CHEAPER in bps as the clip grows", () => {
    const mid = midFromReserves(RESERVE_U, RESERVE_WBNB);
    const small = armFloor({ clipUWei: 10n * U, midE18: mid, impactBps: 4n, params: PARAMS });
    const large = armFloor({ clipUWei: 100n * U, midE18: mid, impactBps: 40n, params: PARAMS });
    assert.ok(large.gasBps < small.gasBps);
  });

  it("never shrinks the clip — the floor is a REFUSAL, never a resize", () => {
    // There is no code path that returns a smaller clip: `armFloor` answers a
    // boolean and the ladder's `clipUWei` is written once at admission.
    const mid = midFromReserves(RESERVE_U, RESERVE_WBNB);
    const ladder = buildLadder({ allocationUWei: 10n * U, p0E18: mid, params: PARAMS });
    assert.equal(ladder.ok, true);
    if (!ladder.ok) return;
    const floor = armFloor({
      clipUWei: ladder.ladder.clipUWei, midE18: mid, impactBps: 4n, params: PARAMS,
    });
    assert.equal(typeof floor.economic, "boolean");
    assert.equal(ladder.ladder.clipUWei, 10n * U);
  });

  it("prices the residual threshold from the DEEPEST level's sell price", () => {
    const mid = midFromReserves(RESERVE_U, RESERVE_WBNB);
    const minSell = economicMinSellWei({ sellPriceE18: 700n * E18, midE18: mid, params: PARAMS });
    assert.ok(minSell > 0n);
    // Selling exactly `minSell` at that price covers one fee plus the edge.
    const proceeds = (minSell * 700n * E18) / E18;
    const feeU = feeEstInU(PARAMS, mid);
    assert.ok(
      proceeds - (proceeds * BigInt(PARAMS.minNetEdgeBps)) / BPS >= feeU,
      `${proceeds} vs ${feeU}`,
    );
  });
});

describe("quant exit partition (R7.2 / BC30)", () => {
  const cases: readonly (readonly [bigint, bigint])[] = [
    [1n, 1n], [10n, 3n], [1_000_000n, 7n], [13_551_363_807_546_408n, 200_000_000_000_000_00n],
    [10n ** 18n, 10n ** 17n], [999_999n, 1_000_000n],
  ];

  it("sums EXACTLY, spreads by at most 1 wei, and never emits a zero chunk", () => {
    for (const [base, cap] of cases) {
      const chunks = partitionExit(base, cap);
      assert.ok(chunks.length > 0, `${base}/${cap}`);
      const total = chunks.reduce((sum, chunk) => sum + chunk, 0n);
      assert.equal(total, base, `sum for ${base}/${cap}`);
      const min = chunks.reduce((least, chunk) => (chunk < least ? chunk : least), chunks[0]!);
      const max = chunks.reduce((most, chunk) => (chunk > most ? chunk : most), chunks[0]!);
      assert.ok(max - min <= 1n, `spread for ${base}/${cap}: ${min}..${max}`);
      assert.ok(min > 0n, `zero chunk for ${base}/${cap}`);
      for (const chunk of chunks) {
        assert.ok(chunk <= cap, `chunk ${chunk} exceeds cap ${cap}`);
      }
    }
  });

  it("handles the r = 0 boundary — every chunk equal, none oversized", () => {
    const chunks = partitionExit(300n, 100n);
    assert.deepEqual(chunks, [100n, 100n, 100n]);
  });

  it("emits the LARGEST chunks first, so a residual is the smallest one", () => {
    const chunks = partitionExit(10n, 3n);
    assert.deepEqual(chunks, [3n, 3n, 2n, 2n]);
    const last = chunks[chunks.length - 1]!;
    assert.ok(chunks.every((chunk) => chunk >= last));
  });

  it("is empty for a zero base and refuses a non-positive cap", () => {
    assert.deepEqual(partitionExit(0n, 100n), []);
    assert.throws(() => partitionExit(10n, 0n));
  });

  it("bounds dust at 1e12 wei", () => {
    assert.equal(DUST_WEI, 1_000_000_000_000n);
  });
});

describe("quant native reservation (R5.5 / R6.4 / BC21 / BC27)", () => {
  const cap = 200_000_000_000_000_000n;

  it("a BUY reserves its own submission, its exits, and every other level's", () => {
    const required = requiredNativeWei({
      side: "buy",
      ownBaseWei: cap * 2n,
      otherLevels: [
        { kind: "holding-base", baseWei: cap },
        { kind: "pending-buy", baseWei: cap },
        { kind: "idle", baseWei: 0n },
      ],
      minCapLimitWei: cap,
      params: PARAMS,
    });
    // own = 1 + 2 exits; other holding = 1; other pending buy = 1 + 1.
    assert.equal(required, feeEst(PARAMS) * 6n);
  });

  it("a SELL reserves ONE fee and nothing else — exits are never blocked", () => {
    const required = requiredNativeWei({
      side: "sell",
      ownBaseWei: 0n,
      otherLevels: [
        { kind: "holding-base", baseWei: cap * 10n },
        { kind: "pending-buy", baseWei: cap * 10n },
      ],
      minCapLimitWei: cap,
      params: PARAMS,
    });
    assert.equal(required, feeEst(PARAMS));
  });

  it("a wallet funded for exactly one fee cannot pass a BUY", () => {
    const oneFee = feeEst(PARAMS);
    const required = requiredNativeWei({
      side: "buy", ownBaseWei: cap, otherLevels: [], minCapLimitWei: cap, params: PARAMS,
    });
    assert.ok(required > oneFee, "the buy must also reserve its own exit");
  });

  it("grows with the ACTUAL inventory a favourable fill acquires (R6.4)", () => {
    const quoted = requiredNativeWei({
      side: "buy", ownBaseWei: cap, otherLevels: [], minCapLimitWei: cap, params: PARAMS,
    });
    const better = requiredNativeWei({
      side: "buy", ownBaseWei: cap * 3n, otherLevels: [], minCapLimitWei: cap, params: PARAMS,
    });
    assert.ok(better > quoted, "more WBNB is more exits");
  });
});

describe("quant impact", () => {
  it("is byte-identical to the trade layer's, which it deliberately restates", () => {
    for (const [full, probe] of [[100n, 2n], [199n, 2n], [200n, 2n], [0n, 2n], [5n, 0n]] as const) {
      assert.equal(quantPriceImpactBps(full, probe), priceImpactBps(full, probe));
    }
  });
});
