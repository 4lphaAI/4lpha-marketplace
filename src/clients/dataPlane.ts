/**
 * The execution plane's ONLY third-party-data dependency.
 *
 * This is an architectural boundary, not a convenience wrapper. The execution
 * plane holds fund-moving keys; the data plane talks to a dozen third-party
 * market-data providers with their own credentials, rate limits and outages. If
 * the execution plane called those providers directly it would inherit every one
 * of those failure modes and every one of those secrets, and a provider that
 * started returning attacker-controlled JSON would be shaping decisions inside
 * the process that signs transactions.
 *
 * ─── THE INVARIANT, STATED PRECISELY (PHASE2.1 R7) ─────────────────────────
 *
 * **The data-plane CLIENT contacts exactly one host — the data plane.** Nothing
 * widens that, and the egress tests keep asserting it path by path: no request
 * this client makes ever leaves the configured origin, and the trade route asks
 * it for `security/` and nothing else.
 *
 * The invariant used to be phrased as "the execution plane contacts exactly one
 * host", which was never quite what the code did — `getBalance`,
 * `getTokenBalance` and the whole owner-recovery path have always spoken to a
 * public RPC. The honest split, and the one the code now makes explicit:
 *
 *   - THIRD-PARTY MARKET JUDGEMENT comes only from the data plane. GoPlus
 *     verdicts, price feeds, anything credentialed and anything whose JSON an
 *     attacker could shape. That is this client, and its boundary is unchanged.
 *   - CHAIN STATE comes from the provider's chain-id-pinned RPC.
 *     `TokenManagerHelper3.getTokenInfo`/`tryBuy`/`trySell` are `view` calls on
 *     a BNB-Chain contract, in exactly the same class as `balanceOf`, verified
 *     by the same client that verifies its endpoint's chain id before trusting
 *     it. Four.Meme quotes are chain state, and were never a data-plane call.
 *
 * Everything is injectable — `fetch`, the clock-free timeouts, the base URL — so
 * the whole client is exercised offline.
 */
import { InfrastructureError, ProviderError } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import { getAddress } from "viem";

/** The subset of `fetch` this client uses. Injected so tests never touch a socket. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Envelope the data plane returns on every route. */
export type DataPlaneEnvelope<T> = {
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message?: string };
  readonly meta?: Record<string, unknown>;
};

export type DataPlaneClientOptions = {
  /** Base origin of the data plane, e.g. `http://data-plane.internal:8080`. */
  readonly baseUrl: string;
  /** Shared service credential, sent as `x-dp-token`. Never logged. */
  readonly token?: string;
  /** Per-request ceiling. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injected transport. Defaults to global `fetch`. */
  readonly fetch?: FetchLike;
};

/** Default per-request timeout. A market read is never worth blocking on. */
export const DEFAULT_TIMEOUT_MS = 5_000;

export type DataPlaneHealth = {
  readonly ok: boolean;
  readonly uptimeSec: number;
};

/**
 * Every answer a Venus data-plane read can give, as a TYPED NON-ANSWER rather
 * than as `null` or a thrown status (PHASE4 R2.13).
 *
 * Four of these were previously indistinguishable through `#get`:
 *
 *   - `pending` — HTTP 202, or a 200 whose body is
 *     `{data:{owner,status:"pending"}}`. `response.ok` is TRUE for the second
 *     one, so a client that only branched on the status code would return a
 *     placeholder as if it were a snapshot;
 *   - `untracked` — 404. The subject is not registered, which is a lifecycle
 *     fact, not an outage;
 *   - `capacity` — 409 carrying `error.code: "capacity_exceeded"`. The data
 *     plane tracks at most 1 000 subjects; the old non-ok branch never parsed
 *     the body, so hitting the ceiling on a public marketplace read exactly
 *     like an outage;
 *   - `ok` — the ENVELOPE, not `envelope.data`, because freshness lives in
 *     `meta.staleness` and `#get` drops `meta`. "A stale snapshot never wakes an
 *     action" is not buildable without it.
 *
 * Every one of them is ADVISORY. The snapshot is a wake-up signal and a UI
 * snapshot, never authorization to move funds; the worker's own periodic direct
 * finalized read is the PRIMARY cadence, because the data plane's 15 s hot lane
 * only admits `wakeRiskHealthFactor < 1.15` (so any `triggerHf` above 1.15
 * never enters it) and its 60 s base lane rotates a cursor in chunks of 16 with
 * an unbounded revisit interval at capacity.
 */
