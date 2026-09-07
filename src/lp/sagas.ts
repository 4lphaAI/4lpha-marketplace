import type { AtomicRotateReceipt, AtomicRotateReceiptIdentity } from "./atomicRotateReceipt.js";
/**
 * LP saga runner (PHASE3-SPEC body "Sagas" + "Sequence journal"; Revision 2
 * items 9–17, 23, 27–28, 31–32; PHASE3-REVIEW R4/R5/R6/R7/R10, OQ2/OQ3).
 *
 * One generic driver ({@link driveSequence}) composes what earlier phases
 * already landed — the pure NFPM/router builders, the rails and floor
 * derivations, the sequence store, the execution journal, the kill-switch
 * boundary — into the three v1 sagas:
 *
 *   protect / manual-exit  [zap-out (unwrap to native), sweep-token? (PHASE3.1)]
 *   rotate                 [zap-out-keep-wbnb, sweep-token?, mint-wbnb]
 *   harvest                [collect-fees, sweep-token?, zap-in-increase]
 *
 * PHASE3.1 gave the exit its second position: `exitToQuote` converts the freed
 * NON-quote leg into the quote asset, because a stop-loss that hands back the
 * asset it stopped out of has done the mechanical half of its job only
 * (FINDINGS (ag)). That step is OPTIONAL ({@link PlannedStep.optional}) — by
 * the time it runs every asset is already in the owner's wallet, so its
 * refusals are recorded SKIPS and the sequence still COMPLETES. A stop-loss
 * must never appear unfinished because its cosmetic leg could not run.
 *
 * ─── DIVISION OF AUTHORITY, RESTATED (Rev2 item 9) ─────────────────────────
 *
 * The EXECUTION JOURNAL is the single authority on step OUTCOMES; the
 * sequence store is the authority on ORDER and RESUME; this module is the
 * only place the two are joined, and it never writes an outcome anywhere but
 * the journal. Every step is ONE journal row, kind `lp`, decision id
 * `lp:<sequenceId>:<stepIndex>`, and goes through the /trade route's proven
 * skeleton per step: `withSessionKey → restoreSession → preflightExecute`
 * ABOVE the submit try, the submit alone inside it. Classification is
 * POSITIONAL (PHASE2.4 R3): thrown above the submit ⇒ ROLLED_BACK and the
 * step provably never reached a relay; thrown inside ⇒ UNKNOWN and the
 * sequence HOLDS until `reconcile` resolves the row. Ambiguity never
 * auto-replays, and no idempotency key is ever submitted twice — a retried
 * step is a NEW recorded step with a fresh key (see the resume notes below).
 *
 * ─── RESUME SEMANTICS ──────────────────────────────────────────────────────
 *
 * Progress is derived with the store's own {@link deriveLpSequenceProgress},
 * fed the journal rows keyed by each step's idempotency key — with one driver
 * decision layered on top, exactly where the store's docstring places it
 * ("the DRIVER decides between retrying the step and rolling the sequence
 * back"): a ROLLED_BACK step provably MOVED NO MONEY — either it never reached
 * a relay, or it reached one and failed (PHASE3.1-FIXREVIEW4 I2 corrected the
 * stronger "never reached a relay", which is false of a relay-FAILED row and is
 * NOT what this join needs) — so its recorded slot is treated as OPEN and a
 * later append of the same kind is its retry —
 * and so is a recorded step whose journal row was NEVER CREATED (a crash in
 * the appendStep→begin window; audit A1 — begin precedes every submit path,
 * so a missing row is provably unsubmitted). The join therefore runs over the
 * steps whose journal row exists and is not rolled back; anything PENDING /
 * IN_PROGRESS / UNKNOWN holds the whole sequence. Confirmed steps
 * are REPLAYED (their `after` hooks run from the journal row's txHash) so
 * every money amount carried forward — the sweep's amountIn above all — comes
 * from CONFIRMED RECEIPTS, never a balance re-read (Rev2 item 32 / OQ3).
 *
 * A refusal before any money moved rolls the SEQUENCE back and frees the
 * position (one non-terminal sequence per position — a parked empty rotate
 * would block a later protect). A refusal after money moved parks the
 * sequence in its stated recovery state (`pending-mint` / `pending-increase`
 * / `wbnb-stranded`) — non-terminal, resumed next cycle. A sequence holding
 * on an AMBIGUOUS row keeps its lock either way: `held` when a recovery
 * state names where the funds sit, otherwise it simply stays `active`
 * (a `held`+`none` sequence would read as terminal and release the position
 * under an unresolved submit, which is the double-drive the store's
 * constraint exists to stop).
 *
 * ─── GATES BETWEEN EVERY STEP (Rev2 items 16, 21, 23) ──────────────────────
 *
 * Before each step, in order: the owner-settings digest is re-compared (a
 * settings change invalidates in-flight automation); `authorizeExecute` runs
 * with the FINDINGS (s) carve-out — protect and manual-exit steps are
 * exposure-reducing, open/rotate/harvest run strict on their
 * exposure-increasing steps, and a quota-bound sequence that has not yet
 * moved money runs strict outright so no new rotate/harvest starts under
 * pause (an in-flight rotate may finish its zap-out, then holds at
 * `pending-mint` — the stated safe state); the manipulation rails are
 * re-checked on FRESH evidence; and every floor is derived server-side from a
 * fresh quote or the rail-checked price (`sagaSwapMinOut` / `sagaMintFloors`
 * / `sagaDecreaseFloors`), with `deadline = now + TRADE_DEADLINE_SEC`.
 *
 * ─── THE BRAIN SEAM IS STRUCTURAL (Rev2 item 28) ───────────────────────────
 *
 * Only {@link runLpRotate} accepts the optional `proposeRange` callback, and
 * only through {@link LpRotateDeps}. The protect/manual-exit construction
 * ({@link runLpProtect} / {@link runLpManualExit}) takes {@link LpSagaDeps},
 * which has no such field — the protect path cannot receive a brain even by
 * mistake, and a test drives a protect+rotate-both-eligible cycle asserting
 * zero brain calls. Every proposal goes through `validateBrainProposal`; any
 * fence failure or an unreachable brain falls back to the deterministic
 * `centeredRotationRange`.
 *
 * PURE OF I/O BY INJECTION: no RPC happens in this module. Chain reads arrive
 * through narrow reader interfaces ({@link LpMarketReader},
 * {@link LpPositionsReader}, {@link LpQuoteReader}, {@link LpReceiptReader})
 * exactly as the provider seam does it, so the whole runner is testable
 * offline against fakes.
 */
import { recordLpFeeEvents } from "./feeRecorder.js";

import type { Address, Hex } from "viem";
import type {
  ExecutionReceipt,
  SessionRef,
  WalletCall,
  WalletProvider,
} from "../core/types.js";
import { ExecutionPlaneError, ProviderError } from "../core/types.js";
import { mapProviderError, sanitizeMessage } from "../core/errors.js";
import { authorizeExecute, executeIdempotencyKey } from "../auth/executeDecision.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal, JournalEntry } from "../store/journal.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import {
  LpExitQuotaError,
  LpPositionNotFoundError,
  LpPositionResolvingError,
  deriveLpSequenceProgress,
  lpStepDecisionId,
  type LpExitQuota,
  type LpRecenterEvidence,
  type LpShiftCause,
  type LpPositionRecord,
  type LpRecoveryState,
  type LpSequenceKind,
  type LpSequenceStep,
  type LpSequenceStore,
  type LpStepKind,
  type LpStepOutcomeState,
} from "../store/lpSequences.js";
import { hashCalls } from "../http/wire.js";
import { exceedsDailyCap } from "../rules/engine.js";
import { agentAuthorityFromPrivateKey } from "../wallet/altana.js";
import {
  fingerprintLpFinalCallsV1,
  isProvenPreBindStagedLpError,
} from "./preparedIntent.js";
import { DEFAULT_TRADE_DEADLINE_SEC } from "../ops/config.js";
import {
  buildCollectToWallet,
  buildLpIncreaseBatch,
  buildLpMintWbnbBatch,
  buildLpZapOutBatch,
  buildLpZapOutKeepWbnbBatch,
} from "../ops/nfpm.js";
import { buildLpExitSwap, buildLpSweepSwap } from "../ops/pancakeV3.js";
import {
  amountInAfterPoolFee,
  checkManipulationRails,
  quotePriceImpactBps,
  sagaDecreaseFloors,
  sagaMintFloors,
  sagaSingleSidedMintFloors,
  sagaSwapMinOut,
  spotSwapOutput,
  type LpRailConfig,
  type LpRailEvidence,
  type LpRailFailureCode,
} from "./rails.js";
import {
  computeSwapAmount,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  swapSplitIsTotal,
} from "./tickMath.js";
import {
  lpHarvestRangeHoldReason,
  ladderMinMarkoutBps,
  lpSwaplessRotateReason,
  type LpGridLadder,
  // PHASE3.22 — aliased because this module spends the `LpGridShift` name on
  // its own `LpGridShiftDeps`/`LpGridShiftRow` family.
  type LpGridShift as LpGridShiftSettings,
  type LpRotateMode,
} from "./triggers.js";
import {
  gridLadderHedgePlan,
  gridLadderMarkout,
  gridLadderRemintSide,
  gridRequoteG0,
  gridShiftFunding,
  gridShiftDriftMotionsPerDay,
  gridShiftSideFloors,
  gridSideChargesQuote,
  gridTargetSide,
  lpGridFlipReason,
  lpGridLadderHedgeSkipNote,
  lpGridLadderRefusal,
  type LpGridRole,
  lpGridRequoteRefusal,
  lpGridShiftFundingHoldReason,
  lpGridShiftRefusal,
} from "./gridTriggers.js";
import type { LpGridCycleStore } from "../store/gridCycles.js";
import { createPositionForArmGroup } from "../store/lpSequences.js";
import { buildApprove } from "../ops/pancake.js";
import {
  adjacentRotationRange,
  centeredRotationRange,
  swaplessResidueWithinBound,
  swaplessRotationSide,
  validateBrainProposal,
  type RangeFenceContext,
  type SwaplessRotationSide,
} from "./fence.js";

/* -------------------------------------------------------------------------- */
/* Narrow injected readers (no RPC in this module)                            */
/* -------------------------------------------------------------------------- */

/**
 * The rail evidence PLUS the current tick — everything a between-step check
 * and a range/sweep decision need from one observation. The caller reads it
 * at/below the finalized block exactly as the trigger evaluator requires.
 */
export type LpSagaMarket = LpRailEvidence & { readonly currentTick: number };

export type LpMarketReader = () => Promise<LpSagaMarket>;

/**
 * What `positions(tokenId)` answers for a live token.
 *
 * The first three fields are all any saga has ever needed. PHASE3.4 (Rev2 M13)
 * surfaces the rest of the struct the ABI was already decoding and the reader
 * was throwing away, because the IMPORT path needs what the sagas never did:
 * the LEGS (an import must read them from chain rather than trust a caller —
 * the worker derives the pool purely from the stored row, so a row whose legs
 * did not match its NFT would be valued and rotated against the wrong pool with
 * nothing to detect it) and the per-token `operator` (a nonzero one is an
 * outstanding third-party approval that can yank the NFT out from under the
 * automation mid-management).
 *
 * Optional, so every existing hand-built test snapshot still typechecks; the
 * import route requires them and refuses a reader that cannot supply them.
 */
/**
 * Whether a terminal sequence PROVABLY made no relay submission, and may
 * therefore hand its exit-quota slot back (PHASE3.5 Rev2 M1).
 *
 * DELIBERATELY NARROWER THAN `driveSequence`'s retry predicate, and the spec's
 * first draft conflated the two. The retry join asks "is this plan slot open?"
 * and answers yes for any `ROLLED_BACK` row — which is right for retries and
 * WRONG here, because two rows in this codebase reach the relay and still end
 * `ROLLED_BACK`:
 *
 *   - the FAILED-receipt rollback, where `markInProgress{callsId}` runs BEFORE
 *     `markRolledBack` (`makeStep`'s confirm path, and the same shape in
 *     `runLpOpen`);
 *   - `reconcile`'s FAILED resolution, where a `callsId` is present by
 *     construction.
 *
 * Both drew relay gas, and `maxExitSequencesPerDay` is a proxy for the gas
 * meter — `checkLpNativeCapSizing` leans on it being an upper bound on
 * submission-MAKING sequences. So the test is the `callsId ?? txHash` idiom
 * (PHASE3.1-FIXREVIEW3 H5): a row that ever learned either reached a relay.
 *
 * A `resolution` marker excludes a row too: that one came from `UNKNOWN` via
 * the owner-signed abandon, whose evidence is that the EFFECT is absent — which
 * cannot discharge gas, because the relay may have taken the bundle
 * (FINDINGS (aa)) and this deployment cannot read logs to check.
 *
 * An ABSENT row is releasable: `appendStep` runs strictly before
 * `beginWithSpend`, which runs strictly before any submit, so a missing row can
 * only mean the process died in that window. Zero recorded steps likewise.
 */
export function lpReservationReleasable(
  rows: ReadonlyMap<string, JournalEntry | null>,
  steps: readonly { readonly journalIdempotencyKey: string }[],
): boolean {
  for (const step of steps) {
    const row = rows.get(step.journalIdempotencyKey);
    if (row === undefined || row === null) continue; // never began
    if (row.state !== "ROLLED_BACK") return false;
    if (row.externalRef.resolution !== undefined) return false;
    if (row.externalRef.callsId !== undefined) return false;
    if (row.externalRef.txHash !== undefined) return false;
  }
  return true;
}

export type LpPositionSnapshot = {
  readonly liquidity: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly token0?: Address;
  readonly token1?: Address;
  readonly fee?: number;
  /** NFPM per-token approval. `0x00…00` means none. */
  readonly operator?: Address;
};

/**
 * Pinned-RPC `positions(tokenId)` read. Ordinary valuation/post-verify calls
 * omit the height and use latest (OQ3); a resolution whose answer can close a
 * row supplies its finalized height explicitly. The reader maps the
 * burned-token revert to literal `"burned"`, positive confirmation rather than
 * an error to retry.
 */
export type LpPositionsReader = (
  tokenId: bigint,
  /** Omitted for ordinary valuation; present for a decision that closes state. */
  blockNumber?: bigint,
  /** When present, the pinned reader must prove this exact finalized lineage. */
  expectedBlockHash?: Hex,
) => Promise<LpPositionSnapshot | "burned">;

/** A FRESH QuoterV2 single-hop quote: the swap's expected output, in wei. */
export type LpQuoteReader = (params: {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly amountInWei: bigint;
}) => Promise<bigint>;

/**
 * Money amounts from CONFIRMED receipts — the only place a carried amount may
 * come from (Rev2 item 32: "money amounts come only from confirmed
 * receipts"). Implementations parse the transaction's own logs; the driver
 * never re-reads a balance to learn what a step moved.
 *
 * ─── PHASE3.19 item 6 — THE CHARTER, AMENDED RATHER THAN VIOLATED ──────────
 *
 * The sentence above is REVISED, in the same commit that makes the revision
 * necessary, so the next auditor does not read a live contradiction:
 *
 *   - the amount a step **MOVED** still comes ONLY from a confirmed receipt.
 *     Nothing about that has changed, and every existing saga is untouched;
 *   - the amount a step **INTENDS TO MOVE** may come from a BALANCE READ at
 *     BUILD time — in the LADDER saga (`runLpGridRecenter`) and NOWHERE ELSE.
 *
 * The widening is forced and it is bounded. It is FORCED because the ladder's
 * whole mechanism is an idle BUFFER: a buffer-funded mint and a
 * buffer-sized hedge are, by definition, sized on a standing balance rather than
 * on what the previous step freed, and `planLpSweep`'s clamp to
 * `wbnbFreedWei`/`tokenFreedWei` CANNOT express either. It is BOUNDED because
 * the reader is {@link LpSagaDeps.walletTokenBalance}, which is OPTIONAL — so
 * `tsc` proves no other saga can reach it — and because the INTENT it produces
 * is PERSISTED BEFORE THE SUBMIT (`hedge_direction`/`hedge_amount_in_wei`),
 * persisted-wins, so a resume rebinds the SAME swap rather than re-deriving a
 * different one at a different price.
 */
export type LpReceiptReader = {
  atomicRotateReceipt?(txHash: Hex, identity: AtomicRotateReceiptIdentity): Promise<AtomicRotateReceipt>;
  /** Optional reporting seam: missing wiring means unavailable history. */
  feeEvents?(txHash: Hex, atomic?: { readonly oldTokenId: bigint; readonly wallet: Address; readonly token0: Address; readonly token1: Address; readonly fee: number }): Promise<import("./feeTelemetry.js").LpFeeReceipt>;
  /** Collect deltas (pool order) from a confirmed zap-out/collect tx. */
  collectAmounts(txHash: Hex): Promise<{
    readonly amount0Wei: bigint;
    readonly amount1Wei: bigint;
  }>;
  /** Exact legs of a confirmed sweep swap. */
  swapAmounts(txHash: Hex): Promise<{
    readonly tokenIn: Address;
    readonly amountInWei: bigint;
    readonly tokenOut: Address;
    readonly amountOutWei: bigint;
  }>;
  /**
   * PHASE3.24 C3 — the dedicated atomic-exit witness. It examines every V3
   * Swap-topic log and accepts only one log from the expected pool with the
   * expected base-input orientation. It is deliberately not `swapAmounts`.
   * Optional only for pre-3.24 fakes; a consented production path refuses when
   * absent.
   */
  expectedPoolSwap?(
    txHash: Hex,
    expectedPool: Address,
    baseIsToken0: boolean,
  ): Promise<{ readonly amountInWei: bigint; readonly amountOutWei: bigint } | null>;
  /** The tokenId a confirmed mint produced. */
  mintedTokenId(txHash: Hex): Promise<bigint>;
  /**
   * PHASE3.17 R2.8 — the tokenIds a confirmed multi-mint batch produced,
   * ordered by log index.
   *
   * PHASE3.22 R4.2.6 WIDENED IT from "exactly two" to ONE OR TWO, because a
   * one-sided shift mints a single rung. THE COUNT IS NOW THE CALLER'S
   * ASSERTION, bound by the mint set its own plan recorded: the dual arm still
   * requires exactly two at its seam, and the shift's finish requires exactly
   * what its batch contained. Two ids are always sell-then-buy with
   * `sellTokenId < buyTokenId` asserted; one id belongs to the one recorded
   * role.
   *
   * OPTIONAL, and the optionality is load-bearing in one direction only: the
   * wired reader always supplies it, and the dual-arm `finish` refuses
   * fail-closed when it is absent rather than inventing a second id. Every
   * pre-3.17 fake in the tree implements this type, and none of them can
   * produce a two-mint receipt — so requiring the method would have forced an
   * edit into suites this phase must leave byte-identical.
   */
  mintedTokenIds?(txHash: Hex): Promise<readonly bigint[]>;
  /**
   * PHASE3.19 item 38 (review M2) — the amounts a confirmed MINT consumed, from
   * the NFPM's own `IncreaseLiquidity` log.
   *
   * WHY IT EXISTS: the cycle ledger is supposed to derive from CONFIRMED
   * RECEIPTS, and there was no reader for what a mint took — the flip gets those
   * from `state.mintPlan`, set in `build`, which is exactly why `finish` writes
   * NOTHING on a pure resume. FINDINGS (aw) records resume as the DEFAULT path
   * (6 of 6 mainnet submissions), so "the ledger is written on the live path"
   * meant "the ledger is usually not written". That is the (aw) residual, and
   * this reader is what closes it.
   *
   * OPTIONAL, for the reason {@link mintedTokenIds} is: every pre-3.19 fake in
   * the tree implements this type and none can produce the log, so REQUIRING it
   * would force edits into suites this phase must leave byte-identical. Absent
   * ⇒ the ledger falls back to the in-process plan exactly as it does today, so
   * nothing regresses.
   */
  mintAmounts?(txHash: Hex): Promise<{
    readonly amount0Wei: bigint;
    readonly amount1Wei: bigint;
  }>;
};

/**
 * PHASE3.17 R3.3 — a QuoterV2 quote that ALSO carries the simulated post-swap
 * price, for the one gate that needs it.
 *
 * A SECOND reader type beside {@link LpQuoteReader}, never a widening of it:
 * that function type is consumed at seven sites across four modules and none of
 * them wants a second field. See `quoteWithPriceAfter` in `src/lp/readers.ts`.
 */
export type LpQuoteWithPriceAfterReader = (params: {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly amountInWei: bigint;
}) => Promise<{ readonly amountOutWei: bigint; readonly sqrtPriceX96After: bigint }>;

/** The CURRENTLY stored owner-settings digest for this agent. */
export type LpSettingsDigestReader = () => Promise<Hex>;

/* -------------------------------------------------------------------------- */
/* Deps                                                                       */
/* -------------------------------------------------------------------------- */

export type LpSagaVenue = {
  /** The NonfungiblePositionManager, from resolved config — never a request. */
  readonly nfpm: Address;
  /** The dedicated V3 SwapRouter (pinned since 2.2). */
  readonly routerV3: Address;
  readonly wbnb: Address;
};

/**
 * Everything the driver needs. DELIBERATELY brain-free: this is the deps type
 * the protect and manual-exit sagas take, so the brain seam cannot leak into
 * them (Rev2 item 28). Rotate extends it with {@link LpRotateDeps}.
 */
export type LpSagaDeps = {
  readonly feeEvents?: import("../store/lpFeeEvents.js").LpFeeEventStore;
  readonly feeSignal?: AbortSignal;
  readonly agent: AgentRecord;
  readonly agentStore: AgentStore;
  readonly provider: WalletProvider;
  readonly journal: ExecutionJournal;
  readonly store: LpSequenceStore;
  readonly killswitch: KillSwitch;
  /** Resolved rail config. Resolution failures hold UPSTREAM (worker), not here. */
  readonly rails: LpRailConfig;
  /** The owner-signed exit quota the reservation enforces. */
  readonly quota: LpExitQuota;
  readonly market: LpMarketReader;
  readonly positions: LpPositionsReader;
  readonly quote: LpQuoteReader;
  /**
   * PHASE3.17 R3.3 — OPTIONAL, and used by exactly one plan: the DUAL grid
   * arm's post-swap sell gate. Absent ⇒ that plan refuses fail-closed before
   * any money, which is the correct posture for a gate whose whole job is to
   * stop a systematic revert. Every other saga is unaffected and every existing
   * deps object still type-checks unchanged.
   */
  readonly quoteWithPriceAfter?: LpQuoteWithPriceAfterReader;
  /**
   * PHASE3.19 item 5 (review B2) — the wallet's balance of one ERC-20, named for
   * exactly what it is.
   *
   * OPTIONAL, and the optionality is the enforcement: every existing fake and
   * every existing saga is untouched, and `tsc` proves that only the code that
   * asks for it can use it. The LADDER saga refuses FAIL-CLOSED when it is
   * absent, which is the `quoteWithPriceAfter` precedent — a mechanism whose
   * whole job is to size a mint from the buffer must not degrade to sizing it
   * from something else.
   *
   * IT NEVER TELLS THE DRIVER WHAT A STEP MOVED. See the amended charter on
   * {@link LpReceiptReader}: receipts remain the only source for that, and this
   * reader answers only "what does the wallet hold, so what may the next call
   * INTEND to move" — an intent that is then persisted before the submit.
   */
  readonly walletTokenBalance?: (token: Address) => Promise<bigint>;
  readonly receipts: LpReceiptReader;
  /** PHASE3.24 C3 / AUDIT A1+A9 — required pool for the dedicated Swap witness. */
  readonly expectedPool: Address;
  /** PHASE3.24 R3.6 / AUDIT A1+A9 — required boot-resolved conversion allowlist. */
  readonly conversionCompatibleTokens: ReadonlySet<Address>;
  /**
   * The digest this sequence was ARMED under. The ROUTE layer owns computing
   * it (`paramsHash("lpSettings", params)` — Rev2 item 21); the runner only
   * compares it against {@link currentSettingsDigest} and refuses on mismatch
   * before every step, so an owner settings change invalidates in-flight
   * automation.
   */
  readonly settingsDigest: Hex;
  readonly currentSettingsDigest: LpSettingsDigestReader;
  /**
   * PHASE3.1 Rev2 item 8: the owner's `exitToQuote` setting, REQUIRED and
   * never optional-with-a-default. Protect and manual exit convert the freed
   * non-quote leg into `position.quoteToken` when it is true; `false`
   * reproduces Phase 3 exactly.
   *
   * Required so a FORGOTTEN WIRING IS A COMPILE ERROR. A silent default here
   * would be Phase 3's own defect — an exit that quietly does half its job —
   * wearing this phase's version number.
   */
  readonly exitToQuote: boolean;
  /**
   * PHASE3.13 F12 — the ride-along the Phase 3.12 Part 1 audit's Ruling 1
   * deferred to this phase, in writing.
   *
   * The harvest's G2 refusal (`collect-fees.build`) speaks the SAME sentence as
   * the trigger's G1 hold, and Q1 requires that sentence's remedy to be
   * conditional on the owner's own `autoRotate` — telling an owner who already
   * has rotation on to turn it on is how a product teaches people to ignore it.
   * Part 1 could not: `LpSagaDeps` carried no settings, so the saga seam passed
   * no flag and `lpHarvestRangeHoldReason` stated BOTH branches. That arm is now
   * retired and this dep is why.
   *
   * REQUIRED, like {@link exitToQuote} and for the same reason: a forgotten
   * wiring must be a compile error, not a guess about what the owner signed.
   */
  readonly autoRotate: boolean;
  /**
   * `LP_RELAY_FEE_PER_SUBMIT_WEI` (Rev2 item 17): the DUST FLOOR the exit swap
   * compares its fresh quote against. Deliberately the whole-submission
   * RESERVE constant rather than a second calibrated number, so the floor
   * moves with the constant the moment a live run replaces the placeholder.
   *
   * REQUIRED HERE, but NOT with {@link exitToQuote}'s full guarantee, and
   * PHASE3.1-AUDIT A10 is right that the two docstrings used to claim it was.
   * `exitToQuote` has no defensible default anywhere on the path, so item 8's
   * "a forgotten wiring is a compile error" holds end to end. This one does
   * have one — {@link DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI}, the same constant
   * the sizing arithmetic uses — and `createServer` applies it when the
   * optional `LpServerDeps.relayFeePerSubmitWei` is absent, so a wiring
   * forgotten at THAT seam is a silent default rather than a compile error.
   * Unreachable in a wired deployment (`buildLpServerDeps` always resolves the
   * env key, and a malformed value throws at boot rather than defaulting), and
   * the cost of the residual is one over-conservative dust skip against the
   * plane's own published constant — never a wrong number nobody chose.
   */
  readonly relayFeePerSubmitWei: bigint;
  readonly venue: LpSagaVenue;
  /** Injected clock, epoch MILLISECONDS. */
  readonly now: () => number;
  /** Swap/NFPM deadline horizon, SECONDS. Defaults to the 2.x constant. */
  readonly deadlineSec?: number;
};

/** The context a range proposal is asked against. Data, never authority. */
export type LpRangeProposalContext = {
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly maxTickWidth: number;
  readonly priorWidthTicks: number;
};

/**
 * Rotate's deps: the ONLY saga deps type that carries the brain seam.
 * `proposeRange` is optional and UNTRUSTED — its reply goes through
 * `validateBrainProposal` and any failure (or the callback throwing) falls
 * back to the deterministic `centeredRotationRange`. The brain being down
 * never blocks a triggered rotate.
 */
export type LpRotateDeps = LpSagaDeps & {
  /** Boot-resolved preference; existing injected legacy callers omit it. */
  readonly atomicRotate?: boolean;
  /** Pool tick spacing, read from the factory/pool by the caller. */
  readonly tickSpacing: number;
  /** Fence ceiling on `tickUpper - tickLower`. */
  readonly maxTickWidth: number;
  /**
   * PHASE3.13: the owner-signed rotate shape. REQUIRED, same posture as
   * {@link LpSagaDeps.exitToQuote} — a forgotten wiring is a compile error, and
   * there is no defensible server-side default for a setting that changes the
   * position's EXPOSURE.
   *
   * It lives HERE and not on {@link LpSagaDeps} on purpose (review F9): the
   * server never dispatches a rotate, so putting it on the shared type would
   * force `src/server.ts` to declare a mode for a saga it does not run — and,
   * worse, would hand it to `makeSweepStep`, which the exit and the harvest
   * share. The sweep constructor receives the swapless DECISION as a step
   * input instead, so `tsc` proves the other two sweeps are untouched.
   */
  readonly rotateMode: LpRotateMode;
  readonly proposeRange?: (
    context: LpRangeProposalContext,
  ) => Promise<unknown>;
};

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type LpSagaRunCode =
  | "COMPLETED"
  | "NO_SESSION"
  | "SESSION_EXPIRED"
  | "AGENT_PAUSED"
  | "GLOBAL_HALT"
  | "AGENT_NOT_ARMED"
  | "SETTINGS_DIGEST_MISMATCH"
  | "QUOTA"
  | "DAILY_CAP"
  | LpRailFailureCode
  | "BUILD_REFUSED"
  | "STEP_REFUSED"
  | "HELD_AMBIGUOUS"
  | "POST_VERIFY_FAILED"
  | "PLAN_MISMATCH"
  | "SEQUENCE_CONFLICT"
  /**
   * A resolver (landing resolution / pre-bind retirement) holds the sequence
   * row under its own fence, so this saga wrote nothing and decided nothing
   * (PHASE3.11 R-D). Distinct from `SEQUENCE_CONFLICT`, which is another
   * SEQUENCE on the same position.
   */
  | "SEQUENCE_FENCED";

export type LpSagaRunResult = {
  readonly sequenceId: string;
  readonly kind: LpSequenceKind;
  readonly status: "completed" | "held" | "rolled-back";
  readonly code: LpSagaRunCode;
  /** Sanitized. Callers branch on `code`, never on this text. */
  readonly reason: string;
  /** Plan positions confirmed (skipped steps included — they are complete). */
  readonly confirmedSteps: number;
};

/* -------------------------------------------------------------------------- */
/* The sweep split (pure, exported for tests)                                 */
/* -------------------------------------------------------------------------- */

export type LpSweepPlan = {
  readonly direction: "wbnb-to-token" | "token-to-wbnb";
  readonly amountInWei: bigint;
};

/**
 * Decide whether the freed legs need a sweep before re-entry, and in which
 * direction — `computeSwapAmount` decides (the ported 0G linear-in-tick
 * split), so a `null` here is a SKIPPED step, recorded as such.
 *
 * Method, stated: the TOKEN side is valued into WBNB at the RAIL-CHECKED spot
 * price; `computeSwapAmount` answers how much of an all-WBNB stake the range
 * would want swapped into TOKEN; the difference against what already sits on
 * the TOKEN side, clamped to what was actually freed, is the sweep. The split
 * is the same linear approximation `computeSwapAmount` itself is — an
 * out-of-range exit frees (almost) everything in ONE leg, which is the case
 * the math is exact for — and the executed swap is still floor-bounded by a
 * fresh quote via `sagaSwapMinOut`, so the approximation risks dust in the
 * mint, never an unbounded execution.
 */
