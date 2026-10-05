import { EQUITY_WRAPPERS } from "./classification.js";
/** Trading candidate admission and per-cycle selection (TRADING-AGENT R3 / R3.4). */
import type { Address } from "viem";
import { evaluateSecurityPayload, type ScanReason, type ScanVerdict } from "../rules/scanGate.js";
import { maxGrantedTokens } from "./sizing.js";
import { admittedVenueRows, rwaEntryVerdict, type RwaFact } from "./rwa.js";
import type { TradeExecutionModel, TradeSettings } from "./settings.js";
import type {
  EligibilityBatchRow,
  EligibilitySource,
  EligibilityVenue,
  TokenBatchRow,
  TradeDataPlaneReads,
  UniverseLane,
  UniverseRow,
  VenueRow,
} from "./dataPlaneReads.js";

export const PIN_MAX_READS = 16;
export const PIN_MAX_BALANCE_READS = 69;
export const PIN_CONCURRENCY = 4;
export const MIN_PIN = 5;
export const US_EQUITY_REGULAR_SESSION_ET = { openMinute: 570, closeMinute: 960 } as const;
export const TRADE_READ_BUDGET = 24;
export const TRADE_SHORTLIST_MAX = 12;
export const TRADE_SCAN_TTL_SEC = 300;

const NON_ENTRY_TOKEN_ADDRESSES: ReadonlySet<string> = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB route anchor
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", // BTCB
]);

const NON_ENTRY_TOKEN_SYMBOLS: ReadonlySet<string> = new Set([
  "USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD", "USDE", "USDS",
  "USDP", "USDD", "FRAX", "LUSD", "CRVUSD", "USD1",
]);

/** Candidate-only exclusions; USDT remains usable as an internal route hop. */
export function isEntryExcludedToken(address: string, symbol?: string, lane?: UniverseLane): boolean {
  if (NON_ENTRY_TOKEN_ADDRESSES.has(address.toLowerCase())
    || (EQUITY_WRAPPERS.has(address.toLowerCase()) && lane !== "ondo" && lane !== "bstocks")) return true;
  if (typeof symbol !== "string") return false;
  return NON_ENTRY_TOKEN_SYMBOLS.has(symbol.trim().toUpperCase());
}

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

