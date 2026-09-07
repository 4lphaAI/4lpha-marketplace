/**
 * Deterministic LP-management triggers, ported from `D:\4lpha-0G`
 * `lib/agent/lp/lp-manage.ts` (`evaluateLpTriggers` + `validateTriggerInput`).
 *
 * PURE AND OFFLINE: no I/O, no clock reads — the caller injects `nowMs` and
 * finalized-chain observations. Priority order is NORMATIVE:
 * protect (0) > rotate (1) > harvest (2), ONE action per evaluation per
 * position. The LLM brain is never consulted here (PHASE3 R13/item 28): this
 * module has no import path to `src/lp/brain.ts` and decides WHETHER, the
 * brain only ever proposes HOW.
 *
 * DELIBERATE DELTAS from the 0G original (PHASE3 Rev2 item 25, named here so
 * a diff against 0G reads as intent, not drift):
 *   - `harvestMinFeesWei` is a bigint in WEI, re-based for BNB: bound `> 0`,
 *     default 0.002 BNB. The 0G original was a decimal string floored at
 *     0.01 native-0G and capped at 100.
 *   - `topUpEnabled` and the `harvest-top-up` decision are DROPPED — the 0G
 *     vault-headroom min() (`computeV41Reinvestable`) collapses to "reinvest
 *     the exact confirmed proceeds" because on-chain session caps replaced
 *     the vault's exposure caps.
 *   - `rotationBudget0G` is DROPPED for the same reason.
 *   - TP/SL basis (`basisWei`) is the position LINEAGE basis (Rev2 item 17):
 *     recorded at open, carried unchanged across every rotate and harvest,
 *     reset only when protect or a manual exit closes the lineage. The CALLER
 *     owns that persistence — this evaluator only compares.
 *   - The rail check itself lives in `src/lp/rails.ts` and the rail config
 *     carries `twapWindowSeconds` AND `maxSagaSlippageBps` (Rev2 items 18/23).
 *   - Settings gain `brainEnabled`, `stakingEnabled`, `accumulateMode`,
 *     `minAprBps` (Rev2 item 39); the last three are v1-fenced below.
 */
import { SWAPLESS_MAX_RESIDUE_BPS } from "./fence.js";
import { getSqrtRatioAtTick, MAX_TICK, MIN_TICK, swapSplitIsTotal } from "./tickMath.js";
import { V3_FEE_TIERS } from "../ops/route.js";
import type { TradeLlmModelId } from "../trade/llm.js";
// PHASE3.18 R2.1: the coherence rule runs the ONE rung derivation. That module
// is a LEAF (type-only imports back to this file), so this dependency adds no
// runtime cycle — see its header for why the derivation had to move there.
import { gridPolicyCoherence } from "./gridGeometry.js";
import {
  assertValidLpRailConfig,
  checkManipulationRails,
  priceDeviationBps,
  type LpRailConfig,
  type LpRailEvidence,
} from "./rails.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type LpManagementDecision =
  | "protect-stop-loss"
  | "protect-take-profit"
  // PHASE3.6 Rev2 M14. `src/lp/worker.ts` maps any non-rotate/non-harvest
  // decision to sequence kind "protect", so these need no dispatch change —
  // but without them the receipt cannot name which instrument fired.
  | "protect-price-stop-loss"
  | "protect-price-take-profit"
  | "rotate"
  | "harvest"
  /**
   * PHASE3.15 (R2.6/H7). The grid ping-pong's ONE money decision: settle the
   * filled level and re-mint single-sided into the OPPOSITE signed range.
   *
   * It joins this union rather than living in a private grid vocabulary because
   * `src/lp/worker.ts` maps a decision onto a saga kind, and a second decision
   * type would need a second dispatch — the drift class this repo has paid for
   * twice. The consequence is named in the worker: the ternary at the dispatch
   * had a catch-all `protect` default, so a member added here without an arm
   * there EXITS every grid position silently. That ternary is now an exhaustive
   * switch, which is what makes adding this member safe.
   */
  | "grid-flip"
  /**
   * PHASE3.18 — the grid requote: re-centre an UNFILLED level on its OWN side,
   * at the signed policy's distance from the fresh tick.
   *
   * It joins this union for the same reason `grid-flip` did, and the same
   * compiler guarantee applies: `lpDispatchKindFor` is an EXHAUSTIVE switch, so
   * this member did not compile until its dispatch arm existed. Emitted ONLY
   * under `grid.mode: "policy"` — a fixed grid can never produce it, which is
   * the byte-identity pin R2.13 requires.
   */
  | "grid-requote"
  /**
   * PHASE3.19 — the LADDER's ONE motion: re-anchor THIS rung at
   * `anchor +/- ladder.gapTicks` from the fresh tick, funded from the idle
   * buffer, optionally hedging the standing inventory imbalance on the way.
   *
   * ONE decision for BOTH triggers, and that is the whole of the phase's cure
   * (D4/R2.4): a FILL's motion and a DRIFT's motion are no longer different
   * machines, which deletes the Q5 asymmetry that produced FINDINGS (ax). The
   * two pieces of EVIDENCE keep their own durable counters; only the motion is
   * shared.
   *
   * It joins this union for the reason `grid-flip` and `grid-requote` did, and
   * the same compiler guarantee applies: `lpDispatchKindFor` is an EXHAUSTIVE
   * switch, so this member did not compile until its dispatch arm existed.
   * Emitted ONLY under `grid.mode: "ladder"`.
   */
  | "grid-recenter"
  /**
   * PHASE3.22 R7 / PHASE3.23 — the ATOMIC ladder's ONE motion: re-anchor one
   * or both rungs from the current tick in a single relay batch.
   *
   * ONE decision for BOTH triggers, exactly as `grid-recenter` is — but where
   * the 3.19 ladder shares one MOTION between two lanes, shift mode shares one
   * SUBMISSION between its targeted RUNGS. Cross and clean drift still target
   * both; mid-fill drift targets only the clean rung and leaves its sibling
   * untouched (PHASE3.23 R2.1/R3.4).
   *
   * ONE DECISION FOR THE PAIR, not one per row (R7). The evaluator's dispatch
   * gate resolves which row carries it — the buy row while it is live,
   * otherwise the surviving sell row — from the cycle's `shiftGroupLiveRoles`
   * snapshot, so the pair can never dispatch twice for one motion.
   *
   * It joins this union for the reason its three grid predecessors did, and
   * the same compiler guarantee applies: `lpDispatchKindFor` is an EXHAUSTIVE
   * switch, so this member did not compile until its dispatch arm existed.
   * Emitted ONLY under `grid.mode: "shift"`.
   */
  | "grid-shift"
  | "hold";

/**
 * Where a basis came from. `"owner-budget"` is the ONE name for the
 * owner-signed budget recorded at `/lp/open`, and `"imported"` (PHASE3.4) the
 * owner's DECLARATION at `POST /lp/import` about a position this plane did not
 * create — both shared verbatim with `src/store/lpSequences.ts`
 * `LpLineageBasisSource`, unified when `src/lp/sagas.ts` landed so the saga
 * layer passes the persisted value through without a mapping.
 *
 * `"minted"` IS NOW PERSISTED (PHASE3.16, ruling Q2) — it was typed here from
 * the start for exactly this future source and the future arrived. It is the
 * GRID ARM's row: the plane minted the position and there is deliberately no
 * basis (`basisWei: 0n`), because a ping-pong's inventory alternates assets and
 * a lineage-basis TP/SL would misfire on it. `"owner-budget"` would claim the
 * plane metered a number it recorded as zero; `"imported"` would claim a
 * position this plane did not create. Because the member already existed here,
 * the addition on the STORE side needed no mapping — which is the whole point
 * of the unified vocabulary.
 *
 * The evaluator TREATS THEM IDENTICALLY, and it must: a basis is a number in
 * quote wei, and where it came from changes what may be CLAIMED about it (the
 * receipt, the dashboard, the sizing term), never how a threshold is compared.
 */
export type LpBasisSource = "minted" | "owner-budget" | "imported";

/**
 * The ONE TP/SL comparison (PHASE3.4 Rev2 M11), extracted from the evaluator so
 * `POST /agents/:id/lp/import` can refuse an already-breaching import on exactly
 * the predicate that would later fire — decision 11's argument applied to the
 * comparison rather than only to the valuation.
 *
 * Exact integer arithmetic, and the shape is preserved verbatim from the
 * evaluator: multiply out rather than divide, so no rounding exists to argue
 * about, and the comparisons are `<=` / `>=`, so a value sitting EXACTLY on the
 * threshold IS a breach. Stop-loss is tested first and wins — the two cannot
 * both hold unless the owner configured overlapping thresholds, and in that case
 * protecting the downside is the answer that loses less.
 *
 * `basisWei <= 0` answers `null`: a zero basis is the "manage it, no TP/SL"
 * option (`LP_BASIS_ZERO_HOLD_REASON`), not a position at zero value.
 */
export function evaluateLpProtectBreach(input: {
  readonly basisWei: bigint;
  readonly exitValueWei: bigint;
  readonly stopLossPct: number;
  readonly takeProfitPct: number;
}): { readonly kind: "stop-loss" | "take-profit"; readonly thresholdBps: bigint } | null {
  if (input.basisWei <= 0n) return null;
  if (input.stopLossPct > 0) {
    const threshold = BigInt(input.stopLossPct) * 100n;
    if (input.exitValueWei * 10_000n <= input.basisWei * (10_000n - threshold)) {
      return { kind: "stop-loss", thresholdBps: -threshold };
    }
  }
  if (input.takeProfitPct > 0) {
    const threshold = BigInt(input.takeProfitPct) * 100n;
    if (input.exitValueWei * 10_000n >= input.basisWei * (10_000n + threshold)) {
      return { kind: "take-profit", thresholdBps: threshold };
    }
  }
  return null;
}

/**
 * An owner-signed PRICE threshold (PHASE3.6), or `null` when off.
 *
 * WHY A TICK AND A DIRECTION, never a price and never an inference. A tick is
 * the pool's own unit and the comparison is integer; a decimal price on the
 * wire would need a float or a scaled bigint, a decimals convention per token,
 * and an orientation convention — three chances to be wrong about a number that
 * liquidates a position.
 *
 * `when` is EXPLICIT because deriving "which side is down" from the pool's leg
 * order is exactly what went wrong in FINDINGS (ao): whether a falling token
 * price moves the tick up or down depends on whether the token is `token0` or
 * `token1`, while the owner's mental model is about the TOKEN. The plane
 * enforces literally what was signed. The price→tick→direction derivation still
 * exists — it lives in the CLI, where it PRINTS its reasoning and refuses when
 * the operator's stated direction disagrees with the one it derived (Rev2 M10).
 *
 * `pool` is required because `lpSettings` is per-AGENT while a tick means one
 * thing in one pool. MATCHING, however, is on the position row's
 * `(token0, token1, fee)` triple (Rev2 M1/M6): that triple uniquely names a
 * Pancake V3 pool, it is already on `LpPositionRecord`, and — unlike a pool
 * address — the READ ROUTE can evaluate it without a chain call.
 */
export type LpPriceTrigger = {
  /**
   * The pool, named by the triple that IDENTIFIES it rather than by its
   * address (Rev2 M6, resolved).
   *
   * The review's requirement was that the matching rule name "a field that
   * exists on both paths". A pool ADDRESS exists on neither: `LpPositionRecord`
   * does not carry one, and deriving it means `getPool`, a chain call the read
   * route's own comment forbids. The triple is already on the record, already
   * in `lpPositionView`, and uniquely names a Pancake V3 pool — so ONE rule
   * serves the evaluator and the route, and they cannot disagree.
   *
   * The operator still THINKS in pool addresses; `live-lp` resolves one to this
   * triple and prints both.
   */
  readonly token0: `0x${string}`;
  readonly token1: `0x${string}`;
  readonly fee: number;
  /** The pool's own tick. `MIN_TICK..MAX_TICK`. */
  readonly tick: number;
  readonly when: "at-or-below" | "at-or-above";
};

/**
 * The tick direction a price trigger must carry, derived from the operator's
 * INTENT alone (PHASE3.6 Rev2 M10, restored by FIXREVIEW N1).
 *
 * It lives here rather than in `scripts/live-lp.ts` because of FIXREVIEW2 P1:
 * inverting it there left the whole suite green — the headline fix of a commit
 * about unverified claims had no coverage, and the mutation fails CLOSED on the
 * CORRECT input, so it would have refused the FINDINGS (ao) owner's own stop at
 * the terminal. Nothing in `scripts/` is importable (its `main()` runs at
 * import), and this derivation is pure pool arithmetic that any future UI needs
 * too.
 *
 * THE TRUTH TABLE, and it follows from one fact: a V3 tick tracks
 * token1-per-token0, which is the price OF token0.
 *
 *
 *   quoted price is token1/token0 (the price OF token0)   — inverted=false
 *     stop-loss   -> token0 cheapens -> tick FALLS -> at-or-below
 *     take-profit -> token0 dearens  -> tick RISES -> at-or-above
 *   quoted price is token0/token1 (the price OF token1)   — inverted=true
 *     stop-loss   -> token1 cheapens -> tick RISES -> at-or-above
 *     take-profit -> token1 dearens  -> tick FALLS -> at-or-below
 *
 *
 * The second row is the (ao) case: USDT/WBNB with USDT as token0, an owner
 * quoting USDT-per-BNB, wanting out if BNB weakens ⇒ `at-or-above`.
 */
export function expectedPriceTriggerDirection(
  which: "stop-loss" | "take-profit",
  quotedPriceIsToken1: boolean,
): "at-or-below" | "at-or-above" {
  // `quotedPriceIsToken1` is the CLI's `--…-price-inverted`: the number the
  // operator typed is token0-per-token1, i.e. a price OF token1.
  const quotedAssetFallsWithTick = !quotedPriceIsToken1;
  const wantsAFall = which === "stop-loss";
  return wantsAFall === quotedAssetFallsWithTick ? "at-or-below" : "at-or-above";
}

/** Whether `trigger` is satisfied at `currentTick`. Inclusive on both sides. */
export function priceTriggerFires(
  trigger: LpPriceTrigger,
  currentTick: number,
): boolean {
  return trigger.when === "at-or-below"
    ? currentTick <= trigger.tick
    : currentTick >= trigger.tick;
}

/**
 * Does this trigger apply to this pool? Case-insensitive on the legs, exact on
 * the fee. Leg ORDER is not normalised: both the position row and the signed
 * trigger carry pool order (`token0 < token1`), which `parseLpOpenParams`
 * already enforces on the one path that lets a caller name a pool.
 */
export function priceTriggerMatchesPool(
  trigger: LpPriceTrigger,
  pool: {
    readonly token0: `0x${string}`;
    readonly token1: `0x${string}`;
    readonly fee: number;
  },
): boolean {
  return (
    trigger.fee === pool.fee
    && trigger.token0.toLowerCase() === pool.token0.toLowerCase()
    && trigger.token1.toLowerCase() === pool.token1.toLowerCase()
  );
}

/**
 * The price trigger that would ALREADY be satisfied for a position in this pool
 * at this tick, or `null` (PHASE3.6 Rev2 M8).
 *
 * ONE predicate, shared by `POST /lp/import` and `POST /lp/open`, because an
 * armed trigger OUTLIVES the position that motivated it: without this, the next
 * position opened or imported into that pool would be liquidated two cycles
 * later by a threshold its owner set for something else. Sharing the function
 * rather than re-implementing the comparison is PHASE3.4 M11's rule applied
 * again.
 */
export function alreadySatisfiedPriceTrigger(
  settings: {
    readonly priceStopLoss: LpPriceTrigger | null;
    readonly priceTakeProfit: LpPriceTrigger | null;
  },
  pool: {
    readonly token0: `0x${string}`;
    readonly token1: `0x${string}`;
    readonly fee: number;
  },
  currentTick: number,
): { readonly label: "stopLoss" | "takeProfit"; readonly trigger: LpPriceTrigger } | null {
  for (const [label, trigger] of [
    ["stopLoss", settings.priceStopLoss],
    ["takeProfit", settings.priceTakeProfit],
  ] as const) {
    if (trigger === null) continue;
    if (!priceTriggerMatchesPool(trigger, pool)) continue;
    if (priceTriggerFires(trigger, currentTick)) return { label, trigger };
  }
  return null;
}

/** The trigger if it applies to this position, else `null`. */
function matchedPriceTrigger(
  trigger: LpPriceTrigger | null,
  position: {
    readonly token0: `0x${string}`;
    readonly token1: `0x${string}`;
    readonly fee: number;
  },
): LpPriceTrigger | null {
  if (trigger === null) return null;
  return priceTriggerMatchesPool(trigger, position) ? trigger : null;
}

/**
 * The CLASS a breach belongs to (Rev2 M7). The consecutive-confirmation count
 * compares this, not the exact kind: a position building a `price-stop-loss`
 * count that also trips the VALUE stop on cycle 2 must DISPATCH, not restart —
 * more evidence of danger must never produce a later exit.
 */
export function breachClassOf(
  breach: LpTriggerObservation["protectBreach"],
): "stop" | "take-profit" | undefined {
  if (breach === undefined) return undefined;
  return breach === "stop-loss" || breach === "price-stop-loss"
    ? "stop"
    : "take-profit";
}

export type LpTriggerPositionInput = {
  /**
   * LINEAGE basis in wei of the quote asset (WBNB), Rev2 item 17. Recorded at
   * `/lp/open` from the owner-signed budget; NOT re-based on rotate/harvest.
   * Zero disables protect (with an explicit hold reason), never fires it.
   */
  readonly basisWei: bigint;
  readonly basisSource: LpBasisSource;
  readonly collectibleFee0: bigint;
  readonly collectibleFee1: bigint;
  readonly currentTick: number;
  /** Position value (both legs + uncollected fees) quoted into WBNB wei. */
  readonly exitValueWei: bigint;
  /** Freshly collectible fees quoted into WBNB wei. */
  readonly freshFeesValueWei: bigint;
  readonly poolAddress: `0x${string}`;
  /**
   * The pool's identifying triple (PHASE3.6). Carried alongside `poolAddress`
   * rather than instead of it: the address is what the observation and the
   * receipt record, the triple is what a price trigger MATCHES on, and the
   * route can evaluate the triple without a chain read.
   */
  readonly token0: `0x${string}`;
  readonly token1: `0x${string}`;
  readonly fee: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly tokenId: string;
  /**
   * PHASE3.18 R2.6 / C1 — the position row's DURABLE grid identity, carried
   * through so the grid evaluator can resolve `{level, role}` in POLICY MODE
   * without an exact-tick match (a requoted rung equals no signed rung, which
   * is the definition of policy mode).
   *
   * OPTIONAL and defaulting to absent, so every non-grid caller and every
   * 3.15-3.17 test fixture is unchanged. `null` means the COLUMN is null, which
   * in policy mode is a HOLD naming the remedy and never a guess (R2.6); FIXED
   * mode ignores both fields entirely and exact-tick match stays the authority.
   */
  readonly gridLevel?: LpGridLevelValue | null;
  readonly gridRole?: LpGridRoleValue | null;
  /**
   * PHASE3.19 item 18 / C16 — the IDLE BUFFER, as two wallet balances in their
   * OWN token units, read once per cycle on the EVALUATE path and supplied as
   * evaluator INPUTS.
   *
   * They are inputs rather than a reader because the evaluator is PURE and must
   * stay so (the 3.15 M10 property): the funding conjunct is a decision the
   * caller must be able to reproduce offline from recorded numbers.
   *
   * OPTIONAL and defaulting to absent, so every non-ladder caller and every
   * 3.15-3.18 fixture is unchanged. ABSENT under ladder mode FAILS CLOSED — the
   * funding conjunct cannot be satisfied by a balance nobody read.
   *
   * THEY NEVER PARTICIPATE IN `settingsUnchanged` OR COMPARABILITY (item 18): a
   * balance change measures INVENTORY and the cross/drift counters measure
   * PRICE, so folding these into the staleness logic would reset the anti-wick
   * evidence on every fee accrual.
   */
  readonly bufferQuoteWei?: bigint;
  readonly bufferBaseWei?: bigint;
  /**
   * GRID-GAS-RESERVE P2 — the wallet's NATIVE balance, read by the worker under
   * shift mode only and PRESENT-ONLY-WHEN-READ like the two above. The shift
   * trigger's gas gate fails closed on its absence: a batch the relay bills
   * from an unread pot is not a batch this plane dispatches.
   */
  readonly bufferNativeWei?: bigint;
};

/**
 * PHASE3.18 — the durable identity columns' value types, declared HERE rather
 * than in `gridTriggers.ts` so `LpTriggerPositionInput` and the STORE can both
 * name them without importing the grid evaluator.
 */
export type LpGridLevelValue = 1 | 2;
export type LpGridRoleValue = "buy" | "sell";

/* -------------------------------------------------------------------------- */
/* PHASE3.15 — the grid ping-pong block                                       */
/* -------------------------------------------------------------------------- */

/** One signed grid level, in the pool's OWN tick coordinates. */
export type LpGridRange = {
  readonly tickLower: number;
  readonly tickUpper: number;
};

