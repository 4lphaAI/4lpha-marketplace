/**
 * PHASE3.18 — the worker's requote seams: the dispatch map, the three-lane
 * quota wiring, the C11 per-token cap PRE-REFUSAL, and the flag-off skip that
 * must cover the fourth grid kind.
 *
 * The fixture pattern is `test/lp.gridWorker.test.ts`'s — memory stores, a fake
 * chain, and a provider that is asserted NEVER to be called on any path this
 * file exercises, which is what makes "zero-money" a measured property rather
 * than a claim.
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
import { gridDeriveRanges } from "../src/lp/gridGeometry.js";
import { MAX_TICK, MIN_TICK } from "../src/lp/tickMath.js";
import {
  DEFAULT_LP_SETTINGS,
  type LpAutomationSettings,
  type LpGridSettings,
  type LpTriggerObservation,
} from "../src/lp/triggers.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  GRID_SEQUENCE_KINDS,
  LP_GRID_DISABLED_REASON,
  LP_SAGA_PLANS,
  createLpWorkerState,
  lpDispatchKindFor,
  runLpWorkerOnce,
  type LpWorkerDeps,
} from "../src/lp/worker.js";

const AGENT_ID = "grid-requote-worker";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const POSITION_ID = "grid-requote-position";
const TOKEN_ID = "777";
const INTERVAL_MS = 30_000;
const SPACING = 50;
const GAP = 1_500;
const WIDTH = 200;
const ANCHOR = 0;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

/** Case B: WBNB sorts into token0, so the quote-holding BUY rung sits ABOVE. */
const DERIVED = gridDeriveRanges({
  currentTick: ANCHOR,
  tickSpacing: SPACING,
  gapTicks: GAP,
  widthTicks: WIDTH,
  wbnbIsToken0: true,
  minTick: MIN_TICK,
  maxTick: MAX_TICK,
});

const POLICY_GRID: LpGridSettings = {
  pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
  wbnbIsToken0: true,
  tickSpacing: SPACING,
  buyRange: DERIVED.buyRange,
  sellRange: DERIVED.sellRange,
  maxFlipsPerDay: 12,
  minNetEdgeBps: 0,
  mode: "policy",
  policy: { gapTicks: GAP, widthTicks: WIDTH },
  requote: { driftPctOfGap: 60, maxRequotesPerDay: 12 },
};

function lpSessionSpec(expiresAt: number, wbnbCap: bigint): SessionSpec {
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "approve(address,uint256)" },
    ],
    spendCaps: [
      { limit: 10n ** 18n, period: "day" },
      { limit: 2n ** 160n, period: "day", token: TOKEN },
      { limit: wbnbCap, period: "day", token: WBNB },
    ],
    expiresAt,
  };
}

function lpSessionFacts(expiresAt: number, wbnbCap: bigint): SessionFacts {
  return {
    spec: lpSessionSpec(expiresAt, wbnbCap),
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
      tickSpacing: SPACING,
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
    readonly live?: { tickLower: number; tickUpper: number };
    readonly tick?: number;
    readonly wbnbCap?: bigint;
    readonly identity?: { gridLevel: 1 | 2; gridRole: "buy" | "sell" } | null;
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
  const live = options.live ?? DERIVED.buyRange;
  const chain: Chain = {
    tick: options.tick ?? ANCHOR,
    positions: new Map([[TOKEN_ID, { liquidity: 1_000n, ...live }]]),
    nftOwner: ownerAccount.address,
  };

  await agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600, options.wbnbCap ?? 2n ** 160n),
    status: "armed",
  });
  await agentStore.putAgentSessionKey(ownerAccount.address, AGENT_ID, SESSION_KEY);
  const identity =
    options.identity === undefined
      ? { gridLevel: 1 as const, gridRole: "buy" as const }
      : options.identity;
  await store.createPosition({
    positionId: POSITION_ID,
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    tokenId: TOKEN_ID,
    basisWei: 0n,
    basisSource: "minted",
    ...(identity ?? {}),
  });

  const grid = options.grid === undefined ? POLICY_GRID : options.grid;
  const settings: LpAutomationSettings = { ...DEFAULT_LP_SETTINGS, grid };
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

/** Two comparable cycles, which is what a drift confirmation costs. */
async function twoCycles(
  f: Fixture,
): Promise<ReturnType<typeof runLpWorkerOnce> extends Promise<infer T> ? T : never> {
  const state = createLpWorkerState();
  await runLpWorkerOnce(f.deps, state);
  // The second cycle must be at least one interval later and a later BLOCK, or
  // the previous observation is not comparable and no count can build.
  const later: LpWorkerDeps = {
    ...f.deps,
    now: () => NOW_SEC * 1000 + INTERVAL_MS * 4,
    readers: {
      ...f.deps.readers,
      poolState: async () => {
        const base = await fakeReaders(f.chain).poolState(POOL);
        return {
          ...base,
          evidence: { ...base.evidence, blockNumber: 101n, finalizedBlockNumber: 101n },
        };
      },
    } as LpWorkerChainReaders,
  };
  return runLpWorkerOnce(later, state);
}

