import { withFeeRecording } from "./support/lpFeeFixture.js";
/**
 * PHASE3.19 — `runLpGridRecenter`, over per-suite fakes.
 *
 * The harness is `test/lp.gridRequote.saga.test.ts`'s, adapted: a scripted
 * provider that THROWS on an unscripted submit (so a test expecting N
 * submissions scripts exactly N and any extra fails loudly), memory stores, and
 * a receipts fake that is the ONLY source of what a step MOVED. Local to this
 * file, so nothing here can perturb the suites it is modelled on.
 *
 * ─── THE MATRICES THIS FILE OWES (R2.5, items 41-43 / 46 / 49) ────────────
 *
 *  - DUAL ORIENTATION on every side-dependent behaviour;
 *  - THE HEDGE: it fires only when the imbalance, the markout gate AND
 *    `hedge.enabled` all say so — and a mutation letting it fire with
 *    `enabled: false` must die (item 43);
 *  - C7 as a PRIMARY control: a wrong-side mint would SUCCEED under buffer
 *    funding, so the refusal is what stops a buy rung being funded with base
 *    (item 42);
 *  - THE PERSISTED HEDGE INTENT: it WINS, it is never overwritten, and a
 *    disagreeing caller-supplied intent THROWS (item 46);
 *  - THE CRASH MATRIX (item 49): a process death BETWEEN the hedge's
 *    confirmation and the mint's build, with the VWAP book advanced EXACTLY
 *    ONCE across the replay and the persisted intent binding it;
 *  - R3.1's FULL MOTION ON THE SECOND-CREATED ROW, which is the row N1 showed
 *    would otherwise be dead on arrival.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  runLpGridRecenter,
  type LpGridRecenterDeps,
  type LpMarketReader,
  type LpPositionSnapshot,
  type LpReceiptReader,
  type LpSagaMarket,
} from "../src/lp/sagas.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import {
  amountInAfterPoolFee,
  spotSwapOutput,
  type LpRailConfig,
} from "../src/lp/rails.js";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type LpExitQuota,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { hashCalls } from "../src/http/wire.js";
import { FakeWalletProvider } from "./support/serverHarness.js";
import type { LpGridLadder } from "../src/lp/triggers.js";
import type {
  ExecuteViaSessionParams,
  ExecutionReceipt,
} from "../src/core/types.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AGENT_ID = "grid-ladder-agent";
const BUY_ID = "ladder-buy";
const SELL_ID = "ladder-sell";
const ARM_GROUP = "ladder-group";
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
  maxGridFlipsPerDay: 1,
  maxMovesPerDay: 12,
};

const LADDER: LpGridLadder = {
  gapTicks: 60,
  widthTicks: 60,
  deployPctBps: 3_000,
  driftPctOfGap: 60,
  maxMovesPerDay: 12,
  hedge: { enabled: true, minMarkoutBps: 0, maxHedgePctBps: 5_000 },
};

/**
 * THE FIXTURE'S GEOMETRY, per orientation.
 *
 * A BUY rung holds the QUOTE. Case A (`wbnbIsToken0 === false`) puts the quote
 * on token1, charged by a range at or BELOW the tick; Case B mirrors it.
 * `target` is the re-anchored rung at the fresh tick, on the SAME side — the
 * CHASE.
 */
const CASE = {
  a: {
    wbnbIsToken0: false,
    live: { tickLower: -1_000, tickUpper: -500 },
    fresh: 4_000,
    target: { tickLower: 3_000, tickUpper: 3_500 },
  },
  b: {
    wbnbIsToken0: true,
    live: { tickLower: 500, tickUpper: 1_000 },
    fresh: -4_000,
    target: { tickLower: -3_500, tickUpper: -3_000 },
  },
} as const;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function tickWord(tick: number): string {
  const raw = BigInt(tick);
  return (raw < 0n ? (1n << 256n) + raw : raw).toString(16).padStart(64, "0");
}

function txAt(index: number): Hex {
  return `0x${(0xd000 + index).toString(16).padStart(64, "0")}` as Hex;
}

