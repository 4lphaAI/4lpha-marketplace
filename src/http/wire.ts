/**
 * The wire boundary: untrusted JSON in, safe JSON out.
 *
 * Everything here treats its input as hostile and its output as a place a secret
 * could escape. Two rules drive the module:
 *
 *   1. NOTHING is read off a request body by spreading it. Every field is pulled
 *      out by name and type-checked, so an attacker cannot smuggle an extra
 *      property into a shape that is later handed to the provider — which is
 *      exactly how `bypassLocalPolicyCheck` would become settable from a request.
 *      `parseExecuteRequest` reconstructs each call from three named fields and
 *      nothing else.
 *   2. NOTHING is written into a response by spreading a stored record. Views are
 *      built field by field, so a column added to the agent store later cannot
 *      silently start appearing in an owner-facing response.
 *
 * Bigints cross the wire as DECIMAL STRINGS. JSON has no bigint, and `Number` is
 * lossy above 2^53 — which for wei is an everyday amount, not an edge case.
 */
import { getAddress, isAddress, isHex, keccak256, stringToBytes } from "viem";
import type { Address, Hex } from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import {
  MAX_ROUTE_HOPS,
  MAX_ROUTE_POOLS,
  V3_FEE_TIERS,
  normalizeRoute,
  type TradeRoute,
  type V3FeeTier,
} from "../ops/route.js";
import type { OwnerActionRequest, OwnerActionStruct, OwnerActionType } from "../auth/ownerAuth.js";
import { validProvisioningCancellation, type AgentCaps, type AgentRecord } from "../store/agents.js";
import { identityOwnerView } from "../identity/types.js";
import type { WalletCall } from "../core/types.js";
import { parseTradeSettings, type TradeSettings } from "../trade/settings.js";

/** Parse outcome. The message is for the caller's 400, never for a log of input. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function fail<T>(message: string): ParseResult<T> {
  return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string no longer than `max`. Length caps keep logs and keys bounded. */
function readString(
  source: Record<string, unknown>,
  field: string,
  max: number,
): ParseResult<string> {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    return fail(`"${field}" must be a non-empty string.`);
  }
  if (value.length > max) return fail(`"${field}" exceeds ${max} characters.`);
  return { ok: true, value };
}

/**
 * A uint256 given as a decimal string (or a JSON number, which we accept only
 * when it is a safe integer — anything larger has already lost precision by the
 * time it reaches us).
 */
function readBigint(value: unknown, field: string): ParseResult<bigint> {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return fail(`"${field}" must be a non-negative safe integer or a decimal string.`);
    }
    return { ok: true, value: BigInt(value) };
  }
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    return fail(`"${field}" must be a decimal string of up to 78 digits.`);
  }
  return { ok: true, value: BigInt(value) };
}

function readAddress(value: unknown, field: string): ParseResult<Address> {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    return fail(`"${field}" must be a 20-byte hex address.`);
  }
  return { ok: true, value: getAddress(value) };
}

export type GridHireParams = {
  readonly walletAddress: Address;
  readonly token: Address;
  readonly capDayWei: bigint;
  readonly openNativeBudgetWei: bigint;
  readonly ttlSec: number;
  readonly sizingPreset: "grid-v1" | "grid-shift-v1" | "lp-v1";
};

export type TradeHireParams = {
  readonly walletAddress: Address;
  readonly capDayWei: bigint;
  readonly ttlSec: number;
  readonly sizingPreset: "trade-v1";
  readonly executionModel: import("../trade/settings.js").TradeExecutionModel;
  readonly hireRunId: string;
  readonly autoGrant: true;
  readonly settings: TradeSettings;
};

export type HireParams = GridHireParams | TradeHireParams;

const HIRE_PARAM_KEYS = ["walletAddress", "token", "capDayWei", "openNativeBudgetWei", "ttlSec", "sizingPreset"] as const;

