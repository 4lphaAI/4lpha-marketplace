/**
 * PHASE3.22 — the WORKER's shift seams, and specifically AUDIT A2's group lock.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * The independent audit found that `gridShiftGroupLock` appeared NOWHERE in
 * `src/lp/worker.ts` while THREE shipped texts asserted a worker seam. What
 * the worker actually had was the dynamic dispatcher — which prevents a second
 * SHIFT — and not a group lock. The hole: `resumedPositions` claims only each
 * sequence's OWN `positionId`, so the SIBLING of a row holding a live or
 * UNKNOWN `grid-shift` was evaluated in full every cycle, and priority 0 (the
 * price-stop protect that decision 9 keeps armed per live row) runs BEFORE the
 * shift branch. Two consecutive breach observations would dispatch
 * `runLpProtect` into the sibling's NFT while the pair's twelve-call batch —
 * which zaps that same NFT — was unresolved.
 *
 * ─── WHAT THIS FILE PINS ──────────────────────────────────────────────────
 *
 *  1. the sibling's protect does NOT dispatch while the pair's shift is
 *     non-terminal, including the `held` + `shift-ambiguous` (UNKNOWN) case;
 *  2. it DOES dispatch once that sequence goes terminal — the lock is a lock,
 *     not a permanent disarm;
 *  3. R3.3/P7's carve-out: the sibling keeps its `ownerOf` check and its
 *     OBSERVATION WRITE, and loses only its DISPATCH. That is why the lock sits
 *     at the dispatch seam and not in the resume partition, which would have
 *     suppressed the evaluation entirely;
 *  4. mode-first: a LADDER pair — which also carries `arm_group_id` — is
 *     untouched.
 *
 * Fixture pattern is `test/lp.gridLadder.worker.test.ts`'s, for the same
 * reason: memory stores, a fake chain, and a provider asserted never to be
 * called, which is what makes "zero money moved" a measured property.
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
import { MemoryLpObservationStore, type PutLpObservationInput } from "../src/store/lpObservations.js";
import { MemoryLpGridCycleStore } from "../src/store/gridCycles.js";
import type { SessionSpec } from "../src/core/types.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import type { LpWorkerChainReaders } from "../src/lp/readers.js";
import { gridDeriveRanges } from "../src/lp/gridGeometry.js";
import { gridCrossReading } from "../src/lp/gridTriggers.js";
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
  createLpWorkerState,
  runLpWorkerOnce,
  type LpWorkerDeps,
} from "../src/lp/worker.js";

const AGENT_ID = "grid-shift-worker";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC2");
const BUY_ID = "shift-buy-row";
const SELL_ID = "shift-sell-row";
const BUY_TOKEN_ID = "9201";
const SELL_TOKEN_ID = "9202";
const ARM_GROUP_ID = "7b1e7e6b-2a5e-4e7d-9b4b-0a2f1c8d3e51";
const INTERVAL_MS = 30_000;
const SPACING = 50;
const GAP = 1_500;
const WIDTH = 50;
const TICK_ANCHOR = 0;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

/** Case B, as in the sibling worker suites: WBNB sorts into token0. */
const DERIVED = gridDeriveRanges({
  currentTick: TICK_ANCHOR,
  tickSpacing: SPACING,
  gapTicks: GAP,
  widthTicks: WIDTH,
  wbnbIsToken0: true,
  minTick: MIN_TICK,
  maxTick: MAX_TICK,
});

const SHIFT_GRID: LpGridSettings = {
  pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
  wbnbIsToken0: true,
  tickSpacing: SPACING,
  buyRange: DERIVED.buyRange,
  sellRange: DERIVED.sellRange,
  // Shift mode PINS the flip lane to 1 — it runs no flips, and any other value
  // would bound nothing while still costing a reachability slot.
  maxFlipsPerDay: 1,
  minNetEdgeBps: 0,
  mode: "shift",
  shift: {
    gapTicks: GAP,
    widthTicks: WIDTH,
    deployPctBps: 3_000,
    driftPctOfGap: 60,
    shiftsPerDay: 8,
    driftGasBudgetWei: 8n,
    driftPerMotionWei: 1n,
  },
};

const T_X = [DERIVED.sellRange.tickLower - 1, DERIVED.sellRange.tickUpper]
  .find((tick) => gridCrossReading({ currentTick: tick, range: DERIVED.sellRange, role: "sell", wbnbIsToken0: true }).filled
    && !gridCrossReading({ currentTick: tick, range: DERIVED.buyRange, role: "buy", wbnbIsToken0: true }).filled)
  ?? (() => { throw new Error("The worker fixture must have a clean sell-cross tick."); })();