export function planLpSweep(input: {
  readonly wbnbFreedWei: bigint;
  readonly tokenFreedWei: bigint;
  readonly wbnbIsToken0: boolean;
  readonly currentTick: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly spotSqrtPriceX96: bigint;
}): LpSweepPlan | null {
  if (input.wbnbFreedWei < 0n || input.tokenFreedWei < 0n) {
    throw new Error("planLpSweep: freed amounts must be nonnegative.");
  }
  if (input.wbnbFreedWei === 0n && input.tokenFreedWei === 0n) return null;

  const tokenValueInWbnb = spotSwapOutput({
    amountInAfterFee: input.tokenFreedWei,
    sqrtPriceX96: input.spotSqrtPriceX96,
    tokenInIsToken0: !input.wbnbIsToken0,
  });
  const totalWbnbValue = input.wbnbFreedWei + tokenValueInWbnb;
  if (totalWbnbValue <= 0n) return null;

  const targetTokenValue = computeSwapAmount(
    totalWbnbValue,
    input.currentTick,
    input.tickLower,
    input.tickUpper,
    input.wbnbIsToken0,
  );

  if (tokenValueInWbnb < targetTokenValue) {
    const wanted = targetTokenValue - tokenValueInWbnb;
    const amountIn = wanted < input.wbnbFreedWei ? wanted : input.wbnbFreedWei;
    return amountIn <= 0n
      ? null
      : { direction: "wbnb-to-token", amountInWei: amountIn };
  }
  if (tokenValueInWbnb > targetTokenValue) {
    const excessValue = tokenValueInWbnb - targetTokenValue;
    const excessInToken = spotSwapOutput({
      amountInAfterFee: excessValue,
      sqrtPriceX96: input.spotSqrtPriceX96,
      tokenInIsToken0: input.wbnbIsToken0,
    });
    const amountIn =
      excessInToken < input.tokenFreedWei ? excessInToken : input.tokenFreedWei;
    return amountIn <= 0n
      ? null
      : { direction: "token-to-wbnb", amountInWei: amountIn };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Internal plumbing                                                          */
/* -------------------------------------------------------------------------- */

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * PHASE3.1-AUDIT A1: how many times an OPTIONAL step RETRIES a TRANSPORT-class
 * failure before it gives up and records the terminal skip.
 *
 * THE FINDING. Rev2 item 12's table converts *refusals* on the optional step
 * into recorded skips, and a skip is TERMINAL: the plan advances, the sequence
 * completes, the lineage is closed and the basis zeroed, so there is no second
 * chance and the owner keeps the volatile leg for ever. The build applied that
 * to *any* failure, transport included — and a rate-limited dataseed at the
 * exact moment a stop-loss fires (FINDINGS (ad) records these endpoints as
 * lossy enough to warrant a fallback list) is not a product decision. It
 * resolves within one worker cycle, exactly like the GLOBAL_HALT and
 * SETTINGS_DIGEST_MISMATCH carve-outs item 12 *did* think about.
 *
 * WHY BOUNDED. An unbounded hold re-opens the trap item 15 refused: a sequence
 * that can never finish. Past the budget the step is skipped with a reason that
 * SAYS the failure was transient and how many attempts were actually made, so
 * an operator can tell it from a deliberate refusal.
 *
 * WHY ATTEMPTS, NOT WALL CLOCK (PHASE3.1-FIXREVIEW F2). The first fix pass
 * bounded this with a 30-minute window anchored on the SEQUENCE's `createdAt`,
 * which measured the wrong thing twice over:
 *
 *   - a sequence that reached the optional step LATE — a `GLOBAL_HALT` hold
 *     "which may last hours", a `SETTINGS_DIGEST_MISMATCH` while the owner
 *     re-arms, a PENDING step 0 resolved by `reconcile` (FINDINGS (aa)), an
 *     A13 park — got ZERO retries, and then recorded "retry window exhausted"
 *     about a step that had run exactly once. That is the "looks like the
 *     system working" shape this repo is careful about, arriving inside the fix
 *     for it;
 *   - the budget silently varied between ~3 and ~60 attempts with
 *     `LP_WORKER_INTERVAL_SEC`, which is a deployment's cadence, not a policy.
 *
 * An attempt count is what the budget was always trying to express: each unit
 * is one real retry, and it means the same thing at a 30-second cadence and at
 * a ten-minute one. It is also SELF-ANCHORING — there is no timestamp to get
 * wrong, because attempt one is by construction the step's first failure — and
 * it bounds the row growth PHASE3.1-FIXREVIEW F6 recorded, which a wall clock
 * did not.
 *
 * The count is PERSISTED, not held in process memory. Every transient hold
 * records one provably-unsubmitted (`ROLLED_BACK`) journal row for the step, so
 * the attempts survive a restart — FINDINGS (ae) is the standing reminder of
 * what a counter in a `Map` is worth.
 *
 * NOT WIDENED BEYOND THE AUDIT'S OWN SPLIT: the product refusals — the flag
 * off, a zero leg, dust, and impact over the manipulation rail — stay terminal
 * skips exactly as built, and so does the sibling between-step rails check,
 * which is the same deliberate market gate wearing a different name.
 */
export const OPTIONAL_TRANSIENT_RETRY_ATTEMPTS = 6;

/**
 * The exact `lastError` a rolled-back row carries when the TRANSIENT path wrote
 * it — and the ONLY thing {@link OPTIONAL_TRANSIENT_RETRY_ATTEMPTS} is spent on.
 *
 * PHASE3.1-FIXREVIEW2 **G1**. The budget used to be a count of every trailing
 * provably-unsubmitted row at the plan position, whatever refused it. That is
 * one unit wider than the thing it is a budget FOR: the late kill-switch
 * re-check rolls its row back and then HOLDS (the window between the early check
 * and the late one spans `deps.market()`, the rails check, `build`'s RPC quote,
 * `appendStep` and `beginWithSpend` — seconds, not microseconds), and a
 * `GLOBAL_HALT` is not an attempt at anything. In the limit five such rows made
 * the FIRST transient failure report `all 6 of 6 attempts, retries exhausted`,
 * which is verbatim the sentence F2 was filed about, arriving through the fix
 * for it.
 *
 * WHY A REASON STRING AND NOT A NEW COLUMN. The journal's `lastError` is written
 * by the same code that classifies the failure, one line apart, so the
 * attribution is recorded where the decision was made rather than inferred later
 * — and no store migration, no new state, and nothing for the two backends to
 * drift on. It is the first thing `lastError` is READ for; everywhere else it is
 * an audit detail, so the format is fixed HERE, produced only by
 * {@link transientRollbackReason}, and matched against an ANCHORED pattern that
 * upstream prose cannot forge (`sanitizeMessage` leaves it byte-identical: no
 * URL, no long hex, no whitespace run, well under the 280- and 300-character
 * caps that would truncate it).
 *
 * ONE-SHOT UPGRADE EFFECT, so nobody has to rediscover it in production
 * (PHASE3.1-FIXREVIEW3 **H7**). Rows written by the PREVIOUS build's preflight
 * site carried `Refused before submission: <code>.` with no `(transient)`, so
 * they fail this pattern: a sequence already in flight across the deploy has its
 * earlier preflight attempts FORGIVEN and restarts its budget from zero. An
 * operator who sees a budget "reset" right after a deploy is seeing this and
 * nothing else. It is bounded (≤5 extra holds, nothing submitted,
 * `nativeSpendWei` `0n`, every one of them above the submit) and it happens once
 * per in-flight sequence; matching the old format too was refused because it
 * would re-admit exactly the ambiguity G1 removed — a `GLOBAL_HALT` row wrote
 * that same old text.
 */
const TRANSIENT_ROLLBACK_REASON = /^Refused before submission: [A-Z_]+ \(transient\)\.$/;

/** The one producer of the reason {@link TRANSIENT_ROLLBACK_REASON} matches. */
function transientRollbackReason(code: string): string {
  return `Refused before submission: ${code} (transient).`;
}

/**
 * A1's explicit TRANSIENT signal: raised by a `build` that has already
 * inspected its own failure and decided the next cycle would probably succeed.
 * Module-private — nothing outside this file may manufacture one.
 */
class LpTransientStepError extends Error {}

/**
 * "Would this probably succeed on the next worker cycle?"
 *
 * `mapProviderError` is the plane's ONE classifier and `INFRASTRUCTURE_ERROR`
 * is precisely the class it exists to keep apart from a policy refusal (see
 * `src/core/errors.ts`: "an outage never masquerades as a policy rejection").
 * Reusing it means the optional step's retry decision and the trade plane's
 * error taxonomy cannot drift apart.
 *
 * PHASE3.1-FIXREVIEW F1: this predicate was right and the CLASS was too narrow.
 * `INFRASTRUCTURE_ERROR` used to mean "an HTTP server answered, and the answer
 * was an outage", so the failures a stop-loss actually meets — `socket hang
 * up`, `ECONNRESET`, `ETIMEDOUT`, a DNS `EAI_AGAIN`, viem's network-level
 * `fetch failed` and its `TimeoutError` — were still `PROVIDER_ERROR` and still
 * took the permanent skip this whole mechanism exists to remove. The fix went
 * into `src/core/errors.ts`, where the taxonomy lives, rather than into a
 * second LP-local list: a private predicate here would have been the
 * cross-implementation drift PHASE2.4's F3 was filed about, and the trade
 * plane was mis-classifying the same failures for the same reason.
 *
 * ITS CALL SITES ARE THE ANTECEDENT OF A NORMATIVE CONDITION, so they are
 * enumerated here and PINNED by a test (PHASE3.1-FIXREVIEW3 **H1**;
 * `test/errors.test.ts`, "E9 item 2's tripwire"). PHASE3.1-SPEC's erratum **E9
 * item 2** accepts a residue — a prose-only refusal that also carries transport
 * vocabulary reads as an outage — and its acceptability rests on WHERE this
 * class is branched on: every site must be strictly ABOVE a submit, so being
 * wrong costs at most {@link OPTIONAL_TRANSIENT_RETRY_ATTEMPTS} free round trips
 * and a delayed skip. Three sites, all in this file, all above the submit and
 * all producing `nativeSpendWei: 0n` rows:
 *
 *   1. a throw out of `step.build()` — the builder's own guards and its RPC;
 *   2. the `restoreSession` / `preflightExecute` block, before `executeViaSession`;
 *   3. the exit plan's fresh-quote catch, which chooses between
 *      {@link LpTransientStepError} and a terminal `action: "skip"` — the site
 *      where the residue actually decides whether the owner keeps a volatile leg.
 *
 * The count was reported as TWO by two consecutive review passes, which is why
 * it is a test now and not a sentence. **Adding a fourth site — and above all
 * adding one BELOW a submit — means E9 item 2 must be revisited before that
 * branch ships**; the pinned test is what sends the author to read it.
 */
function isTransientFailure(error: unknown): boolean {
  if (error instanceof LpTransientStepError) return true;
  return mapProviderError(error).code === "INFRASTRUCTURE_ERROR";
}

/** What one plan position does. Closures over the saga's carried state. */
type PlannedStep = {
  readonly kind: LpStepKind;
  /** FINDINGS (s) classification for `authorizeExecute` (Rev2 item 16). */
  readonly reducesExposure: boolean;
  /** Recovery state meaning "this step confirmed, the tail is owed". */
  readonly recoveryAfterConfirm: LpRecoveryState;
  /**
   * PHASE3.1 Rev2 item 12. A step whose failure must not leave the sequence
   * unfinished: by the time it runs, every asset is already in the owner's
   * wallet and the step is a convenience, not custody. On an optional step the
   * driver converts the DRIVER-OWNED pre-submit refusals — and a confirmed
   * REVERT — into a recorded SKIP carrying the reason, then advances.
   *
   * Exhaustively (the table is the whole of the change):
   *
   * | condition                                    | optional | non-optional |
   * | -------------------------------------------- | -------- | ------------ |
   * | between-step rails failure                   | SKIP     | unchanged    |
   * | `build` throws (BUILD_REFUSED)               | SKIP     | unchanged    |
   * | restoreSession/preflight (STEP_REFUSED)      | SKIP     | unchanged    |
   * | receipt FAILED (confirmed revert)            | ROLLED_BACK row, then SKIP | unchanged |
   * | NO_SESSION / SESSION_EXPIRED                 | SKIP     | unchanged    |
   * | GLOBAL_HALT                                  | HOLD     | unchanged    |
   * | SETTINGS_DIGEST_MISMATCH                     | HOLD     | unchanged    |
   * | submit throws / PENDING / UNKNOWN            | HOLD     | unchanged    |
   * | `after` throws (POST_VERIFY_FAILED)          | HOLD     | unchanged    |
   * | AGENT_PAUSED / DAILY_CAP                     | unreachable by construction |
   *
   * The two HOLD carve-outs are deliberate: a halt is the operator's stop and
   * is transient by construction — silently discarding the owed swap would
   * repurpose halt as a behaviour switch — and a digest mismatch means the
   * owner just re-signed, so the next cycle re-arms and runs the swap. Both
   * resolve within one worker cycle.
   *
   * WITHOUT THIS FLAG the confirmed-REVERT case is not merely a hold: audit
   * A1's join reclassifies the ROLLED_BACK step as an OPEN slot, and the
   * worker resubmits the reverting swap every cycle, drawing relay gas for
   * ever.
   *
   * DEFAULTS FALSE — a step that forgets it gets the strict, pre-3.1 answer,
   * the same idiom as `reducesExposure` in `src/auth/executeDecision.ts`.
   */
  readonly optional?: boolean;
  /**
   * PHASE3.13 F3. Persist a SKIP's reason as the sequence note even though this
   * step is MANDATORY.
   *
   * `recordSkip` wrote the note only for `optional === true` steps (item 15's
   * original purpose: a completed exit that still handed back the token). The
   * swapless rotate's sweep is mandatory and its skip is the owner's ONLY
   * in-product explanation for a residue appearing in their wallet — without
   * this flag the reason was accepted by `recordSkip` and then discarded, and
   * `lpSequenceView` showed a clean COMPLETED rotate with no note at all.
   *
   * A SEPARATE flag rather than marking the sweep `optional: true`, deliberately
   * (F3 says so): optionality is a whole refusal/transient-retry semantics, and
   * this step must keep the strict, mandatory one. It changes nothing about
   * WHICH skips happen — only whether the reason survives.
   *
   * DEFAULTS FALSE, so the three existing mandatory-skip sites (`NO_SESSION`,
   * a rails failure, an absent session) are untouched.
   */
  readonly noteOnSkip?: boolean;
  /**
   * PHASE3.22 R4.1 / R5.3 — WRITE {@link recoveryAfterConfirm} BEFORE THE
   * SUBMIT, not after the confirmation.
   *
   * ─── THE PROBLEM IT SOLVES (REVIEW3 P1, a BLOCKER) ────────────────────────
   *
   * `holdSequence` writes `held` only when `currentRecovery !== "none"`. For
   * every step before 3.22 that is exactly right: the marker names WHERE FUNDS
   * SIT, which is unknowable until a step confirms, and the steps that can park
   * ambiguously are never plan position 0 of their sequence.
   *
   * A `grid-shift` is ONE step and ONE submission. Its ambiguous states —
   * UNKNOWN submit, PENDING receipt, POST_VERIFY_FAILED — all occur while the
   * marker would still say `none`, so the row parks `active` + `none`, which is
   * unabandonable (`sequence_active`), unclaimable (`claimSequenceForAbandon`
   * takes `held` only) and invisible to the 3.11 stall latch. Three doors shut
   * at once, and the fourth is the one the declared-ambiguity abandon needs.
   *
   * ─── WHAT THE FLAG DOES, and the ORDERING that is normative ───────────────
   *
   * With it set, `advanceRecovery(step.recoveryAfterConfirm)` runs strictly
   * BEFORE `journal.beginWithSpend` and therefore before any submit could have
   * happened. R5.3 corrected R4.1's "in the same durable write": the journal
   * and `lp_sequences` are DIFFERENT STORES, so atomicity was never
   * expressible — ORDERING is, and ordering is what is required.
   *
   * ─── THE STALE MARKER ON A TERMINAL ROLLBACK IS DELIBERATE ────────────────
   *
   * Four pre-submit refusal paths downstream of the intent write reach
   * `refuseCleanly` ⇒ `rollBackSequence` with `confirmedMoney === 0`, and none
   * of them clears the marker. That is CHOSEN, not overlooked (R5.3 required
   * the build to pick one and say so): `isTerminalLpSequence` answers `true`
   * for `rolled-back` on the STATE ALONE (`lpSequences.ts:1030-1035`), and the
   * one-live-sequence partial index excludes `rolled-back` regardless of
   * recovery label (`:4366`, `:4900`). A rolled-back row's recovery label
   * decides nothing, so clearing it would be a write that buys nothing and one
   * more failure path to get wrong.
   *
   * RECORDED BEHAVIOUR CHANGE, in the intended direction: a crash between the
   * marker write and the submit now parks `held` on the next resume. That is
   * precisely the door the declared-ambiguity abandon opens on.
   *
   * DEFAULTS FALSE, so every step shipped before 3.22 keeps writing its marker
   * after confirmation exactly as it does today.
   */
  readonly markRecoveryBeforeSubmit?: boolean;
  /**
   * Build the step's calls with FRESH quotes and floors, or decide to skip.
   * Throwing here is a clean refusal: nothing has been recorded or journaled
   * for this position yet.
   */
  build(ctx: { readonly market: LpSagaMarket; readonly deadline: bigint }): Promise<
    | { readonly action: "submit"; readonly calls: readonly WalletCall[] }
    | { readonly action: "skip"; readonly reason: string }
  >;
  /**
   * Runs once the step's journal row is COMMITTED — live AND on resume
   * replay (`replay: true`). `txHash` is `undefined` for a skipped step.
   * Carried money amounts MUST come from `receipts` here, never a re-read.
   * Throwing parks the sequence as POST_VERIFY_FAILED (money already moved).
   *
   * ─── PHASE3.19 D2 — THE DRIVER-SUPPLIED IDEMPOTENCY KEY ───────────────────
   *
   * `ctx.journalIdempotencyKey` is the key of THE STEP ROW THIS HOOK IS ABOUT,
   * passed IDENTICALLY on all three paths the driver has: the live confirm, the
   * SKIP, and the resume replay (where it is read back from the stored step row,
   * never recomputed). It exists because the ladder's VWAP book is guarded by a
   * SET keyed on exactly that value, and the hook otherwise receives no key at
   * all — a builder who did not notice would substitute something weaker
   * (`sequenceId + step.kind` is the obvious guess), which re-opens N16 for the
   * arm seed and for any future third writer. SUBSTITUTING ANY WEAKER KEY IS
   * REFUSED.
   *
   * Every existing `after` declares two parameters and therefore IGNORES this
   * one, which is what makes the widening free: `tsc` proves no other saga
   * moves.
   */
  after(
    txHash: Hex | undefined,
    replay: boolean,
    ctx: {
      readonly journalIdempotencyKey: string;
      /**
       * The sequence this step belongs to. Carried alongside the D2 key so the
       * DERIVED cycle row (item 38) can move out of `finish` and into this
       * hook, which runs on the replay path too — FINDINGS (aw) makes that the
       * DEFAULT path, so a ledger written only on the live path is a ledger
       * usually not written at all.
       */
      readonly sequenceId: string;
    },
  ): Promise<void>;
};

type DriveInput = {
  readonly deps: LpSagaDeps;
  readonly kind: LpSequenceKind;
  readonly position: LpPositionRecord;
  readonly plan: readonly PlannedStep[];
  /** PHASE3.24 C2 — normalized request value, persisted on manual-exit create. */
  readonly inlineConvert?: boolean;
  /** Runs when a sequence is CREATED (not on resume). */
  readonly begin?: () => Promise<void>;
  /**
   * Runs when every plan position is confirmed, before `completed`.
   *
   * PHASE3.15 declares the ONE touch it makes to this shared driver: the hook
   * now receives the `sequenceId`. Existing callers ignore it (a zero-argument
   * function is assignable), so their behaviour is unchanged; the grid flip
   * needs it to key its idempotent, derived cycle row without making a store
   * read from the money path's tail.
   */
  readonly finish?: (sequenceId: string) => Promise<void>;
  /** Runs when a fresh sequence rolls back before any money moved. */
  readonly abandon?: () => Promise<void>;
  /**
   * PHASE3.18 R2.3/C4 — the requote's TARGET RUNG, written onto the sequence
   * row by the INSERT that creates it, so it is durable before the zap-out can
   * submit. Omitted by every other kind, which leaves both columns null.
   */
  readonly targetRange?: { readonly tickLower: number; readonly tickUpper: number };
  /**
   * PHASE3.22 R8 — the SHIFT's SELL target, written onto the sequence row by
   * the SAME INSERT that writes {@link targetRange} (which for a shift carries
   * the BUY rung). Omitted by every other kind.
   *
   * A shift authorizes TWO mints, so both must be durable before the batch can
   * submit — persisting one would leave a resumable row whose second rung is a
   * fresh derivation at a later tick, which is 3.18's B4 defect doubled.
   */
  readonly targetSellRange?: { readonly tickLower: number; readonly tickUpper: number };
  /** PHASE3.23 R3.2 — persisted authority for grid-shift create and recovery. */
  readonly shiftCause?: LpShiftCause;
  /**
   * PHASE3.20 item 7 / C6 — the LADDER motion's LANE EVIDENCE, written onto the
   * sequence row by the INSERT that creates it, so the reservation taken a few
   * lines later reads a lane that is already durable. Omitted by every other
   * kind, which leaves the column null and every other reserve path
   * byte-identical.
   */
  readonly recenterEvidence?: LpRecenterEvidence;
  /** PHASE3.25 R6.2 — shift-only legacy drift resume gate. */
  readonly zeroDriftResume?: boolean;
};

/**
 * Fetch, use and drop the agent's session key in the narrowest possible
 * scope — the same discipline as the /trade route's helper (which is private
 * to `src/server.ts` by design; this mirror keeps the property, not the
 * export). The key is a local `const`, never returned, logged or journaled.
 */
async function withSessionKey<T>(
  store: AgentStore,
  agent: AgentRecord,
  use: (
    authority: ReturnType<typeof agentAuthorityFromPrivateKey>,
    sessionPrivateKey: Hex,
  ) => Promise<T>,
): Promise<T> {
  let sessionKey: Hex | undefined = await store.getAgentSessionKey(agent.ownerAddress, agent.id) ?? undefined;
  if (sessionKey === undefined) {
    throw new ProviderError("Agent has no stored session key.");
  }
  try {
    return await use(agentAuthorityFromPrivateKey(sessionKey), sessionKey);
  } finally {
    // JavaScript cannot zero immutable string storage. Drop this local
    // reference at the end of the narrow decrypted-key scope instead.
    sessionKey = undefined;
  }
}

/**
 * Our errors pass through with their codes intact; anything else becomes a
 * sanitized ProviderError — the exact rule `src/server.ts` applies at the
 * same two positions (its helper is route-private by design).
 */
function asPlaneError(error: unknown, fallback: string): ExecutionPlaneError {
  if (error instanceof ExecutionPlaneError) return error;
  return new ProviderError(
    sanitizeMessage(error instanceof Error ? error.message : fallback),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireTokenId(position: LpPositionRecord): bigint {
  if (position.tokenId === null) {
    throw new Error(
      "Position has no recorded tokenId; the open's mint has not confirmed.",
    );
  }
  return BigInt(position.tokenId);
}

type PoolLegs = { readonly wbnbIsToken0: boolean; readonly token: Address };

/**
 * PHASE3.1-AUDIT A3 (the `poolLegs` half). v1 refuses a pool with no
 * configured-WBNB leg, and PHASE3.1 moved that refusal ABOVE the sequence:
 * `runExitSaga` asks for the legs before any sequence exists. Thrown as a bare
 * `Error` it was neither a `BadRequestError` nor an `LpPositionNotFoundError`,
 * so it escaped `ownerMutation`'s catch as a **500** — the (s)-family blast
 * radius on the one route that must never be unavailable, the owner's escape
 * hatch. Typed, so the route answers a typed refusal with the reason instead.
 *
 * Unreachable in v1 (`/lp/open` refuses such pools), which is exactly why it
 * must be typed rather than trusted.
 */
export class LpNoQuoteLegError extends Error {
  readonly code = "LP_NO_QUOTE_LEG";
  constructor() {
    super("Position has no WBNB leg; v1 refuses pools without one (fail-closed).");
  }
}

function poolLegs(position: LpPositionRecord, wbnb: Address): PoolLegs {
  const w = wbnb.toLowerCase();
  if (position.token0.toLowerCase() === w) {
    return { wbnbIsToken0: true, token: position.token1 };
  }
  if (position.token1.toLowerCase() === w) {
    return { wbnbIsToken0: false, token: position.token0 };
  }
  throw new LpNoQuoteLegError();
}

async function requirePosition(
  deps: LpSagaDeps,
  positionId: string,
  mode: "exit" | "entry",
): Promise<LpPositionRecord> {
  const record = await deps.store.getPosition(
    deps.agent.ownerAddress,
    deps.agent.id,
    positionId,
  );
  if (record === null) throw new LpPositionNotFoundError(positionId);
  if (mode === "entry" && record.state !== "open") {
    // A rotate/harvest needs an open position; `closing`/`closed` belong to
    // the exit path.
    throw new Error(`LP position "${positionId}" is ${record.state}.`);
  }
  // An EXIT saga accepts every state, and resume-on-`closed` is INTENDED.
  //
  // PHASE3.1-AUDIT A12: this comment used to call `closed` "the crash window
  // between `finish()` closing the position and the sequence's `completed`
  // write", which badly under-stated it from item 13 onward. `closed` is now
  // the NORMAL state of a resumable exit: step 0's `after` closes the position
  // the moment the zap-out confirms, so EVERY held, ambiguous or retrying
  // step 1 — the whole optional-step surface, including A1's transient
  // retries — finds the position already `closed`. `closing` remains the
  // in-flight marker for an exit whose step 0 has not confirmed. The resume
  // must be able to walk back in either way and finish the bookkeeping.
  // Validates the WBNB-leg invariant early, whatever the saga.
  poolLegs(record, deps.venue.wbnb);
  return record;
}

/* -------------------------------------------------------------------------- */
/* The generic driver                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The recovery state the PLAN declares for the last confirmed step that
 * actually moved money — i.e. the value the live submit loop would have left
 * on the row had it confirmed that whole prefix in-process (PHASE3.11 R-D).
 *
 * `null` means "assert nothing": no confirmed step carried a txHash (a prefix
 * of SKIPs declares nothing, exactly as `recordSkip` writes no marker), or the
 * recorded prefix does not line up with this plan. A marker must never be
 * derived from a plan the recorded steps do not match — that mismatch is
 * PLAN_MISMATCH's business, and it is decided on the replay path.
 */
function confirmedPrefixRecovery(
  plan: readonly PlannedStep[],
  liveSteps: readonly LpSequenceStep[],
  rows: ReadonlyMap<string, JournalEntry | null>,
  confirmedSteps: number,
): LpRecoveryState | null {
  let marker: LpRecoveryState | null = null;
  for (let index = 0; index < confirmedSteps; index += 1) {
    const recorded = liveSteps[index];
    const step = plan[index];
    if (recorded === undefined || step === undefined) return null;
    if (step.kind !== recorded.kind) return null;
    if (rows.get(recorded.journalIdempotencyKey)?.externalRef.txHash === undefined) {
      continue;
    }
    marker = step.recoveryAfterConfirm;
  }
  return marker;
}

async function driveSequence(input: DriveInput): Promise<LpSagaRunResult> {
  const { deps, plan, kind, position } = input;
  const owner = deps.agent.ownerAddress;
  const agentId = deps.agent.id;
  const nowSec = (): number => Math.floor(deps.now() / 1000);
  const deadlineSec = deps.deadlineSec ?? DEFAULT_TRADE_DEADLINE_SEC;

  /* ----- resume or create -------------------------------------------------- */

  let sequence = await deps.store.getNonTerminalSequence(
    owner,
    agentId,
    position.positionId,
  );
  if (sequence !== null && sequence.kind !== kind) {
    return {
      sequenceId: sequence.sequenceId,
      kind: sequence.kind,
      status: "held",
      code: "SEQUENCE_CONFLICT",
      reason: `Position already has a non-terminal ${sequence.kind} sequence; a ${kind} cannot start until it resolves.`,
      confirmedSteps: 0,
    };
  }
  if (
    sequence !== null
    && kind === "manual-exit"
    && sequence.inlineConvert !== (input.inlineConvert === true)
  ) {
    // PHASE3.24 C2: persisted consent wins. Refuse a caller that attempts to
    // resume the same money saga under a different signed value.
    return {
      sequenceId: sequence.sequenceId,
      kind: sequence.kind,
      status: "held",
      code: "PLAN_MISMATCH",
      reason: "The manual-exit inlineConvert value disagrees with the persisted sequence consent.",
      confirmedSteps: 0,
    };
  }
  let createdFresh = false;
  if (sequence === null) {
    sequence = await deps.store.createSequence({
      agentId,
      ownerAddress: owner,
      positionId: position.positionId,
      kind,
      ...(kind === "manual-exit" ? { inlineConvert: input.inlineConvert === true } : {}),
      // PHASE3.18 R2.3/C4: in the SAME transaction that creates the row.
      ...(input.targetRange === undefined ? {} : { targetRange: input.targetRange }),
      // PHASE3.22 R8: the SHIFT's second rung, in the SAME transaction as the
      // first. Both or neither — a row carrying one authorized rung and one
      // re-derivable one is the defect the persistence exists to prevent.
      ...(input.targetSellRange === undefined
        ? {}
        : { targetSellRange: input.targetSellRange }),
      ...(input.shiftCause === undefined ? {} : { shiftCause: input.shiftCause }),
      // PHASE3.20 item 7 / C6: likewise, and for the identical reason — a
      // resume does not re-evaluate the trigger, so the evidence that decided
      // the lane is not recoverable from anywhere else.
      ...(input.recenterEvidence === undefined
        ? {}
        : { recenterEvidence: input.recenterEvidence }),
    });
    createdFresh = true;
    if (input.begin !== undefined) await input.begin();
  }
  const sequenceId = sequence.sequenceId;

  /** Recovery state as this run last wrote (or found) it. */
  let currentRecovery: LpRecoveryState = sequence.recoveryState;

  /**
   * Advance the recovery marker to what THE PLAN declares for a step the
   * journal reports COMMITTED (PHASE3.11 R-D).
   *
   * The live submit loop writes this marker itself, and until this phase that
   * was the ONLY writer — so a step whose in-process receipt came back
   * PENDING/UNKNOWN, was settled out of process by `reconcile` and was then
   * REPLAYED here left the row saying `none` while its money had in fact
   * moved. `none` reads as "nothing is owed", `holdSequence` therefore refuses
   * to park the row, and an `active`+`none` sequence is un-abandonable: the
   * live deadlock this phase exists to close. No crash is required for it.
   *
   * The evidence is a COMMITTED journal row plus the plan's OWN declaration —
   * never a balance read, never a caller field, never the row's stale label.
   * The `!==` guard keeps it idempotent, so a repeated resume writes nothing.
   *
   * Returns `false` when a resolver fence owns the row. That row's recovery
   * state belongs to the resolver, not to this saga, so the resume aborts and
   * writes nothing rather than turning a fenced row into a saga error.
   */
  const advanceRecovery = async (declared: LpRecoveryState): Promise<boolean> => {
    if (declared === currentRecovery) return true;
    try {
      await deps.store.setRecoveryState(owner, agentId, sequenceId, declared);
    } catch (error) {
      if (error instanceof LpPositionResolvingError) return false;
      // The marker DECIDES (`held` vs `active`) where the note only EXPLAINS,
      // so this one is never swallowed: the sequence stays `active`, which is
      // the behaviour that stood before this phase.
      throw error;
    }
    currentRecovery = declared;
    return true;
  };

  /** The resume aborted because a resolver owns the row; nothing was written. */
  const fencedResult = (confirmedSteps: number): LpSagaRunResult => ({
    sequenceId,
    kind,
    status: "held",
    code: "SEQUENCE_FENCED",
    reason:
      "A resolver fence owns this sequence row; the resume decided nothing and wrote nothing.",
    confirmedSteps,
  });

  let confirmedMoney = 0;

  /**
   * Did THIS run do anything that makes the exit-quota slot NON-RELEASABLE
   * (PHASE3.5 Rev2 M2)?
   *
   * Read the name as "this run is not entitled to a refund", not as "this run
   * submitted" (audit A6): `recordSkip` sets it for a step that submits
   * nothing, which is correct and conservative — a skip commits a journal row,
   * and the adopted advisory is that an all-skip completion over-holds. The join's `rows` map is fetched ONCE, before any step runs, so by the
   * time a sequence goes terminal it is stale — and for a sequence whose steps
   * were all appended and committed in this very run it is EMPTY, which the
   * predicate would read as "no steps" and release. That would free a slot on
   * every successful sequence and silently double the quota.
   *
   * Two independent guards, and the belt is not the braces: this flag catches
   * the current run, and the re-read below catches everything the join saw
   * stale. Either one alone has a hole.
   */
  let submittedThisRun = false;

  /**
   * Hand the exit-quota slot back when the sequence provably spent nothing
   * (PHASE3.5). DERIVED state, in the same failure-tolerance idiom as the
   * sequence note: it explains, it never decides — a throw here must not turn a
   * completed saga into a failed one, and costs at most one stale row that the
   * 24 h window ages out.
   */
  const releaseReservationIfUnspent = async (): Promise<void> => {
    try {
      // M2 names three independent signals; `confirmedMoney` covers the
      // second `markCommitted` site, which is reached only through the
      // `markInProgress` above but must not depend on that reading staying true.
      if (submittedThisRun || confirmedMoney > 0) return;
      const current = await deps.store.getSequence(owner, agentId, sequenceId);
      // AUDIT A5: a vanished row HOLDS. Practically unreachable —
      // `setSequenceState` succeeded on this same row one line up — but every
      // other missing-evidence branch in this phase holds, and a uniform
      // posture is worth one line.
      if (current === null) return;
      const steps = current.steps;
      const fresh = new Map<string, JournalEntry | null>();
      for (const step of steps) {
        fresh.set(
          step.journalIdempotencyKey,
          await deps.journal.get(step.journalIdempotencyKey),
        );
      }
      if (!lpReservationReleasable(fresh, steps)) return;
      await deps.store.releaseReservation(owner, agentId, sequenceId);
    } catch {
      /* derived: a failed release costs one stale row, never the saga */
    }
  };

  const rollBackSequence = async (
    code: LpSagaRunCode,
    reason: string,
    confirmedSteps: number,
  ): Promise<LpSagaRunResult> => {
    await deps.store.setSequenceState(owner, agentId, sequenceId, "rolled-back");
    await releaseReservationIfUnspent();
    if (input.abandon !== undefined) await input.abandon();
    return {
      sequenceId,
      kind,
      status: "rolled-back",
      code,
      reason: sanitizeMessage(reason),
      confirmedSteps,
    };
  };

  const holdSequence = async (
    code: LpSagaRunCode,
    reason: string,
    confirmedSteps: number,
  ): Promise<LpSagaRunResult> => {
    // `held` is only entered when a recovery state names where the funds sit;
    // otherwise the sequence simply STAYS `active` — `held`+`none` reads as
    // terminal and would release the position under an unresolved step.
    const fresh = await deps.store.getSequence(owner, agentId, sequenceId);
    if (
      fresh !== null &&
      fresh.state === "active" &&
      currentRecovery !== "none"
    ) {
      await deps.store.setSequenceState(owner, agentId, sequenceId, "held");
    }
    // PHASE3.1-AUDIT A5: item 15 gave the owner an in-product explanation for a
    // SKIPPED optional step and gave the HOLD branches none — yet a hold is the
    // case where a swap is genuinely STILL OWED. The position is already
    // `closed`, its basis zeroed, and `LpSagaRunResult.reason` goes to the
    // worker's log and nowhere else for an autonomous protect, which is
    // verbatim the gap item 15 exists to close.
    //
    // Scoped to a hold on THE OPTIONAL STEP, which is the only plan position
    // whose predecessors have all confirmed and whose money is already in the
    // owner's own EOA. A hold on a mandatory step is an in-flight sequence, not
    // an owed conversion, and its reason belongs in the recovery state.
    // Derived, operator-facing state — a failed write never decides anything.
    //
    // LP-ROTATE-MINT-FLOORS review 4 M2: widening this to mandatory-step
    // BUILD_REFUSED holds was tried and REVERTED — it left a stale refusal
    // note on a rotate that later completed, and it broke the brain
    // hold-instead pin (`lp.brain.test.ts`: the accepted hold persists NO
    // text in the note). A mint-floor refusal therefore still reaches only
    // the worker log; a durable, lifecycle-managed diagnostic is the
    // residue-accounting phase's to add.
    if (plan[confirmedSteps]?.optional === true) {
      try {
        await deps.store.setSequenceNote(
          owner,
          agentId,
          sequenceId,
          sanitizeMessage(`${code}: ${reason}`),
        );
      } catch {
        /* the note explains; it never decides */
      }
    }
    return {
      sequenceId,
      kind,
      status: "held",
      code,
      reason: sanitizeMessage(reason),
      confirmedSteps,
    };
  };

  /* ----- reservation BEFORE any money (Rev2 items 11/13) ------------------- */

  try {
    // PHASE3.20 C6 — THE LANE COMES OFF THE ROW, on BOTH paths. `sequence` here
    // is the row this run created OR the row it resumed, so a resume — which
    // never re-evaluates the trigger, and which FINDINGS (aw) makes the DEFAULT
    // path on this relay — charges the same lane the motion started in rather
    // than a re-derivation. A NULL (pre-migration, in flight at upgrade) reserves
    // SETTLEMENT, which is the store's own rule.
    await deps.store.reserveSequence(
      owner,
      agentId,
      sequenceId,
      deps.quota,
      sequence.recenterEvidence ?? undefined,
    );
  } catch (error) {
    if (error instanceof LpExitQuotaError) {
      // Only rotate/harvest can be refused here, and only before any money
      // moved: the reservation precedes step 0 and is idempotent afterwards.
      return rollBackSequence("QUOTA", error.message, 0);
    }
    throw error;
  }

  /* ----- join recorded steps against journal outcomes ---------------------- */

  const rows = new Map<string, JournalEntry | null>();
  for (const step of sequence.steps) {
    rows.set(
      step.journalIdempotencyKey,
      await deps.journal.get(step.journalIdempotencyKey),
    );
  }
  // PHASE3.25 R6.2 — settings alone never prove a submission did not happen.
  // Only the existing journal predicate may release a legacy drift reservation;
  // every ambiguous, committed, or submitted-and-reverted partition continues
  // through the unchanged driver below.
  if (
    !createdFresh
    && input.zeroDriftResume === true
    && lpReservationReleasable(rows, sequence.steps)
  ) {
    return rollBackSequence(
      "QUOTA",
      "Shift drift allowance is zero under the signed settings; the clean legacy reservation was released before any new call was built.",
      0,
    );
  }
  const outcomes = new Map<string, LpStepOutcomeState>();
  for (const [key, row] of rows) {
    if (row !== null) outcomes.set(key, row.state);
  }
  // The driver's retry decisions (store docstring: "the DRIVER decides"):
  //
  //  - a ROLLED_BACK step provably never reached a relay, so its slot is open
  //    and a later recorded step of the same kind is its retry;
  //
  //  - a recorded step whose journal row DOES NOT EXIST (audit A1) is likewise
  //    PROVABLY NEVER SUBMITTED: `appendStep` runs strictly before
  //    `beginWithSpend`, and `beginWithSpend` runs strictly before any submit
  //    path, so a missing row can only mean the process died in the
  //    appendStep→begin window — nothing could have reached a relay under a
  //    key whose row was never created. Its slot is OPEN too. This must be
  //    distinguished from a row that EXISTS but is non-terminal
  //    (PENDING/IN_PROGRESS/UNKNOWN): that row DID reach the begin, its submit
  //    window is genuinely ambiguous, and it HOLDS until `reconcile` resolves
  //    it. Holding on the missing row instead would deadlock the position
  //    forever — the key is derived from freshly-built calldata and never
  //    re-derived, `reconcile` iterates journal ROWS and cannot resolve one
  //    that was never created, and the stuck non-terminal sequence would then
  //    block BOTH the automated protect AND the owner's manual exit
  //    (SEQUENCE_CONFLICT) — the exact trap FINDINGS (s) exists to prevent.
  //
  // The store's own join runs over what remains, so hold/advance semantics
  // stay the store's; a retry appends a NEW step record with a FRESH key.
  const liveSteps = sequence.steps.filter((step) => {
    const row = rows.get(step.journalIdempotencyKey);
    return row !== null && row !== undefined && row.state !== "ROLLED_BACK";
  });
  const progress = deriveLpSequenceProgress({ steps: liveSteps }, outcomes);
  if (progress.disposition === "hold") {
    // PHASE3.11 R-D, case (c). The CONFIRMED PREFIX is money that already
    // moved, and this branch parks the sequence without ever reaching the
    // replay loop — so without this write a sequence with one COMMITTED step
    // and one UNKNOWN one stays `active`+`none` and can never be abandoned.
    // Same evidence as the replay loop below: a COMMITTED row carrying a
    // txHash, plus the plan's declaration at that position.
    const prefix = confirmedPrefixRecovery(
      plan,
      liveSteps,
      rows,
      progress.confirmedSteps,
    );
    if (prefix !== null && !(await advanceRecovery(prefix))) {
      return fencedResult(progress.confirmedSteps);
    }
    return holdSequence("HELD_AMBIGUOUS", progress.reason, progress.confirmedSteps);
  }
  // disposition can only be "advance" here: rolled-back rows were filtered.

  /**
   * A1's retry budget, counted rather than timed (PHASE3.1-FIXREVIEW F2), and
   * ATTRIBUTED to the transient path rather than to the plan position
   * (PHASE3.1-FIXREVIEW2 G1).
   *
   * How many TRANSIENT attempts this sequence has already made AT THE PLAN
   * POSITION IT IS ABOUT TO RUN. Scanning BACKWARD from the end and stopping at
   * the first live step is what makes it position-scoped: the rows that trail
   * the last live step are, by construction, attempts at the step that has not
   * confirmed yet. Rows further back belong to positions that have since
   * confirmed and are none of this budget's business.
   *
   * WHAT COUNTS, and why the scan does not simply count every open slot:
   *
   *   - a `ROLLED_BACK` row whose reason the TRANSIENT path wrote
   *     ({@link TRANSIENT_ROLLBACK_REASON}) is one real transient attempt — a
   *     round trip that failed on transport and cost nothing else;
   *   - a `ROLLED_BACK` row written by anything else — the late `GLOBAL_HALT`
   *     re-check, the `DAILY_CAP` re-check — is SKIPPED, not counted, and the
   *     scan keeps going. It provably moved no money, so it is still an open
   *     slot for the join above, but a halt is not an attempt at the swap and
   *     must not spend a budget that exists for outages (G1);
   *   - a recorded step whose row was NEVER CREATED counts. It died in the
   *     `appendStep`→`begin` window, which is provably unsubmitted, and the
   *     evidence for WHY is genuinely absent — counting it is the conservative
   *     reading, and it is the one case where nothing can be attributed.
   *
   * THE ROW-GROWTH BOUND, EXACTLY (corrected by PHASE3.1-FIXREVIEW3 **H6(b)**;
   * the pre-G1 scan counted every trailing rolled-back row, so it bounded them
   * all). Because an UNATTRIBUTED rolled-back row is now SKIPPED rather than
   * counted, the bound at one plan position is "≤{@link
   * OPTIONAL_TRANSIENT_RETRY_ATTEMPTS} attributed rows + 1 skip row, plus
   * however many unattributed rows the paths below wrote". That residue is not
   * bounded by a constant, and the reason it is still not R2's
   * stays-active-forever trap is reachability, enumerated rather than assumed:
   * `DAILY_CAP` needs `nativeSpendWei > 0n` and every optional step is WBNB-paid,
   * so it cannot fire here; the late kill-switch needs the halt to arrive INSIDE
   * the `build`→`beginWithSpend` window on EVERY cycle, because a STANDING halt
   * refuses at the early check before `appendStep` and appends nothing; and a
   * non-transient preflight refusal takes `recordSkip` and terminates the plan
   * position. So unbounded growth needs an improbable event to recur
   * indefinitely, every row it writes is `nativeSpendWei` `0n` and above the
   * submit, and the retry budget still terminates — but "6 + 1" is not the whole
   * number and a future reader should not quote it as one.
   *
   * This is a READ of what earlier runs persisted, so the budget survives the
   * process — the defect FINDINGS (ae) recorded when the hysteresis counter
   * lived in a `Map`.
   */
  let transientAttempts = 0;
  for (let index = sequence.steps.length - 1; index >= 0; index -= 1) {
    const recorded = sequence.steps[index];
    if (recorded === undefined) break;
    const row = rows.get(recorded.journalIdempotencyKey);
    if (row === null || row === undefined) {
      transientAttempts += 1;
      continue;
    }
    if (row.state !== "ROLLED_BACK") break;
    if (row.lastError !== null && TRANSIENT_ROLLBACK_REASON.test(row.lastError)) {
      transientAttempts += 1;
    }
  }

  let planPos = 0;
  for (const recorded of liveSteps) {
    const step = plan[planPos];
    if (step === undefined || step.kind !== recorded.kind) {
      return holdSequence(
        "PLAN_MISMATCH",
        `Recorded step ${recorded.index} (${recorded.kind}) does not match this saga's plan; refusing to drive it.`,
        planPos,
      );
    }
    const row = rows.get(recorded.journalIdempotencyKey);
    const txHash = row?.externalRef.txHash;
    if (txHash !== undefined) confirmedMoney += 1;
    // PHASE3.11 R-D. The marker follows the PLAN POSITION the journal reports
    // COMMITTED, not the process that happened to submit it — and it is
    // written BEFORE `after` for the same reason the live path states at its
    // own write: a POST_VERIFY_FAILED on the replay must land in a NAMED
    // state. A replayed SKIP (`txHash === undefined`) declares nothing, which
    // mirrors `recordSkip` writing no marker on the live path.
    if (
      txHash !== undefined &&
      !(await advanceRecovery(step.recoveryAfterConfirm))
    ) {
      return fencedResult(planPos);
    }
    // REPLAY: rebuild carried state from the confirmed receipt (Rev2 item 32).
    //
    // PHASE3.1-AUDIT A13: this hook is an RPC on the replay path too — PHASE3.1
    // added `receipts.collectAmounts` (a `getTransactionReceipt`, the one method
    // FINDINGS (ad) records some pinned endpoints refusing) beside the existing
    // `positions` read, and `collectAmounts` is strict: it throws unless it
    // finds exactly one NFPM `Collect` log. Unguarded, such a throw escaped
    // `runLpProtect` entirely instead of becoming a typed hold. Same treatment
    // as the live path at the bottom of the loop: money already moved, so this
    // parks the sequence for an operator and never retries blind.
    try {
      await step.after(txHash, true, {
        // D2: read BACK from the stored step row, never recomputed, so the
        // replayed write presents exactly the key the live write used.
        journalIdempotencyKey: recorded.journalIdempotencyKey,
        sequenceId,
      });
    } catch (error) {
      return holdSequence("POST_VERIFY_FAILED", messageOf(error), planPos);
    }
    // PHASE3.1-FIXREVIEW F3: the A5 note is cleared on the LIVE confirm path at
    // the bottom of the plan loop, and that was the only place — so an optional
    // step that submitted, landed PENDING/UNKNOWN, held with a note, and was
    // then resolved to COMMITTED by `reconcile` came back through HERE, walked
    // straight past `plan.length`, and COMPLETED still carrying "a swap is
    // owed". Erratum E3 is normative that a completed exit which actually
    // converted never tells the owner that, and `lpSequenceView` renders the
    // note as the owner's only in-product explanation. Cleared on every path
    // that confirms the optional step, therefore.
    //
    // `txHash === undefined` is a replayed SKIP, whose note is item 15's
    // original purpose and must survive — the same distinction the live path
    // makes by sitting after `markCommitted`.
    if (step.optional === true && txHash !== undefined) {
      try {
        await deps.store.setSequenceNote(owner, agentId, sequenceId, null);
      } catch {
        /* the note explains; it never decides */
      }
    }
    planPos += 1;
  }
  let recordedCount = sequence.steps.length;

  // A resumed held sequence goes back to active before it can record steps.
  if (sequence.state === "held" && planPos < plan.length) {
    await deps.store.setSequenceState(owner, agentId, sequenceId, "active");
  }

  /** A refusal that provably moved no money on THIS step. */
  const refuseCleanly = async (
    code: LpSagaRunCode,
    reason: string,
  ): Promise<LpSagaRunResult> =>
    confirmedMoney === 0
      ? rollBackSequence(code, reason, planPos)
      : holdSequence(code, reason, planPos);

  /**
   * Record a plan position as SKIPPED and advance (PHASE3.1 Rev2 items 11/12).
   *
   * The step is RECORDED, not omitted, so resume indexes stay stable: its
   * journal row is begun and immediately COMMITTED with no submit and no
   * callsId — "this plan position completed; nothing needed doing" — and the
   * journal stays the single authority on the outcome. A resume sees an
   * ordinary confirmed step with no txHash, whose `after` replay is a no-op by
   * contract.
   *
   * Returns `null` on success (the caller continues the loop) or a HOLD result
   * when the skip's own key collided, which is the one ambiguity even a skip
   * must not guess at.
   */
  const recordSkip = async (
    step: PlannedStep,
    reason: string,
    publicKey?: Hex,
  ): Promise<LpSagaRunResult | null> => {
    const decisionId = lpStepDecisionId(sequenceId, recordedCount);
    const key = executeIdempotencyKey(agentId, decisionId, hashCalls([]));
    await deps.store.appendStep(owner, agentId, sequenceId, {
      kind: step.kind,
      journalIdempotencyKey: key,
    });
    recordedCount += 1;
    const { created } = await deps.journal.beginWithSpend(
      {
        idempotencyKey: key,
        agentId,
        ownerAddress: owner,
        kind: "lp",
        decisionId,
        ...(publicKey === undefined ? {} : { externalRef: { publicKey } }),
        nativeSpendWei: 0n,
      },
      deps.now() - DAILY_WINDOW_MS,
    );
    if (!created) {
      return holdSequence(
        "HELD_AMBIGUOUS",
        "A fresh idempotency key collided with an existing journal row; holding rather than guessing.",
        planPos,
      );
    }
    // Audit A6: a skip submits nothing, but it COMMITS a row, and the adopted
    // advisory is that an all-skip completion holds its slot. Setting the flag
    // here makes that explicit rather than leaving it to the re-read.
    submittedThisRun = true;
    await deps.journal.markCommitted(key);
    if (step.optional === true || step.noteOnSkip === true) {
      // Rev2 item 15: the owner's ONLY in-product explanation for a completed
      // exit that still handed back the token — and, since PHASE3.13 F3, for a
      // swapless rotate that left a residue in the wallet. Derived,
      // operator-facing state — a failed write must never turn a finished exit
      // into an unfinished one, which is the very shape this phase exists to
      // remove.
      try {
        await deps.store.setSequenceNote(
          owner,
          agentId,
          sequenceId,
          sanitizeMessage(`${step.kind} skipped: ${reason}`),
        );
      } catch {
        /* the note explains; it never decides */
      }
    }
    // D2: the SKIP path passes the SAME key it just journalled, so a skip that
    // writes a book credit (none does today, and the guard must still hold) is
    // keyed exactly as its replay will be.
    await step.after(undefined, false, { journalIdempotencyKey: key, sequenceId });
    planPos += 1;
    return null;
  };

  /**
   * Record ONE transient attempt as a provably-unsubmitted step row, so the
   * retry budget survives the process (PHASE3.1-FIXREVIEW F2).
   *
   * Identical in shape to `recordSkip`'s bookkeeping — the step's identity
   * first, then a journal row under its key, no submit, no callsId, zero native
   * — except that the row is marked `ROLLED_BACK` rather than `COMMITTED`. The
   * distinction is the whole meaning: a skip says "this plan position is
   * finished", a rolled-back row says "this plan position was attempted and
   * provably never reached a relay, so its slot is still open". The join above
   * already reads exactly that, which is why this needs no new state, no new
   * column and no change to `deriveLpSequenceProgress`.
   *
   * The `restoreSession`/`preflightExecute` path does not call this: the driver
   * has already appended and rolled back its row by the time it classifies the
   * failure. This exists for the transient failures raised out of `build`,
   * which throw BEFORE any row exists — and leaving those unrecorded is what
   * made their retries uncountable.
   *
   * Returns `null` on success, or a hold when the fresh key collided — the one
   * ambiguity even a bookkeeping row must not guess at.
   *
   * ITS OWN begin→settle WINDOW, recorded rather than discovered
   * (PHASE3.1-FIXREVIEW2 **G7**). `beginWithSpend` and `markRolledBack` are two
   * awaits, and a store failure between them leaves a `PENDING` `lp` row with no
   * `callsId`, which `reconcile` resolves to `UNKNOWN` (`src/store/journal.ts`)
   * and never revisits — so the sequence holds until an operator runs Phase
   * 3.3's `resolveUnknown`. This is the SAME shape as `recordSkip`'s
   * pre-existing begin→`markCommitted` window and is not new, but the retry
   * budget makes it up to {@link OPTIONAL_TRANSIENT_RETRY_ATTEMPTS} times more
   * reachable per sequence. Two things make it acceptable rather than merely
   * tolerated: such a row is genuinely RESOLVABLE by 3.3 — the sweep never
   * submitted, so the token is still in the wallet and 3.3's discriminating test
   * passes — and it is distinguishable from a real submit by the ABSENCE of a
   * `callsHash` on the row, because this path hashes an empty call list.
   *
   * THAT LAST CLAUSE ONLY RUNS ONE WAY, and PHASE3.1-FIXREVIEW3 **H5** is what
   * it cost to learn: the ABSENCE of a `callsHash` proves nothing was submitted,
   * but its PRESENCE proves nothing at all, because the live path writes it at
   * `beginWithSpend` — above the daily-cap re-check, the late kill-switch,
   * `restoreSession`, `preflightExecute` and every submit. G4 read the field as
   * "submitted" on the owner's sequence view and so reported six submissions
   * against one. Anything asking "did this reach a relay?" must use
   * `callsId ?? txHash` (`src/http/lpWire.ts`'s `lpStepOutcome`,
   * `src/lp/resolveUnknown.ts`, `journal.reconcile`).
   */
  const recordTransientAttempt = async (
    step: PlannedStep,
    reason: string,
    publicKey?: Hex,
  ): Promise<LpSagaRunResult | null> => {
    const decisionId = lpStepDecisionId(sequenceId, recordedCount);
    const key = executeIdempotencyKey(agentId, decisionId, hashCalls([]));
    await deps.store.appendStep(owner, agentId, sequenceId, {
      kind: step.kind,
      journalIdempotencyKey: key,
    });
    recordedCount += 1;
    const { created } = await deps.journal.beginWithSpend(
      {
        idempotencyKey: key,
        agentId,
        ownerAddress: owner,
        kind: "lp",
        decisionId,
        ...(publicKey === undefined ? {} : { externalRef: { publicKey } }),
        nativeSpendWei: 0n,
      },
      deps.now() - DAILY_WINDOW_MS,
    );
    if (!created) {
      return holdSequence(
        "HELD_AMBIGUOUS",
        "A fresh idempotency key collided with an existing journal row; holding rather than guessing.",
        planPos,
      );
    }
    await deps.journal.markRolledBack(key, sanitizeMessage(reason));
    return null;
  };

  /**
   * PHASE3.1-AUDIT A1. An optional step's PRE-SUBMIT refusal, split the way the
   * audit's fix direction asks:
   *
   *   - a PRODUCT refusal (the flag off, a zero leg, dust, impact over the
   *     rail, a builder guard) is the TERMINAL skip Rev2 item 12 specified —
   *     unchanged;
   *   - a TRANSPORT failure — the fresh quote's RPC, `restoreSession`,
   *     `preflightExecute`; a 429, a 5xx, a socket reset, a connection timeout,
   *     a DNS failure, viem's network-level `fetch failed` — HOLDS instead, so
   *     the next worker cycle retries it, bounded by
   *     {@link OPTIONAL_TRANSIENT_RETRY_ATTEMPTS}. Past the budget it becomes a
   *     skip whose reason SAYS the failure was transient AND how many attempts
   *     were made. (The connection-level half of that list is true only since
   *     PHASE3.1-FIXREVIEW F1 widened `src/core/errors.ts`; before it, this
   *     docstring claimed coverage the code did not have.)
   *
   * A hold here is safe for the same reason the GLOBAL_HALT carve-out is: the
   * sequence stays non-terminal, the position is already `closed` and out of
   * the trigger queue, and the worker resumes the sequence next cycle.
   *
   * `alreadyRecorded` says whether THIS failure already left a
   * provably-unsubmitted row (the preflight path has; a throw out of `build`
   * has not). It is a parameter rather than a guess because the two transient
   * sites sit on opposite sides of `appendStep`, and counting one of them twice
   * would spend the budget at double rate. Both sites write the SAME
   * {@link transientRollbackReason} onto their row, which is what makes the
   * budget a count of transient attempts specifically (G1) — the preflight site
   * has to classify BEFORE it rolls the row back for that reason to be true.
   *
   * THE REASON TEXT IS PART OF THE FIX (PHASE3.1-FIXREVIEW F2). It states the
   * attempt number and the budget, so it can never claim an exhausted budget
   * about a step that ran once — which the wall-clock version did, routinely,
   * for any sequence that reached its optional step late, and which
   * PHASE3.1-FIXREVIEW2 G1 showed an unrelated `GLOBAL_HALT` row could still
   * make it say.
   *
   * Returns `null` when the caller should continue the plan, or a result to
   * return (a hold, or `recordSkip`'s own key-collision hold).
   */
  const refuseOptionalStep = async (
    step: PlannedStep,
    code: LpSagaRunCode,
    reason: string,
    transient: boolean,
    alreadyRecorded: boolean,
    publicKey?: Hex,
  ): Promise<LpSagaRunResult | null> => {
    if (!transient) return recordSkip(step, reason, publicKey);
    const attempt = transientAttempts + 1;
    if (attempt < OPTIONAL_TRANSIENT_RETRY_ATTEMPTS) {
      if (!alreadyRecorded) {
        const collision = await recordTransientAttempt(
          step,
          transientRollbackReason(code),
          publicKey,
        );
        if (collision !== null) return collision;
      }
      return holdSequence(
        code,
        `Transient failure on the optional step (attempt ${attempt} of ${OPTIONAL_TRANSIENT_RETRY_ATTEMPTS}); the conversion is still owed and is retried next cycle. ${reason}`,
        planPos,
      );
    }
    return recordSkip(
      step,
      `transient failure on all ${attempt} of ${OPTIONAL_TRANSIENT_RETRY_ATTEMPTS} attempts, retries exhausted: ${reason}`,
      publicKey,
    );
  };

  if (
    createdFresh
    && deps.agent.status !== "armed"
    // PHASE3.24 R2.11/C4: the owner-signed pause route records BOTH the kill
    // switch and status="paused" before close --all starts. Manual exit is the
    // one fresh-sequence carve-out; without it pause-first is self-refuting.
    // Protect and every other saga retain the shipped status gate exactly.
    && !(kind === "manual-exit" && deps.agent.status === "paused")
  ) {
    return refuseCleanly(
      "AGENT_NOT_ARMED",
      `Agent status is "${deps.agent.status}"; a new LP sequence needs an armed agent.`,
    );
  }

  /* ----- drive the remaining plan positions -------------------------------- */

  while (planPos < plan.length) {
    const step = plan[planPos];
    if (step === undefined) break; // unreachable; satisfies noUncheckedIndexedAccess

    // (b) Settings digest: an owner settings change invalidates in-flight
    // automation (Rev2 item 21; spec body).
    const current = await deps.currentSettingsDigest();
    if (current.toLowerCase() !== deps.settingsDigest.toLowerCase()) {
      return refuseCleanly(
        "SETTINGS_DIGEST_MISMATCH",
        "Owner settings changed since this sequence was armed; automation refuses between steps.",
      );
    }

    // (a) Kill switch, with the FINDINGS (s) carve-out (Rev2 item 16).
    // A quota-bound sequence that has not yet moved money runs STRICT
    // regardless of the step's own classification: no new rotate/harvest
    // starts under pause. In flight, the step's classification decides —
    // exposure-reducing steps finish, exposure-increasing ones hold.
    const reduces =
      kind === "protect" || kind === "manual-exit"
        ? true
        : confirmedMoney === 0
          ? false
          : step.reducesExposure;
    const decision = await authorizeExecute({
      agent: deps.agent,
      killswitch: deps.killswitch,
      now: nowSec(),
      reducesExposure: reduces,
    });
    /** Rev2 item 12's table, applied where the driver owns the refusal. */
    const optional = step.optional === true;
    if (!decision.allowed) {
      // GLOBAL_HALT (and AGENT_PAUSED, unreachable on an exit kind) keep
      // holding even on an optional step: a halt is transient by construction
      // and must never become a behaviour switch.
      if (
        optional &&
        (decision.code === "NO_SESSION" || decision.code === "SESSION_EXPIRED")
      ) {
        const held = await recordSkip(step, `${decision.code}: ${decision.reason}`);
        if (held !== null) return held;
        continue;
      }
      return refuseCleanly(decision.code, decision.reason);
    }
    const facts = deps.agent.sessionFacts;
    if (facts === null) {
      if (optional) {
        const held = await recordSkip(step, "Agent has no granted session.");
        if (held !== null) return held;
        continue;
      }
      return refuseCleanly("NO_SESSION", "Agent has no granted session.");
    }

    // (c) Rails re-check on FRESH evidence, between every step.
    const market = await deps.market();
    const railFailure = checkManipulationRails(market, deps.rails);
    if (railFailure !== undefined) {
      if (optional) {
        const held = await recordSkip(step, railFailure.reason, facts.publicKey);
        if (held !== null) return held;
        continue;
      }
      return refuseCleanly(railFailure.code, railFailure.reason);
    }

    // (d) Build with fresh quotes; floors are server-derived inside `build`.
    const deadline = BigInt(nowSec() + deadlineSec);
    let built: Awaited<ReturnType<PlannedStep["build"]>>;
    try {
      built = await step.build({ market, deadline });
    } catch (error) {
      if (optional) {
        // A1: a builder guard is a product refusal and skips; a transport
        // failure raised (or signalled) out of `build` holds and retries.
        const held = await refuseOptionalStep(
          step,
          "BUILD_REFUSED",
          messageOf(error),
          isTransientFailure(error),
          // `build` throws BEFORE `appendStep`, so nothing is recorded yet.
          false,
          facts.publicKey,
        );
        if (held !== null) return held;
        continue;
      }
      return refuseCleanly("BUILD_REFUSED", messageOf(error));
    }

    if (built.action === "skip") {
      // Every PRODUCT-level refusal arrives here (Rev2 item 11) — returned
      // from `build`, never thrown — and the landed driver already completes
      // the sequence through it with no change at all.
      const held = await recordSkip(step, built.reason, facts.publicKey);
      if (held !== null) return held;
      continue;
    }

    const decisionId = lpStepDecisionId(sequenceId, recordedCount);
    const calls = built.calls;
    const callsHash = hashCalls(calls);
    const finalCalls = fingerprintLpFinalCallsV1(calls);
    const nativeSpendWei = calls.reduce(
      (total, call) => total + (call.value ?? 0n),
      0n,
    );
    const key = executeIdempotencyKey(agentId, decisionId, callsHash);

    // Order is the store's stated design: record the step's identity FIRST,
    // then journal-begin under its key, then submit.
    await deps.store.appendStep(owner, agentId, sequenceId, {
      kind: step.kind,
      journalIdempotencyKey: key,
      ...(step.kind === "rotate-atomic" ? { priorTokenId: requireTokenId(position).toString(10) } : {}),
    });
    recordedCount += 1;

    // ─── PHASE3.22 R5.3 — THE PRE-SUBMIT RECOVERY MARKER ────────────────────
    //
    // STRICTLY BEFORE `beginWithSpend`, which is the ordering R5.3 makes
    // normative. From this line on, every ambiguous park of this sequence —
    // UNKNOWN submit, PENDING receipt, POST_VERIFY_FAILED — finds
    // `currentRecovery !== "none"` and therefore writes `held` instead of the
    // unabandonable `active` + `none`. See the flag's own docstring for why
    // that matters and why a stale marker on a terminal rollback is harmless.
    //
    // `advanceRecovery` returns false only when a resolver fence owns the row,
    // in which case this resume must write nothing at all — the same handling
    // every other call site gives it.
    if (step.markRecoveryBeforeSubmit === true) {
      if (!(await advanceRecovery(step.recoveryAfterConfirm))) {
        return fencedResult(planPos);
      }
    }

    const { otherSpendWei, created } = await deps.journal.beginWithSpend(
      {
        idempotencyKey: key,
        agentId,
        ownerAddress: owner,
        kind: "lp",
        decisionId,
        externalRef: { callsHash, publicKey: facts.publicKey },
        nativeSpendWei,
        begunAtBlock: market.blockNumber,
        finalCallsFingerprint: finalCalls.canonical,
        finalCallsFingerprintHash: finalCalls.hash,
      },
      deps.now() - DAILY_WINDOW_MS,
    );
    if (!created) {
      // A fresh key already existed: this process raced itself. Ambiguity
      // holds; nothing is resubmitted under the same key, ever.
      return holdSequence(
        "HELD_AMBIGUOUS",
        "The step's idempotency key already has a journal row; holding rather than resubmitting.",
        planPos,
      );
    }
    // The daily-cap re-check runs ONLY when the step actually attaches native
    // (item 10: the open's mint{value}; zero for every WBNB-paid step). A
    // zero-native step adds nothing to the meter, and refusing an exit
    // because the BUYS spent the budget is the (s)-family trap.
    if (
      nativeSpendWei > 0n &&
      exceedsDailyCap(deps.agent.caps, otherSpendWei, nativeSpendWei)
    ) {
      await deps.journal.markRolledBack(key, "Refused before submit: DAILY_CAP.");
      return refuseCleanly("DAILY_CAP", "The step would exceed the off-chain daily native cap.");
    }

    // Late kill-switch re-check, immediately before submit (mirrors /trade).
    const late = await authorizeExecute({
      agent: deps.agent,
      killswitch: deps.killswitch,
      now: nowSec(),
      reducesExposure: reduces,
    });
    if (!late.allowed) {
      await deps.journal.markRolledBack(
        key,
        sanitizeMessage(`Refused before submit: ${late.code}.`),
      );
      if (
        optional &&
        (late.code === "NO_SESSION" || late.code === "SESSION_EXPIRED")
      ) {
        // The rolled-back row is a provably-unsubmitted OPEN slot; the skip is
        // recorded at the NEXT index so both facts stay in the journal.
        const held = await recordSkip(step, `${late.code}: ${late.reason}`, facts.publicKey);
        if (held !== null) return held;
        continue;
      }
      return refuseCleanly(late.code, late.reason);
    }

    // (5a) EVERYTHING BEFORE THE SUBMIT, in its own block (PHASE2.4 R3).
    // A throw here provably never reached a relay: the row rolls back.
    let session: SessionRef;
    try {
      session = await withSessionKey(deps.agentStore, deps.agent, async (authority) =>
        deps.provider.restoreSession({
          spec: facts.spec,
          agent: authority,
          walletAddress: deps.agent.walletAddress,
          publicKey: facts.publicKey,
          expiresAt: facts.expiry,
        }),
      );
      await deps.provider.preflightExecute({ session, calls });
    } catch (error) {
      const refusal = asPlaneError(error, "lp step refused");
      // Classified on the RAW error (before `asPlaneError` flattens an
      // unrecognised failure into PROVIDER_ERROR) and BEFORE the roll-back, so
      // the row itself records whether this attempt was a transport failure.
      // That attribution is what the retry budget counts (G1); computing it
      // after the write would leave the row indistinguishable from a halt's.
      const transient = isTransientFailure(error);
      // PHASE3.1-FIXREVIEW3 **H2**: the code NAMED in a transient reason is the
      // CLASSIFIER's, never `asPlaneError`'s. `asPlaneError` does not classify —
      // it returns any non-plane error as a `ProviderError` — so a raw transport
      // throw out of `restoreSession` or `preflightExecute` wrote
      // `Refused before submission: PROVIDER_ERROR (transient).`: a row naming
      // the PERMANENT class while asserting the failure was transient, in the
      // one field `lastError` is now load-bearing for. Both halves of the
      // sentence come from one verdict now. At this site a transient verdict can
      // only come from the classifier (`LpTransientStepError` is raised solely
      // out of `build`, above), so this is `INFRASTRUCTURE_ERROR` whenever
      // `transient` holds — and `TRANSIENT_ROLLBACK_REASON` accepts any
      // `[A-Z_]+`, so the budget's count is unaffected either way.
      const transientCode = mapProviderError(error).code;
      await deps.journal.markRolledBack(
        key,
        transient
          ? transientRollbackReason(transientCode)
          : sanitizeMessage(`Refused before submission: ${refusal.code}.`),
      );
      if (optional) {
        // A1: `restoreSession` and `preflightExecute` cover session-key
        // decryption, the Altana SDK transport and the relay's preflight —
        // none of which are "refusals" in item 12's sense when the failure is
        // an outage. The classification was taken above, on the RAW error, so
        // the row's own reason and this decision cannot disagree.
        const held = await refuseOptionalStep(
          step,
          "STEP_REFUSED",
          // H2 again: the hold the owner reads says "Transient failure …", so
          // the code beside the message must be the classifier's too.
          `${transient ? transientCode : refusal.code}: ${refusal.message}`,
          transient,
          // This step's row was appended and `markRolledBack` above: the
          // attempt is already on the record, and re-recording it would spend
          // the retry budget twice per cycle.
          true,
          facts.publicKey,
        );
        if (held !== null) return held;
        continue;
      }
      return refuseCleanly("STEP_REFUSED", `${refusal.code}: ${refusal.message}`);
    }

    // (5b) THE SUBMIT. From here on, ambiguity is the rule.
    let receipt: ExecutionReceipt;
    try {
      const submitPreparedLp = deps.provider.submitPreparedLp;
      if (submitPreparedLp === undefined) {
        throw new ProviderError("Wallet provider lacks the mandatory staged LP capability.");
      }
      const stagedSubmit = { provider: { executeViaSession: (_request: Record<string, never>) => withSessionKey(
        deps.agentStore, deps.agent, async (authority, sessionPrivateKey) => {
          const restored = deps.provider.restoreSession({
            spec: facts.spec,
            agent: authority,
            walletAddress: deps.agent.walletAddress,
            publicKey: facts.publicKey,
            expiresAt: facts.expiry,
          });
          return submitPreparedLp.call(deps.provider, {
            journalIdempotencyKey: key,
            expectedBindingVersion: 0,
            sessionPrivateKey,
            walletAddress: deps.agent.walletAddress,
            persistedSession: facts,
            restoredSessionPublicKey: restored.publicKey,
            restoredSessionExpiry: facts.expiry,
            calls,
            expectedExecutionDataHash: finalCalls.value.executionDataHash,
            bind: async (request) => {
              const bound = await deps.journal.bindPreparedIntent(key, {
                canonicalIdentity: request.canonicalIdentity,
                identityHash: request.identityHash,
                expectedBindingVersion: request.expectedBindingVersion,
              });
              return {
                ...request,
                boundBindingVersion: bound.boundBindingVersion,
              };
            },
          });
        },
      ) } };
      // Keep the ambiguity window shaped as one provider operation. This is an
      // owned local facade over the staged Porto path above, not the legacy
      // WalletProvider.executeViaSession implementation.
      receipt = await (async (deps) => deps.provider.executeViaSession({}))(stagedSubmit);
    } catch (error) {
      if (isProvenPreBindStagedLpError(error)) {
        // The classification alone is not diagnosable: a pre-bind refusal is
        // PROVABLY safe, but "which check refused" is exactly what an operator
        // needs, and overwriting the cause with the bare family name cost this
        // repo two live phases of guessing. The proof carries the underlying
        // message; keep it, sanitized like every other journalled error.
        // The ternary is not dead code (FIXREVIEW7 F9):
        // `isProvenPreBindStagedLpError` returns `boolean`, not a type
        // predicate, so `error` is still `unknown` here and the narrowing is
        // what the compiler requires to read `.message` at all.
        await deps.journal.markRolledBack(
          key,
          sanitizeMessage(
            `Refused before submission: STAGED_PRE_BIND. ${
              error instanceof Error ? error.message : "cause unavailable"
            }`,
          ),
        );
        return refuseCleanly(
          "STEP_REFUSED",
          "The staged LP submit was refused before its durable prepared-intent bind.",
        );
      }
      const mapped = asPlaneError(error, "lp step failed");
      await deps.journal.markUnknown(key, sanitizeMessage(mapped.message));
      return holdSequence(
        "HELD_AMBIGUOUS",
        "Submission outcome is unknown and is held for reconciliation; ambiguity never auto-replays.",
        planPos,
      );
    }

    // AUDIT A4. The flag is set for ANY receipt, not only one carrying a
    // `callsId`: getting an answer back from the staged submit IS the
    // submission window, and a provider that returns FAILED without a batch id
    // would otherwise roll its row back bare — which
    // `lpReservationReleasable` reads as never-submitted, freeing the slot and
    // voiding the upper bound `checkLpNativeCapSizing` leans on. The shipped
    // Altana provider always sets `callsId`, so this is dead code today; the
    // `WalletProvider` seam exists to admit a second one.
    submittedThisRun = true;
    if (receipt.callsId !== undefined) {
      await deps.journal.markInProgress(key, { callsId: receipt.callsId });
    }
    if (receipt.status === "FAILED") {
      await deps.journal.markRolledBack(
        key,
        sanitizeMessage(receipt.failureCode ?? "LP step reported FAILED."),
      );
      const failure = `Execution reported FAILED (${receipt.failureCode ?? "PROVIDER_ERROR"}).`;
      if (optional) {
        // THE UNBOUNDED-GAS CASE (Rev2 item 12). Holding here would leave the
        // ROLLED_BACK row looking like an OPEN slot to audit A1's join, and
        // the worker would resubmit the reverting swap every cycle for ever.
        // Recording a SKIP at the next index closes the plan position instead:
        // the position is already empty and the owner holds the token.
        const held = await recordSkip(step, failure, facts.publicKey);
        if (held !== null) return held;
        continue;
      }
      return refuseCleanly("STEP_REFUSED", failure);
    }
    if (receipt.status !== "CONFIRMED") {
      // PENDING with a callsId stays IN_PROGRESS; reconcile resolves the row
      // and only then may the sequence advance or roll back (Rev2 item 9).
      return holdSequence(
        "HELD_AMBIGUOUS",
        "Submission is pending; held until reconcile resolves the step row.",
        planPos,
      );
    }
    await deps.journal.markCommitted(
      key,
      receipt.transactionHash === undefined
        ? {}
        : { txHash: receipt.transactionHash },
    );
    confirmedMoney += 1;
    if (step.optional === true) {
      // A5's companion: a hold on this step wrote "the conversion is still
      // owed". The conversion just happened, so that sentence must not outlive
      // it — an owner reading a COMPLETED exit must not be told a swap is owed
      // when it was made. A `recordSkip` note is never cleared here, because a
      // skipped step never reaches this line.
      try {
        await deps.store.setSequenceNote(owner, agentId, sequenceId, null);
      } catch {
        /* the note explains; it never decides */
      }
    }

    // Recovery marker: this step confirmed, its tail is owed (spec body's
    // partial-completion table). Set BEFORE post-verify so a crash right here
    // resumes into the correct named state.
    if (step.recoveryAfterConfirm !== currentRecovery) {
      await deps.store.setRecoveryState(
        owner,
        agentId,
        sequenceId,
        step.recoveryAfterConfirm,
      );
      currentRecovery = step.recoveryAfterConfirm;
    }

    // (f) Post-step state verification (Rev2 item 32). Money already moved;
    // a mismatch parks the sequence for an operator, never retries blind.
    try {
      await step.after(receipt.transactionHash, false, {
        // D2: the LIVE path passes the key `beginWithSpend` was called with.
        journalIdempotencyKey: key,
        sequenceId,
      });
    } catch (error) {
      return holdSequence("POST_VERIFY_FAILED", messageOf(error), planPos);
    }
    planPos += 1;
  }

  /* ----- every plan position confirmed -------------------------------------- */

  if (input.finish !== undefined) await input.finish(sequenceId);
  if (currentRecovery !== "none") {
    await deps.store.setRecoveryState(owner, agentId, sequenceId, "none");
  }
  await deps.store.setSequenceState(owner, agentId, sequenceId, "completed");
  // A completed sequence normally committed something and holds its slot; the
  // gate below decides, so an all-SKIPPED completion is evaluated rather than
  // assumed. (It still holds today: skipped plan positions record no rows, but
  // `submittedThisRun` is false and the join's rows are re-read, so the honest
  // answer comes from the evidence rather than from the status.)
  await releaseReservationIfUnspent();
  return {
    sequenceId,
    kind,
    status: "completed",
    code: "COMPLETED",
    reason: createdFresh
      ? "Sequence completed."
      : "Sequence resumed and completed.",
    confirmedSteps: planPos,
  };
}

/* -------------------------------------------------------------------------- */
/* Shared step constructors                                                   */
/* -------------------------------------------------------------------------- */

/** Carried state a sweep/mint pair shares. Rebuilt from receipts on resume. */
type FreedState = {
  freedWbnbWei: bigint;
  freedTokenWei: bigint;
};

function makeSweepStep(input: {
  readonly deps: LpSagaDeps;
  readonly position: LpPositionRecord;
  readonly legs: PoolLegs;
  readonly state: FreedState;
  /** The range the sweep balances toward. Fresh per build. */
  readonly targetRange: (
    market: LpSagaMarket,
  ) => Promise<{ readonly tickLower: number; readonly tickUpper: number }>;
  readonly recoveryAfterConfirm: LpRecoveryState;
  /**
   * PHASE3.13 (review F9, and the ORDERING constraint of its section 2(d)).
   *
   * The swapless decision, injected as a STEP INPUT by the only caller that has
   * one — the rotate. `makeSweepStep` is shared with the exit and the harvest,
   * so it must never read a mode off `deps`: with the decision arriving here,
   * `tsc` proves the other two sweeps are untouched, rather than an argument
   * doing it.
   *
   * It is consulted FIRST, BEFORE `targetRange` and before `planLpSweep`, and
   * that order is load-bearing rather than tidy. `computeSwapAmount` against a
   * range that does not contain the tick is TOTAL by definition — that is
   * exactly what Phase 3.12's `swapSplitIsTotal` names — so calling
   * `planLpSweep` on an adjacent range does NOT return `null`; it returns a
   * WHOLE-LEG SALE at market, the opposite of a fallback. Deciding first also
   * keeps the "already balanced" null-skip reachable only on the swapped path,
   * where it still means what it has always meant, so the two skip reasons can
   * never compete for one step.
   *
   * Returns the skip reason, or `null` to fall through to today's code verbatim.
   */
  readonly swaplessSkip?: (
    market: LpSagaMarket,
  ) => Promise<string | null>;
  /**
   * PHASE3.13: fired from `after` whenever this step confirmed with NO txHash,
   * i.e. it was skipped — on the live path (`replay: false`) and on the resume
   * replay (`replay: true`) alike. The rotate uses the replay half; nothing
   * else supplies this callback, so the exit and harvest sweeps are unchanged.
   */
  readonly onSweepSkipped?: (replay: boolean) => void;
}): PlannedStep {
  const { deps, position, legs, state } = input;
  const wbnb = deps.venue.wbnb;
  return {
    kind: "sweep-token",
    // Re-shaping assets toward re-entry is not an exit: strict under pause.
    reducesExposure: false,
    recoveryAfterConfirm: input.recoveryAfterConfirm,
    // F3: only the swapless-capable sweep persists its skip reason. The exit's
    // sweep already gets its note from `optional`; the harvest's never skips
    // for a product reason.
    ...(input.swaplessSkip === undefined ? {} : { noteOnSkip: true }),
    build: async (ctx) => {
      if (input.swaplessSkip !== undefined) {
        const reason = await input.swaplessSkip(ctx.market);
        if (reason !== null) return { action: "skip", reason };
      }
      const range = await input.targetRange(ctx.market);
      const plan = planLpSweep({
        wbnbFreedWei: state.freedWbnbWei,
        tokenFreedWei: state.freedTokenWei,
        wbnbIsToken0: legs.wbnbIsToken0,
        currentTick: ctx.market.currentTick,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        spotSqrtPriceX96: ctx.market.spotSqrtPriceX96,
      });
      if (plan === null) {
        return {
          action: "skip",
          reason: "The freed legs already match the range's required ratio.",
        };
      }
      const tokenIn = plan.direction === "wbnb-to-token" ? wbnb : legs.token;
      const tokenOut = plan.direction === "wbnb-to-token" ? legs.token : wbnb;
      // Fresh QuoterV2 quote → server-derived floor (Rev2 item 23). The swap
      // runs in THE POSITION'S OWN POOL, single hop, always (Rev2 item 31).
      const quotedOut = await deps.quote({
        tokenIn,
        tokenOut,
        fee: position.fee,
        amountInWei: plan.amountInWei,
      });
      // Audit A2: re-derive THIS leg's quoted-vs-spot impact and refuse above
      // the rail, exactly as `/lp/open` does (`open.ts` `buildOpenCalls`). The
      // evidence's `priceImpactBps` is a hardcoded 0n (it can describe no
      // particular swap), so without this check the `maxPriceImpactBps` rail
      // is inert on the autonomous rotate/harvest sweep legs — a thin pool
      // that passes the TWAP/liquidity rails could still execute a
      // high-impact sweep inside its own slippage floor. Throwing here is a
      // clean BUILD_REFUSED: rolled back before money, held after.
      const tokenInIsToken0 =
        plan.direction === "wbnb-to-token"
          ? legs.wbnbIsToken0
          : !legs.wbnbIsToken0;
      // PHASE3.1 Rev2 item 16, an ERRATUM to this very check: `spotSwapOutput`
      // names its parameter `amountInAfterFee` and A2 fed it the RAW amount,
      // so the POOL'S OWN FEE was counted as impact — measured at 1/5/25/103
      // bps for the 100/500/2500/10000 tiers on live CAKE/WBNB. Deducted here
      // and at the exit swap, the two sites the item enumerates, so they
      // cannot diverge.
      const expectedAtSpot = spotSwapOutput({
        amountInAfterFee: amountInAfterPoolFee(plan.amountInWei, position.fee),
        sqrtPriceX96: ctx.market.spotSqrtPriceX96,
        tokenInIsToken0,
      });
      const impactBps = quotePriceImpactBps(expectedAtSpot, quotedOut);
      if (impactBps > BigInt(deps.rails.maxPriceImpactBps)) {
        throw new Error(
          "Quoted price impact of the sweep leg exceeds the manipulation-rail ceiling.",
        );
      }
      const minOutWei = sagaSwapMinOut(quotedOut, deps.rails.maxSagaSlippageBps);
      return {
        action: "submit",
        calls: buildLpSweepSwap({
          router: deps.venue.routerV3,
          tokenIn,
          tokenOut,
          fee: position.fee,
          amountInWei: plan.amountInWei,
          minOutWei,
          recipient: deps.agent.walletAddress,
          deadline: ctx.deadline,
        }),
      };
    },
    after: async (txHash, replay) => {
      if (txHash === undefined) {
        // Skipped: nothing moved. The callback only RECORDS that fact.
        input.onSweepSkipped?.(replay);
        return;
      }
      const swap = await deps.receipts.swapAmounts(txHash);
      const inIsWbnb = swap.tokenIn.toLowerCase() === wbnb.toLowerCase();
      if (inIsWbnb) {
        state.freedWbnbWei -= swap.amountInWei;
        state.freedTokenWei += swap.amountOutWei;
      } else {
        state.freedTokenWei -= swap.amountInWei;
        state.freedWbnbWei += swap.amountOutWei;
      }
      if (state.freedWbnbWei < 0n || state.freedTokenWei < 0n) {
        throw new Error(
          "The confirmed sweep receipt reports more input than the collect freed; refusing to carry a negative amount forward.",
        );
      }
    },
  };
}

/**
 * PHASE3.13: everything one swapless decision concluded, on ONE market read.
 *
 * Carried so the sweep's recorded skip and the mint's independent
 * re-derivation can be COMPARED (review F8) rather than one trusting the
 * other's cache.
 */
type SwaplessPlacement = {
  readonly side: SwaplessRotationSide;
  /** The range the position is being rotated OUT of. */
  readonly prior: { readonly tickLower: number; readonly tickUpper: number };
  /** The freed legs in POOL ORDER — the 3.12 review's F7 inversion hazard. */
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly residueWei: bigint;
  readonly residueBps: bigint;
  readonly range: { readonly tickLower: number; readonly tickUpper: number };
};

/** Map carried WBNB/TOKEN amounts onto pool-ordered legs. */
function poolOrderedAmounts(
  legs: PoolLegs,
  state: FreedState,
): { amount0: bigint; amount1: bigint } {
  return legs.wbnbIsToken0
    ? { amount0: state.freedWbnbWei, amount1: state.freedTokenWei }
    : { amount0: state.freedTokenWei, amount1: state.freedWbnbWei };
}

/* -------------------------------------------------------------------------- */
/* Protect / manual exit                                                      */
/* -------------------------------------------------------------------------- */

/**
 * TP/SL protect: `[zap-out (unwrap to native), sweep-token (exit swap)]` — the
 * ONLY saga that unwraps (PHASE3 Rev2 item 14, CLARIFIED by PHASE3.1 Rev2 item
 * 23: it now does so in TWO submissions and on TWO contracts, the NFPM's
 * `unwrapWETH9` for the quote leg in step 0 and the router's for the swapped
 * leg in step 1). It must never be trapped: every step runs `authorizeExecute`
 * with `reducesExposure: true` (Rev2 item 16), and the reservation never
 * throws on quota (Rev2 item 13).
 *
 * Takes {@link LpSagaDeps} — the brain-free deps type. There is no parameter
 * through which a range proposal could reach this path (Rev2 item 28).
 */
export async function runLpProtect(
  deps: LpSagaDeps,
  positionId: string,
): Promise<LpSagaRunResult> {
  return runExitSaga(deps, positionId, "protect", false);
}

/** The owner-signed manual exit: same plan, same carve-outs, kind differs. */
export async function runLpManualExit(
  deps: LpSagaDeps,
  positionId: string,
  inlineConvert = false,
): Promise<LpSagaRunResult> {
  return runExitSaga(deps, positionId, "manual-exit", inlineConvert);
}

/** PHASE3.24 R2.4 — one wording source for the owner-visible residue. */
export function lpInlineResidueNote(residueBaseWei: bigint): string {
  return `Inline conversion left ${residueBaseWei.toString(10)} base-token wei in the wallet. This is material residue, not dust.`;
}

async function runExitSaga(
  deps: LpSagaDeps,
  positionId: string,
  kind: "protect" | "manual-exit",
  requestedInlineConvert: boolean,
): Promise<LpSagaRunResult> {
  const position = await requirePosition(deps, positionId, "exit");
  const owner = deps.agent.ownerAddress;
  const agentId = deps.agent.id;
  const legs = poolLegs(position, deps.venue.wbnb);
  const inlineTokenCompatible = [...deps.conversionCompatibleTokens]
    .some((token) => token.toLowerCase() === legs.token.toLowerCase());
  // PHASE3.24 C2: protect cannot enter this branch. Manual exit additionally
  // needs the persisted/requested consent, the existing exitToQuote setting,
  // and the boot-default-empty token allowlist.
  const inlineEligible = kind === "manual-exit"
    && requestedInlineConvert
    && deps.exitToQuote
    && inlineTokenCompatible;
  /**
   * The exact confirmed non-quote delta step 0 freed — the ONLY input step 1's
   * swap may size itself on (PHASE3.1 Rev2 item 14 / PHASE3 Rev2 item 32).
   *
   * `collectAmounts` is a LOWER bound on what the wallet actually received:
   * `buildLpZapOutBatch` collects to the NFPM and then `sweepToken`s the
   * NFPM'S ENTIRE balance of that leg to the wallet. Under-approving and
   * under-swapping is the safe direction, and it is why a PRE-EXISTING wallet
   * balance of the same token is never touched — the exit converts what THIS
   * exit produced, nothing else.
   */
  const freed: { tokenWei: bigint } = { tokenWei: 0n };
  const inline: { residueBaseWei: bigint | null } = { residueBaseWei: null };

  /** State-aware transition: hooks may run on any resume of the exit. */
  const setPositionStateIfNeeded = async (
    from: readonly ("open" | "closing" | "closed")[],
    to: "open" | "closing" | "closed",
  ): Promise<void> => {
    const current = await deps.store.getPosition(owner, agentId, positionId);
    if (current !== null && from.includes(current.state) && current.state !== to) {
      await deps.store.setPositionState(owner, agentId, positionId, to);
    }
  };

  const plan: readonly PlannedStep[] = [
    {
      kind: "zap-out",
      reducesExposure: true,
      // PHASE3.11 F2. This step declared `none`, which made `holdSequence`'s
      // guard DEAD CODE for every exit: any hold after the zap-out committed
      // left the row `active`+`none` — un-abandonable, permanently, with no
      // crash involved — on the one saga that must never trap a position. What
      // is physically true once this confirms is `wbnb-stranded`'s own
      // definition: the principal is out of the NFT and sitting in the owner's
      // EOA, with the optional conversion possibly still owed. No DISPOSITION
      // keys on this label (AUDIT A2 moved that to step evidence), and the
      // completion path resets it to `none`.
      recoveryAfterConfirm: "wbnb-stranded",
      build: async (ctx) => {
        const tokenId = requireTokenId(position);
        const snapshot = await deps.positions(tokenId);
        if (snapshot === "burned") {
          return {
            action: "skip",
            reason: "Position token is already burned; nothing to withdraw.",
          };
        }
        if (snapshot.liquidity <= 0n) {
          return {
            action: "skip",
            reason: "Position holds no liquidity; nothing to withdraw.",
          };
        }
        const floors = sagaDecreaseFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
          liquidity: snapshot.liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
        });
        const zapOutCalls = buildLpZapOutBatch({
            nfpm: deps.venue.nfpm,
            tokenId,
            token0: position.token0,
            token1: position.token1,
            wbnb: deps.venue.wbnb,
            liquidity: snapshot.liquidity,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            deadline: ctx.deadline,
            wallet: deps.agent.walletAddress,
          });
        if (!inlineEligible) return { action: "submit", calls: zapOutCalls };

        // PHASE3.24 C2/C3: amountIn is EXACTLY the base-leg decrease floor.
        // Owed fees, collected amounts, residues and wallet balances are not
        // available at build time and must never be added later.
        const amountInWei = legs.wbnbIsToken0
          ? floors.amount1Min
          : floors.amount0Min;
        if (amountInWei <= 0n) return { action: "submit", calls: zapOutCalls };
        let quotedOut: bigint;
        try {
          quotedOut = await deps.quote({
            tokenIn: legs.token,
            tokenOut: deps.venue.wbnb,
            fee: position.fee,
            amountInWei,
          });
        } catch {
          // No money has moved. A failed inline quote falls back to the shipped
          // four-call withdrawal; its existing optional step owns retry/skip.
          return { action: "submit", calls: zapOutCalls };
        }
        if (quotedOut <= deps.relayFeePerSubmitWei) {
          return { action: "submit", calls: zapOutCalls };
        }
        const expectedAtSpot = spotSwapOutput({
          amountInAfterFee: amountInAfterPoolFee(amountInWei, position.fee),
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tokenInIsToken0: !legs.wbnbIsToken0,
        });
        if (quotePriceImpactBps(expectedAtSpot, quotedOut) > BigInt(deps.rails.maxPriceImpactBps)) {
          return { action: "submit", calls: zapOutCalls };
        }
        return {
          action: "submit",
          calls: [
            ...zapOutCalls,
            ...buildLpExitSwap({
              router: deps.venue.routerV3,
              wbnb: deps.venue.wbnb,
              quoteToken: deps.venue.wbnb,
              token: legs.token,
              fee: position.fee,
              amountInWei,
              minOutWei: sagaSwapMinOut(quotedOut, deps.rails.maxSagaSlippageBps),
              recipient: deps.agent.walletAddress,
              deadline: ctx.deadline,
            }),
          ],
        };
      },
      after: async (txHash, _replay, ctx) => {
        try {
        if (txHash === undefined) {
          // SKIPPED: the position was already burned or already held no
          // liquidity, so the lineage is over exactly as much as it is after a
          // confirmed zap-out.
          //
          // PHASE3.1-AUDIT A4: leaving it `closing` here opened a churn loop
          // absent before 3.1. A skipped step 0 leaves `confirmedMoney === 0`,
          // so a HOLD-class refusal on step 1 (GLOBAL_HALT or
          // SETTINGS_DIGEST_MISMATCH, both checked before `build`) took
          // `refuseCleanly`'s ROLLBACK branch → `abandon()` →
          // `closing → open`, returning an EMPTY position to the trigger queue
          // with its basis intact. `lpProtectionStatus` then reported
          // `armed: true` and the worker dispatched another protect every
          // cycle for the duration of an operator halt.
          //
          // Closing here makes `abandon()`'s `closing → open` a no-op by
          // construction (`closed ∉ from`), which is the audit's own fix
          // direction. Idempotent, so the replay path is safe.
          //
          // ONE RESIDUAL, stated rather than discovered (PHASE3.1-FIXREVIEW
          // F7): `liquidity <= 0` is also true of a position whose liquidity
          // was withdrawn OUT OF BAND while its `tokensOwed` still sit in the
          // NFPM. Before this write such a row could return to `open` under a
          // HOLD-class refusal and a later harvest could still collect those
          // fees; now it cannot. Accepted — the churn loop removed above is the
          // worse failure, every other path already closed the row at
          // `finish()`, and no funds leave custody: the owner still holds the
          // position NFT and can collect out of band. So "the lineage is over
          // exactly as much as a zapped-out one's" is exact for a BURNED or
          // genuinely EMPTY position, and for an empty-with-fees one it means
          // the plane stops tracking fees it never accounted for anyway.
          await setPositionStateIfNeeded(["open", "closing"], "closed");
          return;
        }
        const snapshot = await deps.positions(requireTokenId(position));
        // The burned revert is POSITIVE confirmation here (Rev2 item 32):
        // an emptied position may have been burned by someone since.
        if (snapshot !== "burned" && snapshot.liquidity !== 0n) {
          throw new Error(
            "Post-step verification failed: the zap-out confirmed but the position still reports liquidity.",
          );
        }
        // PHASE3.1 Rev2 item 13: the position closes HERE, the moment step 0
        // confirms — not at `finish()`. The batch is atomic and both legs are
        // already in the wallet, so the lineage is genuinely over; deferring
        // the write would let a refused or ambiguous step 1 leave a `closing`
        // GHOST that `POST /lp/settings` counts in `openPositionsCount` and
        // sums into `openNativeBudgetWei` for ever. Idempotent, so the replay
        // path is safe. Consequence, accepted deliberately: this write ZEROES
        // `basisWei` (R7), so the basis is gone before step 1 builds — one
        // more reason the dust floor below is absolute, never a fraction of
        // basis (item 17).
        await setPositionStateIfNeeded(["open", "closing"], "closed");
        // Item 14: the exact confirmed delta, from the receipt, on BOTH the
        // live and the replay path — exactly as rotate's zap-out does it. The
        // spec body's claim that this plumbing already existed was true of
        // `makeSweepStep` and FALSE of the exit saga.
        const collected = await deps.receipts.collectAmounts(txHash);
        const collectedBaseWei = legs.wbnbIsToken0
          ? collected.amount1Wei
          : collected.amount0Wei;
        // AUDIT A1: receipt interpretation follows the write-once consent that
        // driveSequence already reconciled against the row, never today's
        // ambient compatibility set. The latter decides what may be BUILT; it
        // cannot erase evidence that the prior boot may already have submitted.
        if (kind === "manual-exit" && requestedInlineConvert) {
          if (deps.receipts.expectedPoolSwap === undefined) {
            throw new Error("The dedicated expected-pool inline Swap witness is unavailable.");
          }
          // PHASE3.24 C3: never substitute swapAmounts here. Zero means the
          // inline calls were not emitted/committed and preserves the shipped
          // collect fallback. Every non-table shape throws in the reader.
          const witnessed = await deps.receipts.expectedPoolSwap(
            txHash,
            deps.expectedPool,
            !legs.wbnbIsToken0,
          );
          if (witnessed !== null) {
            const residueBaseWei = collectedBaseWei - witnessed.amountInWei;
            if (residueBaseWei < 0n) {
              throw new Error("The inline Swap input exceeds the confirmed collected base leg.");
            }
            inline.residueBaseWei = residueBaseWei;
            freed.tokenWei = 0n;
            await deps.store.recordInlineResidue(
              owner,
              agentId,
              ctx.sequenceId,
              residueBaseWei,
              lpInlineResidueNote(residueBaseWei),
            );
            return;
          }
        }
        freed.tokenWei = collectedBaseWei;
        } finally {
          await recordLpFeeEvents({ deps, ctx: ctx, txHash, position });
        }
      },
    },
    {
      // PHASE3.1 Rev2 item 10: the plan is ALWAYS two positions, whatever
      // `exitToQuote` says. A plan whose LENGTH varied with a settings field
      // would make a resumed sequence hit PLAN_MISMATCH → `held` with recovery
      // `none` — which `isTerminalLpSequence` reads as TERMINAL, releasing a
      // position that is still `closing`. Fixed length removes that state
      // entirely, and every product refusal below is an ordinary recorded SKIP
      // the landed driver already handles (item 11).
      //
      // The step kind is the EXISTING `sweep-token`: `LpStepKind` is a
      // code-level union and `lp_sequences.steps` is jsonb with no enum CHECK,
      // so reusing it costs no migration where a new kind would need one.
      kind: "sweep-token",
      // Item 20: honest, and INERT for exit kinds — `driveSequence` forces
      // `reduces = true` for protect/manual-exit regardless of this field.
      // Stated so nobody later "fixes" the driver by honouring it.
      reducesExposure: true,
      // F2, the same rule one step later: `none` here would re-open the trap
      // for a hold between this step's confirm and its post-verify, because
      // the marker is deliberately written BEFORE `after`. The freed principal
      // is in the wallet until the sequence completes, and completion clears
      // the label.
      recoveryAfterConfirm: "wbnb-stranded",
      optional: true,
      build: async (ctx) => {
        if (!deps.exitToQuote) {
          return {
            action: "skip",
            reason:
              "exitToQuote is off in the owner's settings; the freed token leg was returned as-is.",
          };
        }
        if (freed.tokenWei <= 0n) {
          return {
            action: "skip",
            reason: inline.residueBaseWei === null
              ? "The exit freed no non-quote leg; there is nothing to convert."
              : lpInlineResidueNote(inline.residueBaseWei),
          };
        }
        // THE OUTPUT LEG IS THE POOL'S OWN QUOTE LEG — `deps.venue.wbnb`, the
        // configured WBNB that `poolLegs` already proved this position has.
        //
        // Rev2 item 5 phrases the destination as `position.quoteToken` and
        // asserts `quoteToken === venue.wbnb` is "always true in v1". IT IS
        // NOT: `LpPositionRecord.quoteToken` defaults to `DEFAULT_QUOTE_TOKEN`,
        // a hardcoded BNB-Chain-56 WBNB literal in `src/store/lpSequences.ts`,
        // and nothing on the `/lp/open` path ever overrides it — so on any
        // deployment whose configured WBNB is a different address (testnet,
        // and every offline fixture) the two differ. Keying the swap off the
        // recorded field, or refusing when the two disagree, would make the
        // exit skip on EVERY position of such a deployment, silently and for
        // ever: this phase's own defect wearing this phase's fix. The pool's
        // quote leg is the asset the basis is really denominated in and the
        // only one reachable in the position's own pool in one hop (item 4),
        // so it is the authority here. Item 5's real requirement — that a
        // non-WBNB quote asset LOSES the unwrap rather than emitting a wrong
        // one — lives in `buildLpExitSwap` and is tested there.
        const quoteToken = deps.venue.wbnb;
        let quotedOut: bigint;
        try {
          quotedOut = await deps.quote({
            tokenIn: legs.token,
            tokenOut: quoteToken,
            fee: position.fee,
            amountInWei: freed.tokenWei,
          });
        } catch (error) {
          // PHASE3.1-AUDIT A1: this catch was BARE, so a 429, a 5xx or a
          // dropped connection from the pinned dataseed — the likeliest
          // failures at the exact moment a stop-loss fires — became a
          // PERMANENT, unretryable skip and the owner kept the volatile leg for
          // ever: this phase's own defect wearing this phase's fix. A transport
          // failure is signalled to the driver, which HOLDS and retries next
          // cycle up to OPTIONAL_TRANSIENT_RETRY_ATTEMPTS times. Anything else
          // is the product refusal this catch always was.
          //
          // PHASE3.1-FIXREVIEW F1: this comment used to name "a socket reset"
          // among the covered failures and that was FALSE — the class recognised
          // HTTP-status failures only, so a reset took the permanent skip. The
          // sentence is true now because `src/core/errors.ts` was widened to
          // recognise connection-level failures, not because the sentence was
          // softened.
          if (isTransientFailure(error)) {
            throw new LpTransientStepError(
              "The exit swap's fresh quote could not be read (transport failure).",
            );
          }
          return {
            action: "skip",
            reason: "The exit swap's fresh quote could not be read; the token leg was returned as-is.",
          };
        }
        // Item 17: the dust floor is the whole-submission RESERVE constant,
        // with NO multiplier — swapping a leg worth less than the gas to swap
        // it destroys value, and reusing the reserve constant means the floor
        // moves with it when a live run replaces the placeholder. Absolute,
        // never a fraction of basis: the basis was zeroed by item 13 above,
        // gas is an absolute cost, and a percentage floor would skip large
        // value on a large position and swap dust on a small one.
        if (quotedOut <= deps.relayFeePerSubmitWei) {
          return {
            action: "skip",
            reason:
              "The exit swap's quoted output is at or below one submission's relay fee; swapping it would destroy value.",
          };
        }
        // Item 16, the ERRATUM TO AUDIT A2's FIX: deduct the POOL'S OWN FEE
        // before comparing against spot. Fed the raw amount — as every A2 call
        // site was — this reads `impactBps ≈ feeTierBps`, so at the
        // deployment's `LP_MAX_PRICE_IMPACT_BPS=100` a position in a 1% pool
        // could NEVER exit to quote, silently and permanently (item 11 makes
        // the refusal a skip). A pool's advertised fee is not manipulation.
        const expectedAtSpot = spotSwapOutput({
          amountInAfterFee: amountInAfterPoolFee(freed.tokenWei, position.fee),
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tokenInIsToken0: !legs.wbnbIsToken0,
        });
        const impactBps = quotePriceImpactBps(expectedAtSpot, quotedOut);
        if (impactBps > BigInt(deps.rails.maxPriceImpactBps)) {
          // A PRODUCT refusal, returned rather than thrown (item 11): refusing
          // at a manipulated price leaves the owner holding the token, which
          // is exactly Phase 3's outcome and never worse — the one place in
          // the plane where a rail refusal costs the user nothing.
          return {
            action: "skip",
            reason:
              "Quoted price impact of the exit swap exceeds the manipulation-rail ceiling; the token leg was returned as-is.",
          };
        }
        const minOutWei = sagaSwapMinOut(quotedOut, deps.rails.maxSagaSlippageBps);
        return {
          action: "submit",
          calls: buildLpExitSwap({
            router: deps.venue.routerV3,
            wbnb: deps.venue.wbnb,
            quoteToken,
            token: legs.token,
            fee: position.fee,
            amountInWei: freed.tokenWei,
            minOutWei,
            recipient: deps.agent.walletAddress,
            deadline: ctx.deadline,
          }),
        };
      },
      // Nothing to verify and nothing to carry: the position is already closed
      // and the proceeds are native in the owner's own EOA. A post-verify
      // throw here would HOLD (item 12), which is the one thing this step must
      // never do.
      after: async () => {},
    },
  ];

  return driveSequence({
    deps,
    kind,
    position,
    plan,
    ...(kind === "manual-exit" ? { inlineConvert: requestedInlineConvert } : {}),
    begin: async () => {
      await setPositionStateIfNeeded(["open"], "closing");
    },
    finish: async () => {
      // Closing the lineage resets the basis in the same write (R7). Already
      // `closed` is the normal path now (item 13 closes at step 0's confirm);
      // this idempotent call remains for the step-0-SKIPPED case — a burned or
      // empty position, where no txHash ever existed.
      await setPositionStateIfNeeded(["open", "closing"], "closed");
    },
    abandon: async () => {
      // A rolled-back exit (refused above the submit) puts the position back
      // in play — the store's documented `closing → open` transition. Only
      // from `closing`: a `closed` position moved money and never rolls back.
      await setPositionStateIfNeeded(["closing"], "open");
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Rotate                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Auto-rebalance: `[zap-out-keep-wbnb, sweep-token?, mint-wbnb]`.
 *
 * The zap-out does NOT unwrap and the re-mint pays BOTH legs as ERC-20s under
 * exact approves — rotations are native-cap-neutral except relay gas (Rev2
 * item 14). The new range comes from the injected `proposeRange` when
 * present, ALWAYS through the fence; otherwise (or on any fence failure) from
 * the deterministic `centeredRotationRange`. The confirmed mint's tokenId is
 * recorded on the SAME lineage with the basis untouched (R7).
 *
 * NOTE on resume: the chosen range is deliberately NOT persisted — a resume
 * re-chooses it against fresh evidence (fence and rails re-apply). A sweep
 * balanced for a range chosen last cycle can therefore feed a mint into a
 * slightly different range; the mint's desired amounts are the ACTUAL
 * confirmed balances and its floors come from the fresh rail-checked price,
 * so the cost of the re-choice is dust left in the wallet, never an unbounded
 * execution.
 */
/** R2.9: callers pass only the driver's live join, in recorded order. */
export function selectRotatePlanShape(liveSteps: readonly Pick<LpSequenceStep, "kind">[], preference: boolean): "atomic" | "legacy" | "unsupported" {
  if (liveSteps.length === 0) return preference ? "atomic" : "legacy";
  if (liveSteps.length === 1 && liveSteps[0]?.kind === "rotate-atomic") return "atomic";
  const legacy = ["zap-out", "sweep-token", "zap-in-mint"];
  if (liveSteps.length <= legacy.length && liveSteps.every((step, index) => step.kind === legacy[index])) return "legacy";
  return "unsupported";
}

export async function runLpRotate(deps: LpRotateDeps, positionId: string): Promise<LpSagaRunResult> {
  const sequence = await deps.store.getNonTerminalSequence(deps.agent.ownerAddress, deps.agent.id, positionId);
  const live: LpSequenceStep[] = [];
  for (const step of sequence?.steps ?? []) {
    const row = await deps.journal.get(step.journalIdempotencyKey);
    if (row !== null && row.state !== "ROLLED_BACK") live.push(step);
  }
  const shape = selectRotatePlanShape(live, deps.atomicRotate === true);
  if (sequence !== null && (sequence.kind !== "rotate" || shape === "unsupported")) {
    return { sequenceId: sequence.sequenceId, kind: sequence.kind, status: "held",
      code: sequence.kind !== "rotate" ? "SEQUENCE_CONFLICT" : "PLAN_MISMATCH",
      reason: "The recorded sequence does not match a supported rotate plan; no submission was made.", confirmedSteps: 0 };
  }
  if (shape === "legacy") return legacyRotatePlan(deps, positionId);
  if (!Number.isInteger(deps.tickSpacing) || deps.tickSpacing <= 0 || !Number.isInteger(deps.maxTickWidth) || deps.maxTickWidth < 2 * deps.tickSpacing) {
    throw new Error("Atomic rotate requires valid tick spacing and maximum width.");
  }
  const position = await requirePosition(deps, positionId, "entry");
  return driveSequence({ deps, kind: "rotate", position, plan: [makeAtomicRotateStep(deps, position)] });
}

function makeAtomicRotateStep(deps: LpRotateDeps, position: LpPositionRecord): PlannedStep {
  const legs = poolLegs(position, deps.venue.wbnb);
  const state: FreedState & {
    priorRange?: { tickLower: number; tickUpper: number };
    chosenRange?: { tickLower: number; tickUpper: number };
    /** Set by the sweep build when IT decided the swapless shape, this drive. */
    swaplessParked?: SwaplessPlacement;
    /** Set by the sweep's `after` on the REPLAY path: a skip we did not decide. */
    sweepSkipOnReplay?: boolean;
  } = { freedWbnbWei: 0n, freedTokenWei: 0n };

  const readPriorRange = async (): Promise<{
    tickLower: number;
    tickUpper: number;
  }> => {
    if (state.priorRange !== undefined) return state.priorRange;
    const snapshot = await deps.positions(requireTokenId(position));
    if (snapshot === "burned") {
      throw new Error(
        "The prior position is burned and its range is unknowable; the rotate cannot derive a width.",
      );
    }
    state.priorRange = {
      tickLower: snapshot.tickLower,
      tickUpper: snapshot.tickUpper,
    };
    return state.priorRange;
  };

  /**
   * The rotate's range choice: brain proposes (when injected), the fence
   * disposes, the deterministic re-center is the fallback for every failure
   * INCLUDING the brain being unreachable. An accepted `holdInstead` throws —
   * a clean between-step refusal, which mid-rotate parks at the stated
   * `pending-mint` recovery state.
   */
  const chooseRange = async (
    market: LpSagaMarket,
  ): Promise<{ tickLower: number; tickUpper: number }> => {
    if (state.chosenRange !== undefined) return state.chosenRange;
    const prior = await readPriorRange();
    const priorWidthTicks = Math.max(1, prior.tickUpper - prior.tickLower);
    const fence: RangeFenceContext = {
      kind: "range",
      currentTick: market.currentTick,
      tickSpacing: deps.tickSpacing,
      maxTickWidth: deps.maxTickWidth,
      priorWidthTicks,
    };
    const fallback = (): { tickLower: number; tickUpper: number } =>
      centeredRotationRange({
        currentTick: market.currentTick,
        priorWidthTicks,
        tickSpacing: deps.tickSpacing,
      });

    if (deps.proposeRange === undefined) {
      state.chosenRange = fallback();
      return state.chosenRange;
    }
    let proposal: unknown;
    try {
      proposal = await deps.proposeRange({
        currentTick: market.currentTick,
        tickSpacing: deps.tickSpacing,
        maxTickWidth: deps.maxTickWidth,
        priorWidthTicks,
      });
    } catch {
      // The brain being down never blocks a triggered rotate.
      state.chosenRange = fallback();
      return state.chosenRange;
    }
    const verdict = validateBrainProposal(proposal, fence);
    if (verdict.outcome === "accepted" && verdict.kind === "hold") {
      throw new Error(
        "The brain proposed hold-instead; the rotate parks for this cycle.",
      );
    }
    if (verdict.outcome === "accepted" && verdict.kind === "range") {
      state.chosenRange = {
        tickLower: verdict.tickLower,
        tickUpper: verdict.tickUpper,
      };
      return state.chosenRange;
    }
    if (verdict.outcome === "fell-back" && verdict.fallback.kind === "range") {
      state.chosenRange = {
        tickLower: verdict.fallback.tickLower,
        tickUpper: verdict.fallback.tickUpper,
      };
      return state.chosenRange;
    }
    state.chosenRange = fallback();
    return state.chosenRange;
  };

  /**
   * PHASE3.13. Does the swapless shape apply RIGHT NOW, on fresh evidence?
   *
   * The ONE derivation, called at BOTH seams — the sweep's skip decision and
   * the mint's bind — so the shape cannot be decided by one rule and verified
   * by another (review F2/F8). It reads only `legs`, `state`, the prior range
   * and the rail-checked spot: NO target range, which is why the sweep can call
   * it BEFORE `targetRange` and `planLpSweep`.
   *
   * Three conjuncts, all required, in this order:
   *   1. the owner signed `rotateMode: "swapless"`;
   *   2. a SIDE EXISTS — the fresh tick is outside the PRIOR range. F4: a
   *      position resting one tick inside its own `tickUpper` frees a near
   *      single-sided principal, so the residue bound alone would let a
   *      "no side" rotate mint one-sided into a centered range;
   *   3. the off-side leg is within the ONE residue bound (F2), measured by the
   *      ONE exported predicate at the ONE threshold.
   *
   * `adjacentRotationRange` may THROW (no legal spacing-aligned anchor at the
   * global bounds) — deliberately not caught: at the sweep build that is a
   * clean refusal before this step submits anything, with the principal in the
   * wallet, and silently falling back to a swapped shape would be a mode the
   * owner did not sign.
   */
  const decideSwapless = async (
    market: LpSagaMarket,
  ): Promise<SwaplessPlacement | null> => {
    if (deps.rotateMode !== "swapless") return null;
    const prior = await readPriorRange();
    const side = swaplessRotationSide({
      currentTick: market.currentTick,
      priorTickLower: prior.tickLower,
      priorTickUpper: prior.tickUpper,
    });
    const amounts = poolOrderedAmounts(legs, state);
    if (side === undefined) return null;
    const verdict = swaplessResidueWithinBound({
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      side,
      spotSqrtPriceX96: market.spotSqrtPriceX96,
    });
    if (!verdict.within) return null;
    return {
      side,
      prior,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      residueWei: verdict.residueWei,
      residueBps: verdict.residueBps,
      range: adjacentRotationRange({
        currentTick: market.currentTick,
        priorWidthTicks: Math.max(1, prior.tickUpper - prior.tickLower),
        tickSpacing: deps.tickSpacing,
        maxTickWidth: deps.maxTickWidth,
        side,
      }),
    };
  };


  return {
    kind: "rotate-atomic",
    reducesExposure: false,
    recoveryAfterConfirm: "rotate-ambiguous",
    markRecoveryBeforeSubmit: true,
    build: async (ctx) => {
      if (deps.receipts.atomicRotateReceipt === undefined || deps.expectedPool === undefined) {
        throw new Error("Atomic rotate requires the combined receipt reader and expected pool.");
      }
      const tokenId = requireTokenId(position);
      const snapshot = await deps.positions(tokenId);
      if (snapshot === "burned" || snapshot.liquidity <= 0n) throw new Error("Position holds no liquidity to rotate.");
      state.priorRange = { tickLower: snapshot.tickLower, tickUpper: snapshot.tickUpper };
      const funding = sagaDecreaseFloors({ sqrtPriceX96: ctx.market.spotSqrtPriceX96,
        tickLower: snapshot.tickLower, tickUpper: snapshot.tickUpper, liquidity: snapshot.liquidity,
        maxSagaSlippageBps: deps.rails.maxSagaSlippageBps });
      state.freedWbnbWei = legs.wbnbIsToken0 ? funding.amount0Min : funding.amount1Min;
      state.freedTokenWei = legs.wbnbIsToken0 ? funding.amount1Min : funding.amount0Min;
      // R2.4: this decision sees floor-funded principal. Off-side collected fees stay in the wallet.
      const placement = await decideSwapless(ctx.market);
      const range = placement?.range ?? await chooseRange(ctx.market);
      let amount0 = funding.amount0Min, amount1 = funding.amount1Min;
      let mintPrice = ctx.market.spotSqrtPriceX96;
      const calls: WalletCall[] = [...buildLpZapOutKeepWbnbBatch({ nfpm: deps.venue.nfpm, tokenId,
        liquidity: snapshot.liquidity, amount0MinWei: funding.amount0Min, amount1MinWei: funding.amount1Min,
        deadline: ctx.deadline, wallet: deps.agent.walletAddress })];
      if (placement === null) {
        const sweep = planLpSweep({ wbnbFreedWei: state.freedWbnbWei, tokenFreedWei: state.freedTokenWei,
          wbnbIsToken0: legs.wbnbIsToken0, currentTick: ctx.market.currentTick,
          tickLower: range.tickLower, tickUpper: range.tickUpper, spotSqrtPriceX96: ctx.market.spotSqrtPriceX96 });
        if (sweep !== null) {
          if (deps.quoteWithPriceAfter === undefined) throw new Error("Atomic rotate requires a post-swap price quote.");
          const tokenIn = sweep.direction === "wbnb-to-token" ? deps.venue.wbnb : legs.token;
          const tokenOut = sweep.direction === "wbnb-to-token" ? legs.token : deps.venue.wbnb;
          const tokenInIsToken0 = tokenIn.toLowerCase() === position.token0.toLowerCase();
          const quoted = await deps.quoteWithPriceAfter({ tokenIn, tokenOut, fee: position.fee, amountInWei: sweep.amountInWei });
          const expected = spotSwapOutput({ amountInAfterFee: amountInAfterPoolFee(sweep.amountInWei, position.fee),
            sqrtPriceX96: ctx.market.spotSqrtPriceX96, tokenInIsToken0 });
          if (quotePriceImpactBps(expected, quoted.amountOutWei) > BigInt(deps.rails.maxPriceImpactBps)) {
            throw new Error("Quoted price impact of the atomic rotate exceeds the manipulation-rail ceiling.");
          }
          const minOutWei = sagaSwapMinOut(quoted.amountOutWei, deps.rails.maxSagaSlippageBps);
          if (tokenInIsToken0) { amount0 -= sweep.amountInWei; amount1 += minOutWei; }
          else { amount1 -= sweep.amountInWei; amount0 += minOutWei; }
          mintPrice = quoted.sqrtPriceX96After;
          calls.push(...buildLpSweepSwap({ router: deps.venue.routerV3, tokenIn, tokenOut, fee: position.fee,
            amountInWei: sweep.amountInWei, minOutWei, recipient: deps.agent.walletAddress, deadline: ctx.deadline }));
        }
        // The manipulation reference above remains pre-swap; only mint placement/floors use this price.
        if (amount0 <= 0n || amount1 <= 0n || mintPrice <= getSqrtRatioAtTick(range.tickLower) || mintPrice >= getSqrtRatioAtTick(range.tickUpper)) {
          throw new Error("The quoted post-swap price does not support the proposed two-sided mint.");
        }
      } else {
        amount0 = placement.side === "above" ? amount0 : 0n;
        amount1 = placement.side === "below" ? amount1 : 0n;
      }
      const liquidity = getLiquidityForAmounts(mintPrice, range.tickLower, range.tickUpper, amount0, amount1);
      const floorInput = { sqrtPriceX96: mintPrice, tickLower: range.tickLower, tickUpper: range.tickUpper,
        liquidity, maxSagaSlippageBps: deps.rails.maxSagaSlippageBps };
      const floors = placement === null
        ? sagaMintFloors({ ...floorInput, amount0Desired: amount0, amount1Desired: amount1 })
        : sagaSingleSidedMintFloors({ ...floorInput, side: placement.side });
      calls.push(buildApprove(legs.token, deps.venue.nfpm, 0n), buildApprove(deps.venue.wbnb, deps.venue.nfpm, 0n),
        ...buildLpMintWbnbBatch({ nfpm: deps.venue.nfpm, token0: position.token0, token1: position.token1,
          wbnb: deps.venue.wbnb, fee: position.fee, tickLower: range.tickLower, tickUpper: range.tickUpper,
          amount0DesiredWei: amount0, amount1DesiredWei: amount1, amount0MinWei: floors.amount0Min, amount1MinWei: floors.amount1Min,
          recipient: deps.agent.walletAddress, deadline: ctx.deadline }));
      return { action: "submit", calls };
    },
    after: async (txHash, _replay, ctx) => {
      try {
        if (txHash === undefined || deps.receipts.atomicRotateReceipt === undefined || deps.expectedPool === undefined) {
          throw new Error("Atomic rotate confirmation requires its combined receipt.");
        }
        const sequence = await deps.store.getSequence(deps.agent.ownerAddress, deps.agent.id, ctx.sequenceId);
        if (sequence?.priorTokenId == null) throw new Error("Atomic rotate has no durable prior NFT identity.");
        const oldTokenId = BigInt(sequence.priorTokenId);
        const receipt = await deps.receipts.atomicRotateReceipt(txHash, { oldTokenId, pool: deps.expectedPool,
          nfpm: deps.venue.nfpm, wallet: deps.agent.walletAddress });
        const old = await deps.positions(oldTokenId), minted = await deps.positions(receipt.minted.tokenId);
        if (old === "burned" || old.liquidity !== 0n || minted === "burned" || minted.liquidity <= 0n || receipt.minted.tokenId === oldTokenId) {
          throw new Error("Atomic rotate post-verification failed for the old or replacement NFT.");
        }
        const current = await deps.store.getPosition(deps.agent.ownerAddress, deps.agent.id, position.positionId);
        const newId = receipt.minted.tokenId.toString(10);
        if (current === null || (current.tokenId !== sequence.priorTokenId && current.tokenId !== newId)) {
          throw new Error("Atomic rotate position identity differs from its durable receipt lineage.");
        }
        if (current.tokenId !== newId) await deps.store.updatePositionTokenId(deps.agent.ownerAddress, deps.agent.id, position.positionId, newId);
        const residue0 = receipt.collected.amount0 - (receipt.swap?.amount0Delta ?? 0n) - receipt.minted.amount0;
        const residue1 = receipt.collected.amount1 - (receipt.swap?.amount1Delta ?? 0n) - receipt.minted.amount1;
        await deps.store.setSequenceNote(deps.agent.ownerAddress, deps.agent.id, ctx.sequenceId,
          "Atomic rotate completed. Wallet residue (pool order): " + residue0 + " / " + residue1 + " wei, including collected fees; fees were not reinvested. Swapless residue checks cover floor-funded principal only.");
      } finally {
        await recordLpFeeEvents({ deps, ctx, txHash, position });
      }
    },
  };
}

async function legacyRotatePlan(
  deps: LpRotateDeps,
  positionId: string,
): Promise<LpSagaRunResult> {
  if (!Number.isInteger(deps.tickSpacing) || deps.tickSpacing <= 0) {
    throw new Error("runLpRotate: tickSpacing must be a positive integer.");
  }
  if (
    !Number.isInteger(deps.maxTickWidth) ||
    deps.maxTickWidth < 2 * deps.tickSpacing
  ) {
    throw new Error("runLpRotate: maxTickWidth must be >= 2 * tickSpacing.");
  }
  const position = await requirePosition(deps, positionId, "entry");
  const legs = poolLegs(position, deps.venue.wbnb);
  const state: FreedState & {
    priorRange?: { tickLower: number; tickUpper: number };
    chosenRange?: { tickLower: number; tickUpper: number };
    /** Set by the sweep build when IT decided the swapless shape, this drive. */
    swaplessParked?: SwaplessPlacement;
    /** Set by the sweep's `after` on the REPLAY path: a skip we did not decide. */
    sweepSkipOnReplay?: boolean;
  } = { freedWbnbWei: 0n, freedTokenWei: 0n };

  const readPriorRange = async (): Promise<{
    tickLower: number;
    tickUpper: number;
  }> => {
    if (state.priorRange !== undefined) return state.priorRange;
    const snapshot = await deps.positions(requireTokenId(position));
    if (snapshot === "burned") {
      throw new Error(
        "The prior position is burned and its range is unknowable; the rotate cannot derive a width.",
      );
    }
    state.priorRange = {
      tickLower: snapshot.tickLower,
      tickUpper: snapshot.tickUpper,
    };
    return state.priorRange;
  };

  /**
   * The rotate's range choice: brain proposes (when injected), the fence
   * disposes, the deterministic re-center is the fallback for every failure
   * INCLUDING the brain being unreachable. An accepted `holdInstead` throws —
   * a clean between-step refusal, which mid-rotate parks at the stated
   * `pending-mint` recovery state.
   */
  const chooseRange = async (
    market: LpSagaMarket,
  ): Promise<{ tickLower: number; tickUpper: number }> => {
    if (state.chosenRange !== undefined) return state.chosenRange;
    const prior = await readPriorRange();
    const priorWidthTicks = Math.max(1, prior.tickUpper - prior.tickLower);
    const fence: RangeFenceContext = {
      kind: "range",
      currentTick: market.currentTick,
      tickSpacing: deps.tickSpacing,
      maxTickWidth: deps.maxTickWidth,
      priorWidthTicks,
    };
    const fallback = (): { tickLower: number; tickUpper: number } =>
      centeredRotationRange({
        currentTick: market.currentTick,
        priorWidthTicks,
        tickSpacing: deps.tickSpacing,
      });

    if (deps.proposeRange === undefined) {
      state.chosenRange = fallback();
      return state.chosenRange;
    }
    let proposal: unknown;
    try {
      proposal = await deps.proposeRange({
        currentTick: market.currentTick,
        tickSpacing: deps.tickSpacing,
        maxTickWidth: deps.maxTickWidth,
        priorWidthTicks,
      });
    } catch {
      // The brain being down never blocks a triggered rotate.
      state.chosenRange = fallback();
      return state.chosenRange;
    }
    const verdict = validateBrainProposal(proposal, fence);
    if (verdict.outcome === "accepted" && verdict.kind === "hold") {
      throw new Error(
        "The brain proposed hold-instead; the rotate parks for this cycle.",
      );
    }
    if (verdict.outcome === "accepted" && verdict.kind === "range") {
      state.chosenRange = {
        tickLower: verdict.tickLower,
        tickUpper: verdict.tickUpper,
      };
      return state.chosenRange;
    }
    if (verdict.outcome === "fell-back" && verdict.fallback.kind === "range") {
      state.chosenRange = {
        tickLower: verdict.fallback.tickLower,
        tickUpper: verdict.fallback.tickUpper,
      };
      return state.chosenRange;
    }
    state.chosenRange = fallback();
    return state.chosenRange;
  };

  /**
   * PHASE3.13. Does the swapless shape apply RIGHT NOW, on fresh evidence?
   *
   * The ONE derivation, called at BOTH seams — the sweep's skip decision and
   * the mint's bind — so the shape cannot be decided by one rule and verified
   * by another (review F2/F8). It reads only `legs`, `state`, the prior range
   * and the rail-checked spot: NO target range, which is why the sweep can call
   * it BEFORE `targetRange` and `planLpSweep`.
   *
   * Three conjuncts, all required, in this order:
   *   1. the owner signed `rotateMode: "swapless"`;
   *   2. a SIDE EXISTS — the fresh tick is outside the PRIOR range. F4: a
   *      position resting one tick inside its own `tickUpper` frees a near
   *      single-sided principal, so the residue bound alone would let a
   *      "no side" rotate mint one-sided into a centered range;
   *   3. the off-side leg is within the ONE residue bound (F2), measured by the
   *      ONE exported predicate at the ONE threshold.
   *
   * `adjacentRotationRange` may THROW (no legal spacing-aligned anchor at the
   * global bounds) — deliberately not caught: at the sweep build that is a
   * clean refusal before this step submits anything, with the principal in the
   * wallet, and silently falling back to a swapped shape would be a mode the
   * owner did not sign.
   */
  const decideSwapless = async (
    market: LpSagaMarket,
  ): Promise<SwaplessPlacement | null> => {
    if (deps.rotateMode !== "swapless") return null;
    const prior = await readPriorRange();
    const side = swaplessRotationSide({
      currentTick: market.currentTick,
      priorTickLower: prior.tickLower,
      priorTickUpper: prior.tickUpper,
    });
    const amounts = poolOrderedAmounts(legs, state);
    if (side === undefined) return null;
    const verdict = swaplessResidueWithinBound({
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      side,
      spotSqrtPriceX96: market.spotSqrtPriceX96,
    });
    if (!verdict.within) return null;
    return {
      side,
      prior,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      residueWei: verdict.residueWei,
      residueBps: verdict.residueBps,
      range: adjacentRotationRange({
        currentTick: market.currentTick,
        priorWidthTicks: Math.max(1, prior.tickUpper - prior.tickLower),
        tickSpacing: deps.tickSpacing,
        maxTickWidth: deps.maxTickWidth,
        side,
      }),
    };
  };

  /** The figures the mint's refusal reports when the bind does NOT hold. */
  const refusalFigures = async (
    market: LpSagaMarket,
  ): Promise<{
    side: SwaplessRotationSide | undefined;
    prior: { tickLower: number; tickUpper: number };
    amount0: bigint;
    amount1: bigint;
    residueWei: bigint;
    residueBps: bigint;
  }> => {
    const prior = await readPriorRange();
    const amounts = poolOrderedAmounts(legs, state);
    const side = swaplessRotationSide({
      currentTick: market.currentTick,
      priorTickLower: prior.tickLower,
      priorTickUpper: prior.tickUpper,
    });
    const verdict = side === undefined
      ? { residueWei: 0n, residueBps: 0n }
      : swaplessResidueWithinBound({
          amount0: amounts.amount0,
          amount1: amounts.amount1,
          side,
          spotSqrtPriceX96: market.spotSqrtPriceX96,
        });
    return {
      side,
      prior,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      residueWei: verdict.residueWei,
      residueBps: verdict.residueBps,
    };
  };

  const plan: readonly PlannedStep[] = [
    {
      kind: "zap-out",
      reducesExposure: true,
      recoveryAfterConfirm: "pending-mint",
      build: async (ctx) => {
        const tokenId = requireTokenId(position);
        const snapshot = await deps.positions(tokenId);
        if (snapshot === "burned") {
          throw new Error("Position token is burned; there is nothing to rotate.");
        }
        if (snapshot.liquidity <= 0n) {
          throw new Error(
            "Position holds no liquidity; a rotate has nothing to move.",
          );
        }
        state.priorRange = {
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
        };
        const floors = sagaDecreaseFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
          liquidity: snapshot.liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
        });
        return {
          action: "submit",
          calls: buildLpZapOutKeepWbnbBatch({
            nfpm: deps.venue.nfpm,
            tokenId,
            liquidity: snapshot.liquidity,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            deadline: ctx.deadline,
            wallet: deps.agent.walletAddress,
          }),
        };
      },
      after: async (txHash, _feeReplay, feeCtx) => {
        try {
        if (txHash === undefined) {
          throw new Error("A rotate zap-out cannot be skipped.");
        }
        // The sweep's amountIn derives from THIS confirmed delta, passed
        // forward — never a balance re-read (Rev2 item 32 / spec body).
        const collected = await deps.receipts.collectAmounts(txHash);
        state.freedWbnbWei = legs.wbnbIsToken0
          ? collected.amount0Wei
          : collected.amount1Wei;
        state.freedTokenWei = legs.wbnbIsToken0
          ? collected.amount1Wei
          : collected.amount0Wei;
        const snapshot = await deps.positions(requireTokenId(position));
        if (snapshot !== "burned") {
          if (snapshot.liquidity !== 0n) {
            throw new Error(
              "Post-step verification failed: the zap-out confirmed but the position still reports liquidity.",
            );
          }
          state.priorRange ??= {
            tickLower: snapshot.tickLower,
            tickUpper: snapshot.tickUpper,
          };
        }
        } finally {
          await recordLpFeeEvents({ deps, ctx: feeCtx, txHash, position });
        }
      },
    },
    makeSweepStep({
      deps,
      position,
      legs,
      state,
      targetRange: chooseRange,
      recoveryAfterConfirm: "wbnb-stranded",
      swaplessSkip: async (market) => {
        const placement = await decideSwapless(market);
        if (placement === null) return null;
        state.swaplessParked = placement;
        return lpSwaplessRotateReason({
          outcome: "parked",
          currentTick: market.currentTick,
          priorTickLower: placement.prior.tickLower,
          priorTickUpper: placement.prior.tickUpper,
          side: placement.side,
          amount0: placement.amount0,
          amount1: placement.amount1,
          residueWei: placement.residueWei,
          residueBps: placement.residueBps,
          range: placement.range,
        });
      },
      onSweepSkipped: (replay) => {
        // A replayed skip is the ONE case the mint cannot reconstruct: `state`
        // is per-process, so a swapless skip decided by an earlier drive leaves
        // nothing behind here. Recording that it happened is what lets the mint
        // re-derive the shape from fresh evidence and REFUSE on a disagreement,
        // rather than quietly minting centered on an unbalanced principal.
        if (replay) state.sweepSkipOnReplay = true;
      },
    }),
    {
      kind: "zap-in-mint",
      reducesExposure: false,
      recoveryAfterConfirm: "none",
      build: async (ctx) => {
        const parked = state.swaplessParked;
        // PHASE3.13. The swapless branch is taken on OBSERVED HISTORY, not on
        // the mode alone: the sweep must actually have been SKIPPED. Under
        // `rotateMode: "swapless"` the sweep can still RUN (no side, or a
        // residue above the bound), and that rotate is swapped-shaped and must
        // take the centered path below exactly as today.
        //
        // F10, stated where the next reader will need it: a mode flip BETWEEN
        // cycles is NOT refused. `SETTINGS_DIGEST_MISMATCH` is a WITHIN-drive
        // check — the worker passes the current cycle's digest as
        // `settingsDigest` and re-reads the live one between steps — so a flip
        // that lands between cycles arrives as a resumed sequence armed under
        // the new mode. The invariant three-step plan is what makes that
        // harmless for `PLAN_MISMATCH`; this branch plus the bind below is what
        // makes it harmless for the MONEY.
        if (
          deps.rotateMode === "swapless"
          && (parked !== undefined || state.sweepSkipOnReplay === true)
        ) {
          // F8: an INDEPENDENT verification against fresh evidence, never a
          // re-read of the sweep's cache. The range is re-derived at the
          // CURRENT tick, so a parked range from two cycles ago cannot be
          // minted into a price that has moved.
          const fresh = await decideSwapless(ctx.market);
          if (fresh === null || (parked !== undefined && fresh.side !== parked.side)) {
            const figures = await refusalFigures(ctx.market);
            throw new Error(
              lpSwaplessRotateReason({
                outcome: "refused",
                currentTick: ctx.market.currentTick,
                priorTickLower: figures.prior.tickLower,
                priorTickUpper: figures.prior.tickUpper,
                side: figures.side,
                amount0: figures.amount0,
                amount1: figures.amount1,
                residueWei: figures.residueWei,
                residueBps: figures.residueBps,
                ...(parked === undefined ? {} : { recordedSide: parked.side }),
              }),
            );
          }
          const single = fresh.range;
          // F5 — the PLACEMENT assertion that REPLACES the leg-positivity check
          // at this seam, not a preservation of it. `sagas.ts`'s
          // both-legs-positive throw reads neither the range nor the tick, so
          // under swapless it protects nothing (the zap-out's `collect` returns
          // fees on BOTH legs, so both amounts are always positive) and fires
          // wrongly the moment the off-side leg is passed as the required `0n`.
          // `swapSplitIsTotal` is Phase 3.12's own predicate, reused rather
          // than hand-written a third time.
          if (
            !swapSplitIsTotal(ctx.market.currentTick, single.tickLower, single.tickUpper)
          ) {
            throw new Error(
              `The swapless re-mint range [${single.tickLower}, ${single.tickUpper}) contains tick ${ctx.market.currentTick}; a single-sided mint there would be sized by the dust leg.`,
            );
          }
          if (
            fresh.side === "above"
              ? single.tickLower <= ctx.market.currentTick
              : single.tickUpper > ctx.market.currentTick
          ) {
            throw new Error(
              `The swapless re-mint range [${single.tickLower}, ${single.tickUpper}) is not on the derived "${fresh.side}" side of tick ${ctx.market.currentTick}.`,
            );
          }
          const amounts = poolOrderedAmounts(legs, state);
          const present = fresh.side === "above" ? amounts.amount0 : amounts.amount1;
          if (present <= 0n) {
            throw new Error(
              `The swapless re-mint has nothing on its "${fresh.side}" side; refusing a mint with no principal.`,
            );
          }
          // The off-side leg is DROPPED — `desired` and `min` both `0n`, the
          // only shape `validateDepositLeg` permits for an absent leg. It stays
          // in the wallet as the owner's, bounded by SWAPLESS_MAX_RESIDUE_BPS
          // and disclosed in the sweep's skip note. The lineage `basisWei` is
          // NOT deducted (review OQ2): there is no idempotent seam for such a
          // write, `basisWei: 0n` imported positions have no defined answer,
          // and a basis that chases the loss down is a stop-loss that never
          // fires.
          const amount0 = fresh.side === "above" ? present : 0n;
          const amount1 = fresh.side === "above" ? 0n : present;
          const liquidity = getLiquidityForAmounts(
            ctx.market.spotSqrtPriceX96,
            single.tickLower,
            single.tickUpper,
            amount0,
            amount1,
          );
          const singleFloors = sagaSingleSidedMintFloors({
            sqrtPriceX96: ctx.market.spotSqrtPriceX96,
            tickLower: single.tickLower,
            tickUpper: single.tickUpper,
            liquidity,
            maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
            side: fresh.side,
          });
          return {
            action: "submit",
            calls: buildLpMintWbnbBatch({
              nfpm: deps.venue.nfpm,
              token0: position.token0,
              token1: position.token1,
              wbnb: deps.venue.wbnb,
              fee: position.fee,
              tickLower: single.tickLower,
              tickUpper: single.tickUpper,
              amount0DesiredWei: amount0,
              amount1DesiredWei: amount1,
              amount0MinWei: singleFloors.amount0Min,
              amount1MinWei: singleFloors.amount1Min,
              recipient: deps.agent.walletAddress,
              deadline: ctx.deadline,
            }),
          };
        }
        const range = await chooseRange(ctx.market);
        const amounts = poolOrderedAmounts(legs, state);
        if (amounts.amount0 <= 0n || amounts.amount1 <= 0n) {
          throw new Error(
            "The re-mint needs both legs positive after the sweep; refusing a single-sided mint into a centered range.",
          );
        }
        const liquidity = getLiquidityForAmounts(
          ctx.market.spotSqrtPriceX96,
          range.tickLower,
          range.tickUpper,
          amounts.amount0,
          amounts.amount1,
        );
        const floors = sagaMintFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: range.tickLower,
          tickUpper: range.tickUpper,
          liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
          amount0Desired: amounts.amount0,
          amount1Desired: amounts.amount1,
        });
        return {
          action: "submit",
          calls: buildLpMintWbnbBatch({
            nfpm: deps.venue.nfpm,
            token0: position.token0,
            token1: position.token1,
            wbnb: deps.venue.wbnb,
            fee: position.fee,
            tickLower: range.tickLower,
            tickUpper: range.tickUpper,
            amount0DesiredWei: amounts.amount0,
            amount1DesiredWei: amounts.amount1,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            recipient: deps.agent.walletAddress,
            deadline: ctx.deadline,
          }),
        };
      },
      after: async (txHash) => {
        if (txHash === undefined) {
          throw new Error("A rotate mint cannot be skipped.");
        }
        // The new tokenId comes from the CONFIRMED mint receipt (spec body).
        const mintedTokenId = await deps.receipts.mintedTokenId(txHash);
        const snapshot = await deps.positions(mintedTokenId);
        if (snapshot === "burned" || snapshot.liquidity <= 0n) {
          throw new Error(
            "Post-step verification failed: the mint confirmed but the new position reports no liquidity.",
          );
        }
        // SAME lineage, basis untouched — updatePositionTokenId touches only
        // the tokenId by construction (R7).
        await deps.store.updatePositionTokenId(
          deps.agent.ownerAddress,
          deps.agent.id,
          position.positionId,
          mintedTokenId.toString(10),
        );
      },
    },
  ];

  return driveSequence({ deps, kind: "rotate", position, plan });
}

/* -------------------------------------------------------------------------- */
/* Grid flip (PHASE3.15)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The grid ping-pong's deps: the rotate's shape MINUS the brain and the fence,
 * PLUS the range the owner already signed.
 *
 * There is no `tickSpacing`, no `maxTickWidth` and no `proposeRange`, and their
 * absence is structural rather than tidy: a flip does NO tick arithmetic at all
 * beyond the G-gates. Its destination is DATA the owner signed, validated at
 * the settings route against the pool's own spacing, and re-compared against
 * the settings digest before every step — so the range minted is provably the
 * range signed. A fence computation here would be a second authority on a
 * question that already has one.
 */
export type LpGridFlipDeps = LpSagaDeps & {
  /** The SIGNED opposite range this flip mints into. Never derived. */
  readonly targetRange: { readonly tickLower: number; readonly tickUpper: number };
  /** Which signed level the target IS — owner-facing labelling only. */
  readonly targetRole: "buy" | "sell";
  /**
   * DERIVED TELEMETRY (R2.11). Optional: a flip with no ledger wired still
   * flips, and a write failure here is swallowed. Never consulted to decide
   * whether a step ran.
   */
  readonly gridCycles?: LpGridCycleStore;
};

/**
 * ONE grid flip: `[zap-out-keep-wbnb, sweep-token (ALWAYS SKIPPED), mint]`.
 *
 * ─── THE PLAN SHAPE IS INVARIANT, AND THE SWEEP IS A NO-OP ON PURPOSE ──────
 *
 * The middle position exists for SHAPE PARITY with the swapless rotate and
 * always skips, because **a grid in `fixed` or `policy` mode never swaps to
 * rebalance** (PHASE3.19 L1 — the sentence is SCOPED, not revised: ladder mode
 * swaps only to HEDGE filled inventory, sized to the imbalance and only at
 * protected profit, and it does so in its OWN saga which this one never
 * reaches): inventory changes
 * sides only by the pool trading through a range. Keeping the position rather
 * than shortening the plan is PHASE3.1 item 10's rule — a plan whose LENGTH
 * varied would make a resumed sequence hit `PLAN_MISMATCH` → `held` with
 * recovery `none`, which reads as TERMINAL and releases a position mid-flight.
 *
 * The skip supplies a real `swaplessSkip` callback, which is what makes
 * `makeSweepStep` set `noteOnSkip` and `recordSkip` persist the reason (L2).
 * Without it the residue disclosure would be accepted and then discarded, and
 * `lpSequenceView` would show a clean COMPLETED flip with no note — 3.13 F3
 * verbatim.
 *
 * ─── PAUSE, WITH NO NEW CODE (R2.5 / OQ4) ─────────────────────────────────
 *
 * `driveSequence`'s existing `reduces` classification already gives §4's exact
 * semantics for `kind: "grid-flip"`: before step 0, `confirmedMoney === 0` ⇒
 * strict ⇒ a paused agent starts NO flip and rolls back cleanly; step 0 is
 * `reducesExposure: true`, so a settle already in flight FINISHES under pause;
 * steps 1–2 are exposure-increasing and refuse into a clean recoverable hold at
 * `pending-mint`. `grid-flip` is deliberately NOT added to the
 * `protect || manual-exit` always-reduces arm.
 *
 * That is live IFF the steps declare REAL recovery markers — `holdSequence`
 * only parks a sequence when `currentRecovery !== "none"`, and PHASE3.11 F2 is
 * exactly a step that declared `none` and thereby made the hold guard dead
 * code. Hence the table below, and hence no new `LpRecoveryState` member (which
 * would need a SECOND constraint migration on top of the kind CHECK).
 *
 * | step          | recoveryAfterConfirm | why                                  |
 * | ------------- | -------------------- | ------------------------------------ |
 * | `zap-out`     | `pending-mint`       | principal out of the NFT, no mint yet |
 * | `sweep-token` | `wbnb-stranded`      | matches rotate; harmless when skipped |
 * | `zap-in-mint` | `none`               | the sequence completes                |
 *
 * ─── RECOVERY, HONESTLY (R2.4) ────────────────────────────────────────────
 *
 * `grid-flip` is NOT in `RESOLVABLE_SEQUENCE_KINDS`. An UNKNOWN mid-flip step
 * has the principal out of the position and retrying would risk a second mint —
 * the sentence `resolveUnknown` already refuses `rotate` with, applying
 * verbatim. The operator path is: wait for the stall latch to quiesce the row,
 * then owner-signed abandon (which CLOSES the position and leaves the inventory
 * in the owner's own EOA), then re-mint a level by hand and re-import. No
 * currency conversion is required, which is what makes that restart path
 * acceptable at all.
 *
 * PHASE3.18 R2.5 — THAT LAST SENTENCE HOLDS FOR `grid.mode: "fixed"` ONLY.
 * `/lp/import` admits by EXACT-TICK match against the signed rungs, and a
 * requoted level's ticks match no signed rung by design, so in POLICY MODE the
 * re-import door is CLOSED and v1 declares policy mode non-restartable by
 * import. The policy-mode restart is: abandon (which closes the row, and its
 * sibling through `arm_group_id`), re-sign coherent rungs at the current tick
 * if the ladder has drifted, then sign `gridArm` again — which re-enters at the
 * SIGNED rungs (C3).
 */
export async function runLpGridFlip(
  deps: LpGridFlipDeps,
  positionId: string,
): Promise<LpSagaRunResult> {
  const target = deps.targetRange;
  if (
    !Number.isInteger(target.tickLower)
    || !Number.isInteger(target.tickUpper)
    || target.tickUpper <= target.tickLower
  ) {
    throw new Error("runLpGridFlip: the signed target range is inverted or empty.");
  }
  const position = await requirePosition(deps, positionId, "entry");
  const legs = poolLegs(position, deps.venue.wbnb);
  const state: FreedState & {
    priorRange?: { tickLower: number; tickUpper: number };
    /**
     * What the mint's BUILD decided, for the derived cycle row. Set only when
     * the build actually ran in THIS process — a pure resume replay leaves it
     * absent and the ledger simply records nothing, which is the accepted
     * OQ7 gap rather than a fabricated row.
     */
    mintPlan?: {
      readonly amount0: bigint;
      readonly amount1: bigint;
      readonly residueWei: bigint;
      readonly residueBps: bigint;
    };
    /** Set by the mint's `after` once the new tokenId is on the row. */
    cycle?: {
      readonly fromTokenId: string;
      readonly toTokenId: string;
    };
  } = { freedWbnbWei: 0n, freedTokenWei: 0n };

  /**
   * THE ONE derivation both G2 conjuncts 1 and 2 read, and the one the sweep's
   * skip note discloses from — so the sentence an owner reads and the bind that
   * refuses cannot be computed by two different rules (the 3.13 cannot-diverge
   * rule, applied to a second saga).
   *
   * `side` is `swaplessRotationSide` against the TARGET range, which at
   * `t === tickLower` REFUSES where the rotate's `swapSplitIsTotal` bind
   * admits. That is the intended direction (OQ2) and strictly safer; it must
   * not be reconciled toward the rotate later.
   */
  const figuresAt = (
    market: LpSagaMarket,
  ): {
    side: SwaplessRotationSide | undefined;
    amount0: bigint;
    amount1: bigint;
    within: boolean;
    residueWei: bigint;
    residueBps: bigint;
  } => {
    const side = gridTargetSide(market.currentTick, target);
    const amounts = poolOrderedAmounts(legs, state);
    if (side === undefined) {
      return {
        side,
        amount0: amounts.amount0,
        amount1: amounts.amount1,
        within: false,
        residueWei: 0n,
        residueBps: 0n,
      };
    }
    const verdict = swaplessResidueWithinBound({
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      side,
      spotSqrtPriceX96: market.spotSqrtPriceX96,
    });
    return {
      side,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      within: verdict.within,
      residueWei: verdict.residueWei,
      residueBps: verdict.residueBps,
    };
  };

  const plan: readonly PlannedStep[] = [
    {
      kind: "zap-out",
      reducesExposure: true,
      recoveryAfterConfirm: "pending-mint",
      build: async (ctx) => {
        const tokenId = requireTokenId(position);
        const snapshot = await deps.positions(tokenId);
        if (snapshot === "burned") {
          throw new Error("Position token is burned; there is nothing to flip.");
        }
        if (snapshot.liquidity <= 0n) {
          throw new Error(
            "Position holds no liquidity; a grid flip has nothing to settle.",
          );
        }
        state.priorRange = {
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
        };
        const floors = sagaDecreaseFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
          liquidity: snapshot.liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
        });
        // KEEP-WBNB, never the unwrapping zap-out: the mint pays both legs as
        // ERC-20s under exact approves, so a flip is native-cap-neutral except
        // relay gas. Unwrapping would meter the principal against the native
        // cap on every cycle — the (ah)-shaped trap Phase 3 already closed for
        // the rotate.
        return {
          action: "submit",
          calls: buildLpZapOutKeepWbnbBatch({
            nfpm: deps.venue.nfpm,
            tokenId,
            liquidity: snapshot.liquidity,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            deadline: ctx.deadline,
            wallet: deps.agent.walletAddress,
          }),
        };
      },
      after: async (txHash, _feeReplay, feeCtx) => {
        try {
        if (txHash === undefined) {
          throw new Error("A grid flip zap-out cannot be skipped.");
        }
        // The mint's desired amounts derive from THIS confirmed delta, carried
        // forward — never a balance re-read (Rev2 item 32).
        const collected = await deps.receipts.collectAmounts(txHash);
        state.freedWbnbWei = legs.wbnbIsToken0
          ? collected.amount0Wei
          : collected.amount1Wei;
        state.freedTokenWei = legs.wbnbIsToken0
          ? collected.amount1Wei
          : collected.amount0Wei;
        const snapshot = await deps.positions(requireTokenId(position));
        if (snapshot !== "burned") {
          if (snapshot.liquidity !== 0n) {
            throw new Error(
              "Post-step verification failed: the zap-out confirmed but the position still reports liquidity.",
            );
          }
          state.priorRange ??= {
            tickLower: snapshot.tickLower,
            tickUpper: snapshot.tickUpper,
          };
        }
        } finally {
          await recordLpFeeEvents({ deps, ctx: feeCtx, txHash, position });
        }
      },
    },
    makeSweepStep({
      deps,
      position,
      legs,
      state,
      // Never consulted: `swaplessSkip` answers first and never returns `null`.
      // Supplied because the constructor requires it, and pointing it at the
      // signed target keeps a future reader from inferring a fence exists.
      targetRange: async () => target,
      recoveryAfterConfirm: "wbnb-stranded",
      swaplessSkip: async (market) => {
        const figures = figuresAt(market);
        return lpGridFlipReason({
          outcome: "skipped",
          currentTick: market.currentTick,
          target,
          side: figures.side,
          amount0: figures.amount0,
          amount1: figures.amount1,
          residueWei: figures.residueWei,
          residueBps: figures.residueBps,
        });
      },
    }),
    {
      kind: "zap-in-mint",
      reducesExposure: false,
      recoveryAfterConfirm: "none",
      build: async (ctx) => {
        // ─── G2: THREE CONJUNCTS, ALL AGAINST THE TARGET RANGE (R2.3/M8) ───
        //
        // A side check alone is NOT enough, and "past it" is the dangerous
        // case: if the price gapped THROUGH the target between the settle and
        // this build, `swaplessRotationSide` still returns a VALID side — the
        // other one — and a mint on it would charge the leg the wallet does not
        // hold. So the leg the side IMPLIES is cross-checked against the leg
        // actually held, in POOL ORDER.
        const fresh = figuresAt(ctx.market);
        if (fresh.side === undefined) {
          throw new Error(
            lpGridFlipReason({
              outcome: "refused",
              currentTick: ctx.market.currentTick,
              target,
              side: fresh.side,
              amount0: fresh.amount0,
              amount1: fresh.amount1,
              residueWei: fresh.residueWei,
              residueBps: fresh.residueBps,
              failed: "no-side",
            }),
          );
        }
        if (!fresh.within) {
          throw new Error(
            lpGridFlipReason({
              outcome: "refused",
              currentTick: ctx.market.currentTick,
              target,
              side: fresh.side,
              amount0: fresh.amount0,
              amount1: fresh.amount1,
              residueWei: fresh.residueWei,
              residueBps: fresh.residueBps,
              failed: "residue",
            }),
          );
        }
        const present = fresh.side === "above" ? fresh.amount0 : fresh.amount1;
        if (present <= 0n) {
          throw new Error(
            lpGridFlipReason({
              outcome: "refused",
              currentTick: ctx.market.currentTick,
              target,
              side: fresh.side,
              amount0: fresh.amount0,
              amount1: fresh.amount1,
              residueWei: fresh.residueWei,
              residueBps: fresh.residueBps,
              failed: "leg-contradiction",
            }),
          );
        }
        // The off-side leg is DROPPED — `desired` and `min` both `0n`, the only
        // shape `validateDepositLeg` permits for an absent leg. It stays in the
        // wallet as the owner's, bounded by SWAPLESS_MAX_RESIDUE_BPS and
        // disclosed in the sweep's persisted skip note. `basisWei` is NOT
        // deducted: it is `0n` for a grid agent by construction, and the 3.13
        // OQ2 ruling (no idempotent seam, write-once field) stands.
        const amount0 = fresh.side === "above" ? present : 0n;
        const amount1 = fresh.side === "above" ? 0n : present;
        const liquidity = getLiquidityForAmounts(
          ctx.market.spotSqrtPriceX96,
          target.tickLower,
          target.tickUpper,
          amount0,
          amount1,
        );
        const floors = sagaSingleSidedMintFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: target.tickLower,
          tickUpper: target.tickUpper,
          liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
          side: fresh.side,
        });
        state.mintPlan = {
          amount0,
          amount1,
          residueWei: fresh.residueWei,
          residueBps: fresh.residueBps,
        };
        return {
          action: "submit",
          calls: buildLpMintWbnbBatch({
            nfpm: deps.venue.nfpm,
            token0: position.token0,
            token1: position.token1,
            wbnb: deps.venue.wbnb,
            fee: position.fee,
            tickLower: target.tickLower,
            tickUpper: target.tickUpper,
            amount0DesiredWei: amount0,
            amount1DesiredWei: amount1,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            recipient: deps.agent.walletAddress,
            deadline: ctx.deadline,
          }),
        };
      },
      after: async (txHash, _replay, ctx) => {
        if (txHash === undefined) {
          throw new Error("A grid flip mint cannot be skipped.");
        }
        const mintedTokenId = await deps.receipts.mintedTokenId(txHash);
        const snapshot = await deps.positions(mintedTokenId);
        if (snapshot === "burned" || snapshot.liquidity <= 0n) {
          throw new Error(
            "Post-step verification failed: the mint confirmed but the new position reports no liquidity.",
          );
        }
        const fromTokenId = requireTokenId(position).toString(10);
        // OQ8/C8: the row is REPLACED, not added — `updatePositionTokenId` is
        // the identical call the rotate makes — so a single row never holds two
        // live tokenIds and `lp_positions_one_live_token_idx` is satisfied by
        // construction. The mint→row-update window that PHASE3.4 bought a gate
        // for is protected on the IMPORT side, which is unchanged.
        await deps.store.updatePositionTokenId(
          deps.agent.ownerAddress,
          deps.agent.id,
          position.positionId,
          mintedTokenId.toString(10),
        );
        state.cycle = { fromTokenId, toTokenId: mintedTokenId.toString(10) };
        // ─── PHASE3.19 item 38 — THE (aw) FIX, IN THE SAME COMMIT ──────────
        //
        // The cycle write MOVES HERE, out of `finish`, because this hook runs on
        // BOTH the live path and the RESUME REPLAY — and FINDINGS (aw) records
        // resume as the DEFAULT path on this relay (6 of 6 mainnet
        // submissions), so a ledger written only from `finish`'s in-process
        // `state.mintPlan` was a ledger USUALLY NOT WRITTEN. The minted amounts
        // now come from the confirmed receipt when the deployment's reader can
        // supply them, falling back to the in-process plan so nothing regresses
        // where it cannot.
        //
        // IT KEEPS ITS DERIVED-STATE CATCH, and that disposition is stated here
        // beside the ladder's opposite one so the distinction survives the next
        // reader: `gridCycles` is DERIVED TELEMETRY and a lost row must never
        // hold a sequence, whereas the ladder's VWAP book is an INPUT TO A MONEY
        // DECISION and is allowed to throw (D4).
        await recordGridCycle({
          deps,
          sequenceId: ctx.sequenceId,
          positionId: position.positionId,
          direction: deps.targetRole === "buy" ? "to-buy" : "to-sell",
          from: state.priorRange,
          to: target,
          legs,
          freedWbnbWei: state.freedWbnbWei,
          freedTokenWei: state.freedTokenWei,
          minted: state.mintPlan,
          txHash,
          fromTokenId,
          toTokenId: mintedTokenId.toString(10),
        });
      },
    },
  ];

  return driveSequence({
    deps,
    kind: "grid-flip",
    position,
    plan,
  });
}

