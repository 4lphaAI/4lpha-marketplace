import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TradeRunLog, hasExecutedTrade } from "./TradeRunLog";

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
