/** Thin batch reads for the trading candidate pipeline (TRADING-AGENT R3 / C23). */
import { getAddress, isHex, type Address, type Hex } from "viem";
import { InfrastructureError } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import { TRADFI_BINANCE_ROUTER_SELECTOR } from "./guard.js";
import type {
  DataPlaneClient,
  DataPlaneClientOptions,
  DataPlaneEnvelope,
  FetchLike,
} from "../clients/dataPlane.js";
import type { RwaFact } from "./rwa.js";
import { admittedVenueRows } from "./rwa.js";

export type UniverseLane = "allowlist" | "bstocks" | "coins" | "meme" | "ondo";

export type VenueRow = {
  readonly dex: "pancakeswap" | "uniswap";
  readonly version: "v2" | "v3";
  readonly pool: Address;
  readonly feeTier: number | null;
  readonly quote: Address;
  readonly quoteSymbol: string;
  readonly priceUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly asOf: number | null;
};

export type UniverseRow = {
  readonly address: Address;
  readonly symbol: string;
  readonly name?: string;
  readonly lane: UniverseLane;
  readonly source: string;
  readonly marketHours?: "us-equities";
  readonly rwa?: RwaFact;
  readonly venues?: readonly VenueRow[];
};

export type TokenBatchRow = {
  readonly address: Address;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly holders: number | null;
  readonly priceChange24hPct: number | null;
  readonly symbol?: string;
  readonly asOf?: number;
  readonly source?: string;
  readonly staleness?: "fresh" | "stale" | "dead";
  readonly updatedFields?: readonly string[];
};

export type EligibilitySource = "allowlist" | "binance-alpha" | "binance-rwa" | "fourmeme" | "flap";
export type EligibilityVenue = "fourmeme-bonding" | "flap-bonding" | "pancake-v2";

export type EligibilityBatchRow = {
  readonly address: Address;
  readonly eligible: boolean;
  readonly reason: string;
  readonly source: EligibilitySource | null;
  readonly venue: EligibilityVenue | null;
};

export type TradfiFlashQuote = {
  readonly version: "tradfi-binance-flash-v1";
  readonly chainId: 56;
  readonly taker: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountInAtomic: string;
  readonly quotedOutAtomic: string;
  readonly minOutAtomic: string;
  readonly router: Address;
  readonly spender: Address;
  readonly calldata: `0x${string}`;
  readonly value: "0";
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly estimatedGasUnits: string;
  readonly gasPriceWei: string;
  /** `null` iff {@link feeToken} is also `null` (C1): the proxy omits both together, never one alone. */
  readonly feeAmountAtomic: string | null;
  readonly feeToken: Address | null;
};

export interface TradeDataPlaneReads extends Pick<DataPlaneClient, "security"> {
  binanceSimulate?(input: { readonly from: Address; readonly to: Address; readonly data: Hex; readonly signal: AbortSignal }): Promise<TradfiSimulateResult>;
  featurePools?(signal?: AbortSignal): Promise<unknown>;
  featuresBatch?(pools: readonly Address[], interval: "15m" | "1h", signal?: AbortSignal): Promise<unknown>;
  /** AGENTIC-RFQ-STOCKS R2.4: the recorded-underlying feature index and 1..10-token batch (store-only on the data plane; a missing method is no evidence). */
  underlyingFeatureIndex?(signal?: AbortSignal): Promise<unknown>;
  underlyingFeaturesBatch?(tokens: readonly Address[], interval: "15m" | "1h", signal?: AbortSignal): Promise<unknown>;
  /** `null` is reserved for the legacy 400 `invalid_lane` allowlist response. */
  universe(lane: UniverseLane, signal?: AbortSignal): Promise<readonly UniverseRow[] | null>;
  tokensBatch(addresses: readonly Address[], signal?: AbortSignal): Promise<readonly TokenBatchRow[]>;
  eligibilityBatch(
    addresses: readonly Address[],
    signal?: AbortSignal,
  ): Promise<readonly EligibilityBatchRow[]>;
  binanceQuoteAndSwap?(input: { readonly tokenIn: Address; readonly tokenOut: Address; readonly amountAtomic: string; readonly slippageBps: number; readonly signal?: AbortSignal }): Promise<TradfiFlashQuote>;
  /** TRADFI-AI-TRADE-V3 §6.3: `GET /trading/regime/us-equity`. 404/error/stale degrades to `unavailable`, never throws. */
  usEquityRegime?(signal?: AbortSignal): Promise<UsEquityRegime>;
}

