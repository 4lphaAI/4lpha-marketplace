/**
 * PHASE3.20 — THE WORKER'S OWN SEAMS, which are the only ones that prove items
 * 17-19 are WIRED rather than merely written.
 *
 * `evaluatePosition` is reached only through `runLpWorkerOnce`, and the 3.19
 * audit recorded exactly this gap as its residual R1 for the ladder's other
 * seams. The three claims here:
 *
 *  1. THE PER-POSITION QUOTA READ (items 17/OQ4/H3). The evaluator receives the
 *     lane usage it would be refused against, so a spent lane HOLDS at the
 *     trigger — no sequence, no reservation, nothing rolled back. (az) produced
 *     15+ rolled-back `grid-recenter` rows in three minutes; this is the seam
 *     that stops them, and §5(4) is the mutation class.
 *  2. THE LANE EVIDENCE IS PERSISTED AND CHARGED (items 7/10, C6). A dispatched
 *     motion writes `recenterEvidence` on the sequence row in the SAME
 *     transaction that creates it, and the reservation copies it — so the RESUME
 *     path, which never re-evaluates the trigger, charges the lane the motion
 *     started in.
 *  3. THE SPACING HALF (H4) comes from the SAME read, so one `quotaUsage` value
 *     answers both bounds and the hold names which one closed.
 *
 * Fixture pattern is `test/lp.gridLadder.worker.test.ts`'s, for its stated
 * reason: memory stores, a fake chain, and a provider whose call count is what
 * makes "zero money moved" a measured property rather than a claim.
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
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import {
  DEFAULT_LP_SETTINGS,
  type LpAutomationSettings,
  type LpGridSettings,
} from "../src/lp/triggers.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import { createLpWorkerState, runLpWorkerOnce, type LpWorkerDeps } from "../src/lp/worker.js";

const AGENT_ID = "grid-two-sided-worker";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC3");
const BUY_POSITION_ID = "two-sided-buy";
const SELL_POSITION_ID = "two-sided-sell";
const SPENT_POSITION_ID = "two-sided-lane-filler";
const BUY_TOKEN_ID = "7001";
const SELL_TOKEN_ID = "7002";
const FILLER_TOKEN_ID = "7003";
const ARM_GROUP_ID = "0f2c9c11-4a02-4a5f-9b6e-3d5c1f7a8e20";
const INTERVAL_MS = 30_000;
const SPACING = 50;
const GAP = 1_500;
const WIDTH = 200;
const MINUTE = 60_000;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

/** Case B: WBNB sorts into token0, as in the 3.18/3.19 worker suites. */
const DERIVED = gridDeriveRanges({
  currentTick: 0,
  tickSpacing: SPACING,
  gapTicks: GAP,
  widthTicks: WIDTH,
  wbnbIsToken0: true,
  minTick: MIN_TICK,
  maxTick: MAX_TICK,
});

function ladderGrid(
  ladder: Partial<NonNullable<LpGridSettings["ladder"]>> = {},
): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: SPACING,
    buyRange: DERIVED.buyRange,
    sellRange: DERIVED.sellRange,
    maxFlipsPerDay: 1,
    minNetEdgeBps: 0,
    mode: "ladder",
    ladder: {
      gapTicks: GAP,
      widthTicks: WIDTH,
      deployPctBps: 3_000,
      driftPctOfGap: 60,
      // PHASE3.20 D1: ONE settlement a day makes "the last slot" reachable in a
      // two-cycle test, which is what the pre-check is about.
      settlementsPerDay: 1,
      // L3's first live exercise, and the reason it is the fixture default here:
      // with drift OFF the SELL row cannot dispatch a discretionary motion of
      // its own, so every submission this file counts belongs to the rung under
      // test.
      driftMovesPerDay: 0,
      hedge: { enabled: true, minMarkoutBps: 30, maxHedgePctBps: 5_000 },
      ...ladder,
    },
  };
}

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
  blockNumber: bigint;
  positions: Map<string, LpPositionSnapshot | "burned">;
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
        blockNumber: chain.blockNumber,
        finalizedBlockNumber: chain.blockNumber,
        observationCardinality: 500,
        poolLiquidity: 10n ** 24n,
        priceImpactBps: 0n,
        spotSqrtPriceX96: getSqrtRatioAtTick(chain.tick),
        twapSqrtPriceX96: getSqrtRatioAtTick(chain.tick),
      },
    }),
    positions: async (tokenId) => chain.positions.get(tokenId.toString(10)) ?? "burned",
    positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
    ownerOf: async () => ownerAccount.address,
    quote: async (params) => params.amountInWei,
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
  readonly clock: { ms: number };
};

