"use client";

import { useState } from "react";
import { txUrl, type TradeDcaActionView, type TradeView } from "@/lib/trade";
import { relativeTime } from "@/lib/exec/agent-detail";

type Run = TradeView["runs"][number];
/**
 * Operator hotfix 2026-10-07: a paper meme cycle (reason `meme-...`) never reaches the executor. Its paper buy (`buy`/`meme-paper-entry`) and paper sell
 * (`sell`/`meme-exit:<code>`) are its trades, its model answers are `entry-llm`/`meme-llm:<answer>`, and a failure is a data, Binance or step failure.
 */
const isPaperEvent = (event: { stage: string; code: string }): boolean => event.stage === "buy" && event.code === "meme-paper-entry" || event.stage === "sell" && event.code.startsWith("meme-exit:");
const MEME_FAILED = new Set(["meme-step-failed", "meme-unreachable", "meme-unparseable", "meme-llm:invalid", "meme-llm:timeout"]);
const MEME_LLM_ANSWERS = new Set(["meme-llm:buy_now", "meme-llm:wait", "meme-llm:reject"]);
const memeFailedCode = (code: string): boolean => MEME_FAILED.has(code) || code.startsWith("meme-refused:") || code.startsWith("meme-data:") && code !== "meme-data:no-candidates";
function memeRunFailed(run: Run): boolean {
  return memeFailedCode(run.reason.split(";")[0] ?? "") || (run.events ?? []).some((event) => event.stage === "route" && memeFailedCode(event.code));
}
export function hasExecutedTrade(run: Run): boolean {
  if (run.dryRun) return false;
  // Entry counts are attempts; route selection and executor denials are not trades.
  return (run.events ?? []).some((event) => (event.stage === "buy" || event.stage === "sell") && event.code === "committed" || isPaperEvent(event))
    || run.exits > 0 || run.reason.split(";")[0] === "entered";
}

/**
 * AGENT-GAS-ATTENTION §5 — which bucket a trade CYCLE belongs to.
 *
 * A trade run is not a sequence, so the LP classifier does not transfer: most
 * cycles legitimately do nothing at all (nothing passed screening, the LLM
 * chose to wait) and calling those "failed" would bury the ones that actually
 * broke. So:
 *
 *   succeeded — something was committed on chain (a buy or a sell landed);
 *   failed    — the cycle tried and could not: an agent error, a refused
 *               entry, a route it could not build, or a wallet that could not
 *               pay for gas;
 *   quiet     — it ran, decided to do nothing, and that was correct.
 *
 * `quiet` is visible under "All cycles" and under neither of the two buckets,
 * which is the same three-way shape the LP log takes and for the same reason.
 */
export type RunOutcome = "succeeded" | "failed" | "quiet";

const FAILED_CODES = new Set([
  "agent-error", "no-route", "entry-budget-too-small", "llm-invalid", "llm-unavailable",
  // TradFi v2 cycle outcomes (2026-09-20): the cycle could not run, not "chose to wait".
  "settlement-price-unavailable", "data-plane-unavailable", "cost-unavailable", "quote-meter-unavailable",
  "data-budget-unavailable", "receipt-unverified",
]);

/**
 * A cycle that REACHED the executor and did not commit.
 *
 * REVIEW FINDING 7: the first build classified only on the run's summary
 * `reason`, so a buy denied `DAILY_CAP` and a refused sell both landed under
 * "quiet" — the two cycles most worth finding, filed as "nothing happened".
 * The events carry the truth: a `buy`/`sell` stage that ended on anything but
 * `committed` is an attempt that failed.
 */
function hasFailedExecution(run: Run): boolean {
  return (run.events ?? []).some(
    (event) => (event.stage === "buy" || event.stage === "sell") && event.code !== "committed" && !isPaperEvent(event),
  );
}

/**
 * REVIEW 2 — the buckets are PREDICATES, not a single label, because one trade
 * cycle can genuinely be both.
 *
 * A cycle that committed a sell AND had its buy refused `DAILY_CAP` returned
 * `"succeeded"` under the first build, so the refusal — the actionable half —
 * vanished from Failed. Forcing a total order on a cycle that did two things
 * means one of them is always hidden. A run may now appear under BOTH filters,
 * which is what actually happened.
 */
export function runSucceeded(run: Run): boolean {
  return !run.dryRun && hasExecutedTrade(run);
}

/**
 * Operator 2026-10-02: a TradFi v2 attempt that did not commit writes no
 * `buy`/`sell` event, only its executor outcome as the cycle reason: `unknown`
 * (held for reconciliation), `portfolio-submission-unknown`, or an UPPER_SNAKE
 * executor code (`RELAY_PREPARE_REFUSED`, `SIMULATION_FAILED`, `NATIVE_RESERVE`,
 * `DAILY_CAP`, ...). Those cycles tried and could not, so they belong in Failed.
 */
function isExecutorFailureCode(code: string): boolean {
  return code === "unknown" || code === "portfolio-submission-unknown" || /^[A-Z][A-Z0-9_]+$/u.test(code);
}

export function runFailed(run: Run): boolean {
  if (run.dryRun) return false;
  if (hasFailedExecution(run) || memeRunFailed(run)) return true;
  const code = run.reason.split(";")[0] ?? run.reason;
  // The gas gate reports its remedy sentence rather than a code, and a cycle
  // the worker stood down is a cycle that could not run.
  return FAILED_CODES.has(code) || code.startsWith("agent-error") || /^Deposit /u.test(run.reason) || isExecutorFailureCode(code);
}