export type VenusReadResult =
  | { readonly kind: "ok"; readonly envelope: DataPlaneEnvelope<unknown> }
  | { readonly kind: "pending" }
  | { readonly kind: "untracked" }
  | { readonly kind: "capacity" };

/** What a tracking mutation can answer. `ok` covers the PUT's 200/201 pair. */
export type VenusTrackingResult =
  | { readonly kind: "ok" }
  | { readonly kind: "pending" }
  | { readonly kind: "untracked" }
  | { readonly kind: "capacity" };

/**
 * What the execution plane is allowed to ask the data plane for.
 *
 * Narrow on purpose: an interface that mirrored the whole data-plane API would
 * invite the execution plane to start making market judgements, which is the
 * marketplace's job. Widen it deliberately, per use case.
 */
export interface DataPlaneClient {
  /** Liveness of the data plane. Used by `/status`; never throws. */
  health(signal?: AbortSignal): Promise<DataPlaneHealth | null>;
  /** A token snapshot, or `null` when the data plane has none. */
  token(address: string, signal?: AbortSignal): Promise<unknown | null>;
  tokenEnvelope?(
    address: string,
    signal?: AbortSignal,
  ): Promise<DataPlaneEnvelope<unknown> | null>;
  /** A token's security summary, or `null`. */
  security(address: string, signal?: AbortSignal): Promise<unknown | null>;
  /**
   * The token-scoped ranked-pools envelope for LP yield selection (Phase 3.10).
   *
   * Unlike the other reads, this preserves the UNTRUSTED `{ data, meta }`
   * envelope because coverage and freshness metadata are part of admission.
   * `discoveryToken` comes from the persisted canonical LP session, never from
   * request text; explicit-pool opens never call this method.
   *
   * LP and trade brains are worker-only. The HTTP execution plane holds no
   * LLM key, makes no LLM call, and never routes model work through this
   * data-plane client.
   */
  lpRankedPools(
    discoveryToken: string,
    orderBy: "lpFeeApr24h" | "volume24hUsd",
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  /** Venus Core account snapshot v2 for one owner. ADVISORY (PHASE4 D9). */
  venusAccount(owner: string, signal?: AbortSignal): Promise<VenusReadResult>;
  /** Venus Core rewards snapshot v2 for one owner. ADVISORY. */
  venusRewards(owner: string, signal?: AbortSignal): Promise<VenusReadResult>;
  /** Venus Core markets snapshot v1. ADVISORY. */
  venusMarkets(signal?: AbortSignal): Promise<VenusReadResult>;
  /**
   * Register an owner as a tracked Venus subject, referenced by `agentId`.
   *
   * IDEMPOTENT, and multi-agent-per-owner safe by the reference-count semantics
   * measured live on 2026-08-22. **Recorded risk, carried in both repos' docs**:
   * this internal mutation sits behind the SAME `x-dp-token` as every read, so a
   * READ credential is registration authority over ANY address. This plane must
   * therefore only ever call it from the enablement path bound to a real agent
   * row, and the data plane owes a future split of that authority.
   */
  venusTrackOwner(
    owner: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<VenusTrackingResult>;
  /** Drop this agent's reference. Idempotent; a 404 is success, not an error. */
  venusUntrackOwner(
    owner: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<VenusTrackingResult>;
}

/**
 * Join a path onto the base URL and REFUSE anything that changes origin.
 *
 * `new URL("//evil.example/x", base)` silently retargets the host. Paths here are
 * built from route parameters, so this check is what stops a crafted agent id or
 * address from steering an outbound request at a host of the caller's choosing.
 */
function resolveUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const target = new URL(path.startsWith("/") ? path.slice(1) : path, ensureTrailingSlash(base));
  if (target.origin !== base.origin) {
    throw new ProviderError("Refusing a data-plane request that leaves the configured origin.");
  }
  return target.toString();
}

function ensureTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith("/")) return url;
  const copy = new URL(url.toString());
  copy.pathname = `${copy.pathname}/`;
  return copy;
}

/**
 * Every HTTP verb this client may use.
 *
 * PHASE4 R2.13/S12 widened it from `"GET" | "POST"`, and BOTH unions had to
 * move: `#request` and `#requestEnvelope` each carried their own copy. The
 * tracking lifecycle is the first WRITE egress this plane makes to the data
 * plane, and the path-by-path egress tests gained its two paths with it.
 */