/**
 * The owner-signed two-range ping-pong (PHASE3.15 R2.2/R2.8, C1).
 *
 * ─── WHY `wbnbIsToken0` AND `tickSpacing` ARE SIGNED FIELDS ────────────────
 *
 * REVIEW2 C1. R2.8 wanted both "recorded with the settings evidence", and there
 * is no such store: `LpSettingsRecord` is `{params, digest, updatedAt}` and
 * nothing else. They cannot be SERVER-INJECTED either — `ownerAuth` recomputes
 * `paramsHash` over the params the caller signed, so a field the route adds
 * before hashing does not verify. And they cannot be omitted: `validateLpSettings`
 * is pure over parsed params, so without them it can check neither spacing
 * alignment nor the orientation-conditioned ordering constraint, and both would
 * fall back to the route — which is exactly the M4/M16 drift (`worker.ts`
 * re-parses stored settings through the same validator, so a route-only rule is
 * a rule the worker does not enforce).
 *
 * So they are CALLER-SUPPLIED and CROSS-CHECKED at the route against its own
 * pool read; a mismatch is a refusal naming both values. After that, every
 * consumer reads them from the signed params.
 *
 * ─── GEOMETRY, IN POOL ORDER (R2.2 / OQ1) ─────────────────────────────────
 *
 * ```text
 * A V3 range strictly ABOVE the tick charges token0 only.   (fence.ts:363-378)
 * A V3 range at or BELOW the tick charges token1 only.
 *
 * wbnbIsToken0 === true   (quote = token0, base = token1):
 *     buyRange is ABOVE the price; sellRange is BELOW it.
 *     constraint:  sellRange.tickUpper <= buyRange.tickLower
 * wbnbIsToken0 === false  (quote = token1, base = token0):
 *     buyRange is BELOW the price; sellRange is ABOVE it.
 *     constraint:  buyRange.tickUpper  <= sellRange.tickLower
 * ```
 *
 * The ONE implementable rule: **the quote-holding (buy) range is always on the
 * side of the price that charges the quote token**, the ranges do not overlap,
 * and the base-holding range is on the other side. The spec's first draft wrote
 * `buyRange.tickUpper <= sellRange.tickLower` unconditionally, which inverts on
 * every pool where WBNB sorts into token0 — the 3.13 F7 inversion, reproduced in
 * a validation rule (review H1).
 */
export type LpGridSettings = {
  /** The pool this grid runs on, named by the triple that identifies it. */
  readonly pool: {
    readonly token0: `0x${string}`;
    readonly token1: `0x${string}`;
    readonly fee: number;
  };
  /** C1: signed, cross-checked at the route against its own pool read. */
  readonly wbnbIsToken0: boolean;
  /** C1: the pool's live tick spacing, signed and cross-checked at the route. */
  readonly tickSpacing: number;
  /** The quote-holding level. */
  readonly buyRange: LpGridRange;
  /** The base-holding level. */
  readonly sellRange: LpGridRange;
  /**
   * PHASE3.17 R2.2 — LEVEL 2's pair, present only on a DUAL grid.
   *
   * BOTH-OR-NEITHER, enforced in {@link validateLpSettings} (review2 N14: both
   * operands are settings fields, so the rule belongs in the pure validator and
   * not in `readGridSettings`). Absent ⇒ a 3.15/3.16 single-level grid,
   * byte-identical in every path.
   *
   * ─── WHY A SECOND PAIR AND NOT A SECOND LEVEL ON ONE PAIR (B3) ────────────
   *
   * Two levels sharing ONE pair of ranges synchronize permanently after the
   * first fill: level A fills, flips into the sell range, and now sits on
   * byte-identical ticks to level B, holding the same asset. From that moment
   * they take the same cross reading, target the same range and flip together
   * for ever — a one-level grid carrying two NFTs at double the gas, which is
   * exactly the thing a dual arm exists to stop being. The fix is STRUCTURAL:
   * each level owns its OWN pair, the four ranges are pairwise disjoint, and
   * two levels can never occupy one range.
   *
   * ─── THE CROSSED-PAIR GEOMETRY, IN POOL ORDER (R2.1) ──────────────────────
   *
   * The four ranges are the grid's four RUNGS. Each level's pair spans one
   * INNER rung on one side and the OUTER rung on the other, so both levels
   * quote the price-nearest rungs AT ARM TIME (C10 — after a fill a level's
   * counter-order lands on its pair's OUTER rung, so the inner rungs go
   * periodically vacant; that is the ladder working, not a defect) and both
   * cycles carry equal spread under even rung pitch.
   *
   * ```text
   * Case B (wbnbIsToken0 === false; buy below the tick, sell above):
   *   ascending ticks:  buy2 | buy1 | <- corridor -> | sell2 | sell1
   *   chain:  buy2.tickUpper  <= buy1.tickLower
   *        /\ buy1.tickUpper  <= sell2.tickLower
   *        /\ sell2.tickUpper <= sell1.tickLower
   *   arm corridor:  buy1.tickUpper <= t < sell2.tickLower
   *
   * Case A (wbnbIsToken0 === true; buy above the tick, sell below):
   *   ascending ticks:  sell1 | sell2 | <- corridor -> | buy1 | buy2
   *   chain:  sell1.tickUpper <= sell2.tickLower
   *        /\ sell2.tickUpper <= buy1.tickLower
   *        /\ buy1.tickUpper  <= buy2.tickLower
   *   arm corridor:  sell2.tickUpper <= t < buy1.tickLower
   * ```
   *
   * Level 1 = (`buyRange` INNER, `sellRange` OUTER), armed as the BUY at
   * `buyRange`. Level 2 = (`buyRange2` OUTER, `sellRange2` INNER), armed as the
   * SELL at `sellRange2`. Both chains IMPLY the existing pair-1 ordering rule
   * for BOTH pairs, so that rule is unchanged and contradicts nothing.
   *
   * ONE-WAY ROLLBACK, the same sense as `grid` itself: a stored row that omits
   * these keys parses to a single-level grid, but a build that does not KNOW
   * them fails `parseLpSettingsParams` on the WHOLE row of any owner who signed
   * them. Roll back by re-signing with the pair cleared FIRST.
   */
  readonly buyRange2?: LpGridRange;
  /** Level 2's INNER rung — the one a dual arm funds with base. See {@link buyRange2}. */
  readonly sellRange2?: LpGridRange;
  /**
   * The grid's OWN daily quota, 1..24 (R2.7). It does NOT share
   * `maxExitSequencesPerDay` — a grid's whole point is to cycle — but the
   * agent-wide `minMinutesBetweenExits` spacing gate still FLOORS the rate, and
   * `validateLpSettings` refuses a value that gate makes unreachable (C3).
   */
  readonly maxFlipsPerDay: number;
  /** The owner's own admission floor on top of the gas cost (R2.10). */
  readonly minNetEdgeBps: number;
  /**
   * PHASE3.18 R2.2 (ruling Q1) — WHICH LADDER THIS IS. Absent ⇒ `"fixed"`.
   *
   * `"fixed"` is 3.15–3.17 byte for byte: four owner-signed rungs that never
   * move, role resolved by EXACT-TICK match, no requote.
   *
   * `"ladder"` is PHASE3.19 and is a DIFFERENT STRATEGY on the same machinery:
   * BOTH rungs re-anchor near the price — on a FILL and on a DRIFT alike,
   * through ONE saga and ONE quota lane — funded from an IDLE BUFFER held in the
   * owner's own EOA rather than from the rungs themselves, with a profit-gated
   * hedge that keeps that buffer two-sided.
   *
   * IT SCOPES THE HEADLINE INVARIANT (L1). "A grid never swaps to rebalance"
   * stays true verbatim for `fixed` and `policy`; a LADDER swaps only to HEDGE
   * filled inventory, sized to the imbalance and only at protected profit
   * against its own durable VWAP book.
   *
   * `"policy"` keeps the same four SIGNED rungs as the INITIAL placement (C3 —
   * the arm mints at the signed rungs in BOTH modes and policy mode floats
   * nothing until the first requote) but adds the drift-triggered requote: an
   * UNFILLED level whose distance from the price exceeds its signed gap by
   * {@link LpGridRequote.driftPctOfGap} is re-centred on its own side, at the
   * {@link LpGridPolicy} distance from the fresh tick.
   *
   * ─── WHY AN EXPLICIT FIELD AND NOT SUB-BLOCK PRESENCE ─────────────────────
   *
   * Ruling Q1 REFUSED presence-semantics. Three stacked presence keys make
   * "requote absent" and "requote off" indistinguishable, and rolling policy
   * back to fixed UNDER A LIVE LEVEL is a silent geometry change that kills the
   * grid at three seams at once (role identity, C2's admission, import's door).
   * A named mode is a thing an owner can read back off their own signature.
   *
   * Present-only-when-set on the wire, exactly like `buyRange2` — see
   * `gridSettingsParamsView`. `DEFAULT_SETTINGS_DIGEST` must not move.
   */
  readonly mode?: LpGridMode;
  /**
   * PHASE3.18 R2.1 (review B1) — THE SIGNED GEOMETRY POLICY, present only in
   * policy mode.
   *
   * B1's finding, and the reason this block exists: `gapTicks`/`widthTicks`
   * lived ONLY in the client script, were never signed, never stored and never
   * reached the server — and they CANNOT be recovered unambiguously from the
   * rungs, because a dual level's own pair separates by `s + 3g + w` while the
   * two inner rungs separate by `s + 2g`. A requote that re-derives a rung from
   * a policy the plane cannot see is a rung the owner never signed.
   *
   * C6: the policy is SHARED between the two levels in v1 — one gap, one width.
   * The R2.1 coherence rule (`gridPolicyCoherence`) proves in
   * {@link validateLpSettings} that the four signed rungs ARE this policy's
   * derivation at some tick, in both orientations and both level counts.
   */
  readonly policy?: LpGridPolicy;
  /**
   * PHASE3.18 — the requote's own two owner-signed numbers. Legal ONLY under
   * `mode: "policy"`; a requote block under `"fixed"` is refused at signing
   * (R2.2), and `"policy"` without one is refused too (C5 — all of the identity
   * and admission cost, none of the motion).
   */
  readonly requote?: LpGridRequote;
  /**
   * PHASE3.19 R2.1/D2 — THE LADDER's signed geometry and motion policy, present
   * only under `mode: "ladder"`.
   *
   * Legal ONLY under that mode, and required by it: a ladder block under
   * `"fixed"`/`"policy"` is a setting that quietly means nothing (the (ae)
   * shape) and `"ladder"` without one has no geometry to re-anchor against.
   *
   * PRESENT-ONLY-WHEN-SET on the wire (C18), for the fifth time and for the
   * same reason every additive grid key before it is: `canonicalEncode` drops
   * ABSENT keys but ENCODES present ones, so emitting it at an absent value
   * would move `DEFAULT_SETTINGS_DIGEST` and refuse every in-flight sequence of
   * every agent with no stored settings row at upgrade.
   */
  readonly ladder?: LpGridLadder;
  /**
   * PHASE3.22 R1 (as amended by R5.8) — THE ATOMIC LADDER's signed geometry and
   * motion policy, present only under `mode: "shift"`.
   *
   * Legal ONLY under that mode and required by it, for the (ae) reason every
   * sibling block carries: a shift block under another mode is a setting that
   * quietly means nothing, and `"shift"` without one has no geometry to
   * re-anchor against.
   *
   * PRESENT-ONLY-WHEN-SET on the wire, for the SIXTH time and for the same
   * reason: `canonicalEncode` drops ABSENT keys but ENCODES present ones, so
   * emitting it at an absent value would move `DEFAULT_SETTINGS_DIGEST` and
   * refuse every in-flight sequence of every agent with no stored settings row.
   */
  readonly shift?: LpGridShift;
};

/**
 * PHASE3.18 R2.2 / PHASE3.19 R2.1 / PHASE3.22 R1. See {@link LpGridSettings.mode}.
 *
 * `"ladder"` is PHASE3.19: idle-buffer market making, where BOTH rungs re-anchor
 * near the price — on a fill AND on a drift, through one saga and one quota lane
 * — and a profit-gated hedge keeps the buffer two-sided.
 *
 * `"shift"` is PHASE3.22: the same re-anchoring, collapsed into ONE relay batch.
 * One or both targeted rungs are zapped out and re-minted in a single
 * all-or-nothing submission. Cross and clean drift use the original two-rung
 * shape; mid-fill drift uses the seven-call one-rung shape. There is no hedge
 * (operator decision 2).
 */
export type LpGridMode = "fixed" | "policy" | "ladder" | "shift";

/**
 * PHASE3.19 — the LADDER's profit-gated inventory hedge.
 *
 * `enabled` defaults TRUE, and turning it OFF is a legal v1 configuration with a
 * DECLARED consequence (C12): a one-sided market then parks a side until the
 * market moves it back, and the ladder degrades to a one-and-a-half-sided
 * quoter. The funding hold's own text says so.
 *
 * `minMarkoutBps` is the profit the hedge must clear against the ladder's VWAP
 * book average before it will sell inventory at market. Its EFFECTIVE floor is
 * `poolFeeBps + maxSagaSlippageBps` ({@link ladderMinMarkoutBps}) — the hedge's
 * own EXECUTION cost — because a hedge that clears only its own fee is not a
 * profit, it is a fee paid twice. The signed number may only RAISE it.
 *
 * `maxHedgePctBps` caps ONE hedge as a fraction of one side's deployed size, so
 * a large accumulated imbalance is unwound over several motions rather than in
 * one market order.
 */
export type LpGridLadderHedge = {
  readonly enabled: boolean;
  readonly minMarkoutBps: number;
  readonly maxHedgePctBps: number;
};

/**
 * PHASE3.19 R2.1 — the ladder's SIGNED geometry and motion policy.
 *
 * `gapTicks`/`widthTicks` are the same two quantities `LpGridPolicy` carries and
 * are used the same way — but they are a SEPARATE block, deliberately: under
 * ladder mode `grid.policy` does not exist (C17), so a target derivation that
 * reached for {@link LpGridPolicy} would read `undefined`. The ladder's target
 * uses `ladder.gapTicks` DIRECTLY and MUST NOT call `gridPolicyGapFor`
 * (item 12): a ladder has ONE rung per side, never a crossed pair, so there is
 * no outer rung for that function's `2g + w` branch to be about.
 *
 * `deployPctBps` (1000..5000, default 3000) is the measured HawkFi 30% rule,
 * SIGNED. R4.2's accounting identity, pinned because the misread is natural: it
 * applies ONCE PER SIDE to that side's HALF, so total deployed is
 * `deployPctBps` of the whole inventory (30% + 30% of two halves is 30% of the
 * total, NOT 60%) and idle is `10000 - deployPctBps` of it.
 *
 * `driftPctOfGap` (25..200, default 60) is 3.18's own drift threshold, with the
 * 3.13 F1 floor inherited VERBATIM (item 16): the threshold is
 * `max(gap x (1 + drift/100), gap + tickSpacing)`, and without the second term a
 * `gapTicks: 0` ladder re-fires its own motion for ever.
 *
 * `maxMovesPerDay` (1..24) bounds ALL ladder motions — fill-response and
 * drift-response alike — in ONE quota lane, because they are the same motion.
 * The 1..24 ceiling is its siblings' (L4) and it is not stylistic: the number
 * multiplies directly into `checkLpNativeCapSizing`'s native reserve.
 *
 * ─── PHASE3.20 D1 — `maxMovesPerDay` IS SPLIT IN TWO, AND BOTH FORMS ARE LEGAL
 *
 * (az) proved the one-lane ruling above wrong ON CHAIN: a discretionary DRIFT
 * move consumed the single slot, and the mandatory FILL settlement then starved
 * for the rest of the window while the worker produced one rolled-back
 * `grid-recenter` row per 30-second cycle. `settlementsPerDay` (1..24, default
 * 8) and `driftMovesPerDay` (0..24, default 4) are therefore two SIGNED numbers
 * over two quota lanes, and a drift can no longer spend a settlement's capacity.
 *
 * EXACTLY ONE FORM IS ACCEPTED (the migration ruling): legacy `maxMovesPerDay`
 * alone, or the new pair alone. Both present ⇒ refused; neither ⇒ refused, so
 * no default is ever invented on the wire. A LEGACY signature is interpreted as
 * `settlementsPerDay = maxMovesPerDay, driftMovesPerDay = 0` — the strictly
 * SAFER reading, since it can never let a drift starve a settlement — which
 * means an existing agent keeps running with drift DISABLED until it re-signs.
 * {@link ladderMotionCounts} is the ONE place that interpretation is written.
 *
 * `maxStrandedMinutes` (D2) is the liveness bound: a rung that has held the
 * WRONG asset for longer than it is re-placed as a settlement regardless of its
 * own cross/drift counters. Its default and its floor are COMPUTED against
 * `minMinutesBetweenExits` by {@link ladderStrandedMinutes} — a literal 45 is
 * BELOW its own floor at the plane's default spacing of 30 (clearance N4).
 * ABSENT ⇒ the computed default, NEVER disabled: deliberately the opposite of
 * `driftMovesPerDay`'s fail-to-zero, because a liveness guarantee an old
 * signature silently opts out of is not a guarantee, while a discretionary
 * motion an old signature never authorized must not start on its own.
 */
export type LpGridLadder = {
  readonly gapTicks: number;
  readonly widthTicks: number;
  readonly deployPctBps: number;
  readonly driftPctOfGap: number;
  /**
   * LEGAL-DEPRECATED (PHASE3.20). Retained so every 3.19 signature keeps
   * running unchanged; read ONLY by {@link ladderMotionCounts}, by the
   * validator and by the canonical-params view.
   */
  readonly maxMovesPerDay?: number;
  /** PHASE3.20 D1 — the FILL-response lane's own bound (1..24). */
  readonly settlementsPerDay?: number;
  /** PHASE3.20 D1 — the DISCRETIONARY re-anchor lane's own bound (0..24). */
  readonly driftMovesPerDay?: number;
  /** PHASE3.20 D2 — the stranding bound, in minutes. Absent ⇒ computed default. */
  readonly maxStrandedMinutes?: number;
  readonly hedge: LpGridLadderHedge;
};

/**
 * PHASE3.22 R1 / R5.8 — THE ATOMIC LADDER's signed geometry and motion policy.
 *
 * `gapTicks`/`widthTicks` are the same two quantities {@link LpGridLadder} and
 * {@link LpGridPolicy} carry, in their own block for the identical C17 reason:
 * under shift mode neither of those blocks exists, so a target derivation that
 * reached for one would read `undefined`. The client defaults `widthTicks` to
 * exactly ONE tick spacing — the single-bin finding of the 40 h census (§1b),
 * where every observed placement carried exactly one bin id.
 *
 * `deployPctBps` (1000..5000, default 3000) is the ladder's field verbatim,
 * including its accounting identity: it applies ONCE PER SIDE to that side's
 * half, so total deployed is `deployPctBps` of the whole inventory and idle is
 * `10000 - deployPctBps` of it.
 *
 * `driftPctOfGap` (25..200, default 60) is 3.18's own drift threshold with the
 * 3.13 F1 floor inherited VERBATIM through `gridDriftReading`: the threshold is
 * `max(gap x (1 + drift/100), gap + tickSpacing)`. The second term is
 * load-bearing here for the M8 reason — a shift-mode ladder CHASES, so without
 * it a `gapTicks: 0` grid re-fires its own motion for ever.
 *
 * ─── `shiftsPerDay`: ONE LANE, AND NO POLICY CAP (decision 8 / R5.8) ─────────
 *
 * Fill settlement and drift re-anchor are THE SAME MOTION in shift mode, so the
 * mandatory/discretionary distinction (az) exploited does not exist to be
 * starved — which is the point of the phase, not an omission. One lane,
 * `shiftsPerDay`.
 *
 * Operator decision 8 removed R3.4's `1..24` POLICY cap: fees are the user's
 * choice. The two remaining bounds are TECHNICAL — the reachability conjunct
 * `1 + shiftsPerDay <= floor(1440/minMinutesBetweenExits)` (the `1 +` is the
 * arm's own lane) and a hard sanity ceiling of 288, which is not invented but
 * IMPLIED: `minMinutesBetweenExits` is validated `5..1440`, so
 * `floor(1440/mm) <= 288` always. Default 8; the client prints `minBudgetWei`
 * at the SIGNED cadence before the signature, which is the real bound an owner
 * feels (R5.8's named transcript line).
 *
 * No hedge sub-block (decision 2). PHASE3.25 R2.6/R5.1 adds one optional,
 * signed budget/price pair for the independent drift allowance; absence keeps
 * every pre-3.25 signature byte-identical and means zero drift motions.
 */
export type LpGridShift = {
  readonly gapTicks: number;
  readonly widthTicks: number;
  readonly deployPctBps: number;
  readonly driftPctOfGap: number;
  readonly shiftsPerDay: number;
  readonly driftGasBudgetWei?: bigint;
  readonly driftPerMotionWei?: bigint;
};

/** PHASE3.22 R1 — the shift ladder's default deployment fraction, per side. */
export const DEFAULT_GRID_SHIFT_DEPLOY_PCT_BPS = 3_000;

/** PHASE3.22 R1 — the shift ladder's default drift threshold, 3.18's own number. */
export const DEFAULT_GRID_SHIFT_DRIFT_PCT = 60;

/**
 * PHASE3.22 R3.4 — the default cadence. Eight motions a day puts the capital
 * floor at ~1.333 BNB at the tightest client geometry, against the default
 * ladder's 6.0 (R4.5 L1).
 */
export const DEFAULT_GRID_SHIFT_SHIFTS_PER_DAY = 8;

/**
 * PHASE3.22 R5.8 — the hard SANITY ceiling on `shiftsPerDay`, not a policy cap.
 *
 * `minMinutesBetweenExits` is validated `5..1440`, so the reachability conjunct
 * can never admit more than `floor(1440/5) = 288` sequences a day in any lane.
 * Stating it explicitly costs nothing and keeps a hand-built object from
 * carrying a number no spacing gate could ever pass (decision 8's own framing:
 * technical bounds only).
 */
export const MAX_GRID_SHIFT_SHIFTS_PER_DAY = 288;

/** PHASE3.25 R2.2 — a sanity ceiling, not a policy cap. */
export const MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI = 1_000_000_000_000_000_000n;

/** PHASE3.20 D1 — the SETTLEMENT lane's default daily bound. */
export const DEFAULT_GRID_LADDER_SETTLEMENTS_PER_DAY = 8;

/** PHASE3.20 D1 — the DRIFT lane's default daily bound. */
export const DEFAULT_GRID_LADDER_DRIFT_MOVES_PER_DAY = 4;

/** PHASE3.20 D2 — the stranding bound's nominal default, before its floor. */
export const DEFAULT_GRID_LADDER_MAX_STRANDED_MINUTES = 45;

/** PHASE3.20 D2 — the stranding bound's nominal ceiling, before its floor. */
export const MAX_GRID_LADDER_STRANDED_MINUTES = 240;

