/**
 * The worker cycle end to end, on scripted observations and quotes
 * (QUANT-GRID R3.7 item 1, R2.13, R3.9, R4.4, R4.5, BC30, BC34).
 *
 * OFFLINE, and complete: arm → buy → sell → cycle closed, plus the holds, plus
 * crash injection at each phase boundary with the generic recovery driven
 * afterwards. The MAINNET proof is gate 1 and is a different instrument — no
 * forced observation exists on that path (R3.7).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryQuantJobStore, type QuantJobStore } from "../src/store/quantJobs.js";
import {
  QUANT_STRATEGY_DEFAULTS,
  QUANT_ROUTER_56,
  QUANT_U_56,
  QUANT_U_WBNB_PAIR_56,
  QUANT_WBNB_56,
  quantParamsDigest,
} from "../src/quant/config.js";
import { deriveKeypair, seal } from "../src/quant/envelope.js";
import { E18, feeEst, requiredNativeWei } from "../src/quant/grid.js";
import { runQuantWorkerOnce, type QuantWorkerDeps } from "../src/quant/worker.js";
import { MemoryQuantTransport } from "../src/quant/termix.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { ExecutionReceipt, SessionRef, SpendInfoReading, WalletProvider } from "../src/core/types.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { publicKeyToAddress } from "viem/accounts";
import {
  buildPair,
  encodeExecute,
  encodeIntent,
  intentExecutedLog,
  swapLog,
  transferLog,
} from "./support/quantReceipts.js";
import { INTENT_SUCCESS_ERR } from "../src/quant/receipt.js";
import { decodeFunctionData } from "viem";
import { PANCAKE_V2_ROUTER_TOKENS_ABI } from "../src/ops/pancakeTokens.js";

const U = 10n ** 18n;
const JOB = "quant-job-scenario";
const SEED = `0x${"88".repeat(32)}`;
const KEYPAIR = deriveKeypair(SEED);
const NOW_SEC = 1_800_000_000 - 5 * 86_400;

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8"),
) as { session: Record<string, unknown> };
const WALLET = getAddress(String(fixture.session["walletAddress"]));
const PUBLIC_KEY = String(fixture.session["publicKey"]) as Hex;
const KEY_HASH = accountKeyHashForAddress(publicKeyToAddress(PUBLIC_KEY));

const P0 = 740n * E18;
/** Level 1's buy price at the 700 bps default: floor(P0 * 9300 / 10000). */
const BUY_1 = (P0 * 9_300n) / 10_000n;
const SELL_1 = (BUY_1 * 10_700n + 9_999n) / 10_000n;

type Harness = {
  readonly store: QuantJobStore;
  readonly journal: MemoryExecutionJournal;
  readonly deps: QuantWorkerDeps;
  readonly chain: {
    mid: bigint;
    block: bigint;
    nativeBalance: bigint;
    submissions: number;
    receipts: Map<string, ReturnType<typeof buildPair>>;
    failNextSubmit: "throw" | "failed" | undefined;
  };
  clock: { nowMs: number };
};

function jobRecord(overrides: Partial<QuantJobRecord> = {}): QuantJobRecord {
  return {
    id: JOB,
    status: "ACTIVE",
    strategyId: "strategy-1",
    tradingWalletAddress: WALLET,
    allocationUWei: 10n * U,
    dailyCapUWei: 40n * U,
    termDays: 30,
    startedAtMs: NOW_SEC * 1_000,
    endsAtMs: (NOW_SEC + 4 * 86_400) * 1_000,
    sessionExpiresAtMs: 1_800_000_000 * 1_000,
    revokedAtMs: null,
    ...overrides,
  };
}

