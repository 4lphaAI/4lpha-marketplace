/** One bounded autonomous trading pass (TRADING-AGENT R3.8 / C31). */
import { randomUUID } from "node:crypto";
import { decodeAbiParameters, keccak256, stringToBytes, type Address, type Hex } from "viem";
import type { ExecutionReceipt, SpendInfoReading, WalletCall, WalletProvider } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import type { TradeRequest } from "../http/wire.js";
import type { ScanGate } from "../rules/scanGate.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal, JournalEntry } from "../store/journal.js";
import type { TradeCloseReason, TradeCrashEvidenceAction, TradeEvidenceExpected, TradePositionRecord, TradePositionStore } from "../store/tradePositions.js";
import type { TradeIntentRecord, TradeIntentStore } from "../store/tradeIntents.js";
import type { TradeSettingsRecord, TradeSettingsStore } from "../store/tradeSettings.js";
import type { SqlClient } from "../store/sql.js";
import { grantsTokenSell } from "../ops/policy.js";
import { applySlippageFloorWei, decideExit, hasBlankThreshold, pnlBps, RUG_QUOTE_WINDOW_MS, SESSION_ENTRY_CUTOFF_MS, SESSION_EXIT_LEAD_MS, type ExitEvidence } from "./exits.js";
import {
  buildEntryPrompt,
  buildExitPrompt,
  enteredIndexes,
  validateEntryResponse,
  validateExitResponse,
  type LlmDataRequest,
  type TradeLlm,
  type OpenRouterMessage,
} from "./llm.js";
import {
  quoteBestBuyRoute,
  quoteBestTradfiBuy,
  quoteBestTradfiSell,
  createRouteQuoteReader,
  TradeRouteQuoteError,
  quoteSellAlongRoute,
  USDT_56,
  USDC_56,
  type BestBuyRoute,
  type RouteQuoteReader,
  type TradeVenueId,
  type TradfiQuote,
} from "./route.js";
import type { TradeRoute, V3FeeTier } from "../ops/route.js";
import { isTradfiV2Settings, isTradfiAiSettings, isTradeDcaSettings, isTradeScheduleSettings, isTradePortfolioSettings, parseTradeSettings, type EffectiveTradeSettings } from "./settings.js";
import type { FinalizedSessionRevocationVerdict } from "../account/keyStoreReader.js";
import { inertDispositionEvidence, isInertSubmissionCandidate, isInertTradeSubmission } from "./inertSubmission.js";
import { PORTFOLIO_PLATFORM_FEE_BPS, portfolioStockValue } from "./portfolio.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import type { DcaActionRow, DcaActionState, DcaOrderRow, DcaRoundInsert, DcaRoundRow, DcaRoundStore } from "../store/dcaRounds.js";
import { getAmountsForLiquidity } from "../lp/tickMath.js";
import { gridTargetSide } from "../lp/gridTriggers.js";
import { WBNB_56 } from "../ops/venues.js";
import { hashCalls } from "../http/wire.js";
import { freshNativeCostFacts, nativeCostToUsdtAtomic } from "./cost.js";
import { DCA_NFPM_COLLECT_TOPIC, verifyDcaReceipt, type DcaReceiptEvidence, type TradfiV2ReceiptReader } from "./receipt.js";
import { DCA_HOLD_CODES, dcaIdempotencyKey, type DcaExecuteInput, type DcaExecuteResult } from "./dcaExecute.js";
import { recordSimulationActual, type TradfiEvidenceWriter } from "./simulate.js";
import { DCA_LOG_WINDOW_BLOCKS, DCA_NOT_LANDED_MIN_AGE_MS, dcaChainPositions, dcaUnknownEvidence, type DcaChainReads } from "./dcaResolve.js";
import { assessTradeUnknown, type TradeUnknownReads } from "./unknownResolve.js";
import {
  DCA_DUST_USDT_WEI,
  DCA_GUARD_EXPIRED_UNMERGE,
  DCA_MAX_EXITS_PER_BATCH,
  DCA_PLATFORM_FEE_BPS,
  dcaAdvanceCounter,
  dcaAhead,
  dcaApplyExit,
  dcaBatchCalls,
  dcaBilledNativeWei,
  dcaCounterConfirmed,
  dcaEquityWei,
  dcaLevelPrice,
  dcaLevelRange,
  dcaLevelVerdict,
  dcaMidPrice,
  dcaOrderReadsFilled,
  dcaPoolForToken,
  dcaPoolLegs,
  dcaPriceRangeHold,
  dcaR0Gas,
  dcaRoundAnchor,
  dcaSettle,
  dcaStartLedger,
  dcaStopLossBreached,
  dcaTriggerMinOutWei,
  dcaUneconomic,
  nextDcaStrategyStep,
  planDcaClose,
  planDcaCloseStart,
  planDcaFill,
  planDcaLevelPlace,
  planDcaRemove,
  planDcaStart,
  planDcaStopLoss,
  planDcaTpPlace,
  type DcaBatchKind,
  type DcaBatchPlan,
  type DcaLedger,
  type DcaLiveOrder,
  type DcaPool,
  type DcaReading,
  type DcaSwapLeg,
} from "./dca.js";
import { canonicalEncode } from "../auth/canonical.js";
import { MAX_TRADE_SESSION_SECONDS, TRADFI_GUARD_SWAP_SELECTOR } from "../ops/policy.js";
import {
  createTradeVerdictCache,
  selectEntryCandidates,
  type EntryCandidate,
  type PinnedPrefilterSummary,
  type TradeVerdictCache,
} from "./universe.js";
import { RWA_MAX_PREMIUM_BPS, rwaEntryVerdict, type RwaFact } from "./rwa.js";
import { admittedVenueRows } from "./rwa.js";
import { freshTokenUsdFact, type TradeDataPlaneReads, type TradfiFlashQuote, type UniverseRow } from "./dataPlaneReads.js";
import type { TradeReadiness } from "./readiness.js";
import { pinnedTokens } from "./view.js";
import { AGENT_GAS_MAX_BACKOFF_MS, agentGasFloor, agentGasReason, classifyAgentGas } from "../ops/gasFloor.js";
import { appendTradeRunEvent, normalizeTradeRunEvents, type TradeRunEvent } from "../store/tradeRunTrace.js";
import { sizeTradeBuy, tradfiV2BuyFeeWei, tradfiV2EntryReservation } from "./sizing.js";
import { rwaMarketClosed } from "./universe.js";
import { currentSlot, scheduleAnchorMs, scheduleLedger, type ScheduleIntervalSec, type ScheduleLedger } from "./schedule.js";
import { enrichFeatures, featurePrompt, assessMomentum, featureModel, describeFeatures, mergeUnderlyingFeatures } from "./features.js";
import { sessionState, SESSION_PROFILES } from "./session.js";
import { evaluateExitTrigger, blendRegime, scoreToken, tradfiExitAllowed, type Regime, type ExitTriggerContext } from "./score.js";
import { entryTimingGate, type EntryTimingMode } from "./entryTiming.js";
import { tradfiPeakImplausible, tradfiRobotExit, type TradfiExitRulesMode } from "./exitRules.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56, TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC, TRADFI_GUARD_MIN_REMAINING_MS, flashRequest } from "./guard.js";
import { RFQ_CONFIRM_DELAY_MS, confirmationGates, isRfqOnlyRow, priorFromStored, rfqAsk, rfqPeak, rfqPeakArgument, rfqQuoteRecord, skipsConfirmation, usablePreviousReading, type RfqReading, type RfqStocksDeps } from "./rfq.js";
import { buildTradfiGuardSwapCall } from "./guard.js";
import { buildTradfiApprove, buildTradfiPancakeV2Swap, buildTradfiPancakeV3Swap, buildTradfiUniswapV3Swap, buildTradfiPlatformFee } from "../ops/tradfi.js";
import type { CmcNewsService } from "./cmcNews.js";
import { GLOBAL_TICKER } from "./cmcNews.js";
import { CMC_GLOBAL_TOOL } from "./cmc.js";
import { parseGlobalMetrics, globalRegime, regimeSizeScale, type CryptoRegime } from "./cmcGlobal.js";
import {
  CMC_SKILL_EVENTS,
  CMC_SKILL_MACRO,
  CMC_SKILL_MACRO_RELEASE,
  CMC_SKILL_PLANNING,
  CMC_SKILL_SCANNER,
  CMC_SKILL_SECTOR,
  classifyLlmDataRequestTicker,
  eventsPromptPart,
  readCompactEvents,
  macroEventRiskUsEquity,
  macroPromptLine,
  marketPromptLine,
  planningValidForPrompt,
  readCompactMacro,
  readCompactPlanning,
  readCompactScanner,
  readCompactSector,
  tickerClass,
  tickerPromptLine,
} from "./cmcUsEquity.js";

export type TradeExecutionMeta = Readonly<Record<string, unknown>>;
export type TradeExecutorFill =
  | { readonly side: "buy"; readonly entryWei: bigint; readonly tokenAmount: bigint | null; readonly fillStatus: "verified" | "unverified"; readonly receiptAttributable?: boolean; readonly verifiedEntryAtomic?: bigint; readonly receiptOwnershipKey?: string }
  | { readonly side: "sell"; readonly exitWei: bigint | null; readonly fillStatus: "verified" | "unverified"; readonly receiptOwnershipKey?: string };

export type TradeExecutorResult =
  | { readonly kind: "denied"; readonly status: number; readonly code: string; readonly message?: string; readonly meta?: TradeExecutionMeta }
  | { readonly kind: "rolled-back"; readonly code: string; readonly meta: TradeExecutionMeta }
  | { readonly kind: "committed"; readonly receipt: ExecutionReceipt; readonly fill: TradeExecutorFill | null; readonly meta: TradeExecutionMeta }
  | { readonly kind: "unknown"; readonly callsId?: Hex; readonly meta: TradeExecutionMeta };

export type TradeExecutorInput = {
  readonly agent: AgentRecord;
  readonly request: TradeRequest;
  readonly scanGate: ScanGate;
  readonly idempotencyKey: Hex;
  readonly paramsHash: Hex;
  readonly signal?: AbortSignal;
  readonly deps: unknown;
};

export interface TradeExecutor {
  execute(input: TradeExecutorInput): Promise<TradeExecutorResult>;
}

export type TradeWorkerCounts = {
  readonly candidates: number;
  readonly refusals: number;
  readonly entries: number;
  readonly exits: number;
  readonly heldNoPrice: number;
};

export type TradeWorkerAgentOutcome = TradeWorkerCounts & {
  readonly agentId: string;
  readonly reason: string;
  readonly dryRun: boolean;
};

export type TradeWorkerReport = {
  readonly skippedNotReady: boolean;
  readonly outcomes: readonly TradeWorkerAgentOutcome[];
};

export type TradeWorkerDeps = {
  /**
   * `transitionAgentStatus` is the worker's first status write, and its only
   * one: the DCA stop loss pauses the agent with the pause route's two writes
   * (AUTO-DCA §7.4, R2.17; REVIEW2 condition 15 — nothing broader).
   */
  readonly agentStore: Pick<AgentStore, "getAgentById" | "transitionAgentStatus">;
  readonly killswitch?: Pick<KillSwitch, "pauseAgent">;
  /** Auto DCA (AUTO-DCA §12, R2.8). Absent ⇒ a DCA agent only holds `dca-disabled`. */
  readonly dca?: TradeWorkerDcaDeps;
  readonly settingsStore: Pick<TradeSettingsStore, "get" | "listTradeAgentsForWorker" | "listTradeAgentsForProjection" | "withEntryFence">;
  readonly positions: Pick<TradePositionStore,
    "get" | "list" | "listOpen" | "open" | "closePosition" | "recordSellRefusal" | "resolveFill" | "recordQuote" | "recordCrashEvidence" | "clearSessionExpiringMarkers" | "incrementNoPrice" | "resetNoPrice" | "markOrphaned" | "insertRun" | "listRuns" | "setExitLlmContext"> & {
      readonly adoptVerifiedEntry?: TradePositionStore["adoptVerifiedEntry"];
      readonly adoptVerifiedExit?: TradePositionStore["adoptVerifiedExit"];
    };
  readonly intents: Pick<TradeIntentStore, "create" | "listUnsettled" | "markSubmitted" | "markProjected" | "markRolledBack" | "listSchedule">
    & Partial<Pick<TradeIntentStore, "get" | "listPortfolio" | "getPortfolioCheck" | "insertPortfolioCheck" | "markPortfolioCheckDone" | "setPortfolioProceeds" | "listProjectedV2" | "disposeInertSell">>;
  /**
   * TRADFI-EXPIRY-KEEP-REMOVE §2: the finalized KeyStore read behind the
   * inert-ambiguous-sell disposal, and the chain/registry that read must be
   * about. Absent ⇒ no disposal (every offline fixture).
   */
  readonly inertSubmission?: {
    readonly chainId: number;
    readonly keyStore: Address;
    readonly read: (input: { readonly wallet: Address; readonly keyId: Hex; readonly publicKey: Hex; readonly signal?: AbortSignal }) => Promise<FinalizedSessionRevocationVerdict>;
  };
  readonly portfolioEnabled?: boolean;
  /** TRADFI-ENTRY-TIMING: the daemon's `TRADFI_ENTRY_TIMING_MODE`; absent means off (offline fixtures stay unchanged). */
  readonly entryTimingMode?: EntryTimingMode;
  readonly journal: Pick<ExecutionJournal, "get"> & { readonly sumPendingQuoteSpendSince?: ExecutionJournal["sumPendingQuoteSpendSince"]; readonly markCommitted?: ExecutionJournal["markCommitted"];
    readonly advanceUnknown?: ExecutionJournal["advanceUnknown"]; readonly resolveUnknown?: ExecutionJournal["resolveUnknown"] };
  readonly unknownReads?: TradeUnknownReads;
  readonly dataPlane: TradeDataPlaneReads;
  readonly provider: Pick<WalletProvider, "getTokenBalance" | "readSpendInfos" | "getTokenMetadata">;
  /**
   * One client per model id. The settings carry a primary and a distinct
   * fallback (operator, 2026-09-03), so the worker resolves both per agent
   * rather than holding a single daemon-wide client.
   */
  readonly llmFor: (modelId: string) => TradeLlm;
  /**
   * The daemon-wide override (TRADE_LLM_MODEL / TRADE_LLM_FALLBACK_MODEL): when
   * set it replaces every agent's primary — and, with a fallback slot, its
   * fallback — so the operator who pays the router key bounds the models
   * (2026-09-16: two slots, so an override keeps a real fallback).
   */
  readonly modelOverride?: { readonly primary: string; readonly fallback?: string };
  readonly executor: TradeExecutor;
  readonly executorDeps: unknown;
  readonly readiness: Pick<TradeReadiness, "ready" | "allowlistAvailable" | "bstocksAddresses">;
  readonly rpcUrls: readonly string[];
  readonly uniswapRouter?: Address;
  /** The configured Flash guard (R2.6/R3.3): absent ⇒ every Flash call site is skipped. */
  readonly aggregatorGuard?: Address;
  /** TRADFI-EXIT-RULES §3: read once at worker start; absent ⇒ `off` (every offline fixture). */
  readonly tradfiExitRulesMode?: TradfiExitRulesMode;
  readonly knownRwaAddresses?: Set<string>;
  /** The same boot-resolved percentage used by the executor's fee policy. */
  readonly platformFeeBps: number;
  /** Remaining CMC exposure reserved from the same wallet, supplied by the CMC service. */
  readonly v2DataBudgetReservedWei?: (agent: AgentRecord) => Promise<bigint>;
  /** Read-only cached CMC context; payment/refresh stays in the service owner. */
  readonly cmcNews?: Pick<CmcNewsService, "getFresh">;
  readonly refreshCmcNews?: (input: {
    readonly agent: AgentRecord;
    readonly heldTickers: readonly string[];
    readonly shortlistedTickers: readonly string[];
    readonly nowMs: number;
    readonly signal?: AbortSignal;
    /** TRADFI-LLM-CMC-REQUEST R2.1.1: worker-mapped index-free paid data requests. */
    readonly llmRequests?: readonly {
      readonly ticker: string;
      readonly skill: "planning" | "events";
      readonly reason: string;
      readonly source: "entry" | "exit";
      readonly model: string;
    }[];
  }) => Promise<void>;
  readonly tradfiNativeCostUsdtAtomic?: (input: { readonly agent: AgentRecord; readonly tokenIn: Address; readonly tokenOut: Address; readonly amountInAtomic: bigint; readonly venue: TradeVenueId; readonly route: TradeRoute; readonly calls: readonly WalletCall[]; readonly estimatedNativeCostWei?: bigint; readonly signal?: AbortSignal }) => Promise<bigint | null>;
  readonly platformFeeTreasury?: Address;
  readonly routeReader?: RouteQuoteReader;
  readonly forbiddenAddresses: (agent: AgentRecord) => ReadonlySet<string>;
  readonly executionIdentity: (agent: AgentRecord, request: TradeRequest) => {
    readonly idempotencyKey: Hex;
    readonly paramsHash: Hex;
  };
  /** Exact fee-inclusive buy basis from the same boot-resolved fee policy as execution. */
  readonly entryBasisWei?: (agent: AgentRecord, request: TradeRequest) => bigint;
  /** Generic journal convergence; live cycles run it before projecting intents. */
  readonly reconcile?: () => Promise<unknown>;
  /** Rebuild a receipt-derived fill for a journal row reconciled after the original process exited. */
  readonly recoverFill: (intent: TradeIntentRecord, txHash: Hex) => Promise<TradeExecutorFill>;
  readonly now?: () => number;
  readonly verdictCache?: TradeVerdictCache;
  /**
   * AGENT-GAS-ATTENTION §2.2 — the agent wallet's native balance.
   *
   * OPTIONAL, and its absence disables the gate entirely rather than blocking:
   * an absent instrument is not a short wallet. Every offline fixture is in
   * that shape, so the gate is opt-in per deployment and no existing test
   * changes behaviour.
   */
  readonly walletNativeBalance?: (wallet: Address) => Promise<bigint>;
  /**
   * The backoff ladder, owned by the daemon and handed in like
   * {@link TradeWorkerDeps.verdictCache}. In memory on purpose — see
   * `LpWorkerState.gasBackoff` for why this must not be durable.
   */
  readonly gasBackoff?: TradeGasBackoff;
  /** The daemon's cycle interval, for the backoff ladder. Defaults to 60 s. */
  readonly intervalMs?: number;
  /** Minimum process-local interval for time-limit-only exit-model calls. */
  readonly exitLlmIntervalMs?: number;
  /** AGENTIC-RFQ-STOCKS E7: the Agentic-only Binance quote source. Only `createAgenticWorkerDeps` sets it (flag on or off); an Altana worker never has it, so no Altana path can reach it (RI1). */
  readonly rfqStocks?: RfqStocksDeps;
  readonly log?: (message: string) => void;
};

/** AGENT-GAS-ATTENTION §2.4 — one agent's standing in the gas backoff ladder. */
export type TradeGasBackoffEntry = {
  readonly consecutiveBlockedProbes: number;
  readonly nextProbeAtMs: number;
  readonly reason: string;
};

export type TradeGasBackoff = Map<string, TradeGasBackoffEntry>;

export function createTradeGasBackoff(): TradeGasBackoff {
  return new Map<string, TradeGasBackoffEntry>();
}

export type RunTradeWorkerOptions = {
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
};

type MutableCounts = { events?: TradeRunEvent[]; startedAt?: number; candidates: number; refusals: number; entries: number; exits: number; heldNoPrice: number };

export const TRADE_EXIT_LLM_INTERVAL_MS = 300_000;
const exitLlmAttemptAt = new Map<string, number>();
/**
 * R2.2 (M4): a guard SELL for a position that rolls back pre-submit or lands a
 * confirmed FAILED/revert must not repeat the same failing guard call every
 * cycle while a working direct route sits unused — the position would never
 * exit. The next sell attempt for that position skips Flash once and falls
 * back to direct; the entry is cleared the moment it is read.
 */
const directSellEscape = new Set<string>();
/**
 * AGENTIC-RFQ-STOCKS R5.1.1 (P1): an asked-mark hold of an RFQ-only model-approved sale, keyed `agent:position`, valued with the cycle time of the hold. The next model-approved sale of that
 * position within 900 000 ms skips the check once and clears the entry only when the sale is actually dispatched; older entries are swept at the start of each RFQ exit pass.
 */
const rfqAskedMarkEscape = new Map<string, number>();
/**
 * AUTO-DCA R2.4 (audit H-1): a merged close + start the executor DENIED writes
 * no action, so no rollback streak can unmerge it. The agent's next strategy
 * step runs the close alone; the entry is cleared the moment it is read.
 */
const dcaCloseAloneOnce = new Set<string>();
const KNOWN_RWA_BY_WORKER = new WeakMap<object, Set<string>>();
const UNISWAP_V3_SELECTORS = [
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  "exactInput((bytes,address,uint256,uint256))",
  "unwrapWETH9(uint256,address)",
  "refundETH()",
] as const;

function exitLlmIntervalMs(deps: TradeWorkerDeps): number {
  const configured = deps.exitLlmIntervalMs
    ?? Number.parseInt(process.env["TRADE_EXIT_LLM_INTERVAL_MS"] ?? "", 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : TRADE_EXIT_LLM_INTERVAL_MS;
}

function observe(counts: MutableCounts, event: Omit<TradeRunEvent, "elapsedMs">): void {
  if (counts.events === undefined) return;
  appendTradeRunEvent(counts.events, normalizeTradeRunEvents([{ ...event, elapsedMs: Date.now() - (counts.startedAt ?? Date.now()) }]));
}

type LlmDataRequestForward = { readonly ticker: string; readonly skill: "planning" | "events"; readonly reason: string; readonly source: "entry" | "exit"; readonly model: string };

/**
 * TRADFI-LLM-CMC-REQUEST §3/R2.5: worker-side index -> ticker mapping for a
 * validated `dataRequests` list, shared by the entry and exit lanes. Emits
 * one run-log `cmc` event per request (`request:queued` or
 * `request:refused:<code>`) using the row's own on-chain address as `token`
 * (a ticker can be missing/unmapped; the address never is), and returns only
 * the accepted requests to forward to the CMC runtime.
 */
function mapAndObserveLlmDataRequests(input: {
  readonly counts: MutableCounts;
  readonly requests: readonly LlmDataRequest[];
  readonly rowFor: (index: number) => { readonly address: string; readonly ticker: string } | undefined;
  readonly dataRequestsEnabled: boolean;
  readonly source: "entry" | "exit";
  readonly model: string;
}): readonly LlmDataRequestForward[] {
  const accepted: LlmDataRequestForward[] = [];
  for (const request of input.requests) {
    const row = input.rowFor(request.index);
    if (row === undefined) continue; // index bounds are already enforced by the validator; defensive only.
    // L6: the exit lane's ticker is `underlyingTicker ?? ""`; normalize "" to no-ticker before the map lookup.
    const ticker = row.ticker.trim().toUpperCase();
    const code = classifyLlmDataRequestTicker(ticker, request.skill, input.dataRequestsEnabled);
    const reasonLine = `${ticker || "?"} ${request.skill}: ${request.reason}`;
    if (code === "ok") {
      accepted.push({ ticker, skill: request.skill, reason: request.reason, source: input.source, model: input.model });
      observe(input.counts, { stage: "cmc", code: "request:queued", token: row.address, model: input.model, reason: reasonLine });
    } else {
      observe(input.counts, { stage: "cmc", code: `request:refused:${code}`, token: row.address, model: input.model, reason: reasonLine });
    }
  }
  return accepted;
}

/** `0x1234…abcd` — the run log's own short form, matched by the web's fallback. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * ONE `screen` line for what the owner's own rules set aside before the data
 * plane saw the cycle, so "N skipped/refused" has a denominator. The tokens
 * are the owner's (pinned at hire), the rule is the owner's (`noReentry`), and
 * a per-token refusal row for each would count the owner's choice as a
 * screening failure and grow every cycle's trace by the size of the universe.
 * Silent when nothing was set aside: the common case stays one line shorter.
 */
export function prefilterEvent(prefilter: PinnedPrefilterSummary): Omit<TradeRunEvent, "elapsedMs"> | null {
  const skipped = prefilter.skippedReentry.length + prefilter.skippedOpen + prefilter.skippedForbidden;
  if (skipped === 0) return null;
  const parts: string[] = [];
  if (prefilter.skippedReentry.length > 0) {
    const shown = prefilter.skippedReentry.slice(0, 8).map(shortAddress);
    const more = prefilter.skippedReentry.length - shown.length;
    parts.push(`${prefilter.skippedReentry.length} traded before and No re-entry is on: ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`);
  }
  if (prefilter.skippedOpen > 0) parts.push(`${prefilter.skippedOpen} already open`);
  if (prefilter.skippedForbidden > 0) parts.push(`${prefilter.skippedForbidden} not enterable`);
  return {
    stage: "screen",
    code: "owner-rules",
    reason: `${skipped} of ${prefilter.pinned} pinned tokens set aside before screening — ${parts.join("; ")}.`,
  };
}

function settingsFrom(value: unknown): EffectiveTradeSettings {
  const parsed = parseTradeSettings(value);
  if (!parsed.ok) throw new Error("Stored trade settings are invalid.");
  return parsed.value.effective;
}

function routeKey(venue: PricedPosition["venue"], route: TradePositionRecord["route"]): string {
  return `${venue}:${keccak256(stringToBytes(canonicalEncode(route)))}`;
}

/** What every Flash call site asked for — the request half of C2's binding check (F7). */
export type FlashRequestFacts = {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountAtomic: string;
};

export type FlashAcceptRefusal = "not-granted" | "request-mismatch" | "identity" | "expired";

/**
 * C2 — the one acceptance path every Flash quote must clear before it becomes
 * a guard call, checked in order:
 *
 * 1. `not-granted` — the session actually grants the guard rule AND the quote's
 *    taker is the worker's OWN configured guard (R2.6): comparing only
 *    `flash.taker` against the session (as every call site did before) is a
 *    tautology once the taker IS the guard being checked.
 * 2. `request-mismatch` — the quote's token pair and amount are exactly what
 *    was asked (F7: nothing bound the response to the request before this).
 * 3. `identity` — router/spender/chain are the one reviewed Flash deployment.
 * 4. `expired` — at least {@link TRADFI_GUARD_MIN_REMAINING_MS} of validity is
 *    left against the caller's OWN clock (F6), not the proxy's `expiresAt`
 *    alone.
 */
export function acceptFlashQuote(input: {
  readonly request: FlashRequestFacts;
  readonly flash: TradfiFlashQuote;
  readonly facts: NonNullable<AgentRecord["sessionFacts"]>;
  readonly configuredGuard: Address | undefined;
  readonly nowMs: number;
}): { readonly ok: true; readonly guardQuote: NonNullable<TradeRequest["guardQuote"]> } | { readonly ok: false; readonly code: FlashAcceptRefusal } {
  const { request, flash, facts, configuredGuard, nowMs } = input;
  if (configuredGuard === undefined || flash.taker.toLowerCase() !== configuredGuard.toLowerCase()
    || !facts.spec.allowedCalls.some((rule) => rule.to?.toLowerCase() === flash.taker.toLowerCase() && rule.selector === TRADFI_GUARD_SWAP_SELECTOR)) {
    return { ok: false, code: "not-granted" };
  }
  if (flash.tokenIn.toLowerCase() !== request.tokenIn.toLowerCase() || flash.tokenOut.toLowerCase() !== request.tokenOut.toLowerCase()
    || flash.amountInAtomic !== request.amountAtomic) {
    return { ok: false, code: "request-mismatch" };
  }
  if (flash.chainId !== 56 || flash.router.toLowerCase() !== TRADFI_BINANCE_FLASH_ROUTER_56.toLowerCase()
    || flash.spender.toLowerCase() !== TRADFI_BINANCE_FLASH_SPENDER_56.toLowerCase()) {
    return { ok: false, code: "identity" };
  }
  if (flash.expiresAt - nowMs < TRADFI_GUARD_MIN_REMAINING_MS) {
    return { ok: false, code: "expired" };
  }
  return { ok: true, guardQuote: { guard: flash.taker, router: flash.router, spender: flash.spender, calldata: flash.calldata, deadline: BigInt(Math.floor(flash.expiresAt / 1_000)) } };
}

/** C7's on/off switch: no configured guard, or no matching session rule, means no Flash call at all. */
function flashGuardGranted(deps: TradeWorkerDeps, facts: NonNullable<AgentRecord["sessionFacts"]>): boolean {
  const guard = deps.aggregatorGuard;
  return guard !== undefined && facts.spec.allowedCalls.some((rule) => rule.to?.toLowerCase() === guard.toLowerCase() && rule.selector === TRADFI_GUARD_SWAP_SELECTOR);
}

/** C8/R2.11 (L2): `proxy:<code[:reason]>` thrown by `dataPlaneReads.ts`, sanitized and capped at 64 chars. */
function flashProxyReason(error: unknown): string {
  const text = `proxy:${error instanceof Error ? error.message : "unknown"}`;
  return sanitizeMessage(text).slice(0, 64);
}

/**
 * L3: the fallback sites throw one of these three sentinels ONLY after already
 * recording its own closed refusal code; the outer catch must not re-observe
 * the same refusal a second time under the unrelated `proxy:` namespace.
 */
const ROUTE_REFUSAL_SENTINELS: ReadonlySet<string> = new Set(["guard unavailable", "reference-premium", "cost-unavailable"]);
function isRouteRefusalSentinel(error: unknown): boolean {
  return error instanceof Error && ROUTE_REFUSAL_SENTINELS.has(error.message);
}

function evidenceExpected(position: TradePositionRecord): TradeEvidenceExpected {
  return {
    sessionGeneration: position.sessionGeneration ?? 0,
    lastQuoteWei: position.lastQuoteWei,
    lastQuoteBalance: position.lastQuoteBalance,
    lastQuoteRoute: position.lastQuoteRoute,
    lastQuoteAtMs: position.lastQuoteAtMs,
    crashPendingSinceMs: position.crashPendingSinceMs,
    crashPendingKind: position.crashPendingKind,
    crashRefQuoteWei: position.crashRefQuoteWei,
    crashRefBalance: position.crashRefBalance,
    crashRefAtMs: position.crashRefAtMs,
    crashRefRoute: position.crashRefRoute,
    autoExitReason: position.autoExitReason,
    autoExitAtMs: position.autoExitAtMs,
    autoExitNote: position.autoExitNote,
  };
}

function evidenceAction(evidence: ExitEvidence): TradeCrashEvidenceAction {
  if (evidence.kind === "clear") return evidence;
  if (evidence.kind === "arm") return {
    kind: "arm", pendingKind: evidence.pendingKind, pendingSinceMs: evidence.pendingSinceMs,
    reference: evidence.reference,
  };
  return evidence;
}

function venueForRoute(route: TradePositionRecord["route"]): TradeVenueId {
  return route.fees.length === 0 ? "pancake_v2" : "pancake_v3";
}

function tradeVenue(venue: TradeVenueId): TradeRequest["venue"] {
  return venue === "pancake_v2" ? "pancake" : venue;
}

function sessionAllowsUniswap(agent: AgentRecord, router: Address | undefined): boolean {
  if (router === undefined || agent.sessionFacts === null) return false;
  return UNISWAP_V3_SELECTORS.every((selector) => agent.sessionFacts!.spec.allowedCalls.some((rule) =>
    rule.to?.toLowerCase() === router.toLowerCase() && rule.selector === selector));
}

function resultCode(result: TradeExecutorResult): string {
  switch (result.kind) {
    case "denied": return result.code;
    case "rolled-back": return result.code;
    case "unknown": return "unknown";
    case "committed": return "committed";
  }
}

function runReason(reason: string, counts: MutableCounts): string {
  // Item 1 shipped no count columns; keep the durable row useful without widening its schema here.
  return `${reason};candidates=${counts.candidates};refusals=${counts.refusals};entries=${counts.entries};exits=${counts.exits};held-no-price=${counts.heldNoPrice}`
    + (counts.heldNoPrice > 0 ? ";held=no-price" : "");
}

async function execute(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  request: TradeRequest,
  scanGate: ScanGate,
  signal?: AbortSignal,
): Promise<TradeExecutorResult> {
  const identity = deps.executionIdentity(agent, request);
  return deps.executor.execute({
    agent, request, scanGate, ...identity, deps: deps.executorDeps,
    ...(signal === undefined ? {} : { signal }),
  });
}

type PricedPosition = {
  readonly position: TradePositionRecord;
  readonly balance: bigint;
  readonly quoteOutWei: bigint;
  readonly route: TradePositionRecord["route"];
  readonly venue: TradeVenueId;
  readonly routeKey: string;
  readonly guardQuote?: TradeRequest["guardQuote"];
};

type RwaLaneSnapshot = {
  readonly available: boolean;
  readonly rowsByAddress: ReadonlyMap<string, UniverseRow>;
  readonly facts: ReadonlyMap<string, RwaFact>;
  readonly addresses: ReadonlySet<string>;
};

function workerKnownRwaAddresses(deps: TradeWorkerDeps): Set<string> {
  if (deps.knownRwaAddresses !== undefined) {
    for (const address of deps.readiness.bstocksAddresses) deps.knownRwaAddresses.add(address.toLowerCase());
    return deps.knownRwaAddresses;
  }
  let known = KNOWN_RWA_BY_WORKER.get(deps.settingsStore);
  if (known === undefined) {
    known = new Set<string>();
    KNOWN_RWA_BY_WORKER.set(deps.settingsStore, known);
  }
  for (const address of deps.readiness.bstocksAddresses) known.add(address.toLowerCase());
  return known;
}

async function readRwaLaneSnapshot(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  model: EffectiveTradeSettings["executionModel"],
  signal?: AbortSignal,
): Promise<RwaLaneSnapshot> {
  const known = workerKnownRwaAddresses(deps);
  const results = await Promise.allSettled([
    deps.dataPlane.universe("bstocks", signal),
    deps.dataPlane.universe("ondo", signal),
  ]);
  signal?.throwIfAborted();
  const rowsByAddress = new Map<string, UniverseRow>();
  for (const result of results) {
    if (result.status !== "fulfilled" || result.value === null) continue;
    for (const row of result.value) {
      const key = row.address.toLowerCase();
      known.add(key);
      const existing = rowsByAddress.get(key);
      if (existing === undefined || (existing.lane === "ondo" && row.lane === "bstocks")) {
        rowsByAddress.set(key, row);
      }
    }
  }
  const available = results.every((result) => result.status === "fulfilled");
  const addresses = new Set(known);
  if (model === "tradfi") {
    for (const address of pinnedTokens(agent.sessionFacts, agent.sessionFacts?.hireSizing?.settlementAsset === "USDT")) addresses.add(address.toLowerCase());
  }
  if (!available) return { available: false, rowsByAddress: new Map(), facts: new Map(), addresses };
  const facts = new Map<string, RwaFact>();
  for (const [key, row] of rowsByAddress) if (row.rwa !== undefined) {
    facts.set(key, row.rwa.venues === undefined && row.venues !== undefined
      ? { ...row.rwa, venues: row.venues, onchainPriceUsd: admittedVenueRows(row.venues)[0]?.priceUsd ?? null }
      : row.rwa);
  }
  return { available: true, rowsByAddress, facts, addresses };
}

/** AGENTIC-RFQ-STOCKS E8: null for every Altana agent and every hire without the marker (the dep exists only on Agentic workers, and the agent must be an Agentic AI one). */
async function rfqOf(deps: TradeWorkerDeps, agent: AgentRecord, settings: EffectiveTradeSettings): Promise<{ readonly entries: boolean; readonly rfqOnlyAtHire: ReadonlySet<string> } | null> {
  if (deps.rfqStocks === undefined || agent.custodyModel !== "binance-agentic" || !isTradfiAiSettings(settings)) return null;
  return deps.rfqStocks.active(agent);
}

/** E2: RFQ-only now when the lane snapshot is readable and shows no admitted venue; the hire-time set when it is not. */
function isRfqOnlyToken(snapshot: RwaLaneSnapshot, rfq: { readonly rfqOnlyAtHire: ReadonlySet<string> }, token: string): boolean {
  const key = token.toLowerCase();
  return snapshot.available ? isRfqOnlyRow(snapshot.rowsByAddress.get(key)) : rfq.rfqOnlyAtHire.has(key);
}

async function repairSellRoute(
  deps: TradeWorkerDeps,
  position: TradePositionRecord,
  balance: bigint,
  signal?: AbortSignal,
): Promise<Omit<PricedPosition, "position" | "balance" | "routeKey"> | null> {
  const probes = [
    { venue: "pancake_v2" as const, route: { hops: [], fees: [] } },
    ...([100, 500, 2_500, 10_000] as const).map((fee) => ({ venue: "pancake_v3" as const, route: { hops: [], fees: [fee] } })),
    { venue: "pancake_v3" as const, route: { hops: [USDT_56], fees: [100, 100] as const } },
    { venue: "pancake_v3" as const, route: { hops: [USDT_56], fees: [500, 100] as const } },
  ];
  let best: Omit<PricedPosition, "position" | "balance" | "routeKey"> | null = null;
  for (const probe of probes) {
    try {
      const quoteOutWei = await quoteSellAlongRoute({
        token: position.token,
        amountInWei: balance,
        venue: probe.venue,
        route: probe.route,
        rpcUrls: deps.rpcUrls,
        ...(signal === undefined ? {} : { signal }),
        ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }),
      });
      if (quoteOutWei > (best?.quoteOutWei ?? 0n)) best = { ...probe, quoteOutWei };
    } catch {
      signal?.throwIfAborted();
    }
  }
  return best;
}

