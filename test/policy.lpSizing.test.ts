/**
 * The R4 LP sizing invariant (PHASE3 Rev2 items 11–12; audit A3): the reserve
 * count is DERIVED from the enforced settings limit, the operator flag may
 * only RAISE it, the quota-EXEMPT protect/manual-exit gas is reserved per
 * open position (floored at one), and the inequality is strict.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI,
  MAX_SUBMISSIONS_PER_SEQUENCE,
  PROTECT_SUBMISSIONS_PER_POSITION,
  checkLpNativeCapSizing,
  resolveLpRelayFeePerSubmitWei,
} from "../src/ops/policy.js";

const FEE = DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
const OPEN = 10n ** 16n; // 0.01 BNB open budget

/**
 * The exact requirement for N sequences (and P open positions, default 1) at
 * the default constants — the A3 protect term included.
 */
function required(open: bigint, sequences: number, feeBps = 0, positions = 1): bigint {
  return (
    open +
    (open * BigInt(feeBps)) / 10_000n +
    BigInt(sequences) * BigInt(MAX_SUBMISSIONS_PER_SEQUENCE) * FEE +
    BigInt(Math.max(1, positions)) * BigInt(PROTECT_SUBMISSIONS_PER_POSITION) * FEE
  );
}

describe("checkLpNativeCapSizing", () => {
  it("pins MAX_SUBMISSIONS_PER_SEQUENCE to the rotate plan's length (3)", () => {
    // zap-out, sweep, mint — the worst case (Rev2 item 12). The saga runner's
    // rotate plan is exactly this long; drift in either place fails a test.
    assert.equal(MAX_SUBMISSIONS_PER_SEQUENCE, 3);
  });

  it("pins PROTECT_SUBMISSIONS_PER_POSITION to the exit plan's length (2)", () => {
    // PHASE3.1 Rev2 item 18, the ERRATUM to audit A3 and its fix-review, both
    // of which assert "exactly one step": the protect/manual-exit plan is
    // `[zap-out, sweep-token]` from 3.1 on, because a stop-loss that returns
    // the volatile leg has done half its job. The reserve's exempt term must
    // not drift from the plan.
    assert.equal(PROTECT_SUBMISSIONS_PER_POSITION, 2);
    // And MAX_SUBMISSIONS_PER_SEQUENCE stays 3: rotate is still the worst
    // case, the exit is now two.
    assert.ok(PROTECT_SUBMISSIONS_PER_POSITION < MAX_SUBMISSIONS_PER_SEQUENCE);
  });

  it("an agent that PASSED under Phase 3's one-submission exit is refused now (Rev2 item 19)", () => {
    // The exact pre-3.1 requirement, +1 wei: open + N×3×fee + P×1×fee.
    const preciselyPhase3 =
      OPEN + 4n * BigInt(MAX_SUBMISSIONS_PER_SEQUENCE) * FEE + 1n * FEE + 1n;
    const now = checkLpNativeCapSizing({
      onChainDailyCapWei: preciselyPhase3,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      openPositionsCount: 1,
    });
    assert.equal(now.ok, false, "the second exit submission needs its own headroom");
    if (!now.ok) {
      assert.match(now.message, /short by 100000000000000 wei/);
      assert.match(now.message, /two-step exit/);
    }
    // One more submission's worth of cap and it passes again.
    const widened = checkLpNativeCapSizing({
      onChainDailyCapWei: preciselyPhase3 + FEE,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      openPositionsCount: 1,
    });
    assert.equal(widened.ok, true);
  });

  it("passes when the cap strictly exceeds open + fee + N×3×perSubmit", () => {
    const result = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 4) + 1n,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
    });
    assert.deepEqual(result, { ok: true });
  });

  it("refuses at exact equality — the inequality is strict", () => {
    const result = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 4),
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /short by 1 wei/);
      assert.match(result.message, /floor,\s*not a guarantee/i);
    }
  });

  it("derives N from maxExitSequencesPerDay — harvest shares the quota, no separate allowance", () => {
    // Covers N=8 but not N=9: raising the setting one step flips the verdict.
    const cap = required(OPEN, 8) + 1n;
    const okAt8 = checkLpNativeCapSizing({
      onChainDailyCapWei: cap,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 8,
    });
    const failAt9 = checkLpNativeCapSizing({
      onChainDailyCapWei: cap,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 9,
    });
    assert.equal(okAt8.ok, true);
    assert.equal(failAt9.ok, false);
  });

  it("lets --expected-sequences-day RAISE N above the derived floor", () => {
    const cap = required(OPEN, 4) + 1n; // covers the floor exactly
    const raised = checkLpNativeCapSizing({
      onChainDailyCapWei: cap,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      expectedSequencesPerDay: 10,
    });
    assert.equal(raised.ok, false, "a raised N must demand more headroom");
    const covered = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 10) + 1n,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      expectedSequencesPerDay: 10,
    });
    assert.equal(covered.ok, true);
  });

  it("REFUSES --expected-sequences-day below the derived floor (raise-only, never silently ignored)", () => {
    const result = checkLpNativeCapSizing({
      // Generous cap: the refusal must come from the flag rule, not headroom.
      onChainDailyCapWei: required(OPEN, 100),
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      expectedSequencesPerDay: 2,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /only RAISE/i);
      assert.match(result.message, /floor 4/);
    }
  });

  it("counts the fee term on the open budget", () => {
    const withoutFee = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 4) + 1n,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      feeBps: 100,
    });
    assert.equal(withoutFee.ok, false, "a 1% fee needs 1% more headroom");
    const withFee = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 4, 100) + 1n,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      feeBps: 100,
    });
    assert.equal(withFee.ok, true);
  });

  it("scales with an overridden per-submission constant", () => {
    const perSubmit = FEE * 5n; // what a live-lp measurement might install
    const result = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 4) + 1n, // enough at the default only
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      lpRelayFeePerSubmitWei: perSubmit,
    });
    assert.equal(result.ok, false);
  });

  it("refuses malformed inputs instead of sizing on them", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const result = checkLpNativeCapSizing({
        onChainDailyCapWei: 10n ** 18n,
        openNativeBudgetWei: OPEN,
        maxExitSequencesPerDay: bad,
      });
      assert.equal(result.ok, false, `maxExitSequencesPerDay=${bad} must refuse`);
    }
    const badFlag = checkLpNativeCapSizing({
      onChainDailyCapWei: 10n ** 18n,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      expectedSequencesPerDay: 0,
    });
    assert.equal(badFlag.ok, false);
    const negative = checkLpNativeCapSizing({
      onChainDailyCapWei: -1n,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
    });
    assert.equal(negative.ok, false);
  });

  it("a zero-open-budget sizing still reserves saga gas", () => {
    // An LP agent whose position is already open re-runs the check at
    // /lp/settings with no new open budget; the gas reserve alone binds.
    const result = checkLpNativeCapSizing({
      onChainDailyCapWei: BigInt(4 * MAX_SUBMISSIONS_PER_SEQUENCE) * FEE,
      openNativeBudgetWei: 0n,
      maxExitSequencesPerDay: 4,
    });
    assert.equal(result.ok, false, "equality still refuses at zero budget");
  });

  /* ----- the protect term (audit A3) -------------------------------------- */

  it("reserves quota-exempt protect gas even when the N term is fully covered (audit A3)", () => {
    // A cap that covers open + N×3×fee EXACTLY (the pre-A3 requirement, +1)
    // must now refuse: the protect draws the same meter and is quota-exempt,
    // so without its own headroom the stop-loss lands gasless on a crash day.
    const preA3 = OPEN + 4n * BigInt(MAX_SUBMISSIONS_PER_SEQUENCE) * FEE + 1n;
    const result = checkLpNativeCapSizing({
      onChainDailyCapWei: preA3,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /protect headroom/i);
      assert.match(result.message, /quota-exempt/i);
    }
    const covered = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 4) + 1n, // helper includes P=1
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
    });
    assert.equal(covered.ok, true);
  });

  it("openPositionsCount scales the protect term: more open positions demand more headroom", () => {
    const capForOne = required(OPEN, 4, 0, 1) + 1n;
    const okAtOne = checkLpNativeCapSizing({
      onChainDailyCapWei: capForOne,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      openPositionsCount: 1,
    });
    const failAtThree = checkLpNativeCapSizing({
      onChainDailyCapWei: capForOne,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      openPositionsCount: 3,
    });
    const coveredAtThree = checkLpNativeCapSizing({
      onChainDailyCapWei: required(OPEN, 4, 0, 3) + 1n,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      openPositionsCount: 3,
    });
    assert.equal(okAtOne.ok, true);
    assert.equal(failAtThree.ok, false, "each open position adds one exit submission's gas");
    assert.equal(coveredAtThree.ok, true);
  });

  it("openPositionsCount floors at 1 — provisioning before any open still reserves one exit", () => {
    // Zero and omitted must size identically: the open that follows
    // provisioning creates exactly one position, and a zero protect reserve
    // would re-open A3 for it.
    const cap = required(OPEN, 4, 0, 1) + 1n;
    const zero = checkLpNativeCapSizing({
      onChainDailyCapWei: cap,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      openPositionsCount: 0,
    });
    const omitted = checkLpNativeCapSizing({
      onChainDailyCapWei: cap,
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
    });
    assert.equal(zero.ok, true);
    assert.equal(omitted.ok, true);
    const short = checkLpNativeCapSizing({
      onChainDailyCapWei: cap - 1n, // exact equality: strict inequality refuses
      openNativeBudgetWei: OPEN,
      maxExitSequencesPerDay: 4,
      openPositionsCount: 0,
    });
    assert.equal(short.ok, false);
  });

  it("refuses a malformed openPositionsCount instead of sizing on it", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const result = checkLpNativeCapSizing({
        onChainDailyCapWei: 10n ** 18n,
        openNativeBudgetWei: OPEN,
        maxExitSequencesPerDay: 4,
        openPositionsCount: bad,
      });
      assert.equal(result.ok, false, `openPositionsCount=${bad} must refuse`);
    }
  });
});

describe("resolveLpRelayFeePerSubmitWei", () => {
  it("defaults to the 0.0001 BNB placeholder when unset or blank", () => {
    assert.equal(resolveLpRelayFeePerSubmitWei({}), FEE);
    assert.equal(
      resolveLpRelayFeePerSubmitWei({ LP_RELAY_FEE_PER_SUBMIT_WEI: "  " }),
      FEE,
    );
    assert.equal(FEE, 100_000_000_000_000n);
  });

  it("reads a valid override", () => {
    assert.equal(
      resolveLpRelayFeePerSubmitWei({ LP_RELAY_FEE_PER_SUBMIT_WEI: "42000" }),
      42_000n,
    );
  });

  it("throws on malformed values — a defaulted rail is a rail that stopped existing", () => {
    for (const bad of ["0", "-5", "1.5", "1e18", "0x10", "lots"]) {
      assert.throws(() =>
        resolveLpRelayFeePerSubmitWei({ LP_RELAY_FEE_PER_SUBMIT_WEI: bad }),
      );
    }
  });
});