/**
 * PHASE3.19 item 38 — ONE cycle-row writer, shared by the flip and the ladder.
 *
 * It reads the minted amounts from the CONFIRMED RECEIPT when the deployment's
 * `LpReceiptReader` can supply them ({@link LpReceiptReader.mintAmounts}, which
 * is optional for the `mintedTokenIds?` reason), and falls back to the
 * in-process build plan otherwise — so a pure resume records a row where before
 * it recorded nothing, and a deployment whose reader predates this phase behaves
 * exactly as it did.
 *
 * DERIVED TELEMETRY, and its catch is deliberate: idempotent on `sequenceId`, so
 * a replayed completion writes nothing new, and a failure costs one report line
 * rather than holding a sequence. This is the OPPOSITE disposition from the
 * ladder's VWAP book (D4), which is an input to a money decision and throws.
 */
async function recordGridCycle(input: {
  readonly deps: LpSagaDeps & { readonly gridCycles?: LpGridCycleStore };
  readonly sequenceId: string;
  readonly positionId: string;
  readonly direction: "to-buy" | "to-sell";
  readonly from: { readonly tickLower: number; readonly tickUpper: number } | undefined;
  readonly to: { readonly tickLower: number; readonly tickUpper: number };
  readonly legs: PoolLegs;
  readonly freedWbnbWei: bigint;
  readonly freedTokenWei: bigint;
  readonly minted:
    | {
        readonly amount0: bigint;
        readonly amount1: bigint;
        readonly residueWei: bigint;
        readonly residueBps: bigint;
      }
    | undefined;
  readonly txHash: Hex;
  readonly fromTokenId: string;
  readonly toTokenId: string;
}): Promise<void> {
  const cycles = input.deps.gridCycles;
  const from = input.from;
  if (cycles === undefined || from === undefined) return;
  try {
    // RECEIPT FIRST (the (aw) fix), plan second. `mintAmounts` is pool-ordered
    // exactly as `collectAmounts` is, so no orientation decision enters here.
    let mintedAmount0Wei: bigint | undefined;
    let mintedAmount1Wei: bigint | undefined;
    const reader = input.deps.receipts.mintAmounts;
    if (reader !== undefined) {
      const amounts = await reader.call(input.deps.receipts, input.txHash);
      mintedAmount0Wei = amounts.amount0Wei;
      mintedAmount1Wei = amounts.amount1Wei;
    } else if (input.minted !== undefined) {
      mintedAmount0Wei = input.minted.amount0;
      mintedAmount1Wei = input.minted.amount1;
    }
    if (mintedAmount0Wei === undefined || mintedAmount1Wei === undefined) return;
    await cycles.record({
      sequenceId: input.sequenceId,
      agentId: input.deps.agent.id,
      ownerAddress: input.deps.agent.ownerAddress,
      positionId: input.positionId,
      direction: input.direction,
      fromTickLower: from.tickLower,
      fromTickUpper: from.tickUpper,
      toTickLower: input.to.tickLower,
      toTickUpper: input.to.tickUpper,
      freedAmount0Wei: input.legs.wbnbIsToken0 ? input.freedWbnbWei : input.freedTokenWei,
      freedAmount1Wei: input.legs.wbnbIsToken0 ? input.freedTokenWei : input.freedWbnbWei,
      mintedAmount0Wei,
      mintedAmount1Wei,
      residueWei: input.minted?.residueWei ?? 0n,
      residueBps: input.minted?.residueBps ?? 0n,
      fromTokenId: input.fromTokenId,
      toTokenId: input.toTokenId,
      completedAtMs: input.deps.now(),
    });
  } catch {
    /* derived: a lost accounting row costs a report line, never the motion */
  }
}

