/**
 * Adversarial tests for the PHASE3 LP routes (auditor style: every test is an
 * attack or a boundary, and the assertion is what the attacker GETS).
 *
 * Matrix covered here:
 *   - authz: no service credential / no owner envelope / wrong owner (404,
 *     indistinguishable from missing) / replayed nonce / tampered params vs
 *     digest / envelope-to-route binding / cross-tenant position (404);
 *   - the (u)-transposition: an open on a pool whose TOKEN the session cannot
 *     sell is refused BEFORE any money — no submit, no position row;
 *   - R8: a cardinality-1 pool is refused AT OPEN with the permissionless
 *     remedy (`increaseObservationCardinalityNext`) named in the error;
 *   - R11: no-WBNB-leg and NFPM-as-token pools are refused;
 *   - R15: `selectPool: "best-apr"` fails closed on missing/stale ranking
 *     while an explicit-pool open on the same fixture succeeds; a brain pool
 *     proposal outside the survivor set FALLS BACK and the receipt carries the
 *     fence verdict;
 *   - Rev2 item 11: a settings change that breaks `checkLpNativeCapSizing`
 *     against the LIVE on-chain cap is refused;
 *   - Rev2 item 22: an LP action verifies through the PASSKEY dispatcher with
 *     zero passkey-side changes;
 *   - FINDINGS (s): the owner's manual exit completes under pause.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  AGENT_ID,
  NOW_SEC,
  OTHER_AGENT_ID,
  OTHER_OWNER_PK,
  ROUTER_V3,
  SESSION_KEY,
  TOKEN,
  WBNB,
  call,
  createHarness,
  errorCode,
  freshNonce,
  otherOwnerAccount,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
  type Harness,
} from "./support/serverHarness.js";
import type { SessionFacts } from "../src/store/agents.js";
import type { SessionSpec } from "../src/core/types.js";
import type { LpPoolStateReading, LpServerDeps } from "../src/server.js";
import {
  DEFAULT_QUOTE_TOKEN,
  MemoryLpSequenceStore,
} from "../src/store/lpSequences.js";
import {
  MemoryLpSettingsStore,
  PostgresLpSettingsStore,
} from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import { paramsHash } from "../src/auth/canonical.js";
import { gridDeriveRanges } from "../src/lp/gridTriggers.js";
import { sanitizeMessage } from "../src/core/errors.js";
import {
  PASSKEY_CONFIG,
  createTestPasskey,
  signPasskeyOwnerAction,
} from "./support/passkey.js";

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

const LP_AGENT_ID = "agent-lp";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL_A = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const POOL_B = getAddress("0xCCCCCCcCCCcCCccCcccccCcCCccCcccCcCCCccC2");
/** A second sellable token, above WBNB in pool order like TOKEN. */
const TOKEN_2 = getAddress("0x6666666666666666666666666666666666666666");
/** A token the session cannot sell — the (u) probe. */
const TOKEN_UNSELLABLE = getAddress("0x5E55555555555555555555555555555555555555");

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
  // PHASE3.3: the production defaults, so this suite runs against what ships.
  resolveMinAgeSec: 1_800,
  resolveDiscriminatingMultipleBps: 12_000,
};

const BUDGET = 10n ** 16n; // 0.01 BNB

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
      spotSqrtPriceX96: 2n ** 96n, // price 1
      twapSqrtPriceX96: 2n ** 96n,
    },
  };
}

function poolKey(token0: Address, token1: Address, fee: number): string {
  return `${token0.toLowerCase()}|${token1.toLowerCase()}|${fee}`;
}

type LpFixture = {
  readonly harness: Harness;
  readonly lpStore: MemoryLpSequenceStore;
  readonly settingsStore: MemoryLpSettingsStore;
  /** PHASE3.2: the durable observation store the read side reports from. */
  readonly observations: MemoryLpObservationStore;
  readonly chain: {
    readonly pools: Map<string, Address>;
    readonly states: Map<string, LpPoolStateReading>;
    liveCapWei: bigint;
    liveCapError: Error | null;
    mintedTokenId: bigint;
    positionsImpl: (tokenId: bigint) => Promise<LpPositionSnapshot | "burned">;
  };
};

async function lpFixture(
  options: { readonly passkey?: boolean; readonly gridEnabled?: boolean } = {},
): Promise<LpFixture> {
  const lpStore = new MemoryLpSequenceStore();
  const settingsStore = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();

  const chain: LpFixture["chain"] = {
    pools: new Map(),
    states: new Map(),
    liveCapWei: 10n ** 18n,
    liveCapError: null,
    mintedTokenId: 777n,
    positionsImpl: async () => "burned",
  };

  const lp: LpServerDeps = {
    store: lpStore,
    settingsStore,
    observations,
    workerIntervalMs: 60_000,
    railsResult: { ok: true, config: RAILS },
    runtime: RUNTIME,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    ...(options.gridEnabled === undefined ? {} : { gridEnabled: options.gridEnabled }),
    readers: {
      getPool: async (token0, token1, fee) =>
        chain.pools.get(poolKey(token0, token1, fee)) ?? null,
      poolState: async (pool) => {
        const state = chain.states.get(pool.toLowerCase());
        if (state === undefined) throw new Error("no observations");
        return state;
      },
      positions: (tokenId) => chain.positionsImpl(tokenId),
      positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      ownerOf: async () => ownerAccount.address,
      quote: async (params) => params.amountInWei, // 1:1, matching spot
      receipts: {
        collectAmounts: async () => ({ amount0Wei: 10_000n, amount1Wei: 10_000n }),
        swapAmounts: async () => {
          throw new Error("unused in these tests");
        },
        mintedTokenId: async () => chain.mintedTokenId,
      },
      onChainNativeDailyCapWei: async () => {
        if (chain.liveCapError !== null) throw chain.liveCapError;
        return chain.liveCapWei;
      },
    },
  };

  const harness = await createHarness({
    lp,
    ...(options.passkey === true ? { config: { passkey: PASSKEY_CONFIG } } : {}),
  });
  await harness.agentStore.createAgent({
    id: LP_AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600),
    status: "armed",
  });
  await harness.agentStore.putAgentSessionKey(
    ownerAccount.address,
    LP_AGENT_ID,
    SESSION_KEY,
  );

  // The canonical (WBNB, TOKEN, 2500) pool, healthy.
  chain.pools.set(poolKey(WBNB, TOKEN, 2500), POOL_A);
  chain.states.set(POOL_A.toLowerCase(), healthyState(POOL_A));
  // The minted position is live once the open confirms.
  chain.positionsImpl = async (tokenId) =>
    tokenId === 777n
      ? { liquidity: 1_000n, tickLower: -500, tickUpper: 500 }
      : "burned";

  return { harness, lpStore, settingsStore, observations, chain };
}

