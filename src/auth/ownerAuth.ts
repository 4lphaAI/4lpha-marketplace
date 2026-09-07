/**
 * EIP-712 owner-action verifier.
 *
 * An owner authorizes a privileged change to a hired agent — grant, revoke,
 * pause, unpause, change budget, recover — by signing a typed `OwnerAction`
 * struct. The server never trusts the body's claim of who the owner is: it
 * AUTHENTICATES the signer and derives their identity from the signature
 * material — by `ecrecover` for secp256k1, by verifying a P256 assertion against
 * the carried credential key for passkeys (PHASE1.5) — and treats THAT as the
 * owner. Every other field is checked against that authenticated identity and
 * against the caller-supplied real parameters.
 *
 * What a valid verification establishes, and why each check exists:
 *   - AUTHENTICITY  the signature recovers to an address under OUR domain. A
 *     signature produced for a different chainId or a different environment salt
 *     recovers to a different address, so `recovered !== owner` and it is
 *     rejected — that is how cross-chain and cross-environment replay is caught.
 *     For the passkey backend the same property is enforced EXPLICITLY rather
 *     than emergently: the verifier recomputes the EIP-712 digest from the
 *     domain IT built and requires the WebAuthn challenge to equal it, so an
 *     assertion made for a different chainId or environment salt carries a
 *     different challenge and is refused BEFORE the owner match. Equally strong,
 *     by a different mechanism; the file must not claim they are the same one.
 *   - PARAMETER BINDING  the signed `paramsHash` equals `paramsHash(action,
 *     realParams)` recomputed here from the parameters the caller actually wants
 *     executed. This is the crux: a signature for "grant spec A" cannot be
 *     replayed to grant spec B, because B hashes differently.
 *   - FRESHNESS  `now` lies within `[issuedAt - skew, expiry]` and the signed
 *     window is at most {@link MAX_ACTION_WINDOW_SECONDS}. A short bounded window
 *     limits how long a captured signature is useful; single-use is enforced
 *     separately by the nonce store.
 *
 * FAILURES ARE INDISTINGUISHABLE. Every rejection throws the same
 * {@link OwnerAuthError} with one generic message, so an attacker probing the
 * endpoint cannot tell an expired signature from a replayed one from a forged
 * one. An internal reason is attached for server-side logs ONLY and is never the
 * public message.
 *
 * ORDERING CONTRACT (enforced by {@link authorizeOwnerAction}):
 *   rate-limit → ecrecover → domain/window → paramsHash recompute → consume
 *   nonce → act.
 * The nonce is consumed ONLY after every cheap cryptographic check has passed,
 * so a burst of forged or stale requests cannot burn a victim's nonces.
 */
import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { paramsHash } from "./canonical.js";
import type { NonceStore } from "../store/nonces.js";

/* -------------------------------------------------------------------------- */
/* Action taxonomy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of owner actions. Anything else is rejected before crypto.
 *
 * `read` (added in 1b-api) is the only NON-MUTATING member, and it is deliberate
 * rather than convenient: an owner-scoped read still has to prove who the owner
 * is, and the only proof this service accepts is a signature. Reusing the same
 * signed envelope for reads keeps ONE authentication mechanism instead of
 * bolting a second one onto GET routes.
 *
 * A `read` signature can do nothing but read: `paramsHash` binds the action name,
 * so a signature made for `read` recomputes to a different hash under `pause`,
 * `revoke` or any other action and is refused. See
 * {@link READ_ACTION_NONCE_POLICY} for why reads are the one action the HTTP
 * layer does not nonce-consume.
 */
