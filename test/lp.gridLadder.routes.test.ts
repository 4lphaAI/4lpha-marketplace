/**
 * PHASE3.19 — the OWNER-SIGNED surfaces in LADDER mode.
 *
 * The fixture pattern is `test/lp.gridRequote.routes.test.ts`'s — the shared
 * server harness over memory stores and a fake chain. THE SHARED FIXTURE'S POOL
 * IS CASE B (`WBNB` sorts into token0), so the quote-holding BUY rung sits ABOVE
 * the price at the anchor tick.
 *
 * ─── WHAT THIS FILE OWES ──────────────────────────────────────────────────
 *
 *  - item 35 / H5 / OQ6: the MODE-CHANGE REFUSAL under a live level, in BOTH
 *    directions across the ladder pairs — and the DECLARED DEVIATION that
 *    `fixed <-> policy` stays legal, because 3.18's M7 backfill exists exactly
 *    for that transition and is a shipped, tested migration;
 *  - item 37: the `levels` cross-rule's LADDER branch, in both directions;
 *  - item 3: a session granted before this phase is refused AT THE ROUTE with
 *    its remedy, rather than failing at the wrap with a provider code;
 *  - items 25/28: ONE net-edge evaluation, on the DEPLOYED rung, at the ladder's
 *    own `submissionsPerCycle`, and the minimum-budget refusal that prints both
 *    relay figures;
 *  - item 26: the markout floor refused at the route, where the rail config is;
 *  - R3.1/C2 + C4: the arm writes TWO rows, both `gridLevel: 1`, role-distinct,
 *    sharing one `arm_group_id`, with the BUY row as the book ANCHOR.
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
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import {
  DEFAULT_LP_SETTINGS,
  type LpAutomationSettings,
  type LpGridLadder,
  type LpGridSettings,
} from "../src/lp/triggers.js";

const AGENT_ID = "agent-grid-ladder";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const INTERVAL_MS = 60_000;

const SPACING = 50;
/**
 * A WIDE gap, for the reason the 3.18 fixture states: the ladder's own
 * `submissionsPerCycle` is 42 at `maxMovesPerDay: 12` with the hedge on, so the
 * geometry has to clear a 42-submission gas floor before any OTHER rule can be
 * tested. Sizing the fixture to clear it is what keeps the admission from
 * refusing everything first.
 */
const GAP = 6_000;
const WIDTH = 1_000;
const ANCHOR = 0;
const BUDGET = 10n ** 19n;

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

const DERIVED = gridDeriveRanges({
  currentTick: ANCHOR,
  tickSpacing: SPACING,
  gapTicks: GAP,
  widthTicks: WIDTH,
  wbnbIsToken0: true,
  minTick: MIN_TICK,
  maxTick: MAX_TICK,
});

/** The route's own floor: pool fee (25 bps) + the saga slippage rail (100). */
const MARKOUT_FLOOR = 125;

const LADDER: LpGridLadder = {
  gapTicks: GAP,
  widthTicks: WIDTH,
  deployPctBps: 3_000,
  driftPctOfGap: 60,
  maxMovesPerDay: 12,
  hedge: { enabled: true, minMarkoutBps: MARKOUT_FLOOR, maxHedgePctBps: 5_000 },
};

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

function ladderGrid(overrides: Partial<LpGridLadder> = {}): LpGridSettings {
  return grid({
    maxFlipsPerDay: 1,
    mode: "ladder",
    ladder: { ...LADDER, ...overrides },
  });
}

function policyGrid(): LpGridSettings {
  return grid({
    mode: "policy",
    policy: { gapTicks: GAP, widthTicks: WIDTH },
    requote: { driftPctOfGap: 60, maxRequotesPerDay: 12 },
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
    minMinutesBetweenExits: 5,
    ...overrides,
    grid: gridBlock,
  });
}

/**
 * The session, WITH the ladder's WBNB `deposit()` rule unless a test drops it.
 * Item 3's route refusal is about exactly this rule's absence.
 */