/* -------------------------------------------------------------------------- */
/* Grid requote (PHASE3.18)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The requote's deps: the flip's shape, with a target that is PERSISTED rather
 * than derived and a stored ROLE the G0 gate checks against.
 *
 * PLACEMENT, declared (R2.12 leaves the file to the builder): this runner lives
 * in `sagas.ts` BESIDE THE FLIP rather than in a new module, because it is the
 * flip's plan with two conjuncts added — it reuses `makeSweepStep`,
 * `poolLegs`, `poolOrderedAmounts`, `sagaDecreaseFloors`,
 * `sagaSingleSidedMintFloors`, `swaplessResidueWithinBound`,
 * `buildLpZapOutKeepWbnbBatch`, `buildLpMintWbnbBatch`, `requirePosition`,
 * `requireTokenId` and `driveSequence`, every one of which is module-private
 * here. A separate module would have to widen this file's export surface by a
 * dozen internals to gain nothing but a shorter file, and each new export is a
 * seam a later phase can reach for from somewhere it should not.
 */
export type LpGridRequoteDeps = LpSagaDeps & {
  /**
   * THE RE-CENTRED RANGE, as the TRIGGER computed it and as the sequence row
   * PERSISTED it. Never derived here, and never re-derived on resume.
   *
   * FINDINGS (aw) is the reason and it is measurement, not caution: on the BSC
   * relay resume is the DEFAULT path — 6 of 6 mainnet submissions published
   * after `awaitExecution`'s deadline — so a live-tick derivation at the mint
   * would, in ordinary operation, bind a rung the owner's own drift evidence
   * never justified. The worker loads the row and builds these deps FROM it;
   * this runner then cross-checks the row itself (below) so the precedence rule
   * holds even if a future caller forgets.
   */
  readonly targetRange: { readonly tickLower: number; readonly tickUpper: number };
  /** The level's STORED role — the side G0 requires the live rung to still charge. */
  readonly liveRole: "buy" | "sell";
  /** Signed orientation, for the pool-order side rule. */
  readonly wbnbIsToken0: boolean;
};

