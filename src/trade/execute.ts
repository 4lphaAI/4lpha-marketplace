/** Shared route/worker trade execution core (TRADING-AGENT R6 / R3.6 / C27). */
import { keccak256, stringToBytes, zeroAddress, type Address, type Hex } from "viem";
import type {
  ExecutionErrorCode,
  ExecutionReceipt,
  FlapTokenState,
  FourMemeQuote,
  NativeDayMeterReading,
  ProviderRegistry,
  SessionRef,
  WalletCall,
  WalletProvider,
} from "../core/types.js";
import { ExecutionPlaneError, ProviderError } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import { preflightSimulate, type TradfiPreflightDeps } from "./simulate.js";
import { canonicalEncode } from "../auth/canonical.js";
import { authorizeExecute } from "../auth/executeDecision.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import { hashCalls, tradeParamsHash, type TradeRequest } from "../http/wire.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import { isTradePortfolioSettings, isTradeScheduleSettings, isTradfiV2Settings, parseTradeSettings } from "./settings.js";
import { PORTFOLIO_PLATFORM_FEE_BPS } from "./portfolio.js";
import type { ExecutionJournal, JournalEntry } from "../store/journal.js";
import type { ScanGate, ScanReason } from "../rules/scanGate.js";
import { evaluateTradeRules, exceedsDailyCap } from "../rules/engine.js";
import type { TradeRuntimeConfig } from "../ops/config.js";
import type { PancakeVenue } from "../ops/venues.js";
import { buildPancakeBuy, buildPancakeSell } from "../ops/pancake.js";
import { buildPancakeV3Buy, buildPancakeV3Sell, isEncodableV3Route } from "../ops/pancakeV3.js";
import { buildUniswapV3Buy, buildUniswapV3Sell, isEncodableUniswapV3Route } from "../ops/uniswapV3.js";
import { buildFourMemeBuy, buildFourMemeSell } from "../ops/fourmeme.js";
import { buildFlapBuy, buildFlapSell } from "../ops/flap.js";
import { buildTradfiPancakeV2Swap, buildTradfiPancakeV3Swap, buildTradfiUniswapV3Swap, buildTradfiPlatformFee } from "../ops/tradfi.js";
import { buildTradfiGuardSwapCall, TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC, TRADFI_GUARD_MIN_REMAINING_MS } from "./guard.js";
import { buildTradfiApprove } from "../ops/tradfi.js";
import type { TradfiV2ReceiptReader } from "./receipt.js";
import { feeValueOf } from "../ops/fees.js";
import { MAX_ROUTE_HOPS, type TradeRoute } from "../ops/route.js";
import { NATIVE_RESERVE_REMEDY, nativeReserveFloor } from "../ops/policy.js";
import { agentAuthorityFromPrivateKey } from "../wallet/altana.js";
import { fingerprintLpFinalCallsV1, isProvenPreBindStagedLpError } from "../lp/preparedIntent.js";
import { RECONCILE_ASSUMED_SUBMIT_TIMEOUT_MS } from "../store/journal.js";
import type { TradeReceiptLog, TradeReceiptReader } from "./route.js";

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const BPS_DENOMINATOR = 10_000n;

export type TradeDenyBy = "scan" | "rules" | "venue" | "session" | "transport";

export type TradeExecutionMeta = Readonly<Record<string, unknown>> & {
  readonly idempotencyKey: Hex;
};

export type ExecuteTradeResult =
  | { readonly kind: "denied"; readonly status: 409 | 429; readonly code: string; readonly message?: string; readonly meta?: TradeExecutionMeta }
  | { readonly kind: "rolled-back"; readonly code: string; readonly failureCode: ExecutionErrorCode; readonly receipt?: ExecutionReceipt; readonly meta: TradeExecutionMeta }
  | { readonly kind: "committed"; readonly receipt: ExecutionReceipt; readonly fill: TradeReceiptFill | null; readonly meta: TradeExecutionMeta }
  | { readonly kind: "unknown"; readonly callsId?: Hex; readonly meta: TradeExecutionMeta };

export type ExecuteTradeDeps = {
  readonly preflight?: TradfiPreflightDeps;
  readonly chainId: number;
  readonly keyStore: Address;
  readonly agentStore: AgentStore;
  readonly settingsStore?: Pick<TradeSettingsStore, "get">;
  readonly journal: ExecutionJournal;
  readonly killswitch: KillSwitch;
  readonly providerRegistry: ProviderRegistry;
  readonly trade: TradeRuntimeConfig;
  readonly pancake: PancakeVenue | null;
  readonly pancakeV3: PancakeVenue | null;
  readonly uniswapV3: PancakeVenue | null;
  readonly flapPortal: Address | null;
  readonly receiptReader?: TradeReceiptReader;
  /** C27: supplied only by HTTP; the in-process worker has its interval bound. */
  readonly routeThrottle?: () => { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSec: number };
  readonly nowMs?: () => number;
  /** Optional chain/orchestrator proof reader; absent keeps v2 basis unverified. */
  readonly v2EvidenceForReceipt?: (input: {
    readonly receipt: ExecutionReceipt;
    readonly idempotencyKey: Hex;
    readonly request: TradeRequest;
    readonly walletAddress: Address;
    readonly sessionPublicKey: Hex;
    readonly sessionGeneration: number;
    readonly intentId: Hex;
    readonly callsHash: Hex;
    readonly calls: readonly WalletCall[];
  }) => Promise<{ readonly evidence: TradfiV2ReceiptEvidence; readonly expected: TradfiV2ExpectedIdentity } | null>;
  readonly v2ReceiptReader?: TradfiV2ReceiptReader;
};

export type TradeReceiptFill =
  | { readonly side: "buy"; readonly entryWei: bigint; readonly tokenAmount: bigint | null; readonly fillStatus: "verified" | "unverified"; readonly receiptAttributable?: boolean; readonly verifiedEntryAtomic?: bigint; readonly receiptOwnershipKey?: string }
  | { readonly side: "sell"; readonly exitWei: bigint | null; readonly fillStatus: "verified" | "unverified"; readonly receiptOwnershipKey?: string };