export function runOutcome(run: Run): RunOutcome {
  // Retained for callers that want ONE label; the filters use the predicates,
  // and where a cycle is both, failure is the half worth surfacing.
  if (runFailed(run)) return "failed";
  return runSucceeded(run) ? "succeeded" : "quiet";
}

/**
 * DCA-DETAIL §4 — the root cause: a DCA cycle's events carry only
 * `{stage:"cycle", code:<reason>}`, never a `buy`/`sell` `committed` event, so
 * `hasExecutedTrade`/`runSucceeded`/`runFailed` classify every DCA run as
 * "quiet". These two predicates classify by the reason CODE instead.
 */
const DCA_SUCCEEDED = new Set(["dca-placed", "dca-level-filled", "dca-round-closed", "dca-removed", "dca-stopped",
  // AGENTIC-DCA 4.6
  "dca-base-bought", "dca-orders-cancelled"]);
const DCA_QUIET = new Set([
  "dca-disabled", "dca-action-in-flight", "dca-waiting", "dca-resumed", "dca-retry-backoff", "dca-uneconomic",
  "dca-trigger-not-reached", "dca-below-range", "dca-above-range", "dca-cash-low", "dca-cap-exhausted",
  "dca-native-cap-exhausted", "dca-removing:sale-backoff", "dca-removing:waiting-for-an-unknown-mint", "dca_round_changed", "dry-run", "session-expired", "session-expiring",
  // mirror of src/trade/dcaExecute.ts:339-341 DCA_HOLD_CODES (a denial that is a hold, not a failure)
  "NATIVE_RESERVE", "QUOTE_DAILY_CAP", "GUARD_QUOTE_EXPIRED", "dca_key_conflict", "halted", "paused", "not_executable",
  // AGENTIC-DCA 4.6 and R22.2: waits and a held take profit, not failures (the held-order codes stay failed)
  "dca-watching", "dca-quote-short", "dca-cooldown", "dca-cancelling", "dca-stopping", "dca-winding-down", "dca-low-bnb", "dca-quota-low", "dca-settings-hold", "dca-binance-throttled", "dca-agentic-off", "dca-tp-stale",
]);
export function dcaRunSucceeded(run: Run): boolean {
  if (run.dryRun) return false;
  const code = run.reason.split(";")[0] ?? "";
  const protective = !run.reason.includes(";");
  return DCA_SUCCEEDED.has(code) || (protective && (code === "dca-stop-loss" || code === "dca-removing"));
}
export function dcaRunFailed(run: Run): boolean {
  if (run.dryRun || dcaRunSucceeded(run)) return false;
  const code = run.reason.split(";")[0] ?? "";
  if (DCA_QUIET.has(code) || code.endsWith(":waiting-for-an-in-flight-submission")) return false;
  // a strategy-phase "dca-stop-loss"/"dca-removing" is the closing-round state note (worker.ts:3155-3156), not a submit
  if (code === "dca-stop-loss" || code === "dca-removing") return false;
  return true; // every other code is a real failure, including unknown executor codes (fail-visible)
}

/** Event codes that are an actual model answer (not transport, not "no trigger"). */
const LLM_DECISION_CODES = new Set(["enter", "llm-veto", "final-below-threshold", "exit", "hold", "hold-guard", "selected", "below-confidence"]);
/** Per-cycle bookkeeping that buries the decisions; shown under "Other events". */
const NOISE_CODES = new Set(["request", "response", "no-trigger", "feature-ready", "feature-partial", "feature-missing"]);

export function hasLlmDecision(run: Run): boolean {
  return (run.events ?? []).some((event) => event.stage.endsWith("llm") && LLM_DECISION_CODES.has(event.code) || event.stage === "entry-llm" && MEME_LLM_ANSWERS.has(event.code));
}

/** V3 cycles log one `score` event per candidate; summarise those instead of the routeable count. */
export function runSummary(run: Run): string {
  // Entry-timing events share the "score" stage but are not candidates scored.
  const scores = (run.events ?? []).filter((event) => event.stage === "score" && !event.code.startsWith("timing:"));
  // Operator hotfix 2026-10-06: a paper meme cycle's `candidates` counts the memes that reached the model, not the data plane's shortlist.
  if (scores.length === 0 && run.reason.startsWith("meme-")) return `${run.candidates} sent to the model after every check · ${run.entries} paper entries · ${run.exits} paper exits`;
  if (scores.length === 0) return `${run.candidates} shortlisted · ${run.entries} buy attempts · ${run.exits} closed · ${run.refusals} skipped/refused`;
  const passed = scores.filter((event) => event.code === "shortlisted" || event.code === "strong").length;
  const vetoed = scores.filter((event) => event.code.startsWith("vetoed")).length;
  const noData = scores.filter((event) => event.code === "insufficient-evidence").length;
  return `${scores.length} scored · ${passed} passed · ${vetoed} vetoed · ${noData} no data · ${run.entries} bought · ${run.exits} closed`;
}

type RunEvent = NonNullable<Run["events"]>[number];
export type TradeCard = {
  readonly side: "buy" | "sell";
  readonly runId: string;
  readonly createdAt: number;
  readonly token: string | null;
  readonly detail: string | null;
  readonly score: RunEvent | null;
  readonly llm: RunEvent | null;
  /** Sells only: the exit trigger that woke the exit model ("trigger:<name>"). */
  readonly trigger: RunEvent | null;
  /** Every route event for the bought token, in order (aggregator refusals, then the selection). */
  readonly routes: readonly RunEvent[];
  /** A paper meme buy or sell (hotfix 2026-10-07): no transaction, the model answer carries no text. */
  readonly paper?: true;
};

