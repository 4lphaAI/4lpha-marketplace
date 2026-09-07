import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DataPlaneEnvelope } from "../src/clients/dataPlane.js";
import {
  createTradeReadiness,
  type TradeReadinessDataPlane,
  type TradeReadinessProbeResult,
} from "../src/trade/readiness.js";

function envelope(lane: "bstocks" | "allowlist", count: number, staleness: number | null = 0): DataPlaneEnvelope<unknown> {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      address: `0x${(index + (lane === "bstocks" ? 1 : 100)).toString(16).padStart(40, "0")}`,
      lane,
    })),
    meta: { lanes: { [lane]: { staleness } } },
  };
}

function plane(allowlist: TradeReadinessProbeResult): TradeReadinessDataPlane {
  return {
    async probeUniverse(lane) {
      return lane === "bstocks" ? { status: 200, envelope: envelope("bstocks", 25) } : allowlist;
    },
  };
}

describe("trade readiness", () => {
  it("requires exactly 25 bStocks and a non-empty, non-null-staleness allowlist", async () => {
    const readiness = await createTradeReadiness({
      dataPlane: plane({ status: 200, envelope: envelope("allowlist", 1) }), intervalMs: 60_000,
    });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.allowlistAvailable, true);
    assert.equal(readiness.bstocksAddresses.size, 25);
    readiness.stop();
  });

  it("remembers legacy invalid_lane and null staleness as unavailable", async () => {
    const legacy = await createTradeReadiness({
      dataPlane: plane({ status: 400, envelope: { error: { code: "invalid_lane" } } }), intervalMs: 60_000,
    });
    assert.equal(legacy.ready, true);
    assert.equal(legacy.allowlistAvailable, false);
    legacy.stop();
    const empty = await createTradeReadiness({
      dataPlane: plane({ status: 200, envelope: envelope("allowlist", 1, null) }), intervalMs: 60_000,
    });
    assert.equal(empty.allowlistAvailable, false);
    empty.stop();
  });

  it("turns a network failure into not-ready instead of throwing at boot", async () => {
    const readiness = await createTradeReadiness({
      dataPlane: { async probeUniverse() { throw new Error("credential-bearing detail"); } },
      intervalMs: 60_000,
    });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.allowlistAvailable, false);
    assert.equal(readiness.bstocksAddresses.size, 0);
    readiness.stop();
  });
});
