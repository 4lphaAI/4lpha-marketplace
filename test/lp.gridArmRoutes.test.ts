/**
 * PHASE3.16 — `POST /agents/:id/lp/grid/arm`, the autonomous grid arm's only
 * surface.
 *
 * ONE owner signature carries the COMPLETE `lpSettings` params plus a native
 * `budgetWei`, and the plane does the rest: admission, the settings write, the
 * position row, and a one-submission saga that mints the first level
 * single-sided into the signed `buyRange`. Before this phase the front door was
 * "hand-mint on PancakeSwap and import", which is still legal and is now the
 * second door.
 *
 * The fixture pattern is `test/lp.gridRoutes.test.ts`'s — the shared server
 * harness over memory stores and a fake chain — with ONE addition: a worker
 * deps block built over THOSE SAME STORES, because two of this phase's
 * requirements can only be honestly pinned by running a cycle (the persisted
 * digest surviving the worker's every-cycle recompute, and the flag-off resume
 * skip).
 *
 * THE SHARED FIXTURE'S POOL IS CASE B: `WBNB` is `0x2222…` and `TOKEN` is
 * `0x5555…`, so WBNB sorts into token0 and `wbnbIsToken0 === true`. Under that
 * orientation the quote-holding BUY level sits ABOVE the sell level, and the
 * arm funds it when the tick is BELOW it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  NOW_SEC,
  ROUTER_V3,
  SESSION_KEY,
  TOKEN,
  WBNB,
  call,
  createHarness,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
  type Harness,
} from "./support/serverHarness.js";
import type { SessionFacts } from "../src/store/agents.js";
import { DRAFT_KEY, cancelDraft, pendingDraft } from "./support/provisioningDraft.js";
import type { SessionSpec } from "../src/core/types.js";
import {
  shiftArmEconomicsRefusal,
  type LpPoolStateReading,
  type LpServerDeps,
} from "../src/server.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { MemoryLpGridCycleStore } from "../src/store/gridCycles.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import type { LpWorkerChainReaders } from "../src/lp/readers.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  DEFAULT_LP_SETTINGS,
  type LpAutomationSettings,
  type LpGridSettings,
} from "../src/lp/triggers.js";
import {
  gridDeriveRanges,
  gridShiftEconomics,
} from "../src/lp/gridTriggers.js";
import { sanitizeMessage } from "../src/core/errors.js";
import {
  LP_GRID_DISABLED_REASON,
  createLpWorkerState,
  runLpWorkerOnce,
  type LpWorkerDeps,
} from "../src/lp/worker.js";

const AGENT_ID = "agent-grid-arm";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const MINTED_TOKEN_ID = "777";
const BUDGET = 10n ** 17n;
const INTERVAL_MS = 60_000;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

const RUNTIME: LpRuntimeConfig = {
  rankingMaxAgeSec: 300,
  maxTickWidth: 200_000,
  defaultOpenWidthTicks: 1_000,
  maxRankedCandidates: 10,
  knownStakers: [],
  conversionCompatibleTokens: new Set(),
  resolveMinAgeSec: 1_800,
  resolveDiscriminatingMultipleBps: 12_000,
};

/** Case B: the quote-holding BUY level sits ABOVE the price at tick 0. */
const BUY = { tickLower: 500, tickUpper: 1_000 };
const SELL = { tickLower: -1_000, tickUpper: -500 };

function grid(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: 50,
    buyRange: BUY,
    sellRange: SELL,
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    ...overrides,
  };
}

function settingsWith(
  gridBlock: LpGridSettings | null,
  overrides: Partial<LpAutomationSettings> = {},
): Record<string, unknown> {
  return lpSettingsParamsView({
    ...DEFAULT_LP_SETTINGS,
    autoRotate: false,
    autoHarvest: false,
    ...overrides,
    grid: gridBlock,
  });
}

function lpSessionSpec(expiresAt: number, nativeCapWei = 10n ** 18n): SessionSpec {
  const tokenCapWei = nativeCapWei > 2n ** 160n ? nativeCapWei : 2n ** 160n;
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "deposit()" },
    ],
    spendCaps: [
      { limit: nativeCapWei, period: "day" },
      { limit: tokenCapWei, period: "day", token: TOKEN },
      { limit: tokenCapWei, period: "day", token: WBNB },
    ],
    expiresAt,
  };
}

function lpSessionFacts(
  expiresAt: number,
  nativeCapWei = 10n ** 18n,
  hireSizingName?: "lp-v1" | "grid-v1",
): SessionFacts {
  return {
    spec: lpSessionSpec(expiresAt, nativeCapWei),
    permissions: { calls: [], spend: [] },
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: expiresAt,
    ...(hireSizingName === undefined ? {} : {
      hireSizing: { name: hireSizingName, version: 1 as const, openNativeBudgetWei: BUDGET.toString(10) },
    }),
  };
}

