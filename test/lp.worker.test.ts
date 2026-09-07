/**
 * The LP worker cycle truth table (PHASE3 "Worker"), over fakes:
 *
 *   - no positions â‡’ no-op, zero provider calls;
 *   - a non-terminal sequence is RESUMED before any new trigger work, and no
 *     second sequence appears for the position;
 *   - Rev2 item 16: a PAUSED agent still gets its protect dispatched
 *     (FINDINGS (s) carve-out) while a rotate gets no new work; a global HALT
 *     blocks the protect too;
 *   - one saga per position per cycle with protect and rotate BOTH eligible â€”
 *     and zero brain-transport calls on that cycle (Rev2 item 28);
 *   - dry-run logs the decision (trigger reason + would-be steps) and makes
 *     ZERO WalletProvider calls, creates no sequences, journals nothing, and
 *     skips reconcile;
 *   - a stored settings digest that does not recompute skips the position
 *     with a logged reason;
 *   - `resolveLpWorkerBootConfig` refuses to start without LP_ENABLED or
 *     without the rails, and clamps the interval into [30s, 10min];
 *   - the two worker-queue store methods answer identically on the memory and
 *     Postgres implementations.
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
import { FakeSqlClient } from "./support/fakeSql.js";
import { MemoryAgentStore, type SessionFacts } from "../src/store/agents.js";
import { DRAFT_KEY, cancelDraft, pendingDraft } from "./support/provisioningDraft.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import {
  MemoryLpObservationStore,
  type LpObservationStore,
} from "../src/store/lpObservations.js";
import type { SessionSpec } from "../src/core/types.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import type { LpWorkerChainReaders } from "../src/lp/readers.js";
import {
  DEFAULT_LP_SETTINGS,
  lpMaxObservationAgeMs,
  LP_NO_TOKEN_ID_REASON,
  LP_NOT_OWNED_REASON,
  LP_STALE_OBSERVATION_HOLD_REASON,
  type LpAutomationSettings,
} from "../src/lp/triggers.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  LP_STALL_BACKOFF_INTERVALS,
  LP_STALL_LATCH_ATTEMPTS,
  LP_WORKER_MAX_INTERVAL_MS,
  LP_WORKER_MIN_INTERVAL_MS,
  clampLpWorkerIntervalMs,
  createLpWorkerState,
  nextCycleDelayMs,
  resolveLpWorkerBootConfig,
  runLpWorkerOnce,
  sleepUntilNextCycle,
  type LpWorkerDeps,
  type LpWorkerState,
} from "../src/lp/worker.js";

const AGENT_ID = "lp-agent";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const POSITION_ID = "position-1";
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

/** LP session facts: BOTH legs carry the approve rule AND the cap. */
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

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** `LpPoolStateReading`, with the readonly stripped so tests can bump it. */
type MutablePoolState = {
  pool: Address;
  tickSpacing: number;
  currentTick: number;
  evidence: {
    blockNumber: bigint;
    finalizedBlockNumber: bigint;
    observationCardinality: number;
    poolLiquidity: bigint;
    priceImpactBps: bigint;
    spotSqrtPriceX96: bigint;
    twapSqrtPriceX96: bigint;
  };
};

type Chain = {
  /** Mutable market: the tests bump block/tick between cycles. */
  state: MutablePoolState;
  positions: Map<string, LpPositionSnapshot | "burned">;
  fees: { amount0Wei: bigint; amount1Wei: bigint };
  /**
   * What NFPM `ownerOf` answers (PHASE3.4). Defaults to the agent's wallet;
   * a test that moves the NFT sets it to prove the worker suspends automation
   * rather than resuming a saga onto a position someone else now owns.
   */
  nftOwner: Address | "burned";
};

function healthyState(): MutablePoolState {
  return {
    pool: POOL,
    tickSpacing: 50,
    currentTick: 0,
    evidence: {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 24n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: 2n ** 96n, // price 1
      twapSqrtPriceX96: 2n ** 96n,
    },
  };
}

function fakeReaders(chain: Chain): LpWorkerChainReaders {
  return {
    getPool: async () => POOL,
    poolState: async () => ({
      ...chain.state,
      evidence: { ...chain.state.evidence },
    }),
    positions: async (tokenId) => chain.positions.get(tokenId.toString(10)) ?? "burned",
    positionFees: async () => ({ ...chain.fees }),
    ownerOf: async () => chain.nftOwner,
    quote: async (params) => params.amountInWei, // 1:1, matching spot
    receipts: {
      collectAmounts: async () => ({ amount0Wei: 10n, amount1Wei: 10n }),
      swapAmounts: async () => {
        throw new Error("unused in these tests");
      },
      mintedTokenId: async () => 888n,
    },
    onChainNativeDailyCapWei: async () => 10n ** 18n,
  };
}

type Fixture = {
  readonly deps: LpWorkerDeps;
  readonly state: LpWorkerState;
  readonly chain: Chain;
  readonly provider: FakeWalletProvider;
  readonly agentStore: MemoryAgentStore;
  readonly journal: MemoryExecutionJournal;
  readonly killswitch: MemoryKillSwitch;
  readonly store: LpSequenceStore;
  readonly settingsStore: MemoryLpSettingsStore;
  /** PHASE3.2: the DURABLE observation store; survives a fresh state/deps. */
  readonly observations: MemoryLpObservationStore;
  readonly brainCalls: { kind: string; context: Record<string, unknown> }[];
  readonly reconcileCalls: { count: number };
  advance(ms: number): void;
  /** One trigger-comparable step: next finalized block, one interval later. */
  nextCycleWindow(): void;
  dryRun(on: boolean): LpWorkerDeps;
};

async function fixture(
  options: {
    readonly settings?: Partial<LpAutomationSettings>;
    readonly seedPosition?: boolean;
    readonly basisWei?: bigint;
    /**
     * PHASE3.2: share ONE durable observation store across two fixtures to
     * simulate two worker PROCESSES over one database.
     */
    readonly observations?: MemoryLpObservationStore;
    /** Start the injected clock somewhere other than NOW_SEC (a "later run"). */
    readonly startMs?: number;
    /** Lets the worker exercise the same cycle against the SQL store seam. */
    readonly store?: LpSequenceStore;
    readonly brainReply?: unknown;
    readonly brainError?: Error;
  } = {},
): Promise<Fixture> {
  let nowMs = options.startMs ?? NOW_SEC * 1000;
  const now = (): number => nowMs;

  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = options.store ?? new MemoryLpSequenceStore(now);
  const settingsStore = new MemoryLpSettingsStore(now);
  const observations = options.observations ?? new MemoryLpObservationStore();
  const provider = new FakeWalletProvider();
  const chain: Chain = {
    state: healthyState(),
    positions: new Map([
      [TOKEN_ID, { liquidity: 1_000n, tickLower: -500, tickUpper: 500 }],
    ]),
    fees: { amount0Wei: 0n, amount1Wei: 0n },
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

  if (options.seedPosition !== false) {
    await store.createPosition({
      positionId: POSITION_ID,
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB, // 0x2222â€¦ < 0x5555â€¦, pool order holds
      token1: TOKEN,
      fee: 2500,
      tokenId: TOKEN_ID,
      basisWei: options.basisWei ?? 10n ** 18n,
    });
  }

  if (options.settings !== undefined) {
    const settings: LpAutomationSettings = { ...DEFAULT_LP_SETTINGS, ...options.settings };
    const params = lpSettingsParamsView(settings);
    await settingsStore.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: paramsHash("lpSettings", params),
    });
  }

  const brainCalls: { kind: string; context: Record<string, unknown> }[] = [];
  const reconcileCalls = { count: 0 };

  const deps: LpWorkerDeps = {
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
    // PHASE3.1 Rev2 item 17: the exit swap's dust floor, the production
    // default. The fixtures' collect deltas sit far below it, so the exit's
    // step 1 records an ordinary skip and submits nothing.
    relayFeePerSubmitWei: 100_000_000_000_000n,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    brainTransport: async (kind, context) => {
      brainCalls.push({ kind, context });
      if (options.brainError !== undefined) throw options.brainError;
      return options.brainReply ?? null;
    },
    reconcile: async () => {
      reconcileCalls.count += 1;
    },
    now,
    intervalMs: INTERVAL_MS,
    dryRun: false,
  };

  return {
    deps,
    state: createLpWorkerState(),
    chain,
    provider,
    agentStore,
    journal,
    killswitch,
    store,
    settingsStore,
    observations,
    brainCalls,
    reconcileCalls,
    advance(ms: number): void {
      nowMs += ms;
    },
    nextCycleWindow(): void {
      nowMs += INTERVAL_MS;
      chain.state.evidence = {
        ...chain.state.evidence,
        blockNumber: chain.state.evidence.blockNumber + 1n,
        finalizedBlockNumber: chain.state.evidence.finalizedBlockNumber + 1n,
      };
    },
    dryRun(on: boolean): LpWorkerDeps {
      return { ...deps, dryRun: on };
    },
  };
}

function assertZeroProviderCalls(provider: FakeWalletProvider): void {
  assert.equal(provider.executeCalls.length, 0);
  assert.equal(provider.restoreCalls.length, 0);
  assert.equal(provider.preflightCalls.length, 0);
}

/* -------------------------------------------------------------------------- */
/* The truth table                                                            */
/* -------------------------------------------------------------------------- */

