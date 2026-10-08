/**
 * AGENTIC-MEME-STOCKS-SPEC section 5: parsers of the four raw meme reads (`memeShortlist`, `memeToken`, `memeBars`, `memeEligibility`) and their freshness rules.
 * Unknown keys are ignored everywhere (review M3); a missing method, a non-2xx answer, a network error, an unparseable envelope or a failed required field is
 * "unavailable" (null). The contract is pinned to the data plane's production master `1525319` and re-checked at gate MA-pre.
 */
import type { Address } from "viem";
import type { TradeDataPlaneReads } from "../trade/dataPlaneReads.js";

export const MEME_FRESH_MS = 180_000;
/**
 * 5.3: was 180 000 (measured p90 163 s + 17 s). Set to 120 000, the spec's value at the plane's 90 s p90 target: the data plane (production 3801f95,
 * MEME-BARS-LATENCY-REPLY-2026-10-05) met it, measured by the coordinator on 2026-10-05 over 264 samples at p50 46 s, p90 79 s, max 81 s, none over 90 s.
 */
export const MEME_ENTRY_BAR_LAG_MAX_MS = 120_000;
export const MEME_EXIT_BAR_LAG_MAX_MS = 300_000;
export const MEME_ELIGIBILITY_FRESH_MS = 60_000;
/** Operator 2026-10-07: was 15. 8 is the fewest bars the 6.3 burst can be computed on (a 5-bar base before the bar at L-2); the 6.5 range then spans the bars there are. */
export const MEME_MIN_BARS = 8;
export const MEME_BARS_BATCH_MAX = 30;

export type MemeFlow = { buys: number; sells: number; uniqueTraders: number | null; inflowUsd: number | null };
export type MemeSmart = { netUsd: number; traders: number | null; rank: number | null; rankedAt: number | null };
export type MemeShortlistRow = {
  address: Address; launchpad: string; stage: string; status: string;
  quote: { kind: string; address: Address | null; symbol: string | null; openState: boolean | null };
  liquidityUsd: number | null; flags: readonly string[]; observedAt: number | null;
  symbol: string | null; category: string | null; ageMinutes: number | null; marketCapUsd: number | null; holders: number | null; priceUsd: number | null;
  txs5m: number | null; volume5mUsd: number | null; volume1hUsd: number | null; priceChange5mPct: number | null; priceChange1hPct: number | null;
  flow5m: MemeFlow | null; flow1h: MemeFlow | null; smartInflow5m: MemeSmart | null; smartInflow1h: MemeSmart | null;
  venue: string | null; tax: { buyBps: number; sellBps: number } | null;
};
export type MemeCount = { flap: number; fourmeme: number } | null;
export type MemeShortlist = { rows: MemeShortlistRow[]; invalid: number; staleness: string; asOf: number; boardTotal: number | null; candidates: MemeCount; picked: MemeCount };
export type MemeBoardRow = { status: string; flags: readonly string[]; flow5m: MemeFlow | null; smartInflow5mNetUsd: number | null; venue: string | null;
  tax: { buyBps: number; sellBps: number } | null; observedAt: number | null; staleness: string | null };
export type MemeBar = { startMs: number; open: number; high: number; low: number; close: number; volume: number; filled: boolean };
export type MemeBars = { address: Address; tracked: boolean; staleness: string; lastClosedStartMs: number; bars: MemeBar[] };
export type MemeEligibility = { address: Address; eligible: boolean; source: string | null; venue: string | null; checkedAt: number;
  flap: { status: number; tokenVersion: number; quote: Address; progress: bigint; buyTaxBps: number; sellTaxBps: number } | null;
  /** Operator hotfix 2026-10-06: the Four.meme TokenManager facts (no tax here; the shortlist row carries it). FOURMEME-CURVE-PAPER-SPEC 6.3: the curve's `funds` and `maxFunds` (raw quote atomic units), null when absent or malformed. */
  fourmeme: { version: number; quote: Address | null; liquidityAdded: boolean; funds: bigint | null; maxFunds: bigint | null } | null };

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const num = (value: unknown): number | null => finite(value) ? value : null;
const address = (value: unknown): Address | null => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value) ? value.toLowerCase() as Address : null;
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
/** Display only (5.1): at most 32 characters, control characters stripped; never placed in a prompt. */
export const memeSymbol = (value: unknown): string | null => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 32) : null;
const bps = (value: unknown): number | null => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000 ? value as number : null;

