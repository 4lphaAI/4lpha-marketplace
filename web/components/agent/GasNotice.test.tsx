import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttentionChip, GasNotice, gasAttention } from "./GasNotice";
import type { AgentGasView } from "@/lib/exec/agent-detail";

const WALLET = "0x1111111111111111111111111111111111111111";

function gas(over: Partial<AgentGasView> = {}): AgentGasView {
  return {
    nativeWei: "300000000000000", nextMotionWei: "155200000000000",
    warnWei: "465600000000000", blockWei: "77600000000000",
    state: "low", enforcement: "block", low: true, ...over,
  };
}

const render = (view: AgentGasView | null) =>
  renderToStaticMarkup(<GasNotice gas={view} walletAddress={WALLET} />);

describe("AGENT-GAS-ATTENTION §3.3 — the rendered gas notice", () => {
  it("a WARN-ONLY profile is never told it has stood down, on any branch", () => {
    // Finding 5, and finding 10 re-introduced it once already through the
    // UNKNOWN branch. Both branches are pinned here, because a liquidation
    // guard described as idle while it is still submitting reduced repays is
    // the worst available lie about it.
    for (const state of ["blocked", "low"] as const) {
      const html = render(gas({ state, enforcement: "warn-only", nativeWei: "1" }));
      expect(html, state).not.toMatch(/standing by|stands by|holds until/u);
      expect(html, state).toMatch(/keeps trying/u);
    }
    const unknown = render(gas({ state: "unknown", nativeWei: null, enforcement: "warn-only" }));
    expect(unknown).not.toMatch(/holds until it can be read/u);
    expect(unknown).toMatch(/keeps running regardless/u);
  });

  it("a BLOCKING profile does say it is standing by, including when unread", () => {
    // The control: a notice that said nothing alarming for anyone would pass
    // the test above while telling a real owner nothing.
    expect(render(gas({ state: "blocked", nativeWei: "1" }))).toMatch(/standing by/u);
    expect(render(gas({ state: "unknown", nativeWei: null }))).toMatch(/holds until it can be read/u);
  });

  it("renders nothing at all when the wallet is healthy", () => {
    expect(render(gas({ state: "ok", low: false, nativeWei: "999999999999999999" }))).toBe("");
    expect(render(null)).toBe("");
  });

  it("a warn-only shortfall is a chip that says Gas low, never Needs gas", () => {
    expect(gasAttention(gas({ state: "blocked", enforcement: "warn-only" }))).toBe("gas-low");
    expect(gasAttention(gas({ state: "blocked" }))).toBe("gas-blocked");
    expect(renderToStaticMarkup(<AttentionChip state={gasAttention(gas({ state: "blocked", enforcement: "warn-only" }))} />))
      .toMatch(/Gas low/u);
  });
});
