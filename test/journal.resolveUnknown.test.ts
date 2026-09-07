/**
 * The journal's operator half of UNKNOWN (PHASE3.3; `PHASE3.3-REVIEW.md`
 * Revision 2 items 4, 5, 7, 13, 17, and the item-19 test list).
 *
 * The review's R1 is the reason this file exists: the first draft claimed
 * "nothing else changes", and the journal PHYSICALLY COULD NOT leave `UNKNOWN`
 * — `assertTransition` gave it an empty legal set and both `markCommitted` and
 * `markRolledBack` threw on an UNKNOWN row, on both backends. Everything below
 * pins the shape of the one relaxation, and above all pins that it has NOT
 * leaked: the two ordinary terminal writes must still throw.
 *
 * Every case runs against BOTH implementations, for the PHASE2 F3 reason.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOCAL_ONLY_KINDS,
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  boundResolutionEvidence,
  reconcile,
  type ExecutionJournal,
  type JournalResolutionEvidence,
} from "../src/store/journal.js";
import type { ExecutionReceipt, WalletProvider } from "../src/core/types.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = "0x0000000000000000000000000000000000000001";
const AGENT = "agent-1";
const NOW = 1_900_000_000_000;

type Backend = {
  readonly label: string;
  create(now: () => number): Promise<ExecutionJournal>;
};

const BACKENDS: readonly Backend[] = [
  { label: "memory", create: async (now) => new MemoryExecutionJournal(now) },
  {
    label: "postgres(fake sql)",
    create: (now) => PostgresExecutionJournal.create(new FakeSqlClient(), now),
  },
];

function evidence(
  overrides: Partial<JournalResolutionEvidence> = {},
): JournalResolutionEvidence {
  return {
    action: "resolveUnknown",
    at: NOW,
    ownerAddress: OWNER,
    observedBlock: "116391700",
    serverBlock: "116391701",
    checks: [{ name: "age", result: "43000s >= 1800s" }],
    legs: [
      {
        token: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        neededWei: "13443686488",
        walletWei: "13443686488",
        discriminating: true,
      },
    ],
    logAbsence: { checked: false, detail: "no capability-probed endpoint" },
    disposition: "abandoned harvest sequence at step 2 (zap-in-increase)",
    ...overrides,
  };
}

/** A provider that proves reconcile never submits anything. */
function readOnlyProvider(): WalletProvider {
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
    awaitExecution: async () => ({ status: "PENDING" }) satisfies ExecutionReceipt,
    isSessionActive: async () => true,
    revokeSession: unreachable("revokeSession"),
    ownerRevokeSession: unreachable("ownerRevokeSession"),
    getBalance: unreachable("getBalance"),
    getTokenBalance: unreachable("getTokenBalance"),
    ownerRecoverNative: unreachable("ownerRecoverNative"),
    ownerRecoverTokens: unreachable("ownerRecoverTokens"),
  } as unknown as WalletProvider;
}

describe("journal resolveUnknown: the kind joins LOCAL_ONLY_KINDS", () => {
  it("is local-only, so an interrupted resolution is closed out and not parked (Rev2 item 7)", () => {
    assert.equal(LOCAL_ONLY_KINDS.has("resolveUnknown"), true);
  });
});

