/**
 * PHASE3.18 — the OWNER-SIGNED surfaces in policy mode: the arm (C3), C2's four
 * checks on a re-sign (R2.7 as corrected by C2), the M7 identity backfill, the
 * C10 policy width ceiling, and the import door R2.5 declares CLOSED.
 *
 * The fixture pattern is `test/lp.gridArmRoutes.test.ts`'s — the shared server
 * harness over memory stores and a fake chain. THE SHARED FIXTURE'S POOL IS
 * CASE B (`WBNB` sorts into token0, `wbnbIsToken0 === true`), so the
 * quote-holding BUY level sits ABOVE the price at tick 0.
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
  type Harness,
} from "./support/serverHarness.js";
import type { SessionFacts } from "../src/store/agents.js";
import type { LpPoolStateReading, LpServerDeps } from "../src/server.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { MemoryLpGridCycleStore } from "../src/store/gridCycles.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import { gridDeriveRanges } from "../src/lp/gridGeometry.js";
import { MAX_TICK, MIN_TICK } from "../src/lp/tickMath.js";
import {
  DEFAULT_LP_SETTINGS,
  type LpAutomationSettings,
  type LpGridSettings,
} from "../src/lp/triggers.js";

const AGENT_ID = "agent-grid-requote";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const MINTED_TOKEN_ID = "777";
const BUDGET = 10n ** 17n;
const INTERVAL_MS = 60_000;

const SPACING = 50;
/**
 * A WIDE gap on purpose. C2's check 4 runs on the REQUOTE-INFLATED floor
 * (`2 + 2R` submissions), so at `maxRequotesPerDay: 12` a re-sign must clear a
 * 26-submission gas floor — which a 100-tick gap does not at this level size.
 * Sizing the fixture to clear it is what lets the OTHER checks be tested
 * without check 4 refusing everything first.
 */
const GAP = 1_500;
const WIDTH = 200;
/** The tick the ladder is derived at, and the fixture pool's current tick. */
const ANCHOR = 0;

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

/** The SIGNED rungs, derived through the ONE derivation the validator checks. */
const DERIVED = gridDeriveRanges({
  currentTick: ANCHOR,
  tickSpacing: SPACING,
  gapTicks: GAP,
  widthTicks: WIDTH,
  wbnbIsToken0: true,
  minTick: MIN_TICK,
  maxTick: MAX_TICK,
});

function grid(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: SPACING,
    buyRange: DERIVED.buyRange,
    sellRange: DERIVED.sellRange,
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    ...overrides,
  };
}

function policyGrid(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return grid({
    mode: "policy",
    policy: { gapTicks: GAP, widthTicks: WIDTH },
    requote: { driftPctOfGap: 60, maxRequotesPerDay: 12 },
    ...overrides,
  });
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

function lpSessionFacts(expiresAt: number): SessionFacts {
  return {
    spec: {
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
    },
    permissions: { calls: [], spend: [] },
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: expiresAt,
  };
}

function snapshotAt(range: { tickLower: number; tickUpper: number }): LpPositionSnapshot {
  return {
    liquidity: 10n ** 18n,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    operator: zeroAddress,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
  };
}

type Fixture = {
  readonly harness: Harness;
  readonly lpStore: MemoryLpSequenceStore;
  readonly settingsStore: MemoryLpSettingsStore;
  readonly chain: {
    snapshot: LpPositionSnapshot | "burned";
    tick: number;
    owner: Address | "burned";
  };
};

async function fixture(
  options: { readonly settingsGrid?: LpGridSettings | null } = {},
): Promise<Fixture> {
  const lpStore = new MemoryLpSequenceStore();
  const settingsStore = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();
  const cycles = new MemoryLpGridCycleStore();
  const chain: Fixture["chain"] = {
    snapshot: snapshotAt(DERIVED.buyRange),
    tick: ANCHOR,
    owner: ownerAccount.address,
  };

  const state = (): LpPoolStateReading => ({
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
  });

  const lp: LpServerDeps = {
    store: lpStore,
    settingsStore,
    observations,
    workerIntervalMs: INTERVAL_MS,
    railsResult: { ok: true, config: RAILS },
    runtime: RUNTIME,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    gridCycles: cycles,
    gridEnabled: true,
    readers: {
      getPool: async (): Promise<Address> => POOL,
      poolState: async (): Promise<LpPoolStateReading> => state(),
      positions: async (): Promise<LpPositionSnapshot | "burned"> => chain.snapshot,
      positionFees: async (): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> => ({
        amount0Wei: 0n,
        amount1Wei: 0n,
      }),
      ownerOf: async (): Promise<Address | "burned"> => chain.owner,
      quote: async (params: { amountInWei: bigint }): Promise<bigint> => params.amountInWei,
      receipts: {
        collectAmounts: async (): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> => ({
          amount0Wei: 0n,
          amount1Wei: 0n,
        }),
        swapAmounts: async (): Promise<never> => {
          throw new Error("no swap in this fixture");
        },
        mintedTokenId: async (): Promise<bigint> => BigInt(MINTED_TOKEN_ID),
      },
      onChainNativeDailyCapWei: async (): Promise<bigint> => 10n ** 18n,
    },
  };

  const harness = await createHarness({ lp });
  await harness.agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600),
    status: "armed",
  });
  await harness.agentStore.putAgentSessionKey(ownerAccount.address, AGENT_ID, SESSION_KEY);
  if (options.settingsGrid !== undefined) {
    const params = settingsWith(options.settingsGrid);
    await settingsStore.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: paramsHash("lpSettings", params),
    });
  }
  return { harness, lpStore, settingsStore, chain };
}

