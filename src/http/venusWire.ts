/**
 * The Venus settings wire — parse, validate, and the defaults
 * (PHASE4-SPEC D4, amended by R2.9 (`maxClaimsPerDay`), R2.14 (the default
 * thresholds), R3.6 (`rescueReserveCount` as a NUMBER) and acceptance step 4
 * (both claim booleans default FALSE, with the evidence gap stated)).
 *
 * WHAT IS STORED IS THE SIGNED WIRE PARAMS, VERBATIM, plus their digest — the
 * `lpSettings` discipline, for the same reason: the observation row carries the
 * digest and a digest mismatch invalidates the confirmation counter (R2.15/
 * R18), so the bytes that were signed and the bytes that are compared must be
 * the same bytes. Interpretation happens at READ time, from those bytes.
 */
import { getAddress, isAddress, type Address } from "viem";

/* -------------------------------------------------------------------------- */
/* The interpreted settings                                                   */
/* -------------------------------------------------------------------------- */

/** One owner-set per-action ceiling. `token: null` means NATIVE BNB. */
export type VenusPerActionCap = {
  readonly token: Address | null;
  readonly maxWei: bigint;
};

export type VenusAutomationSettings = {
  /** 1e18 mantissa. The guard acts below this, on the LIQUIDATION basis. */
  readonly triggerHf: bigint;
  /** 1e18 mantissa. What a rescue aims to restore. `> triggerHf`. */
  readonly targetHf: bigint;
  /** vToken addresses the owner permits a repay in. Locked at hire (D2). */
  readonly debtMarkets: readonly Address[];
  /** vToken addresses the owner permits a supply into. */
  readonly collateralMarkets: readonly Address[];
  /** Per-token ceilings on ONE submission. */
  readonly maxPerAction: readonly VenusPerActionCap[];
  /**
   * The daily quota — CLAIMS ONLY (R2.9). Rescues are counted against the same
   * ledger and never refused by it (R3.4).
   */
  readonly maxClaimsPerDay: number;
  /** Anti-flap floor between two rescues. */
  readonly minSecondsBetweenActions: number;
  /** Floor on a claim's value, denominated in wei of BNB (R2.15/R24). */
  readonly minClaimValueWei: bigint;
  readonly claimEnabled: boolean;
  readonly claimRepayEnabled: boolean;
  /** Optional second, HIGHER threshold: flag "approaching", never act. */
  readonly notifyOnlyBelowHf?: bigint;
  /** How many rescue submissions the claim gate reserves meter for (R3.6). */
  readonly rescueReserveCount: number;
};

export const E18 = 10n ** 18n;

/**
 * Defaults, as NUMBERS rather than as "owner-set" (R3.6/S6).
 *
 * `triggerHf` 1.30 / `targetHf` 1.60 are R2.14's, chosen with the latency
 * budget: the guard's working range is `1.0 < HF < triggerHf`, so the band must
 * exceed one worker interval of plausible price movement.
 *
 * Both claim booleans default FALSE. Acceptance step 4: no non-zero claim has
 * ever been measured on an account this plane controls (the same-token
 * claim-repay case is assembled from two DIFFERENT accounts — a Prime holder
 * with 17.81 pending USDT and zero debt, and the test wallet with USDT debt and
 * no Prime). Shipping them on would be shipping an unexercised money path.
 */
export const DEFAULT_VENUS_SETTINGS: VenusAutomationSettings = {
  triggerHf: 1_300_000_000_000_000_000n,
  targetHf: 1_600_000_000_000_000_000n,
  debtMarkets: [],
  collateralMarkets: [],
  maxPerAction: [],
  maxClaimsPerDay: 4,
  minSecondsBetweenActions: 300,
  minClaimValueWei: 2_000_000_000_000_000n,
  claimEnabled: false,
  claimRepayEnabled: false,
  rescueReserveCount: 4,
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

export type VenusParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function fail<T>(message: string): VenusParseResult<T> {
  return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "triggerHf",
  "targetHf",
  "debtMarkets",
  "collateralMarkets",
  "maxPerAction",
  "maxClaimsPerDay",
  "minSecondsBetweenActions",
  "minClaimValueWei",
  "claimEnabled",
  "claimRepayEnabled",
  "notifyOnlyBelowHf",
  "rescueReserveCount",
]);

