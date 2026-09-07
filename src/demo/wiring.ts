/**
 * DEMO MODE — the one composition site.
 *
 * Everything demo mode needs is assembled here and nowhere else, so the server,
 * the worker script and the dev stack all get the same object and there is no
 * second place for a default to drift. It is the `src/lp/wiring.ts` pattern at
 * a tenth of the size, because demo mode has a tenth of the collaborators and
 * none of the dangerous ones.
 *
 * COLLABORATORS, and what each is allowed to be:
 *
 *   - the store           Postgres when `DATABASE_URL` is set, memory otherwise.
 *                         Memory is a legitimate deployment here: losing every
 *                         demo on a restart costs simulations, not money.
 *   - the pool reader     `src/demo/poolReader.ts` — two read-only calls.
 *   - prices              the data plane's batched token read, shared across
 *                         every demo trade agent in a cycle.
 *   - the universe        the data plane's lane list, pinned ONCE at creation.
 *   - the brain           absent unless a key is configured. Absent is the
 *                         supported case and costs a demo nothing but the
 *                         heuristic path.
 */
import type { Address } from "viem";

import { createDemoPoolReader, DEMO_WBNB_56, type DemoPoolReader } from "./poolReader.js";
import { resolveDemoConfig, type DemoConfig, type DemoEnv } from "./config.js";
import type { DemoServerDeps, DemoUniverseRow } from "./routes.js";
import type { DemoBrain, DemoPriceReader, DemoWorkerDeps } from "./worker.js";
import {
  MemoryDemoAgentStore,
  PostgresDemoAgentStore,
  type DemoAgentStore,
} from "../store/demoAgents.js";
import {
  HttpTradeDataPlaneReads,
  type TradeDataPlaneReads,
} from "../trade/dataPlaneReads.js";
import { pinUniverse } from "../trade/universe.js";
import type { TradeExecutionModel } from "../trade/settings.js";
import { buildExitPrompt, createTradeLlm, validateExitResponse } from "../trade/llm.js";

/** Public BSC RPC endpoints, used when the operator names none. */
const DEFAULT_DEMO_RPC_URLS = ["https://bsc-dataseed.bnbchain.org"] as const;

/**
 * The data plane's own hard limit on `tokensBatch` (`BATCH_MAX` in
 * `src/trade/dataPlaneReads.ts`), restated because it is not exported. Over it,
 * the call THROWS rather than truncating.
 */
const TOKENS_BATCH_MAX = 50;

/** The four live execution models. A demo runs the same set and no others. */
const TRADE_EXECUTION_MODELS = ["blue-chip", "mid-cap", "degen", "sigma"] as const;

function isTradeExecutionModel(value: string): value is TradeExecutionModel {
  return (TRADE_EXECUTION_MODELS as readonly string[]).includes(value);
}

export type DemoWiring = {
  readonly config: DemoConfig;
  readonly store: DemoAgentStore;
  readonly server: DemoServerDeps;
  readonly worker: DemoWorkerDeps;
  readonly close: () => Promise<void>;
};

/**
 * Build demo mode, or answer `null` when it is off.
 *
 * `null` rather than a disabled object: the server mounts nothing at all when
 * demo mode is off, which is what makes `/demo/*` a real 404 instead of a
 * route that exists and refuses.
 */
