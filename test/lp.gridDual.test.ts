/**
 * PHASE3.17 — the DUAL-LEVEL grid arm, at the PURE and SAGA seams.
 *
 * The pattern is `test/lp.gridArm.test.ts`'s, per-suite and local to this file:
 * a scripted provider that records every batch and THROWS on an unscripted
 * submit, memory stores, and a receipts fake that is the ONLY source of money
 * amounts. Nothing here extends the shared harness.
 *
 * The matrices this file owes (R2.10 + R3.6):
 *
 *   - DUAL ORIENTATION for every side-dependent thing. The crossed-pair chain,
 *     the corridor, role resolution, the batch, both floors and the post-swap
 *     gate all run on a Case-A pool (WBNB = token0) and a Case-B pool
 *     (WBNB = token1). A rule written in role order inverts for roughly half of
 *     BSC's WBNB pools — the 3.13 F7 / 3.15 H1 class, twice caught in this
 *     lineage.
 *   - THE H1 KILL TEST: a post-swap price at which the SELL rung's gate refuses
 *     and a pre-swap-only gate would have PASSED, in both orientations. Without
 *     it the whole atomic batch reverts on gas, systematically.
 *   - THE N2 KILL TEST: pair 2 narrow, pair 1 wide — the arm refuses, because
 *     `gridNetEdge` prices each level on ITS OWN pair's rungs.
 *   - THE TWO-ROW DISPOSITION: all six rollback classes, the UNKNOWN hold, the
 *     crash between the two tokenId writes, and the abandon — every one of them
 *     reaching BOTH rows through `arm_group_id` and never through the request.
 *   - THE SINGLE-LEVEL PATH, pinned byte-identical.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { runLpOpen } from "../src/lp/open.js";
import type {
  LpMarketReader,
  LpPositionSnapshot,
  LpReceiptReader,
  LpSagaDeps,
  LpSagaMarket,
} from "../src/lp/sagas.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import {
  GRID_DUAL_SPLIT_BPS,
  gridDeriveDualRanges,
  gridDualSellClearanceOk,
  gridDualSellSizeWei,
  gridDualSwapInWei,
  gridIsDual,
  gridLiveRole,
  gridNetEdge,
  gridNetEdgePair,
  gridPair,
  gridRangeList,
  gridSideChargesQuote,
  gridTargetRange,
  gridTargetSide,
  lpGridDualArmBuyRefusal,
  lpGridDualArmSellRefusal,
  lpGridNetEdgeRefusal,
} from "../src/lp/gridTriggers.js";
import {
  DEFAULT_LP_SETTINGS,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridRange,
  type LpGridSettings,
} from "../src/lp/triggers.js";
import { verifyLpAbandonSequence } from "../src/lp/abandonSequence.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import { sagaSwapMinOut } from "../src/lp/rails.js";
import { sanitizeMessage } from "../src/core/errors.js";
import {
  MemoryLpSequenceStore,
  lpStepDecisionId,
  type LpExitQuota,
} from "../src/store/lpSequences.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { executeIdempotencyKey } from "../src/auth/executeDecision.js";
import { hashCalls } from "../src/http/wire.js";
import { FakeWalletProvider } from "./support/serverHarness.js";
import type {
  ExecuteViaSessionParams,
  ExecutionReceipt,
} from "../src/core/types.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = OWNER;
const AGENT_ID = "grid-dual-agent";
/** LEVEL 1's row — the BUY rung, the native-attaching mint, the one the sequence names. */
const BUY_POSITION_ID = "grid-dual-buy";
/** LEVEL 2's row — the SELL rung, reached only through `arm_group_id`. */
const SELL_POSITION_ID = "grid-dual-sell";
const ARM_GROUP_ID = "arm-group-1";
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB ⇒ WBNB is token1 ⇒ Case B. */
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
/** Sorts ABOVE WBNB ⇒ WBNB is token0 ⇒ Case A. */
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const SESSION_KEY = `0x${"7d".repeat(32)}` as Hex;
const ARMED_DIGEST = `0x${"ab".repeat(32)}` as Hex;

const NOW_MS = 1_900_000_000_000;
const NOW_SEC = 1_900_000_000;
const BUDGET = 10n ** 17n;
const MINTED_LIQ = 10n ** 15n;
const SPACING = 50;
const SELL_TOKEN_ID = 4_100n;
const BUY_TOKEN_ID = 4_101n;
/**
 * `sanitizeMessage`'s platform-wide ceiling, restated (it is a private constant
 * in `src/core/errors.ts` and this phase does not widen that module's exports).
 * Pinned against `sanitizeMessage` itself below, so the literal cannot drift.
 */
const MAX_MESSAGE_LENGTH = 280;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 500,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

const QUOTA: LpExitQuota = {
  maxExitSequencesPerDay: 4,
  minMinutesBetweenExits: 5,
  maxGridFlipsPerDay: 12,
};

/*
 * THE FOUR RUNGS, derived once at tick 0 with gap 100 / width 200 / spacing 50.
 *
 * `gridDeriveDualRanges` composes two `gridDeriveRanges` calls at even pitch, so
 * the shapes below are exactly what the client signs and the route validates.
 *
 *   inner (gap 100):            above [150, 350]    below [-300, -100]
 *   outer (gap 2*100+200=400):  above [450, 650]    below [-600, -400]
 *
 * Case A (wbnbIsToken0): buy = above, sell = below, so
 *   buy1 [150,350]  sell1 [-600,-400]  buy2 [450,650]  sell2 [-300,-100]
 *   ascending: sell1 < sell2 < [corridor] < buy1 < buy2
 * Case B mirrors it exactly.
 */
const GAP = 100;
const WIDTH = 200;