const T_IN = Math.floor((DERIVED.sellRange.tickLower + DERIVED.sellRange.tickUpper) / 2);
assert.equal(gridCrossReading({ currentTick: T_IN, range: DERIVED.sellRange, role: "sell", wbnbIsToken0: true }).side, undefined);

const RECHECK_GRID: LpGridSettings = {
  ...SHIFT_GRID,
  shift: { ...SHIFT_GRID.shift!, driftPctOfGap: 0 },
};

/** The SAME rows and geometry as a LADDER, for the mode-first control. */
const LADDER_GRID: LpGridSettings = {
  pool: SHIFT_GRID.pool,
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
    settlementsPerDay: 4,
    driftMovesPerDay: 0,
    hedge: { enabled: false, minMarkoutBps: 0, maxHedgePctBps: 5_000 },
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
  tickFor?: (tokenId: string) => number;
  currentRow: string | null;
  calls: string[];
  /** The cycle clock and block, advanced between cycles so the protect
   * hysteresis can actually confirm — two observations ONE INTERVAL APART. */
  nowMs: number;
  block: bigint;
  positions: Map<string, LpPositionSnapshot | "burned">;
  nftOwner: Address | "burned";
  balances: Map<Address, bigint>;
};

class FailingPuts extends MemoryLpObservationStore {
  readonly failFor = new Set<string>();
  readonly failGetFor = new Set<string>();

  override async put(input: PutLpObservationInput): Promise<void> {
    if (this.failFor.has(input.positionId)) throw new Error("scripted");
    return super.put(input);
  }

  override async get(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    signal?: AbortSignal,
  ): Promise<LpTriggerObservation | null> {
    if (this.failGetFor.has(positionId)) throw new Error("scripted");
    return super.get(ownerAddress, agentId, positionId, signal);
  }
}

