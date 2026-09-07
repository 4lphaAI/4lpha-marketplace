/**
 * Multi-tenant agent store.
 *
 * One row per hired agent, scoped to the OWNER that hired it. Every read and
 * write is filtered by `owner_address` so one user can never see or mutate
 * another's agent — a cross-tenant read returns `null` (indistinguishable from
 * "no such agent"), never someone else's row.
 *
 * The session key an agent signs with is the one fund-moving secret here. It is
 * held in its own column, encrypted at rest, and is never returned by any
 * listing or lookup — only by the explicit {@link AgentStore.getAgentSessionKey}.
 *
 * Mirrors the data-plane store pattern: an interface, a process-local memory
 * implementation, a durable Postgres implementation, and a factory that picks
 * between them by `DATABASE_URL` — logging which backend, never the URL.
 */
import { getAddress, isHex, keccak256, size, type Address, type Hex } from "viem";
import type { CustodyModel, SessionSpec } from "../core/types.js";
import type { ProviderPermissions } from "../core/session.js";
import {
  parseHttpRuntimeProfile,
  type BindableHttpRuntimeProfile,
  type HttpRuntimeProfile,
} from "../auth/runtimeAuth.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import {
  decryptSecret,
  encryptSecret,
  loadMasterKey,
} from "./crypto.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import type { TradeSettings } from "../trade/settings.js";
import type { SessionRevocationEvidenceV1 } from "../account/keyStoreReader.js";
import { categoryForPreset, decodeIdentity, fail as identityFail, newIdentity, type StoredIdentity, type IdentityCategory, type IdentitySource, type Erc8004IdentitySummary, type IdentityFence } from "../identity/types.js";
import { IDENTITY_AGENT_MIGRATION, IDENTITY_AGENT_INDEX, projectionAllowed, sourceFromRecord } from "./erc8004Sources.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

/** Runtime provenance required before a stored invalid-key fact can release a wallet. */
export type SessionRevocationContext = {
  readonly chainId: number;
  readonly keyStoreAddress: Address;
};

/** Lifecycle state of an agent. 1b drives the transitions; 1a only stores them. */
export type AgentStatus =
  | "provisioning"
  | "armed"
  | "paused"
  | "revoked"
  | "retired";

const AGENT_STATUSES: ReadonlySet<string> = new Set<AgentStatus>([
  "provisioning",
  "armed",
  "paused",
  "revoked",
  "retired",
]);

function isOrdinaryLifecycleTransition(from: AgentStatus, to: AgentStatus): boolean {
  return (from === "armed" && (to === "paused" || to === "revoked"))
    || (from === "paused" && (to === "armed" || to === "revoked"));
}

/**
 * The facts needed to rebuild a session after a restart — persisted byte-exact.
 *
 * `permissions` is the canonical permission shape `validateSessionSpec`
 * produced at grant time; it is stored alongside `spec` so a mismatch between a
 * re-derived shape and the granted one is detectable rather than silent.
 */
export type SessionFacts = {
  readonly spec: SessionSpec;
  readonly permissions: ProviderPermissions;
  readonly publicKey: Hex;
  readonly expiry: number;
  /** Immutable S1 sizing envelope retained after the pending grant is cleared. */
  readonly hireSizing?: {
    readonly name: "grid-v1" | "grid-shift-v1" | "lp-v1" | "trade-v1";
    readonly version: 1;
    readonly openNativeBudgetWei: string;
  };
  /** Durable link used only to repair S1's row-before-journal crash window. */
  readonly provisionActionId?: Hex;
  /** Browser run correlation; authority remains the accepted provision action. */
  readonly hireRunId?: string;
};

export type FundingRequirement = {
  readonly version: 1;
  readonly observedAtSec: number;
  readonly registrationFeeWei: string;
  readonly registrations: 1 | 2;
  readonly relayGasHeadroomWei: string;
  readonly requiredWei: string;
  readonly balanceWei: string | null;
};

export type PendingGrant = {
  readonly version: 1;
  readonly recoveredOwner: Address;
  readonly walletAddress: Address;
  readonly sessionAddress: Address;
  readonly sessionPublicKey: Hex;
  readonly accountKeyHash: Hex;
  readonly keyStoreKeyId: Hex;
  readonly sessionSpec: SessionSpec;
  readonly permissions: ProviderPermissions;
  readonly grantDigest: Hex;
  readonly expiresAt: number;
  readonly sizing: {
    readonly openNativeBudgetWei: string;
    readonly capDayWei: string;
    readonly sizingPreset: "grid-v1" | "grid-shift-v1" | "lp-v1" | "trade-v1";
    readonly sizingPresetVersion: 1;
  };
  readonly funding: FundingRequirement;
  readonly createdAtSec: number;
  readonly keyStoreVerdictAtS1: "verified" | "not-registered";
  readonly provisionActionId: Hex;
  readonly hireRunId?: string;
  readonly autoGrant?: true;
  readonly initialTradeSettings?: {
    readonly params: TradeSettings;
    readonly digest: Hex;
  };
  readonly grantAttempt?: {
    readonly version: 1;
    readonly attemptId: Hex;
    readonly startedAtSec: number;
  };
  readonly lastGrantAttemptReset?: {
    readonly version: 1;
    readonly resetActionId: Hex;
    readonly clearedAttemptId: Hex;
    readonly resetAtSec: number;
  };
  readonly cancelRequestedAtSec?: number;
  readonly cancelActionId?: Hex;
};

/** Off-chain execution caps. Extensible; empty is valid. */
export type AgentCaps = {
  /** Optional off-chain ceiling on native spend per rolling day, in wei. */
  readonly dailyNativeWei?: bigint;
  /** Optional off-chain ceiling on native spend per trade, in wei. */
  readonly perTradeNativeWei?: bigint;
};

/** A stored agent. Never carries the session key. */
export type AgentRecord = {
  readonly id: string;
  /**
   * Normalized (checksum-lowered) owner scope key.
   *
   * Typed as an `Address` rather than a bare string because it IS one: every
   * write path runs it through {@link ownerKey}, which checksum-validates before
   * lowering, and every read path re-normalizes on the way out. Callers that
   * need an `Address` — the kill switch, the session-key accessor — can use it
   * directly instead of asserting a cast at each call site, which is how a
   * genuinely unvalidated string would eventually slip through one of them.
   */
  readonly ownerAddress: Address;
  readonly walletAddress: Address;
  readonly custodyModel: CustodyModel;
  readonly sessionFacts: SessionFacts | null;
  /** Store-owned finalized KeyStore proof; never accepted by generic inputs. */
  readonly sessionRevocation: SessionRevocationEvidenceV1 | null;
  /** Decoded nulls were not SQL NULLs; internal corruption veto, never a wire field. */
  readonly sessionStateDecodeMismatch?: true;
  readonly caps: AgentCaps | null;
  readonly status: AgentStatus;
  /** Fail-closed authorization profile for the autonomous HTTP runtime only. */
  readonly httpRuntimeProfile: HttpRuntimeProfile;
  /**
   * Optional ERC-8004 Identity Registry reference (`AgentID`), set when the
   * marketplace registers the agent on-chain. Purely informational here: the
   * execution plane never derives authority from it — tenancy and custody come
   * from `ownerAddress` and the session, always.
   */
  readonly erc8004AgentId: string | null;
  /** Informational outbox. Invalid non-NULL storage never authorizes reenrollment. */
  readonly erc8004Identity?: StoredIdentity;
  /** Pending browser grant intent; present only while status is provisioning. */
  readonly pendingGrant: PendingGrant | null;
  /** First-wins authority CAS token; informational identity writes have a separate revision. */
  readonly rowVersion: number;
  /** Epoch ms. */
  readonly createdAt: number;
  /** Epoch ms. */
  readonly updatedAt: number;
};

export type CreateAgentInput = {
  readonly id: string;
  readonly ownerAddress: Address;
  readonly walletAddress: Address;
  readonly custodyModel: CustodyModel;
  readonly sessionFacts?: SessionFacts;
  readonly caps?: AgentCaps;
  readonly status?: AgentStatus;
  readonly httpRuntimeProfile?: HttpRuntimeProfile;
  readonly erc8004AgentId?: string;
};

export type BindHttpRuntimeProfileResult =
  | { readonly kind: "updated" | "same"; readonly agent: AgentRecord }
  | { readonly kind: "conflict"; readonly agent: AgentRecord }
  | { readonly kind: "not_found" };

export class AgentExistsError extends Error {
  constructor(id: string) {
    super(`Agent "${id}" already exists.`);
    this.name = "AgentExistsError";
  }
}

export class AgentWalletInUseError extends Error {
  constructor(readonly agentId: string | null = null) {
    super("This wallet is already occupied by an agent that cannot safely share Trading capital.");
    this.name = "AgentWalletInUseError";
  }
}

export type CreateProvisioningAgentInput = {
  readonly record: Omit<CreateAgentInput, "sessionFacts" | "status">;
  readonly pendingGrant: Omit<PendingGrant, "cancelRequestedAtSec" | "cancelActionId">;
  /** Raw private key. The store seals it before making the row visible. */
  readonly sessionKey: Hex;
  /** Optional end-to-end S1 convergence deadline/cancellation. */
  readonly signal?: AbortSignal;
};

export type ProvisioningCasResult = {
  readonly updated: boolean;
  readonly retired?: boolean;
  readonly failure?: "not_found" | "state_changed" | "wallet_in_use";
};

export type ConfirmSessionRevokedInput = {
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly expectedRowVersion: number;
  readonly expectedPublicKey: Hex;
  readonly expectedChainId: number;
  readonly expectedKeyStoreAddress: Address;
  readonly evidence: SessionRevocationEvidenceV1;
  readonly signal?: AbortSignal;
};

