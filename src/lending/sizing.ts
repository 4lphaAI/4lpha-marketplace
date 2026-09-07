/**
 * The lending guard's planner — the pure layer
 * (MARKETPLACE-LENDING-AGENT §5.2–§5.3, corrected by R2.6, R2.7, R2.8, R2.12,
 * R2.21, R3.1, R3.5, R3.6, R3.10, R3.12, L10).
 *
 * ═══ WHAT THIS LAYER OWNS, AND WHAT IT DOES NOT ═══════════════════════════
 *
 * It owns the ARITHMETIC: how much of A's debt this reserve can retire, where
 * that money has to come from, and what the swap solver must ask for. It owns
 * no chain reads and no clock — every quantity is an argument, so the tables in
 * `test/lending.planner.test.ts` mean something.
 *
 * The AMOUNT is still sized by Phase 4's `sizeVenusRepay`, unchanged: the
 * closed form proposes, the recompute decides, and a partial rescue reports the
 * HF it actually achieves. What this module adds is the `reserveCapacityWei`
 * term that form now takes (R3.6) and the batch composition that makes the
 * amount payable.
 *
 * ═══ THE FIVE RULES THAT ARE EASY TO GET WRONG ════════════════════════════
 *
 *  1. **The native floor is applied ONCE, inside `tierBnb`** (R2.8), and it is
 *     COUNT-AWARE: `max(1, rescueReserveCount - rescuesChargedInWindow)`
 *     submissions' worth, because a day of six rescues has already drawn six
 *     relay reimbursements out of the same balance. The caller passes
 *     `context.walletNativeFloorWei = 0n` so `sizeVenusRepay` cannot subtract
 *     it a second time.
 *  2. **A floor-clamped rescue SUBMITS THE REDUCED AMOUNT, never refuses**
 *     (R2.8, R3.10). Refusing the rescue is the trap the whole phase exists to
 *     avoid, so every clamp in this module produces a smaller submission plus a
 *     reported condition.
 *  3. **The swap solver is INPUT-FIRST with a slippage pad, and its
 *     `amountOutMinimum` is the REQUIREMENT, never the quote** (R2.7). A
 *     quote-derived floor would let the batch's own downstream leg go short.
 *  4. **`r` is clamped 10 bps BELOW `borrowCurrent_A` when the two would be
 *     equal** (R2.6). A is a third party whose debt can FALL between the sizing
 *     block and inclusion — A repays, a liquidator repays at exactly the
 *     trigger, another guard repays — and the full-size repay is the only shape
 *     that reverts on ANY downward move. The clamp never applies below
 *     {@link LENDING_MIN_REPAY_WEI}, where a debt is `guarded-no-debt` rather
 *     than a refusal (L10).
 *  5. **An unreadable spend meter OMITS its term and reports
 *     `cap-unreadable`; it NEVER refuses a rescue** (R3.5). "Mandatory" means
 *     the read is attempted and reported, not that its absence blocks.
 */
import type { Address } from "viem";

import {
  LENDING_MIN_REPAY_WEI,
  RELAY_FEE_PER_EXIT_WEI,
  walletNativeFloorWei,
} from "../ops/policy.js";
import { sagaSwapMinOut } from "../lp/rails.js";
import type { LendingCondition, LendingReserveReading, LendingTokenMeterReading } from "./types.js";

/** `ceil(a / b)` for positive `b`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive.");
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

function clampAtZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;

/* -------------------------------------------------------------------------- */
/* The BNB tier (R2.8)                                                        */
/* -------------------------------------------------------------------------- */

export type LendingTierInput = {
  /** B's native balance at the pinned block. */
  readonly nativeBalanceWei: bigint;
  /** `rescueReserveCount` from the owner's settings. */
  readonly rescueReserveCount: number;
  /** Rescue submissions already charged in the rolling 24 h window. */
  readonly rescuesChargedInWindow: number;
  /**
   * R2.21 — the arm's own `msg.value`, subtracted while the arm is ambiguous
   * and the evidence does NOT show it landed. `0n` on every other path.
   */
  readonly outstandingArmNativeWei: bigint;
};

