/**
 * PHASE4 — the trigger layer (R2.2, R2.6, R2.15/R23, R2.16/R26).
 *
 * Test obligation 2. The named enemy is FINDINGS (ae): the LP hysteresis
 * counter lived in a per-process `Map`, so `--once` could never fire and every
 * restart zeroed every counter — "the fail-safe direction" that looks like the
 * system working. These tests pin the four properties that make that
 * impossible here: the counter is read from a DURABLE row, the spacing
 * comparison uses the FROZEN cycle clock, an over-age row is not consecutive
 * with anything, and a settings change invalidates the row rather than
 * carrying a confirmation across a change of meaning.
 *
 * The fail-closed ORDER is pinned too, because it is load-bearing: a protocol
 * mismatch must outrank every other answer (a mismatch means the whole sizing
 * pipeline is wrong, not that the number is smaller).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { E18 } from "../src/venus/risk.js";
import { evaluateVenusTrigger, venusMaxObservationAgeMs } from "../src/venus/triggers.js";
import type { VenusAccountReading, VenusMarketReading } from "../src/venus/types.js";
import type { VenusObservation } from "../src/store/venusObservations.js";

const V_BNB = getAddress("0x2222222222222222222222222222222222222222");
const V_USDT = getAddress("0x1111111111111111111111111111111111111111");
const USDT = getAddress("0x3333333333333333333333333333333333333333");
const OWNER = getAddress("0x561b561ef37874c8e61534be9bae52eb6261ddc4");
const DIGEST = (`0x${"ab".repeat(32)}`) as Hex;
const OTHER_DIGEST = (`0x${"be".repeat(32)}`) as Hex;

const INTERVAL = 30_000;
const MAX_AGE = venusMaxObservationAgeMs(INTERVAL);

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

function market(overrides: Partial<VenusMarketReading> = {}): VenusMarketReading {
  return {
    vToken: V_BNB,
    vTokenSymbol: "vBNB",
    vTokenDecimals: 8,
    underlying: null,
    underlyingDecimals: 18,
    native: true,
    listed: true,
    borrowAllowed: true,
    collateralMember: true,
    vTokenBalance: 8n * E18,
    borrowStored: 0n,
    exchangeRateStored: 220_000_000_000_000_000n,
    borrowCurrent: 0n,
    exchangeRateCurrent: 220_000_000_000_000_000n,
    effectiveCf: pct("0.8"),
    effectiveLt: pct("0.8"),
    spotPrice: pct("600"),
    boundedCollateralPrice: pct("600"),
    boundedDebtPrice: pct("600"),
    mintPaused: false,
    repayPaused: false,
    supplyHeadroom: 10n ** 24n,
    ...overrides,
  } as VenusMarketReading;
}

function debtMarket(overrides: Partial<VenusMarketReading> = {}): VenusMarketReading {
  return market({
    vToken: V_USDT,
    vTokenSymbol: "vUSDT",
    underlying: USDT,
    native: false,
    collateralMember: false,
    vTokenBalance: 0n,
    borrowStored: 700n * E18,
    borrowCurrent: 700n * E18,
    exchangeRateStored: E18,
    exchangeRateCurrent: E18,
    spotPrice: pct("1"),
    boundedCollateralPrice: pct("1"),
    boundedDebtPrice: pct("1"),
    ...overrides,
  });
}

/**
 * A reading whose protocol answers AGREE with the reconstruction by
 * construction: W = 844.8, D = 700, so liquidity = 144.8 and HF = 1.2068.
 * That is below a 1.30 trigger and above 1.0 — the guard's real working range.
 */
function reading(overrides: Partial<VenusAccountReading> = {}): VenusAccountReading {
  const markets = [market(), debtMarket()];
  const w = pct("844.8");
  const d = pct("700");
  return {
    blockNumber: 117_741_526n,
    blockHash: "0xd611" as Hex,
    owner: OWNER,
    protocolPaused: false,
    userPoolId: 0n,
    lastPoolId: 15n,
    vaiDebt: 0n,
    accountLiquidity: [0n, w - d, 0n],
    borrowingPower: [0n, w - d, 0n],
    markets,
    snapshotErrorMarket: null,
    ...overrides,
  };
}

function observation(overrides: Partial<VenusObservation> = {}): VenusObservation {
  return {
    blockNumber: 117_741_000n,
    evaluatedAtMs: 1_000_000,
    healthFactor: pct("1.2068"),
    shortfall: false,
    breach: true,
    consecutive: 1,
    settingsDigest: DIGEST,
    collateral: pct("844.8"),
    debt: pct("700"),
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    reading: reading(),
    triggerHf: pct("1.3"),
    settingsDigest: DIGEST,
    previous: null,
    cycleNowMs: 1_000_000 + INTERVAL,
    intervalMs: INTERVAL,
    maxObservationAgeMs: MAX_AGE,
    ...overrides,
  } as Parameters<typeof evaluateVenusTrigger>[0];
}

