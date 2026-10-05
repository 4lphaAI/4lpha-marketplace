/**
 * AGENTIC-RFQ-STOCKS: the pure half of the Agentic-only RFQ lane. Nothing here does I/O, and nothing in an Altana path imports it at runtime except through a
 * branch gated on the hire marker (spec RI1). The worker calls these from `src/trade/worker.ts`; the quote source itself lives in `src/agentic/rfq.ts`.
 */
import type { Address } from "viem";
import type { ExitLlmContextRecord, TradePositionRecord } from "../store/tradePositions.js";
import type { AgentRecord } from "../store/agents.js";
import { RUG_QUOTE_WINDOW_MS, pnlBps } from "./exits.js";
import { TRADFI_TRAIL_ARM_BPS, tradfiRobotExit, type TradfiExitRulesMode } from "./exitRules.js";
import { TRADFI_LOSS_REVIEW_BPS, evaluateExitTrigger, type ExitTriggerContext, type Regime } from "./score.js";
import type { SessionState } from "./session.js";
import { admittedVenueRows } from "./rwa.js";
import type { UniverseRow } from "./dataPlaneReads.js";
import { USDT_56 } from "./settlement.js";
import type { TradfiQuote } from "./route.js";

/** E7: the Agentic quote source the worker is handed. Only `createAgenticWorkerDeps` builds one; Altana deps never carry it. */
export type RfqQuoteInput = { readonly agent: AgentRecord; readonly side: "buy" | "sell"; readonly token: Address; readonly amountAtomic: bigint; readonly signal?: AbortSignal };
export type RfqQuoteResult = { readonly ok: true; readonly outAtomic: bigint } | { readonly ok: false; readonly code: string };
export type RfqStocksDeps = {
  /** Non-null only for an RFQ-active agent (custody binance-agentic, AI mode, `hire_facts.rfq.v === 1`) whose wallet row is bound; `entries` is the worker's own flag. */
  active(agent: AgentRecord): Promise<{ readonly entries: boolean; readonly rfqOnlyAtHire: ReadonlySet<string> } | null>;
  quote(input: RfqQuoteInput): Promise<RfqQuoteResult>;
};

/** R4.2 N2: the pause before the confirming sell quote of a mark gate. */
export const RFQ_CONFIRM_DELAY_MS = 5_000;
/** R3.4: a previous reading is usable for this long (inclusive), and only strictly after its own cycle. */
export const RFQ_PREVIOUS_MAX_AGE_MS = RUG_QUOTE_WINDOW_MS;
/** R3.10: the routing label of every RFQ quote record; the executor ignores it (Binance executes), so it is the Flash synthetic route and a zero router that never leaves the local object. */
export const RFQ_ROUTER_LABEL: Address = "0x0000000000000000000000000000000000000000";
/** The ranking quote notional (R2): the default largest AI entry, 20 USDT. */
export const RFQ_RANKING_NOTIONAL_WEI = 20n * 10n ** 18n;

/** The ONE venue expression of the plane: the lane row's venues, else the venues of its RWA fact (the pin's own, `src/trade/universe.ts`). */
export function rfqRowVenues(row: UniverseRow | undefined): UniverseRow["venues"] {
  return row?.venues ?? row?.rwa?.venues;
}

/** E2: a stock is RFQ-only when no admitted venue is measured for it (pooled-first order; a missing row has none). */
export function isRfqOnlyRow(row: UniverseRow | undefined): boolean {
  return admittedVenueRows(rfqRowVenues(row)).length === 0;
}

/** 4.9 step 5 / R3.10: labels only. */
export function rfqQuoteRecord(input: { token: Address; amountInAtomic: bigint; quotedOutAtomic: bigint; minOutAtomic: bigint; nowMs: number }): TradfiQuote {
  return { venue: "pancake_v3", router: RFQ_ROUTER_LABEL, route: { hops: [], fees: [100] as const }, settlementToken: USDT_56, token: input.token,
    amountInAtomic: input.amountInAtomic, quotedOutAtomic: input.quotedOutAtomic, minOutAtomic: input.minOutAtomic, observedAt: input.nowMs, expiresAt: input.nowMs + 15_000 };
}

/** One mark of an RFQ-only position: the Binance sell quote of the whole balance and its pnl against the verified entry. */
export type RfqReading = { readonly quoteWei: bigint; readonly pnlBps: bigint };

/**
 * R3.4 / R4.8: the previous reading is the one stored on the position row loaded at the start of the cycle, usable iff all four fields are set, the route key and the balance are the
 * current ones, the basis is positive and `0 < now - lastQuoteAtMs <= 900 000` (so it comes from an earlier cycle: the strict lower bound is what stops a same-reading self-confirmation).
 */
