/**
 * The ONE session-key submission path this phase has
 * (MARKETPLACE-LENDING-AGENT R2.1, R2.14, §5.6).
 *
 * The arm route, the retire route and the worker all submit through here, and
 * they all write the SAME journal kind — `"lending"` — under the SAME decision
 * namespace `lending:<agentId>:<day>:<n>`. Three call sites and one classifier
 * is the point: Phase 2.4's positional rule is a property of where a throw
 * happens relative to the submit, and three copies of that reasoning would
 * eventually disagree about where the line is.
 *
 * ═══ POSITIONAL CLASSIFICATION (Phase 2.4, inherited verbatim) ════════════
 *
 * Everything thrown ABOVE the submit provably never reached a relay, so the row
 * ROLLS BACK. Everything thrown at or below the submit is ambiguous and is held
 * as UNKNOWN — and for lending, UNKNOWN is where it stays: v1 ships NO owner
 * signed resolver for this kind, so the row degrades the guard through §5.6's
 * typed holds until one exists. The view says so in those words.
 *
 * ═══ AN ANSWERED `FAILED` IS A ROLLBACK, NOT AN UNKNOWN (R2.14) ═══════════
 *
 * The relay batch is ATOMIC. A redeem that fails at execution returns a Venus
 * error code without reverting, but the batch's own `repayBorrowBehalf` then
 * reverts on the short balance (`doTransferIn` requires the `transferFrom`), so
 * the WHOLE submission is FAILED. There is no partial landing to reason about,
 * and `no-effect` applies only to a batch that contains no redeem.
 */
import { getAddress, type Address, type Hex } from "viem";

import { sanitizeMessage } from "../core/errors.js";
import {
  ExecutionPlaneError,
  ProviderError,
  type ExecutionReceipt,
  type SessionRef,
  type WalletCall,
  type WalletProvider,
} from "../core/types.js";
import { agentAuthorityFromPrivateKey } from "../wallet/altana.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal } from "../store/journal.js";

/** What a lending submission can end as. Mirrors the arm response's `status`. */
export type LendingSubmitStatus = "completed" | "held" | "rolled-back";

export type LendingSubmitOutcome = {
  readonly status: LendingSubmitStatus;
  /** A short machine code, never prose. The view branches on this. */
  readonly code:
    | "confirmed"
    | "no-session"
    | "refused-before-submit"
    | "submit-ambiguous"
    | "relay-pending"
    | "relay-failed";
  readonly reason: string;
  readonly journalKey: string;
  readonly decisionId: string;
  readonly txHash: Hex | null;
  readonly callsId: Hex | null;
  readonly receiptStatus: ExecutionReceipt["status"] | null;
};

export type LendingSubmitDeps = {
  readonly agentStore: AgentStore;
  readonly journal: ExecutionJournal;
  readonly provider: WalletProvider;
};

export type LendingSubmitInput = {
  readonly agent: AgentRecord;
  /** `lending:<agentId>:<day>:<n>` — `n` from the guard row's `action_seq`. */
  readonly decisionId: string;
  readonly calls: readonly WalletCall[];
  /** Native this batch attaches, recorded HONESTLY on the journal ledger. */
  readonly nativeSpendWei: bigint;
};

/**
 * The decision id, namespaced per agent + day + the guard's own action
 * sequence (R2.1, R3.7/L11).
 *
 * `n` comes from `lending_guards.action_seq`, returned by the claim CAS — NOT
 * from a row count. A count-derived `n` is unsafe: a submission that wrote a
 * journal row but no action row makes the next rescue reuse `n`, and
 * `getByDecision` then refuses it as a replay, silently.
 */
export function lendingDecisionId(
  agentId: string,
  nowMs: number,
  actionSeq: number,
): string {
  const day = Math.floor(nowMs / 86_400_000);
  return `lending:${agentId}:${day}:${actionSeq}`;
}

/** The arm's and the retire's decision ids are keyed on the guard row version. */
export function lendingOwnerActionDecisionId(
  agentId: string,
  action: "arm" | "retire",
  guardRowVersion: number,
): string {
  return `lending:${agentId}:${action}:${guardRowVersion}`;
}

