// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TradeDcaActionView, TradeDcaView, TradeView } from "@/lib/trade";
import { DCA_REMOVE_PATIENCE_MS, TradeRunLog, dcaRemoveProgress, tradeCards, dcaRunFailed, dcaRunSucceeded, hasExecutedTrade, hasLlmDecision, routeLine, runFailed, runLabel, runSucceeded, runSummary } from "./TradeRunLog";

// The exact §2.2 reason set (worker.ts's `runTradfiScheduleEntry`), literal
// here as spec §10 allows, and also asserted against in
// `test/tradeSchedule.worker.test.ts`'s "every §2.2 refusal reason is reachable".
const SCHEDULE_REASONS = [
  "schedule-token-not-granted", "schedule-not-started", "schedule-slot-filled", "schedule-pending-intent",
  "schedule-market-closed", "schedule-rwa-unavailable", "schedule-rwa-stale", "schedule-issuer-not-trading",
  "schedule-venue-stale", "schedule-premium-unknown", "schedule-premium-too-high", "schedule-cash-low",
  "schedule-cap-exhausted", "schedule-no-route", "schedule-finished:budget", "schedule-finished:runs", "schedule-finished:date",
];

/** AUTO-DCA R4.8: the minimal fixtures dcaRemoveProgress reads from. */
type DcaLevelView = NonNullable<TradeDcaView["round"]>["levels"][number];
function dcaLevel(state: DcaLevelView["state"], levelNo = 1): DcaLevelView {
  return { levelNo, levelPriceE8: null, state, tokenId: null, tickLower: 0, tickUpper: 0, closedBy: null, usdtWei: "0", stockWei: "0", txHash: null };
}
function dcaTp(state: string): NonNullable<NonNullable<TradeDcaView["round"]>["tp"]> {
  return { tokenId: null, tickLower: 0, tickUpper: 0, closedBy: null, usdtWei: "0", stockWei: "0", txHash: null, state, rangeLowE8: "0", rangeHighE8: "0" };
}
function dcaRound(patch: Partial<NonNullable<TradeDcaView["round"]>> = {}): NonNullable<TradeDcaView["round"]> {
  return { roundNo: 1, phase: "closing", closeCause: "remove", openedAt: 0, unreliable: false, p0E8: null, avgCostE8: null,
    tpTargetE8: null, costUsdtWei: "0", stockHeldWei: "0", realizedPnlWei: null, levels: [], tp: null, ...patch };
}
function dcaView(patch: Partial<TradeDcaView> = {}): TradeDcaView {
  return { token: "0xstock", symbol: "NVDAB", fee: 2500, usdtIsToken0: false,
    settings: { stepBps: 100, takeProfitBps: 150, baseWei: "0", orderWei: "0", maxOrders: 4, triggerE8: null, rangeMinE8: null, rangeMaxE8: null, stopLossBps: null },
    round: null, rounds: { settled: 0, realizedPnlWei: "0", lastSettledAt: null }, equity: null, wallet: null, reason: null,
    inFlight: null, unknownAction: null, ...patch };
}
function dcaTrade(dca: TradeDcaView, patch: Partial<TradeView> = {}): TradeView {
  return { settings: null, open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: true, holidaysModeled: false },
    summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: null, observedAt: null },
    lifecycle: { draining: true, drainingAt: 0 }, pendingIntents: [], dca, ...patch };
}