function dualRangesFor(wbnbIsToken0: boolean): {
  readonly buyRange: LpGridRange;
  readonly sellRange: LpGridRange;
  readonly buyRange2: LpGridRange;
  readonly sellRange2: LpGridRange;
} {
  return gridDeriveDualRanges({
    currentTick: 0,
    tickSpacing: SPACING,
    gapTicks: GAP,
    widthTicks: WIDTH,
    wbnbIsToken0,
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
}

function dualGrid(wbnbIsToken0: boolean, overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    pool: wbnbIsToken0
      ? { token0: WBNB, token1: TOKEN_HI, fee: 2_500 }
      : { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0,
    tickSpacing: SPACING,
    ...dualRangesFor(wbnbIsToken0),
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    ...overrides,
  };
}

/** The 3.15/3.16 two-rung grid, for the byte-identity pins. */
function singleGrid(wbnbIsToken0: boolean): LpGridSettings {
  const four = dualRangesFor(wbnbIsToken0);
  return {
    pool: wbnbIsToken0
      ? { token0: WBNB, token1: TOKEN_HI, fee: 2_500 }
      : { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0,
    tickSpacing: SPACING,
    buyRange: four.buyRange,
    sellRange: four.sellRange,
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
  };
}

function settingsFor(grid: LpGridSettings | null): LpAutomationSettings {
  return { ...DEFAULT_LP_SETTINGS, autoRotate: false, autoHarvest: false, grid };
}

/**
 * A post-swap tick that CLEARS the one-spacing rule, per orientation.
 *
 * Case A: the swap lowers the tick and `sell2` is BELOW, so the price must stay
 * at or above `sell2.tickUpper + spacing` = -50. Case B mirrors it.
 */
function clearingTickFor(wbnbIsToken0: boolean): number {
  return wbnbIsToken0 ? -20 : 20;
}

/**
 * A post-swap tick at which the SELL gate REFUSES and a pre-swap-shaped gate
 * (side exists AND charges base) would have PASSED — the H1 kill test's whole
 * point. It sits strictly inside the one-spacing pad and strictly outside the
 * rung, which is exactly the window the old shape could not see.
 */
function killTickFor(wbnbIsToken0: boolean): number {
  return wbnbIsToken0 ? -60 : 120;
}

/** A signed tick as ABI-encodes it: int24, two's complement, 32-byte word. */
function tickWord(tick: number): string {
  const raw = BigInt(tick);
  return (raw < 0n ? (1n << 256n) + raw : raw).toString(16).padStart(64, "0");
}

function txAt(index: number): Hex {
  return `0x${(0xd000 + index).toString(16).padStart(64, "0")}` as Hex;
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

type ScriptEntry = (
  params: ExecuteViaSessionParams,
  txHash: Hex,
) => ExecutionReceipt;

class ScriptedProvider extends FakeWalletProvider {
  readonly submitted: {
    readonly calls: ExecuteViaSessionParams["calls"];
    readonly hash: Hex;
  }[] = [];
  readonly script: ScriptEntry[] = [];
  #submitIndex = 0;

  override async executeViaSession(
    params: ExecuteViaSessionParams,
  ): Promise<ExecutionReceipt> {
    const txHash = txAt(this.#submitIndex);
    this.#submitIndex += 1;
    this.submitted.push({ calls: params.calls, hash: hashCalls(params.calls) });
    const entry = this.script.shift();
    if (entry === undefined) throw new Error("unscripted executeViaSession");
    return entry(params, txHash);
  }
}

class FakeReceipts implements LpReceiptReader {
  readonly mintsByTx = new Map<string, readonly bigint[]>();
  /** Set to make the reader ABSENT, pinning the fail-closed branch. */
  plural = true;

  async collectAmounts(): Promise<never> {
    throw new Error("an arm never collects");
  }
  async swapAmounts(): Promise<never> {
    throw new Error("the dual arm's swap amounts are never read back");
  }
  async mintedTokenId(txHash: Hex): Promise<bigint> {
    const ids = this.mintsByTx.get(txHash) ?? [];
    if (ids.length !== 1) {
      throw new Error(
        `mintedTokenId: expected exactly one NFPM mint Transfer in ${txHash}; found ${ids.length}.`,
      );
    }
    return ids[0] as bigint;
  }
  mintedTokenIds = async (txHash: Hex): Promise<readonly bigint[]> => {
    if (!this.plural) throw new Error("unreachable — the reader is absent");
    const ids = this.mintsByTx.get(txHash) ?? [];
    if (ids.length !== 2) {
      throw new Error(
        `mintedTokenIds: expected exactly two NFPM mint Transfers in ${txHash}; found ${ids.length}.`,
      );
    }
    return ids;
  };
}

function confirmed(txHash: Hex): ExecutionReceipt {
  return {
    status: "CONFIRMED",
    callsId: `0x${"d2".repeat(32)}` as Hex,
    transactionHash: txHash,
  };
}

type Harness = {
  readonly agent: AgentRecord;
  readonly agentStore: MemoryAgentStore;
  readonly journal: MemoryExecutionJournal;
  readonly killswitch: MemoryKillSwitch;
  readonly store: MemoryLpSequenceStore;
  readonly provider: ScriptedProvider;
  readonly positions: Map<string, LpPositionSnapshot | "burned">;
  readonly receipts: FakeReceipts;
  readonly deps: LpSagaDeps;
  readonly grid: LpGridSettings;
  readonly quoted: {
    /** `null` ⇒ scale with the requested amount at ~10 bps of impact. */
    out: bigint | null;
    postSwapTick: number;
    fail: boolean;
    lastOutWei: bigint;
  };
  currentDigest: Hex;
};

async function createDualHarness(
  options: {
    readonly wbnbIsToken0?: boolean;
    readonly tick?: number;
    readonly postSwapTick?: number;
    readonly status?: AgentRecord["status"];
    /** Omit level 2's row entirely, for the never-created-sibling paths. */
    readonly withoutSibling?: boolean;
  } = {},
): Promise<Harness> {
  const wbnbIsToken0 = options.wbnbIsToken0 === true;
  const grid = dualGrid(wbnbIsToken0);
  const now = (): number => NOW_MS;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new MemoryLpSequenceStore(now);
  const provider = new ScriptedProvider();
  const receipts = new FakeReceipts();
  const positions = new Map<string, LpPositionSnapshot | "burned">();

  let agent = await agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    custodyModel: "self-eoa",
    sessionFacts: {
      spec: {
        allowedCalls: [{ to: NFPM }, { to: ROUTER_V3 }],
        spendCaps: [{ limit: 10n ** 18n, period: "day" }],
        expiresAt: NOW_SEC + 3_600,
      },
      permissions: { calls: [], spend: [] },
      publicKey: `0x04${"ab".repeat(64)}` as Hex,
      expiry: NOW_SEC + 3_600,
    },
    caps: { dailyNativeWei: 10n ** 18n },
    status: options.status === "revoked" ? "armed" : options.status ?? "armed",
  });
  await agentStore.putAgentSessionKey(OWNER, AGENT_ID, SESSION_KEY);
  if (options.status === "revoked") {
    const withKey = await agentStore.getAgent(OWNER, AGENT_ID);
    const revoked = await agentStore.transitionAgentStatus({ ownerAddress: OWNER, agentId: AGENT_ID,
      expectedStatus: "armed", expectedRowVersion: withKey!.rowVersion, status: "revoked" });
    assert.ok(revoked !== null);
    agent = revoked;
  }

  // BOTH rows, created together and carrying the SAME `arm_group_id` — exactly
  // what the route writes, and the only thing the recovery paths can see.
  const rowInput = {
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: grid.pool.token0,
    token1: grid.pool.token1,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted" as const,
    armGroupId: ARM_GROUP_ID,
  };
  await store.createPosition({ ...rowInput, positionId: BUY_POSITION_ID });
  if (options.withoutSibling !== true) {
    await store.createPosition({ ...rowInput, positionId: SELL_POSITION_ID });
  }

  const marketTick = options.tick ?? 0;
  const market: LpMarketReader = async (): Promise<LpSagaMarket> => {
    const sqrt = getSqrtRatioAtTick(marketTick);
    return {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 18n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: sqrt,
      twapSqrtPriceX96: sqrt,
      currentTick: marketTick,
    };
  };

  /*
   * The quoter fake. `out` is `null` ⇒ SCALE with the requested amount at ~10
   * bps of impact against the fixture's 1:1 spot, which every rail admits. A
   * fixed number would make the price-impact rail fire on any test that changes
   * the budget, which is a fixture artefact rather than a finding.
   */
  const quoted: Harness["quoted"] = {
    out: null,
    postSwapTick: options.postSwapTick ?? clearingTickFor(wbnbIsToken0),
    fail: false,
    lastOutWei: 0n,
  };

  const harness: Harness = {
    agent,
    agentStore,
    journal,
    killswitch,
    store,
    provider,
    positions,
    receipts,
    grid,
    quoted,
    currentDigest: ARMED_DIGEST,
    deps: {
      agent,
      agentStore,
      provider,
      journal,
      store,
      killswitch,
      rails: RAILS,
      quota: QUOTA,
      market,
      positions: async (tokenId) => {
        const entry = positions.get(tokenId.toString(10));
        if (entry === undefined) throw new Error(`no snapshot for token ${tokenId}`);
        return entry;
      },
      quote: async () => {
        throw new Error("the dual arm uses quoteWithPriceAfter, never the bare quote");
      },
      quoteWithPriceAfter: async (params) => {
        if (quoted.fail) throw new Error("quoter down");
        const amountOutWei = quoted.out ?? (params.amountInWei * 9_990n) / 10_000n;
        quoted.lastOutWei = amountOutWei;
        return {
          amountOutWei,
          sqrtPriceX96After: getSqrtRatioAtTick(quoted.postSwapTick),
        };
      },
      receipts,
      expectedPool: getAddress("0x2222222222222222222222222222222222222222"),
      conversionCompatibleTokens: new Set(),
      settingsDigest: ARMED_DIGEST,
      currentSettingsDigest: async () => harness.currentDigest,
      exitToQuote: true,
      autoRotate: false,
      relayFeePerSubmitWei: 100_000_000_000_000n,
      venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
      now,
      deadlineSec: 120,
    },
  };
  return harness;
}

function dualInput(
  grid: LpGridSettings,
  budgetWei = BUDGET,
): Parameters<typeof runLpOpen>[1] {
  const pair2 = gridPair(grid, 2);
  if (pair2 === null) throw new Error("fixture: the grid is not dual");
  return {
    mode: "grid-arm-dual",
    kind: "grid-arm",
    positionId: BUY_POSITION_ID,
    siblingPositionId: SELL_POSITION_ID,
    budgetWei,
    tickLower: grid.buyRange.tickLower,
    tickUpper: grid.buyRange.tickUpper,
    sellTickLower: pair2.sellRange.tickLower,
    sellTickUpper: pair2.sellRange.tickUpper,
    tickSpacing: grid.tickSpacing,
  };
}

/** Script one CONFIRMED dual mint, and record BOTH snapshots as live. */
function scriptDualMint(
  h: Harness,
  options: { readonly ids?: readonly [bigint, bigint]; readonly zeroLiquidity?: boolean } = {},
): void {
  const [sellId, buyId] = options.ids ?? [SELL_TOKEN_ID, BUY_TOKEN_ID];
  const pair2 = gridPair(h.grid, 2);
  h.provider.script.push((_params, txHash) => {
    h.receipts.mintsByTx.set(txHash, [sellId, buyId]);
    h.positions.set(sellId.toString(10), {
      liquidity: options.zeroLiquidity === true ? 0n : MINTED_LIQ,
      tickLower: pair2?.sellRange.tickLower ?? 0,
      tickUpper: pair2?.sellRange.tickUpper ?? 0,
    });
    h.positions.set(buyId.toString(10), {
      liquidity: MINTED_LIQ,
      tickLower: h.grid.buyRange.tickLower,
      tickUpper: h.grid.buyRange.tickUpper,
    });
    return confirmed(txHash);
  });
}

async function statesOf(h: Harness): Promise<{ buy: string | undefined; sell: string | undefined }> {
  return {
    buy: (await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID))?.state,
    sell: (await h.store.getPosition(OWNER, AGENT_ID, SELL_POSITION_ID))?.state,
  };
}

/* -------------------------------------------------------------------------- */
/* R2.1 / C9 — the crossed-pair geometry                                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.1: the four rungs cross, in both pool orderings", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const label = wbnbIsToken0 ? "Case A (WBNB is token0)" : "Case B (WBNB is token1)";

    it(`${label}: the chain ASCENDS in the pinned order and the corridor holds the tick`, () => {
      const grid = dualGrid(wbnbIsToken0);
      const pair2 = gridPair(grid, 2);
      assert.ok(pair2 !== null);
      // The R2.1 chain, written ascending per orientation.
      const ascending = wbnbIsToken0
        ? [grid.sellRange, pair2!.sellRange, grid.buyRange, pair2!.buyRange]
        : [pair2!.buyRange, grid.buyRange, pair2!.sellRange, grid.sellRange];
      for (let i = 0; i + 1 < ascending.length; i += 1) {
        assert.ok(
          (ascending[i] as LpGridRange).tickUpper <= (ascending[i + 1] as LpGridRange).tickLower,
          `rung ${i} must not overlap rung ${i + 1}`,
        );
      }
      // THE CORRIDOR IS EXACTLY the conjunction of the two INNER-rung gates —
      // which is what makes both arming assignments legal at the same tick.
      const innerBuy = grid.buyRange;
      const innerSell = pair2!.sellRange;
      const buySide = gridTargetSide(0, innerBuy);
      const sellSide = gridTargetSide(0, innerSell);
      assert.notEqual(buySide, undefined);
      assert.notEqual(sellSide, undefined);
      assert.equal(gridSideChargesQuote(buySide!, wbnbIsToken0), true, "buy1 holds QUOTE");
      assert.equal(gridSideChargesQuote(sellSide!, wbnbIsToken0), false, "sell2 holds BASE");
    });

    it(`${label}: each level takes one INNER rung and one OUTER rung — they never share`, () => {
      const grid = dualGrid(wbnbIsToken0);
      const one = gridPair(grid, 1);
      const two = gridPair(grid, 2);
      assert.ok(one !== null && two !== null);
      const rungs = [one!.buyRange, one!.sellRange, two!.buyRange, two!.sellRange];
      const keys = new Set(rungs.map((r) => `${r.tickLower}:${r.tickUpper}`));
      assert.equal(keys.size, 4, "the four signed rungs are pairwise distinct");
      // The INNER rungs (nearest the tick) belong to DIFFERENT levels — that is
      // the crossing, and it is the whole of B3's repair.
      const innerBuy = one!.buyRange;
      const innerSell = two!.sellRange;
      const outerBuy = two!.buyRange;
      const outerSell = one!.sellRange;
      const distance = (r: LpGridRange): number =>
        Math.min(Math.abs(r.tickLower), Math.abs(r.tickUpper));
      assert.ok(distance(innerBuy) < distance(outerBuy), "buy1 is inside buy2");
      assert.ok(distance(innerSell) < distance(outerSell), "sell2 is inside sell1");
    });

    it(`${label}: the derivation REFUSES rather than truncating at the global bounds`, () => {
      // C9: the bounds refusal must cover ALL FOUR rungs, not merely the inner
      // pair — a truncated outer rung is a geometry the operator never saw.
      assert.throws(
        () =>
          gridDeriveDualRanges({
            currentTick: MAX_TICK - 10,
            tickSpacing: SPACING,
            gapTicks: GAP,
            widthTicks: WIDTH,
            wbnbIsToken0,
            minTick: MIN_TICK,
            maxTick: MAX_TICK,
          }),
        /leaves the global tick bounds/u,
      );
    });

    it(`${label}: rung pitch is EVEN, so both pairs carry the same gross spread`, () => {
      const grid = dualGrid(wbnbIsToken0);
      const one = gridNetEdgePair(grid, 1);
      const two = gridNetEdgePair(grid, 2);
      assert.ok(one !== null && two !== null);
      const edgeOne = gridNetEdge({
        pair: one!, minNetEdgeBps: 0, sizeWei: BUDGET, relayFeePerSubmitWei: 1n,
      });
      const edgeTwo = gridNetEdge({
        pair: two!, minNetEdgeBps: 0, sizeWei: BUDGET, relayFeePerSubmitWei: 1n,
      });
      assert.equal(edgeOne.grossEdgeBps, edgeTwo.grossEdgeBps);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* R2.2 — validation at SIGNING                                               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.2: the four-rung chain is validated where it is signed", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const label = wbnbIsToken0 ? "Case A" : "Case B";

    it(`${label}: a legal dual grid validates`, () => {
      assert.doesNotThrow(() => validateLpSettings(settingsFor(dualGrid(wbnbIsToken0))));
    });

    it(`${label}: an OVERLAPPING outer rung is refused, naming the ascending order`, () => {
      const grid = dualGrid(wbnbIsToken0);
      const pair2 = gridPair(grid, 2);
      // Drag the OUTER buy rung back across the inner one.
      const broken: LpGridSettings = {
        ...grid,
        buyRange2: {
          tickLower: grid.buyRange.tickLower - 50,
          tickUpper: grid.buyRange.tickUpper - 50,
        },
        sellRange2: pair2!.sellRange,
      };
      assert.throws(() => validateLpSettings(settingsFor(broken)), /must not overlap and must ascend/u);
    });

    it(`${label}: an EMPTY corridor is refused AT SIGNING as permanently unarmable`, () => {
      // The inner rungs TOUCH. A single-level 3.15 grid may do that and stays
      // armable (its arm asks only the BUY gate); a dual arm asks both at once,
      // so no tick anywhere satisfies the conjunction — for ever.
      const grid = dualGrid(wbnbIsToken0);
      const pair2 = gridPair(grid, 2);
      const innerBuy = grid.buyRange;
      const innerSell = pair2!.sellRange;
      const touching: LpGridSettings = wbnbIsToken0
        ? { ...grid, sellRange2: { tickLower: innerSell.tickLower, tickUpper: innerBuy.tickLower } }
        : { ...grid, sellRange2: { tickLower: innerBuy.tickUpper, tickUpper: innerSell.tickUpper } };
      assert.throws(
        () => validateLpSettings(settingsFor(touching)),
        /EMPTY arm corridor and is permanently unarmable/u,
      );
    });

    it(`${label}: ONE pair-2 key alone is refused — a level is a PAIR`, () => {
      const grid = dualGrid(wbnbIsToken0);
      const halfSigned: LpGridSettings = { ...grid };
      delete (halfSigned as { sellRange2?: LpGridRange }).sellRange2;
      assert.throws(
        () => validateLpSettings(settingsFor(halfSigned)),
        /carries BOTH grid.buyRange2 and grid.sellRange2 or neither/u,
      );
    });
  }

  it("a TOUCHING single-level grid stays legal — 3.15/3.16 are untouched", () => {
    // The empty-corridor rule is scoped to the pair-2-present shape ON PURPOSE.
    const grid = singleGrid(true);
    const touching: LpGridSettings = {
      ...grid,
      sellRange: { tickLower: grid.sellRange.tickLower, tickUpper: grid.buyRange.tickLower },
    };
    assert.doesNotThrow(() => validateLpSettings(settingsFor(touching)));
  });
});

/* -------------------------------------------------------------------------- */
/* R2.5 — role resolution over four rungs                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.5: role resolution is per LEVEL, and the target never crosses", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const label = wbnbIsToken0 ? "Case A" : "Case B";

    it(`${label}: each rung resolves to its OWN level and its OWN counter-rung`, () => {
      const grid = dualGrid(wbnbIsToken0);
      const one = gridPair(grid, 1);
      const two = gridPair(grid, 2);
      assert.deepEqual(gridLiveRole(grid, one!.buyRange), { level: 1, role: "buy" });
      assert.deepEqual(gridLiveRole(grid, one!.sellRange), { level: 1, role: "sell" });
      assert.deepEqual(gridLiveRole(grid, two!.buyRange), { level: 2, role: "buy" });
      assert.deepEqual(gridLiveRole(grid, two!.sellRange), { level: 2, role: "sell" });

      // THE CROSSING, asserted as a target: a filled level-1 buy flips into
      // level 1's OUTER sell rung — never level 2's inner one, which is what a
      // shared pair would have done and what B3 killed the design over.
      assert.deepEqual(gridTargetRange(grid, 1, "buy"), one!.sellRange);
      assert.deepEqual(gridTargetRange(grid, 2, "sell"), two!.buyRange);
      assert.notDeepEqual(gridTargetRange(grid, 1, "buy"), two!.sellRange);
      assert.notDeepEqual(gridTargetRange(grid, 2, "sell"), one!.buyRange);
    });

    it(`${label}: TWO levels can never land on one rung, over a full cycle`, () => {
      // Level 1 occupies only {buy1, sell1}; level 2 only {buy2, sell2}. The
      // sets are disjoint by construction, so the B3 collapse is structural.
      const grid = dualGrid(wbnbIsToken0);
      const one = gridPair(grid, 1);
      const two = gridPair(grid, 2);
      const levelOneRungs = [one!.buyRange, one!.sellRange];
      const levelTwoRungs = [two!.buyRange, two!.sellRange];
      for (const a of levelOneRungs) {
        for (const b of levelTwoRungs) {
          assert.notDeepEqual(a, b);
        }
      }
    });
  }

  it("a level 2 target on a SINGLE-level grid throws rather than falling back to pair 1", () => {
    const grid = singleGrid(true);
    assert.equal(gridIsDual(grid), false);
    assert.equal(gridPair(grid, 2), null);
    assert.throws(() => gridTargetRange(grid, 2, "buy"), /has no signed pair/u);
  });

  it("the fail-closed refusal names EVERY signed range, not pair 1's two", () => {
    const text = gridRangeList(dualGrid(true));
    assert.match(text, /L1 buy \[/u);
    assert.match(text, /L2 sell \[/u);
    assert.equal(gridRangeList(singleGrid(true)).includes("L2"), false);
  });
});

/* -------------------------------------------------------------------------- */
/* C2 / R3.2 — the net edge is per PAIR, on each level's own size              */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 C2: the net edge prices each level on ITS OWN pair", () => {
  const relay = 100_000_000_000_000n;

  it("N2 KILL TEST: pair 2 NARROW and pair 1 WIDE — level 2 is refused", () => {
    // The defect review2 N2 found: `gridNetEdge` read `grid.buyRange`/
    // `grid.sellRange` and nothing else, so level 2's admission was priced on
    // level 1's spread. Nothing forces two signed pairs to carry equal spreads
    // — the client's even pitch is a convenience, not an invariant — so a
    // directly-signed envelope can do exactly this.
    const wide = dualGrid(true);
    const narrow: LpGridSettings = {
      ...wide,
      // Pair 2's two rungs pushed almost on top of each other, while pair 1 is
      // left exactly as derived.
      buyRange2: { tickLower: 450, tickUpper: 650 },
      sellRange2: { tickLower: 400, tickUpper: 450 },
    };
    const one = gridNetEdgePair(narrow, 1);
    const two = gridNetEdgePair(narrow, 2);
    const size = 10n ** 16n;
    const edgeOne = gridNetEdge({ pair: one!, minNetEdgeBps: 0, sizeWei: size, relayFeePerSubmitWei: relay });
    const edgeTwo = gridNetEdge({ pair: two!, minNetEdgeBps: 0, sizeWei: size, relayFeePerSubmitWei: relay });
    assert.equal(edgeOne.ok, true, "pair 1 is wide and clears");
    assert.equal(edgeTwo.ok, false, "pair 2 is narrow and does NOT — the kill");
    assert.ok(edgeTwo.grossEdgeBps < edgeOne.grossEdgeBps);
    // And the refusal NAMES its pair, so an owner is not left guessing which
    // spread was priced.
    const text = lpGridNetEdgeRefusal(edgeTwo, "Grid arm refused");
    assert.match(text, /Pair 2 \(buy \[450, 650\), sell \[400, 450\)\)/u);
  });

  it("a SINGLE-level grid names no pair — the 3.15/3.16 sentence is byte-identical", () => {
    const grid = singleGrid(true);
    const edge = gridNetEdge({
      pair: gridNetEdgePair(grid, 1)!,
      minNetEdgeBps: 10_000,
      sizeWei: 10n ** 20n,
      relayFeePerSubmitWei: relay,
    });
    const text = lpGridNetEdgeRefusal(edge, "Grid import refused");
    assert.equal(text.startsWith("Grid import refused: the grid's spread does not cover"), true);
    assert.doesNotMatch(text, /Pair \d/u);
  });

  it("R3.2: the sell level's size is a NATIVE-WEI lower bound with three deductions", () => {
    const swapInWei = gridDualSwapInWei(BUDGET);
    assert.equal(swapInWei, BUDGET / 2n, "50/50 by CONSTANT");
    assert.equal(GRID_DUAL_SPLIT_BPS, 5_000);
    const bound = gridDualSellSizeWei({
      swapInWei,
      poolFee: 2_500,
      maxPriceImpactBps: RAILS.maxPriceImpactBps,
      maxSagaSlippageBps: RAILS.maxSagaSlippageBps,
    });
    // 2_500 millionths = 25 bps. keep = 10_000 - 25 - 500 - 100 = 9_375.
    assert.equal(bound, (swapInWei * 9_375n) / 10_000n);
    // STRICTLY SMALLER than the buy level: the asymmetry H5 found is priced,
    // not hidden.
    assert.ok(bound < BUDGET - swapInWei);
  });

  it("R3.2: rails that eat the whole swap produce ZERO, never a negative size", () => {
    const bound = gridDualSellSizeWei({
      swapInWei: BUDGET,
      poolFee: 10_000,
      maxPriceImpactBps: 9_000,
      maxSagaSlippageBps: 2_000,
    });
    assert.equal(bound, 0n);
    // And a zero-size level clears NO floor, so the arm refuses rather than
    // dividing by zero.
    const edge = gridNetEdge({
      pair: gridNetEdgePair(dualGrid(true), 2)!,
      minNetEdgeBps: 0,
      sizeWei: bound,
      relayFeePerSubmitWei: relay,
    });
    assert.equal(edge.ok, false);
  });
});