/**
 * Fetch, use and drop the agent's session key in the narrowest possible scope —
 * the same discipline as the `/trade` route's helper, the LP sagas' mirror and
 * the Venus worker's. The key is a local `const`, never returned, logged or
 * journaled.
 */
async function withSessionKey<T>(
  store: AgentStore,
  agent: AgentRecord,
  use: (authority: ReturnType<typeof agentAuthorityFromPrivateKey>) => Promise<T>,
): Promise<T> {
  let sessionKey: Hex | undefined =
    (await store.getAgentSessionKey(agent.ownerAddress, agent.id)) ?? undefined;
  if (sessionKey === undefined) {
    throw new ProviderError("Agent has no stored session key.");
  }
  try {
    return await use(agentAuthorityFromPrivateKey(sessionKey));
  } finally {
    sessionKey = undefined;
  }
}

function asPlaneError(error: unknown, fallback: string): ExecutionPlaneError {
  if (error instanceof ExecutionPlaneError) return error;
  return new ProviderError(
    sanitizeMessage(error instanceof Error ? error.message : fallback),
  );
}

/**
 * Journal begin -> restore -> preflight -> submit -> settle.
 *
 * The caller does the EFFECT VERIFICATION afterwards, because what "effect"
 * means differs per action — a repay checks `borrowBalanceCurrent(A)`, the arm
 * checks a vUSDT DELTA against a pre-submission read, the retire checks a
 * relative supplied-underlying residue — and folding three different answers
 * into one helper would make each of them harder to read than it is worth.
 */