export function usablePreviousReading(input: { readonly position: Pick<TradePositionRecord, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs" | "verifiedEntryAtomic">;
  readonly routeKey: string; readonly balance: bigint; readonly nowMs: number }): RfqReading | null {
  const { position } = input;
  if (position.lastQuoteWei === null || position.lastQuoteBalance === null || position.lastQuoteRoute === null || position.lastQuoteAtMs === null) return null;
  if (position.lastQuoteRoute !== input.routeKey || position.lastQuoteBalance !== input.balance) return null;
  const age = input.nowMs - position.lastQuoteAtMs;
  if (!(age > 0 && age <= RFQ_PREVIOUS_MAX_AGE_MS)) return null;
  const pnl = pnlBps(position.lastQuoteWei, position.verifiedEntryAtomic ?? 0n);
  return pnl === null ? null : { quoteWei: position.lastQuoteWei, pnlBps: pnl };
}

/** R3.4: the peak argument written with a reading is the lower of the pair, so one upward outlier can never raise the stored peak. `null` writes no peak. */
export function rfqPeakArgument(current: bigint | null, prev: RfqReading | null): bigint | null {
  if (current === null || prev === null) return null;
  return current < prev.pnlBps ? current : prev.pnlBps;
}

/** R5.1.5: the in-cycle peak. With a pair it is the stored peak raised to the lower reading; without one, the stored peak alone (`-Infinity` when null, which never arms T). */
export function rfqPeak(stored: bigint | null, current: bigint, prev: RfqReading | null): number {
  const base = stored === null ? Number.NEGATIVE_INFINITY : Number(stored);
  const raised = rfqPeakArgument(current, prev);
  return raised === null ? base : Math.max(base, Number(raised));
}

type GateInput = {
  readonly stopLossBps: number | null; readonly takeProfitBps: number | null; readonly maxHoldSec: number | null;
  readonly mode: TradfiExitRulesMode; readonly openedAtMs: number; readonly nowMs: number;
  readonly storedPeak: bigint | null; readonly prior: ExitTriggerContext | null;
};

function robotRule(input: GateInput, pnl: bigint, peak: number): string | null {
  if (input.mode !== "enforce") return null;
  return tradfiRobotExit({ pnlBps: Number(pnl), peakPnlBps: peak, openedAtMs: input.openedAtMs, nowMs: input.nowMs,
    takeProfitBlank: input.takeProfitBps === null, maxHoldBlank: input.maxHoldSec === null })?.rule ?? null;
}

/** A loss trigger needs no feature (R5.5): the trigger table evaluated with the prior context's own signs, regime and session so that only the price triggers can match. */
function lossTriggerKind(input: GateInput, pnl: bigint): "cost-band-breach" | "peak-giveback" | null {
  const prior = input.prior;
  const current: ExitTriggerContext = { pnlBps: Number(pnl), peakPnlBps: input.storedPeak === null ? null : Number(input.storedPeak),
    macdHistSign: prior?.macdHistSign ?? null, emaSpreadSign: prior?.emaSpreadSign ?? null, regime: prior?.regime ?? "unavailable", session: prior?.session ?? "rth" };
  const trigger = evaluateExitTrigger(prior, current);
  if (trigger === "cost-band-breach" && pnl < 0n) return "cost-band-breach";
  return trigger === "peak-giveback" ? "peak-giveback" : null;
}

/** R3.15: a loss trigger counts only if the previous reading also satisfies it on its own value. */
export function lossTriggerSatisfiedBy(kind: "cost-band-breach" | "peak-giveback", prevPnl: bigint, storedPeak: bigint | null): boolean {
  if (kind === "cost-band-breach") return prevPnl <= -BigInt(TRADFI_LOSS_REVIEW_BPS);
  return storedPeak !== null && prevPnl <= storedPeak - 200n;
}

/** The stored ask context as the trigger table reads it (the worker's own mapping, shared so the pricing site and the trigger site agree). */
export function priorFromStored(stored: ExitLlmContextRecord | null | undefined, fallbackSession: SessionState): ExitTriggerContext | null {
  if (stored === null || stored === undefined) return null;
  const regime: Regime = stored.regime === "risk_on" || stored.regime === "risk_off" || stored.regime === "neutral" || stored.regime === "unavailable" ? stored.regime : "unavailable";
  const session: SessionState = stored.session === "rth" || stored.session === "close" || stored.session === "overnight" ? stored.session : fallbackSession;
  return { pnlBps: stored.pnlBps, peakPnlBps: stored.peakPnlBps, macdHistSign: stored.macdHistSign, emaSpreadSign: stored.emaSpreadSign, regime, session, trigger: stored.trigger };
}