/** A bounded v2 capability census could not finish before the hire read window. */
export class TradfiCapabilityIncompleteError extends Error {
  constructor() {
    super("The TradFi v2 capability preview is incomplete; retry the preview.");
    this.name = "TradfiCapabilityIncompleteError";
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
  readonly underlyingTicker?: string;
  readonly platform?: string;
  readonly venues?: readonly VenueRow[];
};

export type PinUniverseDeps = {
  readonly dataPlane: Pick<TradeDataPlaneReads, "universe" | "tokensBatch">;
  readonly signal?: AbortSignal;
  /** Optional v2-only guard probe; its presence also admits guard-only rows. */
  readonly tradfiV2CapabilityProbe?: (candidate: PinnedCandidate, signal?: AbortSignal) => Promise<boolean>;
};

export function lanesFor(model: TradeExecutionModel): readonly UniverseLane[] {
  switch (model) {
    case "tradfi": return ["bstocks", "ondo"];
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

function deepestLiquidity(candidate: PinnedCandidate): number {
  return admittedVenueRows(candidate.venues)[0]?.liquidityUsd ?? 0;
}

function tradfiCompare(left: PinnedCandidate, right: PinnedCandidate): number {
  const leftLiquidity = deepestLiquidity(left);
  const rightLiquidity = deepestLiquidity(right);
  return rightLiquidity > leftLiquidity ? 1 : rightLiquidity < leftLiquidity ? -1
    : left.address.localeCompare(right.address);
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

export function inModelBand(model: TradeExecutionModel, row: UniverseRow, token: TokenBatchRow): boolean {
  const cap = token.marketCapUsd;
  switch (model) {
    case "tradfi": return row.lane === "bstocks" || row.lane === "ondo";
    case "blue-chip": return row.lane === "bstocks" || (cap !== null && cap > 1_000_000_000);
    case "mid-cap": return cap !== null && cap >= 10_000_000 && cap <= 1_000_000_000;
    case "degen": return cap !== null && cap < 1_000_000;
    case "sigma": return true;
  }
}

export type PinUniverseOptions = {
  /** G2: overrides `lanesFor(model)` — Schedule mode reads bStocks only. */
  readonly lanes?: readonly UniverseLane[];
  /**
   * G3: set only in schedule mode. When true, the v2 capability probe runs
   * over every ranked candidate instead of the top 28, and the pinned result
   * is not cut back to 28 — a pool-less bStock sorted past position 28 can
   * still reach the schedule pin.
   */
  readonly probeAll?: boolean;
};

/** Owner-independent stage cached by the hire flow; C23 keeps balances outside it. */
export async function pinUniverse(
  model: TradeExecutionModel,
  deps: PinUniverseDeps,
  options?: PinUniverseOptions,
): Promise<readonly PinnedCandidate[]> {
  const lanes = options?.lanes ?? lanesFor(model);
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

  // TradFi has bStocks address precedence; legacy models retain the existing
  // later-lane behavior so their static bStocks row supplies market-hours identity.
  const universeByAddress = new Map<string, UniverseRow>();
  for (const rows of laneRows) {
    if (rows === null) continue;
    for (const row of rows) {
      const key = row.address.toLowerCase();
      if (model === "tradfi" && universeByAddress.has(key)) continue;
      universeByAddress.set(key, row);
    }
  }

  const laneReadCount = lanes.length;
  const tokenReadLimit = Math.min(PIN_MAX_READS - 4, PIN_MAX_READS - laneReadCount);
  // AUDIT M2: under the fixed read ceiling, deterministic custody relevance wins:
  // bStocks and allowlist first, then meme, coins and Ondo; one seed keeps every nonempty lane represented.
  const lanePriority: Readonly<Record<UniverseLane, number>> = { bstocks: 0, allowlist: 1, meme: 2, coins: 3, ondo: 4 };
  const ranked = [...universeByAddress.values()]
    .sort((left, right) => lanePriority[left.lane] - lanePriority[right.lane]
      || left.address.localeCompare(right.address));
  const capacity = tokenReadLimit * 50;
  const selected = ranked.slice(0, capacity);
  for (const lane of ["bstocks", "allowlist", "meme", "coins", "ondo"] as const) {
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
    const venues = row.venues ?? row.rwa?.venues;
    if (model === "tradfi" && (row.rwa === undefined || row.rwa.openState !== true
      || row.rwa.reasonCode !== "TRADING"
      || (admittedVenueRows(venues).length === 0 && deps.tradfiV2CapabilityProbe === undefined))) continue;
    if (isEntryExcludedToken(row.address, token.symbol, row.lane)) continue;
    const ticker = row.rwa?.underlyingTicker?.trim().toUpperCase();
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
      ...(ticker === undefined || ticker === "" ? {} : { underlyingTicker: ticker }),
      ...(row.rwa?.platform === undefined ? {} : { platform: row.rwa.platform }),
      ...(venues === undefined ? {} : { venues }),
    });
  }
  let rankedCandidates = candidates;
  if (model === "tradfi") {
    const groups = new Map<string, PinnedCandidate[]>();
    for (const candidate of candidates) {
      const key = candidate.underlyingTicker ?? candidate.address.toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }
    rankedCandidates = [...groups.values()].map((group) => group.sort((left, right) =>
      (left.lane === "bstocks" ? 0 : 1) - (right.lane === "bstocks" ? 0 : 1)
      || tradfiCompare(left, right))[0]!).filter((candidate): candidate is PinnedCandidate => candidate !== undefined)
      .sort(tradfiCompare);
  }
  if (model === "tradfi" && deps.tradfiV2CapabilityProbe !== undefined) {
    const probeCandidates = options?.probeAll === true ? rankedCandidates : rankedCandidates.slice(0, 28);
    let probeResults: readonly boolean[];
    try {
      probeResults = await mapConcurrent(probeCandidates, 4, (candidate) =>
        deps.tradfiV2CapabilityProbe!(candidate, deps.signal));
    } catch {
      throw new TradfiCapabilityIncompleteError();
    }
    rankedCandidates = probeCandidates.filter((_candidate, index) => probeResults[index] === true);
  }
  const pinned = (model === "tradfi" ? rankedCandidates : rankDiversified(model, rankedCandidates))
    .slice(0, options?.probeAll === true ? rankedCandidates.length
      : model === "tradfi" && deps.tradfiV2CapabilityProbe !== undefined ? 28 : maxGrantedTokens(model));
  if (pinned.length < MIN_PIN) throw new PinTooSmallError(pinned.length);
  return pinned;
}

/**
 * R2.3 (H2): one list feeds both the grant and its sizing. G3's schedule pin
 * is no longer cut to 28, so a caller that separately cuts `pinned` for
 * sizing and grants the uncut list (or vice versa) can grant more tokens than
 * it sized for, or drop the chosen token past position 28. The chosen token
 * always goes first.
 */
export function scheduleGrantList(
  pinned: readonly PinnedCandidate[],
  chosen: PinnedCandidate,
): readonly PinnedCandidate[] {
  const key = chosen.address.toLowerCase();
  return [chosen, ...pinned.filter((candidate) => candidate.address.toLowerCase() !== key)]
    .slice(0, maxGrantedTokens("tradfi"));
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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "NaN");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "NaN");
  const localMinute = hour * 60 + minute;
  return weekday !== "Sat" && weekday !== "Sun" && weekday !== undefined
    && localMinute >= US_EQUITY_REGULAR_SESSION_ET.openMinute
    && localMinute < US_EQUITY_REGULAR_SESSION_ET.closeMinute;
}