async function fixture(
  options: { readonly grid?: LpGridSettings } = {},
): Promise<Fixture> {
  const clock = { ms: NOW_SEC * 1_000 };
  const now = (): number => clock.ms;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new MemoryLpSequenceStore(now);
  const settingsStore = new MemoryLpSettingsStore(now);
  const observations = new MemoryLpObservationStore();
  const provider = new FakeWalletProvider();
  const chain: Chain = {
    // The BUY rung has FILLED: the tick sits strictly beyond its far edge, so
    // the range now charges the base asset the role does not hold.
    tick: DERIVED.buyRange.tickUpper + 500,
    blockNumber: 100n,
    positions: new Map([
      [BUY_TOKEN_ID, { liquidity: 1_000n, ...DERIVED.buyRange }],
      [SELL_TOKEN_ID, { liquidity: 1_000n, ...DERIVED.sellRange }],
      [FILLER_TOKEN_ID, { liquidity: 1_000n, ...DERIVED.sellRange }],
    ]),
    balances: new Map<Address, bigint>([
      [WBNB, 10n ** 18n],
      [TOKEN, 10n ** 18n],
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

  const base = {
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted" as const,
    gridLevel: 1 as const,
    armGroupId: ARM_GROUP_ID,
  };
  await store.createPosition({
    ...base,
    positionId: BUY_POSITION_ID,
    tokenId: BUY_TOKEN_ID,
    gridRole: "buy",
    inventoryAnchor: true,
  });
  await store.createPosition({
    ...base,
    positionId: SELL_POSITION_ID,
    tokenId: SELL_TOKEN_ID,
    gridRole: "sell",
  });

  const grid = options.grid ?? ladderGrid();
  const settings: LpAutomationSettings = {
    ...DEFAULT_LP_SETTINGS,
    minMinutesBetweenExits: 5,
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
    clock,
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
      gridEnabled: true,
      reconcile: async () => {},
      now,
      intervalMs: INTERVAL_MS,
      dryRun: false,
    },
  };
}

/**
 * Consume ONE settlement slot with a row that is TERMINAL, so the worker's own
 * resume path never touches it and the only thing it contributes is the
 * reservation the pre-check reads.
 */
async function spendSettlementSlot(f: Fixture): Promise<void> {
  await f.store.createPosition({
    positionId: SPENT_POSITION_ID,
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    tokenId: FILLER_TOKEN_ID,
    basisWei: 0n,
    basisSource: "minted",
  });
  const created = await f.store.createSequence({
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    positionId: SPENT_POSITION_ID,
    kind: "grid-recenter",
    recenterEvidence: "settlement",
  });
  await f.store.reserveSequence(
    ownerAccount.address,
    AGENT_ID,
    created.sequenceId,
    {
      maxExitSequencesPerDay: 4,
      minMinutesBetweenExits: 5,
      maxSettlementsPerDay: 1,
      maxDriftMovesPerDay: 1,
    },
  );
  await f.store.setSequenceState(
    ownerAccount.address,
    AGENT_ID,
    created.sequenceId,
    "completed",
  );
  await f.store.setPositionState(
    ownerAccount.address,
    AGENT_ID,
    SPENT_POSITION_ID,
    "closed",
  );
}

/** Two cycles one interval and one block apart: what a confirmation needs. */
async function twoCycles(f: Fixture): Promise<
  Awaited<ReturnType<typeof runLpWorkerOnce>>
> {
  const state = createLpWorkerState();
  await runLpWorkerOnce(f.deps, state);
  f.clock.ms += INTERVAL_MS;
  f.chain.blockNumber += 1n;
  return runLpWorkerOnce(f.deps, state);
}

function outcomeFor(
  result: Awaited<ReturnType<typeof runLpWorkerOnce>>,
  positionId: string,
): Record<string, unknown> {
  const found = result.outcomes.find(
    (outcome) => (outcome as { positionId?: string }).positionId === positionId,
  );
  assert.ok(found, `no outcome for ${positionId}`);
  return found as unknown as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* items 17-19 / §5(4) — the pre-check is WIRED, and it does not churn        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 items 17-19: the trigger reads the lane usage PER POSITION", () => {
  it("with the lane OPEN the filled rung dispatches, and its lane is persisted", async () => {
    const f = await fixture();
    const result = await twoCycles(f);
    const outcome = outcomeFor(result, BUY_POSITION_ID);
    assert.equal(outcome["decision"], "grid-recenter");
    // Item 7 / C6 — the evidence is on the ROW, written by the create, and the
    // reservation copied it. This is what makes a RESUME (the DEFAULT path on
    // this relay, FINDINGS (aw)) charge the lane the motion started in rather
    // than re-derive it from a trigger evaluation that does not run.
    const sequence = await f.store.getNonTerminalSequence(
      ownerAccount.address,
      AGENT_ID,
      BUY_POSITION_ID,
    );
    assert.ok(sequence);
    assert.equal(sequence!.kind, "grid-recenter");
    assert.equal(sequence!.recenterEvidence, "settlement");
    const reservation = await f.store.getReservation(
      ownerAccount.address,
      AGENT_ID,
      sequence!.sequenceId,
    );
    assert.equal(reservation?.quotaLane, "settlement");
    assert.equal(reservation?.quotaBound, true);
  });

  it("§5(4): a SPENT settlement lane HOLDS at the trigger — no row, no reservation, no churn", async () => {
    const f = await fixture();
    await spendSettlementSlot(f);
    // Past the spacing gate, so the LANE is unambiguously what refuses.
    f.clock.ms += 10 * MINUTE;
    const before = await f.store.quotaUsage(ownerAccount.address, AGENT_ID);
    const result = await twoCycles(f);
    const outcome = outcomeFor(result, BUY_POSITION_ID);
    assert.equal(outcome["action"], "hold");
    assert.match(String(outcome["reason"]), /settlement lane is spent/u);
    assert.match(String(outcome["reason"]), /NO sequence, NO reservation/u);
    // THE MUTATION THIS KILLS: reinstating the reserve-then-roll-back path.
    // (az) wrote 15+ rolled-back `grid-recenter` rows in three minutes, which is
    // bookkeeping noise that can mask a real event — and D5's view fields are
    // the replacement audit trail precisely because these rows are gone.
    const sequence = await f.store.getNonTerminalSequence(
      ownerAccount.address,
      AGENT_ID,
      BUY_POSITION_ID,
    );
    assert.equal(sequence, null, "no sequence row may be created by a refused motion");
    const after = await f.store.quotaUsage(ownerAccount.address, AGENT_ID);
    assert.equal(
      after.settlementLiveCount,
      before.settlementLiveCount,
      "and no reservation may be taken",
    );
    assert.equal(f.provider.executeCalls.length, 0, "and nothing may be submitted");
  });

  it("H4: the SPACING half comes from the SAME read and names itself", async () => {
    const f = await fixture(
      // A settlement lane with room, so the only thing left to refuse is the
      // agent-wide pacing floor the seeded reservation just anchored.
      { grid: ladderGrid({ settlementsPerDay: 4 }) },
    );
    await spendSettlementSlot(f);
    const result = await twoCycles(f);
    const outcome = outcomeFor(result, BUY_POSITION_ID);
    assert.equal(outcome["action"], "hold");
    assert.match(String(outcome["reason"]), /minMinutesBetweenExits/u);
    assert.match(String(outcome["reason"]), /AGENT-WIDE/u);
    assert.equal(f.provider.executeCalls.length, 0);
  });
});