/** Strict S1 parser: exact keys, exact decimals, and the closed v1 preset. */
export function parseHireParams(value: unknown): ParseResult<HireParams> {
  if (!isRecord(value)) return fail("Hire params must be a JSON object.");
  if (value["sizingPreset"] === "trade-v1") return parseTradeHireParams(value);
  const keys = Object.keys(value).sort();
  const expected = [...HIRE_PARAM_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return fail(`Hire params must contain exactly: ${HIRE_PARAM_KEYS.join(", ")}.`);
  }
  const walletAddress = readAddress(value["walletAddress"], "walletAddress");
  if (!walletAddress.ok) return walletAddress;
  const token = readAddress(value["token"], "token");
  if (!token.ok) return token;
  if (typeof value["capDayWei"] !== "string") return fail('"capDayWei" must be a positive decimal bigint string.');
  const capDayWei = readBigint(value["capDayWei"], "capDayWei");
  if (!capDayWei.ok || capDayWei.value <= 0n) return fail('"capDayWei" must be a positive decimal bigint string.');
  if (typeof value["openNativeBudgetWei"] !== "string") return fail('"openNativeBudgetWei" must be a positive decimal bigint string.');
  const openNativeBudgetWei = readBigint(value["openNativeBudgetWei"], "openNativeBudgetWei");
  if (!openNativeBudgetWei.ok || openNativeBudgetWei.value <= 0n) return fail('"openNativeBudgetWei" must be a positive decimal bigint string.');
  const ttlSec = value["ttlSec"];
  if (!Number.isInteger(ttlSec) || (ttlSec as number) < 3_600 || (ttlSec as number) > 604_800) {
    return fail('"ttlSec" must be an integer from 3600 through 604800.');
  }
  if (
    value["sizingPreset"] !== "grid-v1"
    && value["sizingPreset"] !== "grid-shift-v1"
    && value["sizingPreset"] !== "lp-v1"
  ) {
    return fail('"sizingPreset" must be "grid-v1", "grid-shift-v1", or "lp-v1".');
  }
  return { ok: true, value: {
    walletAddress: walletAddress.value, token: token.value, capDayWei: capDayWei.value,
    openNativeBudgetWei: openNativeBudgetWei.value, ttlSec: ttlSec as number, sizingPreset: value["sizingPreset"],
  } };
}

const TRADE_HIRE_PARAM_KEYS = [
  "walletAddress", "capDayWei", "ttlSec", "sizingPreset", "executionModel",
  "hireRunId", "autoGrant", "settings",
] as const;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Strict trade-v1 S1 envelope; the existing grid parser remains byte-identical. */
export function parseTradeHireParams(value: unknown): ParseResult<TradeHireParams> {
  if (!isRecord(value)) return fail("Trade hire params must be a JSON object.");
  const keys = Object.keys(value).sort();
  const expected = [...TRADE_HIRE_PARAM_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return fail(`Trade hire params must contain exactly: ${TRADE_HIRE_PARAM_KEYS.join(", ")}.`);
  }
  const walletAddress = readAddress(value["walletAddress"], "walletAddress");
  if (!walletAddress.ok) return walletAddress;
  if (typeof value["capDayWei"] !== "string") return fail('"capDayWei" must be a positive decimal bigint string.');
  const capDayWei = readBigint(value["capDayWei"], "capDayWei");
  if (!capDayWei.ok || capDayWei.value <= 0n) return fail('"capDayWei" must be a positive decimal bigint string.');
  const ttlSec = value["ttlSec"];
  if (!Number.isInteger(ttlSec) || (ttlSec as number) < 3_600 || (ttlSec as number) > 604_800) {
    return fail('"ttlSec" must be an integer from 3600 through 604800.');
  }
  const executionModel = value["executionModel"];
  if (executionModel !== "blue-chip" && executionModel !== "mid-cap"
    && executionModel !== "degen" && executionModel !== "sigma") {
    return fail('"executionModel" must be "blue-chip", "mid-cap", "degen", or "sigma".');
  }
  const hireRunId = value["hireRunId"];
  if (typeof hireRunId !== "string" || !LOWER_UUID.test(hireRunId)) {
    return fail('"hireRunId" must be a lowercase UUID.');
  }
  if (value["autoGrant"] !== true) return fail('"autoGrant" must be true.');
  const settings = parseTradeSettings(value["settings"]);
  if (!settings.ok) return fail(`"settings" is invalid: ${settings.message}`);
  if (settings.value.executionModel !== executionModel) {
    return fail('"settings.executionModel" must equal "executionModel".');
  }
  return { ok: true, value: {
    walletAddress: walletAddress.value, capDayWei: capDayWei.value,
    ttlSec: ttlSec as number, sizingPreset: "trade-v1", executionModel,
    hireRunId, autoGrant: true, settings: settings.value,
  } };
}

/* -------------------------------------------------------------------------- */
/* Execute request                                                            */
/* -------------------------------------------------------------------------- */

/** Longest calldata blob one call may carry, in hex characters. */
const MAX_CALLDATA_HEX = 32_768;

/** Longest identifier we accept for a decision id. */
export const MAX_DECISION_ID_CHARS = 128;

export type ExecuteRequest = {
  readonly decisionId: string;
  readonly calls: readonly WalletCall[];
};

/**
 * Parse the autonomous-execute body.
 *
 * `maxCalls` comes from the provider's `MAX_CALLS_PER_EXECUTE`; the check is
 * repeated here so an oversized batch is refused before any store or key access,
 * not after.
 *
 * Note what this function CANNOT produce: it builds each call from `to`, `value`
 * and `data` and drops every other property, and it returns only
 * `{ decisionId, calls }`. There is no path from a request field to any other
 * `executeViaSession` parameter — `bypassLocalPolicyCheck` in particular.
 */
