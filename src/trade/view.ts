/** Tenant-facing trading projections and remedies (TRADING-AGENT R2 / R3.1 / C22). */
import type { Address } from "viem";
import type { SessionFacts } from "../store/agents.js";
import type { TradePositionRecord, TradeRunRecord } from "../store/tradePositions.js";
import type { TradePositionObservation } from "./detail.js";

export const TRADE_CAPITAL_REMEDY = "Close positions, retire this agent, and deploy a new one with more capital.";
export const ORPHANED_POSITION_TEXT = "This server will not sell this position (the agent was retired). Deploy a new agent on this wallet: it will list this token first and can close the position.";
export const ORPHANED_OUTSIDE_MODEL_TEXT = "A token outside every model's candidate set remains stranded until ERC-20 withdraw ships.";
/** TRADFI-EXPIRY-KEEP-REMOVE §5.3: replaces both remedies above for a removed TradFi AI agent's holdings. */
export const KEPT_POSITION_TEXT = "Kept in the wallet: this agent was removed and no longer manages or sells this position. Withdraw it from Account.";

export function tradeRefusalText(code: string | null): string | null {
  if (code === null) return null;
  if (code === "NATIVE_RESERVE" || code === "DAILY_CAP" || code === "capital_too_small") {
    return TRADE_CAPITAL_REMEDY;
  }
  if (code === "SCAN_DENIED") return "This token did not pass the trading safety check.";
  if (code === "VENUE_UNSUPPORTED" || code === "VENUE_GRADUATED" || code === "VENUE_QUOTE_UNSUPPORTED") {
    return "This position cannot currently be quoted on its recorded venue.";
  }
  return "The last trade attempt was refused; the agent will retry when the blocking condition clears.";
}

export function pinnedTokens(facts: SessionFacts | null, excludeSettlementAsset = false): readonly Address[] {
  if (facts === null) return [];
  const tokens = new Map<string, Address>();
  for (const rule of facts.spec.allowedCalls) {
    if (rule.to !== undefined && rule.selector === "approve(address,uint256)") {
      if (!excludeSettlementAsset || rule.to.toLowerCase() !== "0x55d398326f99059ff775485246999027b3197955") tokens.set(rule.to.toLowerCase(), rule.to);
    }
  }
  return [...tokens.values()];
}

export function positionView(
  position: TradePositionRecord,
  marketHours: "us-equities" | null,
  observation?: TradePositionObservation,
  kept = false,
): Readonly<Record<string, unknown>> {
  const basis = position.settlementAsset === "USDT" ? position.verifiedEntryAtomic : position.entryWei;
  const realisedComplete = position.fillStatus === "verified"
    && position.tokenAmount !== null
    && position.soldTokenAmount === position.tokenAmount
    && position.exitFillStatus === "verified"
    && position.exitWei !== null
    && basis !== null && basis !== undefined;
  return {
    positionId: position.positionId,
    token: position.token,
    route: position.route,
    entryWei: position.entryWei.toString(10),
    ...(position.settlementAsset === undefined ? {} : { settlementAsset: position.settlementAsset }),
    ...(position.requestedEntryAtomic === undefined ? {} : { requestedEntryAtomic: position.requestedEntryAtomic?.toString(10) ?? null }),
    ...(position.verifiedEntryAtomic === undefined ? {} : { verifiedEntryAtomic: position.verifiedEntryAtomic?.toString(10) ?? null }),
    tokenAmount: position.tokenAmount?.toString(10) ?? null,
    fillStatus: position.fillStatus,
    openedAt: position.openedAt,
    entryTxHash: position.entryTxHash,
    status: position.status,
    exitRequestedAt: position.exitRequestedAt,
    orphanedAt: position.orphanedAt,
    closedAt: position.closedAt,
    exitWei: position.exitWei?.toString(10) ?? null,
    exitTxHash: position.exitTxHash,
    soldTokenAmount: position.soldTokenAmount?.toString(10) ?? null,
    exitFillStatus: position.exitFillStatus,
    // The current item-1 row has no quote-value column; null is an explicit unsourced value.
    pnlBps: !realisedComplete || basis === null || basis === undefined || basis === 0n
      ? null
      : ((position.exitWei! - basis) * 10_000n / basis).toString(10),
    noPriceCount: position.noPriceCount,
    held: position.fillStatus === "unverified" ? "fill-unverified"
      : position.noPriceCount >= 3 ? "no-price" : null,
    closeReason: position.closeReason,
    closeNote: position.closeNote,
    autoExitReason: position.autoExitReason,
    peakPnlBps: position.peakPnlBps?.toString(10) ?? null,
    lastSellRefusal: position.lastSellRefusal,
    lastSellRefusalAt: position.lastSellRefusalAt,
    refusalText: tradeRefusalText(position.lastSellRefusal),
    marketHours,
    observation: observation ?? null,
    ...(kept ? { orphanedText: KEPT_POSITION_TEXT, orphanedResidual: null }
      : position.status === "orphaned" ? { orphanedText: ORPHANED_POSITION_TEXT,
        orphanedResidual: ORPHANED_OUTSIDE_MODEL_TEXT } : {}),
  };
}