export function rwaMarketClosed(fact: RwaFact | undefined, nowMs: number): boolean {
  if (typeof fact?.marketStatus === "string") return fact.marketStatus !== "regular";
  return !isUsEquityOpen(nowMs);
}

export type CandidateRefusal = {
  readonly address: Address;
  readonly reason: string;
};

export type EntryCandidate = PinnedCandidate & {
  /** True when this token's underlying is a US-listed instrument and its market is shut. */
  readonly underlyingMarketClosed: boolean;
  readonly rwaNote: string | null;
  readonly marketStatus?: string | null;
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
  readonly settings: Pick<TradeSettings, "minMarketCapUsd" | "maxMarketCapUsd" | "noReentry" | "settlementAsset">;
  readonly candidates: readonly PinnedCandidate[];
  readonly pinnedAddresses: ReadonlySet<string>;
  readonly previouslyEnteredAddresses: ReadonlySet<string>;
  readonly openPositionAddresses: ReadonlySet<string>;
  readonly forbiddenAddresses: ReadonlySet<string>;
  readonly rwaAddresses: ReadonlySet<string>;
  readonly rwaFacts: ReadonlyMap<string, RwaFact>;
  readonly dataPlane: Pick<TradeDataPlaneReads, "tokensBatch" | "eligibilityBatch" | "security">;
  readonly signal?: AbortSignal;
  readonly nowMs: number;
  readonly verdictCache?: TradeVerdictCache;
  /**
   * AGENTIC-RFQ-STOCKS E5 (lowercase addresses): the pool-less stocks of an RFQ-active Agentic AI agent. Absent, this function is byte-identical to before.
   * Present: their verdict ignores the dust-pool premium, the shortlist is the first 12 pooled plus every RFQ-only token, and the read budget grows by the RFQ-only tokens shortlisted.
   */
  readonly rfqOnly?: ReadonlySet<string>;
};

/**
 * What the owner's OWN rules removed before the data plane saw anything.
 *
 * An observation, never an input to selection. It exists because the run log
 * could not explain a shrinking universe: on 2026-09-15 a Sigma agent showed
 * "13 skipped/refused" every cycle while twelve more of its twenty-five pinned
 * tokens had been dropped in silence by `noReentry` — the owner's rule, not a
 * refusal — and nothing on the page said where they went.
 */
