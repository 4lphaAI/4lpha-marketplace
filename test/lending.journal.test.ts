/**
 * The lending journal kinds, at ALL SIX hand-maintained sites
 * (MARKETPLACE-LENDING-AGENT R2.1, closing REVIEW B1).
 *
 * `JournalKind`'s own docstring names six places a new kind lands, and this
 * repo has walked into the same trap three times: a kind missing from
 * {@link LOCAL_ONLY_KINDS} parks every interrupted owner action as a permanent
 * `UNKNOWN` that no resolver can clear, and a money kind missing from the
 * `getByDecision` filter lets a decision id be reused on a second route with
 * the replay check silently passing.
 *
 * Both backends are exercised, because the Postgres filter and the fake SQL
 * client's copy of it are TWO HAND-WRITTEN LISTS and their agreement is the
 * only thing that makes the offline suite evidence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import { FakeSqlClient } from "./support/fakeSql.js";
import {
  LOCAL_ONLY_KINDS,
  MONEY_KINDS,
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  reconcile,
  type ExecutionJournal,
} from "../src/store/journal.js";
import type { ExecutionReceipt, WalletProvider } from "../src/core/types.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { submitLendingBatch } from "../src/lending/execute.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AGENT = "lending-journal-agent";

describe("R2.1 — the four kinds and their memberships", () => {
  it("the THREE owner actions are LOCAL_ONLY and none is a money kind", () => {
    for (const kind of ["lendingArm", "lendingSettings", "lendingRetire"] as const) {
      assert.ok(
        LOCAL_ONLY_KINDS.has(kind),
        `${kind} must be LOCAL_ONLY: ownerMutation journals a row of the route's kind `
        + "unconditionally, and a kind missing here parks every interrupted action as a "
        + "permanent UNKNOWN that resolveUnknown refuses (it verifies `lp` rows only)",
      );
      assert.ok(!MONEY_KINDS.has(kind));
    }
  });

  it("`lending` is the ONE money kind, and is NOT local-only", () => {
    assert.ok(MONEY_KINDS.has("lending"));
    assert.ok(!LOCAL_ONLY_KINDS.has("lending"));
  });

  it("`lendingRescue` does NOT exist as a kind — one namespace, one kind", () => {
    assert.ok(![...MONEY_KINDS].includes("lendingRescue" as never));
    assert.ok(![...LOCAL_ONLY_KINDS].includes("lendingRescue" as never));
  });
});

describe("the decision-id namespace is SHARED across every money route", () => {
  for (const backend of ["memory", "postgres(fake)"] as const) {
    it(`${backend}: getByDecision finds a \`lending\` row`, async () => {
      const journal: ExecutionJournal =
        backend === "memory"
          ? new MemoryExecutionJournal(() => 1_000)
          : await PostgresExecutionJournal.create(new FakeSqlClient(), () => 1_000);
      await journal.begin({
        idempotencyKey: `${AGENT}:lending:${AGENT}:0:1`,
        agentId: AGENT, ownerAddress: OWNER, kind: "lending",
        decisionId: `lending:${AGENT}:0:1`,
      });
      const found = await journal.getByDecision(AGENT, `lending:${AGENT}:0:1`);
      assert.equal(
        found?.kind, "lending",
        "without the kind in the filter, a decision id could be reused on a second route",
      );
      await journal.close();
    });

    it(`${backend}: a LOCAL_ONLY lending row is NOT in the decision namespace`, async () => {
      const journal: ExecutionJournal =
        backend === "memory"
          ? new MemoryExecutionJournal(() => 1_000)
          : await PostgresExecutionJournal.create(new FakeSqlClient(), () => 1_000);
      await journal.begin({
        idempotencyKey: "owner-action-key",
        agentId: AGENT, ownerAddress: OWNER, kind: "lendingArm",
        decisionId: `lending:${AGENT}:arm:1`,
      });
      assert.equal(
        await journal.getByDecision(AGENT, `lending:${AGENT}:arm:1`),
        null,
        "the owner-action row carries no money and must not occupy the namespace",
      );
      await journal.close();
    });
  }
});

describe("reconcile's sixth site — `resolveRow`'s callsId branch", () => {
  function provider(receipt: ExecutionReceipt): WalletProvider {
    return {
      async awaitExecution() { return receipt; },
      async isSessionActive() { return true; },
    } as unknown as WalletProvider;
  }

  async function seed(state: "in-progress" | "no-calls-id") {
    const journal = new MemoryExecutionJournal(() => 1_000);
    const key = `${AGENT}:lending:${AGENT}:0:1`;
    await journal.begin({
      idempotencyKey: key, agentId: AGENT, ownerAddress: OWNER,
      kind: "lending", decisionId: `lending:${AGENT}:0:1`,
    });
    if (state === "in-progress") {
      await journal.markInProgress(key, { callsId: `0x${"cd".repeat(32)}` as Hex });
    }
    return { journal, key };
  }

  it("resolves a CONFIRMED lending row from its callsId", async () => {
    const { journal, key } = await seed("in-progress");
    await reconcile({
      provider: provider({
        status: "CONFIRMED", transactionHash: `0x${"ab".repeat(32)}`,
      } as ExecutionReceipt),
      journal,
      resolveWallet: async () => null,
    });
    assert.equal((await journal.get(key))?.state, "COMMITTED");
  });

  it("rolls a FAILED lending row back — an answered FAILED is never UNKNOWN", async () => {
    const { journal, key } = await seed("in-progress");
    await reconcile({
      provider: provider({ status: "FAILED", failureCode: "REVERT" } as unknown as ExecutionReceipt),
      journal,
      resolveWallet: async () => null,
    });
    assert.equal((await journal.get(key))?.state, "ROLLED_BACK");
  });

  it("holds a lending row with NO callsId as UNKNOWN, never COMMITTED", async () => {
    const { journal, key } = await seed("no-calls-id");
    await reconcile({
      provider: provider({ status: "CONFIRMED" } as ExecutionReceipt),
      journal,
      resolveWallet: async () => null,
    });
    assert.equal(
      (await journal.get(key))?.state, "UNKNOWN",
      "a fallthrough must never produce COMMITTED",
    );
  });

  it("ROLLS BACK an interrupted lendingArm — it is local-only, so re-signing is free", async () => {
    const journal = new MemoryExecutionJournal(() => 1_000);
    await journal.begin({
      idempotencyKey: "arm-owner-row", agentId: AGENT, ownerAddress: OWNER,
      kind: "lendingArm",
    });
    await reconcile({
      provider: provider({ status: "CONFIRMED" } as ExecutionReceipt),
      journal,
      resolveWallet: async () => null,
    });
    const row = await journal.get("arm-owner-row");
    assert.equal(row?.state, "ROLLED_BACK");
    assert.match(String(row?.lastError), /re-sign to be certain/u);
  });
});

/* -------------------------------------------------------------------------- */
/* AUDIT B-H2 — one decision id, one submission                               */
/* -------------------------------------------------------------------------- */

