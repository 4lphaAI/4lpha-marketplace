import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySlippageFloorWei, decideExit, hasBlankThreshold, pnlBps } from "../src/trade/exits.js";

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

describe("trade exit doctrine revision 4", () => {
  const observed = {
    balance: 100n,
    routeKey: "pancake_v2:route-a",
    lastQuoteWei: 100n,
    lastQuoteBalance: 100n,
    lastQuoteRoute: "pancake_v2:route-a",
    lastQuoteAtMs: 0,
    peakPnlBps: 0n,
    crashProtection: true,
    sessionExpiresAtMs: null,
    sessionExitLeadMs: 3_600_000,
    crashPendingSinceMs: null,
    crashPendingKind: null,
    crashRefQuoteWei: null,
    crashRefBalance: null,
    crashRefAtMs: null,
    crashRefRoute: null,
    autoExitReason: null,
    autoExitNote: null,
    fillStatus: "verified" as const,
    crashBasisVerified: true,
    tokenAmount: 100n,
    timeLimitAuthority: false,
  };

  it("keeps the R2.1 order pairwise, including marker and protective rows", () => {
    const common = {
      ...observed, quoteOutWei: 90n, entryWei: 100n, openedAtMs: 0, nowMs: 2_000,
      stopLossBps: 1_000, takeProfitBps: 0, maxHoldSec: 1, exitRequestedAt: null, llmExit: true,
    };
    assert.equal(decideExit({ ...common, exitRequestedAt: 1 }).reason, "owner-request");
    assert.equal(decideExit({ ...common, autoExitReason: "session-expiring" }).reason, "session-expiring");
    assert.equal(decideExit({ ...common, quoteOutWei: 90n }).reason, "stop-loss");
    assert.equal(decideExit({ ...common, quoteOutWei: 100n }).reason, "take-profit");
    assert.equal(decideExit({ ...common, quoteOutWei: 100n, takeProfitBps: 10_000, nowMs: 1_000 }).reason, "max-hold");
    assert.equal(decideExit({ ...common, quoteOutWei: 100n, takeProfitBps: 10_000, maxHoldSec: null, llmExit: true, timeLimitAuthority: true }).reason, "llm");
  });

  it("fires the crash collapse only after two comparable observations and uses the exact half boundary", () => {
    const armed = decideExit({
      ...observed, quoteOutWei: 50n, entryWei: 100n, openedAtMs: 0, nowMs: 1_000,
      stopLossBps: 9_000, takeProfitBps: 10_000, maxHoldSec: 86_400, exitRequestedAt: null,
    });
    assert.equal(armed.exit, false);
    assert.equal(armed.evidence?.kind, "arm");
    const confirmed = decideExit({
      ...observed, quoteOutWei: 50n, entryWei: 100n, openedAtMs: 0, nowMs: 2_000,
      stopLossBps: 9_000, takeProfitBps: 10_000, maxHoldSec: 86_400, exitRequestedAt: null,
      crashPendingSinceMs: 1_000, crashPendingKind: "collapse",
      crashRefQuoteWei: 100n, crashRefBalance: 100n, crashRefAtMs: 0, crashRefRoute: observed.routeKey,
    });
    assert.equal(confirmed.reason, "crash-stop");
    assert.equal(decideExit({
      ...observed, quoteOutWei: 51n, entryWei: 100n, openedAtMs: 0, nowMs: 1_000,
      stopLossBps: 9_000, takeProfitBps: 10_000, maxHoldSec: 86_400, exitRequestedAt: null,
    }).evidence, undefined);
  });

  it("uses receipt-attributed quantity for dust and never uses balance-only verification", () => {
    const dust = decideExit({
      ...observed, quoteOutWei: 25n, entryWei: 100n, balance: 100n, tokenAmount: 1n,
      lastQuoteWei: 40n, nowMs: 1_000, stopLossBps: 9_000, takeProfitBps: 10_000,
      maxHoldSec: 86_400, openedAtMs: 0, exitRequestedAt: null,
    });
    assert.equal(dust.exit, false);
    assert.equal(dust.evidence?.kind, "arm");
    assert.equal(dust.evidence?.kind === "arm" ? dust.evidence.pendingKind : null, "dust");
    const noReceipt = decideExit({
      ...observed, quoteOutWei: 25n, entryWei: 100n, balance: 100n, tokenAmount: 1n,
      crashBasisVerified: false, lastQuoteWei: 40n, nowMs: 1_000, stopLossBps: 9_000,
      takeProfitBps: 10_000, maxHoldSec: 86_400, openedAtMs: 0, exitRequestedAt: null,
    });
    assert.equal(noReceipt.evidence, undefined);
  });

  it("re-bases on route, balance, time-window, future and recovered confirmation changes", () => {
    const base = { ...observed, quoteOutWei: 50n, entryWei: 100n, openedAtMs: 0, nowMs: 1_000,
      stopLossBps: 9_000, takeProfitBps: 10_000, maxHoldSec: 86_400, exitRequestedAt: null };
    assert.equal(decideExit({ ...base, lastQuoteRoute: "other" }).evidence, undefined);
    assert.equal(decideExit({ ...base, balance: 102n }).evidence, undefined);
    assert.equal(decideExit({ ...base, lastQuoteAtMs: 901_001 }).evidence, undefined);
    assert.equal(decideExit({ ...base, lastQuoteAtMs: 2_000 }).evidence, undefined);
    const recovered = decideExit({ ...base, quoteOutWei: 100n, nowMs: 2_000,
      crashPendingSinceMs: 1_000, crashPendingKind: "collapse", crashRefQuoteWei: 100n,
      crashRefBalance: 100n, crashRefAtMs: 0, crashRefRoute: observed.routeKey });
    assert.equal(recovered.exit, false);
    assert.equal(recovered.evidence?.kind, "clear");
  });

  it("allows owner-request, max-hold and session-expiring with nullable PnL", () => {
    const input = { ...observed, quoteOutWei: 100n, entryWei: 0n, openedAtMs: 0, nowMs: 10_000,
      stopLossBps: 5_000, takeProfitBps: 5_000, maxHoldSec: 1, exitRequestedAt: null };
    assert.equal(decideExit({ ...input, exitRequestedAt: 1 }).reason, "owner-request");
    assert.equal(decideExit(input).reason, "max-hold");
    assert.equal(decideExit({ ...input, maxHoldSec: 86_400, sessionExpiresAtMs: 10_000, sessionExitLeadMs: 1 }).reason, "session-expiring");
  });

  it("treats only the time limit as a blank threshold when authority is explicit", () => {
    assert.equal(hasBlankThreshold({ takeProfitBps: 1_000, stopLossBps: 2_000, timeLimitAuthority: true }), true);
    assert.equal(hasBlankThreshold({ takeProfitBps: 1_000, stopLossBps: 2_000, timeLimitAuthority: false }), false);
  });
});