describe("lp worker cycle", () => {
  it("R5 cannot submit a stale position's manual exit using a canceled draft's retained key", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const agents = new MemoryAgentStore(null, () => NOW_SEC * 1_000);
    await agents.createProvisioningAgent({ record: { id: AGENT_ID, ownerAddress: ownerAccount.address,
      walletAddress: ownerAccount.address, custodyModel: "passkey" },
      pendingGrant: pendingDraft(ownerAccount.address, ownerAccount.address, NOW_SEC), sessionKey: DRAFT_KEY });
    await cancelDraft(agents, ownerAccount.address, AGENT_ID, NOW_SEC);
    await f.store.createSequence({ agentId: AGENT_ID, ownerAddress: ownerAccount.address, positionId: POSITION_ID, kind: "manual-exit" });
    await runLpWorkerOnce({ ...f.deps, agentStore: agents }, f.state);
    assertZeroProviderCalls(f.provider);
    assert.equal(await f.journal.sumNativeSpendSince(AGENT_ID, 0), 0n);
    assert.deepEqual(await f.journal.listNonTerminal(), []);
    assert.equal((await agents.getAgent(ownerAccount.address, AGENT_ID))?.sessionFacts, null);
    assert.equal(await agents.hasAgentSessionKey(ownerAccount.address, AGENT_ID), true);
  });
  it("no positions is a no-op with zero provider calls", async () => {
    const f = await fixture({ seedPosition: false });
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.equal(report.outcomes.length, 0);
    assert.equal(report.reconciled, true);
    assertZeroProviderCalls(f.provider);
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("does not enter readers, evaluators, providers, appends, or ordinary mutations behind a pre-bind retirement fence", async () => {
    const makeStores: readonly {
      readonly name: string;
      readonly create: () => Promise<LpSequenceStore>;
    }[] = [
      { name: "memory", create: async () => new MemoryLpSequenceStore() },
      { name: "postgres(fake)", create: async () => PostgresLpSequenceStore.create(new FakeSqlClient()) },
    ];
    for (const backend of makeStores) {
      const store = await backend.create();
      const f = await fixture({ store });
      const position = await store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID);
      assert.ok(position, backend.name);
      const sequence = await store.createSequence({ agentId: AGENT_ID,
        ownerAddress: ownerAccount.address, positionId: POSITION_ID, kind: "open" });
      const retirement = await store.claimSequenceForPreBindRetirement(
        ownerAccount.address, AGENT_ID, sequence.sequenceId, {
          expectedState: "active", expectedRecoveryState: "none", expectedUpdatedAt: sequence.updatedAt,
          expectedPositionId: POSITION_ID, expectedPositionVersion: position.rowVersion,
          expectedRetirementRowVersion: sequence.retirementRowVersion,
          targetJournalKey: "target-held-by-retirement", actionIdempotencyKey: "retirement-action",
          snapshotHash: `0x${"44".repeat(32)}` as Hex, leaseUntilMs: Number.MAX_SAFE_INTEGER,
        },
      );
      assert.ok(retirement, backend.name);
      const beforePosition = await store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID);
      const beforeSequence = await store.getSequence(ownerAccount.address, AGENT_ID, sequence.sequenceId);
      let chainRead = 0;
      const readers = new Proxy(f.deps.readers, { get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? async (...args: unknown[]) => {
          chainRead += 1;
          return Reflect.apply(value, target, args);
        } : value;
      } });
      const report = await runLpWorkerOnce({ ...f.deps, readers }, f.state);
      assert.equal(report.outcomes.length, 0, backend.name);
      assert.equal(chainRead, 0, `${backend.name}: retirement must be invisible before a reader`);
      assertZeroProviderCalls(f.provider);
      assert.deepEqual(await store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID), beforePosition,
        `${backend.name}: worker must not mutate the fenced position`);
      assert.deepEqual(await store.getSequence(ownerAccount.address, AGENT_ID, sequence.sequenceId), beforeSequence,
        `${backend.name}: worker must not append or mutate the fenced sequence`);
      assert.equal((await store.listSequences(ownerAccount.address, AGENT_ID)).length, 1,
        `${backend.name}: worker must not create a replacement sequence`);
      await store.close();
    }
  });

  it("a non-terminal sequence is resumed before any new trigger work", async () => {
    // Protect would be eligible on a later cycle, but the position carries an
    // in-flight manual exit: the worker must drive THAT and evaluate nothing.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "manual-exit",
    });

    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.equal(report.outcomes.length, 1);
    const outcome = report.outcomes[0];
    assert.ok(outcome !== undefined);
    assert.equal(outcome.action, "resumed");
    assert.equal(outcome.kind, "manual-exit");
    // The resume drove the EXISTING sequence; no second one appeared, and no
    // trigger observation was recorded for the position. (PHASE3.2: the
    // assertion moved from the process-memory Map to the DURABLE store â€” the
    // property is unchanged, its home is not.)
    const sequences = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences.length, 1);
    assert.equal(
      await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID),
      null,
    );
    assert.equal(f.state.dryRunObservations.size, 0);
    assert.ok(f.provider.executeCalls.length >= 1, "the resume reached the provider");
  });

  it("claims a HELD sequence active before the first context chain read", async () => {
    const f = await fixture();
    const sequence = await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "manual-exit",
    });
    await f.store.setRecoveryState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "wbnb-stranded",
    );
    await f.store.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "held",
    );

    const baseGetPool = f.deps.readers.getPool;
    const readers: LpWorkerChainReaders = {
      ...f.deps.readers,
      getPool: async (...args) => {
        const claimed = await f.store.getSequence(
          ownerAccount.address,
          AGENT_ID,
          sequence.sequenceId,
        );
        assert.equal(
          claimed?.state,
          "active",
          "context read ran before the worker contended with abandon",
        );
        return baseGetPool(...args);
      },
    };

    const report = await runLpWorkerOnce({ ...f.deps, readers }, f.state);
    assert.equal(report.outcomes[0]?.action, "resumed");
  });

  it("dispatches a protect after two comparable finalized observations", async () => {
    // Basis 1 BNB, stop-loss 10%, tiny live value â‡’ breach; needs 2 cycles.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const first = await runLpWorkerOnce(f.deps, f.state);
    assert.equal(first.outcomes[0]?.action, "hold");
    assertZeroProviderCalls(f.provider);

    f.nextCycleWindow();
    const second = await runLpWorkerOnce(f.deps, f.state);
    const outcome = second.outcomes[0];
    assert.ok(outcome !== undefined);
    assert.equal(outcome.action, "dispatched");
    assert.equal(outcome.kind, "protect");
    assert.equal(outcome.decision, "protect-stop-loss");
    const sequences = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences.length, 1);
    assert.equal(sequences[0]?.kind, "protect");
  });

  it("pause: the protect still dispatches (FINDINGS (s) carve-out) and a halt blocks it", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    await f.killswitch.pauseAgent(AGENT_ID, ownerAccount.address);

    await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "dispatched");
    assert.equal(outcome?.kind, "protect");
    assert.ok(f.provider.executeCalls.length >= 1, "the paused protect reached the provider");

    // A global halt is the operator's stop and blocks everything.
    const halted = await fixture({ settings: { stopLossPct: 10 } });
    await halted.killswitch.halt("test");
    await runLpWorkerOnce(halted.deps, halted.state);
    halted.nextCycleWindow();
    const haltedReport = await runLpWorkerOnce(halted.deps, halted.state);
    const haltedOutcome = haltedReport.outcomes[0];
    assert.equal(haltedOutcome?.action, "skipped");
    assert.match(haltedOutcome?.reason ?? "", /GLOBAL_HALT/u);
    assertZeroProviderCalls(halted.provider);
    assert.equal(
      (await halted.store.listSequences(ownerAccount.address, AGENT_ID)).length,
      0,
      "no sequence (and no reservation accounting) is minted under halt",
    );
  });

  it("pause: no NEW rotate work starts (Rev2 item 16)", async () => {
    const f = await fixture({ settings: { autoRotate: true } });
    f.chain.state.currentTick = 600; // out of [-500, 500)
    await f.killswitch.pauseAgent(AGENT_ID, ownerAccount.address);

    await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.decision, "rotate");
    assert.equal(outcome?.action, "skipped");
    assert.match(outcome?.reason ?? "", /AGENT_PAUSED/u);
    assertZeroProviderCalls(f.provider);
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("protect and rotate both eligible: exactly one saga, and zero brain calls", async () => {
    const f = await fixture({
      settings: { stopLossPct: 10, autoRotate: true, brainEnabled: true },
    });
    f.chain.state.currentTick = 600; // rotate-eligible too

    await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "dispatched");
    assert.equal(outcome?.kind, "protect", "priority protect(0) > rotate(1)");
    const sequences = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences.length, 1, "one saga per position per cycle");
    assert.equal(sequences[0]?.kind, "protect");
    // Rev2 item 28: no protect path can reach the brain, even with the
    // transport wired and brainEnabled signed on.
    assert.equal(f.brainCalls.length, 0);
  });

  it("darkens a legacy brainEnabled row without a brain block on a dispatched rotate", async () => {
    const f = await fixture({ settings: { autoRotate: true, brainEnabled: true } });
    f.chain.state.currentTick = 600;

    await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "dispatched");
    assert.equal(outcome?.kind, "rotate");
    assert.equal(f.brainCalls.length, 0, "legacy settings never attach the present transport");
  });

  for (const scenario of [
    { name: "accepted range", reply: { tickLower: 0, tickUpper: 1_000 }, target: [0, 1_000] as const },
    { name: "transport throw", error: new Error("brain unavailable"), target: [100, 1_100] as const },
    { name: "out-of-fence reply", reply: { tickLower: -1_003, tickUpper: 997, budgetWei: "1" }, target: [100, 1_100] as const },
  ] as const) {
    it(`dispatches a brain-enabled rotate through ${scenario.name} without leaving the fence`, async () => {
      const f = await fixture({
        settings: {
          autoRotate: true,
          brainEnabled: true,
          brain: {
            primaryModel: "0gm-1.0-35b-a3b",
            fallbackModel: "qwen3-vl-30b",
            instructions: null,
            skillMarkdown: null,
          },
        },
        ...("reply" in scenario ? { brainReply: scenario.reply } : { brainError: scenario.error }),
      });
      f.chain.state.currentTick = 600;
      const deps: LpWorkerDeps = {
        ...f.deps,
        readers: {
          ...f.deps.readers,
          positions: async (tokenId) => tokenId === 777n
            ? f.provider.executeCalls.length === 0
              ? { liquidity: 1_000n, tickLower: -500, tickUpper: 500 }
              : { liquidity: 0n, tickLower: -500, tickUpper: 500 }
            : { liquidity: 1_000n, tickLower: scenario.target[0], tickUpper: scenario.target[1] },
          receipts: {
            ...f.deps.readers.receipts,
            collectAmounts: async () => ({ amount0Wei: 10n ** 18n, amount1Wei: 10n ** 18n }),
            swapAmounts: async () => ({ tokenIn: WBNB, amountInWei: 10n, tokenOut: TOKEN, amountOutWei: 10n }),
          },
        },
      };
      await runLpWorkerOnce(deps, f.state);
      f.nextCycleWindow();
      const report = await runLpWorkerOnce(deps, f.state);
      assert.equal(report.outcomes[0]?.action, "dispatched");
      assert.equal(report.outcomes[0]?.kind, "rotate");
      const sequence = (await f.store.listSequences(ownerAccount.address, AGENT_ID))[0];
      assert.equal(f.brainCalls.length, 1, `${report.outcomes[0]?.reason ?? ""}|${sequence?.state}|${sequence?.recoveryState}|${sequence?.note ?? ""}`);
      assert.equal(sequence?.state, "held", `${report.outcomes[0]?.reason ?? ""}|${sequence?.recoveryState}|${sequence?.note ?? ""}`);
      assert.match(sequence?.recoveryState ?? "", /pending-mint|wbnb-stranded/u);
    });
  }

  it("parks a dispatched brain-enabled rotate on hold without persisting owner text", async () => {
    const ownerText = "Authorization: Bearer owner-secret";
    const f = await fixture({
      settings: {
        autoRotate: true,
        brainEnabled: true,
        brain: {
          primaryModel: "0gm-1.0-35b-a3b",
          fallbackModel: "qwen3-vl-30b",
          instructions: ownerText,
          skillMarkdown: null,
        },
      },
      brainReply: { holdInstead: true },
    });
    f.chain.state.currentTick = 600;
    const deps: LpWorkerDeps = {
      ...f.deps,
      readers: {
        ...f.deps.readers,
        positions: async () => f.provider.executeCalls.length === 0
          ? { liquidity: 1_000n, tickLower: -500, tickUpper: 500 }
          : { liquidity: 0n, tickLower: -500, tickUpper: 500 },
      },
    };
    await runLpWorkerOnce(deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(deps, f.state);
    assert.equal(report.outcomes[0]?.action, "dispatched");
    const sequences = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(f.brainCalls.length, 1, `${report.outcomes[0]?.reason ?? ""}|${sequences[0]?.state}|${sequences[0]?.recoveryState}|${sequences[0]?.note ?? ""}`);
    assert.equal(sequences[0]?.state, "held");
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
    assert.doesNotMatch(
      `${report.outcomes[0]?.reason ?? ""}|${sequences.map((sequence) => `${sequence.note ?? ""}|${sequence.stallCode ?? ""}`).join("|")}`,
      /owner-secret/u,
    );
  });

  it("dry-run logs the full decision and executes nothing", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const dry = f.dryRun(true);

    await runLpWorkerOnce(dry, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(dry, f.state);

    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "dry-run");
    assert.equal(outcome?.decision, "protect-stop-loss");
    // PHASE3.1 Rev2 item 22: the exit's plan is two positions, and a dry run
    // that under-reported it would be exactly the drift the constant exists
    // to prevent.
    assert.deepEqual(outcome?.plannedSteps, ["zap-out", "sweep-token"]);
    assert.ok(outcome?.triggerReason !== undefined, "the full trigger reason is logged");
    assert.match(outcome?.reason ?? "", /Nothing was executed/u);

    // ZERO provider calls, no sequences, no reservations, no journal rows,
    // and reconcile was never invoked.
    assertZeroProviderCalls(f.provider);
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
    assert.equal((await f.journal.listNonTerminal()).length, 0);
    assert.equal(f.reconcileCalls.count, 0);
    assert.equal(report.reconciled, false);
    // PHASE3.2 Rev2 items 7/8: ...and NO DURABLE OBSERVATION ROW. The two dry
    // cycles reached `protect-stop-loss` above through the process-local
    // overlay; a rehearsal that left durable state would let the next LIVE
    // `--once` confirm a protect having looked at the market exactly ONCE.
    assert.equal(
      await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID),
      null,
      "a dry run must leave no durable observation",
    );
    assert.equal(f.state.dryRunObservations.size, 1, "the overlay carried it");
  });

  it("a stored settings digest that does not recompute skips the position", async () => {
    const f = await fixture();
    const params = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, stopLossPct: 10 });
    await f.settingsStore.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: `0x${"ab".repeat(32)}`, // NOT paramsHash("lpSettings", params)
    });

    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.match(outcome?.reason ?? "", /digest/iu);
    assertZeroProviderCalls(f.provider);
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("a burned position token is skipped with the reason logged", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.positions.set(TOKEN_ID, "burned");
    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.match(outcome?.reason ?? "", /burned/iu);
  });
});