/**
 * PHASE3.20 C10 (clearance N8) — THE ONE NORMALIZER for the two motion counts.
 *
 * Six seams need the pair — `gridCycleSubmissions`, `checkLpNativeCapSizing`,
 * {@link assertGridLanesReachable}, the worker's `LpExitQuota`, the store's
 * `quotaLimitFor` and the client's transcript — and six restatements of one
 * legacy interpretation is exactly the 3.13 F12 cannot-diverge hazard that
 * produced `gridLadderEconomics` and {@link ladderMinMarkoutBps}.
 *
 * IT IS THE ONLY READER OF `maxMovesPerDay` outside the validator and
 * `gridSettingsParamsView`. The legacy reading is
 * `{settlementsPerDay: maxMovesPerDay, driftMovesPerDay: 0}`; a block carrying
 * NEITHER form is refused at validation, so the `?? 0` tail here is a
 * fail-closed backstop for a hand-built object, never a default on the wire.
 */
export function ladderMotionCounts(ladder: LpGridLadder): {
  readonly settlementsPerDay: number;
  readonly driftMovesPerDay: number;
} {
  if (ladder.settlementsPerDay !== undefined || ladder.driftMovesPerDay !== undefined) {
    return {
      settlementsPerDay: ladder.settlementsPerDay ?? 0,
      driftMovesPerDay: ladder.driftMovesPerDay ?? 0,
    };
  }
  return {
    settlementsPerDay: ladder.maxMovesPerDay ?? 0,
    driftMovesPerDay: 0,
  };
}

/**
 * PHASE3.20 C11 (clearance N4) — THE STRANDING BOUND'S DEFAULT, FLOOR AND
 * CEILING, DERIVED IN ONE FUNCTION.
 *
 * The first review specified `max(5, 2 x minMinutesBetweenExits)..240, default
 * 45`, and the clearance proved that self-refuting: `DEFAULT_LP_SETTINGS`
 * carries `minMinutesBetweenExits: 30`, so the floor is 60 and the default 45
 * is BELOW its own floor; and above 120 the range is EMPTY, which would retire
 * ladder mode for a spacing an owner can legally sign today.
 *
 * The floor is `2 x minMinutesBetweenExits` because a bound that fires inside
 * the spacing gate fires into a gate it cannot pass — the 3.13 F1 shape. The
 * default and the ceiling are both lifted by the same term so the interval is
 * never empty and the default is never below the floor.
 *
 * ONE function, three readers — the validator, the client transcript and the
 * owner view — for the 3.13 F12 reason.
 */
export function ladderStrandedMinutes(
  ladder: LpGridLadder,
  minMinutesBetweenExits: number,
): {
  readonly value: number;
  readonly floor: number;
  readonly ceiling: number;
  readonly defaultValue: number;
} {
  const floor = Math.max(5, 2 * minMinutesBetweenExits);
  const defaultValue = Math.max(DEFAULT_GRID_LADDER_MAX_STRANDED_MINUTES, floor);
  const ceiling = Math.max(MAX_GRID_LADDER_STRANDED_MINUTES, floor);
  return {
    value: ladder.maxStrandedMinutes ?? defaultValue,
    floor,
    ceiling,
    defaultValue,
  };
}

/** PHASE3.19 — the signed default deployment fraction, per side. */
export const DEFAULT_GRID_LADDER_DEPLOY_PCT_BPS = 3_000;

/** PHASE3.19 — the ladder's default drift threshold, 3.18's own number. */
export const DEFAULT_GRID_LADDER_DRIFT_PCT = 60;

/** PHASE3.19 — the default per-hedge cap, as a fraction of one side's size. */
export const DEFAULT_GRID_LADDER_MAX_HEDGE_PCT_BPS = 5_000;

/**
 * PHASE3.19 item 26 (OQ4's ruling) — the EFFECTIVE markout floor, in ONE place.
 *
 * The hedge's SUBMISSION cost belongs in the cycle floor (`gridCycleSubmissions`
 * / `gridLadderEconomics`); its EXECUTION cost — the pool fee plus the slippage
 * haircut the saga's own floor takes — belongs HERE, because it is the thing
 * that decides whether unwinding is profitable at all. At a fee-2500 pool with a
 * 50 bps saga slippage rail that is 75 bps, fifteen times the `5` the spec body
 * proposed.
 *
 * `poolFee` is in MILLIONTHS as the pool reports it (2_500 ⇒ 25 bps), the same
 * conversion `gridDualSellSizeWei` makes.
 *
 * ONE function, three readers — the markout gate, the route's refusal and the
 * client's transcript — so a signed number below the floor cannot make the gate
 * looser than the refusal claimed (the 3.13 F12 cannot-diverge rule).
 */
export function ladderMinMarkoutBps(input: {
  readonly poolFee: number;
  readonly maxSagaSlippageBps: number;
  readonly signedMinMarkoutBps: number;
}): number {
  const floor = Math.floor(input.poolFee / 100) + input.maxSagaSlippageBps;
  return Math.max(floor, input.signedMinMarkoutBps);
}

/**
 * PHASE3.18 R2.1 — the signed rung geometry, in the pool's own tick units.
 *
 * `gapTicks` is the clearance between the price anchor and a rung's NEAR edge;
 * `widthTicks` is the rung's own corridor. Both are spacing multiples (the
 * derivation refuses otherwise), and both are what
 * {@link LpGridSettings.buyRange} and its siblings were derived FROM at signing
 * time.
 */
export type LpGridPolicy = {
  readonly gapTicks: number;
  readonly widthTicks: number;
};

/**
 * PHASE3.18 — when to re-centre, and how often at most.
 *
 * `driftPctOfGap` (25..200, default 60): re-centre when the level's NEAR EDGE
 * is farther from the tick than `gap x (1 + driftPctOfGap/100)`. The default is
 * the survey's own measured motion — a competitor's observed ~0.69% drift per
 * cycle against a 96 bps gap is ~72% of gap, and 60% reproduces the ~7
 * re-centres per 8 h their engine actually performs (Addendum 3; their own
 * 1.44% threshold never fired at all, which is why the default sits well below
 * it).
 *
 * `maxRequotesPerDay` (1..24, default 21 = 7 per 8 h) bounds the spend. Its own
 * quota lane, never the flip lane (ruling Q6, on SAFETY grounds: a flip settles
 * a fill that already happened, a requote is discretionary, and a shared lane
 * lets re-centres starve settlements). `validateLpSettings` additionally
 * refuses a pair the spacing gate makes unreachable
 * (`maxFlipsPerDay + maxRequotesPerDay <= floor(1440/minMinutesBetweenExits)`).
 */
export type LpGridRequote = {
  readonly driftPctOfGap: number;
  readonly maxRequotesPerDay: number;
};

/** PHASE3.18 — the requote's default drift threshold, in percent of the gap. */
export const DEFAULT_GRID_REQUOTE_DRIFT_PCT = 60;

/** PHASE3.18 R2.11 — 7 re-centres per 8 h, the measured motion. Bounded 1..24. */
export const DEFAULT_GRID_MAX_REQUOTES_PER_DAY = 21;

/** PHASE3.18 R2.2 — the mode a grid block with no `mode` key means. */
export function gridModeOf(grid: LpGridSettings): LpGridMode {
  return grid.mode ?? "fixed";
}

/**
 * Owner-signed automation settings — the PHASE3 spec settings table plus
 * `minAprBps` (Rev2 item 39). `validateLpSettings` enforces every range.
 */
export type LpAutomationSettings = {
  readonly autoRotate: boolean;
  readonly autoHarvest: boolean;
  /** 0..5000. Deviation from the breached bound required before a rotate. */
  readonly rotateBandBps: number;
  /** >= 0 minutes since the breach BEGAN before a rotate may fire. */
  readonly rotateMinHoldMinutes: number;
  /** > 0, wei. Default 0.002 BNB (delta from 0G, see module header). */
  readonly harvestMinFeesWei: bigint;
  /** 0 = off, else 1..90 (percent below lineage basis). */
  readonly stopLossPct: number;
  /** 0 = off, else 1..500 (percent above lineage basis). */
  readonly takeProfitPct: number;
  /**
   * PHASE3.6. A price threshold that protects independently of the basis —
   * `null` when off, which is the default and makes this phase inert.
   *
   * It is NOT a replacement for `stopLossPct`: value-versus-basis is the right
   * instrument for a volatile/volatile pair and stays unchanged. It is the
   * instrument an owner reasoning in TOKEN PRICE actually wanted, and its
   * absence is why FINDINGS (ao) gap 2 put a stop on the wrong side of the
   * market.
   */
  readonly priceStopLoss: LpPriceTrigger | null;
  readonly priceTakeProfit: LpPriceTrigger | null;
  /** 1..24. Enforced by the sequence journal, NOT here (quota-agnostic evaluator). */
  readonly maxExitSequencesPerDay: number;
  /** 5..1440. Enforced by the sequence journal, NOT here. */
  readonly minMinutesBetweenExits: number;
  /** Default false — deterministic-only automation. */
  readonly brainEnabled: boolean;
  /** Present only when the owner signed the brain block. */
  readonly brain?: LpBrainSettings;
  /** MUST be false in v1; true is refused (reserved for the CAKE phase). */
  readonly stakingEnabled: boolean;
  /** MUST be "compound" in v1; "accumulate" is refused (upgrade seam). */
  readonly accumulateMode: "compound" | "accumulate";
  /** 0..1_000_000, default 0 = off. At-open APR floor (Rev2 item 39). */
  readonly minAprBps: number;
  /**
   * PHASE3.1 Rev2 item 5. On protect and manual exit, convert the position's
   * NON-quote leg into `position.quoteToken` before the sequence ends —
   * default TRUE, because a stop-loss that hands back the asset it stopped out
   * of has done the mechanical half of its job only (FINDINGS (ag): a live
   * protect returned 0.0305 BNB *and* 0.604 CAKE).
   *
   * `false` reproduces Phase 3 exactly and MUST stay reachable: a forced swap
   * at the moment of a stop is itself a market action an owner may not want.
   *
   * NAMED `exitToQuote`, NOT `exitToNative`, and the name is load-bearing
   * (Rev2 item 5): settings params are stored VERBATIM as the owner signed
   * them and `rejectUnknownKeys` refuses any key it does not know, so renaming
   * a signed key later makes every stored row unparseable — which turns the
   * worker's `loadPositionContext` into a silent per-cycle skip and disarms
   * automation with a reasonable-looking log line. That is FINDINGS (ae)'s
   * failure mode produced by a rename.
   */
  readonly exitToQuote: boolean;
  /**
   * PHASE3.13. How a triggered rotate re-ranges the freed principal.
   *
   * `"swapped"` (the DEFAULT, and Phase 3's behaviour byte for byte) balances
   * the freed legs with a sweep swap and re-mints CENTERED on the price.
   * `"swapless"` skips that swap and parks the prior width STRICTLY beside the
   * price on the side the principal is already on — HawkFi's swapless
   * rebalance, expressed in V3 terms. It saves one submission, one pool fee and
   * that leg's slippage.
   *
   * It CHANGES EXPOSURE, which is why it is owner-signed and why it defaults to
   * today's behaviour: the position earns nothing until the price comes back,
   * `autoHarvest` is inert for it while parked (Phase 3.12 G1 gates a harvest
   * whenever the split would be total, and a parked range never contains the
   * tick), and up to `SWAPLESS_MAX_RESIDUE_BPS` of the freed value is left in
   * the WALLET rather than re-deposited.
   *
   * Additive, exactly like `exitToQuote`: a stored row that predates this phase
   * carries no such key and parses to `"swapped"`.
   */
  readonly rotateMode: LpRotateMode;
  /**
   * PHASE3.15. The two-range grid ping-pong, or `null` when this agent is not a
   * grid agent — the DEFAULT, and what makes this phase inert for every
   * existing agent.
   *
   * ITS PRESENCE SWITCHES THE WORKER'S EVALUATION for this agent (R2.6): a grid
   * agent is evaluated by `evaluateGridTriggers`, never by
   * {@link evaluateLpTriggers}, because a standard rotate would re-range the
   * grid position and destroy the strategy. That is why the standard automation
   * flags are refused ALONGSIDE it rather than ignored — nobody signs a
   * contradiction.
   *
   * Additive in the same ONE-WAY sense as `priceStopLoss`/`rotateMode`: a stored
   * row that omits the key parses to `null`, but a build that does not KNOW the
   * key fails `parseLpSettingsParams` on the WHOLE row of any owner who signed
   * it. Rollback procedure: clear the grid block with an owner-signed re-sign
   * FIRST (which drops the key from the view, because it is only emitted when
   * set), then roll back.
   */
  readonly grid: LpGridSettings | null;
};

export type LpBrainSettings = {
  readonly primaryModel: TradeLlmModelId;
  readonly fallbackModel: TradeLlmModelId;
  readonly instructions: string | null;
  readonly skillMarkdown: string | null;
};

/** PHASE3.13. The owner-signed rotate shape; see {@link LpAutomationSettings.rotateMode}. */
export type LpRotateMode = "swapped" | "swapless";

/** 0.002 BNB in wei — the re-based harvest floor default (Rev2 item 25). */
export const DEFAULT_HARVEST_MIN_FEES_WEI = 2_000_000_000_000_000n;

export const DEFAULT_LP_SETTINGS: LpAutomationSettings = {
  autoRotate: false,
  autoHarvest: false,
  rotateBandBps: 0,
  rotateMinHoldMinutes: 0,
  harvestMinFeesWei: DEFAULT_HARVEST_MIN_FEES_WEI,
  stopLossPct: 0,
  takeProfitPct: 0,
  // PHASE3.6: off by default, which is what makes this phase inert for every
  // existing agent. Rev2 M5 is why these must not be EMITTED when null —
  // `canonicalEncode` drops absent keys but encodes present ones, so a
  // `priceStopLoss: null` on the wire would move `DEFAULT_SETTINGS_DIGEST` and
  // refuse every in-flight sequence of every agent with no stored row.
  priceStopLoss: null,
  priceTakeProfit: null,
  maxExitSequencesPerDay: 4,
  minMinutesBetweenExits: 30,
  brainEnabled: false,
  stakingEnabled: false,
  accumulateMode: "compound",
  minAprBps: 0,
  // PHASE3.1 Rev2 item 7: the DEFAULT is the CORRECTED behaviour. A stored row
  // that predates this phase carries no such key, so it parses to `true` — an
  // owner who wants the old behaviour says so, because the old behaviour is
  // the defect.
  exitToQuote: true,
  // PHASE3.13: today's behaviour is the default, because swapless CHANGES
  // EXPOSURE. Unlike `exitToQuote`, the pre-key behaviour here is not a defect
  // — it is the strategy every existing owner signed up for — so the migration
  // direction is the opposite one and the default must never move.
  rotateMode: "swapped",
  // PHASE3.15: absent by default, and the key is emitted from
  // `lpSettingsParamsView` ONLY when set — the M4/M5 asymmetry, for the third
  // time. `DEFAULT_SETTINGS_DIGEST` must not move (R2.12), and
  // `test/lp.rotateMode.test.ts`'s literal is the tripwire that says so.
  grid: null,
};

/**
 * Confirmation state carried BETWEEN evaluations by the caller. The
 * 2-consecutive-finalized-observations rules key off it; it is only
 * comparable when it names the same tokenId + pool, is strictly older by
 * BLOCK, at least one interval older by clock, and NOT older than
 * {@link lpMaxObservationAgeMs} (PHASE3.2 Rev2 item 18).
 *
 * PHASE3.2 made it DURABLE (`src/store/lpObservations.ts`). Everything in it
 * is flat and serializable — no handle, no promise, no client — so it persists
 * as it stands.
 */
export type LpTriggerObservation = {
  readonly fees?: import("./feeTelemetry.js").LpFeesTelemetry;
  readonly blockNumber: bigint;
  readonly evaluatedAtMs: number;
  readonly poolAddress: `0x${string}`;
  /** Read-only portfolio mark produced by the worker's canonical valuation. */
  readonly valuation?: {
    readonly method: "sellable-exit-v1";
    readonly exitValueWei: bigint;
    readonly quoteToken: `0x${string}`;
    readonly tokenId: string;
    readonly positionRowVersion: number;
    readonly blockNumber: bigint;
    readonly valuedAtMs: number;
  };
  /**
   * The tick this observation was taken at (PHASE3.6 Rev2 M1). OPTIONAL, so a
   * row written before this phase still parses.
   *
   * It exists so the READ ROUTE can report how far a price trigger is from
   * firing without a chain call — reported as of `evaluatedAtMs`, never as
   * "now", and the view already carries the age that makes that honest.
   */
  readonly currentTick?: number;
  /** Optional so rows written before R4.1 still parse. */
  readonly tickLower?: number;
  readonly tickUpper?: number;
  /**
   * PHASE3.6 widens this from two kinds to four. See {@link breachClassOf} for
   * why the CONFIRMATION compares the class instead.
   */
  readonly protectBreach?:
    | "stop-loss"
    | "take-profit"
    | "price-stop-loss"
    | "price-take-profit";
  /**
   * The class of {@link protectBreach} (Rev2 M7). OPTIONAL so an older row
   * parses; when absent the count restarts, which is the fail-safe direction.
   */
  readonly protectBreachClass?: "stop" | "take-profit";
  /**
   * The settings digest this observation was earned under (AUDIT A7).
   * OPTIONAL, so a pre-existing row parses — and an ABSENT one is treated as
   * NOT comparable, which costs every building count one cycle at the upgrade
   * and is the fail-safe direction.
   *
   * Why it must be here: nothing invalidates a stored observation when the
   * owner re-signs their settings, and `previousIsComparable` compares tokenId,
   * pool, block, clock gap and staleness — never the settings the count was
   * earned under. So a count built under one instrument could be INHERITED by a
   * newly-signed one, and a price trigger observed exactly ONCE could dispatch.
   * The "two consecutive finalized observations" contract is the transient-wick
   * filter this whole subsystem rests on; it must not be satisfiable by two
   * observations of different things. (The same hole predates PHASE3.6 for
   * `stopLossPct`: moving the threshold under a building count inherited it.)
   */
  readonly settingsDigest?: string;
  readonly protectConsecutive: number;
  readonly rotationBreach: boolean;
  readonly rotationBreachStartedAtMs?: number;
  readonly rotationConsecutive: number;
  /**
   * PHASE3.15 (M1). The grid's cross hysteresis, DURABLE for the same reason
   * `protectConsecutive` is: FINDINGS (ae) is what a confirmation counter in
   * process memory costs, and a grid flip is the agent's core loop.
   *
   * NOT COLUMNS. `lp_observations` has six columns and the observation rides in
   * the `observation` jsonb; the module's own header records why typed numeric
   * columns were REJECTED (a SQL NULL read through a copy of `toWei` becomes
   * `0n`, and `0n < market.blockNumber` is trivially true — a fail-OPEN
   * comparability). The spec's "exactly parallel to protectConsecutive"
   * therefore points at jsonb, not at DDL.
   *
   * THE TRAP THAT COMES WITH THE jsonb PATH, and it is the reason these two
   * fields and `parseLpTriggerObservation` land in ONE change:
   * `parseLpTriggerObservation` rebuilds field by field and returns only the
   * fields it knows, so a field written into the jsonb but not added there is
   * silently dropped on read — the count restarts every cycle and the grid can
   * NEVER confirm a fill. That is (ae) in a brand-new trigger.
   *
   * Absent ⇒ the count restarts, which is the fail-safe direction.
   */
  readonly gridCrossConsecutive?: number;
  /**
   * The side the live range charged at the observation that produced the count,
   * in POOL ORDER (`swaplessRotationSide`'s own vocabulary) — never a role name
   * like "buy"/"sell", because a role-named side inverts for half of BSC's
   * pools (the 3.13 F7 lesson). A CLOSED SET: an unrecognised value rejects the
   * whole observation, which reads as "no previous observation" and restarts
   * the count.
   */
  readonly gridCrossSide?: "above" | "below";
  /**
   * PHASE3.18 R2.8 — the REQUOTE's OWN durable hysteresis counter, and its own
   * side.
   *
   * REUSING `gridCrossConsecutive` WAS REFUSED, for two independent reasons the
   * ruling names: the store validator pins `gridCrossSide` to a closed
   * two-member vocabulary observation-wide, and — decisively — the two counters
   * must reset INDEPENDENTLY. A cross and a drift are different evidence about
   * different events; one counter would let each erase the other's anti-wick
   * history, which is precisely the guarantee the two-consecutive discipline
   * exists to give.
   *
   * `gridDriftSide` is the side the LIVE range presented at the observation
   * that produced the count, in POOL ORDER for the 3.13 F7 reason. A reversal —
   * the price coming back toward the rung, or crossing to the other side —
   * resets the count to zero.
   *
   * Additive optional fields validated in `parseLpTriggerObservation` IN THE
   * SAME COMMIT: the (ae) trap the `gridCrossConsecutive` docstring above
   * warns about, one trigger further on.
   */
  readonly gridDriftConsecutive?: number;
  readonly gridDriftSide?: "above" | "below";
  /**
   * PHASE3.23 R2.3 / R3.6 — the shift rung's range relation at this
   * observation. Optional because every pre-3.23 row, and every non-shift
   * evaluator, has no such evidence; consumers must read absence as
   * `"unknown"`, never infer it from the absent cross side (FINDINGS (be)).
   */
  readonly gridRangeRelation?: "inside" | "outside";
  /**
   * PHASE3.20 items 12/13 (OQ2's ruling, amended by R3.4/C7) — THE STRANDING
   * CLOCK: the wall-clock millisecond at which this ladder rung was FIRST
   * observed holding the asset its `gridRole` does not charge.
   *
   * A LIVENESS clock, not anti-wick evidence, and the two asymmetries that
   * follow from that are the whole of this field:
   *
   *  1. IT IS CARRIED FORWARD UNCONDITIONALLY — independent of
   *     `previousIsComparable`, `settingsUnchanged` and `previousIsStale`. The
   *     cross/drift counters above deliberately reset on all three, because a
   *     count earned under other settings is not evidence about these ones. A
   *     liveness clock has the OPPOSITE requirement: an owner re-signing every
   *     40 minutes would otherwise postpone the bound for ever, and a worker
   *     outage would restart it (review H2).
   *  2. IT IS NOT CLEARED BY AN IN-RANGE TICK. `gridCrossReading` answers
   *     `{side: undefined, filled: false}` whenever the tick sits inside the
   *     live range, so "clear when the current reading is not mismatched" would
   *     reset the clock on every chop — and a chop is the market the bound
   *     exists for (clearance N6). The rule is THREE-WAY: SET when mismatched
   *     and unset, CLEAR only on `side !== undefined && filled === false`,
   *     CARRY FORWARD UNCHANGED when `side === undefined`.
   *
   * DECLARED (clearance N14 / R4.4): `parseLpTriggerObservation` is fail-closed
   * OBSERVATION-WIDE, so a row it rejects reads as "no previous observation" and
   * silently RESTARTS this clock — safe for an anti-wick counter, unsafe here,
   * and unfixable without breaking the (ae) discipline. That is why this field's
   * validation is the LOOSEST sound one (a finite number >= 0, exactly
   * `rotationBreachStartedAtMs`'s): it must never itself be the reason a whole
   * observation is discarded.
   */
  readonly gridMismatchSinceMs?: number;
  readonly tokenId: string;
};