function makeHarness(options: { readonly allocationUWei?: bigint } = {}): Harness {
  const store = new MemoryQuantJobStore();
  const journal = new MemoryExecutionJournal();
  const clock = { nowMs: NOW_SEC * 1_000 };
  const chain = {
    mid: P0,
    block: 1_000n,
    nativeBalance: 10n ** 16n,
    submissions: 0,
    receipts: new Map<string, ReturnType<typeof buildPair>>(),
    failNextSubmit: undefined as unknown as "throw" | "failed" | undefined,
  };

  const transport = new MemoryQuantTransport({
    config: {
      chainId: 56, u: QUANT_U_56, uDecimals: 18,
      tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "direct" }],
      venueAllowlist: [QUANT_ROUTER_56],
    },
    agentKey: {
      encryptionPublicKey: KEYPAIR.publicKey.toString("base64"),
      algorithm: "x25519-hkdf-chacha20poly1305",
    },
    inbox: [{
      envelopeId: "env-1",
      quantJobId: JOB,
      ...seal(JSON.stringify(fixture.session), KEYPAIR.publicKey),
    }],
    jobs: new Map([[JOB, jobRecord(
      options.allocationUWei === undefined ? {} : { allocationUWei: options.allocationUWei },
    )]]),
    trades: new Map(),
    reports: [],
  });

  const reader: QuantChainReader = {
    async chainId() { return 56; },
    async finalizedBlock() {
      return {
        number: chain.block,
        hash: `0x${chain.block.toString(16).padStart(64, "0")}` as Hex,
        timestampSec: BigInt(Math.floor(clock.nowMs / 1_000)),
      };
    },
    async latestBlockNumber() { return chain.block; },
    async blockAt(blockNumber) {
      return {
        number: blockNumber,
        hash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
        timestampSec: BigInt(Math.floor(clock.nowMs / 1_000)),
      };
    },
    async reservesAt() {
      // A constant-product pool at the scripted mid, deep enough that a 10 U
      // clip's impact is a few bps rather than the refusal.
      const reserveWbnb = 113_570_000_000_000_000_000n;
      return {
        reserve0: (chain.mid * reserveWbnb) / E18,
        reserve1: reserveWbnb,
        token0: QUANT_U_56,
      };
    },
    async pairToken0() { return QUANT_U_56; },
    async getPair() { return QUANT_U_WBNB_PAIR_56; },
    async quoteV2At(_router, path, amountInWei) {
      const first = path[0];
      // U → WBNB: divide by the mid. WBNB → U: multiply. A flat 25 bps fee.
      const gross = first?.toLowerCase() === QUANT_U_56.toLowerCase()
        ? (amountInWei * E18) / chain.mid
        : (amountInWei * chain.mid) / E18;
      return (gross * 9_975n) / 10_000n;
    },
    async tokenBalanceAt() { return 30n * U; },
    async nativeBalanceAt() { return chain.nativeBalance; },
    async getTransaction(hash) { return chain.receipts.get(hash.toLowerCase())?.transaction ?? null; },
    async getReceipt(hash) { return chain.receipts.get(hash.toLowerCase())?.receipt ?? null; },
  };

  let nonce = 0n;
  const provider = {
    restoreGrantedSession(params: {
      readonly walletAddress: Address; readonly publicKey: Hex; readonly spec: unknown;
    }): SessionRef {
      return {
        walletAddress: params.walletAddress, chainId: 56,
        publicKey: params.publicKey, spec: params.spec as SessionRef["spec"], handle: {},
      };
    },
    async preflightExecute() { /* the granted snapshot permits these calls */ },
    async readSpendInfos(): Promise<readonly SpendInfoReading[]> {
      return [
        { token: null, period: "day", periodCode: 2, limitWei: 3n * 10n ** 15n, currentSpentWei: 0n },
        { token: QUANT_U_56, period: "day", periodCode: 2, limitWei: 40n * U, currentSpentWei: 0n },
        { token: QUANT_WBNB_56, period: "day", periodCode: 2, limitWei: 2n * 10n ** 17n, currentSpentWei: 0n },
        { token: QUANT_WBNB_56, period: "minute", periodCode: 0, limitWei: 2n * 10n ** 17n, currentSpentWei: 0n },
      ];
    },
    async executeViaSession(params: {
      readonly calls: readonly { readonly to: Address; readonly data?: Hex }[];
    }): Promise<ExecutionReceipt> {
      chain.submissions += 1;
      if (chain.failNextSubmit === "throw") {
        chain.failNextSubmit = undefined;
        throw new Error("relay timeout");
      }
      if (chain.failNextSubmit === "failed") {
        chain.failNextSubmit = undefined;
        return { status: "FAILED", callsId: `0x${"c1".repeat(32)}` as Hex, failureCode: "CAP_EXCEEDED" };
      }
      // Build the receipt the reconciler will later verify, from the SAME
      // calls the builder produced: this is what makes the scenario end to end
      // rather than a stub that agrees with itself.
      const swap = params.calls[1];
      const decoded = decodeFunctionData({
        abi: PANCAKE_V2_ROUTER_TOKENS_ABI, data: swap!.data!,
      });
      const [amountIn, minOut, path] = decoded.args;
      const tokenIn = getAddress(path[0]!);
      const tokenOut = getAddress(path[1]!);
      const out = tokenIn.toLowerCase() === QUANT_U_56.toLowerCase()
        ? ((amountIn * E18) / chain.mid * 9_975n) / 10_000n
        : ((amountIn * chain.mid) / E18 * 9_975n) / 10_000n;
      assert.ok(out >= minOut, "the scripted fill must clear the floor the builder set");
      nonce += 1n;
      const txHash = `0x${nonce.toString(16).padStart(64, "0")}` as Hex;
      const intent = encodeIntent({
        eoa: WALLET, nonce, keyHash: KEY_HASH,
        calls: params.calls.map((call) => ({ to: call.to, value: 0n, data: call.data ?? "0x" })),
      });
      chain.receipts.set(txHash, buildPair({
        txHash,
        blockNumber: chain.block,
        input: encodeExecute([intent]),
        logs: [
          transferLog({ token: tokenIn, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: amountIn, logIndex: 0n }),
          transferLog({ token: tokenOut, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: out, logIndex: 1n }),
          swapLog({
            pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn, amountOut: out,
            inputIsToken0: tokenIn.toLowerCase() === QUANT_U_56.toLowerCase(), logIndex: 2n,
          }),
          intentExecutedLog({ eoa: WALLET, nonce, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 3n }),
        ],
      }));
      return { status: "CONFIRMED", callsId: `0x${"c1".repeat(32)}` as Hex, transactionHash: txHash };
    },
    async readExecutionStatus() {
      return { receipt: { status: "PENDING" as const }, rawStatus: "300" };
    },
  } as unknown as WalletProvider;

  const deps: QuantWorkerDeps = {
    store, journal, provider, reader, transport, keypair: KEYPAIR,
    params: QUANT_STRATEGY_DEFAULTS,
    strategyId: "strategy-1",
    agentId: "agent-1",
    paramsDigest: quantParamsDigest(QUANT_STRATEGY_DEFAULTS),
    venue: {
      router: QUANT_ROUTER_56, u: QUANT_U_56, wbnb: QUANT_WBNB_56, pair: QUANT_U_WBNB_PAIR_56,
    },
    chainAdmission: {
      async isValidKey() { return true; },
      async accountKeys() { return [{ keyHash: KEY_HASH, isSuperAdmin: false }]; },
      async canExecute() { return true; },
    },
    intervalMs: 60_000,
    nowMs: () => clock.nowMs,
  };
  return { store, journal, deps, chain, clock };
}

