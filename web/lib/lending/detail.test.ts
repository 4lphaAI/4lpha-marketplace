import { describe, expect, it } from "vitest";
import {
  lendingAccountSource,
  lendingConditionCopy,
  lendingConditionTone,
  lendingCoverageMetric,
  lendingHealth,
  lendingRecoveryOffered,
  lendingRemoveGate,
  lendingReserveMetric,
  shortAddress,
} from "./detail";
import {
  LENDING_CONDITIONS,
  type LendingAgentView,
  type LendingConfigView,
  type LendingGuardView,
  type LendingSnapshotPayload,
} from "@/lib/exec/lending-types";

const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const V_BNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const ACCOUNT = "0x1111111111111111111111111111111111111111";

const config: LendingConfigView = {
  chainId: 56, vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB,
  routerV3: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  swapFeeTier: 100, maxSagaSlippageBps: 50, dustUsdtWei: "10000000000000000", maxMarkets: 24,
};

function market(vToken: string, borrowWei: string, priceMantissa: string) {
  return {
    vToken, symbol: vToken === V_USDT ? "vUSDT" : "vBNB",
    underlying: vToken === V_USDT ? USDT : null, underlyingDecimals: 18,
    supplyUnderlyingWei: "0", borrowWei, isCollateral: false,
    collateralFactor: "800000000000000000", liquidationThreshold: "850000000000000000",
    priceMantissa,
  };
}

function payload(patch: Partial<LendingSnapshotPayload> = {}): LendingSnapshotPayload {
  return {
    version: 1,
    account: {
      blockNumber: "1", markets: [market(V_USDT, "100000000000000000000", "1000000000000000000")],
      accountLiquidity: ["0", "0", "0"], borrowingPower: ["0", "0", "0"], vaiDebt: "0",
    },
    reserve: {
      idleUsdtWei: "1000000000000000000",       // 1 USDT
      suppliedUsdtWei: "30000000000000000000",  // 30 USDT
      vUsdtBalance: "1", poolCashWei: "0",
      bnbTierWei: "0", nativeBalanceWei: "0", walletFloorWei: "0",
      usdtAllowanceToVUsdt: "0", usdtAllowanceToRouter: "0",
    },
    conditions: [],
    usage: { rescues: 0, lastRescueAtMs: null },
    observation: { healthFactor: "1180000000000000000", breach: true, consecutive: 1, evaluatedAtMs: 1 },
    session: { expiresAt: null },
    ...patch,
  };
}

const guard: LendingGuardView = {
  status: "armed", hold: null, guardedAccount: ACCOUNT, debtMarkets: [V_USDT],
  reserveBps: 2_000, budgetWei: "50000000000000000", reserveCapWei: "40000000000000000000",
  armTxHash: null, armBlock: null, armBlockSource: null, closeReason: null,
  actionSeq: 0, lastActionAtMs: null, updatedAtMs: 1,
};

function view(patch: Partial<LendingAgentView> = {}): LendingAgentView {
  return {
    guard,
    snapshot: {
      presentAt: 1, ageMs: 100, staleAfterMs: 60_000, stale: false, reason: null,
      workerIntervalMs: 30_000, payload: payload(),
    },
    rescues: [], settings: null, settingsDigest: null,
    session: { expiresAt: null, expiring: false }, recovery: { note: "" },
    ...patch,
  };
}

