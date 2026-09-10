/**
 * The TermiX Quant REST client — the ONLY module that knows
 * `QUANT_API_BASE_URL` (spec §3.1, R2.10, R2.11, R8.2 BC35).
 *
 * ─── A SEAM, NOT A SINGLETON ───────────────────────────────────────────────
 *
 * `runQuantWorkerOnce` takes a {@link QuantTransport} as a DEPENDENCY and has
 * no other way to reach TermiX. That is what makes the mainnet self-test
 * honest: `live-quant self-test` serves an IN-MEMORY transport whose
 * `config()` / `agentKey()` return the pinned block and our own key, and the
 * worker then runs its normal boot checks and its normal cycle through the
 * SAME parsers, the SAME admission and the SAME execution path (R2.10 / BC36).
 *
 * ─── EVERY RESPONSE IS PARSED, NEVER TRUSTED ───────────────────────────────
 *
 * Non-throwing parsers, one per endpoint. A field this build does not
 * understand is a REFUSAL with the field named (`wire-invalid`), never a
 * best-effort read: `allocationU` decides how much of a stranger's money the
 * ladder commits, and `sessionExpiresAt` decides whether we may act at all.
 *
 * ─── EGRESS ────────────────────────────────────────────────────────────────
 *
 * `redirect: "error"` on every request, and the FINAL URL is checked against
 * the one-entry origin allowlist before the body is read — an allowlist a 302
 * can leave is not one (H11 / BC35).
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { QUANT_API_ORIGINS_ALLOWED } from "./config.js";
import type {
  QuantIndexerTrade,
  QuantInboxItem,
  QuantJobRecord,
} from "./types.js";

export type QuantTransportError = {
  readonly ok: false;
  readonly code:
    | "transport-unavailable"
    | "transport-unauthorized"
    | "transport-refused"
    | "wire-invalid";
  /** The offending FIELD name when the code is `wire-invalid`. Never a value. */
  readonly detail?: string;
};

export type QuantTransportResult<T> = { readonly ok: true; readonly data: T } | QuantTransportError;

export type QuantConfigBlock = {
  readonly chainId: number;
  readonly u: Address;
  readonly uDecimals: number;
  readonly tradableTokens: readonly {
    readonly address: Address;
    readonly decimals: number;
    readonly priceRoute: string;
  }[];
  readonly venueAllowlist: readonly Address[];
};

export type QuantAgentKeyBlock = {
  readonly encryptionPublicKey: string | null;
  readonly algorithm: string | null;
};

export type QuantReportPayload = {
  readonly trades: readonly { readonly txHash: Hex; readonly note: string }[];
};

export type QuantReportAck = {
  readonly status: string;
  readonly notesApplied: number | null;
};

/**
 * Everything the worker may ask TermiX. Six methods, no more: a seam that can
 * grow a method at a call site is a seam the self-test does not cover.
 */
export interface QuantTransport {
  config(): Promise<QuantTransportResult<QuantConfigBlock>>;
  agentKey(agentId: string): Promise<QuantTransportResult<QuantAgentKeyBlock>>;
  registerKey(input: {
    readonly agentId: string;
    readonly encryptionPublicKey: string;
    readonly algorithm: string;
  }): Promise<QuantTransportResult<QuantAgentKeyBlock>>;
  inbox(agentId: string, cursor?: string): Promise<QuantTransportResult<{
    readonly items: readonly QuantInboxItem[];
    readonly nextCursor: string | null;
  }>>;
  job(quantJobId: string): Promise<QuantTransportResult<QuantJobRecord>>;
  trades(quantJobId: string): Promise<QuantTransportResult<readonly QuantIndexerTrade[]>>;
  report(
    quantJobId: string,
    payload: QuantReportPayload,
  ): Promise<QuantTransportResult<QuantReportAck>>;
}

/* -------------------------------------------------------------------------- */
/* Parsers                                                                    */
/* -------------------------------------------------------------------------- */