export async function submitLendingBatch(
  deps: LendingSubmitDeps,
  input: LendingSubmitInput,
): Promise<LendingSubmitOutcome> {
  const agent = input.agent;
  const facts = agent.sessionFacts;
  const journalKey = `${agent.id}:${input.decisionId}`;
  if (facts === null) {
    return {
      status: "rolled-back",
      code: "no-session",
      reason: "The agent has no granted session; nothing was submitted.",
      journalKey,
      decisionId: input.decisionId,
      txHash: null,
      callsId: null,
      receiptStatus: null,
    };
  }

  // THE KEY MUST BE THIS CALL'S OWN (AUDIT B-H2).
  //
  // `begin` is idempotent: handed an EXISTING key it returns that row and does
  // nothing, so a decision id that repeats — B-H2's two concurrent arms keyed
  // on the same PRE-fence `rowVersion` — used to walk straight past it, submit,
  // and then throw in `markInProgress` AFTER `executeViaSession` had already
  // moved money, leaving the guard pointing at a ROLLED_BACK row that says
  // "NOTHING WAS SPENT".
  //
  // So the row this call did not CREATE is refused above the submit, and so is
  // a row that is not PENDING. `created` is the authority rather than the
  // state, for the reason `JournalBeginWithSpendResult` gives: a state check
  // cannot tell the creator from a racing duplicate that is still PENDING, and
  // two callers who both believe they own it both submit. `otherSpendWei` is
  // deliberately unused here — the lending native ledger is the on-chain meter
  // (R3.2), not a journal sum.
  const { entry: begun, created } = await deps.journal.beginWithSpend(
    {
      idempotencyKey: journalKey,
      agentId: agent.id,
      ownerAddress: agent.ownerAddress,
      kind: "lending",
      decisionId: input.decisionId,
      externalRef: { publicKey: facts.publicKey },
      nativeSpendWei: input.nativeSpendWei,
    },
    // Only `created` is read; the window is this row's own instant, so the sum
    // it takes is the cheapest one that answers nothing.
    Number.MAX_SAFE_INTEGER,
  );
  if (!created || begun.state !== "PENDING") {
    return {
      status: "rolled-back",
      code: "refused-before-submit",
      reason: sanitizeMessage(
        `A journal row already exists for this decision (${begun.state}); refusing rather `
        + "than submitting a second time against one decision id.",
      ),
      journalKey,
      decisionId: input.decisionId,
      txHash: null,
      callsId: null,
      receiptStatus: null,
    };
  }

  // (a) EVERYTHING BEFORE THE SUBMIT, in its own block. A throw here provably
  // never reached a relay: the row rolls back.
  let session: SessionRef;
  try {
    session = await withSessionKey(deps.agentStore, agent, (authority) =>
      Promise.resolve(
        deps.provider.restoreSession({
          spec: facts.spec,
          agent: authority,
          walletAddress: agent.walletAddress,
          publicKey: facts.publicKey,
          expiresAt: facts.expiry,
        }),
      ),
    );
    // The CHAIN is the authority NOW (Phase 2.4): a target that passed the
    // template's early warning and fails here is a grant that has moved.
    await deps.provider.preflightExecute({ session, calls: input.calls });
  } catch (error) {
    const refusal = asPlaneError(error, "lending action refused");
    await deps.journal.markRolledBack(
      journalKey,
      sanitizeMessage(`Refused before submission: ${refusal.code}.`),
    );
    return {
      status: "rolled-back",
      code: "refused-before-submit",
      reason: sanitizeMessage(`${refusal.code}: ${refusal.message}`),
      journalKey,
      decisionId: input.decisionId,
      txHash: null,
      callsId: null,
      receiptStatus: null,
    };
  }

  // (b) THE SUBMIT. From here on, ambiguity is the rule.
  let receipt: ExecutionReceipt;
  try {
    receipt = await deps.provider.executeViaSession({
      session,
      calls: input.calls,
      // HARD-CODED, exactly as on /trade, /execute and the Venus worker. No
      // request field, config field or parameter on this path can reach it.
      bypassLocalPolicyCheck: false,
    });
  } catch (error) {
    const mapped = asPlaneError(error, "lending action failed");
    await deps.journal.markUnknown(journalKey, sanitizeMessage(mapped.message));
    return {
      status: "held",
      code: "submit-ambiguous",
      reason:
        "The submission outcome is UNKNOWN and is held. Nothing resolves a lending "
        + "UNKNOWN automatically in v1; the guard is degraded until an owner-signed "
        + "resolver ships.",
      journalKey,
      decisionId: input.decisionId,
      txHash: null,
      callsId: null,
      receiptStatus: null,
    };
  }

  if (receipt.callsId !== undefined) {
    await deps.journal.markInProgress(journalKey, { callsId: receipt.callsId });
  }
  if (receipt.status === "PENDING") {
    await deps.journal.markUnknown(
      journalKey,
      "The relay returned PENDING; the submission window is ambiguous.",
    );
    return {
      status: "held",
      code: "relay-pending",
      reason: "The relay returned PENDING; the row is held as UNKNOWN.",
      journalKey,
      decisionId: input.decisionId,
      txHash: null,
      callsId: receipt.callsId ?? null,
      receiptStatus: receipt.status,
    };
  }
  if (receipt.status === "FAILED") {
    // R2.14: an ANSWERED FAILED is a rollback everywhere in this tree, and the
    // relay batch is atomic, so there is no partial landing to hold for.
    await deps.journal.markRolledBack(
      journalKey,
      sanitizeMessage(receipt.failureCode ?? "Execution reported FAILED."),
    );
    return {
      status: "rolled-back",
      code: "relay-failed",
      reason: sanitizeMessage(
        `The relay reported FAILED (${receipt.failureCode ?? "no code"}). Nothing was spent.`,
      ),
      journalKey,
      decisionId: input.decisionId,
      txHash: null,
      callsId: receipt.callsId ?? null,
      receiptStatus: receipt.status,
    };
  }

  await deps.journal.markCommitted(
    journalKey,
    receipt.transactionHash === undefined
      ? {}
      : { txHash: receipt.transactionHash },
  );
  return {
    status: "completed",
    code: "confirmed",
    reason: "The submission CONFIRMED; the effect read decides what it did.",
    journalKey,
    decisionId: input.decisionId,
    txHash: receipt.transactionHash ?? null,
    callsId: receipt.callsId ?? null,
    receiptStatus: receipt.status,
  };
}

/** The guarded account, normalized once so every caller compares like with like. */
export function normalizeGuarded(account: Address): Address {
  return getAddress(account);
}