describe("dcaRemoveProgress (AUTO-DCA R4.8)", () => {
  it("DCA_REMOVE_PATIENCE_MS is 900 000 ms (audit HIGH 1, ruled)", () => {
    expect(DCA_REMOVE_PATIENCE_MS).toBe(900_000);
  });

  it("in flight, 3 resting ⇒ stage 5, message 1", () => {
    const round = dcaRound({ levels: [dcaLevel("resting", 1), dcaLevel("resting", 2)], tp: dcaTp("resting") });
    const dca = dcaView({ round, inFlight: { kind: "remove", state: "submitted", txHash: null } });
    const p = dcaRemoveProgress(dcaTrade(dca));
    expect(p.stage).toBe(5);
    expect(p.message).toContain("on its way to the chain");
  });

  it("3 resting, note not_executable ⇒ stage 4, message 2 + Last plane note", () => {
    const round = dcaRound({ levels: [dcaLevel("resting", 1), dcaLevel("resting", 2)], tp: dcaTp("resting") });
    const dca = dcaView({ round });
    const trade = dcaTrade(dca, { runs: [{ id: "r1", dryRun: false, reason: "not_executable", candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 5 }] });
    const p = dcaRemoveProgress(trade);
    expect(p.stage).toBe(4);
    expect(p.message).toContain("order");
    expect(p.message).toContain("still on chain");
    expect(p.message).toContain("Last plane note:");
  });

  it("closing, 0 resting, note dca-removing:waiting-for-an-unknown-mint ⇒ stage 1, message 3 + the unknown-wait suffix", () => {
    const round = dcaRound({ phase: "closing", levels: [], tp: null });
    const dca = dcaView({ round });
    const trade = dcaTrade(dca, { runs: [{ id: "r1", dryRun: false, reason: "dca-removing:waiting-for-an-unknown-mint", candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 5 }] });
    const p = dcaRemoveProgress(trade);
    expect(p.stage).toBe(1);
    expect(p.message).toContain("closing the round");
    expect(p.message).toContain("An earlier batch's outcome is unknown; the plane waits up to 10 minutes for it to expire.");
  });

  it("an unknownAction never blocks progress and appends the 'does not stop Remove' suffix", () => {
    const round = dcaRound({ levels: [dcaLevel("resting", 1), dcaLevel("resting", 2)], tp: null });
    const dca = dcaView({ round, unknownAction: { kind: "remove", actionKey: "dca:x:1:3", note: null } });
    const p = dcaRemoveProgress(dcaTrade(dca));
    expect(p.message).toContain("One batch's outcome is unknown; it does not stop Remove.");
  });

  it("no round, nothing in flight ⇒ done", () => {
    const dca = dcaView({ round: null });
    const p = dcaRemoveProgress(dcaTrade(dca, { open: [], pendingIntents: [] }));
    expect(p.done).toBe(true);
    expect(p.stage).toBe(0);
  });

  it("a protective row older than drainingAt is ignored", () => {
    const round = dcaRound({ levels: [], tp: null });
    const dca = dcaView({ round });
    const trade = dcaTrade(dca, { lifecycle: { draining: true, drainingAt: 100 },
      runs: [{ id: "old", dryRun: false, reason: "not_executable", candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 50 }] });
    const p = dcaRemoveProgress(trade);
    expect(p.message).not.toContain("Last plane note:");
  });
});