export function tradeSummary(
  positions: readonly TradePositionRecord[],
  observations: readonly TradePositionObservation[],
  maxOpenPositions: number | null,
): Readonly<Record<string, unknown>> {
  const byId = new Map(observations.map((item) => [item.positionId, item]));
  const open = positions.filter((position) => position.status !== "closed");
  const closed = positions.filter((position) => position.status === "closed");
  const closedComplete = closed.every((position) => position.fillStatus === "verified"
    && position.tokenAmount !== null && position.soldTokenAmount === position.tokenAmount
    && position.exitFillStatus === "verified" && position.exitWei !== null
    && (position.settlementAsset !== "USDT" || position.verifiedEntryAtomic !== null && position.verifiedEntryAtomic !== undefined));
  const openComplete = open.every((position) => byId.get(position.positionId)?.quoteStatus === "quoted");
  const basisComplete = positions.every((position) => position.settlementAsset !== "USDT" || position.verifiedEntryAtomic !== null && position.verifiedEntryAtomic !== undefined);
  const complete = closedComplete && openComplete && basisComplete;
  const mixedSettlement = positions.some((position) => position.settlementAsset === "USDT")
    && positions.some((position) => position.settlementAsset !== "USDT");
  const grossDeltaWei = complete && !mixedSettlement
    ? positions.reduce((sum, position) => {
      const basis = position.settlementAsset === "USDT" ? position.verifiedEntryAtomic : position.entryWei;
      const value = position.status === "closed"
        ? position.exitWei
        : (() => {
          const raw = byId.get(position.positionId)?.currentQuoteWei;
          return raw === null || raw === undefined ? null : BigInt(raw);
        })();
      return value === null || basis === null || basis === undefined ? sum : sum + value - basis;
    }, 0n)
    : null;
  const wins = closedComplete && !mixedSettlement
    ? closed.filter((position) => {
      const basis = position.settlementAsset === "USDT" ? position.verifiedEntryAtomic : position.entryWei;
      return basis !== null && basis !== undefined && position.exitWei !== null && position.exitWei > basis;
    }).length
    : null;
  const winRateBps = wins === null || closed.length === 0 ? null : Math.floor((wins * 10_000) / closed.length);
  return {
    grossDeltaWei: grossDeltaWei?.toString(10) ?? null,
    grossComplete: complete,
    grossReason: complete ? null : "A position lacks attributable live value or verified proceeds.",
    wins,
    winRateBps,
    closedTrades: closed.length,
    openPositions: open.length,
    maxOpenPositions,
    observedAt: observations.length === 0 ? null : Math.min(...observations.map((item) => item.observedAt)),
  };
}

export function runView(run: TradeRunRecord): Readonly<Record<string, unknown>> {
  return {
    id: run.id, dryRun: run.dryRun, reason: run.reason,
    candidates: run.candidates, refusals: run.refusals, entries: run.entries, exits: run.exits,
    createdAt: run.createdAt, events: run.events ?? [],
  };
}
