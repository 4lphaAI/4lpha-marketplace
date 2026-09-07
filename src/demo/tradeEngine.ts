/**
 * DEMO MODE — the trading engine, PURE.
 *
 * ─── THE MODEL, PORTED FROM 4alpha ─────────────────────────────────────────
 *
 * `D:\4alpha` `lib/agents/execution.ts:283` is one branch at the top of the
 * execute seam: in paper mode a fill IS the live quote, `gasUsed: "0"`, no tx
 * hash. That is the whole simulation, and it is honest because the quote is
 * real on-chain data read from the same source the live path reads.
 *
 * This is that model, with two differences forced by where it now lives:
 *
 *   1. It is a SEPARATE engine, not a branch inside `src/trade/execute.ts`.
 *      4alpha could afford the branch; this repo cannot, because that file is
 *      on the money path and a boolean inside it fails in both directions —
 *      a demo agent that submits, or a live agent that silently does not.
 *   2. The decision layer is IMPORTED rather than re-implemented:
 *      `decideExit` from `src/trade/exits.ts` is the live precedence
 *      (owner-request, stop-loss, take-profit, max-hold, then LLM) and the demo
 *      calls it unmodified. A demo that decided differently would teach the
 *      visitor the wrong thing about the agent they are about to hire.
 *
 * ─── WHAT IT DOES NOT MODEL (plan §4, and the UI must say so) ──────────────
 *
 *   - slippage beyond the quoted route, and this order's own price impact
 *   - MEV, failed submissions, priority fees
 *   - transfer taxes and honeypot behaviour a live trade would actually meet
 *
 * Gas is charged as a disclosed line item, exactly as the grid engine charges
 * it: `relayFeePerSubmitWei` per leg, accumulated, never netted in silence.
 *
 * ─── PURITY ────────────────────────────────────────────────────────────────
 *
 * No clock, no I/O, no LLM call. Quotes and any brain verdict arrive as inputs,
 * so a demo run replays exactly from its recorded observations.
 */
import { decideExit, pnlBps, type ExitDecision } from "../trade/exits.js";
import type { Address } from "viem";

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type DemoTradePosition = {
  readonly token: Address;
  readonly symbol: string;
  /**
   * The position's size as an ABSTRACT 18-decimal quantity — NOT the token's
   * own units (fix-review finding 11 corrected this comment).
   *
   * The demo never touches a real token and therefore never learns its
   * `decimals()`; nothing in this repo reads that value without a source, and
   * assuming 18 would be quietly wrong for every USDC-shaped token. An abstract
   * quantity is exact for the only arithmetic the demo does — quote in, quote
   * out — and any surface printing it must label it raw rather than format it
   * as if it knew the scale.
   */
  readonly baseWei: bigint;
  /** What the entry cost in quote wei — the basis every exit is scored against. */
  readonly entryQuoteWei: bigint;
  readonly openedAtMs: number;
};

export type DemoTradeState = {
  /** Uninvested quote, in wei. Starts at the demo's declared capital. */
  readonly cashQuoteWei: bigint;
  readonly positions: readonly DemoTradePosition[];
  readonly realisedQuoteWei: bigint;
  /** Gas charged so far, in quote wei. A LINE ITEM, never netted in silence. */
  readonly costQuoteWei: bigint;
  readonly trades: number;
};

/** What a demo trade agent was configured with. Frozen for the run's life. */
export type DemoTradeSettings = {
  readonly buySizeQuoteWei: bigint;
  readonly maxOpenPositions: number;
  readonly stopLossBps: number | null;
  readonly takeProfitBps: number | null;
  readonly maxHoldSec: number | null;
};

/** A live mark for a held token: what selling ALL of it would return now. */
export type DemoTradeMark = {
  readonly token: Address;
  readonly quoteOutWei: bigint;
};

/** A buyable candidate: what `buySizeQuoteWei` would return in token units. */
export type DemoTradeCandidate = {
  readonly token: Address;
  readonly symbol: string;
  readonly baseOutWei: bigint;
};

/** The brain's optional verdict on a held token, when its budget allowed one. */
export type DemoTradeBrainVerdict = {
  readonly token: Address;
  readonly exit: boolean;
  readonly reason?: string;
};

export type DemoTradeFill = {
  readonly side: "buy" | "sell";
  readonly token: Address;
  readonly symbol: string;
  readonly atMs: number;
  readonly quoteWei: bigint;
  readonly baseWei: bigint;
  /** Present on a SELL: the realised result of the round trip, in bps and wei. */
  readonly pnlBps: bigint | null;
  readonly pnlQuoteWei: bigint | null;
  /** Which rule fired. `entry` on a buy, the live exit reason on a sell. */
  readonly reason: ExitDecision["reason"] | "entry";
};

/* -------------------------------------------------------------------------- */
/* Step                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Advance a demo trade agent by ONE cycle.
 *
 * EXITS BEFORE ENTRIES, and at most ONE buy per cycle — the live worker's own
 * shape (`src/trade/worker.ts`). Freeing capital before spending it is what
 * makes a small demo capital behave like the live agent's rather than like a
 * bot with infinite balance.
 *
 * A token with no mark this cycle is HELD, never marked to a stale price and
 * never force-exited: an unreadable quote is missing evidence, and the demo's
 * answer to missing evidence is the same as the plane's — do nothing and say
 * why (plan §7's dash-with-a-reason, surfaced by the caller).
 */