export type PinnedPrefilterSummary = {
  /** Pinned tokens offered to this cycle, before any rule. */
  readonly pinned: number;
  /** Skipped because they were entered once and `noReentry` is on; checksummed. */
  readonly skippedReentry: readonly Address[];
  /** Skipped because a position (or a pending buy) is already open on them. */
  readonly skippedOpen: number;
  /** Skipped because the plane forbids them (exit-only assets, forbidden lists). */
  readonly skippedForbidden: number;
};

export type SelectEntryCandidatesResult =
  | {
      readonly kind: "selected";
      readonly candidates: readonly EntryCandidate[];
      readonly refusals: readonly CandidateRefusal[];
      readonly reads: number;
      readonly prefilter: PinnedPrefilterSummary;
    }
  | {
      readonly kind: "aborted";
      readonly reason: "data-plane-unavailable" | "read-budget";
      readonly refusals: readonly CandidateRefusal[];
      readonly reads: number;
      readonly prefilter: PinnedPrefilterSummary;
    };

/**
 * R3.4 step 1: the owner's and the plane's own rules, applied to the pinned
 * universe BEFORE any read. Pure and exported so the worker's run log reports
 * the same partition the selector acted on, rather than a second copy of it.
 * Each token is reported under ONE reason, the most specific first: a token
 * with a position open on it is "open" whether or not it was also entered
 * before, since that is the fact the owner can see on the page. The three
 * tests drop the same tokens in any order; only the label depends on it.
 */
export function partitionPinnedCandidates(
  input: Pick<SelectEntryCandidatesInput, "settings" | "candidates" | "pinnedAddresses" | "previouslyEnteredAddresses" | "openPositionAddresses" | "forbiddenAddresses">,
): { readonly kept: readonly PinnedCandidate[]; readonly summary: PinnedPrefilterSummary } {
  const kept: PinnedCandidate[] = [];
  const skippedReentry: Address[] = [];
  let pinned = 0;
  let skippedOpen = 0;
  let skippedForbidden = 0;
  // `forEach`, not `for…of`: the `.filter()` this replaces skipped array holes,
  // and the review (TRADE-RUNLOG-OWNER-RULES-REVIEW) kept that equivalence as
  // its one condition — a sparse `candidates` must not throw before any read.
  input.candidates.forEach((candidate) => {
    const key = candidate.address.toLowerCase();
    if (!input.pinnedAddresses.has(key)) return;
    pinned += 1;
    if (input.openPositionAddresses.has(key)) { skippedOpen += 1; return; }
    if (input.settings.noReentry && input.previouslyEnteredAddresses.has(key)) { skippedReentry.push(candidate.address); return; }
    if (input.forbiddenAddresses.has(key)) { skippedForbidden += 1; return; }
    // MEASURED 2026-09-03 at 13:10 UTC, US market closed: 11 of the 25 bStocks
    // quoted inside the impact limit, 3 were too thin and 11 had no pool at all.
    // The AMM never closes, so "the underlying is a US-listed instrument" is a
    // FACT ABOUT THE ASSET (the data plane's job) and not a reason to refuse a
    // swap (this plane's job). The bound that separated the three groups was
    // the 300 bps impact refusal, which reads the chain. So the window is now
    // advisory: it reaches the model as a fact and refuses nothing.
    kept.push(candidate);
  });
  return { kept, summary: { pinned, skippedReentry, skippedOpen, skippedForbidden } };
}

