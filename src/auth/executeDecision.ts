/**
 * The execute-authorization boundary — the Q3 crux, encoded exactly once.
 *
 * Autonomous execution is NOT authorized by an owner signature. The owner
 * already delegated authority on-chain when the session was granted; from then
 * on the agent runs on its own. So the question this function answers is
 * deliberately narrow:
 *
 *   May the executor submit for this agent RIGHT NOW?
 *   = the session is not expired  ∧  the agent is not paused  ∧  nothing is halted.
 *
 * There is no owner signature in the inputs, and there must not be one: requiring
 * a fresh owner signature per trade would defeat the point of a scoped session.
 * The standing on-chain session plus the kill switch ARE the authorization.
 *
 * This is the ONLY place the execute boundary lives. It is a decision over
 * injected state — the agent record and the kill switch — with an injected
 * clock, so it is fully testable offline. The authoritative on-chain policy
 * re-check still happens inside `executeViaSession`; this function never
 * replaces it and never relaxes it.
 *
 * INVARIANT for 1b-api: `executeViaSession`'s `bypassLocalPolicyCheck` exists
 * only for the spike's on-chain-rejection proof. It MUST remain unreachable from
 * any HTTP path — no route may accept it, forward it, or set it. The decision
 * here never emits it; 1b-api must never wire a request field to it.
 */
import { keccak256, stringToBytes, type Hex } from "viem";
import { isSessionExpired } from "../core/session.js";
import type { AgentRecord } from "../store/agents.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import { canonicalEncode } from "./canonical.js";
import type { OwnerActionStruct } from "./ownerAuth.js";

/** Why an execute was refused. Callers branch on `code`, never on `reason`. */
export type ExecuteDenyCode =
  | "NO_SESSION"
  | "SESSION_EXPIRED"
  | "AGENT_PAUSED"
  | "GLOBAL_HALT";

export type ExecuteDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: ExecuteDenyCode; readonly reason: string };

export type AuthorizeExecuteInput = {
  /** The agent to run. Its `sessionFacts` supply the expiry to check. */
  readonly agent: AgentRecord;
  readonly killswitch: KillSwitch;
  /** Current time in unix SECONDS (matches `isSessionExpired`). */
  readonly now: number;
  /**
   * Whether this operation only REDUCES the agent's exposure — a sell, a
   * position close, a withdrawal.
   *
   * A pause exists so an owner can stop an agent that is behaving badly. If it
   * also blocked the exits, the owner's safety action would trap the position
   * it was meant to protect, and the only way out would be to wait for the
   * session to expire while the market moved. So a pause blocks OPENING and
   * leaves CLOSING available — the same reasoning that already stops the scan
   * gate from evaluating sells, applied to the control that needed it more.
   *
   * A global `halt` is deliberately NOT softened this way: it is the operator's
   * emergency stop for our own infrastructure, not a risk tool for one owner,
   * and "stop absolutely everything" is what it is for.
   *
   * Defaults to `false`, so a caller that forgets it gets the strict answer.
   */
  readonly reducesExposure?: boolean;
};

/**
 * Decide whether the executor may submit for this agent now.
 *
 * Checks, in order of severity: global halt first (it overrides everything),
 * then a missing or expired session, then a per-agent pause — which an
 * exposure-reducing operation is allowed to pass. Async only because the kill
 * switch is; it takes NO signature and reads no global state beyond its
 * injected inputs.
 */
export async function authorizeExecute(
  input: AuthorizeExecuteInput,
): Promise<ExecuteDecision> {
  const { agent, killswitch, now } = input;

  if (await killswitch.isHalted()) {
    return { allowed: false, code: "GLOBAL_HALT", reason: "Global halt is engaged." };
  }

  const facts = agent.sessionFacts;
  if (facts === null) {
    return {
      allowed: false,
      code: "NO_SESSION",
      reason: "Agent has no granted session.",
    };
  }
  if (isSessionExpired(facts.spec, now)) {
    return {
      allowed: false,
      code: "SESSION_EXPIRED",
      reason: "Agent session has expired.",
    };
  }

  // A pause is scoped by the agent's owner. `AgentRecord.ownerAddress` is the
  // already-normalized scope key; the kill switch re-normalizes defensively.
  // An exit is still permitted while paused — see `reducesExposure`.
  if (
    input.reducesExposure !== true &&
    (await killswitch.isAgentPaused(agent.id, agent.ownerAddress))
  ) {
    return { allowed: false, code: "AGENT_PAUSED", reason: "Agent is paused." };
  }

  return { allowed: true };
}

/* -------------------------------------------------------------------------- */
/* Idempotency keys                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Idempotency key for an owner action: the keccak256 of the CANONICAL signed
 * struct. Identical signed actions collapse to one key; any change to owner,
 * agent, action, params binding, nonce or window changes it.
 *
 * 1b-api uses this as the journal key. The reconciliation rule below is what
 * makes a retried owner action safe.
 */
export function ownerActionIdempotencyKey(signed: OwnerActionStruct): Hex {
  return keccak256(stringToBytes(canonicalEncode(signed)));
}

/**
 * Idempotency key for an autonomous execute: binds the agent, the decision that
 * authorized it, and the exact calls (their hash). Two submits of the same calls
 * under the same decision collapse to one journal row.
 */
export function executeIdempotencyKey(
  agentId: string,
  decisionId: string,
  callsHash: Hex,
): Hex {
  return keccak256(
    stringToBytes(canonicalEncode({ agentId, decisionId, callsHash })),
  );
}

/**
 * Idempotency key for a high-level trade.
 *
 * Structurally the same binding as {@link executeIdempotencyKey}, over the
 * trade's paramsHash rather than a calls hash: the calls do not exist yet when
 * the key is needed (a DENIED trade never builds any), and the paramsHash covers
 * strictly more — the resolved venue configuration as well as the request. Two
 * submits of the same parameters under the same decision collapse to one row.
 */
export function tradeIdempotencyKey(
  agentId: string,
  decisionId: string,
  paramsHash: Hex,
): Hex {
  return keccak256(
    stringToBytes(canonicalEncode({ agentId, decisionId, paramsHash })),
  );
}

/**
 * NONCE ↔ IDEMPOTENCY RECONCILIATION — the contract 1b-api MUST implement.
 *
 * A nonce is single-use; a legitimate client retry (same signed action, resent
 * after a dropped response) MUST NOT be mistaken for a replay. The two are
 * reconciled by ORDER:
 *
 *   1. Compute `ownerActionIdempotencyKey(signed)`.
 *   2. Look the journal up by that key. If a row EXISTS, return its stored
 *      outcome and STOP — do not verify the signature again and do NOT consume
 *      the nonce. This is the retry path.
 *   3. Only if no row exists, run `authorizeOwnerAction` (verify → consume nonce)
 *      and then `journal.begin` under the same key before acting.
 *
 * Journal-lookup precedes nonce-consumption, always. That ordering is why a
 * retry (row present) never touches the nonce, while a first arrival consumes it
 * exactly once. A replay of a DIFFERENT-but-valid signature carrying an already
 * consumed nonce has no journal row, reaches step 3, and is rejected by
 * `consume` returning false.
 */
export const NONCE_IDEMPOTENCY_CONTRACT =
  "journal lookup by ownerActionIdempotencyKey BEFORE nonce consume; existing row returns stored outcome without re-consuming" as const;
