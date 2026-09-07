/**
 * Read-only derivation of the atomic LP-open call batch.
 *
 * Both the money path and D1's prepare diagnostic use this one planner.  It
 * owns no journal, store, signer, provider or relay capability.
 */
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { buildLpMintWbnbBatch, buildLpOpenBatch } from "../ops/nfpm.js";
import { buildApprove, buildWbnbDeposit } from "../ops/pancake.js";
import { buildPancakeV3Buy } from "../ops/pancakeV3.js";
import { V3_FEE_TIERS, type V3FeeTier } from "../ops/route.js";
import { quotePriceImpactBps, sagaMintFloors, sagaSingleSidedMintFloors,
  sagaSwapMinOut, spotSwapOutput, type LpRailConfig } from "./rails.js";
import { computeSwapAmount, getLiquidityForAmounts, getSqrtRatioAtTick } from "./tickMath.js";
import {
  gridDualSellClearanceOk,
  gridDualSwapInWei,
  gridSideChargesQuote,
  gridTargetSide,
  lpGridArmRefusal,
  lpGridDualArmBuyRefusal,
  lpGridDualArmSellRefusal,
} from "./gridTriggers.js";
import type { LpQuoteWithPriceAfterReader } from "./sagas.js";

/**
 * WHICH PLAN THIS BUILD IS FOR — an explicit, caller-supplied discriminant
 * (PHASE3.16 R2.4 / ruling D1), NEVER inferred from where the range sits
 * relative to the tick. An inference here is the 3.13 F4 shape: the same input
 * silently selecting a different money shape depending on a market read.
 *
 * `"two-sided-in-range"` — `POST /lp/open`'s plan, unchanged in every byte:
 * swap part of the budget, approve, mint two-sided into a range containing the
 * tick.
 *
 * `"grid-arm"` — PHASE3.16's plan: NO quote read, NO swap leg, NO approve. The
 * whole budget attaches as native to a single-sided mint into the signed
 * `buyRange`, whose side at the fresh tick must charge the quote.
 *
 * `"grid-arm-dual"` — PHASE3.17's plan: ONE submission that swaps half the
 * budget to the base token and mints BOTH of a crossed-pair grid's inner rungs.
 * The batch is pinned by R3.4 and reproduced verbatim in
 * {@link buildGridArmDualPlan}.
 *
 * `"grid-arm-ladder"` — PHASE3.19's plan (C1): a FIFTH discriminant with its
 * OWN builder, so {@link buildGridArmDualPlan} and the six calls
 * `test/lp.gridDual.test.ts:940-978` pins positionally stay BYTE-IDENTICAL.
 * FOUR conceptual legs — wrap the idle quote, swap the whole base half, mint the
 * SELL rung, mint the BUY rung — reproduced verbatim in
 * {@link buildGridArmLadderPlan}.
 */
export type LpOpenPlanMode =
  | "two-sided-in-range"
  | "grid-arm"
  | "grid-arm-dual"
  | "grid-arm-ladder"
  /**
   * PHASE3.22 R5 (body, as amended) — the SHIFT arm's plan kind.
   *
   * A SIXTH discriminant that DELEGATES to { buildGridArmLadderPlan}
   * VERBATIM. R5 says the shift arm "reuses the ladder arm VERBATIM": wrap the
   * idle quote, swap the whole base half, mint the SELL rung, mint the BUY rung
   * — every 3.19 item inherited BY REFERENCE rather than re-specified.
   *
   * IT IS A SEPARATE DISCRIMINANT RATHER THAN A REUSED ONE for the reason C1
   * gave the ladder its own: the mode a caller names is the mode the audit can
   * read back off the call site, and collapsing two products into one label
   * makes a future divergence a silent edit rather than a compile error. The
   * delegation is one line and is the whole implementation.
   */
  | "grid-arm-shift";

export type LpOpenPlanInput = {
  readonly mode: LpOpenPlanMode;
  readonly walletAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly wbnb: Address;
  readonly nfpm: Address;
  readonly routerV3: Address;
  readonly budgetWei: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly currentTick: number;
  readonly spotSqrtPriceX96: bigint;
  readonly deadline: bigint;
  readonly rails: LpRailConfig;
  readonly quote: (input: { readonly tokenIn: Address; readonly tokenOut: Address;
    readonly fee: number; readonly amountInWei: bigint }) => Promise<bigint>;
  /**
   * PHASE3.17 (review2 N16) — the DUAL arm's second range and its own reader.
   *
   * Present only on `mode: "grid-arm-dual"`; the two-sided and single-arm
   * branches never read them and are unchanged in every byte. `tickLower` /
   * `tickUpper` above carry level 1's `buyRange` (the native-attaching mint) and
   * these carry level 2's `sellRange2` (the base-attaching one), so the two
   * mints are named by the SAME field convention the single arm uses.
   */
  readonly sellTickLower?: number;
  readonly sellTickUpper?: number;
  /** The pool's own tick spacing, for R3.3's one-spacing clearance rule. */
  readonly tickSpacing?: number;
  /** R3.3's reader. Absent ⇒ the dual plan refuses before any money. */
  readonly quoteWithPriceAfter?: LpQuoteWithPriceAfterReader;
  /**
   * PHASE3.19 R4.2 — the SIGNED `grid.ladder.deployPctBps`.
   *
   * Present only on `mode: "grid-arm-ladder"`; absent ⇒ that plan refuses before
   * any money, exactly as an absent sell rung does. Every other branch ignores
   * it and is unchanged in every byte.
   */
  readonly deployPctBps?: number;
};