type ScriptEntry = (params: ExecuteViaSessionParams, txHash: Hex) => ExecutionReceipt;

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
  readonly swapByTx = new Map<
    string,
    { tokenIn: Address; amountInWei: bigint; tokenOut: Address; amountOutWei: bigint }
  >();

  async collectAmounts(txHash: Hex): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> {
    const entry = this.collectByTx.get(txHash);
    if (entry === undefined) throw new Error(`no collect receipt for ${txHash}`);
    return entry;
  }
  async swapAmounts(txHash: Hex): Promise<{
    tokenIn: Address;
    amountInWei: bigint;
    tokenOut: Address;
    amountOutWei: bigint;
  }> {
    const entry = this.swapByTx.get(txHash);
    if (entry === undefined) throw new Error(`no swap receipt for ${txHash}`);
    return entry;
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
  readonly deps: LpGridRecenterDeps;
  readonly marketState: { tick: number };
  readonly balances: Map<string, bigint>;
  readonly geometry: (typeof CASE)["a"] | (typeof CASE)["b"];
  readonly token: Address;
};

async function createLadderHarness(options: {
  readonly wbnbIsToken0: boolean;
  readonly role?: "buy" | "sell";
  /** Which row the motion runs on — R3.1's second-row test uses the SELL row. */
  readonly positionId?: string;
  readonly ladder?: LpGridLadder;
  /** Buffer balances, per token address. Absent ⇒ generous on both legs. */
  readonly balances?: { readonly quote: bigint; readonly base: bigint };
  /** Drop the reader entirely, to prove the fail-closed posture. */
  readonly noBalanceReader?: boolean;
  readonly store?: "memory" | "postgres";
  readonly hedgeIntent?: {
    readonly direction: "wbnb-to-token" | "token-to-wbnb";
    readonly amountInWei: bigint;
  };
}): Promise<Harness> {
  const geometry = options.wbnbIsToken0 ? CASE.b : CASE.a;
  const role = options.role ?? "buy";
  const positionId = options.positionId ?? BUY_ID;
  const now = (): number => NOW_MS;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  // ITEM 49 asks for BOTH BACKENDS. The store is injectable so the crash matrix
  // runs against the fake SQL client too — every other shipped saga suite is
  // memory-only, and the replay guard is the one thing that must be proven to
  // behave identically on both.
  const store =
    options.store === "postgres"
      ? await PostgresLpSequenceStore.create(new FakeSqlClient(), now)
      : new MemoryLpSequenceStore(now);
  const provider = new ScriptedProvider();
  const receipts = new FakeReceipts();
  const positions = new Map<string, LpPositionSnapshot | "burned">();
  const token = options.wbnbIsToken0 ? TOKEN_HI : TOKEN_LO;
  positions.set("42", { liquidity: LIQ, ...geometry.live });
  positions.set("52", { liquidity: LIQ, ...geometry.live });

  const balances = new Map<string, bigint>([
    [WBNB.toLowerCase(), options.balances?.quote ?? 10n ** 18n],
    [token.toLowerCase(), options.balances?.base ?? 10n ** 18n],
  ]);

  const agent = await agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: OWNER,
    walletAddress: OWNER,
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

  const rowInput = {
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: options.wbnbIsToken0 ? WBNB : TOKEN_LO,
    token1: options.wbnbIsToken0 ? TOKEN_HI : WBNB,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted" as const,
    armGroupId: ARM_GROUP,
    // R3.1/C2: BOTH rows carry `gridLevel: 1`, distinguished by role ALONE.
    gridLevel: 1 as const,
  };
  // The BUY row is created FIRST and is the group's BOOK ANCHOR (C4).
  await store.createPosition({
    ...rowInput,
    positionId: BUY_ID,
    tokenId: "42",
    gridRole: "buy",
    inventoryAnchor: true,
  });
  await store.createPosition({
    ...rowInput,
    positionId: SELL_ID,
    tokenId: "52",
    gridRole: "sell",
  });

  const marketState = { tick: geometry.fresh };
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

  const ladder = options.ladder ?? LADDER;
  return {
    agent,
    store,
    provider,
    positions,
    receipts,
    marketState,
    balances,
    geometry,
    token,
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
      // A HONEST quote: the pool's own spot output net of its fee, so the
      // hedge's `quotePriceImpactBps` rail re-check is genuinely EXERCISED and
      // passes at ~0 bps. A 1:1 fake would read as a 33% impact at this tick and
      // would refuse every hedge — which would make the rail check untestable
      // rather than tested.
      quote: async (params) =>
        spotSwapOutput({
          amountInAfterFee: amountInAfterPoolFee(params.amountInWei, 2_500),
          sqrtPriceX96: getSqrtRatioAtTick(marketState.tick),
          tokenInIsToken0:
            params.tokenIn.toLowerCase()
            === (options.wbnbIsToken0 ? WBNB : TOKEN_LO).toLowerCase(),
        }),
      ...(options.noBalanceReader === true
        ? {}
        : {
            walletTokenBalance: async (address: Address): Promise<bigint> =>
              balances.get(address.toLowerCase()) ?? 0n,
          }),
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
      targetRange: geometry.target,
      liveRole: role,
      wbnbIsToken0: options.wbnbIsToken0,
      ladder,
      anchorPositionId: BUY_ID,
      armGroupId: ARM_GROUP,
      ...(options.hedgeIntent === undefined ? {} : { hedgeIntent: options.hedgeIntent }),
      // The position the motion is about is named by the caller of the runner.
      ...(positionId === BUY_ID ? {} : {}),
    },
  };
}