/* -------------------------------------------------------------------------- */
/* Boot config                                                                */
/* -------------------------------------------------------------------------- */

const RAIL_ENV = {
  LP_MAX_PRICE_IMPACT_BPS: "300",
  LP_MAX_SPOT_TWAP_DEVIATION_BPS: "500",
  LP_MIN_OBSERVATION_CARDINALITY: "10",
  LP_MIN_POOL_LIQUIDITY_WEI: "1000",
  LP_TWAP_WINDOW_SECONDS: "300",
  LP_MAX_SAGA_SLIPPAGE_BPS: "100",
};

describe("lp worker boot config", () => {
  it("refuses to start when LP_ENABLED is not true", () => {
    assert.throws(() => resolveLpWorkerBootConfig({}), /LP_ENABLED/u);
    assert.throws(
      () => resolveLpWorkerBootConfig({ LP_ENABLED: "false", ...RAIL_ENV }),
      /LP_ENABLED/u,
    );
  });

  it("refuses to start on missing rails â€” never a silent hold", () => {
    assert.throws(
      () => resolveLpWorkerBootConfig({ LP_ENABLED: "true" }),
      /LP manipulation rails are not configured/u,
    );
    assert.throws(
      () =>
        resolveLpWorkerBootConfig({
          LP_ENABLED: "true",
          ...RAIL_ENV,
          LP_TWAP_WINDOW_SECONDS: "", // one missing key is enough
        }),
      /LP_TWAP_WINDOW_SECONDS/u,
    );
  });

  it("resolves and clamps the interval into [30s, 10min]", () => {
    const boot = resolveLpWorkerBootConfig({ LP_ENABLED: "true", ...RAIL_ENV });
    assert.equal(boot.atomicRotate, true);
    assert.equal(resolveLpWorkerBootConfig({ LP_ENABLED: "true", ...RAIL_ENV, LP_ROTATE_ATOMIC: "off" }).atomicRotate, false);
    assert.equal(boot.intervalMs, 60_000);
    assert.equal(boot.rails.twapWindowSeconds, 300);

    const low = resolveLpWorkerBootConfig({
      LP_ENABLED: "true",
      ...RAIL_ENV,
      LP_WORKER_INTERVAL_SEC: "5",
    });
    assert.equal(low.intervalMs, LP_WORKER_MIN_INTERVAL_MS);

    const high = resolveLpWorkerBootConfig({
      LP_ENABLED: "true",
      ...RAIL_ENV,
      LP_WORKER_INTERVAL_SEC: "9999",
    });
    assert.equal(high.intervalMs, LP_WORKER_MAX_INTERVAL_MS);

    assert.throws(
      () =>
        resolveLpWorkerBootConfig({
          LP_ENABLED: "true",
          ...RAIL_ENV,
          LP_WORKER_INTERVAL_SEC: "not-a-number",
        }),
      /LP_WORKER_INTERVAL_SEC/u,
    );

    assert.equal(clampLpWorkerIntervalMs(45_000), 45_000);
    assert.equal(clampLpWorkerIntervalMs(1), LP_WORKER_MIN_INTERVAL_MS);
    assert.equal(clampLpWorkerIntervalMs(10 ** 9), LP_WORKER_MAX_INTERVAL_MS);
  });
});

/* -------------------------------------------------------------------------- */
/* Worker-queue store methods: memory and Postgres answer identically         */
/* -------------------------------------------------------------------------- */

