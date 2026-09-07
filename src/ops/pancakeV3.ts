/**
 * PancakeSwap V3 call builders. PURE: no network, no clock, no environment.
 *
 * Same contract as `src/ops/pancake.ts`: every quantity is an explicit
 * parameter, including the deadline, so identical inputs always produce
 * byte-identical calldata and the golden tests mean something.
 *
 * ─── WHAT WAS VERIFIED, AND WHY IT IS WRITTEN DOWN (PHASE2.2 R1) ───────────
 *
 * Verified 2026-08-11 against DEPLOYED BYTECODE on BNB Chain 56, on the
 * DEDICATED V3 router 0x1b81D678ffb9C0263b24A97847620C99d213eB14 (not the
 * SmartRouter): `exactInputSingle` 0x414bf389, `exactInput` 0xc04b8d59,
 * `multicall(bytes[])` 0xac9650d8, `refundETH()` 0x12210e8a,
 * `unwrapWETH9(uint256,address)` 0x49404b7c, and `WETH9()` reading back
 * 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c. The SmartRouter's
 * `multicall(uint256 deadline, bytes[])` (0x5ae401dc) is ABSENT from this
 * dispatcher, so the deadline goes inside each swap struct.
 *
 * ─── THE RECIPIENT SENTINEL, WHICH IS WHERE THE MONEY GETS LOST ────────────
 *
 * A sell must leave its WBNB in the router so `unwrapWETH9` can convert it, and
 * periphery routers spell "keep it here" as `recipient = address(0)` (mapped to
 * `address(this)` in `exactInputInternal`). `address(1)` and `address(2)` are
 * NOT sentinels on this router — they are literal recipients, and calldata that
 * uses one passes every offline golden test while permanently stranding the
 * whole sell on mainnet. This builder writes the ROUTER'S OWN ADDRESS
 * explicitly. `address(0)` would work, but an address-shaped constant meaning
 * "not an address" is one refactor away from being read as "unset".
 *
 * ─── NO FEE-ON-TRANSFER SUPPORT, AT ALL (PHASE2.2 R10) ─────────────────────
 *
 * `src/ops/pancake.ts` uses the `SupportingFeeOnTransferTokens` V2 variants
 * because meme tokens routinely tax transfers. V3 HAS NO SUCH VARIANT: the pool
 * measures its own balance delta and reverts when a transfer delivers less than
 * it moved. So for exactly the token class Phase 2 was built for, `pancake_v3`
 * is unusable in BOTH directions. A taxed token is a `pancake` (V2) trade or it
 * is no trade — and this service does NOT fall back from one venue to the
 * other, because choosing the venue is the caller's judgement, not ours.
 *
 * ─── WHY THE BUY IS ALSO A MULTICALL ───────────────────────────────────────
 *
 * Symmetry with the sell, not necessity. `exactInputSingle` alone with `value`
 * attached works perfectly well, and `refundETH` is unreachable belt-and-braces:
 * `pay()` deposits exactly `msg.value` into WETH9, and the router's `receive()`
 * rejects every sender but WETH9, so there is no remainder to refund. It is
 * documented here so a later refactor does not preserve `refundETH` in the
 * belief that it is load-bearing.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { PANCAKE_V3_ROUTER_ABI } from "./abis.js";
import { buildApprove } from "./pancake.js";
import { MAX_ROUTE_HOPS, V3_FEE_TIERS, type TradeRoute, type V3FeeTier } from "./route.js";

/**
 * `sqrtPriceLimitX96`, always.
 *
 * A price limit is a second, redundant slippage control the caller never asked
 * for, and a non-zero value silently converts a full fill into a partial one.
 * `amountOutMinimum` is the floor and it comes from the caller.
 */
const NO_PRICE_LIMIT = 0n;

export type PancakeV3BuyParams = {
  readonly router: Address;
  readonly wbnb: Address;
  readonly token: Address;
  /** Native BNB the swap itself spends. Becomes the call's `value`. */
  readonly amountInWei: bigint;
  /** Slippage floor, in the token's smallest unit. */
  readonly minOutWei: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly recipient: Address;
  /** Unix SECONDS. The route computes `now + TRADE_DEADLINE_SEC`. */
  readonly deadline: bigint;
  /** The caller's route, in `WBNB → …hops → token` orientation. */
  readonly route: TradeRoute;
};

