/**
 * PHASE3.19 — the WORKER's ladder seams, which the phase's own audit recorded
 * as residual R1: `buildGridRecenterDeps` is reached only through
 * `runLpWorkerOnce`, and until this file existed its three load-bearing claims
 * rested on the compiler and on the saga suite's hand-built deps.
 *
 * The three claims, each a `describe` below:
 *
 *  1. THE ANCHOR RESOLUTION (C4 / N4). One book per ladder, carried by the
 *     arm group's anchor row. A motion on the SIBLING must find the anchor
 *     through `arm_group_id`; a ladder row with neither its own book nor a
 *     locatable anchor must THROW rather than open a second book over one
 *     pooled buffer.
 *  2. THE DEPS-SEAM TARGET GUARD (C4, the 3.18 M-B3 class). The resume passes
 *     NO target, so the persisted one is the only source; a cycle that hands a
 *     DISAGREEING recomputation is refused, not obeyed; and a row with neither
 *     is refused rather than re-derived at a fresh tick.
 *  3. THE FLAG-OFF RESUME SKIP. `grid-recenter` is in `GRID_SEQUENCE_KINDS`,
 *     so a held ladder motion under `GRID_ENABLED=false` is SKIPPED — never
 *     resumed, and never standard-managed by the protect evaluator.
 *
 * Fixture pattern is `test/lp.gridRequote.worker.test.ts`'s, for the same
 * reason: memory stores, a fake chain, and a provider asserted never to be
 * called, which is what makes "zero money moved" a measured property here.
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
} from "../src/lp/triggers.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  GRID_SEQUENCE_KINDS,
  LP_SAGA_PLANS,
  createLpWorkerState,
  lpDispatchKindFor,
  runLpWorkerOnce,
  type LpWorkerDeps,
} from "../src/lp/worker.js";

const AGENT_ID = "grid-ladder-worker";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC2");
const ANCHOR_POSITION_ID = "ladder-anchor-position";
const SIBLING_POSITION_ID = "ladder-sibling-position";
const ANCHOR_TOKEN_ID = "9101";
const SIBLING_TOKEN_ID = "9102";
const ARM_GROUP_ID = "6a0d6d5a-1f4d-4d6c-8a3a-9f1e0b7c2d40";
const INTERVAL_MS = 30_000;
const SPACING = 50;
const GAP = 1_500;
const WIDTH = 200;
const TICK_ANCHOR = 0;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

/** Case B, as in the 3.18 worker suite: WBNB sorts into token0. */
const DERIVED = gridDeriveRanges({
  currentTick: TICK_ANCHOR,
  tickSpacing: SPACING,
  gapTicks: GAP,
  widthTicks: WIDTH,
  wbnbIsToken0: true,
  minTick: MIN_TICK,
  maxTick: MAX_TICK,
});

const LADDER_GRID: LpGridSettings = {
  pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
  wbnbIsToken0: true,
  tickSpacing: SPACING,
  buyRange: DERIVED.buyRange,
  sellRange: DERIVED.sellRange,
  // A ladder pins `maxFlipsPerDay` to 1 (work-order item 22) — the flip lane is
  // unreachable for it, and the three-way reachability rule counts this slot.
  maxFlipsPerDay: 1,
  minNetEdgeBps: 0,
  mode: "ladder",
  ladder: {
    gapTicks: GAP,
    widthTicks: WIDTH,
    deployPctBps: 3_000,
    driftPctOfGap: 60,
    maxMovesPerDay: 4,
    hedge: { enabled: true, minMarkoutBps: 30, maxHedgePctBps: 5_000 },
  },
};

function lpSessionSpec(expiresAt: number): SessionSpec {
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "deposit()" },
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
  balances: Map<Address, bigint>;
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
    // PHASE3.19 B2: the ONE new reader, optional on the type. Every assertion
    // in this file that reaches the funding conjunct needs it present.
    walletTokenBalance: async (token: Address) => chain.balances.get(token) ?? 0n,
    receipts: {
      collectAmounts: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      swapAmounts: async () => {
        throw new Error("unused");
      },
      mintedTokenId: async () => 888n,
    },
    onChainNativeDailyCapWei: async () => 10n ** 18n,
  } as LpWorkerChainReaders;
}

type Fixture = {
  readonly deps: LpWorkerDeps;
  readonly chain: Chain;
  readonly provider: FakeWalletProvider;
  readonly store: MemoryLpSequenceStore;
};