export type TradfiSimulateResult = {
  readonly status: "SUCCESS" | "FAILED"; readonly failReason: string | null;
  readonly balanceChanges: readonly { readonly token: Address; readonly owner: Address; readonly change: bigint }[];
  readonly otherChangeCount: number; readonly upstreamMs: number | null;
};

export type UsEquityRegime = {
  readonly regime: "risk_on" | "risk_off" | "neutral" | "unavailable";
  readonly reasons: readonly string[];
  readonly asOf: number | null;
};

function parseUsEquityRegime(data: unknown): UsEquityRegime {
  const UNAVAILABLE: UsEquityRegime = { regime: "unavailable", reasons: [], asOf: null };
  if (!isRecord(data)) return UNAVAILABLE;
  const regime = data["regime"];
  if (regime !== "risk_on" && regime !== "risk_off" && regime !== "neutral" && regime !== "unavailable") return UNAVAILABLE;
  const reasonsRaw = data["reasons"];
  const reasons = Array.isArray(reasonsRaw) ? reasonsRaw.filter((row): row is string => typeof row === "string") : [];
  const asOfRaw = data["asOf"];
  const asOf = typeof asOfRaw === "number" && Number.isFinite(asOfRaw) ? asOfRaw : null;
  return { regime, reasons, asOf };
}

/** A price fact is comparable only when its own producer refreshed priceUsd. */
export function freshTokenUsdFact(row: TokenBatchRow | undefined, nowMs: number, maxAgeMs = 60_000): number | null {
  if (row === undefined || row.priceUsd === null || !Number.isFinite(row.priceUsd) || row.priceUsd <= 0) return null;
  if (row.asOf === undefined || !Number.isFinite(row.asOf) || row.asOf > nowMs || nowMs - row.asOf > maxAgeMs) return null;
  if (row.staleness !== undefined && row.staleness !== "fresh") return null;
  if (row.updatedFields !== undefined && !row.updatedFields.includes("priceUsd")) return null;
  return row.priceUsd;
}

const BATCH_MAX = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function malformed(route: string): never {
  throw new InfrastructureError(`Data plane returned malformed ${route} data.`);
}

function optionalFinite(item: Record<string, unknown>, field: string): number | null | undefined {
  if (!Object.hasOwn(item, field)) return undefined;
  const value = item[field];
  if (value === null) return null;
  if (typeof value !== "number") return malformed("universe");
  return Number.isFinite(value) ? value : null;
}

function optionalNullableString(item: Record<string, unknown>, field: string): string | null {
  if (!Object.hasOwn(item, field) || item[field] === null) return null;
  if (typeof item[field] !== "string") return malformed("universe");
  return item[field] as string;
}

function optionalNullableBoolean(item: Record<string, unknown>, field: string): boolean | null {
  if (!Object.hasOwn(item, field) || item[field] === null) return null;
  if (typeof item[field] !== "boolean") return malformed("universe");
  return item[field] as boolean;
}

function parseVenue(item: unknown): VenueRow | null {
  if (!isRecord(item)) return malformed("universe");
  const dex = item["dex"];
  const version = item["version"];
  if (typeof dex !== "string" || typeof version !== "string") return malformed("universe");
  if ((dex !== "pancakeswap" && dex !== "uniswap") || (version !== "v2" && version !== "v3")) return null;
  const pool = parseAddress(item["pool"]);
  const quote = item["quote"];
  if (!isRecord(quote)) return malformed("universe");
  const quoteAddress = parseAddress(quote["address"]);
  const quoteSymbol = quote["symbol"];
  if (pool === null || quoteAddress === null || typeof quoteSymbol !== "string") return malformed("universe");
  const feeTier = item["feeTier"];
  if (feeTier !== undefined && feeTier !== null && typeof feeTier !== "number") {
    return malformed("universe");
  }
  if (typeof feeTier === "number" && Number.isFinite(feeTier) && !Number.isInteger(feeTier)) {
    return malformed("universe");
  }
  const parsedFeeTier = feeTier === undefined || feeTier === null || !Number.isFinite(feeTier as number) ? null : feeTier;
  const priceUsd = optionalFinite(item, "priceUsd");
  const liquidityUsd = optionalFinite(item, "liquidityUsd");
  const volume24hUsd = optionalFinite(item, "volume24hUsd");
  const asOf = optionalFinite(item, "asOf");
  return {
    dex,
    version,
    pool,
    feeTier: parsedFeeTier,
    quote: quoteAddress,
    quoteSymbol,
    priceUsd: priceUsd === undefined ? null : priceUsd,
    liquidityUsd: liquidityUsd === undefined ? null : liquidityUsd,
    volume24hUsd: volume24hUsd === undefined ? null : volume24hUsd,
    asOf: asOf === undefined ? null : asOf,
  };
}

