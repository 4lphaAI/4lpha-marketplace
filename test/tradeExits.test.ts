import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySlippageFloorWei, decideExit, pnlBps } from "../src/trade/exits.js";

describe("TRADING-AGENT R8 exit arithmetic", () => {
  it("floors positive and negative bigint PnL", () => {
    assert.equal(pnlBps(125n, 100n), 2_500n);
    assert.equal(pnlBps(2n, 3n), -3_334n);
    assert.equal(pnlBps(1n, 0n), null);
  });

  it("ports applySlippageFloorWei with truncation and clamping", () => {
    assert.equal(applySlippageFloorWei(10_000n, 250), 9_750n);
    assert.equal(applySlippageFloorWei(10_000n, -1), 10_000n);
    assert.equal(applySlippageFloorWei(10_000n, 20_000), 1n);
    assert.equal(applySlippageFloorWei(10_000n, 250.9), 9_750n);
  });
});

describe("TRADING-AGENT R8 exit precedence", () => {
  const base = {
    quoteOutWei: 110n,
    entryWei: 100n,
    openedAtMs: 0,
    nowMs: 10_000,
    stopLossBps: 500,
    takeProfitBps: 500,
    maxHoldSec: 1,
    exitRequestedAt: null,
    llmExit: true,
    llmReason: "model",
  } as const;

  it("puts exitRequestedAt first of all", () => {
    assert.equal(decideExit({ ...base, exitRequestedAt: 1 }).reason, "owner-request");
  });

  it("checks SL before TP", () => {
    assert.equal(decideExit({ ...base, quoteOutWei: 90n }).reason, "stop-loss");
  });

  it("checks TP before max hold", () => {
    assert.equal(decideExit(base).reason, "take-profit");
  });

  it("checks max hold before the LLM", () => {
    assert.equal(decideExit({
      ...base, quoteOutWei: 100n, takeProfitBps: null, stopLossBps: null,
    }).reason, "max-hold");
  });

  it("consults the LLM only when TP or SL is blank", () => {
    assert.equal(decideExit({
      ...base,
      quoteOutWei: 100n,
      nowMs: 500,
      takeProfitBps: null,
      stopLossBps: 500,
    }).reason, "llm");
    assert.deepEqual(decideExit({
      ...base,
      quoteOutWei: 100n,
      nowMs: 500,
      takeProfitBps: 500,
      stopLossBps: 500,
    }), { exit: false, reason: "hold" });
  });
});
