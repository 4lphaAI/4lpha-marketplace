import { describe, expect, it } from "vitest";
import {
  INVALID,
  LENDING_ACTIONS,
  lendingRetireOutcomeText,
  parseLendingAgentView,
  parseLendingArmOutcome,
  parseLendingConfig,
  parseLendingGuardable,
  parseLendingQuote,
  parseLendingRetireOutcome,
  parseLendingSettingsView,
} from "./lending-types";

const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const V_BNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;

const config = {
  chainId: 56, vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB, routerV3: ROUTER, wbnb: WBNB,
  quoterV2: QUOTER, swapFeeTier: 100, maxSagaSlippageBps: 50,
  dustUsdtWei: "10000000000000000", maxMarkets: 24,
};

const market = {
  vToken: V_USDT, symbol: "vUSDT", underlying: USDT, underlyingDecimals: 18,
  supplyUnderlyingWei: "0", borrowWei: "1000000000000000000000",
  isCollateral: false, collateralFactor: "800000000000000000",
  liquidationThreshold: "850000000000000000", priceMantissa: "1000000000000000000",
};

const guardable = {
  account: ACCOUNT,
  blockNumber: "120362697",
  bases: {
    borrowingPower: { hf: "1300000000000000000", matched: true },
    liquidation: { hf: "1180000000000000000", matched: true },
  },
  markets: [market],
  debts: [{ vToken: V_USDT, symbol: "vUSDT", borrowWei: "1000000000000000000000", debtValueMantissa: "1000000000000000000000", supported: true }],
  guardable: true,
};

const guardRow = {
  status: "armed", hold: null, guardedAccount: ACCOUNT, debtMarkets: [V_USDT],
  reserveBps: 2000, budgetWei: "50000000000000000", reserveCapWei: "40000000000000000000",
  armTxHash: HASH, armBlock: "120362700", closeReason: null,
  actionSeq: 3, lastActionAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_100_000,
};

const snapshotPayload = {
  version: 1,
  account: {
    blockNumber: "120362697", markets: [market],
    accountLiquidity: ["0", "100", "0"], borrowingPower: ["0", "200", "0"], vaiDebt: "0",
  },
  reserve: {
    idleUsdtWei: "1000000000000000000", suppliedUsdtWei: "30000000000000000000",
    vUsdtBalance: "140000000000", poolCashWei: "9000000000000000000000",
    bnbTierWei: "9000000000000000", nativeBalanceWei: "10000000000000000",
    walletFloorWei: "200000000000000", usdtAllowanceToVUsdt: "0", usdtAllowanceToRouter: "0",
  },
  conditions: [{ condition: "hf-above-trigger", detail: "1.18 is above 1.20? no" }],
  usage: { rescues: 2, lastRescueAtMs: 1_700_000_000_000 },
  observation: { healthFactor: "1180000000000000000", breach: true, consecutive: 1, evaluatedAtMs: 1_700_000_050_000 },
  session: { expiresAt: 1_700_600_000 },
};

const agentView = {
  guard: guardRow,
  snapshot: {
    presentAt: 1_700_000_100_000, ageMs: 5_000, staleAfterMs: 60_000, stale: false,
    reason: null, workerIntervalMs: 30_000, payload: snapshotPayload,
  },
  rescues: [{
    rescueId: "r1", market: V_USDT, amountWei: "10000000000000000000",
    hfBefore: "1100000000000000000", hfAfter: "1510000000000000000", achievedHf: "1500000000000000000",
    txHash: HASH, effect: "changed", partial: false, conditions: [], createdAtMs: 1_700_000_000_000,
  }],
  settings: {
    triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
    maxPerAction: [{ token: USDT, maxWei: "240000000000000000000" }],
    minSecondsBetweenActions: 300, rescueReserveCount: 6, notifyOnlyBelowHf: null,
  },
  settingsDigest: HASH,
  session: { expiresAt: 1_700_600_000, expiring: false },
  recovery: { note: "Your reserve is recoverable with your passkey at any time; the agent's key cannot block it." },
};