/* -------------------------------------------------------------------------- */
/* R3.3 / H1 — the post-swap sell gate                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R3.3: the SELL rung is gated on the POST-SWAP price", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const label = wbnbIsToken0 ? "Case A (swap moves the tick DOWN)" : "Case B (swap moves the tick UP)";
    const grid = dualGrid(wbnbIsToken0);
    const sellRange2 = gridPair(grid, 2)!.sellRange;

    it(`${label}: a price with one full spacing of clearance PASSES`, () => {
      assert.equal(
        gridDualSellClearanceOk({
          sqrtPriceX96After: getSqrtRatioAtTick(clearingTickFor(wbnbIsToken0)),
          sellRange2,
          tickSpacing: SPACING,
          wbnbIsToken0,
        }),
        true,
      );
    });

    it(`${label}: H1 KILL TEST — the post-swap gate REFUSES where a pre-swap-shaped gate PASSES`, () => {
      const killTick = killTickFor(wbnbIsToken0);
      // (a) THE PRE-SWAP-SHAPED CHECK PASSES at this price: the rung is
      // strictly outside and charges the BASE leg, which is all the old shape
      // ever asked. This is the window that made the failure systematic.
      const naiveSide = gridTargetSide(killTick, sellRange2);
      assert.notEqual(naiveSide, undefined, "strictly outside the rung");
      assert.equal(
        gridSideChargesQuote(naiveSide!, wbnbIsToken0),
        false,
        "and it charges the BASE leg — a pre-swap gate would admit it",
      );
      // (b) THE SHIPPED GATE REFUSES: under one tick spacing of clearance to the
      // near edge, so any further movement between quote and execution puts the
      // mint in range and reverts the WHOLE atomic batch on gas.
      assert.equal(
        gridDualSellClearanceOk({
          sqrtPriceX96After: getSqrtRatioAtTick(killTick),
          sellRange2,
          tickSpacing: SPACING,
          wbnbIsToken0,
        }),
        false,
      );
    });

    it(`${label}: a price INSIDE the rung refuses too`, () => {
      const inside = Math.floor((sellRange2.tickLower + sellRange2.tickUpper) / 2);
      assert.equal(
        gridDualSellClearanceOk({
          sqrtPriceX96After: getSqrtRatioAtTick(inside),
          sellRange2,
          tickSpacing: SPACING,
          wbnbIsToken0,
        }),
        false,
      );
    });

    it(`${label}: a ZERO-GAP grid can NEVER clear the rule (the --gap0 refusal, structurally)`, () => {
      /*
       * `gridDeriveRanges`' anchors put the SELL rung's near edge exactly one
       * anchor away from the tick it was derived at, so at `gapTicks = 0` the
       * clearance is strictly LESS than one spacing — at every tick, by
       * arithmetic rather than by luck.
       *
       * The gate is evaluated at the DERIVATION tick, which is the most
       * favourable price a dual arm can ever see: the swap only ever moves the
       * price TOWARD this rung, so every real post-swap price is worse. Refusing
       * already at zero movement is therefore the whole claim.
       */
      for (let tick = -137; tick <= 137; tick += 13) {
        const zeroGap = gridDeriveDualRanges({
          currentTick: tick,
          tickSpacing: SPACING,
          gapTicks: 0,
          widthTicks: WIDTH,
          wbnbIsToken0,
          minTick: MIN_TICK,
          maxTick: MAX_TICK,
        });
        assert.equal(
          gridDualSellClearanceOk({
            // Zero movement — the best case a swap could possibly leave.
            sqrtPriceX96After: getSqrtRatioAtTick(tick),
            sellRange2: zeroGap.sellRange2,
            tickSpacing: SPACING,
            wbnbIsToken0,
          }),
          false,
          `a zero-gap dual arm derived at tick ${tick} must refuse even at zero movement`,
        );
      }
      // And a ONE-GAP grid at the same ticks clears — so the rule refuses the
      // shape, not the arm.
      for (let tick = -137; tick <= 137; tick += 13) {
        const oneGap = gridDeriveDualRanges({
          currentTick: tick,
          tickSpacing: SPACING,
          gapTicks: SPACING,
          widthTicks: WIDTH,
          wbnbIsToken0,
          minTick: MIN_TICK,
          maxTick: MAX_TICK,
        });
        assert.equal(
          gridDualSellClearanceOk({
            sqrtPriceX96After: getSqrtRatioAtTick(tick),
            sellRange2: oneGap.sellRange2,
            tickSpacing: SPACING,
            wbnbIsToken0,
          }),
          true,
          `a one-spacing gap at tick ${tick} must clear at zero movement`,
        );
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* R3.4 — the pinned batch                                                    */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R3.4: the ONE submission, in the pinned order", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const label = wbnbIsToken0 ? "Case A (WBNB is token0)" : "Case B (WBNB is token1)";

    it(`${label}: six calls, in order, with BOTH values summing to the budget`, async () => {
      const h = await createDualHarness({ wbnbIsToken0 });
      scriptDualMint(h);
      const result = await runLpOpen(h.deps, dualInput(h.grid));
      assert.equal(result.status, "completed", result.reason);

      assert.equal(h.provider.submitted.length, 1, "ONE submission — both mint or neither does");
      const calls = h.provider.submitted[0]?.calls ?? [];
      assert.equal(calls.length, 6, "router + 2 approves + sell mint + buy mint + refundETH");

      const swapInWei = gridDualSwapInWei(BUDGET);
      // 1. the router leg, carrying its own value. `SwapRouter.pay()` wraps
      //    native only when `msg.value` covers the leg exactly.
      assert.equal(calls[0]?.to, ROUTER_V3);
      assert.equal(calls[0]?.value, swapInWei);
      // 2-3. `buildLpMintWbnbBatch`'s OWN emission order: WBNB first, by ROLE.
      assert.equal(calls[1]?.to, WBNB);
      assert.equal(calls[2]?.to, wbnbIsToken0 ? TOKEN_HI : TOKEN_LO);
      assert.equal(calls[1]?.value ?? 0n, 0n);
      assert.equal(calls[2]?.value ?? 0n, 0n);
      // 4. mint#1 = the SELL rung, base-charging, NO native attached.
      const pair2 = gridPair(h.grid, 2)!;
      assert.equal(calls[3]?.to, NFPM);
      assert.equal(calls[3]?.value ?? 0n, 0n);
      assert.ok(calls[3]?.data?.includes(tickWord(pair2.sellRange.tickLower)));
      // 5. mint#2 = the BUY rung, carrying the REMAINING native.
      assert.equal(calls[4]?.to, NFPM);
      assert.equal(calls[4]?.value, BUDGET - swapInWei);
      assert.ok(calls[4]?.data?.includes(tickWord(h.grid.buyRange.tickLower)));
      // 6. the NFPM's own refundETH.
      assert.equal(calls[5]?.to, NFPM);
      assert.equal(calls[5]?.value ?? 0n, 0n);

      // §4.4's metering claim, by CONSTRUCTION: `nativeSpendWei` is a plain sum
      // of attached values, so it records the WHOLE owner-signed budget and the
      // off-chain daily cap is fed the real number.
      const total = calls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
      assert.equal(total, BUDGET);
    });

    it(`${label}: exactly ONE base approve — the buy mint is single-sided QUOTE`, async () => {
      const h = await createDualHarness({ wbnbIsToken0 });
      scriptDualMint(h);
      await runLpOpen(h.deps, dualInput(h.grid));
      const calls = h.provider.submitted[0]?.calls ?? [];
      const base = wbnbIsToken0 ? TOKEN_HI : TOKEN_LO;
      assert.equal(
        calls.filter((c) => c.to === base).length,
        1,
        "review2 N6: the pre-correction shape's duplicate approve does not exist",
      );
    });

    it(`${label}: the sell mint's desired is the swap FLOOR, never the quote`, async () => {
      const h = await createDualHarness({ wbnbIsToken0 });
      scriptDualMint(h);
      await runLpOpen(h.deps, dualInput(h.grid));
      const calls = h.provider.submitted[0]?.calls ?? [];
      const floor = sagaSwapMinOut(h.quoted.lastOutWei, RAILS.maxSagaSlippageBps);
      assert.ok(floor < h.quoted.lastOutWei, "the floor is strictly below the quote");
      const approveWord = floor.toString(16).padStart(64, "0");
      assert.ok(
        calls[2]?.data?.toLowerCase().includes(approveWord),
        "the base approve is for the FLOOR, so the batch can never need more base than the swap guarantees",
      );
    });

    it(`${label}: a post-swap price under one spacing of clearance refuses at the BUILD`, async () => {
      const h = await createDualHarness({
        wbnbIsToken0,
        postSwapTick: killTickFor(wbnbIsToken0),
      });
      const result = await runLpOpen(h.deps, dualInput(h.grid));
      assert.equal(result.status, "rolled-back");
      assert.equal(result.code, "BUILD_REFUSED");
      assert.equal(h.provider.submitted.length, 0, "nothing reached a relay");
      assert.match(result.reason, /SELL rung/u);
      // BOTH rows closed — the whole of B1.
      assert.deepEqual(await statesOf(h), { buy: "closed", sell: "closed" });
    });

    it(`${label}: a BUY rung the tick moved into refuses on the PRE-swap tick`, async () => {
      const grid = dualGrid(wbnbIsToken0);
      const inside = Math.floor((grid.buyRange.tickLower + grid.buyRange.tickUpper) / 2);
      const h = await createDualHarness({ wbnbIsToken0, tick: inside });
      const result = await runLpOpen(h.deps, dualInput(h.grid));
      assert.equal(result.status, "rolled-back");
      assert.equal(result.code, "BUILD_REFUSED");
      assert.match(result.reason, /BUY rung/u);
      assert.deepEqual(await statesOf(h), { buy: "closed", sell: "closed" });
    });
  }

  it("an absent post-swap reader refuses FAIL-CLOSED rather than using the pre-swap tick", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    delete (h.deps as { quoteWithPriceAfter?: unknown }).quoteWithPriceAfter;
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /post-swap quote reader/u);
    assert.equal(h.provider.submitted.length, 0);
  });

  it("a swap leg over the price-impact rail refuses before any money", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    h.quoted.out = 1n; // a catastrophic quote against a spot of ~1:1
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /price impact/u);
    assert.equal(h.provider.submitted.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* C11 / M2 — the two tokenId writes                                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 C11: finish verifies BOTH mints before writing EITHER tokenId", () => {
  it("pairs mint#1 to the SELL row and mint#2 to the BUY row", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h);
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "completed");
    assert.equal(result.tokenId, BUY_TOKEN_ID.toString(10), "the result's tokenId is the row it names");
    assert.equal(result.siblingTokenId, SELL_TOKEN_ID.toString(10));
    const buy = await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID);
    const sell = await h.store.getPosition(OWNER, AGENT_ID, SELL_POSITION_ID);
    assert.equal(buy?.tokenId, BUY_TOKEN_ID.toString(10));
    assert.equal(sell?.tokenId, SELL_TOKEN_ID.toString(10));
    assert.equal(buy?.armGroupId, ARM_GROUP_ID);
    assert.equal(sell?.armGroupId, ARM_GROUP_ID);
  });

  it("L1: a non-monotonic id pair HOLDS rather than giving the rows each other's NFT", async () => {
    // NFPM `_nextId` is monotonic and the SELL mint is first in the pinned
    // batch, so `sellTokenId < buyTokenId` by construction. If it does not
    // hold, the plan's order and this pairing have drifted apart.
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h, { ids: [BUY_TOKEN_ID, SELL_TOKEN_ID] });
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "held");
    assert.equal(result.code, "POST_VERIFY_FAILED");
    assert.match(result.reason, /pinned mint order/u);
    // NEITHER row was written: verify-both-then-write-both.
    const buy = await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID);
    const sell = await h.store.getPosition(OWNER, AGENT_ID, SELL_POSITION_ID);
    assert.equal(buy?.tokenId, null);
    assert.equal(sell?.tokenId, null);
  });

  it("a zero-liquidity SECOND position writes NEITHER tokenId", async () => {
    // The C11 window: `finish` holds POST_VERIFY_FAILED for reasons that are
    // not a crash, and with two rows that hold could otherwise land BETWEEN the
    // two writes, leaving one funded row and one phantom.
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h, { zeroLiquidity: true });
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "held");
    assert.equal(result.code, "POST_VERIFY_FAILED");
    assert.match(result.reason, /one of the two new positions reports no liquidity/u);
    assert.equal((await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID))?.tokenId, null);
    assert.equal((await h.store.getPosition(OWNER, AGENT_ID, SELL_POSITION_ID))?.tokenId, null);
  });

  it("M2: a CRASH between the two writes replays idempotently, with no LpTokenIdInUseError", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    // THE CRASH WINDOW, staged exactly: write #1 (the SELL row, mint#1) landed;
    // the process died before write #2. On replay `finishDual` re-derives BOTH
    // ids from the SAME receipt and re-applies both — and the row that ALREADY
    // holds its id must not trip the global one-live-token index on a claim it
    // is making against itself.
    await h.store.updatePositionTokenId(
      OWNER, AGENT_ID, SELL_POSITION_ID, SELL_TOKEN_ID.toString(10),
    );
    scriptDualMint(h);

    const replay = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(replay.status, "completed", replay.reason);
    assert.equal(
      (await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID))?.tokenId,
      BUY_TOKEN_ID.toString(10),
      "the missing write is applied",
    );
    assert.equal(
      (await h.store.getPosition(OWNER, AGENT_ID, SELL_POSITION_ID))?.tokenId,
      SELL_TOKEN_ID.toString(10),
      "the row that already held its id keeps it, unchanged and un-rewritten",
    );
  });

  it("a resumed COMMITTED step finishes from the receipt and never resubmits", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h);
    const first = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(first.status, "completed");
    // A second drive of the same envelope: the BUY row already holds its id, so
    // the driver answers idempotent success without touching a relay.
    const again = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(again.status, "completed");
    assert.equal(h.provider.submitted.length, 1, "ambiguity and success both never replay a submit");
  });

  it("an absent mintedTokenIds reader HOLDS rather than pairing by guess", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h);
    delete (h.receipts as { mintedTokenIds?: unknown }).mintedTokenIds;
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "held");
    assert.equal(result.code, "POST_VERIFY_FAILED");
    assert.match(result.reason, /cannot report two minted tokenIds/u);
  });

  it("THE LIVE INCIDENT (2026-08-27): a dual arm completing THROUGH THE WORKER'S RESUME pairs both rows from the ROW", async () => {
    // Mainnet, first dual arm (tx 0x4e7bed5e…): the relay published its receipt
    // after `awaitExecution`'s deadline, reconcile COMMITTED the step, and the
    // worker resumed with `mode: "grid-arm"` + the `budgetWei: 0n` sentinel —
    // C7's OWN design. The old `finish` dispatched dual by `input.mode`, so the
    // resume fell into the single-arm branch and `mintedTokenId` refused the
    // two-mint receipt ("found 2"), leaving both rows `open` with null
    // tokenIds. The fix decides dual from `arm_group_id` ON THE ROW — the same
    // B1 rule `rollBack` and the abandon route already obey.
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h);

    // Phase 1 — reproduce the mid-state: the submit lands and the step commits
    // (txHash recorded), but `finish` cannot pair yet (reader absent), so the
    // sequence is left non-terminal with BOTH tokenIds unwritten.
    const savedReader = h.receipts.mintedTokenIds;
    delete (h.receipts as { mintedTokenIds?: unknown }).mintedTokenIds;
    const held = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(held.status, "held");
    assert.equal(h.provider.submitted.length, 1);
    assert.equal((await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID))?.tokenId, null);

    // Phase 2 — the WORKER's resume, verbatim: single-arm mode, zero-budget
    // sentinel. Without the fix this is the exact live failure
    // ("mintedTokenId: expected exactly one NFPM mint Transfer; found 2").
    (h.receipts as { mintedTokenIds?: typeof savedReader }).mintedTokenIds = savedReader;
    const resumed = await runLpOpen(h.deps, {
      mode: "grid-arm",
      kind: "grid-arm",
      positionId: BUY_POSITION_ID,
      budgetWei: 0n,
      tickLower: 0,
      tickUpper: 0,
    });
    assert.equal(resumed.status, "completed", resumed.reason);
    assert.equal(h.provider.submitted.length, 1, "the resume finishes from the receipt; it never resubmits");
    assert.equal(
      (await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID))?.tokenId,
      BUY_TOKEN_ID.toString(10),
    );
    assert.equal(
      (await h.store.getPosition(OWNER, AGENT_ID, SELL_POSITION_ID))?.tokenId,
      SELL_TOKEN_ID.toString(10),
    );
    const seq = await h.store.getSequence(OWNER, AGENT_ID, resumed.sequenceId);
    assert.equal(seq?.state, "completed");
  });

  it("a THREE-row arm group HOLDS as ambiguous rather than pairing by guess", async () => {
    // The row-derived dispatch must stay fail-closed on a shape the route
    // cannot create: pairing is only ever defined for exactly two rows.
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h);
    await h.store.createPosition({
      positionId: "extra-group-row",
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: h.grid.pool.token0,
      token1: h.grid.pool.token1,
      fee: h.grid.pool.fee,
      basisWei: 0n,
      basisSource: "minted",
      armGroupId: ARM_GROUP_ID,
    });
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "held");
    assert.equal(result.code, "POST_VERIFY_FAILED");
    assert.match(result.reason, /More than two position rows share this arm group/u);
    // Nothing was paired: no row received a tokenId.
    assert.equal((await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID))?.tokenId, null);
    assert.equal((await h.store.getPosition(OWNER, AGENT_ID, SELL_POSITION_ID))?.tokenId, null);
  });
});