/** One observation is one BLOCK; the trigger needs two, so the block advances. */
async function cycle(harness: Harness, options: { readonly dryRun?: boolean } = {}) {
  harness.chain.block += 10n;
  harness.clock.nowMs += 60_000;
  return runQuantWorkerOnce(harness.deps, options);
}

describe("quant worker — arm", () => {
  it("discovers, admits and arms a job in one cycle", async () => {
    const harness = makeHarness();
    await cycle(harness);
    const job = await harness.store.getJob(JOB);
    assert.equal(job?.status, "armed");
    assert.equal(job?.levels, 1);
    assert.equal(job?.clipUWei, 10n * U);
    assert.equal(job?.sessionPublicKey, PUBLIC_KEY);
    const levels = await harness.store.listLevels(JOB);
    assert.equal(levels[0]?.buyPriceE18, BUY_1);
    assert.equal(levels[0]?.sellPriceE18, SELL_1);
    assert.equal(levels[0]?.state, "armed-quote");
  });

  it("PERSISTS the ciphertext, so discovery does not consume the only copy", async () => {
    const harness = makeHarness();
    await cycle(harness);
    const job = await harness.store.getJob(JOB);
    assert.notEqual(job?.envelopeJson, null);
    assert.equal(JSON.parse(job!.envelopeJson!).algorithm, "x25519-hkdf-chacha20poly1305");
  });

  it("HOLDS a job whose strategyId is not ours, and never trades it", async () => {
    const harness = makeHarness();
    const state = (harness.deps.transport as MemoryQuantTransport).state;
    state.jobs.set(JOB, jobRecord({ strategyId: "someone-elses" }));
    await cycle(harness);
    const job = await harness.store.getJob(JOB);
    assert.equal(job?.holdCode, "foreign-strategy");
    assert.equal(job?.status, "discovered");
    assert.equal(harness.chain.submissions, 0);
  });

  it("HOLDS a REVOKED job", async () => {
    const harness = makeHarness();
    const state = (harness.deps.transport as MemoryQuantTransport).state;
    state.jobs.set(JOB, jobRecord({ revokedAtMs: NOW_SEC * 1_000 }));
    await cycle(harness);
    assert.equal((await harness.store.getJob(JOB))?.holdCode, "job-not-tradable");
    assert.equal(harness.chain.submissions, 0);
  });

  it("REFUSES an allocation below the minimum clip", async () => {
    const harness = makeHarness({ allocationUWei: 5n * U });
    await cycle(harness);
    const job = await harness.store.getJob(JOB);
    assert.equal(job?.holdCode, "below-minimum");
    assert.equal(job?.status, "discovered");
  });
});