function invalid(detail: string): QuantTransportError {
  return { ok: false, code: "wire-invalid", detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A decimal token amount → wei, STRICTLY (R2.8).
 *
 * Digits, at most one point, at most `decimals` fractional digits. Anything
 * else refuses the JOB. `Number()` is never involved: `allocationU` can be
 * larger than `Number.MAX_SAFE_INTEGER` in wei, and a float round trip is how
 * an allocation quietly becomes a different allocation.
 */
export function parseDecimalToWei(
  raw: unknown,
  decimals: number,
): bigint | null {
  const text = typeof raw === "number" && Number.isFinite(raw)
    ? String(raw)
    : typeof raw === "string" ? raw.trim() : null;
  if (text === null || text === "") return null;
  if (!/^[0-9]+(\.[0-9]+)?$/u.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  const padded = fraction.padEnd(decimals, "0");
  return BigInt(whole ?? "0") * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
}

/** ISO-8601 → epoch ms, or `null` when absent. `NaN` refuses. */
function parseTimestamp(raw: unknown): number | null | "invalid" {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : "invalid";
  }
  if (typeof raw !== "string") return "invalid";
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? "invalid" : parsed;
}

function parseAddress(raw: unknown): Address | null {
  if (typeof raw !== "string" || !isAddress(raw, { strict: false })) return null;
  return getAddress(raw);
}

export function parseQuantJob(
  value: unknown,
  uDecimals: number,
): QuantTransportResult<QuantJobRecord> {
  if (!isRecord(value)) return invalid("job");
  const id = value["id"];
  if (typeof id !== "string" || id === "") return invalid("id");
  const status = value["status"];
  if (typeof status !== "string" || status === "") return invalid("status");
  const strategyId = value["strategyId"];
  if (typeof strategyId !== "string" || strategyId === "") return invalid("strategyId");
  const wallet = parseAddress(value["tradingWalletAddress"]);
  if (wallet === null) return invalid("tradingWalletAddress");
  const allocation = parseDecimalToWei(value["allocationU"], uDecimals);
  if (allocation === null) return invalid("allocationU");
  const dailyCap = parseDecimalToWei(value["dailyCapU"], uDecimals);
  if (dailyCap === null) return invalid("dailyCapU");
  const termDays = value["termDays"];
  if (typeof termDays !== "number" || !Number.isSafeInteger(termDays) || termDays <= 0) {
    return invalid("termDays");
  }
  const startedAt = parseTimestamp(value["startedAt"]);
  if (startedAt === "invalid") return invalid("startedAt");
  const endsAt = parseTimestamp(value["endsAt"]);
  if (endsAt === "invalid") return invalid("endsAt");
  const sessionExpiresAt = parseTimestamp(value["sessionExpiresAt"]);
  if (sessionExpiresAt === "invalid") return invalid("sessionExpiresAt");
  const revokedAt = parseTimestamp(value["revokedAt"]);
  if (revokedAt === "invalid") return invalid("revokedAt");
  return {
    ok: true,
    data: {
      id, status, strategyId,
      tradingWalletAddress: wallet,
      allocationUWei: allocation,
      dailyCapUWei: dailyCap,
      termDays,
      startedAtMs: startedAt,
      endsAtMs: endsAt,
      sessionExpiresAtMs: sessionExpiresAt,
      revokedAtMs: revokedAt,
    },
  };
}

export function parseInboxItem(value: unknown): QuantTransportResult<QuantInboxItem> {
  if (!isRecord(value)) return invalid("inboxItem");
  const fields = ["envelopeId", "quantJobId", "ephemeralPublicKey", "nonce", "ciphertext", "algorithm"] as const;
  for (const field of fields) {
    const raw = value[field];
    if (typeof raw !== "string" || raw === "") return invalid(field);
  }
  return {
    ok: true,
    data: {
      envelopeId: String(value["envelopeId"]),
      quantJobId: String(value["quantJobId"]),
      ephemeralPublicKey: String(value["ephemeralPublicKey"]),
      nonce: String(value["nonce"]),
      ciphertext: String(value["ciphertext"]),
      algorithm: String(value["algorithm"]),
    },
  };
}

export function parseIndexerTrade(value: unknown): QuantTransportResult<QuantIndexerTrade> {
  if (!isRecord(value)) return invalid("trade");
  const txHash = value["txHash"];
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(txHash)) {
    return invalid("txHash");
  }
  const direction = value["direction"];
  if (typeof direction !== "string") return invalid("direction");
  const blockTime = parseTimestamp(value["blockTime"]);
  if (blockTime === "invalid") return invalid("blockTime");
  return {
    ok: true,
    data: {
      txHash: txHash.toLowerCase() as Hex,
      blockTimeMs: blockTime,
      direction,
      amountIn: String(value["amountIn"] ?? ""),
      amountOut: String(value["amountOut"] ?? ""),
      realizedPnlU: value["realizedPnlU"] === undefined || value["realizedPnlU"] === null
        ? null : String(value["realizedPnlU"]),
      note: typeof value["note"] === "string" ? value["note"] : null,
    },
  };
}

export function parseConfigBlock(value: unknown): QuantTransportResult<QuantConfigBlock> {
  if (!isRecord(value)) return invalid("config");
  const quant = isRecord(value["quant"]) ? value["quant"] : value;
  const chainId = quant["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) return invalid("chainId");
  const token = isRecord(quant["token"]) ? quant["token"] : null;
  if (token === null) return invalid("token");
  const u = parseAddress(token["address"]);
  if (u === null) return invalid("token.address");
  const uDecimals = token["decimals"];
  if (typeof uDecimals !== "number" || !Number.isSafeInteger(uDecimals)) {
    return invalid("token.decimals");
  }
  const rawTokens = quant["tradableTokens"];
  if (!Array.isArray(rawTokens)) return invalid("tradableTokens");
  const tradableTokens: QuantConfigBlock["tradableTokens"][number][] = [];
  for (const entry of rawTokens) {
    if (!isRecord(entry)) return invalid("tradableTokens[]");
    const address = parseAddress(entry["address"]);
    if (address === null) return invalid("tradableTokens[].address");
    const decimals = entry["decimals"];
    if (typeof decimals !== "number" || !Number.isSafeInteger(decimals)) {
      return invalid("tradableTokens[].decimals");
    }
    const priceRoute = entry["priceRoute"];
    if (typeof priceRoute !== "string") return invalid("tradableTokens[].priceRoute");
    tradableTokens.push({ address, decimals, priceRoute });
  }
  const rawVenues = quant["venueAllowlist"];
  if (!Array.isArray(rawVenues)) return invalid("venueAllowlist");
  const venueAllowlist: Address[] = [];
  for (const entry of rawVenues) {
    const direct = parseAddress(entry);
    if (direct !== null) { venueAllowlist.push(direct); continue; }
    if (!isRecord(entry)) return invalid("venueAllowlist[]");
    const nested = parseAddress(entry["address"]) ?? parseAddress(entry["venue"]);
    if (nested === null) return invalid("venueAllowlist[].address");
    venueAllowlist.push(nested);
  }
  return {
    ok: true,
    data: { chainId, u, uDecimals, tradableTokens, venueAllowlist },
  };
}

/* -------------------------------------------------------------------------- */
/* HTTPS implementation                                                       */
/* -------------------------------------------------------------------------- */

export type HttpQuantTransportOptions = {
  readonly baseUrl: string;
  /** The REST bearer. Held in this closure and never returned or logged. */
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Decimals for `allocationU`/`dailyCapU`. Read from `config()` at boot. */
  readonly uDecimals?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpQuantTransport implements QuantTransport {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #uDecimals: number;

  constructor(options: HttpQuantTransportOptions) {
    const origin = new URL(options.baseUrl).origin;
    if (!QUANT_API_ORIGINS_ALLOWED.has(origin)) {
      throw new Error("The quant transport origin is not in the one-entry allowlist.");
    }
    this.#baseUrl = origin;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#uDecimals = options.uDecimals ?? 18;
  }

  async #request<T>(
    path: string,
    init: { readonly method: "GET" | "POST"; readonly body?: unknown },
    parse: (value: unknown) => QuantTransportResult<T>,
  ): Promise<QuantTransportResult<T>> {
    const url = new URL(path, `${this.#baseUrl}/`);
    // BC35: the FINAL destination is checked, and a redirect is refused rather
    // than followed — an allowlist a 302 can leave is not one.
    if (!QUANT_API_ORIGINS_ALLOWED.has(url.origin)) {
      return { ok: false, code: "transport-refused", detail: "origin" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: init.method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      return { ok: false, code: "transport-unavailable" };
    } finally {
      clearTimeout(timer);
    }
    if (!QUANT_API_ORIGINS_ALLOWED.has(new URL(response.url === "" ? url : response.url).origin)) {
      return { ok: false, code: "transport-refused", detail: "final-origin" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: "transport-unauthorized" };
    }
    if (!response.ok) return { ok: false, code: "transport-refused" };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return invalid("body");
    }
    return parse(body);
  }

  async config(): Promise<QuantTransportResult<QuantConfigBlock>> {
    const result = await this.#request(
      "api/v1/config/contracts", { method: "GET" }, parseConfigBlock,
    );
    if (result.ok) this.#uDecimals = result.data.uDecimals;
    return result;
  }

  async agentKey(agentId: string): Promise<QuantTransportResult<QuantAgentKeyBlock>> {
    return this.#request(
      `api/v1/quant/agent-key?agentId=${encodeURIComponent(agentId)}`,
      { method: "GET" },
      parseAgentKeyBlock,
    );
  }

  async registerKey(input: {
    readonly agentId: string;
    readonly encryptionPublicKey: string;
    readonly algorithm: string;
  }): Promise<QuantTransportResult<QuantAgentKeyBlock>> {
    return this.#request(
      "api/v1/quant/agent-key",
      { method: "POST", body: { ...input } },
      parseAgentKeyBlock,
    );
  }

  async inbox(agentId: string, cursor?: string): Promise<QuantTransportResult<{
    readonly items: readonly QuantInboxItem[];
    readonly nextCursor: string | null;
  }>> {
    const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    return this.#request(
      `api/v1/quant/inbox?agentId=${encodeURIComponent(agentId)}${query}`,
      { method: "GET" },
      (value) => {
        if (!isRecord(value)) return invalid("inbox");
        const rawItems = value["items"];
        if (!Array.isArray(rawItems)) return invalid("inbox.items");
        const items: QuantInboxItem[] = [];
        for (const entry of rawItems) {
          const parsed = parseInboxItem(entry);
          // ONE bad item must not blind the whole inbox (R2.13): it is skipped
          // here and the worker records `wire-invalid` for the job it names, if
          // it named one at all.
          if (parsed.ok) items.push(parsed.data);
        }
        const next = value["nextCursor"];
        return {
          ok: true,
          data: { items, nextCursor: typeof next === "string" && next !== "" ? next : null },
        };
      },
    );
  }

  async job(quantJobId: string): Promise<QuantTransportResult<QuantJobRecord>> {
    return this.#request(
      `api/v1/quant/jobs/${encodeURIComponent(quantJobId)}`,
      { method: "GET" },
      (value) => parseQuantJob(isRecord(value) && isRecord(value["job"]) ? value["job"] : value,
        this.#uDecimals),
    );
  }

  async trades(quantJobId: string): Promise<QuantTransportResult<readonly QuantIndexerTrade[]>> {
    return this.#request(
      `api/v1/quant/jobs/${encodeURIComponent(quantJobId)}/trades`,
      { method: "GET" },
      (value) => {
        if (!isRecord(value)) return invalid("trades");
        const rawItems = value["items"];
        if (!Array.isArray(rawItems)) return invalid("trades.items");
        const items: QuantIndexerTrade[] = [];
        for (const entry of rawItems) {
          const parsed = parseIndexerTrade(entry);
          if (parsed.ok) items.push(parsed.data);
        }
        return { ok: true, data: items };
      },
    );
  }

  async report(
    quantJobId: string, payload: QuantReportPayload,
  ): Promise<QuantTransportResult<QuantReportAck>> {
    return this.#request(
      `api/v1/quant/jobs/${encodeURIComponent(quantJobId)}/report`,
      { method: "POST", body: { trades: payload.trades.map((trade) => ({ ...trade })) } },
      (value) => {
        if (!isRecord(value)) return invalid("report");
        const applied = value["notesApplied"];
        return {
          ok: true,
          data: {
            status: String(value["status"] ?? ""),
            notesApplied: typeof applied === "number" && Number.isSafeInteger(applied)
              ? applied : null,
          },
        };
      },
    );
  }
}