function lpSessionFacts(expiresAt: number, withDeposit = true): SessionFacts {
  return {
    spec: {
      allowedCalls: [
        { to: ROUTER_V3 },
        { to: TOKEN, selector: "approve(address,uint256)" },
        { to: WBNB, selector: "approve(address,uint256)" },
        ...(withDeposit ? [{ to: WBNB, selector: "deposit()" }] : []),
      ],
      spendCaps: [
        { limit: 10n ** 20n, period: "day" },
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
  /** PHASE3.20 item 26: exposed additively so the owner view's two-sidedness
   * fields can be driven from the STAMPS the worker persists — the same
   * evidence the trigger writes, never a recomputation. */
  readonly observations: MemoryLpObservationStore;
  readonly chain: {
    snapshot: LpPositionSnapshot | "burned";
    tick: number;
    owner: Address | "burned";
  };
};

async function fixture(
  options: {
    readonly settingsGrid?: LpGridSettings | null;
    readonly withDeposit?: boolean;
  } = {},
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
      spotSqrtPriceX96: getSqrtRatioAtTick(chain.tick),
      twapSqrtPriceX96: getSqrtRatioAtTick(chain.tick),
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
      // Case B: the arm's own swap raises the tick, so a post-swap price well
      // above the SELL rung's near edge satisfies the one-spacing clearance.
      quoteWithPriceAfter: async (params: { amountInWei: bigint }) => ({
        amountOutWei: params.amountInWei,
        sqrtPriceX96After: getSqrtRatioAtTick(ANCHOR + 100),
      }),
      walletTokenBalance: async (): Promise<bigint> => 10n ** 18n,
      receipts: {
        collectAmounts: async (): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> => ({
          amount0Wei: 0n,
          amount1Wei: 0n,
        }),
        swapAmounts: async (): Promise<{
          tokenIn: Address;
          amountInWei: bigint;
          tokenOut: Address;
          amountOutWei: bigint;
        }> => ({
          tokenIn: WBNB,
          amountInWei: BUDGET / 2n,
          tokenOut: TOKEN,
          amountOutWei: BUDGET / 2n,
        }),
        mintedTokenId: async (): Promise<bigint> => 777n,
        mintedTokenIds: async (): Promise<readonly bigint[]> => [777n, 778n],
      },
      onChainNativeDailyCapWei: async (): Promise<bigint> => 10n ** 20n,
    },
  };

  const harness = await createHarness({ lp });
  await harness.agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600, options.withDeposit ?? true),
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
  return { harness, lpStore, settingsStore, observations, chain };
}

