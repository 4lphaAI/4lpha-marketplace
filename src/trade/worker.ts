/** One bounded autonomous trading pass (TRADING-AGENT R3.8 / C31). */
import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import type { ExecutionReceipt, WalletProvider } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import type { TradeRequest } from "../http/wire.js";
import type { ScanGate } from "../rules/scanGate.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { TradeCloseReason, TradePositionRecord, TradePositionStore } from "../store/tradePositions.js";
import type { TradeIntentRecord, TradeIntentStore } from "../store/tradeIntents.js";
import type { TradeSettingsRecord, TradeSettingsStore } from "../store/tradeSettings.js";
import { grantsTokenSell } from "../ops/policy.js";
import { applySlippageFloorWei, decideExit, pnlBps } from "./exits.js";
import {
  buildEntryPrompt,
  buildExitPrompt,
  enteredIndexes,
  validateEntryResponse,
  validateExitResponse,
  type TradeLlm,
  type OpenRouterMessage,
} from "./llm.js";
import {
  quoteBestBuyRoute,
  TradeRouteQuoteError,
  quoteSellAlongRoute,
  USDT_56,
  type BestBuyRoute,
  type RouteQuoteReader,
} from "./route.js";
import { parseTradeSettings, type TradeSettings } from "./settings.js";
import {
  createTradeVerdictCache,
  selectEntryCandidates,
  type EntryCandidate,
  type TradeVerdictCache,
} from "./universe.js";
import type { TradeDataPlaneReads } from "./dataPlaneReads.js";
import type { TradeReadiness } from "./readiness.js";
import { pinnedTokens } from "./view.js";
import { AGENT_GAS_MAX_BACKOFF_MS, agentGasFloor, agentGasReason, classifyAgentGas } from "../ops/gasFloor.js";
import { normalizeTradeRunEvents, type TradeRunEvent } from "../store/tradeRunTrace.js";
import { sizeTradeBuy } from "./sizing.js";
import { enrichFeatures, featurePrompt, assessMomentum, featureModel } from "./features.js";

export type TradeExecutionMeta = Readonly<Record<string, unknown>>;
export type TradeExecutorFill =
  | { readonly side: "buy"; readonly entryWei: bigint; readonly tokenAmount: bigint | null; readonly fillStatus: "verified" | "unverified" }
  | { readonly side: "sell"; readonly exitWei: bigint | null; readonly fillStatus: "verified" | "unverified" };

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
  readonly agentStore: Pick<AgentStore, "getAgentById">;
  readonly settingsStore: Pick<TradeSettingsStore, "listTradeAgentsForWorker" | "listTradeAgentsForProjection" | "withEntryFence">;
  readonly positions: Pick<TradePositionStore,
    "get" | "list" | "listOpen" | "open" | "closePosition" | "recordSellRefusal" | "resolveFill" | "incrementNoPrice" | "resetNoPrice" | "markOrphaned" | "insertRun">;
  readonly intents: Pick<TradeIntentStore, "create" | "listUnsettled" | "markSubmitted" | "markProjected" | "markRolledBack">;
  readonly journal: Pick<ExecutionJournal, "get">;
  readonly dataPlane: TradeDataPlaneReads;
  readonly provider: Pick<WalletProvider, "getTokenBalance">;
  /**
   * One client per model id. The settings carry a primary and a distinct
   * fallback (operator, 2026-09-03), so the worker resolves both per agent
   * rather than holding a single daemon-wide client.
   */
  readonly llmFor: (modelId: string) => TradeLlm;
  readonly executor: TradeExecutor;
  readonly executorDeps: unknown;
  readonly readiness: Pick<TradeReadiness, "ready" | "allowlistAvailable" | "bstocksAddresses">;
  readonly rpcUrls: readonly string[];
  /** The same boot-resolved percentage used by the executor's fee policy. */
  readonly platformFeeBps: number;
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

