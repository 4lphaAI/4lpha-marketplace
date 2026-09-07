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
import { canonicalEncode } from "../auth/canonical.js";
import { authorizeExecute } from "../auth/executeDecision.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import { hashCalls, tradeParamsHash, type TradeRequest } from "../http/wire.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal, JournalEntry } from "../store/journal.js";
import type { ScanGate, ScanReason } from "../rules/scanGate.js";
import { evaluateTradeRules, exceedsDailyCap } from "../rules/engine.js";
import type { TradeRuntimeConfig } from "../ops/config.js";
import type { PancakeVenue } from "../ops/venues.js";
import { buildPancakeBuy, buildPancakeSell } from "../ops/pancake.js";
import { buildPancakeV3Buy, buildPancakeV3Sell, isEncodableV3Route } from "../ops/pancakeV3.js";
import { buildFourMemeBuy, buildFourMemeSell } from "../ops/fourmeme.js";
import { buildFlapBuy, buildFlapSell } from "../ops/flap.js";
import { feeValueOf } from "../ops/fees.js";
import { MAX_ROUTE_HOPS, type TradeRoute } from "../ops/route.js";
import { NATIVE_RESERVE_REMEDY, nativeReserveFloor } from "../ops/policy.js";
import { agentAuthorityFromPrivateKey } from "../wallet/altana.js";
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
  readonly chainId: number;
  readonly keyStore: Address;
  readonly agentStore: AgentStore;
  readonly journal: ExecutionJournal;
  readonly killswitch: KillSwitch;
  readonly providerRegistry: ProviderRegistry;
  readonly trade: TradeRuntimeConfig;
  readonly pancake: PancakeVenue | null;
  readonly pancakeV3: PancakeVenue | null;
  readonly flapPortal: Address | null;
  readonly receiptReader?: TradeReceiptReader;
  /** C27: supplied only by HTTP; the in-process worker has its interval bound. */
  readonly routeThrottle?: () => { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSec: number };
  readonly nowMs?: () => number;
};

