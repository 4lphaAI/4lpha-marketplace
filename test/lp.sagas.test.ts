import { withFeeRecording } from "./support/lpFeeFixture.js";
/**
 * The LP saga runner (PHASE3 Rev2 items 9–17, 23, 27–28, 31–32).
 *
 * Offline, fake everything: memory stores, a scripted provider that records
 * every batch it was handed, reader fakes for market/positions/quotes and a
 * receipts fake that is the ONLY source of money amounts. The matrices the
 * spec demands live here: crash (kill before submit / inside submit / after
 * confirm ⇒ resume skips confirmed, holds UNKNOWN, never resubmits a key),
 * pause (mirroring `audit.pauseExit.test.ts` — protect proceeds, rotate holds
 * at pending-mint, halt blocks all), settings-digest mismatch, server-derived
 * floors byte-exact in the submitted calldata, and the structural
 * protect-never-brain rule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { custom } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB } from "@altananetwork/sdk";
import { prepareCalls, sendPreparedCalls, signCalls } from "porto/viem/RelayActions";
import {
  OPTIONAL_TRANSIENT_RETRY_ATTEMPTS,
  planLpSweep,
  runLpHarvest,
  runLpManualExit,
  runLpProtect,
  runLpRotate,
  type LpMarketReader,
  type LpPositionSnapshot,
  type LpReceiptReader,
  type LpSagaDeps,
  type LpSagaMarket,
} from "../src/lp/sagas.js";
import { runLpOpen } from "../src/lp/open.js";
import {
  amountInAfterPoolFee,
  sagaDecreaseFloors,
  sagaMintFloors,
  sagaSwapMinOut,
  type LpRailConfig,
} from "../src/lp/rails.js";
import { Q96, getLiquidityForAmounts, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { SWAPLESS_MAX_RESIDUE_BPS } from "../src/lp/fence.js";
import { sanitizeMessage } from "../src/core/errors.js";
import {
  DEFAULT_LP_SETTINGS,
  evaluateLpTriggers,
  lpHarvestRangeHoldReason,
} from "../src/lp/triggers.js";
import {
  DEFAULT_QUOTE_TOKEN,
  LpPositionResolvingError,
  MemoryLpSequenceStore,
  lpStepDecisionId,
  type LpExitQuota,
  type LpRecoveryState,
  type LpSequenceState,
} from "../src/store/lpSequences.js";
import {
  MemoryExecutionJournal,
  reconcile,
} from "../src/store/journal.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { PostgresAgentStore } from "../src/store/agents.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { executeIdempotencyKey } from "../src/auth/executeDecision.js";
import { hashCalls } from "../src/http/wire.js";
import { FakeWalletProvider } from "./support/serverHarness.js";
import type {
  ExecuteViaSessionParams,
  ExecutionReceipt,
  GetTokenBalanceParams,
  WalletCall,
} from "../src/core/types.js";
import { PortoStagedLpAdapter, PORTO_V055_ORCHESTRATOR,
  encodeLpFinalCallsV1 } from "../src/lp/preparedIntent.js";
import { validateSessionSpec } from "../src/core/session.js";
import { FakeSqlClient } from "./support/fakeSql.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = OWNER;
const AGENT_ID = "lp-agent-1";
const POSITION_ID = "pos-1";
/** Sorts BELOW WBNB, so WBNB is token1 and the TOKEN leg is amount0. */
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/**
 * PHASE3.13 B9: a paired token that sorts ABOVE WBNB, so a pool can be built
 * with `wbnbIsToken0 === true` without violating `orderedLegs`' pool-order
 * requirement (`token0 < token1`). Roughly half of BSC's WBNB pools look like
 * this, and it is the ordering the role-named carried state inverts on.
 */
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const POOL = getAddress("0x2222222222222222222222222222222222222222");
const SESSION_KEY = `0x${"7d".repeat(32)}` as Hex;
const ARMED_DIGEST = `0x${"ab".repeat(32)}` as Hex;

const NOW_MS = 1_900_000_000_000;
const NOW_SEC = 1_900_000_000;
const DEADLINE = BigInt(NOW_SEC + 120);
const LIQ = 10n ** 15n;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 500,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

const QUOTA: LpExitQuota = { maxExitSequencesPerDay: 4, minMinutesBetweenExits: 5 };

/**
 * PHASE3.1 Rev2 item 17: the exit swap's DUST FLOOR is the whole-submission
 * relay reserve constant — the production default, so the fixture and the
 * deployment agree about what "dust" means.
 */
const RELAY_FEE_PER_SUBMIT = 100_000_000_000_000n;

function baseMarket(): LpSagaMarket {
  return {
    blockNumber: 100n,
    finalizedBlockNumber: 100n,
    observationCardinality: 500,
    poolLiquidity: 10n ** 18n,
    priceImpactBps: 0n,
    spotSqrtPriceX96: Q96, // price 1: token and WBNB trade 1:1
    twapSqrtPriceX96: Q96,
    currentTick: 0,
  };
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
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

/**
 * Records every batch (and its canonical hash) and answers from a script.
 * An unscripted submit THROWS — which the driver classifies as UNKNOWN, so a
 * test that expects N submits scripts exactly N entries and any extra submit
 * fails loudly as a held sequence plus an assertion on `submitted.length`.
 */
class ScriptedProvider extends FakeWalletProvider {
  readonly submitted: { readonly calls: ExecuteViaSessionParams["calls"]; readonly hash: Hex }[] = [];
  readonly script: ScriptEntry[] = [];
  awaitResult: ExecutionReceipt = { status: "PENDING" };
  balanceReads = 0;
  #submitIndex = 0;

  nextTxHash(): Hex {
    return txAt(this.#submitIndex);
  }

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

  override async awaitExecution(): Promise<ExecutionReceipt> {
    return this.awaitResult;
  }

  /** The decoy: a balance re-read would "see" this absurd number. */
  override async getTokenBalance(_params: GetTokenBalanceParams): Promise<bigint> {
    this.balanceReads += 1;
    return 987_654_321_000_000_000_000n;
  }
}

/** Money amounts by txHash — the ONLY source the runner may use. */
class FakeReceipts implements LpReceiptReader {
  readonly collectByTx = new Map<string, { amount0Wei: bigint; amount1Wei: bigint }>();
  readonly swapByTx = new Map<
    string,
    { tokenIn: Address; amountInWei: bigint; tokenOut: Address; amountOutWei: bigint }
  >();
  readonly mintByTx = new Map<string, bigint>();
  readonly expectedPoolSwapByTx = new Map<
    string,
    { amountInWei: bigint; amountOutWei: bigint } | null
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
  async expectedPoolSwap(
    txHash: Hex,
    _expectedPool: Address,
    _baseIsToken0: boolean,
  ): Promise<{ amountInWei: bigint; amountOutWei: bigint } | null> {
    const entry = this.expectedPoolSwapByTx.get(txHash);
    if (entry === undefined) throw new Error(`no expected-pool swap receipt for ${txHash}`);
    return entry;
  }
  async mintedTokenId(txHash: Hex): Promise<bigint> {
    const entry = this.mintByTx.get(txHash);
    if (entry === undefined) throw new Error(`no mint receipt for ${txHash}`);
    return entry;
  }
}

/** A store whose `completed` write can be made to crash exactly once. */
class CrashOnCompletedStore extends MemoryLpSequenceStore {
  crashOnCompleted = false;
  /**
   * Every recovery-state write, in order (PHASE3.11). The ORDER is the
   * assertion that matters: the marker must be written before the replayed
   * `after`, and never more than once per plan position.
   */
  readonly recoveryWrites: LpRecoveryState[] = [];
  /** Impersonate a resolver fence taking the row mid-resume (PHASE3.11 B9). */
  fenceRecoveryWrites = false;

  override async setRecoveryState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    recoveryState: LpRecoveryState,
  ): ReturnType<MemoryLpSequenceStore["setRecoveryState"]> {
    if (this.fenceRecoveryWrites) {
      throw new LpPositionResolvingError("pos-1");
    }
    this.recoveryWrites.push(recoveryState);
    return super.setRecoveryState(ownerAddress, agentId, sequenceId, recoveryState);
  }

  override async setSequenceState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    state: LpSequenceState,
  ): ReturnType<MemoryLpSequenceStore["setSequenceState"]> {
    if (this.crashOnCompleted && state === "completed") {
      this.crashOnCompleted = false;
      throw new Error("simulated crash before the completed write");
    }
    return super.setSequenceState(ownerAddress, agentId, sequenceId, state);
  }
}

type Harness = {
  readonly agent: AgentRecord;
  readonly agentStore: MemoryAgentStore;
  readonly journal: MemoryExecutionJournal;
  readonly killswitch: MemoryKillSwitch;
  readonly store: CrashOnCompletedStore;
  readonly provider: ScriptedProvider;
  readonly positions: Map<string, LpPositionSnapshot | "burned">;
  readonly receipts: FakeReceipts;
  readonly deps: LpSagaDeps;
  readonly marketState: { failAfterReads: number; reads: number };
  /**
   * The injected clock, MUTABLE. Introduced for PHASE3.1-AUDIT A1's wall-clock
   * retry window; PHASE3.1-FIXREVIEW F2 replaced that window with an ATTEMPT
   * budget, so nothing in A1's own cases moves it any more — but a movable
   * clock is the right shape for a harness and F2's "arrives late" case uses it
   * to prove exactly that lateness no longer costs the retries.
   * Defaults to NOW_MS, so every pre-existing case is unaffected.
   */
  readonly clock: { ms: number };
  currentDigest: Hex;
  quoteResult: bigint;
  readonly quoteCalls: { tokenIn: Address; tokenOut: Address; fee: number; amountInWei: bigint }[];
};

async function createLpHarness(
  options: {
    readonly quota?: LpExitQuota;
    readonly tokenId?: string | null;
    /** PHASE3.1 Rev2 item 5 — default TRUE, exactly as the settings default. */
    readonly exitToQuote?: boolean;
    /** PHASE3.1 Rev2 item 17 — the exit swap's dust floor. */
    readonly relayFeePerSubmitWei?: bigint;
    /** PHASE3.13 F12 — the owner's rotation flag, for the G2 refusal's remedy. */
    readonly autoRotate?: boolean;
    /**
     * PHASE3.13 B9. Flip the pool's leg order so WBNB sorts into token0.
     * Roughly half of BSC's pools are this way round, and it is the ordering
     * nobody tests first — which is exactly why the 3.12 review's F7 demanded a
     * both-orderings property test.
     */
    readonly wbnbIsToken0?: boolean;
  } = {},
): Promise<Harness> {
  const clock = { ms: NOW_MS };
  const now = (): number => clock.ms;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const store = new CrashOnCompletedStore(now);
  const provider = new ScriptedProvider();
  const receipts = new FakeReceipts();
  const positions = new Map<string, LpPositionSnapshot | "burned">();
  positions.set("42", { liquidity: LIQ, tickLower: -1_000, tickUpper: 1_000 });
  // PHASE3.4: `lp_positions_one_live_token_idx` forbids two non-closed rows
  // sharing one NFT, so the fixtures that add a SECOND position to this same
  // store now use their own tokenIds — which is the state the index is for.
  for (const extra of ["1042", "1043", "1044", "1045"]) {
    positions.set(extra, { liquidity: LIQ, tickLower: -1_000, tickUpper: 1_000 });
  }

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
    token0: options.wbnbIsToken0 === true ? WBNB : TOKEN,
    token1: options.wbnbIsToken0 === true ? TOKEN_HI : WBNB,
    fee: 2_500,
    ...(options.tokenId === null ? {} : { tokenId: options.tokenId ?? "42" }),
    basisWei: 10n ** 18n,
  });

  const marketState = { failAfterReads: Number.POSITIVE_INFINITY, reads: 0 };
  const market: LpMarketReader = async () => {
    marketState.reads += 1;
    if (marketState.reads > marketState.failAfterReads) {
      throw new Error("simulated crash: the market reader died mid-run");
    }
    return baseMarket();
  };

  const quoteCalls: Harness["quoteCalls"] = [];

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
    clock,
    currentDigest: ARMED_DIGEST,
    quoteResult: 495_000_000_000_000n,
    quoteCalls,
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
      quote: async (params) => {
        quoteCalls.push(params);
        return harness.quoteResult;
      },
      receipts,
      expectedPool: POOL,
      conversionCompatibleTokens: new Set<Address>(),
      settingsDigest: ARMED_DIGEST,
      currentSettingsDigest: async () => harness.currentDigest,
      // PHASE3.1: both REQUIRED on LpSagaDeps, so a forgotten wiring is a
      // compile error rather than a silently half-done exit.
      exitToQuote: options.exitToQuote ?? true,
      // PHASE3.13 F12: required on `LpSagaDeps`, so the harvest range refusal
      // names ONE remedy rather than stating both branches.
      autoRotate: options.autoRotate ?? false,
      relayFeePerSubmitWei: options.relayFeePerSubmitWei ?? RELAY_FEE_PER_SUBMIT,
      venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
      now,
    },
  };
  return harness;
}

/* ----- happy-path scripts -------------------------------------------------- */

function confirmed(txHash: Hex): ExecutionReceipt {
  return {
    status: "CONFIRMED",
    callsId: `0x${"c1".repeat(32)}` as Hex,
    transactionHash: txHash,
  };
}

const FREED_WBNB = 10n ** 15n;

/**
 * Protect / manual exit, the OUT-OF-RANGE case: one zap-out that empties the
 * position and frees the whole principal on the WBNB (quote) leg.
 *
 * PHASE3.1's plan is TWO positions, always (Rev2 item 10) — but with no
 * non-quote leg to convert, step 1 records an ordinary SKIP and submits
 * nothing, so every pre-3.1 assertion about submission counts stays true.
 * {@link scriptExitToQuote} is the in-range fixture that actually swaps.
 */
