/**
 * The lending detail page's arithmetic and its copy — pure, so every tile can
 * be tested without a browser.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a tile with no source shows a DASH WITH
 * ITS REASON, never a number. Every function here returns
 * `{ value: null, reason }` rather than a zero, a guess, or a figure derived
 * from a price nobody read.
 */
import type { DetailMetric } from "@/lib/exec/agent-detail";
import {
  type LendingAgentView,
  type LendingConfigView,
  type LendingGuardView,
  type LendingGuardableView,
  type LendingMarketView,
  type LendingRescueView,
  type LendingSnapshotPayload,
} from "@/lib/exec/lending-types";
import { formatAtomicAmount, formatHf } from "./form";

const E18 = 10n ** 18n;

export function unavailable(reason: string): DetailMetric {
  return { value: null, reason };
}

/* -------------------------------------------------------------------------- */
/* The hero: the health factor the guard actually decides on                  */
/* -------------------------------------------------------------------------- */

export type LendingHealth = {
  readonly value: string | null;
  readonly reason: string | null;
  /**
   * Whether the plane's reconstruction matched Venus's own account-liquidity
   * call. `null` when nothing said either way — the SNAPSHOT does not carry the
   * flag, so a fresh snapshot derives it from the absence of the
   * `protocol-mismatch` condition and says so.
   */
  readonly matched: boolean | null;
  readonly matchedNote: string;
  /** True when the figure came from the BFF's live read, not from the agent. */
  readonly live: boolean;
};

/**
 * The LIQUIDATION-basis health factor.
 *
 * Fresh snapshot: `observation.healthFactor`, which the worker writes from
 * `pair.liquidationRisk.healthFactor` — the exact number the trigger compares
 * against `triggerHf`. Stale snapshot: the BFF's live `/lending/guardable` read
 * (R2.18), labelled. Neither available: a dash with the staleness reason.
 */