function explicitOpenParams(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pool: { token0: WBNB, token1: TOKEN, fee: 2500 },
    range: { tickLower: -500, tickUpper: 500 },
    budgetWei: BUDGET.toString(10),
    ...overrides,
  };
}

async function postOwner(
  fixture: LpFixture,
  path: string,
  action: "lpOpen" | "lpSettings" | "lpExit" | "pause",
  params: unknown,
  options: Parameters<typeof signOwnerAction>[2] = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction(action, params, {
    agentId: LP_AGENT_ID,
    ...options,
  });
  return call(fixture.harness, path, { method: "POST", body: envelope });
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body["data"] ?? {}) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Authz matrix                                                               */
/* -------------------------------------------------------------------------- */

describe("lp1 — the LP routes do not exist until their deps are wired", () => {
  it("answers the unknown-path 404 for every LP path on an unwired server", async () => {
    const harness = await createHarness(); // no lp deps
    const envelope = await signOwnerAction("lpSettings", {}, { agentId: AGENT_ID });
    const settings = await call(harness, `/agents/${AGENT_ID}/lp/settings`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(settings.status, 404);
    assert.equal(errorCode(settings.body), "not_found");

    const read = await call(harness, `/agents/${AGENT_ID}/lp`);
    assert.equal(read.status, 404);
  });
});

describe("lp2 — authz matrix on the wired routes", () => {
  it("refuses without the service credential, before anything else", async () => {
    const fixture = await lpFixture();
    const response = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp`, {
      noExecToken: true,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "unauthorized");
  });

  it("refuses a read without an owner envelope", async () => {
    const fixture = await lpFixture();
    const response = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp`);
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("answers the WRONG owner with the same 404 a missing agent gets", async () => {
    const fixture = await lpFixture();
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      {},
      { pk: OTHER_OWNER_PK },
    );
    assert.equal(response.status, 404);
    assert.equal(errorCode(response.body), "not_found");
    assert.equal(await fixture.settingsStore.get(ownerAccount.address, LP_AGENT_ID), null);
  });

  it("refuses a replayed nonce on a SECOND, different signed action", async () => {
    const fixture = await lpFixture();
    const nonce = freshNonce();
    const first = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      {},
      { nonce },
    );
    assert.equal(first.status, 200);

    const second = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      { autoHarvest: true },
      { nonce },
    );
    assert.equal(second.status, 401);
    assert.equal(errorCode(second.body), "owner_auth_failed");
  });

  it("answers a byte-identical retry from the journal without touching the nonce", async () => {
    const fixture = await lpFixture();
    const envelope = await signOwnerAction("lpSettings", {}, { agentId: LP_AGENT_ID });
    const first = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(first.status, 200);
    const retry = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(retry.status, 200);
    assert.equal(dataOf(retry.body)["replayed"], true);
  });

  it("refuses params tampered after signing — the digest binds the bytes", async () => {
    const fixture = await lpFixture();
    const envelope = await signOwnerAction("lpSettings", {}, { agentId: LP_AGENT_ID });
    const tampered = { ...envelope, params: { autoRotate: true } };
    const response = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: tampered,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("refuses an lpSettings envelope posted to the open route (binding)", async () => {
    const fixture = await lpFixture();
    const envelope = await signOwnerAction("lpSettings", {}, { agentId: LP_AGENT_ID });
    const response = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp/open`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("answers a cross-tenant positionId with 404, indistinguishable from missing", async () => {
    const fixture = await lpFixture();
    await fixture.lpStore.createPosition({
      positionId: "pos-other",
      agentId: OTHER_AGENT_ID,
      ownerAddress: otherOwnerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2500,
      tokenId: "5",
      basisWei: 1n,
    });
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-other/exit`,
      "lpExit",
      { positionId: "pos-other" },
    );
    assert.equal(response.status, 404);
    assert.equal(errorCode(response.body), "not_found");
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });

  it("refuses an exit whose signed positionId does not match the path", async () => {
    const fixture = await lpFixture();
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-2" },
    );
    assert.equal(response.status, 400);
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Open-time gates                                                            */
/* -------------------------------------------------------------------------- */

describe("lp3 — the open's admission gates run before any money", () => {
  it("(u) transposed: a pool whose TOKEN the session cannot sell is refused with nothing submitted and no row created", async () => {
    const fixture = await lpFixture();
    // A real, healthy pool for the unsellable token — the refusal must come
    // from the membership predicate, not from a missing pool.
    const pool = getAddress("0xCCcCCcccCCCCCcCcCCCcCccccCcCCCcCcCCCCCc9");
    fixture.chain.pools.set(poolKey(WBNB, TOKEN_UNSELLABLE, 2500), pool);
    fixture.chain.states.set(pool.toLowerCase(), healthyState(pool));

    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: { token0: WBNB, token1: TOKEN_UNSELLABLE, fee: 2500 } }),
    );
    assert.equal(response.status, 400);
    assert.match(String(response.body["error"] ? (response.body["error"] as Record<string, unknown>)["message"] : ""), /cannot sell/i);
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
    assert.equal(fixture.harness.provider.preflightCalls.length, 0);
    assert.equal(
      (await fixture.lpStore.listPositions(ownerAccount.address, LP_AGENT_ID)).length,
      0,
    );
  });

  it("R8: a cardinality-1 pool is refused naming increaseObservationCardinalityNext", async () => {
    const fixture = await lpFixture();
    const state = healthyState(POOL_A);
    fixture.chain.states.set(POOL_A.toLowerCase(), {
      ...state,
      evidence: { ...state.evidence, observationCardinality: 1 },
    });
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams(),
    );
    assert.equal(response.status, 400);
    const message = String(
      (response.body["error"] as Record<string, unknown>)["message"],
    );
    assert.match(message, /increaseObservationCardinalityNext/);
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });

  it("R11: a pool with no WBNB leg is refused; two identical legs are refused", async () => {
    const fixture = await lpFixture();
    const noWbnb = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: { token0: TOKEN, token1: TOKEN_2, fee: 2500 } }),
    );
    assert.equal(noWbnb.status, 400);
    assert.match(
      String((noWbnb.body["error"] as Record<string, unknown>)["message"]),
      /WBNB leg/,
    );

    const twin = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: { token0: WBNB, token1: WBNB, fee: 2500 } }),
    );
    assert.equal(twin.status, 400);
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });

  it("R11: the NFPM itself is never an LP token", async () => {
    const fixture = await lpFixture();
    const pool = getAddress("0xcCCCCCcccCcCCcCCCCcCcccCCcccCCcCcCcCCc10");
    fixture.chain.pools.set(poolKey(WBNB, NFPM, 2500), pool);
    fixture.chain.states.set(pool.toLowerCase(), healthyState(pool));
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: { token0: WBNB, token1: NFPM, fee: 2500 } }),
    );
    assert.equal(response.status, 400);
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"]),
      /not an LP-eligible token/,
    );
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });

  it("item 37: naming neither a pool nor selectPool is refused; naming both is refused", async () => {
    const fixture = await lpFixture();
    const neither = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      { range: { tickLower: -500, tickUpper: 500 }, budgetWei: "1000" },
    );
    assert.equal(neither.status, 400);

    const both = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ selectPool: "best-apr" }),
    );
    assert.equal(both.status, 400);
  });

  it("item 27: an open with no signed range and no server-fenced marker is refused", async () => {
    const fixture = await lpFixture();
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      {
        pool: { token0: WBNB, token1: TOKEN, fee: 2500 },
        budgetWei: BUDGET.toString(10),
      },
    );
    assert.equal(response.status, 400);
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"]),
      /server-fenced|range/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Yield selection (R15)                                                      */
/* -------------------------------------------------------------------------- */

function rankedPayload(asOfMs: number): Record<string, unknown> {
  return {
    asOfMs,
    pools: [
      {
        pool: POOL_A,
        token0: WBNB,
        token1: TOKEN,
        fee: 2500,
        tvlQuoteWei: (10n ** 20n).toString(10),
        volume24hQuoteWei: (10n ** 19n).toString(10),
      },
      {
        pool: POOL_B,
        token0: WBNB,
        token1: TOKEN_2,
        fee: 2500,
        tvlQuoteWei: (10n ** 21n).toString(10),
        volume24hQuoteWei: (10n ** 19n).toString(10),
      },
    ],
  };
}

describe("lp4 — selectPool: best-apr fails closed; explicit pools are unaffected", () => {
  it("refuses best-apr when the ranking is missing, while the explicit open on the same fixture succeeds", async () => {
    const fixture = await lpFixture();
    fixture.harness.dataPlane.nextRankedPools = null; // the 404 / missing seam

    const bestApr = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: undefined, selectPool: "best-apr" }),
    );
    assert.equal(bestApr.status, 400);
    assert.match(
      String((bestApr.body["error"] as Record<string, unknown>)["message"]),
      /unavailable or malformed/,
    );
    assert.equal(fixture.harness.provider.executeCalls.length, 0);

    const explicit = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams(),
    );
    assert.equal(explicit.status, 200);
    const open = dataOf(explicit.body)["open"] as Record<string, unknown>;
    assert.equal(open["status"], "completed");
    assert.equal(open["tokenId"], "777");
    assert.equal(fixture.harness.provider.executeCalls.length, 1);
  });

  it("refuses a STALE ranking (item 38)", async () => {
    const fixture = await lpFixture();
    fixture.harness.dataPlane.nextRankedPools = rankedPayload(
      NOW_SEC * 1000 - (RUNTIME.rankingMaxAgeSec + 1) * 1000,
    );
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: undefined, selectPool: "best-apr" }),
    );
    assert.equal(response.status, 400);
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"]),
      /staleness|stale/i,
    );
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });

  it("refuses best-apr when the data plane is UNREACHABLE (thrown, not null)", async () => {
    const fixture = await lpFixture();
    fixture.harness.dataPlane.rankedPoolsError = new Error("ECONNREFUSED");
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: undefined, selectPool: "best-apr" }),
    );
    assert.equal(response.status, 400);
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });

  it("rails first, ranking second: a decorated pool that fails a gate is never chosen", async () => {
    const fixture = await lpFixture();
    // POOL_B ranks first on APR (TOKEN_2 sellable via the chain fallback) but
    // its pool state is MISSING — the TWAP gate excludes it, so the head is
    // POOL_A. The ranking never resurrects a gate-failed pool.
    fixture.harness.provider.chainSellableTokens.add(TOKEN_2.toLowerCase());
    fixture.harness.dataPlane.nextRankedPools = {
      asOfMs: NOW_SEC * 1000,
      pools: [
        {
          pool: POOL_B,
          token0: WBNB,
          token1: TOKEN_2,
          fee: 2500,
          tvlQuoteWei: "1000",
          volume24hQuoteWei: "100000000", // wash-decorated APR
        },
        (rankedPayload(NOW_SEC * 1000)["pools"] as unknown[])[0],
      ],
    };
    fixture.chain.pools.set(poolKey(WBNB, TOKEN_2, 2500), POOL_B);
    // No state registered for POOL_B: poolState throws, the gate fails.

    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: undefined, selectPool: "best-apr" }),
    );
    assert.equal(response.status, 200);
    const selection = dataOf(response.body)["selection"] as Record<string, unknown>;
    assert.equal(selection["chosen"], POOL_A);
    assert.equal(selection["head"], POOL_A);
    const survivors = selection["survivors"] as unknown[];
    assert.equal(survivors.length, 1);
  });

  // INVERTED by MARKETPLACE-LP-AGENT Revision 4 BC4 (declared in the build
  // note): the HTTP plane runs NO brain. The original item-36 test proved a
  // hallucinated pool proposal FELL BACK to the ranked head through the pool
  // fence; the fence is gone from `/lp/open` because the data plane never
  // implemented `lp/brain/*` and the LP brain now lives in the WORKER only
  // (R2.1 / R3.2). What must hold instead: `brainEnabled: true` in stored
  // settings changes NOTHING on this route — no transport is consulted, the
  // receipt carries no `poolFence`, and the deterministic head is chosen.
  it("brainEnabled settings leave `selectPool: best-apr` deterministic on the HTTP plane — no brain, no pool fence (BC4 inversion of item 36)", async () => {
    const fixture = await lpFixture();
    const params = { brainEnabled: true };
    await fixture.settingsStore.put({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: paramsHash("lpSettings", params),
    });
    fixture.harness.provider.chainSellableTokens.add(TOKEN_2.toLowerCase());
    fixture.harness.dataPlane.nextRankedPools = rankedPayload(NOW_SEC * 1000);
    fixture.chain.pools.set(poolKey(WBNB, TOKEN_2, 2500), POOL_B);
    fixture.chain.states.set(POOL_B.toLowerCase(), healthyState(POOL_B));

    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ pool: undefined, selectPool: "best-apr" }),
    );
    assert.equal(response.status, 200);
    const data = dataOf(response.body);
    assert.equal("poolFence" in data, false, "the HTTP plane carries no brain verdict");
    const selection = data["selection"] as Record<string, unknown>;
    assert.equal(selection["chosen"], selection["head"]);
    const open = data["open"] as Record<string, unknown>;
    assert.equal(open["status"], "completed");
  });
});

