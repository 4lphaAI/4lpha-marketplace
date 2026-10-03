import { describe, expect, it } from "vitest";
import type { TradePositionView } from "@/lib/trade";
import { closeReasonLabel, closedNewestFirst, heldDuration } from "./TradeAgentDetail";

const MIN = 60_000;

describe("close reason labels", () => {
  it("names the two TRADFI-EXIT-RULES reasons and leaves the others as words", () => {
    expect(closeReasonLabel("trailing-stop")).toBe("Trailing stop");
    expect(closeReasonLabel("stale-exit")).toBe("Stale position exit");
    expect(closeReasonLabel("crash-stop")).toBe("crash stop");
    expect(closeReasonLabel(null)).toBe("\u2014");
  });
});

describe("closed positions tab", () => {
  it("shows held as the open-to-close duration, never 'ago'", () => {
    expect(heldDuration(0, null)).toBe("—");
    expect(heldDuration(0, 30_000)).toBe("<1m");
    expect(heldDuration(0, 51 * MIN)).toBe("51m");
    expect(heldDuration(0, 5 * 60 * MIN)).toBe("5h");
    expect(heldDuration(0, (5 * 60 + 12) * MIN)).toBe("5h 12m");
    expect(heldDuration(0, 27 * 60 * MIN)).toBe("1d 3h");
    expect(heldDuration(0, 48 * 60 * MIN)).toBe("2d");
  });

  it("orders the most recently closed position first", () => {
    const row = (positionId: string, openedAt: number, closedAt: number | null) => ({ positionId, openedAt, closedAt }) as unknown as TradePositionView;
    const input = [row("a", 0, 10 * MIN), row("b", 0, 30 * MIN), row("c", 5 * MIN, null), row("d", 0, 20 * MIN)];
    expect(closedNewestFirst(input).map((p) => p.positionId)).toEqual(["b", "d", "a", "c"]);
    expect(input.map((p) => p.positionId)).toEqual(["a", "b", "c", "d"]);
  });
});