/** Receipt ownership facts required before a v2 basis/proceeds claim is valid. */
export type TradfiV2ReceiptEvidence = {
  readonly chainId: 56;
  readonly receiptStatus: "success";
  readonly blockHash: Hex;
  readonly blockNumber: bigint;
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  readonly sessionGeneration: number;
  readonly intentId: Hex;
  readonly callsHash: Hex;
  readonly chainIntentHash: Hex;
  readonly nonce: bigint;
  readonly receiptOwned: true;
  readonly singleWalletExecution: true;
  readonly unexplainedRelevantTransfers: false;
  readonly matchingIntent: true;
  readonly matchingCalls: true;
  readonly guardEventMatches?: boolean;
  readonly treasuryFeeMatches?: boolean;
  readonly ownership: { readonly transactionHash: Hex; readonly swapLogIndex: bigint };
  readonly actualInputAtomic?: bigint;
  readonly actualOutputAtomic?: bigint;
  readonly verifiedEntryAtomic?: bigint | null;
  readonly verifiedProceedsAtomic?: bigint | null;
};

export type TradfiV2ExpectedIdentity = {
  readonly sessionPublicKey: Hex;
  readonly sessionGeneration: number;
  readonly intentId: Hex;
  readonly callsHash: Hex;
};

export function verifyTradfiV2ReceiptEvidence(input: {
  readonly evidence: TradfiV2ReceiptEvidence | undefined;
  readonly walletAddress: Address;
  readonly expected: TradfiV2ExpectedIdentity | undefined;
}): boolean {
  const evidence = input.evidence;
  const expected = input.expected;
  return evidence !== undefined
    && expected !== undefined
    && evidence.chainId === 56
    && evidence.receiptStatus === "success"
    && evidence.receiptOwned === true
    && evidence.singleWalletExecution === true
    && evidence.unexplainedRelevantTransfers === false
    && evidence.matchingIntent === true
    && evidence.matchingCalls === true
    && evidence.wallet.toLowerCase() === input.walletAddress.toLowerCase()
    && evidence.sessionPublicKey.toLowerCase() === expected.sessionPublicKey.toLowerCase()
    && evidence.sessionGeneration === expected.sessionGeneration
    && evidence.intentId.toLowerCase() === expected.intentId.toLowerCase()
    && evidence.callsHash.toLowerCase() === expected.callsHash.toLowerCase()
    && evidence.chainIntentHash.toLowerCase() === evidence.intentId.toLowerCase()
    && /^0x[0-9a-fA-F]{64}$/u.test(evidence.ownership.transactionHash)
    && evidence.nonce >= 0n
    && evidence.ownership.swapLogIndex >= 0n
    && evidence.actualInputAtomic !== undefined
    && evidence.actualOutputAtomic !== undefined
    && (evidence.guardEventMatches !== false)
    && (evidence.treasuryFeeMatches !== false);
}

function receiptOwnershipKey(evidence: TradfiV2ReceiptEvidence): string {
  return [evidence.chainId, evidence.ownership.transactionHash.toLowerCase(), evidence.wallet.toLowerCase(),
    evidence.ownership.swapLogIndex.toString(10), evidence.chainIntentHash.toLowerCase()].join("|");
}

const TRANSFER_TOPIC = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const WITHDRAWAL_TOPIC = keccak256(stringToBytes("Withdrawal(address,uint256)"));

function topicAddress(topic: Hex | undefined): string | null {
  return topic === undefined || topic.length !== 66 ? null : `0x${topic.slice(-40)}`.toLowerCase();
}

function uintData(data: Hex): bigint | null {
  try { return BigInt(data); } catch { return null; }
}

function tokenDelta(logs: readonly TradeReceiptLog[], token: Address, wallet: Address): bigint {
  let delta = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase() || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const amount = uintData(log.data);
    if (amount === null) continue;
    if (topicAddress(log.topics[2]) === wallet.toLowerCase()) delta += amount;
    if (topicAddress(log.topics[1]) === wallet.toLowerCase()) delta -= amount;
  }
  return delta;
}

function nativeWithdrawal(logs: readonly TradeReceiptLog[], wbnb: Address | undefined): bigint {
  if (wbnb === undefined) return 0n;
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== wbnb.toLowerCase() || log.topics[0]?.toLowerCase() !== WITHDRAWAL_TOPIC) continue;
    const amount = uintData(log.data);
    if (amount !== null) total += amount;
  }
  return total;
}

export async function tradeReceiptFill(input: {
  readonly request: TradeRequest;
  readonly walletAddress: Address;
  readonly nativeInWei: bigint;
  readonly receipt: ExecutionReceipt;
  readonly reader?: TradeReceiptReader;
  readonly wbnb?: Address;
  readonly v2Evidence?: TradfiV2ReceiptEvidence;
  readonly v2ExpectedIdentity?: TradfiV2ExpectedIdentity;
}): Promise<TradeReceiptFill> {
  let logs: readonly TradeReceiptLog[] = [];
  if (input.receipt.transactionHash !== undefined && input.reader !== undefined) {
    try { logs = (await input.reader.getReceipt(input.receipt.transactionHash)).logs; } catch { /* H2: persist uncertainty after commit. */ }
  }
  if (input.request.side === "buy") {
    if (input.request.settlementAsset === "USDT") {
      const attributable = verifyTradfiV2ReceiptEvidence({ evidence: input.v2Evidence, walletAddress: input.walletAddress, expected: input.v2ExpectedIdentity });
      if (!attributable) return { side: "buy", entryWei: input.request.amountWei, tokenAmount: null, fillStatus: "unverified", receiptAttributable: false };
      const actualEntry = input.v2Evidence?.verifiedEntryAtomic ?? (input.v2Evidence?.actualInputAtomic === undefined ? null : input.v2Evidence.actualInputAtomic);
      const actualOutput = input.v2Evidence?.actualOutputAtomic ?? 0n;
      if (actualEntry === null || actualEntry <= 0n || actualOutput <= 0n) return { side: "buy", entryWei: input.request.amountWei, tokenAmount: null, fillStatus: "unverified", receiptAttributable: false };
      return { side: "buy", entryWei: actualEntry, tokenAmount: actualOutput, fillStatus: "verified",
        receiptAttributable: true, verifiedEntryAtomic: actualEntry, receiptOwnershipKey: receiptOwnershipKey(input.v2Evidence!) };
    }
    const delta = tokenDelta(logs, input.request.token, input.walletAddress);
    return { side: "buy", entryWei: input.nativeInWei, tokenAmount: delta > 0n ? delta : null,
      fillStatus: delta > 0n ? "verified" : "unverified", receiptAttributable: delta > 0n };
  }
  if (input.request.settlementAsset === "USDT") {
    if (!verifyTradfiV2ReceiptEvidence({ evidence: input.v2Evidence, walletAddress: input.walletAddress, expected: input.v2ExpectedIdentity })) {
      return { side: "sell", exitWei: null, fillStatus: "unverified" };
    }
    const actualProceeds = input.v2Evidence?.verifiedProceedsAtomic ?? input.v2Evidence?.actualOutputAtomic ?? null;
    if (actualProceeds === null || actualProceeds <= 0n) return { side: "sell", exitWei: null, fillStatus: "unverified" };
    return { side: "sell", exitWei: actualProceeds, fillStatus: "verified", receiptOwnershipKey: receiptOwnershipKey(input.v2Evidence!) };
  }
  const exitWei = nativeWithdrawal(logs, input.wbnb);
  return { side: "sell", exitWei: exitWei > 0n ? exitWei : null,
    fillStatus: exitWei > 0n ? "verified" : "unverified" };
}

