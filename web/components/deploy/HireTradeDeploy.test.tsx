import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TradeSettings } from "@/lib/trade";

vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({ passkey: null, walletAddress: undefined, ownerAddress: undefined, signReadHeader: vi.fn(), signEnvelope: vi.fn() }) }));
vi.mock("@/lib/altana/client", () => ({ grantAgentSession: vi.fn(), GrantAgentSessionError: class GrantAgentSessionError extends Error {} }));

import { HireTradeDeploy } from "./HireTradeDeploy";

const settings: TradeSettings = {
  name: "Trading Agent 01",
  executionModel: "blue-chip",
  entryWei: "20000000000000000",
  maxOpenPositions: 3,
  minMarketCapUsd: 1_000_000_000,
  maxMarketCapUsd: null,
  noReentry: true,
  takeProfitBps: 4_000,
  stopLossBps: 2_500,
  maxHoldSec: 86_400,
  breakEvenAfterTp: true,
  slippageBps: 300,
  gasPriority: "standard",
  instructions: null,
  skillMarkdown: null,
  primaryModel: "0gm-1.0-35b-a3b",
  fallbackModel: "qwen3-vl-30b",
};

describe("trade deploy sizing guard", () => {
  it("disables the hire action and shows the R2 minimum when capital is too small", () => {
    const html = renderToStaticMarkup(<HireTradeDeploy agentName={settings.name} executionModel="blue-chip" capitalBnb="0.02" settings={settings} go={() => undefined} />);
    expect(html).toContain("Total capital is too small. Raise it to at least 0.0659 BNB.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign hire and create the session key<\/button>/u);
  });

  it("refuses below the capital floor and enables0.01 with25 tokens", () => {
    const compact = { ...settings, entryWei: "2000000000000000", maxOpenPositions: 3 };
    const html = renderToStaticMarkup(<HireTradeDeploy agentName={compact.name} executionModel="blue-chip" capitalBnb="0.009" settings={compact} go={() => undefined} />);
    expect(html).toContain("Raise it to at least 0.01 BNB.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign hire and create the session key<\/button>/u);
    const enough = renderToStaticMarkup(<HireTradeDeploy agentName={compact.name} executionModel="blue-chip" capitalBnb="0.01" settings={compact} go={() => undefined} />);
    expect(enough).not.toMatch(/<button[^>]*disabled=""[^>]*>Sign hire and create the session key<\/button>/u);
  });

  it("disables when the exact form tuple exceeds total capital", () => {
    const html = renderToStaticMarkup(<HireTradeDeploy agentName={settings.name} executionModel="sigma" capitalBnb="0.03" settings={settings} go={() => undefined} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign hire and create the session key<\/button>/u);
  });
});

it.each(["mid-cap", "degen"] as const)("retains25-token sizing for %s", executionModel => {
  const compact = { ...settings, executionModel, entryWei: "2000000000000000", maxOpenPositions: 3 };
  const html = renderToStaticMarkup(<HireTradeDeploy agentName={compact.name} executionModel={executionModel} capitalBnb="0.01" settings={compact} go={() => undefined} />);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Sign hire and create the session key<\/button>/u);
});