export type LendingTier = {
  readonly tierBnbWei: bigint;
  readonly floorWei: bigint;
  readonly reservedSubmissions: number;
};

/**
 * The spendable BNB tier, with the wallet floor applied ONCE and count-aware.
 *
 * The static form Revision 1 shipped kept reserving the FULL
 * `rescueReserveCount` after the rescues had already fired, which both
 * over-reserves late in the day and — as REVIEW H6 put it — never sees the
 * first rescue's own consumption again.
 */
export function lendingTier(input: LendingTierInput): LendingTier {
  const outstanding = Math.max(
    1,
    input.rescueReserveCount - Math.max(0, input.rescuesChargedInWindow),
  );
  const floorWei =
    walletNativeFloorWei() + BigInt(outstanding) * RELAY_FEE_PER_EXIT_WEI;
  const tierBnbWei = clampAtZero(
    input.nativeBalanceWei - floorWei - clampAtZero(input.outstandingArmNativeWei),
  );
  return { tierBnbWei, floorWei, reservedSubmissions: outstanding };
}

/* -------------------------------------------------------------------------- */
/* The swap solver (R3.10, closing REVIEW2 M6)                                */
/* -------------------------------------------------------------------------- */

export type SwapInForInput = {
  /** The output the batch REQUIRES, in the output token's units. */
  readonly needWei: bigint;
  /** Everything the input side can spend. The clamp ceiling. */
  readonly availableWei: bigint;
  /** `rails.maxSagaSlippageBps`. */
  readonly slippageBps: number;
  /**
   * The last observed pool price as `outputPerInput` scaled by 1e18, used ONLY
   * to SEED the search. `null` when `slot0` was unreadable, in which case the
   * seed is `availableWei` and the first quote decides.
   */
  readonly seedPriceE18: bigint | null;
  /**
   * The pool's fee in millionths (the Pancake V3 tier: 100, 500, 2 500,
   * 10 000). The SEED must carry it (AUDIT A-H1): `slot0` prices the pool
   * BEFORE its own fee, so a seed derived from it quotes back
   * `price x (1 - fee)` and misses the requirement DETERMINISTICALLY on every
   * fee-bearing pool. Defaults to `0`, which is only correct for a fee-less
   * fixture.
   */
  readonly poolFeePpm?: number;
  /** `quote(amountIn) -> amountOut`. Called at most {@link SWAP_SOLVER_MAX_QUOTES} times. */
  readonly quote: (amountInWei: bigint) => Promise<bigint>;
};

/** The solver's whole read budget for one leg, in quotes. */
export const SWAP_SOLVER_MAX_QUOTES = 6;

export type SwapInForResult = {
  /** What to feed the swap. */
  readonly amountInWei: bigint;
  /** `amountOutMinimum` — the REQUIREMENT when satisfied, the padded quote
   * when the solver had to clamp. */
  readonly minOutWei: bigint;
  /** `true` when the solver could not reach `needWei` and clamped (R3.10). */
  readonly clamped: boolean;
  /** How many quotes were spent. Reported so a cycle's read budget is visible. */
  readonly quotes: number;
};