/**
 * A two-row ladder: the BUY row is the arm group's book ANCHOR (its inventory
 * columns are non-null from creation), the SELL row is the sibling whose
 * columns stay NULL for ever — the exact shape `POST /lp/grid/arm` writes.
 */
async function fixture(
  options: {
    readonly grid?: LpGridSettings | null;
    readonly gridEnabled?: boolean;
    readonly anchored?: boolean;
    readonly armGroup?: string | null;
    readonly tick?: number;
    readonly live?: { tickLower: number; tickUpper: number };
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
    tick: options.tick ?? TICK_ANCHOR,
    positions: new Map([
      [ANCHOR_TOKEN_ID, { liquidity: 1_000n, ...live }],
      [SIBLING_TOKEN_ID, { liquidity: 1_000n, ...DERIVED.sellRange }],
    ]),
    nftOwner: ownerAccount.address,
    balances: new Map<Address, bigint>([
      [WBNB, 10n ** 17n],
      [TOKEN, 10n ** 17n],
    ]),
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

  const armGroupId = options.armGroup === undefined ? ARM_GROUP_ID : options.armGroup;
  const base = {
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted" as const,
    // R3.1/C2: BOTH ladder rows carry `gridLevel: 1`, split by `gridRole`.
    gridLevel: 1 as const,
    ...(armGroupId === null ? {} : { armGroupId }),
  };
  await store.createPosition({
    ...base,
    positionId: ANCHOR_POSITION_ID,
    tokenId: ANCHOR_TOKEN_ID,
    gridRole: "buy",
    ...(options.anchored === false ? {} : { inventoryAnchor: true }),
  });
  await store.createPosition({
    ...base,
    positionId: SIBLING_POSITION_ID,
    tokenId: SIBLING_TOKEN_ID,
    gridRole: "sell",
  });

  const grid = options.grid === undefined ? LADDER_GRID : options.grid;
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

/**
 * Park a NON-TERMINAL `grid-recenter` row on one of the two positions, with or
 * without a persisted target. `state: "held"` is what the resume path claims.
 */
async function parkRecenter(
  f: Fixture,
  positionId: string,
  target: { tickLower: number; tickUpper: number } | null,
): Promise<string> {
  const created = await f.store.createSequence({
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    positionId,
    kind: "grid-recenter",
    ...(target === null ? {} : { targetRange: target }),
  });
  // A recovery marker is what makes the row RESUMABLE — the same shape
  //  parks a flip with, and the 3.11 F2 pin.
  await f.store.setRecoveryState(
    ownerAccount.address,
    AGENT_ID,
    created.sequenceId,
    "pending-mint",
  );
  return created.sequenceId;
}

/* -------------------------------------------------------------------------- */
/* 0. Registration — the compile-time half, asserted at runtime too            */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19: the fifth grid kind joins every enumeration the worker owns", () => {
  it("the ladder decision maps to its OWN saga kind, never to protect", () => {
    assert.equal(lpDispatchKindFor("grid-recenter"), "grid-recenter");
  });

  it("its plan is the three-step shape the crash matrix is written against", () => {
    assert.deepEqual(LP_SAGA_PLANS["grid-recenter"], [
      "zap-out",
      "sweep-token",
      "zap-in-mint",
    ]);
  });

  it("GRID_SEQUENCE_KINDS covers it, so the flag-off resume skip reaches it", () => {
    assert.equal(GRID_SEQUENCE_KINDS.has("grid-recenter"), true);
  });
});

