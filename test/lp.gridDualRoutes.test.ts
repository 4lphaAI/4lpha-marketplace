/**
 * PHASE3.17 — the DUAL grid arm at the ROUTE seam, plus the surfaces two levels
 * break: the re-sign guard, the owner view and the abandon door.
 *
 * The fixture pattern is `test/lp.gridArmRoutes.test.ts`'s — the shared server
 * harness over memory stores and a fake chain — with three additions the dual
 * arm needs: a `quoteWithPriceAfter` reader whose post-swap tick the test
 * drives, a `mintedTokenIds` receipt reader, and a per-token session cap the
 * C12 pre-check can be starved of.
 *
 * THE SHARED FIXTURE'S POOL IS CASE A: `WBNB` is `0x2222…` and `TOKEN` is
 * `0x5555…`, so WBNB sorts into token0 and `wbnbIsToken0 === true`. Under that
 * orientation the quote-holding BUY rung sits ABOVE the price and level 2's
 * base-holding SELL rung sits BELOW it, with the tick in the corridor between.
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
import type { SessionSpec } from "../src/core/types.js";
import type { LpPoolStateReading, LpServerDeps } from "../src/server.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { MemoryLpGridCycleStore } from "../src/store/gridCycles.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { gridDeriveDualRanges, gridDualSwapInWei } from "../src/lp/gridTriggers.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  DEFAULT_LP_SETTINGS,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridSettings,
} from "../src/lp/triggers.js";

const AGENT_ID = "agent-grid-dual";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const SELL_TOKEN_ID = "880";
const BUY_TOKEN_ID = "881";
const BUDGET = 10n ** 17n;
const INTERVAL_MS = 60_000;
const SPACING = 50;

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

/** The four rungs, derived at tick 0 exactly as `live-grid arm --levels 2` does. */
const FOUR = gridDeriveDualRanges({
  currentTick: 0,
  tickSpacing: SPACING,
  gapTicks: 100,
  widthTicks: 200,
  wbnbIsToken0: true,
  minTick: MIN_TICK,
  maxTick: MAX_TICK,
});

/** The 3.15/3.16 two-rung shape, for the byte-identity and cross-rule pins. */
function singleGridBlock(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: SPACING,
    buyRange: FOUR.buyRange,
    sellRange: FOUR.sellRange,
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    ...overrides,
  };
}

function dualGridBlock(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    ...singleGridBlock(),
    buyRange2: FOUR.buyRange2,
    sellRange2: FOUR.sellRange2,
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

function lpSessionSpec(expiresAt: number, baseCapWei: bigint): SessionSpec {
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "approve(address,uint256)" },
    ],
    spendCaps: [
      { limit: 10n ** 18n, period: "day" },
      { limit: baseCapWei, period: "day", token: TOKEN },
      { limit: 2n ** 160n, period: "day", token: WBNB },
    ],
    expiresAt,
  };
}

function lpSessionFacts(expiresAt: number, baseCapWei: bigint): SessionFacts {
  return {
    spec: lpSessionSpec(expiresAt, baseCapWei),
    permissions: { calls: [], spend: [] },
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: expiresAt,
  };
}

function snapshotOf(range: { tickLower: number; tickUpper: number }): LpPositionSnapshot {
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
  readonly observations: MemoryLpObservationStore;
  readonly cycles: MemoryLpGridCycleStore;
  readonly chain: {
    /** Per-tokenId snapshots, so two live levels can differ. */
    snapshots: Map<string, LpPositionSnapshot | "burned">;
    fallbackSnapshot: LpPositionSnapshot | "burned";
    tick: number;
    postSwapTick: number;
    owner: Address | "burned";
    liveCapWei: bigint;
    quoteFails: boolean;
    plural: boolean;
  };
};

