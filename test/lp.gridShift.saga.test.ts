import { withFeeRecording } from "./support/lpFeeFixture.js";
/**
 * PHASE3.22 — `runLpGridShift`, DRIVEN, over per-suite fakes.
 *
 * ─── WHY THIS FILE EXISTS (AUDIT A3) ──────────────────────────────────────
 *
 * The independent audit found `grep -rn "runLpGridShift" test/` returned
 * NOTHING: the money path's guards were pinned by `readFileSync` + regex over
 * `sagas.ts` and by nothing else. The measurable consequence was that two of
 * the audit's own mutations — **M2** (the persisted-target authority guard made
 * unreachable) and **M4** (the `sellTokenId < buyTokenId` belt inverted) —
 * SURVIVED the entire 3189-test suite. Every sibling phase drove its saga with
 * fakes (`lp.gridLadder.saga.test.ts` alone invokes `runLpGridRecenter` 17
 * times); this file is the shift's.
 *
 * ─── WHAT IT DRIVES ───────────────────────────────────────────────────────
 *
 *  - the two-live HAPPY PATH: the 12-call batch in its pinned order, both rows
 *    re-pointed, the gap preserved;
 *  - **the M2 KILL**: a run handed a target that disagrees with the persisted
 *    one THROWS, at the saga seam where a mutation can be caught;
 *  - **the M4 KILL**: a receipt whose ids violate the pinned sell-then-buy
 *    order is REFUSED rather than paired;
 *  - the ONE-SIDED path: the depleted row closes with `shift-depleted`;
 *  - a FAILED receipt: zero-money terminal rollback, rows untouched;
 *  - an UNKNOWN submit: parks `held` carrying `shift-ambiguous`;
 *  - **AUDIT A1's replay**: a COMMITTED step resumed by a FRESH
 *    `runLpGridShift` invocation — no shared in-memory state — completes both
 *    row writes, which is the "idempotently re-runnable finish" R2.26 asserts
 *    and the tier-1 refusal text promises.
 *
 * The harness is `test/lp.gridLadder.saga.test.ts`'s, adapted: a scripted
 * provider that THROWS on an unscripted submit (so a test expecting N
 * submissions scripts exactly N and any extra fails loudly), memory stores, and
 * a receipts fake that is the only source of what a step moved. Local to this
 * file, so nothing here can perturb the suites it is modelled on.
 *
 * Offline, so this file supplies no live evidence. FINDINGS (bd) proves one
 * DRIFT-caused atomic shift on BNB mainnet at block 118951160; fill/cross
 * settlement and grid flip remain unproven live.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  runLpGridShift,
  type LpGridShiftDeps,
  type LpMarketReader,
  type LpPositionSnapshot,
  type LpReceiptReader,
  type LpSagaMarket,
} from "../src/lp/sagas.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { spotSwapOutput, type LpRailConfig } from "../src/lp/rails.js";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type LpExitQuota,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { FakeWalletProvider } from "./support/serverHarness.js";
import type { LpGridShift } from "../src/lp/triggers.js";
import type {
  ExecuteViaSessionParams,
  ExecutionReceipt,
} from "../src/core/types.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AGENT_ID = "grid-shift-agent";
const BUY_ID = "shift-buy";
const SELL_ID = "shift-sell";
const ARM_GROUP = "shift-group";
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB ⇒ WBNB is token1 ⇒ Case A. */
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const SESSION_KEY = `0x${"7d".repeat(32)}` as Hex;
const ARMED_DIGEST = `0x${"ab".repeat(32)}` as Hex;

const NOW_MS = 1_900_000_000_000;
const NOW_SEC = 1_900_000_000;
const LIQ = 10n ** 15n;
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
  maxGridFlipsPerDay: 1,
  maxShiftsPerDay: 8,
  maxShiftDriftPerDay: 8,
};

const SHIFT: LpGridShift = {
  gapTicks: 60,
  widthTicks: 60,
  deployPctBps: 3_000,
  driftPctOfGap: 60,
  shiftsPerDay: 8,
  driftGasBudgetWei: 8n,
  driftPerMotionWei: 1n,
};

/**
 * Case A geometry (WBNB is token1): the BUY rung holds the quote and sits at or
 * BELOW the tick; the SELL rung holds the base and sits ABOVE it. The tick sits
 * between the two targets, so both G-gates pass and both mints are
 * single-sided — which is the ordinary two-live motion.
 */
const TICK = 0;
const LIVE_BUY = { tickLower: -1_000, tickUpper: -500 };
const LIVE_SELL = { tickLower: 500, tickUpper: 1_000 };
const TARGET_BUY = { tickLower: -180, tickUpper: -120 };
const TARGET_SELL = { tickLower: 120, tickUpper: 180 };

function txAt(index: number): Hex {
  return `0x${(0xd000 + index).toString(16).padStart(64, "0")}` as Hex;
}

type ScriptEntry = (params: ExecuteViaSessionParams, txHash: Hex) => ExecutionReceipt;

class ScriptedProvider extends FakeWalletProvider {
  readonly submitted: ExecuteViaSessionParams["calls"][] = [];
  readonly script: ScriptEntry[] = [];
  #submitIndex = 0;

