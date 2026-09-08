// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const suggestion = vi.hoisted(() => ({ report: null as ((value: string | null) => void) | null }));

vi.mock("@/components/deploy/HireGridDeploy", () => ({ HireGridDeploy: ({ mode }: { mode: string }) => <span data-mode={mode} /> }));
vi.mock("@/components/deploy/HireLpDeploy", () => ({ HireLpDeploy: ({ mode }: { mode: string }) => <span data-mode={mode} /> }));
vi.mock("@/components/deploy/HireTradeDeploy", () => ({ HireTradeDeploy: () => <span data-mode="Live" /> }));
vi.mock("@/components/deploy/TradeModelSelect", () => ({ TradeModelSelect: () => null }));
vi.mock("@/components/deploy/HireLendingDeploy", () => ({
  HireLendingDeploy: (props: {
    readonly triggerHf: string; readonly targetHf: string; readonly maxRepayUsd: string;
    readonly rescueReserveCount: number; readonly cooldownSeconds: number; readonly reserveBps: number;
    readonly capitalBnb: string; readonly agentName: string; readonly mode: string;
    readonly onRepaySuggestion?: (value: string | null) => void;
  }) => { suggestion.report = props.onRepaySuggestion ?? null; return <button
    data-testid="lending-deploy-props"
    data-mode={props.mode}
    data-trigger={props.triggerHf}
    data-target={props.targetHf}
    data-max-repay={props.maxRepayUsd}
    data-count={String(props.rescueReserveCount)}
    data-cooldown={String(props.cooldownSeconds)}
    data-reserve-bps={String(props.reserveBps)}
    data-capital={props.capitalBnb}
    data-name={props.agentName}
  >Deploy Lending Agent</button>; },
}));
// The guarded-account stage owns its own fetch; the screen only has to SWAP it
// in for the section, which is what this file checks.
vi.mock("@/components/deploy/GuardedAccountSection", () => ({
  GuardedAccountSection: () => <div data-testid="guarded-account-section">guarded account stage</div>,
  guardedAccountBlocker: () => null,
  guardedAccountReady: () => true,
  emptyGuardedAccount: () => ({ account: "", editing: false, confirmed: false, view: null, reason: null, loading: false }),
}));

import { DeployAgentScreen } from "./DeployAgentScreen";

function html(): string {
  return renderToStaticMarkup(<DeployAgentScreen kind="health" go={() => undefined} />);
}

describe("lending deploy controls", () => {
  for (const kind of ["grid", "trading", "lp", "health"]) {
    it(`${kind} defaults to the actual Live hire flow`, () => {
      const rendered = renderToStaticMarkup(<DeployAgentScreen kind={kind} go={() => undefined} />);
      expect(rendered).toContain('data-mode="Live"');
      expect(rendered).not.toContain('data-mode="Demo"');
    });
  }
  // MARKETPLACE-LENDING-AGENT §2.2: these have NO wire seam. "Do not render, do
  // not stub" — a control the owner can move that changes nothing is a lie
  // about what they control.
  it("renders NONE of the controls §2.2 removes", () => {
    const rendered = html();
    for (const removed of [
      "Gas priority", "Slippage tolerance",
      "Send an alert every time the agent repays",
      "Oracle deviation guard", "Max gas price",
      "Allow a flash-loan repay",
      "Collateral asset", "Debt asset",
      "Lista",
      "Max actions per day",
      "Vault balance", "Sell collateral",
      // The sandbox and its SIM.health rows read as measured numbers.
      "SANDBOX", "Stress window", "Run backtest", "Lowest health factor",
    ]) {
      expect(rendered, removed).not.toContain(removed);
    }
  });

  it("renders exactly the §2.1/R2.17 controls, and the guarded-account stage first", () => {
    const rendered = html();
    for (const kept of [
      "Agent name", "Total capital",
      "guarded account stage",
      "Act below health factor", "Restore health factor to",
      "Reserve kept as BNB",
      "Max repay per event",
      "Rescues to reserve gas for",
      "Cooldown between repays",
    ]) {
      expect(rendered, kept).toContain(kept);
    }
    // R2.17: the control is named for what it does, and its hint says the guard
    // rescues beyond it anyway.
    expect(rendered).toContain("refusing a rescue is the trap it exists to avoid");
    // The guarded-account stage sits ABOVE the thresholds (R3.3's stage order).
    expect(rendered.indexOf("guarded account stage"))
      .toBeLessThan(rendered.indexOf("Act below health factor"));
  });

  it("hands the hire component the operator's 1.20 / 1.50 defaults and a 2000 bps reserve", () => {
    const rendered = html();
    expect(rendered).toContain("data-trigger=\"1.20\"");
    expect(rendered).toContain("data-mode=\"Live\"");
    expect(rendered).toContain("data-target=\"1.50\"");
    expect(rendered).toContain("data-reserve-bps=\"2000\"");
    expect(rendered).toContain("data-count=\"6\"");
    expect(rendered).toContain("data-cooldown=\"300\"");
    expect(rendered).toContain("data-max-repay=\"\"");
    expect(rendered).toContain("data-capital=\"0.05\"");
  });

  it("keeps the mock's Deploy button off the page — the hire machine owns it now", () => {
    const rendered = html();
    expect(rendered).toContain("Deploy Lending Agent");
    // The design export's inert action row (with its "Reset to preset" twin) is
    // replaced, not rendered beside the real one.
    expect(rendered).not.toContain("Reset to preset");
  });
});