async function fixture(
  options: {
    readonly gridEnabled?: boolean;
    readonly settingsGrid?: LpGridSettings | null;
    readonly baseCapWei?: bigint;
  } = {},
): Promise<Fixture> {
  const lpStore = new MemoryLpSequenceStore();
  const settingsStore = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();
  const cycles = new MemoryLpGridCycleStore();
  const chain: Fixture["chain"] = {
    snapshots: new Map(),
    fallbackSnapshot: snapshotOf(FOUR.buyRange),
    tick: 0,
    // Case A: the swap moves the tick DOWN; -20 leaves a full spacing of
    // clearance to `sellRange2`'s near edge at -100.
    postSwapTick: -20,
    owner: ownerAccount.address,
    liveCapWei: 10n ** 18n,
    quoteFails: false,
    plural: true,
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
      spotSqrtPriceX96: getSqrtRatioAtTick(chain.tick),
      twapSqrtPriceX96: getSqrtRatioAtTick(chain.tick),
    },
  });

  const readers = {
    getPool: async (): Promise<Address> => POOL,
    poolState: async (): Promise<LpPoolStateReading> => state(),
    positions: async (tokenId: bigint): Promise<LpPositionSnapshot | "burned"> =>
      chain.snapshots.get(tokenId.toString(10)) ?? chain.fallbackSnapshot,
    positionFees: async (): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> => ({
      amount0Wei: 0n,
      amount1Wei: 0n,
    }),
    ownerOf: async (): Promise<Address | "burned"> => chain.owner,
    quote: async (params: { amountInWei: bigint }): Promise<bigint> => params.amountInWei,
    quoteWithPriceAfter: async (params: {
      amountInWei: bigint;
    }): Promise<{ amountOutWei: bigint; sqrtPriceX96After: bigint }> => {
      if (chain.quoteFails) throw new Error("quoter down");
      return {
        // ~10 bps of impact against the 1:1 spot: inside every rail.
        amountOutWei: (params.amountInWei * 9_990n) / 10_000n,
        sqrtPriceX96After: getSqrtRatioAtTick(chain.postSwapTick),
      };
    },
    receipts: {
      collectAmounts: async (): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> => ({
        amount0Wei: 0n,
        amount1Wei: 0n,
      }),
      swapAmounts: async (): Promise<never> => {
        throw new Error("the dual arm's swap amounts are never read back");
      },
      mintedTokenId: async (): Promise<bigint> => BigInt(BUY_TOKEN_ID),
      mintedTokenIds: async (): Promise<readonly bigint[]> => {
        if (!chain.plural) throw new Error("no plural reader");
        return [BigInt(SELL_TOKEN_ID), BigInt(BUY_TOKEN_ID)];
      },
    },
    onChainNativeDailyCapWei: async (): Promise<bigint> => chain.liveCapWei,
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

  const harness = await createHarness({ lp });
  await harness.agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600, options.baseCapWei ?? 2n ** 160n),
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

  // Both minted NFTs, so a completed dual arm can be verified per tokenId.
  chain.snapshots.set(BUY_TOKEN_ID, snapshotOf(FOUR.buyRange));
  chain.snapshots.set(SELL_TOKEN_ID, snapshotOf(FOUR.sellRange2));

  return { harness, lpStore, settingsStore, observations, cycles, chain };
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

async function settingsCall(
  f: Fixture,
  gridBlock: LpGridSettings | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction("lpSettings", settingsWith(gridBlock), {
    agentId: AGENT_ID,
  });
  return call(f.harness, `/agents/${AGENT_ID}/lp/settings`, {
    method: "POST",
    body: envelope,
  });
}

function dualParams(
  overrides: {
    readonly grid?: LpGridSettings | null;
    readonly budgetWei?: bigint;
    readonly levels?: number;
  } = {},
): Record<string, unknown> {
  return {
    settings: settingsWith(overrides.grid === undefined ? dualGridBlock() : overrides.grid),
    budgetWei: (overrides.budgetWei ?? BUDGET).toString(10),
    ...(overrides.levels === undefined ? { levels: 2 } : { levels: overrides.levels }),
  };
}

async function viewGrid(f: Fixture): Promise<Record<string, unknown>> {
  const envelope = await signOwnerAction("read", {}, { agentId: AGENT_ID });
  const response = await call(f.harness, `/agents/${AGENT_ID}/lp`, {
    headers: { "x-owner-action": toReadHeader(envelope) },
  });
  const data = (response.body["data"] ?? {}) as Record<string, unknown>;
  return (data["grid"] ?? {}) as Record<string, unknown>;
}

function reason(body: Record<string, unknown>): string {
  const error = body["error"] as { message?: string } | undefined;
  return error?.message ?? "";
}

