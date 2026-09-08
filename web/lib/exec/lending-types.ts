/**
 * Hand-written DTOs for the lending guard, and non-throwing parsers for them.
 *
 * `web/` NEVER imports from `../src/` (CLAUDE.md §"Marketplace UI"), so these
 * shapes MIRROR `src/http/lendingWire.ts` by hand and are checked against what
 * the plane actually emits rather than against a shared type. Every bigint
 * crosses as a DECIMAL STRING — the LP detail page's rule — so a JSON round trip
 * can never silently truncate a reserve.
 *
 * ── PARSE, DO NOT TRUST ─────────────────────────────────────────────────────
 * Every `parse*` returns `T | INVALID` and throws nothing. A malformed payload
 * must dash a tile with a reason, never blank the page and never render a
 * number nobody sourced (the dash-with-reason rule).
 *
 * ── ONE DIVERGENCE FROM THE PLANE'S OWN DOC COMMENT, DELIBERATE ─────────────
 * `src/http/lendingWire.ts` documents `LendingAgentView` as a FLAT object with
 * top-level `account`, `reserve`, `conditions` and `usage`. The route
 * (`GET /agents/:id/lending/view`, `src/server.ts`) does NOT emit that shape: it
 * emits `guard`, `snapshot` (with the worker's payload nested under
 * `snapshot.payload`, `null` while stale), `rescues`, `settings`,
 * `settingsDigest`, `session` and `recovery`. These DTOs describe the ROUTE,
 * because the route is what the browser receives. The divergence is recorded as
 * an open item in the build report; nothing here changes the plane.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** The single failure value every parser returns. Never thrown. */
import { parseLendingPortfolio } from "./lending-portfolio";
export const INVALID = "invalid" as const;
export type Invalid = typeof INVALID;

const DECIMAL = /^\d{1,78}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;

type Row = Record<string, unknown>;