export type PancakeV3SellParams = {
  readonly router: Address;
  readonly wbnb: Address;
  readonly token: Address;
  /** Token amount sold, in the token's smallest unit. */
  readonly amountInWei: bigint;
  /** Slippage floor, in wei of native BNB. */
  readonly minOutWei: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  /**
   * The caller's route, in the SAME `WBNB → …hops → token` orientation as the
   * buy. This builder reverses it — tokens and fee tiers together.
   */
  readonly route: TradeRoute;
};

/**
 * Whether a route can be encoded at all: one fee tier per pool, and no more
 * pools than the ceiling allows.
 *
 * The wire parser already guarantees both, which is why this returns a boolean
 * rather than throwing: the route layer refuses a bad route with a 400 long
 * before a builder sees it, and a builder that threw here would turn a caught
 * invariant into a 500.
 */
export function isEncodableV3Route(route: TradeRoute): boolean {
  return (
    route.hops.length <= MAX_ROUTE_HOPS && route.fees.length === route.hops.length + 1
  );
}

/**
 * Pack a V3 path: `token(20) | uint24 fee big-endian (3) | token(20) [| …]`.
 *
 * 43 bytes for one pool, 66 for two, 89 for the three-pool ceiling. VERIFIED
 * against the router's own `Path.sol` layout. A byte-packing bug here produces a
 * perfectly valid-looking call into a DIFFERENT pool, which is why the golden
 * test asserts the bytes literally rather than round-tripping them.
 */
export function encodeV3Path(
  tokens: readonly Address[],
  fees: readonly number[],
): Hex {
  if (tokens.length !== fees.length + 1) {
    throw new Error("encodeV3Path: one fee tier per pool is required.");
  }
  const parts: string[] = [];
  for (const [index, token] of tokens.entries()) {
    parts.push(token.slice(2).toLowerCase());
    const fee = fees[index];
    if (fee !== undefined) parts.push(fee.toString(16).padStart(6, "0"));
  }
  return `0x${parts.join("")}` as Hex;
}

/** The token sequence a BUY traverses: WBNB, then the hops, then the token. */
function buyTokens(params: {
  readonly wbnb: Address;
  readonly token: Address;
  readonly route: TradeRoute;
}): readonly Address[] {
  return [params.wbnb, ...params.route.hops, params.token];
}

type SwapLeg = {
  readonly tokens: readonly Address[];
  readonly fees: readonly number[];
  readonly recipient: Address;
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly deadline: bigint;
};

/**
 * Encode ONE swap leg: `exactInputSingle` for a single pool, `exactInput` for
 * two or more.
 *
 * The single-pool case MUST NOT be encoded as a one-pool `exactInput`
 * (PHASE2.2 R12): if it were, one request would have two possible calldatas and
 * the relation between `paramsHash` and `callsHash` would stop being
 * deterministic.
 *
 * `amountOutMinimum` is `minOutWei` on EVERY leg, without exception (R5).
 */
function encodeSwapLeg(leg: SwapLeg): Hex {
  const first = leg.tokens[0];
  const last = leg.tokens[leg.tokens.length - 1];
  const onlyFee = leg.fees[0];
  if (first === undefined || last === undefined || onlyFee === undefined) {
    throw new Error("encodeSwapLeg: a swap leg needs at least one pool.");
  }

  if (leg.fees.length === 1) {
    return encodeFunctionData({
      abi: PANCAKE_V3_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: first,
          tokenOut: last,
          fee: onlyFee,
          recipient: leg.recipient,
          deadline: leg.deadline,
          amountIn: leg.amountInWei,
          amountOutMinimum: leg.minOutWei,
          sqrtPriceLimitX96: NO_PRICE_LIMIT,
        },
      ],
    }) as Hex;
  }

  return encodeFunctionData({
    abi: PANCAKE_V3_ROUTER_ABI,
    functionName: "exactInput",
    args: [
      {
        path: encodeV3Path(leg.tokens, leg.fees),
        recipient: leg.recipient,
        deadline: leg.deadline,
        amountIn: leg.amountInWei,
        amountOutMinimum: leg.minOutWei,
      },
    ],
  }) as Hex;
}

/** `multicall(bytes[])` — the ONLY overload this router has. */
function encodeMulticall(inner: readonly Hex[]): Hex {
  return encodeFunctionData({
    abi: PANCAKE_V3_ROUTER_ABI,
    functionName: "multicall",
    args: [inner],
  }) as Hex;
}

/**
 * Buy `token` with native BNB.
 *
 * ONE call to the router, so `assertTargetsAllowed` sees a single target and the
 * batch stays small. `value` is exactly `amountInWei` — and exactly is the
 * operative word: `SwapRouter.pay()` wraps native only when
 * `token == WETH9 && address(this).balance >= value`, so a buy that attached one
 * wei less would silently stop being a native buy and become a
 * `transferFrom` of WBNB against whatever allowance the wallet happens to hold.
 */