function scriptExit(h: Harness): void {
  h.provider.script.push((_params, txHash) => {
    h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
    h.receipts.collectByTx.set(txHash, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
    return confirmed(txHash);
  });
}

/** The non-quote (TOKEN) leg an in-range exit frees — FINDINGS (ag)'s shape. */
const EXIT_FREED_TOKEN = 10n ** 15n;
/**
 * A fresh quote just under the fee-adjusted spot expectation
 * (`1e15 × (1e6 − 2500)/1e6 = 997_500_000_000_000`), i.e. ~35 bps of GENUINE
 * impact — comfortably inside the 500-bps rail and comfortably above the
 * 1e14 dust floor.
 */
const EXIT_QUOTE_OUT = 994_000_000_000_000n;

/**
 * Protect / manual exit, PHASE3.1's own shape: the zap-out frees BOTH legs and
 * step 1 converts the TOKEN leg into native through the router.
 */
function scriptExitToQuote(
  h: Harness,
  freedToken = EXIT_FREED_TOKEN,
  // PHASE3.4: the tests that create a SECOND position in this store can no
  // longer reuse tokenId "42" (one non-closed row per NFT), so the script has
  // to empty the snapshot the saga will actually read.
  tokenId = "42",
): void {
  h.quoteResult = EXIT_QUOTE_OUT;
  h.provider.script.push((_params, txHash) => {
    h.positions.set(tokenId, { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
    h.receipts.collectByTx.set(txHash, {
      amount0Wei: freedToken,
      amount1Wei: FREED_WBNB,
    });
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => confirmed(txHash));
}

/**
 * PHASE3.24 C3: one atomic zap-out+conversion receipt. The collected base leg
 * deliberately exceeds the swap input, so replay must preserve the material
 * per-position residue without ever scheduling the old second-leg sale.
 */
function scriptInlineExit(h: Harness, wbnbIsToken0: boolean): bigint {
  const floors = sagaDecreaseFloors({
    sqrtPriceX96: Q96,
    tickLower: -1_000,
    tickUpper: 1_000,
    liquidity: LIQ,
    maxSagaSlippageBps: RAILS.maxSagaSlippageBps,
  });
  const amountInWei = wbnbIsToken0 ? floors.amount1Min : floors.amount0Min;
  const residueWei = 777n;
  h.quoteResult = amountInWei;
  h.provider.script.push((_params, txHash) => {
    h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
    h.receipts.collectByTx.set(txHash, wbnbIsToken0
      ? { amount0Wei: FREED_WBNB, amount1Wei: amountInWei + residueWei }
      : { amount0Wei: amountInWei + residueWei, amount1Wei: FREED_WBNB });
    h.receipts.expectedPoolSwapByTx.set(txHash, {
      amountInWei,
      amountOutWei: amountInWei,
    });
    return confirmed(txHash);
  });
  return amountInWei;
}

/**
 * A freed leg whose fee-adjusted spot value (`100 448 250 000 000` wei) sits
 * just ABOVE the 1e14 dust floor — so both sides of the `<=` boundary stay
 * comfortably inside the impact rail and the test isolates the dust rule.
 */
const DUST_BOUNDARY_FREED = 100_700_000_000_000n;

/** planLpSweep at price 1, centered [-1000,1000): swap half the WBNB. */
const ROTATE_SWEEP_IN = FREED_WBNB / 2n;
const ROTATE_SWEEP_OUT = 495_000_000_000_000n;

/** Rotate: zap-out frees single-sided WBNB, sweep swaps half, mint re-enters. */
function scriptRotate(
  h: Harness,
  tokenId = "42",
  mintedRange: { readonly tickLower: number; readonly tickUpper: number } = {
    tickLower: -1_000,
    tickUpper: 1_000,
  },
): void {
  h.provider.script.push((_params, txHash) => {
    h.positions.set(tokenId, { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
    // Out-of-range exit: the whole principal came back on the WBNB leg
    // (WBNB is token1 in this pool).
    h.receipts.collectByTx.set(txHash, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => {
    h.receipts.swapByTx.set(txHash, {
      tokenIn: WBNB,
      amountInWei: ROTATE_SWEEP_IN,
      tokenOut: TOKEN,
      amountOutWei: ROTATE_SWEEP_OUT,
    });
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => {
    h.receipts.mintByTx.set(txHash, 43n);
    h.positions.set("43", { liquidity: LIQ, ...mintedRange });
    return confirmed(txHash);
  });
}

const HARVEST_FEE_WBNB = 10n ** 13n;

/** Harvest: unbalanced fees (WBNB only), so the sweep actually runs. */
function scriptHarvest(h: Harness): void {
  h.provider.script.push((_params, txHash) => {
    h.receipts.collectByTx.set(txHash, { amount0Wei: 0n, amount1Wei: HARVEST_FEE_WBNB });
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => {
    h.receipts.swapByTx.set(txHash, {
      tokenIn: WBNB,
      amountInWei: HARVEST_FEE_WBNB / 2n,
      tokenOut: TOKEN,
      amountOutWei: 4_950_000_000_000n,
    });
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => {
    h.positions.set("42", {
      liquidity: LIQ + 10n ** 10n,
      tickLower: -1_000,
      tickUpper: 1_000,
    });
    return confirmed(txHash);
  });
}

function rotateDeps(h: Harness, proposeRange?: (context: unknown) => Promise<unknown>) {
  return {
    ...h.deps,
    tickSpacing: 50,
    maxTickWidth: 10_000,
    // PHASE3.13: the DEFAULT, so every pre-existing rotate case is unaffected.
    rotateMode: "swapped" as const,
    ...(proposeRange === undefined ? {} : { proposeRange }),
  };
}

/** PHASE3.13: the same deps with the owner-signed swapless mode. */
function swaplessRotateDeps(h: Harness) {
  return { ...rotateDeps(h), rotateMode: "swapless" as const };
}

/**
 * The F2 runner cases must cross the real staged adapter.  A hand-thrown
 * Error cannot impersonate its module-private pre-bind proof, so this helper
 * drives the adapter all the way to the selected boundary and then hands its
 * actual error to the open/saga caller.
 */
type StagedFailure = "validation" | "prepare" | "prepare-timeout" | "prepared" |
  "binder-throws" | "malformed-bind" | "abort" | "sign" | "send";

function stagedFailureDeps(h: Harness, failure: StagedFailure): {
  readonly deps: LpSagaDeps;
  readonly order: readonly string[];
} {
  const order: string[] = [];
  const sessionAccount = privateKeyToAccount(SESSION_KEY);
  const spec = {
    allowedCalls: [{ to: NFPM, selector: "balanceOf(address)" }],
    spendCaps: [{ limit: 10n ** 18n, period: "day" as const }],
    expiresAt: Math.floor(h.clock.ms / 1_000) + 3_600,
  };
  const permissions = validateSessionSpec(spec, { minSessionSeconds: 0 });
  const agent = { ...h.agent, sessionFacts: { spec,
    permissions: failure === "validation" ? { calls: [], spend: [] } : permissions,
    publicKey: sessionAccount.publicKey, expiry: spec.expiresAt } };
  const adapter = new PortoStagedLpAdapter({ network: BNB,
    transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
    functions: {
      prepare: (async (...[_client, request]: Parameters<typeof prepareCalls>) => {
        order.push("prepare");
        if (failure === "prepare") throw new Error("injected prepare failure");
        if (failure === "prepare-timeout") return await new Promise<never>(() => undefined);
        const prepared = {
          capabilities: { quote: { quotes: [{ chainId: 56,
            orchestrator: PORTO_V055_ORCHESTRATOR,
            intent: { eoa: request.account, executionData: encodeLpFinalCallsV1(
              (request.calls ?? []) as readonly WalletCall[],
            ), nonce: 1n, expiry: BigInt(spec.expiresAt) } }] } },
          context: {}, digest: `0x${"21".repeat(32)}` as Hex, key: request.key, typedData: {},
        };
        return (failure === "prepared"
          ? { ...prepared, capabilities: { quote: { quotes: [] } } }
          : prepared) as unknown as Awaited<ReturnType<typeof prepareCalls>>;
      }) as typeof prepareCalls,
      sign: (async () => {
        order.push("sign");
        if (failure === "sign") throw new Error("injected sign failure");
        return `0x${"22".repeat(65)}` as Hex;
      }) as typeof signCalls,
      send: (async () => {
        order.push("send");
        if (failure === "send") throw new Error("injected send failure");
        return { id: `0x${"23".repeat(32)}` as Hex };
      }) as typeof sendPreparedCalls,
    }, submitTimeoutMs: failure === "prepare-timeout" ? 2 : 1_000 });
  const provider = h.provider as ScriptedProvider & {
    submitPreparedLp: PortoStagedLpAdapter["submit"];
  };
  provider.submitPreparedLp = async (input) => {
    const abort = failure === "abort" ? new AbortController() : undefined;
    return adapter.submit({ ...input, ...(abort === undefined ? {} : { signal: abort.signal }),
      bind: async (request) => {
      order.push("bind");
      const bound = await input.bind(request);
      if (failure === "abort") abort?.abort();
      if (failure === "binder-throws") throw new Error("binder committed then lost response");
      if (failure === "malformed-bind") {
        return { ...bound, boundBindingVersion: bound.boundBindingVersion + 1 };
      }
      return bound;
      },
    });
  };
  return { deps: { ...h.deps, agent, provider }, order };
}

function assertNoDuplicateSubmits(h: Harness): void {
  const hashes = h.provider.submitted.map((entry) => entry.hash);
  assert.equal(new Set(hashes).size, hashes.length, "a batch was submitted twice");
}

async function recordedKeys(h: Harness): Promise<readonly string[]> {
  const sequences = await h.store.listSequences(OWNER, AGENT_ID);
  return sequences.flatMap((sequence) =>
    sequence.steps.map((step) => step.journalIdempotencyKey),
  );
}

/* -------------------------------------------------------------------------- */
/* Happy paths                                                                */
/* -------------------------------------------------------------------------- */

describe("lp sagas: happy paths", () => {
  it("protect completes [zap-out, sweep-token] and closes the position (basis reset)", async () => {
    const h = await createLpHarness();
    scriptExit(h);
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    // PHASE3.1 Rev2 item 22: the plan is two positions and a SKIPPED step is a
    // completed one, so this counts 2 where Phase 3 counted 1.
    assert.equal(result.confirmedSteps, 2);
    assert.equal(h.provider.submitted.length, 1, "nothing to convert ⇒ nothing to submit");
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");
    assert.equal(position?.basisWei, 0n);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed");
    const liveRow = await h.journal.get(sequences[0]?.steps[0]?.journalIdempotencyKey ?? "");
    assert.equal(liveRow?.begunAtBlock, 100n, "the existing finalized market block is persisted");
    assert.deepEqual(
      sequences[0]?.steps.map((step) => step.kind),
      ["zap-out", "sweep-token"],
    );
    assert.match(
      sequences[0]?.note ?? "",
      /freed no non-quote leg/,
      "Rev2 item 15: the skip's reason is recorded ON THE SEQUENCE",
    );
  });

  it("rotate completes [zap-out, sweep, mint], records the new tokenId on the SAME lineage with the basis untouched (R7)", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    const before = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 3);
    assert.equal(h.provider.submitted.length, 3);
    assertNoDuplicateSubmits(h);
    const after = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(after?.tokenId, "43");
    assert.equal(after?.lineageId, before?.lineageId);
    assert.equal(after?.basisWei, before?.basisWei);
    assert.equal(after?.state, "open");
  });

  it("harvest completes [collect, sweep, increase] on the SAME tokenId", async () => {
    const h = await createLpHarness();
    scriptHarvest(h);
    const result = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 3);
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.tokenId, "42");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.deepEqual(
      sequences[0]?.steps.map((step) => step.kind),
      ["collect-fees", "sweep-token", "zap-in-increase"],
    );
  });

  it("a balanced harvest records the sweep as SKIPPED, not omitted — indexes stay stable", async () => {
    const h = await createLpHarness();
    // Balanced fee legs at price 1 in a symmetric range: nothing to sweep.
    h.provider.script.push((_params, txHash) => {
      h.receipts.collectByTx.set(txHash, {
        amount0Wei: HARVEST_FEE_WBNB,
        amount1Wei: HARVEST_FEE_WBNB,
      });
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", {
        liquidity: LIQ + 10n ** 10n,
        tickLower: -1_000,
        tickUpper: 1_000,
      });
      return confirmed(txHash);
    });
    const result = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 3, "the skipped sweep still counts a plan position");
    assert.equal(h.provider.submitted.length, 2, "a skipped step submits nothing");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    const steps = sequences[0]?.steps ?? [];
    assert.deepEqual(
      steps.map((step) => step.kind),
      ["collect-fees", "sweep-token", "zap-in-increase"],
    );
    // The skip's journal row is COMMITTED with no submit artifacts.
    const skipRow = await h.journal.get(steps[1]?.journalIdempotencyKey ?? "");
    assert.equal(skipRow?.state, "COMMITTED");
    assert.equal(skipRow?.externalRef.callsId, undefined);
    assert.equal(skipRow?.externalRef.txHash, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Floors (Rev2 item 23): server-derived, byte-exact in the submitted calls   */
/* -------------------------------------------------------------------------- */

describe("lp sagas: floors and money amounts", () => {
  it("every submitted rotate call carries non-zero server-derived floors and the 120s deadline", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    await runLpRotate(rotateDeps(h), POSITION_ID);

    // Step 0 — the decrease floors come from the rail-checked price.
    const decreaseFloors = sagaDecreaseFloors({
      sqrtPriceX96: Q96,
      tickLower: -1_000,
      tickUpper: 1_000,
      liquidity: LIQ,
      maxSagaSlippageBps: RAILS.maxSagaSlippageBps,
    });
    assert.ok(decreaseFloors.amount0Min > 0n && decreaseFloors.amount1Min > 0n);
    const decreaseData =
      "0x0c49ccbe" +
      word(42n) +
      word(LIQ) +
      word(decreaseFloors.amount0Min) +
      word(decreaseFloors.amount1Min) +
      word(DEADLINE);
    assert.equal(h.provider.submitted[0]?.calls[0]?.data, decreaseData);

    // Step 1 — the sweep floor comes from the FRESH injected quote.
    const expectedMinOut = sagaSwapMinOut(h.quoteResult, RAILS.maxSagaSlippageBps);
    assert.ok(expectedMinOut > 0n);
    assert.equal(h.quoteCalls.length, 1);
    assert.deepEqual(h.quoteCalls[0], {
      tokenIn: WBNB,
      tokenOut: TOKEN,
      fee: 2_500,
      amountInWei: ROTATE_SWEEP_IN,
    });
    const sweepCalls = h.provider.submitted[1]?.calls ?? [];
    // Exact approve for exactly the sweep's amountIn (Rev2 item 15).
    assert.ok(sweepCalls[1]?.data?.endsWith(word(ROTATE_SWEEP_IN)));
    assert.ok(
      sweepCalls[2]?.data?.includes(word(expectedMinOut)),
      "the swap must carry the quote-derived floor",
    );
    assert.ok(sweepCalls[2]?.data?.includes(word(DEADLINE)));

    // Step 2 — mint floors from getLiquidityForAmounts + sagaMintFloors over
    // the CONFIRMED post-sweep amounts.
    const amount0 = ROTATE_SWEEP_OUT; // TOKEN leg (token0)
    const amount1 = FREED_WBNB - ROTATE_SWEEP_IN; // WBNB leg (token1)
    const liquidity = getLiquidityForAmounts(Q96, -1_000, 1_000, amount0, amount1);
    const mintFloors = sagaMintFloors({
      sqrtPriceX96: Q96,
      tickLower: -1_000,
      tickUpper: 1_000,
      liquidity,
      maxSagaSlippageBps: RAILS.maxSagaSlippageBps,
      // LP-ROTATE-MINT-FLOORS: the saga passes the confirmed amounts so the
      // floors are the price-shifted figures; the mirror must too.
      amount0Desired: amount0,
      amount1Desired: amount1,
    });
    assert.ok(mintFloors.amount0Min > 0n && mintFloors.amount1Min > 0n);
    const mintCall = h.provider.submitted[2]?.calls[2];
    assert.ok(mintCall?.data?.startsWith("0x88316456"));
    assert.ok(mintCall?.data?.includes(word(amount0)), "desired0 = confirmed amount");
    assert.ok(mintCall?.data?.includes(word(amount1)), "desired1 = confirmed amount");
    assert.ok(mintCall?.data?.includes(word(mintFloors.amount0Min)));
    assert.ok(mintCall?.data?.includes(word(mintFloors.amount1Min)));
    assert.equal(mintCall?.value, undefined, "a rotate mint never attaches native");
  });

  it("the sweep's amountIn is the CONFIRMED collect delta — never a balance re-read", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    await runLpRotate(rotateDeps(h), POSITION_ID);

    // The decoy balance the provider would report is absurd; prove nothing
    // ever asked for it, and the swept amount derives from the receipt.
    assert.equal(h.provider.balanceReads, 0, "a balance was re-read");
    const expected = planLpSweep({
      wbnbFreedWei: FREED_WBNB,
      tokenFreedWei: 0n,
      wbnbIsToken0: false,
      currentTick: 0,
      tickLower: -1_000,
      tickUpper: 1_000,
      spotSqrtPriceX96: Q96,
    });
    assert.deepEqual(expected, {
      direction: "wbnb-to-token",
      amountInWei: ROTATE_SWEEP_IN,
    });
    const sweepCalls = h.provider.submitted[1]?.calls ?? [];
    assert.ok(sweepCalls[1]?.data?.endsWith(word(ROTATE_SWEEP_IN)));
  });
});

/* -------------------------------------------------------------------------- */
/* Crash matrix                                                               */
/* -------------------------------------------------------------------------- */

describe("lp sagas: crash matrix", () => {
  type SagaCase = {
    readonly name: "protect" | "rotate" | "harvest";
    readonly firstKind: "zap-out" | "collect-fees";
    run(h: Harness): Promise<unknown>;
  };
  const CASES: readonly SagaCase[] = [
    { name: "protect", firstKind: "zap-out", run: (h) => runLpProtect(h.deps, POSITION_ID) },
    { name: "rotate", firstKind: "zap-out", run: (h) => runLpRotate(rotateDeps(h), POSITION_ID) },
    { name: "harvest", firstKind: "collect-fees", run: (h) => runLpHarvest(h.deps, POSITION_ID) },
  ];

  for (const sagaCase of CASES) {
    it(`${sagaCase.name}: kill BEFORE submit ⇒ resume holds; the recorded key is never submitted`, async () => {
      const h = await createLpHarness();
      // Hand-craft what a crash between journal-begin and the submit leaves:
      // a recorded step whose journal row is PENDING with no callsId.
      const sequence = await h.store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: POSITION_ID,
        kind: sagaCase.name,
      });
      if (sagaCase.name === "protect") {
        await h.store.setPositionState(OWNER, AGENT_ID, POSITION_ID, "closing");
      }
      const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
      const key = executeIdempotencyKey(
        AGENT_ID,
        decisionId,
        hashCalls([{ to: NFPM }]),
      );
      await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
        kind: sagaCase.firstKind,
        journalIdempotencyKey: key,
      });
      await h.journal.beginWithSpend(
        {
          idempotencyKey: key,
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          kind: "lp",
          decisionId,
          nativeSpendWei: 0n,
        },
        0,
      );

      const first = (await sagaCase.run(h)) as { status: string; code: string };
      assert.equal(first.status, "held");
      assert.equal(first.code, "HELD_AMBIGUOUS");
      assert.equal(h.provider.submitted.length, 0);

      // Reconcile: no callsId ⇒ the row parks as UNKNOWN, and the sequence
      // still holds — ambiguity never auto-replays.
      await reconcile({
    minRowAgeMs: 0,
        provider: h.provider,
        journal: h.journal,
        resolveWallet: async () => null,
      });
      assert.equal((await h.journal.get(key))?.state, "UNKNOWN");
      const second = (await sagaCase.run(h)) as { status: string };
      assert.equal(second.status, "held");
      assert.equal(h.provider.submitted.length, 0, "the key must never be submitted");
    });

    it(`${sagaCase.name}: kill INSIDE the submit ⇒ UNKNOWN holds; never resubmitted`, async () => {
      const h = await createLpHarness();
      h.provider.script.push(() => {
        throw new Error("transport died mid-submit");
      });
      const first = (await sagaCase.run(h)) as { status: string; code: string };
      assert.equal(first.status, "held");
      assert.equal(first.code, "HELD_AMBIGUOUS");
      assert.equal(h.provider.submitted.length, 1);

      const keys = await recordedKeys(h);
      assert.equal(keys.length, 1);
      assert.equal((await h.journal.get(keys[0] ?? ""))?.state, "UNKNOWN");

      const second = (await sagaCase.run(h)) as { status: string };
      assert.equal(second.status, "held");
      assert.equal(
        h.provider.submitted.length,
        1,
        "an UNKNOWN step must never be resubmitted",
      );
      assertNoDuplicateSubmits(h);
    });
  }

  it("rotate: crash after the zap-out confirms ⇒ resume skips it, finishes, no key submitted twice", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    // The second market read (step 1's gate) dies — a crash between steps.
    h.marketState.failAfterReads = 1;
    await assert.rejects(
      () => runLpRotate(rotateDeps(h), POSITION_ID),
      /market reader died/,
    );
    assert.equal(h.provider.submitted.length, 1);
    const midway = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(midway[0]?.recoveryState, "pending-mint");

    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 3, "resume must skip the confirmed zap-out");
    assertNoDuplicateSubmits(h);
    const keys = await recordedKeys(h);
    assert.equal(new Set(keys).size, keys.length, "step keys must be unique");
    const after = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(after?.tokenId, "43");
  });

  it("rotate: crash after the sweep confirms ⇒ resume runs only the mint", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.marketState.failAfterReads = 2; // step 2's gate read dies
    await assert.rejects(
      () => runLpRotate(rotateDeps(h), POSITION_ID),
      /market reader died/,
    );
    assert.equal(h.provider.submitted.length, 2);
    const midway = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(midway[0]?.recoveryState, "wbnb-stranded");

    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 3);
    assert.equal(h.provider.submitted.length, 3);
    assertNoDuplicateSubmits(h);
  });

  it("harvest: crash after the collect confirms ⇒ resume finishes from pending-increase", async () => {
    const h = await createLpHarness();
    scriptHarvest(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpHarvest(h.deps, POSITION_ID), /market reader died/);
    assert.equal(h.provider.submitted.length, 1);
    const midway = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(midway[0]?.recoveryState, "pending-increase");

    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const result = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 3);
    assertNoDuplicateSubmits(h);
  });

  it("protect: crash after the last confirm (before `completed`) ⇒ resume replays nothing and completes", async () => {
    const h = await createLpHarness();
    scriptExit(h);
    h.store.crashOnCompleted = true;
    await assert.rejects(
      () => runLpProtect(h.deps, POSITION_ID),
      /simulated crash before the completed write/,
    );
    assert.equal(h.provider.submitted.length, 1);

    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 1, "the confirmed exit must not resubmit");
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");
  });

  it("a PENDING submit holds IN_PROGRESS until reconcile resolves it, then the sequence advances", async () => {
    const h = await createLpHarness();
    const pendingTx = txAt(0);
    h.provider.script.push(() => ({
      status: "PENDING",
      callsId: `0x${"c2".repeat(32)}` as Hex,
    }));
    const first = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(first.status, "held");
    assert.equal(h.provider.submitted.length, 1);
    const keys = await recordedKeys(h);
    assert.equal((await h.journal.get(keys[0] ?? ""))?.state, "IN_PROGRESS");

    // The chain says it landed: reconcile resolves the STEP ROW, and only
    // then may the sequence advance (Rev2 item 9).
    h.provider.awaitResult = { status: "CONFIRMED", transactionHash: pendingTx };
    h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
    h.receipts.collectByTx.set(pendingTx, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
    const summary = await reconcile({
    minRowAgeMs: 0,
      provider: h.provider,
      journal: h.journal,
      resolveWallet: async () => null,
    });
    assert.equal(summary.committed, 1);

    h.provider.script.push((_params, txHash) => {
      h.receipts.swapByTx.set(txHash, {
        tokenIn: WBNB,
        amountInWei: ROTATE_SWEEP_IN,
        tokenOut: TOKEN,
        amountOutWei: ROTATE_SWEEP_OUT,
      });
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => {
      h.receipts.mintByTx.set(txHash, 43n);
      h.positions.set("43", { liquidity: LIQ, tickLower: -1_000, tickUpper: 1_000 });
      return confirmed(txHash);
    });
    const second = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(second.status, "completed");
    assert.equal(h.provider.submitted.length, 3);
    assertNoDuplicateSubmits(h);
  });

  /* ----- the appendStep→begin window (audit A1) --------------------------- */
  // A recorded step whose journal row was NEVER CREATED is provably never
  // submitted (`appendStep` → `begin` → submit is a strict order), so the
  // resume must treat its slot as OPEN and retry with a FRESH step record —
  // never hold. The pre-fix behaviour held forever: the key is derived from
  // freshly-built calldata and never re-derived, `reconcile` iterates journal
  // ROWS so it can never resolve one that does not exist, and the stuck
  // non-terminal sequence blocked BOTH protect and the owner's manual exit.

  // SUBMISSIONS, not plan positions: the protect fixture's step 1 skips.
  const A1_SUBMITS: Record<"protect" | "rotate" | "harvest", number> = {
    protect: 1,
    rotate: 3,
    harvest: 3,
  };
  const A1_SCRIPTS: Record<"protect" | "rotate" | "harvest", (h: Harness) => void> = {
    protect: scriptExit,
    rotate: scriptRotate,
    harvest: scriptHarvest,
  };
  /**
   * RECORDED steps after the retry: the orphan slot plus every plan position.
   * The protect's plan is two from PHASE3.1 on and its second position is a
   * recorded SKIP, which is why this is not simply `submits + 1`.
   */
  const A1_RECORDED_STEPS: Record<"protect" | "rotate" | "harvest", number> = {
    protect: 3,
    rotate: 4,
    harvest: 4,
  };

  for (const sagaCase of CASES) {
    it(`${sagaCase.name}: kill BETWEEN appendStep and begin ⇒ resume RETRIES with a FRESH step record (audit A1)`, async () => {
      const h = await createLpHarness();
      // Hand-craft exactly what a crash in the appendStep→begin window
      // leaves: a recorded step whose idempotency key has NO journal row.
      const sequence = await h.store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: POSITION_ID,
        kind: sagaCase.name,
      });
      if (sagaCase.name === "protect") {
        await h.store.setPositionState(OWNER, AGENT_ID, POSITION_ID, "closing");
      }
      const orphanKey = executeIdempotencyKey(
        AGENT_ID,
        lpStepDecisionId(sequence.sequenceId, 0),
        hashCalls([{ to: NFPM }]),
      );
      await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
        kind: sagaCase.firstKind,
        journalIdempotencyKey: orphanKey,
      });
      // NO journal.begin — that is the crash.

      A1_SCRIPTS[sagaCase.name](h);
      const result = (await sagaCase.run(h)) as {
        status: string;
        confirmedSteps: number;
      };
      assert.equal(result.status, "completed", "the orphaned slot must be retried, not held");
      assert.equal(h.provider.submitted.length, A1_SUBMITS[sagaCase.name]);
      assertNoDuplicateSubmits(h);

      // The orphan key was never begun and never submitted; the retry ran
      // under FRESH keys (a new step record with a new index ⇒ new decision
      // id ⇒ new key), so the idempotency guarantee holds by construction.
      assert.equal(
        await h.journal.get(orphanKey),
        null,
        "a row must never be created for the provably-unsubmitted orphan key",
      );
      const keys = await recordedKeys(h);
      assert.equal(new Set(keys).size, keys.length, "step keys must be unique");
      assert.ok(keys.includes(orphanKey), "the orphan record stays (order authority)");
      const sequences = await h.store.listSequences(OWNER, AGENT_ID);
      assert.equal(sequences[0]?.state, "completed");
      assert.equal(
        sequences[0]?.steps.length,
        A1_RECORDED_STEPS[sagaCase.name],
        "the retry is a NEW recorded step; the orphan slot is not reused",
      );
    });
  }

  it("a rotate orphaned in the appendStep→begin window never traps the position: the resume rolls it back and the owner's manual exit completes — under pause (audit A1)", async () => {
    // The audit's blast radius, replayed: pre-fix, the orphaned rotate held
    // forever, occupied the one-non-terminal-sequence slot, and the manual
    // exit answered SEQUENCE_CONFLICT — on a live-funded position, with the
    // agent paused, which is exactly when the exit matters (FINDINGS (s)).
    const h = await createLpHarness();
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "rotate",
    });
    const orphanKey = executeIdempotencyKey(
      AGENT_ID,
      lpStepDecisionId(sequence.sequenceId, 0),
      hashCalls([{ to: NFPM }]),
    );
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "zap-out",
      journalIdempotencyKey: orphanKey,
    });
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);

    // The worker's resume of the orphaned rotate: no money has provably
    // moved, so the quota-bound sequence runs STRICT under pause and rolls
    // back cleanly — freeing the position instead of holding it hostage.
    const resumed = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(resumed.status, "rolled-back");
    assert.equal(resumed.code, "AGENT_PAUSED");
    assert.equal(h.provider.submitted.length, 0);

    scriptExit(h);
    const exit = await runLpManualExit(h.deps, POSITION_ID);
    assert.equal(exit.status, "completed", "the manual exit must not be blocked");
    assert.equal(await h.journal.get(orphanKey), null);
  });

  it("rotate: orphan at the SWEEP slot mid-sequence ⇒ resume replays the confirmed zap-out and retries the sweep fresh (audit A1)", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.marketState.failAfterReads = 1; // zap-out confirms, then the crash
    await assert.rejects(
      () => runLpRotate(rotateDeps(h), POSITION_ID),
      /market reader died/,
    );
    assert.equal(h.provider.submitted.length, 1);
    const midway = await h.store.listSequences(OWNER, AGENT_ID);
    const sequenceId = midway[0]?.sequenceId ?? "";

    // NOW the appendStep→begin crash, at the sweep slot: record the step,
    // create no journal row.
    const orphanKey = executeIdempotencyKey(
      AGENT_ID,
      lpStepDecisionId(sequenceId, 1),
      hashCalls([{ to: ROUTER_V3 }]),
    );
    await h.store.appendStep(OWNER, AGENT_ID, sequenceId, {
      kind: "sweep-token",
      journalIdempotencyKey: orphanKey,
    });

    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 3);
    assert.equal(h.provider.submitted.length, 3, "zap-out replayed from the journal, not resubmitted");
    assertNoDuplicateSubmits(h);
    assert.equal(await h.journal.get(orphanKey), null);
    const after = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(after[0]?.steps.length, 4, "confirmed zap-out + orphan + fresh sweep + mint");
    const keys = await recordedKeys(h);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("a recorded step whose row EXISTS but is UNKNOWN still holds — the A1 reclassification touches only the missing-row case", async () => {
    // The counter-case the fix must not weaken: a row that reached `begin`
    // has a genuinely ambiguous submit window and must hold for reconcile.
    // (The per-saga "kill BEFORE submit" cases above pin PENDING; this pins
    // the post-reconcile UNKNOWN state explicitly against the new filter.)
    const h = await createLpHarness();
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "rotate",
    });
    const key = executeIdempotencyKey(
      AGENT_ID,
      lpStepDecisionId(sequence.sequenceId, 0),
      hashCalls([{ to: NFPM }]),
    );
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "zap-out",
      journalIdempotencyKey: key,
    });
    await h.journal.beginWithSpend(
      {
        idempotencyKey: key,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        kind: "lp",
        decisionId: lpStepDecisionId(sequence.sequenceId, 0),
        nativeSpendWei: 0n,
      },
      0,
    );
    await h.journal.markUnknown(key, "submit window ambiguous");

    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(result.code, "HELD_AMBIGUOUS");
    assert.equal(h.provider.submitted.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.1: the exit converts the non-quote leg (Rev2 items 10–17)           */
/* -------------------------------------------------------------------------- */

const SELECTOR = {
  approve: "095ea7b3",
  exactInputSingle: "414bf389",
  unwrapWETH9: "49404b7c",
} as const;

function addressWord(value: Address): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

/** Every non-terminal sequence and open position the WORKER would pick up. */
async function workerQueue(
  h: Harness,
): Promise<{ sequences: number; positions: number }> {
  const sequences = await h.store.listNonTerminalSequencesForWorker();
  const positions = await h.store.listOpenPositionsForWorker();
  return { sequences: sequences.length, positions: positions.length };
}

describe("lp exit: converting the freed leg into the quote asset", () => {
  it("protect runs TWO submissions and the second is the router exit swap, priced off the CONFIRMED collect delta", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    const result = await runLpProtect(h.deps, POSITION_ID);

    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 2);
    assert.equal(h.provider.submitted.length, 2);
    assertNoDuplicateSubmits(h);

    // Rev2 item 14: `amountIn` is the exact confirmed collect delta and NEVER a
    // balance re-read — proven by the decoy, which reports an absurd balance to
    // anyone who asks.
    assert.equal(h.provider.balanceReads, 0, "a balance was re-read");
    assert.deepEqual(h.quoteCalls, [
      { tokenIn: TOKEN, tokenOut: WBNB, fee: 2_500, amountInWei: EXIT_FREED_TOKEN },
    ]);

    const calls = h.provider.submitted[1]?.calls ?? [];
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.to),
      [TOKEN, TOKEN, ROUTER_V3],
      "approve pair on the TOKEN leg, then one router call",
    );
    // The EXACT approve is for the collect delta, not the decoy balance.
    assert.equal(
      calls[1]?.data,
      `0x${SELECTOR.approve}${addressWord(ROUTER_V3)}${word(EXIT_FREED_TOKEN)}`,
    );
    const batch = calls[2]?.data ?? "";
    assert.ok(batch.includes(SELECTOR.exactInputSingle));
    assert.ok(batch.includes(SELECTOR.unwrapWETH9), "the exit delivers NATIVE");
    assert.ok(
      batch.includes(addressWord(ROUTER_V3)),
      "the swap's recipient is the router, so the unwrap has WBNB to convert",
    );
    const expectedMinOut = sagaSwapMinOut(EXIT_QUOTE_OUT, RAILS.maxSagaSlippageBps);
    assert.ok(expectedMinOut > 0n);
    assert.ok(batch.includes(word(expectedMinOut)), "the server-derived floor");
    assert.ok(batch.includes(word(DEADLINE)));
    for (const call of calls) {
      assert.equal(call.value, undefined, "the exit swap attaches NO native");
    }

    // A completed exit that actually converted owes the owner no explanation.
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.note, null);
    assert.deepEqual(
      sequences[0]?.steps.map((step) => step.kind),
      ["zap-out", "sweep-token"],
    );
    assert.deepEqual(await workerQueue(h), { sequences: 0, positions: 0 });
  });

  it("the owner's manual exit converts too — the same plan, a different kind", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    const result = await runLpManualExit(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
  });

  for (const wbnbIsToken0 of [false, true]) {
    it(`PHASE3.24 C3: committed inline conversion never sells the collected base leg again (${wbnbIsToken0 ? "WBNB token0" : "WBNB token1"})`, async () => {
      const h = await createLpHarness({ wbnbIsToken0, relayFeePerSubmitWei: 1n });
      const baseToken = wbnbIsToken0 ? TOKEN_HI : TOKEN;
      Object.assign(h.deps, {
        expectedPool: POOL,
        conversionCompatibleTokens: new Set<Address>([baseToken]),
      });
      const amountInWei = scriptInlineExit(h, wbnbIsToken0);

      // The third argument is the owner-signed, write-once inline consent. On
      // the pre-3.24 implementation it is ignored, so collect-based sizing
      // schedules the forbidden second sale and this test goes red.
      const result = await runLpManualExit(h.deps, POSITION_ID, true);

      assert.equal(result.status, "completed");
      assert.equal(h.provider.submitted.length, 1, "a committed inline sale must end step 1");
      assert.equal(h.provider.submitted[0]?.calls.length, 7, "four zap-out plus three swap calls");
      assert.equal(h.provider.balanceReads, 0, "inline sizing must never read the wallet");
      assert.deepEqual(h.quoteCalls, [
        { tokenIn: baseToken, tokenOut: WBNB, fee: 2_500, amountInWei },
      ]);
      assert.equal(
        h.provider.submitted[0]?.calls[5]?.data,
        `0x${SELECTOR.approve}${addressWord(ROUTER_V3)}${word(amountInWei)}`,
        "amountIn is exactly the base-leg tokenMin, never collected principal plus fees",
      );
      const [sequence] = await h.store.listSequences(OWNER, AGENT_ID);
      assert.equal(
        (sequence as unknown as Record<string, unknown>)["inlineResidueBaseWei"],
        777n,
      );
    });
  }

  it("PHASE3.24 C3: replay of a committed inline exit cannot double-sell after the between-step crash", async () => {
    const h = await createLpHarness({ relayFeePerSubmitWei: 1n });
    Object.assign(h.deps, {
      expectedPool: POOL,
      conversionCompatibleTokens: new Set<Address>([TOKEN]),
    });
    scriptInlineExit(h, false);
    h.marketState.failAfterReads = 1;
    await assert.rejects(
      () => runLpManualExit(h.deps, POSITION_ID, true),
      /market reader died/,
    );
    assert.equal(h.provider.submitted.length, 1, "the atomic batch committed before the crash");

    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const resumed = await runLpManualExit(h.deps, POSITION_ID, true);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 1, "replay must witness inline commitment and skip sale 2");
    assertNoDuplicateSubmits(h);
  });

  it("AUDIT A1: persisted inline consent still witnesses the committed Swap after ambient compatibility removal", async () => {
    const h = await createLpHarness({ relayFeePerSubmitWei: 1n });
    Object.assign(h.deps, {
      expectedPool: POOL,
      conversionCompatibleTokens: new Set<Address>([TOKEN]),
    });
    scriptInlineExit(h, false);
    h.marketState.failAfterReads = 1;
    await assert.rejects(
      () => runLpManualExit(h.deps, POSITION_ID, true),
      /market reader died/,
    );
    assert.equal(h.provider.submitted.length, 1, "the seven-call batch committed before resume");

    // The operator may remove a token, or the worker may have booted from a
    // different environment. That ambient PRE-SUBMIT decision cannot rewrite
    // the already-persisted consent or suppress the committed receipt witness.
    Object.assign(h.deps, { conversionCompatibleTokens: new Set<Address>() });
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const resumed = await runLpManualExit(h.deps, POSITION_ID, true);

    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 1, "resume must not dispatch sale 2");
    assertNoDuplicateSubmits(h);
  });

  it("PHASE3.24 C3: zero Swap logs preserve the exact collect-based second-step amount", async () => {
    const h = await createLpHarness({ relayFeePerSubmitWei: 1n });
    const floors = sagaDecreaseFloors({
      sqrtPriceX96: Q96,
      tickLower: -1_000,
      tickUpper: 1_000,
      liquidity: LIQ,
      maxSagaSlippageBps: RAILS.maxSagaSlippageBps,
    });
    Object.assign(h.deps, {
      expectedPool: POOL,
      conversionCompatibleTokens: new Set<Address>([TOKEN]),
      quote: async (params: Harness["quoteCalls"][number]): Promise<bigint> => {
        h.quoteCalls.push(params);
        return amountInAfterPoolFee(params.amountInWei, params.fee);
      },
    });
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, {
        amount0Wei: EXIT_FREED_TOKEN,
        amount1Wei: FREED_WBNB,
      });
      h.receipts.expectedPoolSwapByTx.set(txHash, null);
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => confirmed(txHash));

    const result = await runLpManualExit(h.deps, POSITION_ID, true);
    assert.equal(result.status, "completed");
    assert.deepEqual(h.quoteCalls.map((call) => call.amountInWei), [
      floors.amount0Min,
      EXIT_FREED_TOKEN,
    ]);
    assert.equal(h.provider.submitted.length, 2);
  });

  it("PHASE3.24 C3: an unavailable/non-table Swap witness holds committed money", async () => {
    const h = await createLpHarness({ relayFeePerSubmitWei: 1n });
    Object.assign(h.deps, {
      expectedPool: POOL,
      conversionCompatibleTokens: new Set<Address>([TOKEN]),
    });
    const floors = sagaDecreaseFloors({
      sqrtPriceX96: Q96,
      tickLower: -1_000,
      tickUpper: 1_000,
      liquidity: LIQ,
      maxSagaSlippageBps: RAILS.maxSagaSlippageBps,
    });
    h.quoteResult = floors.amount0Min;
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, {
        amount0Wei: EXIT_FREED_TOKEN,
        amount1Wei: FREED_WBNB,
      });
      // Deliberately no expectedPoolSwapByTx entry: the dedicated reader throws.
      return confirmed(txHash);
    });
    const result = await runLpManualExit(h.deps, POSITION_ID, true);
    assert.equal(result.status, "held");
    assert.equal(result.code, "POST_VERIFY_FAILED");
    assert.equal(h.provider.submitted.length, 1);
  });

  it("PHASE3.24 C2: a resume whose inline consent disagrees with the row refuses", async () => {
    const h = await createLpHarness();
    await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "manual-exit",
      inlineConvert: true,
    });
    const result = await runLpManualExit(h.deps, POSITION_ID, false);
    assert.equal(result.status, "held");
    assert.equal(result.code, "PLAN_MISMATCH");
    assert.equal(h.provider.submitted.length, 0);
  });

  it("the position is CLOSED and its basis ZEROED the moment step 0 confirms — before step 1 builds (Rev2 item 13)", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    // Crash on step 1's between-step market read: step 0 has confirmed, step 1
    // has not run.
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    assert.equal(h.provider.submitted.length, 1);

    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed", "no `closing` ghost, ever");
    assert.equal(position?.basisWei, 0n);
    // The lineage is out of the worker's trigger queue immediately; only the
    // unfinished sequence remains, and it is resumable.
    assert.deepEqual(await workerQueue(h), { sequences: 1, positions: 0 });

    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    const resumed = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the confirmed zap-out is replayed, not resubmitted");
    assertNoDuplicateSubmits(h);
  });

  it("exitToQuote: false reproduces Phase 3's call list BYTE-FOR-BYTE and records why", async () => {
    const converting = await createLpHarness();
    scriptExitToQuote(converting);
    await runLpProtect(converting.deps, POSITION_ID);

    const off = await createLpHarness({ exitToQuote: false });
    scriptExitToQuote(off);
    const result = await runLpProtect(off.deps, POSITION_ID);

    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 2, "the plan length never varies (Rev2 item 10)");
    assert.equal(off.provider.submitted.length, 1, "the flag is a real off switch");
    assert.equal(off.quoteCalls.length, 0, "not even a quote is read");
    // The zap-out itself is untouched by the flag.
    assert.deepEqual(
      off.provider.submitted[0]?.calls,
      converting.provider.submitted[0]?.calls,
    );
    assert.equal(
      off.provider.submitted[0]?.hash,
      converting.provider.submitted[0]?.hash,
    );
    const sequences = await off.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", /exitToQuote is off/);
    const position = await off.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");
  });

  it("skips as DUST when the fresh quote is at or below one submission's relay fee (Rev2 item 17)", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h, DUST_BOUNDARY_FREED);
    h.quoteResult = RELAY_FEE_PER_SUBMIT; // exactly the floor: `<=` skips
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", /at or below one submission's relay fee/);

    // One wei more and it is worth swapping — the boundary is STRICTLY `<=`.
    const worth = await createLpHarness();
    scriptExitToQuote(worth, DUST_BOUNDARY_FREED);
    worth.quoteResult = RELAY_FEE_PER_SUBMIT + 1n;
    const swapped = await runLpProtect(worth.deps, POSITION_ID);
    assert.equal(swapped.status, "completed");
    assert.equal(worth.provider.submitted.length, 2);
  });

  it("skips when the exit's price impact exceeds the rail — completed WITH A REASON, never held (Rev2 item 11)", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    // 20% under the fee-adjusted spot expectation: genuine impact, not a fee.
    h.quoteResult = (amountInAfterPoolFee(EXIT_FREED_TOKEN, 2_500) * 8_000n) / 10_000n;
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed", "a refused cosmetic leg never leaves the exit unfinished");
    assert.equal(result.code, "COMPLETED");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed");
    assert.match(sequences[0]?.note ?? "", /price impact/i);
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");
    assert.deepEqual(await workerQueue(h), { sequences: 0, positions: 0 });
  });

  it("the POOL FEE is no longer counted as impact: a quote at the fee-adjusted spot price still swaps (Rev2 item 16)", async () => {
    // The erratum, end to end. The quote is EXACTLY the fee-adjusted spot
    // output — zero genuine impact — on the 2500 tier. Fed the raw amountIn,
    // as audit A2's fix did, this reads ~25 bps; the harness rail is 500 so
    // that alone would still pass, so the case is sharpened below with a rail
    // set to the deployment's own 100 and the 1% tier.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.quoteResult = amountInAfterPoolFee(EXIT_FREED_TOKEN, 2_500);
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "zero genuine impact must never refuse");

    // The deployment's own configuration, on a 1% pool: the raw-amount formula
    // reads ~100 bps of "impact" that is entirely the pool's advertised fee,
    // and under Rev2 item 11 that refusal would be silent and permanent.
    const deployed = await createLpHarness();
    await deployed.store.setPositionState(OWNER, AGENT_ID, POSITION_ID, "open");
    const onePercent = {
      ...deployed.deps,
      rails: { ...RAILS, maxPriceImpactBps: 100 },
    };
    scriptExitToQuote(deployed);
    deployed.quoteResult = amountInAfterPoolFee(EXIT_FREED_TOKEN, 2_500);
    const strict = await runLpProtect(onePercent, POSITION_ID);
    assert.equal(strict.status, "completed");
    assert.equal(
      deployed.provider.submitted.length,
      2,
      "at LP_MAX_PRICE_IMPACT_BPS=100 the fee alone must not block the exit",
    );
  });

  it("A6: on a 1% pool at LP_MAX_PRICE_IMPACT_BPS=100 the exit swaps under the fix and would SKIP under the defect", async () => {
    // PHASE3.1-AUDIT A6: the case above cannot fail under the pre-erratum
    // formula. Its fixture is fee 2500 in BOTH halves, so the raw-amountIn
    // reading is 25 bps — under the 500 rail AND under the "sharpened" 100.
    // This is the fixture that separates them, at the numbers the audit
    // re-measured on chain: 3 bps under the fix, 103 under the defect.
    const h = await createLpHarness();
    await h.store.createPosition({
      positionId: "pos-1pct",
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: TOKEN,
      token1: WBNB,
      fee: 10_000,
      tokenId: "1042",
      basisWei: 10n ** 18n,
    });
    scriptExitToQuote(h, undefined, "1042");
    // Three bps of GENUINE impact on top of the pool's own 1% fee.
    h.quoteResult =
      (amountInAfterPoolFee(EXIT_FREED_TOKEN, 10_000) * 9_997n) / 10_000n;

    // The arithmetic the assertion rests on, stated so a reader can check it:
    const spotUnderTheFix = amountInAfterPoolFee(EXIT_FREED_TOKEN, 10_000);
    assert.equal(
      ((spotUnderTheFix - h.quoteResult) * 10_000n) / spotUnderTheFix,
      3n,
      "under the fix the rail reads 3 bps",
    );
    assert.equal(
      ((EXIT_FREED_TOKEN - h.quoteResult) * 10_000n) / EXIT_FREED_TOKEN,
      102n,
      "under the defect (raw amountIn) it reads 102 bps — OVER the 100 rail",
    );

    const deployed = { ...h.deps, rails: { ...RAILS, maxPriceImpactBps: 100 } };
    const result = await runLpProtect(deployed, "pos-1pct");
    assert.equal(result.status, "completed");
    assert.equal(
      h.provider.submitted.length,
      2,
      "the pool's advertised 1% fee must not block the exit swap",
    );
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    const sequence = sequences.find((entry) => entry.positionId === "pos-1pct");
    assert.equal(sequence?.note, null, "nothing was skipped, so nothing is owed");
  });

  it("A6: the same fixture pins makeSweepStep's call site — a rotate sweep on a 1% pool", async () => {
    // The audit's second half: item 16 names TWO sites and only the exit's was
    // exercised at a fee tier that can tell the formulas apart.
    const h = await createLpHarness();
    await h.store.createPosition({
      positionId: "pos-1pct-rotate",
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: TOKEN,
      token1: WBNB,
      fee: 10_000,
      tokenId: "1043",
      basisWei: 10n ** 18n,
    });
    scriptRotate(h, "1043");
    h.quoteResult =
      (amountInAfterPoolFee(ROTATE_SWEEP_IN, 10_000) * 9_997n) / 10_000n;
    const spotUnderTheFix = amountInAfterPoolFee(ROTATE_SWEEP_IN, 10_000);
    assert.equal(
      ((spotUnderTheFix - h.quoteResult) * 10_000n) / spotUnderTheFix,
      3n,
    );
    assert.equal(
      ((ROTATE_SWEEP_IN - h.quoteResult) * 10_000n) / ROTATE_SWEEP_IN,
      102n,
      "the defect would refuse this sweep at the deployment's own rail",
    );

    const result = await runLpRotate(
      { ...rotateDeps(h), rails: { ...RAILS, maxPriceImpactBps: 100 } },
      "pos-1pct-rotate",
    );
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 3, "zap-out, sweep, mint");
  });

  it("converts on a deployment whose configured WBNB is NOT the DEFAULT_QUOTE_TOKEN literal", async () => {
    // THE REVIEW'S ONE FALSE PREMISE, pinned. Rev2 item 5 says the swap's
    // destination is `position.quoteToken` and that `quoteToken === venue.wbnb`
    // is "always true in v1". It is not: `createPosition` defaults the field to
    // DEFAULT_QUOTE_TOKEN — a hardcoded BNB-Chain-56 WBNB literal — and nothing
    // on the `/lp/open` path overrides it, so every testnet deployment (and
    // every offline fixture) records a quoteToken that differs from its own
    // configured WBNB. Keying the swap off the recorded field would make the
    // exit skip on EVERY position of such a deployment, silently and for ever.
    // The POOL'S OWN quote leg is the authority.
    const altWbnb = getAddress("0x2222222222222222222222222222222222222222");
    assert.notEqual(altWbnb, DEFAULT_QUOTE_TOKEN);
    const h = await createLpHarness();
    const created = await h.store.createPosition({
      positionId: "pos-testnet",
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: TOKEN,
      token1: altWbnb,
      fee: 2_500,
      tokenId: "1044",
      basisWei: 10n ** 18n,
    });
    assert.equal(created.quoteToken, DEFAULT_QUOTE_TOKEN, "the stale literal, as stored");
    scriptExitToQuote(h, undefined, "1044");
    const result = await runLpProtect(
      { ...h.deps, venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: altWbnb } },
      "pos-testnet",
    );
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the exit must still convert");
    assert.deepEqual(h.quoteCalls, [
      { tokenIn: TOKEN, tokenOut: altWbnb, fee: 2_500, amountInWei: EXIT_FREED_TOKEN },
    ]);
  });

  it("skips when the exit frees no non-quote leg, and when the quote reader is down", async () => {
    const empty = await createLpHarness();
    scriptExit(empty); // all-WBNB exit: nothing to convert
    const first = await runLpProtect(empty.deps, POSITION_ID);
    assert.equal(first.status, "completed");
    assert.equal(empty.provider.submitted.length, 1);
    assert.equal(empty.quoteCalls.length, 0);

    const blind = await createLpHarness();
    scriptExitToQuote(blind);
    const result = await runLpProtect(
      {
        ...blind.deps,
        quote: async () => {
          throw new Error("quoter down");
        },
      },
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    assert.equal(blind.provider.submitted.length, 1);
    const sequences = await blind.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", /quote could not be read/);
  });
});