function observe(counts: MutableCounts, event: Omit<TradeRunEvent, "elapsedMs">): void {
  if (counts.events === undefined || counts.events.length >= 100) return;
  counts.events.push(...normalizeTradeRunEvents([{ ...event, elapsedMs: Date.now() - (counts.startedAt ?? Date.now()) }]));
}

function settingsFrom(value: unknown): TradeSettings {
  const parsed = parseTradeSettings(value);
  if (!parsed.ok) throw new Error("Stored trade settings are invalid.");
  return parsed.value;
}

function venueForRoute(route: TradePositionRecord["route"]): "pancake_v2" | "pancake_v3" {
  return route.fees.length === 0 ? "pancake_v2" : "pancake_v3";
}

function tradeVenue(venue: "pancake_v2" | "pancake_v3"): TradeRequest["venue"] {
  return venue === "pancake_v2" ? "pancake" : "pancake_v3";
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
  readonly venue: "pancake_v2" | "pancake_v3";
};

async function repairSellRoute(
  deps: TradeWorkerDeps,
  position: TradePositionRecord,
  balance: bigint,
  signal?: AbortSignal,
): Promise<Omit<PricedPosition, "position" | "balance"> | null> {
  const probes = [
    { venue: "pancake_v2" as const, route: { hops: [], fees: [] } },
    ...([100, 500, 2_500, 10_000] as const).map((fee) => ({ venue: "pancake_v3" as const, route: { hops: [], fees: [fee] } })),
    { venue: "pancake_v3" as const, route: { hops: [USDT_56], fees: [100, 100] as const } },
    { venue: "pancake_v3" as const, route: { hops: [USDT_56], fees: [500, 100] as const } },
  ];
  let best: Omit<PricedPosition, "position" | "balance"> | null = null;
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
    const venue = venueForRoute(position.route);
    try {
      const quoteOutWei = await quoteSellAlongRoute({
        token: position.token, amountInWei: balance, venue, route: position.route,
        rpcUrls: deps.rpcUrls,
        ...(signal === undefined ? {} : { signal }),
        ...(deps.routeReader === undefined ? {} : { reader: deps.routeReader }),
      });
      await deps.positions.resetNoPrice(agent.ownerAddress, agent.id, position.positionId);
      priced.push({ position, balance, quoteOutWei, venue, route: position.route });
    } catch {
      signal?.throwIfAborted();
      const repair = repaired ? null : await repairSellRoute(deps, position, balance, signal);
      repaired = true;
      if (repair !== null) {
        await deps.positions.resetNoPrice(agent.ownerAddress, agent.id, position.positionId);
        priced.push({ position, balance, ...repair });
        continue;
      }
      const row = await deps.positions.incrementNoPrice(agent.ownerAddress, agent.id, position.positionId);
      if ((row?.noPriceCount ?? position.noPriceCount + 1) >= 3) counts.heldNoPrice += 1;
    }
  }
  return priced;
}

async function projectIntent(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  intent: TradeIntentRecord,
  txHash: Hex,
  fill: TradeExecutorFill,
  signal?: AbortSignal,
): Promise<boolean> {
  if (intent.side === "buy") {
    if (fill.side !== "buy") return false;
    const existing = await deps.positions.get(agent.ownerAddress, agent.id, intent.positionId);
    if (existing === null) {
      await deps.positions.open({
        positionId: intent.positionId,
        agentId: agent.id,
        ownerAddress: agent.ownerAddress,
        token: intent.token,
        route: intent.route,
        // The durable intent is written before submission from the exact same
        // fee policy as execution. It is the restart-stable cost basis; receipt
        // recovery must not silently drop the platform fee.
        entryWei: intent.entryWei ?? fill.entryWei,
        tokenAmount: fill.tokenAmount,
        fillStatus: fill.fillStatus,
        openedAt: intent.createdAt,
        entryTxHash: txHash,
      });
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
      reason: intent.closeReason ?? "owner-request",
    });
  }
  await deps.intents.markProjected(agent.ownerAddress, agent.id, intent.decisionId);
  return true;
}