function getUsdtAddress(): Address {
  return "0x55d398326f99059fF775485246999027B3197955" as Address;
}

export type ExecuteTradeInput = {
  readonly agent: AgentRecord;
  readonly request: TradeRequest;
  readonly scanGate: ScanGate;
  readonly idempotencyKey: Hex;
  readonly paramsHash: Hex;
  readonly signal?: AbortSignal;
  readonly deps: ExecuteTradeDeps;
};

/** C27 binds the entire request plus the fee policy used by both callers. */
export function tradeIdempotencyKey(
  agentId: string,
  request: TradeRequest,
  feeBps: number | undefined,
  feeTreasury: Address | undefined,
): Hex {
  return keccak256(stringToBytes(canonicalEncode({
    agentId,
    request,
    feeBps: feeBps ?? 0,
    feeTreasury: feeTreasury ?? null,
  })));
}

/** AUDIT L8: route and worker bind one identical venue/config tuple. */
export function tradeExecutionIdentity(input: {
  readonly agentId: string;
  readonly chainId: number;
  readonly request: TradeRequest;
  readonly trade: TradeRuntimeConfig;
  readonly pancake: PancakeVenue | null;
  readonly pancakeV3: PancakeVenue | null;
  readonly uniswapV3: PancakeVenue | null;
  readonly flapPortal: Address | null;
}): { readonly paramsHash: Hex; readonly idempotencyKey: Hex } {
  const uniswapRouter = input.uniswapV3?.router ?? input.trade.venues.uniswapRouterV3;
  const paramsHash = tradeParamsHash({
    chainId: input.chainId,
    venue: input.request.venue,
    side: input.request.side,
    token: input.request.token,
    amountWei: input.request.amountWei,
    minOutWei: input.request.minOutWei,
    quotedOutWei: input.request.quotedOutWei,
    ...(input.pancake === null ? {} : { router: input.pancake.router }),
    ...(input.trade.venues.wbnb === undefined ? {} : { wbnb: input.trade.venues.wbnb }),
    ...(input.pancakeV3 === null ? {} : { routerV3: input.pancakeV3.router }),
    ...(uniswapRouter === undefined ? {} : { routerUniV3: uniswapRouter }),
    ...(input.flapPortal === null ? {} : { flapPortal: input.flapPortal }),
    ...(input.trade.feeTreasury === undefined ? {} : { treasury: input.trade.feeTreasury }),
    ...(input.trade.feeBps === undefined ? {} : { feeBps: input.trade.feeBps }),
    ...(input.request.route === undefined ? {} : { route: input.request.route }),
    ...(input.request.settlementAsset === undefined ? {} : { settlementAsset: input.request.settlementAsset }),
    ...(input.request.platformFeeAtomic === undefined ? {} : { platformFeeAtomic: input.request.platformFeeAtomic }),
    ...(input.request.guardQuote === undefined ? {} : { guardQuote: input.request.guardQuote }),
  });
  return { paramsHash, idempotencyKey: tradeIdempotencyKey(
    input.agentId, input.request, input.trade.feeBps, input.trade.feeTreasury,
  ) };
}

function receiptFrom(entry: JournalEntry): ExecutionReceipt {
  return {
    status: entry.state === "COMMITTED" ? "CONFIRMED" : entry.state === "ROLLED_BACK" ? "FAILED" : "PENDING",
    ...(entry.externalRef.txHash === undefined ? {} : { transactionHash: entry.externalRef.txHash }),
    ...(entry.externalRef.callsId === undefined ? {} : { callsId: entry.externalRef.callsId }),
  };
}

function replayResult(entry: JournalEntry): ExecuteTradeResult {
  const meta = {
    idempotencyKey: entry.idempotencyKey as Hex,
    journalState: entry.state,
    replayed: true,
    ...(entry.decisionId === null ? {} : { decisionId: entry.decisionId }),
  };
  if (entry.state === "ROLLED_BACK") return { kind: "rolled-back", code: "NOT_ALLOWED", failureCode: "NOT_ALLOWED", receipt: receiptFrom(entry), meta };
  if (entry.state === "COMMITTED") return { kind: "committed", receipt: receiptFrom(entry), fill: null, meta };
  return { kind: "unknown", ...(entry.externalRef.callsId === undefined ? {} : { callsId: entry.externalRef.callsId }), meta };
}

function asPlaneError(error: unknown, fallback: string): ExecutionPlaneError {
  if (error instanceof ExecutionPlaneError) return error;
  return new ProviderError(sanitizeMessage(error instanceof Error ? error.message : fallback));
}

function forbiddenSpenders(input: ExecuteTradeInput): ReadonlySet<string> {
  const values = new Set<string>([
    input.agent.walletAddress.toLowerCase(),
    input.deps.keyStore.toLowerCase(),
    zeroAddress.toLowerCase(),
  ]);
  if (input.deps.trade.venues.wbnb !== undefined) values.add(input.deps.trade.venues.wbnb.toLowerCase());
  if (input.deps.trade.feeTreasury !== undefined) values.add(input.deps.trade.feeTreasury.toLowerCase());
  return values;
}

type FourMemeBuyBound =
  | { readonly ok: true; readonly fundsWei: bigint; readonly msgValueWei: bigint }
  | { readonly ok: false; readonly code: string };

function boundFourMemeBuy(input: {
  readonly amountWei: bigint;
  readonly maxVenueFeeBps: number;
  readonly fundsWei?: bigint;
  readonly msgValueWei?: bigint;
  readonly estimatedOutWei?: bigint;
}): FourMemeBuyBound {
  const { fundsWei, msgValueWei, estimatedOutWei } = input;
  if (fundsWei === undefined || msgValueWei === undefined || estimatedOutWei === undefined
    || fundsWei === 0n || msgValueWei === 0n || estimatedOutWei === 0n) {
    return { ok: false, code: "VENUE_UNSUPPORTED" };
  }
  const ceiling = (input.amountWei * (BPS_DENOMINATOR + BigInt(input.maxVenueFeeBps))) / BPS_DENOMINATOR;
  if (fundsWei > input.amountWei || msgValueWei < fundsWei || msgValueWei > ceiling) {
    return { ok: false, code: "VENUE_MSGVALUE_UNSAFE" };
  }
  return { ok: true, fundsWei, msgValueWei };
}

