import { describe, expect, it } from "vitest";
import {
  EMPTY_REMOVE_PROGRESS,
  advanceRemoveAttempt,
  finalizedAtOrAfter,
  hasFreshRevocationProof,
  mayBeginRemoveAttempt,
  newRemoveAttempt,
  nextRemoveStep,
  parseLegacyRemoveProgress,
  parseRemoveAttempt,
  removeAttemptBindings,
  removeBlockerOf,
  type RemoveSnapshot,
} from "./remove-agent";

const NOW = 2_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const PUBLIC_KEY = `0x04${"33".repeat(64)}`;
const bindings = removeAttemptBindings({ ownerAddress: OWNER, agentId: "grid", walletAddress: WALLET, sessionPublicKey: PUBLIC_KEY })!;
const ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CALLS_ID = "0x1234" as const;

function attempt(state: "invoking" | "pending" | "failed" | "awaiting-finality" | "postcondition-failed") {
  const initial = newRemoveAttempt(bindings, ATTEMPT_ID, NOW);
  if (state === "invoking") return initial;
  const submitted = { ...initial, state: state === "failed" ? "failed" as const : "pending" as const, callsId: CALLS_ID };
  if (state === "pending" || state === "failed") return submitted;
  return {
    ...submitted,
    state,
    transactionHash: `0x${"44".repeat(32)}` as const,
    receipt: { chainId: 56 as const, transactionHash: `0x${"44".repeat(32)}` as const, blockNumber: 100, blockHash: `0x${"55".repeat(32)}` as const },
  };
}
const base: RemoveSnapshot = {
  status: "armed", positions: [], sequences: [], sessionRegistration: null,
  finalizedSessionRevocation: null,
};

