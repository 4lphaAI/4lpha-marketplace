import { withFeeRecording } from "./support/lpFeeFixture.js";
/**
 * PHASE3.15 — `runLpGridFlip`, over per-suite fakes.
 *
 * The pattern is `test/lp.sagas.test.ts`'s, deliberately: a scripted provider
 * that records every batch and THROWS on an unscripted submit (so a test which
 * expects N submissions scripts exactly N entries and any extra one fails
 * loudly), memory stores, and a receipts fake that is the ONLY source of money
 * amounts. The harness is local to this file rather than an extension of the
 * shared one, so nothing here can perturb the existing saga suite.
 *
 * The matrices this file owes:
 *
 *   - DUAL ORIENTATION. Every side-dependent behaviour runs on a Case-A pool
 *     (WBNB = token1) and a Case-B pool (WBNB = token0). A side rule written in
 *     role order inverts for roughly half of BSC's WBNB pools — 3.13 F7, and
 *     this phase's own H1.
 *   - PAUSE (R2.5/OQ4, with NO new gate): a paused agent starts no flip at all;
 *     a pause landing between the settle and the mint parks `held` +
 *     `pending-mint` + `AGENT_PAUSED`.
 *   - G2's THREE CONJUNCTS (R2.3/M8), each refusing into a RECOVERABLE hold,
 *     including the gapped-THROUGH-the-target case a side check alone passes.
 *   - CRASH: kill before submit / inside submit / after confirm — resume skips
 *     confirmed steps, holds on ambiguity, and never resubmits a key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import {
  runLpGridFlip,
  type LpGridFlipDeps,
  type LpMarketReader,
  type LpPositionSnapshot,
  type LpReceiptReader,
  type LpSagaMarket,
} from "../src/lp/sagas.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { SWAPLESS_MAX_RESIDUE_BPS } from "../src/lp/fence.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import {
  MemoryLpSequenceStore,
  lpStepDecisionId,
  type LpExitQuota,
} from "../src/store/lpSequences.js";
import { MemoryLpGridCycleStore } from "../src/store/gridCycles.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
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
const AGENT_ID = "grid-agent-1";
const POSITION_ID = "grid-pos-1";
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
const LIQ = 10n ** 15n;
const FREED = 10n ** 15n;
const RELAY_FEE_PER_SUBMIT = 100_000_000_000_000n;

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

/** The live buy level, in each ordering. */
const BUY_A = { tickLower: -1_000, tickUpper: -500 };
const SELL_A = { tickLower: 500, tickUpper: 1_000 };
const BUY_B = { tickLower: 500, tickUpper: 1_000 };
const SELL_B = { tickLower: -1_000, tickUpper: -500 };

/**
 * A FILLED buy level, per ordering.
 *
 * Case A: the buy range is BELOW the price and holds token1 (= WBNB). It fills
 * when the tick drops through it, so the freed principal is token0 (base) and
 * the target sell range is "above" the tick.
 * Case B: the mirror — the buy range is ABOVE the price and holds token0
 * (= WBNB); it fills when the tick rises through it, the freed principal is
 * token1 (base), and the target sell range is "below" the tick.
 */
const FILLED_TICK_A = -1_100;
const FILLED_TICK_B = 1_100;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** A signed tick as ABI-encodes it: int24, two's complement, 32-byte word. */
function tickWord(tick: number): string {
  const raw = BigInt(tick);
  return (raw < 0n ? (1n << 256n) + raw : raw).toString(16).padStart(64, "0");
}

function txAt(index: number): Hex {
  return `0x${(0xa000 + index).toString(16).padStart(64, "0")}` as Hex;
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
  readonly collectByTx = new Map<string, { amount0Wei: bigint; amount1Wei: bigint }>();
  readonly mintByTx = new Map<string, bigint>();

  async collectAmounts(txHash: Hex): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> {
    const entry = this.collectByTx.get(txHash);
    if (entry === undefined) throw new Error(`no collect receipt for ${txHash}`);
    return entry;
  }
  async swapAmounts(): Promise<never> {
    // The grid's sweep ALWAYS skips, so this reader must never be reached. A
    // throw here is the fixture's own assertion that no swap ever happened.
    throw new Error("a grid flip must never submit a sweep swap");
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
    callsId: `0x${"c1".repeat(32)}` as Hex,
    transactionHash: txHash,
  };
}