/** The level the arm mints: single-sided BUY, strictly above the price. */
function mintedSnapshot(
  overrides: Partial<LpPositionSnapshot> = {},
): LpPositionSnapshot {
  return {
    liquidity: 10n ** 18n,
    ...BUY,
    operator: zeroAddress,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    ...overrides,
  };
}

type Fixture = {
  readonly harness: Harness;
  readonly lpStore: MemoryLpSequenceStore;
  readonly settingsStore: MemoryLpSettingsStore;
  readonly observations: MemoryLpObservationStore;
  readonly sizingCalls: {
    openPositionsCount: number;
    openNativeBudgetWei: bigint;
    maxGridFlipsPerDay?: number | undefined;
  }[];
  readonly capReads: { count: number; fail: boolean };
  readonly chain: {
    snapshot: LpPositionSnapshot | "burned";
    tick: number;
    owner: Address | "burned";
    liveCapWei: bigint;
  };
  /** One worker cycle over the SAME stores this route wrote. */
  workerDeps(options?: { readonly gridEnabled?: boolean }): LpWorkerDeps;
};

async function fixture(
  options: {
    readonly gridEnabled?: boolean;
    readonly settingsGrid?: LpGridSettings | null;
    readonly nativeSessionCapWei?: bigint;
    readonly canceledDraft?: boolean;
    readonly hireSizingName?: "lp-v1" | "grid-v1";
    readonly benchmarkReader?: LpServerDeps["readers"]["gridArmBenchmark"];
  } = {},
): Promise<Fixture> {
  const lpStore = new MemoryLpSequenceStore();
  const settingsStore = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();
  const cycles = new MemoryLpGridCycleStore();
  const capReads = { count: 0, fail: false };
  const chain: Fixture["chain"] = {
    snapshot: mintedSnapshot(),
    tick: 0,
    owner: ownerAccount.address,
    liveCapWei: 10n ** 18n,
  };

  const state = (): LpPoolStateReading => ({
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
  });

  const readers = {
    ...(options.benchmarkReader === undefined ? {} : { gridArmBenchmark: options.benchmarkReader }),
    getPool: async (): Promise<Address> => POOL,
    poolState: async (): Promise<LpPoolStateReading> => state(),
    positions: async (tokenId: bigint): Promise<LpPositionSnapshot | "burned"> => {
      if (tokenId === 778n) {
        return mintedSnapshot({ tickLower: -1_000, tickUpper: -500 });
      }
      if (tokenId === 779n) {
        return mintedSnapshot({ tickLower: 550, tickUpper: 1_050 });
      }
      return chain.snapshot;
    },
    positionFees: async (): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> => ({
      amount0Wei: 0n,
      amount1Wei: 0n,
    }),
    ownerOf: async (): Promise<Address | "burned"> => chain.owner,
    quote: async (params: { amountInWei: bigint }): Promise<bigint> => params.amountInWei,
    quoteWithPriceAfter: async (params: { amountInWei: bigint }) => ({
      amountOutWei: params.amountInWei,
      sqrtPriceX96After: getSqrtRatioAtTick(100),
    }),
    receipts: {
      collectAmounts: async (): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> => ({
        amount0Wei: 0n,
        amount1Wei: 0n,
      }),
      swapAmounts: async (): Promise<never> => {
        throw new Error("an arm must never submit a swap");
      },
      mintedTokenId: async (): Promise<bigint> => BigInt(MINTED_TOKEN_ID),
      mintedTokenIds: async (): Promise<readonly bigint[]> => [778n, 779n],
    },
    onChainNativeDailyCapWei: async (): Promise<bigint> => {
      // C2 pins that there is exactly ONE read per arm request: two reads can
      // disagree, which is the same defect Q4 forbade at the pool read.
      capReads.count += 1;
      if (capReads.fail) throw new Error("rpc down");
      return chain.liveCapWei;
    },
  };

  const lp: LpServerDeps = {
    store: lpStore,
    settingsStore,
    observations,
    workerIntervalMs: INTERVAL_MS,
    railsResult: { ok: true, config: RAILS },
    runtime: RUNTIME,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    gridCycles: cycles,
    ...(options.gridEnabled === undefined ? {} : { gridEnabled: options.gridEnabled }),
    readers,
  };

  const harness = await createHarness({ lp, seedAgent: options.canceledDraft !== true });
  if (options.canceledDraft === true) {
    await harness.agentStore.createProvisioningAgent({ record: { id: AGENT_ID, ownerAddress: ownerAccount.address,
      walletAddress: ownerAccount.address, custodyModel: "passkey" },
      pendingGrant: pendingDraft(ownerAccount.address, ownerAccount.address, NOW_SEC), sessionKey: DRAFT_KEY });
    await cancelDraft(harness.agentStore, ownerAccount.address, AGENT_ID, NOW_SEC);
  } else {
    await harness.agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600, options.nativeSessionCapWei, options.hireSizingName),
    status: "armed",
  });
  await harness.agentStore.putAgentSessionKey(
    ownerAccount.address,
    AGENT_ID,
    SESSION_KEY,
  );
  }
  if (options.settingsGrid !== undefined) {
    const params = settingsWith(options.settingsGrid);
    await settingsStore.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: paramsHash("lpSettings", params),
    });
  }

  return {
    harness,
    lpStore,
    settingsStore,
    observations,
    sizingCalls: [],
    capReads,
    chain,
    workerDeps(workerOptions = {}) {
      return {
        agentStore: harness.agentStore,
        journal: harness.journal,
        killswitch: harness.killswitch,
        store: lpStore,
        settingsStore,
        observations,
        provider: harness.provider,
        readers: readers as unknown as LpWorkerChainReaders,
        rails: RAILS,
        maxTickWidth: RUNTIME.maxTickWidth,
        conversionCompatibleTokens: RUNTIME.conversionCompatibleTokens,
        relayFeePerSubmitWei: 100_000_000_000_000n,
        venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
        gridCycles: cycles,
        ...(workerOptions.gridEnabled === undefined
          ? {}
          : { gridEnabled: workerOptions.gridEnabled }),
        reconcile: async () => {},
        now: () => NOW_SEC * 1000,
        intervalMs: INTERVAL_MS,
        dryRun: false,
      };
    },
  };
}