/**
 * ONE grid requote: `[zap-out-keep-wbnb, sweep-token (ALWAYS SKIPPED), mint]` —
 * the flip's plan SHAPE exactly, so the 3.11 crash matrix, the `pending-mint`
 * hold semantics, the stall latch, the abandon disposition
 * (`LIQUIDITY_REMOVING_STEPS`) and the non-resolvable posture all carry over
 * with NO new recovery machinery.
 *
 * ─── WHAT DIFFERS FROM THE FLIP, EXHAUSTIVELY ─────────────────────────────
 *
 * 1. THE TARGET IS THE SAME SIDE, not the opposite one. A requote moves the
 *    quote closer to the price; it never converts, never swaps and never
 *    changes which leg the level holds. So the role does NOT invert and this
 *    runner writes no `gridRole` — the flip's write is the only one.
 * 2. G0 (R2.9), at the ZAP-OUT BUILD as well as at the trigger: the level must
 *    still be STRICTLY OUTSIDE its range and still charging the asset its
 *    stored role was armed holding. Drift back INTO range, or a FILL, between
 *    the trigger and the build is a ZERO-MONEY TERMINAL ROLLBACK — never a
 *    hold. A re-centre is discretionary and must never park a position or
 *    disarm the price stop for a move nobody needed.
 * 3. THE PERSISTED TARGET WINS (C4). The row is read here and a `deps`
 *    disagreement is a THROW, never an overwrite — without that a caller could
 *    satisfy "read from the row" with a read a later derivation replaces, which
 *    is B4 restored.
 * 4. Its quota lane is its own (`grid-requote` -> `"requote"`), so a burst of
 *    re-centres can never starve the settlements the flip lane pays for.
 *
 * The mint's G2 is the flip's three conjuncts against the persisted target,
 * unchanged in substance and speaking through {@link lpGridRequoteRefusal} so
 * an owner is never told a re-centre was a flip.
 */
