/**
 * The Venus trigger — the pure evaluator (PHASE4-SPEC D2, R2.2, R2.6, R2.12,
 * R2.15/R21 and R23, R2.16/R26, R3.11).
 *
 * ═══ WHAT THE TRIGGER ACTUALLY IS ═════════════════════════════════════════
 *
 * No Venus call returns a health factor; `getAccountLiquidity` returns a
 * DIFFERENCE. So HF is a 4lpha-computed quantity, reconstructed locally on both
 * bases and CROSS-CHECKED against the protocol's own difference for EXACT
 * equality. A mismatch on EITHER basis is `protocol-mismatch` and fails closed
 * — never a smaller number. "Byte-for-byte with the protocol's own liquidity
 * answer" was deleted from this phase and must not come back.
 *
 * That equality is a PER-ACCOUNT, PER-BLOCK PROOF that the effective factors
 * were applied correctly, which is stronger evidence than any one-off live
 * observation — and it is why the E-Mode posture is "act on any pool" rather
 * than "refuse `userPoolId != 0`" (R2.15/R21). `emode-unverified` now means
 * exactly one thing: a pool configuration the plane cannot interpret
 * (`userPoolId > lastPoolId`).
 *
 * The proof runs on the STORED basis, because that is what the protocol
 * answers. It TRANSFERS to the CURRENT sizing basis because both use the
 * identical effective-factor set and the identical R2.3 price pairing —
 * CURRENT substitutes only fresher balances into a pipeline the proof just
 * validated (R3.11/S14).
 *
 * ═══ HYSTERESIS: DURABLE FROM THE FIRST LINE ══════════════════════════════
 *
 * The Phase 3 (ae) failure is the named enemy: a per-process counter meant
 * `--once` could never fire and every restart zeroed every position. Here the
 * counter is a durable row, and the predicate is spelled out (R2.16/R26) so a
 * test cannot assert the wrong thing:
 *
 *   A prior durable observation whose SETTINGS DIGEST MATCHES, whose stamp is
 *   at least ONE WORKER INTERVAL old AND within
 *   `VENUS_MAX_OBSERVATION_AGE_MS`, and whose basis RE-QUALIFIES on this
 *   cycle's fresh read.
 *
 * The minimum spacing is enforced against the RECORDED STAMP, not a run count:
 * two `--once` runs against one lagging node must not manufacture
 * confirmations. The staleness bound exists because an observation from three
 * days ago is not "consecutive" with anything.
 *
 * `shortfall > 0` — the account is ALREADY liquidatable — skips hysteresis:
 * ONE finalized confirmation suffices, because waiting an interval is itself
 * the loss. R2.14 is honest about what that carve-out buys: it fires after the
 * account is liquidatable, racing bots that read `latest` and the mempool, and
 * the plane will usually LOSE. The guard's real working range is
 * `1.0 < HF < triggerHf`.
 */
import type { Address } from "viem";
import type { Hex } from "viem";
import {
  calculateVenusRisk,
  riskMatchesProtocol,
  type VenusRiskMarketInput,
  type VenusRiskPair,
} from "./risk.js";
import type { VenusObservation } from "../store/venusObservations.js";
import type { VenusAccountReading, VenusCondition } from "./types.js";

/** Both reconstructed bases plus their per-basis match flags (D10 reports both). */
export type VenusBasisView = {
  readonly pair: VenusRiskPair;
  readonly liquidationMatched: boolean;
  readonly borrowingPowerMatched: boolean;
};

/**
 * Build the risk inputs for one basis from a finalized account reading.
 *
 * `stored` mirrors what `getAccountSnapshot` answered, which is what the
 * protocol's own call matches. `current` substitutes the `eth_call` figures and
 * is `null` when ANY active market's simulation failed — a partly-current basis
 * would be neither basis.
 */
