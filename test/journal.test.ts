/**
 * Offline tests for the execution journal.
 *
 * The two golden properties, protected directly:
 *   - IDEMPOTENCY: a second begin with the same key returns the existing row and
 *     never creates a duplicate or re-runs the work;
 *   - AMBIGUOUS → UNKNOWN, HELD: a crash window resolves to UNKNOWN, reconcile
 *     never re-submits, and it never auto-advances an UNKNOWN row.
 *
 * The state machine and reconcile run against both backends (memory and
 * Postgres-over-fake). Reconcile is driven by a fake provider whose
 * awaitExecution / isSessionActive are pure reads — proving nothing is
 * re-submitted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import {
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  reconcile,
  type ExecutionJournal,
  type JournalBeginInput,
} from "../src/store/journal.js";
import type {
  AgentWalletRef,
  ExecutionReceipt,
  WalletProvider,
} from "../src/core/types.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4").toLowerCase();
const WALLET: AgentWalletRef = {
  address: getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4"),
  chainId: 97,
  ownerAddress: getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4"),
  custodyModel: "self-eoa",
};
const CALLS_ID = `0x${"cc".repeat(32)}` as Hex;
const PUBLIC_KEY = `0x${"ab".repeat(64)}` as Hex;

function beginInput(overrides: Partial<JournalBeginInput> = {}): JournalBeginInput {
  return {
    idempotencyKey: "op-1",
    agentId: "agent-1",
    ownerAddress: OWNER,
    kind: "execute",
    ...overrides,
  };
}

let clock = 5_000;
const nextClock = (): number => (clock += 1);

type Factory = { name: string; make: () => Promise<ExecutionJournal> };
const FACTORIES: readonly Factory[] = [
  { name: "memory", make: async () => new MemoryExecutionJournal(nextClock) },
  {
    name: "postgres(fake)",
    make: async () => PostgresExecutionJournal.create(new FakeSqlClient(), nextClock),
  },
];

/**
 * A provider stub for reconcile. Only the two read methods are exercised; the
 * rest throw so a test that accidentally reaches them fails loudly — and so no
 * write path can be invoked from reconcile.
 */
function fakeProvider(overrides: {
  awaitExecution?: (callsId: Hex) => Promise<ExecutionReceipt>;
  isSessionActive?: () => Promise<boolean>;
}): WalletProvider {
  const unreachable = (name: string) => async () => {
    throw new Error(`reconcile must not call ${name}`);
  };
  return {
    resolveOwnerWallet: unreachable("resolveOwnerWallet"),
    grantSession: unreachable("grantSession"),
    restoreSession: () => {
      throw new Error("reconcile must not call restoreSession");
    },
    executeViaSession: unreachable("executeViaSession"),
    awaitExecution: async ({ callsId }: { callsId: Hex }) =>
      overrides.awaitExecution === undefined
        ? { status: "PENDING", callsId }
        : overrides.awaitExecution(callsId),
    isSessionActive: async () =>
      overrides.isSessionActive === undefined ? false : overrides.isSessionActive(),
    revokeSession: unreachable("revokeSession"),
    ownerRevokeSession: unreachable("ownerRevokeSession"),
    getBalance: unreachable("getBalance"),
    getTokenBalance: unreachable("getTokenBalance"),
    ownerRecoverNative: unreachable("ownerRecoverNative"),
    ownerRecoverTokens: unreachable("ownerRecoverTokens"),
  } as unknown as WalletProvider;
}

const noWallet = async () => null;
const resolvesWallet = async () => WALLET;