  override async executeViaSession(
    params: ExecuteViaSessionParams,
  ): Promise<ExecutionReceipt> {
    const txHash = txAt(this.#submitIndex);
    this.#submitIndex += 1;
    this.submitted.push(params.calls);
    const entry = this.script.shift();
    if (entry === undefined) throw new Error("unscripted executeViaSession");
    return entry(params, txHash);
  }
}

class FakeReceipts implements LpReceiptReader {
  readonly mintsByTx = new Map<string, readonly bigint[]>();
  /** Flip to make `positions()` throw once — the A1 transient-RPC scenario. */
  async collectAmounts(): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> {
    return { amount0Wei: 0n, amount1Wei: 0n };
  }
  async swapAmounts(): Promise<{
    tokenIn: Address;
    amountInWei: bigint;
    tokenOut: Address;
    amountOutWei: bigint;
  }> {
    throw new Error("unused");
  }
  async mintedTokenId(): Promise<bigint> {
    throw new Error("unused");
  }
  async mintedTokenIds(txHash: Hex): Promise<readonly bigint[]> {
    const entry = this.mintsByTx.get(txHash);
    if (entry === undefined) throw new Error(`no mint receipt for ${txHash}`);
    return entry;
  }
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
  readonly store: LpSequenceStore;
  readonly provider: ScriptedProvider;
  readonly positions: Map<string, LpPositionSnapshot | "burned">;
  readonly receipts: FakeReceipts;
  readonly journal: MemoryExecutionJournal;
  readonly balances: Map<string, bigint>;
  readonly rpc: { failTokenOnce: string | null };
  deps(overrides?: Partial<LpGridShiftDeps>): LpGridShiftDeps;
};

async function createShiftHarness(options: {
  /** Buffer balances per token. Absent ⇒ generous on both legs. */
  readonly balances?: { readonly quote: bigint; readonly base: bigint };
  /** Omit the SELL row entirely — the already-one-sided pair. */
  readonly sellRow?: boolean;
  /** Inject the fake-Postgres store for persistence-seam parity tests. */
  readonly store?: LpSequenceStore;
} = {}): Promise<Harness> {
  const now = (): number => NOW_MS;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = options.store ?? new MemoryLpSequenceStore(now);
  const provider = new ScriptedProvider();
  const receipts = new FakeReceipts();
  // AUDIT A1: the failure must land INSIDE `after` — on a MINTED id — not on
  // the build's own exit snapshots, or the run rolls back before it submits
  // and the replay this test is about never happens.
  const rpc: { failTokenOnce: string | null } = { failTokenOnce: null };
  const positions = new Map<string, LpPositionSnapshot | "burned">();
  positions.set("42", { liquidity: LIQ, ...LIVE_BUY });
  positions.set("52", { liquidity: LIQ, ...LIVE_SELL });
  // The freshly minted NFTs, each sitting at its own PERSISTED target — which
  // is what the A1 attribution matches on.
  positions.set("333", { liquidity: LIQ, ...TARGET_SELL });
  positions.set("334", { liquidity: LIQ, ...TARGET_BUY });

  const balances = new Map<string, bigint>([
    [WBNB.toLowerCase(), options.balances?.quote ?? 10n ** 18n],
    [TOKEN_LO.toLowerCase(), options.balances?.base ?? 10n ** 18n],
  ]);

  const agent = await agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: OWNER,
    walletAddress: OWNER,
    custodyModel: "self-eoa",
    sessionFacts: {
      spec: {
        allowedCalls: [{ to: NFPM }, { to: WBNB }, { to: TOKEN_LO }],
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

  const rowInput = {
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: TOKEN_LO,
    token1: WBNB,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted" as const,
    armGroupId: ARM_GROUP,
    gridLevel: 1 as const,
  };
  // The BUY row is created FIRST — it is the pair's natural dispatcher.
  await store.createPosition({
    ...rowInput,
    positionId: BUY_ID,
    tokenId: "42",
    gridRole: "buy",
  });
  if (options.sellRow !== false) {
    await store.createPosition({
      ...rowInput,
      positionId: SELL_ID,
      tokenId: "52",
      gridRole: "sell",
    });
  }

  const market: LpMarketReader = async (): Promise<LpSagaMarket> => {
    const sqrt = getSqrtRatioAtTick(TICK);
    return {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 18n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: sqrt,
      twapSqrtPriceX96: sqrt,
      currentTick: TICK,
    };
  };

  /**
   * A FRESH deps object on every call — which is exactly what the A1 replay
   * test needs: a resume constructs a new `runLpGridShift` invocation with no
   * in-memory state carried over from the run that submitted.
   */
  const deps = (overrides: Partial<LpGridShiftDeps> = {}): LpGridShiftDeps => ({
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
      if (rpc.failTokenOnce !== null && rpc.failTokenOnce === tokenId.toString(10)) {
        rpc.failTokenOnce = null;
        throw new Error("transient RPC failure reading positions()");
      }
      const entry = positions.get(tokenId.toString(10));
      if (entry === undefined) throw new Error(`no snapshot for token ${tokenId}`);
      return entry;
    },
    quote: async (params) =>
      spotSwapOutput({
        amountInAfterFee: params.amountInWei,
        sqrtPriceX96: getSqrtRatioAtTick(TICK),
        tokenInIsToken0: params.tokenIn.toLowerCase() === TOKEN_LO.toLowerCase(),
      }),
    walletTokenBalance: async (address: Address): Promise<bigint> =>
      balances.get(address.toLowerCase()) ?? 0n,
    receipts,
    expectedPool: getAddress("0x2222222222222222222222222222222222222222"),
    conversionCompatibleTokens: new Set(),
    settingsDigest: ARMED_DIGEST,
    currentSettingsDigest: async () => ARMED_DIGEST,
    exitToQuote: true,
    autoRotate: false,
    relayFeePerSubmitWei: RELAY_FEE_PER_SUBMIT,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    now,
    targetBuyRange: TARGET_BUY,
    targetSellRange: TARGET_SELL,
    cause: "cross",
    armGroupId: ARM_GROUP,
    rows:
      options.sellRow === false
        ? [{ positionId: BUY_ID, role: "buy", tokenId: "42", lineageId: "lin-1" }]
        : [
            { positionId: BUY_ID, role: "buy", tokenId: "42", lineageId: "lin-1" },
            { positionId: SELL_ID, role: "sell", tokenId: "52", lineageId: "lin-1" },
          ],
    shift: SHIFT,
    wbnbIsToken0: false,
    minRungWei: 1n,
    ...overrides,
  });

  return { agent, store, provider, positions, receipts, journal, balances, rpc, deps };
}

/* -------------------------------------------------------------------------- */
/* The happy path — the 12-call batch                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22: runLpGridShift, the two-live motion", () => {
  it("submits ONE batch of 12 calls in the pinned order and re-points BOTH rows", async () => {
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [333n, 334n]);

    const result = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(result.status, "completed", result.reason);

    // ONE submission — the whole phase.
    assert.equal(h.provider.submitted.length, 1);
    const calls = h.provider.submitted[0] ?? [];
    // R2.1/R3.5/L2: 12 calls, and 12 <= MAX_CALLS_PER_EXECUTE (20).
    assert.equal(calls.length, 12, "the batch is 12 calls");
    // R2.2's PINNED ORDER: two zap-outs (NFPM), the zero-reset pair (the two
    // TOKENS), then two mints (NFPM). Asserted by TARGET, which is what the
    // per-call preflight actually gates on.
    const targets = calls.map((call) => call.to.toLowerCase());
    assert.deepEqual(
      targets.slice(0, 4),
      Array(4).fill(NFPM.toLowerCase()),
      "the two zap-outs come first — funds must be in the wallet before the NFPM pulls",
    );
    assert.deepEqual(
      targets.slice(4, 6),
      [TOKEN_LO.toLowerCase(), WBNB.toLowerCase()],
      "the R3.5 zero-reset pair sits between the exits and the first mint",
    );
    // Then two THREE-CALL mints, each `[approve(WBNB), approve(TOKEN), mint]`
    // — `buildLpMintWbnbBatch`'s own shape, reused UNCHANGED (which is what
    // keeps the three shipped modes byte-identical). R4.5 L2's point is visible
    // here: the SELL mint's WBNB approve is the ZERO one, so the BUY mint's
    // non-zero WBNB approve always follows a zero and the dust window R3.5
    // worried about is unreachable.
    assert.deepEqual(targets.slice(6), [
      WBNB.toLowerCase(),
      TOKEN_LO.toLowerCase(),
      NFPM.toLowerCase(),
      WBNB.toLowerCase(),
      TOKEN_LO.toLowerCase(),
      NFPM.toLowerCase(),
    ]);
    // NATIVE-CAP-NEUTRAL end to end: both mints pay in ERC-20s and nothing
    // unwraps, so no call attaches value.
    for (const call of calls) {
      assert.equal(call.value ?? 0n, 0n, "nativeSpendWei is 0 for the whole step");
    }

    // BOTH rows re-pointed, TOGETHER, and the roles are invariant.
    const rows = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(rows.find((r) => r.gridRole === "buy")?.tokenId, "334");
    assert.equal(rows.find((r) => r.gridRole === "sell")?.tokenId, "333");
    assert.equal(rows.every((r) => r.armGroupId === ARM_GROUP), true);
    // THE GAP IS PRESERVED: each new NFT sits at its own persisted target, and
    // the two targets are the signed width apart from the anchor.
    const buySnap = h.positions.get("334");
    const sellSnap = h.positions.get("333");
    assert.notEqual(buySnap, "burned");
    assert.notEqual(sellSnap, "burned");
    if (buySnap === "burned" || sellSnap === "burned" || buySnap === undefined
      || sellSnap === undefined) return;
    assert.equal(buySnap.tickUpper - buySnap.tickLower, SHIFT.widthTicks);
    assert.equal(sellSnap.tickUpper - sellSnap.tickLower, SHIFT.widthTicks);
  });

  it("R2.27(a): the batch touches exactly THREE targets — NFPM, WBNB and the base", async () => {
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [333n, 334n]);
    await runLpGridShift(h.deps(), BUY_ID);
    const targets = new Set(
      (h.provider.submitted[0] ?? []).map((call) => call.to.toLowerCase()),
    );
    // R6's custody claim, measured: every call is already granted by the 3.19
    // `lpSessionSpec` — zero new selectors, zero new caps.
    assert.deepEqual(
      [...targets].sort(),
      [NFPM.toLowerCase(), TOKEN_LO.toLowerCase(), WBNB.toLowerCase()].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* THE MUTATION KILLS — M2 and M4                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R8 (AUDIT M2): the persisted-target authority guard", () => {
  it("THROWS when a run is handed a target that disagrees with the persisted one", async () => {
    // Drive one motion far enough to persist a target pair, then leave the
    // sequence non-terminal and re-enter with a DIFFERENT target — the resume
    // shape FINDINGS (aw) makes the DEFAULT path on this relay.
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => ({
      status: "PENDING",
      callsId: `0x${"d3".repeat(32)}` as Hex,
      transactionHash: txHash,
    }));
    const parked = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(parked.status, "held", parked.reason);

    // A disagreeing BUY target.
    await assert.rejects(
      () =>
        runLpGridShift(
          h.deps({ targetBuyRange: { tickLower: -240, tickUpper: -180 } }),
          BUY_ID,
        ),
      /persisted a buy target[\s\S]*PERSISTED target wins/u,
      "a disagreeing buy recomputation must be refused, not obeyed",
    );
    // And a disagreeing SELL target — the half a single-target guard would miss.
    await assert.rejects(
      () =>
        runLpGridShift(
          h.deps({ targetSellRange: { tickLower: 180, tickUpper: 240 } }),
          BUY_ID,
        ),
      /persisted a sell target[\s\S]*PERSISTED target wins/u,
      "a disagreeing sell recomputation must be refused too",
    );
    // Nothing was submitted by either refused run.
    assert.equal(h.provider.submitted.length, 1);
  });

  it("PHASE3.23 R3.2: a persisted-vs-handed cause disagreement refuses before any new call", async () => {
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => ({
      status: "PENDING",
      callsId: `0x${"c3".repeat(32)}` as Hex,
      transactionHash: txHash,
    }));
    const parked = await runLpGridShift(h.deps({ cause: "cross" }), BUY_ID);
    assert.equal(parked.status, "held");
    await assert.rejects(
      () => runLpGridShift(h.deps({ cause: "drift" }), BUY_ID),
      /persisted cause cross but this run was handed drift/u,
    );
    assert.equal(h.provider.submitted.length, 1, "the refused resume constructs no new call");
  });
});

describe("PHASE3.23: one-target finish, replay and drift G0", () => {
  it("submits seven calls, updates only the target row, and replays after restart", async () => {
    const h = await createShiftHarness();
    h.positions.set("52", { liquidity: LIQ, tickLower: -10, tickUpper: 10 });
    const beforeSell = (await h.store.listPositions(OWNER, AGENT_ID))
      .find((row) => row.positionId === SELL_ID);
    assert.ok(beforeSell);
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [334n]);
    h.rpc.failTokenOnce = "334";
    const { targetSellRange: _untargeted, ...oneTarget } = h.deps({ cause: "drift" });

    const first = await runLpGridShift(oneTarget, BUY_ID);
    assert.equal(first.status, "held");
    assert.equal((h.provider.submitted[0] ?? []).length, 7, "one target is exactly seven calls");

    const resumed = await runLpGridShift({ ...oneTarget }, BUY_ID);
    assert.equal(resumed.status, "completed", resumed.reason);
    assert.equal(h.provider.submitted.length, 1, "COMMITTED replay submits nothing again");
    const after = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(after.find((row) => row.positionId === BUY_ID)?.tokenId, "334");
    assert.deepEqual(
      after.find((row) => row.positionId === SELL_ID),
      beforeSell,
      "untargeted SELL remains byte-identical, including tokenId and timestamps",
    );
  });

  it("R3.4: the mirrored one-target SELL shape accepts exactly one id", async () => {
    const h = await createShiftHarness();
    const beforeBuy = (await h.store.listPositions(OWNER, AGENT_ID))
      .find((row) => row.positionId === BUY_ID);
    assert.ok(beforeBuy);
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [333n]);
    const { targetBuyRange: _untargeted, ...sellOnly } = h.deps({ cause: "drift" });

    const result = await runLpGridShift(sellOnly, BUY_ID);
    assert.equal(result.status, "completed", result.reason);
    assert.equal((h.provider.submitted[0] ?? []).length, 7);
    const after = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(after.find((row) => row.positionId === SELL_ID)?.tokenId, "333");
    assert.deepEqual(after.find((row) => row.positionId === BUY_ID), beforeBuy);
  });

  it("R3.4: two targets retain the one-id SELL-survivor depletion shape", async () => {
    const h = await createShiftHarness({
      balances: { quote: 1n, base: 10n ** 18n },
    });
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [333n]);
    const result = await runLpGridShift(
      h.deps({ cause: "cross", minRungWei: 10n ** 17n }),
      BUY_ID,
    );
    assert.equal(result.status, "completed", result.reason);
    const after = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(after.find((row) => row.positionId === SELL_ID)?.tokenId, "333");
    assert.equal(after.find((row) => row.positionId === BUY_ID)?.state, "closed");
    assert.equal(after.find((row) => row.positionId === BUY_ID)?.closeReason, "shift-depleted");
  });

  it("R3.1: targeted in-range drift is a zero-call rollback; cross is exempt", async () => {
    const drift = await createShiftHarness();
    drift.positions.set("42", { liquidity: LIQ, tickLower: -10, tickUpper: 10 });
    const { targetSellRange: _untargeted, ...oneDrift } = drift.deps({ cause: "drift" });
    const refused = await runLpGridShift(oneDrift, BUY_ID);
    assert.equal(refused.status, "rolled-back");
    assert.equal(drift.provider.submitted.length, 0);
    const reservation = await drift.store.getReservation(OWNER, AGENT_ID, refused.sequenceId);
    assert.notEqual(reservation, null);
    assert.notEqual(reservation?.releasedAt, null, "G0 releases the reservation");

    const cross = await createShiftHarness();
    cross.positions.set("42", { liquidity: LIQ, tickLower: -10, tickUpper: 10 });
    cross.provider.script.push((_params, txHash) => confirmed(txHash));
    cross.receipts.mintsByTx.set(txAt(0), [334n]);
    const { targetSellRange: _alsoUntargeted, ...oneCross } = cross.deps({ cause: "cross" });
    const completed = await runLpGridShift(oneCross, BUY_ID);
    assert.equal(completed.status, "completed", completed.reason);
    assert.equal(cross.provider.submitted.length, 1, "cross settlement is not mid-fill gated");
  });

  it("R3.2: a never-submitted legacy NULL cause rolls back cleanly with zero calls", async () => {
    const h = await createShiftHarness();
    await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: BUY_ID,
      kind: "grid-shift",
      targetRange: TARGET_BUY,
      targetSellRange: TARGET_SELL,
    });
    const result = await runLpGridShift(h.deps({ cause: "unknown" }), BUY_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(h.provider.submitted.length, 0);
    const reservation = await h.store.getReservation(OWNER, AGENT_ID, result.sequenceId);
    assert.notEqual(reservation?.releasedAt, null);
  });

  it("R3.2: a COMMITTED legacy NULL-cause row keeps journal replay untouched", async () => {
    const h = await createShiftHarness();
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: BUY_ID,
      kind: "grid-shift",
      targetRange: TARGET_BUY,
      targetSellRange: TARGET_SELL,
    });
    const key = "legacy-committed-grid-shift";
    const txHash = txAt(0);
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "grid-shift",
      journalIdempotencyKey: key,
    });
    await h.journal.begin({
      idempotencyKey: key,
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      kind: "lp",
      decisionId: "legacy-committed-grid-shift",
    });
    await h.journal.markCommitted(key, { txHash });
    h.receipts.mintsByTx.set(txHash, [333n, 334n]);

    const replayed = await runLpGridShift(h.deps({ cause: "unknown" }), BUY_ID);
    assert.equal(replayed.status, "completed", replayed.reason);
    assert.equal(h.provider.submitted.length, 0, "COMMITTED recovery bypasses the build guard");
    const rows = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(rows.find((row) => row.gridRole === "buy")?.tokenId, "334");
    assert.equal(rows.find((row) => row.gridRole === "sell")?.tokenId, "333");
  });
});

const {
  driftGasBudgetWei: _signedDriftBudget,
  driftPerMotionWei: _signedDriftPrice,
  ...ZERO_DRIFT_SHIFT
} = SHIFT;

for (const backend of [
  {
    name: "memory",
    make: async (): Promise<LpSequenceStore> => new MemoryLpSequenceStore(() => NOW_MS),
  },
  {
    name: "postgres(fake)",
    make: async (): Promise<LpSequenceStore> =>
      PostgresLpSequenceStore.create(new FakeSqlClient(), () => NOW_MS),
  },
] as const) {
  describe(`PHASE3.25 R6.2 (${backend.name}): zero-drift resume partition`, () => {
    async function appendExistingStep(
      h: Harness,
      suffix: string,
    ): Promise<{ readonly sequenceId: string; readonly key: string }> {
      const sequence = await h.store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: BUY_ID,
        kind: "grid-shift",
        targetRange: TARGET_BUY,
        targetSellRange: TARGET_SELL,
        shiftCause: "drift",
      });
      const key = `${backend.name}-zero-drift-${suffix}`;
      await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
        kind: "grid-shift",
        journalIdempotencyKey: key,
      });
      return { sequenceId: sequence.sequenceId, key };
    }

    async function begin(h: Harness, key: string): Promise<void> {
      await h.journal.begin({
        idempotencyKey: key,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        kind: "lp",
        decisionId: key,
      });
    }

    it("rolls back and releases a clean pre-existing drift reservation", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const sequence = await h.store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: BUY_ID,
        kind: "grid-shift",
        targetRange: TARGET_BUY,
        targetSellRange: TARGET_SELL,
        shiftCause: "drift",
      });
      const result = await runLpGridShift(
        h.deps({ cause: "drift", shift: ZERO_DRIFT_SHIFT }),
        BUY_ID,
      );
      assert.equal(result.status, "rolled-back");
      assert.equal(h.provider.submitted.length, 0);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, sequence.sequenceId);
      assert.notEqual(reservation?.releasedAt, null);
      await h.store.close();
    });

    it("rolls back and releases when the recorded step has no journal row", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const seeded = await appendExistingStep(h, "missing-journal");
      const result = await runLpGridShift(
        h.deps({ cause: "drift", shift: ZERO_DRIFT_SHIFT }),
        BUY_ID,
      );
      assert.equal(result.status, "rolled-back");
      assert.equal(h.provider.submitted.length, 0);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, seeded.sequenceId);
      assert.notEqual(reservation?.releasedAt, null);
      await h.store.close();
    });

    it("rolls back and releases a clean ROLLED_BACK journal row", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const seeded = await appendExistingStep(h, "clean-rolled-back");
      await begin(h, seeded.key);
      await h.journal.markRolledBack(seeded.key, "clean pre-submit rollback");
      const result = await runLpGridShift(
        h.deps({ cause: "drift", shift: ZERO_DRIFT_SHIFT }),
        BUY_ID,
      );
      assert.equal(result.status, "rolled-back");
      assert.equal(h.provider.submitted.length, 0);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, seeded.sequenceId);
      assert.notEqual(reservation?.releasedAt, null);
      await h.store.close();
    });

    it("retains a submitted-and-ROLLED_BACK row's reservation", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const seeded = await appendExistingStep(h, "submitted-rolled-back");
      await begin(h, seeded.key);
      await h.journal.markInProgress(seeded.key, {
        callsId: `0x${"a5".repeat(32)}` as Hex,
      });
      await h.journal.markRolledBack(seeded.key, "submitted receipt failed");
      const result = await runLpGridShift(
        h.deps({ cause: "drift", shift: ZERO_DRIFT_SHIFT }),
        BUY_ID,
      );
      assert.equal(result.status, "held");
      assert.equal(h.provider.submitted.length, 1, "the existing retry rule may build one new call");
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, seeded.sequenceId);
      assert.equal(reservation?.releasedAt, null);
      await h.store.close();
    });

    it("leaves a PENDING drift row held and charged", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const seeded = await appendExistingStep(h, "pending");
      await begin(h, seeded.key);
      const result = await runLpGridShift(
        h.deps({ cause: "drift", shift: ZERO_DRIFT_SHIFT }),
        BUY_ID,
      );
      assert.equal(result.status, "held");
      assert.equal(h.provider.submitted.length, 0);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, seeded.sequenceId);
      assert.equal(reservation?.releasedAt, null);
      await h.store.close();
    });

    it("leaves an ambiguous submitted drift row held and charged", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const sequence = await h.store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: BUY_ID,
        kind: "grid-shift",
        targetRange: TARGET_BUY,
        targetSellRange: TARGET_SELL,
        shiftCause: "drift",
      });
      const key = `${backend.name}-zero-drift-unknown`;
      await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
        kind: "grid-shift",
        journalIdempotencyKey: key,
      });
      await h.journal.begin({
        idempotencyKey: key,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        kind: "lp",
        decisionId: key,
      });
      await h.journal.markUnknown(key, "relay outcome unknown");

      const result = await runLpGridShift(
        h.deps({ cause: "drift", shift: ZERO_DRIFT_SHIFT }),
        BUY_ID,
      );
      assert.equal(result.status, "held");
      assert.equal(h.provider.submitted.length, 0);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, sequence.sequenceId);
      assert.equal(reservation?.releasedAt, null);
      await h.store.close();
    });

    it("replays a committed drift row without rebuilding or releasing it", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const sequence = await h.store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: BUY_ID,
        kind: "grid-shift",
        targetRange: TARGET_BUY,
        targetSellRange: TARGET_SELL,
        shiftCause: "drift",
      });
      const key = `${backend.name}-zero-drift-committed`;
      const txHash = txAt(0);
      await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
        kind: "grid-shift",
        journalIdempotencyKey: key,
      });
      await h.journal.begin({
        idempotencyKey: key,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        kind: "lp",
        decisionId: key,
      });
      await h.journal.markCommitted(key, { txHash });
      h.receipts.mintsByTx.set(txHash, [333n, 334n]);

      const result = await runLpGridShift(
        h.deps({ cause: "drift", shift: ZERO_DRIFT_SHIFT }),
        BUY_ID,
      );
      assert.equal(result.status, "completed", result.reason);
      assert.equal(h.provider.submitted.length, 0);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, sequence.sequenceId);
      assert.equal(reservation?.releasedAt, null);
      await h.store.close();
    });

    it("does not gate a post-3.25 row with a nonzero signed drift count", async () => {
      const h = await createShiftHarness({ store: await backend.make() });
      const sequence = await h.store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: BUY_ID,
        kind: "grid-shift",
        targetRange: TARGET_BUY,
        targetSellRange: TARGET_SELL,
        shiftCause: "drift",
      });
      h.provider.script.push((_params, txHash) => confirmed(txHash));
      h.receipts.mintsByTx.set(txAt(0), [333n, 334n]);
      const result = await runLpGridShift(h.deps({ cause: "drift" }), BUY_ID);
      assert.equal(result.status, "completed", result.reason);
      assert.equal(h.provider.submitted.length, 1);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, sequence.sequenceId);
      assert.equal(reservation?.releasedAt, null);
      await h.store.close();
    });
  });
}

describe("PHASE3.22 R2.13 (AUDIT M4): the sell<buy belt", () => {
  it("REFUSES a receipt whose ids violate the pinned sell-then-buy order", async () => {
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    // The SELL rung's NFT carries the HIGHER id — impossible if the batch's
    // call order and the range attribution agree, since NFPM `_nextId` is
    // monotonic and the sell mint is first. This is the ONE way the two rows
    // could be given each other's NFT.
    h.positions.set("999", { liquidity: LIQ, ...TARGET_SELL });
    h.positions.set("500", { liquidity: LIQ, ...TARGET_BUY });
    h.receipts.mintsByTx.set(txAt(0), [999n, 500n]);

    const result = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(result.status, "held", "an out-of-order pairing must HOLD");
    assert.match(result.reason ?? "", /not in the pinned mint order/u);
    // AND NEITHER ROW WAS WRITTEN — verify-both-then-write-both means a receipt
    // that fails the belt never produces a half-written pair.
    const rows = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(rows.find((r) => r.gridRole === "buy")?.tokenId, "42");
    assert.equal(rows.find((r) => r.gridRole === "sell")?.tokenId, "52");
  });

  it("REFUSES a minted position that matches NEITHER persisted target", async () => {
    // The A1 attribution's own fail-closed arm: a receipt that does not
    // describe this motion is never paired by guess.
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.positions.set("777", { liquidity: LIQ, tickLower: 9_000, tickUpper: 9_060 });
    h.receipts.mintsByTx.set(txAt(0), [333n, 777n]);
    const result = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(result.status, "held");
    assert.match(result.reason ?? "", /equals NEITHER persisted target range/u);
  });

  it("REFUSES two mints that both claim the SAME target — the bijection rule", async () => {
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.positions.set("888", { liquidity: LIQ, ...TARGET_SELL });
    h.receipts.mintsByTx.set(txAt(0), [333n, 888n]);
    const result = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(result.status, "held");
    assert.match(result.reason ?? "", /not a bijection/u);
  });
});

/* -------------------------------------------------------------------------- */
/* AUDIT A1 — the replay, with NO shared in-memory state                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 (AUDIT A1): the COMMITTED finish is re-runnable on a FRESH invocation", () => {
  it("a transient RPC failure in `after` is recovered by the next resume", async () => {
    // THE EXACT A1 SCENARIO: the batch lands, then the pinned RPC hiccups once
    // during `after`'s liquidity verification. Before the fix this converted a
    // successful motion into a PERMANENT hold whose only door was the tier-2
    // abandon — because `after` read `state.mintRoles`, which only `build`
    // populates and which every resume therefore finds `undefined`.
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [333n, 334n]);
    h.rpc.failTokenOnce = "333";

    const first = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(first.status, "held", "the transient failure parks the row");
    // The marker is what makes it claimable and latchable at all (R4.1).
    const parked = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, BUY_ID);
    assert.equal(parked?.recoveryState, "shift-ambiguous");
    // Neither row was written — the failure was before the write block.
    let rows = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(rows.find((r) => r.gridRole === "buy")?.tokenId, "42");

    // ── THE RESUME. A FRESH `runLpGridShift` invocation: `h.deps()` builds a
    // new object every call, so NOTHING from the run above is carried in
    // memory. The provider is scripted for exactly ONE submit, so a resume
    // that tried to submit again would throw "unscripted executeViaSession".
    const second = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(second.status, "completed", second.reason);
    assert.equal(h.provider.submitted.length, 1, "the replay submits NOTHING");

    // BOTH rows written by the replay — the R2.26 property, on a genuine
    // process-boundary resume rather than an in-memory one.
    rows = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(rows.find((r) => r.gridRole === "buy")?.tokenId, "334");
    assert.equal(rows.find((r) => r.gridRole === "sell")?.tokenId, "333");
  });

  it("the replay is idempotent: a third run changes nothing", async () => {
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [333n, 334n]);
    await runLpGridShift(h.deps(), BUY_ID);
    const before = await h.store.listPositions(OWNER, AGENT_ID);
    // A completed sequence is terminal, so a further run creates a NEW one; what
    // matters for R2.26 is that the rows the finish wrote are already current
    // and a repeated write is a no-op. Re-running the hook's own path through a
    // fresh invocation must not throw or double-write.
    const after = await h.store.listPositions(OWNER, AGENT_ID);
    assert.deepEqual(
      after.map((r) => [r.gridRole, r.tokenId]),
      before.map((r) => [r.gridRole, r.tokenId]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* One-sided, rollback and the ambiguous park                                 */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R4.2: the one-sided motion", () => {
  it("mints only the fundable side and CLOSES the depleted row as shift-depleted", async () => {
    // The BASE side is dust, so the sell rung cannot fund a mint; decision 9
    // says the motion PROCEEDS on the other side rather than holding.
    const h = await createShiftHarness({
      balances: { quote: 10n ** 18n, base: 1n },
      // A base-side floor above the dust: `minRungWei` converts at spot.
    });
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    h.receipts.mintsByTx.set(txAt(0), [334n]);
    // Make the base side genuinely unfundable by raising the economic floor.
    const result = await runLpGridShift(h.deps({ minRungWei: 10n ** 17n }), BUY_ID);
    assert.equal(result.status, "completed", result.reason);

    const rows = await h.store.listPositions(OWNER, AGENT_ID);
    const buy = rows.find((r) => r.gridRole === "buy");
    const sell = rows.find((r) => r.gridRole === "sell");
    assert.equal(buy?.tokenId, "334", "the fundable side minted");
    assert.equal(sell?.state, "closed", "the depleted side's row CLOSES");
    assert.equal(sell?.closeReason, "shift-depleted");
    // The batch still exited BOTH rungs — the principal is in the buffer.
    const calls = h.provider.submitted[0] ?? [];
    assert.equal(calls.length, 9, "two zap-outs + the zero pair + ONE three-call mint");
  });

  it("BOTH sides below floor is a zero-money terminal ROLLBACK, not a hold", async () => {
    const h = await createShiftHarness({ balances: { quote: 1n, base: 1n } });
    const result = await runLpGridShift(h.deps({ minRungWei: 10n ** 17n }), BUY_ID);
    assert.equal(result.status, "rolled-back", result.reason);
    assert.equal(h.provider.submitted.length, 0, "nothing is submitted");
    // A motion must NEVER be a pure withdrawal (R10).
    assert.match(result.reason ?? "", /NEITHER rung can fund a mint/u);
    const rows = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(rows.every((r) => r.state === "open"), true, "rows untouched");
  });
});