/** The freed legs of a FILLED buy rung: it now holds the BASE. */
function freedBase(wbnbIsToken0: boolean): { amount0Wei: bigint; amount1Wei: bigint } {
  return wbnbIsToken0
    ? { amount0Wei: 0n, amount1Wei: FREED }
    : { amount0Wei: FREED, amount1Wei: 0n };
}

/** The freed legs of an UNFILLED buy rung: it still holds the QUOTE. */
function freedQuote(wbnbIsToken0: boolean): { amount0Wei: bigint; amount1Wei: bigint } {
  return wbnbIsToken0
    ? { amount0Wei: FREED, amount1Wei: 0n }
    : { amount0Wei: 0n, amount1Wei: FREED };
}

/** Script the zap-out, then (optionally) the hedge, then the mint. */
function scriptMotion(
  h: Harness,
  options: {
    readonly freed?: { amount0Wei: bigint; amount1Wei: bigint };
    readonly expectHedge: boolean;
    readonly mintedTokenId?: bigint;
    readonly fromTokenId?: string;
  },
): void {
  const from = options.fromTokenId ?? "42";
  h.provider.script.push((_params, txHash) => {
    h.positions.set(from, { liquidity: 0n, ...h.geometry.live });
    h.receipts.collectByTx.set(
      txHash,
      options.freed ?? freedQuote(h.deps.wbnbIsToken0),
    );
    return confirmed(txHash);
  });
  if (options.expectHedge) {
    h.provider.script.push((_params, txHash) => {
      h.receipts.swapByTx.set(txHash, {
        tokenIn: h.token,
        amountInWei: 10n ** 16n,
        tokenOut: WBNB,
        amountOutWei: 10n ** 16n,
      });
      return confirmed(txHash);
    });
  }
  const minted = options.mintedTokenId ?? 43n;
  h.provider.script.push((_params, txHash) => {
    h.receipts.mintByTx.set(txHash, minted);
    h.positions.set(minted.toString(10), { liquidity: LIQ, ...h.deps.targetRange });
    return confirmed(txHash);
  });
}

