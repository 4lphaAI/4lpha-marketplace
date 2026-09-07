/**
 * The lending guard's wire layer — parse, validate, the defaults, the digest,
 * and every DTO the marketplace UI reads
 * (MARKETPLACE-LENDING-AGENT §4.2 as amended by R2.17, §4.3 as amended by
 * R3.3(4), §8.3 as amended by R2.18, R3.9's config/quote reads).
 *
 * WHAT IS STORED IS THE SIGNED WIRE PARAMS, VERBATIM, plus their digest — the
 * `lpSettings` / `venusSettings` discipline, for the same reason: the
 * observation row carries `paramsHash("lendingSettings", params)` and a digest
 * mismatch invalidates the confirmation counter, so the bytes that were signed
 * and the bytes that are compared must be the same bytes. Interpretation
 * happens at READ time, from those bytes.
 *
 * ─── THE DTOs ARE THE WEB CONTRACT ─────────────────────────────────────────
 *
 * `web/` never imports from `../src/`; it hand-writes DTOs in
 * `web/lib/exec-client.ts` against what this module emits. Every exported
 * `*View` type below is therefore documented as a wire contract rather than as
 * an internal shape, and every bigint crosses as a DECIMAL STRING — the LP
 * detail page's rule, adopted here so a JSON round trip cannot silently
 * truncate a reserve.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { paramsHash } from "../auth/canonical.js";
import {
  LENDING_MAX_MARKETS,
  LENDING_RESERVE_BPS_DEFAULT,
  LENDING_RESERVE_BPS_MAX,
  LENDING_RESERVE_BPS_MIN,
} from "../ops/policy.js";
import type {
  LendingCloseReason,
  LendingConditionReport,
  LendingGuardStatus,
  LendingHold,
} from "../lending/types.js";

/* -------------------------------------------------------------------------- */
/* The interpreted settings                                                   */
/* -------------------------------------------------------------------------- */

/** One owner-set per-action ceiling. `token: null` means NATIVE BNB (vBNB). */
export type LendingPerActionCap = {
  readonly token: Address | null;
  readonly maxWei: bigint;
};

export type LendingSettings = {
  /** 1e18 mantissa. The guard acts below this, on the LIQUIDATION basis. */
  readonly triggerHf: bigint;
  /** 1e18 mantissa. What a rescue aims to restore. `>= triggerHf + 0.05e18`. */
  readonly targetHf: bigint;
  /**
   * Per-token ceilings on ONE submission. One entry per PINNED debt market,
   * all required — enforced against the pinned set by
   * {@link enforceLendingV1Profile}, which is the only place that set is known.
   */
  readonly maxPerAction: readonly LendingPerActionCap[];
  /** Anti-flap floor between two rescues. Seconds. Floor AND default 300. */
  readonly minSecondsBetweenActions: number;
  /**
   * "Rescues to reserve gas for" (R2.17, replacing the mock's "Max actions per
   * day"). It SIZES the gas reserve; it never refuses a rescue. The hint the
   * UI must render says so: "the guard will still rescue beyond this —
   * refusing a rescue is the trap it exists to avoid."
   */
  readonly rescueReserveCount: number;
  /** Optional second, HIGHER threshold: flag "approaching", never act. */
  readonly notifyOnlyBelowHf?: bigint;
};

export const E18 = 10n ** 18n;

/**
 * Defaults, as NUMBERS (§0.6, R2.17).
 *
 * `triggerHf` 1.20 / `targetHf` 1.50 are the operator's ruling of 2026-09-06,
 * closing OQ2. Phase 4 shipped 1.30 / 1.60 and the mock showed 1.18 / 1.60;
 * the band argument (it must exceed one worker interval of plausible price
 * movement) is stated on the owner view rather than re-decided here.
 *
 * `minSecondsBetweenActions` keeps Phase 4's deliberate 300 as BOTH the floor
 * and the default, and the mock's 120 is NOT adopted (R2.17/C18). The
 * arithmetic: at 60 s a guard can fire every ~90 s, ~40 rescues an hour, each
 * drawing a relay fee out of a tier R2.8 shows is thin and a USDT cap R3.1
 * shows is scarce.
 */
export const DEFAULT_LENDING_SETTINGS: LendingSettings = {
  triggerHf: 1_200_000_000_000_000_000n,
  targetHf: 1_500_000_000_000_000_000n,
  maxPerAction: [],
  minSecondsBetweenActions: 300,
  rescueReserveCount: 6,
};