describe("lp worker store queue", () => {
  it("listOpenPositionsForWorker / listNonTerminalSequencesForWorker agree across backends", async () => {
    let nowMs = NOW_SEC * 1000;
    const now = (): number => (nowMs += 1);
    const memory = new MemoryLpSequenceStore(now);
    const postgres = await PostgresLpSequenceStore.create(new FakeSqlClient(), now);

    for (const store of [memory, postgres]) {
      const owner = ownerAccount.address as Address;
      await store.createPosition({
        positionId: "p-open",
        agentId: AGENT_ID,
        ownerAddress: owner,
        token0: WBNB,
        token1: TOKEN,
        fee: 2500,
        tokenId: "1",
        basisWei: 1n,
      });
      await store.createPosition({
        positionId: "p-closed",
        agentId: AGENT_ID,
        ownerAddress: owner,
        token0: WBNB,
        token1: TOKEN,
        fee: 2500,
        tokenId: "2",
        basisWei: 1n,
      });
      await store.setPositionState(owner, AGENT_ID, "p-closed", "closed");

      const live = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: owner,
        positionId: "p-open",
        kind: "harvest",
      });
      const done = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: owner,
        positionId: "p-closed",
        kind: "manual-exit",
      });
      await store.setSequenceState(owner, AGENT_ID, done.sequenceId, "completed");

      const positions = await store.listOpenPositionsForWorker();
      assert.deepEqual(
        positions.map((p) => p.positionId),
        ["p-open"],
      );
      const sequences = await store.listNonTerminalSequencesForWorker();
      assert.deepEqual(
        sequences.map((s) => s.sequenceId),
        [live.sequenceId],
      );
      assert.equal(sequences[0]?.kind, "harvest");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.2 â€” the stop-loss survives a process boundary (FINDINGS (ae))       */
/* -------------------------------------------------------------------------- */

/**
 * A second worker PROCESS over the same database: fresh `LpWorkerState`, fresh
 * `LpWorkerDeps`, its own clock â€” sharing only the durable stores, which is
 * exactly what two processes share. The STORE, not the state object, is what
 * makes the acceptance test a cross-process proof (Rev2 item 31).
 */
function separateProcess(
  f: Fixture,
  options: {
    readonly atMs: number;
    readonly observations?: LpObservationStore;
  },
): { deps: LpWorkerDeps; state: LpWorkerState } {
  return {
    deps: {
      ...f.deps,
      ...(options.observations === undefined
        ? {}
        : { observations: options.observations }),
      now: () => options.atMs,
    },
    state: createLpWorkerState(),
  };
}

/** Advance the finalized block the way a real interval would. */
function advanceBlock(f: Fixture, by: bigint = 1n): void {
  f.chain.state.evidence = {
    ...f.chain.state.evidence,
    blockNumber: f.chain.state.evidence.blockNumber + by,
    finalizedBlockNumber: f.chain.state.evidence.finalizedBlockNumber + by,
  };
}

describe("lp worker: the trigger observation is durable (PHASE3.2)", () => {
  it("ACCEPTANCE â€” two SEPARATE invocations one interval apart DISPATCH a protect", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const t0 = NOW_SEC * 1000;

    // Process 1: a first observation, and nothing else. This is what every
    // `--once` invocation used to be able to achieve, for ever.
    const one = separateProcess(f, { atMs: t0 });
    const first = await runLpWorkerOnce(one.deps, one.state);
    assert.equal(first.outcomes[0]?.action, "hold");
    assert.match(first.outcomes[0]?.reason ?? "", /awaits a second finalized evaluation/u);
    assertZeroProviderCalls(f.provider);
    // The observation is in the DATABASE, not in this process's memory.
    const held = await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID);
    assert.equal(held?.protectConsecutive, 1);
    assert.equal(held?.protectBreach, "stop-loss");
    assert.equal(held?.evaluatedAtMs, t0);
    assert.equal(one.state.dryRunObservations.size, 0, "nothing in process memory");

    // Process 2: a brand-new state and deps, one interval later, next block.
    advanceBlock(f);
    const two = separateProcess(f, { atMs: t0 + INTERVAL_MS });
    const second = await runLpWorkerOnce(two.deps, two.state);
    const outcome = second.outcomes[0];
    assert.equal(outcome?.action, "dispatched");
    assert.equal(outcome?.kind, "protect");
    assert.equal(outcome?.decision, "protect-stop-loss");
    assert.equal(outcome?.observationPersisted, true);
    const sequences = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences.length, 1);
    assert.equal(sequences[0]?.kind, "protect");
  });

  it("PRE-FIX PROOF â€” the same two invocations against process-local state HOLD for ever", async () => {
    // The pre-fix behaviour, reconstructed exactly: each process gets its own
    // observation memory, so the second look has no first to compare against.
    // This is FINDINGS (ae) â€” four `--once` runs on mainnet, every one
    // answering "awaits a second finalized evaluation", with pnl -166 bps
    // against a 1% stop.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const t0 = NOW_SEC * 1000;

    for (let run = 0; run < 4; run += 1) {
      const worker = separateProcess(f, {
        atMs: t0 + run * INTERVAL_MS,
        observations: new MemoryLpObservationStore(), // process-local memory
      });
      const report = await runLpWorkerOnce(worker.deps, worker.state);
      assert.equal(report.outcomes[0]?.action, "hold", `run ${run}`);
      assert.equal(report.outcomes[0]?.decision, "hold", `run ${run}`);
      assert.match(
        report.outcomes[0]?.reason ?? "",
        /awaits a second finalized evaluation/u,
        `run ${run}`,
      );
      advanceBlock(f);
    }
    assertZeroProviderCalls(f.provider);
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("a gap beyond maxObservationAgeMs restarts the count, and the next pair confirms", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const t0 = NOW_SEC * 1000;
    // The worker's own bound at the 30 s test interval is the 5-minute floor.
    const bound = lpMaxObservationAgeMs(INTERVAL_MS);
    assert.equal(bound, 300_000);

    const first = separateProcess(f, { atMs: t0 });
    await runLpWorkerOnce(first.deps, first.state);
    advanceBlock(f);

    // An outage longer than the bound: the persisted observation is DISCARDED
    // rather than trusted, so a protect cannot fire on ONE fresh look.
    const stale = separateProcess(f, { atMs: t0 + bound + 1 });
    const staleReport = await runLpWorkerOnce(stale.deps, stale.state);
    assert.equal(staleReport.outcomes[0]?.action, "hold");
    assert.equal(
      staleReport.outcomes[0]?.reason,
      LP_STALE_OBSERVATION_HOLD_REASON,
      "the discard must be REPORTED, not silent",
    );
    assert.equal(
      staleReport.outcomes[0]?.triggerReason?.previousObservationDiscarded,
      "stale",
    );
    const restarted = await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID);
    assert.equal(restarted?.protectConsecutive, 1);

    // One more pair, under the bound, confirms: a single outage costs exactly
    // one extra cycle.
    advanceBlock(f);
    const next = separateProcess(f, { atMs: t0 + bound + 1 + INTERVAL_MS });
    const confirmed = await runLpWorkerOnce(next.deps, next.state);
    assert.equal(confirmed.outcomes[0]?.action, "dispatched");
    assert.equal(confirmed.outcomes[0]?.decision, "protect-stop-loss");
  });

  it("losing the table entirely degrades to one extra cycle, never a wrong decision", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const t0 = NOW_SEC * 1000;
    await runLpWorkerOnce(f.deps, f.state);

    // `truncate lp_observations` â€” the property the separate module exists to
    // make an operator able to rely on.
    await f.observations.close();

    advanceBlock(f);
    const afterTruncate = separateProcess(f, { atMs: t0 + INTERVAL_MS });
    const held = await runLpWorkerOnce(afterTruncate.deps, afterTruncate.state);
    assert.equal(held.outcomes[0]?.action, "hold", "one extra cycle, not a wrong exit");

    advanceBlock(f);
    const next = separateProcess(f, { atMs: t0 + 2 * INTERVAL_MS });
    const confirmed = await runLpWorkerOnce(next.deps, next.state);
    assert.equal(confirmed.outcomes[0]?.action, "dispatched");
  });
});

/* -------------------------------------------------------------------------- */
/* Store failures fail SAFE, and never sit between a trigger and its dispatch */
/* -------------------------------------------------------------------------- */

/** An observation store whose chosen method always throws. */
function brokenObservations(
  inner: LpObservationStore,
  broken: "get" | "put",
): LpObservationStore {
  return {
    get: async (owner, agentId, positionId) => {
      if (broken === "get") throw new Error("connection terminated unexpectedly");
      return inner.get(owner, agentId, positionId);
    },
    put: async (input) => {
      if (broken === "put") throw new Error("connection terminated unexpectedly");
      return inner.put(input);
    },
    delete: (owner, agentId, positionId) => inner.delete(owner, agentId, positionId),
    close: () => inner.close(),
  };
}

describe("lp worker: an observation store outage is never a new way to hold a stop-loss", () => {
  it("a READ failure means NO previous observation â€” one extra cycle, never a skip", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const t0 = NOW_SEC * 1000;
    const broken = brokenObservations(f.observations, "get");

    for (let run = 0; run < 3; run += 1) {
      const worker = separateProcess(f, {
        atMs: t0 + run * INTERVAL_MS,
        observations: broken,
      });
      const report = await runLpWorkerOnce(worker.deps, worker.state);
      // HOLD, never "skipped": a skip is how this worker answers unverified
      // OWNER INTENT; losing derived telemetry is not that.
      assert.equal(report.outcomes[0]?.action, "hold", `run ${run}`);
      advanceBlock(f);
    }
  });

  it("a WRITE failure does not stop an otherwise-confirmed protect from dispatching", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const t0 = NOW_SEC * 1000;
    const first = separateProcess(f, { atMs: t0 });
    await runLpWorkerOnce(first.deps, first.state);
    advanceBlock(f);

    // The confirmed cycle: the durable write throws. The dispatch must still
    // happen â€” a Postgres blip holding a CONFIRMED stop-loss with a plausible
    // log line is (ae)'s own signature, DB-backed.
    const worker = separateProcess(f, {
      atMs: t0 + INTERVAL_MS,
      observations: brokenObservations(f.observations, "put"),
    });
    const report = await runLpWorkerOnce(worker.deps, worker.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "dispatched");
    assert.equal(outcome?.kind, "protect");
    assert.equal(outcome?.observationPersisted, false, "the failure is REPORTED");
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).length, 1);
  });

  it("a HOLD whose write fails still reports the hold and flags the write", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const worker = separateProcess(f, {
      atMs: NOW_SEC * 1000,
      observations: brokenObservations(f.observations, "put"),
    });
    const report = await runLpWorkerOnce(worker.deps, worker.state);
    assert.equal(report.outcomes[0]?.action, "hold");
    assert.equal(report.outcomes[0]?.observationPersisted, false);
  });
});

