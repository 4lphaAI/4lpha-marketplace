/**
 * NonfungiblePositionManager (NFPM) call builders. PURE: no network, no clock,
 * no environment.
 *
 * Same contract as `src/ops/pancakeV3.ts`: every quantity is an explicit
 * parameter, including the deadline, so identical inputs always produce
 * byte-identical calldata and the golden tests mean something. Floors
 * (`amount0Min`/`amount1Min`, unwrap/sweep minimums) are CALLER-SUPPLIED —
 * PHASE3 Rev2 item 23 (R10) derives them server-side from the rail-checked
 * price and `maxSagaSlippageBps`; these builders just carry them, and refuse
 * the one shape R10 calls a build error (a missing floor on a leg that
 * deposits — see {@link validateDepositLeg}).
 *
 * ─── NO NFPM MULTICALL, EVER (PHASE3 Rev2 item 3) ──────────────────────────
 *
 * The NFPM's Multicall delegatecalls to self, so an inner call is invisible to
 * the account's allowlist — and the same dispatcher carries `setApprovalForAll`,
 * ERC-721 `approve`, `safeTransferFrom` and `transferFrom`, the theft surface
 * for a position NFT. So NO builder here emits `multicall(bytes[])`, and the
 * ABI fragment in `src/ops/abis.ts` deliberately omits the entry, so a builder
 * COULD not encode it even by mistake (viem throws on an unknown
 * `functionName`). Batching is multiple `WalletCall`s in ONE atomic ERC-7821
 * execute batch — the proven sell-batch mechanism (`src/ops/pancake.ts` batch
 * atomicity note). State persists across calls within the one transaction,
 * which is what makes the collect-to-NFPM → unwrap flow below work.
 *
 * Nor does any builder emit an approval/transfer ON the NFPM: the only
 * approvals emitted are ERC-20 `approve`s on WBNB/TOKEN with the NFPM as
 * spender, and those are EXACT amounts (Rev2 item 15).
 *
 * ─── NATIVE ATTACHES ONLY TO THE OPEN'S MINT (PHASE3 Rev2 item 14) ─────────
 *
 * Only {@link buildLpOpenBatch} carries `value`, and only on its mint call.
 * Rotate and harvest zap-ins pay in WBNB via target-bound exact `approve` +
 * the NFPM's `transferFrom` pull — metered against the WBNB cap (a 2.3-R4
 * gate at 2^160), never the native budget. Without this, every rotation would
 * meter the full position principal against the rolling native cap and the
 * mint leg would land in the (h)/(u)/(v)/(w) failure family mid-sequence.
 * A test iterates every builder and asserts the invariant.
 *
 * ─── THE RECIPIENT SENTINEL, AGAIN (PHASE3 Rev2 item 6) ────────────────────
 *
 * The unwrap path's `collect` must leave both legs IN the NFPM so
 * `unwrapWETH9`/`sweepToken` can forward them, and the periphery spells "keep
 * it here" as `recipient = address(0)` (mapped to `address(this)`). Exactly as
 * on the 2.2 router, these builders write the NFPM'S OWN LITERAL ADDRESS —
 * an address-shaped constant meaning "not an address" is one refactor away
 * from being read as "unset". Every other recipient is the row's wallet, and
 * a zero recipient anywhere is refused at build time.
 *
 * ─── COLLECT-TO-WALLET vs COLLECT-TO-NFPM + SWEEP, THE CHOICE STATED ───────
 *
 * Parking proceeds in the NFPM is required ONLY when a leg must be unwrapped:
 * the periphery has to hold the WBNB it converts. The keep-WBNB zap-out
 * (rotate's exit, Rev2 item 14: the rotate zap-out does NOT unwrap) has no
 * unwrap leg, so {@link buildLpZapOutKeepWbnbBatch} collects BOTH legs
 * straight to the wallet and emits no `sweepToken` at all — two calls, no
 * funds ever parked in a shared periphery contract mid-batch, no sweep to
 * forget. `sweepToken` exists to drain the NFPM's own balance; with nothing
 * parked there it would move nothing and only widen the batch.
 *
 * ─── COMPOSITION SEAM: THE OPEN'S TOKEN-LEG APPROVE ────────────────────────
 *
 * {@link buildLpOpenBatch} is exactly `[mint{value}, refundETH]`, per Rev2
 * item 3. The mint's WBNB leg is paid natively (`pay()` wraps `msg.value`);
 * a dual-leg open's TOKEN leg is pulled via `transferFrom`, which needs an
 * allowance THIS builder deliberately does not emit — the saga composes
 * `buildApprove(token, nfpm, exactAmount)` into the SAME atomic batch
 * (WalletCall arrays concatenate; the batch is all-or-nothing). Keeping the
 * open batch to the enumerated pair keeps native attachment in one auditable
 * place.
 *
 * ─── RESIDUAL, STATED: LEFTOVER ERC-20 ALLOWANCE ───────────────────────────
 *
 * A mint/increase pulls the ACTUAL amounts the pool needs, which can be less
 * than `amountXDesired`, leaving a dust allowance to the NFPM. Two
 * consequences, neither hidden: (1) the NFPM only ever spends an allowance on
 * behalf of the caller that granted it (the payer in its callback is the
 * minter), so the residual is not a third-party drain path; (2) an
 * approve-race token (USDT-style: refuses `approve(nonzero)` while a nonzero
 * allowance stands) could brick a SECOND increase. The spec enumerates the
 * exact three-call batch without a zero-reset pair, so none is emitted; if the
 * live-lp run hits an approve-race token this is a spec revision, not a hand
 * patch.
 */
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { NONFUNGIBLE_POSITION_MANAGER_ABI } from "./abis.js";
import { buildApprove } from "./pancake.js";