export function demoTradeStep(input: {
  readonly state: DemoTradeState;
  readonly settings: DemoTradeSettings;
  readonly nowMs: number;
  readonly marks: readonly DemoTradeMark[];
  readonly candidates: readonly DemoTradeCandidate[];
  readonly brain: readonly DemoTradeBrainVerdict[];
  readonly relayFeePerSubmitWei: bigint;
  /** Tokens the owner asked to close, by the demo's own exit flag. */
  readonly exitRequested: readonly Address[];
}): { readonly state: DemoTradeState; readonly fills: readonly DemoTradeFill[] } {
  const markBy = new Map(input.marks.map((mark) => [key(mark.token), mark.quoteOutWei]));
  const brainBy = new Map(input.brain.map((verdict) => [key(verdict.token), verdict]));
  const requested = new Set(input.exitRequested.map(key));
  const fills: DemoTradeFill[] = [];

  let cashQuoteWei = input.state.cashQuoteWei;
  let realisedQuoteWei = input.state.realisedQuoteWei;
  let costQuoteWei = input.state.costQuoteWei;
  let trades = input.state.trades;
  const held: DemoTradePosition[] = [];

  // ── exits ────────────────────────────────────────────────────────────────
  for (const position of input.state.positions) {
    const quoteOutWei = markBy.get(key(position.token));
    if (quoteOutWei === undefined) {
      held.push(position);
      continue;
    }
    const verdict = brainBy.get(key(position.token));
    const decision = decideExit({
      quoteOutWei,
      entryWei: position.entryQuoteWei,
      openedAtMs: position.openedAtMs,
      nowMs: input.nowMs,
      stopLossBps: input.settings.stopLossBps,
      takeProfitBps: input.settings.takeProfitBps,
      maxHoldSec: input.settings.maxHoldSec,
      exitRequestedAt: requested.has(key(position.token)) ? input.nowMs : null,
      ...(verdict === undefined
        ? {}
        : { llmExit: verdict.exit, ...(verdict.reason === undefined ? {} : { llmReason: verdict.reason }) }),
    });
    if (!decision.exit) {
      held.push(position);
      continue;
    }
    cashQuoteWei += quoteOutWei;
    const pnlQuoteWei = quoteOutWei - position.entryQuoteWei;
    realisedQuoteWei += pnlQuoteWei;
    costQuoteWei += input.relayFeePerSubmitWei;
    trades += 1;
    fills.push({
      side: "sell",
      token: position.token,
      symbol: position.symbol,
      atMs: input.nowMs,
      quoteWei: quoteOutWei,
      baseWei: position.baseWei,
      pnlBps: pnlBps(quoteOutWei, position.entryQuoteWei),
      pnlQuoteWei,
      reason: decision.reason,
    });
  }

  // ── one entry ────────────────────────────────────────────────────────────
  // Deliberately after the exits, and deliberately singular. A demo that
  // opened a whole shortlist at once would show a fill rate no live agent
  // reaches, which is the most flattering lie a simulation can tell.
  const size = input.settings.buySizeQuoteWei;
  if (held.length < input.settings.maxOpenPositions && size > 0n && cashQuoteWei >= size) {
    const openTokens = new Set(held.map((position) => key(position.token)));
    const pick = input.candidates.find(
      (candidate) => !openTokens.has(key(candidate.token)) && candidate.baseOutWei > 0n,
    );
    if (pick !== undefined) {
      cashQuoteWei -= size;
      costQuoteWei += input.relayFeePerSubmitWei;
      trades += 1;
      held.push({
        token: pick.token,
        symbol: pick.symbol,
        baseWei: pick.baseOutWei,
        entryQuoteWei: size,
        openedAtMs: input.nowMs,
      });
      fills.push({
        side: "buy",
        token: pick.token,
        symbol: pick.symbol,
        atMs: input.nowMs,
        quoteWei: size,
        baseWei: pick.baseOutWei,
        pnlBps: null,
        pnlQuoteWei: null,
        reason: "entry",
      });
    }
  }

  return {
    state: { cashQuoteWei, positions: held, realisedQuoteWei, costQuoteWei, trades },
    fills,
  };
}

/**
 * The agent's mark-to-market, for a view.
 *
 * Returns `null` for any position with no mark this cycle rather than falling
 * back to its entry, so an equity figure is either complete or absent — the
 * plane's dash-with-a-reason rule applied to a number a visitor might act on.
 */
export function demoTradeEquity(
  state: DemoTradeState,
  marks: readonly DemoTradeMark[],
): { readonly equityQuoteWei: bigint | null; readonly unmarked: readonly Address[] } {
  const markBy = new Map(marks.map((mark) => [key(mark.token), mark.quoteOutWei]));
  const unmarked: Address[] = [];
  let equity = state.cashQuoteWei;
  for (const position of state.positions) {
    const quoteOutWei = markBy.get(key(position.token));
    if (quoteOutWei === undefined) {
      unmarked.push(position.token);
      continue;
    }
    equity += quoteOutWei;
  }
  return { equityQuoteWei: unmarked.length > 0 ? null : equity, unmarked };
}

function key(token: Address): string {
  return token.toLowerCase();
}
