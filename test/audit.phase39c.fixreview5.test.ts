import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { resolveLpEvidenceConfig } from "../src/ops/config.js";
import { PostgresLpCoverageStore, type CoverageLane } from "../src/store/lpCoverage.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";

const H0 = `0x${"00".repeat(32)}` as Hex;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;

describe("Phase 3.9c fifth independent fix-review regressions", () => {
  it("takes the charged-row quota prefix before rewind's ordinary cursor lock", async () => {
    class LockOrderSql implements SqlClient {
      readonly tags: string[] = [];

      async query<R = Record<string, unknown>>(
        text: string,
      ): Promise<SqlResult<R>> {
        const tag = /\/\*\s*([\w.]+)\s*\*\//.exec(text)?.[1] ?? "ddl";
        this.tags.push(tag);
        const rows: Record<string, unknown>[] = tag === "lpCoverage.cursorLock" ? [{
          coverage_version: H2, quorum_id: H3, lane_id: H1, purpose: "base",
          admission_key_hash: H0, origin_block: "0", covered_through: "10",
          covered_through_hash: H1, covered_through_timestamp: null,
          raw_retained_from: "0", generation: "0", state: "active", row_version: "1",
        }] : tag === "lpCoverage.leaseLock" ? [{
          holder_id: "auditor", fence: "1", lease_until: new Date(8_000_000_000_000_000),
        }] : tag === "lpCoverage.rewindQuotaGlobal" || tag === "lpCoverage.rewindQuotaVersion"
          ? [{ logical_bytes: "0", block_rows: "0", candidate_rows: "0" }]
          : [];
        if (tag === "lpCoverage.rewindPrefixesLock") throw new Error("AUDIT_STOP_AFTER_LOCK_PREFIX");
        return { rows: structuredClone(rows) as R[] };
      }

      transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> { return fn(this); }
      async close(): Promise<void> {}
    }

    const sql = new LockOrderSql();
    const store = new PostgresLpCoverageStore(sql, resolveLpEvidenceConfig({}));
    const lane: CoverageLane = { coverageVersion: H2, quorumId: H3, laneId: H1,
      purpose: "base", admissionKeyHash: H0, originBlock: 0n, coveredThrough: 10n,
      coveredThroughHash: H1, coveredThroughTimestamp: 10n, rawRetainedFrom: 0n,
      generation: 0n, state: "active", rowVersion: 1 };
    await assert.rejects(store.rewind(lane, null,
      { holderId: "auditor", fence: 1n, leaseUntil: 8_000_000_000_000_000 }),
    /AUDIT_STOP_AFTER_LOCK_PREFIX/);

    const quota = sql.tags.indexOf("lpCoverage.rewindQuotaGlobal");
    const cursor = sql.tags.indexOf("lpCoverage.cursorLock");
    assert.ok(quota !== -1 && cursor !== -1);
    assert.ok(quota < cursor,
      `quota-changing rewind must follow the mandatory quota-prefix order; got ${sql.tags.join(" -> ")}`);
  });
});
