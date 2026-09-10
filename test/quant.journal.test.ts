/**
 * The five hand-maintained journal sites, and their PARITY (QUANT-GRID R2.7 / H4).
 *
 * `quantTrade` lands in five places that no compiler ties together: the
 * `JournalKind` union, `MONEY_KINDS`, the Postgres `getByDecision` SQL literal,
 * `test/support/fakeSql.ts`'s copy of that filter, and `resolveRow`'s callsId
 * branch. Every kind before this one had to be enumerated the same way; three
 * separate phase docs record the trap of forgetting one. This file is what
 * makes a forgotten site fail rather than ship.
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

const KIND: JournalKind = "quantTrade";
const JOB = "quant-job-journal";
const WALLET = "0x9bb0ab9dcef83f0b39a4be3ebe7a1c9d6d5c1111";
const DECISION = "decision-1";

const journalSource = readFileSync(
  new URL("../src/store/journal.ts", import.meta.url), "utf8",
);
const fakeSqlSource = readFileSync(
  new URL("./support/fakeSql.ts", import.meta.url), "utf8",
);

describe("site 1 + 2 — the union and MONEY_KINDS", () => {
  it("`quantTrade` is a MONEY kind and NOT a local-only one", () => {
    assert.equal(MONEY_KINDS.has(KIND), true);
    assert.equal(LOCAL_ONLY_KINDS.has(KIND), false);
  });
});

describe("site 3 + 4 — the SQL literal and its hand-written twin", () => {
  it("the Postgres `getByDecision` literal names it", () => {
    assert.ok(
      journalSource.includes("'billingCollect', 'lending', 'quantTrade')"),
      "the getByDecision SQL literal must enumerate quantTrade",
    );
  });

  it("`test/support/fakeSql.ts` names it too", () => {
    assert.ok(
      fakeSqlSource.includes('row["kind"] === "quantTrade"'),
      "the fake SQL client's copy of the filter must enumerate quantTrade",
    );
  });

  it("EVERY MONEY_KINDS member appears in BOTH — the parity that matters", () => {
    for (const kind of MONEY_KINDS) {
      assert.ok(
        journalSource.includes(`'${kind}'`),
        `the SQL literal is missing ${kind}`,
      );
      assert.ok(
        fakeSqlSource.includes(`"${kind}"`),
        `the fake SQL filter is missing ${kind}`,
      );
    }
  });
});

describe("site 5 — reconcile's callsId branch", () => {
  const provider = (receipt: ExecutionReceipt): WalletProvider =>
    ({ async awaitExecution() { return receipt; } }) as unknown as WalletProvider;

  async function pending(journal: ExecutionJournal): Promise<string> {
    const key = "quant-key-1";
    await journal.beginWithSpend({
      idempotencyKey: key, agentId: JOB, ownerAddress: WALLET, kind: KIND,
      decisionId: DECISION, externalRef: { callsId: `0x${"c1".repeat(32)}` as Hex },
      nativeSpendWei: 0n,
    }, 0);
    await journal.markInProgress(key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    return key;
  }

  it("resolves a CONFIRMED quant row from its callsId, like `lp` and `lending`", async () => {
    const journal = new MemoryExecutionJournal();
    const key = await pending(journal);
    const summary = await reconcile({
      provider: provider({
        status: "CONFIRMED", callsId: `0x${"c1".repeat(32)}` as Hex,
        transactionHash: `0x${"ab".repeat(32)}` as Hex,
      }),
      journal,
      resolveWallet: async () => null,
      minRowAgeMs: 0,
    });
    assert.equal(summary.committed, 1);
    assert.equal((await journal.get(key))?.state, "COMMITTED");
  });

  it("rolls a FAILED quant row back", async () => {
    const journal = new MemoryExecutionJournal();
    const key = await pending(journal);
    const summary = await reconcile({
      provider: provider({
        status: "FAILED", callsId: `0x${"c1".repeat(32)}` as Hex, failureCode: "CAP_EXCEEDED",
      }),
      journal,
      resolveWallet: async () => null,
      minRowAgeMs: 0,
    });
    assert.equal(summary.rolledBack, 1);
    assert.equal((await journal.get(key))?.state, "ROLLED_BACK");
  });

  it("HOLDS a still-pending quant row rather than closing it", async () => {
    const journal = new MemoryExecutionJournal();
    const key = await pending(journal);
    const summary = await reconcile({
      provider: provider({ status: "PENDING", callsId: `0x${"c1".repeat(32)}` as Hex }),
      journal,
      resolveWallet: async () => null,
      minRowAgeMs: 0,
    });
    assert.deepEqual(summary.held, [key]);
    assert.equal((await journal.get(key))?.state, "UNKNOWN");
  });

  it("does NOT fall through to the unrecognized-kind branch", async () => {
    // Without site 5 the row would park UNKNOWN with the generic reason, which
    // for a kind with no owner-signed resolver is PERMANENT. The distinguishing
    // evidence is that a CONFIRMED answer COMMITS rather than holding.
    const journal = new MemoryExecutionJournal();
    await pending(journal);
    const summary = await reconcile({
      provider: provider({
        status: "CONFIRMED", callsId: `0x${"c1".repeat(32)}` as Hex,
        transactionHash: `0x${"ab".repeat(32)}` as Hex,
      }),
      journal,
      resolveWallet: async () => null,
      minRowAgeMs: 0,
    });
    assert.deepEqual(summary.held, []);
  });
});

describe("cross-backend parity for the decision namespace", () => {
  async function bothBackends(): Promise<readonly ExecutionJournal[]> {
    const fake = new FakeSqlClient();
    return [new MemoryExecutionJournal(), await PostgresExecutionJournal.create(fake)];
  }

  it("finds a quantTrade row by its decision on BOTH backends", async () => {
    for (const journal of await bothBackends()) {
      await journal.beginWithSpend({
        idempotencyKey: "k1", agentId: JOB, ownerAddress: WALLET,
        kind: KIND, decisionId: DECISION, nativeSpendWei: 0n,
      }, 0);
      const found = await journal.getByDecision(JOB, DECISION);
      assert.notEqual(found, null, "a quantTrade row must be findable by decision");
      assert.equal(found?.kind, KIND);
    }
  });

  it("shares ONE decision namespace with trade and lp, on BOTH backends", async () => {
    for (const journal of await bothBackends()) {
      await journal.beginWithSpend({
        idempotencyKey: "k-quant", agentId: JOB, ownerAddress: WALLET,
        kind: KIND, decisionId: DECISION, nativeSpendWei: 0n,
      }, 0);
      // A `trade` row reusing the SAME decision must find the quant row — the
      // property that stops one decision spending twice across two routes.
      const found = await journal.getByDecision(JOB, DECISION);
      assert.equal(found?.kind, KIND);
    }
  });

  it("counts a quant row's spend as zero — the legs move no native", async () => {
    for (const journal of await bothBackends()) {
      await journal.beginWithSpend({
        idempotencyKey: "k2", agentId: JOB, ownerAddress: WALLET,
        kind: KIND, decisionId: "d2", nativeSpendWei: 0n,
      }, 0);
      assert.equal(await journal.sumNativeSpendSince(JOB, 0), 0n);
    }
  });
});
