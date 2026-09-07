/**
 * DEMO MODE — the worker.
 *
 * ─── THE COST DESIGN IS THE DESIGN (plan §5) ───────────────────────────────
 *
 * A live agent is bounded by money: it costs its owner something to exist, so
 * nobody makes a thousand. A demo agent is free, created by an anonymous
 * cookie, and therefore has NO natural bound at all. Everything below follows
 * from that one fact:
 *
 *   - ONE loop for every demo agent, never a loop per agent.
 *   - Reads are shared PER POOL and PER TOKEN BATCH, never per agent. A hundred
 *     demo grids on one pool cost exactly one tick read, which is why a hundred
 *     of them cost about what one costs.
 *   - `GET /lp/pools/:address/state` is NOT used: that route says in its own
 *     header that it carries an RPC read per call with no cache. The worker
 *     holds the reader directly and reads each distinct pool once.
 *   - Nothing per-tick is persisted. A cycle replaces ONE rolling snapshot per
 *     agent and appends only actual fills, so a demo agent's row count grows
 *     with what HAPPENED, not with how long it ran.
 *   - The agent count per cycle is bounded, and expired agents are swept by the
 *     same loop that advances the live ones.
 *
 * ─── WHAT IT CANNOT DO ─────────────────────────────────────────────────────
 *
 * There is no session, no key, no journal, no sequence and no submit anywhere
 * below. The worker's entire output is rows in `demo_agents` / `demo_fills`.
 * Every collaborator is injected as a narrow function type, so the offline
 * tests drive the whole loop with no chain and no data plane.
 */
import type { Address } from "viem";

import {
  demoGridStep,
  type DemoGridState,
} from "./gridEngine.js";
import {
  demoTradeStep,
  type DemoTradeBrainVerdict,
  type DemoTradeCandidate,
  type DemoTradeMark,
  type DemoTradeState,
} from "./tradeEngine.js";
import { pnlBps } from "../trade/exits.js";
import { demoUtcDay, type DemoConfig } from "./config.js";
import {
  parseDemoGridConfig,
  parseDemoGridState,
  parseDemoTradeConfig,
  parseDemoTradeState,
  serialiseGridFill,
  serialiseTradeFill,
  type DemoTradeConfig,
} from "./codec.js";
import type {
  DemoAgentRecord,
  DemoAgentStore,
  DemoFillRecord,
} from "../store/demoAgents.js";

/* -------------------------------------------------------------------------- */
/* Injected collaborators                                                     */
/* -------------------------------------------------------------------------- */

/** One pool's live tick. `null` when the pool is unreadable this cycle. */
export type DemoPoolTickReader = (
  pool: Address,
) => Promise<{ readonly currentTick: number; readonly tickSpacing: number } | null>;

/** A token's USD price, batched. Missing entries simply do not appear. */
export type DemoPriceReader = (
  tokens: readonly Address[],
) => Promise<ReadonlyMap<string, { readonly priceUsd: number; readonly change24hPct: number | null }>>;

/**
 * The optional brain. Returns a verdict per held token, and is called ONLY
 * when the day's budget allows — the caller has already decided that, so an
 * implementation never needs to know about budgets.
 */
export type DemoBrainHolding = {
  readonly token: Address;
  readonly symbol: string;
  /** `null` when this token had no readable price this cycle. */
  readonly pnlBps: bigint | null;
  readonly ageSec: number;
  readonly takeProfitBps: number | null;
  readonly stopLossBps: number | null;
};

export type DemoBrain = (input: {
  readonly agentId: string;
  readonly holdings: readonly DemoBrainHolding[];
}) => Promise<readonly DemoTradeBrainVerdict[]>;

export type DemoWorkerDeps = {
  readonly store: DemoAgentStore;
  readonly config: DemoConfig;
  readonly poolTick: DemoPoolTickReader;
  readonly prices: DemoPriceReader;
  readonly brain?: DemoBrain;
  readonly now?: () => number;
  /** Where a swallowed per-agent error goes. Defaults to silence. */
  readonly onError?: (agentId: string, error: unknown) => void;
};

export type DemoCycleReport = {
  readonly swept: number;
  readonly advanced: number;
  readonly held: number;
  readonly fills: number;
  readonly poolReads: number;
  readonly priceReads: number;
  readonly llmCalls: number;
};