/**
 * Solve for the smallest input whose slippage-floored quote covers `needWei`.
 *
 * ═══ THE ALGORITHM, WRITTEN DOWN (R3.10, corrected by AUDIT A-H1) ════════
 *
 * ```
 * padded = ceil(need x 10_000 / (10_000 - slip))          // the slippage rail
 * grossed = ceil(padded x 1e6 / (1e6 - poolFeePpm))       // the pool's own fee
 * seed   = min(available, grossed / lastObservedPrice)
 * q0     = quote(seed)
 * if minOut(q0) >= need:  bisect DOWN  in (0, seed]
 * else:                   q1 = quote(available)
 *      if minOut(q1) >= need: bisect UP in (seed, available]
 *      else: CLAMP to available, minOut = minOut(q1)     // condition reserve-low
 * ```
 *
 * ═══ WHY THE SEED CARRIES THE FEE ════════════════════════════════════════
 *
 * `slot0` prices the pool BEFORE its own fee, so a seed derived from it quotes
 * back `price x (1 - fee)`, and `minOut(quote(seed)) = need x (1 - fee) x
 * (1 - slip) < need` on EVERY fee-bearing pool. The original code took that
 * deterministic miss as proof that the requirement was out of reach and set
 * `amountIn = available` — the WHOLE remaining side — so a rescue that needed
 * 15 USDT converted the entire BNB tier, and a BNB rescue redeemed and sold the
 * WHOLE USDT reserve. Never a custody loss; always the wrong size, and one that
 * spends the day's caps on the way past.
 *
 * ═══ WHY A MISS NOW SEARCHES UP INSTEAD OF SPENDING EVERYTHING ═══════════
 *
 * A seed miss says one thing: the seed is too small. `available` is the only
 * other input we know anything about, so the solver asks it — and if IT can
 * satisfy the requirement, the answer is somewhere in between and worth up to
 * four more quotes to find. The clamp survives for the one case it was ever
 * about: `available` itself cannot reach `need`.
 *
 * MONOTONICITY IS ASSUMED AND STATED: output is non-decreasing in input for a
 * single V3 pool. That is what makes a bisection meaningful, what makes an
 * `available` miss conclusive, and what makes the clamp branch's answer the
 * best one available. It holds for a constant-product/concentrated pool with a
 * fixed fee; it would NOT hold across a router that re-splits by size, which is
 * why this solver quotes ONE pool.
 *
 * The miss branch CLAMPS; it never refuses. Revision 2's "two iterations max,
 * else refuse" contradicted R2.8's own ruling two subsections later, and a
 * solver detail is not a reason to leave A unrescued.
 */
export async function swapInFor(input: SwapInForInput): Promise<SwapInForResult> {
  if (input.needWei <= 0n) {
    return { amountInWei: 0n, minOutWei: 0n, clamped: false, quotes: 0 };
  }
  if (input.availableWei <= 0n) {
    return { amountInWei: 0n, minOutWei: 0n, clamped: true, quotes: 0 };
  }
  const padded = ceilDiv(
    input.needWei * 10_000n,
    BigInt(10_000 - input.slippageBps),
  );
  const feePpm = BigInt(Math.max(0, Math.min(999_999, input.poolFeePpm ?? 0)));
  const grossed = ceilDiv(padded * 1_000_000n, 1_000_000n - feePpm);
  const seed =
    input.seedPriceE18 === null || input.seedPriceE18 <= 0n
      ? input.availableWei
      : (() => {
          const fromPrice = ceilDiv(grossed * E18, input.seedPriceE18);
          return fromPrice < input.availableWei ? fromPrice : input.availableWei;
        })();
  const seedIn = seed > 0n ? seed : input.availableWei;

  let quotes = 0;
  const quoteAt = async (amountInWei: bigint): Promise<bigint> => {
    quotes += 1;
    return input.quote(amountInWei);
  };
  const satisfies = (quoted: bigint): boolean =>
    quoted > 0n && sagaSwapMinOut(quoted, input.slippageBps) >= input.needWei;

  // `lo` is the largest input KNOWN not to satisfy (exclusive); `hi` the
  // smallest KNOWN to satisfy. `hi === null` means nothing satisfying is known.
  let lo = 0n;
  let hi: bigint | null = null;

  const q0 = await quoteAt(seedIn);
  if (satisfies(q0)) {
    hi = seedIn;
  } else {
    lo = seedIn;
    if (seedIn < input.availableWei) {
      const qFull = await quoteAt(input.availableWei);
      if (satisfies(qFull)) {
        hi = input.availableWei;
      } else {
        // CLAMP AND SUBMIT. `minOut` becomes the padded quote of everything
        // available, because the requirement is provably out of reach here.
        if (qFull <= 0n) {
          return { amountInWei: 0n, minOutWei: 0n, clamped: true, quotes };
        }
        return {
          amountInWei: input.availableWei,
          minOutWei: sagaSwapMinOut(qFull, input.slippageBps),
          clamped: true,
          quotes,
        };
      }
    } else {
      // The seed WAS everything available and it does not reach the
      // requirement: the same clamp, one quote cheaper.
      if (q0 <= 0n) {
        return { amountInWei: 0n, minOutWei: 0n, clamped: true, quotes };
      }
      return {
        amountInWei: input.availableWei,
        minOutWei: sagaSwapMinOut(q0, input.slippageBps),
        clamped: true,
        quotes,
      };
    }
  }

  // Bisect for the SMALLEST satisfying input inside the remaining budget. A
  // tighter input leaves more of the reserve where it was, which is strictly
  // better for the owner; every step keeps a known-satisfying `hi`, so the
  // answer can only improve and can never become unfundable.
  let best: bigint = hi;
  while (quotes < SWAP_SOLVER_MAX_QUOTES) {
    const gap: bigint = best - lo;
    // Stop when the remaining window is under ~1.5 % of the answer: further
    // quotes cost a chain read each and buy nothing the owner can feel.
    if (gap <= best / 64n || gap <= 1n) break;
    const mid: bigint = lo + gap / 2n;
    if (mid <= lo || mid >= best) break;
    const quoted = await quoteAt(mid);
    if (satisfies(quoted)) best = mid;
    else lo = mid;
  }

  return { amountInWei: best, minOutWei: input.needWei, clamped: false, quotes };
}

