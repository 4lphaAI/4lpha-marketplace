/**
 * The canonical session template for a trade agent.
 *
 * This is a BUILDER for the marketplace to call at hire time. Nothing in this
 * phase grants a session; what lives here is the one honest description of what
 * a trade agent needs to be able to do, so that every trade agent is granted the
 * same shape and that shape can be reviewed once instead of per hire.
 *
 * ═══ WHAT THE TEMPLATE GRANTS (PHASE2.3) ═══════════════════════════════════
 *
 *   - one `{ to: <venue> }` rule per configured venue (routers, the Four.Meme
 *     manager);
 *   - for EVERY token the caller names: a TARGET-BOUND
 *     `{ to: <token>, selector: "approve(address,uint256)" }` rule AND a
 *     matching per-token spend cap. Both, always, or the agent can buy and
 *     never sell — see below;
 *   - `{ to: <treasury> }` when a fee is configured, with NO token cap (R10).
 *
 * The BARE-SELECTOR `approve` this template used to grant — `approve` on every
 * contract on the chain, for any spender, for any amount — is GONE, and with it
 * `allowUnrestrictedSelector`. A leaked session key can now only approve the
 * tokens named at hire. That is a strict tightening, and it is what the old
 * "blast radius" docstring existed to warn about.
 *
 * ═══ PER-TOKEN CAPS: WHY A SELL NEEDS ONE ═════════════════════════════════
 *
 * A session carries TWO independent grants: the allowlist, and a spend limit
 * PER TOKEN. FINDINGS (h), proven on BNB mainnet: with the allowlist granted
 * for every token and a cap for native BNB only, `GuardedExecutor` counts a
 * sell's `approve` as spending that token, finds no limit for it, and the
 * relay's simulation reverts. The failure is SILENT — `status: "PENDING"`, no
 * transaction, no gas — so it reads like a slow relay rather than a refusal.
 *
 * The correction to the record this module used to carry: the previous
 * docstring asserted at length that "APPROVALS ARE NOT BOUNDED BY THE SPEND
 * CAPS". That is FALSE on Altana and the whole chain of reasoning built on it
 * has been removed. `spendInfos(keyHash)` read after four live sells shows
 * every sold token with `currentSpent` equal to the amount approved:
 * `GuardedExecutor` METERS `approve` against the token's own cap and decrements
 * it (PHASE2.3 spec, FINDINGS (h)/(j)).
 *
 * ═══ A TOKEN CAP IS A GATE, NOT A BUDGET (PHASE2.3 R4) ════════════════════
 *
 * Because `approve` is metered, the cap's MAGNITUDE is a meter, not a risk
 * knob — and sizing it tight is actively harmful:
 *
 *   - an agent can only sell what it holds, and it only holds what it bought
 *     with NATIVE, which the native cap already bounds. A tight token cap adds
 *     almost no security;
 *   - every sell does `approve(0)` then `approve(amount)` (FINDINGS (j)), so
 *     selling one token twice in a period charges `2 x amount`. "How much can
 *     be sold per period" is not what the meter measures;
 *   - the moment appreciation or a second round trip pushes summed approvals
 *     past a finite limit, the exit is TRAPPED — the same silent un-sellable
 *     failure this phase exists to remove.
 *
 * So token caps default to {@link DEFAULT_TOKEN_CAP_LIMIT} (`2^160`, what the
 * live remediation used) and are documented as *a gate that satisfies on-chain
 * approve-metering*. THE SPEND BUDGET IS THE NATIVE CAP ON BUYS. A caller may
 * still set a finite token cap; if it does, it must size it at or above the
 * SUMMED per-period approvals (position x round-trips), never the position.
 *
 * LP ADDS A CONSUMER NOTHING CHECKS (PHASE3.1-AUDIT A11). {@link
 * checkLpNativeCapSizing} models the NATIVE cap only, and PHASE3.1's exit swap
 * meters `approve(TOKEN, router, freed)` against the TOKEN cap — a consumer
 * Phase 3's protect did not have at all. So a finite `token.limit` must now
 * also carry one protect-approval PER OPEN POSITION on top of the trading
 * round-trips above. Inert for what ships (`lpSessionSpec` defaults to
 * {@link DEFAULT_TOKEN_CAP_LIMIT} and `live-lp` passes no limit), and DELIBERATELY
 * left unmodelled: the sizing helper's inputs are native-only and adding a
 * token axis to it is a design change.
 *
 * HOW EXHAUSTION PRESENTS (corrected by PHASE3.1-FIXREVIEW F4). It reverts
 * `ExceededSpendLimit`, which `mapProviderError` classifies from the selector
 * as `CAP_EXCEEDED` — a PRODUCT refusal. So the optional step skips TERMINALLY
 * on the FIRST attempt, with no retry at all: audit A1's bounded retry covers
 * the transport class and deliberately does not cover this one. That is the
 * right behaviour — an on-chain cap does not refill inside a retry budget, so
 * retrying would only spend round trips before reaching the same answer — but
 * this docstring previously described it as "a bounded retry and then a skip",
 * which is the sentence a future reader would rely on when they finally model
 * the token axis. The recorded skip does name the refusal, and that part holds.
 *
 * Two residuals, stated rather than implied:
 *
 *   1. a generous cap lets a leaked exec token force-sell an owner-held balance
 *      of a GRANTED token up to that cap. The proceeds land in the owner's own
 *      wallet as native — a conversion, not a drain — and the spender of every
 *      approval is still hardcoded by the trade route from resolved config,
 *      never from a request field (PHASE2 OQ1: `CallRule` cannot constrain an
 *      argument, so the SPENDER is bounded by the route, not by the grant);
 *   2. INVARIANT — TRADE BUILDERS MUST APPROVE EXACT AMOUNTS. A max/unlimited
 *      approve is incompatible with a spend-cap-bearing session: it would be
 *      metered at `type(uint256).max` and exhaust any finite cap in one call,
 *      re-creating the trap. `src/ops/abis.ts` (`ERC20_APPROVE_ABI`) and the
 *      pancake/pancakeV3/fourmeme sell builders all approve the exact amount;
 *      that is a requirement of this template, not a stylistic choice.
 *
 * ═══ WHAT REMAINS TRUE FROM THE OLD BOUND LIST ════════════════════════════
 *
 *   1. this server holds the session key, and no route hands it out;
 *   2. the trade route HARDCODES the spender — it is the venue resolved from
 *      config or from the data-plane read, never a request field;
 *   3. the raw `POST /agents/:id/execute` route is disabled by default
 *      (`EXECUTE_RAW_ENABLED`, PHASE2 R2). Its drain path is NARROWED by this
 *      phase, not closed — see {@link resolveExecuteRawEnabled};
 *   4. the pre-flight evaluates the allowlist PER CALL (PHASE2 R1) — against
 *      the granted snapshot UNION THE ACCOUNT'S LIVE ALLOWLIST (PHASE2.4 R1).
 *      Corrected here rather than left standing: since 2.4 a snapshot refusal
 *      is not the final answer, so this bound is WIDER than it used to read. A
 *      leaked `x-exec-token` now reaches the union of every target any owner
 *      has ever authorised on chain for this key — strictly more than the
 *      snapshot, growing with every `owner-add-spend-limit` and shrinking only
 *      on revoke. It is still bounded by the on-chain caps, the on-chain
 *      allowlist, expiry, the two targets the pre-flight refuses
 *      unconditionally (the wallet itself and the KeyStore, never eligible for
 *      the chain fallback), and the per-agent throttle;
 *   5. the session expires within {@link MAX_TRADE_SESSION_SECONDS}.
 */
import {
  InvalidSessionSpecError,
  type CallRule,
  type SessionSpec,
  type SpendCap,
  type SpendPeriod,
} from "../core/types.js";
import { validateSessionSpec } from "../core/session.js";
import type { Address } from "viem";
import { RELAY_FEE_PER_EXIT_WEI } from "./relayFee.js";
export { RELAY_FEE_PER_EXIT_WEI } from "./relayFee.js";
import type { VenueConfig } from "./venues.js";

/**
 * Hard ceiling on a trade session, in seconds.
 *
 * SEVEN DAYS (PHASE2.3 R5), up from 24 hours. The 24h ceiling had two purposes
 * and only one of them is gone. It bounded the unrestricted `approve`, which no
 * longer exists — but it also bounded LIFETIME NATIVE EXPOSURE, and per-token
 * caps do nothing for that: Altana caps are rolling per period with NO lifetime
 * ceiling (FINDINGS (d)), so a session's real native exposure is
 * `per-period cap x periods in the session`. Thirty days would multiply it 30x
 * with no compensating control; seven removes the daily-reauth pain just as
 * effectively and holds native exposure to 7x (0.05 BNB/day -> 0.35 BNB), which
 * is the "consider 7 for real money" recommendation in FINDINGS (g).
 *
 * UI REQUIREMENT that comes with it (FINDINGS (r)): show the user the PRODUCT
 * — cap x periods — never the per-period rate alone.
 */
export const MAX_TRADE_SESSION_SECONDS = 7 * 24 * 60 * 60;

/** The `approve` grant this template needs, in canonical signature form. */
export const APPROVE_SELECTOR = "approve(address,uint256)";

/**
 * PHASE3.19 item 1 — WBNB's payable zero-arg wrap, in canonical signature form.
 *
 * The ONE selector this phase adds to `lpSessionSpec`, and the ONE the review's
 * discharge of §4.2's STOP-AND-REVIEW clause covers. `withdraw(uint256)` is
 * deliberately absent: nothing in the ladder unwraps.
 *
 * A zero-arg canonical signature is already grantable — `refundETH()` is in
 * {@link NFPM_GRANTED_SELECTORS} and validates today — and `deposit` is NOT in
 * `VALUE_MOVING_SIGNATURES`, so `assertTokenMoversAreCapped` demands no cap for
 * it. WBNB carries one anyway.
 */
export const WBNB_DEPOSIT_SELECTOR = "deposit()";

/**
 * Default per-token cap: effectively unlimited.
 *
 * `2^160` — the value the live mainnet remediation used, and larger than any
 * ERC-20 total supply that fits in a `uint256` balance anyone will hold. It is
 * a GATE that satisfies on-chain approve-metering, NOT a budget. See the module
 * docstring (R4) before making it smaller.
 */
export const DEFAULT_TOKEN_CAP_LIMIT = 2n ** 160n;

/** Default rolling period for a per-token cap (PHASE2.3 R9). */
export const DEFAULT_TOKEN_CAP_PERIOD: SpendPeriod = "day";

/**
 * One ERC-20 the agent may trade.
 *
 * TRADING-AGENT R3.5: hire may pin by volume, bounded by byte-exact S3 convergence plus `grantsTokenSell` at build.
 */
export type TokenGrant = {
  /** The ERC-20. Gets an `approve` rule AND a spend cap. */
  readonly token: Address;
  /** Per-token cap. Defaults to {@link DEFAULT_TOKEN_CAP_LIMIT}. A gate. */
  readonly limit?: bigint;
  /** Rolling period. Defaults to {@link DEFAULT_TOKEN_CAP_PERIOD}. */
  readonly period?: SpendPeriod;
};

export type TradeSessionSpecInput = {
  /** Venue addresses to allow. Absent fields are simply not granted. */
  readonly venues: VenueConfig;
  /** Fee treasury, when a fee is configured. Granted as a transfer target. */
  readonly treasury?: Address;
  /**
   * ERC-20s this agent may trade. Each yields an `approve` rule AND a cap.
   *
   * MAY BE EMPTY (PHASE2.3 R6) — the boot-time treasury probe needs it so. An
   * empty list is a buy-nothing agent: the trade route refuses every buy whose
   * token has no cap (R1), which is a coherent degenerate state rather than the
   * FINDINGS (h) trap.
   *
   * Deduplicated by lowercased address before rules are emitted: the granted
   * permissions are part of the on-chain key descriptor, and a duplicate rule
   * would change the bytes `restoreSession` has to reproduce.
   */
  readonly tokens: readonly TokenGrant[];
  /**
   * NATIVE spend caps. MUST be non-empty; none may name a token.
   *
   * A LIST, not a single cap (PHASE2.3 R6): provisioning grants a rolling day
   * cap plus an optional per-trade `minute` cap, and a singular field cannot
   * express that pair. THIS is the agent's real spend budget — buys spend
   * native, and so do the ~1% fee transfers (R10 corollary), so a native cap
   * must budget both.
   *
   * ═══ AND THE RELAY'S GAS. MEASURED, NOT DESIGNED (PHASE2.4 R6) ═══════════
   *
   * The Altana relay pays the gas and then REIMBURSES ITSELF IN NATIVE OUT OF
   * THE WALLET, and the account meters that reimbursement against this very
   * cap. Measured on sell tx `0x33a0b081…d5f`, block 115495477:
   *
   *   on-chain gas paid by the relay   15 744 400 000 000 wei
   *   session native meter increment   24 825 550 000 000 wei   (~1.58x)
   *   the trade's own native movement  +298 573 734 835 866 wei (INBOUND)
   *
   * A sell moves no native outward and the meter still moved. There is no
   * second bucket to put gas in — the account has ONE native meter per key — so
   * this is stated, not faked away with a "reserve N% for gas" rule enforced
   * nowhere.
   *
   * THE CONSEQUENCE IS A TRAPPED EXIT, and it is the fourth member of the
   * (h)/(u)/(v) family: **a sell needs native-cap headroom even though it
   * spends none**, so an agent that has spent its native cap on buys cannot get
   * out. It arrives on a healthy agent with no operator error, and it defeats
   * the FINDINGS (s) pause carve-out exactly when that carve-out matters — an
   * owner who pauses a runaway agent gets the server-side permission to exit
   * and no on-chain ability to. See {@link checkNativeCapSizing}, which
   * `provision-agent` and `dev-stack` REFUSE on rather than warn about.
   */
  readonly nativeCaps: readonly SpendCap[];
  /** Requested expiry, unix SECONDS. CLAMPED to 7 days — see below. */
  readonly expiresAt: number;
  /** Clock, unix SECONDS. Injected so the clamp is testable. */
  readonly nowSeconds?: number;
};

/**
 * Build the canonical trade `SessionSpec`.
 *
 * `expiresAt` is CLAMPED, not rejected: a caller asking for a month gets seven
 * days. Clamping rather than throwing is deliberate — a marketplace that
 * requested too long should still be able to hire, and the ceiling is a property
 * of the template rather than an argument error. The returned spec always
 * carries the effective expiry, so a caller that persists what it received (as
 * every caller must, byte-exact) records the truth.
 *
 * The result is run through `validateSessionSpec` before it is returned, so an
 * unusable template fails here rather than at a grant that costs gas.
 */
