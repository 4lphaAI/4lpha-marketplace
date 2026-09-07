// @vitest-environment happy-dom
/**
 * The demo LIST and the demo DETAIL screen.
 *
 * Most of what is asserted is what these must NOT do, because they are the two
 * screens whose whole value is being honest about simulated figures.
 *
 * The list's own shape is pinned too: ONE row per demo. It used to be a stack
 * of full cards, each repeating five metrics, a ladder and the entire omissions
 * list — three demos put the same small print on the page three times and
 * pushed the footer off the horizon. Repetition past the first copy is not
 * extra honesty, it is noise a reader learns to skip.
 */
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DemoAgentView } from "@/lib/demo/client";

const api = vi.hoisted(() => ({
  listDemoAgents: vi.fn(),
  readDemoAgent: vi.fn(),
  readDemoFills: vi.fn(),
  stopDemoAgent: vi.fn(),
}));
vi.mock("@/lib/demo/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/demo/client")>("@/lib/demo/client");
  return { ...actual, ...api };
});

const { DemoAgentPanel } = await import("./DemoAgentPanel");
const { DemoAgentDetail } = await import("./DemoAgentDetail");

function gridAgent(patch: Partial<DemoAgentView> = {}, detail: Record<string, unknown> = {}): DemoAgentView {
  return {
    id: "demo-1",
    kind: "grid",
    name: "Demo Grid Agent",
    status: "running",
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_600_000_000,
    lastTickAtMs: Date.now() - 20_000,
    holdReason: null,
    detail: {
      pool: "0x36696169c63e42cd08ce11f5deebbcebae652050",
      quoteSymbol: "WBNB",
      baseSymbol: "USDT",
      budgetQuoteWei: "209400000000000000",
      tickSpacing: 10,
      wbnbIsToken0: false,
      currentTick: -66177,
      currentTickAtMs: Date.now() - 30_000,
      levels: [
        { level: 1, role: "buy", range: { tickLower: -66490, tickUpper: -66290 }, cycles: 2, realisedQuoteWei: "4184996989322786" },
      ],
      flips: 3,
      cycles: 2,
      realisedQuoteWei: "4184996989322786",
      gasChargedQuoteWei: "200000000000000",
      netQuoteWei: "3984996989322786",
      ...detail,
    } as DemoAgentView["detail"],
    detailUnavailableReason: null,
    disclosure: { simulated: true, omits: ["fees earned while the price sits inside a range"] },
    txHash: null,
    tokenId: null,
    erc8004AgentId: null,
    callsId: null,
    ...patch,
  };
}

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(node);
  });
  return host;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.readDemoFills.mockResolvedValue({ fills: [], disclosure: { simulated: true, omits: [] } });
  document.body.innerHTML = "";
});

describe("demo list", () => {
  it("is ONE row per demo, and opens the detail screen", async () => {
    api.listDemoAgents.mockResolvedValue({ agents: [gridAgent(), gridAgent({ id: "demo-2" })] });
    const go = vi.fn();
    const host = await mount(<DemoAgentPanel go={go} />);

    const rows = host.querySelectorAll("button");
    expect(rows.length).toBe(2);
    await act(async () => {
      rows[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(go).toHaveBeenCalledWith("/demo/demo-1");

    // The clutter is GONE: no per-row metrics and no repeated small print.
    const text = host.textContent ?? "";
    expect(text).not.toContain("does not account for");
    expect(text).not.toContain("GAS CHARGED");
    expect(text).not.toContain("Show activity");
  });

  it("renders nothing at all when the visitor has no demos", async () => {
    api.listDemoAgents.mockResolvedValue({ agents: [] });
    const host = await mount(<DemoAgentPanel go={vi.fn()} />);
    expect(host.textContent).toBe("");
  });

  it("says why rather than showing an empty list when the read fails", async () => {
    api.listDemoAgents.mockRejectedValue(new Error("down"));
    const host = await mount(<DemoAgentPanel go={vi.fn()} />);
    expect(host.textContent).toContain("could not be loaded");
  });
});

describe("demo detail", () => {
  it("draws the rungs and the price marker when a price has been read", async () => {
    api.readDemoAgent.mockResolvedValue({ agent: gridAgent() });
    const host = await mount(<DemoAgentDetail demoId="demo-1" go={vi.fn()} />);

    const bars = host.querySelectorAll("[title*='rung']");
    expect(bars.length).toBe(1);
    expect(bars[0]?.getAttribute("title")).toContain("Level 1 buy rung");
    expect(host.querySelector("[title*='price at tick']")).not.toBeNull();
    expect(host.textContent).toContain("Price read");
  });

  it("says the price has not been read rather than drawing a marker at zero", async () => {
    api.readDemoAgent.mockResolvedValue({
      agent: gridAgent({}, { currentTick: null, currentTickAtMs: null }),
    });
    const host = await mount(<DemoAgentDetail demoId="demo-1" go={vi.fn()} />);
    expect(host.querySelector("[title*='price at tick']")).toBeNull();
    expect(host.textContent).toContain("has not been read yet");
  });

  it("never renders a transaction hash, an NFT id or a registry id", async () => {
    api.readDemoAgent.mockResolvedValue({ agent: gridAgent() });
    const host = await mount(<DemoAgentDetail demoId="demo-1" go={vi.fn()} />);
    const text = host.textContent ?? "";
    expect(text).not.toMatch(/0x[0-9a-f]{64}/iu);
    expect(text).not.toContain("8004");
    // Uppercased by CSS, so the DOM text keeps the lower-case source.
    expect(text).toContain("(simulated)");
    expect(text).toContain("does not account for");
  });

  it("explains a 404 as a browser-scoped demo rather than a missing one", async () => {
    const { DemoError } = await import("@/lib/demo/client");
    api.readDemoAgent.mockRejectedValue(new DemoError("not_found"));
    const host = await mount(<DemoAgentDetail demoId="demo-1" go={vi.fn()} />);
    expect(host.textContent).toContain("not created in this browser");
  });

  it("shows a dash with a reason instead of figures it could not read", async () => {
    api.readDemoAgent.mockResolvedValue({
      agent: gridAgent({ detail: null, detailUnavailableReason: "This demo's saved figures could not be read." }),
    });
    const host = await mount(<DemoAgentDetail demoId="demo-1" go={vi.fn()} />);
    expect(host.textContent).toContain("could not be read");
    expect(host.querySelector("[title*='rung']")).toBeNull();
  });

  it("surfaces a hold reason rather than hiding it behind the numbers", async () => {
    api.readDemoAgent.mockResolvedValue({
      agent: gridAgent({ holdReason: "The pool's price could not be read this cycle." }),
    });
    const host = await mount(<DemoAgentDetail demoId="demo-1" go={vi.fn()} />);
    expect(host.textContent).toContain("The pool's price could not be read this cycle.");
  });

  it("distinguishes a failed history read from an empty one", async () => {
    api.readDemoAgent.mockResolvedValue({ agent: gridAgent() });
    api.readDemoFills.mockRejectedValue(new Error("down"));
    const host = await mount(<DemoAgentDetail demoId="demo-1" go={vi.fn()} />);
    expect(host.textContent).toContain("history could not be read");
    expect(host.textContent).not.toContain("no fills yet");
  });
});