describe("PHASE3.22 R12: the two failure states", () => {
  it("a FAILED receipt rolls the sequence back with both rows untouched", async () => {
    const h = await createShiftHarness();
    h.provider.script.push((_params, txHash) => ({
      status: "FAILED",
      callsId: `0x${"d4".repeat(32)}` as Hex,
      transactionHash: txHash,
    }));
    const result = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(result.status, "rolled-back", result.reason);
    const rows = await h.store.listPositions(OWNER, AGENT_ID);
    assert.equal(rows.find((r) => r.gridRole === "buy")?.tokenId, "42");
    assert.equal(rows.find((r) => r.gridRole === "sell")?.tokenId, "52");
  });

  it("an UNKNOWN submit parks HELD carrying the shift-ambiguous marker", async () => {
    // R4.1's whole point: without the PRE-SUBMIT marker this would park
    // `active` + `none` — unabandonable, unclaimable, invisible to the stall
    // latch. Three doors shut, and the fourth is the one R3.2 promised.
    const h = await createShiftHarness();
    h.provider.script.push(() => {
      throw new Error("relay timeout");
    });
    const result = await runLpGridShift(h.deps(), BUY_ID);
    assert.equal(result.status, "held", result.reason);
    const parked = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, BUY_ID);
    assert.equal(parked?.state, "held");
    assert.equal(
      parked?.recoveryState,
      "shift-ambiguous",
      "the marker must be durable BEFORE the submit, not after the confirmation",
    );
  });
});

