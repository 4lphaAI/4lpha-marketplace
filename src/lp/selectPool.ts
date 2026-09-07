/**
 * Yield selection at open — the PURE half (PHASE3.10 Revision 2 R4/R5/R7).
 *
 * This module adapts the untrusted `/pools/top` envelope into one normalized
 * contract. It does not discover the persisted session token, filter the
 * token/WBNB universe, cap candidates, or run chain admission reads; those
 * operations belong to the server in the fail-cheap order fixed by R4. The
 * caller gives `selectLpPool` only rows that reached the ranking stage and the
 * factory-resolved addresses that passed every admission gate.
 *
 * APR is CARRIED from PancakeSwap's `lpFeeApr24h`, not reconstructed from TVL,
 * volume and fee. TVL and volume are USD microdollars used only as deterministic
 * tiebreaks. No gross-fee formula may admit, drop, rank, or floor a pool here.
 */
import { getAddress, isAddress, type Address } from "viem";

/** `/pools/top` rejects timestamps farther ahead than this fixed clock skew. */
export const LP_RANKING_MAX_FUTURE_SKEW_MS = 30_000;

const MAX_COVERAGE_ROWS = 500;
const V3_FEES = new Set([100, 500, 2500, 10_000]);

export type LpV3Fee = 100 | 500 | 2500 | 10_000;

/** One field-by-field reason why an otherwise valid lane dropped one row. */
export type LpPoolRowDropReason =
  | "not-object"
  | "protocol"
  | "source"
  | "apr-sources"
  | "pool-address"
  | "token0-address"
  | "token1-address"
  | "token-order"
  | "fee"
  | "tvl-usd"
  | "volume24h-usd"
  | "lp-fee-apr24h"
  | "row-as-of"
  | "row-future"
  | "duplicate-pool";

export type LpPoolRowDropCounts = Readonly<Record<LpPoolRowDropReason, number>>;

/** One normalized row. No untrusted object is spread into this type. */
export type LpRankedPool = {
  readonly pool: Address;
  /** Pool legs in canonical pool order (`token0 < token1`). */
  readonly token0: Address;
  readonly token1: Address;
  /** V3 fee tier in millionths: 2500 means 0.25%. */
  readonly fee: LpV3Fee;
  /** Pancake's net `lpFeeApr24h` percentage converted to basis points. */
  readonly aprBps: bigint;
  readonly tvlUsdE6: bigint;
  readonly volume24hUsdE6: bigint;
  /** Epoch milliseconds at which this individual pool row was read. */
  readonly rowAsOfMs: number;
  readonly aprSource: "pancake-apr24h";
};

/** Validated coverage and provenance retained for the selection receipt. */
export type LpRankedPoolsPayload = {
  readonly laneAsOfMs: number;
  readonly source: "pancake";
  /** Lane-wide pool count when the optional metadata was internally valid. */
  readonly total: number | null;
  /** Token-filtered count. Coverage requires `matched === returned`. */
  readonly matched: number;
  readonly returned: number;
  /** Data-plane ingest cap when the optional metadata was internally valid. */
  readonly cap: number | null;
  /** `"tvlUSD"` when the data plane declares its expected ingest order. */
  readonly ingestOrder: "tvlUSD" | null;
  readonly rowDropCounts: LpPoolRowDropCounts;
  readonly pools: readonly LpRankedPool[];
};

function emptyDropCounts(): Record<LpPoolRowDropReason, number> {
  return {
    "not-object": 0,
    protocol: 0,
    source: 0,
    "apr-sources": 0,
    "pool-address": 0,
    "token0-address": 0,
    "token1-address": 0,
    "token-order": 0,
    fee: 0,
    "tvl-usd": 0,
    "volume24h-usd": 0,
    "lp-fee-apr24h": 0,
    "row-as-of": 0,
    "row-future": 0,
    "duplicate-pool": 0,
  };
}

function readAddr(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    return null;
  }
  return getAddress(value);
}

function readNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readCoverageCount(value: unknown): number | null {
  const parsed = readNonnegativeInteger(value);
  return parsed !== null && parsed <= MAX_COVERAGE_ROWS ? parsed : null;
}

function isTooFarInFuture(asOfMs: number, nowMs: number): boolean {
  return asOfMs - nowMs > LP_RANKING_MAX_FUTURE_SKEW_MS;
}

/**
 * Convert a finite nonnegative JSON number to a scaled bigint, round-half-up.
 *
 * Conversion parses the number's canonical decimal string, including exponent
 * notation. It never multiplies the floating-point value by the scale. A
 * result wider than 78 decimal digits is refused before `BigInt` construction.
 */
