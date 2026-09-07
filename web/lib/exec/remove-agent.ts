export type RemoveSequence = {
  readonly sequenceId: string;
  readonly positionId?: string;
  readonly kind?: string;
  readonly state: string;
  readonly recoveryState: string;
  /** Per-step journal state, so a blocked Remove can name the step the owner may resolve. */
  readonly steps?: readonly { readonly decisionId: string; readonly kind: string; readonly state: string | null }[];
};

/** The only sequence kinds `resolveUnknown` accepts (RESOLVABLE_SEQUENCE_KINDS in the plane). */
const RESOLVABLE_KINDS = new Set(["harvest", "protect", "manual-exit"]);

/** What is holding Remove, and which owner action can release it — if any. */
export type RemoveBlocker = {
  readonly sequenceId: string;
  readonly positionId: string | null;
  readonly kind: string | null;
  readonly state: string;
  readonly recoveryState: string;
  /** The UNKNOWN step an owner-signed `resolveUnknown` can settle, when the plane has such a resolver for this kind. */
  readonly resolvableDecisionId: string | null;
  /** A held sequence may be released by `abandonSequence` once the plane proves it idle. */
  readonly abandonable: boolean;
};

export function removeBlockerOf(sequence: RemoveSequence): RemoveBlocker {
  const unknownStep = sequence.steps?.find((step) => step.state === "UNKNOWN");
  return {
    sequenceId: sequence.sequenceId,
    positionId: sequence.positionId ?? null,
    kind: sequence.kind ?? null,
    state: sequence.state,
    recoveryState: sequence.recoveryState,
    resolvableDecisionId: unknownStep !== undefined && sequence.kind !== undefined && RESOLVABLE_KINDS.has(sequence.kind) ? unknownStep.decisionId : null,
    abandonable: sequence.state === "held" && (sequence.kind !== "rotate" || !sequence.steps?.some(step => step.state === "UNKNOWN" || step.state === "PENDING" || step.state === "IN_PROGRESS") || isAtomicRotateSequence(sequence)),
  };
}

export type RemovePosition = { readonly positionId: string; readonly state: string };

export type SessionRegistration = {
  readonly kind: "registered" | "missing" | "invalid" | "unreadable";
  readonly checkedAtMs: number;
} | null;

export type FinalizedSessionRevocation = {
  readonly kind: "registered" | "missing" | "invalid" | "unreadable";
  readonly checkedAtMs: number;
  readonly finalizedBlockNumber?: string;
  readonly finalizedBlockHash?: Hex;
} | null;

export type RemoveSnapshot = {
  readonly status: string;
  readonly positions: readonly RemovePosition[];
  readonly sequences: readonly RemoveSequence[];
  readonly sessionRegistration: SessionRegistration;
  readonly finalizedSessionRevocation: FinalizedSessionRevocation;
};

export type RemoveAttemptBindings = {
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly walletAddress: Address;
  readonly sessionPublicKeyFingerprint: Hex;
};

export type RemoveAttemptReceipt = {
  readonly chainId: 56;
  readonly transactionHash: Hex;
  readonly blockNumber: number;
  readonly blockHash: Hex;
};

export type RemoveAttemptV2 = RemoveAttemptBindings & {
  readonly version: 2;
  readonly attemptId: string;
  readonly startedAtMs: number;
  readonly state: "invoking" | "pending" | "failed" | "awaiting-finality" | "postcondition-failed";
  readonly callsId?: Hex;
  readonly transactionHash?: Hex;
  readonly receipt?: RemoveAttemptReceipt;
};

export type RemoveAttemptSlot =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly attempt: RemoveAttemptV2 };

export type RemoveAttemptExpectation =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "replace"; readonly attemptId: string };

export type RemoveProgress = {
  readonly failedPositionId?: string;
  readonly pendingWarning?: string;
  readonly legacyRevokeUnknown?: boolean;
  readonly revokeAttempt?: RemoveAttemptV2;
};

export type RemoveDecision = {
  readonly kind: "disabled" | "pause" | "blocked" | "exit" | "local-revoke" | "broadcast-revoke" | "check-revoke" | "retry-revoke" | "removed";
  readonly message: string;
  readonly positionId?: string;
  readonly blocker?: RemoveBlocker;
  readonly completedPositionIds: readonly string[];
  readonly remainingPositionIds: readonly string[];
};

export const EMPTY_REMOVE_PROGRESS: RemoveProgress = {};