/** "Filled via the Binance aggregator guard" vs "direct AMM", with why the aggregator was not used. */
export function routeLine(routes: readonly RunEvent[]): string | null {
  if (routes.length === 0) return null;
  const selected = [...routes].reverse().find((event) => event.code !== "binance-refused") ?? null;
  const refused = routes.filter((event) => event.code === "binance-refused").map((event) => event.reason ?? "refused");
  const via = selected === null ? "no route selected"
    : selected.code === "binance-guard" ? "Binance aggregator through the guard"
    : selected.code === "binance-rfq" ? "Binance aggregator (RFQ)"
    : `direct AMM (${selected.code.replace(/_/gu, " ")})`;
  return `Route: ${via}${refused.length === 0 ? "" : ` · aggregator refused: ${[...new Set(refused)].join(", ")}`}`;
}

/** One card per committed buy or sell, with the score / exit trigger and the model's reason for that token (operator 2026-09-24: Trades shows buys and sells). */
export function tradeCards(runs: readonly Run[]): readonly TradeCard[] {
  return runs.flatMap((run): TradeCard[] => {
    if (run.dryRun) return [];
    const events = run.events ?? [];
    const same = (event: RunEvent, token: string | null) => token !== null && event.token?.toLowerCase() === token.toLowerCase();
    const forToken = (token: string | null, stage: string, codes: readonly string[]) =>
      events.find((event) => event.stage === stage && codes.includes(event.code) && same(event, token)) ?? null;
    const routesFor = (token: string | null) => events.filter((event) => event.stage === "route" && same(event, token));
    if (events.some(isPaperEvent)) return events.filter(isPaperEvent).map((event): TradeCard => {
      const token = event.token ?? null, sell = event.stage === "sell";
      return { side: sell ? "sell" : "buy", runId: run.id, createdAt: run.createdAt, token, detail: sell ? runLabel(event.code).replace(/^Paper exit: /u, "") : null, score: null,
        llm: sell ? null : forToken(token, "entry-llm", ["meme-llm:buy_now"]), trigger: null, routes: [], paper: true };
    });
    const sells = events.filter((event) => event.stage === "sell" && event.code === "committed").map((sell): TradeCard => {
      const token = sell.token ?? null;
      return { side: "sell", runId: run.id, createdAt: run.createdAt, token, detail: sell.reason ?? null, score: null,
        llm: forToken(token, "exit-llm", ["exit"]),
        trigger: events.find((event) => event.stage === "exit-llm" && event.code.startsWith("trigger:") && same(event, token)) ?? null, routes: [] };
    });
    const buy = (token: string | null, detail: string | null): TradeCard => ({ side: "buy", runId: run.id, createdAt: run.createdAt, token, detail,
      score: forToken(token, "score", ["strong", "shortlisted"]), llm: forToken(token, "entry-llm", ["enter", "selected"]), trigger: null, routes: routesFor(token) });
    const buys = events.filter((event) => event.stage === "buy" && event.code === "committed");
    if (buys.length > 0) return [...sells, ...buys.map((event) => buy(event.token ?? null, event.reason ?? null))];
    // Cycles recorded before the buy event existed: the summary still says a buy committed.
    if ((run.reason.split(";")[0] ?? "") !== "entered") return sells;
    const route = [...events].reverse().find((event) => event.stage === "route" && event.token !== undefined) ?? null;
    return [...sells, buy(route?.token ?? null, null)];
  });
}

/** Readable text for the robot exit rule events (`rule:would-exit:<rule>`, `rule:exit:<rule>`, `rule:peak-implausible`); other codes keep the generic words. */
export function eventLabel(code: string): string {
  const rule = /^rule:(would-exit|exit):(trailing-stop|stale-exit)$/u.exec(code);
  if (rule !== null) return `Robot exit rule ${rule[1] === "exit" ? "sells" : "would sell"}: ${rule[2] === "stale-exit" ? "stale position" : "trailing stop"}`;
  if (code === "rule:peak-implausible") return "Robot exit rule skipped: the recorded peak is implausible";
  // Jev benchmark (operator 2026-10-07, display only): the Jev shadow's answer beside the model's; it never decides.
  if (code.startsWith("meme-jev:")) return `Jev (shadow): ${code.slice("meme-jev:".length).replace(/_/gu, " ")}`;
  return code.replace(/[-_]/gu, " ");
}

function scoreLine(event: RunEvent): string {
  const reason = event.reason ?? "";
  const score = /score=(-?[\d.]+)/u.exec(reason)?.[1];
  const parts = reason.replace(/score=-?[\d.]+\s*/u, "").replace(/active=[\d.]+\s*/u, "").trim();
  return `Score ${score ?? "?"}${event.code === "strong" ? " (strong)" : ""}${parts === "" ? "" : ` · ${parts}`}`;
}