/**
 * PancakeSwap NFPM on BNB Chain 56.
 *
 * VERIFIED 2026-08-13 against deployed bytecode (PHASE3-REVIEW.md facts):
 * 24 466 bytes, not a proxy; all eight granted selectors located in the
 * dispatcher; `WETH9()` and `factory()` read back the pinned WBNB and V3
 * factory. Pinned here (not in `venues.ts`) until the LP route wires venue
 * config — R2 ships builders + template only.
 */
export const NFPM_56: Address = getAddress(
  "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
);

/**
 * `type(uint128).max` — the collect amount that means "everything owed".
 *
 * A zap-out collects the decreased principal PLUS accrued fees, and the exact
 * total is only knowable on-chain; uint128-max is the periphery's own idiom
 * for "all of it" (it clamps to `tokensOwed`). This is a sentinel the venue
 * defines, not a quantity judgement, which is why it is a module constant
 * rather than a parameter — the same standing as `NO_PRICE_LIMIT` in
 * `src/ops/pancakeV3.ts`.
 */
export const MAX_UINT128 = 2n ** 128n - 1n;

/** TickMath bounds. A tick outside these reverts on-chain; refuse offline. */
const MIN_TICK = -887272;
const MAX_TICK = 887272;

const MAX_UINT24 = 0xffffff;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function fail(builder: string, message: string): never {
  throw new Error(`${builder}: ${message}`);
}

/**
 * Refuse the zero address for any recipient-shaped parameter.
 *
 * On this periphery `address(0)` is the "keep it here" sentinel (Rev2 item 6),
 * so a zero recipient is never a typo with small consequences: proceeds either
 * strand in the NFPM or the mint's NFT is minted to nobody. The rule is
 * structural here so no caller can reach the sentinel by accident.
 */
function requireRealAddress(builder: string, field: string, value: Address): void {
  if (value.toLowerCase() === ZERO_ADDRESS) {
    fail(builder, `${field} must not be the zero address — on this periphery it is the "keep it in the contract" sentinel, not a recipient.`);
  }
}

/**
 * Validate the pool's leg ordering and locate the WBNB leg.
 *
 * V3 pools order `token0 < token1` (numeric address order) and the NFPM's
 * structs are expressed in that order — an unsorted pair encodes a call into a
 * pool that does not exist. Identical legs are refused here too (the
 * "identical-token legs throw" invariant). Lowercased hex compares exactly as
 * the underlying uint160 does because both strings are fixed-width.
 */
