/** Thin batch reads for the trading candidate pipeline (TRADING-AGENT R3 / C23). */
import { getAddress, type Address } from "viem";
import { InfrastructureError } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import type {
  DataPlaneClient,
  DataPlaneClientOptions,
  DataPlaneEnvelope,
  FetchLike,
} from "../clients/dataPlane.js";

export type UniverseLane = "allowlist" | "bstocks" | "coins" | "meme";

export type UniverseRow = {
  readonly address: Address;
  readonly symbol: string;
  readonly name?: string;
  readonly lane: UniverseLane;
  readonly source: string;
  readonly marketHours?: "us-equities";
};

export type TokenBatchRow = {
  readonly address: Address;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly holders: number | null;
  readonly priceChange24hPct: number | null;
  readonly symbol?: string;
};

export type EligibilitySource = "allowlist" | "binance-alpha" | "fourmeme" | "flap";
export type EligibilityVenue = "fourmeme-bonding" | "flap-bonding" | "pancake-v2";

export type EligibilityBatchRow = {
  readonly address: Address;
  readonly eligible: boolean;
  readonly reason: string;
  readonly source: EligibilitySource | null;
  readonly venue: EligibilityVenue | null;
};

export interface TradeDataPlaneReads extends Pick<DataPlaneClient, "security"> {
  featurePools?(signal?: AbortSignal): Promise<unknown>;
  featuresBatch?(pools: readonly Address[], interval: "15m" | "1h", signal?: AbortSignal): Promise<unknown>;
  /** `null` is reserved for the legacy 400 `invalid_lane` allowlist response. */
  universe(lane: UniverseLane, signal?: AbortSignal): Promise<readonly UniverseRow[] | null>;
  tokensBatch(addresses: readonly Address[], signal?: AbortSignal): Promise<readonly TokenBatchRow[]>;
  eligibilityBatch(
    addresses: readonly Address[],
    signal?: AbortSignal,
  ): Promise<readonly EligibilityBatchRow[]>;
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
    return {
      address,
      symbol,
      lane,
      source,
      ...(name === undefined ? {} : { name }),
      ...(marketHours === undefined ? {} : { marketHours }),
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
    if (
      address === null
      || priceUsd === undefined
      || marketCapUsd === undefined
      || volume24hUsd === undefined
      || holders === undefined
      || priceChange24hPct === undefined
      || (symbol !== undefined && typeof symbol !== "string")
    ) return malformed("token batch");
    return {
      address,
      priceUsd,
      marketCapUsd,
      volume24hUsd,
      holders,
      priceChange24hPct,
      ...(symbol === undefined ? {} : { symbol }),
    };
  });
}

const ELIGIBILITY_SOURCES: ReadonlySet<unknown> = new Set([
  "allowlist", "binance-alpha", "fourmeme", "flap",
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

  async featurePools(signal?: AbortSignal): Promise<unknown> {
    return this.#requireOk(await this.#send("trading/features/v2/pools", signal), "feature index").data;
  }

  async featuresBatch(pools: readonly Address[], interval: "15m" | "1h", signal?: AbortSignal): Promise<unknown> {
    if (pools.length < 1 || pools.length > 10) throw new InfrastructureError("Feature batches require 1..10 pools.");
    const query = pools.map(pool => pool.toLowerCase()).join(",");
    return this.#requireOk(await this.#send(`trading/features/v2?pools=${encodeURIComponent(query)}&interval=${interval}`, signal), "features").data;
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