/* -------------------------------------------------------------------------- */
/* Rev2 item 12's behaviour table for the OPTIONAL step                       */
/* -------------------------------------------------------------------------- */

describe("lp exit: the optional step's behaviour table (Rev2 item 12)", () => {
  it("a BUILD throw is a recorded skip, and the sequence completes", async () => {
    // A position whose recorded fee is not one of the four V3 tiers: the
    // builder's own guard throws, and on an OPTIONAL step a throw is a skip.
    const h = await createLpHarness();
    await h.store.createPosition({
      positionId: "pos-odd",
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: TOKEN,
      token1: WBNB,
      fee: 3_000,
      tokenId: "1045",
      basisWei: 10n ** 18n,
    });
    scriptExitToQuote(h, undefined, "1045");
    const result = await runLpProtect(h.deps, "pos-odd");
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    const sequence = sequences.find((entry) => entry.positionId === "pos-odd");
    assert.equal(sequence?.state, "completed");
    assert.match(sequence?.note ?? "", /fee must be one of the known V3 tiers/);
  });

  it("a PREFLIGHT refusal is a recorded skip: the row rolls back and the plan position closes at the next index", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    h.provider.preflightError = new Error("session cannot move this token");
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 1, "a refused preflight never submits");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed");
    assert.match(sequences[0]?.note ?? "", /session cannot move this token/);
    // Three recorded steps: zap-out, the rolled-back swap attempt, the skip.
    assert.equal(sequences[0]?.steps.length, 3);
    assert.deepEqual(await workerQueue(h), { sequences: 0, positions: 0 });
  });

  it("a CONFIRMED REVERT completes, and the reverting swap is NOT resubmitted on the next cycle", async () => {
    // THE UNBOUNDED-GAS CASE. Without `optional`, the FAILED receipt marks the
    // row ROLLED_BACK and holds; audit A1's join then reads that row as an OPEN
    // slot, so every worker cycle appends a fresh step and resubmits the same
    // reverting swap, drawing relay gas for ever.
    const h = await createLpHarness();
    h.quoteResult = EXIT_QUOTE_OUT;
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, {
        amount0Wei: EXIT_FREED_TOKEN,
        amount1Wei: FREED_WBNB,
      });
      return confirmed(txHash);
    });
    h.provider.script.push(() => ({ status: "FAILED", failureCode: "NOT_ALLOWED" }));

    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed", "TERMINAL, not `active` for ever");
    assert.match(sequences[0]?.note ?? "", /FAILED \(NOT_ALLOWED\)/);
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");

    // The worker has nothing left to pick up — no sequence to resume, no open
    // position to evaluate. THAT is what "not resubmitted every cycle" means.
    assert.deepEqual(await workerQueue(h), { sequences: 0, positions: 0 });
    // And an explicit second drive submits nothing more: the script is empty,
    // so any further submit would throw and hold instead of completing.
    const again = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(again.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the reverting swap must never be retried");
  });

  it("an EXPIRED session is a recorded skip on the optional step", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    const facts = h.deps.agent.sessionFacts;
    assert.ok(facts !== null);
    const expired: LpSagaDeps = {
      ...h.deps,
      agent: {
        ...h.deps.agent,
        sessionFacts: {
          ...facts,
          spec: { ...facts.spec, expiresAt: NOW_SEC - 1 },
          expiry: NOW_SEC - 1,
        },
      },
    };
    const result = await runLpProtect(expired, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", /SESSION_EXPIRED/);
  });

  it("a between-step RAILS failure is a recorded skip on the optional step", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    const trippedMarket: LpMarketReader = async () => ({
      ...baseMarket(),
      blockNumber: 101n,
      finalizedBlockNumber: 100n,
    });
    const result = await runLpProtect(
      { ...h.deps, market: trippedMarket },
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", /not finalized/i);
  });

  it("a GLOBAL HALT still HOLDS the optional step — a halt is transient, not a behaviour switch", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    await h.killswitch.halt("operator stop");
    const halted = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(halted.status, "held");
    assert.equal(halted.code, "GLOBAL_HALT");
    assert.equal(h.provider.submitted.length, 1);
    const held = await h.store.listSequences(OWNER, AGENT_ID);
    // PHASE3.1-AUDIT A5: this assertion used to demand `note === null` —
    // "nothing was skipped, so nothing is explained". That was the finding: the
    // HOLD branches are the ones where a swap is genuinely STILL OWED, the
    // position is already `closed`, and `LpSagaRunResult.reason` reaches only
    // the worker's log for an autonomous protect. The owner's dashboard read
    // `state: "active", note: null` over a closed position with an
    // un-converted leg — verbatim the gap item 15 exists to close.
    assert.match(held[0]?.note ?? "", /GLOBAL_HALT/, "a HELD exit explains itself");
    // Non-terminal, so the worker owes it a resume — but the position is
    // already closed and out of the trigger queue (Rev2 item 13).
    assert.deepEqual(await workerQueue(h), { sequences: 1, positions: 0 });

    await h.killswitch.resume();
    const resumed = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the owed swap runs once the halt lifts");
    // A5's companion: the conversion HAPPENED, so the sentence saying it was
    // owed must not outlive it. A COMPLETED exit that converted owes nothing.
    const done = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(done[0]?.note, null, "the owed-conversion note is cleared by the conversion");
  });

  it("a SETTINGS DIGEST MISMATCH still HOLDS the optional step, then re-arms", async () => {
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    h.currentDigest = `0x${"cd".repeat(32)}` as Hex;
    const mismatched = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(mismatched.status, "held");
    assert.equal(mismatched.code, "SETTINGS_DIGEST_MISMATCH");
    assert.equal(h.provider.submitted.length, 1);

    h.currentDigest = ARMED_DIGEST;
    const resumed = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
  });

  it("an UNKNOWN submit on the optional step HOLDS and is never replayed", async () => {
    const h = await createLpHarness();
    h.quoteResult = EXIT_QUOTE_OUT;
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, {
        amount0Wei: EXIT_FREED_TOKEN,
        amount1Wei: FREED_WBNB,
      });
      return confirmed(txHash);
    });
    h.provider.script.push(() => {
      throw new Error("transport died mid-submit");
    });

    const first = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(first.status, "held");
    assert.equal(first.code, "HELD_AMBIGUOUS");
    assert.equal(h.provider.submitted.length, 2);
    const keys = await recordedKeys(h);
    assert.equal((await h.journal.get(keys[1] ?? ""))?.state, "UNKNOWN");

    const second = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(second.status, "held");
    assert.equal(
      h.provider.submitted.length,
      2,
      "ambiguity never auto-replays, optional or not",
    );
    assertNoDuplicateSubmits(h);
  });

  it("A1: a TRANSIENT quote failure HOLDS and retries — it never permanently returns the token", async () => {
    // THE FINDING. The bare catch turned every quote-read failure into a
    // recorded SKIP, and a skip is terminal: the sequence completes, the
    // lineage closes, and nothing in the plane ever tries again. A rate-limited
    // dataseed at the exact moment a stop-loss fires is not a product decision.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    let rateLimited = true;
    const flaky: LpSagaDeps = {
      ...h.deps,
      quote: async (params) => {
        if (rateLimited) throw new Error("HTTP 429 Too Many Requests");
        return h.deps.quote(params);
      },
    };
    const first = await runLpProtect(flaky, POSITION_ID);
    assert.equal(first.status, "held", "a transport failure must not complete the exit");
    assert.equal(first.code, "BUILD_REFUSED");
    assert.match(first.reason, /still owed/);
    assert.equal(h.provider.submitted.length, 1, "the zap-out confirmed; the swap did not run");
    const held = await h.store.listSequences(OWNER, AGENT_ID);
    // PHASE3.11 F2: the exit's zap-out now NAMES where the freed principal
    // sits, so a hold on the optional step PARKS the row instead of leaving it
    // `active`+`none` — un-abandonable, which is the defect. The `workerQueue`
    // assertion below is the one that matters here: still non-terminal, so the
    // worker resumes it.
    assert.equal(held[0]?.state, "held", "parked, not left mid-drive");
    assert.equal(held[0]?.recoveryState, "wbnb-stranded");
    assert.match(held[0]?.note ?? "", /Transient/i, "and the owner is told a swap is owed");
    // The position is closed and out of the trigger queue; only the sequence
    // remains, which is exactly what the worker picks up next cycle.
    assert.deepEqual(await workerQueue(h), { sequences: 1, positions: 0 });

    rateLimited = false;
    const resumed = await runLpProtect(flaky, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the owed conversion runs on the retry");
    assertNoDuplicateSubmits(h);
    const done = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(done[0]?.note, null, "the conversion clears its own owed-note");
  });

  it("A1/F2: the budget is ATTEMPTS, and the skip only comes after every one of them ran", async () => {
    // BOUNDED, because an unbounded hold re-creates the trap Rev2 item 15
    // refused: a sequence that can never finish.
    //
    // PHASE3.1-FIXREVIEW F2 changed WHAT bounds it. The wall clock this case
    // used to advance measured elapsed time since the SEQUENCE was born, which
    // is neither the step's first failure nor a count of anything the step did.
    // The budget is now attempt-shaped, so this drives the real thing: N-1
    // holds, then the skip, with nothing else moved.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    const down: LpSagaDeps = {
      ...h.deps,
      quote: async () => {
        throw new Error("HTTP 503 Service Unavailable");
      },
    };

    for (let attempt = 1; attempt < OPTIONAL_TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      const held = await runLpProtect(down, POSITION_ID);
      assert.equal(held.status, "held", `attempt ${attempt} must still retry`);
      assert.match(
        held.reason,
        new RegExp(`attempt ${attempt} of ${OPTIONAL_TRANSIENT_RETRY_ATTEMPTS}`),
        "the hold counts, so an operator can see how much budget is left",
      );
      const live = await h.store.listSequences(OWNER, AGENT_ID);
      // F2: parked with a named recovery, which the queue below still counts.
      assert.equal(live[0]?.state, "held");
      assert.equal(live[0]?.recoveryState, "wbnb-stranded");
      assert.deepEqual(
        await workerQueue(h),
        { sequences: 1, positions: 0 },
        "non-terminal, so the worker resumes it",
      );
    }

    const exhausted = await runLpProtect(down, POSITION_ID);
    assert.equal(exhausted.status, "completed", "a stop-loss never stays unfinished for ever");
    assert.equal(h.provider.submitted.length, 1, "no retry ever submitted anything");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed");
    assert.match(
      sequences[0]?.note ?? "",
      new RegExp(
        `transient failure on all ${OPTIONAL_TRANSIENT_RETRY_ATTEMPTS} of ` +
          `${OPTIONAL_TRANSIENT_RETRY_ATTEMPTS} attempts, retries exhausted`,
      ),
      "the reason names the count it actually made — never a window a step never got",
    );
    assert.deepEqual(await workerQueue(h), { sequences: 0, positions: 0 });
    assertNoDuplicateSubmits(h);
  });

  it("F2: a sequence that reaches its optional step LATE still gets its full retry budget", async () => {
    // THE FINDING, stated as the case that used to fail. The window was
    // anchored on the SEQUENCE's `createdAt`, so a sequence held between the
    // steps — a GLOBAL_HALT "which may last hours", a digest re-arm, a PENDING
    // step 0 resolved by `reconcile`, an A13 park — arrived at step 1 with the
    // budget already spent, took the terminal skip on its FIRST failure, and
    // then recorded "retry window exhausted" about a step that had run once.
    // A1's fix, gated behind a slow step 0.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    let rateLimited = true;
    const flaky: LpSagaDeps = {
      ...h.deps,
      quote: async (params) => {
        if (rateLimited) throw new Error("read ECONNRESET");
        return h.deps.quote(params);
      },
    };

    // Step 0 confirms, then the run dies between the steps — the same idiom the
    // GLOBAL_HALT case above uses to put a refusal BETWEEN the two steps rather
    // than before step 0, where it would simply roll back.
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(flaky, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    // Now the operator halts, and the clock moves 45 minutes — past the 30 the
    // old anchor allowed the WHOLE sequence, and deliberately short of the
    // fixture's own one-hour session expiry, which is a different refusal and
    // would prove nothing about this one.
    await h.killswitch.halt("operator stop");
    const halted = await runLpProtect(flaky, POSITION_ID);
    assert.equal(halted.status, "held");
    assert.equal(halted.code, "GLOBAL_HALT");
    assert.equal(h.provider.submitted.length, 1, "the zap-out confirmed; the swap did not run");
    await h.killswitch.resume();
    h.clock.ms = NOW_MS + 45 * 60 * 1000;

    const first = await runLpProtect(flaky, POSITION_ID);
    assert.equal(
      first.status,
      "held",
      "lateness is not a reason to permanently return the token",
    );
    assert.match(first.reason, /attempt 1 of/, "and it really is the FIRST attempt");
    assert.doesNotMatch(
      first.reason,
      /exhausted/,
      "nothing may claim a budget was spent by a step that ran once",
    );

    rateLimited = false;
    const resumed = await runLpProtect(flaky, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the owed conversion runs on the retry");
    assertNoDuplicateSubmits(h);
  });

  it("G1: an unrelated GLOBAL_HALT row does NOT spend the transient retry budget", async () => {
    // THE FINDING (PHASE3.1-FIXREVIEW2 G1). The budget used to count every
    // trailing provably-unsubmitted row at the plan position, whatever refused
    // it — so a halt arriving in the window between the EARLY kill-switch check
    // and the LATE one (which spans `market()`, the rails check, `build`'s RPC
    // quote, `appendStep` and `beginWithSpend`) rolled a row back, held, and
    // then made the FIRST transient failure report `attempt 2 of 6`. In the
    // limit that reproduced the exact sentence F2 was filed about: an exhausted
    // budget claimed about a step that failed transiently once. A halt is not an
    // attempt at the swap.
    //
    // The halt is triggered FROM the fresh quote, which is the only way to land
    // it inside that window: `build` succeeds, the row is appended and begun,
    // and only then does the late re-check refuse.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    let haltedOnce = false;
    let brokenAfterHalt = true;
    const haltMidStep: LpSagaDeps = {
      ...h.deps,
      quote: async (params) => {
        if (!haltedOnce) {
          const quoted = await h.deps.quote(params);
          haltedOnce = true;
          await h.killswitch.halt("operator stop, mid-step");
          return quoted;
        }
        if (brokenAfterHalt) throw new Error("socket hang up");
        return h.deps.quote(params);
      },
    };

    const halted = await runLpProtect(haltMidStep, POSITION_ID);
    assert.equal(halted.status, "held");
    assert.equal(halted.code, "GLOBAL_HALT", "the LATE re-check is the one that refused");
    assert.equal(h.provider.submitted.length, 1, "the zap-out only; the swap never submitted");
    // The halt really did leave a rolled-back row trailing the live step 0 —
    // otherwise this case would prove nothing about what the scan counts.
    const afterHalt = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(
      afterHalt[0]?.steps.length,
      2,
      "the halt's row is recorded, and it is the row G1 is about",
    );

    await h.killswitch.resume();
    const first = await runLpProtect(haltMidStep, POSITION_ID);
    assert.equal(first.status, "held");
    assert.match(
      first.reason,
      /attempt 1 of/,
      "the halt's row must not be charged to the transport budget",
    );
    assert.doesNotMatch(first.reason, /exhausted/);

    // And the budget is genuinely intact: the full N-1 holds are still available
    // AFTER the halt, so the count is attributable rather than merely shifted.
    for (let attempt = 2; attempt < OPTIONAL_TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      const held = await runLpProtect(haltMidStep, POSITION_ID);
      assert.equal(held.status, "held", `attempt ${attempt} must still retry`);
      assert.match(
        held.reason,
        new RegExp(`attempt ${attempt} of ${OPTIONAL_TRANSIENT_RETRY_ATTEMPTS}`),
      );
    }

    brokenAfterHalt = false;
    const resumed = await runLpProtect(haltMidStep, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the owed conversion still runs");
    assertNoDuplicateSubmits(h);
  });

  it("F1: a socket reset, a DNS failure, viem's fetch failed and its TimeoutError all HOLD", async () => {
    // THE SHIP GATE, and the half the first fix pass missed. A1 defined the
    // transient class as `INFRASTRUCTURE_ERROR`, which recognised HTTP-STATUS
    // failures only — so a 429 held and a dropped connection took the permanent
    // skip, which is backwards: the connection-level failures are the COMMON
    // ones. Two code comments claimed a socket reset was covered. It was not.
    //
    // These are the exact strings Node, undici and viem produce.
    for (const message of [
      "socket hang up",
      "read ECONNRESET",
      "connect ETIMEDOUT 10.0.0.1:443",
      "getaddrinfo EAI_AGAIN bsc-dataseed.example",
      "HTTP request failed. Details: fetch failed",
      "The request took too long to respond. Details: The request timed out.",
    ]) {
      const h = await createLpHarness();
      scriptExitToQuote(h);
      let broken = true;
      const flaky: LpSagaDeps = {
        ...h.deps,
        quote: async (params) => {
          if (broken) throw new Error(message);
          return h.deps.quote(params);
        },
      };

      const held = await runLpProtect(flaky, POSITION_ID);
      assert.equal(held.status, "held", `"${message}" must not complete the exit`);
      assert.equal(held.code, "BUILD_REFUSED");
      assert.match(held.reason, /still owed/);
      assert.equal(h.provider.submitted.length, 1, "the zap-out confirmed; the swap did not");
      const live = await h.store.listSequences(OWNER, AGENT_ID);
      // F2: `held` + a named recovery is NON-terminal (the queue below), and
      // it is the state an abandon can act on if the transport never heals.
      assert.equal(live[0]?.state, "held", `"${message}" left the sequence mid-drive`);
      assert.equal(live[0]?.recoveryState, "wbnb-stranded");
      // The position is closed and out of the trigger queue; only the sequence
      // remains, which is what the worker picks up next cycle.
      assert.deepEqual(await workerQueue(h), { sequences: 1, positions: 0 });

      broken = false;
      const resumed = await runLpProtect(flaky, POSITION_ID);
      assert.equal(resumed.status, "completed", `"${message}" never got its retry`);
      assert.equal(h.provider.submitted.length, 2, "the owed conversion runs on the retry");
      assertNoDuplicateSubmits(h);
    }
  });

  it("F3: an optional step resolved by RECONCILE completes with its hold note CLEARED", async () => {
    // THE FINDING. A5 clears the owed-conversion note on the live confirm path
    // at the bottom of the plan loop, and that was the only place. So the exit
    // whose step 1 landed PENDING with a callsId — FINDINGS (aa)/(al)'s exact
    // relay behaviour — held with "a swap is owed", was resolved to COMMITTED
    // by `reconcile`, came back through the REPLAY loop, walked past
    // `plan.length` and COMPLETED still saying a swap was owed. Erratum E3 is
    // normative that this must not happen, and `lpSequenceView` renders the
    // note as the owner's only in-product explanation.
    const h = await createLpHarness();
    h.quoteResult = EXIT_QUOTE_OUT;
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, {
        amount0Wei: EXIT_FREED_TOKEN,
        amount1Wei: FREED_WBNB,
      });
      return confirmed(txHash);
    });
    const swapTx = txAt(1);
    h.provider.script.push(() => ({
      status: "PENDING",
      callsId: `0x${"c3".repeat(32)}` as Hex,
    }));

    const first = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(first.status, "held");
    assert.equal(first.code, "HELD_AMBIGUOUS");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(
      sequences[0]?.note ?? "",
      /HELD_AMBIGUOUS/,
      "A5: the hold explains itself while it is still true",
    );

    // The chain says the swap landed. `reconcile` resolves the STEP ROW, and
    // the resume then has nothing left to run — the plan loop never executes,
    // which is precisely why the live path's clearing could not fire.
    h.provider.awaitResult = { status: "CONFIRMED", transactionHash: swapTx };
    const summary = await reconcile({
    minRowAgeMs: 0,
      provider: h.provider,
      journal: h.journal,
      resolveWallet: async () => null,
    });
    assert.equal(summary.committed, 1);

    const resumed = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "ambiguity never auto-replays");
    const done = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(done[0]?.state, "completed");
    assert.equal(
      done[0]?.note,
      null,
      "the conversion happened, so the owner must not be told one is owed",
    );
    assertNoDuplicateSubmits(h);
  });

  it("F3: a SKIPPED optional step keeps its note across a resume", async () => {
    // The counter-case that keeps the clearing honest: item 15's note explains
    // a COMPLETED exit that really did hand back the token, and a replay of the
    // skip row must never erase it. The live path draws the same line by
    // sitting after `markCommitted`; the replay path draws it on `txHash`.
    const h = await createLpHarness({ exitToQuote: false });
    scriptExitToQuote(h);
    const done = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(done.status, "completed");
    assert.equal(h.provider.submitted.length, 1, "exitToQuote is off: no swap");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(
      sequences[0]?.note ?? "",
      /exitToQuote is off/,
      "the owner's only in-product explanation survives",
    );
  });

  it("F1: the same connection failure on the PREFLIGHT holds too", async () => {
    // The second transient site. `restoreSession`/`preflightExecute` cover the
    // session-key decryption, the Altana SDK transport and the relay's own
    // pre-flight — and the plane's OWN pre-flight turned an RPC outage into a
    // NOT_ALLOWED policy refusal before any classifier could see it, which is
    // fixed in `src/wallet/altana.ts` and pinned in `test/executeGuards.test.ts`.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    h.provider.preflightError = new Error("socket hang up");
    const held = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(held.status, "held");
    assert.equal(held.code, "STEP_REFUSED");
    assert.match(held.reason, /attempt 1 of/);
    assert.equal(h.provider.submitted.length, 1, "a refused preflight never submits");

    h.provider.preflightError = null;
    const resumed = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
    assertNoDuplicateSubmits(h);
  });

  it("A1: a TRANSIENT preflight failure holds too, while a policy refusal still skips on the first try", async () => {
    const infra = await createLpHarness();
    scriptExitToQuote(infra);
    infra.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(infra.deps, POSITION_ID), /market reader died/);
    infra.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    infra.provider.preflightError = new Error("relay responded 502 Bad Gateway");
    const held = await runLpProtect(infra.deps, POSITION_ID);
    assert.equal(held.status, "held");
    assert.equal(held.code, "STEP_REFUSED");
    assert.equal(infra.provider.submitted.length, 1, "a refused preflight never submits");
    const sequences = await infra.store.listSequences(OWNER, AGENT_ID);
    // F2: parked with a named recovery rather than left `active`+`none`; the
    // resume below is what proves it was retried and not skipped.
    assert.equal(sequences[0]?.state, "held", "retried, not skipped");
    assert.equal(sequences[0]?.recoveryState, "wbnb-stranded");

    infra.provider.preflightError = null;
    const resumed = await runLpProtect(infra.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(infra.provider.submitted.length, 2);

    // The counter-case, unchanged: a POLICY refusal is a product decision and
    // stays the terminal skip Rev2 item 12 specified.
    const policy = await createLpHarness();
    scriptExitToQuote(policy);
    policy.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(policy.deps, POSITION_ID), /market reader died/);
    policy.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    policy.provider.preflightError = new Error("UnauthorizedCall");
    const skipped = await runLpProtect(policy.deps, POSITION_ID);
    assert.equal(skipped.status, "completed", "a product refusal needs no second chance");
    assert.equal(policy.provider.submitted.length, 1);
  });

  it("G1: the PREFLIGHT site's own rows are still charged to the budget, one per attempt", async () => {
    // The other half of G1, and the half that could have broken. The preflight
    // path rolls its row back BEFORE it classifies, so scoping the count to the
    // transient path meant that write had to carry the attribution — otherwise
    // the transport failures the budget exists for would have stopped counting
    // and the retry would have become unbounded, which is the trap Rev2 item 15
    // refused. So: N-1 holds numbered 1…N-1, then the terminal skip.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    h.provider.preflightError = new Error("socket hang up");

    for (let attempt = 1; attempt < OPTIONAL_TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      const held = await runLpProtect(h.deps, POSITION_ID);
      assert.equal(held.status, "held", `attempt ${attempt} must still retry`);
      assert.equal(held.code, "STEP_REFUSED");
      assert.match(
        held.reason,
        new RegExp(`attempt ${attempt} of ${OPTIONAL_TRANSIENT_RETRY_ATTEMPTS}`),
        "each preflight failure is one attempt, counted exactly once",
      );
    }

    const exhausted = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(exhausted.status, "completed", "still bounded");
    assert.equal(h.provider.submitted.length, 1, "no attempt ever submitted anything");
    assertNoDuplicateSubmits(h);
  });

  it("G2: a DETERMINISTIC revert out of the fresh quote skips on the FIRST attempt", async () => {
    // PHASE3.1-FIXREVIEW3 **H4**. `PHASE3.1-FIXREVIEW2` G2 and its commit message
    // both LEAD with this behaviour — "the optional step was HOLDING and
    // re-attempting a deterministic revert up to six times" — and nothing
    // asserted it: `REVERT_EVIDENCE` was pinned only through the classifier's own
    // unit cases, so mutating the gate away failed four tests in
    // `test/errors.test.ts` and not one test on the money-adjacent path.
    //
    // `Timeout()` is an ordinary custom-error name a router or a timelock can
    // genuinely revert with, and `\b(?:timed ?out|timeout)\b` used to claim it as
    // an outage. `INFRASTRUCTURE_ERROR` is the class the retry keys on, so the
    // owner's stop-loss held its conversion for six worker cycles over a refusal
    // that would never have succeeded. A revert is an ANSWER: it skips at once.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    const reverting: LpSagaDeps = {
      ...h.deps,
      quote: async () => {
        throw new Error("execution reverted: Timeout()");
      },
    };

    const result = await runLpProtect(reverting, POSITION_ID);
    assert.equal(result.status, "completed", "a revert needs no second chance");
    assert.equal(h.provider.submitted.length, 1, "the zap-out only");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed", "skipped, not held");
    assert.match(sequences[0]?.note ?? "", /quote could not be read/);
    assert.doesNotMatch(
      sequences[0]?.note ?? "",
      /transient|attempts/,
      "and it was never counted as a transport attempt",
    );

    // The counter-case in the same test, so the pin cannot pass by making
    // EVERYTHING terminal: a real transport failure on the same reader holds.
    const outage = await createLpHarness();
    scriptExitToQuote(outage);
    const held = await runLpProtect(
      {
        ...outage.deps,
        quote: async () => {
          throw new Error("socket hang up");
        },
      },
      POSITION_ID,
    );
    assert.equal(held.status, "held", "an outage is still retried");
    assert.match(held.reason, /attempt 1 of/);
  });

  it("A4: a SKIPPED step 0 plus a HOLD-class refusal on step 1 never re-opens the empty position", async () => {
    // The churn loop: step 0 skips (burned/empty), so `confirmedMoney === 0`;
    // a halt on step 1 then took `refuseCleanly`'s ROLLBACK branch, whose
    // `abandon()` returned the EMPTY position to `open` with its basis intact
    // — and the worker re-dispatched a protect every cycle for the duration.
    const h = await createLpHarness();
    h.positions.set("42", "burned");
    // The HOLD-class refusal must arrive BETWEEN the steps — both gates run
    // before step 0 as well, and a refusal there is the ordinary pre-3.1
    // rollback. The digest re-read is per step, so drifting it after the first
    // read reproduces the audit's trace exactly.
    let digestReads = 0;
    const drifting: LpSagaDeps = {
      ...h.deps,
      currentSettingsDigest: async () => {
        digestReads += 1;
        return digestReads === 1 ? ARMED_DIGEST : (`0x${"cd".repeat(32)}` as Hex);
      },
    };

    const first = await runLpProtect(drifting, POSITION_ID);
    assert.equal(first.status, "rolled-back");
    assert.equal(first.code, "SETTINGS_DIGEST_MISMATCH");
    assert.equal(h.provider.submitted.length, 0, "a burned position submits nothing");
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed", "a burned lineage is over, whatever step 1 does");
    assert.equal(position?.basisWei, 0n);
    // NOTHING for the worker to pick up: no open position, no live sequence.
    // Before the fix this read `{ sequences: 0, positions: 1 }` and the worker
    // dispatched another protect every cycle for the duration of the refusal.
    assert.deepEqual(await workerQueue(h), { sequences: 0, positions: 0 });

    // And a second cycle under the same sustained refusal cannot re-open it.
    const again = await runLpProtect(drifting, POSITION_ID);
    assert.equal(again.status, "rolled-back");
    assert.equal(
      (await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID))?.state,
      "closed",
      "never returned to the trigger queue",
    );
    assert.deepEqual(await workerQueue(h), { sequences: 0, positions: 0 });
  });

  it("A13: a replay-path `after` failure HOLDS instead of escaping the saga", async () => {
    // PHASE3.1 added `collectAmounts` — a `getTransactionReceipt`, the one
    // method FINDINGS (ad) records some pinned endpoints refusing — to step 0's
    // `after`, which the join loop called outside any try/catch.
    const h = await createLpHarness();
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    const blindReceipts: LpReceiptReader = {
      ...h.receipts,
      collectAmounts: async () => {
        throw new Error("no Collect log in the receipt");
      },
      swapAmounts: (txHash) => h.receipts.swapAmounts(txHash),
      mintedTokenId: (txHash) => h.receipts.mintedTokenId(txHash),
    };
    const result = await runLpProtect({ ...h.deps, receipts: blindReceipts }, POSITION_ID);
    assert.equal(result.status, "held", "a typed hold, not a throw out of runLpProtect");
    assert.equal(result.code, "POST_VERIFY_FAILED");
    assert.equal(h.provider.submitted.length, 1, "and nothing was resubmitted");

    // The receipt heals and the resume finishes the owed conversion.
    const resumed = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
  });

  it("the optional step PROCEEDS under an owner pause (Rev2 item 20)", async () => {
    const h = await createLpHarness();
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    scriptExitToQuote(h);
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the conversion is exposure-REDUCING");
  });
});

