/** Optional reporting evidence. Never an input to valuation or execution. */
export type LpFeeReceipt = {
  readonly atomicRotate?: import("./atomicRotateReceipt.js").AtomicRotateReceipt;
  readonly blockNumber: bigint;
  readonly byTokenId: ReadonlyMap<string, {
    readonly collected0: bigint;
    readonly collected1: bigint;
    readonly decreased0: bigint;
    readonly decreased1: bigint;
  }>;
};

export type LpFeesTelemetry = {
  readonly collectible0Wei: bigint;
  readonly collectible1Wei: bigint;
  readonly blockNumber: bigint;
  readonly tokenId: string;
  readonly positionRowVersion: number;
  readonly asOfMs: number;
};

const uint256Max = (1n << 256n) - 1n;
function uint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= uint256Max;
}

/** Bounded, closed shape; malformed telemetry cannot erase protection state. */
export function parseLpFeesTelemetry(value: unknown): LpFeesTelemetry | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "asOfMs,blockNumber,collectible0Wei,collectible1Wei,positionRowVersion,tokenId") return undefined;
    if (!uint(row["collectible0Wei"]) || !uint(row["collectible1Wei"]) || !uint(row["blockNumber"])
      || typeof row["tokenId"] !== "string" || !/^(0|[1-9]\d{0,77})$/u.test(row["tokenId"]) || !uint(BigInt(row["tokenId"]))
      || typeof row["positionRowVersion"] !== "number" || !Number.isSafeInteger(row["positionRowVersion"]) || row["positionRowVersion"] < 0
      || typeof row["asOfMs"] !== "number" || !Number.isSafeInteger(row["asOfMs"]) || row["asOfMs"] < 0) return undefined;
    return { collectible0Wei: row["collectible0Wei"], collectible1Wei: row["collectible1Wei"], blockNumber: row["blockNumber"],
      tokenId: row["tokenId"], positionRowVersion: row["positionRowVersion"], asOfMs: row["asOfMs"] };
  } catch { return undefined; }
}

/** Split before the shared codec revives tags; only three scalar bigint slots. */
export function reviveLpFeesTelemetry(value: unknown): LpFeesTelemetry | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const row = { ...value } as Record<string, unknown>;
    if (Object.keys(row).length !== 6) return undefined;
    for (const key of ["collectible0Wei", "collectible1Wei", "blockNumber"]) {
      const tagged = row[key];
      if (typeof tagged === "object" && tagged !== null && !Array.isArray(tagged)) {
        const tag = tagged as Record<string, unknown>;
        if (Object.keys(tag).length !== 1 || typeof tag["$bigint"] !== "string" || !/^(0|[1-9]\d{0,77})$/u.test(tag["$bigint"])) return undefined;
        row[key] = BigInt(tag["$bigint"]);
      }
    }
    return parseLpFeesTelemetry(row);
  } catch { return undefined; }
}