export function parseExecuteRequest(
  body: unknown,
  maxCalls: number,
): ParseResult<ExecuteRequest> {
  if (!isRecord(body)) return fail("Body must be a JSON object.");

  const decisionId = readString(body, "decisionId", MAX_DECISION_ID_CHARS);
  if (!decisionId.ok) return decisionId;

  const rawCalls = body["calls"];
  if (!Array.isArray(rawCalls)) return fail(`"calls" must be an array.`);
  if (rawCalls.length === 0) return fail(`"calls" must contain at least one call.`);
  if (rawCalls.length > maxCalls) {
    return fail(`"calls" accepts at most ${maxCalls} entries.`);
  }

  const calls: WalletCall[] = [];
  for (const [index, raw] of rawCalls.entries()) {
    if (!isRecord(raw)) return fail(`calls[${index}] must be an object.`);

    const to = readAddress(raw["to"], `calls[${index}].to`);
    if (!to.ok) return to;

    let value: bigint | undefined;
    if (raw["value"] !== undefined && raw["value"] !== null) {
      const parsed = readBigint(raw["value"], `calls[${index}].value`);
      if (!parsed.ok) return parsed;
      value = parsed.value;
    }

    let data: Hex | undefined;
    if (raw["data"] !== undefined && raw["data"] !== null) {
      const candidate = raw["data"];
      if (typeof candidate !== "string" || !isHex(candidate)) {
        return fail(`calls[${index}].data must be a 0x-prefixed hex string.`);
      }
      if (candidate.length > MAX_CALLDATA_HEX) {
        return fail(`calls[${index}].data exceeds ${MAX_CALLDATA_HEX} characters.`);
      }
      data = candidate;
    }

    // Rebuilt field by field. Nothing else from `raw` survives this line.
    calls.push({
      to: to.value,
      ...(value === undefined ? {} : { value }),
      ...(data === undefined ? {} : { data }),
    });
  }

  return { ok: true, value: { decisionId: decisionId.value, calls } };
}

/**
 * Hash a call batch for idempotency and for the decision-conflict check.
 *
 * Uses the SAME canonical encoder the owner-action paramsHash uses, so address
 * casing and bigint spelling cannot make two identical batches hash differently
 * — which would turn a legitimate retry into a fresh submit of the same trade.
 */
export function hashCalls(calls: readonly WalletCall[]): Hex {
  const canonical = calls.map((call) => ({
    to: call.to,
    value: call.value ?? 0n,
    data: call.data ?? "0x",
  }));
  return keccak256(stringToBytes(canonicalEncode(canonical)));
}

/* -------------------------------------------------------------------------- */
/* Trade request                                                              */
/* -------------------------------------------------------------------------- */

/** Venues the trade route can route to. A CLOSED set. */
export const TRADE_VENUES = ["pancake", "pancake_v3", "fourmeme", "flap"] as const;
export type TradeVenue = (typeof TRADE_VENUES)[number];

/**
 * The venues a caller-supplied `route` is meaningful on.
 *
 * `fourmeme` and `flap` are OUT because both are bonding curves: there are no
 * hops and no fee tiers, so a `route` on one is a 400 rather than a field that
 * is silently ignored while still changing `paramsHash`.
 */
const ROUTABLE_VENUES: readonly TradeVenue[] = ["pancake", "pancake_v3"];

/** Trade sides. A CLOSED set. */
export const TRADE_SIDES = ["buy", "sell"] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export type TradeRequest = {
  readonly decisionId: string;
  readonly venue: TradeVenue;
  readonly side: TradeSide;
  readonly token: Address;
  /** Buy: native BNB in. Sell: token amount in. Always > 0. */
  readonly amountWei: bigint;
  /** Slippage floor. Always > 0. */
  readonly minOutWei: bigint;
  /** The caller's own expected output. Always > 0. */
  readonly quotedOutWei: bigint;
  /**
   * The caller's route, ALREADY CANONICAL: absent when it says nothing, and
   * otherwise `{ hops, fees }` with both arrays present. See
   * {@link normalizeRoute} — three spellings of "no route" must not be three
   * different trades.
   */
  readonly route?: TradeRoute;
};

/**
 * Read an enum field.
 *
 * EXACT string equality against the closed set — no trimming, no case folding,
 * no coercion. `"PANCAKE"`, `" pancake"`, `["pancake"]` and
 * `{ toString: () => "pancake" }` are all 400s, because a parser that is
 * forgiving about how a venue is spelled is a parser an attacker can use to
 * reach a code path the validator did not think it was on.
 */
function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): ParseResult<T> {
  if (typeof value !== "string") {
    return fail(`"${field}" must be one of: ${allowed.join(", ")}.`);
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    return fail(`"${field}" must be one of: ${allowed.join(", ")}.`);
  }
  return { ok: true, value: match };
}

/** A uint256 that must be strictly positive. */
function readPositiveBigint(value: unknown, field: string): ParseResult<bigint> {
  const parsed = readBigint(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0n) return fail(`"${field}" must be greater than zero.`);
  return parsed;
}

/**
 * Read one V3 fee tier.
 *
 * STRICT, in the same way {@link readEnum} is strict: a JSON number that is an
 * exact member of the closed set, or a 400. `"2500"` is a 400 because a parser
 * that coerces a string is a parser that will one day coerce `"2500abc"`;
 * `2500.5` is a 400 because `uint24` has no fractional part and rounding one
 * silently would pick a pool the caller did not name.
 */