async function reconcileTradeIntents(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  signal?: AbortSignal,
): Promise<readonly TradeIntentRecord[]> {
  const unsettled = await deps.intents.listUnsettled(agent.ownerAddress, agent.id);
  for (const intent of unsettled) {
    const journal = await deps.journal.get(intent.idempotencyKey);
    if (journal === null || journal.state === "ROLLED_BACK") {
      await deps.intents.markRolledBack(agent.ownerAddress, agent.id, intent.decisionId,
        journal === null ? "No submission journal exists." : "Trade journal rolled back before projection.");
      continue;
    }
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
  return deps.intents.listUnsettled(agent.ownerAddress, agent.id);
}

async function sellPosition(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: TradeSettings,
  priced: PricedPosition,
  closeReason: Exclude<TradeCloseReason, "balance-gone">,
  counts: MutableCounts,
  signal?: AbortSignal,
): Promise<void> {
  const prior = (await deps.intents.listUnsettled(agent.ownerAddress, agent.id))
    .find((intent) => intent.side === "sell" && intent.positionId === priced.position.positionId);
  if (prior !== undefined) return;
  const request: TradeRequest = {
    decisionId: randomUUID(),
    venue: tradeVenue(priced.venue),
    side: "sell",
    token: priced.position.token,
    amountWei: priced.balance,
    quotedOutWei: priced.quoteOutWei,
    minOutWei: applySlippageFloorWei(priced.quoteOutWei, settings.slippageBps),
    route: priced.route,
  };
  const identity = deps.executionIdentity(agent, request);
  const intent = await deps.intents.create({
    decisionId: request.decisionId,
    idempotencyKey: identity.idempotencyKey,
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    side: "sell",
    token: request.token,
    route: priced.route,
    amountWei: priced.balance,
    entryWei: priced.position.entryWei,
    positionId: priced.position.positionId,
    closeReason,
  });
  const result = await execute(deps, agent, request, {
    async evaluate() { return { verdict: "allow", reasons: [] }; },
  }, signal);
  observe(counts, { stage: "sell", code: resultCode(result), token: priced.position.token, reason: closeReason });
  if (result.kind === "committed") {
    const txHash = result.receipt.transactionHash;
    if (txHash !== undefined) {
      await deps.intents.markSubmitted(agent.ownerAddress, agent.id, intent.decisionId, txHash);
      const fill = result.fill?.side === "sell" ? result.fill
        : { side: "sell" as const, exitWei: null, fillStatus: "unverified" as const };
      if (await projectIntent(deps, agent, intent, txHash, fill, signal)) counts.exits += 1;
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

async function runExits(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: TradeSettings,
  counts: MutableCounts,
  nowMs: number,
  draining: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const open = await deps.positions.listOpen(agent.ownerAddress, agent.id);
  const ordered = [...open].sort((left, right) =>
    Number(right.exitRequestedAt !== null) - Number(left.exitRequestedAt !== null)
    || left.openedAt - right.openedAt);
  const priced = await pricePositions(deps, agent, ordered, counts, signal);
  const llmCandidates: PricedPosition[] = [];
  for (const item of priced) {
    const decision = decideExit({
      quoteOutWei: item.quoteOutWei, entryWei: item.position.entryWei,
      openedAtMs: item.position.openedAt, nowMs,
      stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps,
      maxHoldSec: settings.maxHoldSec,
      exitRequestedAt: draining ? (item.position.exitRequestedAt ?? nowMs) : item.position.exitRequestedAt,
    });
    // The exit side follows the entry side (see universe.ts): a shut underlying
    // market is a fact about the asset, and the sell quote itself is the price.
    // Refusing to exit on a calendar would strand a position the pool can close.
    if (decision.exit) {
      await sellPosition(deps, agent, settings, item, decision.reason, counts, signal);
    } else if (
      (settings.takeProfitBps === null || settings.stopLossBps === null)
      && !decision.exit
    ) {
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
      }];
    });
    if (llmPositions.length !== llmCandidates.length) return;
    const features = await enrichFeatures(deps.dataPlane, settings.executionModel,
      llmCandidates.map(item => item.position.token), deps.now?.() ?? Date.now(), signal);
    const featureNow = deps.now?.() ?? Date.now();
    if (featureModel(settings.executionModel)) for (const item of llmCandidates) {
      const evidence = features.get(item.position.token.toLowerCase());
      const momentum = assessMomentum(evidence ?? {}, featureNow);
      observe(counts, { stage: "exit-llm", code: !evidence ? "feature-missing" : momentum.status === "unavailable" ? "feature-partial" : "feature-ready",
        token: item.position.token, reason: `momentum:${momentum.status}; snapshot:${evidence?.["15m"]?.snapshotId ?? evidence?.["1h"]?.snapshotId ?? "none"}` });
    }
    const answer = await completeWithFallback(deps, settings, buildExitPrompt({
      featureBlocks: llmCandidates.map((item, index) => {
        const block = featurePrompt(features.get(item.position.token.toLowerCase()), featureNow);
        return block ? `${index}: ${block}` : "";
      }),
      positions: llmPositions,
      owner: settings,
    }), signal, (event) => observe(counts, { ...event, stage: "exit-llm" }));
    const decisions = validateExitResponse(answer.content, llmCandidates.length);
    if (!decisions.ok) { observe(counts, { stage: "exit-llm", code: "invalid-response" }); return; }
    for (const decision of decisions.decisions) {
      const item = llmCandidates[decision.index];
      observe(counts, { stage: "exit-llm", code: decision.exit ? "exit" : "hold", model: answer.model, reason: decision.reason, ...(item === undefined ? {} : { token: item.position.token }) });
      if (decision.exit && item !== undefined) await sellPosition(deps, agent, settings, item, "llm", counts, signal);
    }
  } catch {
    observe(counts, { stage: "exit-llm", code: "unavailable-hold" });
    // R7: model failure is a hold, never an exit guess.
  }
}

async function runEntry(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settings: TradeSettings,
  counts: MutableCounts,
  nowMs: number,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const facts = agent.sessionFacts;
  if (facts === null) throw new Error("Agent session facts are unavailable.");
  const open = await deps.positions.listOpen(agent.ownerAddress, agent.id);
  if (open.length >= settings.maxOpenPositions) return "at-capacity";
  const buySize = sizeTradeBuy({ entryWei: BigInt(settings.entryWei),
    perTradeCapWei: agent.caps?.perTradeNativeWei, platformFeeBps: deps.platformFeeBps });
  if (buySize === null) return "entry-budget-too-small";
  if (settings.executionModel === "mid-cap" && !deps.readiness.allowlistAvailable) {
    return "allowlist-lane-unavailable";
  }
  // Preserve already-granted larger sessions; the 25-token ceiling applies to new hires.
  // AUDIT M1: an armed agent's durable grant is its universe; pinning runs only at hire/preview.
  const candidates = pinnedTokens(agent.sessionFacts).slice(0, settings.executionModel === "blue-chip" || settings.executionModel === "sigma" ? 69 : 25).map((address) => ({
    address,
    symbol: address.slice(0, 8),
    lane: deps.readiness.bstocksAddresses.has(address.toLowerCase()) ? "bstocks" as const
      : settings.executionModel === "degen" ? "meme" as const : "allowlist" as const,
    marketCapUsd: null, priceUsd: null, volume24hUsd: null, priceChange24hPct: null, holders: null,
    ...(deps.readiness.bstocksAddresses.has(address.toLowerCase()) ? { marketHours: "us-equities" as const } : {}),
  }));
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
    usEquityAddresses: deps.readiness.bstocksAddresses,
    dataPlane: deps.dataPlane,
    ...(signal === undefined ? {} : { signal }),
    nowMs,
    ...(deps.verdictCache === undefined ? {} : { verdictCache: deps.verdictCache }),
  });
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
  observe(counts, { stage: "screen", code: "shortlisted", reason: `${routeable.length} candidates passed screening and routeability` });
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