export type ConfirmSessionRevokedResult =
  | { readonly kind: "confirmed" | "same"; readonly agent: AgentRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" };

export type GrantAttemptCasResult =
  | { readonly kind: "created"; readonly agent: AgentRecord }
  | { readonly kind: "same"; readonly agent: AgentRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" };

export type GrantAttemptResetCasResult =
  | { readonly kind: "cleared"; readonly agent: AgentRecord }
  | { readonly kind: "same"; readonly agent: AgentRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" };

/** Liveness of a long-running executor. Mirrors the data-plane job-health row. */
export type ExecutorHealth = {
  readonly executor: string;
  readonly lastOkAt: number | null;
  readonly lastErrorAt: number | null;
  readonly lastError: string | null;
  readonly lastLatencyMs: number | null;
  readonly consecutiveFailures: number;
};

export interface AgentStore {
  /** True only for a restart-durable backend. */
  readonly durable: boolean;
  /** True only when create-with-key can seal private material at rest. */
  readonly keyEncryptionConfigured: boolean;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  createProvisioningAgent(input: CreateProvisioningAgentInput): Promise<AgentRecord>;
  /** The agent, or `null` when it does not exist OR is owned by someone else. */
  getAgent(ownerAddress: Address, id: string): Promise<AgentRecord | null>;
  /**
   * The agent by id ALONE, without an owner scope. The single unscoped read in
   * this interface, and it exists for exactly one caller.
   *
   * The autonomous execute path is driven by our own runtime, which authenticates
   * as a SERVICE and carries no owner signature — so there is no owner to scope
   * by, and taking one from the request would let the caller name any tenant it
   * liked. Tenancy therefore comes FROM THE ROW: this returns the agent, and the
   * row's own `ownerAddress` is authoritative for everything downstream (the
   * session-key lookup, the kill-switch scope, the journal). Every other read
   * stays owner-scoped.
   *
   * Like every other accessor here, it never returns the session key.
   */
  getAgentById(id: string): Promise<AgentRecord | null>;
  listAgents(ownerAddress: Address): Promise<AgentRecord[]>;
  listAgentsBounded(
    ownerAddress: Address,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ readonly rows: readonly AgentRecord[]; readonly hasMore: boolean }>;
  listProvisioningAgentsForWorker(input: {
    readonly afterId: string | null;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly rows: readonly AgentRecord[]; readonly hasMore: boolean }>;
  armProvisioningAgent(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly expectedGrantDigest: Hex;
    readonly sessionFacts: SessionFacts;
  }): Promise<ProvisioningCasResult>;
  startGrantAttemptCas(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedGrantDigest: Hex;
    readonly attemptId: Hex;
    readonly startedAtSec: number;
  }): Promise<GrantAttemptCasResult>;
  resetGrantAttemptCas(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedGrantDigest: Hex;
    readonly attemptId: Hex;
    readonly resetActionId: Hex;
    readonly resetAtSec: number;
  }): Promise<GrantAttemptResetCasResult>;
  confirmSessionRevokedCas(input: ConfirmSessionRevokedInput): Promise<ConfirmSessionRevokedResult>;
  cancelProvisioningAgent(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly expectedGrantDigest: Hex;
    readonly nowSec: number;
    readonly cancelActionId: Hex;
  }): Promise<ProvisioningCasResult>;
  transitionAgentStatus(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedStatus: AgentStatus;
    readonly expectedRowVersion: number;
    readonly status: AgentStatus;
  }): Promise<AgentRecord | null>;
  updateAgentCapsCas(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly caps: AgentCaps;
  }): Promise<AgentRecord | null>;
  bindHttpRuntimeProfileCas(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly profile: BindableHttpRuntimeProfile;
  }): Promise<BindHttpRuntimeProfileResult>;
  updateAgentStatus(
    ownerAddress: Address,
    id: string,
    status: AgentStatus,
  ): Promise<AgentRecord | null>;
  updateAgentSessionFacts(
    ownerAddress: Address,
    id: string,
    facts: SessionFacts,
  ): Promise<AgentRecord | null>;
  /**
   * Record the owner's INTENDED off-chain caps.
   *
   * Off-chain only, and the distinction matters: the on-chain session's spend
   * caps are what the account contract enforces, and only a fresh owner-signed
   * grant can change those. This records what the owner asked for so the service
   * refuses trades beyond it — a tightening the owner gets immediately, and a
   * loosening that does nothing until the on-chain re-grant lands.
   */
  updateAgentCaps(
    ownerAddress: Address,
    id: string,
    caps: AgentCaps,
  ): Promise<AgentRecord | null>;
  /**
   * Record the agent's ERC-8004 registry id after the marketplace registers it.
   * Owner-scoped like every other mutation; `null` clears it.
   */
  updateAgentErc8004Id(
    ownerAddress: Address,
    id: string,
    erc8004AgentId: string | null,
  ): Promise<AgentRecord | null>;
  /** One-way owner-scoped CAS from unbound to an ordinary runtime profile. */
  bindHttpRuntimeProfile(
    ownerAddress: Address,
    id: string,
    profile: BindableHttpRuntimeProfile,
  ): Promise<BindHttpRuntimeProfileResult>;
  /**
   * Store the agent's session key, encrypted. The value is never logged and
   * never returned by any other method. Throws if the agent is not owned by
   * `ownerAddress`.
   */
  putAgentSessionKey(
    ownerAddress: Address,
    id: string,
    sessionKey: Hex,
  ): Promise<void>;
  /** The decrypted session key, or `null` when absent or not owned. */
  getAgentSessionKey(ownerAddress: Address, id: string): Promise<Hex | null>;
  /** Presence-only integrity check; never decrypts or returns private material. */
  hasAgentSessionKey(ownerAddress: Address, id: string): Promise<boolean>;
  putExecutorHealth(health: ExecutorHealth): Promise<void>;
  getExecutorHealth(): Promise<ExecutorHealth[]>;
  close(): Promise<void>;
}

const MAX_ERROR_CHARS = 300;

/**
 * Checksum-validate then lower an owner address for use as a scope key.
 *
 * Rebuilt as a template literal rather than `.toLowerCase() as Address` so the
 * `Address` type is EARNED — `getAddress` does the validating, and the result is
 * structurally `0x${string}` with no assertion anywhere.
 */
function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

/** Normalize an owner address read back out of storage. Validates as it goes. */
function ownerKeyFromStorage(value: string): Address {
  return ownerKey(getAddress(value));
}

function assertStatus(status: string): AgentStatus {
  if (!AGENT_STATUSES.has(status)) {
    throw new Error(`Unknown agent status "${status}".`);
  }
  return status as AgentStatus;
}

function assertWorkerLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) {
    throw new Error("Invalid provisioning worker limit.");
  }
}

const REVOCATION_MAX_FUTURE_SKEW_MS = 30_000;

export function parseSessionRevocationEvidence(value: unknown): SessionRevocationEvidenceV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row["version"] !== 1 || (row["verdict"] !== "invalid" && row["verdict"] !== "missing")
    || typeof row["chainId"] !== "number" || !Number.isSafeInteger(row["chainId"]) || row["chainId"] < 1
    || typeof row["keyStoreAddress"] !== "string" || typeof row["walletAddress"] !== "string"
    || typeof row["keyId"] !== "string" || !isHex(row["keyId"]) || size(row["keyId"]) !== 32
    || typeof row["sessionPublicKey"] !== "string" || !isHex(row["sessionPublicKey"]) || size(row["sessionPublicKey"]) === 0
    || typeof row["blockNumber"] !== "string" || !/^[1-9][0-9]*$/u.test(row["blockNumber"])
    || typeof row["blockHash"] !== "string" || !isHex(row["blockHash"]) || size(row["blockHash"]) !== 32
    || typeof row["observedAtMs"] !== "number" || !Number.isSafeInteger(row["observedAtMs"]) || row["observedAtMs"] < 0) {
    return null;
  }
  try {
    if (BigInt(row["blockNumber"]) <= 0n) return null;
    return {
      version: 1,
      chainId: row["chainId"],
      keyStoreAddress: getAddress(row["keyStoreAddress"]),
      walletAddress: getAddress(row["walletAddress"]),
      keyId: row["keyId"],
      sessionPublicKey: row["sessionPublicKey"],
      verdict: row["verdict"],
      blockNumber: row["blockNumber"],
      blockHash: row["blockHash"],
      observedAtMs: row["observedAtMs"],
    };
  } catch {
    return null;
  }
}

function sameRevocationIdentity(left: SessionRevocationEvidenceV1, right: SessionRevocationEvidenceV1): boolean {
  return left.version === right.version && left.chainId === right.chainId
    && left.keyStoreAddress.toLowerCase() === right.keyStoreAddress.toLowerCase()
    && left.walletAddress.toLowerCase() === right.walletAddress.toLowerCase()
    && left.keyId.toLowerCase() === right.keyId.toLowerCase()
    && left.sessionPublicKey.toLowerCase() === right.sessionPublicKey.toLowerCase()
    && left.verdict === right.verdict && left.blockNumber === right.blockNumber
    && left.blockHash.toLowerCase() === right.blockHash.toLowerCase();
}

/** Runtime validation for the only fact that can release an unexpired wallet. */
export function validSessionRevocationProof(
  agent: AgentRecord,
  context: SessionRevocationContext | null,
  nowMs: number,
): boolean {
  const proof = parseSessionRevocationEvidence(agent.sessionRevocation);
  const facts = agent.sessionFacts;
  if (context === null || agent.status !== "revoked" || proof === null || facts === null
    || !Number.isSafeInteger(nowMs) || nowMs < 0
    || proof.chainId !== context.chainId
    || proof.observedAtMs > nowMs + REVOCATION_MAX_FUTURE_SKEW_MS) return false;
  try {
    return proof.keyStoreAddress.toLowerCase() === getAddress(context.keyStoreAddress).toLowerCase()
      && proof.walletAddress.toLowerCase() === getAddress(agent.walletAddress).toLowerCase()
      && proof.sessionPublicKey.toLowerCase() === facts.publicKey.toLowerCase()
      && proof.keyId.toLowerCase() === keccak256(facts.publicKey).toLowerCase();
  } catch {
    return false;
  }
}

export type AgentSessionIntegrity = "ok" | "proof_with_key";

/** The impossible state is reported separately even though occupancy fails closed. */
export function agentSessionIntegrity(
  agent: AgentRecord,
  context: SessionRevocationContext | null,
  nowMs: number,
  sessionKeyPresent: boolean,
): AgentSessionIntegrity {
  return sessionKeyPresent && validSessionRevocationProof(agent, context, nowMs)
    ? "proof_with_key"
    : "ok";
}

function validConfirmation(
  input: ConfirmSessionRevokedInput,
  agent: AgentRecord,
  context: SessionRevocationContext | null,
  nowMs: number,
): boolean {
  const proof = parseSessionRevocationEvidence(input.evidence);
  if (context === null || proof === null
    || !Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 1
    || !Number.isSafeInteger(input.expectedChainId) || input.expectedChainId < 1
    || input.expectedChainId !== context.chainId
    || proof.chainId !== input.expectedChainId
    || proof.walletAddress.toLowerCase() !== agent.walletAddress.toLowerCase()
    || proof.sessionPublicKey.toLowerCase() !== input.expectedPublicKey.toLowerCase()
    || proof.observedAtMs > nowMs + REVOCATION_MAX_FUTURE_SKEW_MS) return false;
  try {
    return getAddress(input.expectedKeyStoreAddress).toLowerCase() === getAddress(context.keyStoreAddress).toLowerCase()
      && proof.keyStoreAddress.toLowerCase() === getAddress(context.keyStoreAddress).toLowerCase()
      && agent.sessionFacts !== null
      && input.expectedPublicKey.toLowerCase() === agent.sessionFacts.publicKey.toLowerCase()
      && proof.keyId.toLowerCase() === keccak256(agent.sessionFacts.publicKey).toLowerCase();
  } catch {
    return false;
  }
}