export function decimalNumberToScaledBigInt(
  value: unknown,
  scaleDigits: number,
): bigint | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(scaleDigits) ||
    scaleDigits < 0 ||
    scaleDigits > 78
  ) {
    return null;
  }
  if (value === 0) return 0n;

  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (match === null) return null;

  const integerPart = match[1];
  if (integerPart === undefined) return null;
  const fractionPart = match[2] ?? "";
  const exponentText = match[3];
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return null;

  const digits = `${integerPart}${fractionPart}`.replace(/^0+/, "");
  if (digits.length === 0) return 0n;

  const shift = exponent - fractionPart.length + scaleDigits;
  if (shift >= 0) {
    if (digits.length + shift > 78) return null;
    return BigInt(`${digits}${"0".repeat(shift)}`);
  }

  const discardedDigits = -shift;
  if (discardedDigits > digits.length) return 0n;

  const retainedLength = digits.length - discardedDigits;
  const retained = retainedLength === 0 ? 0n : BigInt(digits.slice(0, retainedLength));
  const firstDiscarded = digits.charCodeAt(retainedLength) - 48;
  const rounded = firstDiscarded >= 5 ? retained + 1n : retained;
  return rounded.toString(10).length <= 78 ? rounded : null;
}

function isLpV3Fee(value: unknown): value is LpV3Fee {
  return typeof value === "number" && Number.isInteger(value) && V3_FEES.has(value);
}

/**
 * Parse and normalize an UNTRUSTED `/pools/top` response envelope.
 *
 * Envelope defects return `null`. Row defects increment exactly one reason and
 * drop only that row. `nowMs` is injected so a lane timestamp over 30 seconds
 * ahead rejects the envelope and an individual future row cannot bypass the
 * later age rail. Stale-but-not-future rows remain represented for the server's
 * token/WBNB-universe-aware freshness decision.
 */
export function parsePoolsTopEnvelope(
  value: unknown,
  nowMs: number,
): LpRankedPoolsPayload | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const envelope = value as Record<string, unknown>;
  const rawData = envelope["data"];
  const rawMeta = envelope["meta"];
  if (
    !Array.isArray(rawData) ||
    typeof rawMeta !== "object" ||
    rawMeta === null ||
    Array.isArray(rawMeta)
  ) {
    return null;
  }

  const meta = rawMeta as Record<string, unknown>;
  const laneAsOfMs = readNonnegativeInteger(meta["asOf"]);
  const matched = readCoverageCount(meta["matched"]);
  const returned = readCoverageCount(meta["returned"]);
  if (
    laneAsOfMs === null ||
    isTooFarInFuture(laneAsOfMs, nowMs) ||
    meta["source"] !== "pancake" ||
    matched === null ||
    returned === null ||
    matched !== returned ||
    returned !== rawData.length
  ) {
    return null;
  }

  const rawTotal = readCoverageCount(meta["total"]);
  const total = rawTotal !== null && rawTotal >= matched ? rawTotal : null;
  const rawCap = readNonnegativeInteger(meta["cap"]);
  const capFloor = total ?? matched;
  const cap = rawCap !== null && rawCap >= capFloor ? rawCap : null;
  const ingestOrder = meta["ingestOrder"] === "tvlUSD" ? "tvlUSD" : null;

  const rowDropCounts = emptyDropCounts();
  const pools: LpRankedPool[] = [];
  const seenPools = new Set<string>();

  const drop = (reason: LpPoolRowDropReason): void => {
    rowDropCounts[reason] += 1;
  };

  for (const rawRow of rawData) {
    if (typeof rawRow !== "object" || rawRow === null || Array.isArray(rawRow)) {
      drop("not-object");
      continue;
    }
    const row = rawRow as Record<string, unknown>;

    if (row["protocol"] !== "v3") {
      drop("protocol");
      continue;
    }
    if (row["source"] !== "pancake") {
      drop("source");
      continue;
    }
    const aprSources = row["aprSources"];
    if (!Array.isArray(aprSources) || !aprSources.includes("lpFee")) {
      drop("apr-sources");
      continue;
    }

    const pool = readAddr(row["pool"]);
    if (pool === null) {
      drop("pool-address");
      continue;
    }
    const token0 = readAddr(row["token0"]);
    if (token0 === null) {
      drop("token0-address");
      continue;
    }
    const token1 = readAddr(row["token1"]);
    if (token1 === null) {
      drop("token1-address");
      continue;
    }
    if (token0.toLowerCase() >= token1.toLowerCase()) {
      drop("token-order");
      continue;
    }

    const fee = row["fee"];
    if (!isLpV3Fee(fee)) {
      drop("fee");
      continue;
    }

    const tvlUsd = row["tvlUsd"];
    const tvlUsdE6 = decimalNumberToScaledBigInt(tvlUsd, 6);
    if (typeof tvlUsd !== "number" || tvlUsd <= 0 || tvlUsdE6 === null) {
      drop("tvl-usd");
      continue;
    }
    const volume24hUsd = row["volume24hUsd"];
    const volume24hUsdE6 = decimalNumberToScaledBigInt(volume24hUsd, 6);
    if (typeof volume24hUsd !== "number" || volume24hUsd < 0 || volume24hUsdE6 === null) {
      drop("volume24h-usd");
      continue;
    }
    const lpFeeApr24h = row["lpFeeApr24h"];
    const aprBps = decimalNumberToScaledBigInt(lpFeeApr24h, 2);
    if (typeof lpFeeApr24h !== "number" || lpFeeApr24h < 0 || aprBps === null) {
      drop("lp-fee-apr24h");
      continue;
    }

    const rowAsOfMs = readNonnegativeInteger(row["asOf"]);
    if (rowAsOfMs === null) {
      drop("row-as-of");
      continue;
    }
    if (isTooFarInFuture(rowAsOfMs, nowMs)) {
      drop("row-future");
      continue;
    }

    const poolKey = pool.toLowerCase();
    if (seenPools.has(poolKey)) {
      drop("duplicate-pool");
      continue;
    }
    seenPools.add(poolKey);
    pools.push({
      pool,
      token0,
      token1,
      fee,
      aprBps,
      tvlUsdE6,
      volume24hUsdE6,
      rowAsOfMs,
      aprSource: "pancake-apr24h",
    });
  }

  return {
    laneAsOfMs,
    source: "pancake",
    total,
    matched,
    returned,
    cap,
    ingestOrder,
    rowDropCounts,
    pools,
  };
}

