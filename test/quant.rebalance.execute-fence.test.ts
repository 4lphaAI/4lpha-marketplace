import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { getAddress, type Hex } from "viem";
import { parseSessionPlaintext, permissionsDigest, projectGrantedPermissions, specDigest } from "../src/quant/admission.js";
import { quantKeypairFromSeed, submitQuantRebalanceAction, type QuantRebalanceExecuteDeps } from "../src/quant/execute.js";
import { seal } from "../src/quant/envelope.js";
import { buildRebalanceCalls } from "../src/quant/rebalanceRoutes.js";
import { E18, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import { callsDigest } from "../src/quant/receipt.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import type { QuantRebalanceStore } from "../src/store/quantRebalance.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const PAIR = getAddress(`0x${"22".repeat(20)}`);
const SESSION_FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };

async function runBoundary(input: { readonly wireStatus?: string; readonly abortOnWire?: boolean; readonly abortOnPreflight?: boolean; readonly throwOnExecute?: boolean; readonly terminalizeOnExecute?: "confirmed" | "throw"; readonly revalidationAllowed?: boolean }) {
  const parsed = parseSessionPlaintext(JSON.stringify(SESSION_FIXTURE.session));
  assert.equal(parsed.ok, true); if (!parsed.ok) throw new Error("offline session fixture invalid");
  const session = parsed.session;
  const nowMs = (session.expiry - 2 * 86_400) * 1_000;
  const keypair = quantKeypairFromSeed(`0x${"77".repeat(32)}`);
  const envelope = seal(JSON.stringify(SESSION_FIXTURE.session), keypair.publicKey);
  const projection = projectGrantedPermissions(session.permissions, { expiry: session.expiry,
    nowSeconds: Math.floor(nowMs / 1_000), termDays: 30, walletAddress: session.walletAddress });
  assert.equal(projection.ok, true); if (!projection.ok) throw new Error("offline projection invalid");
  const wallet = getAddress(session.walletAddress);
  const job: QuantRebalanceJobRow = {
    jobId: "submit-fence-job", strategyId: "strategy-1", tradingWallet: wallet,
    allocationWei: 10n * E18, dailyCapWei: 40n * E18, termDays: 30,
    startedAtMs: nowMs - 1_000, endsAtMs: session.expiry * 1_000, sessionExpiresAtMs: session.expiry * 1_000,
    revokedAtMs: null, platformStatus: "ACTIVE", status: "admitted", wireJson: "{}", wireDigest: HASH,
    envelopeJson: JSON.stringify(envelope), envelopeId: "env", admittedAtMs: nowMs - 500,
    policyJson: "{}", policyDigest: HASH, tier: "low", sessionPublicKey: session.publicKey,
    sessionExpirySec: session.expiry, permissionsDigest: permissionsDigest(session.permissions),
    projectionDigest: specDigest(projection.spec), descriptorJson: JSON.stringify(session.permissions, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value),
    projectionJson: JSON.stringify(projection.spec, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value), capRowsJson: "[]", claimGeneration: 1n,
    baselineBlock: 100n, baselineHash: HASH, baselineAtMs: nowMs - 500,
    actualBaselineJson: "{}", protectedBaselineJson: "{}",
    managed: { USDC: 10n * E18, WBNB: 0n, ETH: 0n, CAKE: 0n }, costBasis: { WBNB: 0n, ETH: 0n, CAKE: 0n },
    accountingRev: 5n, checkRev: 2n, nextEligibleSlot: 0, actionSequence: 1n,
    lastDeadlineSec: 0, bootstrapComplete: false, externalActivity: false,
    holdCode: null, holdEvidenceJson: null, reportAttempts: 0, reportPayloadDigest: null,
    reportResponseStatus: null, reportNotesApplied: null, reportedAtMs: null, retiredAtMs: null,
    retirementEvidenceJson: null, rowVersion: 5, createdAtMs: nowMs - 1_000, updatedAtMs: nowMs,
  };
  const deadlineSec = Math.floor(nowMs / 1_000) + 600;
  const built = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: [REBALANCE_USDC, REBALANCE_WBNB],
    amountInWei: E18, quoteOutWei: 2n * E18, recipient: wallet, deadlineSec, actionSequence: 1n });
  const callsJson = JSON.stringify(built.calls, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value);
  let action: QuantRebalanceActionRow = {
    actionId: `0x${"01".repeat(32)}`, journalKey: `0x${"01".repeat(32)}`, jobId: job.jobId, checkId: "bootstrap",
    sequence: 1n, plannedAccountingRev: 4n, plannedCheckVersion: 1, state: "intended", side: "buy", asset: "WBNB",
    tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
    pairAddresses: [PAIR], amountInWei: E18, minOutWei: built.minOutWei, quoteOutWei: 2n * E18,
    deadlineSec, callsJson, callsDigest: callsDigest(built.calls), policyDigest: HASH,
    permissionsDigest: job.permissionsDigest!, projectionDigest: job.projectionDigest!, claimGeneration: 1n,
    quoteBlockNumber: 101n, quoteBlockHash: HASH, quoteObservedAtMs: nowMs,
    referenceBlockNumber: 101n, referenceBlockHash: HASH, referenceObservedAtMs: nowMs,
    referenceEvidenceJson: "{}", gasEvidenceJson: "{}", preSubmitBlockNumber: null, preSubmitBlockHash: null,
    txHash: null, fillInWei: null, fillOutWei: null, receiptBlockNumber: null, receiptBlockHash: null,
    swapLogIndices: [], proofDigest: null, reservationWei: E18, failureCode: null, ambiguousCause: null,
    resolutionJson: null, rowVersion: 1, createdAtMs: nowMs, updatedAtMs: nowMs,
  };
  const check = { checkId: "bootstrap", jobId: job.jobId, kind: "bootstrap" as const, slot: 0,
    state: "rebalancing" as const, evidenceJson: "{}", takenAssets: [], rowVersion: 1,
    createdAtMs: nowMs, updatedAtMs: nowMs };
  let markSubmittedCalls = 0; let providerSubmits = 0; let failedActions = 0; let ambiguousActions = 0;
  let journalBegins = 0; let journalWasPresentBeforeSessionRestore = false;
  const controller = new AbortController();
  const journal = new MemoryExecutionJournal();
  const store = {
    async getAction() { return action; },
    async beginJournalForIntended(args: Parameters<QuantRebalanceStore["beginJournalForIntended"]>[0]) {
      if (action.state !== "intended" || action.rowVersion !== args.expectedRowVersion) return { kind: "conflict" as const, record: action };
      const result = await args.journalBegin.journal.beginWithSpend(args.journalBegin.input, args.journalBegin.sinceMs);
      if (!result.created) return { kind: "inconsistent" as const, code: "action-unresolved" as const };
      journalBegins += 1;
      return { kind: "ok" as const, record: action };
    },
    async markSubmitted(args: Parameters<QuantRebalanceStore["markSubmitted"]>[0]) {
      markSubmittedCalls += 1;
      if (action.state !== "intended" || action.rowVersion !== args.expectedRowVersion) return { kind: "conflict" as const, record: action };
      const fresh = await args.revalidate({ job, check, action });
      if (!fresh) return { kind: "inconsistent" as const, code: "revision-changed" as const };
      action = { ...action, state: "submitted", preSubmitBlockNumber: args.blockNumber,
        preSubmitBlockHash: args.blockHash, rowVersion: action.rowVersion + 1 };
      return { kind: "ok" as const, record: action };
    },
    async abortIntendedAction(args: Parameters<QuantRebalanceStore["abortIntendedAction"]>[0]) {
      if (action.state !== "intended" || action.rowVersion !== args.expectedRowVersion) return { kind: "conflict" as const, record: action };
      const existing = await journal.get(action.journalKey);
      if (args.expectedJournalState === "absent" ? existing !== null
        : existing === null || existing.state !== args.expectedJournalState || existing.externalRef.callsId !== undefined || existing.externalRef.txHash !== undefined) {
        return { kind: "inconsistent" as const, code: "revision-changed" as const };
      }
      if (existing?.state === "PENDING") await journal.markRolledBack(action.journalKey, "offline pre-provider refusal");
      action = { ...action, state: "aborted", resolutionJson: "{}", rowVersion: action.rowVersion + 1 };
      return { kind: "ok" as const, record: action };
    },
    async failAction() { failedActions += 1; action = { ...action, state: "failed", rowVersion: action.rowVersion + 1 }; return { kind: "ok" as const, record: action }; },
    async markAmbiguous(args: { readonly state: "unknown" | "committed-unverified"; readonly cause: string; readonly txHash?: Hex }) {
      if (!(action.state === "submitted" || action.state === "unknown" || action.state === "committed-unverified")) {
        return { kind: "inconsistent" as const, code: "revision-changed" as const };
      }
      ambiguousActions += 1; action = { ...action, state: args.state, ambiguousCause: args.cause,
        ...(args.txHash === undefined ? {} : { txHash: args.txHash }), rowVersion: action.rowVersion + 1 };
      return { kind: "ok" as const, record: action };
    },
  } as unknown as QuantRebalanceStore;
  const provider = {
    restoreGrantedSession(args: { readonly walletAddress: typeof wallet; readonly publicKey: Hex; readonly expiresAt: number; readonly spec: typeof projection.spec }) {
      journalWasPresentBeforeSessionRestore = journalBegins === 1;
      return { walletAddress: args.walletAddress, chainId: 56, publicKey: args.publicKey, spec: args.spec, handle: {}, expiresAt: args.expiresAt };
    },
    async preflightExecute() {
      if (input.abortOnPreflight) {
        const current = await store.getAction(action.actionId);
        assert(current !== null);
        const recovery = await store.abortIntendedAction({ actionId: action.actionId, expectedRowVersion: current.rowVersion,
          expectedJournalState: "PENDING", nowMs });
        assert.equal(recovery.kind, "ok");
      }
    },
    async readSpendInfos() { return [
      { token: null, period: "day", limitWei: 3_000_000_000_000_000n, currentSpentWei: 0n },
      { token: REBALANCE_USDC, period: "day", limitWei: 40n * E18, currentSpentWei: 0n },
    ]; },
    async executeViaSession() {
      providerSubmits += 1;
      if (input.terminalizeOnExecute !== undefined) action = { ...action, state: "aborted", resolutionJson: "late-terminal", rowVersion: action.rowVersion + 1 };
      if (input.throwOnExecute || input.terminalizeOnExecute === "throw") throw new Error("relay-ambiguous");
      return { status: "CONFIRMED" as const };
    },
  } as unknown as WalletProvider;
  const reader = {
    async finalizedBlock() { return { number: 101n, hash: HASH, timestampSec: BigInt(Math.floor(nowMs / 1_000)) }; },
    async nativeBalanceAtHash() { return E18; },
  } as unknown as QuantChainReader;
  const currentWire: QuantJobRecord = { id: job.jobId, status: input.wireStatus ?? "ACTIVE", strategyId: job.strategyId,
    tradingWalletAddress: wallet, allocationUWei: job.allocationWei, dailyCapUWei: job.dailyCapWei,
    termDays: job.termDays, startedAtMs: job.startedAtMs, endsAtMs: job.endsAtMs,
    sessionExpiresAtMs: job.sessionExpiresAtMs, revokedAtMs: null };
  const deps: QuantRebalanceExecuteDeps = {
    store, journal, provider, reader, keypair, nowMs: () => nowMs,
    async revalidatePlan() { return input.revalidationAllowed ?? true; },
    async readCurrentWire() { if (input.abortOnWire) controller.abort(); return currentWire; },
    signal: controller.signal,
  };
  const outcome = await submitQuantRebalanceAction(deps, { job, action, calls: built.calls, requiredNativeWei: 1n });
  return { outcome, markSubmittedCalls, providerSubmits, failedActions, ambiguousActions, action, journal,
    journalWasPresentBeforeSessionRestore };
}