export async function buildDemoWiring(input: {
  readonly env: DemoEnv;
  readonly dataPlaneUrl?: string;
  readonly dataPlaneToken?: string;
  readonly poolReader?: DemoPoolReader;
  readonly store?: DemoAgentStore;
  /** Injected for the offline tests; production builds one from the URL. */
  readonly dataPlaneReads?: TradeDataPlaneReads;
}): Promise<DemoWiring | null> {
  const config = resolveDemoConfig(input.env);
  if (!config.enabled) return null;

  const store =
    input.store
    ?? (typeof input.env["DATABASE_URL"] === "string" && input.env["DATABASE_URL"].trim() !== ""
      ? await PostgresDemoAgentStore.fromUrl(input.env["DATABASE_URL"].trim())
      : new MemoryDemoAgentStore());

  const rpcUrls = (input.env["DEMO_RPC_URLS"] ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  const pools =
    input.poolReader
    ?? createDemoPoolReader({
      rpcUrls: rpcUrls.length > 0 ? rpcUrls : [...DEFAULT_DEMO_RPC_URLS],
    });

  const dataPlane: TradeDataPlaneReads | null =
    input.dataPlaneReads
    ?? (input.dataPlaneUrl === undefined || input.dataPlaneUrl.trim() === ""
      ? null
      : new HttpTradeDataPlaneReads({
          baseUrl: input.dataPlaneUrl.trim(),
          ...(input.dataPlaneToken === undefined ? {} : { token: input.dataPlaneToken }),
        }));

  const prices: DemoPriceReader = async (tokens) => {
    const out = new Map<string, { priceUsd: number; change24hPct: number | null }>();
    if (dataPlane === null || tokens.length === 0) return out;
    // CHUNKED, and this is a review fix (finding 6): `tokensBatch` REFUSES
    // more than 50 addresses, and the worker hands it the union of every due
    // agent's universe. Two disjoint 25-token universes plus WBNB already
    // exceeded it, and the refusal surfaced as an empty price map — i.e. every
    // demo trade agent silently held for the whole cycle. The first version's
    // "batched in the data plane's own chunk size" comment described chunking
    // it did not do.
    //
    // A failing chunk costs its own tokens and no others: the agents priced by
    // the chunks that did answer keep running.
    for (let index = 0; index < tokens.length; index += TOKENS_BATCH_MAX) {
      const chunk = tokens.slice(index, index + TOKENS_BATCH_MAX);
      let rows;
      try {
        rows = await dataPlane.tokensBatch(chunk);
      } catch {
        continue;
      }
      for (const row of rows) {
        if (row.priceUsd === null || row.priceUsd <= 0) continue;
        out.set(row.address.toLowerCase(), {
          priceUsd: row.priceUsd,
          change24hPct: row.priceChange24hPct,
        });
      }
    }
    return out;
  };

  const tradeUniverse = async (model: string): Promise<readonly DemoUniverseRow[]> => {
    if (dataPlane === null || !isTradeExecutionModel(model)) return [];
    // THE LIVE PIN, unmodified (fix-review finding 12).
    //
    // The first version took the first 25 rows of one lane and the plan
    // justified it by claiming `pinUniverse` needs balance readers and a
    // granted token set. That was FALSE — its deps are `universe` and
    // `tokensBatch` and nothing else (`PinUniverseDeps`, `src/trade/universe.ts`)
    // — and the divergence it caused was real: an offline fixture put five
    // $1M-cap tokens into a mid-cap demo that live rejects outright. Lane
    // selection, the market-cap band, 24 h volume ranking and deduplication now
    // come from the same function the live hire pins with, so a demo cannot
    // advertise a universe the agent it demonstrates would refuse.
    //
    // Its refusals are not a demo's problem to escalate: an unreadable or
    // too-small universe answers empty, and the route turns that into a 503
    // with a reason rather than a 500.
    try {
      const pinned = await pinUniverse(model, { dataPlane });
      return pinned.map((row) => ({ address: row.address, symbol: row.symbol }));
    } catch {
      return [];
    }
  };

  const server: DemoServerDeps = {
    store,
    config,
    getPool: (token0: Address, token1: Address, fee: number) => pools.getPool(token0, token1, fee),
    poolTick: (pool: Address) => pools.poolTick(pool),
    poolToken0: (pool: Address) => pools.poolToken0(pool),
    wbnb: DEMO_WBNB_56,
    ...(dataPlane === null ? {} : { tradeUniverse }),
  };

  // ── the brain ────────────────────────────────────────────────────────────
  // FIX-REVIEW FINDING 10: the operator's decision was "LLM on, with a daily
  // budget", and the first build enforced the budget while wiring no brain at
  // all — so configuring a key could not enable anything. It is wired here,
  // from the SAME provider the trade worker uses, and it is absent (heuristic
  // only) when no key is configured, which stays the supported case.
  //
  // The key lives in `createTradeLlm`'s closure and reaches no record, no log
  // and no prompt. Both ceilings are claimed durably BEFORE the call, in the
  // worker; nothing here can spend outside them.
  const llmKey = (input.env["TRADE_LLM_API_KEY"] ?? "").trim();
  const brain: DemoBrain | undefined =
    llmKey === ""
      ? undefined
      : (() => {
          const llm = createTradeLlm({
            readKey: () => llmKey,
            ...(input.env["TRADE_LLM_MODEL"] === undefined
              ? {}
              : { model: input.env["TRADE_LLM_MODEL"] }),
            ...(input.env["TRADE_LLM_BASE_URL"] === undefined
              ? {}
              : { baseUrl: input.env["TRADE_LLM_BASE_URL"] }),
          });
          return async ({ holdings }) => {
            const positions = holdings.map((holding, index) => ({
              index,
              symbol: holding.symbol,
              tokenAddress: holding.token,
              pnlBps: holding.pnlBps ?? 0n,
              ageSec: 0,
              takeProfitBps: null,
              stopLossBps: null,
            }));
            const { content } = await llm.complete(
              buildExitPrompt({ positions, owner: { instructions: null, skillMarkdown: null } }),
            );
            // The response schema is INDEX-ONLY and validated by the live
            // validator, so no model output can name a token or reach past the
            // holdings it was shown.
            const validated = validateExitResponse(content, positions.length);
            // An invalid answer is NO answer, never a default: the heuristic
            // path already decided everything the brain was asked to refine.
            if (!validated.ok) return [];
            return validated.decisions.flatMap((decision) => {
              const holding = holdings[decision.index];
              if (holding === undefined) return [];
              return [{
                token: holding.token,
                exit: decision.exit,
                ...(decision.reason === undefined ? {} : { reason: decision.reason }),
              }];
            });
          };
        })();

  const worker: DemoWorkerDeps = {
    store,
    config,
    poolTick: (pool: Address) => pools.poolTick(pool),
    prices,
    ...(brain === undefined ? {} : { brain }),
  };

  return { config, store, server, worker, close: () => store.close() };
}