/* -------------------------------------------------------------------------- */
/* B1 — the two-row disposition, on every failure path                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.3/B1: every rollback class closes BOTH rows, through the ROW", () => {
  it("BUILD_REFUSED (the sentinel) closes both", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    // The worker's resume passes `mode: "grid-arm"` and `budgetWei: 0n` —
    // UNCHANGED by this phase — and it must still close BOTH rows without
    // knowing the request was ever dual.
    const result = await runLpOpen(h.deps, {
      mode: "grid-arm",
      kind: "grid-arm",
      positionId: BUY_POSITION_ID,
      budgetWei: 0n,
      tickLower: 0,
      tickUpper: 0,
    });
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.deepEqual(
      await statesOf(h),
      { buy: "closed", sell: "closed" },
      "the sibling is resolved from arm_group_id, never from the input",
    );
  });

  it("AGENT_NOT_ARMED closes both", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true, status: "revoked" });
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "AGENT_NOT_ARMED");
    assert.deepEqual(await statesOf(h), { buy: "closed", sell: "closed" });
  });

  it("SETTINGS_DIGEST_MISMATCH closes both", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    h.currentDigest = `0x${"cd".repeat(32)}` as Hex;
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "SETTINGS_DIGEST_MISMATCH");
    assert.deepEqual(await statesOf(h), { buy: "closed", sell: "closed" });
  });

  it("AGENT_PAUSED closes both", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "AGENT_PAUSED");
    assert.deepEqual(await statesOf(h), { buy: "closed", sell: "closed" });
  });

  it("DAILY_CAP closes both", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    const result = await runLpOpen(h.deps, dualInput(h.grid, 2n * 10n ** 18n));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "DAILY_CAP");
    assert.equal(h.provider.submitted.length, 0);
    assert.deepEqual(await statesOf(h), { buy: "closed", sell: "closed" });
  });

  it("STEP_REFUSED (a provider FAILED receipt) closes both", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    h.provider.script.push((_params, txHash) => ({
      status: "FAILED",
      callsId: `0x${"d3".repeat(32)}` as Hex,
      transactionHash: txHash,
      failureCode: "PROVIDER_ERROR",
    }));
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "STEP_REFUSED");
    assert.deepEqual(await statesOf(h), { buy: "closed", sell: "closed" });
  });

  it("an UNKNOWN submit HOLDS with BOTH rows open and neither tokenId written", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    h.provider.script.push(() => {
      throw new Error("relay transport died mid-submit");
    });
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "held");
    assert.equal(result.code, "HELD_AMBIGUOUS");
    assert.deepEqual(await statesOf(h), { buy: "open", sell: "open" });
    const buy = await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID);
    assert.equal(buy?.tokenId, null);
    // The journal row carries the WHOLE budget, not half of it.
    const sequence = (await h.store.listSequences(OWNER, AGENT_ID))[0];
    const key = sequence?.steps[0]?.journalIdempotencyKey ?? "";
    const row = await h.journal.get(key);
    assert.equal(row?.state, "UNKNOWN");
    assert.equal(row?.nativeSpendWei, BUDGET);
  });

  it("a never-created sibling is not invented — the group is what the ROWS say", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true, withoutSibling: true });
    const result = await runLpOpen(h.deps, dualInput(h.grid, 2n * 10n ** 18n));
    assert.equal(result.status, "rolled-back");
    assert.equal(
      (await h.store.getPosition(OWNER, AGENT_ID, BUY_POSITION_ID))?.state,
      "closed",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The abandon door                                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.3: abandon reports the whole group it will close", () => {
  /**
   * A HELD `grid-arm` sequence whose one recorded step has NO journal row — the
   * "died between appendStep and begin" window, which the verifier settles by
   * ABSENCE and which is the never-funded shape the abandon door exists for.
   */
  async function heldNeverFundedArm(h: Harness): Promise<{
    readonly sequenceId: string;
    readonly stepRows: Map<string, null>;
    readonly sequence: Awaited<ReturnType<MemoryLpSequenceStore["createSequence"]>>;
  }> {
    const created = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: BUY_POSITION_ID,
      kind: "grid-arm",
    });
    const key = executeIdempotencyKey(
      AGENT_ID,
      lpStepDecisionId(created.sequenceId, 0),
      hashCalls([{ to: NFPM }]),
    );
    await h.store.appendStep(OWNER, AGENT_ID, created.sequenceId, {
      kind: "zap-in-mint",
      journalIdempotencyKey: key,
    });
    // `held` + `none` is TERMINAL by `isTerminalLpSequence`, so a PARKED
    // sequence carries a recovery marker — `pending-mint`, the same one the
    // abandoned-open and abandoned-single-arm twins use, and for the same
    // reason: the mint is the whole plan, so a hold can only be waiting on it.
    await h.store.setRecoveryState(OWNER, AGENT_ID, created.sequenceId, "pending-mint");
    await h.store.setSequenceState(OWNER, AGENT_ID, created.sequenceId, "held");
    const held = await h.store.getSequence(OWNER, AGENT_ID, created.sequenceId);
    assert.ok(held !== null);
    return {
      sequenceId: created.sequenceId,
      stepRows: new Map([[key, null]]),
      sequence: held!,
    };
  }

  it("a never-funded dual arm closes BOTH rows, and the check list says so", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    const { sequence, stepRows } = await heldNeverFundedArm(h);
    const verdict = verifyLpAbandonSequence({
      sequence,
      stepRows,
      nextIndexRow: null,
      positionState: "open",
      nowMs: NOW_MS,
      minIdleMs: 0,
      armGroupPositionIds: [BUY_POSITION_ID, SELL_POSITION_ID],
    });
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.message);
    assert.equal(verdict.ok && verdict.positionAction, "close");
    const group = verdict.checks.find((check) => check.name === "arm-group");
    assert.ok(group !== undefined, "the disposition names the group it governs");
    assert.match(String(group?.result), /apply "close" to 1 sibling row/u);
    assert.match(String(group?.result), /one submission funded both/u);
  });

  it("a non-dual sequence records NO group check — 3.15/3.16 verdicts are unchanged", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true, withoutSibling: true });
    const { sequence, stepRows } = await heldNeverFundedArm(h);
    const verdict = verifyLpAbandonSequence({
      sequence,
      stepRows,
      nextIndexRow: null,
      positionState: "open",
      nowMs: NOW_MS,
      minIdleMs: 0,
      armGroupPositionIds: [BUY_POSITION_ID],
    });
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.message);
    assert.equal(
      verdict.checks.some((check) => check.name === "arm-group"),
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Refusal texts: the R2.7 budget                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.7: two SHORT per-side texts from one fact function", () => {
  it("both fit under the 280-character platform ceiling, with the remedy intact", () => {
    const grid = dualGrid(true);
    const sellRange2 = gridPair(grid, 2)!.sellRange;
    for (const where of ["route", "mint"] as const) {
      const buy = lpGridDualArmBuyRefusal({
        where,
        currentTick: -123_456,
        buyRange: grid.buyRange,
        side: undefined,
        wbnbIsToken0: true,
      });
      const sell = lpGridDualArmSellRefusal({
        where,
        sellRange2,
        tickSpacing: SPACING,
        wbnbIsToken0: true,
      });
      for (const [name, text] of [["buy", buy], ["sell", sell]] as const) {
        assert.ok(
          text.length <= MAX_MESSAGE_LENGTH,
          `${name} refusal at the ${where} is ${text.length} chars, over the ${MAX_MESSAGE_LENGTH} ceiling`,
        );
        // And it is UNCLIPPED: `sanitizeMessage` is the identity on it.
        assert.equal(sanitizeMessage(text), text);
      }
      // ORDERING IS LOAD-BEARING: the non-reconstructible fact leads and the
      // remedy survives, because the tail is what a cap takes.
      assert.match(buy, /NOTHING was spent/u);
      assert.match(buy, /re-sign gridArm at the current price/u);
      assert.match(sell, /NOTHING was spent/u);
      assert.match(sell, /wider gap/u);
    }
  });

  it("the sell text names the POST-SWAP evidence, which is what an owner cannot reconstruct", () => {
    const grid = dualGrid(true);
    const text = lpGridDualArmSellRefusal({
      where: "route",
      sellRange2: gridPair(grid, 2)!.sellRange,
      tickSpacing: SPACING,
      wbnbIsToken0: true,
    });
    assert.match(text, /POST-SWAP price/u);
    assert.match(text, /zero-gap dual arm never clears it/u);
  });
});