describe("venus trigger: the fail-closed order", () => {
  it("a snapshot error outranks everything and yields NO observation to persist", () => {
    const decision = evaluateVenusTrigger(
      input({ reading: reading({ snapshotErrorMarket: V_USDT }) }),
    );
    assert.equal(decision.kind, "refuse");
    if (decision.kind !== "refuse") return;
    assert.equal(decision.condition, "snapshot-error");
    // Nothing may be written: an unreadable basis is not an observation.
    assert.equal(decision.observation, null);
  });

  it("a non-zero Comptroller error code refuses, even with a prior confirmation banked", () => {
    const decision = evaluateVenusTrigger(
      input({
        reading: reading({ accountLiquidity: [3n, 0n, 0n] }),
        previous: observation(),
      }),
    );
    assert.equal(decision.kind, "refuse");
    if (decision.kind !== "refuse") return;
    assert.equal(decision.condition, "protocol-error");
    assert.equal(decision.observation, null);
  });

  it("a ONE-WEI protocol mismatch refuses and outranks a ready-to-act counter", () => {
    // The counter is otherwise perfect: prior breach, right digest, exactly one
    // interval old. The mismatch must still win — R2.2's whole point.
    const decision = evaluateVenusTrigger(
      input({
        reading: reading({ accountLiquidity: [0n, pct("144.8") + 1n, 0n] }),
        previous: observation(),
      }),
    );
    assert.equal(decision.kind, "refuse");
    if (decision.kind !== "refuse") return;
    assert.equal(decision.condition, "protocol-mismatch");
  });

  it("an uninterpretable E-Mode pool refuses; an interpretable one does NOT", () => {
    const unknown = evaluateVenusTrigger(
      input({ reading: reading({ userPoolId: 99n, lastPoolId: 15n }) }),
    );
    assert.equal(unknown.kind, "refuse");
    if (unknown.kind === "refuse") assert.equal(unknown.condition, "emode-unverified");

    // R2.15/R21: a KNOWN non-zero pool is acted on, not refused. The blanket
    // `userPoolId != 0` refusal was replaced precisely here.
    const known = evaluateVenusTrigger(
      input({ reading: reading({ userPoolId: 3n, lastPoolId: 15n }) }),
    );
    assert.notEqual(known.kind, "refuse");
  });

  it("a zero oracle price refuses rather than valuing a leg at nothing — bounded prices included", () => {
    // Only the BOUNDED debt price is zeroed, so the liquidation basis (spot on
    // both legs) is untouched and still matches, while the borrowing-power
    // basis sees D = 0 and matches a liquidity of the full weighted collateral.
    // Both equalities therefore hold and the oracle check is the one that has
    // to catch this — which also proves the check covers the bounded pair and
    // not merely spot.
    const decision = evaluateVenusTrigger(
      input({
        reading: reading({
          markets: [market(), debtMarket({ boundedDebtPrice: 0n })],
          borrowingPower: [0n, pct("844.8"), 0n],
        }),
      }),
    );
    assert.equal(decision.kind, "refuse");
    if (decision.kind !== "refuse") return;
    assert.equal(decision.condition, "oracle-invalid");
  });
});

