/**
 * PHASE3.15 — the worker's grid seams: the EXCLUSIVE evaluator dispatch, the
 * flag-off skip on both paths, the exhaustive decision → saga map, and the
 * regression pin that says the non-grid path did not move.
 *
 * WHY THE DISPATCH MAP HAS ITS OWN TESTS. `worker.ts` mapped a decision onto a
 * saga kind with a TERNARY whose catch-all default was `protect` — a full EXIT
 * of the position. TypeScript cannot make a ternary exhaustive, so a decision
 * member added without an arm dispatched a liquidation, silently, with no
 * compile error. This phase converts it to an exhaustive switch, and the tests
 * below are what stop a future reader converting it back.
 *
 * Offline: memory stores, a fake chain, zero provider calls on every path this
 * file exercises.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  NOW_SEC,
  ROUTER_V3,
  SESSION_KEY,
  TOKEN,
  WBNB,
  FakeWalletProvider,
  ownerAccount,
} from "./support/serverHarness.js";
import { MemoryAgentStore, type SessionFacts } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { MemoryLpGridCycleStore } from "../src/store/gridCycles.js";
import type { SessionSpec } from "../src/core/types.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import type { LpWorkerChainReaders } from "../src/lp/readers.js";
import {
  DEFAULT_LP_SETTINGS,
  type LpAutomationSettings,
  type LpGridSettings,
  type LpManagementDecision,
} from "../src/lp/triggers.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  LP_GRID_DISABLED_REASON,
  LP_SAGA_PLANS,
  createLpWorkerState,
  lpDispatchKindFor,
  runLpWorkerOnce,
  type LpWorkerDeps,
} from "../src/lp/worker.js";

const AGENT_ID = "grid-worker-agent";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const POSITION_ID = "grid-position-1";
const TOKEN_ID = "777";
const INTERVAL_MS = 30_000;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

/**
 * The fixture's pool is `token0 = WBNB` (`0x2222…` sorts below `0x5555…`), so
 * `wbnbIsToken0` is TRUE — the Case-B orientation, and the one that inverts
 * every role-named side rule.
 */
const GRID: LpGridSettings = {
  pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
  wbnbIsToken0: true,
  tickSpacing: 50,
  // Case B: the quote-holding buy level sits ABOVE the sell level.
  buyRange: { tickLower: 500, tickUpper: 1_000 },
  sellRange: { tickLower: -1_000, tickUpper: -500 },
  maxFlipsPerDay: 12,
  minNetEdgeBps: 0,
};

function lpSessionSpec(expiresAt: number): SessionSpec {
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "approve(address,uint256)" },
    ],
    spendCaps: [
      { limit: 10n ** 18n, period: "day" },
      { limit: 2n ** 160n, period: "day", token: TOKEN },
      { limit: 2n ** 160n, period: "day", token: WBNB },
    ],
    expiresAt,
  };
}

function lpSessionFacts(expiresAt: number): SessionFacts {
  return {
    spec: lpSessionSpec(expiresAt),
    permissions: { calls: [], spend: [] },
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: expiresAt,
  };
}

type Chain = {
  tick: number;
  positions: Map<string, LpPositionSnapshot | "burned">;
  nftOwner: Address | "burned";
};

function fakeReaders(chain: Chain): LpWorkerChainReaders {
  return {
    getPool: async () => POOL,
    poolState: async () => ({
      pool: POOL,
      tickSpacing: 50,
      currentTick: chain.tick,
      evidence: {
        blockNumber: 100n,
        finalizedBlockNumber: 100n,
        observationCardinality: 500,
        poolLiquidity: 10n ** 24n,
        priceImpactBps: 0n,
        spotSqrtPriceX96: 2n ** 96n,
        twapSqrtPriceX96: 2n ** 96n,
      },
    }),
    positions: async (tokenId) => chain.positions.get(tokenId.toString(10)) ?? "burned",
    positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
    ownerOf: async () => chain.nftOwner,
    quote: async (params) => params.amountInWei,
    receipts: {
      collectAmounts: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      swapAmounts: async () => {
        throw new Error("unused");
      },
      mintedTokenId: async () => 888n,
    },
    onChainNativeDailyCapWei: async () => 10n ** 18n,
  };
}

