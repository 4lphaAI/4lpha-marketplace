/**
 * The six hand-maintained journal sites for `dcaRange` (AUTO-DCA-SPEC §11.2,
 * F17): the `JournalKind` union, `MONEY_KINDS`, the Postgres `getByDecision`
 * literal, `test/support/fakeSql.ts`'s copy of it, `resolveRow`'s callsId
 * branch — and NOT `LOCAL_ONLY_KINDS`. The shape of `quant.journal.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Hex } from "viem";

import {
  LOCAL_ONLY_KINDS,
  MemoryExecutionJournal,
  MONEY_KINDS,
  PostgresExecutionJournal,
  reconcile,
  type ExecutionJournal,
  type JournalKind,
} from "../src/store/journal.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import type { ExecutionReceipt, WalletProvider } from "../src/core/types.js";

const KIND: JournalKind = "dcaRange";
const AGENT = "dca-agent-journal";
const OWNER = "0x9bb0ab9dcef83f0b39a4be3ebe7a1c9d6d5c1111";
const DECISION = `dca:${AGENT}:1:1`;
const CALLS_ID = `0x${"d1".repeat(32)}` as Hex;

const journalSource = readFileSync(new URL("../src/store/journal.ts", import.meta.url), "utf8");
const fakeSqlSource = readFileSync(new URL("./support/fakeSql.ts", import.meta.url), "utf8");

describe("sites 1, 2 and 6 — the union, MONEY_KINDS, and not local-only", () => {
  it("`dcaRange` is a MONEY kind and NOT a local-only one", () => {
    assert.equal(MONEY_KINDS.has(KIND), true);
    assert.equal(LOCAL_ONLY_KINDS.has(KIND), false);
  });
});

describe("sites 3 and 4 — the SQL literal and its hand-written twin", () => {
  it("both name it", () => {
    assert.match(journalSource, /kind in \([^)]*'dcaRange'[^)]*\)/u);
    assert.ok(fakeSqlSource.includes('row["kind"] === "dcaRange"'));
  });

  it("finds a dcaRange row by its decision on BOTH backends, in the shared namespace", async () => {
    for (const journal of [new MemoryExecutionJournal(), await PostgresExecutionJournal.create(new FakeSqlClient())] as ExecutionJournal[]) {
      await journal.beginWithSpend({
        idempotencyKey: DECISION, agentId: AGENT, ownerAddress: OWNER, kind: KIND,
        decisionId: DECISION, externalRef: { quoteSpendWei: "10000000000000000000" }, nativeSpendWei: 0n,
      }, 0);
      const found = await journal.getByDecision(AGENT, DECISION);
      assert.equal(found?.kind, KIND);
    }
  });
});

describe("site 5 — reconcile's callsId branch", () => {
  const provider = (receipt: ExecutionReceipt): WalletProvider =>
    ({ async awaitExecution() { return receipt; } }) as unknown as WalletProvider;

  async function pending(journal: ExecutionJournal): Promise<string> {
    await journal.beginWithSpend({
      idempotencyKey: DECISION, agentId: AGENT, ownerAddress: OWNER, kind: KIND,
      decisionId: DECISION, externalRef: { callsId: CALLS_ID }, nativeSpendWei: 0n,
    }, 0);
    await journal.markInProgress(DECISION, { callsId: CALLS_ID });
    return DECISION;
  }

  it("commits a CONFIRMED row from its callsId instead of parking it UNKNOWN", async () => {
    const journal = new MemoryExecutionJournal();
    const key = await pending(journal);
    const summary = await reconcile({
      provider: provider({ status: "CONFIRMED", callsId: CALLS_ID, transactionHash: `0x${"ab".repeat(32)}` as Hex }),
      journal, resolveWallet: async () => null, minRowAgeMs: 0,
    });
    assert.equal(summary.committed, 1);
    assert.deepEqual(summary.held, []);
    assert.equal((await journal.get(key))?.state, "COMMITTED");
  });

  it("rolls a FAILED row back and holds a still-pending one", async () => {
    const failed = new MemoryExecutionJournal();
    const failedKey = await pending(failed);
    await reconcile({ provider: provider({ status: "FAILED", callsId: CALLS_ID, failureCode: "CAP_EXCEEDED" }), journal: failed, resolveWallet: async () => null, minRowAgeMs: 0 });
    assert.equal((await failed.get(failedKey))?.state, "ROLLED_BACK");
    const held = new MemoryExecutionJournal();
    const heldKey = await pending(held);
    const summary = await reconcile({ provider: provider({ status: "PENDING", callsId: CALLS_ID }), journal: held, resolveWallet: async () => null, minRowAgeMs: 0 });
    assert.deepEqual(summary.held, [heldKey]);
  });
});