function orderedLegs(
  builder: string,
  token0: Address,
  token1: Address,
  wbnb: Address,
): { readonly wbnbLeg: 0 | 1; readonly token: Address } {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (t0 === t1) fail(builder, "token0 and token1 are the same address; a pool has two distinct legs.");
  if (t0 > t1) fail(builder, "token0/token1 are not in pool order (token0 < token1). Reordering silently would also have to swap every per-leg amount, so the caller must pass them sorted.");
  const w = wbnb.toLowerCase();
  if (w === t0) return { wbnbLeg: 0, token: token1 };
  if (w === t1) return { wbnbLeg: 1, token: token0 };
  fail(builder, "neither leg is WBNB. v1 refuses pools without a WBNB leg (PHASE3 spec, fail-closed).");
}

function validateTicks(builder: string, tickLower: number, tickUpper: number): void {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) {
    fail(builder, "ticks must be integers.");
  }
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
    fail(builder, `ticks must lie within [${MIN_TICK}, ${MAX_TICK}].`);
  }
  if (tickLower >= tickUpper) {
    fail(builder, "tickLower must be strictly below tickUpper.");
  }
  // Spacing alignment is NOT checked here: tick spacing must be read from the
  // factory/pool (never assumed — PHASE3 venue facts), and this module is
  // deliberately offline. A misaligned tick reverts on-chain; the R10 layer
  // that derives ranges snaps to spacing before any builder runs.
}

function validateFee(builder: string, fee: number): void {
  if (!Number.isInteger(fee) || fee <= 0 || fee > MAX_UINT24) {
    fail(builder, "fee must be a positive uint24 fee tier. The valid tier set is the factory's, read on-chain, never assumed here.");
  }
}

function validateDeadline(builder: string, deadline: bigint): void {
  if (deadline <= 0n) fail(builder, "deadline must be a positive unix-seconds value. Rev2 item 23: every NFPM call carries now + TRADE_DEADLINE_SEC.");
}

function validateTokenId(builder: string, tokenId: bigint): void {
  // NFPM tokenIds start at 1 (`_nextId = 1` in the periphery), so 0 is never a
  // real position — it is the classic "unset bigint" default, refused offline.
  if (tokenId <= 0n) fail(builder, "tokenId must be a positive position id; NFPM ids start at 1.");
}

/**
 * Validate one DEPOSIT leg (mint/increase): the desired amount and its floor.
 *
 * The floor rule restates Rev2 item 23 at the builder boundary: a leg that
 * deposits (`desired > 0`) MUST carry a floor of at least 1 wei — "zero/absent
 * floors are a build error, not a default" — and a leg that deposits nothing
 * (single-sided range) MUST carry a zero floor, because the pool will deliver
 * zero and any positive minimum reverts the whole batch. Builders cannot
 * DERIVE floors (that needs the rail-checked price), but they can refuse the
 * two shapes that are always wrong.
 */
