// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import type { TradeSettings } from "@/lib/trade";

vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => ({}) }));
const NOW = 1_900_000_000_000, W = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", E = "000000000000000000";
const SPYB = "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", QQQB = "0x205812cdbed920aff76c6580abd681a46d11efc7";
/** What the Deploy form sends for Smart Portfolio: two stocks 50/50, drift 0.5 %, every 4 h, capital 50 USDT, no CMC fields. */
const settings: TradeSettings = { name: "Agentic portfolio", executionModel: "tradfi", settlementAsset: "USDT", entryWei: "50" + E, minEntryWei: "100000000000000000", capitalQuoteWei: "50" + E,
  maxOpenPositions: 1, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false, cmcNewsEnabled: false,
  tradeMode: "portfolio", portfolioTokens: [SPYB, QQQB], portfolioWeightsBps: [5000, 5000], portfolioDriftBps: 50, portfolioIntervalSec: 14400 };
const facts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0, x402DailyLimit: 20, x402QuotaUsed: 0,
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
const mount = async (symbols: readonly string[] | undefined = ["SPYB", "QQQB"], value: TradeSettings = settings) =>
  act(async () => root!.render(<AgenticDeployModal settings={value} go={() => undefined} onClose={() => undefined} onAltana={() => undefined} portfolioSymbols={symbols} />));
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

it("portfolio step 2 shows the locked CMC line with the keep-alive budget, the keep-alive sentence and the basket line, and no term-end choice", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await mount();
  await chooseAgentic();
  expect(node.textContent).toContain("Agentic Wallet term");
  expect(node.textContent).toContain("CMC Agent Hub x402 is required and locked on.");
  expect(node.textContent).toContain("Total budget 0.2 USDT");
  expect(node.textContent).toContain("Used only to keep the Binance session active after 12 hours without a trade. Keep the x402 daily limit at 0.50 USDT or more: below it the agent pauses all trading until you raise it.");
  expect(node.textContent).toContain("This agent holds SPYB 50 %, QQQB 50 % and rebalances when a weight drifts 0.5 % from target, checked every 4 h.");
  for (const gone of ["At term end", "Keep holdings at term end", "Sell all", "buys; "]) expect(node.textContent).not.toContain(gone);
  expect(button("Next").disabled).toBe(false);
  await act(async () => button("30 days").click());
  expect(node.textContent).toContain("Total budget 0.8 USDT");
});

it("the basket line falls back to the token address without tickers and words every interval", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await mount([], { ...settings, portfolioIntervalSec: 86400, portfolioDriftBps: 500 });
  await chooseAgentic();
  expect(node.textContent).toContain(`This agent holds ${SPYB} 50 %, ${QQQB} 50 % and rebalances when a weight drifts 5 % from target, checked every day.`);
  await act(async () => root!.render(<AgenticDeployModal settings={{ ...settings, portfolioIntervalSec: 28800 }} go={() => undefined} onClose={() => undefined} onAltana={() => undefined} portfolioSymbols={["SPYB", "QQQB"]} />));
  expect(node.textContent).toContain("checked every 8 h.");
  await act(async () => root!.render(<AgenticDeployModal settings={{ ...settings, portfolioIntervalSec: 43200 }} go={() => undefined} onClose={() => undefined} onAltana={() => undefined} portfolioSymbols={["SPYB", "QQQB"]} />));
  expect(node.textContent).toContain("checked every 12 h.");
});

it("portfolio deploy: needs, gate rows with the x402 row, button text and a hire body that keeps the form's tuple and holdings", async () => {
  const fetch = server();
  await mount();
  await chooseAgentic();
  await act(async () => button("Next").click());
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => button("Finalize pairing").click());
  // Funding step: USDT = the capital plus the 0.20 keep-alive budget; BNB = (2 x 2 + 2) x 0.0004.
  expect(node.textContent).toContain("need 50.2 USDT"); expect(node.textContent).toContain("need 0.0024 BNB");
  await act(async () => button("Next").click());
  const checks = node.querySelector('[aria-label="Binance checks"]')!.textContent!;
  for (const label of ["x402 daily limit", "Daily limit", "USDT balance", "BNB for gas"]) expect(checks).toContain(label);
  expect(checks).not.toContain("First buy falls inside the term");
  for (const gone of ["Deploy Agentic AI Trade", "Deploy Agentic Schedule buy"]) expect(node.textContent).not.toContain(gone);
  await act(async () => button("Deploy Agentic Smart Portfolio").click());
  const hire = fetch.mock.calls.find(([url]) => url === "/api/agentic/hire")!;
  const sent = JSON.parse(String((hire[1] as RequestInit).body)) as { settings: unknown; termEndAction: string; term: number; executionModel: string; acceptedDedicatedWallet: boolean; pairingId: string };
  expect(sent).toMatchObject({ pairingId: "private-pairing", term: 7, termEndAction: "keep", executionModel: "tradfi", acceptedDedicatedWallet: true });
  expect(sent.settings).toEqual(settings);
  expect(JSON.stringify(sent)).not.toContain("cmcTotalBudgetWei");
});

it("portfolio deploy for 30 days asks 50.8 USDT, and five stocks ask 0.0048 BNB", async () => {
  const five = { ...settings, portfolioTokens: [SPYB, QQQB, "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1", "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec"],
    portfolioWeightsBps: [2000, 2000, 2000, 2000, 2000], capitalQuoteWei: "125" + E, entryWei: "125" + E };
  server();
  await mount(["A", "B", "C", "D", "E"], five);
  await chooseAgentic();
  await act(async () => button("30 days").click());
  await act(async () => button("Next").click());
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => button("Finalize pairing").click());
  expect(node.textContent).toContain("need 125.8 USDT"); expect(node.textContent).toContain("need 0.0048 BNB");
});
