// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// The REAL HireGridDeploy restores the saved hire choices from a mount-time
// effect (the resume effect). Child effects run before the parent's, so this
// mock reproduces exactly that ordering against the screen's own `[id]`
// reset effect — the case the component tests cannot see with a `<div>` mock.
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({ walletAddress: "0x1111111111111111111111111111111111111111" }) }));
vi.mock("@/components/deploy/HireGridDeploy", () => ({
  HireGridDeploy: (props: { onRestoreChoices?: (record: unknown) => void; blockedReason?: string | null }) => {
    React.useEffect(() => {
      props.onRestoreChoices?.({ version: 1, agentId: "grid-agent-01", uiPresetId: "balanced", capitalBnb: "0.0971", utilizationPct: 50, maxRequotesDaily: 4, takeProfitPct: 0, stopLossPct: 0 });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="grid-deploy-props" data-blocked={String(props.blockedReason ?? "")} />;
  },
}));
vi.mock("@/components/deploy/HireLpDeploy", () => ({ HireLpDeploy: () => null }));
vi.mock("@/components/deploy/HireTradeDeploy", () => ({ HireTradeDeploy: () => null }));
vi.mock("@/components/deploy/TradeModelSelect", () => ({ TradeModelSelect: () => null }));

import { DeployAgentScreen } from "./DeployAgentScreen";

describe("grid deploy: restored hire choices survive the screen's own mount reset", () => {
  it("shows 50 / 4 / 0.0971 after a mount-time restore, not the defaults", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/pools") return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/agents/hire/preview?")) return new Response(JSON.stringify({ data: { sizing: { relayFeePerSubmitWei: "37600000000000" } } }), { headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const field = (label: string) => [...host.querySelectorAll(".fl-field")].find((entry) => entry.querySelector("label")?.textContent?.startsWith(label));
    const value = (label: string) => field(label)?.querySelector<HTMLInputElement>("input")?.value;
    try {
      await act(async () => { root.render(<DeployAgentScreen kind="grid" go={() => undefined} />); for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
      expect(value("Capital utilization")).toBe("50");
      expect(value("Max requotes daily")).toBe("4");
      expect(value("Total capital")).toBe("0.0971");
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