/* -------------------------------------------------------------------------- */
/* One cycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Advance every due demo agent once.
 *
 * A per-agent failure is SWALLOWED and recorded as that agent's hold reason —
 * one broken simulation must not stop the other ninety-nine, and there is no
 * money outcome for an error here to be ambiguous about.
 */
export async function runDemoCycle(deps: DemoWorkerDeps): Promise<DemoCycleReport> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const swept = await deps.store.sweepExpired(nowMs);
  const due = await deps.store.listDue(nowMs, deps.config.maxAgentsPerCycle);

  // ── the shared samplers ──────────────────────────────────────────────────
  // Distinct pools and distinct tokens across EVERY due agent, read once.
  const grids = due.filter((agent) => agent.kind === "grid");
  const trades = due.filter((agent) => agent.kind === "trade");

  const poolByAgent = new Map<string, ReturnType<typeof parseDemoGridConfig>>();
  const pools = new Set<string>();
  for (const agent of grids) {
    const parsed = parseDemoGridConfig(agent.config);
    poolByAgent.set(agent.id, parsed);
    if (parsed !== null) pools.add(parsed.pool.toLowerCase());
  }
  const tickByPool = new Map<string, { currentTick: number; tickSpacing: number } | null>();
  for (const pool of pools) {
    try {
      tickByPool.set(pool, await deps.poolTick(pool as Address));
    } catch {
      tickByPool.set(pool, null);
    }
  }

  const tradeConfigs = new Map<string, DemoTradeConfig | null>();
  const tokens = new Set<string>();
  for (const agent of trades) {
    const parsed = parseDemoTradeConfig(agent.config);
    tradeConfigs.set(agent.id, parsed);
    if (parsed === null) continue;
    tokens.add(parsed.quoteToken.toLowerCase());
    for (const row of parsed.universe) tokens.add(row.address.toLowerCase());
  }
  let priceReads = 0;
  let priceBy: ReadonlyMap<string, { priceUsd: number; change24hPct: number | null }> = new Map();
  if (tokens.size > 0) {
    try {
      priceBy = await deps.prices([...tokens].map((token) => token as Address));
      priceReads = 1;
    } catch {
      priceBy = new Map();
    }
  }

  let advanced = 0;
  let held = 0;
  let fills = 0;
  let llmCalls = 0;
  // The GLOBAL budget lives in the STORE, keyed by UTC day, and is claimed one
  // call at a time. Deliberately not fair-shared across agents: a ceiling any
  // agent can consume is BOUNDED, which is the property that matters, and
  // pretending to be fair across anonymous owners would be theatre.
  //
  // The day is computed AT RESERVATION TIME, not here (fix-review-2 finding 3):
  // a cycle that starts at 23:59:59 and reaches its first agent after midnight
  // was charging the previous day's bucket, so the same wall-clock day could be
  // charged twice over — once by the cycle that straddled it and once by the
  // cycle after.

  for (const agent of due) {
    try {
      const outcome =
        agent.kind === "grid"
          ? await advanceGrid({ agent, deps, nowMs, config: poolByAgent.get(agent.id) ?? null, tickByPool })
          : await advanceTrade({
              agent,
              deps,
              nowMs,
              config: tradeConfigs.get(agent.id) ?? null,
              priceBy,
            });
      llmCalls += outcome.llmCallsUsed;
      if (outcome.holdReason !== null) held += 1;
      else advanced += 1;
      fills += outcome.fills.length;

      // ONE commit for the whole cycle (fix-review finding 13). An earlier
      // repair wrote fills first and argued the next cycle would re-derive a
      // lost one; it would not — the next cycle reads FRESH prices, so its
      // replayed fill is a different fill while the idempotent key keeps the
      // old payload, and state and history disagree for ever afterwards.
      await deps.store.commitCycle({
        id: agent.id,
        state: outcome.state,
        lastTickAtMs: nowMs,
        holdReason: outcome.holdReason,
        llmCallsToday: outcome.llmCallsToday,
        llmDayUtc: outcome.llmDayUtc,
        fills: outcome.fills,
      });
    } catch (error) {
      deps.onError?.(agent.id, error);
      held += 1;
    }
  }

  return { swept, advanced, held, fills, poolReads: pools.size, priceReads, llmCalls };
}