export type EvaluateLpTriggersInput = {
  /**
   * The digest of the settings this evaluation runs under (AUDIT A7). Absent
   * disables the check — which is what every existing test does, and which is
   * exactly the pre-PHASE3.6 behaviour.
   */
  readonly settingsDigest?: string;
  readonly intervalMs: number;
  readonly market: LpRailEvidence;
  readonly nowMs: number;
  readonly position: LpTriggerPositionInput;
  readonly previousObservation?: LpTriggerObservation;
  readonly rails: LpRailConfig;
  readonly settings: LpAutomationSettings;
  /**
   * Operator override for the staleness bound, LOWER-ONLY (PHASE3.2 Rev2 item
   * 22). Absent ⇒ the derived bound. Present ⇒ clamped DOWN to it here as
   * well as refused above it at boot, so no caller can widen the anti-wick
   * rule by handing this evaluator a bigger number.
   */
  readonly maxObservationAgeMs?: number;
};

/* -------------------------------------------------------------------------- */
/* The staleness bound (PHASE3.2 Rev2 items 18/21/22)                         */
/* -------------------------------------------------------------------------- */

/** The floor of the derived bound. Load-bearing — see {@link lpMaxObservationAgeMs}. */
export const LP_MIN_OBSERVATION_AGE_MS = 300_000;
/** The ceiling. `3 × LP_WORKER_MAX_INTERVAL_MS` — stated so nobody widens it by accident. */
export const LP_MAX_OBSERVATION_AGE_CEILING_MS = 1_800_000;

/**
 * How old a persisted observation may be and still count as the FIRST of two
 * consecutive evaluations: `min(max(3 × intervalMs, 5 min), 30 min)`.
 *
 * Persistence introduces a hazard memory never had — an observation from hours
 * ago being treated as the first of two, letting a protect fire on ONE fresh
 * look at the market. This bounds it. It is derived from the interval rather
 * than being a fresh knob so that lengthening the interval does not silently
 * invalidate every observation.
 *
 * THE 5-MINUTE FLOOR IS LOAD-BEARING, in two independent ways:
 *   - a pure `3 × intervalMs` (180 000 ms at the 60 s default) would discard
 *     the 240 000 ms-old observation `test/lp.triggers.test.ts` feeds, turning
 *     an existing `rotate` into a `hold`;
 *   - it would break this phase's OWN runbook: a human who takes four minutes
 *     between two `--once` commands would silently restart the count and see
 *     the very "awaits a second finalized evaluation" line that motivated the
 *     phase — (ae) reproduced by the fix for (ae).
 *
 * `overrideMs` is the operator's LOWER-ONLY override (`LP_MAX_OBSERVATION_AGE_MS`).
 * Raising the bound weakens the anti-wick rule; lowering it costs at most one
 * confirmation cycle, so the clamp only ever goes down.
 *
 * TWO CONSEQUENCES, stated rather than discovered (PHASE3.2 Rev2 items 24/25):
 *   - the confirmation compares `previousObservation?.protectBreach ===
 *     protectBreach`, so two UNRELATED breaches with a full recovery between
 *     them confirm as ONE. This bound is the ONLY thing limiting that window,
 *     which is why it is a safety constant and not a convenience knob;
 *   - `rotationBreachStartedAtMs` now carries across a process gap, so
 *     `rotateMinHoldMinutes` can be satisfied from a breach that began before
 *     an interval in which nothing was observed. That WIDENS a churn control
 *     (rotate costs money and quota) deliberately, bounded by this same value.
 */
export function lpMaxObservationAgeMs(
  intervalMs: number,
  overrideMs?: number,
): number {
  const derived = Math.min(
    Math.max(3 * intervalMs, LP_MIN_OBSERVATION_AGE_MS),
    LP_MAX_OBSERVATION_AGE_CEILING_MS,
  );
  if (overrideMs === undefined) return derived;
  if (!Number.isFinite(overrideMs) || overrideMs <= 0) return derived;
  return Math.min(derived, Math.floor(overrideMs));
}

/**
 * The hold reason a discarded-because-stale observation produces. Exported so
 * the worker can log it without re-deriving the rule that produced it.
 */
export const LP_STALE_OBSERVATION_HOLD_REASON =
  "The previous observation is older than the maximum comparable age; the confirmation count restarted.";

/* -------------------------------------------------------------------------- */
/* "Is protection armed?" — ONE definition (PHASE3.2 Rev2 items 26/27)        */
/* -------------------------------------------------------------------------- */

/**
 * The four DISARM reasons, as message constants, because they are shared
 * verbatim between the worker's skip path and the owner-facing read side. Two
 * of them are exactly what the worker skips a position for today, silently,
 * every cycle — the PHASE3.1-REVIEW R5 path that nothing an owner can query
 * reports.
 */
export const LP_DIGEST_UNVERIFIED_REASON =
  "Stored LP settings digest does not recompute from the stored params; skipping this position rather than automating under unverified settings.";

export function lpSettingsUnreadableReason(detail: string): string {
  return `Stored LP settings are unreadable (${detail}); skipping rather than defaulting over signed settings.`;
}

export const LP_NO_TOKEN_ID_REASON =
  "The position has no recorded tokenId and no in-flight open to resume.";

export const LP_BASIS_ZERO_HOLD_REASON =
  "Protect excluded because the lineage basis is zero.";

/**
 * PHASE3.12 (R-E, F9/F11): the ONE sentence the harvest range gate refuses
 * with, at BOTH seams — the trigger's `holdReason` (so the owner view and the
 * worker log say the same thing) and the saga's build-time refusal (so an
 * operator-driven `live-lp harvest` that loses the race gets the same
 * explanation rather than a bare throw).
 *
 * A FUNCTION rather than a bare constant because the review's Q1 requires the
 * remedy to be conditional on the owner's OWN `autoRotate` — telling an owner
 * who already has rotation on to "turn rotation on" is the kind of remedy that
 * teaches people to ignore the product. `lpSettingsUnreadableReason` above is
 * the precedent for a parameterised reason in this block.
 *
 * `autoRotate` is REQUIRED, and PHASE3.13 F12 is why it changed. Part 1 left it
 * optional with a both-branches arm because `LpSagaDeps` carried no
 * `autoRotate` and plumbing one touched three wiring sites — and the Part 1
 * audit's Ruling 1 said in writing that when Part 2 plumbed its own required
 * saga dep, `autoRotate` should ride along and the arm should retire. It has:
 * `LpSagaDeps.autoRotate` is now required at all three sites, so the arm was
 * dead defensive code on an always-supplied value.
 *
 * Figures ARE included on purpose. LP routes are owner-signed (`ownerMutation`
 * on every one), so the PHASE2.5 rule that a `/trade` refusal carries no
 * figures — which exists because `/trade` takes the SHARED exec token — does
 * not apply here, and a refusal that will not say which tick or which range
 * cannot be acted on.
 */
export function lpHarvestRangeHoldReason(input: {
  readonly currentTick: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly autoRotate: boolean;
}): string {
  const remedy = input.autoRotate
    ? "The rotate is the action here and will run once its confirmations are in."
    : "Turn on rotation (`live-lp settings --auto-rotate`) to re-range it, or exit it.";
  // ELEMENT ORDER CHANGED BY PHASE3.13 F12-b, and it is a truncation fix, not a
  // wording preference. Part 1 built this sentence at ~450 characters with the
  // remedy LAST — and the saga seam passes it through `sanitizeMessage`, which
  // truncates at `MAX_MESSAGE_LENGTH` (280). Measured: the remedy, and most of
  // the single-sided explanation, never reached an operator reading a `live-lp
  // harvest` refusal at all. Making that remedy CONDITIONAL (F12's whole
  // purpose) would have been invisible where it is read.
  //
  // Q1's four elements are unchanged and every substring Part 1 pinned is still
  // here; only their order moved, so that the three an owner must ACT on — out
  // of range with figures, the fees are not lost, and what to do — survive the
  // ceiling, and the mechanical WHY is the sacrificial tail. The trigger seam
  // is not sanitized and still carries all four in full.
  return `Harvest refused: tick ${input.currentTick} is outside the compoundable interior of [${input.tickLower}, ${input.tickUpper}) (the lower bound counts as outside). The fees are NOT lost — they stay in the position and the next rotate or exit collects them. ${remedy} A compounding increase here could only be single-sided, and the increase refuses single-sided by design.`;
}

/**
 * PHASE3.13 (OQ3, F3, F8): the ONE sentence the swapless rotate speaks with, at
 * BOTH of its seams — the sweep step's recorded SKIP note (`"parked"`, the
 * owner's only in-product explanation for a residue sitting in their wallet)
 * and the mint build's contradiction refusal (`"refused"`).
 *
 * ONE builder, deliberately, and the review is explicit about why: the skip is
 * what the sweep DECIDED and the refusal is the mint DISAGREEING with that same
 * decision, so if the two sentences could drift, the owner would be reading two
 * different accounts of one quantity. Every figure below is common to both.
 *
 * Four elements each, the discipline `lpHarvestRangeHoldReason` set:
 *   parked  — (1) what was derived, from what evidence; (2) that the principal
 *             is being re-ranged on its OWN side with NO conversion made, and
 *             into which range; (3) the residue: how much, where it is, that it
 *             is NOT in the position; (4) the exposure consequence.
 *   refused — (1) what contradicted what; (2) that the principal is SAFE in the
 *             wallet and the sequence is held at `pending-mint`; (3) why minting
 *             anyway would be worse; (4) the remedy, in the owner's vocabulary.
 *
 * Figures included, for `lpHarvestRangeHoldReason`'s reason: LP routes are
 * owner-signed, so PHASE2.5's figureless-refusal rule (which exists for the
 * shared-exec-token `/trade` path) does not apply.
 */
export function lpSwaplessRotateReason(input: {
  readonly outcome: "parked" | "refused";
  readonly currentTick: number;
  readonly priorTickLower: number;
  readonly priorTickUpper: number;
  /** `undefined` means the fresh tick is INSIDE the prior range, i.e. no side. */
  readonly side: "above" | "below" | undefined;
  /** The freed legs in POOL ORDER — never the role-named WBNB/TOKEN pair. */
  readonly amount0: bigint;
  readonly amount1: bigint;
  /** The off-side leg in its own units, and its share of the freed value. */
  readonly residueWei: bigint;
  readonly residueBps: bigint;
  /** The range the swapless mint parks into. Present on `"parked"` only. */
  readonly range?: { readonly tickLower: number; readonly tickUpper: number };
  /**
   * The side the SKIP recorded, when the refusal is a disagreement with it
   * rather than a plain bind failure (F8's "on any disagreement, THROW").
   */
  readonly recordedSide?: "above" | "below";
}): string {
  // ORDERING IS LOAD-BEARING, and it is about a 280-character ceiling rather
  // than about prose. Both surfaces this text reaches — `recordSkip`'s sequence
  // note and the driver's hold reason — pass it through `sanitizeMessage`,
  // which TRUNCATES at `MAX_MESSAGE_LENGTH`. So each branch leads with the fact
  // an owner cannot reconstruct from anywhere else (the residue AMOUNT on the
  // skip; the bind that failed on the refusal) and puts the derivable evidence
  // last. At extreme amount magnitudes the tail is what is lost.
  const evidence =
    `tick ${input.currentTick} vs prior [${input.priorTickLower}, ${input.priorTickUpper}), side ${input.side ?? "none"}, freed ${input.amount0}/${input.amount1} pool-ordered`;
  if (input.outcome === "parked") {
    const range = input.range;
    const placement = range === undefined
      ? "the adjacent range"
      : `[${range.tickLower}, ${range.tickUpper})`;
    return `Swapless rotate: residue ${input.residueWei} wei (${input.residueBps} bps) stays in the WALLET, unconverted and outside the position. Principal re-ranged ${input.side ?? "none"} the price into ${placement}, NO conversion made. Parked beside the price: no fees, auto-harvest inert, until price returns. Evidence: ${evidence}.`;
  }
  const disagreement = input.recordedSide === undefined || input.recordedSide === input.side
    ? ""
    : ` (skip recorded ${input.recordedSide})`;
  return `Swapless rotate refused at the mint: the bind needs a side and off-side <=${SWAPLESS_MAX_RESIDUE_BPS} bps; side ${input.side ?? "none"} at ${input.residueBps} bps${disagreement}. Principal SAFE in wallet, held pending-mint. Remedy: owner-signed abandon, or re-sign rotateMode "swapped". A mint now is sized by the dust leg. Evidence: ${evidence}.`;
}

/**
 * PHASE3.13 F1's owner-facing half: why a PARKED swapless position, plainly out
 * of range with `autoRotate` on, is deliberately not re-rotating.
 *
 * Its floor is the position's own width, so the sentence names both figures —
 * an owner who wants the old behaviour back can re-sign
 * `rotateMode: "swapped"`, which is exactly what the remedy says.
 */
export function lpSwaplessParkedHoldReason(input: {
  readonly currentTick: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly deviationBps: bigint;
  readonly floorBps: bigint;
}): string {
  return `Swapless rotate parked: tick ${input.currentTick} is outside range [${input.tickLower}, ${input.tickUpper}) by ${input.deviationBps} bps, which is under the ${input.floorBps} bps this position's own width requires before a parked range is re-rotated. This is the mode working as signed — a swapless rotate parks the principal BESIDE the price on purpose and waits for it to come back, so re-rotating on the deviation it just created would rotate for ever and strand another residue each time. It earns no fees and auto-harvest stays inert while parked. Remedy: wait for re-entry, re-sign settings with rotateMode "swapped" to re-center instead, or exit the position.`;
}

/**
 * The SEVENTH disarm reason (PHASE3.4 Rev2 M6/M7): a finalized `ownerOf` read
 * says the position's NFT is not this wallet's any more.
 *
 * Before import, this state was nearly unreachable — `/lp/open` minted the NFT
 * and only a saga touched it. Import makes owner-held NFTs moving an EXPECTED
 * event, and PHASE3.3-AUDIT A3 is what happens when the worker knows something
 * the owner's dashboard does not: the one surface built to answer "is this
 * stop-loss real?" kept saying yes. Two consecutive confirmed mismatches also
 * CLOSE the row, which is what frees the NFT for its next owner to import.
 */
export const LP_NOT_OWNED_REASON =
  "A finalized ownerOf read says this position's NFT is no longer held by the agent's wallet; automation is suspended and the row closes after a second consecutive confirmation.";

/**
 * PHASE3.6 Rev2 M2. Distinct sentences so none of them claims "nothing to arm"
 * while something is, and so an owner can tell WHICH instrument is live.
 */
export const LP_ARMED_PRICE_ONLY_REASON =
  "A price trigger for this position's pool is configured and this position is being observed; the value-based stop-loss/take-profit is off or has no basis.";

export const LP_ARMED_BOTH_REASON =
  "Both a value-based stop-loss/take-profit and a price trigger for this position's pool are configured, and this position is being observed.";

export const LP_NO_PROTECT_CONFIGURED_REASON =
  "Neither a stop-loss nor a take-profit is configured; there is nothing to arm.";

export const LP_ARMED_REASON =
  "A stop-loss or take-profit is configured and this position is being observed.";

/**
 * The FIFTH disarm reason, added by PHASE3.3 (review R17 / Rev2 item 18).
 *
 * `driveSequence` refuses any saga whose kind differs from the position's one
 * non-terminal sequence (`SEQUENCE_CONFLICT`), so a position carrying a
 * non-terminal `harvest`, `rotate` or `open` sequence CANNOT be protected and
 * cannot be exited — FINDINGS (al) exactly. Until this reason existed the one
 * product surface built to answer "is this position's stop-loss real?" reported
 * `armed: true` about the very position the finding is about.
 *
 * A non-terminal sequence of the SAME kind (`protect`) does not disarm
 * anything — PROVIDED IT CAN STILL ADVANCE. See
 * {@link lpBlockingSequenceCanProgress}.
 */
export function lpBlockedBySequenceReason(kind: string): string {
  return (
    `A non-terminal ${kind} sequence holds this position, so a protect would be ` +
    `refused with SEQUENCE_CONFLICT; the owner must resolve it before the ` +
    `stop-loss can fire.`
  );
}

/**
 * The SIXTH disarm reason (PHASE3.3-AUDIT A3): the blocking sequence is the
 * position's own `protect`, and it is the one that cannot fire.
 *
 * Distinct from {@link lpBlockedBySequenceReason} because the remedy is not
 * "wait for it" and the owner must not be told a kind conflict is in the way:
 * the protect IS the sequence, and it is stuck on a step whose outcome only an
 * owner-signed resolution can settle.
 */
export const LP_STUCK_PROTECT_REASON =
  "This position's own protect sequence is stuck on an UNKNOWN step row, so it " +
  "can never advance and the stop-loss cannot fire; resolve the step " +
  "(POST /agents/:id/journal/:decisionId/resolve) to re-arm it.";

/**
 * The blocking sequence, as the status computation needs it. Structural rather
 * than the store's own record, for the same reason `LpStepOutcomeState` is
 * structural: this module must not depend on the sequence store.
 */
export type LpBlockingSequence = {
  readonly sequenceId: string;
  /** `LpSequenceKind` as a plain string — see above. */
  readonly kind: string;
  /** `LpSequenceState` as a plain string, when the caller knows it. */
  readonly state?: string;
  /**
   * Whether the sequence's MOST RECENTLY RECORDED step is an `UNKNOWN` journal
   * row (PHASE3.3-AUDIT A3). Absent means "the caller did not look", which is
   * treated as "it can still advance" — the pre-A3 reading, kept so the
   * worker's call sites need no change.
   */
  readonly currentStepUnknown?: boolean;
};

/**
 * Whether a blocking sequence can still make progress on its own.
 *
 * PHASE3.3-AUDIT A3, and the whole of the fix. R17 exempted a non-terminal
 * `protect` on the reasoning that "the next cycle resumes it, which is the
 * protect firing". That is true of a protect the driver can ADVANCE and false
 * of one it can only HOLD: `deriveLpSequenceProgress` answers `hold` for a
 * non-terminal current step row, so a protect whose current step is `UNKNOWN`
 * is re-queued and held every cycle, for ever, and with no `callsId` not even
 * `reconcile` can settle it. Keying the exemption on the KIND STRING alone
 * therefore reported `armed: true` for a stop-loss that can never fire — the
 * same lie R17 exists to remove, one family of cases further in.
 *
 * The discriminator is the STEP ROW, not the sequence's `state`. A `held`
 * sequence whose rows are all settled resumes and advances on the next cycle
 * (that is what `held → active` is for, and what PHASE3.1's optional-step
 * retry budget spends), so disarming on `held` alone would be a fresh lie in
 * the opposite direction: reporting a protect that is about to fire as
 * un-armed.
 */
export function lpBlockingSequenceCanProgress(
  sequence: LpBlockingSequence,
): boolean {
  return sequence.currentStepUnknown !== true;
}

export type LpProtectionStatusInput = {
  /** The owner's settings, or `null` when the stored row could not be read. */
  readonly settings: LpAutomationSettings | null;
  /** False ⇒ the stored settings row exists and does not parse. */
  readonly settingsReadable: boolean;
  /** False ⇒ the stored digest does not recompute from the stored params. */
  readonly digestVerified: boolean;
  /** The position LINEAGE basis. Zero excludes protect (see the evaluator). */
  readonly basisWei: bigint;
  /** False ⇒ the position row carries no tokenId; automation refuses it. */
  readonly hasTokenId: boolean;
  readonly observation: LpTriggerObservation | null;
  readonly nowMs: number;
  readonly intervalMs: number;
  readonly maxObservationAgeMs?: number;
  /**
   * The position's ONE non-terminal sequence, or `null`/absent when it has
   * none (PHASE3.3 Rev2 item 18). The caller passes whatever
   * `getNonTerminalSequence` answered; the RULE — that only a sequence of a
   * kind other than `protect` disarms — lives here, so there is one definition
   * of it and not one per call site.
   */
  readonly blockingSequence?: LpBlockingSequence | null;
  /**
   * The worker's DURABLE ownership finding for this position (PHASE3.4 Rev2
   * M6): how many consecutive finalized `ownerOf` reads said the NFT is not
   * this wallet's, and why.
   *
   * Passed from the position ROW, never from a chain read — `GET /agents/:id/lp`
   * makes none and must not start. Any nonzero count disarms: one confirmed
   * mismatch is not enough to CLOSE a position (that needs two, M7) but it is
   * more than enough to stop claiming the stop-loss is real.
   */
  readonly ownershipMismatchCount?: number;
  readonly ownershipLostReason?: string | null;
  /**
   * The position's pool triple (PHASE3.6 Rev2 M2). Without it this function
   * cannot know whether a configured price trigger APPLIES here, and it would
   * report `armed: false` — "there is nothing to arm" — about a position a
   * price stop is two cycles from liquidating. That is PHASE3.3-AUDIT A3 for
   * the third time, and this time in the dangerous direction.
   *
   * Optional so every existing caller compiles; absent means "no price trigger
   * can be matched", which is the pre-PHASE3.6 behaviour exactly.
   */
  readonly pool?: {
    readonly token0: `0x${string}`;
    readonly token1: `0x${string}`;
    readonly fee: number;
  };
};