describe("lending owner action names", () => {
  it("pins the three names the plane's OWNER_ACTIONS set carries, byte for byte", () => {
    expect(LENDING_ACTIONS).toEqual({
      arm: "lendingArm", settings: "lendingSettings", retire: "lendingRetire",
    });
  });
});

describe("parseLendingConfig", () => {
  it("accepts the plane's config and refuses every malformed field", () => {
    expect(parseLendingConfig(config)).toEqual(config);
    for (const bad of [
      null, [], "config", {},
      { ...config, chainId: 1 },
      { ...config, vUsdt: "0x1234" },
      { ...config, swapFeeTier: 0 },
      { ...config, maxSagaSlippageBps: 10_001 },
      { ...config, dustUsdtWei: "-1" },
      { ...config, maxMarkets: 0 },
    ]) {
      expect(parseLendingConfig(bad), JSON.stringify(bad)).toBe(INVALID);
    }
  });

  // The plane is adding `workerIntervalMs` separately. It is OPTIONAL in both
  // directions: carried when it is a positive whole number, silently absent
  // otherwise, and NEVER a reason to reject the venue read.
  it("carries an optional workerIntervalMs, and drops an unusable one", () => {
    expect(parseLendingConfig({ ...config, workerIntervalMs: 30_000 }))
      .toEqual({ ...config, workerIntervalMs: 30_000 });
    for (const bad of [0, -1, 1.5, "30000", null]) {
      const parsed = parseLendingConfig({ ...config, workerIntervalMs: bad });
      expect(parsed, JSON.stringify(bad)).not.toBe(INVALID);
      expect(parsed).toEqual(config);
    }
  });
});

describe("parseLendingQuote", () => {
  const quote = {
    tokenIn: USDT, tokenOut: WBNB, fee: 100, amountInWei: "31000000000000000000",
    quotedOutWei: "50000000000000000", minOutWei: "49750000000000000", maxSagaSlippageBps: 50,
  };
  it("accepts a quote and refuses one missing its floor", () => {
    expect(parseLendingQuote(quote)).toEqual(quote);
    const { minOutWei: _dropped, ...withoutFloor } = quote;
    expect(parseLendingQuote(withoutFloor)).toBe(INVALID);
    expect(parseLendingQuote({ ...quote, quotedOutWei: "1e18" })).toBe(INVALID);
  });
});

describe("parseLendingGuardable", () => {
  it("accepts display mode without a receipt", () => {
    const parsed = parseLendingGuardable(guardable);
    expect(parsed).not.toBe(INVALID);
    if (parsed === INVALID) return;
    expect(parsed.previewReceipt).toBeUndefined();
    expect(parsed.sizing).toBeUndefined();
    expect(parsed.bases.liquidation.hf).toBe("1180000000000000000");
  });

  it("accepts receipt mode and carries the floors and the opaque receipt", () => {
    const parsed = parseLendingGuardable({
      ...guardable,
      sizing: {
        reserveCapFloorWei: "44000000000000000000", minimumCapDayWei: "90000000000000000",
        mintUsdtWei: "40000000000000000000", reserveNativeWei: "10000000000000000",
        supplyNativeWei: "40000000000000000", ok: true,
      },
      previewReceipt: "v1.abc.def",
      expiresAtSec: 1_700_000_030,
    });
    expect(parsed).not.toBe(INVALID);
    if (parsed === INVALID) return;
    expect(parsed.sizing?.reserveCapFloorWei).toBe("44000000000000000000");
    expect(parsed.previewReceipt).toBe("v1.abc.def");
  });

  it("keeps a refusal and the market it names, and refuses an unknown refusal", () => {
    const refused = parseLendingGuardable({
      ...guardable, guardable: false, refusal: "oracle-invalid", refusalMarket: V_BNB,
      note: "Your account entered a market this guard cannot price; the guard is paused until it can.",
    });
    expect(refused).not.toBe(INVALID);
    if (refused === INVALID) return;
    expect(refused.refusal).toBe("oracle-invalid");
    expect(refused.refusalMarket).toBe(V_BNB);
    expect(parseLendingGuardable({ ...guardable, refusal: "vibes" })).toBe(INVALID);
  });

  it("refuses a malformed account, block, basis, market or debt", () => {
    for (const bad of [
      { ...guardable, account: "not-an-address" },
      { ...guardable, blockNumber: -1 },
      { ...guardable, bases: { borrowingPower: { hf: "1", matched: true } } },
      { ...guardable, bases: { ...guardable.bases, liquidation: { hf: "x", matched: true } } },
      { ...guardable, markets: [{ ...market, priceMantissa: null }] },
      { ...guardable, debts: [{ ...guardable.debts[0], supported: "yes" }] },
      { ...guardable, debts: [{ ...guardable.debts[0], reason: "because" }] },
    ]) {
      expect(parseLendingGuardable(bad), JSON.stringify(bad).slice(0, 80)).toBe(INVALID);
    }
  });
});