export async function runLpGridRequote(
  deps: LpGridRequoteDeps,
  positionId: string,
): Promise<LpSagaRunResult> {
  const target = deps.targetRange;
  if (
    !Number.isInteger(target.tickLower)
    || !Number.isInteger(target.tickUpper)
    || target.tickUpper <= target.tickLower
  ) {
    throw new Error("runLpGridRequote: the persisted target range is inverted or empty.");
  }
  const position = await requirePosition(deps, positionId, "entry");

  // C4's PRECEDENCE RULE, enforced at the seam rather than merely documented:
  // if a row already exists for this position it carries the target the trigger
  // authorized, and a `deps` target that disagrees is a programming error in
  // the resume path — THROW, never silently prefer either one.
  const existing = await deps.store.getNonTerminalSequence(
    deps.agent.ownerAddress,
    deps.agent.id,
    positionId,
  );
  if (existing !== null && existing.kind === "grid-requote") {
    const lower = existing.targetTickLower;
    const upper = existing.targetTickUpper;
    if (lower === null || upper === null) {
      throw new Error(
        `Requote sequence ${existing.sequenceId} carries no persisted target range; the rung it was authorized to mint cannot be recovered and it will not be re-derived. Owner-signed abandon is the exit.`,
      );
    }
    if (lower !== target.tickLower || upper !== target.tickUpper) {
      throw new Error(
        `Requote sequence ${existing.sequenceId} persisted target [${lower}, ${upper}) but this run was handed [${target.tickLower}, ${target.tickUpper}). The PERSISTED target wins and is never overwritten; a disagreeing recomputation is refused rather than acted on (PHASE3.18 C4).`,
      );
    }
  }

  const legs = poolLegs(position, deps.venue.wbnb);
  const state: FreedState & {
    priorRange?: { tickLower: number; tickUpper: number };
  } = { freedWbnbWei: 0n, freedTokenWei: 0n };

  /** The ONE derivation both G2 conjuncts read — the flip's `figuresAt`, verbatim in shape. */
  const figuresAt = (
    market: LpSagaMarket,
  ): {
    side: SwaplessRotationSide | undefined;
    amount0: bigint;
    amount1: bigint;
    within: boolean;
  } => {
    const side = gridTargetSide(market.currentTick, target);
    const amounts = poolOrderedAmounts(legs, state);
    if (side === undefined) {
      return { side, amount0: amounts.amount0, amount1: amounts.amount1, within: false };
    }
    const verdict = swaplessResidueWithinBound({
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      side,
      spotSqrtPriceX96: market.spotSqrtPriceX96,
    });
    return {
      side,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      within: verdict.within,
    };
  };

  const plan: readonly PlannedStep[] = [
    {
      kind: "zap-out",
      reducesExposure: true,
      recoveryAfterConfirm: "pending-mint",
      build: async (ctx) => {
        const tokenId = requireTokenId(position);
        const snapshot = await deps.positions(tokenId);
        if (snapshot === "burned") {
          throw new Error("Position token is burned; there is nothing to re-centre.");
        }
        if (snapshot.liquidity <= 0n) {
          throw new Error(
            "Position holds no liquidity; a grid requote has nothing to move.",
          );
        }
        const liveRange = {
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
        };
        // ─── G0 AT THE BUILD (R2.9) ───────────────────────────────────────
        //
        // The trigger's own G0 ran two observations ago; this one runs against
        // FRESH evidence immediately before the calls are built, which is the
        // standing money-build discipline. It THROWS, and the throw IS the
        // zero-money terminal rollback: this is plan position 0 of a freshly
        // created sequence, so `driveSequence` has `confirmedMoney === 0` and
        // rolls the sequence back rather than holding it — the same mechanism
        // PHASE3.12 Part 1's G2 uses at `collect-fees.build`, cited here so
        // nobody "improves" it into a hold. A held requote would park a
        // position and disarm its price stop for a move nobody needed.
        const gate = gridRequoteG0({
          currentTick: ctx.market.currentTick,
          range: liveRange,
          role: deps.liveRole,
          wbnbIsToken0: deps.wbnbIsToken0,
        });
        if (!gate.ok) {
          throw new Error(
            lpGridRequoteRefusal({
              where: "zap-out",
              failed: gate.side === undefined ? "in-range" : "filled",
              currentTick: ctx.market.currentTick,
              range: liveRange,
              role: deps.liveRole,
            }),
          );
        }
        state.priorRange = liveRange;
        const floors = sagaDecreaseFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
          liquidity: snapshot.liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
        });
        // KEEP-WBNB, for the flip's reason: the mint pays both legs as ERC-20s
        // under exact approves, so a requote is native-cap-neutral except relay
        // gas. Unwrapping would meter the principal against the native cap on
        // every re-centre — and a re-centre is the motion this phase makes
        // FREQUENT, so the (ah)-shaped trap would bite harder here than
        // anywhere.
        return {
          action: "submit",
          calls: buildLpZapOutKeepWbnbBatch({
            nfpm: deps.venue.nfpm,
            tokenId,
            liquidity: snapshot.liquidity,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            deadline: ctx.deadline,
            wallet: deps.agent.walletAddress,
          }),
        };
      },
      after: async (txHash, _feeReplay, feeCtx) => {
        try {
        if (txHash === undefined) {
          throw new Error("A grid requote zap-out cannot be skipped.");
        }
        const collected = await deps.receipts.collectAmounts(txHash);
        state.freedWbnbWei = legs.wbnbIsToken0
          ? collected.amount0Wei
          : collected.amount1Wei;
        state.freedTokenWei = legs.wbnbIsToken0
          ? collected.amount1Wei
          : collected.amount0Wei;
        const snapshot = await deps.positions(requireTokenId(position));
        if (snapshot !== "burned") {
          if (snapshot.liquidity !== 0n) {
            throw new Error(
              "Post-step verification failed: the zap-out confirmed but the position still reports liquidity.",
            );
          }
          state.priorRange ??= {
            tickLower: snapshot.tickLower,
            tickUpper: snapshot.tickUpper,
          };
        }
        } finally {
          await recordLpFeeEvents({ deps, ctx: feeCtx, txHash, position });
        }
      },
    },
    makeSweepStep({
      deps,
      position,
      legs,
      state,
      targetRange: async () => target,
      recoveryAfterConfirm: "wbnb-stranded",
      // ALWAYS SKIPPED, exactly as the flip's is and for the identical reason:
      // a grid in fixed or policy mode never swaps to rebalance (PHASE3.19 L1:
      // SCOPED — ladder mode's middle step is a profit-gated hedge in its own
      // saga), and a requote does not even change
      // which asset the level holds. The real callback is what makes
      // `makeSweepStep` set `noteOnSkip` and persist the disclosure (3.13 F3).
      swaplessSkip: async (market) => {
        const figures = figuresAt(market);
        return lpGridFlipReason({
          outcome: "skipped",
          currentTick: market.currentTick,
          target,
          side: figures.side,
          amount0: figures.amount0,
          amount1: figures.amount1,
          residueWei: 0n,
          residueBps: 0n,
        });
      },
    }),
    {
      kind: "zap-in-mint",
      reducesExposure: false,
      recoveryAfterConfirm: "none",
      build: async (ctx) => {
        // G2: the flip's THREE CONJUNCTS, against the PERSISTED target.
        const fresh = figuresAt(ctx.market);
        const refuse = (
          failed: "no-side" | "residue" | "leg-contradiction",
        ): never => {
          throw new Error(
            lpGridRequoteRefusal({
              where: "mint",
              failed,
              currentTick: ctx.market.currentTick,
              range: target,
              role: deps.liveRole,
            }),
          );
        };
        if (fresh.side === undefined) refuse("no-side");
        if (!fresh.within) refuse("residue");
        const side = fresh.side as SwaplessRotationSide;
        const present = side === "above" ? fresh.amount0 : fresh.amount1;
        if (present <= 0n) refuse("leg-contradiction");
        const amount0 = side === "above" ? present : 0n;
        const amount1 = side === "above" ? 0n : present;
        const liquidity = getLiquidityForAmounts(
          ctx.market.spotSqrtPriceX96,
          target.tickLower,
          target.tickUpper,
          amount0,
          amount1,
        );
        const floors = sagaSingleSidedMintFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: target.tickLower,
          tickUpper: target.tickUpper,
          liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
          side,
        });
        return {
          action: "submit",
          calls: buildLpMintWbnbBatch({
            nfpm: deps.venue.nfpm,
            token0: position.token0,
            token1: position.token1,
            wbnb: deps.venue.wbnb,
            fee: position.fee,
            tickLower: target.tickLower,
            tickUpper: target.tickUpper,
            amount0DesiredWei: amount0,
            amount1DesiredWei: amount1,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            recipient: deps.agent.walletAddress,
            deadline: ctx.deadline,
          }),
        };
      },
      after: async (txHash) => {
        if (txHash === undefined) {
          throw new Error("A grid requote mint cannot be skipped.");
        }
        const mintedTokenId = await deps.receipts.mintedTokenId(txHash);
        const snapshot = await deps.positions(mintedTokenId);
        if (snapshot === "burned" || snapshot.liquidity <= 0n) {
          throw new Error(
            "Post-step verification failed: the mint confirmed but the re-centred position reports no liquidity.",
          );
        }
        // The row is REPLACED, exactly as the flip and the rotate replace it,
        // so one row never holds two live tokenIds. NO `gridRole` argument: a
        // requote keeps its side by construction, so writing the role here
        // would be a second authority saying the same thing — and the one place
        // the role actually CHANGES is the flip.
        await deps.store.updatePositionTokenId(
          deps.agent.ownerAddress,
          deps.agent.id,
          position.positionId,
          mintedTokenId.toString(10),
        );
      },
    },
  ];

  return driveSequence({
    deps,
    kind: "grid-requote",
    position,
    plan,
    targetRange: target,
  });
}

/* -------------------------------------------------------------------------- */
/* Grid ladder re-centre (PHASE3.19)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The LADDER motion's deps: the requote's shape, plus the four things a
 * buffer-funded, book-keeping motion needs that no earlier saga did.
 *
 * PLACEMENT, declared: this runner lives in `sagas.ts` beside the flip and the
 * requote for the reason 3.18's own header gives — it is the flip's plan with a
 * different middle step, and it reuses `poolLegs`, `sagaDecreaseFloors`,
 * `sagaSingleSidedMintFloors`, `buildLpZapOutKeepWbnbBatch`,
 * `buildLpMintWbnbBatch`, `buildLpSweepSwap`, `amountInAfterPoolFee`,
 * `sagaSwapMinOut`, `quotePriceImpactBps`, `requirePosition`, `requireTokenId`
 * and `driveSequence`, every one of which is module-private here.
 */
export type LpGridRecenterDeps = LpSagaDeps & {
  /**
   * THE RE-ANCHORED RANGE, as the TRIGGER computed it and as the sequence row
   * PERSISTED it. Never derived here, never re-derived on resume — the 3.18 C4
   * contract, for the reason FINDINGS (aw) measures: resume is the DEFAULT path
   * on this relay, so a live-tick derivation at the mint would in ORDINARY
   * OPERATION bind a rung the trigger's own evidence never justified.
   */
  readonly targetRange: { readonly tickLower: number; readonly tickUpper: number };
  /**
   * The rung's STORED role, from the durable columns. A ladder's role is
   * INVARIANT across every motion — a fill does NOT invert it (item 13) — and
   * THIS SAGA WRITES NO `gridRole`, EVER.
   */
  readonly liveRole: LpGridRole;
  /**
   * PHASE3.20 item 7 / C6 — WHICH LANE this motion charges, as the TRIGGER
   * decided it from the evidence that fired. Present on the DISPATCH path only;
   * a RESUME passes nothing and the persisted value on the row is the only
   * source there is, exactly as `targetRange` behaves.
   *
   * PRECEDENCE, enforced at the seam below rather than merely documented: the
   * PERSISTED evidence WINS and a supplied one that disagrees is a THROW. A
   * resume that re-derived it could charge a settlement to the drift budget,
   * which is (az)'s own defect with the lanes pointing the other way.
   */
  readonly recenterEvidence?: LpRecenterEvidence;
  readonly wbnbIsToken0: boolean;
  /** The signed ladder block: the geometry, the deploy fraction and the hedge. */
  readonly ladder: LpGridLadder;
  /**
   * The arm group's BOOK ANCHOR row (C4) — the member whose inventory columns
   * are NOT NULL. EVERY motion of EITHER row reads and writes this one book.
   */
  readonly anchorPositionId: string;
  readonly armGroupId: string | null;
  /**
   * PHASE3.19 item 8 — an OPTIONAL caller-supplied hedge intent, and the second
   * half of the C4 DOUBLE GUARD. Supplied by nothing in the shipped wiring (the
   * worker reads the row); a supplied intent that DISAGREES with the persisted
   * one is a THROW, never an overwrite.
   */
  readonly hedgeIntent?: {
    readonly direction: "wbnb-to-token" | "token-to-wbnb";
    readonly amountInWei: bigint;
  };
  /** DERIVED TELEMETRY, exactly as on the flip. Optional; a failure is swallowed. */
  readonly gridCycles?: LpGridCycleStore;
};