describe("quant worker — a full cycle", () => {
  async function armed(): Promise<Harness> {
    const harness = makeHarness();
    await cycle(harness);
    return harness;
  }

  it("QUANT-SELFTEST R7: a wire that changes strategy AFTER admission holds the job and never trades", async () => {
    const harness = await armed();
    const state = (harness.deps.transport as MemoryQuantTransport).state;
    state.jobs.set(JOB, jobRecord({ strategyId: "someone-elses" }));
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    await cycle(harness);
    await cycle(harness);
    const job = await harness.store.getJob(JOB);
    assert.equal(job?.holdCode, "foreign-strategy");
    assert.equal(job?.strategyId, harness.deps.strategyId);
    assert.equal(harness.chain.submissions, 0);
  });

  it("does NOT buy on a single reading — a touch is never a fill", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - 1n;
    await cycle(harness);
    assert.equal(harness.chain.submissions, 0);
    const level = (await harness.store.listLevels(JOB))[0];
    assert.equal(level?.triggerConsecutive, 1);
    assert.equal(level?.state, "armed-quote");
  });

  it("does NOT buy at EXACTLY the level price, however many readings", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1;
    await cycle(harness);
    await cycle(harness);
    await cycle(harness);
    assert.equal(harness.chain.submissions, 0);
  });

  it("BUYS on the second consecutive reading below the level", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    await cycle(harness);
    assert.equal(harness.chain.submissions, 1);
    const action = (await harness.store.listActions(JOB))[0];
    assert.equal(action?.side, "buy");
    assert.equal(action?.amountInWei, 10n * U);
    assert.equal(action?.state, "committed-unverified");
    assert.equal((await harness.store.listLevels(JOB))[0]?.state, "blocked");
  });

  it("SETTLES the buy on the next cycle's recovery and holds WBNB", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    await cycle(harness);
    await cycle(harness);
    const level = (await harness.store.listLevels(JOB))[0];
    assert.equal(level?.state, "holding-base");
    assert.ok(level!.baseWei > 0n);
    assert.equal(level?.basisUWei, 10n * U);
    assert.equal((await harness.store.listActions(JOB))[0]?.state, "settled");
  });

  it("CLOSES the cycle when the price crosses the sell level", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    await cycle(harness);
    await cycle(harness); // settle the buy
    harness.clock.nowMs += QUANT_STRATEGY_DEFAULTS.cooldownSec * 1_000;
    harness.chain.mid = SELL_1 + 30n * E18;
    await cycle(harness);
    await cycle(harness);
    assert.equal(harness.chain.submissions, 2);
    await cycle(harness); // settle the sell
    const level = (await harness.store.listLevels(JOB))[0];
    assert.equal(level?.state, "armed-quote");
    assert.equal(level?.cyclesClosed, 1);
    assert.ok(level!.realizedUWei > 0n, `realized was ${level?.realizedUWei}`);
  });

  it("submits AT MOST ONE action per job per cycle (R4.4)", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    const before = harness.chain.submissions;
    await cycle(harness);
    assert.equal(harness.chain.submissions - before, 1);
  });
});

