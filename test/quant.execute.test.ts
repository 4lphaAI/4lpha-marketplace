/**
 * The execution path's ORDERING and its secret discipline
 * (QUANT-GRID §9, R2.2, R3.4, R5.6, BC33).
 *
 * The two claims that matter most here are ordering claims, and both are
 * asserted by CONSTRUCTION rather than by inspection:
 *
 *   1. NO KEY IS OPENED BEFORE THE JOURNAL ROW EXISTS. The public key comes
 *      from admission, so the body's impossible ordering is gone — and a probe
 *      records the sequence so a future edit that swaps them fails here.
 *   2. Anything thrown BEFORE `executeViaSession` is entered is a ROLLBACK;
 *      the moment it is entered the action is `submitted` and any throw is
 *      UNKNOWN. The boundary is the CAS, not the error's type.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryQuantJobStore, type QuantJobStore } from "../src/store/quantJobs.js";
import { QUANT_STRATEGY_DEFAULTS, QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56 } from "../src/quant/config.js";
import { deriveKeypair, seal } from "../src/quant/envelope.js";
import { permissionsDigest, parseSessionPlaintext, projectGrantedPermissions, specDigest } from "../src/quant/admission.js";
import {
  checkQuantMeters,
  quantJournalKey,
  submitQuantAction,
  QuantExecuteError,
  type QuantExecuteDeps,
} from "../src/quant/execute.js";
import { buildPancakeTokenSwap } from "../src/ops/pancakeTokens.js";
import type { ExecutionReceipt, SessionRef, SpendInfoReading, WalletProvider } from "../src/core/types.js";
import type { QuantChainReader } from "../src/quant/readers.js";

const U = 10n ** 18n;
const SEED = `0x${"77".repeat(32)}`;
const KEYPAIR = deriveKeypair(SEED);
const JOB = "quant-job-exec";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8"),
) as { session: Record<string, unknown> };

const WALLET = getAddress(String(fixture.session["walletAddress"]));
const PUBLIC_KEY = String(fixture.session["publicKey"]) as Hex;
const PRIVATE_KEY = String(
  (fixture.session["signer"] as Record<string, unknown>)["privateKey"],
) as Hex;

const CALLS = buildPancakeTokenSwap({
  router: QUANT_ROUTER_56, tokenIn: QUANT_U_56, tokenOut: QUANT_WBNB_56,
  amountInWei: 10n * U, minOutWei: 13_500_000_000_000_000n,
  recipient: WALLET, deadline: 1_800_000_601n,
});

const NOW_SEC = 1_800_000_000 - 2 * 86_400;

function envelopeJson(): string {
  return JSON.stringify(seal(JSON.stringify(fixture.session), KEYPAIR.publicKey));
}

function digests(): { readonly permissions: Hex; readonly projection: Hex } {
  const parsed = parseSessionPlaintext(JSON.stringify(fixture.session));
  if (!parsed.ok) throw new Error("fixture must parse");
  const projection = projectGrantedPermissions(parsed.session.permissions, {
    expiry: parsed.session.expiry, nowSeconds: NOW_SEC, termDays: 30,
    walletAddress: parsed.session.walletAddress,
  });
  if (!projection.ok) throw new Error("fixture must project");
  return {
    permissions: permissionsDigest(parsed.session.permissions),
    projection: specDigest(projection.spec),
  };
}

type Probe = {
  readonly events: string[];
  readonly journal: MemoryExecutionJournal;
  readonly store: QuantJobStore;
  readonly deps: QuantExecuteDeps;
};

async function probe(options: {
  readonly onExecute?: () => Promise<ExecutionReceipt>;
  readonly onPreflight?: () => Promise<void>;
  readonly spendInfos?: readonly SpendInfoReading[];
  readonly restoreGranted?: boolean;
} = {}): Promise<Probe> {
  const events: string[] = [];
  const journal = new MemoryExecutionJournal();
  const store = new MemoryQuantJobStore();
  const { permissions, projection } = digests();

  await store.discoverJob({
    quantJobId: JOB, envelopeId: "env", envelopeJson: envelopeJson(), nowMs: 1_000,
  });
  await store.updateJobWire({
    quantJobId: JOB, strategyId: "s", tradingWallet: WALLET,
    allocationUWei: 30n * U, dailyCapUWei: 40n * U, termDays: 30,
    startedAtMs: 1_000, endsAtMs: 9_000_000_000_000,
    sessionExpiresAtMs: 1_800_000_000 * 1_000, revokedAtMs: null, nowMs: 1_100,
  });
  const row = await store.getJob(JOB);
  await store.admitJob({
    quantJobId: JOB, expectedRowVersion: row!.rowVersion,
    sessionPublicKey: PUBLIC_KEY, sessionExpiry: 1_800_000_000,
    permissionsDigest: permissions, projectionDigest: projection,
    wbnbCapMinLimitWei: 2n * 10n ** 17n, residualThresholdWei: 10n ** 15n,
    paramsJson: "{}", paramsDigest: `0x${"5a".repeat(32)}` as Hex,
    p0E18: 740n * U, armBlock: 100n,
    levels: [{ levelIndex: 1, buyPriceE18: 700n * U, sellPriceE18: 749n * U }],
    clipUWei: 10n * U, idleUWei: 0n,
    baselineUWei: 30n * U, baselineWbnbWei: 0n, baselineNativeWei: 10n ** 16n,
    nowMs: 1_200,
  });

  const provider = {
    restoreGrantedSession: options.restoreGranted === false ? undefined : (params: {
      readonly walletAddress: Address; readonly publicKey: Hex; readonly spec: unknown;
    }): SessionRef => {
      events.push("open-key");
      return {
        walletAddress: params.walletAddress,
        chainId: 56,
        publicKey: params.publicKey,
        spec: params.spec as SessionRef["spec"],
        handle: {},
      };
    },
    async preflightExecute() {
      events.push("preflight");
      if (options.onPreflight !== undefined) await options.onPreflight();
    },
    async readSpendInfos(): Promise<readonly SpendInfoReading[]> {
      events.push("meters");
      return options.spendInfos ?? [
        { token: null, period: "day", periodCode: 2, limitWei: 10n ** 16n, currentSpentWei: 0n },
        { token: QUANT_U_56, period: "day", periodCode: 2, limitWei: 40n * U, currentSpentWei: 0n },
        { token: QUANT_WBNB_56, period: "day", periodCode: 2, limitWei: 10n ** 18n, currentSpentWei: 0n },
      ];
    },
    async executeViaSession(): Promise<ExecutionReceipt> {
      events.push("submit");
      if (options.onExecute !== undefined) return options.onExecute();
      return {
        status: "CONFIRMED",
        callsId: `0x${"c1".repeat(32)}` as Hex,
        transactionHash: `0x${"aa".repeat(32)}` as Hex,
      };
    },
  } as unknown as WalletProvider;

  const reader = {
    async finalizedBlock() {
      events.push("finalized");
      return { number: 100n, hash: `0x${"bb".repeat(32)}` as Hex, timestampSec: 1n };
    },
  } as unknown as QuantChainReader;

  const beginWithSpend = journal.beginWithSpend.bind(journal);
  journal.beginWithSpend = async (input, sinceMs) => {
    events.push("journal-begin");
    return beginWithSpend(input, sinceMs);
  };

  return {
    events, journal, store,
    deps: {
      store, journal, provider, reader, keypair: KEYPAIR,
      params: QUANT_STRATEGY_DEFAULTS,
      venue: { router: QUANT_ROUTER_56, u: QUANT_U_56, wbnb: QUANT_WBNB_56 },
      nowMs: () => NOW_SEC * 1_000,
    },
  };
}

async function intent(store: QuantJobStore): Promise<Awaited<ReturnType<QuantJobStore["getAction"]>>> {
  const levels = await store.listLevels(JOB);
  const level = levels[0]!;
  const key = quantJournalKey(JOB, 1, 1);
  const result = await store.withQuantFence(JOB, async (fence) =>
    fence.insertIntent({
      journalKey: key, quantJobId: JOB, levelIndex: 1, actionSeq: 1, side: "buy",
      priorLevelState: level.state, expectedLevelRowVersion: level.rowVersion,
      amountInWei: 10n * U, minOutWei: 13_500_000_000_000_000n,
      quoteOutWei: 13_551_363_807_546_408n, quoteBlock: 101n,
      triggerBlock1: 100n, triggerBlock2: 100n, deadlineSec: 1_800_000_601,
      callsJson: JSON.stringify(CALLS.map((call) => ({
        to: call.to, value: "0", data: call.data,
      }))),
      note: "{}", impactBps: 4,
      preUWei: 30n * U, preWbnbWei: 0n, preNativeWei: 10n ** 16n,
      basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: 1_900,
    }),
  );
  assert.equal(result.kind, "ok");
  return store.getAction(key);
}

describe("quant execute — ordering", () => {
  it("opens the journal row BEFORE any key is opened", async () => {
    const context = await probe();
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const outcome = await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    assert.equal(outcome.kind, "committed");
    assert.ok(
      context.events.indexOf("journal-begin") < context.events.indexOf("open-key"),
      `ordering was ${context.events.join(" → ")}`,
    );
    assert.deepEqual(context.events, [
      "journal-begin", "open-key", "preflight", "meters", "finalized", "submit",
    ]);
  });

  it("marks the action `committed-unverified`, NEVER settled, on a CONFIRMED receipt", async () => {
    const context = await probe();
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    const settled = await context.store.getAction(action!.journalKey);
    // A COMMITTED journal row is evidence a submission LANDED, not evidence of
    // what it did. Only a verified receipt moves inventory.
    assert.equal(settled?.state, "committed-unverified");
    const level = (await context.store.listLevels(JOB))[0];
    assert.equal(level?.state, "blocked");
    assert.equal(level?.baseWei, 0n);
  });

  it("a REPLAY never opens a key and never submits", async () => {
    const context = await probe();
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const input = {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    };
    await submitQuantAction(context.deps, input);
    context.events.length = 0;
    const replay = await submitQuantAction(context.deps, input);
    assert.equal(replay.kind, "replay");
    assert.deepEqual(context.events, ["journal-begin"]);
  });
});

describe("quant execute — the submit boundary", () => {
  it("a throw BEFORE the submit is a ROLLBACK and restores the level", async () => {
    const context = await probe({
      onPreflight: async () => { throw new Error("refused"); },
    });
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const outcome = await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    assert.equal(outcome.kind, "rolled-back");
    assert.equal((await context.journal.get(action!.journalKey))?.state, "ROLLED_BACK");
    assert.equal((await context.store.getAction(action!.journalKey))?.state, "failed");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "armed-quote");
    assert.equal(context.events.includes("submit"), false);
  });

  it("a throw INSIDE the submit is UNKNOWN and the level STAYS blocked", async () => {
    const context = await probe({
      onExecute: async () => { throw new Error("relay timeout"); },
    });
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const outcome = await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    assert.equal(outcome.kind, "unknown");
    assert.equal((await context.journal.get(action!.journalKey))?.state, "UNKNOWN");
    assert.equal((await context.store.getAction(action!.journalKey))?.state, "unknown");
    // The level is NOT released. Silence never releases a possibly-submitted
    // action (R6.1) — that is the fail-closed price of not double-buying.
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "blocked");
  });

  it("a FAILED receipt rolls back and releases the level", async () => {
    const context = await probe({
      onExecute: async () => ({
        status: "FAILED", callsId: `0x${"c1".repeat(32)}` as Hex, failureCode: "CAP_EXCEEDED",
      }),
    });
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const outcome = await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    assert.equal(outcome.kind, "failed");
    assert.equal((await context.journal.get(action!.journalKey))?.state, "ROLLED_BACK");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "armed-quote");
  });

  it("a PENDING receipt leaves IN_PROGRESS, `submitted`, and blocked", async () => {
    const context = await probe({
      onExecute: async () => ({ status: "PENDING", callsId: `0x${"c1".repeat(32)}` as Hex }),
    });
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const outcome = await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    assert.equal(outcome.kind, "in-progress");
    assert.equal((await context.journal.get(action!.journalKey))?.state, "IN_PROGRESS");
    assert.equal((await context.store.getAction(action!.journalKey))?.state, "submitted");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "blocked");
  });
});

describe("quant execute — the session identity check", () => {
  it("refuses when the stored digest no longer matches the envelope", async () => {
    const context = await probe();
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const outcome = await submitQuantAction(context.deps, {
      job: { ...job!, permissionsDigest: `0x${"99".repeat(32)}` as Hex },
      action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    assert.equal(outcome.kind, "rolled-back");
    if (outcome.kind !== "rolled-back") return;
    assert.equal(outcome.code, "session-changed");
    assert.equal(context.events.includes("submit"), false);
  });

  it("refuses a provider that cannot restore a granted session", async () => {
    const context = await probe({ restoreGranted: false });
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    const outcome = await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    assert.equal(outcome.kind, "rolled-back");
    if (outcome.kind !== "rolled-back") return;
    assert.equal(outcome.code, "session-restore-unsupported");
  });
});

describe("quant execute — the secret discipline", () => {
  it("the session PRIVATE KEY appears in NO persisted string", async () => {
    const context = await probe();
    const action = await intent(context.store);
    const job = await context.store.getJob(JOB);
    await submitQuantAction(context.deps, {
      job: job!, action: action!, calls: CALLS,
      requiredNativeWei: 3n * 10n ** 14n, tokenIn: QUANT_U_56,
    });
    const rows = [
      JSON.stringify(await context.store.getJob(JOB), replacer),
      JSON.stringify(await context.store.listLevels(JOB), replacer),
      JSON.stringify(await context.store.listActions(JOB), replacer),
      JSON.stringify(await context.journal.get(action!.journalKey), replacer),
    ].join("|");
    const bare = PRIVATE_KEY.slice(2).toLowerCase();
    assert.equal(rows.toLowerCase().includes(bare), false, "a session key reached a store row");
    // The envelope CIPHERTEXT is persisted deliberately (R2.0.4) and is useless
    // without the worker-only seed — but the PLAINTEXT never is.
    assert.equal(rows.includes(JSON.stringify(fixture.session).slice(0, 40)), false);
  });

  it("QuantExecuteError's message is built from a fixed code table only", () => {
    for (const code of ["envelope-invalid", "session-changed", "submit-ambiguous"] as const) {
      const error = new QuantExecuteError(code);
      assert.equal(error.code, code);
      assert.ok(error.message.length > 0);
      assert.equal(error.message.includes(PRIVATE_KEY), false);
    }
  });
});

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString(10) : value;
}

describe("quant meters (R3.4 / BC27 / BC33)", () => {
  const base = {
    walletAddress: WALLET, publicKey: PUBLIC_KEY, tokenIn: QUANT_U_56,
    amountInWei: 10n * U, requiredNativeWei: 3n * 10n ** 14n,
  };

  function providerWith(rows: readonly SpendInfoReading[]): WalletProvider {
    return { async readSpendInfos() { return rows; } } as unknown as WalletProvider;
  }

  it("passes when every native AND token row covers the submission", async () => {
    const verdict = await checkQuantMeters({
      ...base,
      provider: providerWith([
        { token: null, period: "day", periodCode: 2, limitWei: 10n ** 16n, currentSpentWei: 0n },
        { token: QUANT_U_56, period: "day", periodCode: 2, limitWei: 40n * U, currentSpentWei: 0n },
      ]),
    });
    assert.deepEqual(verdict, { ok: true });
  });

  it("refuses when a NON-DAY period is the binding one", async () => {
    // The exact case `nativeDayMeter` cannot see, and why quant does not use it.
    const verdict = await checkQuantMeters({
      ...base,
      provider: providerWith([
        { token: null, period: "day", periodCode: 2, limitWei: 10n ** 16n, currentSpentWei: 0n },
        { token: null, period: "minute", periodCode: 0, limitWei: 1n, currentSpentWei: 0n },
        { token: QUANT_U_56, period: "day", periodCode: 2, limitWei: 40n * U, currentSpentWei: 0n },
      ]),
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "meter-exhausted");
    assert.equal(verdict.detail, "native:minute");
  });

  it("reports NO NATIVE GRANT distinctly — it is not 'unlimited' (FINDINGS (h))", async () => {
    const verdict = await checkQuantMeters({
      ...base,
      provider: providerWith([
        { token: QUANT_U_56, period: "day", periodCode: 2, limitWei: 40n * U, currentSpentWei: 0n },
      ]),
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "no-native-grant");
  });

  it("counts `currentSpent`, so a partly-used period can still refuse", async () => {
    const verdict = await checkQuantMeters({
      ...base,
      provider: providerWith([
        { token: null, period: "day", periodCode: 2, limitWei: 10n ** 16n, currentSpentWei: 0n },
        { token: QUANT_U_56, period: "day", periodCode: 2, limitWei: 40n * U, currentSpentWei: 35n * U },
      ]),
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "meter-exhausted");
  });

  it("an UNREADABLE meter is its own code, never a pass", async () => {
    const verdict = await checkQuantMeters({
      ...base,
      provider: {
        async readSpendInfos() { throw new Error("rpc down"); },
      } as unknown as WalletProvider,
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "meter-unreadable");
  });

  it("a provider WITHOUT the capability is unreadable, not unlimited", async () => {
    const verdict = await checkQuantMeters({ ...base, provider: {} as WalletProvider });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "meter-unreadable");
    assert.equal(verdict.detail, "capability");
  });
});

describe("quant journal keys", () => {
  it("are deterministic and unique per (job, level, seq)", () => {
    const a = quantJournalKey(JOB, 1, 1);
    assert.equal(a, quantJournalKey(JOB, 1, 1));
    assert.notEqual(a, quantJournalKey(JOB, 1, 2));
    assert.notEqual(a, quantJournalKey(JOB, 2, 1));
    assert.notEqual(a, quantJournalKey("other", 1, 1));
  });
});
