/**
 * PHASE3.16 — the autonomous grid arm, at the SAGA and STORE seams.
 *
 * The pattern is `test/lp.gridFlip.test.ts`'s, per-suite and local to this
 * file: a scripted provider that records every batch and THROWS on an
 * unscripted submit (so a test expecting N submissions scripts exactly N and
 * any extra one fails loudly), memory stores, and a receipts fake that is the
 * ONLY source of money amounts. Nothing here extends the shared harness.
 *
 * The matrices this file owes:
 *
 *   - DUAL ORIENTATION. The arm funds `buyRange` and only `buyRange`, and the
 *     SIDE it presents is derived in POOL ORDER — so every side-dependent
 *     behaviour runs on a Case-A pool (WBNB = token1) and a Case-B pool
 *     (WBNB = token0). A side rule written in role order inverts for roughly
 *     half of BSC's WBNB pools.
 *   - THE BOTH-QUALIFY TICK POSITIONS (review B1): tick below the whole grid
 *     and tick above the whole grid, in both orientations. Under the REFUTED
 *     search-over-both-ranges rule both ranges qualify at those ticks and the
 *     wrong branch arms the SELL level with quote — which `gridCrossReading`
 *     reads as `filled` and which burns a no-fill flip. The shipped rule has no
 *     such branch, and these cases prove it.
 *   - THE G-GATE at the mint seam: a tick inside the armed range rolls back
 *     with ZERO submissions and the shared refusal text.
 *   - RECOVERY's four outcomes, and above all the fourth: an arm is NEVER
 *     re-driven. The worker's resume sentinel must BUILD_REFUSE and close the
 *     never-funded lineage.
 *   - The RECORDS: `basisWei: 0n` + `basisSource: "minted"`, the journal kind's
 *     `LOCAL_ONLY_KINDS` membership, the quota exemption, and the abandon
 *     disposition that keeps re-arming reachable.
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
  gridCrossReading,
  gridDeriveRanges,
  gridNetEdge,
  gridPresetMinEconomicSizeWei,
  gridQuantizeUpToSpacing,
  gridSideChargesQuote,
  gridTargetSide,
  lpGridArmRefusal,
} from "../src/lp/gridTriggers.js";
import type { LpGridSettings } from "../src/lp/triggers.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import { verifyLpAbandonSequence } from "../src/lp/abandonSequence.js";
import { GRID_SEQUENCE_KINDS } from "../src/lp/worker.js";
import {
  MemoryLpSequenceStore,
  lpStepDecisionId,
  type LpExitQuota,
} from "../src/store/lpSequences.js";
import {
  LOCAL_ONLY_KINDS,
  MONEY_KINDS,
  MemoryExecutionJournal,
} from "../src/store/journal.js";
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
const AGENT_ID = "grid-arm-agent";
const POSITION_ID = "grid-arm-pos";
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB ⇒ WBNB is token1 ⇒ Case A. */
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
/** Sorts ABOVE WBNB ⇒ WBNB is token0 ⇒ Case B. */
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const SESSION_KEY = `0x${"7d".repeat(32)}` as Hex;
const ARMED_DIGEST = `0x${"ab".repeat(32)}` as Hex;

const NOW_MS = 1_900_000_000_000;
const NOW_SEC = 1_900_000_000;
const BUDGET = 10n ** 17n;
const MINTED_LIQ = 10n ** 15n;

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

/**
 * The two signed ranges per orientation, at tick 0.
 *
 * Case A (`wbnbIsToken0 === false`): the quote is token1, and a range at or
 * BELOW the tick charges token1 — so the quote-holding BUY level sits below.
 * Case B is the exact mirror. The ordering constraint follows from that and is
 * orientation-conditioned, which is why neither pair can be written once.
 */
const BUY_A = { tickLower: -1_000, tickUpper: -500 };
const SELL_A = { tickLower: 500, tickUpper: 1_000 };
const BUY_B = { tickLower: 500, tickUpper: 1_000 };
const SELL_B = { tickLower: -1_000, tickUpper: -500 };

function buyRangeFor(wbnbIsToken0: boolean): { tickLower: number; tickUpper: number } {
  return wbnbIsToken0 ? BUY_B : BUY_A;
}

function sellRangeFor(wbnbIsToken0: boolean): { tickLower: number; tickUpper: number } {
  return wbnbIsToken0 ? SELL_B : SELL_A;
}

/** A signed tick as ABI-encodes it: int24, two's complement, 32-byte word. */
function tickWord(tick: number): string {
  const raw = BigInt(tick);
  return (raw < 0n ? (1n << 256n) + raw : raw).toString(16).padStart(64, "0");
}

