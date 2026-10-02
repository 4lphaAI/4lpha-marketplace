// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paramsHash, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import { dcaNativeReserveWei, type TradeSettings } from "@/lib/trade";

// AUTO-DCA §14.2 + R2.9: the DCA hire signs `capDayWei` from the `dcaNativeReserveWei` mirror,
// shows the fee-inclusive funding copy, and stays at 2 passkey prompts (+ MetaMask when short).
const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  signEnvelope: vi.fn(),
  owner: { passkey: {}, walletAddress: "0x1111111111111111111111111111111111111111", ownerAddress: "0x2222222222222222222222222222222222222222" },
}));

vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({ ...mocks.owner, signEnvelope: mocks.signEnvelope }) }));
vi.mock("@/lib/altana/client", () => ({ grantAgentSession: mocks.grant, GrantAgentSessionError: class extends Error {} }));
vi.mock("@/lib/altana/cmc-budget", () => ({ executeCmcBudgetCalls: vi.fn(), validateCmcBudgetCallPlan: vi.fn(() => []) }));
vi.mock("@/components/FundsModal", () => ({
  FundsModal: ({ onClose }: { readonly onClose: () => void }) => <button onClick={onClose}>Close deposit</button>,
}));

import { HireTradeDeploy } from "./HireTradeDeploy";

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const CAP = dcaNativeReserveWei(4).toString(10);
const settings: TradeSettings = {
  name: "Auto DCA 01", executionModel: "tradfi", entryWei: "15000000000000000000", maxOpenPositions: 1, minMarketCapUsd: null, maxMarketCapUsd: null,
  noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard",
  instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false,
  settlementAsset: "USDT", minEntryWei: "15000000000000000000", capitalQuoteWei: "55000000000000000000", cmcNewsEnabled: false,
  tradeMode: "dca", dcaToken: NVDAB, dcaStepBps: 100, dcaStepMultiplierBps: 12_000, dcaTakeProfitBps: 150, dcaOrderWei: "10000000000000000000",
  dcaMaxOrders: 4, dcaTriggerPriceE8: null, dcaRangeMinE8: null, dcaRangeMaxE8: null, dcaStopLossBps: null,
};

function envelope(agentId: string, signedParams: unknown): OwnerActionEnvelope {
  return { signed: { owner: mocks.owner.ownerAddress, action: "provisionAgent", agentId, paramsHash: paramsHash("provisionAgent", signedParams),
    nonce: `0x${"44".repeat(32)}`, issuedAt: "1", expiry: "9999999999" }, signature: "0xsignature", params: signedParams } as OwnerActionEnvelope;
}

function preview(balanceWei: string, quoteBalanceWei: string, economics: Record<string, unknown> | null = null) {
  return {
    capDayWei: CAP,
    sizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", executionModel: "tradfi", entryWei: settings.entryWei, settlementAsset: "USDT",
      minEntryWei: settings.minEntryWei, capitalQuoteWei: settings.capitalQuoteWei, cmcNewsEnabled: false, maxOpenPositions: 1, grantedTokenCount: 1,
      platformFeeBps: 0, platformFeePerEntryWei: "0", platformFeeTotalWei: "0", tradeRelayFeePerSubmitWei: "100000000000000",
      capitalRequiredWei: "55000000000000000000", capitalShortfallWei: "0", nativeReserveWei: CAP, nativeShortfallWei: "0", tradeMode: "dca",
      depositQuoteWei: "55000000000000000000", usdtDayCapWei: "275000000000000000000", roundsPerDayAtCap: { noFill: 18, full: 5 }, economics, ok: true },
    funding: { version: 1, observedAtSec: Math.floor(Date.now() / 1_000), registrationFeeWei: "2", registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5",
      balanceWei, quoteAsset: "USDT", quoteRequiredWei: "55000000000000000000", quoteBalanceWei,
      quoteShortfallWei: BigInt(quoteBalanceWei) >= 55_000_000_000_000_000_000n ? "0" : (55_000_000_000_000_000_000n - BigInt(quoteBalanceWei)).toString(10) },
    pin: [{ symbol: "NVDAB", address: NVDAB }],
    indicative: true,
  };
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

