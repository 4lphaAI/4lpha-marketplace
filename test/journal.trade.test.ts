/**
 * Journal behaviour Phase 2 depends on, run against BOTH implementations.
 *
 * The memory journal and the Postgres one are two independent pieces of code
 * with one contract, and the parts that matter here — which kinds share a
 * decision namespace, which states hold budget, whether a sum and an insert are
 * atomic — are exactly the parts where a divergence would be a double spend
 * rather than a test failure. So every case runs twice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import {
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  reconcile,
  type ExecutionJournal,
  type JournalKind,
} from "../src/store/journal.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import {
  NotImplementedError,
  type AgentWalletRef,
  type AwaitExecutionParams,
  type ExecuteViaSessionParams,
  type ExecutionReceipt,
  type FourMemeQuote,
  type FlapTokenState,
  type ReadFlapTokenStateParams,
  type GetBalanceParams,
  type GetTokenBalanceParams,
  type GrantSessionParams,
  type IsSessionActiveParams,
  type ReadFourMemeQuoteParams,
  type OwnerRecoverParams,
  type PreflightExecuteParams,
  type OwnerRecoverTokensParams,
  type OwnerRevokeSessionParams,
  type OwnerRevokeSessionResult,
  type ResolveOwnerWalletParams,
  type RestoreSessionParams,
  type RevokeSessionParams,
  type SessionRef,
  type WalletProvider,
} from "../src/core/types.js";

const OWNER = "0x0000000000000000000000000000000000000001";
const AGENT = "agent-1";
const NOW = 1_900_000_000_000;

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

function beginInput(
  key: string,
  overrides: Partial<{
    kind: JournalKind;
    decisionId: string;
    nativeSpendWei: bigint;
    paramsHash: Hex;
  }> = {},
): Parameters<ExecutionJournal["begin"]>[0] {
  return {
    idempotencyKey: key,
    agentId: AGENT,
    ownerAddress: OWNER,
    kind: overrides.kind ?? "trade",
    ...(overrides.decisionId === undefined ? {} : { decisionId: overrides.decisionId }),
    ...(overrides.paramsHash === undefined
      ? {}
      : { externalRef: { paramsHash: overrides.paramsHash } }),
    nativeSpendWei: overrides.nativeSpendWei ?? 0n,
  };
}

for (const backend of BACKENDS) {
  describe(`journal (${backend.label}): decision namespace`, () => {
    it("finds a trade row by decision, not only an execute row", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(beginInput("k1", { kind: "trade", decisionId: "d1" }));
      const found = await journal.getByDecision(AGENT, "d1");
      assert.equal(found?.kind, "trade");
      assert.equal(found?.idempotencyKey, "k1");
      await journal.close();
    });

    it("returns an execute row for a trade lookup and vice versa", async () => {
      // ONE decisionId namespace across both money routes. Anything narrower
      // makes the replay check a no-op for the second route.
      const a = await backend.create(() => NOW);
      await a.begin(beginInput("k1", { kind: "execute", decisionId: "shared" }));
      assert.equal((await a.getByDecision(AGENT, "shared"))?.kind, "execute");
      await a.close();

      const b = await backend.create(() => NOW);
      await b.begin(beginInput("k1", { kind: "trade", decisionId: "shared" }));
      assert.equal((await b.getByDecision(AGENT, "shared"))?.kind, "trade");
      await b.close();
    });

    it("ignores non-money kinds", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(beginInput("k1", { kind: "pause", decisionId: "d1" }));
      assert.equal(await journal.getByDecision(AGENT, "d1"), null);
      await journal.close();
    });

    it("returns the OLDEST row when a decision has several", async () => {
      let now = NOW;
      const journal = await backend.create(() => now);
      await journal.begin(beginInput("older", { decisionId: "d1" }));
      now += 5_000;
      await journal.begin(beginInput("newer", { decisionId: "d1" }));
      assert.equal((await journal.getByDecision(AGENT, "d1"))?.idempotencyKey, "older");
      await journal.close();
    });
  });

  describe(`journal (${backend.label}): native spend accounting`, () => {
    it("counts PENDING, IN_PROGRESS, COMMITTED and UNKNOWN; releases ROLLED_BACK", async () => {
      const journal = await backend.create(() => NOW);

      await journal.begin(beginInput("pending", { nativeSpendWei: 1n }));

      await journal.begin(beginInput("inprogress", { nativeSpendWei: 10n }));
      await journal.markInProgress("inprogress", { callsId: `0x${"11".repeat(32)}` });

      await journal.begin(beginInput("committed", { nativeSpendWei: 100n }));
      await journal.markCommitted("committed");

      await journal.begin(beginInput("unknown", { nativeSpendWei: 1_000n }));
      await journal.markUnknown("unknown", "ambiguous");

      await journal.begin(beginInput("rolledback", { nativeSpendWei: 10_000n }));
      await journal.markRolledBack("rolledback", "failed");

      // 1 + 10 + 100 + 1000; the 10_000 is released.
      assert.equal(await journal.sumNativeSpendSince(AGENT, NOW - 1), 1_111n);
      await journal.close();
    });

    it("excludes rows older than the window and other agents' rows", async () => {
      let now = NOW;
      const journal = await backend.create(() => now);
      await journal.begin(beginInput("old", { nativeSpendWei: 7n }));
      now += 60_000;
      await journal.begin(beginInput("recent", { nativeSpendWei: 3n }));
      await journal.begin({
        idempotencyKey: "other-agent",
        agentId: "agent-2",
        ownerAddress: OWNER,
        kind: "trade",
        nativeSpendWei: 500n,
      });
      assert.equal(await journal.sumNativeSpendSince(AGENT, NOW + 1), 3n);
      assert.equal(await journal.sumNativeSpendSince(AGENT, NOW - 1), 10n);
      await journal.close();
    });

    it("can exclude one row by key", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(beginInput("a", { nativeSpendWei: 5n }));
      await journal.begin(beginInput("b", { nativeSpendWei: 9n }));
      assert.equal(await journal.sumNativeSpendSince(AGENT, NOW - 1, "b"), 5n);
      await journal.close();
    });

    it("round-trips a full uint256 without losing wei", async () => {
      const journal = await backend.create(() => NOW);
      const huge = 2n ** 200n + 12_345n;
      await journal.begin(beginInput("huge", { nativeSpendWei: huge }));
      assert.equal((await journal.get("huge"))?.nativeSpendWei, huge);
      assert.equal(await journal.sumNativeSpendSince(AGENT, NOW - 1), huge);
      await journal.close();
    });
  });

  describe(`journal (${backend.label}): beginWithSpend is a reservation`, () => {
    it("reports only OTHER rows' spend", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(beginInput("first", { nativeSpendWei: 40n }));
      const { entry, otherSpendWei } = await journal.beginWithSpend(
        beginInput("second", { nativeSpendWei: 60n }),
        NOW - 1,
      );
      assert.equal(entry.state, "PENDING");
      assert.equal(otherSpendWei, 40n, "its own row must not be double counted");
      await journal.close();
    });

    it("serializes two concurrent begins: the second sees the first", async () => {
      const journal = await backend.create(() => NOW);
      const [a, b] = await Promise.all([
        journal.beginWithSpend(beginInput("a", { nativeSpendWei: 600n }), NOW - 1),
        journal.beginWithSpend(beginInput("b", { nativeSpendWei: 600n }), NOW - 1),
      ]);
      const seen = [a.otherSpendWei, b.otherSpendWei].toSorted();
      assert.deepEqual(
        seen,
        [0n, 600n],
        "exactly one of two concurrent trades may observe an empty ledger",
      );
      await journal.close();
    });

    it("returns the existing row for a repeated key", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin(beginInput("k", { nativeSpendWei: 5n }));
      await journal.markCommitted("k");
      const again = await journal.beginWithSpend(
        beginInput("k", { nativeSpendWei: 999n }),
        NOW - 1,
      );
      assert.equal(again.entry.state, "COMMITTED");
      assert.equal(again.entry.nativeSpendWei, 5n, "a retry must not re-price the row");
      await journal.close();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Reconcile                                                                  */
