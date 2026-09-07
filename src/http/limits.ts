/**
 * Request-rate controls for the HTTP layer.
 *
 * Two different jobs, deliberately kept as two mechanisms:
 *
 *   - {@link TokenBucketLimiter} is ABUSE control. It is cheap, it runs before
 *     any signature recovery, and it exists so a flood of junk cannot burn CPU on
 *     ecrecover or hammer the database.
 *   - {@link ExecuteThrottle} is MONEY control. It bounds how fast one agent can
 *     submit, so a leaked `x-exec-token` cannot drain a full cap period in a
 *     burst before an operator notices. The on-chain spend caps are the real
 *     ceiling; this is what makes the ceiling take TIME to reach.
 *
 * PERSISTENCE TRADEOFF (documented, deliberate): both are process-local. A
 * restart clears them, so a burst that spans a restart is not counted across it,
 * and a horizontally-scaled deployment limits per instance rather than globally.
 * That is acceptable because neither is the last line of defence — the on-chain
 * caps and expiry are, and those are enforced by the chain regardless of what
 * this process remembers. Moving these to Postgres would put a write on the hot
 * path of every execute to harden a control that is already backstopped. If the
 * execution plane is ever scaled out, the throttle is the piece to move first.
 *
 * Both keep their maps bounded: an unbounded keyspace (one entry per source IP)
 * is itself a memory-exhaustion vector, so the oldest entries are evicted past a
 * ceiling.
 */

/** Injectable clock, epoch milliseconds. */
export type Clock = () => number;

/** Most distinct keys a limiter tracks before it evicts the oldest. */
const DEFAULT_MAX_KEYS = 10_000;

export type TokenBucketOptions = {
  /** Burst size: how many requests are allowed back to back. */
  readonly capacity: number;
  /** Sustained rate, in requests per second. */
  readonly refillPerSecond: number;
  readonly now?: Clock;
  readonly maxKeys?: number;
};

type Bucket = { tokens: number; updatedAt: number };

/**
 * A classic token bucket, one per key.
 *
 * `capacity` is the burst and `refillPerSecond` the sustained rate; a key that
 * goes quiet refills to full and is eventually evicted.
 */
export class TokenBucketLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillPerSecond: number;
  readonly #maxKeys: number;
  readonly #now: Clock;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0) {
      throw new Error("TokenBucketLimiter capacity must be positive.");
    }
    if (options.refillPerSecond <= 0) {
      throw new Error("TokenBucketLimiter refillPerSecond must be positive.");
    }
    this.#capacity = options.capacity;
    this.#refillPerSecond = options.refillPerSecond;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#now = options.now ?? Date.now;
  }

  /** Take one token. `false` means the caller is over its rate. */
  tryConsume(key: string): boolean {
    const at = this.#now();
    const bucket = this.#buckets.get(key);

    if (bucket === undefined) {
      this.#evictIfFull();
      this.#buckets.set(key, { tokens: this.#capacity - 1, updatedAt: at });
      return true;
    }

    const elapsedSec = Math.max(0, (at - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(
      this.#capacity,
      bucket.tokens + elapsedSec * this.#refillPerSecond,
    );
    bucket.updatedAt = at;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    // Re-insert so Map iteration order tracks recency for eviction.
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    return true;
  }

  /** How many keys are currently tracked. For tests and diagnostics. */
  size(): number {
    return this.#buckets.size;
  }

  #evictIfFull(): void {
    while (this.#buckets.size >= this.#maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done === true) return;
      this.#buckets.delete(oldest.value);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Execute throttle                                                           */
/* -------------------------------------------------------------------------- */

export type ExecuteThrottleOptions = {
  /** Minimum gap between two accepted executes for one agent, in ms. */
  readonly minIntervalMs: number;
  /** Most executes one agent may have accepted inside `windowMs`. */
  readonly maxPerWindow: number;
  /** Length of the rolling window, in ms. */
  readonly windowMs: number;
  readonly now?: Clock;
  readonly maxKeys?: number;
};

export type ThrottleVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Which limit tripped. Callers surface one generic code regardless. */
      readonly reason: "min_interval" | "window";
      /** How long until the next attempt could succeed, in ms. */
      readonly retryAfterMs: number;
    };

/** Defaults: one execute every 3s, at most 20 in a 5-minute window, per agent. */
export const DEFAULT_EXECUTE_THROTTLE: Omit<ExecuteThrottleOptions, "now" | "maxKeys"> = {
  minIntervalMs: 3_000,
  maxPerWindow: 20,
  windowMs: 300_000,
};

/**
 * Per-agent submit throttle.
 *
 * `tryAcquire` both decides and records, in one call with no await between the
 * two, so two concurrent executes for one agent cannot both observe the same
 * empty window. Rejections are NOT recorded — a throttled caller retrying does
 * not push its own next opportunity further away.
 */
export class ExecuteThrottle {
  readonly #history = new Map<string, number[]>();
  readonly #options: Required<Omit<ExecuteThrottleOptions, "now">>;
  readonly #now: Clock;

  constructor(options: ExecuteThrottleOptions) {
    this.#options = {
      minIntervalMs: options.minIntervalMs,
      maxPerWindow: options.maxPerWindow,
      windowMs: options.windowMs,
      maxKeys: options.maxKeys ?? DEFAULT_MAX_KEYS,
    };
    this.#now = options.now ?? Date.now;
  }

  tryAcquire(agentId: string): ThrottleVerdict {
    const at = this.#now();
    const { minIntervalMs, maxPerWindow, windowMs } = this.#options;

    const recent = (this.#history.get(agentId) ?? []).filter(
      (stamp) => at - stamp < windowMs,
    );

    const last = recent[recent.length - 1];
    if (last !== undefined && at - last < minIntervalMs) {
      this.#history.set(agentId, recent);
      return {
        allowed: false,
        reason: "min_interval",
        retryAfterMs: minIntervalMs - (at - last),
      };
    }

    if (recent.length >= maxPerWindow) {
      // The window frees up when its OLDEST entry ages out.
      const oldest = recent[0] ?? at;
      this.#history.set(agentId, recent);
      return {
        allowed: false,
        reason: "window",
        retryAfterMs: Math.max(1, windowMs - (at - oldest)),
      };
    }

    recent.push(at);
    this.#evictIfFull(agentId);
    this.#history.delete(agentId);
    this.#history.set(agentId, recent);
    return { allowed: true };
  }

  #evictIfFull(keeping: string): void {
    while (this.#history.size >= this.#options.maxKeys) {
      const oldest = this.#history.keys().next();
      if (oldest.done === true) return;
      if (oldest.value === keeping) return;
      this.#history.delete(oldest.value);
    }
  }
}