/** A 1e18 mantissa on the wire: a bare decimal integer string. */
function readMantissa(
  value: unknown,
  field: string,
): VenusParseResult<bigint> {
  if (typeof value !== "string" || !/^\d{1,40}$/u.test(value)) {
    return fail(`${field} must be a decimal integer string (1e18 mantissa).`);
  }
  return { ok: true, value: BigInt(value) };
}

function readWei(value: unknown, field: string): VenusParseResult<bigint> {
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
): VenusParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(`${field} must be an integer.`);
  }
  if (value < min || value > max) {
    return fail(`${field} must be between ${min} and ${max}.`);
  }
  return { ok: true, value };
}

function readBool(value: unknown, field: string): VenusParseResult<boolean> {
  if (typeof value !== "boolean") return fail(`${field} must be a boolean.`);
  return { ok: true, value };
}

/**
 * A vToken list. Deduplicated by lowercased address and REJECTED on a
 * duplicate rather than silently folded: a duplicate market in a signed
 * parameter is a caller who believed it meant something.
 */
function readMarketList(
  value: unknown,
  field: string,
): VenusParseResult<readonly Address[]> {
  if (!Array.isArray(value)) return fail(`${field} must be an array.`);
  if (value.length > 16) return fail(`${field} may name at most 16 markets.`);
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isAddress(entry, { strict: false })) {
      return fail(`${field} entries must be addresses.`);
    }
    const normalized = getAddress(entry);
    const key = normalized.toLowerCase();
    if (seen.has(key)) return fail(`${field} names ${normalized} twice.`);
    seen.add(key);
    out.push(normalized);
  }
  return { ok: true, value: out };
}

