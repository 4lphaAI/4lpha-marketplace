export type LendingPortfolio = {
  readonly status: "available" | "unavailable";
  readonly totalSupplyUsdMantissa: string | null;
  readonly totalBorrowedUsdMantissa: string | null;
  readonly dailyEarningUsdMantissa: string | null;
  readonly netApyBps: string | null;
  readonly blockNumber: string | null;
  readonly asOfMs: number | null;
  readonly reason: string | null;
};
export function parseLendingPortfolio(value: unknown, now = Date.now()): LendingPortfolio | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data["status"] === "unavailable") return {
    status: "unavailable", totalSupplyUsdMantissa: null, totalBorrowedUsdMantissa: null,
    dailyEarningUsdMantissa: null, netApyBps: null, blockNumber: null, asOfMs: null,
    reason: typeof data["reason"] === "string" ? data["reason"] : "Portfolio data unavailable.",
  };
  const supply = data["totalSupplyUsdMantissa"], borrow = data["totalBorrowedUsdMantissa"];
  const daily = data["dailyEarningUsdMantissa"], apy = data["netApyBps"], block = data["blockNumber"], at = data["asOfMs"];
  if (data["status"] !== "available" || typeof supply !== "string" || !/^\d{1,78}$/u.test(supply)
    || typeof borrow !== "string" || !/^\d{1,78}$/u.test(borrow)
    || typeof daily !== "string" || !/^-?\d{1,78}$/u.test(daily)
    || (apy !== null && (typeof apy !== "string" || !/^-?\d{1,78}$/u.test(apy)))
    || typeof block !== "string" || !/^\d+$/u.test(block)
    || typeof at !== "number" || !Number.isSafeInteger(at) || at > now || now - at > 120_000) return null;
  return { status: "available", totalSupplyUsdMantissa: supply, totalBorrowedUsdMantissa: borrow,
    dailyEarningUsdMantissa: daily, netApyBps: apy, blockNumber: block, asOfMs: at, reason: null };
}
export function portfolioUsd(value: string | null | undefined, daily = false): string {
  if (value === null || value === undefined) return "—";
  const raw = BigInt(value), abs = raw < 0n ? -raw : raw, sign = raw < 0n ? "-" : "";
  if (daily && abs > 0n && abs < 10n ** 16n) return `${sign}<$0.01`;
  const cents = (abs + 5n * 10n ** 15n) / 10n ** 16n;
  return `${sign}$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export function portfolioApy(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const raw = BigInt(value), abs = raw < 0n ? -raw : raw;
  return `${raw < 0n ? "-" : raw > 0n ? "+" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`;
}
