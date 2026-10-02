// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { paramsHash, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import { tradfiPortfolioNativeReserveWei, type TradeSettings } from "@/lib/trade";

const mocks = vi.hoisted(() => ({
  grant: vi.fn(), signEnvelope: vi.fn(),
  owner: { passkey: {}, walletAddress: "0x1111111111111111111111111111111111111111", ownerAddress: "0x2222222222222222222222222222222222222222" },
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({ ...mocks.owner, signEnvelope: mocks.signEnvelope }) }));
vi.mock("@/lib/altana/client", () => ({ grantAgentSession: mocks.grant, GrantAgentSessionError: class extends Error {} }));
vi.mock("@/lib/altana/cmc-budget", () => ({ executeCmcBudgetCalls: vi.fn(), validateCmcBudgetCallPlan: vi.fn(() => []) }));
vi.mock("@/components/FundsModal", () => ({ FundsModal: () => null }));

import { HireTradeDeploy } from "./HireTradeDeploy";

const TOKENS = ["0x02fca66c1d1afb4e2a7884261eb00f63598a7436", "0x80106cb3ead06659a5ad19df39d9b4733863b9b0"];
const CAP = tradfiPortfolioNativeReserveWei({ tokenCount: 2, intervalSec: 86400 }).toString();
const settings: TradeSettings = { name: "Portfolio", executionModel: "tradfi", entryWei: "50000000000000000000",
  minEntryWei: "100000000000000000", capitalQuoteWei: "50000000000000000000", settlementAsset: "USDT", maxOpenPositions: 1,
  minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
  breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null,
  primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false, cmcNewsEnabled: false,
  tradeMode: "portfolio", portfolioTokens: TOKENS, portfolioWeightsBps: [5000, 5000], portfolioDriftBps: 50, portfolioIntervalSec: 86400 };

let host: HTMLDivElement;
let root: Root | null;
const urls: string[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  urls.length = 0;
  mocks.signEnvelope.mockImplementation(async (_action: string, agentId: string, params: unknown): Promise<OwnerActionEnvelope> => ({
    signed: { owner: mocks.owner.ownerAddress, action: "provisionAgent", agentId, paramsHash: paramsHash("provisionAgent", params),
      nonce: `0x${"44".repeat(32)}`, issuedAt: "1", expiry: "9999999999" }, signature: "0xsignature", params,
  } as OwnerActionEnvelope));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; host.remove(); vi.unstubAllGlobals(); });

it("Smart Portfolio hire previews the local cap and signs both ordered arrays unchanged", async () => {
  const preview = { data: { capDayWei: CAP, indicative: true,
    sizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", executionModel: "tradfi", entryWei: settings.entryWei,
      settlementAsset: "USDT", minEntryWei: settings.minEntryWei, capitalQuoteWei: settings.capitalQuoteWei,
      cmcNewsEnabled: false, maxOpenPositions: 1, grantedTokenCount: 2, platformFeeBps: 0, platformFeePerEntryWei: "0",
      platformFeeTotalWei: "0", tradeRelayFeePerSubmitWei: "100000000000000", capitalRequiredWei: settings.capitalQuoteWei,
      capitalShortfallWei: "0", nativeReserveWei: CAP, nativeShortfallWei: "0", tradeMode: "portfolio", tokenCount: 2,
      intervalSec: 86400, depositQuoteWei: settings.capitalQuoteWei, ok: true },
    funding: { version: 1, observedAtSec: Math.floor(Date.now() / 1000), registrationFeeWei: "2", registrations: 1,
      relayGasHeadroomWei: "3", requiredWei: "5", balanceWei: "1000000000000000000", quoteAsset: "USDT",
      quoteRequiredWei: settings.capitalQuoteWei, quoteBalanceWei: settings.capitalQuoteWei, quoteShortfallWei: "0" },
    pin: [{ symbol: "NVDAB", address: TOKENS[0] }, { symbol: "MSFTB", address: TOKENS[1] }] } };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
    const url = String(input); urls.push(url);
    if (url.includes("/hire/preview")) return new Response(JSON.stringify(preview), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: { code: "test_stop" } }), { status: 400, headers: { "content-type": "application/json" } });
  }));
  await act(async () => { root!.render(<HireTradeDeploy agentName="Portfolio" executionModel="tradfi" capitalBnb="" settings={settings} go={() => undefined} />); });
  for (let index = 0; index < 8; index++) await act(async () => { await Promise.resolve(); });
  const previewUrl = urls.find((url) => url.includes("/hire/preview"));
  expect(previewUrl).toBeDefined();
  const query = new URL(previewUrl!, "http://local").searchParams;
  expect(query.get("capDayWei")).toBe(CAP);
  expect(query.get("tradeMode")).toBe("portfolio");
  expect(query.get("portfolioTokens")).toBe(TOKENS.join(","));
  expect(query.get("portfolioIntervalSec")).toBe("86400");
  const sign = [...host.querySelectorAll("button")].find((button) => button.textContent === "Sign hire and create the session key");
  expect(sign?.hasAttribute("disabled")).toBe(false);
  await act(async () => { sign?.click(); });
  expect(mocks.signEnvelope).toHaveBeenCalled();
  const params = mocks.signEnvelope.mock.calls.find((call) => call[0] === "provisionAgent")?.[2] as { settings: TradeSettings; capDayWei: string } | undefined;
  expect(params?.capDayWei).toBe(CAP);
  expect(params?.settings.portfolioTokens).toEqual(TOKENS);
  expect(params?.settings.portfolioWeightsBps).toEqual([5000, 5000]);
  expect(params?.settings.minEntryWei).toBe((10n ** 17n).toString());
  expect(params?.settings.portfolioDriftBps).toBe(50);
});