function parseRwa(item: Record<string, unknown>, venues: readonly VenueRow[] | undefined): RwaFact | undefined {
  if (!Object.hasOwn(item, "platform")) return undefined;
  if (typeof item["platform"] !== "string") return malformed("universe");
  const tokenPriceUsd = optionalFinite(item, "tokenPriceUsd");
  const referencePriceUsd = optionalFinite(item, "referencePriceUsd");
  const premiumBps = optionalFinite(item, "premiumBps");
  const tokenToShareRatio = optionalFinite(item, "tokenToShareRatio");
  const staleness = optionalNullableString(item, "staleness");
  if (staleness !== null && staleness !== "fresh" && staleness !== "stale" && staleness !== "dead") {
    return malformed("universe");
  }
  const onchainPriceUsd = admittedVenueRows(venues)[0]?.priceUsd ?? null;
  return {
    platform: item["platform"] as string,
    underlyingTicker: optionalNullableString(item, "underlyingTicker"),
    tokenPriceUsd: tokenPriceUsd === undefined ? null : tokenPriceUsd,
    referencePriceUsd: referencePriceUsd === undefined ? null : referencePriceUsd,
    premiumBps: premiumBps === undefined ? null : premiumBps,
    openState: optionalNullableBoolean(item, "openState"),
    marketStatus: optionalNullableString(item, "marketStatus"),
    reasonCode: optionalNullableString(item, "reasonCode"),
    staleness,
    tokenToShareRatio: tokenToShareRatio === undefined ? null : tokenToShareRatio,
    onchainPriceUsd,
    ...(venues === undefined ? {} : { venues }),
  };
}

function parseUniverseRows(value: unknown, lane: UniverseLane): readonly UniverseRow[] {
  if (!Array.isArray(value)) return malformed("universe");
  return value.map((item) => {
    if (!isRecord(item)) return malformed("universe");
    const address = parseAddress(item["address"]);
    const symbol = item["symbol"];
    const rowLane = item["lane"];
    const source = item["source"];
    if (
      address === null
      || typeof symbol !== "string"
      || rowLane !== lane
      || typeof source !== "string"
    ) return malformed("universe");
    const name = item["name"];
    const marketHours = item["marketHours"];
    if (name !== undefined && typeof name !== "string") return malformed("universe");
    if (marketHours !== undefined && marketHours !== "us-equities") return malformed("universe");
    const venuesValue = item["venues"];
    let venues: readonly VenueRow[] | undefined;
    if (venuesValue !== undefined) {
      if (!Array.isArray(venuesValue)) return malformed("universe");
      venues = venuesValue.map(parseVenue).filter((venue): venue is VenueRow => venue !== null);
    }
    const rwa = parseRwa(item, venues);
    return {
      address,
      symbol,
      lane,
      source,
      ...(name === undefined ? {} : { name }),
      ...(marketHours === undefined ? {} : { marketHours }),
      ...(rwa === undefined ? {} : { rwa }),
      ...(venues === undefined ? {} : { venues }),
    };
  });
}