export function runLabel(reason: string, readOnly = false): string {
  const code = reason.split(";")[0] ?? reason;
  const labels: Record<string, string> = {
    "score-hold": "No candidate passed the score",
    "agentic-earn": "Earn on idle USDT",
    "timing-defer": "Entry deferred: waiting for a better entry",
    "buy-pacing": "Waiting: the last buy was under 5 minutes ago",
    "at-capacity": "All position slots occupied", "no-route": "No usable buy route",
    "entered": "Buy execution committed", "llm-hold": "LLM chose to wait",
    "no-candidates": "No candidates passed screening", "llm-invalid": "LLM response rejected",
    "llm-unavailable": "LLM unavailable", "draining": "Closing positions",
    "entry-budget-too-small": "Entry budget cannot cover fees", "dry-run": "Simulation completed",
    "session-expired": "Session expired — nothing can execute",
    "session-expiring": "No new entries — session ends soon",
    "settlement-price-unavailable": "USDT price unavailable — cycle skipped", "data-plane-unavailable": "Data plane unavailable — cycle skipped",
    "cost-unavailable": "Relay cost quote unavailable", "quote-meter-unavailable": "On-chain USDT meter unreadable",
    "data-budget-unavailable": "CMC data reservation unreadable",
    "schedule-token-not-granted": "Schedule token is not granted",
    "schedule-token-unquotable": "Schedule token did not quote",
    "schedule-market-closed": "Postponed: US market closed",
    "schedule-premium-too-high": "Postponed: NAV premium too high",
    "schedule-rwa-stale": "Postponed: stock reference is stale",
    "schedule-rwa-unavailable": "Postponed: stock reference unavailable",
    "schedule-issuer-not-trading": "Postponed: issuer is not trading",
    "schedule-venue-stale": "Postponed: on-chain venue quote is stale",
    "schedule-premium-unknown": "Postponed: NAV premium is unknown",
    "schedule-no-route": "Postponed: no buy route",
    "schedule-cash-low": "Postponed: USDT balance is low",
    "schedule-cap-exhausted": "Postponed: USDT cap is exhausted",
    "schedule-pending-intent": "Waiting for the previous buy",
    "schedule-slot-filled": "This schedule slot is filled",
    // R2.10 (LOW-7): the fenced race denial — a competing buy took this cycle's slot first.
    "schedule_slot_taken": "Skipped: this cycle was already bought",
    "schedule-not-started": "Schedule has not started",
    "schedule-finished:budget": "Finished — budget spent",
    "schedule-finished:runs": "Finished — run count reached",
    "schedule-finished:date": "Finished — end date reached",
    "portfolio-disabled": "Smart Portfolio is off",
    "portfolio-token-not-granted": "A selected stock is not granted",
    "portfolio-pending-intent": "Waiting for a rebalance trade",
    "portfolio-submission-unknown": readOnly ? "A trade's outcome is unknown; the agent waits."
      : "A trade's outcome is unknown; the agent waits. Pause and Remove stay available and your funds stay in this wallet.",
    "portfolio-held": "Already checked this interval — no rebalance",
    "portfolio-done": "Rebalance check complete",
    "portfolio-hold": "Checked — drift stayed below the threshold",
    "portfolio-empty": "Waiting for portfolio capital",
    "portfolio-quote-unavailable": "A stock value cannot be quoted",
    "portfolio-legs-too-small": "Trades below the minimum trade size are skipped",
    "portfolio-rebalanced": "Rebalance complete",
    "portfolio-sold": "Rebalancing — sold a stock",
    "portfolio-bought": "Rebalancing — bought a stock",
    "portfolio-no-route": "No usable rebalance route",
    "AGENTIC_QUOTE_REFUSED": "Binance refused the quote (the trade may be below its minimum size)",
    "binance-rejected": "Binance rejected the order",
    "portfolio-refused": "Stock rebalance route or budget refused",
    "portfolio-capital-used": "Total capital is already invested",
    "portfolio-cap-exhausted": "USDT day cap is exhausted",
    "portfolio-cash-low": "Wallet USDT is too low for a trade",
    "portfolio-rwa-unavailable": "Stock reference unavailable",
    "portfolio-rwa-stale": "Stock reference is stale",
    "portfolio-issuer-not-trading": "Issuer is not trading",
    "portfolio-venue-stale": "Stock venue quote is stale",
    "portfolio-premium-unknown": "Stock premium is unknown",
    "portfolio-premium-too-high": "Stock premium is too high",
    "portfolio_leg_taken": "This stock was already traded in this slot",
    "portfolio_slot_changed": "The check interval changed before submission",
    "portfolio_capital_exhausted": "Total capital was used before submission",
    "portfolio_submission_unknown": "An earlier trade's outcome is unknown",
    "portfolio_pending_intent": "An earlier trade is still settling",
    "portfolio_slot_held": "This interval is held",
    "portfolio_slot_done": "This interval is complete",
    "portfolio-replan": "Portfolio changed during the check; planning again",
    "portfolio-dry-run": "Portfolio simulation only",
    "portfolio-proof-conflict": "Sale proof belongs to another trade",
    "settings_changed": "Settings changed before submission",
    "session_changed": "Session changed before submission",
    "entry_budget_changed": "USDT funding changed before submission",
    "paused": "Agent paused before submission",
    "NATIVE_RESERVE": "BNB relay reserve is too low",
    "QUOTE_DAILY_CAP": "USDT day cap is exhausted",
    // AUTO-DCA §14.3 item 6: every reason the DCA worker writes (A2 decision 21).
    "dca-disabled": "Auto DCA is off — only exits run",
    "dca-action-in-flight": "Waiting for the previous batch",
    "dca-submission-unknown": "Held: a batch's outcome is unknown",
    "dca-waiting": "Waiting for the price",
    "dca-resumed": "Resumed after the stop loss",
    "dca-retry-backoff": "Backing off after failed batches",
    "dca-retry-exhausted": "Held after repeated failed batches — pause and resume, edit, or Remove",
    "dca-round-unreliable": "Held: this round cannot be measured",
    "dca-collected-elsewhere": "Held: an order was collected to another address",
    "dca-order-mismatch": "Held: an order does not match the chain",
    "dca-quote-deficit": "Held: the batch could not be funded or priced",
    "dca-plan-refused": "Held: the batch could not be built",
    "dca-uneconomic": "Waiting: a round would cost more gas than it earns",
    "GUARD_QUOTE_EXPIRED": "Price quote expired before sending — retrying",
    "dca-trigger-not-reached": "Waiting: trigger price not reached",
    "dca-below-range": "Waiting: price is below your range",
    "dca-above-range": "Waiting: price is above your range",
    "dca-cash-low": "Waiting: USDT balance is low",
    "dca-cap-exhausted": "Waiting: USDT cap is exhausted",
    "dca-native-cap-exhausted": "Waiting: the BNB day cap is exhausted",
    "dca-no-route": "No usable buy route",
    "dca-placed": "Orders placed",
    "dca-level-filled": "DCA order filled",
    "dca-round-closed": "Round closed",
    "dca-stop-loss": "Stop loss: pulling every order",
    "dca-stop-loss:waiting-for-an-in-flight-submission": "Stop loss waiting for an in-flight submission",
    "dca-stopped": "Stopped by the stop loss",
    "dca-removing": "Removing: pulling every order back to the wallet",
    "dca-removing:waiting-for-an-in-flight-submission": "Remove waiting for an in-flight submission",
    "dca-removing:waiting-for-an-unknown-mint": "Remove waiting for an unknown batch to expire (up to 10 minutes)",
    "dca-removing:sale-backoff": "Removing: the sale is backing off after failures",
    "dca-removing:cost-unavailable": "Removing: the sale cannot be priced yet",
    "dca-removed": "Removed — every order is back in the wallet",
    "dca-receipt-mismatch": "Held: a batch receipt did not match its plan",
    // AGENTIC-DCA 4.6 and R22.2: the Agentic lane's codes. The lane never emits dca-disabled, dca-retry-exhausted, dca-stop-loss or dca-removing*.
    "dca-base-bought": "Base order bought",
    "dca-orders-cancelled": "Term ended: nothing is left to fill",
    "dca-watching": "Watching the price",
    "dca-quote-short": "Price reached; the Binance quote is not good enough yet",
    "dca-cooldown": "Cooling down after the round",
    "dca-cancelling": "Cancelling orders",
    "dca-stopping": "Stop loss: waiting for the order in flight",
    "dca-winding-down": "Term ending: waiting for the order in flight",
    "dca-low-bnb": "Waiting: BNB for gas is low",
    "dca-quota-low": "Waiting: Binance daily quota is low",
    "dca-settings-hold": "Waiting: Binance settings changed",
    "dca-binance-throttled": "Waiting: Binance is rate limiting",
    "dca-agentic-off": "Agentic Auto DCA is off: only cancels run",
    "dca-order-held": "Held: an order needs review",
    "dca-unattributed-strategy": "Held: an order this agent did not place is open",
    "dca-list-incomplete": "Held: the order list could not be read completely",
    "dca-fill-above-level": "A buy filled above its level price",
    "dca-tp-stale": "Take profit left as placed while the agent is held",
    "dca-stop-cancel-unconfirmed": "Stop loss: a cancel is not confirmed yet; retrying every minute",
    "dca-no-tp": "Held: the round has no take profit order right now",
    // AGENTIC-MEME-STOCKS 9.4: the paper meme lane's closed codes. Paper trading: no code here is a real order.
    "meme-idle": "Paper: nothing to do this cycle",
    "meme-entered": "Paper entry recorded",
    "meme-paper-entry": "Paper entry recorded",
    "meme-ended": "Term ended: paper positions closed",
    "meme-off": "Meme entries are off: only paper exits run",
    "meme-entry-cutoff": "Entries closed for the rest of the term",
    "meme-draining": "Closing paper positions before term end",
    "meme-full": "Paper positions are full",
    "meme-loss-brake": "Paused entries: 24 h paper loss over 25 % of capital",
    "meme-day-cap": "Paper buys reached the day cap",
    "meme-exit-slow": "Exits took long this cycle: no entry",
    "meme-budget": "Cycle time budget used: the rest waits for the next cycle",
    "meme-no-candidate": "No meme passed the checks",
    "meme-step-failed": "The cycle failed; it runs again next minute",
    "meme-cost-measured": "Round-trip cost measured with two Binance quotes",
    "meme-data:shortlist": "Waiting: meme list unavailable or stale",
    "meme-data:no-candidates": "Waiting: no meme on the list",
    "meme-data:bars": "Waiting: price bars unavailable",
    "meme-data:universe": "Waiting: stock list unavailable",
    "meme-data:eligibility": "Waiting: launchpad check unavailable",
    "meme-data:gas-price": "Waiting: BNB price unavailable",
    "meme-veto:held": "Already held",
    "meme-veto:cooldown": "Cooling down after a recent paper trade",
    "meme-veto:refused-recently": "Binance refused a quote recently",
    "meme-veto:liquidity": "Too little liquidity for the trade size",
    "meme-veto:cost": "Price range too small for the round-trip cost",
    "meme-veto:eligibility": "Launchpad check failed",
    "meme-veto:token-version": "Unsupported token version",
    "meme-veto:decimals": "Unsupported token decimals",
    "meme-veto:no-exit-quote": "No sell quote: possible honeypot",
    "meme-veto:curve-funds": "Curve about to graduate: 80 % of its funds raised",
    "meme-llm:buy_now": "Model: buy now",
    "meme-llm:wait": "Model: wait",
    "meme-llm:reject": "Model: reject",
    "meme-llm:invalid": "Model answer invalid: no entry",
    "meme-llm:timeout": "Model timed out: no entry",
    "meme-exit:stop": "Paper exit: stop",
    "meme-exit:trailing": "Paper exit: trailing stop",
    "meme-exit:dead-chart": "Paper exit: dead chart",
    "meme-exit:smart-out": "Paper exit: smart money left",
    "meme-exit:flow-flip": "Paper exit: sellers took over",
    "meme-exit:time": "Paper exit: time limit",
    "meme-exit:drain": "Paper exit: closed on request",
    "meme-exit:ended": "Paper exit: term ended",
    "meme-throttled": "Waiting: Binance is rate limiting",
    "meme-wallet-busy": "Waiting: the wallet is busy",
    "meme-unreachable": "Binance unreachable",
    "meme-unparseable": "Binance answer unreadable",
  };
  // A DCA reason may carry a detail after ":" (`dca-plan-refused:<why>`); its label is the code's.
  return labels[code] ?? (code.startsWith("dca-") ? labels[code.split(":")[0] ?? ""] : undefined) ?? (code.startsWith("meme-refused:") ? "Binance refused the quote" : undefined) ?? code.replace(/[-_]/gu, " ");
}

