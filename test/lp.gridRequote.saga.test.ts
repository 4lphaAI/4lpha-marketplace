import { withFeeRecording } from "./support/lpFeeFixture.js";
/**
 * PHASE3.18 — `runLpGridRequote`, over per-suite fakes.
 *
 * The harness is `test/lp.gridFlip.test.ts`'s, adapted: a scripted provider
 * that THROWS on an unscripted submit (so a test expecting N submissions
 * scripts exactly N and any extra fails loudly), memory stores, and a receipts
 * fake that is the ONLY source of money amounts. Local to this file, so nothing
 * here can perturb the flip suite it is modelled on.
 *
 * The matrices this file owes:
 *
 *   - DUAL ORIENTATION on every side-dependent behaviour (3.13 F7 / 3.15 H1).
 *   - G0 AT THE BUILD (R2.9): drift back INTO range, and a FILL, between the
 *     trigger and the build are ZERO-MONEY TERMINAL ROLLBACKS — never holds.
 *     A re-centre is discretionary and must never park a position or disarm the
 *     price stop. The re-entry race is the mandatory test.
 *   - THE PERSISTED TARGET (R2.3/C4): it is written by the create, it WINS on
 *     resume, and a recomputation that disagrees THROWS rather than overwrites.
 *   - The plan SHAPE is the flip's, so the sweep always skips and the crash
 *     matrix carries over unedited.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import {
  runLpGridRequote,
  type LpGridRequoteDeps,
  type LpMarketReader,
  type LpPositionSnapshot,
  type LpReceiptReader,
  type LpSagaMarket,
} from "../src/lp/sagas.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import {
  MemoryLpSequenceStore,
  type LpExitQuota,
} from "../src/store/lpSequences.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { hashCalls } from "../src/http/wire.js";
import { FakeWalletProvider } from "./support/serverHarness.js";
import type {
  ExecuteViaSessionParams,
  ExecutionReceipt,
} from "../src/core/types.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AGENT_ID = "grid-requote-agent";
const POSITION_ID = "grid-requote-pos";
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
  maxRequotesPerDay: 21,
};

/**
 * THE FIXTURE'S GEOMETRY, per orientation.
 *
 * A BUY level holds the QUOTE. Case A (`wbnbIsToken0 === false`) puts the quote
 * on token1, which is charged by a range at or BELOW the tick; Case B mirrors
 * it. `DRIFTED` is where the price has moved to — far enough that the live rung
 * is well beyond the policy distance — and `TARGET` is the re-centred rung one
 * gap from that fresh tick, on the SAME side.
 */
const CASE = {
  // Case A: the buy rung sits BELOW; the price ran UP away from it.
  a: {
    wbnbIsToken0: false,
    live: { tickLower: -1_000, tickUpper: -500 },
    drifted: 4_000,
    target: { tickLower: 3_000, tickUpper: 3_500 },
  },
  // Case B: the buy rung sits ABOVE; the price ran DOWN away from it.
  b: {
    wbnbIsToken0: true,
    live: { tickLower: 500, tickUpper: 1_000 },
    drifted: -4_000,
    target: { tickLower: -3_500, tickUpper: -3_000 },
  },
} as const;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
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
  readonly collectByTx = new Map<string, { amount0Wei: bigint; amount1Wei: bigint }>();
  readonly mintByTx = new Map<string, bigint>();

  async collectAmounts(txHash: Hex): Promise<{ amount0Wei: bigint; amount1Wei: bigint }> {
    const entry = this.collectByTx.get(txHash);
    if (entry === undefined) throw new Error(`no collect receipt for ${txHash}`);
    return entry;
  }
  async swapAmounts(): Promise<never> {
    // A requote NEVER swaps — it does not even change which asset the level
    // holds. A throw here is the fixture's own assertion of that.
    throw new Error("a grid requote must never submit a sweep swap");
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
  readonly store: MemoryLpSequenceStore;
  readonly provider: ScriptedProvider;
  readonly positions: Map<string, LpPositionSnapshot | "burned">;
  readonly receipts: FakeReceipts;
  readonly deps: LpGridRequoteDeps;
  readonly marketState: { tick: number };
  readonly geometry: (typeof CASE)["a"] | (typeof CASE)["b"];
};