function section(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const data = body["data"] as Record<string, unknown>;
  return (data[key] ?? {}) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* The happy path                                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17: POST /lp/grid/arm --levels 2 — one signature, two levels", () => {
  it("mints BOTH rungs in ONE submission and records two GROUPED rows", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, dualParams());
    assert.equal(response.status, 200, reason(response.body));

    const arm = section(response.body, "arm");
    assert.equal(arm["status"], "completed");
    assert.equal(arm["tokenId"], BUY_TOKEN_ID, "the row the sequence names gets mint#2");
    assert.equal(arm["siblingTokenId"], SELL_TOKEN_ID, "mint#1 is the SELL rung");
    assert.match(String(arm["note"]), /Both levels are live/u);

    // TWO rows, ONE group — the durable pairing every recovery path reads.
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.equal(positions.length, 2);
    const groups = new Set(positions.map((p) => p.armGroupId));
    assert.equal(groups.size, 1);
    assert.notEqual([...groups][0], null, "both rows carry the same non-null arm_group_id");
    assert.deepEqual(
      positions.map((p) => p.basisSource).sort(),
      ["minted", "minted"],
      "a ping-pong's inventory alternates assets, so neither row carries a value basis",
    );
    assert.deepEqual(positions.map((p) => p.basisWei), [0n, 0n]);
    assert.deepEqual(
      positions.map((p) => p.tokenId).sort(),
      [SELL_TOKEN_ID, BUY_TOKEN_ID].sort(),
    );

    // ONE sequence, naming the BUY row (level 1, the native-attaching level).
    const sequences = await f.lpStore.listSequences(ownerAccount.address, AGENT_ID);
    assert.equal(sequences.length, 1);
    assert.equal(sequences[0]?.kind, "grid-arm");
    assert.equal(sequences[0]?.state, "completed");
    const buyRow = positions.find((p) => p.tokenId === BUY_TOKEN_ID);
    assert.equal(sequences[0]?.positionId, buyRow?.positionId);

    // ONE submission, six calls, both values summing to the whole budget.
    assert.equal(f.harness.provider.executeCalls.length, 1);
    const calls = f.harness.provider.executeCalls[0]?.calls ?? [];
    assert.equal(calls.length, 6);
    assert.equal(
      calls.reduce((sum, c) => sum + (c.value ?? 0n), 0n),
      BUDGET,
      "the whole owner-signed budget is metered, not half of it",
    );
    assert.equal(calls[0]?.value, gridDualSwapInWei(BUDGET));
    assert.equal(calls[4]?.value, BUDGET - gridDualSwapInWei(BUDGET));
  });

  it("the receipt reports BOTH pairs' rungs and the honest sell-side asymmetry", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, dualParams());
    const grid = section(response.body, "grid");
    assert.equal(grid["levels"], 2);
    assert.equal(grid["splitBps"], 5_000);
    const armed = grid["armedLevels"] as Record<string, unknown>[];
    assert.equal(armed.length, 2);
    assert.equal(armed[0]?.["level"], 1);
    assert.equal(armed[0]?.["role"], "buy");
    assert.deepEqual(armed[0]?.["armedRange"], FOUR.buyRange);
    // C10: the OUTER rung where the counter-order will land, printed so the
    // owner sees it BEFORE the first fill puts an order there.
    assert.deepEqual(armed[0]?.["counterRange"], FOUR.sellRange);
    assert.equal(armed[1]?.["level"], 2);
    assert.equal(armed[1]?.["role"], "sell");
    assert.equal(armed[1]?.["chargesQuote"], false);
    assert.deepEqual(armed[1]?.["armedRange"], FOUR.sellRange2);
    assert.deepEqual(armed[1]?.["counterRange"], FOUR.buyRange2);
    assert.match(String(armed[1]?.["note"]), /SMALLER than level 1/u);
    // H5: the sell level is priced on the CONSERVATIVE lower bound, and it is
    // strictly below the buy level's size. Nothing hides the asymmetry.
    assert.ok(
      BigInt(String(armed[1]?.["sizeWei"])) < BigInt(String(armed[0]?.["sizeWei"])),
    );
    // C2: one net-edge verdict PER PAIR.
    assert.equal((grid["netEdges"] as unknown[]).length, 2);
    // M5: the PER-LEVEL flip budget, because maxFlipsPerDay is agent-wide.
    assert.match(String(grid["firstFlipFloor"]), /AGENT-WIDE and counts BOTH levels/u);
    assert.match(String(grid["firstFlipFloor"]), /each level gets about 6 flips a day/u);
  });

  it("sizing reserves TWO positions' protect gas, not one", async () => {
    // Ruling Q4: `P = max(1, openPositionsCount)` feeds the A3 reserve, and an
    // armed level's protect burns the same relay gas whichever level it is.
    // Starve the cap to just below what TWO rows need and the arm refuses.
    const f = await fixture({ gridEnabled: true });
    const generous = await armCall(f, dualParams());
    assert.equal(generous.status, 200);

    const tight = await fixture({ gridEnabled: true });
    // The whole budget plus one position's reserve, and no more.
    tight.chain.liveCapWei = BUDGET + 8n * 100_000_000_000_000n;
    const response = await armCall(tight, dualParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /daily native cap is short by/u);
    assert.equal(
      (await tight.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length,
      0,
      "the refusal is BEFORE either row is created",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R2.2 — the levels <=> pair-2 cross-rule, scoped to THIS route               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.2: levels and the second pair must agree, at the arm", () => {
  it("levels: 2 without pair-2 keys is refused", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, dualParams({ grid: singleGridBlock() }));
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /needs the settings' grid block to carry buyRange2 and sellRange2/u);
    assert.equal(await f.settingsStore.get(ownerAccount.address, AGENT_ID), null);
    assert.equal((await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("a four-rung grid armed at levels: 1 is refused — two rungs would be dead", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, dualParams({ levels: 1 }));
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /needs levels: 2/u);
    assert.match(reason(response.body), /two signed rungs no position will ever occupy/u);
  });

  it("levels other than 1 or 2 are refused at the PARSE, before any chain read", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, dualParams({ levels: 3 }));
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /"levels" must be 1 or 2/u);
  });

  it("an ABSENT levels field is 1 — every 3.16 envelope parses unchanged", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await armCall(f, {
      settings: settingsWith(singleGridBlock()),
      budgetWei: BUDGET.toString(10),
    });
    assert.equal(response.status, 200, reason(response.body));
    const arm = section(response.body, "arm");
    assert.equal(arm["status"], "completed");
    assert.equal(arm["siblingTokenId"], undefined);
    // TWO calls, not six: the single-sided arm's plan is untouched.
    assert.equal(f.harness.provider.executeCalls[0]?.calls.length, 2);
    assert.equal((await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length, 1);
    assert.equal(section(response.body, "grid")["armedLevels"], undefined);
  });

  it("R3.1: the cross-rule does NOT reach /lp/settings — a dual re-sign is supported", async () => {
    // An `lpSettings` envelope has no `levels` field at all, so the rule is
    // scoped to the gridArm ROUTE. That is what keeps settings-only re-signs of
    // a live dual grid the supported path, guarded by C2's multi-level form.
    const f = await fixture({ gridEnabled: true });
    const response = await settingsCall(f, dualGridBlock());
    assert.equal(response.status, 200, reason(response.body));
  });
});