/**
 * AUTO-DCA R4.8, as amended by the R4 audit (HIGH 1, ruled): up to 60 000 ms to
 * the loop's first poll, plus `DCA_COMMITTED_WAIT_MS` (600 000 ms, R4.2/`worker.ts`),
 * plus two 60 000 ms worker cycles to finish or re-sweep past it, plus one more
 * settle cycle, with margin. `stage` keeps its `inFlight` term (a ruled
 * deviation from review disposition #6(a): `done` relies on it to keep the
 * loop alive while a batch is still on its way to the chain).
 */
export const DCA_REMOVE_PATIENCE_MS = 900_000;

/**
 * R4.8: notes the loop must not quote as "Last plane note" — the four current
 * copy keys, plus the two legacy sale labels a pre-R4 round can still carry
 * (R4.7 keeps their labels; review Finding 12).
 */
const DCA_REMOVE_NOTE_EXCLUDED = new Set([
  "dca-removing", "dca-removing:waiting-for-an-in-flight-submission", "dca-removing:waiting-for-an-unknown-mint", "dca-removed",
  "dca-removing:sale-backoff", "dca-removing:cost-unavailable",
]);

/** AUTO-DCA R4.8: how far along a DCA Remove is, from the plane's own view — never an attempt count. */
export function dcaRemoveProgress(trade: TradeView): { readonly done: boolean; readonly stage: number; readonly message: string } {
  const dca = trade.dca;
  const round = dca?.round ?? null;
  const resting = round === null ? 0
    : round.levels.filter((level) => level.state === "resting").length + (round.tp !== null && round.tp.state === "resting" ? 1 : 0);
  const inFlight = dca?.inFlight ?? null;
  const stage = (round === null ? 0 : 1) + resting + (inFlight === null ? 0 : 1);
  const done = stage === 0 && trade.open.length === 0 && trade.pendingIntents.length === 0;
  const drainingAt = trade.lifecycle.drainingAt;
  // The newest protective row (no `;`) at or after the drain: `trade.runs` is newest-first (server.ts:5454).
  const note = drainingAt === null ? null
    : trade.runs.find((run) => !run.dryRun && !run.reason.includes(";") && run.createdAt >= drainingAt)?.reason ?? null;
  let message = inFlight !== null
    ? "Removing: the batch that pulls your orders back to the agent wallet is on its way to the chain…"
    : resting > 0
      ? `Removing: ${resting} order${resting === 1 ? "" : "s"} still on chain; the plane pulls them back to the agent wallet on its next cycle…`
      : round !== null
        ? "Removing: every order is back in the agent wallet; the plane is closing the round…"
        : "Removing: waiting for the plane…";
  if (note === "dca-removing:waiting-for-an-unknown-mint") {
    message += " An earlier batch's outcome is unknown; the plane waits up to 10 minutes for it to expire.";
  } else if ((dca?.unknownAction ?? null) !== null) {
    message += " One batch's outcome is unknown; it does not stop Remove.";
  }
  if (note !== null && !DCA_REMOVE_NOTE_EXCLUDED.has(note)) message += ` Last plane note: ${runLabel(note)}.`;
  return { done, stage, message };
}

