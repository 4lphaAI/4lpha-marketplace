/**
 * The brain fence: any out-of-bounds proposal — malformed, unsnapped, too
 * wide, misplaced, hallucinated pool, smuggled budget — produces the
 * DETERMINISTIC fallback, never an acceptance and never an exception the
 * caller could route around (PHASE3 body "The brain" + Rev2 item 36).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  adjacentRotationRange,
  centeredRotationRange,
  SWAPLESS_MAX_RESIDUE_BPS,
  swaplessResidueWithinBound,
  swaplessRotationSide,
  validateBrainProposal,
  type PoolFenceContext,
  type RangeFenceContext,
} from "../src/lp/fence.js";
import { MAX_TICK, MIN_TICK, Q96, swapSplitIsTotal } from "../src/lp/tickMath.js";

const RANGE_FENCE: RangeFenceContext = {
  kind: "range",
  currentTick: 123,
  tickSpacing: 50,
  maxTickWidth: 2_000,
  priorWidthTicks: 300,
};

// The fallback every failure in RANGE_FENCE must produce.
const EXPECTED_FALLBACK = centeredRotationRange({
  currentTick: 123,
  priorWidthTicks: 300,
  tickSpacing: 50,
});

// Lowercase on purpose: the fence must normalize case itself. CHECKSUMMED is
// what an accepted/fallback verdict must carry.
const SURVIVORS = [
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364",
  "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
] as const;
const CHECKSUMMED = SURVIVORS.map((address) => getAddress(address));

const POOL_FENCE: PoolFenceContext = { kind: "pool", survivors: SURVIVORS };

function describeProposal(proposal: unknown): string {
  return JSON.stringify(proposal, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value.toString()}n` : value,
  ) ?? String(proposal);
}

function expectRangeFallback(proposal: unknown, code?: string): void {
  const verdict = validateBrainProposal(proposal, RANGE_FENCE);
  assert.equal(verdict.outcome, "fell-back", describeProposal(proposal));
  if (verdict.outcome !== "fell-back") return; // narrow for TS
  if (code !== undefined) assert.equal(verdict.code, code, describeProposal(proposal));
  assert.deepEqual(verdict.fallback, { kind: "range", ...EXPECTED_FALLBACK });
  assert.ok(verdict.reason.length > 0);
}

describe("centeredRotationRange (the deterministic fallback)", () => {
  it("re-centers the prior width on the current tick, snapped to spacing", () => {
    // center = floor(123/50)*50 = 100; width 300 -> halfSteps 3 -> [-50, 250].
    assert.deepEqual(
      centeredRotationRange({ currentTick: 123, priorWidthTicks: 300, tickSpacing: 50 }),
      { tickLower: -50, tickUpper: 250 },
    );
  });

  it("floors the width at 2 * tickSpacing", () => {
    assert.deepEqual(
      centeredRotationRange({ currentTick: 123, priorWidthTicks: 10, tickSpacing: 50 }),
      { tickLower: 50, tickUpper: 150 },
    );
  });

  it("rounds a non-multiple width UP in half-steps (never narrows below prior)", () => {
    // width 250 -> halfSteps ceil(2.5) = 3 -> total width 300 >= 250.
    const range = centeredRotationRange({ currentTick: 0, priorWidthTicks: 250, tickSpacing: 50 });
    assert.deepEqual(range, { tickLower: -150, tickUpper: 150 });
  });

  it("shifts (not truncates) the window inside the global bounds near MAX_TICK", () => {
    const range = centeredRotationRange({
      currentTick: 887_270,
      priorWidthTicks: 800,
      tickSpacing: 200,
    });
    assert.deepEqual(range, { tickLower: 886_400, tickUpper: 887_200 });
    assert.ok(range.tickUpper <= MAX_TICK);
    assert.equal(range.tickUpper - range.tickLower, 800);
  });

  it("shifts inside the global bounds near MIN_TICK", () => {
    const range = centeredRotationRange({
      currentTick: -887_270,
      priorWidthTicks: 800,
      tickSpacing: 200,
    });
    assert.ok(range.tickLower >= MIN_TICK);
    assert.equal(range.tickUpper - range.tickLower, 800);
    assert.equal(Math.abs(range.tickLower % 200), 0);
  });

  it("rejects an invalid caller context (a build error, not brain output)", () => {
    assert.throws(() => centeredRotationRange({ currentTick: 0, priorWidthTicks: 100, tickSpacing: 0 }));
    assert.throws(() => centeredRotationRange({ currentTick: 0.5, priorWidthTicks: 100, tickSpacing: 50 }));
    assert.throws(() =>
      centeredRotationRange({ currentTick: MAX_TICK + 1, priorWidthTicks: 100, tickSpacing: 50 }),
    );
  });
});

describe("range fence: acceptance", () => {
  it("accepts a snapped, in-width, centered range containing the current tick", () => {
    const verdict = validateBrainProposal({ tickLower: -100, tickUpper: 200 }, RANGE_FENCE);
    assert.deepEqual(verdict, {
      outcome: "accepted",
      kind: "range",
      tickLower: -100,
      tickUpper: 200,
      bias: "centered",
    });
  });

  it("rejects holdInstead when the reply also carries an unknown key", () => {
    const verdict = validateBrainProposal(
      { holdInstead: true, tickLower: "nonsense", anything: 42 },
      RANGE_FENCE,
    );
    assert.equal(verdict.outcome, "fell-back");
    if (verdict.outcome !== "fell-back") return;
    assert.equal(verdict.code, "PROPOSAL_MALFORMED");
    assert.match(verdict.reason, /unexpected field "anything"/u);
    assert.deepEqual(verdict.fallback, { kind: "range", ...EXPECTED_FALLBACK });
  });

  it("accepts an above-biased range anchored at the current price", () => {
    // floorTick = 100. Anchors at 100 or 150 are both proper brackets.
    for (const tickLower of [100, 150]) {
      const verdict = validateBrainProposal(
        { tickLower, tickUpper: tickLower + 500, bias: "above" },
        RANGE_FENCE,
      );
      assert.equal(verdict.outcome, "accepted");
    }
  });

  it("accepts a below-biased range anchored at the current price", () => {
    for (const tickUpper of [100, 150]) {
      const verdict = validateBrainProposal(
        { tickLower: tickUpper - 500, tickUpper, bias: "below" },
        RANGE_FENCE,
      );
      assert.equal(verdict.outcome, "accepted");
    }
  });

  it("accepts holdInstead: false as a plain range proposal", () => {
    const verdict = validateBrainProposal(
      { tickLower: -100, tickUpper: 200, holdInstead: false },
      RANGE_FENCE,
    );
    assert.equal(verdict.outcome, "accepted");
  });
});

describe("range fence: every failure falls back deterministically", () => {
  it("non-object proposals", () => {
    for (const proposal of [null, undefined, 42, "rotate wider", [], [1, 2], true]) {
      expectRangeFallback(proposal, "PROPOSAL_MALFORMED");
    }
  });

  it("missing or non-integer ticks", () => {
    expectRangeFallback({}, "PROPOSAL_MALFORMED");
    expectRangeFallback({ tickLower: -100 }, "PROPOSAL_MALFORMED");
    expectRangeFallback({ tickLower: -100.5, tickUpper: 200 }, "PROPOSAL_MALFORMED");
    expectRangeFallback({ tickLower: "-100", tickUpper: 200 }, "PROPOSAL_MALFORMED");
    expectRangeFallback({ tickLower: -100, tickUpper: Number.NaN }, "PROPOSAL_MALFORMED");
    expectRangeFallback({ tickLower: -100n, tickUpper: 200 } as unknown, "PROPOSAL_MALFORMED");
  });

  it("a smuggled budget or any unknown field (the brain has no sizing authority)", () => {
    expectRangeFallback({ tickLower: -100, tickUpper: 200, budgetWei: "1" }, "PROPOSAL_MALFORMED");
    expectRangeFallback({ tickLower: -100, tickUpper: 200, amount: 5 }, "PROPOSAL_MALFORMED");
    expectRangeFallback({ tickLower: -100, tickUpper: 200, recipient: "0x" }, "PROPOSAL_MALFORMED");
  });

  it("a non-boolean holdInstead", () => {
    expectRangeFallback({ holdInstead: "true" }, "PROPOSAL_MALFORMED");
    expectRangeFallback({ holdInstead: 1 }, "PROPOSAL_MALFORMED");
  });

  it("an invalid bias", () => {
    expectRangeFallback({ tickLower: -100, tickUpper: 200, bias: "sideways" }, "PROPOSAL_MALFORMED");
  });

  it("unsnapped ticks", () => {
    expectRangeFallback({ tickLower: -101, tickUpper: 200 }, "TICKS_NOT_SNAPPED");
    expectRangeFallback({ tickLower: -100, tickUpper: 199 }, "TICKS_NOT_SNAPPED");
  });

  it("inverted or globally out-of-bounds ranges", () => {
    expectRangeFallback({ tickLower: 200, tickUpper: -100 }, "RANGE_OUT_OF_BOUNDS");
    expectRangeFallback({ tickLower: 100, tickUpper: 100 }, "RANGE_OUT_OF_BOUNDS");
    expectRangeFallback({ tickLower: -887_300, tickUpper: 200 }, "RANGE_OUT_OF_BOUNDS");
    expectRangeFallback({ tickLower: -100, tickUpper: 887_300 }, "RANGE_OUT_OF_BOUNDS");
  });

  it("width below 2 * spacing or above maxTickWidth", () => {
    expectRangeFallback({ tickLower: 100, tickUpper: 150 }, "WIDTH_OUT_OF_BOUNDS");
    expectRangeFallback({ tickLower: -1_000, tickUpper: 1_050 }, "WIDTH_OUT_OF_BOUNDS");
  });

  it("a centered range that does not contain the current tick", () => {
    expectRangeFallback({ tickLower: 150, tickUpper: 450 }, "RANGE_MISPLACED");
    expectRangeFallback({ tickLower: -450, tickUpper: -150 }, "RANGE_MISPLACED");
    // Upper bound is exclusive: currentTick 123 needs tickUpper > 123... a
    // range ending exactly at the floor tick does not contain it.
    expectRangeFallback({ tickLower: -200, tickUpper: 100 }, "RANGE_MISPLACED");
  });

  it("a biased range that drifts away from the current price", () => {
    expectRangeFallback({ tickLower: 200, tickUpper: 700, bias: "above" }, "RANGE_MISPLACED");
    expectRangeFallback({ tickLower: -700, tickUpper: -200, bias: "below" }, "RANGE_MISPLACED");
    expectRangeFallback({ tickLower: 0, tickUpper: 500, bias: "above" }, "RANGE_MISPLACED");
  });

  it("property loop: randomized invalid proposals ALWAYS fall back to the deterministic range", () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 0xdecafbad;
    const rand = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(rand() * items.length)];
      if (item === undefined) throw new Error("empty pick");
      return item;
    };

    for (let i = 0; i < 500; i += 1) {
      const kind = pick(["garbage", "unsnapped", "narrow", "wide", "misplaced", "inverted", "extraKey"] as const);
      let proposal: unknown;
      const span = 50 * (2 + Math.floor(rand() * 30)); // valid-ish width
      switch (kind) {
        case "garbage":
          proposal = pick([null, rand(), `tick ${rand()}`, [rand()], { tickLower: rand() }]);
          break;
        case "unsnapped": {
          const lower = Math.floor(rand() * 400) - 200;
          const misaligned = lower % 50 === 0 ? lower + 1 : lower;
          proposal = { tickLower: misaligned, tickUpper: misaligned + span };
          break;
        }
        case "narrow":
          proposal = { tickLower: 100, tickUpper: 100 + pick([0, 50]) };
          break;
        case "wide":
          proposal = { tickLower: -50_000, tickUpper: 50_000 };
          break;
        case "misplaced": {
          const lower = 50 * (10 + Math.floor(rand() * 100)); // entirely above 123
          proposal = { tickLower: lower, tickUpper: lower + span };
          break;
        }
        case "inverted":
          proposal = { tickLower: 250, tickUpper: -250 };
          break;
        case "extraKey":
          proposal = { tickLower: -100, tickUpper: 200, [`k${i}`]: rand() };
          break;
      }
      const verdict = validateBrainProposal(proposal, RANGE_FENCE);
      assert.equal(verdict.outcome, "fell-back", `${kind}: ${JSON.stringify(proposal)}`);
      if (verdict.outcome === "fell-back") {
        assert.deepEqual(verdict.fallback, { kind: "range", ...EXPECTED_FALLBACK });
      }
    }
  });

  it("rejects an invalid caller context by throwing (not by falling back)", () => {
    assert.throws(() =>
      validateBrainProposal({ tickLower: -100, tickUpper: 200 }, { ...RANGE_FENCE, tickSpacing: 0 }),
    );
    assert.throws(() =>
      validateBrainProposal({ tickLower: -100, tickUpper: 200 }, { ...RANGE_FENCE, maxTickWidth: 50 }),
    );
    assert.throws(() =>
      validateBrainProposal({ tickLower: -100, tickUpper: 200 }, { ...RANGE_FENCE, priorWidthTicks: 0 }),
    );
  });
});

describe("pool fence (Rev2 item 36)", () => {
  it("accepts a survivor, normalizing case to the checksummed form", () => {
    const verdict = validateBrainProposal({ poolChoice: SURVIVORS[1] }, POOL_FENCE);
    assert.deepEqual(verdict, {
      outcome: "accepted",
      kind: "pool",
      poolAddress: CHECKSUMMED[1],
    });
    // The checksummed spelling of the same survivor is equally accepted.
    const checksummed = validateBrainProposal({ poolChoice: CHECKSUMMED[1] }, POOL_FENCE);
    assert.equal(checksummed.outcome, "accepted");
  });

  it("falls back to the deterministic head on a hallucinated pool address", () => {
    const verdict = validateBrainProposal(
      { poolChoice: "0x00000000000000000000000000000000deadbeef" },
      POOL_FENCE,
    );
    assert.equal(verdict.outcome, "fell-back");
    if (verdict.outcome === "fell-back") {
      assert.equal(verdict.code, "POOL_NOT_IN_SURVIVOR_SET");
      assert.deepEqual(verdict.fallback, { kind: "pool", poolAddress: CHECKSUMMED[0] });
    }
  });

  it("falls back on malformed pool proposals", () => {
    for (const proposal of [
      null,
      "just pick the best one",
      { poolChoice: "not-an-address" },
      { poolChoice: 42 },
      { poolChoice: SURVIVORS[0], alsoDo: "stake" },
      {},
    ]) {
      const verdict = validateBrainProposal(proposal, POOL_FENCE);
      assert.equal(verdict.outcome, "fell-back", JSON.stringify(proposal));
      if (verdict.outcome === "fell-back") {
        assert.equal(verdict.code, "PROPOSAL_MALFORMED");
        assert.deepEqual(verdict.fallback, { kind: "pool", poolAddress: CHECKSUMMED[0] });
      }
    }
  });

  it("property loop: random hex addresses never pass the survivor set", () => {
    let seed = 0xc0ffee;
    const rand = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let i = 0; i < 200; i += 1) {
      const hex = Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
      const poolChoice = `0x${hex}`;
      if (SURVIVORS.some((s) => s.toLowerCase() === poolChoice)) continue; // astronomically unlikely
      const verdict = validateBrainProposal({ poolChoice }, POOL_FENCE);
      assert.equal(verdict.outcome, "fell-back", poolChoice);
      if (verdict.outcome === "fell-back") {
        assert.deepEqual(verdict.fallback, { kind: "pool", poolAddress: CHECKSUMMED[0] });
      }
    }
  });

  it("an empty survivor list is a caller bug and throws (the open refuses upstream)", () => {
    assert.throws(
      () => validateBrainProposal({ poolChoice: SURVIVORS[0] }, { kind: "pool", survivors: [] }),
      /must not be empty/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.13 — the swapless rotate's pure layer                               */