export type OwnerActionType =
  | "grant"
  | "revoke"
  | "pause"
  | "unpause"
  | "changeBudget"
  | "recover"
  | "bindRuntimeProfile"
  | "read"
  | "createAccountReadSession"
  | "provisionAgent"
  | "cancelProvisioning"
  | "resetGrantAttempt"
  | "lpOpen"
  | "lpSettings"
  | "lpExit"
  | "tradeSettings"
  | "tradeExit"
  | "tradeDrain"
  | "resolveUnknown"
  | "resolveUnknownLandingV1"
  | "retireLpPreBindV1"
  | "lpImport"
  // PHASE3.8 F4a. The OTHER half of the UNKNOWN story, and the cheaper one:
  // `resolveUnknown` asks whether a submission that MAY have happened did.
  // This asks whether one ever STARTED — provable from local state alone,
  // because the plane always writes a journal row before it submits. FINDINGS
  // (aq) is a sequence held with no row to name, which the row-keyed resolver
  // cannot express at all.
  | "abandonSequence"
  | "billingGrant"
  | "billingIssuerRotate"
  | "billingPause"
  | "billingResume"
  | "billingRevoke"
  | "billingClose"
  | "billingServiceSession"
  // PHASE4 D10/R3.11(S13). The ONLY mutating Venus owner action: the guard's
  // thresholds, market lists and ceilings. Every other Venus surface is either
  // the existing `read` (the owner view) or absent — Phase 4 adds ZERO routes
  // reachable with `x-exec-token` alone, and the actor for the money actions is
  // a daemon holding the standing on-chain session, exactly as `/trade` is.
  //
  // It must appear in BOTH homes: this union AND the `OWNER_ACTIONS` runtime
  // set below. A member in one and not the other is rejected before crypto with
  // a generic failure, which is indistinguishable from a forgery.
  | "venusSettings"
  // PHASE3.16 R2.10 (review M1). The autonomous grid arm: ONE envelope carrying
  // the COMPLETE `lpSettings` params (grid block included) plus a native
  // `budgetWei`, so hire → BNB in → the agent places its own first level is one
  // owner signature. Like `venusSettings` it must appear in BOTH hand-maintained
  // homes — this union and the `OWNER_ACTIONS` set below.
  //
  // `OWNER_ACTION_TYPES` (the EIP-712 struct, further down this file) is NOT
  // touched and must never be: its field order IS part of the signed hash, so
  // editing it would invalidate every signature ever produced against this
  // domain. A new ACTION is a new value for the existing `action` string field,
  // not a new field.
  | "gridArm"
  | "lpArm"
  // MARKETPLACE-LENDING-AGENT §4, §6.1. THREE mutating owner actions and no
  // others: the arm (which carries the complete settings, the native budget
  // and the reserve split in one envelope), a settings replacement, and the
  // retire that converts the reserve back to BNB in wallet B. The guardable
  // preview and the detail view add NO member — the first is a perimeter read
  // of public chain state and the second reuses `read` through
  // `authorizeAccountRead`.
  //
  // Like every member above, each must appear in BOTH hand-maintained homes:
  // this union AND the `OWNER_ACTIONS` runtime set below. A member in one and
  // not the other is rejected before crypto with a generic failure, which an
  // owner cannot tell apart from a forgery.
  | "lendingArm"
  | "lendingSettings"
  | "lendingRetire";