async function pricePositions(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  positions: readonly TradePositionRecord[],
  counts: MutableCounts,
  uniswapAllowed: boolean,
  signal?: AbortSignal,
): Promise<readonly PricedPosition[]> {
  const priced: PricedPosition[] = [];
  let repaired = false;
  for (let position of positions) {
    const balance = await deps.provider.getTokenBalance({
      wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 },
      token: position.token,
      ...(signal === undefined ? {} : { signal }),
    });
    if (position.fillStatus === "unverified") {
      if (balance <= 0n) {
        counts.heldNoPrice += 1;
        continue;
      }
      const resolved = await deps.positions.resolveFill({ ownerAddress: agent.ownerAddress, agentId: agent.id,
        positionId: position.positionId, tokenAmount: balance });
      if (resolved === null) {
        counts.heldNoPrice += 1;
        continue;
      }
      position = resolved;
    } else if (balance <= 0n) {
      // AUDIT M7: a verified fill that left the wallet must release worker capacity.
      await deps.positions.closePosition({ ownerAddress: agent.ownerAddress, agentId: agent.id,
        positionId: position.positionId, exitWei: 0n, reason: "balance-gone" });
      continue;
    }
    const venue = position.venue ?? venueForRoute(position.route);
    try {
      if (venue === "uniswap_v3" && !uniswapAllowed) throw new TradeRouteQuoteError("NO_ROUTE");
      const quoteOutWei = await quoteSellAlongRoute({
        token: position.token, amountInWei: balance, venue, route: position.route,
        rpcUrls: deps.rpcUrls,
        ...(signal === undefined ? {} : { signal }),
        ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }),
      });
      await deps.positions.resetNoPrice(agent.ownerAddress, agent.id, position.positionId);
      priced.push({ position, balance, quoteOutWei, venue, route: position.route, routeKey: routeKey(venue, position.route) });
    } catch {
      signal?.throwIfAborted();
      const repair = repaired ? null : await repairSellRoute(deps, position, balance, signal);
      repaired = true;
      if (repair !== null) {
        await deps.positions.resetNoPrice(agent.ownerAddress, agent.id, position.positionId);
        priced.push({ position, balance, ...repair, routeKey: routeKey(repair.venue, repair.route) });
        continue;
      }
      const row = await deps.positions.incrementNoPrice(agent.ownerAddress, agent.id, position.positionId);
      if ((row?.noPriceCount ?? position.noPriceCount + 1) >= 3) counts.heldNoPrice += 1;
    }
  }
  return priced;
}

type ExitRoute = { readonly venue: TradeVenueId; readonly route: TradePositionRecord["route"] };