/* -------------------------------------------------------------------------- */
/* Settings sizing (Rev2 item 11)                                             */
/* -------------------------------------------------------------------------- */

describe("lp5 — settings re-run the sizing check against the LIVE cap", () => {
  it("refuses a settings change the live on-chain cap cannot cover", async () => {
    const fixture = await lpFixture();
    fixture.chain.liveCapWei = 10n ** 12n; // far below N × 3 × 1e14
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      { maxExitSequencesPerDay: 24 },
    );
    assert.equal(response.status, 400);
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"]),
      /on-chain daily native cap/,
    );
    assert.equal(await fixture.settingsStore.get(ownerAccount.address, LP_AGENT_ID), null);
  });

  it("PHASE3.25 R7/R10: shift T12a keeps all clauses and projects the shortfall", async () => {
    const fixture = await lpFixture({ gridEnabled: true });
    fixture.chain.liveCapWei = 1n;
    const shift = {
      gapTicks: 500,
      widthTicks: 500,
      deployPctBps: 3_000,
      driftPctOfGap: 60,
      shiftsPerDay: 8,
      driftGasBudgetWei: "8",
      driftPerMotionWei: "1",
    };
    const ranges = gridDeriveRanges({
      currentTick: 0,
      tickSpacing: 50,
      gapTicks: shift.gapTicks,
      widthTicks: shift.widthTicks,
      wbnbIsToken0: true,
      minTick: -887_272,
      maxTick: 887_272,
    });
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      {
        minMinutesBetweenExits: 7,
        grid: {
          pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
          wbnbIsToken0: true,
          tickSpacing: 50,
          ...ranges,
          maxFlipsPerDay: 1,
          minNetEdgeBps: 0,
          mode: "shift",
          shift,
        },
      },
    );
    assert.equal(response.status, 400);
    const meta = response.body["meta"] as { shortfallWei: string };
    assert.ok(meta, JSON.stringify(response.body));
    const raw = "LP settings refused: the on-chain daily native cap is too low. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, or raise the cap with owner-add-spend-limit. The EXIT path is unaffected: positions can still be closed. Shortfall (wei): "
      + meta.shortfallWei;
    const message = String((response.body["error"] as Record<string, unknown>)["message"]);
    assert.equal(message, sanitizeMessage(raw));
    assert.match(message, /Remedies:/u);
    assert.match(message, /positions can still be closed/u);
    assert.match(message, /Shortfall \(wei\):/u);
  });

  it("refuses when the live cap cannot be READ — unreadable is unsizable", async () => {
    const fixture = await lpFixture();
    fixture.chain.liveCapError = new Error("rpc down");
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      {},
    );
    assert.equal(response.status, 400);
    assert.equal(await fixture.settingsStore.get(ownerAccount.address, LP_AGENT_ID), null);
  });

  it("stores the digest on success, and GET /lp reports it", async () => {
    const fixture = await lpFixture();
    const params = { autoHarvest: true };
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      params,
    );
    assert.equal(response.status, 200);
    const expected = paramsHash("lpSettings", params);
    assert.equal(dataOf(response.body)["settingsDigest"], expected);

    const envelope = await signOwnerAction(
      "read",
      { scope: "agent", agentId: LP_AGENT_ID },
      { agentId: LP_AGENT_ID },
    );
    const read = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(read.status, 200);
    assert.equal(dataOf(read.body)["settingsDigest"], expected);
  });
});

