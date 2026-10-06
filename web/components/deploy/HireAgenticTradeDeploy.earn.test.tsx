// @vitest-environment happy-dom
/** AGENTIC-EARN-SPEC ET13 (+ R11.6): the Deploy opt-in: the visibility matrix (flag, a configured product, the lane), unchecked by default, the verbatim disclosure with the owner-supply sentence, the body key only when checked, the BNB gate mirror. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import { AGENTIC_EARN_COPY } from "@/lib/agentic";
import type { TradeSettings } from "@/lib/trade";

const flag = vi.hoisted(() => ({ earn: true, meme: false, configured: true }));
vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => ({}) }));
vi.mock("@/lib/agentic", async importOriginal => { const actual = await importOriginal<typeof import("@/lib/agentic")>();
  return { ...actual, get agenticEarnEnabled() { return flag.earn; }, get agenticMemeEnabled() { return flag.meme; },
    get AGENTIC_EARN_PRODUCTS() { return flag.configured ? actual.AGENTIC_EARN_PRODUCTS : actual.AGENTIC_EARN_PRODUCTS.map(product => ({ ...product, investmentId: null })); } }; });
const NOW = 1_900_000_000_000, W = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", E = "000000000000000000";
const base = { executionModel: "tradfi", settlementAsset: "USDT", minEntryWei: "5" + E, entryWei: "5" + E, capitalQuoteWei: "50" + E, maxOpenPositions: 3, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false,
  takeProfitBps: 1000, stopLossBps: 500, maxHoldSec: 3600, breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false };
const ai = { ...base, name: "AI Trade", cmcNewsEnabled: true, cmcTotalBudgetWei: "2" + E } as TradeSettings;
const schedule = { ...base, name: "Schedule", cmcNewsEnabled: false, tradeMode: "schedule", scheduleToken: "0x2222222222222222222222222222222222222222", scheduleIntervalSec: 86_400, scheduleFirstAtSec: null, scheduleEndKind: "runs",
  scheduleEndAtSec: null, scheduleEndRuns: 2, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150, maxOpenPositions: 1 } as unknown as TradeSettings;
const dca = (n: number) => ({ ...base, name: "DCA", cmcNewsEnabled: false, tradeMode: "dca", dcaToken: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", dcaStepBps: 100, dcaStepMultiplierBps: 12000, dcaTakeProfitBps: 150,
  dcaOrderWei: "10" + E, dcaMaxOrders: n, dcaTriggerPriceE8: null, dcaRangeMinE8: null, dcaRangeMaxE8: null, dcaStopLossBps: 1500 }) as unknown as TradeSettings;
const portfolio = { ...base, name: "Portfolio", cmcNewsEnabled: false, tradeMode: "portfolio", portfolioTokens: ["0x1111111111111111111111111111111111111111"], portfolioWeightsBps: [10000], portfolioDriftBps: 500, portfolioIntervalSec: 86400 } as unknown as TradeSettings;
const facts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0, x402DailyLimit: 20, x402QuotaUsed: 0, signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: "100" + E, bnbWei: "1" + E };
let root: Root | undefined, node: HTMLDivElement;
beforeEach(() => {
  flag.earn = true; flag.meme = false; flag.configured = true; vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; node.remove(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
const button = (text: string): HTMLButtonElement => { const found = [...node.querySelectorAll("button")].find(value => value.textContent === text); expect(found, text).toBeDefined(); return found!; };
const mount = async (value: TradeSettings) => act(async () => root!.render(<AgenticDeployModal settings={value} go={() => undefined} onClose={() => undefined} onAltana={() => undefined} />));
const toStep1 = async () => { await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click()); await act(async () => button("Next").click()); };
const toggle = () => node.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Earn on idle USDT (optional)"]');
function server() {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/agentic/pairings") return Response.json({ data: { pairingId: "private-pairing", urlForWeb: "https://binance.test/qr", expireAtMs: NOW + 300_000 } });
    if (url === "/api/agentic/hire") return Response.json({ data: { walletAddress: W, hireEndMs: NOW + 604_800_000 } });
    return Response.json({ data: { state: "paired", walletAddress: W, codeAttemptsLeft: 5, facts, continuationDeadlineMs: NOW + 1_800_000, failure: null } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("the opt-in shows only with the flag on, a configured product and a lane that may use it; AI, Schedule and DCA with 5 or more levels", async () => {
  const shows: [string, TradeSettings, () => void][] = [["ai", ai, () => undefined], ["schedule", schedule, () => undefined], ["dca 5", dca(5), () => undefined], ["dca 8", dca(8), () => undefined],
    ["flag off", ai, () => { flag.earn = false; }], ["no configured product", ai, () => { flag.configured = false; }], ["dca 4", dca(4), () => undefined], ["portfolio", portfolio, () => undefined]];
  const expected = [true, true, true, true, false, false, false, false];
  for (const [index, [label, settings, arrange]] of shows.entries()) {
    flag.earn = true; flag.configured = true; arrange();
    vi.stubGlobal("fetch", vi.fn());
    await mount(settings); await toStep1();
    expect(toggle() !== null, label).toBe(expected[index]);
    await act(async () => root!.unmount()); root = createRoot(node);
  }
});

it("the paper meme strategy never offers it; the toggle is unchecked by default and the disclosure shows only when checked, verbatim with the owner-supply sentence and no em dash", async () => {
  flag.meme = true;
  vi.stubGlobal("fetch", vi.fn());
  await mount(ai); await toStep1();
  expect(toggle()!.checked).toBe(false);
  expect(node.querySelector('[data-testid="earn-disclosure"]')).toBeNull();
  await act(async () => toggle()!.click());
  // Operator 2026-10-06: the short disclosure is a picture, one line and three points (no sign-out details: the self-rescue commands live on the Earn tab).
  const box = node.querySelector('[data-testid="earn-disclosure"]')!, text = box.textContent!;
  expect(box.querySelector(".fl-earn-flow")).not.toBeNull();
  expect(text).toContain(AGENTIC_EARN_COPY.summary);
  for (const point of AGENTIC_EARN_COPY.points) expect(text).toContain(point);
  expect(box.querySelector("details")).toBeNull();
  expect(JSON.stringify(AGENTIC_EARN_COPY)).not.toContain(String.fromCharCode(0x2014));
  await act(async () => button("Meme stocks (paper)").click());
  expect(toggle()).toBeNull();
});

it("the hire body carries earn: true only when the box is checked, and the BNB gate asks 0.0008 more only then", async () => {
  for (const checked of [false, true]) {
    const fetch = server();
    await mount(ai); await toStep1();
    await act(async () => button("Keep holdings at term end").click());
    if (checked) await act(async () => toggle()!.click());
    await act(async () => button("Next").click());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => button("Finalize pairing").click());
    const funding = node.textContent ?? "";
    expect(funding).toContain(checked ? "need 0.0028 BNB" : "need 0.002 BNB");
    await act(async () => button("Next").click());
    await act(async () => button("Deploy Agentic AI Trade").click());
    const hire = fetch.mock.calls.find(call => call[0] === "/api/agentic/hire")!;
    const body = JSON.parse(String((hire[1] as RequestInit).body)) as Record<string, unknown>;
    expect(Object.hasOwn(body, "earn")).toBe(checked);
    if (checked) expect(body["earn"]).toBe(true);
    await act(async () => root!.unmount()); root = createRoot(node);
  }
});

it("the Dockerfile carries the build-time flag (ARG and ENV) or the flag bakes undefined", () => {
  const text = readFileSync("Dockerfile", "utf8").replace(/\r\n/gu, "\n");
  expect(text).toContain("ARG NEXT_PUBLIC_AGENTIC_EARN_ENABLED=");
  expect(text).toContain("NEXT_PUBLIC_AGENTIC_EARN_ENABLED=$NEXT_PUBLIC_AGENTIC_EARN_ENABLED \\");
});