async function armCall(
  f: Fixture,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction("gridArm", params, { agentId: AGENT_ID });
  return call(f.harness, `/agents/${AGENT_ID}/lp/grid/arm`, {
    method: "POST",
    body: envelope,
  });
}

function armParams(
  overrides: {
    readonly grid?: LpGridSettings | null;
    readonly budgetWei?: bigint;
    readonly settings?: Partial<LpAutomationSettings>;
  } = {},
): Record<string, unknown> {
  return {
    settings: settingsWith(
      overrides.grid === undefined ? grid() : overrides.grid,
      overrides.settings ?? {},
    ),
    budgetWei: (overrides.budgetWei ?? BUDGET).toString(10),
  };
}

function shiftGrid(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  const shift = {
    gapTicks: 500,
    widthTicks: 500,
    deployPctBps: 3_000,
    driftPctOfGap: 60,
    shiftsPerDay: 8,
    driftGasBudgetWei: 8n,
    driftPerMotionWei: 1n,
  } as const;
  const ranges = gridDeriveRanges({
    currentTick: 0,
    tickSpacing: 50,
    gapTicks: shift.gapTicks,
    widthTicks: shift.widthTicks,
    wbnbIsToken0: true,
    minTick: -887_272,
    maxTick: 887_272,
  });
  return grid({
    ...ranges,
    mode: "shift",
    maxFlipsPerDay: 1,
    shift,
    ...overrides,
  });
}

async function viewCall(f: Fixture): Promise<Record<string, unknown>> {
  const envelope = await signOwnerAction("read", {}, { agentId: AGENT_ID });
  const response = await call(f.harness, `/agents/${AGENT_ID}/lp`, {
    headers: { "x-owner-action": toReadHeader(envelope) },
  });
  return (response.body["data"] ?? {}) as Record<string, unknown>;
}

describe("on-chain HODL owner projection", () => {
  it("starts only after owner auth, uses journal capital, then serves cached evidence", async () => {
    let reads = 0;
    const f = await fixture({ gridEnabled: true, hireSizingName: "grid-v1", benchmarkReader: async input => {
      reads++;
      assert.equal(input.capitalWei, BUDGET.toString());
      return { status: "ready", method: "arm-transaction-post-swap-v1", txHash: input.txHash,
        blockNumber: "100", blockHash: `0x${"11".repeat(32)}`, armedAtMs: NOW_SEC * 1000,
        pool: input.pool, token0: input.token0, token1: input.token1, sqrtPriceX96: (1n << 96n).toString(), capitalWei: input.capitalWei };
    } });
    assert.equal((await armCall(f, armParams())).status, 200);
    const forbidden = await call(f.harness, `/agents/${AGENT_ID}/lp`);
    assert.notEqual(forbidden.status, 200);
    assert.equal(reads, 0);
    const first = await viewCall(f);
    assert.equal(((first["grid"] as Record<string, unknown>)["benchmark"] as { status: string }).status, "pending");
    await new Promise(resolve => setImmediate(resolve));
    const second = await viewCall(f);
    assert.equal(((second["grid"] as Record<string, unknown>)["benchmark"] as { status: string }).status, "ready");
    assert.equal(reads, 1);
    assert.equal(f.harness.provider.executeCalls.length, 1, "reporting never executes another batch");
  });
});

function reason(body: Record<string, unknown>): string {
  const error = body["error"] as { message?: string } | undefined;
  return error?.message ?? "";
}