/** Either marker forbids activation; only a complete valid marker releases occupancy. */
export function hasProvisioningCancellation(pending: unknown): boolean {
  return typeof pending === "object" && pending !== null
    && ("cancelRequestedAtSec" in pending || "cancelActionId" in pending);
}

function safeSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function bytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

/** R5: JSONB is untrusted. Retained ciphertext alone does not revive a canceled draft. */
export function validProvisioningCancellation(value: unknown, nowSec: number): boolean {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !safeSeconds(nowSec)) return false;
    const agent = value as Record<string, unknown>;
    if (agent["status"] !== "provisioning" || agent["sessionFacts"] !== null || agent["sessionRevocation"] !== null
      || agent["sessionStateDecodeMismatch"] === true) return false;
    const pending = agent["pendingGrant"];
    if (typeof pending !== "object" || pending === null || Array.isArray(pending)) return false;
    const row = pending as Record<string, unknown>;
    const created = row["createdAtSec"];
    const canceled = row["cancelRequestedAtSec"];
    const expiry = row["expiresAt"];
    return safeSeconds(created) && safeSeconds(canceled) && safeSeconds(expiry)
      && created <= canceled && canceled < expiry && nowSec < expiry
      && canceled - nowSec <= 30 && bytes32(row["cancelActionId"]);
  } catch {
    return false;
  }
}

function validCancelTransition(pending: PendingGrant, nowSec: number, actionId: Hex): boolean {
  return safeSeconds(nowSec) && safeSeconds(pending.createdAtSec) && safeSeconds(pending.expiresAt)
    && pending.createdAtSec < pending.expiresAt && pending.createdAtSec <= nowSec && bytes32(actionId);
}

/** A local lifecycle label is not proof that an unexpired on-chain key is gone. */
export function agentOccupiesWallet(
  agent: AgentRecord,
  context: SessionRevocationContext | null,
  nowMs: number,
  sessionKeyPresent = false,
): boolean {
  if (validProvisioningCancellation(agent, Math.floor(nowMs / 1_000))) return false;
  if (agent.status === "provisioning" || agent.status === "armed" || agent.status === "paused") return true;
  if (sessionKeyPresent) return true;
  if (validSessionRevocationProof(agent, context, nowMs)) return false;
  if (agent.sessionFacts !== null) {
    const expiry = agent.sessionFacts.expiry;
    const expiryMs = expiry * 1_000;
    return !Number.isSafeInteger(expiry) || expiry < 0
      || !Number.isSafeInteger(expiryMs) || expiryMs > nowMs;
  }
  return agent.status === "revoked";
}

export function isExclusiveTradeAgent(agent: AgentRecord): boolean {
  return agent.pendingGrant?.sizing.sizingPreset === "trade-v1"
    || agent.sessionFacts?.hireSizing?.name === "trade-v1";
}