describe("schedule reason copy completeness", () => {
  it("has dedicated copy for every schedule-* reason the worker can emit", () => {
    for (const reason of SCHEDULE_REASONS) {
      const label = runLabel(reason);
      expect(label, reason).not.toBe(reason.replace(/[-_]/gu, " "));
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

it("renders legacy history honestly and new public model decisions as escaped text", () => {
  const html = renderToStaticMarkup(<TradeRunLog symbols={{}} runs={[
    { id: "old", dryRun: false, reason: "no-route;candidates=12", candidates: 12, entries: 0, exits: 0, refusals: 2, createdAt: 1000 },
    { id: "new", dryRun: false, reason: "entered", candidates: 2, entries: 1, exits: 0, refusals: 0, createdAt: 2000,
      events: [{ stage: "entry-llm", code: "selected", elapsedMs: 1200, model: "fixture", confidence: 90, reason: "<script>unsafe</script>" }] },
  ]} />);
  expect(html).toContain("No usable buy route");
  expect(html).toContain("Historical cycle: only summary counts were recorded.");
  expect(html).toContain("buy attempts");
  expect(html).toContain("90% confidence");
  expect(html).toContain("LLM model: fixture");
  expect(html).not.toContain("<script>unsafe</script>");
});

it("Trades includes real buy/sell outcomes and excludes candidates, refusals and simulations", () => {
  const run = { id: "run", dryRun: false, reason: "no-route", candidates: 12, entries: 0, exits: 0, refusals: 3, createdAt: 1000 };
  expect(hasExecutedTrade(run)).toBe(false);
  expect(hasExecutedTrade({ ...run, reason: "DAILY_CAP", entries: 1 })).toBe(false);
  expect(hasExecutedTrade({ ...run, events: [{ stage: "entry-llm", code: "selected", elapsedMs: 1 }] })).toBe(false);
  expect(hasExecutedTrade({ ...run, events: [{ stage: "buy", code: "denied", elapsedMs: 1 }] })).toBe(false);
  expect(hasExecutedTrade({ ...run, reason: "entered;candidates=12", entries: 1 })).toBe(true);
  expect(hasExecutedTrade({ ...run, exits: 1 })).toBe(true);
  expect(hasExecutedTrade({ ...run, events: [{ stage: "sell", code: "committed", elapsedMs: 1 }] })).toBe(true);
  expect(hasExecutedTrade({ ...run, dryRun: true, reason: "entered", entries: 1 })).toBe(false);
});

describe("portfolio run log", () => {
  const base = { candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 1000 };
  const runs: TradeView["runs"] = [
    { ...base, id: "success", dryRun: false, reason: "portfolio-bought", events: [{ stage: "buy", code: "committed", elapsedMs: 1 }] },
    { ...base, id: "quiet", dryRun: false, reason: "portfolio-held" },
    { ...base, id: "failed", dryRun: false, reason: "portfolio-quote-unavailable" },
    { ...base, id: "mixed", dryRun: false, reason: "portfolio-rebalanced", events: [{ stage: "sell", code: "committed", elapsedMs: 1 }, { stage: "screen", code: "portfolio-refused", elapsedMs: 2 }] },
    { ...base, id: "simulation", dryRun: true, reason: "portfolio-quote-unavailable", events: [{ stage: "buy", code: "committed", elapsedMs: 1 }] },
  ];
  it("offers exactly the DCA-style filters and separates success, failure, quiet and dry runs", async () => {
    const host = document.createElement("div"), root = createRoot(host);
    try {
      await act(async () => { root.render(<TradeRunLog runs={runs} symbols={{}} portfolio portfolioLegs={[]} />); });
      expect([...host.querySelectorAll(".fl-run-filters button")].map((button) => button.textContent)).toEqual(["All cycles", "Succeeded", "Failed", "Trades"]);
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Succeeded")!.click(); });
      expect(host.textContent).toContain("Run success");
      expect(host.textContent).toContain("Run mixed");
      expect(host.textContent).not.toContain("Run quiet");
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Failed")!.click(); });
      expect(host.textContent).toContain("Run failed");
      expect(host.textContent).toContain("Run mixed");
      expect(host.textContent).not.toContain("Run quiet");
    } finally { await act(async () => root.unmount()); }
  });

  it("shows only journal-committed portfolio legs as transaction cards", async () => {
    const token = "0x1111111111111111111111111111111111111111";
    const leg = (state: "COMMITTED" | "UNKNOWN") => ({ slot: 0, side: "buy" as const, token, symbol: "NVDAB", amountWei: "20",
      quotedOutAtomic: "1", minOutAtomic: "1", proceedsAtomic: null, state: "projected" as const, txHash: state === "COMMITTED" ? `0x${"aa".repeat(32)}` : null, createdAt: 1000,
      detail: { id: state, executionState: state, executionReason: null, quantityAtomic: null, quantityReason: "not-recorded" as const, quoteWei: "19", quoteReason: null } });
    const host = document.createElement("div"), root = createRoot(host);
    try {
      await act(async () => { root.render(<TradeRunLog runs={runs} symbols={{ [token]: "NVDAB" }} portfolio portfolioLegs={[leg("COMMITTED"), leg("UNKNOWN")]} />); });
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Trades")!.click(); });
      expect(host.textContent).toContain("Bought NVDAB");
      expect(host.querySelectorAll(".fl-run-card")).toHaveLength(1);
      expect(host.querySelector('a[href*="bscscan.com/tx/"]')).not.toBeNull();
      expect(host.textContent).not.toContain("LLM");
      await act(async () => { root.render(<TradeRunLog runs={runs} symbols={{}} portfolio portfolioLegs={undefined} />); });
      expect(host.textContent).toContain("Needs the updated execution plane");
    } finally { await act(async () => root.unmount()); }
  });
});

describe("AGENT-GAS-ATTENTION §5 / review 2: the Succeeded and Failed buckets", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: "r1", createdAt: 1, dryRun: false, candidates: 0, refusals: 0, entries: 0, exits: 0,
    reason: "no-candidates", events: [], ...over,
  }) as unknown as Parameters<typeof runSucceeded>[0];

  it("a cycle that BOTH sold and had a buy refused appears under both buckets", () => {
    // Review 2: this returned `succeeded` and the refusal — the actionable half
    // — vanished from Failed. A cycle that did two things cannot be one label.
    const mixed = run({ events: [
      { stage: "sell", code: "committed", elapsedMs: 1 },
      { stage: "buy", code: "DAILY_CAP", elapsedMs: 2 },
    ] });
    expect(runSucceeded(mixed)).toBe(true);
    expect(runFailed(mixed)).toBe(true);
  });

  it("a refused buy with no success is Failed only, and a quiet cycle is neither", () => {
    const refused = run({ events: [{ stage: "buy", code: "DAILY_CAP", elapsedMs: 1 }] });
    expect(runFailed(refused)).toBe(true);
    expect(runSucceeded(refused)).toBe(false);

    const quiet = run({ reason: "no-candidates;candidates=0" });
    expect(runFailed(quiet)).toBe(false);
    expect(runSucceeded(quiet)).toBe(false);
  });

  it("the gas stand-down reads as Failed, and a dry run as neither", () => {
    const gas = run({ reason: "Deposit at least 0.0001 BNB to 0xabc…" });
    expect(runFailed(gas)).toBe(true);

    const rehearsal = run({ dryRun: true, exits: 1, events: [{ stage: "sell", code: "committed", elapsedMs: 1 }] });
    expect(runSucceeded(rehearsal)).toBe(false);
    expect(runFailed(rehearsal)).toBe(false);
  });
});

describe("AGENT-GAS-ATTENTION review 3: the bucket predicates' controls", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: "r1", createdAt: 1, dryRun: false, candidates: 0, refusals: 0, entries: 0, exits: 0,
    reason: "no-candidates", events: [], ...over,
  }) as unknown as Parameters<typeof runSucceeded>[0];

  it("a purely SUCCESSFUL cycle is not Failed", () => {
    // Review 3: classifying committed trades as failures survived the earlier
    // suite, because nothing asserted the negative. A Failed filter that shows
    // every winning cycle is as useless as one that shows none.
    const won = run({ exits: 1, events: [{ stage: "sell", code: "committed", elapsedMs: 1 }] });
    expect(runSucceeded(won)).toBe(true);
    expect(runFailed(won)).toBe(false);

    const entered = run({ reason: "entered;candidates=3", events: [{ stage: "buy", code: "committed", elapsedMs: 1 }] });
    expect(runSucceeded(entered)).toBe(true);
    expect(runFailed(entered)).toBe(false);
  });

  it("a TradFi v2 attempt that did not commit is Failed: unknown outcome and executor codes", () => {
    // Operator 2026-10-02: the stuck MSTRB buy wrote only `unknown` as the cycle
    // reason (no buy event), so it never showed under Failed.
    for (const reason of ["unknown;candidates=12", "RELAY_PREPARE_REFUSED;candidates=12", "SIMULATION_FAILED",
      "NATIVE_RESERVE;candidates=3", "portfolio-submission-unknown"]) {
      expect(runFailed(run({ reason }))).toBe(true);
    }
    // Postponements and holds that merely contain "unknown" stay quiet.
    for (const reason of ["schedule-premium-unknown", "score-hold;candidates=12", "portfolio-premium-unknown", "paused"]) {
      expect(runFailed(run({ reason }))).toBe(false);
    }
    expect(runFailed(run({ dryRun: true, reason: "unknown" }))).toBe(false);
  });

  it("a DRY RUN is neither, even when it contains a refusal", () => {
    // A rehearsal that "failed" never risked anything; filing it under Failed
    // buries the live ones.
    const rehearsed = run({ dryRun: true, events: [{ stage: "buy", code: "DAILY_CAP", elapsedMs: 1 }] });
    expect(runFailed(rehearsed)).toBe(false);
    expect(runSucceeded(rehearsed)).toBe(false);
  });
});