describe("the hero health factor", () => {
  it("is the LIQUIDATION basis the trigger acts on, from the agent's own observation", () => {
    const health = lendingHealth(view());
    expect(health.value).toBe("1.18");
    expect(health.live).toBe(false);
    expect(health.matched).toBe(true);
  });

  // The snapshot carries no match flag, so it is derived from the ABSENCE of a
  // `protocol-mismatch` condition — and the note says exactly that.
  it("reports a protocol mismatch as NOT matched, from the condition the worker wrote", () => {
    const health = lendingHealth(view({
      snapshot: {
        presentAt: 1, ageMs: 1, staleAfterMs: 60_000, stale: false, reason: null, workerIntervalMs: 30_000,
        payload: payload({ conditions: [{ condition: "protocol-mismatch", known: true, detail: "" }] }),
      },
    }));
    expect(health.matched).toBe(false);
    expect(health.matchedNote).toContain("does NOT match");
  });

  it("falls back to the BFF's live read when the snapshot is stale, and LABELS it", () => {
    const health = lendingHealth(view({
      snapshot: { presentAt: 1, ageMs: 9_000_000, staleAfterMs: 60_000, stale: true, reason: "no report since", workerIntervalMs: 30_000, payload: null },
      liveAccount: {
        account: ACCOUNT, blockNumber: "2",
        bases: { borrowingPower: { hf: "1300000000000000000", matched: true }, liquidation: { hf: "1050000000000000000", matched: false } },
        markets: [], debts: [], guardable: true,
      },
    }));
    expect(health.value).toBe("1.05");
    expect(health.live).toBe(true);
    expect(health.matched).toBe(false);
  });

  it("dashes WITH THE STALENESS REASON when neither source exists", () => {
    const health = lendingHealth(view({
      snapshot: { presentAt: null, ageMs: null, staleAfterMs: 60_000, stale: true, reason: "The worker has not reported for this guard yet.", workerIntervalMs: 30_000, payload: null },
    }));
    expect(health.value).toBeNull();
    expect(health.reason).toBe("The worker has not reported for this guard yet.");
    expect(health.matched).toBeNull();
  });
});

describe("the reserve tile", () => {
  it("prices the legs from the PROTOCOL oracle and names its composition", () => {
    const metric = lendingReserveMetric({ payload: payload(), config, usdtDecimals: 18 });
    expect(metric.value).toBe("$31.00");
    expect(metric.note).toBe("30 USDT on Venus · 1 idle USDT · 0 BNB tier");
  });

  // A leg that holds value but has no oracle row dashes the WHOLE figure: a
  // partial total read as a total is exactly what this page refuses.
  it("dashes when a non-zero leg has no protocol price on this account", () => {
    const withTier = payload({
      reserve: { ...payload().reserve, bnbTierWei: "9000000000000000" },
    });
    const metric = lendingReserveMetric({ payload: withTier, config, usdtDecimals: 18 });
    expect(metric.value).toBeNull();
    expect(metric.reason).toContain("vBNB market");
    // The composition is still shown — it needs no price.
    expect(metric.note).toContain("0.009 BNB tier");
  });

  it("dashes when the venue could not be read at all", () => {
    const metric = lendingReserveMetric({ payload: payload(), config: null, usdtDecimals: 18 });
    expect(metric.value).toBeNull();
    expect(metric.reason).toContain("lending venue");
  });
});

describe("coverage", () => {
  it("is the reserve's value over the PINNED debt, both from the same oracle rows", () => {
    // 31 USDT reserve against 100 USDT of pinned debt.
    const metric = lendingCoverageMetric({ payload: payload(), guard, config });
    expect(metric.value).toBe("31.0%");
    expect(metric.note).toBe("$31.00 reserve against $100.00 of pinned debt");
  });

  it("dashes, naming the market, when a pinned debt has left the account", () => {
    const metric = lendingCoverageMetric({
      payload: payload(), guard: { ...guard, debtMarkets: [V_BNB] }, config,
    });
    expect(metric.value).toBeNull();
    expect(metric.reason).toContain("no longer holds");
  });

  it("says so plainly when the pinned debt is zero rather than dividing by it", () => {
    const cleared = payload({
      account: { ...payload().account, markets: [market(V_USDT, "0", "1000000000000000000")] },
    });
    const metric = lendingCoverageMetric({ payload: cleared, guard, config });
    expect(metric.value).toBe("—");
    expect(metric.note).toContain("owes nothing in the pinned markets");
  });
});

describe("the condition taxonomy", () => {
  it("has owner-facing copy for EVERY member the plane can emit", () => {
    for (const condition of LENDING_CONDITIONS) {
      const copy = lendingConditionCopy(condition);
      expect(copy.length, condition).toBeGreaterThan(20);
      expect(copy, condition).not.toContain("not one this page recognizes");
    }
  });

  it("carries R2.13's disarm language and R3.11's account bound verbatim", () => {
    expect(lendingConditionCopy("oracle-invalid"))
      .toBe("Your account entered a market this guard cannot price; the guard is paused until it can.");
    expect(lendingConditionCopy("account-too-complex"))
      .toBe("Your account entered more markets than this guard can price; the guard is paused until it can.");
  });

  it("keeps the conditions the web run was told to surface by name", () => {
    for (const condition of ["borrow-moved", "pool-cash-short", "arm-unknown", "account-too-complex",
      "cap-unreadable", "reserve-low", "usdt-cap-exhausted"]) {
      expect(LENDING_CONDITIONS.some((known) => known === condition), condition).toBe(true);
      expect(lendingConditionCopy(condition), condition).not.toContain("not one this page recognizes");
    }
  });

  it("shows an unrecognized condition verbatim rather than dropping it", () => {
    expect(lendingConditionCopy("brand-new-thing")).toContain("shown verbatim rather than dropped");
    expect(lendingConditionTone("brand-new-thing")).toBe("warn");
    expect(lendingConditionTone("protocol-mismatch")).toBe("alarm");
    expect(lendingConditionTone("hf-above-trigger")).toBe("info");
  });
});