function row(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function decimal(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

function nullableDecimal(value: unknown): string | null | typeof INVALID {
  if (value === null) return null;
  const parsed = decimal(value);
  return parsed === null ? INVALID : parsed;
}

function address(value: unknown): string | null {
  return typeof value === "string" && ADDRESS.test(value) ? value : null;
}

function hash(value: unknown): string | null {
  return typeof value === "string" && HASH.test(value) ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Wei as a bigint, or `null` when the string is not a wei amount. */
export function weiOrNull(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Owner action names — exactly the plane's `OWNER_ACTIONS` members            */
/* -------------------------------------------------------------------------- */

/**
 * The three owner actions this surface signs.
 *
 * They must equal `src/auth/ownerAuth.ts`'s `OWNER_ACTIONS` members byte for
 * byte: the action string is hashed INTO the EIP-712 message
 * (`paramsHash(action, params)` plus the `action` field itself), so a typo is a
 * generic 401 with no diagnostic. `owner-action.ts`'s `OWNER_ACTION_TYPES`
 * struct is NOT touched by this phase — the envelope is unchanged.
 */
export const LENDING_ACTIONS = {
  arm: "lendingArm",
  settings: "lendingSettings",
  retire: "lendingRetire",
} as const;

export type LendingActionName = (typeof LENDING_ACTIONS)[keyof typeof LENDING_ACTIONS];

/* -------------------------------------------------------------------------- */
/* /lending/config and /lending/quote                                         */
/* -------------------------------------------------------------------------- */

/**
 * `GET /lending/config` — the venue the passkey recovery batch is built against.
 *
 * The browser MUST NOT hardcode any of it: the router, the vToken and the fee
 * tier are boot config an operator can move, and a recovery batch built against
 * a stale copy would approve the wrong spender.
 */
export type LendingConfigView = {
  readonly chainId: 56;
  readonly vUsdt: string;
  readonly usdt: string;
  readonly vBnb: string;
  readonly routerV3: string;
  readonly wbnb: string;
  readonly quoterV2: string;
  readonly swapFeeTier: number;
  readonly maxSagaSlippageBps: number;
  readonly dustUsdtWei: string;
  readonly maxMarkets: number;
  /**
   * The guard worker's configured cadence, when this deployment publishes it.
   *
   * OPTIONAL by contract: the plane is adding it separately, and a deployment
   * that never sends it must render exactly as it does today. Absent, or not a
   * positive whole number of milliseconds, is the SAME case — the hire form
   * says "the operator's configured cadence" and quotes no figure nobody read.
   */
  readonly workerIntervalMs?: number;
};

export function parseLendingConfig(value: unknown): LendingConfigView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const vUsdt = address(data["vUsdt"]);
  const usdt = address(data["usdt"]);
  const vBnb = address(data["vBnb"]);
  const routerV3 = address(data["routerV3"]);
  const wbnb = address(data["wbnb"]);
  const quoterV2 = address(data["quoterV2"]);
  const swapFeeTier = integer(data["swapFeeTier"]);
  const slippage = integer(data["maxSagaSlippageBps"]);
  const dust = decimal(data["dustUsdtWei"]);
  const maxMarkets = integer(data["maxMarkets"]);
  if (data["chainId"] !== 56 || vUsdt === null || usdt === null || vBnb === null
    || routerV3 === null || wbnb === null || quoterV2 === null
    || swapFeeTier === null || swapFeeTier <= 0
    || slippage === null || slippage < 0 || slippage > 10_000
    || dust === null || maxMarkets === null || maxMarkets <= 0) return INVALID;
  // OPTIONAL, and never a reason to reject the read: an absent, malformed or
  // non-positive interval is simply not carried forward.
  const workerIntervalMs = integer(data["workerIntervalMs"]);
  return {
    chainId: 56, vUsdt, usdt, vBnb, routerV3, wbnb, quoterV2,
    swapFeeTier, maxSagaSlippageBps: slippage, dustUsdtWei: dust, maxMarkets,
    ...(workerIntervalMs === null || workerIntervalMs <= 0 ? {} : { workerIntervalMs }),
  };
}

/**
 * `GET /lending/quote` — a QuoterV2 read THROUGH the plane.
 *
 * `minOutWei` is the plane's own rail (`sagaSwapMinOut` at the boot slippage),
 * and the browser uses it verbatim. A DATA-PLANE PRICE IS NOT A QUOTE and must
 * never stand in for this (R3.9 / L4).
 */
export type LendingQuoteView = {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly fee: number;
  readonly amountInWei: string;
  readonly quotedOutWei: string;
  readonly minOutWei: string;
  readonly maxSagaSlippageBps: number;
};

export function parseLendingQuote(value: unknown): LendingQuoteView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const tokenIn = address(data["tokenIn"]);
  const tokenOut = address(data["tokenOut"]);
  const fee = integer(data["fee"]);
  const amountInWei = decimal(data["amountInWei"]);
  const quotedOutWei = decimal(data["quotedOutWei"]);
  const minOutWei = decimal(data["minOutWei"]);
  const slippage = integer(data["maxSagaSlippageBps"]);
  if (tokenIn === null || tokenOut === null || fee === null || amountInWei === null
    || quotedOutWei === null || minOutWei === null || slippage === null) return INVALID;
  return { tokenIn, tokenOut, fee, amountInWei, quotedOutWei, minOutWei, maxSagaSlippageBps: slippage };
}

/* -------------------------------------------------------------------------- */
/* /lending/guardable                                                         */
/* -------------------------------------------------------------------------- */

export type LendingMarketView = {
  readonly vToken: string;
  readonly symbol: string;
  readonly underlying: string | null;
  readonly underlyingDecimals: number;
  readonly supplyUnderlyingWei: string;
  readonly borrowWei: string;
  readonly isCollateral: boolean;
  readonly collateralFactor: string;
  readonly liquidationThreshold: string;
  readonly priceMantissa: string;
};

export type LendingDebtView = {
  readonly vToken: string;
  readonly symbol: string;
  readonly borrowWei: string;
  readonly debtValueMantissa: string;
  /** Whether v1 can repay it at all (vUSDT / vBNB only). */
  readonly supported: boolean;
  readonly reason?: "unsupported-in-v1";
};

export type LendingBasisView = { readonly hf: string | null; readonly matched: boolean };

export type LendingBasesView = {
  readonly borrowingPower: LendingBasisView;
  readonly liquidation: LendingBasisView;
};

/** The receipt-mode sizing block. Absent in display mode. */
export type LendingGuardableSizing = {
  readonly reserveCapFloorWei: string;
  readonly minimumCapDayWei: string;
  readonly mintUsdtWei: string;
  readonly reserveNativeWei: string;
  readonly supplyNativeWei: string;
  readonly ok: boolean;
  readonly refusal?: string;
};

export const LENDING_GUARDABLE_REFUSALS = [
  "no-debt",
  "no-supported-debt",
  "protocol-mismatch",
  "emode-unverified",
  "oracle-invalid",
  "protocol-error",
  "snapshot-error",
  "account-too-complex",
] as const;

export type LendingGuardableRefusal = (typeof LENDING_GUARDABLE_REFUSALS)[number];

export type LendingGuardableView = {
  readonly account: string;
  readonly blockNumber: string;
  readonly bases: LendingBasesView;
  readonly markets: readonly LendingMarketView[];
  readonly debts: readonly LendingDebtView[];
  readonly guardable: boolean;
  readonly refusal?: LendingGuardableRefusal;
  readonly refusalMarket?: string;
  readonly sizing?: LendingGuardableSizing;
  /** Opaque to the browser; it only carries it back into the S1 envelope. */
  readonly previewReceipt?: string;
  readonly expiresAtSec?: number;
  readonly note?: string;
};

function parseBasis(value: unknown): LendingBasisView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const hf = nullableDecimal(data["hf"]);
  const matched = bool(data["matched"]);
  if (hf === INVALID || matched === null) return INVALID;
  return { hf, matched };
}

function parseMarket(value: unknown): LendingMarketView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const vToken = address(data["vToken"]);
  const symbol = text(data["symbol"]);
  const underlying = data["underlying"] === null ? null : address(data["underlying"]);
  const decimals = integer(data["underlyingDecimals"]);
  const supply = decimal(data["supplyUnderlyingWei"]);
  const borrow = decimal(data["borrowWei"]);
  const isCollateral = bool(data["isCollateral"]);
  const cf = decimal(data["collateralFactor"]);
  const lt = decimal(data["liquidationThreshold"]);
  const price = decimal(data["priceMantissa"]);
  if (vToken === null || symbol === null || decimals === null || decimals < 0 || decimals > 36
    || supply === null || borrow === null || isCollateral === null
    || cf === null || lt === null || price === null) return INVALID;
  if (data["underlying"] !== null && underlying === null) return INVALID;
  return {
    vToken, symbol, underlying, underlyingDecimals: decimals,
    supplyUnderlyingWei: supply, borrowWei: borrow, isCollateral,
    collateralFactor: cf, liquidationThreshold: lt, priceMantissa: price,
  };
}