export function tradeSessionSpec(input: TradeSessionSpecInput): SessionSpec {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ceiling = nowSeconds + MAX_TRADE_SESSION_SECONDS;
  const expiresAt = Math.min(input.expiresAt, ceiling);

  if (input.nativeCaps.length === 0) {
    throw new InvalidSessionSpecError(
      "tradeSessionSpec requires at least one native spend cap; an empty list is uncapped.",
    );
  }
  for (const [index, cap] of input.nativeCaps.entries()) {
    if (cap.token !== undefined) {
      // A token cap smuggled in here would arrive WITHOUT the `approve` rule
      // that makes it useful, and would sit outside the dedup below.
      throw new InvalidSessionSpecError(
        `nativeCaps[${index}] names a token. Per-token caps come from \`tokens\`, which grants the matching approve rule too.`,
      );
    }
  }

  // Dedup by lowercased address, keeping the FIRST grant for each token
  // (PHASE2.3 R6). `validateSessionSpec` dedups spend caps by `token:period`
  // only — so the same token at two periods would pass — and nothing dedups the
  // call array at all.
  const seen = new Set<string>();
  const tokens: TokenGrant[] = [];
  for (const grant of input.tokens) {
    const key = grant.token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(grant);
  }

  const allowedCalls: CallRule[] = [
    ...(input.venues.pancakeRouterV2 === undefined
      ? []
      : [{ to: input.venues.pancakeRouterV2 }]),
    // The V3 router, granted alongside the V2 one (PHASE2.2). TIMING MATTERS:
    // the allowlist is signed on-chain at grant time and a persisted
    // `sessionFacts.spec` is never rewritten, so a session granted before this
    // line existed cannot call the V3 router — `assertTargetsAllowed` rejects
    // it locally, before the relay sees it. The cost of adding it late is up to
    // one session lifetime of V3 unavailability per already-hired agent, which
    // is why this ships before provisioning, when it costs nothing.
    ...(input.venues.pancakeRouterV3 === undefined
      ? []
      : [{ to: input.venues.pancakeRouterV3 }]),
    ...(input.venues.fourMemeTokenManager === undefined
      ? []
      : [{ to: input.venues.fourMemeTokenManager }]),
    // The flap Portal (PHASE2.4). Target-only, like every other venue: it is
    // the swap target, and the `approve` a flap sell needs is granted per token
    // below — so a token already granted for Pancake is already sellable on
    // flap, and no new token rule is required. Same TIMING caveat as the V3
    // router above: a session granted before this line existed cannot call the
    // Portal, because a persisted spec is never rewritten.
    ...(input.venues.flapPortal === undefined
      ? []
      : [{ to: input.venues.flapPortal }]),
    // TARGET-BOUND approve, one per token. Not the bare-selector form: this is
    // the whole point of the phase. The SPENDER is an argument and `CallRule`
    // cannot constrain it (PHASE2 OQ1), so the spender stays bounded by the
    // trade route hardcoding it — unchanged, and still load-bearing.
    ...tokens.map((grant) => ({ to: grant.token, selector: APPROVE_SELECTOR })),
    // Granted so the fee transfer clears the on-chain policy. Without it a
    // configured fee turns every trade into an on-chain NOT_ALLOWED.
    //
    // NO TOKEN CAP, deliberately (PHASE2.3 R10): this is a target-only rule, so
    // `assertTokenMoversAreCapped` skips it (`functionName === undefined`), and
    // the fee is a NATIVE transfer already metered by the native cap. Do not
    // add a treasury token cap, and do not narrow this to a selector-bound
    // `transfer` — that WOULD trip the guard and then demand a cap for an
    // address that is not a token.
    ...(input.treasury === undefined ? [] : [{ to: input.treasury }]),
  ];

  const spendCaps: SpendCap[] = [
    ...input.nativeCaps,
    ...tokens.map((grant) => ({
      token: grant.token,
      limit: grant.limit ?? DEFAULT_TOKEN_CAP_LIMIT,
      period: grant.period ?? DEFAULT_TOKEN_CAP_PERIOD,
    })),
  ];

  const spec: SessionSpec = { allowedCalls, spendCaps, expiresAt };

  // Throws InvalidSessionSpecError on anything unusable — including an expiry
  // already in the past, which the clamp above cannot fix, and an approve rule
  // whose token has no matching cap, which is FINDINGS (h) caught at build time.
  validateSessionSpec(spec, { nowSeconds, maxSessionSeconds: MAX_TRADE_SESSION_SECONDS });
  return spec;
}

/* -------------------------------------------------------------------------- */
/* The LP session template (PHASE3 R2)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on an LP session, in seconds — the same seven days as
 * {@link MAX_TRADE_SESSION_SECONDS}, and for the same reason: Altana caps are
 * rolling per period with no lifetime ceiling (FINDINGS (d)), so session
 * length multiplies real native exposure. An LP agent is a SEPARATE session
 * with its own meter and expiry (PHASE3 Rev2 item 33), but nothing about LP
 * changes the exposure arithmetic that picked seven.
 */
export const MAX_LP_SESSION_SECONDS = MAX_TRADE_SESSION_SECONDS;

/**
 * The EXACT selector set granted on the NFPM, in the canonical tuple-expanded
 * forms the session grammar validates since PHASE3 R1 (`canonicalizeSignature`
 * via `toFunctionSignature`).
 *
 * Every selector was independently recomputed and located in the deployed
 * NFPM bytecode (PHASE3-REVIEW.md facts): 0x88316456, 0x219f5d17, 0x0c49ccbe,
 * 0xfc6f7865, 0x42966c68, 0x12210e8a, 0x49404b7c, 0xdf2ab5bb.
 *
 * WHAT IS ABSENT IS NORMATIVE (Rev2 items 3–4): no `multicall(bytes[])` — the
 * NFPM's Multicall delegatecalls to self, so a multicall grant is a
 * target-only grant in disguise — and no `approve` / `setApprovalForAll` /
 * `safeTransferFrom` / `transferFrom`, the NFT-authority surface the SAME
 * dispatcher carries. "No NFT approvals, ever" is a property of THIS list
 * plus the builders never emitting one plus `EXECUTE_RAW_ENABLED` defaulting
 * OFF — not of EIP-7702.
 */
export const NFPM_GRANTED_SELECTORS = [
  "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
  "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))",
  "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
  "collect((uint256,address,uint128,uint128))",
  "burn(uint256)",
  "refundETH()",
  "unwrapWETH9(uint256,address)",
  "sweepToken(address,uint256,address)",
] as const;

export type LpSessionSpecInput = {
  /** The NonfungiblePositionManager. Granted PER-SELECTOR only, never bare. */
  readonly nfpm: Address;
  /**
   * The dedicated V3 SwapRouter (pinned since 2.2). Granted TARGET-ONLY,
   * exactly as `tradeSessionSpec` grants it — see the docstring below for why
   * per-selector rules on the ROUTER would be a costume, not a tightening.
   */
  readonly routerV3: Address;
  /** The WBNB leg: gets an `approve` rule AND a cap (Rev2 item 14). */
  readonly wbnb: TokenGrant;
  /** The pool's non-WBNB leg: gets an `approve` rule AND a cap. */
  readonly token: TokenGrant;
  /**
   * Fee treasury. REQUIRED even though LP is fee-free in v1 (Rev2 item 30):
   * the allowlist is signed on-chain at grant time and a persisted spec is
   * never rewritten, so a later fee must be a config change, never a re-grant.
   */
  readonly treasury: Address;
  /** NATIVE spend caps. MUST be non-empty; none may name a token. */
  readonly nativeCaps: readonly SpendCap[];
  /** Requested expiry, unix SECONDS. CLAMPED to 7 days like the trade spec. */
  readonly expiresAt: number;
  /** Clock, unix SECONDS. Injected so the clamp is testable. */
  readonly nowSeconds?: number;
};

/**
 * Build the canonical LP `SessionSpec` for ONE position pool `(TOKEN, WBNB)`.
 *
 * ═══ THE NFPM GRANT SHAPE (PHASE3 Rev2 items 3–6) ══════════════════════════
 *
 * The NFPM is granted {@link NFPM_GRANTED_SELECTORS}, each as its own
 * TARGET-BOUND rule, and NEVER appears target-only. `multicall(bytes[])` is
 * not granted and no builder emits it (see `src/ops/nfpm.ts`); batching is
 * the atomic ERC-7821 execute batch. None of the eight names is in
 * `VALUE_MOVING_FUNCTIONS`, so no cap is demanded for the NFPM itself — the
 * value they move is metered where it actually flows: native on the open's
 * `mint{value}` (native cap), WBNB/TOKEN under `approve`+`transferFrom`
 * (their per-token caps).
 *
 * ═══ WHY THE ROUTER IS TARGET-ONLY WHEN THE NFPM IS NOT ════════════════════
 *
 * The rebalance swap leg reuses the PROVEN 2.2 builders verbatim, and those
 * wrap every swap in `multicall(bytes[])` on the router — so any per-selector
 * router grant would have to include `multicall`, and a multicall grant IS a
 * target-only grant in disguise (the delegatecall-to-self argument, same as
 * the NFPM). Per-selector rules on the router would therefore be a costume
 * over identical authority. The difference in treatment is a difference in
 * the dispatchers, verified in bytecode: the DEDICATED router carries no
 * approval, no NFT authority and no pull/approveMax surface (the reason 2.2
 * pinned it over the SmartRouter), while the NFPM carries `setApprovalForAll`
 * and friends — which is exactly what item 3 exists to keep unreachable.
 *
 * ═══ CAPS (Rev2 items 14–15) ═══════════════════════════════════════════════
 *
 * `nativeCaps` fund the open's `mint{value}` and the relay's per-submission
 * gas reimbursement (FINDINGS (w)). WBNB and TOKEN each carry an approve rule
 * AND a cap — both halves, always, or the position can be opened and never
 * exited (FINDINGS (h)/(u), transposed to LP as open ⇒ exitable). The caps
 * default to the 2.3-R4 gate (2^160/day): rotations re-approve the SAME
 * principal every cycle, so a finite WBNB cap is exactly the trapped-exit
 * meter 2.3 removed for trades.
 *
 * ═══ R4 SIZING SEAM — DELIBERATELY NOT HERE ════════════════════════════════
 *
 * The sizing invariant (Rev2 items 11–12: reserve count DERIVED from
 * `maxExitSequencesPerDay` + the harvest allowance, `N × 3 ×
 * LP_RELAY_FEE_PER_SUBMIT_WEI` native headroom, provisioning REFUSES on
 * shortfall) is a PROVISIONING check against owner settings and the live
 * on-chain cap — inputs this pure template does not have. It is
 * {@link checkLpNativeCapSizing}, and it runs beside this builder, not inside
 * it; nothing here may be read as having performed it.
 */
export function lpSessionSpec(input: LpSessionSpecInput): SessionSpec {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ceiling = nowSeconds + MAX_LP_SESSION_SECONDS;
  const expiresAt = Math.min(input.expiresAt, ceiling);

  if (input.nativeCaps.length === 0) {
    throw new InvalidSessionSpecError(
      "lpSessionSpec requires at least one native spend cap; an empty list is uncapped.",
    );
  }
  for (const [index, cap] of input.nativeCaps.entries()) {
    if (cap.token !== undefined) {
      throw new InvalidSessionSpecError(
        `nativeCaps[${index}] names a token. Per-token caps come from \`token\`/\`wbnb\`, which grant the matching approve rules too.`,
      );
    }
  }

  // The five addresses play five DIFFERENT roles, and any collision merges two
  // authorities this template means to keep apart. The load-bearing cases: a
  // treasury or router equal to the NFPM would be `{ to: NFPM }` target-only —
  // the exact shape Rev2 item 4 forbids, granting `setApprovalForAll` — and a
  // treasury equal to a token leg would be an uncapped target-only rule on an
  // ERC-20, i.e. unlimited `transfer`. Refusing all pairs is cheaper to reason
  // about than enumerating which collisions happen to be survivable.
  const roles: readonly (readonly [string, Address])[] = [
    ["nfpm", input.nfpm],
    ["routerV3", input.routerV3],
    ["wbnb", input.wbnb.token],
    ["token", input.token.token],
    ["treasury", input.treasury],
  ];
  for (let a = 0; a < roles.length; a += 1) {
    for (let b = a + 1; b < roles.length; b += 1) {
      const left = roles[a];
      const right = roles[b];
      if (
        left !== undefined &&
        right !== undefined &&
        left[1].toLowerCase() === right[1].toLowerCase()
      ) {
        throw new InvalidSessionSpecError(
          `lpSessionSpec: ${left[0]} and ${right[0]} are the same address (${left[1]}). Each address plays a distinct role in the grant; a collision merges two authorities the template keeps apart.`,
        );
      }
    }
  }

  const allowedCalls: CallRule[] = [
    // The NFPM, per-selector ONLY (Rev2 item 3). Never target-only.
    ...NFPM_GRANTED_SELECTORS.map((selector) => ({
      to: input.nfpm,
      selector,
    })),
    // The dedicated V3 SwapRouter, target-only as 2.2 shipped — see docstring.
    { to: input.routerV3 },
    // TARGET-BOUND approves. The SPENDER is an argument `CallRule` cannot
    // constrain (PHASE2 OQ1); it stays bounded by the builders hardcoding the
    // NFPM/router from resolved config, never from a request field.
    { to: input.wbnb.token, selector: APPROVE_SELECTOR },
    /**
     * PHASE3.19 items 1-3 (review B1) — WBNB `deposit()`, and NOTHING ELSE new.
     *
     * WHY IT IS HERE AT ALL. The ladder's idle BUFFER must hold its quote half
     * as WBNB: every re-mint after the arm is `buildLpMintWbnbBatch`-shaped
     * (D6), and no reachable call turned the wallet's native BNB into
     * wallet-held WBNB — the arm's two native legs wrap inside the periphery's
     * own `pay()` and leave nothing behind, and `unwrapWETH9` is the NFPM's and
     * runs the other way. So without this rule the buffer's quote half is
     * unrepresentable and 70% of the owner's budget is parked as native for
     * ever.
     *
     * `withdraw(uint256)` is NOT granted, deliberately: nothing in the ladder
     * unwraps, and the exit path still unwraps through the NFPM.
     *
     * THE HONEST LEAKED-KEY SENTENCE (item 2), because "no new trust" would be
     * false: `deposit()` lets a leaked session key convert the owner's NATIVE
     * balance into an ERC-20 the same key may then swap within the WBNB cap.
     * That is a real widening of the leaked-key surface. It is bounded by TWO
     * caps rather than one — `deposit()` attaches value, so it is metered by the
     * NATIVE cap, and what it produces is metered by the WBNB cap — and it can
     * never send value to a third party. It is the price of the buffer model,
     * and spec §4.2's STOP-AND-REVIEW clause is discharged in advance for THIS
     * ONE SELECTOR and no other.
     *
     * EVERY EXISTING GRID AGENT MUST RE-GRANT before running ladder mode
     * (item 3). A ladder arm on a pre-3.19 session fails VISIBLY at the wrap —
     * the allowlist refuses the call at `preflightExecute` — never silently.
     */
    { to: input.wbnb.token, selector: WBNB_DEPOSIT_SELECTOR },
    { to: input.token.token, selector: APPROVE_SELECTOR },
    // Fee-free v1, treasury granted anyway (Rev2 item 30). Target-only, no
    // cap — same reasoning as the trade template's treasury rule (2.3 R10).
    { to: input.treasury },
  ];

  const spendCaps: SpendCap[] = [
    ...input.nativeCaps,
    {
      token: input.wbnb.token,
      limit: input.wbnb.limit ?? DEFAULT_TOKEN_CAP_LIMIT,
      period: input.wbnb.period ?? DEFAULT_TOKEN_CAP_PERIOD,
    },
    {
      token: input.token.token,
      limit: input.token.limit ?? DEFAULT_TOKEN_CAP_LIMIT,
      period: input.token.period ?? DEFAULT_TOKEN_CAP_PERIOD,
    },
  ];

  const spec: SessionSpec = { allowedCalls, spendCaps, expiresAt };

  // Throws InvalidSessionSpecError on anything unusable — including a tuple
  // selector the grammar cannot canonicalize (R1's regression surface) and an
  // approve rule whose token has no matching cap (FINDINGS (h) at build time).
  validateSessionSpec(spec, { nowSeconds, maxSessionSeconds: MAX_LP_SESSION_SECONDS });
  return spec;
}