export function parseLegacyRemoveProgress(value: unknown): RemoveProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { legacyRevokeUnknown: true };
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["revokeSubmission", "failedPositionId", "pendingWarning"].includes(key))
    || (raw["failedPositionId"] !== undefined && typeof raw["failedPositionId"] !== "string")
    || (raw["pendingWarning"] !== undefined && typeof raw["pendingWarning"] !== "string")) {
    return { legacyRevokeUnknown: true };
  }
  const revokeSubmission = raw["revokeSubmission"];
  return {
    ...(typeof raw["failedPositionId"] === "string" ? { failedPositionId: raw["failedPositionId"] } : {}),
    ...(typeof raw["pendingWarning"] === "string" ? { pendingWarning: raw["pendingWarning"] } : {}),
    ...(revokeSubmission === undefined || revokeSubmission === "not-started" ? {} : { legacyRevokeUnknown: true }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ATTEMPT_KEYS = new Set([
  "version", "attemptId", "startedAtMs", "state", "ownerAddress", "agentId", "walletAddress",
  "sessionPublicKeyFingerprint", "callsId", "transactionHash", "receipt",
]);

export function removeAttemptBindings(input: {
  readonly ownerAddress: string;
  readonly agentId: string;
  readonly walletAddress: string;
  readonly sessionPublicKey: string;
}): RemoveAttemptBindings | null {
  if (!isAddress(input.ownerAddress) || !isAddress(input.walletAddress) || !AGENT_ID.test(input.agentId)
    || !isHex(input.sessionPublicKey) || size(input.sessionPublicKey) === 0) return null;
  return {
    ownerAddress: getAddress(input.ownerAddress),
    agentId: input.agentId,
    walletAddress: getAddress(input.walletAddress),
    sessionPublicKeyFingerprint: keccak256(input.sessionPublicKey),
  };
}

function sameBindings(left: RemoveAttemptBindings, right: RemoveAttemptBindings): boolean {
  return left.ownerAddress.toLowerCase() === right.ownerAddress.toLowerCase()
    && left.agentId === right.agentId
    && left.walletAddress.toLowerCase() === right.walletAddress.toLowerCase()
    && left.sessionPublicKeyFingerprint.toLowerCase() === right.sessionPublicKeyFingerprint.toLowerCase();
}

function exactHex32(value: unknown): value is Hex {
  return typeof value === "string" && isHex(value) && size(value) === 32;
}

function nonEmptyHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value);
}

