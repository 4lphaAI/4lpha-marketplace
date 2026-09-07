/** Data-plane readiness for autonomous trading (TRADING-AGENT R3.9 / C35). */
import { getAddress } from "viem";
import type { DataPlaneClientOptions, DataPlaneEnvelope, FetchLike } from "../clients/dataPlane.js";
import { sanitizeMessage } from "../core/errors.js";
import type { UniverseLane } from "./dataPlaneReads.js";

export type TradeReadinessProbeResult = {
  readonly status: number;
  readonly envelope: DataPlaneEnvelope<unknown> | null;
};

export interface TradeReadinessDataPlane {
  probeUniverse(lane: "bstocks" | "allowlist", signal?: AbortSignal): Promise<TradeReadinessProbeResult>;
}

export type TradeReadiness = {
  readonly ready: boolean;
  readonly allowlistAvailable: boolean;
  readonly bstocksAddresses: ReadonlySet<string>;
  stop(): void;
};

export type CreateTradeReadinessInput = {
  readonly dataPlane: TradeReadinessDataPlane;
  readonly intervalMs?: number;
  readonly log?: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(envelope: DataPlaneEnvelope<unknown> | null, lane: UniverseLane): readonly string[] | null {
  if (envelope === null || envelope.error !== undefined || !Array.isArray(envelope.data)) return null;
  const addresses: string[] = [];
  for (const value of envelope.data) {
    if (!isRecord(value) || value["lane"] !== lane || typeof value["address"] !== "string") return null;
    try {
      addresses.push(getAddress(value["address"]).toLowerCase());
    } catch {
      return null;
    }
  }
  return addresses;
}

function allowlistIsNonEmpty(envelope: DataPlaneEnvelope<unknown> | null): boolean {
  const meta = envelope?.meta;
  if (!isRecord(meta)) return false;
  const lanes = meta["lanes"];
  if (!isRecord(lanes)) return false;
  const allowlist = lanes["allowlist"];
  return isRecord(allowlist) && allowlist["staleness"] !== null;
}

/** Network answers update state and never escape the probe loop (R3.9). */
export async function createTradeReadiness(input: CreateTradeReadinessInput): Promise<TradeReadiness> {
  const intervalMs = input.intervalMs ?? 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Trade readiness interval must be positive.");
  let ready = false;
  let allowlistAvailable = false;
  let bstocksAddresses: ReadonlySet<string> = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const probe = async (): Promise<void> => {
    try {
      const [bstocks, allowlist] = await Promise.all([
        input.dataPlane.probeUniverse("bstocks"),
        input.dataPlane.probeUniverse("allowlist"),
      ]);
      const bstockRows = bstocks.status === 200 ? rows(bstocks.envelope, "bstocks") : null;
      ready = bstockRows?.length === 25;
      bstocksAddresses = ready ? new Set(bstockRows) : new Set<string>();
      const allowlistRows = allowlist.status === 200 ? rows(allowlist.envelope, "allowlist") : null;
      const legacyUnavailable = allowlist.status === 400
        && allowlist.envelope?.error?.code === "invalid_lane";
      allowlistAvailable = !legacyUnavailable
        && allowlistRows !== null
        && allowlistRows.length > 0
        && allowlistIsNonEmpty(allowlist.envelope);
    } catch (error) {
      ready = false;
      allowlistAvailable = false;
      bstocksAddresses = new Set<string>();
      input.log?.(`[trade-readiness] probe failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`);
    }
  };

  await probe();
  if (!stopped) {
    timer = setInterval(() => { void probe(); }, intervalMs);
    timer.unref?.();
  }
  return {
    get ready() { return ready; },
    get allowlistAvailable() { return allowlistAvailable; },
    get bstocksAddresses() { return bstocksAddresses; },
    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

export function createHttpTradeReadinessDataPlane(options: DataPlaneClientOptions): TradeReadinessDataPlane {
  const baseUrl = new URL(options.baseUrl);
  const token = options.token?.trim() ?? "";
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async probeUniverse(lane, signal) {
      const target = new URL(`universe?lane=${encodeURIComponent(lane)}`, baseUrl);
      if (target.origin !== baseUrl.origin) throw new Error("Trade readiness origin changed.");
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetchFn(target.toString(), {
        method: "GET",
        headers: { accept: "application/json", ...(token === "" ? {} : { "x-dp-token": token }) },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      try {
        return { status: response.status, envelope: await response.json() as DataPlaneEnvelope<unknown> };
      } catch {
        return { status: response.status, envelope: null };
      }
    },
  };
}