function parseTokenRows(value: unknown): readonly TokenBatchRow[] {
  if (!Array.isArray(value)) return malformed("token batch");
  return value.map((item) => {
    if (!isRecord(item)) return malformed("token batch");
    const address = parseAddress(item["address"]);
    const priceUsd = nullableFinite(item["priceUsd"]);
    const marketCapUsd = nullableFinite(item["marketCapUsd"]);
    const volume24hUsd = nullableFinite(item["volume24hUsd"]);
    const holders = nullableFinite(item["holders"]);
    const priceChange24hPct = nullableFinite(item["priceChange24hPct"]);
    const symbol = item["symbol"];
    const asOf = item["asOf"] === undefined ? undefined : nullableFinite(item["asOf"]);
    const source = item["source"] === undefined ? undefined : item["source"];
    const staleness = item["staleness"] === undefined ? undefined : item["staleness"];
    const updatedFields = item["updatedFields"] === undefined ? undefined : item["updatedFields"];
    if (
      address === null
      || priceUsd === undefined
      || marketCapUsd === undefined
      || volume24hUsd === undefined
      || holders === undefined
      || priceChange24hPct === undefined
      || (symbol !== undefined && typeof symbol !== "string")
      || (asOf !== undefined && asOf === null)
      || (source !== undefined && typeof source !== "string")
      || (staleness !== undefined && staleness !== "fresh" && staleness !== "stale" && staleness !== "dead")
      || (updatedFields !== undefined && (!Array.isArray(updatedFields) || updatedFields.some((field) => typeof field !== "string")))
    ) return malformed("token batch");
    return {
      address,
      priceUsd,
      marketCapUsd,
      volume24hUsd,
      holders,
      priceChange24hPct,
      ...(symbol === undefined ? {} : { symbol }),
      ...(asOf === undefined ? {} : { asOf }),
      ...(source === undefined ? {} : { source }),
      ...(staleness === undefined ? {} : { staleness }),
      ...(updatedFields === undefined ? {} : { updatedFields: updatedFields as readonly string[] }),
    };
  });
}

function parseTradfiFlashQuote(value: unknown): TradfiFlashQuote {
  const observedAt = isRecord(value) ? value.observedAt : undefined;
  const expiresAt = isRecord(value) ? value.expiresAt : undefined;
  if (!isRecord(value) || value.version !== "tradfi-binance-flash-v1" || value.chainId !== 56
    || typeof value.taker !== "string" || typeof value.tokenIn !== "string" || typeof value.tokenOut !== "string"
    || typeof value.amountInAtomic !== "string" || typeof value.quotedOutAtomic !== "string" || typeof value.minOutAtomic !== "string"
    || typeof value.router !== "string" || typeof value.spender !== "string" || typeof value.calldata !== "string" || !isHex(value.calldata)
    || value.value !== "0" || !Number.isSafeInteger(observedAt) || !Number.isSafeInteger(expiresAt)
    || typeof value.estimatedGasUnits !== "string" || typeof value.gasPriceWei !== "string"
    || (value.feeAmountAtomic !== null && typeof value.feeAmountAtomic !== "string")
    || (value.feeToken !== null && typeof value.feeToken !== "string")
    // C1: the pair is mandatory. The proxy omits both together for a fee-less
    // quote; exactly one side null is a malformed response, not a zero fee.
    || (value.feeAmountAtomic === null) !== (value.feeToken === null)) throw new InfrastructureError("Flash quote response was malformed.");
  const addresses = [value.taker, value.tokenIn, value.tokenOut, value.router, value.spender, value.feeToken].filter((row): row is string => typeof row === "string");
  try { addresses.forEach((row) => getAddress(row)); } catch { throw new InfrastructureError("Flash quote response contained an invalid address."); }
  if (value.feeToken !== null && value.feeToken.toLowerCase() !== (value.tokenIn as string).toLowerCase()
    && value.feeToken.toLowerCase() !== (value.tokenOut as string).toLowerCase()) {
    throw new InfrastructureError("Flash quote response fee token is neither side of the pair.");
  }
  for (const field of ["amountInAtomic", "quotedOutAtomic", "minOutAtomic", "estimatedGasUnits", "gasPriceWei"] as const) {
    if (!/^\d{1,78}$/u.test(value[field] as string)) throw new InfrastructureError("Flash quote response contained a malformed amount.");
  }
  if (value.feeAmountAtomic !== null && !/^\d{1,78}$/u.test(value.feeAmountAtomic)) {
    throw new InfrastructureError("Flash quote response contained a malformed amount.");
  }
  if (BigInt(value.amountInAtomic) <= 0n || BigInt(value.quotedOutAtomic) <= 0n || BigInt(value.minOutAtomic) <= 0n
    || BigInt(value.minOutAtomic) > BigInt(value.quotedOutAtomic) || (expiresAt as number) <= (observedAt as number)
    || (value.calldata.length - 2) / 2 > 64 * 1024 || value.calldata.slice(0, 10).toLowerCase() !== TRADFI_BINANCE_ROUTER_SELECTOR.toLowerCase()) throw new InfrastructureError("Flash quote response failed economic bounds.");
  return { version: "tradfi-binance-flash-v1", chainId: 56, taker: getAddress(value.taker), tokenIn: getAddress(value.tokenIn), tokenOut: getAddress(value.tokenOut),
    amountInAtomic: value.amountInAtomic, quotedOutAtomic: value.quotedOutAtomic, minOutAtomic: value.minOutAtomic, router: getAddress(value.router), spender: getAddress(value.spender),
    calldata: value.calldata, value: "0", observedAt: observedAt as number, expiresAt: expiresAt as number, estimatedGasUnits: value.estimatedGasUnits, gasPriceWei: value.gasPriceWei,
    feeAmountAtomic: value.feeAmountAtomic, feeToken: value.feeToken === null ? null : getAddress(value.feeToken) };
}