/* -------------------------------------------------------------------------- */
/* The frozen cycle clock and the cadence (FINDINGS (af))                     */
/* -------------------------------------------------------------------------- */

describe("lp worker: the cycle clock is frozen (FINDINGS (af))", () => {
  /**
   * A clock that ADVANCES during the cycle's reads, by a different amount each
   * cycle â€” the real shape of RPC latency. Before the fix, `nowMs` was stamped
   * AFTER those reads, so the stamp-to-stamp gap was
   * `cadence + (w_next - w_prev)` and went NEGATIVE when the second cycle's
   * reads were faster: 59 970 ms against a 60 000 ms interval on mainnet.
   */
  function driftingClock(): {
    now: () => number;
    startCycle: (atMs: number, stepMs: number) => void;
  } {
    let base = 0;
    let step = 0;
    let calls = 0;
    return {
      now: () => base + calls++ * step,
      startCycle: (atMs, stepMs) => {
        base = atMs;
        step = stepMs;
        calls = 0;
      },
    };
  }

  it("two cycles exactly one interval apart produce stamps exactly one interval apart", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const clock = driftingClock();
    const t0 = NOW_SEC * 1000;

    // Cycle 1's reads are SLOW (11 ms each), cycle 2's are FAST (3 ms each).
    clock.startCycle(t0, 11);
    const first = await runLpWorkerOnce(
      { ...f.deps, now: clock.now },
      createLpWorkerState(),
    );
    assert.equal(first.startedAtMs, t0, "startedAtMs is the cycle START, not its end");
    const one = await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID);
    assert.equal(one?.evaluatedAtMs, t0);

    advanceBlock(f);
    clock.startCycle(t0 + INTERVAL_MS, 3);
    const second = await runLpWorkerOnce(
      { ...f.deps, now: clock.now },
      createLpWorkerState(),
    );
    const two = await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID);
    assert.equal(two?.evaluatedAtMs, t0 + INTERVAL_MS);
    assert.equal(
      (two?.evaluatedAtMs ?? 0) - (one?.evaluatedAtMs ?? 0),
      INTERVAL_MS,
      "the stamp gap must equal the scheduler's cadence exactly",
    );
    // ...and because it does, the evaluator's `>= intervalMs` passes on the
    // SECOND cycle rather than the third. That one cycle is the whole of (af).
    assert.equal(second.outcomes[0]?.action, "dispatched");
    assert.equal(second.outcomes[0]?.decision, "protect-stop-loss");
  });
});

describe("lp worker cadence: anchored on the cycle START, re-checked", () => {
  it("nextCycleDelayMs anchors on the start and never goes negative", () => {
    assert.equal(nextCycleDelayMs(1_000, 1_000, 60_000), 60_000);
    assert.equal(nextCycleDelayMs(1_000, 31_000, 60_000), 30_000);
    // An overrun: the next cycle starts immediately, and NOT earlier â€” there
    // is no catch-up debt to repay, so no burst is possible.
    assert.equal(nextCycleDelayMs(1_000, 121_000, 60_000), 0);
  });

  it("an EARLY setTimeout is re-checked rather than trusted", async () => {
    // `setTimeout` is not contractually late-only; a 1 ms early fire would put
    // two stamps under `intervalMs` apart and reproduce (af) at 1 ms.
    let now = 1_000;
    const slept: number[] = [];
    await sleepUntilNextCycle({
      cycleStartedAtMs: 1_000,
      intervalMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        // The FIRST timer fires 1 ms early â€” the class of failure that would
        // reproduce (af) at 1 ms. The re-check sleeps the remainder exactly.
        now += slept.length === 1 ? ms - 1 : ms;
      },
    });
    assert.equal(now, 61_000, "the loop waited out the full interval");
    assert.deepEqual(slept, [60_000, 1], "it re-checked and slept the remainder");
  });

  it("an overrunning cycle waits zero, and cycle STARTS stay one interval apart", async () => {
    let now = 1_000;
    const starts: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      now += ms;
    };
    // Three cycles: the middle one overruns the interval by more than 2x.
    for (const duration of [10, 130_000, 10]) {
      const startedAt = now;
      starts.push(startedAt);
      now += duration;
      await sleepUntilNextCycle({
        cycleStartedAtMs: startedAt,
        intervalMs: 60_000,
        now: () => now,
        sleep,
      });
    }
    starts.push(now);
    for (let i = 1; i < starts.length; i += 1) {
      const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
      assert.ok(gap >= 60_000, `cycle starts ${i - 1} to ${i} were ${gap}ms apart`);
    }
    // No burst: the overrun did not cause a run of back-to-back cycles.
    assert.deepEqual(starts, [1_000, 61_000, 191_000, 251_000]);
  });

  it("a stop request breaks the wait without sleeping the remainder", async () => {
    let now = 1_000;
    let stopped = false;
    const slept: number[] = [];
    await sleepUntilNextCycle({
      cycleStartedAtMs: 1_000,
      intervalMs: 600_000,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += 1_000;
        stopped = true;
      },
      stopped: () => stopped,
    });
    assert.deepEqual(slept, [600_000]);
  });
});

/* -------------------------------------------------------------------------- */
/* Retention and the operator-visible protection status                       */
/* -------------------------------------------------------------------------- */

describe("lp worker: retention and protection status", () => {
  it("a protect that CLOSES the lineage retires the observation row with it", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const t0 = NOW_SEC * 1000;
    // The zap-out's post-verify re-reads the position: once the provider has
    // executed, the fake chain reports the liquidity gone, the saga completes,
    // and the position reaches `closed`.
    const closingReaders: LpWorkerChainReaders = {
      ...f.deps.readers,
      positions: async (tokenId) =>
        f.provider.executeCalls.length > 0
          ? { liquidity: 0n, tickLower: -500, tickUpper: 500 }
          : (f.chain.positions.get(tokenId.toString(10)) ?? "burned"),
    };

    const one = separateProcess(f, { atMs: t0 });
    await runLpWorkerOnce({ ...one.deps, readers: closingReaders }, one.state);
    assert.notEqual(
      await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID),
      null,
    );

    advanceBlock(f);
    const two = separateProcess(f, { atMs: t0 + INTERVAL_MS });
    const report = await runLpWorkerOnce(
      { ...two.deps, readers: closingReaders },
      two.state,
    );
    assert.equal(report.outcomes[0]?.action, "dispatched");
    const position = await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed", "the protect closed the lineage");
    assert.equal(
      await f.observations.get(ownerAccount.address, AGENT_ID, POSITION_ID),
      null,
      "the observation row must not outlive the lineage",
    );
  });

  it("every evaluated outcome carries the protection status the read side shows", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const report = await runLpWorkerOnce(f.deps, f.state);
    const protection = report.outcomes[0]?.protection;
    assert.ok(protection !== undefined);
    assert.equal(protection.armed, true);
    assert.equal(protection.stopLossPct, 10);
    assert.equal(protection.protectConsecutive, 1);
    assert.equal(protection.observationStale, false);
    assert.equal(
      protection.confirmationEligibleAtMs,
      NOW_SEC * 1000 + INTERVAL_MS,
      "one interval after the observation this cycle recorded",
    );
  });

  it("the settings-digest SKIP now reports armed:false with the same message", async () => {
    // PHASE3.1-REVIEW R5's silent disarm: the worker skips this position on
    // EVERY cycle and nothing an owner could query said so.
    const f = await fixture();
    const params = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, stopLossPct: 10 });
    await f.settingsStore.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: `0x${"ab".repeat(32)}`,
    });
    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.equal(outcome?.protection?.armed, false);
    assert.equal(outcome?.protection?.reason, outcome?.reason);
    assert.equal(outcome?.protection?.digestVerified, false);
  });

  it("a position with no tokenId reports armed:false rather than only skipping", async () => {
    const f = await fixture({ seedPosition: false, settings: { stopLossPct: 10 } });
    await f.store.createPosition({
      positionId: POSITION_ID,
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2500,
      basisWei: 10n ** 18n,
    });
    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.equal(outcome?.protection?.armed, false);
    assert.equal(outcome?.protection?.reason, LP_NO_TOKEN_ID_REASON);
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.4 M6/M7/M8 — the ownership gate                                     */
/* -------------------------------------------------------------------------- */

describe("lp worker: the position's NFT left the wallet", () => {
  it("first confirmed mismatch: skips, increments a DURABLE count, and does NOT close", async () => {
    // Durable because the alternative is FINDINGS (ae) a third time — a
    // confirmation counter in process memory resets on every restart, so a
    // two-cycle rule could never fire on a restarting daemon and would fire
    // never on `--once`.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    const report = await runLpWorkerOnce(f.deps, f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.match(outcome?.reason ?? "", /not the agent wallet/iu);
    assert.match(outcome?.reason ?? "", /second consecutive confirmation/iu);

    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.ownershipMismatchCount, 1);
    assert.equal(position?.state, "open");
    assert.match(position?.ownershipLostReason ?? "", /is held by/iu);
    assertZeroProviderCalls(f.provider);
  });

  it("second consecutive confirmation CLOSES the row, which is what frees the tokenId", async () => {
    // Without this the global unique index deadlocks the NFT's next owner: the
    // worker only skips, an exit on a transferred NFT reverts and rolls back,
    // and nothing else can ever move the row to `closed`.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.match(report.outcomes[0]?.reason ?? "", /confirmed twice/iu);

    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "closed");
    // Closing the lineage resets the basis in the same write (R7).
    assert.equal(position?.basisWei, 0n);
  });

  it("a transfer BACK resets the count, so an unrelated later mismatch starts from one", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    await runLpWorkerOnce(f.deps, f.state);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.ownershipMismatchCount,
      1,
    );

    f.chain.nftOwner = ownerAccount.address;
    f.nextCycleWindow();
    await runLpWorkerOnce(f.deps, f.state);
    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.ownershipMismatchCount, 0);
    assert.equal(position?.ownershipLostReason, null);
    assert.equal(position?.state, "open");
  });

  it("a READ FAILURE holds and writes nothing — an outage is not a lost NFT", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const readers = f.deps.readers as {
      ownerOf: (tokenId: bigint) => Promise<Address | "burned">;
    };
    readers.ownerOf = async () => {
      throw new Error("rpc down");
    };
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.match(
      report.outcomes[0]?.reason ?? "",
      /holding rather than treating an RPC failure/iu,
    );

    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.ownershipMismatchCount, 0);
    assert.equal(position?.state, "open");
  });

  it("the close DEFERS while a non-terminal sequence exists — a frozen saga is the operator's first", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    const sequence = await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "harvest",
    });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    // Two confirmations, and the row still must not close.
    await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.match(report.outcomes[0]?.reason ?? "", /close is deferred/iu);
    assert.match(
      report.outcomes[0]?.reason ?? "",
      new RegExp(sequence.sequenceId, "iu"),
    );

    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "open");
  });

  it("a RESUME is frozen too — this is the money half (M8)", async () => {
    // NFPM `increaseLiquidity` is PERMISSIONLESS: a harvest resumed after the
    // NFT was transferred away would deposit both carried legs into a position
    // someone else now owns, and would NOT revert. The gate sits in
    // `loadPositionContext`, which BOTH worker paths call, so a mismatch
    // freezes the sequence rather than resuming it. A frozen sequence costs
    // patience; a resumed one donates.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "harvest",
    });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.equal(report.outcomes[0]?.action, "skipped");
    assertZeroProviderCalls(f.provider);
  });

  it("reports armed:false with the not-owned reason, not a settings or basis problem", async () => {
    // PHASE3.3-AUDIT A3's failure class: the worker knows and the OWNER does
    // not. And the reason must name what actually happened — sending someone to
    // fix a digest or a basis would be a second lie on top of the first.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const report = await runLpWorkerOnce(f.deps, f.state);
    const protection = report.outcomes[0]?.protection;
    assert.equal(protection?.armed, false);
    assert.equal(protection?.reason, LP_NOT_OWNED_REASON);
    assert.ok((protection?.ownershipMismatchCount ?? 0) >= 1);
  });

  it("a BURNED token counts as a confirmed mismatch", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = "burned";
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.match(report.outcomes[0]?.reason ?? "", /does not exist on chain/iu);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.ownershipMismatchCount,
      1,
    );
  });
});


