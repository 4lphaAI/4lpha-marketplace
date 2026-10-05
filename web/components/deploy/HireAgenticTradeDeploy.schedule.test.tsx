// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import type { TradeSettings } from "@/lib/trade";

vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => ({}) }));
const NOW = 1_900_000_000_000, W = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", E = "000000000000000000";
/** What the Deploy form sends for a Schedule buy: 5 USDT per buy, hourly, two runs, market hours off, premium 1.5 %. */
const settings: TradeSettings = { name: "Agentic schedule", executionModel: "tradfi", settlementAsset: "USDT", entryWei: "5" + E, minEntryWei: "5" + E, capitalQuoteWei: "10" + E,
  maxOpenPositions: 1, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", cmcNewsEnabled: false,
  tradeMode: "schedule", scheduleToken: "0x2222222222222222222222222222222222222222", scheduleIntervalSec: 3600, scheduleFirstAtSec: null, scheduleEndKind: "runs",
  scheduleEndAtSec: null, scheduleEndRuns: 2, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 };
const facts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0, x402DailyLimit: 0, x402QuotaUsed: 0,
  signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: "100" + E, bnbWei: "1" + E };
let root: Root | undefined, node: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; node.remove(); localStorage.clear();
  vi.useRealTimers(); vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
const button = (text: string): HTMLButtonElement => { const found = [...node.querySelectorAll("button")].find(value => value.textContent === text); expect(found, text).toBeDefined(); return found!; };
const mount = async (value: TradeSettings = settings) => act(async () => root!.render(<AgenticDeployModal settings={value} go={() => undefined} onClose={() => undefined} onAltana={() => undefined} />));
function server() {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/agentic/pairings") return Response.json({ data: { pairingId: "private-pairing", urlForWeb: "https://binance.test/qr", expireAtMs: NOW + 300_000 } });
    if (url === "/api/agentic/hire") return Response.json({ data: { walletAddress: W, hireEndMs: NOW + 604_800_000 } });
    return Response.json({ data: { state: "paired", walletAddress: W, codeAttemptsLeft: 5, facts, continuationDeadlineMs: NOW + 1_800_000, failure: null } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("Schedule step 2 shows the term's buy count in place of the CMC line and the term-end choice, and Next needs no choice", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await mount();
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click());
  await act(async () => button("Next").click());
  expect(node.textContent).toContain("Agentic Wallet term");
  expect(node.textContent).toContain("Your 7-day term covers up to 166 buys; 2 are planned.");
  for (const gone of ["At term end", "CMC Agent Hub", "Total budget", "Keep holdings at term end", "Sell all"]) expect(node.textContent).not.toContain(gone);
  expect(button("Next").disabled).toBe(false);
  await act(async () => button("30 days").click());
  expect(node.textContent).toContain("Your 30-day term covers up to 718 buys; 2 are planned.");
});

it("Schedule deploy: needs, Schedule gate rows, button text and a hire body that keeps the form's settings and holdings", async () => {
  const fetch = server();
  await mount();
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click());
  await act(async () => button("Next").click());
  await act(async () => button("Next").click());
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => button("Finalize pairing").click());
  // Funding step: USDT = the capital only; BNB = 0.0012 + 2 buys x 0.0004.
  expect(node.textContent).toContain("need 10 USDT"); expect(node.textContent).toContain("need 0.002 BNB");
  await act(async () => button("Next").click());
  const checks = node.querySelector('[aria-label="Binance checks"]')!.textContent!;
  for (const label of ["First buy falls inside the term", "End date is in the future", "Daily limit", "USDT balance", "BNB for gas"]) expect(checks).toContain(label);
  expect(checks).not.toContain("x402 daily limit");
  expect(node.textContent).not.toContain("Deploy Agentic AI Trade");
  await act(async () => button("Deploy Agentic Schedule buy").click());
  const hire = fetch.mock.calls.find(([url]) => url === "/api/agentic/hire")!;
  const sent = JSON.parse(String((hire[1] as RequestInit).body)) as { settings: unknown; termEndAction: string; term: number; executionModel: string; acceptedDedicatedWallet: boolean; pairingId: string };
  expect(sent).toMatchObject({ pairingId: "private-pairing", term: 7, termEndAction: "keep", executionModel: "tradfi", acceptedDedicatedWallet: true });
  expect(sent.settings).toEqual(settings);
  expect(JSON.stringify(sent)).not.toContain("cmcTotalBudgetWei");
});
