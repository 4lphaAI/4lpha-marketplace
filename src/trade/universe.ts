import { EQUITY_WRAPPERS } from "./classification.js";
/** Trading candidate admission and per-cycle selection (TRADING-AGENT R3 / R3.4). */
import type { Address } from "viem";
import { evaluateSecurityPayload, type ScanReason, type ScanVerdict } from "../rules/scanGate.js";
import { maxGrantedTokens } from "./sizing.js";
import type { TradeExecutionModel, TradeSettings } from "./settings.js";
import type {
  EligibilityBatchRow,
  EligibilitySource,
  EligibilityVenue,
  TokenBatchRow,
  TradeDataPlaneReads,
  UniverseLane,
  UniverseRow,
} from "./dataPlaneReads.js";

export const PIN_MAX_READS = 16;
export const PIN_MAX_BALANCE_READS = 69;
export const PIN_CONCURRENCY = 4;
export const MIN_PIN = 5;
export const US_EQUITY_HOURS_UTC = {
  weekdays: [1, 2, 3, 4, 5] as const,
  openMinute: 13 * 60 + 30,
  closeMinute: 20 * 60,
} as const;
export const TRADE_READ_BUDGET = 24;
export const TRADE_SHORTLIST_MAX = 12;
export const TRADE_SCAN_TTL_SEC = 300;

export class PinUnreadableError extends Error {
  constructor() {
    super("The trading universe could not be read.");
    this.name = "PinUnreadableError";
  }
}

export class PinTooSmallError extends Error {
  constructor(readonly count: number) {
    super(`The trading universe has only ${count} usable tokens; at least ${MIN_PIN} are required.`);
    this.name = "PinTooSmallError";
  }
}

export class ModelUnavailableError extends Error {
  constructor(readonly model: TradeExecutionModel) {
    super(`The ${model} trading model is unavailable.`);
    this.name = "ModelUnavailableError";
  }
}

export type PinnedCandidate = {
  readonly address: Address;
  readonly symbol: string;
  readonly lane: UniverseLane;
  readonly marketCapUsd: number | null;
  readonly priceUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly priceChange24hPct: number | null;
  readonly holders: number | null;
  readonly marketHours?: "us-equities";
};

export type PinUniverseDeps = {
  readonly dataPlane: Pick<TradeDataPlaneReads, "universe" | "tokensBatch">;
  readonly signal?: AbortSignal;
};