/* -------------------------------------------------------------------------- */

class ScriptedProvider implements WalletProvider {
  awaitCalls = 0;
  sessionActiveCalls = 0;
  nextAwait: ExecutionReceipt = { status: "PENDING" };
  sessionActive = true;

  async awaitExecution(_params: AwaitExecutionParams): Promise<ExecutionReceipt> {
    this.awaitCalls += 1;
    return this.nextAwait;
  }
  async isSessionActive(_params: IsSessionActiveParams): Promise<boolean> {
    this.sessionActiveCalls += 1;
    return this.sessionActive;
  }
  restoreSession(_params: RestoreSessionParams): SessionRef {
    throw new NotImplementedError("unused");
  }
  async preflightExecute(_p: PreflightExecuteParams): Promise<void> {
    throw new NotImplementedError("unused");
  }
  async executeViaSession(_p: ExecuteViaSessionParams): Promise<ExecutionReceipt> {
    throw new NotImplementedError("unused");
  }
  async resolveOwnerWallet(_p: ResolveOwnerWalletParams): Promise<AgentWalletRef> {
    throw new NotImplementedError("unused");
  }
  async grantSession(_p: GrantSessionParams): Promise<SessionRef> {
    throw new NotImplementedError("unused");
  }
  async revokeSession(_p: RevokeSessionParams): Promise<ExecutionReceipt> {
    throw new NotImplementedError("unused");
  }
  async ownerRevokeSession(
    _p: OwnerRevokeSessionParams,
  ): Promise<OwnerRevokeSessionResult> {
    throw new NotImplementedError("unused");
  }
  async getBalance(_p: GetBalanceParams): Promise<bigint> {
    throw new NotImplementedError("unused");
  }
  async getTokenBalance(_p: GetTokenBalanceParams): Promise<bigint> {
    throw new NotImplementedError("unused");
  }
  async readFourMemeQuote(_p: ReadFourMemeQuoteParams): Promise<FourMemeQuote> {
    throw new NotImplementedError("unused");
  }
  async readFlapTokenState(_p: ReadFlapTokenStateParams): Promise<FlapTokenState> {
    throw new NotImplementedError("unused");
  }
  async canSessionSellToken(): Promise<boolean> {
    return true;
  }
  async ownerRecoverNative(_p: OwnerRecoverParams): Promise<ExecutionReceipt> {
    throw new NotImplementedError("unused");
  }
  async ownerRecoverTokens(
    _p: OwnerRecoverTokensParams,
  ): Promise<readonly ExecutionReceipt[]> {
    throw new NotImplementedError("unused");
  }
}