describe("quant worker — holds", () => {
  async function armed(): Promise<Harness> {
    const harness = makeHarness();
    await cycle(harness);
    return harness;
  }

  it("HOLDS `no-gas` when the wallet cannot cover the buy AND its exit", async () => {
    const harness = await armed();
    harness.chain.nativeBalance = 3n * 10n ** 14n; // exactly one FEE_EST
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    const report = await cycle(harness);
    assert.equal(harness.chain.submissions, 0);
    assert.ok(report.notes.some((note) => note.endsWith(":no-gas")), report.notes.join(","));
  });

  it("HOLDS on a COOLDOWN rather than advancing state", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    await cycle(harness); // buys
    await cycle(harness); // settles
    harness.chain.mid = SELL_1 + 30n * E18;
    await cycle(harness);
    const report = await cycle(harness);
    // The cooldown clock has not run: the sell is held, not submitted.
    assert.equal(harness.chain.submissions, 1);
    assert.ok(report.notes.some((note) => note.endsWith(":cooldown")), report.notes.join(","));
  });

  it("does NOT poll the inbox under dry-run — the one external side effect it avoids", async () => {
    const harness = makeHarness();
    const report = await cycle(harness, { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(await harness.store.getJob(JOB), null, "no job may be discovered in a rehearsal");
  });

  it("a dry-run cycle on an ARMED job submits nothing and holds `dry-run`", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    const report = await cycle(harness, { dryRun: true });
    assert.equal(harness.chain.submissions, 0);
    assert.ok(report.notes.some((note) => note.endsWith(":dry-run")), report.notes.join(","));
  });

  it("records a STALE observation and resets the latch after two of them", async () => {
    const harness = await armed();
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    assert.equal((await harness.store.listLevels(JOB))[0]?.triggerConsecutive, 1);
    // Two readings at a height already recorded: an outage, not a signal.
    harness.chain.block -= 10n;
    await runQuantWorkerOnce(harness.deps);
    await runQuantWorkerOnce(harness.deps);
    assert.equal((await harness.store.listLevels(JOB))[0]?.triggerConsecutive, 0);
    assert.equal(harness.chain.submissions, 0);
  });

  it("an inbox outage HOLDS and never blinds an armed job", async () => {
    const harness = await armed();
    (harness.deps.transport as MemoryQuantTransport).state.failing = new Set(["inbox"]);
    const report = await cycle(harness);
    assert.ok(report.notes.includes("inbox-unavailable"));
    assert.equal(report.errors, 0);
  });
});

describe("quant worker — crash injection", () => {
  async function armedAndBuying(): Promise<Harness> {
    const harness = makeHarness();
    await cycle(harness);
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    return harness;
  }

  it("a THROWN submit leaves the level blocked and the row UNKNOWN, forever", async () => {
    const harness = await armedAndBuying();
    harness.chain.failNextSubmit = "throw";
    await cycle(harness);
    const action = (await harness.store.listActions(JOB))[0];
    assert.equal(action?.state, "unknown");
    assert.equal((await harness.journal.get(action!.journalKey))?.state, "UNKNOWN");
    // Every later cycle re-drives recovery and CHANGES NOTHING: silence never
    // releases a possibly-submitted action (R6.1).
    for (let index = 0; index < 3; index += 1) await cycle(harness);
    assert.equal((await harness.store.listLevels(JOB))[0]?.state, "blocked");
    assert.equal(harness.chain.submissions, 1);
  });

  it("a FAILED receipt releases the level and the ladder resumes", async () => {
    const harness = await armedAndBuying();
    harness.chain.failNextSubmit = "failed";
    await cycle(harness);
    assert.equal((await harness.store.listLevels(JOB))[0]?.state, "armed-quote");
    const action = (await harness.store.listActions(JOB))[0];
    assert.equal(action?.state, "failed");
    assert.equal((await harness.journal.get(action!.journalKey))?.state, "ROLLED_BACK");
  });

  it("a crash AFTER the intent but BEFORE the journal row aborts on recovery", async () => {
    const harness = makeHarness();
    await cycle(harness);
    const levels = await harness.store.listLevels(JOB);
    await harness.store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "orphan", quantJobId: JOB, levelIndex: 1, actionSeq: 1, side: "buy",
        priorLevelState: levels[0]!.state, expectedLevelRowVersion: levels[0]!.rowVersion,
        amountInWei: 10n * U, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 1n,
        triggerBlock1: 1n, triggerBlock2: 1n, deadlineSec: 1, callsJson: "[]", note: "",
        impactBps: 0, preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: harness.clock.nowMs,
      }),
    );
    assert.equal((await harness.store.listLevels(JOB))[0]?.state, "blocked");
    await cycle(harness);
    assert.equal((await harness.store.getAction("orphan"))?.state, "aborted");
    assert.equal((await harness.store.listLevels(JOB))[0]?.state, "armed-quote");
  });

  it("a settled buy is never re-bought, even after many cycles", async () => {
    const harness = await armedAndBuying();
    await cycle(harness); // buys
    for (let index = 0; index < 4; index += 1) await cycle(harness);
    const buys = (await harness.store.listActions(JOB)).filter((row) => row.side === "buy");
    assert.equal(buys.length, 1, "the level holds base; there is nothing to buy");
    assert.equal(harness.chain.submissions, 1);
  });
});