function fakeReaders(chain: Chain): LpWorkerChainReaders {
  return {
    getPool: async () => POOL,
    poolState: async () => {
      const tokenId = chain.currentRow ?? "";
      chain.calls.push(`poolState(${tokenId})`);
      const tick = chain.tickFor?.(tokenId) ?? chain.tick;
      return {
        pool: POOL,
        tickSpacing: SPACING,
        currentTick: tick,
        evidence: {
          blockNumber: chain.block,
          finalizedBlockNumber: chain.block,
          observationCardinality: 500,
          poolLiquidity: 10n ** 24n,
          priceImpactBps: 0n,
          spotSqrtPriceX96: 2n ** 96n,
          twapSqrtPriceX96: 2n ** 96n,
        },
      };
    },
    positions: async (tokenId) => chain.positions.get(tokenId.toString(10)) ?? "burned",
    positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
    ownerOf: async (tokenId) => {
      const id = tokenId.toString(10);
      chain.currentRow = id;
      chain.calls.push(`ownerOf(${id})`);
      return chain.nftOwner;
    },
    quote: async (params) => params.amountInWei,
    walletTokenBalance: async (token: Address) => chain.balances.get(token) ?? 0n,
    // GRID-GAS-RESERVE P2: the gas pot is funded so what these journeys test
    // stays the shift machinery, not the wallet's native balance.
    walletNativeBalance: async () => 10n ** 18n,
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
  readonly observations: MemoryLpObservationStore;
};

/**
 * A two-row shift pair, in one arm group, both `gridLevel: 1`, split by role —
 * the exact shape `POST /lp/grid/arm` writes for shift mode.
 *
 * A PRICE STOP is signed (legal under shift mode; only the value-versus-basis
 * `stopLossPct`/`takeProfitPct` are refused), and the chain tick is placed
 * beyond it so the protect evaluator has a real breach to act on. That is what
 * makes "the sibling's protect did not dispatch" a measurement rather than a
 * vacuous pass.
 */
async function fixture(
  options: {
    readonly grid?: LpGridSettings;
    readonly tick?: number;
    readonly rowOrder?: "buy-first" | "sell-first";
    readonly sellTokenId?: string;
    readonly observations?: MemoryLpObservationStore;
    /**
     * FINDINGS (bc): the always-firing price stop below is what makes the
     * group-lock tests non-vacuous, but protect is priority 0 — so a test that
     * needs to observe the SHIFT decision itself must turn it off, or it only
     * ever measures protect winning the race.
     */
    readonly priceStop?: boolean;
  } = {},
): Promise<Fixture> {
  const chainClock = { nowMs: NOW_SEC * 1000 };
  const now = (): number => chainClock.nowMs;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new MemoryLpSequenceStore(now);
  const settingsStore = new MemoryLpSettingsStore(now);
  const observations = options.observations ?? new MemoryLpObservationStore();
  const provider = new FakeWalletProvider();
  const chain: Chain = {
    tick: options.tick ?? TICK_ANCHOR,
    currentRow: null,
    calls: [],
    get nowMs() { return chainClock.nowMs; },
    set nowMs(value: number) { chainClock.nowMs = value; },
    block: 100n,
    positions: new Map([
      [BUY_TOKEN_ID, { liquidity: 1_000n, ...DERIVED.buyRange }],
      [options.sellTokenId ?? SELL_TOKEN_ID, { liquidity: 1_000n, ...DERIVED.sellRange }],
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
  const rows = options.rowOrder === "sell-first"
    ? [
        { positionId: SELL_ID, tokenId: options.sellTokenId ?? SELL_TOKEN_ID, gridRole: "sell" as const },
        { positionId: BUY_ID, tokenId: BUY_TOKEN_ID, gridRole: "buy" as const },
      ]
    : [
        { positionId: BUY_ID, tokenId: BUY_TOKEN_ID, gridRole: "buy" as const },
        { positionId: SELL_ID, tokenId: options.sellTokenId ?? SELL_TOKEN_ID, gridRole: "sell" as const },
      ];
  for (const [index, row] of rows.entries()) {
    if (index > 0 && options.rowOrder !== undefined) chainClock.nowMs += 1;
    await store.createPosition({ ...base, ...row });
  }

  const grid = options.grid ?? SHIFT_GRID;
  const settings: LpAutomationSettings = {
    ...DEFAULT_LP_SETTINGS,
    grid,
    // A PRICE stop — legal under both modes, and the instrument decision 9
    // names as the risk control for depletion. `at-or-above` with a tick well
    // below the chain's fires on every evaluation.
    ...(options.priceStop === false
      ? {}
      : {
          priceStopLoss: {
            token0: WBNB,
            token1: TOKEN,
            fee: 2_500,
            tick: -800_000,
            when: "at-or-above" as const,
          },
        }),
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
      gridEnabled: true,
      reconcile: async () => {},
      now,
      intervalMs: INTERVAL_MS,
      dryRun: false,
    },
  };
}

/**
 * One worker interval, on BOTH clocks the comparability rule reads: the cycle
 * clock and the block number. Without this a second cycle's observation is not
 * "one interval apart" and the protect hysteresis can never reach 2 — which
 * would make every assertion below pass VACUOUSLY.
 */
function advance(f: Fixture): void {
  f.chain.nowMs += INTERVAL_MS;
  f.chain.block += 1n;
}

/** Park a NON-TERMINAL `grid-shift` on the BUY row, in the given state. */
async function parkShift(
  f: Fixture,
  state: "held" | "abandoning",
): Promise<string> {
  const created = await f.store.createSequence({
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    positionId: BUY_ID,
    kind: "grid-shift",
    targetRange: DERIVED.buyRange,
    targetSellRange: DERIVED.sellRange,
  });
  if (state === "abandoning") {
    // `abandoning` is reachable ONLY through the owner's atomic CLAIM on a
    // HELD row — `setSequenceState` refuses both `active -> abandoning` and
    // `held -> abandoning` — so the fixture walks exactly the path the abandon
    // route walks.
    const held = await f.store.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      created.sequenceId,
      "held",
    );
    const claimed = await f.store.claimSequenceForAbandon(
      ownerAccount.address,
      AGENT_ID,
      created.sequenceId,
      {
        expectedUpdatedAt: held.updatedAt,
        claimId: "claim-1",
        nowMs: f.chain.nowMs + INTERVAL_MS * 4,
        minIdleMs: INTERVAL_MS,
      },
    );
    assert.notEqual(claimed, null, "the fixture must actually reach abandoning");
    return created.sequenceId;
  }
  if (state === "held") {
    // The row must be QUIESCENT, or the resume loop drives it and it is
    // terminal before the sibling is ever evaluated — which would make every
    // assertion below pass for the wrong reason. Three identical stalls is the
    // 3.11 latch threshold, and a latched row is exactly the in-flight state
    // this lock exists for.
    for (let i = 0; i < 3; i += 1) {
      await f.store.recordSequenceStall(
        ownerAccount.address,
        AGENT_ID,
        created.sequenceId,
        "POST_VERIFY_FAILED@0",
      );
    }
    // The R4.1 shape: the marker is what makes an ambiguous park `held` at all.
    await f.store.setRecoveryState(
      ownerAccount.address,
      AGENT_ID,
      created.sequenceId,
      "shift-ambiguous",
    );
    await f.store.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      created.sequenceId,
      "held",
    );
  }
  return created.sequenceId;
}

describe("PHASE3.22 AUDIT A2: the worker-seam group lock", () => {
  // The two NON-TERMINAL states that genuinely PERSIST across cycles. An
  // `active` row cannot: the worker is single-threaded, so the resume loop
  // drives it to a terminal state within the same cycle it was created in, and
  // a test parameterised on it would assert against a sequence that no longer
  // exists by the time the sibling is evaluated. `held` is the ambiguous park
  // R4.1 exists for; `abandoning` is the owner's claim in flight.
  for (const state of ["held", "abandoning"] as const) {
    it(`the SIBLING does not dispatch while the pair's shift is ${state}`, async () => {
      const f = await fixture();
      await parkShift(f, state);

      // Two cycles: the protect hysteresis needs two consecutive observations,
      // so a single cycle could pass vacuously.
      await runLpWorkerOnce(f.deps, createLpWorkerState());
      advance(f);
      const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());

      const sibling = outcomes.filter((o) => o.positionId === SELL_ID);
      assert.equal(sibling.length, 1, "the sibling IS still evaluated");
      assert.equal(
        sibling[0]?.action,
        "skipped",
        "but its dispatch is suppressed — protect included",
      );
      assert.match(
        sibling[0]?.reason ?? "",
        /non-terminal grid-shift/u,
        "and the reason names the pair's sequence",
      );
      // R3.3/P7's CARVE-OUT: the observation write still ran. That is why the
      // lock sits at the dispatch seam rather than in the resume partition,
      // which would have suppressed the evaluation entirely.
      assert.equal(
        sibling[0]?.observationPersisted,
        true,
        "the sibling keeps its observation write",
      );
      // NOTHING was submitted for either row.
      assert.equal(f.provider.executeCalls.length, 0);
    });
  }

  it("the sibling DOES dispatch once the shift goes terminal — a lock, not a disarm", async () => {
    const f = await fixture();
    const sequenceId = await parkShift(f, "held");
    await runLpWorkerOnce(f.deps, createLpWorkerState());
    advance(f);

    // Terminal: the pair's motion is over and the lock must lift.
    await f.store.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      sequenceId,
      "rolled-back",
    );

    await runLpWorkerOnce(f.deps, createLpWorkerState());
    advance(f);
    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const sibling = outcomes.filter((o) => o.positionId === SELL_ID);
    assert.equal(sibling.length, 1);
    assert.notEqual(
      sibling[0]?.reason ?? "",
      "",
      "the sibling is evaluated on its own terms again",
    );
    assert.equal(
      /non-terminal grid-shift/u.test(sibling[0]?.reason ?? ""),
      false,
      "the group lock no longer suppresses it",
    );
  });

  it("MODE FIRST: a LADDER pair with the same arm group is untouched", async () => {
    // A ladder pair also carries `arm_group_id`. A predicate that tested the
    // COLUMN first would change ladder behaviour on every cycle — exactly what
    // R2's byte-identity requirement forbids.
    const f = await fixture({ grid: LADDER_GRID });
    // A non-terminal sequence on the BUY row, of a LADDER kind.
    await f.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: BUY_ID,
      kind: "grid-recenter",
      targetRange: DERIVED.buyRange,
    });

    await runLpWorkerOnce(f.deps, createLpWorkerState());
    advance(f);
    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const sibling = outcomes.filter((o) => o.positionId === SELL_ID);
    assert.equal(sibling.length, 1);
    assert.equal(
      /non-terminal grid-shift/u.test(sibling[0]?.reason ?? ""),
      false,
      "a ladder pair must never see the shift group lock",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* FINDINGS (bc) — the worker must BUILD the buffer input for a SHIFT grid     */
/* -------------------------------------------------------------------------- */

/**
 * THE REGRESSION THIS FILE EXISTS FOR, and the one the whole 3.22 chain missed.
 *
 * `worker.ts`'s wallet-buffer read was gated on `gridSettings.ladder !==
 * undefined` alone, so a `mode: "shift"` grid never had its buffer read. Both
 * figures stayed `undefined`, the evaluator input omitted them (present-only-
 * when-defined), `gridShiftFunding` fail-closed on BOTH sides, and the shift
 * branch returned a funding hold every cycle for ever. Live on mainnet
 * 2026-08-30 the arm landed, the drift counter climbed past 165 against a
 * threshold of 2, and no `grid-shift` was ever dispatched.
 *
 * Why four reviews, an audit and a six-mutation pass all missed it: every other
 * shift test either drives the RESUME path or calls `evaluateGridTriggers`
 * DIRECTLY and hands it the buffers by hand — the exact input the worker failed
 * to build. Nothing executed the wiring. So this test asserts through
 * `runLpWorkerOnce` and supplies the balances ONLY through the fake reader,
 * never through the evaluator input.
 */
describe("PHASE3.22 FINDINGS (bc): the worker builds the shift buffer input", () => {
  it("dispatches grid-shift once drift is confirmed and the buffer funds both rungs", async () => {
    // Far enough below the BUY rung to clear the drift floor
    // (`max(gap x 1.6, gap + spacing)` = 2400 ticks) with room to spare.
    const f = await fixture({ tick: TICK_ANCHOR - 1_000, priceStop: false });

    // TWO cycles one interval apart: the drift counter needs a second
    // comparable observation, so a single cycle would pass vacuously — and
    // vacuity is precisely how this defect stayed invisible.
    await runLpWorkerOnce(f.deps, createLpWorkerState());
    advance(f);
    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());

    const buy = outcomes.find((o) => o.positionId === BUY_ID);
    assert.equal(
      buy?.kind,
      "grid-shift",
      `the BUY row is the pair's dispatcher and its drift is confirmed, so the `
        + `motion must dispatch; got ${buy?.action} / ${buy?.kind} — ${buy?.reason}`,
    );
    // The precise regression: a funding hold here means the worker did not read
    // the buffer, NOT that the buffer is empty — the fake reader holds 0.1 of
    // each token and `deployPctBps` is 3000.
    assert.doesNotMatch(
      buy?.reason ?? "",
      /NEITHER rung can fund a mint/u,
      "a funding hold with a funded wallet is the (bc) defect itself",
    );
  });

  it("still reads the buffer for a LADDER grid — the gate widened, it did not move", async () => {
    const f = await fixture({ grid: LADDER_GRID, tick: TICK_ANCHOR - 1_000, priceStop: false });
    await runLpWorkerOnce(f.deps, createLpWorkerState());
    advance(f);
    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());
    const buy = outcomes.find((o) => o.positionId === BUY_ID);
    assert.doesNotMatch(
      buy?.reason ?? "",
      /fund a mint/u,
      "the ladder's own buffer read must be unaffected by the widening",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The DRIFT-vs-MID-FILL hole, found by the operator reading a live receipt    */
/* -------------------------------------------------------------------------- */

/**
 * THE HOLE, stated before it is asserted.
 *
 * A shift dispatches on EITHER rung's evidence (R7's union). Drift is measured
 * per rung against ITS OWN range, so a rung the price has walked INTO reads
 * zero drift — but its SIBLING, now far on the other side, reads a large one
 * and dispatches. The motion then exits BOTH rungs, including the one that is
 * PART-WAY THROUGH CONVERTING.
 *
 * Economically that abandons a half-finished order at a mid-range average
 * instead of letting it complete at the range's own edge, which is the whole
 * point of a ping-pong rung. Nothing in the trigger looks at either rung's
 * COMPOSITION: `gridTargetSide` checks only that the TARGET ranges exclude the
 * tick, and the union checks only counters.
 *
 * Found by the operator inspecting the first live shift's receipt and asking
 * why it fired before the price reached a rung. That transaction was CLEAN —
 * both rungs were fully single-sided, so nothing was crystallised — but the
 * question exposed the case where it would not be.
 */
describe("FINDINGS (be): drift must not exit a rung that is mid-conversion", () => {
  it("dispatches only the clean sibling on mid-fill drift", async () => {
    // Tick INSIDE the sell rung [-1550, -1500) — so that rung is part token,
    // part WBNB — while the buy rung at [1550, 1600) sits 3075 ticks away,
    // over the 2400-tick drift floor. Exactly the live shape.
    const f = await fixture({ tick: -1_525, priceStop: false });

    await runLpWorkerOnce(f.deps, createLpWorkerState());
    advance(f);
    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());

    const dispatched = outcomes.filter((o) => o.kind === "grid-shift");
    assert.equal(dispatched.length, 1, "the clean rung still moves");
    const rows = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    const shift = rows.find((row) => row.kind === "grid-shift");
    assert.ok(shift);
    assert.equal(shift.shiftCause, "drift");
    assert.notEqual(shift.targetTickLower, null, "the clean BUY rung is targeted");
    assert.equal(shift.targetSellTickLower, null, "the mid-fill SELL rung is untouched");
  });

  it("DOES still dispatch on drift when both rungs are fully outside the price", async () => {
    // The control: same drift, but the tick is clear of BOTH rungs, so the
    // guard must not turn into a blanket disarm of the drift trigger.
    const f = await fixture({ tick: -1_000, priceStop: false });

    await runLpWorkerOnce(f.deps, createLpWorkerState());
    advance(f);
    const { outcomes } = await runLpWorkerOnce(f.deps, createLpWorkerState());

    const buy = outcomes.find((o) => o.positionId === BUY_ID);
    assert.equal(
      buy?.kind,
      "grid-shift",
      `a clean drift must still re-anchor the pair; got ${buy?.action} — ${buy?.reason}`,
    );
    const rows = await f.store.listSequences(ownerAccount.address, AGENT_ID);
    const shift = rows.find((row) => row.kind === "grid-shift");
    assert.ok(shift);
    assert.equal(shift.shiftCause, "drift");
    assert.notEqual(shift.targetTickLower, null);
    assert.notEqual(shift.targetSellTickLower, null, "a clean drift targets both rungs");
  });
});

describe("GRID-ONE-TICK-SHIFT-RECHECK B: worker threading of the sibling's range", () => {
  async function cycle(f: Fixture): Promise<readonly { readonly positionId: string; readonly action: string; readonly kind?: string; readonly reason: string }[]> {
    f.chain.calls.length = 0;
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    let lastOwner: string | null = null;
    for (const call of f.chain.calls) {
      if (call.startsWith("ownerOf(")) lastOwner = call.slice("ownerOf(".length, -1);
      if (!call.startsWith("poolState(")) continue;
      const tokenId = call.slice("poolState(".length, -1);
      assert.equal(lastOwner, tokenId, "poolState must use the row most recently checked by ownerOf");
    }
    return report.outcomes.map((outcome) => ({
      positionId: outcome.positionId,
      action: outcome.action,
      ...(outcome.kind === undefined ? {} : { kind: outcome.kind }),
      reason: outcome.reason,
    }));
  }

  function outcome(outcomes: readonly { readonly positionId: string; readonly action: string; readonly kind?: string; readonly reason: string }[], positionId: string): { readonly positionId: string; readonly action: string; readonly kind?: string; readonly reason: string } {
    const found = outcomes.find((entry) => entry.positionId === positionId);
    assert.ok(found, `missing outcome for ${positionId}`);
    return found;
  }

  async function noShift(f: Fixture): Promise<void> {
    assert.equal((await f.store.listSequences(ownerAccount.address, AGENT_ID)).some((row) => row.kind === "grid-shift"), false);
  }

  async function seedSellObservation(
    f: Fixture,
    input: { readonly tokenId: string; readonly lower?: boolean; readonly upper?: boolean },
  ): Promise<void> {
    const side = gridCrossReading({ currentTick: T_X, range: DERIVED.sellRange, role: "sell", wbnbIsToken0: true }).side;
    if (side === undefined) throw new Error("The worker fixture must have a sell cross side.");
    await f.observations.put({
      ownerAddress: ownerAccount.address,
      agentId: AGENT_ID,
      positionId: SELL_ID,
      observation: {
        blockNumber: f.chain.block,
        currentTick: T_X,
        evaluatedAtMs: f.chain.nowMs - INTERVAL_MS,
        poolAddress: POOL,
        protectConsecutive: 0,
        rotationBreach: false,
        rotationConsecutive: 0,
        gridCrossConsecutive: 2,
        gridCrossSide: side,
        gridRangeRelation: "outside",
        ...(input.lower === false ? {} : { tickLower: DERIVED.sellRange.tickLower }),
        ...(input.upper === false ? {} : { tickUpper: DERIVED.sellRange.tickUpper }),
        tokenId: input.tokenId,
      },
    });
  }

  async function matchingTokenObservation(f: Fixture): Promise<LpTriggerObservation> {
    const row = await f.observations.get(ownerAccount.address, AGENT_ID, SELL_ID);
    assert.ok(row);
    return row;
  }

  it("BW-1a buy-first: hold on a dispatcher-only reversal, then dispatch", async () => {
    const f = await fixture({ grid: RECHECK_GRID, rowOrder: "buy-first", priceStop: false });
    f.chain.tickFor = () => T_X;
    await cycle(f);
    advance(f);
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 2);
    f.chain.tickFor = (tokenId) => tokenId === BUY_TOKEN_ID ? T_IN : T_X;
    advance(f);
    const held = outcome(await cycle(f), BUY_ID);
    assert.equal(held.action, "hold");
    assert.match(held.reason, /Shift cross evidence is stale/u);
    assert.match(held.reason, /INSIDE/u);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 3);
    await noShift(f);
    delete f.chain.tickFor;
    f.chain.tick = T_X;
    advance(f);
    const shifted = outcome(await cycle(f), BUY_ID);
    assert.equal(shifted.kind, "grid-shift");
    assert.notEqual(shifted.reason, "");
  });

  it("BW-1b sell-first: the same hold appears when the sibling is crossed and the dispatcher is inside", async () => {
    const f = await fixture({ grid: RECHECK_GRID, rowOrder: "sell-first", priceStop: false });
    f.chain.tickFor = () => T_X;
    await cycle(f);
    advance(f);
    f.chain.tickFor = (tokenId) => tokenId === BUY_TOKEN_ID ? T_IN : T_X;
    const held = outcome(await cycle(f), BUY_ID);
    assert.equal(held.action, "hold");
    assert.match(held.reason, /Shift cross evidence is stale/u);
    await noShift(f);
    delete f.chain.tickFor;
    f.chain.tick = T_X;
    advance(f);
    assert.equal(outcome(await cycle(f), BUY_ID).kind, "grid-shift");
  });

  it("BW-1c sell-first: a persisted reversal requires two fresh crossings before dispatch", async () => {
    const f = await fixture({ grid: RECHECK_GRID, rowOrder: "sell-first", priceStop: false });
    f.chain.tickFor = () => T_X;
    await cycle(f);
    advance(f);
    f.chain.tickFor = (tokenId) => tokenId === BUY_TOKEN_ID ? T_IN : T_X;
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 2);
    delete f.chain.tickFor;
    f.chain.tick = T_IN;
    advance(f);
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 0);
    await noShift(f);
    f.chain.tick = T_X;
    advance(f);
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 1);
    await noShift(f);
    const beforeDispatch = await matchingTokenObservation(f);
    assert.equal(beforeDispatch.gridCrossConsecutive, 1);
    advance(f);
    assert.equal(outcome(await cycle(f), BUY_ID).kind, "grid-shift");
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 2);
  });

  it("BW-1c' buy-first: a persisted reversal requires two fresh crossings before dispatch", async () => {
    const f = await fixture({ grid: RECHECK_GRID, rowOrder: "buy-first", priceStop: false });
    f.chain.tickFor = () => T_X;
    await cycle(f);
    advance(f);
    await cycle(f);
    f.chain.tickFor = (tokenId) => tokenId === BUY_TOKEN_ID ? T_IN : T_X;
    advance(f);
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 3);
    delete f.chain.tickFor;
    f.chain.tick = T_IN;
    advance(f);
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 0);
    await noShift(f);
    f.chain.tick = T_X;
    advance(f);
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 1);
    await noShift(f);
    const beforeSecondCross = await matchingTokenObservation(f);
    assert.equal(beforeSecondCross.gridCrossConsecutive, 1);
    advance(f);
    await cycle(f);
    assert.equal((await matchingTokenObservation(f)).gridCrossConsecutive, 2);
    await noShift(f);
    const beforeDispatch = await matchingTokenObservation(f);
    assert.equal(beforeDispatch.gridCrossConsecutive, 2);
    advance(f);
    assert.equal(outcome(await cycle(f), BUY_ID).kind, "grid-shift");
  });

  it("BW-2 mismatched tokenId holds without a recheckable sibling range", async () => {
    for (const rowOrder of ["buy-first", "sell-first"] as const) {
      const observations = new FailingPuts();
      const f = await fixture({ grid: RECHECK_GRID, rowOrder, priceStop: false, observations, sellTokenId: "9203" });
      await seedSellObservation(f, { tokenId: "9200" });
      assert.equal((await f.observations.get(ownerAccount.address, AGENT_ID, SELL_ID))?.tokenId, "9200");
      observations.failFor.add(SELL_ID);
      const buy = outcome(await cycle(f), BUY_ID);
      assert.equal(buy.action, "hold");
      assert.match(buy.reason, /cannot be re-checked/u);
      await noShift(f);
    }
  });

  it("BW-3 either missing range bound holds without a recheckable sibling range", async () => {
    for (const missing of ["lower", "upper"] as const) {
      const observations = new FailingPuts();
      const f = await fixture({ grid: RECHECK_GRID, rowOrder: "sell-first", priceStop: false, observations });
      await seedSellObservation(f, { tokenId: SELL_TOKEN_ID, ...(missing === "lower" ? { lower: false } : { upper: false }) });
      observations.failFor.add(SELL_ID);
      const buy = outcome(await cycle(f), BUY_ID);
      assert.equal(buy.action, "hold");
      assert.match(buy.reason, /cannot be re-checked/u);
      await noShift(f);
    }
  });

  it("BW-4 closed sibling with stale evidence is ignored by the survivor", async () => {
    const observations = new FailingPuts();
    const f = await fixture({ grid: RECHECK_GRID, rowOrder: "sell-first", priceStop: false, observations });
    await seedSellObservation(f, { tokenId: SELL_TOKEN_ID });
    await f.store.setPositionState(ownerAccount.address, AGENT_ID, SELL_ID, "closed");
    const buy = outcome(await cycle(f), BUY_ID);
    assert.equal(buy.action, "hold");
    assert.doesNotMatch(buy.reason, /Shift cross evidence/u);
    await noShift(f);
  });

  it("BW-5 recovery after a successful matching-token write clears the hold, but a failed write does not", async () => {
    const recoveredStore = new FailingPuts();
    const recovered = await fixture({ grid: RECHECK_GRID, rowOrder: "sell-first", priceStop: false, observations: recoveredStore, sellTokenId: "9203" });
    await seedSellObservation(recovered, { tokenId: "9200" });
    recoveredStore.failFor.add(SELL_ID);
    assert.match(outcome(await cycle(recovered), BUY_ID).reason, /cannot be re-checked/u);
    recoveredStore.failFor.delete(SELL_ID);
    recovered.chain.tick = T_X;
    const first = outcome(await cycle(recovered), BUY_ID);
    assert.notEqual(first.kind, "grid-shift");
    assert.equal((await matchingTokenObservation(recovered)).tokenId, "9203");
    assert.equal((await matchingTokenObservation(recovered)).gridCrossConsecutive, 1);
    advance(recovered);
    assert.equal(outcome(await cycle(recovered), BUY_ID).kind, "grid-shift");

    const heldStore = new FailingPuts();
    const held = await fixture({ grid: RECHECK_GRID, rowOrder: "sell-first", priceStop: false, observations: heldStore, sellTokenId: "9203" });
    await seedSellObservation(held, { tokenId: "9200" });
    heldStore.failFor.add(SELL_ID);
    await cycle(held);
    advance(held);
    assert.match(outcome(await cycle(held), BUY_ID).reason, /cannot be re-checked/u);
    await noShift(held);
  });

  it("BW-6 the snapshot fields survive for every mode", async () => {
    const fixed: LpGridSettings = {
      pool: SHIFT_GRID.pool,
      wbnbIsToken0: SHIFT_GRID.wbnbIsToken0,
      tickSpacing: SHIFT_GRID.tickSpacing,
      buyRange: SHIFT_GRID.buyRange,
      sellRange: SHIFT_GRID.sellRange,
      maxFlipsPerDay: 12,
      minNetEdgeBps: 0,
    };
    const f = await fixture({ grid: fixed, priceStop: false });
    await cycle(f);
    const buy = await f.observations.get(ownerAccount.address, AGENT_ID, BUY_ID);
    const sell = await f.observations.get(ownerAccount.address, AGENT_ID, SELL_ID);
    assert.deepEqual(buy && { tickLower: buy.tickLower, tickUpper: buy.tickUpper }, DERIVED.buyRange);
    assert.deepEqual(sell && { tickLower: sell.tickLower, tickUpper: sell.tickUpper }, DERIVED.sellRange);
  });

  it("BW-7 a failed sibling observation read produces no shift-cross hold", async () => {
    const observations = new FailingPuts();
    const f = await fixture({ grid: RECHECK_GRID, rowOrder: "sell-first", priceStop: false, observations });
    observations.failGetFor.add(SELL_ID);
    const buy = outcome(await cycle(f), BUY_ID);
    assert.doesNotMatch(buy.reason, /Shift cross evidence/u);
    await noShift(f);
  });
});
