// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_READ_EXPIRY_KEY } from "./read-session-window";
import { useAgentDetail } from "./use-agent-detail";

const sign = vi.hoisted(() => vi.fn());
vi.mock("./use-owner-actions", () => ({ useOwnerActions: () => ({ signEnvelope: sign }) }));
vi.mock("../trade", () => ({ parseTradeViewEnvelope: (value: unknown) => value }));
vi.mock("./agent-detail", () => ({
  mapAgentDetail: () => ({ id: "trader", hireSizingName: "trade-v1", armMs: null,
    grid: { pool: null, token0: "", token1: "" } }),
}));

let root: Root;
let container: HTMLDivElement;
function Probe() {
  const result = useAgentDetail("trader");
  return <div data-state={result.state} data-trade={result.trade === null ? "missing" : "loaded"}>{result.message}</div>;
}

describe("mounted detail read lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem(ACCOUNT_READ_EXPIRY_KEY, String(Date.now() + 86_400_000));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); localStorage.clear();
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  });

  function mockReads(ownerDelay = 0, tradeStatus = 200) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/agents/trader" && ownerDelay > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ownerDelay);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer); reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (url.endsWith("/trade/view")) return new Response(JSON.stringify({ settings: {}, open: [] }), { status: tradeStatus });
      return new Response(JSON.stringify({ data: { hireSizing: { name: "trade-v1" } } }));
    }));
  }

  it("loads Trading with the shared cookie and no signing ceremony", async () => {
    mockReads();
    await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
    expect(container.firstElementChild?.getAttribute("data-state")).toBe("ready");
    expect(container.firstElementChild?.getAttribute("data-trade")).toBe("loaded");
    expect(sign).not.toHaveBeenCalled();
  });

  it("shows a rejected session instead of leaving the resume spinner running", async () => {
    mockReads(0, 401);
    await act(async () => root.render(<Probe />));
    expect(container.firstElementChild?.getAttribute("data-state")).toBe("auth-expired");
    expect(localStorage.getItem(ACCOUNT_READ_EXPIRY_KEY)).toBeNull();
  });

  it("does not cancel a slow initial read at the next polling tick", async () => {
    mockReads(31_000);
    await act(async () => root.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(31_100));
    expect(container.firstElementChild?.getAttribute("data-state")).toBe("ready");
    expect(container.firstElementChild?.getAttribute("data-trade")).toBe("loaded");
  });

  it("stops a stalled read and reports unavailability instead of loading forever", async () => {
    mockReads(120_000);
    await act(async () => root.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(35_100));
    expect(container.firstElementChild?.getAttribute("data-state")).toBe("execution-unavailable");
    expect(sign).not.toHaveBeenCalled();
  });
});
