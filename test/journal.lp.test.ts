/**
 * The journal's `lp` kind (PHASE3-SPEC Revision 2 items 7–8; PHASE3-REVIEW R3).
 *
 * PHASE2 F3 was exactly this change done by half: one implementation learned
 * the new money kind and the other did not, so the replay check silently
 * passed on one backend and the same decision could spend twice. Every case
 * here therefore runs against BOTH implementations, and one test pins the
 * Postgres SQL literal itself — the fake SQL client re-enumerates the kind set
 * by hand, so a cross-implementation test alone cannot see the real SQL drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import {
  MemoryExecutionJournal,
  MONEY_KINDS,
  PostgresExecutionJournal,
  reconcile,
  type ExecutionJournal,
  type JournalBeginInput,
} from "../src/store/journal.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import type { ExecutionReceipt, WalletProvider } from "../src/core/types.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { AGENT_ID, call, createHarness, errorCode } from "./support/serverHarness.js";

const OWNER = "0x0000000000000000000000000000000000000001";
const AGENT = "agent-1";
const NOW = 1_900_000_000_000;
const CALLS_ID = `0x${"cd".repeat(32)}` as Hex;

type Backend = {
  readonly label: string;
  create(now: () => number): Promise<ExecutionJournal>;
};

const BACKENDS: readonly Backend[] = [
  {
    label: "memory",
    create: async (now) => new MemoryExecutionJournal(now),
  },
  {
    label: "postgres(fake sql)",
    create: (now) => PostgresExecutionJournal.create(new FakeSqlClient(), now),
  },
];

function lpBegin(
  key: string,
  overrides: Partial<JournalBeginInput> = {},
): JournalBeginInput {
  return {
    idempotencyKey: key,
    agentId: AGENT,
    ownerAddress: OWNER,
    kind: "lp",
    ...overrides,
  };
}

/**
 * A provider whose only reachable methods are the two reconcile reads.
 * Anything else throwing proves reconcile never submits.
 */
function readOnlyProvider(overrides: {
  awaitExecution?: () => Promise<ExecutionReceipt>;
  isSessionActive?: () => Promise<boolean>;
}): { provider: WalletProvider; counters: { awaits: number; sessionChecks: number } } {
  const counters = { awaits: 0, sessionChecks: 0 };
  const unreachable = (name: string) => async () => {
    throw new Error(`reconcile must not call ${name}`);
  };
  const provider = {
    resolveOwnerWallet: unreachable("resolveOwnerWallet"),
    grantSession: unreachable("grantSession"),
    restoreSession: () => {
      throw new Error("reconcile must not call restoreSession");
    },
    executeViaSession: unreachable("executeViaSession"),
    awaitExecution: async () => {
      counters.awaits += 1;
      if (overrides.awaitExecution === undefined) {
        return { status: "PENDING", callsId: CALLS_ID } satisfies ExecutionReceipt;
      }
      return overrides.awaitExecution();
    },
    isSessionActive: async () => {
      counters.sessionChecks += 1;
      return overrides.isSessionActive === undefined
        ? true
        : overrides.isSessionActive();
    },
    revokeSession: unreachable("revokeSession"),
    ownerRevokeSession: unreachable("ownerRevokeSession"),
    getBalance: unreachable("getBalance"),
    getTokenBalance: unreachable("getTokenBalance"),
    ownerRecoverNative: unreachable("ownerRecoverNative"),
    ownerRecoverTokens: unreachable("ownerRecoverTokens"),
  } as unknown as WalletProvider;
  return { provider, counters };
}

/**
 * Records every statement it is handed before delegating to the fake, so a
 * test can assert on the REAL SQL text. The fake's `transaction` passes ITSELF
 * to the callback, which would route inner queries around this recorder — so
 * `transaction` re-binds the callback to the recorder instead.
 */
class RecordingSqlClient implements SqlClient {
  readonly texts: string[] = [];
  readonly #inner = new FakeSqlClient();