/* -------------------------------------------------------------------------- */
/* The exit reserve (PHASE2.4 R6)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Native the relay is assumed to take back for ONE exit, in wei.
 *
 * 0.0001 BNB — roughly FOUR TIMES the single measured sample
 * (24 825 550 000 000 wei on the sell recorded beside `nativeCaps`).
 * Deliberately conservative while it rests on one observation: the cost of
 * being too generous is a slightly smaller off-chain budget, and the cost of
 * being too tight is a position that cannot be closed.
 *
 * THIS CONSTANT IS STILL A PLACEHOLDER FOR A MEASUREMENT, AND PHASE2.5 F2 DID
 * NOT CHANGE THAT. What F2 shipped is the HARNESS the measurement was missing:
 * `live-trade --measure-relay-fee` reads this session's native day meter
 * (`spendInfos`) either side of a submission and prints the increment, exactly
 * as `live-lp --measure-relay-fee` does for the LP plane. The SELL leg is the
 * canonical sample — it attaches no native, so the whole delta IS the relay's
 * reimbursement.
 *
 * NORMATIVE (PHASE2.5 F2): the number below changes only when the measurement
 * has actually been taken, across several mainnet submissions, and is replaced
 * by the observed p95. A padded guess that LOOKS measured is worse than this
 * one, which admits what it is. No env key overrides it either — a deployment
 * that can lower the exit reserve from the environment can quietly disarm the
 * one guarantee this reserve exists to make (contrast the LP plane's
 * `LP_RELAY_FEE_PER_SUBMIT_WEI`, whose placeholder is known WRONG for mints and
 * therefore needs a correction path more than it needs a floor).
 *
 * Until the measurement lands this is a guess wearing a number, and it errs
 * HIGH — the cost of that is a buy refused early, never an exit that cannot pay.
 */
/**
 * Native to hold back so every position the session may open can still be
 * closed: one relay reimbursement per grantable token.
 *
 * `max(1, tokens)` because an agent with no token grants still has to be able
 * to sell something it already holds — the wallet IS the owner's EOA and may
 * carry a position from before the grant (FINDINGS (s)).
 *
 * WHAT THIS TERM IS, NOW THAT PHASE2.5 HAS SPLIT THE JOB (F3). It is still
 * keyed on grantable tokens while the relay still reimburses itself on EVERY
 * submission, so on its own it covers about one exit per granted token and
 * nothing for the buys — PHASE2.4 audit A1, unchanged as arithmetic.
 *
 * What changed is that it is no longer the only thing standing between a busy
 * agent and a trapped exit. **The GUARANTEE now lives at submit time**:
 * {@link nativeReserveFloor}, read off the account's own native day meter
 * before every exposure-increasing trade, refuses the buy that would leave too
 * little behind to pay for an exit. Arithmetic about a future day cannot see
 * the relay spending the meter; the meter can.
 *
 * So this term keeps the job it is actually good at — catching the grossly
 * undersized grant at PROVISIONING time, when the operator can still fix it
 * cheaply and for free — and it is honest about being a floor rather than the
 * guarantee. The residual recorded in FINDINGS (w) is bounded by the live gate,
 * not by this number.
 */
export function exitReserveWei(grantedTokenCount: number): bigint {
  return BigInt(Math.max(1, grantedTokenCount)) * RELAY_FEE_PER_EXIT_WEI;
}

/**
 * What the live meter says, reduced to the numbers the decision turns on.
 *
 * Structurally a {@link NativeDayMeter} without the transport concern, so this
 * module stays free of the provider interface and a test can drive it with four
 * bigints.
 */
export type NativeReserveInput = {
  readonly limitWei: bigint;
  /** The CURRENT period's usage — `currentSpent`, never `spent` (REVIEW M2). */
  readonly currentSpentWei: bigint;
  /** ERC-20s this key can still sell, read from the SAME account call. */
  readonly grantedTokenCount: number;
  /**
   * Native THIS submission will spend, if it is authorised — the venue's
   * attached value PLUS the 4lpha fee transfer (`nativeInWei` at the trade
   * route). `0n` when nothing is being authorised, i.e. when the answer is a
   * STANDING report for the owner rather than a decision about a trade.
   *
   * PHASE2.5-AUDIT A1, and it is the whole finding. Without this term the
   * predicate is "the meter holds an exit's worth of headroom NOW", not "it
   * will still hold one AFTER this buy" — and the two differ by the entire size
   * of the trade. One maximum-size buy on a default grant passed the check and
   * left the meter below the exit reserve: PHASE2.4 A1 reproduced through A1's
   * own fix.
   */
  readonly submissionNativeWei: bigint;
};

/**
 * The live headroom decision, in full, so the gate and the owner view cannot
 * disagree about it.
 */
export type NativeReserveFloor = {
  /**
   * `limit - currentSpent`, on the DAY row.
   *
   * NEGATIVE is representable and is not a bug: an owner may lower a cap below
   * what the period has already spent (`setSpendLimit` writes an absolute
   * value). {@link overCap} says so explicitly rather than leaving a UI to
   * discover a minus sign in a balance (PHASE2.5-AUDIT A10).
   */
  readonly remainingWei: bigint;
  /** True when the period has already spent PAST its limit. */
  readonly overCap: boolean;
  /** One relay reimbursement per sellable token — what the exits will cost. */
  readonly reserveWei: bigint;
  /**
   * The native the submission being authorised will spend, echoed back so the
   * caller reports the number the decision was made on (`0n` for a standing
   * report). PHASE2.5-AUDIT A1.
   */
  readonly submissionNativeWei: bigint;
  /**
   * The RELAY's reimbursement for the submission being authorised.
   *
   * PHASE2.5-REVIEW M5: omitting this term reintroduces A1's exact mistake —
   * forgetting that the authorised submission also spends — inside A1's own fix.
   * PHASE2.5-AUDIT A1: this term alone was not enough, because the submission
   * spends its own `nativeInWei` as well as the relay's gas.
   */
  readonly ownFeeWei: bigint;
  /** `submissionNative + ownFee + reserve` — what the meter must still hold. */
  readonly requiredWei: bigint;
  /** True when the trade may proceed. */
  readonly sufficient: boolean;
  /** How much more headroom the meter needs. `0n` when {@link sufficient}. */
  readonly shortfallWei: bigint;
  /**
   * The LARGEST submission this meter could still authorise, in native wei.
   *
   * What the owner actually wants to know when buys stop — "how big a trade
   * still fits" — and the number that ties F4's report to F1's decision: a trade
   * of exactly this size proceeds and one wei more refuses. `0n` when nothing
   * fits (PHASE2.5-AUDIT A1's fix made this computable; before it, the view's
   * `remainingWei` implied a headroom the gate did not actually offer).
   */
  readonly headroomForSubmissionWei: bigint;
};

/**
 * PHASE2.5 F1's floor, as ONE function.
 *
 * THE SEAM IS THE POINT (PHASE2.5-REVIEW, the inverted-fix list). The trade
 * gate refuses on this answer and the owner view REPORTS this answer, and both
 * call it here rather than each doing the arithmetic. Two copies of a formula
 * are two things to keep in step, and the failure mode — a dashboard saying the
 * agent has room while the gate refuses every buy — is the "worker knows
 * something the dashboard does not" defect this phase's F4 exists to end.
 *
 * THE PREDICATE, AND WHY IT IS ABOUT THE FUTURE (PHASE2.5-AUDIT A1):
 *
 * ```
 * remaining - submissionNative - ownFee  >=  reserve
 * ```
 *
 * NOT `remaining >= reserve + ownFee`. That earlier form asked whether the
 * meter holds an exit's worth of headroom RIGHT NOW, which is true right up to
 * the moment the buy it is authorising spends it. The gate exists to answer a
 * question about the state AFTER the submission, and the two forms differ by
 * the entire size of the trade.
 *
 * Pure: no clock, no chain, no config. The caller supplies the meter reading.
 */
export function nativeReserveFloor(input: NativeReserveInput): NativeReserveFloor {
  const remainingWei = input.limitWei - input.currentSpentWei;
  const reserveWei = exitReserveWei(input.grantedTokenCount);
  const ownFeeWei = RELAY_FEE_PER_EXIT_WEI;
  const submissionNativeWei = input.submissionNativeWei;
  const requiredWei = submissionNativeWei + ownFeeWei + reserveWei;
  const sufficient = remainingWei >= requiredWei;
  // What a submission of ANY size would have to leave behind. Subtracting it
  // from the remaining headroom gives the largest trade that still fits — and
  // `max(0)` rather than a negative, because "you may still spend minus three
  // wei" is not a fact about anything.
  const standingFloorWei = ownFeeWei + reserveWei;
  const headroomForSubmissionWei =
    remainingWei > standingFloorWei ? remainingWei - standingFloorWei : 0n;
  return {
    remainingWei,
    overCap: remainingWei < 0n,
    reserveWei,
    submissionNativeWei,
    ownFeeWei,
    requiredWei,
    sufficient,
    shortfallWei: sufficient ? 0n : requiredWei - remainingWei,
    headroomForSubmissionWei,
  };
}

/**
 * The remedy an owner can actually act on when {@link nativeReserveFloor}
 * refuses.
 *
 * PHASE2.5-REVIEW erratum 2: `setSpendLimit` raises a limit on a LIVE session,
 * so no fresh grant is needed, and the review made it NORMATIVE that F1 does not
 * ship without a path an owner can act on.
 *
 * IT NAMES THE ON-CHAIN ACTION, NOT A SCRIPT (PHASE2.5-AUDIT A2). The first
 * version pointed at `npm run add-spend-limit`, and that was wrong twice over:
 * the advertised line omitted the mainnet confirmation flag so it threw rather
 * than raising anything, and the script needs the OWNER'S PRIVATE KEY in an env
 * var — which `CLAUDE.md` is explicit must never be a deployment input, and
 * which the tenant reading this refusal does not have, because under the
 * 2026-08-19 public multi-tenant decision the tenant is not the operator. The
 * remedy that works for every reader is the call itself, signed by the owner's
 * own wallet through the UI; the script stays an operator affordance and is
 * named as one.
 *
 * CARRIES NO NUMBERS, DELIBERATELY. It is rendered on `/trade`, which is
 * reachable with the SHARED exec token, and per-tenant meter figures do not
 * belong on a route that is not owner-scoped (REVIEW M3). The figures live on
 * the owner-signed view; this names where to look.
 */
export const NATIVE_RESERVE_REMEDY =
  "This agent's on-chain native day cap no longer holds enough headroom to pay " +
  "for an exit, so buys are refused until it does. THE FIX IS AN OWNER ACTION ON " +
  "CHAIN: the owner's wallet calls `setSpendLimit(keyHash, 0x0000000000000000" +
  "000000000000000000000000, 2 /* PERIOD_DAY */, newLimitWei)` on the account " +
  "itself, which raises the cap on the LIVE session with no re-grant. The exact " +
  "figures, including how much is short, are on the owner-signed view " +
  "(`GET /agents/:id/owner-view`). Operators driving a test agent from a laptop " +
  "can use `npm run add-spend-limit -- --session-var <VAR> --native-cap <BNB> " +
  "--confirm i-understand-real-funds`, which needs the owner key in the " +
  "environment and is therefore NOT the path for a self-serve tenant.";

export type NativeCapSizingInput = {
  /** The rolling daily NATIVE cap the owner is about to grant ON CHAIN. */
  readonly onChainDailyCapWei: bigint;
  /** The daily cap THIS SERVER will enforce off-chain (`agent.caps`). */
  readonly offChainDailyCapWei: bigint;
  /** Configured 4lpha fee, in basis points. Charged on top of every buy. */
  readonly feeBps?: number;
  /** How many ERC-20s the session grants — one exit each. */
  readonly grantedTokenCount: number;
};

/**
 * Either the sizing holds, or it does not — and there are exactly two ways for
 * it not to.
 *
 * PHASE3.1-FIXREVIEW F5: the failure variant used to be one shape carrying an
 * OPTIONAL `shortfallWei`, which forced `/lp/settings` to render
 * `${sizing.shortfallWei ?? 0n}`. Any refusal that reached that route without a
 * shortfall would have told the owner the cap is "short by 0 wei" — a false,
 * actionable-looking number, which is the exact failure class audit A9 was
 * filed about, reintroduced by the type that fixed it. Unreachable in practice
 * (the malformed-input refusals are all screened upstream of that route), but a
 * seam only stays unreachable while nobody adds a caller.
 *
 * Two members instead, so "a shortfall without a figure" is UNREPRESENTABLE and
 * the `?? 0n` is deleted rather than defended:
 *
 *   - `shortfall` — the arithmetic ran and the cap is too small by a known,
 *     exact amount;
 *   - `malformed` — an input could not be sized on at all, so there is no
 *     shortfall to report and no number to print.
 */
export type NativeCapSizing =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "shortfall";
      /**
       * How much the on-chain cap must rise by for the check to pass, as a
       * NUMBER rather than as prose.
       *
       * PHASE3.1-AUDIT A9: `/lp/settings`'s refusal is capped at 280 characters
       * by `sanitizeMessage`, and this figure sits far past that point inside
       * {@link message}. So the owner was told to "raise it with
       * `owner-add-spend-limit`" and given no way to learn BY HOW MUCH.
       */
      readonly shortfallWei: bigint;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly kind: "malformed";
      readonly message: string;
    };

/**
 * THE SIZING INVARIANT (PHASE2.4 R6 item 21), enforced at provision:
 *
 * ```
 * onChainNativeCap  >  offChainDailyCap
 *                    + offChainDailyCap * feeBps / 10_000
 *                    + exitReserve
 * ```
 *
 * Each term is a real outflow metered against the SAME on-chain native cap:
 * the buys this server will permit, the fee transfers it appends to them, and
 * the relay's gas reimbursement on the sells that close them.
 *
 * Provisioning REFUSES when it does not hold, rather than warning — the same
 * posture as boot refusing an ungranted treasury. Three layers have now warned
 * about this family of failure and shipped it anyway, and the failure it
 * prevents is a trapped exit that survives a pause.
 *
 * PASSING THIS IS A FLOOR, NOT A GUARANTEE (PHASE2.4 audit A1). The reserve is
 * sized per GRANTABLE TOKEN, and the relay reimburses itself per SUBMISSION, so
 * a busy agent can still exhaust the on-chain meter before the off-chain cap.
 * Read this before trusting a green check.
 *
 * PHASE2.5 F3 — WHERE THE GUARANTEE LIVES. The disclosure above stays, because
 * it is still true of THIS check. What is no longer true is that nothing else
 * covers it: {@link nativeReserveFloor} is applied at SUBMIT time against the
 * account's own native day meter, and it refuses the exposure-increasing trade
 * that would leave too little behind to exit. This check is the early warning;
 * that one is the guarantee. Neither replaces the other — a grant this check
 * refuses is a grant no live gate can rescue, because the headroom was never
 * granted in the first place.
 */
export function checkNativeCapSizing(input: NativeCapSizingInput): NativeCapSizing {
  const fee =
    (input.offChainDailyCapWei * BigInt(input.feeBps ?? 0)) / 10_000n;
  const reserve = exitReserveWei(input.grantedTokenCount);
  const required = input.offChainDailyCapWei + fee + reserve;
  if (input.onChainDailyCapWei > required) return { ok: true };
  return {
    ok: false,
    kind: "shortfall",
    // F5: the same number the prose computes below, carried structurally. This
    // helper has no malformed-input variant — every field is validated by its
    // own type — so `shortfall` is its only failure.
    shortfallWei: required - input.onChainDailyCapWei + 1n,
    message:
      `The on-chain daily native cap does not cover what this agent may spend. ` +
      `on-chain cap ${input.onChainDailyCapWei} wei must EXCEED ` +
      `off-chain daily cap ${input.offChainDailyCapWei} + fee ${fee} + exit reserve ` +
      `${reserve} = ${required} wei; short by ${required - input.onChainDailyCapWei + 1n} wei. ` +
      `The relay reimburses its gas out of this same meter, so headroom the buys ` +
      `consume is headroom the exit needs — and a pause will not save it. ` +
      `WHAT THIS RESERVE DOES AND DOES NOT COVER (PHASE2.4 A1): it is sized per ` +
      `GRANTABLE TOKEN, not per SUBMISSION, so it covers roughly one exit per ` +
      `granted token and NOTHING for the reimbursements the buys themselves incur. ` +
      `An agent that submits many trades a day can still exhaust the on-chain meter ` +
      `before the off-chain cap. Passing this check is a floor, not a guarantee. ` +
      // PHASE2.5 F3: the one sentence the review asked for, APPENDED rather than
      // spliced in — every figure above keeps its offset, so audit A9's
      // 280-character truncation argument is unchanged by this addition.
      `THE GUARANTEE LIVES AT SUBMIT TIME: every exposure-increasing trade is ` +
      `refused unless the account's own native day meter still holds an exit's ` +
      `worth of headroom.`,
  };
}