function exitRoutes(
  position: TradePositionRecord,
  snapshot: RwaLaneSnapshot,
  uniswapAllowed: boolean,
): readonly ExitRoute[] {
  const storedVenue = position.venue ?? venueForRoute(position.route);
  const routes: ExitRoute[] = [];
  const seen = new Set<string>();
  const add = (candidate: ExitRoute): void => {
    if (candidate.venue === "uniswap_v3" && !uniswapAllowed) return;
    const key = `${candidate.venue}:${candidate.route.hops.map((hop) => hop.toLowerCase()).join(",")}:${candidate.route.fees.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(candidate);
  };
  add({ venue: storedVenue, route: position.route });
  if (!snapshot.available) return routes;
  const row = snapshot.rowsByAddress.get(position.token.toLowerCase());
  for (const venue of admittedVenueRows(row?.venues)) {
    const quote = venue.quote.toLowerCase();
    const stable = quote === USDT_56.toLowerCase() || quote === USDC_56.toLowerCase();
    if (!stable && quote !== "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c") continue;
    if (venue.dex === "pancakeswap" && venue.version === "v2") {
      add({ venue: "pancake_v2", route: stable ? { hops: [venue.quote], fees: [] } : { hops: [], fees: [] } });
      continue;
    }
    if (venue.version !== "v3" || venue.feeTier === null) continue;
    const tier = venue.feeTier as V3FeeTier;
    if (stable) {
      for (const hopFee of [100, 500] as const) {
        add({
          venue: venue.dex === "uniswap" ? "uniswap_v3" : "pancake_v3",
          route: { hops: [venue.quote], fees: [hopFee, tier] },
        });
      }
    } else {
      add({
        venue: venue.dex === "uniswap" ? "uniswap_v3" : "pancake_v3",
        route: { hops: [], fees: [tier] },
      });
    }
  }
  return routes.slice(0, 16);
}

async function searchExitRoute(
  deps: TradeWorkerDeps,
  item: PricedPosition,
  snapshot: RwaLaneSnapshot,
  uniswapAllowed: boolean,
  signal?: AbortSignal,
): Promise<PricedPosition> {
  let best = item;
  for (const candidate of exitRoutes(item.position, snapshot, uniswapAllowed)) {
    try {
      const quoteOutWei = await quoteSellAlongRoute({
        token: item.position.token,
        amountInWei: item.balance,
        venue: candidate.venue,
        route: candidate.route,
        rpcUrls: deps.rpcUrls,
        ...(signal === undefined ? {} : { signal }),
        ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }),
      });
      if (quoteOutWei > best.quoteOutWei) {
        best = { ...item, quoteOutWei, venue: candidate.venue, route: candidate.route,
          routeKey: routeKey(candidate.venue, candidate.route) };
      }
    } catch {
      signal?.throwIfAborted();
    }
  }
  return best;
}

async function projectIntent(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  intent: TradeIntentRecord,
  txHash: Hex,
  fill: TradeExecutorFill,
  signal?: AbortSignal,
  useIntentNote = false,
): Promise<boolean> {
  if (intent.portfolioSlot !== undefined && intent.portfolioSlot !== null) {
    if (intent.side !== fill.side) return false;
    if (fill.side === "buy" && fill.verifiedEntryAtomic !== undefined && deps.journal.markCommitted !== undefined) {
      await deps.journal.markCommitted(intent.idempotencyKey, { actualQuoteSpendWei: fill.verifiedEntryAtomic.toString(10) });
    }
    if (fill.side === "sell" && fill.fillStatus === "verified" && fill.exitWei !== null && fill.receiptOwnershipKey !== undefined) {
      if (deps.intents.setPortfolioProceeds === undefined) return false;
      const credit = await deps.intents.setPortfolioProceeds(agent.ownerAddress, agent.id, intent.decisionId, fill.exitWei, fill.receiptOwnershipKey);
      if (credit.outcome === "conflict") await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress,
        dryRun: false, reason: "portfolio-proof-conflict", events: [{ stage: "screen", code: "portfolio-proof-conflict", token: intent.token, reason: intent.decisionId, elapsedMs: 0 }] });
    }
    await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
    return true;
  }
  if (intent.side === "buy") {
    if (fill.side !== "buy") return false;
    const existing = await deps.positions.get(agent.ownerAddress, agent.id, intent.positionId);
    let receiptAdopted = true;
    if (intent.settlementAsset === "USDT" && fill.verifiedEntryAtomic !== undefined && fill.receiptOwnershipKey === undefined) return false;
    if (existing === null) {
      const opened = await deps.positions.open({
        positionId: intent.positionId,
        agentId: agent.id,
        ownerAddress: agent.ownerAddress,
        token: intent.token,
        route: intent.route,
        venue: intent.venue ?? venueForRoute(intent.route),
        // The durable intent is written before submission from the exact same
        // fee policy as execution. It is the restart-stable cost basis; receipt
        // recovery must not silently drop the platform fee.
        entryWei: intent.entryWei ?? fill.entryWei,
        tokenAmount: fill.tokenAmount,
        fillStatus: fill.fillStatus,
        openedAt: intent.createdAt,
        entryTxHash: txHash,
        crashBasisVerified: fill.receiptAttributable === true,
        sessionGeneration: agent.sessionFacts?.generation ?? 0,
        ...(intent.settlementAsset === undefined ? {} : { settlementAsset: intent.settlementAsset,
          requestedEntryAtomic: intent.amountWei, verifiedEntryAtomic: fill.verifiedEntryAtomic ?? null,
          ...(fill.receiptOwnershipKey === undefined ? {} : { receiptOwnershipKey: fill.receiptOwnershipKey }) }),
      });
      receiptAdopted = intent.settlementAsset !== "USDT" || (opened.verifiedEntryAtomic === fill.verifiedEntryAtomic
        && opened.receiptOwnershipKey === fill.receiptOwnershipKey);
    } else if (intent.settlementAsset === "USDT" && fill.verifiedEntryAtomic !== undefined) {
      if (deps.positions.adoptVerifiedEntry === undefined || fill.receiptOwnershipKey === undefined) {
        receiptAdopted = false;
      } else {
        const adopted = await deps.positions.adoptVerifiedEntry({ ownerAddress: agent.ownerAddress, agentId: agent.id, positionId: intent.positionId,
          verifiedEntryAtomic: fill.verifiedEntryAtomic, receiptOwnershipKey: fill.receiptOwnershipKey,
          ...(fill.tokenAmount === null ? {} : { tokenAmount: fill.tokenAmount }) });
        receiptAdopted = adopted !== null && adopted.verifiedEntryAtomic === fill.verifiedEntryAtomic && adopted.receiptOwnershipKey === fill.receiptOwnershipKey;
      }
      if (receiptAdopted && fill.tokenAmount !== null && existing.tokenAmount === null) {
        await deps.positions.resolveFill({ ownerAddress: agent.ownerAddress, agentId: agent.id, positionId: intent.positionId, tokenAmount: fill.tokenAmount });
      }
    }
    if (!receiptAdopted) return false;
    if (fill.verifiedEntryAtomic !== undefined && deps.journal.markCommitted !== undefined) {
      await deps.journal.markCommitted(intent.idempotencyKey, { actualQuoteSpendWei: fill.verifiedEntryAtomic.toString(10) });
    }
    await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
    return true;
  }
  if (fill.side !== "sell") return false;
  const balance = await deps.provider.getTokenBalance({
    wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 },
    token: intent.token,
    ...(signal === undefined ? {} : { signal }),
  });
  // A confirmed partial disposition is real, but this v1 store has no partial
  // basis ledger. Keep it unsettled and visible instead of calling the whole
  // position closed or manufacturing realised PnL.
  if (balance !== 0n) return false;
  const existing = await deps.positions.get(agent.ownerAddress, agent.id, intent.positionId);
  if (existing !== null && existing.status !== "closed") {
    await deps.positions.closePosition({
      ownerAddress: agent.ownerAddress,
      agentId: agent.id,
      positionId: intent.positionId,
      exitWei: fill.exitWei,
      exitTxHash: txHash,
      soldTokenAmount: intent.amountWei,
      exitFillStatus: fill.fillStatus,
      ...(fill.receiptOwnershipKey === undefined ? {} : { exitReceiptOwnershipKey: fill.receiptOwnershipKey }),
      reason: intent.closeReason ?? "owner-request",
      note: useIntentNote ? intent.note : null,
    });
  }
  await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
  return true;
}

/**
 * TRADFI-EXPIRY-KEEP-REMOVE §2.2: a TradFi AI hashless UNKNOWN sell whose
 * submitting key is provably dead at a finalized block is disposed on the
 * INTENT only; the journal row stays UNKNOWN. No key access, no submission.
 * A read failure leaves the row untouched for the next cycle.
 */
async function disposeInertAmbiguousSell(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  intent: TradeIntentRecord,
  journal: JournalEntry,
  signal?: AbortSignal,
): Promise<void> {
  const inert = deps.inertSubmission;
  if (inert === undefined || deps.intents.disposeInertSell === undefined || !isInertSubmissionCandidate({ intent, journal })) return;
  const settingsRow = await deps.settingsStore.get(agent.ownerAddress, agent.id);
  const parsed = settingsRow === null ? null : parseTradeSettings(settingsRow.params);
  if (parsed?.ok !== true || !isTradfiAiSettings(parsed.value.effective)) return;
  const publicKey = journal.externalRef.publicKey!;
  let evidence: FinalizedSessionRevocationVerdict;
  try {
    evidence = await inert.read({ wallet: agent.walletAddress, keyId: keccak256(publicKey), publicKey, ...(signal === undefined ? {} : { signal }) });
  } catch {
    signal?.throwIfAborted();
    return;
  }
  const input = { intent, journal, agent, expected: { wallet: agent.walletAddress, chainId: inert.chainId, registry: inert.keyStore }, evidence };
  if (!isInertTradeSubmission(input)) return;
  const disposed = await deps.intents.disposeInertSell(agent.ownerAddress, agent.id, intent.decisionId, inertDispositionEvidence(input));
  if (!disposed.changed) return;
  // At-most-once: the evidence on the intent is the durable record; a crash
  // between the CAS and this write loses only the run row.
  try {
    await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress, dryRun: false, reason: "ambiguous-sell-disposed",
      events: [{ stage: "sell", code: "ambiguous-sell-disposed", token: intent.token, elapsedMs: 0,
        reason: sanitizeMessage("The submitting key is expired at a finalized block; this hashless sell can no longer land and no longer blocks renewal or removal.").slice(0, 280) }] });
  } catch { signal?.throwIfAborted(); }
}

async function reconcileTradeIntents(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  signal?: AbortSignal,
): Promise<readonly TradeIntentRecord[]> {
  const unsettled = await deps.intents.listUnsettled(agent.ownerAddress, agent.id);
  if (deps.unknownReads !== undefined && deps.journal.advanceUnknown !== undefined && deps.journal.resolveUnknown !== undefined) {
    for (const intent of unsettled) {
      const journal = await deps.journal.get(intent.idempotencyKey);
      if (journal?.state !== "UNKNOWN") continue;
      try {
        const verdict = await assessTradeUnknown({ agent, journal, reads: deps.unknownReads,
          nowMs: deps.now?.() ?? Date.now(), ...(signal === undefined ? {} : { signal }) });
        if (verdict.kind === "landed") {
          await deps.journal.advanceUnknown(journal.idempotencyKey, verdict.evidence, { txHash: verdict.txHash });
        } else if (verdict.kind === "landed-failed" || verdict.kind === "superseded") {
          await deps.journal.resolveUnknown(journal.idempotencyKey, verdict.evidence);
        } else continue;
        try {
          await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress, dryRun: false,
            reason: "ambiguous-trade-resolved", events: [{ stage: intent.side,
              code: `ambiguous-trade-${verdict.kind}`, token: intent.token, elapsedMs: 0,
              reason: sanitizeMessage(verdict.evidence.disposition).slice(0, 280) }] });
        } catch { signal?.throwIfAborted(); }
      } catch { signal?.throwIfAborted(); }
    }
  }
  for (const intent of unsettled) {
    if (intent.portfolioSlot !== undefined && intent.portfolioSlot !== null) {
      const fenced = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
        const fresh = deps.intents.get === undefined ? null : await deps.intents.get(agent.ownerAddress, agent.id, intent.decisionId, sql);
        if (fresh?.state !== "pending") return;
        const journal = await deps.journal.get(intent.idempotencyKey);
        if (journal === null) {
          await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId, "No submission journal exists.");
        } else if (journal.state === "ROLLED_BACK") {
          if (intent.side === "sell") await deps.intents.setPortfolioProceeds?.(agent.ownerAddress, agent.id, intent.decisionId, 0n, null);
          await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
        } else if (journal.state === "COMMITTED") {
          const txHash = journal.externalRef.txHash;
          if (txHash === undefined) {
            await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
          } else {
            await deps.intents.markSubmitted(agent.ownerAddress, agent.id, intent.decisionId, txHash);
            try {
              const fill = await deps.recoverFill(intent, txHash);
              await projectIntent(deps, agent, intent, txHash, fill, signal);
            } catch { signal?.throwIfAborted(); }
          }
        }
      });
      if (fenced.kind === "draining") continue;
      continue;
    }
    const journal = await deps.journal.get(intent.idempotencyKey);
    if (journal === null || journal.state === "ROLLED_BACK") {
      await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId,
        journal === null ? "No submission journal exists." : "Trade journal rolled back before projection.");
      continue;
    }
    if (journal.state === "UNKNOWN") await disposeInertAmbiguousSell(deps, agent, intent, journal, signal);
    if (journal.state !== "COMMITTED" || journal.externalRef.txHash === undefined) continue;
    const txHash = journal.externalRef.txHash;
    await deps.intents.markSubmitted(agent.ownerAddress, agent.id, intent.decisionId, txHash);
    try {
      const fill = await deps.recoverFill(intent, txHash);
      await projectIntent(deps, agent, intent, txHash, fill, signal);
    } catch {
      signal?.throwIfAborted();
      // A confirmed transaction whose receipt detail is temporarily unreadable
      // remains pending projection; it is never resubmitted.
    }
  }
  // A v2 position may have been projected from a confirmed transaction while
  // the receipt reader was temporarily unavailable. Revisit only those rows;
  // the CAS in adoptVerifiedEntry makes concurrent cycles idempotent and no
  // trade is submitted from this path.
  const projectedV2 = deps.intents.listProjectedV2 === undefined
    ? []
    : await deps.intents.listProjectedV2(agent.ownerAddress, agent.id);
  for (const intent of projectedV2) {
    const position = await deps.positions.get(agent.ownerAddress, agent.id, intent.positionId);
    if (position === null) continue;
    if (intent.side === "buy" && position.verifiedEntryAtomic !== null && position.verifiedEntryAtomic !== undefined) continue;
    if (intent.side === "sell" && (position.status !== "closed" || position.exitWei !== null && position.exitWei !== undefined
      && !(position.closeReason === "balance-gone" && position.exitWei === 0n && position.exitFillStatus !== "verified"
        && (position.exitReceiptOwnershipKey === null || position.exitReceiptOwnershipKey === undefined)))) continue;
    const journal = await deps.journal.get(intent.idempotencyKey);
    const txHash = intent.txHash ?? journal?.externalRef.txHash ?? null;
    if (txHash === null) continue;
    try {
      const fill = await deps.recoverFill(intent, txHash);
      if (intent.side === "buy") {
        if (position.verifiedEntryAtomic !== null && position.verifiedEntryAtomic !== undefined) continue;
        if (fill.side !== "buy" || fill.fillStatus !== "verified" || fill.verifiedEntryAtomic === undefined) continue;
        await projectIntent(deps, agent, intent, txHash, fill, signal);
      } else {
        if (position.status !== "closed" || position.exitWei !== null && position.exitWei !== undefined
          && !(position.closeReason === "balance-gone" && position.exitWei === 0n && position.exitFillStatus !== "verified"
            && (position.exitReceiptOwnershipKey === null || position.exitReceiptOwnershipKey === undefined))
          || fill.side !== "sell" || fill.fillStatus !== "verified" || fill.exitWei === null || fill.receiptOwnershipKey === undefined
          || deps.positions.adoptVerifiedExit === undefined) continue;
        await deps.positions.adoptVerifiedExit({ ownerAddress: agent.ownerAddress, agentId: agent.id, positionId: intent.positionId,
          exitWei: fill.exitWei, receiptOwnershipKey: fill.receiptOwnershipKey });
      }
    } catch {
      signal?.throwIfAborted();
      // Proof remains pending; the next cycle retries reads only.
    }
  }
  if (deps.intents.listPortfolio !== undefined && deps.intents.setPortfolioProceeds !== undefined) {
    const portfolio = await deps.intents.listPortfolio(agent.ownerAddress, agent.id);
    for (const intent of portfolio) {
      if (intent.side !== "sell" || intent.state !== "projected" || intent.portfolioProceedsAtomic !== null
        && intent.portfolioProceedsAtomic !== undefined || (deps.now?.() ?? Date.now()) - intent.createdAt >= MAX_TRADE_SESSION_SECONDS * 1_000) continue;
      const journal = await deps.journal.get(intent.idempotencyKey);
      const txHash = intent.txHash ?? journal?.externalRef.txHash ?? null;
      if (txHash === null) continue;
      try {
        const fill = await deps.recoverFill(intent, txHash);
        if (fill.side !== "sell" || fill.fillStatus !== "verified" || fill.exitWei === null || fill.receiptOwnershipKey === undefined) continue;
        await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
          const result = await deps.intents.setPortfolioProceeds!(agent.ownerAddress, agent.id, intent.decisionId, fill.exitWei!, fill.receiptOwnershipKey!, sql);
          if (result.outcome === "conflict") await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress,
            dryRun: false, reason: "portfolio-proof-conflict", events: [{ stage: "screen", code: "portfolio-proof-conflict", token: intent.token, reason: intent.decisionId, elapsedMs: 0 }] });
        });
      } catch { signal?.throwIfAborted(); }
    }
  }
  return deps.intents.listUnsettled(agent.ownerAddress, agent.id);
}

async function sellPosition(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  priced: PricedPosition,
  closeReason: Exclude<TradeCloseReason, "balance-gone">,
  counts: MutableCounts,
  signal?: AbortSignal,
  decisionNote: string | null = null,
): Promise<void> {
  const request: TradeRequest = {
    decisionId: randomUUID(),
    venue: tradeVenue(priced.venue),
    side: "sell",
    token: priced.position.token,
    amountWei: priced.balance,
    quotedOutWei: priced.quoteOutWei,
    minOutWei: applySlippageFloorWei(priced.quoteOutWei, settings.slippageBps),
    route: priced.route,
    ...(priced.guardQuote === undefined ? {} : { guardQuote: priced.guardQuote }),
    ...(priced.position.settlementAsset === "USDT" ? { settlementAsset: "USDT" as const } : {}),
  };
  const identity = deps.executionIdentity(agent, request);
  const createInput = {
    decisionId: request.decisionId,
    idempotencyKey: identity.idempotencyKey,
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    side: "sell" as const,
    token: request.token,
    route: priced.route,
    amountWei: priced.balance,
    entryWei: priced.position.entryWei,
    positionId: priced.position.positionId,
    closeReason,
    venue: priced.venue,
    ...(priced.position.settlementAsset === "USDT" ? { minOutAtomic: request.minOutWei, quotedOutAtomic: request.quotedOutWei, platformFeeAtomic: 0n } : {}),
    ...(priced.position.settlementAsset === "USDT" ? { settlementAsset: "USDT" as const } : {}),
    ...(decisionNote === null ? {} : { note: decisionNote }),
  };
  let intent: TradeIntentRecord | null = null;
  const markerDriven = closeReason === "crash-stop" || closeReason === "session-expiring";
  if (markerDriven) {
    const fenced = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
      const currentSettingsRow = await deps.settingsStore.get(agent.ownerAddress, agent.id, sql);
      if (currentSettingsRow === null) return null;
      const currentSettings = settingsFrom(currentSettingsRow.params);
      if (closeReason === "crash-stop" && currentSettings.crashProtection !== true) return null;
      const current = await deps.positions.get(agent.ownerAddress, agent.id, priced.position.positionId, sql);
      if (current === null || current.status !== "open" || current.autoExitReason !== closeReason) return null;
      const prior = (await deps.intents.listUnsettled(agent.ownerAddress, agent.id, sql))
        .find((row) => row.side === "sell" && row.positionId === priced.position.positionId);
      if (prior !== undefined) return null;
      return deps.intents.create({ ...createInput,
        ...(current.autoExitNote === null ? {} : { note: current.autoExitNote }),
      }, sql);
    });
    if (fenced.kind === "draining" || fenced.value === null) return;
    intent = fenced.value;
  } else {
    const prior = (await deps.intents.listUnsettled(agent.ownerAddress, agent.id))
      .find((row) => row.side === "sell" && row.positionId === priced.position.positionId);
    if (prior !== undefined) return;
    intent = await deps.intents.create(createInput);
  }
  if (intent === null) return;
  // AUDIT HIGH-1/LOW-1: consume the one-shot escape here, at the actual direct
  // sell attempt — whichever call site produced this request. A no-op Set
  // delete when nothing was armed.
  if (priced.guardQuote === undefined) directSellEscape.delete(priced.position.positionId);
  const result = await execute(deps, agent, request, {
    async evaluate() { return { verdict: "allow", reasons: [] }; },
  }, signal);
  observe(counts, { stage: "sell", code: resultCode(result), token: priced.position.token, reason: closeReason });
  if (priced.guardQuote !== undefined && (result.kind === "rolled-back"
    || (result.kind === "committed" && result.receipt.status === "FAILED"))) {
    // R2.2 (M4): a guard sell that fails pre-submit or lands FAILED on chain
    // must not repeat the same guard call every cycle (exposure-reducing
    // sells only — sellPosition is never called for a buy).
    directSellEscape.add(priced.position.positionId);
  }
  if (result.kind === "committed") {
    const txHash = result.receipt.transactionHash;
    if (txHash !== undefined) {
      await deps.intents.markSubmitted(agent.ownerAddress, agent.id, intent.decisionId, txHash);
      const fill = result.fill?.side === "sell" ? result.fill
        : { side: "sell" as const, exitWei: null, fillStatus: "unverified" as const };
      if (await projectIntent(deps, agent, intent, txHash, fill, signal, true)) counts.exits += 1;
    }
  } else {
    if (result.kind === "denied" || result.kind === "rolled-back") {
      await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId, resultCode(result));
    }
    await deps.positions.recordSellRefusal({
      ownerAddress: agent.ownerAddress, agentId: agent.id,
      positionId: priced.position.positionId, refusal: resultCode(result),
    });
  }
}

async function persistExitEvidence(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  position: TradePositionRecord,
  evidence: ExitEvidence,
): Promise<boolean> {
  const fenced = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
    const currentSettingsRow = await deps.settingsStore.get(agent.ownerAddress, agent.id, sql);
    if (currentSettingsRow === null) return false;
    const currentSettings = settingsFrom(currentSettingsRow.params);
    if (evidence.kind !== "marker" || evidence.reason === "crash-stop") {
      if (currentSettings.crashProtection !== true) return false;
    }
    const current = await deps.positions.get(agent.ownerAddress, agent.id, position.positionId, sql);
    if (current === null || current.status !== "open") return false;
    return (await deps.positions.recordCrashEvidence({
      ownerAddress: agent.ownerAddress,
      agentId: agent.id,
      positionId: position.positionId,
      expected: evidenceExpected(position),
      action: evidenceAction(evidence),
      writerGeneration: agent.sessionFacts?.generation ?? 0,
    }, sql)) !== null;
  });
  return fenced.kind === "allowed" && fenced.value;
}

async function persistQuoteTelemetry(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  item: PricedPosition,
  decisionPnlBps: bigint | null,
  atMs: number,
  counts: MutableCounts,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const recorded = await deps.positions.recordQuote({
      ownerAddress: agent.ownerAddress,
      agentId: agent.id,
      positionId: item.position.positionId,
      quoteOutWei: item.quoteOutWei,
      balance: item.balance,
      routeKey: item.routeKey,
      pnlBps: decisionPnlBps,
      atMs,
      expected: {
        sessionGeneration: item.position.sessionGeneration ?? 0,
        lastQuoteWei: item.position.lastQuoteWei,
        lastQuoteBalance: item.position.lastQuoteBalance,
        lastQuoteRoute: item.position.lastQuoteRoute,
        lastQuoteAtMs: item.position.lastQuoteAtMs,
      },
      sessionGeneration: agent.sessionFacts?.generation ?? 0,
    });
    if (recorded === null) observe(counts, { stage: "sell", code: "telemetry-unavailable", token: item.position.token });
  } catch {
    signal?.throwIfAborted();
    observe(counts, { stage: "sell", code: "telemetry-unavailable", token: item.position.token });
  }
}

/**
 * TRADFI-CMC-EQUITY R2.6 (R-A: prompt only). One worded line per position or
 * candidate in the ask — no 3-ticker cap (closes Rev 1 M6). `sector`/`scanner`
 * are the single `_GLOBAL` rows shared by every ticker; `planning` is read
 * per ticker and gated by N1 (`planningValidForPrompt`) before it is shown.
 */
async function cachedCmcNewsBlocks(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  tickers: readonly string[],
  nowMs: number,
): Promise<readonly string[]> {
  if (deps.cmcNews === undefined || tickers.length === 0) return [];
  const unique = [...new Set(tickers.map((value) => value.trim().toUpperCase()).filter((value) => value.length > 0))];
  if (unique.length === 0) return [];
  const cmcNews = deps.cmcNews;
  const [sectorCtx, scannerCtx] = await Promise.all([
    cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: GLOBAL_TICKER, skill: CMC_SKILL_SECTOR, nowMs }).catch(() => null),
    cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: GLOBAL_TICKER, skill: CMC_SKILL_SCANNER, nowMs }).catch(() => null),
  ]);
  const sector = sectorCtx === null ? null : readCompactSector(sectorCtx.text);
  const scanner = scannerCtx === null ? null : readCompactScanner(scannerCtx.text);
  const lines: string[] = [];
  for (const symbol of unique) {
    const cls = tickerClass(symbol);
    let planning = null as ReturnType<typeof readCompactPlanning>;
    let planningFresh = false;
    if (cls !== null && cls.kind === "stock") {
      try {
        const planningCtx = await cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: symbol, skill: CMC_SKILL_PLANNING, nowMs });
        if (planningCtx !== null) {
          planning = readCompactPlanning(planningCtx.text);
          planningFresh = planning !== null && planningValidForPrompt(planning.sessionDate, nowMs);
        }
      } catch { /* renders "EOD structure: unknown" */ }
    }
    let line = tickerPromptLine({ ticker: symbol, cls, sector, scanner, planning, planningFresh });
    // G0 follow-up: a fresh LLM-requested events row is appended; without one
    // the line is exactly as before (events are never scheduled).
    if (cls !== null && cls.kind === "stock") {
      try {
        const eventsCtx = await cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: symbol, skill: CMC_SKILL_EVENTS, nowMs });
        const events = eventsCtx === null ? null : readCompactEvents(eventsCtx.text);
        if (events !== null) line = `${line}; ${eventsPromptPart(events)}`;
      } catch { /* no events part */ }
    }
    lines.push(line);
  }
  return lines;
}

/** TRADFI-CMC-EQUITY R-B/R2.5/N3(a): the crypto leg (unchanged, `blendRegime`/sizing) plus the R2.6 market-wide and macro prompt lines. */
async function readCmcGlobalRegime(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  nowMs: number,
): Promise<{ readonly regime: CryptoRegime; readonly sizeScale: number; readonly newsLines: readonly string[] }> {
  if (deps.cmcNews === undefined) return { regime: "unavailable", sizeScale: 1, newsLines: [] };
  try {
    const [globalCtx, macroCtx, macroReleaseCtx, sectorCtx] = await Promise.all([
      deps.cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: GLOBAL_TICKER, skill: CMC_GLOBAL_TOOL, nowMs }),
      deps.cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: GLOBAL_TICKER, skill: CMC_SKILL_MACRO, nowMs }),
      deps.cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: GLOBAL_TICKER, skill: CMC_SKILL_MACRO_RELEASE, nowMs }),
      deps.cmcNews.getFresh({ agentId: agent.id, ownerAddress: agent.ownerAddress, ticker: GLOBAL_TICKER, skill: CMC_SKILL_SECTOR, nowMs }),
    ]);
    const metrics = globalCtx === null ? { mcap24hPct: null, mcap7dPct: null, fearGreed: null, volume24hPct: null } : parseGlobalMetrics(globalCtx.text);
    const regime = globalRegime(metrics);
    // AUDIT HIGH-1: read the newer of the daily/release rows — the "+1" call
    // exists to bring actual-vs-estimate sooner than the next daily fetch.
    const freshestMacroCtx = macroReleaseCtx === null ? macroCtx
      : macroCtx === null ? macroReleaseCtx
      : macroReleaseCtx.asOfMs > macroCtx.asOfMs ? macroReleaseCtx : macroCtx;
    const macro = freshestMacroCtx === null ? null : readCompactMacro(freshestMacroCtx.text);
    const risk = macro === null ? "none" : macroEventRiskUsEquity(macro, nowMs);
    const sector = sectorCtx === null ? null : readCompactSector(sectorCtx.text);
    // R-B/H9: the old `cmc-global:` crypto prompt line is removed; the market-wide
    // and macro lines below replace it (R2.6). The crypto leg still feeds
    // `regime`/`sizeScale` exactly as before.
    const newsLines: string[] = [marketPromptLine(sector), macroPromptLine(macro, nowMs)];
    return { regime, sizeScale: regimeSizeScale(regime, risk), newsLines };
  } catch { return { regime: "unavailable", sizeScale: 1, newsLines: [] }; }
}

async function runExits(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  counts: MutableCounts,
  nowMs: number,
  snapshot: RwaLaneSnapshot,
  draining: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (isTradfiV2Settings(settings)) {
    await runTradfiV2Exits(deps, agent, settings, counts, nowMs, snapshot, draining, signal);
    return;
  }
  let open = await deps.positions.listOpen(agent.ownerAddress, agent.id);
  const ordered = [...open].sort((left, right) =>
    Number(right.exitRequestedAt !== null) - Number(left.exitRequestedAt !== null)
    || left.openedAt - right.openedAt);
  const uniswapAllowed = sessionAllowsUniswap(agent, deps.uniswapRouter);
  const priced = await pricePositions(deps, agent, ordered, counts, uniswapAllowed, signal);
  const llmCandidates: PricedPosition[] = [];
  const unsettledSellPositions = new Set((await deps.intents.listUnsettled(agent.ownerAddress, agent.id))
    .filter((intent) => intent.side === "sell")
    .map((intent) => intent.positionId));
  const sessionExpiresAtMs = agent.sessionFacts?.expiry === undefined || agent.sessionFacts === null
    ? null : agent.sessionFacts.expiry * 1_000;
  const clampBasisMs = agent.sessionFacts?.grantedAtSec === undefined
    ? agent.createdAt
    : agent.sessionFacts.grantedAtSec * 1_000;
  if (open.some((position) => position.autoExitReason === "session-expiring"
    && position.autoExitAtMs !== null && position.autoExitAtMs < clampBasisMs)) {
    const cleared = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
      await deps.positions.clearSessionExpiringMarkers({ ownerAddress: agent.ownerAddress, agentId: agent.id, beforeMs: clampBasisMs }, sql);
      return deps.positions.listOpen(agent.ownerAddress, agent.id, sql);
    });
    if (cleared.kind === "allowed") open = cleared.value;
  }
  const remaining = sessionExpiresAtMs === null ? null : sessionExpiresAtMs - clampBasisMs;
  const safeRemaining = remaining !== null && Number.isFinite(remaining) && remaining > 0
    ? remaining : MAX_TRADE_SESSION_SECONDS * 1_000;
  const sessionExitLeadMs = Math.min(SESSION_EXIT_LEAD_MS, safeRemaining / 4);
  for (const item of priced) {
    // R3.3: an unsettled disposition owns this position until projection;
    // neither crash evidence nor another automatic decision may advance it.
    if (unsettledSellPositions.has(item.position.positionId)) continue;
    const decision = decideExit({
      quoteOutWei: item.quoteOutWei, entryWei: item.position.entryWei,
      openedAtMs: item.position.openedAt, nowMs,
      stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps,
      maxHoldSec: settings.maxHoldSec,
      exitRequestedAt: draining ? (item.position.exitRequestedAt ?? nowMs) : item.position.exitRequestedAt,
      sessionExpiresAtMs, sessionExitLeadMs, crashProtection: settings.crashProtection,
      balance: item.balance, routeKey: item.routeKey,
      lastQuoteWei: item.position.lastQuoteWei, lastQuoteBalance: item.position.lastQuoteBalance,
      lastQuoteRoute: item.position.lastQuoteRoute, lastQuoteAtMs: item.position.lastQuoteAtMs,
      peakPnlBps: item.position.peakPnlBps,
      crashPendingSinceMs: item.position.crashPendingSinceMs,
      crashPendingKind: item.position.crashPendingKind,
      crashRefQuoteWei: item.position.crashRefQuoteWei, crashRefBalance: item.position.crashRefBalance,
      crashRefAtMs: item.position.crashRefAtMs, crashRefRoute: item.position.crashRefRoute,
      crashBasisVerified: item.position.crashBasisVerified, tokenAmount: item.position.tokenAmount,
      fillStatus: item.position.fillStatus, autoExitReason: item.position.autoExitReason,
      autoExitNote: item.position.autoExitNote, rugQuoteWindowMs: RUG_QUOTE_WINDOW_MS,
      timeLimitAuthority: settings.maxHoldSec === null,
    });
    const evidenceOkay = decision.evidence === undefined
      ? true : await persistExitEvidence(deps, agent, item.position, decision.evidence);
    const decisionPnlBps = decision.exit ? decision.pnlBps : pnlBps(item.quoteOutWei, item.position.entryWei);
    await persistQuoteTelemetry(deps, agent, item, decisionPnlBps, nowMs, counts, signal);
    // The exit side follows the entry side (see universe.ts): a shut underlying
    // market is a fact about the asset, and the sell quote itself is the price.
    // Refusing to exit on a calendar would strand a position the pool can close.
    if (decision.exit && evidenceOkay) {
      const best = await searchExitRoute(deps, item, snapshot, uniswapAllowed, signal);
      await sellPosition(deps, agent, settings, best, decision.reason, counts, signal, decision.note ?? null);
    } else if (!decision.exit && hasBlankThreshold({
      takeProfitBps: settings.takeProfitBps,
      stopLossBps: settings.stopLossBps,
      timeLimitAuthority: settings.maxHoldSec === null,
    })) {
      llmCandidates.push(item);
    }
  }
  if (llmCandidates.length === 0) return;
  try {
    const llmPositions = llmCandidates.flatMap((item) => {
      const currentPnl = pnlBps(item.quoteOutWei, item.position.entryWei);
      return currentPnl === null ? [] : [{
        tokenAddress: item.position.token,
        symbol: item.position.token.slice(0, 8),
        pnlBps: currentPnl,
        ageSec: Math.max(0, Math.floor((nowMs - item.position.openedAt) / 1_000)),
        takeProfitBps: settings.takeProfitBps,
        stopLossBps: settings.stopLossBps,
        ...(settings.maxHoldSec === null ? { maxHoldSec: null } : {}),
      }];
    });
    if (llmPositions.length !== llmCandidates.length) return;
    const timeLimitOnly = settings.takeProfitBps !== null
      && settings.stopLossBps !== null && settings.maxHoldSec === null;
    const attemptedAt = exitLlmAttemptAt.get(agent.id);
    if (timeLimitOnly && attemptedAt !== undefined && nowMs - attemptedAt < exitLlmIntervalMs(deps)) {
      observe(counts, { stage: "exit-llm", code: "deferred" });
      return;
    }
    const features = await enrichFeatures(deps.dataPlane, settings.executionModel,
      llmCandidates.map(item => item.position.token), deps.now?.() ?? Date.now(), signal);
    const featureNow = deps.now?.() ?? Date.now();
    if (featureModel(settings.executionModel)) for (const item of llmCandidates) {
      const evidence = features.get(item.position.token.toLowerCase());
      const momentum = assessMomentum(evidence ?? {}, featureNow);
      observe(counts, { stage: "exit-llm", code: !evidence ? "feature-missing" : momentum.status === "unavailable" ? "feature-partial" : "feature-ready",
        token: item.position.token, reason: `momentum:${momentum.status}; snapshot:${evidence?.["15m"]?.snapshotId ?? evidence?.["1h"]?.snapshotId ?? "none"}` });
    }
    if (timeLimitOnly) exitLlmAttemptAt.set(agent.id, nowMs);
    const answer = await completeWithFallback(deps, settings, buildExitPrompt({
      featureBlocks: llmCandidates.map((item, index) => {
        const block = featurePrompt(features.get(item.position.token.toLowerCase()), featureNow);
        return block ? `${index}: ${block}` : "";
      }),
      positions: llmPositions,
      owner: settings,
      ...(timeLimitOnly ? { timeLimitAuthority: true } : {}),
    }), signal, (event) => observe(counts, { ...event, stage: "exit-llm" }));
    const decisions = validateExitResponse(answer.content, llmCandidates.length);
    if (!decisions.ok) { observe(counts, { stage: "exit-llm", code: "invalid-response" }); return; }
    for (const decision of decisions.decisions) {
      const item = llmCandidates[decision.index];
      observe(counts, { stage: "exit-llm", code: decision.exit ? "exit" : "hold", model: answer.model, reason: decision.reason, ...(item === undefined ? {} : { token: item.position.token }) });
      if (decision.exit && item !== undefined) {
        const best = await searchExitRoute(deps, item, snapshot, uniswapAllowed, signal);
        await sellPosition(deps, agent, settings, best, "llm", counts, signal, decision.reason);
      }
    }
  } catch {
    observe(counts, { stage: "exit-llm", code: "unavailable-hold" });
    // R7: model failure is a hold, never an exit guess.
  }
}

async function listScheduleIntents(deps: TradeWorkerDeps, agent: AgentRecord): Promise<readonly TradeIntentRecord[]> {
  return deps.intents.listSchedule(agent.ownerAddress, agent.id);
}

async function agentScheduleLedger(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  facts: NonNullable<AgentRecord["sessionFacts"]>,
  nowMs: number,
): Promise<ScheduleLedger> {
  const scheduleIntents = await listScheduleIntents(deps, agent);
  const anchorMs = scheduleAnchorMs(settings.scheduleFirstAtSec, agent.createdAt);
  const ttlSec = Math.max(0, facts.expiry - (facts.grantedAtSec ?? Math.floor(agent.createdAt / 1_000)));
  return scheduleLedger({ anchorMs, intervalSec: settings.scheduleIntervalSec as ScheduleIntervalSec, nowMs,
    capitalQuoteWei: BigInt(settings.capitalQuoteWei!), entryWei: BigInt(settings.entryWei), platformFeeBps: deps.platformFeeBps,
    ttlSec, endKind: settings.scheduleEndKind!, endAtSec: settings.scheduleEndAtSec!, endRuns: settings.scheduleEndRuns!, intents: scheduleIntents });
}

/**
 * A finished Schedule agent has nothing left to buy until an owner edit
 * reopens it, so the cycle stops here: no gas read, no data-plane snapshot,
 * and one durable run row on the transition instead of one per cycle.
 * Returns `null` — the normal path — for anything that is not a well-formed,
 * finished Schedule agent.
 */
async function scheduleFinishedSkip(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  row: TradeSettingsRecord,
  dryRun: boolean,
): Promise<TradeWorkerAgentOutcome | null> {
  if (agent.sessionFacts === null || row.drainingAt !== null) return null;
  const parsed = parseTradeSettings(row.params);
  if (!parsed.ok) return null;
  const settings = parsed.value.effective;
  if (!isTradeScheduleSettings(settings) || settings.capitalQuoteWei === undefined || settings.scheduleIntervalSec === undefined
    || settings.scheduleEndKind === undefined || settings.scheduleEndAtSec === undefined || settings.scheduleEndRuns === undefined
    || settings.scheduleFirstAtSec === undefined) return null;
  const ledger = await agentScheduleLedger(deps, agent, settings, agent.sessionFacts, deps.now?.() ?? Date.now());
  if (ledger.finished === null) return null;
  const reason = `schedule-finished:${ledger.finished}`;
  const counts: MutableCounts = { events: [], startedAt: Date.now(), candidates: 0, refusals: 0, entries: 0, exits: 0, heldNoPrice: 0 };
  const [latest] = await deps.positions.listRuns(agent.ownerAddress, agent.id, 1);
  if (latest === undefined || latest.dryRun !== dryRun || !latest.reason.startsWith(`${reason};`)) {
    observe(counts, { stage: "cycle", code: reason });
    await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress, dryRun, reason: runReason(reason, counts),
      events: counts.events ?? [], candidates: 0, refusals: 0, entries: 0, exits: 0 });
  }
  return { agentId: agent.id, dryRun, reason, ...counts };
}

async function runTradfiScheduleEntry(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  counts: MutableCounts,
  nowMs: number,
  snapshot: RwaLaneSnapshot,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const facts = agent.sessionFacts;
  if (facts === null || settings.scheduleToken === undefined || settings.scheduleIntervalSec === undefined
    || settings.scheduleEndKind === undefined || settings.scheduleEndAtSec === undefined || settings.scheduleEndRuns === undefined
    || settings.scheduleFirstAtSec === undefined || settings.scheduleMarketHoursOnly === undefined || settings.scheduleMaxPremiumBps === undefined) return "settings-invalid";
  const pinned = pinnedTokens(facts, true);
  if (!pinned.some((token) => token.toLowerCase() === settings.scheduleToken!.toLowerCase())) return "schedule-token-not-granted";
  // §2.2: the run row reports one candidate once the token is granted, whether
  // or not this cycle goes on to buy it.
  counts.candidates = 1;
  const unsettled = await deps.intents.listUnsettled(agent.ownerAddress, agent.id);
  const ledger = await agentScheduleLedger(deps, agent, settings, facts, nowMs);
  if (ledger.finished !== null) return `schedule-finished:${ledger.finished}`;
  if (ledger.currentSlot === null) return "schedule-not-started";
  if (ledger.currentSlotTaken) return "schedule-slot-filled";
  if (unsettled.some((intent) => intent.side === "buy")) return "schedule-pending-intent";
  const fact = snapshot.facts.get(settings.scheduleToken.toLowerCase());
  if (settings.scheduleMarketHoursOnly && rwaMarketClosed(fact, nowMs)) { counts.refusals += 1; return "schedule-market-closed"; }
  if (!snapshot.available) { counts.refusals += 1; return "data-plane-unavailable"; }
  const verdict = rwaEntryVerdict(fact, nowMs, { allowVenueMissing: true, deferUnknownPremium: true, maxPremiumBps: settings.scheduleMaxPremiumBps });
  if (verdict.kind === "refuse") { counts.refusals += 1; return `schedule-${verdict.reason}`; }
  const reservation = tradfiV2EntryReservation(BigInt(settings.entryWei), deps.platformFeeBps);
  const dataReserve = deps.v2DataBudgetReservedWei === undefined ? 0n : await deps.v2DataBudgetReservedWei(agent);
  if (dataReserve === null || dataReserve < 0n) { counts.refusals += 1; return "schedule-cash-low"; }
  const pendingBefore = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const walletUsdt = await deps.provider.getTokenBalance({ wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 }, token: USDT_56,
    ...(signal === undefined ? {} : { signal }) });
  const settlementRows = await deps.dataPlane.tokensBatch([USDT_56], signal);
  const settlementRow = settlementRows.find((row) => row.address.toLowerCase() === USDT_56.toLowerCase());
  const settlementUsd = freshTokenUsdFact(settlementRow, Date.now());
  if (settlementUsd === null) { counts.refusals += 1; return "cost-unavailable"; }
  const pendingAfter = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const pending = pendingBefore > pendingAfter ? pendingBefore : pendingAfter;
  const spendable = walletUsdt > dataReserve + pending ? walletUsdt - dataReserve - pending : 0n;
  const quoteRemaining = await readTradfiV2QuoteRemaining(deps, agent, facts, signal);
  // R2.9 (LOW-6): an unreadable on-chain day-cap meter is the v2 string, not a schedule cap
  // exhaustion misdiagnosis; checked immediately, mirroring the v2 read at :1820.
  if (quoteRemaining === null) { counts.refusals += 1; return "quote-meter-unavailable"; }
  const spendCap = quoteRemaining <= pending ? 0n : quoteRemaining - pending;
  if (reservation > spendable) { counts.refusals += 1; return "schedule-cash-low"; }
  if (reservation > spendCap) { counts.refusals += 1; return "schedule-cap-exhausted"; }
  if (reservation > ledger.remainingWei) { counts.refusals += 1; return "schedule-finished:budget"; }
  if (deps.tradfiNativeCostUsdtAtomic === undefined) { counts.refusals += 1; return "cost-unavailable"; }
  const row = snapshot.rowsByAddress.get(settings.scheduleToken.toLowerCase());
  const candidate = {
    address: settings.scheduleToken as `0x${string}`,
    symbol: row?.symbol ?? settings.scheduleToken.slice(0, 8),
    lane: "bstocks" as const, marketCapUsd: null, priceUsd: null, volume24hUsd: null, priceChange24hPct: null, holders: null,
    ...(row?.venues === undefined ? {} : { venues: row.venues }), underlyingMarketClosed: false, rwaNote: verdict.note,
    marketStatus: fact?.marketStatus ?? null, eligibilitySource: "binance-rwa" as const, eligibilityVenue: "pancake-v2" as const,
    routeKind: "pancake-v2" as const, scanReasons: [],
  };
  const result = await submitTradfiV2Buy(deps, agent, settings, { candidate, amount: BigInt(settings.entryWei), snapshot, settlementUsd,
    uniswapAllowed: sessionAllowsUniswap(agent, deps.uniswapRouter), budget: ledger.remainingWei, spendableUsdt: spendable,
    maxPremiumBps: settings.scheduleMaxPremiumBps, scheduleSlot: ledger.currentSlot,
    fenceGuard: async (sql) => {
      const rows = await deps.intents.listSchedule(agent.ownerAddress, agent.id, sql);
      return !rows.some((intent) => intent.scheduleSlot === ledger.currentSlot);
    } }, counts, dryRun, signal);
  if (result === "no-route") return "schedule-no-route";
  if (result === "entry-budget-too-small") return "schedule-finished:budget";
  if (result === "settings_changed" || result === "session_changed" || result === "entry_budget_changed" || result === "schedule_slot_taken") return result;
  return result;
}

function portfolioEscapeKey(agentId: string, token: Address): string {
  return `portfolio:${agentId}:${token.toLowerCase()}`;
}

async function submitTradfiPortfolioSell(
  deps: TradeWorkerDeps, agent: AgentRecord, settings: EffectiveTradeSettings,
  input: { readonly token: Address; readonly amount: bigint; readonly slot: number;
    readonly priced: Awaited<ReturnType<typeof priceTradfiV2Sell>> },
  counts: MutableCounts, dryRun: boolean, signal?: AbortSignal,
): Promise<string> {
  if ("refusal" in input.priced) return "portfolio-no-route";
  const { quote, guardQuote } = input.priced;
  if (dryRun) return "dry-run";
  const request: TradeRequest = { decisionId: randomUUID(), venue: tradeVenue(quote.venue), side: "sell", token: input.token,
    amountWei: input.amount, quotedOutWei: quote.quotedOutAtomic, minOutWei: applySlippageFloorWei(quote.quotedOutAtomic, settings.slippageBps),
    route: quote.route, settlementAsset: "USDT", ...(guardQuote === undefined ? {} : { guardQuote }) };
  const fenced = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
    const denial = await portfolioFence(deps, agent, settings, input.slot, input.token, null, sql);
    if (denial !== null) return { kind: "denied" as const, status: 409, code: denial, meta: {} };
    const identity = deps.executionIdentity(agent, request);
    const intent = await deps.intents.create({ decisionId: request.decisionId, idempotencyKey: identity.idempotencyKey,
      agentId: agent.id, ownerAddress: agent.ownerAddress, side: "sell", token: input.token, route: quote.route, venue: quote.venue,
      amountWei: input.amount, entryWei: 0n, positionId: request.decisionId, closeReason: null, settlementAsset: "USDT",
      platformFeeAtomic: 0n, minOutAtomic: request.minOutWei, quotedOutAtomic: request.quotedOutWei, portfolioSlot: input.slot });
    const escape = portfolioEscapeKey(agent.id, input.token);
    if (guardQuote === undefined) directSellEscape.delete(escape);
    const result = await execute(deps, agent, request, { async evaluate() { return { verdict: "allow", reasons: [] }; } }, signal);
    observe(counts, { stage: "sell", code: resultCode(result), token: input.token, reason: "rebalance" });
    if (guardQuote !== undefined && (result.kind === "rolled-back" || result.kind === "committed" && result.receipt.status === "FAILED")) directSellEscape.add(escape);
    if (result.kind === "committed") {
      const txHash = result.receipt.transactionHash;
      if (txHash !== undefined) await deps.intents.markSubmitted(agent.ownerAddress, agent.id, intent.decisionId, txHash);
      if (result.receipt.status === "FAILED") {
        await deps.intents.setPortfolioProceeds?.(agent.ownerAddress, agent.id, intent.decisionId, 0n, null);
        await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
      } else if (txHash === undefined) await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
      else await projectIntent(deps, agent, intent, txHash, result.fill?.side === "sell" ? result.fill
        : { side: "sell", fillStatus: "unverified", exitWei: null }, signal);
    } else if (result.kind === "denied" || result.kind === "rolled-back") {
      const released = result.kind === "denied" ? result.code !== "conflict" : result.meta["deniedBy"] !== undefined && result.meta["replayed"] !== true;
      if (released) await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId, resultCode(result));
      else {
        await deps.intents.setPortfolioProceeds?.(agent.ownerAddress, agent.id, intent.decisionId, 0n, null);
        await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
      }
    }
    return result;
  });
  if (fenced.kind === "draining") return "draining";
  if (fenced.value.kind === "committed") { counts.exits += 1; return "portfolio-sold"; }
  return resultCode(fenced.value);
}

async function runTradfiPortfolioCycle(
  deps: TradeWorkerDeps, agent: AgentRecord, settings: EffectiveTradeSettings, counts: MutableCounts,
  nowMs: number, snapshot: RwaLaneSnapshot, dryRun: boolean, signal?: AbortSignal,
): Promise<string> {
  if (deps.portfolioEnabled !== true) return "portfolio-disabled";
  const facts = agent.sessionFacts;
  const tokens = settings.portfolioTokens;
  const weights = settings.portfolioWeightsBps;
  const interval = settings.portfolioIntervalSec;
  if (facts === null || tokens === undefined || weights === undefined || interval === undefined
    || deps.intents.listPortfolio === undefined || deps.intents.getPortfolioCheck === undefined || deps.intents.insertPortfolioCheck === undefined
    || deps.intents.markPortfolioCheckDone === undefined) return "settings-invalid";
  const grant = new Set(pinnedTokens(facts, true).map((token) => token.toLowerCase()));
  if (tokens.some((token) => !grant.has(token))) return "portfolio-token-not-granted";
  counts.candidates = tokens.length;
  const unsettled = await deps.intents.listUnsettled(agent.ownerAddress, agent.id);
  for (const intent of unsettled) {
    const journal = await deps.journal.get(intent.idempotencyKey);
    return journal?.state === "UNKNOWN" ? "portfolio-submission-unknown" : "portfolio-pending-intent";
  }
  const slot = currentSlot(agent.createdAt, interval, nowMs);
  if (slot === null) return "portfolio-empty";
  let check = await deps.intents.getPortfolioCheck(agent.ownerAddress, agent.id, slot);
  if (check?.state === "held") return "portfolio-held";
  if (check?.state === "done") return "portfolio-done";
  if (!snapshot.available) { counts.refusals += 1; return "data-plane-unavailable"; }
  const ledger = await deps.intents.listPortfolio(agent.ownerAddress, agent.id);
  const complete = async (): Promise<boolean> => {
    const before = ledger.map((intent) => `${intent.decisionId}:${intent.state}:${intent.portfolioProceedsAtomic ?? "null"}`);
    const fenced = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
      const state = await deps.intents.getPortfolioCheck!(agent.ownerAddress, agent.id, slot, sql);
      if (state?.state !== "rebalancing") return false;
      const fresh = await deps.intents.listPortfolio!(agent.ownerAddress, agent.id, sql);
      if (canonicalEncode(before) !== canonicalEncode(fresh.map((intent) => `${intent.decisionId}:${intent.state}:${intent.portfolioProceedsAtomic ?? "null"}`))) return false;
      await deps.intents.markPortfolioCheckDone!(agent.ownerAddress, agent.id, slot, sql);
      return true;
    });
    return fenced.kind === "allowed" && fenced.value;
  };
  const invested = ledger.reduce((total, intent) => total + (intent.side === "buy" ? intent.entryWei : -(intent.portfolioProceedsAtomic ?? 0n)), 0n);
  const capital = BigInt(settings.capitalQuoteWei!);
  const cashCap = capital > invested ? capital - invested : 0n;
  const pendingBefore = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const wallet = { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 as const };
  const walletUsdt = await deps.provider.getTokenBalance({ wallet, token: USDT_56, ...(signal === undefined ? {} : { signal }) });
  const settlementRows = await deps.dataPlane.tokensBatch([USDT_56], signal);
  const settlementRow = settlementRows.find((row) => row.address.toLowerCase() === USDT_56.toLowerCase());
  const settlementUsd = freshTokenUsdFact(settlementRow, Date.now());
  if (settlementUsd === null) { counts.refusals += 1; return "cost-unavailable"; }
  const pendingAfter = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const pending = pendingBefore > pendingAfter ? pendingBefore : pendingAfter;
  const spendable = walletUsdt > pending ? walletUsdt - pending : 0n;
  const cash = spendable < cashCap ? spendable : cashCap;
  const rawRemaining = await readTradfiV2QuoteRemaining(deps, agent, facts, signal);
  if (rawRemaining === null) { counts.refusals += 1; return "quote-meter-unavailable"; }
  const quoteRemaining = rawRemaining > pending ? rawRemaining - pending : 0n;
  const reader = deps.routeReader ?? createRouteQuoteReader({ rpcUrls: deps.rpcUrls });
  const balances: bigint[] = [];
  const values: bigint[] = [];
  for (const token of tokens) {
    const balance = await deps.provider.getTokenBalance({ wallet, token: token as Address, ...(signal === undefined ? {} : { signal }) });
    const value = await portfolioStockValue(reader, token, balance);
    if (value === null) { counts.refusals += 1; return "portfolio-quote-unavailable"; }
    balances.push(balance);
    values.push(value);
  }
  const minLeg = BigInt(settings.minEntryWei!);
  const total = values.reduce((sum, value) => sum + value, cash);
  if (total < minLeg) return "portfolio-empty";
  const targets = weights.map((weight) => total * BigInt(weight) / 10_000n);
  const drift = values.map((value, index) => Number((value > targets[index]! ? value - targets[index]! : targets[index]! - value) * 10_000n / targets[index]!));
  const maxDrift = Math.max(...drift);
  const taken = new Set(ledger.filter((intent) => intent.portfolioSlot === slot).map((intent) => intent.token.toLowerCase()));
  if (check === null) {
    const state = taken.size === 0 && maxDrift < settings.portfolioDriftBps! ? "held" : "rebalancing";
    if (dryRun) {
      observe(counts, { stage: "screen", code: "portfolio-dry-run", reason: `${state} maxDrift=${maxDrift}` });
      return "dry-run";
    }
    check = await deps.intents.insertPortfolioCheck({ agentId: agent.id, ownerAddress: agent.ownerAddress, slot, state, maxDriftBps: maxDrift, valueWei: total });
    if (check.state === "held") {
      observe(counts, { stage: "screen", code: "portfolio-hold", reason: `max drift ${maxDrift} bps < ${settings.portfolioDriftBps} bps` });
      return "portfolio-hold";
    }
    if (check.state === "done") return "portfolio-done";
  }
  const sells = tokens.map((token, index) => ({ token: token as Address, index, excess: values[index]! - targets[index]! }))
    .filter((leg) => !taken.has(leg.token.toLowerCase()) && leg.excess >= minLeg)
    .sort((a, b) => a.excess === b.excess ? a.index - b.index : a.excess > b.excess ? -1 : 1);
  const buys = tokens.map((token, index) => ({ token: token as Address, index, need: targets[index]! - values[index]! }))
    .filter((leg) => !taken.has(leg.token.toLowerCase()) && leg.need >= minLeg)
    .sort((a, b) => a.need === b.need ? a.index - b.index : a.need > b.need ? -1 : 1);
  observe(counts, { stage: "screen", code: "portfolio-plan", reason: `V=${total} cash=${cash} maxDrift=${maxDrift} legs=${sells.length + buys.length}` });
  if (sells.length === 0 && buys.length === 0) {
    if (dryRun) return "dry-run";
    return await complete() ? taken.size > 0 ? "portfolio-rebalanced" : "portfolio-legs-too-small" : "portfolio-replan";
  }
  if (deps.tradfiNativeCostUsdtAtomic === undefined) { counts.refusals += 1; return "cost-unavailable"; }
  if (dryRun) return "dry-run";
  for (const leg of sells) {
    const amount = balances[leg.index]! * leg.excess / values[leg.index]!;
    const priced = await priceTradfiV2Sell(deps, agent, settings, { token: leg.token, amount,
      positionId: portfolioEscapeKey(agent.id, leg.token) }, counts, signal);
    if ("refusal" in priced) { counts.refusals += 1;
      observe(counts, { stage: "screen", code: "portfolio-refused", token: leg.token, reason: priced.refusal }); continue; }
    return submitTradfiPortfolioSell(deps, agent, settings, { token: leg.token, amount, slot, priced }, counts, dryRun, signal);
  }
  if (sells.length > 0) return "portfolio-no-route";
  const budget = cash < quoteRemaining ? cash : quoteRemaining;
  const totalNeed = buys.reduce((sum, leg) => sum + leg.need, 0n);
  let lastRefusal = "portfolio-no-route";
  for (const [index, leg] of buys.entries()) {
    let amount = totalNeed > budget ? leg.need * budget / totalNeed : leg.need;
    if (amount > BigInt(settings.entryWei)) amount = BigInt(settings.entryWei);
    if (amount < minLeg) {
      const budgetReason = cashCap <= spendable && cashCap <= quoteRemaining ? "portfolio-capital-used"
        : quoteRemaining <= spendable ? "portfolio-cap-exhausted" : "portfolio-cash-low";
      for (const skipped of buys.slice(index)) observe(counts, { stage: "screen", code: "portfolio-refused", token: skipped.token, reason: budgetReason });
      if (!await complete()) return "portfolio-replan";
      return budgetReason;
    }
    const fact = snapshot.facts.get(leg.token.toLowerCase());
    const verdict = rwaEntryVerdict(fact, nowMs, { allowVenueMissing: true, deferUnknownPremium: true });
    if (verdict.kind === "refuse") { counts.refusals += 1; lastRefusal = `portfolio-${verdict.reason}`;
      observe(counts, { stage: "screen", code: lastRefusal, token: leg.token }); continue; }
    const row = snapshot.rowsByAddress.get(leg.token.toLowerCase());
    const candidate: EntryCandidate = { address: leg.token, symbol: row?.symbol ?? leg.token.slice(0, 8), lane: "bstocks",
      marketCapUsd: null, priceUsd: null, volume24hUsd: null, priceChange24hPct: null, holders: null,
      ...(row?.venues === undefined ? {} : { venues: row.venues }), underlyingMarketClosed: false, rwaNote: verdict.note,
      marketStatus: fact?.marketStatus ?? null, eligibilitySource: "binance-rwa", eligibilityVenue: "pancake-v2",
      routeKind: "pancake-v2", scanReasons: [] };
    const result = await submitTradfiV2Buy({ ...deps, platformFeeBps: PORTFOLIO_PLATFORM_FEE_BPS }, agent, settings,
      { candidate, amount, snapshot, settlementUsd, uniswapAllowed: sessionAllowsUniswap(agent, deps.uniswapRouter),
        budget: amount, spendableUsdt: spendable, portfolioSlot: slot,
        fenceGuard: async (sql) => await portfolioFence(deps, agent, settings, slot, leg.token, amount, sql) ?? true }, counts, false, signal);
    if (result === "no-route" || result === "entry-budget-too-small") { counts.refusals += 1;
      lastRefusal = result === "no-route" ? "portfolio-no-route" : "portfolio-cash-low";
      observe(counts, { stage: "screen", code: "portfolio-refused", token: leg.token, reason: lastRefusal }); continue; }
    return result === "entered" ? "portfolio-bought" : result;
  }
  return lastRefusal;
}

async function runEntry(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  counts: MutableCounts,
  nowMs: number,
  snapshot: RwaLaneSnapshot,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const entryFacts = agent.sessionFacts;
  if (entryFacts === null) return "settings-invalid";
  const entryExpiryMs = entryFacts.expiry * 1_000;
  const entryClampMs = entryFacts.grantedAtSec === undefined ? agent.createdAt : entryFacts.grantedAtSec * 1_000;
  const entryRemaining = entryExpiryMs - entryClampMs;
  const entrySafeRemaining = Number.isFinite(entryRemaining) && entryRemaining > 0 ? entryRemaining : MAX_TRADE_SESSION_SECONDS * 1_000;
  const entryCutoffMs = Math.min(SESSION_ENTRY_CUTOFF_MS, entrySafeRemaining / 2);
  if (nowMs >= entryExpiryMs - entryCutoffMs) return "session-expiring";
  if (isTradePortfolioSettings(settings)) return runTradfiPortfolioCycle(deps, agent, settings, counts, nowMs, snapshot, dryRun, signal);
  if (isTradeScheduleSettings(settings)) {
    return runTradfiScheduleEntry(deps, agent, settings, counts, nowMs, snapshot, dryRun, signal);
  }
  if (isTradfiV2Settings(settings)) {
    return runTradfiV2Entry(deps, agent, settings, counts, nowMs, snapshot, dryRun, signal);
  }
  const facts = entryFacts;
  const open = await deps.positions.listOpen(agent.ownerAddress, agent.id);
  if (open.length >= settings.maxOpenPositions) return "at-capacity";
  const buySize = sizeTradeBuy({ entryWei: BigInt(settings.entryWei),
    perTradeCapWei: agent.caps?.perTradeNativeWei, platformFeeBps: deps.platformFeeBps });
  if (buySize === null) return "entry-budget-too-small";
  if (settings.executionModel === "mid-cap" && !deps.readiness.allowlistAvailable) {
    return "allowlist-lane-unavailable";
  }
  if (settings.executionModel === "tradfi" && !snapshot.available) return "data-plane-unavailable";
  // Preserve already-granted larger sessions; the 25-token ceiling applies to new hires.
  // AUDIT M1: an armed agent's durable grant is its universe; pinning runs only at hire/preview.
  const uniswapAllowed = sessionAllowsUniswap(agent, deps.uniswapRouter);
  const candidates = pinnedTokens(agent.sessionFacts)
    .slice(0, settings.executionModel === "tradfi" || settings.executionModel === "blue-chip" || settings.executionModel === "sigma" ? 69 : 25)
    .map((address) => {
      const key = address.toLowerCase();
      const row = snapshot.rowsByAddress.get(key);
      const venues = row?.venues ?? row?.rwa?.venues;
      const lane = row?.lane ?? (deps.readiness.bstocksAddresses.has(key) ? "bstocks" as const
        : settings.executionModel === "degen" ? "meme" as const : "allowlist" as const);
      const ticker = row?.rwa?.underlyingTicker?.trim().toUpperCase();
      return {
        address,
        symbol: row?.symbol ?? address.slice(0, 8),
        lane,
        marketCapUsd: null, priceUsd: null, volume24hUsd: null, priceChange24hPct: null, holders: null,
        ...(row?.marketHours === undefined ? {} : { marketHours: row.marketHours }),
        ...(ticker === undefined || ticker === "" ? {} : { underlyingTicker: ticker }),
        ...(row?.rwa?.platform === undefined ? {} : { platform: row.rwa.platform }),
        ...(venues === undefined ? {} : { venues }),
      };
    });
  const all = await deps.positions.list(agent.ownerAddress, agent.id);
  const unsettled = await deps.intents.listUnsettled(agent.ownerAddress, agent.id);
  const pendingBuyAddresses = unsettled.filter((intent) => intent.side === "buy")
    .map((intent) => intent.token.toLowerCase());
  const selected = await selectEntryCandidates({
    model: settings.executionModel,
    settings,
    candidates,
    pinnedAddresses: new Set(candidates.map((candidate) => candidate.address.toLowerCase())),
    previouslyEnteredAddresses: new Set(all.map((row) => row.token.toLowerCase())),
    openPositionAddresses: new Set([...open.map((row) => row.token.toLowerCase()), ...pendingBuyAddresses]),
    forbiddenAddresses: deps.forbiddenAddresses(agent),
    rwaAddresses: snapshot.addresses,
    rwaFacts: snapshot.facts,
    dataPlane: deps.dataPlane,
    ...(signal === undefined ? {} : { signal }),
    nowMs,
    ...(deps.verdictCache === undefined ? {} : { verdictCache: deps.verdictCache }),
  });
  const setAside = prefilterEvent(selected.prefilter);
  if (setAside !== null) observe(counts, setAside);
  for (const refusal of selected.refusals) observe(counts, { stage: "screen", code: refusal.reason, token: refusal.address });
  counts.refusals += selected.refusals.length;
  if (selected.kind === "aborted") return selected.reason;
  const routeable: EntryCandidate[] = [];
  for (const candidate of selected.candidates) {
    signal?.throwIfAborted();
    // The current worker has no bonding-curve quote path. A launchpad token
    // must not reach the LLM merely because a future executor builder exists.
    if (candidate.routeKind === "fourmeme" || candidate.routeKind === "flap") {
      observe(counts, { stage: "route", code: "NO_ROUTE", token: candidate.address });
      counts.refusals += 1;
      continue;
    }
    try {
      await quoteBestBuyRoute({
        token: candidate.address,
        amountInWei: buySize.amountWei,
        rpcUrls: deps.rpcUrls,
        ...(candidate.venues === undefined ? {} : { venues: candidate.venues }),
        ...(uniswapAllowed && deps.uniswapRouter !== undefined ? { uniswapRouter: deps.uniswapRouter } : {}),
        ...(signal === undefined ? {} : { signal }),
        ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }),
      });
      routeable.push(candidate);
    } catch (error) {
      if (signal?.aborted === true) throw error;
      observe(counts, {
        stage: "route",
        code: error instanceof TradeRouteQuoteError ? error.code : "quote-unavailable",
        token: candidate.address,
      });
      counts.refusals += 1;
    }
  }
  counts.candidates = routeable.length;
  signal?.throwIfAborted();
  const screened = selected.prefilter.pinned - selected.prefilter.skippedReentry.length - selected.prefilter.skippedOpen - selected.prefilter.skippedForbidden;
  observe(counts, { stage: "screen", code: "shortlisted", reason: `${routeable.length} of ${screened} screened candidates passed screening and routeability` });
  if (routeable.length === 0) return selected.candidates.length === 0 ? "no-candidates" : "no-route";
  let accepted: readonly number[];
  try {
    const features = await enrichFeatures(deps.dataPlane, settings.executionModel,
      routeable.map(item => item.address), deps.now?.() ?? Date.now(), signal);
    const featureNow = deps.now?.() ?? Date.now();
    if (featureModel(settings.executionModel)) for (const candidate of routeable) {
      const evidence = features.get(candidate.address.toLowerCase());
      const momentum = assessMomentum(evidence ?? {}, featureNow);
      observe(counts, { stage: "entry-llm", code: !evidence ? "feature-missing" : momentum.status === "unavailable" ? "feature-partial" : "feature-ready",
        token: candidate.address, reason: `momentum:${momentum.status}; snapshot:${evidence?.["15m"]?.snapshotId ?? evidence?.["1h"]?.snapshotId ?? "none"}` });
    }
    const answer = await completeWithFallback(deps, settings, buildEntryPrompt({
      featureBlocks: routeable.map((item, index) => {
        const block = featurePrompt(features.get(item.address.toLowerCase()), featureNow);
        return block ? `${index}: ${block}` : "";
      }),
      model: settings.executionModel,
      candidates: routeable.map((candidate) => ({
        address: candidate.address, symbol: candidate.symbol,
        marketCapUsd: candidate.marketCapUsd, priceUsd: candidate.priceUsd,
        volume24hUsd: candidate.volume24hUsd, priceChange24hPct: candidate.priceChange24hPct,
        holders: candidate.holders, source: candidate.eligibilitySource,
        scanFlags: candidate.scanReasons,
        underlyingMarketClosed: candidate.underlyingMarketClosed,
        rwaNote: candidate.rwaNote,
        ...(candidate.marketStatus === undefined ? {} : { marketStatus: candidate.marketStatus }),
      })),
      owner: settings,
    }), signal, (event) => observe(counts, { ...event, stage: "entry-llm" }));
    const validated = validateEntryResponse(answer.content, routeable.length);
    if (!validated.ok) return "llm-invalid";
    accepted = enteredIndexes(settings.executionModel, validated);
    for (const decision of validated.decisions) observe(counts, {
      stage: "entry-llm", code: accepted.includes(decision.index) ? "selected" : decision.enter ? "below-confidence" : "hold",
      token: routeable[decision.index]!.address, model: answer.model,
      confidence: decision.confidence, reason: decision.reason,
    });
  } catch {
    signal?.throwIfAborted();
    return "llm-unavailable";
  }
  for (const index of accepted.slice(0, 3)) {
    const candidate = routeable[index];
    if (candidate === undefined) continue;
    // AUDIT H1: the pin filter is not authority; approve plus token cap must still hold at build time.
    if (!grantsTokenSell(facts.spec, candidate.address)) {
      observe(counts, { stage: "buy", code: "sell-not-authorized", token: candidate.address });
      counts.refusals += 1;
      continue;
    }
    let quote: BestBuyRoute;
    try {
      quote = await quoteBestBuyRoute({
        token: candidate.address,
        amountInWei: buySize.amountWei,
        rpcUrls: deps.rpcUrls,
        ...(candidate.venues === undefined ? {} : { venues: candidate.venues }),
        ...(uniswapAllowed && deps.uniswapRouter !== undefined ? { uniswapRouter: deps.uniswapRouter } : {}),
        ...(signal === undefined ? {} : { signal }),
        ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }),
      });
    } catch (error) {
      signal?.throwIfAborted();
      observe(counts, { stage: "route", code: error instanceof TradeRouteQuoteError ? error.code : "quote-unavailable", token: candidate.address });
      counts.refusals += 1;
      continue;
    }
    observe(counts, { stage: "route", code: quote.venue, token: candidate.address, reason: `Buy ${buySize.amountWei} wei; quote ${quote.amountOutWei} token units` });
    counts.entries += 1;
    signal?.throwIfAborted();
    if (dryRun) return "dry-run";
    const request: TradeRequest = {
      decisionId: randomUUID(), venue: tradeVenue(quote.venue), side: "buy",
      token: candidate.address, amountWei: buySize.amountWei,
      quotedOutWei: quote.amountOutWei,
      minOutWei: applySlippageFloorWei(quote.amountOutWei, settings.slippageBps),
      route: quote.route,
    };
    const fenced = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async () => {
      signal?.throwIfAborted();
      const identity = deps.executionIdentity(agent, request);
      const intent = await deps.intents.create({
        decisionId: request.decisionId,
        idempotencyKey: identity.idempotencyKey,
        agentId: agent.id,
        ownerAddress: agent.ownerAddress,
        side: "buy",
        token: candidate.address,
        route: quote.route,
        venue: quote.venue,
        amountWei: request.amountWei,
        entryWei: deps.entryBasisWei?.(agent, request) ?? request.amountWei,
        positionId: request.decisionId,
        closeReason: null,
      });
      const result = await execute(deps, agent, request, {
        async evaluate() { return { verdict: "allow", reasons: candidate.scanReasons }; },
      }, signal);
      observe(counts, { stage: "buy", code: resultCode(result), token: candidate.address });
      if (result.kind === "committed" && result.receipt.transactionHash !== undefined) {
        const txHash = result.receipt.transactionHash;
        await deps.intents.markSubmitted(agent.ownerAddress, agent.id, intent.decisionId, txHash);
        const fill = result.fill?.side === "buy" ? result.fill : {
          side: "buy" as const, entryWei: request.amountWei, tokenAmount: null, fillStatus: "unverified" as const,
        };
        await projectIntent(deps, agent, intent, txHash, fill, signal);
      } else if (result.kind === "denied" || result.kind === "rolled-back") {
        await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId, resultCode(result));
      }
      return result;
    });
    if (fenced.kind === "draining") return "draining";
    const result = fenced.value;
    if (result.kind !== "committed") return resultCode(result);
    return "entered";
  }
  return accepted.length === 0 ? "llm-hold" : "no-route";
}

/**
 * The guard-first v2 sell pricing of {@link runTradfiV2Exits}, extracted verbatim
 * (AUTO-DCA §6.2, R2.3 item 2): direct quote; Flash fallback when direct throws;
 * otherwise Flash with the direct-floor rail and the one-shot direct escape.
 * The caller records the refusal exactly as the loop did. DCA calls it for the
 * Remove sale only.
 */
async function priceTradfiV2Sell(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  sale: { readonly token: Address; readonly amount: bigint; readonly positionId: string },
  counts: MutableCounts,
  signal?: AbortSignal,
  rfq?: boolean,
): Promise<{ readonly quote: Awaited<ReturnType<typeof quoteBestTradfiSell>>; readonly guardQuote?: TradeRequest["guardQuote"] } | { readonly refusal: "cost-unavailable" }> {
  // AGENTIC-RFQ-STOCKS E10: an RFQ-only position is priced only by the Agentic sell quote of its balance; no direct or Flash call is ever made for it.
  if (rfq === true && deps.rfqStocks !== undefined) {
    const q = await deps.rfqStocks.quote({ agent, side: "sell", token: sale.token, amountAtomic: sale.amount, ...(signal === undefined ? {} : { signal }) });
    if (!q.ok) { observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: q.code }); return { refusal: "cost-unavailable" }; }
    observe(counts, { stage: "route", code: "binance-rfq", token: sale.token });
    return { quote: rfqQuoteRecord({ token: sale.token, amountInAtomic: sale.amount, quotedOutAtomic: q.outAtomic, minOutAtomic: applySlippageFloorWei(q.outAtomic, settings.slippageBps), nowMs: deps.now?.() ?? Date.now() }) };
  }
  const uniswapAllowed = sessionAllowsUniswap(agent, deps.uniswapRouter);
  let quote: Awaited<ReturnType<typeof quoteBestTradfiSell>>;
  let guardQuote: TradeRequest["guardQuote"] | undefined;
  try {
    quote = await quoteBestTradfiSell({ token: sale.token, amountInAtomic: sale.amount, slippageBps: settings.slippageBps, rpcUrls: deps.rpcUrls,
      ...(uniswapAllowed && deps.uniswapRouter === undefined ? {} : uniswapAllowed && deps.uniswapRouter !== undefined ? { uniswapRouter: deps.uniswapRouter } : {}),
      ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }), ...(signal === undefined ? {} : { signal }) });
  } catch {
    const sellFacts = agent.sessionFacts;
    if (deps.dataPlane.binanceQuoteAndSwap === undefined || sellFacts === null || !flashGuardGranted(deps, sellFacts)) {
      return { refusal: "cost-unavailable" };
    }
    try {
      const flashReq = { tokenIn: sale.token, tokenOut: USDT_56, amountAtomic: sale.amount.toString(10) };
      const flash = await deps.dataPlane.binanceQuoteAndSwap(flashRequest({ ...flashReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
      const accepted = acceptFlashQuote({ request: flashReq, flash, facts: sellFacts, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
      if (!accepted.ok) {
        observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: accepted.code });
        throw new Error("guard unavailable");
      }
      quote = { venue: "pancake_v3", router: flash.router, route: { hops: [], fees: [100] as const },
        settlementToken: USDT_56, token: sale.token, amountInAtomic: sale.amount,
        quotedOutAtomic: BigInt(flash.quotedOutAtomic), minOutAtomic: BigInt(flash.minOutAtomic), observedAt: flash.observedAt, expiresAt: flash.expiresAt };
      guardQuote = accepted.guardQuote;
      observe(counts, { stage: "route", code: "binance-guard", token: sale.token });
    } catch (error) {
      if (!isRouteRefusalSentinel(error)) observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: flashProxyReason(error) });
      return { refusal: "cost-unavailable" };
    }
  }
  // C7: at most one Flash call per position — skip the comparison below when
  // the fallback above already fetched (and used) a Flash quote this cycle.
  if (guardQuote === undefined && deps.dataPlane.binanceQuoteAndSwap !== undefined && agent.sessionFacts !== null && flashGuardGranted(deps, agent.sessionFacts)) {
    const sellFacts = agent.sessionFacts;
    // AUDIT HIGH-1/LOW-1: peek, don't consume — this comparison runs every
    // cycle regardless of whether a sell is actually attempted (it also
    // feeds the decideExit mark). Consuming here would burn the one-shot
    // escape on a cycle that never sells, and would leave the exit-LLM
    // re-quote (the site that actually decides a blank-threshold exit) with
    // nothing to check. The entry is consumed only in `sellPosition`, at the
    // actual direct sell attempt.
    if (directSellEscape.has(sale.positionId)) {
      observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: "escape-after-guard-failure" });
    } else {
      try {
        const flashReq = { tokenIn: sale.token, tokenOut: USDT_56, amountAtomic: sale.amount.toString(10) };
        const flash = await deps.dataPlane.binanceQuoteAndSwap(flashRequest({ ...flashReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
        const accepted = acceptFlashQuote({ request: flashReq, flash, facts: sellFacts, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
        if (!accepted.ok) {
          observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: accepted.code });
        } else if (BigInt(flash.quotedOutAtomic) < quote.minOutAtomic) {
          // R2.1 (H1a): the sell direct-floor rail — Binance must clear the
          // fresh direct quote's own slippage floor, or a bad Flash price
          // would feed straight into the stop-loss/crash mark (H1).
          observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: "direct-floor" });
        } else {
          const candidate = { venue: "pancake_v3" as const, router: flash.router,
            route: { hops: [], fees: [100] as const }, quotedOutAtomic: BigInt(flash.quotedOutAtomic),
            minOutAtomic: BigInt(flash.minOutAtomic), expiresAt: flash.expiresAt };
          // M1: kept as the pre-flight — the only pre-submission signal that a
          // guard call would be refused or revert.
          const aggregatorCost = deps.tradfiNativeCostUsdtAtomic === undefined ? null : await deps.tradfiNativeCostUsdtAtomic({
            agent, tokenIn: sale.token, tokenOut: USDT_56, amountInAtomic: sale.amount, venue: candidate.venue, route: candidate.route,
            calls: buildV2CostCalls({ quote: candidate, token: sale.token, amountInAtomic: sale.amount, wallet: agent.walletAddress, feeAtomic: 0n, side: "sell", guardQuote: accepted.guardQuote }), ...(signal === undefined ? {} : { signal }) });
          if (aggregatorCost === null) {
            observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: "cost-unavailable" });
          } else {
            // G1/P-a: Binance wins whenever usable — no net-price ranking against direct.
            quote = { ...quote, venue: candidate.venue, route: candidate.route, quotedOutAtomic: candidate.quotedOutAtomic,
              minOutAtomic: candidate.minOutAtomic, expiresAt: candidate.expiresAt };
            guardQuote = accepted.guardQuote;
            observe(counts, { stage: "route", code: "binance-guard", token: sale.token });
          }
        }
      } catch (error) { observe(counts, { stage: "route", code: "binance-refused", token: sale.token, reason: flashProxyReason(error) }); /* direct quote remains the protective fallback */ }
    }
  }
  return { quote, ...(guardQuote === undefined ? {} : { guardQuote }) };
}

function rfqPause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) { reject(signal.reason); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The (current, previous) readings of one RFQ-only position this cycle, carried from the pricing site to the robot site and the trigger site; nothing re-reads the row (R4.8). */
type RfqPair = { readonly quote: TradfiQuote; readonly current: RfqReading | null; readonly prev: RfqReading | null; readonly confirmFailed: string | null };

/**
 * AGENTIC-RFQ-STOCKS R3.4 / R4.2 / R5.4 / R5.5: the previous reading is the one on the position row loaded at the start of the cycle (usable only from an earlier cycle, same route and
 * balance, within 900 000 ms). When a mark gate is breached by the first reading and no usable previous reading agrees, ONE confirming sell quote is taken after a 5 s pause (no wallet fence
 * held); on success it is the cycle's current reading and the first reading its previous one, on failure the first reading stays current. A sale that is not a mark decision never waits.
 */
async function rfqPair(input: { deps: TradeWorkerDeps; agent: AgentRecord; settings: EffectiveTradeSettings; position: TradePositionRecord; balance: bigint; first: TradfiQuote;
  nowMs: number; draining: boolean; counts: MutableCounts; signal?: AbortSignal }): Promise<RfqPair> {
  const { deps, agent, settings, position, balance, first, nowMs, counts, signal } = input;
  const basis = position.verifiedEntryAtomic;
  const firstPnl = basis === null || basis === undefined ? null : pnlBps(first.quotedOutAtomic, basis);
  if (basis === null || basis === undefined || firstPnl === null) return { quote: first, current: null, prev: null, confirmFailed: null };
  const firstReading: RfqReading = { quoteWei: first.quotedOutAtomic, pnlBps: firstPnl };
  const prev = usablePreviousReading({ position, routeKey: routeKey(first.venue, first.route), balance, nowMs });
  const exitRequestedAt = input.draining ? (position.exitRequestedAt ?? nowMs) : position.exitRequestedAt;
  const autoExitReason = position.autoExitReason === "session-expiring" ? null : position.autoExitReason;
  if (skipsConfirmation({ draining: input.draining, exitRequestedAt, autoExitReason, crashProtection: settings.crashProtection })) return { quote: first, current: firstReading, prev, confirmFailed: null };
  const gates = confirmationGates({ stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps, maxHoldSec: settings.maxHoldSec,
    mode: isTradfiAiSettings(settings) ? deps.tradfiExitRulesMode ?? "off" : "off", openedAtMs: position.openedAt, nowMs, storedPeak: position.peakPnlBps,
    prior: priorFromStored(position.exitLlmContext, sessionState(nowMs)), first: firstReading, prev,
    hasBlankThreshold: hasBlankThreshold({ takeProfitBps: settings.takeProfitBps, stopLossBps: settings.stopLossBps, timeLimitAuthority: settings.maxHoldSec === null }) });
  if (gates.length === 0) return { quote: first, current: firstReading, prev, confirmFailed: null };
  await rfqPause(RFQ_CONFIRM_DELAY_MS, signal);
  const confirm = await deps.rfqStocks!.quote({ agent, side: "sell", token: position.token, amountAtomic: balance, ...(signal === undefined ? {} : { signal }) });
  if (!confirm.ok) {
    observe(counts, { stage: "sell", code: "rfq-confirm", token: position.token, reason: `${gates.join("+")};failed:${confirm.code}` });
    return { quote: first, current: firstReading, prev, confirmFailed: confirm.code };
  }
  observe(counts, { stage: "sell", code: "rfq-confirm", token: position.token, reason: `${gates.join("+")};ok` });
  return { quote: rfqQuoteRecord({ token: position.token, amountInAtomic: balance, quotedOutAtomic: confirm.outAtomic, minOutAtomic: applySlippageFloorWei(confirm.outAtomic, settings.slippageBps), nowMs: deps.now?.() ?? Date.now() }),
    current: { quoteWei: confirm.outAtomic, pnlBps: pnlBps(confirm.outAtomic, basis)! }, prev: firstReading, confirmFailed: null };
}

/** USDT v2 exits keep the sell quote and basis in the same settlement asset. */
async function runTradfiV2Exits(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  counts: MutableCounts,
  nowMs: number,
  snapshot: RwaLaneSnapshot,
  draining: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const open = await deps.positions.listOpen(agent.ownerAddress, agent.id);
  const uniswapAllowed = sessionAllowsUniswap(agent, deps.uniswapRouter);
  // AGENTIC-RFQ-STOCKS E10: null for every Altana agent and every hire without the marker (exits and marks keep working with the flag off: a holder must be able to sell).
  const rfq = await rfqOf(deps, agent, settings);
  if (rfq !== null) for (const [key, heldAt] of rfqAskedMarkEscape) if (nowMs - heldAt > RUG_QUOTE_WINDOW_MS) rfqAskedMarkEscape.delete(key);
  // TRADFI-EXPIRY-KEEP-REMOVE R2: nothing is sold at session expiry for this
  // model. A stored `session-expiring` marker is UI hygiene now: cleared once
  // per cycle under the entry fence, and masked below in case one is retained.
  if (open.some((position) => position.autoExitReason === "session-expiring")) {
    await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, (sql) =>
      deps.positions.clearSessionExpiringMarkers({ ownerAddress: agent.ownerAddress, agentId: agent.id }, sql));
  }
  // TRADFI-LLM-CMC-REQUEST R3.10 L2: ONE computed boolean feeds the prompt's
  // `dataRequests` line AND the exit validator's `allowDataRequests` option —
  // this function only ever runs for TradFi v2 (`isTradfiV2Settings`), so the
  // gate here is complete.
  const dataRequestsEnabled = settings.cmcNewsEnabled === true && deps.refreshCmcNews !== undefined;
  const exitHeldTickers = open.flatMap((position) => { const ticker = snapshot.rowsByAddress.get(position.token.toLowerCase())?.rwa?.underlyingTicker; return ticker === undefined || ticker === null ? [] : [ticker]; });
  if (dataRequestsEnabled) {
    void deps.refreshCmcNews!({ agent, heldTickers: exitHeldTickers, shortlistedTickers: [], nowMs, ...(signal === undefined ? {} : { signal }) }).catch(() => undefined);
  }
  const llmCandidates: Array<{ readonly priced: PricedPosition; readonly pnlBps: bigint; readonly ticker: string; readonly rfq?: { readonly prev: RfqReading | null; readonly confirmFailed: string | null } }> = [];
  for (const position of open) {
    signal?.throwIfAborted();
    const balance = await deps.provider.getTokenBalance({ wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 }, token: position.token,
      ...(signal === undefined ? {} : { signal }) });
    if (balance <= 0n) {
      await deps.positions.closePosition({ ownerAddress: agent.ownerAddress, agentId: agent.id, positionId: position.positionId, exitWei: 0n, reason: "balance-gone" });
      continue;
    }
    const rfqPosition = rfq !== null && isRfqOnlyToken(snapshot, rfq, position.token);
    const sellPriced = await priceTradfiV2Sell(deps, agent, settings, { token: position.token, amount: balance, positionId: position.positionId }, counts, signal, rfqPosition);
    if ("refusal" in sellPriced) {
      await deps.positions.recordSellRefusal({ ownerAddress: agent.ownerAddress, agentId: agent.id, positionId: position.positionId, refusal: sellPriced.refusal }); continue;
    }
    const { quote: firstQuote, guardQuote } = sellPriced;
    // R3.4 / R4.2: an RFQ-only mark is a pair of readings; the confirming quote, when one is taken, is the cycle's current reading (and prices a resulting sale).
    const rfqMark = rfqPosition ? await rfqPair({ deps, agent, settings, position, balance, first: firstQuote, nowMs, draining, counts, ...(signal === undefined ? {} : { signal }) }) : null;
    const quote = rfqMark?.quote ?? firstQuote;
    const priced: PricedPosition = { position, balance, quoteOutWei: quote.quotedOutAtomic, venue: quote.venue, route: quote.route,
      routeKey: routeKey(quote.venue, quote.route), ...(guardQuote === undefined ? {} : { guardQuote }) };
    const basis = position.verifiedEntryAtomic;
    const decision = decideExit({ quoteOutWei: quote.quotedOutAtomic, entryWei: basis ?? 0n, openedAtMs: position.openedAt, nowMs,
      stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps, maxHoldSec: settings.maxHoldSec,
      exitRequestedAt: draining ? (position.exitRequestedAt ?? nowMs) : position.exitRequestedAt, sessionExpiresAtMs: null,
      sessionExitLeadMs: SESSION_EXIT_LEAD_MS, crashProtection: settings.crashProtection, balance, routeKey: priced.routeKey,
      lastQuoteWei: position.lastQuoteWei, lastQuoteBalance: position.lastQuoteBalance, lastQuoteRoute: position.lastQuoteRoute,
      lastQuoteAtMs: position.lastQuoteAtMs, peakPnlBps: position.peakPnlBps, crashPendingSinceMs: position.crashPendingSinceMs,
      crashPendingKind: position.crashPendingKind, crashRefQuoteWei: position.crashRefQuoteWei, crashRefBalance: position.crashRefBalance,
      crashRefAtMs: position.crashRefAtMs, crashRefRoute: position.crashRefRoute, crashBasisVerified: position.crashBasisVerified,
      tokenAmount: position.tokenAmount, fillStatus: position.fillStatus,
      autoExitReason: position.autoExitReason === "session-expiring" ? null : position.autoExitReason,
      autoExitNote: position.autoExitNote, rugQuoteWindowMs: RUG_QUOTE_WINDOW_MS, timeLimitAuthority: settings.maxHoldSec === null,
      ...(rfqMark === null ? {} : { previousMarkPnlBps: rfqMark.prev?.pnlBps ?? null }) });
    const evidenceOkay = decision.evidence === undefined ? true : await persistExitEvidence(deps, agent, position, decision.evidence);
    const decisionPnlBps = decision.exit ? decision.pnlBps : pnlBps(quote.quotedOutAtomic, basis ?? 0n);
    // R3.4: an RFQ-only position feeds the stored peak the LOWER of the pair (nothing without a usable previous reading); the stored quote is the current reading either way.
    await persistQuoteTelemetry(deps, agent, priced, rfqMark === null ? decisionPnlBps : rfqPeakArgument(decisionPnlBps, rfqMark.prev), nowMs, counts, signal);
    if (decision.exit && evidenceOkay) {
      await sellPosition(deps, agent, settings, priced, decision.reason === "llm" ? "llm" : decision.reason, counts, signal, decision.note ?? null);
    } else if (!decision.exit && basis !== undefined && basis !== null && basis > 0n && decisionPnlBps !== null && hasBlankThreshold({
      takeProfitBps: settings.takeProfitBps, stopLossBps: settings.stopLossBps, timeLimitAuthority: settings.maxHoldSec === null,
    })) {
      // TRADFI-EXIT-RULES §3/§4: the owner's own exits and `decideExit` ran first. The peak is the stored one
      // (loaded before this cycle's telemetry write) raised to the current reading.
      const mode = isTradfiAiSettings(settings) ? deps.tradfiExitRulesMode ?? "off" : "off";
      const peak = rfqMark === null ? Math.max(Number(decisionPnlBps), position.peakPnlBps === null ? Number.NEGATIVE_INFINITY : Number(position.peakPnlBps)) : rfqPeak(position.peakPnlBps, decisionPnlBps, rfqMark.prev);
      // Review M1: a peak above TRADFI_TRAIL_MAX_PEAK_BPS never arms T (tradfiRobotExit); say so once per cycle.
      if (mode !== "off" && tradfiPeakImplausible(peak)) observe(counts, { stage: "exit-llm", code: "rule:peak-implausible", token: position.token, reason: `peak=+${Math.trunc(peak)}` });
      const robot = mode === "off" ? null : tradfiRobotExit({ pnlBps: Number(decisionPnlBps), peakPnlBps: peak,
        openedAtMs: position.openedAt, nowMs, takeProfitBlank: settings.takeProfitBps === null, maxHoldBlank: settings.maxHoldSec === null });
      // R3.15: for an RFQ-only position the same rule must fire on the previous reading too (same peak); otherwise the worker logs rule:hold-confirm and sells nothing.
      const confirmedRobot = rfqMark === null || robot === null ? robot : rfqMark.prev !== null && tradfiRobotExit({ pnlBps: Number(rfqMark.prev.pnlBps), peakPnlBps: peak,
        openedAtMs: position.openedAt, nowMs, takeProfitBlank: settings.takeProfitBps === null, maxHoldBlank: settings.maxHoldSec === null })?.rule === robot.rule ? robot : null;
      if (robot !== null && confirmedRobot === null) observe(counts, { stage: "exit-llm", code: "rule:hold-confirm", token: position.token, reason: robot.detail });
      else if (robot !== null) observe(counts, { stage: "exit-llm", code: `rule:${mode === "enforce" ? "exit" : "would-exit"}:${robot.rule}`, token: position.token, reason: robot.detail });
      if (confirmedRobot !== null && mode === "enforce") {
        await sellPosition(deps, agent, settings, priced, confirmedRobot.rule, counts, signal, confirmedRobot.detail);
      } else if (rfqMark !== null && settings.stopLossBps !== null && decisionPnlBps <= -BigInt(settings.stopLossBps)) {
        // R3.4: a stop-loss awaiting its second reading is not offered to the exit model this cycle; it is decided next cycle by the readings.
      } else {
        const ticker = snapshot.rowsByAddress.get(position.token.toLowerCase())?.rwa?.underlyingTicker ?? "";
        llmCandidates.push({ priced, pnlBps: decisionPnlBps, ticker, ...(rfqMark === null ? {} : { rfq: { prev: rfqMark.prev, confirmFailed: rfqMark.confirmFailed } }) });
      }
    }
  }
  if (llmCandidates.length === 0) return;
  try {
    const features = await enrichFeatures(deps.dataPlane, settings.executionModel, llmCandidates.map((item) => item.priced.position.token), nowMs, signal);
    const session = sessionState(nowMs);
    let equityRegime: Regime = "unavailable";
    try {
      const read = await deps.dataPlane.usEquityRegime?.(signal);
      if (read !== undefined) equityRegime = read.regime;
    } catch { /* degrades to unavailable */ }
    const cryptoLeg = await readCmcGlobalRegime(deps, agent, nowMs);
    const regime = blendRegime(equityRegime, cryptoLeg.regime);
    observe(counts, { stage: "cmc", code: `regime:${regime}` });
    const isRegimeValue = (value: string): value is Regime => value === "risk_on" || value === "risk_off" || value === "neutral" || value === "unavailable";
    const triggered: typeof llmCandidates = [];
    const triggerById = new Map<string, string>();
    // AGENTIC-RFQ-STOCKS R5.1.4/R5.2: the pnl shown to the model (and braked on) and the quote behind it, per RFQ-only position; per-cycle maps, never fields of the stored context (a bigint cannot be JSON).
    const askedById = new Map<string, bigint>();
    const decisionMarkById = new Map<string, bigint>();
    const contextByPosition = new Map<string, { askedAtMs: number; pnlBps: number; peakPnlBps: number | null;
      macdHistSign: -1 | 0 | 1 | null; emaSpreadSign: -1 | 0 | 1 | null; regime: Regime; session: typeof session; trigger: string }>();
    for (const item of llmCandidates) {
      const evidence1h = features.get(item.priced.position.token.toLowerCase())?.["1h"];
      const histogram = evidence1h?.additiveMetrics?.histogram;
      const emaSpread = evidence1h?.metrics.emaSpreadPct;
      const macdHistSign: -1 | 0 | 1 | null = histogram?.available === true && histogram.value !== null ? (histogram.value > 0 ? 1 : histogram.value < 0 ? -1 : 0) : null;
      const emaSpreadSign: -1 | 0 | 1 | null = emaSpread?.available === true && emaSpread.value !== null ? (emaSpread.value > 0 ? 1 : emaSpread.value < 0 ? -1 : 0) : null;
      const current: ExitTriggerContext = { pnlBps: Number(item.pnlBps), peakPnlBps: item.priced.position.peakPnlBps === null ? null : Number(item.priced.position.peakPnlBps), macdHistSign, emaSpreadSign, regime, session };
      const storedContext = item.priced.position.exitLlmContext;
      const prior: ExitTriggerContext | null = storedContext === null || storedContext === undefined ? null : {
        pnlBps: storedContext.pnlBps, peakPnlBps: storedContext.peakPnlBps, macdHistSign: storedContext.macdHistSign, emaSpreadSign: storedContext.emaSpreadSign,
        regime: isRegimeValue(storedContext.regime) ? storedContext.regime : "unavailable",
        session: storedContext.session === "rth" || storedContext.session === "close" || storedContext.session === "overnight" ? storedContext.session : session,
        trigger: storedContext.trigger,
      };
      const trigger = evaluateExitTrigger(prior, current);
      if (trigger === null) { observe(counts, { stage: "exit-llm", code: "no-trigger", token: item.priced.position.token }); continue; }
      if (item.rfq !== undefined) {
        // R3.15 / R4.1: a loss or non-price trigger of an RFQ-only position needs a confirmed pair; a gain trigger stays single-reading.
        const verdict = rfqAsk({ trigger, pnlBps: item.pnlBps, quoteWei: item.priced.quoteOutWei, prev: item.rfq.prev, confirmFailed: item.rfq.confirmFailed, storedPeak: item.priced.position.peakPnlBps });
        if (verdict.kind === "hold") { observe(counts, { stage: "exit-llm", code: "trigger:hold-confirm", token: item.priced.position.token, reason: verdict.reason }); continue; }
        askedById.set(item.priced.position.positionId, verdict.askedPnl);
        decisionMarkById.set(item.priced.position.positionId, verdict.markQuote);
      }
      observe(counts, { stage: "exit-llm", code: `trigger:${trigger}`, token: item.priced.position.token });
      triggerById.set(item.priced.position.positionId, trigger);
      // Written only after a validated answer below: an LLM outage or off-schema
      // response must not consume the trigger, or it silently never re-asks.
      contextByPosition.set(item.priced.position.positionId, {
        askedAtMs: nowMs, pnlBps: askedById.has(item.priced.position.positionId) ? Number(askedById.get(item.priced.position.positionId)) : current.pnlBps, peakPnlBps: current.peakPnlBps, macdHistSign, emaSpreadSign, regime, session, trigger,
      });
      triggered.push(item);
    }
    if (triggered.length === 0) return;
    // AUDIT MEDIUM-1: an agent not opted into CMC must get a byte-identical
    // prompt to before this build — no header, no "unknown" market/macro
    // lines. `cryptoLeg.newsLines` is non-empty even when CMC is off (the
    // rows simply read null), so it is gated the same way as the per-ticker block.
    const dossierBlocks = settings.cmcNewsEnabled === true
      ? await cachedCmcNewsBlocks(deps, agent, triggered.map((item) => item.ticker), nowMs) : [];
    const newsBlocks = settings.cmcNewsEnabled === true ? [...cryptoLeg.newsLines, ...dossierBlocks] : [];
    const answer = await completeWithFallback(deps, settings, buildExitPrompt({
      tradfi: true,
      positions: triggered.map((item) => ({ tokenAddress: item.priced.position.token, symbol: snapshot.rowsByAddress.get(item.priced.position.token.toLowerCase())?.symbol ?? item.priced.position.token.slice(0, 8),
        pnlBps: askedById.get(item.priced.position.positionId) ?? item.pnlBps, ageSec: Math.max(0, Math.floor((nowMs - item.priced.position.openedAt) / 1_000)), takeProfitBps: settings.takeProfitBps, stopLossBps: settings.stopLossBps,
        peakPnlBps: item.priced.position.peakPnlBps, trigger: triggerById.get(item.priced.position.positionId) ?? "-", session, regime,
        indicators: describeFeatures(features.get(item.priced.position.token.toLowerCase())),
        ...(settings.maxHoldSec === null ? { maxHoldSec: null } : {}) })),
      featureBlocks: [],
      ...(newsBlocks.length === 0 ? {} : { newsBlocks }), owner: settings,
      ...(settings.maxHoldSec === null ? { timeLimitAuthority: true } : {}),
      dataRequests: dataRequestsEnabled,
    }), signal, (event) => observe(counts, { ...event, stage: "exit-llm" }));
    const decisions = validateExitResponse(answer.content, triggered.length, { allowDataRequests: dataRequestsEnabled });
    if (!decisions.ok) return;
    // TRADFI-LLM-CMC-REQUEST R3.4: right after validation, before the
    // decision loop (the lane can still return early below on a triggered
    // position). Re-passes the same held list `enqueue` already merges for free.
    if (dataRequestsEnabled && decisions.dataRequests.length > 0) {
      const llmRequests = mapAndObserveLlmDataRequests({
        counts, requests: decisions.dataRequests,
        rowFor: (index) => { const item = triggered[index]; return item === undefined ? undefined : { address: item.priced.position.token, ticker: item.ticker }; },
        dataRequestsEnabled, source: "exit", model: answer.model,
      });
      if (llmRequests.length > 0) {
        void deps.refreshCmcNews!({ agent, heldTickers: exitHeldTickers, shortlistedTickers: [], nowMs, llmRequests, ...(signal === undefined ? {} : { signal }) }).catch(() => undefined);
      }
    }
    // The answer validated: write every triggered position's ask context now,
    // whatever that position's own decision says (§3.1).
    for (const item of triggered) {
      const context = contextByPosition.get(item.priced.position.positionId);
      if (context !== undefined) await deps.positions.setExitLlmContext(agent.ownerAddress, agent.id, item.priced.position.positionId, context);
    }
    for (const decision of decisions.decisions) {
      const item = triggered[decision.index];
      if (item === undefined) continue;
      observe(counts, { stage: "exit-llm", code: decision.exit ? "exit" : "hold", model: answer.model, token: item.priced.position.token, reason: decision.reason });
      if (decision.exit) {
        // Operator ruling 2026-09-23 (implicit −8 %): a loss inside the review
        // band is sold only on a broken 1h trend or a risk_off regime.
        const guardContext = contextByPosition.get(item.priced.position.positionId);
        const guard = tradfiExitAllowed({ pnlBps: Number(askedById.get(item.priced.position.positionId) ?? item.pnlBps), regime,
          emaSpreadSign: guardContext?.emaSpreadSign ?? null, macdHistSign: guardContext?.macdHistSign ?? null });
        if (!guard.allowed) {
          observe(counts, { stage: "exit-llm", code: "hold-guard", model: answer.model, token: item.priced.position.token, reason: guard.reason });
          continue;
        }
        // The model may spend longer than the 15-second quote validity window.
        // Rebuild the executable route after inference and refuse an expired
        // quote instead of submitting the pre-prompt calldata.
        let refreshed: PricedPosition | null = null;
        const exitFacts = agent.sessionFacts;
        const exitFlashGranted = deps.dataPlane.binanceQuoteAndSwap !== undefined && exitFacts !== null && flashGuardGranted(deps, exitFacts);
        // E10: the post-model re-quote of an RFQ-only position is the Agentic sell quote, never a direct or Flash one.
        if (item.rfq !== undefined && deps.rfqStocks !== undefined) {
          const fresh = await deps.rfqStocks.quote({ agent, side: "sell", token: item.priced.position.token, amountAtomic: item.priced.balance, ...(signal === undefined ? {} : { signal }) });
          if (!fresh.ok) observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: fresh.code });
          else {
            const record = rfqQuoteRecord({ token: item.priced.position.token, amountInAtomic: item.priced.balance, quotedOutAtomic: fresh.outAtomic,
              minOutAtomic: applySlippageFloorWei(fresh.outAtomic, settings.slippageBps), nowMs: deps.now?.() ?? Date.now() });
            const { guardQuote: droppedGuard, ...withoutGuard } = item.priced;
            void droppedGuard;
            refreshed = { ...withoutGuard, quoteOutWei: record.quotedOutAtomic, venue: record.venue, route: record.route, routeKey: routeKey(record.venue, record.route) };
            observe(counts, { stage: "route", code: "binance-rfq", token: item.priced.position.token });
          }
        } else try {
          const direct = await quoteBestTradfiSell({ token: item.priced.position.token, amountInAtomic: item.priced.balance,
            slippageBps: settings.slippageBps, rpcUrls: deps.rpcUrls, ...(uniswapAllowed && deps.uniswapRouter !== undefined ? { uniswapRouter: deps.uniswapRouter } : {}),
            ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }), ...(signal === undefined ? {} : { signal }) });
          const { guardQuote: ignoredGuard, ...withoutGuard } = item.priced;
          void ignoredGuard;
          refreshed = { ...withoutGuard, quoteOutWei: direct.quotedOutAtomic, venue: direct.venue, route: direct.route,
            routeKey: routeKey(direct.venue, direct.route) };
          if (exitFlashGranted && directSellEscape.has(item.priced.position.positionId)) {
            // AUDIT HIGH-1: the escape must also be checked here — a
            // blank-threshold exit (no time limit; the LLM decides) is decided
            // at THIS site, never the main loop, so a check only at the main
            // loop's comparison never protects it. Peek only; `sellPosition`
            // consumes it on the actual direct attempt below.
            observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: "escape-after-guard-failure" });
          } else if (exitFlashGranted) {
            try {
              const flashReq = { tokenIn: item.priced.position.token, tokenOut: USDT_56, amountAtomic: item.priced.balance.toString(10) };
              const flash = await deps.dataPlane.binanceQuoteAndSwap!(flashRequest({ ...flashReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
              const accepted = acceptFlashQuote({ request: flashReq, flash, facts: exitFacts!, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
              if (!accepted.ok) {
                observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: accepted.code });
              } else if (BigInt(flash.quotedOutAtomic) < direct.minOutAtomic) {
                // R2.1 (H1a): the same sell direct-floor rail as the main exit loop.
                observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: "direct-floor" });
              } else {
                const route = { hops: [], fees: [100] as const };
                const candidate = { venue: "pancake_v3" as const, router: flash.router, route,
                  quotedOutAtomic: BigInt(flash.quotedOutAtomic), minOutAtomic: BigInt(flash.minOutAtomic), expiresAt: flash.expiresAt };
                // M1: the same cost inputs the main exit loop uses — kept as the
                // pre-flight, the only pre-submission signal a guard call would
                // be refused or revert.
                const aggregatorCost = deps.tradfiNativeCostUsdtAtomic === undefined ? null : await deps.tradfiNativeCostUsdtAtomic({
                  agent, tokenIn: item.priced.position.token, tokenOut: USDT_56, amountInAtomic: item.priced.balance, venue: candidate.venue, route: candidate.route,
                  calls: buildV2CostCalls({ quote: candidate, token: item.priced.position.token, amountInAtomic: item.priced.balance, wallet: agent.walletAddress, feeAtomic: 0n, side: "sell", guardQuote: accepted.guardQuote }), ...(signal === undefined ? {} : { signal }) });
                if (aggregatorCost === null) {
                  observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: "cost-unavailable" });
                } else {
                  // G1/P-a: Binance wins whenever usable — no net-price ranking against direct.
                  refreshed = { ...withoutGuard, quoteOutWei: candidate.quotedOutAtomic, venue: "pancake_v3" as const, route,
                    routeKey: routeKey("pancake_v3", route), guardQuote: accepted.guardQuote };
                  observe(counts, { stage: "route", code: "binance-guard", token: item.priced.position.token });
                }
              }
            } catch (error) { observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: flashProxyReason(error) }); /* the fresh direct quote remains executable */ }
          }
        } catch {
          // R2.9 (M4): this fallback used to run with no local catch, so one
          // Flash failure here aborted every remaining position's decision at
          // the function-level catch (C6).
          if (exitFlashGranted) {
            try {
              const flashReq = { tokenIn: item.priced.position.token, tokenOut: USDT_56, amountAtomic: item.priced.balance.toString(10) };
              const flash = await deps.dataPlane.binanceQuoteAndSwap!(flashRequest({ ...flashReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
              const accepted = acceptFlashQuote({ request: flashReq, flash, facts: exitFacts!, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
              if (!accepted.ok) {
                observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: accepted.code });
              } else {
                const route = { hops: [], fees: [100] as const };
                refreshed = { ...item.priced, quoteOutWei: BigInt(flash.quotedOutAtomic), venue: "pancake_v3" as const, route,
                  routeKey: routeKey("pancake_v3", route), guardQuote: accepted.guardQuote };
                observe(counts, { stage: "route", code: "binance-guard", token: item.priced.position.token });
              }
            } catch (error) { observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: flashProxyReason(error) }); }
          }
        }
        if (refreshed !== null) {
          if (item.rfq !== undefined) {
            // R5.1 / R5.1.1: the sale quote must not sit below the owner's own slippage floor of the quote behind the asked pnl; a hold lasts to the next model-approved sale within 900 s and is cleared only by a dispatch.
            const key = `${agent.id}:${item.priced.position.positionId}`, heldAt = rfqAskedMarkEscape.get(key), mark = decisionMarkById.get(item.priced.position.positionId);
            const honoured = heldAt !== undefined && nowMs - heldAt <= RUG_QUOTE_WINDOW_MS;
            if (!honoured && mark !== undefined && refreshed.quoteOutWei < applySlippageFloorWei(mark, settings.slippageBps)) {
              rfqAskedMarkEscape.set(key, nowMs);
              observe(counts, { stage: "route", code: "binance-refused", token: item.priced.position.token, reason: "asked-mark" });
              continue;
            }
            rfqAskedMarkEscape.delete(key);
          }
          await sellPosition(deps, agent, settings, refreshed, "llm", counts, signal, decision.reason);
        }
      }
    }
  } catch {
    observe(counts, { stage: "exit-llm", code: "unavailable-hold" });
  }
}

type V2CostQuote = { readonly venue: TradeVenueId; readonly router: Address; readonly route: TradeRoute; readonly minOutAtomic: bigint; readonly quotedOutAtomic?: bigint; readonly expiresAt: number };

/** USDT v2 entry lane. Legacy/native requests stay on the function above. */
function buildV2CostCalls(input: {
  readonly quote: V2CostQuote;
  readonly token: Address;
  readonly amountInAtomic: bigint;
  readonly wallet: Address;
  readonly feeAtomic: bigint;
  readonly side?: "buy" | "sell";
  readonly treasury?: Address;
  readonly guardQuote?: TradeRequest["guardQuote"];
  /** AUTO-DCA R2.3 item 1: calls appended to the priced batch (the DCA mints); absent ⇒ unchanged. */
  readonly extraCallsFor?: (quote: V2CostQuote) => readonly WalletCall[];
}): readonly WalletCall[] {
  const deadline = BigInt(Math.floor(input.quote.expiresAt / 1_000));
  const tokenIn = input.side === "sell" ? input.token : USDT_56;
  const tokenOut = input.side === "sell" ? USDT_56 : input.token;
  const common = { tokenIn, tokenOut, amountInWei: input.amountInAtomic, minOutWei: input.quote.minOutAtomic,
    recipient: input.wallet, deadline, route: input.quote.route };
  let swap: readonly WalletCall[];
  if (input.guardQuote !== undefined) {
    swap = [...buildTradfiApprove(tokenIn, input.guardQuote.guard, input.amountInAtomic), buildTradfiGuardSwapCall({ guard: input.guardQuote.guard,
      router: input.guardQuote.router, spender: input.guardQuote.spender, canonicalUSDT: USDT_56, tokenIn, tokenOut,
      amountInWei: input.amountInAtomic, minOutWei: input.quote.minOutAtomic, deadline: input.guardQuote.deadline, calldata: input.guardQuote.calldata })];
  } else if (input.quote.venue === "pancake_v3") swap = buildTradfiPancakeV3Swap({ router: input.quote.router, ...common });
  else if (input.quote.venue === "uniswap_v3") swap = buildTradfiUniswapV3Swap({ router: input.quote.router, ...common });
  else swap = buildTradfiPancakeV2Swap({ router: input.quote.router, ...common });
  const calls = input.feeAtomic > 0n && input.treasury !== undefined
    ? [...swap, ...buildTradfiPlatformFee({ usdt: USDT_56, treasury: input.treasury, amountWei: input.feeAtomic })]
    : swap;
  return input.extraCallsFor === undefined ? calls : [...calls, ...input.extraCallsFor(input.quote)];
}

/** Exported for the DCA executor's fence re-read (R2.10, condition 12); `null` is unreadable. */
export async function readTradfiV2QuoteRemaining(
  deps: Pick<TradeWorkerDeps, "provider">,
  agent: AgentRecord,
  facts: NonNullable<AgentRecord["sessionFacts"]>,
  signal?: AbortSignal,
): Promise<bigint | null> {
  const granted = facts.spec.spendCaps.filter((cap) => cap.token?.toLowerCase() === USDT_56.toLowerCase() && cap.period === "day");
  if (granted.length !== 1 || granted[0]!.limit <= 0n || deps.provider.readSpendInfos === undefined) return null;
  const infos = await deps.provider.readSpendInfos({ walletAddress: agent.walletAddress, publicKey: facts.publicKey,
    ...(signal === undefined ? {} : { signal }) });
  if (infos.some((row) => row.period === "unknown")) return null;
  const matches = infos.filter((row) => row.token?.toLowerCase() === USDT_56.toLowerCase() && row.period === "day");
  if (matches.length !== 1) return null;
  const row: SpendInfoReading = matches[0]!;
  if (row.limitWei !== granted[0]!.limit || row.currentSpentWei < 0n || row.currentSpentWei > row.limitWei) return null;
  return row.limitWei - row.currentSpentWei;
}

function maxTradfiV2DebitAmount(cashWei: bigint, feeBps: number): bigint {
  if (cashWei <= 0n) return 0n;
  let low = 0n;
  let high = cashWei;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (tradfiV2EntryReservation(middle, feeBps) <= cashWei) low = middle;
    else high = middle - 1n;
  }
  return low;
}

export async function tradfiActualPremiumAllowed(input: {
  readonly deps: TradeWorkerDeps;
  readonly fact: RwaFact | undefined;
  readonly token: Address;
  readonly amountInAtomic: bigint;
  readonly amountOutAtomic: bigint;
  readonly settlementUsd: number;
  readonly maxPremiumBps?: number;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (input.fact === undefined || input.amountInAtomic <= 0n || input.amountOutAtomic <= 0n) return false;
  if (input.deps.provider.getTokenMetadata === undefined) return false;
  const metadata = await input.deps.provider.getTokenMetadata({ token: input.token, ...(input.signal === undefined ? {} : { signal: input.signal }) });
  if (!Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 36 || !Number.isFinite(input.settlementUsd) || input.settlementUsd <= 0) return false;
  const fact = input.fact;
  const reference = fact.referencePriceUsd;
  const ratio = fact.tokenToShareRatio;
  const inputUnits = Number(input.amountInAtomic) / 10 ** 18;
  const outputUnits = Number(input.amountOutAtomic) / 10 ** metadata.decimals;
  if (reference === null || ratio === null || !Number.isFinite(reference) || !Number.isFinite(ratio)
    || reference <= 0 || ratio <= 0 || !Number.isFinite(inputUnits) || !Number.isFinite(outputUnits) || outputUnits <= 0) return false;
  const premiumBps = Math.round((inputUnits * input.settlementUsd / outputUnits / (reference * ratio) - 1) * 10_000);
  return Number.isFinite(premiumBps) && premiumBps <= (input.maxPremiumBps ?? RWA_MAX_PREMIUM_BPS);
}

type SubmitTradfiV2BuyInput = {
  readonly candidate: EntryCandidate;
  readonly amount: bigint;
  readonly snapshot: RwaLaneSnapshot;
  readonly settlementUsd: number;
  readonly uniswapAllowed: boolean;
  readonly budget: bigint;
  readonly spendableUsdt: bigint;
  readonly maxPremiumBps?: number;
  readonly scheduleSlot?: number;
  readonly portfolioSlot?: number;
  readonly fenceGuard?: (sql: SqlClient | undefined) => Promise<boolean | string>;
  /** AGENTIC-RFQ-STOCKS E8: set only for an RFQ-only candidate of an RFQ-active agent; priced by the Agentic quote (E9). */
  readonly rfq?: boolean;
};

async function portfolioFence(
  deps: TradeWorkerDeps, agent: AgentRecord, settings: EffectiveTradeSettings, slot: number,
  token: Address, amount: bigint | null, sql: SqlClient | undefined,
): Promise<string | null> {
  const pending = await deps.intents.listUnsettled(agent.ownerAddress, agent.id, sql);
  for (const intent of pending) {
    const journal = await deps.journal.get(intent.idempotencyKey);
    if (journal?.state === "UNKNOWN") return "portfolio_submission_unknown";
    return "portfolio_pending_intent";
  }
  const row = await deps.settingsStore.get(agent.ownerAddress, agent.id, sql);
  if (row === null) return "settings_changed";
  const parsed = parseTradeSettings(row.params);
  if (!parsed.ok || !isTradePortfolioSettings(parsed.value.effective)
    || canonicalEncode(parsed.value.raw) !== canonicalEncode(settings)) return "settings_changed";
  const current = await deps.agentStore.getAgentById(agent.id);
  if (current?.status !== "armed") return "paused";
  if (current.sessionFacts === null || current.sessionFacts.generation !== agent.sessionFacts?.generation) return "session_changed";
  const liveNow = deps.now?.() ?? Date.now();
  const liveClamp = current.sessionFacts.grantedAtSec === undefined ? current.createdAt : current.sessionFacts.grantedAtSec * 1_000;
  const liveWindow = current.sessionFacts.expiry * 1_000 - liveClamp;
  if (current.sessionFacts.expiry * 1_000 - liveNow <= Math.min(SESSION_ENTRY_CUTOFF_MS, Math.max(0, liveWindow / 2))) return "session_changed";
  if (currentSlot(agent.createdAt, settings.portfolioIntervalSec!, liveNow) !== slot) return "portfolio_slot_changed";
  if (deps.intents.getPortfolioCheck === undefined || deps.intents.listPortfolio === undefined) return "portfolio_slot_done";
  const check = await deps.intents.getPortfolioCheck(agent.ownerAddress, agent.id, slot, sql);
  if (check?.state !== "rebalancing") return check?.state === "held" ? "portfolio_slot_held" : "portfolio_slot_done";
  const ledger = await deps.intents.listPortfolio(agent.ownerAddress, agent.id, sql);
  if (ledger.some((intent) => intent.portfolioSlot === slot && intent.token.toLowerCase() === token.toLowerCase())) return "portfolio_leg_taken";
  if (amount !== null) {
    const invested = ledger.reduce((total, intent) => total + (intent.side === "buy" ? intent.entryWei : -(intent.portfolioProceedsAtomic ?? 0n)), 0n);
    if (amount > BigInt(settings.capitalQuoteWei!) - invested) return "portfolio_capital_exhausted";
  }
  return null;
}

type PriceTradfiV2BuyInput = Pick<SubmitTradfiV2BuyInput, "candidate" | "amount" | "snapshot" | "settlementUsd" | "uniswapAllowed" | "maxPremiumBps" | "rfq">;

/**
 * AGENTIC-RFQ-STOCKS E9: an RFQ-only buy is priced by the Agentic `market-order quote` (the source the executor re-checks), never by a direct, cost or Flash step:
 * the buy quote, the executed-quote premium (cap 150 bps), an exit quote for what the buy would return (no bound on the round trip, D2), and `minOut = Q x (1 - slippage)`.
 */
async function priceRfqBuy(deps: TradeWorkerDeps, agent: AgentRecord, settings: EffectiveTradeSettings, input: PriceTradfiV2BuyInput, counts: MutableCounts,
  signal?: AbortSignal): Promise<{ readonly quote: Awaited<ReturnType<typeof quoteBestTradfiBuy>>; readonly rfq: true } | "no-route"> {
  const { candidate, amount, snapshot, settlementUsd } = input;
  const refuse = (reason: string): "no-route" => { observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason }); counts.refusals += 1; return "no-route"; };
  const bought = await deps.rfqStocks!.quote({ agent, side: "buy", token: candidate.address, amountAtomic: amount, ...(signal === undefined ? {} : { signal }) });
  if (!bought.ok) return refuse(bought.code);
  if (!await tradfiActualPremiumAllowed({ deps, fact: snapshot.facts.get(candidate.address.toLowerCase()), token: candidate.address, amountInAtomic: amount, amountOutAtomic: bought.outAtomic,
    settlementUsd, ...(input.maxPremiumBps === undefined ? {} : { maxPremiumBps: input.maxPremiumBps }), ...(signal === undefined ? {} : { signal }) })) return refuse("premium");
  const exit = await deps.rfqStocks!.quote({ agent, side: "sell", token: candidate.address, amountAtomic: bought.outAtomic, ...(signal === undefined ? {} : { signal }) });
  if (!exit.ok || exit.outAtomic <= 0n) return refuse(`no-exit:${exit.ok ? "zero" : exit.code}`);
  const minOut = bought.outAtomic * BigInt(10_000 - settings.slippageBps) / 10_000n;
  if (minOut <= 0n) { counts.refusals += 1; return "no-route"; }
  const nowMs = deps.now?.() ?? Date.now();
  observe(counts, { stage: "route", code: "binance-rfq", token: candidate.address, reason: `premium-ok;exit=${exit.outAtomic}` });
  return { quote: rfqQuoteRecord({ token: candidate.address, amountInAtomic: amount, quotedOutAtomic: bought.outAtomic, minOutAtomic: minOut, nowMs }), rfq: true };
}

/**
 * The v2 buy pricing block of {@link submitTradfiV2Buy}, extracted verbatim
 * (AUTO-DCA R2.3 item 1, REVIEW2 N14 / condition 11): direct quote, executable
 * premium, relay cost, guard preference, Flash fallback, and every run-log
 * observation and refusal count that block made. `extraCallsFor` appends calls
 * to each priced batch (the DCA mints), so the relay prices the whole mixed
 * batch in the same `prepareCalls` round trip; absent, nothing changes.
 */
async function priceTradfiV2Buy(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  input: PriceTradfiV2BuyInput,
  facts: NonNullable<AgentRecord["sessionFacts"]>,
  counts: MutableCounts,
  signal?: AbortSignal,
  extraCallsFor?: (quote: V2CostQuote) => readonly WalletCall[],
): Promise<{ readonly quote: Awaited<ReturnType<typeof quoteBestTradfiBuy>>; readonly guardQuote?: TradeRequest["guardQuote"]; readonly nativeCostWei?: bigint; readonly rfq?: true } | "no-route"> {
  if (input.rfq === true && deps.rfqStocks !== undefined) return priceRfqBuy(deps, agent, settings, input, counts, signal);
  const { candidate, amount, snapshot, settlementUsd, uniswapAllowed } = input;
  const extra = extraCallsFor === undefined ? {} : { extraCallsFor };
  // A DCA start (the one caller with `extraCallsFor`) carries no platform fee.
  const feeBps = extraCallsFor === undefined ? deps.platformFeeBps : DCA_PLATFORM_FEE_BPS;
  let quote: Awaited<ReturnType<typeof quoteBestTradfiBuy>>;
  let guardQuote: TradeRequest["guardQuote"] | undefined;
  let selectedCostUsdt: bigint | null = null;
  // AUTO-DCA audit M-3: a DCA start (the one caller with `extraCallsFor`) prices
  // through the wei oracle and keeps the SELECTED offer's native-wei quote, so
  // its submit makes no second relay quote inside the guard window.
  const weiOracle = extraCallsFor === undefined ? undefined : deps.dca?.batchCostWei;
  let lastCostWei: bigint | null = null;
  let selectedCostWei: bigint | null = null;
  const costUsdt = async (request: Parameters<NonNullable<TradeWorkerDeps["tradfiNativeCostUsdtAtomic"]>>[0]): Promise<bigint | null> => {
    if (weiOracle === undefined) return deps.tradfiNativeCostUsdtAtomic!(request);
    lastCostWei = await weiOracle({ agent, calls: request.calls });
    if (lastCostWei === null) return null;
    const costFacts = freshNativeCostFacts(await deps.dataPlane.tokensBatch([WBNB_56, USDT_56]), Date.now());
    return costFacts === null ? null : nativeCostToUsdtAtomic(lastCostWei, costFacts);
  };
  try {
    quote = await quoteBestTradfiBuy({ token: candidate.address, amountInAtomic: amount, slippageBps: settings.slippageBps,
      rpcUrls: deps.rpcUrls, ...(candidate.venues === undefined ? {} : { venues: candidate.venues }), ...(uniswapAllowed && deps.uniswapRouter !== undefined ? { uniswapRouter: deps.uniswapRouter } : {}),
      ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }), ...(signal === undefined ? {} : { signal }) });
    if (!await tradfiActualPremiumAllowed({ deps, fact: snapshot.facts.get(candidate.address.toLowerCase()), token: candidate.address,
      amountInAtomic: amount, amountOutAtomic: quote.quotedOutAtomic, settlementUsd, ...(input.maxPremiumBps === undefined ? {} : { maxPremiumBps: input.maxPremiumBps }), ...(signal === undefined ? {} : { signal }) })) throw new Error("reference-premium");
    selectedCostUsdt = await costUsdt({ agent, tokenIn: USDT_56, tokenOut: candidate.address, amountInAtomic: amount, venue: quote.venue, route: quote.route,
      calls: buildV2CostCalls({ quote, token: candidate.address, amountInAtomic: amount, wallet: agent.walletAddress, feeAtomic: tradfiV2BuyFeeWei(amount, feeBps),
        ...(deps.platformFeeTreasury === undefined ? {} : { treasury: deps.platformFeeTreasury }), ...extra }), ...(signal === undefined ? {} : { signal }) });
    if (selectedCostUsdt === null) throw new Error("cost-unavailable");
    selectedCostWei = lastCostWei;
    const buyFlashGranted = deps.dataPlane.binanceQuoteAndSwap !== undefined && flashGuardGranted(deps, facts);
    if (buyFlashGranted) {
      try {
        const flashReq = { tokenIn: USDT_56, tokenOut: candidate.address, amountAtomic: amount.toString(10) };
        const flash = await deps.dataPlane.binanceQuoteAndSwap!(flashRequest({ ...flashReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
        const accepted = acceptFlashQuote({ request: flashReq, flash, facts, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
        if (!accepted.ok) {
          observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: accepted.code });
        } else {
          const candidateGuard = accepted.guardQuote;
          const aggregatorQuote = { venue: "pancake_v3" as const, router: flash.router, route: { hops: [], fees: [100] as const },
            settlementToken: USDT_56, token: candidate.address, amountInAtomic: amount,
            minOutAtomic: BigInt(flash.minOutAtomic), quotedOutAtomic: BigInt(flash.quotedOutAtomic), observedAt: flash.observedAt, expiresAt: flash.expiresAt };
          const aggregatorCost = await costUsdt({ agent, tokenIn: USDT_56, tokenOut: candidate.address, amountInAtomic: amount,
            venue: aggregatorQuote.venue, route: aggregatorQuote.route, calls: buildV2CostCalls({ quote: aggregatorQuote, token: candidate.address, amountInAtomic: amount,
              wallet: agent.walletAddress, feeAtomic: tradfiV2BuyFeeWei(amount, feeBps), ...(deps.platformFeeTreasury === undefined ? {} : { treasury: deps.platformFeeTreasury }), guardQuote: candidateGuard, ...extra }),
            estimatedNativeCostWei: BigInt(flash.estimatedGasUnits) * BigInt(flash.gasPriceWei), ...(signal === undefined ? {} : { signal }) });
          if (aggregatorCost === null || !await tradfiActualPremiumAllowed({ deps, fact: snapshot.facts.get(candidate.address.toLowerCase()), token: candidate.address,
            amountInAtomic: amount, amountOutAtomic: aggregatorQuote.quotedOutAtomic, settlementUsd, ...(input.maxPremiumBps === undefined ? {} : { maxPremiumBps: input.maxPremiumBps }), ...(signal === undefined ? {} : { signal }) })) {
            observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: aggregatorCost === null ? "cost-unavailable" : "premium" });
          } else {
            // G1/P-a: Binance wins whenever usable — no net-price ranking against
            // direct. Buys get no rail (R2.1): `tradfiActualPremiumAllowed` above
            // already bounds the executed Flash price against the reference.
            quote = aggregatorQuote; guardQuote = candidateGuard; selectedCostUsdt = aggregatorCost; selectedCostWei = lastCostWei;
          }
        }
      } catch (error) { observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: flashProxyReason(error) }); /* direct AMM remains the admissible route when Flash is unavailable */ }
    }
  } catch {
    if (deps.dataPlane.binanceQuoteAndSwap === undefined || !flashGuardGranted(deps, facts)) { counts.refusals += 1; return "no-route"; }
    try {
      const flashReq = { tokenIn: USDT_56, tokenOut: candidate.address, amountAtomic: amount.toString(10) };
      const flash = await deps.dataPlane.binanceQuoteAndSwap!(flashRequest({ ...flashReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
      const accepted = acceptFlashQuote({ request: flashReq, flash, facts, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
      if (!accepted.ok) { observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: accepted.code }); throw new Error("guard unavailable"); }
      quote = { venue: "pancake_v3" as const, router: flash.router, route: { hops: [], fees: [100] as const }, minOutAtomic: BigInt(flash.minOutAtomic), quotedOutAtomic: BigInt(flash.quotedOutAtomic), expiresAt: flash.expiresAt,
        settlementToken: USDT_56, token: candidate.address, amountInAtomic: amount, observedAt: flash.observedAt };
      if (!await tradfiActualPremiumAllowed({ deps, fact: snapshot.facts.get(candidate.address.toLowerCase()), token: candidate.address,
          amountInAtomic: amount, amountOutAtomic: quote.quotedOutAtomic, settlementUsd, ...(input.maxPremiumBps === undefined ? {} : { maxPremiumBps: input.maxPremiumBps }), ...(signal === undefined ? {} : { signal }) })) {
        observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: "premium" }); throw new Error("reference-premium");
      }
      guardQuote = accepted.guardQuote;
      selectedCostUsdt = await costUsdt({ agent, tokenIn: USDT_56, tokenOut: candidate.address, amountInAtomic: amount,
        venue: quote.venue, route: quote.route, calls: buildV2CostCalls({ quote, token: candidate.address, amountInAtomic: amount, wallet: agent.walletAddress,
          feeAtomic: tradfiV2BuyFeeWei(amount, feeBps), ...(deps.platformFeeTreasury === undefined ? {} : { treasury: deps.platformFeeTreasury }), guardQuote, ...extra }),
        estimatedNativeCostWei: BigInt(flash.estimatedGasUnits) * BigInt(flash.gasPriceWei), ...(signal === undefined ? {} : { signal }) });
      if (selectedCostUsdt === null) { observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: "cost-unavailable" }); throw new Error("cost-unavailable"); }
      selectedCostWei = lastCostWei;
    } catch (error) {
      if (!isRouteRefusalSentinel(error)) observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: flashProxyReason(error) });
      counts.refusals += 1; return "no-route";
    }
  }
  observe(counts, { stage: "route", code: guardQuote === undefined ? quote.venue : "binance-guard", token: candidate.address,
    reason: `cost-comparison:${selectedCostUsdt?.toString(10) ?? "unavailable"}` });
  return { quote, ...(guardQuote === undefined ? {} : { guardQuote }), ...(selectedCostWei === null ? {} : { nativeCostWei: selectedCostWei }) };
}

/** Shared v2 buy submission block; schedule mode supplies only its slot fence and premium ceiling. */
async function submitTradfiV2Buy(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  input: SubmitTradfiV2BuyInput,
  counts: MutableCounts,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const { candidate, amount, budget, spendableUsdt } = input;
  const facts = agent.sessionFacts;
  if (facts === null) return "settings-invalid";
  const reservation = tradfiV2EntryReservation(amount, deps.platformFeeBps);
  if (reservation > budget || amount > spendableUsdt) { counts.refusals += 1; return "entry-budget-too-small"; }
  const priced = await priceTradfiV2Buy(deps, agent, settings, input, facts, counts, signal);
  if (priced === "no-route") return "no-route";
  const { quote, guardQuote } = priced;
  if (dryRun) return "dry-run";
  const request: TradeRequest = { decisionId: randomUUID(), venue: tradeVenue(quote.venue), side: "buy", token: candidate.address,
    amountWei: amount, quotedOutWei: quote.quotedOutAtomic, minOutWei: quote.minOutAtomic, route: quote.route,
    settlementAsset: "USDT", platformFeeAtomic: tradfiV2BuyFeeWei(amount, deps.platformFeeBps), ...(guardQuote === undefined ? {} : { guardQuote }) };
  const fenced = await deps.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async (sql) => {
    if (input.portfolioSlot !== undefined) {
      if (input.fenceGuard === undefined) return { kind: "denied" as const, status: 409, code: "portfolio_pending_intent", meta: {} };
      const allowed = await input.fenceGuard(sql);
      if (allowed !== true) return { kind: "denied" as const, status: 409, code: allowed === false ? "schedule_slot_taken" : allowed, meta: {} };
    }
    const currentSettingsRow = await deps.settingsStore.get(agent.ownerAddress, agent.id, sql);
    if (currentSettingsRow === null) return { kind: "denied" as const, status: 409, code: "settings_changed", meta: {} };
    const currentSettings = settingsFrom(currentSettingsRow.params);
    if (!isTradfiV2Settings(currentSettings) || amount < BigInt(currentSettings.minEntryWei!) || amount > BigInt(currentSettings.entryWei)) {
      return { kind: "denied" as const, status: 409, code: "settings_changed", meta: {} };
    }
    // R2.8 (LOW-5): a schedule buy also re-reads the six schedule fields an owner edit can
    // change (§2.2 step 9); any difference from what this cycle used denies the same way.
    if (isTradeScheduleSettings(settings) && (!isTradeScheduleSettings(currentSettings)
      || currentSettings.scheduleMaxPremiumBps !== settings.scheduleMaxPremiumBps
      || currentSettings.scheduleMarketHoursOnly !== settings.scheduleMarketHoursOnly
      || currentSettings.scheduleEndKind !== settings.scheduleEndKind
      || currentSettings.scheduleEndAtSec !== settings.scheduleEndAtSec
      || currentSettings.scheduleEndRuns !== settings.scheduleEndRuns
      || currentSettings.slippageBps !== settings.slippageBps)) {
      return { kind: "denied" as const, status: 409, code: "settings_changed", meta: {} };
    }
    if (input.portfolioSlot === undefined && input.fenceGuard !== undefined) {
      const allowed = await input.fenceGuard(sql);
      if (allowed !== true) return { kind: "denied" as const, status: 409, code: allowed === false ? "schedule_slot_taken" : allowed, meta: {} };
    }
    const currentAgent = await deps.agentStore.getAgentById(agent.id);
    if (currentAgent === null || currentAgent.sessionFacts === null) return { kind: "denied" as const, status: 409, code: "session_changed", meta: {} };
    const liveNow = deps.now?.() ?? Date.now();
    const liveRemaining = currentAgent.sessionFacts.expiry * 1_000 - liveNow;
    const liveClamp = currentAgent.sessionFacts.grantedAtSec === undefined ? currentAgent.createdAt : currentAgent.sessionFacts.grantedAtSec * 1_000;
    const liveWindow = currentAgent.sessionFacts.expiry * 1_000 - liveClamp;
    if (liveRemaining <= Math.min(SESSION_ENTRY_CUTOFF_MS, Math.max(0, liveWindow / 2))) return { kind: "denied" as const, status: 409, code: "session_changed", meta: {} };
    const liveDataReserveBefore = deps.v2DataBudgetReservedWei === undefined ? 0n : await deps.v2DataBudgetReservedWei(currentAgent);
    if (liveDataReserveBefore === null || liveDataReserveBefore < 0n) return { kind: "denied" as const, status: 409, code: "entry_budget_changed", meta: {} };
    const livePendingBefore = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(currentAgent.id, 0);
    const liveQuoteRemainingRaw = await readTradfiV2QuoteRemaining(deps, currentAgent, currentAgent.sessionFacts, signal);
    const liveWalletUsdt = await deps.provider.getTokenBalance({ wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 }, token: USDT_56, ...(signal === undefined ? {} : { signal }) });
    const liveDataReserveAfter = deps.v2DataBudgetReservedWei === undefined ? 0n : await deps.v2DataBudgetReservedWei(currentAgent);
    if (liveDataReserveAfter === null || liveDataReserveAfter < 0n) return { kind: "denied" as const, status: 409, code: "entry_budget_changed", meta: {} };
    const liveDataReserve = liveDataReserveBefore > liveDataReserveAfter ? liveDataReserveBefore : liveDataReserveAfter;
    const livePendingAfter = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(currentAgent.id, 0);
    const livePending = livePendingBefore > livePendingAfter ? livePendingBefore : livePendingAfter;
    const liveQuoteRemaining = liveQuoteRemainingRaw === null || liveQuoteRemainingRaw <= livePending ? 0n : liveQuoteRemainingRaw - livePending;
    const liveCashProtected = liveDataReserve + livePending;
    const liveSpendable = liveWalletUsdt > liveCashProtected ? liveWalletUsdt - liveCashProtected : 0n;
    if (liveQuoteRemainingRaw === null || reservation > liveQuoteRemaining || reservation > liveSpendable) return { kind: "denied" as const, status: 409, code: "entry_budget_changed", meta: {} };
    const identity = deps.executionIdentity(agent, request);
    const intent = await deps.intents.create({ decisionId: request.decisionId, idempotencyKey: identity.idempotencyKey, agentId: agent.id,
      ownerAddress: agent.ownerAddress, side: "buy", token: candidate.address, route: quote.route, venue: quote.venue,
      amountWei: amount, entryWei: reservation, positionId: request.decisionId, closeReason: null, settlementAsset: "USDT",
      ...(request.platformFeeAtomic === undefined ? {} : { platformFeeAtomic: request.platformFeeAtomic }), minOutAtomic: quote.minOutAtomic, quotedOutAtomic: quote.quotedOutAtomic,
      ...(input.scheduleSlot === undefined ? {} : { scheduleSlot: input.scheduleSlot }),
      ...(input.portfolioSlot === undefined ? {} : { portfolioSlot: input.portfolioSlot }) });
    const result = await execute(deps, agent, request, { async evaluate() { return { verdict: "allow", reasons: candidate.scanReasons }; } }, signal);
    if (result.kind === "committed" && result.receipt.transactionHash !== undefined) {
      await deps.intents.markSubmitted(agent.ownerAddress, agent.id, intent.decisionId, result.receipt.transactionHash);
      const fill = result.fill?.side === "buy" ? result.fill : { side: "buy" as const, entryWei: amount, tokenAmount: null, fillStatus: "unverified" as const };
      await projectIntent(deps, agent, intent, result.receipt.transactionHash, fill, signal);
    } else if (input.portfolioSlot !== undefined && result.kind === "committed") {
      await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
    } else if (input.portfolioSlot !== undefined && (result.kind === "denied" || result.kind === "rolled-back")) {
      const released = result.kind === "denied" ? result.code !== "conflict" : result.meta["deniedBy"] !== undefined && result.meta["replayed"] !== true;
      if (released) await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId, resultCode(result));
      else await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
    } else if (result.kind === "denied" || result.kind === "rolled-back") await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId, resultCode(result));
    return result;
  });
  if (fenced.kind === "draining") return "draining";
  // Run log (2026-09-24): the buy itself, with size and venue, so the Trades view can show it.
  const usdtText = (Number(amount / 10n ** 14n) / 10_000).toFixed(2);
  const via = guardQuote === undefined && priced.rfq !== true ? quote.venue : "binance-aggregator";
  if (fenced.value.kind === "committed") {
    counts.entries += 1;
    observe(counts, { stage: "buy", code: "committed", token: candidate.address, reason: `${usdtText} USDT via ${via}` });
    return "entered";
  }
  // AGENTIC-RECEIPT-WAIT F2: an unknown submission may have landed; the marker keeps this run through the 200-run prune.
  if (fenced.value.kind === "unknown") observe(counts, { stage: "buy", code: "unknown", token: candidate.address, reason: `${usdtText} USDT via ${via}` });
  return resultCode(fenced.value);
}

async function runTradfiV2Entry(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: EffectiveTradeSettings,
  counts: MutableCounts,
  nowMs: number,
  snapshot: RwaLaneSnapshot,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const facts = agent.sessionFacts;
  if (facts === null || settings.minEntryWei === undefined || settings.capitalQuoteWei === undefined) return "settings-invalid";
  const minEntry = BigInt(settings.minEntryWei);
  const open = await deps.positions.listOpen(agent.ownerAddress, agent.id);
  if (open.length >= settings.maxOpenPositions) return "at-capacity";
  // §4: overnight caps open positions tighter than the owner's own setting.
  if (sessionState(nowMs) === "overnight" && open.length >= Math.min(settings.maxOpenPositions, 3)) return "at-capacity";
  // Read the live CMC exposure before the wallet balance. A payment can settle
  // between these reads, so bracket the wallet read and keep the larger
  // exposure as the conservative cash reserve.
  const dataReservedBefore = deps.v2DataBudgetReservedWei === undefined ? 0n : await deps.v2DataBudgetReservedWei(agent);
  if (dataReservedBefore === null || dataReservedBefore < 0n) return "data-budget-unavailable";
  const pendingQuoteBefore = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n
    : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const usdtBalance = await deps.provider.getTokenBalance({ wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 }, token: USDT_56,
    ...(signal === undefined ? {} : { signal }) });
  const settlementRows = await deps.dataPlane.tokensBatch([USDT_56], signal);
  const settlementRow = settlementRows.find((row) => row.address.toLowerCase() === USDT_56.toLowerCase());
  const settlementUsd = freshTokenUsdFact(settlementRow, Date.now());
  if (settlementUsd === null) return "settlement-price-unavailable";
  const dataReservedAfter = deps.v2DataBudgetReservedWei === undefined ? 0n : await deps.v2DataBudgetReservedWei(agent);
  if (dataReservedAfter === null || dataReservedAfter < 0n) return "data-budget-unavailable";
  const dataReserved = dataReservedBefore > dataReservedAfter ? dataReservedBefore : dataReservedAfter;
  const pendingQuoteAfter = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n
    : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const pendingQuote = pendingQuoteBefore > pendingQuoteAfter ? pendingQuoteBefore : pendingQuoteAfter;
  const chainQuoteRemaining = await readTradfiV2QuoteRemaining(deps, agent, facts, signal);
  if (chainQuoteRemaining === null) return "quote-meter-unavailable";
  const quoteRemaining = chainQuoteRemaining > pendingQuote ? chainQuoteRemaining - pendingQuote : 0n;
  const cashProtected = dataReserved + pendingQuote;
  const spendableUsdt = usdtBalance > cashProtected ? usdtBalance - cashProtected : 0n;
  const budget = [BigInt(settings.capitalQuoteWei), quoteRemaining, spendableUsdt].reduce((left, right) => left < right ? left : right, 1n << 256n);
  const persistedQuotePerTrade = facts.hireSizing?.quotePerTradeWei === undefined ? null : BigInt(facts.hireSizing.quotePerTradeWei);
  const maxEntry = [BigInt(settings.entryWei), maxTradfiV2DebitAmount(quoteRemaining, deps.platformFeeBps), maxTradfiV2DebitAmount(spendableUsdt, deps.platformFeeBps),
    ...(persistedQuotePerTrade === null ? [] : [maxTradfiV2DebitAmount(persistedQuotePerTrade, deps.platformFeeBps)])].reduce((left, right) => left < right ? left : right, 1n << 256n);
  if (deps.tradfiNativeCostUsdtAtomic === undefined) return "cost-unavailable";
  if (spendableUsdt < minEntry || budget < minEntry) return "entry-budget-too-small";
  if (!snapshot.available) return "data-plane-unavailable";
  const uniswapAllowed = sessionAllowsUniswap(agent, deps.uniswapRouter);
  // AGENTIC-RFQ-STOCKS E8: an RFQ-active Agentic AI agent sees every pinned stock (at most 64) when its worker has the flag on; with the flag off it sees the pooled ones only, cut at 28 as today.
  const rfq = await rfqOf(deps, agent, settings);
  const rfqOnlySet = rfq === null ? undefined : new Set(pinnedTokens(facts, true).filter((address) => isRfqOnlyToken(snapshot, rfq, address)).map((address) => address.toLowerCase()));
  const rfqEntries = rfq !== null && rfq.entries;
  const candidates = (rfq === null ? pinnedTokens(facts, true).slice(0, 28) : rfqEntries ? pinnedTokens(facts, true)
    : pinnedTokens(facts, true).filter((address) => !rfqOnlySet!.has(address.toLowerCase())).slice(0, 28)).map((address) => {
    const row = snapshot.rowsByAddress.get(address.toLowerCase());
    return { address, symbol: row?.symbol ?? address.slice(0, 8), lane: row?.lane ?? "bstocks" as const,
      marketCapUsd: null, priceUsd: null, volume24hUsd: null, priceChange24hPct: null, holders: null,
      ...(row?.rwa?.underlyingTicker === undefined || row.rwa.underlyingTicker === null ? {} : { underlyingTicker: row.rwa.underlyingTicker }),
      ...(row?.rwa?.platform === undefined ? {} : { platform: row.rwa.platform }),
      ...(row?.venues === undefined ? {} : { venues: row.venues }) };
  });
  const all = await deps.positions.list(agent.ownerAddress, agent.id);
  const unsettled = await deps.intents.listUnsettled(agent.ownerAddress, agent.id);
  const selected = await selectEntryCandidates({ model: settings.executionModel, settings, candidates,
    pinnedAddresses: new Set(candidates.map((candidate) => candidate.address.toLowerCase())),
    previouslyEnteredAddresses: new Set(all.map((row) => row.token.toLowerCase())),
    openPositionAddresses: new Set([...open.map((row) => row.token.toLowerCase()), ...unsettled.filter((row) => row.side === "buy").map((row) => row.token.toLowerCase())]),
    forbiddenAddresses: deps.forbiddenAddresses(agent), rwaAddresses: snapshot.addresses, rwaFacts: snapshot.facts, dataPlane: deps.dataPlane,
    ...(signal === undefined ? {} : { signal }), nowMs, ...(deps.verdictCache === undefined ? {} : { verdictCache: deps.verdictCache }),
    ...(rfqEntries ? { rfqOnly: rfqOnlySet! } : {}) });
  if (selected.kind === "aborted") return selected.reason;
  const routeable: EntryCandidate[] = [];
  for (const candidate of selected.candidates) {
    // E8: an RFQ-only candidate is routeable unquoted (scored first, quoted only when the model enters it): no direct, cost or Flash call is ever made for it.
    if (rfqEntries && rfqOnlySet!.has(candidate.address.toLowerCase())) { routeable.push(candidate); continue; }
    let directAvailable = false;
    try {
      const minQuote = await quoteBestTradfiBuy({ token: candidate.address, amountInAtomic: minEntry, slippageBps: settings.slippageBps,
        rpcUrls: deps.rpcUrls, ...(candidate.venues === undefined ? {} : { venues: candidate.venues }), ...(uniswapAllowed && deps.uniswapRouter !== undefined ? { uniswapRouter: deps.uniswapRouter } : {}),
        ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }), ...(signal === undefined ? {} : { signal }) });
      if (await deps.tradfiNativeCostUsdtAtomic({ agent, tokenIn: USDT_56, tokenOut: candidate.address, amountInAtomic: minEntry, venue: minQuote.venue, route: minQuote.route,
        calls: buildV2CostCalls({ quote: minQuote, token: candidate.address, amountInAtomic: minEntry, wallet: agent.walletAddress, feeAtomic: tradfiV2BuyFeeWei(minEntry, deps.platformFeeBps),
          ...(deps.platformFeeTreasury === undefined ? {} : { treasury: deps.platformFeeTreasury }) }), ...(signal === undefined ? {} : { signal }) }) === null) throw new Error("cost-unavailable");
      routeable.push(candidate);
      directAvailable = true;
    } catch { counts.refusals += 1; }
    if (!directAvailable && deps.dataPlane.binanceQuoteAndSwap !== undefined && flashGuardGranted(deps, facts)) {
      try {
        const buyReq = { tokenIn: USDT_56, tokenOut: candidate.address, amountAtomic: minEntry.toString(10) };
        const flash = await deps.dataPlane.binanceQuoteAndSwap(flashRequest({ ...buyReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
        const acceptedBuy = acceptFlashQuote({ request: buyReq, flash, facts, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
        if (!acceptedBuy.ok) { observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: acceptedBuy.code }); counts.refusals += 1; continue; }
        const exitReq = { tokenIn: candidate.address, tokenOut: USDT_56, amountAtomic: flash.quotedOutAtomic };
        const exit = await deps.dataPlane.binanceQuoteAndSwap(flashRequest({ ...exitReq, slippageBps: settings.slippageBps, ...(signal === undefined ? {} : { signal }) }));
        const acceptedExit = acceptFlashQuote({ request: exitReq, flash: exit, facts, configuredGuard: deps.aggregatorGuard, nowMs: deps.now?.() ?? Date.now() });
        if (!acceptedExit.ok) { observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: acceptedExit.code }); counts.refusals += 1; continue; }
        if (await tradfiActualPremiumAllowed({ deps, fact: snapshot.facts.get(candidate.address.toLowerCase()), token: candidate.address,
          amountInAtomic: minEntry, amountOutAtomic: BigInt(flash.quotedOutAtomic), settlementUsd, ...(signal === undefined ? {} : { signal }) })) {
          routeable.push(candidate);
          observe(counts, { stage: "route", code: "binance-guard", token: candidate.address });
        } else observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: "premium" });
      } catch (error) { observe(counts, { stage: "route", code: "binance-refused", token: candidate.address, reason: flashProxyReason(error) }); counts.refusals += 1; }
    }
  }
  counts.candidates = routeable.length;
  if (routeable.length === 0) return "no-route";
  const poolFeatures = await enrichFeatures(deps.dataPlane, settings.executionModel, routeable.map((item) => item.address), nowMs, signal);
  // E6 / RI2: the recorded-underlying series only for the RFQ-only tokens that got no pool evidence at all.
  const features = !rfqEntries ? poolFeatures : await mergeUnderlyingFeatures(deps.dataPlane, poolFeatures, routeable.filter((item) => rfqOnlySet!.has(item.address.toLowerCase())).map((item) => item.address), nowMs, signal);
  const session = sessionState(nowMs);
  let entryRegime: Regime = "unavailable";
  try {
    const read = await deps.dataPlane.usEquityRegime?.(signal);
    if (read !== undefined) entryRegime = read.regime;
  } catch { /* degrades to unavailable */ }
  const cryptoLeg = await readCmcGlobalRegime(deps, agent, nowMs);
  const regime = blendRegime(entryRegime, cryptoLeg.regime);
  observe(counts, { stage: "cmc", code: `regime:${regime}` });
  const sessionProfile = SESSION_PROFILES[session];
  const scored = routeable.map((candidate) => ({ candidate,
    result: scoreToken(features.get(candidate.address.toLowerCase())?.["15m"], features.get(candidate.address.toLowerCase())?.["1h"], regime, session) }));
  for (const { candidate, result } of scored) {
    const code = result.insufficientEvidence ? "insufficient-evidence"
      : result.veto !== null ? `vetoed:${result.veto}`
      : result.strong ? "strong" : result.buy ? "shortlisted" : "below-threshold";
    observe(counts, { stage: "score", code, token: candidate.address, reason: `score=${result.score} active=${result.activeWeightShare.toFixed(2)} ${result.reasons.join(" ")}` });
  }
  const scoredShortlist = scored.filter(({ result }) => result.buy)
    .sort((a, b) => (b.result.strong ? 1 : 0) - (a.result.strong ? 1 : 0) || b.result.score - a.result.score);
  // TRADFI-ENTRY-TIMING: a gated candidate is only DEFERRED to a later cycle. `log` records the would-defer and changes nothing; `enforce` removes it before the entry LLM and the buy.
  const entryTimingMode = deps.entryTimingMode ?? "off";
  const shortlist = entryTimingMode === "off" ? scoredShortlist : scoredShortlist.filter(({ candidate }) => {
    const gate = entryTimingGate(features.get(candidate.address.toLowerCase())?.["15m"], nowMs);
    if (!gate.gated) return true;
    observe(counts, { stage: "score", code: `timing:${entryTimingMode === "enforce" ? "deferred" : "would-defer"}:${gate.rule}`, token: candidate.address, reason: gate.detail });
    return entryTimingMode !== "enforce";
  });
  // R2.3/N2: the entry lane also passes the held tickers from the positions
  // it already read above, mapped exactly as the exit lane does. `enqueue`
  // (cmcRuntime.ts) merges this with whatever the exit lane enqueued in the
  // same cycle, so an out-of-phase CMC tick can never see a shortlist-only
  // target and drop the held list (Rev 1 H7 / Rev 2 re-review N2).
  // TRADFI-LLM-CMC-REQUEST R3.10 L2: ONE computed boolean feeds the prompt's
  // `dataRequests` line AND the entry validator's `allowDataRequests` option.
  const dataRequestsEnabled = settings.cmcNewsEnabled === true && deps.refreshCmcNews !== undefined;
  const entryHeldTickers = open.flatMap((position) => { const heldTicker = snapshot.rowsByAddress.get(position.token.toLowerCase())?.rwa?.underlyingTicker; return heldTicker === undefined || heldTicker === null ? [] : [heldTicker]; });
  // E11: the RFQ-only part of the score shortlist replaces the list when it is non-empty (held tickers stay first in the planning pick); caps and budget are the existing ones.
  const rfqShortlistedTickers = !rfqEntries ? [] : shortlist.filter(({ candidate }) => rfqOnlySet!.has(candidate.address.toLowerCase())).map(({ candidate }) => candidate.underlyingTicker ?? "");
  const entryShortlistedTickers = rfqShortlistedTickers.length > 0 ? rfqShortlistedTickers : shortlist.map(({ candidate }) => candidate.underlyingTicker ?? "");
  if (dataRequestsEnabled) {
    void deps.refreshCmcNews!({ agent, heldTickers: entryHeldTickers, shortlistedTickers: entryShortlistedTickers, nowMs, ...(signal === undefined ? {} : { signal }) }).catch(() => undefined);
  }
  if (shortlist.length === 0) return scoredShortlist.length > 0 ? "timing-defer" : "score-hold";
  const unsettledBuys = unsettled.filter((intent) => intent.side === "buy");
  const recentBuyAt = Math.max(-Infinity, ...open.map((position) => position.openedAt), ...unsettledBuys.map((intent) => intent.createdAt));
  if (Number.isFinite(recentBuyAt) && nowMs - recentBuyAt < 300_000) return "buy-pacing";
  // AUDIT MEDIUM-1: an agent not opted into CMC must get a byte-identical
  // prompt to before this build — no header, no "unknown" market/macro lines.
  const dossierBlocks = settings.cmcNewsEnabled === true
    ? await cachedCmcNewsBlocks(deps, agent, shortlist.map(({ candidate }) => candidate.underlyingTicker ?? ""), nowMs) : [];
  const newsBlocks = settings.cmcNewsEnabled === true ? [...cryptoLeg.newsLines, ...dossierBlocks] : [];
  // The model that actually answered (primary or fallback), for the run log.
  let entryAnswer: { readonly content: string; readonly model: string } | null = null;
  const validated = validateEntryResponse(
    (entryAnswer = await completeWithFallback(deps, settings, buildEntryPrompt({ model: settings.executionModel, v2: true,
      candidates: shortlist.map(({ candidate, result }) => ({ address: candidate.address, symbol: candidate.symbol, marketCapUsd: candidate.marketCapUsd,
        priceUsd: candidate.priceUsd, volume24hUsd: candidate.volume24hUsd, priceChange24hPct: candidate.priceChange24hPct, holders: candidate.holders,
        source: candidate.eligibilitySource, scanFlags: candidate.scanReasons, minEntryAtomic: minEntry.toString(10), maxEntryAtomic: maxEntry.toString(10),
        availablePrincipalAtomic: budget.toString(10), openPositions: open.length, dataQualityNotes: [snapshot.available ? "fresh-universe" : "unavailable"],
        score: result.score, strength: result.strong ? "strong" as const : "buy" as const, scoreReasons: result.reasons.join(" ") })),
      featureBlocks: shortlist.map(({ candidate }, index) => { const block = featurePrompt(features.get(candidate.address.toLowerCase()), nowMs, { v2: true }); return block ? `${index}: ${block}` : ""; }),
      ...(newsBlocks.length === 0 ? {} : { newsBlocks }), owner: settings, dataRequests: dataRequestsEnabled }), signal, (event) => observe(counts, { ...event, stage: "entry-llm" }))).content,
    shortlist.length, { v2: true, bounds: new Map(shortlist.map((_row, index) => [index, { minAtomic: minEntry, maxAtomic: maxEntry }])), allowDataRequests: dataRequestsEnabled });
  if (!validated.ok) return "llm-invalid";
  // TRADFI-LLM-CMC-REQUEST R3.4: right after validation, before the decision
  // loop (which can return on a committed buy below). Re-passes the same
  // held/shortlisted lists `enqueue` already merges for free.
  if (dataRequestsEnabled && validated.dataRequests.length > 0) {
    const llmRequests = mapAndObserveLlmDataRequests({
      counts, requests: validated.dataRequests,
      rowFor: (index) => { const row = shortlist[index]; return row === undefined ? undefined : { address: row.candidate.address, ticker: row.candidate.underlyingTicker ?? "" }; },
      dataRequestsEnabled, source: "entry", model: entryAnswer?.model ?? settings.primaryModel,
    });
    if (llmRequests.length > 0) {
      void deps.refreshCmcNews!({ agent, heldTickers: entryHeldTickers, shortlistedTickers: entryShortlistedTickers, nowMs, llmRequests, ...(signal === undefined ? {} : { signal }) }).catch(() => undefined);
    }
  }
  for (let index = 0; index < shortlist.length; index += 1) {
    const decision = validated.decisions.find((row) => row.index === index);
    const row = shortlist[index]; if (row === undefined) continue;
    const { candidate, result } = row;
    if (decision === undefined) continue;
    // Run-log observations only (2026-09-24): record the model's own reason and
    // confidence for every shortlisted decision, so "LLM decisions" says why.
    if (!decision.enter) { observe(counts, { stage: "entry-llm", code: "llm-veto", token: candidate.address, model: entryAnswer?.model ?? settings.primaryModel, confidence: decision.confidence, reason: decision.reason }); continue; }
    if (decision.amountAtomic === undefined) continue;
    const baseConfidence = Math.round((result.activeWeightShare + 0.15) * 100);
    const nudge = decision.confidence >= 70 ? 8 : -8;
    const final = baseConfidence + nudge;
    if (final < sessionProfile.final) { observe(counts, { stage: "entry-llm", code: "final-below-threshold", token: candidate.address, model: entryAnswer?.model ?? settings.primaryModel, confidence: decision.confidence, reason: `final=${final} < ${sessionProfile.final}. ${decision.reason}` }); continue; }
    observe(counts, { stage: "entry-llm", code: "enter", token: candidate.address, model: entryAnswer?.model ?? settings.primaryModel, confidence: decision.confidence, reason: decision.reason });
    const regimeSizeScaleValue = cryptoLeg.sizeScale;
    let amount = BigInt(decision.amountAtomic) * BigInt(Math.round(sessionProfile.sizeMult * regimeSizeScaleValue * 1000)) / 1000n;
    if (amount < minEntry) amount = minEntry;
    if (amount > maxEntry) amount = maxEntry;
    const extractedResult = await submitTradfiV2Buy(deps, agent, settings, {
      candidate, amount, snapshot, settlementUsd, uniswapAllowed, budget, spendableUsdt, ...(rfqEntries && rfqOnlySet!.has(candidate.address.toLowerCase()) ? { rfq: true } : {}),
    }, counts, dryRun, signal);
    if (extractedResult === "entry-budget-too-small" || extractedResult === "no-route") continue;
    return extractedResult;
  }
  return "llm-hold";
}

async function processAgent(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settingsRow: TradeSettingsRecord,
  options: RunTradeWorkerOptions,
  dcaSubmitted = false,
): Promise<TradeWorkerAgentOutcome> {
  const dryRun = options.dryRun === true;
  const counts: MutableCounts = { events: [], startedAt: Date.now(), candidates: 0, refusals: 0, entries: 0, exits: 0, heldNoPrice: 0 };
  let reason = "ok";
  try {
    const settings = settingsFrom(settingsRow.params);
    if (agent.sessionFacts === null) throw new Error("Agent session facts are unavailable.");
    const rwaSnapshot = await readRwaLaneSnapshot(deps, agent, settings.executionModel, options.signal);
    if (isTradeDcaSettings(settings)) {
      // I9 (R13): a DCA agent never reaches `runExits`, an LLM or the crash stop.
      reason = await runDcaStrategy(deps, agent, settingsRow, settings, counts, rwaSnapshot, dryRun, dcaSubmitted, options.signal);
    } else {
      // R7: dry-run calls the model/data plane but never touches provider or position mutations.
      if (!dryRun && !isTradeScheduleSettings(settings) && !isTradePortfolioSettings(settings)) await runExits(deps, agent, settings, counts, deps.now?.() ?? Date.now(), rwaSnapshot, settingsRow.drainingAt !== null, options.signal);
      reason = settingsRow.drainingAt !== null
        ? "draining"
        : await runEntry(deps, agent, settings, counts, deps.now?.() ?? Date.now(), rwaSnapshot, dryRun, options.signal);
    }
  } catch (error) {
    reason = `agent-error:${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`;
  }
  observe(counts, { stage: "cycle", code: reason });
  await deps.positions.insertRun({
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    dryRun,
    reason: runReason(reason, counts),
    events: counts.events ?? [],
    candidates: counts.candidates,
    refusals: counts.refusals,
    entries: counts.entries,
    exits: counts.exits,
  });
  return { agentId: agent.id, dryRun, reason, ...counts };
}

/**
 * AGENTIC-RFQ-STOCKS E13 (gate only: scripts/agentic-gate.ts is its only importer, a source test pins it): one RFQ buy of an RFQ-only stock at the settings' minimum entry, for the live gate RG2.
 * It runs the entry lane's budget and snapshot preamble (copied, so the entry lane stays untouched) and then the ordinary buy submission with the RFQ marker: no score, no model, no timing gate,
 * no pacing. Without `live` it prices only (quote, executed premium, exit check, minOut), prints the numbers and writes nothing.
 */
export async function submitTradfiV2GateBuy(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settingsRow: TradeSettingsRecord,
  token: Address,
  options: { readonly live: boolean; readonly signal?: AbortSignal },
): Promise<{ readonly result: string; readonly numbers: { readonly amountAtomic: string; readonly quotedOutAtomic: string; readonly minOutAtomic: string } | null; readonly events: readonly TradeRunEvent[] }> {
  const counts: MutableCounts = { events: [], startedAt: Date.now(), candidates: 0, refusals: 0, entries: 0, exits: 0, heldNoPrice: 0 };
  const signal = options.signal;
  const done = async (result: string, numbers: { readonly amountAtomic: string; readonly quotedOutAtomic: string; readonly minOutAtomic: string } | null = null) => {
    observe(counts, { stage: "cycle", code: result });
    if (options.live) await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress, dryRun: false, reason: runReason(result, counts),
      events: counts.events ?? [], candidates: counts.candidates, refusals: counts.refusals, entries: counts.entries, exits: counts.exits });
    return { result, numbers, events: counts.events ?? [] };
  };
  const settings = settingsFrom(settingsRow.params);
  const facts = agent.sessionFacts;
  const rfq = await rfqOf(deps, agent, settings);
  if (rfq === null || !rfq.entries) return done("rfq-not-active");
  if (facts === null || settings.minEntryWei === undefined || settings.capitalQuoteWei === undefined) return done("settings-invalid");
  const minEntry = BigInt(settings.minEntryWei);
  const open = await deps.positions.listOpen(agent.ownerAddress, agent.id);
  if (open.length >= settings.maxOpenPositions) return done("at-capacity");
  const dataReservedBefore = deps.v2DataBudgetReservedWei === undefined ? 0n : await deps.v2DataBudgetReservedWei(agent);
  if (dataReservedBefore === null || dataReservedBefore < 0n) return done("data-budget-unavailable");
  const pendingQuoteBefore = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const usdtBalance = await deps.provider.getTokenBalance({ wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 }, token: USDT_56,
    ...(signal === undefined ? {} : { signal }) });
  const settlementUsd = freshTokenUsdFact((await deps.dataPlane.tokensBatch([USDT_56], signal)).find((row) => row.address.toLowerCase() === USDT_56.toLowerCase()), Date.now());
  if (settlementUsd === null) return done("settlement-price-unavailable");
  const dataReservedAfter = deps.v2DataBudgetReservedWei === undefined ? 0n : await deps.v2DataBudgetReservedWei(agent);
  if (dataReservedAfter === null || dataReservedAfter < 0n) return done("data-budget-unavailable");
  const pendingQuoteAfter = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const pendingQuote = pendingQuoteBefore > pendingQuoteAfter ? pendingQuoteBefore : pendingQuoteAfter;
  const chainQuoteRemaining = await readTradfiV2QuoteRemaining(deps, agent, facts, signal);
  if (chainQuoteRemaining === null) return done("quote-meter-unavailable");
  const quoteRemaining = chainQuoteRemaining > pendingQuote ? chainQuoteRemaining - pendingQuote : 0n;
  const cashProtected = (dataReservedBefore > dataReservedAfter ? dataReservedBefore : dataReservedAfter) + pendingQuote;
  const spendableUsdt = usdtBalance > cashProtected ? usdtBalance - cashProtected : 0n;
  const budget = [BigInt(settings.capitalQuoteWei), quoteRemaining, spendableUsdt].reduce((left, right) => left < right ? left : right, 1n << 256n);
  if (deps.tradfiNativeCostUsdtAtomic === undefined) return done("cost-unavailable");
  if (spendableUsdt < minEntry || budget < minEntry) return done("entry-budget-too-small");
  const snapshot = await readRwaLaneSnapshot(deps, agent, settings.executionModel, signal);
  if (!snapshot.available) return done("data-plane-unavailable");
  if (!isRfqOnlyToken(snapshot, rfq, token)) return done("not-rfq-only");
  const row = snapshot.rowsByAddress.get(token.toLowerCase());
  const candidate: EntryCandidate = { address: token, symbol: row?.symbol ?? token.slice(0, 8), lane: row?.lane ?? "bstocks" as const, marketCapUsd: null, priceUsd: null, volume24hUsd: null,
    priceChange24hPct: null, holders: null, ...(row?.rwa?.underlyingTicker === undefined || row.rwa.underlyingTicker === null ? {} : { underlyingTicker: row.rwa.underlyingTicker }),
    ...(row?.rwa?.platform === undefined ? {} : { platform: row.rwa.platform }), underlyingMarketClosed: false, rwaNote: null, eligibilitySource: "binance-rwa", eligibilityVenue: null,
    routeKind: "pancake-discovery", scanReasons: [] };
  const input: SubmitTradfiV2BuyInput = { candidate, amount: minEntry, snapshot, settlementUsd, uniswapAllowed: false, budget, spendableUsdt, rfq: true };
  if (!options.live) {
    const priced = await priceRfqBuy(deps, agent, settings, input, counts, signal);
    return done(priced === "no-route" ? "no-route" : "priced", priced === "no-route" ? null : { amountAtomic: minEntry.toString(10), quotedOutAtomic: priced.quote.quotedOutAtomic.toString(10), minOutAtomic: priced.quote.minOutAtomic.toString(10) });
  }
  return done(await submitTradfiV2Buy(deps, agent, settings, input, counts, false, signal));
}

/** Sweep every stable 32-row page; one agent failure never stops the page or sweep. */
/**
 * Ask the owner's primary model; on a throw (timeout, transport, HTTP error)
 * ask the distinct fallback once. An off-schema ANSWER is not retried here —
 * the validator decides that, and a second call would double the cost for a
 * model that already answered.
 */
async function completeWithFallback(
  deps: Pick<TradeWorkerDeps, "llmFor" | "modelOverride">,
  chosen: { readonly primaryModel: string; readonly fallbackModel: string },
  prompt: readonly OpenRouterMessage[],
  signal?: AbortSignal,
  observeCall?: (event: Omit<TradeRunEvent, "stage" | "elapsedMs">) => void,
): Promise<{ readonly content: string; readonly model: string }> {
  // The owner's signed choice wins — operator ruling 2026-09-20, after a local
  // `.env` pinned every agent to the fallback model while the detail page
  // showed the owner's Qwen pick. The daemon override (`TRADE_LLM_MODEL`) is
  // kept only as a DEFAULT for a row with no model; `parseTradeSettings`
  // never admits one today, so for every signed hire this branch is inert.
  // A one-slot override (no fallback slot) still means the same model in both
  // roles: no second call.
  const settings = chosen.primaryModel !== "" || deps.modelOverride === undefined ? chosen
    : { primaryModel: deps.modelOverride.primary, fallbackModel: deps.modelOverride.fallback ?? deps.modelOverride.primary };
  try {
    observeCall?.({ code: "request", model: settings.primaryModel });
    const result = await deps.llmFor(settings.primaryModel).complete(prompt, signal);
    signal?.throwIfAborted();
    observeCall?.({ code: "response", model: settings.primaryModel });
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    observeCall?.({ code: "request-failed", model: settings.primaryModel });
    if (settings.fallbackModel === settings.primaryModel) throw error;
    signal?.throwIfAborted();
    observeCall?.({ code: "fallback-request", model: settings.fallbackModel });
    const result = await deps.llmFor(settings.fallbackModel).complete(prompt, signal);
    signal?.throwIfAborted();
    observeCall?.({ code: "response", model: settings.fallbackModel });
    return result;
  }
}

/* ========================================================================== */
/* Auto DCA (AUTO-DCA §5, §7, R2.3–R2.18; REVIEW2 §7 conditions)              */
/* ========================================================================== */
//
// A DCA agent never reaches `runExits`, an LLM or the crash stop (I9). Its work
// is split in two phases (R2.8):
//
//   PROJECTION — every cycle, for armed, paused and revoked agents, BEFORE the
//   data-plane readiness gate: converge its actions (finish, orphan release,
//   the UNKNOWN resolver's landed path), observe its orders (fill and stop
//   counters, owner-close reconciliation), and run the protective steps —
//   Remove for a draining agent, the stop-loss sweep then pause. Protective
//   work prices itself in native wei (condition 5), so it needs no data plane.
//
//   STRATEGY — `processAgent`, armed agents only, after the gates: holds, then
//   fill, close (+ start), TP re-place, level placement, start.
//
// At most one submission per agent per cycle across both phases.

/** R2.13: back off at 3 consecutive reverts, hold at 6 until an owner action. */
const DCA_REVERT_BACKOFF_AT = 3;
const DCA_REVERT_EXHAUSTED_AT = 6;
const DCA_REVERT_BACKOFF_CYCLES = 10;
/** The NFPM deadline a batch signs, from its build (the trade executor's window). */
const DCA_BATCH_DEADLINE_SEC = 300n;
/** R2.15: `eth_gasPrice` is bounded at 1 000 gwei for the hold, like Quant. */
const DCA_MAX_GAS_PRICE_WEI = 1_000_000_000_000n;

export type TradeWorkerDcaDeps = {
  readonly simulations?: Pick<TradfiEvidenceWriter, "recordActual">;
  readonly store: DcaRoundStore;
  /** `DCA_ENABLED`. Off ⇒ the exit subset only: convergence, stop loss, Remove (D17). */
  readonly enabled: boolean;
  readonly nfpm: Address;
  readonly chain: DcaChainReads;
  /** REVIEW2 condition 5: the relay quote of a full batch in native wei, before any data-plane conversion. */
  readonly batchCostWei: (input: { readonly agent: AgentRecord; readonly calls: readonly WalletCall[] }) => Promise<bigint | null>;
  /** `executeDcaRangeBatch`, bound to its deps by the composition root. */
  readonly executeRange: (input: DcaExecuteInput) => Promise<DcaExecuteResult>;
  readonly receipts: Pick<TradfiV2ReceiptReader, "readFinalized" | "getReceipt">;
  readonly journal: Pick<ExecutionJournal, "get" | "advanceUnknown">;
};

type DcaContext = {
  readonly deps: TradeWorkerDeps;
  readonly dca: TradeWorkerDcaDeps;
  readonly agent: AgentRecord;
  readonly settings: EffectiveTradeSettings;
  readonly pool: DcaPool;
  readonly nowMs: number;
};

function dcaUsdt(pool: DcaPool, amount0: bigint, amount1: bigint): bigint {
  return pool.usdtIsToken0 ? amount0 : amount1;
}

function dcaStock(pool: DcaPool, amount0: bigint, amount1: bigint): bigint {
  return pool.usdtIsToken0 ? amount1 : amount0;
}

function dcaLive(order: DcaOrderRow): DcaLiveOrder {
  return { orderKey: order.orderKey, role: order.role, levelNo: order.levelNo, tokenId: order.tokenId ?? 0n,
    tickLower: order.tickLower, tickUpper: order.tickUpper, liquidity: order.liquidity };
}

function dcaLedgerOf(round: DcaRoundRow): DcaLedger {
  return { costUsdtWei: round.costUsdtWei, stockAcquiredWei: round.stockAcquiredWei,
    usdtCollectedWei: round.usdtCollectedWei, saleProceedsWei: round.saleProceedsWei };
}

function dcaStockValue(stockWei: bigint, mid: { readonly num: bigint; readonly den: bigint }): bigint {
  return (stockWei * mid.num) / mid.den;
}

/**
 * What the round's exited TPs sold, from their own receipts, plus any
 * `extraSoldWei` the caller adds before the clamp (AUTO-DCA R4.1.2: a
 * removed round's pre-R4 legacy sale); the rest of H carries (R2.6).
 */
function dcaCarryOut(round: DcaRoundRow, orders: readonly DcaOrderRow[], extraSoldWei: bigint = 0n): { readonly realizedPnlWei: bigint; readonly carriedStockWei: bigint; readonly carriedCostWei: bigint } {
  if (round.stockAcquiredWei <= 0n) {
    return { realizedPnlWei: round.usdtCollectedWei + round.saleProceedsWei - round.costUsdtWei, carriedStockWei: 0n, carriedCostWei: 0n };
  }
  const tpSold = orders.filter((order) => order.role === "tp" && order.state === "exited" && order.roundNo === round.roundNo)
    .reduce((sum, order) => sum + (order.mintedStockWei > order.collectedStockWei ? order.mintedStockWei - order.collectedStockWei : 0n), 0n);
  const sold = tpSold + extraSoldWei;
  return dcaSettle({ ledger: dcaLedgerOf(round), stockSoldWei: sold > round.stockAcquiredWei ? round.stockAcquiredWei : sold });
}

/**
 * The level rows of a round born with `anchor` (A1: they exist from activation),
 * exactly one per level (review C5). Given the start's `minted` rows (an R3 plan,
 * R3.2), a minted level is its live row from the receipt, and a level below the
 * highest minted one or below the range min is `skipped`; the rest are pending.
 */
function dcaPendingLevels(ctx: DcaContext, roundNo: number, anchor: { readonly num: bigint; readonly den: bigint }, minted?: ReadonlyMap<number, DcaOrderRow>): DcaOrderRow[] {
  const rows: DcaOrderRow[] = [];
  const highest = minted === undefined ? 0 : Math.max(0, ...minted.keys());
  const rangeMinE8 = ctx.settings.dcaRangeMinE8 === null || ctx.settings.dcaRangeMinE8 === undefined ? null : BigInt(ctx.settings.dcaRangeMinE8);
  for (let levelNo = 1; levelNo <= (ctx.settings.dcaMaxOrders ?? 0); levelNo += 1) {
    const live = minted?.get(levelNo);
    if (live !== undefined) {
      rows.push(live);
      continue;
    }
    let range: { readonly tickLower: number; readonly tickUpper: number } | null = null;
    let belowRange = false;
    try {
      const price = dcaLevelPrice(anchor, levelNo, ctx.settings.dcaStepBps ?? 0);
      range = dcaLevelRange(ctx.pool, price);
      belowRange = rangeMinE8 !== null && price.num * 100_000_000n < rangeMinE8 * price.den;
    } catch { range = null; }
    const skipped = range === null || minted !== undefined && (levelNo < highest || belowRange);
    rows.push({ agentId: ctx.agent.id, roundNo, orderKey: `r${roundNo}:l${levelNo}`, role: "level", levelNo,
      tickLower: range?.tickLower ?? 0, tickUpper: range?.tickUpper ?? 0, tokenId: null, state: skipped ? "skipped" : "pending",
      liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, collectedUsdtWei: 0n, collectedStockWei: 0n,
      crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null, exitedByAction: null,
      lastSeenLiveBlock: null, closedBy: null, updatedAtMs: ctx.nowMs });
  }
  return rows;
}

async function dcaInsertRun(ctx: DcaContext, reason: string): Promise<void> {
  await ctx.deps.positions.insertRun({ agentId: ctx.agent.id, ownerAddress: ctx.agent.ownerAddress, dryRun: false,
    reason, events: normalizeTradeRunEvents([{ stage: "cycle", code: reason, elapsedMs: 0 }]) });
}

/* ---- the finish (§5.5, R2.3 "Anchor and receipt") ------------------------- */

type DcaVerified = { readonly kind: "verified"; readonly evidence: DcaReceiptEvidence } | { readonly kind: "pending" } | { readonly kind: "mismatch"; readonly code: string };

async function verifyDcaAction(ctx: DcaContext, action: DcaActionRow, txHash: Hex): Promise<DcaVerified> {
  const entry = await ctx.dca.journal.get(dcaIdempotencyKey(action.actionKey));
  const observation = await ctx.dca.receipts.readFinalized(txHash);
  if (entry === null || observation === null) return { kind: "pending" };
  const plan = action.plan;
  // The persisted plan wins (I4): the calls are rebuilt from it and must hash
  // to what the journal recorded as submitted.
  const calls = dcaBatchCalls(plan, { pool: ctx.pool, nfpm: ctx.dca.nfpm, wallet: ctx.agent.walletAddress, treasury: ctx.deps.platformFeeTreasury ?? null });
  const callsHash = entry.externalRef.callsHash;
  const publicKey = entry.externalRef.publicKey;
  if (callsHash === undefined || publicKey === undefined || hashCalls(calls).toLowerCase() !== callsHash.toLowerCase()) return { kind: "mismatch", code: "receipt-calls-mismatch" };
  const legs = dcaPoolLegs(ctx.pool);
  const verification = verifyDcaReceipt({ observation, expected: {
    wallet: ctx.agent.walletAddress, sessionPublicKey: publicKey, sessionGeneration: entry.externalRef.sessionGeneration ?? 0,
    callsHash, calls, nfpm: ctx.dca.nfpm, pool: ctx.pool.pool, token0: legs.token0, token1: legs.token1, stock: ctx.pool.stock,
    exits: plan.exits, mints: plan.mints, feeAtomic: plan.feeWei,
    ...(ctx.deps.platformFeeTreasury === undefined ? {} : { feeTreasury: ctx.deps.platformFeeTreasury }),
    swap: plan.swap === null ? null : { side: plan.swap.side, amountInAtomic: plan.swap.amountInWei, minOutAtomic: plan.swap.minOutWei,
      ...(plan.swap.guard === undefined ? {} : { guard: { address: plan.swap.guard.address, calldata: plan.swap.guard.calldata } }) },
  } });
  if (!verification.ok) return { kind: "mismatch", code: verification.code };
  // §5.5: every minted id carries the persisted ticks (read at the finalized tip; ticks never change).
  for (const [index, minted] of verification.evidence.mints.entries()) {
    const position = await ctx.dca.chain.position(minted.tokenId, observation.finalizedBlock.number);
    const planned = plan.mints[index]!;
    if (position === "burned" || position.tickLower !== planned.tickLower || position.tickUpper !== planned.tickUpper) return { kind: "mismatch", code: "receipt-ticks-mismatch" };
  }
  recordSimulationActual(ctx.dca.simulations, { idempotencyKey: dcaIdempotencyKey(action.actionKey),
    txHash: verification.evidence.transactionHash, token: ctx.pool.stock, wallet: ctx.agent.walletAddress,
    logs: observation.receipt.logs, atMs: ctx.nowMs, ...(ctx.deps.log === undefined ? {} : { log: ctx.deps.log }) });
  return { kind: "verified", evidence: verification.evidence };
}

/**
 * Book a verified batch in ONE store transaction (§5.5), from the persisted
 * plan and the receipt only (I4, I5). A round or order that changed under it
 * throws, and the next cycle re-derives from the same persisted inputs.
 */
async function finishDcaAction(ctx: DcaContext, action: DcaActionRow, evidence: DcaReceiptEvidence): Promise<void> {
  const { pool, agent } = ctx;
  const plan = action.plan;
  const rounds = await ctx.dca.store.listRounds(agent.ownerAddress, agent.id);
  const round = rounds.find((row) => row.roundNo === plan.roundNo);
  if (round === undefined) throw new Error("dca: the action's round is missing.");
  const orders = await ctx.dca.store.listOrders(agent.id, plan.roundNo);
  let ledger = dcaLedgerOf(round);
  let unreliable = round.unreliable;
  const orderWrites: DcaOrderRow[] = [];
  const sweep = plan.kind === "stop-loss" || plan.kind === "remove";
  for (const [index, exit] of plan.exits.entries()) {
    const got = evidence.exits[index]!;
    const usdt = dcaUsdt(pool, got.amount0, got.amount1);
    const stock = dcaStock(pool, got.amount0, got.amount1);
    const order = orders.find((row) => row.tokenId === exit.tokenId);
    if (order === undefined) {
      // Condition 1: a position the store did not know (e.g. a mint that landed
      // under UNKNOWN). Its collect is real; its basis is not the plane's.
      unreliable = true;
      continue;
    }
    ledger = dcaApplyExit(ledger, { role: order.role, mintedUsdtWei: order.mintedUsdtWei, collectedUsdtWei: usdt, collectedStockWei: stock });
    // A swept level that bought nothing waits for the round to resume (D12, R2.23 item 3).
    const unfilledLevel = plan.kind === "stop-loss" && order.role === "level" && stock === 0n;
    orderWrites.push(unfilledLevel
      ? { ...order, state: "pending", tokenId: null, liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, crossCount: 0, crossLastBlock: null,
        crossLastAtMs: null, createdByAction: null, exitedByAction: null, lastSeenLiveBlock: null, updatedAtMs: ctx.nowMs }
      : { ...order, state: "exited", collectedUsdtWei: usdt, collectedStockWei: stock, exitedByAction: action.actionKey, closedBy: "plane", updatedAtMs: ctx.nowMs });
  }
  const nextRoundNo = plan.roundNo + 1;
  // R3.3: every mint of a close + start belongs to round k + 1. An R3 start's
  // level rows are written by `dcaPendingLevels` alone, one per level (review C5).
  const ladderMinted = new Map<number, DcaOrderRow>();
  for (const [index, mint] of plan.mints.entries()) {
    const got = evidence.mints[index]!;
    const row: DcaOrderRow = { agentId: agent.id, roundNo: plan.kind === "close-start" ? nextRoundNo : plan.roundNo,
      orderKey: mint.orderKey, role: mint.role, levelNo: mint.levelNo, tickLower: mint.tickLower, tickUpper: mint.tickUpper,
      tokenId: got.tokenId, state: "live", liquidity: got.liquidity, mintedUsdtWei: dcaUsdt(pool, got.amount0, got.amount1),
      mintedStockWei: dcaStock(pool, got.amount0, got.amount1), collectedUsdtWei: 0n, collectedStockWei: 0n,
      crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: action.actionKey, exitedByAction: null,
      lastSeenLiveBlock: evidence.blockNumber, closedBy: null, updatedAtMs: ctx.nowMs };
    if (plan.ladderAnchor !== undefined && mint.role === "level" && mint.levelNo !== null) ladderMinted.set(mint.levelNo, row);
    else orderWrites.push(row);
  }
  const strategyDone = { revertStreak: sweep ? round.revertStreak : 0, backoffUntilMs: sweep ? round.backoffUntilMs : null };
  const roundWrites: DcaRoundRow[] = [];
  const roundInserts: DcaRoundInsert[] = [];
  const swap = evidence.swap;
  if (plan.kind === "start") {
    if (swap === null) throw new Error("dca: a start receipt has no swap.");
    const started = dcaStartLedger({ carriedCostWei: round.carriedCostWei, carriedStockWei: round.carriedStockWei,
      swapInWei: swap.inputAtomic, feeWei: plan.feeWei, swapOutWei: swap.outputAtomic });
    roundWrites.push({ ...round, ...started, ...strategyDone, phase: "active", p0UsdtWei: swap.inputAtomic, p0StockWei: swap.outputAtomic, updatedAtMs: ctx.nowMs });
    // I13: an R3 round's ladder comes from its plan's anchor and overwrites any row a
    // rolled-back attempt left; a pre-R3 plan keeps the legacy rows from the receipt P0.
    orderWrites.push(...(plan.ladderAnchor === undefined
      ? dcaPendingLevels(ctx, plan.roundNo, { num: swap.inputAtomic, den: swap.outputAtomic }).filter((level) => !orders.some((row) => row.orderKey === level.orderKey))
      : dcaPendingLevels(ctx, plan.roundNo, plan.ladderAnchor, ladderMinted)));
  } else if (plan.kind === "close" || plan.kind === "close-start") {
    const closed = dcaCarryOut({ ...round, ...ledger }, [...orders.filter((row) => !orderWrites.some((write) => write.orderKey === row.orderKey)), ...orderWrites]);
    roundWrites.push({ ...round, ...ledger, ...strategyDone, phase: "settled", closeCause: "take-profit", realizedPnlWei: closed.realizedPnlWei,
      settledAtMs: ctx.nowMs, unreliable, updatedAtMs: ctx.nowMs });
    if (plan.kind === "close-start") {
      if (swap === null) throw new Error("dca: a close + start receipt has no swap.");
      const started = dcaStartLedger({ carriedCostWei: closed.carriedCostWei, carriedStockWei: closed.carriedStockWei,
        swapInWei: swap.inputAtomic, feeWei: plan.feeWei, swapOutWei: swap.outputAtomic });
      roundInserts.push({ agentId: agent.id, ownerAddress: agent.ownerAddress, roundNo: nextRoundNo, phase: "active",
        p0UsdtWei: swap.inputAtomic, p0StockWei: swap.outputAtomic, costUsdtWei: started.costUsdtWei, stockAcquiredWei: started.stockAcquiredWei,
        carriedStockWei: closed.carriedStockWei, carriedCostWei: closed.carriedCostWei, slBaselineWei: round.slBaselineWei, nowMs: ctx.nowMs });
      orderWrites.push(...(plan.ladderAnchor === undefined
        ? dcaPendingLevels(ctx, nextRoundNo, { num: swap.inputAtomic, den: swap.outputAtomic })
        : dcaPendingLevels(ctx, nextRoundNo, plan.ladderAnchor, ladderMinted)));
    }
  } else if (sweep) {
    // AUTO-DCA R4.15 (R4-R1 disposition a): a late sweep finish leaves a round
    // already `removed` alone — it never re-opens a settle.
    if (round.phase !== "settled") {
      const proceeds = swap === null ? 0n : swap.outputAtomic;
      roundWrites.push({ ...round, ...ledger, saleProceedsWei: ledger.saleProceedsWei + proceeds, phase: "closing",
        closeCause: plan.kind === "stop-loss" ? "stop-loss" : "remove", unreliable, updatedAtMs: ctx.nowMs });
    }
  } else {
    roundWrites.push({ ...round, ...ledger, ...strategyDone, unreliable, updatedAtMs: ctx.nowMs });
  }
  await ctx.dca.store.withDcaFence(agent.ownerAddress, agent.id, (sql) => ctx.dca.store.finishAction({
    ownerAddress: agent.ownerAddress, actionKey: action.actionKey, plan, roundWrites, roundInserts, orders: orderWrites, nowMs: ctx.nowMs,
  }, sql));
}

async function bumpDcaStreak(ctx: DcaContext, roundNo: number): Promise<void> {
  const intervalMs = ctx.deps.intervalMs ?? 60_000;
  await ctx.dca.store.withDcaFence(ctx.agent.ownerAddress, ctx.agent.id, async (sql) => {
    const round = (await ctx.dca.store.listRounds(ctx.agent.ownerAddress, ctx.agent.id, sql)).find((row) => row.roundNo === roundNo);
    if (round === undefined || round.phase === "settled") return;
    const streak = round.revertStreak + 1;
    // At 6 the backoff stamp marks WHEN it exhausted: an owner action after it clears the hold.
    const backoffUntilMs = streak >= DCA_REVERT_EXHAUSTED_AT ? ctx.nowMs
      : streak >= DCA_REVERT_BACKOFF_AT ? ctx.nowMs + DCA_REVERT_BACKOFF_CYCLES * intervalMs : round.backoffUntilMs;
    await ctx.dca.store.writeRound({ ...round, revertStreak: streak, backoffUntilMs, updatedAtMs: ctx.nowMs }, sql);
  });
}

/* ---- convergence (§5.7, R2.7 safety net, R2.8 resolver) ------------------- */

async function reconcileDcaActions(ctx: DcaContext): Promise<void> {
  const { dca, agent } = ctx;
  for (const action of await dca.store.listActions(agent.ownerAddress, agent.id)) {
    if (action.state === "finished" || action.state === "rolled-back") continue;
    // One action that cannot converge (a round that moved under its finish, a
    // receipt read that fails) must not keep the protective steps from running.
    try {
      const key = dcaIdempotencyKey(action.actionKey);
      const entry = await dca.journal.get(key);
      const setState = (from: readonly DcaActionState[], to: DcaActionState, extra: { readonly txHash?: Hex | null; readonly note?: string | null } = {}) =>
        dca.store.setActionState({ ownerAddress: agent.ownerAddress, actionKey: action.actionKey, from, to, ...extra, nowMs: ctx.nowMs });
      if (entry === null) {
        // R2.7: a crash between the claim and `beginWithSpend`. The store answers
        // only for the age; the missing journal row is proved here.
        if (action.state === "intended") await dca.store.releaseOrphan({ ownerAddress: agent.ownerAddress, actionKey: action.actionKey, nowMs: ctx.nowMs });
        continue;
      }
      if (entry.state === "PENDING" || entry.state === "IN_PROGRESS") {
        if (action.state === "intended") await setState(["intended"], "submitted");
        continue;
      }
      if (entry.state === "ROLLED_BACK") {
        await setState(["intended", "submitted", "unknown"], "rolled-back", { note: sanitizeMessage(entry.lastError ?? "rolled back").slice(0, 120) });
        if (action.kind !== "stop-loss" && !(action.kind === "remove" && action.plan.exits.length > 0)) await bumpDcaStreak(ctx, action.roundNo);
        continue;
      }
      if (entry.state === "UNKNOWN") {
        if (action.state !== "unknown") await setState(["intended", "submitted"], "unknown");
        await resolveDcaUnknownLanded(ctx, { ...action, state: "unknown" });
        continue;
      }
      const txHash = entry.externalRef.txHash;
      if (txHash === undefined) continue;
      if (action.state !== "committed") await setState(["intended", "submitted", "unknown"], "committed", { txHash });
      const verified = await verifyDcaAction(ctx, action, txHash);
      if (verified.kind === "pending") continue;
      if (verified.kind === "mismatch") {
        // §5.5: never guessed — the action stays committed and the round holds.
        await setState(["committed"], "committed", { note: `dca-receipt-mismatch:${verified.code}` });
        continue;
      }
      await finishDcaAction(ctx, action, verified.evidence);
    } catch (error) {
      ctx.deps.log?.(`[trade-worker] dca action ${action.actionKey} did not converge: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`);
    }
  }
}

/**
 * R2.8's LANDED path, automatic: positive chain evidence (condition 3), the
 * transaction found from the landed id's NFPM logs inside the 8 000-block
 * window, and the same receipt proof as a live finish. Anything less holds;
 * the not-landed path is `scripts/dca-resolve.ts`.
 */
async function resolveDcaUnknownLanded(ctx: DcaContext, action: DcaActionRow): Promise<void> {
  const { dca, agent, pool } = ctx;
  const orders = await dca.store.listOrders(agent.id, action.roundNo);
  const others = (await dca.store.listActions(agent.ownerAddress, agent.id))
    .filter((row) => row.actionKey !== action.actionKey)
    .map((row) => ({ actionKey: row.actionKey, state: row.state, txHash: row.txHash, plan: { exits: row.plan.exits } }));
  const evidence = await dcaUnknownEvidence({ reads: dca.chain, pool, wallet: agent.walletAddress, plan: action.plan,
    knownTokenIds: new Set(orders.flatMap((row) => row.tokenId === null ? [] : [row.tokenId])), ageMs: ctx.nowMs - action.createdAtMs, others });
  // AUTO-DCA R4.5 (I18): only a `landed` verdict advances here; `superseded` is
  // the operator's `--apply` to write, same as `not-landed`.
  if (evidence.verdict !== "landed" || evidence.landedTokenId === null || evidence.block === null) return;
  const from = action.plan.readingBlock;
  if (evidence.block < from || evidence.block - from > DCA_LOG_WINDOW_BLOCKS) return;
  let hashes: readonly Hex[];
  try {
    hashes = [...new Set((await dca.chain.nfpmLogs(evidence.landedTokenId, from, evidence.block)).map((row) => row.transactionHash))];
  } catch {
    return; // a failed log read is no evidence, never absence
  }
  for (const txHash of hashes) {
    const verified = await verifyDcaAction(ctx, action, txHash);
    if (verified.kind !== "verified") continue;
    await dca.journal.advanceUnknown(dcaIdempotencyKey(action.actionKey), {
      action: "resolveUnknown", at: ctx.nowMs, ownerAddress: agent.ownerAddress, observedBlock: evidence.block.toString(10),
      serverBlock: evidence.block.toString(10), checks: evidence.checks, legs: [],
      logAbsence: { checked: false, detail: "landed: found from NFPM logs and verified on the two-RPC pair" },
      disposition: "dcaRange landed: advanced to COMMITTED from its verified receipt",
    }, { txHash });
    await dca.store.setActionState({ ownerAddress: agent.ownerAddress, actionKey: action.actionKey, from: ["unknown"], to: "committed", txHash, nowMs: ctx.nowMs });
    await finishDcaAction(ctx, action, verified.evidence);
    return;
  }
}

/* ---- observation (§5.3, §7.2, R2.12) -------------------------------------- */

type DcaObservation = {
  readonly reading: DcaReading;
  readonly orders: readonly DcaOrderRow[];
  readonly walletStockWei: bigint;
  readonly equityWei: bigint;
};

async function dcaEquityAt(ctx: DcaContext, round: DcaRoundRow, orders: readonly DcaOrderRow[], reading: DcaReading, walletStockWei: bigint): Promise<bigint> {
  const rounds = await ctx.dca.store.listRounds(ctx.agent.ownerAddress, ctx.agent.id);
  const realized = rounds.filter((row) => row.phase === "settled").reduce((sum, row) => sum + (row.realizedPnlWei ?? 0n), 0n);
  let orderUsdt = 0n;
  let orderStock = 0n;
  let liveLevelMinted = 0n;
  let tpPrincipal = 0n;
  for (const order of orders) {
    if (order.state !== "live" && order.state !== "exiting") continue;
    const amounts = getAmountsForLiquidity(reading.sqrtPriceX96, order.tickLower, order.tickUpper, order.liquidity);
    orderUsdt += dcaUsdt(ctx.pool, amounts.amount0, amounts.amount1);
    orderStock += dcaStock(ctx.pool, amounts.amount0, amounts.amount1);
    if (order.role === "level") liveLevelMinted += order.mintedUsdtWei;
    else tpPrincipal += order.mintedStockWei;
  }
  const roundStock = round.stockAcquiredWei > tpPrincipal ? round.stockAcquiredWei - tpPrincipal : 0n;
  return dcaEquityWei({ capitalQuoteWei: BigInt(ctx.settings.capitalQuoteWei ?? "0"), realizedPnlWei: realized, ledger: dcaLedgerOf(round),
    liveLevelMintedUsdtWei: liveLevelMinted, orderUsdtWei: orderUsdt, orderStockWei: orderStock,
    walletRoundStockWei: walletStockWei < roundStock ? walletStockWei : roundStock, mid: dcaMidPrice(ctx.pool, reading.sqrtPriceX96) });
}

/**
 * One finalized reading: fill and TP counters (the dispatching cycle's own
 * reading confirms, I1), `lastSeenLiveBlock`, R2.12 owner-close reconciliation,
 * and — for an armed agent — the stop-loss counter (§7.2).
 */
async function observeDca(ctx: DcaContext, round: DcaRoundRow): Promise<DcaObservation> {
  const { dca, pool, agent } = ctx;
  const reading = await dca.chain.reading(pool.pool);
  const orders = await dca.store.listOrders(agent.id, round.roundNo);
  const updates: DcaOrderRow[] = [];
  for (const order of orders) {
    if (order.state !== "live" || order.tokenId === null) continue;
    const position = await dca.chain.position(order.tokenId, reading.block);
    const liquidity = position === "burned" ? 0n : position.liquidity;
    if (position !== "burned" && (position.tickLower !== order.tickLower || position.tickUpper !== order.tickUpper)) continue;
    if (liquidity === 0n) {
      await reconcileDcaOwnerClose(ctx, round, order, reading.block);
      continue;
    }
    if (liquidity !== order.liquidity) continue; // the strategy phase holds dca-order-mismatch
    const qualifies = dcaOrderReadsFilled({ pool, role: order.role, range: order, liquidity, reading });
    const next = dcaAdvanceCounter({ count: order.crossCount, lastBlock: order.crossLastBlock, lastAtMs: order.crossLastAtMs },
      { qualifies, block: reading.block, atMs: ctx.nowMs, intervalMs: ctx.deps.intervalMs ?? 60_000 });
    updates.push({ ...order, crossCount: next.count, crossLastBlock: next.lastBlock, crossLastAtMs: next.lastAtMs, lastSeenLiveBlock: reading.block, updatedAtMs: ctx.nowMs });
  }
  const walletStockWei = await dca.chain.tokenBalance(pool.stock, agent.walletAddress, reading.block);
  const current = await dca.store.listOrders(agent.id, round.roundNo);
  const equityWei = round.phase === "active" ? await dcaEquityAt(ctx, round, current, reading, walletStockWei) : 0n;
  const stopLossBps = ctx.settings.dcaStopLossBps ?? null;
  const counter = agent.status === "armed" && round.phase === "active" && stopLossBps !== null
    ? dcaAdvanceCounter({ count: round.slCount, lastBlock: round.slLastBlock, lastAtMs: round.slLastAtMs },
      { qualifies: dcaStopLossBreached(equityWei, round.slBaselineWei, stopLossBps), block: reading.block, atMs: ctx.nowMs, intervalMs: ctx.deps.intervalMs ?? 60_000 })
    : null;
  await dca.store.withDcaFence(agent.ownerAddress, agent.id, async (sql) => {
    const stored = await dca.store.listOrders(agent.id, round.roundNo, sql);
    for (const update of updates) {
      // Only a row still live under the same NFT: an action may have marked it since.
      const now = stored.find((row) => row.orderKey === update.orderKey);
      if (now !== undefined && now.state === "live" && now.tokenId === update.tokenId) await dca.store.putOrder(update, sql);
    }
    if (counter !== null && (counter.count !== round.slCount || counter.lastBlock !== round.slLastBlock)) {
      const fresh = await dca.store.getOpenRound(agent.ownerAddress, agent.id, sql);
      if (fresh !== null && fresh.roundNo === round.roundNo) {
        await dca.store.writeRound({ ...fresh, slCount: counter.count, slLastBlock: counter.lastBlock, slLastAtMs: counter.lastAtMs, updatedAtMs: ctx.nowMs }, sql);
      }
    }
  });
  return { reading, orders: await dca.store.listOrders(agent.id, round.roundNo), walletStockWei, equityWei };
}

/**
 * R2.12: a live order whose NFT reads liquidity 0 that no plane action exited.
 * Its own `Collect` receipt books it exactly (recipient = wallet ⇒ owner-closed);
 * a foreign recipient is a leaked-key signal (`collected-elsewhere`); a window
 * past {@link DCA_LOG_WINDOW_BLOCKS} (condition 3) or no log at all marks the
 * round unreliable. A failed log read is no evidence: the next cycle retries.
 */
async function reconcileDcaOwnerClose(ctx: DcaContext, round: DcaRoundRow, order: DcaOrderRow, zeroSeenBlock: bigint): Promise<void> {
  const { dca, agent, pool } = ctx;
  const markUnreliable = async (closedBy: DcaOrderRow["closedBy"], usdt: bigint, stock: bigint): Promise<void> => {
    await dca.store.withDcaFence(agent.ownerAddress, agent.id, async (sql) => {
      const fresh = await dca.store.getOpenRound(agent.ownerAddress, agent.id, sql);
      if (fresh === null || fresh.roundNo !== round.roundNo) return;
      await dca.store.writeRound({ ...fresh, unreliable: true, updatedAtMs: ctx.nowMs }, sql);
      if (closedBy !== null) await dca.store.putOrder({ ...order, state: "exited", collectedUsdtWei: usdt, collectedStockWei: stock, closedBy, updatedAtMs: ctx.nowMs }, sql);
    });
  };
  const from = (order.lastSeenLiveBlock ?? 0n) + 1n;
  if (order.lastSeenLiveBlock === null || zeroSeenBlock < from || zeroSeenBlock - from > DCA_LOG_WINDOW_BLOCKS) {
    await markUnreliable(null, 0n, 0n);
    return;
  }
  let hashes: readonly Hex[];
  try {
    hashes = [...new Set((await dca.chain.nfpmLogs(order.tokenId!, from, zeroSeenBlock))
      .filter((row) => row.topic.toLowerCase() === DCA_NFPM_COLLECT_TOPIC).map((row) => row.transactionHash))];
  } catch {
    return;
  }
  if (hashes.length === 0) {
    await markUnreliable(null, 0n, 0n);
    return;
  }
  let usdt = 0n;
  let stock = 0n;
  let elsewhere = false;
  for (const txHash of hashes) {
    const receipt = await dca.receipts.getReceipt(txHash);
    if (receipt === null || receipt.status !== 1n) return; // not readable on the pair yet: retry
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== dca.nfpm.toLowerCase() || log.topics[0]?.toLowerCase() !== DCA_NFPM_COLLECT_TOPIC
        || log.topics[1] === undefined || BigInt(log.topics[1]) !== order.tokenId) continue;
      const [recipient, amount0, amount1] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], log.data);
      if (recipient.toLowerCase() !== agent.walletAddress.toLowerCase()) elsewhere = true;
      usdt += dcaUsdt(pool, amount0, amount1);
      stock += dcaStock(pool, amount0, amount1);
    }
  }
  if (elsewhere) {
    await markUnreliable("elsewhere", usdt, stock);
    return;
  }
  await dca.store.withDcaFence(agent.ownerAddress, agent.id, async (sql) => {
    const fresh = await dca.store.getOpenRound(agent.ownerAddress, agent.id, sql);
    const stored = (await dca.store.listOrders(agent.id, round.roundNo, sql)).find((row) => row.orderKey === order.orderKey);
    if (fresh === null || fresh.roundNo !== round.roundNo || stored === undefined || stored.state !== "live" || stored.tokenId !== order.tokenId) return;
    const ledger = dcaApplyExit(dcaLedgerOf(fresh), { role: order.role, mintedUsdtWei: order.mintedUsdtWei, collectedUsdtWei: usdt, collectedStockWei: stock });
    await dca.store.writeRound({ ...fresh, ...ledger, updatedAtMs: ctx.nowMs }, sql);
    // A pulled level that bought nothing returns to pending; one that bought is a fill (R2.23 item 3).
    await dca.store.putOrder(order.role === "level" && stock === 0n
      ? { ...order, state: "pending", tokenId: null, liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, crossCount: 0, crossLastBlock: null,
        crossLastAtMs: null, createdByAction: null, lastSeenLiveBlock: null, closedBy: "owner", updatedAtMs: ctx.nowMs }
      : { ...order, state: "exited", collectedUsdtWei: usdt, collectedStockWei: stock, closedBy: "owner", updatedAtMs: ctx.nowMs }, sql);
  });
}

/* ---- submitting one batch -------------------------------------------------- */

/**
 * R2.19 + R2.13: snapshot the wallet at the reading, price the FULL batch in
 * native wei immediately before the submit, then hand it to the executor.
 */
async function submitDcaBatch(ctx: DcaContext, round: DcaRoundRow, plan: DcaBatchPlan, sweep: boolean): Promise<DcaExecuteResult | "dca-quote-deficit"> {
  const { dca, agent, pool } = ctx;
  const [walletUsdtWei, walletStockWei] = await Promise.all([
    dca.chain.tokenBalance(USDT_56, agent.walletAddress, plan.readingBlock),
    dca.chain.tokenBalance(pool.stock, agent.walletAddress, plan.readingBlock),
  ]);
  // Audit M-3: a start already carries its pricing's own wei quote; only the other batches are quoted here.
  const relayQuoteWei = plan.relayQuoteWei ?? await dca.batchCostWei({ agent,
    calls: dcaBatchCalls(plan, { pool, nfpm: dca.nfpm, wallet: agent.walletAddress, treasury: ctx.deps.platformFeeTreasury ?? null }) });
  if (relayQuoteWei === null) return "dca-quote-deficit";
  return dca.executeRange({ agent, pool, round, sweep, settings: ctx.settings,
    plan: { ...plan, preSubmit: { walletUsdtWei, walletStockWei }, relayQuoteWei } });
}

const DCA_SUBMITTED_REASON: Readonly<Record<DcaBatchKind, string>> = {
  "start": "dca-placed", "close-start": "dca-round-closed", "close": "dca-round-closed", "level-place": "dca-placed",
  "fill": "dca-level-filled", "tp-place": "dca-placed", "stop-loss": "dca-stop-loss", "remove": "dca-removing",
};

function dcaResultReason(plan: DcaBatchPlan, result: DcaExecuteResult | "dca-quote-deficit"): string {
  if (result === "dca-quote-deficit") return result;
  if (result.kind === "submitted") return DCA_SUBMITTED_REASON[plan.kind];
  if (result.kind === "unknown") return "dca-submission-unknown";
  return result.code;
}

/* ---- the protective steps (R2.8 3a/3b, §7, R2.17, R2.18) ------------------ */

/** Condition 1: the union of the store's live orders and the chain's positions in the pool. */
async function dcaSweepOrders(ctx: DcaContext, round: DcaRoundRow | null, block: bigint): Promise<readonly DcaLiveOrder[]> {
  const chainPositions = await dcaChainPositions(ctx.dca.chain, ctx.pool, ctx.agent.walletAddress, block);
  const stored = round === null ? [] : await ctx.dca.store.listOrders(ctx.agent.id, round.roundNo);
  return chainPositions.map((position) => {
    const order = stored.find((row) => row.tokenId === position.tokenId);
    return { orderKey: order?.orderKey ?? `chain:${position.tokenId}`, role: order?.role ?? "level", levelNo: order?.levelNo ?? null,
      tokenId: position.tokenId, tickLower: position.tickLower, tickUpper: position.tickUpper, liquidity: position.liquidity };
  });
}

function dcaOwnerActedSince(agent: AgentRecord, settingsRow: TradeSettingsRecord, stampMs: number | null): boolean {
  return stampMs !== null && (agent.updatedAt > stampMs || settingsRow.updatedAt > stampMs || (settingsRow.drainingAt ?? 0) > stampMs);
}

/** Audit M-2: how long a protective step waits for a `committed` action's finish. */
const DCA_COMMITTED_WAIT_MS = 10 * 60 * 1_000;

async function runDcaProtective(ctx: DcaContext, settingsRow: TradeSettingsRecord): Promise<{ readonly reason: string; readonly submitted: boolean } | null> {
  const { dca, agent, pool } = ctx;
  if (agent.status !== "armed" && agent.status !== "paused") return null;
  const round = await dca.store.getOpenRound(agent.ownerAddress, agent.id);
  const draining = settingsRow.drainingAt !== null;
  const stopping = round !== null && (round.phase === "closing" && round.closeCause === "stop-loss"
    || round.phase === "active" && agent.status === "armed" && ctx.settings.dcaStopLossBps !== null && ctx.settings.dcaStopLossBps !== undefined
      && dcaCounterConfirmed({ count: round.slCount, lastBlock: round.slLastBlock, lastAtMs: round.slLastAtMs }));
  if (!draining && !stopping) return null;
  // R2.8: wait only for an action in flight — and for a landed one whose finish
  // is one finality away — never for `unknown`, and never for a receipt
  // mismatch, which is an audit item that must not hold a sweep hostage. A
  // landed one whose receipt stays unreadable is waited for ten minutes, then
  // swept past (audit M-2); its finish books an unknown collect as unreliable.
  const actions = await dca.store.listActions(agent.ownerAddress, agent.id);
  if (actions.some((row) => row.state === "intended" || row.state === "submitted"
    || row.state === "committed" && !(row.note ?? "").startsWith("dca-receipt-mismatch") && ctx.nowMs - row.createdAtMs < DCA_COMMITTED_WAIT_MS)) {
    return { reason: draining ? "dca-removing:waiting-for-an-in-flight-submission" : "dca-stop-loss:waiting-for-an-in-flight-submission", submitted: false };
  }
  if (round === null) return null;
  const reading = await dca.chain.reading(pool.pool);
  const sweepOrders = (await dcaSweepOrders(ctx, round, reading.block)).slice(0, DCA_MAX_EXITS_PER_BATCH);
  const deadlineSec = BigInt(Math.floor(ctx.nowMs / 1_000)) + DCA_BATCH_DEADLINE_SEC;
  const base = { pool, roundNo: round.roundNo, reading, deadlineSec };
  if (!draining) {
    if (sweepOrders.length === 0) {
      // Condition 1: `stopped` only once the chain shows nothing left in the pool.
      await dca.store.withDcaFence(agent.ownerAddress, agent.id, async (sql) => {
        const fresh = await dca.store.getOpenRound(agent.ownerAddress, agent.id, sql);
        if (fresh !== null && fresh.roundNo === round!.roundNo) {
          await dca.store.writeRound({ ...fresh, phase: "stopped", closeCause: "stop-loss", stoppedAtMs: ctx.nowMs, slCount: 0, slLastBlock: null, slLastAtMs: null, updatedAtMs: ctx.nowMs }, sql);
        }
      });
      // §7.4 / R2.17: the pause route's two writes. A lost CAS leaves the round
      // `stopped`, which is itself the latch: nothing starts, mints or sells in it.
      if (agent.status === "armed" && ctx.deps.killswitch !== undefined) {
        const paused = await ctx.deps.agentStore.transitionAgentStatus({ ownerAddress: agent.ownerAddress, agentId: agent.id,
          expectedStatus: "armed", expectedRowVersion: agent.rowVersion, status: "paused" });
        if (paused !== null) await ctx.deps.killswitch.pauseAgent(agent.id, agent.ownerAddress);
      }
      return { reason: "dca-stopped", submitted: false };
    }
    const plan = planDcaStopLoss({ ...base, orders: sweepOrders, slippageBps: ctx.settings.slippageBps });
    const result = await submitDcaBatch(ctx, round, plan, true);
    return { reason: dcaResultReason(plan, result), submitted: result !== "dca-quote-deficit" && result.kind !== "denied" };
  }
  // Remove (R2.18) as amended by AUTO-DCA R4.1: sweep with the owner's floors;
  // nothing is sold. A sweep never backs off (condition 10 is void).
  if (sweepOrders.length > 0) {
    const plan = planDcaRemove({ ...base, orders: sweepOrders, slippageBps: ctx.settings.slippageBps });
    const result = await submitDcaBatch(ctx, round, plan, true);
    return { reason: dcaResultReason(plan, result), submitted: result !== "dca-quote-deficit" && result.kind !== "denied" };
  }
  // R4.2 guard (c): a mint-bearing unknown batch may still land inside its NFPM deadline.
  if (actions.some((row) => row.state === "unknown" && row.plan.mints.length > 0 && ctx.nowMs - row.createdAtMs < DCA_NOT_LANDED_MIN_AGE_MS)) {
    return { reason: "dca-removing:waiting-for-an-unknown-mint", submitted: false };
  }
  // R4.3: nothing is left on chain and no unknown mint is outstanding — settle `removed`.
  // `dcaCarryOut` and the unsold_* figures are derived from `fresh`, the round
  // re-read inside the fence (audit MEDIUM 6): a ledger write that lands
  // between this read and the lock must not be silently overwritten by a
  // settle computed from the stale copy.
  const mid = dcaMidPrice(pool, reading.sqrtPriceX96);
  const orders = await dca.store.listOrders(agent.id, round.roundNo);
  const legacySold = actions.filter((row) => row.roundNo === round!.roundNo && row.kind === "remove" && row.state === "finished" && row.plan.swap?.side === "sell")
    .reduce((sum, row) => sum + (row.plan.swap?.amountInWei ?? 0n), 0n);
  const unbooked = orders.some((order) => (order.state === "live" || order.state === "exiting") && order.tokenId !== null);
  await dca.store.withDcaFence(agent.ownerAddress, agent.id, async (sql) => {
    const fresh = await dca.store.getOpenRound(agent.ownerAddress, agent.id, sql);
    if (fresh === null || fresh.roundNo !== round!.roundNo) return;
    const settled = dcaCarryOut(fresh, orders, legacySold);
    const unsoldValueWei = dcaStockValue(settled.carriedStockWei, mid);
    await dca.store.writeRound({ ...fresh, phase: "settled", closeCause: "removed", realizedPnlWei: settled.realizedPnlWei,
      unsoldStockWei: settled.carriedStockWei, unsoldCostWei: settled.carriedCostWei, unsoldValueWei,
      unreliable: fresh.unreliable || unbooked, settledAtMs: ctx.nowMs, updatedAtMs: ctx.nowMs }, sql);
  });
  return { reason: "dca-removed", submitted: false };
}

/**
 * The swap leg a start carries: the priced offer's calls with the guard
 * deadline CLAMPED to the contract's window before it is encoded (the
 * executor's C3/R2.5 clamp, moved to build time because the calls are data).
 * The direct leg is exactly the TradFi builder's three calls (condition 11).
 */
function dcaSwapLeg(
  ctx: DcaContext,
  side: "buy" | "sell",
  amountInWei: bigint,
  quote: { readonly venue: TradeVenueId; readonly router: Address; readonly route: TradeRoute; readonly minOutAtomic: bigint; readonly quotedOutAtomic: bigint; readonly expiresAt: number },
  guardQuote: TradeRequest["guardQuote"] | undefined,
): DcaSwapLeg {
  // The window counts from NOW, when the priced offer is in hand — not from the
  // cycle start (`ctx.nowMs`): a slow pricing would otherwise eat the window and
  // the executor's 6 s re-check would refuse it as GUARD_QUOTE_EXPIRED (2026-09-25).
  const cap = BigInt(Math.floor((ctx.deps.now?.() ?? Date.now()) / 1_000)) + TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC - 1n;
  const clamped = guardQuote === undefined ? undefined : { ...guardQuote, deadline: guardQuote.deadline < cap ? guardQuote.deadline : cap };
  const calls = buildV2CostCalls({ quote, token: ctx.pool.stock, amountInAtomic: amountInWei, wallet: ctx.agent.walletAddress, feeAtomic: 0n,
    side, ...(clamped === undefined ? {} : { guardQuote: clamped }) });
  return { side, amountInWei, minOutWei: quote.minOutAtomic, quotedOutWei: quote.quotedOutAtomic, calls,
    ...(clamped === undefined ? {} : { guard: { address: clamped.guard, calldata: clamped.calldata, deadlineSec: clamped.deadline } }) };
}

/**
 * The projection phase for one DCA agent (R2.8): convergence, observation and
 * the protective steps. Returns whether it attempted a submission, so the
 * strategy phase submits nothing more this cycle.
 */
async function runDcaProjection(deps: TradeWorkerDeps, agent: AgentRecord, settingsRow: TradeSettingsRecord): Promise<boolean> {
  const dca = deps.dca;
  if (dca === undefined) return false;
  const parsed = parseTradeSettings(settingsRow.params);
  if (!parsed.ok || !isTradeDcaSettings(parsed.value.effective)) return false;
  const settings = parsed.value.effective;
  const pool = dcaPoolForToken(settings.dcaToken ?? "");
  if (pool === null) return false;
  const ctx: DcaContext = { deps, dca, agent, settings, pool, nowMs: deps.now?.() ?? Date.now() };
  await reconcileDcaActions(ctx);
  const round = await dca.store.getOpenRound(agent.ownerAddress, agent.id);
  if (round !== null && round.phase !== "settled") await observeDca(ctx, round);
  const protective = await runDcaProtective(ctx, settingsRow);
  if (protective !== null) await dcaInsertRun(ctx, protective.reason);
  return protective?.submitted === true;
}

/* ---- the strategy phase (R2.8, R2.4–R2.6, R2.13–R2.15) --------------------- */

async function runDcaStrategy(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settingsRow: TradeSettingsRecord,
  settings: EffectiveTradeSettings,
  counts: MutableCounts,
  snapshot: RwaLaneSnapshot,
  dryRun: boolean,
  alreadySubmitted: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const dca = deps.dca;
  if (dca === undefined) return "dca-disabled";
  const pool = dcaPoolForToken(settings.dcaToken ?? "");
  const facts = agent.sessionFacts;
  if (pool === null || facts === null) return "settings-invalid";
  counts.candidates = 1;
  const nowMs = deps.now?.() ?? Date.now();
  const ctx: DcaContext = { deps, dca, agent, settings, pool, nowMs };
  const actions = await dca.store.listActions(agent.ownerAddress, agent.id);
  if (actions.some((row) => row.state === "unknown")) return "dca-submission-unknown";
  if (actions.some((row) => row.state === "committed" && (row.note ?? "").startsWith("dca-receipt-mismatch"))) return "dca-receipt-mismatch";
  if (alreadySubmitted || actions.some((row) => row.state === "intended" || row.state === "submitted" || row.state === "committed")) return "dca-action-in-flight";
  let round = await dca.store.getOpenRound(agent.ownerAddress, agent.id);
  if (round !== null && round.unreliable) {
    const orders = await dca.store.listOrders(agent.id, round.roundNo);
    return orders.some((row) => row.closedBy === "elsewhere") ? "dca-collected-elsewhere" : "dca-round-unreliable";
  }
  if (!dca.enabled) return "dca-disabled";
  if (settingsRow.drainingAt !== null) return "dca-removing";
  if (round !== null && round.phase === "closing") return round.closeCause === "remove" ? "dca-removing" : "dca-stop-loss";
  // R7: a dry run reads nothing further and writes nothing at all.
  if (dryRun) return "dry-run";
  const roundNo = round?.roundNo;
  const lastRoundAction = actions.filter(action => action.roundNo === roundNo).at(-1);
  const simulationUnmerge = lastRoundAction?.kind === "close-start" && lastRoundAction.state === "rolled-back" && lastRoundAction.note === "SIMULATION_FAILED";
  let heldBy: "dca-retry-exhausted" | "dca-retry-backoff" | null = null;
  if (round !== null && round.revertStreak >= DCA_REVERT_EXHAUSTED_AT) {
    if (!dcaOwnerActedSince(agent, settingsRow, round.backoffUntilMs)) heldBy = "dca-retry-exhausted";
    else {
      round = await dca.store.writeRound({ ...round, revertStreak: 0, backoffUntilMs: null, updatedAtMs: nowMs });
      if (round === null) return "dca_round_changed";
    }
  }
  if (heldBy === null && round !== null && round.backoffUntilMs !== null && round.backoffUntilMs > nowMs) heldBy = "dca-retry-backoff";
  if (heldBy !== null && !simulationUnmerge) return heldBy;
  const reading = await dca.chain.reading(pool.pool);
  const deadlineSec = BigInt(Math.floor(nowMs / 1_000)) + DCA_BATCH_DEADLINE_SEC;
  const walletStockWei = await dca.chain.tokenBalance(pool.stock, agent.walletAddress, reading.block);
  const mid = dcaMidPrice(pool, reading.sqrtPriceX96);
  if (round !== null && round.phase === "stopped") {
    // D12 (§7.5): the owner unpaused a stop-loss stop; re-anchor the baseline at
    // this reading's equity so the same stop cannot fire again, and continue.
    const orders = await dca.store.listOrders(agent.id, round.roundNo);
    const equity = await dcaEquityAt(ctx, round, orders, reading, walletStockWei);
    await dca.store.writeRound({ ...round, phase: "active", slBaselineWei: equity, slCount: 0, slLastBlock: null, slLastAtMs: null, updatedAtMs: nowMs });
    return "dca-resumed";
  }

  // Gates. A start gate binds the start and the merged close; a level gate binds a level mint alone.
  const expiryMs = facts.expiry * 1_000;
  const clampMs = facts.grantedAtSec === undefined ? agent.createdAt : facts.grantedAtSec * 1_000;
  const windowMs = expiryMs - clampMs;
  const cutoffMs = Math.min(SESSION_ENTRY_CUTOFF_MS, (Number.isFinite(windowMs) && windowMs > 0 ? windowMs : MAX_TRADE_SESSION_SECONDS * 1_000) / 2);
  const sessionHold = nowMs >= expiryMs - cutoffMs ? "session-expiring" : null;
  const entryWei = BigInt(settings.entryWei);
  const orderWei = BigInt(settings.dcaOrderWei ?? "0");
  const feeWei = tradfiV2BuyFeeWei(entryWei, DCA_PLATFORM_FEE_BPS);
  const pending = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
  const walletUsdt = await dca.chain.tokenBalance(USDT_56, agent.walletAddress, reading.block);
  const spendable = walletUsdt > pending ? walletUsdt - pending : 0n;
  const meter = await readTradfiV2QuoteRemaining(deps, agent, facts, signal);
  const capRoom = meter === null ? null : meter > pending ? meter - pending : 0n;
  const spendHold = (spend: bigint, extraCash: bigint): string | null => {
    if (capRoom === null) return "quote-meter-unavailable";
    if (spendable + extraCash < spend) return "dca-cash-low";
    if (capRoom < spend + orderWei) return "dca-cap-exhausted";
    return null;
  };
  const orders = round === null ? [] : await dca.store.listOrders(agent.id, round.roundNo);
  const live = orders.filter((row) => row.state === "live" && row.tokenId !== null);
  for (const order of live) {
    const position = await dca.chain.position(order.tokenId!, reading.block);
    if (position === "burned" || position.liquidity !== order.liquidity || position.tickLower !== order.tickLower || position.tickUpper !== order.tickUpper) {
      return "dca-order-mismatch";
    }
  }
  const reads = (order: DcaOrderRow): boolean => dcaOrderReadsFilled({ pool, role: order.role, range: order, liquidity: order.liquidity, reading });
  const confirmed = (order: DcaOrderRow): boolean => dcaCounterConfirmed({ count: order.crossCount, lastBlock: order.crossLastBlock, lastAtMs: order.crossLastAtMs }) && reads(order);
  const liveTp = live.find((row) => row.role === "tp") ?? null;
  const liveLevels = live.filter((row) => row.role === "level");
  const filled = liveLevels.filter(confirmed);
  const tpConfirmed = liveTp !== null && confirmed(liveTp);
  const tpPrincipal = live.filter((row) => row.role === "tp").reduce((sum, row) => sum + row.mintedStockWei, 0n);
  const roundStock = round === null ? 0n : round.stockAcquiredWei > tpPrincipal ? round.stockAcquiredWei - tpPrincipal : 0n;
  const walletRoundStockWei = walletStockWei < roundStock ? walletStockWei : roundStock;

  // R3.1: the open slots, `ahead − (live levels − levels this batch exits as filled)`,
  // filled from the pending levels in ladder order at their persisted ticks (I4);
  // a passed or out-of-range candidate met on the way is skipped for the round (R3.4, D5).
  const ahead = dcaAhead(settings.dcaMaxOrders ?? 0);
  const open = ahead - (liveLevels.length - filled.length);
  const levelsToMint: DcaOrderRow[] = [];
  const anchor = round === null || round.phase !== "active" ? null : dcaRoundAnchor(round, actions);
  if (anchor !== null && open > 0) {
    for (const order of orders.filter((row) => row.role === "level" && row.state === "pending").sort((a, b) => (a.levelNo ?? 0) - (b.levelNo ?? 0))) {
      if (levelsToMint.length >= open) break;
      const verdict = dcaLevelVerdict({ pool, levelPrice: dcaLevelPrice(anchor, order.levelNo ?? 1, settings.dcaStepBps ?? 0), range: order,
        rangeMinE8: settings.dcaRangeMinE8 === null || settings.dcaRangeMinE8 === undefined ? null : BigInt(settings.dcaRangeMinE8), reading });
      if (verdict === "passed" || verdict === "below-range") {
        await dca.store.withDcaFence(agent.ownerAddress, agent.id, async (sql) => {
          const stored = (await dca.store.listOrders(agent.id, order.roundNo, sql)).find((row) => row.orderKey === order.orderKey);
          if (stored !== undefined && stored.state === "pending") await dca.store.putOrder({ ...stored, state: "skipped", updatedAtMs: nowMs }, sql);
        });
        continue;
      }
      levelsToMint.push(order);
    }
  }
  // R3.5: the level gate is all or nothing over this batch's `m` mints; the session cutoff stays first (I10).
  const levelHold = sessionHold ?? spendHold(BigInt(levelsToMint.length) * orderWei, 0n);
  const roundActive = round !== null && round.phase === "active";
  const startNeeded = !roundActive || tpConfirmed;
  let startHold: string | null = null;
  if (startNeeded) {
    // R2.4 / R3.5: a merged close + start counts its exits' USDT, each at its 1 bp
    // floor, as cash: the TP collect and the resting levels'.
    const exitCash = [...(liveTp === null ? [] : [liveTp]), ...liveLevels].reduce((sum, order) => {
      const amounts = getAmountsForLiquidity(reading.sqrtPriceX96, order.tickLower, order.tickUpper, order.liquidity);
      return sum + dcaUsdt(pool, amounts.amount0, amounts.amount1) * 9_999n / 10_000n;
    }, 0n);
    startHold = sessionHold
      ?? dcaPriceRangeHold({ pool, sqrtPriceX96: reading.sqrtPriceX96,
        rangeMinE8: settings.dcaRangeMinE8 === null || settings.dcaRangeMinE8 === undefined ? null : BigInt(settings.dcaRangeMinE8),
        rangeMaxE8: settings.dcaRangeMaxE8 === null || settings.dcaRangeMaxE8 === undefined ? null : BigInt(settings.dcaRangeMaxE8) })
      ?? spendHold(entryWei + feeWei + BigInt(ahead) * orderWei, exitCash)
      ?? await dcaEconomicsHold(ctx, entryWei, feeWei);
  }
  const guardExpiredStreak = (() => {
    let streak = 0;
    for (const action of [...actions].reverse()) {
      if (round === null || action.roundNo !== round.roundNo) break;
      // R3.4: a FAILED rollback of the merged batch unmerges exactly like GUARD_QUOTE_EXPIRED.
      if (action.kind !== "close-start" || action.state !== "rolled-back" || (action.note !== "GUARD_QUOTE_EXPIRED" && action.note !== "FAILED")) break;
      streak += 1;
    }
    return streak;
  })();
  const step = nextDcaStrategyStep({ roundActive, filledLevelNos: filled.map((row) => row.levelNo ?? 0), tpConfirmed,
    liveLevelReadsFilled: liveLevels.some(reads), levelsToMint: levelsToMint.map((row) => row.levelNo ?? 0), startHold, levelHold,
    guardExpiredStreak: simulationUnmerge ? DCA_GUARD_EXPIRED_UNMERGE : guardExpiredStreak });
  if (heldBy !== null && step.kind !== "close") return heldBy;
  // Review C7 (M2): a resting level the tick sits inside blocks the close's strictly-outside
  // exit (I6); hold by name until it leaves the range or its fill batch collects it.
  if ((step.kind === "close" || step.kind === "close-start") && liveLevels.some((order) => gridTargetSide(reading.tick, order) === undefined)) {
    return "dca-level-inside-range";
  }
  const closeAlone = dcaCloseAloneOnce.delete(agent.id);

  // R2.6 / D12 / R2.11: an active round with round stock and no TP resting re-places it.
  const tpMissing = roundActive && liveTp === null && !orders.some((row) => row.role === "tp" && row.state === "minting")
    && dcaStockValue(walletRoundStockWei, mid) > DCA_DUST_USDT_WEI;
  // R2.11: a TP the owner pulled after it converted leaves proceeds and no stock: the round settles here.
  if (roundActive && round !== null && liveTp === null && !tpMissing && round.usdtCollectedWei > 0n && liveLevels.length === 0
    && !orders.some((row) => row.state === "minting" || row.state === "exiting")) {
    const closed = dcaCarryOut(round, orders);
    const written = await dca.store.writeRound({ ...round, phase: "settled", closeCause: "take-profit", realizedPnlWei: closed.realizedPnlWei, settledAtMs: nowMs, updatedAtMs: nowMs });
    return written === null ? "dca_round_changed" : "dca-round-closed";
  }
  const base = { pool, roundNo: round?.roundNo ?? 0, reading, deadlineSec };
  const tpKey = (roundNo: number): string => `r${roundNo}:tp:${reading.block}`;
  let plan: DcaBatchPlan;
  let submitRound: DcaRoundRow;
  try {
    const levelInputs = (levelNos: readonly number[]) => levelsToMint.filter((row) => levelNos.includes(row.levelNo ?? 0))
      .map((row) => ({ orderKey: row.orderKey, levelNo: row.levelNo ?? 0, range: row }));
    if (step.kind === "fill" && round !== null) {
      plan = planDcaFill({ ...base, filled: filled.map((row) => ({ ...dcaLive(row), mintedUsdtWei: row.mintedUsdtWei })),
        oldTp: liveTp === null ? null : dcaLive(liveTp), ledger: round, walletRoundStockWei, takeProfitBps: settings.dcaTakeProfitBps ?? 0,
        tpOrderKey: tpKey(round.roundNo), nextLevels: levelInputs(step.nextLevelNos), orderWei });
      submitRound = round;
    } else if ((step.kind === "close" || step.kind === "close-start" && closeAlone) && round !== null && liveTp !== null) {
      plan = planDcaClose({ ...base, tp: dcaLive(liveTp), liveLevels: liveLevels.map(dcaLive) });
      submitRound = round;
    } else if (step.kind === "close-start" || step.kind === "start") {
      const built = await buildDcaStart(ctx, round, orders, liveTp, liveLevels, reading, deadlineSec, walletStockWei, counts, snapshot, signal);
      if (typeof built === "string") {
        // Review C3: a merged close + start that cannot be built or priced never holds the close hostage (R2.4).
        if (step.kind === "close-start") dcaCloseAloneOnce.add(agent.id);
        return built;
      }
      plan = built.plan;
      submitRound = built.round;
    } else if (tpMissing && round !== null) {
      plan = planDcaTpPlace({ ...base, ledger: round, walletRoundStockWei, takeProfitBps: settings.dcaTakeProfitBps ?? 0, tpOrderKey: tpKey(round.roundNo) });
      submitRound = round;
    } else if (step.kind === "level-place" && round !== null) {
      plan = planDcaLevelPlace({ ...base, levels: levelInputs(step.levelNos), orderWei });
      submitRound = round;
    } else {
      return step.kind === "hold" ? step.reason : "dca-waiting";
    }
  } catch (error) {
    signal?.throwIfAborted();
    return `dca-plan-refused:${sanitizeMessage(error instanceof Error ? error.message : "unknown").slice(0, 80)}`;
  }
  const result = await submitDcaBatch(ctx, submitRound, plan, false);
  if (plan.kind === "close-start" && result !== "dca-quote-deficit" && result.kind === "denied") dcaCloseAloneOnce.add(agent.id);
  if (result === "dca-quote-deficit" || result.kind === "rolled-back" && !DCA_HOLD_CODES.has(result.code)) await bumpDcaStreak(ctx, submitRound.roundNo);
  if (result !== "dca-quote-deficit" && result.kind === "submitted" && plan.swap !== null) counts.entries += 1;
  return dcaResultReason(plan, result);
}

/**
 * R2.15's hold at every round start: the no-fill round's billed cost, with its
 * `ahead` level mints and exits (R3.5), at the live gas price bounded at
 * 1 000 gwei, against its worst gross.
 */
async function dcaEconomicsHold(ctx: DcaContext, entryWei: bigint, feeWei: bigint): Promise<string | null> {
  let gasPriceWei: bigint;
  try { gasPriceWei = await ctx.dca.chain.gasPriceWei(); } catch { return "cost-unavailable"; }
  if (gasPriceWei > DCA_MAX_GAS_PRICE_WEI) gasPriceWei = DCA_MAX_GAS_PRICE_WEI;
  const facts = freshNativeCostFacts(await ctx.deps.dataPlane.tokensBatch([WBNB_56, USDT_56]), Date.now());
  const r0CostUsdtWei = facts === null ? null : nativeCostToUsdtAtomic(dcaBilledNativeWei(dcaR0Gas(ctx.pool, dcaAhead(ctx.settings.dcaMaxOrders ?? 0)), gasPriceWei), facts);
  if (r0CostUsdtWei === null) return "cost-unavailable";
  return dcaUneconomic({ pool: ctx.pool, entryWei, feeWei, takeProfitBps: ctx.settings.dcaTakeProfitBps ?? 0, r0CostUsdtWei }) ? "dca-uneconomic" : null;
}

/**
 * Batch 1 or 2 (R2.4): the guard-first TradFi v2 buy priced WITH the batch's
 * NFPM calls (R2.3 item 1's hook), the trigger on round 1 (R2.14), and the TP
 * placed from the worst-case average, spend / `minOut` (R2.6).
 */
async function buildDcaStart(
  ctx: DcaContext,
  round: DcaRoundRow | null,
  orders: readonly DcaOrderRow[],
  liveTp: DcaOrderRow | null,
  liveLevels: readonly DcaOrderRow[],
  reading: DcaReading,
  deadlineSec: bigint,
  walletStockWei: bigint,
  counts: MutableCounts,
  snapshot: RwaLaneSnapshot,
  signal?: AbortSignal,
): Promise<{ readonly plan: DcaBatchPlan; readonly round: DcaRoundRow } | string> {
  const { deps, dca, agent, settings, pool } = ctx;
  const facts = agent.sessionFacts!;
  const entryWei = BigInt(settings.entryWei);
  const feeWei = tradfiV2BuyFeeWei(entryWei, DCA_PLATFORM_FEE_BPS);
  const closing = round !== null && round.phase === "active" && liveTp !== null;
  // The round this start is claimed on: the closing round (batch 2), a round
  // already `starting` (a retried start), or a new one carrying the last
  // settled round's residue.
  let startRound: DcaRoundRow;
  let carry = { carriedStockWei: 0n, carriedCostWei: 0n };
  if (closing && round !== null) {
    startRound = round;
    const projected = dcaCarryOut(round, orders.map((row) => row.tokenId === liveTp!.tokenId
      ? { ...row, state: "exited" as const, collectedStockWei: 0n } : row));
    carry = { carriedStockWei: projected.carriedStockWei, carriedCostWei: projected.carriedCostWei };
  } else if (round === null) {
    const rounds = await dca.store.listRounds(agent.ownerAddress, agent.id);
    const last = rounds.at(-1);
    if (last !== undefined) {
      const out = dcaCarryOut(last, await dca.store.listOrders(agent.id, last.roundNo));
      carry = { carriedStockWei: out.carriedStockWei, carriedCostWei: out.carriedCostWei };
    }
    const inserted = await dca.store.insertRound({ agentId: agent.id, ownerAddress: agent.ownerAddress, roundNo: (last?.roundNo ?? 0) + 1, phase: "starting",
      p0UsdtWei: null, p0StockWei: null, costUsdtWei: carry.carriedCostWei, stockAcquiredWei: carry.carriedStockWei,
      carriedStockWei: carry.carriedStockWei, carriedCostWei: carry.carriedCostWei,
      slBaselineWei: last?.slBaselineWei ?? BigInt(settings.capitalQuoteWei ?? "0"), nowMs: ctx.nowMs });
    if (inserted === null) return "dca_round_changed";
    startRound = inserted;
  } else {
    startRound = round;
    carry = { carriedStockWei: startRound.carriedStockWei, carriedCostWei: startRound.carriedCostWei };
  }
  const residueStockWei = walletStockWei < carry.carriedStockWei ? walletStockWei : carry.carriedStockWei;
  const tpRoundNo = closing ? startRound.roundNo + 1 : startRound.roundNo;
  const tpOrderKey = `r${tpRoundNo}:tp:${reading.block}`;
  const base = { pool, roundNo: startRound.roundNo, reading, deadlineSec };
  const startParts = (swap: DcaSwapLeg) => ({ swap, feeWei, carriedCostWei: carry.carriedCostWei, residueStockWei,
    takeProfitBps: settings.dcaTakeProfitBps ?? 0, tpOrderKey,
    ladder: { stepBps: settings.dcaStepBps ?? 0, maxOrders: settings.dcaMaxOrders ?? 0, orderWei: BigInt(settings.dcaOrderWei ?? "0"),
      rangeMinE8: settings.dcaRangeMinE8 === null || settings.dcaRangeMinE8 === undefined ? null : BigInt(settings.dcaRangeMinE8) } });
  const planFor = (swap: DcaSwapLeg): DcaBatchPlan => closing
    ? planDcaCloseStart({ ...base, ...startParts(swap), tp: dcaLive(liveTp!), liveLevels: liveLevels.map(dcaLive) })
    : planDcaStart({ ...base, ...startParts(swap) });
  const settlementRow = (await deps.dataPlane.tokensBatch([USDT_56], signal)).find((row) => row.address.toLowerCase() === USDT_56.toLowerCase());
  const settlementUsd = freshTokenUsdFact(settlementRow, Date.now());
  if (settlementUsd === null) return "cost-unavailable";
  if (deps.tradfiNativeCostUsdtAtomic === undefined) return "cost-unavailable";
  const row = snapshot.rowsByAddress.get(pool.stock.toLowerCase());
  const candidate: EntryCandidate = {
    address: pool.stock, symbol: row?.symbol ?? pool.symbol, lane: "bstocks", marketCapUsd: null, priceUsd: null, volume24hUsd: null,
    priceChange24hPct: null, holders: null, ...(row?.venues === undefined ? {} : { venues: row.venues }), underlyingMarketClosed: false,
    rwaNote: null, marketStatus: null, eligibilitySource: "binance-rwa", eligibilityVenue: "pancake-v2", routeKind: "pancake-v2", scanReasons: [],
  };
  // The NFPM calls ride inside the same `prepareCalls` the pricing makes: the
  // relay prices the whole mixed batch, exits, the TP and level mints after the
  // swap; the offer's quoted output anchors the same levels the submit carries (R3.2).
  const extraCallsFor = (quote: V2CostQuote): readonly WalletCall[] => {
    const shaped = planFor({ side: "buy", amountInWei: entryWei, minOutWei: quote.minOutAtomic, calls: [],
      ...(quote.quotedOutAtomic === undefined ? {} : { quotedOutWei: quote.quotedOutAtomic }) });
    return dcaBatchCalls({ ...shaped, feeWei: 0n }, { pool, nfpm: dca.nfpm, wallet: agent.walletAddress, treasury: null });
  };
  const priced = await priceTradfiV2Buy(deps, agent, settings, { candidate, amount: entryWei, snapshot, settlementUsd,
    uniswapAllowed: sessionAllowsUniswap(agent, deps.uniswapRouter) }, facts, counts, signal, extraCallsFor);
  if (priced === "no-route") return "dca-no-route";
  // R2.14: round 1 fires only when the swap's own on-chain minOut guarantees a price at or below the trigger.
  if (startRound.roundNo === 1 && !closing && settings.dcaTriggerPriceE8 !== null && settings.dcaTriggerPriceE8 !== undefined
    && priced.quote.minOutAtomic < dcaTriggerMinOutWei(entryWei, BigInt(settings.dcaTriggerPriceE8))) {
    counts.refusals += 1;
    return "dca-trigger-not-reached";
  }
  const plan = planFor(dcaSwapLeg(ctx, "buy", entryWei, priced.quote, priced.guardQuote));
  return { plan: priced.nativeCostWei === undefined ? plan : { ...plan, relayQuoteWei: priced.nativeCostWei }, round: startRound };
}

export async function runTradeWorkerOnce(
  deps: TradeWorkerDeps,
  options: RunTradeWorkerOptions = {},
): Promise<TradeWorkerReport> {
  const dcaSubmitted = new Set<string>();
  if (options.dryRun !== true) {
    await deps.reconcile?.();
    // Projection is custody convergence, not a trading decision. It must run
    // for paused/revoked agents and while the data plane is unavailable, or a
    // later-confirmed submission could remain invisible indefinitely.
    let projectionCursor: string | null = null;
    for (;;) {
      const page = await deps.settingsStore.listTradeAgentsForProjection({ limit: 32, cursor: projectionCursor });
      for (const row of page.rows) {
        const agent = await deps.agentStore.getAgentById(row.agentId);
        if (agent === null) continue;
        try { await reconcileTradeIntents(deps, agent, options.signal); }
        catch (error) { deps.log?.(`[trade-worker] intent projection failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`); }
        // AUTO-DCA R2.8: convergence, observation and the protective steps, for
        // armed, paused and revoked agents alike, before the readiness gate.
        try { if (await runDcaProjection(deps, agent, row)) dcaSubmitted.add(agent.id); }
        catch (error) { deps.log?.(`[trade-worker] dca projection failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`); }
        if (agent.status === "revoked") {
          // TRADFI-EXPIRY-KEEP-REMOVE §2.2 (TradFi AI only): a position whose sell
          // is still unsettled is not orphaned, so a sell that lands later is
          // projected normally instead of hitting an already-orphaned row.
          const parsedRow = parseTradeSettings(row.params);
          const unsettledSells = parsedRow.ok && isTradfiAiSettings(parsedRow.value.effective)
            ? new Set((await deps.intents.listUnsettled(agent.ownerAddress, agent.id)).filter((intent) => intent.side === "sell").map((intent) => intent.positionId))
            : new Set<string>();
          for (const position of await deps.positions.listOpen(agent.ownerAddress, agent.id)) {
            if (unsettledSells.has(position.positionId)) continue;
            await deps.positions.markOrphaned(agent.ownerAddress, agent.id, position.positionId);
          }
        }
      }
      if (!page.hasMore || page.cursor === null) break;
      projectionCursor = page.cursor;
    }
  }
  const outcomes: TradeWorkerAgentOutcome[] = [];
  const workerRows: TradeSettingsRecord[] = [];
  let workerCursor: string | null = null;
  for (;;) {
    const page = await deps.settingsStore.listTradeAgentsForWorker({ limit: 32, cursor: workerCursor });
    workerRows.push(...page.rows);
    if (!page.hasMore || page.cursor === null) break;
    workerCursor = page.cursor;
  }
  const expiredAgentIds = new Set<string>();
  if (options.dryRun !== true) {
    const atMs = deps.now?.() ?? Date.now();
    for (const row of workerRows) {
      const agent = await deps.agentStore.getAgentById(row.agentId);
      if (agent?.status !== "armed" || agent.sessionFacts === null) continue;
      const expiryMs = agent.sessionFacts.expiry * 1_000;
      if (atMs < expiryMs) continue;
      expiredAgentIds.add(agent.id);
      const counts: MutableCounts = { events: [], startedAt: atMs, candidates: 0, refusals: 0, entries: 0, exits: 0, heldNoPrice: 0 };
      observe(counts, { stage: "cycle", code: "session-expired", reason: new Date(expiryMs).toISOString() });
      await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress, dryRun: false,
        reason: "session-expired", events: counts.events ?? [] });
      outcomes.push({ agentId: agent.id, dryRun: false, reason: "session-expired", ...counts });
    }
  }
  if (!deps.readiness.ready) {
    deps.log?.("[trade-worker] data plane is not ready; skipping cycle");
    return { skippedNotReady: true, outcomes };
  }
  // AGENT-GAS-ATTENTION §2.2 — one `eth_getBalance` per WALLET per cycle.
  // Rebuilt per cycle: a balance from a previous cycle is not a reading.
  const gasCache = new Map<string, bigint | undefined>();
  for (const row of workerRows) {
      const agent = await deps.agentStore.getAgentById(row.agentId);
      if (agent === null) continue;
      // AUDIT L9 / TRADING-AGENT R5/R9: pause deliberately stops entries AND exits, matching Venus D4.
      if (agent.status !== "armed") continue;
      if (expiredAgentIds.has(agent.id)) continue;
      // A failed read falls through to the normal cycle, which records its own error.
      const finished = await scheduleFinishedSkip(deps, agent, row, options.dryRun === true).catch(() => null);
      if (finished !== null) { outcomes.push(finished); continue; }
      // AGENT-GAS-ATTENTION §2.2 — the gas gate, before `processAgent` reaches
      // the data plane, the LLM or the router. It sits BELOW the projection
      // sweep above on purpose: custody convergence must run for a broke agent
      // exactly as it runs for a paused one, or a later-confirmed submission
      // stays invisible. What it stops is the DISCRETIONARY work.
      const gasSkip = await tradeAgentGasGate(deps, agent, gasCache);
      if (gasSkip !== null) {
        // No `insertRun`: a durable row per cycle for an agent that did
        // nothing IS the churn this change exists to remove.
        outcomes.push({ agentId: agent.id, dryRun: options.dryRun === true, reason: gasSkip,
          candidates: 0, refusals: 0, entries: 0, exits: 0, heldNoPrice: 0 });
        continue;
      }
      try {
        // REVIEW 3, MEDIUM — the wallet's cached reading is SPENT by this
        // agent's cycle. Reproduced: two legacy self-EOA agents on one wallet,
        // A spends its budget plus the relay fee, and B reaches the executor on
        // A's pre-spend figure with the wallet at zero. Browser-hired wallets
        // are exclusive, which narrows this — it does not remove legacy
        // sharing. Dropped BEFORE, and again in `finally` so a throw (which may
        // still have submitted) cannot leave a spent figure behind.
        gasCache.delete(agent.walletAddress.toLowerCase());
        outcomes.push(await processAgent(deps, agent, row, options, dcaSubmitted.has(agent.id)));
      } catch (error) {
        const counts: MutableCounts = { events: [], startedAt: Date.now(), candidates: 0, refusals: 0, entries: 0, exits: 0, heldNoPrice: 0 };
        const reason = `agent-error:${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`;
        try {
          await deps.positions.insertRun({ agentId: agent.id, ownerAddress: agent.ownerAddress,
            dryRun: options.dryRun === true, reason: runReason(reason, counts),
            candidates: counts.candidates, refusals: counts.refusals,
            entries: counts.entries, exits: counts.exits });
        } catch {
          // A broken run store for one tenant must not stop the remaining sweep.
        }
        outcomes.push({ agentId: agent.id, dryRun: options.dryRun === true, reason, ...counts });
      } finally {
        gasCache.delete(agent.walletAddress.toLowerCase());
      }
  }
  return { skippedNotReady: false, outcomes };
}

/**
 * AGENT-GAS-ATTENTION §2.2 — the trade agent's gas gate.
 *
 * Returns `null` to proceed, or the owner-facing reason to stand down. The
 * shape mirrors `lpAgentGasGate` deliberately: same floor module, same
 * fail-closed treatment of an unread balance, same backoff ladder, and the
 * same rule that an ABSENT reader disables the gate rather than blocking with
 * it. Two workers, one policy.
 *
 * A trade agent's next motion is one exit's relay reimbursement
 * ({@link RELAY_FEE_PER_EXIT_WEI}). `nativeReserveFloor` already guards the
 * SUBMIT seam against the day meter; this guards the CYCLE against a wallet
 * that cannot pay for any submission at all.
 */
async function tradeAgentGasGate(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  gasCache: Map<string, bigint | undefined>,
): Promise<string | null> {
  const readNative = deps.walletNativeBalance;
  if (readNative === undefined) return null;
  const floor = agentGasFloor({ profile: "trade-v1" });
  if (floor === null) return null;

  const nowMs = deps.now?.() ?? Date.now();
  const intervalMs = deps.intervalMs ?? 60_000;
  const backoff = deps.gasBackoff;

  // Serve the ladder BEFORE any read: this is the branch that saves the cycle.
  const standing = backoff?.get(agent.id);
  if (standing !== undefined && nowMs < standing.nextProbeAtMs) return standing.reason;

  const walletKey = agent.walletAddress.toLowerCase();
  let nativeWei: bigint | undefined;
  if (gasCache.has(walletKey)) {
    nativeWei = gasCache.get(walletKey);
  } else {
    try {
      nativeWei = await readNative(agent.walletAddress as Address);
    } catch {
      nativeWei = undefined;
    }
    gasCache.set(walletKey, nativeWei);
  }

  const state = classifyAgentGas({ nativeWei, floor });
  if (state === "ok" || state === "low") {
    backoff?.delete(agent.id);
    return null;
  }
  const reason = sanitizeMessage(
    agentGasReason({ state, floor, nativeWei, walletAddress: agent.walletAddress }),
  );
  const consecutiveBlockedProbes = (standing?.consecutiveBlockedProbes ?? 0) + 1;
  backoff?.set(agent.id, {
    consecutiveBlockedProbes,
    // REVIEW FINDING 6 — CLAMPED IN WALL-CLOCK MS, not left as a count of
    // intervals. This daemon's default interval is 60 s against the LP
    // worker's 30 s, so the raw 60-interval rung would have made its deepest
    // wait SIXTY minutes against a plan that promised thirty.
    nextProbeAtMs:
      nowMs + tradeGasBackoffDelayMs(consecutiveBlockedProbes, intervalMs),
    reason,
  });
  return reason;
}

/** The ladder, clamped to {@link AGENT_GAS_MAX_BACKOFF_MS}. */
export function tradeGasBackoffDelayMs(
  consecutiveBlockedProbes: number,
  intervalMs: number,
): number {
  const ladder = tradeGasBackoffIntervals(consecutiveBlockedProbes) * intervalMs;
  return ladder > AGENT_GAS_MAX_BACKOFF_MS ? AGENT_GAS_MAX_BACKOFF_MS : ladder;
}

/**
 * The same 1 / 10 / 60 ladder the LP worker uses (`lpGasBackoffIntervals`).
 *
 * Duplicated rather than imported across the two workers ON PURPOSE: importing
 * `src/lp/worker.ts` into the trade worker would pull the entire LP saga graph
 * into the trade daemon's module closure, and `test/demo.plane.test.ts` pins
 * import closures precisely because that kind of coupling is how a plane grows
 * reachability it did not intend. Six lines is the cheaper price, and
 * `test/trade.gasGate.test.ts` pins the two ladders equal.
 */
export function tradeGasBackoffIntervals(consecutiveBlockedProbes: number): number {
  if (consecutiveBlockedProbes <= 2) return 1;
  if (consecutiveBlockedProbes <= 5) return 10;
  return 60;
}

export function createWorkerVerdictCache(): TradeVerdictCache {
  return createTradeVerdictCache();
}