function parseDebt(value: unknown): LendingDebtView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const vToken = address(data["vToken"]);
  const symbol = text(data["symbol"]);
  const borrow = decimal(data["borrowWei"]);
  const debtValue = decimal(data["debtValueMantissa"]);
  const supported = bool(data["supported"]);
  if (vToken === null || symbol === null || borrow === null
    || debtValue === null || supported === null) return INVALID;
  const reason = data["reason"];
  if (reason !== undefined && reason !== "unsupported-in-v1") return INVALID;
  return {
    vToken, symbol, borrowWei: borrow, debtValueMantissa: debtValue, supported,
    ...(reason === "unsupported-in-v1" ? { reason } : {}),
  };
}

function parseSizing(value: unknown): LendingGuardableSizing | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const floor = decimal(data["reserveCapFloorWei"]);
  const capDay = decimal(data["minimumCapDayWei"]);
  const mint = decimal(data["mintUsdtWei"]);
  const reserve = decimal(data["reserveNativeWei"]);
  const supply = decimal(data["supplyNativeWei"]);
  const ok = bool(data["ok"]);
  if (floor === null || capDay === null || mint === null
    || reserve === null || supply === null || ok === null) return INVALID;
  const refusal = data["refusal"];
  if (refusal !== undefined && typeof refusal !== "string") return INVALID;
  return {
    reserveCapFloorWei: floor, minimumCapDayWei: capDay, mintUsdtWei: mint,
    reserveNativeWei: reserve, supplyNativeWei: supply, ok,
    ...(typeof refusal === "string" ? { refusal } : {}),
  };
}