export function buildPancakeV3Buy(
  params: PancakeV3BuyParams,
): readonly WalletCall[] {
  const swap = encodeSwapLeg({
    tokens: buyTokens(params),
    fees: params.route.fees,
    // The output goes straight to the row's wallet; there is nothing to unwrap.
    recipient: params.recipient,
    amountInWei: params.amountInWei,
    minOutWei: params.minOutWei,
    deadline: params.deadline,
  });
  const refund = encodeFunctionData({
    abi: PANCAKE_V3_ROUTER_ABI,
    functionName: "refundETH",
  }) as Hex;

  return [
    {
      to: params.router,
      value: params.amountInWei,
      data: encodeMulticall([swap, refund]),
    },
  ];
}

/**
 * Sell `token` for native BNB.
 *
 * Exactly `[approve(router, 0), approve(router, amount), multicall]`, for the
 * same reasons as the V2 sell: the zero-reset unbricks USDT-style tokens, and
 * the batch is atomic so a reverting swap leaves no live allowance behind.
 *
 * The swap's output is retained by the ROUTER and then unwrapped to the row's
 * wallet. A V3 sell MUST unwrap: leaving WBNB in the wallet would report success
 * while the native balance never moved, and the off-chain daily-cap accounting —
 * which counts native — would never see the proceeds. The V2 sell returns BNB;
 * if V3 did not, the two venues would disagree about what a sell is.
 *
 * `unwrapWETH9` carries `minOutWei` too, but it is a WEAKER check and never a
 * replacement for `amountOutMinimum` (PHASE2.2 R5): it measures the router's
 * ENTIRE WBNB balance, so with any stray WBNB sitting there a swap returning far
 * less than the floor would still pass it. `amountOutMinimum` is the only floor
 * that measures THIS swap.
 */
export function buildPancakeV3Sell(
  params: PancakeV3SellParams,
): readonly WalletCall[] {
  // The sell path is the exact reverse of the buy path — tokens AND fee tiers
  // (PHASE2.2 R2). Reversing only the addresses would route through a real but
  // wrong-tier pool, where `minOutWei` is the only thing left standing.
  // `[...x].reverse()` because both arrays are readonly and are already folded
  // into `paramsHash`; mutating them would change the trade's identity.
  const tokens = [...buyTokens(params)].reverse();
  const fees = [...params.route.fees].reverse();

  const swap = encodeSwapLeg({
    tokens,
    fees,
    // NOT address(0)/(1)/(2). See the module docstring.
    recipient: params.router,
    amountInWei: params.amountInWei,
    minOutWei: params.minOutWei,
    deadline: params.deadline,
  });
  const unwrap = encodeFunctionData({
    abi: PANCAKE_V3_ROUTER_ABI,
    functionName: "unwrapWETH9",
    args: [params.minOutWei, params.recipient],
  }) as Hex;

  return [
    buildApprove(params.token, params.router, 0n),
    buildApprove(params.token, params.router, params.amountInWei),
    {
      to: params.router,
      data: encodeMulticall([swap, unwrap]),
    },
  ];
}

export type LpSweepSwapParams = {
  readonly router: Address;
  /** The ERC-20 sold. Approved to the router for EXACTLY `amountInWei`. */
  readonly tokenIn: Address;
  /** The ERC-20 bought. Delivered to `recipient` as an ERC-20 — no unwrap. */
  readonly tokenOut: Address;
  /**
   * THE POSITION'S OWN pool fee tier (PHASE3 Rev2 item 31): the sweep swaps in
   * the position's own pool, single hop, always — the one route that is data
   * rather than a server routing judgement, so there is no `TradeRoute` here
   * and nothing to choose.
   */
  readonly fee: number;
  /** EXACT confirmed amount from the collect/step receipts, never a re-read. */
  readonly amountInWei: bigint;
  /** Server-derived floor (Rev2 item 23, `sagaSwapMinOut`). Never zero. */
  readonly minOutWei: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly recipient: Address;
  /** Unix SECONDS. The saga computes `now + TRADE_DEADLINE_SEC`. */
  readonly deadline: bigint;
};