/* -------------------------------------------------------------------------- */
/* PHASE3.4 audit A1/A2 — the rehearsal writes nothing, and two reads must be  */
/* separated                                                                  */
/* -------------------------------------------------------------------------- */

describe("lp worker: the ownership gate under --dry-run (audit A1)", () => {
  it("reads, reports, and writes NOTHING on a mismatch", async () => {
    // The first build ran this gate from `loadPositionContext`, which BOTH
    // worker paths call before they consult `dryRun` — so a rehearsal durably
    // incremented the counter. The mode an operator reaches for precisely when
    // something looks wrong was a state-mutating operation.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    const report = await runLpWorkerOnce(f.dryRun(true), f.state);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.match(outcome?.reason ?? "", /DRY RUN, so nothing was written/iu);

    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.ownershipMismatchCount, 0);
    assert.equal(position?.ownershipLostReason, null);
    assert.equal(position?.state, "open");
  });

  it("TWO rehearsals do not close the position or zero its basis", async () => {
    // The A1 failure scenario, verbatim: an operator investigating a transfer
    // with `--once --dry-run`, twice, used to release the global tokenId claim
    // and destroy the TP/SL anchor.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    await runLpWorkerOnce(f.dryRun(true), f.state);
    f.nextCycleWindow();
    await runLpWorkerOnce(f.dryRun(true), f.state);

    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "open");
    assert.equal(position?.ownershipMismatchCount, 0);
    assert.notEqual(position?.basisWei, 0n);
  });

  it("still REPORTS armed:false, so the rehearsal tells the truth about what it saw", async () => {
    // Writing nothing must not mean seeing nothing: the whole value of the
    // rehearsal is that it reaches the same verdict a live cycle would.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    const report = await runLpWorkerOnce(f.dryRun(true), f.state);
    const protection = report.outcomes[0]?.protection;
    assert.equal(protection?.armed, false);
    assert.equal(protection?.reason, LP_NOT_OWNED_REASON);
  });

  it("a dry-run MATCH does not clear a durable count a live cycle recorded", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    await runLpWorkerOnce(f.deps, f.state); // live: count 1

    f.chain.nftOwner = ownerAccount.address;
    f.nextCycleWindow();
    await runLpWorkerOnce(f.dryRun(true), f.state);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.ownershipMismatchCount,
      1,
      "a rehearsal must not clear state either — writing nothing means nothing",
    );
  });
});