export function parseLendingGuardable(value: unknown): LendingGuardableView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const account = address(data["account"]);
  const blockNumber = decimal(data["blockNumber"]);
  const guardable = bool(data["guardable"]);
  if (account === null || blockNumber === null || guardable === null) return INVALID;
  const basesRow = row(data["bases"]);
  if (basesRow === null) return INVALID;
  const borrowingPower = parseBasis(basesRow["borrowingPower"]);
  const liquidation = parseBasis(basesRow["liquidation"]);
  if (borrowingPower === INVALID || liquidation === INVALID) return INVALID;
  if (!Array.isArray(data["markets"]) || !Array.isArray(data["debts"])) return INVALID;
  const markets: LendingMarketView[] = [];
  for (const entry of data["markets"]) {
    const market = parseMarket(entry);
    if (market === INVALID) return INVALID;
    markets.push(market);
  }
  const debts: LendingDebtView[] = [];
  for (const entry of data["debts"]) {
    const debt = parseDebt(entry);
    if (debt === INVALID) return INVALID;
    debts.push(debt);
  }
  const refusal = data["refusal"];
  if (refusal !== undefined
    && !LENDING_GUARDABLE_REFUSALS.some((known) => known === refusal)) return INVALID;
  const refusalMarket = data["refusalMarket"] === undefined
    ? undefined : address(data["refusalMarket"]);
  if (data["refusalMarket"] !== undefined && refusalMarket === null) return INVALID;
  let sizing: LendingGuardableSizing | undefined;
  if (data["sizing"] !== undefined) {
    const parsed = parseSizing(data["sizing"]);
    if (parsed === INVALID) return INVALID;
    sizing = parsed;
  }
  const receipt = data["previewReceipt"];
  if (receipt !== undefined && (typeof receipt !== "string" || receipt.length === 0
    || receipt.length > 1024)) return INVALID;
  const expiresAtSec = data["expiresAtSec"] === undefined
    ? undefined : integer(data["expiresAtSec"]);
  if (data["expiresAtSec"] !== undefined && expiresAtSec === null) return INVALID;
  const note = data["note"];
  if (note !== undefined && typeof note !== "string") return INVALID;
  return {
    account, blockNumber,
    bases: { borrowingPower, liquidation },
    markets, debts, guardable,
    ...(refusal === undefined ? {} : { refusal: refusal as LendingGuardableRefusal }),
    ...(refusalMarket === undefined || refusalMarket === null ? {} : { refusalMarket }),
    ...(sizing === undefined ? {} : { sizing }),
    ...(typeof receipt === "string" ? { previewReceipt: receipt } : {}),
    ...(expiresAtSec === undefined || expiresAtSec === null ? {} : { expiresAtSec }),
    ...(typeof note === "string" ? { note } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export type LendingPerActionCapView = {
  /** `null` means NATIVE BNB (the vBNB market). */
  readonly token: string | null;
  readonly maxWei: string;
};

export type LendingSettingsView = {
  readonly triggerHf: string;
  readonly targetHf: string;
  readonly maxPerAction: readonly LendingPerActionCapView[];
  readonly minSecondsBetweenActions: number;
  readonly rescueReserveCount: number;
  readonly notifyOnlyBelowHf: string | null;
};

/** Mirrors `src/http/lendingWire.ts`'s bounds so the form refuses before signing. */
export const LENDING_TRIGGER_HF_MIN = 1_050_000_000_000_000_000n;
export const LENDING_TRIGGER_HF_MAX = 3_000_000_000_000_000_000n;
export const LENDING_TARGET_HF_BAND = 50_000_000_000_000_000n;
export const LENDING_MIN_SECONDS_BETWEEN_ACTIONS = 300;
export const LENDING_RESCUE_RESERVE_COUNT_MIN = 1;
export const LENDING_RESCUE_RESERVE_COUNT_MAX = 24;
export const LENDING_RESERVE_BPS_MIN = 1_000;
export const LENDING_RESERVE_BPS_MAX = 5_000;
export const LENDING_RESERVE_BPS_DEFAULT = 2_000;
/** The operator's ruling of 2026-09-06 (spec §0.6 / OQ2), not the mock's 1.18/1.60. */
export const LENDING_DEFAULT_TRIGGER_HF = 1.2;
export const LENDING_DEFAULT_TARGET_HF = 1.5;

export function parseLendingSettingsView(value: unknown): LendingSettingsView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const trigger = decimal(data["triggerHf"]);
  const target = decimal(data["targetHf"]);
  const minSeconds = integer(data["minSecondsBetweenActions"]);
  const count = integer(data["rescueReserveCount"]);
  const notify = nullableDecimal(data["notifyOnlyBelowHf"]);
  if (trigger === null || target === null || minSeconds === null
    || count === null || notify === INVALID) return INVALID;
  if (!Array.isArray(data["maxPerAction"])) return INVALID;
  const caps: LendingPerActionCapView[] = [];
  for (const entry of data["maxPerAction"]) {
    const cap = row(entry);
    if (cap === null) return INVALID;
    const token = cap["token"] === null ? null : address(cap["token"]);
    const maxWei = decimal(cap["maxWei"]);
    if (maxWei === null) return INVALID;
    if (cap["token"] !== null && token === null) return INVALID;
    caps.push({ token, maxWei });
  }
  return {
    triggerHf: trigger, targetHf: target, maxPerAction: caps,
    minSecondsBetweenActions: minSeconds, rescueReserveCount: count,
    notifyOnlyBelowHf: notify,
  };
}

/* -------------------------------------------------------------------------- */
/* The guard row                                                              */
/* -------------------------------------------------------------------------- */

export const LENDING_GUARD_STATUSES = [
  "provisioning-guard", "arming", "armed", "held", "retiring", "retired", "closed",
] as const;
export type LendingGuardStatus = (typeof LENDING_GUARD_STATUSES)[number];

export const LENDING_HOLDS = ["arm-unknown", "retire-unknown", "account-too-complex"] as const;
export type LendingHold = (typeof LENDING_HOLDS)[number];

export const LENDING_CLOSE_REASONS = [
  "arm-rolled-back", "arm-never-submitted", "retired", "recovered-by-owner",
] as const;
export type LendingCloseReason = (typeof LENDING_CLOSE_REASONS)[number];

export type LendingGuardView = {
  readonly status: LendingGuardStatus;
  readonly hold: LendingHold | null;
  readonly guardedAccount: string;
  readonly debtMarkets: readonly string[];
  readonly reserveBps: number;
  readonly budgetWei: string;
  readonly reserveCapWei: string;
  readonly armTxHash: string | null;
  readonly armBlock: string | null;
  /**
   * WHICH block `armBlock` is (plane FIXREVIEW F7), carried so the run-log
   * timeline can say what the number proves: `"receipt"` = the block the arm's
   * transaction landed in; `"post-arm-read"` = the finalized block of a read
   * taken afterwards, which proves the arm was OBSERVED and nothing about when
   * it happened. Additive and nullable — a deployment that does not send it
   * renders exactly as before.
   */
  readonly armBlockSource: "receipt" | "post-arm-read" | null;
  readonly closeReason: LendingCloseReason | null;
  readonly actionSeq: number;
  readonly lastActionAtMs: number | null;
  readonly updatedAtMs: number;
};

function parseGuard(value: unknown): LendingGuardView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const status = LENDING_GUARD_STATUSES.find((known) => known === data["status"]);
  if (status === undefined) return INVALID;
  const hold = data["hold"] === null
    ? null : LENDING_HOLDS.find((known) => known === data["hold"]);
  if (hold === undefined) return INVALID;
  const guardedAccount = address(data["guardedAccount"]);
  const budgetWei = decimal(data["budgetWei"]);
  const reserveCapWei = decimal(data["reserveCapWei"]);
  const reserveBps = integer(data["reserveBps"]);
  const actionSeq = integer(data["actionSeq"]);
  const updatedAtMs = integer(data["updatedAtMs"]);
  if (guardedAccount === null || budgetWei === null || reserveCapWei === null
    || reserveBps === null || actionSeq === null || updatedAtMs === null) return INVALID;
  if (!Array.isArray(data["debtMarkets"])) return INVALID;
  const debtMarkets: string[] = [];
  for (const entry of data["debtMarkets"]) {
    const market = address(entry);
    if (market === null) return INVALID;
    debtMarkets.push(market);
  }
  const armTxHash = data["armTxHash"] === null ? null : hash(data["armTxHash"]);
  if (data["armTxHash"] !== null && armTxHash === null) return INVALID;
  const armBlock = nullableDecimal(data["armBlock"]);
  if (armBlock === INVALID) return INVALID;
  // Additive: absent, null or unrecognized is the SAME case — no claim about
  // which block `armBlock` is. It never rejects the guard row.
  const armBlockSource = data["armBlockSource"] === "receipt" ? "receipt" as const
    : data["armBlockSource"] === "post-arm-read" ? "post-arm-read" as const
      : null;
  const closeReason = data["closeReason"] === null
    ? null : LENDING_CLOSE_REASONS.find((known) => known === data["closeReason"]);
  if (closeReason === undefined) return INVALID;
  const lastActionAtMs = data["lastActionAtMs"] === null
    ? null : integer(data["lastActionAtMs"]);
  if (data["lastActionAtMs"] !== null && lastActionAtMs === null) return INVALID;
  return {
    status, hold, guardedAccount, debtMarkets, reserveBps, budgetWei, reserveCapWei,
    armTxHash, armBlock, armBlockSource, closeReason, actionSeq, lastActionAtMs, updatedAtMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Conditions and rescues                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The plane's CLOSED condition taxonomy (`src/lending/types.ts`).
 *
 * Re-declared rather than imported, and deliberately CLOSED here too: a
 * condition the browser does not recognize is rendered under its own raw name
 * with a "not recognized by this page" note, never silently dropped.
 */
export const LENDING_CONDITIONS = [
  "hf-above-trigger", "awaiting-confirmation", "observation-stale", "protocol-mismatch",
  "emode-unverified", "snapshot-error", "protocol-error", "protocol-paused",
  "action-paused", "oracle-invalid", "position-liquidated", "no-effect", "cooldown",
  "killswitch", "session-expiring", "session-expired-or-revoked", "unknown-held",
  "transport", "settings-absent", "market-not-in-grant", "market-delisted",
  "insufficient-wallet-balance",
  "guarded-no-debt", "unsupported-debt", "reserve-low", "reserve-depleted",
  "pool-cash-low", "pool-cash-short", "arm-unknown", "retire-unknown",
  "insufficient-reserve", "usdt-cap-exhausted", "native-cap-exhausted",
  "cap-unreadable", "borrow-moved", "account-too-complex", "arm-never-submitted",
  "recovered-by-owner", "lending-disabled",
] as const;

export type LendingCondition = (typeof LENDING_CONDITIONS)[number];

export type LendingConditionReport = {
  /** The raw name. Known members are typed; an unknown one is kept verbatim. */
  readonly condition: string;
  readonly known: boolean;
  readonly detail: string;
  readonly market?: string;
};

function parseCondition(value: unknown): LendingConditionReport | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const condition = text(data["condition"]);
  const detail = text(data["detail"]);
  if (condition === null || detail === null) return INVALID;
  const market = data["market"] === undefined ? undefined : address(data["market"]);
  if (data["market"] !== undefined && market === null) return INVALID;
  return {
    condition,
    known: LENDING_CONDITIONS.some((known) => known === condition),
    detail,
    ...(market === undefined || market === null ? {} : { market }),
  };
}

export type LendingRescueView = {
  readonly rescueId: string;
  readonly market: string;
  readonly amountWei: string;
  readonly hfBefore: string | null;
  readonly hfAfter: string | null;
  readonly achievedHf: string | null;
  readonly txHash: string | null;
  readonly effect: "changed" | "no-effect" | "unverified";
  readonly partial: boolean;
  readonly conditions: readonly string[];
  readonly createdAtMs: number;
};

function parseRescue(value: unknown): LendingRescueView | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const rescueId = text(data["rescueId"]);
  const market = address(data["market"]);
  const amountWei = decimal(data["amountWei"]);
  const hfBefore = nullableDecimal(data["hfBefore"]);
  const hfAfter = nullableDecimal(data["hfAfter"]);
  const achievedHf = nullableDecimal(data["achievedHf"]);
  const createdAtMs = integer(data["createdAtMs"]);
  const partial = bool(data["partial"]);
  const effect = data["effect"];
  if (rescueId === null || market === null || amountWei === null
    || hfBefore === INVALID || hfAfter === INVALID || achievedHf === INVALID
    || createdAtMs === null || partial === null
    || (effect !== "changed" && effect !== "no-effect" && effect !== "unverified")) return INVALID;
  const txHash = data["txHash"] === null ? null : hash(data["txHash"]);
  if (data["txHash"] !== null && txHash === null) return INVALID;
  if (!Array.isArray(data["conditions"])) return INVALID;
  const conditions: string[] = [];
  for (const entry of data["conditions"]) {
    if (typeof entry !== "string") return INVALID;
    conditions.push(entry);
  }
  return {
    rescueId, market, amountWei, hfBefore, hfAfter, achievedHf, txHash,
    effect, partial, conditions, createdAtMs,
  };
}

