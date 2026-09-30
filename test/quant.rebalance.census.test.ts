import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { buildQuantWalletCensus } from "../src/quant/rebalanceCensus.js";
import { sanitizeQuantRebalanceWalletCensus } from "../src/quant/rebalanceOperatorCli.js";
import { withQuantRebalanceCensusSnapshot } from "../scripts/live-quant-rebalance.js";
import type { SqlClient } from "../src/store/sql.js";
import type { QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";

const WALLET = getAddress(`0x${"ab".repeat(20)}`);
const H = `0x${"11".repeat(32)}` as const;

function job(jobId: string, rowVersion: number, admittedAtMs: number | null): QuantRebalanceJobRow {
  return {
    jobId, strategyId: "rebal-strategy", tradingWallet: WALLET, allocationWei: 10n, dailyCapWei: 20n,
    termDays: 30, startedAtMs: 1, endsAtMs: 10_000, sessionExpiresAtMs: 9_000, revokedAtMs: null,
    platformStatus: "ACTIVE", status: admittedAtMs === null ? "discovered" : "admitted",
    wireJson: "{}", wireDigest: H, envelopeJson: "SENSITIVE_CIPHERTEXT", envelopeId: "env",
    admittedAtMs, policyJson: null, policyDigest: null, tier: null, sessionPublicKey: null, sessionExpirySec: admittedAtMs === null ? null : 8_000,
    permissionsDigest: null, projectionDigest: null, descriptorJson: "SENSITIVE_SESSION_DESCRIPTOR",
    projectionJson: null, capRowsJson: null, claimGeneration: null, baselineBlock: null, baselineHash: null,
    baselineAtMs: null, actualBaselineJson: null, protectedBaselineJson: null, managed: null, costBasis: null,
    accountingRev: 0n, checkRev: 0n, nextEligibleSlot: 1, actionSequence: 0n, lastDeadlineSec: 0,
    bootstrapComplete: false, externalActivity: false, holdCode: null, holdEvidenceJson: "PRIVATE_SHOULD_NOT_ESCAPE",
    reportAttempts: 0, reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null,
    reportedAtMs: null, retiredAtMs: null, retirementEvidenceJson: null,
    rowVersion, createdAtMs: 1, updatedAtMs: 2,
  };
}

describe("Quant shared-wallet read-only census", () => {
  it("marks multiple admitted jobs for explicit disposition and hashes their revisions", () => {
    const base = { generatedAtMs: 10, migrationInstalled: false, gridJobs: [], gridActions: [],
      rebalanceActions: [], claims: [] } as const;
    const first = buildQuantWalletCensus({ ...base,
      rebalanceJobs: [job("job-a", 3, 4), job("job-b", 5, 6)],
    });
    assert.equal(first.groups.length, 1);
    assert.equal(first.groups[0]?.disposition, "operator-disposition-required");
    assert.deepEqual(first.groups[0]?.jobs.map((row) => row.jobId), ["job-a", "job-b"]);
    const changed = buildQuantWalletCensus({ ...base,
      rebalanceJobs: [job("job-a", 4, 4), job("job-b", 5, 6)],
    });
    assert.notEqual(first.digest, changed.digest);
  });

  it("is independent of input iteration order and returns no envelope/session text", () => {
    const base = { generatedAtMs: 10, migrationInstalled: false, gridJobs: [], gridActions: [],
      rebalanceActions: [], claims: [] } as const;
    const jobs = [job("job-a", 3, 4), job("job-b", 5, null)];
    const forward = buildQuantWalletCensus({ ...base, rebalanceJobs: jobs });
    const reverse = buildQuantWalletCensus({ ...base, rebalanceJobs: [...jobs].reverse() });
    assert.equal(forward.digest, reverse.digest);
    const printed = JSON.stringify(forward);
    assert.doesNotMatch(printed, /SENSITIVE_CIPHERTEXT|SENSITIVE_SESSION_DESCRIPTOR|PRIVATE_SHOULD_NOT_ESCAPE/u);
  });

  it("retains each job's reviewed public disposition facts through the sanitizer", () => {
    const census = buildQuantWalletCensus({ generatedAtMs: 10, migrationInstalled: true,
      gridJobs: [], gridActions: [], rebalanceJobs: [job("job-a", 3, 4)], rebalanceActions: [], claims: [] });
    const group = census.groups[0]!;
    const sanitized = sanitizeQuantRebalanceWalletCensus({ schema: "ready", migrationInstalled: true,
      digest: census.digest, code: null, groups: [{ wallet: group.wallet, receiptOwnershipCount: group.receiptOwnershipCount,
        claimMode: null, claimGeneration: null, dispositionRequired: false, actionSetDigest: H,
        jobs: group.jobs.map((row) => ({ strategyKind: row.strategyKind, jobId: row.jobId, status: row.status,
          rowVersion: row.rowVersion, admitted: row.admitted, receiptOwnershipCount: row.receiptOwnershipCount,
          sessionExpirySec: row.sessionExpirySec, revokedAtMs: row.revokedAtMs,
          claimGeneration: row.claimGeneration?.toString(10) ?? null, accountingDigest: row.accountingDigest,
          actionStates: row.actionStates, actionSetDigest: row.actionSetDigest })) }] });
    assert.equal(sanitized.groups[0]?.jobs[0]?.sessionExpirySec, 8_000);
    assert.equal(sanitized.groups[0]?.jobs[0]?.revokedAtMs, null);
    assert.equal(sanitized.groups[0]?.jobs[0]?.accountingDigest, group.jobs[0]?.accountingDigest);
    assert.deepEqual(sanitized.groups[0]?.jobs[0]?.actionStates, []);
    assert.equal(sanitized.groups[0]?.jobs[0]?.actionSetDigest, group.jobs[0]?.actionSetDigest);
  });

  it("runs every census read through a repeatable-read, read-only transaction", async () => {
    const statements: string[] = [];
    let tx: SqlClient;
    tx = {
      async query<Row>(text: string) { statements.push(text); return { rows: [] as readonly Row[] }; },
      async transaction<T>(read: (client: SqlClient) => Promise<T>) { return read(tx); },
      async close() {},
    };
    const sql: SqlClient = {
      async query<Row>(text: string) { statements.push(`pool:${text}`); return { rows: [] as readonly Row[] }; },
      async transaction<T>(read: (client: SqlClient) => Promise<T>) { statements.push("begin"); return read(tx); },
      async close() {},
    };
    const value = await withQuantRebalanceCensusSnapshot(sql, async (client) => {
      assert.equal(client, tx);
      await client.query("select census rows");
      return "same-snapshot";
    });
    assert.equal(value, "same-snapshot");
    assert.deepEqual(statements, ["begin", "set transaction isolation level repeatable read, read only", "select census rows"]);
  });
});