describe("lp worker: the two confirmations must be separated (audit A2)", () => {
  it("two cycles inside one interval do NOT close the position", async () => {
    // Without this, two `--once` invocations seconds apart against a single
    // misbehaving endpoint satisfy "two consecutive confirmations". The trigger
    // discipline this rule claims to inherit is interval-separated; so is this.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    await runLpWorkerOnce(f.deps, f.state);
    f.advance(1_000); // far inside INTERVAL_MS
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.match(report.outcomes[0]?.reason ?? "", /inside the .* worker interval/iu);

    const position = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "open");
    assert.equal(position?.ownershipMismatchCount, 2, "the count still advances");
  });

  it("and DO close once a full interval has passed", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");

    await runLpWorkerOnce(f.deps, f.state);
    f.advance(1_000);
    await runLpWorkerOnce(f.deps, f.state); // refused: too close
    f.advance(60_000);
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.match(report.outcomes[0]?.reason ?? "", /confirmed twice/iu);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.state,
      "closed",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.4-FIXREVIEW F1 — the separation gate under REAL in-cycle latency     */
/* -------------------------------------------------------------------------- */

describe("lp worker: the ownership close survives in-cycle latency (F1)", () => {
  /**
   * The defect this suite could not previously see, and why.
   *
   * Every other worker test shares ONE frozen clock between the worker and the
   * store, so no time passes inside a cycle: the confirmation write lands at
   * exactly the cycle start, and a separation rule comparing "now" against that
   * write passes at the boundary. Production cannot reproduce that — the write
   * happens at *cycle start + delta*, after reconcile, the store reads and the
   * `ownerOf` RPC — while the daemon anchors consecutive cycle STARTS exactly
   * one interval apart. So the first fix measured `interval - delta` every
   * cycle, short for ever, and the close could never fire.
   *
   * These tests advance the injected clock inside `ownerOf`, which is where the
   * real latency sits, and place cycle starts at the daemon's own cadence. Each
   * one FAILS against the reverted rule (verified by reverting it) and passes
   * against the anchored one.
   */
  const LATENCY_MS = 500;

  function withLatency(f: Fixture): void {
    const readers = f.deps.readers as {
      ownerOf: (tokenId: bigint) => Promise<Address | "burned">;
    };
    const inner = readers.ownerOf.bind(readers);
    readers.ownerOf = async (tokenId) => {
      f.advance(LATENCY_MS);
      return inner(tokenId);
    };
  }

  /** Put the NEXT cycle's start exactly one interval after this one's. */
  function nextCycleStart(f: Fixture): void {
    f.advance(INTERVAL_MS - LATENCY_MS);
  }

  it("closes on the second SEPARATED confirmation even though each cycle burns latency", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    withLatency(f);

    // Cycle 1 at t. The write lands at t + LATENCY; the ANCHOR is the frozen
    // cycle clock t, which is the whole point.
    await runLpWorkerOnce(f.deps, f.state);
    const first = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(first?.ownershipMismatchCount, 1);
    assert.equal(first?.state, "open");
    assert.equal(first?.ownershipFirstSeenAtMs, first?.updatedAt - LATENCY_MS);

    // Cycle 2 starts exactly one interval after cycle 1 STARTED — the daemon's
    // own guarantee. Under the reverted rule this measured
    // INTERVAL_MS - LATENCY_MS against INTERVAL_MS and refused, for ever.
    nextCycleStart(f);
    const report = await runLpWorkerOnce(f.deps, f.state);
    assert.match(report.outcomes[0]?.reason ?? "", /confirmed twice/iu);

    const closed = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(closed?.state, "closed");
  });

  it("the anchor does not move while the mismatch persists", async () => {
    // The mechanism, asserted directly: a later confirmation inherits the first
    // one's stamp. If the gate ever rewrites it, the measured gap resets every
    // cycle and the close becomes unreachable again.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    withLatency(f);

    await runLpWorkerOnce(f.deps, f.state);
    const anchor = (
      await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID)
    )?.ownershipFirstSeenAtMs;
    assert.ok(anchor !== null && anchor !== undefined);

    // A cycle too close to separate: the count advances, the anchor does not.
    f.advance(1_000);
    await runLpWorkerOnce(f.deps, f.state);
    const held = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(held?.state, "open", "still inside the interval");
    assert.equal(held?.ownershipMismatchCount, 2);
    assert.equal(held?.ownershipFirstSeenAtMs, anchor, "the anchor must not move");

    // And once the interval has genuinely elapsed FROM THE ANCHOR it closes —
    // it needs a separated confirmation, not a third one.
    f.advance(INTERVAL_MS);
    await runLpWorkerOnce(f.deps, f.state);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.state,
      "closed",
    );
  });

  it("a transfer back clears the anchor, so a later run starts its own clock", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    withLatency(f);
    await runLpWorkerOnce(f.deps, f.state);

    f.chain.nftOwner = ownerAccount.address;
    nextCycleStart(f);
    await runLpWorkerOnce(f.deps, f.state);
    const cleared = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(cleared?.ownershipMismatchCount, 0);
    assert.equal(
      cleared?.ownershipFirstSeenAtMs,
      null,
      "a stale anchor would let the NEXT mismatch close on its first confirmation",
    );

    // Prove it: one fresh mismatch must NOT close, because its anchor is now.
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    nextCycleStart(f);
    await runLpWorkerOnce(f.deps, f.state);
    const fresh = await f.store.getPosition(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
    );
    assert.equal(fresh?.state, "open");
    assert.equal(fresh?.ownershipMismatchCount, 1);
  });

  it("a row predating the anchor column still closes, one cycle later", async () => {
    // `null` reads as "no anchor yet", so an in-flight mismatch from before the
    // migration costs one extra confirmation and never a wrong close.
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    await f.store.setOwnershipMismatch(
      ownerAccount.address,
      AGENT_ID,
      POSITION_ID,
      { count: 1, reason: "legacy row", firstSeenAtMs: null },
    );
    withLatency(f);

    await runLpWorkerOnce(f.deps, f.state);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.state,
      "open",
      "the anchor is set THIS cycle, so this cycle cannot also be the separated one",
    );

    nextCycleStart(f);
    await runLpWorkerOnce(f.deps, f.state);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.state,
      "closed",
    );
  });

  it("the DRY-RUN report does not promise a close the live cycle would refuse (F2)", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    f.chain.nftOwner = getAddress("0x1111111111111111111111111111111111111111");
    await runLpWorkerOnce(f.deps, f.state); // live: confirmation 1, anchored

    // A rehearsal one second later: the count would reach two, but the
    // separation gate would still hold — so the report must say so.
    f.advance(1_000);
    const report = await runLpWorkerOnce(f.dryRun(true), f.state);
    assert.match(report.outcomes[0]?.reason ?? "", /still hold the close/iu);
    assert.doesNotMatch(
      report.outcomes[0]?.reason ?? "",
      /and, with no non-terminal/iu,
    );

    // And a rehearsal a full interval later reports the close it would make.
    f.advance(INTERVAL_MS);
    const later = await runLpWorkerOnce(f.dryRun(true), f.state);
    assert.match(later.outcomes[0]?.reason ?? "", /close it/iu);
    assert.equal(
      (await f.store.getPosition(ownerAccount.address, AGENT_ID, POSITION_ID))
        ?.state,
      "open",
      "and STILL writes nothing",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.6 audit A2 — the worker's OWN print must agree with the dashboard   */
/* -------------------------------------------------------------------------- */

describe("lp worker: a price trigger is reported as armed (audit A2)", () => {
  it("the cycle output says armed:true on the cycle it records a price breach", () => {
    // The bug this pins is not a log-formatting detail. `lpProtectionStatus`
    // needs the position's POOL to know a price trigger applies; the worker's
    // call site omitted it, so the `--once` print reported
    // "there is nothing to arm" about a position it had just recorded a
    // `price-stop-loss` breach for — while the HTTP route, which does pass the
    // pool, said the same position was armed. Two surfaces, one fact, two
    // answers: PHASE3.3-AUDIT A3's shape.
    //
    // Deleting the `pool` block at the worker's call site must fail HERE.
    return (async () => {
      const f = await fixture({
        settings: {
          // A trigger on the fixture's own pool, already satisfied at tick 0.
          priceStopLoss: {
            token0: WBNB,
            token1: TOKEN,
            fee: 2500,
            tick: 1_000,
            when: "at-or-below",
          },
        },
      });
      const report = await runLpWorkerOnce(f.deps, f.state);
      const outcome = report.outcomes[0];
      assert.equal(outcome?.action, "hold", "one confirmation is not two");
      assert.equal(
        outcome?.protection?.armed,
        true,
        "the worker's own print must not call this position unprotected",
      );
    })();
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.11 F1 — the worker backs off a sequence that cannot progress        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.11 F1: the stall latch", () => {
  /** A held sequence that has parked at the same point past the latch bound. */
  async function latchedSequence(f: Fixture): Promise<string> {
    const sequence = await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "harvest",
    });
    await f.store.setRecoveryState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "wbnb-stranded",
    );
    await f.store.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "held",
    );
    for (let index = 0; index < LP_STALL_LATCH_ATTEMPTS; index += 1) {
      await f.store.recordSequenceStall(
        ownerAccount.address,
        AGENT_ID,
        sequence.sequenceId,
        "BUILD_REFUSED@2",
      );
    }
    return sequence.sequenceId;
  }

  it("B7: a latched sequence is SKIPPED, and the cycle writes nothing to its row", async () => {
    const f = await fixture();
    const sequenceId = await latchedSequence(f);
    const before = await f.store.getSequence(ownerAccount.address, AGENT_ID, sequenceId);

    const report = await runLpWorkerOnce(f.deps, f.state);

    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "skipped");
    assert.match(outcome?.reason ?? "", /backs off/u);
    const after = await f.store.getSequence(ownerAccount.address, AGENT_ID, sequenceId);
    assert.equal(
      after?.updatedAt,
      before?.updatedAt,
      "quiescence is the whole point: the owner's abandon measures idleness",
    );
    assert.equal(after?.state, "held");
    assertZeroProviderCalls(f.provider);
  });

  it("the position is still claimed by the deferred sequence, so no trigger fires behind it", async () => {
    const f = await fixture({ settings: { stopLossPct: 10 } });
    await latchedSequence(f);

    const first = await runLpWorkerOnce(f.deps, f.state);
    f.nextCycleWindow();
    const second = await runLpWorkerOnce(f.deps, f.state);

    for (const report of [first, second]) {
      assert.equal(report.outcomes.length, 1, "one outcome: the sequence, not the position");
      assert.equal(report.outcomes[0]?.action, "skipped");
    }
    assertZeroProviderCalls(f.provider);
  });

  it("the backoff EXPIRES: the same sequence is resumed again once the gap has passed", async () => {
    const f = await fixture();
    const sequenceId = await latchedSequence(f);
    const before = await f.store.getSequence(ownerAccount.address, AGENT_ID, sequenceId);
    f.advance(INTERVAL_MS * LP_STALL_BACKOFF_INTERVALS);

    const report = await runLpWorkerOnce(f.deps, f.state);

    assert.notEqual(
      report.outcomes[0]?.action,
      "skipped",
      "a refusal that heals by itself must still be picked up",
    );
    const after = await f.store.getSequence(ownerAccount.address, AGENT_ID, sequenceId);
    assert.notEqual(
      after?.updatedAt,
      before?.updatedAt,
      "the worker touched the row again once the backoff elapsed",
    );
  });

  it("a held resume that parks again RECORDS the stall it parked with", async () => {
    const f = await fixture();
    const sequence = await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "harvest",
    });
    await f.store.setRecoveryState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "wbnb-stranded",
    );
    await f.store.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "held",
    );

    await runLpWorkerOnce(f.deps, f.state);

    const after = await f.store.getSequence(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
    );
    assert.equal(after?.stallCount, 1, "one parked resume counted");
    assert.match(after?.stallCode ?? "", /@\d+$/u, "WHAT refused, and WHERE");
  });
});