describe("AUDIT B-H2 — submitLendingBatch refuses a journal row it did not create", () => {
  const WALLET = getAddress("0x00000000000000000000000000000000000000b1");
  const KEY = `0x${"7d".repeat(32)}` as Hex;

  async function fixture() {
    const journal = new MemoryExecutionJournal(() => 1_000);
    const agentStore = new MemoryAgentStore(null, () => 1_000);
    await agentStore.createAgent({
      id: AGENT,
      ownerAddress: OWNER,
      walletAddress: WALLET,
      custodyModel: "passkey",
      sessionFacts: {
        spec: { calls: [], spend: [], expiresAt: 9_999_999_999 } as never,
        permissions: { calls: [], spend: [] },
        publicKey: `0x04${"ab".repeat(64)}` as Hex,
        expiry: 9_999_999_999,
      },
    });
    await agentStore.putAgentSessionKey(OWNER, AGENT, KEY);
    const agent = (await agentStore.getAgent(OWNER, AGENT))!;
    const executes: unknown[] = [];
    const provider = {
      restoreSession: () => ({ sessionId: "session-1" }),
      preflightExecute: async () => undefined,
      async executeViaSession(input: unknown) {
        executes.push(input);
        return {
          status: "CONFIRMED",
          transactionHash: `0x${"ab".repeat(32)}`,
          callsId: `0x${"cd".repeat(32)}`,
        };
      },
    } as unknown as WalletProvider;
    return { journal, agentStore, agent, provider, executes };
  }

  it("a second submission on one decision id is REFUSED ABOVE THE SUBMIT", async () => {
    const f = await fixture();
    const input = {
      agent: f.agent,
      decisionId: "lending:lending-journal-agent:arm:1",
      calls: [] as never,
      nativeSpendWei: 0n,
    };
    const first = await submitLendingBatch(
      { agentStore: f.agentStore, journal: f.journal, provider: f.provider },
      input,
    );
    assert.equal(first.status, "completed");
    assert.equal(f.executes.length, 1);

    // The B-H2 shape: two owner-signed arms that derived the SAME key. The
    // second used to walk past `begin` (which is idempotent), submit, and then
    // throw in `markInProgress` AFTER the money had moved.
    const second = await submitLendingBatch(
      { agentStore: f.agentStore, journal: f.journal, provider: f.provider },
      input,
    );
    assert.equal(second.status, "rolled-back");
    assert.equal(second.code, "refused-before-submit");
    assert.equal(f.executes.length, 1, "NOTHING was submitted the second time");
  });

  it("a ROLLED_BACK row is not a free re-run either", async () => {
    const f = await fixture();
    const decisionId = "lending:lending-journal-agent:arm:2";
    await f.journal.begin({
      idempotencyKey: `${AGENT}:${decisionId}`,
      agentId: AGENT,
      ownerAddress: OWNER,
      kind: "lending",
      decisionId,
      nativeSpendWei: 0n,
    });
    await f.journal.markRolledBack(`${AGENT}:${decisionId}`, "an earlier attempt");
    const again = await submitLendingBatch(
      { agentStore: f.agentStore, journal: f.journal, provider: f.provider },
      { agent: f.agent, decisionId, calls: [] as never, nativeSpendWei: 0n },
    );
    assert.equal(again.status, "rolled-back");
    assert.equal(again.code, "refused-before-submit");
    assert.equal(f.executes.length, 0);
  });
});
