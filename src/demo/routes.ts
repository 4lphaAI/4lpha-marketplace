/**
 * DEMO MODE — the HTTP surface.
 *
 * ─── THE PERIMETER, STATED PLAINLY ─────────────────────────────────────────
 *
 * The shared `x-exec-token` (applied by the host app's middleware) and an
 * ANONYMOUS OWNER ID in `x-demo-owner`. There is no owner signature, no nonce,
 * no runtime assertion and no session on any route here — because there is
 * nothing owner-scoped to protect: a demo agent holds no funds, no key and no
 * authority, and the worst a stolen demo cookie buys is somebody else's
 * simulation.
 *
 * The owner id is minted and stored by the UI's BFF in an HttpOnly cookie and
 * forwarded as a header, exactly as `x-exec-token` is: the browser never sees
 * either. The plane stays stateless about cookies.
 *
 * ─── WHY `POST /demo/agents` MAY BE UNAUTHENTICATED ────────────────────────
 *
 * Operator decision 2026-09-06 (plan §8-1): requiring a passkey would kill the
 * "try it with no wallet" case that is the whole point. The write is bounded
 * by four things instead — the per-owner cap enforced INSIDE the store's
 * insert, the TTL sweep, the host's global rate limiter, and the fact that the
 * route can create nothing but a row.
 *
 * ─── EVERY PROJECTION CARRIES ITS DISCLOSURE ───────────────────────────────
 *
 * A demo figure never leaves this file without `disclosure`, and the live-only
 * facts a demo cannot have (`txHash`, `tokenId`, `erc8004AgentId`, `callsId`)
 * are present and NULL rather than absent — a UI that forgets to branch renders
 * an empty field, not a fabricated one.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getAddress, parseEther, type Address } from "viem";

import { demoGridArm, DemoGridArmError } from "./gridEngine.js";
import {
  DEMO_GRID_OMISSIONS,
  DEMO_TRADE_OMISSIONS,
  demoUtcDay,
  type DemoConfig,
} from "./config.js";
import {
  parseDemoGridConfig,
  parseDemoGridObservation,
  parseDemoGridState,
  parseDemoTradeConfig,
  parseDemoTradeState,
} from "./codec.js";
import {
  DEMO_LIVE_ONLY_FACTS,
  asDemoOwnerId,
  type DemoAgentKind,
  type DemoOwnerId,
} from "./types.js";
import { gridDeriveDualRanges, gridDeriveRanges } from "../lp/gridGeometry.js";
import { MAX_TICK, MIN_TICK } from "../lp/tickMath.js";
import type { LpGridSettings } from "../lp/triggers.js";
import type { DemoAgentRecord, DemoAgentStore } from "../store/demoAgents.js";

/* -------------------------------------------------------------------------- */
/* Deps                                                                       */
/* -------------------------------------------------------------------------- */

/** One candidate token for a demo trading universe, ranked by the caller. */
export type DemoUniverseRow = { readonly address: Address; readonly symbol: string };

export type DemoServerDeps = {
  readonly store: DemoAgentStore;
  readonly config: DemoConfig;
  /** Pool resolution and the live tick — the SAME readers the LP routes use. */
  readonly getPool: (token0: Address, token1: Address, fee: number) => Promise<Address | null>;
  readonly poolTick: (
    pool: Address,
  ) => Promise<{ readonly currentTick: number; readonly tickSpacing: number } | null>;
  /** The pool's own `token0`. Pool order is read from the pool, never inferred
   *  from the order a caller listed the pair in (review finding 14). */
  readonly poolToken0: (pool: Address) => Promise<Address | null>;
  readonly wbnb: Address;
  /**
   * The pinned universe a demo trading agent is created with. Read ONCE at
   * creation, exactly as the live trading agent pins its 25 tokens at hire —
   * a demo that re-read its universe every cycle would be a different product
   * from the one it is advertising.
   */
  readonly tradeUniverse?: (model: string) => Promise<readonly DemoUniverseRow[]>;
  readonly now?: () => number;
  readonly newId?: () => string;
};

/* -------------------------------------------------------------------------- */
/* Small local helpers                                                        */
/* -------------------------------------------------------------------------- */

type DemoErrorCode =
  | "invalid_request"
  | "not_found"
  | "at_cap"
  | "conflict"
  | "unavailable"
  | "demo_disabled";

/**
 * The demo plane's own error renderer.
 *
 * `src/server.ts` exports a `fail` this could have used, and importing it was
 * REJECTED: it would pull the whole money surface into `src/demo/**` and make
 * an import cycle out of the mount. Twelve lines is the cheaper price.
 */