/**
 * The largest off-chain daily cap that satisfies {@link checkNativeCapSizing}
 * for a given on-chain cap, or `null` when even a zero budget would not fit.
 *
 * Used as the DEFAULT when an operator does not name one, so provisioning
 * produces a coherent pair by construction rather than refusing on a number
 * nobody chose. `null` means the on-chain cap does not even cover the exit
 * reserve, which is a refusal the operator has to fix by raising `--cap-day`.
 *
 * Integer division FLOORS, so the answer can sit a wei or two below the exact
 * maximum. That is the safe direction and it is not worth a correction step.
 */
export function maxOffChainDailyCapWei(input: {
  readonly onChainDailyCapWei: bigint;
  readonly feeBps?: number;
  readonly grantedTokenCount: number;
}): bigint | null {
  const headroom =
    input.onChainDailyCapWei - exitReserveWei(input.grantedTokenCount) - 1n;
  if (headroom <= 0n) return null;
  // Invert `budget + budget*bps/10_000 <= headroom` with integer division.
  return (headroom * 10_000n) / (10_000n + BigInt(input.feeBps ?? 0));
}

/* -------------------------------------------------------------------------- */
/* The LP gas reserve (PHASE3 R4)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Worst-case relay submissions in ONE LP sequence — the rotate:
 * zap-out, sweep, mint (Rev2 item 12). A NAMED constant, not prose, so the
 * sizing arithmetic and the saga step lists cannot drift apart silently: the
 * saga runner's longest plan is exactly this long, and its test pins the two
 * together.
 */
export const MAX_SUBMISSIONS_PER_SEQUENCE = 3;

/**
 * Relay submissions ONE protect (or manual exit) makes: the zap-out batch AND
 * the exit swap. A NAMED constant for the same anti-drift reason as
 * {@link MAX_SUBMISSIONS_PER_SEQUENCE}: the exit saga's plan is exactly this
 * long, and the sizing arithmetic must not silently disagree with it.
 *
 * WAS 1, NOW 2 — PHASE3.1 Rev2 item 18, which is the ERRATUM to
 * `PHASE3-AUDIT.md` A3 and `PHASE3-FIXREVIEW.md` A3, both of which assert "the
 * exit saga's plan is verifiably one step". It is two from PHASE3.1 on:
 * `[zap-out, sweep-token]`, because a stop-loss that returns the volatile leg
 * has done the mechanical half of its job only (FINDINGS (ag)).
 *
 * THE EXEMPT SET IS THREE KINDS, NOT TWO (PHASE3.7-AUDIT A4, FIXREVIEW N6).
 * `QUOTA_BOUND_KINDS` is {rotate, harvest}, so `protect`, `manual-exit` AND
 * `open` all escape `maxExitSequencesPerDay`. The term below budgets the first
 * two on the POSITION axis. `open` is budgeted on the native-VALUE axis (its
 * own `mint{value}`) and on NO submission-gas axis at all — until PHASE3.7 F2
 * its gas was covered only by an accidental coupling, where an open reservation
 * happened to occupy a quota slot it was exempt from being refused by. Whether
 * to add an `openSubmissions` term is a design change and goes through
 * spec -> review; this comment exists so the next reader does not inherit a
 * two-kind exempt set as settled fact.
 *
 * WHY IT IS IN THE RESERVE (PHASE3 audit A3): protect and manual-exit are
 * quota-EXEMPT (Rev2 item 13) — `reserveSequence` never throws for them — yet
 * each still submits and draws relay gas from the same on-chain native meter.
 * A reserve sized only on the quota-bound `N` therefore leaves the stop-loss
 * gasless exactly on the day several positions crash at once. Each protect is
 * terminal per position (the position closes), so this many submissions per
 * open position is exact headroom, not a guess.
 *
 * The wider exit does NOT reintroduce FINDINGS (w) / audit A1: two non-mint
 * submissions cost roughly `2 × 3.8e13` wei (FINDINGS (ac)'s measured sweep,
 * and the exit swap's estimate is smaller still) against a reserve of
 * `2 × 1e14` — a 2.6× margin, versus 14% for the mint-bearing submission.
 * {@link MAX_SUBMISSIONS_PER_SEQUENCE} stays 3: rotate is still the worst
 * case, and the exit is now two.
 */
export const PROTECT_SUBMISSIONS_PER_POSITION = 2;

/**
 * Relay submissions ONE grid flip is reserved for (PHASE3.15 R2.7 / H6).
 *
 * THREE, and the flip's REAL count is TWO — the plan is
 * `[zap-out, sweep-token, zap-in-mint]` and the sweep always skips, because a
 * grid never swaps to rebalance. The third is PADDING for a resubmission after
 * a G2 hold (price gapping into the target range is normal strategy behaviour,
 * and the worker retries the mint when the price allows).
 *
 * The two numbers are DELIBERATELY DIFFERENT and are stated side by side rather
 * than reconciled: the R2.10 net-edge admission uses TWO, because it is asking
 * whether the spread covers a flip's real gas; this reserve uses THREE, because
 * it is asking what the day could cost. Naming both here is what stops a future
 * reader "fixing" one to match the other.
 *
 * WHY THE TERM EXISTS AT ALL (OQ5's answer, whose premise the spec got wrong):
 * a flip pays its PRINCIPAL in WBNB, which is what makes it native-cap-neutral
 * for the deposit — but the relay bills GAS PER SUBMISSION out of the same
 * on-chain native meter whatever currency the principal is in (`lpSessionSpec`:
 * "nativeCaps fund the open's mint{value} AND the relay's per-submission gas
 * reimbursement", FINDINGS (w)). Twelve unreserved flips a day is a direct raid
 * on the PROTECT reserve — the PHASE2.4-A1 trap in its LP form.
 *
 * PHASE3.18 L2 — IT IS NOW REUSED BY THE REQUOTE LANE, and the name stays
 * `..._PER_GRID_FLIP` deliberately. A requote is the identical plan shape (three
 * positions, the middle one always skipped, so TWO real submissions plus one
 * pad) and the identical WBNB-paid custody, so the number is the same number
 * and not a coincidence. Renaming it to something lane-neutral would touch the
 * 3.15 sizing texts an auditor pinned; the correction is this sentence, so a
 * reader who finds it in the requote term knows it was meant.
 */
export const MAX_SUBMISSIONS_PER_GRID_FLIP = 3;

/**
 * PHASE3.19 item 29 (review H6) — relay submissions ONE grid RECENTER is
 * reserved for.
 *
 * FOUR, and the derivation is deliberately NOT the flip's. A flip's plan is
 * `[zap-out, sweep-token, zap-in-mint]` whose middle step ALWAYS SKIPS, so its
 * real count is 2 and {@link MAX_SUBMISSIONS_PER_GRID_FLIP} is `2 real + 1 pad`.
 * A ladder motion's middle step — the profit-gated hedge — SOMETIMES FIRES, so
 * its real count is 3 and the padded count is `3 real + 1 pad` = 4.
 *
 * A SEPARATE CONSTANT rather than a bump of the flip's, and both halves of that
 * matter: the flip constant is cited BY NAME in the sizing refusal text and in
 * the requote's own reuse comment, so raising it would silently re-price two
 * lanes this phase does not touch; and reusing it here would under-reserve the
 * one lane whose middle step can cost a submission.
 */
export const MAX_SUBMISSIONS_PER_GRID_RECENTER = 4;

/* ────────────────────────────────────────────────────────────────────────────
 * PHASE3.22 N6 / R3.4 — THE SHIFT LANE'S TWO CONSTANTS, STATED SIDE BY SIDE.
 *
 * They are DIFFERENT NUMBERS FOR THE SAME MOTION and conflating them is the
 * exact mistake R2.11 made and R3.4 withdrew: it multiplied the per-cycle
 * MOTION COUNT by the padded SIZING constant, which is the "fix" the shipped
 * comments at `gridTriggers.ts` and `checkLpNativeCapSizing` forbid in writing.
 *
 *   MAX_SUBMISSIONS_PER_GRID_SHIFT       = 4   ← NATIVE-CAP SIZING RESERVE
 *                                              fee UNITS per motion (batch shape)
 *   MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE = 1   ← ADMISSION CYCLE COUNT
 *                                              the REAL submission count
 *
 * A shift motion is ONE relay batch — that is the whole phase — so the REAL
 * count is 1 and the admission floor (`gridCycleSubmissions`) must use 1, or
 * every shift grid is priced as if it submitted twice as often as it does.
 * The SIZING reserve is a count of FEE UNITS, not of submissions, because a
 * reserve that is exactly right is a reserve that traps the next motion the
 * moment the relay meters above the estimate.
 *
 * WHY FOUR UNITS (GRID-GAS-RESERVE, 2026-09-04, replacing R2.12's two): R2.12
 * was arithmetic on a 1e14 unit ("two units = 0.0002 BNB"). `.env` lowered
 * `LP_RELAY_FEE_PER_SUBMIT_WEI` to 0.0000388 BNB and two units silently became
 * 0.0000776 BNB — LESS than one real shift. Measured on wallet B: the relay
 * metered btcb's 983,748-gas arm at 0.000116918 BNB against 0.000049187 BNB of
 * physical gas (2.38x, receipt 0xa48f…2c34); a 12-call shift batch is
 * 1.05-1.08M gas (receipts 0xc422…, 0xd502…), so ~0.000129 BNB metered ≈ 3.3
 * units. FOUR units (0.000155 BNB) is a ~1.2x pad on the NEXT motion; the DAILY
 * reserve (16 x 4 units) is what keeps a day of shifts flowing. The same
 * constant sizes the shift trigger's gas gate (`gridShiftGasGate`) and the
 * deposit the marketplace computes, so the three cannot disagree.
 *
 * THE HONESTY CLAUSE (§11), which the relay-fee recalibration spec must carry:
 * `LP_RELAY_FEE_PER_SUBMIT_WEI` was measured against 251k-776k-gas submissions.
 * A shift batch is larger than anything it was measured on, so the "per
 * submission" fiction is doing more work here than in any other lane, and a
 * gas-price regime change erodes THIS lane's pad faster than a flip's. The
 * constant must be treated as per-BATCH-SHAPE, not per-tx.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * PHASE3.22 R3.4 — relay submissions ONE grid SHIFT is RESERVED for, in
 * `checkLpNativeCapSizing`, as FEE UNITS per batch shape. See the block comment
 * above for why it is 4 and why it is not the same number as its cycle sibling.
 */
export const MAX_SUBMISSIONS_PER_GRID_SHIFT = 4;

/**
 * PHASE3.22 R3.4 — relay submissions ONE grid SHIFT actually MAKES, in
 * `gridCycleSubmissions`' admission floor. ONE: the motion is one batch.
 * See the block comment above for why this is deliberately NOT
 * {@link MAX_SUBMISSIONS_PER_GRID_SHIFT}.
 */
export const MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE = 1;

/**
 * Native the relay is assumed to take back for ONE LP saga submission, in wei.
 *
 * 0.0001 BNB — the SAME starting guess as {@link RELAY_FEE_PER_EXIT_WEI}, and
 * deliberately NOT evidence-based for LP: the trade-plane constant rests on a
 * swap's measured reimbursement, and an NFPM mint costs several times a swap's
 * gas (the quoter alone estimates 92k for one pool crossing; a mint is ~3-5×
 * that — PHASE3-REVIEW R4 item 4).
 *
 * THIS CONSTANT IS A PLACEHOLDER FOR A MEASUREMENT (Rev2 item 12): the live-lp
 * run MEASURES the actual relay increment per step kind and REPLACES it — a
 * named phase deliverable. Until that lands, deployments may correct it via
 * the `LP_RELAY_FEE_PER_SUBMIT_WEI` env key ({@link resolveLpRelayFeePerSubmitWei}).
 */
export const DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI = 100_000_000_000_000n;

/**
 * Read the per-submission relay-fee constant from the (injected) environment.
 * `LP_RELAY_FEE_PER_SUBMIT_WEI` must be a positive integer in wei when set;
 * malformed values THROW rather than defaulting — a sizing check fed a
 * silently-defaulted constant would answer green about a number nobody chose.
 */