async function armCall(
  f: Fixture,
  gridBlock: LpGridSettings,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = {
    settings: settingsWith(gridBlock),
    budgetWei: BUDGET.toString(10),
  };
  const envelope = await signOwnerAction("gridArm", params, { agentId: AGENT_ID });
  return call(f.harness, `/agents/${AGENT_ID}/lp/grid/arm`, {
    method: "POST",
    body: envelope,
  });
}

async function settingsCall(
  f: Fixture,
  gridBlock: LpGridSettings,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = settingsWith(gridBlock);
  const envelope = await signOwnerAction("lpSettings", params, { agentId: AGENT_ID });
  return call(f.harness, `/agents/${AGENT_ID}/lp/settings`, {
    method: "POST",
    body: envelope,
  });
}

function reason(body: Record<string, unknown>): string {
  const error = body["error"] as { message?: string } | undefined;
  return error?.message ?? "";
}

/* -------------------------------------------------------------------------- */
/* C3 — the ARM mints at the SIGNED rungs in BOTH modes                       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 C3: the arm mints at the SIGNED rungs in policy mode too", () => {
  it("C12(d): a policy-mode arm mints the SIGNED buyRange, not a fresh derivation", async () => {
    const f = await fixture();
    const response = await armCall(f, policyGrid());
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    const gridView = data["grid"] as Record<string, unknown>;
    const armed = gridView["armedRange"] as Record<string, unknown>;
    // Policy mode floats NOTHING until the first requote. A policy-derived arm
    // would reintroduce B4 on the arm's own mainnet-exercised resume path and
    // break its per-pair net-edge admission, which prices SIGNED rungs.
    assert.equal(armed["tickLower"], DERIVED.buyRange.tickLower);
    assert.equal(armed["tickUpper"], DERIVED.buyRange.tickUpper);

    const calls = f.harness.provider.executeCalls[0]?.calls ?? [];
    assert.equal(calls[0]?.value, BUDGET, "the whole budget attaches to the mint");
  });

  it("R2.6: the arm writes the DURABLE identity at row creation", async () => {
    const f = await fixture();
    const response = await armCall(f, policyGrid());
    assert.equal(response.status, 200);
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.equal(positions.length, 1);
    assert.equal(positions[0]?.gridLevel, 1);
    assert.equal(positions[0]?.gridRole, "buy");
  });

  it("a FIXED-mode arm writes the columns too, so a later mode switch can verify", async () => {
    const f = await fixture();
    const response = await armCall(f, grid());
    assert.equal(response.status, 200);
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.equal(positions[0]?.gridLevel, 1);
    assert.equal(positions[0]?.gridRole, "buy");
  });

  it("an INCOHERENT policy is refused at signing, before any money", async () => {
    const f = await fixture();
    const response = await armCall(
      f,
      policyGrid({ policy: { gapTicks: GAP + SPACING, widthTicks: WIDTH } }),
    );
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /is not what grid\.policy/u);
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* C10 — the POLICY width ceiling                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 C10: LP_MAX_TICK_WIDTH is checked on the POLICY", () => {
  it("a policy width over the deployment ceiling is refused", async () => {
    const f = await fixture();
    // A width above the ceiling, with rungs coherent for it — so the ONLY
    // thing that can refuse is the policy check. Every FUTURE rung the requote
    // derives inherits this width, and none of them passes the four-rung loop.
    const wide = gridDeriveRanges({
      currentTick: ANCHOR,
      tickSpacing: SPACING,
      gapTicks: GAP,
      widthTicks: RUNTIME.maxTickWidth + SPACING,
      wbnbIsToken0: true,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    });
    const response = await armCall(
      f,
      policyGrid({
        buyRange: wide.buyRange,
        sellRange: wide.sellRange,
        policy: { gapTicks: GAP, widthTicks: RUNTIME.maxTickWidth + SPACING },
      }),
    );
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /grid\.policy\.widthTicks is/u);
  });
});

/* -------------------------------------------------------------------------- */
/* C2 — the re-sign guard's four checks                                       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.7/C2: the re-sign guard in policy mode", () => {
  /** Arm a policy grid, then hand back a fixture with one live level. */
  async function armed(): Promise<Fixture> {
    const f = await fixture();
    const response = await armCall(f, policyGrid());
    assert.equal(response.status, 200);
    return f;
  }

  it("check 2: a live rung REPRODUCIBLE from the new policy is admitted", async () => {
    const f = await armed();
    // A REQUOTED rung — equal to no signed range, but the policy's own width
    // and spacing-aligned. Exact-tick membership is meaningless here; that is
    // the price of policy mode, stated rather than hidden.
    f.chain.snapshot = snapshotAt({ tickLower: 3_000, tickUpper: 3_000 + WIDTH });
    f.chain.tick = 2_000;
    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 200, reason(response.body));
  });

  it("check 2: a live rung of the WRONG WIDTH is refused", async () => {
    const f = await armed();
    f.chain.snapshot = snapshotAt({ tickLower: 3_000, tickUpper: 3_000 + WIDTH + SPACING });
    f.chain.tick = 2_000;
    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /not reproducible from the NEW grid\.policy/u);
  });

  it("check 3: a live BUY rung on the side that no longer charges the quote is refused", async () => {
    const f = await armed();
    // The rung is reproducible, but the price has left it BEHIND on the wrong
    // side — under Case B a buy rung must be ABOVE the tick.
    f.chain.snapshot = snapshotAt({ tickLower: 3_000, tickUpper: 3_000 + WIDTH });
    f.chain.tick = 9_000;
    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /does not charge the asset a buy level holds/u);
  });

  it("C12(c): check 4 prices the SIGNED counter-rung — narrowing it REFUSES", async () => {
    const f = await armed();
    // A drifted (requoted) live BUY rung, still on the right side.
    f.chain.snapshot = snapshotAt({ tickLower: 3_000, tickUpper: 3_000 + WIDTH });
    f.chain.tick = 2_000;
    // The owner now re-signs the SELL rung right up against the live one, so
    // the pair the plane will actually trade earns nothing. A gate that priced
    // a policy-DERIVED counter-rung instead would wave this through, because a
    // policy derivation always reproduces the signed spread.
    const narrowed = gridDeriveRanges({
      currentTick: ANCHOR,
      tickSpacing: SPACING,
      gapTicks: GAP,
      widthTicks: WIDTH,
      wbnbIsToken0: true,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    });
    const response = await settingsCall(
      f,
      policyGrid({
        buyRange: narrowed.buyRange,
        sellRange: narrowed.sellRange,
        // A floor no spread of this size can clear once the gas floor is
        // inflated by the signed requote budget.
        minNetEdgeBps: 9_000,
      }),
    );
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Grid re-sign refused/u);
    assert.match(reason(response.body), /gas floor/u);
  });

  it("check 4's floor is the REQUOTE-INFLATED one (2 + 2R submissions)", async () => {
    const f = await armed();
    f.chain.snapshot = snapshotAt({ tickLower: 3_000, tickUpper: 3_000 + WIDTH });
    f.chain.tick = 2_000;
    const response = await settingsCall(f, policyGrid({ minNetEdgeBps: 9_000 }));
    assert.equal(response.status, 400);
    // `2 + 2 x 12 = 26`, printed by the refusal itself: the count is not a
    // hidden constant, it is the number the owner signed multiplied out.
    assert.match(reason(response.body), /26 submissions x/u);
  });
});