const ELIGIBILITY_SOURCES: ReadonlySet<unknown> = new Set([
  "allowlist", "binance-alpha", "binance-rwa", "fourmeme", "flap",
]);
const ELIGIBILITY_VENUES: ReadonlySet<unknown> = new Set([
  "fourmeme-bonding", "flap-bonding", "pancake-v2",
]);

function parseEligibilityRows(value: unknown): readonly EligibilityBatchRow[] {
  if (!Array.isArray(value)) return malformed("eligibility batch");
  return value.map((item) => {
    if (!isRecord(item)) return malformed("eligibility batch");
    const address = parseAddress(item["address"]);
    const eligible = item["eligible"];
    const reason = item["reason"];
    const source = item["source"];
    const venue = item["venue"];
    if (
      address === null
      || typeof eligible !== "boolean"
      || typeof reason !== "string"
      || (source !== null && !ELIGIBILITY_SOURCES.has(source))
      || (venue !== null && !ELIGIBILITY_VENUES.has(venue))
    ) return malformed("eligibility batch");
    return {
      address,
      eligible,
      reason,
      source: source as EligibilitySource | null,
      venue: venue as EligibilityVenue | null,
    };
  });
}

function requireBatch(addresses: readonly Address[]): void {
  if (addresses.length < 1 || addresses.length > BATCH_MAX) {
    throw new InfrastructureError("Trading data-plane batches must contain 1..50 addresses.");
  }
}

/**
 * Separate because `HttpDataPlaneClient` deliberately keeps its generic fetch
 * primitive private; this preserves the same single-origin/auth boundary (C23).
 */
export class HttpTradeDataPlaneReads implements TradeDataPlaneReads {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: DataPlaneClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#token = options.token ?? "";
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async universe(lane: UniverseLane, signal?: AbortSignal): Promise<readonly UniverseRow[] | null> {
    const response = await this.#send(`universe?lane=${encodeURIComponent(lane)}`, signal);
    if (
      lane === "allowlist"
      && response.status === 400
      && response.envelope?.error?.code === "invalid_lane"
    ) return null;
    const envelope = this.#requireOk(response, "universe");
    return parseUniverseRows(envelope.data, lane);
  }