/**
 * The pool's last observed price as `outputPerInput`, 1e18-scaled, from
 * `slot0().sqrtPriceX96`.
 *
 * `sqrtPriceX96` is `sqrt(token1/token0) * 2^96`, so `price1per0 =
 * (sqrtP/2^96)^2`. The division order below keeps every intermediate inside
 * bigint without overflowing the 1e18 scale.
 */
export function poolPriceE18(
  sqrtPriceX96: bigint,
  inputIsToken0: boolean,
): bigint | null {
  if (sqrtPriceX96 <= 0n) return null;
  // price1per0 = sqrtP^2 * 1e18 / 2^192, computed in two halves.
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const price1per0 = (numerator * E18) / (Q96 * Q96);
  if (inputIsToken0) return price1per0 > 0n ? price1per0 : null;
  if (price1per0 <= 0n) return null;
  return (E18 * E18) / price1per0;
}

/* -------------------------------------------------------------------------- */
/* Reserve capacity per debt token (§5.3)                                     */
/* -------------------------------------------------------------------------- */

export type LendingCapacityInput = {
  readonly reading: LendingReserveReading;
  readonly tier: LendingTier;
  readonly slippageBps: number;
  /**
   * What the BNB tier could buy in USDT, and what the USDT side could buy in
   * BNB, as already-floored figures. The caller quotes these once per cycle;
   * `0n` means "no quote available", which makes the capacity SMALLER and is
   * therefore the safe direction.
   */
  readonly tierToUsdtWei: bigint;
  readonly usdtToNativeWei: bigint;
};

export type LendingCapacity = {
  /** `min(suppliedUsdt, cash - 1)` — never the last wei of pool cash (§5.4). */
  readonly redeemableUsdtWei: bigint;
  readonly suppliedUsdtWei: bigint;
  readonly idleUsdtWei: bigint;
  /** Capacity to repay a USDT debt. */
  readonly usdtCapacityWei: bigint;
  /** Capacity to repay a BNB debt. */
  readonly nativeCapacityWei: bigint;
  /** `cash < suppliedUsdt`: the whole supply is not redeemable in one go. */
  readonly poolCashLow: boolean;
};

export function lendingCapacity(input: LendingCapacityInput): LendingCapacity {
  const { reading } = input;
  const suppliedUsdtWei =
    (reading.vUsdtBalance * reading.exchangeRateStored) / E18;
  // The §5.4 bound: NEVER the last wei of pool cash. A redeem that asks for all
  // of it races every other redeemer and reverts the whole atomic batch.
  const cashBound = clampAtZero(reading.cash - 1n);
  const redeemableUsdtWei =
    suppliedUsdtWei < cashBound ? suppliedUsdtWei : cashBound;
  return {
    redeemableUsdtWei,
    suppliedUsdtWei,
    idleUsdtWei: reading.usdtBalance,
    usdtCapacityWei:
      reading.usdtBalance + redeemableUsdtWei + input.tierToUsdtWei,
    nativeCapacityWei: input.tier.tierBnbWei + input.usdtToNativeWei,
    poolCashLow: reading.cash < suppliedUsdtWei,
  };
}