function validateDepositLeg(
  builder: string,
  label: string,
  desired: bigint,
  min: bigint,
): void {
  if (desired < 0n || min < 0n) fail(builder, `${label} amounts must not be negative.`);
  if (desired > 0n && min <= 0n) {
    fail(builder, `${label} deposits ${desired} but carries no minimum. Floors are derived server-side (Rev2 item 23) and are at least 1 wei; a zero floor here is a forgotten derivation, not a choice.`);
  }
  if (desired === 0n && min > 0n) {
    fail(builder, `${label} deposits nothing but demands a minimum of ${min}, which can only revert.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Shared encoders (each corresponds to exactly one granted selector)          */
/* -------------------------------------------------------------------------- */

type MintFields = {
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly amount0DesiredWei: bigint;
  readonly amount1DesiredWei: bigint;
  readonly amount0MinWei: bigint;
  readonly amount1MinWei: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
};

function encodeMint(fields: MintFields): Hex {
  return encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "mint",
    args: [
      {
        token0: fields.token0,
        token1: fields.token1,
        fee: fields.fee,
        tickLower: fields.tickLower,
        tickUpper: fields.tickUpper,
        amount0Desired: fields.amount0DesiredWei,
        amount1Desired: fields.amount1DesiredWei,
        amount0Min: fields.amount0MinWei,
        amount1Min: fields.amount1MinWei,
        recipient: fields.recipient,
        deadline: fields.deadline,
      },
    ],
  }) as Hex;
}

function encodeDecrease(params: {
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly amount0MinWei: bigint;
  readonly amount1MinWei: bigint;
  readonly deadline: bigint;
}): Hex {
  return encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: params.tokenId,
        liquidity: params.liquidity,
        amount0Min: params.amount0MinWei,
        amount1Min: params.amount1MinWei,
        deadline: params.deadline,
      },
    ],
  }) as Hex;
}

function encodeCollectAll(tokenId: bigint, recipient: Address): Hex {
  return encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "collect",
    args: [
      {
        tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ],
  }) as Hex;
}

/**
 * Shared validation for a zap-out's decrease leg.
 *
 * Zap-out floors differ from deposit floors: an out-of-range position — which
 * a rotate's exit usually IS, since out-of-range is the trigger — holds its
 * whole principal in ONE leg, so a zero minimum on the empty leg is correct
 * and a 1-wei floor there would revert the decrease. What is never correct is
 * BOTH floors zero: a decrease of real liquidity always returns value in at
 * least one leg, and two zero floors are the signature of a forgotten R10
 * derivation, i.e. a sandwichable exit.
 */
function validateZapOut(
  builder: string,
  params: {
    readonly tokenId: bigint;
    readonly liquidity: bigint;
    readonly amount0MinWei: bigint;
    readonly amount1MinWei: bigint;
    readonly deadline: bigint;
    readonly wallet: Address;
  },
): void {
  validateTokenId(builder, params.tokenId);
  if (params.liquidity <= 0n) fail(builder, "liquidity must be positive; a zero decrease moves nothing.");
  if (params.liquidity > MAX_UINT128) fail(builder, "liquidity exceeds uint128.");
  if (params.amount0MinWei < 0n || params.amount1MinWei < 0n) {
    fail(builder, "minimums must not be negative.");
  }
  if (params.amount0MinWei === 0n && params.amount1MinWei === 0n) {
    fail(builder, "both minimums are zero — no floor bounds this exit. Floors are derived server-side (Rev2 item 23); an out-of-range position has ONE zero leg, never two.");
  }
  validateDeadline(builder, params.deadline);
  requireRealAddress(builder, "wallet", params.wallet);
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

export type LpOpenParams = {
  /** The NFPM — call target AND, on the zap-out path, collect's recipient. */
  readonly nfpm: Address;
  /** Pool legs, in POOL ORDER (`token0 < token1`); one of them MUST be WBNB. */
  readonly token0: Address;
  readonly token1: Address;
  /** Which address is WBNB. Decides which leg's desired becomes the `value`. */
  readonly wbnb: Address;
  /** Fee tier from the pool itself (uint24, millionths). */
  readonly fee: number;
  /** Range bounds, already snapped to the pool's tick spacing (R10). */
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly amount0DesiredWei: bigint;
  readonly amount1DesiredWei: bigint;
  /** Server-derived floors (Rev2 item 23). Carried verbatim. */
  readonly amount0MinWei: bigint;
  readonly amount1MinWei: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly recipient: Address;
  /** Unix SECONDS. The route computes `now + TRADE_DEADLINE_SEC`. */
  readonly deadline: bigint;
};

/**
 * Open a position paying the WBNB leg in NATIVE BNB: `[mint{value}, refundETH]`
 * — the one place native attaches (Rev2 items 3 and 14).
 *
 * `value` is EXACTLY the WBNB leg's `amountDesired`, derived from `wbnb`
 * rather than taken as a separate parameter so the two can never disagree:
 * the periphery's `pay()` uses native only for the WETH9 leg, takes what the
 * pool actually needs, and `refundETH` — the second call of the SAME atomic
 * ERC-7821 batch, so the leftover is still sitting in the NFPM when it runs —
 * returns the remainder to the wallet (`msg.sender`).
 *
 * The TOKEN leg, when non-zero, is pulled via `transferFrom` and needs a
 * caller-composed `buildApprove(token, nfpm, exactAmount)` in the same batch
 * (see the module docstring's composition seam).
 */
export function buildLpOpenBatch(params: LpOpenParams): readonly WalletCall[] {
  const builder = "buildLpOpenBatch";
  const legs = orderedLegs(builder, params.token0, params.token1, params.wbnb);
  validateFee(builder, params.fee);
  validateTicks(builder, params.tickLower, params.tickUpper);
  validateDeadline(builder, params.deadline);
  requireRealAddress(builder, "recipient", params.recipient);
  validateDepositLeg(builder, "leg 0", params.amount0DesiredWei, params.amount0MinWei);
  validateDepositLeg(builder, "leg 1", params.amount1DesiredWei, params.amount1MinWei);

  const wbnbDesired =
    legs.wbnbLeg === 0 ? params.amount0DesiredWei : params.amount1DesiredWei;
  if (wbnbDesired <= 0n) {
    fail(builder, "the WBNB leg deposits nothing, so there is no native to attach. A token-only single-sided open pays by approve — use buildLpMintWbnbBatch's shape.");
  }

  return [
    {
      to: params.nfpm,
      value: wbnbDesired,
      data: encodeMint(params),
    },
    { to: params.nfpm, data: encodeRefundEth() },
  ];
}

function encodeRefundEth(): Hex {
  return encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "refundETH",
  }) as Hex;
}

export type LpMintWbnbParams = LpOpenParams;

/**
 * Rotate's re-mint, paying BOTH legs as ERC-20s — NO value on any call
 * (Rev2 item 14: only `/lp/open` attaches native; the freed WBNB from the
 * zap-out stays WBNB and comes back in via `approve` + `transferFrom`,
 * metered against the WBNB cap rather than the native budget).
 *
 * Exactly `[approve(WBNB, nfpm, wbnbDesired), approve(TOKEN, nfpm,
 * tokenDesired), mint]` — approves ordered by ROLE (WBNB first), not by leg
 * index, so the shape is the same whichever leg WBNB sorts into. EXACT
 * amounts, never max (Rev2 item 15): a max-approve would be metered at
 * ~2^256 against the token's cap and trap the session in one call. A
 * zero-amount leg (single-sided re-mint) still gets its `approve(0)` so the
 * batch shape is constant — a zero approve moves no meter and doubles as an
 * allowance reset.
 *
 * No `refundETH`: nothing native is attached, so there is never anything to
 * refund, and a batch call that can only be a no-op is surface without work.
 */
export function buildLpMintWbnbBatch(params: LpMintWbnbParams): readonly WalletCall[] {
  const builder = "buildLpMintWbnbBatch";
  const legs = orderedLegs(builder, params.token0, params.token1, params.wbnb);
  validateFee(builder, params.fee);
  validateTicks(builder, params.tickLower, params.tickUpper);
  validateDeadline(builder, params.deadline);
  requireRealAddress(builder, "recipient", params.recipient);
  validateDepositLeg(builder, "leg 0", params.amount0DesiredWei, params.amount0MinWei);
  validateDepositLeg(builder, "leg 1", params.amount1DesiredWei, params.amount1MinWei);
  if (params.amount0DesiredWei === 0n && params.amount1DesiredWei === 0n) {
    fail(builder, "both legs deposit nothing; there is no position to mint.");
  }

  const wbnbDesired =
    legs.wbnbLeg === 0 ? params.amount0DesiredWei : params.amount1DesiredWei;
  const tokenDesired =
    legs.wbnbLeg === 0 ? params.amount1DesiredWei : params.amount0DesiredWei;

  return [
    buildApprove(params.wbnb, params.nfpm, wbnbDesired),
    buildApprove(legs.token, params.nfpm, tokenDesired),
    { to: params.nfpm, data: encodeMint(params) },
  ];
}

export type LpIncreaseParams = {
  readonly nfpm: Address;
  readonly tokenId: bigint;
  /** Pool legs in POOL ORDER; one MUST be WBNB. Needed to route the approves. */
  readonly token0: Address;
  readonly token1: Address;
  readonly wbnb: Address;
  readonly amount0DesiredWei: bigint;
  readonly amount1DesiredWei: bigint;
  /** Server-derived floors (Rev2 item 23). Carried verbatim. */
  readonly amount0MinWei: bigint;
  readonly amount1MinWei: bigint;
  readonly deadline: bigint;
};

/**
 * Harvest's compounding tail: `[approve(WBNB, nfpm, exact), approve(TOKEN,
 * nfpm, exact), increaseLiquidity]` on the SAME tokenId — no value anywhere
 * (Rev2 items 14/15; see {@link buildLpMintWbnbBatch} for the approve rules,
 * which are identical here).
 */
export function buildLpIncreaseBatch(params: LpIncreaseParams): readonly WalletCall[] {
  const builder = "buildLpIncreaseBatch";
  const legs = orderedLegs(builder, params.token0, params.token1, params.wbnb);
  validateTokenId(builder, params.tokenId);
  validateDeadline(builder, params.deadline);
  validateDepositLeg(builder, "leg 0", params.amount0DesiredWei, params.amount0MinWei);
  validateDepositLeg(builder, "leg 1", params.amount1DesiredWei, params.amount1MinWei);
  if (params.amount0DesiredWei === 0n && params.amount1DesiredWei === 0n) {
    fail(builder, "both legs deposit nothing; there is nothing to compound.");
  }

  const wbnbDesired =
    legs.wbnbLeg === 0 ? params.amount0DesiredWei : params.amount1DesiredWei;
  const tokenDesired =
    legs.wbnbLeg === 0 ? params.amount1DesiredWei : params.amount0DesiredWei;

  const increase = encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "increaseLiquidity",
    args: [
      {
        tokenId: params.tokenId,
        amount0Desired: params.amount0DesiredWei,
        amount1Desired: params.amount1DesiredWei,
        amount0Min: params.amount0MinWei,
        amount1Min: params.amount1MinWei,
        deadline: params.deadline,
      },
    ],
  }) as Hex;

  return [
    buildApprove(params.wbnb, params.nfpm, wbnbDesired),
    buildApprove(legs.token, params.nfpm, tokenDesired),
    { to: params.nfpm, data: increase },
  ];
}

export type LpZapOutParams = {
  readonly nfpm: Address;
  readonly tokenId: bigint;
  /** Pool legs in POOL ORDER; one MUST be WBNB. Routes the unwrap/sweep legs. */
  readonly token0: Address;
  readonly token1: Address;
  readonly wbnb: Address;
  /** Liquidity to remove (uint128). 100% for protect. */
  readonly liquidity: bigint;
  /**
   * Server-derived decrease floors (Rev2 item 23), per POOL leg. The SAME
   * numbers double as the unwrap/sweep minimums: collect returns the decreased
   * principal PLUS accrued fees, so the decrease floor is a valid (weaker)
   * floor for the forwarded balance — one pair of numbers, no second source
   * to disagree with the first. `amountOutMinimum`-style protection lives in
   * the decrease mins; the unwrap/sweep minimums are the same belt-and-braces
   * the 2.2 sell documents for `unwrapWETH9`.
   */
  readonly amount0MinWei: bigint;
  readonly amount1MinWei: bigint;
  readonly deadline: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly wallet: Address;
};

/**
 * Protect's exit, unwrapping to NATIVE: `[decreaseLiquidity, collect(recipient
 * = THE NFPM ITSELF), unwrapWETH9(→ wallet), sweepToken(TOKEN, → wallet)]` in
 * one atomic batch.
 *
 * The collect recipient is the NFPM's OWN LITERAL ADDRESS — never
 * `address(0)`, which the periphery maps to `address(this)` (Rev2 item 6; the
 * 2.2 recipient-sentinel rule). Both legs land in the NFPM, then `unwrapWETH9`
 * converts the WBNB leg to native for the wallet and `sweepToken` forwards the
 * TOKEN leg. Protect is the ONLY saga that unwraps (Rev2 item 14) — the native
 * proceeds are what the off-chain daily-cap accounting counts.
 */
export function buildLpZapOutBatch(params: LpZapOutParams): readonly WalletCall[] {
  const builder = "buildLpZapOutBatch";
  const legs = orderedLegs(builder, params.token0, params.token1, params.wbnb);
  validateZapOut(builder, params);

  const wbnbMin = legs.wbnbLeg === 0 ? params.amount0MinWei : params.amount1MinWei;
  const tokenMin = legs.wbnbLeg === 0 ? params.amount1MinWei : params.amount0MinWei;

  const unwrap = encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "unwrapWETH9",
    args: [wbnbMin, params.wallet],
  }) as Hex;
  const sweep = encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "sweepToken",
    args: [legs.token, tokenMin, params.wallet],
  }) as Hex;

  return [
    { to: params.nfpm, data: encodeDecrease(params) },
    // NOT address(0). See the module docstring and Rev2 item 6.
    { to: params.nfpm, data: encodeCollectAll(params.tokenId, params.nfpm) },
    { to: params.nfpm, data: unwrap },
    { to: params.nfpm, data: sweep },
  ];
}

export type LpZapOutKeepWbnbParams = {
  readonly nfpm: Address;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  /** Server-derived decrease floors (Rev2 item 23), per POOL leg. */
  readonly amount0MinWei: bigint;
  readonly amount1MinWei: bigint;
  readonly deadline: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly wallet: Address;
};

/**
 * Rotate's exit, keeping WBNB AS WBNB: `[decreaseLiquidity, collect(recipient
 * = wallet)]` — two calls, nothing else.
 *
 * No `unwrapWETH9` (Rev2 item 14: the rotate zap-out does NOT unwrap — the
 * freed WBNB funds the re-mint through the WBNB cap, keeping rotations
 * native-cap-neutral). And with no unwrap there is no reason to park anything
 * in the NFPM: collect pays ERC-20s directly to any recipient the owner
 * names, so both legs go straight to the wallet and no `sweepToken` is needed
 * — the sweep exists to drain the periphery's own balance, and this path
 * never creates one (choice documented in the module docstring).
 *
 * Note this variant needs no token0/token1/wbnb at all: with no per-leg
 * routing of proceeds, the leg identities never enter the calldata.
 */
export function buildLpZapOutKeepWbnbBatch(
  params: LpZapOutKeepWbnbParams,
): readonly WalletCall[] {
  const builder = "buildLpZapOutKeepWbnbBatch";
  validateZapOut(builder, params);

  return [
    { to: params.nfpm, data: encodeDecrease(params) },
    { to: params.nfpm, data: encodeCollectAll(params.tokenId, params.wallet) },
  ];
}

export type LpCollectParams = {
  readonly nfpm: Address;
  readonly tokenId: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly wallet: Address;
};

/**
 * Harvest's fee collection: ONE `collect(tokenId, recipient = wallet,
 * uint128-max, uint128-max)` call, nothing else (ADDITIVE builder for the
 * harvest saga's `collect-fees` step — the spec body's step list needs a
 * collect with NO decrease leg, and none of the zap-out batches has that
 * shape).
 *
 * The recipient is the WALLET, not the NFPM: parking proceeds in the NFPM is
 * required only when a leg must be unwrapped (module docstring), and harvest
 * never unwraps — it pays its compounding tail in WBNB (Rev2 item 14), so the
 * collected WBNB fee leg stays WBNB and both legs go straight home. The
 * uint128-max sentinels are the periphery's own "everything owed" idiom
 * ({@link MAX_UINT128}); liquidity is untouched, so no floor parameter exists
 * on this call — the R10 floors guard the legs that price risk can move
 * (swaps, mints, decreases), and a fee collect has none.
 */
export function buildCollectToWallet(params: LpCollectParams): readonly WalletCall[] {
  const builder = "buildCollectToWallet";
  validateTokenId(builder, params.tokenId);
  requireRealAddress(builder, "wallet", params.wallet);
  return [{ to: params.nfpm, data: encodeCollectAll(params.tokenId, params.wallet) }];
}

/**
 * Burn an emptied position NFT. Standalone — a burn only succeeds after the
 * position's liquidity and owed fees are zero, so it follows a confirmed
 * zap-out rather than riding in its batch (a collect that leaves 1 wei of
 * fees behind would otherwise revert the whole exit).
 */
export function buildBurn(nfpm: Address, tokenId: bigint): WalletCall {
  validateTokenId("buildBurn", tokenId);
  return {
    to: nfpm,
    data: encodeFunctionData({
      abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
      functionName: "burn",
      args: [tokenId],
    }) as Hex,
  };
}