/* -------------------------------------------------------------------------- */

/**
 * B8 — `adjacentRotationRange` properties.
 *
 * The whole point of the function is a range that is STRICTLY one side of the
 * current tick, for EVERY residue of `currentTick mod tickSpacing` including 0
 * and every negative one. A range that contains the tick is sized by the dust
 * leg and strands the principal, which is the failure the swapless mode exists
 * to avoid rather than to cause.
 */
describe("PHASE3.13 B8: adjacentRotationRange", () => {
  const SPACINGS = [10, 50, 60, 100, 200] as const;

  it("is STRICTLY one side of the tick for every tick/spacing residue, negatives and zero included", () => {
    for (const tickSpacing of SPACINGS) {
      for (let currentTick = -3 * tickSpacing - 3; currentTick <= 3 * tickSpacing + 3; currentTick += 1) {
        const above = adjacentRotationRange({
          currentTick,
          priorWidthTicks: 6 * tickSpacing,
          tickSpacing,
          maxTickWidth: 100 * tickSpacing,
          side: "above",
        });
        assert.ok(
          above.tickLower > currentTick,
          `above must start strictly above tick ${currentTick} at spacing ${tickSpacing}, got ${above.tickLower}`,
        );
        const below = adjacentRotationRange({
          currentTick,
          priorWidthTicks: 6 * tickSpacing,
          tickSpacing,
          maxTickWidth: 100 * tickSpacing,
          side: "below",
        });
        assert.ok(
          below.tickUpper <= currentTick,
          `below must end at or below tick ${currentTick} at spacing ${tickSpacing}, got ${below.tickUpper}`,
        );
        // The pool's own tick check: both bounds are multiples of the spacing.
        for (const range of [above, below]) {
          assert.ok(range.tickLower % tickSpacing === 0, "tickLower is spacing-aligned");
          assert.ok(range.tickUpper % tickSpacing === 0, "tickUpper is spacing-aligned");
          assert.ok(range.tickUpper - range.tickLower >= 2 * tickSpacing);
        }
        // And the split at that tick is TOTAL — the placement the mint asserts.
        assert.equal(swapSplitIsTotal(currentTick, above.tickLower, above.tickUpper), true);
        assert.equal(swapSplitIsTotal(currentTick, below.tickLower, below.tickUpper), true);
      }
    }
  });

  it("preserves the prior width (snapped down) and floors it at 2 * tickSpacing", () => {
    const wide = adjacentRotationRange({
      currentTick: 137,
      priorWidthTicks: 1_000,
      tickSpacing: 50,
      maxTickWidth: 10_000,
      side: "above",
    });
    assert.equal(wide.tickUpper - wide.tickLower, 1_000);
    const narrow = adjacentRotationRange({
      currentTick: 137,
      priorWidthTicks: 1,
      tickSpacing: 50,
      maxTickWidth: 10_000,
      side: "below",
    });
    assert.equal(narrow.tickUpper - narrow.tickLower, 100, "floored at 2 * spacing");
  });

  it("clamps to maxTickWidth — F7 case 3, the imported-wide-position gap", () => {
    const clamped = adjacentRotationRange({
      currentTick: 0,
      priorWidthTicks: 50_000,
      tickSpacing: 50,
      maxTickWidth: 500,
      side: "above",
    });
    assert.equal(clamped.tickUpper - clamped.tickLower, 500);
  });

  it("REFUSES at the global bounds rather than shifting back across the tick (F7 cases 1 and 2, both directions)", () => {
    for (const tickSpacing of SPACINGS) {
      const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
      const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
      // No legal "above" range: even 2 * spacing overruns the top.
      assert.throws(
        () =>
          adjacentRotationRange({
            currentTick: MAX_TICK,
            priorWidthTicks: 4 * tickSpacing,
            tickSpacing,
            maxTickWidth: 100 * tickSpacing,
            side: "above",
          }),
        /refusing/u,
      );
      // No legal "below" range at the bottom.
      assert.throws(
        () =>
          adjacentRotationRange({
            currentTick: MIN_TICK,
            priorWidthTicks: 4 * tickSpacing,
            tickSpacing,
            maxTickWidth: 100 * tickSpacing,
            side: "below",
          }),
        /refusing/u,
      );
      // And where a range DOES fit near the edge it is still aligned and
      // still strictly one-sided — never an unaligned MIN_TICK/MAX_TICK anchor.
      const nearTop = adjacentRotationRange({
        currentTick: maxUsable - 4 * tickSpacing,
        priorWidthTicks: 10 * tickSpacing,
        tickSpacing,
        maxTickWidth: 100 * tickSpacing,
        side: "above",
      });
      assert.ok(nearTop.tickUpper % tickSpacing === 0);
      assert.ok(nearTop.tickUpper <= maxUsable);
      assert.ok(nearTop.tickLower > maxUsable - 4 * tickSpacing);
      const nearBottom = adjacentRotationRange({
        currentTick: minUsable + 4 * tickSpacing,
        priorWidthTicks: 10 * tickSpacing,
        tickSpacing,
        maxTickWidth: 100 * tickSpacing,
        side: "below",
      });
      assert.ok(nearBottom.tickLower % tickSpacing === 0);
      assert.ok(nearBottom.tickLower >= minUsable);
      assert.ok(nearBottom.tickUpper <= minUsable + 4 * tickSpacing);
    }
  });

  it("refuses a tick below the lowest spacing-aligned anchor rather than emitting an unaligned one (M3)", () => {
    // MIN_TICK is -887272, which is a multiple of NO usable spacing
    // (887272 = 8 * 110909). `nearestUsableTick` would return it verbatim.
    for (const tickSpacing of SPACINGS) {
      const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
      const belowAnchor = minUsable - 1;
      if (belowAnchor < MIN_TICK) continue;
      // `nearestUsableTick` would hand back MIN_TICK verbatim here and the
      // anchor derived from it would be unaligned. This refuses instead.
      assert.throws(
        () =>
          adjacentRotationRange({
            currentTick: belowAnchor,
            priorWidthTicks: 4 * tickSpacing,
            tickSpacing,
            maxTickWidth: 100 * tickSpacing,
            side: "above",
          }),
        /no spacing-aligned anchor/u,
      );
    }
    assert.throws(
      () =>
        adjacentRotationRange({
          currentTick: MIN_TICK,
          priorWidthTicks: 200,
          tickSpacing: 60,
          maxTickWidth: 10_000,
          side: "above",
        }),
      /no spacing-aligned anchor/u,
    );
  });

  it("validates its own inputs", () => {
    const base = {
      currentTick: 0,
      priorWidthTicks: 500,
      tickSpacing: 50,
      maxTickWidth: 10_000,
      side: "above" as const,
    };
    assert.throws(() => adjacentRotationRange({ ...base, tickSpacing: 0 }), /tickSpacing/u);
    assert.throws(() => adjacentRotationRange({ ...base, priorWidthTicks: 0 }), /priorWidthTicks/u);
    assert.throws(() => adjacentRotationRange({ ...base, maxTickWidth: 50 }), /maxTickWidth/u);
    assert.throws(
      () => adjacentRotationRange({ ...base, currentTick: MAX_TICK + 1 }),
      /global tick bounds/u,
    );
  });
});