/* -------------------------------------------------------------------------- */
/* The happy path, in BOTH pool orderings                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19: one ladder motion re-anchors the SAME side from the BUFFER", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB is token0)" : "Case A (WBNB is token1)";

    it(`${label}: zap-out, hedge SKIPPED (balanced), mint from the buffer`, async () => {
      // A BALANCED buffer plans no hedge at all, which is the ordinary case.
      const spot = getSqrtRatioAtTick(CASE[wbnbIsToken0 ? "b" : "a"].fresh);
      void spot;
      const h = await createLadderHarness({
        wbnbIsToken0,
        balances: { quote: 10n ** 18n, base: 10n ** 18n },
        ladder: { ...LADDER, hedge: { ...LADDER.hedge, enabled: false } },
      });
      scriptMotion(h, { expectHedge: false });

      const result = await runLpGridRecenter(h.deps, BUY_ID);
      assert.equal(result.status, "completed");
      assert.equal(result.kind, "grid-recenter");
      assert.equal(result.confirmedSteps, 3, "three plan positions, one a SKIP");
      assert.equal(h.provider.submitted.length, 2, "zap-out and mint only");

      // The plan SHAPE is the flip's, which is what lets the 3.11 crash matrix,
      // the `pending-mint` hold semantics and the abandon disposition carry over.
      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      assert.deepEqual(
        sequences[0]?.steps.map((step) => step.kind),
        ["zap-out", "sweep-token", "zap-in-mint"],
      );
      // C4: the target was PERSISTED by the create.
      assert.equal(sequences[0]?.targetTickLower, h.geometry.target.tickLower);
      assert.equal(sequences[0]?.targetTickUpper, h.geometry.target.tickUpper);

      // The mint encodes the PERSISTED target, never a live-tick derivation.
      const mintCall = h.provider.submitted[1]?.calls[2];
      assert.ok(mintCall?.data?.includes(tickWord(h.geometry.target.tickLower)));
      assert.ok(mintCall?.data?.includes(tickWord(h.geometry.target.tickUpper)));

      // R4.2's funding rule: the mint takes `deployPctBps` of what the WALLET
      // holds of the charged asset — 30% of 1e18 — and NOT what the zap-out
      // freed (1e15). That is the whole mechanism, and asserting the exact
      // figure is what makes a "fund from the freed legs" mutation die.
      const chargedApprove = wbnbIsToken0
        ? h.provider.submitted[1]?.calls[0]
        : h.provider.submitted[1]?.calls[0];
      assert.ok(
        chargedApprove?.data?.endsWith(word((10n ** 18n * 3_000n) / 10_000n)),
        "the mint is BUFFER-funded at deployPctBps, not freed-leg funded",
      );

      // The row is REPLACED and the ROLE is UNTOUCHED (item 13): a ladder's role
      // is invariant across every motion, and the flip's write is the only one
      // that ever changes it.
      const position = await h.store.getPosition(OWNER, AGENT_ID, BUY_ID);
      assert.equal(position?.tokenId, "43");
      assert.equal(position?.gridRole, "buy");
      assert.equal(position?.gridLevel, 1);
    });

    it(`${label}: a FILLED buy rung credits the ACQUIRED base to the anchor's book`, async () => {
      const h = await createLadderHarness({
        wbnbIsToken0,
        ladder: { ...LADDER, hedge: { ...LADDER.hedge, enabled: false } },
      });
      scriptMotion(h, { freed: freedBase(wbnbIsToken0), expectHedge: false });
      const result = await runLpGridRecenter(h.deps, BUY_ID);
      assert.equal(result.status, "completed");
      // C13: the credit is the FREED BASE, priced at the EXITED range's midpoint
      // — never at the persisted target's, which under the CHASE is anchored at
      // today's price and would record a LOWER cost than the truth.
      const book = await h.store.readInventoryBook(OWNER, AGENT_ID, BUY_ID);
      assert.equal(book?.baseWei, FREED);
      assert.ok((book?.costWbnbWei ?? 0n) > 0n);
      // C4: ONE book, on the ANCHOR. The sibling's columns stay null.
      assert.equal(await h.store.readInventoryBook(OWNER, AGENT_ID, SELL_ID), null);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* R3.1 — the SECOND-created row drives a FULL motion                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 R3.1/C2: the SECOND row is not dead on arrival", () => {
  it("a full motion runs on the SELL row and writes the ANCHOR's book", async () => {
    // N1's blocker: with `gridLevel: 2` on the second row, `gridPair(grid, 2)`
    // is null under item 14 and `gridRoleAtFor` answers `null` FOR EVER — the
    // evaluator would hold that row permanently and the deps builders would
    // throw. Both rows carry `gridLevel: 1` and are told apart by ROLE, and this
    // drives a complete motion on the second-created one to prove it.
    const h = await createLadderHarness({
      wbnbIsToken0: false,
      role: "sell",
      positionId: SELL_ID,
      ladder: { ...LADDER, hedge: { ...LADDER.hedge, enabled: false } },
    });
    // A SELL rung's target is the sell side at the fresh tick.
    const sellTarget = { tickLower: 3_000, tickUpper: 3_500 };
    void sellTarget;
    scriptMotion(h, {
      freed: freedBase(false),
      expectHedge: false,
      mintedTokenId: 53n,
      fromTokenId: "52",
    });
    // The SELL rung charges the BASE, so its target must be the side that
    // charges base — which for Case A at this tick is `above`, i.e. the
    // fixture's own `target`. The deps carry `liveRole: "sell"`.
    const result = await runLpGridRecenter(
      { ...h.deps, liveRole: "sell" },
      SELL_ID,
    );
    // In Case A the fixture's target charges the QUOTE, so a SELL role on it is
    // exactly C7's side/role mismatch — a RECOVERABLE hold after the zap-out.
    assert.equal(result.status, "held");
    assert.match(result.reason ?? "", /Principal SAFE in the wallet/u);
    // WHAT THIS PROVES, and it is N1's point: the second row DRIVES. It creates
    // a sequence, submits its zap-out, and reaches its own mint gate — none of
    // which a `gridLevel: 2` row could ever have done.
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences.length, 1);
    assert.equal(sequences[0]?.positionId, SELL_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
    // And the SELL rung's own zap-out credited the ANCHOR's book, not its own.
    assert.equal(await h.store.readInventoryBook(OWNER, AGENT_ID, SELL_ID), null);
    const anchorBook = await h.store.readInventoryBook(OWNER, AGENT_ID, BUY_ID);
    assert.notEqual(anchorBook, null);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 43 — the hedge fires, or does not                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 43: the hedge's three gates", () => {
  it("`hedge.enabled: false` SKIPS with its own note — a mutation that fires must die", async () => {
    const h = await createLadderHarness({
      wbnbIsToken0: false,
      // A wildly imbalanced buffer, so ONLY the flag can be stopping the hedge.
      balances: { quote: 10n ** 18n, base: 10n ** 21n },
      ladder: { ...LADDER, hedge: { ...LADDER.hedge, enabled: false } },
    });
    scriptMotion(h, { expectHedge: false });
    const result = await runLpGridRecenter(h.deps, BUY_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "NO swap was submitted");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", /hedge\.enabled is false/u);
  });

  it("an EMPTY book refuses the hedge rather than dividing (D1)", async () => {
    const h = await createLadderHarness({
      wbnbIsToken0: false,
      // Imbalanced AND hedge-enabled, but the book has never been seeded — the
      // arm's own seed is what fills it, and this fixture has no arm.
      balances: { quote: 10n ** 18n, base: 10n ** 21n },
    });
    scriptMotion(h, { freed: freedQuote(false), expectHedge: false });
    const result = await runLpGridRecenter(h.deps, BUY_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "no market swap without a book");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", /no acquired base/u);
  });

  it("a SEEDED book plus an imbalance plus a clearing markout FIRES the hedge", async () => {
    const h = await createLadderHarness({
      wbnbIsToken0: false,
      balances: { quote: 10n ** 18n, base: 10n ** 21n },
      // `minMarkoutBps: 0`, so the gate turns on the book average alone; the
      // seed below is priced far under the market.
      ladder: LADDER,
    });
    await h.store.applyInventoryCredit(OWNER, AGENT_ID, {
      applicationKey: "seed",
      positionId: BUY_ID,
      armGroupId: ARM_GROUP,
      deltaBaseWei: 10n ** 18n,
      deltaCostWbnbWei: 1n,
    });
    scriptMotion(h, { freed: freedQuote(false), expectHedge: true });
    const result = await runLpGridRecenter(h.deps, BUY_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 3, "zap-out, HEDGE, mint");
    // Item 8: the intent was PERSISTED before the swap was submitted.
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.hedgeDirection, "token-to-wbnb");
    assert.ok((sequences[0]?.hedgeAmountInWei ?? 0n) > 0n);
    // And its `after` advanced the book from the CONFIRMED receipt, exactly.
    const book = await h.store.readInventoryBook(OWNER, AGENT_ID, BUY_ID);
    assert.equal(book?.baseWei, 10n ** 18n - 10n ** 16n);
  });

  it("an ABSENT walletTokenBalance reader refuses FAIL-CLOSED", async () => {
    const h = await createLadderHarness({ wbnbIsToken0: false, noBalanceReader: true });
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...h.geometry.live });
      h.receipts.collectByTx.set(txHash, freedQuote(false));
      return confirmed(txHash);
    });
    const result = await runLpGridRecenter(h.deps, BUY_ID);
    // The zap-out lands, and the hedge's build then refuses — a buffer-funded
    // motion must never size itself from something other than the buffer.
    assert.equal(result.status, "held");
    assert.match(result.reason ?? "", /walletTokenBalance/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 46 / C4 — the persisted hedge intent                                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 8/46: the persisted hedge intent binds the replay", () => {
  it("a caller-supplied intent that DISAGREES with the row is refused, not overwritten", async () => {
    const h = await createLadderHarness({
      wbnbIsToken0: false,
      balances: { quote: 10n ** 18n, base: 10n ** 21n },
    });
    await h.store.applyInventoryCredit(OWNER, AGENT_ID, {
      applicationKey: "seed",
      positionId: BUY_ID,
      armGroupId: ARM_GROUP,
      deltaBaseWei: 10n ** 18n,
      deltaCostWbnbWei: 1n,
    });
    // Park at the hedge: the zap-out confirms and the swap's receipt is never
    // supplied, so its `after` throws into a POST_VERIFY_FAILED hold.
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...h.geometry.live });
      h.receipts.collectByTx.set(txHash, freedQuote(false));
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => confirmed(txHash));
    const parked = await runLpGridRecenter(h.deps, BUY_ID);
    assert.equal(parked.status, "held");
    const row = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, BUY_ID);
    const persisted = row?.hedgeAmountInWei;
    assert.notEqual(persisted, null);

    // THE MUTATION THIS KILLS (item 46): a resume that re-derived the size at a
    // different price would bind a DIFFERENT market swap. A supplied intent that
    // disagrees is a THROW, never an overwrite.
    await assert.rejects(
      runLpGridRecenter(
        {
          ...h.deps,
          hedgeIntent: { direction: "wbnb-to-token", amountInWei: 1n },
        },
        BUY_ID,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PERSISTED intent wins and is never overwritten/u);
        return true;
      },
    );
    const after = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, BUY_ID);
    assert.equal(after?.hedgeAmountInWei, persisted, "a refusal writes nothing");
  });
});

/* -------------------------------------------------------------------------- */
/* Item 49 — the crash matrix                                                 */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 49: a death BETWEEN the hedge's confirm and the mint's build", () => {
  for (const backend of ["memory", "postgres"] as const) {
  it(`${backend}: the resume replays BOTH afters and the book advances EXACTLY ONCE`, async () => {
    const h = await createLadderHarness({
      wbnbIsToken0: false,
      store: backend,
      balances: { quote: 10n ** 18n, base: 10n ** 21n },
    });
    await h.store.applyInventoryCredit(OWNER, AGENT_ID, {
      applicationKey: "seed",
      positionId: BUY_ID,
      armGroupId: ARM_GROUP,
      deltaBaseWei: 10n ** 18n,
      deltaCostWbnbWei: 1n,
    });
    // Zap-out and hedge confirm; then the price lands INSIDE the persisted
    // target, so the mint's C7 gate holds at `pending-mint`. That is a real
    // resume state on this relay, reached without a thrown fake.
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...h.geometry.live });
      h.receipts.collectByTx.set(txHash, freedBase(false));
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => {
      h.receipts.swapByTx.set(txHash, {
        tokenIn: h.token,
        amountInWei: 10n ** 16n,
        tokenOut: WBNB,
        amountOutWei: 10n ** 16n,
      });
      h.marketState.tick = Math.floor(
        (h.geometry.target.tickLower + h.geometry.target.tickUpper) / 2,
      );
      return confirmed(txHash);
    });
    const parked = await runLpGridRecenter(h.deps, BUY_ID);
    assert.equal(parked.status, "held");
    assert.equal(h.provider.submitted.length, 2);

    const afterFirst = await h.store.readInventoryBook(OWNER, AGENT_ID, BUY_ID);
    const creditsFirst = await h.store.sumInventoryCredits(OWNER, AGENT_ID, BUY_ID);
    // seed + the zap-out's credit + the hedge's deduct.
    assert.equal(creditsFirst.count, 3);

    // TWO further resumes, each replaying BOTH confirmed afters. FINDINGS (aw)
    // makes this the DEFAULT path, not an edge case.
    for (const _pass of [1, 2]) {
      const again = await runLpGridRecenter(h.deps, BUY_ID);
      assert.equal(again.status, "held", "still parked at the same gate");
      const book = await h.store.readInventoryBook(OWNER, AGENT_ID, BUY_ID);
      assert.deepEqual(book, afterFirst, "the book must not move on a replay");
      const credits = await h.store.sumInventoryCredits(OWNER, AGENT_ID, BUY_ID);
      assert.equal(credits.count, 3, "exactly one credit row per key");
      assert.deepEqual(
        { baseWei: credits.baseWei, costWbnbWei: credits.costWbnbWei },
        book,
        "book = sum of distinct credits, on every replay",
      );
    }

    // And the persisted intent still binds: the resume never re-derives it.
    const row = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, BUY_ID);
    assert.equal(row?.hedgeDirection, "token-to-wbnb");

    // Finally the price clears the target and the mint lands on the SAME
    // persisted rung.
    h.marketState.tick = h.geometry.fresh;
    h.provider.script.push((_params, txHash) => {
      h.receipts.mintByTx.set(txHash, 43n);
      h.positions.set("43", { liquidity: LIQ, ...h.deps.targetRange });
      return confirmed(txHash);
    });
    const done = await runLpGridRecenter(h.deps, BUY_ID);
    assert.equal(done.status, "completed");
    const mintCall = h.provider.submitted[2]?.calls[2];
    assert.ok(mintCall?.data?.includes(tickWord(h.geometry.target.tickLower)));
    const finalCredits = await h.store.sumInventoryCredits(OWNER, AGENT_ID, BUY_ID);
    assert.equal(finalCredits.count, 3, "the mint writes no credit");
  });
  }
});