/** The floor AND the default. One constant so the two cannot drift (R2.17). */
export const LENDING_MIN_SECONDS_BETWEEN_ACTIONS = 300;

/** `triggerHf` bounds, 1e18 mantissa (§4.2). */
export const LENDING_TRIGGER_HF_MIN = 1_050_000_000_000_000_000n;
export const LENDING_TRIGGER_HF_MAX = 3_000_000_000_000_000_000n;

/** The band `targetHf` must clear above `triggerHf` (§4.2). */
export const LENDING_TARGET_HF_BAND = 50_000_000_000_000_000n;

/** `rescueReserveCount` bounds (R2.17). */
export const LENDING_RESCUE_RESERVE_COUNT_MIN = 1;
export const LENDING_RESCUE_RESERVE_COUNT_MAX = 24;

/* -------------------------------------------------------------------------- */
/* Parsing primitives                                                         */
/* -------------------------------------------------------------------------- */

export type LendingParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function fail<T>(message: string): LendingParseResult<T> {
  return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 1e18 mantissa on the wire: a bare decimal integer string. */
function readMantissa(value: unknown, field: string): LendingParseResult<bigint> {
  if (typeof value !== "string" || !/^\d{1,40}$/u.test(value)) {
    return fail(`${field} must be a decimal integer string (1e18 mantissa).`);
  }
  return { ok: true, value: BigInt(value) };
}

function readWei(value: unknown, field: string): LendingParseResult<bigint> {
  if (typeof value !== "string" || !/^\d{1,40}$/u.test(value)) {
    return fail(`${field} must be a decimal integer string of wei.`);
  }
  return { ok: true, value: BigInt(value) };
}

function readInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): LendingParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(`${field} must be an integer.`);
  }
  if (value < min || value > max) {
    return fail(`${field} must be between ${min} and ${max}.`);
  }
  return { ok: true, value };
}

function readAddressField(value: unknown, field: string): LendingParseResult<Address> {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    return fail(`${field} must be a 20-byte hex address.`);
  }
  return { ok: true, value: getAddress(value) };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "triggerHf",
  "targetHf",
  "maxPerAction",
  "minSecondsBetweenActions",
  "rescueReserveCount",
  "notifyOnlyBelowHf",
]);

function readPerActionCaps(
  value: unknown,
): LendingParseResult<readonly LendingPerActionCap[]> {
  if (!Array.isArray(value)) return fail("maxPerAction must be an array.");
  if (value.length === 0) {
    return fail(
      "maxPerAction must name one ceiling per pinned debt market; an empty list is a guard with no amount it may pay.",
    );
  }
  if (value.length > 8) return fail("maxPerAction may hold at most 8 entries.");
  const seen = new Set<string>();
  const out: LendingPerActionCap[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return fail("maxPerAction entries must be objects.");
    const unknownKey = Object.keys(entry).find(
      (key) => key !== "token" && key !== "maxWei",
    );
    if (unknownKey !== undefined) {
      return fail(`maxPerAction entry has unknown key "${unknownKey}".`);
    }
    const rawToken = entry["token"];
    let token: Address | null;
    if (rawToken === null) {
      token = null;
    } else if (typeof rawToken === "string" && isAddress(rawToken, { strict: false })) {
      token = getAddress(rawToken);
    } else {
      return fail("maxPerAction entry `token` must be an address or null (native).");
    }
    const key = token === null ? "native" : token.toLowerCase();
    if (seen.has(key)) return fail(`maxPerAction names ${key} twice.`);
    seen.add(key);
    const max = readWei(entry["maxWei"], "maxPerAction.maxWei");
    if (!max.ok) return fail(max.message);
    if (max.value <= 0n) return fail("maxPerAction.maxWei must be positive.");
    out.push({ token, maxWei: max.value });
  }
  return { ok: true, value: out };
}

/**
 * Parse and VALIDATE the owner's lending settings.
 *
 * The threshold ordering is enforced here with typed messages: `targetHf >=
 * triggerHf + 0.05e18 > 1.05e18`. A `triggerHf` at or below 1.0 is a guard
 * that fires only once the account is already liquidatable, which is the one
 * state the plane will usually lose the race in; a `targetHf` inside the band
 * sizes a rescue that barely clears the trigger, so the next cycle fires again
 * — a cap-draining loop wearing a threshold's name.
 *
 * `debtMarkets` and `reserveBps` are deliberately NOT settings (§4.2): the
 * first is pinned at S1 because the session grants exactly those markets, and
 * the second is applied once at the arm.
 */