export type TradeReceiptFill =
  | { readonly side: "buy"; readonly entryWei: bigint; readonly tokenAmount: bigint | null; readonly fillStatus: "verified" | "unverified" }
  | { readonly side: "sell"; readonly exitWei: bigint | null; readonly fillStatus: "verified" | "unverified" };

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
}): Promise<TradeReceiptFill> {
  let logs: readonly TradeReceiptLog[] = [];
  if (input.receipt.transactionHash !== undefined && input.reader !== undefined) {
    try { logs = (await input.reader.getReceipt(input.receipt.transactionHash)).logs; } catch { /* H2: persist uncertainty after commit. */ }
  }
  if (input.request.side === "buy") {
    const delta = tokenDelta(logs, input.request.token, input.walletAddress);
    return { side: "buy", entryWei: input.nativeInWei, tokenAmount: delta > 0n ? delta : null,
      fillStatus: delta > 0n ? "verified" : "unverified" };
  }
  const exitWei = nativeWithdrawal(logs, input.wbnb);
  return { side: "sell", exitWei: exitWei > 0n ? exitWei : null,
    fillStatus: exitWei > 0n ? "verified" : "unverified" };
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
  readonly flapPortal: Address | null;
}): { readonly paramsHash: Hex; readonly idempotencyKey: Hex } {
  const paramsHash = tradeParamsHash({
    chainId: input.chainId,
    venue: input.request.venue,
    side: input.request.side,
    token: input.request.token,
    amountWei: input.request.amountWei,
    minOutWei: input.request.minOutWei,
    quotedOutWei: input.request.quotedOutWei,
    ...(input.pancake === null ? {} : { router: input.pancake.router, wbnb: input.pancake.wbnb }),
    ...(input.pancakeV3 === null ? {} : { routerV3: input.pancakeV3.router }),
    ...(input.flapPortal === null ? {} : { flapPortal: input.flapPortal }),
    ...(input.trade.feeTreasury === undefined ? {} : { treasury: input.trade.feeTreasury }),
    ...(input.trade.feeBps === undefined ? {} : { feeBps: input.trade.feeBps }),
    ...(input.request.route === undefined ? {} : { route: input.request.route }),
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

async function withSessionKey<T>(
  store: AgentStore,
  agent: AgentRecord,
  use: (authority: ReturnType<typeof agentAuthorityFromPrivateKey>) => Promise<T>,
): Promise<T> {
  const sessionKey = await store.getAgentSessionKey(agent.ownerAddress, agent.id);
  if (sessionKey === null) throw new ProviderError("Agent has no stored session key.");
  return use(agentAuthorityFromPrivateKey(sessionKey));
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
  readonly flapPortal: Address | null;
  readonly fourMemeManager: Address | null;
  readonly fourMemeFundsWei: bigint;
  readonly fourMemeMsgValueWei: bigint;
}): readonly WalletCall[] | null {
  const { request, recipient, deadline } = input;
  const hops = request.route?.hops ?? [];
  if (hops.length > MAX_ROUTE_HOPS) return null;
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

  const feeCall = deps.trade.feePolicy({ agentId: agent.id, venue: request.venue, side: request.side,
    token: request.token, nativeInWei: request.side === "buy" ? request.amountWei : 0n });
  const feeWei = feeValueOf(feeCall);
  const swapNativeWei = request.side !== "buy" ? 0n : request.venue === "fourmeme" ? fourMemeMsgValueWei : request.amountWei;
  const nativeInWei = swapNativeWei + feeWei;
  const scan = await input.scanGate.evaluate({ chainId: deps.chainId, token: request.token, side: request.side,
    ...(input.signal === undefined ? {} : { signal: input.signal }) });
  if (scan.verdict === "deny") return deny("scan", "SCAN_DENIED", scan.reasons);
  const scanMeta = scan.reasons.length === 0 ? {} : { scanFlags: scan.reasons };

  const sinceMs = nowMs() - DAILY_WINDOW_MS;
  const spentTodayWei = await deps.journal.sumNativeSpendSince(agent.id, sinceMs);
  const ruled = evaluateTradeRules({ amountWei: request.amountWei, nativeInWei, minOutWei: request.minOutWei,
    quotedOutWei: request.quotedOutWei, caps: agent.caps, spentTodayWei,
    maxSlippageBps: deps.trade.maxSlippageBps });
  if (!ruled.allowed) return deny("rules", ruled.code);

  const venueCalls = buildVenueCalls({ request, recipient: agent.walletAddress,
    deadline: BigInt(nowSec() + deps.trade.deadlineSec), pancake: deps.pancake,
    pancakeV3: deps.pancakeV3, flapPortal: deps.flapPortal, fourMemeManager,
    fourMemeFundsWei, fourMemeMsgValueWei });
  if (venueCalls === null) return deny("venue", "VENUE_UNSUPPORTED");
  const calls = feeCall === null ? venueCalls : [...venueCalls, feeCall];
  const callsHash = hashCalls(calls);
  const { entry: begun, otherSpendWei, created } = await deps.journal.beginWithSpend({
    idempotencyKey: input.idempotencyKey, agentId: agent.id, ownerAddress: agent.ownerAddress,
    kind: "trade", decisionId: request.decisionId,
    externalRef: { paramsHash: input.paramsHash, callsHash, publicKey: facts.publicKey }, nativeSpendWei: nativeInWei,
  }, sinceMs);
  if (!created) return replayResult(begun);
  if (exceedsDailyCap(agent.caps, otherSpendWei, nativeInWei)) return rollBack("rules", "DAILY_CAP");

  const lateDecision = await authorizeExecute({ agent, killswitch: deps.killswitch, now: nowSec(), reducesExposure });
  if (!lateDecision.allowed) {
    await deps.journal.markRolledBack(input.idempotencyKey, sanitizeMessage(`Refused before submit: ${lateDecision.code}.`));
    return { kind: "denied", status: 409,
      code: lateDecision.code === "GLOBAL_HALT" ? "halted"
        : lateDecision.code === "AGENT_PAUSED" ? "paused" : "not_executable" };
  }

  const provider: WalletProvider = deps.providerRegistry.get(deps.chainId);
  let session: SessionRef;
  try {
    session = await withSessionKey(deps.agentStore, agent, async (authority) => provider.restoreSession({
      spec: facts.spec, agent: authority, walletAddress: agent.walletAddress,
      publicKey: facts.publicKey, expiresAt: facts.expiry,
    }));
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
    if (meter.kind === "day" && !nativeReserveFloor({ ...meter, submissionNativeWei: nativeInWei }).sufficient) {
      return rollBack("session", "NATIVE_RESERVE", undefined, NATIVE_RESERVE_REMEDY);
    }
  }

  let receipt: ExecutionReceipt;
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
  const finalMeta = { ...baseMeta, venue: request.venue, side: request.side, ...scanMeta, ...flapMeta };
  if (receipt.status === "FAILED") return { kind: "committed", receipt, fill: null, meta: finalMeta };
  if (receipt.status === "PENDING") {
    return { kind: "unknown", ...(receipt.callsId === undefined ? {} : { callsId: receipt.callsId }),
      meta: finalMeta };
  }
  // AUDIT H2: the pre-extraction response only sourced token delta; entry basis is request native plus fee.
  const fill = await tradeReceiptFill({ request, walletAddress: agent.walletAddress,
    nativeInWei: request.side === "buy" ? request.amountWei + feeWei : 0n, receipt,
    ...(deps.receiptReader === undefined ? {} : { reader: deps.receiptReader }),
    ...(deps.trade.venues.wbnb === undefined ? {} : { wbnb: deps.trade.venues.wbnb }) });
  return { kind: "committed", receipt, fill, meta: finalMeta };
}
