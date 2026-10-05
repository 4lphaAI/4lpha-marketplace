// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TradeRunLog, runLabel } from "./TradeRunLog";

const OWNER_TEXT = "Pause and Remove stay available and your funds stay in this wallet.";

it("runLabel keeps today's text by default and drops the owner actions when read-only", () => {
  expect(runLabel("portfolio-submission-unknown")).toBe("A trade's outcome is unknown; the agent waits. " + OWNER_TEXT);
  expect(runLabel("portfolio-submission-unknown;a=1", false)).toBe("A trade's outcome is unknown; the agent waits. " + OWNER_TEXT);
  expect(runLabel("portfolio-submission-unknown", true)).toBe("A trade's outcome is unknown; the agent waits.");
  expect(runLabel("portfolio-held", true)).toBe(runLabel("portfolio-held"));
});

it("words the two Binance refusals, and no Altana reason maps to them", () => {
  expect(runLabel("AGENTIC_QUOTE_REFUSED")).toBe("Binance refused the quote (the trade may be below its minimum size)");
  expect(runLabel("binance-rejected")).toBe("Binance rejected the order");
});

it("TradeRunLog passes readOnly to its run labels", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const runs = [{ id: "r1", dryRun: false, reason: "portfolio-submission-unknown;candidates=2", candidates: 2, refusals: 0, entries: 0, exits: 0, createdAt: 1_900_000_000_000, events: [] }];
  for (const readOnly of [false, true]) {
    const host = document.createElement("div"), root = createRoot(host);
    await act(async () => root.render(readOnly ? <TradeRunLog runs={runs} symbols={{}} portfolio readOnly /> : <TradeRunLog runs={runs} symbols={{}} portfolio />));
    expect(host.textContent?.includes(OWNER_TEXT)).toBe(!readOnly);
    expect(host.textContent).toContain("A trade's outcome is unknown; the agent waits.");
    await act(async () => root.unmount());
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