function lanesFor(model: TradeExecutionModel): readonly UniverseLane[] {
  switch (model) {
    case "blue-chip": return ["allowlist", "bstocks"];
    case "mid-cap": return ["allowlist", "coins"];
    case "degen": return ["meme"];
    case "sigma": return ["meme", "coins", "allowlist", "bstocks"];
  }
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  limit: number,
  visit: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await visit(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function volumeCompare(left: PinnedCandidate, right: PinnedCandidate): number {
  const leftVolume = left.volume24hUsd ?? -1;
  const rightVolume = right.volume24hUsd ?? -1;
  return rightVolume - leftVolume || left.address.localeCompare(right.address);
}

/** Preserve stable volume ranking inside each provenance bucket. */
export function rankDiversified<T extends PinnedCandidate>(model: TradeExecutionModel, candidates: readonly T[]): T[] {
  if (model !== "blue-chip" && model !== "sigma") return [...candidates].sort(volumeCompare);
  const buckets: Record<"crypto" | "equity" | "meme", T[]> = { crypto: [], equity: [], meme: [] };
  for (const candidate of candidates) {
    const source = "eligibilitySource" in candidate ? candidate.eligibilitySource : null;
    const bucket = candidate.lane === "bstocks" || EQUITY_WRAPPERS.has(candidate.address.toLowerCase()) ? "equity"
      : model === "sigma" && (source === "fourmeme" || source === "flap" || (source === null && candidate.lane === "meme")) ? "meme" : "crypto";
    buckets[bucket].push(candidate);
  }
  for (const rows of Object.values(buckets)) rows.sort(volumeCompare);
  const order = [buckets.crypto, buckets.equity, buckets.meme];
  const result: T[] = [];
  for (let index = 0; result.length < candidates.length; index++) {
    for (const bucket of order) if (bucket[index] !== undefined) result.push(bucket[index]!);
  }
  return result;
}

function inModelBand(model: TradeExecutionModel, row: UniverseRow, token: TokenBatchRow): boolean {
  const cap = token.marketCapUsd;
  switch (model) {
    case "blue-chip": return row.lane === "bstocks" || (cap !== null && cap > 1_000_000_000);
    case "mid-cap": return cap !== null && cap >= 10_000_000 && cap <= 1_000_000_000;
    case "degen": return cap !== null && cap < 1_000_000;
    case "sigma": return true;
  }
}

/** Owner-independent stage cached by the hire flow; C23 keeps balances outside it. */
export async function pinUniverse(
  model: TradeExecutionModel,
  deps: PinUniverseDeps,
): Promise<readonly PinnedCandidate[]> {
  const lanes = lanesFor(model);
  let laneRows: readonly (readonly UniverseRow[] | null)[];
  try {
    laneRows = await mapConcurrent(lanes, PIN_CONCURRENCY, (lane) =>
      deps.dataPlane.universe(lane, deps.signal));
  } catch {
    throw new PinUnreadableError();
  }
  const allowlistIndex = lanes.indexOf("allowlist");
  const allowlist = allowlistIndex < 0 ? undefined : laneRows[allowlistIndex];
  if (model === "mid-cap" && allowlist === null) throw new ModelUnavailableError(model);

  // Later lanes win, so the static bStocks row supplies market-hours identity (C25).
  const universeByAddress = new Map<string, UniverseRow>();
  for (const rows of laneRows) {
    if (rows === null) continue;
    for (const row of rows) universeByAddress.set(row.address.toLowerCase(), row);
  }

  const laneReadCount = lanes.length;
  const tokenReadLimit = PIN_MAX_READS - laneReadCount;
  // AUDIT M2: under the fixed read ceiling, deterministic custody relevance wins:
  // bStocks and allowlist first, then meme, then coins; one seed keeps every nonempty lane represented.
  const lanePriority: Readonly<Record<UniverseLane, number>> = { bstocks: 0, allowlist: 1, meme: 2, coins: 3 };
  const ranked = [...universeByAddress.values()]
    .sort((left, right) => lanePriority[left.lane] - lanePriority[right.lane]
      || left.address.localeCompare(right.address));
  const capacity = tokenReadLimit * 50;
  const selected = ranked.slice(0, capacity);
  for (const lane of ["bstocks", "allowlist", "meme", "coins"] as const) {
    if (selected.some((row) => row.lane === lane)) continue;
    const seed = ranked.find((row) => row.lane === lane);
    if (seed === undefined) continue;
    const replaceAt = selected.findLastIndex((row) =>
      selected.filter((candidate) => candidate.lane === row.lane).length > 1);
    if (replaceAt >= 0) selected[replaceAt] = seed;
  }
  const addresses = selected
    .sort((left, right) => lanePriority[left.lane] - lanePriority[right.lane]
      || left.address.localeCompare(right.address))
    .map((row) => row.address);
  const tokenChunks = chunks(addresses, 50);
  let tokenRows: readonly (readonly TokenBatchRow[])[];
  try {
    tokenRows = await mapConcurrent(tokenChunks, PIN_CONCURRENCY, (batch) =>
      deps.dataPlane.tokensBatch(batch, deps.signal));
  } catch {
    throw new PinUnreadableError();
  }
  if (laneReadCount + tokenChunks.length > PIN_MAX_READS) throw new PinUnreadableError();

  const tokens = new Map<string, TokenBatchRow>();
  for (const batch of tokenRows) {
    for (const token of batch) tokens.set(token.address.toLowerCase(), token);
  }
  const candidates: PinnedCandidate[] = [];
  for (const [key, row] of universeByAddress) {
    const token = tokens.get(key);
    if (token === undefined || !inModelBand(model, row, token)) continue;
    candidates.push({
      address: row.address,
      symbol: token.symbol ?? row.symbol,
      lane: row.lane,
      marketCapUsd: token.marketCapUsd,
      priceUsd: token.priceUsd,
      volume24hUsd: token.volume24hUsd,
      priceChange24hPct: token.priceChange24hPct,
      holders: token.holders,
      ...(row.marketHours === undefined ? {} : { marketHours: row.marketHours }),
    });
  }
  const pinned = rankDiversified(model, candidates).slice(0, maxGrantedTokens(model));
  if (pinned.length < MIN_PIN) throw new PinTooSmallError(pinned.length);
  return pinned;
}

export type BalanceReader = (token: Address, signal?: AbortSignal) => Promise<bigint>;

/** Any incomplete balance picture is less trustworthy than the deterministic volume order (C24). */
export async function rerankHeld(
  candidates: readonly PinnedCandidate[],
  balanceReader: BalanceReader,
  signal?: AbortSignal,
): Promise<readonly PinnedCandidate[]> {
  const bounded = candidates.slice(0, PIN_MAX_BALANCE_READS);
  try {
    const balances = await mapConcurrent(bounded, PIN_CONCURRENCY, (candidate) =>
      balanceReader(candidate.address, signal));
    return bounded
      .map((candidate, index) => ({ candidate, held: (balances[index] ?? 0n) > 0n, index }))
      .sort((left, right) => Number(right.held) - Number(left.held) || left.index - right.index)
      .map(({ candidate }) => candidate);
  } catch {
    return candidates;
  }
}

export function marketHoursByAddress(bstocksRows: readonly UniverseRow[]): ReadonlySet<string> {
  return new Set(bstocksRows.map((row) => row.address.toLowerCase()));
}

export function isUsEquityOpen(nowMs: number): boolean {
  const date = new Date(nowMs);
  const day = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return day >= 1 && day <= 5
    && minute >= US_EQUITY_HOURS_UTC.openMinute
    && minute < US_EQUITY_HOURS_UTC.closeMinute;
}

export type CandidateRefusal = {
  readonly address: Address;
  readonly reason: string;
};

export type EntryCandidate = PinnedCandidate & {
  /** True when this token's underlying is a US-listed instrument and its market is shut. */
  readonly underlyingMarketClosed: boolean;
  readonly eligibilitySource: EligibilitySource;
  readonly eligibilityVenue: EligibilityVenue | null;
  readonly routeKind: "pancake-discovery" | "pancake-v2" | "fourmeme" | "flap";
  readonly scanReasons: readonly ScanReason[];
};

type VerdictCacheEntry = { readonly expiresAtMs: number; readonly verdict: ScanVerdict };
export type TradeVerdictCache = Map<string, VerdictCacheEntry>;

export function createTradeVerdictCache(): TradeVerdictCache {
  return new Map<string, VerdictCacheEntry>();
}

const PROCESS_VERDICT_CACHE = createTradeVerdictCache();

export type SelectEntryCandidatesInput = {
  readonly model: TradeExecutionModel;
  readonly settings: Pick<TradeSettings, "minMarketCapUsd" | "maxMarketCapUsd" | "noReentry">;
  readonly candidates: readonly PinnedCandidate[];
  readonly pinnedAddresses: ReadonlySet<string>;
  readonly previouslyEnteredAddresses: ReadonlySet<string>;
  readonly openPositionAddresses: ReadonlySet<string>;
  readonly forbiddenAddresses: ReadonlySet<string>;
  readonly usEquityAddresses: ReadonlySet<string>;
  readonly dataPlane: Pick<TradeDataPlaneReads, "tokensBatch" | "eligibilityBatch" | "security">;
  readonly signal?: AbortSignal;
  readonly nowMs: number;
  readonly verdictCache?: TradeVerdictCache;
};

export type SelectEntryCandidatesResult =
  | {
      readonly kind: "selected";
      readonly candidates: readonly EntryCandidate[];
      readonly refusals: readonly CandidateRefusal[];
      readonly reads: number;
    }
  | {
      readonly kind: "aborted";
      readonly reason: "data-plane-unavailable" | "read-budget";
      readonly refusals: readonly CandidateRefusal[];
      readonly reads: number;
    };

function routeFor(row: EligibilityBatchRow): EntryCandidate["routeKind"] | null {
  switch (row.source) {
    case "allowlist":
    case "binance-alpha": return "pancake-discovery";
    case "fourmeme":
      if (row.venue === "fourmeme-bonding") return "fourmeme";
      return row.venue === "pancake-v2" ? "pancake-v2" : null;
    case "flap":
      if (row.venue === "flap-bonding") return "flap";
      return row.venue === "pancake-v2" ? "pancake-v2" : null;
    case null: return null;
  }
}

function ownerBandAllows(
  token: TokenBatchRow,
  settings: SelectEntryCandidatesInput["settings"],
): boolean {
  const cap = token.marketCapUsd;
  if (settings.minMarketCapUsd !== null && (cap === null || cap < settings.minMarketCapUsd)) return false;
  if (settings.maxMarketCapUsd !== null && (cap === null || cap > settings.maxMarketCapUsd)) return false;
  return true;
}

/** R3.4 steps 1..7; a plane failure aborts while a token denial stays local. */
export async function selectEntryCandidates(
  input: SelectEntryCandidatesInput,
): Promise<SelectEntryCandidatesResult> {
  const refusals: CandidateRefusal[] = [];
  let reads = 0;
  const consume = (): boolean => {
    if (reads >= TRADE_READ_BUDGET) return false;
    reads += 1;
    return true;
  };
  const prefiltered = input.candidates.filter((candidate) => {
    const key = candidate.address.toLowerCase();
    if (!input.pinnedAddresses.has(key)) return false;
    if (input.settings.noReentry && input.previouslyEnteredAddresses.has(key)) return false;
    if (input.openPositionAddresses.has(key) || input.forbiddenAddresses.has(key)) return false;
    // MEASURED 2026-09-03 at 13:10 UTC, US market closed: 11 of the 25 bStocks
    // quoted inside the impact limit, 3 were too thin and 11 had no pool at all.
    // The AMM never closes, so "the underlying is a US-listed instrument" is a
    // FACT ABOUT THE ASSET (the data plane's job) and not a reason to refuse a
    // swap (this plane's job). The bound that separated the three groups was
    // the 300 bps impact refusal, which reads the chain. So the window is now
    // advisory: it reaches the model as a fact and refuses nothing.
    return true;
  });
  if (prefiltered.length === 0) return { kind: "selected", candidates: [], refusals, reads };

  const tokens: TokenBatchRow[] = [];
  const eligibility: EligibilityBatchRow[] = [];
  try {
    for (const batch of chunks(prefiltered.map(({ address }) => address), 50)) {
      if (!consume()) return { kind: "aborted", reason: "read-budget", refusals, reads };
      tokens.push(...await input.dataPlane.tokensBatch(batch, input.signal));
      if (!consume()) return { kind: "aborted", reason: "read-budget", refusals, reads };
      eligibility.push(...await input.dataPlane.eligibilityBatch(batch, input.signal));
    }
  } catch {
    return { kind: "aborted", reason: "data-plane-unavailable", refusals, reads };
  }

  const tokenByAddress = new Map(tokens.map((row) => [row.address.toLowerCase(), row]));
  const eligibilityByAddress = new Map(eligibility.map((row) => [row.address.toLowerCase(), row]));
  const ranked: EntryCandidate[] = [];
  for (const candidate of prefiltered) {
    const key = candidate.address.toLowerCase();
    const token = tokenByAddress.get(key);
    const gate = eligibilityByAddress.get(key);
    if (token === undefined || gate === undefined) {
      return { kind: "aborted", reason: "data-plane-unavailable", refusals, reads };
    }
    if (!inModelBand(input.model, { ...candidate, source: "cycle" }, token) || !ownerBandAllows(token, input.settings)) {
      refusals.push({ address: candidate.address, reason: "market-cap" });
      continue;
    }
    if (!gate.eligible) {
      refusals.push({ address: candidate.address, reason: gate.reason });
      continue;
    }
    const routeKind = routeFor(gate);
    if (gate.source === null || routeKind === null) {
      refusals.push({ address: candidate.address, reason: "eligibility-route" });
      continue;
    }
    ranked.push({
      ...candidate,
      // A fact for the model, never a refusal: the pool is open even when the
      // underlying exchange is not, and the impact gate prices the difference.
      underlyingMarketClosed: input.usEquityAddresses.has(candidate.address.toLowerCase())
        && !isUsEquityOpen(input.nowMs),
      symbol: token.symbol ?? candidate.symbol,
      marketCapUsd: token.marketCapUsd,
      priceUsd: token.priceUsd,
      volume24hUsd: token.volume24hUsd,
      priceChange24hPct: token.priceChange24hPct,
      holders: token.holders,
      eligibilitySource: gate.source,
      eligibilityVenue: gate.venue,
      routeKind,
      scanReasons: [],
    });
  }
  const shortlist = rankDiversified(input.model, ranked).slice(0, TRADE_SHORTLIST_MAX);
  const cache = input.verdictCache ?? PROCESS_VERDICT_CACHE;
  const selected: EntryCandidate[] = [];
  for (const candidate of shortlist) {
    const key = candidate.address.toLowerCase();
    let verdict = cache.get(key);
    if (verdict !== undefined && verdict.expiresAtMs <= input.nowMs) {
      cache.delete(key);
      verdict = undefined;
    }
    let resolved: ScanVerdict;
    if (verdict !== undefined) {
      resolved = verdict.verdict;
    } else {
      if (!consume()) return { kind: "aborted", reason: "read-budget", refusals, reads };
      let payload: unknown;
      try {
        payload = await input.dataPlane.security(candidate.address, input.signal);
      } catch {
        return { kind: "aborted", reason: "data-plane-unavailable", refusals, reads };
      }
      resolved = evaluateSecurityPayload(payload, true);
      cache.set(key, { expiresAtMs: input.nowMs + TRADE_SCAN_TTL_SEC * 1_000, verdict: resolved });
    }
    if (resolved.verdict === "deny") {
      refusals.push({ address: candidate.address, reason: resolved.reasons[0] ?? "scan_unavailable" });
      continue;
    }
    selected.push({ ...candidate, scanReasons: resolved.reasons });
  }
  return { kind: "selected", candidates: selected, refusals, reads };
}