/* -------------------------------------------------------------------------- */
/* The worker's snapshot payload                                              */
/* -------------------------------------------------------------------------- */

export type LendingReserveSnapshot = {
  readonly idleUsdtWei: string;
  readonly suppliedUsdtWei: string;
  readonly vUsdtBalance: string;
  readonly poolCashWei: string;
  readonly bnbTierWei: string;
  readonly nativeBalanceWei: string;
  readonly walletFloorWei: string;
  readonly usdtAllowanceToVUsdt: string;
  readonly usdtAllowanceToRouter: string;
};

export type LendingAccountSnapshot = {
  readonly blockNumber: string;
  readonly markets: readonly LendingMarketView[];
  readonly accountLiquidity: readonly string[];
  readonly borrowingPower: readonly string[];
  readonly vaiDebt: string;
};

export type LendingObservationSnapshot = {
  /** LIQUIDATION-basis health factor, 1e18 mantissa. The number the guard acts on. */
  readonly healthFactor: string | null;
  readonly breach: boolean;
  readonly consecutive: number;
  readonly evaluatedAtMs: number;
};

export type LendingSnapshotPayload = {
  readonly version: number;
  readonly account: LendingAccountSnapshot;
  readonly reserve: LendingReserveSnapshot;
  readonly conditions: readonly LendingConditionReport[];
  readonly usage: { readonly rescues: number; readonly lastRescueAtMs: number | null };
  readonly observation: LendingObservationSnapshot | null;
  readonly session: { readonly expiresAt: number | null };
};