function buildVenueCalls(input: {
  readonly request: TradeRequest;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly pancake: PancakeVenue | null;
  readonly pancakeV3: PancakeVenue | null;
  readonly uniswapV3: PancakeVenue | null;
  readonly flapPortal: Address | null;
  readonly fourMemeManager: Address | null;
  readonly fourMemeFundsWei: bigint;
  readonly fourMemeMsgValueWei: bigint;
}): readonly WalletCall[] | null {
  const { request, recipient, deadline } = input;
  const hops = request.route?.hops ?? [];
  if (hops.length > MAX_ROUTE_HOPS) return null;
  if (request.settlementAsset === "USDT") {
    const route = request.route ?? { hops: [], fees: [] };
    const common = { tokenIn: request.side === "buy" ? getUsdtAddress() : request.token,
      tokenOut: request.side === "buy" ? request.token : getUsdtAddress(), amountInWei: request.amountWei,
      minOutWei: request.minOutWei, recipient, deadline, route };
    if (request.guardQuote !== undefined) {
      const approvals = buildTradfiApprove(common.tokenIn, request.guardQuote.guard, common.amountInWei);
      return [...approvals, buildTradfiGuardSwapCall({ guard: request.guardQuote.guard, router: request.guardQuote.router, spender: request.guardQuote.spender,
        canonicalUSDT: getUsdtAddress(), tokenIn: common.tokenIn, tokenOut: common.tokenOut, amountInWei: common.amountInWei,
        minOutWei: common.minOutWei, deadline: request.guardQuote.deadline, calldata: request.guardQuote.calldata })];
    }
    if (request.venue === "pancake") return input.pancake === null ? null : buildTradfiPancakeV2Swap({ router: input.pancake.router, ...common });
    if (request.venue === "pancake_v3") return input.pancakeV3 === null ? null : buildTradfiPancakeV3Swap({ router: input.pancakeV3.router, ...common });
    if (request.venue === "uniswap_v3") return input.uniswapV3 === null ? null : buildTradfiUniswapV3Swap({ router: input.uniswapV3.router, ...common });
    return null;
  }
  if (request.venue === "pancake") {
    if (input.pancake === null) return null;
    return request.side === "buy"
      ? buildPancakeBuy({ router: input.pancake.router, wbnb: input.pancake.wbnb, token: request.token,
          amountInWei: request.amountWei, minOutWei: request.minOutWei, recipient, deadline, hops })
      : buildPancakeSell({ router: input.pancake.router, wbnb: input.pancake.wbnb, token: request.token,
          amountInWei: request.amountWei, minOutWei: request.minOutWei, recipient, deadline, hops });
  }
  if (request.venue === "pancake_v3") {
    if (input.pancakeV3 === null) return null;
    const route: TradeRoute = request.route ?? { hops: [], fees: [] };
    if (!isEncodableV3Route(route)) return null;
    const common = { router: input.pancakeV3.router, wbnb: input.pancakeV3.wbnb, token: request.token,
      amountInWei: request.amountWei, minOutWei: request.minOutWei, recipient, deadline, route };
    return request.side === "buy" ? buildPancakeV3Buy(common) : buildPancakeV3Sell(common);
  }
  if (request.venue === "uniswap_v3") {
    if (input.uniswapV3 === null) return null;
    const route: TradeRoute = request.route ?? { hops: [], fees: [] };
    if (!isEncodableUniswapV3Route(route)) return null;
    const common = { router: input.uniswapV3.router, wbnb: input.uniswapV3.wbnb, token: request.token,
      amountInWei: request.amountWei, minOutWei: request.minOutWei, recipient, deadline, route };
    return request.side === "buy" ? buildUniswapV3Buy(common) : buildUniswapV3Sell(common);
  }
  if (request.venue === "flap") {
    if (input.flapPortal === null) return null;
    return request.side === "buy"
      ? buildFlapBuy({ portal: input.flapPortal, token: request.token, amountInWei: request.amountWei, minOutWei: request.minOutWei })
      : buildFlapSell({ portal: input.flapPortal, token: request.token, amountInWei: request.amountWei, minOutWei: request.minOutWei });
  }
  if (input.fourMemeManager === null) return null;
  return request.side === "buy"
    ? buildFourMemeBuy({ manager: input.fourMemeManager, token: request.token, fundsWei: input.fourMemeFundsWei,
        minTokensOut: request.minOutWei, msgValueWei: input.fourMemeMsgValueWei })
    : buildFourMemeSell({ manager: input.fourMemeManager, token: request.token,
        amountWei: request.amountWei, minFundsOut: request.minOutWei });
}

export type TradfiV2SwapBounds =
  | { readonly ok: true; readonly scheduleAgent: boolean; readonly v2QuoteCap: bigint }
  | { readonly ok: false; readonly scope: TradeDenyBy; readonly code: string };

/**
 * The v2 swap-bound checks of {@link executeTradeForAgent}, extracted verbatim
 * (AUTO-DCA R2.3 item 3, REVIEW2 N4 / condition 4): entry bounds against the
 * current settings and the grant-time sizing, the per-trade debit, the USDT day
 * cap, the fee and the slippage floor. It also answers the two values the
 * executor reads later — whether the agent is a Schedule agent (its native
 * reserve counts ONE token) and the USDT day cap (`QUOTE_DAILY_CAP`) — so no
 * caller can lose them by extracting a narrower range. The DCA executor calls
 * it for a batch's swap leg.
 */