/* -------------------------------------------------------------------------- */
/* Migration: a Phase-3-shaped exit resumes into the new plan                  */
/* -------------------------------------------------------------------------- */

describe("lp exit: the upgrade path", () => {
  it("a Phase-3 exit sequence with ONE recorded, COMMITTED zap-out drives the new step 1 and completes", async () => {
    // Exactly what a deploy finds in flight: one recorded step, its journal row
    // COMMITTED with a txHash. `plan[0].kind` still matches, so the replay runs
    // step 0's `after` from the receipt and the driver then runs step 1.
    const h = await createLpHarness();
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "protect",
    });
    await h.store.setPositionState(OWNER, AGENT_ID, POSITION_ID, "closing");
    const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
    const key = executeIdempotencyKey(AGENT_ID, decisionId, hashCalls([{ to: NFPM }]));
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "zap-out",
      journalIdempotencyKey: key,
    });
    await h.journal.beginWithSpend(
      {
        idempotencyKey: key,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        kind: "lp",
        decisionId,
        nativeSpendWei: 0n,
      },
      0,
    );
    const legacyTx = txAt(99);
    await h.journal.markCommitted(key, { txHash: legacyTx });
    h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
    h.receipts.collectByTx.set(legacyTx, {
      amount0Wei: EXIT_FREED_TOKEN,
      amount1Wei: FREED_WBNB,
    });
    h.quoteResult = EXIT_QUOTE_OUT;
    h.provider.script.push((_params, txHash) => confirmed(txHash));

    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 2);
    assert.equal(
      h.provider.submitted.length,
      1,
      "the legacy zap-out is replayed from its receipt, never resubmitted",
    );
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "closed");
  });

  it("PLAN_MISMATCH is unreachable across an exitToQuote flip — the plan length never varies (Rev2 item 10)", async () => {
    const h = await createLpHarness({ exitToQuote: true });
    scriptExitToQuote(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpProtect(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    // The owner turns the flag OFF mid-sequence. A plan whose LENGTH varied
    // would hit PLAN_MISMATCH → held + recovery `none`, which reads as TERMINAL
    // and would release a position that is still mid-exit.
    const flipped = await runLpProtect({ ...h.deps, exitToQuote: false }, POSITION_ID);
    assert.equal(flipped.status, "completed");
    assert.notEqual(flipped.code, "PLAN_MISMATCH");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed");
    assert.match(sequences[0]?.note ?? "", /exitToQuote is off/);
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep price-impact rail (audit A2)                                     */
/* -------------------------------------------------------------------------- */

describe("lp sagas: sweep price-impact rail (audit A2)", () => {
  // At price 1 (Q96) with WBNB as tokenIn, `spotSwapOutput` is identity, so
  // the sweep's expected-at-spot output equals ROTATE_SWEEP_IN and the quoted
  // impact is exactly (in - quote) / in in bps.
  const IMPACT_2000_BPS = (ROTATE_SWEEP_IN * 8_000n) / 10_000n; // 20% under spot
  const IMPACT_500_BPS = (ROTATE_SWEEP_IN * 9_500n) / 10_000n; // exactly the rail

  it("a rotate sweep quoted OVER the rail holds (money already moved) and resumes once the quote heals", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.quoteResult = IMPACT_2000_BPS; // 2000 bps > maxPriceImpactBps 500
    const first = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(first.status, "held");
    assert.equal(first.code, "BUILD_REFUSED");
    assert.match(first.reason, /price impact/i);
    assert.equal(h.provider.submitted.length, 1, "the sweep must not submit over the rail");
    const midway = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(midway[0]?.state, "held");
    assert.equal(midway[0]?.recoveryState, "pending-mint", "funds parked at the stated recovery state");

    // AT the rail (strict >) the sweep proceeds — the under-the-rail arm.
    h.quoteResult = IMPACT_500_BPS;
    const resumed = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 3);
    assertNoDuplicateSubmits(h);
  });

  it("a harvest sweep quoted over the rail holds the same way", async () => {
    const h = await createLpHarness();
    scriptHarvest(h);
    // Harvest sweeps HARVEST_FEE_WBNB / 2; 20% under its spot expectation.
    h.quoteResult = ((HARVEST_FEE_WBNB / 2n) * 8_000n) / 10_000n;
    const result = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /price impact/i);
    assert.equal(h.provider.submitted.length, 1, "collect only; the sweep must not submit");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-increase");
  });

  /**
   * PHASE3.12 B4/G2. The trigger gate decides on the PREVIOUS cycle's
   * evidence; this is the build-time seam that decides on the evidence the
   * collect would actually have submitted on. It sits at plan position 0
   * deliberately: `refuseCleanly` routes on confirmed money, and with none the
   * sequence rolls back TERMINAL and gives its reservation back. One step
   * later the identical refusal is a `held` row with the fees in the wallet —
   * the live Phase 3.11 incident.
   */
  it("G2: a harvest whose fresh read is out of the compoundable interior rolls back before the collect", async () => {
    const h = await createLpHarness();
    scriptHarvest(h);
    // The market fixture's tick is 0; move the position's own range so that 0
    // lands ON `tickLower` — in range by V3's lower-inclusive rule, and the
    // exact tick where the sweep's split is total in both orderings (F1).
    h.positions.set("42", { liquidity: LIQ, tickLower: 0, tickUpper: 1_000 });

    const result = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.equal(result.confirmedSteps, 0);
    assert.match(result.reason, /Harvest refused: tick 0/u);
    assert.match(result.reason, /\[0, 1000\)/u);
    assert.equal(h.provider.submitted.length, 0, "the collect must not submit");
    // PHASE3.13 F12 — the ride-along the Part 1 audit deferred, and the moved
    // pin. Part 1's saga seam carried no `autoRotate`, so this sentence stated
    // BOTH branches; `LpSagaDeps.autoRotate` is now required, so it names the
    // ONE remedy that applies to this owner (here: rotation is OFF).
    assert.match(result.reason, /--auto-rotate/u);
    assert.doesNotMatch(result.reason, /With autoRotate on/u);
    assert.doesNotMatch(result.reason, /The rotate is the action here/u);

    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    const sequence = sequences[0];
    assert.equal(sequence?.kind, "harvest");
    assert.equal(sequence?.state, "rolled-back", "TERMINAL, not held");
    assert.deepEqual(sequence?.steps.map((step) => step.kind), [], "no collect row was written");
    const reservation = await h.store.getReservation(
      OWNER,
      AGENT_ID,
      sequence?.sequenceId ?? "",
    );
    assert.notEqual(reservation?.releasedAt, null, "an unspent reservation is released");
  });

  /**
   * PHASE3.13 F12, the other arm. The Part 1 audit's Ruling 1 said in writing
   * that when Part 2 plumbed its own required saga dep, `autoRotate` should
   * ride along and the both-branches arm should retire. It has — so the SAME
   * refusal, for an owner who already has rotation on, must point at the rotate
   * instead of telling them to turn on something that is already on.
   *
   * This is the trigger-side pin (`test/lp.triggers.test.ts`, "refuses the same
   * harvest with autoRotate ON") moved to the seam that could not carry it.
   */
  it("G2: the refusal's remedy is CONDITIONAL on the owner's own autoRotate (F12)", async () => {
    const rotating = await createLpHarness({ autoRotate: true });
    scriptHarvest(rotating);
    rotating.positions.set("42", { liquidity: LIQ, tickLower: 0, tickUpper: 1_000 });

    const result = await runLpHarvest(rotating.deps, POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /The rotate is the action here/u);
    assert.doesNotMatch(result.reason, /--auto-rotate/u);
    // Both seams still speak the ONE builder's sentence, byte for byte — the
    // saga seam through `sanitizeMessage`, which is the 280-character ceiling
    // F12-b reordered the elements around. Asserting the SANITIZED identity
    // pins both facts at once: the seam adds no wording of its own, and the
    // truncation lands where the builder intends it to.
    const full = lpHarvestRangeHoldReason({
      currentTick: 0,
      tickLower: 0,
      tickUpper: 1_000,
      autoRotate: true,
    });
    assert.equal(result.reason, sanitizeMessage(full));
    assert.match(sanitizeMessage(full), /The rotate is the action here/u);
    assert.match(
      sanitizeMessage(
        lpHarvestRangeHoldReason({
          currentTick: 0,
          tickLower: 0,
          tickUpper: 1_000,
          autoRotate: false,
        }),
      ),
      /--auto-rotate/u,
      "the remedy must SURVIVE the ceiling at this seam — that is F12's whole point",
    );
  });

  /**
   * PHASE3.12 B5. The live incident's shape: the trigger dispatched on
   * evidence that said IN range (the position's own range brackets the
   * trigger's tick) and the saga's own read, taken later, says otherwise. G2
   * reads `ctx.market` — the driver's between-step read — so the dispatch gap
   * is closed at the only place it can be.
   */
  it("G2: the dispatch→build gap is closed — the saga's own read decides, not the trigger's", async () => {
    const h = await createLpHarness();
    scriptHarvest(h);
    // The position's range is the harness default [-1000, 1000): the trigger
    // that dispatched this harvest saw a tick inside it. The saga's fresh read
    // does not.
    const movedMarket: LpMarketReader = async () => ({ ...baseMarket(), currentTick: 2_000 });

    const result = await runLpHarvest({ ...h.deps, market: movedMarket }, POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.equal(result.confirmedSteps, 0);
    assert.match(result.reason, /Harvest refused: tick 2000/u);
    assert.equal(h.provider.submitted.length, 0);

    // And the in-interior arm of the same seam still runs to completion, so
    // the gate is the tick and nothing else.
    const healthy = await createLpHarness();
    scriptHarvest(healthy);
    const completed = await runLpHarvest(healthy.deps, POSITION_ID);
    assert.equal(completed.status, "completed");
    assert.equal(completed.confirmedSteps, 3);
  });
});

/* -------------------------------------------------------------------------- */
/* Pause matrix (mirrors audit.pauseExit.test.ts — Rev2 item 16)              */
/* -------------------------------------------------------------------------- */

describe("lp sagas: pause and halt", () => {
  it("protect PROCEEDS under pause — the FINDINGS (s) carve-out", async () => {
    const h = await createLpHarness();
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    scriptExit(h);
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 1);
  });

  it("the owner's manual exit PROCEEDS under pause", async () => {
    const h = await createLpHarness();
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    scriptExit(h);
    const result = await runLpManualExit(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
  });

  it("no NEW rotate starts under pause: a fresh rotate rolls back with zero submits", async () => {
    const h = await createLpHarness();
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "AGENT_PAUSED");
    assert.equal(h.provider.submitted.length, 0);
    // The position is FREE again — a parked empty rotate must not block a
    // later protect.
    scriptExit(h);
    const protect = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(protect.status, "completed");
  });

  it("an in-flight rotate finishes its zap-out, then HOLDS at pending-mint under pause", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.marketState.failAfterReads = 1; // crash right after the zap-out confirms
    await assert.rejects(() => runLpRotate(rotateDeps(h), POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(result.code, "AGENT_PAUSED");
    assert.equal(h.provider.submitted.length, 1, "the mint must hold under pause");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "held");
    assert.equal(sequences[0]?.recoveryState, "pending-mint");

    // Unpause ⇒ the stated safe state resumes to completion.
    await h.killswitch.unpauseAgent(AGENT_ID, OWNER);
    const resumed = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(resumed.status, "completed");
    assertNoDuplicateSubmits(h);
  });

  it("an in-flight harvest holds at pending-increase under pause", async () => {
    const h = await createLpHarness();
    scriptHarvest(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpHarvest(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const result = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(result.code, "AGENT_PAUSED");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-increase");
  });

  it("a global HALT blocks everything, protect included", async () => {
    const h = await createLpHarness();
    await h.killswitch.halt("operator stop");
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "GLOBAL_HALT");
    assert.equal(h.provider.submitted.length, 0);
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.state, "open", "an aborted exit puts the position back in play");
  });

  it("a global HALT holds an in-flight rotate rather than rolling back moved funds", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpRotate(rotateDeps(h), POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    await h.killswitch.halt("operator stop");
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(result.code, "GLOBAL_HALT");
  });
});

/* -------------------------------------------------------------------------- */
/* Gates: settings digest, quota, daily cap                                    */
/* -------------------------------------------------------------------------- */

describe("lp sagas: between-step gates", () => {
  it("a settings-digest mismatch aborts BETWEEN steps: the in-flight rotate holds, nothing more submits", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpRotate(rotateDeps(h), POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    h.currentDigest = `0x${"cd".repeat(32)}` as Hex;
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "held");
    assert.equal(result.code, "SETTINGS_DIGEST_MISMATCH");
    assert.equal(h.provider.submitted.length, 1);

    // Restoring the armed settings lets the stated recovery state resume.
    h.currentDigest = ARMED_DIGEST;
    const resumed = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(resumed.status, "completed");
  });

  it("a fresh saga under a digest mismatch rolls back before any money moves", async () => {
    const h = await createLpHarness();
    h.currentDigest = `0x${"cd".repeat(32)}` as Hex;
    const result = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "SETTINGS_DIGEST_MISMATCH");
    assert.equal(h.provider.submitted.length, 0);
  });

  it("quota refuses a rotate BEFORE any money moves; protect is exempt (Rev2 item 13)", async () => {
    const h = await createLpHarness({
      quota: { maxExitSequencesPerDay: 1, minMinutesBetweenExits: 5 },
    });
    scriptHarvest(h);
    const harvest = await runLpHarvest(h.deps, POSITION_ID);
    assert.equal(harvest.status, "completed");

    const rotate = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(rotate.status, "rolled-back");
    assert.equal(rotate.code, "QUOTA");
    assert.equal(h.provider.submitted.length, 3, "the refused rotate submitted nothing");

    // The protect still fires with the quota exhausted — and still writes its
    // reservation row for the R4 accounting.
    scriptExit(h);
    const protect = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(protect.status, "completed");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    const protectSequence = sequences.find((sequence) => sequence.kind === "protect");
    assert.notEqual(protectSequence, undefined);
    const reservation = await h.store.getReservation(
      OWNER,
      AGENT_ID,
      protectSequence?.sequenceId ?? "",
    );
    assert.equal(reservation?.quotaBound, false);
  });

  it("a rails failure on fresh evidence refuses between steps and the stated recovery state survives", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpRotate(rotateDeps(h), POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    // Fresh evidence trips the finalization rail: hold, funds parked.
    const trippedMarket: LpMarketReader = async () => ({
      ...baseMarket(),
      blockNumber: 101n,
      finalizedBlockNumber: 100n,
    });
    const tripped = await runLpRotate(
      { ...rotateDeps(h), market: trippedMarket },
      POSITION_ID,
    );
    assert.equal(tripped.status, "held");
    assert.equal(tripped.code, "OBSERVATION_NOT_FINALIZED");
    assert.equal(h.provider.submitted.length, 1);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
  });
});