/* -------------------------------------------------------------------------- */
/* The overpay clamp (R2.6) and the dust floor (L10)                          */
/* -------------------------------------------------------------------------- */

export type OverpayClampResult = {
  readonly amountWei: bigint;
  readonly clamped: boolean;
};

/**
 * Hold `r` strictly below `borrowCurrent_A` when the two would be equal.
 *
 * ═══ WHY THIS IS NOT "THE OVERPAY IS UNREACHABLE" ════════════════════════
 *
 * Revision 1 said the overpay case could not arise and attributed that to
 * FINDINGS (at-2). The attribution was FABRICATED: (at-2) measured only vBNB
 * `repayBorrow{value}`, plain and delegated. The reviewer re-measured
 * `vBNB.repayBorrowBehalf` at 2x the debt and it REVERTS
 * (`REPAY_BORROW_NEW_ACCOUNT_BORROW_BALANCE_CALCULATION_FAILED`); the string is
 * ABSENT from the vUSDT implementation, so the ERC-20 overpay branch is
 * UNMEASURED and the build records it as such.
 *
 * More importantly the PREMISE does not transfer to guard-on-behalf at all: A
 * is a third party whose debt can FALL between the sizing block and inclusion.
 * `min(..., borrowCurrent_A)` is therefore a clamp, NOT a guarantee, and the
 * only shape that reverts on any downward move is the exactly-full repay. Ten
 * basis points under it is cheap insurance; the dust it leaves is reported.
 */
export function clampBelowBorrow(
  amountWei: bigint,
  borrowCurrentWei: bigint,
  minRepayWei: bigint,
): OverpayClampResult {
  if (amountWei < borrowCurrentWei) return { amountWei, clamped: false };
  if (borrowCurrentWei <= minRepayWei) {
    // L10: below the dust floor the clamp would yield `r = 0`, which
    // `sizeVenusRepay` surfaces as `insufficient-wallet-balance` — a wrong name
    // for a dust debt. The caller treats this as `guarded-no-debt`.
    return { amountWei: 0n, clamped: true };
  }
  const step = borrowCurrentWei / 1_000n;
  const back = step > 1n ? step : 1n;
  return { amountWei: borrowCurrentWei - back, clamped: true };
}

/** The per-token dust floor a debt must clear to be worth a relay fee (L10). */
export function lendingMinRepayFor(native: boolean): bigint {
  return native ? LENDING_MIN_REPAY_WEI.native : LENDING_MIN_REPAY_WEI.usdt;
}

/* -------------------------------------------------------------------------- */
/* The meter term (R3.5)                                                      */
/* -------------------------------------------------------------------------- */

export type MeterTerm = {
  /** `null` OMITS the term from the `min(...)`, exactly as Phase 4 documents. */
  readonly capRemainingWei: bigint | null;
  readonly condition: LendingCondition | null;
  readonly detail: string | null;
};

/**
 * Turn a meter reading into a clamp term, with the omit-and-report rule
 * written out.
 *
 * An UNREADABLE meter never refuses a rescue. That is the reconciliation
 * REVIEW2 M1 asked for between R2.3's word "mandatory" and
 * `src/venus/sizing.ts`'s normative "`null` OMITS the term rather than
 * treating it as unbounded": mandatory means the read is ATTEMPTED and
 * REPORTED, and the chain enforces the cap either way.
 */
