import { MemoryLpFeeEventStore } from "../src/store/lpFeeEvents.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { checkHireSizing, hireSizingPreview } from "../src/ops/policy.js";
import { paramsHash } from "../src/auth/canonical.js";
import { lpSettingsParamsView, lpSettingsResponseView } from "../src/http/lpWire.js";
import { gridDeriveRanges } from "../src/lp/gridTriggers.js";
import { DEFAULT_LP_SETTINGS } from "../src/lp/triggers.js";
import type { LpPoolStateReading, LpServerDeps } from "../src/server.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import type { LpWorkerDeps } from "../src/lp/worker.js";
import type { SessionFacts } from "../src/store/agents.js";
import type { SessionSpec } from "../src/core/types.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
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

const AGENT = "lp-arm-agent";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const OTHER_POOL = getAddress("0xCCCCCCcCCCcCCccCcccccCcCCccCcccCcCCCccC2");
const OTHER_TOKEN = getAddress("0x6666666666666666666666666666666666666666");
const BUDGET = 10n ** 16n;

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

function poolKey(token0: Address, token1: Address, fee: number): string {
  return `${token0.toLowerCase()}|${token1.toLowerCase()}|${fee}`;
}

function state(pool: Address): LpPoolStateReading {
  return {
    pool,
    tickSpacing: 50,
    currentTick: 0,
    evidence: {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 24n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: 2n ** 96n,
      twapSqrtPriceX96: 2n ** 96n,
    },
  };
}

function spec(expiresAt: number): SessionSpec {
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

function facts(profile: "lp-v1" | "grid-v1" | "trade-v1"): SessionFacts {
  return {
    spec: spec(NOW_SEC + 3_600),
    permissions: { calls: [], spend: [] },
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: NOW_SEC + 3_600,
    hireSizing: { name: profile, version: 1, openNativeBudgetWei: BUDGET.toString(10) },
  };
}

type Fixture = {
  readonly harness: Harness;
  readonly store: MemoryLpSequenceStore;
  readonly settings: MemoryLpSettingsStore;
  readonly observations: MemoryLpObservationStore;
  readonly feeEvents: MemoryLpFeeEventStore;
  readonly pools: Map<string, Address>;
  readonly states: Map<string, LpPoolStateReading>;
  readonly brainTransportCalls: Parameters<NonNullable<LpWorkerDeps["brainTransport"]>>[];
};

async function fixture(options: {
  readonly profile?: "lp-v1" | "grid-v1" | "trade-v1";
  readonly settings?: MemoryLpSettingsStore;
  readonly store?: MemoryLpSequenceStore;
  readonly receiptReaderUnwired?: boolean;
} = {}): Promise<Fixture> {
  const store = options.store ?? new MemoryLpSequenceStore();
  const settings = options.settings ?? new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();
  const feeEvents = new MemoryLpFeeEventStore();
  const pools = new Map<string, Address>();
  const states = new Map<string, LpPoolStateReading>();
  const brainTransportCalls: Parameters<NonNullable<LpWorkerDeps["brainTransport"]>>[] = [];
  const brainTransport: NonNullable<LpWorkerDeps["brainTransport"]> = async (...args) => {
    brainTransportCalls.push(args);
    return { holdInstead: true };
  };
  let positions: (tokenId: bigint) => Promise<LpPositionSnapshot | "burned"> = async () => "burned";
  const lp = {
    feeEvents,
    store,
    settingsStore: settings,
    observations,
    workerIntervalMs: 60_000,
    railsResult: { ok: true, config: RAILS },
    runtime: RUNTIME,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    readers: {
      getPool: async (token0, token1, fee) => pools.get(poolKey(token0, token1, fee)) ?? null,
      poolState: async (pool) => {
        const found = states.get(pool.toLowerCase());
        if (found === undefined) throw new Error("missing pool state");
        return found;
      },
      positions: (tokenId) => positions(tokenId),
      positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      ownerOf: async () => ownerAccount.address,
      quote: async (params) => params.amountInWei,
      receipts: {
        ...(options.receiptReaderUnwired ? {} : { feeEvents: async () => { throw new Error("read route must never read fee receipts"); } }),
        collectAmounts: async () => ({ amount0Wei: 1n, amount1Wei: 1n }),
        swapAmounts: async () => ({ tokenIn: WBNB, amountInWei: 1n, tokenOut: TOKEN, amountOutWei: 1n }),
        mintedTokenId: async () => 777n,
      },
      onChainNativeDailyCapWei: async () => 10n ** 18n,
    },
    // Deliberately worker-shaped: the HTTP arm/open boundary must never invoke
    // this transport even when the persisted settings enable the brain.
    brainTransport,
  } satisfies LpServerDeps & { readonly brainTransport: NonNullable<LpWorkerDeps["brainTransport"]> };
  const harness = await createHarness({ lp, seedAgent: false });
  const profile = options.profile ?? "lp-v1";
  await harness.agentStore.createAgent({
    id: AGENT,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: facts(profile),
    status: "armed",
    httpRuntimeProfile: profile === "trade-v1" ? "unbound-v1" : "lp-v1",
  });
  await harness.agentStore.putAgentSessionKey(ownerAccount.address, AGENT, SESSION_KEY);
  pools.set(poolKey(WBNB, TOKEN, 2500), POOL);
  states.set(POOL.toLowerCase(), state(POOL));
  positions = async (tokenId) => tokenId === 777n
    ? { liquidity: 1_000n, tickLower: -500, tickUpper: 500 }
    : "burned";
  return { harness, store, settings, observations, feeEvents, pools, states, brainTransportCalls };
}

const LP_PROFILE_SETTINGS = { autoRotate: true, rotateMinHoldMinutes: 5 } as const;

function armParams(settings: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    settings: { ...LP_PROFILE_SETTINGS, ...settings },
    budgetWei: BUDGET.toString(10),
    pool: { token0: WBNB, token1: TOKEN, fee: 2500 },
    range: { tickLower: -500, tickUpper: 500 },
    ...overrides,
  };
}