/**
 * ONE LADDER MOTION: `[zap-out-keep-wbnb, sweep-token (the HEDGE), zap-in-mint]`
 * — the flip's plan SHAPE exactly, so the 3.11 crash matrix, the `pending-mint`
 * hold semantics, the stall latch, the abandon disposition
 * (`LIQUIDITY_REMOVING_STEPS`, which keys on the STEP kind `"zap-out"` and needs
 * NO change) and the non-resolvable posture all carry over with NO new recovery
 * machinery.
 *
 * ─── WHAT DIFFERS FROM THE FLIP AND THE REQUOTE, EXHAUSTIVELY ──────────────
 *
 * 1. THE TARGET IS THE SAME ROLE'S RUNG, RE-ANCHORED AT THE CURRENT TICK — the
 *    CHASE (R2.4/OQ5, as measured on HawkFi). A fill's motion and a drift's
 *    motion are THE SAME MOTION, which is the deletion of the Q5 asymmetry that
 *    produced FINDINGS (ax). The role does not invert and no `gridRole` is
 *    written.
 * 2. THE MINT IS FUNDED FROM THE BUFFER, not from what the zap-out freed. That
 *    is the whole mechanism, and it is why {@link LpSagaDeps.walletTokenBalance}
 *    exists and why the {@link LpReceiptReader} charter is amended in the same
 *    commit. Absent reader ⇒ this saga refuses FAIL-CLOSED.
 * 3. THE MIDDLE STEP CAN FIRE. It is the profit-gated inventory HEDGE, and it is
 *    its OWN step with its own build — it does NOT route through
 *    `makeSweepStep`/`planLpSweep` (item 7), whose clamp to the freed legs
 *    cannot express a buffer-sized swap and whose `after` would THROW on every
 *    confirmation ("more input than the collect freed"). It reuses
 *    `buildLpSweepSwap`, `sagaSwapMinOut`, `amountInAfterPoolFee` and the
 *    `quotePriceImpactBps` RAIL RE-CHECK verbatim — copying the CHECKS is
 *    mandatory, because without the impact re-check `maxPriceImpactBps` is inert
 *    on an autonomous swap leg. It NEVER decrements `state.freed*`.
 * 4. IT KEEPS A DURABLE VWAP BOOK. Two `after` hooks credit it — the zap-out's
 *    (priced at the midpoint of the EXITED range, C13) and the hedge's (exact,
 *    from the swap receipt) — through the append-only, replay-proof set of
 *    R4.1/D1-D4.
 * 5. G2's RESIDUE CONJUNCT IS NOT RUN (M9). `swaplessResidueWithinBound`
 *    measures the FREED legs and asks whether the off-side leg the swapless mint
 *    would DROP is small. Under a ladder the freed legs go TO the buffer and are
 *    not dropped at all, so the check is meaningless here — and running it
 *    unchanged would refuse a perfectly good motion whenever fees accrued on
 *    both legs. `SWAPLESS_MAX_RESIDUE_BPS` and both existing call sites are
 *    UNTOUCHED. The ladder's own G2 is TWO conjuncts: the C7 side rule, and the
 *    buffer holding a positive planned mint.
 *
 * ─── THE ONE HOLD, AND WHY IT IS RECOVERABLE (H3.3) ────────────────────────
 *
 * A `zap-out` refusal is plan position 0 of a freshly created sequence, so it
 * ROLLS BACK terminal and releases its reservation. Everything after it holds at
 * `pending-mint`: the principal is in the owner's own EOA, the 3.11 stall latch
 * quiesces the row, and the owner-signed abandon door stays open. There is no
 * state in which a ladder motion parks a position with money it cannot account
 * for.
 */
export async function runLpGridRecenter(
  deps: LpGridRecenterDeps,
  positionId: string,
): Promise<LpSagaRunResult> {
  const target = deps.targetRange;
  if (
    !Number.isInteger(target.tickLower)
    || !Number.isInteger(target.tickUpper)
    || target.tickUpper <= target.tickLower
  ) {
    throw new Error("runLpGridRecenter: the persisted target range is inverted or empty.");
  }
  const position = await requirePosition(deps, positionId, "entry");
  const owner = deps.agent.ownerAddress;
  const agentId = deps.agent.id;

  // C4's PRECEDENCE RULE, enforced at the seam rather than merely documented —
  // the 3.18 shape verbatim, and now covering the HEDGE INTENT as well as the
  // target. A `deps` value that disagrees with a persisted one is a programming
  // error in the resume path: THROW, never silently prefer either.
  const existing = await deps.store.getNonTerminalSequence(owner, agentId, positionId);
  if (existing !== null && existing.kind === "grid-recenter") {
    const lower = existing.targetTickLower;
    const upper = existing.targetTickUpper;
    if (lower === null || upper === null) {
      throw new Error(
        `Ladder sequence ${existing.sequenceId} carries no persisted target range; the rung it was authorized to mint cannot be recovered and it will not be re-derived. Owner-signed abandon is the exit.`,
      );
    }
    if (lower !== target.tickLower || upper !== target.tickUpper) {
      throw new Error(
        `Ladder sequence ${existing.sequenceId} persisted target [${lower}, ${upper}) but this run was handed [${target.tickLower}, ${target.tickUpper}). The PERSISTED target wins and is never overwritten; a disagreeing recomputation is refused rather than acted on (PHASE3.18 C4).`,
      );
    }
    // PHASE3.20 C6 — the SAME precedence rule, one field further on. A run
    // handed an evidence that disagrees with the persisted one is a programming
    // error in the resume path, and the fail-closed answer is a THROW rather
    // than silently preferring either: the persisted lane is the one the
    // reservation already charged, and re-deciding it after the fact would let a
    // motion consume a budget the owner's own trigger never authorized.
    const suppliedEvidence = deps.recenterEvidence;
    if (
      suppliedEvidence !== undefined
      && existing.recenterEvidence !== null
      && existing.recenterEvidence !== suppliedEvidence
    ) {
      throw new Error(
        `Ladder sequence ${existing.sequenceId} persisted the ${existing.recenterEvidence} lane but this run was handed ${suppliedEvidence}. The PERSISTED evidence wins and is never overwritten; a disagreeing recomputation is refused rather than acted on (PHASE3.20 C6).`,
      );
    }
    const supplied = deps.hedgeIntent;
    if (
      supplied !== undefined
      && existing.hedgeDirection !== null
      && existing.hedgeAmountInWei !== null
      && (existing.hedgeDirection !== supplied.direction
        || existing.hedgeAmountInWei !== supplied.amountInWei)
    ) {
      throw new Error(
        `Ladder sequence ${existing.sequenceId} persisted a ${existing.hedgeDirection} hedge of ${existing.hedgeAmountInWei} wei but this run was handed ${supplied.direction} / ${supplied.amountInWei}. The PERSISTED intent wins and is never overwritten: a hedge is a market order, so a resume that re-derived its size at a different price would bind a DIFFERENT swap.`,
      );
    }
  }

  const legs = poolLegs(position, deps.venue.wbnb);
  const wbnb = deps.venue.wbnb;
  const chargedIsQuote = deps.liveRole === "buy";
  const chargedToken = chargedIsQuote ? wbnb : legs.token;
  const state: FreedState & {
    /** The EXITED range, read BEFORE the row's tokenId is replaced (C13). */
    priorRange?: { tickLower: number; tickUpper: number };
    mintPlan?: {
      readonly amount0: bigint;
      readonly amount1: bigint;
      readonly residueWei: bigint;
      readonly residueBps: bigint;
    };
    cycle?: { readonly fromTokenId: string; readonly toTokenId: string };
  } = { freedWbnbWei: 0n, freedTokenWei: 0n };

  /** The buffer reader, refused FAIL-CLOSED when the deployment has none. */
  const readBalance = async (token: Address): Promise<bigint> => {
    const reader = deps.walletTokenBalance;
    if (reader === undefined) {
      throw new Error(
        "This deployment's saga deps carry no walletTokenBalance reader, so a buffer-funded ladder mint cannot be sized. The motion refuses rather than sizing it from something else.",
      );
    }
    return reader(token);
  };

  /**
   * What the mint this motion still owes will take, in the CHARGED asset's own
   * units: `deployPctBps` of what the wallet holds of it AT BUILD TIME.
   *
   * By the time this is read the zap-out has confirmed and its proceeds are in
   * the wallet, so "what the wallet holds" IS the side's whole inventory — which
   * is exactly the HawkFi model: re-place `deployPctBps` of the side, keep the
   * rest idle.
   */
  const plannedMintWei = async (): Promise<bigint> => {
    const held = await readBalance(chargedToken);
    return (held * BigInt(deps.ladder.deployPctBps)) / 10_000n;
  };

  /**
   * PHASE3.19 C13 — the book's credit, priced at the midpoint of the EXITED
   * range.
   *
   * NOT at the persisted target's midpoint, which is where the review's first
   * repair put it and which is WRONG in a NAMED DIRECTION: under the CHASE the
   * target is anchored at TODAY's price, so pricing a buy fill's acquisition
   * there records a LOWER cost than the truth, the book average falls, and
   * `markout = market - bookAvg` reads MORE PROFITABLE than it is — the exact
   * bias the repair was written to remove.
   *
   * The exited range's ticks ARE readable for the whole motion:
   * `buildLpZapOutKeepWbnbBatch` is `[decreaseLiquidity, collect]` and emits NO
   * `burn`, so the token survives at zero liquidity and `deps.positions` answers
   * its ticks on the live path AND on resume; the row's tokenId is replaced only
   * in the MINT's `after`, i.e. after this write.
   *
   * MIDPOINT-VS-PATH-AVERAGE REMAINS AN APPROXIMATION, and the bias is named: a
   * range order fills continuously across its width, so the realised average is
   * somewhere inside it and the midpoint is the unbiased point estimate of that
   * — as against a BOUNDARY, which is optimistic by up to `widthTicks` in the
   * direction that makes the hedge fire earlier.
   */
  const midpointSqrt = (range: { tickLower: number; tickUpper: number }): bigint =>
    getSqrtRatioAtTick(Math.floor((range.tickLower + range.tickUpper) / 2));

  const plan: readonly PlannedStep[] = [
    {
      kind: "zap-out",
      reducesExposure: true,
      recoveryAfterConfirm: "pending-mint",
      build: async (ctx) => {
        const tokenId = requireTokenId(position);
        const snapshot = await deps.positions(tokenId);
        if (snapshot === "burned") {
          throw new Error(
            lpGridLadderRefusal({
              where: "zap-out",
              failed: "burned",
              role: deps.liveRole,
              currentTick: ctx.market.currentTick,
              target,
            }),
          );
        }
        if (snapshot.liquidity <= 0n) {
          throw new Error(
            "Position holds no liquidity; a ladder re-anchor has nothing to move.",
          );
        }
        // C13: the EXITED range, captured before anything replaces it.
        state.priorRange = {
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
        };
        const floors = sagaDecreaseFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
          liquidity: snapshot.liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
        });
        // KEEP-WBNB, for the flip's reason and one more of this phase's own: the
        // proceeds must land in the BUFFER as ERC-20s, because every re-mint
        // after the arm is `buildLpMintWbnbBatch`-shaped. Unwrapping would meter
        // the principal against the native cap on EVERY motion — and a ladder is
        // the mode that moves most.
        return {
          action: "submit",
          calls: buildLpZapOutKeepWbnbBatch({
            nfpm: deps.venue.nfpm,
            tokenId,
            liquidity: snapshot.liquidity,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            deadline: ctx.deadline,
            wallet: deps.agent.walletAddress,
          }),
        };
      },
      after: async (txHash, _replay, hookCtx) => {
        try {
        if (txHash === undefined) {
          throw new Error("A ladder zap-out cannot be skipped.");
        }
        const collected = await deps.receipts.collectAmounts(txHash);
        state.freedWbnbWei = legs.wbnbIsToken0
          ? collected.amount0Wei
          : collected.amount1Wei;
        state.freedTokenWei = legs.wbnbIsToken0
          ? collected.amount1Wei
          : collected.amount0Wei;
        const snapshot = await deps.positions(requireTokenId(position));
        if (snapshot !== "burned") {
          if (snapshot.liquidity !== 0n) {
            throw new Error(
              "Post-step verification failed: the zap-out confirmed but the position still reports liquidity.",
            );
          }
          state.priorRange ??= {
            tickLower: snapshot.tickLower,
            tickUpper: snapshot.tickUpper,
          };
        }
        const exited = state.priorRange;
        if (exited === undefined) {
          throw new Error(
            "The exited range could not be recovered from the position snapshot; the inventory book will not be advanced against a range nobody read.",
          );
        }
        const sqrtAtMid = midpointSqrt(exited);
        // B.1 — WHICH LEG IS ACQUIRED IS DETERMINABLE FROM THE DURABLE ROLE, and
        // that is what makes this a receipt-derived credit rather than a guess:
        // role `buy` STARTED holding quote, so ALL freed base is ACQUIRED base;
        // role `sell` STARTED holding base, so ALL freed quote is REALISED. A
        // partial fill frees both legs and the split is still unambiguous.
        const delta = chargedIsQuote
          ? {
              // A BUY rung: credit the base it acquired, at the cost the exited
              // rung's own midpoint implies.
              baseWei: state.freedTokenWei,
              costWbnbWei: spotSwapOutput({
                amountInAfterFee: state.freedTokenWei,
                sqrtPriceX96: sqrtAtMid,
                tokenInIsToken0: !legs.wbnbIsToken0,
              }),
            }
          : {
              // A SELL rung: deduct the base it sold, priced back from the quote
              // it realised at the same midpoint. The COST leg is recomputed
              // proportionally by the store's own clamp (D1), so the value
              // passed here is only the requested one.
              baseWei: -spotSwapOutput({
                amountInAfterFee: state.freedWbnbWei,
                sqrtPriceX96: sqrtAtMid,
                tokenInIsToken0: legs.wbnbIsToken0,
              }),
              costWbnbWei: -state.freedWbnbWei,
            };
        if (delta.baseWei !== 0n) {
          // D4: TRANSACTIONAL, and ALLOWED TO HOLD. This is not derived
          // telemetry — the markout gate reads it to decide a market swap — so a
          // throw here becomes a recoverable POST_VERIFY_FAILED hold rather than
          // a permanently lost credit.
          await deps.store.applyInventoryCredit(owner, agentId, {
            applicationKey: hookCtx.journalIdempotencyKey,
            positionId: deps.anchorPositionId,
            armGroupId: deps.armGroupId,
            deltaBaseWei: delta.baseWei,
            deltaCostWbnbWei: delta.costWbnbWei,
          });
        }
        } finally {
          await recordLpFeeEvents({ deps, ctx: hookCtx, txHash, position });
        }
      },
    },
    {
      // ITEM 7 / M3 — its OWN step, with the EXISTING kind. `LpStepKind` has no
      // DB CHECK so a `"hedge-swap"` member would be cheap in the store and
      // expensive everywhere else; the plan is otherwise byte-identical in SHAPE
      // to the flip's and the requote's, which is what lets everything carry
      // over. It BEHAVES differently and its kind does not.
      kind: "sweep-token",
      reducesExposure: false,
      recoveryAfterConfirm: "wbnb-stranded",
      // F3's flag: a MANDATORY step whose SKIP reason must survive, because the
      // skip note is the owner's only in-product account of why the hedge did
      // not fire.
      noteOnSkip: true,
      build: async (ctx) => {
        const sequence = await deps.store.getNonTerminalSequence(owner, agentId, positionId);
        const persistedDirection = sequence?.hedgeDirection ?? null;
        const persistedAmount = sequence?.hedgeAmountInWei ?? null;
        let direction: "wbnb-to-token" | "token-to-wbnb";
        let amountInWei: bigint;
        if (persistedDirection !== null && persistedAmount !== null) {
          // THE PERSISTED INTENT WINS and is USED VERBATIM. Nothing is
          // recomputed here — not because a recomputation would be wrong, but
          // because a recomputation is the thing that could OVERWRITE it, and
          // the resume must rebind the SAME swap the trigger's own evidence
          // authorized (item 46's mutation class).
          direction = persistedDirection;
          amountInWei = persistedAmount;
        } else {
          if (!deps.ladder.hedge.enabled) {
            return {
              action: "skip",
              reason: lpGridLadderHedgeSkipNote({
                why: "disabled",
                markoutBps: 0n,
                minMarkoutBps: deps.ladder.hedge.minMarkoutBps,
              }),
            };
          }
          const bufferQuoteWei = await readBalance(wbnb);
          const bufferBaseWei = await readBalance(legs.token);
          const owedMintWei = await plannedMintWei();
          const hedge = gridLadderHedgePlan({
            bufferQuoteWei,
            bufferBaseWei,
            spotSqrtPriceX96: ctx.market.spotSqrtPriceX96,
            wbnbIsToken0: legs.wbnbIsToken0,
            maxHedgePctBps: deps.ladder.hedge.maxHedgePctBps,
            // C14's second term is a fraction of ONE SIDE'S DEPLOYED SIZE, which
            // at this moment IS the mint this motion still owes.
            rungSizeWei: owedMintWei,
            chargedIsQuote,
            plannedMintWei: owedMintWei,
          });
          if (hedge === null) {
            return {
              action: "skip",
              reason: lpGridLadderHedgeSkipNote({
                why: "balanced",
                markoutBps: 0n,
                minMarkoutBps: deps.ladder.hedge.minMarkoutBps,
              }),
            };
          }
          const book = await deps.store.readInventoryBook(
            owner,
            agentId,
            deps.anchorPositionId,
          );
          const effectiveMinMarkoutBps = ladderMinMarkoutBps({
            poolFee: position.fee,
            maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
            signedMinMarkoutBps: deps.ladder.hedge.minMarkoutBps,
          });
          const markout = gridLadderMarkout({
            direction: hedge.direction,
            bookBaseWei: book?.baseWei ?? 0n,
            bookCostWbnbWei: book?.costWbnbWei ?? 0n,
            spotSqrtPriceX96: ctx.market.spotSqrtPriceX96,
            wbnbIsToken0: legs.wbnbIsToken0,
            minMarkoutBps: effectiveMinMarkoutBps,
          });
          if (!markout.defined) {
            // D1: a zero book has NO average. REFUSE rather than divide.
            return {
              action: "skip",
              reason: lpGridLadderHedgeSkipNote({
                why: "no-book",
                markoutBps: 0n,
                minMarkoutBps: effectiveMinMarkoutBps,
              }),
            };
          }
          if (!markout.ok) {
            return {
              action: "skip",
              reason: lpGridLadderHedgeSkipNote({
                why: "markout",
                markoutBps: markout.markoutBps,
                minMarkoutBps: effectiveMinMarkoutBps,
              }),
            };
          }
          direction = hedge.direction;
          amountInWei = hedge.amountInWei;
          // PERSISTED BEFORE THE SUBMIT. The store's write is WRITE-ONCE, so
          // even a racing second build cannot replace it.
          const bound = await deps.store.setHedgeIntent(owner, agentId, sequence?.sequenceId ?? "", {
            direction,
            amountInWei,
          });
          direction = bound.hedgeDirection ?? direction;
          amountInWei = bound.hedgeAmountInWei ?? amountInWei;
        }
        if (amountInWei <= 0n) {
          return {
            action: "skip",
            reason: lpGridLadderHedgeSkipNote({
              why: "dust",
              markoutBps: 0n,
              minMarkoutBps: deps.ladder.hedge.minMarkoutBps,
            }),
          };
        }
        const tokenIn = direction === "wbnb-to-token" ? wbnb : legs.token;
        const tokenOut = direction === "wbnb-to-token" ? legs.token : wbnb;
        const quotedOut = await deps.quote({
          tokenIn,
          tokenOut,
          fee: position.fee,
          amountInWei,
        });
        // THE RAIL RE-CHECK, COPIED VERBATIM from `makeSweepStep` (item 7),
        // including the `tokenInIsToken0` expression and the pool-fee deduction.
        // Copying rather than re-deriving is the instruction and the reason: the
        // evidence's `priceImpactBps` is a hardcoded `0n`, so without this
        // `maxPriceImpactBps` is INERT on an autonomous swap leg, and getting
        // `tokenInIsToken0` backwards inverts the comparison silently.
        const tokenInIsToken0 =
          direction === "wbnb-to-token" ? legs.wbnbIsToken0 : !legs.wbnbIsToken0;
        const expectedAtSpot = spotSwapOutput({
          amountInAfterFee: amountInAfterPoolFee(amountInWei, position.fee),
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tokenInIsToken0,
        });
        if (
          quotePriceImpactBps(expectedAtSpot, quotedOut)
          > BigInt(deps.rails.maxPriceImpactBps)
        ) {
          throw new Error(
            "Quoted price impact of the ladder hedge leg exceeds the manipulation-rail ceiling.",
          );
        }
        return {
          action: "submit",
          calls: buildLpSweepSwap({
            router: deps.venue.routerV3,
            tokenIn,
            tokenOut,
            fee: position.fee,
            amountInWei,
            minOutWei: sagaSwapMinOut(quotedOut, deps.rails.maxSagaSlippageBps),
            recipient: deps.agent.walletAddress,
            deadline: ctx.deadline,
          }),
        };
      },
      after: async (txHash, _replay, hookCtx) => {
        // A SKIPPED hedge moved nothing and owes the book nothing.
        if (txHash === undefined) return;
        const swap = await deps.receipts.swapAmounts(txHash);
        const inIsWbnb = swap.tokenIn.toLowerCase() === wbnb.toLowerCase();
        // IT NEVER DECREMENTS `state.freed*` (item 7). Those amounts describe
        // what the ZAP-OUT freed; the hedge trades the standing BUFFER, and
        // subtracting a buffer-sized swap from them is precisely the negative
        // that makes `makeSweepStep`'s `after` throw on every confirmation.
        const delta = inIsWbnb
          ? // quote -> base: an ACQUISITION, at its EXACT cost. Both legs come
            // straight from the confirmed receipt; nothing is estimated.
            { baseWei: swap.amountOutWei, costWbnbWei: swap.amountInWei }
          : // base -> quote: a REALISATION. The cost leg is recomputed
            // proportionally by the store's clamp (D1) from the book average.
            { baseWei: -swap.amountInWei, costWbnbWei: -swap.amountOutWei };
        await deps.store.applyInventoryCredit(owner, agentId, {
          applicationKey: hookCtx.journalIdempotencyKey,
          positionId: deps.anchorPositionId,
          armGroupId: deps.armGroupId,
          deltaBaseWei: delta.baseWei,
          deltaCostWbnbWei: delta.costWbnbWei,
        });
      },
    },
    {
      kind: "zap-in-mint",
      reducesExposure: false,
      recoveryAfterConfirm: "none",
      build: async (ctx) => {
        // ─── THE LADDER'S G2: TWO CONJUNCTS (M9), NOT THE FLIP'S THREE ─────
        //
        // (1) C7's SIDE RULE, against the PERSISTED target at the BUILD tick.
        //     It is a PRIMARY control here and not a belt: unlike the flip, a
        //     buffer-funded wallet holds BOTH legs, so a wrong-side mint would
        //     SUCCEED and fund a buy rung with base.
        const verdict = gridLadderRemintSide({
          currentTick: ctx.market.currentTick,
          target,
          role: deps.liveRole,
          wbnbIsToken0: deps.wbnbIsToken0,
        });
        if (!verdict.ok) {
          throw new Error(
            lpGridLadderRefusal({
              where: "mint",
              failed: verdict.failed,
              role: deps.liveRole,
              currentTick: ctx.market.currentTick,
              target,
            }),
          );
        }
        // (2) THE BUFFER FUNDS IT. `swaplessResidueWithinBound` is deliberately
        //     NOT called (M9): it measures the FREED legs, and a ladder retains
        //     them rather than dropping them.
        const present = await plannedMintWei();
        if (present <= 0n) {
          throw new Error(
            lpGridLadderRefusal({
              where: "mint",
              failed: "unfunded",
              role: deps.liveRole,
              currentTick: ctx.market.currentTick,
              target,
            }),
          );
        }
        // The charged leg is the one the SIDE implies, and by conjunct (1) that
        // is the one this role holds — so the pool-ordered assignment reads off
        // the side with no orientation branch.
        const amount0 = verdict.side === "above" ? present : 0n;
        const amount1 = verdict.side === "above" ? 0n : present;
        const liquidity = getLiquidityForAmounts(
          ctx.market.spotSqrtPriceX96,
          target.tickLower,
          target.tickUpper,
          amount0,
          amount1,
        );
        const floors = sagaSingleSidedMintFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: target.tickLower,
          tickUpper: target.tickUpper,
          liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
          side: verdict.side,
        });
        state.mintPlan = { amount0, amount1, residueWei: 0n, residueBps: 0n };
        return {
          action: "submit",
          calls: buildLpMintWbnbBatch({
            nfpm: deps.venue.nfpm,
            token0: position.token0,
            token1: position.token1,
            wbnb,
            fee: position.fee,
            tickLower: target.tickLower,
            tickUpper: target.tickUpper,
            amount0DesiredWei: amount0,
            amount1DesiredWei: amount1,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            recipient: deps.agent.walletAddress,
            deadline: ctx.deadline,
          }),
        };
      },
      after: async (txHash, _replay, hookCtx) => {
        if (txHash === undefined) {
          throw new Error("A ladder mint cannot be skipped.");
        }
        const mintedTokenId = await deps.receipts.mintedTokenId(txHash);
        const snapshot = await deps.positions(mintedTokenId);
        if (snapshot === "burned" || snapshot.liquidity <= 0n) {
          throw new Error(
            "Post-step verification failed: the mint confirmed but the re-anchored position reports no liquidity.",
          );
        }
        const fromTokenId = requireTokenId(position).toString(10);
        // The row is REPLACED, exactly as the flip and the requote replace it.
        // NO `gridRole` ARGUMENT (item 13): a ladder's role is invariant across
        // every motion, and the flip's write is the only place a role changes.
        await deps.store.updatePositionTokenId(
          owner,
          agentId,
          position.positionId,
          mintedTokenId.toString(10),
        );
        state.cycle = { fromTokenId, toTokenId: mintedTokenId.toString(10) };
        await recordGridCycle({
          deps,
          sequenceId: hookCtx.sequenceId,
          positionId: position.positionId,
          direction: deps.liveRole === "buy" ? "to-buy" : "to-sell",
          from: state.priorRange,
          to: target,
          legs,
          freedWbnbWei: state.freedWbnbWei,
          freedTokenWei: state.freedTokenWei,
          minted: state.mintPlan,
          txHash,
          fromTokenId,
          toTokenId: mintedTokenId.toString(10),
        });
      },
    },
  ];

  return driveSequence({
    deps,
    kind: "grid-recenter",
    position,
    plan,
    // C4: written by the INSERT that creates the row, so the target is durable
    // before the zap-out can submit.
    targetRange: target,
    // PHASE3.20 item 7: written by the same INSERT, for the same reason.
    ...(deps.recenterEvidence === undefined
      ? {}
      : { recenterEvidence: deps.recenterEvidence }),
  });
}

/* -------------------------------------------------------------------------- */
/* Harvest                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Auto-compound: `[collect-fees, sweep-token?, zap-in-increase]` on the SAME
 * tokenId. Pays WBNB (Rev2 item 14) — the collected WBNB fee leg stays WBNB
 * and comes back in under an exact approve. No brain anywhere near this path:
 * the target ratio is the position's OWN standing range.
 */
export async function runLpHarvest(
  deps: LpSagaDeps,
  positionId: string,
): Promise<LpSagaRunResult> {
  const position = await requirePosition(deps, positionId, "entry");
  const legs = poolLegs(position, deps.venue.wbnb);
  const state: FreedState & {
    range?: { tickLower: number; tickUpper: number };
    preLiquidity?: bigint;
  } = { freedWbnbWei: 0n, freedTokenWei: 0n };

  const readRange = async (): Promise<{ tickLower: number; tickUpper: number }> => {
    if (state.range !== undefined) return state.range;
    const snapshot = await deps.positions(requireTokenId(position));
    if (snapshot === "burned") {
      throw new Error("Position token is burned; a harvest has nothing to compound into.");
    }
    state.range = {
      tickLower: snapshot.tickLower,
      tickUpper: snapshot.tickUpper,
    };
    return state.range;
  };

  const plan: readonly PlannedStep[] = [
    {
      kind: "collect-fees",
      reducesExposure: true,
      recoveryAfterConfirm: "pending-increase",
      build: async (ctx) => {
        const tokenId = requireTokenId(position);
        const snapshot = await deps.positions(tokenId);
        if (snapshot === "burned") {
          throw new Error("Position token is burned; there is nothing to harvest.");
        }
        // PHASE3.12 G2 — the SAME predicate the trigger gate reads, applied to
        // the fresh evidence this step would have submitted on, ABOVE the
        // collect. The trigger decided on the previous cycle's tick; the price
        // can leave the interior in the gap, and that gap is the live Phase
        // 3.11 incident's shape.
        //
        // Position 0 of the plan is why this is a throw and not something
        // cleverer: `refuseCleanly` routes on confirmed money, and here there
        // is none, so the sequence ROLLS BACK terminal and releases its
        // reservation. One step later — after the collect — the identical
        // refusal would be a `held` row with the fees stranded in the wallet.
        if (swapSplitIsTotal(ctx.market.currentTick, snapshot.tickLower, snapshot.tickUpper)) {
          throw new Error(
            lpHarvestRangeHoldReason({
              currentTick: ctx.market.currentTick,
              tickLower: snapshot.tickLower,
              tickUpper: snapshot.tickUpper,
              // PHASE3.13 F12: the ride-along Part 1 deferred. The saga seam
              // now carries the owner's own flag, so this refusal names the ONE
              // remedy that applies instead of stating both branches.
              autoRotate: deps.autoRotate,
            }),
          );
        }
        state.range = {
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
        };
        state.preLiquidity = snapshot.liquidity;
        return {
          action: "submit",
          calls: buildCollectToWallet({
            nfpm: deps.venue.nfpm,
            tokenId,
            wallet: deps.agent.walletAddress,
          }),
        };
      },
      after: async (txHash, _feeReplay, feeCtx) => {
        try {
        if (txHash === undefined) {
          throw new Error("A harvest collect cannot be skipped.");
        }
        const collected = await deps.receipts.collectAmounts(txHash);
        state.freedWbnbWei = legs.wbnbIsToken0
          ? collected.amount0Wei
          : collected.amount1Wei;
        state.freedTokenWei = legs.wbnbIsToken0
          ? collected.amount1Wei
          : collected.amount0Wei;
        const snapshot = await deps.positions(requireTokenId(position));
        if (snapshot === "burned") {
          throw new Error(
            "Post-step verification failed: the collect confirmed but the position token is gone.",
          );
        }
        state.range ??= {
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
        };
        } finally {
          await recordLpFeeEvents({ deps, ctx: feeCtx, txHash, position });
        }
      },
    },
    makeSweepStep({
      deps,
      position,
      legs,
      state,
      targetRange: readRange,
      recoveryAfterConfirm: "wbnb-stranded",
    }),
    {
      kind: "zap-in-increase",
      reducesExposure: false,
      recoveryAfterConfirm: "none",
      build: async (ctx) => {
        const range = await readRange();
        const amounts = poolOrderedAmounts(legs, state);
        if (amounts.amount0 <= 0n || amounts.amount1 <= 0n) {
          throw new Error(
            "The compounding increase needs both legs positive after the sweep.",
          );
        }
        const liquidity = getLiquidityForAmounts(
          ctx.market.spotSqrtPriceX96,
          range.tickLower,
          range.tickUpper,
          amounts.amount0,
          amounts.amount1,
        );
        const floors = sagaMintFloors({
          sqrtPriceX96: ctx.market.spotSqrtPriceX96,
          tickLower: range.tickLower,
          tickUpper: range.tickUpper,
          liquidity,
          maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
          amount0Desired: amounts.amount0,
          amount1Desired: amounts.amount1,
        });
        return {
          action: "submit",
          calls: buildLpIncreaseBatch({
            nfpm: deps.venue.nfpm,
            tokenId: requireTokenId(position),
            token0: position.token0,
            token1: position.token1,
            wbnb: deps.venue.wbnb,
            amount0DesiredWei: amounts.amount0,
            amount1DesiredWei: amounts.amount1,
            amount0MinWei: floors.amount0Min,
            amount1MinWei: floors.amount1Min,
            deadline: ctx.deadline,
          }),
        };
      },
      after: async (txHash, replay) => {
        if (txHash === undefined) {
          throw new Error("A harvest increase cannot be skipped.");
        }
        const snapshot = await deps.positions(requireTokenId(position));
        if (snapshot === "burned" || snapshot.liquidity <= 0n) {
          throw new Error(
            "Post-step verification failed: the increase confirmed but the position reports no liquidity.",
          );
        }
        // The strict before/after comparison only means something on the live
        // path: a replay's `preLiquidity` was read AFTER the increase landed.
        if (
          !replay &&
          state.preLiquidity !== undefined &&
          snapshot.liquidity <= state.preLiquidity
        ) {
          throw new Error(
            "Post-step verification failed: the increase confirmed but liquidity did not grow.",
          );
        }
      },
    },
  ];

  return driveSequence({ deps, kind: "harvest", position, plan });
}

/* -------------------------------------------------------------------------- */
/* Grid ATOMIC ladder shift (PHASE3.22)                                       */
/* -------------------------------------------------------------------------- */

/** PHASE3.22 R10 — one rung of the pair, as the worker loaded it this cycle. */
export type LpGridShiftRow = {
  readonly positionId: string;
  readonly role: LpGridRole;
  readonly tokenId: string | null;
  /** Carried so a re-opened dormant side inherits the pair's lineage (R4.2.3). */
  readonly lineageId: string;
};

/**
 * PHASE3.22 R10 — the ATOMIC LADDER's deps.
 *
 * PLACEMENT, declared for the reason 3.18/3.19 declared theirs: this runner
 * lives beside the flip, the requote and the ladder because it reuses
 * `poolLegs`, `sagaDecreaseFloors`, `sagaSingleSidedMintFloors`,
 * `buildLpZapOutKeepWbnbBatch`, `buildLpMintWbnbBatch`, `requirePosition` and
 * `driveSequence` — every one of which is module-private here.
 */
