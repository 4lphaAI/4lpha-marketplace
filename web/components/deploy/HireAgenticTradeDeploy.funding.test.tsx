// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import type { TradeSettings } from "@/lib/trade";

vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: "0x1111111111111111111111111111111111111111", chainId: 56 }) }));
vi.mock("@/components/FundsModal", () => ({
  FundsModal: ({ onDepositSubmitted }: { readonly onDepositSubmitted?: (hash: string) => void }) =>
    <div data-testid="funds-modal"><button onClick={() => onDepositSubmitted?.("0xdeposit")}>Wallet sent</button></div>,
}));
const NOW = 1_900_000_000_000, W = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", E = "000000000000000000";
const settings: TradeSettings = { name: "Agentic schedule", executionModel: "tradfi", settlementAsset: "USDT", entryWei: "5" + E, minEntryWei: "5" + E, capitalQuoteWei: "10" + E,
  maxOpenPositions: 1, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", cmcNewsEnabled: false,
  tradeMode: "schedule", scheduleToken: "0x2222222222222222222222222222222222222222", scheduleIntervalSec: 3600, scheduleFirstAtSec: null, scheduleEndKind: "runs",
  scheduleEndAtSec: null, scheduleEndRuns: 2, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 };
const facts = (usdt: string) => ({ readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0, x402DailyLimit: 0, x402QuotaUsed: 0,
  signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: usdt, bnbWei: "1" + E });
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
/** The wallet starts short of USDT; it is funded once `fund()` is called (the deposit landed). */
function server() {
  let usdt = "1" + E;
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/agentic/pairings") return Response.json({ data: { pairingId: "private-pairing", urlForWeb: "https://binance.test/qr", expireAtMs: NOW + 300_000 } });
    if (url === "/api/agentic/hire") return Response.json({ data: { walletAddress: W, hireEndMs: NOW + 604_800_000 } });
    return Response.json({ data: { state: "paired", walletAddress: W, codeAttemptsLeft: 5, facts: facts(usdt), continuationDeadlineMs: NOW + 1_800_000, failure: null } });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, fund: () => { usdt = "100" + E; } };
}
async function toFunding(go: (route: string) => void = () => undefined) {
  await act(async () => root!.render(<AgenticDeployModal settings={settings} go={go} onClose={() => undefined} onAltana={() => undefined} />));
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click());
  await act(async () => button("Next").click());
  await act(async () => button("Next").click());
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => button("Finalize pairing").click());
}

it("a deposit sent from the extension wallet closes the funding pop-up, says it is on its way, and the balances re-read on their own every 10 s", async () => {
  const { fetch, fund } = server();
  await toFunding();
  expect(button("Next").disabled).toBe(true);
  await act(async () => button("Send USDT from extension wallet").click());
  expect(node.querySelector('[data-testid="funds-modal"]')).not.toBeNull();
  await act(async () => button("Wallet sent").click());
  expect(node.querySelector('[data-testid="funds-modal"]')).toBeNull();
  expect(node.textContent).toContain("Deposit sent. Waiting for it to land in the Agentic Wallet.");
  const finalizes = () => fetch.mock.calls.filter(([url]) => url === "/api/agentic/pairings/private-pairing/finalize").length;
  const before = finalizes();
  fund();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(finalizes()).toBe(before + 1);
  expect(button("Next").disabled).toBe(false);
  expect(node.textContent).not.toContain("Deposit sent. Waiting");
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(finalizes()).toBe(before + 1);
});

it("a successful hire goes straight to the agent's read-only detail page", async () => {
  const { fund } = server();
  fund();
  const go = vi.fn();
  await toFunding(go);
  await act(async () => button("Next").click());
  await act(async () => button("Deploy Agentic Schedule buy").click());
  expect(go).toHaveBeenCalledWith("/agentic/" + W);
});
