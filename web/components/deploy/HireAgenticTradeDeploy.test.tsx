// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import type { TradeSettings } from "@/lib/trade";
const settings: TradeSettings = { name: "Agentic", executionModel: "tradfi", entryWei: "5000000000000000000", maxOpenPositions: 2,
  minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b" };
vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => ({}) }));
const button = (node: HTMLElement, text: string) => [...node.querySelectorAll("button")].find(b => b.textContent === text)!;
async function mount(onAltana = vi.fn()) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"), root = createRoot(node);
  await act(async () => root.render(<AgenticDeployModal settings={settings} go={() => undefined} onClose={() => undefined} onAltana={onAltana} />));
  return { node, root, done: async () => { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; } };
}
it("Agentic hire requires an explicit term-end choice with CMC locked on", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { node, done } = await mount();
  expect(button(node, "Next").disabled).toBe(true);
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click());
  await act(async () => button(node, "Next").click());
  expect(node.textContent).toContain("Agentic Wallet term");
  const options = [...node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
  expect(options.filter(o => o.textContent!.includes("term end")).every(o => o.getAttribute("aria-pressed") === "false")).toBe(true);
  expect(button(node, "Next").disabled).toBe(true);
  expect(node.querySelector('input[type="checkbox"]')).toBeNull();
  await act(async () => button(node, "Keep holdings at term end").click()); expect(button(node, "Next").disabled).toBe(false);
  await act(async () => button(node, "30 days").click());
  expect(node.textContent).toContain("Total budget 8 USDT");
  expect(fetch).not.toHaveBeenCalled();
  await done(); vi.unstubAllGlobals();
});
it("choosing Altana hands back to the passkey hire without touching the Agentic routes", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const onAltana = vi.fn(); const { node, done } = await mount(onAltana);
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[0]!.click());
  await act(async () => button(node, "Next").click());
  expect(onAltana).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  await done(); vi.unstubAllGlobals();
});
it("a blocked Altana hire refuses that choice with its reason while Agentic stays open", async () => {
  vi.stubGlobal("fetch", vi.fn());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"), root = createRoot(node), onAltana = vi.fn();
  await act(async () => root.render(<AgenticDeployModal settings={settings} go={() => undefined} onClose={() => undefined} onAltana={onAltana} altanaBlockedReason="Sign in with your passkey first." />));
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[0]!.click());
  expect(node.textContent).toContain("Sign in with your passkey first."); expect(button(node, "Next").disabled).toBe(true);
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click());
  expect(button(node, "Next").disabled).toBe(false); expect(onAltana).not.toHaveBeenCalled();
  await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; vi.unstubAllGlobals();
});