it("labels the session backstop rows", () => {
  expect(renderToStaticMarkup(<TradeRunLog symbols={{}} runs={[
    { id: "expired", dryRun: false, reason: "session-expired", candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 1 },
    { id: "soon", dryRun: false, reason: "session-expiring", candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 2 },
  ]} />)).toContain("Session expired — nothing can execute");
  expect(renderToStaticMarkup(<TradeRunLog symbols={{}} runs={[
    { id: "soon", dryRun: false, reason: "session-expiring", candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 2 },
  ]} />)).toContain("No new entries — session ends soon");
});

describe("run log hotfix (2026-09-24): V3 cycles are readable", () => {
  const quiet = { id: "q", dryRun: false, reason: "score-hold;candidates=12", candidates: 12, entries: 0, exits: 0, refusals: 0, createdAt: 1000,
    events: [
      { stage: "score", code: "below-threshold", elapsedMs: 1, token: "0x1", reason: "score=7.8 active=1.00" },
      { stage: "score", code: "vetoed:extended-over-3atr", elapsedMs: 1, token: "0x2" },
      { stage: "score", code: "insufficient-evidence", elapsedMs: 1, token: "0x3" },
      { stage: "exit-llm", code: "no-trigger", elapsedMs: 1, token: "0x4" },
      { stage: "cmc", code: "regime:neutral", elapsedMs: 1 },
    ] };
  it("LLM decisions ignores no-trigger and transport events, and keeps real model answers", () => {
    expect(hasLlmDecision(quiet)).toBe(false);
    expect(hasLlmDecision({ ...quiet, events: [{ stage: "exit-llm", code: "request", elapsedMs: 1 }, { stage: "exit-llm", code: "response", elapsedMs: 1 }] })).toBe(false);
    expect(hasLlmDecision({ ...quiet, events: [{ stage: "exit-llm", code: "hold", elapsedMs: 1, reason: "within spread" }] })).toBe(true);
    expect(hasLlmDecision({ ...quiet, events: [{ stage: "entry-llm", code: "enter", elapsedMs: 1, confidence: 78 }] })).toBe(true);
    expect(hasLlmDecision({ ...quiet, events: [{ stage: "exit-llm", code: "hold-guard", elapsedMs: 1 }] })).toBe(true);
  });
  it("summarises the score instead of the routeable count, and names score-hold", () => {
    expect(runSummary(quiet)).toBe("3 scored · 0 passed · 1 vetoed · 1 no data · 0 bought · 0 closed");
    expect(runLabel(quiet.reason)).toBe("No candidate passed the score");
    expect(runLabel("buy-pacing")).toBe("Waiting: the last buy was under 5 minutes ago");
  });
  it("moves bookkeeping events under Other events", () => {
    const html = renderToStaticMarkup(<TradeRunLog runs={[quiet]} symbols={{ "0x4": "NVDAB" }} />);
    expect(html).toContain("Other events (1)");
    expect(html).toContain("no trigger · NVDAB");
  });
});