/** A schedule agent has no model and no sells: a cycle either bought or postponed. */
const SCHEDULE_FILTERS: readonly (readonly [string, string])[] = [["all", "All cycles"], ["activity", "Succeeded"], ["postponed", "Postponed"]];
const TRADE_FILTERS: readonly (readonly [string, string])[] = [["all", "All cycles"], ["succeeded", "Succeeded"], ["failed", "Failed"], ["activity", "Trades"], ["llm", "LLM decisions"]];
/** DCA-DETAIL §4: a DCA agent has no model and its runs carry no tx, so "Trades" sources the action rows instead. */
const DCA_FILTERS: readonly (readonly [string, string])[] = [["all", "All cycles"], ["succeeded", "Succeeded"], ["failed", "Failed"], ["activity", "Trades"]];
const PORTFOLIO_FILTERS: readonly (readonly [string, string])[] = DCA_FILTERS;
const PORTFOLIO_QUIET = new Set([
  "portfolio-disabled", "portfolio-held", "portfolio-done", "portfolio-hold", "portfolio-empty", "portfolio-legs-too-small",
  "portfolio-pending-intent", "portfolio_pending_intent", "portfolio-capital-used", "portfolio-cap-exhausted", "portfolio-cash-low",
  "portfolio-replan", "portfolio-dry-run", "portfolio_leg_taken", "portfolio_slot_changed", "portfolio_slot_held", "portfolio_slot_done",
  "portfolio_capital_exhausted", "paused", "halted", "not_executable", "session-expired", "session-expiring", "dry-run",
  "settings_changed", "session_changed", "entry_budget_changed", "NATIVE_RESERVE", "QUOTE_DAILY_CAP", "GUARD_QUOTE_EXPIRED",
]);
function portfolioRunFailed(run: Run): boolean {
  if (run.dryRun) return false;
  if (runFailed(run) || (run.events ?? []).some((event) => event.stage === "screen" && ["portfolio-refused", "portfolio-proof-conflict"].includes(event.code))) return true;
  const code = run.reason.split(";")[0] ?? "";
  return !PORTFOLIO_QUIET.has(code) && !["portfolio-bought", "portfolio-sold", "portfolio-rebalanced"].includes(code);
}