describe("PHASE3.13: swaplessRotationSide", () => {
  const prior = { priorTickLower: -1_000, priorTickUpper: 1_000 };

  it("derives the side from the FRESH tick against the PRIOR range, lower-inclusive", () => {
    assert.equal(swaplessRotationSide({ currentTick: -1_001, ...prior }), "above");
    assert.equal(swaplessRotationSide({ currentTick: 1_000, ...prior }), "below");
    assert.equal(swaplessRotationSide({ currentTick: 1_001, ...prior }), "below");
  });

  it("has NO side while the tick is inside the prior range — F4's conjunct", () => {
    assert.equal(swaplessRotationSide({ currentTick: -1_000, ...prior }), undefined);
    assert.equal(swaplessRotationSide({ currentTick: 0, ...prior }), undefined);
    assert.equal(swaplessRotationSide({ currentTick: 999, ...prior }), undefined);
  });

  it("refuses an inverted prior range", () => {
    assert.throws(
      () => swaplessRotationSide({ currentTick: 0, priorTickLower: 10, priorTickUpper: 10 }),
      /inverted or empty/u,
    );
  });
});

/**
 * B20's pure half — ONE predicate, ONE threshold. The mutation this kills is
 * M5: "the chosen side carries the MAJORITY of the freed value" is 5000 bps,
 * and a 45/55 split passes it while stranding 45 % of the principal.
 */