/* -------------------------------------------------------------------------- */
/* The SINGLE-level path, pinned byte-identical                               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17: the single-level arm is untouched", () => {
  it("still mints TWO calls and attaches the WHOLE budget", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true, withoutSibling: true });
    const grid = singleGrid(true);
    h.provider.script.push((_params, txHash) => {
      h.receipts.mintsByTx.set(txHash, [BUY_TOKEN_ID]);
      h.positions.set(BUY_TOKEN_ID.toString(10), {
        liquidity: MINTED_LIQ,
        tickLower: grid.buyRange.tickLower,
        tickUpper: grid.buyRange.tickUpper,
      });
      return confirmed(txHash);
    });
    const result = await runLpOpen(h.deps, {
      mode: "grid-arm",
      kind: "grid-arm",
      positionId: BUY_POSITION_ID,
      budgetWei: BUDGET,
      tickLower: grid.buyRange.tickLower,
      tickUpper: grid.buyRange.tickUpper,
    });
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.tokenId, BUY_TOKEN_ID.toString(10));
    assert.equal(result.siblingTokenId, undefined, "a single arm names no sibling");
    const calls = h.provider.submitted[0]?.calls ?? [];
    assert.equal(calls.length, 2, "mint + refundETH, nothing else");
    assert.equal(calls[0]?.value, BUDGET);
    // It never touches the plural reader or the post-swap quote.
    assert.equal(h.receipts.mintsByTx.size, 1);
  });

  it("`mintedTokenId` is NOT weakened: a two-mint receipt still refuses", async () => {
    const receipts = new FakeReceipts();
    const tx = txAt(9);
    receipts.mintsByTx.set(tx, [SELL_TOKEN_ID, BUY_TOKEN_ID]);
    await assert.rejects(
      () => receipts.mintedTokenId(tx),
      /expected exactly one NFPM mint Transfer/u,
    );
    // And the plural reader refuses anything but exactly two.
    receipts.mintsByTx.set(tx, [BUY_TOKEN_ID]);
    await assert.rejects(
      () => receipts.mintedTokenIds(tx),
      /expected exactly two NFPM mint Transfers/u,
    );
    receipts.mintsByTx.set(tx, [1n, 2n, 3n]);
    await assert.rejects(
      () => receipts.mintedTokenIds(tx),
      /expected exactly two NFPM mint Transfers/u,
    );
  });

  it("L3: the SHIPPED readers keep their own exact counts, side by side", () => {
    // The fakes above prove the CONTRACT; this proves the wired reader still
    // has it. `mintedTokenId`'s `!== 1` refusal is post-verify fail-closed for
    // every single-mint path in the tree, and a phase that added a plural
    // reader beside it must not have relaxed it into `>= 1`.
    //
    // ─── PHASE3.22 R4.2.6 — THE PLURAL READER'S HALF IS DECLARED-AND-INVERTED
    //
    // The 3.14 A9 precedent, applied deliberately rather than discovered. This
    // test pinned `mintedTokenIds` at EXACTLY TWO, and R4.2.6 WIDENED it to
    // 1..2 because a one-sided shift — decision 9's ordinary case — mints a
    // single rung, so a strict two-mint reader would fail closed on a receipt
    // that is exactly correct. REVIEW2 N3 required this widening to be "said
    // out loud" where it touches the fakes 3.17 left alone; this is that.
    //
    // WHAT THE INVERSION DOES NOT GIVE UP: the count did not become unbounded,
    // it MOVED TO THE CALLER — the only place that knows how many mints its own
    // plan asked for. The dual arm still asserts `ids.length !== 2` at its seam
    // in `open.ts` (pinned below), and the shift's finish asserts against the
    // mint set its batch actually recorded. Both callers kept a guard and both
    // gained one that knows what it is checking.
    //
    // `mintedTokenId`'s `!== 1` is UNTOUCHED — the property this test was
    // originally written for is intact and still asserted.
    const source = readFileSync(new URL("../src/lp/readers.ts", import.meta.url), "utf8");
    assert.match(source, /mintedTokenId: expected exactly one NFPM mint Transfer/u);
    assert.match(source, /mints\.length !== 1/u);
    assert.match(source, /mintedTokenIds: expected one or two NFPM mint Transfers/u);
    assert.match(source, /mints\.length < 1 \|\| mints\.length > 2/u);
    // The dual arm's OWN two-mint assertion, which is where the count lives now.
    const openSource = readFileSync(
      new URL("../src/lp/open.ts", import.meta.url),
      "utf8",
    );
    assert.match(openSource, /ids\.length !== 2/u);
    // And the plural reader mirrors the SAME four-topic zero-address filter,
    // rather than inventing a second, looser one.
    assert.equal(
      (source.match(/log\.topics\[1\] === ZERO_TOPIC/gu) ?? []).length,
      2,
      "one filter per reader, identical",
    );
  });

  it("a single arm's row carries armGroupId null — the column is inert for it", async () => {
    const store = new MemoryLpSequenceStore(() => NOW_MS);
    const row = await store.createPosition({
      positionId: "solo",
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: WBNB,
      token1: TOKEN_HI,
      fee: 2_500,
      basisWei: 0n,
      basisSource: "minted",
    });
    assert.equal(row.armGroupId, null);
  });
});

/* -------------------------------------------------------------------------- */
/* The step and journal records                                               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.17 R2.8: a dual arm writes the SAME records as a single one", () => {
  it("one grid-arm sequence, one zap-in-mint step, naming the BUY row", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h);
    const result = await runLpOpen(h.deps, dualInput(h.grid));
    assert.equal(result.status, "completed");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences.length, 1, "ONE sequence for two rows");
    assert.equal(sequences[0]?.kind, "grid-arm");
    assert.equal(sequences[0]?.state, "completed");
    assert.equal(
      sequences[0]?.positionId,
      BUY_POSITION_ID,
      "R3.4: the sequence names the BUY row (level 1, the native-attaching level)",
    );
    assert.deepEqual(sequences[0]?.steps.map((step) => step.kind), ["zap-in-mint"]);
    const key = sequences[0]?.steps[0]?.journalIdempotencyKey ?? "";
    const row = await h.journal.get(key);
    assert.equal(row?.kind, "lp");
    assert.equal(row?.decisionId, lpStepDecisionId(sequences[0]!.sequenceId, 0));
    assert.equal(row?.nativeSpendWei, BUDGET);
    assert.equal(
      key,
      executeIdempotencyKey(
        AGENT_ID,
        lpStepDecisionId(sequences[0]!.sequenceId, 0),
        h.provider.submitted[0]!.hash,
      ),
    );
  });

  it("the arm occupies NEITHER quota lane — grid-arm is exempt, dual or not", async () => {
    const h = await createDualHarness({ wbnbIsToken0: true });
    scriptDualMint(h);
    await runLpOpen(h.deps, dualInput(h.grid));
    const usage = await h.store.quotaUsage(OWNER, AGENT_ID);
    assert.equal(usage.liveCount, 0);
    assert.equal(usage.gridFlipLiveCount ?? 0, 0);
  });
});
