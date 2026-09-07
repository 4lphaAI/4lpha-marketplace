import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { paramsHash } from "../src/auth/canonical.js";
import type { SessionSpec } from "../src/core/types.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPoolStateReading, LpServerDeps } from "../src/server.js";
import type { SessionFacts } from "../src/store/agents.js";
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
  type Harness,
} from "./support/serverHarness.js";

const AGENT_ID = "agent-phase310";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL_A = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const POOL_B = getAddress("0xCCCCCCcCCCcCCccCcccccCcCCccCcccCcCCCccC2");
const TOKEN_2 = getAddress("0x6666666666666666666666666666666666666666");
const BUDGET = 10n ** 16n;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

function runtime(maxRankedCandidates = 1): LpRuntimeConfig {
  return {
    rankingMaxAgeSec: 300,
    maxTickWidth: 200_000,
    defaultOpenWidthTicks: 1_000,
    maxRankedCandidates,
    knownStakers: [],
    conversionCompatibleTokens: new Set(),
    resolveMinAgeSec: 1_800,
    resolveDiscriminatingMultipleBps: 12_000,
  };
}

function lpSpec(extraToken = false): SessionSpec {
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "approve(address,uint256)" },
      ...(extraToken
        ? [{ to: TOKEN_2, selector: "approve(address,uint256)" as const }]
        : []),
    ],
    spendCaps: [
      { limit: 10n ** 18n, period: "day" },
      { limit: 2n ** 160n, period: "day", token: TOKEN },
      { limit: 2n ** 160n, period: "day", token: WBNB },
      ...(extraToken
        ? [{ limit: 2n ** 160n, period: "day" as const, token: TOKEN_2 }]
        : []),
    ],
    expiresAt: NOW_SEC + 3_600,
  };
}

function facts(spec: SessionSpec): SessionFacts {
  return {
    spec,
    permissions: { calls: [], spend: [] },
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: spec.expiresAt,
  };
}

function healthyState(pool: Address): LpPoolStateReading {
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

function poolKey(token0: Address, token1: Address, fee: number): string {
  return `${token0.toLowerCase()}|${token1.toLowerCase()}|${fee}`;
}

type Fixture = {
  readonly harness: Harness;
  readonly settings: MemoryLpSettingsStore;
  readonly poolStateCalls: Address[];
};

async function fixture(options: {
  readonly factoryPool?: Address;
  readonly extraToken?: boolean;
  readonly maxRankedCandidates?: number;
} = {}): Promise<Fixture> {
  const store = new MemoryLpSequenceStore();
  const settings = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();
  const factoryPool = options.factoryPool ?? POOL_A;
  const poolStateCalls: Address[] = [];
  const lp: LpServerDeps = {
    store,
    settingsStore: settings,
    observations,
    workerIntervalMs: 60_000,
    railsResult: { ok: true, config: RAILS },
    runtime: runtime(options.maxRankedCandidates),
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    readers: {
      getPool: async (token0, token1, fee) =>
        poolKey(token0, token1, fee) === poolKey(WBNB, TOKEN, 2500)
          ? factoryPool
          : null,
      poolState: async (pool) => {
        poolStateCalls.push(pool);
        return healthyState(getAddress(pool));
      },
      positions: async (tokenId): Promise<LpPositionSnapshot | "burned"> =>
        tokenId === 777n
          ? { liquidity: 1_000n, tickLower: -500, tickUpper: 500 }
          : "burned",
      positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      ownerOf: async () => ownerAccount.address,
      quote: async (params) => params.amountInWei,
      receipts: {
        collectAmounts: async () => ({ amount0Wei: 10_000n, amount1Wei: 10_000n }),
        swapAmounts: async () => {
          throw new Error("unused");
        },
        mintedTokenId: async () => 777n,
      },
      onChainNativeDailyCapWei: async () => 10n ** 18n,
    },
  };
  const harness = await createHarness({ lp, seedAgent: false });
  await harness.agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: facts(lpSpec(options.extraToken)),
    status: "armed",
  });
  await harness.agentStore.putAgentSessionKey(
    ownerAccount.address,
    AGENT_ID,
    SESSION_KEY,
  );
  return { harness, settings, poolStateCalls };
}