function parseReserveSnapshot(value: unknown): LendingReserveSnapshot | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const keys = [
    "idleUsdtWei", "suppliedUsdtWei", "vUsdtBalance", "poolCashWei", "bnbTierWei",
    "nativeBalanceWei", "walletFloorWei", "usdtAllowanceToVUsdt", "usdtAllowanceToRouter",
  ] as const;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const parsed = decimal(data[key]);
    if (parsed === null) return INVALID;
    out[key] = parsed;
  }
  return out as unknown as LendingReserveSnapshot;
}

function parseAccountSnapshot(value: unknown): LendingAccountSnapshot | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const blockNumber = decimal(data["blockNumber"]);
  const vaiDebt = decimal(data["vaiDebt"]);
  if (blockNumber === null || vaiDebt === null) return INVALID;
  if (!Array.isArray(data["markets"]) || !Array.isArray(data["accountLiquidity"])
    || !Array.isArray(data["borrowingPower"])) return INVALID;
  const markets: LendingMarketView[] = [];
  for (const entry of data["markets"]) {
    const market = parseMarket(entry);
    if (market === INVALID) return INVALID;
    markets.push(market);
  }
  const numbers = (list: unknown[]): string[] | Invalid => {
    const out: string[] = [];
    for (const entry of list) {
      const parsed = decimal(entry);
      if (parsed === null) return INVALID;
      out.push(parsed);
    }
    return out;
  };
  const accountLiquidity = numbers(data["accountLiquidity"]);
  const borrowingPower = numbers(data["borrowingPower"]);
  if (accountLiquidity === INVALID || borrowingPower === INVALID) return INVALID;
  return { blockNumber, markets, accountLiquidity, borrowingPower, vaiDebt };
}

function parseSnapshotPayload(value: unknown): LendingSnapshotPayload | Invalid {
  const data = row(value);
  if (data === null) return INVALID;
  const version = integer(data["version"]);
  if (version === null) return INVALID;
  const account = parseAccountSnapshot(data["account"]);
  const reserve = parseReserveSnapshot(data["reserve"]);
  if (account === INVALID || reserve === INVALID) return INVALID;
  if (!Array.isArray(data["conditions"])) return INVALID;
  const conditions: LendingConditionReport[] = [];
  for (const entry of data["conditions"]) {
    const parsed = parseCondition(entry);
    if (parsed === INVALID) return INVALID;
    conditions.push(parsed);
  }
  const usageRow = row(data["usage"]);
  if (usageRow === null) return INVALID;
  const rescues = integer(usageRow["rescues"]);
  const lastRescueAtMs = usageRow["lastRescueAtMs"] === null
    ? null : integer(usageRow["lastRescueAtMs"]);
  if (rescues === null || (usageRow["lastRescueAtMs"] !== null && lastRescueAtMs === null)) {
    return INVALID;
  }
  let observation: LendingObservationSnapshot | null = null;
  if (data["observation"] !== null && data["observation"] !== undefined) {
    const obs = row(data["observation"]);
    if (obs === null) return INVALID;
    const healthFactor = nullableDecimal(obs["healthFactor"]);
    const breach = bool(obs["breach"]);
    const consecutive = integer(obs["consecutive"]);
    const evaluatedAtMs = integer(obs["evaluatedAtMs"]);
    if (healthFactor === INVALID || breach === null
      || consecutive === null || evaluatedAtMs === null) return INVALID;
    observation = { healthFactor, breach, consecutive, evaluatedAtMs };
  }
  const sessionRow = row(data["session"]);
  const expiresAt = sessionRow === null || sessionRow["expiresAt"] === null
    ? null : integer(sessionRow["expiresAt"]);
  return {
    version, account, reserve, conditions,
    usage: { rescues, lastRescueAtMs },
    observation,
    session: { expiresAt },
  };
}

/* -------------------------------------------------------------------------- */
/* GET /agents/:id/lending/view                                               */
/* -------------------------------------------------------------------------- */

export type LendingSnapshotEnvelope = {
  readonly presentAt: number | null;
  readonly ageMs: number | null;
  readonly staleAfterMs: number;
  readonly stale: boolean;
  /** Why a stale snapshot is stale. THIS is the dash's reason, verbatim. */
  readonly reason: string | null;
  readonly workerIntervalMs: number;
  /** `null` while stale — the plane refuses to serve a guess. */
  readonly payload: LendingSnapshotPayload | null;
};