function readFeeTier(value: unknown, field: string): ParseResult<V3FeeTier> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(`"${field}" must be one of: ${V3_FEE_TIERS.join(", ")}.`);
  }
  const match = V3_FEE_TIERS.find((tier) => tier === value);
  if (match === undefined) {
    return fail(`"${field}" must be one of: ${V3_FEE_TIERS.join(", ")}.`);
  }
  return { ok: true, value: match };
}

/**
 * Parse the OPTIONAL `route`, with the same discipline as every other field.
 *
 * Every rule here is a rule about not submitting a trade the caller did not
 * describe:
 *
 *   - a `route` on a venue that cannot route is a 400, INCLUDING `{}`
 *     (PHASE2.2 R3). Accepting and ignoring it would be bad enough on its own —
 *     the caller believes it routed somewhere it did not — but `route` also
 *     folds into `paramsHash`, so an ignored field silently changes the trade's
 *     identity and 409s an honest retry;
 *   - `pancake_v3` REQUIRES `fees`. There is no default tier, because picking
 *     one is routing and this service does not route;
 *   - `pancake` (V2) with `fees` is a 400. Fee tiers mean nothing on V2;
 *   - both arrays are length-bounded BEFORE anything iterates them;
 *   - hops are unique, and none of them is `token`. A repeated or
 *     self-referencing hop is a malformed path, not a route.
 *
 * The remaining hop checks — wallet, KeyStore, WBNB, the routers, the treasury,
 * the zero address — need the persisted row, so they run in the route handler
 * against the same `forbiddenTokenAddresses` set `token` itself goes through.
 */
function parseRoute(
  raw: unknown,
  venue: TradeVenue,
  token: Address,
): ParseResult<TradeRoute | undefined> {
  const present = raw !== undefined && raw !== null;

  if (present && !ROUTABLE_VENUES.includes(venue)) {
    return fail(`"route" is only meaningful on the ${ROUTABLE_VENUES.join(" and ")} venues.`);
  }
  if (present && !isRecord(raw)) {
    return fail(`"route" must be a JSON object.`);
  }

  const source: Record<string, unknown> = present ? (raw as Record<string, unknown>) : {};

  const rawHops = source["hops"];
  const hops: Address[] = [];
  if (rawHops !== undefined && rawHops !== null) {
    if (!Array.isArray(rawHops)) return fail(`"route.hops" must be an array.`);
    if (rawHops.length > MAX_ROUTE_HOPS) {
      return fail(`"route.hops" accepts at most ${MAX_ROUTE_HOPS} entries.`);
    }
    for (const [index, entry] of rawHops.entries()) {
      const hop = readAddress(entry, `route.hops[${index}]`);
      if (!hop.ok) return hop;
      if (hop.value.toLowerCase() === token.toLowerCase()) {
        return fail(`"route.hops" must not contain the traded token.`);
      }
      if (hops.some((seen) => seen.toLowerCase() === hop.value.toLowerCase())) {
        return fail(`"route.hops" must not repeat an address.`);
      }
      hops.push(hop.value);
    }
  }

  const rawFees = source["fees"];
  const fees: V3FeeTier[] = [];
  if (rawFees !== undefined && rawFees !== null) {
    if (!Array.isArray(rawFees)) return fail(`"route.fees" must be an array.`);
    if (rawFees.length > MAX_ROUTE_POOLS) {
      return fail(`"route.fees" accepts at most ${MAX_ROUTE_POOLS} entries.`);
    }
    for (const [index, entry] of rawFees.entries()) {
      const tier = readFeeTier(entry, `route.fees[${index}]`);
      if (!tier.ok) return tier;
      fees.push(tier.value);
    }
  }

  if (venue === "pancake_v3") {
    if (fees.length === 0) {
      return fail(`"route.fees" is required for the pancake_v3 venue.`);
    }
    if (fees.length !== hops.length + 1) {
      return fail(`"route.fees" must carry exactly one entry per pool.`);
    }
  } else if (fees.length > 0) {
    return fail(`"route.fees" is meaningless on the pancake venue.`);
  }

  // Rebuilt field by field: nothing else on the supplied object survives.
  return { ok: true, value: normalizeRoute({ hops, fees }) };
}

/**
 * Parse the high-level trade body.
 *
 * Same discipline as {@link parseExecuteRequest}, for the same reason: the
 * result is built from named fields ONLY, so nothing else in the body survives
 * into anything handed to the provider. There is no `calls` array here at all —
 * the calldata is built server-side from these values — which is what makes the
 * recipient, the spender and the venue unreachable from the wire.
 *
 * `route` is the one field that widens what a caller can ask for: it names
 * intermediate POOLS. It cannot name a recipient, a spender or a router, and
 * every address in it runs the same blacklist `token` runs.
 */