function routeFor(row: EligibilityBatchRow): EntryCandidate["routeKind"] | null {
  switch (row.source) {
    case "allowlist":
    case "binance-alpha": return "pancake-discovery";
    case "binance-rwa": return "pancake-discovery";
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
  let budget = TRADE_READ_BUDGET;
  const consume = (): boolean => {
    if (reads >= budget) return false;
    reads += 1;
    return true;
  };
  const { kept: prefiltered, summary: prefilter } = partitionPinnedCandidates(input);
  const rwaAddresses = input.rwaAddresses;
  const rwaFacts = input.rwaFacts;
  const classified: PinnedCandidate[] = [];
  const rwaNotes = new Map<string, string | null>();
  for (const candidate of prefiltered) {
    const key = candidate.address.toLowerCase();
    if (!rwaAddresses.has(key)) {
      classified.push(candidate);
      continue;
    }
    const rfqFact = rwaFacts.get(key);
    // E5: an RFQ-only token never reads the dust-pool premium of its row; the executed-quote premium decides, so a row with a reference and a ratio is allowed as premium:deferred.
    const verdict = input.rfqOnly?.has(key) === true
      ? rwaEntryVerdict(rfqFact === undefined ? undefined : { ...rfqFact, premiumBps: null }, input.nowMs, { allowVenueMissing: true, deferUnknownPremium: true })
      : rwaEntryVerdict(rwaFacts.get(key), input.nowMs,
      input.model === "tradfi" && input.settings.settlementAsset === "USDT" ? { allowVenueMissing: true } : {});
    if (verdict.kind === "refuse") {
      refusals.push({ address: candidate.address, reason: verdict.reason });
      continue;
    }
    rwaNotes.set(key, verdict.note);
    classified.push(candidate);
  }
  if (classified.length === 0) return { kind: "selected", candidates: [], refusals, reads, prefilter };

  const tokens: TokenBatchRow[] = [];
  const eligibility: EligibilityBatchRow[] = [];
  try {
    for (const batch of chunks(classified.map(({ address }) => address), 50)) {
      if (!consume()) return { kind: "aborted", reason: "read-budget", refusals, reads, prefilter };
      tokens.push(...await input.dataPlane.tokensBatch(batch, input.signal));
      if (!consume()) return { kind: "aborted", reason: "read-budget", refusals, reads, prefilter };
      eligibility.push(...await input.dataPlane.eligibilityBatch(batch, input.signal));
    }
  } catch {
    return { kind: "aborted", reason: "data-plane-unavailable", refusals, reads, prefilter };
  }

  const tokenByAddress = new Map(tokens.map((row) => [row.address.toLowerCase(), row]));
  const eligibilityByAddress = new Map(eligibility.map((row) => [row.address.toLowerCase(), row]));
  const ranked: EntryCandidate[] = [];
  for (const candidate of classified) {
    const key = candidate.address.toLowerCase();
    const fact = rwaFacts.get(key);
    const marketStatus = fact?.marketStatus;
    const token = tokenByAddress.get(key);
    const gate = eligibilityByAddress.get(key);
    if (token === undefined || gate === undefined) {
      return { kind: "aborted", reason: "data-plane-unavailable", refusals, reads, prefilter };
    }
    if (isEntryExcludedToken(candidate.address, token.symbol, candidate.lane)) {
      refusals.push({ address: candidate.address, reason: "non-entry-asset" });
      continue;
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
      underlyingMarketClosed: rwaAddresses.has(key) ? rwaMarketClosed(fact, input.nowMs) : false,
      rwaNote: rwaNotes.get(key) ?? null,
      ...(marketStatus === undefined ? {} : { marketStatus }),
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
  const ordered = input.model === "tradfi" ? ranked : rankDiversified(input.model, ranked);
  const rfqOnly = input.rfqOnly;
  const shortlist = rfqOnly === undefined ? ordered.slice(0, TRADE_SHORTLIST_MAX)
    : [...ordered.filter((candidate) => !rfqOnly.has(candidate.address.toLowerCase())).slice(0, TRADE_SHORTLIST_MAX), ...ordered.filter((candidate) => rfqOnly.has(candidate.address.toLowerCase()))];
  if (rfqOnly !== undefined) budget = TRADE_READ_BUDGET + shortlist.filter((candidate) => rfqOnly.has(candidate.address.toLowerCase())).length;
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
      if (!consume()) return { kind: "aborted", reason: "read-budget", refusals, reads, prefilter };
      let payload: unknown;
      try {
        payload = await input.dataPlane.security(candidate.address, input.signal);
      } catch {
        return { kind: "aborted", reason: "data-plane-unavailable", refusals, reads, prefilter };
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
  return { kind: "selected", candidates: selected, refusals, reads, prefilter };
}