export function parseLendingSettingsParams(
  params: unknown,
): LendingParseResult<LendingSettings> {
  if (!isRecord(params)) return fail("Settings params must be a JSON object.");
  const unknownKey = Object.keys(params).find((key) => !SETTINGS_KEYS.has(key));
  if (unknownKey !== undefined) {
    return fail(`Settings params has unknown key "${unknownKey}".`);
  }

  const out: { -readonly [K in keyof LendingSettings]: LendingSettings[K] } = {
    ...DEFAULT_LENDING_SETTINGS,
  };

  if (params["triggerHf"] !== undefined) {
    const parsed = readMantissa(params["triggerHf"], "triggerHf");
    if (!parsed.ok) return fail(parsed.message);
    out.triggerHf = parsed.value;
  }
  if (params["targetHf"] !== undefined) {
    const parsed = readMantissa(params["targetHf"], "targetHf");
    if (!parsed.ok) return fail(parsed.message);
    out.targetHf = parsed.value;
  }
  if (params["notifyOnlyBelowHf"] !== undefined) {
    const parsed = readMantissa(params["notifyOnlyBelowHf"], "notifyOnlyBelowHf");
    if (!parsed.ok) return fail(parsed.message);
    out.notifyOnlyBelowHf = parsed.value;
  }
  if (params["maxPerAction"] !== undefined) {
    const parsed = readPerActionCaps(params["maxPerAction"]);
    if (!parsed.ok) return fail(parsed.message);
    out.maxPerAction = parsed.value;
  }
  if (params["minSecondsBetweenActions"] !== undefined) {
    const parsed = readInt(
      params["minSecondsBetweenActions"],
      "minSecondsBetweenActions",
      LENDING_MIN_SECONDS_BETWEEN_ACTIONS,
      86_400,
    );
    if (!parsed.ok) {
      return fail(
        `${parsed.message} The floor is ${LENDING_MIN_SECONDS_BETWEEN_ACTIONS}s: at 60s a guard can ` +
          "fire every ~90s, roughly 40 rescues an hour, each drawing a relay fee out of a thin BNB tier.",
      );
    }
    out.minSecondsBetweenActions = parsed.value;
  }
  if (params["rescueReserveCount"] !== undefined) {
    const parsed = readInt(
      params["rescueReserveCount"],
      "rescueReserveCount",
      LENDING_RESCUE_RESERVE_COUNT_MIN,
      LENDING_RESCUE_RESERVE_COUNT_MAX,
    );
    if (!parsed.ok) return fail(parsed.message);
    out.rescueReserveCount = parsed.value;
  }
  if (params["maxPerAction"] === undefined) {
    return fail(
      "maxPerAction is required: it must name one ceiling per pinned debt market.",
    );
  }

  if (out.triggerHf < LENDING_TRIGGER_HF_MIN || out.triggerHf > LENDING_TRIGGER_HF_MAX) {
    return fail(
      `triggerHf must be between ${LENDING_TRIGGER_HF_MIN} and ${LENDING_TRIGGER_HF_MAX} (1.05 .. 3.0). ` +
        "A guard that fires at or below 1.0 fires only once the account is already " +
        "liquidatable, which is the one race this plane will usually lose.",
    );
  }
  if (out.targetHf < out.triggerHf + LENDING_TARGET_HF_BAND) {
    return fail(
      `targetHf must be at least triggerHf + ${LENDING_TARGET_HF_BAND} (0.05). A target inside the ` +
        "band sizes a rescue that does not clear the trigger, so the next cycle fires " +
        "again — a cap-draining loop wearing a threshold's name.",
    );
  }
  if (out.notifyOnlyBelowHf !== undefined && out.notifyOnlyBelowHf <= out.triggerHf) {
    return fail(
      "notifyOnlyBelowHf is the APPROACHING flag and must sit ABOVE triggerHf; " +
        "below it, the guard is already acting and the flag says nothing new.",
    );
  }
  return { ok: true, value: out };
}

/** `paramsHash("lendingSettings", params)` — the ONE shared encoder. */
export function lendingSettingsDigest(params: unknown): Hex {
  return paramsHash("lendingSettings", params);
}