function flow(value: unknown): MemeFlow | null | undefined {
  if (value === null || value === undefined) return null;
  if (!record(value) || !finite(value["buys"]) || !finite(value["sells"]) || value["buys"] < 0 || value["sells"] < 0) return undefined;
  return { buys: value["buys"], sells: value["sells"], uniqueTraders: num(value["uniqueTraders"]), inflowUsd: num(value["inflowUsd"]) };
}
function smart(value: unknown): MemeSmart | null | undefined {
  if (value === null || value === undefined) return null;
  if (!record(value) || !finite(value["netUsd"])) return undefined;
  return { netUsd: value["netUsd"], traders: num(value["traders"]), rank: num(value["rank"]), rankedAt: num(value["rankedAt"]) };
}
function tax(value: unknown): { buyBps: number; sellBps: number } | null | undefined {
  if (value === null || value === undefined) return null;
  if (!record(value)) return undefined;
  const buy = bps(value["buyBps"]), sell = bps(value["sellBps"]);
  return buy === null || sell === null ? undefined : { buyBps: buy, sellBps: sell };
}
function count(value: unknown): MemeCount {
  return record(value) && finite(value["flap"]) && finite(value["fourmeme"]) ? { flap: value["flap"], fourmeme: value["fourmeme"] } : null;
}

/** 5.1, one row; null when a required field is missing or malformed (the row is then dropped and counted). */
export function parseShortlistRow(value: unknown): MemeShortlistRow | null {
  if (!record(value)) return null;
  const token = address(value["address"]), quote = value["quote"], flags = value["flags"];
  if (token === null || typeof value["launchpad"] !== "string" || typeof value["stage"] !== "string" || typeof value["status"] !== "string"
    || !record(quote) || typeof quote["kind"] !== "string" || quote["address"] !== null && address(quote["address"]) === null
    || !(quote["stock"] === null || quote["stock"] === undefined || record(quote["stock"]) && (quote["stock"]["openState"] === null || typeof quote["stock"]["openState"] === "boolean"))
    || !(value["liquidityUsd"] === null || finite(value["liquidityUsd"])) || !Array.isArray(flags) || !flags.every(flag => typeof flag === "string")
    || !(value["observedAt"] === null || finite(value["observedAt"]))) return null;
  const parts = { flow5m: flow(value["flow5m"]), flow1h: flow(value["flow1h"]), smartInflow5m: smart(value["smartInflow5m"]), smartInflow1h: smart(value["smartInflow1h"]), tax: tax(value["tax"]) };
  if (Object.values(parts).some(part => part === undefined)) return null;
  const stock = record(quote["stock"]) ? quote["stock"] : null;
  return { address: token, launchpad: value["launchpad"], stage: value["stage"], status: value["status"],
    quote: { kind: quote["kind"], address: address(quote["address"]), symbol: memeSymbol(quote["symbol"]), openState: stock === null ? null : stock["openState"] as boolean | null },
    liquidityUsd: value["liquidityUsd"] as number | null, flags: flags as string[], observedAt: value["observedAt"] as number | null,
    symbol: memeSymbol(value["symbol"]), category: str(value["category"]), ageMinutes: num(value["ageMinutes"]), marketCapUsd: num(value["marketCapUsd"]), holders: num(value["holders"]),
    priceUsd: num(value["priceUsd"]), txs5m: num(value["txs5m"]), volume5mUsd: num(value["volume5mUsd"]), volume1hUsd: num(value["volume1hUsd"]),
    priceChange5mPct: num(value["priceChange5mPct"]), priceChange1hPct: num(value["priceChange1hPct"]),
    flow5m: parts.flow5m!, flow1h: parts.flow1h!, smartInflow5m: parts.smartInflow5m!, smartInflow1h: parts.smartInflow1h!, venue: str(value["venue"]), tax: parts.tax! };
}

/** 5.1: the shortlist envelope; rows keep the plane's order (its `picked` ranking, review R3-2). */
export function parseShortlist(envelope: unknown): MemeShortlist | null {
  if (!record(envelope) || !Array.isArray(envelope["data"]) || !record(envelope["meta"])) return null;
  const meta = envelope["meta"];
  if (typeof meta["staleness"] !== "string" || !finite(meta["asOf"])) return null;
  const parsed = envelope["data"].map(parseShortlistRow);
  return { rows: parsed.filter((row): row is MemeShortlistRow => row !== null), invalid: parsed.filter(row => row === null).length,
    staleness: meta["staleness"], asOf: meta["asOf"], boardTotal: num(meta["boardTotal"]), candidates: count(meta["candidates"]), picked: count(meta["picked"]) };
}

