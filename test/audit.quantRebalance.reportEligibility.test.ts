/** Independent final-report eligibility race. No transport or chain I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";
import { runQuantRebalanceWorkerOnce, type QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import { buildQuantRebalanceReportPayload } from "../src/quant/rebalanceReporting.js";
import type { QuantRebalanceStore } from "../src/store/quantRebalance.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";

test("audit report eligibility: ending must not send after its transaction discovers a new unresolved action", async () => {
  const now = 1_800_000_000_000;
  const hash = `0x${"98".repeat(32)}` as Hex;
  const wallet = getAddress(`0x${"65".repeat(20)}`);
  let job = { jobId: "report-race", strategyId: "report-race", tradingWallet: wallet,
    status: "admitted", platformStatus: "ACTIVE", allocationWei: 10n ** 19n, dailyCapWei: 10n ** 19n,
    termDays: 30, startedAtMs: now - 100_000, endsAtMs: now - 1,
    sessionExpiresAtMs: now + 100_000, revokedAtMs: null,
    claimGeneration: 1n, reportAttempts: 0, reportedAtMs: null, rowVersion: 1, createdAtMs: now - 100_000,
  } as unknown as QuantRebalanceJobRow;
  const settled = { actionId: "settled", jobId: job.jobId, state: "settled", side: "buy", asset: "WBNB", txHash: hash } as QuantRebalanceActionRow;
  const unresolved = { actionId: "concurrent", jobId: job.jobId, state: "intended" } as QuantRebalanceActionRow;
  let actions = [settled]; let reportCalls = 0; let rejectedAttemptWrites = 0;
  const store = {
    async listWorkableJobs() { return [job]; },
    async listUnresolvedActions() { return actions.filter((action) => action.state === "intended"); },
    async discoverJob() { return job; },
    async markEnded() {
      // A second sender inserts just after the caller's pending read. The real
      // PostgreSQL end transaction rechecks and correctly returns this status.
      actions = [settled, unresolved];
      job = { ...job, status: "ended-unresolved", rowVersion: job.rowVersion + 1 };
    },
    async getJob() { return job; },
    async listActions() { return actions; },
    async recordReportAttempt() { rejectedAttemptWrites += 1; return { kind: "inconsistent", code: "action-unresolved" }; },
  } as unknown as QuantRebalanceStore;
  const deps = { store,
    claims: { migrationInstalled: async () => true, releaseTerminal: async () => false },
    strategyId: job.strategyId, agentId: "offline", nowMs: () => now, intervalMs: 60_000,
    transport: {
      async inbox() { return { ok: true, data: { items: [], nextCursor: null } }; },
      async job() { return { ok: true, data: { id: job.jobId, strategyId: job.strategyId,
        tradingWalletAddress: wallet, allocationUWei: job.allocationWei, dailyCapUWei: job.dailyCapWei,
        termDays: job.termDays, startedAtMs: job.startedAtMs, endsAtMs: job.endsAtMs,
        sessionExpiresAtMs: job.sessionExpiresAtMs, revokedAtMs: null, status: "ACTIVE" } }; },
    },
    async reportJob(_job: QuantRebalanceJobRow, current: readonly QuantRebalanceActionRow[]) {
      reportCalls += 1;
      assert.deepEqual(buildQuantRebalanceReportPayload(current), { trades: [{ txHash: hash, note: "buy:WBNB" }] });
      return { ok: true, payloadDigest: hash, responseStatus: 200, notesApplied: 1 };
    },
  } as unknown as QuantRebalanceWorkerDeps;
  await runQuantRebalanceWorkerOnce(deps);
  assert.equal(job.status, "ended-unresolved");
  assert.equal(reportCalls, 0, "eligibility must be decided before outward report, not by its later metadata write");
  assert.equal(rejectedAttemptWrites, 0);
});