function armSection(body: Record<string, unknown>): Record<string, unknown> {
  const data = body["data"] as Record<string, unknown>;
  return data["arm"] as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* The happy path                                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16: POST /lp/grid/arm — one signature, settings plus a level", () => {
  it("explicitly refuses gridArm for an immutable lp-v1 hire profile", async () => {
    const f = await fixture({ gridEnabled: true, hireSizingName: "lp-v1" });
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.match(reason(response.body), /lp-v1 hire cannot arm a grid/u);
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("R5 refuses signed Grid arm and LP open for a canceled draft before reserving or submitting", async () => {
    const f = await fixture({ gridEnabled: true, canceledDraft: true });
    const gridResponse = await armCall(f, armParams());
    assert.equal(gridResponse.status, 400);
    assert.match(JSON.stringify(gridResponse.body), /no granted session/iu);
    const params = { pool: { token0: WBNB, token1: TOKEN, fee: 2500 }, range: "server-fenced", budgetWei: BUDGET.toString(10) };
    const lpResponse = await call(f.harness, `/agents/${AGENT_ID}/lp/open`, {
      method: "POST", body: await signOwnerAction("lpOpen", params, { agentId: AGENT_ID }),
    });
    assert.equal(lpResponse.status, 400, lpResponse.text);
    assert.match(lpResponse.text, /no granted session/iu);
    assert.equal(f.harness.provider.executeCalls.length, 0);
    assert.equal(f.harness.provider.restoreCalls.length, 0);
    assert.equal((await f.lpStore.listSequences(ownerAccount.address, AGENT_ID)).length, 0);
    assert.equal(await f.harness.journal.sumNativeSpendSince(AGENT_ID, 0), 0n);
    assert.equal((await f.harness.agentStore.getAgent(ownerAccount.address, AGENT_ID))?.sessionFacts, null);
  });
  it("persists the settings, mints the level and reports both", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, armParams());
    assert.equal(response.status, 200);

    const arm = armSection(response.body);
    assert.equal(arm["status"], "completed");
    assert.equal(arm["tokenId"], MINTED_TOKEN_ID);
    assert.match(String(arm["note"]), /the worker is watching it/u);

    // The settings row is the bytes the owner SIGNED, under the lpSettings
    // digest — not a server-synthesised object.
    const stored = await f.settingsStore.get(ownerAccount.address, AGENT_ID);
    assert.ok(stored);
    assert.deepEqual(stored!.params, armParams()["settings"]);
    assert.equal(stored!.digest, paramsHash("lpSettings", stored!.params));
    assert.equal(
      (response.body["data"] as Record<string, unknown>)["settingsDigest"],
      stored!.digest,
    );

    // The position row: zero basis, source "minted", tokenId from the receipt.
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.equal(positions.length, 1);
    assert.equal(positions[0]?.basisWei, 0n);
    assert.equal(positions[0]?.basisSource, "minted");
    assert.equal(positions[0]?.tokenId, MINTED_TOKEN_ID);

    // ONE submission, TWO calls: `mint{value}` and `refundETH`. No swap leg,
    // no approve — which is what makes "the arm never converts" structural
    // rather than a promise.
    assert.equal(f.harness.provider.executeCalls.length, 1);
    const calls = f.harness.provider.executeCalls[0]?.calls ?? [];
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.value, BUDGET, "the whole budget attaches to the mint");
    const sequences = await f.lpStore.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences[0]?.kind, "grid-arm");
    assert.equal(sequences[0]?.state, "completed");
  });

  it("M8: the response's grid section is SCOPED to what an arm actually knows", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, armParams());
    const section = (response.body["data"] as Record<string, unknown>)["grid"] as Record<
      string,
      unknown
    >;
    const armed = section["armedRange"] as Record<string, unknown>;
    assert.equal(armed["tickLower"], BUY.tickLower);
    assert.equal(armed["role"], "buy");
    assert.equal(armed["side"], "above");
    assert.equal(armed["chargesQuote"], true);
    assert.equal((section["netEdge"] as Record<string, unknown>)["ok"], true);
    // L1: "the agent is live" is true; "the first flip can fire immediately"
    // is not — the arm's own reservation moves the spacing anchor.
    assert.match(String(section["firstFlipFloor"]), /minMinutesBetweenExits/u);
    // NOT the full gridOwnerView assembly: its cycle, quota and observation
    // reads are all empty at arm time and its restart branch would contradict
    // a rolled-back arm.
    assert.equal(section["cycles"], undefined);
    assert.equal(section["pnl"], undefined);
  });

  it("C5: the persisted digest survives the worker's every-cycle recompute", async () => {
    // The entire content of the B2 blocker. `loadPositionContext` recomputes
    // `paramsHash("lpSettings", stored.params)` on EVERY cycle and SKIPS the
    // position on a mismatch, because "automation under it would run settings
    // nobody provably signed". A row whose params the server synthesised would
    // pass that recompute while being exactly what it exists to prevent — so
    // this is pinned by running a cycle, never inferred.
    const f = await fixture({ gridEnabled: true });
    assert.equal((await armCall(f, armParams())).status, 200);

    const report = await runLpWorkerOnce(
      f.workerDeps({ gridEnabled: true }),
      createLpWorkerState(),
    );
    const outcome = report.outcomes[0];
    assert.ok(outcome, "the armed position is visible to the worker");
    assert.doesNotMatch(
      String(outcome?.reason ?? ""),
      /settings/iu,
      "no digest-mismatch skip",
    );
    assert.notEqual(outcome?.action, "skipped");
  });
});