export function venusRiskInputs(
  reading: VenusAccountReading,
): { readonly stored: VenusRiskMarketInput[]; readonly current: VenusRiskMarketInput[] | null } {
  const active = reading.markets.filter(
    (market) =>
      market.vTokenBalance !== 0n
      || market.borrowStored !== 0n
      || market.collateralMember,
  );
  const common = (market: (typeof active)[number]): Omit<VenusRiskMarketInput, "exchangeRate" | "borrowBalance"> => ({
    collateralMember: market.collateralMember,
    vTokenBalance: market.vTokenBalance,
    collateralFactor: market.effectiveCf,
    liquidationThreshold: market.effectiveLt,
    collateralPrice: market.boundedCollateralPrice,
    debtPrice: market.boundedDebtPrice,
    spotPrice: market.spotPrice,
  });
  const stored = active.map((market) => ({
    ...common(market),
    exchangeRate: market.exchangeRateStored,
    borrowBalance: market.borrowStored,
  }));
  const everyCurrent = active.every(
    (market) => market.borrowCurrent !== null && market.exchangeRateCurrent !== null,
  );
  const current = everyCurrent
    ? active.map((market) => ({
        ...common(market),
        exchangeRate: market.exchangeRateCurrent as bigint,
        borrowBalance: market.borrowCurrent as bigint,
      }))
    : null;
  return { stored, current };
}

/**
 * Reconstruct both bases from the STORED read set and cross-check each against
 * its protocol answer.
 */