type Fixture = {
  readonly deps: LpWorkerDeps;
  readonly chain: Chain;
  readonly provider: FakeWalletProvider;
  readonly store: MemoryLpSequenceStore;
  readonly observations: MemoryLpObservationStore;
};

async function fixture(
  options: {
    readonly grid?: LpGridSettings | null;
    readonly gridEnabled?: boolean;
    readonly settings?: Partial<LpAutomationSettings>;
    /** The live level's ticks. Defaults to the signed BUY range. */
    readonly live?: { tickLower: number; tickUpper: number };
    readonly tick?: number;
  } = {},
): Promise<Fixture> {
  const now = (): number => NOW_SEC * 1000;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new MemoryLpSequenceStore(now);
  const settingsStore = new MemoryLpSettingsStore(now);
  const observations = new MemoryLpObservationStore();
  const provider = new FakeWalletProvider();
  const live = options.live ?? GRID.buyRange;
  const chain: Chain = {
    tick: options.tick ?? 0,
    positions: new Map([[TOKEN_ID, { liquidity: 1_000n, ...live }]]),
    nftOwner: ownerAccount.address,
  };

  await agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600),
    status: "armed",
  });
  await agentStore.putAgentSessionKey(ownerAccount.address, AGENT_ID, SESSION_KEY);
  await store.createPosition({
    positionId: POSITION_ID,
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    tokenId: TOKEN_ID,
    basisWei: 0n,
    basisSource: "imported",
  });

  const grid = options.grid === undefined ? GRID : options.grid;
  const settings: LpAutomationSettings = {
    ...DEFAULT_LP_SETTINGS,
    ...options.settings,
    grid,
  };
  const params = lpSettingsParamsView(settings);
  await settingsStore.put({
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    params,
    digest: paramsHash("lpSettings", params),
  });

  return {
    chain,
    provider,
    store,
    observations,
    deps: {
      agentStore,
      journal,
      killswitch,
      store,
      settingsStore,
      observations,
      provider,
      readers: fakeReaders(chain),
      rails: RAILS,
      maxTickWidth: 200_000,
      conversionCompatibleTokens: new Set(),
      relayFeePerSubmitWei: 100_000_000_000_000n,
      venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
      gridCycles: new MemoryLpGridCycleStore(),
      ...(options.gridEnabled === undefined ? {} : { gridEnabled: options.gridEnabled }),
      reconcile: async () => {},
      now,
      intervalMs: INTERVAL_MS,
      dryRun: false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* R2.6 / H7 — the decision → saga map                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 H7: the decision map is EXHAUSTIVE, not a catch-all ternary", () => {
  it("maps every money decision to its own saga kind — no silent protect", () => {
    // THE LINE THIS REPLACES: `decision === "rotate" ? "rotate" : decision ===
    // "harvest" ? "harvest" : "protect"`. Under it, `grid-flip` would have
    // dispatched `runLpProtect` — a full exit of the grid level, on the first
    // flip, with no compile error to catch it.
    assert.equal(lpDispatchKindFor("grid-flip"), "grid-flip");
    assert.equal(lpDispatchKindFor("rotate"), "rotate");
    assert.equal(lpDispatchKindFor("harvest"), "harvest");
    for (const decision of [
      "protect-stop-loss",
      "protect-take-profit",
      "protect-price-stop-loss",
      "protect-price-take-profit",
    ] as const) {
      assert.equal(lpDispatchKindFor(decision), "protect");
    }
  });

  it("a hold dispatches nothing, and says so rather than defaulting", () => {
    assert.throws(() => lpDispatchKindFor("hold"), /dispatches no saga/u);
  });

  it("an unmapped decision THROWS rather than routing to the exit path", () => {
    // The `never` binding is a compile-time guard; this is its runtime twin,
    // reached only if someone widens the union through a cast.
    assert.throws(
      () => lpDispatchKindFor("something-new" as LpManagementDecision),
      /unmapped decision/u,
    );
  });

  it("LP_SAGA_PLANS reports the flip's full three positions", () => {
    // A dry run that reported two would UNDER-state the plan a resume walks —
    // the quiet drift this constant exists to prevent.
    assert.deepEqual(LP_SAGA_PLANS["grid-flip"], [
      "zap-out",
      "sweep-token",
      "zap-in-mint",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.6 — the flag-off skip                                                   */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.6: GRID_ENABLED off SKIPS a grid agent, never standard-manages it", () => {
  it("skips the evaluate path with the named reason and touches no chain reader", async () => {
    const f = await fixture({ gridEnabled: false });
    let readerCalls = 0;
    const readers = new Proxy(f.deps.readers, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? async (...args: unknown[]) => {
              readerCalls += 1;
              return Reflect.apply(value, target, args);
            }
          : value;
      },
    });
    const report = await runLpWorkerOnce({ ...f.deps, readers }, createLpWorkerState());
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.equal(outcome?.reason, LP_GRID_DISABLED_REASON);
    // The skip is ABOVE the market read: the position never reaches an
    // evaluator, so no rotate can re-range the level.
    assert.equal(outcome?.decision, undefined);
    // `getPool` and `ownerOf` still run (they precede the branch); the pool
    // STATE read and the valuation do not.
    assert.ok(readerCalls <= 2, `expected at most the context reads, saw ${readerCalls}`);
    assert.equal(f.provider.executeCalls.length, 0);
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("skips a non-terminal grid-flip RESUME too, and leaves the row exactly as it was", async () => {
    const f = await fixture({ gridEnabled: false });
    const sequence = await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "grid-flip",
    });
    await f.store.setRecoveryState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "pending-mint",
    );
    const before = await f.store.getSequence(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
    );
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.equal(outcome?.kind, "grid-flip");
    assert.equal(outcome?.reason, LP_GRID_DISABLED_REASON);
    // Nothing was written: running a money saga under a flag the operator
    // turned off is the wrong posture, and refusing traps nothing — the
    // owner-signed abandon door is unaffected by this flag.
    assert.deepEqual(
      await f.store.getSequence(ownerAccount.address, AGENT_ID, sequence.sequenceId),
      before,
    );
    assert.equal(f.provider.executeCalls.length, 0);
  });

  it("an ABSENT gridEnabled reads as off — the fail-closed default", async () => {
    const f = await fixture({});
    assert.equal(f.deps.gridEnabled, undefined);
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(report.outcomes[0]?.reason, LP_GRID_DISABLED_REASON);
  });
});

/* -------------------------------------------------------------------------- */
/* The EXCLUSIVE dispatch                                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.6: the evaluator dispatch is exclusive and settings-decided", () => {
  it("a grid agent under an ON flag is evaluated by the GRID evaluator", async () => {
    // The live level is the signed BUY range and the tick is inside it, so the
    // grid evaluator holds with ITS vocabulary — which the standard evaluator
    // has no sentence for.
    const f = await fixture({ gridEnabled: true, tick: 750 });
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "hold");
    assert.equal(outcome?.decision, "hold");
    assert.match(String(outcome?.reason), /Grid waiting/u);
    assert.equal(outcome?.observationPersisted, true);
  });

  it("two comparable cycles on a filled level DISPATCH the flip, not a rotate or a protect", async () => {
    // Case B: the buy level [500, 1000) holds token0 = WBNB and fills when the
    // tick rises through it.
    const f = await fixture({ gridEnabled: true, tick: 1_500 });
    const state = createLpWorkerState();
    const first = await runLpWorkerOnce(f.deps, state);
    assert.equal(first.outcomes[0]?.action, "hold");

    // A second finalized observation, one interval later.
    let nowMs = NOW_SEC * 1000 + INTERVAL_MS;
    const readers = {
      ...f.deps.readers,
      poolState: async () => ({
        pool: POOL,
        tickSpacing: 50,
        currentTick: 1_500,
        evidence: {
          blockNumber: 101n,
          finalizedBlockNumber: 101n,
          observationCardinality: 500,
          poolLiquidity: 10n ** 24n,
          priceImpactBps: 0n,
          spotSqrtPriceX96: 2n ** 96n,
          twapSqrtPriceX96: 2n ** 96n,
        },
      }),
    };
    const report = await runLpWorkerOnce(
      { ...f.deps, readers, now: () => nowMs },
      state,
    );
    nowMs += 0;
    const outcome = report.outcomes[0];
    assert.equal(outcome?.decision, "grid-flip");
    assert.equal(outcome?.kind, "grid-flip");
    // The saga actually ran: a sequence of the new kind exists.
    const sequences = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences[0]?.kind, "grid-flip");
  });

  it("a dry run reports the flip's plan and writes NOTHING durable", async () => {
    const f = await fixture({ gridEnabled: true, tick: 1_500 });
    const state = createLpWorkerState();
    await runLpWorkerOnce({ ...f.deps, dryRun: true }, state);
    // The second observation must be a strictly LATER finalized block, one
    // interval on — two looks at the same block are one look.
    const laterReaders = {
      ...f.deps.readers,
      poolState: async () => ({
        pool: POOL,
        tickSpacing: 50,
        currentTick: 1_500,
        evidence: {
          blockNumber: 101n,
          finalizedBlockNumber: 101n,
          observationCardinality: 500,
          poolLiquidity: 10n ** 24n,
          priceImpactBps: 0n,
          spotSqrtPriceX96: 2n ** 96n,
          twapSqrtPriceX96: 2n ** 96n,
        },
      }),
    };
    const report = await runLpWorkerOnce(
      {
        ...f.deps,
        readers: laterReaders,
        dryRun: true,
        now: () => NOW_SEC * 1000 + INTERVAL_MS,
      },
      state,
    );
    const outcome = report.outcomes[0];
    // The overlay advances within a dry run, so two dry cycles do confirm.
    assert.equal(outcome?.action, "dry-run");
    assert.deepEqual(outcome?.plannedSteps, ["zap-out", "sweep-token", "zap-in-mint"]);
    assert.equal(f.provider.executeCalls.length, 0);
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
    // NO DURABLE OBSERVATION ROW — including the grid hysteresis columns.
    assert.equal(
      await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID),
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The regression pin                                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15: the NON-GRID path is unchanged", () => {
  it("an agent with no grid block still runs the STANDARD evaluator, with unchanged inputs", async () => {
    // The pin the phase owes: a non-grid agent must reach `evaluateLpTriggers`
    // with exactly the inputs it reached before, and must produce the standard
    // vocabulary. `autoRotate` is on and the position is in range, so the
    // standard evaluator's own hold sentence is the assertion.
    const f = await fixture({
      grid: null,
      gridEnabled: true,
      settings: { autoRotate: true, autoHarvest: true },
      live: { tickLower: -500, tickUpper: 500 },
      tick: 0,
    });
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "hold");
    assert.equal(outcome?.decision, "hold");
    // A standard-evaluator sentence, not a grid one.
    assert.doesNotMatch(String(outcome?.reason), /[Gg]rid/u);
    assert.match(
      String(outcome?.reason),
      /Harvest requires both freshly collectible fee legs to be positive|No LP management trigger is ready/u,
    );
    // And the observation it wrote carries NO grid fields — the standard
    // evaluator does not know about them, and a non-grid row must not gain any.
    const observation = await f.observations.get(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.ok(observation !== null);
    assert.equal(observation?.gridCrossConsecutive, undefined);
    assert.equal(observation?.gridCrossSide, undefined);
  });

  it("the flag being ON changes nothing for a non-grid agent", async () => {
    const on = await fixture({ grid: null, gridEnabled: true, live: { tickLower: -500, tickUpper: 500 } });
    const off = await fixture({ grid: null, gridEnabled: false, live: { tickLower: -500, tickUpper: 500 } });
    const a = await runLpWorkerOnce(on.deps, createLpWorkerState());
    const b = await runLpWorkerOnce(off.deps, createLpWorkerState());
    assert.equal(a.outcomes[0]?.action, b.outcomes[0]?.action);
    assert.equal(a.outcomes[0]?.reason, b.outcomes[0]?.reason);
    assert.equal(a.outcomes[0]?.decision, b.outcomes[0]?.decision);
  });
});