/* -------------------------------------------------------------------------- */
/* R3.3 / C12 — the two route-seam gates a dual arm adds                       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R3.3: the SELL rung is gated at the ROUTE on the post-swap price", () => {
  it("a post-swap price under one spacing of clearance refuses PRE-MONEY", async () => {
    const f = await fixture({ gridEnabled: true });
    // -60 is strictly OUTSIDE `sellRange2` = [-300, -100) and charges the base
    // leg, so a pre-swap-shaped gate would admit it — but it leaves only 40
    // ticks of clearance to the near edge at -100, under one 50-tick spacing.
    f.chain.postSwapTick = -60;
    const response = await armCall(f, dualParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /SELL rung/u);
    assert.match(reason(response.body), /POST-SWAP price/u);
    assert.equal(f.harness.provider.executeCalls.length, 0, "nothing reached a relay");
    assert.equal(await f.settingsStore.get(ownerAccount.address, AGENT_ID), null);
    assert.equal((await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("an unreadable quoter refuses rather than gating on a price it does not have", async () => {
    const f = await fixture({ gridEnabled: true });
    f.chain.quoteFails = true;
    const response = await armCall(f, dualParams());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /could not be quoted/u);
  });
});

describe("PHASE3.17 C12: the base-token cap is a metering this arm INTRODUCES", () => {
  it("an undersized base cap is NAMED before any money, with owner-add-spend-limit", async () => {
    // 3.16's arm approves nothing at all. The dual batch's
    // `approve(base, nfpm, sellDesired)` meters against the base token's own
    // session cap, and an undersized one reverts the WHOLE atomic batch as an
    // opaque relay failure — fail-closed, gas only, with no remedy anywhere.
    const f = await fixture({ gridEnabled: true, baseCapWei: 1n });
    const response = await armCall(f, dualParams());
    assert.equal(response.status, 400);
    const text = reason(response.body);
    assert.match(text, /the session cap for 0x/u);
    assert.match(text, /would revert at the relay/u);
    // THE REMEDY MUST SURVIVE the 280-char cap — the whole reason the text is
    // ordered fact-first and evidence-last.
    assert.match(text, /add-spend-limit -- --cap <amount> for that token\./u);
    assert.ok(text.length <= 280, `the refusal is ${text.length} chars`);
    assert.equal(f.harness.provider.executeCalls.length, 0);
    assert.equal((await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)).length, 0);
  });

  it("a SINGLE-level arm is unaffected — it approves nothing and needs no base cap", async () => {
    const f = await fixture({ gridEnabled: true, baseCapWei: 1n });
    const response = await armCall(f, {
      settings: settingsWith(singleGridBlock()),
      budgetWei: BUDGET.toString(10),
    });
    assert.equal(response.status, 200, reason(response.body));
  });
});

/* -------------------------------------------------------------------------- */
/* R3.1 / C1 — the re-sign guard goes multi-level                              */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R3.1: C2 iterates EVERY live level, over all four rungs", () => {
  /** Two live levels, one on each pair's inner rung. */
  async function twoLiveLevels(f: Fixture): Promise<void> {
    for (const [positionId, tokenId, range] of [
      ["level-1", BUY_TOKEN_ID, FOUR.buyRange],
      ["level-2", SELL_TOKEN_ID, FOUR.sellRange2],
    ] as const) {
      await f.lpStore.createPosition({
        positionId,
        agentId: AGENT_ID,
        ownerAddress: ownerAccount.address,
        token0: WBNB,
        token1: TOKEN,
        fee: 2_500,
        tokenId,
        basisWei: 0n,
        basisSource: "minted",
        armGroupId: "group-1",
      });
      f.chain.snapshots.set(tokenId, snapshotOf(range));
    }
  }

  it("a re-sign that keeps BOTH levels matched is ACCEPTED, and prices each pair", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: dualGridBlock() });
    await twoLiveLevels(f);
    // Move only the two OUTER rungs — every live level still matches a signed
    // range, so nothing is stranded.
    const moved = dualGridBlock({
      sellRange: { tickLower: FOUR.sellRange.tickLower - 50, tickUpper: FOUR.sellRange.tickUpper - 50 },
      buyRange2: { tickLower: FOUR.buyRange2.tickLower + 50, tickUpper: FOUR.buyRange2.tickUpper + 50 },
    });
    const response = await settingsCall(f, moved);
    assert.equal(response.status, 200, reason(response.body));
    const grid = section(response.body, "grid");
    const levels = grid["liveLevels"] as Record<string, unknown>[];
    assert.equal(levels.length, 2, "EVERY live level is checked, not find-one");
    assert.deepEqual(levels.map((l) => l["level"]).sort(), [1, 2]);
    // Each level was priced on ITS OWN pair.
    for (const level of levels) {
      assert.equal((level["netEdge"] as Record<string, unknown>)["ok"], true);
    }
  });

  it("a re-sign that would STRAND level 2 is REFUSED — the state C2 exists to prevent", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: dualGridBlock() });
    await twoLiveLevels(f);
    // Clearing the second pair leaves level 2 matching nothing: `gridLiveRole`
    // would answer null, `buildGridFlipDeps` would throw, and the level would
    // be dead to automation until a manual exit.
    const response = await settingsCall(f, singleGridBlock());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /equals none of the NEW signed ranges/u);
    assert.match(reason(response.body), /Keep one range equal to each live level/u);
  });

  it("N1's own case: a LEGAL chain that moves level 2's rungs off it is still refused", async () => {
    // The precise defect review2 N1 found. This re-sign passes
    // `validateLpSettings` — the four-rung chain is intact — and level 1 still
    // matches its signed rung, so a `find`-one guard reading the FIRST live row
    // would wave it through. Level 2's live NFT then matches nothing:
    // `gridLiveRole` answers null, `buildGridFlipDeps` throws, and that level is
    // dead to automation until a manual exit. C2 must iterate EVERY level.
    const f = await fixture({ gridEnabled: true, settingsGrid: dualGridBlock() });
    await twoLiveLevels(f);
    const moved = dualGridBlock({
      sellRange2: {
        tickLower: FOUR.sellRange2.tickLower + 50,
        tickUpper: FOUR.sellRange2.tickUpper + 50,
      },
    });
    // The chain itself is legal — the pure validator does NOT refuse this.
    assert.doesNotThrow(() =>
      validateLpSettings({
        ...DEFAULT_LP_SETTINGS,
        autoRotate: false,
        autoHarvest: false,
        grid: moved,
      }),
    );
    const response = await settingsCall(f, moved);
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /equals none of the NEW signed ranges/u);
    assert.match(reason(response.body), /Keep one range equal to each live level/u);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.6 — the owner view                                                       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.6: the owner view renders TWO levels", () => {
  it("levels[] carries every live row, with per-level blockedBySequence", async () => {
    const f = await fixture({ gridEnabled: true });
    assert.equal((await armCall(f, dualParams())).status, 200);
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    const second = positions[1];
    assert.ok(second !== undefined);
    // A held flip on ONE level. Before R2.6 it was derived from the FIRST live
    // row alone, so a hold on the other level — including its disarm of that
    // level's price stop — was reported nowhere at all.
    await f.lpStore.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: second!.positionId,
      kind: "grid-flip",
    });

    const grid = await viewGrid(f);
    const levels = grid["levels"] as Record<string, unknown>[];
    assert.equal(levels.length, 2, "both rows render");
    assert.equal(levels[0]?.["blockedBySequence"], null);
    const blocked = levels[1]?.["blockedBySequence"] as Record<string, unknown>;
    assert.equal(blocked["kind"], "grid-flip");
    assert.match(String(blocked["note"]), /NO trigger fires — the price stop-loss included/u);
    // The singular `level` is kept, still reporting the FIRST live row, so a
    // one-level agent's view is byte-identical.
    assert.equal(
      (grid["level"] as Record<string, unknown>)["positionId"],
      levels[0]?.["positionId"],
    );
    // Both pairs' rungs are visible.
    assert.deepEqual(grid["buyRange2"], FOUR.buyRange2);
    assert.deepEqual(grid["sellRange2"], FOUR.sellRange2);
  });

  it("the PnL is partitioned by positionId, so one ledger is not read as one lineage", async () => {
    const f = await fixture({ gridEnabled: true });
    assert.equal((await armCall(f, dualParams())).status, 200);
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    const [first, second] = positions;
    assert.ok(first !== undefined && second !== undefined);
    // Two `to-buy` cycles for LEVEL 1 only. An unpartitioned delta would have
    // compared these against level 2's rows — a number about nothing.
    for (const [index, minted] of [[0, 100n], [1, 140n]] as const) {
      await f.cycles.record({
        sequenceId: `seq-${index}`,
        agentId: AGENT_ID,
        ownerAddress: ownerAccount.address,
        positionId: first!.positionId,
        direction: "to-buy",
        fromTickLower: FOUR.sellRange.tickLower,
        fromTickUpper: FOUR.sellRange.tickUpper,
        toTickLower: FOUR.buyRange.tickLower,
        toTickUpper: FOUR.buyRange.tickUpper,
        freedAmount0Wei: 0n,
        freedAmount1Wei: 0n,
        mintedAmount0Wei: minted,
        mintedAmount1Wei: 0n,
        residueWei: 0n,
        residueBps: 0n,
        fromTokenId: "1",
        toTokenId: "2",
        completedAtMs: 1_000 + index,
      });
    }
    const grid = await viewGrid(f);
    const levels = grid["levels"] as Record<string, unknown>[];
    const forFirst = levels.find((l) => l["positionId"] === first!.positionId);
    const forSecond = levels.find((l) => l["positionId"] === second!.positionId);
    assert.equal((forFirst?.["pnl"] as Record<string, unknown>)["realisedQuoteWei"], "40");
    assert.equal((forFirst?.["pnl"] as Record<string, unknown>)["overRoundTrips"], 1);
    assert.equal((forSecond?.["pnl"] as Record<string, unknown>)["realisedQuoteWei"], null);
    assert.equal((forSecond?.["pnl"] as Record<string, unknown>)["recordedCycles"], 0);
    // And the aggregate says plainly that it is not a per-level result.
    assert.match(
      String((grid["pnl"] as Record<string, unknown>)["note"]),
      /read levels\[\]\.pnl, which is partitioned by positionId/u,
    );
  });

  it("ONE DARK level reads as one dark, never as healthy and never as none", async () => {
    const f = await fixture({ gridEnabled: true });
    assert.equal((await armCall(f, dualParams())).status, 200);
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    await f.lpStore.setPositionState(
      ownerAccount.address,
      AGENT_ID,
      positions[1]!.positionId,
      "closed",
    );
    const grid = await viewGrid(f);
    assert.equal((grid["levels"] as unknown[]).length, 1);
    assert.match(String(grid["restart"]), /only ONE level is live/u);
    assert.match(String(grid["restart"]), /gridArm cannot top it up/u);
    assert.match(String(grid["restart"]), /L2 sell \[/u, "every signed rung is named");
  });

  it("NO live level still reads as the 3.16 restart sentence", async () => {
    const f = await fixture({ gridEnabled: true });
    assert.equal((await armCall(f, dualParams())).status, 200);
    for (const position of await f.lpStore.listPositions(ownerAccount.address, AGENT_ID)) {
      await f.lpStore.setPositionState(
        ownerAccount.address,
        AGENT_ID,
        position.positionId,
        "closed",
      );
    }
    const grid = await viewGrid(f);
    assert.equal((grid["levels"] as unknown[]).length, 0);
    assert.match(String(grid["restart"]), /^No live level\./u);
  });
});

