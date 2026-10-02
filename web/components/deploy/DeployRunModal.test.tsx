// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployRunModal, IDLE_DEPLOY_STEPS, type DeployStep, type DeployStepDef, type DeployStepKey } from "./DeployRunModal";

const STEPS: readonly DeployStepDef[] = [
  { key: "hire", title: "Sign the hire", hint: "hire hint" },
  { key: "fund", title: "Fund the agent wallet", hint: "fund hint" },
  { key: "grant", title: "Grant the session on chain", hint: "grant hint" },
  { key: "converge", title: "Verify the grant", hint: "converge hint" },
  { key: "arm", title: "Arm the grid", hint: "arm hint" },
];

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

type Props = React.ComponentProps<typeof DeployRunModal>;
function steps(patch: Partial<Record<DeployStepKey, DeployStep>>): Record<DeployStepKey, DeployStep> {
  return { ...IDLE_DEPLOY_STEPS, ...patch };
}
async function show(props: Partial<Props>): Promise<void> {
  await act(async () => {
    root!.render(<DeployRunModal label="Grid Agent" color="var(--cat-grid)" agentId="grid-agent-1"
      stepDefs={STEPS} steps={IDLE_DEPLOY_STEPS} running={false} {...props} />);
  });
}
const dialog = (): HTMLElement | null => document.body.querySelector("[role='dialog']");
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}
const stateOf = (key: DeployStepKey): string | null =>
  document.body.querySelector(`[data-step='${key}']`)?.getAttribute("data-state") ?? null;

describe("DeployRunModal", () => {
  it("renders nothing before a run starts", async () => {
    await show({});
    expect(dialog()).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("portals the running popup to the body with the finished count", async () => {
    await show({ running: true, steps: steps({ hire: { state: "done" }, fund: { state: "skipped" }, grant: { state: "active", detail: "Relay submitting…" } }) });
    expect(dialog()?.getAttribute("aria-label")).toBe("Deploying Grid Agent");
    expect(host.contains(dialog())).toBe(false);
    expect(dialog()?.textContent).toContain("2/5");
    expect(dialog()?.textContent).toContain("Relay submitting…");
    expect(dialog()?.textContent).toContain("grid-agent-1");
    expect(stateOf("grant")).toBe("active");
  });

  it("hides on Hide and comes back on Show progress", async () => {
    await show({ running: true, steps: steps({ hire: { state: "active" } }) });
    await act(async () => { button("Hide").click(); });
    expect(dialog()).toBeNull();
    expect(host.textContent).toContain("Deploying Grid Agent");
    await act(async () => { button("Show progress").click(); });
    expect(dialog()).not.toBeNull();
  });

  it("surfaces again when a new run starts after being hidden", async () => {
    await show({ running: false, steps: steps({ hire: { state: "failed", detail: "No." } }), message: "No." });
    await act(async () => { button("Close").click(); });
    expect(dialog()).toBeNull();
    await show({ running: true, steps: steps({ hire: { state: "active" } }) });
    expect(dialog()).not.toBeNull();
  });

  it("survives a switch between branch roots when keyed, as the hire components render it", async () => {
    // The hire components render `{deployModal}` (key="deploy-run") inside a
    // different root <div> per branch; a hidden popup must stay hidden across
    // the switch into the arm branch rather than remounting.
    const running = steps({ hire: { state: "done" }, converge: { state: "active" } });
    const modal = <DeployRunModal key="deploy-run" label="Grid Agent" color="var(--cat-grid)" agentId="grid-agent-1"
      stepDefs={STEPS} steps={running} running />;
    await act(async () => { root!.render(<div><p>s1 branch</p><button type="button">Continue deploy</button>{modal}</div>); });
    await act(async () => { button("Hide").click(); });
    await act(async () => { root!.render(<div style={{ gap: 12 }}><p>arm branch</p>{modal}<p>message</p></div>); });
    expect(dialog()).toBeNull();
    expect(host.querySelector("[data-testid='deploy-run-chip']")).not.toBeNull();
  });

  it("hides on Escape", async () => {
    await show({ running: true, steps: steps({ hire: { state: "active" } }) });
    await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(dialog()).toBeNull();
    expect(host.querySelector("[data-testid='deploy-run-chip']")).not.toBeNull();
  });

  it("does not close on the backdrop while running", async () => {
    await show({ running: true, steps: steps({ hire: { state: "active" } }) });
    const scrim = document.body.querySelector("[data-testid='deploy-run-modal']") as HTMLElement;
    await act(async () => { scrim.click(); });
    expect(dialog()).not.toBeNull();
  });

  it("steps aside while the deposit prompt is open", async () => {
    await show({ running: true, suspended: true, steps: steps({ fund: { state: "active" } }) });
    expect(dialog()).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("shows a stopped run's reason and never leaves a step spinning", async () => {
    await show({ running: false, steps: steps({ hire: { state: "done" }, fund: { state: "active", detail: "Waiting…" } }), message: "Deposit closed." });
    expect(dialog()?.getAttribute("aria-label")).toBe("Deploy stopped");
    expect(dialog()?.textContent).toContain("Deposit closed.");
    expect(stateOf("fund")).toBe("failed");
  });

  it("offers Cancel hire safely only when the page does, with the same handler", async () => {
    const onCancel = vi.fn();
    await show({ running: true, steps: steps({ grant: { state: "active" } }) });
    expect([...document.body.querySelectorAll("button")].some((entry) => entry.textContent === "Cancel hire safely")).toBe(false);
    await show({ running: true, steps: steps({ grant: { state: "active" } }), onCancel });
    await act(async () => { button("Cancel hire safely").click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers Stop deploy only when given, and only while running", async () => {
    const onStop = vi.fn();
    await show({ running: true, onStop, steps: steps({ fund: { state: "active" } }) });
    await act(async () => { button("Stop deploy").click(); });
    expect(onStop).toHaveBeenCalledTimes(1);
    await show({ running: false, onStop, steps: steps({ fund: { state: "failed" } }) });
    expect([...document.body.querySelectorAll("button")].some((entry) => entry.textContent === "Stop deploy")).toBe(false);
  });

  it("reads Agent deployed once the last step is done, with a way to the agent now", async () => {
    const onOpenAgent = vi.fn();
    await show({ running: true, onOpenAgent, steps: steps({ hire: { state: "done" }, fund: { state: "skipped" }, grant: { state: "done" }, converge: { state: "done" }, arm: { state: "done" } }) });
    expect(dialog()?.getAttribute("aria-label")).toBe("Agent deployed");
    expect(dialog()?.textContent).toContain("5/5");
    await act(async () => { button("Open the agent page").click(); });
    expect(onOpenAgent).toHaveBeenCalledTimes(1);
  });
});