describe("Trades = one card per buy and sell with the reason (2026-09-24)", () => {
  const bought = { id: "b", dryRun: false, reason: "entered;candidates=12", candidates: 12, entries: 1, exits: 1, refusals: 0, createdAt: 2000,
    events: [
      { stage: "score", code: "strong", elapsedMs: 1, token: "0xAA", reason: "score=41.2 active=1.00 orb=45 macd=43.7 regime=35" },
      { stage: "score", code: "below-threshold", elapsedMs: 1, token: "0xBB", reason: "score=3 active=1.00" },
      { stage: "entry-llm", code: "enter", elapsedMs: 2, token: "0xAA", model: "qwen3.7-flash", confidence: 78, reason: "Clean ORB break with volume." },
      { stage: "sell", code: "committed", elapsedMs: 3, token: "0xCC" },
      { stage: "buy", code: "committed", elapsedMs: 4, token: "0xAA", reason: "8.08 USDT via pancake_v3" },
    ] };
  it("builds one card per committed buy and per committed sell, with the buy's score and the model's reason", () => {
    const cards = tradeCards([bought]);
    expect(cards.map((card) => card.side)).toEqual(["sell", "buy"]);
    const buy = cards[1]!;
    expect(buy.token).toBe("0xAA");
    expect(buy.detail).toBe("8.08 USDT via pancake_v3");
    expect(buy.score?.reason).toContain("score=41.2");
    expect(buy.llm?.model).toBe("qwen3.7-flash");
    expect(cards[0]!.token).toBe("0xCC");
  });
  it("renders the buy, the score line and the model name, without the cycle noise", () => {
    const html = renderToStaticMarkup(<TradeRunLog runs={[bought]} symbols={{ "0xaa": "NVDAB" }} />);
    expect(html).toContain("Trades");
    expect(tradeCards([bought])[1]!.llm?.reason).toBe("Clean ORB break with volume.");
  });
  it("a dry run has no card; a sell-only cycle has one sell card", () => {
    expect(tradeCards([{ ...bought, dryRun: true }])).toHaveLength(0);
    const sellOnly = tradeCards([{ ...bought, reason: "score-hold", events: [{ stage: "sell", code: "committed", elapsedMs: 1, token: "0xCC" }] }]);
    expect(sellOnly.map((card) => card.side)).toEqual(["sell"]);
  });
  it("a sell card carries the close reason, the exit trigger and the exit model's reason", () => {
    const sold = { id: "s", dryRun: false, reason: "exited", candidates: 0, entries: 0, exits: 1, refusals: 0, createdAt: 3000,
      events: [
        { stage: "exit-llm", code: "trigger:cost-band-breach", elapsedMs: 1, token: "0xDD" },
        { stage: "exit-llm", code: "exit", elapsedMs: 2, token: "0xDD", model: "qwen3.7-flash", reason: "Trend broke below EMA26." },
        { stage: "sell", code: "committed", elapsedMs: 3, token: "0xDD", reason: "llm" },
        { stage: "sell", code: "committed", elapsedMs: 4, token: "0xEE", reason: "stop-loss" },
      ] };
    const [first, second] = tradeCards([sold]);
    expect(first!.trigger?.code).toBe("trigger:cost-band-breach");
    expect(first!.llm?.reason).toBe("Trend broke below EMA26.");
    expect(second!.detail).toBe("stop-loss");
    expect(second!.llm).toBeNull();
    expect(second!.trigger).toBeNull();
  });
});