/** The per-action ceiling for a token, or `null` when the owner named none. */
export function lendingMaxPerActionFor(
  settings: LendingSettings,
  token: Address | null,
): bigint | null {
  const key = token === null ? null : token.toLowerCase();
  for (const cap of settings.maxPerAction) {
    const capKey = cap.token === null ? null : cap.token.toLowerCase();
    if (capKey === key) return cap.maxWei;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The owner actions                                                          */
/* -------------------------------------------------------------------------- */

export type LendingArmRequest = {
  /** The COMPLETE settings, as signed. */
  readonly settings: LendingSettings;
  /** The exact bytes the digest binds. Persisted verbatim. */
  readonly settingsParams: unknown;
  /** `<= hireSizing.openNativeBudgetWei`, `> 0`. */
  readonly budgetWei: bigint;
  /** Integer 1000..5000 — the share kept as native BNB. */
  readonly reserveBps: number;
};

const ARM_KEYS: ReadonlySet<string> = new Set([
  "settings",
  "budgetWei",
  "reserveBps",
]);

export function parseLendingArmParams(
  params: unknown,
): LendingParseResult<LendingArmRequest> {
  if (!isRecord(params)) return fail("lendingArm params must be a JSON object.");
  const unknownKey = Object.keys(params).find((key) => !ARM_KEYS.has(key));
  if (unknownKey !== undefined) {
    return fail(`lendingArm params has unknown key "${unknownKey}".`);
  }
  if (params["settings"] === undefined) return fail("lendingArm requires `settings`.");
  const settings = parseLendingSettingsParams(params["settings"]);
  if (!settings.ok) return fail(`"settings" is invalid: ${settings.message}`);
  const budget = readWei(params["budgetWei"], "budgetWei");
  if (!budget.ok) return fail(budget.message);
  if (budget.value <= 0n) return fail("budgetWei must be positive.");
  const reserveBps = readInt(
    params["reserveBps"],
    "reserveBps",
    LENDING_RESERVE_BPS_MIN,
    LENDING_RESERVE_BPS_MAX,
  );
  if (!reserveBps.ok) return fail(reserveBps.message);
  return {
    ok: true,
    value: {
      settings: settings.value,
      settingsParams: params["settings"],
      budgetWei: budget.value,
      reserveBps: reserveBps.value,
    },
  };
}

export type LendingSettingsRequest = {
  readonly settings: LendingSettings;
  readonly settingsParams: unknown;
};

/**
 * `POST /agents/:id/lending/settings` takes the settings object DIRECTLY as its
 * params, exactly as `lpSettings` and `venusSettings` do — the digest is
 * `paramsHash("lendingSettings", params)` over those bytes, so wrapping them in
 * an envelope key would make the digest bind a different object from the one
 * the arm signed and the worker recomputes.
 */
export function parseLendingSettingsRequest(
  params: unknown,
): LendingParseResult<LendingSettingsRequest> {
  const settings = parseLendingSettingsParams(params);
  if (!settings.ok) return fail(settings.message);
  return { ok: true, value: { settings: settings.value, settingsParams: params } };
}

export type LendingRetireRequest = {
  /**
   * The owner's declared acceptance that a POOL-SHORT retire leaves the
   * unredeemable remainder supplied on Venus, recoverable with the passkey
   * (R3.12). Absent or false ⇒ a pool-short retire is refused rather than
   * submitted as a partial, so nobody discovers the residue afterwards.
   */
  readonly acceptPartial?: boolean;
};

const RETIRE_KEYS: ReadonlySet<string> = new Set(["acceptPartial"]);

export function parseLendingRetireParams(
  params: unknown,
): LendingParseResult<LendingRetireRequest> {
  if (params === undefined || params === null) return { ok: true, value: {} };
  if (!isRecord(params)) return fail("lendingRetire params must be a JSON object.");
  const unknownKey = Object.keys(params).find((key) => !RETIRE_KEYS.has(key));
  if (unknownKey !== undefined) {
    return fail(`lendingRetire params has unknown key "${unknownKey}".`);
  }
  const raw = params["acceptPartial"];
  if (raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== "boolean") return fail("acceptPartial must be a boolean.");
  return { ok: true, value: { acceptPartial: raw } };
}

/* -------------------------------------------------------------------------- */
/* Profile enforcement (§4.3, R3.3 item 4)                                    */
/* -------------------------------------------------------------------------- */

export type LendingProfileContext = {
  /** The PINNED debt markets, from the guard row. */
  readonly debtMarkets: readonly Address[];
  /** vUSDT's underlying, so a vUSDT entry maps to a token address. */
  readonly usdt: Address;
  /** vUSDT, pinned at boot. */
  readonly vUsdt: Address;
  /** vBNB, pinned at boot. A vBNB entry maps to `token: null`. */
  readonly vBnb: Address;
  /** The GRANTED on-chain caps, so a refusal can name a live remedy. */
  readonly grantedReserveCapWei: bigint;
  readonly grantedCapDayWei: bigint;
  /** `hireSizing.openNativeBudgetWei`. */
  readonly hireBudgetWei: bigint;
};

export type LendingProfileRefusal = {
  readonly message: string;
};

/**
 * Refuse settings this hire cannot honour — at the arm AND at every later
 * settings write.
 *
 * ═══ THE R3.3(4) HALF, AND WHY IT IS NOT A REPEAT OF `checkLendingSizing` ══
 *
 * On-chain caps are FIXED AT GRANT. An owner who raises `rescueReserveCount`
 * or a `maxPerAction` after funding cannot widen `reserveCapWei` from the
 * browser — `owner-add-spend-limit` is an operator CLI — so a refusal that
 * arrives after the passkey grant with no browser remedy leaves the wallet
 * occupied by an un-armable agent (`walletConflict`). Every refusal here
 * therefore NAMES A REMEDY the browser can act on, and the gas-reserve term is
 * checked against the cap the session ACTUALLY HOLDS rather than against the
 * one the hire asked for.
 */
export function enforceLendingV1Profile(
  settings: LendingSettings,
  context: LendingProfileContext,
  armBudgetWei?: bigint,
): LendingProfileRefusal | null {
  if (context.debtMarkets.length === 0) {
    return {
      message:
        "This guard pins no debt market. A guard with no market it may repay is a promise the agent cannot keep; retire and re-hire naming at least one market.",
    };
  }
  if (context.debtMarkets.length > 2) {
    return {
      message:
        "v1 guards at most two debt markets (vUSDT and vBNB). Retire and re-hire with a supported set.",
    };
  }

  // One ceiling per pinned market, all required, nothing outside the set.
  const expected = new Map<string, Address | null>();
  for (const market of context.debtMarkets) {
    if (market.toLowerCase() === context.vUsdt.toLowerCase()) {
      expected.set(context.usdt.toLowerCase(), context.usdt);
    } else if (market.toLowerCase() === context.vBnb.toLowerCase()) {
      expected.set("native", null);
    } else {
      return {
        message:
          `Pinned market ${market} is not a v1 debt market (vUSDT or vBNB). Retire and re-hire with a supported set.`,
      };
    }
  }
  const supplied = new Set(
    settings.maxPerAction.map((cap) =>
      cap.token === null ? "native" : cap.token.toLowerCase(),
    ),
  );
  for (const key of expected.keys()) {
    if (!supplied.has(key)) {
      return {
        message:
          `maxPerAction is missing a ceiling for ${key === "native" ? "BNB" : key}. ` +
          "Set a Max repay per event for every debt this guard is pinned to.",
      };
    }
  }
  for (const key of supplied) {
    if (!expected.has(key)) {
      return {
        message:
          `maxPerAction names ${key === "native" ? "BNB" : key}, which this guard is not pinned to. ` +
          "Remove it; the session grants exactly the markets pinned at hire.",
      };
    }
  }

  if (armBudgetWei !== undefined && armBudgetWei > context.hireBudgetWei) {
    return {
      message:
        `budgetWei ${armBudgetWei} exceeds the budget this hire was sized and funded for ` +
        `(${context.hireBudgetWei}). Lower the amount, or retire and re-hire at the larger size.`,
    };
  }

  // R3.3(4): the implied approves must still fit under the GRANTED USDT cap.
  // The largest single USDT approve any rescue emits is `maxPerAction[USDT]`
  // for the vUSDT-debt path; the router paths are bounded by holdings, which
  // `checkLendingSizing` already priced at hire. What can change AFTER the
  // grant is `maxPerAction`, so that is what is re-checked here.
  const usdtCeiling = lendingMaxPerActionFor(settings, context.usdt);
  if (usdtCeiling !== null && usdtCeiling > context.grantedReserveCapWei) {
    return {
      message:
        `Max repay per event for USDT (${usdtCeiling}) exceeds the USDT day cap this session ` +
        `actually holds (${context.grantedReserveCapWei}). A repay that large would be refused ` +
        `on chain and would surface as a silent PENDING. Lower Max repay per event to ` +
        `${context.grantedReserveCapWei}, or retire and re-hire with a larger cap.`,
    };
  }
  const nativeCeiling = lendingMaxPerActionFor(settings, null);
  if (nativeCeiling !== null && nativeCeiling > context.grantedCapDayWei) {
    return {
      message:
        `Max repay per event for BNB (${nativeCeiling}) exceeds the native day cap this session ` +
        `actually holds (${context.grantedCapDayWei}). Lower it to ${context.grantedCapDayWei}, ` +
        "or retire and re-hire with a larger cap.",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Views — the WEB CONTRACT (§8.3 as amended by R2.18)                        */
/* -------------------------------------------------------------------------- */

/**
 * The settings echoed back on a route response.
 *
 * No owner text fields exist on a lending settings object (§4.2), so unlike
 * the LP surface there is nothing to redact — the full object rides back, which
 * is what makes an Edit panel able to read what it is replacing.
 */
export type LendingSettingsView = {
  readonly triggerHf: string;
  readonly targetHf: string;
  readonly maxPerAction: readonly {
    readonly token: Address | null;
    readonly maxWei: string;
  }[];
  readonly minSecondsBetweenActions: number;
  readonly rescueReserveCount: number;
  readonly notifyOnlyBelowHf: string | null;
};

export function lendingSettingsView(settings: LendingSettings): LendingSettingsView {
  return {
    triggerHf: settings.triggerHf.toString(10),
    targetHf: settings.targetHf.toString(10),
    maxPerAction: settings.maxPerAction.map((cap) => ({
      token: cap.token,
      maxWei: cap.maxWei.toString(10),
    })),
    minSecondsBetweenActions: settings.minSecondsBetweenActions,
    rescueReserveCount: settings.rescueReserveCount,
    notifyOnlyBelowHf:
      settings.notifyOnlyBelowHf === undefined
        ? null
        : settings.notifyOnlyBelowHf.toString(10),
  };
}

/**
 * One market as `GET /lending/guardable` and the view report it.
 *
 * Prices are the PROTOCOL ORACLE's, never the data plane's — this is the same
 * reconstruction the trigger acts on, so a UI that renders it is rendering the
 * number the guard decided against.
 */
export type LendingMarketView = {
  readonly vToken: Address;
  readonly symbol: string;
  readonly underlying: Address | null;
  readonly underlyingDecimals: number;
  readonly supplyUnderlyingWei: string;
  readonly borrowWei: string;
  readonly isCollateral: boolean;
  readonly collateralFactor: string;
  readonly liquidationThreshold: string;
  readonly priceMantissa: string;
};

export type LendingDebtView = {
  readonly vToken: Address;
  readonly symbol: string;
  readonly borrowWei: string;
  readonly debtValueMantissa: string;
  /** Whether v1 can repay it at all (vUSDT / vBNB only). */
  readonly supported: boolean;
  readonly reason?: "unsupported-in-v1";
};

/** Both reconstructed bases, with the per-basis protocol match flag. */
export type LendingBasesView = {
  readonly borrowingPower: { readonly hf: string | null; readonly matched: boolean };
  readonly liquidation: { readonly hf: string | null; readonly matched: boolean };
};

/**
 * `GET /lending/guardable` — the perimeter read the guarded-account stage and
 * the stale-snapshot fallback both use (R2.10, R2.11, R2.18, R3.3(5)).
 *
 * TWO MODES:
 *   - **display** (`?account=A` alone): position only, NO receipt.
 *   - **receipt** (`?account=A&budgetWei=&reserveBps=&maxPerActionUsdtWei=&
 *     rescueReserveCount=`): additionally returns a plane-signed, 30-second
 *     receipt binding the account, the block, guardability, the debts and
 *     EVERY sizing input — so S1 can verify that the hire params it was signed
 *     with equal the ones the floor was computed from (R3.3(b)).
 */
export type LendingGuardableView = {
  readonly account: Address;
  readonly blockNumber: string;
  readonly bases: LendingBasesView;
  readonly markets: readonly LendingMarketView[];
  readonly debts: readonly LendingDebtView[];
  readonly guardable: boolean;
  readonly refusal?:
    | "no-debt"
    | "no-supported-debt"
    | "protocol-mismatch"
    | "emode-unverified"
    | "oracle-invalid"
    | "protocol-error"
    | "snapshot-error"
    | "account-too-complex";
  /** Names the offending market when the refusal is about one (R2.13). */
  readonly refusalMarket?: Address;
  /** Present in receipt mode only. */
  readonly sizing?: {
    readonly reserveCapFloorWei: string;
    readonly minimumCapDayWei: string;
    readonly mintUsdtWei: string;
    readonly reserveNativeWei: string;
    readonly supplyNativeWei: string;
    readonly ok: boolean;
    readonly refusal?: string;
  };
  /** Present in receipt mode only; opaque to the browser. */
  readonly previewReceipt?: string;
  readonly expiresAtSec?: number;
  /**
   * The disclosure R2.13 requires beside any market-shaped refusal: "Your
   * account entered a market this guard cannot price; the guard is paused
   * until it can."
   */
  readonly note?: string;
};

/** The guard row, as the detail page reads it. */
export type LendingGuardView = {
  readonly status: LendingGuardStatus;
  readonly hold: LendingHold | null;
  readonly guardedAccount: Address;
  readonly debtMarkets: readonly Address[];
  readonly reserveBps: number;
  readonly budgetWei: string;
  readonly reserveCapWei: string;
  readonly armTxHash: Hex | null;
  readonly armBlock: string | null;
  /**
   * WHICH block `armBlock` is (FIXREVIEW F7): `"receipt"` = the block the arm's
   * transaction landed in; `"post-arm-read"` = the finalized block of a read
   * taken after it, which proves the arm was observed and nothing about when.
   * Additive and nullable — an existing consumer ignores it.
   */
  readonly armBlockSource: "receipt" | "post-arm-read" | null;
  readonly closeReason: LendingCloseReason | null;
  readonly actionSeq: number;
  readonly lastActionAtMs: number | null;
  readonly updatedAtMs: number;
};

/** What wallet B holds, as of the worker's last snapshot. */
export type LendingReserveView = {
  readonly idleUsdtWei: string;
  readonly suppliedUsdtWei: string;
  readonly vUsdtBalance: string;
  readonly poolCashWei: string;
  readonly bnbTierWei: string;
  readonly capacity: readonly { readonly token: Address | null; readonly wei: string }[];
  /** Capacity value / A's supported debt value, in bps. `null` when unpriced. */
  readonly coverageBps: number | null;
  /** The dust the retire left behind, disclosed rather than rounded away. */
  readonly dust?: { readonly usdtWei: string; readonly vUsdtWei: string };
};

export type LendingRescueView = {
  readonly rescueId: string;
  readonly market: Address;
  readonly amountWei: string;
  readonly hfBefore: string | null;
  readonly hfAfter: string | null;
  readonly achievedHf: string | null;
  readonly txHash: Hex | null;
  readonly effect: "changed" | "no-effect" | "unverified";
  readonly partial: boolean;
  readonly conditions: readonly string[];
  readonly createdAtMs: number;
};

/**
 * `GET /agents/:id/lending/view` — behind `authorizeAccountRead`, ZERO chain
 * reads (R2.18).
 *
 * The worker writes `lending_snapshots` LAST in every cycle and this route
 * serves it. `snapshot.staleAfterMs` is `2 x workerIntervalMs`: past it the
 * BFF must render every ACCOUNT tile from a live `/lending/guardable` call
 * labelled "read now, not by the agent", and leave every GUARD tile dashed
 * with the staleness reason. The view NEVER guesses.
 */
export type LendingAgentView = {
  readonly guard: LendingGuardView;
  readonly account: {
    readonly blockNumber: string;
    readonly observedAtMs: number;
    readonly bases: LendingBasesView;
    readonly markets: readonly LendingMarketView[];
    readonly debts: readonly LendingDebtView[];
    /** `(hf - 1)` in bps on the liquidation basis. `null` when there is no debt. */
    readonly liquidationDistanceBps: number | null;
  } | null;
  readonly reserve: LendingReserveView | null;
  readonly conditions: readonly LendingConditionReport[];
  readonly usage: { readonly rescues: number; readonly lastRescueAtMs: number | null };
  readonly rescues: readonly LendingRescueView[];
  readonly settings: LendingSettingsView | null;
  readonly settingsDigest: Hex | null;
  readonly session: { readonly expiresAt: number | null; readonly expiring: boolean };
  readonly snapshot: {
    readonly presentAt: number | null;
    readonly ageMs: number | null;
    readonly staleAfterMs: number;
    readonly stale: boolean;
    /** Why a stale snapshot is stale, for the dash-with-reason rule. */
    readonly reason: string | null;
    readonly workerIntervalMs: number;
  };
};

/**
 * `GET /lending/config` — the perimeter read the browser's passkey recovery
 * batch needs (R3.9 / L4).
 *
 * The browser must NOT hardcode these: the router, the vToken and the fee tier
 * are boot config the operator can move, and a recovery batch built against a
 * stale copy would approve the wrong spender.
 */
export type LendingConfigView = {
  readonly chainId: 56;
  readonly vUsdt: Address;
  readonly usdt: Address;
  readonly vBnb: Address;
  readonly routerV3: Address;
  readonly wbnb: Address;
  readonly quoterV2: Address;
  readonly swapFeeTier: number;
  readonly maxSagaSlippageBps: number;
  readonly dustUsdtWei: string;
  readonly maxMarkets: number;
  /**
   * The worker's configured cadence, in milliseconds.
   *
   * The deploy form's "Check every" figure was a STATIC string, so an operator
   * who moved `LENDING_WORKER_INTERVAL_MS` changed how often the guard actually
   * looks without changing what a hire is told it will do. This is the RESOLVED
   * runtime value the worker is composed with — the same number
   * `/lending/view`'s snapshot block reports as `workerIntervalMs` — read from
   * the one composition site (`buildLendingServerDeps`), so a read side cannot
   * report a cadence the writer does not run on.
   *
   * It is CONFIGURED CADENCE, not certification: nothing here says a worker is
   * running (PHASE 'worker-only ticks never light the live badge').
   */
  readonly workerIntervalMs: number;
};

/**
 * `GET /lending/quote` — a QuoterV2 `quoteExactInputSingle` through the plane,
 * so the browser's `minOut` comes off THE SAME RAIL the plane uses and never
 * off a data-plane price (R3.9 / L4). A price is not a quote.
 */
export type LendingQuoteView = {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly amountInWei: string;
  readonly quotedOutWei: string;
  readonly minOutWei: string;
  readonly maxSagaSlippageBps: number;
};

/** Parse the `/lending/guardable` query string. Strict, and address-checked. */
export function parseGuardableQuery(query: {
  readonly account?: string | undefined;
  readonly budgetWei?: string | undefined;
  readonly reserveBps?: string | undefined;
  readonly maxPerActionUsdtWei?: string | undefined;
  readonly rescueReserveCount?: string | undefined;
}): LendingParseResult<{
  readonly account: Address;
  readonly sizing:
    | {
        readonly budgetWei: bigint;
        readonly reserveBps: number;
        readonly maxPerActionUsdtWei: bigint;
        readonly rescueReserveCount: number;
      }
    | null;
}> {
  const account = readAddressField(query.account, "account");
  if (!account.ok) return fail(account.message);
  const present = [
    query.budgetWei,
    query.reserveBps,
    query.maxPerActionUsdtWei,
    query.rescueReserveCount,
  ].filter((entry) => entry !== undefined && entry !== "");
  if (present.length === 0) {
    return { ok: true, value: { account: account.value, sizing: null } };
  }
  if (present.length !== 4) {
    return fail(
      "Receipt mode requires budgetWei, reserveBps, maxPerActionUsdtWei and rescueReserveCount together; a receipt that bound only some of its inputs would verify at S1 for a budget it never priced.",
    );
  }
  if (!/^\d{1,78}$/u.test(query.budgetWei ?? "")) {
    return fail("budgetWei must be a decimal uint256 string.");
  }
  const budgetWei = BigInt(query.budgetWei as string);
  if (budgetWei <= 0n) return fail("budgetWei must be positive.");
  if (!/^\d{1,78}$/u.test(query.maxPerActionUsdtWei ?? "")) {
    return fail("maxPerActionUsdtWei must be a decimal uint256 string.");
  }
  const maxPerActionUsdtWei = BigInt(query.maxPerActionUsdtWei as string);
  const reserveBps = Number(query.reserveBps);
  if (
    !Number.isInteger(reserveBps)
    || reserveBps < LENDING_RESERVE_BPS_MIN
    || reserveBps > LENDING_RESERVE_BPS_MAX
  ) {
    return fail(
      `reserveBps must be an integer in ${LENDING_RESERVE_BPS_MIN}..${LENDING_RESERVE_BPS_MAX}.`,
    );
  }
  const rescueReserveCount = Number(query.rescueReserveCount);
  if (
    !Number.isInteger(rescueReserveCount)
    || rescueReserveCount < LENDING_RESCUE_RESERVE_COUNT_MIN
    || rescueReserveCount > LENDING_RESCUE_RESERVE_COUNT_MAX
  ) {
    return fail(
      `rescueReserveCount must be an integer in ${LENDING_RESCUE_RESERVE_COUNT_MIN}..${LENDING_RESCUE_RESERVE_COUNT_MAX}.`,
    );
  }
  return {
    ok: true,
    value: {
      account: account.value,
      sizing: { budgetWei, reserveBps, maxPerActionUsdtWei, rescueReserveCount },
    },
  };
}

/** Exported for the S1 parser and the arm route; keeps one bound in one place. */
export const LENDING_DEFAULT_RESERVE_BPS = LENDING_RESERVE_BPS_DEFAULT;
export const LENDING_VIEW_MAX_MARKETS = LENDING_MAX_MARKETS;