/* -------------------------------------------------------------------------- */
/* The dispatch map and the flag                                              */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18: the fourth grid kind joins every place that enumerates them", () => {
  it("the decision maps to its OWN saga kind, never to protect", () => {
    // The exhaustive switch is what made this member a COMPILE ERROR until its
    // arm existed. Under the pre-3.15 ternary it would have dispatched
    // `runLpProtect` — a full exit — on the first re-centre.
    assert.equal(lpDispatchKindFor("grid-requote"), "grid-requote");
  });

  it("its plan is the FLIP's three positions, so the crash matrix carries over", () => {
    assert.deepEqual(LP_SAGA_PLANS["grid-requote"], [
      "zap-out",
      "sweep-token",
      "zap-in-mint",
    ]);
    assert.deepEqual(LP_SAGA_PLANS["grid-requote"], LP_SAGA_PLANS["grid-flip"]);
  });

  it("GRID_SEQUENCE_KINDS covers it, so the flag-off resume skip does too", () => {
    // The 3.16 H4 lesson: a hardcoded kind at the resume skip is how this class
    // of bug gets in. Membership is the predicate; every future grid kind joins
    // the set in ONE place.
    assert.equal(GRID_SEQUENCE_KINDS.has("grid-requote"), true);
    assert.equal(GRID_SEQUENCE_KINDS.has("grid-flip"), true);
    assert.equal(GRID_SEQUENCE_KINDS.has("grid-arm"), true);
  });

  it("a policy grid under an OFF flag is SKIPPED, never standard-managed", async () => {
    const f = await fixture({ gridEnabled: false });
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.equal(report.outcomes[0]?.reason, LP_GRID_DISABLED_REASON);
    assert.equal(f.provider.executeCalls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The end-to-end trigger, through the worker                                 */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18: the worker confirms a drift over two cycles and dispatches", () => {
  it("one cycle HOLDS; two consecutive comparable cycles dispatch grid-requote", async () => {
    // The price has run DOWN away from a BUY rung sitting above it.
    const f = await fixture({ gridEnabled: true, tick: ANCHOR - 5 * GAP });
    const first = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(first.outcomes[0]?.action, "hold");
    assert.match(String(first.outcomes[0]?.reason), /awaiting a second finalized evaluation/u);

    const second = await twoCycles(await fixture({ gridEnabled: true, tick: ANCHOR - 5 * GAP }));
    assert.equal(second.outcomes[0]?.decision, "grid-requote");
    assert.equal(second.outcomes[0]?.kind, "grid-requote");
  });

  it("a FIXED grid at the same drift never dispatches one", async () => {
    const { mode: _m, policy: _p, requote: _r, ...fixed } = POLICY_GRID;
    const f = await fixture({
      gridEnabled: true,
      grid: fixed,
      tick: ANCHOR - 5 * GAP,
    });
    const report = await twoCycles(f);
    assert.notEqual(report.outcomes[0]?.decision, "grid-requote");
    assert.equal(f.provider.executeCalls.length, 0);
  });

  it("C12(b): NULL identity columns in policy mode HOLD, naming the remedy", async () => {
    const f = await fixture({
      gridEnabled: true,
      tick: ANCHOR - 5 * GAP,
      identity: null,
    });
    const report = await twoCycles(f);
    assert.equal(report.outcomes[0]?.action, "hold");
    assert.match(String(report.outcomes[0]?.reason), /carries no grid_level\/grid_role/u);
    assert.equal(f.provider.executeCalls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* C11 — the per-token cap PRE-REFUSAL                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.10/C11: an unaffordable re-centre never starts", () => {
  it("an undersized WBNB cap refuses BEFORE any sequence exists", async () => {
    const f = await fixture({
      gridEnabled: true,
      tick: ANCHOR - 5 * GAP,
      // A cap far under the level's own quote leg: the mint's approve would
      // revert the batch at the relay as an opaque failure.
      wbnbCap: 1n,
    });
    const report = await twoCycles(f);
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.match(String(report.outcomes[0]?.reason), /refused before it started/u);
    assert.match(String(report.outcomes[0]?.reason), /add-spend-limit/u);
    assert.match(
      String(report.outcomes[0]?.reason),
      /\(1 \+ maxRequotesPerDay\) times per cycle/u,
    );

    // ZERO MONEY, classified like G0 (C11): no submission, no sequence row, no
    // reservation — and the price stop is still armed because nothing is held.
    assert.equal(f.provider.executeCalls.length, 0);
    const sequences = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences.length, 0);
    const blocking = await f.store.getAnyNonTerminalSequence(ownerAccount.address, AGENT_ID);
    assert.equal(blocking, null);
  });

  it("an ABSENT cap for the charged token refuses the same way", async () => {
    const f = await fixture({ gridEnabled: true, tick: ANCHOR - 5 * GAP, wbnbCap: 0n });
    const report = await twoCycles(f);
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.match(String(report.outcomes[0]?.reason), /refused before it started/u);
  });

  it("the observation is STILL persisted, so the count is not lost to a refusal", async () => {
    const f = await fixture({ gridEnabled: true, tick: ANCHOR - 5 * GAP, wbnbCap: 1n });
    await twoCycles(f);
    const observation = await f.observations.get(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    const stored = observation as LpTriggerObservation | null;
    assert.notEqual(stored, null);
    assert.equal((stored?.gridDriftConsecutive ?? 0) >= 2, true);
  });
});