async function processAgent(
  deps: TradeWorkerDeps,
  agent: AgentRecord,
  settingsRow: TradeSettingsRecord,
  options: RunTradeWorkerOptions,
): Promise<TradeWorkerAgentOutcome> {
  const dryRun = options.dryRun === true;
  const counts: MutableCounts = { events: [], startedAt: Date.now(), candidates: 0, refusals: 0, entries: 0, exits: 0, heldNoPrice: 0 };
  let reason = "ok";
  try {
    const settings = settingsFrom(settingsRow.params);
    if (agent.sessionFacts === null) throw new Error("Agent session facts are unavailable.");
    // R7: dry-run calls the model/data plane but never touches provider or position mutations.
    if (!dryRun) await runExits(deps, agent, settings, counts, deps.now?.() ?? Date.now(), settingsRow.drainingAt !== null, options.signal);
    reason = settingsRow.drainingAt !== null
      ? "draining"
      : await runEntry(deps, agent, settings, counts, deps.now?.() ?? Date.now(), dryRun, options.signal);
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

/** Sweep every stable 32-row page; one agent failure never stops the page or sweep. */
/**
 * Ask the owner's primary model; on a throw (timeout, transport, HTTP error)
 * ask the distinct fallback once. An off-schema ANSWER is not retried here —
 * the validator decides that, and a second call would double the cost for a
 * model that already answered.
 */
async function completeWithFallback(
  deps: Pick<TradeWorkerDeps, "llmFor">,
  settings: { readonly primaryModel: string; readonly fallbackModel: string },
  prompt: readonly OpenRouterMessage[],
  signal?: AbortSignal,
  observeCall?: (event: Omit<TradeRunEvent, "stage" | "elapsedMs">) => void,
): Promise<{ readonly content: string; readonly model: string }> {
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

export async function runTradeWorkerOnce(
  deps: TradeWorkerDeps,
  options: RunTradeWorkerOptions = {},
): Promise<TradeWorkerReport> {
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
        if (agent.status === "revoked") {
          for (const position of await deps.positions.listOpen(agent.ownerAddress, agent.id)) {
            await deps.positions.markOrphaned(agent.ownerAddress, agent.id, position.positionId);
          }
        }
      }
      if (!page.hasMore || page.cursor === null) break;
      projectionCursor = page.cursor;
    }
  }
  if (!deps.readiness.ready) {
    deps.log?.("[trade-worker] data plane is not ready; skipping cycle");
    return { skippedNotReady: true, outcomes: [] };
  }
  const outcomes: TradeWorkerAgentOutcome[] = [];
  // AGENT-GAS-ATTENTION §2.2 — one `eth_getBalance` per WALLET per cycle.
  // Rebuilt per cycle: a balance from a previous cycle is not a reading.
  const gasCache = new Map<string, bigint | undefined>();
  let cursor: string | null = null;
  for (;;) {
    const page = await deps.settingsStore.listTradeAgentsForWorker({ limit: 32, cursor });
    for (const row of page.rows) {
      const agent = await deps.agentStore.getAgentById(row.agentId);
      if (agent === null) continue;
      // AUDIT L9 / TRADING-AGENT R5/R9: pause deliberately stops entries AND exits, matching Venus D4.
      if (agent.status !== "armed") continue;
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
        outcomes.push(await processAgent(deps, agent, row, options));
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
    if (!page.hasMore || page.cursor === null) break;
    cursor = page.cursor;
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