let host: HTMLDivElement;
let root: Root | null;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const previewUrls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  previewUrls.length = 0;
  mocks.signEnvelope.mockImplementation(async (_action: string, agentId: string, signedParams: unknown) => envelope(agentId, signedParams));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function runLedger(balances: readonly (readonly [string, string])[], economics: Record<string, unknown> | null = null): Promise<string[]> {
  let reads = 0;
  let sessionView: Record<string, unknown> = { status: "provisioning", hireRunId: "", missing: ["account-key"], permissions: { calls: [], spend: [] },
    sessionPublicKey: `0x${"33".repeat(65)}`, sessionAddress: "0x3333333333333333333333333333333333333333", expiresAt: 9_999_999_999 };
  mocks.grant.mockImplementation(async () => { sessionView = { ...sessionView, status: "armed", missing: [] }; return {}; });
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/hire/preview")) {
      previewUrls.push(url);
      const [native, quote] = balances[Math.min(reads++, balances.length - 1)] ?? ["0", "0"];
      return response(preview(native, quote, economics));
    }
    if (url.endsWith("/session/grant-attempt") && init?.method === "POST") {
      sessionView = { ...sessionView, grantAttempt: { version: 1, attemptId: `0x${"55".repeat(32)}`, startedAtSec: 100 } };
      return response({ ...sessionView, attemptId: `0x${"55".repeat(32)}`, mayInvoke: true });
    }
    if (url.endsWith("/session") && init?.method === "POST") {
      const submitted = JSON.parse(String(init.body)) as OwnerActionEnvelope;
      sessionView = { ...sessionView, hireRunId: (submitted.params as { hireRunId: string }).hireRunId };
      return response({ ...sessionView, readSession: { expiry: Math.floor(Date.now() / 1_000) + 900 } });
    }
    if (url.endsWith("/session")) return response(sessionView);
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => { root!.render(<HireTradeDeploy agentName={settings.name} executionModel="tradfi" capitalBnb="" settings={settings} go={vi.fn()} />); });
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
  const sign = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Sign hire and create the session key");
  if (sign === undefined) throw new Error(`Sign button missing: ${host.textContent}`);
  await act(async () => { sign.click(); await vi.advanceTimersByTimeAsync(0); });
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
  for (let index = 0; index < 4; index += 1) await act(async () => { await vi.advanceTimersByTimeAsync(6_001); });
  for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); });
  const entries = mocks.signEnvelope.mock.calls.map((call, index) => ({ order: mocks.signEnvelope.mock.invocationCallOrder[index]!, label: String(call[0]) }));
  entries.push(...mocks.grant.mock.invocationCallOrder.map((order) => ({ order, label: "grant" })));
  return entries.sort((left, right) => left.order - right.order).map((entry) => entry.label);
}

describe("the Auto DCA hire (§14.2)", () => {
  it("signs capDayWei from the dcaNativeReserveWei mirror and previews with the DCA tuple", async () => {
    const funded = "100000000000000000000";
    expect(await runLedger([[funded, funded]])).toEqual(["provisionAgent", "grant"]);
    const query = new URL(previewUrls[0]!, "http://local").searchParams;
    expect(query.get("capDayWei")).toBe(CAP);
    expect(CAP).toBe("3840000000000000");
    expect(query.get("tradeMode")).toBe("dca");
    expect(query.get("dcaToken")).toBe(NVDAB);
    expect(query.get("dcaStepBps")).toBe("100");
    expect(query.get("dcaTakeProfitBps")).toBe("150");
    expect(query.get("dcaOrderWei")).toBe("10000000000000000000");
    expect(query.get("dcaMaxOrders")).toBe("4");
    const signed = mocks.signEnvelope.mock.calls[0]![2] as { capDayWei: string; settings: TradeSettings };
    expect(signed.capDayWei).toBe(CAP);
    expect(signed.settings.tradeMode).toBe("dca");
  });

  it("HIRE-SIGNATURES-BC keeps a short DCA hire at 2 passkey prompts plus the wallet deposit", async () => {
    const observed = await runLedger([["0", "0"], ["0", "0"], ["100000000000000000000", "0"], ["100000000000000000000", "100000000000000000000"]]);
    expect(observed).toEqual(["provisionAgent", "grant"]);
  });

  it("shows the principal-only funding copy (Auto DCA charges no platform fee), the one-stock line, and the negative economics lines", async () => {
    const funded = "100000000000000000000";
    fetchMock = vi.fn<typeof fetch>(async () => response(preview(funded, funded, {
      r0CostUsdtWei: "400000000000000000", r0GrossUsdtWei: "300000000000000000", holdEngagesAtGwei: 0.0375,
      perFillNetUsdtWei: "-48000000000000000", gasPriceGwei: 0.05 })));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => { root!.render(<HireTradeDeploy agentName={settings.name} executionModel="tradfi" capitalBnb="" settings={settings} go={vi.fn()} />); });
    for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
    const text = host.textContent ?? "";
    expect(text).toContain("USDT principal 55. 0.00384 BNB covers one busy round a day.");
    expect(text).not.toContain("platform fee");
    expect(text).toContain("This agent trades only NVDAB.");
    expect(host.querySelector('[data-testid="dca-hold-line"]')?.textContent).toBe("At today's gas this agent would wait before starting a round: NVDAB at TP 1.5 % needs gas below 0.0375 gwei.");
    expect(host.querySelector('[data-testid="dca-fill-line"]')?.textContent).toContain("costs about 0.048 USDT more than it earns");
  });
});