/** DCA-DETAIL §4: one Trades card title per `DcaBatchKind`. */
const DCA_ACTION_TITLE: Readonly<Record<TradeDcaActionView["kind"], (roundNo: number) => string>> = {
  start: (roundNo) => `Round ${roundNo} started: base buy`,
  "close-start": (roundNo) => `Round ${roundNo} closed at take profit; round ${roundNo + 1} started`,
  close: (roundNo) => `Round ${roundNo} closed at take profit`,
  "level-place": () => "DCA order placed",
  fill: () => "DCA order filled; take profit moved",
  "tp-place": () => "Take profit placed",
  "stop-loss": () => "Stop loss: every order pulled",
  remove: () => "Remove: orders pulled",
};

export function TradeRunLog({ runs, symbols, schedule = false, portfolio = false, portfolioLegs, dca, readOnly = false }: { readonly runs: readonly Run[]; readonly symbols: Readonly<Record<string, string>>; readonly schedule?: boolean; readonly portfolio?: boolean;
  readonly portfolioLegs?: NonNullable<TradeView["portfolio"]>["legs"]; readonly readOnly?: boolean;
  readonly dca?: { readonly actions: readonly TradeDcaActionView[] | undefined } }) {
  const [filter, setFilter] = useState("all");
  const shown = runs.filter((run) => filter === "all"
    || (dca !== undefined ? (filter === "succeeded" ? dcaRunSucceeded(run) : filter === "failed" ? dcaRunFailed(run) : hasExecutedTrade(run))
    : filter === "llm" ? hasLlmDecision(run)
    : filter === "succeeded" ? runSucceeded(run)
    : filter === "failed" ? portfolio ? portfolioRunFailed(run) : runFailed(run)
    : filter === "postponed" ? !hasExecutedTrade(run)
    : hasExecutedTrade(run)));
  return <div className="fl-run-feed">
    <div className="fl-run-filters">{(dca !== undefined ? DCA_FILTERS : portfolio ? PORTFOLIO_FILTERS : schedule ? SCHEDULE_FILTERS : TRADE_FILTERS).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    <div className="fl-run-scroll" role="region" aria-label="Run history" tabIndex={0}>
    {portfolio && filter === "activity" ? portfolioLegs === undefined || portfolioLegs.some((leg) => leg.detail === undefined) ? <div className="fl-trade-empty">Needs the updated execution plane.</div>
      : portfolioLegs.filter((leg) => leg.detail?.executionState === "COMMITTED").length === 0 ? <div className="fl-trade-empty">No portfolio transactions recorded yet.</div>
        : portfolioLegs.filter((leg) => leg.detail?.executionState === "COMMITTED").map((leg) => <div className="fl-run-card is-open" key={leg.detail!.id}><div className="fl-run-detail">
          <div className="fl-run-meta"><strong>{leg.side === "buy" ? "Bought" : "Sold"} {leg.symbol}</strong></div>
          <p>{new Date(leg.createdAt).toLocaleString()} · {leg.slot === 0 ? "Initial allocation" : "Rebalance"}</p>
          <p>{txUrl(leg.txHash) ? <a href={txUrl(leg.txHash)!} target="_blank" rel="noreferrer">Tx ↗</a> : <span title="Transaction hash unavailable.">— · Transaction hash unavailable.</span>}</p>
        </div></div>)
      : dca !== undefined && filter === "activity" ? (() => {
      if (dca.actions === undefined) return <div className="fl-trade-empty">Needs the updated execution plane.</div>;
      const cards = dca.actions.filter((action) => action.state === "committed" || action.state === "finished");
      return cards.length === 0
        ? <div className="fl-trade-empty">No DCA transactions yet.</div>
        : cards.map((action) => <div className="fl-run-card is-open" key={`${action.roundNo}:${action.kind}:${action.txHash}`}>
          <div className="fl-run-detail">
            <div className="fl-run-meta"><strong>{DCA_ACTION_TITLE[action.kind](action.roundNo)}</strong></div>
            <p>Round {action.roundNo} · {new Date(action.createdAt).toLocaleString()} · {action.state === "committed" ? "landed, booking" : "booked"}</p>
            {txUrl(action.txHash) === null ? null : <p><a href={txUrl(action.txHash)!} target="_blank" rel="noreferrer">Tx ↗</a></p>}
          </div>
        </div>);
    })() : !schedule && !portfolio && dca === undefined && filter === "activity" ? (() => {
      const cards = tradeCards(runs);
      const name = (token: string | null) => token === null ? "token" : symbols[token.toLowerCase()] ?? `${token.slice(0, 6)}…${token.slice(-4)}`;
      return cards.length === 0
        ? <div className="fl-trade-empty">{runs.length === 0 ? "No runs yet." : `No buys or sells in the latest ${runs.length} cycles.`}</div>
        : cards.map((card) => <div className="fl-run-card is-open" key={`${card.runId}:${card.side}:${card.token ?? "-"}`}>
          <div className="fl-run-detail">
            <div className="fl-run-meta"><strong>{card.paper ? "Paper " + (card.side === "sell" ? "sold" : "bought") : card.side === "sell" ? "Sold" : "Bought"} {name(card.token)}</strong>{card.detail ? ` · ${card.side === "sell" && card.paper !== true ? card.detail.replace(/-/gu, " ") : card.detail}` : ""} · <time title={new Date(card.createdAt).toISOString()}>{new Date(card.createdAt).toLocaleString()}</time></div>
            {routeLine(card.routes) === null ? null : <p>{routeLine(card.routes)}</p>}
            {card.score ? <p>{scoreLine(card.score)}</p> : null}
            {card.trigger ? <p>Exit trigger: {card.trigger.code.slice("trigger:".length).replace(/-/gu, " ")}</p> : null}
            {card.paper ? <p>{card.side === "sell" ? "Rule exit: no model decision for a paper sell." : card.llm ? `Model: buy now${card.llm.confidence === undefined ? "" : `, ${card.llm.confidence}% confidence`}${card.llm.model ? ` (${card.llm.model})` : ""}` : "No model answer was recorded for this paper buy."} No transaction: paper trade.</p>
            : card.llm ? <p><strong>Why (LLM{card.llm.model ? `: ${card.llm.model}` : ""}{card.llm.confidence === undefined ? "" : `, ${card.llm.confidence}% confidence`})</strong> {card.llm.reason ?? "—"}</p>
              : <p>{card.side === "sell" ? "Rule exit — no model decision was recorded for this sell." : "No model reason was recorded for this buy."}</p>}
          </div>
        </div>);
    })() : shown.map((run) => <details className="fl-run-card" key={run.id}>
      <summary><span className={`fl-run-dot ${(dca !== undefined ? dcaRunSucceeded(run) : run.entries > 0 || run.exits > 0) ? "is-active" : ""}`} /><div><strong>{runLabel(run.reason, readOnly)}</strong><p>{runSummary(run)}{run.dryRun ? " · simulation" : ""}</p></div><time title={new Date(run.createdAt).toISOString()}>{relativeTime(run.createdAt, Date.now()).text}</time><span aria-hidden="true">⌄</span></summary>
      <div className="fl-run-detail"><div className="fl-run-meta">{new Date(run.createdAt).toLocaleString()} · Run {run.id}</div>
        {(run.events?.length ?? 0) > 0 ? <><ol>{run.events!.filter((event) => !NOISE_CODES.has(event.code)).map((event, i) => <li key={i}>
          <span className="fl-run-stage">{event.stage.replace(/-/gu, " ")} <small>+{(event.elapsedMs / 1000).toFixed(1)}s</small></span>
          <div><strong>{eventLabel(event.code)}</strong>{event.token ? <span title={event.token}> · {symbols[event.token.toLowerCase()] ?? `${event.token.slice(0, 6)}…${event.token.slice(-4)}`}</span> : null}{event.confidence === undefined ? null : <span className="fl-run-confidence">{event.confidence}% {event.code.startsWith("meme-jev:") ? "buy" : "confidence"}</span>}
            {event.model ? <small className="fl-run-model">{event.code.startsWith("meme-jev:") ? "Jev model" : "LLM model"}: {event.model}</small> : null}{event.reason ? <p>{event.reason}</p> : null}</div>
        </li>)}</ol>
        {run.events!.some((event) => NOISE_CODES.has(event.code)) ? <details className="fl-run-raw"><summary>Other events ({run.events!.filter((event) => NOISE_CODES.has(event.code)).length})</summary>
          <ul>{run.events!.filter((event) => NOISE_CODES.has(event.code)).map((event, i) => <li key={i}>{event.stage.replace(/-/gu, " ")} · {event.code.replace(/[-_]/gu, " ")}{event.token ? ` · ${symbols[event.token.toLowerCase()] ?? `${event.token.slice(0, 6)}…${event.token.slice(-4)}`}` : ""}</li>)}</ul>
        </details> : null}</> : <p>Historical cycle: only summary counts were recorded. Detailed LLM and route events are available for new cycles.</p>}
        <details className="fl-run-raw"><summary>Raw summary</summary><code>{run.reason}</code></details>
      </div>
    </details>)}
    {shown.length === 0 && (schedule || filter !== "activity") ? <div className="fl-trade-empty">{runs.length === 0 ? "No runs yet." : filter === "activity" ? `No executed trades in the latest ${runs.length} cycles.` : "No matching cycles in this history."}</div> : null}
    </div>
  </div>;
}