type Harness = {
  readonly agent: AgentRecord;
  readonly agentStore: MemoryAgentStore;
  readonly journal: MemoryExecutionJournal;
  readonly killswitch: MemoryKillSwitch;
  readonly store: MemoryLpSequenceStore;
  readonly cycles: MemoryLpGridCycleStore;
  readonly provider: ScriptedProvider;
  readonly positions: Map<string, LpPositionSnapshot | "burned">;
  readonly receipts: FakeReceipts;
  readonly deps: LpGridFlipDeps;
  readonly marketState: { tick: number; failAfterReads: number; reads: number };
  currentDigest: Hex;
};

async function createGridHarness(
  options: {
    /** `false` ⇒ Case A (WBNB is token1). `true` ⇒ Case B (WBNB is token0). */
    readonly wbnbIsToken0?: boolean;
    readonly quota?: LpExitQuota;
    readonly withCycles?: boolean;
  } = {},
): Promise<Harness> {
  const wbnbIsToken0 = options.wbnbIsToken0 === true;
  const now = (): number => NOW_MS;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new MemoryLpSequenceStore(now);
  const cycles = new MemoryLpGridCycleStore();
  const provider = new ScriptedProvider();
  const receipts = new FakeReceipts();
  const live = wbnbIsToken0 ? BUY_B : BUY_A;
  const target = wbnbIsToken0 ? SELL_B : SELL_A;
  const positions = new Map<string, LpPositionSnapshot | "burned">();
  positions.set("42", { liquidity: LIQ, ...live });

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
    status: "armed",
  });
  await agentStore.putAgentSessionKey(OWNER, AGENT_ID, SESSION_KEY);

  await store.createPosition({
    positionId: POSITION_ID,
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: wbnbIsToken0 ? WBNB : TOKEN_LO,
    token1: wbnbIsToken0 ? TOKEN_HI : WBNB,
    fee: 2_500,
    tokenId: "42",
    // A grid level is imported with a ZERO basis by construction (R2.1).
    basisWei: 0n,
    basisSource: "imported",
  });

  const marketState = {
    tick: wbnbIsToken0 ? FILLED_TICK_B : FILLED_TICK_A,
    failAfterReads: Number.POSITIVE_INFINITY,
    reads: 0,
  };
  const market: LpMarketReader = async (): Promise<LpSagaMarket> => {
    marketState.reads += 1;
    if (marketState.reads > marketState.failAfterReads) {
      throw new Error("simulated crash: the market reader died mid-run");
    }
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
    cycles,
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
      quota: options.quota ?? QUOTA,
      market,
      positions: async (tokenId) => {
        const entry = positions.get(tokenId.toString(10));
        if (entry === undefined) throw new Error(`no snapshot for token ${tokenId}`);
        return entry;
      },
      quote: async () => {
        throw new Error("a grid flip must never ask for a swap quote");
      },
      receipts,
      expectedPool: getAddress("0x2222222222222222222222222222222222222222"),
      conversionCompatibleTokens: new Set(),
      settingsDigest: ARMED_DIGEST,
      currentSettingsDigest: async () => harness.currentDigest,
      exitToQuote: true,
      autoRotate: false,
      relayFeePerSubmitWei: RELAY_FEE_PER_SUBMIT,
      venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
      now,
      targetRange: target,
      targetRole: "sell",
      ...(options.withCycles === false ? {} : { gridCycles: cycles }),
    },
  };
  return harness;
}

/**
 * A flip submits TWO calls: the zap-out and the mint. Deliberately NOT three —
 * the sweep script entry a rotate would need is absent here, so a sweep that
 * ever submitted would consume the mint's entry and the assertion on
 * `submitted.length` would fire first.
 */