export async function tradfiV2SwapRefusal(
  deps: Pick<ExecuteTradeDeps, "settingsStore" | "trade">,
  agent: AgentRecord,
  facts: NonNullable<AgentRecord["sessionFacts"]>,
  request: Pick<TradeRequest, "side" | "amountWei" | "platformFeeAtomic" | "quotedOutWei" | "minOutWei">,
): Promise<TradfiV2SwapBounds> {
  let scheduleAgent = false;
  let portfolioAgent = false;
  let currentV2Slippage = deps.trade.maxSlippageBps;
  let currentV2MinEntry: bigint | null = null;
  if (deps.settingsStore !== undefined) {
    const currentSettings = await deps.settingsStore.get(agent.ownerAddress, agent.id);
    if (currentSettings === null) return { ok: false, scope: "session", code: "USDT_SETTINGS_UNAVAILABLE" };
    const parsedCurrent = parseTradeSettings(currentSettings.params);
    if (!parsedCurrent.ok || !isTradfiV2Settings(parsedCurrent.value.effective)) return { ok: false, scope: "session", code: "USDT_SETTINGS_UNAVAILABLE" };
    scheduleAgent = isTradeScheduleSettings(parsedCurrent.value.effective);
    portfolioAgent = isTradePortfolioSettings(parsedCurrent.value.effective);
    currentV2MinEntry = BigInt(parsedCurrent.value.effective.minEntryWei!);
    if (request.side === "buy" && request.amountWei > BigInt(parsedCurrent.value.effective.entryWei)) return { ok: false, scope: "rules", code: "USDT_ENTRY_BOUNDS" };
    currentV2Slippage = Math.min(currentV2Slippage, parsedCurrent.value.effective.slippageBps);
  }
  if (facts.hireSizing?.settlementAsset !== "USDT") return { ok: false, scope: "session", code: "USDT_SETTINGS_UNAVAILABLE" };
  if (request.side === "buy") {
    if (facts.hireSizing.minEntryWei === undefined || facts.hireSizing.entryWei === undefined) return { ok: false, scope: "session", code: "USDT_SETTINGS_UNAVAILABLE" };
    let minEntry: bigint;
    let maxEntry: bigint;
    try { minEntry = BigInt(facts.hireSizing.minEntryWei); maxEntry = BigInt(facts.hireSizing.entryWei); }
    catch { return { ok: false, scope: "session", code: "USDT_SETTINGS_UNAVAILABLE" }; }
    const effectiveMinEntry = currentV2MinEntry ?? minEntry;
    if (maxEntry <= 0n || request.amountWei < effectiveMinEntry || request.amountWei > maxEntry) return { ok: false, scope: "rules", code: "USDT_ENTRY_BOUNDS" };
    if (facts.hireSizing.quotePerTradeWei === undefined) return { ok: false, scope: "session", code: "USDT_SETTINGS_UNAVAILABLE" };
    const persistedPerTradeDebit = BigInt(facts.hireSizing.quotePerTradeWei);
    if (request.amountWei + (request.platformFeeAtomic ?? 0n) > persistedPerTradeDebit) return { ok: false, scope: "rules", code: "USDT_ENTRY_CAP" };
  }
  const cap = facts.spec.spendCaps.find((row) => row.token?.toLowerCase() === getUsdtAddress().toLowerCase() && row.period === "day");
  const v2QuoteCap = cap?.limit ?? null;
  if (v2QuoteCap === null) return { ok: false, scope: "session", code: "USDT_CAP_UNAVAILABLE" };
  const configuredFee = request.side === "buy" ? request.amountWei * BigInt(portfolioAgent ? PORTFOLIO_PLATFORM_FEE_BPS : deps.trade.feeBps ?? 0) / 10_000n : 0n;
  if ((request.platformFeeAtomic ?? 0n) !== configuredFee) return { ok: false, scope: "rules", code: "FEE_MISMATCH" };
  const floor = request.quotedOutWei * BigInt(10_000 - currentV2Slippage) / 10_000n;
  if (request.minOutWei < floor || request.minOutWei > request.quotedOutWei) return { ok: false, scope: "rules", code: "MIN_OUT_TOO_LOW" };
  return { ok: true, scheduleAgent, v2QuoteCap };
}