export type LendingAgentView = {
  readonly portfolio?: import("./lending-portfolio").LendingPortfolio | null;
  readonly guard: LendingGuardView;
  readonly snapshot: LendingSnapshotEnvelope;
  readonly rescues: readonly LendingRescueView[];
  readonly settings: LendingSettingsView | null;
  readonly settingsDigest: string | null;
  readonly session: { readonly expiresAt: number | null; readonly expiring: boolean };
  readonly recovery: { readonly note: string };
  /**
   * R2.18's stale-snapshot fallback, added BY THE BFF (never by the plane): the
   * guarded account read NOW, in display mode, so the account tiles have a
   * source while the guard tiles stay dashed. Labelled by
   * {@link LENDING_LIVE_ACCOUNT_LABEL} wherever it is rendered.
   */
  readonly liveAccount?: LendingGuardableView;
  /** Why the fallback is absent when the snapshot is stale. */
  readonly liveAccountReason?: string;
};

/** R2.18's label. A tile fed by this is NOT the agent's own observation. */
export const LENDING_LIVE_ACCOUNT_LABEL = "read now, not by the agent";

export function parseLendingAgentView(value: unknown): LendingAgentView | Invalid {
  const body = row(value);
  const data = row(body?.["data"]) ?? body;
  if (data === null) return INVALID;
  const guard = parseGuard(data["guard"]);
  if (guard === INVALID) return INVALID;
  const snapshotRow = row(data["snapshot"]);
  if (snapshotRow === null) return INVALID;
  const staleAfterMs = integer(snapshotRow["staleAfterMs"]);
  const workerIntervalMs = integer(snapshotRow["workerIntervalMs"]);
  const stale = bool(snapshotRow["stale"]);
  if (staleAfterMs === null || workerIntervalMs === null || stale === null) return INVALID;
  const presentAt = snapshotRow["presentAt"] === null ? null : integer(snapshotRow["presentAt"]);
  const ageMs = snapshotRow["ageMs"] === null ? null : integer(snapshotRow["ageMs"]);
  if ((snapshotRow["presentAt"] !== null && presentAt === null)
    || (snapshotRow["ageMs"] !== null && ageMs === null)) return INVALID;
  const reason = snapshotRow["reason"] === null ? null : text(snapshotRow["reason"]);
  if (snapshotRow["reason"] !== null && reason === null) return INVALID;
  let payload: LendingSnapshotPayload | null = null;
  if (snapshotRow["payload"] !== null && snapshotRow["payload"] !== undefined) {
    const parsed = parseSnapshotPayload(snapshotRow["payload"]);
    // A payload the browser cannot map is NOT a broken page: the guard row and
    // the rescue log still render, and every tile that needed the payload
    // dashes with this reason.
    payload = parsed === INVALID ? null : parsed;
  }
  if (!Array.isArray(data["rescues"])) return INVALID;
  const rescues: LendingRescueView[] = [];
  for (const entry of data["rescues"]) {
    const rescue = parseRescue(entry);
    if (rescue === INVALID) return INVALID;
    rescues.push(rescue);
  }
  let settings: LendingSettingsView | null = null;
  if (data["settings"] !== null && data["settings"] !== undefined) {
    const parsed = parseLendingSettingsView(data["settings"]);
    if (parsed === INVALID) return INVALID;
    settings = parsed;
  }
  const settingsDigest = data["settingsDigest"] === null || data["settingsDigest"] === undefined
    ? null : text(data["settingsDigest"]);
  const sessionRow = row(data["session"]);
  if (sessionRow === null) return INVALID;
  const expiresAt = sessionRow["expiresAt"] === null ? null : integer(sessionRow["expiresAt"]);
  const expiring = bool(sessionRow["expiring"]);
  if (expiring === null || (sessionRow["expiresAt"] !== null && expiresAt === null)) return INVALID;
  const recoveryRow = row(data["recovery"]);
  const note = recoveryRow === null ? null : text(recoveryRow["note"]);
  let liveAccount: LendingGuardableView | undefined;
  if (data["liveAccount"] !== null && data["liveAccount"] !== undefined) {
    const parsed = parseLendingGuardable(data["liveAccount"]);
    if (parsed !== INVALID) liveAccount = parsed;
  }
  const liveAccountReason = text(data["liveAccountReason"]);
  return {
    guard,
    snapshot: { presentAt, ageMs, staleAfterMs, stale, reason, workerIntervalMs, payload },
    ...(data["portfolio"] === undefined ? {} : { portfolio: parseLendingPortfolio(data["portfolio"]) }),
    rescues,
    settings,
    settingsDigest,
    session: { expiresAt, expiring },
    recovery: { note: note ?? "" },
    ...(liveAccount === undefined ? {} : { liveAccount }),
    ...(liveAccountReason === null ? {} : { liveAccountReason }),
  };
}

/* -------------------------------------------------------------------------- */
/* Route outcome parsers — an HTTP 200 is not an outcome                      */
/* -------------------------------------------------------------------------- */

export type LendingArmOutcome = {
  readonly status: "completed" | "held" | "rolled-back";
  readonly code?: string;
  readonly reason?: string;
  readonly txHash: string | null;
  readonly effect: "changed" | "no-effect" | "unverified";
  readonly mintUsdtWei: string;
  readonly supplyNativeWei: string;
  readonly reserveNativeWei: string;
  readonly idleUsdtWei: string | null;
  readonly swapFeeTier: number;
};