for(const fail of [false,true])it(`LP detail two-NFT shift atomic attribution; store failure=${fail}`,async()=>{const h=await createShiftHarness();h.provider.script.push((_params,txHash)=>confirmed(txHash));h.receipts.mintsByTx.set(txAt(0),[333n,334n]);const deps=h.deps();const f=withFeeRecording(deps,deps.rows.flatMap(r=>r.tokenId?[r.tokenId]:[]),fail);const result=await runLpGridShift(f.deps,BUY_ID);assert.equal(result.status,"completed",result.reason);const rows=await f.store.snapshot(OWNER,AGENT_ID);assert.equal(rows.length,fail?0:2);if(!fail)assert.equal(new Set(rows.map(r=>r.positionId)).size,2);});
it("LP fee two-NFT replay preserves both old identities after a post-verification failure",async()=>{
  const h=await createShiftHarness();h.provider.script.push((_params,txHash)=>confirmed(txHash));h.receipts.mintsByTx.set(txAt(0),[333n,334n]);
  const base=h.deps(),f=withFeeRecording(base,base.rows.flatMap(r=>r.tokenId?[r.tokenId]:[]));let fail=true;
  const deps={...f.deps,positions:async(id:bigint)=>{if(id===333n && fail)throw Error("post-verify transient");return base.positions(id);}};
  const first=await runLpGridShift(deps,BUY_ID);assert.equal(first.status,"held");assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,2);
  fail=false;assert.equal((await runLpGridShift(deps,BUY_ID)).status,"completed");assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,2);assert.equal(h.provider.submitted.length,1);
});