function scriptFlip(h: Harness, freed: { amount0Wei: bigint; amount1Wei: bigint }): void {
  const wbnbIsToken0 = h.deps.targetRange === SELL_B;
  h.provider.script.push((_params, txHash) => {
    h.positions.set("42", {
      liquidity: 0n,
      ...(wbnbIsToken0 ? BUY_B : BUY_A),
    });
    h.receipts.collectByTx.set(txHash, freed);
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => {
    h.receipts.mintByTx.set(txHash, 43n);
    h.positions.set("43", { liquidity: LIQ, ...(wbnbIsToken0 ? SELL_B : SELL_A) });
    return confirmed(txHash);
  });
}

/** The freed legs of a filled buy level, in POOL ORDER, per orientation. */
function freedFor(wbnbIsToken0: boolean, base = FREED, quote = 0n): {
  amount0Wei: bigint;
  amount1Wei: bigint;
} {
  // Case A: base is token0. Case B: base is token1.
  return wbnbIsToken0
    ? { amount0Wei: quote, amount1Wei: base }
    : { amount0Wei: base, amount1Wei: quote };
}

function assertNoDuplicateSubmits(h: Harness): void {
  const seen = new Set<string>();
  for (const submit of h.provider.submitted) {
    assert.equal(seen.has(submit.hash), false, "a call batch was submitted twice");
    seen.add(submit.hash);
  }
}

/* -------------------------------------------------------------------------- */
/* Happy path, in BOTH pool orderings                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15: the flip settles and re-mints single-sided into the SIGNED range", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB is token0)" : "Case A (WBNB is token1)";

    it(`${label}: two submissions, the sweep SKIPPED, the signed target minted`, async () => {
      const h = await createGridHarness({ wbnbIsToken0 });
      scriptFlip(h, freedFor(wbnbIsToken0));

      const result = await runLpGridFlip(h.deps, POSITION_ID);
      assert.equal(result.status, "completed");
      assert.equal(result.kind, "grid-flip");
      assert.equal(result.confirmedSteps, 3, "three plan positions, one a SKIP");
      // THE assertion the shape rests on: submitted CALLS, not plan length.
      assert.equal(h.provider.submitted.length, 2, "zap-out and mint only");
      assertNoDuplicateSubmits(h);

      // The recorded plan is the invariant three kinds, so a resume can never
      // hit PLAN_MISMATCH because a step was omitted.
      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      assert.deepEqual(
        sequences[0]?.steps.map((step) => step.kind),
        ["zap-out", "sweep-token", "zap-in-mint"],
      );

      // The mint names the SIGNED target range, never a fence computation.
      const target = wbnbIsToken0 ? SELL_B : SELL_A;
      const mintCall = h.provider.submitted[1]?.calls[2];
      assert.ok(
        mintCall?.data?.includes(tickWord(target.tickLower)),
        "the mint encodes the SIGNED target's lower tick",
      );
      assert.ok(
        mintCall?.data?.includes(tickWord(target.tickUpper)),
        "the mint encodes the SIGNED target's upper tick",
      );

      // SINGLE-SIDED: the approve for the leg the mint drops is ZERO, and which
      // leg that is inverts with the orientation. `buildLpMintWbnbBatch` orders
      // its approves by ROLE (WBNB first), so under Case A the freed base is
      // the SECOND approve and under Case B it is still the second — what
      // changes is which one carries the zero.
      const wbnbApprove = h.provider.submitted[1]?.calls[0];
      const tokenApprove = h.provider.submitted[1]?.calls[1];
      assert.ok(
        wbnbApprove?.data?.endsWith(word(0n)),
        "the WBNB leg is dropped: a filled BUY level frees the BASE token",
      );
      assert.ok(
        tokenApprove?.data?.endsWith(word(FREED)),
        "the base leg carries the whole freed principal",
      );

      // NO NATIVE is attached anywhere: only opens attach native, so routine
      // flips never meter the principal against the native cap.
      for (const submit of h.provider.submitted) {
        for (const call of submit.calls) {
          assert.equal(call.value ?? 0n, 0n);
        }
      }

      // The lineage is the SAME row with a new tokenId (OQ8/C8).
      const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
      assert.equal(position?.tokenId, "43");
      assert.equal(position?.basisWei, 0n, "a grid basis stays zero");
    });

    it(`${label}: the SKIP's reason is PERSISTED and names the residue`, async () => {
      const h = await createGridHarness({ wbnbIsToken0 });
      scriptFlip(h, freedFor(wbnbIsToken0));
      await runLpGridFlip(h.deps, POSITION_ID);
      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      const note = sequences[0]?.note ?? "";
      // L2: without a `swaplessSkip` callback `makeSweepStep` sets no
      // `noteOnSkip`, `recordSkip` discards the reason, and the owner is told
      // nothing at all — 3.13 F3 verbatim.
      assert.match(note, /sweep-token skipped/u);
      assert.match(note, /NO conversion made/u);
      assert.match(note, /a grid never swaps to rebalance/u);
      assert.match(note, /Residue 0 wei/u);
      // The platform-wide `sanitizeMessage` ceiling still applies.
      assert.ok(note.length <= 280);
    });

    it(`${label}: the cycle ledger records the flip, idempotently`, async () => {
      const h = await createGridHarness({ wbnbIsToken0 });
      scriptFlip(h, freedFor(wbnbIsToken0));
      await runLpGridFlip(h.deps, POSITION_ID);
      const rows = await h.cycles.list(OWNER, AGENT_ID);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row?.direction, "to-sell");
      assert.equal(row?.fromTokenId, "42");
      assert.equal(row?.toTokenId, "43");
      assert.deepEqual(
        { lower: row?.toTickLower, upper: row?.toTickUpper },
        {
          lower: (wbnbIsToken0 ? SELL_B : SELL_A).tickLower,
          upper: (wbnbIsToken0 ? SELL_B : SELL_A).tickUpper,
        },
      );
      // The minted legs are POOL-ORDERED and the dropped one is zero.
      const minted = wbnbIsToken0 ? row?.mintedAmount1Wei : row?.mintedAmount0Wei;
      const dropped = wbnbIsToken0 ? row?.mintedAmount0Wei : row?.mintedAmount1Wei;
      assert.equal(minted, FREED);
      assert.equal(dropped, 0n);
      // A second record for the same sequence writes nothing.
      await h.cycles.record({ ...row!, direction: "to-buy" });
      const again = await h.cycles.list(OWNER, AGENT_ID);
      assert.equal(again.length, 1);
      assert.equal(again[0]?.direction, "to-sell");
    });
  }

  it("a flip with NO ledger wired still flips — the row is derived, never a gate", async () => {
    const h = await createGridHarness({ withCycles: false });
    scriptFlip(h, freedFor(false));
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal((await h.cycles.list(OWNER, AGENT_ID)).length, 0);
  });

  it("a failing ledger write never turns a completed flip into a failed one", async () => {
    const h = await createGridHarness();
    scriptFlip(h, freedFor(false));
    const exploding = {
      ...h.deps,
      gridCycles: {
        record: async (): Promise<void> => {
          throw new Error("simulated ledger outage");
        },
        list: async () => [],
        close: async () => {},
      },
    };
    const result = await runLpGridFlip(exploding, POSITION_ID);
    assert.equal(result.status, "completed");
  });

  it("a small off-side residue RIDES ALONG, bounded and disclosed", async () => {
    const h = await createGridHarness();
    // ~8 bps of the freed value at tick -1100: within the 50 bps bound.
    const dust = FREED / 1_200n;
    scriptFlip(h, freedFor(false, FREED, dust));
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", new RegExp(`Residue ${dust} wei`, "u"));
    const rows = await h.cycles.list(OWNER, AGENT_ID);
    assert.equal(rows[0]?.residueWei, dust);
    assert.ok((rows[0]?.residueBps ?? 0n) > 0n);
    assert.ok((rows[0]?.residueBps ?? 0n) <= BigInt(SWAPLESS_MAX_RESIDUE_BPS));
  });
});

/* -------------------------------------------------------------------------- */
/* R2.5 / OQ4 — pause, with no new gate                                       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.5: pause semantics fall out of driveSequence, unchanged", () => {
  it("a PAUSED agent starts NO flip, and rolls back cleanly", async () => {
    const h = await createGridHarness();
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "AGENT_PAUSED");
    assert.equal(h.provider.submitted.length, 0, "nothing was submitted");
    // `confirmedMoney === 0` ⇒ the reservation is handed back and the position
    // is free for the next cycle.
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "rolled-back");
  });

  it("a pause landing BETWEEN the settle and the mint parks held + pending-mint", async () => {
    const h = await createGridHarness();
    // Only the zap-out is scripted: the mint must never reach a submit.
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...BUY_A });
      h.receipts.collectByTx.set(txHash, freedFor(false));
      return confirmed(txHash);
    });
    // The pause arrives after step 0 has confirmed: the agent's own kill switch
    // is flipped from inside the receipt read the settle's `after` makes.
    let settled = false;
    const deps: LpGridFlipDeps = {
      ...h.deps,
      receipts: {
        collectAmounts: async (txHash: Hex) => {
          settled = true;
          await h.killswitch.pauseAgent(AGENT_ID, OWNER);
          return h.receipts.collectAmounts(txHash);
        },
        swapAmounts: h.receipts.swapAmounts.bind(h.receipts),
        mintedTokenId: h.receipts.mintedTokenId.bind(h.receipts),
      },
    };
    void settled;

    const result = await runLpGridFlip(deps, POSITION_ID);
    // The SETTLE finished under pause (step 0 is exposure-REDUCING); the mint
    // refused into a clean recoverable hold.
    assert.equal(result.status, "held");
    assert.equal(result.code, "AGENT_PAUSED");
    assert.equal(h.provider.submitted.length, 1, "the settle only");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "held");
    // THE MARKER IS WHAT MAKES THE HOLD REAL. `holdSequence` only parks a
    // sequence when `currentRecovery !== "none"`; PHASE3.11 F2 is a step that
    // declared `none` and made the guard dead code, trapping the position with
    // no crash involved.
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
  });

  it("unpausing lets the flip run — the pause is a refusal, not a corruption", async () => {
    // The spacing anchor counts EVERY in-window reservation, released ones
    // included (PHASE3.5 M3), so a retry inside `minMinutesBetweenExits` would
    // be refused on `min-interval` — correct, and not what this case is about.
    const h = await createGridHarness({
      quota: { ...QUOTA, minMinutesBetweenExits: 0 },
    });
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const refused = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(refused.code, "AGENT_PAUSED");
    await h.killswitch.unpauseAgent(AGENT_ID, OWNER);
    scriptFlip(h, freedFor(false));
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
  });

  it("a GLOBAL HALT stops the flip before it starts", async () => {
    const h = await createGridHarness();
    await h.killswitch.halt("operator");
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.code, "GLOBAL_HALT");
    assert.equal(h.provider.submitted.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.3 / M8 — G2's three conjuncts                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.3/M8: G2 refuses into a RECOVERABLE hold, never a mint", () => {
  /** Settle at the filled tick, then move the market before the mint builds. */
  async function settleThenMove(
    tickAfterSettle: number,
    freed = freedFor(false),
  ): Promise<{ h: Harness; result: Awaited<ReturnType<typeof runLpGridFlip>> }> {
    const h = await createGridHarness();
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...BUY_A });
      h.receipts.collectByTx.set(txHash, freed);
      return confirmed(txHash);
    });
    let reads = 0;
    const moving: LpMarketReader = async () => {
      reads += 1;
      const tick = reads <= 2 ? FILLED_TICK_A : tickAfterSettle;
      const sqrt = getSqrtRatioAtTick(tick);
      return {
        blockNumber: 100n,
        finalizedBlockNumber: 100n,
        observationCardinality: 500,
        poolLiquidity: 10n ** 18n,
        priceImpactBps: 0n,
        spotSqrtPriceX96: sqrt,
        twapSqrtPriceX96: sqrt,
        currentTick: tick,
      };
    };
    const result = await runLpGridFlip({ ...h.deps, market: moving }, POSITION_ID);
    return { h, result };
  }

  it("conjunct 1 — the price moved INTO the target range: held at pending-mint", async () => {
    // The tick lands inside the signed sell range [500, 1000).
    const { h, result } = await settleThenMove(750);
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /INSIDE the target range/u);
    assert.match(result.reason, /Principal SAFE in the wallet/u);
    assert.equal(h.provider.submitted.length, 1, "the mint never submitted");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
    assert.equal(sequences[0]?.state, "held");
  });

  it("the price gapped THROUGH the target — the case a SIDE CHECK ALONE passes (M8)", async () => {
    // THE MOTIVATING CASE. At tick 1500 the signed sell range [500, 1000) is
    // "below" the tick, which is a perfectly VALID side — so a gate that only
    // asked "does a side exist?" would admit here, and the mint would charge
    // token1, of which a wallet holding a freed BASE (token0) leg has nothing.
    //
    // WHICH CONJUNCT CATCHES IT, stated because the ordering is load-bearing:
    // conjunct 2 does. Flipping the derived side turns the ENTIRE principal
    // into the off-side leg — 10 000 bps of the freed value — so the residue
    // bound refuses first, and conjunct 3 (`present <= 0`) is defence in depth
    // that conjunct 2's fail-closed zero-total behaviour makes unreachable.
    // What matters for safety is that the mint refuses into a RECOVERABLE hold
    // with the principal in the wallet, which it does.
    const { h, result } = await settleThenMove(1_500);
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, new RegExp(`over the ${SWAPLESS_MAX_RESIDUE_BPS} bps bound`, "u"));
    assert.match(result.reason, /Principal SAFE in the wallet/u);
    // A PINNED RESIDUAL, not an omission: the evidence tail (which names the
    // derived side and the pool-ordered legs) is CLIPPED by `sanitizeMessage`'s
    // 280-character ceiling, exactly as PHASE3.13 R1/R2 recorded for the
    // swapless builders. This phase does not change that platform-wide cap; the
    // ordering above is what guarantees the facts an owner must act on survive
    // it, and the sacrificial tail is the derivable evidence.
    assert.ok(result.reason.length <= 280);
    assert.match(result.reason, /Evidence: tick/u);
    assert.equal(h.provider.submitted.length, 1, "the mint never submitted");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
    assert.equal(sequences[0]?.state, "held");
  });

  it("conjunct 2 — an off-side residue over the bound holds rather than stranding it", async () => {
    // A 50/50 freed principal: a side exists and the held leg agrees, but
    // stranding half the position is exactly what the bound forbids.
    const half = FREED / 2n;
    const { h, result } = await settleThenMove(FILLED_TICK_A, {
      amount0Wei: half,
      amount1Wei: half,
    });
    assert.equal(result.status, "held");
    assert.match(result.reason, new RegExp(`over the ${SWAPLESS_MAX_RESIDUE_BPS} bps bound`, "u"));
    assert.equal(h.provider.submitted.length, 1, "no sweep, and no mint");
  });

  it("the refusal and the skip note come from the SAME builder", async () => {
    const { h } = await settleThenMove(750);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    // The sweep's skip ran first and recorded its own disclosure; the mint then
    // refused with the same vocabulary and the same evidence tail.
    assert.match(sequences[0]?.note ?? "", /Grid flip/u);
  });
});