export function parseTradeRequest(body: unknown): ParseResult<TradeRequest> {
  if (!isRecord(body)) return fail("Body must be a JSON object.");

  const decisionId = readString(body, "decisionId", MAX_DECISION_ID_CHARS);
  if (!decisionId.ok) return decisionId;

  const venue = readEnum(body["venue"], "venue", TRADE_VENUES);
  if (!venue.ok) return venue;

  const side = readEnum(body["side"], "side", TRADE_SIDES);
  if (!side.ok) return side;

  const token = readAddress(body["token"], "token");
  if (!token.ok) return token;

  const amountWei = readPositiveBigint(body["amountWei"], "amountWei");
  if (!amountWei.ok) return amountWei;

  const minOutWei = readPositiveBigint(body["minOutWei"], "minOutWei");
  if (!minOutWei.ok) return minOutWei;

  const quotedOutWei = readPositiveBigint(body["quotedOutWei"], "quotedOutWei");
  if (!quotedOutWei.ok) return quotedOutWei;

  const route = parseRoute(body["route"], venue.value, token.value);
  if (!route.ok) return route;

  return {
    ok: true,
    value: {
      decisionId: decisionId.value,
      venue: venue.value,
      side: side.value,
      token: token.value,
      amountWei: amountWei.value,
      minOutWei: minOutWei.value,
      quotedOutWei: quotedOutWei.value,
      ...(route.value === undefined ? {} : { route: route.value }),
    },
  };
}

/** Everything a trade's identity depends on. See {@link tradeParamsHash}. */
export type TradeParamsHashInput = {
  readonly chainId: number;
  readonly venue: TradeVenue;
  readonly side: TradeSide;
  readonly token: Address;
  readonly amountWei: bigint;
  readonly minOutWei: bigint;
  readonly quotedOutWei: bigint;
  readonly router?: Address;
  /**
   * The resolved V3 router, folded in for exactly the reason `router` is
   * (PHASE2 R17 / PHASE2.2 R7): without it, `VENUE_PANCAKE_ROUTER_V3` could be
   * repointed between a submit and its retry with the hash unchanged, and the
   * retry would be answered with the FIRST trade's stored outcome even though it
   * is now aimed at a different contract.
   */
  readonly routerV3?: Address;
  /**
   * The resolved flap Portal, folded in for exactly the reason `routerV3` is
   * (PHASE2.2 R7 / PHASE2.4 R8): a `VENUE_FLAP_PORTAL` repointed between a
   * submit and its retry must not leave the hash unchanged. It matters slightly
   * more here than for a router — the Portal is also the approval SPENDER on
   * every flap sell — so a retry answered with the first trade's outcome could
   * be aimed at a contract that now holds an allowance.
   */
  readonly flapPortal?: Address;
  readonly wbnb?: Address;
  readonly treasury?: Address;
  readonly feeBps?: number;
  /**
   * The caller's route, in the ONE canonical form (PHASE2.2 R7). Two trades with
   * the same amounts down different routes are different trades, so hops and fee
   * tiers are both bound.
   */
  readonly route?: TradeRoute;
};

/**
 * Hash a trade's parameters AND the configuration that will execute them.
 *
 * The resolved venue addresses, the chain, the fee treasury and the fee rate are
 * all folded in, not just the request. Without that, changing a `VENUE_*`
 * override between a submit and its retry would leave the paramsHash unchanged:
 * the retry would be treated as an exact replay and answered with the FIRST
 * trade's stored outcome, even though it would now be aimed at a different
 * router. Binding the config makes that a 409 instead.
 *
 * The Four.Meme manager and `msgValue` are DELIBERATELY absent (PHASE2.1 R11).
 * They are no longer configuration: they come from a fresh RPC read on every
 * attempt, and a legitimate retry re-reads them. They are recorded in
 * `externalRef.callsHash`, which is what the row actually submitted. Folding
 * chain-state-at-submit-time into the identity of a decision would turn every
 * honest retry into a 409, exactly as Pancake's per-attempt deadline would.
 * Replay safety does not depend on them: `beginWithSpend`'s `created` flag
 * guarantees one submit per `(decisionId, paramsHash)`, a retry returns the
 * stored outcome without re-reading, and UNKNOWN is held rather than replayed.
 */
export function tradeParamsHash(input: TradeParamsHashInput): Hex {
  return keccak256(stringToBytes(canonicalEncode(input)));
}

/* -------------------------------------------------------------------------- */
/* Owner-action envelope                                                      */
/* -------------------------------------------------------------------------- */

/** Longest owner-action envelope we accept, in characters of JSON. */
export const MAX_OWNER_ENVELOPE_CHARS = 8_192;

/**
 * Parse a signed owner action.
 *
 * `params` is passed through VERBATIM — whatever JSON value the client sent is
 * exactly what `paramsHash` is recomputed over. That is the contract that makes
 * the binding checkable by a client: sign `paramsHash(action, <the object you are
 * about to send>)`. Interpreting the params (coercing a decimal string to a
 * bigint, say) happens per-route AFTER verification, never before, because any
 * coercion here would hash differently than what the client signed.
 */
