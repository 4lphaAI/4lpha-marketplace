/**
 * The lending hire form's arithmetic and its verbatim copy.
 *
 * Pure, testable, and deliberately separate from the component: every figure the
 * owner signs is derived here, so the numbers on the screen and the numbers in
 * the envelope come out of ONE function rather than two renders.
 *
 * The copy constants are the spec's, VERBATIM (R2.2, R2.13, R2.20, R3.13,
 * §6.2). They are not paraphrased in the component.
 */
import { formatUnits, parseUnits } from "viem";

import {
  LENDING_RESCUE_RESERVE_COUNT_MAX,
  LENDING_RESCUE_RESERVE_COUNT_MIN,
  LENDING_RESERVE_BPS_MAX,
  LENDING_RESERVE_BPS_MIN,
  LENDING_MIN_SECONDS_BETWEEN_ACTIONS,
  LENDING_TARGET_HF_BAND,
  LENDING_TRIGGER_HF_MAX,
  LENDING_TRIGGER_HF_MIN,
  type LendingGuardableView,
} from "@/lib/exec/lending-types";

/* -------------------------------------------------------------------------- */
/* Copy — verbatim from the spec                                              */
/* -------------------------------------------------------------------------- */

/** R2.20(d). The whole safeguard against a mistyped address is the owner's eye. */
export const LENDING_GIFT_COPY =
  "Repayments to this address are final: they cannot be undone.";

/** R2.20(b). Deploy stays disabled until this is ticked. */
export const LENDING_IRREVERSIBLE_TICK =
  "I understand repayments to this address cannot be reversed";

/**
 * §9 copy, as replaced by R2.2 — the honest custody sentence, VERBATIM (W7).
 *
 * The first pass paraphrased it: it dropped the "by approving any spender on
 * USDT, or by naming any recipient on the granted router" clause — which is the
 * only part that says HOW a leaked key moves the reserve, and without it the
 * sentence reads as a theoretical bound rather than a described mechanism — and
 * it dropped the closing sentence naming the hard stops. Both are restored.
 *
 * Only the paragraph's two SOURCE CITATIONS are absent (`src/ops/policy.ts:
 * 2103-2110` and `FINDINGS (at)`): they are file and finding references for a
 * reader of the spec, not owner-facing copy, and the sentences they annotate are
 * carried in full.
 */
export const LENDING_CUSTODY_COPY =
  "Wallet B's reserve is protected by three things and no fourth: the on-chain "
  + "per-token and native caps, the call allowlist, and the 7-day expiry. A leaked "
  + "session key can move the reserve OUT of wallet B to an address of its choosing "
  + "— by approving any spender on USDT, or by naming any recipient on the granted "
  + "router — bounded per rolling day by the USDT cap (reserveCapWei) and the native "
  + "cap (capDayWei), and over the session's life by seven times each. That is the "
  + "same posture venusSessionSpec states and the same posture every LP and Grid "
  + "session on this platform already carries. What the template does remove is the "
  + "ability to borrow, to enter or exit markets, to touch the wallet's own admin "
  + "surface or the KeyStore, and to mint an unredeemable native position. The hard "
  + "stops remain the caps, the expiry, and an owner-signed revoke.";

/** R2.14's working-range sentence, carried on the hire screen and the detail page. */
export const LENDING_WORKING_RANGE_COPY =
  "The guard's working range is 1.0 < HF < trigger; an account already liquidatable races bots and usually loses.";

/** R2.13's disarm language, for a market-shaped refusal. */
export const LENDING_UNPRICEABLE_MARKET_COPY =
  "Your account entered a market this guard cannot price; the guard is paused until it can.";

/** R3.13's second sentence. The gate itself is `walletSharedWithLiveAgents`. */
export const LENDING_OWN_ACCOUNT_COPY =
  "The guard needs its own account (a new passkey), not just its own wallet. Switching accounts does not pause your other agent.";

/** §6.2, beside the session countdown. */
export const LENDING_NO_LOCK_IN_COPY =
  "Your reserve is recoverable with your passkey at any time; the agent's key cannot block it.";

/** R2.17's hint on "Rescues to reserve gas for". */
export const LENDING_RESCUE_COUNT_HINT =
  "The guard will still rescue beyond this — refusing a rescue is the trap it exists to avoid.";

/** §2.1's fixed text for the removed "Repay from" picker. There is no choice. */
export const LENDING_REPAY_SOURCE_TEXT =
  "Reserve: USDT supplied on Venus + BNB tier";

/**
 * "Check every" — the mock's 30 s field, honestly.
 *
 * `lending.workerIntervalMs` is boot config and `GET /lending/config` does not
 * expose it, so at hire time there is NO source for a number here. A dash with
 * its reason, never a figure nobody read.
 */
