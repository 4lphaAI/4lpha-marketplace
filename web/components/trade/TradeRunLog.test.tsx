import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TradeRunLog, hasExecutedTrade, runFailed, runSucceeded } from "./TradeRunLog";

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

  it("a DRY RUN is neither, even when it contains a refusal", () => {
    // A rehearsal that "failed" never risked anything; filing it under Failed
    // buries the live ones.
    const rehearsed = run({ dryRun: true, events: [{ stage: "buy", code: "DAILY_CAP", elapsedMs: 1 }] });
    expect(runFailed(rehearsed)).toBe(false);
    expect(runSucceeded(rehearsed)).toBe(false);
  });
});