function demoFail(c: Context, status: 400 | 404 | 409 | 429 | 503, code: DemoErrorCode, message?: string): Response {
  return c.json(
    { error: { code, ...(message === undefined ? {} : { message: message.slice(0, 280) }) } },
    status,
  );
}

function ownerOf(c: Context): DemoOwnerId | null {
  return asDemoOwnerId((c.req.header("x-demo-owner") ?? "").trim().toLowerCase());
}

function parseAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

/** A positive BNB amount as a decimal string, refusing anything else. */
function parseBnb(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,9}(\.\d{1,18})?$/u.test(value)) return null;
  try {
    const wei = parseEther(value);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

function parseName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 40)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively render a stored payload as JSON-safe values.
 *
 * Every `bigint` becomes DECIMAL TEXT — the repo's wire convention, and the
 * only representation that survives a value larger than `Number.MAX_SAFE_INTEGER`
 * intact. ONE function, because the alternative is remembering it at each of
 * the payload shapes the two engines write (review finding 5).
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(item);
    }
    return out;
  }
  return value;
}

/** Round a tick count UP to the pool's spacing, the deploy form's own rule. */
function quantiseUp(ticks: number, spacing: number): number {
  return Math.ceil(ticks / spacing) * spacing;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                */
/* -------------------------------------------------------------------------- */

function gridView(agent: DemoAgentRecord): Readonly<Record<string, unknown>> | null {
  const config = parseDemoGridConfig(agent.config);
  const state = parseDemoGridState(agent.state);
  if (config === null || state === null) return null;
  const realisedQuoteWei = state.levels.reduce((sum, level) => sum + level.realisedQuoteWei, 0n);
  const cycles = state.levels.reduce((sum, level) => sum + level.cycles, 0);
  const observed = parseDemoGridObservation(agent.state);
  return {
    pool: config.pool,
    quoteSymbol: config.quoteSymbol,
    baseSymbol: config.baseSymbol,
    budgetQuoteWei: config.budgetQuoteWei.toString(10),
    // The GEOMETRY a viewer needs to see where the price sits between the rungs.
    // `currentTick` is an OBSERVATION with its own timestamp, not a live read on
    // this request: the screen ages it and says how old it is, rather than
    // implying the plane just looked.
    tickSpacing: config.grid.tickSpacing,
    wbnbIsToken0: config.grid.wbnbIsToken0,
    currentTick: observed?.tick ?? null,
    currentTickAtMs: observed?.atMs ?? null,
    levels: state.levels.map((level) => ({
      level: level.level,
      role: level.role,
      range: level.role === "buy"
        ? rangeOf(config.grid, level.level, "buy")
        : rangeOf(config.grid, level.level, "sell"),
      cycles: level.cycles,
      realisedQuoteWei: level.realisedQuoteWei.toString(10),
    })),
    flips: state.flips,
    cycles,
    realisedQuoteWei: realisedQuoteWei.toString(10),
    // The gas pad is reported BESIDE the result, never inside it, so a reader
    // sees both halves and can judge the net for themselves (plan §3).
    gasChargedQuoteWei: state.costQuoteWei.toString(10),
    netQuoteWei: (realisedQuoteWei - state.costQuoteWei).toString(10),
  };
}

function rangeOf(
  grid: LpGridSettings,
  level: 1 | 2,
  role: "buy" | "sell",
): { tickLower: number; tickUpper: number } | null {
  if (level === 1) return role === "buy" ? grid.buyRange : grid.sellRange;
  const range = role === "buy" ? grid.buyRange2 : grid.sellRange2;
  return range ?? null;
}

function tradeView(agent: DemoAgentRecord): Readonly<Record<string, unknown>> | null {
  const config = parseDemoTradeConfig(agent.config);
  const state = parseDemoTradeState(agent.state);
  if (config === null || state === null) return null;
  return {
    model: config.model,
    capitalQuoteWei: config.capitalQuoteWei.toString(10),
    cashQuoteWei: state.cashQuoteWei.toString(10),
    universeSize: config.universe.length,
    brainEnabled: config.brainEnabled,
    positions: state.positions.map((position) => ({
      token: position.token,
      symbol: position.symbol,
      entryQuoteWei: position.entryQuoteWei.toString(10),
      openedAtMs: position.openedAtMs,
    })),
    trades: state.trades,
    realisedQuoteWei: state.realisedQuoteWei.toString(10),
    gasChargedQuoteWei: state.costQuoteWei.toString(10),
    netQuoteWei: (state.realisedQuoteWei - state.costQuoteWei).toString(10),
  };
}

function agentView(agent: DemoAgentRecord): Readonly<Record<string, unknown>> {
  const detail = agent.kind === "grid" ? gridView(agent) : tradeView(agent);
  return {
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    status: agent.status,
    createdAtMs: agent.createdAtMs,
    expiresAtMs: agent.expiresAtMs,
    lastTickAtMs: agent.lastTickAtMs,
    // A dash-with-a-reason, machine readable. A UI shows the reason; it never
    // shows a number in place of one (plan §7).
    holdReason: agent.holdReason,
    detail,
    detailUnavailableReason:
      detail === null ? "This demo's saved figures could not be read." : null,
    disclosure: {
      simulated: true,
      omits: agent.kind === "grid" ? DEMO_GRID_OMISSIONS : DEMO_TRADE_OMISSIONS,
    },
    ...DEMO_LIVE_ONLY_FACTS,
  };
}

/* -------------------------------------------------------------------------- */
/* The app                                                                    */
/* -------------------------------------------------------------------------- */

export function createDemoRoutes(deps: DemoServerDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomId;

  app.use("/demo/*", async (c, next) => {
    if (!deps.config.enabled) return demoFail(c, 404, "demo_disabled");
    await next();
  });

  app.post("/demo/agents", async (c) => {
    const owner = ownerOf(c);
    if (owner === null) return demoFail(c, 400, "invalid_request", "A demo session id is required.");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return demoFail(c, 400, "invalid_request", "The request body is not JSON.");
    }
    if (!isRecord(body)) return demoFail(c, 400, "invalid_request", "The request body is not an object.");
    const kind: DemoAgentKind | null =
      body["kind"] === "grid" ? "grid" : body["kind"] === "trade" ? "trade" : null;
    if (kind === null) return demoFail(c, 400, "invalid_request", "kind must be \"grid\" or \"trade\".");

    const created =
      kind === "grid"
        ? await createGrid({ body, owner, deps, now: now(), id: newId(), c })
        : await createTrade({ body, owner, deps, now: now(), id: newId(), c });
    return created;
  });

  app.get("/demo/agents", async (c) => {
    const owner = ownerOf(c);
    if (owner === null) return c.json({ data: { agents: [] } });
    const agents = await deps.store.list(owner);
    return c.json({ data: { agents: agents.map(agentView) } });
  });

  app.get("/demo/agents/:id", async (c) => {
    const owner = ownerOf(c);
    if (owner === null) return demoFail(c, 404, "not_found");
    const agent = await deps.store.get(owner, c.req.param("id"));
    // A cross-owner id is a 404, indistinguishable from "no such agent".
    if (agent === null) return demoFail(c, 404, "not_found");
    return c.json({ data: { agent: agentView(agent) } });
  });

  app.get("/demo/agents/:id/fills", async (c) => {
    const owner = ownerOf(c);
    if (owner === null) return demoFail(c, 404, "not_found");
    const agent = await deps.store.get(owner, c.req.param("id"));
    if (agent === null) return demoFail(c, 404, "not_found");
    const fills = await deps.store.listFills(owner, c.req.param("id"), 100);
    return c.json({
      data: {
        // REVIEW FIX (finding 5): every wei figure crosses as DECIMAL TEXT.
        // The first version spread the stored payload straight into `c.json`,
        // and a payload full of bigints makes `JSON.stringify` throw — so the
        // history endpoint answered 500 the moment an agent had its first
        // fill. Nothing downstream may re-introduce a raw bigint here.
        fills: fills.map((fill) => ({
          seq: fill.seq,
          atMs: fill.atMs,
          kind: fill.kind,
          ...(jsonSafe(fill.payload) as Record<string, unknown>),
        })),
        // The disclosure and the null live-only facts ride on THIS projection
        // too (finding 5, second half). A history view is exactly where a
        // reader would look for a transaction hash.
        disclosure: {
          simulated: true,
          omits: agent.kind === "grid" ? DEMO_GRID_OMISSIONS : DEMO_TRADE_OMISSIONS,
        },
        ...DEMO_LIVE_ONLY_FACTS,
      },
    });
  });

  app.post("/demo/agents/:id/stop", async (c) => {
    const owner = ownerOf(c);
    if (owner === null) return demoFail(c, 404, "not_found");
    const stopped = await deps.store.stop(owner, c.req.param("id"));
    if (!stopped) return demoFail(c, 404, "not_found");
    const agent = await deps.store.get(owner, c.req.param("id"));
    return agent === null
      ? demoFail(c, 404, "not_found")
      : c.json({ data: { agent: agentView(agent) } });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

async function createGrid(input: {
  readonly body: Record<string, unknown>;
  readonly owner: DemoOwnerId;
  readonly deps: DemoServerDeps;
  readonly now: number;
  readonly id: string;
  readonly c: Context;
}): Promise<Response> {
  const { body, deps, c } = input;
  const token0 = parseAddress(body["token0"]);
  const token1 = parseAddress(body["token1"]);
  const fee = body["fee"];
  const budgetQuoteWei = parseBnb(body["budgetBnb"]);
  const gapRaw = body["gapTicks"];
  const widthRaw = body["widthTicks"];
  const levels = body["levels"] === 2 ? 2 : 1;
  if (
    token0 === null
    || token1 === null
    || typeof fee !== "number"
    || !Number.isInteger(fee)
    || budgetQuoteWei === null
    || typeof gapRaw !== "number"
    || typeof widthRaw !== "number"
    || !Number.isInteger(gapRaw)
    || !Number.isInteger(widthRaw)
    || gapRaw < 0
    || widthRaw <= 0
  ) {
    return demoFail(c, 400, "invalid_request", "The demo grid request is incomplete.");
  }
  const wbnb = deps.wbnb.toLowerCase();
  if (token0.toLowerCase() !== wbnb && token1.toLowerCase() !== wbnb) {
    // The engine prices everything in the QUOTE leg, and the quote is WBNB.
    // A pool with no WBNB leg has no quote to report a result in, so it is
    // refused rather than reported in a unit nobody asked for.
    return demoFail(c, 400, "invalid_request", "A demo grid runs on a WBNB pair.");
  }

  let pool: Address | null;
  let reading: { currentTick: number; tickSpacing: number } | null;
  let poolToken0: Address | null;
  try {
    pool = await deps.getPool(token0, token1, fee);
    reading = pool === null ? null : await deps.poolTick(pool);
    poolToken0 = pool === null ? null : await deps.poolToken0(pool);
  } catch {
    pool = null;
    reading = null;
    poolToken0 = null;
  }
  if (pool === null || reading === null || poolToken0 === null) {
    return demoFail(c, 503, "unavailable", "That pool's price could not be read right now.");
  }

  const gapTicks = quantiseUp(gapRaw, reading.tickSpacing);
  const widthTicks = Math.max(reading.tickSpacing, quantiseUp(widthRaw, reading.tickSpacing));
  // From the POOL, not from the request (review finding 14).
  const wbnbIsToken0 = poolToken0.toLowerCase() === wbnb;
  let grid: LpGridSettings;
  try {
    const geometry = {
      currentTick: reading.currentTick,
      tickSpacing: reading.tickSpacing,
      gapTicks,
      widthTicks,
      wbnbIsToken0,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    };
    const base = {
      // Stored in POOL ORDER, so the persisted grid and the chain agree even
      // when the request listed the pair the other way round.
      pool: poolToken0.toLowerCase() === token0.toLowerCase()
        ? { token0, token1, fee }
        : { token0: token1, token1: token0, fee },
      wbnbIsToken0,
      tickSpacing: reading.tickSpacing,
      maxFlipsPerDay: 24,
      minNetEdgeBps: 0,
    };
    // Two explicit branches rather than one spread: the dual derivation returns
    // four rungs and the single one returns two, and a spread would let a
    // half-populated pair through the type — the both-or-neither rule the
    // codec's own parser refuses (PHASE3.17 review2 N14).
    if (levels === 2) {
      const derived = gridDeriveDualRanges(geometry);
      grid = {
        ...base,
        buyRange: derived.buyRange,
        sellRange: derived.sellRange,
        buyRange2: derived.buyRange2,
        sellRange2: derived.sellRange2,
      };
    } else {
      const derived = gridDeriveRanges(geometry);
      grid = { ...base, buyRange: derived.buyRange, sellRange: derived.sellRange };
    }
  } catch (error) {
    return demoFail(
      c,
      400,
      "invalid_request",
      error instanceof Error ? error.message : "That grid geometry is not valid.",
    );
  }

  let state;
  try {
    state = demoGridArm({ grid, currentTick: reading.currentTick, budgetQuoteWei });
  } catch (error) {
    return demoFail(
      c,
      400,
      "invalid_request",
      error instanceof DemoGridArmError ? error.message : "That grid could not be armed.",
    );
  }

  const record: DemoAgentRecord = {
    id: input.id,
    ownerId: input.owner,
    kind: "grid",
    name: parseName(body["name"], "Demo Grid Agent"),
    status: "running",
    createdAtMs: input.now,
    expiresAtMs: input.now + deps.config.ttlDays * 86_400_000,
    lastTickAtMs: null,
    holdReason: null,
    config: {
      pool,
      grid,
      budgetQuoteWei,
      quoteSymbol: "WBNB",
      baseSymbol: typeof body["baseSymbol"] === "string" ? body["baseSymbol"].slice(0, 12) : "TOKEN",
    },
    state: {
      kind: "grid",
      levels: state.levels.map((level) => ({ ...level })),
      costQuoteWei: state.costQuoteWei,
      flips: state.flips,
    },
    llmCallsToday: 0,
    llmDayUtc: demoUtcDay(input.now),
  };
  return finish(c, deps, record);
}

async function createTrade(input: {
  readonly body: Record<string, unknown>;
  readonly owner: DemoOwnerId;
  readonly deps: DemoServerDeps;
  readonly now: number;
  readonly id: string;
  readonly c: Context;
}): Promise<Response> {
  const { body, deps, c } = input;
  const capitalQuoteWei = parseBnb(body["capitalBnb"]);
  const model = typeof body["model"] === "string" ? body["model"] : null;
  if (capitalQuoteWei === null || model === null) {
    return demoFail(c, 400, "invalid_request", "The demo trading request is incomplete.");
  }
  if (deps.tradeUniverse === undefined) {
    return demoFail(c, 503, "unavailable", "Demo trading is not available on this deployment.");
  }
  let universe: readonly DemoUniverseRow[];
  try {
    universe = await deps.tradeUniverse(model);
  } catch {
    return demoFail(c, 503, "unavailable", "The token list could not be read right now.");
  }
  if (universe.length === 0) {
    return demoFail(c, 503, "unavailable", "That model has no eligible tokens right now.");
  }

  // The form's own value when it sends one, clamped to the live agent's range
  // (1..10, `checkTradeSizing`). Three is the default a request without one
  // gets, and it is what the buy size divides by.
  const requested = body["maxOpenPositions"];
  const maxOpenPositions =
    typeof requested === "number" && Number.isInteger(requested) && requested >= 1 && requested <= 10
      ? requested
      : 3;
  const record: DemoAgentRecord = {
    id: input.id,
    ownerId: input.owner,
    kind: "trade",
    name: parseName(body["name"], "Demo Trading Agent"),
    status: "running",
    createdAtMs: input.now,
    expiresAtMs: input.now + deps.config.ttlDays * 86_400_000,
    lastTickAtMs: null,
    holdReason: null,
    config: {
      quoteToken: deps.wbnb,
      model,
      universe: universe.map((row) => ({ address: row.address, symbol: row.symbol })),
      capitalQuoteWei,
      // DEFAULTS ON (fix-review finding 10). The operator's decision was "LLM
      // on, with a daily budget", and a default of false meant a browser that
      // never sends the field — which is every browser — could not reach the
      // brain at all, budgets or no budgets. An explicit `false` still turns it
      // off, and a deployment with no key configured has no brain to consult
      // regardless, so this flag decides nothing on its own.
      brainEnabled: body["brainEnabled"] !== false,
      settings: {
        buySizeQuoteWei: capitalQuoteWei / BigInt(maxOpenPositions),
        maxOpenPositions,
        stopLossBps: intOrNull(body["stopLossBps"]),
        takeProfitBps: intOrNull(body["takeProfitBps"]),
        maxHoldSec: intOrNull(body["maxHoldSec"]),
      },
    },
    state: {
      kind: "trade",
      cashQuoteWei: capitalQuoteWei,
      positions: [],
      realisedQuoteWei: 0n,
      costQuoteWei: 0n,
      trades: 0,
    },
    llmCallsToday: 0,
    llmDayUtc: demoUtcDay(input.now),
  };
  return finish(c, deps, record);
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

async function finish(
  c: Context,
  deps: DemoServerDeps,
  record: DemoAgentRecord,
): Promise<Response> {
  const outcome = await deps.store.create(record, deps.config.maxAgentsPerOwner);
  if (!outcome.ok) {
    return outcome.reason === "at-cap"
      ? demoFail(
          c,
          409,
          "at_cap",
          `You already have ${deps.config.maxAgentsPerOwner} demo agents running. Stop one to start another.`,
        )
      : demoFail(c, 409, "conflict", "That demo agent already exists.");
  }
  return c.json({ data: { agent: agentView(outcome.record) } }, 201);
}