const WALLET: AgentWalletRef = {
  address: "0x0000000000000000000000000000000000000002",
  chainId: 56,
  ownerAddress: OWNER,
  custodyModel: "self-eoa",
};

describe("reconcile: trade rows", () => {
  it("resolves a crashed trade row through awaitExecution", async () => {
    const journal = new MemoryExecutionJournal(() => NOW);
    const provider = new ScriptedProvider();
    provider.nextAwait = {
      status: "CONFIRMED",
      transactionHash: `0x${"ab".repeat(32)}`,
    };
    await journal.begin(beginInput("k", { kind: "trade", decisionId: "d" }));
    await journal.markInProgress("k", { callsId: `0x${"c1".repeat(32)}` });

    const summary = await reconcile({
    minRowAgeMs: 0,
      provider,
      journal,
      resolveWallet: async () => WALLET,
    });
    assert.equal(summary.committed, 1);
    assert.equal(provider.awaitCalls, 1);
    assert.equal(provider.sessionActiveCalls, 0, "a trade is not a session check");
    assert.equal((await journal.get("k"))?.state, "COMMITTED");
  });

  it("holds a trade row with no callsId rather than guessing", async () => {
    const journal = new MemoryExecutionJournal(() => NOW);
    const provider = new ScriptedProvider();
    await journal.begin(beginInput("k", { kind: "trade" }));

    const summary = await reconcile({
    minRowAgeMs: 0,
      provider,
      journal,
      resolveWallet: async () => WALLET,
    });
    assert.deepEqual(summary.held, ["k"]);
    assert.equal((await journal.get("k"))?.state, "UNKNOWN");
  });

  it("NEVER commits a trade row on the strength of a live session", async () => {
    // The F4 defect: a trade row falling into the grant/revoke branch resolves
    // by asking whether the session is active. It always is.
    const journal = new MemoryExecutionJournal(() => NOW);
    const provider = new ScriptedProvider();
    provider.sessionActive = true;
    await journal.begin({
      idempotencyKey: "k",
      agentId: AGENT,
      ownerAddress: OWNER,
      kind: "trade",
      externalRef: { publicKey: `0x04${"ab".repeat(64)}` },
      nativeSpendWei: 10n,
    });

    const summary = await reconcile({
    minRowAgeMs: 0,
      provider,
      journal,
      resolveWallet: async () => WALLET,
    });
    assert.equal(summary.committed, 0);
    assert.deepEqual(summary.held, ["k"]);
    assert.equal((await journal.get("k"))?.state, "UNKNOWN");
  });

  it("parks an unrecognized kind as UNKNOWN", async () => {
    const journal = new MemoryExecutionJournal(() => NOW);
    const provider = new ScriptedProvider();
    provider.sessionActive = true;
    await journal.begin({
      idempotencyKey: "k",
      agentId: AGENT,
      ownerAddress: OWNER,
      // A row written by a future version, or a corrupted one. There is no safe
      // guess, and a fallthrough must never produce COMMITTED.
      kind: "swap" as JournalKind,
      externalRef: {
        publicKey: `0x04${"ab".repeat(64)}`,
        callsId: `0x${"c1".repeat(32)}`,
      },
    });

    const summary = await reconcile({
    minRowAgeMs: 0,
      provider,
      journal,
      resolveWallet: async () => WALLET,
    });
    assert.equal(summary.committed, 0);
    assert.equal(summary.rolledBack, 0);
    assert.deepEqual(summary.held, ["k"]);
    assert.equal(provider.awaitCalls, 0);
    assert.equal(provider.sessionActiveCalls, 0);
  });

  it("rolls a trade row back when the chain reports FAILED", async () => {
    const journal = new MemoryExecutionJournal(() => NOW);
    const provider = new ScriptedProvider();
    provider.nextAwait = { status: "FAILED", failureCode: "CAP_EXCEEDED" };
    await journal.begin(beginInput("k", { kind: "trade" }));
    await journal.markInProgress("k", { callsId: `0x${"c1".repeat(32)}` });

    const summary = await reconcile({
    minRowAgeMs: 0,
      provider,
      journal,
      resolveWallet: async () => WALLET,
    });
    assert.equal(summary.rolledBack, 1);
    // A rolled-back row releases its reserved spend.
    assert.equal(await journal.sumNativeSpendSince(AGENT, NOW - 1), 0n);
  });
});