describe("DCA-DETAIL §4: the DCA run log (2026-09-25)", () => {
  const dcaRun = (reason: string) => ({ id: "r", dryRun: false, reason, candidates: 0, entries: 0, exits: 0, refusals: 0, createdAt: 1 });

  it("with dca set, the filter buttons are exactly All cycles / Succeeded / Failed / Trades", () => {
    const html = renderToStaticMarkup(<TradeRunLog runs={[]} symbols={{}} dca={{ actions: [] }} />);
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/gu)].map((match) => match[1]);
    expect(buttons).toEqual(["All cycles", "Succeeded", "Failed", "Trades"]);
    expect(html).not.toContain("LLM decisions");
  });

  it("classifies every DCA reason code (§4's classification table)", () => {
    expect(dcaRunSucceeded(dcaRun("dca-placed;candidates=1;refusals=0;entries=1;exits=0"))).toBe(true);
    expect(dcaRunFailed(dcaRun("dca-placed;candidates=1;refusals=0;entries=1;exits=0"))).toBe(false);

    expect(dcaRunSucceeded(dcaRun("dca-level-filled;candidates=0;refusals=0;entries=0;exits=0"))).toBe(true);
    expect(dcaRunFailed(dcaRun("dca-level-filled;candidates=0;refusals=0;entries=0;exits=0"))).toBe(false);

    expect(dcaRunSucceeded(dcaRun("dca-stop-loss"))).toBe(true);
    expect(dcaRunFailed(dcaRun("dca-stop-loss"))).toBe(false);
    expect(dcaRunSucceeded(dcaRun("dca-removing"))).toBe(true);
    expect(dcaRunFailed(dcaRun("dca-removing"))).toBe(false);

    // A strategy-phase (candidate-bearing) "dca-stop-loss"/"dca-removing" is the closing-round state note, not a submit.
    expect(dcaRunSucceeded(dcaRun("dca-stop-loss;candidates=1;refusals=0;entries=0;exits=0"))).toBe(false);
    expect(dcaRunFailed(dcaRun("dca-stop-loss;candidates=1;refusals=0;entries=0;exits=0"))).toBe(false);

    for (const reason of ["dca-waiting;candidates=0;refusals=0;entries=0;exits=0", "dca-cash-low;candidates=0;refusals=0;entries=0;exits=0",
      "NATIVE_RESERVE;candidates=0;refusals=0;entries=0;exits=0", "dca-removing:waiting-for-an-in-flight-submission"]) {
      expect(dcaRunSucceeded(dcaRun(reason)), reason).toBe(false);
      expect(dcaRunFailed(dcaRun(reason)), reason).toBe(false);
    }

    for (const reason of ["FAILED;candidates=0;refusals=0;entries=0;exits=0", "dca-plan-refused:x;candidates=0;refusals=0;entries=0;exits=0",
      "dca-submission-unknown;candidates=0;refusals=0;entries=0;exits=0", "WHATEVER;candidates=0;refusals=0;entries=0;exits=0"]) {
      expect(dcaRunSucceeded(dcaRun(reason)), reason).toBe(false);
      expect(dcaRunFailed(dcaRun(reason)), reason).toBe(true);
    }
  });

  async function renderAndOpenTrades(dca: { readonly actions: readonly TradeDcaActionView[] | undefined }) {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<TradeRunLog runs={[]} symbols={{}} dca={dca} />));
    const trades = [...host.querySelectorAll("button")].find((button) => button.textContent === "Trades")!;
    await act(async () => trades.click());
    return { host, done: async () => act(async () => root.unmount()) };
  }

  it("Trades sources the DCA action rows: one card per committed/finished action, none for rolled-back, each with a tx link", async () => {
    const actions: readonly TradeDcaActionView[] = [
      { kind: "start", roundNo: 1, state: "finished", txHash: "0xaa", createdAt: 1000, updatedAt: 1000 },
      { kind: "fill", roundNo: 1, state: "committed", txHash: "0xbb", createdAt: 2000, updatedAt: 2000 },
      { kind: "close-start", roundNo: 1, state: "finished", txHash: "0xcc", createdAt: 3000, updatedAt: 3000 },
      { kind: "level-place", roundNo: 2, state: "finished", txHash: "0xdd", createdAt: 4000, updatedAt: 4000 },
      { kind: "stop-loss", roundNo: 2, state: "finished", txHash: "0xee", createdAt: 5000, updatedAt: 5000 },
      { kind: "remove", roundNo: 2, state: "finished", txHash: "0xff", createdAt: 6000, updatedAt: 6000 },
      { kind: "tp-place", roundNo: 2, state: "rolled-back", txHash: "0x00", createdAt: 7000, updatedAt: 7000 },
    ];
    const page = await renderAndOpenTrades({ actions });
    try {
      const html = page.host.innerHTML;
      expect(html).toContain("Round 1 started: base buy");
      expect(html).toContain("DCA order filled; take profit moved");
      expect(html).toContain("Round 1 closed at take profit; round 2 started");
      expect(html).toContain("DCA order placed");
      expect(html).toContain("Stop loss: every order pulled");
      expect(html).toContain("Remove: orders pulled");
      expect(html).not.toContain("Take profit placed");
      expect([...html.matchAll(/bscscan\.com\/tx\//gu)]).toHaveLength(6);
    } finally { await page.done(); }
  });

  it("shows the empty and unavailable copy", async () => {
    const empty = await renderAndOpenTrades({ actions: [] });
    try { expect(empty.host.innerHTML).toContain("No DCA transactions yet."); } finally { await empty.done(); }
    const unavailable = await renderAndOpenTrades({ actions: undefined });
    try { expect(unavailable.host.innerHTML).toContain("Needs the updated execution plane."); } finally { await unavailable.done(); }
  });
});

describe("DCA-DETAIL §8 fence: a non-DCA trade view is unaffected", () => {
  it("without dca, the filter buttons stay the five TRADE_FILTERS including LLM decisions", () => {
    const html = renderToStaticMarkup(<TradeRunLog runs={[]} symbols={{}} />);
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/gu)].map((match) => match[1]);
    expect(buttons).toEqual(["All cycles", "Succeeded", "Failed", "Trades", "LLM decisions"]);
  });
});