/** 5.1 entry freshness of the envelope. */
export const shortlistFresh = (s: MemeShortlist, nowMs: number): boolean => s.staleness === "fresh" && nowMs - s.asOf <= MEME_FRESH_MS;
/** 5.1 entry freshness of a row: its observation and every non-null rank within 180 000 ms. */
export const rowFresh = (row: MemeShortlistRow, nowMs: number): boolean => row.observedAt !== null && nowMs - row.observedAt <= MEME_FRESH_MS
  && [row.smartInflow5m, row.smartInflow1h].every(rank => rank === null || rank.rankedAt !== null && nowMs - rank.rankedAt <= MEME_FRESH_MS);

/** 5.2: the board row of a held token. */
export function parseBoardRow(envelope: unknown): MemeBoardRow | null {
  if (!record(envelope) || !record(envelope["data"])) return null;
  const row = envelope["data"], meta = record(envelope["meta"]) ? envelope["meta"] : {};
  const flags = row["flags"], smartMoney = row["smartMoney"], activity = row["activity"];
  const parts = { flow5m: flow(row["flow5m"]), inflow5m: smart(record(smartMoney) ? smartMoney["inflow5m"] : null), tax: tax(row["tax"]) };
  if (typeof row["status"] !== "string" || !Array.isArray(flags) || !flags.every(flag => typeof flag === "string") || Object.values(parts).some(part => part === undefined)) return null;
  return { status: row["status"], flags: flags as string[], flow5m: parts.flow5m!, smartInflow5mNetUsd: parts.inflow5m?.netUsd ?? null, venue: str(row["venue"]),
    tax: parts.tax!, observedAt: record(activity) ? num(activity["observedAt"]) : null, staleness: str(meta["staleness"]) };
}
/** 5.2 exit freshness; otherwise X4 and X6 are skipped. */
export const boardFresh = (row: MemeBoardRow, nowMs: number): boolean => row.staleness === "fresh" && row.observedAt !== null && nowMs - row.observedAt <= MEME_FRESH_MS;

/** 5.3: one element of a bars batch; null when any rule fails. */
export function parseBarsElement(value: unknown, requested: Address): MemeBars | null {
  if (!record(value) || address(value["address"]) !== requested.toLowerCase() || value["source"] !== "sintral" || value["unit"] !== "usd"
    || typeof value["staleness"] !== "string" || typeof value["tracked"] !== "boolean" || !finite(value["lastClosedStartMs"]) || !Array.isArray(value["bars"])) return null;
  const bars: MemeBar[] = [];
  for (const bar of value["bars"]) {
    if (!record(bar)) return null;
    const { startMs, open, high, low, close, volume, filled } = bar;
    if (!finite(startMs) || ![open, high, low, close, volume].every(v => finite(v) && v >= 0) || typeof filled !== "boolean") return null;
    const o = open as number, h = high as number, l = low as number, c = close as number;
    if (h < Math.max(o, c) || l > Math.min(o, c) || bars.length > 0 && startMs !== bars.at(-1)!.startMs + 60_000) return null;
    bars.push({ startMs, open: o, high: h, low: l, close: c, volume: volume as number, filled });
  }
  if (bars.length === 0 || bars.at(-1)!.startMs !== value["lastClosedStartMs"]) return null;
  return { address: requested.toLowerCase() as Address, tracked: value["tracked"], staleness: value["staleness"], lastClosedStartMs: value["lastClosedStartMs"], bars };
}
/** 5.3: the batch, element i answering request i; a failed element is absent from the map. */
export function parseBars(envelope: unknown, requested: readonly Address[]): Map<string, MemeBars> | null {
  if (!record(envelope) || !Array.isArray(envelope["data"]) || envelope["data"].length !== requested.length) return null;
  const out = new Map<string, MemeBars>();
  envelope["data"].forEach((element, index) => { const parsed = parseBarsElement(element, requested[index]!); if (parsed !== null) out.set(parsed.address, parsed); });
  return out;
}
/** 5.3: the lag recorded on every decision. */
export const barLagMs = (bars: MemeBars, nowMs: number): number => nowMs - (bars.lastClosedStartMs + 60_000);
/** 5.3 entry rule: tracked, at least MEME_MIN_BARS bars, fresh, lag within MEME_ENTRY_BAR_LAG_MAX_MS. */
export const barsEntryOk = (bars: MemeBars, nowMs: number): boolean => bars.tracked && bars.bars.length >= MEME_MIN_BARS && bars.staleness === "fresh"
  && barLagMs(bars, nowMs) <= MEME_ENTRY_BAR_LAG_MAX_MS;