function parseAgentKeyBlock(value: unknown): QuantTransportResult<QuantAgentKeyBlock> {
  if (!isRecord(value)) return invalid("agentKey");
  const nested = isRecord(value["agentKey"]) ? value["agentKey"] : value;
  const key = nested["encryptionPublicKey"];
  const algorithm = nested["algorithm"];
  return {
    ok: true,
    data: {
      encryptionPublicKey: typeof key === "string" && key !== "" ? key : null,
      algorithm: typeof algorithm === "string" && algorithm !== "" ? algorithm : null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory implementation (self-test and offline suites)                    */
/* -------------------------------------------------------------------------- */

export type MemoryQuantTransportState = {
  config: QuantConfigBlock;
  agentKey: QuantAgentKeyBlock;
  inbox: QuantInboxItem[];
  jobs: Map<string, QuantJobRecord>;
  trades: Map<string, QuantIndexerTrade[]>;
  reports: { quantJobId: string; payload: QuantReportPayload }[];
  /** Set to fail one endpoint, so a hold path can be exercised. */
  failing?: Set<"config" | "agentKey" | "inbox" | "job" | "trades" | "report">;
};

/**
 * The transport the mainnet self-test and every offline suite use.
 *
 * It answers with the SAME record types the HTTPS parsers produce, so the
 * worker cannot tell them apart — which is the whole point (BC36): a self-test
 * that fed the worker a different shape would prove nothing about production.
 */
export class MemoryQuantTransport implements QuantTransport {
  readonly state: MemoryQuantTransportState;

  constructor(state: MemoryQuantTransportState) {
    this.state = state;
  }

  #fail<T>(endpoint: NonNullable<MemoryQuantTransportState["failing"]> extends Set<infer E>
    ? E : never): QuantTransportResult<T> | null {
    return this.state.failing?.has(endpoint) === true
      ? { ok: false, code: "transport-unavailable" }
      : null;
  }

  async config(): Promise<QuantTransportResult<QuantConfigBlock>> {
    return this.#fail<QuantConfigBlock>("config") ?? { ok: true, data: this.state.config };
  }

  async agentKey(): Promise<QuantTransportResult<QuantAgentKeyBlock>> {
    return this.#fail<QuantAgentKeyBlock>("agentKey") ?? { ok: true, data: this.state.agentKey };
  }

  async registerKey(input: {
    readonly agentId: string;
    readonly encryptionPublicKey: string;
    readonly algorithm: string;
  }): Promise<QuantTransportResult<QuantAgentKeyBlock>> {
    this.state.agentKey = {
      encryptionPublicKey: input.encryptionPublicKey,
      algorithm: input.algorithm,
    };
    return { ok: true, data: this.state.agentKey };
  }

  async inbox(): Promise<QuantTransportResult<{
    readonly items: readonly QuantInboxItem[];
    readonly nextCursor: string | null;
  }>> {
    const failure = this.#fail<{
      readonly items: readonly QuantInboxItem[];
      readonly nextCursor: string | null;
    }>("inbox");
    if (failure !== null) return failure;
    return { ok: true, data: { items: [...this.state.inbox], nextCursor: null } };
  }

  async job(quantJobId: string): Promise<QuantTransportResult<QuantJobRecord>> {
    const failure = this.#fail<QuantJobRecord>("job");
    if (failure !== null) return failure;
    const record = this.state.jobs.get(quantJobId);
    return record === undefined
      ? { ok: false, code: "transport-refused" }
      : { ok: true, data: record };
  }

  async trades(quantJobId: string): Promise<QuantTransportResult<readonly QuantIndexerTrade[]>> {
    const failure = this.#fail<readonly QuantIndexerTrade[]>("trades");
    if (failure !== null) return failure;
    return { ok: true, data: this.state.trades.get(quantJobId) ?? [] };
  }

  async report(
    quantJobId: string, payload: QuantReportPayload,
  ): Promise<QuantTransportResult<QuantReportAck>> {
    const failure = this.#fail<QuantReportAck>("report");
    if (failure !== null) return failure;
    this.state.reports.push({ quantJobId, payload });
    return { ok: true, data: { status: "accepted", notesApplied: payload.trades.length } };
  }
}