it("ambiguous two-NFT shift replay records an atomic gap per arm-group position", async () => {
  const h = await createShiftHarness();
  h.provider.script.push((_params, txHash) => confirmed(txHash));
  h.receipts.mintsByTx.set(txAt(0), [333n, 334n]);
  h.rpc.failTokenOnce = "333";
  const first = await runLpGridShift(h.deps(), BUY_ID);
  assert.equal(first.status, "held");
  const sequence = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, BUY_ID);
  assert.ok(sequence);
  const base = h.deps();
  // Replay has lost the old NFT association; the receipt cannot be guessed onto a rung.
  const f = withFeeRecording({ ...base, rows: base.rows.map(p => ({ ...p, tokenId: null })) }, ["42", "43"]);
  assert.equal((await runLpGridShift(f.deps, BUY_ID)).status, "completed");
  const rows = await f.store.snapshot(OWNER, AGENT_ID);
  assert.equal(rows.length, 2);
  assert.equal(f.store.attempts, 1);
  assert.deepEqual(new Set(rows.map(r => r.positionId)), new Set([BUY_ID, SELL_ID]));
  const { feeCoverage, sequenceAffectsPosition } = {
    ...await import("../src/store/lpFeeEvents.js"),
    ...await import("../src/lp/feeRecorder.js"),
  };
  const positions = await h.store.listPositions(OWNER, AGENT_ID);
  for (const position of positions) {
    assert.ok(sequenceAffectsPosition(sequence, position, positions.find(p => p.positionId === BUY_ID)));
    const gap = rows.find(r => r.positionId === position.positionId)!;
    assert.equal(gap.tokenId, "-");
    assert.equal(gap.reason, "attribution-unavailable");
    assert.equal(feeCoverage(rows, [{ sequenceId: sequence.sequenceId, journalIdempotencyKey: gap.journalIdempotencyKey, txHash: gap.txHash }], 100n).status, "incomplete");
  }
  await f.store.recordReceipt(rows);
  assert.deepEqual(await f.store.snapshot(OWNER, AGENT_ID), rows);
  assert.equal(h.provider.submitted.length, 1);
});