const FINAL_CALLS_PARAMETERS = [{ type: "tuple[]", components: [
  { name: "target", type: "address" }, { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
] }] as const;

/** The final-call witness shared by the submit and its prepare-only diagnostic. */
export function lpOpenPlanExecutionDataHash(calls: readonly WalletCall[]): Hex {
  if (calls.length === 0) throw new Error("LP final calls must not be empty.");
  return keccak256(encodeAbiParameters(FINAL_CALLS_PARAMETERS, [calls.map((call) => ({
    target: getAddress(call.to), value: call.value ?? 0n, data: call.data ?? "0x",
  }))]));
}

/**
 * The pool's legs and fee tier, with the two refusals both branches share.
 *
 * Extracted (PHASE3.16) so the grid branch can run them WITHOUT moving them on
 * the two-sided branch: they still execute at exactly the point they did, after
 * the in-range refusal, so the ORDER in which a two-sided caller meets its
 * refusals is byte-identical to Phase 3's.
 */
function resolvePoolLegs(input: LpOpenPlanInput): {
  readonly wbnbIsToken0: boolean;
  readonly token: Address;
  readonly feeTier: V3FeeTier;
} {
  const wbnbIsToken0 = input.token0.toLowerCase() === input.wbnb.toLowerCase();
  const token = wbnbIsToken0 ? input.token1 : input.token0;
  if (!wbnbIsToken0 && input.token1.toLowerCase() !== input.wbnb.toLowerCase()) {
    throw new Error("Position has no WBNB leg; v1 refuses pools without one.");
  }
  const feeTier = V3_FEE_TIERS.find((tier) => tier === input.fee);
  if (feeTier === undefined) throw new Error("Position fee is not a known V3 fee tier.");
  return { wbnbIsToken0, token, feeTier };
}

/**
 * PHASE3.16 — the GRID ARM's plan: one `mint{value}` plus `refundETH`, and
 * nothing else.
 *
 * G2, THE BUILD-SEAM GATE (R2.6). The side is re-derived here against the
 * caller's FRESH market read and must (a) exist — the tick strictly outside the
 * signed `buyRange` — and (b) charge the QUOTE leg, because quote is the only
 * asset the arm holds. Anything else throws ABOVE THE SUBMIT, which
 * `runLpOpen`'s positional classification turns into a zero-money rollback that
 * closes the never-funded lineage. There is nothing to hold: no prior step
 * committed anything.
 *
 * `sagaSingleSidedMintFloors` carries TWO refusals of its own for the same
 * geometric fact ("expects nothing on the declared side", "expects both legs").
 * Behind this gate they are UNREACHABLE — the gate has already proved the tick
 * is strictly outside — and they are a BACKSTOP, not a second refusal
 * authority. Stated so nobody reorders them in front of the gate, and so nobody
 * concludes {@link lpGridArmRefusal} is redundant and deletes it (C9).
 */
function buildGridArmPlan(input: LpOpenPlanInput): readonly WalletCall[] {
  const { wbnbIsToken0 } = resolvePoolLegs(input);
  const buyRange = { tickLower: input.tickLower, tickUpper: input.tickUpper };
  const side = gridTargetSide(input.currentTick, buyRange);
  if (side === undefined || !gridSideChargesQuote(side, wbnbIsToken0)) {
    throw new Error(
      lpGridArmRefusal({
        where: "mint",
        currentTick: input.currentTick,
        buyRange,
        side,
        wbnbIsToken0,
      }),
    );
  }
  // The charged leg is the WBNB one BY THE GATE ABOVE, so the budget lands
  // there and the other leg is a true zero — the shape `buildLpOpenBatch`
  // already accepts unedited, in BOTH pool orderings.
  const amount0 = wbnbIsToken0 ? input.budgetWei : 0n;
  const amount1 = wbnbIsToken0 ? 0n : input.budgetWei;
  // C9: the liquidity argument comes from `getLiquidityForAmounts` over the
  // single-sided amounts — the two-sided branch's own pattern, and the value
  // `sagaSingleSidedMintFloors` requires to be positive.
  const liquidity = getLiquidityForAmounts(input.spotSqrtPriceX96, input.tickLower,
    input.tickUpper, amount0, amount1);
  const floors = sagaSingleSidedMintFloors({ sqrtPriceX96: input.spotSqrtPriceX96,
    tickLower: input.tickLower, tickUpper: input.tickUpper, liquidity,
    maxSagaSlippageBps: input.rails.maxSagaSlippageBps, side });
  return buildLpOpenBatch({ nfpm: input.nfpm, token0: input.token0, token1: input.token1,
    wbnb: input.wbnb, fee: input.fee, tickLower: input.tickLower, tickUpper: input.tickUpper,
    amount0DesiredWei: amount0, amount1DesiredWei: amount1, amount0MinWei: floors.amount0Min,
    amount1MinWei: floors.amount1Min, recipient: input.walletAddress, deadline: input.deadline });
}

/**
 * PHASE3.17 R3.4 — the DUAL GRID ARM's plan: ONE atomic batch that funds BOTH
 * of a crossed-pair grid's inner rungs from one native budget.
 *
 * ─── THE PINNED CALL ORDER, quoted by every surface that mentions it ───────
 *
 * ```text
 * 1. {to: routerV3, value: swapInWei, data: multicall([exactInputSingle(WBNB->base,
 *      recipient=wallet, minOut), refundETH()])}          <- buildPancakeV3Buy
 * 2. approve(WBNB, nfpm, 0)                                ┐
 * 3. approve(base, nfpm, sellDesired = minOut)             ├ buildLpMintWbnbBatch
 * 4. {to: nfpm, data: mint(SELL inner rung)}               ┘ (its own emission
 * 5. {to: nfpm, value: budgetWei - swapInWei,                 order, unedited)
 *      data: mint(BUY inner rung)}                         ┐ buildLpOpenBatch
 * 6. {to: nfpm, data: refundETH()}                         ┘
 * ```
 *
 * **mint#1 = SELL (level 2's row), mint#2 = BUY (level 1's row)**, and the
 * caller's `mintedTokenIds` pairing plus its `sellTokenId < buyTokenId` assert
 * both quote this order. There is exactly ONE base approve: the buy mint is
 * single-sided QUOTE and needs none.
 *
 * ─── WHY EACH BUILDER, RATHER THAN THE OBVIOUS ONE ────────────────────────
 *
 * The SELL mint charges the BASE leg by construction (that is what its own gate
 * proves), so its WBNB leg is a true zero — and `buildLpOpenBatch` REFUSES a
 * zero WBNB leg outright, because there would be no native to attach. The
 * token-only shape is `buildLpMintWbnbBatch`, the one `runLpGridFlip`'s own
 * single-sided mint already uses. Its approves are ordered by ROLE (WBNB
 * first), which is the shape three sagas share and this phase does not edit.
 *
 * ─── NATIVE, AND WHY THERE IS NO WRAP CALL ────────────────────────────────
 *
 * Both native legs wrap inside the periphery's own `pay()`: the router's
 * `value` must equal `amountIn` EXACTLY or the swap silently stops being a
 * native buy, and the NFPM mint's `value` is its WBNB leg's desired. They sum
 * to exactly `budgetWei`, so `runLpOpen`'s `nativeSpendWei` — a plain sum of
 * attached values — records the whole owner-signed budget and the off-chain
 * daily-cap check is fed the real number. Both `refundETH`s are present and
 * each is the documented belt for its own contract.
 *
 * ─── THE TWO GATES, AT DIFFERENT PRICES AND DELIBERATELY SO (R3.3) ────────
 *
 * The BUY rung is gated on the PRE-swap tick and the SELL rung on the QUOTED
 * POST-SWAP price, because the arm's own swap moves the price toward the sell
 * rung and away from the buy rung in BOTH orientations. See
 * {@link gridDualSellClearanceOk} for the derivation and for why the sell rule
 * is written per orientation rather than once.
 *
 * Everything here throws ABOVE THE SUBMIT, which `runLpOpen`'s positional
 * classification turns into a zero-money rollback closing BOTH never-funded
 * rows through their `arm_group_id`.
 */
async function buildGridArmDualPlan(input: LpOpenPlanInput): Promise<readonly WalletCall[]> {
  const { wbnbIsToken0, token, feeTier } = resolvePoolLegs(input);
  const sellTickLower = input.sellTickLower;
  const sellTickUpper = input.sellTickUpper;
  const tickSpacing = input.tickSpacing;
  const quoteWithPriceAfter = input.quoteWithPriceAfter;
  if (
    sellTickLower === undefined
    || sellTickUpper === undefined
    || tickSpacing === undefined
  ) {
    throw new Error(
      "A dual grid arm needs level 2's sellRange2 and the pool's tick spacing; the plan refuses rather than minting one level of a two-level signature.",
    );
  }
  if (quoteWithPriceAfter === undefined) {
    // FAIL CLOSED. Without the post-swap price the sell rung's gate cannot run
    // at all, and its absence is precisely the systematic revert R3.3 exists to
    // prevent — so a missing reader refuses instead of degrading to the
    // pre-swap tick.
    throw new Error(
      "A dual grid arm needs the post-swap quote reader (quoteWithPriceAfter); without it the sell rung's gate cannot be evaluated and the arm refuses.",
    );
  }

  const buyRange = { tickLower: input.tickLower, tickUpper: input.tickUpper };
  const sellRange2 = { tickLower: sellTickLower, tickUpper: sellTickUpper };

  // G2-BUY, on the PRE-swap tick: the swap moves AWAY from this rung in both
  // orientations, monotonically, so a pre-swap verdict is preserved by it.
  const buySide = gridTargetSide(input.currentTick, buyRange);
  if (buySide === undefined || !gridSideChargesQuote(buySide, wbnbIsToken0)) {
    throw new Error(
      lpGridDualArmBuyRefusal({
        where: "mint",
        currentTick: input.currentTick,
        buyRange,
        side: buySide,
        wbnbIsToken0,
      }),
    );
  }

  const swapInWei = gridDualSwapInWei(input.budgetWei);
  const buyValueWei = input.budgetWei - swapInWei;
  if (swapInWei <= 0n || buyValueWei <= 0n) {
    throw new Error(
      "The dual arm's budget is too small to split: each level must receive a positive share.",
    );
  }
  const quoted = await quoteWithPriceAfter({
    tokenIn: input.wbnb,
    tokenOut: token,
    fee: input.fee,
    amountInWei: swapInWei,
  });
  const expectedAtSpot = spotSwapOutput({
    amountInAfterFee: swapInWei,
    sqrtPriceX96: input.spotSqrtPriceX96,
    tokenInIsToken0: wbnbIsToken0,
  });
  if (
    quotePriceImpactBps(expectedAtSpot, quoted.amountOutWei)
    > BigInt(input.rails.maxPriceImpactBps)
  ) {
    throw new Error(
      "Quoted price impact of the dual arm's swap leg exceeds the manipulation-rail ceiling.",
    );
  }

  // G2-SELL, on the QUOTED POST-SWAP price, in sqrt space (R3.3/C3: tickMath
  // gains no inverse).
  if (
    !gridDualSellClearanceOk({
      sqrtPriceX96After: quoted.sqrtPriceX96After,
      sellRange2,
      tickSpacing,
      wbnbIsToken0,
    })
  ) {
    throw new Error(
      lpGridDualArmSellRefusal({ where: "mint", sellRange2, tickSpacing, wbnbIsToken0 }),
    );
  }

  // The sell mint's desired is the swap's FLOOR, never its quote (ruling Q2,
  // taken with NO extra safety margin): the batch can then never need more base
  // than the swap is guaranteed to have delivered, and the overage stays in the
  // wallet as the same bounded dust `/lp/open`'s two-sided plan has left on
  // mainnet since Phase 3. A margin would make the asymmetry WORSE, not better.
  const sellDesired = sagaSwapMinOut(quoted.amountOutWei, input.rails.maxSagaSlippageBps);
  if (sellDesired <= 0n) {
    throw new Error("The dual arm's swap floor is zero; there is nothing to mint the sell rung with.");
  }

  // The SELL rung's own side, derived at the POST-SWAP price for the same
  // reason the gate above is: this decides which leg the mint charges, and the
  // mint executes after the swap.
  const sellSide = gridDualPostSwapSide(sellRange2, quoted.sqrtPriceX96After);
  const sellAmount0 = sellSide === "above" ? sellDesired : 0n;
  const sellAmount1 = sellSide === "above" ? 0n : sellDesired;
  const sellLiquidity = getLiquidityForAmounts(
    quoted.sqrtPriceX96After, sellTickLower, sellTickUpper, sellAmount0, sellAmount1,
  );
  const sellFloors = sagaSingleSidedMintFloors({
    sqrtPriceX96: quoted.sqrtPriceX96After, tickLower: sellTickLower,
    tickUpper: sellTickUpper, liquidity: sellLiquidity,
    maxSagaSlippageBps: input.rails.maxSagaSlippageBps, side: sellSide,
  });

  // The BUY rung, at the SPOT price and the pre-swap tick — 3.16's own
  // derivation verbatim, because this is 3.16's mint with a smaller budget.
  const buyAmount0 = wbnbIsToken0 ? buyValueWei : 0n;
  const buyAmount1 = wbnbIsToken0 ? 0n : buyValueWei;
  const buyLiquidity = getLiquidityForAmounts(
    input.spotSqrtPriceX96, input.tickLower, input.tickUpper, buyAmount0, buyAmount1,
  );
  const buyFloors = sagaSingleSidedMintFloors({
    sqrtPriceX96: input.spotSqrtPriceX96, tickLower: input.tickLower,
    tickUpper: input.tickUpper, liquidity: buyLiquidity,
    maxSagaSlippageBps: input.rails.maxSagaSlippageBps, side: buySide,
  });

  return [
    ...buildPancakeV3Buy({ router: input.routerV3, wbnb: input.wbnb, token,
      amountInWei: swapInWei, minOutWei: sellDesired, recipient: input.walletAddress,
      deadline: input.deadline, route: { hops: [], fees: [feeTier] } }),
    // mint#1 — the SELL rung, base-charging, no native attached.
    ...buildLpMintWbnbBatch({ nfpm: input.nfpm, token0: input.token0, token1: input.token1,
      wbnb: input.wbnb, fee: input.fee, tickLower: sellTickLower, tickUpper: sellTickUpper,
      amount0DesiredWei: sellAmount0, amount1DesiredWei: sellAmount1,
      amount0MinWei: sellFloors.amount0Min, amount1MinWei: sellFloors.amount1Min,
      recipient: input.walletAddress, deadline: input.deadline }),
    // mint#2 — the BUY rung, quote-charging, carrying the remaining native.
    ...buildLpOpenBatch({ nfpm: input.nfpm, token0: input.token0, token1: input.token1,
      wbnb: input.wbnb, fee: input.fee, tickLower: input.tickLower, tickUpper: input.tickUpper,
      amount0DesiredWei: buyAmount0, amount1DesiredWei: buyAmount1,
      amount0MinWei: buyFloors.amount0Min, amount1MinWei: buyFloors.amount1Min,
      recipient: input.walletAddress, deadline: input.deadline }),
  ];
}

/**
 * PHASE3.19 item 4 / R4.2 — THE LADDER ARM's plan: ONE atomic batch that funds
 * BOTH rungs AND the idle buffer from one native budget.
 *
 * ─── THE PINNED CALL ORDER ─────────────────────────────────────────────────
 *
 * ```text
 * 1. {to: WBNB, value: idleQuoteWei, data: deposit()}      <- buildWbnbDeposit
 * 2. {to: routerV3, value: swapInWei, data: multicall([exactInputSingle(
 *      WBNB->base, recipient=wallet, minOut), refundETH()])}  <- buildPancakeV3Buy
 * 3. approve(WBNB, nfpm, 0)                                 ┐
 * 4. approve(base, nfpm, sellDesired)                       ├ buildLpMintWbnbBatch
 * 5. {to: nfpm, data: mint(SELL rung)}                      ┘
 * 6. {to: nfpm, value: buyValueWei, data: mint(BUY rung)}   ┐ buildLpOpenBatch
 * 7. {to: nfpm, data: refundETH()}                          ┘
 * ```
 *
 * mint#1 = SELL, mint#2 = BUY — the SAME pinned order the dual arm uses, so
 * `finishDual`'s positional pairing and its `sellTokenId < buyTokenId` assert
 * carry over verbatim. `nativeSpendWei` is a plain sum of attached values and
 * therefore equals `idleQuoteWei + swapInWei + buyValueWei`, which is EXACTLY
 * `budgetWei` by the arithmetic below.
 *
 * ─── THE SPLIT, R4.2 VERBATIM (N17) ────────────────────────────────────────
 *
 * ```text
 * swapInWei    = gridDualSwapInWei(budgetWei)            // budget/2, UNSCALED
 * quoteHalfWei = budgetWei - swapInWei
 * buyValueWei  = quoteHalfWei * deployPctBps / 10_000
 * idleQuoteWei = quoteHalfWei - buyValueWei              // > 0 by the 1000..5000 bound
 * sellDesired  = sagaSwapMinOut(quoted.amountOutWei, slippage) * deployPctBps / 10_000
 * ```
 *
 * THE SWAP IS UNSCALED, AND THAT IS THE FINDING. Scaling `swapInWei` by
 * `deployPctBps` would swap only ~30% of the base half, leave the other ~70% of
 * it as WBNB, and produce a buffer that is ~85% quote with NO IDLE BASE AT ALL —
 * so the sell rung could be re-minted exactly once and would then park for ever.
 * That is FINDINGS (ax)'s one-sided ladder mirrored onto the base side, i.e. the
 * failure this whole phase exists to remove. The WHOLE base half is acquired at
 * arm; `deployPctBps` applies ONCE PER SIDE to that side's HALF, so idle is
 * `10_000 - deployPctBps` of the total and is TWO-SIDED BY CONSTRUCTION.
 *
 * ─── ORIENTATION ───────────────────────────────────────────────────────────
 *
 * The value split is orientation-IRRELEVANT and provably so: all three values
 * are denominated in native wei, and `wbnbIsToken0` only decides which of
 * `amount0Desired`/`amount1Desired` carries a mint's desired. There is no
 * orientation-conditioned arithmetic in the split at all. The two SIDE decisions
 * — which leg each mint charges — are the dual arm's own, unchanged.
 *
 * ─── THE GATES, AT DIFFERENT PRICES, EXACTLY AS THE DUAL ARM'S ─────────────
 *
 * The BUY rung is gated on the PRE-swap tick and the SELL rung on the QUOTED
 * POST-SWAP price, because the arm's own swap moves the price TOWARD the sell
 * rung and AWAY from the buy rung in BOTH orientations. The ladder's swap is
 * LARGER than the dual arm's relative to what it mints (it acquires the whole
 * base half but deploys only `deployPctBps` of it), so the clearance rule
 * matters more here, not less.
 *
 * Everything throws ABOVE THE SUBMIT, which `runLpOpen`'s positional
 * classification turns into a zero-money rollback closing BOTH never-funded rows
 * through their `arm_group_id`.
 */
async function buildGridArmLadderPlan(
  input: LpOpenPlanInput,
): Promise<readonly WalletCall[]> {
  const { wbnbIsToken0, token, feeTier } = resolvePoolLegs(input);
  const sellTickLower = input.sellTickLower;
  const sellTickUpper = input.sellTickUpper;
  const tickSpacing = input.tickSpacing;
  const deployPctBps = input.deployPctBps;
  const quoteWithPriceAfter = input.quoteWithPriceAfter;
  if (
    sellTickLower === undefined
    || sellTickUpper === undefined
    || tickSpacing === undefined
    || deployPctBps === undefined
  ) {
    throw new Error(
      "A ladder grid arm needs the sell rung, the pool's tick spacing and the signed deployPctBps; the plan refuses rather than minting one rung of a two-rung signature.",
    );
  }
  if (quoteWithPriceAfter === undefined) {
    // FAIL CLOSED, the dual arm's posture verbatim: without the post-swap price
    // the sell rung's gate cannot run at all, and its absence is precisely the
    // systematic revert that gate exists to prevent.
    throw new Error(
      "A ladder grid arm needs the post-swap quote reader (quoteWithPriceAfter); without it the sell rung's gate cannot be evaluated and the arm refuses.",
    );
  }

  const buyRange = { tickLower: input.tickLower, tickUpper: input.tickUpper };
  const sellRange = { tickLower: sellTickLower, tickUpper: sellTickUpper };

  // G2-BUY, on the PRE-swap tick.
  const buySide = gridTargetSide(input.currentTick, buyRange);
  if (buySide === undefined || !gridSideChargesQuote(buySide, wbnbIsToken0)) {
    throw new Error(
      lpGridDualArmBuyRefusal({
        where: "mint",
        currentTick: input.currentTick,
        buyRange,
        side: buySide,
        wbnbIsToken0,
      }),
    );
  }

  // R4.2's three values, in the order they are derived.
  const swapInWei = gridDualSwapInWei(input.budgetWei);
  const quoteHalfWei = input.budgetWei - swapInWei;
  const buyValueWei = (quoteHalfWei * BigInt(deployPctBps)) / 10_000n;
  const idleQuoteWei = quoteHalfWei - buyValueWei;
  if (swapInWei <= 0n || buyValueWei <= 0n || idleQuoteWei <= 0n) {
    throw new Error(
      "The ladder arm's budget is too small to split: the swap, the deployed buy rung and the idle quote buffer must each receive a positive share.",
    );
  }

  const quoted = await quoteWithPriceAfter({
    tokenIn: input.wbnb,
    tokenOut: token,
    fee: input.fee,
    amountInWei: swapInWei,
  });
  const expectedAtSpot = spotSwapOutput({
    amountInAfterFee: swapInWei,
    sqrtPriceX96: input.spotSqrtPriceX96,
    tokenInIsToken0: wbnbIsToken0,
  });
  if (
    quotePriceImpactBps(expectedAtSpot, quoted.amountOutWei)
    > BigInt(input.rails.maxPriceImpactBps)
  ) {
    throw new Error(
      "Quoted price impact of the ladder arm's swap leg exceeds the manipulation-rail ceiling.",
    );
  }

  // G2-SELL, on the QUOTED POST-SWAP price, in sqrt space.
  if (
    !gridDualSellClearanceOk({
      sqrtPriceX96After: quoted.sqrtPriceX96After,
      sellRange2: sellRange,
      tickSpacing,
      wbnbIsToken0,
    })
  ) {
    throw new Error(
      lpGridDualArmSellRefusal({
        where: "mint",
        sellRange2: sellRange,
        tickSpacing,
        wbnbIsToken0,
      }),
    );
  }

  // The sell mint's desired is `deployPctBps` of the swap's FLOOR, never of its
  // quote (ruling Q2, inherited): the batch can then never need more base than
  // the swap is GUARANTEED to have delivered, and the undeployed remainder is
  // exactly the idle BASE half of the buffer — which is the point of the mode.
  const sellFloorWei = sagaSwapMinOut(quoted.amountOutWei, input.rails.maxSagaSlippageBps);
  const sellDesired = (sellFloorWei * BigInt(deployPctBps)) / 10_000n;
  if (sellDesired <= 0n) {
    throw new Error(
      "The ladder arm's deployed sell size is zero; there is nothing to mint the sell rung with.",
    );
  }

  const sellSide = gridDualPostSwapSide(sellRange, quoted.sqrtPriceX96After);
  const sellAmount0 = sellSide === "above" ? sellDesired : 0n;
  const sellAmount1 = sellSide === "above" ? 0n : sellDesired;
  const sellLiquidity = getLiquidityForAmounts(
    quoted.sqrtPriceX96After, sellTickLower, sellTickUpper, sellAmount0, sellAmount1,
  );
  const sellFloors = sagaSingleSidedMintFloors({
    sqrtPriceX96: quoted.sqrtPriceX96After, tickLower: sellTickLower,
    tickUpper: sellTickUpper, liquidity: sellLiquidity,
    maxSagaSlippageBps: input.rails.maxSagaSlippageBps, side: sellSide,
  });

  const buyAmount0 = wbnbIsToken0 ? buyValueWei : 0n;
  const buyAmount1 = wbnbIsToken0 ? 0n : buyValueWei;
  const buyLiquidity = getLiquidityForAmounts(
    input.spotSqrtPriceX96, input.tickLower, input.tickUpper, buyAmount0, buyAmount1,
  );
  const buyFloors = sagaSingleSidedMintFloors({
    sqrtPriceX96: input.spotSqrtPriceX96, tickLower: input.tickLower,
    tickUpper: input.tickUpper, liquidity: buyLiquidity,
    maxSagaSlippageBps: input.rails.maxSagaSlippageBps, side: buySide,
  });

  return [
    // 1 — THE WRAP. It runs FIRST so the buffer's quote half exists before
    // anything else touches the budget, and because the two legs below attach
    // the rest: a wrap ordered last would be a wrap of whatever the periphery
    // happened to leave, which is not a number this plan controls.
    buildWbnbDeposit(input.wbnb, idleQuoteWei),
    ...buildPancakeV3Buy({ router: input.routerV3, wbnb: input.wbnb, token,
      amountInWei: swapInWei, minOutWei: sellFloorWei, recipient: input.walletAddress,
      deadline: input.deadline, route: { hops: [], fees: [feeTier] } }),
    // mint#1 — the SELL rung, base-charging, no native attached.
    ...buildLpMintWbnbBatch({ nfpm: input.nfpm, token0: input.token0, token1: input.token1,
      wbnb: input.wbnb, fee: input.fee, tickLower: sellTickLower, tickUpper: sellTickUpper,
      amount0DesiredWei: sellAmount0, amount1DesiredWei: sellAmount1,
      amount0MinWei: sellFloors.amount0Min, amount1MinWei: sellFloors.amount1Min,
      recipient: input.walletAddress, deadline: input.deadline }),
    // mint#2 — the BUY rung, quote-charging, carrying its deployed native.
    ...buildLpOpenBatch({ nfpm: input.nfpm, token0: input.token0, token1: input.token1,
      wbnb: input.wbnb, fee: input.fee, tickLower: input.tickLower, tickUpper: input.tickUpper,
      amount0DesiredWei: buyAmount0, amount1DesiredWei: buyAmount1,
      amount0MinWei: buyFloors.amount0Min, amount1MinWei: buyFloors.amount1Min,
      recipient: input.walletAddress, deadline: input.deadline }),
  ];
}

/**
 * Which leg `sellRange2` charges at the POST-SWAP price, in sqrt space.
 *
 * `gridTargetSide` takes a TICK, and this module deliberately has no tick to
 * give it here: R3.3 forbids a sqrt→tick inverse. The bounds are V3's own —
 * strictly below `sqrtRatio(tickLower)` is "above", at or above
 * `sqrtRatio(tickUpper)` is "below" — the exact pair `swaplessRotationSide`
 * uses, and the one-spacing clearance gate has ALREADY proved the price is
 * strictly outside, so the in-range case is unreachable here and throws rather
 * than returning a guess.
 */
function gridDualPostSwapSide(
  range: { readonly tickLower: number; readonly tickUpper: number },
  sqrtPriceX96After: bigint,
): "above" | "below" {
  if (sqrtPriceX96After < getSqrtRatioAtTick(range.tickLower)) return "above";
  if (sqrtPriceX96After >= getSqrtRatioAtTick(range.tickUpper)) return "below";
  throw new Error(
    "The quoted post-swap price is INSIDE the sell rung; the one-spacing clearance gate should have refused first.",
  );
}

/** Throws a clean pre-submit refusal; it never signs, sends or persists. */
export async function buildLpOpenPlan(input: LpOpenPlanInput): Promise<readonly WalletCall[]> {
  // FIRST STATEMENT, AND SHARED BY BOTH MODES ON PURPOSE (PHASE3.16 C7). The
  // worker's `grid-arm` resume passes `budgetWei: 0n` as a SENTINEL, and this
  // line is what turns that into `BUILD_REFUSED` → rollback → the never-funded
  // lineage closed. The whole "an arm is NEVER re-driven" policy rests on it:
  // an arm's range is derivable only against a fresh tick and its budget is not
  // persisted at all, so an honest re-drive is impossible by construction. Move
  // this below the mode branch and the policy silently dies.
  if (input.budgetWei <= 0n) throw new Error("The open budget must be positive.");
  if (input.mode === "grid-arm") return buildGridArmPlan(input);
  // PHASE3.17: the dual arm's branch sits BELOW the budget sentinel for exactly
  // the reason stated above — the worker's `grid-arm` resume passes
  // `budgetWei: 0n` and must be refused before ANY mode branch is consulted.
  if (input.mode === "grid-arm-dual") return buildGridArmDualPlan(input);
  // PHASE3.19 C1: a FIFTH branch with its OWN builder, below the budget sentinel
  // for the reason stated above — the worker's `grid-arm` resume passes
  // `budgetWei: 0n` and must be refused before ANY mode branch is consulted.
  if (input.mode === "grid-arm-ladder") return buildGridArmLadderPlan(input);
  // PHASE3.22 R5: the SIXTH branch, DELEGATING to the ladder's builder
  // verbatim — same four legs, same batch, same refusals. It sits below the
  // budget sentinel for the same reason every arm branch does: the worker's
  // resume passes `budgetWei: 0n` and must be refused before ANY mode branch.
  if (input.mode === "grid-arm-shift") return buildGridArmLadderPlan(input);
  if (!(input.tickLower <= input.currentTick && input.currentTick < input.tickUpper)) {
    throw new Error("v1 opens a two-sided in-range position; the signed range does not contain the current tick.");
  }
  const { wbnbIsToken0, token, feeTier } = resolvePoolLegs(input);

  const swapInWei = computeSwapAmount(input.budgetWei, input.currentTick, input.tickLower,
    input.tickUpper, wbnbIsToken0);
  if (swapInWei <= 0n || swapInWei >= input.budgetWei) {
    throw new Error("The range asks for a single-sided deposit; v1 opens two-sided positions only.");
  }
  const wbnbDesired = input.budgetWei - swapInWei;
  const quotedOut = await input.quote({ tokenIn: input.wbnb, tokenOut: token, fee: input.fee,
    amountInWei: swapInWei });
  const expectedAtSpot = spotSwapOutput({ amountInAfterFee: swapInWei,
    sqrtPriceX96: input.spotSqrtPriceX96, tokenInIsToken0: wbnbIsToken0 });
  if (quotePriceImpactBps(expectedAtSpot, quotedOut) > BigInt(input.rails.maxPriceImpactBps)) {
    throw new Error("Quoted price impact of the open's swap leg exceeds the manipulation-rail ceiling.");
  }
  const minOutWei = sagaSwapMinOut(quotedOut, input.rails.maxSagaSlippageBps);
  const tokenDesired = minOutWei;
  const amount0 = wbnbIsToken0 ? wbnbDesired : tokenDesired;
  const amount1 = wbnbIsToken0 ? tokenDesired : wbnbDesired;
  const liquidity = getLiquidityForAmounts(input.spotSqrtPriceX96, input.tickLower,
    input.tickUpper, amount0, amount1);
  const floors = sagaMintFloors({ sqrtPriceX96: input.spotSqrtPriceX96, tickLower: input.tickLower,
    tickUpper: input.tickUpper, liquidity, maxSagaSlippageBps: input.rails.maxSagaSlippageBps,
    amount0Desired: amount0, amount1Desired: amount1 });
  return [
    ...buildPancakeV3Buy({ router: input.routerV3, wbnb: input.wbnb, token,
      amountInWei: swapInWei, minOutWei, recipient: input.walletAddress, deadline: input.deadline,
      route: { hops: [], fees: [feeTier] } }),
    buildApprove(token, input.nfpm, tokenDesired),
    ...buildLpOpenBatch({ nfpm: input.nfpm, token0: input.token0, token1: input.token1,
      wbnb: input.wbnb, fee: input.fee, tickLower: input.tickLower, tickUpper: input.tickUpper,
      amount0DesiredWei: amount0, amount1DesiredWei: amount1, amount0MinWei: floors.amount0Min,
      amount1MinWei: floors.amount1Min, recipient: input.walletAddress, deadline: input.deadline }),
  ];
}