/* -------------------------------------------------------------------------- */
/* Grid                                                                       */
/* -------------------------------------------------------------------------- */

type AdvanceOutcome = {
  readonly state: Readonly<Record<string, unknown>>;
  readonly holdReason: string | null;
  readonly fills: readonly DemoFillRecord[];
  readonly llmCallsToday: number;
  readonly llmCallsUsed: number;
  /** The UTC day `llmCallsToday` counts against, decided when it was charged. */
  readonly llmDayUtc: string;
};

async function advanceGrid(input: {
  readonly agent: DemoAgentRecord;
  readonly deps: DemoWorkerDeps;
  readonly nowMs: number;
  readonly config: ReturnType<typeof parseDemoGridConfig>;
  readonly tickByPool: ReadonlyMap<string, { currentTick: number; tickSpacing: number } | null>;
}): Promise<AdvanceOutcome> {
  const keep = {
    state: input.agent.state,
    fills: [] as DemoFillRecord[],
    llmCallsToday: input.agent.llmCallsToday,
    llmCallsUsed: 0,
    llmDayUtc: input.agent.llmDayUtc,
  };
  if (input.config === null) {
    return { ...keep, holdReason: "This demo's configuration could not be read." };
  }
  const reading = input.tickByPool.get(input.config.pool.toLowerCase()) ?? null;
  if (reading === null) {
    // An unreadable pool is MISSING EVIDENCE, and the demo's answer to missing
    // evidence is the plane's: hold, say why, change nothing.
    return { ...keep, holdReason: "The pool's price could not be read this cycle." };
  }
  const state = parseDemoGridState(input.agent.state);
  if (state === null) {
    return { ...keep, holdReason: "This demo's saved state could not be read." };
  }

  const out = demoGridStep({
    grid: input.config.grid,
    state,
    currentTick: reading.currentTick,
    atMs: input.nowMs,
    relayFeePerSubmitWei: input.deps.config.relayFeePerSubmitWei,
    submissionsPerFlip: 2,
  });

  const baseSeq = seqFloor(state);
  const fills = out.fills.map((fill, index): DemoFillRecord => ({
    agentId: input.agent.id,
    seq: baseSeq + index + 1,
    atMs: fill.atMs,
    kind: "grid-flip",
    payload: serialiseGridFill(fill),
  }));

  return {
    state: serialiseGridState(out.state, { tick: reading.currentTick, atMs: input.nowMs }),
    holdReason: out.holds[0]?.reason ?? null,
    fills,
    llmCallsToday: input.agent.llmCallsToday,
    llmCallsUsed: 0,
    llmDayUtc: input.agent.llmDayUtc,
  };
}

function seqFloor(state: DemoGridState | DemoTradeState): number {
  return "flips" in state ? state.flips : state.trades;
}

function serialiseGridState(
  state: DemoGridState,
  observed: { readonly tick: number; readonly atMs: number } | null,
): Readonly<Record<string, unknown>> {
  return {
    kind: "grid",
    levels: state.levels.map((level) => ({
      level: level.level,
      role: level.role,
      liquidity: level.liquidity,
      openCycleQuoteWei: level.openCycleQuoteWei,
      cycles: level.cycles,
      realisedQuoteWei: level.realisedQuoteWei,
    })),
    costQuoteWei: state.costQuoteWei,
    flips: state.flips,
    // The tick this cycle acted on, kept so a viewer can see WHERE the price
    // is relative to the rungs rather than only what has already filled. It is
    // an OBSERVATION with its own timestamp — a screen must age it rather than
    // present it as current, and a cycle that could not read the pool leaves
    // the previous one in place rather than blanking it.
    ...(observed === null ? {} : { lastTick: observed.tick, lastTickAtMs: observed.atMs }),
  };
}

/* -------------------------------------------------------------------------- */
/* Trade                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A token's price expressed in the agent's QUOTE (BNB), scaled 1e18.
 *
 * The demo tracks a position's size as an abstract 18-dp quantity rather than
 * real token units, because it never touches a real token and therefore never
 * learns its `decimals()`. Nothing else in this repo reads `decimals()` without
 * a source (`humanPriceAtTick`'s own warning), and a demo that guessed 18 for
 * every token would be quietly wrong for USDC-shaped ones. An abstract quantity
 * is not a guess: it is exact for the only arithmetic the demo does, which is
 * quote in -> quote out.
 */