describe("parseLendingSettingsView", () => {
  it("round-trips a full settings object including a native ceiling", () => {
    const settings = {
      triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
      maxPerAction: [{ token: USDT, maxWei: "240000000000000000000" }, { token: null, maxWei: "300000000000000000" }],
      minSecondsBetweenActions: 300, rescueReserveCount: 6, notifyOnlyBelowHf: "1600000000000000000",
    };
    expect(parseLendingSettingsView(settings)).toEqual(settings);
  });
  it("refuses a ceiling whose amount is not wei", () => {
    expect(parseLendingSettingsView({
      triggerHf: "1", targetHf: "2", maxPerAction: [{ token: USDT, maxWei: "0.5" }],
      minSecondsBetweenActions: 300, rescueReserveCount: 6, notifyOnlyBelowHf: null,
    })).toBe(INVALID);
  });
});

describe("parseLendingAgentView", () => {
  it("maps the route's ACTUAL shape: guard, snapshot.payload, rescues, settings, session", () => {
    const parsed = parseLendingAgentView({ data: agentView });
    expect(parsed).not.toBe(INVALID);
    if (parsed === INVALID) return;
    expect(parsed.guard.status).toBe("armed");
    expect(parsed.snapshot.stale).toBe(false);
    expect(parsed.snapshot.payload?.observation?.healthFactor).toBe("1180000000000000000");
    expect(parsed.snapshot.payload?.reserve.suppliedUsdtWei).toBe("30000000000000000000");
    expect(parsed.rescues).toHaveLength(1);
    expect(parsed.settings?.rescueReserveCount).toBe(6);
    expect(parsed.session.expiring).toBe(false);
  });

  it("a stale snapshot serves a null payload and keeps its reason", () => {
    const parsed = parseLendingAgentView({
      data: {
        ...agentView,
        snapshot: { ...agentView.snapshot, stale: true, payload: null, reason: "The worker has not reported since 2026-09-07T00:00:00.000Z." },
      },
    });
    expect(parsed).not.toBe(INVALID);
    if (parsed === INVALID) return;
    expect(parsed.snapshot.payload).toBeNull();
    expect(parsed.snapshot.reason).toContain("has not reported since");
  });

  it("carries the BFF's live account fallback when the snapshot is stale", () => {
    const parsed = parseLendingAgentView({
      data: {
        ...agentView,
        snapshot: { ...agentView.snapshot, stale: true, payload: null, reason: "stale" },
        liveAccount: guardable,
      },
    });
    expect(parsed).not.toBe(INVALID);
    if (parsed === INVALID) return;
    expect(parsed.liveAccount?.bases.liquidation.hf).toBe("1180000000000000000");
  });

  // A payload the page cannot map must NOT blank the guard row and the rescue
  // log; it degrades to "no payload", which every tile then dashes with a reason.
  it("keeps the guard row and rescues when the snapshot payload is unmappable", () => {
    const parsed = parseLendingAgentView({
      data: { ...agentView, snapshot: { ...agentView.snapshot, payload: { version: 1, nonsense: true } } },
    });
    expect(parsed).not.toBe(INVALID);
    if (parsed === INVALID) return;
    expect(parsed.snapshot.payload).toBeNull();
    expect(parsed.guard.guardedAccount).toBe(ACCOUNT);
    expect(parsed.rescues).toHaveLength(1);
  });

  it("refuses a missing guard, a bad status, a bad hold and a bad close reason", () => {
    for (const bad of [
      { ...agentView, guard: undefined },
      { ...agentView, guard: { ...guardRow, status: "arming-ish" } },
      { ...agentView, guard: { ...guardRow, hold: "confused" } },
      { ...agentView, guard: { ...guardRow, closeReason: "gave-up" } },
      { ...agentView, guard: { ...guardRow, armTxHash: "0x00" } },
      { ...agentView, snapshot: undefined },
      { ...agentView, rescues: [{ ...agentView.rescues[0], effect: "maybe" }] },
    ]) {
      expect(parseLendingAgentView({ data: bad }), JSON.stringify(bad).slice(0, 60)).toBe(INVALID);
    }
  });
});