export function lendingHealth(view: LendingAgentView): LendingHealth {
  const payload = view.snapshot.payload;
  if (!view.snapshot.stale && payload !== null) {
    const hf = payload.observation?.healthFactor ?? null;
    const mismatch = payload.conditions.some((entry) => entry.condition === "protocol-mismatch");
    return {
      value: hf === null ? null : formatHf(hf),
      reason: hf === null ? "the guard has observed no health factor for this account yet" : null,
      matched: mismatch ? false : true,
      matchedNote: mismatch
        ? "the plane's reconstruction does NOT match Venus's own account-liquidity call"
        : "no protocol mismatch recorded by the agent",
      live: false,
    };
  }
  const live = view.liveAccount;
  if (live !== undefined) {
    return {
      value: live.bases.liquidation.hf === null ? null : formatHf(live.bases.liquidation.hf),
      reason: live.bases.liquidation.hf === null ? "this account carries no debt on Venus" : null,
      matched: live.bases.liquidation.matched,
      matchedNote: live.bases.liquidation.matched
        ? "matches Venus's own account-liquidity call"
        : "does NOT match Venus's own account-liquidity call",
      live: true,
    };
  }
  return {
    value: null,
    reason: view.liveAccountReason ?? view.snapshot.reason ?? "the agent has not reported yet",
    matched: null,
    matchedNote: "no source for the protocol match flag",
    live: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Prices, from the PROTOCOL oracle only                                      */
/* -------------------------------------------------------------------------- */

/**
 * Venus's oracle price for one vToken's underlying, scaled so that
 * `amountWei × price / 1e18` is a 1e18-scaled USD value.
 *
 * Read from the guarded account's OWN market rows, which the plane populated
 * from the protocol's deviation-bounded oracle. There is deliberately no data
 * plane price anywhere on this page: the guard decides on these numbers, so the
 * page shows these numbers or none.
 */
function priceOf(markets: readonly LendingMarketView[], vToken: string | null): bigint | null {
  if (vToken === null) return null;
  const market = markets.find((entry) => entry.vToken.toLowerCase() === vToken.toLowerCase());
  if (market === undefined) return null;
  try {
    const price = BigInt(market.priceMantissa);
    return price > 0n ? price : null;
  } catch {
    return null;
  }
}

function usd18(value: bigint): string {
  const cents = (value * 100n + E18 / 2n) / E18;
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  return `${negative ? "-" : ""}$${magnitude / 100n}.${(magnitude % 100n).toString(10).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* Reserve and coverage                                                       */
/* -------------------------------------------------------------------------- */

export type LendingReserveLegs = {
  readonly usdtOnVenusWei: bigint;
  readonly idleUsdtWei: bigint;
  readonly bnbTierWei: bigint;
};

export function lendingReserveLegs(payload: LendingSnapshotPayload): LendingReserveLegs {
  return {
    usdtOnVenusWei: BigInt(payload.reserve.suppliedUsdtWei),
    idleUsdtWei: BigInt(payload.reserve.idleUsdtWei),
    bnbTierWei: BigInt(payload.reserve.bnbTierWei),
  };
}

/**
 * The reserve's value, priced from the protocol oracle, WITH its composition.
 *
 * A leg that holds value but cannot be priced (the guarded account is not in
 * that market, so its oracle row is absent) dashes the whole figure rather than
 * silently reporting the legs it could price — a partial total read as a total
 * is exactly the kind of number this page refuses to show.
 */
export function lendingReserveMetric(input: {
  readonly payload: LendingSnapshotPayload;
  readonly config: LendingConfigView | null;
  readonly usdtDecimals: number;
}): DetailMetric {
  const legs = lendingReserveLegs(input.payload);
  const markets = input.payload.account.markets;
  const note =
    `${formatAtomicAmount(legs.usdtOnVenusWei, input.usdtDecimals, 2)} USDT on Venus · `
    + `${formatAtomicAmount(legs.idleUsdtWei, input.usdtDecimals, 2)} idle USDT · `
    + `${formatAtomicAmount(legs.bnbTierWei, 18, 6)} BNB tier`;
  if (input.config === null) {
    return { value: null, reason: "the lending venue could not be read, so the reserve cannot be priced", note };
  }
  const usdtTotal = legs.usdtOnVenusWei + legs.idleUsdtWei;
  const usdtPrice = priceOf(markets, input.config.vUsdt);
  const bnbPrice = priceOf(markets, input.config.vBnb);
  if (usdtTotal > 0n && usdtPrice === null) {
    return { value: null, reason: "the guarded account is not in the vUSDT market, so the USDT leg has no protocol price here", note };
  }
  if (legs.bnbTierWei > 0n && bnbPrice === null) {
    return { value: null, reason: "the guarded account is not in the vBNB market, so the BNB tier has no protocol price here", note };
  }
  const value = (usdtTotal * (usdtPrice ?? 0n)) / E18 + (legs.bnbTierWei * (bnbPrice ?? 0n)) / E18;
  return {
    value: usd18(value),
    reason: null,
    note,
    bnb: `${formatAtomicAmount(legs.bnbTierWei, 18, 6)} BNB`,
    usd: usd18(value),
  };
}

/**
 * Coverage: the reserve's value over what the guard is pinned to repay.
 *
 * The plane's own `LendingReserveView` documents a `coverageBps`, but the
 * worker's snapshot does not carry one, so it is DERIVED here from the same
 * oracle rows the trigger used — and dashes with a named reason the moment any
 * leg or any pinned debt cannot be priced.
 */
export function lendingCoverageMetric(input: {
  readonly payload: LendingSnapshotPayload;
  readonly guard: LendingGuardView;
  readonly config: LendingConfigView | null;
}): DetailMetric {
  if (input.config === null) {
    return unavailable("the lending venue could not be read, so coverage cannot be priced");
  }
  const markets = input.payload.account.markets;
  const legs = lendingReserveLegs(input.payload);
  const usdtTotal = legs.usdtOnVenusWei + legs.idleUsdtWei;
  const usdtPrice = priceOf(markets, input.config.vUsdt);
  const bnbPrice = priceOf(markets, input.config.vBnb);
  if (usdtTotal > 0n && usdtPrice === null) {
    return unavailable("the USDT reserve leg has no protocol price on this account");
  }
  if (legs.bnbTierWei > 0n && bnbPrice === null) {
    return unavailable("the BNB tier has no protocol price on this account");
  }
  const reserveValue = (usdtTotal * (usdtPrice ?? 0n)) / E18 + (legs.bnbTierWei * (bnbPrice ?? 0n)) / E18;

  let debtValue = 0n;
  for (const vToken of input.guard.debtMarkets) {
    const market = markets.find((entry) => entry.vToken.toLowerCase() === vToken.toLowerCase());
    if (market === undefined) {
      return unavailable(`the guarded account no longer holds a ${vToken.slice(0, 8)}… position, so its debt cannot be priced`);
    }
    const price = priceOf(markets, vToken);
    if (price === null) return unavailable("a pinned debt market has no protocol price");
    debtValue += (BigInt(market.borrowWei) * price) / E18;
  }
  if (debtValue === 0n) {
    return { value: "—", reason: null, note: "this account owes nothing in the pinned markets right now" };
  }
  const bps = Number((reserveValue * 10_000n) / debtValue);
  return {
    value: `${(bps / 100).toFixed(1)}%`,
    reason: null,
    note: `${usd18(reserveValue)} reserve against ${usd18(debtValue)} of pinned debt`,
  };
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The owner-facing sentence for each condition the plane can emit.
 *
 * The taxonomy is CLOSED on both sides, so an unknown name falls through with
 * its raw text rather than being dropped — a condition nobody has reasoned
 * about is exactly the one an owner must still see.
 */
export function lendingConditionCopy(condition: string): string {
  switch (condition) {
    case "hf-above-trigger": return "The account is above your trigger. Nothing to do.";
    case "awaiting-confirmation": return "A breach was seen once. The guard acts on two finalized observations one interval apart, never on one.";
    case "observation-stale": return "The last observation is too old to act on; the guard waits for a fresh one.";
    case "protocol-mismatch": return "The plane's risk reconstruction disagrees with Venus's own numbers. The guard is paused until they agree — it will not act on figures it cannot trust.";
    case "emode-unverified": return "This account's E-Mode configuration has not been verified; the guard is paused.";
    case "oracle-invalid": return "Your account entered a market this guard cannot price; the guard is paused until it can.";
    case "account-too-complex": return "Your account entered more markets than this guard can price; the guard is paused until it can.";
    case "snapshot-error": return "The account's position could not be reconstructed this cycle.";
    case "protocol-error": return "Venus's Comptroller returned an error for this account.";
    case "protocol-paused": return "Venus has paused this market; nothing can be repaid into it right now.";
    case "action-paused": return "Venus has paused REPAY on this market.";
    case "position-liquidated": return "This account was liquidated. The confirmation counter is reset.";
    case "no-effect": return "A repay was submitted and confirmed but changed no debt. The slot is kept and the counter is not reset.";
    case "cooldown": return "The cooldown between repays has not elapsed.";
    case "killswitch": return "The platform kill switch is on; the guard will not submit.";
    case "session-expiring": return "This session expires within 48 hours. Retire the reserve and re-hire, or recover it with your passkey.";
    case "session-expired-or-revoked": return "The session is gone. The reserve is still yours — recover it with your passkey; the agent's key cannot block it.";
    case "unknown-held": return "A submission's outcome is ambiguous. v1 ships no owner-signed resolver for this; the next cycle re-plans against a fresh read.";
    case "transport": return "A read the guard needs was unavailable this cycle.";
    case "settings-absent": return "No settings are recorded for this guard.";
    case "market-not-in-grant": return "A market this guard would repay is not in its session grant.";
    case "market-delisted": return "A market this guard is pinned to has been delisted.";
    case "insufficient-wallet-balance": return "The agent wallet cannot fund the submission.";
    case "guarded-no-debt": return "The guarded account has repaid everything in the pinned markets. The guard is armed and idle.";
    case "unsupported-debt": return "This account owes in markets v1 cannot repay. They are watched, never repaid.";
    case "reserve-low": return "The reserve is below one full repay, so a rescue would be partial. It is still submitted — refusing a rescue is the trap this agent exists to avoid.";
    case "reserve-depleted": return "The reserve is empty. Retire and re-hire, or deposit and re-arm.";
    case "pool-cash-low": return "Venus's USDT pool cannot pay out the whole supplied leg in one go. The BNB tier covers the difference.";
    case "pool-cash-short": return "A retire could only redeem part of the supply; the rest stays supplied on Venus and is recoverable with your passkey.";
    case "arm-unknown": return "The reserve placement's outcome was ambiguous. A second arm is blocked — but rescues continue on whatever the wallet actually holds, and retire still works.";
    case "retire-unknown": return "A retire's outcome was ambiguous. Retire is blocked until it is understood; rescues continue on whatever remains.";
    case "insufficient-reserve": return "A partial rescue was submitted, with figures. It was never refused.";
    case "usdt-cap-exhausted": return "The session's rolling-day USDT cap is spent. Wait for the day to roll forward, or retire and re-hire with a larger cap.";
    case "native-cap-exhausted": return "The session's rolling-day BNB cap is spent.";
    case "cap-unreadable": return "A spend meter could not be read. The term is omitted from the sizing — it never refuses a rescue.";
    case "borrow-moved": return "The guarded account's debt fell between the sizing read and inclusion, and the repay reverted. The next cycle re-plans.";
    case "arm-never-submitted": return "An arm was recorded but never submitted; the guard converged itself to closed. Sign the arm again.";
    case "recovered-by-owner": return "The reserve was recovered with your passkey. The guard closed itself.";
    case "lending-disabled": return "The lending guard is off on this deployment.";
    default: return "This condition is not one this page recognizes. It is shown verbatim rather than dropped.";
  }
}

/** Conditions that should read as an alarm rather than as information. */
const ALARMING: ReadonlySet<string> = new Set([
  "protocol-mismatch", "oracle-invalid", "account-too-complex", "reserve-depleted",
  "session-expired-or-revoked", "killswitch", "arm-unknown", "retire-unknown",
  "usdt-cap-exhausted", "native-cap-exhausted", "protocol-paused", "action-paused",
  "position-liquidated", "market-not-in-grant", "market-delisted",
]);

export function lendingConditionTone(condition: string): "alarm" | "warn" | "info" {
  if (ALARMING.has(condition)) return "alarm";
  if (condition === "hf-above-trigger") return "info";
  return "warn";
}

/* -------------------------------------------------------------------------- */
/* Gates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * §6.1 as amended by R3.12: when Remove may be offered.
 *
 * `retired | closed` always. `retiring + pool-cash-short` ONLY behind the
 * owner's DECLARED CHOICE to leave the remainder supplied on Venus — which is
 * safe precisely because the passkey can still recover it, and which the page
 * must state as a figure rather than as a shrug.
 */
export function lendingRemoveGate(input: {
  readonly guard: LendingGuardView;
  readonly poolShort: boolean;
  readonly leaveRemainderAccepted: boolean;
}): { readonly allowed: boolean; readonly reason: string | null } {
  if (input.guard.status === "retired" || input.guard.status === "closed") {
    return { allowed: true, reason: null };
  }
  if (input.guard.status === "retiring" && input.poolShort) {
    return input.leaveRemainderAccepted
      ? { allowed: true, reason: null }
      : {
        allowed: false,
        reason: "Venus could not redeem the whole supply. Tick “leave the remaining supply on Venus (recoverable with my passkey)” to remove the agent anyway.",
      };
  }
  return {
    allowed: false,
    reason: `Retire the reserve first — this guard is ${input.guard.status} and still holds it.`,
  };
}

/** §6.2: when "Recover with passkey" is the door the owner needs. */
export function lendingRecoveryOffered(input: {
  readonly guard: LendingGuardView;
  readonly sessionExpiresAt: number | null;
  readonly agentStatus: string | null;
  readonly planeUnreachable: boolean;
  readonly nowSec: number;
}): boolean {
  if (input.guard.status === "retired" || input.guard.status === "closed") return false;
  if (input.planeUnreachable) return true;
  if (input.agentStatus === "revoked" || input.agentStatus === "retired") return true;
  return input.sessionExpiresAt !== null && input.sessionExpiresAt <= input.nowSec;
}

/** A short, copyable rendering of the guarded account. */
export function shortAddress(value: string): string {
  return value.length < 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** The account half the page renders — the agent's, or the BFF's live read. */
export function lendingAccountSource(view: LendingAgentView): {
  readonly markets: readonly LendingMarketView[];
  readonly live: boolean;
  readonly reason: string | null;
} {
  const payload = view.snapshot.payload;
  if (!view.snapshot.stale && payload !== null) {
    return { markets: payload.account.markets, live: false, reason: null };
  }
  const live: LendingGuardableView | undefined = view.liveAccount;
  if (live !== undefined) return { markets: live.markets, live: true, reason: null };
  return {
    markets: [],
    live: false,
    reason: view.liveAccountReason ?? view.snapshot.reason ?? "the agent has not reported yet",
  };
}

/* -------------------------------------------------------------------------- */
/* The two bases, each with its match flag (mock-up port, fix 2)              */
/* -------------------------------------------------------------------------- */

/**
 * One health-factor basis, and whether the plane's reconstruction EQUALLED
 * Venus's own account-liquidity answer for it.
 *
 * The match flag is not decoration. The whole trigger rests on the local
 * reconstruction agreeing with the Comptroller: when it does not, the guard
 * pauses rather than acting on a number it cannot trust. So an unmatched basis
 * is rendered NEXT TO the figure, never implied by the absence of a banner.
 */
export type LendingBasisCell = {
  readonly hf: string | null;
  /** The 1e18 mantissa behind `hf`, so "distance to liquidation" is exact. */
  readonly raw: string | null;
  readonly reason: string | null;
  readonly matched: boolean | null;
  readonly matchedNote: string;
  /** True when the figure came from the BFF's live read, not from the agent. */
  readonly live: boolean;
};

export type LendingBasesCells = {
  readonly liquidation: LendingBasisCell;
  readonly borrowingPower: LendingBasisCell;
};

const NO_MATCH_SOURCE = "no source for the match flag";

/**
 * Both bases as the page renders them.
 *
 * A FRESH snapshot carries only the liquidation basis — the worker writes the
 * one number the trigger compares — so the borrowing-power cell dashes with
 * that as its reason rather than borrowing a stale figure. The STALE fallback
 * (`liveAccount`) carries both, each with its own `matched` flag, and both are
 * labelled live.
 */
export function lendingBases(view: LendingAgentView): LendingBasesCells {
  const payload = view.snapshot.payload;
  if (!view.snapshot.stale && payload !== null) {
    const hf = payload.observation?.healthFactor ?? null;
    const mismatch = payload.conditions.some((entry) => entry.condition === "protocol-mismatch");
    return {
      liquidation: {
        hf: hf === null ? null : formatHf(hf),
        raw: hf,
        reason: hf === null ? "the guard has observed no health factor for this account yet" : null,
        matched: mismatch ? false : true,
        matchedNote: mismatch
          ? "does NOT match Venus's own account-liquidity call"
          : "no protocol mismatch recorded by the agent",
        live: false,
      },
      borrowingPower: {
        hf: null,
        raw: null,
        reason: "the agent's snapshot carries only the liquidation basis, which is the one the trigger acts on",
        matched: null,
        matchedNote: NO_MATCH_SOURCE,
        live: false,
      },
    };
  }
  const live = view.liveAccount;
  if (live !== undefined) {
    const cell = (basis: { readonly hf: string | null; readonly matched: boolean }): LendingBasisCell => ({
      hf: basis.hf === null ? null : formatHf(basis.hf),
      raw: basis.hf,
      reason: basis.hf === null ? "this account carries no debt on Venus" : null,
      matched: basis.matched,
      matchedNote: basis.matched
        ? "matches Venus's own account-liquidity call"
        : "does NOT match Venus's own account-liquidity call",
      live: true,
    });
    return {
      liquidation: cell(live.bases.liquidation),
      borrowingPower: cell(live.bases.borrowingPower),
    };
  }
  const reason = view.liveAccountReason ?? view.snapshot.reason ?? "the agent has not reported yet";
  const dashed: LendingBasisCell = { hf: null, raw: null, reason, matched: null, matchedNote: NO_MATCH_SOURCE, live: false };
  return { liquidation: dashed, borrowingPower: dashed };
}

/* -------------------------------------------------------------------------- */
/* effect and partial are DIFFERENT THINGS (mock-up port, fix 1)              */
/* -------------------------------------------------------------------------- */

/**
 * What the row's dot means. It is coloured from `effect` ALONE.
 *
 * The mock-up collapsed `partial | armed | else` into one tone, which made a
 * `changed` repay that was also `partial` read as though the debt had not
 * moved. The DTO carries two independent facts and this page shows two.
 */
export function lendingEffectTone(effect: "changed" | "no-effect" | "unverified"): "profit" | "warn" | "subtle" {
  return effect === "changed" ? "profit" : effect === "no-effect" ? "warn" : "subtle";
}

export function lendingEffectColor(effect: "changed" | "no-effect" | "unverified"): string {
  const tone = lendingEffectTone(effect);
  return tone === "profit" ? "var(--profit)" : tone === "warn" ? "var(--warn)" : "var(--text-subtle)";
}

/** The sentence for each `effect`, in the owner's words rather than the enum's. */
export function lendingEffectCopy(effect: "changed" | "no-effect" | "unverified"): string {
  switch (effect) {
    case "changed":
      return "The debt moved: the read taken after the receipt shows less owed than before.";
    case "no-effect":
      return "The receipt confirmed and the debt did not move.";
    default:
      return "The read taken after the receipt failed, so the effect is unverified.";
  }
}

/** `partial` is its own fact, and it can sit on a `changed` row. */
export const LENDING_PARTIAL_COPY =
  "Partial: the reserve could not fund the whole sized repay, so a smaller amount was submitted. It was never refused.";

/* -------------------------------------------------------------------------- */
/* Debt repaid to date                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The total this guard has actually taken off the debt.
 *
 * Only `effect === "changed"` rows are summed: a `no-effect` row confirmed and
 * moved nothing, and an `unverified` row's outcome was never read back. Both
 * are COUNTED in the note rather than being silently folded into a total that
 * would overstate what the owner got.
 */
export function lendingRepaidMetric(input: {
  readonly rescues: readonly LendingRescueView[];
  readonly config: LendingConfigView | null;
  readonly usdtDecimals: number;
}): DetailMetric {
  if (input.rescues.length === 0) {
    return unavailable("no repay is recorded for this guard yet");
  }
  if (input.config === null) {
    return unavailable("the lending venue could not be read, so a repay's market cannot be named");
  }
  const vBnb = input.config.vBnb.toLowerCase();
  let usdtWei = 0n;
  let nativeWei = 0n;
  let changed = 0;
  let noEffect = 0;
  let unverified = 0;
  for (const rescue of input.rescues) {
    if (rescue.effect === "no-effect") { noEffect += 1; continue; }
    if (rescue.effect === "unverified") { unverified += 1; continue; }
    changed += 1;
    let amount: bigint;
    try { amount = BigInt(rescue.amountWei); } catch { continue; }
    if (rescue.market.toLowerCase() === vBnb) nativeWei += amount; else usdtWei += amount;
  }
  const excluded = `${noEffect} confirmed with no debt movement · ${unverified} unverified`;
  if (changed === 0) {
    return unavailable(`no recorded repay moved the debt — ${excluded}`);
  }
  const parts: string[] = [];
  if (usdtWei > 0n) parts.push(`${formatAtomicAmount(usdtWei.toString(10), input.usdtDecimals, 2)} USDT`);
  if (nativeWei > 0n) parts.push(`${formatAtomicAmount(nativeWei.toString(10), 18, 6)} BNB`);
  return {
    value: parts.length === 0 ? "0" : parts.join(" + "),
    reason: null,
    note: `over ${changed} repay${changed === 1 ? "" : "s"} that moved debt · ${excluded}`,
  };
}

/* -------------------------------------------------------------------------- */
/* The run-log timeline — durable rows only (mock-up port, fix 5)             */
/* -------------------------------------------------------------------------- */

/**
 * One line of the run log.
 *
 * `atMs === null` is not a hole to be filled with a plausible time: it renders
 * as a dash carrying {@link LendingTimelineEvent.timeReason}. The mock-up's
 * "Triggered by a N% drop in BNB", "Checked your Venus position" and
 * "N USDT of collateral placed under watch" lines are ABSENT on purpose — the
 * plane stores no cause, no price history, no per-cycle check history and no
 * collateral-at-hire figure, so none of them has a row to come from.
 */
export type LendingTimelineEvent = {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly atMs: number | null;
  readonly timeReason: string | null;
  readonly tone: "default" | "profit" | "warn" | "loss";
  readonly txHash: string | null;
};

export function lendingTimeline(input: {
  readonly view: LendingAgentView;
  readonly config: LendingConfigView | null;
  readonly usdtDecimals: number;
}): readonly LendingTimelineEvent[] {
  const { view, config } = input;
  const guard = view.guard;
  const events: LendingTimelineEvent[] = [];

  // 1. The live line: the last read, and what it observed. ONE row — the
  //    observation table keeps a single row per agent and overwrites it, so
  //    there is no history here to list and no series to chart.
  const observation = view.snapshot.payload?.observation ?? null;
  events.push({
    key: "last-read",
    title: view.snapshot.stale ? "Last report from the agent" : "Watching your Venus position",
    detail: observation === null
      ? view.snapshot.reason ?? "the agent has recorded no observation for this account yet"
      : `health factor ${formatHf(observation.healthFactor)} · ${observation.breach
        ? `below your trigger, ${observation.consecutive} consecutive confirmation${observation.consecutive === 1 ? "" : "s"}`
        : "above your trigger"} · one row, overwritten every cycle`,
    atMs: view.snapshot.presentAt,
    timeReason: view.snapshot.presentAt === null ? "the plane records no time for the last snapshot" : null,
    tone: view.snapshot.stale ? "warn" : observation?.breach === true ? "warn" : "default",
    txHash: null,
  });

  // 2. The retire, when the guard row says one happened.
  if (guard.status === "retiring" || guard.status === "retired" || guard.status === "closed") {
    events.push({
      key: "retire",
      title: guard.status === "retiring"
        ? "Retire in progress"
        : guard.closeReason === "recovered-by-owner" ? "Recovered with your passkey" : "Reserve retired",
      detail: `${guard.closeReason ?? "no close reason recorded"} · timed by the guard row's last update, the only time recorded for it`,
      atMs: guard.updatedAtMs,
      timeReason: null,
      tone: guard.status === "retiring" ? "warn" : "default",
      txHash: null,
    });
  }

  // 3. Every repay, newest first. These are durable rescue rows.
  const vBnb = config?.vBnb.toLowerCase() ?? null;
  for (const rescue of [...view.rescues].sort((a, b) => b.createdAtMs - a.createdAtMs)) {
    const native = vBnb !== null && rescue.market.toLowerCase() === vBnb;
    const amount = config === null
      ? `${rescue.amountWei} wei`
      : native
        ? `${formatAtomicAmount(rescue.amountWei, 18, 6)} BNB`
        : `${formatAtomicAmount(rescue.amountWei, input.usdtDecimals, 2)} USDT`;
    events.push({
      key: `rescue:${rescue.rescueId}`,
      title: `Repaid ${amount}`,
      detail: `HF ${formatHf(rescue.hfBefore)} → ${formatHf(rescue.hfAfter)} · ${lendingEffectCopy(rescue.effect)}${rescue.partial ? ` ${LENDING_PARTIAL_COPY}` : ""}`,
      atMs: rescue.createdAtMs,
      timeReason: null,
      tone: rescue.effect === "changed" ? "profit" : rescue.effect === "no-effect" ? "warn" : "default",
      txHash: rescue.txHash,
    });
  }

  // 4. The arm. The guard row records its BLOCK, not its time — and which
  //    block it is decides what the number proves.
  if (guard.armTxHash !== null || guard.armBlock !== null) {
    events.push({
      key: "arm",
      title: "Reserve armed on Venus",
      detail: guard.armBlock === null
        ? "no block is recorded for the arm"
        : guard.armBlockSource === "receipt"
          ? `block ${guard.armBlock} — the block the arm's transaction landed in`
          : guard.armBlockSource === "post-arm-read"
            ? `block ${guard.armBlock} — a read taken after the arm, which proves it was observed and nothing about when`
            : `block ${guard.armBlock} — the plane did not say which block this is`,
      atMs: null,
      timeReason: "the guard row records the arm's block, not its time",
      tone: "default",
      txHash: guard.armTxHash,
    });
  }

  // 5. The hire. It happened — the guard row exists — but no timestamp for it
  //    reaches this page, so the time dashes rather than being invented.
  events.push({
    key: "hire",
    title: "Hired",
    detail: `guarding ${shortAddress(guard.guardedAccount)} on ${guard.debtMarkets.length} pinned market${guard.debtMarkets.length === 1 ? "" : "s"}`,
    atMs: null,
    timeReason: "the hire's time is not carried by the guard view",
    tone: "default",
    txHash: null,
  });

  return events;
}