/**
 * The LP saga's `sweep-token` leg: an ERC-20 → ERC-20 `exactInputSingle` in
 * the position's own pool, output paid to the wallet AS AN ERC-20 (ADDITIVE
 * builder for PHASE3).
 *
 * Deliberately a THIRD shape rather than a reuse of the two 2.2 builders,
 * because Rev2 item 14 makes both of them wrong here: {@link buildPancakeV3Buy}
 * attaches native `value` (only `/lp/open` may attach native — a saga leg that
 * did would meter against the rolling native cap), and
 * {@link buildPancakeV3Sell} unwraps to native (the rotate zap-out does NOT
 * unwrap; the freed WBNB must stay WBNB to fund the re-mint through the WBNB
 * cap). With no native leg in either direction there is nothing to refund and
 * nothing to unwrap, so the multicall wraps the one swap alone and the
 * recipient is the wallet directly — no funds are ever parked in the router.
 *
 * The approve pair is the proven sell shape: `approve(0)` unbricks USDT-style
 * tokens (FINDINGS (j)) and the second approve is EXACT (Rev2 item 15 / 2.3
 * R4 — a max-approve would be metered at ~2^256 against the token's cap). The
 * batch is atomic, so a reverting swap leaves no live allowance behind.
 */
export function buildLpSweepSwap(params: LpSweepSwapParams): readonly WalletCall[] {
  const builder = "buildLpSweepSwap";
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) {
    throw new Error(`${builder}: tokenIn and tokenOut are the same address; a sweep swaps between the pool's two legs.`);
  }
  if (params.amountInWei <= 0n) {
    throw new Error(`${builder}: amountInWei must be positive; a zero sweep is a skipped step, not an empty swap.`);
  }
  if (params.minOutWei <= 0n) {
    throw new Error(`${builder}: minOutWei must be positive. Floors are derived server-side from a fresh quote (Rev2 item 23); a zero floor here is a forgotten derivation, not a choice.`);
  }
  if (!Number.isInteger(params.fee) || params.fee <= 0 || params.fee > 0xffffff) {
    throw new Error(`${builder}: fee must be a positive uint24 fee tier — the position's own pool tier, read on-chain.`);
  }
  if (params.deadline <= 0n) {
    throw new Error(`${builder}: deadline must be a positive unix-seconds value.`);
  }
  if (params.recipient.toLowerCase() === `0x${"00".repeat(20)}`) {
    throw new Error(`${builder}: recipient must not be the zero address — on this router it is the "keep it in the contract" sentinel, not a recipient.`);
  }

  const swap = encodeSwapLeg({
    tokens: [params.tokenIn, params.tokenOut],
    fees: [params.fee],
    // Straight to the wallet: the output is an ERC-20 either way, so there is
    // no unwrap leg and no reason to park anything in the router.
    recipient: params.recipient,
    amountInWei: params.amountInWei,
    minOutWei: params.minOutWei,
    deadline: params.deadline,
  });

  return [
    buildApprove(params.tokenIn, params.router, 0n),
    buildApprove(params.tokenIn, params.router, params.amountInWei),
    { to: params.router, data: encodeMulticall([swap]) },
  ];
}

export type LpExitSwapParams = {
  readonly router: Address;
  /** The configured WBNB. Compared BY IDENTITY against `quoteToken`. */
  readonly wbnb: Address;
  /**
   * The asset the position's basis is quoted in (`LpPositionRecord.quoteToken`,
   * WBNB in v1). The swap's OUTPUT. The `unwrapWETH9` tail rides only when
   * this IS the configured WBNB (PHASE3.1 Rev2 item 5).
   */
  readonly quoteToken: Address;
  /** The position's NON-quote leg — the asset the exit converts. */
  readonly token: Address;
  /**
   * THE POSITION'S OWN pool fee tier. PHASE3 Rev2 item 31 EXTENDS to the exit
   * swap (PHASE3.1 Rev2 item 4): the position's own pool, single hop, always.
   * There is no `TradeRoute` choice on this path.
   */
  readonly fee: number;
  /** EXACT confirmed collect delta from step 0's receipt, never a re-read. */
  readonly amountInWei: bigint;
  /** Server-derived floor (`sagaSwapMinOut`). Never zero. */
  readonly minOutWei: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly recipient: Address;
  /** Unix SECONDS. The saga computes `now + TRADE_DEADLINE_SEC`. */
  readonly deadline: bigint;
};

