// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, it, expect, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";
afterEach(() => { vi.unstubAllGlobals(); });
it("Agentic public page only polls the wallet projection and exposes no owner controls", async () => {
  const wallet = "0x" + "22".repeat(20), calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return new Response(JSON.stringify({ data: { wallet, custody: "binance-agentic", agent: null } }), { status: 200 }); });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"), root = createRoot(node);
  await act(async () => { root.render(<AgenticPublicScreen wallet={wallet} />); await Promise.resolve(); });
  expect(node.textContent).toContain("No Agentic hire found for this wallet.");
  expect(calls).toEqual(["/api/agentic/wallets/" + wallet]);
  expect(node.querySelectorAll("button").length).toBe(0);
  expect(node.textContent).toContain("Read-only");
  await act(async () => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