function walletConflict(
  candidate: AgentRecord,
  existing: Iterable<{ readonly record: AgentRecord; readonly sessionKeyPresent: boolean }>,
  context: SessionRevocationContext | null,
  nowMs: number,
): AgentRecord | null {
  if (!agentOccupiesWallet(candidate, context, nowMs)) return null;
  const candidateTrade = isExclusiveTradeAgent(candidate);
  for (const occupant of existing) {
    const row = occupant.record;
    if (row.id === candidate.id || row.ownerAddress !== candidate.ownerAddress
      || row.walletAddress.toLowerCase() !== candidate.walletAddress.toLowerCase()
      || !agentOccupiesWallet(row, context, nowMs, occupant.sessionKeyPresent)) continue;
    if (candidate.custodyModel === "passkey" || row.custodyModel === "passkey"
      || candidateTrade || isExclusiveTradeAgent(row)) return row;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Session-key envelope                                                       */
/* -------------------------------------------------------------------------- */

/** How a session key is held: encrypted when a master key exists, else plain. */
type StoredKey =
  | { readonly kind: "encrypted"; readonly ciphertext: string }
  | { readonly kind: "plaintext"; readonly value: Hex };

function sealKey(sessionKey: Hex, masterKey: Buffer | null): StoredKey {
  if (masterKey === null) {
    return { kind: "plaintext", value: sessionKey };
  }
  return { kind: "encrypted", ciphertext: encryptSecret(sessionKey, masterKey) };
}

function openKey(stored: StoredKey, masterKey: Buffer | null): Hex {
  if (stored.kind === "plaintext") return stored.value;
  if (masterKey === null) {
    throw new Error(
      "A master key is required to decrypt a stored session key, but none is configured.",
    );
  }
  return decryptSecret(stored.ciphertext, masterKey) as Hex;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

type MemoryAgent = {
  record: AgentRecord;
  key: StoredKey | undefined;
};

/**
 * Process-local store for development and tests. State is lost on restart, by
 * design. Records are cloned in and out so callers cannot mutate stored state
 * through a returned reference.
 */
export class MemoryAgentStore implements AgentStore {
  readonly durable = false;
  readonly keyEncryptionConfigured: boolean;
  readonly #agents = new Map<string, MemoryAgent>();
  readonly #health = new Map<string, ExecutorHealth>();
  readonly #masterKey: Buffer | null;
  readonly #now: Clock;
  readonly #revocationContext: SessionRevocationContext | null;
  readonly #walletFences = new Map<string, Promise<void>>();

  constructor(
    masterKey: Buffer | null = null,
    now: Clock = Date.now,
    revocationContext: SessionRevocationContext | null = null,
  ) {
    this.#masterKey = masterKey;
    this.keyEncryptionConfigured = masterKey !== null;
    this.#now = now;
    this.#revocationContext = revocationContext;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const at = this.#now();
    const record: AgentRecord = {
      id: input.id,
      ownerAddress: ownerKey(input.ownerAddress),
      walletAddress: getAddress(input.walletAddress),
      custodyModel: input.custodyModel,
      sessionFacts: input.sessionFacts ?? null,
      sessionRevocation: null,
      caps: input.caps ?? null,
      status: input.status ?? "provisioning",
      httpRuntimeProfile: input.httpRuntimeProfile ?? "unbound-v1",
      erc8004AgentId: input.erc8004AgentId ?? null,
      pendingGrant: null,
      rowVersion: 1,
      createdAt: at,
      updatedAt: at,
    };
    return this.#withWalletFence(record.ownerAddress, record.walletAddress, async () => {
      if (this.#agents.has(input.id)) throw new AgentExistsError(input.id);
      const blocker = walletConflict(record, [...this.#agents.values()].map((entry) => ({
        record: entry.record,
        sessionKeyPresent: entry.key !== undefined,
      })), this.#revocationContext, this.#now());
      if (blocker !== null) {
        throw new AgentWalletInUseError(blocker.id);
      }
      this.#agents.set(input.id, { record: structuredClone(record), key: undefined });
      return structuredClone(record);
    });
  }

  async createProvisioningAgent(input: CreateProvisioningAgentInput): Promise<AgentRecord> {
    const pendingGrant = structuredClone(input.pendingGrant);
    input.signal?.throwIfAborted();
    if (hasProvisioningCancellation(pendingGrant)) throw new Error("Cancellation fields are store-owned.");
    const at = this.#now();
    const record: AgentRecord = {
      id: input.record.id,
      ownerAddress: ownerKey(input.record.ownerAddress),
      walletAddress: getAddress(input.record.walletAddress),
      custodyModel: input.record.custodyModel,
      sessionFacts: null,
      sessionRevocation: null,
      caps: input.record.caps ?? null,
      status: "provisioning",
      httpRuntimeProfile: input.record.httpRuntimeProfile ?? "lp-v1",
      erc8004AgentId: input.record.erc8004AgentId ?? null,
      pendingGrant,
      rowVersion: 1,
      createdAt: at,
      updatedAt: at,
    };
    return this.#withWalletFence(record.ownerAddress, record.walletAddress, async () => {
      input.signal?.throwIfAborted();
      if (this.#agents.has(input.record.id)) throw new AgentExistsError(input.record.id);
      const blocker = walletConflict(record, [...this.#agents.values()].map((entry) => ({
        record: entry.record,
        sessionKeyPresent: entry.key !== undefined,
      })), this.#revocationContext, this.#now());
      if (blocker !== null) {
        throw new AgentWalletInUseError(blocker.id);
      }
      this.#agents.set(input.record.id, {
        record: structuredClone(record),
        key: sealKey(input.sessionKey, this.#masterKey),
      });
      return structuredClone(record);
    });
  }

  async getAgent(ownerAddress: Address, id: string): Promise<AgentRecord | null> {
    const entry = this.#owned(ownerAddress, id);
    return entry === undefined ? null : structuredClone(entry.record);
  }

  async getAgentById(id: string): Promise<AgentRecord | null> {
    const entry = this.#agents.get(id);
    return entry === undefined ? null : structuredClone(entry.record);
  }

  async listAgents(ownerAddress: Address): Promise<AgentRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#agents.values()]
      .filter((entry) => entry.record.ownerAddress === owner)
      .map((entry) => structuredClone(entry.record))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async listAgentsBounded(ownerAddress: Address, limit: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error("Invalid agent list limit.");
    const owner = ownerKey(ownerAddress);
    const rows = [...this.#agents.values()]
      .filter((entry) => entry.record.ownerAddress === owner)
      .map((entry) => structuredClone(entry.record))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async listProvisioningAgentsForWorker(input: {
    readonly afterId: string | null;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();
    assertWorkerLimit(input.limit);
    const rows = [...this.#agents.values()]
      .map((entry) => entry.record)
      .filter((row) => row.status === "provisioning" && (input.afterId === null || row.id > input.afterId))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      rows: structuredClone(rows.slice(0, input.limit)),
      hasMore: rows.length > input.limit,
    };
  }

  async armProvisioningAgent(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedRowVersion: number;
    readonly expectedGrantDigest: Hex; readonly sessionFacts: SessionFacts;
  }): Promise<ProvisioningCasResult> {
    const initial = this.#owned(input.ownerAddress, input.agentId);
    if (initial === undefined) return { updated: false, failure: "not_found" };
    return this.#withWalletFence(initial.record.ownerAddress, initial.record.walletAddress, async () => {
      const entry = this.#owned(input.ownerAddress, input.agentId);
      if (entry === undefined || entry.record.status !== "provisioning"
        || entry.record.rowVersion !== input.expectedRowVersion
        || entry.record.pendingGrant?.grantDigest.toLowerCase() !== input.expectedGrantDigest.toLowerCase()
        || hasProvisioningCancellation(entry.record.pendingGrant)) {
        return { updated: false, failure: entry === undefined ? "not_found" : "state_changed" };
      }
      if (walletConflict(entry.record, [...this.#agents.values()].map((candidate) => ({
        record: candidate.record,
        sessionKeyPresent: candidate.key !== undefined,
      })), this.#revocationContext, this.#now())) {
        return { updated: false, failure: "wallet_in_use" };
      }
      entry.record = structuredClone({
        ...entry.record,
        status: "armed",
        erc8004Identity: entry.record.erc8004Identity ?? (entry.record.erc8004AgentId === null && categoryForPreset(entry.record.pendingGrant?.sizing.sizingPreset) !== null
          ? newIdentity(categoryForPreset(entry.record.pendingGrant?.sizing.sizingPreset)!) : null),
        sessionFacts: structuredClone(input.sessionFacts),
        pendingGrant: null,
        rowVersion: entry.record.rowVersion + 1,
        updatedAt: this.#now(),
      });
      return { updated: true };
    });
  }

  async identitySource(id: string): Promise<IdentitySource | null> {
    const entry = this.#agents.get(id);
    return entry === undefined ? null : structuredClone(sourceFromRecord(entry.record));
  }

  async identityOutbox(afterId = ""): Promise<readonly IdentitySource[]> {
    return [...this.#agents.values()].filter((entry) => entry.record.erc8004Identity != null && entry.record.id > afterId)
      .sort((a, b) => a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0).slice(0, 100)
      .map((entry) => structuredClone(sourceFromRecord(entry.record)));
  }

  async enrollIdentity(id: string, category?: IdentityCategory): Promise<IdentitySource> {
    const entry = this.#agents.get(id); if (entry === undefined) identityFail("not_found");
    const source = sourceFromRecord(entry.record);
    if (source.identity !== null || source.existingId !== null) identityFail("conflict");
    const selected = source.category ?? (category === "trading" && entry.record.httpRuntimeProfile === "trade-v1" ? "trading" : (category === "lp" || category === "grid") && entry.record.httpRuntimeProfile === "lp-v1" ? category : null);
    if (!source.eligible || selected === null || category !== undefined && category !== selected) identityFail("ineligible");
    entry.record = { ...entry.record, erc8004Identity: newIdentity(selected) };
    return structuredClone(sourceFromRecord(entry.record));
  }

  async projectIdentity(source: IdentitySource, next: Erc8004IdentitySummary, fence: IdentityFence): Promise<boolean> {
    fence.check();
    const entry = this.#owned(source.owner, source.id);
    if (entry === undefined || JSON.stringify(entry.record.erc8004Identity) !== JSON.stringify(source.identity)
      || !projectionAllowed(sourceFromRecord(entry.record), next)) return false;
    entry.record = { ...entry.record, erc8004Identity: structuredClone(next),
      erc8004AgentId: next.status === "registered" ? next.agentId : entry.record.erc8004AgentId };
    return true;
  }

  async startGrantAttemptCas(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedGrantDigest: Hex;
    readonly attemptId: Hex; readonly startedAtSec: number;
  }): Promise<GrantAttemptCasResult> {
    const entry = this.#owned(input.ownerAddress, input.agentId);
    if (entry === undefined) return { kind: "not_found" };
    const pending = entry.record.pendingGrant;
    if (entry.record.status !== "provisioning" || pending === null
      || pending.grantDigest.toLowerCase() !== input.expectedGrantDigest.toLowerCase()
      || (pending.sizing.sizingPreset !== "trade-v1" && pending.sizing.sizingPreset !== "lp-v1")
      || (pending.sizing.sizingPreset === "trade-v1" && pending.autoGrant !== true)
      || hasProvisioningCancellation(pending)) return { kind: "conflict" };
    if (pending.grantAttempt !== undefined) {
      return pending.grantAttempt.attemptId.toLowerCase() === input.attemptId.toLowerCase()
        ? { kind: "same", agent: structuredClone(entry.record) }
        : { kind: "conflict" };
    }
    entry.record = structuredClone({ ...entry.record,
      pendingGrant: { ...pending, grantAttempt: { version: 1, attemptId: input.attemptId, startedAtSec: input.startedAtSec } },
      rowVersion: entry.record.rowVersion + 1, updatedAt: this.#now() });
    return { kind: "created", agent: structuredClone(entry.record) };
  }

  async resetGrantAttemptCas(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedGrantDigest: Hex;
    readonly attemptId: Hex; readonly resetActionId: Hex; readonly resetAtSec: number;
  }): Promise<GrantAttemptResetCasResult> {
    const entry = this.#owned(input.ownerAddress, input.agentId);
    if (entry === undefined) return { kind: "not_found" };
    const pending = entry.record.pendingGrant;
    if (entry.record.status !== "provisioning" || pending === null
      || pending.grantDigest.toLowerCase() !== input.expectedGrantDigest.toLowerCase()
      || hasProvisioningCancellation(pending)) return { kind: "conflict" };
    const prior = pending.lastGrantAttemptReset;
    if (prior?.resetActionId.toLowerCase() === input.resetActionId.toLowerCase()
      && prior.clearedAttemptId.toLowerCase() === input.attemptId.toLowerCase()
      && pending.grantAttempt === undefined) return { kind: "same", agent: structuredClone(entry.record) };
    if (pending.grantAttempt?.attemptId.toLowerCase() !== input.attemptId.toLowerCase()) return { kind: "conflict" };
    const { grantAttempt: _cleared, ...rest } = pending;
    entry.record = structuredClone({ ...entry.record,
      pendingGrant: { ...rest, lastGrantAttemptReset: { version: 1, resetActionId: input.resetActionId,
        clearedAttemptId: input.attemptId, resetAtSec: input.resetAtSec } },
      rowVersion: entry.record.rowVersion + 1, updatedAt: this.#now() });
    return { kind: "cleared", agent: structuredClone(entry.record) };
  }

  async confirmSessionRevokedCas(input: ConfirmSessionRevokedInput): Promise<ConfirmSessionRevokedResult> {
    input.signal?.throwIfAborted();
    const initial = this.#owned(input.ownerAddress, input.agentId);
    if (initial === undefined) return { kind: "not_found" };
    return this.#withWalletFence(initial.record.ownerAddress, initial.record.walletAddress, async () => {
      input.signal?.throwIfAborted();
      const entry = this.#owned(input.ownerAddress, input.agentId);
      if (entry === undefined) return { kind: "not_found" };
      const stored = parseSessionRevocationEvidence(entry.record.sessionRevocation);
      const incoming = parseSessionRevocationEvidence(input.evidence);
      if (stored !== null && incoming !== null && sameRevocationIdentity(stored, incoming)
        && entry.record.status === "revoked" && entry.key === undefined
        && validSessionRevocationProof(entry.record, this.#revocationContext, this.#now())) {
        return { kind: "same", agent: structuredClone(entry.record) };
      }
      if (incoming === null || entry.record.sessionRevocation !== null || entry.record.status !== "revoked"
        || entry.record.rowVersion !== input.expectedRowVersion
        || !validConfirmation(input, entry.record, this.#revocationContext, this.#now())) return { kind: "conflict" };
      entry.record = structuredClone({
        ...entry.record,
        sessionRevocation: incoming,
        rowVersion: entry.record.rowVersion + 1,
        updatedAt: this.#now(),
      });
      entry.key = undefined;
      return { kind: "confirmed", agent: structuredClone(entry.record) };
    });
  }

  async cancelProvisioningAgent(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedRowVersion: number;
    readonly expectedGrantDigest: Hex; readonly nowSec: number;
    readonly cancelActionId: Hex;
  }): Promise<ProvisioningCasResult> {
    const initial = this.#owned(input.ownerAddress, input.agentId);
    if (initial === undefined) return { updated: false, failure: "not_found" };
    return this.#withWalletFence(initial.record.ownerAddress, initial.record.walletAddress, async () => {
      const entry = this.#owned(input.ownerAddress, input.agentId);
      const pending = entry?.record.pendingGrant;
      if (entry === undefined || entry.record.status !== "provisioning" || pending === null || pending === undefined
        || entry.record.rowVersion !== input.expectedRowVersion
        || pending.grantDigest.toLowerCase() !== input.expectedGrantDigest.toLowerCase()) {
        return { updated: false, failure: entry === undefined ? "not_found" : "state_changed" };
      }
      if (entry.record.sessionFacts !== null || entry.record.sessionRevocation !== null
        || entry.record.sessionStateDecodeMismatch === true
        || !validCancelTransition(pending, input.nowSec, input.cancelActionId)) {
        return { updated: false, failure: "state_changed" };
      }
      const retire = input.nowSec >= pending.expiresAt;
      entry.record = structuredClone({
        ...entry.record,
        status: retire ? "retired" : "provisioning",
        pendingGrant: retire ? null : {
          ...pending,
          cancelRequestedAtSec: input.nowSec,
          cancelActionId: input.cancelActionId,
        },
        rowVersion: entry.record.rowVersion + 1,
        updatedAt: this.#now(),
      });
      if (retire) entry.key = undefined;
      return { updated: true, retired: retire };
    });
  }

  async transitionAgentStatus(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedStatus: AgentStatus;
    readonly expectedRowVersion: number; readonly status: AgentStatus;
  }): Promise<AgentRecord | null> {
    if (!isOrdinaryLifecycleTransition(input.expectedStatus, input.status)) return null;
    const initial = this.#owned(input.ownerAddress, input.agentId);
    if (initial === undefined) return null;
    return this.#withWalletFence(initial.record.ownerAddress, initial.record.walletAddress, async () => {
      const entry = this.#owned(input.ownerAddress, input.agentId);
      if (entry === undefined || entry.record.status !== input.expectedStatus
        || entry.record.rowVersion !== input.expectedRowVersion
        || hasProvisioningCancellation(entry.record.pendingGrant)) return null;
      return this.#mutate(input.ownerAddress, input.agentId, (record) => ({ ...record, status: input.status }));
    });
  }

  async updateAgentCapsCas(input: {
    readonly ownerAddress: Address; readonly agentId: string;
    readonly expectedRowVersion: number; readonly caps: AgentCaps;
  }): Promise<AgentRecord | null> {
    const entry = this.#owned(input.ownerAddress, input.agentId);
    if (entry === undefined || (entry.record.status !== "armed" && entry.record.status !== "paused") || entry.record.rowVersion !== input.expectedRowVersion) return null;
    return this.#mutate(input.ownerAddress, input.agentId, (record) => ({ ...record, caps: structuredClone(input.caps) }));
  }

  async bindHttpRuntimeProfileCas(input: {
    readonly ownerAddress: Address; readonly agentId: string;
    readonly expectedRowVersion: number; readonly profile: BindableHttpRuntimeProfile;
  }): Promise<BindHttpRuntimeProfileResult> {
    const entry = this.#owned(input.ownerAddress, input.agentId);
    if (entry === undefined) return { kind: "not_found" };
    if ((entry.record.status !== "armed" && entry.record.status !== "paused") || entry.record.rowVersion !== input.expectedRowVersion) return { kind: "conflict", agent: structuredClone(entry.record) };
    return this.bindHttpRuntimeProfile(input.ownerAddress, input.agentId, input.profile);
  }

  async updateAgentStatus(
    ownerAddress: Address,
    id: string,
    status: AgentStatus,
  ): Promise<AgentRecord | null> {
    const initial = this.#owned(ownerAddress, id);
    if (initial === undefined) return null;
    return this.#withWalletFence(initial.record.ownerAddress, initial.record.walletAddress, async () => {
      const current = this.#owned(ownerAddress, id)?.record;
      if (current === undefined || hasProvisioningCancellation(current.pendingGrant)) return null;
      return this.#mutate(ownerAddress, id, (record) => ({ ...record, status }));
    });
  }

  async updateAgentSessionFacts(
    ownerAddress: Address,
    id: string,
    facts: SessionFacts,
  ): Promise<AgentRecord | null> {
    const initial = this.#owned(ownerAddress, id);
    if (initial === undefined) return null;
    return this.#withWalletFence(initial.record.ownerAddress, initial.record.walletAddress, async () =>
      this.#owned(ownerAddress, id)?.record.sessionRevocation !== null
        || hasProvisioningCancellation(this.#owned(ownerAddress, id)?.record.pendingGrant)
        ? null
        : this.#mutate(ownerAddress, id, (record) => ({
          ...record,
          sessionFacts: structuredClone(facts),
        })),
    );
  }

  async updateAgentCaps(
    ownerAddress: Address,
    id: string,
    caps: AgentCaps,
  ): Promise<AgentRecord | null> {
    return this.#mutate(ownerAddress, id, (record) => ({
      ...record,
      caps: structuredClone(caps),
    }));
  }

  async updateAgentErc8004Id(
    ownerAddress: Address,
    id: string,
    erc8004AgentId: string | null,
  ): Promise<AgentRecord | null> {
    return this.#mutate(ownerAddress, id, (record) => ({
      ...record,
      erc8004AgentId,
    }));
  }

  async bindHttpRuntimeProfile(
    ownerAddress: Address,
    id: string,
    profile: BindableHttpRuntimeProfile,
  ): Promise<BindHttpRuntimeProfileResult> {
    const entry = this.#owned(ownerAddress, id);
    if (entry === undefined) return { kind: "not_found" };
    if (entry.record.httpRuntimeProfile === profile) {
      return { kind: "same", agent: structuredClone(entry.record) };
    }
    if (entry.record.httpRuntimeProfile !== "unbound-v1") {
      return { kind: "conflict", agent: structuredClone(entry.record) };
    }
    const next: AgentRecord = {
      ...entry.record,
      httpRuntimeProfile: profile,
      rowVersion: entry.record.rowVersion + 1,
      updatedAt: this.#now(),
    };
    entry.record = structuredClone(next);
    return { kind: "updated", agent: structuredClone(next) };
  }

  async putAgentSessionKey(
    ownerAddress: Address,
    id: string,
    sessionKey: Hex,
  ): Promise<void> {
    const initial = this.#owned(ownerAddress, id);
    if (initial === undefined) {
      throw new Error(`Agent "${id}" not found for this owner.`);
    }
    await this.#withWalletFence(initial.record.ownerAddress, initial.record.walletAddress, async () => {
      const entry = this.#owned(ownerAddress, id);
      if (entry === undefined) throw new Error(`Agent "${id}" not found for this owner.`);
      if (entry.record.status === "revoked" || entry.record.sessionRevocation !== null) {
        throw new Error("Refusing to restore a revoked agent session key.");
      }
      entry.key = sealKey(sessionKey, this.#masterKey);
      entry.record = { ...entry.record, rowVersion: entry.record.rowVersion + 1, updatedAt: this.#now() };
    });
  }

  async getAgentSessionKey(
    ownerAddress: Address,
    id: string,
  ): Promise<Hex | null> {
    const entry = this.#owned(ownerAddress, id);
    if (entry === undefined || entry.key === undefined) return null;
    return openKey(entry.key, this.#masterKey);
  }

  async hasAgentSessionKey(ownerAddress: Address, id: string): Promise<boolean> {
    return this.#owned(ownerAddress, id)?.key !== undefined;
  }

  async putExecutorHealth(health: ExecutorHealth): Promise<void> {
    this.#health.set(health.executor, {
      ...health,
      lastError: health.lastError?.slice(0, MAX_ERROR_CHARS) ?? null,
    });
  }

  async getExecutorHealth(): Promise<ExecutorHealth[]> {
    return [...this.#health.values()]
      .map((health) => ({ ...health }))
      .sort((a, b) => a.executor.localeCompare(b.executor));
  }

  async close(): Promise<void> {
    this.#agents.clear();
    this.#health.clear();
    this.#walletFences.clear();
  }

  async #withWalletFence<T>(ownerAddress: Address, walletAddress: Address, work: () => Promise<T>): Promise<T> {
    const key = `${ownerAddress}|${walletAddress.toLowerCase()}`;
    const prior = this.#walletFences.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    this.#walletFences.set(key, tail);
    await prior;
    try { return await work(); }
    finally {
      release();
      if (this.#walletFences.get(key) === tail) this.#walletFences.delete(key);
    }
  }

  #owned(ownerAddress: Address, id: string): MemoryAgent | undefined {
    const entry = this.#agents.get(id);
    if (entry === undefined) return undefined;
    return entry.record.ownerAddress === ownerKey(ownerAddress) ? entry : undefined;
  }

  #mutate(
    ownerAddress: Address,
    id: string,
    change: (record: AgentRecord) => AgentRecord,
  ): AgentRecord | null {
    const entry = this.#owned(ownerAddress, id);
    if (entry === undefined) return null;
    const next: AgentRecord = { ...change(entry.record), rowVersion: entry.record.rowVersion + 1, updatedAt: this.#now() };
    entry.record = structuredClone(next);
    return structuredClone(next);
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type AgentRow = {
  id: string;
  owner_address: string;
  wallet_address: string;
  custody_model: string;
  session_facts: unknown;
  session_revocation: unknown;
  session_state_empty: boolean;
  caps: unknown;
  status: string;
  http_runtime_profile: string;
  erc8004_agent_id: string | null;
  erc8004_identity?: unknown;
  identity_absent?: boolean;
  pending_grant: unknown;
  row_version: number;
  created_at: Date;
  updated_at: Date;
};

type WalletOccupantRow = AgentRow & { session_key_present: boolean };

const AGENT_COLUMNS = "id, owner_address, wallet_address, custody_model, session_facts, session_revocation, (session_facts is null and session_revocation is null) as session_state_empty, caps, status, http_runtime_profile, erc8004_agent_id, erc8004_identity, (erc8004_identity is null) as identity_absent, pending_grant, row_version, created_at, updated_at";

type HealthRow = {
  executor: string;
  last_ok_at: Date | null;
  last_error_at: Date | null;
  last_error: string | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
};

const AGENTS_DDL = `
  create table if not exists agents (
    id text primary key,
    owner_address text not null,
    wallet_address text not null,
    custody_model text not null,
    session_facts jsonb,
    session_revocation jsonb,
    session_key_ciphertext text,
    caps jsonb,
    status text not null,
    http_runtime_profile text not null default 'unbound-v1',
    erc8004_agent_id text,
    pending_grant jsonb,
    row_version integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )
`;

/** Migration for tables created before the ERC-8004 column existed. */
const AGENTS_ERC8004_MIGRATION_DDL = `
  alter table agents add column if not exists erc8004_agent_id text
`;

const AGENTS_HTTP_RUNTIME_PROFILE_MIGRATION_DDL = `
  alter table agents add column if not exists http_runtime_profile text not null default 'unbound-v1'
`;

const AGENTS_PENDING_GRANT_MIGRATION_DDL = `
  alter table agents add column if not exists pending_grant jsonb
`;

const AGENTS_ROW_VERSION_MIGRATION_DDL = `
  alter table agents add column if not exists row_version integer not null default 1
`;

const AGENTS_SESSION_REVOCATION_MIGRATION_DDL = `
  alter table agents add column if not exists session_revocation jsonb
`;

const AGENTS_OWNER_INDEX_DDL = `
  create index if not exists agents_owner_idx on agents (owner_address)
`;

const EXECUTOR_HEALTH_DDL = `
  create table if not exists executor_health (
    executor text primary key,
    last_ok_at timestamptz,
    last_error_at timestamptz,
    last_error text,
    last_latency_ms int,
    consecutive_failures int not null default 0,
    updated_at timestamptz not null default now()
  )
`;

function toEpoch(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

/**
 * Durable Postgres store. Construct via {@link PostgresAgentStore.create} so the
 * idempotent DDL runs before the instance is handed out. All SQL is
 * parameterized; jsonb is passed through `$n::jsonb` bind parameters.
 */
export class PostgresAgentStore implements AgentStore {
  readonly durable = true;
  readonly keyEncryptionConfigured: boolean;
  readonly #sql: SqlClient;
  readonly #masterKey: Buffer | null;
  readonly #now: Clock;
  readonly #revocationContext: SessionRevocationContext | null;

  private constructor(
    sql: SqlClient,
    masterKey: Buffer | null,
    now: Clock,
    revocationContext: SessionRevocationContext | null,
  ) {
    this.#sql = sql;
    this.#masterKey = masterKey;
    this.keyEncryptionConfigured = masterKey !== null;
    this.#now = now;
    this.#revocationContext = revocationContext;
  }

  static async create(
    sql: SqlClient,
    masterKey: Buffer | null,
    now: Clock = Date.now,
    revocationContext: SessionRevocationContext | null = null,
  ): Promise<PostgresAgentStore> {
    await sql.query(AGENTS_DDL);
    await sql.query(AGENTS_ERC8004_MIGRATION_DDL);
    await sql.query(IDENTITY_AGENT_MIGRATION);
    await sql.query(IDENTITY_AGENT_INDEX);
    await sql.query(AGENTS_HTTP_RUNTIME_PROFILE_MIGRATION_DDL);
    await sql.query(AGENTS_PENDING_GRANT_MIGRATION_DDL);
    await sql.query(AGENTS_ROW_VERSION_MIGRATION_DDL);
    await sql.query(AGENTS_SESSION_REVOCATION_MIGRATION_DDL);
    await sql.query(AGENTS_OWNER_INDEX_DDL);
    await sql.query(EXECUTOR_HEALTH_DDL);
    return new PostgresAgentStore(sql, masterKey, now, revocationContext);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const at = new Date(this.#now());
    const status = input.status ?? "provisioning";
    const owner = ownerKey(input.ownerAddress);
    const wallet = getAddress(input.walletAddress);
    const candidate: AgentRecord = {
      id: input.id, ownerAddress: owner, walletAddress: wallet, custodyModel: input.custodyModel,
      sessionFacts: input.sessionFacts ?? null, sessionRevocation: null, caps: input.caps ?? null, status,
      httpRuntimeProfile: input.httpRuntimeProfile ?? "unbound-v1",
      erc8004AgentId: input.erc8004AgentId ?? null, pendingGrant: null,
      rowVersion: 1, createdAt: at.getTime(), updatedAt: at.getTime(),
    };
    const result = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`, [`${owner}|${wallet.toLowerCase()}`]);
      const neighbours = await tx.query<WalletOccupantRow>(
        `/* agents.walletOccupants */ select ${AGENT_COLUMNS}, session_key_ciphertext is not null as session_key_present
         from agents where owner_address = $1 and lower(wallet_address) = lower($2)`,
        [owner, wallet],
      );
      const blocker = walletConflict(candidate, neighbours.rows.map((row) => ({
        record: rowToRecord(row), sessionKeyPresent: row.session_key_present,
      })), this.#revocationContext, this.#now());
      if (blocker !== null) throw new AgentWalletInUseError(blocker.id);
      return tx.query<AgentRow>(
        `/* agents.create */
         insert into agents
            (id, owner_address, wallet_address, custody_model, session_facts, session_revocation, caps, status, http_runtime_profile, erc8004_agent_id, pending_grant, row_version, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, null, $6::jsonb, $7, $8, $9, null, 1, $10, $10)
         on conflict (id) do nothing
         returning ${AGENT_COLUMNS}`,
        [input.id, owner, wallet, input.custodyModel,
          input.sessionFacts === undefined ? null : encodeJsonbParam(input.sessionFacts),
          input.caps === undefined ? null : encodeJsonbParam(input.caps), status,
          input.httpRuntimeProfile ?? "unbound-v1", input.erc8004AgentId ?? null, at],
      );
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new AgentExistsError(input.id);
    }
    return rowToRecord(row);
  }

  async createProvisioningAgent(input: CreateProvisioningAgentInput): Promise<AgentRecord> {
    const pendingGrant = structuredClone(input.pendingGrant);
    input.signal?.throwIfAborted();
    if (hasProvisioningCancellation(pendingGrant)) throw new Error("Cancellation fields are store-owned.");
    if (this.#masterKey === null) {
      throw new Error("Refusing to persist a session key without encryption configured; set EXECUTION_MASTER_KEY.");
    }
    const at = new Date(this.#now());
    const ciphertext = encryptSecret(input.sessionKey, this.#masterKey);
    const owner = ownerKey(input.record.ownerAddress);
    const wallet = getAddress(input.record.walletAddress);
    const candidate: AgentRecord = {
      id: input.record.id, ownerAddress: owner, walletAddress: wallet,
      custodyModel: input.record.custodyModel, sessionFacts: null,
      sessionRevocation: null,
      caps: input.record.caps ?? null, status: "provisioning",
      httpRuntimeProfile: input.record.httpRuntimeProfile ?? "lp-v1",
      erc8004AgentId: input.record.erc8004AgentId ?? null,
      pendingGrant, rowVersion: 1, createdAt: at.getTime(), updatedAt: at.getTime(),
    };
    const result = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`,
        [`${owner}|${wallet.toLowerCase()}`],
        { ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: 5_000 });
      input.signal?.throwIfAborted();
      const neighbours = await tx.query<WalletOccupantRow>(
        `/* agents.walletOccupants */ select ${AGENT_COLUMNS}, session_key_ciphertext is not null as session_key_present
         from agents where owner_address = $1 and lower(wallet_address) = lower($2)`,
        [owner, wallet],
        { ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: 5_000 },
      );
      input.signal?.throwIfAborted();
      const blocker = walletConflict(candidate, neighbours.rows.map((row) => ({
        record: rowToRecord(row), sessionKeyPresent: row.session_key_present,
      })), this.#revocationContext, this.#now());
      if (blocker !== null) throw new AgentWalletInUseError(blocker.id);
      return tx.query<AgentRow>(
        `/* agents.createProvisioning */
         insert into agents
           (id, owner_address, wallet_address, custody_model, session_facts, session_revocation, session_key_ciphertext, caps, status, http_runtime_profile, erc8004_agent_id, pending_grant, row_version, created_at, updated_at)
         values ($1, $2, $3, $4, null, null, $5, $6::jsonb, 'provisioning', $7, $8, $9::jsonb, 1, $10, $10)
         on conflict (id) do nothing
         returning ${AGENT_COLUMNS}`,
        [input.record.id, owner, wallet, input.record.custodyModel, ciphertext,
          input.record.caps === undefined ? null : encodeJsonbParam(input.record.caps),
          input.record.httpRuntimeProfile ?? "lp-v1", input.record.erc8004AgentId ?? null,
          encodeJsonbParam(pendingGrant), at],
        { ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: 5_000 },
      );
    });
    const row = result.rows[0];
    if (row === undefined) throw new AgentExistsError(input.record.id);
    return rowToRecord(row);
  }

  async getAgent(ownerAddress: Address, id: string): Promise<AgentRecord | null> {
    const result = await this.#sql.query<AgentRow>(
      `/* agents.get */
       select ${AGENT_COLUMNS}
       from agents where id = $1 and owner_address = $2`,
      [id, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async getAgentById(id: string): Promise<AgentRecord | null> {
    const result = await this.#sql.query<AgentRow>(
      `/* agents.getById */
       select ${AGENT_COLUMNS}
       from agents where id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async listAgents(ownerAddress: Address): Promise<AgentRecord[]> {
    const result = await this.#sql.query<AgentRow>(
      `/* agents.list */
       select ${AGENT_COLUMNS}
       from agents where owner_address = $1
       order by created_at asc, id asc`,
      [ownerKey(ownerAddress)],
    );
    return result.rows.map(rowToRecord);
  }

  async listAgentsBounded(ownerAddress: Address, limit: number, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error("Invalid agent list limit.");
    const result = await this.#sql.query<AgentRow>(
      `/* agents.listBounded */
       select ${AGENT_COLUMNS}
       from agents where owner_address = $1
       order by id asc limit $2`,
        [ownerKey(ownerAddress), limit + 1],
        { ...(signal === undefined ? {} : { signal }), timeoutMs: 5_000 },
    );
    return { rows: result.rows.slice(0, limit).map(rowToRecord), hasMore: result.rows.length > limit };
  }

  async listProvisioningAgentsForWorker(input: {
    readonly afterId: string | null; readonly limit: number; readonly signal?: AbortSignal;
  }) {
    assertWorkerLimit(input.limit);
    const result = await this.#sql.query<AgentRow>(
      `/* agents.listProvisioningWorker */
       select ${AGENT_COLUMNS}
       from agents
       where status = 'provisioning' and ($1::text is null or id > $1)
       order by id asc limit $2`,
      [input.afterId, input.limit + 1],
      { ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: 5_000 },
    );
    return { rows: result.rows.slice(0, input.limit).map(rowToRecord), hasMore: result.rows.length > input.limit };
  }

  async armProvisioningAgent(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedRowVersion: number;
    readonly expectedGrantDigest: Hex; readonly sessionFacts: SessionFacts;
  }): Promise<ProvisioningCasResult> {
    const owner = ownerKey(input.ownerAddress);
    return this.#sql.transaction(async (tx) => {
      const initial = await tx.query<AgentRow>(
        `/* agents.armRead */ select ${AGENT_COLUMNS} from agents where id = $1 and owner_address = $2`,
        [input.agentId, owner],
      );
      const first = initial.rows[0];
      if (first === undefined) return { updated: false, failure: "not_found" } as const;
      const firstRecord = rowToRecord(first);
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`,
        [`${owner}|${firstRecord.walletAddress.toLowerCase()}`]);
      const currentRead = await tx.query<AgentRow>(
        `/* agents.armCurrent */ select ${AGENT_COLUMNS} from agents where id = $1 and owner_address = $2 for update`,
        [input.agentId, owner],
      );
      const currentRow = currentRead.rows[0];
      if (currentRow === undefined) return { updated: false, failure: "not_found" } as const;
      const current = rowToRecord(currentRow);
      if (current.status !== "provisioning" || current.rowVersion !== input.expectedRowVersion
        || current.pendingGrant?.grantDigest.toLowerCase() !== input.expectedGrantDigest.toLowerCase()
        || hasProvisioningCancellation(current.pendingGrant)) {
        return { updated: false, failure: "state_changed" } as const;
      }
      const neighbours = await tx.query<WalletOccupantRow>(
        `/* agents.walletOccupants */ select ${AGENT_COLUMNS}, session_key_ciphertext is not null as session_key_present
         from agents where owner_address = $1 and lower(wallet_address) = lower($2)`,
        [owner, current.walletAddress],
      );
      if (walletConflict(current, neighbours.rows.map((row) => ({
        record: rowToRecord(row), sessionKeyPresent: row.session_key_present,
      })), this.#revocationContext, this.#now())) {
        return { updated: false, failure: "wallet_in_use" } as const;
      }
      const result = await tx.query<{ id: string }>(
        `/* agents.armProvisioning */
         update agents
         set session_facts = $5::jsonb, status = 'armed', pending_grant = null,
             erc8004_identity = case when erc8004_identity is null and erc8004_agent_id is null then $7::jsonb else erc8004_identity end,
             row_version = row_version + 1, updated_at = $6
         where id = $1 and owner_address = $2 and status = 'provisioning'
           and row_version = $3 and pending_grant->>'grantDigest' = $4
           and not (pending_grant ? 'cancelRequestedAtSec')
           and not (pending_grant ? 'cancelActionId')
         returning id`,
        [input.agentId, owner, input.expectedRowVersion,
          input.expectedGrantDigest, encodeJsonbParam(input.sessionFacts), new Date(this.#now()),
          categoryForPreset(current.pendingGrant?.sizing.sizingPreset) === null ? null : JSON.stringify(newIdentity(categoryForPreset(current.pendingGrant?.sizing.sizingPreset)!))],
      );
      return result.rows[0] === undefined
        ? { updated: false, failure: "state_changed" } as const
        : { updated: true } as const;
    });
  }

  async startGrantAttemptCas(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedGrantDigest: Hex;
    readonly attemptId: Hex; readonly startedAtSec: number;
  }): Promise<GrantAttemptCasResult> {
    const owner = ownerKey(input.ownerAddress);
    return this.#sql.transaction(async (tx) => {
      const selected = await tx.query<AgentRow>(
        `/* agents.grantAttemptRead */ select ${AGENT_COLUMNS} from agents where id = $1 and owner_address = $2 for update`,
        [input.agentId, owner],
      );
      const source = selected.rows[0];
      if (source === undefined) return { kind: "not_found" } as const;
      const current = rowToRecord(source);
      const pending = current.pendingGrant;
      if (current.status !== "provisioning" || pending === null
        || pending.grantDigest.toLowerCase() !== input.expectedGrantDigest.toLowerCase()
        || (pending.sizing.sizingPreset !== "trade-v1" && pending.sizing.sizingPreset !== "lp-v1")
        || (pending.sizing.sizingPreset === "trade-v1" && pending.autoGrant !== true)
        || hasProvisioningCancellation(pending)) return { kind: "conflict" } as const;
      if (pending.grantAttempt !== undefined) {
        return pending.grantAttempt.attemptId.toLowerCase() === input.attemptId.toLowerCase()
          ? { kind: "same", agent: current } as const
          : { kind: "conflict" } as const;
      }
      const nextPending: PendingGrant = { ...pending,
        grantAttempt: { version: 1, attemptId: input.attemptId, startedAtSec: input.startedAtSec } };
      const updated = await tx.query<AgentRow>(
        `/* agents.grantAttemptStart */ update agents set pending_grant = $4::jsonb,
           row_version = row_version + 1, updated_at = $5
         where id = $1 and owner_address = $2 and row_version = $3 returning ${AGENT_COLUMNS}`,
        [input.agentId, owner, current.rowVersion, encodeJsonbParam(nextPending), new Date(this.#now())],
      );
      return updated.rows[0] === undefined
        ? { kind: "conflict" } as const
        : { kind: "created", agent: rowToRecord(updated.rows[0]) } as const;
    });
  }

  async resetGrantAttemptCas(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedGrantDigest: Hex;
    readonly attemptId: Hex; readonly resetActionId: Hex; readonly resetAtSec: number;
  }): Promise<GrantAttemptResetCasResult> {
    const owner = ownerKey(input.ownerAddress);
    return this.#sql.transaction(async (tx) => {
      const selected = await tx.query<AgentRow>(
        `/* agents.grantAttemptResetRead */ select ${AGENT_COLUMNS} from agents where id = $1 and owner_address = $2 for update`,
        [input.agentId, owner],
      );
      const source = selected.rows[0];
      if (source === undefined) return { kind: "not_found" } as const;
      const current = rowToRecord(source);
      const pending = current.pendingGrant;
      if (current.status !== "provisioning" || pending === null
        || pending.grantDigest.toLowerCase() !== input.expectedGrantDigest.toLowerCase()
        || hasProvisioningCancellation(pending)) return { kind: "conflict" } as const;
      const prior = pending.lastGrantAttemptReset;
      if (prior?.resetActionId.toLowerCase() === input.resetActionId.toLowerCase()
        && prior.clearedAttemptId.toLowerCase() === input.attemptId.toLowerCase()
        && pending.grantAttempt === undefined) return { kind: "same", agent: current } as const;
      if (pending.grantAttempt?.attemptId.toLowerCase() !== input.attemptId.toLowerCase()) {
        return { kind: "conflict" } as const;
      }
      const { grantAttempt: _cleared, ...rest } = pending;
      const nextPending: PendingGrant = { ...rest,
        lastGrantAttemptReset: { version: 1, resetActionId: input.resetActionId,
          clearedAttemptId: input.attemptId, resetAtSec: input.resetAtSec } };
      const updated = await tx.query<AgentRow>(
        `/* agents.grantAttemptReset */ update agents set pending_grant = $4::jsonb,
           row_version = row_version + 1, updated_at = $5
         where id = $1 and owner_address = $2 and row_version = $3 returning ${AGENT_COLUMNS}`,
        [input.agentId, owner, current.rowVersion, encodeJsonbParam(nextPending), new Date(this.#now())],
      );
      return updated.rows[0] === undefined
        ? { kind: "conflict" } as const
        : { kind: "cleared", agent: rowToRecord(updated.rows[0]) } as const;
    });
  }

  async confirmSessionRevokedCas(input: ConfirmSessionRevokedInput): Promise<ConfirmSessionRevokedResult> {
    input.signal?.throwIfAborted();
    const owner = ownerKey(input.ownerAddress);
    const before = await this.getAgent(input.ownerAddress, input.agentId);
    if (before === null) return { kind: "not_found" };
    const wallet = before.walletAddress;
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`,
        [`${owner}|${wallet.toLowerCase()}`],
        { ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: 5_000 });
      const selected = await tx.query<AgentRow & { session_key_ciphertext: string | null }>(
        `/* agents.confirmRevocationRead */ select ${AGENT_COLUMNS}, session_key_ciphertext
         from agents where id = $1 and owner_address = $2 for update`,
        [input.agentId, owner],
        { ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: 5_000 },
      );
      const source = selected.rows[0];
      if (source === undefined) return { kind: "not_found" } as const;
      const current = rowToRecord(source);
      const stored = parseSessionRevocationEvidence(
        source.session_revocation === null || source.session_revocation === undefined
          ? null
          : decodeJsonb(source.session_revocation),
      );
      const incoming = parseSessionRevocationEvidence(input.evidence);
      if (stored !== null && incoming !== null && sameRevocationIdentity(stored, incoming)
        && current.status === "revoked" && source.session_key_ciphertext === null
        && validSessionRevocationProof(current, this.#revocationContext, this.#now())) {
        return { kind: "same", agent: current } as const;
      }
      if (incoming === null || source.session_revocation !== null || current.status !== "revoked"
        || current.rowVersion !== input.expectedRowVersion
        || !validConfirmation(input, current, this.#revocationContext, this.#now())) return { kind: "conflict" } as const;
      const updated = await tx.query<AgentRow>(
        `/* agents.confirmRevocation */ update agents
         set session_revocation = $4::jsonb, session_key_ciphertext = null,
             row_version = row_version + 1, updated_at = $5
         where id = $1 and owner_address = $2 and row_version = $3
           and status = 'revoked' and session_revocation is null
         returning ${AGENT_COLUMNS}`,
        [input.agentId, owner, current.rowVersion, encodeJsonbParam(incoming), new Date(this.#now())],
        { ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: 5_000 },
      );
      return updated.rows[0] === undefined
        ? { kind: "conflict" } as const
        : { kind: "confirmed", agent: rowToRecord(updated.rows[0]) } as const;
    });
  }

  async cancelProvisioningAgent(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedRowVersion: number;
    readonly expectedGrantDigest: Hex; readonly nowSec: number;
    readonly cancelActionId: Hex;
  }): Promise<ProvisioningCasResult> {
    const owner = ownerKey(input.ownerAddress);
    const before = await this.getAgent(input.ownerAddress, input.agentId);
    if (before === null) return { updated: false, retired: false, failure: "not_found" };
    const result = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`, [`${owner}|${before.walletAddress.toLowerCase()}`]);
      const selected = await tx.query<AgentRow>(
        `/* agents.cancelRead */ select ${AGENT_COLUMNS} from agents where id = $1 and owner_address = $2 for update`,
        [input.agentId, owner],
      );
      const current = selected.rows[0] === undefined ? null : rowToRecord(selected.rows[0]);
      if (current === null || current.status !== "provisioning" || current.rowVersion !== input.expectedRowVersion
        || current.pendingGrant === null || current.pendingGrant.grantDigest !== input.expectedGrantDigest
        || current.sessionFacts !== null || current.sessionRevocation !== null
        || current.sessionStateDecodeMismatch === true
        || !validCancelTransition(current.pendingGrant, input.nowSec, input.cancelActionId)) {
        return { rows: [] };
      }
      return tx.query<{ id: string; retired: boolean }>(
        `/* agents.cancelProvisioning */
         update agents
         set status = case when (pending_grant->>'expiresAt')::bigint <= $5 then 'retired' else 'provisioning' end,
             pending_grant = case when (pending_grant->>'expiresAt')::bigint <= $5 then null
               else jsonb_set(jsonb_set(pending_grant, '{cancelRequestedAtSec}', to_jsonb($6::bigint)), '{cancelActionId}', to_jsonb($7::text)) end,
             session_key_ciphertext = case when (pending_grant->>'expiresAt')::bigint <= $5 then null else session_key_ciphertext end,
             row_version = row_version + 1, updated_at = $8
         where id = $1 and owner_address = $2 and status = 'provisioning'
           and row_version = $3 and pending_grant->>'grantDigest' = $4
         returning id, status = 'retired' as retired`,
        [input.agentId, owner, input.expectedRowVersion,
          input.expectedGrantDigest, input.nowSec, input.nowSec,
          input.cancelActionId, new Date(this.#now())],
      );
    });
    if (result.rows[0] !== undefined) return { updated: true, retired: result.rows[0].retired };
    return {
      updated: false,
      retired: false,
      failure: await this.getAgent(input.ownerAddress, input.agentId) === null ? "not_found" : "state_changed",
    };
  }

  async transitionAgentStatus(input: {
    readonly ownerAddress: Address; readonly agentId: string; readonly expectedStatus: AgentStatus;
    readonly expectedRowVersion: number; readonly status: AgentStatus;
  }): Promise<AgentRecord | null> {
    if (!isOrdinaryLifecycleTransition(input.expectedStatus, input.status)) return null;
    const before = await this.getAgent(input.ownerAddress, input.agentId);
    if (before === null) return null;
    const result = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`,
        [`${ownerKey(input.ownerAddress)}|${before.walletAddress.toLowerCase()}`]);
      return tx.query<AgentRow>(
      `/* agents.transitionStatus */
       update agents set status = $5, row_version = row_version + 1, updated_at = $6
       where id = $1 and owner_address = $2 and status = $3 and row_version = $4
         and not coalesce(pending_grant ?| array['cancelRequestedAtSec', 'cancelActionId'], false)
       returning ${AGENT_COLUMNS}`,
      [input.agentId, ownerKey(input.ownerAddress), input.expectedStatus, input.expectedRowVersion, input.status, new Date(this.#now())],
      );
    });
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
  }

  async updateAgentCapsCas(input: {
    readonly ownerAddress: Address; readonly agentId: string;
    readonly expectedRowVersion: number; readonly caps: AgentCaps;
  }): Promise<AgentRecord | null> {
    const result = await this.#sql.query<AgentRow>(
      `/* agents.updateCapsCas */
       update agents set caps = $4::jsonb, row_version = row_version + 1, updated_at = $5
       where id = $1 and owner_address = $2 and status in ('armed', 'paused') and row_version = $3
       returning ${AGENT_COLUMNS}`,
      [input.agentId, ownerKey(input.ownerAddress), input.expectedRowVersion, encodeJsonbParam(input.caps), new Date(this.#now())],
    );
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
  }

  async bindHttpRuntimeProfileCas(input: {
    readonly ownerAddress: Address; readonly agentId: string;
    readonly expectedRowVersion: number; readonly profile: BindableHttpRuntimeProfile;
  }): Promise<BindHttpRuntimeProfileResult> {
    const result = await this.#sql.query<AgentRow>(
      `/* agents.bindHttpRuntimeProfileCas */
       update agents set http_runtime_profile = $4, row_version = row_version + 1, updated_at = $5
       where id = $1 and owner_address = $2 and status in ('armed', 'paused') and row_version = $3
         and http_runtime_profile = 'unbound-v1'
       returning ${AGENT_COLUMNS}`,
      [input.agentId, ownerKey(input.ownerAddress), input.expectedRowVersion, input.profile, new Date(this.#now())],
    );
    if (result.rows[0] !== undefined) return { kind: "updated", agent: rowToRecord(result.rows[0]) };
    const observed = await this.getAgent(input.ownerAddress, input.agentId);
    if (observed === null) return { kind: "not_found" };
    return observed.httpRuntimeProfile === input.profile && (observed.status === "armed" || observed.status === "paused")
      ? { kind: "same", agent: observed }
      : { kind: "conflict", agent: observed };
  }

  async updateAgentStatus(
    ownerAddress: Address,
    id: string,
    status: AgentStatus,
  ): Promise<AgentRecord | null> {
    const before = await this.getAgent(ownerAddress, id);
    if (before === null) return null;
    const result = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`,
        [`${ownerKey(ownerAddress)}|${before.walletAddress.toLowerCase()}`]);
      return tx.query<AgentRow>(
      `/* agents.updateStatus */
       update agents set status = $3, row_version = row_version + 1, updated_at = $4
       where id = $1 and owner_address = $2
         and not coalesce(pending_grant ?| array['cancelRequestedAtSec', 'cancelActionId'], false)
       returning ${AGENT_COLUMNS}`,
      [id, ownerKey(ownerAddress), status, new Date(this.#now())],
      );
    });
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async updateAgentSessionFacts(
    ownerAddress: Address,
    id: string,
    facts: SessionFacts,
  ): Promise<AgentRecord | null> {
    const owner = ownerKey(ownerAddress);
    const before = await this.getAgent(ownerAddress, id);
    if (before === null) return null;
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`, [`${owner}|${before.walletAddress.toLowerCase()}`]);
      const result = await tx.query<AgentRow>(
        `/* agents.updateFacts */
         update agents set session_facts = $3::jsonb, row_version = row_version + 1, updated_at = $4
         where id = $1 and owner_address = $2 and session_revocation is null
           and not coalesce(pending_grant ?| array['cancelRequestedAtSec', 'cancelActionId'], false)
         returning ${AGENT_COLUMNS}`,
        [id, owner, encodeJsonbParam(facts), new Date(this.#now())],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToRecord(row);
    });
  }

  async updateAgentCaps(
    ownerAddress: Address,
    id: string,
    caps: AgentCaps,
  ): Promise<AgentRecord | null> {
    const result = await this.#sql.query<AgentRow>(
      `/* agents.updateCaps */
       update agents set caps = $3::jsonb, row_version = row_version + 1, updated_at = $4
       where id = $1 and owner_address = $2
       returning ${AGENT_COLUMNS}`,
      [id, ownerKey(ownerAddress), encodeJsonbParam(caps), new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async updateAgentErc8004Id(
    ownerAddress: Address,
    id: string,
    erc8004AgentId: string | null,
  ): Promise<AgentRecord | null> {
    const result = await this.#sql.query<AgentRow>(
      `/* agents.updateErc8004Id */
       update agents set erc8004_agent_id = $3, row_version = row_version + 1, updated_at = $4
       where id = $1 and owner_address = $2
       returning ${AGENT_COLUMNS}`,
      [id, ownerKey(ownerAddress), erc8004AgentId, new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async bindHttpRuntimeProfile(
    ownerAddress: Address,
    id: string,
    profile: BindableHttpRuntimeProfile,
  ): Promise<BindHttpRuntimeProfileResult> {
    const owner = ownerKey(ownerAddress);
    const result = await this.#sql.query<AgentRow>(
      `/* agents.bindHttpRuntimeProfile */
       update agents
       set http_runtime_profile = $3, row_version = row_version + 1, updated_at = $4
       where id = $1 and owner_address = $2 and http_runtime_profile = 'unbound-v1'
       returning ${AGENT_COLUMNS}`,
      [id, owner, profile, new Date(this.#now())],
    );
    const updated = result.rows[0];
    if (updated !== undefined) {
      return { kind: "updated", agent: rowToRecord(updated) };
    }

    // Classify a zero-row CAS from a fresh owner-scoped read. A concurrent bind
    // has completed before this query, so exactly one different target wins.
    const observed = await this.getAgent(ownerAddress, id);
    if (observed === null) return { kind: "not_found" };
    return observed.httpRuntimeProfile === profile
      ? { kind: "same", agent: observed }
      : { kind: "conflict", agent: observed };
  }

  async putAgentSessionKey(
    ownerAddress: Address,
    id: string,
    sessionKey: Hex,
  ): Promise<void> {
    if (this.#masterKey === null) {
      throw new Error(
        "Refusing to persist a session key without encryption configured; set EXECUTION_MASTER_KEY.",
      );
    }
    const ciphertext = encryptSecret(sessionKey, this.#masterKey);
    const owner = ownerKey(ownerAddress);
    const before = await this.getAgent(ownerAddress, id);
    if (before === null) throw new Error(`Agent "${id}" not found for this owner.`);
    const result = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* agents.walletFence */ select pg_advisory_xact_lock(hashtext($1))`, [`${owner}|${before.walletAddress.toLowerCase()}`]);
      const selected = await tx.query<AgentRow>(
        `/* agents.putKeyRead */ select ${AGENT_COLUMNS} from agents
         where id = $1 and owner_address = $2 for update`,
        [id, owner],
      );
      const current = selected.rows[0] === undefined ? null : rowToRecord(selected.rows[0]);
      if (current === null) return { kind: "not_found" } as const;
      if (current.status === "revoked" || current.sessionRevocation !== null) return { kind: "refused" } as const;
      const updated = await tx.query<{ id: string }>(
        `/* agents.putKey */
         update agents set session_key_ciphertext = $4, row_version = row_version + 1, updated_at = $5
         where id = $1 and owner_address = $2 and row_version = $3
           and status <> 'revoked' and session_revocation is null
         returning id`,
        [id, owner, current.rowVersion, ciphertext, new Date(this.#now())],
      );
      return updated.rows[0] === undefined ? { kind: "refused" } as const : { kind: "stored" } as const;
    });
    if (result.kind === "not_found") throw new Error(`Agent "${id}" not found for this owner.`);
    if (result.kind === "refused") throw new Error("Refusing to restore a revoked agent session key.");
  }

  async getAgentSessionKey(
    ownerAddress: Address,
    id: string,
  ): Promise<Hex | null> {
    const result = await this.#sql.query<{ session_key_ciphertext: string | null }>(
      `/* agents.getKey */
       select session_key_ciphertext from agents
       where id = $1 and owner_address = $2`,
      [id, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    if (row === undefined || row.session_key_ciphertext === null) return null;
    if (this.#masterKey === null) {
      throw new Error(
        "A master key is required to decrypt a stored session key, but none is configured.",
      );
    }
    return decryptSecret(row.session_key_ciphertext, this.#masterKey) as Hex;
  }

  async hasAgentSessionKey(ownerAddress: Address, id: string): Promise<boolean> {
    const result = await this.#sql.query<{ present: boolean }>(
      `/* agents.hasKey */ select session_key_ciphertext is not null as present
       from agents where id = $1 and owner_address = $2`,
      [id, ownerKey(ownerAddress)],
    );
    return result.rows[0]?.present === true;
  }

  async putExecutorHealth(health: ExecutorHealth): Promise<void> {
    await this.#sql.query(
      `/* health.put */
       insert into executor_health
         (executor, last_ok_at, last_error_at, last_error, last_latency_ms, consecutive_failures, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (executor) do update set
         last_ok_at = excluded.last_ok_at,
         last_error_at = excluded.last_error_at,
         last_error = excluded.last_error,
         last_latency_ms = excluded.last_latency_ms,
         consecutive_failures = excluded.consecutive_failures,
         updated_at = now()`,
      [
        health.executor,
        health.lastOkAt === null ? null : new Date(health.lastOkAt),
        health.lastErrorAt === null ? null : new Date(health.lastErrorAt),
        health.lastError?.slice(0, MAX_ERROR_CHARS) ?? null,
        health.lastLatencyMs,
        health.consecutiveFailures,
      ],
    );
  }

  async getExecutorHealth(): Promise<ExecutorHealth[]> {
    const result = await this.#sql.query<HealthRow>(
      `/* health.list */
       select executor, last_ok_at, last_error_at, last_error, last_latency_ms, consecutive_failures
       from executor_health order by executor asc`,
    );
    return result.rows.map((row) => ({
      executor: row.executor,
      lastOkAt: toEpoch(row.last_ok_at),
      lastErrorAt: toEpoch(row.last_error_at),
      lastError: row.last_error,
      lastLatencyMs: row.last_latency_ms,
      consecutiveFailures: row.consecutive_failures,
    }));
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