/**
 * The three LP members (PHASE3 Rev2 item 20): `lpOpen`, `lpSettings`, `lpExit`
 * — all MUTATING (nonce-consumed, {@link isMutatingOwnerAction} answers by
 * exclusion so nothing here needed changing), none global. `GET /agents/:id/lp`
 * reuses `read` and adds no member. `settingsDigest` is
 * `paramsHash("lpSettings", params)` — the ONE shared encoder (Rev2 item 21);
 * no second canonical-JSON codec exists, and none may be written.
 *
 * The passkey dispatcher needed ZERO changes for these (Rev2 item 22): the
 * tagged challenge is over the EIP-712 digest and is action-agnostic. An
 * adversarial test drives an LP action through the passkey verifier anyway.
 *
 * `resolveUnknown` (PHASE3.3 Rev2 item 6) joins them on the same terms:
 * MUTATING by exclusion, correctly NOT global, `paramsHash`-bound over
 * `{decisionId, observedBlock}` plus the agent binding `requireBinding` already
 * enforces, and no change to `ownerMutation`, `authorizeOwnerAction` or the
 * passkey dispatcher.
 *
 * WHY IT IS OWNER-SIGNED AND NOT OPERATOR-TOKEN, stated here because it is the
 * decision the whole phase rests on: resolving an `UNKNOWN` row to
 * `ROLLED_BACK` RELEASES that row's held daily-cap budget
 * (`SPEND_COUNTING_STATES`), so an operator who could clear UNKNOWN rows could
 * release held budget on any agent. The signature does not assert a fact — it
 * authorizes the SERVER to check one and act on what it finds.
 *
 * `lpImport` (PHASE3.4) joins on the same terms — MUTATING by exclusion, not
 * global, `paramsHash`-bound over `{tokenId, basisWei}` — and the reason it must
 * be owner-signed rather than operator-token is the `basisWei` half. The basis
 * is a DECLARATION the owner makes about a position this plane did not create
 * and cannot price the history of; it becomes the TP/SL threshold the automation
 * will liquidate against. Nobody but the owner may author that number, and
 * `paramsHash` is what stops the server from rewriting it after the fact.
 *
 * The PREVIEW (`GET /agents/:id/lp/importable/:tokenId`) adds no member: it
 * reuses `read`, so it is verified but not nonce-consumed, and a `read`
 * signature binds the action and the agent — not the tokenId. Within its window
 * it can preview any tokenId, which is consistent with every other read on this
 * surface (it reveals the owner's own rows plus public chain state).
 */
const OWNER_ACTIONS: ReadonlySet<string> = new Set<OwnerActionType>([
  "grant",
  "revoke",
  "pause",
  "unpause",
  "changeBudget",
  "recover",
  "bindRuntimeProfile",
  "read",
  "createAccountReadSession",
  "provisionAgent",
  "cancelProvisioning",
  "resetGrantAttempt",
  "lpOpen",
  "lpSettings",
  "lpExit",
  "tradeSettings",
  "tradeExit",
  "tradeDrain",
  "resolveUnknown",
  "resolveUnknownLandingV1",
  "retireLpPreBindV1",
  "abandonSequence",
  "lpImport",
  "billingGrant",
  "billingIssuerRotate",
  "billingPause",
  "billingResume",
  "billingRevoke",
  "billingClose",
  "billingServiceSession",
  // PHASE4 D10. The second of the two hand-maintained homes (R3.11/S13).
  "venusSettings",
  // PHASE3.16 R2.10. The second home for the grid arm; a member present in the
  // union and absent here is rejected before crypto with a generic failure,
  // which an owner cannot tell apart from a forgery.
  "gridArm",
  "lpArm",
  // MARKETPLACE-LENDING-AGENT §4/§6.1 — the second home for the three lending
  // owner actions.
  "lendingArm",
  "lendingSettings",
  "lendingRetire",
]);

/**
 * Why `read` is verified but not nonce-consumed, stated once so the deviation is
 * a decision rather than an oversight.
 *
 * A nonce buys single-use. Single-use is what stops a captured signature being
 * REPLAYED to cause a second side effect — and a read has no side effect, so
 * there is no second effect to stop. What consuming a nonce on a read would buy
 * instead is a bug: a client that retries a dropped GET gets a hard
 * authorization failure on its second attempt.
 *
 * What still bounds a captured read signature: the signed window is at most
 * {@link MAX_ACTION_WINDOW_SECONDS}, the paramsHash binds it to one agent (or to
 * the list scope), and it authorizes reading data the signer already owns. The
 * HTTP layer therefore calls {@link verifyOwnerAction} for reads and
 * {@link authorizeOwnerAction} for every mutating action.
 */
export const READ_ACTION_NONCE_POLICY =
  "read is verified but not nonce-consumed: a replay may only observe or opportunistically trigger the monotonic caller-independent provisioning CAS; consuming would break legitimate retries" as const;

/** Actions that mutate state and therefore MUST consume a nonce. */
export function isMutatingOwnerAction(action: OwnerActionType): boolean {
  return action !== "read";
}