function txAt(index: number): Hex {
  return `0x${(0xb000 + index).toString(16).padStart(64, "0")}` as Hex;
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
  readonly mintByTx = new Map<string, bigint>();

  async collectAmounts(): Promise<never> {
    throw new Error("an arm never collects");
  }
  async swapAmounts(): Promise<never> {
    // The arm has no swap leg AT ALL — no quote read, no approve, no router
    // call. A throw here is the fixture's own assertion of that.
    throw new Error("an arm must never submit a swap");
  }
  async mintedTokenId(txHash: Hex): Promise<bigint> {
    const entry = this.mintByTx.get(txHash);
    if (entry === undefined) throw new Error(`no mint receipt for ${txHash}`);
    return entry;
  }
}

function confirmed(txHash: Hex): ExecutionReceipt {
  return {
    status: "CONFIRMED",
    callsId: `0x${"c2".repeat(32)}` as Hex,
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
  readonly marketState: { tick: number };
  currentDigest: Hex;
};

async function createArmHarness(
  options: {
    /** `false` ⇒ Case A (WBNB is token1). `true` ⇒ Case B (WBNB is token0). */
    readonly wbnbIsToken0?: boolean;
    readonly tick?: number;
    readonly status?: AgentRecord["status"];
  } = {},
): Promise<Harness> {
  const wbnbIsToken0 = options.wbnbIsToken0 === true;
  const now = (): number => NOW_MS;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new MemoryLpSequenceStore(now);
  const provider = new ScriptedProvider();
  const receipts = new FakeReceipts();
  const positions = new Map<string, LpPositionSnapshot | "burned">();

  const agent = await agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    custodyModel: "self-eoa",
    sessionFacts: {
      spec: {
        allowedCalls: [{ to: NFPM }],
        spendCaps: [{ limit: 10n ** 18n, period: "day" }],
        expiresAt: NOW_SEC + 3_600,
      },
      permissions: { calls: [], spend: [] },
      publicKey: `0x04${"ab".repeat(64)}` as Hex,
      expiry: NOW_SEC + 3_600,
    },
    caps: { dailyNativeWei: 10n ** 18n },
    status: options.status ?? "armed",
  });
  await agentStore.putAgentSessionKey(OWNER, AGENT_ID, SESSION_KEY);

  // THE ARMED ROW, exactly as the route writes it: zero basis, source
  // "minted". Neither existing member is honest — "owner-budget" would claim
  // the plane metered a number it recorded as zero, "imported" would claim a
  // position the plane did not create.
  await store.createPosition({
    positionId: POSITION_ID,
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: wbnbIsToken0 ? WBNB : TOKEN_LO,
    token1: wbnbIsToken0 ? TOKEN_HI : WBNB,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted",
  });

  const marketState = { tick: options.tick ?? 0 };
  const market: LpMarketReader = async (): Promise<LpSagaMarket> => {
    const sqrt = getSqrtRatioAtTick(marketState.tick);
    return {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 18n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: sqrt,
      twapSqrtPriceX96: sqrt,
      currentTick: marketState.tick,
    };
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
    marketState,
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
        throw new Error("an arm must never ask for a swap quote");
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

function armInput(wbnbIsToken0: boolean, budgetWei = BUDGET): Parameters<typeof runLpOpen>[1] {
  const buy = buyRangeFor(wbnbIsToken0);
  return {
    mode: "grid-arm",
    kind: "grid-arm",
    positionId: POSITION_ID,
    budgetWei,
    tickLower: buy.tickLower,
    tickUpper: buy.tickUpper,
  };
}

function scriptMint(h: Harness, wbnbIsToken0: boolean, tokenId = 91n): void {
  h.provider.script.push((_params, txHash) => {
    h.receipts.mintByTx.set(txHash, tokenId);
    h.positions.set(tokenId.toString(10), {
      liquidity: MINTED_LIQ,
      ...buyRangeFor(wbnbIsToken0),
    });
    return confirmed(txHash);
  });
}

/* -------------------------------------------------------------------------- */
/* B1 — WHICH range the arm funds, in both orientations and at every tick     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 B1: the arm funds buyRange and only buyRange", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB is token0)" : "Case A (WBNB is token1)";
    const buy = buyRangeFor(wbnbIsToken0);
    const sell = sellRangeFor(wbnbIsToken0);

    // THE BOTH-QUALIFY TICK POSITION, and which one it is depends on the
    // ORIENTATION — which is itself the point. Both ranges answer the same
    // side whenever the tick sits outside the whole grid, and that side
    // charges the quote on exactly one of the two sides of the price:
    //
    //   wbnbIsToken0 === true  ⇒ tick BELOW the grid  (both answer "above")
    //   wbnbIsToken0 === false ⇒ tick ABOVE the grid  (both answer "below")
    //
    // `validateLpSettings` cannot refuse either: it is pure and never sees a
    // tick, and two ranges on one side of the price is not degenerate — it is
    // simply what a grid looks like once the price has left it, which is the
    // single most common way a client's tick goes stale.
    const bothQualifyTick = wbnbIsToken0
      ? Math.min(buy.tickLower, sell.tickLower) - 100
      : Math.max(buy.tickUpper, sell.tickUpper) + 100;
    const neitherQualifiesTick = wbnbIsToken0
      ? Math.max(buy.tickUpper, sell.tickUpper) + 100
      : Math.min(buy.tickLower, sell.tickLower) - 100;

    it(`${label}: outside the whole grid BOTH ranges qualify, and only buyRange is fundable`, () => {
      const buySide = gridTargetSide(bothQualifyTick, buy);
      const sellSide = gridTargetSide(bothQualifyTick, sell);
      // The premise of B1: at this tick both ranges are strictly outside and
      // BOTH charge the quote. A rule that SEARCHED would have to pick.
      assert.notEqual(buySide, undefined);
      assert.notEqual(sellSide, undefined);
      assert.equal(buySide, sellSide, "both ranges present the SAME side");
      assert.equal(gridSideChargesQuote(buySide!, wbnbIsToken0), true);
      assert.equal(gridSideChargesQuote(sellSide!, wbnbIsToken0), true);

      // And the consequence of picking the sell one: a SELL level funded with
      // quote reads as ALREADY FILLED on its very first evaluation, which
      // burns a full flip (two relay submissions) for no fill at all.
      const asSell = gridCrossReading({
        currentTick: bothQualifyTick,
        range: sell,
        role: "sell",
        wbnbIsToken0,
      });
      assert.equal(asSell.filled, true, "a quote-funded sell level reads as filled");
      const asBuy = gridCrossReading({
        currentTick: bothQualifyTick,
        range: buy,
        role: "buy",
        wbnbIsToken0,
      });
      assert.equal(asBuy.filled, false, "the armed buy level starts the flip counter at zero");
    });

    it(`${label}: outside the grid on the OTHER side NEITHER qualifies, and the arm refuses`, async () => {
      const buySide = gridTargetSide(neitherQualifiesTick, buy);
      assert.notEqual(buySide, undefined, "strictly outside, but on the base-charging side");
      assert.equal(gridSideChargesQuote(buySide!, wbnbIsToken0), false);

      const h = await createArmHarness({ wbnbIsToken0, tick: neitherQualifiesTick });
      const result = await runLpOpen(h.deps, armInput(wbnbIsToken0));
      assert.equal(result.status, "rolled-back");
      assert.equal(h.provider.submitted.length, 0);
    });

    it(`${label}: the arm MINTS at the both-qualify tick, into buyRange`, async () => {
      const h = await createArmHarness({ wbnbIsToken0, tick: bothQualifyTick });
      scriptMint(h, wbnbIsToken0);
      const result = await runLpOpen(h.deps, armInput(wbnbIsToken0));
      assert.equal(result.status, "completed");
      const calls = h.provider.submitted[0]?.calls ?? [];
      assert.ok(calls[0]?.data?.includes(tickWord(buy.tickLower)));
      // NEVER the sell range's ticks — the branch that does not exist.
      assert.equal(calls[0]?.data?.includes(tickWord(sell.tickLower)), false);
    });

    it(`${label}: the mint encodes the SIGNED buyRange and attaches the whole budget`, async () => {
      const h = await createArmHarness({ wbnbIsToken0 });
      scriptMint(h, wbnbIsToken0);

      const result = await runLpOpen(h.deps, armInput(wbnbIsToken0));
      assert.equal(result.status, "completed");
      assert.equal(result.kind, "grid-arm");
      assert.equal(result.tokenId, "91");

      // ONE submission, TWO calls: mint{value} and refundETH. No swap, no
      // approve — the shape that makes "the arm never converts" structural.
      assert.equal(h.provider.submitted.length, 1);
      const calls = h.provider.submitted[0]?.calls ?? [];
      assert.equal(calls.length, 2, "mint + refundETH, nothing else");
      assert.equal(calls[0]?.value, BUDGET, "the whole budget attaches to the mint");
      assert.equal(calls[1]?.value ?? 0n, 0n);
      assert.ok(calls[0]?.data?.includes(tickWord(buy.tickLower)));
      assert.ok(calls[0]?.data?.includes(tickWord(buy.tickUpper)));

      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      assert.equal(sequences[0]?.kind, "grid-arm");
      assert.deepEqual(sequences[0]?.steps.map((step) => step.kind), ["zap-in-mint"]);
      const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
      assert.equal(position?.tokenId, "91");
    });
  }
});

/* -------------------------------------------------------------------------- */
/* R2.6 — the G-gate at the mint seam                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 R2.6: the mint-seam G-gate rolls back at zero cost", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB is token0)" : "Case A (WBNB is token1)";

    it(`${label}: a tick that moved INSIDE the armed range rolls back, zero submissions`, async () => {
      const buy = buyRangeFor(wbnbIsToken0);
      // The tick the client did not sign against: inside the level.
      const inside = Math.floor((buy.tickLower + buy.tickUpper) / 2);
      const h = await createArmHarness({ wbnbIsToken0, tick: inside });

      const result = await runLpOpen(h.deps, armInput(wbnbIsToken0));
      assert.equal(result.status, "rolled-back");
      assert.equal(result.code, "BUILD_REFUSED");
      assert.equal(h.provider.submitted.length, 0, "nothing reached a relay");
      assert.match(result.reason, /Grid arm refused at the mint/u);
      assert.match(result.reason, /re-sign gridArm at the current price/u);

      // The rollback CLOSES the never-funded lineage — which is what keeps the
      // re-arm precondition ("no non-closed position row") satisfiable.
      const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
      assert.equal(position?.state, "closed");
      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      assert.equal(sequences[0]?.state, "rolled-back");
    });

    it(`${label}: a tick on the WRONG side charges the base leg and is refused`, async () => {
      const buy = buyRangeFor(wbnbIsToken0);
      // Strictly outside the buy range, but on the side that charges the leg
      // the arm does NOT hold: the level would be funded with an asset the
      // wallet has none of.
      const wrongSide = wbnbIsToken0 ? buy.tickUpper + 100 : buy.tickLower - 100;
      const h = await createArmHarness({ wbnbIsToken0, tick: wrongSide });
      const side = gridTargetSide(wrongSide, buy);
      assert.notEqual(side, undefined, "the tick IS strictly outside");
      assert.equal(gridSideChargesQuote(side!, wbnbIsToken0), false);

      const result = await runLpOpen(h.deps, armInput(wbnbIsToken0));
      assert.equal(result.status, "rolled-back");
      assert.equal(result.code, "BUILD_REFUSED");
      assert.equal(h.provider.submitted.length, 0);
      assert.match(result.reason, /not the quote the arm funds/u);
    });
  }

  it("C5: the route seam and the mint seam speak with ONE builder", () => {
    // The rule is worthless unpinned (3.13 and 3.15 both pinned their
    // equivalents): two texts for one geometric fact is the cannot-diverge
    // failure this builder exists to make impossible.
    const shared = {
      currentTick: 700,
      buyRange: BUY_B,
      side: undefined,
      wbnbIsToken0: true,
    } as const;
    const atRoute = lpGridArmRefusal({ ...shared, where: "route" });
    const atMint = lpGridArmRefusal({ ...shared, where: "mint" });
    assert.equal(
      atRoute.replace("at the route", "at the SEAM"),
      atMint.replace("at the mint", "at the SEAM"),
      "the two seams differ only in WHERE they were asked",
    );
    // And the source carries exactly one construction site per seam.
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const planning = readFileSync(
      new URL("../src/lp/openPlanning.ts", import.meta.url),
      "utf8",
    );
    assert.equal((server.match(/lpGridArmRefusal\(\{/gu) ?? []).length, 1);
    assert.equal((planning.match(/lpGridArmRefusal\(\{/gu) ?? []).length, 1);
  });

  it("the refusal survives the 280-character sanitize cap with its remedy intact", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true, tick: 750 });
    const result = await runLpOpen(h.deps, armInput(true));
    assert.ok(result.reason.length <= 280, "sanitizeMessage's platform-wide ceiling");
    // ORDERING IS LOAD-BEARING: the fact and the remedy lead, the derivable
    // evidence is the sacrificial tail.
    assert.match(result.reason, /NOTHING was spent/u);
    assert.match(result.reason, /re-sign gridArm/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Pause, digest, and the daily cap                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16: an arm is an EXPOSURE-INCREASING submission", () => {
  it("a paused agent arms NOTHING and the row is closed", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);

    const result = await runLpOpen(h.deps, armInput(true));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "AGENT_PAUSED");
    assert.equal(h.provider.submitted.length, 0);
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");
    // Nothing was journaled either: the refusal is above `beginWithSpend`.
    assert.equal(await h.journal.get(
      executeIdempotencyKey(AGENT_ID, lpStepDecisionId("x", 0), hashCalls([{ to: NFPM }])),
    ), null);
  });

  it("a settings change between persist and submit rolls the arm back", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    h.currentDigest = `0x${"cd".repeat(32)}` as Hex;
    const result = await runLpOpen(h.deps, armInput(true));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "SETTINGS_DIGEST_MISMATCH");
    assert.equal(h.provider.submitted.length, 0);
  });

  it("the off-chain daily cap refuses the arm INSIDE the journal transaction", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    // A budget larger than the whole daily cap. This is the SUBMIT-time check
    // — a different guarantee from the route's sizing invariant, which prices
    // the exit reserve rather than this one spend.
    const result = await runLpOpen(h.deps, armInput(true, 2n * 10n ** 18n));
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "DAILY_CAP");
    assert.equal(h.provider.submitted.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Recovery: the four outcomes, and the fourth above all                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 R2.4/H5: an arm is NEVER re-driven", () => {
  it("the worker's resume sentinel BUILD_REFUSEs and closes the never-funded lineage", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    // The crash window `runLpOpen` and `driveSequence` both treat as a
    // provably-unsubmitted open slot: a recorded step whose journal row does
    // NOT exist. That is the state a fresh drive is reachable from.
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "grid-arm",
    });
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "zap-in-mint",
      journalIdempotencyKey: executeIdempotencyKey(
        AGENT_ID,
        lpStepDecisionId(sequence.sequenceId, 0),
        hashCalls([{ to: NFPM }]),
      ),
    });

    // EXACTLY what `worker.ts`'s `case "grid-arm"` passes.
    const result = await runLpOpen(h.deps, {
      mode: "grid-arm",
      kind: "grid-arm",
      positionId: POSITION_ID,
      budgetWei: 0n,
      tickLower: 0,
      tickUpper: 0,
    });
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /budget must be positive/u);
    assert.equal(h.provider.submitted.length, 0, "a re-drive never reaches a relay");
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");
  });

  it("C7: an arm sequence resumed under the OPEN kind conflicts instead of building", async () => {
    // The hazard C7 names: an `"open"` kind trips the sequence-kind guard into
    // SEQUENCE_CONFLICT/held — NOT the BUILD_REFUSED → closed row the policy
    // depends on. The union makes the honest pairing the only compilable one;
    // this pins the runtime half, because `sequence.kind` comes from the store.
    const h = await createArmHarness({ wbnbIsToken0: true });
    await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "grid-arm",
    });
    const result = await runLpOpen(h.deps, {
      mode: "two-sided-in-range",
      kind: "open",
      positionId: POSITION_ID,
      budgetWei: 1n,
      tickLower: 0,
      tickUpper: 0,
    });
    assert.equal(result.status, "held");
    assert.equal(result.code, "SEQUENCE_CONFLICT");
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.notEqual(position?.state, "closed");
  });

  it("an ambiguous submit HOLDS, and a retry of the same envelope never resubmits", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    h.provider.script.push(() => {
      throw new Error("relay transport died mid-submit");
    });
    const first = await runLpOpen(h.deps, armInput(true));
    assert.equal(first.status, "held");
    assert.equal(first.code, "HELD_AMBIGUOUS");
    assert.equal(h.provider.submitted.length, 1);

    // The journal row exists and is UNKNOWN; the retry joins it and holds.
    const retry = await runLpOpen(h.deps, armInput(true));
    assert.equal(retry.status, "held");
    assert.equal(h.provider.submitted.length, 1, "ambiguity never auto-replays");
  });

  it("L2: an UNKNOWN arm carries nativeSpendWei, so resolveUnknown refuses at native_spend", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    h.provider.script.push(() => {
      throw new Error("relay transport died mid-submit");
    });
    await runLpOpen(h.deps, armInput(true));
    const sequence = (await h.store.listSequences(OWNER, AGENT_ID))[0];
    const key = sequence?.steps[0]?.journalIdempotencyKey ?? "";
    const row = await h.journal.get(key);
    assert.equal(row?.state, "UNKNOWN");
    // This is WHY the operator sees `native_spend` rather than
    // `sequence_kind_unsupported`: check (c) runs before the kind check, and
    // the arm's step row is the first grid row to carry a native spend at all.
    assert.equal(row?.nativeSpendWei, BUDGET);
  });
});

/* -------------------------------------------------------------------------- */
/* Records: quota, basis, journal kind, abandon, worker flag                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 R2.5: the records an arm writes", () => {
  it("M6: the arm's reservation is written quotaBound: false", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    scriptMint(h, true);
    await runLpOpen(h.deps, armInput(true));
    const usage = await h.store.quotaUsage(OWNER, AGENT_ID);
    assert.equal(usage.liveCount, 0, "an arm occupies neither quota lane");
    assert.equal(usage.gridFlipLiveCount ?? 0, 0);
    // But the row EXISTS, which is why the SPACING ANCHOR sees it — the anchor
    // is agent-wide and counts quota-exempt rows too, so the FIRST flip after
    // an arm is floored by `minMinutesBetweenExits`.
    assert.notEqual(usage.latestReservedAtMs, null);
  });

  it("M6: `grid-arm` is absent from QUOTA_LANE_BY_KIND, and that absence IS the exemption", () => {
    // `runLpOpen` calls `reserveSequence` with NO try/catch, so a lane entry
    // would surface `LpExitQuotaError` as an untyped 500 on a money route.
    const source = readFileSync(
      new URL("../src/store/lpSequences.ts", import.meta.url),
      "utf8",
    );
    const map = /const QUOTA_LANE_BY_KIND[\s\S]*?\]\);/u.exec(source)?.[0];
    assert.ok(map !== undefined);
    assert.doesNotMatch(map!, /"grid-arm"/u);
  });

  it("H2/C5: the armed row persists basisSource \"minted\" with a ZERO basis", async () => {
    const h = await createArmHarness({ wbnbIsToken0: true });
    scriptMint(h, true);
    await runLpOpen(h.deps, armInput(true));
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.basisSource, "minted");
    assert.equal(position?.basisWei, 0n);
  });

  it("Q3/C5: lpGridArm is LOCAL-ONLY and is NOT a money kind", () => {
    // The membership is the whole point: a kind absent from LOCAL_ONLY_KINDS
    // is parked as a permanent UNKNOWN row no resolver can clear.
    assert.equal(LOCAL_ONLY_KINDS.has("lpGridArm"), true);
    assert.equal(MONEY_KINDS.has("lpGridArm"), false);
  });

  it("H3: abandoning an arm CLOSES the never-funded lineage", async () => {
    // Without this membership the row stays `open` with `tokenId: null` for
    // ever: the worker skips it every cycle, no exit can reach it (an exit
    // needs a tokenId), and the re-arm precondition — no non-closed position —
    // becomes permanently unsatisfiable. The owner is wedged with no
    // in-product remedy, in the phase whose purpose is "sign gridArm again".
    const h = await createArmHarness({ wbnbIsToken0: true });
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "grid-arm",
    });
    const key = executeIdempotencyKey(
      AGENT_ID,
      lpStepDecisionId(sequence.sequenceId, 0),
      hashCalls([{ to: NFPM }]),
    );
    // The H5 crash window: the step is RECORDED and the journal row never
    // existed, so it is settled by absence — the plane writes a row before
    // every submit.
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "zap-in-mint",
      journalIdempotencyKey: key,
    });
    // `held` + `none` is TERMINAL by `isTerminalLpSequence`, so a parked
    // sequence carries a recovery marker — the same `pending-mint` the
    // existing abandoned-OPEN twin uses, and for the same reason: the mint is
    // the whole plan, so a hold can only be waiting on it.
    await h.store.setRecoveryState(OWNER, AGENT_ID, sequence.sequenceId, "pending-mint");
    await h.store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "held");
    const held = await h.store.getSequence(OWNER, AGENT_ID, sequence.sequenceId);
    assert.ok(held);

    const verdict = verifyLpAbandonSequence({
      sequence: held!,
      stepRows: new Map([[key, null]]),
      nextIndexRow: null,
      positionState: "open",
      nowMs: NOW_MS,
      minIdleMs: 0,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok === true && verdict.positionAction, "close");
    assert.ok(
      verdict.ok === true
        && verdict.checks.some((check) => /abandoned grid arm never funded/u.test(check.result)),
      "the receipt names the ARM, not an open",
    );
  });

  it("H4: the worker's flag-off skip is SET membership over both grid kinds", () => {
    assert.equal(GRID_SEQUENCE_KINDS.has("grid-flip"), true);
    assert.equal(GRID_SEQUENCE_KINDS.has("grid-arm"), true);
    assert.equal(GRID_SEQUENCE_KINDS.has("open"), false);
    // And the resume loop reads the SET, never a second kind literal — a
    // hardcoded kind is how this class of bug got in the first time.
    const source = readFileSync(new URL("../src/lp/worker.ts", import.meta.url), "utf8");
    assert.match(source, /GRID_SEQUENCE_KINDS\.has\(sequence\.kind\) && deps\.gridEnabled !== true/u);
    assert.doesNotMatch(source, /sequence\.kind === "grid-flip"/u);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.8 / M5 — the client's range derivation                                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16 M5: presets quantize UP, and the minimum size follows", () => {
  it("rounds UP to the next spacing multiple — the conservative direction", () => {
    assert.deepEqual(gridQuantizeUpToSpacing(15, 1), { ticks: 15, clamped: false });
    assert.deepEqual(gridQuantizeUpToSpacing(15, 10), { ticks: 20, clamped: false });
    assert.deepEqual(gridQuantizeUpToSpacing(50, 50), { ticks: 50, clamped: false });
    assert.deepEqual(gridQuantizeUpToSpacing(51, 50), { ticks: 100, clamped: false });
  });

  it("CLAMPS below one spacing, and says it did", () => {
    // A 0.25x spread factor on the "tight" preset gives 3.75 ticks, which is
    // below spacing on every Pancake V3 pool but the spacing-1 ones. The
    // transcript prints the clamp because the geometry the owner then signs is
    // not the geometry the preset's NAME suggests.
    assert.deepEqual(gridQuantizeUpToSpacing(3.75, 1), { ticks: 4, clamped: false });
    assert.deepEqual(gridQuantizeUpToSpacing(3.75, 50), { ticks: 50, clamped: true });
    assert.deepEqual(gridQuantizeUpToSpacing(150, 200), { ticks: 200, clamped: true });
  });

  it("the presets COLLAPSE on wide-spacing pools, which is why sizes are computed after", () => {
    // On a fee-2500 pool (spacing 50), "tight 15/15" and "standard 30/30"
    // quantize to the SAME geometry; on spacing 200 the first three collapse
    // together. A minimum-size figure taken from the NOMINAL bps would be
    // wrong by up to 3x in the OPTIMISTIC direction.
    for (const [nominal, spacing, expected] of [
      [15, 50, 50],
      [30, 50, 50],
      [15, 200, 200],
      [30, 200, 200],
      [75, 200, 200],
      [150, 200, 200],
    ] as const) {
      assert.equal(gridQuantizeUpToSpacing(nominal, spacing).ticks, expected);
    }
  });

  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB is token0)" : "Case A (WBNB is token1)";

    it(`${label}: the derived buyRange charges the QUOTE at the tick it was derived from`, () => {
      for (const currentTick of [0, 1, -1, 137, -137, 500, -500]) {
        const derived = gridDeriveRanges({
          currentTick,
          tickSpacing: 50,
          gapTicks: 50,
          widthTicks: 100,
          wbnbIsToken0,
          minTick: MIN_TICK,
          maxTick: MAX_TICK,
        });
        const side = gridTargetSide(currentTick, derived.buyRange);
        assert.notEqual(side, undefined, `tick ${currentTick}: strictly outside`);
        assert.equal(
          gridSideChargesQuote(side!, wbnbIsToken0),
          true,
          `tick ${currentTick}: the armed level holds quote`,
        );
        // And the SIGNED ordering constraint holds in pool order, which is
        // what `validateLpSettings` enforces.
        if (wbnbIsToken0) {
          assert.ok(derived.sellRange.tickUpper <= derived.buyRange.tickLower);
        } else {
          assert.ok(derived.buyRange.tickUpper <= derived.sellRange.tickLower);
        }
      }
    });

    it(`${label}: a ZERO gap is still armable at a tick ON a spacing multiple`, () => {
      // The subtlety the strict upper anchor exists for. With a naive
      // `alignUp(t)` the buy level would start AT the tick when `t` is a
      // spacing multiple, `gridTargetSide` would answer `undefined`, and the
      // arm's own G-gate would refuse the one shape `--gap0` exists to offer.
      const derived = gridDeriveRanges({
        currentTick: 500,
        tickSpacing: 50,
        gapTicks: 0,
        widthTicks: 100,
        wbnbIsToken0,
        minTick: MIN_TICK,
        maxTick: MAX_TICK,
      });
      const side = gridTargetSide(500, derived.buyRange);
      assert.notEqual(side, undefined);
      assert.equal(gridSideChargesQuote(side!, wbnbIsToken0), true);
    });
  }

  it("REFUSES rather than truncating at the global tick bounds", () => {
    assert.throws(
      () =>
        gridDeriveRanges({
          currentTick: MAX_TICK - 10,
          tickSpacing: 50,
          gapTicks: 50,
          widthTicks: 100,
          wbnbIsToken0: true,
          minTick: MIN_TICK,
          maxTick: MAX_TICK,
        }),
      /leaves the global tick bounds/u,
    );
  });

  it("the minimum economic size is gridNetEdge inverted, on the QUANTIZED geometry", () => {
    const relayFee = 100_000_000_000_000n; // the shipped 1e14 default
    const quantized: LpGridSettings = {
      pool: { token0: WBNB, token1: TOKEN_HI, fee: 2_500 },
      wbnbIsToken0: true,
      tickSpacing: 50,
      buyRange: BUY_B,
      sellRange: SELL_B,
      maxFlipsPerDay: 12,
      minNetEdgeBps: 0,
    };
    const edge = gridNetEdge({ pair: { buyRange: quantized.buyRange, sellRange: quantized.sellRange }, minNetEdgeBps: quantized.minNetEdgeBps, sizeWei: 0n, relayFeePerSubmitWei: relayFee });
    const minSize = gridPresetMinEconomicSizeWei({
      grossEdgeBps: edge.grossEdgeBps,
      minNetEdgeBps: edge.minNetEdgeBps,
      relayFeePerSubmitWei: relayFee,
    });
    assert.ok(minSize !== null && minSize > 0n);
    // AT the minimum it clears; ONE wei below it does not. That round-trip is
    // the whole claim the transcript makes to the operator.
    assert.equal(
      gridNetEdge({ pair: { buyRange: quantized.buyRange, sellRange: quantized.sellRange }, minNetEdgeBps: quantized.minNetEdgeBps, sizeWei: minSize!, relayFeePerSubmitWei: relayFee }).ok,
      true,
    );
    assert.equal(
      gridNetEdge({ pair: { buyRange: quantized.buyRange, sellRange: quantized.sellRange }, minNetEdgeBps: quantized.minNetEdgeBps, sizeWei: minSize! - 1n, relayFeePerSubmitWei: relayFee }).ok,
      false,
    );
  });

  it("no size clears a floor the owner's own minimum already exceeds", () => {
    assert.equal(
      gridPresetMinEconomicSizeWei({
        grossEdgeBps: 100n,
        minNetEdgeBps: 100n,
        relayFeePerSubmitWei: 100_000_000_000_000n,
      }),
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The DDL migration (C10's pattern, third widening)                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.16: the lp_sequences kind CHECK accepts grid-arm", () => {
  it("the memory store creates and reads back a grid-arm sequence", async () => {
    const store = new MemoryLpSequenceStore(() => NOW_MS);
    await store.createPosition({
      positionId: POSITION_ID,
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: WBNB,
      token1: TOKEN_HI,
      fee: 2_500,
      basisWei: 0n,
      basisSource: "minted",
    });
    const sequence = await store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "grid-arm",
    });
    assert.equal(sequence.kind, "grid-arm");
    const queue = await store.listNonTerminalSequencesForWorker();
    assert.equal(queue.some((row) => row.kind === "grid-arm"), true);
    await store.close();
  });

  it("the REAL DDL widens the constraint through a THIRD guarded, idempotent DO block", () => {
    // The fake never parses SQL — it no-ops DDL entirely — so the store case
    // above cannot see this. Pinned at the TEXT level, the `lpQuotaRelease`
    // and 3.15 precedent.
    const source = readFileSync(
      new URL("../src/store/lpSequences.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      // PHASE3.18 AMENDS THIS PIN: the fresh-database list gained
      // `'grid-requote'` (the FOURTH widening). The property asserted is
      // unchanged — a fresh database gets the full list from `create table` —
      // and the 3.18 suite pins its own guarded block separately.
      /kind text not null check \(kind in \('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm', 'grid-requote'\)\)/u,
      "a fresh database must get the widened list",
    );
    const block = /do \$lp_sequences_arm_kind\$[\s\S]*?\$lp_sequences_arm_kind\$/u.exec(source)?.[0];
    assert.ok(block !== undefined, "the guarded DO block must exist");
    assert.match(
      block!,
      /lock table lp_sequences in access exclusive mode/u,
      "server and worker initialize the same store independently",
    );
    assert.match(
      block!,
      /pg_get_constraintdef\(oid\) not like '%grid-arm%'/u,
      "the drop is guarded on the constraint LACKING the NEW member",
    );
    assert.match(block!, /add constraint lp_sequences_kind_check[\s\S]*'grid-arm'/u);
    // Chained AFTER 3.15's, never instead of it: a database that already ran
    // 3.15 never re-enters that block, so widening its list alone would reach
    // only a fresh database.
    const init = /LP_SEQUENCES_KIND_CHECK_DDL\) await sql\.query\(ddl\);[\s\S]{0,400}?LP_SEQUENCES_ARM_KIND_CHECK_DDL/u;
    assert.match(source, init, "the 3.15 block still runs, and this one runs after it");
    assert.doesNotMatch(block!, /recovery_state/u, "ONE constraint migration, not two");
  });
});