  async tokensBatch(
    addresses: readonly Address[],
    signal?: AbortSignal,
  ): Promise<readonly TokenBatchRow[]> {
    requireBatch(addresses);
    const query = addresses.map((address) => address.toLowerCase()).join(",");
    const response = await this.#send(`tokens?addresses=${encodeURIComponent(query)}`, signal);
    return parseTokenRows(this.#requireOk(response, "tokens").data);
  }

  async eligibilityBatch(
    addresses: readonly Address[],
    signal?: AbortSignal,
  ): Promise<readonly EligibilityBatchRow[]> {
    requireBatch(addresses);
    const query = addresses.map((address) => address.toLowerCase()).join(",");
    const response = await this.#send(`eligibility?addresses=${encodeURIComponent(query)}`, signal);
    return parseEligibilityRows(this.#requireOk(response, "eligibility").data);
  }

  async binanceQuoteAndSwap(input: { readonly tokenIn: Address; readonly tokenOut: Address; readonly amountAtomic: string; readonly slippageBps: number; readonly signal?: AbortSignal }): Promise<TradfiFlashQuote> {
    if (!/^\d{1,78}$/u.test(input.amountAtomic) || BigInt(input.amountAtomic) <= 0n || !Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 300) {
      throw new InfrastructureError("The Flash quote request is invalid.");
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const composed = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(this.#url("trading/binance/quote-and-swap"), {
        method: "POST", redirect: "error", headers: { accept: "application/json", "content-type": "application/json",
          ...(this.#token === "" ? {} : { "x-dp-token": this.#token }) },
        body: JSON.stringify({ tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountAtomic: input.amountAtomic, slippageBps: input.slippageBps }), signal: composed,
      });
    } catch (cause) { throw new InfrastructureError(sanitizeMessage(`Data plane is unreachable: ${cause instanceof Error ? cause.name : "unknown"}.`)); }
    let envelope: DataPlaneEnvelope<unknown>;
    try { envelope = await response.json() as DataPlaneEnvelope<unknown>; } catch { throw new InfrastructureError("Flash quote response was malformed."); }
    if (!response.ok || envelope.data === undefined) {
      const code = envelope.error?.code ?? "binance_unavailable";
      // R2.11 (L2): carry the data plane's own reason alongside its code, so a
      // caller's `proxy:<code>` observation does not merge 429s, credential
      // failures and upstream outages into one indistinguishable string.
      throw new InfrastructureError(envelope.error?.message === undefined ? code : `${code}:${envelope.error.message}`);
    }
    return parseTradfiFlashQuote(envelope.data);
  }

  async binanceSimulate(input: { readonly from: Address; readonly to: Address; readonly data: Hex; readonly signal: AbortSignal }): Promise<TradfiSimulateResult> {
    const fail = (reason: string): never => { throw new InfrastructureError(`simulate:${reason}`); };
    let response: Response;
    try {
      response = await this.#fetch(this.#url("internal/binance/pre-transaction/simulate"), {
        method: "POST", redirect: "error", headers: { accept: "application/json", "content-type": "application/json",
          ...(this.#token === "" ? {} : { "x-dp-token": this.#token }) },
        body: JSON.stringify({ from: input.from, to: input.to, data: input.data }),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
    } catch { return fail("unavailable"); }
    if (response.status === 401) return fail("auth");
    let envelope: unknown;
    try { envelope = await response.json() as unknown; } catch { return fail(response.ok ? "malformed" : "unavailable"); }
    if (!isRecord(envelope)) return fail(response.ok ? "malformed" : "unavailable");
    if (!response.ok) {
      const error = isRecord(envelope["error"]) ? envelope["error"] : {};
      const code = error["code"], reason = error["reason"];
      if (response.status === 400 && code === "simulate_invalid_request") return fail("shape");
      if (response.status === 503) {
        if (code === "auth_not_configured") return fail("auth");
        if (code === "simulate_unavailable") {
          if (reason === "credentials_unavailable") return fail("credentials");
          if (reason === "rate_budget_exhausted" || reason === "upstream_rate_limited") return fail("rate-limited");
          if (reason === "upstream_timeout") return fail("timeout");
          if (reason === "auth_rejected") return fail("auth");
        }
      }
      if (response.status === 502 && code === "simulate_invalid_response") return fail("malformed");
      if (response.status === 502 && code === "simulate_upstream_error") return fail("upstream-error");
      return fail("unavailable");
    }
    const data = envelope["data"];
    if (!isRecord(data) || data["version"] !== "binance-simulate-v1" || (data["status"] !== "SUCCESS" && data["status"] !== "FAILED")) return fail("malformed");
    const status = data["status"], failReason = data["failReason"], changes = data["balanceChanges"], other = data["otherChangeCount"];
    if ((failReason !== null && (typeof failReason !== "string" || failReason.length > 2_048)) || (status === "SUCCESS" && failReason !== null)
      || !Array.isArray(changes) || changes.length > 64 || typeof other !== "number" || !Number.isInteger(other) || other < 0 || other > 64) return fail("malformed");
    const balanceChanges: { token: Address; owner: Address; change: bigint }[] = [];
    for (const row of changes) {
      if (!isRecord(row)) return fail("malformed");
      const token = parseAddress(row["token"]), owner = parseAddress(row["owner"]), raw = row["change"];
      if (token === null || owner === null || typeof raw !== "string" || !/^-?(0|[1-9][0-9]{0,77})$/u.test(raw)) return fail("malformed");
      const change = BigInt(raw);
      if (change <= -(1n << 256n) || change >= (1n << 256n)) return fail("malformed");
      balanceChanges.push({ token, owner, change });
    }
    const meta = envelope["meta"];
    const ms = isRecord(meta) ? meta["upstreamMs"] : undefined;
    if (ms !== undefined && ms !== null && (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 60_000)) return fail("malformed");
    return { status, failReason: failReason as string | null, balanceChanges, otherChangeCount: other, upstreamMs: typeof ms === "number" ? ms : null };
  }

  async featurePools(signal?: AbortSignal): Promise<unknown> {
    return this.#requireOk(await this.#send("trading/features/v2/pools", signal), "feature index").data;
  }

  async featuresBatch(pools: readonly Address[], interval: "15m" | "1h", signal?: AbortSignal): Promise<unknown> {
    if (pools.length < 1 || pools.length > 10) throw new InfrastructureError("Feature batches require 1..10 pools.");
    const query = pools.map(pool => pool.toLowerCase()).join(",");
    return this.#requireOk(await this.#send(`trading/features/v2?pools=${encodeURIComponent(query)}&interval=${interval}`, signal), "features").data;
  }

  async underlyingFeatureIndex(signal?: AbortSignal): Promise<unknown> {
    return this.#requireOk(await this.#send("trading/underlying-features/v1/tokens", signal), "underlying feature index").data;
  }

  async underlyingFeaturesBatch(tokens: readonly Address[], interval: "15m" | "1h", signal?: AbortSignal): Promise<unknown> {
    if (tokens.length < 1 || tokens.length > 10) throw new InfrastructureError("Underlying feature batches require 1..10 tokens.");
    const query = tokens.map(token => token.toLowerCase()).join(",");
    return this.#requireOk(await this.#send(`trading/underlying-features/v1?tokens=${encodeURIComponent(query)}&interval=${interval}`, signal), "underlying features").data;
  }

  async usEquityRegime(signal?: AbortSignal): Promise<UsEquityRegime> {
    try {
      const response = await this.#send("trading/regime/us-equity", signal);
      if (response.status === 404 || response.envelope === null || response.envelope.error !== undefined) {
        return { regime: "unavailable", reasons: [], asOf: null };
      }
      if (response.status < 200 || response.status >= 300) return { regime: "unavailable", reasons: [], asOf: null };
      if (response.envelope.meta?.["staleness"] === "dead" || response.envelope.meta?.["staleness"] === "stale") {
        return { regime: "unavailable", reasons: [], asOf: null };
      }
      return parseUsEquityRegime(response.envelope.data);
    } catch {
      return { regime: "unavailable", reasons: [], asOf: null };
    }
  }

  async security(address: string, signal?: AbortSignal): Promise<unknown | null> {
    const response = await this.#send(`security/${encodeURIComponent(address)}`, signal);
    if (response.status === 404) return null;
    return this.#requireOk(response, "security").data ?? null;
  }

  #url(path: string): string {
    const base = new URL(this.#baseUrl.toString());
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const target = new URL(path, base);
    if (target.origin !== base.origin) {
      throw new InfrastructureError("Refusing a trading data-plane request outside its origin.");
    }
    return target.toString();
  }

  async #send(path: string, signal?: AbortSignal): Promise<{
    readonly status: number;
    readonly envelope: DataPlaneEnvelope<unknown> | null;
  }> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(this.#url(path), {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          ...(this.#token === "" ? {} : { "x-dp-token": this.#token }),
        },
        signal: composed,
      });
    } catch (cause) {
      throw new InfrastructureError(sanitizeMessage(
        `Data plane is unreachable: ${cause instanceof Error ? cause.name : "unknown"}.`,
      ));
    }
    try {
      return { status: response.status, envelope: await response.json() as DataPlaneEnvelope<unknown> };
    } catch {
      return { status: response.status, envelope: null };
    }
  }

  #requireOk(
    response: { readonly status: number; readonly envelope: DataPlaneEnvelope<unknown> | null },
    route: string,
  ): DataPlaneEnvelope<unknown> {
    if (response.status < 200 || response.status >= 300) {
      throw new InfrastructureError(`Data plane returned status ${response.status} for ${route}.`);
    }
    if (response.envelope === null || response.envelope.error !== undefined) {
      throw new InfrastructureError(`Data plane returned an unreadable ${route} envelope.`);
    }
    return response.envelope;
  }
}