/**
 * The LP EXIT's step-1 leg (PHASE3.1 Rev2 items 1–4): convert the freed
 * non-quote leg into the position's quote asset, delivering NATIVE when that
 * asset is WBNB.
 *
 * A THIN VALIDATING WRAPPER, not a fourth encoding. {@link buildLpSweepSwap}
 * cannot build this batch and must not be widened to: it writes
 * `recipient = wallet` and wraps the swap ALONE, and composing that with the
 * router's `unwrapWETH9` REVERTS on chain — `Insufficient WETH9`, measured by
 * the PHASE3.1 review against the deployed router on 2026-08-16, because the
 * swap's output has already left the router by the time the unwrap runs. Its
 * inability to unwrap is PHASE3 Rev2 item 14's guard on the ROTATE path and
 * stays exactly as it is.
 *
 * So the WBNB-quoted case delegates to {@link buildPancakeV3Sell} — the
 * mainnet-proven 2.2 sell, which already emits this phase's step 1 verbatim:
 * `[approve(token, router, 0), approve(token, router, amountIn),
 * multicall([exactInputSingle(recipient = the ROUTER'S OWN ADDRESS),
 * unwrapWETH9(minOut, wallet)])]`. A golden test pins the two byte-identical
 * so they can never drift.
 *
 * `unwrapWETH9` carries `minOutWei` as well, and it is a WEAKER floor that
 * never substitutes for `amountOutMinimum` (PHASE2.2 R5, carried): it measures
 * the ROUTER'S ENTIRE WBNB balance, so with any stray WBNB parked there a swap
 * returning far less than the floor would still pass it.
 *
 * The non-WBNB-quoted branch is future-proofing with a fail-safe direction: a
 * pool quoted in something other than the configured WBNB LOSES the unwrap
 * (it delegates to {@link buildLpSweepSwap}, ERC-20 out, straight to the
 * wallet) rather than emitting an unwrap for an asset WETH9 knows nothing
 * about. v1 never reaches it — `/lp/open` refuses pools without a WBNB leg.
 */
export function buildLpExitSwap(params: LpExitSwapParams): readonly WalletCall[] {
  const builder = "buildLpExitSwap";
  if (params.token.toLowerCase() === params.quoteToken.toLowerCase()) {
    throw new Error(`${builder}: the exit swaps the position's NON-quote leg INTO its quote asset; the two must differ.`);
  }
  if (params.amountInWei <= 0n) {
    throw new Error(`${builder}: amountInWei must be positive; a zero exit swap is a skipped step, not an empty swap.`);
  }
  if (params.minOutWei <= 0n) {
    throw new Error(`${builder}: minOutWei must be positive. Floors are derived server-side from a fresh quote (PHASE3 Rev2 item 23); a zero floor here is a forgotten derivation, not a choice.`);
  }
  // Narrower than `buildLpSweepSwap`'s uint24 check, and deliberately so: the
  // delegation below builds a `TradeRoute`, whose fee tiers are the four the
  // plane knows. A position row can only carry one of them (`/lp/open` refuses
  // anything else), so a value outside the set is corruption, not a request.
  const tier: V3FeeTier | undefined = Number.isInteger(params.fee)
    ? V3_FEE_TIERS.find((candidate) => candidate === params.fee)
    : undefined;
  if (tier === undefined) {
    throw new Error(`${builder}: fee must be one of the known V3 tiers (${V3_FEE_TIERS.join(", ")}) — the position's own pool tier, read on-chain.`);
  }
  if (params.deadline <= 0n) {
    throw new Error(`${builder}: deadline must be a positive unix-seconds value.`);
  }
  if (params.recipient.toLowerCase() === `0x${"00".repeat(20)}`) {
    throw new Error(`${builder}: recipient must not be the zero address — on this router it is the "keep it in the contract" sentinel, not a recipient.`);
  }

  if (params.quoteToken.toLowerCase() !== params.wbnb.toLowerCase()) {
    // No unwrap: the quote asset is an ordinary ERC-20 and goes to the wallet.
    return buildLpSweepSwap({
      router: params.router,
      tokenIn: params.token,
      tokenOut: params.quoteToken,
      fee: tier,
      amountInWei: params.amountInWei,
      minOutWei: params.minOutWei,
      recipient: params.recipient,
      deadline: params.deadline,
    });
  }

  return buildPancakeV3Sell({
    router: params.router,
    wbnb: params.wbnb,
    token: params.token,
    amountInWei: params.amountInWei,
    minOutWei: params.minOutWei,
    recipient: params.recipient,
    deadline: params.deadline,
    // SINGLE POOL, the position's own (item 4): no hops, one fee tier. The
    // sell builder reverses `[wbnb, token]` into `[token, wbnb]`, which is the
    // exit's direction.
    route: { hops: [], fees: [tier] },
  });
}
