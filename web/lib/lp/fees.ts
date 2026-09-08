import { getSqrtRatioAtTick, formatAtomic } from "@/lib/exec/pairs";
import type { DetailMetric } from "@/lib/exec/agent-detail";
import { formatTokenAmount } from "./dust";

export type FeeEvidence = {
  events: readonly Record<string, unknown>[];
  sum: { realised0Wei: string; realised1Wei: string; throughBlock: string; recordedCount: number; gapCount: number } | null;
  collectible: { collectible0Wei: string; collectible1Wei: string; blockNumber: string; tokenId: string; positionRowVersion: number; asOfMs: number } | null;
  coverage: { status: string; reason: string; missing: number; gaps: number };
};
const row = (v: unknown): Record<string, unknown> | null => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const unsigned = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,77})$/u.test(v);
const signed = (v: unknown): v is string => typeof v === "string" && /^-?(0|[1-9]\d{0,78})$/u.test(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function parseFeeEvidence(position: Record<string, unknown>): FeeEvidence {
  const sum = row(position.feeSum), fees = row(row(position.observation)?.fees), coverage = row(position.feeCoverage);
  return {
    events: Array.isArray(position.feeEvents) ? position.feeEvents.slice(0, 200).flatMap(v => row(v) ? [row(v)!] : []) : [],
    sum: sum && signed(sum.realised0Wei) && signed(sum.realised1Wei) && unsigned(sum.throughBlock) && count(sum.recordedCount) && count(sum.gapCount)
      ? { realised0Wei: sum.realised0Wei, realised1Wei: sum.realised1Wei, throughBlock: sum.throughBlock, recordedCount: sum.recordedCount, gapCount: sum.gapCount } : null,
    collectible: fees && unsigned(fees.collectible0Wei) && unsigned(fees.collectible1Wei) && unsigned(fees.blockNumber) && unsigned(fees.tokenId)
      && count(fees.positionRowVersion) && count(fees.asOfMs) ? { collectible0Wei: fees.collectible0Wei, collectible1Wei: fees.collectible1Wei,
        blockNumber: fees.blockNumber, tokenId: fees.tokenId, positionRowVersion: fees.positionRowVersion, asOfMs: fees.asOfMs } : null,
    coverage: coverage && ["complete", "incomplete", "unavailable"].includes(String(coverage.status)) && typeof coverage.reason === "string" && count(coverage.missing) && count(coverage.gaps)
      ? { status: String(coverage.status), reason: coverage.reason, missing: coverage.missing, gaps: coverage.gaps }
      : { status: "unavailable", reason: "fee coverage unavailable", missing: 0, gaps: 0 },
  };
}
/** Canonical orientation only. Display-unit flips never enter money arithmetic. */
export function feeUsd(wei0: bigint, wei1: bigint, tick: number, quoteIsToken0: boolean, quoteDecimals: number, quoteMicros: bigint): string {
  const sqrt = getSqrtRatioAtTick(tick), q192 = 1n << 192n, squared = sqrt * sqrt;
  const denominator = (quoteIsToken0 ? squared : q192) * 10n ** BigInt(quoteDecimals) * 1_000_000n;
  const raw = (quoteIsToken0 ? wei0 * squared + wei1 * q192 : wei1 * q192 + wei0 * squared) * quoteMicros * 100n;
  const magnitude = raw < 0n ? -raw : raw;
  const cents = (magnitude * 2n + denominator) / (denominator * 2n);
  return `${raw < 0n && cents > 0n ? "-" : ""}$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
export function feeMetric(input: { evidence: FeeEvidence; tokenId: string | null; rowVersion: number | null; imported: boolean;
  tick: number | null; quoteIsToken0: boolean; quoteMicros: bigint | null; decimals0: number | null; decimals1: number | null; symbol0: string; symbol1: string }): DetailMetric {
  const e = input.evidence;
  const reason = input.imported ? "import fee history unavailable" : e.coverage.status !== "complete" ? e.coverage.reason
    : !e.sum || !e.collectible ? "collectible or recorded evidence unavailable"
    : e.sum.throughBlock !== e.collectible.blockNumber ? "fee evidence blocks differ"
    : e.collectible.tokenId !== input.tokenId || e.collectible.positionRowVersion !== input.rowVersion ? "fees are for a prior position version" : null;
  if (reason) return { value: null, reason };
  const a = BigInt(e.sum!.realised0Wei) + BigInt(e.collectible!.collectible0Wei), b = BigInt(e.sum!.realised1Wei) + BigInt(e.collectible!.collectible1Wei);
  const note = `this position since arm · managed submissions · NFPM accounting + simulated collectible at block ${e.collectible!.blockNumber} · before gas`;
  if (input.quoteMicros === null || input.tick === null || input.decimals0 === null || input.decimals1 === null) {
    return { value: null, reason: "fresh matching price unavailable", note: `${a} ${input.symbol0} wei + ${b} ${input.symbol1} wei · ${note}` };
  }
  const token0 = `${formatTokenAmount(a,input.decimals0)} ${input.symbol0}`, token1 = `${formatTokenAmount(b,input.decimals1)} ${input.symbol1}`;
  return { value: feeUsd(a,b,input.tick,input.quoteIsToken0,input.quoteIsToken0 ? input.decimals0 : input.decimals1,input.quoteMicros), reason: null,
    tokenBreakdown: input.quoteIsToken0 ? `${token0} / ${token1}` : `${token1} / ${token0}`,
    note: `${formatAtomic(a.toString(),input.decimals0,6) ?? a.toString()} ${input.symbol0} + ${formatAtomic(b.toString(),input.decimals1,6) ?? b.toString()} ${input.symbol1} · ${note}` };
}