describe("buy card route line: guard fill vs direct AMM (2026-09-24)", () => {
  it("names a fill through the Binance aggregator guard", () => {
    expect(routeLine([{ stage: "route", code: "binance-guard", elapsedMs: 1, token: "0xAA", reason: "cost-comparison:123" }]))
      .toBe("Route: Binance aggregator through the guard");
  });
  it("names a direct AMM fill and why the aggregator was refused", () => {
    expect(routeLine([
      { stage: "route", code: "binance-refused", elapsedMs: 1, token: "0xAA", reason: "premium" },
      { stage: "route", code: "pancake_v3", elapsedMs: 2, token: "0xAA", reason: "cost-comparison:123" },
    ])).toBe("Route: direct AMM (pancake v3) · aggregator refused: premium");
    expect(routeLine([])).toBeNull();
  });
  it("carries the route events into the buy card", () => {
    const run = { id: "r", dryRun: false, reason: "entered", candidates: 1, entries: 1, exits: 0, refusals: 0, createdAt: 1,
      events: [{ stage: "route", code: "binance-guard", elapsedMs: 1, token: "0xAA" }, { stage: "buy", code: "committed", elapsedMs: 2, token: "0xAA", reason: "5.00 USDT via binance-aggregator" }] };
    expect(routeLine(tradeCards([run])[0]!.routes)).toBe("Route: Binance aggregator through the guard");
  });
});