type DataPlaneMethod = "GET" | "POST" | "PUT" | "DELETE";

/** An owner address is canonicalized before it enters a path segment. */
function normalizeOwner(owner: string): string {
  try {
    return getAddress(owner).toLowerCase();
  } catch {
    throw new ProviderError("Refusing a data-plane request for an invalid owner address.");
  }
}

/** Persisted session addresses are canonicalized before entering a query. */
function normalizeDiscoveryToken(token: string): string {
  try {
    return getAddress(token).toLowerCase();
  } catch {
    throw new ProviderError("Refusing an invalid persisted discovery token.");
  }
}

/**
 * HTTP implementation. Every failure is sanitized before it becomes an error
 * message: a data-plane 500 body can contain upstream URLs and keys.
 */
export class HttpDataPlaneClient implements DataPlaneClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: DataPlaneClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.token ?? "";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async health(signal?: AbortSignal): Promise<DataPlaneHealth | null> {
    // Liveness must never be the reason /status fails, so this one swallows.
    try {
      const body = await this.#get<DataPlaneHealth>("health", signal);
      return body ?? null;
    } catch {
      return null;
    }
  }

  async token(address: string, signal?: AbortSignal): Promise<unknown | null> {
    return this.#get<unknown>(`tokens/${encodeURIComponent(address)}`, signal);
  }

  async tokenEnvelope(
    address: string,
    signal?: AbortSignal,
  ): Promise<DataPlaneEnvelope<unknown> | null> {
    return this.#requestEnvelope<unknown>(
      "GET",
      `tokens/${encodeURIComponent(address)}`,
      undefined,
      signal,
    );
  }

  async security(address: string, signal?: AbortSignal): Promise<unknown | null> {
    return this.#get<unknown>(`security/${encodeURIComponent(address)}`, signal);
  }

  async lpRankedPools(
    discoveryToken: string,
    orderBy: "lpFeeApr24h" | "volume24hUsd",
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    const token = encodeURIComponent(normalizeDiscoveryToken(discoveryToken));
    return this.#requestEnvelope(
      "GET",
      `pools/top?token=${token}&orderBy=${orderBy}&aprField=lpFeeApr24h&limit=500`,
      undefined,
      signal,
    );
  }

  async venusAccount(
    owner: string,
    signal?: AbortSignal,
  ): Promise<VenusReadResult> {
    return this.#venusRead(
      `venus/core/accounts/${encodeURIComponent(normalizeOwner(owner))}`,
      signal,
    );
  }

  async venusRewards(
    owner: string,
    signal?: AbortSignal,
  ): Promise<VenusReadResult> {
    // The data plane serves rewards NESTED under the account:
    // `GET /venus/core/accounts/:owner/rewards` (verified live 2026-08-22/24).
    // The first draft of this method invented `venus/core/rewards/:owner`,
    // which does not exist and answered a permanent 404 — mapped to
    // "untracked", the failure mode that LOOKS like an untracked owner. Found
    // by the A5 egress test, which pins the exact path per method.
    return this.#venusRead(
      `venus/core/accounts/${encodeURIComponent(normalizeOwner(owner))}/rewards`,
      signal,
    );
  }

  async venusMarkets(signal?: AbortSignal): Promise<VenusReadResult> {
    return this.#venusRead("venus/core/markets", signal);
  }

  async venusTrackOwner(
    owner: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<VenusTrackingResult> {
    return this.#venusTracking("PUT", owner, agentId, signal);
  }

  async venusUntrackOwner(
    owner: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<VenusTrackingResult> {
    return this.#venusTracking("DELETE", owner, agentId, signal);
  }

  /** The shared read branch: 202/pending, 404, 409-capacity, then the envelope. */
  async #venusRead(
    path: string,
    signal?: AbortSignal,
  ): Promise<VenusReadResult> {
    const response = await this.#send("GET", path, undefined, signal);
    if (response.status === 404) return { kind: "untracked" };
    if (response.status === 202) return { kind: "pending" };
    if (response.status === 409) {
      return response.envelope?.error?.code === "capacity_exceeded"
        ? { kind: "capacity" }
        : { kind: "untracked" };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new InfrastructureError(
        sanitizeMessage(`Data plane returned status ${response.status}.`),
      );
    }
    const envelope = response.envelope;
    if (envelope === null) {
      throw new InfrastructureError("Data plane returned a malformed response body.");
    }
    if (envelope.error !== undefined) {
      throw new InfrastructureError(
        sanitizeMessage(`Data plane error: ${envelope.error.code}.`),
      );
    }
    // A 200 whose body says `pending` is a PLACEHOLDER, not a snapshot. Missing
    // this branch is how a stale-or-absent record becomes a wake signal.
    const data = envelope.data;
    if (
      typeof data === "object"
      && data !== null
      && (data as { status?: unknown }).status === "pending"
    ) {
      return { kind: "pending" };
    }
    return { kind: "ok", envelope };
  }

  async #venusTracking(
    method: "PUT" | "DELETE",
    owner: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<VenusTrackingResult> {
    // `agentId` is a persisted row id, never request text, and both segments are
    // encoded — `resolveUrl` still refuses anything that would change origin.
    const path =
      `internal/venus/core/tracked-owners/` +
      `${encodeURIComponent(normalizeOwner(owner))}/${encodeURIComponent(agentId)}`;
    const response = await this.#send(method, path, undefined, signal);
    // The DELETE's 404 is SUCCESS: the reference is already gone, and the
    // reconcile pass that issues it is idempotent and retryable by design.
    if (response.status === 404) {
      return method === "DELETE" ? { kind: "ok" } : { kind: "untracked" };
    }
    if (response.status === 202) return { kind: "pending" };
    if (response.status === 409) {
      return response.envelope?.error?.code === "capacity_exceeded"
        ? { kind: "capacity" }
        : { kind: "untracked" };
    }
    // The PUT answers 200 or 201 depending on `created`; both are success.
    if (response.status >= 200 && response.status < 300) return { kind: "ok" };
    throw new InfrastructureError(
      sanitizeMessage(`Data plane returned status ${response.status}.`),
    );
  }

  async #get<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    return this.#request<T>("GET", path, undefined, signal);
  }

  async #request<T>(
    method: DataPlaneMethod,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const envelope = await this.#requestEnvelope<T>(method, path, body, signal);
    return envelope?.data ?? null;
  }

  /**
   * The raw send: STATUS PRESERVED, body parsed leniently.
   *
   * `#requestEnvelope` discards the status code (404 becomes `null`, everything
   * else non-ok becomes a thrown `InfrastructureError`), and PHASE4 R2.13 needs
   * four different answers off three different codes. Rather than change what
   * the LP and scan callers see, the status-preserving layer sits underneath and
   * `#requestEnvelope` becomes its existing behaviour expressed on top.
   */
  async #send(
    method: DataPlaneMethod,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    readonly status: number;
    readonly envelope: DataPlaneEnvelope<unknown> | null;
  }> {
    const url = resolveUrl(this.#baseUrl, path);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const composed =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          // Absent when unset rather than sent empty: an empty credential is a
          // configuration mistake worth surfacing as a 401, not as a silent pass.
          ...(this.#token === "" ? {} : { "x-dp-token": this.#token }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: composed,
      });
    } catch (cause) {
      throw new InfrastructureError(
        sanitizeMessage(
          `Data plane is unreachable: ${cause instanceof Error ? cause.name : "unknown"}.`,
        ),
      );
    }

    let envelope: DataPlaneEnvelope<unknown> | null;
    try {
      envelope = (await response.json()) as DataPlaneEnvelope<unknown>;
    } catch {
      // A body that will not parse is only fatal for a caller that needs it;
      // a DELETE's empty 204 is not an outage.
      envelope = null;
    }
    return { status: response.status, envelope };
  }

  /**
   * The pre-PHASE4 behaviour, unchanged for every existing caller: 404 answers
   * `null`, any other non-2xx throws, a malformed body throws, and an
   * `error` envelope throws.
   */
  async #requestEnvelope<T>(
    method: DataPlaneMethod,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DataPlaneEnvelope<T> | null> {
    const response = await this.#send(method, path, body, signal);
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new InfrastructureError(
        sanitizeMessage(`Data plane returned status ${response.status}.`),
      );
    }
    if (response.envelope === null) {
      throw new InfrastructureError("Data plane returned a malformed response body.");
    }
    const envelope = response.envelope as DataPlaneEnvelope<T>;
    if (envelope.error !== undefined) {
      throw new InfrastructureError(
        sanitizeMessage(`Data plane error: ${envelope.error.code}.`),
      );
    }
    return envelope;
  }
}