describe("PHASE3.13 B20: swaplessResidueWithinBound", () => {
  // A spot of exactly 1.0 (token1 per token0), so value arithmetic is by hand.
  const SPOT = Q96;

  it("admits a residue at or under the bound and refuses one above it", () => {
    // 50 bps exactly: 50 out of 10000.
    assert.equal(
      swaplessResidueWithinBound({
        amount0: 9_950n,
        amount1: 50n,
        side: "above",
        spotSqrtPriceX96: SPOT,
      }).within,
      true,
    );
    assert.equal(
      swaplessResidueWithinBound({
        amount0: 9_949n,
        amount1: 51n,
        side: "above",
        spotSqrtPriceX96: SPOT,
      }).within,
      false,
    );
  });

  it("REFUSES a 45/55 split — which a majority bind would have admitted (M5)", () => {
    const verdict = swaplessResidueWithinBound({
      amount0: 5_500n,
      amount1: 4_500n,
      side: "above",
      spotSqrtPriceX96: SPOT,
    });
    assert.equal(verdict.within, false);
    assert.equal(verdict.residueBps, 4_500n);
    assert.ok(verdict.residueBps < 5_000n, "a majority bind would have PASSED this");
  });

  it("mirrors correctly on the other side — the residue is the OTHER leg", () => {
    const above = swaplessResidueWithinBound({
      amount0: 10_000n,
      amount1: 10n,
      side: "above",
      spotSqrtPriceX96: SPOT,
    });
    assert.equal(above.residueWei, 10n, "above keeps token0, drops token1");
    const below = swaplessResidueWithinBound({
      amount0: 10n,
      amount1: 10_000n,
      side: "below",
      spotSqrtPriceX96: SPOT,
    });
    assert.equal(below.residueWei, 10n, "below keeps token1, drops token0");
    assert.equal(below.within, true);
    // The same physical dust on the WRONG side is not a residue at all.
    assert.equal(
      swaplessResidueWithinBound({
        amount0: 10n,
        amount1: 10_000n,
        side: "above",
        spotSqrtPriceX96: SPOT,
      }).within,
      false,
    );
  });

  it("is FAIL-CLOSED on a zero total: nothing freed is not a small residue", () => {
    assert.equal(
      swaplessResidueWithinBound({
        amount0: 0n,
        amount1: 0n,
        side: "above",
        spotSqrtPriceX96: SPOT,
      }).within,
      false,
    );
  });

  it("is exported as ONE constant, not two literals (OQ1/F2)", () => {
    assert.equal(SWAPLESS_MAX_RESIDUE_BPS, 50);
  });
});