export type LpProtectionStatus = {
  /** Whether a protect could actually fire for this position as things stand. */
  readonly armed: boolean;
  readonly reason: string;
  readonly settingsReadable: boolean;
  readonly digestVerified: boolean;
  readonly observationHeldAtMs: number | null;
  readonly observationAgeMs: number | null;
  readonly observationStale: boolean;
  readonly protectConsecutive: number;
  readonly stopLossPct: number | null;
  readonly takeProfitPct: number | null;
  /** When the held observation becomes usable as the first of two. */
  readonly confirmationEligibleAtMs: number | null;
  readonly maxObservationAgeMs: number;
  /**
   * The sequence that is BLOCKING a protect, or `null`. Non-null implies
   * `armed: false` with {@link lpBlockedBySequenceReason}.
   */
  readonly blockedBySequence: LpBlockingSequence | null;
  /**
   * Consecutive confirmed `ownerOf` mismatches carried on the row, and the
   * reason. Nonzero implies `armed: false` — see {@link LP_NOT_OWNED_REASON}.
   */
  readonly ownershipMismatchCount: number;
  readonly ownershipLostReason: string | null;
  /**
   * The price triggers that APPLY to this position (PHASE3.6), each with the
   * tick the last observation saw. Empty when none match — which is itself the
   * answer to "is my price stop protecting THIS position?".
   */
  readonly priceTriggers?: readonly {
    readonly label: "stopLoss" | "takeProfit";
    readonly trigger: LpPriceTrigger;
    readonly observedTick: number | null;
  }[];
};

/**
 * The ONE answer to "is this position's protection actually armed" (Rev2 item
 * 26). `GET /agents/:id/lp` and the worker's `--once` print both call this;
 * two computations of "armed" is the drift class this phase is closing.
 *
 * `armed` is FALSE whenever any of the four TODAY-SILENT conditions holds: no
 * stop/take-profit configured; a zero lineage basis; unreadable settings or a
 * digest that does not recompute; or a position with no tokenId. A dashboard
 * that shows "SL: 5%" while the counter can never reach two is the failure
 * mode of this entire finding. PHASE3.3 (Rev2 item 18) adds the fifth: a
 * position held by a non-terminal sequence of another kind, whose protect
 * `driveSequence` refuses outright. PHASE3.3-AUDIT A3 adds the sixth: the
 * position's OWN protect sequence, stuck on an `UNKNOWN` step row that only an
 * owner-signed resolution can settle — see
 * {@link lpBlockingSequenceCanProgress}.
 *
 * NOTE the residual it cannot hide (Rev2 item 24(b)): a worker that
 * CRASH-LOOPS with a restart gap longer than {@link lpMaxObservationAgeMs}
 * discards on every restart and the protect never fires. That agent reports
 * `armed: true` with a permanently STALE observation — which is why
 * `observationStale` and `observationAgeMs` are on the view and not only in a
 * log line.
 */
export function lpProtectionStatus(
  input: LpProtectionStatusInput,
): LpProtectionStatus {
  const maxObservationAgeMs = lpMaxObservationAgeMs(
    input.intervalMs,
    input.maxObservationAgeMs,
  );
  const ownershipMismatchCount = Math.max(0, input.ownershipMismatchCount ?? 0);
  // PHASE3.6 M1/M2: which triggers apply here, and the tick the last
  // observation saw. Computed once and used by both the gates below and the
  // view, so the surface and the decision cannot disagree.
  const observedTick = input.observation?.currentTick ?? null;
  const matchedTriggers: {
    readonly label: "stopLoss" | "takeProfit";
    readonly trigger: LpPriceTrigger;
    readonly observedTick: number | null;
  }[] = [];
  if (input.settings !== null && input.pool !== undefined) {
    for (const [label, trigger] of [
      ["stopLoss", input.settings.priceStopLoss],
      ["takeProfit", input.settings.priceTakeProfit],
    ] as const) {
      if (trigger !== null && priceTriggerMatchesPool(trigger, input.pool)) {
        matchedTriggers.push({ label, trigger, observedTick });
      }
    }
  }
  const observation = input.observation;
  const observationHeldAtMs = observation === null ? null : observation.evaluatedAtMs;
  const observationAgeMs =
    observationHeldAtMs === null ? null : input.nowMs - observationHeldAtMs;
  const observationStale =
    observationAgeMs !== null && observationAgeMs > maxObservationAgeMs;
  const stopLossPct = input.settings === null ? null : input.settings.stopLossPct;
  const takeProfitPct = input.settings === null ? null : input.settings.takeProfitPct;
  // Rev2 item 18, as corrected by PHASE3.3-AUDIT A3: a non-terminal sequence
  // of ANOTHER kind blocks a protect, and so does the position's OWN protect
  // when that protect can no longer advance. One definition of the rule, here.
  const blocking = input.blockingSequence ?? null;
  const blockedBySequence =
    blocking !== null
    && (blocking.kind !== "protect" || !lpBlockingSequenceCanProgress(blocking))
      ? blocking
      : null;
  const base = {
    settingsReadable: input.settingsReadable,
    digestVerified: input.digestVerified,
    observationHeldAtMs,
    observationAgeMs,
    observationStale,
    protectConsecutive: observation === null ? 0 : observation.protectConsecutive,
    stopLossPct,
    takeProfitPct,
    confirmationEligibleAtMs:
      observationHeldAtMs === null ? null : observationHeldAtMs + input.intervalMs,
    maxObservationAgeMs,
    blockedBySequence,
    priceTriggers: matchedTriggers,
    ownershipMismatchCount,
    ownershipLostReason: ownershipMismatchCount === 0
      ? null
      : input.ownershipLostReason ?? null,
  };
  // FIRST, ahead of every other reason (M6). A position whose NFT is not in the
  // wallet has no protection to describe: the settings, the basis and the
  // observation are all still perfectly valid and all completely beside the
  // point. Reporting a digest problem or a zero basis here would send the owner
  // to fix something that is not what happened.
  if (ownershipMismatchCount > 0) {
    return { ...base, armed: false, reason: LP_NOT_OWNED_REASON };
  }
  if (!input.digestVerified) {
    return { ...base, armed: false, reason: LP_DIGEST_UNVERIFIED_REASON };
  }
  if (!input.settingsReadable || input.settings === null) {
    return {
      ...base,
      armed: false,
      reason: lpSettingsUnreadableReason("the stored params do not parse"),
    };
  }
  if (!input.hasTokenId) {
    return { ...base, armed: false, reason: LP_NO_TOKEN_ID_REASON };
  }
  // PHASE3.6 Rev2 M2. A price trigger protects INDEPENDENTLY of the basis, so
  // neither of the two gates below may disarm while one applies to this pool.
  const pricePoolArmed = matchedTriggers.length > 0;
  if (
    input.settings.stopLossPct <= 0
    && input.settings.takeProfitPct <= 0
    && !pricePoolArmed
  ) {
    return { ...base, armed: false, reason: LP_NO_PROTECT_CONFIGURED_REASON };
  }
  if (input.basisWei <= 0n && !pricePoolArmed) {
    return { ...base, armed: false, reason: LP_BASIS_ZERO_HOLD_REASON };
  }
  // LAST, deliberately: this reason means "everything else about this position
  // IS armed, and a sequence is the only thing in the way". Reporting it ahead
  // of an unreadable settings row or a zero basis would send an owner to
  // resolve a sequence that was never the problem.
  if (blockedBySequence !== null) {
    return {
      ...base,
      armed: false,
      // A3: a stuck PROTECT gets a reason that names itself. "A non-terminal
      // protect sequence holds this position" would read as a kind conflict
      // and send the owner looking for a sequence that is not the problem.
      reason:
        blockedBySequence.kind === "protect"
          ? LP_STUCK_PROTECT_REASON
          : lpBlockedBySequenceReason(blockedBySequence.kind),
    };
  }
  // Naming the instrument is the point: an owner whose basis is zero and whose
  // price stop is live must not read the same sentence as one whose value stop
  // is live, or PHASE3.4's "basisWei 0 means no TP/SL" promise reads as broken
  // when it is merely superseded.
  const valueArmed =
    input.basisWei > 0n
    && (input.settings.stopLossPct > 0 || input.settings.takeProfitPct > 0);
  return {
    ...base,
    armed: true,
    reason:
      valueArmed && pricePoolArmed
        ? LP_ARMED_BOTH_REASON
        : pricePoolArmed
          ? LP_ARMED_PRICE_ONLY_REASON
          : LP_ARMED_REASON,
  };
}

/**
 * Sanitized, string-valued record of WHY a decision was reached; rides on the
 * sequence row / receipt so an audit can reconstruct the choice.
 */
export type LpTriggerReason = {
  readonly basisWei: string;
  readonly basisSource: LpBasisSource | "zero-excluded";
  readonly blockNumber: string;
  readonly currentTick: number;
  readonly decision: LpManagementDecision;
  readonly exitValueWei: string;
  readonly freshFeesValueWei: string;
  readonly observedAtMs: number;
  readonly observationCardinality: number;
  readonly pnlBps?: string;
  readonly poolAddress: `0x${string}`;
  readonly poolLiquidity: string;
  readonly priceImpactBps: string;
  /**
   * Present ONLY when a previous observation existed and was discarded — for
   * AGE (`"stale"`), or because the owner re-signed their settings while a
   * protect count was building (`"settings-changed"`, FIXREVIEW N3/P3). The
   * original wording below names only the first and is kept for its reasoning.
   *
   * Present ONLY when a previous observation existed and was discarded for
   * age. The discard must never be silent — "your protect restarted its count"
   * is exactly the class of fact (ae) proved must be reported (Rev2 item 18's
   * channel: the evaluator names it, the worker logs it without knowing the
   * rule).
   */
  readonly previousObservationDiscarded?: "stale" | "settings-changed";
  readonly reason: string;
  readonly rotateDeviationBps?: string;
  readonly spotTwapDeviationBps: string;
  readonly thresholdBps?: string;
  /**
   * The price threshold that fired (PHASE3.6 M14). `thresholdBps` is
   * bps-of-basis and is meaningless for a tick comparison, so a price breach
   * carries these instead of it.
   */
  readonly triggerTick?: number;
  readonly triggerWhen?: "at-or-below" | "at-or-above";
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly tokenId: string;
};

export type EvaluateLpTriggersResult = {
  readonly decision: LpManagementDecision;
  readonly holdReason?: string;
  readonly nextObservation: LpTriggerObservation;
  readonly railsPassed: boolean;
  readonly triggerReason: LpTriggerReason;
  /**
   * PHASE3.18 R2.3/C4 — the REQUOTE'S TARGET RUNG, computed ONCE at the trigger
   * and carried to the dispatch, which writes it onto the sequence row in the
   * transaction that creates it.
   *
   * Present ONLY on a `grid-requote` decision. It is returned rather than
   * re-derived at the worker because re-derivation is exactly the defect B4
   * found: on this relay resume is the DEFAULT path (FINDINGS (aw)), and a
   * second derivation at a second tick binds a rung the trigger never saw.
   */
  readonly gridRequoteTarget?: LpGridRange;
  /**
   * PHASE3.19 (C4, inherited from 3.18 R2.3) — the LADDER MOTION'S TARGET RUNG,
   * computed ONCE at the trigger and carried to the dispatch, which writes it
   * onto the sequence row in the transaction that creates it.
   *
   * Present ONLY on a `grid-recenter` decision, and persisted for the identical
   * reason the requote's is: on this relay resume is the DEFAULT path
   * (FINDINGS (aw)), so a second derivation at a second tick would bind a rung
   * the trigger's own evidence never justified. The PERSISTED target WINS and a
   * disagreeing recomputation THROWS.
   */
  readonly gridRecenterTarget?: LpGridRange;
  /**
   * PHASE3.20 D1 / items 7/16 — WHICH LANE this ladder motion reserves in,
   * decided from the EVIDENCE that fired rather than from the sequence kind.
   *
   * `quotaLaneOf(kind)` cannot separate two dispatches that share the kind
   * `grid-recenter`, so the driver persists this on the sequence row at CREATE
   * and the reservation reads it back — the 3.18 C4 persisted-target seam, same
   * rule, same "persisted wins and a disagreement THROWS".
   *
   * A CROSS fill and a STRANDING bound both reserve `"settlement"`: a stranded
   * rung is mismatched precisely because it filled, so the bound is the SAME
   * motion arriving late (OQ3). Only a discretionary drift reserves `"drift"`.
   */
  readonly gridRecenterEvidence?: "settlement" | "drift";
  /**
   * PHASE3.23 R2.4 / R3.4 — the SHIFT's discriminated one-or-two-target shape,
   * derived ONCE at the trigger and persisted exactly as present. At least one
   * member is present whenever this object is emitted; a null column means the
   * corresponding rung is untouched, never re-derived and never depleted.
   */
  readonly gridShiftTargets?: {
    readonly buyRange?: LpGridRange;
    readonly sellRange?: LpGridRange;
  };
  /** PHASE3.23 R2.1 — persisted authority for quota and the fresh build guard. */
  readonly gridShiftCause?: "cross" | "drift";
};

/* -------------------------------------------------------------------------- */
/* Settings validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Enforce the spec's settings table. THROWS with a per-field message; the
 * route layer maps that to a refusal before anything is persisted or signed.
 */
export function validateLpSettings(settings: LpAutomationSettings): void {
  if (typeof settings.autoRotate !== "boolean" || typeof settings.autoHarvest !== "boolean") {
    throw new Error("autoRotate and autoHarvest must be booleans.");
  }
  if (typeof settings.brainEnabled !== "boolean") {
    throw new Error("brainEnabled must be a boolean.");
  }
  if (settings.brain !== undefined) {
    if (typeof settings.brain.instructions !== "string" && settings.brain.instructions !== null) {
      throw new Error("brain.instructions must be a string or null.");
    }
    if (
      typeof settings.brain.skillMarkdown !== "string"
      && settings.brain.skillMarkdown !== null
    ) {
      throw new Error("brain.skillMarkdown must be a string or null.");
    }
    if (settings.brain.primaryModel === settings.brain.fallbackModel) {
      throw new Error("brain.fallbackModel must differ from brain.primaryModel.");
    }
  }
  if (typeof settings.exitToQuote !== "boolean") {
    throw new Error("exitToQuote must be a boolean.");
  }
  if (settings.rotateMode !== "swapped" && settings.rotateMode !== "swapless") {
    throw new Error('rotateMode must be "swapped" or "swapless".');
  }
  if (settings.stakingEnabled !== false) {
    throw new Error("stakingEnabled is reserved for the CAKE phase; it must be false in v1.");
  }
  if (settings.accumulateMode !== "compound") {
    throw new Error('accumulateMode "accumulate" is reserved; it must be "compound" in v1.');
  }
  if (!Number.isInteger(settings.rotateBandBps) || settings.rotateBandBps < 0 || settings.rotateBandBps > 5_000) {
    throw new Error("rotateBandBps must be an integer in 0..5000.");
  }
  if (!Number.isInteger(settings.rotateMinHoldMinutes) || settings.rotateMinHoldMinutes < 0) {
    throw new Error("rotateMinHoldMinutes must be a nonnegative integer.");
  }
  if (typeof settings.harvestMinFeesWei !== "bigint" || settings.harvestMinFeesWei <= 0n) {
    throw new Error("harvestMinFeesWei must be a positive bigint (wei).");
  }
  if (!Number.isInteger(settings.stopLossPct) || settings.stopLossPct < 0 || settings.stopLossPct > 90) {
    throw new Error("stopLossPct must be zero/off or an integer in 1..90.");
  }
  if (!Number.isInteger(settings.takeProfitPct) || settings.takeProfitPct < 0 || settings.takeProfitPct > 500) {
    throw new Error("takeProfitPct must be zero/off or an integer in 1..500.");
  }
  // PHASE3.6 Rev2 M16: RANGES live here, in the ONE range validator both wire
  // paths call; the STRUCTURAL parse (shape, unknown keys) lives in
  // `src/http/lpWire.ts` beside `rejectUnknownKeys`.
  for (const [name, trigger] of [
    ["priceStopLoss", settings.priceStopLoss],
    ["priceTakeProfit", settings.priceTakeProfit],
  ] as const) {
    if (trigger === null) continue;
    if (!Number.isInteger(trigger.tick) || trigger.tick < MIN_TICK || trigger.tick > MAX_TICK) {
      throw new Error(`${name}.tick must be an integer in ${MIN_TICK}..${MAX_TICK}.`);
    }
    if (trigger.when !== "at-or-below" && trigger.when !== "at-or-above") {
      throw new Error(`${name}.when must be "at-or-below" or "at-or-above".`);
    }
    for (const leg of ["token0", "token1"] as const) {
      if (!/^0x[0-9a-fA-F]{40}$/u.test(trigger[leg])) {
        throw new Error(`${name}.${leg} must be a 20-byte hex address.`);
      }
    }
    if (trigger.token0.toLowerCase() >= trigger.token1.toLowerCase()) {
      throw new Error(`${name} legs must be in pool order (token0 < token1).`);
    }
    if (!V3_FEE_TIERS.includes(trigger.fee as (typeof V3_FEE_TIERS)[number])) {
      throw new Error(`${name}.fee must be one of: ${V3_FEE_TIERS.join(", ")}.`);
    }
  }
  if (
    !Number.isInteger(settings.maxExitSequencesPerDay)
    || settings.maxExitSequencesPerDay < 1
    || settings.maxExitSequencesPerDay > 24
  ) {
    throw new Error("maxExitSequencesPerDay must be an integer in 1..24.");
  }
  if (
    !Number.isInteger(settings.minMinutesBetweenExits)
    || settings.minMinutesBetweenExits < 5
    || settings.minMinutesBetweenExits > 1_440
  ) {
    throw new Error("minMinutesBetweenExits must be an integer in 5..1440.");
  }
  if (!Number.isInteger(settings.minAprBps) || settings.minAprBps < 0 || settings.minAprBps > 1_000_000) {
    throw new Error("minAprBps must be an integer in 0..1000000.");
  }
  validateLpGridSettings(settings);
}

/**
 * PHASE3.15 (R2.8, C1/C3): the grid block's RANGES AND ORDERING, in the ONE
 * range validator both wire paths call.
 *
 * WHAT LIVES HERE and what does not, on the M16 split:
 *   - HERE: everything decidable from the SIGNED PARAMS ALONE — shape bounds,
 *     spacing alignment (against the SIGNED `tickSpacing`), the
 *     orientation-conditioned ordering constraint (against the SIGNED
 *     `wbnbIsToken0`), non-overlap, the quota bounds, and the two
 *     cross-field refusals (C3's unreachable `maxFlipsPerDay`, and the
 *     grid-plus-standard-automation contradiction). Both operands of each are
 *     settings fields, so a route-only check would be a rule the worker's own
 *     `parseLpSettingsParams` does not enforce.
 *   - AT THE ROUTE: only what needs CHAIN or CONFIG input — `gateLpPool`, the
 *     cross-check of `wbnbIsToken0`/`tickSpacing` against the live pool read,
 *     the `LP_MAX_TICK_WIDTH` ceiling (a CONFIG value this pure function
 *     cannot see), and the R2.10 net-edge admission.
 */