for (const backend of BACKENDS) {
  describe(`journal resolveUnknown (${backend.label}): the one relaxation`, () => {
    it("moves an UNKNOWN row to ROLLED_BACK and records the evidence", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
        decisionId: "lp:seq-1:2",
      });
      await journal.markUnknown("k1", "The relay did not answer within 45000ms.");

      const resolved = await journal.resolveUnknown("k1", evidence());
      assert.equal(resolved.state, "ROLLED_BACK");
      assert.equal(resolved.externalRef.resolution?.action, "resolveUnknown");
      assert.equal(resolved.externalRef.resolution?.legs[0]?.discriminating, true);
      await journal.close();
    });

    it("PRESERVES last_error — the reason the row went UNKNOWN is history (Rev2 item 17)", async () => {
      const journal = await backend.create(() => NOW);
      const reason = "The relay did not answer within 45000ms. Whether it accepted the submission is UNKNOWN.";
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("k1", reason);

      const resolved = await journal.resolveUnknown("k1", evidence());
      assert.equal(resolved.lastError, reason);
      const reread = await journal.get("k1");
      assert.equal(reread?.lastError, reason);
      await journal.close();
    });

    it("keeps the other external-ref fields — the merge drops nothing (R18)", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
        externalRef: {
          callsHash: `0x${"b3".repeat(32)}`,
          publicKey: `0x04${"ab".repeat(64)}`,
        },
      });
      await journal.markUnknown("k1", "held");

      const resolved = await journal.resolveUnknown("k1", evidence());
      assert.equal(resolved.externalRef.callsHash, `0x${"b3".repeat(32)}`);
      assert.equal(resolved.externalRef.publicKey, `0x04${"ab".repeat(64)}`);
      assert.notEqual(resolved.externalRef.resolution, undefined);
      await journal.close();
    });

    it("REFUSES a row that is not UNKNOWN — it asserts the state itself (R1)", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k-committed",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markCommitted("k-committed");
      await assert.rejects(
        () => journal.resolveUnknown("k-committed", evidence()),
        /not UNKNOWN/u,
      );

      await journal.begin({
        idempotencyKey: "k-pending",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await assert.rejects(
        () => journal.resolveUnknown("k-pending", evidence()),
        /not UNKNOWN/u,
      );
      await journal.close();
    });

    it("refuses a second resolution — its write is the LAST one on the row", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("k1", "held");
      await journal.resolveUnknown("k1", evidence());
      await assert.rejects(() => journal.resolveUnknown("k1", evidence()), /not UNKNOWN/u);
      await journal.close();
    });

    it("throws on a row that does not exist", async () => {
      const journal = await backend.create(() => NOW);
      await assert.rejects(() => journal.resolveUnknown("nope", evidence()), /does not exist/u);
      await journal.close();
    });
  });

  describe(`journal advanceUnknown (${backend.label}): PHASE3.9a's second named edge`, () => {
    it("moves UNKNOWN to COMMITTED, preserves history/refs, and keeps spend counted", async () => {
      const journal = await backend.create(() => NOW);
      const callsHash = `0x${"b3".repeat(32)}` as const;
      const publicKey = `0x04${"ab".repeat(64)}` as const;
      const txHash = `0x${"cd".repeat(32)}` as const;
      const reason = "relay timeout; landing was unknown";
      await journal.begin({
        idempotencyKey: "advanced",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
        nativeSpendWei: 5n,
        externalRef: { callsHash, publicKey },
      });
      await journal.markUnknown("advanced", reason);

      const advanced = await journal.advanceUnknown(
        "advanced",
        evidence({
          disposition: "advanced manual-exit zap-out on finalized position evidence",
          positionEvidenceBlock: "116391690",
        }),
        { txHash },
      );
      assert.equal(advanced.state, "COMMITTED");
      assert.equal(advanced.lastError, reason);
      assert.equal(advanced.externalRef.callsHash, callsHash);
      assert.equal(advanced.externalRef.publicKey, publicKey);
      assert.equal(advanced.externalRef.txHash, txHash);
      assert.equal(
        advanced.externalRef.resolution?.positionEvidenceBlock,
        "116391690",
      );
      assert.equal(await journal.sumNativeSpendSince(AGENT, 0), 5n);

      const reread = await journal.get("advanced");
      assert.equal(reread?.state, "COMMITTED");
      assert.equal(reread?.lastError, reason);
      await journal.close();
    });

    it("refuses a second advance and every non-UNKNOWN source state", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "once",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("once", "held");
      await journal.advanceUnknown("once", evidence());
      await assert.rejects(
        () => journal.advanceUnknown("once", evidence()),
        /not UNKNOWN/u,
      );

      await journal.begin({
        idempotencyKey: "pending",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await assert.rejects(
        () => journal.advanceUnknown("pending", evidence()),
        /not UNKNOWN/u,
      );
      assert.equal((await journal.get("pending"))?.state, "PENDING");
      await journal.close();
    });

    it("does not leak through ordinary markCommitted", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "ordinary",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("ordinary", "held");
      await assert.rejects(
        () => journal.markCommitted("ordinary"),
        /Illegal journal transition UNKNOWN/u,
      );
      assert.equal((await journal.get("ordinary"))?.state, "UNKNOWN");
      await journal.close();
    });
  });

  describe(`journal markRolledBack (${backend.label}): A7's refusal evidence`, () => {
    it("carries an externalRef onto the ACTION's own row, merged, without widening anything", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "action-1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "resolveUnknown",
        externalRef: { publicKey: `0x04${"ab".repeat(64)}` },
      });

      const refused = await journal.markRolledBack("action-1", "unresolvable: …", {
        resolution: evidence({ disposition: "refused:unresolvable" }),
      });
      assert.equal(refused.state, "ROLLED_BACK");
      assert.equal(refused.externalRef.resolution?.disposition, "refused:unresolvable");
      // The ref seeded at `begin` survived the merge.
      assert.equal(refused.externalRef.publicKey, `0x04${"ab".repeat(64)}`);
      assert.equal(refused.lastError, "unresolvable: …");

      const reread = await journal.get("action-1");
      assert.equal(reread?.externalRef.resolution?.disposition, "refused:unresolvable");
      await journal.close();
    });

    it("still cannot move an UNKNOWN row, ref or no ref (the R1 leak, again)", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("k1", "held");
      await assert.rejects(
        () =>
          journal.markRolledBack("k1", "sneaking in", {
            resolution: evidence(),
          }),
        /Illegal journal transition UNKNOWN/u,
      );
      assert.equal((await journal.get("k1"))?.state, "UNKNOWN");
      await journal.close();
    });
  });

  describe(`journal resolveUnknown (${backend.label}): the relaxation has NOT leaked`, () => {
    it("markCommitted STILL throws on an UNKNOWN row (R1, the reconcile leak)", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("k1", "held");
      await assert.rejects(
        () => journal.markCommitted("k1"),
        /Illegal journal transition UNKNOWN/u,
      );
      await journal.close();
    });

    it("markRolledBack STILL throws on an UNKNOWN row", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("k1", "held");
      await assert.rejects(
        () => journal.markRolledBack("k1", "nope"),
        /Illegal journal transition UNKNOWN/u,
      );
      await journal.close();
    });

    it("reconcile leaves an UNKNOWN row alone: listNonTerminal never yields one", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
      });
      await journal.markUnknown("k1", "held");

      const summary = await reconcile({
    minRowAgeMs: 0,
        provider: readOnlyProvider(),
        journal,
        resolveWallet: async () => null,
      });
      assert.deepEqual(summary, { committed: 0, rolledBack: 0, held: [], skippedYoung: 0 });
      assert.equal((await journal.get("k1"))?.state, "UNKNOWN");
      await journal.close();
    });

    it("reconcile CLOSES OUT an interrupted resolveUnknown row rather than parking it (Rev2 item 7)", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "own-row",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "resolveUnknown",
      });

      const summary = await reconcile({
    minRowAgeMs: 0,
        provider: readOnlyProvider(),
        journal,
        resolveWallet: async () => null,
      });
      assert.equal(summary.rolledBack, 1);
      assert.deepEqual(summary.held, []);
      assert.equal((await journal.get("own-row"))?.state, "ROLLED_BACK");
      await journal.close();
    });
  });

  describe(`journal resolveUnknown (${backend.label}): budget`, () => {
    it("releases the row's spend — which is exactly why a non-zero row is refused upstream (Rev2 item 13)", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "k1",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
        nativeSpendWei: 5n,
      });
      await journal.markUnknown("k1", "held");
      assert.equal(await journal.sumNativeSpendSince(AGENT, 0), 5n);

      await journal.resolveUnknown("k1", evidence());
      assert.equal(await journal.sumNativeSpendSince(AGENT, 0), 0n);
      await journal.close();
    });

    it("leaves the daily-cap sum UNCHANGED for a zero-native resolution (item 19)", async () => {
      const journal = await backend.create(() => NOW);
      await journal.begin({
        idempotencyKey: "other",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
        nativeSpendWei: 7n,
      });
      await journal.begin({
        idempotencyKey: "stuck",
        agentId: AGENT,
        ownerAddress: OWNER,
        kind: "lp",
        nativeSpendWei: 0n,
      });
      await journal.markUnknown("stuck", "held");
      const before = await journal.sumNativeSpendSince(AGENT, 0);

      await journal.resolveUnknown("stuck", evidence());
      assert.equal(await journal.sumNativeSpendSince(AGENT, 0), before);
      assert.equal(before, 7n);
      await journal.close();
    });
  });
}

describe("journal resolveUnknown: the evidence is size-bounded (R18)", () => {
  it("clamps long strings and long lists rather than growing the jsonb without limit", () => {
    const bounded = boundResolutionEvidence(
      evidence({
        disposition: "x".repeat(1_000),
        checks: Array.from({ length: 100 }, (_, index) => ({
          name: `check-${index}`,
          result: "y".repeat(1_000),
        })),
        legs: Array.from({ length: 100 }, () => ({
          token: "0x00",
          neededWei: "1",
          walletWei: "1",
          discriminating: false,
        })),
      }),
    );
    assert.equal(bounded.disposition.length, 200);
    assert.equal(bounded.checks.length, 24);
    assert.equal(bounded.checks[0]?.result.length, 200);
    assert.equal(bounded.legs.length, 24);
  });
});