export function meterTerm(
  reading: LendingTokenMeterReading,
  /**
   * Which meter this reading came from (AUDIT A-M4). The NATIVE meter used to
   * report `usdt-cap-exhausted` — a condition naming the wrong token, on the
   * one surface whose whole job is to tell the owner which cap to raise.
   */
  native = false,
): MeterTerm {
  const exhausted = native
    ? ("native-cap-exhausted" as const)
    : ("usdt-cap-exhausted" as const);
  switch (reading.kind) {
    case "day":
      return {
        capRemainingWei: reading.remainingWei,
        condition: reading.remainingWei === 0n ? exhausted : null,
        detail:
          reading.remainingWei === 0n
            ? `The rolling-day ${native ? "BNB" : "USDT"} cap of ${reading.limitWei} is spent `
              + `(${reading.currentSpentWei} used); it resets as the rolling day moves.`
            : null,
      };
    case "no-grant":
      return {
        capRemainingWei: null,
        condition: "cap-unreadable",
        detail:
          "The session holds no rolling-day row for this token; the chain will refuse the spend, and the term is omitted rather than guessed.",
      };
    case "other-period":
      return {
        capRemainingWei: null,
        condition: "cap-unreadable",
        detail:
          "The session's cap for this token is not a rolling DAY period; the term is omitted rather than compared across periods.",
      };
    default:
      return {
        capRemainingWei: null,
        condition: "cap-unreadable",
        detail: `The spend meter could not be read (${reading.detail}); the term is omitted and the rescue proceeds.`,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Market choice (§5.2)                                                       */
/* -------------------------------------------------------------------------- */

export type LendingDebtCandidate = {
  readonly vToken: Address;
  readonly native: boolean;
  readonly borrowCurrentWei: bigint;
  /** `borrow x debtPrice / 1e18` — the comparable figure across tokens. */
  readonly debtValueWei: bigint;
};

/**
 * The pinned debt market with the LARGEST debt value for A; ties by address.
 *
 * Deliberately NOT Phase 4's "rank by clamped effect": that ranking exists
 * because the Venus guard repays out of a wallet that may hold one underlying
 * and not the other. Here BOTH legs are funded from ONE reserve that can swap
 * between them, so every dollar repaid moves HF identically and the largest
 * debt is the one whose repay is least likely to be clamped by
 * `borrowCurrent`.
 */
export function chooseLendingDebtMarket(
  candidates: readonly LendingDebtCandidate[],
): LendingDebtCandidate | null {
  let best: LendingDebtCandidate | null = null;
  for (const candidate of candidates) {
    const minRepay = lendingMinRepayFor(candidate.native);
    if (candidate.borrowCurrentWei <= minRepay) continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.debtValueWei > best.debtValueWei) {
      best = candidate;
      continue;
    }
    if (
      candidate.debtValueWei === best.debtValueWei
      && candidate.vToken.toLowerCase() < best.vToken.toLowerCase()
    ) {
      best = candidate;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Batch composition (§5.3)                                                   */
/* -------------------------------------------------------------------------- */

export type UsdtLegPlan = {
  readonly takeIdleWei: bigint;
  readonly takeRedeemWei: bigint;
  /** > 0 only when the pool is short — the §5.4 fallback through the tier. */
  readonly takeSwapWei: bigint;
};

/** Where `r` USDT comes from: idle first, then the pool, then the BNB tier. */
export function planUsdtLegs(
  amountWei: bigint,
  capacity: LendingCapacity,
): UsdtLegPlan {
  const takeIdleWei = amountWei < capacity.idleUsdtWei ? amountWei : capacity.idleUsdtWei;
  const afterIdle = amountWei - takeIdleWei;
  const takeRedeemWei =
    afterIdle < capacity.redeemableUsdtWei ? afterIdle : capacity.redeemableUsdtWei;
  const takeSwapWei = clampAtZero(afterIdle - takeRedeemWei);
  return { takeIdleWei, takeRedeemWei, takeSwapWei };
}

export type NativeLegPlan = {
  readonly takeTierWei: bigint;
  /** What the swap must deliver as native. */
  readonly takeSwapOutWei: bigint;
};

/**
 * Where `r` BNB comes from: the tier first, then a USDT -> BNB swap.
 *
 * `takeSwapOutWei` is what the swap must DELIVER, and it becomes the
 * `amountOutMinimum` enforced INSIDE the same multicall — which is what makes
 * `value: r` on the vBNB call a lower bound the batch can always pay. The
 * unwrap's own `amountMinimum` is the weaker second check.
 */
export function planNativeLegs(
  amountWei: bigint,
  tier: LendingTier,
): NativeLegPlan {
  const takeTierWei = amountWei < tier.tierBnbWei ? amountWei : tier.tierBnbWei;
  return {
    takeTierWei,
    takeSwapOutWei: clampAtZero(amountWei - takeTierWei),
  };
}

/* -------------------------------------------------------------------------- */
/* The retire (R2.5 as amended by R3.12)                                      */
/* -------------------------------------------------------------------------- */

export type RetirePlan = {
  /** `min(suppliedUsdt, cash - 1)`. Zero when nothing is supplied. */
  readonly redeemAmountWei: bigint;
  /** `idleUsdt + redeemAmount` — EXACT, and it WILL exist after the redeem. */
  readonly swapInWei: bigint;
  readonly suppliedUsdtWei: bigint;
  /** `true` when the pool could not honour the whole supply (R3.12). */
  readonly poolShort: boolean;
  /** The remainder that stays supplied on Venus when `poolShort`. */
  readonly remainderUsdtWei: bigint;
  /** `true` only when there is literally nothing to submit. */
  readonly empty: boolean;
};

/**
 * Plan the retire from ONE pinned finalized read of B.
 *
 * ═══ WHY `redeemUnderlying` AND NOT `redeem` (OQ3, R2.5) ═════════════════
 *
 * With `redeem(vBal)` the amount of USDT that will exist after the call is not
 * known when the calldata is written, so the approve and the swap's `amountIn`
 * have to guess — which is exactly how Revision 1's retire came to swap only
 * the idle leg and strand ~80 % of the reserve while reporting `retired`. With
 * `redeemUnderlying(x)` the plane chooses `x`, so both are EXACT.
 *
 * ═══ POOL-SHORT SUBMITS THE PARTIAL (R3.12, closing REVIEW2 M8) ══════════
 *
 * Revision 2 refused a cash-short retire outright. That reading of "rather than
 * a failed batch" meant "submit nothing", so an owner whose vUSDT pool is 90 %
 * utilized — the state that CO-OCCURS with the crash this guard is for — could
 * retrieve nothing, not even the 90 % the pool can honour. And because §6.2's
 * browser recovery is the same shape, the passkey path inherited the refusal,
 * which removes the no-lock-in property the page advertises.
 *
 * So: submit the bounded partial, hold the guard at `retiring` with
 * `pool-cash-short` and the figures, and offer "retire again when the pool
 * refills". A hard refusal survives for exactly one case — nothing to submit at
 * all.
 */
export function planLendingRetire(reading: LendingReserveReading): RetirePlan {
  const suppliedUsdtWei =
    (reading.vUsdtBalance * reading.exchangeRateStored) / E18;
  const cashBound = clampAtZero(reading.cash - 1n);
  const redeemAmountWei =
    suppliedUsdtWei < cashBound ? suppliedUsdtWei : cashBound;
  const swapInWei = reading.usdtBalance + redeemAmountWei;
  return {
    redeemAmountWei,
    swapInWei,
    suppliedUsdtWei,
    poolShort: redeemAmountWei < suppliedUsdtWei,
    remainderUsdtWei: clampAtZero(suppliedUsdtWei - redeemAmountWei),
    empty: swapInWei <= 0n,
  };
}

/**
 * The retire's effect bound, RELATIVE (R3.12, closing REVIEW2 M9).
 *
 * `suppliedUsdt` is computed from `exchangeRateStored`, which is a LOWER bound
 * — the rate only rises — so the residue after a perfect `redeemUnderlying` is
 * `(current - stored) x vBal` plus rounding, and that term SCALES WITH THE
 * RESERVE while an absolute 0.01 USDT constant does not. On a quiet market and
 * a five-figure reserve the absolute bound would report "not retired" on a
 * retire that worked perfectly, and §6.1 offers Remove only from
 * `retired | closed` — so a successful retire would leave the wallet occupied
 * and the owner unable to hire anything else.
 */
export function retireCleared(
  suppliedAfterWei: bigint,
  suppliedBeforeWei: bigint,
  dustWei: bigint,
): boolean {
  const relative = suppliedBeforeWei / 10_000n;
  const bound = relative > dustWei ? relative : dustWei;
  return suppliedAfterWei <= bound;
}