describe("venus trigger: hysteresis, and why FINDINGS (ae) cannot recur", () => {
  it("the FIRST qualifying observation holds — one breach is never enough", () => {
    const decision = evaluateVenusTrigger(input({ previous: null }));
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.condition, "awaiting-confirmation");
    assert.equal(decision.observation.breach, true);
    assert.equal(decision.observation.consecutive, 1);
  });

  it("a SECOND breach one interval later ACTS — and this is the `--once` property", () => {
    // The durable row is the only thing that makes this reachable: nothing in
    // this call graph remembers the first observation. A fresh process reading
    // the row acts on its FIRST cycle, which is exactly what `--once` needs and
    // exactly what the in-memory Map could never do.
    const decision = evaluateVenusTrigger(input({ previous: observation() }));
    assert.equal(decision.kind, "act");
    if (decision.kind !== "act") return;
    assert.equal(decision.reason, "confirmed-breach");
    assert.equal(decision.observation.consecutive, 2);
  });

  it("ONE MILLISECOND under the interval holds — two runs against a lagging node cannot manufacture a confirmation", () => {
    const decision = evaluateVenusTrigger(
      input({ previous: observation(), cycleNowMs: 1_000_000 + INTERVAL - 1 }),
    );
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.condition, "awaiting-confirmation");
    assert.match(decision.detail, /must not manufacture a confirmation/u);
  });

  it("exactly AT the interval acts — the bound is inclusive, and 59 970 ms against 60 000 is the bug it exists for", () => {
    const decision = evaluateVenusTrigger(
      input({ previous: observation(), cycleNowMs: 1_000_000 + INTERVAL }),
    );
    assert.equal(decision.kind, "act");
  });

  it("an OVER-AGE row is not consecutive with anything — a week-old worker restart does not act on cycle one", () => {
    const decision = evaluateVenusTrigger(
      input({ previous: observation(), cycleNowMs: 1_000_000 + MAX_AGE + 1 }),
    );
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.condition, "observation-stale");
    // It still banks a fresh first observation, so the NEXT cycle can act.
    assert.equal(decision.observation.consecutive, 1);
  });

  it("a SETTINGS CHANGE invalidates the counter — a confirmation cannot cross a change of meaning", () => {
    const decision = evaluateVenusTrigger(
      input({ previous: observation({ settingsDigest: OTHER_DIGEST }) }),
    );
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.match(decision.detail, /different settings/u);
    assert.equal(decision.observation.settingsDigest, DIGEST);
  });

  it("a previous NON-breach restarts the count rather than completing it", () => {
    const decision = evaluateVenusTrigger(
      input({ previous: observation({ breach: false, consecutive: 0 }) }),
    );
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.observation.consecutive, 1);
  });

  it("HF at or above the trigger holds with no breach recorded", () => {
    const decision = evaluateVenusTrigger(input({ triggerHf: pct("1.1") }));
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.condition, "hf-above-trigger");
    assert.equal(decision.observation.breach, false);
  });

  it("zero debt is HF = infinity, and the guard is written before any division", () => {
    const decision = evaluateVenusTrigger(
      input({
        reading: reading({
          markets: [market(), debtMarket({ borrowStored: 0n, borrowCurrent: 0n })],
          accountLiquidity: [0n, pct("844.8"), 0n],
          borrowingPower: [0n, pct("844.8"), 0n],
        }),
      }),
    );
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.observation.healthFactor, null);
    assert.equal(decision.observation.breach, false);
  });

  it("notifyOnlyBelowHf reports approaching WITHOUT acting", () => {
    const decision = evaluateVenusTrigger(
      input({ triggerHf: pct("1.1"), notifyOnlyBelowHf: pct("1.5") }),
    );
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.condition, "hf-above-trigger");
    assert.match(decision.detail, /watch level/u);
  });
});

describe("venus trigger: shortfall and third-party liquidation", () => {
  it("shortfall acts on ONE confirmation — waiting an interval IS the loss", () => {
    const decision = evaluateVenusTrigger(
      input({
        previous: null,
        reading: reading({
          accountLiquidity: [0n, 0n, pct("55.2")],
          borrowingPower: [0n, 0n, pct("55.2")],
          markets: [market(), debtMarket({ borrowStored: 900n * E18, borrowCurrent: 900n * E18 })],
        }),
      }),
    );
    assert.equal(decision.kind, "act");
    if (decision.kind !== "act") return;
    assert.equal(decision.reason, "shortfall");
    assert.equal(decision.observation.shortfall, true);
  });

  it("BOTH legs falling is read as a liquidation: counter reset, cycle skipped, owner told", () => {
    // A liquidator seizes collateral AND repays debt, so both fall together.
    // HF then RISES, and without this branch the owner would be shown a
    // healthy no-op on the cycle their position was partly taken.
    const decision = evaluateVenusTrigger(
      input({
        previous: observation({ collateral: pct("1000"), debt: pct("800") }),
      }),
    );
    assert.equal(decision.kind, "hold");
    if (decision.kind !== "hold") return;
    assert.equal(decision.condition, "position-liquidated");
    assert.equal(decision.observation.consecutive, 0);
  });

  it("collateral alone falling is a PRICE MOVE, not a liquidation — and it still acts", () => {
    // The discriminator is the conjunction. A collateral-token drop lowers W
    // and leaves D alone; treating that as a liquidation would disarm the guard
    // in precisely the scenario it exists for.
    const decision = evaluateVenusTrigger(
      input({ previous: observation({ collateral: pct("1000"), debt: pct("700") }) }),
    );
    assert.equal(decision.kind, "act");
  });

  it("debt alone falling is not a liquidation either — accrual can only RAISE debt, so this is a repay", () => {
    const decision = evaluateVenusTrigger(
      input({ previous: observation({ collateral: pct("844.8"), debt: pct("900") }) }),
    );
    assert.equal(decision.kind, "act");
  });

  it("a sub-threshold wobble on both legs is NOT a liquidation", () => {
    // 1 bp of movement is noise; the detector's floor keeps it from eating
    // ordinary rounding as a seizure.
    const decision = evaluateVenusTrigger(
      input({
        previous: observation({
          collateral: pct("844.8") + pct("844.8") / 100_000n,
          debt: pct("700") + pct("700") / 100_000n,
        }),
      }),
    );
    assert.equal(decision.kind, "act");
  });
});

describe("venus trigger: the staleness bound itself", () => {
  it("is a multiple of the interval, and refuses to be tighter than two", () => {
    assert.equal(venusMaxObservationAgeMs(30_000), 90_000);
    assert.ok(venusMaxObservationAgeMs(30_000) >= 2 * 30_000);
  });
});