/**
 * R4.2 / R5.4 / R5.5 / R5.1.2: the gates that make the pricing site take its one confirming sell quote this cycle (empty: none).
 * Each gate that the FIRST reading breaches is checked against the previous reading: with no usable previous reading the pair does not exist (so any breach, or a blank threshold that
 * lets the exit model be asked, needs a confirmation); with one, only a breach the previous reading does not share needs it (a disagreeing pair).
 */
export function confirmationGates(input: GateInput & { readonly first: RfqReading; readonly prev: RfqReading | null; readonly hasBlankThreshold: boolean }): readonly string[] {
  const { first, prev } = input;
  const gates: { readonly name: string; readonly breach: boolean; readonly shared: boolean }[] = [];
  if (input.stopLossBps !== null) {
    const line = -BigInt(input.stopLossBps);
    gates.push({ name: "stop-loss", breach: first.pnlBps <= line, shared: prev !== null && prev.pnlBps <= line });
  }
  const firstRule = robotRule(input, first.pnlBps, rfqPeak(input.storedPeak, first.pnlBps, null));
  gates.push({ name: "robot", breach: firstRule !== null, shared: prev !== null && firstRule !== null && robotRule(input, prev.pnlBps, rfqPeak(input.storedPeak, first.pnlBps, prev)) === firstRule });
  const stored = input.storedPeak === null ? Number.NEGATIVE_INFINITY : Number(input.storedPeak);
  const pairPeak = rfqPeakArgument(first.pnlBps, prev);
  gates.push({ name: "peak", breach: Number(first.pnlBps) >= TRADFI_TRAIL_ARM_BPS && Number(first.pnlBps) > stored,
    shared: pairPeak !== null && Number(pairPeak) >= TRADFI_TRAIL_ARM_BPS && Number(pairPeak) > stored });
  const loss = lossTriggerKind(input, first.pnlBps);
  gates.push({ name: "loss-trigger", breach: loss !== null, shared: prev !== null && loss !== null && lossTriggerSatisfiedBy(loss, prev.pnlBps, input.storedPeak) });
  const open = gates.filter((gate) => gate.breach && (prev === null || !gate.shared)).map((gate) => gate.name);
  // R5.4: with no usable previous reading a blank threshold lets the exit model be asked this cycle, and its triggers are confirmed here (the trigger site never takes a quote).
  return prev === null && input.hasBlankThreshold && open.length === 0 ? ["ask"] : open;
}

/** P2: a sale that is not a mark decision never waits for a confirming quote. `exitRequestedAt` is the effective one the pass hands to `decideExit`; `autoExitReason` the masked one. */
export function skipsConfirmation(input: { readonly draining: boolean; readonly exitRequestedAt: number | null; readonly autoExitReason: string | null; readonly crashProtection: boolean | undefined }): boolean {
  return input.draining || input.exitRequestedAt !== null || input.autoExitReason === "session-expiring" || (input.autoExitReason === "crash-stop" && input.crashProtection === true);
}

/**
 * R4.1 / R5.1: what the exit model is shown and braked on for an RFQ-only position's trigger. A gain trigger keeps the cycle's current reading. A loss or non-price trigger needs a
 * confirmed pair: a failed confirmation or a missing previous reading holds it (not asked, nothing written, so it fires again on the next confirming reading); a loss trigger additionally
 * needs the previous reading to satisfy it on its own value; the asked pnl is the HIGHER of the pair, and `markQuote` is the quote behind it (the decision mark of the M1 hold).
 */
export function rfqAsk(input: { readonly trigger: string; readonly pnlBps: bigint; readonly quoteWei: bigint; readonly prev: RfqReading | null; readonly confirmFailed: string | null; readonly storedPeak: bigint | null }):
  { readonly kind: "ask"; readonly askedPnl: bigint; readonly markQuote: bigint } | { readonly kind: "hold"; readonly reason: string } {
  if (input.trigger === "cost-band-breach" && input.pnlBps > 0n) return { kind: "ask", askedPnl: input.pnlBps, markQuote: input.quoteWei };
  if (input.confirmFailed !== null) return { kind: "hold", reason: `confirm-failed:${input.confirmFailed}` };
  if (input.prev === null) return { kind: "hold", reason: "no-previous-reading" };
  const loss = input.trigger === "cost-band-breach" || input.trigger === "peak-giveback" ? input.trigger : null;
  if (loss !== null && !lossTriggerSatisfiedBy(loss, input.prev.pnlBps, input.storedPeak)) return { kind: "hold", reason: "previous-reading-did-not-confirm" };
  return input.prev.pnlBps > input.pnlBps ? { kind: "ask", askedPnl: input.prev.pnlBps, markQuote: input.prev.quoteWei } : { kind: "ask", askedPnl: input.pnlBps, markQuote: input.quoteWei };
}
