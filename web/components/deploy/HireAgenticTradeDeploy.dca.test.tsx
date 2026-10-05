// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import { agenticGate } from "@/lib/agentic";
import type { TradeSettings } from "@/lib/trade";

vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => ({}) }));
vi.mock("@/lib/agentic", async (importOriginal) => { const actual = await importOriginal<typeof import("@/lib/agentic")>(); return { ...actual, agenticGate: vi.fn(actual.agenticGate) }; });
const NOW = 1_900_000_000_000, W = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", E = "000000000000000000";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
/** What the Deploy form sends for Auto DCA with three orders: base 25 USDT, orders of 10 USDT, capital 55 USDT, no CMC fields. */
const settings: TradeSettings = { name: "Agentic DCA", executionModel: "tradfi", settlementAsset: "USDT", entryWei: "25" + E, minEntryWei: "25" + E, capitalQuoteWei: "55" + E,
  maxOpenPositions: 1, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false, cmcNewsEnabled: false,
  tradeMode: "dca", dcaToken: NVDAB, dcaStepBps: 100, dcaStepMultiplierBps: 12000, dcaTakeProfitBps: 150, dcaOrderWei: "10" + E, dcaMaxOrders: 3,
  dcaTriggerPriceE8: null, dcaRangeMinE8: null, dcaRangeMaxE8: null, dcaStopLossBps: 1500 };
const facts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0, x402DailyLimit: 20, x402QuotaUsed: 0,
  signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: "100" + E, bnbWei: "1" + E };
let root: Root | undefined, node: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear(); vi.mocked(agenticGate).mockClear();
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
const chooseAgentic = async () => { await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click()); await act(async () => button("Next").click()); };
const toFunding = async () => {
  await act(async () => button("Next").click());
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => button("Finalize pairing").click());
};

it("DCA step 2 shows the locked keep-alive line with its budget, the three lines and no term-end choice", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await mount();
  await chooseAgentic();
  expect(node.textContent).toContain("Agentic Wallet term");
  const text = node.textContent!;
  expect(text).toContain("CMC x402 keep-alive is required and locked on. Keep the x402 daily limit at 0.50 USDT or more: below it the agent stops trading until you raise it.");
  expect(text).toContain("Total budget 0.2 USDT");
  const lines = ["The agent watches the pool price itself and trades with Binance market orders from your Agentic Wallet: the base order buys at once, then it watches one take-profit price and 1 buy level(s), and buys or sells at market when the price reaches them.",
    "Stop loss and term end stop the agent; nothing is sold. Your stock and USDT stay in the Agentic Wallet. The keep-alive pays one 0.01 USDT data call after 12 hours without a trade.",
    "To stop the agent, sign 4lpha out in the Binance App. Nothing waits at Binance: after that no order is placed.",
    "Fills need 4lpha's worker running: a price touch that reverses within about a minute can be missed, and each fill is a market order that can execute up to 0.5 % worse than its quote."];
  for (const line of lines) expect(text).toContain(line);
  expect(lines.map(line => text.indexOf(line))).toEqual([...lines.map(line => text.indexOf(line))].sort((a, b) => a - b));
  for (const gone of ["At term end", "Keep holdings at term end", "Sell all", "buys; ", "CMC Agent Hub x402 is required", "limit orders", "cancel it there", "Binance limit"]) expect(text).not.toContain(gone);
  expect(button("Next").disabled).toBe(false);
  await act(async () => button("30 days").click());
  expect(node.textContent).toContain("Total budget 0.8 USDT");
});

it("four to eight orders watch two buy levels, and the line says so", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await mount({ ...settings, dcaMaxOrders: 4, capitalQuoteWei: "65" + E });
  await chooseAgentic();
  expect(node.textContent).toContain("one take-profit price and 2 buy level(s)");
});

it("DCA deploy: needs, the gate preview's dca input, the x402 row, the button text and a hire body that keeps the form's tuple and holdings", async () => {
  const fetch = server();
  await mount();
  await chooseAgentic();
  await toFunding();
  // Funding step: USDT = the 55 USDT capital plus the 0.20 keep-alive budget; BNB = (2 x 3 + 4) x 0.0004.
  expect(node.textContent).toContain("need 55.2 USDT"); expect(node.textContent).toContain("need 0.004 BNB");
  await act(async () => button("Next").click());
  expect(vi.mocked(agenticGate).mock.calls.at(-1)![0].dca).toEqual({ maxOrders: 3 });
  const checks = node.querySelector('[aria-label="Binance checks"]')!.textContent!;
  for (const label of ["x402 daily limit", "Daily limit", "USDT balance", "BNB for gas"]) expect(checks).toContain(label);
  expect(checks).not.toContain("First buy falls inside the term");
  for (const gone of ["Deploy Agentic AI Trade", "Deploy Agentic Schedule buy", "Deploy Agentic Smart Portfolio"]) expect(node.textContent).not.toContain(gone);
  await act(async () => button("Deploy Agentic Auto DCA").click());
  const hire = fetch.mock.calls.find(([url]) => url === "/api/agentic/hire")!;
  const sent = JSON.parse(String((hire[1] as RequestInit).body)) as { settings: unknown; termEndAction: string; term: number; executionModel: string; acceptedDedicatedWallet: boolean; pairingId: string };
  expect(sent).toMatchObject({ pairingId: "private-pairing", term: 7, termEndAction: "keep", executionModel: "tradfi", acceptedDedicatedWallet: true });
  expect(sent.settings).toEqual(settings);
  expect(JSON.stringify(sent)).not.toContain("cmcTotalBudgetWei");
});

it("the 30-day term asks 55.8 USDT, and the BNB need follows the order count: 0.0024 for one, 0.0048 for four, 0.0080 for eight", async () => {
  server();
  await mount();
  await chooseAgentic();
  await act(async () => button("30 days").click());
  await toFunding();
  expect(node.textContent).toContain("need 55.8 USDT");
  await act(async () => root!.unmount()); root = createRoot(node);
  for (const [orders, bnb] of [[1, "0.0024"], [4, "0.0048"], [8, "0.008"]] as const) {
    server();
    await act(async () => root!.unmount()); root = createRoot(node);
    await mount({ ...settings, dcaMaxOrders: orders, capitalQuoteWei: String(25 + 10 * orders) + E });
    await chooseAgentic();
    await toFunding();
    expect(node.textContent).toContain(`need ${bnb} BNB`);
  }
});