export function venusBasisView(reading: VenusAccountReading): VenusBasisView {
  const { stored } = venusRiskInputs(reading);
  const pair = calculateVenusRisk(stored, reading.vaiDebt);
  return {
    pair,
    liquidationMatched: riskMatchesProtocol(
      pair.liquidationRisk,
      reading.accountLiquidity[0],
      reading.accountLiquidity[1],
      reading.accountLiquidity[2],
    ),
    borrowingPowerMatched: riskMatchesProtocol(
      pair.borrowingPower,
      reading.borrowingPower[0],
      reading.borrowingPower[1],
      reading.borrowingPower[2],
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* The observation-age bound (R2.6)                                           */
/* -------------------------------------------------------------------------- */

/** Default maximum observation age: three intervals (R2.6). */
export function venusMaxObservationAgeMs(intervalMs: number): number {
  return 3 * intervalMs;
}

/**
 * The FLOOR the boot resolver refuses below: two intervals.
 *
 * Below two intervals a previous observation can never satisfy BOTH "at least
 * one interval old" and "not older than the bound" on a cycle that ran even
 * slightly late — the confirmation would be structurally unreachable, and the
 * guard would look armed while being unable to fire. That is (ae)'s shape with
 * a config key instead of a `Map`.
 */
export function venusMinObservationAgeBoundMs(intervalMs: number): number {
  return 2 * intervalMs;
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Basis points of movement below which a fall in collateral OR debt is treated
 * as ordinary noise rather than as a liquidation.
 */
export const VENUS_LIQUIDATION_DETECT_BPS = 100n;

export type VenusTriggerInput = {
  readonly reading: VenusAccountReading;
  readonly triggerHf: bigint;
  readonly notifyOnlyBelowHf?: bigint;
  readonly settingsDigest: Hex;
  readonly previous: VenusObservation | null;
  /** The FROZEN cycle clock (R2.6) — the only clock this function may see. */
  readonly cycleNowMs: number;
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
};

export type VenusTriggerDecision =
  | {
      readonly kind: "refuse";
      readonly condition: VenusCondition;
      readonly detail: string;
      readonly observation: VenusObservation | null;
      readonly view: VenusBasisView;
    }
  | {
      readonly kind: "hold";
      readonly condition: VenusCondition;
      readonly detail: string;
      readonly observation: VenusObservation;
      readonly view: VenusBasisView;
    }
  | {
      readonly kind: "act";
      readonly reason: "confirmed-breach" | "shortfall";
      readonly observation: VenusObservation;
      readonly view: VenusBasisView;
    };

/**
 * Evaluate one finalized reading against the durable counter.
 *
 * Order matters and is the fail-closed order: protocol answers first (a
 * mismatch means every number downstream is wrong), then the E-Mode
 * interpretability gate, then liquidation detection, then the threshold, then
 * hysteresis. Nothing here writes; the caller persists the returned
 * observation BELOW the dispatch (R2.6).
 */
export function evaluateVenusTrigger(
  input: VenusTriggerInput,
): VenusTriggerDecision {
  const { reading } = input;
  const view = venusBasisView(reading);
  const liquidation = view.pair.liquidationRisk;

  const observation = (breach: boolean, consecutive: number): VenusObservation => ({
    blockNumber: reading.blockNumber,
    evaluatedAtMs: input.cycleNowMs,
    healthFactor: liquidation.healthFactor,
    shortfall: liquidation.shortfall > 0n,
    breach,
    consecutive,
    settingsDigest: input.settingsDigest,
    collateral: liquidation.collateral,
    debt: liquidation.debt,
  });

  if (reading.snapshotErrorMarket !== null) {
    return {
      kind: "refuse",
      condition: "snapshot-error",
      detail: `getAccountSnapshot returned a non-zero code on ${reading.snapshotErrorMarket}.`,
      observation: null,
      view,
    };
  }
  if (reading.accountLiquidity[0] !== 0n || reading.borrowingPower[0] !== 0n) {
    return {
      kind: "refuse",
      condition: "protocol-error",
      detail:
        `The Comptroller returned a non-zero error code ` +
        `(getAccountLiquidity ${reading.accountLiquidity[0]}, ` +
        `getBorrowingPower ${reading.borrowingPower[0]}).`,
      observation: null,
      view,
    };
  }
  if (!view.liquidationMatched || !view.borrowingPowerMatched) {
    return {
      kind: "refuse",
      condition: "protocol-mismatch",
      detail:
        "The local reconstruction does not equal the protocol's own answer " +
        `(liquidation matched=${view.liquidationMatched}, ` +
        `borrowingPower matched=${view.borrowingPowerMatched}). Failing closed: ` +
        "a mismatch means the sizing pipeline is wrong, not that the number is smaller.",
      observation: null,
      view,
    };
  }
  if (reading.userPoolId > reading.lastPoolId) {
    return {
      kind: "refuse",
      condition: "emode-unverified",
      detail:
        `userPoolId ${reading.userPoolId} exceeds lastPoolId ${reading.lastPoolId}; ` +
        "the account sits in a pool configuration this plane cannot interpret. " +
        "Failing closed toward waking the owner, not toward a wrong amount.",
      observation: null,
      view,
    };
  }
  for (const market of reading.markets) {
    if (
      market.spotPrice === 0n
      || market.boundedCollateralPrice === 0n
      || market.boundedDebtPrice === 0n
    ) {
      return {
        kind: "refuse",
        condition: "oracle-invalid",
        detail: `${market.vToken} has a zero oracle price; no decision is made on it.`,
        observation: null,
        view,
      };
    }
  }

  // R2.15/R23 — liquidation during the confirmation window. The discriminator
  // is the CONJUNCTION: a liquidator seizes collateral AND repays debt, so both
  // fall together, while an ordinary price move pushes the two legs
  // independently (a collateral-token drop lowers W and leaves D alone). Accrual
  // can only RAISE debt, so a material fall in D is never accrual.
  //
  // The consequence is a NOTIFICATION, never a silent `hf-above-trigger`: HF
  // rises after a liquidation and the second observation stops qualifying, so
  // without this the owner would be shown a healthy no-op on the cycle their
  // position was partly taken.
  const previous = input.previous;
  if (previous !== null && previous.settingsDigest === input.settingsDigest) {
    const fellBy = (before: bigint, after: bigint): boolean =>
      before > 0n && after < before && ((before - after) * 10_000n) / before >= VENUS_LIQUIDATION_DETECT_BPS;
    if (
      fellBy(previous.collateral, liquidation.collateral)
      && fellBy(previous.debt, liquidation.debt)
    ) {
      return {
        kind: "hold",
        condition: "position-liquidated",
        detail:
          `Both collateral and debt fell between observations (collateral ` +
          `${previous.collateral} -> ${liquidation.collateral}, debt ${previous.debt} -> ` +
          `${liquidation.debt}), which accrual cannot explain and a price move does not ` +
          "produce on both legs at once. A third party likely liquidated part of this " +
          "position. The counter is reset and the cycle is skipped.",
        // Counter RESET: `consecutive: 0`, and `breach` recorded honestly.
        observation: observation(
          liquidation.healthFactor !== null
            && liquidation.healthFactor < input.triggerHf,
          0,
        ),
        view,
      };
    }
  }

  const shortfall = liquidation.shortfall > 0n;
  const hf = liquidation.healthFactor;
  // `debt == 0` is HF = ∞ = healthy, and the check comes FIRST — never a
  // division written before the guard.
  const breach = hf !== null && hf < input.triggerHf;

  if (!breach && !shortfall) {
    const approaching =
      input.notifyOnlyBelowHf !== undefined
      && hf !== null
      && hf < input.notifyOnlyBelowHf;
    return {
      kind: "hold",
      condition: "hf-above-trigger",
      detail: approaching
        ? `HF ${hf} is above triggerHf ${input.triggerHf} but below the ` +
          `notifyOnlyBelowHf watch level ${input.notifyOnlyBelowHf}.`
        : hf === null
          ? "The account carries no debt; HF is infinite."
          : `HF ${hf} is above triggerHf ${input.triggerHf}.`,
      observation: observation(false, 0),
      view,
    };
  }

  if (shortfall) {
    // Already liquidatable: ONE finalized confirmation suffices. Waiting an
    // interval IS the loss.
    return {
      kind: "act",
      reason: "shortfall",
      observation: observation(true, 1),
      view,
    };
  }

  // The R2.16/R26 predicate, spelled out.
  const usable =
    previous !== null
    && previous.settingsDigest === input.settingsDigest
    && previous.breach
    && input.cycleNowMs - previous.evaluatedAtMs >= input.intervalMs
    && input.cycleNowMs - previous.evaluatedAtMs <= input.maxObservationAgeMs;

  if (!usable) {
    const detail =
      previous === null
        ? "First qualifying observation; a rescue needs two, at least one worker interval apart."
        : previous.settingsDigest !== input.settingsDigest
          ? "The previous observation was taken under different settings; the counter is invalidated."
          : !previous.breach
            ? "The previous observation did not breach; the counter restarts."
            : input.cycleNowMs - previous.evaluatedAtMs < input.intervalMs
              ? `The previous observation is only ${input.cycleNowMs - previous.evaluatedAtMs} ms old ` +
                `against an interval of ${input.intervalMs} ms; two runs against one lagging node ` +
                "must not manufacture a confirmation."
              : `The previous observation is ${input.cycleNowMs - previous.evaluatedAtMs} ms old, past ` +
                `the ${input.maxObservationAgeMs} ms staleness bound; it is not consecutive with anything.`;
    return {
      kind: "hold",
      condition:
        previous !== null
        && previous.breach
        && previous.settingsDigest === input.settingsDigest
        && input.cycleNowMs - previous.evaluatedAtMs > input.maxObservationAgeMs
          ? "observation-stale"
          : "awaiting-confirmation",
      detail,
      observation: observation(true, 1),
      view,
    };
  }

  return {
    kind: "act",
    reason: "confirmed-breach",
    observation: observation(true, previous.consecutive + 1),
    view,
  };
}

/** The vTokens a claim submission should name — the owner's own market list. */
export function venusClaimMarkets(
  reading: VenusAccountReading,
  named: readonly Address[],
): readonly Address[] {
  const wanted = new Set(named.map((entry) => entry.toLowerCase()));
  return reading.markets
    .filter((market) => wanted.has(market.vToken.toLowerCase()) && market.listed)
    .map((market) => market.vToken);
}