export function parseRemoveAttempt(value: unknown, expected: RemoveAttemptBindings): RemoveAttemptV2 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !ATTEMPT_KEYS.has(key)) || raw["version"] !== 2
    || typeof raw["attemptId"] !== "string" || !UUID.test(raw["attemptId"])
    || typeof raw["startedAtMs"] !== "number" || !Number.isSafeInteger(raw["startedAtMs"]) || raw["startedAtMs"] < 0
    || typeof raw["ownerAddress"] !== "string" || !isAddress(raw["ownerAddress"])
    || typeof raw["agentId"] !== "string" || !AGENT_ID.test(raw["agentId"])
    || typeof raw["walletAddress"] !== "string" || !isAddress(raw["walletAddress"])
    || !exactHex32(raw["sessionPublicKeyFingerprint"])
    || !["invoking", "pending", "failed", "awaiting-finality", "postcondition-failed"].includes(String(raw["state"]))) return null;
  const bindings: RemoveAttemptBindings = {
    ownerAddress: getAddress(raw["ownerAddress"]), agentId: raw["agentId"],
    walletAddress: getAddress(raw["walletAddress"]), sessionPublicKeyFingerprint: raw["sessionPublicKeyFingerprint"],
  };
  if (!sameBindings(bindings, expected)) return null;
  const callsId = raw["callsId"];
  const transactionHash = raw["transactionHash"];
  if (callsId !== undefined && !nonEmptyHex(callsId)) return null;
  if (transactionHash !== undefined && !exactHex32(transactionHash)) return null;
  let receipt: RemoveAttemptReceipt | undefined;
  if (raw["receipt"] !== undefined) {
    if (typeof raw["receipt"] !== "object" || raw["receipt"] === null || Array.isArray(raw["receipt"])) return null;
    const item = raw["receipt"] as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["chainId", "transactionHash", "blockNumber", "blockHash"].includes(key))
      || item["chainId"] !== 56 || !exactHex32(item["transactionHash"]) || !exactHex32(item["blockHash"])
      || typeof item["blockNumber"] !== "number" || !Number.isSafeInteger(item["blockNumber"]) || item["blockNumber"] < 1) return null;
    receipt = { chainId: 56, transactionHash: item["transactionHash"], blockNumber: item["blockNumber"], blockHash: item["blockHash"] };
  }
  const state = raw["state"] as RemoveAttemptV2["state"];
  if (state === "invoking" && (callsId !== undefined || receipt !== undefined)) return null;
  if (["pending", "failed", "awaiting-finality", "postcondition-failed"].includes(state) && callsId === undefined) return null;
  if (["awaiting-finality", "postcondition-failed"].includes(state) && receipt === undefined) return null;
  if (receipt !== undefined && transactionHash !== undefined
    && receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) return null;
  return {
    version: 2, ...bindings, attemptId: raw["attemptId"], startedAtMs: raw["startedAtMs"], state,
    ...(callsId === undefined ? {} : { callsId }),
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

export function newRemoveAttempt(bindings: RemoveAttemptBindings, attemptId: string, startedAtMs: number): RemoveAttemptV2 {
  const candidate = parseRemoveAttempt({ version: 2, ...bindings, attemptId, startedAtMs, state: "invoking" }, bindings);
  if (candidate === null) throw new Error("Cannot create a valid removal attempt.");
  return candidate;
}

/** A late tab may update only the exact attempt it launched; terminal evidence never moves backwards. */
export function advanceRemoveAttempt(
  current: RemoveAttemptV2,
  expectedAttemptId: string,
  next: RemoveAttemptV2,
): RemoveAttemptV2 | null {
  if (current.attemptId !== expectedAttemptId || next.attemptId !== expectedAttemptId
    || !sameBindings(current, next) || current.startedAtMs !== next.startedAtMs) return null;
  const sameReceipt = (left: RemoveAttemptReceipt | undefined, right: RemoveAttemptReceipt | undefined): boolean =>
    left === undefined ? right === undefined : right !== undefined
      && left.chainId === right.chainId && left.blockNumber === right.blockNumber
      && left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase()
      && left.blockHash.toLowerCase() === right.blockHash.toLowerCase();
  const sameEvidence = current.callsId?.toLowerCase() === next.callsId?.toLowerCase()
    && current.transactionHash?.toLowerCase() === next.transactionHash?.toLowerCase()
    && sameReceipt(current.receipt, next.receipt);
  if (current.state === next.state) return sameEvidence ? next : null;
  if (current.state === "invoking" && (next.state === "pending" || next.state === "failed")) return next;
  if (current.state === "pending" && (next.state === "failed" || next.state === "awaiting-finality")) {
    return current.callsId?.toLowerCase() === next.callsId?.toLowerCase() ? next : null;
  }
  if (current.state === "awaiting-finality" && next.state === "postcondition-failed") {
    return sameEvidence ? next : null;
  }
  return null;
}

/** Rechecked under the browser lock immediately before a new paid invocation. */
export function mayBeginRemoveAttempt(
  slot: RemoveAttemptSlot,
  legacyAmbiguous: boolean,
  expected: RemoveAttemptExpectation,
): boolean {
  if (expected.kind === "none") return slot.kind === "missing" && !legacyAmbiguous;
  if (expected.kind === "ambiguous") return slot.kind !== "valid";
  return slot.kind === "valid" && slot.attempt.attemptId === expected.attemptId
    && ["invoking", "failed", "postcondition-failed"].includes(slot.attempt.state);
}

export function finalizedAtOrAfter(evidence: FinalizedSessionRevocation, blockNumber: number): boolean {
  if (evidence === null || evidence.kind === "unreadable" || typeof evidence.finalizedBlockNumber !== "string"
    || !/^[1-9][0-9]*$/u.test(evidence.finalizedBlockNumber) || !Number.isSafeInteger(blockNumber) || blockNumber < 1) return false;
  try { return BigInt(evidence.finalizedBlockNumber) >= BigInt(blockNumber); } catch { return false; }
}

export function isTerminalSequence(sequence: RemoveSequence): boolean {
  if (sequence.state === "completed" || sequence.state === "rolled-back") return true;
  return sequence.state === "held" && sequence.recoveryState === "none";
}

export function hasFreshRevocationProof(snapshot: RemoveSnapshot, nowMs: number): boolean {
  const evidence = snapshot.finalizedSessionRevocation;
  if (snapshot.status !== "revoked" || evidence === null || !Number.isSafeInteger(nowMs)
    || !Number.isSafeInteger(evidence.checkedAtMs)) return false;
  const age = nowMs - evidence.checkedAtMs;
  return age >= 0 && age <= 15_000 && (evidence.kind === "missing" || evidence.kind === "invalid");
}

/** Authoritative, reload-safe next step for the serial Remove workflow. */
export function nextRemoveStep(
  snapshot: RemoveSnapshot,
  progress: RemoveProgress,
  nowMs: number,
): RemoveDecision {
  const completedPositionIds = snapshot.positions.filter((position) => position.state === "closed").map((position) => position.positionId);
  const remainingPositionIds = snapshot.positions.filter((position) => position.state !== "closed").map((position) => position.positionId);
  const base = { completedPositionIds, remainingPositionIds };

  if (snapshot.status === "provisioning") {
    return { kind: "disabled", message: "This agent is still being hired. Finish the on-chain grant, or cancel the hire.", ...base };
  }
  if (hasFreshRevocationProof(snapshot, nowMs)) {
    return { kind: "removed", message: "Removed. The recorded session is no longer valid on chain.", ...base };
  }
  if (snapshot.status === "armed") {
    return { kind: "pause", message: "Pause automation before closing positions.", ...base };
  }
  const blocker = snapshot.sequences.find((sequence) => !isTerminalSequence(sequence));
  if (blocker !== undefined) {
    const detail = removeBlockerOf(blocker);
    const remedy = detail.resolvableDecisionId !== null
      ? " The relay never answered for one of its steps; Resolve settles it from chain evidence."
      : detail.abandonable ? (isAtomicRotateSequence(blocker)
        ? " Abandon relinquishes management; a replacement NFT may exist or the submission may still land. Recover manually in the PancakeSwap UI."
        : " Abandon releases it once the plane has proven it idle.") : "";
    return { kind: "blocked", blocker: detail, message: `Sequence ${blocker.sequenceId.slice(0, 8)} (${blocker.kind ?? "lp"}, ${blocker.state}/${blocker.recoveryState}) is still settling.${remedy}`, ...base };
  }
  if (snapshot.status === "paused" && remainingPositionIds.length > 0) {
    const positionId = progress.failedPositionId !== undefined && remainingPositionIds.includes(progress.failedPositionId)
      ? progress.failedPositionId
      : remainingPositionIds[0];
    return {
      kind: "exit",
      positionId,
      message: progress.failedPositionId === positionId
        ? `Exit ${positionId} failed. Retry it before continuing.`
        : `Exit ${positionId}; positions are closed serially.`,
      ...base,
    };
  }
  if (snapshot.status === "paused") {
    return { kind: "local-revoke", message: "Revoke the agent locally, then remove its on-chain session authority.", ...base };
  }
  if (snapshot.status === "revoked") {
    if (remainingPositionIds.length > 0) {
      return { kind: "blocked", message: "The agent is locally revoked but still has live position rows. Do not revoke on chain until they are recovered.", ...base };
    }
    const attempt = progress.revokeAttempt;
    if (attempt?.state === "pending" || attempt?.state === "awaiting-finality") {
      return { kind: "check-revoke", message: attempt.state === "pending"
        ? "The on-chain revoke is pending. Check its relay status."
        : "The revoke transaction is waiting for BNB finality before KeyStore verification.", ...base };
    }
    if (attempt?.state === "invoking") {
      return { kind: "retry-revoke", message: "Previous revoke outcome unknown. Retrying may spend relay gas again.", ...base };
    }
    if (attempt?.state === "failed" || attempt?.state === "postcondition-failed" || progress.legacyRevokeUnknown === true) {
      return { kind: "retry-revoke", message: progress.legacyRevokeUnknown === true
        ? "Previous revoke outcome unknown. Retrying may spend relay gas again."
        : "The on-chain revoke did not remove the session. Retry with the owner passkey; relay gas may be spent again.", ...base };
    }
    return {
      kind: "broadcast-revoke",
      message: "On-chain revoke unverified. Sign and submit the dedicated Altana revocation.",
      ...base,
    };
  }
  return { kind: "disabled", message: `Remove is unavailable while the agent is ${snapshot.status}.`, ...base };
}
import { getAddress, isAddress, isHex, keccak256, size, type Address, type Hex } from "viem";

export function isAtomicRotateSequence(sequence: RemoveSequence): boolean {
  return sequence.kind === "rotate" && sequence.steps !== undefined && sequence.steps.length > 0 && sequence.steps.some(step => step.kind === "rotate-atomic") && sequence.steps.every(step => step.kind === "rotate-atomic" || step.state === "ROLLED_BACK" || step.state === null);
}
export function lpStepLabel(kind: string): string {
  return kind === "rotate-atomic" ? "Rotate (one transaction)" : kind;
}
export function lpSequenceLabel(sequence: RemoveSequence): string {
  if (sequence.state === "held" && sequence.recoveryState === "rotate-ambiguous") return "Rotate submitted; outcome unconfirmed";
  if (isAtomicRotateSequence(sequence)) return lpStepLabel("rotate-atomic") + " \u00b7 " + sequence.state;
  return (sequence.kind ?? "lp") + " \u00b7 " + sequence.state;
}