describe("quant worker — budgets and term end", () => {
  it("HOLDS when the daily U budget cannot cover another clip", async () => {
    const harness = makeHarness();
    const state = (harness.deps.transport as MemoryQuantTransport).state;
    state.jobs.set(JOB, jobRecord({ dailyCapUWei: 5n * U }));
    await cycle(harness);
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    const report = await cycle(harness);
    assert.equal(harness.chain.submissions, 0);
    assert.ok(
      report.notes.some((note) => note.endsWith(":day-cap-exhausted")),
      report.notes.join(","),
    );
  });

  it("REPORTS once past endsAt, and does not report twice", async () => {
    const harness = makeHarness();
    await cycle(harness);
    harness.clock.nowMs = (NOW_SEC + 5 * 86_400) * 1_000;
    await cycle(harness);
    const state = (harness.deps.transport as MemoryQuantTransport).state;
    assert.equal(state.reports.length, 1);
    assert.equal((await harness.store.getJob(JOB))?.status, "reported");
    await cycle(harness);
    assert.equal(state.reports.length, 1);
  });

  it("does NOT report while an action is unresolved — `ended-unresolved`", async () => {
    const harness = makeHarness();
    await cycle(harness);
    harness.chain.mid = BUY_1 - E18;
    await cycle(harness);
    harness.chain.failNextSubmit = "throw";
    await cycle(harness);
    harness.clock.nowMs = (NOW_SEC + 5 * 86_400) * 1_000;
    await cycle(harness);
    const state = (harness.deps.transport as MemoryQuantTransport).state;
    assert.equal(state.reports.length, 0);
    assert.equal((await harness.store.getJob(JOB))?.status, "ended-unresolved");
  });
});

