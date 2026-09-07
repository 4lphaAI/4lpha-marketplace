/**
 * DEMO MODE — boot configuration.
 *
 * Self-contained ON PURPOSE. Every other flag in this repo is resolved in
 * `src/ops/config.ts`, but `src/demo/**` may not import `src/ops/**` (the ban
 * in `types.ts`), and adding demo knobs to that file would put demo code inside
 * the module the money path configures itself from. The cost is one duplicated
 * tri-state parser; the benefit is that deleting `src/demo/` deletes demo mode
 * entirely, with nothing left behind in an audited file.
 *
 * `DEMO_ENABLED` follows `resolveLpEnabled` / `resolveGridEnabled` byte for
 * byte in SHAPE, and for the same reason: OFF by default, ON only for the exact
 * string `"true"`, and a TYPO FAILS THE BOOT. An operator who wrote
 * `DEMO_ENABLED=1` believed they enabled demo mode, and a server that silently
 * serves 404 while looking healthy is the PHASE4-AUDIT A1/F8 shape.
 */

export type DemoEnv = Readonly<Record<string, string | undefined>>;

function read(env: DemoEnv, key: string): string {
  return (env[key] ?? "").trim();
}

/** A tri-state boolean where a typo throws rather than defaulting to off. */
function strictBool(env: DemoEnv, key: string): boolean {
  const raw = read(env, key);
  if (raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} must be exactly "true" or "false"; got "${raw}".`);
}

function intIn(env: DemoEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = read(env, key);
  if (raw === "") return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${key} must be a whole number; got "${raw}".`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}; got ${value}.`);
  }
  return value;
}

export type DemoConfig = {
  readonly enabled: boolean;
  /** Worker cadence, clamped the way the LP worker clamps its own. */
  readonly workerIntervalMs: number;
  /** How many agents one anonymous cookie may hold at once. */
  readonly maxAgentsPerOwner: number;
  /** How long a demo agent lives before the sweep retires it. */
  readonly ttlDays: number;
  /** Agents advanced per cycle — the bound on one tick's work. */
  readonly maxAgentsPerCycle: number;
  /**
   * LLM budgets (plan §4). The per-agent number is the operator's (25/day);
   * the global one is the builder's addition, because anonymous owners are
   * unlimited and a per-agent cap alone bounds nothing. Both fail CLOSED to the
   * heuristic path — a demo agent whose budget is spent keeps trading and
   * simply stops consulting the brain.
   */
  readonly llmCallsPerAgentPerDay: number;
  readonly llmCallsPerDay: number;
  /**
   * The minimum gap between one agent's consultations.
   *
   * FIX-REVIEW-2 FINDING 6. The budget alone bounds the DAY but not the RATE:
   * with continuous holdings a 25-call allowance was spent in about 25 minutes
   * of consecutive cycles, leaving the rest of the day heuristic-only — the
   * opposite of the "roughly one consultation per hour" the plan describes. The
   * pacing is now explicit, and the two bounds do different jobs: the budget
   * caps the spend, this caps the burst.
   */
  readonly llmMinIntervalSec: number;
  /**
   * The gas pad a demo charges per submission, in wei. Defaults to the live
   * plane's `RELAY_FEE_PER_EXIT_WEI` constant — still the unmeasured pad, and
   * the demo's disclosure says so rather than presenting it as measured.
   */
  readonly relayFeePerSubmitWei: bigint;
};

/** The live plane's own unmeasured pad, restated here rather than imported. */
export const DEMO_DEFAULT_RELAY_FEE_PER_SUBMIT_WEI = 100_000_000_000_000n; // 0.0001 BNB

/** The shape a disabled deployment gets: every default, nothing parsed. */
const DISABLED: DemoConfig = {
  enabled: false,
  workerIntervalMs: 60_000,
  maxAgentsPerOwner: 3,
  ttlDays: 7,
  maxAgentsPerCycle: 64,
  llmCallsPerAgentPerDay: 25,
  llmCallsPerDay: 500,
  llmMinIntervalSec: 3_600,
  relayFeePerSubmitWei: 100_000_000_000_000n,
};

export function resolveDemoConfig(env: DemoEnv): DemoConfig {
  const enabled = strictBool(env, "DEMO_ENABLED");
  // REVIEW FIX (finding 18): a DISABLED deployment parses nothing else. The
  // first version validated every demo knob regardless, so a stray
  // `DEMO_MAX_AGENTS_PER_OWNER=bogus` threw during boot and stopped the whole
  // execution service from listening — a demo setting taking down the money
  // plane, which is the exact inversion of what this module is for. `DEMO_ENABLED`
  // itself still throws on a typo, because a silently-disabled demo mode is the
  // failure the tri-state exists to prevent.
  if (!enabled) return DISABLED;
  const intervalSec = intIn(env, "DEMO_WORKER_INTERVAL_SEC", 60, 30, 300);
  const rawFee = read(env, "DEMO_RELAY_FEE_PER_SUBMIT_WEI");
  if (rawFee !== "" && !/^\d+$/u.test(rawFee)) {
    throw new Error(`DEMO_RELAY_FEE_PER_SUBMIT_WEI must be a whole number of wei; got "${rawFee}".`);
  }
  return {
    enabled,
    workerIntervalMs: intervalSec * 1_000,
    maxAgentsPerOwner: intIn(env, "DEMO_MAX_AGENTS_PER_OWNER", 3, 1, 10),
    ttlDays: intIn(env, "DEMO_AGENT_TTL_DAYS", 7, 1, 30),
    maxAgentsPerCycle: intIn(env, "DEMO_MAX_AGENTS_PER_CYCLE", 64, 1, 512),
    llmCallsPerAgentPerDay: intIn(env, "DEMO_LLM_CALLS_PER_AGENT_PER_DAY", 25, 0, 500),
    llmCallsPerDay: intIn(env, "DEMO_LLM_CALLS_PER_DAY", 500, 0, 100_000),
    llmMinIntervalSec: intIn(env, "DEMO_LLM_MIN_INTERVAL_SEC", 3_600, 0, 86_400),
    relayFeePerSubmitWei:
      rawFee === "" ? DEMO_DEFAULT_RELAY_FEE_PER_SUBMIT_WEI : BigInt(rawFee),
  };
}

/** The UTC day an LLM budget is counted against. Stable across processes. */
export function demoUtcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The disclosure every demo projection carries (plan §7).
 *
 * ONE list, so a screen cannot show a demo number while omitting what the
 * number leaves out. Written in the owner's words, not the engine's.
 */
export const DEMO_GRID_OMISSIONS: readonly string[] = [
  "fees earned while the price sits inside a range",
  "the price impact this position's own liquidity would have",
  "partial fills, MEV and failed submissions",
  // Review finding 16. Realised PnL scores COMPLETED cycles only, so whatever
  // the level is holding between fills — the position that has converted and
  // not yet converted back — is not in the figure. On a one-way move that
  // unrealised leg is the whole story, and leaving it unsaid would flatter the
  // demo exactly when a real grid hurts most.
  "the value of inventory a level is holding between fills, when the price moves one way and stays",
];

/**
 * The pool fee is deliberately NOT charged as a cost (review finding 16, which
 * read plan §3 as requiring a "fee tier plus gas" pad).
 *
 * A liquidity position EARNS the pool fee; it does not pay it. Charging it
 * would be a cost the live agent never meets, and the thing the demo actually
 * leaves out — the fee income — is already the first line of the omissions
 * above, where it belongs. Gas is the one real cost, and it is charged.
 */
export const DEMO_GRID_POOL_FEE_IS_INCOME_NOT_COST = true;

export const DEMO_TRADE_OMISSIONS: readonly string[] = [
  // FIX-REVIEW FINDING 11. This said "slippage beyond the QUOTED ROUTE", which
  // claimed a check the demo does not make: a fill is priced from the live USD
  // feed, and no venue is ever asked whether the trade could actually be
  // routed. The creation screen said so; this list is what Account and the
  // history show a returning viewer, so the correction has to live here too.
  "whether the trade could actually be routed — fills are priced from the live USD feed, not from a venue quote, so a token that is priced but unsellable still shows a clean exit",
  "slippage and the price impact of the order itself",
  "MEV, failed submissions and priority fees",
  "token transfer taxes and honeypot behaviour a live trade would meet",
];