/* -------------------------------------------------------------------------- */
/* 1. The flag-off resume skip (audit R1, third claim)                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19: a held ladder motion under an OFF flag is SKIPPED", () => {
  it("never resumes, never standard-manages, and moves no money", async () => {
    const f = await fixture({ gridEnabled: false });
    await parkRecenter(f, ANCHOR_POSITION_ID, DERIVED.sellRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.filter((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.action, "skipped");
    // The decisive half: the protect evaluator must NOT have picked the row up
    // as an ordinary LP position once the grid path declined it.
    assert.notEqual(mine[0]?.kind, "protect");
    assert.equal(f.provider.executeCalls.length, 0);
  });

  it("with the flag ON the same row is RESUMED, not skipped", async () => {
    const f = await fixture({ gridEnabled: true });
    await parkRecenter(f, ANCHOR_POSITION_ID, DERIVED.sellRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.filter((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.equal(mine.length, 1);
    assert.notEqual(mine[0]?.action, "skipped");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The deps-seam target guard (audit R1, second claim)                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 C4: the persisted target is the resume's only source", () => {
  it("a resume with a persisted target does NOT refuse for want of one", async () => {
    const f = await fixture({ gridEnabled: true });
    await parkRecenter(f, ANCHOR_POSITION_ID, DERIVED.sellRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.notEqual(mine, undefined);
    // Whatever the saga then decides, the DEPS BUILDER did not throw about a
    // missing target — that is the seam this file exists to cover.
    assert.equal(
      /carries no persisted target range/.test(mine?.reason ?? ""),
      false,
      mine?.reason ?? "(no reason)",
    );
  });

  it("a NON-TERMINAL recenter row with NO persisted target is refused, never re-derived", async () => {
    const f = await fixture({ gridEnabled: true });
    await parkRecenter(f, ANCHOR_POSITION_ID, null);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.match(
      mine?.reason ?? "",
      /carries no persisted target range and none was supplied/,
    );
    // The refusal is the POINT: re-deriving at a fresh tick would mint a rung
    // the owner's evidence never authorized.
    assert.match(mine?.reason ?? "", /will NOT be re-derived at a fresh tick/);
    assert.equal(f.provider.executeCalls.length, 0);
  });

  it("the refusal names the owner-signed exit rather than stranding the row", async () => {
    const f = await fixture({ gridEnabled: true });
    await parkRecenter(f, ANCHOR_POSITION_ID, null);
    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.match(mine?.reason ?? "", /abandon/i);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The anchor resolution (audit R1, first claim — C4 / N4)                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 C4/N4: ONE book per ladder, located through the arm group", () => {
  it("a motion on the SIBLING resolves the anchor and does not open a second book", async () => {
    const f = await fixture({ gridEnabled: true });
    await parkRecenter(f, SIBLING_POSITION_ID, DERIVED.buyRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === SIBLING_POSITION_ID);
    assert.notEqual(mine, undefined);
    // Neither anchor-resolution throw fired.
    assert.equal(
      /cannot be located|no row of this ladder/i.test(mine?.reason ?? ""),
      false,
      mine?.reason ?? "(no reason)",
    );
    // And the sibling's own columns stayed NULL — the book is the anchor's.
    const sibling = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      SIBLING_POSITION_ID,
    );
    assert.equal(sibling?.inventoryBaseWei, null);
    assert.equal(sibling?.inventoryCostWbnbWei, null);
  });

  it("a bookless row in NO arm group REFUSES rather than opening a second book", async () => {
    // The N4 shape: no own book, no group to find one in.
    const f = await fixture({ gridEnabled: true, anchored: false, armGroup: null });
    await parkRecenter(f, ANCHOR_POSITION_ID, DERIVED.sellRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.match(mine?.reason ?? "", /belongs to no arm group/);
    assert.match(mine?.reason ?? "", /rather than opening a second one/);
    assert.equal(f.provider.executeCalls.length, 0);
  });

  it("a group whose every member is bookless REFUSES, naming the markout gate", async () => {
    // Both rows exist and share a group, but NO member carries the book.
    const f = await fixture({ gridEnabled: true, anchored: false });
    await parkRecenter(f, ANCHOR_POSITION_ID, DERIVED.sellRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.match(mine?.reason ?? "", /No row of this ladder's arm group/);
    assert.match(mine?.reason ?? "", /markout gate has no average to read/);
    assert.equal(f.provider.executeCalls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Mode policing at the same seam                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19: the deps builder polices the MODE it was dispatched under", () => {
  it("a recenter row under a FIXED grid is refused, never run", async () => {
    const fixedGrid: LpGridSettings = {
      pool: LADDER_GRID.pool,
      wbnbIsToken0: true,
      tickSpacing: SPACING,
      buyRange: DERIVED.buyRange,
      sellRange: DERIVED.sellRange,
      maxFlipsPerDay: 12,
      minNetEdgeBps: 0,
    };
    const f = await fixture({ gridEnabled: true, grid: fixedGrid });
    await parkRecenter(f, ANCHOR_POSITION_ID, DERIVED.sellRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.match(mine?.reason ?? "", /grid\.mode is not "ladder"/);
    assert.equal(f.provider.executeCalls.length, 0);
  });

  it("a recenter row on an agent with NO grid block is refused for want of geometry", async () => {
    const f = await fixture({ gridEnabled: true, grid: null });
    await parkRecenter(f, ANCHOR_POSITION_ID, DERIVED.sellRange);

    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const mine = outcomes.find((o) => o.positionId === ANCHOR_POSITION_ID);
    assert.match(mine?.reason ?? "", /no grid block/);
    assert.equal(f.provider.executeCalls.length, 0);
  });
});