/**
 * The `agentId` sentinel for an action that targets every agent at once rather
 * than one. No core action is global yet, so the sentinel is currently rejected
 * for all of them — but the rule is validated now so a later global action
 * cannot silently accept a per-agent id, or vice versa.
 */
export const GLOBAL_AGENT_SENTINEL = "*";

/**
 * Actions permitted to use {@link GLOBAL_AGENT_SENTINEL}.
 *
 * `read` is here because listing an owner's agents genuinely has no single
 * agent to name — the scope IS "everything I own". Every mutating action stays
 * out: there is no owner action that should ever pause, revoke or re-budget an
 * entire fleet from one signature.
 */
const GLOBAL_ACTIONS: ReadonlySet<OwnerActionType> = new Set<OwnerActionType>([
  "read",
  "createAccountReadSession",
]);

/* -------------------------------------------------------------------------- */
/* Domain                                                                     */
/* -------------------------------------------------------------------------- */

/** EIP-712 domain name for every owner action. */
export const DOMAIN_NAME = "4lpha-execution";
/** EIP-712 domain version. Bump only on a breaking struct change. */
export const DOMAIN_VERSION = "1";

/**
 * Longest signed window we accept, in seconds. A signature good for five
 * minutes bounds the blast radius of a captured request; the nonce store makes
 * it single-use inside that window.
 */
export const MAX_ACTION_WINDOW_SECONDS = 300;

/** Default clock skew tolerance, in seconds, for the freshness check. */
export const DEFAULT_SKEW_SECONDS = 30;

/**
 * Inputs from which the per-environment domain salt is derived.
 *
 * The salt is what makes an otherwise-identical domain differ BETWEEN
 * ENVIRONMENTS even at the same chain id: a testnet and a mainnet fork can both
 * report chainId 56, and without a salt a signature from one would verify on the
 * other. Precedence:
 *   1. `EXECUTION_ENV_SALT`, when the operator sets it — the strongest isolation.
 *   2. otherwise `network:chainId`, so "testnet:97" and "mainnet:56" (and any
 *      two distinct networks) never share a salt.
 */
export type DomainSaltInput = {
  readonly chainId: number;
  /** Network label, e.g. "testnet" or "mainnet". Folded into the derived salt. */
  readonly network?: string;
  /** Explicit override, typically from `EXECUTION_ENV_SALT`. */
  readonly envSalt?: string;
};

/**
 * Derive the bytes32 domain salt. Any override string is hashed (so it need not
 * be 32 bytes); the derived fallback binds network label and chain id together.
 */
export function resolveDomainSalt(input: DomainSaltInput): Hex {
  const base =
    input.envSalt !== undefined && input.envSalt.trim() !== ""
      ? input.envSalt.trim()
      : `${input.network ?? "unknown"}:${input.chainId}`;
  return keccak256(stringToBytes(`${DOMAIN_NAME}/${DOMAIN_VERSION}/${base}`));
}

/**
 * THE domain constructor. Both sides use this one function — the signing client
 * and the verifier below — so the two can never drift.
 *
 * That drift is a real failure mode, not a hypothetical: a client that
 * hand-reassembles `{name, version, chainId, salt}` and gets one field wrong
 * produces signatures that recover to a different address, and every one of them
 * is rejected as a forgery with the same generic error — a bug that looks
 * exactly like an attack. `canonicalEncode` is shared for the same reason; this
 * closes the equivalent hole on the domain.
 *
 * Pair it with {@link resolveDomainSalt}:
 *
 *   buildOwnerActionDomain(chainId, resolveDomainSalt({ chainId, network, envSalt }))
 *
 * No `verifyingContract`: this is an off-chain authorization, not a call into a
 * specific contract. The salt carries the per-environment separation instead.
 */
export function buildOwnerActionDomain(
  chainId: number,
  salt: Hex,
): TypedDataDomain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    salt,
  };
}