describe("LP detail optional collectible evaluation",()=>{
  for(const mode of ["absent","present","failure","oversized","burned"] as const)it(`${mode}: counters and decision unchanged`,async()=>{
    const baseline=await fixture(), f=await fixture();
    const base=await runLpWorkerOnce(baseline.deps,baseline.state);
    const readers={...f.deps.readers,...(mode==="absent"?{}:{positionFeesAt:async()=>{if(mode==="failure")throw Error("telemetry unavailable");if(mode==="burned")return "burned" as const;return {amount0Wei:mode==="oversized"?1n<<300n:3n,amount1Wei:4n};}})};
    const result=await runLpWorkerOnce({...f.deps,readers},f.state);
    assert.deepEqual(result.outcomes,base.outcomes);
    const observation=await f.observations.get(ownerAccount.address,AGENT_ID,POSITION_ID);
    const original=await baseline.observations.get(ownerAccount.address,AGENT_ID,POSITION_ID);
    assert.deepEqual(observation && (({fees:_,...rest})=>rest)(observation),original);
    assert.equal(observation?.fees!==undefined,mode==="present");
  });
  it("dry-run carries optional fees only in overlay; evaluation failure retains prior timestamps",async()=>{
    const f=await fixture(); const readers={...f.deps.readers,positionFeesAt:async()=>({amount0Wei:3n,amount1Wei:4n})};
    await runLpWorkerOnce({...f.deps,readers,dryRun:true},f.state);assert.equal(await f.observations.get(ownerAccount.address,AGENT_ID,POSITION_ID),null);
    assert.equal([...f.state.dryRunObservations.values()][0]?.fees?.collectible0Wei,3n);
    await runLpWorkerOnce({...f.deps,readers},f.state);const prior=await f.observations.get(ownerAccount.address,AGENT_ID,POSITION_ID);
    f.nextCycleWindow();await runLpWorkerOnce({...f.deps,readers:{...readers,positionFees:async()=>{throw Error("valuation unavailable");}}},f.state);
    assert.deepEqual(await f.observations.get(ownerAccount.address,AGENT_ID,POSITION_ID),prior);
  });
});
describe("LP detail bounded history repair",()=>{
  async function history(count:number) {
    const f=await fixture();
    for(let i=0;i<count;i++){
      const s=await f.store.createSequence({agentId:AGENT_ID,ownerAddress:ownerAccount.address,positionId:POSITION_ID,kind:"harvest"});
      const key=`fees-${i}`;
      await f.store.appendStep(ownerAccount.address,AGENT_ID,s.sequenceId,{kind:"collect-fees",journalIdempotencyKey:key});
      await f.journal.begin({idempotencyKey:key,agentId:AGENT_ID,ownerAddress:ownerAccount.address,kind:"lp",decisionId:key,nativeSpendWei:0n});
      await f.journal.markCommitted(key,{txHash:`0x${i.toString(16).padStart(64,"0")}`});
      await f.store.setSequenceState(ownerAccount.address,AGENT_ID,s.sequenceId,"completed");
    }
    await f.store.setPositionState(ownerAccount.address,AGENT_ID,POSITION_ID,"closed");
    const {MemoryLpFeeEventStore}=await import("../src/store/lpFeeEvents.js");
    const feeEvents=new MemoryLpFeeEventStore();let reads=0;
    const deps={...f.deps,feeEvents,readers:{...f.deps.readers,receipts:{...f.deps.readers.receipts,feeEvents:async()=>{reads++;return {blockNumber:100n,byTokenId:new Map([[TOKEN_ID,{collected0:3n,collected1:4n,decreased0:0n,decreased1:0n}]])};}}}};
    return {f,deps,feeEvents,reads:()=>reads};
  }
  it("terminal/closed unknown-height history repairs after normal work, eight per agent",async()=>{
    const h=await history(9);let snapshots=0;
    const snapshot=h.feeEvents.snapshot.bind(h.feeEvents);
    h.feeEvents.snapshot=async(...args)=>{snapshots++;return snapshot(...args);};
    const report=await runLpWorkerOnce(h.deps,h.f.state);assert.equal(report.outcomes.length,0);assert.equal(h.reads(),8);
    assert.equal(snapshots,1);
    assert.equal((await h.feeEvents.snapshot(ownerAccount.address,AGENT_ID)).length,8);
    await runLpWorkerOnce(h.deps,h.f.state);assert.equal(h.reads(),9);
  });
  it("dry-run never reads or durably repairs receipts",async()=>{const h=await history(1);await runLpWorkerOnce({...h.deps,dryRun:true},h.f.state);assert.equal(h.reads(),0);assert.equal((await h.feeEvents.snapshot(ownerAccount.address,AGENT_ID)).length,0);});
  it("fence loss after a receipt returns prevents every new write",async()=>{
    const h=await history(1),controller=new AbortController();
    const deps={...h.deps,feeWorkerFence:{signal:controller.signal,isFatal:()=>controller.signal.aborted,assertOpen:()=>controller.signal.throwIfAborted()},readers:{...h.deps.readers,receipts:{...h.deps.readers.receipts,feeEvents:async()=>{const result=await h.deps.readers.receipts.feeEvents();controller.abort();return result;}}}};
    await runLpWorkerOnce(deps,h.f.state);assert.equal((await h.feeEvents.snapshot(ownerAccount.address,AGENT_ID)).length,0);
  });
  it("a hung receipt respects the elapsed budget and cannot write after its late return",async()=>{
    const h=await history(1);let finish: (()=>void)|undefined;
    const deps={...h.deps,readers:{...h.deps.readers,receipts:{...h.deps.readers.receipts,feeEvents:async()=>{await new Promise<void>(r=>{finish=r;});return h.deps.readers.receipts.feeEvents();}}}};
    const start=Date.now();await runLpWorkerOnce(deps,h.f.state);assert.ok(Date.now()-start<2000);finish?.();await new Promise(r=>setTimeout(r,10));assert.equal((await h.feeEvents.snapshot(ownerAccount.address,AGENT_ID)).length,0);
  });
  it("a slow first agent does not prevent the second agent's repair in the same cycle", async () => {
    const h = await history(2);
    const second = "second-fee-agent";
    await h.f.agentStore.createAgent({ id: second, ownerAddress: ownerAccount.address, walletAddress: ownerAccount.address,
      custodyModel: "self-eoa", sessionFacts: lpSessionFacts(NOW_SEC + 3600), status: "armed" });
    await h.f.store.createPosition({ positionId: "second-position", agentId: second, ownerAddress: ownerAccount.address,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: TOKEN_ID, basisWei: 1n });
    h.f.advance(1);
    const s = await h.f.store.createSequence({ agentId: second, ownerAddress: ownerAccount.address, positionId: "second-position", kind: "harvest" });
    await h.f.store.appendStep(ownerAccount.address, second, s.sequenceId, { kind: "collect-fees", journalIdempotencyKey: "second-fees" });
    await h.f.journal.begin({ idempotencyKey: "second-fees", agentId: second, ownerAddress: ownerAccount.address, kind: "lp", decisionId: "second-fees", nativeSpendWei: 0n });
    await h.f.journal.markCommitted("second-fees", { txHash: `0x${"ee".repeat(32)}` });
    await h.f.store.setSequenceState(ownerAccount.address, second, s.sequenceId, "completed");
    let reads = 0;
    const deps = { ...h.deps, readers: { ...h.deps.readers, receipts: { ...h.deps.readers.receipts, feeEvents: async () => {
      if (++reads === 1) await new Promise(resolve => setTimeout(resolve, 1100));
      return h.deps.readers.receipts.feeEvents();
    } } } };
    const { repairLpFeeEvents } = await import("../src/lp/feeRepair.js");
    await repairLpFeeEvents(deps, h.f.state);
    assert.equal(reads, 2);
    assert.equal((await h.feeEvents.snapshot(ownerAccount.address, AGENT_ID)).length, 0);
    assert.equal((await h.feeEvents.snapshot(ownerAccount.address, second)).length, 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await h.feeEvents.snapshot(ownerAccount.address, AGENT_ID)).length, 0);
  });
  it("decrease without collect records a gap and repair skips that step on the next cycle", async () => {
    const h = await history(1);
    const { decodeLpFeeReceipt, NFPM_DECREASE_LIQUIDITY_TOPIC } = await import("../src/lp/readers.js");
    const { encodeAbiParameters, padHex } = await import("viem");
    let reads = 0;
    const deps = { ...h.deps, readers: { ...h.deps.readers, receipts: { ...h.deps.readers.receipts, feeEvents: async (hash: Hex) => {
      reads++;
      return decodeLpFeeReceipt({ status: "success", transactionHash: hash, blockNumber: 100n, logs: [{ address: NFPM,
        topics: [NFPM_DECREASE_LIQUIDITY_TOPIC, padHex(`0x${BigInt(TOKEN_ID).toString(16)}`)],
        data: encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [1n, 2n, 3n]),
        transactionHash: hash, blockNumber: 100n, removed: false }] } as unknown as import("viem").TransactionReceipt, NFPM, hash);
    } } } };
    await runLpWorkerOnce(deps, h.f.state);
    const rows = await h.feeEvents.snapshot(ownerAccount.address, AGENT_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "gap");
    assert.equal(rows[0]!.reason, "receipt-evidence-invalid: Decrease without collect in managed receipt");
    await runLpWorkerOnce(deps, h.f.state);
    assert.equal(reads, 1);
  });
});

it("worker repairs atomic fees after replacement attachment using durable old NFT identity", async () => {
  const { MemoryLpFeeEventStore } = await import("../src/store/lpFeeEvents.js");
  const { repairLpFeeEvents } = await import("../src/lp/feeRepair.js");
  const f = await fixture(); const fees = new MemoryLpFeeEventStore();
  const sequence = await f.store.createSequence({ ownerAddress: ownerAccount.address, agentId: AGENT_ID, positionId: POSITION_ID, kind: "rotate" });
  await f.store.appendStep(ownerAccount.address, AGENT_ID, sequence.sequenceId, { kind: "rotate-atomic", journalIdempotencyKey: "atomic-fees", priorTokenId: TOKEN_ID });
  await f.journal.begin({ idempotencyKey: "atomic-fees", ownerAddress: ownerAccount.address, agentId: AGENT_ID, kind: "lp", decisionId: "atomic-fees" });
  await f.journal.markCommitted("atomic-fees", { txHash: `0x${"bb".repeat(32)}` });
  await f.store.updatePositionTokenId(ownerAccount.address, AGENT_ID, POSITION_ID, "999");
  await f.store.setSequenceState(ownerAccount.address, AGENT_ID, sequence.sequenceId, "completed");
  let reads = 0;
  const deps: LpWorkerDeps = { ...f.deps, feeEvents: fees, readers: { ...f.deps.readers, receipts: { ...f.deps.readers.receipts,
    feeEvents: async (_hash, identity) => { reads++; assert.equal(identity?.oldTokenId, BigInt(TOKEN_ID));
      return { blockNumber: 100n, atomicRotate: { decreased: { amount0: 1n, amount1: 2n }, collected: { amount0: 3n, amount1: 5n }, swap: null, minted: { tokenId: 999n, amount0: 1n, amount1: 2n } },
        byTokenId: new Map([[TOKEN_ID, { collected0: 3n, collected1: 5n, decreased0: 1n, decreased1: 2n }]]) }; }
  } } };
  await repairLpFeeEvents(deps, f.state); await repairLpFeeEvents(deps, f.state);
  const rows = await fees.snapshot(ownerAccount.address, AGENT_ID); assert.equal(reads, 1); assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tokenId, TOKEN_ID); assert.equal(rows[0]!.realised0Wei, 2n); assert.equal(rows[0]!.realised1Wei, 3n);
});