async function createRequoteHarness(options: {
  readonly wbnbIsToken0: boolean;
  /** Override the deps' target — used by the C4 precedence test. */
  readonly targetRange?: { tickLower: number; tickUpper: number };
}): Promise<Harness> {
  const geometry = options.wbnbIsToken0 ? CASE.b : CASE.a;
  const now = (): number => NOW_MS;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new MemoryLpSequenceStore(now);
  const provider = new ScriptedProvider();
  const receipts = new FakeReceipts();
  const positions = new Map<string, LpPositionSnapshot | "burned">();
  positions.set("42", { liquidity: LIQ, ...geometry.live });

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

  await store.createPosition({
    positionId: POSITION_ID,
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: options.wbnbIsToken0 ? WBNB : TOKEN_LO,
    token1: options.wbnbIsToken0 ? TOKEN_HI : WBNB,
    fee: 2_500,
    tokenId: "42",
    basisWei: 0n,
    basisSource: "minted",
    gridLevel: 1,
    gridRole: "buy",
  });

  const marketState = { tick: geometry.drifted };
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

  return {
    agent,
    store,
    provider,
    positions,
    receipts,
    marketState,
    geometry,
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
        throw new Error("a grid requote must never ask for a swap quote");
      },
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
      targetRange: options.targetRange ?? geometry.target,
      liveRole: "buy",
      wbnbIsToken0: options.wbnbIsToken0,
    },
  };
}

/** The freed legs of an UNFILLED buy level: it still holds the QUOTE. */
function freedQuote(wbnbIsToken0: boolean): { amount0Wei: bigint; amount1Wei: bigint } {
  return wbnbIsToken0
    ? { amount0Wei: FREED, amount1Wei: 0n }
    : { amount0Wei: 0n, amount1Wei: FREED };
}