/* -------------------------------------------------------------------------- */
/* The abandon door, through the ROUTE                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.3: the abandon route closes the WHOLE arm group", () => {
  it("both rows of a never-funded dual arm are closed, and re-arming works again", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: dualGridBlock() });
    // Two grouped rows and a HELD arm whose one step never got a journal row —
    // the crash window between `appendStep` and `beginWithSpend`, settled by
    // absence. Nothing was ever funded.
    for (const positionId of ["dual-a", "dual-b"]) {
      await f.lpStore.createPosition({
        positionId,
        agentId: AGENT_ID,
        ownerAddress: ownerAccount.address,
        token0: WBNB,
        token1: TOKEN,
        fee: 2_500,
        basisWei: 0n,
        basisSource: "minted",
        armGroupId: "group-x",
      });
    }
    const sequence = await f.lpStore.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: "dual-a",
      kind: "grid-arm",
    });
    await f.lpStore.appendStep(ownerAccount.address, AGENT_ID, sequence.sequenceId, {
      kind: "zap-in-mint",
      journalIdempotencyKey: "never-written-key",
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

    const envelope = await signOwnerAction(
      "abandonSequence",
      { sequenceId: sequence.sequenceId },
      { agentId: AGENT_ID },
    );
    const response = await call(
      f.harness,
      `/agents/${AGENT_ID}/lp/sequences/${sequence.sequenceId}/abandon`,
      { method: "POST", body: envelope },
    );
    assert.equal(response.status, 200, reason(response.body));
    const abandoned = section(response.body, "abandoned");
    assert.equal(abandoned["positionAction"], "close");

    // BOTH rows closed — without this the sibling stays `open` with a null
    // tokenId, invisible to the worker and unreachable by any exit, and the
    // arm's idle gate refuses every future re-arm for ever.
    const positions = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.deepEqual(positions.map((p) => p.state), ["closed", "closed"]);

    // And the restart path is reachable again: sign gridArm.
    const rearm = await armCall(f, dualParams());
    assert.equal(rearm.status, 200, reason(rearm.body));
  });
});