export type LpGridShiftDeps = LpSagaDeps & {
  /**
   * THE BUY RUNG's re-anchored range, as the TRIGGER computed it and as the
   * sequence row PERSISTED it (`target_tick_lower/upper`).
   *
   * Never derived here and never re-derived on resume — the 3.18 C4 contract,
   * for the reason FINDINGS (aw) measures: resume is the DEFAULT path on this
   * relay, so a live-tick derivation at the mint would in ORDINARY OPERATION
   * bind a rung the trigger's own evidence never justified.
   */
  readonly targetBuyRange?: { readonly tickLower: number; readonly tickUpper: number };
  /** THE SELL RUNG's range, persisted in `target_sell_tick_lower/upper`. */
  readonly targetSellRange?: { readonly tickLower: number; readonly tickUpper: number };
  /**
   * PHASE3.23 R3.2 — cause authority from the persisted row. `unknown` is
   * tolerated only for submitted journal replay; a build refuses it at G0.
   */
  readonly cause: LpShiftCause | "unknown";
  /**
   * The pair's arm group. Every position write this saga makes resolves
   * through it, so a shift can never touch a row outside its own ladder.
   */
  readonly armGroupId: string;
  /**
   * BOTH rows of the pair, as the worker loaded them this cycle — the row this
   * saga was dispatched on and its sibling, each with its durable role.
   *
   * A shift is ONE sequence that moves TWO positions, which no saga before it
   * did. The rows are passed IN rather than read here because the worker
   * already holds the cycle's position list (the `ladderArbitration` threading
   * pattern, zero extra reads), and because a money path must not depend on a
   * store read it could make at a different moment than the trigger did.
   *
   * A ONE-SIDED pair passes ONE entry: the dormant side's row is CLOSED
   * (R4.2.2), so it is not in the worker's open-position list at all.
   */
  readonly rows: readonly LpGridShiftRow[];
  /**
   * The pair's SIGNED shift geometry. Read for `deployPctBps` at the
   * mint-build funding recompute — the fail-closed belt, never a second
   * authority: the trigger consumed the same block through the same function.
   */
  readonly shift: LpGridShiftSettings;
  readonly wbnbIsToken0: boolean;
  /**
   * The economic minimum rung this pair was admitted on, in quote wei, from
   * `gridShiftEconomics`. `null` means no size is economic at this geometry,
   * which {@link gridShiftSideFloors} turns into an unreachable floor and
   * therefore a refusal.
   */
  readonly minRungWei: bigint | null;
  /** Cycle telemetry, when the deployment wires it. */
  readonly gridCycles?: LpGridCycleStore;
};

/**
 * PHASE3.22 R10/R11 — THE ATOMIC LADDER'S ONE MOTION.
 *
 * ═══ WHAT IT SUBMITS ═══════════════════════════════════════════════════════
 *
 * ONE step, ONE relay batch, all-or-nothing. Two targets use twelve calls:
 *
 * ```text
 *  1-2   buildLpZapOutKeepWbnbBatch(sell rung)  [decreaseLiquidity, collect]
 *  3-4   buildLpZapOutKeepWbnbBatch(buy rung)   [decreaseLiquidity, collect]
 *  5-6   approve(TOKEN, 0), approve(WBNB, 0)    [the R3.5 zero-reset pair]
 *  7-9   buildLpMintWbnbBatch(sell rung)        [approve, approve, mint]
 * 10-12  buildLpMintWbnbBatch(buy rung)         [approve, approve, mint]
 * ```
 *
 * A one-target mid-fill drift omits the untargeted exit and mint trio, keeping
 * both zero-reset approvals: 2 exit + 2 resets + 3 mint = seven calls. The
 * two-target shape is twelve calls against `MAX_CALLS_PER_EXECUTE` (20).
 * `nativeSpendWei` is 0 for the whole step: both mints pay in ERC-20s under
 * exact approves and nothing unwraps, so the motion is native-cap-neutral end
 * to end except for the relay's own gas.
 *
 * THE ORDER IS NORMATIVE (R2.2). Exits before mints, because the funds must be
 * in the wallet before the NFPM pulls them. Sell mint before buy mint, because
 * NFPM ids are sequential and that is what makes `sellTokenId < buyTokenId`
 * true — the only guard against attaching the sell NFT to the buy row, a
 * role/asset inversion every later motion would then compute against.
 *
 * THE ZERO-RESET PAIR (R3.5, as corrected by R4.5 L2). `buildLpMintWbnbBatch`
 * emits a non-zero approve for each leg, so a base token that refuses a
 * non-zero-to-non-zero approve would revert the whole batch at the second
 * mint. The saga PREPENDS `approve(TOKEN, 0)` and `approve(WBNB, 0)` around
 * the UNTOUCHED builders, which is what preserves byte-identity of
 * `buildLpMintWbnbBatch` for the three shipped modes. R4.5 L2 deleted R3.5's
 * "intra-batch WBNB dust window accepted" sentence as unreachable: the sell
 * mint's WBNB approve is itself the zero one, so the buy mint's non-zero WBNB
 * approve always follows a zero. The pair stays for the BASE token, which is
 * the one an operator cannot vouch for.
 *
 * TWO RECORDED CONSEQUENCES of that shape, carried from R2.2 verbatim: the
 * leftover-allowance residual (`src/ops/nfpm.ts`) now recurs on EVERY motion,
 * and each approve is metered against the per-token cap — so an owner with a
 * finite token cap gets a shift agent that stops at the cap.
 *
 * ═══ WHY ONE STEP, AND WHAT THAT COSTS ═════════════════════════════════════
 *
 * The collapse of the ladder's four submissions into one IS the phase: it
 * divides the modeled relay cost by four without touching the constant, and it
 * deletes the half-moved-ladder state that 3.20's stranding bound, mismatch
 * clock and last-slot arbitration all exist to bound. There is no second
 * submission to owe, so `recoveryAfterConfirm: "pending-mint"` is WRONG here
 * and MUST NOT be used.
 *
 * What it costs is that the sequence has no intermediate state to reason
 * about, so its AMBIGUOUS states needed doors built for them:
 *
 *  - `recoveryAfterConfirm: "shift-ambiguous"` plus
 *    `markRecoveryBeforeSubmit`, so the marker is durable BEFORE the submit
 *    and every ambiguous park writes `held` rather than the unabandonable
 *    `active` + `none` (R4.1 — REVIEW3's blocker P1);
 *  - a declared-ambiguity abandon for a NON-SETTLED step row, which closes
 *    both arm-group rows and names both prior tokenIds (R5.1);
 *  - a two-tier abandon for a COMMITTED one, whose tier 2 opens only once the
 *    3.11 stall latch has quiesced the row (R4.3) — which is exactly why every
 *    position write below lives in the step's `after` hook and NOT in
 *    `input.finish` (R5.4(a)): a throw out of `input.finish` escapes
 *    `driveSequence` unguarded, produces no result, records no stall, and tier
 *    2 would never open.
 *
 * ═══ THE AUTHORITY GUARD (R8, C4/M-B3 placement) ═══════════════════════════
 *
 * Every PRESENT target and the shift cause are PERSISTED, and that persisted
 * one-or-two-target shape WINS. A run handed a disagreeing shape, range, or
 * cause THROWS — HERE, inside the run function, before any call is built.
 */
export async function runLpGridShift(
  deps: LpGridShiftDeps,
  positionId: string,
): Promise<LpSagaRunResult> {
  const buyTarget = deps.targetBuyRange;
  const sellTarget = deps.targetSellRange;
  const targets = ([
    ...(sellTarget === undefined ? [] : [{ role: "sell" as const, range: sellTarget }]),
    ...(buyTarget === undefined ? [] : [{ role: "buy" as const, range: buyTarget }]),
  ] as const);
  if (targets.length === 0) {
    throw new Error("runLpGridShift: both persisted target ranges are absent.");
  }
  for (const { role: name, range } of targets) {
    if (
      !Number.isInteger(range.tickLower)
      || !Number.isInteger(range.tickUpper)
      || range.tickUpper <= range.tickLower
    ) {
      throw new Error(
        `runLpGridShift: the persisted ${name} target range is inverted or empty.`,
      );
    }
  }
  const position = await requirePosition(deps, positionId, "entry");
  const owner = deps.agent.ownerAddress;
  const agentId = deps.agent.id;

  // ─── R8's PRECEDENCE RULE, ENFORCED AT THIS SEAM ────────────────────────
  //
  // The 3.18 C4 shape, doubled because a shift authorizes two rungs. A `deps`
  // value that disagrees with a persisted one is a programming error on the
  // resume path: THROW, never silently prefer either. Placed inside the run
  // function rather than in `buildGridShiftDeps` deliberately (C4/M-B3) — the
  // audit's named mutation is "delete the guard", and it must die at the SAGA
  // seam, where the money is, rather than in a worker helper.
  const existing = await deps.store.getNonTerminalSequence(owner, agentId, positionId);
  if (existing !== null && existing.kind === "grid-shift") {
    const persisted = [
      ["buy", existing.targetTickLower, existing.targetTickUpper, buyTarget],
      ["sell", existing.targetSellTickLower, existing.targetSellTickUpper, sellTarget],
    ] as const;
    for (const [name, lower, upper, handed] of persisted) {
      if ((lower === null) !== (upper === null)) {
        throw new Error(
          `Shift sequence ${existing.sequenceId} carries a partial persisted ${name} target range; it will not be guessed or re-derived.`,
        );
      }
      const persistedPresent = lower !== null && upper !== null;
      if (persistedPresent !== (handed !== undefined)) {
        throw new Error(
          `Shift sequence ${existing.sequenceId} persisted ${persistedPresent ? "a" : "no"} ${name} target but this run was handed ${handed === undefined ? "none" : "one"}; NULL means untouched and the persisted shape wins.`,
        );
      }
      if (handed !== undefined && (lower !== handed.tickLower || upper !== handed.tickUpper)) {
        throw new Error(
          `Shift sequence ${existing.sequenceId} persisted a ${name} target [${lower}, ${upper}) but this run was handed [${handed.tickLower}, ${handed.tickUpper}). The PERSISTED target wins and is never overwritten; a disagreeing recomputation is refused rather than acted on (PHASE3.22 R8).`,
        );
      }
    }
    const persistedCause = existing.shiftCause ?? "unknown";
    if (persistedCause !== deps.cause) {
      throw new Error(
        `Shift sequence ${existing.sequenceId} persisted cause ${persistedCause} but this run was handed ${deps.cause}; the persisted cause wins (PHASE3.23 R3.2).`,
      );
    }
  }

  const legs = poolLegs(position, deps.venue.wbnb);
  const wbnb = deps.venue.wbnb;
  const rowFor = (role: LpGridRole): LpGridShiftRow | undefined =>
    deps.rows.find((row) => row.role === role);
  const targetFor = (role: LpGridRole): { tickLower: number; tickUpper: number } => {
    const target = role === "buy" ? buyTarget : sellTarget;
    if (target === undefined) throw new Error(`Grid shift ${role} target is absent.`);
    return target;
  };
  const targetedRoles = targets.map(({ role }) => role);

  /**
   * BUILD-SCOPED ONLY, and deliberately nothing else lives here.
   *
   * AUDIT A1: this object used to also carry `mintRoles`/`exitedRoles` for
   * `after` to read, which made the finish UNRUNNABLE on the replay path —
   * `driveSequence` calls `after` for a recorded COMMITTED step WITHOUT
   * running `build`, so those fields were always `undefined` on a resume and
   * the hook threw for ever. The finish now derives role attribution from the
   * PERSISTED target ranges and the receipt alone, so **`after` reads no build
   * state at all** and this object is confined to the two freed-leg
   * accumulators the funding recompute needs INSIDE `build`.
   *
   * Keep it that way: anything `after` needs must be durable or derivable, not
   * remembered.
   */
  const state: {
    freedWbnbWei: bigint;
    freedTokenWei: bigint;
  } = { freedWbnbWei: 0n, freedTokenWei: 0n };

  const plan: readonly PlannedStep[] = [
    {
      kind: "grid-shift",
      // The motion RE-DEPLOYS: it frees two rungs and mints one or two back, so
      // the batch as a whole is not exposure-reducing even though its first
      // four calls are. Classified on the whole batch's effect, which is the
      // only honest reading of a batch that does both.
      reducesExposure: false,
      // R5.2 site 6 — the SAME value the pre-submit write uses, so a
      // POST_VERIFY_FAILED after the mints also parks `held`. R5.4's tier-2
      // abandon depends on exactly that.
      recoveryAfterConfirm: "shift-ambiguous",
      // R4.1 / R5.3 — durable BEFORE the submit. Without it every ambiguous
      // park of this one-step plan lands `active` + `none`: unabandonable,
      // unclaimable, and invisible to the stall latch.
      markRecoveryBeforeSubmit: true,
      build: async (ctx) => {
        // PHASE3.23 REVIEW2 N2 / R3.2: CREATE precedes build, so this check
        // covers fresh dispatch and resume before any wallet call is built.
        // Submitted/committed replay bypasses build and remains untouched.
        const authoritative = await deps.store.getNonTerminalSequence(owner, agentId, positionId);
        if (authoritative === null || authoritative.kind !== "grid-shift") {
          throw new Error("Grid shift build cannot locate its persisted sequence authority.");
        }
        const persistedCause = authoritative.shiftCause ?? "unknown";
        if (persistedCause !== deps.cause) {
          throw new Error(
            `Shift sequence ${authoritative.sequenceId} persisted cause ${persistedCause} but the build was handed ${deps.cause}; no call is constructed.`,
          );
        }
        if (persistedCause === "unknown") {
          throw new Error(
            `Shift sequence ${authoritative.sequenceId} has no persisted shift_cause; a never-submitted legacy row cannot authorize a fresh build.`,
          );
        }
        for (const { role, range } of targets) {
          const [lower, upper] = role === "buy"
            ? [authoritative.targetTickLower, authoritative.targetTickUpper]
            : [authoritative.targetSellTickLower, authoritative.targetSellTickUpper];
          if (lower !== range.tickLower || upper !== range.tickUpper) {
            throw new Error(
              `Shift sequence ${authoritative.sequenceId} no longer authorizes its handed ${role} target; no call is constructed.`,
            );
          }
        }

        // PHASE3.23 R3.1 / FINDINGS (be): drift may never zap a targeted
        // source rung while the fresh tick is inside it. Untargeted rows never
        // veto, and cross-caused settlement is exempt.
        if (persistedCause === "drift") {
          for (const role of targetedRoles) {
            const row = rowFor(role);
            if (row === undefined || row.tokenId === null) continue;
            const source = await deps.positions(BigInt(row.tokenId));
            if (
              source !== "burned"
              && source.tickLower <= ctx.market.currentTick
              && ctx.market.currentTick < source.tickUpper
            ) {
              throw new Error(
                `Grid shift G0 refused: fresh tick ${ctx.market.currentTick} is inside targeted ${role} source [${source.tickLower}, ${source.tickUpper}) (PHASE3.23 R3.1; FINDINGS (be)).`,
              );
            }
          }
        }
        // ── The two zap-outs, SELL rung then BUY rung ────────────────────
        //
        // The exits' relative order is not load-bearing (they are independent
        // and touch different NFTs); it matches the mints' pinned order only so
        // the batch reads against the spec's own listing.
        const calls: WalletCall[] = [];
        const exitedRoles: LpGridRole[] = [];
        for (const role of targetedRoles) {
          const row = rowFor(role);
          if (row === undefined || row.tokenId === null) continue;
          const tokenId = BigInt(row.tokenId);
          const snapshot = await deps.positions(tokenId);
          // R10's SKIP SEMANTICS, INSIDE the step: a rung already burned or
          // holding no liquidity contributes no exit calls — and that does NOT
          // skip the whole step, because the OTHER rung may still need moving
          // and the mints are the point of the motion.
          if (snapshot === "burned" || snapshot.liquidity <= 0n) continue;
          const floors = sagaDecreaseFloors({
            sqrtPriceX96: ctx.market.spotSqrtPriceX96,
            tickLower: snapshot.tickLower,
            tickUpper: snapshot.tickUpper,
            liquidity: snapshot.liquidity,
            maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
          });
          // KEEP-WBNB, for the rotate/flip/requote reason: the mints pay both
          // legs as ERC-20s under exact approves, so the motion is
          // native-cap-neutral except relay gas. Unwrapping would meter the
          // principal against the native cap on EVERY shift — and a shift is
          // the motion this phase makes frequent, so the (ah)-shaped trap
          // would bite harder here than anywhere else in the tree.
          calls.push(
            ...buildLpZapOutKeepWbnbBatch({
              nfpm: deps.venue.nfpm,
              tokenId,
              liquidity: snapshot.liquidity,
              amount0MinWei: floors.amount0Min,
              amount1MinWei: floors.amount1Min,
              deadline: ctx.deadline,
              wallet: deps.agent.walletAddress,
            }),
          );
          exitedRoles.push(role);
          // The freed legs, in POOL ORDER. These are the DECREASE FLOORS and
          // not measured amounts, because the batch has not run: a conservative
          // lower bound is the only honest figure here, and it is exactly the
          // figure `gridShiftFunding` was specified to take.
          state.freedWbnbWei += legs.wbnbIsToken0 ? floors.amount0Min : floors.amount1Min;
          state.freedTokenWei += legs.wbnbIsToken0 ? floors.amount1Min : floors.amount0Min;
        }
        if (calls.length === 0) {
          throw new Error(
            "No rung of this shift ladder holds liquidity to move; nothing is submitted.",
          );
        }

        // ── R4.2.1 / P8 — THE FUNDING RECOMPUTE, AS THE FAIL-CLOSED BELT ──
        //
        // The trigger already ran THIS FUNCTION with the worker's balance
        // reads. Running it again is not a second authority: it is the same
        // authority against fresher facts, because price and balances move
        // between the trigger and the build, and the build is the last honest
        // moment before the calls are bound.
        const readBalance = deps.walletTokenBalance;
        if (readBalance === undefined) {
          // The 3.19 charter's fail-closed posture verbatim: a mechanism whose
          // whole job is to size a mint from the buffer must never degrade to
          // sizing it from something else.
          throw new Error(
            "This deployment has no wallet balance reader, so a shift's mint sizes cannot be computed; the motion refuses rather than guessing a size.",
          );
        }
        const sideFloors = gridShiftSideFloors({
          minRungWei: deps.minRungWei,
          spotSqrtPriceX96: ctx.market.spotSqrtPriceX96,
          wbnbIsToken0: deps.wbnbIsToken0,
        });
        const funding = gridShiftFunding({
          deployPctBps: deps.shift.deployPctBps,
          // R2.5: an untargeted rung is outside this motion's funding
          // authority. Do not even consume its balance read; NULL means
          // untouched all the way from trigger shape through the build.
          idleQuoteWei: targetedRoles.includes("buy")
            ? await readBalance(wbnb)
            : undefined,
          idleBaseWei: targetedRoles.includes("sell")
            ? await readBalance(legs.token)
            : undefined,
          freedQuoteWei: state.freedWbnbWei,
          freedBaseWei: state.freedTokenWei,
          quoteFloorWei: sideFloors.quoteFloorWei,
          baseFloorWei: sideFloors.baseFloorWei,
          targetRoles: targetedRoles,
        });
        if (funding.hold) {
          // R10: a batch that would contain NO mint call is a REFUSAL, never a
          // submission — the motion must never be a pure withdrawal. Throwing
          // at plan position 0 of a freshly created sequence is the zero-money
          // terminal ROLLBACK (`confirmedMoney === 0`), which is what the
          // trigger-level hold normally prevents reaching at all.
          throw new Error(lpGridShiftFundingHoldReason({ funding }));
        }

        // ── R9's G-GATE, AT THE MINT BUILD ──────────────────────────────────
        //
        // The trigger's own G-gate ran against an observation; this one runs
        // against FRESH evidence immediately before the calls are built, which
        // is the standing money-build discipline. It THROWS, and the throw IS
        // the zero-money terminal rollback — the same mechanism PHASE3.12 Part
        // 1's G2 uses at `collect-fees.build`, cited here so nobody "improves"
        // it into a hold. A held shift freezes BOTH rungs and disarms both
        // price stops, which is far too much blast radius for a target that has
        // merely gone stale; a rollback re-triggers on a later cycle.
        //
        // ONE SHARED REFUSAL BUILDER with the trigger (`lpGridShiftRefusal`),
        // so route and worker text cannot diverge — the `lpGridArmRefusal`
        // pattern R9 names.
        const mintRoles: LpGridRole[] = [];
        const mintCalls: WalletCall[] = [];
        for (const role of targetedRoles) {
          const side = role === "sell" ? funding.sell : funding.buy;
          if (!side.fundable) continue;
          const target = targetFor(role);
          // The target must strictly EXCLUDE the current tick with one-spacing
          // clearance, and the side it implies must be the side this role
          // charges. `gridTargetSide` answers the first; `gridSideChargesQuote`
          // answers the second, in POOL ORDER — never from "above/below" read
          // as a direction, which inverts on every pool where WBNB is token0.
          const targetSide = gridTargetSide(ctx.market.currentTick, target);
          if (targetSide === undefined) {
            throw new Error(
              lpGridShiftRefusal({
                where: "mint",
                failed: "in-range",
                role,
                currentTick: ctx.market.currentTick,
                range: target,
              }),
            );
          }
          const chargesQuote = gridSideChargesQuote(targetSide, deps.wbnbIsToken0);
          if (chargesQuote !== (role === "buy")) {
            throw new Error(
              lpGridShiftRefusal({
                where: "mint",
                failed: "side",
                role,
                currentTick: ctx.market.currentTick,
                range: target,
              }),
            );
          }
          // The mint is SINGLE-SIDED by construction: a range that strictly
          // excludes the tick takes exactly one asset, which is what makes the
          // whole motion swap-free (the buffer funds each side in its own
          // asset — decision 2 removed the hedge, and the arm's 50/50 split
          // plus proportional sizing make a balancing swap unnecessary).
          const amount0 = chargesQuote === deps.wbnbIsToken0 ? side.plannedMintWei : 0n;
          const amount1 = chargesQuote === deps.wbnbIsToken0 ? 0n : side.plannedMintWei;
          const liquidity = getLiquidityForAmounts(
            ctx.market.spotSqrtPriceX96,
            target.tickLower,
            target.tickUpper,
            amount0,
            amount1,
          );
          if (liquidity <= 0n) {
            throw new Error(
              lpGridShiftRefusal({
                where: "mint",
                failed: "dust",
                role,
                currentTick: ctx.market.currentTick,
                range: target,
              }),
            );
          }
          const floors = sagaSingleSidedMintFloors({
            sqrtPriceX96: ctx.market.spotSqrtPriceX96,
            tickLower: target.tickLower,
            tickUpper: target.tickUpper,
            liquidity,
            maxSagaSlippageBps: deps.rails.maxSagaSlippageBps,
            side: targetSide,
          });
          mintCalls.push(
            ...buildLpMintWbnbBatch({
              nfpm: deps.venue.nfpm,
              token0: position.token0,
              token1: position.token1,
              wbnb,
              fee: position.fee,
              tickLower: target.tickLower,
              tickUpper: target.tickUpper,
              amount0DesiredWei: amount0,
              amount1DesiredWei: amount1,
              amount0MinWei: floors.amount0Min,
              amount1MinWei: floors.amount1Min,
              recipient: deps.agent.walletAddress,
              deadline: ctx.deadline,
            }),
          );
          mintRoles.push(role);
        }
        if (mintRoles.length === 0) {
          // Unreachable given `funding.hold` above, but a batch of pure
          // withdrawals is the one thing R10 forbids outright, so it is refused
          // structurally rather than relied upon not to happen.
          throw new Error(
            "A grid shift would submit no mint call; the motion must never be a pure withdrawal.",
          );
        }

        // ── R3.5's ZERO-RESET PAIR, between the exits and the first mint ────
        //
        // Assembled by the SAGA around the untouched builders, which is what
        // keeps `buildLpMintWbnbBatch` byte-identical for the three shipped
        // modes. See the function header for why the BASE token needs it and
        // why R4.5 L2 proved the WBNB dust window unreachable.
        calls.push(
          buildApprove(legs.token, deps.venue.nfpm, 0n),
          buildApprove(wbnb, deps.venue.nfpm, 0n),
          ...mintCalls,
        );
        // AUDIT A1: the mint set is NOT stashed for `after` to read. It is
        // recoverable from the persisted targets and the receipt, and stashing
        // it is what made the finish un-replayable.
        void exitedRoles;
        return { action: "submit", calls };
      },
      // ═══ R5.4(a) — EVERY POSITION WRITE LIVES HERE, IN `after` ════════════
      //
      // NOT in `input.finish`. A throw out of `input.finish` escapes
      // `driveSequence` entirely (`sagas.ts`: `if (input.finish !== undefined)
      // await input.finish(sequenceId);` is unguarded) — no result is
      // produced, no stall is recorded, the row stays `held` with its marker,
      // and R4.3's tier-2 abandon NEVER OPENS. A throw out of `after` becomes
      // `holdSequence("POST_VERIFY_FAILED")`, which the worker latches, and
      // three identical stalls quiesce the row so the owner's abandon can
      // claim it. The difference between the two hooks is the difference
      // between a doorless state and a recoverable one.
      after: async (txHash, _feeReplay, feeCtx) => {
        try {
        if (txHash === undefined) {
          throw new Error("A grid shift cannot be skipped.");
        }
        const readIds = deps.receipts.mintedTokenIds;
        if (readIds === undefined) {
          // FAIL-CLOSED, the 3.17 R2.13 posture: hold rather than guess which
          // NFT belongs to which side. A guess here is a role/asset inversion
          // every later motion computes against.
          throw new Error(
            "Post-step verification failed: this deployment's receipt reader cannot report minted tokenIds, so the shift's rows are held rather than paired by guess.",
          );
        }
        const ids = await readIds.call(deps.receipts, txHash);
        if (targets.length === 1 && ids.length !== 1) {
          throw new Error(
            `Post-step verification failed: a one-target shift requires exactly one minted tokenId, got ${ids.length}.`,
          );
        }
        if (targets.length === 2 && (ids.length < 1 || ids.length > 2)) {
          throw new Error(
            `Post-step verification failed: a two-target shift requires one or two minted tokenIds, got ${ids.length}.`,
          );
        }

        // ══ AUDIT A1 — ROLE ATTRIBUTION IS DERIVED FROM THE PERSISTED
        //    TARGETS, NOT FROM BUILD-SCOPED STATE ═══════════════════════════
        //
        // THE DEFECT THIS REPLACES, because the shape is easy to reintroduce:
        // this hook used to read `state.mintRoles`, a closure variable ONLY
        // `build` populates. On the REPLAY path `driveSequence` calls
        // `step.after(txHash, true, …)` for a recorded COMMITTED step WITHOUT
        // running `build` — so every resume across a process boundary, and
        // every resume after a transient RPC failure inside this very hook,
        // constructed a fresh `runLpGridShift` with `mintRoles === undefined`
        // and threw "recorded no mint set" DETERMINISTICALLY, for ever. One
        // RPC hiccup during the liquidity verification turned a landed batch
        // into a permanent hold whose only door was the tier-2 abandon — which
        // discards the plane's account of two freshly minted NFTs and sends the
        // owner to PancakeSwap by hand. That contradicted R2.26, the tier-1
        // refusal's own text, and this hook's own docstring.
        //
        // THE FIX NEEDS NO NEW COLUMN. Both target ranges are already durable
        // on the sequence row (R8) and are already the authority guard's own
        // data; each minted NFT's `positions()` snapshot carries its ticks. So
        // a role is attributed by EXACT RANGE MATCH — the same equality the
        // authority guard uses — and the attribution is a pure function of
        // durable state plus the receipt. `build` state is now used by this
        // hook for nothing at all.
        //
        // BIJECTION OR REFUSE. An id matching neither target, two ids matching
        // the same target, or a target claimed twice is a receipt that does not
        // describe the batch this row authorized: fail-closed hold, never a
        // guessed pairing.
        const sameRange = (
          a: { readonly tickLower: number; readonly tickUpper: number },
          b: { readonly tickLower: number; readonly tickUpper: number },
        ): boolean => a.tickLower === b.tickLower && a.tickUpper === b.tickUpper;

        // ── VERIFY EVERY ID, THEN WRITE BOTH (R2.26 / the 3.17 rule) ───────
        //
        // Every new NFT is checked for liquidity AND attributed BEFORE any row
        // is touched, so a receipt that names a dud never produces a
        // half-written pair.
        const minted = new Map<LpGridRole, bigint>();
        for (const tokenId of ids) {
          const snapshot = await deps.positions(tokenId);
          if (snapshot === "burned" || snapshot.liquidity <= 0n) {
            throw new Error(
              `Post-step verification failed: the shift's mint of ${tokenId.toString(10)} confirmed but the new position reports no liquidity.`,
            );
          }
          const role: LpGridRole | undefined = sellTarget !== undefined && sameRange(snapshot, sellTarget)
            ? "sell"
            : buyTarget !== undefined && sameRange(snapshot, buyTarget)
              ? "buy"
              : undefined;
          if (role === undefined) {
            throw new Error(
              `Post-step verification failed: minted position ${tokenId.toString(10)} sits at [${snapshot.tickLower}, ${snapshot.tickUpper}), which equals NEITHER persisted target range; the rows are held rather than paired against a receipt that does not describe this motion.`,
            );
          }
          if (minted.has(role)) {
            throw new Error(
              `Post-step verification failed: two minted positions both sit at the persisted ${role} target range; the attribution is not a bijection and the rows are held rather than paired by guess.`,
            );
          }
          minted.set(role, tokenId);
        }
        if (minted.size === 0) {
          throw new Error(
            "Post-step verification failed: the shift confirmed but the receipt names no mint the persisted targets can account for.",
          );
        }
        if (targets.length === 2 && minted.size === 2) {
          const sellTokenId = minted.get("sell");
          const buyTokenId = minted.get("buy");
          // The 3.17 L1 belt, carried verbatim and now STRONGER than the
          // positional version it replaces: it no longer merely restates the
          // receipt's own order, it cross-checks the RANGE attribution against
          // NFPM `_nextId` monotonicity. The SELL mint is first in the pinned
          // batch, so a sell id above the buy id means the batch's call order
          // and the ranges disagree — the one way the two rows could be given
          // each other's NFT.
          if (
            sellTokenId === undefined
            || buyTokenId === undefined
            || !(sellTokenId < buyTokenId)
          ) {
            throw new Error(
              "Post-step verification failed: the shift's two minted tokenIds are not in the pinned mint order (sell then buy); the rows are held rather than paired against a monotonic id that disagrees.",
            );
          }
        }

        // ── THE WRITES ────────────────────────────────────────────────────
        //
        // IDEMPOTENTLY RE-RUNNABLE (R2.26 as clarified): a crash between them
        // leaves one row fresh and one stale, and the resume re-enters this
        // same hook via the replay path, re-reads the receipt through the
        // journal's txHash, re-verifies both ids, finds the first row already
        // current (tolerated — the write is a no-op) and applies the second.
        for (const role of targetedRoles) {
          const row = rowFor(role);
          const tokenId = minted.get(role);
          if (tokenId !== undefined) {
            if (row === undefined) {
              // R4.2.3 — THE DORMANT SIDE RE-OPENS. Its funding recovered above
              // the floor, so this batch minted it a rung and it needs a row
              // again. Same arm group, same role, lineage carried from the
              // pair, `basisWei: 0n` / `basisSource: "minted"`.
              //
              // This is the self-cure §10's "3.21 is subsumed for shift rows"
              // claim rests on: the surviving side's fills deliver the depleted
              // asset back to the buffer — a sell fill delivers quote, a buy
              // fill delivers base — so one-sidedness corrects itself whenever
              // price crosses the surviving rung, with no owner action.
              const lineageId = deps.rows[0]?.lineageId;
              if (lineageId === undefined) {
                throw new Error(
                  "Post-step verification failed: the shift minted a dormant side but the pair carries no lineage to inherit.",
                );
              }
              await createPositionForArmGroup(deps.store, {
                positionId: `${deps.armGroupId}:${role}:${tokenId.toString(10)}`,
                agentId,
                ownerAddress: owner,
                token0: position.token0,
                token1: position.token1,
                fee: position.fee,
                quoteToken: wbnb,
                armGroupId: deps.armGroupId,
                gridRole: role,
                lineageId,
              });
              await deps.store.updatePositionTokenId(
                owner,
                agentId,
                `${deps.armGroupId}:${role}:${tokenId.toString(10)}`,
                tokenId.toString(10),
              );
              continue;
            }
            // The row is RE-POINTED at its new NFT, exactly as the flip, the
            // rotate and the requote re-point theirs, so one row never holds
            // two live tokenIds. NO `gridRole` ARGUMENT (H5 / R2.13): a shift's
            // roles are INVARIANT, so writing the role here would be a second
            // authority saying the same thing — and the one place a role
            // actually changes is the flip.
            await deps.store.updatePositionTokenId(
              owner,
              agentId,
              row.positionId,
              tokenId.toString(10),
            );
            continue;
          }
          // ── THE DORMANT CLOSE (R4.2.2) ──────────────────────────────────
          //
          // This side was below its single-sided floor, so the batch exited its
          // rung and minted nothing back. Its principal is in the buffer and
          // the row has no NFT, so it is CLOSED rather than parked as a
          // null-tokenId zombie — the shape REVIEW2 refuted and R4.2 replaced.
          //
          // Closing is what the one-live-token index, the worker loop, the arm
          // gate and the abandon path ALL already handle: a closed row leaves
          // both index predicates, is skipped by the worker, and does NOT block
          // a re-arm (the arm gate refuses on non-closed rows only). No store
          // seam is invented for a half-alive row.
          //
          // `closeReason` records WHY, for the owner view's benefit — R4.2.4
          // requires the view to distinguish depletion from an ownership close
          // and from an owner's single-rung manual exit, and depletion was the
          // one cause with no marker.
          if (row !== undefined && row.tokenId !== null) {
            await deps.store.setPositionState(
              owner,
              agentId,
              row.positionId,
              "closed",
              undefined,
              "shift-depleted",
            );
          }
        }
        } finally {
          await recordLpFeeEvents({ deps, ctx: feeCtx, txHash, position, associations: deps.rows });
        }
      },
    },
  ];

  return driveSequence({
    deps,
    kind: "grid-shift",
    position,
    plan,
    // PHASE3.23 R3.4: persist only present roles. NULL means untouched.
    ...(buyTarget === undefined ? {} : { targetRange: buyTarget }),
    ...(sellTarget === undefined ? {} : { targetSellRange: sellTarget }),
    ...(deps.cause === "unknown" ? {} : { shiftCause: deps.cause }),
    ...(deps.cause === "drift" && gridShiftDriftMotionsPerDay(deps.shift) === 0
      ? { zeroDriftResume: true }
      : {}),
  });
}