  async query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<R>> {
    this.texts.push(text);
    return this.#inner.query<R>(text, params);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.#inner.transaction(async () => fn(this));
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

describe("journal lp kind: the money set", () => {
  it("MONEY_KINDS contains lp, so the memory getByDecision follows for free", () => {
    assert.equal(MONEY_KINDS.has("lp"), true);
  });

  it("the Postgres getByDecision SQL literal itself names lp (F3: the fake cannot see this drift)", async () => {
    const sql = new RecordingSqlClient();
    const journal = await PostgresExecutionJournal.create(sql, () => NOW);
    await journal.begin(lpBegin("k1", { decisionId: "d1" }));
    await journal.getByDecision(AGENT, "d1");

    const statement = sql.texts.find((text) => text.includes("journal.getByDecision"));
    assert.notEqual(statement, undefined);
    // The literal enumerates EVERY money kind by hand. PHASE4 R2.5 added the
    // four Venus kinds and required all three hand-maintained homes to move
    // together — this assertion is the drift guard that made the third one
    // impossible to forget, so it is derived from MONEY_KINDS rather than
    // re-typed, and a future kind that lands in the set and not in the SQL
    // fails here.
    const expected = [...MONEY_KINDS].map((kind) => `'${kind}'`).join(", ");
    assert.ok(
      (statement ?? "").includes(`kind in (${expected})`),
      `getByDecision must enumerate exactly MONEY_KINDS; got: ${statement ?? ""}`,
    );
    await journal.close();
  });
});

describe("Phase 3.9b: begun_at_block SQL and call-site boundary", () => {
  it("migrates the nullable bigint and binds it explicitly on journal begin", async () => {
    const sql = new RecordingSqlClient();
    const journal = await PostgresExecutionJournal.create(sql, () => NOW);
    await journal.begin(lpBegin("bounded", { begunAtBlock: 54_321n }));

    assert.equal(
      sql.texts.some((text) =>
        text
          .replace(/\s+/gu, " ")
          .includes("alter table execution_journal add column if not exists begun_at_block bigint"),
      ),
      true,
    );
    const insert = sql.texts.find((text) => text.includes("journal.beginInsert"));
    assert.match(insert ?? "", /native_spend_wei, begun_at_block, created_at/);
    assert.match(insert ?? "", /\$7::numeric, \$8::bigint, \$9, \$9/);
    await journal.close();
  });

  it("only submission-capable LP call sites pass the existing market block", () => {
    const open = readFileSync(new URL("../src/lp/open.ts", import.meta.url), "utf8");
    const sagas = readFileSync(new URL("../src/lp/sagas.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

    assert.equal(open.match(/begunAtBlock:\s*market\.blockNumber/gu)?.length, 1);
    assert.equal(sagas.match(/begunAtBlock:\s*market\.blockNumber/gu)?.length, 1);
    assert.doesNotMatch(server, /begunAtBlock/);
  });
});

for (const backend of BACKENDS) {
  describe(`Phase 3.9b begunAtBlock (${backend.label})`, () => {
    it("round-trips the exact finalized LP lower bound and defaults other rows to null", async () => {
      const journal = await backend.create(() => NOW);
      const bounded = await journal.begin(lpBegin("bounded", { begunAtBlock: 54_321n }));
      const unbounded = await journal.begin(lpBegin("unbounded", { kind: "execute" }));

      assert.equal(bounded.begunAtBlock, 54_321n);
      assert.equal((await journal.get("bounded"))?.begunAtBlock, 54_321n);
      assert.equal(unbounded.begunAtBlock, null);
      await journal.close();
    });

    it("never overwrites the original lower bound on an idempotent retry", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(lpBegin("same", { begunAtBlock: 100n }));
      const retried = await journal.begin(lpBegin("same", { begunAtBlock: 999n }));

      assert.equal(retried.begunAtBlock, 100n);
      await journal.close();
    });

    it("rejects a block that cannot fit the non-negative PostgreSQL bigint contract", async () => {
      const journal = await backend.create(() => NOW);
      await assert.rejects(
        journal.begin({ ...lpBegin("number"), begunAtBlock: 12 } as unknown as JournalBeginInput),
        /must be a bigint/,
      );
      await assert.rejects(
        journal.begin(lpBegin("negative", { begunAtBlock: -1n })),
        /non-negative PostgreSQL bigint/,
      );
      await assert.rejects(
        journal.begin(lpBegin("too-large", { begunAtBlock: 9_223_372_036_854_775_808n })),
        /non-negative PostgreSQL bigint/,
      );
      await journal.close();
    });
  });

  describe(`journal lp kind (${backend.label}): decision namespace`, () => {
    it("finds an lp row by decision — the same lookup /execute and /trade replay-check through", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(lpBegin("k1", { decisionId: "lp:seq-1:0" }));

      const found = await journal.getByDecision(AGENT, "lp:seq-1:0");
      assert.equal(found?.kind, "lp");
      assert.equal(found?.idempotencyKey, "k1");
      await journal.close();
    });

    it("shares ONE decisionId namespace across lp, execute and trade", async () => {
      // A decision id burned by an lp step must be visible to a later /execute
      // or /trade lookup, and the other way round — anything narrower re-opens
      // the F3 double spend for the third route.
      const journal = await backend.create(() => NOW);
      await journal.begin(lpBegin("k-lp", { decisionId: "shared" }));

      const seenFromMoneyRoutes = await journal.getByDecision(AGENT, "shared");
      assert.equal(seenFromMoneyRoutes?.kind, "lp");
      await journal.close();
    });

    it("still ignores non-money kinds and other agents", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(lpBegin("k1", { decisionId: "d1", kind: "pause" }));
      assert.equal(await journal.getByDecision(AGENT, "d1"), null);

      await journal.begin(lpBegin("k2", { decisionId: "d2" }));
      assert.equal(await journal.getByDecision("agent-2", "d2"), null);
      await journal.close();
    });
  });

  describe(`reconcile lp rows (${backend.label})`, () => {
    it("resolves a crashed lp step from its callsId — same path as execute/trade, no session check", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(lpBegin("k1", { decisionId: "lp:seq-1:0" }));
      await journal.markInProgress("k1", { callsId: CALLS_ID });

      const { provider, counters } = readOnlyProvider({
        awaitExecution: async () => ({
          status: "CONFIRMED",
          callsId: CALLS_ID,
          transactionHash: `0x${"ee".repeat(32)}` as Hex,
        }),
      });
      const summary = await reconcile({
    minRowAgeMs: 0,
        provider,
        journal,
        resolveWallet: async () => null,
      });

      assert.equal(summary.committed, 1);
      assert.equal(counters.awaits, 1);
      assert.equal(
        counters.sessionChecks,
        0,
        "an lp step is never resolved on the strength of a live session (F4)",
      );
      assert.equal((await journal.get("k1"))?.state, "COMMITTED");
      await journal.close();
    });

    it("rolls an lp step back when the chain reports FAILED", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(lpBegin("k1", { nativeSpendWei: 10n }));
      await journal.markInProgress("k1", { callsId: CALLS_ID });

      const { provider } = readOnlyProvider({
        awaitExecution: async () => ({ status: "FAILED", failureCode: "CAP_EXCEEDED" }),
      });
      const summary = await reconcile({
    minRowAgeMs: 0,
        provider,
        journal,
        resolveWallet: async () => null,
      });

      assert.equal(summary.rolledBack, 1);
      assert.equal((await journal.get("k1"))?.state, "ROLLED_BACK");
      // A rolled-back step releases its reserved native.
      assert.equal(await journal.sumNativeSpendSince(AGENT, NOW - 1), 0n);
      await journal.close();
    });

    it("parks an lp step with no callsId as UNKNOWN and holds it", async () => {
      // The submit window is ambiguous: the step may or may not have reached
      // the relay. The saga above (Rev2 item 9) holds the SEQUENCE on this.
      const journal = await backend.create(() => NOW);
      await journal.begin(lpBegin("k1", { decisionId: "lp:seq-1:1" }));

      const { provider, counters } = readOnlyProvider({});
      const summary = await reconcile({
    minRowAgeMs: 0,
        provider,
        journal,
        resolveWallet: async () => null,
      });

      assert.deepEqual(summary.held, ["k1"]);
      assert.equal(counters.awaits, 0);
      assert.equal(counters.sessionChecks, 0);
      assert.equal((await journal.get("k1"))?.state, "UNKNOWN");
      await journal.close();
    });
  });
}

describe("lp rows and the routes' replay check", () => {
  it("/execute 409s a decisionId already bound to an lp step instead of replaying or resubmitting", async () => {
    const harness = await createHarness({ httpRuntimeProfile: "raw-v1" });
    await harness.journal.begin({
      idempotencyKey: "lp-step-key",
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      kind: "lp",
      decisionId: "lp:seq-9:2",
    });

    const response = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: {
        decisionId: "lp:seq-9:2",
        calls: [{ to: "0x00000000000000000000000000000000000000aa", value: "1", data: "0x" }],
      },
    });

    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), "conflict");
    assert.equal(harness.provider.executeCalls.length, 0, "nothing may be submitted");
  });
});