export const LENDING_CHECK_EVERY_TEXT =
  "— the operator's configured cadence; the agent page shows it once the guard reports";

/**
 * "Check every", with the real figure WHEN THE PLANE PUBLISHES ONE.
 *
 * `GET /lending/config` gained an OPTIONAL `workerIntervalMs`. When it is there
 * the form stops dashing and says what the operator configured; when it is not
 * — an older plane, or one that never adds it — the dash and its reason are
 * unchanged, because the alternative is a number nobody read.
 *
 * The figure is the CONFIGURED CADENCE, not evidence the worker is running:
 * the sentence says "configured" for the same reason the LP detail page refuses
 * to light a live badge off `lp.workerIntervalMs`.
 */
export function lendingCheckEveryText(workerIntervalMs: number | null | undefined): string {
  if (typeof workerIntervalMs !== "number" || !Number.isFinite(workerIntervalMs) || workerIntervalMs <= 0) {
    return LENDING_CHECK_EVERY_TEXT;
  }
  const seconds = workerIntervalMs / 1_000;
  const rendered = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
  return `${rendered} s — the operator's configured cadence`;
}

/* -------------------------------------------------------------------------- */
/* Units                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * USDT's decimals on BNB Chain.
 *
 * BSC-USDT (`0x55d3…7955`) is an 18-decimal BEP-20, NOT the 6-decimal Ethereum
 * USDT. Used only as a fallback: the guardable read reports
 * `underlyingDecimals` per market and that is preferred, because the plane
 * derives it from the chain.
 */
export const LENDING_USDT_DECIMALS_FALLBACK = 18;

/** The vUSDT market's own `underlyingDecimals`, when the read named it. */
export function usdtDecimalsFrom(
  guardable: LendingGuardableView | null,
  vUsdt: string | null,
): number {
  if (guardable === null || vUsdt === null) return LENDING_USDT_DECIMALS_FALLBACK;
  const market = guardable.markets.find(
    (entry) => entry.vToken.toLowerCase() === vUsdt.toLowerCase(),
  );
  return market === undefined ? LENDING_USDT_DECIMALS_FALLBACK : market.underlyingDecimals;
}

/**
 * A numeric control's typed value, WITHOUT a clamp (AUDIT G-L3 / W6).
 *
 * `DeployAgentScreen` used to hand the hire component
 * `Math.max(300, Math.round(Number(values.cooldown) || 300))`, so a typed 100
 * became a SIGNED 300 with nothing on screen saying so — the owner reads 100,
 * the envelope carries 300. The typed value now passes straight through, and
 * `buildLendingForm`'s existing bound refusals disable Deploy and name the
 * legal range instead. A BLANK field still falls back to the control's default:
 * that is a default, not a clamp of something the owner typed.
 */