function priceInQuoteWei(
  tokenPriceUsd: number,
  quotePriceUsd: number,
): bigint | null {
  if (!Number.isFinite(tokenPriceUsd) || !Number.isFinite(quotePriceUsd)) return null;
  if (tokenPriceUsd <= 0 || quotePriceUsd <= 0) return null;
  const ratio = tokenPriceUsd / quotePriceUsd;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  // 1e18-scaled, floored. The float is confined to the price feed itself, which
  // arrives as a float from the data plane; every amount downstream is bigint.
  return BigInt(Math.floor(ratio * 1e18));
}

async function advanceTrade(input: {
  readonly agent: DemoAgentRecord;
  readonly deps: DemoWorkerDeps;
  readonly nowMs: number;
  readonly config: DemoTradeConfig | null;
  readonly priceBy: ReadonlyMap<string, { priceUsd: number; change24hPct: number | null }>;
}): Promise<AdvanceOutcome> {
  // The day the reservation will be charged against, computed HERE rather than
  // at cycle start (fix-review-2 finding 3).
  const day = demoUtcDay(input.nowMs);
  const rolledOver = input.agent.llmDayUtc === day ? input.agent.llmCallsToday : 0;
  const keep = {
    state: input.agent.state,
    fills: [] as DemoFillRecord[],
    llmCallsToday: rolledOver,
    llmCallsUsed: 0,
    llmDayUtc: day,
  };
  const config = input.config;
  if (config === null) {
    return { ...keep, holdReason: "This demo's configuration could not be read." };
  }
  const state = parseDemoTradeState(input.agent.state);
  if (state === null) {
    return { ...keep, holdReason: "This demo's saved state could not be read." };
  }
  const quote = input.priceBy.get(config.quoteToken.toLowerCase());
  if (quote === undefined) {
    return { ...keep, holdReason: "The BNB price could not be read this cycle." };
  }

  const marks: DemoTradeMark[] = [];
  for (const position of state.positions) {
    const row = input.priceBy.get(position.token.toLowerCase());
    if (row === undefined) continue;
    const priceWei = priceInQuoteWei(row.priceUsd, quote.priceUsd);
    if (priceWei === null) continue;
    marks.push({ token: position.token, quoteOutWei: (position.baseWei * priceWei) / 10n ** 18n });
  }

  // Candidates are ranked by 24h momentum, which is a HEURISTIC and is labelled
  // one. It is the demo's whole entry rule whenever the brain has no budget,
  // and it is deliberately simple: an elaborate entry model would be a claim
  // about the live agent that the live agent does not make.
  const openTokens = new Set(state.positions.map((position) => position.token.toLowerCase()));
  const candidates: DemoTradeCandidate[] = [];
  for (const row of [...config.universe].sort(
    (left, right) =>
      (input.priceBy.get(right.address.toLowerCase())?.change24hPct ?? -Infinity)
      - (input.priceBy.get(left.address.toLowerCase())?.change24hPct ?? -Infinity),
  )) {
    if (openTokens.has(row.address.toLowerCase())) continue;
    const priced = input.priceBy.get(row.address.toLowerCase());
    if (priced === undefined) continue;
    const priceWei = priceInQuoteWei(priced.priceUsd, quote.priceUsd);
    if (priceWei === null || priceWei === 0n) continue;
    candidates.push({
      token: row.address,
      symbol: row.symbol,
      baseOutWei: (config.settings.buySizeQuoteWei * 10n ** 18n) / priceWei,
    });
  }

  // ── the brain, budgeted ─────────────────────────────────────────────────
  // Two ceilings, both failing CLOSED to the heuristic: a spent budget means
  // the agent keeps trading and simply stops asking. The per-agent counter
  // resets on a UTC day change, which is why the day rides on the row.
  // BOTH ceilings are claimed from the STORE, before the call, in one durable
  // reservation (fix-review finding 4). Neither is a variable in this function
  // any more: the global one reset every cycle in the first version, and the
  // per-agent one rode on the snapshot save in the second, so a throwing
  // provider plus a failed save spent two calls against a ceiling of one.
  //
  // Charged whether or not the call THROWS: a provider that took the request
  // and failed still cost money, and refunding it would be a retry loop.
  let brain: readonly DemoTradeBrainVerdict[] = [];
  let llmCallsUsed = 0;
  if (
    input.deps.brain !== undefined
    && config.brainEnabled
    && state.positions.length > 0
    && (await input.deps.store.reserveLlmCall({
      agentId: input.agent.id,
      dayUtc: day,
      globalCeiling: input.deps.config.llmCallsPerDay,
      perAgentCeiling: input.deps.config.llmCallsPerAgentPerDay,
      minIntervalMs: input.deps.config.llmMinIntervalSec * 1_000,
      nowMs: input.nowMs,
    }))
  ) {
    llmCallsUsed = 1;
    try {
      // REAL FACTS, or none (fix-review-2 finding 7). The first wiring sent
      // `pnlBps: null` for every holding, which the prompt builder then rendered
      // as `0`, alongside `ageSec: 0` and absent thresholds — so the model was
      // asked to judge positions it was told were flat, brand new and
      // unconstrained, and could trigger an exit off facts that were invented.
      // A holding with no readable price this cycle carries `null`, and the
      // caller must render that as unavailable rather than as zero.
      const markBy = new Map(marks.map((mark) => [mark.token.toLowerCase(), mark.quoteOutWei]));
      brain = await input.deps.brain({
        agentId: input.agent.id,
        holdings: state.positions.map((position) => {
          const quoteOutWei = markBy.get(position.token.toLowerCase());
          return {
            token: position.token,
            symbol: position.symbol,
            pnlBps:
              quoteOutWei === undefined ? null : pnlBps(quoteOutWei, position.entryQuoteWei),
            ageSec: Math.max(0, Math.floor((input.nowMs - position.openedAtMs) / 1_000)),
            takeProfitBps: config.settings.takeProfitBps,
            stopLossBps: config.settings.stopLossBps,
          };
        }),
      });
    } catch {
      brain = [];
    }
  }

  const out = demoTradeStep({
    state,
    settings: config.settings,
    nowMs: input.nowMs,
    marks,
    candidates,
    brain,
    relayFeePerSubmitWei: input.deps.config.relayFeePerSubmitWei,
    exitRequested: [],
  });

  const baseSeq = state.trades;
  const fills = out.fills.map((fill, index): DemoFillRecord => ({
    agentId: input.agent.id,
    seq: baseSeq + index + 1,
    atMs: fill.atMs,
    kind: `trade-${fill.side}`,
    payload: serialiseTradeFill(fill),
  }));

  const unmarked = state.positions.length - marks.length;
  return {
    state: serialiseTradeState(out.state),
    holdReason:
      unmarked > 0
        ? `${unmarked} held token${unmarked === 1 ? "" : "s"} had no readable price this cycle and ${unmarked === 1 ? "was" : "were"} left alone.`
        : null,
    fills,
    llmCallsToday: rolledOver + llmCallsUsed,
    llmCallsUsed,
    llmDayUtc: day,
  };
}

function serialiseTradeState(state: DemoTradeState): Readonly<Record<string, unknown>> {
  return {
    kind: "trade",
    cashQuoteWei: state.cashQuoteWei,
    positions: state.positions.map((position) => ({
      token: position.token,
      symbol: position.symbol,
      baseWei: position.baseWei,
      entryQuoteWei: position.entryQuoteWei,
      openedAtMs: position.openedAtMs,
    })),
    realisedQuoteWei: state.realisedQuoteWei,
    costQuoteWei: state.costQuoteWei,
    trades: state.trades,
  };
}

/* -------------------------------------------------------------------------- */
/* The daemon                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run {@link runDemoCycle} forever on the configured cadence.
 *
 * `unref`'d, so a demo worker embedded in the API process never holds the
 * process open on its own — the demo plane must not be the reason a deployment
 * refuses to shut down.
 */
export function startDemoWorker(deps: DemoWorkerDeps): { stop: () => void } {
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await runDemoCycle(deps);
    } catch (error) {
      deps.onError?.("(cycle)", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.config.workerIntervalMs);
  timer.unref?.();
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