it("refuses a pause or lost lease between pricing and the submit claim", async () => {
  const paused = await runBoundary({ wireStatus: "PAUSED" });
  assert.deepEqual(paused.outcome, { kind: "refused", code: "wire-changed" });
  assert.equal(paused.markSubmittedCalls, 0);
  assert.equal(paused.providerSubmits, 0);

  const leaseLost = await runBoundary({ abortOnWire: true });
  assert.deepEqual(leaseLost.outcome, { kind: "refused", code: "worker-lease-lost" });
  assert.equal(leaseLost.markSubmittedCalls, 0);
  assert.equal(leaseLost.providerSubmits, 0);
  const normal = await runBoundary({});
  assert.equal(normal.journalWasPresentBeforeSessionRestore, true);
});

it("a failed pre-submit revalidation aborts without entering the provider", async () => {
  const result = await runBoundary({ revalidationAllowed: false });
  assert.deepEqual(result.outcome, { kind: "refused", code: "price-moved" });
  assert.equal(result.action.state, "aborted");
  assert.equal(result.markSubmittedCalls, 0);
  assert.equal(result.providerSubmits, 0);
  assert.equal(result.ambiguousActions, 0);
  assert.equal((await result.journal.get(result.action.journalKey))?.state, "ROLLED_BACK");
});