describe("quant worker — the native reservation reads OTHER levels' actions (R5.5, A1)", () => {
  /** The harness's smallest WBNB cap row, which is what `Lmin` resolves to. */
  const CAP = 2n * 10n ** 17n;
  const FEE = feeEst(QUANT_STRATEGY_DEFAULTS);
  /** Level 2's buy price on a two-level ladder: floor(BUY_1 × 9300 / 10000). */
  const BUY_2 = (BUY_1 * 9_300n) / 10_000n;
  /** A quote big enough that its inventory needs TWO exits at `CAP`. */
  const PENDING_QUOTE_OUT = CAP + 1n;
  const PENDING_KEY = "quant-job-scenario:1:1";

  /**
   * A two-level ladder whose level 1 carries a live pending BUY.
   *
   * The action is parked `submitted` against a PENDING journal row on purpose:
   * that is the one cell phase 0 waits on rather than resolving, so the action
   * is still non-terminal when the decision for level 2 runs — which is exactly
   * the state A1 is about.
   */
  async function withPendingBuyOnLevelOne(): Promise<Harness> {
    const harness = makeHarness({ allocationUWei: 20n * U });
    await cycle(harness);
    const job = await harness.store.getJob(JOB);
    assert.equal(job?.levels, 2, "the A1 case needs two levels");
    assert.equal(job?.wbnbCapMinLimitWei, CAP);
    const level1 = (await harness.store.listLevels(JOB))[0]!;
    await harness.store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: PENDING_KEY, quantJobId: JOB, levelIndex: 1, actionSeq: 1, side: "buy",
        priorLevelState: level1.state, expectedLevelRowVersion: level1.rowVersion,
        amountInWei: 10n * U, minOutWei: PENDING_QUOTE_OUT,
        quoteOutWei: PENDING_QUOTE_OUT, quoteBlock: harness.chain.block,
        triggerBlock1: harness.chain.block, triggerBlock2: harness.chain.block,
        deadlineSec: Math.floor(harness.clock.nowMs / 1_000) + 600,
        callsJson: "[]", note: "", impactBps: 0,
        preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: harness.clock.nowMs,
      }),
    );
    await harness.journal.beginWithSpend({
      idempotencyKey: PENDING_KEY, agentId: JOB, ownerAddress: WALLET,
      kind: "quantTrade", decisionId: PENDING_KEY,
      externalRef: { publicKey: PUBLIC_KEY }, nativeSpendWei: 0n,
    }, 0);
    const pending = await harness.store.getAction(PENDING_KEY);
    await harness.store.markActionSubmitted({
      journalKey: PENDING_KEY, expectedRowVersion: pending!.rowVersion,
      submitFinalizedNumber: harness.chain.block - 1n,
      submitFinalizedHash: `0x${"cc".repeat(32)}` as Hex,
      nowMs: harness.clock.nowMs,
    });
    // Level 1 holds NO base: its expected inventory lives only on the action.
    assert.equal((await harness.store.listLevels(JOB))[0]?.baseWei, 0n);
    assert.equal((await harness.store.listLevels(JOB))[0]?.state, "blocked");
    return harness;
  }

  /** The figure the reservation must arrive at, stated once and asserted twice. */
  const REQUIRED = requiredNativeWei({
    side: "buy",
    // Level 2's own clip at this mid buys well under one cap: one exit.
    ownBaseWei: CAP,
    otherLevels: [{ kind: "pending-buy", baseWei: PENDING_QUOTE_OUT }],
    minCapLimitWei: CAP,
    params: QUANT_STRATEGY_DEFAULTS,
  });

  it("charges a pending buy its EXITS, not one fee — the exact figure", () => {
    // own = 1 submission + 1 exit; level 1 = 1 submission + 2 exits.
    assert.equal(REQUIRED, FEE * 5n);
  });

  it("HOLDS `no-gas` on level 2 when only level 1's SUBMISSION is funded", async () => {
    const harness = await withPendingBuyOnLevelOne();
    // Exactly level 2's own buy (one submission + one exit) plus ONE fee for
    // level 1 — which is all the level row alone could ever ask for, and is
    // what let two adjacent buys pass with the wallet short of their exits.
    harness.chain.nativeBalance = FEE * 3n;
    harness.chain.mid = BUY_2 - E18;
    await cycle(harness);
    const report = await cycle(harness);
    assert.equal(harness.chain.submissions, 0);
    assert.ok(report.notes.some((note) => note.endsWith(":no-gas")), report.notes.join(","));
    assert.equal((await harness.store.listLevels(JOB))[1]?.state, "armed-quote");
  });

  it("still HOLDS one wei below the figure, and BUYS at it", async () => {
    const short = await withPendingBuyOnLevelOne();
    short.chain.nativeBalance = REQUIRED - 1n;
    short.chain.mid = BUY_2 - E18;
    await cycle(short);
    const held = await cycle(short);
    assert.equal(short.chain.submissions, 0);
    assert.ok(held.notes.some((note) => note.endsWith(":no-gas")), held.notes.join(","));

    const funded = await withPendingBuyOnLevelOne();
    funded.chain.nativeBalance = REQUIRED;
    funded.chain.mid = BUY_2 - E18;
    await cycle(funded);
    await cycle(funded);
    assert.equal(funded.chain.submissions, 1);
    const level2Action = (await funded.store.listActions(JOB))
      .find((row) => row.levelIndex === 2);
    assert.equal(level2Action?.side, "buy");
    assert.equal(level2Action?.amountInWei, 10n * U);
  });

  it("charges a pending SELL for its RESIDUE, never for the chunk in flight", () => {
    const base = 3n * CAP;
    const chunk = CAP;
    const withSell = requiredNativeWei({
      side: "buy", ownBaseWei: CAP, minCapLimitWei: CAP, params: QUANT_STRATEGY_DEFAULTS,
      otherLevels: [{ kind: "pending-sell", baseWei: base - chunk }],
    });
    // own 2 + (1 submission + 2 exits for the 2 caps still to leave) = 5.
    assert.equal(withSell, FEE * 5n);
    const asHolding = requiredNativeWei({
      side: "buy", ownBaseWei: CAP, minCapLimitWei: CAP, params: QUANT_STRATEGY_DEFAULTS,
      otherLevels: [{ kind: "holding-base", baseWei: base }],
    });
    assert.equal(asHolding, FEE * 5n, "the chunk in flight pays for itself, once");
  });
});