function validateLpGridSettings(settings: LpAutomationSettings): void {
  const grid = settings.grid;
  if (grid === null) return;
  for (const leg of ["token0", "token1"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/u.test(grid.pool[leg])) {
      throw new Error(`grid.pool.${leg} must be a 20-byte hex address.`);
    }
  }
  if (grid.pool.token0.toLowerCase() >= grid.pool.token1.toLowerCase()) {
    throw new Error("grid.pool legs must be in pool order (token0 < token1).");
  }
  if (!V3_FEE_TIERS.includes(grid.pool.fee as (typeof V3_FEE_TIERS)[number])) {
    throw new Error(`grid.pool.fee must be one of: ${V3_FEE_TIERS.join(", ")}.`);
  }
  if (typeof grid.wbnbIsToken0 !== "boolean") {
    throw new Error("grid.wbnbIsToken0 must be a boolean.");
  }
  // A POSITIVE INTEGER, never a fee→spacing table (R2.13). PancakeSwap V3's
  // spacings are 1/10/50/200 for the 100/500/2500/10000 tiers and differ from
  // Uniswap's at the lowest tier; nothing in this repo has ever asserted them,
  // so the SIGNED value is cross-checked against the POOL at the route instead
  // of being derived from a constant nobody measured.
  if (!Number.isInteger(grid.tickSpacing) || grid.tickSpacing < 1 || grid.tickSpacing > 16_384) {
    throw new Error("grid.tickSpacing must be an integer in 1..16384.");
  }
  // PHASE3.17 R2.2 / review2 N14: BOTH-OR-NEITHER, and it is checked HERE
  // rather than in `readGridSettings` because both operands are settings
  // fields — the M16 split's own rule. One key alone is a half-signed dual
  // grid, whose missing rung has no defined flip target.
  const hasBuy2 = grid.buyRange2 !== undefined;
  const hasSell2 = grid.sellRange2 !== undefined;
  if (hasBuy2 !== hasSell2) {
    throw new Error(
      `A dual grid carries BOTH grid.buyRange2 and grid.sellRange2 or neither; got only ${hasBuy2 ? "buyRange2" : "sellRange2"}. Level 2 is a PAIR — one rung alone has no flip target.`,
    );
  }
  for (const [name, range] of [
    ["grid.buyRange", grid.buyRange],
    ["grid.sellRange", grid.sellRange],
    ...(grid.buyRange2 === undefined ? [] : [["grid.buyRange2", grid.buyRange2] as const]),
    ...(grid.sellRange2 === undefined ? [] : [["grid.sellRange2", grid.sellRange2] as const]),
  ] as const) {
    for (const bound of ["tickLower", "tickUpper"] as const) {
      const tick = range[bound];
      if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
        throw new Error(`${name}.${bound} must be an integer in ${MIN_TICK}..${MAX_TICK}.`);
      }
      if (tick % grid.tickSpacing !== 0) {
        throw new Error(
          `${name}.${bound} (${tick}) is not aligned to the pool's tick spacing ${grid.tickSpacing}; the mint would revert.`,
        );
      }
    }
    if (range.tickUpper - range.tickLower < grid.tickSpacing) {
      throw new Error(
        `${name} must be at least one tick spacing (${grid.tickSpacing}) wide; got ${range.tickUpper - range.tickLower}.`,
      );
    }
  }
  // R2.2 / OQ1. The constraint is ORIENTATION-CONDITIONED, and writing it
  // unconditionally is the 3.13 F7 inversion: the quote-holding (buy) range is
  // always on the side of the price that charges the QUOTE token, which is the
  // HIGH side when WBNB is token0 and the LOW side when it is token1.
  const [lower, upper, lowerName, upperName] = grid.wbnbIsToken0
    ? [grid.sellRange, grid.buyRange, "grid.sellRange", "grid.buyRange"] as const
    : [grid.buyRange, grid.sellRange, "grid.buyRange", "grid.sellRange"] as const;
  if (lower.tickUpper > upper.tickLower) {
    throw new Error(
      `The grid's ranges overlap or are ordered wrongly for this pool: with wbnbIsToken0=${grid.wbnbIsToken0} the quote-holding range sits ${grid.wbnbIsToken0 ? "ABOVE" : "BELOW"} the price, so ${lowerName}.tickUpper (${lower.tickUpper}) must be <= ${upperName}.tickLower (${upper.tickLower}).`,
    );
  }
  validateLpGridPairTwo(grid);
  // R2.7: bounded 1..24, the same ceiling `maxExitSequencesPerDay` carries,
  // because the number multiplies directly into a native-cap reserve.
  if (
    !Number.isInteger(grid.maxFlipsPerDay)
    || grid.maxFlipsPerDay < 1
    || grid.maxFlipsPerDay > 24
  ) {
    throw new Error("grid.maxFlipsPerDay must be an integer in 1..24.");
  }
  if (
    !Number.isInteger(grid.minNetEdgeBps)
    || grid.minNetEdgeBps < 0
    || grid.minNetEdgeBps > 10_000
  ) {
    throw new Error("grid.minNetEdgeBps must be an integer in 0..10000.");
  }
  // C3 / H8. `minMinutesBetweenExits` is the agent-wide spacing gate and it is
  // UNFILTERED — it anchors on every reservation, released and exempt ones
  // included — so it, not `maxFlipsPerDay`, FLOORS a grid's cycle rate. A
  // `maxFlipsPerDay` the gate makes unreachable is a setting that quietly means
  // nothing, which is the (ae) shape. Refuse instead, here, where both operands
  // are settings fields.
  const reachable = Math.floor(1_440 / settings.minMinutesBetweenExits);
  if (grid.maxFlipsPerDay > reachable) {
    throw new Error(
      `grid.maxFlipsPerDay ${grid.maxFlipsPerDay} is unreachable: minMinutesBetweenExits ${settings.minMinutesBetweenExits} allows at most ${reachable} sequences a day, and the spacing gate counts EVERY reservation. Lower maxFlipsPerDay to ${reachable} or lower minMinutesBetweenExits.`,
    );
  }
  validateLpGridPolicyMode(settings, grid);
  // A grid agent is never standard-managed (R2.6: the dispatch is exclusive),
  // so signing both is signing a contradiction. Refusing beats ignoring: an
  // owner who signed `autoRotate` and watched nothing rotate would have no way
  // to learn that the grid block is what turned it off.
  if (settings.autoRotate || settings.autoHarvest) {
    throw new Error(
      "A grid agent runs the ping-pong and nothing else: autoRotate and autoHarvest are refused alongside a grid block, because a standard rotate would re-range the grid level and destroy the strategy. exitToQuote and the price triggers stay meaningful.",
    );
  }
}

/**
 * PHASE3.18 — the MODE SPLIT and everything that hangs off it, in the pure
 * validator where both wire paths run it.
 *
 * Every rule here has BOTH operands in the settings, which is the M16 split's
 * own criterion. The one policy-mode rule that does NOT is
 * `policy.widthTicks <= LP_MAX_TICK_WIDTH` (C10): `LP_MAX_TICK_WIDTH` is
 * deployment CONFIG this pure function cannot see, so it lives at the route
 * beside the existing four-rung width loop, exactly where 3.15 put the rung
 * ceiling for the same reason.
 */