function scriptRequote(h: Harness): void {
  h.provider.script.push((_params, txHash) => {
    h.positions.set("42", { liquidity: 0n, ...h.geometry.live });
    h.receipts.collectByTx.set(txHash, freedQuote(h.deps.wbnbIsToken0));
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => {
    h.receipts.mintByTx.set(txHash, 43n);
    h.positions.set("43", { liquidity: LIQ, ...h.deps.targetRange });
    return confirmed(txHash);
  });
}

/* -------------------------------------------------------------------------- */
/* Happy path, in BOTH pool orderings                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18: the requote re-centres on the SAME side, no swap", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB is token0)" : "Case A (WBNB is token1)";

    it(`${label}: two submissions, the sweep SKIPPED, the PERSISTED target minted`, async () => {
      const h = await createRequoteHarness({ wbnbIsToken0 });
      scriptRequote(h);

      const result = await runLpGridRequote(h.deps, POSITION_ID);
      assert.equal(result.status, "completed");
      assert.equal(result.kind, "grid-requote");
      assert.equal(result.confirmedSteps, 3, "three plan positions, one a SKIP");
      assert.equal(h.provider.submitted.length, 2, "zap-out and mint only");

      // The plan SHAPE is the flip's, which is what lets the 3.11 crash matrix
      // and the `pending-mint` hold semantics carry over unedited.
      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      assert.deepEqual(
        sequences[0]?.steps.map((step) => step.kind),
        ["zap-out", "sweep-token", "zap-in-mint"],
      );

      // R2.3: the target was PERSISTED on the row by the create.
      assert.equal(sequences[0]?.targetTickLower, h.geometry.target.tickLower);
      assert.equal(sequences[0]?.targetTickUpper, h.geometry.target.tickUpper);

      // And the mint encodes exactly that, never a live-tick derivation.
      const mintCall = h.provider.submitted[1]?.calls[2];
      assert.ok(mintCall?.data?.includes(tickWord(h.geometry.target.tickLower)));
      assert.ok(mintCall?.data?.includes(tickWord(h.geometry.target.tickUpper)));

      // SINGLE-SIDED, and the leg kept is the one the level ALREADY held: an
      // unfilled BUY level holds the QUOTE, so the base approve is zero. If a
      // requote ever converted, this assertion would invert.
      const wbnbApprove = h.provider.submitted[1]?.calls[0];
      const tokenApprove = h.provider.submitted[1]?.calls[1];
      assert.ok(
        wbnbApprove?.data?.endsWith(word(FREED)),
        "the QUOTE leg carries the whole freed principal — no conversion",
      );
      assert.ok(tokenApprove?.data?.endsWith(word(0n)), "the base leg is dropped");

      // The row is REPLACED, and the ROLE is untouched: a requote keeps its
      // side by construction, so only the flip ever inverts it.
      const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
      assert.equal(position?.tokenId, "43");
      assert.equal(position?.gridRole, "buy");
      assert.equal(position?.gridLevel, 1);
    });

    it(`${label}: the sweep records its SKIP note, so the disclosure persists`, async () => {
      const h = await createRequoteHarness({ wbnbIsToken0 });
      scriptRequote(h);
      await runLpGridRequote(h.deps, POSITION_ID);
      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      assert.notEqual(sequences[0]?.note, null);
      assert.match(sequences[0]?.note ?? "", /NO conversion made/u);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* R2.9 — G0 at the BUILD is a ZERO-MONEY ROLLBACK                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.9: G0 at the build rolls back, never holds", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B" : "Case A";

    it(`${label}: THE RE-ENTRY RACE — drift back INTO range ⇒ zero-money rollback`, async () => {
      const h = await createRequoteHarness({ wbnbIsToken0 });
      // Between the trigger's two observations and this build, the price came
      // back inside the live rung. Nothing needs re-centring.
      h.marketState.tick = Math.floor(
        (h.geometry.live.tickLower + h.geometry.live.tickUpper) / 2,
      );

      const result = await runLpGridRequote(h.deps, POSITION_ID);
      assert.equal(result.status, "rolled-back");
      assert.equal(h.provider.submitted.length, 0, "NOTHING was spent");
      assert.match(result.reason ?? "", /drifted back INSIDE the level/u);
      assert.match(result.reason ?? "", /NOTHING was spent/u);

      // The position is untouched and its price stop is still armed: a held
      // sequence would have disarmed it, which is the whole argument for a
      // discretionary saga's refusals being rollbacks.
      const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
      assert.equal(position?.tokenId, "42");
      assert.equal(position?.state, "open");
      const blocking = await h.store.getAnyNonTerminalSequence(OWNER, AGENT_ID);
      assert.equal(blocking, null, "no sequence is left non-terminal");
    });

    it(`${label}: a FILL between trigger and build ⇒ zero-money rollback too`, async () => {
      const h = await createRequoteHarness({ wbnbIsToken0 });
      // Beyond the FAR edge: the level changed asset. A fill is settled by the
      // FLIP, never by a re-centre.
      h.marketState.tick = wbnbIsToken0
        ? h.geometry.live.tickUpper + 5_000
        : h.geometry.live.tickLower - 5_000;

      const result = await runLpGridRequote(h.deps, POSITION_ID);
      assert.equal(result.status, "rolled-back");
      assert.equal(h.provider.submitted.length, 0);
      assert.match(result.reason ?? "", /FILLED before the re-centre ran/u);
      assert.match(result.reason ?? "", /settled by the flip, never by a requote/u);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* C4 — the persisted target WINS                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 C4: the persisted target wins; a disagreement THROWS", () => {
  /**
   * Park the sequence at `pending-mint`: the zap-out confirms and the price
   * then lands INSIDE the target, so G2 holds. That is the state a resume
   * actually finds on this relay, and it is reached WITHOUT a thrown fake — a
   * throw inside `executeViaSession` is an ambiguous submit, which holds for a
   * different reason and would not exercise the mint's rebuild.
   */
  async function parkPendingMint(h: Harness): Promise<void> {
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...h.geometry.live });
      h.receipts.collectByTx.set(txHash, freedQuote(h.deps.wbnbIsToken0));
      h.marketState.tick = Math.floor(
        (h.geometry.target.tickLower + h.geometry.target.tickUpper) / 2,
      );
      return confirmed(txHash);
    });
    const parked = await runLpGridRequote(h.deps, POSITION_ID);
    assert.equal(parked.status, "held");
  }

  it("a resume at a DIFFERENT tick binds the SAME persisted target", async () => {
    const h = await createRequoteHarness({ wbnbIsToken0: false });
    await parkPendingMint(h);
    const midway = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(midway?.targetTickLower, h.geometry.target.tickLower);

    // THE RESUME, at a materially different price — which on this relay is the
    // DEFAULT path, not an edge case (FINDINGS (aw): 6 of 6 mainnet submissions
    // published after `awaitExecution`'s deadline). A live-tick derivation here
    // would bind a rung the trigger never saw.
    h.marketState.tick = h.geometry.drifted + 900;
    h.provider.script.push((_params, txHash) => {
      h.receipts.mintByTx.set(txHash, 43n);
      h.positions.set("43", { liquidity: LIQ, ...h.geometry.target });
      return confirmed(txHash);
    });
    const resumed = await runLpGridRequote(h.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");

    // The mint binds the ROW's target, not the fresh tick's derivation. A
    // re-derivation here is exactly the B4 defect the persistence exists for.
    const mintCall = h.provider.submitted[1]?.calls[2];
    assert.ok(mintCall?.data?.includes(tickWord(h.geometry.target.tickLower)));
    assert.ok(mintCall?.data?.includes(tickWord(h.geometry.target.tickUpper)));
  });

  it("a run handed a target that DISAGREES with the row is refused, not overwritten", async () => {
    const h = await createRequoteHarness({ wbnbIsToken0: false });
    await parkPendingMint(h);

    // A second run built from a RECOMPUTED target — the shape a builder would
    // produce by satisfying "read from the row" with a read a later derivation
    // silently replaces.
    const wrong: LpGridRequoteDeps = {
      ...h.deps,
      targetRange: {
        tickLower: h.geometry.target.tickLower + 50,
        tickUpper: h.geometry.target.tickUpper + 50,
      },
    };
    await assert.rejects(runLpGridRequote(wrong, POSITION_ID), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /PERSISTED target wins and is never overwritten/u);
      return true;
    });
    // And the row is UNCHANGED — a refusal writes nothing.
    const row = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(row?.targetTickLower, h.geometry.target.tickLower);
  });

  it("an inverted or empty target is refused before any store read", async () => {
    const h = await createRequoteHarness({
      wbnbIsToken0: false,
      targetRange: { tickLower: 100, tickUpper: 100 },
    });
    await assert.rejects(
      runLpGridRequote(h.deps, POSITION_ID),
      /persisted target range is inverted or empty/u,
    );
    assert.equal(h.provider.submitted.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* G2 at the mint                                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18: G2 at the mint refuses into a RECOVERABLE hold", () => {
  it("the price landing INSIDE the target parks pending-mint, principal safe", async () => {
    const h = await createRequoteHarness({ wbnbIsToken0: false });
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, ...h.geometry.live });
      h.receipts.collectByTx.set(txHash, freedQuote(false));
      // The zap-out confirmed; NOW the price moves into the target range.
      h.marketState.tick = Math.floor(
        (h.geometry.target.tickLower + h.geometry.target.tickUpper) / 2,
      );
      return confirmed(txHash);
    });

    const result = await runLpGridRequote(h.deps, POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(h.provider.submitted.length, 1, "the zap-out only");
    assert.match(result.reason ?? "", /INSIDE the re-centred range/u);
    // The distinction G0's rollback rests on: THIS one holds, because money
    // HAS moved and the principal is sitting in the wallet.
    assert.match(result.reason ?? "", /Principal SAFE in the wallet, held pending-mint/u);
    const row = await h.store.getNonTerminalSequence(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(row?.recoveryState, "pending-mint");
  });
});

for(const fail of [false,true])it(`LP detail runLpGridRequote: finalizer survives telemetry ${fail?"failure":"success"}`,async()=>{const h=await createRequoteHarness({wbnbIsToken0:false});scriptRequote(h);const old=await h.store.getPosition(OWNER,AGENT_ID,POSITION_ID);const f=withFeeRecording(h.deps,[old!.tokenId!],fail);const result=await runLpGridRequote(f.deps,POSITION_ID);assert.equal(result.status,"completed",result.reason);assert.equal(f.store.attempts,1);assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,fail?0:1);});