export function resolveLpRelayFeePerSubmitWei(
  env: Readonly<Record<string, string | undefined>>,
): bigint {
  const raw = env["LP_RELAY_FEE_PER_SUBMIT_WEI"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
  if (!/^\d+$/u.test(raw) || BigInt(raw) <= 0n) {
    throw new InvalidSessionSpecError(
      "LP_RELAY_FEE_PER_SUBMIT_WEI must be a positive integer number of wei.",
    );
  }
  return BigInt(raw);
}

export type LpNativeCapSizingInput = {
  /** The rolling daily NATIVE cap the owner is about to grant ON CHAIN. */
  readonly onChainDailyCapWei: bigint;
  /** Native the `/lp/open` mint attaches — the one native-spending step. */
  readonly openNativeBudgetWei: bigint;
  /** Configured 4lpha fee, in basis points. Fee-free v1 ⇒ omit/0 (Rev2 item 30). */
  readonly feeBps?: number;
  /**
   * `maxExitSequencesPerDay` from the settings being armed — the DERIVED floor
   * for `N` (Rev2 item 11). Harvest SHARES this quota (the store's documented
   * choice, `LpSequenceStore.reserveSequence`), so there is no separate
   * harvest allowance to add.
   */
  readonly maxExitSequencesPerDay: number;
  /**
   * The `--expected-sequences-day` operator flag. May only RAISE `N` above the
   * settings-derived floor; a value below it is REFUSED, not silently ignored
   * — an operator who typed a lower number believed it meant something.
   */
  readonly expectedSequencesPerDay?: number;
  /** Per-submission relay fee. Defaults to the placeholder constant. */
  readonly lpRelayFeePerSubmitWei?: bigint;
  /**
   * Open (non-closed) LP positions whose quota-EXEMPT protect/manual-exit gas
   * the reserve must additionally cover (audit A3) — see
   * {@link PROTECT_SUBMISSIONS_PER_POSITION}. FLOORED AT 1: provisioning runs
   * before any position exists, and the open that follows creates exactly one,
   * so a zero count still reserves one exit's gas. `/lp/settings` passes the
   * LIVE non-closed count so an agent holding more positions reserves more.
   */
  readonly openPositionsCount?: number;
  /**
   * PHASE3.15 R2.7 — `grid.maxFlipsPerDay` from the settings being armed, or
   * absent for a non-grid agent.
   *
   * A SEPARATE NAMED TERM rather than a summand folded into
   * `maxExitSequencesPerDay`, and the review mildly preferred it for the reason
   * that survives: the two axes stay nameable in the refusal text, so an owner
   * who is short can see WHICH quota is costing them. It is also arithmetically
   * MORE conservative than folding — `max(a, e) + f >= max(a + f, e)` for
   * `f >= 0` — so the reserve is at least as large in every case.
   *
   * `P` IS NOT FIXED AT ONE FOR A GRID (PHASE3.17 R2.6 / review M6, correcting
   * this docstring's own PHASE3.15 claim). 3.15's grid held exactly one
   * position, and this line said so; 3.17's DUAL arm places TWO, and the arm
   * route accordingly passes `openPositionsCount = existing.length + 2`. The
   * `max(1, …)` floor is still what makes the term safe when no position exists
   * yet — that part was and remains correct — but "a grid agent holds exactly
   * one position" is no longer true and must not be inherited as settled fact.
   * The A3 protect reserve scales with P because an armed level's protect burns
   * the same relay gas whichever level it is.
   */
  readonly maxGridFlipsPerDay?: number;
  /**
   * PHASE3.18 R2.11 — the REQUOTE lane's own daily count, reserved on the same
   * per-submission constant and the same
   * {@link MAX_SUBMISSIONS_PER_GRID_FLIP} shape (a requote is the identical
   * 2-submission, WBNB-paid plan; the constant is reused, never duplicated).
   *
   * THE HONEST TOTAL, stated where the number is used: at the padded constant,
   * `maxFlipsPerDay: 12` plus `maxRequotesPerDay: 21` reserves
   * `(12 + 21) x 3 x 1e14 ~= 0.0099 BNB` of native headroom, and the ceiling
   * (24 + 24) reserves `0.0144 BNB`. The MEASURED cost is far lower —
   * 0.0000388 BNB per submission (FINDINGS (av)), so ~7 re-centres per 8 h is
   * ~0.00054 BNB — which means the reserve is a 2.6x pad on real gas, not a
   * forecast. FOR DEPLOYMENTS BELOW ~0.05 BNB the operator should recalibrate
   * `LP_RELAY_FEE_PER_SUBMIT_WEI` BEFORE enabling requotes, or this term alone
   * can refuse an arm that would in fact have been affordable. The client
   * transcript says the same thing at the point of signing.
   */
  readonly maxRequotesPerDay?: number;
  /**
   * PHASE3.19 item 30 (review H6.1) — the LADDER's `recenter` lane, reserved at
   * `moves x {@link MAX_SUBMISSIONS_PER_GRID_RECENTER} x perSubmit`.
   *
   * Its OWN named term for the reason the two grid terms above are their own:
   * the refusal text can then say WHICH quota is costing the owner. Without it
   * an armed ladder reserves ZERO native for up to 24 motions a day — the
   * provisioning check would pass on a cap that cannot pay the gas, which is
   * PHASE2.4-A1 in its ladder form.
   *
   * FOUR submissions, not three: a ladder motion's middle step can FIRE (the
   * hedge), where the flip's and the requote's always skip. See
   * {@link MAX_SUBMISSIONS_PER_GRID_RECENTER}.
   *
   * PHASE3.19 R4.3/N18 — the ladder ARM places TWO rows, so its route passes
   * `openPositionsCount = existing.length + 2`, exactly as the 3.17 dual arm
   * does. Restated here because item 30 adds this term and does not restate it.
   */
  readonly maxMovesPerDay?: number;
  /**
   * PHASE3.20 item 22 — the ladder's ONE lane became TWO, so this check takes
   * TWO NAMED COUNTS and sums them into the SAME `recenterReserve` term.
   *
   * Two named inputs rather than one summed argument, in BOTH directions and
   * for two independent reasons:
   *
   *  - `driftMovesPerDay: 0` is legal and meaningful (a legacy signature reads
   *    exactly that), and passing it through the existing single argument would
   *    be REFUSED as malformed by the 1..24 rule;
   *  - a summed value can reach 48, which the same rule would also refuse.
   *
   * Each field carries its own malformed message, so the refusal names the knob
   * the owner would turn. `settlementsPerDay` is 1..24; `driftMovesPerDay` is
   * 0..24. Supplying either one takes precedence over the deprecated
   * `maxMovesPerDay` above, which is retained for callers that have not
   * migrated.
   */
  readonly settlementsPerDay?: number;
  readonly driftMovesPerDay?: number;
  /**
   * PHASE3.25 R6.1 — physical shift motions reserved across BOTH independent
   * lanes after the ceil-spacing clamp. Optional keeps every non-shift caller
   * byte-identical; absent means no shift term.
   */
  readonly shiftMotionsPerDay?: number;
};

export const HIRE_SIZING_PRESETS = {
  "grid-v1": {
    name: "grid-v1",
    version: 1,
    mode: "fixed",
    maxExitSequencesPerDay: 4,
    openPositionsCount: 2,
    maxGridFlipsPerDay: 12,
    maxRequotesPerDay: 0,
    maxLadderMovesPerDay: 0,
    maxShiftMotionsPerDay: 0,
  },
  /**
   * The SHIFT grid (PHASE3.22 atomic pair, PHASE3.25 cadence split) — the
   * model the operator specified for the marketplace Grid Agent. Bounds what
   * the UI signs at arm: shiftsPerDay <= 8, drift motions <= 8 (budget /
   * per-motion price), minMinutesBetweenExits >= 5, so shiftNativeSizingTerm
   * can never exceed 16 motions a day. No flips, requotes or ladder moves
   * exist in this mode.
   */
  "grid-shift-v1": {
    name: "grid-shift-v1",
    version: 1,
    mode: "shift",
    maxExitSequencesPerDay: 4,
    openPositionsCount: 2,
    maxGridFlipsPerDay: 0,
    maxRequotesPerDay: 0,
    maxLadderMovesPerDay: 0,
    maxShiftMotionsPerDay: 16,
  },
  "lp-v1": {
    name: "lp-v1",
    version: 1,
    mode: "fixed",
    maxExitSequencesPerDay: 4,
    openPositionsCount: 1,
    maxGridFlipsPerDay: 0,
    maxRequotesPerDay: 0,
    maxLadderMovesPerDay: 0,
    maxShiftMotionsPerDay: 0,
  },
} as const;

export type HireSizingPresetName = keyof typeof HIRE_SIZING_PRESETS | "trade-v1";

export type GridHireSizingPreview = {
  readonly name: HireSizingPresetName;
  readonly version: 1;
  readonly openNativeBudgetWei: string;
  readonly feeBps: number;
  readonly feeWei: string;
  readonly relayFeePerSubmitWei: string;
  readonly mode: "fixed" | "shift";
  readonly terms: {
    readonly maxExitSequencesPerDay: 4;
    readonly openPositionsCount: 2 | 1;
    readonly maxGridFlipsPerDay: 12 | 0;
    readonly maxRequotesPerDay: 0;
    readonly maxLadderMovesPerDay: 0;
    readonly maxShiftMotionsPerDay: 0 | 16;
  };
  readonly reserves: {
    readonly exitWei: string;
    readonly protectWei: string;
    readonly gridFlipWei: string;
    readonly shiftWei: string;
    readonly totalWei: string;
  };
  readonly minimumCapDayWei: string;
};

export type TradeHireSizingPreview = {
  readonly name: "trade-v1";
  readonly version: 1;
  readonly openNativeBudgetWei: "0";
  readonly executionModel: TradeExecutionModel;
  readonly entryWei: string;
  readonly maxOpenPositions: number;
  readonly grantedTokenCount: number;
  readonly platformFeeBps: number;
  readonly platformFeePerEntryWei: string;
  readonly platformFeeTotalWei: string;
  readonly tradeRelayFeePerSubmitWei: string;
  readonly capitalRequiredWei: string;
  readonly capitalShortfallWei: string;
  readonly ok: boolean;
};

export type HireSizingPreview = GridHireSizingPreview | TradeHireSizingPreview;

/** Server-owned arithmetic for the mandatory S1 preview. */
export function hireSizingPreview(input: {
  readonly openNativeBudgetWei: bigint;
  readonly feeBps?: number;
  readonly relayFeePerSubmitWei?: bigint;
  readonly sizingPreset: keyof typeof HIRE_SIZING_PRESETS;
}): GridHireSizingPreview;
export function hireSizingPreview(input: {
  readonly capDayWei: bigint;
  readonly executionModel: TradeExecutionModel;
  readonly entryWei: bigint;
  readonly maxOpenPositions: number;
  readonly grantedTokenCount: number;
  readonly feeBps?: number;
  readonly relayFeePerSubmitWei?: bigint;
  readonly sizingPreset: "trade-v1";
}): TradeHireSizingPreview;
export function hireSizingPreview(input: {
  readonly openNativeBudgetWei?: bigint;
  readonly capDayWei?: bigint;
  readonly executionModel?: TradeExecutionModel;
  readonly entryWei?: bigint;
  readonly maxOpenPositions?: number;
  readonly grantedTokenCount?: number;
  readonly feeBps?: number;
  readonly relayFeePerSubmitWei?: bigint;
  readonly sizingPreset: HireSizingPresetName;
}): HireSizingPreview;
export function hireSizingPreview(input: {
  readonly openNativeBudgetWei?: bigint;
  readonly capDayWei?: bigint;
  readonly executionModel?: TradeExecutionModel;
  readonly entryWei?: bigint;
  readonly maxOpenPositions?: number;
  readonly grantedTokenCount?: number;
  readonly feeBps?: number;
  readonly relayFeePerSubmitWei?: bigint;
  readonly sizingPreset: HireSizingPresetName;
}): HireSizingPreview {
  if (input.sizingPreset === "trade-v1") {
    if (input.capDayWei === undefined || input.executionModel === undefined
      || input.entryWei === undefined || input.maxOpenPositions === undefined
      || input.grantedTokenCount === undefined) {
      throw new InvalidSessionSpecError("trade-v1 requires capDayWei, executionModel, entryWei, maxOpenPositions, and grantedTokenCount.");
    }
    const feeBps = input.feeBps ?? 0;
    const sized = checkTradeSizing({
      capDayWei: input.capDayWei,
      entryWei: input.entryWei,
      maxOpenPositions: input.maxOpenPositions,
      grantedTokenCount: input.grantedTokenCount,
      platformFeeBps: feeBps,
    });
    return {
      name: "trade-v1", version: 1, openNativeBudgetWei: "0",
      executionModel: input.executionModel, entryWei: input.entryWei.toString(10),
      maxOpenPositions: input.maxOpenPositions, grantedTokenCount: input.grantedTokenCount,
      platformFeeBps: feeBps,
      platformFeePerEntryWei: sized.platformFeePerEntryWei.toString(10),
      platformFeeTotalWei: sized.platformFeeTotalWei.toString(10),
      tradeRelayFeePerSubmitWei: RELAY_FEE_PER_EXIT_WEI.toString(10),
      capitalRequiredWei: sized.requiredWei.toString(10),
      capitalShortfallWei: sized.shortfallWei.toString(10),
      ok: sized.ok,
    };
  }
  if (input.openNativeBudgetWei === undefined) throw new InvalidSessionSpecError("openNativeBudgetWei is required.");
  if (input.openNativeBudgetWei <= 0n) throw new InvalidSessionSpecError("openNativeBudgetWei must be positive.");
  const feeBps = input.feeBps ?? 0;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new InvalidSessionSpecError("feeBps must be an integer in 0..10000.");
  const perSubmit = input.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
  if (perSubmit <= 0n) throw new InvalidSessionSpecError("lpRelayFeePerSubmitWei must be positive.");
  const preset = HIRE_SIZING_PRESETS[input.sizingPreset];
  const fee = (input.openNativeBudgetWei * BigInt(feeBps)) / 10_000n;
  const exitWei = BigInt(preset.maxExitSequencesPerDay) * BigInt(MAX_SUBMISSIONS_PER_SEQUENCE) * perSubmit;
  const protectWei = BigInt(preset.openPositionsCount) * BigInt(PROTECT_SUBMISSIONS_PER_POSITION) * perSubmit;
  const gridFlipWei = BigInt(preset.maxGridFlipsPerDay) * BigInt(MAX_SUBMISSIONS_PER_GRID_FLIP) * perSubmit;
  const shiftWei = BigInt(preset.maxShiftMotionsPerDay) * BigInt(MAX_SUBMISSIONS_PER_GRID_SHIFT) * perSubmit;
  const total = exitWei + protectWei + gridFlipWei + shiftWei;
  return {
    name: preset.name,
    version: preset.version,
    mode: preset.mode,
    openNativeBudgetWei: input.openNativeBudgetWei.toString(10),
    feeBps,
    feeWei: fee.toString(10),
    relayFeePerSubmitWei: perSubmit.toString(10),
    terms: {
      maxExitSequencesPerDay: preset.maxExitSequencesPerDay,
      openPositionsCount: preset.openPositionsCount,
      maxGridFlipsPerDay: preset.maxGridFlipsPerDay,
      maxRequotesPerDay: preset.maxRequotesPerDay,
      maxLadderMovesPerDay: preset.maxLadderMovesPerDay,
      maxShiftMotionsPerDay: preset.maxShiftMotionsPerDay,
    },
    reserves: {
      exitWei: exitWei.toString(10), protectWei: protectWei.toString(10),
      gridFlipWei: gridFlipWei.toString(10), shiftWei: shiftWei.toString(10), totalWei: total.toString(10),
    },
    minimumCapDayWei: (input.openNativeBudgetWei + fee + total + 1n).toString(10),
  };
}

export function checkHireSizing(input: {
  readonly capDayWei: bigint;
  readonly openNativeBudgetWei?: bigint;
  readonly executionModel?: TradeExecutionModel;
  readonly entryWei?: bigint;
  readonly maxOpenPositions?: number;
  readonly grantedTokenCount?: number;
  readonly feeBps?: number;
  readonly relayFeePerSubmitWei?: bigint;
  readonly sizingPreset: HireSizingPresetName;
}): NativeCapSizing {
  if (input.sizingPreset === "trade-v1") {
    if (input.executionModel === undefined || input.entryWei === undefined || input.maxOpenPositions === undefined) {
      return { ok: false, kind: "malformed", message: "trade-v1 requires executionModel, entryWei, and maxOpenPositions." };
    }
    const sized = checkTradeSizing({
      capDayWei: input.capDayWei,
      entryWei: input.entryWei,
      maxOpenPositions: input.maxOpenPositions,
      grantedTokenCount: input.grantedTokenCount ?? maxGrantedTokens(input.executionModel),
      platformFeeBps: input.feeBps ?? 0,
    });
    return sized.ok
      ? { ok: true }
      : { ok: false, kind: "shortfall", shortfallWei: sized.shortfallWei,
          message: `Total capital must be at least ${sized.minimumCapWei} wei.` };
  }
  if (input.openNativeBudgetWei === undefined) {
    return { ok: false, kind: "malformed", message: "openNativeBudgetWei is required." };
  }
  const preset = HIRE_SIZING_PRESETS[input.sizingPreset];
  return checkLpNativeCapSizing({
    onChainDailyCapWei: input.capDayWei,
    openNativeBudgetWei: input.openNativeBudgetWei,
    ...(input.feeBps === undefined ? {} : { feeBps: input.feeBps }),
    ...(input.relayFeePerSubmitWei === undefined ? {} : { lpRelayFeePerSubmitWei: input.relayFeePerSubmitWei }),
    maxExitSequencesPerDay: preset.maxExitSequencesPerDay,
    openPositionsCount: preset.openPositionsCount,
    ...(preset.mode === "shift"
      ? { shiftMotionsPerDay: preset.maxShiftMotionsPerDay }
      : preset.maxGridFlipsPerDay === 0
        ? {}
        : { maxGridFlipsPerDay: preset.maxGridFlipsPerDay }),
  });
}

/**
 * THE LP SIZING INVARIANT (PHASE3 Rev2 items 11–12), enforced at provisioning
 * AND re-run by `POST /lp/settings` against the LIVE session's on-chain cap
 * (the dev-stack A2 lesson — check against what the chain holds):
 *
 * ```
 * onChainDailyNativeCap > openNativeBudget
 *                       + openNativeBudget × feeBps / 10_000
 *                       + N × MAX_SUBMISSIONS_PER_SEQUENCE × LP_RELAY_FEE_PER_SUBMIT_WEI
 *                       + P × PROTECT_SUBMISSIONS_PER_POSITION × LP_RELAY_FEE_PER_SUBMIT_WEI
 *                       + shiftMotionsPerDay × MAX_SUBMISSIONS_PER_GRID_SHIFT × LP_RELAY_FEE_PER_SUBMIT_WEI
 * ```
 *
 * with `N = max(maxExitSequencesPerDay, --expected-sequences-day)` (the flag
 * RAISE-ONLY) and `P = max(1, openPositionsCount)` (audit A3). Every term is a
 * real outflow metered against the SAME on-chain native meter: the open's
 * `mint{value}` (the only native a saga attaches — Rev2 item 14 makes
 * rotations and harvests native-cap-neutral, so the open budget appears ONCE,
 * not per rotation), the fee on it, the relay's per-submission gas
 * reimbursement for the quota-bound sequences (FINDINGS (w)), and — the A3
 * term — {@link PROTECT_SUBMISSIONS_PER_POSITION} exit submissions' gas PER
 * OPEN POSITION, because protect and manual exit are quota-EXEMPT (Rev2 item
 * 13) yet draw from the same meter, and a protect is terminal per position so
 * that many submissions each is exact. (PHASE3.1-AUDIT A12: this sentence used
 * to say "one submission each", which was true only while the exit plan was
 * one step. PHASE3.1 made it two and the constant says so.)
 *
 * Provisioning REFUSES when it does not hold — the same posture as
 * {@link checkNativeCapSizing}, and the same honest language about what a
 * green check means. This reserve is on the SUBMISSION axis A1 demanded, and
 * — unlike the trade plane's per-token floor — the sequence journal ENFORCES
 * the quota-bound count (`reserveSequence` throws over quota) and the position
 * count bounds the exempt term, and PHASE3.25 R6.1's shift count is clamped to
 * the physical spacing capacity across its independent lanes, so it may be
 * stated as covering saga-driven
 * gas PROVIDED the per-submission constant is honest. Until the live-lp run
 * measures and replaces {@link DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI}, that
 * proviso fails and passing this check is a FLOOR, not a guarantee.
 */
export function checkLpNativeCapSizing(input: LpNativeCapSizingInput): NativeCapSizing {
  if (
    !Number.isInteger(input.maxExitSequencesPerDay) ||
    input.maxExitSequencesPerDay < 1
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "maxExitSequencesPerDay must be an integer >= 1; the reserve count is DERIVED from the enforced settings limit (PHASE3 Rev2 item 11), so a malformed limit cannot size anything.",
    };
  }
  if (input.openNativeBudgetWei < 0n || input.onChainDailyCapWei < 0n) {
    return {
      ok: false,
      kind: "malformed",
      message: "Native amounts must not be negative.",
    };
  }

  const floor = input.maxExitSequencesPerDay;
  const expected = input.expectedSequencesPerDay;
  if (expected !== undefined) {
    if (!Number.isInteger(expected) || expected < 1) {
      return {
        ok: false,
        kind: "malformed",
        message: "--expected-sequences-day must be an integer >= 1 when supplied.",
      };
    }
    if (expected < floor) {
      return {
        ok: false,
        kind: "malformed",
        message:
          `--expected-sequences-day ${expected} is below the settings-derived floor ${floor} ` +
          `(maxExitSequencesPerDay). The flag may only RAISE the reserve count (PHASE3 Rev2 item 11): ` +
          `the sequence journal enforces the settings limit, so reserving for fewer sequences than the ` +
          `owner may run re-creates A1 with a green check. Raise the flag or lower the setting.`,
      };
    }
  }
  const sequences = BigInt(Math.max(floor, expected ?? floor));
  const perSubmit = input.lpRelayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
  if (perSubmit <= 0n) {
    return {
      ok: false,
      kind: "malformed",
      message: "lpRelayFeePerSubmitWei must be positive.",
    };
  }
  const positionsRaw = input.openPositionsCount;
  if (
    positionsRaw !== undefined &&
    (!Number.isInteger(positionsRaw) || positionsRaw < 0)
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "openPositionsCount must be a nonnegative integer when supplied; the protect-gas reserve (audit A3) cannot be sized on a malformed count.",
    };
  }
  // P floors at 1: provisioning runs before any position exists, and the open
  // that follows creates exactly one — a zero reserve here would re-open A3.
  const protectPositions = BigInt(Math.max(1, positionsRaw ?? 1));
  const gridFlips = input.maxGridFlipsPerDay;
  if (
    gridFlips !== undefined
    && (!Number.isInteger(gridFlips) || gridFlips < 1 || gridFlips > 24)
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "maxGridFlipsPerDay must be an integer in 1..24 when supplied; the grid-flip gas reserve (PHASE3.15 R2.7) cannot be sized on a malformed count.",
    };
  }
  const requotes = input.maxRequotesPerDay;
  if (
    requotes !== undefined
    && (!Number.isInteger(requotes) || requotes < 1 || requotes > 24)
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "maxRequotesPerDay must be an integer in 1..24 when supplied; the grid-requote gas reserve (PHASE3.18 R2.11) cannot be sized on a malformed count.",
    };
  }
  const legacyMoves = input.maxMovesPerDay;
  if (
    legacyMoves !== undefined
    && (!Number.isInteger(legacyMoves) || legacyMoves < 1 || legacyMoves > 24)
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "maxMovesPerDay must be an integer in 1..24 when supplied; the grid-recenter gas reserve (PHASE3.19 item 30) cannot be sized on a malformed count.",
    };
  }
  // PHASE3.20 item 22 — the two named counts, each with its OWN bound and its
  // OWN message. They are summed into the recenter term below; at the D1
  // defaults `8 + 4 = 12`, which is exactly the client's shipped default, so the
  // gas reserve does not move for an owner who accepts them.
  const settlements = input.settlementsPerDay;
  if (
    settlements !== undefined
    && (!Number.isInteger(settlements) || settlements < 1 || settlements > 24)
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "settlementsPerDay must be an integer in 1..24 when supplied; the grid-recenter SETTLEMENT gas reserve (PHASE3.20 item 22) cannot be sized on a malformed count.",
    };
  }
  const driftMoves = input.driftMovesPerDay;
  if (
    driftMoves !== undefined
    && (!Number.isInteger(driftMoves) || driftMoves < 0 || driftMoves > 24)
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "driftMovesPerDay must be an integer in 0..24 when supplied; the grid-recenter DRIFT gas reserve (PHASE3.20 item 22) cannot be sized on a malformed count. Zero is legal and means settle fills, never chase.",
    };
  }
  // The two-count form WINS when either is supplied; `maxMovesPerDay` remains
  // for a caller that has not migrated. A ladder route always supplies the pair
  // through `ladderMotionCounts`, so the legacy branch is the compatibility
  // path and not the live one.
  const moves =
    settlements !== undefined || driftMoves !== undefined
      ? (settlements ?? 0) + (driftMoves ?? 0)
      : legacyMoves;
  const shiftMotions = input.shiftMotionsPerDay;
  if (
    shiftMotions !== undefined
    && (!Number.isInteger(shiftMotions) || shiftMotions < 0 || shiftMotions > 288)
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "shiftMotionsPerDay must be an integer in 0..288 when supplied; the grid-shift gas reserve (PHASE3.25 R6.1) cannot be sized on a malformed count.",
    };
  }

  const fee = (input.openNativeBudgetWei * BigInt(input.feeBps ?? 0)) / 10_000n;
  const exitReserve =
    sequences * BigInt(MAX_SUBMISSIONS_PER_SEQUENCE) * perSubmit;
  // The A3 term: quota-exempt protect/manual-exit gas,
  // PROTECT_SUBMISSIONS_PER_POSITION submissions per open position (TWO since
  // PHASE3.1 — the zap-out and the exit swap; PHASE3.1-AUDIT A12 corrects the
  // "one submission" wording this comment carried), so the stop-loss keeps
  // headroom even after the rotate/harvest quota is spent on a crash day.
  const protectReserve =
    protectPositions * BigInt(PROTECT_SUBMISSIONS_PER_POSITION) * perSubmit;
  // PHASE3.15 R2.7: the GRID term. A grid flip is quota-bound in its OWN lane,
  // so it occupies none of `N` above — and it still draws relay gas from the
  // same on-chain native meter, so without this the meter is drained by routine
  // flips and the PROTECT reserve is what runs out.
  const gridReserve =
    gridFlips === undefined
      ? 0n
      : BigInt(gridFlips) * BigInt(MAX_SUBMISSIONS_PER_GRID_FLIP) * perSubmit;
  // PHASE3.18 R2.11: the REQUOTE term. A requote is quota-bound in its OWN
  // lane, so it occupies neither `N` nor the flip term above — and it draws
  // relay gas from the same on-chain native meter, so without this a policy
  // grid's routine re-centres drain the meter and the PROTECT reserve is what
  // runs out. Same 3-submission shape as a flip, same constant, deliberately
  // not a second one.
  const requoteReserve =
    requotes === undefined
      ? 0n
      : BigInt(requotes) * BigInt(MAX_SUBMISSIONS_PER_GRID_FLIP) * perSubmit;
  // PHASE3.19 item 30: the RECENTER term. A ladder motion is quota-bound in its
  // OWN fourth lane, so it occupies none of `N`, none of the flip term and none
  // of the requote term — and it draws relay gas from the same on-chain native
  // meter, so without this an armed ladder reserves NOTHING for up to 24 motions
  // a day and the PROTECT reserve is what runs out. FOUR submissions, because a
  // ladder motion's middle step can fire where the other two lanes' always skip.
  const recenterReserve =
    moves === undefined
      ? 0n
      : BigInt(moves) * BigInt(MAX_SUBMISSIONS_PER_GRID_RECENTER) * perSubmit;
  // PHASE3.25 R6.1 — one real submission plus one whole-unit pad per physical
  // shift motion. The count is computed from separate settlement/drift lanes
  // at the server seams and clamped by their shared ceil-spacing capacity.
  const shiftReserve =
    shiftMotions === undefined
      ? 0n
      : BigInt(shiftMotions) * BigInt(MAX_SUBMISSIONS_PER_GRID_SHIFT) * perSubmit;
  const reserve =
    exitReserve + protectReserve + gridReserve + requoteReserve + recenterReserve + shiftReserve;
  const required = input.openNativeBudgetWei + fee + reserve;
  if (input.onChainDailyCapWei > required) return { ok: true };
  return {
    ok: false,
    kind: "shortfall",
    // A9: the same number the message computes below, carried structurally so a
    // caller whose error body is length-capped can still name it.
    shortfallWei: required - input.onChainDailyCapWei + 1n,
    message:
      `The on-chain daily native cap does not cover what this LP agent may spend. ` +
      `on-chain cap ${input.onChainDailyCapWei} wei must EXCEED ` +
      `open budget ${input.openNativeBudgetWei} + fee ${fee} + gas reserve ` +
      `${reserve} (= N ${sequences} × ${MAX_SUBMISSIONS_PER_SEQUENCE} submissions × ` +
      `${perSubmit} wei/submission, + protect headroom P ${protectPositions} × ` +
      `${PROTECT_SUBMISSIONS_PER_POSITION} submissions × ${perSubmit} wei` +
      (gridFlips === undefined
        ? ""
        : `, + grid headroom N_grid ${gridFlips} × ${MAX_SUBMISSIONS_PER_GRID_FLIP} submissions × ${perSubmit} wei (PHASE3.15: a flip's REAL submission count is 2 — the sweep always skips — and the third pads one resubmission after a hold)`) +
      (requotes === undefined
        ? ""
        : `, + requote headroom N_requote ${requotes} × ${MAX_SUBMISSIONS_PER_GRID_FLIP} submissions × ${perSubmit} wei (PHASE3.18: its OWN lane, so it occupies neither N nor N_grid; same 2-real-plus-1-pad shape as a flip)`) +
      (moves === undefined
        ? ""
        : `, + recenter headroom N_moves ${moves} × ${MAX_SUBMISSIONS_PER_GRID_RECENTER} submissions × ${perSubmit} wei (PHASE3.19: the LADDER's own fourth lane, so it occupies neither N nor N_grid nor N_requote; FOUR submissions because a ladder motion's hedge step can FIRE where a flip's and a requote's sweep always skips${settlements === undefined && driftMoves === undefined ? "" : `; PHASE3.20: N_moves is settlementsPerDay ${settlements ?? 0} + driftMovesPerDay ${driftMoves ?? 0}, two lanes over one gas meter`})`) +
      ` — audit A3, ` +
      `widened to the PHASE3.1 two-step exit [zap-out, sweep-token]: ` +
      `protects are quota-exempt yet draw the same meter; so is open, whose ` +
      `submission gas this formula does NOT reserve — PHASE3.7-AUDIT A4) = ${required} wei; short by ` +
      `${required - input.onChainDailyCapWei + 1n} wei. ` +
      `The relay reimburses its gas out of this same meter on EVERY submission ` +
      `(FINDINGS (w)), and rotations/harvests pay their principal in WBNB (Rev2 item 14), ` +
      `so gas is all they draw from it — this reserve is what keeps a mid-sequence mint ` +
      `from landing PENDING with no gas and no tx. The sequence journal enforces the ` +
      `quota-bound count and the position count bounds the exempt term, so this reserve ` +
      `covers saga gas PROVIDED the per-submission constant is measured; until live-lp ` +
      `replaces the 0.0001 BNB placeholder, passing this check is a floor, ` +
      `not a guarantee.`,
  };
}

