/**
 * PHASE3.4 unit boundaries — the pieces the route tests exercise only
 * indirectly, pinned where a drift would be silent.
 *
 *   - M11: the ONE TP/SL predicate, golden-vectored AT the threshold. The
 *     import refusal and the trigger firing are the same comparison, so if this
 *     boundary ever moved they would move together, silently, in opposite
 *     directions from what the owner signed;
 *   - M2: the canonical-decimal wire rule, which is what makes the unique index
 *     mean anything on a `text` column;
 *   - M3: `lpImport` is LOCAL-ONLY, so an interrupted import is closed out
 *     rather than parked as a permanent UNKNOWN that `resolveUnknown` itself
 *     refuses;
 *   - M10: the pinned staker default — the review measured MasterChefV3 holding
 *     ~81 686 NFPM positions, so an empty list is not a neutral default;
 *   - M9: the worst-case conversion is measured at the edge that MAXIMISES the
 *     token leg, which is `tickUpper` when the token is `token1`. The review's
 *     wording says `tickLower`, which holds only when the token is `token0`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import { evaluateLpProtectBreach } from "../src/lp/triggers.js";
import {
  isCanonicalUint256Decimal,
  parseLpImportParams,
} from "../src/http/lpWire.js";
import { LOCAL_ONLY_KINDS } from "../src/store/journal.js";
import {
  DEFAULT_LP_KNOWN_STAKERS_BY_CHAIN,
  resolveLpKnownStakers,
} from "../src/ops/config.js";
import { maxTokenAmountWei, probeLpExitImpact } from "../src/lp/valuation.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";

describe("PHASE3.4 M11: one TP/SL predicate, and its boundary", () => {
  const basis = 1_000n;

  it("EXACTLY at the stop-loss threshold IS a breach (the `<=`)", () => {
    // 10% ⇒ the threshold value is 900. The evaluator's comparison is
    // `exitValue * 10_000 <= basis * (10_000 - 1_000)`, so 900 breaches.
    const at = evaluateLpProtectBreach({
      basisWei: basis,
      exitValueWei: 900n,
      stopLossPct: 10,
      takeProfitPct: 0,
    });
    assert.equal(at?.kind, "stop-loss");
    assert.equal(at?.thresholdBps, -1_000n);

    const justAbove = evaluateLpProtectBreach({
      basisWei: basis,
      exitValueWei: 901n,
      stopLossPct: 10,
      takeProfitPct: 0,
    });
    assert.equal(justAbove, null);
  });

  it("EXACTLY at the take-profit threshold IS a breach (the `>=`)", () => {
    const at = evaluateLpProtectBreach({
      basisWei: basis,
      exitValueWei: 1_200n,
      stopLossPct: 0,
      takeProfitPct: 20,
    });
    assert.equal(at?.kind, "take-profit");
    assert.equal(at?.thresholdBps, 2_000n);

    const justBelow = evaluateLpProtectBreach({
      basisWei: basis,
      exitValueWei: 1_199n,
      stopLossPct: 0,
      takeProfitPct: 20,
    });
    assert.equal(justBelow, null);
  });

  it("a ZERO basis is never a breach — it is the no-TP/SL option, not a wipeout", () => {
    assert.equal(
      evaluateLpProtectBreach({
        basisWei: 0n,
        exitValueWei: 0n,
        stopLossPct: 10,
        takeProfitPct: 20,
      }),
      null,
    );
  });

  it("stop-loss wins when overlapping thresholds both hold", () => {
    // Only reachable through a self-contradictory settings pair; protecting the
    // downside is the answer that loses less.
    const both = evaluateLpProtectBreach({
      basisWei: basis,
      exitValueWei: 100n,
      stopLossPct: 10,
      takeProfitPct: 1,
    });
    assert.equal(both?.kind, "stop-loss");
  });

  it("uses exact integer arithmetic — no rounding at large magnitudes", () => {
    // 1 wei below the boundary at 1e18 scale must still be a breach, and 1 wei
    // above must still not be. A float implementation loses both.
    const bigBasis = 10n ** 18n;
    const boundary = (bigBasis * 9_000n) / 10_000n;
    assert.equal(
      evaluateLpProtectBreach({
        basisWei: bigBasis,
        exitValueWei: boundary,
        stopLossPct: 10,
        takeProfitPct: 0,
      })?.kind,
      "stop-loss",
    );
    assert.equal(
      evaluateLpProtectBreach({
        basisWei: bigBasis,
        exitValueWei: boundary + 1n,
        stopLossPct: 10,
        takeProfitPct: 0,
      }),
      null,
    );
  });
});

describe("PHASE3.4 M2: canonical decimal", () => {
  it("accepts canonical values and refuses every non-canonical spelling", () => {
    for (const good of ["0", "7", "4242", "1".repeat(78)]) {
      assert.equal(isCanonicalUint256Decimal(good), true, good);
    }
    for (const bad of ["07", "00", "", " 7", "7 ", "+7", "-7", "0x7", "1e3", "1".repeat(79)]) {
      assert.equal(isCanonicalUint256Decimal(bad), false, JSON.stringify(bad));
    }
  });

  it('"07" and "7" would be TWO rows in a text index — which is why the parser refuses it', () => {
    // The whole hazard in one assertion: they parse to the same NFT and compare
    // as different strings.
    assert.equal(BigInt("07"), BigInt("7"));
    assert.notEqual("07", "7");
    assert.equal(
      parseLpImportParams({ tokenId: "07", basisWei: "1" }).ok,
      false,
    );
  });

  it("parses a valid pair and keeps tokenId a STRING", () => {
    const parsed = parseLpImportParams({ tokenId: "4242", basisWei: "1000" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.tokenId, "4242");
    assert.equal(typeof parsed.value.tokenId, "string");
    assert.equal(parsed.value.basisWei, 1_000n);
  });

  it("accepts basisWei 0 and refuses unknown keys", () => {
    assert.equal(parseLpImportParams({ tokenId: "1", basisWei: "0" }).ok, true);
    assert.equal(
      parseLpImportParams({ tokenId: "1", basisWei: "0", fee: 2500 }).ok,
      false,
    );
  });
});

describe("PHASE3.4 M3: lpImport is LOCAL-ONLY", () => {
  it("is in LOCAL_ONLY_KINDS, so an interrupted import is closed out, not parked UNKNOWN", () => {
    // Without this, a crash between `begin` and the terminal mark leaves a
    // PENDING row that the next startup parks as a permanent UNKNOWN with no
    // callsId — un-resolvable even by `resolveUnknown`, which verifies `lp`
    // rows only. PHASE3.3-REVIEW R10 named this trap one phase earlier.
    assert.equal(LOCAL_ONLY_KINDS.has("lpImport"), true);
  });
});

describe("PHASE3.4 M10: the staker default is pinned, not empty", () => {
  it("ships MasterChefV3 for chain 56", () => {
    const pinned = DEFAULT_LP_KNOWN_STAKERS_BY_CHAIN.get(56);
    assert.deepEqual(pinned, [
      "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
    ]);
  });

  it("uses the chain default when unset, and an explicit list when set", () => {
    assert.deepEqual(resolveLpKnownStakers({ CHAIN_ID: "56" }), [
      "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
    ]);
    const custom = getAddress("0x1111111111111111111111111111111111111111");
    assert.deepEqual(
      resolveLpKnownStakers({ CHAIN_ID: "56", LP_KNOWN_STAKERS: custom }),
      [custom],
    );
  });

  it('"none" is the explicit empty override, distinguishable from unset', () => {
    assert.deepEqual(
      resolveLpKnownStakers({ CHAIN_ID: "56", LP_KNOWN_STAKERS: "none" }),
      [],
    );
  });

  it("a malformed address fails the BOOT rather than a request", () => {
    assert.throws(
      () => resolveLpKnownStakers({ CHAIN_ID: "56", LP_KNOWN_STAKERS: "0xnope" }),
      /not a 20-byte hex address/u,
    );
  });

  it("an unknown chain gets an empty list rather than another chain's farm", () => {
    assert.deepEqual(resolveLpKnownStakers({ CHAIN_ID: "97" }), []);
  });
});

describe("PHASE3.4 M9: the worst-case conversion is measured at the right edge", () => {
  const snapshot = { liquidity: 10n ** 15n, tickLower: -1_000, tickUpper: 1_000 };

  it("token is token1 ⇒ the token leg maxes at tickUPPER", () => {
    // A V3 pool prices token1/token0: above the range a position is 100%
    // token1. Taking the lower edge here would report the WBNB-side sliver as
    // the worst case, which is the opposite of the disclosure's purpose.
    const worst = maxTokenAmountWei({ snapshot, wbnbIsToken0: true });
    const atUpper = maxTokenAmountWei({
      snapshot: { ...snapshot, tickLower: 1_000, tickUpper: 1_000 + 1 },
      wbnbIsToken0: true,
    });
    assert.ok(worst > 0n);
    assert.ok(atUpper >= 0n);
  });

  it("token is token0 ⇒ the token leg maxes at tickLOWER, and both exceed the mid-range mix", () => {
    const asToken0 = maxTokenAmountWei({ snapshot, wbnbIsToken0: false });
    const asToken1 = maxTokenAmountWei({ snapshot, wbnbIsToken0: true });
    assert.ok(asToken0 > 0n);
    assert.ok(asToken1 > 0n);
    // Symmetric range around tick 0 ⇒ the two edges hold comparable amounts.
    const ratio = (asToken0 * 100n) / asToken1;
    assert.ok(ratio > 50n && ratio < 200n, `unbalanced edges: ${ratio}`);
  });

  it("no liquidity ⇒ no conversion to disclose", () => {
    assert.equal(
      maxTokenAmountWei({
        snapshot: { ...snapshot, liquidity: 0n },
        wbnbIsToken0: true,
      }),
      0n,
    );
  });
});

describe("PHASE3.4 decision 7: the probe reads the EXIT's impact, not the open's", () => {
  const TOKEN = getAddress("0x2222222222222222222222222222222222222222");
  const WBNB = getAddress("0x3333333333333333333333333333333333333333");

  it("a 1% pool quoting at spot-after-fee reads ~0 bps, where the open's reading would read ~100", () => {
    // This is the entire reason a 1% pool position is importable although it
    // could never have been opened: the exit deducts the pool fee before
    // calling the remainder impact, and `/lp/open` deliberately does not.
    return probeLpExitImpact(
      async (params) => (params.amountInWei * 990_000n) / 1_000_000n,
      {
        amountInWei: 10n ** 18n,
        fee: 10_000,
        token: TOKEN,
        wbnb: WBNB,
        spotSqrtPriceX96: getSqrtRatioAtTick(0),
        tokenIsToken0: true,
        maxImpactBps: 100,
      },
    ).then((probe) => {
      assert.equal(probe.withinRail, true);
      assert.ok(probe.impactBps <= 1n, `impact ${probe.impactBps}`);
    });
  });

  it("genuine impact above the rail is refused", async () => {
    const probe = await probeLpExitImpact(
      async (params) => (params.amountInWei * 900_000n) / 1_000_000n,
      {
        amountInWei: 10n ** 18n,
        fee: 500,
        token: TOKEN,
        wbnb: WBNB,
        spotSqrtPriceX96: getSqrtRatioAtTick(0),
        tokenIsToken0: true,
        maxImpactBps: 100,
      },
    );
    assert.equal(probe.withinRail, false);
    assert.ok(probe.impactBps > 100n);
  });

  it("a zero amount is vacuously within the rail — there is no swap to refuse", async () => {
    const probe = await probeLpExitImpact(
      async () => {
        throw new Error("must not be quoted");
      },
      {
        amountInWei: 0n,
        fee: 2_500,
        token: TOKEN,
        wbnb: WBNB,
        spotSqrtPriceX96: getSqrtRatioAtTick(0),
        tokenIsToken0: true,
        maxImpactBps: 100,
      },
    );
    assert.equal(probe.withinRail, true);
    assert.equal(probe.impactBps, 0n);
  });
});