describe("Remove state machine", () => {
  it("disables provisioning and resumes after a lost pause response", () => {
    expect(nextRemoveStep({ ...base, status: "provisioning" }, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("disabled");
    expect(nextRemoveStep(base, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("pause");
    expect(nextRemoveStep({ ...base, status: "paused" }, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("local-revoke");
  });

  it("blocks every exact non-terminal sequence shape", () => {
    for (const sequence of [
      { sequenceId: "a", state: "active", recoveryState: "none" },
      { sequenceId: "b", state: "held", recoveryState: "pending-mint" },
      { sequenceId: "c", state: "resolving", recoveryState: "none" },
    ]) {
      expect(nextRemoveStep({ ...base, status: "paused", sequences: [sequence] }, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("blocked");
    }
  });

  it("skips closed rows and resumes serially after each exit or response loss", () => {
    const positions = [
      { positionId: "done", state: "closed" },
      { positionId: "first", state: "open" },
      { positionId: "second", state: "closing" },
    ];
    const first = nextRemoveStep({ ...base, status: "paused", positions }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(first).toMatchObject({ kind: "exit", positionId: "first", completedPositionIds: ["done"], remainingPositionIds: ["first", "second"] });
    const afterFirst = nextRemoveStep({ ...base, status: "paused", positions: [{ ...positions[0]! }, { positionId: "first", state: "closed" }, positions[2]!] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(afterFirst).toMatchObject({ kind: "exit", positionId: "second" });
    const failed = nextRemoveStep({ ...base, status: "paused", positions }, { failedPositionId: "first" }, NOW);
    expect(failed).toMatchObject({ kind: "exit", positionId: "first" });
    expect(failed.message).toContain("failed");
  });

  it("recovers legacy, pending, failed, and finalized-postcondition revoke attempts without an automatic resend", () => {
    const revoked = { ...base, status: "revoked" };
    expect(nextRemoveStep(revoked, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("broadcast-revoke");
    expect(nextRemoveStep(revoked, { legacyRevokeUnknown: true }, NOW).kind).toBe("retry-revoke");
    expect(nextRemoveStep(revoked, { revokeAttempt: attempt("invoking") }, NOW).kind).toBe("retry-revoke");
    expect(nextRemoveStep(revoked, { revokeAttempt: attempt("pending") }, NOW).kind).toBe("check-revoke");
    expect(nextRemoveStep(revoked, { revokeAttempt: attempt("failed") }, NOW).kind).toBe("retry-revoke");
    expect(nextRemoveStep(revoked, { revokeAttempt: attempt("awaiting-finality") }, NOW).kind).toBe("check-revoke");
    expect(nextRemoveStep(revoked, { revokeAttempt: attempt("postcondition-failed") }, NOW).kind).toBe("retry-revoke");
  });

  it("migrates the stuck v1 submitted/confirmed record only to an explicit ambiguous retry", () => {
    expect(parseLegacyRemoveProgress({ revokeSubmission: "submitted", pendingWarning: "wait" }))
      .toEqual({ legacyRevokeUnknown: true, pendingWarning: "wait" });
    expect(parseLegacyRemoveProgress({ revokeSubmission: "confirmed" }).legacyRevokeUnknown).toBe(true);
    expect(parseLegacyRemoveProgress({ revokeSubmission: "failed" }).legacyRevokeUnknown).toBe(true);
    expect(parseLegacyRemoveProgress({ revokeSubmission: "not-started" }).legacyRevokeUnknown).toBeUndefined();
    expect(parseLegacyRemoveProgress("broken")).toEqual({ legacyRevokeUnknown: true });
    expect(parseLegacyRemoveProgress({ unexpected: true })).toEqual({ legacyRevokeUnknown: true });
  });

  it("binds v2 progress to the exact owner, agent, wallet and session and rejects stale attempt writes", () => {
    const current = attempt("pending");
    expect(parseRemoveAttempt(current, bindings)).toEqual(current);
    const other = removeAttemptBindings({ ...bindings, ownerAddress: "0x3333333333333333333333333333333333333333", sessionPublicKey: PUBLIC_KEY })!;
    expect(parseRemoveAttempt(current, other)).toBeNull();
    expect(parseRemoveAttempt({ ...current, extra: true }, bindings)).toBeNull();
    expect(parseRemoveAttempt({ ...current, callsId: "0x" }, bindings)).toBeNull();
    expect(advanceRemoveAttempt(current, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", { ...current, state: "failed" })).toBeNull();
    const terminal = attempt("postcondition-failed");
    expect(advanceRemoveAttempt(terminal, ATTEMPT_ID, attempt("pending"))).toBeNull();
  });

  it("makes confirmed inclusion evidence immutable against late or conflicting tabs", () => {
    const pending = attempt("pending");
    const confirmed = attempt("awaiting-finality");
    const conflict = {
      ...confirmed,
      transactionHash: `0x${"66".repeat(32)}` as const,
      receipt: {
        ...confirmed.receipt!,
        transactionHash: `0x${"66".repeat(32)}` as const,
        blockHash: `0x${"77".repeat(32)}` as const,
      },
    };
    expect(advanceRemoveAttempt(pending, ATTEMPT_ID, confirmed)).toEqual(confirmed);
    expect(advanceRemoveAttempt(confirmed, ATTEMPT_ID, { ...pending, state: "failed" })).toBeNull();
    expect(advanceRemoveAttempt(confirmed, ATTEMPT_ID, conflict)).toBeNull();
    expect(advanceRemoveAttempt(confirmed, ATTEMPT_ID, attempt("postcondition-failed")))
      .toEqual(attempt("postcondition-failed"));
  });

  it("rechecks the exact saved attempt before any paid retry, closing stale-tab and hydration races", () => {
    const first = attempt("failed");
    const newer = { ...first, attemptId: "223e4567-e89b-42d3-a456-426614174000" };
    expect(mayBeginRemoveAttempt({ kind: "missing" }, false, { kind: "none" })).toBe(true);
    expect(mayBeginRemoveAttempt({ kind: "valid", attempt: newer }, false, { kind: "none" })).toBe(false);
    expect(mayBeginRemoveAttempt({ kind: "missing" }, true, { kind: "none" })).toBe(false);
    expect(mayBeginRemoveAttempt({ kind: "invalid" }, false, { kind: "none" })).toBe(false);
    expect(mayBeginRemoveAttempt({ kind: "invalid" }, true, { kind: "ambiguous" })).toBe(true);
    expect(mayBeginRemoveAttempt({ kind: "valid", attempt: newer }, false, { kind: "replace", attemptId: ATTEMPT_ID })).toBe(false);
    expect(mayBeginRemoveAttempt({ kind: "valid", attempt: first }, false, { kind: "replace", attemptId: ATTEMPT_ID })).toBe(true);
    expect(mayBeginRemoveAttempt({ kind: "valid", attempt: attempt("pending") }, false, { kind: "replace", attemptId: ATTEMPT_ID })).toBe(false);
  });

  it("requires finalized block provenance at or after the relay inclusion", () => {
    const registered = { kind: "registered" as const, checkedAtMs: NOW, finalizedBlockNumber: "100", finalizedBlockHash: `0x${"55".repeat(32)}` as const };
    expect(finalizedAtOrAfter(registered, 100)).toBe(true);
    expect(finalizedAtOrAfter(registered, 101)).toBe(false);
    expect(finalizedAtOrAfter({ kind: "registered", checkedAtMs: NOW }, 1)).toBe(false);
  });

  it("never strands a live position behind an already-local revoked row", () => {
    const decision = nextRemoveStep({ ...base, status: "revoked", positions: [{ positionId: "still-live", state: "open" }] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(decision.kind).toBe("blocked");
    expect(decision.message).toContain("still has live position");
  });

  it("names the UNKNOWN step of a resolvable sequence so the owner can settle it, and never one the plane cannot resolve", () => {
    // The live 2026-09-03 shape: manual-exit, zap-out COMMITTED, sweep-token
    // UNKNOWN ("Execution still pending after await"), held/wbnb-stranded.
    const stuck = {
      sequenceId: "865d7182-9001-44af-bcb9-78c5b1b53504", positionId: "p", kind: "manual-exit", state: "held", recoveryState: "wbnb-stranded",
      steps: [
        { decisionId: "lp:865d7182-9001-44af-bcb9-78c5b1b53504:0", kind: "zap-out", state: "COMMITTED" },
        { decisionId: "lp:865d7182-9001-44af-bcb9-78c5b1b53504:1", kind: "sweep-token", state: "UNKNOWN" },
      ],
    };
    const decision = nextRemoveStep({ ...base, status: "paused", sequences: [stuck] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(decision.kind).toBe("blocked");
    expect(decision.blocker).toMatchObject({ sequenceId: stuck.sequenceId, resolvableDecisionId: "lp:865d7182-9001-44af-bcb9-78c5b1b53504:1", abandonable: true });
    expect(decision.message).toContain("Resolve");
    // grid-flip is deliberately outside RESOLVABLE_SEQUENCE_KINDS: an UNKNOWN there has no resolver.
    expect(removeBlockerOf({ ...stuck, kind: "grid-flip" }).resolvableDecisionId).toBeNull();
    // A held sequence with no UNKNOWN step offers abandon only.
    const idle = removeBlockerOf({ ...stuck, steps: [{ ...stuck.steps[0]! }, { ...stuck.steps[1]!, state: "COMMITTED" }] });
    expect(idle).toMatchObject({ resolvableDecisionId: null, abandonable: true });
    // The legacy shape without steps still blocks, and offers nothing false.
    const bare = nextRemoveStep({ ...base, status: "paused", sequences: [{ sequenceId: "x", state: "active", recoveryState: "none" }] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(bare.blocker).toMatchObject({ resolvableDecisionId: null, abandonable: false });
  });

  it("calls Removed only for fresh missing/invalid evidence", () => {
    for (const kind of ["missing", "invalid"] as const) {
      const snapshot = { ...base, status: "revoked", finalizedSessionRevocation: { kind, checkedAtMs: NOW - 15_000 } };
      expect(hasFreshRevocationProof(snapshot, NOW)).toBe(true);
      expect(nextRemoveStep(snapshot, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("removed");
    }
    for (const evidence of [
      { kind: "registered" as const, checkedAtMs: NOW },
      { kind: "unreadable" as const, checkedAtMs: NOW },
      { kind: "missing" as const, checkedAtMs: NOW - 15_001 },
      { kind: "invalid" as const, checkedAtMs: NOW + 1 },
    ]) {
      const snapshot = { ...base, status: "revoked", finalizedSessionRevocation: evidence };
      expect(hasFreshRevocationProof(snapshot, NOW)).toBe(false);
      expect(nextRemoveStep(snapshot, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("broadcast-revoke");
    }
  });

  it("never reports Removed from responsive latest-head evidence alone", () => {
    for (const kind of ["missing", "invalid"] as const) {
      const snapshot = { ...base, status: "revoked", sessionRegistration: { kind, checkedAtMs: NOW } };
      expect(hasFreshRevocationProof(snapshot, NOW)).toBe(false);
      expect(nextRemoveStep(snapshot, EMPTY_REMOVE_PROGRESS, NOW).kind).not.toBe("removed");
    }
  });
});