/** No Hono context and no local-policy bypass input: both are deliberate boundaries. */
export async function executeTradeForAgent(input: ExecuteTradeInput): Promise<ExecuteTradeResult> {
  const { agent, request, deps } = input;
  const nowMs = deps.nowMs ?? Date.now;
  const nowSec = (): number => Math.floor(nowMs() / 1_000);
  const prior = await deps.journal.getByDecision(agent.id, request.decisionId);
  if (prior !== null) {
    if (prior.kind !== "trade" || prior.externalRef.paramsHash !== input.paramsHash) {
      return { kind: "denied", status: 409, code: "conflict",
        message: "This decisionId is already bound to different trade parameters." };
    }
    return replayResult(prior);
  }
  if (agent.status === "revoked" || agent.status === "retired") {
    return { kind: "denied", status: 409, code: "revoked" };
  }
  const throttle = deps.routeThrottle?.();
  if (throttle !== undefined && !throttle.allowed) {
    return { kind: "denied", status: 429, code: "throttled",
      meta: { idempotencyKey: input.idempotencyKey, retryAfterSec: throttle.retryAfterSec } };
  }

  const reducesExposure = request.side === "sell";
  const preDecision = await authorizeExecute({ agent, killswitch: deps.killswitch, now: nowSec(), reducesExposure });
  if (!preDecision.allowed) {
    return { kind: "denied", status: 409,
      code: preDecision.code === "GLOBAL_HALT" ? "halted"
        : preDecision.code === "AGENT_PAUSED" ? "paused" : "not_executable" };
  }
  const facts = agent.sessionFacts;
  if (facts === null) return { kind: "denied", status: 409, code: "not_executable" };
  const persistedV2 = facts.hireSizing?.settlementAsset === "USDT";
  if (persistedV2 !== (request.settlementAsset === "USDT")) {
    return { kind: "denied", status: 409, code: "settlement_mismatch" };
  }

  const baseMeta = { idempotencyKey: input.idempotencyKey, decisionId: request.decisionId };
  const rollBack = async (
    deniedBy: TradeDenyBy,
    code: string,
    reasons?: readonly ScanReason[],
    note?: string,
    receiptFailureCode?: ExecutionErrorCode,
  ): Promise<ExecuteTradeResult> => {
    await deps.journal.markRolledBack(input.idempotencyKey, sanitizeMessage(`Trade refused before submit: ${code}.`));
    return { kind: "rolled-back", code, failureCode: receiptFailureCode ?? "NOT_ALLOWED",
      meta: { ...baseMeta, journalState: "ROLLED_BACK", deniedBy, code,
      ...(reasons === undefined ? {} : { reasons }), ...(note === undefined ? {} : { note }) } };
  };
  const deny = async (deniedBy: TradeDenyBy, code: string, reasons?: readonly ScanReason[]): Promise<ExecuteTradeResult> => {
    const { entry, created } = await deps.journal.beginWithSpend({
      idempotencyKey: input.idempotencyKey, agentId: agent.id, ownerAddress: agent.ownerAddress,
      kind: "trade", decisionId: request.decisionId,
      externalRef: { paramsHash: input.paramsHash, publicKey: facts.publicKey }, nativeSpendWei: 0n,
    }, nowMs());
    return created ? rollBack(deniedBy, code, reasons) : replayResult(entry);
  };

  let fourMemeManager: Address | null = null;
  let fourMemeFundsWei = 0n;
  let fourMemeMsgValueWei = 0n;
  if (request.venue === "fourmeme") {
    let quote: FourMemeQuote;
    try {
      quote = await deps.providerRegistry.get(deps.chainId).readFourMemeQuote({
        token: request.token, side: request.side, amountWei: request.amountWei,
      });
    } catch { return deny("venue", "VENUE_UNSUPPORTED"); }
    if (quote.version !== 2) return deny("venue", "VENUE_UNSUPPORTED");
    if (quote.liquidityAdded) return deny("venue", "VENUE_GRADUATED");
    if (quote.quoteToken !== null) return deny("venue", "VENUE_QUOTE_UNSUPPORTED");
    if (forbiddenSpenders(input).has(quote.tokenManager.toLowerCase())
      || quote.tokenManager.toLowerCase() === request.token.toLowerCase()) {
      return deny("venue", "VENUE_UNSUPPORTED");
    }
    if (request.side === "buy") {
      const bound = boundFourMemeBuy({ amountWei: request.amountWei, maxVenueFeeBps: deps.trade.maxVenueFeeBps,
        ...(quote.fundsWei === undefined ? {} : { fundsWei: quote.fundsWei }),
        ...(quote.msgValueWei === undefined ? {} : { msgValueWei: quote.msgValueWei }),
        ...(quote.estimatedOutWei === undefined ? {} : { estimatedOutWei: quote.estimatedOutWei }) });
      if (!bound.ok) return deny("venue", bound.code);
      fourMemeFundsWei = bound.fundsWei;
      fourMemeMsgValueWei = bound.msgValueWei;
    }
    fourMemeManager = quote.tokenManager;
  }

  let flapMeta: Record<string, string> = {};
  if (request.venue === "flap") {
    let state: FlapTokenState;
    try {
      state = await deps.providerRegistry.get(deps.chainId).readFlapTokenState({ token: request.token });
    } catch { return deny("venue", "VENUE_UNSUPPORTED"); }
    if (state.status === 4) return deny("venue", "VENUE_GRADUATED");
    if (state.status !== 1) return deny("venue", "VENUE_UNSUPPORTED");
    if (state.quoteToken !== null || state.nativeToQuoteSwapEnabled) return deny("venue", "VENUE_QUOTE_UNSUPPORTED");
    if (!/^0x0{64}$/u.test(state.extensionId)) return deny("venue", "VENUE_UNSUPPORTED");
    flapMeta = { dexSupplyThresh: state.dexSupplyThresh.toString(10), circulatingSupply: state.circulatingSupply.toString(10) };
  }

  const isV2 = request.settlementAsset === "USDT";
  let v2QuoteCap: bigint | null = null;
  // The schedule reserve counts ONE token, never the chain-granted count
  // (operator ruling, TRADFI-SCHEDULE-NATIVE-CAP-PLAN A1): a schedule agent
  // never sells through the plane (drain/exit refuse `schedule_no_sell`), so
  // every exit fee beyond the one the buy-only path could ever need protects
  // nothing. Decided ONLY from the stored, owner-signed settings row — never
  // from a request field — and `settingsStore` absent leaves it `false`,
  // which keeps the safe, higher chain-count reserve.
  let scheduleAgent = false;
  if (isV2) {
    const bounds = await tradfiV2SwapRefusal(deps, agent, facts, request);
    if (!bounds.ok) return deny(bounds.scope, bounds.code);
    scheduleAgent = bounds.scheduleAgent;
    v2QuoteCap = bounds.v2QuoteCap;
  }
  const feeCall = isV2 ? null : deps.trade.feePolicy({ agentId: agent.id, venue: request.venue, side: request.side,
    token: request.token, nativeInWei: request.side === "buy" ? request.amountWei : 0n });
  const feeWei = isV2 ? 0n : feeValueOf(feeCall);
  const swapNativeWei = isV2 ? 0n : request.side !== "buy" ? 0n : request.venue === "fourmeme" ? fourMemeMsgValueWei : request.amountWei;
  const nativeInWei = swapNativeWei + feeWei;
  const scan = await input.scanGate.evaluate({ chainId: deps.chainId, token: request.token, side: request.side,
    ...(input.signal === undefined ? {} : { signal: input.signal }) });
  if (scan.verdict === "deny") return deny("scan", "SCAN_DENIED", scan.reasons);
  const scanMeta = scan.reasons.length === 0 ? {} : { scanFlags: scan.reasons };

  const sinceMs = nowMs() - DAILY_WINDOW_MS;
  const spentTodayWei = await deps.journal.sumNativeSpendSince(agent.id, sinceMs);
  const ruled = isV2
    ? { allowed: request.amountWei > 0n && request.minOutWei > 0n && request.quotedOutWei >= request.minOutWei, code: "" as const }
    : evaluateTradeRules({ amountWei: request.amountWei, nativeInWei, minOutWei: request.minOutWei,
      quotedOutWei: request.quotedOutWei, caps: agent.caps, spentTodayWei,
      maxSlippageBps: deps.trade.maxSlippageBps });
  if (!ruled.allowed) return deny("rules", ruled.code);

  // C3/R2.5: clamp the guard deadline to the contract's own upper bound before
  // it is ever encoded into calldata. The data plane's clock can run ahead of
  // ours; the clamp only ever LOWERS the deadline (S3), so it never widens
  // what the contract would already accept.
  const guardDeadlineCap = request.guardQuote === undefined ? undefined
    : BigInt(nowSec()) + TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC - 1n;
  const guardDeadline = guardDeadlineCap === undefined ? undefined
    : (request.guardQuote!.deadline < guardDeadlineCap ? request.guardQuote!.deadline : guardDeadlineCap);
  const clampedRequest: TradeRequest = guardDeadline === undefined ? request
    : { ...request, guardQuote: { ...request.guardQuote!, deadline: guardDeadline } };
  const venueCalls = buildVenueCalls({ request: clampedRequest, recipient: agent.walletAddress,
    deadline: BigInt(nowSec() + deps.trade.deadlineSec), pancake: deps.pancake,
    pancakeV3: deps.pancakeV3, uniswapV3: deps.uniswapV3, flapPortal: deps.flapPortal, fourMemeManager,
    fourMemeFundsWei, fourMemeMsgValueWei });
  if (venueCalls === null) return deny("venue", "VENUE_UNSUPPORTED");
  const feeCalls = isV2 && request.side === "buy" && request.platformFeeAtomic !== undefined && request.platformFeeAtomic > 0n
    ? (deps.trade.feeTreasury === undefined ? [] : buildTradfiPlatformFee({ usdt: getUsdtAddress(), treasury: deps.trade.feeTreasury, amountWei: request.platformFeeAtomic }))
    : [];
  const calls = feeCall === null ? [...venueCalls, ...feeCalls] : [...venueCalls, feeCall];
  const staged = deps.trade.stagedSubmit === true && isV2;
  const finalCalls = staged ? fingerprintLpFinalCallsV1(calls) : undefined;
  const callsHash = hashCalls(calls);
  const quoteSpendWei = isV2 && request.side === "buy" ? request.amountWei + (request.platformFeeAtomic ?? 0n) : 0n;
  const submittedCalls = isV2
    ? calls.map((call) => ({ to: call.to, value: (call.value ?? 0n).toString(10), data: call.data ?? "0x" as Hex }))
    : undefined;
  const { entry: begun, otherSpendWei, otherQuoteSpendWei, created } = await deps.journal.beginWithSpend({
    idempotencyKey: input.idempotencyKey, agentId: agent.id, ownerAddress: agent.ownerAddress,
    kind: "trade", decisionId: request.decisionId,
    externalRef: { paramsHash: input.paramsHash, callsHash, publicKey: facts.publicKey,
      ...(quoteSpendWei === 0n ? {} : { quoteSpendWei: quoteSpendWei.toString(10) }),
      ...(submittedCalls === undefined ? {} : { submittedCalls }),
      ...(isV2 ? { sessionGeneration: facts.generation ?? 0 } : {}),
      ...(request.guardQuote === undefined ? {} : { guardQuote: { address: request.guardQuote.guard, calldata: request.guardQuote.calldata } }),
    }, nativeSpendWei: nativeInWei,
    ...(quoteSpendWei === 0n ? {} : { quoteSpendWei }),
    ...(finalCalls === undefined ? {} : { finalCallsFingerprint: finalCalls.canonical,
      finalCallsFingerprintHash: finalCalls.hash }),
  }, sinceMs);
  if (!created) return replayResult(begun);
  if (exceedsDailyCap(agent.caps, otherSpendWei, nativeInWei)) return rollBack("rules", "DAILY_CAP");
  if (isV2 && quoteSpendWei > 0n && (otherQuoteSpendWei ?? 0n) + quoteSpendWei > (v2QuoteCap ?? 0n)) {
    return rollBack("rules", "QUOTE_DAILY_CAP");
  }

  const lateDecision = await authorizeExecute({ agent, killswitch: deps.killswitch, now: nowSec(), reducesExposure });
  if (!lateDecision.allowed) {
    await deps.journal.markRolledBack(input.idempotencyKey, sanitizeMessage(`Refused before submit: ${lateDecision.code}.`));
    return { kind: "denied", status: 409,
      code: lateDecision.code === "GLOBAL_HALT" ? "halted"
        : lateDecision.code === "AGENT_PAUSED" ? "paused" : "not_executable" };
  }

  const provider: WalletProvider = deps.providerRegistry.get(deps.chainId);
  let session: SessionRef;
  let executing: NonNullable<Awaited<ReturnType<AgentStore["readExecutingSession"]>>> | undefined;
  try {
    // TRADFI-EXPIRY-KEEP-REMOVE §4a: the caller's snapshot may be stale. A revoke
    // or retire committed since it was read must stop the submission here, before
    // the key is decrypted. Pause semantics are unchanged (sells bypass pause).
    // Inside the pre-submit boundary: a failed read releases the journal row.
    const fresh = await deps.agentStore.getAgent(agent.ownerAddress, agent.id);
    if (fresh === null || fresh.status === "revoked" || fresh.status === "retired") return rollBack("session", "REVOKED");
    executing = await deps.agentStore.readExecutingSession(agent.ownerAddress, agent.id) ?? undefined;
    if (executing === undefined) throw new ProviderError("Agent has no stored executing session.");
    // §4b: the key restored here MUST be the one the journal row records, so that
    // row's key is the submitting key for every row created from now on.
    if (executing.facts.publicKey.toLowerCase() !== facts.publicKey.toLowerCase()
      || (executing.facts.generation ?? 0) !== (facts.generation ?? 0)) return rollBack("session", "SESSION_CHANGED");
    session = provider.restoreSession({
      spec: executing.facts.spec, agent: agentAuthorityFromPrivateKey(executing.key), walletAddress: agent.walletAddress,
      publicKey: executing.facts.publicKey, expiresAt: executing.facts.expiry,
    });
    await provider.preflightExecute({ session, calls });
  } catch (error) {
    return rollBack("session", asPlaneError(error, "trade refused").code);
  }

  if (!reducesExposure && provider.nativeDayMeter !== undefined) {
    let meter: NativeDayMeterReading;
    try {
      meter = await provider.nativeDayMeter({ walletAddress: session.walletAddress, publicKey: session.publicKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }) });
    } catch (error) {
      const mapped = asPlaneError(error, "the native day meter could not be read");
      return rollBack("transport", mapped.code, undefined, undefined, mapped.code);
    }
    if (meter.kind === "day" && !nativeReserveFloor({ ...meter,
      grantedTokenCount: scheduleAgent ? 1 : meter.grantedTokenCount, submissionNativeWei: nativeInWei }).sufficient) {
      return rollBack("session", "NATIVE_RESERVE", undefined, NATIVE_RESERVE_REMEDY);
    }
  }

  // C3/R2.5: re-check the (already clamped) guard deadline immediately before
  // submission. Nothing has been submitted yet, so a rollback here spends no
  // fee and holds no journal row PENDING.
  if (isV2 && deps.preflight !== undefined) {
    const verdict = await preflightSimulate(deps.preflight, {
      agent, idempotencyKey: input.idempotencyKey, journalKind: "trade", exposure: reducesExposure ? "reduce" : "increase",
      route: request.guardQuote === undefined ? "direct" : "guard", calls,
      outputToken: request.side === "buy" ? request.token : getUsdtAddress(), minOutAtomic: request.minOutWei,
      guardDeadlineSec: guardDeadline, nowMs: nowMs(), ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (verdict.block) return rollBack("venue", "SIMULATION_FAILED", undefined, verdict.failReason ?? undefined);
  }
  if (guardDeadline !== undefined && Number(guardDeadline) * 1_000 - nowMs() < TRADFI_GUARD_MIN_REMAINING_MS) {
    return rollBack("venue", "GUARD_QUOTE_EXPIRED");
  }

  let receipt: ExecutionReceipt;
  if (staged) {
    if (provider.submitPreparedTrade === undefined) return rollBack("session", "STAGED_SUBMIT_UNAVAILABLE");
    let sent: ExecutionReceipt;
    try {
      sent = await provider.submitPreparedTrade.call(provider, {
        journalIdempotencyKey: input.idempotencyKey, expectedBindingVersion: 0,
        sessionPrivateKey: executing!.key, walletAddress: agent.walletAddress,
        persistedSession: executing!.facts, restoredSessionPublicKey: session.publicKey,
        restoredSessionExpiry: executing!.facts.expiry, calls,
        expectedExecutionDataHash: finalCalls!.value.executionDataHash,
        requireSignedPayloadBinding: true,
        bind: async (request) => {
          const bound = await deps.journal.bindPreparedIntent(input.idempotencyKey, {
            canonicalIdentity: request.canonicalIdentity, identityHash: request.identityHash,
            expectedBindingVersion: request.expectedBindingVersion,
          });
          return { ...request, boundBindingVersion: bound.boundBindingVersion };
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (isProvenPreBindStagedLpError(error)) {
        const reason = sanitizeMessage(error instanceof Error ? error.message : "cause unavailable");
        try {
          await deps.journal.markRolledBack(input.idempotencyKey,
            sanitizeMessage(`Refused before submission: RELAY_PREPARE_REFUSED. ${reason}`));
        } catch { return { kind: "unknown", meta: baseMeta }; }
        return { kind: "rolled-back", code: "RELAY_PREPARE_REFUSED", failureCode: "PROVIDER_ERROR",
          meta: { ...baseMeta, journalState: "ROLLED_BACK", deniedBy: "transport",
            code: "RELAY_PREPARE_REFUSED", note: reason } };
      }
      const mapped = asPlaneError(error, "trade failed");
      try { await deps.journal.markUnknown(input.idempotencyKey, sanitizeMessage(mapped.message)); }
      catch { /* A concurrent terminalization owns the row. */ }
      return { kind: "unknown", meta: { idempotencyKey: input.idempotencyKey, journalState: "UNKNOWN",
        failureCode: mapped.code, note: "Submission outcome is unknown and is held for reconciliation." } };
    }
    if (sent.callsId === undefined) {
      try { await deps.journal.markUnknown(input.idempotencyKey, "Staged submit returned no callsId."); }
      catch { /* A concurrent terminalization owns the row. */ }
      return { kind: "unknown", meta: baseMeta };
    }
    try { await deps.journal.markInProgress(input.idempotencyKey, { callsId: sent.callsId }); }
    catch { return { kind: "unknown", callsId: sent.callsId, meta: baseMeta }; }
    const awaited = provider.awaitExecution({ callsId: sent.callsId,
      ...(input.signal === undefined ? {} : { signal: input.signal }) });
    awaited.catch(() => undefined);
    const CEILING = Symbol("ceiling");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const winner = await Promise.race([
      awaited.then((value) => ({ receipt: value }), () => ({ receipt: null })),
      new Promise<typeof CEILING>((resolve) => { timer = setTimeout(() => resolve(CEILING), RECONCILE_ASSUMED_SUBMIT_TIMEOUT_MS); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (winner === CEILING || winner.receipt === null || winner.receipt.status === "PENDING") {
      return { kind: "unknown", callsId: sent.callsId,
        meta: { ...baseMeta, venue: request.venue, side: request.side, ...scanMeta, ...flapMeta } };
    }
    receipt = winner.receipt;
    try {
      const completed = await deps.journal.completeStagedTrade(input.idempotencyKey, { callsId: sent.callsId },
        receipt.status === "CONFIRMED"
          ? { state: "COMMITTED", ...(receipt.transactionHash === undefined ? {} : { txHash: receipt.transactionHash }) }
          : { state: "ROLLED_BACK", lastError: sanitizeMessage(receipt.failureCode ?? "Trade reported FAILED.") });
      if (!completed.applied) return { kind: "unknown", callsId: sent.callsId, meta: baseMeta };
    } catch { return { kind: "unknown", callsId: sent.callsId, meta: baseMeta }; }
  } else {
    try {
      receipt = await provider.executeViaSession({ session, calls, bypassLocalPolicyCheck: false });
    } catch (error) {
      const mapped = asPlaneError(error, "trade failed");
      await deps.journal.markUnknown(input.idempotencyKey, sanitizeMessage(mapped.message));
      return { kind: "unknown", meta: { idempotencyKey: input.idempotencyKey, journalState: "UNKNOWN", failureCode: mapped.code,
        note: "Submission outcome is unknown and is held for reconciliation." } };
    }
    if (receipt.callsId !== undefined) await deps.journal.markInProgress(input.idempotencyKey, { callsId: receipt.callsId });
    if (receipt.status === "CONFIRMED") {
      await deps.journal.markCommitted(input.idempotencyKey,
        receipt.transactionHash === undefined ? {} : { txHash: receipt.transactionHash });
    } else if (receipt.status === "FAILED") {
      await deps.journal.markRolledBack(input.idempotencyKey, sanitizeMessage(receipt.failureCode ?? "Trade reported FAILED."));
    }
  }
  const finalMeta = { ...baseMeta, venue: request.venue, side: request.side, ...scanMeta, ...flapMeta };
  if (receipt.status === "FAILED") return { kind: "committed", receipt, fill: null, meta: finalMeta };
  if (receipt.status === "PENDING") {
    return { kind: "unknown", ...(receipt.callsId === undefined ? {} : { callsId: receipt.callsId }),
      meta: finalMeta };
  }
  // AUDIT H2: the pre-extraction response only sourced token delta; entry basis is request native plus fee.
  const v2Proof = request.settlementAsset === "USDT" && deps.v2EvidenceForReceipt !== undefined
    ? await deps.v2EvidenceForReceipt({ receipt, idempotencyKey: input.idempotencyKey, request, walletAddress: agent.walletAddress,
      sessionPublicKey: facts.publicKey, sessionGeneration: facts.generation ?? 0, intentId: keccak256(stringToBytes(request.decisionId)), callsHash, calls })
    : null;
  const fill = await tradeReceiptFill({ request, walletAddress: agent.walletAddress,
    nativeInWei: request.side === "buy" ? request.amountWei + feeWei : 0n, receipt,
    ...(v2Proof === null ? {} : { v2Evidence: v2Proof.evidence, v2ExpectedIdentity: v2Proof.expected }),
    ...(deps.receiptReader === undefined ? {} : { reader: deps.receiptReader }),
    ...(deps.trade.venues.wbnb === undefined ? {} : { wbnb: deps.trade.venues.wbnb }) });
  return { kind: "committed", receipt, fill, meta: finalMeta };
}