/** The EIP-712 type definition. Field order is part of the signed hash. */
export const OWNER_ACTION_TYPES = {
  OwnerAction: [
    { name: "owner", type: "address" },
    { name: "agentId", type: "string" },
    { name: "action", type: "string" },
    { name: "paramsHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/* -------------------------------------------------------------------------- */
/* Structs and errors                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The signed message. `issuedAt`/`expiry` are unix SECONDS as `bigint` (uint64
 * on the wire); `nonce` and `paramsHash` are bytes32.
 */
export type OwnerActionStruct = {
  readonly owner: Address;
  readonly agentId: string;
  readonly action: OwnerActionType;
  readonly paramsHash: Hex;
  readonly nonce: Hex;
  readonly issuedAt: bigint;
  readonly expiry: bigint;
};

/** A signed request: the struct, the signature, and the REAL params to bind. */
export type OwnerActionRequest = {
  readonly signed: OwnerActionStruct;
  readonly signature: Hex;
  /**
   * The parameters the caller actually wants executed. The verifier recomputes
   * `paramsHash(action, params)` from THIS and compares to `signed.paramsHash`.
   */
  readonly params: unknown;
};

/** What a successful verification yields. `ownerAddress` is the AUTHENTICATED signer identity. */
export type OwnerAuthResult = {
  readonly ownerAddress: Address;
  readonly action: OwnerActionType;
  readonly agentId: string;
};

/**
 * The single error every rejection throws. Its public `message` is generic and
 * constant so failures cannot be told apart; `internalReason` is for logs only
 * and MUST NOT be surfaced to a client.
 */
export class OwnerAuthError extends Error {
  readonly code = "OWNER_AUTH_FAILED" as const;
  /** Server-side only. Never put this in a client response. */
  readonly internalReason: string;

  constructor(internalReason: string) {
    super("Owner authorization failed.");
    this.name = "OwnerAuthError";
    this.internalReason = internalReason;
  }
}

/* -------------------------------------------------------------------------- */
/* Verifier seam                                                              */
/* -------------------------------------------------------------------------- */

/** Everything a recover call needs, provider-agnostic. */
export type RecoverInput = {
  readonly domain: TypedDataDomain;
  readonly message: OwnerActionStruct;
  readonly signature: Hex;
};

/**
 * The pluggable signature backend. Two implementations: secp256k1 (private-key
 * owners) below, and the Phase 1.5 passkey/P256 verifier in
 * `src/auth/passkeyVerifier.ts`, which slots in behind this same interface
 * without touching the verification logic. `createDispatchingVerifier` fronts
 * both and is what `createServer` defaults to.
 */
export interface Verifier {
  /**
   * Authenticate the signature material and return the signer's identity, or
   * throw if it is unusable.
   *
   * The NAME IS HISTORICAL: the secp256k1 backend recovers, the passkey backend
   * verifies-and-derives. The contract both satisfy is that the returned address
   * is a function of the SIGNATURE MATERIAL and the DOMAIN, never of the request
   * body's claim.
   */
  recover(input: RecoverInput): Promise<Address>;
}

/** secp256k1 verifier over viem's typed-data recovery. */
export const secp256k1Verifier: Verifier = {
  async recover({ domain, message, signature }: RecoverInput): Promise<Address> {
    return recoverTypedDataAddress({
      domain,
      types: OWNER_ACTION_TYPES,
      primaryType: "OwnerAction",
      message,
      signature,
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

export type VerifyOwnerActionOptions = {
  /** Current time in unix SECONDS. Injected for deterministic tests. */
  readonly now: number;
  /** The chain id the server accepts signatures for. */
  readonly expectedChainId: number;
  /** Network label, folded into the derived salt when no envSalt is set. */
  readonly network?: string;
  /** Explicit salt override (typically `EXECUTION_ENV_SALT`). */
  readonly envSalt?: string;
  /** Clock skew tolerance in seconds. Defaults to {@link DEFAULT_SKEW_SECONDS}. */
  readonly skewSeconds?: number;
  /** Signature backend. Defaults to {@link secp256k1Verifier}. */
  readonly verifier?: Verifier;
};

export type OwnerActionTimeClassification = "fresh" | "expired" | "not-yet-valid";
export type ClassifiedOwnerAction = OwnerAuthResult & {
  /** Classification only. This result is never authority to mutate state. */
  readonly time: OwnerActionTimeClassification;
};

function assertUint64(value: bigint, field: string): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new OwnerAuthError(`${field} is out of uint64 range.`);
  }
}

/**
 * Verify a signed owner action. Pure crypto and time checks — NO nonce
 * consumption and NO storage. On success returns the recovered owner; on any
 * failure throws {@link OwnerAuthError}.
 *
 * The check order matters and follows the ordering contract: recover the signer
 * (ecrecover), confirm it matches the claimed owner, validate the freshness
 * window, and only then recompute and compare the paramsHash. Nonce consumption
 * is the caller's next step via {@link authorizeOwnerAction}.
 */
async function verifyOwnerActionCore(
  request: OwnerActionRequest,
  options: VerifyOwnerActionOptions,
  enforceCurrentWindow: boolean,
): Promise<ClassifiedOwnerAction> {
  const { signed } = request;
  const skew = options.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const verifier = options.verifier ?? secp256k1Verifier;

  // Shape checks: cheap, and they never leak which one failed.
  if (!OWNER_ACTIONS.has(signed.action)) {
    throw new OwnerAuthError(`Unknown action "${String(signed.action)}".`);
  }
  if (signed.agentId.length === 0) {
    throw new OwnerAuthError("Empty agentId.");
  }
  if (signed.agentId === GLOBAL_AGENT_SENTINEL && !GLOBAL_ACTIONS.has(signed.action)) {
    throw new OwnerAuthError(`Global sentinel not allowed for action "${signed.action}".`);
  }
  assertUint64(signed.issuedAt, "issuedAt");
  assertUint64(signed.expiry, "expiry");

  // ecrecover under OUR domain. A signature made under a different chainId or
  // salt recovers to some other address and fails the owner match below.
  const domain = buildOwnerActionDomain(
    options.expectedChainId,
    resolveDomainSalt({
      chainId: options.expectedChainId,
      ...(options.network === undefined ? {} : { network: options.network }),
      ...(options.envSalt === undefined ? {} : { envSalt: options.envSalt }),
    }),
  );

  let recovered: Address;
  try {
    recovered = await verifier.recover({
      domain,
      message: signed,
      signature: request.signature,
    });
  } catch (error) {
    // A backend that already produced an OwnerAuthError has a PRECISE internal
    // reason for the server log; re-wrapping it would flatten every passkey
    // rejection into "recovery failed: OwnerAuthError". Rethrown unchanged, and
    // the public message is the same constant string either way, so nothing
    // about the indistinguishable-failures contract moves. The secp256k1 path is
    // untouched: viem never throws this type.
    if (error instanceof OwnerAuthError) throw error;
    throw new OwnerAuthError(
      `Signature recovery failed: ${error instanceof Error ? error.name : "unknown"}.`,
    );
  }

  // Owner is the RECOVERED signer, never the body's claim.
  if (getAddress(recovered) !== getAddress(signed.owner)) {
    throw new OwnerAuthError("Recovered signer does not match declared owner.");
  }

  // Freshness window. Bounded span, and `now` inside it.
  if (signed.expiry <= signed.issuedAt) {
    throw new OwnerAuthError("Non-positive signature window.");
  }
  if (signed.expiry - signed.issuedAt > BigInt(MAX_ACTION_WINDOW_SECONDS)) {
    throw new OwnerAuthError("Signature window exceeds the maximum.");
  }
  const now = BigInt(Math.floor(options.now));
  const time: OwnerActionTimeClassification = now < signed.issuedAt - BigInt(skew)
    ? "not-yet-valid"
    : now > signed.expiry
      ? "expired"
      : "fresh";
  if (enforceCurrentWindow && time === "not-yet-valid") throw new OwnerAuthError("Signature not yet valid.");
  if (enforceCurrentWindow && time === "expired") throw new OwnerAuthError("Signature expired.");

  // THE CRUX: recompute the binding from the real params and compare.
  const recomputed = paramsHash(signed.action, request.params);
  if (recomputed.toLowerCase() !== signed.paramsHash.toLowerCase()) {
    throw new OwnerAuthError("paramsHash does not bind the supplied parameters.");
  }

  return {
    ownerAddress: getAddress(recovered),
    action: signed.action,
    agentId: signed.agentId,
    time,
  };
}

export async function verifyOwnerAction(
  request: OwnerActionRequest,
  options: VerifyOwnerActionOptions,
): Promise<OwnerAuthResult> {
  const { time: _time, ...result } = await verifyOwnerActionCore(request, options, true);
  return result;
}

/**
 * Cryptographically classify an owner action whose original time window may
 * have elapsed. The result deliberately grants no mutation authority: callers
 * must still find exact durable acceptance evidence or terminalize a valid
 * expired no-evidence S1 under the provision-claim lock.
 */
export function classifyOwnerActionTime(
  request: OwnerActionRequest,
  options: VerifyOwnerActionOptions,
): Promise<ClassifiedOwnerAction> {
  return verifyOwnerActionCore(request, options, false);
}

/* -------------------------------------------------------------------------- */
/* Orchestration: verify then consume the nonce                              */
/* -------------------------------------------------------------------------- */

export type AuthorizeOwnerActionOptions = VerifyOwnerActionOptions & {
  readonly nonceStore: NonceStore;
  /**
   * Runs with the RECOVERED owner after every cryptographic check has passed and
   * strictly BEFORE the nonce is consumed. Throwing from it aborts the
   * authorization with the nonce still unused.
   *
   * This hook exists so the ordering contract keeps ONE implementation. The HTTP
   * layer needs to rate-limit per owner, and "per owner" is only knowable after
   * ecrecover — but a limit that rejected AFTER consumption would burn a
   * legitimate client's single-use nonce on a request that never ran. The
   * alternative was for the HTTP layer to call `verifyOwnerAction` and
   * `nonceStore.consume` itself, which would put a second copy of this ordering
   * in the codebase, free to drift from this one.
   */
  readonly beforeNonceConsume?: (result: OwnerAuthResult) => Promise<void> | void;
};

/**
 * The call-site helper that enforces the ordering contract end to end:
 *
 *   ecrecover → domain/window → paramsHash recompute  (verifyOwnerAction)
 *     → beforeNonceConsume hook                        (may still refuse, free)
 *     → consume nonce                                  (only if all above pass)
 *
 * The nonce is consumed ONLY after {@link verifyOwnerAction} returns, so a
 * forged or stale request never burns a victim's nonce. If the nonce was already
 * consumed (a replay of an otherwise-valid signature), this throws the same
 * generic {@link OwnerAuthError}.
 *
 * The nonce's `expiresAt` is derived from the signed `expiry` (seconds → ms), so
 * a consumed nonce can be pruned once its signature could no longer be valid.
 *
 * 1b-api NOTE — nonce ↔ idempotency reconciliation: before calling this, the
 * HTTP layer MUST look the operation up in the execution journal by its
 * idempotency key (`ownerActionIdempotencyKey`). If a row already exists, return
 * its stored outcome and DO NOT call this helper — re-consuming the nonce would
 * fail a legitimate retry. The nonce guards first-arrival uniqueness; the
 * journal guards retry idempotency. They are checked in that order: journal
 * lookup first, nonce consumption second.
 */
export async function authorizeOwnerAction(
  request: OwnerActionRequest,
  options: AuthorizeOwnerActionOptions,
): Promise<OwnerAuthResult> {
  const result = await verifyOwnerAction(request, options);

  // Last chance to refuse without spending the nonce.
  await options.beforeNonceConsume?.(result);

  const expiresAtMs = Number(request.signed.expiry) * 1000;
  const fresh = await options.nonceStore.consume(
    result.ownerAddress,
    request.signed.nonce,
    expiresAtMs,
  );
  if (!fresh) {
    throw new OwnerAuthError("Nonce already consumed (replay).");
  }
  return result;
}