describe("arm and retire outcomes — an HTTP 200 is not an outcome", () => {
  const arm = {
    status: "completed", code: undefined, reason: undefined, txHash: HASH, effect: "changed",
    idleUsdtWei: "1000000000000000000", mintUsdtWei: "40000000000000000000",
    supplyNativeWei: "40000000000000000", reserveNativeWei: "10000000000000000", swapFeeTier: 100,
  };
  it("reads a completed arm and refuses a payload with no arm block", () => {
    const parsed = parseLendingArmOutcome({ data: { arm } });
    expect(parsed).not.toBe(INVALID);
    if (parsed === INVALID) return;
    expect(parsed.status).toBe("completed");
    expect(parsed.effect).toBe("changed");
    expect(parseLendingArmOutcome({ data: {} })).toBe(INVALID);
    expect(parseLendingArmOutcome({ data: { replayed: true } })).toBe(INVALID);
    expect(parseLendingArmOutcome({ data: { arm: { ...arm, status: "ok" } } })).toBe(INVALID);
  });

  const retire = {
    status: "completed", txHash: HASH, cleared: true,
    redeemAmountWei: "30000000000000000000", swapInWei: "31000000000000000000",
    minOutWei: "49750000000000000", poolShort: false,
    remainderUsdtWei: "0", residueUsdtWei: "0",
  };
  it("never says \"retired\" for a bare 200, a held batch or an uncleared reserve", () => {
    expect(lendingRetireOutcomeText(parseLendingRetireOutcome({ data: {} }))).toContain("Outcome unavailable");
    expect(lendingRetireOutcomeText(parseLendingRetireOutcome({ data: { retire } })))
      .toBe("Retired — the reserve is back in the agent wallet as BNB.");
    expect(lendingRetireOutcomeText(parseLendingRetireOutcome({
      data: { retire: { ...retire, status: "held", reason: "relay was ambiguous" } },
    }))).toContain("Retire held");
    expect(lendingRetireOutcomeText(parseLendingRetireOutcome({
      data: { retire: { ...retire, cleared: false, residueUsdtWei: "5000000000000000000" } },
    }))).toContain("still supplied on Venus");
    expect(lendingRetireOutcomeText(parseLendingRetireOutcome({
      data: { retire: { ...retire, poolShort: true, remainderUsdtWei: "5000000000000000000" } },
    }))).toContain("remainder stays supplied on Venus");
  });

  it("refuses a retire block missing `cleared` — the only field that means \"it came back\"", () => {
    const { cleared: _dropped, ...withoutCleared } = retire;
    expect(parseLendingRetireOutcome({ data: { retire: withoutCleared } })).toBe(INVALID);
  });
});