/* -------------------------------------------------------------------------- */
/* The crash matrix                                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15: the crash matrix — resume never resubmits a key", () => {
  it("a crash BEFORE any submit leaves nothing recorded and the retry starts clean", async () => {
    const h = await createGridHarness();
    h.marketState.failAfterReads = 0;
    await assert.rejects(runLpGridFlip(h.deps, POSITION_ID), /died mid-run/u);
    assert.equal(h.provider.submitted.length, 0);

    // The retry: a fresh drive of the same position finds its non-terminal
    // sequence, records nothing twice, and completes.
    scriptFlip(h, freedFor(false));
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
    assertNoDuplicateSubmits(h);
  });

  it("a crash AFTER the settle confirms resumes at the mint and submits it ONCE", async () => {
    const h = await createGridHarness();
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...BUY_A });
      h.receipts.collectByTx.set(txHash, freedFor(false));
      return confirmed(txHash);
    });
    // The market reader dies on the read that precedes the SWEEP step, i.e.
    // after the zap-out has committed.
    h.marketState.failAfterReads = 1;
    await assert.rejects(runLpGridFlip(h.deps, POSITION_ID), /died mid-run/u);
    assert.equal(h.provider.submitted.length, 1);

    // The recovery marker is on the row already: a crash right here resumes
    // into a NAMED state, which is what makes the sequence abandonable.
    let sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-mint");

    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    h.provider.script.push((_params, txHash) => {
      h.receipts.mintByTx.set(txHash, 43n);
      h.positions.set("43", { liquidity: LIQ, ...SELL_A });
      return confirmed(txHash);
    });
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.reason, "Sequence resumed and completed.");
    // TWO submissions in total, and the zap-out's key was never reused.
    assert.equal(h.provider.submitted.length, 2);
    assertNoDuplicateSubmits(h);
    sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "none");
    assert.equal(sequences[0]?.state, "completed");
  });

  it("an ambiguous submit HOLDS and never auto-replays", async () => {
    const h = await createGridHarness();
    h.provider.script.push(() => {
      throw new Error("relay transport died inside the submit window");
    });
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(result.code, "HELD_AMBIGUOUS");
    // The step's journal row is UNKNOWN: the sequence cannot advance until
    // reconcile settles it, and `grid-flip` deliberately has NO owner-signed
    // UNKNOWN resolver (R2.4) — the operator path is abandon after the stall
    // latch quiesces the row.
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    const step = sequences[0]?.steps[0];
    assert.ok(step !== undefined);
    const row = await h.journal.get(step!.journalIdempotencyKey);
    assert.equal(row?.state, "UNKNOWN");
    assert.equal(step!.journalDecisionId, lpStepDecisionId(sequences[0]!.sequenceId, 0));
  });

  it("a settings re-sign between steps refuses cleanly and holds the principal", async () => {
    const h = await createGridHarness();
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...BUY_A });
      h.receipts.collectByTx.set(txHash, freedFor(false));
      return confirmed(txHash);
    });
    let settled = false;
    const deps: LpGridFlipDeps = {
      ...h.deps,
      currentSettingsDigest: async () =>
        settled ? (`0x${"ff".repeat(32)}` as Hex) : ARMED_DIGEST,
      receipts: {
        collectAmounts: async (txHash: Hex) => {
          settled = true;
          return h.receipts.collectAmounts(txHash);
        },
        swapAmounts: h.receipts.swapAmounts.bind(h.receipts),
        mintedTokenId: h.receipts.mintedTokenId.bind(h.receipts),
      },
    };
    const result = await runLpGridFlip(deps, POSITION_ID);
    assert.equal(result.code, "SETTINGS_DIGEST_MISMATCH");
    assert.equal(result.status, "held");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
  });
});

/* -------------------------------------------------------------------------- */
/* Structural refusals                                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15: the flip refuses structurally impossible inputs", () => {
  it("an inverted target range throws before any store or chain access", async () => {
    const h = await createGridHarness();
    await assert.rejects(
      runLpGridFlip(
        { ...h.deps, targetRange: { tickLower: 1_000, tickUpper: 500 } },
        POSITION_ID,
      ),
      /target range is inverted or empty/u,
    );
    assert.equal(h.provider.submitted.length, 0);
  });

  it("an empty position refuses before money, with the principal untouched", async () => {
    const h = await createGridHarness();
    h.positions.set("42", { liquidity: 0n, ...BUY_A });
    const result = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(result.code, "BUILD_REFUSED");
    assert.equal(result.status, "rolled-back");
    assert.match(result.reason, /has nothing to settle/u);
  });

  it("the grid's own quota lane refuses a flip over maxFlipsPerDay", async () => {
    const h = await createGridHarness({
      quota: { ...QUOTA, maxGridFlipsPerDay: 1 },
    });
    scriptFlip(h, freedFor(false));
    const first = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(first.status, "completed");
    // A second flip in the same window: refused on the GRID lane, before any
    // money, and the reason names the grid rather than the exit quota.
    const second = await runLpGridFlip(h.deps, POSITION_ID);
    assert.equal(second.code, "QUOTA");
    assert.match(second.reason, /grid-flip quota is exhausted/u);
  });
});

for(const fail of [false,true])it(`LP detail runLpGridFlip: finalizer survives telemetry ${fail?"failure":"success"}`,async()=>{const h=await createGridHarness();scriptFlip(h,freedFor(false));const old=await h.store.getPosition(OWNER,AGENT_ID,POSITION_ID);const f=withFeeRecording(h.deps,[old!.tokenId!],fail);const result=await runLpGridFlip(f.deps,POSITION_ID);assert.equal(result.status,"completed",result.reason);assert.equal(f.store.attempts,1);assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,fail?0:1);});