/* -------------------------------------------------------------------------- */
/* The brain seam (Rev2 items 27–28)                                          */
/* -------------------------------------------------------------------------- */

describe("lp sagas: brain seam", () => {
  it("a protect+rotate-both-eligible cycle makes ZERO brain calls — structurally", async () => {
    // Both triggers eligible; the deterministic priority picks protect.
    const market = baseMarket();
    const decision = evaluateLpTriggers({
      intervalMs: 30_000,
      market: { ...market, blockNumber: 100n },
      nowMs: NOW_MS,
      position: {
        basisWei: 10n ** 18n,
        basisSource: "owner-budget",
        collectibleFee0: 1n,
        collectibleFee1: 1n,
        currentTick: 2_000, // out of range: rotate-eligible
        exitValueWei: 8n * 10n ** 17n, // 20% below basis: SL-eligible
        freshFeesValueWei: 0n,
        poolAddress: `0x${"99".repeat(20)}`,
        token0: "0x1111111111111111111111111111111111111111",
        token1: "0x2222222222222222222222222222222222222222",
        fee: 2500,
        tickLower: -1_000,
        tickUpper: 1_000,
        tokenId: "42",
      },
      previousObservation: {
        blockNumber: 99n,
        evaluatedAtMs: NOW_MS - 60_000,
        poolAddress: `0x${"99".repeat(20)}`,
        protectBreach: "stop-loss",
        protectConsecutive: 1,
        rotationBreach: true,
        rotationBreachStartedAtMs: NOW_MS - 120_000,
        rotationConsecutive: 1,
        tokenId: "42",
      },
      rails: RAILS,
      settings: {
        ...DEFAULT_LP_SETTINGS,
        autoRotate: true,
        stopLossPct: 10,
      },
    });
    assert.equal(decision.decision, "protect-stop-loss");

    // Dispatch the winning decision. The protect construction takes the
    // brain-free deps type: `proposeRange` does not exist on it, so the spy
    // can only ever be wired into a rotate — which the cycle did not choose.
    const h = await createLpHarness();
    let brainCalls = 0;
    const throwingSpy = async (): Promise<unknown> => {
      brainCalls += 1;
      throw new Error("the brain must never be consulted on this cycle");
    };
    // Available to rotate, deliberately built and left unused:
    void rotateDeps(h, throwingSpy);
    assert.equal("proposeRange" in h.deps, false, "protect deps carry no brain seam");

    scriptExit(h);
    const result = await runLpProtect(h.deps, POSITION_ID);
    assert.equal(result.status, "completed");
    assert.equal(brainCalls, 0, "zero brain transport calls on a protect cycle");
  });

  it("a fenced-out rotate proposal falls back to the deterministic centered range", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    let brainCalls = 0;
    const result = await runLpRotate(
      rotateDeps(h, async () => {
        brainCalls += 1;
        // Unsnapped ticks + a smuggled budget field: fence failure.
        return { tickLower: -1_003, tickUpper: 997, budgetWei: "1" };
      }),
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    assert.ok(brainCalls >= 1);
    // The mint used the deterministic fallback range [-1000, 1000).
    const mintCall = h.provider.submitted[2]?.calls[2];
    const negThousand = (1n << 256n) - 1_000n;
    assert.ok(mintCall?.data?.includes(word(negThousand)));
    assert.ok(mintCall?.data?.includes(word(1_000n)));
  });

  it("an accepted rotate proposal controls the submitted mint ticks", async () => {
    const h = await createLpHarness();
    scriptRotate(h, "42", { tickLower: -1_500, tickUpper: 1_500 });
    const result = await runLpRotate(
      rotateDeps(h, async () => ({ tickLower: -1_500, tickUpper: 1_500 })),
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    const mintCall = h.provider.submitted[2]?.calls[2];
    assert.ok(mintCall?.data?.includes(word((1n << 256n) - 1_500n)));
    assert.ok(mintCall?.data?.includes(word(1_500n)));
  });

  it("an unreachable brain never blocks a triggered rotate", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    const result = await runLpRotate(
      rotateDeps(h, async () => {
        throw new Error("brain transport down");
      }),
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
  });

  it("an accepted holdInstead parks the in-flight rotate at pending-mint", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    h.marketState.failAfterReads = 1; // zap-out confirms, then crash
    await assert.rejects(() => runLpRotate(rotateDeps(h), POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    const result = await runLpRotate(
      rotateDeps(h, async () => ({ holdInstead: true })),
      POSITION_ID,
    );
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
    assert.equal(h.provider.submitted.length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The open saga shares the A1 window                                         */
/* -------------------------------------------------------------------------- */

describe("lp open: crash between appendStep and begin (audit A1)", () => {
  it("an orphaned open step (row never created) is retried fresh, never held", async () => {
    // `runLpOpen` has the identical appendStep→begin ordering, so the same
    // crash leaves the same provably-unsubmitted orphan; its join must make
    // the same missing-row-⇒-open-slot decision the saga driver makes.
    const h = await createLpHarness({ tokenId: null });
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "open",
    });
    const orphanKey = executeIdempotencyKey(
      AGENT_ID,
      lpStepDecisionId(sequence.sequenceId, 0),
      hashCalls([{ to: NFPM }]),
    );
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "zap-in-mint",
      journalIdempotencyKey: orphanKey,
    });
    // NO journal.begin — the crash.

    h.provider.script.push((_params, txHash) => {
      h.receipts.mintByTx.set(txHash, 43n);
      h.positions.set("43", { liquidity: LIQ, tickLower: -1_000, tickUpper: 1_000 });
      return confirmed(txHash);
    });
    const result = await runLpOpen(h.deps, {
      mode: "two-sided-in-range", kind: "open",
      positionId: POSITION_ID,
      budgetWei: 10n ** 15n,
      tickLower: -1_000,
      tickUpper: 1_000,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.tokenId, "43");
    assert.equal(h.provider.submitted.length, 1);
    assert.equal(
      await h.journal.get(orphanKey),
      null,
      "no row may ever be created for the orphan key",
    );
    const after = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(after[0]?.state, "completed");
    assert.equal(after[0]?.steps.length, 2, "the retry is a fresh step record");
    const retryRow = await h.journal.get(after[0]?.steps[1]?.journalIdempotencyKey ?? "");
    assert.equal(retryRow?.begunAtBlock, 100n, "open persists its finalized lower bound");
    const keys = await recordedKeys(h);
    assert.equal(new Set(keys).size, keys.length);
    const position = await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID);
    assert.equal(position?.tokenId, "43");
  });
});

describe("Phase 3.9c F1 — PostgreSQL agent facts reach the staged LP adapter", () => {
  it("survives recursive JSONB reordering through PostgresAgentStore -> runLpOpen -> PortoStagedLpAdapter", async () => {
    const h = await createLpHarness({ tokenId: null });
    h.clock.ms = Date.now();
    const sql = new FakeSqlClient();
    const agentStore = await PostgresAgentStore.create(sql, Buffer.alloc(32, 7), () => h.clock.ms);
    const sessionAccount = privateKeyToAccount(SESSION_KEY);
    const spec = {
      allowedCalls: [{ to: NFPM, selector: "balanceOf(address)" }],
      spendCaps: [{ limit: 10n ** 18n, period: "day" as const }],
      expiresAt: Math.floor(h.clock.ms / 1_000) + 3_600,
    };
    const permissions = validateSessionSpec(spec, { minSessionSeconds: 0 });
    await agentStore.createAgent({
      id: AGENT_ID, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa",
      sessionFacts: { spec, permissions,
        publicKey: sessionAccount.publicKey, expiry: spec.expiresAt },
      caps: { dailyNativeWei: 10n ** 18n }, status: "armed",
    });
    await agentStore.putAgentSessionKey(OWNER, AGENT_ID, SESSION_KEY);
    const restored = await agentStore.getAgent(OWNER, AGENT_ID);
    assert.ok(restored);
    assert.notDeepEqual(Object.keys(restored.sessionFacts?.permissions.calls[0] ?? {}),
      Object.keys(permissions.calls[0] ?? {}),
      "the FakeSql JSONB seam must actually reorder the nested descriptor");

    const order: string[] = [];
    const adapter = new PortoStagedLpAdapter({ network: BNB,
      transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
      functions: {
        prepare: (async (...[_client, request]: Parameters<typeof prepareCalls>) => {
          order.push("prepare");
          return {
            capabilities: { quote: { quotes: [{ chainId: 56,
              orchestrator: PORTO_V055_ORCHESTRATOR,
              intent: { eoa: request.account, executionData: encodeLpFinalCallsV1(
                (request.calls ?? []) as readonly WalletCall[],
              ),
                nonce: 1n, expiry: BigInt(spec.expiresAt) } }] } },
            context: {}, digest: `0x${"12".repeat(32)}` as Hex, key: request.key, typedData: {},
          } as unknown as Awaited<ReturnType<typeof prepareCalls>>;
        }) as typeof prepareCalls,
        sign: (async () => {
          order.push("sign");
          return `0x${"13".repeat(65)}` as Hex;
        }) as typeof signCalls,
        send: (async () => {
          order.push("send");
          return { id: `0x${"14".repeat(32)}` as Hex };
        }) as typeof sendPreparedCalls,
      }, submitTimeoutMs: 1_000 });
    const stagedProvider = h.provider as typeof h.provider & {
      submitPreparedLp: PortoStagedLpAdapter["submit"];
    };
    stagedProvider.submitPreparedLp = async (input) => adapter.submit(input);
    const result = await runLpOpen({ ...h.deps, agent: restored, agentStore,
      provider: stagedProvider }, {
      mode: "two-sided-in-range", kind: "open",
      positionId: POSITION_ID, budgetWei: 10n ** 15n, tickLower: -1_000, tickUpper: 1_000,
    });
    assert.equal(result.status, "held");
    assert.deepEqual(order, ["prepare", "sign", "send"]);
    const sequence = (await h.store.listSequences(OWNER, AGENT_ID))[0];
    const step = sequence?.steps[0];
    assert.ok(step);
    assert.notEqual((await h.journal.get(step.journalIdempotencyKey))?.preparedIntentIdentity, null);
  });
});

describe("Phase 3.9c F2 — the staged boundary survives the shared LP callers", () => {
  it("classifies every adapter boundary through runLpOpen, and never replays UNKNOWN", async () => {
    const cases: readonly {
      readonly failure: StagedFailure;
      readonly status: "rolled-back" | "held";
      readonly journalState: "ROLLED_BACK" | "UNKNOWN";
      readonly order: readonly string[];
    }[] = [
      { failure: "validation", status: "rolled-back", journalState: "ROLLED_BACK", order: [] },
      { failure: "prepare", status: "rolled-back", journalState: "ROLLED_BACK", order: ["prepare"] },
      { failure: "prepare-timeout", status: "rolled-back", journalState: "ROLLED_BACK", order: ["prepare"] },
      { failure: "prepared", status: "rolled-back", journalState: "ROLLED_BACK", order: ["prepare"] },
      { failure: "binder-throws", status: "held", journalState: "UNKNOWN", order: ["prepare", "bind"] },
      { failure: "malformed-bind", status: "held", journalState: "UNKNOWN", order: ["prepare", "bind"] },
      { failure: "abort", status: "held", journalState: "UNKNOWN", order: ["prepare", "bind"] },
      { failure: "sign", status: "held", journalState: "UNKNOWN", order: ["prepare", "bind", "sign"] },
      { failure: "send", status: "held", journalState: "UNKNOWN", order: ["prepare", "bind", "sign", "send"] },
    ];
    for (const testCase of cases) {
      const h = await createLpHarness({ tokenId: null });
      h.clock.ms = Date.now();
      const staged = stagedFailureDeps(h, testCase.failure);
      const result = await runLpOpen(staged.deps, {
        mode: "two-sided-in-range", kind: "open",
        positionId: POSITION_ID, budgetWei: 10n ** 15n, tickLower: -1_000, tickUpper: 1_000,
      });
      assert.equal(result.status, testCase.status, testCase.failure);
      assert.deepEqual(staged.order, testCase.order, testCase.failure);
      assert.equal(h.provider.submitted.length, 0, "the legacy submit seam is never used");
      const sequence = (await h.store.listSequences(OWNER, AGENT_ID))[0];
      const step = sequence?.steps[0];
      assert.ok(step, testCase.failure);
      assert.equal((await h.journal.get(step.journalIdempotencyKey))?.state,
        testCase.journalState, testCase.failure);
      assert.equal((await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID))?.state,
        testCase.status === "rolled-back" ? "closed" : "open", testCase.failure);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, sequence?.sequenceId ?? "");
      assert.equal(reservation?.releasedAt === null, testCase.status === "held", testCase.failure);
      if (testCase.status === "held") {
        const retry = await runLpOpen(staged.deps, {
          mode: "two-sided-in-range", kind: "open",
          positionId: POSITION_ID, budgetWei: 10n ** 15n, tickLower: -1_000, tickUpper: 1_000,
        });
        assert.equal(retry.status, "held", `${testCase.failure} must not auto-replay`);
        assert.deepEqual(staged.order, testCase.order, `${testCase.failure} must not re-enter adapter`);
      }
    }
  });

  it("uses the same complete matrix in a multi-step saga: only pre-bind releases", async () => {
    for (const testCase of [
      { failure: "validation" as const, status: "rolled-back" as const, journalState: "ROLLED_BACK" as const, order: [] },
      { failure: "prepare" as const, status: "rolled-back" as const, journalState: "ROLLED_BACK" as const, order: ["prepare"] },
      { failure: "prepare-timeout" as const, status: "rolled-back" as const, journalState: "ROLLED_BACK" as const, order: ["prepare"] },
      { failure: "prepared" as const, status: "rolled-back" as const, journalState: "ROLLED_BACK" as const, order: ["prepare"] },
      { failure: "binder-throws" as const, status: "held" as const, journalState: "UNKNOWN" as const, order: ["prepare", "bind"] },
      { failure: "malformed-bind" as const, status: "held" as const, journalState: "UNKNOWN" as const, order: ["prepare", "bind"] },
      { failure: "abort" as const, status: "held" as const, journalState: "UNKNOWN" as const, order: ["prepare", "bind"] },
      { failure: "sign" as const, status: "held" as const, journalState: "UNKNOWN" as const, order: ["prepare", "bind", "sign"] },
      { failure: "send" as const, status: "held" as const, journalState: "UNKNOWN" as const, order: ["prepare", "bind", "sign", "send"] },
    ]) {
      const h = await createLpHarness();
      h.clock.ms = Date.now();
      const staged = stagedFailureDeps(h, testCase.failure);
      const result = await runLpHarvest(staged.deps, POSITION_ID);
      assert.equal(result.status, testCase.status, testCase.failure);
      assert.deepEqual(staged.order, testCase.order, testCase.failure);
      assert.equal(h.provider.submitted.length, 0, `${testCase.failure}: legacy submit must stay unused`);
      const sequence = (await h.store.listSequences(OWNER, AGENT_ID))[0];
      const step = sequence?.steps[0];
      assert.ok(step, testCase.failure);
      assert.equal((await h.journal.get(step.journalIdempotencyKey))?.state,
        testCase.journalState, testCase.failure);
      assert.equal((await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID))?.state, "open",
        `${testCase.failure}: a failed harvest must not mutate the LP position`);
      const reservation = await h.store.getReservation(OWNER, AGENT_ID, sequence?.sequenceId ?? "");
      assert.equal(reservation?.releasedAt === null, testCase.status === "held", testCase.failure);
      if (testCase.status === "held") {
        const retry = await runLpHarvest(staged.deps, POSITION_ID);
        assert.equal(retry.status, "held");
        assert.deepEqual(staged.order, testCase.order, `${testCase.failure} must not re-enter the adapter`);
      }
    }
  });

  /**
   * FIXREVIEW7 F4. Both pre-bind rollback sites once overwrote the underlying
   * error with the bare family name, and the 2026-08-21 live failure's cause
   * was therefore never recorded — hours of re-derivation. Nothing pinned the
   * repair: reverting both sites to the bare literal left the whole suite
   * green. `STAGED_PRE_BIND.` must survive (`lpReservationReleasable` and the
   * operator both read the family), and so must the cause.
   *
   * The two sites are textually identical, so one case per site is enough:
   * `runLpOpen` exercises `open.ts`, `runLpHarvest` exercises `sagas.ts`.
   */
  it("journals BOTH the pre-bind family name AND the underlying cause, at both sites", async () => {
    for (const site of ["open", "saga"] as const) {
      const h = await createLpHarness(site === "open" ? { tokenId: null } : {});
      h.clock.ms = Date.now();
      const staged = stagedFailureDeps(h, "prepare");
      const result = site === "open"
        ? await runLpOpen(staged.deps, {
          mode: "two-sided-in-range", kind: "open",
          positionId: POSITION_ID, budgetWei: 10n ** 15n, tickLower: -1_000, tickUpper: 1_000,
        })
        : await runLpHarvest(staged.deps, POSITION_ID);
      assert.equal(result.status, "rolled-back", site);
      const step = (await h.store.listSequences(OWNER, AGENT_ID))[0]?.steps[0];
      assert.ok(step, site);
      const row = await h.journal.get(step.journalIdempotencyKey);
      assert.equal(row?.state, "ROLLED_BACK", site);
      const lastError = row?.lastError ?? "";
      assert.ok(lastError.startsWith("Refused before submission: STAGED_PRE_BIND."),
        `${site}: the family name must stay first, got ${JSON.stringify(lastError)}`);
      assert.ok(lastError.includes("injected prepare failure"),
        `${site}: the cause must survive the rollback, got ${JSON.stringify(lastError)}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.5 — the release wiring, end to end (audit A1/A2)                    */
/* -------------------------------------------------------------------------- */

describe("lp quota release: the wiring above the store (PHASE3.5)", () => {
  /** How many in-window reservations still COUNT against the daily limit. */
  async function liveSlots(h: Harness): Promise<number> {
    return (await h.store.quotaUsage(OWNER, AGENT_ID)).liveCount;
  }

  it("a rotate refused under pause GIVES THE SLOT BACK", async () => {
    // The whole point of the phase, and the direction nothing pinned before:
    // a sequence that reserved, refused above the submit, and rolled back
    // spent no gas, so it must not consume a day's automation budget.
    const h = await createLpHarness();
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);

    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(result.code, "AGENT_PAUSED");
    assert.equal(h.provider.submitted.length, 0, "nothing reached a relay");

    const reservation = await h.store.getReservation(
      OWNER,
      AGENT_ID,
      result.sequenceId,
    );
    assert.notEqual(reservation, null, "the row is kept for the audit trail");
    assert.notEqual(
      reservation?.releasedAt,
      null,
      "…and released, so it no longer counts",
    );
    assert.equal(await liveSlots(h), 0);
  });

  it("and the freed slot is REALLY free: the next rotate is admitted at the limit", async () => {
    // A count-only assertion could pass against a store that reports one thing
    // and enforces another. This drives the enforcement.
    const h = await createLpHarness({
      quota: { maxExitSequencesPerDay: 1, minMinutesBetweenExits: 0 },
    });
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const refused = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(refused.status, "rolled-back");

    await h.killswitch.unpauseAgent(AGENT_ID, OWNER);
    scriptRotate(h);
    const second = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(
      second.status,
      "completed",
      "the released slot must be usable, not merely reported",
    );
  });

  it("a COMPLETED rotate does NOT release — the M2 stale-evidence regression", async () => {
    // The join's `rows` map is fetched before any step runs, so for a sequence
    // whose steps all commit in this run it is EMPTY. Reading that as "no
    // steps" would release, freeing a slot on every successful sequence and
    // silently doubling the quota.
    const h = await createLpHarness();
    scriptRotate(h);
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "completed");

    const reservation = await h.store.getReservation(
      OWNER,
      AGENT_ID,
      result.sequenceId,
    );
    assert.equal(
      reservation?.releasedAt,
      null,
      "a sequence that committed steps spent gas and keeps its slot",
    );
    assert.equal(await liveSlots(h), 1);
  });

  it("an open refused before any submit releases too (M4: runLpOpen is its own site)", async () => {
    // `runLpOpen` reserves and terminalises without ever entering
    // `driveSequence`, and a terminal sequence never re-drives — so a release
    // missed here is missed until the 24h window ages the row out.
    const h = await createLpHarness({ tokenId: null });
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const result = await runLpOpen(h.deps, {
      mode: "two-sided-in-range", kind: "open",
      positionId: POSITION_ID,
      budgetWei: 10n ** 15n,
      tickLower: -1_000,
      tickUpper: 1_000,
    });
    assert.equal(result.status, "rolled-back");
    assert.equal(h.provider.submitted.length, 0);

    const reservation = await h.store.getReservation(
      OWNER,
      AGENT_ID,
      result.sequenceId,
    );
    assert.notEqual(reservation?.releasedAt, null);
    assert.equal(await liveSlots(h), 0);
  });

  it("a RESUMED rollback holds the slot on the RE-READ alone (fixreview N1)", async () => {
    // The hole the fix review measured: deleting the release call outright
    // passed the whole suite, because nothing drove the one trace where the
    // run-local flag is USELESS.
    //
    // A first process submitted a step — its journal row carries a `callsId`,
    // so gas was drawn — and rolled it back. A SECOND process resumes and
    // rolls the sequence back for its own reason. In that second run
    // `submittedThisRun` is false and `confirmedMoney` is 0, so the flag says
    // "releasable"; only the fresh re-read of the step rows can see the prior
    // run's `callsId` and hold. If the re-read ever stopped happening, this is
    // the trace that would silently free a gas-drawing slot — the M1 violation
    // the phase exists to prevent.
    const h = await createLpHarness();
    const sequence = await h.store.createSequence({
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      positionId: POSITION_ID,
      kind: "rotate",
    });
    await h.store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, QUOTA);

    // The PRIOR run's evidence: a step that reached the relay and failed.
    const key = "prior-run-step-key";
    await h.store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
      kind: "zap-out",
      journalIdempotencyKey: key,
    });
    await h.journal.beginWithSpend(
      {
        idempotencyKey: key,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        kind: "lp",
      },
      0,
    );
    await h.journal.markInProgress(key, { callsId: `0x${"ab".repeat(32)}` });
    await h.journal.markRolledBack(key, "the relay reported FAILED");

    // This run submits nothing and rolls back.
    await h.killswitch.pauseAgent(AGENT_ID, OWNER);
    const result = await runLpRotate(rotateDeps(h), POSITION_ID);
    assert.equal(result.status, "rolled-back");
    assert.equal(h.provider.submitted.length, 0, "this run reached no relay");

    const reservation = await h.store.getReservation(
      OWNER,
      AGENT_ID,
      sequence.sequenceId,
    );
    assert.equal(
      reservation?.releasedAt,
      null,
      "the prior run's callsId must hold the slot: gas was drawn, and only the re-read can see it",
    );
    assert.equal(
      (await h.store.quotaUsage(OWNER, AGENT_ID)).liveCount,
      1,
      "the slot still counts against the daily limit",
    );
  });

  it("a THROWING release leaves the saga result unchanged (M8, both sites)", async () => {
    // Derived state: it explains, it never decides. A cleanup that made this
    // throw would otherwise turn a clean refusal into a failure on a money
    // path.
    for (const drive of ["rotate", "open"] as const) {
      const h = await createLpHarness(drive === "open" ? { tokenId: null } : {});
      await h.killswitch.pauseAgent(AGENT_ID, OWNER);
      (h.store as unknown as {
        releaseReservation: () => Promise<void>;
      }).releaseReservation = async () => {
        throw new Error("store is down");
      };

      const result =
        drive === "rotate"
          ? await runLpRotate(rotateDeps(h), POSITION_ID)
          : await runLpOpen(h.deps, {
              mode: "two-sided-in-range", kind: "open",
              positionId: POSITION_ID,
              budgetWei: 10n ** 15n,
              tickLower: -1_000,
              tickUpper: 1_000,
            });
      assert.equal(result.status, "rolled-back", `${drive}: status survives`);
      assert.equal(result.code, "AGENT_PAUSED", `${drive}: code survives`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.11 R-D: the RESUME advances the recovery marker                     */
/* -------------------------------------------------------------------------- */

/**
 * The live incident, reproduced from PERSISTED state with NO crash simulation.
 *
 * The collect was mined 2.5 minutes after a 45 s submit timeout, so it came
 * back PENDING in-process and the sequence held with its marker unwritten;
 * `reconcile` then settled the row out of process. While the process was blind
 * the price left the range, so the sweep converts the WHOLE collected leg and
 * the compounding increase can never see both legs positive again.
 *
 * Returns the harness parked exactly as the live row was found:
 * `state=active`, `recovery_state=none`, step 0 settled COMMITTED.
 */
async function outOfRangeHarvestIncident(): Promise<Harness> {
  const h = await createLpHarness();
  const pendingTx = txAt(0);
  h.provider.script.push(() => ({
    status: "PENDING",
    callsId: `0x${"c3".repeat(32)}` as Hex,
  }));
  const first = await runLpHarvest(h.deps, POSITION_ID);
  assert.equal(first.status, "held");
  assert.equal(first.code, "HELD_AMBIGUOUS");
  const parked = await h.store.listSequences(OWNER, AGENT_ID);
  assert.equal(parked[0]?.state, "active", "the incident row: no marker was written");
  assert.equal(parked[0]?.recoveryState, "none");

  h.provider.awaitResult = { status: "CONFIRMED", transactionHash: pendingTx };
  h.receipts.collectByTx.set(pendingTx, {
    amount0Wei: 0n,
    amount1Wei: HARVEST_FEE_WBNB,
  });
  const summary = await reconcile({
    minRowAgeMs: 0,
    provider: h.provider,
    journal: h.journal,
    resolveWallet: async () => null,
  });
  assert.equal(summary.committed, 1, "reconcile settled the collect out of process");

  // Out of range: the sweep sells the entire collected leg.
  h.provider.script.push((_params, txHash) => {
    h.receipts.swapByTx.set(txHash, {
      tokenIn: WBNB,
      amountInWei: HARVEST_FEE_WBNB,
      tokenOut: TOKEN,
      amountOutWei: 4_950_000_000_000n,
    });
    return confirmed(txHash);
  });
  return h;
}

/** Step 0 confirmed live; step 1's submit died UNKNOWN. Case (c)'s shape. */
async function harvestWithUnknownSweep(): Promise<Harness> {
  const h = await createLpHarness();
  h.provider.script.push((_params, txHash) => {
    h.receipts.collectByTx.set(txHash, {
      amount0Wei: 0n,
      amount1Wei: HARVEST_FEE_WBNB,
    });
    return confirmed(txHash);
  });
  // The sweep's submit is unscripted, so it throws: an UNKNOWN row.
  const first = await runLpHarvest(h.deps, POSITION_ID);
  assert.equal(first.code, "HELD_AMBIGUOUS");
  return h;
}

/** Put the row back into the shape D2 leaves behind: `active` + `none`. */
async function forceIncidentRow(h: Harness): Promise<void> {
  const sequences = await h.store.listSequences(OWNER, AGENT_ID);
  const sequenceId = sequences[0]?.sequenceId ?? "";
  if (sequences[0]?.state === "held") {
    await h.store.setSequenceState(OWNER, AGENT_ID, sequenceId, "active");
  }
  await h.store.setRecoveryState(OWNER, AGENT_ID, sequenceId, "none");
  h.store.recoveryWrites.length = 0;
}

describe("PHASE3.11 R-D: the resume advances the recovery marker from the plan", () => {
  it("B1: the reconcile-then-replay path ends HELD + the sweep's declared recovery", async () => {
    const h = await outOfRangeHarvestIncident();
    h.store.recoveryWrites.length = 0;

    const resumed = await runLpHarvest(h.deps, POSITION_ID);

    assert.equal(resumed.status, "held");
    assert.equal(resumed.code, "BUILD_REFUSED");
    assert.match(resumed.reason, /both legs positive/);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(
      sequences[0]?.state,
      "held",
      "the whole point: `active`+`none` is the un-abandonable trap",
    );
    assert.equal(sequences[0]?.recoveryState, "wbnb-stranded");
    assert.deepEqual(
      h.store.recoveryWrites,
      ["pending-increase", "wbnb-stranded"],
      "the REPLAYED step 0 is marked first, from the plan's own declaration",
    );
    // Non-terminal, so the worker still owes it a resume — and the position
    // stays open, because a harvest never removed principal.
    assert.deepEqual(await workerQueue(h), { sequences: 1, positions: 1 });
  });

  it("B2: the marker is written BEFORE the replayed `after` — a POST_VERIFY_FAILED lands NAMED", async () => {
    const h = await outOfRangeHarvestIncident();
    h.store.recoveryWrites.length = 0;
    // FINDINGS (ad): a pinned endpoint refuses `getTransactionReceipt` on the
    // replay. `collectAmounts` throws, and step 0's `after` with it.
    h.receipts.collectByTx.clear();

    const resumed = await runLpHarvest(h.deps, POSITION_ID);

    assert.equal(resumed.status, "held");
    assert.equal(resumed.code, "POST_VERIFY_FAILED");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "held");
    assert.equal(sequences[0]?.recoveryState, "pending-increase");
    assert.deepEqual(h.store.recoveryWrites, ["pending-increase"]);
  });

  it("B3: a confirmed PREFIX is marked before the pre-replay hold (case (c))", async () => {
    const h = await harvestWithUnknownSweep();
    await forceIncidentRow(h);

    const resumed = await runLpHarvest(h.deps, POSITION_ID);

    assert.equal(resumed.status, "held");
    assert.equal(resumed.code, "HELD_AMBIGUOUS");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "held", "the lp-live-2 shape, no longer active+none");
    assert.equal(sequences[0]?.recoveryState, "pending-increase");
    assert.deepEqual(h.store.recoveryWrites, ["pending-increase"]);
  });

  it("B4: a resume that finds the right marker writes NOTHING", async () => {
    const h = await harvestWithUnknownSweep();
    const parked = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(parked[0]?.recoveryState, "pending-increase", "written by the live path");
    h.store.recoveryWrites.length = 0;

    const resumed = await runLpHarvest(h.deps, POSITION_ID);

    assert.equal(resumed.code, "HELD_AMBIGUOUS");
    assert.deepEqual(h.store.recoveryWrites, [], "the `!==` guard: no spurious write");
  });

  it("B4: a fully confirming resume completes with exactly the writes the live path makes", async () => {
    const h = await createLpHarness();
    scriptHarvest(h);
    h.marketState.failAfterReads = 1;
    await assert.rejects(() => runLpHarvest(h.deps, POSITION_ID), /market reader died/);
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;
    h.store.recoveryWrites.length = 0;

    const result = await runLpHarvest(h.deps, POSITION_ID);

    assert.equal(result.status, "completed");
    assert.deepEqual(
      h.store.recoveryWrites,
      ["wbnb-stranded", "none"],
      "the replayed step 0 already matched; only the LIVE steps wrote",
    );
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "completed");
    assert.equal(sequences[0]?.recoveryState, "none");
  });

  it("B9: a resolver fence on the marker write ABORTS the resume instead of failing it", async () => {
    const h = await outOfRangeHarvestIncident();
    const submitsBefore = h.provider.submitted.length;
    h.store.fenceRecoveryWrites = true;

    const resumed = await runLpHarvest(h.deps, POSITION_ID);

    assert.equal(resumed.status, "held");
    assert.equal(resumed.code, "SEQUENCE_FENCED");
    assert.equal(h.provider.submitted.length, submitsBefore, "a fenced resume submits nothing");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "active", "the resolver's row is left exactly as it was");
    assert.equal(sequences[0]?.recoveryState, "none");
  });
});

describe("PHASE3.11 F2: an exit saga can reach HELD", () => {
  it("B8: a protect whose optional sweep holds parks HELD + wbnb-stranded", async () => {
    const h = await createLpHarness();
    h.quoteResult = EXIT_QUOTE_OUT;
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, {
        amount0Wei: EXIT_FREED_TOKEN,
        amount1Wei: FREED_WBNB,
      });
      return confirmed(txHash);
    });
    // The sweep's receipt is PENDING: the documented normal outcome of a slow
    // relay, and the one that used to trap the position for ever.
    h.provider.script.push(() => ({
      status: "PENDING",
      callsId: `0x${"c4".repeat(32)}` as Hex,
    }));

    const result = await runLpProtect(h.deps, POSITION_ID);

    assert.equal(result.status, "held");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(
      sequences[0]?.state,
      "held",
      "the stop-loss is the one saga that must never be trapped",
    );
    assert.equal(sequences[0]?.recoveryState, "wbnb-stranded");
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.13 — the swapless rotate mode                                       */
/* -------------------------------------------------------------------------- */

/**
 * The price has left the prior range [-1000, 1000) UPWARD, so the freed
 * principal is token1 and the new range must sit at or below the tick.
 * Everything below is measured at this tick, with the TWAP equal to spot so no
 * rail can be the thing that refused.
 */
const SWAPLESS_TICK = 2_000;

function swaplessMarket(currentTick = SWAPLESS_TICK): LpMarketReader {
  const spot = getSqrtRatioAtTick(currentTick);
  return async () => ({
    ...baseMarket(),
    currentTick,
    spotSqrtPriceX96: spot,
    twapSqrtPriceX96: spot,
  });
}

/**
 * A swapless rotate submits TWO calls, not three: zap-out then mint. The
 * middle script entry of `scriptRotate` is a SWAP receipt, and using it here
 * would let a mint consume it and then fail looking for a minted tokenId —
 * i.e. the fixture itself would hide a wrongly-submitted sweep. This one
 * cannot: if a sweep submits, the mint gets the mint script and the assertion
 * on `submitted.length` fires first.
 */
function scriptSwaplessRotate(
  h: Harness,
  collected: { amount0Wei: bigint; amount1Wei: bigint },
): void {
  h.provider.script.push((_params, txHash) => {
    h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
    h.receipts.collectByTx.set(txHash, collected);
    return confirmed(txHash);
  });
  h.provider.script.push((_params, txHash) => {
    h.receipts.mintByTx.set(txHash, 43n);
    h.positions.set("43", { liquidity: LIQ, tickLower: 0, tickUpper: 2_000 });
    return confirmed(txHash);
  });
}

/** Residue small enough to strand: ~10 bps of the freed value at tick 2000. */
const SWAPLESS_DUST = FREED_WBNB / 1_200n;

describe("PHASE3.13 B14/B16: the swapless rotate parks, submits no sweep, and says so", () => {
  it("skips the sweep with ZERO submissions for it and mints single-sided into the adjacent range", async () => {
    const h = await createLpHarness();
    scriptSwaplessRotate(h, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket() },
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.confirmedSteps, 3, "three plan positions, one of them a SKIP");
    // The assertion the review asked for: SUBMITTED CALLS, not plan length.
    assert.equal(h.provider.submitted.length, 2, "zap-out and mint only — no sweep");
    assertNoDuplicateSubmits(h);

    // The recorded plan is still the invariant three kinds, so a resume across
    // a mode flip cannot hit PLAN_MISMATCH.
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.deepEqual(
      sequences[0]?.steps.map((step) => step.kind),
      ["zap-out", "sweep-token", "zap-in-mint"],
    );

    // The mint parked at [0, 2000): floorTick(2000, 50) = 2000, width 2000.
    const mintCall = h.provider.submitted[1]?.calls[2];
    assert.ok(mintCall?.data?.includes(word(0n)));
    assert.ok(mintCall?.data?.includes(word(2_000n)));
    // Single-sided: WBNB is token1 in this pool, so token0's approve is zero.
    const tokenApprove = h.provider.submitted[1]?.calls[1];
    assert.ok(tokenApprove?.data?.endsWith(word(0n)), "the dropped leg is approved for ZERO");

    // B16 (F3): the skip's reason is PERSISTED and names the residue.
    const note = sequences[0]?.note ?? "";
    assert.match(note, /sweep-token skipped/u);
    assert.match(note, /Swapless rotate/u);
    assert.match(note, /NO conversion made/u);
    assert.match(note, /\[0, 2000\)/u);
    assert.match(note, /residue 0 wei/u, "the residue AMOUNT, not merely its existence");
    assert.match(note, /no fees, auto-harvest inert/u);
    // The 280-character `sanitizeMessage` ceiling is why the residue and the
    // placement LEAD and the derivable evidence trails: at real BNB magnitudes
    // the tail is what is lost, never the disclosure.
    assert.ok(note.length <= 280);
  });

  it("carries the residue amount into the persisted note when there IS one", async () => {
    const h = await createLpHarness();
    scriptSwaplessRotate(h, { amount0Wei: SWAPLESS_DUST, amount1Wei: FREED_WBNB });
    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket() },
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 2);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.match(sequences[0]?.note ?? "", new RegExp(`${SWAPLESS_DUST} wei`, "u"));
    assert.match(sequences[0]?.note ?? "", /wei \(\d+ bps\)/u);
  });

  it("SWEEPS as today when the off-side leg is ABOVE the bound (B14's other branch)", async () => {
    const h = await createLpHarness();
    // A 50/50 freed principal at a tick outside the prior range: a side exists,
    // but stranding half the position is exactly what the bound forbids.
    const half = FREED_WBNB / 2n;
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, { amount0Wei: half, amount1Wei: half });
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => {
      // LP-ROTATE-MINT-FLOORS: the sweep's receipt must leave the legs
      // BALANCED for the centred re-mint at tick 2000 (price ≈ 1.2214, range
      // [1000, 3000)), or the mint floors now refuse the undeployed share
      // (`MAX_MINT_UNDEPLOYED_BPS`). A 1:3 split left ~42% in the wallet.
      // token0 = half − half/11 ≈ 0.909·half, token1 = half + half/9 ≈ 1.111·half.
      h.receipts.swapByTx.set(txHash, {
        tokenIn: TOKEN,
        amountInWei: half / 11n,
        tokenOut: WBNB,
        amountOutWei: half / 9n,
      });
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => {
      h.receipts.mintByTx.set(txHash, 43n);
      h.positions.set("43", { liquidity: LIQ, tickLower: 0, tickUpper: 2_000 });
      return confirmed(txHash);
    });

    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket() },
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 3, "the sweep SUBMITS above the bound");
  });

  /**
   * LP-ROTATE-MINT-FLOORS. When the mint's floor derivation refuses — here
   * the sweep's receipt left the legs 1:3, which the undeployed bound rejects
   * at the reference price — the rotate parks `held` + `wbnb-stranded` with
   * NOTHING submitted for the mint. The reason reaches the worker log only:
   * review 4 M2 reverted a mandatory-step note (stale after a later success,
   * and it broke the brain hold-instead pin), so the note stays null here.
   */
  it("a mint refused by the floors parks held, submits nothing, and leaves the A5 note alone", async () => {
    const h = await createLpHarness();
    const half = FREED_WBNB / 2n;
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, { amount0Wei: half, amount1Wei: half });
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => {
      h.receipts.swapByTx.set(txHash, {
        tokenIn: TOKEN,
        amountInWei: half / 2n,
        tokenOut: WBNB,
        amountOutWei: half / 2n,
      });
      return confirmed(txHash);
    });
    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket() },
      POSITION_ID,
    );
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /undeployed/u);
    assert.equal(h.provider.submitted.length, 2, "zap-out and sweep confirmed; the mint was never submitted");
    const rows = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(rows[0]?.state, "held");
    assert.equal(rows[0]?.recoveryState, "wbnb-stranded");
    assert.equal(rows[0]?.note, null, "A5 scope: a mandatory-step hold writes no note (review 4 M2)");
  });
});

/**
 * B17 (F4). "If the tick is inside the prior range there is no side, and the
 * residue bound has already forced the swapped shape" — the premise is FALSE.
 * A position resting one tick below its own `tickUpper` is IN RANGE and frees
 * a near single-sided principal, so the bound is SATISFIED. Without the
 * side-exists conjunct the mint would route to `centeredRotationRange` with a
 * one-sided principal, be sized by the dust leg, and strand the rest.
 *
 * This is M6's test.
 */
describe("PHASE3.13 B17 (F4): an in-range near-boundary rotate takes the SWAPPED shape", () => {
  it("sweeps and mints centered even though the freed principal is ~single-sided", async () => {
    const h = await createLpHarness();
    scriptRotate(h);
    // Tick 999: INSIDE [-1000, 1000) by one tick, and the collect frees
    // (almost) everything on the WBNB leg — the shape that satisfies the
    // residue bound while having no side.
    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket(999) },
      POSITION_ID,
    );
    assert.equal(result.status, "completed");
    assert.equal(h.provider.submitted.length, 3, "the sweep RUNS: there is no side");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.doesNotMatch(sequences[0]?.note ?? "", /Swapless rotate/u);
  });
});

/**
 * B10 (inherited) / B18 / F8. A contradiction between what the sweep recorded
 * and what the mint derives from FRESH evidence REFUSES, with the principal
 * safe in the wallet.
 */
describe("PHASE3.13 B10/B18: the mint's bind refuses rather than minting a fraction", () => {
  it("REFUSES when the world moved between the skip and the mint, and holds at pending-mint", async () => {
    const h = await createLpHarness();
    scriptSwaplessRotate(h, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
    // The sweep decides at tick 2000 (side "below", residue 0). Between the
    // steps the price re-enters the prior range, so the mint's own derivation
    // finds NO side — the F8 disagreement.
    let reads = 0;
    const movingMarket: LpMarketReader = async () => {
      reads += 1;
      const tick = reads <= 2 ? SWAPLESS_TICK : 0;
      const spot = getSqrtRatioAtTick(tick);
      return { ...baseMarket(), currentTick: tick, spotSqrtPriceX96: spot, twapSqrtPriceX96: spot };
    };

    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: movingMarket },
      POSITION_ID,
    );
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.equal(h.provider.submitted.length, 1, "the zap-out only — no mint was submitted");

    // The OQ3 builder's four elements, with figures.
    assert.match(result.reason, /Swapless rotate refused at the mint/u);
    assert.match(result.reason, /side none at 0 bps/u);
    assert.match(result.reason, /skip recorded below/u);
    assert.match(result.reason, /Principal SAFE in wallet, held pending-mint/u);
    assert.match(result.reason, /sized by the dust leg/u);
    assert.match(result.reason, /rotateMode "swapped"/u);

    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.equal(sequences[0]?.state, "held");
    assert.equal(sequences[0]?.recoveryState, "pending-mint");
  });

  it("REFUSES at the mint when the residue re-values ABOVE the bound (B20/M5)", async () => {
    const h = await createLpHarness();
    // ~20 bps of residue at tick 2000 — comfortably inside the bound, so the
    // sweep skips. By the mint the price has run to tick 20000, where the same
    // physical dust is worth ~120 bps of the freed value. A "majority" bind
    // would still have passed it and stranded it.
    const dust = (FREED_WBNB * 1637n) / 1_000_000n;
    scriptSwaplessRotate(h, { amount0Wei: dust, amount1Wei: FREED_WBNB });
    let reads = 0;
    const runawayMarket: LpMarketReader = async () => {
      reads += 1;
      const tick = reads <= 2 ? SWAPLESS_TICK : 20_000;
      const spot = getSqrtRatioAtTick(tick);
      return { ...baseMarket(), currentTick: tick, spotSqrtPriceX96: spot, twapSqrtPriceX96: spot };
    };

    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: runawayMarket },
      POSITION_ID,
    );
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.equal(h.provider.submitted.length, 1, "no mint, no sweep — the zap-out only");
    assert.match(result.reason, /Swapless rotate refused at the mint/u);
    assert.match(result.reason, /side below/u);
    // The bind failed on the RESIDUE, and the figure it reports is well under
    // the 5000 bps a majority bind would have allowed.
    const bps = Number(/at (\d+) bps/u.exec(result.reason)?.[1] ?? "0");
    assert.ok(bps > SWAPLESS_MAX_RESIDUE_BPS, `${bps} must exceed the bound`);
    assert.ok(bps < 5_000, `${bps} would have PASSED a majority bind`);
  });

  it("the SWAPPED path keeps its both-legs-positive throw, byte for byte (B18)", async () => {
    const h = await createLpHarness();
    // A rotate under the DEFAULT mode whose sweep skips (the legs already match
    // the target ratio) and whose freed principal is one-sided: the pre-3.13
    // refusal, unchanged.
    h.provider.script.push((_params, txHash) => {
      h.positions.set("42", { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
      h.receipts.collectByTx.set(txHash, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
      return confirmed(txHash);
    });
    h.provider.script.push((_params, txHash) => {
      h.receipts.swapByTx.set(txHash, {
        tokenIn: WBNB,
        amountInWei: FREED_WBNB,
        tokenOut: TOKEN,
        amountOutWei: 0n,
      });
      return confirmed(txHash);
    });
    const result = await runLpRotate(
      { ...rotateDeps(h), market: swaplessMarket() },
      POSITION_ID,
    );
    assert.equal(result.status, "held");
    assert.equal(result.code, "BUILD_REFUSED");
    assert.match(result.reason, /needs both legs positive after the sweep/u);
  });
});

/**
 * B9 (inherited). ONE physical scenario, TWO leg orderings, IDENTICAL physical
 * placement and IDENTICAL stranded leg.
 *
 * This is M4's test. A side decided on `freedTokenWei` vs `freedWbnbWei` is
 * inverted for every pool where `wbnbIsToken0 === true`, which is roughly half
 * of BSC — and the collect's amounts are POOL-ordered, so the same receipt
 * describes the same physical position under both orderings.
 */
describe("PHASE3.13 B9: the same physical placement under both leg orderings", () => {
  async function parkOnce(wbnbIsToken0: boolean): Promise<{
    mintData: string;
    approves: readonly (string | undefined)[];
    note: string;
  }> {
    const h = await createLpHarness({ wbnbIsToken0 });
    scriptSwaplessRotate(h, { amount0Wei: SWAPLESS_DUST, amount1Wei: FREED_WBNB });
    const result = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket() },
      POSITION_ID,
    );
    assert.equal(result.status, "completed", `ordering wbnbIsToken0=${wbnbIsToken0}`);
    assert.equal(h.provider.submitted.length, 2);
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    return {
      mintData: h.provider.submitted[1]?.calls[2]?.data ?? "",
      approves: [
        h.provider.submitted[1]?.calls[0]?.data,
        h.provider.submitted[1]?.calls[1]?.data,
      ],
      note: sequences[0]?.note ?? "",
    };
  }

  it("places the SAME range and strands the SAME leg whichever way the pool sorts", async () => {
    const wbnbSecond = await parkOnce(false);
    const wbnbFirst = await parkOnce(true);

    // Same physical range: [0, 2000).
    for (const run of [wbnbSecond, wbnbFirst]) {
      assert.ok(run.mintData.includes(word(0n)));
      assert.ok(run.mintData.includes(word(2_000n)));
      // Same physical stranded leg: the pool-ordered token0 dust, dropped.
      assert.match(run.note, new RegExp(`${SWAPLESS_DUST} wei`, "u"));
      assert.match(run.note, /re-ranged below the price/u);
    }
    // The approves are ROLE-ordered (WBNB first) by `buildLpMintWbnbBatch`, so
    // the two orderings put the zero on opposite calls — which is precisely why
    // the DECISION must not be role-ordered. The mint payload is identical.
    assert.equal(
      wbnbSecond.mintData.slice(0, 10),
      wbnbFirst.mintData.slice(0, 10),
      "same selector",
    );
    const zeroApprovesSecond = wbnbSecond.approves.filter((data) =>
      data?.endsWith(word(0n)),
    ).length;
    const zeroApprovesFirst = wbnbFirst.approves.filter((data) => data?.endsWith(word(0n))).length;
    assert.equal(zeroApprovesSecond, 1);
    assert.equal(zeroApprovesFirst, 1);
  });
});

/**
 * B21 (OQ2) — LEAVE AND BOUND. The residue is bounded, recorded and disclosed;
 * the lineage `basisWei` is NOT touched.
 *
 * Deducting it has no idempotent seam (`recordSkip` runs once and the replay
 * path's `after` is a no-op), `basisWei: 0n` imported positions have no defined
 * answer, and a basis that chases the loss down is a stop-loss that never
 * fires. This is M15's test.
 */
describe("PHASE3.13 B21 (OQ2): a swapless rotate leaves basisWei byte-identical", () => {
  for (const [label, basisWei] of [
    ["owner-budget", 10n ** 18n],
    ["imported with basisWei 0", 0n],
  ] as const) {
    it(`does not touch the lineage basis (${label})`, async () => {
      const h = await createLpHarness();
      // Re-write the basis for the imported case; the harness creates 1 BNB.
      if (basisWei === 0n) {
        await h.store.createPosition({
          positionId: "pos-imported",
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          token0: TOKEN,
          token1: WBNB,
          fee: 2_500,
          tokenId: "1042",
          basisWei: 0n,
        });
      }
      const positionId = basisWei === 0n ? "pos-imported" : POSITION_ID;
      const tokenId = basisWei === 0n ? "1042" : "42";
      const before = await h.store.getPosition(OWNER, AGENT_ID, positionId);
      assert.equal(before?.basisWei, basisWei);

      h.provider.script.push((_params, txHash) => {
        h.positions.set(tokenId, { liquidity: 0n, tickLower: -1_000, tickUpper: 1_000 });
        h.receipts.collectByTx.set(txHash, {
          amount0Wei: SWAPLESS_DUST,
          amount1Wei: FREED_WBNB,
        });
        return confirmed(txHash);
      });
      h.provider.script.push((_params, txHash) => {
        h.receipts.mintByTx.set(txHash, 44n);
        h.positions.set("44", { liquidity: LIQ, tickLower: 0, tickUpper: 2_000 });
        return confirmed(txHash);
      });

      const result = await runLpRotate(
        { ...swaplessRotateDeps(h), market: swaplessMarket() },
        positionId,
      );
      assert.equal(result.status, "completed");
      const after = await h.store.getPosition(OWNER, AGENT_ID, positionId);
      assert.equal(after?.basisWei, basisWei, "the basis is the owner's budget, never recomputed");
      assert.equal(after?.lineageId, before?.lineageId);
    });
  }
});

/**
 * B13 — a mode flip BETWEEN cycles resumes cleanly.
 *
 * The worker drives a resumed sequence from the CURRENT cycle's digest, so a
 * flip that lands between cycles is not refused by `SETTINGS_DIGEST_MISMATCH`
 * at all (F10). The invariant three-step plan is what makes that harmless for
 * `PLAN_MISMATCH`; the mint's bind is what makes it harmless for the money.
 */
describe("PHASE3.13 B13: a rotateMode flip between cycles never wedges and never mints a fraction", () => {
  it("armed SWAPPED with the zap-out committed, resumed SWAPLESS: no PLAN_MISMATCH", async () => {
    const h = await createLpHarness();
    scriptSwaplessRotate(h, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
    h.marketState.failAfterReads = 1; // the zap-out confirms, then the run dies
    await assert.rejects(
      () => runLpRotate({ ...rotateDeps(h) }, POSITION_ID),
      /market reader died/u,
    );
    h.marketState.failAfterReads = Number.POSITIVE_INFINITY;

    const resumed = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket() },
      POSITION_ID,
    );
    assert.notEqual(resumed.code, "PLAN_MISMATCH");
    assert.equal(resumed.status, "completed");
    assert.equal(h.provider.submitted.length, 2, "the resumed sweep skipped; no fraction minted");
    const sequences = await h.store.listSequences(OWNER, AGENT_ID);
    assert.deepEqual(
      sequences[0]?.steps.map((step) => step.kind),
      ["zap-out", "sweep-token", "zap-in-mint"],
    );
  });

  it("a REPLAYED swapless skip re-verifies the bind and refuses when it no longer holds", async () => {
    const h = await createLpHarness();
    scriptSwaplessRotate(h, { amount0Wei: 0n, amount1Wei: FREED_WBNB });
    // First drive: zap-out confirms, the sweep skips, then the run dies before
    // the mint. The recorded plan carries a SKIPPED sweep with no txHash.
    let reads = 0;
    const dyingMarket: LpMarketReader = async () => {
      reads += 1;
      if (reads > 2) throw new Error("simulated crash: the market reader died mid-run");
      const spot = getSqrtRatioAtTick(SWAPLESS_TICK);
      return {
        ...baseMarket(),
        currentTick: SWAPLESS_TICK,
        spotSqrtPriceX96: spot,
        twapSqrtPriceX96: spot,
      };
    };
    await assert.rejects(
      () => runLpRotate({ ...swaplessRotateDeps(h), market: dyingMarket }, POSITION_ID),
      /market reader died/u,
    );
    const submittedAfterFirstDrive = h.provider.submitted.length;

    // Resume with the price back INSIDE the prior range: `state` is
    // per-process, so nothing about the skip survives except that it happened.
    // Fail-closed is the only honest answer.
    const resumed = await runLpRotate(
      { ...swaplessRotateDeps(h), market: swaplessMarket(0) },
      POSITION_ID,
    );
    assert.equal(resumed.status, "held");
    assert.equal(resumed.code, "BUILD_REFUSED");
    assert.match(resumed.reason, /Swapless rotate refused at the mint/u);
    assert.equal(
      h.provider.submitted.length,
      submittedAfterFirstDrive,
      "nothing was submitted on the refusing resume",
    );
  });
});

/**
 * M16's test. `makeSweepStep` is shared with the exit and the harvest, and the
 * swapless decision reaches it as a step INPUT rather than as a mode on `deps`.
 * Moving `rotateMode` onto `LpSagaDeps` and reading it inside the constructor
 * would make a harvest's sweep skip too, wedging `zap-in-increase` on a
 * one-legged principal — the Phase 3.11 deadlock, re-introduced.
 */
describe("PHASE3.13 M16: the shared sweep constructor is untouched by the rotate's mode", () => {
  it("a harvest still SUBMITS its sweep, and so does an exit, whatever the owner signed", async () => {
    // The mode is carried on the OWNER'S SETTINGS, so an owner who signed
    // `swapless` has it in scope at every dispatch — including the harvest and
    // the exit, which share `makeSweepStep`. `LpSagaDeps` deliberately has no
    // such field, so this extra property is inert against the shipped types;
    // under M16 (the field moved onto the shared deps and read inside the
    // shared constructor) it is exactly what makes both sweeps vanish.
    const signedSwapless = { rotateMode: "swapless" as const };

    const harvest = await createLpHarness();
    scriptHarvest(harvest);
    const harvested = await runLpHarvest(
      { ...harvest.deps, ...signedSwapless },
      POSITION_ID,
    );
    assert.equal(harvested.status, "completed");
    assert.equal(harvest.provider.submitted.length, 3, "collect, SWEEP, increase");

    const exit = await createLpHarness();
    scriptExitToQuote(exit);
    const exited = await runLpProtect({ ...exit.deps, ...signedSwapless }, POSITION_ID);
    assert.equal(exited.status, "completed");
    assert.equal(exit.provider.submitted.length, 2, "zap-out and the exit SWAP");
  });
});

describe("LP detail fee finalizers on driven money paths",()=>{
  for(const kind of ["protect","manual-exit","rotate","harvest"] as const) for(const fail of [false,true]) it(`${kind}: telemetry ${fail?"failure":"success"} preserves completion`,async()=>{
    const h=await createLpHarness();
    if(kind==="rotate")scriptRotate(h);else if(kind==="harvest")scriptHarvest(h);else scriptExit(h);
    const instrumented=withFeeRecording(kind==="rotate"?rotateDeps(h):h.deps,["42"],fail);
    const result=kind==="rotate"?await runLpRotate({...rotateDeps(h),...instrumented.deps},POSITION_ID):kind==="harvest"?await runLpHarvest(instrumented.deps,POSITION_ID):kind==="manual-exit"?await runLpManualExit(instrumented.deps,POSITION_ID):await runLpProtect(instrumented.deps,POSITION_ID);
    assert.equal(result.status,"completed");assert.equal(instrumented.store.attempts,1);
    const rows=await instrumented.store.snapshot(OWNER,AGENT_ID);assert.equal(rows.length,fail?0:1);
    if(!fail){assert.equal(rows[0]?.realised0Wei,10n);assert.equal(rows[0]?.tokenId,"42");}
  });
  it("inline early return and confirmed replay record once without another submission",async()=>{
    const h=await createLpHarness({relayFeePerSubmitWei:1n});Object.assign(h.deps,{expectedPool:POOL,conversionCompatibleTokens:new Set<Address>([TOKEN])});
    scriptInlineExit(h,false);const f=withFeeRecording(h.deps,["42"]);h.marketState.failAfterReads=1;
    await assert.rejects(()=>runLpManualExit(f.deps,POSITION_ID,true),/market reader died/);
    assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,1);
    h.marketState.failAfterReads=Infinity;assert.equal((await runLpManualExit(f.deps,POSITION_ID,true)).status,"completed");
    assert.equal(f.store.attempts,2);assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,1);assert.equal(h.provider.submitted.length,1);
  });
  it("skipped burned exit writes no fee receipt",async()=>{const h=await createLpHarness();h.positions.set("42","burned");const f=withFeeRecording(h.deps,["42"]);await runLpProtect(f.deps,POSITION_ID);assert.equal(f.store.attempts,0);});
});
it("LP fee finalizer still runs when money post-verification fails",async()=>{
  const h=await createLpHarness();scriptExit(h);const f=withFeeRecording(h.deps,["42"]);
  const result=await runLpProtect({...f.deps,positions:async()=>({liquidity:LIQ,tickLower:-1000,tickUpper:1000})},POSITION_ID);
  assert.equal(result.status,"held");assert.equal(result.code,"POST_VERIFY_FAILED");assert.equal(f.store.attempts,1);assert.equal((await f.store.snapshot(OWNER,AGENT_ID)).length,1);
});

it("fee ledger: harvest collect → increase → later exit records exactly two receipts and survives close",async()=>{
  const h=await createLpHarness();scriptHarvest(h);const f=withFeeRecording(h.deps,["42"]);
  assert.equal((await runLpHarvest(f.deps,POSITION_ID)).status,"completed");
  h.clock.ms+=600000;scriptExit(h);const exit=await runLpManualExit(f.deps,POSITION_ID);assert.equal(exit.status,"completed",exit.reason);
  const rows=await f.store.snapshot(OWNER,AGENT_ID);assert.equal(rows.length,2);assert.equal(rows.reduce((sum,r)=>sum+r.realised0Wei,0n),20n);assert.equal(f.store.attempts,2);
  assert.equal((await h.store.getPosition(OWNER,AGENT_ID,POSITION_ID))?.state,"closed");
});
it("receipt without an NFPM collection persists a gap rather than zero fees",async()=>{
  const h=await createLpHarness();scriptExit(h);const f=withFeeRecording(h.deps,[]);assert.equal((await runLpProtect(f.deps,POSITION_ID)).status,"completed");
  const [gap]=await f.store.snapshot(OWNER,AGENT_ID);assert.equal(gap?.status,"gap");assert.equal(gap?.reason,"no-nfpm-collection-event");
});
import { decodeFunctionData } from "viem";
import { NONFUNGIBLE_POSITION_MANAGER_ABI, PANCAKE_V3_ROUTER_ABI, ERC20_APPROVE_ABI } from "../src/ops/abis.js";
import type { AtomicRotateReceipt } from "../src/lp/atomicRotateReceipt.js";
import { selectRotatePlanShape, lpReservationReleasable, type LpRotateDeps } from "../src/lp/sagas.js";

function atomicFixture(h: Harness, mode: "swapped" | "swapless", direction: -1 | 0 | 1 = 0, wbnbIsToken0 = false) {
  const oldRange = direction === 0 ? { tickLower: -1000, tickUpper: 1000 }
    : direction === 1 ? { tickLower: -2000, tickUpper: -1000 } : { tickLower: 1000, tickUpper: 2000 };
  h.positions.set("42", { liquidity: LIQ, ...oldRange });
  let receipt: AtomicRotateReceipt | undefined;
  const deps: LpRotateDeps = { ...h.deps, atomicRotate: true, tickSpacing: 10, maxTickWidth: 4000, rotateMode: mode,
    quoteWithPriceAfter: async p => ({ amountOutWei: amountInAfterPoolFee(p.amountInWei, 2500), sqrtPriceX96After: Q96 }),
    receipts: { ...h.deps.receipts, collectAmounts: h.receipts.collectAmounts.bind(h.receipts),
      swapAmounts: h.receipts.swapAmounts.bind(h.receipts), mintedTokenId: h.receipts.mintedTokenId.bind(h.receipts),
      atomicRotateReceipt: async (_tx, identity) => {
        assert.equal(identity.oldTokenId, 42n); assert.equal(identity.wallet, WALLET); assert.equal(identity.pool, POOL); assert.equal(identity.nfpm, NFPM);
        assert.ok(receipt); return receipt;
      } },
  };
  h.provider.script.push((params, tx) => {
    const calls = params.calls;
    assert.ok(calls.every(c => (c.value ?? 0n) === 0n));
    const dec = decodeFunctionData({ abi: NONFUNGIBLE_POSITION_MANAGER_ABI, data: calls[0]!.data! });
    assert.equal(calls[0]!.to, NFPM); assert.equal(dec.functionName, "decreaseLiquidity");
    if (dec.functionName !== "decreaseLiquidity") throw Error("decrease");
    assert.equal(dec.args[0].tokenId, 42n); assert.equal(dec.args[0].liquidity, LIQ); assert.equal(dec.args[0].deadline, DEADLINE);
    const floors = sagaDecreaseFloors({ sqrtPriceX96: Q96, ...oldRange, liquidity: LIQ, maxSagaSlippageBps: 100 });
    assert.equal(dec.args[0].amount0Min, floors.amount0Min); assert.equal(dec.args[0].amount1Min, floors.amount1Min);
    const collect = decodeFunctionData({ abi: NONFUNGIBLE_POSITION_MANAGER_ABI, data: calls[1]!.data! });
    assert.equal(calls[1]!.to, NFPM); assert.equal(collect.functionName, "collect");
    if (collect.functionName !== "collect") throw Error("collect");
    assert.equal(collect.args[0].recipient, WALLET); assert.equal(collect.args[0].tokenId, 42n);
    const mintCall = calls.at(-1)!;
    const mint = decodeFunctionData({ abi: NONFUNGIBLE_POSITION_MANAGER_ABI, data: mintCall.data! });
    assert.equal(mintCall.to, NFPM); assert.equal(mint.functionName, "mint"); if (mint.functionName !== "mint") throw Error("mint");
    const m = mint.args[0]; assert.equal(m.token0, wbnbIsToken0 ? WBNB : TOKEN); assert.equal(m.token1, wbnbIsToken0 ? TOKEN_HI : WBNB); assert.equal(m.recipient, WALLET); assert.equal(m.deadline, DEADLINE); assert.equal(m.fee, 2500);
    let delta0 = 0n, delta1 = 0n;
    const hasSwap = mode === "swapped" && direction !== 0;
    assert.equal(calls.length, hasSwap ? 10 : 7);
    const allowances = new Map<string, bigint>();
    const approval = (i: number, token: Address, spender: Address, value: bigint) => {
      const call = calls[i]!; assert.equal(call.to.toLowerCase(), token.toLowerCase());
      const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: call.data! });
      assert.equal(decoded.functionName, "approve"); assert.equal(decoded.args[0], spender); assert.equal(decoded.args[1], value);
      const key = token + spender; const prior = allowances.get(key) ?? 999n;
      assert.ok(value === 0n || prior === 0n, "token rejects nonzero-to-nonzero approvals, including pre-existing NFPM allowance");
      allowances.set(key, value);
    };
    if (hasSwap) {
      const router = decodeFunctionData({ abi: PANCAKE_V3_ROUTER_ABI, data: calls[4]!.data! });
      assert.equal(calls[4]!.to, ROUTER_V3); assert.equal(router.functionName, "multicall");
      if (router.functionName !== "multicall") throw Error("router");
      const inner = router.args[router.args.length - 1]; assert.ok(Array.isArray(inner)); assert.equal(inner.length, 1);
      const swap = decodeFunctionData({ abi: PANCAKE_V3_ROUTER_ABI, data: inner[0] as Hex });
      assert.equal(swap.functionName, "exactInputSingle"); if (swap.functionName !== "exactInputSingle") throw Error("swap");
      const q = swap.args[0]; assert.equal(q.recipient, WALLET); assert.equal(q.fee, 2500); assert.equal(q.deadline, DEADLINE);
      approval(2, q.tokenIn, ROUTER_V3, 0n); approval(3, q.tokenIn, ROUTER_V3, q.amountIn);
      const out = sagaSwapMinOut(amountInAfterPoolFee(q.amountIn, 2500), 100); assert.equal(q.amountOutMinimum, out);
      if (q.tokenIn.toLowerCase() === m.token0.toLowerCase()) { delta0 = q.amountIn; delta1 = -out; }
      else { delta1 = q.amountIn; delta0 = -out; }
      assert.equal(m.amount0Desired, floors.amount0Min - delta0); assert.equal(m.amount1Desired, floors.amount1Min - delta1);
    } else if (mode === "swapped") {
      assert.equal(m.amount0Desired, floors.amount0Min); assert.equal(m.amount1Desired, floors.amount1Min);
    } else {
      assert.equal(m.amount0Desired === 0n || m.amount1Desired === 0n, true);
      assert.equal(m.amount0Desired, floors.amount0Min); assert.equal(m.amount1Desired, floors.amount1Min);
    }
    const token = m.token0.toLowerCase() === WBNB.toLowerCase() ? m.token1 : m.token0;
    const i = calls.length - 5;
    approval(i, token, NFPM, 0n); approval(i + 1, WBNB, NFPM, 0n);
    approval(i + 2, WBNB, NFPM, m.token0.toLowerCase() === WBNB.toLowerCase() ? m.amount0Desired : m.amount1Desired);
    approval(i + 3, token, NFPM, m.token0.toLowerCase() === WBNB.toLowerCase() ? m.amount1Desired : m.amount0Desired);
    const floorInput = { sqrtPriceX96: Q96, tickLower: m.tickLower, tickUpper: m.tickUpper,
      liquidity: getLiquidityForAmounts(Q96, m.tickLower, m.tickUpper, m.amount0Desired, m.amount1Desired), maxSagaSlippageBps: 100 };
    const expectedMintFloors = mode === "swapped" ? sagaMintFloors({ ...floorInput, amount0Desired: m.amount0Desired, amount1Desired: m.amount1Desired })
      : sagaSingleSidedMintFloors({ ...floorInput, side: m.amount0Desired > 0n ? "above" : "below" });
    assert.equal(m.amount0Min, expectedMintFloors.amount0Min); assert.equal(m.amount1Min, expectedMintFloors.amount1Min);
    assert.ok(m.amount0Desired >= m.amount0Min && m.amount1Desired >= m.amount1Min);
    receipt = { decreased: { amount0: floors.amount0Min, amount1: floors.amount1Min },
      collected: { amount0: floors.amount0Min + 123n, amount1: floors.amount1Min + 456n },
      swap: hasSwap ? { amount0Delta: delta0, amount1Delta: delta1 } : null,
      minted: { tokenId: 99n, amount0: m.amount0Desired, amount1: m.amount1Desired } };
    h.positions.set("42", { ...oldRange, liquidity: 0n });
    h.positions.set("99", { tickLower: m.tickLower, tickUpper: m.tickUpper, liquidity: LIQ });
    return confirmed(tx);
  });
  return { deps, receipt: () => receipt };
}

describe("atomic rotate Revision 2", () => {
  for (const ordering of [false, true]) for (const mode of ["swapped", "swapless"] as const) for (const direction of [-1, 1] as const) {
    it(`one batch decodes funding, selectors, zero resets and exact approvals: wbnb0=${ordering} ${mode} direction=${direction}`, async () => {
      const h = await createLpHarness({ wbnbIsToken0: ordering }); const fx = atomicFixture(h, mode, direction, ordering);
      const result = await runLpRotate(fx.deps, POSITION_ID); assert.equal(result.status, "completed", result.reason);
      assert.equal(h.provider.submitted.length, 1); assert.equal(result.confirmedSteps, 1);
      const seq = await h.store.getSequence(OWNER, AGENT_ID, result.sequenceId);
      assert.equal(seq?.priorTokenId, "42"); assert.equal(seq?.steps[0]?.kind, "rotate-atomic"); assert.match(seq?.note ?? "", /123 \/ 456 wei/);
      assert.equal((await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID))?.basisWei, 10n ** 18n);
    });
  }
  it("already-balanced atomic rotate omits the router calls", async () => {
    const h = await createLpHarness(); const fx = atomicFixture(h, "swapped");
    const result = await runLpRotate(fx.deps, POSITION_ID); assert.equal(result.status, "completed", result.reason);
  });
  it("swapless is brain-free and excludes collected off-side fees from its principal decision", async () => {
    const h = await createLpHarness(); const fx = atomicFixture(h, "swapless", 1);
    const result = await runLpRotate({ ...fx.deps, proposeRange: async () => { assert.fail("brain must not run"); } }, POSITION_ID);
    assert.equal(result.status, "completed", result.reason); assert.ok(fx.receipt()!.collected.amount0 > 0n && fx.receipt()!.collected.amount1 > 0n);
  });
  it("fresh floor/quoted-price refusal rolls back without a submission or protection lock", async () => {
    const h = await createLpHarness(); const fx = atomicFixture(h, "swapped", 1);
    const result = await runLpRotate({ ...fx.deps, quoteWithPriceAfter: async p => ({ amountOutWei: p.amountInWei, sqrtPriceX96After: getSqrtRatioAtTick(90000) }) }, POSITION_ID);
    assert.equal(result.code, "BUILD_REFUSED"); assert.equal(result.status, "rolled-back"); assert.equal(h.provider.submitted.length, 0);
    assert.equal(await h.store.getNonTerminalSequence(OWNER, AGENT_ID, POSITION_ID), null);
  });
  for (const boundary of ["before-attach", "after-attach"] as const) it(`restart ${boundary} replays the durable old identity with the flag off`, async () => {
    const h = await createLpHarness(); const fx = atomicFixture(h, "swapped");
    if (boundary === "after-attach") h.store.crashOnCompleted = true;
    const original = fx.deps.receipts.atomicRotateReceipt!; let crash = boundary === "before-attach";
    const deps = { ...fx.deps, receipts: { ...fx.deps.receipts, atomicRotateReceipt: async (...args: Parameters<typeof original>) => {
      if (crash) { crash = false; throw Error("receipt temporarily unreadable"); } return original(...args);
    } } };
    if (boundary === "after-attach") await assert.rejects(runLpRotate(deps, POSITION_ID), /simulated crash/);
    else assert.equal((await runLpRotate(deps, POSITION_ID)).code, "POST_VERIFY_FAILED");
    const replay = await runLpRotate({ ...deps, atomicRotate: false }, POSITION_ID);
    assert.equal(replay.status, "completed", replay.reason); assert.equal(h.provider.submitted.length, 1);
    assert.equal((await h.store.getPosition(OWNER, AGENT_ID, POSITION_ID))?.tokenId, "99");
  });
  it("UNKNOWN remains unchanged across age, flag flip and late chain landing; reservation stays charged", async () => {
    const h = await createLpHarness(); const fx = atomicFixture(h, "swapped"); h.provider.script.length = 0;
    const first = await runLpRotate(fx.deps, POSITION_ID); assert.equal(first.status, "held");
    const seq = (await h.store.getSequence(OWNER, AGENT_ID, first.sequenceId))!; assert.equal(seq.recoveryState, "rotate-ambiguous");
    const key = seq.steps[0]!.journalIdempotencyKey; const before = await h.journal.get(key); assert.equal(before?.state, "UNKNOWN");
    h.clock.ms += 3_600_000; h.positions.set("42", { liquidity: 0n, tickLower: -1000, tickUpper: 1000 });
    const second = await runLpRotate({ ...fx.deps, atomicRotate: false }, POSITION_ID); assert.equal(second.status, "held");
    assert.deepEqual(await h.journal.get(key), before); assert.equal(h.provider.submitted.length, 1);
    assert.equal(lpReservationReleasable(new Map([[key, before]]), seq.steps), false);
  });
  for (const stop of ["pause", "halt"] as const) it(`atomic batch never takes the exposure-reducing exception under ${stop}`, async () => {
    const h = await createLpHarness(); const fx = atomicFixture(h, "swapped");
    if (stop === "pause") await h.killswitch.pauseAgent(AGENT_ID, OWNER); else await h.killswitch.halt("operator stop");
    const result = await runLpRotate(fx.deps, POSITION_ID); assert.notEqual(result.status, "completed"); assert.equal(h.provider.submitted.length, 0);
  });
  it("selection preserves persisted atomic/legacy plans and rejects mixed histories", () => {
    assert.equal(selectRotatePlanShape([], true), "atomic"); assert.equal(selectRotatePlanShape([], false), "legacy");
    assert.equal(selectRotatePlanShape([{ kind: "rotate-atomic" }], false), "atomic");
    assert.equal(selectRotatePlanShape([{ kind: "zap-out" }], true), "legacy");
    assert.equal(selectRotatePlanShape([{ kind: "zap-out" }, { kind: "rotate-atomic" }], true), "unsupported");
    assert.equal(selectRotatePlanShape([{ kind: "rotate-atomic" }, { kind: "rotate-atomic" }], true), "unsupported");
  });
});

it("atomic preference still resumes a committed legacy zap-out with the unchanged three-step plan", async () => {
  const h = await createLpHarness(); scriptRotate(h); h.marketState.failAfterReads = 1;
  const legacy: LpRotateDeps = { ...h.deps, atomicRotate: false, tickSpacing: 10, maxTickWidth: 4000, rotateMode: "swapped" };
  await assert.rejects(runLpRotate(legacy, POSITION_ID), /simulated crash/); assert.equal(h.provider.submitted.length, 1);
  h.marketState.failAfterReads = Infinity;
  const result = await runLpRotate({ ...legacy, atomicRotate: true }, POSITION_ID);
  assert.equal(result.status, "completed", result.reason); assert.equal(h.provider.submitted.length, 3);
  assert.deepEqual((await h.store.getSequence(OWNER, AGENT_ID, result.sequenceId))?.steps.map(s => s.kind), ["zap-out", "sweep-token", "zap-in-mint"]);
});

it("atomic receipt finalizer records old NFT fees live and after attachment replay exactly once", async () => {
  const { MemoryLpFeeEventStore } = await import("../src/store/lpFeeEvents.js");
  const h = await createLpHarness(); const fx = atomicFixture(h, "swapped"); const fees = new MemoryLpFeeEventStore();
  const deps: LpRotateDeps = { ...fx.deps, feeEvents: fees, receipts: { ...fx.deps.receipts, feeEvents: async (_tx, identity) => {
    assert.equal(identity?.oldTokenId, 42n); const r = fx.receipt()!;
    return { blockNumber: 100n, atomicRotate: r, byTokenId: new Map([["42", { collected0: r.collected.amount0, collected1: r.collected.amount1, decreased0: r.decreased.amount0, decreased1: r.decreased.amount1 }]]) };
  } } };
  h.store.crashOnCompleted = true; await assert.rejects(runLpRotate(deps, POSITION_ID), /simulated crash/);
  assert.equal((await runLpRotate(deps, POSITION_ID)).status, "completed");
  const rows = await fees.snapshot(OWNER, AGENT_ID); assert.equal(rows.length, 1); assert.equal(rows[0]!.tokenId, "42");
  assert.equal(rows[0]!.realised0Wei, 123n); assert.equal(rows[0]!.realised1Wei, 456n); assert.equal(rows[0]!.status, "recorded");
});

it("atomic malformed fee evidence becomes a gap without changing the money outcome", async () => {
  const { MemoryLpFeeEventStore } = await import("../src/store/lpFeeEvents.js"); const { LpFeeReceiptEvidenceError } = await import("../src/lp/readers.js");
  const h = await createLpHarness(); const fx = atomicFixture(h, "swapped"); const fees = new MemoryLpFeeEventStore();
  const result = await runLpRotate({ ...fx.deps, feeEvents: fees, receipts: { ...fx.deps.receipts,
    feeEvents: async () => { throw new LpFeeReceiptEvidenceError(new Error("duplicate Collect in atomic receipt")); } } }, POSITION_ID);
  assert.equal(result.status, "completed"); const rows = await fees.snapshot(OWNER, AGENT_ID);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.status, "gap"); assert.match(rows[0]!.reason!, /duplicate Collect/);
});

it("eligible IN_PROGRESS atomic confirmation replays after external reconciliation without submitting again", async () => {
  const h = await createLpHarness(); const fx = atomicFixture(h, "swapped");
  const land = h.provider.script.shift()!; h.provider.script.push((p, tx) => { land(p, tx); return { status: "PENDING", callsId: tx }; });
  const first = await runLpRotate(fx.deps, POSITION_ID); assert.equal(first.status, "held");
  const seq = (await h.store.getSequence(OWNER, AGENT_ID, first.sequenceId))!; const key = seq.steps[0]!.journalIdempotencyKey;
  assert.equal((await h.journal.get(key))?.state, "IN_PROGRESS");
  await h.journal.markCommitted(key, { txHash: txAt(0) });
  assert.equal((await runLpRotate(fx.deps, POSITION_ID)).status, "completed"); assert.equal(h.provider.submitted.length, 1);
});

it("empty live join excludes absent and rolled-back rows when choosing the configured atomic preference", async () => {
  for (const existing of ["missing", "rolled-back"] as const) {
    const h = await createLpHarness(); const fx = atomicFixture(h, "swapped");
    const seq = await h.store.createSequence({ ownerAddress: OWNER, agentId: AGENT_ID, positionId: POSITION_ID, kind: "rotate" });
    await h.store.appendStep(OWNER, AGENT_ID, seq.sequenceId, { kind: "zap-out", journalIdempotencyKey: "empty-slot" });
    if (existing === "rolled-back") { await h.journal.begin({ idempotencyKey: "empty-slot", ownerAddress: OWNER, agentId: AGENT_ID, kind: "lp", decisionId: lpStepDecisionId(seq.sequenceId, 0) }); await h.journal.markRolledBack("empty-slot", "pre-bind refusal"); }
    const result = await runLpRotate(fx.deps, POSITION_ID); assert.equal(result.status, "completed", result.reason);
    assert.equal(h.provider.submitted.length, 1); assert.equal((await h.store.getSequence(OWNER, AGENT_ID, seq.sequenceId))?.priorTokenId, "42");
  }
});

it("unsupported live rotate history holds without submitting", async () => {
  const h = await createLpHarness(); const fx = atomicFixture(h, "swapped");
  const seq = await h.store.createSequence({ ownerAddress: OWNER, agentId: AGENT_ID, positionId: POSITION_ID, kind: "rotate" });
  await h.store.appendStep(OWNER, AGENT_ID, seq.sequenceId, { kind: "zap-in-mint", journalIdempotencyKey: "unsupported" });
  await h.journal.begin({ idempotencyKey: "unsupported", ownerAddress: OWNER, agentId: AGENT_ID, kind: "lp", decisionId: lpStepDecisionId(seq.sequenceId, 0) });
  const result = await runLpRotate(fx.deps, POSITION_ID); assert.equal(result.code, "PLAN_MISMATCH"); assert.equal(h.provider.submitted.length, 0);
});

import { sagaSingleSidedMintFloors } from "../src/lp/rails.js";