function rowToRecord(row: AgentRow): AgentRecord {
  const sessionFacts = row.session_facts === null ? null : decodeJsonb(row.session_facts) as SessionFacts;
  const sessionRevocation = parseSessionRevocationEvidence(
    row.session_revocation === null || row.session_revocation === undefined ? null : decodeJsonb(row.session_revocation),
  );
  // PostgreSQL also decodes JSONB literal null as null. Preserve SQL absence
  // separately so malformed stored authority never qualifies for R5 release.
  const mismatch = sessionFacts === null && sessionRevocation === null && row.session_state_empty !== true;
  return {
    id: row.id,
    ownerAddress: ownerKeyFromStorage(row.owner_address),
    walletAddress: getAddress(row.wallet_address),
    custodyModel: row.custody_model as CustodyModel,
    sessionFacts,
    sessionRevocation,
    ...(mismatch ? { sessionStateDecodeMismatch: true as const } : {}),
    caps: row.caps === null ? null : (decodeJsonb(row.caps) as AgentCaps),
    status: assertStatus(row.status),
    httpRuntimeProfile: parseHttpRuntimeProfile(row.http_runtime_profile),
    erc8004AgentId: row.erc8004_agent_id,
    erc8004Identity: decodeIdentity(row.erc8004_identity, row.identity_absent === true || row.erc8004_identity === undefined),
    pendingGrant:
      row.pending_grant === null
        ? null
        : (decodeJsonb(row.pending_grant) as PendingGrant),
    rowVersion: row.row_version,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the durable store when `DATABASE_URL` is set, otherwise the in-memory
 * one. The connection string is never logged. `EXECUTION_MASTER_KEY` is read
 * once here; without it the Postgres store will refuse to persist session keys.
 */
export async function createAgentStore(
  revocationContext: SessionRevocationContext | null = null,
): Promise<AgentStore> {
  const masterKey = loadMasterKey();
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresAgentStore.create(sql, masterKey, Date.now, revocationContext);
    console.log(
      `[agent-store] backend=postgres key-encryption=${masterKey === null ? "OFF" : "on"}`,
    );
    return store;
  }
  console.log(
    `[agent-store] backend=memory (DATABASE_URL not set) key-encryption=${masterKey === null ? "OFF" : "on"}`,
  );
  return new MemoryAgentStore(masterKey, Date.now, revocationContext);
}