/* -------------------------------------------------------------------------- */
/* M7 — the fixed→policy identity backfill                                    */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 M7: the mode switch backfills identity, or refuses entirely", () => {
  /**
   * A row written DIRECTLY on the store with NO identity columns — the shape a
   * grid armed under 3.16/3.17 leaves behind, which is exactly what the
   * migration exists for. Going through the arm would write the columns and
   * there would be nothing to backfill.
   */
  async function legacyRow(f: Fixture, positionId: string): Promise<void> {
    await f.lpStore.createPosition({
      positionId,
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: MINTED_TOKEN_ID,
      basisWei: 0n,
      basisSource: "minted",
    });
    const stored = await f.lpStore.getPosition(ownerAccount.address, AGENT_ID, positionId);
    assert.equal(stored?.gridLevel, null, "the migration's own precondition");
    assert.equal(stored?.gridRole, null);
  }

  it("a live level whose ticks still match is BACKFILLED at the re-sign", async () => {
    const f = await fixture({ settingsGrid: grid() });
    await legacyRow(f, "legacy-1");
    // The last moment the match is provable: the live rung still equals a
    // signed rung exactly, so `gridLiveRole` can answer.
    f.chain.snapshot = snapshotAt(DERIVED.buyRange);
    f.chain.tick = ANCHOR;

    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 200, reason(response.body));
    const after = await f.lpStore.getPosition(ownerAccount.address, AGENT_ID, "legacy-1");
    assert.equal(after?.gridLevel, 1);
    assert.equal(after?.gridRole, "buy");
  });

  it("a live level matching NO signed rung refuses the WHOLE re-sign", async () => {
    const f = await fixture({ settingsGrid: grid() });
    await legacyRow(f, "legacy-2");
    // Manual interference, or a rung that already drifted: nothing can say
    // which level this is, and a half-labelled dual grid is worse than an
    // unchanged one — so the WHOLE re-sign is refused.
    f.chain.snapshot = snapshotAt({ tickLower: 30_000, tickUpper: 30_000 + WIDTH });
    f.chain.tick = 29_000;

    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Cannot switch this grid to policy mode/u);
    assert.match(reason(response.body), /LAST moment that match is provable/u);
    // And NOTHING was written: a refused re-sign leaves no column touched.
    const after = await f.lpStore.getPosition(ownerAccount.address, AGENT_ID, "legacy-2");
    assert.equal(after?.gridLevel, null);
    assert.equal(after?.gridRole, null);
  });

  it("a FIXED re-sign never backfills — the columns stay as they were", async () => {
    const f = await fixture({ settingsGrid: grid() });
    await legacyRow(f, "legacy-3");
    f.chain.snapshot = snapshotAt(DERIVED.buyRange);
    const response = await settingsCall(f, grid({ minNetEdgeBps: 1 }));
    assert.equal(response.status, 200, reason(response.body));
    const after = await f.lpStore.getPosition(ownerAccount.address, AGENT_ID, "legacy-3");
    assert.equal(after?.gridLevel, null, "fixed mode ignores the columns entirely");
  });
});

