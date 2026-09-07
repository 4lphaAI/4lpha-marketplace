/**
 * ONE valuation of an LP position, and ONE exit-impact probe (PHASE3.4,
 * decision 11 + Rev2 M9).
 *
 * WHY THIS MODULE EXISTS, stated once so a future reader does not "simplify" it
 * back into the worker: the owner signs a `basisWei` at `POST /lp/import`
 * against a number the PREVIEW showed them, and the trigger later compares that
 * basis against `exitValueWei` to decide whether to liquidate. If two code paths
 * compute those two numbers, the stop-loss the owner configured is not the
 * stop-loss that fires. The arithmetic below was extracted verbatim from the
 * worker's own valuation block, which remains its only other caller.
 *
 * The valuation is: principal from `getAmountsForLiquidity` at the FINALIZED
 * spot, exact uncollected fees from the `collect` simulation, and the token leg
 * quoted into WBNB through QuoterV2. Fees are part of the exit value because
 * they are part of what an exit returns.
 *
 * The probe is the EXIT swap's own reading, run at admission: quote the token
 * leg the exit would have to swap, deduct the pool fee exactly as
 * `makeExitSwapStep` deducts it, and compare to the rail. It is what discharges
 * PHASE3.1-AUDIT A7's obligation for a SECOND admission surface — A7's ordering
 * argument ("nothing can be admitted that cannot later be exited") named
 * `/lp/open` as the only one, and import is not entitled to inherit the
 * conclusion for free.
 */

import type { Address } from "viem";

import type { LpPositionSnapshot, LpQuoteReader } from "./sagas.js";
import {
  amountInAfterPoolFee,
  quotePriceImpactBps,
  spotSwapOutput,
} from "./rails.js";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "./tickMath.js";

/** The chain reads a valuation needs. A subset of `LpChainReaders`. */
export type LpValuationReaders = {
  readonly positions: (tokenId: bigint) => Promise<LpPositionSnapshot | "burned">;
  readonly positionFees: (
    tokenId: bigint,
    wallet: Address,
  ) => Promise<{ amount0Wei: bigint; amount1Wei: bigint } | "burned">;
  readonly quote: LpQuoteReader;
};

export type LpValuationInput = {
  readonly tokenId: bigint;
  readonly wallet: Address;
  /** The pool's fee tier in millionths — the quote hop and the fee deduction. */
  readonly fee: number;
  /** The non-WBNB leg. */
  readonly token: Address;
  readonly wbnb: Address;
  readonly wbnbIsToken0: boolean;
  /** The FINALIZED spot the caller already read; never re-read here. */
  readonly spotSqrtPriceX96: bigint;
};

export type LpValuation = {
  readonly snapshot: LpPositionSnapshot;
  readonly collectibleFee0: bigint;
  readonly collectibleFee1: bigint;
  /** Principal + fees, per leg. */
  readonly wbnbTotalWei: bigint;
  readonly tokenTotalWei: bigint;
  /** Both legs, quoted into WBNB wei. */
  readonly exitValueWei: bigint;
  readonly freshFeesValueWei: bigint;
};

/**
 * Value the position, or answer `"burned"` when the token does not exist.
 *
 * A QuoterV2 revert is NOT caught here and that is deliberate (Rev2 M9): a
 * valuation that cannot price the token leg has not proved anything, and every
 * caller's correct response is to hold or refuse — never to pass with a partial
 * number. The worker's existing behaviour on a throwing read is unchanged.
 */
export async function valueLpPosition(
  readers: LpValuationReaders,
  input: LpValuationInput,
): Promise<LpValuation | "burned"> {
  const snapshot = await readers.positions(input.tokenId);
  if (snapshot === "burned") return "burned";
  const fees = await readers.positionFees(input.tokenId, input.wallet);
  if (fees === "burned") return "burned";

  const principal =
    snapshot.liquidity > 0n
      ? getAmountsForLiquidity(
          input.spotSqrtPriceX96,
          snapshot.tickLower,
          snapshot.tickUpper,
          snapshot.liquidity,
        )
      : { amount0: 0n, amount1: 0n };

  const wbnbTotalWei = input.wbnbIsToken0
    ? principal.amount0 + fees.amount0Wei
    : principal.amount1 + fees.amount1Wei;
  const tokenTotalWei = input.wbnbIsToken0
    ? principal.amount1 + fees.amount1Wei
    : principal.amount0 + fees.amount0Wei;
  const wbnbFees = input.wbnbIsToken0 ? fees.amount0Wei : fees.amount1Wei;
  const tokenFees = input.wbnbIsToken0 ? fees.amount1Wei : fees.amount0Wei;

  const quoteToWbnb = async (amountInWei: bigint): Promise<bigint> =>
    amountInWei > 0n
      ? readers.quote({
          tokenIn: input.token,
          tokenOut: input.wbnb,
          fee: input.fee,
          amountInWei,
        })
      : 0n;

  return {
    snapshot,
    collectibleFee0: fees.amount0Wei,
    collectibleFee1: fees.amount1Wei,
    wbnbTotalWei,
    tokenTotalWei,
    exitValueWei: wbnbTotalWei + (await quoteToWbnb(tokenTotalWei)),
    freshFeesValueWei: wbnbFees + (await quoteToWbnb(tokenFees)),
  };
}