for (const factory of FACTORIES) {
  describe(`ExecutionJournal — ${factory.name}`, () => {
    it("dedupes a repeated begin: same key twice yields one row, no re-run", async () => {
      const journal = await factory.make();
      const first = await journal.begin(beginInput());
      const second = await journal.begin(beginInput({ agentId: "IGNORED" }));

      assert.equal(first.state, "PENDING");
      // The second begin returns the ORIGINAL row, not a new one.
      assert.equal(second.agentId, "agent-1");
      assert.equal(second.createdAt, first.createdAt);
      const nonTerminal = await journal.listNonTerminal();
      assert.equal(nonTerminal.length, 1);
      await journal.close();
    });

    it("walks a normal PENDING → IN_PROGRESS → COMMITTED path", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput());
      await journal.markInProgress("op-1", { callsId: CALLS_ID });
      const committed = await journal.markCommitted("op-1", { txHash: `0x${"12".repeat(32)}` as Hex });

      assert.equal(committed.state, "COMMITTED");
      assert.equal(committed.externalRef.callsId, CALLS_ID);
      assert.match(committed.externalRef.txHash ?? "", /^0x/);
      // Terminal rows drop out of the reconcile worklist.
      assert.equal((await journal.listNonTerminal()).length, 0);
      await journal.close();
    });

    it("rejects an illegal transition out of a terminal state", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput());
      await journal.markRolledBack("op-1", "gave up");
      await assert.rejects(journal.markCommitted("op-1"), /Illegal journal transition/);
      await journal.close();
    });

    it("serializes concurrent same-key begins into a single row", async () => {
      const journal = await factory.make();
      const [a, b] = await Promise.all([
        journal.begin(beginInput()),
        journal.begin(beginInput()),
      ]);
      assert.equal(a.createdAt, b.createdAt);
      assert.equal((await journal.listNonTerminal()).length, 1);
      await journal.close();
    });

    it("seeds the calls hash at begin so a decision's binding survives a crash", async () => {
      const journal = await factory.make();
      const callsHash: Hex = `0x${"9e".repeat(32)}`;
      await journal.begin(
        beginInput({ decisionId: "decision-1", externalRef: { callsHash } }),
      );

      const found = await journal.getByDecision("agent-1", "decision-1");
      assert.equal(found?.idempotencyKey, "op-1");
      assert.equal(found?.decisionId, "decision-1");
      // This is what a conflicting second submit is compared against.
      assert.equal(found?.externalRef.callsHash, callsHash);
      await journal.close();
    });

    it("scopes getByDecision to the agent, and to execute rows only", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput({ decisionId: "d1" }));
      await journal.begin(
        beginInput({ idempotencyKey: "op-pause", kind: "pause", decisionId: "d1" }),
      );

      assert.equal((await journal.getByDecision("agent-1", "d1"))?.kind, "execute");
      assert.equal(await journal.getByDecision("agent-2", "d1"), null);
      assert.equal(await journal.getByDecision("agent-1", "d2"), null);
      await journal.close();
    });

    it("closes out an interrupted local-only owner action rather than holding it", async () => {
      // A pause touches no chain and moves no funds, so there is nothing
      // ambiguous for an operator to adjudicate — holding it would only add
      // noise to a queue that must stay about money.
      const journal = await factory.make();
      await journal.begin(beginInput({ idempotencyKey: "op-pause", kind: "pause" }));

      const summary = await reconcile({
    minRowAgeMs: 0,
        provider: fakeProvider({}),
        journal,
        resolveWallet: noWallet,
      });

      assert.equal(summary.held.length, 0);
      assert.equal(summary.rolledBack, 1);
      assert.equal((await journal.get("op-pause"))?.state, "ROLLED_BACK");
      await journal.close();
    });
  });

  describe(`reconcile — ${factory.name}`, () => {
    it("resolves an IN_PROGRESS execute to COMMITTED WITHOUT re-submitting", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput());
      await journal.markInProgress("op-1", { callsId: CALLS_ID });

      let polls = 0;
      const provider = fakeProvider({
        awaitExecution: async (callsId) => {
          polls += 1;
          return { status: "CONFIRMED", callsId, transactionHash: `0x${"aa".repeat(32)}` as Hex };
        },
      });
      const summary = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: noWallet });

      assert.equal(summary.committed, 1);
      assert.equal(polls, 1); // polled once; never re-submitted.
      assert.equal((await journal.get("op-1"))?.state, "COMMITTED");
      await journal.close();
    });

    it("rolls back an execute the relay reports FAILED", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput());
      await journal.markInProgress("op-1", { callsId: CALLS_ID });

      const provider = fakeProvider({
        awaitExecution: async () => ({ status: "FAILED", failureCode: "CAP_EXCEEDED" }),
      });
      const summary = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: noWallet });

      assert.equal(summary.rolledBack, 1);
      const row = await journal.get("op-1");
      assert.equal(row?.state, "ROLLED_BACK");
      assert.equal(row?.lastError, "CAP_EXCEEDED");
      await journal.close();
    });

    it("parks a still-pending execute as UNKNOWN and never advances it again", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput());
      await journal.markInProgress("op-1", { callsId: CALLS_ID });

      const provider = fakeProvider({
        awaitExecution: async (callsId) => ({ status: "PENDING", callsId }),
      });
      const first = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: noWallet });
      assert.deepEqual(first.held, ["op-1"]);
      assert.equal((await journal.get("op-1"))?.state, "UNKNOWN");

      // A second pass must not touch the UNKNOWN row — it is out of the worklist.
      const second = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: noWallet });
      assert.equal(second.committed, 0);
      assert.equal(second.rolledBack, 0);
      assert.equal(second.held.length, 0);
      await journal.close();
    });

    it("parks a PENDING row with no external reference as UNKNOWN (ambiguous window)", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput());
      // Never marked in progress: it may or may not have been submitted.
      const provider = fakeProvider({});
      const summary = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: noWallet });
      assert.deepEqual(summary.held, ["op-1"]);
      assert.equal((await journal.get("op-1"))?.state, "UNKNOWN");
      await journal.close();
    });

    it("commits a grant observed active on-chain", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput({ kind: "grant" }));
      await journal.markInProgress("op-1", { publicKey: PUBLIC_KEY });

      const provider = fakeProvider({ isSessionActive: async () => true });
      const summary = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: resolvesWallet });
      assert.equal(summary.committed, 1);
      assert.equal((await journal.get("op-1"))?.state, "COMMITTED");
      await journal.close();
    });

    it("commits a revoke once the session reads inactive", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput({ kind: "revoke" }));
      await journal.markInProgress("op-1", { publicKey: PUBLIC_KEY });

      const provider = fakeProvider({ isSessionActive: async () => false });
      const summary = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: resolvesWallet });
      assert.equal(summary.committed, 1);
      await journal.close();
    });

    it("holds a grant that is not yet observed active", async () => {
      const journal = await factory.make();
      await journal.begin(beginInput({ kind: "grant" }));
      await journal.markInProgress("op-1", { publicKey: PUBLIC_KEY });

      const provider = fakeProvider({ isSessionActive: async () => false });
      const summary = await reconcile({
    minRowAgeMs: 0, provider, journal, resolveWallet: resolvesWallet });
      assert.deepEqual(summary.held, ["op-1"]);
      await journal.close();
    });
  });
}