/* -------------------------------------------------------------------------- */
/* Admission: the flag, the null grid, the arm's own gate                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 R2.7/M2: the route exists with GRID_ENABLED off and says why", () => {
  it("answers 400 naming its remedy, not a bare 404", async () => {
    // The 404 posture is DEP-level (LP absent). The grid flag is a FIELD on
    // live LP deps, and a remedy-naming refusal is strictly more informative
    // at exactly equal security.
    const f = await fixture({ gridEnabled: false });
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /has not enabled the grid agent/u);
    // Nothing was written: the refusal is before the settings put.
    assert.equal(await f.settingsStore.get(ownerAccount.address, AGENT_ID), null);
    assert.equal(
      (await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length,
      0,
    );
  });

  it("C4: settings with NO grid block are refused pre-money with their own text", async () => {
    // `admitGridSettings` returns `null` for a null grid BEFORE even its flag
    // check, so without this refusal a grid-less arm would pass admission
    // entirely — not even refused on a grid-disabled deployment — and reach
    // the derivation with no buyRange to derive from.
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, armParams({ grid: null }));
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /no grid block/u);
    assert.match(reason(response.body), /buyRange and only buyRange/u);
    assert.equal(await f.settingsStore.get(ownerAccount.address, AGENT_ID), null);
  });

  it("B3: an arm over a LIVE position is refused, and no second level is minted", async () => {
    // Without this gate a `gridArm` on a live grid agent mints a SECOND
    // position — breaking the one-live-position statement, the sizing
    // invariant's documented `P = 1`, and the flip's target derivation.
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    await f.lpStore.createPosition({
      positionId: "live-level",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: "4242",
      basisWei: 0n,
      basisSource: "imported",
    });
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400);
    // PHASE3.17 R2.6 AMENDMENT (review M7): the GATE is unchanged — it still
    // refuses on ANY non-closed row, which is what this test proves — but its
    // sentence said "which a grid cannot have", and 3.17's dual arm makes that
    // false. What an arm cannot do is ADD to a grid that already holds a level.
    assert.match(reason(response.body), /cannot add to a grid that already holds one/u);
    assert.match(reason(response.body), /live-grid settings/u);
    assert.equal(
      (await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length,
      1,
      "no second row",
    );
    // C1: the refusal is the ARM'S OWN, not C2's "Grid re-sign refused" —
    // which would be sized on the live level's exitValueWei and would name a
    // remedy for a request that is not a re-sign.
    assert.doesNotMatch(reason(response.body), /re-sign refused/u);
  });

  it("B3: an arm while ANY non-terminal sequence exists is refused", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    await f.lpStore.createPosition({
      positionId: "prior",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: "4242",
      basisWei: 0n,
      basisSource: "imported",
    });
    await f.lpStore.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: "prior",
      kind: "grid-flip",
    });
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400);
    // The position gate fires first; close the row and the SEQUENCE gate is
    // what remains.
    await f.lpStore.setPositionState(ownerAccount.address, AGENT_ID, "prior", "closed");
    const second = await armCall(f, armParams());
    assert.equal(second.status, 400);
    assert.match(reason(second.body), /non-terminal grid-flip sequence/u);
    assert.match(reason(second.body), /abandon door/u);
  });

  it("M7: re-arming after a CLOSED row is accepted — the restart path", async () => {
    // A rolled-back or abandoned arm leaves LIVE settings and a CLOSED row.
    // That is a supported state, and the next gridArm takes the `alreadyGrid`
    // shape with the arm's own gate protecting it.
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    await f.lpStore.createPosition({
      positionId: "spent",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      basisWei: 0n,
      basisSource: "minted",
    });
    await f.lpStore.setPositionState(ownerAccount.address, AGENT_ID, "spent", "closed");
    const response = await armCall(f, armParams());
    assert.equal(response.status, 200);
    assert.equal(armSection(response.body)["status"], "completed");
  });
});

/* -------------------------------------------------------------------------- */
/* The G-gate at the route seam, and the net edge                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 R2.6: the route seam refuses a stale tick for free", () => {
  it("a tick INSIDE the signed buyRange refuses before any row is written", async () => {
    const f = await fixture({ gridEnabled: true });
    f.chain.tick = 750; // inside [500, 1000)
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Grid arm refused at the route/u);
    assert.match(reason(response.body), /re-sign gridArm at the current price/u);
    // The whole value of the route seam: before the position row, the
    // sequence, the reservation and the journal row, a refusal costs NOTHING.
    assert.equal(
      (await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length,
      0,
    );
    assert.equal(await f.settingsStore.get(ownerAccount.address, AGENT_ID), null);
  });

  it("a tick on the BASE-charging side refuses, naming the leg", async () => {
    const f = await fixture({ gridEnabled: true });
    f.chain.tick = 2_000; // above [500, 1000): the range charges token1 = base
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /not the quote the arm funds/u);
  });

  it("R2.3: the net-edge check runs ONCE, on the signed budget", async () => {
    const f = await fixture({ gridEnabled: true });
    // A level too small for the spread to cover one flip's relay gas.
    const response = await armCall(f, armParams({ budgetWei: 10n ** 12n }));
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Grid arm refused: the grid's spread/u);
    // The FIGURES lead and survive; the honest-scope tail is CLIPPED by
    // `sanitizeMessage`'s 280-character platform ceiling — the standing 3.13
    // R1/R2 residual, identical here to what `/lp/import` already produces.
    assert.match(reason(response.body), /Gross edge \d+ bps between the range midpoints/u);
    assert.ok(reason(response.body).length <= 280);
    // ONE text per request. C2's "Grid re-sign refused" is unreachable from
    // the arm, because the arm's own gate refused every live-level state.
    assert.doesNotMatch(reason(response.body), /re-sign refused/u);
  });
});

describe("PHASE3.25 R2.3: shift-arm economics refusals", () => {
  async function refused(gridBlock: LpGridSettings, budgetWei: bigint): Promise<string> {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, {
      ...armParams({ grid: gridBlock, budgetWei }),
      levels: 2,
    });
    assert.equal(response.status, 400);
    assert.equal(f.harness.provider.executeCalls.length, 0);
    const text = reason(response.body);
    assert.equal(text.match(/Grid arm refused:/gu)?.length, 1, JSON.stringify(response.body));
    return text;
  }

  it("refuses geometry for which no budget can clear minNetEdgeBps", async () => {
    const text = await refused(shiftGrid({ minNetEdgeBps: 5_000 }), BUDGET);
    assert.match(text, /no budget clears this shift ladder's own minNetEdgeBps/u);
    assert.match(text, /geometry has to change/u);
  });

  it("refuses a budget below the cadence-invariant shift floor", async () => {
    const text = await refused(shiftGrid(), 7_955_449_482_895_787n);
    assert.match(text, /this shift ladder needs \d+ wei/u);
    assert.match(text, /\(2\/cycle\)/u);
    assert.match(text, /Remedy: raise the budget/u);
  });

  it("admits the exact rounded minimum and mints both shift rungs", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, {
      ...armParams({ grid: shiftGrid(), budgetWei: 7_955_449_482_895_788n }),
      levels: 2,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(f.harness.provider.executeCalls.length, 1);
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.deepEqual(positions.map((position) => position.tokenId).sort(), ["778", "779"]);
  });

  it("retains the final net-edge refusal branch after the two floor checks", () => {
    const grid = shiftGrid();
    const shift = grid.shift;
    assert.notEqual(shift, undefined);
    if (shift === undefined) throw new Error("shift fixture missing");
    const economics = gridShiftEconomics({
      grid,
      shift,
      budgetWei: BUDGET,
      relayFeePerSubmitWei: 100_000_000_000_000n,
      sizeWei: 0n,
    });
    const text = shiftArmEconomicsRefusal({
      economics,
      minNetEdgeBps: grid.minNetEdgeBps,
      budgetWei: BUDGET,
      relayFeePerSubmitWei: 100_000_000_000_000n,
    });
    assert.notEqual(text, null);
    assert.equal(text?.match(/Grid arm refused:/gu)?.length, 1);
    assert.match(text ?? "", /Gross edge \d+ bps between the range midpoints/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Sizing (H1 / C2)                                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 R2.7/C2: exactly one sizing call, with the arm's own terms", () => {
  it("reads the on-chain cap ONCE per request", async () => {
    const f = await fixture({ gridEnabled: true });
    assert.equal((await armCall(f, armParams())).status, 200);
    assert.equal(f.capReads.count, 1, "two reads can disagree; one cannot");
  });

  it("an unreadable cap refuses: an arm that cannot be sized is refused", async () => {
    const f = await fixture({ gridEnabled: true });
    f.capReads.fail = true;
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /an arm that cannot be sized is refused/u);
    // Fail-closed BEFORE the settings write and the position row.
    assert.equal(await f.settingsStore.get(ownerAccount.address, AGENT_ID), null);
    assert.equal(
      (await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length,
      0,
    );
  });

  it("a cap that cannot cover the arm is refused with the actionable NUMBER leading", async () => {
    const f = await fixture({ gridEnabled: true });
    f.chain.liveCapWei = 1n;
    const response = await armCall(f, armParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Grid arm refused: the on-chain daily native cap/u);
    // The A9 shape: `sanitizeMessage` caps the body at 280 characters and the
    // arithmetic alone overruns, so the figure the remedy needs leads.
    assert.match(reason(response.body), /short by \d+ wei/u);
    assert.match(reason(response.body), /owner-add-spend-limit/u);
  });

  it("PHASE3.25 R7/R10: shift T12b keeps all remedies and projects a 78-digit shortfall", async () => {
    const hugeBudget = 10n ** 77n;
    const f = await fixture({
      gridEnabled: true,
      nativeSessionCapWei: hugeBudget,
    });
    f.chain.liveCapWei = 1n;
    const response = await armCall(f, {
      ...armParams({
        grid: shiftGrid(),
        budgetWei: hugeBudget,
        settings: { minMinutesBetweenExits: 7 },
      }),
      levels: 2,
    });
    assert.equal(response.status, 400);
    const meta = response.body["meta"] as { shortfallWei: string };
    assert.ok(meta, JSON.stringify(response.body));
    assert.equal(meta.shortfallWei.length, 78);
    const raw = "Grid arm refused: the on-chain daily native cap is too low once this arm's budget and the shift lane's gas are reserved. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, lower the budget, or raise the cap with owner-add-spend-limit. Shortfall (wei): "
      + meta.shortfallWei;
    assert.equal(raw.length, 352);
    assert.equal(reason(response.body), sanitizeMessage(raw));
    assert.equal(reason(response.body).length, 280);
    assert.match(reason(response.body), /Remedies:/u);
    assert.match(reason(response.body), /owner-add-spend-limit/u);
    assert.match(reason(response.body), /Shortfall \(wei\):/u);
  });

  it("C5/H2: the arm's budget is sized in, and the row it writes is NOT", async () => {
    // The residual, both halves in one test. The arm's OWN sizing call sees
    // `budgetWei`; after it, the row records `basisSource: "minted"` with a
    // zero basis, so `lpOpenNativeBudgetWei` models the budget term as ZERO
    // for the rest of the rolling window.
    const f = await fixture({ gridEnabled: true });
    // A cap that admits the exit reserve but NOT the budget: if the budget
    // were not summed in, this would pass.
    f.chain.liveCapWei = BUDGET / 2n;
    const refused = await armCall(f, armParams());
    assert.equal(refused.status, 400);
    assert.match(reason(refused.body), /the on-chain daily native cap is short/u);

    // With a cap that covers it, the arm lands — and the row it wrote reports
    // a zero budget term to every LATER sizing check.
    f.chain.liveCapWei = 10n ** 18n;
    assert.equal((await armCall(f, armParams())).status, 200);
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.equal(positions[0]?.basisSource, "minted");
    assert.equal(positions[0]?.basisWei, 0n, "invisible to lpOpenNativeBudgetWei");
  });
});

/* -------------------------------------------------------------------------- */
/* The worker, and the owner view                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 H4/M3: the worker and the owner's account of a level-less grid", () => {
  it("H4: an arm sequence is SKIPPED on resume while GRID_ENABLED is off", async () => {
    const f = await fixture({ gridEnabled: true });
    // Arm, then park the sequence non-terminally so the RESUME path is the one
    // the worker takes — the evaluate path's skip is settings-shaped and is
    // never reached for a position with a non-terminal sequence.
    assert.equal((await armCall(f, armParams())).status, 200);
    const positionId = (
      await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)
    )[0]?.positionId;
    assert.ok(positionId);
    const sequence = await f.lpStore.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: positionId!,
      kind: "grid-arm",
    });
    await f.lpStore.setRecoveryState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "pending-mint",
    );
    await f.lpStore.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "held",
    );

    const report = await runLpWorkerOnce(
      f.workerDeps({ gridEnabled: false }),
      createLpWorkerState(),
    );
    const skipped = report.outcomes.find((outcome) => outcome.kind === "grid-arm");
    assert.ok(skipped, "the arm sequence was seen");
    assert.equal(skipped?.action, "skipped");
    assert.equal(skipped?.reason, LP_GRID_DISABLED_REASON);
    // Running a money saga under a flag the operator turned off is the wrong
    // posture, and nothing is trapped: the sequence stays where it is.
    const after = await f.lpStore.getSequence(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
    );
    assert.equal(after?.state, "held");
  });

  it("M3: gridOwnerView's restart line names the ARM first", async () => {
    // `gridOwnerView` is the owner's ONLY in-product account of a grid with no
    // level, so this is the sentence that decides what they do next. Before
    // this phase it told them to hand-mint — the workflow the arm replaces.
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    const data = await viewCall(f);
    const section = data["grid"] as Record<string, unknown>;
    const restart = String(section["restart"]);
    assert.match(restart, /Sign gridArm \(POST \/agents\/:id\/lp\/grid\/arm\)/u);
    assert.ok(
      restart.indexOf("gridArm") < restart.indexOf("by hand"),
      "the arm is the entry path; hand-minting is named as the alternative",
    );
    // The second door is still described, because it is still true.
    assert.match(restart, /POST \/agents\/:id\/lp\/import it with basisWei 0/u);
  });

  it("PHASE3.25 R5.5: owner view projects signed drift wei and independent lanes", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: shiftGrid() });
    const data = await viewCall(f);
    const section = data["grid"] as Record<string, unknown>;
    const shift = section["shift"] as Record<string, unknown>;
    assert.equal(shift["driftGasBudgetWei"], "8");
    assert.equal(shift["driftPerMotionWei"], "1");
    const state = section["shiftState"] as Record<string, unknown>;
    const lanes = state["lanes"] as Record<string, unknown>;
    assert.deepEqual(lanes, {
      shiftsPerDay: 8,
      shiftsUsed: 0,
      driftGasBudgetWei: "8",
      driftPerMotionWei: "1",
      driftLimit: 8,
      driftUsed: 0,
      shiftsLiveTotal: 0,
      note: "Settlement and drift are separate signed allowances but share agent-wide spacing. The drift allowance was priced at signing; it is not a measured gas total.",
    });
    const revertPaths = state["revertPaths"] as Record<string, string>;
    assert.deepEqual(revertPaths, {
      submittedAndRevertedSettle:
        "burned ONE settlement slot — the reservation carries a callsId and is not releasable. Visible as shiftsUsed rising with no new tokenIds.",
      submittedAndRevertedDrift:
        "burned ONE drift motion — the reservation carries a callsId and is not releasable. Visible as driftUsed rising with no new tokenIds; shiftsUsed does NOT move.",
      builtAndRolledBack:
        "burned NOTHING — no submission and the reservation is released. The motion may re-trigger only while its signed lane allowance is nonzero; the cross/drift re-arm delay still applies. Visible as shiftsUsed and driftUsed unchanged.",
    });
    assert.equal(revertPaths["submittedAndRevertedSettle"]?.length, 136);
    assert.equal(revertPaths["submittedAndRevertedDrift"]?.length, 158);
    assert.equal(revertPaths["builtAndRolledBack"]?.length, 229);
  });

  it("PHASE3.25 R5.5: legacy owner view reports absent drift bytes as null and zero", async () => {
    const signed = shiftGrid();
    assert.ok(signed.shift);
    const {
      driftGasBudgetWei: _budget,
      driftPerMotionWei: _price,
      ...legacyShift
    } = signed.shift!;
    const f = await fixture({
      gridEnabled: true,
      settingsGrid: { ...signed, shift: legacyShift },
    });
    const data = await viewCall(f);
    const section = data["grid"] as Record<string, unknown>;
    const state = section["shiftState"] as Record<string, unknown>;
    const lanes = state["lanes"] as Record<string, unknown>;
    assert.equal(lanes["driftGasBudgetWei"], null);
    assert.equal(lanes["driftPerMotionWei"], null);
    assert.equal(lanes["driftLimit"], 0);
  });

  it("M3: the settings route's first-arming and re-sign notes name the arm too", async () => {
    const first = await fixture({ gridEnabled: true });
    const params = settingsWith(grid());
    const envelope = await signOwnerAction("lpSettings", params, { agentId: AGENT_ID });
    const response = await call(first.harness, `/agents/${AGENT_ID}/lp/settings`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 200);
    const evidence = (
      (response.body["data"] as Record<string, unknown>)["grid"]
    ) as Record<string, unknown>;
    assert.equal(evidence["armed"], "first");
    assert.match(String(evidence["note"]), /Sign gridArm/u);
  });
});

/* -------------------------------------------------------------------------- */
/* The authz matrix every owner route gets                                    */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16: the arm is owner-signed and reachable by nothing else", () => {
  it("refuses an unsigned request", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await call(f.harness, `/agents/${AGENT_ID}/lp/grid/arm`, {
      method: "POST",
      body: { params: armParams() },
    });
    assert.equal(response.status, 401);
  });

  it("refuses a signature made for a DIFFERENT action", async () => {
    // `paramsHash` binds the action name, so an `lpSettings` signature over the
    // same params recomputes to a different hash under `gridArm`.
    const f = await fixture({ gridEnabled: true });
    const envelope = await signOwnerAction("lpSettings", armParams(), {
      agentId: AGENT_ID,
    });
    const response = await call(f.harness, `/agents/${AGENT_ID}/lp/grid/arm`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 401);
  });

  it("refuses an unknown field on the envelope — params are hash-bound", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, { ...armParams(), preset: "standard" });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /unexpected field "preset"/u);
  });

  it("refuses a zero budget — it is the resume sentinel", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, armParams({ budgetWei: 0n }));
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /never-re-drive sentinel/u);
  });
});