export function lendingControlNumber(raw: unknown, fallback: number): number {
  const text = String(raw ?? "").replace(/,/gu, "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

/** A dollar figure typed into "Max repay per event", as a positive number. */
export function parseUsd(raw: string): number | null {
  const trimmed = String(raw ?? "").replace(/[,$\s]/gu, "").trim();
  if (trimmed === "" || !/^\d{1,12}(\.\d{1,6})?$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** USDT is priced 1:1 with the dollar for this control (§2.1). */
export function usdToUsdtWei(usd: number, decimals: number): bigint | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  try {
    const wei = parseUnits(usd.toFixed(Math.min(6, decimals)), decimals);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

/**
 * Dollars to native wei through the FRESH WBNB price.
 *
 * `null` when the price is not fresh: the form then refuses to sign a BNB
 * ceiling rather than converting through a stale number the owner would be
 * bound to for seven days.
 */
export function usdToNativeWei(usd: number, priceMicros: bigint | null): bigint | null {
  if (priceMicros === null || priceMicros <= 0n) return null;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const microUsd = BigInt(Math.round(usd * 1_000_000));
  if (microUsd <= 0n) return null;
  const wei = (microUsd * 10n ** 18n) / priceMicros;
  return wei > 0n ? wei : null;
}

/** A 1e18 health-factor mantissa from a typed decimal like "1.20". */
export function hfToMantissa(raw: string | number): bigint | null {
  const trimmed = String(raw ?? "").replace(/,/gu, "").trim();
  if (trimmed === "" || !/^\d{1,3}(\.\d{1,18})?$/u.test(trimmed)) return null;
  try {
    return parseUnits(trimmed, 18);
  } catch {
    return null;
  }
}

/** A 1e18 mantissa rendered for the eye, e.g. "1.20". */
export function formatHf(mantissa: string | bigint | null, places = 2): string {
  if (mantissa === null) return "—";
  try {
    const value = typeof mantissa === "bigint" ? mantissa : BigInt(mantissa);
    return Number(formatUnits(value, 18)).toFixed(places);
  } catch {
    return "—";
  }
}

/** An atomic amount rendered with at most `places` decimals; no exponent. */
export function formatAtomicAmount(wei: string | bigint, decimals: number, places = 4): string {
  try {
    const value = typeof wei === "bigint" ? wei : BigInt(wei);
    const text = formatUnits(value, decimals);
    const [whole, fraction = ""] = text.split(".");
    const trimmed = fraction.slice(0, places).replace(/0+$/u, "");
    return trimmed === "" ? String(whole) : `${whole}.${trimmed}`;
  } catch {
    return "—";
  }
}

/* -------------------------------------------------------------------------- */
/* The derived figures the form shows back                                    */
/* -------------------------------------------------------------------------- */

/**
 * R2.3: the mock's "Daily repay limit" is NOT `reserveCapWei`.
 *
 * It is the DERIVED product `rescueReserveCount × maxPerAction[USDT]`, and it is
 * read-only. The on-chain USDT cap is a separate, larger figure and is shown by
 * {@link lendingExposureLine}.
 */
export function derivedDailyRepayLimitWei(
  rescueReserveCount: number,
  maxPerActionUsdtWei: bigint | null,
): bigint | null {
  if (maxPerActionUsdtWei === null || maxPerActionUsdtWei <= 0n) return null;
  if (!Number.isInteger(rescueReserveCount) || rescueReserveCount <= 0) return null;
  return BigInt(rescueReserveCount) * maxPerActionUsdtWei;
}

/**
 * R2.3's exposure line, shown BEFORE the passkey prompt.
 *
 * It prints the on-chain caps — what the session key could move, not what the
 * agent intends to move — times the seven days of TTL, and says plainly that
 * the drain is additionally bounded by what wallet B holds (R3.1's closing
 * sentence). FINDINGS (r): print the PRODUCT, never the per-day rate alone.
 */
export function lendingExposureLine(input: {
  readonly reserveCapWei: bigint | null;
  readonly capDayWei: bigint | null;
  readonly usdtDecimals: number;
}): string {
  const usdt = input.reserveCapWei === null
    ? "an unquoted amount of" : `${formatAtomicAmount(input.reserveCapWei, input.usdtDecimals, 2)}`;
  const bnb = input.capDayWei === null
    ? "an unquoted amount of" : `${formatAtomicAmount(input.capDayWei, 18, 6)}`;
  return `Most this agent's key could move per day: ${usdt} USDT + ${bnb} BNB (× 7 days = the session's total exposure). It is additionally bounded by what the agent wallet actually holds.`;
}

/* -------------------------------------------------------------------------- */
/* The signed settings object                                                 */
/* -------------------------------------------------------------------------- */

export type LendingSettingsParams = {
  readonly triggerHf: string;
  readonly targetHf: string;
  readonly maxPerAction: readonly { readonly token: string | null; readonly maxWei: string }[];
  readonly minSecondsBetweenActions: number;
  readonly rescueReserveCount: number;
};

export type LendingFormInput = {
  readonly triggerHf: string;
  readonly targetHf: string;
  readonly maxRepayUsd: string;
  readonly rescueReserveCount: number;
  readonly cooldownSeconds: number;
  readonly reserveBps: number;
  /** The PINNED debt markets, in the order the hire will sign them. */
  readonly debtMarkets: readonly string[];
  readonly vUsdt: string;
  readonly vBnb: string;
  readonly usdt: string;
  readonly usdtDecimals: number;
  /** Fresh WBNB price in USD micros; `null` when the snapshot is not fresh. */
  readonly wbnbPriceMicros: bigint | null;
  /**
   * The BNB ceiling THIS GUARD ALREADY SIGNED, for the Edit panel.
   *
   * Editing a vBNB-pinned guard must not silently re-price its BNB ceiling
   * through whatever the price happens to be at that moment — the owner is
   * editing the health thresholds, not the ceiling. When present it is reused
   * verbatim and the price is not consulted at all.
   */
  readonly existingNativeMaxWei?: bigint | undefined;
};

export type LendingFormResult =
  | { readonly ok: true; readonly settings: LendingSettingsParams; readonly usdtCeilingWei: bigint }
  | { readonly ok: false; readonly message: string };

/**
 * Build (and bound-check) the exact settings object the owner will sign.
 *
 * Every bound is the plane's, restated so the refusal arrives BEFORE the passkey
 * ceremony rather than as a 400 after it. `maxPerAction` names one ceiling per
 * PINNED market and nothing else — the plane's `enforceLendingV1Profile` refuses
 * anything else, and a refusal after the grant leaves the wallet occupied.
 */
export function buildLendingForm(input: LendingFormInput): LendingFormResult {
  const trigger = hfToMantissa(input.triggerHf);
  const target = hfToMantissa(input.targetHf);
  if (trigger === null) return { ok: false, message: "Act below health factor must be a decimal like 1.20." };
  if (target === null) return { ok: false, message: "Restore health factor to must be a decimal like 1.50." };
  if (trigger < LENDING_TRIGGER_HF_MIN || trigger > LENDING_TRIGGER_HF_MAX) {
    return {
      ok: false,
      message: "Act below health factor must be between 1.05 and 3.00. A guard that fires at or below 1.0 fires only once the account is already liquidatable, which is the one race this plane will usually lose.",
    };
  }
  if (target < trigger + LENDING_TARGET_HF_BAND) {
    return {
      ok: false,
      message: "Restore health factor to must be at least 0.05 above the trigger; a target inside the band sizes a rescue that does not clear the trigger, so the next cycle fires again.",
    };
  }
  if (!Number.isInteger(input.rescueReserveCount)
    || input.rescueReserveCount < LENDING_RESCUE_RESERVE_COUNT_MIN
    || input.rescueReserveCount > LENDING_RESCUE_RESERVE_COUNT_MAX) {
    return { ok: false, message: `Rescues to reserve gas for must be a whole number from ${LENDING_RESCUE_RESERVE_COUNT_MIN} to ${LENDING_RESCUE_RESERVE_COUNT_MAX}.` };
  }
  if (!Number.isInteger(input.cooldownSeconds)
    || input.cooldownSeconds < LENDING_MIN_SECONDS_BETWEEN_ACTIONS
    || input.cooldownSeconds > 86_400) {
    return { ok: false, message: `Cooldown between repays must be a whole number of seconds from ${LENDING_MIN_SECONDS_BETWEEN_ACTIONS} to 86400.` };
  }
  if (!Number.isInteger(input.reserveBps)
    || input.reserveBps < LENDING_RESERVE_BPS_MIN || input.reserveBps > LENDING_RESERVE_BPS_MAX) {
    return { ok: false, message: "Reserve kept as BNB must be between 10% and 50%." };
  }
  if (input.debtMarkets.length === 0) {
    return { ok: false, message: "This account carries no debt this guard can repay." };
  }
  const usd = parseUsd(input.maxRepayUsd);
  if (usd === null) return { ok: false, message: "Max repay per event must be a dollar amount greater than zero." };

  const caps: { token: string | null; maxWei: string }[] = [];
  let usdtCeilingWei = 0n;
  for (const market of input.debtMarkets) {
    if (market.toLowerCase() === input.vUsdt.toLowerCase()) {
      const wei = usdToUsdtWei(usd, input.usdtDecimals);
      if (wei === null) return { ok: false, message: "Max repay per event could not be converted to USDT." };
      usdtCeilingWei = wei;
      caps.push({ token: input.usdt, maxWei: wei.toString(10) });
    } else if (market.toLowerCase() === input.vBnb.toLowerCase()) {
      const wei = input.existingNativeMaxWei !== undefined && input.existingNativeMaxWei > 0n
        ? input.existingNativeMaxWei
        : usdToNativeWei(usd, input.wbnbPriceMicros);
      if (wei === null) {
        return {
          ok: false,
          message: "The BNB price is not fresh, so Max repay per event cannot be converted to a BNB ceiling. This guard would be signed for seven days against a stale price; wait for the price to refresh.",
        };
      }
      caps.push({ token: null, maxWei: wei.toString(10) });
    } else {
      return { ok: false, message: `${market} is not a v1 debt market (vUSDT or vBNB).` };
    }
  }
  return {
    ok: true,
    usdtCeilingWei,
    settings: {
      triggerHf: trigger.toString(10),
      targetHf: target.toString(10),
      maxPerAction: caps,
      minSecondsBetweenActions: input.cooldownSeconds,
      rescueReserveCount: input.rescueReserveCount,
    },
  };
}

/**
 * The debt markets a hire may pin: SUPPORTED, and carrying a real borrow.
 *
 * S1 refuses `debtMarkets` naming a market with no debt in the preview
 * ("a guard pinned to a market with nothing to repay grants authority it cannot
 * use"), so the browser must not offer one.
 */
export function pinnableDebtMarkets(guardable: LendingGuardableView | null): readonly string[] {
  if (guardable === null) return [];
  return guardable.debts
    .filter((debt) => debt.supported && weiPositive(debt.borrowWei))
    .map((debt) => debt.vToken);
}

function weiPositive(value: string): boolean {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

/** The markets v1 cannot repay, for the `unsupported-debt` disclosure. */
export function unsupportedDebtSymbols(guardable: LendingGuardableView | null): readonly string[] {
  if (guardable === null) return [];
  return guardable.debts.filter((debt) => !debt.supported).map((debt) => debt.symbol);
}