/* -------------------------------------------------------------------------- */
/* R2.5 — the import door                                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.5: policy mode is NON-RESTARTABLE BY IMPORT", () => {
  it("the import preview refuses with the MODE reason, not a tick mismatch", async () => {
    const f = await fixture({ settingsGrid: policyGrid() });
    const envelope = await signOwnerAction("read", {}, { agentId: AGENT_ID });
    const response = await call(
      f.harness,
      `/agents/${AGENT_ID}/lp/importable/${MINTED_TOKEN_ID}`,
      {
        headers: {
          "x-owner-action": Buffer.from(JSON.stringify(envelope)).toString("base64url"),
        },
      },
    );
    // Whichever surface answers, it must NEVER be the tick-mismatch text: in
    // policy mode that sentence is advice to leave policy mode (C1's list).
    assert.doesNotMatch(reason(response.body), /must be one of the signed ranges VERBATIM/u);
  });

  it("POST /lp/import refuses a policy-mode grid by MODE", async () => {
    const f = await fixture({ settingsGrid: policyGrid() });
    f.chain.snapshot = snapshotAt(DERIVED.buyRange);
    const params = { tokenId: MINTED_TOKEN_ID, basisWei: "0" };
    const envelope = await signOwnerAction("lpImport", params, { agentId: AGENT_ID });
    const response = await call(f.harness, `/agents/${AGENT_ID}/lp/import`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /non-restartable by import in v1/u);
    // The REMEDY must survive `sanitizeMessage`'s 280-char cap — the whole
    // reason this text is short (the 3.13 R1/R2 residual, unfixed platform-wide).
    assert.match(reason(response.body), /gridArm again/u);
  });

  it("a FIXED grid's import door is unchanged", async () => {
    const f = await fixture({ settingsGrid: grid() });
    f.chain.snapshot = snapshotAt({ tickLower: 30_000, tickUpper: 30_500 });
    const params = { tokenId: MINTED_TOKEN_ID, basisWei: "0" };
    const envelope = await signOwnerAction("lpImport", params, { agentId: AGENT_ID });
    const response = await call(f.harness, `/agents/${AGENT_ID}/lp/import`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 400);
    // The 3.15 sentence, byte for byte — a fixed grid must not learn the policy
    // vocabulary.
    assert.match(reason(response.body), /equals none of this grid's signed ranges/u);
  });
});