function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "v3",
    source: "pancake",
    pool: POOL_A,
    token0: WBNB,
    token1: TOKEN,
    fee: 2500,
    tvlUsd: 1_000_000.25,
    volume24hUsd: 50_000.5,
    lpFeeApr24h: 10.83,
    aprSources: ["lpFee"],
    asOf: NOW_SEC * 1000,
    ...overrides,
  };
}

function envelope(
  rows: readonly unknown[],
  metaOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: rows,
    meta: {
      asOf: NOW_SEC * 1000,
      source: "pancake",
      total: rows.length,
      matched: rows.length,
      returned: rows.length,
      cap: 500,
      ingestOrder: "tvlUSD",
      ...metaOverrides,
    },
  };
}

function openParams(pool: Record<string, unknown> | undefined = undefined): Record<string, unknown> {
  return {
    ...(pool === undefined ? { selectPool: "best-apr" } : { pool }),
    range: { tickLower: -500, tickUpper: 500 },
    budgetWei: BUDGET.toString(10),
  };
}

async function postOpen(
  value: Fixture,
  params: Record<string, unknown> = openParams(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const signed = await signOwnerAction("lpOpen", params, { agentId: AGENT_ID });
  return call(value.harness, `/agents/${AGENT_ID}/lp/open`, {
    method: "POST",
    body: signed,
  });
}

function errorMessage(body: Record<string, unknown>): string {
  const error = body["error"];
  return typeof error === "object" && error !== null
    ? String((error as Record<string, unknown>)["message"])
    : "";
}

describe("Phase 3.10 live-shaped ranked route", () => {
  it("filters token/WBNB before the local cap and records the honest receipt", async () => {
    const value = await fixture({ maxRankedCandidates: 1 });
    value.harness.dataPlane.nextRankedPools = envelope([
      wireRow({
        pool: POOL_B,
        token0: TOKEN,
        token1: TOKEN_2,
        lpFeeApr24h: 999,
      }),
      wireRow(),
    ]);

    const response = await postOpen(value);
    assert.equal(response.status, 200);
    // Once for admission and once when the open saga takes its market reading.
    assert.deepEqual(value.poolStateCalls, [POOL_A, POOL_A]);
    assert.equal(
      value.harness.dataPlane.requested.includes(
        `pools/top?token=${TOKEN.toLowerCase()}` +
          "&orderBy=lpFeeApr24h&aprField=lpFeeApr24h&limit=500",
      ),
      true,
    );

    const data = response.body["data"] as Record<string, unknown>;
    const selection = data["selection"] as Record<string, unknown>;
    assert.equal(selection["laneAsOfMs"], NOW_SEC * 1000);
    assert.equal(selection["source"], "pancake");
    assert.equal(selection["matched"], 2);
    assert.equal(selection["returned"], 2);
    assert.equal(selection["cap"], 500);
    assert.equal(selection["ingestOrder"], "tvlUSD");
    assert.equal(selection["head"], POOL_A);
    assert.equal(selection["chosen"], POOL_A);
    const drops = selection["rowDropCounts"] as Record<string, unknown>;
    assert.equal(drops["outsideUniverse"], 1);
    assert.equal(drops["staleRow"], 0);
    const survivors = selection["survivors"] as Array<Record<string, unknown>>;
    assert.equal(survivors.length, 1);
    assert.deepEqual(survivors[0], {
      pool: POOL_A,
      aprBps: "1083",
      aprSource: "pancake-apr24h",
      tvlUsdE6: "1000000250000",
      volume24hUsdE6: "50000500000",
      rowAsOfMs: NOW_SEC * 1000,
    });
    assert.equal("tvlQuoteWei" in (survivors[0] ?? {}), false);
    assert.equal("volume24hQuoteWei" in (survivors[0] ?? {}), false);
  });

  it("refuses incomplete coverage before any pool-state RPC", async () => {
    const value = await fixture();
    value.harness.dataPlane.nextRankedPools = envelope([wireRow()], {
      matched: 2,
      returned: 1,
    });
    const response = await postOpen(value);
    assert.equal(response.status, 400);
    assert.match(errorMessage(response.body), /malformed/u);
    assert.deepEqual(value.poolStateCalls, []);
  });

  it("refuses a stale lane and all-stale matching rows before chain gates", async () => {
    const stale = (runtime().rankingMaxAgeSec + 1) * 1000;
    const lane = await fixture();
    lane.harness.dataPlane.nextRankedPools = envelope([wireRow()], {
      asOf: NOW_SEC * 1000 - stale,
    });
    const staleLane = await postOpen(lane);
    assert.equal(staleLane.status, 400);
    assert.match(errorMessage(staleLane.body), /stale/u);
    assert.deepEqual(lane.poolStateCalls, []);

    const row = await fixture();
    row.harness.dataPlane.nextRankedPools = envelope([
      wireRow({ asOf: NOW_SEC * 1000 - stale }),
    ]);
    const staleRow = await postOpen(row);
    assert.equal(staleRow.status, 400);
    assert.match(errorMessage(staleRow.body), /stale/u);
    assert.deepEqual(row.poolStateCalls, []);
  });

  it("drops a future row and reaches NO_SURVIVORS without a pool-state RPC", async () => {
    const value = await fixture();
    value.harness.dataPlane.nextRankedPools = envelope([
      wireRow({ asOf: NOW_SEC * 1000 + 30_001 }),
    ]);
    const response = await postOpen(value);
    assert.equal(response.status, 400);
    assert.match(errorMessage(response.body), /No candidate pool/u);
    assert.deepEqual(value.poolStateCalls, []);
  });

  it("binds ranked identity before poolState and normalizes the factory address", async () => {
    const mismatch = await fixture({ factoryPool: POOL_A });
    mismatch.harness.dataPlane.nextRankedPools = envelope([
      wireRow({ pool: POOL_B }),
    ]);
    const refused = await postOpen(mismatch);
    assert.equal(refused.status, 400);
    assert.deepEqual(mismatch.poolStateCalls, []);

    const mixed = await fixture({ factoryPool: POOL_A.toLowerCase() as Address });
    mixed.harness.dataPlane.nextRankedPools = envelope([wireRow()]);
    const accepted = await postOpen(mixed);
    assert.equal(accepted.status, 200);
    const data = accepted.body["data"] as Record<string, unknown>;
    const selection = data["selection"] as Record<string, unknown>;
    assert.equal(selection["head"], POOL_A);
    assert.equal(selection["chosen"], POOL_A);
    assert.deepEqual(mixed.poolStateCalls, [POOL_A, POOL_A]);
  });

  it("uses carried Pancake APR for the owner floor, never the old gross formula", async () => {
    const value = await fixture();
    const settingsParams = { minAprBps: 1_000 };
    await value.settings.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      params: settingsParams,
      digest: paramsHash("lpSettings", settingsParams),
    });
    value.harness.dataPlane.nextRankedPools = envelope([
      wireRow({
        lpFeeApr24h: 9,
        tvlUsd: 1,
        volume24hUsd: 1_000_000_000,
      }),
    ]);
    const response = await postOpen(value);
    assert.equal(response.status, 400);
    assert.match(errorMessage(response.body), /minAprBps/u);
    assert.equal(value.poolStateCalls.length, 1);
    assert.equal(value.harness.provider.executeCalls.length, 0);
  });

  it("refuses non-canonical discovery only for best-apr; explicit opens remain valid", async () => {
    const value = await fixture({ extraToken: true });
    value.harness.dataPlane.nextRankedPools = envelope([wireRow()]);
    const ranked = await postOpen(value);
    assert.equal(ranked.status, 400);
    assert.match(errorMessage(ranked.body), /not canonical/u);
    assert.equal(
      value.harness.dataPlane.requested.some((path) => path.startsWith("pools/top?")),
      false,
    );

    const explicit = await postOpen(
      value,
      openParams({ token0: WBNB, token1: TOKEN, fee: 2500 }),
    );
    assert.equal(explicit.status, 200);
  });
});