/* -------------------------------------------------------------------------- */
/* W8 — §2.2 checked STRUCTURALLY, not by string search                       */
/* -------------------------------------------------------------------------- */

describe("§2.2 removals, structurally", () => {
  // A string search over the markup passes if a control is renamed, and passes
  // if it is rendered with an empty label. What §2.2 forbids is a CONTROL — a
  // select, an input, a textarea — the owner can move that reaches no wire. So
  // enumerate the controls the page actually renders and check each one's own
  // identity (label, name, id, placeholder, aria-label, adjacent text) against
  // the removed set.
  const REMOVED = [
    /gas\s*priority/iu, /priority\s*fee/iu, /max\s*gas/iu,
    /slippage/iu, /alert/iu, /oracle\s*deviation/iu,
    /flash[-\s]?loan/iu, /lista/iu, /collateral\s*asset/iu, /debt\s*asset/iu,
    /max\s*actions\s*per\s*day/iu, /vault\s*balance/iu, /sell\s*collateral/iu,
    /stress\s*window/iu, /backtest/iu,
  ];

  function controls(): { readonly tag: string; readonly identity: string }[] {
    const holder = document.createElement("div");
    holder.innerHTML = html();
    const out: { tag: string; identity: string }[] = [];
    for (const node of holder.querySelectorAll("input, select, textarea")) {
      const field = node.closest(".fl-field") ?? node.parentElement;
      const label = field?.querySelector("label")?.textContent
        ?? node.previousElementSibling?.textContent
        ?? "";
      out.push({
        tag: node.tagName.toLowerCase(),
        identity: [
          label,
          node.getAttribute("name") ?? "",
          node.getAttribute("id") ?? "",
          node.getAttribute("placeholder") ?? "",
          node.getAttribute("aria-label") ?? "",
          // A checkbox carries its meaning in the text beside it.
          node.parentElement?.textContent ?? "",
        ].join(" "),
      });
    }
    return out;
  }

  it("renders no control whose own identity matches anything §2.2 removes", () => {
    const rendered = controls();
    // If this is zero the assertion below is vacuous — the lending screen does
    // render controls, and this test must fail loudly if it stops.
    expect(rendered.length).toBeGreaterThan(3);
    for (const control of rendered) {
      for (const pattern of REMOVED) {
        expect(pattern.test(control.identity), `${control.tag} "${control.identity.trim().slice(0, 80)}"`).toBe(false);
      }
    }
  });

  it("the identity extractor is not blind — it sees the controls §2.1 KEEPS", () => {
    const identities = controls().map((control) => control.identity).join(" | ");
    for (const kept of ["Act below health factor", "Restore health factor to", "Reserve kept as BNB", "Cooldown between repays"]) {
      expect(identities, kept).toContain(kept);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* W6 — no silent clamps between the field and the envelope                   */
/* -------------------------------------------------------------------------- */

describe("typed control values are never silently clamped", () => {
  let host: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host.remove();
    vi.unstubAllGlobals();
  });

  function field(label: string): HTMLInputElement {
    const found = [...host.querySelectorAll(".fl-field")]
      .find((entry) => entry.querySelector("label")?.textContent === label)
      ?.querySelector("input");
    if (!found) throw new Error(`No field "${label}"`);
    return found as HTMLInputElement;
  }

  function props(): Record<string, string> {
    const node = host.querySelector("[data-testid=\"lending-deploy-props\"]");
    const out: Record<string, string> = {};
    for (const attribute of node?.attributes ?? []) out[attribute.name] = attribute.value;
    return out;
  }

  async function type(label: string, value: string): Promise<void> {
    const input = field(label);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The blur is where the old clamp fired, so it is part of the test.
    await act(async () => { input.dispatchEvent(new Event("blur", { bubbles: true })); });
  }

  it("uses suggestions until edited, preserves manual input through presets, and resets explicitly", async () => {
    await act(async () => { root!.render(<DeployAgentScreen kind="health" go={() => undefined} />); });
    expect(field("Max repay per event").value).toBe("");
    await act(async () => { suggestion.report!("8.00"); });
    expect(field("Max repay per event").value).toBe("8.00");
    await act(async () => { suggestion.report!("6.25"); });
    expect(props()["data-max-repay"]).toBe("6.25");
    await type("Max repay per event", "5.35");
    await act(async () => { suggestion.report!("3.00"); });
    expect(props()["data-max-repay"]).toBe("5.35");
    const preset = [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("Conservative"));
    await act(async () => { preset!.click(); });
    expect(props()["data-max-repay"]).toBe("5.35");
    const reset = [...host.querySelectorAll("button")].find(button => button.textContent === "Reset parameters to defaults");
    await act(async () => { reset!.click(); });
    await act(async () => { suggestion.report!("4.00"); });
    expect(props()["data-max-repay"]).toBe("4.00");
  });

  it("steps repayment by exactly one while preserving fractional amounts", async () => {
    await act(async () => { root!.render(<DeployAgentScreen kind="health" go={() => undefined} />); });
    await act(async () => { suggestion.report!("8.35"); });
    const control = field("Max repay per event").closest(".fl-field")!;
    await act(async () => { control.querySelector<HTMLButtonElement>('[aria-label="Increase"]')!.click(); });
    expect(props()["data-max-repay"]).toBe("9.35");
    await act(async () => { control.querySelector<HTMLButtonElement>('[aria-label="Decrease"]')!.click(); });
    expect(props()["data-max-repay"]).toBe("8.35");
    await act(async () => { suggestion.report!("3.00"); });
    expect(props()["data-max-repay"]).toBe("8.35");
    await type("Max repay per event", "0.35");
    const decrease = control.querySelector<HTMLButtonElement>('[aria-label="Decrease"]')!;
    expect(decrease.disabled).toBe(true);
    await act(async () => { decrease.click(); });
    expect(props()["data-max-repay"]).toBe("0.35");
  });

  // The exact case in the audit: a cooldown of 100 must NEVER become a signed
  // 300. Below the floor is a refusal the owner can see, not a number the
  // screen quietly substitutes.
  it("a typed cooldown of 100 stays 100 on screen and reaches the hire component as 100", async () => {
    await act(async () => { root!.render(<DeployAgentScreen kind="health" go={() => undefined} />); });
    expect(props()["data-cooldown"]).toBe("300");

    await type("Cooldown between repays", "100");
    expect(field("Cooldown between repays").value).toBe("100");
    expect(props()["data-cooldown"]).toBe("100");
    expect(props()["data-cooldown"]).not.toBe("300");
    // And the field says why, in its own red hint, before any signature.
    expect(host.textContent).toContain("Minimum 300");
  });

  it("passes an out-of-range rescue count and reserve split through unclamped", async () => {
    await act(async () => { root!.render(<DeployAgentScreen kind="health" go={() => undefined} />); });

    await type("Rescues to reserve gas for", "99");
    expect(props()["data-count"]).toBe("99");

    await type("Reserve kept as BNB", "80");
    expect(props()["data-reserve-bps"]).toBe("8000");

    await type("Reserve kept as BNB", "5");
    expect(props()["data-reserve-bps"]).toBe("500");
    expect(host.textContent).toContain("Minimum 10");
  });

  it("a BLANK field still falls back to its default — a default is not a clamp", async () => {
    await act(async () => { root!.render(<DeployAgentScreen kind="health" go={() => undefined} />); });
    await type("Cooldown between repays", "");
    await type("Rescues to reserve gas for", "");
    expect(props()["data-cooldown"]).toBe("300");
    expect(props()["data-count"]).toBe("6");
  });
});
