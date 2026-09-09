// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SigmaPet } from "./SigmaPet";
import {
  SIGMA_ANIMATIONS,
  SIGMA_ATLAS_COLUMNS,
  SIGMA_ATLAS_ROWS,
  SIGMA_HIDDEN_STORAGE_KEY,
  SIGMA_PET_GREETING,
  SIGMA_REACTIONS,
  clampSigmaPosition,
  dispatchSigmaPetReaction,
  sigmaReactionForRoute,
  sigmaSpriteOffset,
} from "@/lib/sigma-pet";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

/** `dispatchSigmaPetReaction` keeps per-id cooldowns and a global quiet window
    in module state, so a test that wants a reaction to land must first move the
    clock past whatever an earlier test said. */
let clockOffsetMs = 0;
function useClockPastAnyCooldown() {
  vi.useFakeTimers();
  clockOffsetMs += 600_000;
  vi.setSystemTime(new Date(Date.now() + clockOffsetMs));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(route: string) {
  act(() => {
    root.render(<SigmaPet route={route} />);
  });
}

describe("sigmaReactionForRoute", () => {
  it("maps every KitApp screen route it claims to cover", () => {
    expect(sigmaReactionForRoute("/")).toBe("market.enter");
    expect(sigmaReactionForRoute("/agent/grid-01")).toBe("agent.detail");
    expect(sigmaReactionForRoute("/account")).toBe("account.list");
    expect(sigmaReactionForRoute("/account/lp-agent-01")).toBe("account.detail");
    expect(sigmaReactionForRoute("/demo/demo-1")).toBe("demo.detail");
    expect(sigmaReactionForRoute("/deploy/grid")).toBe("deploy.grid");
    expect(sigmaReactionForRoute("/deploy/trade")).toBe("deploy.trade");
    expect(sigmaReactionForRoute("/deploy/lp")).toBe("deploy.lp");
    expect(sigmaReactionForRoute("/deploy/lending")).toBe("deploy.health");
    expect(sigmaReactionForRoute("/list-your-agent")).toBe("list.enter");
  });

  it("is silent on an unknown route rather than guessing", () => {
    expect(sigmaReactionForRoute("/deploy/unknown-kind")).toBeUndefined();
    expect(sigmaReactionForRoute("/somewhere-else")).toBeUndefined();
  });

  it("names only animation states the atlas actually has", () => {
    for (const reaction of Object.values(SIGMA_REACTIONS)) {
      expect(reaction.state in SIGMA_ANIMATIONS).toBe(true);
    }
  });
});

describe("sigmaSpriteOffset", () => {
  it("puts frame 0 of row 0 at the atlas origin", () => {
    expect(sigmaSpriteOffset("idle", 0)).toEqual({ x: 0, y: 0 });
  });

  it("wraps the frame within its own row and never leaves the atlas", () => {
    const animation = SIGMA_ANIMATIONS.waving;
    expect(sigmaSpriteOffset("waving", animation.frames)).toEqual(
      sigmaSpriteOffset("waving", 0),
    );
    const last = sigmaSpriteOffset("waving", animation.frames - 1);
    expect(last.x).toBeLessThanOrEqual(100);
    expect(last.y).toBeCloseTo((animation.row / (SIGMA_ATLAS_ROWS - 1)) * 100);
  });

  it("keeps every row inside the declared atlas grid", () => {
    for (const animation of Object.values(SIGMA_ANIMATIONS)) {
      expect(animation.row).toBeLessThan(SIGMA_ATLAS_ROWS);
      expect(animation.frames).toBeLessThanOrEqual(SIGMA_ATLAS_COLUMNS);
    }
  });
});

describe("clampSigmaPosition", () => {
  it("keeps the pet fully on screen in both directions", () => {
    const viewport = { height: 800, width: 1200 };
    expect(clampSigmaPosition({ x: -500, y: -500 }, 82, viewport)).toEqual({ x: 8, y: 8 });
    expect(clampSigmaPosition({ x: 9_999, y: 9_999 }, 82, viewport)).toEqual({
      x: 1200 - 82 - 8,
      y: 800 - 82 - 8,
    });
  });
});

describe("SigmaPet quiet window", () => {
  it("lets a fresh event reaction outlive the route reaction that follows it", () => {
    useClockPastAnyCooldown();
    render("/");
    // A hire finishing dispatches with `force`, then the app navigates; the
    // route reaction must not overwrite it 350ms later.
    act(() => dispatchSigmaPetReaction("hire.success", { force: true }));
    act(() => {
      root.render(<SigmaPet route="/account" />);
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector(".fl-sigma__bubble")?.textContent).toBe(
      SIGMA_REACTIONS["hire.success"].bubbleText,
    );
  });
});

describe("SigmaPet", () => {
  it("renders the greeting and a draggable sprite", () => {
    render("/");
    expect(container.querySelector(".fl-sigma__bubble")?.textContent).toBe(SIGMA_PET_GREETING);
    expect(container.querySelector(".fl-sigma__sprite")).not.toBeNull();
  });

  it("reacts to a route with that route's bubble text", () => {
    useClockPastAnyCooldown();
    render("/deploy/grid");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector(".fl-sigma__bubble")?.textContent).toBe(
      SIGMA_REACTIONS["deploy.grid"].bubbleText,
    );
  });

  it("stays hidden once the viewer dismisses it", () => {
    render("/");
    const hide = container.querySelector<HTMLButtonElement>(".fl-sigma__hide");
    expect(hide).not.toBeNull();
    act(() => hide?.click());

    expect(container.querySelector(".fl-sigma")).toBeNull();
    expect(window.localStorage.getItem(SIGMA_HIDDEN_STORAGE_KEY)).toBe("1");
  });

  it("does not render when storage already says hidden", () => {
    window.localStorage.setItem(SIGMA_HIDDEN_STORAGE_KEY, "1");
    render("/");
    expect(container.querySelector(".fl-sigma")).toBeNull();
  });
});