export function parseOwnerActionEnvelope(
  body: unknown,
): ParseResult<OwnerActionRequest> {
  if (!isRecord(body)) return fail("Body must be a JSON object.");

  const signature = body["signature"];
  if (typeof signature !== "string" || !isHex(signature)) {
    return fail(`"signature" must be a 0x-prefixed hex string.`);
  }

  const raw = body["signed"];
  if (!isRecord(raw)) return fail(`"signed" must be a JSON object.`);

  const owner = readAddress(raw["owner"], "signed.owner");
  if (!owner.ok) return owner;

  const agentId = readString(raw, "agentId", MAX_AGENT_ID_CHARS);
  if (!agentId.ok) return agentId;

  const action = raw["action"];
  if (typeof action !== "string" || action.length === 0 || action.length > 32) {
    return fail(`"signed.action" must be a short non-empty string.`);
  }

  const paramsHashValue = raw["paramsHash"];
  if (typeof paramsHashValue !== "string" || !isBytes32(paramsHashValue)) {
    return fail(`"signed.paramsHash" must be a bytes32 hex string.`);
  }

  const nonce = raw["nonce"];
  if (typeof nonce !== "string" || !isBytes32(nonce)) {
    return fail(`"signed.nonce" must be a bytes32 hex string.`);
  }

  const issuedAt = readBigint(raw["issuedAt"], "signed.issuedAt");
  if (!issuedAt.ok) return issuedAt;
  const expiry = readBigint(raw["expiry"], "signed.expiry");
  if (!expiry.ok) return expiry;

  const signed: OwnerActionStruct = {
    owner: owner.value,
    agentId: agentId.value,
    // The verifier owns the action allowlist; an unknown string is rejected
    // there, with the same generic error every other auth failure produces.
    action: action as OwnerActionType,
    paramsHash: paramsHashValue,
    nonce,
    issuedAt: issuedAt.value,
    expiry: expiry.value,
  };

  return {
    ok: true,
    value: { signed, signature, params: body["params"] },
  };
}

/** Longest agent id this service accepts anywhere. */
export const MAX_AGENT_ID_CHARS = 128;