it("keeps a post-provider-entry failure UNKNOWN", async () => {
  const result = await runBoundary({ throwOnExecute: true });
  assert.deepEqual(result.outcome, { kind: "unknown", code: "submit-ambiguous" });
  assert.equal(result.markSubmittedCalls, 1);
  assert.equal(result.providerSubmits, 1);
  assert.equal(result.failedActions, 0);
  assert.equal(result.ambiguousActions, 1);
  assert.equal(result.action.state, "unknown");
});

it("keeps fenced recovery terminal when it wins after journal begin but before the submit claim", async () => {
  const result = await runBoundary({ abortOnPreflight: true });
  assert.deepEqual(result.outcome, { kind: "refused", code: "action-terminal" });
  assert.equal(result.action.state, "aborted");
  assert.equal((await result.journal.get(result.action.journalKey))?.state, "ROLLED_BACK");
  assert.equal(result.providerSubmits, 0);
  assert.equal(result.ambiguousActions, 0);
});

it("does not turn a terminal action UNKNOWN when a stale provider result or error arrives", async () => {
  for (const terminalizeOnExecute of ["confirmed", "throw"] as const) {
    const result = await runBoundary({ terminalizeOnExecute });
    assert.deepEqual(result.outcome, { kind: "refused", code: "action-terminal" }, terminalizeOnExecute);
    assert.equal(result.action.state, "aborted", terminalizeOnExecute);
    assert.equal(result.ambiguousActions, 0, terminalizeOnExecute);
    assert.equal((await result.journal.get(result.action.journalKey))?.state, "PENDING", terminalizeOnExecute);
  }
});
