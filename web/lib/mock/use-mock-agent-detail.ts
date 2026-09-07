"use client";
/**
 * The ONE switch that puts the recording fixture on screen, and the only place
 * it is reachable from: `?mock=1` in the address bar, read in an effect so the
 * server render and the first client render agree.
 *
 * It replaces the VIEW the page reads and nothing else - the real hook still
 * runs, every mutation still goes through the owner-signed path, and with the
 * flag absent this returns the real result by identity. It exists so the
 * marketplace page can be filmed with a full grid history.
 */
import { useEffect, useMemo, useState } from "react";
import type { UseAgentDetailResult } from "@/lib/exec/use-agent-detail";
import { MOCK_AS_OF_MS, mockAgentDetailView, mockMarket } from "./agent-detail-mock";

export function mockRequested(search: string): boolean {
  try {
    return new URLSearchParams(search).get("mock") === "1";
  } catch {
    return false;
  }
}

export function useMockAgentDetail(real: UseAgentDetailResult, agentId: string): UseAgentDetailResult {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(mockRequested(window.location.search)), []);
  return useMemo(() => {
    if (!on) return real;
    return {
      ...real,
      state: "ready",
      view: mockAgentDetailView(agentId),
      market: mockMarket(),
      chartCandles: null,
      chartBanner: null,
      trade: null,
      asOfMs: MOCK_AS_OF_MS,
      message: "",
      marketReason: null,
      readHeaders: {},
    };
  }, [agentId, on, real]);
}