function isBytes32(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Decode an owner-action envelope carried in a header.
 *
 * Owner reads are GETs, and a signature does not belong in a URL: query strings
 * land in access logs, proxy logs and browser history. The envelope therefore
 * travels base64url-encoded in a header instead, which keeps GET semantics
 * without writing an authorization credential somewhere it will be retained.
 */
export function decodeOwnerActionHeader(
  header: string | undefined,
): ParseResult<OwnerActionRequest> {
  if (header === undefined || header.trim() === "") {
    return fail("Missing owner-action header.");
  }
  if (header.length > MAX_OWNER_ENVELOPE_CHARS) {
    return fail("Owner-action header is too large.");
  }
  let json: string;
  try {
    json = Buffer.from(header, "base64url").toString("utf8");
  } catch {
    return fail("Owner-action header is not valid base64url.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("Owner-action header is not valid JSON.");
  }
  return parseOwnerActionEnvelope(parsed);
}

/* -------------------------------------------------------------------------- */
/* Route params                                                               */
/* -------------------------------------------------------------------------- */

/** Interpret `changeBudget` params AFTER the signature has been verified. */
export function parseBudgetParams(params: unknown): ParseResult<AgentCaps> {
  if (!isRecord(params)) return fail("Budget params must be a JSON object.");

  let dailyNativeWei: bigint | undefined;
  if (params["dailyNativeWei"] !== undefined && params["dailyNativeWei"] !== null) {
    const parsed = readBigint(params["dailyNativeWei"], "dailyNativeWei");
    if (!parsed.ok) return parsed;
    dailyNativeWei = parsed.value;
  }

  let perTradeNativeWei: bigint | undefined;
  if (params["perTradeNativeWei"] !== undefined && params["perTradeNativeWei"] !== null) {
    const parsed = readBigint(params["perTradeNativeWei"], "perTradeNativeWei");
    if (!parsed.ok) return parsed;
    perTradeNativeWei = parsed.value;
  }

  if (dailyNativeWei === undefined && perTradeNativeWei === undefined) {
    return fail("Budget params must set at least one cap.");
  }

  return {
    ok: true,
    value: {
      ...(dailyNativeWei === undefined ? {} : { dailyNativeWei }),
      ...(perTradeNativeWei === undefined ? {} : { perTradeNativeWei }),
    },
  };
}

/** An admin action's audit fields. Recorded so a halt has a name attached. */
export type AdminRequest = {
  readonly actor: string;
  readonly reason?: string;
};

export function parseAdminRequest(body: unknown): ParseResult<AdminRequest> {
  if (!isRecord(body)) return fail("Body must be a JSON object.");
  const actor = readString(body, "actor", 64);
  if (!actor.ok) return actor;

  const rawReason = body["reason"];
  if (rawReason === undefined || rawReason === null) {
    return { ok: true, value: { actor: actor.value } };
  }
  if (typeof rawReason !== "string" || rawReason.length > 300) {
    return fail(`"reason" must be a string of at most 300 characters.`);
  }
  return { ok: true, value: { actor: actor.value, reason: rawReason } };
}

/* -------------------------------------------------------------------------- */
/* Response views                                                             */
/* -------------------------------------------------------------------------- */

function capsView(caps: AgentCaps | null): Record<string, string> | null {
  if (caps === null) return null;
  return {
    ...(caps.dailyNativeWei === undefined
      ? {}
      : { dailyNativeWei: caps.dailyNativeWei.toString(10) }),
    ...(caps.perTradeNativeWei === undefined
      ? {}
      : { perTradeNativeWei: caps.perTradeNativeWei.toString(10) }),
  };
}

/**
 * What the trusted runtime is shown: enough to decide whether to submit, and
 * nothing about the owner's other holdings.
 *
 * The session PUBLIC key is included — it is public by construction and is what a
 * caller needs to verify a revocation landed. The session PRIVATE key is not
 * reachable from an `AgentRecord` at all; it lives in its own column behind
 * `getAgentSessionKey`, which no route calls.
 */
export function agentRuntimeView(agent: AgentRecord): Record<string, unknown> {
  return {
    id: agent.id,
    ownerAddress: agent.ownerAddress,
    httpRuntimeProfile: agent.httpRuntimeProfile,
    walletAddress: agent.walletAddress,
    custodyModel: agent.custodyModel,
    status: agent.status,
    session:
      agent.sessionFacts === null
        ? null
        : {
            publicKey: agent.sessionFacts.publicKey,
            expiresAt: agent.sessionFacts.expiry,
          },
    updatedAt: agent.updatedAt,
  };
}

/**
 * The live on-chain native meter, as the OWNER is shown it (PHASE2.5 F4).
 *
 * Three states, and they are kept distinguishable on purpose because the owner
 * acts differently on each:
 *
 *   - `readable: false` — the meter could not be read. Buys are refused right
 *     now (the gate fails closed on the exposure-increasing side), and the fix
 *     is an RPC one, not a cap one.
 *   - `metered: false` — the account enforces no daily native limit for this
 *     key. There is no headroom to run out of, so nothing gates the buys.
 *   - the full reading — every figure the gate used, including the shortfall
 *     when it is refusing.
 */
export type OwnerNativeMeterView =
  | { readonly readable: false; readonly buysRefused: true; readonly note: string }
  | {
      readonly readable: true;
      readonly metered: false;
      /**
       * Whether the session has a native spend grant AT ALL, at any period.
       *
       * PHASE2.5-AUDIT A6: `metered: false` alone covered two opposite accounts
       * — "today is unmetered, nothing is gated" and "this key cannot spend
       * native at all, every buy will revert in simulation" (FINDINGS (h)) — and
       * the view rendered the reassuring sentence for both.
       */
      readonly nativeGranted: boolean;
      readonly buysRefused: false;
      readonly note: string;
    }
  | {
      readonly readable: true;
      readonly metered: true;
      readonly limitWei: bigint;
      readonly currentSpentWei: bigint;
      /** May be NEGATIVE when a cap was lowered below the period's spend. */
      readonly remainingWei: bigint;
      /** True when {@link remainingWei} is negative (PHASE2.5-AUDIT A10). */
      readonly overCap: boolean;
      readonly grantedTokenCount: number;
      readonly reserveWei: bigint;
      readonly ownFeeWei: bigint;
      readonly requiredWei: bigint;
      readonly shortfallWei: bigint;
      /**
       * The largest trade the gate would still authorise, in native wei.
       *
       * The number a UI should render as spendable. `remainingWei` is NOT that
       * number — it includes the reserve the exit needs and the relay fee the
       * next submission owes (PHASE2.5-AUDIT A1).
       */
      readonly headroomForSubmissionWei: bigint;
      readonly buysRefused: boolean;
      readonly note?: string;
    };

/** Render one meter view, bigints as decimal strings like every other figure. */
function nativeMeterView(meter: OwnerNativeMeterView): Record<string, unknown> {
  if (!meter.readable || !meter.metered) return { ...meter };
  return {
    readable: true,
    metered: true,
    limitWei: meter.limitWei.toString(10),
    currentSpentWei: meter.currentSpentWei.toString(10),
    remainingWei: meter.remainingWei.toString(10),
    overCap: meter.overCap,
    grantedTokenCount: meter.grantedTokenCount,
    reserveWei: meter.reserveWei.toString(10),
    ownFeeWei: meter.ownFeeWei.toString(10),
    requiredWei: meter.requiredWei.toString(10),
    shortfallWei: meter.shortfallWei.toString(10),
    headroomForSubmissionWei: meter.headroomForSubmissionWei.toString(10),
    buysRefused: meter.buysRefused,
    ...(meter.note === undefined ? {} : { note: meter.note }),
  };
}

/**
 * What the owner is shown: their own agent, in full, minus anything secret.
 *
 * `nativeMeter` is OPTIONAL and absent when the caller did not read one — a
 * mutation's echo of the agent, or a provider with no meter capability. Absent
 * means "not asked", never "fine": a field that renders as healthy when nothing
 * was measured is how a dashboard lies (PHASE3.3-AUDIT A3).
 */
export function agentOwnerView(
  agent: AgentRecord,
  nativeMeter?: OwnerNativeMeterView,
): Record<string, unknown> {
  return {
    ...(identityOwnerView(agent.erc8004Identity) === undefined ? {} : { erc8004Identity: identityOwnerView(agent.erc8004Identity) }),
    ...(nativeMeter === undefined ? {} : { nativeMeter: nativeMeterView(nativeMeter) }),
    id: agent.id,
    ownerAddress: agent.ownerAddress,
    /**
     * Whether `ownerAddress` is an account that can hold value (PHASE1.5 R2d).
     *
     * ADDITIVE rather than a rename, so no existing client breaks. It exists
     * because under `passkey` custody `ownerAddress` is an off-chain IDENTITY
     * derived from a P256 credential — no secp256k1 key exists for it, and value
     * sent there is burned. A UI that renders an address next to a "withdraw
     * to owner" button must be able to tell the two apart without knowing what
     * a custody model is; leaving that inference to the UI is how funds get
     * burned by a correct-looking screen.
     */
    ownerAddressIsPayable: agent.custodyModel !== "passkey",
    walletAddress: agent.walletAddress,
    custodyModel: agent.custodyModel,
    status: agent.status,
    httpRuntimeProfile: agent.httpRuntimeProfile,
    // AUDIT H3: product kind follows the immutable S1 discriminator, never runtime-route binding.
    hireSizing: agent.sessionFacts?.hireSizing ?? null,
    caps: capsView(agent.caps),
    session:
      agent.sessionFacts === null
        ? null
        : {
            publicKey: agent.sessionFacts.publicKey,
            expiresAt: agent.sessionFacts.expiry,
            allowedCalls: agent.sessionFacts.spec.allowedCalls.map((rule) => ({
              ...(rule.to === undefined ? {} : { to: rule.to }),
              ...(rule.selector === undefined ? {} : { selector: rule.selector }),
            })),
            spendCaps: agent.sessionFacts.spec.spendCaps.map((cap) => ({
              limit: cap.limit.toString(10),
              period: cap.period,
              ...(cap.token === undefined ? {} : { token: cap.token }),
            })),
          },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export type ProvisioningMissing =
  | "account-key"
  | "permissions-differ"
  | "keystore-id"
  | "keystore-pubkey"
  | "wallet-not-registered"
  | "wallet-owner-mismatch"
  | "evidence-unreadable"
  | "expired";

/** Explicit non-secret projection of pending-grant state. */
export function provisioningView(
  agent: AgentRecord,
  nowSec: number,
  missing: readonly ProvisioningMissing[] = [],
  options: { readonly revocationRequired?: boolean; readonly onChainRevoke?: unknown;
    readonly activationError?: "wallet_in_use" | "settings_conflict" } = {},
): Record<string, unknown> {
  if (agent.status === "armed") {
    return {
      status: "armed",
      agent: agentOwnerView(agent),
      hireSizing: agent.sessionFacts?.hireSizing ?? null,
      ...(agent.sessionFacts?.hireRunId === undefined ? {} : { hireRunId: agent.sessionFacts.hireRunId }),
    };
  }
  const pending = agent.pendingGrant;
  if (pending === null) return { status: agent.status };
  return {
    status: agent.status,
    sessionAddress: pending.sessionAddress,
    sessionPublicKey: pending.sessionPublicKey,
    accountKeyHash: pending.accountKeyHash,
    keyStoreKeyId: pending.keyStoreKeyId,
    permissions: {
      calls: pending.permissions.calls.map((row) => ({
        ...(!("to" in row) ? {} : { to: row.to }),
        ...(!("signature" in row) ? {} : { signature: row.signature }),
      })),
      spend: pending.permissions.spend.map((row) => ({
        ...(row.token === undefined ? {} : { token: row.token }),
        period: row.period,
        limit: row.limit.toString(10),
      })),
    },
    expiresAt: pending.expiresAt,
    funding: pending.funding,
    sizing: pending.sizing,
    ...(pending.hireRunId === undefined ? {} : { hireRunId: pending.hireRunId }),
    ...(pending.grantAttempt === undefined ? {} : { grantAttempt: pending.grantAttempt }),
    missing: [...missing],
    ...(missing.includes("permissions-differ")
      ? { remedy: "revoke the session on chain and hire again" }
      : {}),
    cancelRequested: validProvisioningCancellation(agent, nowSec),
    ...(options.revocationRequired === true ? { revocationRequired: true } : {}),
    ...(options.onChainRevoke === undefined ? {} : { onChainRevoke: options.onChainRevoke }),
    ...(options.activationError === undefined ? {} : { activationError: options.activationError }),
  };
}
