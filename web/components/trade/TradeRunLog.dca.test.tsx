// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TradeRunLog, dcaRunFailed, dcaRunSucceeded, runLabel } from "./TradeRunLog";

/** AGENTIC-DCA R3.10: every code the Agentic lane adds to the DCA Run log, with its class and label (the labels of codes Revision 3 no longer emits stay, so legacy run rows still render). */
const run = (reason: string) => ({ id: "r1", dryRun: false, reason, candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: 1_900_000_000_000, events: [] });
const classOf = (code: string): "succeeded" | "quiet" | "failed" => dcaRunSucceeded(run(code)) ? "succeeded" : dcaRunFailed(run(code)) ? "failed" : "quiet";
const TABLE: readonly (readonly [string, "succeeded" | "quiet" | "failed", string])[] = [
  ["dca-base-bought", "succeeded", "Base order bought"],
  ["dca-orders-cancelled", "succeeded", "Term ended: nothing is left to fill"],
  ["dca-watching", "quiet", "Watching the price"],
  ["dca-quote-short", "quiet", "Price reached; the Binance quote is not good enough yet"],
  ["dca-cooldown", "quiet", "Cooling down after the round"],
  ["dca-cancelling", "quiet", "Cancelling orders"],
  ["dca-stopping", "quiet", "Stop loss: waiting for the order in flight"],
  ["dca-winding-down", "quiet", "Term ending: waiting for the order in flight"],
  ["dca-low-bnb", "quiet", "Waiting: BNB for gas is low"],
  ["dca-quota-low", "quiet", "Waiting: Binance daily quota is low"],
  ["dca-settings-hold", "quiet", "Waiting: Binance settings changed"],
  ["dca-binance-throttled", "quiet", "Waiting: Binance is rate limiting"],
  ["dca-agentic-off", "quiet", "Agentic Auto DCA is off: only cancels run"],
  ["dca-order-held", "failed", "Held: an order needs review"],
  ["dca-unattributed-strategy", "failed", "Held: an order this agent did not place is open"],
  ["dca-list-incomplete", "failed", "Held: the order list could not be read completely"],
  ["dca-fill-above-level", "failed", "A buy filled above its level price"],
  ["dca-tp-stale", "quiet", "Take profit left as placed while the agent is held"],
  ["dca-stop-cancel-unconfirmed", "failed", "Stop loss: a cancel is not confirmed yet; retrying every minute"],
  ["dca-no-tp", "failed", "Held: the round has no take profit order right now"],
];

it("labels and classes every new Agentic DCA code, with or without a detail after the code", () => {
  for (const [code, outcome, label] of TABLE) {
    expect(runLabel(code), code).toBe(label);
    expect(runLabel(`${code};candidates=0;refusals=0`), code).toBe(label);
    expect(runLabel(code, true), code).toBe(label);
    expect(classOf(code), code).toBe(outcome);
    expect(classOf(`${code};candidates=0`), code).toBe(outcome);
  }
});

it("leaves cost-unavailable with its existing label and class, and the Altana codes untouched", () => {
  expect(runLabel("cost-unavailable")).toBe("Relay cost quote unavailable");
  expect(classOf("cost-unavailable")).toBe("failed");
  expect(runLabel("dca-placed")).toBe("Orders placed");
  expect(classOf("dca-placed")).toBe("succeeded");
  expect(classOf("dca-waiting")).toBe("quiet");
  expect(runLabel("dca-retry-exhausted")).toBe(`Held after repeated failed batches ${String.fromCharCode(0x2014)} pause and resume, edit, or Remove`);
  expect(classOf("dca-order-mismatch")).toBe("failed");
});

it("the DCA Run log files a cycle under its class filter and shows its label", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const runs = [run("dca-base-bought"), run("dca-low-bnb"), run("dca-no-tp")].map((value, index) => ({ ...value, id: `r${index}` }));
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<TradeRunLog runs={runs} symbols={{}} dca={{ actions: [] }} readOnly />));
  const press = async (label: string) => act(async () => { [...host.querySelectorAll("button")].find((entry) => entry.textContent === label)!.click(); });
  for (const text of ["Base order bought", "Waiting: BNB for gas is low", "Held: the round has no take profit order right now"]) expect(host.textContent).toContain(text);
  await press("Succeeded");
  expect(host.textContent).toContain("Base order bought");
  expect(host.textContent).not.toContain("Waiting: BNB for gas is low");
  expect(host.textContent).not.toContain("Held: the round has no take profit order right now");
  await press("Failed");
  expect(host.textContent).toContain("Held: the round has no take profit order right now");
  expect(host.textContent).not.toContain("Waiting: BNB for gas is low");
  await act(async () => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