/**
 * Whether `treasury` is actually granted by `spec`.
 *
 * Boot calls this when a fee is configured (PHASE2 R10): a fee whose recipient
 * is outside the session allowlist makes EVERY trade fail on-chain, and it fails
 * at the relay after the batch is built and submitted. Refusing to start is the
 * cheap version of that discovery.
 */
export function grantsTreasury(spec: SessionSpec, treasury: Address): boolean {
  const target = treasury.toLowerCase();
  return spec.allowedCalls.some(
    (rule) => rule.to !== undefined && rule.to.toLowerCase() === target,
  );
}

/**
 * Whether `spec` grants everything a SELL of `token` needs — i.e. whether a
 * position in it could ever be EXITED.
 *
 * The trade route calls this to enforce the PHASE2.3 R1 invariant, `buy =>
 * sellable`. A token with no cap can be bought (a Pancake buy needs no
 * `approve`) and then never sold, because the sell's `approve` has no limit to
 * meter against — FINDINGS (h), per token, silent.
 *
 * BOTH halves are required, and the pair is not interchangeable. The account
 * checks the allowlist BEFORE any meter, so a token carrying a spend limit and
 * no `approve` rule reads as authorised in `spendInfos` and still cannot be
 * sold. That asymmetry is not hypothetical: `owner-add-spend-limit` shipped
 * granting only the limit, and the token it "authorised" on mainnet was bought
 * and then stuck — FINDINGS (u). `tradeSessionSpec` always emits the pair, so
 * for specs it builds the two legs agree; this checks them separately anyway,
 * because a spec is data and may arrive from anywhere. Matching is by address,
 * case-insensitively, exactly as `assertTokenMoversAreCapped` matches.
 */
export function grantsTokenSell(spec: SessionSpec, token: Address): boolean {
  const target = token.toLowerCase();
  const capped = spec.spendCaps.some(
    (cap) => cap.token !== undefined && cap.token.toLowerCase() === target,
  );
  if (!capped) return false;
  return spec.allowedCalls.some(
    (rule) =>
      rule.to !== undefined &&
      rule.to.toLowerCase() === target &&
      (rule.selector === undefined || rule.selector === APPROVE_SELECTOR),
  );
}