function readPerActionCaps(
  value: unknown,
): VenusParseResult<readonly VenusPerActionCap[]> {
  if (!Array.isArray(value)) return fail("maxPerAction must be an array.");
  if (value.length > 32) return fail("maxPerAction may hold at most 32 entries.");
  const seen = new Set<string>();
  const out: VenusPerActionCap[] = [];
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
 * Parse and VALIDATE the owner's Venus settings.
 *
 * The threshold ordering is enforced here with typed messages (D4):
 * `targetHf > triggerHf > 1.0`. A `triggerHf` at or below 1.0 is a guard that
 * fires only once the account is already liquidatable, which is the one state
 * R2.14 says the plane will usually lose the race in; a `targetHf` at or below
 * `triggerHf` sizes a rescue that does not clear the trigger, so the next cycle
 * fires again — a cap-draining loop wearing a threshold's name.
 *
 * The market-in-grant cross-check does NOT happen here: it needs the agent's
 * session facts, it is an EARLY WARNING rather than the guarantee (R2.15/R20),
 * and `preflightExecute` at action time is what actually holds.
 */
export function parseVenusSettingsParams(
  params: unknown,
): VenusParseResult<VenusAutomationSettings> {
  if (!isRecord(params)) return fail("Settings params must be a JSON object.");
  const unknownKey = Object.keys(params).find((key) => !SETTINGS_KEYS.has(key));
  if (unknownKey !== undefined) {
    return fail(`Settings params has unknown key "${unknownKey}".`);
  }

  const out: {
    -readonly [K in keyof VenusAutomationSettings]: VenusAutomationSettings[K];
  } = { ...DEFAULT_VENUS_SETTINGS };

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
  if (params["debtMarkets"] !== undefined) {
    const parsed = readMarketList(params["debtMarkets"], "debtMarkets");
    if (!parsed.ok) return fail(parsed.message);
    out.debtMarkets = parsed.value;
  }
  if (params["collateralMarkets"] !== undefined) {
    const parsed = readMarketList(params["collateralMarkets"], "collateralMarkets");
    if (!parsed.ok) return fail(parsed.message);
    out.collateralMarkets = parsed.value;
  }
  if (params["maxPerAction"] !== undefined) {
    const parsed = readPerActionCaps(params["maxPerAction"]);
    if (!parsed.ok) return fail(parsed.message);
    out.maxPerAction = parsed.value;
  }
  if (params["maxClaimsPerDay"] !== undefined) {
    const parsed = readInt(params["maxClaimsPerDay"], "maxClaimsPerDay", 0, 100);
    if (!parsed.ok) return fail(parsed.message);
    out.maxClaimsPerDay = parsed.value;
  }
  if (params["minSecondsBetweenActions"] !== undefined) {
    const parsed = readInt(
      params["minSecondsBetweenActions"],
      "minSecondsBetweenActions",
      0,
      86_400,
    );
    if (!parsed.ok) return fail(parsed.message);
    out.minSecondsBetweenActions = parsed.value;
  }
  if (params["minClaimValueWei"] !== undefined) {
    const parsed = readWei(params["minClaimValueWei"], "minClaimValueWei");
    if (!parsed.ok) return fail(parsed.message);
    out.minClaimValueWei = parsed.value;
  }
  if (params["claimEnabled"] !== undefined) {
    const parsed = readBool(params["claimEnabled"], "claimEnabled");
    if (!parsed.ok) return fail(parsed.message);
    out.claimEnabled = parsed.value;
  }
  if (params["claimRepayEnabled"] !== undefined) {
    const parsed = readBool(params["claimRepayEnabled"], "claimRepayEnabled");
    if (!parsed.ok) return fail(parsed.message);
    out.claimRepayEnabled = parsed.value;
  }
  if (params["rescueReserveCount"] !== undefined) {
    const parsed = readInt(
      params["rescueReserveCount"],
      "rescueReserveCount",
      1,
      64,
    );
    if (!parsed.ok) return fail(parsed.message);
    out.rescueReserveCount = parsed.value;
  }

  if (out.triggerHf <= E18) {
    return fail(
      "triggerHf must exceed 1.0 (1e18). A guard that fires at or below 1.0 fires " +
        "only once the account is already liquidatable, which is the one race this " +
        "plane will usually lose.",
    );
  }
  if (out.targetHf <= out.triggerHf) {
    return fail(
      "targetHf must exceed triggerHf. A target at or below the trigger sizes a " +
        "rescue that does not clear the trigger, so the next cycle fires again — a " +
        "cap-draining loop wearing a threshold's name.",
    );
  }
  if (out.notifyOnlyBelowHf !== undefined && out.notifyOnlyBelowHf <= out.triggerHf) {
    return fail(
      "notifyOnlyBelowHf is the APPROACHING flag and must sit ABOVE triggerHf; " +
        "below it, the guard is already acting and the flag says nothing new.",
    );
  }
  if (out.debtMarkets.length === 0 && out.collateralMarkets.length === 0) {
    return fail(
      "At least one of debtMarkets / collateralMarkets must be named; a guard with " +
        "no market it may pay is a promise the agent cannot keep.",
    );
  }
  return { ok: true, value: out };
}

/**
 * The per-action ceiling for a token, or `null` when the owner named none.
 *
 * `null` is NOT "unlimited": the sizing layer treats a missing ceiling as a
 * refusal to size (`market-not-in-settings`), because R2.1 made the per-token
 * cap the sole bound on a leaked-key drain and a defaulted ceiling is exactly
 * the `DEFAULT_TOKEN_CAP_LIMIT` posture that revision forbids.
 */
export function maxPerActionFor(
  settings: VenusAutomationSettings,
  token: Address | null,
): bigint | null {
  const key = token === null ? null : token.toLowerCase();
  for (const cap of settings.maxPerAction) {
    const capKey = cap.token === null ? null : cap.token.toLowerCase();
    if (capKey === key) return cap.maxWei;
  }
  return null;
}

/** Whether a vToken is in the owner's debt list (case-insensitive). */
export function namesMarket(
  list: readonly Address[],
  vToken: Address,
): boolean {
  const target = vToken.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === target);
}