/**
 * `POST /agents/:id/lending/arm`'s outcome block.
 *
 * An HTTP 200 says the ROUTE ran, not that the reserve is on Venus: the arm's
 * relay batch can come back `held` (ambiguous — a second arm is blocked
 * forever) or `rolled-back` (never funded — re-sign). The caller MUST branch.
 */
export function parseLendingArmOutcome(payload: unknown): LendingArmOutcome | Invalid {
  const body = row(payload);
  const data = row(body?.["data"]) ?? body;
  const arm = row(data?.["arm"]);
  if (arm === null) return INVALID;
  const status = arm["status"];
  if (status !== "completed" && status !== "held" && status !== "rolled-back") return INVALID;
  const effect = arm["effect"];
  if (effect !== "changed" && effect !== "no-effect" && effect !== "unverified") return INVALID;
  const mint = decimal(arm["mintUsdtWei"]);
  const supply = decimal(arm["supplyNativeWei"]);
  const reserve = decimal(arm["reserveNativeWei"]);
  const swapFeeTier = integer(arm["swapFeeTier"]);
  if (mint === null || supply === null || reserve === null || swapFeeTier === null) return INVALID;
  const txHash = arm["txHash"] === null || arm["txHash"] === undefined
    ? null : hash(arm["txHash"]);
  const idleUsdtWei = arm["idleUsdtWei"] === null || arm["idleUsdtWei"] === undefined
    ? null : decimal(arm["idleUsdtWei"]);
  const code = text(arm["code"]);
  const reason = text(arm["reason"]);
  return {
    status,
    ...(code === null ? {} : { code }),
    ...(reason === null ? {} : { reason }),
    txHash, effect,
    mintUsdtWei: mint, supplyNativeWei: supply, reserveNativeWei: reserve,
    idleUsdtWei, swapFeeTier,
  };
}

export type LendingRetireOutcome = {
  readonly status: "completed" | "held" | "rolled-back";
  readonly code?: string;
  readonly reason?: string;
  readonly txHash: string | null;
  /** The ONLY field that means "the reserve came back". */
  readonly cleared: boolean;
  readonly redeemAmountWei: string;
  readonly swapInWei: string;
  readonly minOutWei: string;
  readonly poolShort: boolean;
  readonly remainderUsdtWei: string;
  readonly residueUsdtWei: string | null;
};

/**
 * `POST /agents/:id/lending/retire`'s outcome block.
 *
 * HTTP 200 IS NOT "RETIRED" — the plane says so in its own comment, and the
 * `lpWithdrawOutcome` precedent is why: a `held` retire is an UNKNOWN relay
 * answer that blocks every later retire, and `cleared === false` on a
 * `completed` batch means the supply is still partly on Venus.
 */
export function parseLendingRetireOutcome(payload: unknown): LendingRetireOutcome | Invalid {
  const body = row(payload);
  const data = row(body?.["data"]) ?? body;
  const retire = row(data?.["retire"]);
  if (retire === null) return INVALID;
  const status = retire["status"];
  if (status !== "completed" && status !== "held" && status !== "rolled-back") return INVALID;
  const cleared = bool(retire["cleared"]);
  const poolShort = bool(retire["poolShort"]);
  const redeem = decimal(retire["redeemAmountWei"]);
  const swapIn = decimal(retire["swapInWei"]);
  const minOut = decimal(retire["minOutWei"]);
  const remainder = decimal(retire["remainderUsdtWei"]);
  if (cleared === null || poolShort === null || redeem === null
    || swapIn === null || minOut === null || remainder === null) return INVALID;
  const txHash = retire["txHash"] === null || retire["txHash"] === undefined
    ? null : hash(retire["txHash"]);
  const residue = retire["residueUsdtWei"] === null || retire["residueUsdtWei"] === undefined
    ? null : decimal(retire["residueUsdtWei"]);
  const code = text(retire["code"]);
  const reason = text(retire["reason"]);
  return {
    status,
    ...(code === null ? {} : { code }),
    ...(reason === null ? {} : { reason }),
    txHash, cleared,
    redeemAmountWei: redeem, swapInWei: swapIn, minOutWei: minOut,
    poolShort, remainderUsdtWei: remainder, residueUsdtWei: residue,
  };
}

/** Owner-facing sentence for a retire outcome. Never says "retired" on a 200. */
export function lendingRetireOutcomeText(outcome: LendingRetireOutcome | Invalid): string {
  if (outcome === INVALID) return "Outcome unavailable — re-read the guard from the plane.";
  if (outcome.status === "held") {
    return `Retire held: ${outcome.reason ?? "the relay's answer was ambiguous"}. Retire stays blocked until it is understood; rescues continue on whatever the reserve still holds.`;
  }
  if (outcome.status === "rolled-back") {
    return `Retire refused: ${outcome.reason ?? "the batch rolled back"}. Nothing moved.`;
  }
  if (!outcome.cleared) {
    return `Submitted, but the reserve is not fully back: ${outcome.residueUsdtWei ?? "an unread amount"} USDT wei is still supplied on Venus. It stays recoverable with your passkey.`;
  }
  return outcome.poolShort
    ? "Retired what the pool could pay. The remainder stays supplied on Venus and is recoverable with your passkey."
    : "Retired — the reserve is back in the agent wallet as BNB.";
}