describe("the Remove gate (§6.1 / R3.12)", () => {
  it("allows Remove from retired and closed", () => {
    for (const status of ["retired", "closed"] as const) {
      expect(lendingRemoveGate({ guard: { ...guard, status }, poolShort: false, leaveRemainderAccepted: false }).allowed).toBe(true);
    }
  });

  it("refuses while the guard still holds the reserve, and says to retire first", () => {
    const gate = lendingRemoveGate({ guard, poolShort: false, leaveRemainderAccepted: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Retire the reserve first");
  });

  // The pool-short door is the OWNER'S DECLARED CHOICE, never the page's.
  it("opens `retiring + pool-cash-short` only behind the declared choice", () => {
    const guardRetiring = { ...guard, status: "retiring" as const };
    const refused = lendingRemoveGate({ guard: guardRetiring, poolShort: true, leaveRemainderAccepted: false });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("leave the remaining supply on Venus");
    expect(lendingRemoveGate({ guard: guardRetiring, poolShort: true, leaveRemainderAccepted: true }).allowed).toBe(true);
    // Retiring WITHOUT pool-cash-short is not a door.
    expect(lendingRemoveGate({ guard: guardRetiring, poolShort: false, leaveRemainderAccepted: true }).allowed).toBe(false);
  });
});

describe("the passkey recovery door (§6.2)", () => {
  const nowSec = 1_700_000_000;
  it("opens on an expired session, on a revoked agent and on an unreachable plane", () => {
    expect(lendingRecoveryOffered({ guard, sessionExpiresAt: nowSec - 1, agentStatus: "armed", planeUnreachable: false, nowSec })).toBe(true);
    expect(lendingRecoveryOffered({ guard, sessionExpiresAt: nowSec + 10_000, agentStatus: "revoked", planeUnreachable: false, nowSec })).toBe(true);
    expect(lendingRecoveryOffered({ guard, sessionExpiresAt: nowSec + 10_000, agentStatus: "armed", planeUnreachable: true, nowSec })).toBe(true);
  });
  it("stays closed on a live session and on a guard that holds nothing", () => {
    expect(lendingRecoveryOffered({ guard, sessionExpiresAt: nowSec + 10_000, agentStatus: "armed", planeUnreachable: false, nowSec })).toBe(false);
    expect(lendingRecoveryOffered({ guard: { ...guard, status: "retired" }, sessionExpiresAt: null, agentStatus: "revoked", planeUnreachable: true, nowSec })).toBe(false);
  });
});

describe("which account the page is reading", () => {
  it("uses the agent's own markets while fresh, and the live read while stale", () => {
    expect(lendingAccountSource(view()).live).toBe(false);
    const stale = lendingAccountSource(view({
      snapshot: { presentAt: 1, ageMs: 1, staleAfterMs: 1, stale: true, reason: "stale", workerIntervalMs: 1, payload: null },
      liveAccount: {
        account: ACCOUNT, blockNumber: "2",
        bases: { borrowingPower: { hf: null, matched: false }, liquidation: { hf: null, matched: false } },
        markets: [market(V_USDT, "1", "1")], debts: [], guardable: true,
      },
    }));
    expect(stale.live).toBe(true);
    expect(stale.markets).toHaveLength(1);
    const dark = lendingAccountSource(view({
      snapshot: { presentAt: null, ageMs: null, staleAfterMs: 1, stale: true, reason: "no report", workerIntervalMs: 1, payload: null },
      liveAccountReason: "the live read is rate-limited",
    }));
    expect(dark.markets).toHaveLength(0);
    expect(dark.reason).toBe("the live read is rate-limited");
  });

  it("shortens an address without hiding which one it is", () => {
    expect(shortAddress(ACCOUNT)).toBe("0x1111…1111");
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});