async function post(harness: Harness, action: "lpArm" | "lpSettings", params: unknown) {
  const envelope = await signOwnerAction(action, params, { agentId: AGENT });
  const suffix = action === "lpArm" ? "arm" : "settings";
  return call(harness, `/agents/${AGENT}/lp/${suffix}`, { method: "POST", body: envelope });
}

describe("lp-v1 sizing and arm parser", () => {
  it("accepts the exact preview minimum and reports a one-wei shortfall", () => {
    const preview = hireSizingPreview({ sizingPreset: "lp-v1", openNativeBudgetWei: BUDGET });
    const minimum = BigInt(preview.minimumCapDayWei);
    assert.equal(checkHireSizing({ sizingPreset: "lp-v1", openNativeBudgetWei: BUDGET, capDayWei: minimum }).ok, true);
    const short = checkHireSizing({ sizingPreset: "lp-v1", openNativeBudgetWei: BUDGET, capDayWei: minimum - 1n });
    assert.equal(short.ok, false);
    assert.equal(short.kind, "shortfall");
    assert.equal(short.shortfallWei, 1n);
  });

  it("strictly rejects missing/both pool selectors and nonpositive budgets", async () => {
    const f = await fixture();
    assert.equal((await post(f.harness, "lpArm", armParams({}, { pool: undefined }))).status, 400);
    assert.equal((await post(f.harness, "lpArm", armParams({}, { selectPool: { by: "fee-apr", window: "24h" } }))).status, 400);
    assert.equal((await post(f.harness, "lpArm", armParams({}, { budgetWei: "0" }))).status, 400);
    assert.equal((await post(f.harness, "lpArm", armParams({}, { unexpected: true }))).status, 400);
    assert.equal((await post(f.harness, "lpArm", armParams({}, {
      pool: undefined, selectPool: { by: "fee-apr", window: "7d" }, range: "server-fenced",
    }))).status, 400);
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("refuses out-of-domain, narrower-than-two-spacings, and wider-than-runtime explicit ranges", async () => {
    for (const range of [
      { tickLower: -887_300, tickUpper: -887_200 },
      { tickLower: -50, tickUpper: 0 },
      { tickLower: -100_050, tickUpper: 100_050 },
    ]) {
      const f = await fixture();
      const response = await post(f.harness, "lpArm", armParams({}, { range }));
      assert.equal(response.status, 400, JSON.stringify(range));
      assert.equal(f.harness.provider.executeCalls.length, 0);
    }
  });
});

describe("lpArm fenced route", () => {
  it("never invokes a worker-shaped brain transport from HTTP arm or open", async () => {
    const brain = {
      primaryModel: "0gm-1.0-35b-a3b" as const,
      fallbackModel: "qwen3-vl-30b" as const,
      instructions: null,
      skillMarkdown: null,
    };

    const armed = await fixture();
    const armResponse = await post(armed.harness, "lpArm", armParams(
      { brainEnabled: true, brain },
      { range: "server-fenced" },
    ));
    assert.equal(armResponse.status, 200, armResponse.text);
    assert.equal(armed.brainTransportCalls.length, 0);

    const opened = await fixture();
    const settingsParams = lpSettingsParamsView({
      ...DEFAULT_LP_SETTINGS,
      ...LP_PROFILE_SETTINGS,
      brainEnabled: true,
      brain,
    });
    await opened.settings.put({
      ownerAddress: ownerAccount.address,
      agentId: AGENT,
      params: settingsParams,
      digest: paramsHash("lpSettings", settingsParams),
    });
    const openParams = {
      pool: { token0: WBNB, token1: TOKEN, fee: 2500 },
      range: "server-fenced",
      budgetWei: BUDGET.toString(10),
    };
    const openEnvelope = await signOwnerAction("lpOpen", openParams, { agentId: AGENT });
    const openResponse = await call(opened.harness, `/agents/${AGENT}/lp/open`, {
      method: "POST",
      body: openEnvelope,
    });
    assert.equal(openResponse.status, 200, openResponse.text);
    assert.equal(opened.brainTransportCalls.length, 0);
  });

  it("serializes two arms synchronized after the first empty snapshot but before its insert", async () => {
    class PausedAdmissionStore extends MemoryLpSequenceStore {
      readonly firstSnapshotRead: Promise<void>;
      #markSnapshotRead!: () => void;
      #releaseFirst!: () => void;
      readonly #resumeFirst: Promise<void>;
      #paused = false;

      constructor() {
        super();
        this.firstSnapshotRead = new Promise<void>((resolve) => {
          this.#markSnapshotRead = resolve;
        });
        this.#resumeFirst = new Promise<void>((resolve) => {
          this.#releaseFirst = resolve;
        });
      }

      releaseFirst(): void {
        this.#releaseFirst();
      }

      override async listPositions(ownerAddress: Address, agentId: string) {
        const snapshot = await super.listPositions(ownerAddress, agentId);
        if (!this.#paused) {
          this.#paused = true;
          this.#markSnapshotRead();
          await this.#resumeFirst;
        }
        return snapshot;
      }
    }

    const store = new PausedAdmissionStore();
    const f = await fixture({ store });
    let release!: () => void;
    const secondStarted = new Promise<void>((resolve) => { release = resolve; });
    const firstEnvelope = await signOwnerAction("lpArm", armParams(), { agentId: AGENT });
    const secondEnvelope = await signOwnerAction("lpArm", armParams(), { agentId: AGENT });
    const first = call(f.harness, `/agents/${AGENT}/lp/arm`, { method: "POST", body: firstEnvelope });
    await store.firstSnapshotRead;
    const second = call(f.harness, `/agents/${AGENT}/lp/arm`, { method: "POST", body: secondEnvelope });
    release();
    await secondStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    store.releaseFirst();
    const [landed, refused] = await Promise.all([first, second]);
    assert.deepEqual([landed.status, refused.status].sort((a, b) => a - b), [200, 400]);
    assert.equal(
      (landed.body as { data: { open: { status: string } } }).data.open.status,
      "completed",
    );
    assert.match(JSON.stringify(refused.body), /already holds 1 non-closed LP position/u);
    assert.equal(f.harness.provider.executeCalls.length, 1);
  });

  it("stores settings before inserting/executing and leaves no row if that step fails", async () => {
    class RefusingSettings extends MemoryLpSettingsStore {
      override async put(_input: Parameters<MemoryLpSettingsStore["put"]>[0]): Promise<never> {
        throw new Error("settings write refused");
      }
    }
    const f = await fixture({ settings: new RefusingSettings() });
    const response = await post(f.harness, "lpArm", armParams());
    assert.equal(response.status, 500);
    assert.equal((await f.store.listPositions(ownerAccount.address, AGENT)).length, 0);
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("rolls back with SETTINGS_DIGEST_MISMATCH when settings change after insert but before open", async () => {
    const settings = new MemoryLpSettingsStore();
    class MutatingInsertStore extends MemoryLpSequenceStore {
      override async createPosition(input: Parameters<MemoryLpSequenceStore["createPosition"]>[0]) {
        const created = await super.createPosition(input);
        if (input.armMeta !== undefined) {
          await settings.put({
            ownerAddress: input.ownerAddress,
            agentId: input.agentId,
            params: LP_PROFILE_SETTINGS,
            digest: `0x${"00".repeat(32)}`,
          });
        }
        return created;
      }
    }
    const f = await fixture({ store: new MutatingInsertStore(), settings });
    const response = await post(f.harness, "lpArm", armParams());
    assert.equal(response.status, 200, response.text);
    const open = (response.body as { data: { open: Record<string, unknown> } }).data.open;
    assert.equal(open["status"], "rolled-back");
    assert.equal(open["code"], "SETTINGS_DIGEST_MISMATCH");
    assert.equal(f.harness.provider.executeCalls.length, 0);
    assert.equal((await f.store.listPositions(ownerAccount.address, AGENT))[0]?.state, "closed");
  });

  it("refuses an arm when a closed position still has a non-terminal sequence", async () => {
    const f = await fixture();
    const position = await f.store.createPosition({
      positionId: "closed-with-sequence", agentId: AGENT, ownerAddress: ownerAccount.address,
      token0: WBNB, token1: TOKEN, fee: 2500, basisWei: BUDGET,
    });
    await f.store.createSequence({
      positionId: position.positionId, agentId: AGENT, ownerAddress: ownerAccount.address, kind: "rotate",
    });
    await f.store.setPositionState(ownerAccount.address, AGENT, position.positionId, "closed");
    const response = await post(f.harness, "lpArm", armParams());
    assert.equal(response.status, 400, response.text);
    assert.match(JSON.stringify(response.body), /non-terminal rotate sequence/u);
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("binds the granted token on explicit and ranked-selection paths", async () => {
    const explicit = await fixture();
    explicit.pools.set(poolKey(WBNB, OTHER_TOKEN, 2500), OTHER_POOL);
    explicit.states.set(OTHER_POOL.toLowerCase(), state(OTHER_POOL));
    const explicitResponse = await post(explicit.harness, "lpArm", armParams({}, {
      pool: { token0: WBNB, token1: OTHER_TOKEN, fee: 2500 },
    }));
    assert.equal(explicitResponse.status, 400);

    const sigma = await fixture();
    sigma.pools.set(poolKey(WBNB, OTHER_TOKEN, 2500), OTHER_POOL);
    sigma.states.set(OTHER_POOL.toLowerCase(), state(OTHER_POOL));
    sigma.harness.dataPlane.nextRankedPools = {
      data: [{ pool: OTHER_POOL, protocol: "v3", token0: WBNB, token1: OTHER_TOKEN, fee: 2500,
        tvlUsd: 1_000_000, volume24hUsd: 500_000, lpFeeApr24h: 20, aprSources: ["lpFee"],
        asOf: NOW_SEC * 1_000, source: "pancake" }],
      meta: { total: 1, matched: 1, returned: 1, cap: 500, ingestOrder: "tvlUSD",
        orderBy: "lpFeeApr24h", asOf: NOW_SEC * 1_000, source: "pancake" },
    };
    const rankedResponse = await post(sigma.harness, "lpArm", armParams({}, {
      pool: undefined,
      selectPool: { by: "fee-apr", window: "24h" },
      range: "server-fenced",
    }));
    assert.equal(rankedResponse.status, 400);
    assert.equal(sigma.harness.provider.executeCalls.length, 0);
  });
});

describe("lp-v1 profile equality on both settings and arm", () => {
  const brain = { primaryModel: "0gm-1.0-35b-a3b", fallbackModel: "qwen3-vl-30b", instructions: null, skillMarkdown: null };
  const ranges = gridDeriveRanges({ currentTick: 0, tickSpacing: 50, gapTicks: 500, widthTicks: 500,
    wbnbIsToken0: true, minTick: -887_272, maxTick: 887_272 });
  const grid = { pool: { token0: WBNB, token1: TOKEN, fee: 2500 }, wbnbIsToken0: true, tickSpacing: 50,
    ...ranges, maxFlipsPerDay: 1, minNetEdgeBps: 0, mode: "fixed" };
  const violations: readonly Record<string, unknown>[] = [
    { grid },
    { autoRotate: false },
    { maxExitSequencesPerDay: 5 },
    // Operator ruling 2026-09-06: the lp-v1 cooldown floor is 3 minutes.
    { rotateMinHoldMinutes: 2 },
    { brainEnabled: true },
    { brainEnabled: false, brain },
  ];

  it("refuses every profile violation on lpSettings and lpArm, including both sides of the brain equality", async () => {
    for (const settings of violations) {
      const settingsFixture = await fixture();
      const settingsResponse = await post(settingsFixture.harness, "lpSettings", { ...LP_PROFILE_SETTINGS, ...settings });
      assert.equal(settingsResponse.status, 400, JSON.stringify(settings));
      const armFixture = await fixture();
      const armResponse = await post(armFixture.harness, "lpArm", armParams(settings));
      assert.equal(armResponse.status, 400, JSON.stringify(settings));
      assert.equal(armFixture.harness.provider.executeCalls.length, 0);
    }
    const budgetFixture = await fixture();
    const overBudget = await post(budgetFixture.harness, "lpArm", armParams({}, { budgetWei: (BUDGET + 1n).toString(10) }));
    assert.equal(overBudget.status, 400);
  });

  it("does not apply the lp-v1 equality rule to grid or trade hires", async () => {
    for (const profile of ["grid-v1", "trade-v1"] as const) {
      const f = await fixture({ profile });
      const params = { brainEnabled: true };
      const response = await post(f.harness, "lpSettings", params);
      assert.equal(response.status, 200, profile);
      const stored = await f.settings.get(ownerAccount.address, AGENT);
      assert.deepEqual(stored?.params, params, profile);
      const envelope = await signOwnerAction("read", { scope: "agent", agentId: AGENT }, { agentId: AGENT });
      const ownerView = await call(f.harness, `/agents/${AGENT}/lp`, {
        headers: { "x-owner-action": toReadHeader(envelope) },
      });
      assert.equal((ownerView.body as { data: { lp?: unknown } }).data.lp, undefined, profile);
    }
  });
});

describe("lp-v1 owner response projection", () => {
  const brain = {
    primaryModel: "0gm-1.0-35b-a3b" as const,
    fallbackModel: "qwen3-vl-30b" as const,
    instructions: "owner-only instructions",
    skillMarkdown: "owner-only skill markdown",
  };

  async function readLp(harness: Harness) {
    const envelope = await signOwnerAction(
      "read",
      { scope: "agent", agentId: AGENT },
      { agentId: AGENT },
    );
    return call(harness, `/agents/${AGENT}/lp`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
  }

  it("keeps canonical brain text while HTTP views expose only models and byte counts", () => {
    const settings = { ...DEFAULT_LP_SETTINGS, brainEnabled: true, brain };
    const canonical = lpSettingsParamsView(settings);
    const response = lpSettingsResponseView(settings);
    assert.match(JSON.stringify(canonical), /owner-only instructions/u);
    assert.doesNotMatch(JSON.stringify(response), /owner-only instructions|owner-only skill markdown/u);
    assert.deepEqual(response["brain"], {
      primaryModel: brain.primaryModel,
      fallbackModel: brain.fallbackModel,
      instructionsBytes: 25,
      skillMarkdownBytes: 27,
    });
  });

  it("projects byte counts rather than owner text from the lpSettings route", async () => {
    const f = await fixture();
    const response = await post(f.harness, "lpSettings", {
      ...LP_PROFILE_SETTINGS,
      brainEnabled: true,
      brain,
    });
    assert.equal(response.status, 200, response.text);
    assert.doesNotMatch(JSON.stringify(response.body), /owner-only instructions|owner-only skill markdown/u);
    const settings = (response.body as { data: { settings: Record<string, unknown> } }).data.settings;
    assert.deepEqual(settings["brain"], {
      primaryModel: brain.primaryModel,
      fallbackModel: brain.fallbackModel,
      instructionsBytes: 25,
      skillMarkdownBytes: 27,
    });
  });

  it("reports canonical pool facts and rejects a live range from a prior token id", async () => {
    const f = await fixture();
    const armed = await post(f.harness, "lpArm", armParams({ brainEnabled: true, brain }));
    assert.equal(armed.status, 200, armed.text);
    const [position] = await f.store.listPositions(ownerAccount.address, AGENT);
    assert.notEqual(position, undefined);
    const expectedPool = getCreate2Address({
      from: getAddress("0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9"),
      salt: keccak256(encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }],
        [WBNB, TOKEN, 2500],
      )),
      bytecodeHash: "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2",
    });
    const observation = {
      blockNumber: 100n,
      evaluatedAtMs: NOW_SEC * 1_000,
      poolAddress: POOL,
      currentTick: 0,
      tickLower: -450,
      tickUpper: 550,
      protectConsecutive: 0,
      rotationBreach: false,
      rotationConsecutive: 0,
      tokenId: "777",
      valuation: {
        method: "sellable-exit-v1" as const,
        exitValueWei: BUDGET,
        quoteToken: WBNB,
        tokenId: "778",
        positionRowVersion: position!.rowVersion,
        blockNumber: 100n,
        valuedAtMs: NOW_SEC * 1_000,
      },
    };
    await f.observations.put({
      ownerAddress: ownerAccount.address,
      agentId: AGENT,
      positionId: position!.positionId,
      observation,
    });
    const stale = await readLp(f.harness);
    assert.equal(stale.status, 200, stale.text);
    const staleLp = (stale.body as { data: { lp: Record<string, unknown> } }).data.lp;
    assert.equal(staleLp["range"], null);
    assert.equal(staleLp["rangeReason"], "observation is for a prior position version");
    assert.deepEqual(staleLp["pool"], {
      token0: WBNB,
      token1: TOKEN,
      fee: 2500,
      poolAddress: expectedPool,
      wbnbIsToken0: WBNB.toLowerCase() === WBNB.toLowerCase(),
      tickSpacing: 50,
    });
    assert.doesNotMatch(JSON.stringify(stale.body), /owner-only instructions|owner-only skill markdown/u);

    await f.observations.put({
      ownerAddress: ownerAccount.address,
      agentId: AGENT,
      positionId: position!.positionId,
      observation: { ...observation, valuation: { ...observation.valuation, tokenId: position!.tokenId! } },
    });
    const current = await readLp(f.harness);
    const currentLp = (current.body as { data: { lp: Record<string, unknown> } }).data.lp;
    assert.deepEqual(currentLp["range"], { tickLower: -450, tickUpper: 550, asOfMs: NOW_SEC * 1_000 });
  });


  it("LP detail: redaction matrix, both cadence branches, known/unknown coverage and no route receipt reads",async()=>{
    const f=await fixture();
    const unarmed=await readLp(f.harness);assert.equal((unarmed.body as {data:{lp:{workerIntervalMs:number}}}).data.lp.workerIntervalMs,60000);
    const settingsResponse=await post(f.harness,"lpSettings",{...LP_PROFILE_SETTINGS,brainEnabled:true,brain});
    const armed=await post(f.harness,"lpArm",armParams({brainEnabled:true,brain}));assert.equal(armed.status,200,armed.text);
    const [p]=await f.store.listPositions(ownerAccount.address,AGENT);assert.ok(p);
    const observation={blockNumber:100n,evaluatedAtMs:NOW_SEC*1000,poolAddress:POOL,currentTick:0,tokenId:p.tokenId!,protectConsecutive:0,rotationBreach:false,rotationConsecutive:0,
      fees:{collectible0Wei:3n,collectible1Wei:4n,blockNumber:100n,tokenId:p.tokenId!,positionRowVersion:p.rowVersion,asOfMs:NOW_SEC*1000}};
    await f.observations.put({ownerAddress:ownerAccount.address,agentId:AGENT,positionId:p.positionId,observation});
    const before=await readLp(f.harness);const data=(before.body as {data:{positions:Record<string,unknown>[];lp:Record<string,unknown>}}).data;
    assert.equal(data.lp["workerIntervalMs"],60000);assert.equal((data.positions[0]!["feeCoverage"] as {status:string}).status,"complete");
    const sequence=await f.store.createSequence({ownerAddress:ownerAccount.address,agentId:AGENT,positionId:p.positionId,kind:"harvest"});
    const key="fee-coverage-history";await f.store.appendStep(ownerAccount.address,AGENT,sequence.sequenceId,{kind:"collect-fees",journalIdempotencyKey:key});
    await f.harness.journal.begin({idempotencyKey:key,agentId:AGENT,ownerAddress:ownerAccount.address,kind:"lp",decisionId:key,nativeSpendWei:0n});
    await f.harness.journal.markCommitted(key,{txHash:`0x${"dd".repeat(32)}`});
    const missing=await readLp(f.harness);assert.equal(((missing.body as {data:{positions:{feeCoverage:{status:string;missing:number}}[]}}).data.positions[0]!.feeCoverage).missing,1);
    await f.feeEvents.recordReceipt([{ ownerAddress: ownerAccount.address, agentId: AGENT, positionId: p.positionId, lineageId: p.lineageId,
      sequenceId: sequence.sequenceId, journalIdempotencyKey: key, stepIndex: 0, kind: "harvest", tokenId: p.tokenId!,
      txHash: `0x${"dd".repeat(32)}`, blockNumber: 100n, collected0Wei: 2n, collected1Wei: 3n, decreased0Wei: 0n, decreased1Wei: 0n,
      realised0Wei: 2n, realised1Wei: 3n, status: "recorded", reason: null, recordedAtMs: NOW_SEC * 1000, receiptTokenIds: [p.tokenId!] }]);
    const recorded = await readLp(f.harness);
    const event = (recorded.body as { data: { positions: { feeEvents: Record<string, unknown>[] }[] } }).data.positions[0]!.feeEvents[0]!;
    assert.deepEqual(Object.keys(event).sort(), ["positionId", "lineageId", "sequenceId", "journalIdempotencyKey", "stepIndex", "kind", "tokenId", "txHash", "blockNumber",
      "collected0Wei", "collected1Wei", "decreased0Wei", "decreased1Wei", "realised0Wei", "realised1Wei", "status", "reason", "recordedAtMs"].sort());
    assert.equal(event["blockNumber"], "100");
    assert.equal(event["realised0Wei"], "2");
    const envelope=await signOwnerAction("read",{scope:"agent",agentId:AGENT},{agentId:AGENT});
    const ownerView=await call(f.harness,`/agents/${AGENT}/owner-view`,{headers:{"x-owner-action":toReadHeader(envelope)}});
    for(const response of [settingsResponse,armed,before,missing,ownerView]){
      assert.doesNotMatch(JSON.stringify(response.body),/owner-only instructions|owner-only skill markdown|"instructions"|"skillMarkdown"/u);
    }
  });

  it("LP detail distinguishes an unwired receipt reader from a fee-store read failure", async () => {
    for (const receiptReaderUnwired of [true, false]) {
      const f = await fixture({ receiptReaderUnwired });
      const armed = await post(f.harness, "lpArm", armParams());
      assert.equal(armed.status, 200, armed.text);
      f.feeEvents.snapshot = async () => { throw new TypeError("private store details"); };
      const response = await readLp(f.harness);
      const coverage = (response.body as { data: { positions: { feeCoverage: { status: string; reason: string } }[] } }).data.positions[0]!.feeCoverage;
      assert.equal(coverage.status, "unavailable");
      assert.equal(coverage.reason, receiptReaderUnwired ? "fee receipt reader unwired" : "fee store unavailable (TypeError)");
    }
  });

  it("returns no settings and the exact worker-skip reason for an untrusted digest", async () => {
    const f = await fixture();
    await f.settings.put({
      ownerAddress: ownerAccount.address,
      agentId: AGENT,
      params: { ...LP_PROFILE_SETTINGS },
      digest: `0x${"ab".repeat(32)}`,
    });
    const response = await readLp(f.harness);
    assert.equal(response.status, 200, response.text);
    const lp = (response.body as { data: { lp: Record<string, unknown> } }).data.lp;
    assert.equal(lp["settingsTrusted"], false);
    assert.equal(lp["settingsReason"], "settings digest unverified; worker skips this agent");
    assert.equal(lp["settings"], null);
  });

  it("reports the exact deterministic-range reason for a trusted legacy brainEnabled row", async () => {
    const f = await fixture();
    const params = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, brainEnabled: true });
    await f.settings.put({
      ownerAddress: ownerAccount.address,
      agentId: AGENT,
      params,
      digest: paramsHash("lpSettings", params),
    });
    const response = await readLp(f.harness);
    const lp = (response.body as { data: { lp: Record<string, unknown> } }).data.lp;
    assert.equal(lp["settingsTrusted"], true);
    assert.equal(lp["settingsReason"], "brainEnabled without a model; deterministic ranges");
    assert.equal((lp["settings"] as { brain: unknown }).brain, null);
  });

  it("derives from arm metadata without any sequence/journal row, and a blank metadata row is not armed", async () => {
    const armed = await fixture();
    await armed.store.createPosition({
      positionId: "metadata-only", agentId: AGENT, ownerAddress: ownerAccount.address,
      token0: WBNB, token1: TOKEN, fee: 2500, basisWei: BUDGET,
      armMeta: {
        action: "lpArm", model: "custom", range: { source: "explicit", tickLower: -500, tickUpper: 500 },
        selectPool: null, selection: null, budgetWei: BUDGET.toString(10),
      },
    });
    assert.equal((await armed.store.listSequences(ownerAccount.address, AGENT)).length, 0);
    assert.equal((await armed.harness.journal.listNonTerminal()).length, 0);
    const metadataView = await readLp(armed.harness);
    assert.equal((metadataView.body as { data: { lp: { model: unknown } } }).data.lp.model, "custom");

    const blank = await fixture();
    await blank.store.createPosition({
      positionId: "blank-metadata", agentId: AGENT, ownerAddress: ownerAccount.address,
      token0: WBNB, token1: TOKEN, fee: 2500, basisWei: BUDGET,
    });
    const blankView = await readLp(blank.harness);
    const lp = (blankView.body as { data: { lp: Record<string, unknown> } }).data.lp;
    assert.equal(lp["model"], null);
    assert.equal(lp["reason"], "not armed yet");
  });
});