export type LpExitProbe = {
  /** The token amount priced. Zero ⇒ nothing to swap; the probe is vacuous. */
  readonly amountInWei: bigint;
  readonly quotedOutWei: bigint;
  readonly impactBps: bigint;
  readonly maxImpactBps: number;
  readonly withinRail: boolean;
};

/**
 * Price the token leg an exit would swap, at the EXIT's own reading.
 *
 * `amountInAfterPoolFee` is the whole erratum PHASE3.1 Rev2 item 16 landed: the
 * pool's own fee is not price impact, and counting it as impact measured
 * 1/5/25/103 bps for the 100/500/2500/10000 tiers on a live pool. Deducting it
 * here is what makes this probe the same test the exit will apply, rather than
 * `/lp/open`'s stricter one — which is the point. An import must prove the
 * position can be got OUT; it is not creating a position, so open's
 * about-to-execute strictness would refuse positions the owner already holds
 * and can already exit.
 *
 * A zero amount answers `withinRail: true` with zero impact: there is no swap to
 * refuse. That is the all-WBNB composition, and the exit's own swap step skips
 * on the same emptiness.
 */
export async function probeLpExitImpact(
  quote: LpQuoteReader,
  input: {
    readonly amountInWei: bigint;
    readonly fee: number;
    readonly token: Address;
    readonly wbnb: Address;
    readonly spotSqrtPriceX96: bigint;
    /** True when the TOKEN leg (the input of this swap) is the pool's token0. */
    readonly tokenIsToken0: boolean;
    readonly maxImpactBps: number;
  },
): Promise<LpExitProbe> {
  if (input.amountInWei <= 0n) {
    return {
      amountInWei: 0n,
      quotedOutWei: 0n,
      impactBps: 0n,
      maxImpactBps: input.maxImpactBps,
      withinRail: true,
    };
  }
  const quotedOutWei = await quote({
    tokenIn: input.token,
    tokenOut: input.wbnb,
    fee: input.fee,
    amountInWei: input.amountInWei,
  });
  const expectedAtSpot = spotSwapOutput({
    amountInAfterFee: amountInAfterPoolFee(input.amountInWei, input.fee),
    sqrtPriceX96: input.spotSqrtPriceX96,
    tokenInIsToken0: input.tokenIsToken0,
  });
  const impactBps = quotePriceImpactBps(expectedAtSpot, quotedOutWei);
  return {
    amountInWei: input.amountInWei,
    quotedOutWei,
    impactBps,
    maxImpactBps: input.maxImpactBps,
    withinRail: impactBps <= BigInt(input.maxImpactBps),
  };
}

/**
 * The LARGEST token amount this position can ever hold — its all-token
 * composition at the range edge (Rev2 M9).
 *
 * Disclosure, never a refusal. The probe above sizes the swap at TODAY's mix,
 * but a stop-loss fires after the price fell, by which time a two-sided position
 * has converged toward exactly this amount: the largest swap the exit will ever
 * need, at worse depth. A position imported while 90% WBNB-side probes a sliver
 * and passes, and its eventual protect swaps the whole principal — where the
 * exit's impact rail SKIPS the conversion and hands the owner the token they
 * stopped out of, which is FINDINGS (ag) for that owner.
 *
 * `/lp/open` has the identical blind spot (it also prices only its own leg), so
 * this is not a class import creates and the refusal stays at the current-mix
 * reading. What import adds is pools open would have refused, where the skip is
 * structurally likelier — so the preview says so.
 *
 * WHICH EDGE, corrected from the review's wording (it says `tickLower`, which
 * holds only when the token is `token0`). A V3 pool prices `token1/token0`, so
 * below the range a position is 100% `token0` and above it 100% `token1`. The
 * TOKEN leg is therefore maximised at `tickLower` when the token is `token0`
 * and at `tickUpper` when the token is `token1` — and taking the lower edge
 * unconditionally would report the WBNB-side sliver as the worst case for
 * exactly half of all pools, which is the opposite of the disclosure this is
 * for. The intent is unchanged: quote the composition a stop-loss converges to.
 */
export function maxTokenAmountWei(input: {
  readonly snapshot: LpPositionSnapshot;
  readonly wbnbIsToken0: boolean;
}): bigint {
  if (input.snapshot.liquidity <= 0n) return 0n;
  const tokenIsToken0 = !input.wbnbIsToken0;
  const edgeTick = tokenIsToken0
    ? input.snapshot.tickLower
    : input.snapshot.tickUpper;
  const amounts = getAmountsForLiquidity(
    getSqrtRatioAtTick(edgeTick),
    input.snapshot.tickLower,
    input.snapshot.tickUpper,
    input.snapshot.liquidity,
  );
  return tokenIsToken0 ? amounts.amount0 : amounts.amount1;
}