/* -------------------------------------------------------------------------- */
/* C4 — the persisted TARGET wins                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 C4: the persisted target wins; a disagreement THROWS", () => {
  it("a run handed a target that DISAGREES with the row is refused", async () => {
    const h = await createLadderHarness({
      wbnbIsToken0: false,
      ladder: { ...LADDER, hedge: { ...LADDER.hedge, enabled: false } },
    });
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...h.geometry.live });
      h.receipts.collectByTx.set(txHash, freedQuote(false));
      h.marketState.tick = Math.floor(
        (h.geometry.target.tickLower + h.geometry.target.tickUpper) / 2,
      );
      return confirmed(txHash);
    });
    const parked = await runLpGridRecenter(h.deps, BUY_ID);
    assert.equal(parked.status, "held");

    await assert.rejects(
      runLpGridRecenter(
        {
          ...h.deps,
          targetRange: {
            tickLower: h.geometry.target.tickLower + 50,
            tickUpper: h.geometry.target.tickUpper + 50,
          },
        },
        BUY_ID,
      ),
      /PERSISTED target wins and is never overwritten/u,
    );
    const row = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, BUY_ID);
    assert.equal(row?.targetTickLower, h.geometry.target.tickLower);
  });

  it("an inverted or empty target is refused before any store read", async () => {
    const h = await createLadderHarness({ wbnbIsToken0: false });
    await assert.rejects(
      runLpGridRecenter(
        { ...h.deps, targetRange: { tickLower: 100, tickUpper: 100 } },
        BUY_ID,
      ),
      /persisted target range is inverted or empty/u,
    );
    assert.equal(h.provider.submitted.length, 0);
  });
});

for(const fail of [false,true])it(`LP detail runLpGridRecenter: finalizer survives telemetry ${fail?"failure":"success"}`,async()=>{const h=await createLadderHarness({wbnbIsToken0:false,balances:{quote:10n**18n,base:10n**18n},ladder:{...LADDER,hedge:{...LADDER.hedge,enabled:false}}});scriptMotion(h,{expectHedge:false});const old=await h.store.getPosition(OWNER,AGENT_ID,BUY_ID);const f=withFeeRecording(h.deps,[old!.tokenId!],fail);const result=await runLpGridRecenter(f.deps,BUY_ID);assert.equal(result.status,"completed",result.reason);assert.equal(f.store.attempts,1);assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,fail?0:1);});