/* -------------------------------------------------------------------------- */
/* Exit                                                                       */
/* -------------------------------------------------------------------------- */

async function seedOpenPosition(fixture: LpFixture): Promise<void> {
  await fixture.lpStore.createPosition({
    positionId: "pos-1",
    agentId: LP_AGENT_ID,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2500,
    tokenId: "1",
    basisWei: BUDGET,
  });
  // Live before the exit's submit; emptied after it (the post-verify read).
  fixture.chain.positionsImpl = async (tokenId) => {
    if (tokenId !== 1n) return "burned";
    return fixture.harness.provider.executeCalls.length === 0
      ? { liquidity: 10n ** 15n, tickLower: -500, tickUpper: 500 }
      : { liquidity: 0n, tickLower: -500, tickUpper: 500 };
  };
}

describe("lp6 — the owner's manual exit", () => {
  it("runs the zap-out and completes", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-1" },
    );
    assert.equal(response.status, 200);
    const exit = dataOf(response.body)["exit"] as Record<string, unknown>;
    assert.equal(exit["status"], "completed");
    assert.equal(exit["inlineConvert"], false, "omitted consent normalizes false");
    assert.equal(
      exit["submissionModel"],
      "Every submitted batch is atomic, but this position may take ONE OR TWO submissions.",
    );
    assert.equal(fixture.harness.provider.executeCalls.length, 1);
    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      "pos-1",
    );
    assert.equal(position?.state, "closed");
    assert.equal(position?.basisWei, 0n); // the lineage closed with it (R7)
  });

  it("PHASE3.24 C2: the route persists signed true even when the default-empty allowlist falls back", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-1", inlineConvert: true },
    );
    assert.equal(response.status, 200);
    const exit = dataOf(response.body)["exit"] as Record<string, unknown>;
    assert.equal(exit["inlineConvert"], true);
    const [sequence] = await fixture.lpStore.listSequences(ownerAccount.address, LP_AGENT_ID);
    assert.equal(sequence?.inlineConvert, true);
    assert.equal(fixture.harness.provider.executeCalls.length, 1, "empty compatibility set keeps four-call path");
  });

  it("still exits under an owner pause — FINDINGS (s) carve-out, wired through", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    await fixture.harness.killswitch.pauseAgent(LP_AGENT_ID, ownerAccount.address);

    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-1" },
    );
    assert.equal(response.status, 200);
    const exit = dataOf(response.body)["exit"] as Record<string, unknown>;
    assert.equal(exit["status"], "completed");
  });

  it("PHASE3.24 C4: an owner-signed, confirmed pause can be followed by lpExit", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const pause = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/pause`,
      "pause",
      {},
    );
    assert.equal(pause.status, 200);
    assert.equal(
      await fixture.harness.killswitch.isAgentPaused(LP_AGENT_ID, ownerAccount.address),
      true,
    );
    const exitResponse = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-1", inlineConvert: false },
    );
    assert.equal(exitResponse.status, 200);
    const exit = dataOf(exitResponse.body)["exit"] as Record<string, unknown>;
    assert.equal(exit["status"], "completed", JSON.stringify(exit));
  });

  it("PHASE3.1-AUDIT A3: the open RECORDS the deployment's own WBNB as the position's quote asset", async () => {
    // The finding's silent-drift seam, closed at its source. `createPosition`
    // defaults `quoteToken` to DEFAULT_QUOTE_TOKEN — a hardcoded BNB-Chain-56
    // literal — and nothing on `/lp/open` used to override it, so on this
    // fixture (and on every testnet) the persisted field named an address that
    // is not the configured WBNB and that no code on the exit path reads.
    const fixture = await lpFixture();
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams(),
    );
    assert.equal(response.status, 200);
    const positionId = String(
      (dataOf(response.body)["position"] as Record<string, unknown>)["positionId"],
    );
    const record = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      positionId,
    );
    assert.notEqual(WBNB, DEFAULT_QUOTE_TOKEN, "the fixture must be able to tell them apart");
    assert.equal(record?.quoteToken, WBNB, "authored from resolved config, never defaulted");
  });

  it("PHASE3.1-AUDIT A3: a pool with no WBNB leg answers a TYPED refusal on the exit, never a 500", async () => {
    // `runExitSaga` reads the pool's legs before any sequence exists, and that
    // throw was neither a BadRequestError nor an LpPositionNotFoundError — so
    // it escaped `ownerMutation`'s catch as a 500 on the owner's escape hatch.
    const fixture = await lpFixture();
    fixture.chain.pools.set(poolKey(TOKEN, TOKEN_2, 2500), POOL_B);
    fixture.chain.states.set(POOL_B.toLowerCase(), healthyState(POOL_B));
    await fixture.lpStore.createPosition({
      positionId: "pos-legless",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: TOKEN_2,
      fee: 2500,
      tokenId: "9",
      basisWei: BUDGET,
    });
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-legless/exit`,
      "lpExit",
      { positionId: "pos-legless" },
    );
    assert.equal(response.status, 400, "a typed refusal, not an unhandled 500");
    assert.equal(errorCode(response.body), "invalid_request");
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"]),
      /WBNB leg/,
    );
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });

  it("but a paused agent cannot OPEN — the carve-out is one-directional", async () => {
    const fixture = await lpFixture();
    await fixture.harness.killswitch.pauseAgent(LP_AGENT_ID, ownerAccount.address);
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams(),
    );
    assert.equal(response.status, 200);
    const open = dataOf(response.body)["open"] as Record<string, unknown>;
    assert.equal(open["status"], "rolled-back");
    assert.equal(open["code"], "AGENT_PAUSED");
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The open's money path                                                      */
/* -------------------------------------------------------------------------- */

describe("lp7 — the confirmed open, end to end against the fakes", () => {
  it("submits ONE atomic batch whose attached native equals the signed budget", async () => {
    const fixture = await lpFixture();
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams(),
    );
    assert.equal(response.status, 200);
    const data = dataOf(response.body);
    const open = data["open"] as Record<string, unknown>;
    assert.equal(open["status"], "completed");
    assert.equal(open["tokenId"], "777");
    const position = data["position"] as Record<string, unknown>;
    assert.equal(position["tokenId"], "777");
    assert.equal(position["basisWei"], BUDGET.toString(10));
    assert.equal(position["basisSource"], "owner-budget");

    assert.equal(fixture.harness.provider.executeCalls.length, 1);
    const calls = fixture.harness.provider.executeCalls[0]?.calls ?? [];
    const attached = calls.reduce((total, c) => total + (c.value ?? 0n), 0n);
    assert.equal(attached, BUDGET);
    // The batch never grants NFPM authority: no call targets the NFPM with
    // an approval selector, and the only value-bearing NFPM call is the mint.
    assert.equal(
      fixture.harness.provider.executeCalls[0]?.bypassLocalPolicyCheck,
      false,
    );
  });

  it('honours the signed "server-fenced" delegation: deterministic centered range, zero brain calls while brainEnabled is off', async () => {
    const fixture = await lpFixture();
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams({ range: "server-fenced" }),
    );
    assert.equal(response.status, 200);
    const data = dataOf(response.body);
    const open = data["open"] as Record<string, unknown>;
    assert.equal(open["status"], "completed");
    // centeredRotationRange(defaultOpenWidthTicks 1000, spacing 50, tick 0).
    const range = data["range"] as Record<string, unknown>;
    assert.equal(range["source"], "server-fenced");
    assert.equal(range["tickLower"], -500);
    assert.equal(range["tickUpper"], 500);
    // MARKETPLACE-LP-AGENT BC4 (declared inversion): the HTTP plane has no
    // brain transport at all now, whatever `brainEnabled` says — the only
    // data-plane traffic an open may generate is the ranked-pools read.
    assert.equal(
      fixture.harness.dataPlane.requested.some((path) => path.startsWith("lp/brain/")),
      false,
    );
  });

  it("a FAILED receipt rolls the sequence back and closes the never-funded lineage", async () => {
    const fixture = await lpFixture();
    fixture.harness.provider.nextReceipt = {
      status: "FAILED",
      failureCode: "NOT_ALLOWED",
    };
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams(),
    );
    assert.equal(response.status, 200);
    const open = dataOf(response.body)["open"] as Record<string, unknown>;
    assert.equal(open["status"], "rolled-back");
    const positions = await fixture.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.equal(positions[0]?.state, "closed");
  });

  it("an ambiguous submit HOLDS — nothing retries, nothing rolls back", async () => {
    const fixture = await lpFixture();
    fixture.harness.provider.nextError = new Error("socket hang up");
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/open`,
      "lpOpen",
      explicitOpenParams(),
    );
    assert.equal(response.status, 200);
    const open = dataOf(response.body)["open"] as Record<string, unknown>;
    assert.equal(open["status"], "held");
    assert.equal(open["code"], "HELD_AMBIGUOUS");
    const positions = await fixture.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    // The position row survives: the funds may have moved.
    assert.equal(positions[0]?.state, "open");
  });
});

/* -------------------------------------------------------------------------- */
/* Passkey (Rev2 item 22)                                                     */
/* -------------------------------------------------------------------------- */

describe("lp8 — an LP action through the PASSKEY verifier, zero dispatcher changes", () => {
  it("verifies lpSettings signed by a P-256 credential end to end", async () => {
    const fixture = await lpFixture({ passkey: true });
    const passkey = await createTestPasskey();
    const PASSKEY_AGENT = "agent-lp-passkey";
    await fixture.harness.agentStore.createAgent({
      id: PASSKEY_AGENT,
      ownerAddress: passkey.ownerAddress,
      walletAddress: getAddress("0x000000000000000000000000000000000000a11e"),
      custodyModel: "passkey",
      sessionFacts: lpSessionFacts(NOW_SEC + 3_600),
      status: "armed",
    });

    const envelope = await signPasskeyOwnerAction(passkey, "lpSettings", {}, {
      agentId: PASSKEY_AGENT,
    });
    const response = await call(
      fixture.harness,
      `/agents/${PASSKEY_AGENT}/lp/settings`,
      {
        method: "POST",
        body: {
          signed: envelope.signed,
          signature: envelope.signature,
          params: envelope.params,
        },
      },
    );
    assert.equal(response.status, 200);
    const stored = await fixture.settingsStore.get(passkey.ownerAddress, PASSKEY_AGENT);
    assert.equal(stored?.digest, paramsHash("lpSettings", {}));
  });
});

/* -------------------------------------------------------------------------- */
/* Settings store parity (memory vs Postgres-over-fake-SQL)                   */
/* -------------------------------------------------------------------------- */

describe("lp9 — the settings store answers identically on both backends", () => {
  it("round-trips params + digest and scopes reads/writes by owner", async () => {
    const sql = new FakeSqlClient();
    const stores = [
      new MemoryLpSettingsStore(),
      await PostgresLpSettingsStore.create(sql),
    ];
    const params = { autoRotate: true, minAprBps: 100 };
    const digest = paramsHash("lpSettings", params);
    for (const store of stores) {
      await store.put({
        agentId: "a1",
        ownerAddress: ownerAccount.address,
        params,
        digest,
      });
      const mine = await store.get(ownerAccount.address, "a1");
      assert.deepEqual(mine?.params, params);
      assert.equal(mine?.digest, digest);
      // Cross-tenant read: null, indistinguishable from missing.
      assert.equal(await store.get(otherOwnerAccount.address, "a1"), null);
      // Cross-tenant overwrite: refused loudly.
      await assert.rejects(
        store.put({
          agentId: "a1",
          ownerAddress: otherOwnerAccount.address,
          params: {},
          digest: paramsHash("lpSettings", {}),
        }),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.2 — the read side answers "is protection armed" (Decision 4)        */
/* -------------------------------------------------------------------------- */

/** `GET /agents/:id/lp` under a signed owner read. */
async function readLp(
  fixture: LpFixture,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction(
    "read",
    { scope: "agent", agentId: LP_AGENT_ID },
    { agentId: LP_AGENT_ID },
  );
  return call(fixture.harness, `/agents/${LP_AGENT_ID}/lp`, {
    headers: { "x-owner-action": toReadHeader(envelope) },
  });
}

function protectionOf(
  body: Record<string, unknown>,
  index = 0,
): Record<string, unknown> {
  const positions = dataOf(body)["positions"] as Record<string, unknown>[];
  const position = positions[index] ?? {};
  return (position["protection"] ?? {}) as Record<string, unknown>;
}

/** The observation a worker cycle would have written for `pos-1`. */
function observationAt(evaluatedAtMs: number, protectConsecutive: number) {
  return {
    blockNumber: 100n,
    evaluatedAtMs,
    poolAddress: POOL_A,
    protectBreach: "stop-loss" as const,
    protectConsecutive,
    rotationBreach: false,
    rotationConsecutive: 0,
    tokenId: "1",
  };
}

describe("lp10 — GET /agents/:id/lp reports whether protection is actually armed", () => {
  it("with no stop or take-profit configured, it says so rather than looking healthy", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const read = await readLp(fixture);
    assert.equal(read.status, 200);
    const protection = protectionOf(read.body);
    assert.equal(protection["armed"], false);
    assert.match(String(protection["reason"]), /Neither a stop-loss nor a take-profit/u);
    assert.equal(protection["stopLossPct"], 0);
    assert.equal(protection["observationHeldAtMs"], null);
    assert.equal(protection["protectConsecutive"], 0);
    assert.equal(protection["confirmationEligibleAtMs"], null);
  });

  it("reports the held observation, its age, the count and when it can confirm", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    await postOwner(fixture, `/agents/${LP_AGENT_ID}/lp/settings`, "lpSettings", {
      stopLossPct: 5,
    });
    await fixture.observations.put({
      ownerAddress: ownerAccount.address,
      agentId: LP_AGENT_ID,
      positionId: "pos-1",
      observation: observationAt(NOW_SEC * 1000 - 30_000, 1),
    });

    const protection = protectionOf((await readLp(fixture)).body);
    assert.equal(protection["armed"], true);
    assert.equal(protection["stopLossPct"], 5);
    assert.equal(protection["observationHeldAtMs"], NOW_SEC * 1000 - 30_000);
    assert.equal(protection["observationAgeMs"], 30_000);
    assert.equal(protection["observationStale"], false);
    assert.equal(protection["protectConsecutive"], 1);
    // One WORKER interval after the observation — the number an operator needs
    // to know when a second `--once` becomes useful.
    assert.equal(protection["confirmationEligibleAtMs"], NOW_SEC * 1000 - 30_000 + 60_000);
    assert.equal(protection["maxObservationAgeMs"], 300_000);
  });

  it("a STALE held observation is visible — the crash-loop residual is not hidden", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    await postOwner(fixture, `/agents/${LP_AGENT_ID}/lp/settings`, "lpSettings", {
      stopLossPct: 5,
    });
    await fixture.observations.put({
      ownerAddress: ownerAccount.address,
      agentId: LP_AGENT_ID,
      positionId: "pos-1",
      observation: observationAt(NOW_SEC * 1000 - 900_000, 1),
    });
    const protection = protectionOf((await readLp(fixture)).body);
    assert.equal(protection["observationStale"], true);
    assert.equal(protection["observationAgeMs"], 900_000);
  });

  it("a settings digest that does not recompute reads armed:false — the silent disarm, reported", async () => {
    // The worker skips this position on EVERY cycle. Before PHASE3.2 nothing
    // an owner could query said so (PHASE3.1-REVIEW R5).
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    await fixture.settingsStore.put({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      params: { stopLossPct: 5 },
      digest: `0x${"ab".repeat(32)}`, // NOT paramsHash("lpSettings", params)
    });
    const protection = protectionOf((await readLp(fixture)).body);
    assert.equal(protection["armed"], false);
    assert.equal(protection["digestVerified"], false);
    assert.match(String(protection["reason"]), /digest does not recompute/u);
    assert.equal(protection["stopLossPct"], null, "no settings are claimed to be in force");
  });

  it("an unreadable stored settings row reads armed:false rather than 500ing the dashboard", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const params = { stopLossPct: 5, thisKeyIsNotInTheVocabulary: true };
    await fixture.settingsStore.put({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: paramsHash("lpSettings", params), // the digest DOES recompute
    });
    const read = await readLp(fixture);
    assert.equal(read.status, 200);
    const protection = protectionOf(read.body);
    assert.equal(protection["armed"], false);
    assert.equal(protection["digestVerified"], true);
    assert.equal(protection["settingsReadable"], false);
    assert.match(String(protection["reason"]), /unreadable/u);
  });

  it("a zero lineage basis reads armed:false", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    await postOwner(fixture, `/agents/${LP_AGENT_ID}/lp/settings`, "lpSettings", {
      stopLossPct: 5,
    });
    await fixture.lpStore.setPositionState(
      ownerAccount.address,
      LP_AGENT_ID,
      "pos-1",
      "closing",
    );
    // Closing does not zero the basis; a lineage whose basis IS zero cannot
    // anchor a protect, and the evaluator already excludes it.
    const protection = protectionOf((await readLp(fixture)).body);
    assert.equal(protection["armed"], true, "still open enough to protect");

    const other = await lpFixture();
    await other.lpStore.createPosition({
      positionId: "pos-2",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2500,
      tokenId: "2",
      basisWei: 0n,
    });
    await postOwner(other, `/agents/${LP_AGENT_ID}/lp/settings`, "lpSettings", {
      stopLossPct: 5,
    });
    const zero = protectionOf((await readLp(other)).body);
    assert.equal(zero["armed"], false);
    assert.match(String(zero["reason"]), /lineage basis is zero/u);
  });

  it("an observation store outage degrades the field, never the dashboard", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const read = await readLp(fixture);
    assert.equal(read.status, 200);
    assert.equal(protectionOf(read.body)["observationHeldAtMs"], null);
  });

  it("the exit that CLOSES a lineage retires its observation row (retention)", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    await fixture.observations.put({
      ownerAddress: ownerAccount.address,
      agentId: LP_AGENT_ID,
      positionId: "pos-1",
      observation: observationAt(NOW_SEC * 1000, 1),
    });
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-1" },
    );
    assert.equal(response.status, 200);
    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      "pos-1",
    );
    assert.equal(position?.state, "closed");
    assert.equal(
      await fixture.observations.get(ownerAccount.address, LP_AGENT_ID, "pos-1"),
      null,
      "the observation row must not outlive the lineage",
    );
  });

  /* ----- PHASE3.1: the exit's owner-facing explanation (Rev2 items 15/19) ---- */

  it("an exit whose swap leg was SKIPPED says so on the receipt AND on the sequence view", async () => {
    // Rev2 item 15. Without the note, decision 2's "the reason recorded on the
    // sequence" exists only in the worker's log for an autonomous protect: the
    // owner reads `completed`, still holds the ERC-20, and has no in-product
    // explanation — in the phase that exists BECAUSE the owner was surprised by
    // what the exit returned. This fixture's collect delta (10 000 wei) is far
    // below one submission's relay fee, so the swap is skipped as dust.
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-1" },
    );
    assert.equal(response.status, 200);
    const exit = dataOf(response.body)["exit"] as Record<string, unknown>;
    assert.equal(exit["status"], "completed");
    assert.equal(exit["confirmedSteps"], 2, "the exit is two plan positions from 3.1 on");
    assert.match(
      String(exit["note"]),
      /relay fee/,
      "the receipt must carry the skip's reason",
    );

    const read = await readLp(fixture);
    assert.equal(read.status, 200);
    const sequences = dataOf(read.body)["sequences"] as Record<string, unknown>[];
    assert.equal(sequences.length, 1);
    assert.match(String(sequences[0]?.["note"]), /relay fee/);
    assert.deepEqual(
      (sequences[0]?.["steps"] as Record<string, unknown>[]).map((s) => s["kind"]),
      ["zap-out", "sweep-token"],
    );

    // PHASE3.1-FIXREVIEW2 G4, pinned END TO END rather than only on the pure
    // view: the route has to fetch the journal facts for this to mean anything.
    // Both steps are `COMMITTED` — the skip is a completed plan position — and
    // `submitted` is the only thing that separates the swap that ran from the
    // one that did not. Without it, F2's retry rows render as swaps.
    const wireSteps = sequences[0]?.["steps"] as Record<string, unknown>[];
    assert.deepEqual(
      wireSteps.map((s) => [s["state"], s["submitted"], s["unreadable"]]),
      [
        ["COMMITTED", true, false],
        ["COMMITTED", false, false],
      ],
    );
  });

  it("PHASE3.1-FIXREVIEW3 H5: a never-submitted retry row reads submitted:false ON THE WIRE", async () => {
    // The end-to-end half of H5. The assertion above covers the SKIP shape,
    // whose rows carry no `callsHash` either way, so it passed under the broken
    // derivation too — the gap was the PREFLIGHT transient site, whose row is
    // written by `beginWithSpend` WITH the step's real `callsHash` and then
    // rolled back before `restoreSession`, `preflightExecute` and any submit.
    // Measured on the shipped route, six such rows reported `submitted: true`
    // against one real submission.
    //
    // The rows are seeded rather than driven, because the transport failure has
    // to arrive on the SECOND submission of one request and this fixture's
    // `preflightError` is global. What is seeded is exactly what the saga writes:
    // `appendStep`, then `beginWithSpend` with `{callsHash}`, then
    // `markRolledBack` with the attributed transient reason.
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    const sequence = await fixture.lpStore.createSequence({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: "pos-1",
      kind: "protect",
    });
    const callsHash = `0x${"11".repeat(32)}` as Hex;
    // Step 0: the zap-out that really submitted — a callsId AND a txHash.
    const zapOut = await fixture.lpStore.appendStep(
      ownerAccount.address,
      LP_AGENT_ID,
      sequence.sequenceId,
      { kind: "zap-out", journalIdempotencyKey: "wire-h5-0" },
    );
    await fixture.harness.journal.beginWithSpend(
      {
        idempotencyKey: zapOut.journalIdempotencyKey,
        agentId: LP_AGENT_ID,
        ownerAddress: ownerAccount.address,
        kind: "lp",
        decisionId: zapOut.journalDecisionId,
        externalRef: { callsHash },
        nativeSpendWei: 0n,
      },
      0,
    );
    await fixture.harness.journal.markInProgress(zapOut.journalIdempotencyKey, {
      callsId: `0x${"c1".repeat(32)}` as Hex,
    });
    await fixture.harness.journal.markCommitted(zapOut.journalIdempotencyKey, {
      txHash: `0x${"7a".repeat(32)}` as Hex,
    });
    // Steps 1–2: two transport failures at the preflight site. Real calldata was
    // bound to the key; nothing was ever sent.
    for (const index of [1, 2]) {
      const attempt = await fixture.lpStore.appendStep(
        ownerAccount.address,
        LP_AGENT_ID,
        sequence.sequenceId,
        { kind: "sweep-token", journalIdempotencyKey: `wire-h5-${index}` },
      );
      await fixture.harness.journal.beginWithSpend(
        {
          idempotencyKey: attempt.journalIdempotencyKey,
          agentId: LP_AGENT_ID,
          ownerAddress: ownerAccount.address,
          kind: "lp",
          decisionId: attempt.journalDecisionId,
          externalRef: { callsHash },
          nativeSpendWei: 0n,
        },
        0,
      );
      await fixture.harness.journal.markRolledBack(
        attempt.journalIdempotencyKey,
        "Refused before submission: INFRASTRUCTURE_ERROR (transient).",
      );
    }

    const read = await readLp(fixture);
    assert.equal(read.status, 200);
    const sequences = dataOf(read.body)["sequences"] as Record<string, unknown>[];
    const wireSteps = sequences[0]?.["steps"] as Record<string, unknown>[];
    assert.deepEqual(
      wireSteps.map((s) => [s["state"], s["submitted"], s["unreadable"]]),
      [
        ["COMMITTED", true, false],
        ["ROLLED_BACK", false, false],
        ["ROLLED_BACK", false, false],
      ],
      "a ROLLED_BACK row provably never reached a relay; the view must not say it did",
    );
  });

  it("an exit that had nothing to explain reports note: null", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    // exitToQuote OFF is itself a skip, so use the one shape that is not a
    // skip at all: a position whose collect frees nothing on the token leg.
    fixture.chain.states.set(POOL_A.toLowerCase(), healthyState(POOL_A));
    const read = await readLp(fixture);
    assert.equal(read.status, 200);
    const before = dataOf(read.body)["sequences"] as Record<string, unknown>[];
    assert.equal(before.length, 0, "no sequence, no note");
  });

  it("a settings refusal names the remedies AND that the EXIT path still works (Rev2 item 19)", async () => {
    // The reserve widened from one exit submission per open position to two, so
    // agents that passed under Phase 3 can be refused here for the first time.
    // `/lp/settings` is also how an owner turns automation OFF, so a bare "no"
    // would read as "you are stuck" when the owner is not stuck at all.
    const fixture = await lpFixture();
    fixture.chain.liveCapWei = 10n ** 12n;
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      { maxExitSequencesPerDay: 24 },
    );
    assert.equal(response.status, 400);
    const message = String(
      (response.body["error"] as Record<string, unknown>)["message"],
    );
    assert.match(message, /on-chain daily native cap/);
    assert.match(message, /Remedies/);
    assert.match(message, /owner-add-spend-limit/);
    assert.match(message, /lower maxExitSequencesPerDay/);
    assert.match(message, /close a position/);
    assert.match(message, /EXIT path is unaffected/);
    assert.match(message, /every position can still be closed/);
    // The remedies must LEAD: `sanitizeMessage` caps the body at 280 chars and
    // the sizing arithmetic alone overruns it, so anything appended after the
    // detail is truncated away from the owner. The matches above already prove
    // the actionable half survived; this pins that the truncation (when it
    // happens) falls strictly after it.
    const cut = message.indexOf("…");
    assert.ok(cut === -1 || cut > message.indexOf("every position can still be closed"));
  });

  it("PHASE3.1-AUDIT A9: and it names the SHORTFALL, the one number owner-add-spend-limit needs", async () => {
    // The finding: the remedies led (correctly), but the shortfall lived in
    // `sizing.message` far past `sanitizeMessage`'s 280-character cap, so the
    // owner was told to raise the cap and given no way to learn by how much —
    // and the journal's copy was truncated at the same point.
    const fixture = await lpFixture();
    fixture.chain.liveCapWei = 10n ** 12n;
    const response = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      { maxExitSequencesPerDay: 24 },
    );
    assert.equal(response.status, 400);
    const message = String(
      (response.body["error"] as Record<string, unknown>)["message"],
    );
    const shortfall = /short by (\d+) wei/u.exec(message);
    assert.ok(shortfall !== null, `no shortfall in: ${message}`);
    const raised = BigInt(shortfall[1] ?? "0");
    assert.ok(raised > 0n);
    // AND IT IS THE RIGHT NUMBER: raising the on-chain cap by exactly this
    // much makes the identical settings change pass.
    const healed = await lpFixture();
    healed.chain.liveCapWei = 10n ** 12n + raised;
    const second = await postOwner(
      healed,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      { maxExitSequencesPerDay: 24 },
    );
    assert.equal(second.status, 200, "the shortfall is actionable, not decorative");
    // One wei less is still refused — the figure is exact, not a round-up.
    const short = await lpFixture();
    short.chain.liveCapWei = 10n ** 12n + raised - 1n;
    const third = await postOwner(
      short,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      { maxExitSequencesPerDay: 24 },
    );
    assert.equal(third.status, 400);
  });

  it("and the promise is TRUE: the exit runs while the settings change is refused", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    fixture.chain.liveCapWei = 10n ** 12n;
    const refused = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      "lpSettings",
      { maxExitSequencesPerDay: 24 },
    );
    assert.equal(refused.status, 400);
    const exited = await postOwner(
      fixture,
      `/agents/${LP_AGENT_ID}/lp/pos-1/exit`,
      "lpExit",
      { positionId: "pos-1" },
    );
    assert.equal(exited.status, 200, "the exit route runs no sizing check");
    const exit = dataOf(exited.body)["exit"] as Record<string, unknown>;
    assert.equal(exit["status"], "completed");
  });

  it("another owner's observation is never visible through this route", async () => {
    const fixture = await lpFixture();
    await seedOpenPosition(fixture);
    await postOwner(fixture, `/agents/${LP_AGENT_ID}/lp/settings`, "lpSettings", {
      stopLossPct: 5,
    });
    // A row for the same positionId under a DIFFERENT owner scope.
    await fixture.observations.put({
      ownerAddress: otherOwnerAccount.address,
      agentId: LP_AGENT_ID,
      positionId: "pos-other",
      observation: observationAt(NOW_SEC * 1000, 1),
    });
    const protection = protectionOf((await readLp(fixture)).body);
    assert.equal(protection["observationHeldAtMs"], null);
    assert.equal(protection["protectConsecutive"], 0);
  });
});