export type LpRankingTimestampState = "fresh" | "stale" | "future";

/** Shared lane/row age classifier for the server's R4 filtering order. */
export function classifyLpRankingTimestamp(
  asOfMs: number,
  nowMs: number,
  maxAgeMs: number,
): LpRankingTimestampState {
  if (!Number.isSafeInteger(asOfMs) || asOfMs < 0) {
    throw new Error("classifyLpRankingTimestamp: asOfMs must be a nonnegative safe integer.");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("classifyLpRankingTimestamp: nowMs must be a nonnegative safe integer.");
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("classifyLpRankingTimestamp: maxAgeMs must be a positive safe integer.");
  }
  if (isTooFarInFuture(asOfMs, nowMs)) return "future";
  if (nowMs - asOfMs > maxAgeMs) return "stale";
  return "fresh";
}

/** One admitted row with the carried rank value repeated for receipt callers. */
export type LpRankedSurvivor = {
  readonly pool: LpRankedPool;
  readonly aprBps: bigint;
};

export type LpPoolSelection =
  | {
      readonly ok: true;
      /** Deterministic order: APR desc → TVL desc → volume desc → address asc. */
      readonly survivors: readonly LpRankedSurvivor[];
      readonly head: LpRankedSurvivor;
    }
  | {
      readonly ok: false;
      readonly code: "NO_SURVIVORS";
      readonly reason: string;
    };

export type SelectLpPoolInput = {
  /** Fresh, universe-filtered, candidate-capped rows supplied by the server. */
  readonly pools: readonly LpRankedPool[];
  /** Owner-signed APR floor. Zero disables the floor. */
  readonly minAprBps: number;
  readonly rankBy: "fee-apr" | "volume";
  /** Lowercased factory-resolved pool addresses that passed every chain gate. */
  readonly gatesPassed: ReadonlySet<string>;
};

/** Rank only admitted rows using Pancake's carried net fee APR. */
export function selectLpPool(input: SelectLpPoolInput): LpPoolSelection {
  if (!Number.isInteger(input.minAprBps) || input.minAprBps < 0) {
    throw new Error("selectLpPool: minAprBps must be a nonnegative integer.");
  }

  const survivors: LpRankedSurvivor[] = input.pools
    .filter((pool) => input.gatesPassed.has(pool.pool.toLowerCase()))
    .filter((pool) => pool.aprBps >= BigInt(input.minAprBps))
    .map((pool) => ({ pool, aprBps: pool.aprBps }))
    .sort((a, b) => {
      if (input.rankBy === "fee-apr") {
        if (a.aprBps !== b.aprBps) return a.aprBps > b.aprBps ? -1 : 1;
        if (a.pool.tvlUsdE6 !== b.pool.tvlUsdE6) {
          return a.pool.tvlUsdE6 > b.pool.tvlUsdE6 ? -1 : 1;
        }
        if (a.pool.volume24hUsdE6 !== b.pool.volume24hUsdE6) {
          return a.pool.volume24hUsdE6 > b.pool.volume24hUsdE6 ? -1 : 1;
        }
      } else {
        if (a.pool.volume24hUsdE6 !== b.pool.volume24hUsdE6) {
          return a.pool.volume24hUsdE6 > b.pool.volume24hUsdE6 ? -1 : 1;
        }
        if (a.aprBps !== b.aprBps) return a.aprBps > b.aprBps ? -1 : 1;
        if (a.pool.tvlUsdE6 !== b.pool.tvlUsdE6) {
          return a.pool.tvlUsdE6 > b.pool.tvlUsdE6 ? -1 : 1;
        }
      }
      const addressA = a.pool.pool.toLowerCase();
      const addressB = b.pool.pool.toLowerCase();
      if (addressA === addressB) return 0;
      return addressA < addressB ? -1 : 1;
    });

  const head = survivors[0];
  if (head === undefined) {
    return {
      ok: false,
      code: "NO_SURVIVORS",
      reason:
        "No candidate pool passed the admission gates and the minAprBps floor; the open is refused rather than the filter widened.",
    };
  }
  return { ok: true, survivors, head };
}