/* -------------------------------------------------------------------------- */
/* The Venus guard session template (PHASE4 D5, R2.1/R2.7/R3.2/R3.12)         */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on a Venus guard session, in seconds — SEVEN DAYS, the same
 * constant as {@link MAX_TRADE_SESSION_SECONDS}.
 *
 * PHASE4 Revision 2 proposed thirty days on one clause ("a guard is standing
 * insurance, not a trading session"); Revision 3 (R3.2/S2) WITHDREW that and
 * kept seven, for reasons that bite harder here than for trade or LP:
 *
 *   1. R2.1 makes the per-token ROLLING DAILY cap the SOLE bound on a leaked
 *      session key's `approve`-spender drain. A daily cap over a 30-day session
 *      is a 30x lifetime drain ceiling — the exact `cap x periods` arithmetic
 *      {@link MAX_TRADE_SESSION_SECONDS} was chosen by (FINDINGS (d)/(g)/(r)).
 *   2. The Core Comptroller is a DIAMOND and the vToken implementations are
 *      proxies (R2.7's measured census), so a 30-day grant is a 30-day window
 *      in which Venus governance can re-cut selector routing under a live
 *      session nobody re-reviews.
 *
 * The standing-guard problem is solved the other way: the owner view surfaces a
 * first-class `session-expiring` condition at
 * {@link VENUS_SESSION_EXPIRING_SECONDS}, states the renewal cadence, and the
 * product copy says plainly that a guard session renews weekly with one owner
 * signature.
 */
export const MAX_VENUS_SESSION_SECONDS = MAX_TRADE_SESSION_SECONDS;

/** Remaining session below which `session-expiring` fires (R2.15/R16). */
export const VENUS_SESSION_EXPIRING_SECONDS = 48 * 60 * 60;

/**
 * The selectors granted on vBNB — BOTH payable, and the amount IS `msg.value`.
 *
 * Located in deployed vBNB bytecode at block 117738703: `repayBorrow()`
 * 0x4e4d9fea, `mint()` 0x1249c58b.
 */
export const VENUS_VBNB_GRANTED_SELECTORS = [
  // REPAY-ONLY since Revision 4 (FINDINGS (at)): `mint()` minted a position
  // an EIP-7702 wallet cannot redeem — vBNB pays out via a 2300-gas
  // `.transfer()` that reverts against delegation code. Native REPAY sends
  // value INTO the contract and is measured safe, including the overpay case
  // (CEther REVERTS loudly on value > debt for every caller — no refund path
  // exists). `grantsVenusMarket(vBNB)` therefore now means "can repay", not
  // "can mint" (third review V5); the supply path refuses native markets
  // BEFORE any grant check, so the shift is unobservable there.
  "repayBorrow()",
] as const;

/**
 * The selectors granted on an ERC-20 vToken. Located in the VBep20
 * implementation 0xCDfe...941e: `repayBorrow(uint256)` 0x0e752702,
 * `mint(uint256)` 0xa0712d68.
 */
export const VENUS_VTOKEN_GRANTED_SELECTORS = [
  "repayBorrow(uint256)",
  "mint(uint256)",
] as const;

/** `claimVenus(address,address[])` 0x86df31ee, on Comptroller facet 0x9e0C...416f. */
export const VENUS_COMPTROLLER_GRANTED_SELECTOR = "claimVenus(address,address[])";

/** `claimInterest(address,address)` 0xba437c68, on Prime impl 0x18cb...3a1b. */
export const VENUS_PRIME_GRANTED_SELECTOR = "claimInterest(address,address)";

/**
 * THE CENSUS IS CLOSED. Every selector this template may ever emit, in one
 * list, so a test can enumerate what a built spec granted and FAIL on any
 * addition (test obligation 3).
 *
 * WHAT IS ABSENT IS NORMATIVE, and each absence was located in deployed
 * bytecode too, which is what makes refusing it meaningful:
 * `borrow(uint256)` 0xc5ebeaec, `redeem(uint256)` 0xdb006a75,
 * `redeemUnderlying(uint256)` 0x852a12e3, `enterMarkets(address[])`
 * 0xc2998238, `exitMarket(address)` 0xede4edd0 — plus every VAI selector, every
 * `transfer`/`transferFrom` on a vToken, and (the LP lesson, kept) NO
 * `multicall` and NO target-only rule on any contract except the treasury.
 */
export const VENUS_GRANTED_SELECTORS: readonly string[] = [
  ...VENUS_VBNB_GRANTED_SELECTORS,
  ...VENUS_VTOKEN_GRANTED_SELECTORS,
  APPROVE_SELECTOR,
  VENUS_COMPTROLLER_GRANTED_SELECTOR,
  VENUS_PRIME_GRANTED_SELECTOR,
];

/** The set this template must never grant. Named so the refusal is auditable. */
export const VENUS_REFUSED_SELECTORS: readonly string[] = [
  "borrow(uint256)",
  "redeem(uint256)",
  "redeemUnderlying(uint256)",
  "enterMarkets(address[])",
  "exitMarket(address)",
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "multicall(bytes[])",
];

/**
 * One underlying the guard may spend, with its REQUIRED cap.
 *
 * `dailyCapWei` has NO DEFAULT, and {@link DEFAULT_TOKEN_CAP_LIMIT} is
 * FORBIDDEN here (R2.1). That is the opposite of the 2.3-R4 posture, and the
 * difference is stated at both constants: a trade token cap meters a curated
 * venue flow whose real budget is the native cap on buys, while a Venus token
 * cap is the ONLY bound on an `approve`-spender drain, because `CallRule`
 * cannot constrain an argument (PHASE2 OQ1, this file at :312 and :518). Here
 * the cap is a BUDGET, not a gate.
 */
export type VenusTokenGrant = {
  /** The ERC-20 underlying. Gets a target-bound `approve` rule AND a cap. */
  readonly token: Address;
  /**
   * Its vToken — the spender this plane's builders will name.
   *
   * Recorded for the role-collision check and for provisioning output. It is
   * NOT enforceable by the grant: the spender is calldata. Nothing in this
   * module may be read as claiming otherwise.
   */
  readonly vToken: Address;
  /** REQUIRED, positive. See above — this is the drain budget. */
  readonly dailyCapWei: bigint;
  /** Rolling period. Defaults to `day`. */
  readonly period?: SpendPeriod;
};

/**
 * The R3.12 routing census: what the plane recorded, and what it must still
 * find, before a Venus session may be granted.
 *
 * The Core Comptroller is a Diamond; `claimVenus` lives on a facet and the
 * vToken implementations sit behind proxies. The grant pins selector+target,
 * never SEMANTICS — so a governance re-cut lands under a live `CallRule` and
 * changes what the granted selector does. Under the 7-day ceiling the exposure
 * window of a mid-session re-cut is bounded at one week; this check bounds the
 * window at GRANT time to zero.
 */
export type VenusRoutingCensus = {
  /** `facetAddress(0x86df31ee)` as read now. */
  readonly claimVenusFacet: Address;
  /** Prime's EIP-1967 implementation as read now. */
  readonly primeImplementation: Address;
  /** Each granted ERC-20 vToken's `implementation()` as read now. */
  readonly vTokenImplementations: readonly (readonly [Address, Address])[];
};

/** Where the census was taken. Block 117738703, `.agents/HANDOFF.md` 2026-08-24. */
export const VENUS_CENSUS_BLOCK = 117_738_703n;

/**
 * The recorded census, as MEASURED. Boot and every grant re-read the chain and
 * compare against this; a move is a LOUD typed refusal naming old and new.
 *
 * These addresses are EVIDENCE, not configuration. Re-censusing is a doc change
 * that goes through the phase process, not an env key somebody can move.
 */
export const VENUS_RECORDED_ROUTING: {
  readonly claimVenusFacet: Address;
  readonly policyFacet: Address;
  readonly readsFacet: Address;
  readonly comptrollerImplementation: Address;
  readonly vBep20Implementation: Address;
  readonly primeImplementation: Address;
} = {
  claimVenusFacet: "0x9e0CCD70b5E0030472D5013bbBd37B6E868d416f",
  policyFacet: "0x21f8E1471b153f49BE1d645A008E4a57434eEd23",
  readsFacet: "0x8930B02c69EDd37464B50991680D306Bb9B8FDBD",
  comptrollerImplementation: "0xA66B2b5D50ce68A125bBad6B2265b637868c6E66",
  vBep20Implementation: "0xCDfea50f7CECCB24Fe804657DB8E6c93b689941e",
  primeImplementation: "0x18cb7198cbb6d6e94001458cf3cf47c106d83a1b",
};

/**
 * Refuse the grant when any routing has moved since the census block.
 *
 * LOUD and typed, naming old and new: a silent pass here is a session granted
 * over semantics nobody has read.
 */
export function assertVenusRoutingUnchanged(observed: VenusRoutingCensus): void {
  const same = (left: Address, right: Address): boolean =>
    left.toLowerCase() === right.toLowerCase();
  if (!same(observed.claimVenusFacet, VENUS_RECORDED_ROUTING.claimVenusFacet)) {
    throw new InvalidSessionSpecError(
      `Venus routing has MOVED since the census at block ${VENUS_CENSUS_BLOCK}: ` +
        `claimVenus(address,address[]) now routes to facet ${observed.claimVenusFacet}, ` +
        `census recorded ${VENUS_RECORDED_ROUTING.claimVenusFacet}. The Core Comptroller ` +
        `is a Diamond and the grant pins selector+target, never semantics — refusing the ` +
        `grant until the census is re-taken and re-reviewed.`,
    );
  }
  if (!same(observed.primeImplementation, VENUS_RECORDED_ROUTING.primeImplementation)) {
    throw new InvalidSessionSpecError(
      `Venus routing has MOVED since the census at block ${VENUS_CENSUS_BLOCK}: ` +
        `Prime implementation is now ${observed.primeImplementation}, census recorded ` +
        `${VENUS_RECORDED_ROUTING.primeImplementation}. Refusing the grant.`,
    );
  }
  for (const [vToken, implementation] of observed.vTokenImplementations) {
    if (!same(implementation, VENUS_RECORDED_ROUTING.vBep20Implementation)) {
      throw new InvalidSessionSpecError(
        `Venus routing has MOVED since the census at block ${VENUS_CENSUS_BLOCK}: ` +
          `vToken ${vToken} now points at implementation ${implementation}, census ` +
          `recorded ${VENUS_RECORDED_ROUTING.vBep20Implementation}. repayBorrow/mint ` +
          `semantics are governance-mutable behind that proxy — refusing the grant.`,
      );
    }
  }
}

export type VenusSessionSpecInput = {
  /** Venus Core Comptroller. Granted the ONE `claimVenus` overload, per-selector. */
  readonly comptroller: Address;
  /** Venus Prime. Granted `claimInterest(address,address)` only. */
  readonly prime: Address;
  /**
   * vBNB, pinned by ADDRESS (R2.15/R15) — never derived from a `symbol()`
   * string in an advisory cache. Omit when the guard covers no native market.
   */
  readonly vBnb?: Address;
  /** ERC-20 vTokens the guard may repay into / mint into. */
  readonly vTokens: readonly Address[];
  /** Their underlyings, each with its REQUIRED cap. */
  readonly tokens: readonly VenusTokenGrant[];
  /**
   * Fee treasury. REQUIRED even though Venus v1 is FEE-FREE (R2.15/R17 and the
   * LP precedent at :400-405): the allowlist is signed on-chain at grant time
   * and a persisted spec is never rewritten, so a later fee must be a config
   * change, never a re-grant. Taxing a rescue is indefensible and v1 does not.
   */
  readonly treasury: Address;
  /** NATIVE spend caps. MUST be non-empty; none may name a token. */
  readonly nativeCaps: readonly SpendCap[];
  /** Requested expiry, unix SECONDS. CLAMPED to 7 days. */
  readonly expiresAt: number;
  /** Clock, unix SECONDS. Injected so the clamp is testable. */
  readonly nowSeconds?: number;
  /**
   * The freshly-read routing census (R3.12). Supplied by the grant path;
   * optional only so a pure template test need not fabricate chain reads — the
   * provisioning script always passes it and boot re-checks independently.
   */
  readonly routing?: VenusRoutingCensus;
};

/**
 * Build the canonical Venus guard `SessionSpec`.
 *
 * ═══ THE CUSTODY SENTENCE, IN ITS TRUE FORM (R2.1) ═════════════════════════
 *
 * The first draft of this phase said "there is no selector in the grant that
 * moves value anywhere but into the position or to the owner". That is FALSE as
 * a statement about a leaked key, and this repo had already documented why
 * twice (this file at :312 and :518). The true statement — the strongest this
 * design can make, and the only one the marketplace may render:
 *
 *   The granted selectors move value only into the position or to the owner
 *   WHEN THIS PLANE BUILDS THE CALLDATA. A leaked session key additionally
 *   reaches `approve` on each allowed underlying with an UNCONSTRAINED
 *   SPENDER, bounded ONLY by that token's on-chain spend cap for the period.
 *   The token cap is therefore a BUDGET, not a gate.
 *
 * Residuals, stated rather than implied: `approve` moves no value itself, so
 * the NATIVE meter never sees it; the token cap is per-period ROLLING, not
 * lifetime; and an allowance OUTLIVES the session's expiry until it is spent or
 * zeroed. The builders therefore approve EXACT amounts and zero a residual
 * allowance first (R2.1(2), R2.16/R25).
 *
 * ═══ WHAT IS GRANTED ═══════════════════════════════════════════════════════
 *
 * Per-selector rules ONLY, except the treasury, which is target-only and
 * uncapped exactly as the trade and LP templates grant theirs (2.3 R10).
 * Nothing is bare-selector; nothing is target-only on a contract that can move
 * a token.
 */
export function venusSessionSpec(input: VenusSessionSpecInput): SessionSpec {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ceiling = nowSeconds + MAX_VENUS_SESSION_SECONDS;
  const expiresAt = Math.min(input.expiresAt, ceiling);

  if (input.routing !== undefined) assertVenusRoutingUnchanged(input.routing);

  if (input.nativeCaps.length === 0) {
    throw new InvalidSessionSpecError(
      "venusSessionSpec requires at least one native spend cap; an empty list is uncapped.",
    );
  }
  for (const [index, cap] of input.nativeCaps.entries()) {
    if (cap.token !== undefined) {
      throw new InvalidSessionSpecError(
        `nativeCaps[${index}] names a token. Per-token caps come from \`tokens\`, which grants the matching approve rule too.`,
      );
    }
  }
  if (input.vTokens.length === 0 && input.vBnb === undefined) {
    throw new InvalidSessionSpecError(
      "venusSessionSpec requires at least one market: a guard that can pay nothing is a promise the agent cannot keep.",
    );
  }

  // R2.1(1). No default, and DEFAULT_TOKEN_CAP_LIMIT is refused BY NAME so a
  // caller cannot reach the trade template's gate posture by copying its call.
  for (const grant of input.tokens) {
    if (grant.dailyCapWei <= 0n) {
      throw new InvalidSessionSpecError(
        `venusSessionSpec: token ${grant.token} has no positive dailyCapWei. Venus per-token caps are SIZED, never defaulted — the cap is the only bound on a leaked key's approve-spender drain (PHASE4 R2.1).`,
      );
    }
    if (grant.dailyCapWei >= DEFAULT_TOKEN_CAP_LIMIT) {
      throw new InvalidSessionSpecError(
        `venusSessionSpec: token ${grant.token} was granted the effectively-unlimited trade-template cap (>= 2^160). That posture is FORBIDDEN here: a trade token cap meters a curated venue flow, a Venus token cap is the sole bound on an approve-spender drain (PHASE4 R2.1).`,
      );
    }
  }

  // Role collision, across every address in the grant. The load-bearing cases:
  // a treasury equal to an underlying is an uncapped target-only rule on an
  // ERC-20 (unlimited `transfer`); a vToken equal to its own underlying merges
  // the approve authority with the repay authority; a Comptroller equal to a
  // vToken would put `claimVenus` and `repayBorrow` on one target.
  const roles: (readonly [string, Address])[] = [
    ["comptroller", input.comptroller],
    ["prime", input.prime],
    ["treasury", input.treasury],
    ...(input.vBnb === undefined ? [] : [["vBnb", input.vBnb] as const]),
    ...input.vTokens.map((vToken, index) => [`vTokens[${index}]`, vToken] as const),
    ...input.tokens.map((grant, index) => [`tokens[${index}]`, grant.token] as const),
  ];
  for (let a = 0; a < roles.length; a += 1) {
    for (let b = a + 1; b < roles.length; b += 1) {
      const left = roles[a];
      const right = roles[b];
      if (
        left !== undefined &&
        right !== undefined &&
        left[1].toLowerCase() === right[1].toLowerCase()
      ) {
        throw new InvalidSessionSpecError(
          `venusSessionSpec: ${left[0]} and ${right[0]} are the same address (${left[1]}). Each address plays a distinct role in the grant; a collision merges two authorities the template keeps apart.`,
        );
      }
    }
  }

  const vBnb = input.vBnb;
  const allowedCalls: CallRule[] = [
    // The Comptroller, per-selector: exactly the 2-arg `claimVenus`. The other
    // overloads live on the same facet and are NOT granted.
    { to: input.comptroller, selector: VENUS_COMPTROLLER_GRANTED_SELECTOR },
    { to: input.prime, selector: VENUS_PRIME_GRANTED_SELECTOR },
    ...(vBnb === undefined
      ? []
      : VENUS_VBNB_GRANTED_SELECTORS.map((selector) => ({ to: vBnb, selector }))),
    ...input.vTokens.flatMap((vToken) =>
      VENUS_VTOKEN_GRANTED_SELECTORS.map((selector) => ({ to: vToken, selector })),
    ),
    // TARGET-BOUND approves. The SPENDER is an argument `CallRule` cannot
    // constrain; it stays bounded by the builders naming the vToken from
    // resolved config, never from a request field — and by the cap above, which
    // is what actually bounds a leaked key.
    ...input.tokens.map((grant) => ({ to: grant.token, selector: APPROVE_SELECTOR })),
    // Fee-free v1, treasury granted anyway. Target-only, no cap.
    { to: input.treasury },
  ];

  const spendCaps: SpendCap[] = [
    ...input.nativeCaps,
    ...input.tokens.map((grant) => ({
      token: grant.token,
      limit: grant.dailyCapWei,
      period: grant.period ?? DEFAULT_TOKEN_CAP_PERIOD,
    })),
  ];

  const spec: SessionSpec = { allowedCalls, spendCaps, expiresAt };
  validateSessionSpec(spec, {
    nowSeconds,
    maxSessionSeconds: MAX_VENUS_SESSION_SECONDS,
  });
  return spec;
}

/**
 * The exposure PRODUCT provisioning must print — `cap x periods`, never the
 * per-period rate alone (FINDINGS (r), restated by R3.2).
 *
 * Seven daily periods fit in the 7-day ceiling, so the product is `cap x 7` for
 * every rolling-day cap. A rate on its own is the number that made a 0.05
 * BNB/day grant read as 0.05 BNB of exposure when it was 0.35.
 */
export function venusExposureProduct(input: {
  readonly nativeDailyCapWei: bigint;
  readonly tokens: readonly VenusTokenGrant[];
  readonly sessionSeconds: number;
}): {
  readonly periods: number;
  readonly nativeProductWei: bigint;
  readonly tokenProducts: readonly {
    readonly token: Address;
    readonly productWei: bigint;
  }[];
} {
  const periods = Math.max(1, Math.ceil(input.sessionSeconds / (24 * 60 * 60)));
  return {
    periods,
    nativeProductWei: input.nativeDailyCapWei * BigInt(periods),
    tokenProducts: input.tokens.map((grant) => ({
      token: grant.token,
      productWei: grant.dailyCapWei * BigInt(periods),
    })),
  };
}

/**
 * Whether a session grants everything a repay/mint on `vToken` needs.
 *
 * The settings route calls this as an EARLY WARNING (R2.15/R20) and says so in
 * its refusal text: a persisted `sessionFacts.spec` goes stale the moment the
 * owner widens the session on chain, and `preflightExecute` at ACTION time is
 * the guarantee — the chain is the authority NOW (Phase 2.4).
 */
export function grantsVenusMarket(spec: SessionSpec, vToken: Address): boolean {
  const target = vToken.toLowerCase();
  const granted = new Set<string>();
  for (const rule of spec.allowedCalls) {
    if (rule.to === undefined || rule.to.toLowerCase() !== target) continue;
    if (rule.selector === undefined) continue;
    granted.add(rule.selector);
  }
  const hasAll = (want: readonly string[]): boolean =>
    want.every((selector) => granted.has(selector));
  return (
    hasAll(VENUS_VTOKEN_GRANTED_SELECTORS as readonly string[])
    || hasAll(VENUS_VBNB_GRANTED_SELECTORS as readonly string[])
  );
}

/* -------------------------------------------------------------------------- */
/* The Venus reserves (PHASE4 R2.11 / R3.6)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The default number of rescue submissions the CLAIM gate holds meter back for.
 *
 * A NUMBER, not "owner-set" (R3.6/S6). Four is one rescue per market on a
 * typical 2-4 market account plus margin; the owner may raise it in settings.
 */
export const DEFAULT_VENUS_RESCUE_RESERVE_COUNT = 4;

/**
 * The WALLET-balance floor every native-value-attaching Venus action leaves
 * behind — `2 x RELAY_FEE_PER_EXIT_WEI` (0.0002 BNB at the current constant),
 * i.e. one rescue's reimbursement plus margin (R3.6).
 *
 * ═══ WHY THE WALLET AND NOT THE METER (R2.11(b)/(c)) ══════════════════════
 *
 * This is NOT the meter reserve. The meter reserve protects on-chain cap
 * headroom; this protects the wallet's actual native BALANCE. They are
 * unrelated quantities with unrelated failure modes, and the phase's first
 * draft called them one name.
 *
 * It applies to EVERY native-value-attaching action — repay AND supply — and
 * the reason is measured: the relay reimburses itself in native OUT OF THE
 * WALLET on every submission (this file at :207-221). A native
 * `repayBorrow{value: everything}` sweeps the wallet exactly as a mint does,
 * and the NEXT rescue then has no native to pay the relay with.
 *
 * ═══ MEASUREMENT DEBT, RESTATED AT THIS CALL SITE (R3.6) ══════════════════
 *
 * {@link RELAY_FEE_PER_EXIT_WEI} is still the 4x-padded SINGLE-SAMPLE guess. It
 * is deliberately not env-overridable, for the reason recorded at :596-601 — a
 * deployment that can lower a guarantee-shaped reserve from the environment can
 * quietly disarm it. Worse for THIS function specifically: no measurement in
 * this repo bounds the relay's reimbursement as a WALLET DEBIT rather than as a
 * meter increment, and a Venus submission is a THIRD shape the existing
 * `live-trade --measure-relay-fee` harness must learn before any public
 * deployment. Nothing here may be read as a measured guarantee.
 *
 * It is applied ONCE, inside the wallet-balance term of the sizing `min(...)`,
 * on WHICHEVER BRANCH IS NATIVE — both branches carry the term (R3.1/S1) — and
 * a floor-clamped rescue submits the REDUCED amount, never refuses.
 */
export function walletNativeFloorWei(): bigint {
  return 2n * RELAY_FEE_PER_EXIT_WEI;
}

export type VenusMeterReserveInput = {
  readonly limitWei: bigint;
  /** The CURRENT period's usage — `currentSpent`, never `spent`. */
  readonly currentSpentWei: bigint;
  /** `rescueReserveCount` from settings. */
  readonly rescueReserveCount: number;
  /**
   * Rescue submissions ALREADY charged in the rolling window (R3.4).
   *
   * The reserve NARROWS by what has already fired: a day of six rescues has
   * already drawn six reimbursements out of this meter, and a static reserve
   * would keep authorizing claims against headroom those rescues consumed.
   */
  readonly rescuesChargedInWindow: number;
  /** Native THIS claim will spend. Claims attach none, so normally `0n`. */
  readonly submissionNativeWei: bigint;
};

export type VenusMeterReserve = {
  readonly remainingWei: bigint;
  readonly overCap: boolean;
  /** `max(1, rescueReserveCount - rescuesCharged) x per-submission fee`. */
  readonly reserveWei: bigint;
  readonly reservedSubmissions: number;
  readonly submissionNativeWei: bigint;
  readonly ownFeeWei: bigint;
  readonly requiredWei: bigint;
  readonly sufficient: boolean;
  readonly shortfallWei: bigint;
};

/**
 * The CLAIM gate's headroom decision — a NEW pure function, deliberately not a
 * generalisation of {@link nativeReserveFloor} (R2.11(a)).
 *
 * `nativeReserveFloor` computes its reserve INTERNALLY from `grantedTokenCount`
 * via {@link exitReserveWei} and has no injection seam. Generalising it would
 * have to prove the trade gate's behaviour byte-identical afterwards, because
 * `/trade`'s refusal and `/agents/:id/owner-view`'s report share that seam by
 * design. So Phase 4 adds a function and does not touch that one; the trade
 * gate is unchanged BY CONSTRUCTION rather than by argument.
 *
 * ═══ WHAT IT GATES, AND WHAT IT MUST NOT ═════════════════════════════════
 *
 * CLAIMS ONLY. Rescues are the SELL-analog and are NEVER refused by a reserve
 * floor — refusing the rescue IS the trap. An unreadable meter fails closed as
 * TRANSPORT on the CLAIM side only.
 *
 * The four meter readings, all four named (R2.11(e), mirroring the trade gate
 * at `server.ts:2124-2158`): `day` is gated here; `other-period` and
 * `no-native-grant` are REPORTED and not gated — but `no-native-grant`
 * additionally makes any NATIVE rescue a typed refusal at SIZING time, because
 * a session with no native row cannot attach value at all (FINDINGS (h)), while
 * ERC-20 rescues proceed untouched.
 *
 * Like {@link walletNativeFloorWei} it prices a submission at
 * {@link RELAY_FEE_PER_EXIT_WEI} and inherits that constant's measurement debt
 * verbatim.
 */
export function venusMeterReserve(
  input: VenusMeterReserveInput,
): VenusMeterReserve {
  const remainingWei = input.limitWei - input.currentSpentWei;
  const outstanding = Math.max(
    1,
    input.rescueReserveCount - Math.max(0, input.rescuesChargedInWindow),
  );
  const reserveWei = BigInt(outstanding) * RELAY_FEE_PER_EXIT_WEI;
  const ownFeeWei = RELAY_FEE_PER_EXIT_WEI;
  const requiredWei = input.submissionNativeWei + ownFeeWei + reserveWei;
  const sufficient = remainingWei >= requiredWei;
  return {
    remainingWei,
    overCap: remainingWei < 0n,
    reserveWei,
    reservedSubmissions: outstanding,
    submissionNativeWei: input.submissionNativeWei,
    ownFeeWei,
    requiredWei,
    sufficient,
    shortfallWei: sufficient ? 0n : requiredWei - remainingWei,
  };
}

export type VenusNativeCapSizingInput = {
  /** The rolling daily NATIVE cap the owner is about to grant ON CHAIN. */
  readonly onChainDailyCapWei: bigint;
  /** `rescueReserveCount` — rescue submissions to reserve gas for. */
  readonly rescueReserveCount: number;
  /** `maxClaimsPerDay` — claim submissions to reserve gas for. */
  readonly maxClaimsPerDay: number;
  /**
   * The largest single native VALUE a rescue may attach — the owner's
   * `maxPerAction` for the native market, or `0n` when no native market is
   * covered.
   */
  readonly maxNativeActionWei: bigint;
};

/**
 * THE VENUS PROVISIONING SIZING CHECK — an EARLY WARNING, and it says so.
 *
 * ```
 * onChainDailyNativeCap > maxNativeActionWei
 *                       + (rescueReserveCount + maxClaimsPerDay)
 *                         x RELAY_FEE_PER_EXIT_WEI
 * ```
 *
 * The Phase 2.5 posture VERBATIM, and D5's warning is honoured rather than
 * quietly inverted: this reserves per-SUBMISSION arithmetic on the still
 * UNMEASURED {@link RELAY_FEE_PER_EXIT_WEI}, and the SUBMIT-TIME checks
 * ({@link venusMeterReserve} for claims, plus the sizing minimum's wallet term
 * for rescues) are where any guarantee lives. **Phase 4 must NOT silently
 * re-promote the constant into a guarantee the way PHASE2.4 A1 did**, and this
 * function is the place that sentence had to survive.
 *
 * Note what is deliberately NOT reserved: a rescue is never refused for want of
 * headroom, so this check cannot BOUND rescue spending — it can only tell an
 * operator, at the one moment it is cheap to fix, that the cap they are about to
 * grant does not cover a day of the guard doing its job.
 */
export function checkVenusNativeCapSizing(
  input: VenusNativeCapSizingInput,
): NativeCapSizing {
  if (
    !Number.isInteger(input.rescueReserveCount)
    || input.rescueReserveCount < 1
  ) {
    return {
      ok: false,
      kind: "malformed",
      message:
        "rescueReserveCount must be an integer >= 1; the reserve cannot be sized on a malformed count.",
    };
  }
  if (!Number.isInteger(input.maxClaimsPerDay) || input.maxClaimsPerDay < 0) {
    return {
      ok: false,
      kind: "malformed",
      message: "maxClaimsPerDay must be a nonnegative integer.",
    };
  }
  if (input.onChainDailyCapWei < 0n || input.maxNativeActionWei < 0n) {
    return {
      ok: false,
      kind: "malformed",
      message: "Native amounts must not be negative.",
    };
  }
  const submissions = BigInt(input.rescueReserveCount + input.maxClaimsPerDay);
  const gasReserve = submissions * RELAY_FEE_PER_EXIT_WEI;
  const required = input.maxNativeActionWei + gasReserve;
  if (input.onChainDailyCapWei > required) return { ok: true };
  return {
    ok: false,
    kind: "shortfall",
    shortfallWei: required - input.onChainDailyCapWei + 1n,
    message:
      `The on-chain daily native cap does not cover a day of this guard doing its job. ` +
      `on-chain cap ${input.onChainDailyCapWei} wei must EXCEED largest native rescue ` +
      `${input.maxNativeActionWei} + gas reserve ${gasReserve} (= ${submissions} ` +
      `submissions x ${RELAY_FEE_PER_EXIT_WEI} wei) = ${required} wei; short by ` +
      `${required - input.onChainDailyCapWei + 1n} wei. ` +
      `THIS IS AN EARLY WARNING, NOT A GUARANTEE: it reserves per-SUBMISSION arithmetic ` +
      `on RELAY_FEE_PER_EXIT_WEI, which is still a 4x-padded guess on ONE mainnet sample, ` +
      `and a rescue is NEVER refused for want of headroom — refusing the rescue is the trap. ` +
      `What the submit-time checks actually hold is the CLAIM gate's meter reserve and the ` +
      `wallet floor inside the rescue's own sizing minimum.`,
  };
}
import { checkTradeSizing, maxGrantedTokens } from "../trade/sizing.js";
import type { TradeExecutionModel } from "../trade/settings.js";