async function armCall(
  f: Fixture,
  gridBlock: LpGridSettings,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = {
    settings: settingsWith(gridBlock),
    budgetWei: BUDGET.toString(10),
    ...extra,
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

/** A live grid position on the SIGNED buy rung, as an arm would have left it. */
async function seedLiveLevel(f: Fixture, role: "buy" | "sell" = "buy"): Promise<void> {
  await f.lpStore.createPosition({
    positionId: "live-1",
    agentId: AGENT_ID,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    tokenId: "900",
    basisWei: 0n,
    basisSource: "minted",
    gridLevel: 1,
    gridRole: role,
  });
}

/* -------------------------------------------------------------------------- */
/* Item 37 — the `levels` cross-rule's ladder branch                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 37: `levels` under ladder mode", () => {
  it("a ladder arm WITHOUT levels: 2 is refused with its own reason", async () => {
    const f = await fixture();
    const response = await armCall(f, ladderGrid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /arms TWO rows — one per side/u);
  });

  it("a ladder arm WITH levels: 2 is admitted — the DUAL branch does not apply", async () => {
    // The dual branch requires `buyRange2`/`sellRange2`, which item 14 REFUSES
    // under ladder mode, so without the ladder branch every ladder arm would be
    // refused by the wrong rule.
    const f = await fixture();
    const response = await armCall(f, ladderGrid(), { levels: 2 });
    assert.equal(response.status, 200, reason(response.body));
  });
});

/* -------------------------------------------------------------------------- */
/* Item 3 — the re-grant precondition                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 3: a pre-3.19 session is refused at the ROUTE", () => {
  it("names the remedy instead of failing at the wrap with a provider code", async () => {
    const f = await fixture({ withDeposit: false });
    const response = await armCall(f, ladderGrid(), { levels: 2 });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /granted before ladder mode/u);
    assert.match(reason(response.body), /Re-grant the session/u);
    assert.match(reason(response.body), /nothing was spent/u);
  });
});

/* -------------------------------------------------------------------------- */
/* R3.1 / C2 / C4 — the two rows the arm writes                               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 R3.1/C4: the arm's two rows", () => {
  it("BOTH carry gridLevel 1, are role-distinct, share an arm_group_id, and the BUY row is the ANCHOR", async () => {
    const f = await fixture();
    const response = await armCall(f, ladderGrid(), { levels: 2 });
    assert.equal(response.status, 200, reason(response.body));
    const rows = await f.lpStore.listPositions(ownerAccount.address, AGENT_ID);
    assert.equal(rows.length, 2);
    // N1's repair, structural: a `gridLevel: 2` row would resolve to `null` for
    // ever, because item 14 refuses the second pair and `gridRoleAtFor` demands
    // one for level 2.
    assert.deepEqual(
      rows.map((row) => row.gridLevel).sort(),
      [1, 1],
    );
    assert.deepEqual(
      rows.map((row) => row.gridRole).sort(),
      ["buy", "sell"],
    );
    const groups = new Set(rows.map((row) => row.armGroupId));
    assert.equal(groups.size, 1);
    assert.notEqual([...groups][0], null);
    // C4: ONE book, on the FIRST-CREATED (BUY) row; the sibling's stay null.
    const anchors = rows.filter((row) => row.inventoryBaseWei !== null);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]?.gridRole, "buy");
    // C6 — THE SEED, from the arm's OWN CONFIRMED SWAP RECEIPT. Without it the
    // first hedge would find an empty book, the markout gate would refuse for
    // ever, and the mode's own restorer would never fire. The figures are the
    // fake receipt's exactly: nothing is estimated.
    assert.equal(anchors[0]?.inventoryBaseWei, BUDGET / 2n);
    assert.equal(anchors[0]?.inventoryCostWbnbWei, BUDGET / 2n);
    const credits = await f.lpStore.sumInventoryCredits(
      ownerAccount.address,
      AGENT_ID,
      anchors[0]?.positionId ?? "",
    );
    assert.equal(credits.count, 1, "the seed is ONE keyed credit, not an unguarded +=");
    // B4: both rows record `basisWei: 0n` + `basisSource: "minted"`.
    for (const row of rows) {
      assert.equal(row.basisWei, 0n);
      assert.equal(row.basisSource, "minted");
    }
  });

  it("the receipt reports the deployed-vs-idle split, and it sums to the budget", async () => {
    const f = await fixture();
    const response = await armCall(f, ladderGrid(), { levels: 2 });
    assert.equal(response.status, 200, reason(response.body));
    const data = response.body["data"] as Record<string, unknown>;
    const gridView = data["grid"] as Record<string, unknown>;
    const ladderView = gridView["ladder"] as Record<string, unknown>;
    assert.equal(ladderView["deployPctBps"], 3_000);
    assert.equal(ladderView["idlePctBps"], 7_000);
    const swapIn = BigInt(ladderView["swapInWei"] as string);
    const buy = BigInt(ladderView["deployedBuyWei"] as string);
    const idle = BigInt(ladderView["idleQuoteWei"] as string);
    assert.equal(swapIn + buy + idle, BUDGET);
    assert.equal(gridView["levels"], 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Items 25/28/26 — the admission                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 25/28/26: the ladder's admission", () => {
  it("item 28: a budget under the minimum is refused, naming BOTH relay figures", async () => {
    const f = await fixture();
    const params = {
      settings: settingsWith(ladderGrid()),
      budgetWei: "1000",
    };
    const envelope = await signOwnerAction("gridArm", params, { agentId: AGENT_ID });
    const response = await call(f.harness, `/agents/${AGENT_ID}/lp/grid/arm`, {
      method: "POST",
      body: { ...envelope, params: { ...params, levels: 2 } },
    });
    // The envelope's own params carry `levels`, so re-sign rather than patch.
    const signed = await signOwnerAction(
      "gridArm",
      { ...params, levels: 2 },
      { agentId: AGENT_ID },
    );
    const refused = await call(f.harness, `/agents/${AGENT_ID}/lp/grid/arm`, {
      method: "POST",
      body: signed,
    });
    void response;
    assert.equal(refused.status, 400);
    // C9: BOTH relay figures survive the 280-char cap, because the gap between
    // them is what decides whether a small wallet can arm at all.
    assert.match(refused.body ? reason(refused.body) : "", /this ladder needs \d+ wei/u);
    assert.match(reason(refused.body), /shipped 100000000000000 wei\/submission pad/u);
    // PHASE3.20 C8 DECLARED EDIT (a THIRD assertion the pad's retirement
    // falsifies; the clearance named two). The fixture is LEGACY-signed, so
    // `ladderMotionCounts` reads `{settlements: 12, drift: 0}` and the exact
    // two-lane bound is `2*12 + 12 = 36` where 3.19's padded one was 42. The
    // property under test — the submissions-per-cycle figure is PRINTED and
    // survives the 280-char cap — is unchanged.
    assert.match(reason(refused.body), /36\/cycle/u);
    assert.match(reason(refused.body), /measured 38800000000000/u);
    assert.match(reason(refused.body), /Remedy: raise the budget/u);
  });

  it("item 26: a minMarkoutBps under the pool's own execution cost is refused", async () => {
    const f = await fixture();
    const response = await armCall(
      f,
      ladderGrid({ hedge: { ...LADDER.hedge, minMarkoutBps: MARKOUT_FLOOR - 1 } }),
      { levels: 2 },
    );
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /under this pool's own execution cost/u);
    assert.match(reason(response.body), /fee paid twice/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 35 — the mode-change refusal                                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 35 (H5/OQ6): a mode change under a LIVE level", () => {
  it("ladder -> policy is REFUSED, which is the transition that passes every C2 check", async () => {
    const f = await fixture({ settingsGrid: ladderGrid() });
    await seedLiveLevel(f);
    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /signed under mode "ladder"/u);
    assert.match(reason(response.body), /Changing the mode to "policy"/u);
    assert.match(reason(response.body), /Stand the levels down/u);
  });

  it("policy -> ladder is REFUSED too — the guard is symmetric", async () => {
    const f = await fixture({ settingsGrid: policyGrid() });
    await seedLiveLevel(f);
    const response = await settingsCall(f, ladderGrid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /signed under mode "policy"/u);
    assert.match(reason(response.body), /Changing the mode to "ladder"/u);
  });

  it("ladder -> fixed is REFUSED EXPLICITLY, not by accident", async () => {
    // H5's note: `ladder -> fixed` is already refused because a floated rung
    // matches no signed rung — but an accident is not a guard, and the sentence
    // an owner reads should name the mode change rather than the tick mismatch.
    const f = await fixture({ settingsGrid: ladderGrid() });
    await seedLiveLevel(f);
    const response = await settingsCall(f, grid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Changing the mode to "fixed"/u);
  });

  it("a mode change with NO live level stays LEGAL — that is the restart path", async () => {
    const f = await fixture({ settingsGrid: ladderGrid() });
    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 200, reason(response.body));
  });

  it("DEVIATION D-1: `fixed -> policy` under a live level is STILL legal (3.18 M7)", async () => {
    // Item 35's literal "all six ordered pairs" would refuse this — and it is a
    // SHIPPED, TESTED migration: M7's backfill runs at exactly this moment,
    // because it is the last instant a live rung's identity is provable by tick
    // match. The guard is therefore scoped to pairs involving `ladder`, and this
    // pins the carve-out so a later reader does not "complete" the symmetry.
    const f = await fixture({ settingsGrid: grid() });
    await seedLiveLevel(f);
    const response = await settingsCall(f, policyGrid());
    assert.equal(response.status, 200, reason(response.body));
    const row = await f.lpStore.getPosition(ownerAccount.address, AGENT_ID, "live-1");
    assert.equal(row?.gridRole, "buy");
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.20 D5 / item 26 — TWO-SIDEDNESS IN THE OWNER VIEW                   */
/* -------------------------------------------------------------------------- */

/**
 * §5(6) and item 26, at the REAL route.
 *
 * The view answers from the stranding stamps the WORKER persists, never from a
 * recomputation — position rows carry no ticks (3.17 R2.5), so recomputing is
 * not merely duplicative here, it is impossible. That is also what makes the
 * dashboard structurally incapable of disagreeing with the gate (the 3.3 A3
 * lesson), which matters more now that D3 has REMOVED the rolled-back rows that
 * used to be the only durable trace of a ladder that wanted to move and could
 * not (OQ4's declared consequence).
 */
describe("PHASE3.20 item 26: the owner view reports twoSided, for how long, and why", () => {
  async function seedTwoRows(f: Fixture): Promise<void> {
    for (const [positionId, tokenId, role] of [
      ["ladder-buy", "901", "buy"],
      ["ladder-sell", "902", "sell"],
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
        gridLevel: 1,
        gridRole: role,
        armGroupId: "arm-group-3-20",
      });
    }
  }

  async function stamp(f: Fixture, positionId: string, sinceMs: number): Promise<void> {
    await f.observations.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId,
      observation: {
        blockNumber: 100n,
        evaluatedAtMs: sinceMs,
        poolAddress: POOL,
        protectConsecutive: 0,
        rotationBreach: false,
        rotationConsecutive: 0,
        gridMismatchSinceMs: sinceMs,
        tokenId: positionId === "ladder-buy" ? "901" : "902",
      },
    });
  }

  async function viewGrid(f: Fixture): Promise<Record<string, unknown>> {
    const envelope = await signOwnerAction("read", {}, { agentId: AGENT_ID });
    const response = await call(f.harness, `/agents/${AGENT_ID}/lp`, {
      headers: {
        "x-owner-action": Buffer.from(JSON.stringify(envelope)).toString("base64url"),
      },
    });
    const data = (response.body["data"] ?? {}) as Record<string, unknown>;
    return (data["grid"] ?? {}) as Record<string, unknown>;
  }

  it("a ladder with NO stranded rung is twoSided, blocked by nothing", async () => {
    const f = await fixture({ settingsGrid: ladderGrid() });
    await seedTwoRows(f);
    const view = await viewGrid(f);
    assert.equal(view["twoSided"], true);
    assert.equal(view["oneSidedBlockedBy"], "none");
    assert.equal(view["oneSidedForMinutes"], undefined);
  });

  it("a stranded rung makes it one-sided, and the DURATION comes from the worker's own stamp", async () => {
    const f = await fixture({ settingsGrid: ladderGrid() });
    await seedTwoRows(f);
    // The worker's frozen cycle clock is what wrote this; the view subtracts.
    await stamp(f, "ladder-sell", NOW_SEC * 1_000 - 30 * 60_000);
    const view = await viewGrid(f);
    assert.equal(view["twoSided"], false);
    assert.equal(view["oneSidedForMinutes"], 30);
    // The residual DECLARED at the seam: this route takes no pool-state read, so
    // it cannot price `minRungWei` against the buffer. With neither gate closed
    // the answer is the terminal state B1 names — the only explanation left for
    // a rung that is neither moving nor gated.
    assert.equal(view["oneSidedBlockedBy"], "funding");
    assert.equal(view["maxStrandedMinutes"], 45);
  });

  it("§5(6): clearing the stamp — what a settled fill does — returns twoSided to true", async () => {
    const f = await fixture({ settingsGrid: ladderGrid() });
    await seedTwoRows(f);
    await stamp(f, "ladder-sell", NOW_SEC * 1_000 - 30 * 60_000);
    assert.equal((await viewGrid(f))["twoSided"], false);
    // A settlement re-places the rung on its role's own side, the next cycle's
    // reading is affirmatively not mismatched, and the codec drops the key.
    await f.observations.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: "ladder-sell",
      observation: {
        blockNumber: 101n,
        evaluatedAtMs: NOW_SEC * 1_000,
        poolAddress: POOL,
        protectConsecutive: 0,
        rotationBreach: false,
        rotationConsecutive: 0,
        tokenId: "902",
      },
    });
    const view = await viewGrid(f);
    assert.equal(view["twoSided"], true);
    assert.equal(view["oneSidedBlockedBy"], "none");
  });

  it("item 29: the LANES are reported as they are ENFORCED, legacy reading included", async () => {
    const f = await fixture({ settingsGrid: ladderGrid() });
    await seedTwoRows(f);
    const lanes = (await viewGrid(f))["lanes"] as Record<string, unknown>;
    // The fixture is LEGACY-signed, so the view must say what the worker will
    // actually do: settle up to 12 fills a day, and NEVER chase. A silent
    // capability removal is worse than a refusal.
    assert.equal(lanes["settlementsPerDay"], 12);
    assert.equal(lanes["driftMovesPerDay"], 0);
    assert.equal(lanes["legacyForm"], true);
  });
});