function validateLpGridPolicyMode(
  settings: LpAutomationSettings,
  grid: LpGridSettings,
): void {
  if (
    grid.mode !== undefined
    && grid.mode !== "fixed"
    && grid.mode !== "policy"
    && grid.mode !== "ladder"
    && grid.mode !== "shift"
  ) {
    throw new Error('grid.mode must be "fixed", "policy", "ladder" or "shift" when present.');
  }
  const mode = gridModeOf(grid);
  // PHASE3.22 R2.18 — the SHIFT's own rules, ahead of every other branch for
  // the reason the ladder's arm sits ahead of the fixed/policy split: a shift
  // grid must fall through NEITHER, because a silent inheritance of the policy
  // or ladder branch is the 3.19-M5 hazard this file keeps paying for.
  if (mode === "shift") {
    validateLpGridShiftMode(settings, grid);
    return;
  }
  if (grid.shift !== undefined) {
    // The (ae) shape, for the sixth block. Refuse rather than ignore.
    throw new Error(
      'grid.shift is only meaningful under grid.mode "shift": no other mode moves one or both derived targets in a single shift submission, so a shift block signed against one would silently do nothing. Set grid.mode to "shift", or drop grid.shift.',
    );
  }
  // PHASE3.19 — the LADDER's own rules, ahead of the fixed/policy split so a
  // ladder never falls through either branch. Every rule here has BOTH operands
  // in the settings, which is the M16 split's own criterion; the two that do not
  // (`ladder.widthTicks <= LP_MAX_TICK_WIDTH` and the `minMarkoutBps` floor,
  // which needs the deployment's saga-slippage rail) live at the route beside
  // the policy width check, exactly where 3.15 and 3.18 put theirs.
  if (mode === "ladder") {
    validateLpGridLadderMode(settings, grid);
    return;
  }
  if (grid.ladder !== undefined) {
    // The (ae) shape: a ladder block under a fixed or policy grid is a setting
    // that quietly means nothing. Refuse rather than ignore.
    throw new Error(
      'grid.ladder is only meaningful under grid.mode "ladder": a fixed ladder never re-anchors and a policy grid re-anchors only UNFILLED rungs, through grid.policy. Set grid.mode to "ladder", or drop grid.ladder.',
    );
  }
  if (mode === "fixed") {
    // R2.2. A requote block under a fixed ladder is a setting that quietly
    // means nothing — the (ae) shape — so it is refused rather than ignored.
    if (grid.requote !== undefined) {
      throw new Error(
        'grid.requote is only meaningful under grid.mode "policy": a fixed ladder never re-centres, so a requote block signed against it would silently do nothing. Set grid.mode to "policy" (which also needs grid.policy), or drop grid.requote.',
      );
    }
    if (grid.policy !== undefined) {
      throw new Error(
        'grid.policy is only meaningful under grid.mode "policy": a fixed ladder derives no rung at runtime. Set grid.mode to "policy", or drop grid.policy.',
      );
    }
    return;
  }
  const policy = grid.policy;
  if (policy === undefined) {
    throw new Error(
      'grid.mode "policy" requires grid.policy {gapTicks, widthTicks}: the requote re-derives a rung from the policy at a fresh tick, and the rungs alone do not determine it (a level\'s own pair separates by s + 3*gap + width while the inner rungs separate by s + 2*gap). Sign the policy the client derived the rungs from.',
    );
  }
  const requote = grid.requote;
  if (requote === undefined) {
    // C5. Policy mode without motion buys the whole identity/admission cost —
    // durable role columns, the weaker C2 reproducibility check, a closed
    // import door — and produces no re-centre at all.
    throw new Error(
      'grid.mode "policy" requires grid.requote {driftPctOfGap, maxRequotesPerDay}: policy mode changes role identity, the re-sign guard and the import door, and without a requote block it produces no motion in exchange. Add grid.requote, or sign grid.mode "fixed".',
    );
  }
  for (const [name, value] of [
    ["grid.policy.gapTicks", policy.gapTicks],
    ["grid.policy.widthTicks", policy.widthTicks],
  ] as const) {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} must be an integer.`);
    }
    if (value % grid.tickSpacing !== 0) {
      throw new Error(
        `${name} (${value}) is not a multiple of the pool's tick spacing ${grid.tickSpacing}; every rung the policy derives would be misaligned and the mint would revert.`,
      );
    }
  }
  if (policy.gapTicks < 0) throw new Error("grid.policy.gapTicks must be >= 0.");
  if (policy.widthTicks <= 0) {
    throw new Error("grid.policy.widthTicks must be positive.");
  }
  if (
    !Number.isInteger(requote.driftPctOfGap)
    || requote.driftPctOfGap < 25
    || requote.driftPctOfGap > 200
  ) {
    throw new Error("grid.requote.driftPctOfGap must be an integer in 25..200.");
  }
  if (
    !Number.isInteger(requote.maxRequotesPerDay)
    || requote.maxRequotesPerDay < 1
    || requote.maxRequotesPerDay > 24
  ) {
    // R2.10 — the SAME 1..24 ceiling `maxFlipsPerDay` and
    // `maxExitSequencesPerDay` carry, because the number multiplies directly
    // into `checkLpNativeCapSizing`'s native reserve.
    throw new Error("grid.requote.maxRequotesPerDay must be an integer in 1..24.");
  }
  // R2.10's JOINT reachability rule. The per-lane rule above already refused an
  // unreachable `maxFlipsPerDay`; with a THIRD lane the two limits compete for
  // ONE spacing gate, which is agent-wide and unfiltered. A pair whose SUM the
  // gate cannot deliver is two settings that quietly mean less than they say.
  const reachable = Math.floor(1_440 / settings.minMinutesBetweenExits);
  if (grid.maxFlipsPerDay + requote.maxRequotesPerDay > reachable) {
    throw new Error(
      `grid.maxFlipsPerDay ${grid.maxFlipsPerDay} + grid.requote.maxRequotesPerDay ${requote.maxRequotesPerDay} is unreachable: minMinutesBetweenExits ${settings.minMinutesBetweenExits} allows at most ${reachable} sequences a day in total, and the spacing gate counts EVERY reservation in every lane. Lower one of the two limits to fit ${reachable}, or lower minMinutesBetweenExits.`,
    );
  }
  // R2.1's COHERENCE RULE, run through the ONE derivation the client used
  // (`gridGeometry.ts`) rather than through arithmetic restated here.
  const incoherent = gridPolicyCoherence(grid, policy, {
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  if (incoherent !== null) throw new Error(incoherent);
}

/**
 * PHASE3.19 item 20 — the JOINT REACHABILITY RULE, now THREE-WAY, in ONE place.
 *
 * The spacing gate (`minMinutesBetweenExits`) is agent-wide and UNFILTERED — it
 * anchors on EVERY reservation in EVERY lane, released and exempt ones included
 * — so it, and not any per-lane limit, floors the total sequence rate. With a
 * FOURTH lane three signed limits now compete for one gate, and a sum the gate
 * cannot deliver is settings that quietly mean less than they say: the (ae)
 * shape, which this file refuses rather than tolerates.
 *
 * It is a shared function rather than a rule restated per mode so the two
 * callers cannot disagree, and so a mode added later cannot inherit a two-way
 * version of it. Absent lanes contribute zero, which makes it reduce EXACTLY to
 * 3.18's `maxFlipsPerDay + maxRequotesPerDay <= reachable` for a policy grid and
 * to 3.15's single-lane rule for a fixed one.
 */
function assertGridLanesReachable(
  settings: LpAutomationSettings,
  grid: LpGridSettings,
): void {
  const reachable = Math.floor(1_440 / settings.minMinutesBetweenExits);
  const requotes = grid.requote?.maxRequotesPerDay ?? 0;
  // PHASE3.20 item 9 — FOUR-WAY. The ladder's one lane became two, and the sum
  // is read through {@link ladderMotionCounts} so the legacy interpretation is
  // written in exactly one place (C10). An absent ladder contributes zero on
  // both terms, which makes this reduce EXACTLY to 3.18's two-way rule for a
  // policy grid and to 3.15's single-lane rule for a fixed one.
  const counts =
    grid.ladder === undefined
      ? { settlementsPerDay: 0, driftMovesPerDay: 0 }
      : ladderMotionCounts(grid.ladder);
  // PHASE3.22 R5.8 / D9 — FIVE-WAY. The shift lane joins the sum on the same
  // terms as every lane before it, and the `1 +` D9 asks for is not a literal
  // here: `maxFlipsPerDay` is PINNED to 1 under shift mode by
  // `validateLpGridShiftMode`, so `grid.maxFlipsPerDay + shifts` IS
  // `1 + shiftsPerDay`. Writing it that way keeps ONE summation rather than a
  // mode-conditional one, and keeps the arm's own lane visible in the sum
  // instead of hidden inside a constant.
  const shifts = grid.shift?.shiftsPerDay ?? 0;
  const total =
    grid.maxFlipsPerDay
    + requotes
    + counts.settlementsPerDay
    + counts.driftMovesPerDay
    + shifts;
  if (total > reachable) {
    // PHASE3.22 — the shift term is PRESENT-ONLY-WHEN-NONZERO in the SENTENCE,
    // the same discipline `gridSettingsParamsView` applies to the block itself
    // and for a directly analogous reason: R2's byte-identity requirement
    // covers the three shipped modes' REFUSAL TEXTS, which the 3.19/3.20
    // suites pin verbatim. A lane that contributes zero must therefore also
    // contribute zero words. (An absent ladder's two terms predate this rule
    // and are pinned AT zero by those same suites, so they stay unconditional.)
    const shiftClause = shifts === 0 ? "" : ` + grid.shift.shiftsPerDay ${shifts}`;
    throw new Error(
      `grid.maxFlipsPerDay ${grid.maxFlipsPerDay} + grid.requote.maxRequotesPerDay ${requotes} + grid.ladder.settlementsPerDay ${counts.settlementsPerDay} + grid.ladder.driftMovesPerDay ${counts.driftMovesPerDay}${shiftClause} is unreachable: minMinutesBetweenExits ${settings.minMinutesBetweenExits} allows at most ${reachable} sequences a day in total, and the spacing gate counts EVERY reservation in every lane. Lower one of the limits to fit ${reachable}, or lower minMinutesBetweenExits.`,
    );
  }
}

/**
 * PHASE3.19 — the LADDER mode's own validation, in the pure validator both wire
 * paths call.
 *
 * The rules, and each one's finding:
 *
 *  - `grid.ladder` REQUIRED, `grid.policy`/`grid.requote` REFUSED (C17: under
 *    ladder mode `grid.policy` does not exist, so a target derivation that
 *    reached for it would read `undefined`; and the requote is policy mode's
 *    motion, not this one's);
 *  - `buyRange2`/`sellRange2` REFUSED (item 14). A four-rung ladder is a
 *    different product v1 does not define — and under R3.1's single-level ruling
 *    BOTH ladder rows carry `gridLevel: 1`, so a second pair would have no row
 *    to belong to;
 *  - `maxFlipsPerDay === 1` (item 22 / H4(a)). No `grid-flip` sequence can ever
 *    be created under ladder mode, so any other value is a setting that quietly
 *    means nothing — the (ae) shape this file refuses elsewhere — and it also
 *    COSTS a slot in the three-way reachability rule below. It is not made
 *    optional: that would move `DEFAULT_SETTINGS_DIGEST`'s neighbourhood and
 *    break the one-way-rollback property `grid` itself carries;
 *  - `stopLossPct`/`takeProfitPct` REFUSED non-zero (item 10 / review B4). A
 *    ladder rung holds `deployPctBps` of one side's half — about 15% of the
 *    budget — so a value-versus-basis stop is a stop against the wrong quantity.
 *    Ladder rows record `basisWei: 0n`, which already makes the predicate inert;
 *    refusing the SETTING is the (ae) rule, so nobody signs a stop that silently
 *    never fires. `priceStopLoss`/`priceTakeProfit` compare TICKS and stay legal;
 *  - the 3.13 F1 drift floor is inherited by the DRIFT READING itself
 *    (`gridDriftReading`, unchanged), not restated here — item 16 is about the
 *    arithmetic, and there is exactly one implementation of it;
 *  - the R2.1 COHERENCE RULE (item 15) runs against `grid.ladder`'s own
 *    `{gapTicks, widthTicks}`: `gridPolicyCoherence` takes them structurally, so
 *    it needs no edit and there is still exactly ONE derivation;
 *  - the joint reachability rule goes THREE-WAY (item 20).
 */
function validateLpGridLadderMode(
  settings: LpAutomationSettings,
  grid: LpGridSettings,
): void {
  const ladder = grid.ladder;
  if (ladder === undefined) {
    throw new Error(
      'grid.mode "ladder" requires grid.ladder {gapTicks, widthTicks, deployPctBps, driftPctOfGap, settlementsPerDay+driftMovesPerDay (or the deprecated maxMovesPerDay), hedge}: a ladder re-anchors every rung from that geometry at a fresh tick, and the signed rungs alone do not determine it. Sign the ladder block the client derived the rungs from.',
    );
  }
  if (grid.policy !== undefined) {
    throw new Error(
      'grid.policy is only meaningful under grid.mode "policy"; a ladder carries its own geometry in grid.ladder. Drop grid.policy.',
    );
  }
  if (grid.requote !== undefined) {
    throw new Error(
      'grid.requote is only meaningful under grid.mode "policy": a ladder re-anchors FILLED and unfilled rungs alike through grid.ladder.maxMovesPerDay, in one lane. Drop grid.requote.',
    );
  }
  if (grid.buyRange2 !== undefined || grid.sellRange2 !== undefined) {
    throw new Error(
      'grid.mode "ladder" refuses buyRange2/sellRange2 in v1: a ladder is TWO rows on ONE pair of rungs, one per side, and both rows carry grid_level 1. A four-rung ladder is a different product. Re-sign without the second pair.',
    );
  }
  if (grid.maxFlipsPerDay !== 1) {
    throw new Error(
      `grid.mode "ladder" requires grid.maxFlipsPerDay 1, got ${grid.maxFlipsPerDay}: a ladder creates no grid-flip sequence ever — a fill's motion IS the re-centre — so any other value is a limit that bounds nothing while still consuming a slot in the spacing gate's reachability budget. 1 is the minimum the type admits and it is inert.`,
    );
  }
  if (settings.stopLossPct !== 0 || settings.takeProfitPct !== 0) {
    throw new Error(
      `grid.mode "ladder" refuses a non-zero stopLossPct/takeProfitPct (got ${settings.stopLossPct}/${settings.takeProfitPct}): a ladder rung holds only deployPctBps of one side's half, so a value-versus-basis threshold measures the rung against the WHOLE ladder's money and would liquidate a working rung. priceStopLoss/priceTakeProfit compare ticks and stay legal.`,
    );
  }
  for (const [name, value] of [
    ["grid.ladder.gapTicks", ladder.gapTicks],
    ["grid.ladder.widthTicks", ladder.widthTicks],
  ] as const) {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} must be an integer.`);
    }
    if (value % grid.tickSpacing !== 0) {
      throw new Error(
        `${name} (${value}) is not a multiple of the pool's tick spacing ${grid.tickSpacing}; every rung the ladder derives would be misaligned and the mint would revert.`,
      );
    }
  }
  if (ladder.gapTicks < 0) throw new Error("grid.ladder.gapTicks must be >= 0.");
  if (ladder.widthTicks <= 0) {
    throw new Error("grid.ladder.widthTicks must be positive.");
  }
  if (
    !Number.isInteger(ladder.deployPctBps)
    || ladder.deployPctBps < 1_000
    || ladder.deployPctBps > 5_000
  ) {
    // R4.2's bounds. The lower bound keeps a rung economically meaningful; the
    // UPPER bound is what makes `idleQuoteWei > 0` structural rather than a
    // runtime refusal — at 5000 the arm still leaves half of each side idle.
    throw new Error("grid.ladder.deployPctBps must be an integer in 1000..5000.");
  }
  if (
    !Number.isInteger(ladder.driftPctOfGap)
    || ladder.driftPctOfGap < 25
    || ladder.driftPctOfGap > 200
  ) {
    throw new Error("grid.ladder.driftPctOfGap must be an integer in 25..200.");
  }
  // ─── PHASE3.20 D1 / the migration ruling — EXACTLY ONE FORM ──────────────
  //
  // Both operands are settings fields, so the rule lives HERE and not in the
  // wire parse (the M16 split, `lpWire.ts:466-469`): the worker re-validates
  // every cycle, so its own parse must never be weaker than the route's.
  //
  // A validator that REQUIRED the new pair would disarm every live ladder
  // agent — including its price stop — on the cycle after deploy, which is why
  // `maxMovesPerDay` is retained rather than removed.
  const legacyForm = ladder.maxMovesPerDay !== undefined;
  const newForm =
    ladder.settlementsPerDay !== undefined || ladder.driftMovesPerDay !== undefined;
  if (legacyForm && newForm) {
    throw new Error(
      "grid.ladder carries BOTH the deprecated maxMovesPerDay and the settlementsPerDay/driftMovesPerDay pair. Exactly one form is accepted, because two authorities on one budget is how a drift comes to spend a settlement's slot. Drop maxMovesPerDay and sign the pair.",
    );
  }
  if (!legacyForm && !newForm) {
    throw new Error(
      "grid.ladder needs either the deprecated maxMovesPerDay or the settlementsPerDay/driftMovesPerDay pair; neither is present. No default is invented on the wire — a motion budget nobody signed is a budget nobody agreed to.",
    );
  }
  if (legacyForm) {
    if (
      !Number.isInteger(ladder.maxMovesPerDay)
      || (ladder.maxMovesPerDay as number) < 1
      || (ladder.maxMovesPerDay as number) > 24
    ) {
      // L4 — the SAME 1..24 ceiling `maxFlipsPerDay`, `maxRequotesPerDay` and
      // `maxExitSequencesPerDay` carry, because the number multiplies directly
      // into `checkLpNativeCapSizing`'s native reserve.
      throw new Error("grid.ladder.maxMovesPerDay must be an integer in 1..24.");
    }
  } else {
    if (
      !Number.isInteger(ladder.settlementsPerDay)
      || (ladder.settlementsPerDay as number) < 1
      || (ladder.settlementsPerDay as number) > 24
    ) {
      throw new Error("grid.ladder.settlementsPerDay must be an integer in 1..24.");
    }
    // ZERO IS LEGAL HERE and nowhere else in this family: `driftMovesPerDay: 0`
    // means "settle fills, never chase", which is the configuration an owner who
    // distrusts the drift heuristic signs — and the one L3 names as the first
    // live exercise.
    if (
      !Number.isInteger(ladder.driftMovesPerDay)
      || (ladder.driftMovesPerDay as number) < 0
      || (ladder.driftMovesPerDay as number) > 24
    ) {
      throw new Error(
        "grid.ladder.driftMovesPerDay must be an integer in 0..24; 0 is legal and means settle fills, never chase.",
      );
    }
  }
  // PHASE3.20 D2 / C11 — the STRANDING BOUND's own range, derived by the ONE
  // function the client transcript and the owner view read, so three
  // restatements of a `max()` cannot diverge (the 3.13 F12 rule). ABSENT is
  // legal and means the computed default: the bound is never silently disabled.
  if (ladder.maxStrandedMinutes !== undefined) {
    const bound = ladderStrandedMinutes(ladder, settings.minMinutesBetweenExits);
    if (
      !Number.isInteger(ladder.maxStrandedMinutes)
      || ladder.maxStrandedMinutes < bound.floor
      || ladder.maxStrandedMinutes > bound.ceiling
    ) {
      throw new Error(
        `grid.ladder.maxStrandedMinutes must be an integer in ${bound.floor}..${bound.ceiling} at minMinutesBetweenExits ${settings.minMinutesBetweenExits}: the floor is 2 x the spacing gate, because a bound that fires inside the gate fires into a gate it cannot pass. Absent is legal and means ${bound.defaultValue}.`,
      );
    }
  }
  const hedge = ladder.hedge;
  if (typeof hedge !== "object" || hedge === null) {
    throw new Error("grid.ladder.hedge must be an object.");
  }
  if (typeof hedge.enabled !== "boolean") {
    throw new Error("grid.ladder.hedge.enabled must be a boolean.");
  }
  if (
    !Number.isInteger(hedge.minMarkoutBps)
    || hedge.minMarkoutBps < 0
    || hedge.minMarkoutBps > 10_000
  ) {
    // The EFFECTIVE floor is `poolFeeBps + maxSagaSlippageBps`
    // ({@link ladderMinMarkoutBps}), which needs the deployment's rail config
    // this pure function cannot see — so the ROUTE refuses below it and the gate
    // takes the max regardless. Here only the shape is bounded.
    throw new Error("grid.ladder.hedge.minMarkoutBps must be an integer in 0..10000.");
  }
  if (
    !Number.isInteger(hedge.maxHedgePctBps)
    || hedge.maxHedgePctBps < 1
    || hedge.maxHedgePctBps > 10_000
  ) {
    throw new Error("grid.ladder.hedge.maxHedgePctBps must be an integer in 1..10000.");
  }
  assertGridLanesReachable(settings, grid);
  // ITEM 15 — the R2.1 COHERENCE RULE, through the ONE derivation the client
  // used. It takes `{gapTicks, widthTicks}` structurally, so the ladder's block
  // feeds it unedited and a ladder's signed rungs must be its own derivation at
  // SOME tick, exactly as a policy grid's must be.
  const incoherent = gridPolicyCoherence(grid, ladder, {
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  if (incoherent !== null) throw new Error(incoherent);
}

/**
 * PHASE3.22 R1/R2.18/R5.8 — the SHIFT mode's own validation, in the pure
 * validator both wire paths run.
 *
 * Every rule has BOTH operands in the settings (the M16 split's criterion); the
 * two that do not — `shift.widthTicks <= LP_MAX_TICK_WIDTH` and the pool
 * cross-checks — live at the route beside the policy and ladder width checks,
 * exactly where 3.15, 3.18 and 3.19 put theirs.
 *
 * The rules, each with its finding:
 *
 *  - `grid.shift` REQUIRED; `grid.policy`/`grid.requote`/`grid.ladder` REFUSED
 *    (R2 / C17: a shift grid reads NEITHER `grid.policy` NOR `grid.ladder`, so
 *    a block signed beside it is the (ae) shape AND a silent-inheritance trap);
 *  - `buyRange2`/`sellRange2` REFUSED — a shift ladder is TWO rows on ONE pair,
 *    both `gridLevel: 1` (§10's multi-level non-goal), so a second pair would
 *    have no row to belong to;
 *  - `maxFlipsPerDay === 1` (R5.8/D9). Shift mode runs no flips, so any other
 *    value bounds nothing while still costing a slot in the reachability
 *    budget — the (ae) shape. Making the field OPTIONAL was rejected: it would
 *    move `DEFAULT_SETTINGS_DIGEST`'s neighbourhood and break the one-way
 *    rollback property `grid` itself carries. Pinning it to 1 keeps the signed
 *    field meaningful as the ARM's own lane, which is a motion shift mode
 *    genuinely performs;
 *  - `stopLossPct`/`takeProfitPct` REFUSED non-zero (R2/M10, the ladder's
 *    reasoning verbatim): a rung holds `deployPctBps` of one side's half, so a
 *    value-versus-basis stop measures the rung against the WHOLE ladder's money.
 *    Shift rows record `basisWei: 0n`, which already makes the predicate inert;
 *    refusing the SETTING is the (ae) rule. `priceStopLoss`/`priceTakeProfit`
 *    compare TICKS and stay legal — and under decision 9 they are the declared
 *    risk control for one-sided depletion;
 *  - the 3.13 F1 drift floor is inherited by `gridDriftReading` itself, not
 *    restated here: there is exactly one implementation of that arithmetic;
 *  - the R2.1 COHERENCE RULE runs against `grid.shift`'s own
 *    `{gapTicks, widthTicks}` through the same structural `gridPolicyCoherence`,
 *    so the signed rungs the ARM mints at must be this geometry's derivation at
 *    some tick (R2.22: `buyRange`/`sellRange` remain REQUIRED and are the arm's
 *    geometry, used by the arm ONLY — no shift ever targets them again);
 *  - the joint reachability rule goes through {@link assertGridLanesReachable}.
 */
function validateLpGridShiftMode(
  settings: LpAutomationSettings,
  grid: LpGridSettings,
): void {
  const shift = grid.shift;
  if (shift === undefined) {
    throw new Error(
      'grid.mode "shift" requires grid.shift {gapTicks, widthTicks, deployPctBps, driftPctOfGap, shiftsPerDay}: a shift re-anchors one or both rungs from that geometry at a fresh tick in one submission, and the signed rungs alone do not determine it. Sign the shift block the client derived the rungs from.',
    );
  }
  if (grid.policy !== undefined) {
    throw new Error(
      'grid.policy is only meaningful under grid.mode "policy"; a shift ladder carries its own geometry in grid.shift. Drop grid.policy.',
    );
  }
  if (grid.requote !== undefined) {
    throw new Error(
      'grid.requote is only meaningful under grid.mode "policy": shift motion is governed by grid.shift.shiftsPerDay and may move one or both rungs. Drop grid.requote.',
    );
  }
  if (grid.ladder !== undefined) {
    throw new Error(
      'grid.ladder is only meaningful under grid.mode "ladder": a shift ladder moves its targeted rung or rungs in ONE batch and carries no hedge (v1). Drop grid.ladder, or set grid.mode to "ladder".',
    );
  }
  if (grid.buyRange2 !== undefined || grid.sellRange2 !== undefined) {
    throw new Error(
      'grid.mode "shift" refuses buyRange2/sellRange2 in v1: a shift ladder is TWO rows on ONE pair of rungs, one per side, and both rows carry grid_level 1. A four-rung shift ladder is a different product. Re-sign without the second pair.',
    );
  }
  if (grid.maxFlipsPerDay !== 1) {
    throw new Error(
      `grid.mode "shift" requires grid.maxFlipsPerDay 1, got ${grid.maxFlipsPerDay}: a shift creates no grid-flip sequence ever — a fill's motion IS the re-anchor — so any other value is a limit that bounds nothing while still consuming a slot in the spacing gate's reachability budget. 1 is the minimum the type admits and it is the arm's own lane.`,
    );
  }
  if (settings.stopLossPct !== 0 || settings.takeProfitPct !== 0) {
    throw new Error(
      `grid.mode "shift" refuses a non-zero stopLossPct/takeProfitPct (got ${settings.stopLossPct}/${settings.takeProfitPct}): a shift rung holds only deployPctBps of one side's half, so a value-versus-basis threshold measures the rung against the WHOLE ladder's money and would liquidate a working rung. priceStopLoss/priceTakeProfit compare ticks and stay legal.`,
    );
  }
  for (const [name, value] of [
    ["grid.shift.gapTicks", shift.gapTicks],
    ["grid.shift.widthTicks", shift.widthTicks],
  ] as const) {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} must be an integer.`);
    }
    if (value % grid.tickSpacing !== 0) {
      throw new Error(
        `${name} (${value}) is not a multiple of the pool's tick spacing ${grid.tickSpacing}; every rung the shift derives would be misaligned and the mint would revert.`,
      );
    }
  }
  // R1 requires `gapTicks > 0` — and R2.25 is why it is STRICT here where the
  // ladder's is `>= 0`: `gridDeriveRanges` guarantees STRICT anchors, so actual
  // clearance is `g + (1..s)` above and `g + (0..s-1)` below, and the R9 gate's
  // "one-spacing clearance per side" holds ONLY because the gap is a POSITIVE
  // spacing multiple. At `gapTicks: 0` the below-side range can abut the tick.
  if (shift.gapTicks <= 0) {
    throw new Error(
      "grid.shift.gapTicks must be positive: the G-gate's one-spacing clearance below the tick holds only for a positive spacing multiple (R2.25), and a zero gap re-fires the motion against its own target.",
    );
  }
  if (shift.widthTicks <= 0) {
    throw new Error("grid.shift.widthTicks must be positive.");
  }
  if (
    !Number.isInteger(shift.deployPctBps)
    || shift.deployPctBps < 1_000
    || shift.deployPctBps > 5_000
  ) {
    // The ladder's R4.2 bounds verbatim. The lower bound keeps a rung
    // economically meaningful; the UPPER bound is what makes an idle buffer
    // structural rather than a runtime refusal — at 5000 the arm still leaves
    // half of each side idle, which is what funds the NEXT motion.
    throw new Error("grid.shift.deployPctBps must be an integer in 1000..5000.");
  }
  if (
    !Number.isInteger(shift.driftPctOfGap)
    || (shift.driftPctOfGap !== 0
      && (shift.driftPctOfGap < 25 || shift.driftPctOfGap > 200))
  ) {
    throw new Error("grid.shift.driftPctOfGap must be 0 (drift disabled) or an integer in 25..200.");
  }
  // R5.8 / decision 8 — a TECHNICAL ceiling only. 288 is what
  // `minMinutesBetweenExits >= 5` already implies; the real bound an owner
  // feels is the reachability conjunct below plus the client's printed
  // `minBudgetWei` at this cadence.
  if (
    !Number.isInteger(shift.shiftsPerDay)
    || shift.shiftsPerDay < 1
    || shift.shiftsPerDay > MAX_GRID_SHIFT_SHIFTS_PER_DAY
  ) {
    throw new Error(
      `grid.shift.shiftsPerDay must be an integer in 1..${MAX_GRID_SHIFT_SHIFTS_PER_DAY}. There is no policy cap (operator decision 8): the ceiling is what minMinutesBetweenExits >= 5 already implies, and the cost of the cadence you sign is printed before you sign it.`,
    );
  }
  const hasDriftBudget = shift.driftGasBudgetWei !== undefined;
  const hasDriftPrice = shift.driftPerMotionWei !== undefined;
  if (hasDriftBudget !== hasDriftPrice) {
    throw new Error(
      "grid.shift.driftGasBudgetWei and grid.shift.driftPerMotionWei must be signed together: a budget without its price is a number nobody can spend, and a price without a budget bounds nothing.",
    );
  }
  if (
    shift.driftGasBudgetWei !== undefined
    && (shift.driftGasBudgetWei < 0n
      || shift.driftGasBudgetWei > MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI)
  ) {
    throw new Error(
      `grid.shift.driftGasBudgetWei ${shift.driftGasBudgetWei} exceeds the sanity ceiling of ${MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI} wei (1 BNB). This is not a policy cap: a drift budget larger than any grid's own capital cannot be spent by the spacing gate.`,
    );
  }
  if (
    shift.driftPerMotionWei !== undefined
    && (shift.driftPerMotionWei <= 0n
      || shift.driftPerMotionWei > MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI)
  ) {
    throw new Error(
      `grid.shift.driftPerMotionWei must be positive and no greater than ${MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI} wei (1 BNB).`,
    );
  }
  assertGridLanesReachable(settings, grid);
  // The R2.1 COHERENCE RULE, through the ONE derivation the client used. It
  // takes `{gapTicks, widthTicks}` structurally, so the shift block feeds it
  // unedited: a shift grid's signed rungs must be its own derivation at SOME
  // tick, exactly as a policy grid's and a ladder's must be.
  const incoherent = gridPolicyCoherence(grid, shift, {
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  if (incoherent !== null) throw new Error(incoherent);
}

/**
 * PHASE3.17 R2.2 — the CROSSED-PAIR chain, the corridor and pairwise
 * disjointness, for a grid that carries level 2's pair.
 *
 * Nothing here runs when `buyRange2`/`sellRange2` are absent, and that scoping
 * is deliberate rather than convenient: a single-level 3.15/3.16 grid whose two
 * ranges TOUCH (`sellRange.tickUpper === buyRange.tickLower` in Case A) is
 * legal and armable, because its arm only ever asks the BUY gate. A DUAL arm
 * asks both gates at once, so a touching inner pair leaves an EMPTY corridor
 * and is permanently unarmable at every tick — which is refused HERE, at
 * SIGNING, with a text that says so, rather than surfacing for ever as a
 * stale-tick refusal the owner would keep retrying (review M4.ii).
 *
 * THE CHAIN IS WRITTEN ASCENDING, per orientation, and it is one list rather
 * than six hand-written inequalities so the direction cannot be transcribed
 * wrongly for half of BSC's pools — the 3.13 F7 / 3.15 H1 class this lineage
 * has been caught by twice. See {@link LpGridSettings.buyRange2} for the
 * geometry and why each level takes one inner and one outer rung.
 *
 * DISJOINTNESS is a COROLLARY, not a seventh check: every range has positive
 * width (asserted above), so an ascending chain of `prev.tickUpper <=
 * next.tickLower` links makes all four pairwise disjoint by construction.
 *
 * The pair-1 ordering rule the caller just enforced is IMPLIED by the chain in
 * both orientations, and so is its pair-2 analogue — so this function widens
 * the grid's geometry without contradicting one byte of 3.15's rule.
 */
function validateLpGridPairTwo(grid: LpGridSettings): void {
  const buy2 = grid.buyRange2;
  const sell2 = grid.sellRange2;
  if (buy2 === undefined || sell2 === undefined) return;
  // ASCENDING, with the corridor sitting between elements 1 and 2.
  const ascending = grid.wbnbIsToken0
    ? ([
        ["grid.sellRange", grid.sellRange],
        ["grid.sellRange2", sell2],
        ["grid.buyRange", grid.buyRange],
        ["grid.buyRange2", buy2],
      ] as const)
    : ([
        ["grid.buyRange2", buy2],
        ["grid.buyRange", grid.buyRange],
        ["grid.sellRange2", sell2],
        ["grid.sellRange", grid.sellRange],
      ] as const);
  for (let index = 0; index + 1 < ascending.length; index += 1) {
    const [lowerName, lower] = ascending[index] as (typeof ascending)[number];
    const [upperName, upper] = ascending[index + 1] as (typeof ascending)[number];
    if (lower.tickUpper > upper.tickLower) {
      throw new Error(
        `The dual grid's four rungs must not overlap and must ascend as ${ascending.map(([name]) => name.replace("grid.", "")).join(" < ")} for wbnbIsToken0=${grid.wbnbIsToken0}; ${lowerName}.tickUpper (${lower.tickUpper}) is above ${upperName}.tickLower (${upper.tickLower}).`,
      );
    }
  }
  // THE CORRIDOR, and its emptiness is a PERMANENT defect rather than a
  // transient one. The arm needs a tick with `innerBuy.tickUpper <= t <
  // innerSell.tickLower` (Case B; mirrored in A) — exactly the conjunction of
  // the two inner-rung G-gates — so equality here means no tick anywhere
  // satisfies both, at any price, for ever.
  const innerLower = grid.wbnbIsToken0 ? sell2 : grid.buyRange;
  const innerUpper = grid.wbnbIsToken0 ? grid.buyRange : sell2;
  const innerLowerName = grid.wbnbIsToken0 ? "grid.sellRange2" : "grid.buyRange";
  const innerUpperName = grid.wbnbIsToken0 ? "grid.buyRange" : "grid.sellRange2";
  if (innerLower.tickUpper >= innerUpper.tickLower) {
    throw new Error(
      `This dual grid has an EMPTY arm corridor and is permanently unarmable: the arm needs a tick with ${innerLowerName}.tickUpper (${innerLower.tickUpper}) <= t < ${innerUpperName}.tickLower (${innerUpper.tickLower}), and no tick satisfies that. Widen the gap between the two INNER rungs and re-sign; waiting for the price to move cannot help.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The evaluator                                                              */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* PHASE3.15 M10 — the two pieces the grid evaluator shares, extracted         */
/* -------------------------------------------------------------------------- */

/**
 * What a previous observation may still be compared against (PHASE3.15 M10).
 *
 * A DECLARED PURE-MOTION REFACTOR, and the alternative was rejected in writing:
 * `evaluateGridTriggers` needs the SAME comparability rule and the SAME
 * price-protect comparison, and duplicating either inside `gridTriggers.ts`
 * would be the `evaluateLpProtectBreach`/M11 drift class this repo has already
 * paid for twice — two hand-written tick comparisons silently move a boundary,
 * and here the boundary decides whether a stop-loss fires. §12's freeze on
 * {@link evaluateLpTriggers} is a freeze on its DECISION LOGIC, not on the file:
 * the body below is the code that stood at those lines, moved, and the existing
 * trigger suite passing byte-identically is the pin.
 */
export type LpObservationComparability = {
  readonly maxObservationAgeMs: number;
  readonly previousIsStale: boolean;
  readonly settingsUnchanged: boolean;
  readonly previousIsComparable: boolean;
};

export function lpObservationComparability(input: {
  readonly intervalMs: number;
  readonly maxObservationAgeMs?: number;
  readonly nowMs: number;
  readonly settingsDigest?: string;
  readonly previousObservation?: LpTriggerObservation;
  readonly blockNumber: bigint;
  readonly tokenId: string;
  readonly poolAddress: `0x${string}`;
}): LpObservationComparability {
  const { previousObservation } = input;
  // 2-consecutive-observations comparability: same position, same pool,
  // strictly older by BLOCK (two looks at the same finalized block are one
  // look), at least one interval older by clock, and NOT older than the
  // staleness bound.
  //
  // The staleness conjunct lives HERE, not in the caller (PHASE3.2 Rev2 item
  // 18): four comparability predicates already live in this expression, two of
  // them (tokenId, poolAddress) would have had to be restated in the worker to
  // build the fifth there, and the rule needs ZERO new inputs.
  const maxObservationAgeMs = lpMaxObservationAgeMs(
    input.intervalMs,
    input.maxObservationAgeMs,
  );
  const previousIsStale = Boolean(
    previousObservation
    && input.nowMs - previousObservation.evaluatedAtMs > maxObservationAgeMs,
  );
  // AUDIT A7, SCOPED by FIXREVIEW N3.
  //
  // A count may only be carried forward when it was earned under the SAME
  // signed settings — otherwise a freshly-signed instrument inherits a
  // confirmation another one earned. But the first fix put this conjunct into
  // the SHARED comparability predicate, which also gates the ROTATE count and
  // `rotationBreachStartedAtMs`: every settings re-sign silently restarted the
  // `rotateMinHoldMinutes` clock, for a change that may not have touched
  // rotation at all. So it applies to the PROTECT count only, which is the
  // count A7 was about. (PHASE3.15 reads it for the GRID count too, and that is
  // a deliberate widening rather than an inherited default: a grid cross count
  // earned under one pair of signed ranges must never be inherited by another.)
  //
  // Absent on either side ⇒ treated as changed, which costs one confirmation
  // cycle at the upgrade and is the fail-safe direction.
  const settingsUnchanged =
    input.settingsDigest === undefined
      ? true
      : previousObservation?.settingsDigest === input.settingsDigest;
  const previousIsComparable = Boolean(
    previousObservation
    && previousObservation.tokenId === input.tokenId
    && previousObservation.poolAddress.toLowerCase() === input.poolAddress.toLowerCase()
    && previousObservation.blockNumber < input.blockNumber
    && input.nowMs - previousObservation.evaluatedAtMs >= input.intervalMs
    && !previousIsStale,
  );
  return {
    maxObservationAgeMs,
    previousIsStale,
    settingsUnchanged,
    previousIsComparable,
  };
}

/** Everything the protect priority decides, before the rails gate. */
export type LpProtectSignal = {
  /** The price triggers that MATCH this position's pool, or `null`. */
  readonly priceStop: LpPriceTrigger | null;
  readonly priceTake: LpPriceTrigger | null;
  readonly protectBreach: LpTriggerObservation["protectBreach"];
  readonly protectBreachClass: "stop" | "take-profit" | undefined;
  readonly protectThresholdBps: bigint | undefined;
  readonly firedTrigger: LpPriceTrigger | null;
  readonly protectConsecutive: number;
  /**
   * The decision this breach would dispatch and the sentence it would carry,
   * once the CONFIRMATION COUNT and the RAILS also pass — both of which stay
   * with the caller. ONE object rather than two nullable fields, so a caller
   * cannot narrow one and read the other unguarded.
   */
  readonly dispatch:
    | {
        readonly decision:
          | "protect-stop-loss"
          | "protect-take-profit"
          | "protect-price-stop-loss"
          | "protect-price-take-profit";
        readonly reason: string;
      }
    | undefined;
};

/**
 * THE ONE price/value protect comparison (PHASE3.15 M10), shared verbatim by
 * {@link evaluateLpTriggers} and the grid evaluator.
 *
 * Pure motion from the evaluator's protect block. Note what did NOT move: the
 * RAILS gate and the dispatch itself stay with the caller, because a grid
 * evaluator gates protect on the same rails but everything else differently.
 */
export function evaluateLpProtectSignal(input: {
  readonly position: LpTriggerPositionInput;
  readonly settings: Pick<
    LpAutomationSettings,
    "stopLossPct" | "takeProfitPct" | "priceStopLoss" | "priceTakeProfit"
  >;
  readonly previousObservation?: LpTriggerObservation;
  readonly previousIsComparable: boolean;
  readonly settingsUnchanged: boolean;
}): LpProtectSignal {
  const { position, settings, previousObservation } = input;
  // The comparison itself lives in `evaluateLpProtectBreach` (PHASE3.4 Rev2
  // M11) because `POST /lp/import` must refuse an already-breaching import on
  // the SAME predicate. A second implementation in the route — floats,
  // percent-vs-bps, `<` vs `<=` — would silently move the boundary the owner
  // signed against, so the refusal boundary and the firing boundary would drift.
  const valueBreach = evaluateLpProtectBreach({
    basisWei: position.basisWei,
    exitValueWei: position.exitValueWei,
    stopLossPct: settings.stopLossPct,
    takeProfitPct: settings.takeProfitPct,
  });
  // PHASE3.6 decision 4: value before price, stop-losses before take-profits.
  // Value-first is what makes that phase inert byte-for-byte for an agent with
  // no price trigger set; all four dispatch the same saga, so the order changes
  // only which reason is recorded, and protecting the downside first loses less.
  const priceStop = matchedPriceTrigger(settings.priceStopLoss, position);
  const priceTake = matchedPriceTrigger(settings.priceTakeProfit, position);
  const priceBreach: "price-stop-loss" | "price-take-profit" | undefined =
    priceStop !== null && priceTriggerFires(priceStop, position.currentTick)
      ? "price-stop-loss"
      : priceTake !== null && priceTriggerFires(priceTake, position.currentTick)
        ? "price-take-profit"
        : undefined;
  const protectBreach: LpTriggerObservation["protectBreach"] =
    valueBreach?.kind === "stop-loss"
      ? "stop-loss"
      : priceBreach === "price-stop-loss"
        ? "price-stop-loss"
        : valueBreach?.kind === "take-profit"
          ? "take-profit"
          : priceBreach;
  const protectThresholdBps: bigint | undefined =
    protectBreach === "stop-loss" || protectBreach === "take-profit"
      ? valueBreach?.thresholdBps
      : undefined;
  const firedTrigger =
    protectBreach === "price-stop-loss"
      ? priceStop
      : protectBreach === "price-take-profit"
        ? priceTake
        : null;
  // Rev2 M7: the confirmation compares the CLASS, not the exact kind. Strict
  // kind equality backfires — a position building a `price-stop-loss` count
  // that ALSO trips the value stop on cycle 2 would have its count reset to 1,
  // so MORE evidence of danger would produce a LATER dispatch.
  const protectBreachClass = breachClassOf(protectBreach);
  // Rev2 M7: CLASS, not kind. A previous row from before this phase carries no
  // class; deriving it from its own `protectBreach` keeps the comparison
  // meaningful across the upgrade instead of restarting every count once.
  const previousClass =
    previousObservation === undefined
      ? undefined
      : previousObservation.protectBreachClass
        ?? breachClassOf(previousObservation.protectBreach);
  const protectConsecutive =
    protectBreach
    && input.previousIsComparable
    && input.settingsUnchanged
    && previousClass === protectBreachClass
      ? (previousObservation?.protectConsecutive ?? 0) + 1
      : protectBreach ? 1 : 0;
  const dispatch =
    protectBreach === undefined
      ? undefined
      : {
          decision:
            protectBreach === "stop-loss"
              ? ("protect-stop-loss" as const)
              : protectBreach === "take-profit"
                ? ("protect-take-profit" as const)
                : protectBreach === "price-stop-loss"
                  ? ("protect-price-stop-loss" as const)
                  : ("protect-price-take-profit" as const),
          reason:
            protectBreach === "stop-loss"
              ? "Stop-loss protect threshold confirmed across two finalized evaluations."
              : protectBreach === "take-profit"
                ? "Take-profit protect threshold confirmed across two finalized evaluations."
                : `Price ${protectBreach === "price-stop-loss" ? "stop-loss" : "take-profit"} confirmed across two finalized evaluations: tick ${position.currentTick} is ${firedTrigger?.when ?? "at"} ${firedTrigger?.tick ?? "?"}.`,
        };
  return {
    priceStop,
    priceTake,
    protectBreach,
    protectBreachClass,
    protectThresholdBps,
    firedTrigger,
    protectConsecutive,
    dispatch,
  };
}

/**
 * Deterministic LP-management decision gate. It performs no I/O and only
 * consumes caller-supplied finalized-chain observations, making confirmation
 * and threshold behavior independently unit-testable. (0G's words; the
 * property carried over intact.)
 */
export function evaluateLpTriggers(input: EvaluateLpTriggersInput): EvaluateLpTriggersResult {
  validateTriggerInput(input);
  const { market, nowMs, position, previousObservation, settings } = input;
  const spotTwapDeviationBps = priceDeviationBps(
    market.spotSqrtPriceX96,
    market.twapSqrtPriceX96,
  );
  const railsFailure = checkManipulationRails(market, input.rails);
  const railsPassed = railsFailure === undefined;

  // PHASE3.15 M10: the comparability rule and the protect comparison are the
  // SAME code the grid evaluator runs, extracted above as a declared pure
  // motion. Nothing about the decision logic moved — the existing trigger suite
  // passing byte-identically is the pin.
  const { previousIsStale, settingsUnchanged, previousIsComparable } =
    lpObservationComparability({
      intervalMs: input.intervalMs,
      ...(input.maxObservationAgeMs === undefined
        ? {}
        : { maxObservationAgeMs: input.maxObservationAgeMs }),
      nowMs,
      ...(input.settingsDigest === undefined
        ? {}
        : { settingsDigest: input.settingsDigest }),
      ...(previousObservation === undefined ? {} : { previousObservation }),
      blockNumber: market.blockNumber,
      tokenId: position.tokenId,
      poolAddress: position.poolAddress,
    });

  // --- protect (priority 0): TP/SL vs the LINEAGE basis --------------------
  const protect = evaluateLpProtectSignal({
    position,
    settings,
    ...(previousObservation === undefined ? {} : { previousObservation }),
    previousIsComparable,
    settingsUnchanged,
  });
  const {
    priceStop,
    priceTake,
    protectBreach,
    protectBreachClass,
    protectThresholdBps,
    firedTrigger,
    protectConsecutive,
  } = protect;

  // --- rotate (priority 1): out of range + band + hold ---------------------
  const rotateDeviationBps = rotationDeviationBps(position);
  // PHASE3.13 F1 — the trigger is NOT mode-independent, and OQ4's answer was
  // wrong. A swapless rotate parks the range STRICTLY BESIDE the price: that is
  // its definition, so `rotationDeviationBps` is defined for it on the very
  // next observation, and with `rotateBandBps` defaulting to 0 against a `>=`
  // the position it just parked breaches immediately. Two cycles later the
  // worker dispatches ANOTHER rotate, which derives the SAME side and mints in
  // the SAME place — two relay submissions plus a zap-out and a mint every two
  // intervals, for ever, stranding up to the residue bound each iteration.
  //
  // The floor here is the position's OWN WIDTH in bps, so re-rotating a parked
  // position demands the price to have travelled a full range-width AWAY from
  // it — i.e. the parked range is now unreachable and re-parking is genuinely
  // the better answer. Waiting for re-entry is the strategy the owner bought;
  // this is the smallest rule that makes waiting the default without a new
  // durable column.
  const rotateFloorBps = settings.rotateMode === "swapless"
    ? maxBigint(BigInt(settings.rotateBandBps), rangeWidthBps(position))
    : BigInt(settings.rotateBandBps);
  const rotationBreach = settings.autoRotate
    && rotateDeviationBps !== undefined
    && rotateDeviationBps >= rotateFloorBps;
  const rotationContinuous =
    rotationBreach
    && previousIsComparable
    && previousObservation?.rotationBreach === true;
  const rotationConsecutive = rotationBreach
    ? rotationContinuous ? (previousObservation?.rotationConsecutive ?? 0) + 1 : 1
    : 0;
  const rotationBreachStartedAtMs = rotationBreach
    ? rotationContinuous
      ? previousObservation?.rotationBreachStartedAtMs ?? previousObservation?.evaluatedAtMs ?? nowMs
      : nowMs
    : undefined;

  const nextObservation: LpTriggerObservation = {
    blockNumber: market.blockNumber,
    currentTick: position.currentTick,
    evaluatedAtMs: nowMs,
    poolAddress: position.poolAddress,
    ...(protectBreach === undefined ? {} : { protectBreach }),
    ...(protectBreachClass === undefined ? {} : { protectBreachClass }),
    ...(input.settingsDigest === undefined
      ? {}
      : { settingsDigest: input.settingsDigest }),
    protectConsecutive,
    rotationBreach,
    ...(rotationBreachStartedAtMs === undefined ? {} : { rotationBreachStartedAtMs }),
    rotationConsecutive,
    tokenId: position.tokenId,
  };
  const pnlBps = position.basisWei > 0n
    ? ((position.exitValueWei - position.basisWei) * 10_000n) / position.basisWei
    : undefined;
  /**
   * Rides on every result, so the discard is never silent — and FIXREVIEW N3
   * is why that sentence needed a second member: a protect count dropped
   * because the owner re-signed their settings was invisible, in the one field
   * whose whole purpose is that a discard is visible.
   */
  const staleFlag = previousIsStale
    ? { previousObservationDiscarded: "stale" as const }
    : previousObservation !== undefined
        && !settingsUnchanged
        // FIXREVIEW2 P3: only when something was ACTUALLY dropped. A re-sign
        // during a cycle with no protect count in progress discards nothing,
        // and the flag rode receipts — including a rotate that dispatched off
        // its own carried count — saying otherwise.
        && previousObservation.protectConsecutive > 0
      ? { previousObservationDiscarded: "settings-changed" as const }
      : {};

  if (protect.dispatch !== undefined && protectConsecutive >= 2 && railsPassed) {
    return buildResult({
      decision: protect.dispatch.decision,
      input,
      nextObservation,
      pnlBps,
      protectThresholdBps,
      railsPassed,
      ...staleFlag,
      rotateDeviationBps,
      spotTwapDeviationBps,
      ...(firedTrigger === null
        ? {}
        : { triggerTick: firedTrigger.tick, triggerWhen: firedTrigger.when }),
      reason: protect.dispatch.reason,
    });
  }

  const heldLongEnough = rotationBreachStartedAtMs !== undefined
    && nowMs - rotationBreachStartedAtMs >= settings.rotateMinHoldMinutes * 60_000;
  if (rotationBreach && rotationConsecutive >= 2 && heldLongEnough && railsPassed) {
    return buildResult({
      decision: "rotate",
      input,
      nextObservation,
      pnlBps,
      railsPassed,
      ...staleFlag,
      rotateDeviationBps,
      spotTwapDeviationBps,
      reason: "Out-of-range rotation band and minimum hold were confirmed across finalized evaluations.",
      // The threshold the breach was actually measured against — under
      // `rotateMode: "swapless"` that is F1's width floor, not the raw band.
      thresholdBps: rotateFloorBps,
    });
  }

  // --- harvest (priority 2): both legs collectible + value floor -----------
  //
  // PHASE3.12 G1: and the tick must be in the COMPOUNDABLE INTERIOR of the
  // position's own range. Outside it (including ON `tickLower`) the sweep's
  // split is total, so the harvest sells one whole leg and `zap-in-increase`
  // then refuses the single-sided increase AFTER two submissions have
  // confirmed — the Phase 3.11 deadlock. Refusing here costs nothing: the fees
  // stay inside the NFT and the next rotate's zap-out collects them.
  //
  // Deliberately NOT conditioned on `autoRotate` or on whether the rotate
  // fires this cycle (review Q4). Whether a harvest can SUCCEED depends on the
  // tick and the position's own range and on nothing else — and the rotate
  // needs two consecutive cycles plus its hold, so an unconditioned harvest
  // both goes first AND starves the rotate (a wedged sequence stops the
  // position being evaluated, which stales the observation and resets the
  // rotation count to 1, for ever).
  const harvestRangeIsCompoundable = !swapSplitIsTotal(
    position.currentTick,
    position.tickLower,
    position.tickUpper,
  );
  const harvestFeesReady = settings.autoHarvest
    && position.collectibleFee0 > 0n
    && position.collectibleFee1 > 0n
    && position.freshFeesValueWei >= settings.harvestMinFeesWei;
  if (harvestFeesReady && harvestRangeIsCompoundable && railsPassed) {
    return buildResult({
      decision: "harvest",
      input,
      nextObservation,
      pnlBps,
      railsPassed,
      ...staleFlag,
      rotateDeviationBps,
      spotTwapDeviationBps,
      reason: "Both fee legs are collectible and exceed the harvest threshold.",
    });
  }

  let holdReason = "No LP management trigger is ready.";
  if (
    position.basisWei === 0n
    && (settings.stopLossPct > 0 || settings.takeProfitPct > 0)
    // M2: a matched price trigger is protecting this position regardless of the
    // basis, so "protect excluded because the basis is zero" would be false.
    && priceStop === null
    && priceTake === null
  ) {
    holdReason = LP_BASIS_ZERO_HOLD_REASON;
  } else if (railsFailure !== undefined && (protectBreach || rotationBreach || harvestFeesReady)) {
    holdReason = railsFailure.reason;
  } else if (previousIsStale && (protectBreach || rotationBreach)) {
    // Ahead of the "awaits a second evaluation" lines on purpose: an operator
    // reading that sentence after an outage must be told the count RESTARTED,
    // not merely that it is incomplete.
    holdReason = LP_STALE_OBSERVATION_HOLD_REASON;
  } else if (protectBreach && protectConsecutive < 2) {
    holdReason = "Protect breach awaits a second finalized evaluation at least one interval later.";
  } else if (harvestFeesReady && !harvestRangeIsCompoundable) {
    // Ahead of the rotation-pending line on purpose: this is the branch that
    // CHANGED behaviour, and its remedy already carries the rotate's status.
    // An owner watching fees accumulate needs to be told why the harvest they
    // configured is not running, not merely that a rotate is being confirmed.
    holdReason = lpHarvestRangeHoldReason({
      currentTick: position.currentTick,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      autoRotate: settings.autoRotate,
    });
  } else if (rotationBreach && (rotationConsecutive < 2 || !heldLongEnough)) {
    holdReason = "Rotation breach awaits two finalized cycles and the configured minimum hold.";
  } else if (
    settings.autoRotate
    && settings.rotateMode === "swapless"
    && rotateDeviationBps !== undefined
    && !rotationBreach
  ) {
    // PHASE3.13 F1's owner-facing half. Without this the one state swapless
    // exists to produce — parked, out of range, deliberately NOT re-rotating —
    // reads as "No LP management trigger is ready", which is the sentence an
    // owner would open a support ticket about.
    holdReason = lpSwaplessParkedHoldReason({
      currentTick: position.currentTick,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      deviationBps: rotateDeviationBps,
      floorBps: rotateFloorBps,
    });
  } else if (
    settings.autoHarvest
    && (position.collectibleFee0 <= 0n || position.collectibleFee1 <= 0n)
  ) {
    holdReason = "Harvest requires both freshly collectible fee legs to be positive.";
  } else if (settings.autoHarvest && position.freshFeesValueWei < settings.harvestMinFeesWei) {
    holdReason = "Fresh collectible fees are below harvestMinFeesWei.";
  }
  const held = buildResult({
    decision: "hold",
    input,
    nextObservation,
    pnlBps,
    railsPassed,
    ...staleFlag,
    rotateDeviationBps,
    spotTwapDeviationBps,
    reason: holdReason,
  });
  return { ...held, holdReason };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function buildResult(input: {
  decision: LpManagementDecision;
  input: EvaluateLpTriggersInput;
  nextObservation: LpTriggerObservation;
  pnlBps?: bigint | undefined;
  previousObservationDiscarded?: "stale" | "settings-changed" | undefined;
  protectThresholdBps?: bigint | undefined;
  railsPassed: boolean;
  reason: string;
  rotateDeviationBps?: bigint | undefined;
  spotTwapDeviationBps: bigint;
  thresholdBps?: bigint | undefined;
  /**
   * AUDIT A4. M14 added these at the call site and this signature declared
   * neither, so TypeScript's excess-property check does not fire through a
   * spread and both were silently dropped — the receipt could not name the
   * threshold that fired, which is the one thing M14 existed to provide.
   */
  triggerTick?: number | undefined;
  triggerWhen?: "at-or-below" | "at-or-above" | undefined;
}): EvaluateLpTriggersResult {
  const { market, nowMs, position } = input.input;
  const pnlBps = input.pnlBps?.toString();
  const rotateDeviationBps = input.rotateDeviationBps?.toString();
  const thresholdBps = (input.protectThresholdBps ?? input.thresholdBps)?.toString();
  return {
    decision: input.decision,
    nextObservation: input.nextObservation,
    railsPassed: input.railsPassed,
    triggerReason: {
      basisWei: position.basisWei.toString(),
      basisSource: position.basisWei === 0n ? "zero-excluded" : position.basisSource,
      blockNumber: market.blockNumber.toString(),
      currentTick: position.currentTick,
      decision: input.decision,
      exitValueWei: position.exitValueWei.toString(),
      freshFeesValueWei: position.freshFeesValueWei.toString(),
      observedAtMs: nowMs,
      observationCardinality: market.observationCardinality,
      ...(pnlBps === undefined ? {} : { pnlBps }),
      poolAddress: position.poolAddress,
      poolLiquidity: market.poolLiquidity.toString(),
      priceImpactBps: market.priceImpactBps.toString(),
      ...(input.previousObservationDiscarded === undefined
        ? {}
        : { previousObservationDiscarded: input.previousObservationDiscarded }),
      reason: input.reason,
      ...(rotateDeviationBps === undefined ? {} : { rotateDeviationBps }),
      spotTwapDeviationBps: input.spotTwapDeviationBps.toString(),
      ...(thresholdBps === undefined ? {} : { thresholdBps }),
      ...(input.triggerTick === undefined ? {} : { triggerTick: input.triggerTick }),
      ...(input.triggerWhen === undefined ? {} : { triggerWhen: input.triggerWhen }),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      tokenId: position.tokenId,
    },
  };
}

/**
 * Out-of-range deviation in bps from the BREACHED bound, or undefined while
 * in range. Uniswap V3 ranges are lower-inclusive and UPPER-EXCLUSIVE:
 * `currentTick === tickUpper` is out of range.
 */
function maxBigint(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

/**
 * PHASE3.13 F1: the position's OWN range width, in the SAME bps unit
 * `rotationDeviationBps` reports — the squared-price deviation between its two
 * bounds. Deliberately the same `priceDeviationBps` call, so the floor and the
 * quantity it floors cannot be measured on different scales.
 */
function rangeWidthBps(position: LpTriggerPositionInput): bigint {
  return priceDeviationBps(
    getSqrtRatioAtTick(position.tickUpper),
    getSqrtRatioAtTick(position.tickLower),
  );
}

function rotationDeviationBps(position: LpTriggerPositionInput): bigint | undefined {
  if (position.currentTick < position.tickLower) {
    return priceDeviationBps(
      getSqrtRatioAtTick(position.currentTick),
      getSqrtRatioAtTick(position.tickLower),
    );
  }
  if (position.currentTick >= position.tickUpper) {
    return priceDeviationBps(
      getSqrtRatioAtTick(position.currentTick),
      getSqrtRatioAtTick(position.tickUpper),
    );
  }
  return undefined;
}

function validateTriggerInput(input: EvaluateLpTriggersInput): void {
  const { market, position } = input;
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new Error("nowMs must be nonnegative.");
  }
  if (!Number.isInteger(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error("intervalMs must be a positive integer.");
  }
  if (position.basisWei < 0n || position.exitValueWei < 0n || position.freshFeesValueWei < 0n) {
    throw new Error("LP trigger value inputs must be nonnegative.");
  }
  if (position.collectibleFee0 < 0n || position.collectibleFee1 < 0n) {
    throw new Error("Collectible fee legs must be nonnegative.");
  }
  if (
    !Number.isInteger(position.currentTick)
    || !Number.isInteger(position.tickLower)
    || !Number.isInteger(position.tickUpper)
    || position.tickLower >= position.tickUpper
  ) {
    throw new Error("LP trigger ticks are invalid.");
  }
  if (!/^\d+$/u.test(position.tokenId)) {
    throw new Error("LP tokenId must be an unsigned integer.");
  }
  validateLpSettings(input.settings);
  assertValidLpRailConfig(input.rails);
  if (
    market.blockNumber < 0n
    || market.finalizedBlockNumber < 0n
    || market.poolLiquidity < 0n
    || market.priceImpactBps < 0n
    || market.spotSqrtPriceX96 <= 0n
    || market.twapSqrtPriceX96 <= 0n
    || !Number.isInteger(market.observationCardinality)
    || market.observationCardinality < 0
  ) {
    throw new Error("LP trigger market inputs are invalid.");
  }
}