/** Operator 2026-10-07, log only: which 5.3 entry rule a read series failed, first failing rule in `barsEntryOk` order; null when it passes. A series that was not read at all logs no reason (its brain tuple is the verdict alone). */
export const barsEntryReason = (bars: MemeBars, nowMs: number): "untracked" | "young" | "stale" | "lag" | null => !bars.tracked ? "untracked"
  : bars.bars.length < MEME_MIN_BARS ? "young" : bars.staleness !== "fresh" ? "stale" : barLagMs(bars, nowMs) > MEME_ENTRY_BAR_LAG_MAX_MS ? "lag" : null;
export const barsExitOk =(bars: MemeBars, nowMs: number): boolean => barLagMs(bars, nowMs) <= MEME_EXIT_BAR_LAG_MAX_MS;

/** 5.4: rows keyed by address (order not assumed, duplicates collapsed); a malformed row is absent. */
export function parseEligibility(envelope: unknown): Map<string, MemeEligibility> | null {
  if (!record(envelope) || !Array.isArray(envelope["data"])) return null;
  const out = new Map<string, MemeEligibility>();
  for (const row of envelope["data"]) {
    if (!record(row)) continue;
    const token = address(row["address"]), f = row["flap"];
    if (token === null || typeof row["eligible"] !== "boolean" || !(row["source"] === null || typeof row["source"] === "string")
      || !(row["venue"] === null || typeof row["venue"] === "string") || !finite(row["checkedAt"])) continue;
    let flap: MemeEligibility["flap"] = null;
    if (f !== null && f !== undefined) {
      const quote = record(f) ? address(f["quote"]) : null;
      if (!record(f) || !Number.isInteger(f["status"]) || !Number.isInteger(f["tokenVersion"]) || quote === null || typeof f["progress"] !== "string" || !/^\d{1,78}$/u.test(f["progress"])
        || bps(f["buyTaxBps"]) === null || bps(f["sellTaxBps"]) === null) continue;
      flap = { status: f["status"] as number, tokenVersion: f["tokenVersion"] as number, quote, progress: BigInt(f["progress"]), buyTaxBps: f["buyTaxBps"] as number, sellTaxBps: f["sellTaxBps"] as number };
    }
    let fourmeme: MemeEligibility["fourmeme"] = null;
    const m = row["fourmeme"];
    if (m !== null && m !== undefined) {
      const quote = record(m) && m["quote"] !== null ? address(m["quote"]) : null;
      if (!record(m) || !Number.isInteger(m["version"]) || typeof m["liquidityAdded"] !== "boolean" || m["quote"] !== null && quote === null) continue;
      const raw = (value: unknown): bigint | null => typeof value === "string" && /^\d{1,78}$/u.test(value) ? BigInt(value) : null;
      fourmeme = { version: m["version"] as number, quote, liquidityAdded: m["liquidityAdded"], funds: raw(m["funds"]), maxFunds: raw(m["maxFunds"]) };
    }
    out.set(token, { address: token, eligible: row["eligible"], source: row["source"] as string | null, venue: row["venue"] as string | null, checkedAt: row["checkedAt"], flap, fourmeme });
  }
  return out;
}
export const eligibilityFresh = (row: MemeEligibility, nowMs: number): boolean => nowMs - row.checkedAt <= MEME_ELIGIBILITY_FRESH_MS;

/** Every read through the client's own timeout (5 000 ms in the trade-worker); any failure is null. */
export async function memeRead<T>(read: (() => Promise<unknown>) | undefined, parse: (value: unknown) => T | null): Promise<T | null> {
  if (read === undefined) return null;
  try { return parse(await read()); } catch { return null; }
}
export type MemeReads = Pick<TradeDataPlaneReads, "memeShortlist" | "memeToken" | "memeBars" | "memeEligibility">;
