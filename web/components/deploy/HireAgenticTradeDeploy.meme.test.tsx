// @vitest-environment happy-dom
/** AGENTIC-MEME-STOCKS-SPEC 9.4, 10 web: the paper option only with the flag, its copy, the paper gate preview and no funding, and the hire body. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import { AGENTIC_MEME_COPY, agenticGate } from "@/lib/agentic";
import type { TradeSettings } from "@/lib/trade";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => ({}) }));
vi.mock("@/lib/agentic", async (importOriginal) => { const actual = await importOriginal<typeof import("@/lib/agentic")>(); return { ...actual, get agenticMemeEnabled() { return flag.on; } }; });
const NOW = 1_900_000_000_000, W = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", E = "000000000000000000";
/** What the Deploy form sends for TradFi AI Trade (Altana shape: 5 USDT entries, CMC on). */
const settings: TradeSettings = { name: "AI Trade", executionModel: "tradfi", settlementAsset: "USDT", entryWei: "5" + E, minEntryWei: "5" + E, capitalQuoteWei: "50" + E,
  maxOpenPositions: 3, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: 1000, stopLossBps: 500, maxHoldSec: 3600, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: "be careful", skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false,
  cmcNewsEnabled: true, cmcTotalBudgetWei: "2" + E };
const facts = (tradeAllTokens: boolean) => ({ readAtMs: NOW, status: "CONNECTED", tradeAllTokens, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0, x402DailyLimit: 0, x402QuotaUsed: 0,
  signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: "0", bnbWei: "0" });
let root: Root | undefined, node: HTMLDivElement;
beforeEach(() => {
  flag.on = true; vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; node.remove(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
const button = (text: string): HTMLButtonElement => { const found = [...node.querySelectorAll("button")].find(value => value.textContent === text); expect(found, text).toBeDefined(); return found!; };
const mount = async () => act(async () => root!.render(<AgenticDeployModal settings={settings} go={() => undefined} onClose={() => undefined} onAltana={() => undefined} />));
const chooseAgentic = async () => { await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click()); await act(async () => button("Next").click()); };
function server(tradeAllTokens: boolean) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/agentic/pairings") return Response.json({ data: { pairingId: "private-pairing", urlForWeb: "https://binance.test/qr", expireAtMs: NOW + 300_000 } });
    if (url === "/api/agentic/hire") return Response.json({ data: { walletAddress: W, hireEndMs: NOW + 604_800_000 } });
    return Response.json({ data: { state: "paired", walletAddress: W, codeAttemptsLeft: 5, facts: facts(tradeAllTokens), continuationDeadlineMs: NOW + 1_800_000, failure: null } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("the paper option is offered only with the flag", async () => {
  flag.on = false;
  vi.stubGlobal("fetch", vi.fn());
  await mount(); await chooseAgentic();
  expect(node.textContent).not.toContain("Meme stocks (paper)");
});

it("meme: the paper copy with both R2-M9 clauses and the Law 1 line; no CMC line, no term-end choice; no em dash", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await mount(); await chooseAgentic();
  await act(async () => button("Meme stocks (paper)").click());
  const text = node.textContent!;
  expect(text).toContain(AGENTIC_MEME_COPY.paper);
  expect(text).toContain("While this agent runs, this Binance account cannot run another 4lpha agent.");
  expect(text).toContain("Signing 4lpha out in the Binance App, or signing in anywhere else, ends the agent.");
  expect(text).toContain(AGENTIC_MEME_COPY.law1);
  for (const gone of ["CMC Agent Hub x402 is required", "Sell all to USDT at term end", "Keep holdings at term end"]) expect(text).not.toContain(gone);
  for (const line of Object.values(AGENTIC_MEME_COPY)) expect(line).not.toContain(String.fromCharCode(0x2014));
  expect(button("Next").disabled).toBe(false);
});

it("meme deploy: no funding needed, the four paper gate rows with Trade all tokens as a WARN, and a hire body with strategy and the paper settings", async () => {
  const fetch = server(false);
  await mount(); await chooseAgentic();
  await act(async () => button("Meme stocks (paper)").click());
  await act(async () => button("Next").click());
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => button("Finalize pairing").click());
  expect(node.textContent).toContain(AGENTIC_MEME_COPY.noFunding);
  expect(node.textContent).not.toContain("USDT balance");
  await act(async () => button("Next").click());
  const rows = [...node.querySelectorAll('[aria-label="Binance checks"] li')].map(li => li.textContent ?? "");
  expect(rows.length).toBe(4);
  expect(rows[1]).toContain("WARN");
  expect(rows[1]).toContain("Not needed for paper trading. A live agent will need Trade all tokens.");
  await act(async () => button("Deploy Agentic Meme stocks (paper)").click());
  const hire = fetch.mock.calls.find(call => call[0] === "/api/agentic/hire")!;
  const body = JSON.parse(String(hire[1]!.body)) as { strategy: string; termEndAction: string; settings: TradeSettings };
  expect(body.strategy).toBe("meme-stocks-paper");
  expect(body.termEndAction).toBe("sell-all");
  expect(body.settings).toMatchObject({ cmcNewsEnabled: false, minEntryWei: "10" + E, entryWei: "10" + E, maxOpenPositions: 2, capitalQuoteWei: "20" + E, slippageBps: 500,
    takeProfitBps: null, stopLossBps: null, maxHoldSec: null, instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash" });
  expect(Object.hasOwn(body.settings, "cmcTotalBudgetWei")).toBe(false);
});

it("plane parity: the web mirror's paper rows equal the plane's for the same input (test/agentic.memeStocks.hire.test.ts)", () => {
  const gate = agenticGate({ facts: { ...facts(false), signInMaxTimeMs: NOW + 90 * 86_400_000 }, wallet: W, capitalQuoteWei: 20n * 10n ** 18n, maxOpenPositions: 2, entryWei: 10n * 10n ** 18n,
    termSec: 604_800, nowMs: NOW, budgetWei: 0n, meme: "paper" });
  expect(gate.rows).toEqual([{ code: "status", state: "PASS", fix: "Connect in the Binance App." },
    { code: "trade-all-tokens", state: "WARN", fix: "Not needed for paper trading. A live agent will need Trade all tokens." },
    { code: "sign-in-time", state: "PASS", fix: "Raise Max sign-in duration in the Binance App, or choose 7 days." },
    { code: "sizing", state: "PASS", fix: "Capital 20 USDT is below 2 positions x 10 USDT = 20 USDT; raise capital or lower the entry size." }]);
  const ai = agenticGate({ facts: facts(true), wallet: W, capitalQuoteWei: 50n * 10n ** 18n, maxOpenPositions: 3, entryWei: 5n * 10n ** 18n, termSec: 604_800, nowMs: NOW, budgetWei: 2n * 10n ** 18n });
  expect(ai.rows.map(r => r.code)).toEqual(["status", "trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "x402-limit", "usdt", "bnb", "quota-today", "sizing"]);
});
