/**
 * Bounded CMC composition root.
 *
 * CMC is an optional data budget. This module composes the already reviewed
 * owner, payment, news, capability and receipt seams without introducing a
 * second worker framework or joining the trade entry/exit fence. The caller
 * supplies the current authorization read; this module never derives
 * authority from an environment flag or a serialized session.
 */
import { randomUUID } from "node:crypto";
import type { Session } from "@altananetwork/sdk";
import { getAddress, type Address, type Hex } from "viem";
import {
  CMC_PRICE_ATOMIC,
  CMC_SCHEDULER_INTERVAL_MS,
  cmcBudgetView,
  type CmcBudgetView,
} from "./cmc.js";
import {
  CMC_REVIEWED_PROFILES as REVIEWED_PROFILES,
  createCmcCapabilityGate,
  getCmcReviewedProfile,
  type CmcCapabilityGate,
  type CmcCapabilityEvidence,
  type CmcGrantShapeSpec,
  type CmcReviewedProfile,
} from "./cmcCapability.js";
import {
  createCmcNewsService,
  type CmcLlmRequestSkill,
  type CmcNewsContext,
  type CmcNewsRefreshResult,
  type CmcNewsService,
  type PendingLlmRequest,
} from "./cmcNews.js";
import { planningWindowStartMs } from "./cmcUsEquity.js";
import {
  createCmcOwnerService,
  type CmcOwnerCall,
  type CmcOwnerPrepared,
  type CmcOwnerService,
  type CmcOwnerStateReader,
} from "./cmcOwnerService.js";
import {
  createCmcPaymentClient,
  createCmcProductionPaymentWiring,
  type CmcPaymentClient,
  type CmcPaymentSigner,
  type CmcRuntimeAuthorization,
  type CmcTransport,
} from "./cmcPayment.js";
import { verifyCmcExpiryUnused, type CmcPaymentFacts, type CmcExpiryReader } from "./cmcProof.js";
import {
  createCmcRelayOwnerExecutionResolver,
  createCmcRpcCapabilityReader,
  createCmcRpcChargeReconciler,
  createCmcRpcExpiryReaders,
  createCmcRpcOwnerStateReader,
  type CmcMatrixTrace,
  type CmcRpcChargeReconciler,
} from "./cmcRpc.js";
import type {
  CmcAttemptRecord,
  CmcAttemptState,
  CmcBudgetRecord,
  CmcBudgetStore,
  CmcChargeProof,
  CmcOwnerOperationRecord,
  CmcOwnerFailureProof,
} from "../store/tradeCmc.js";
import { type AgentAuthority, type RestoreSessionParams, type SessionRef } from "../core/types.js";
import type { AltanaSessionHandle } from "../wallet/altana.js";

/** A trusted worker candidate supplied by the trade worker's current read. */
export type CmcRuntimeTarget = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  /** Payable wallet. It is deliberately separate from ownerAddress. */
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  readonly sessionExpiry: number;
  /** Current trading-session generation, read by the authorizer. */
  readonly sessionGeneration: number;
  /** Independent CMC ledger generation used by payment/store CAS. */
  readonly budgetGeneration: number;
  /** Persisted TradFi v2 discriminator, not an execution-model guess. */
  readonly isTradfiV2: boolean;
  readonly cmcNewsEnabled: boolean;
  /** The worker supplies current held positions before technically shortlisted candidates. */
  readonly heldTickers: readonly string[];
  readonly shortlistedTickers: readonly string[];
  /** TRADFI-LLM-CMC-REQUEST R2.1.1: worker-mapped, index-free — never a model-supplied ticker. */
  readonly llmRequests?: readonly {
    readonly ticker: string;
    readonly skill: CmcLlmRequestSkill;
    readonly reason: string;
    readonly source: "entry" | "exit";
    readonly model: string;
  }[];
};

/**
 * A profile is looked up by the IMPLEMENTATION identity the reader observed
 * live — never by wallet address. Every field here comes from a finalized
 * chain read or from the agent's own session spec.
 */
export type CmcRuntimeProfileLookupRequest = {
  readonly accountCodeHash: Hex;
  readonly tokenCodeHash: Hex;
  readonly permit2CodeHash: Hex;
  readonly settlerCodeHash: Hex;
  readonly grantShapeDigest: Hex;
  readonly grantShapeVersion: 1 | 2;
};

/**
 * Source-reviewed profiles carry the static matrix facts next to the
 * deployment/code identity. A missing matrix is intentionally unavailable.
 */
export type CmcRuntimeReviewedProfile = CmcReviewedProfile;

/**
 * Reads the agent's CURRENT session spec so the reader can derive the live
 * grant shape. It returns the persisted descriptor only; it never touches the
 * session key ciphertext.
 */
export type CmcRuntimeSessionSpecReader = (request: {
  readonly agentId: string;
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  readonly generation: number;
}) => Promise<CmcGrantShapeSpec | null>;

export type CmcRuntimeProfileRegistry = {
  readonly profiles: readonly CmcRuntimeReviewedProfile[];
  readonly find: (input: CmcRuntimeProfileLookupRequest) => CmcMatrixTrace | null;
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Build the only profile lookup used by production composition. It reads the
 * source registry supplied by the helper; it does not read manifests, env
 * booleans or operator-provided evidence files. Duplicate implementation
 * profiles or profiles without the reviewed matrix are unavailable.
 */
export function createCmcRuntimeProfileRegistry(
  profiles: readonly CmcRuntimeReviewedProfile[] = REVIEWED_PROFILES,
): CmcRuntimeProfileRegistry {
  const source = profiles;
  const usable = source.filter((profile) => profile.chainId === 56 && profile.matrix !== undefined
    && profile.matrix.proofDigests.length > 0 && profile.matrix.proofDigests.every(isHex32)
    && profile.matrix.ownerApprovalPersists === true
    && profile.matrix.unrelatedTradingPreservesAllowance === true
    && profile.matrix.sessionApproveCannotIncreaseAllowance === true
    && profile.matrix.noTemporaryApproveConsumePath === true
    && profile.matrix.temporaryApproveCallbackReentryExcluded === true
    && profile.matrix.revokeExpiryRejectsPayment === true
    && profile.matrix.walletKeyExclusive === true
    && profile.matrix.additiveIncreaseAllowance === true);
  return {
    profiles: usable,
    find(input) {
      const matches = usable.filter((profile) => sameHex(profile.accountCodeHash, input.accountCodeHash)
        && sameHex(profile.tokenCodeHash, input.tokenCodeHash)
        && sameHex(profile.permit2CodeHash, input.permit2CodeHash)
        && sameHex(profile.settlerCodeHash, input.settlerCodeHash)
        && sameHex(profile.grantShapeDigest, input.grantShapeDigest)
        && (profile.grantShapeVersion ?? 1) === input.grantShapeVersion);
      if (matches.length !== 1) return null;
      const profile = matches[0]!;
      // Keep the helper's canonical lookup in the default path. This protects
      // against a copied object being supplied in place of the source row.
      if (source === REVIEWED_PROFILES && getCmcReviewedProfile(profile.profileId) === null) return null;
      const matrix = profile.matrix;
      if (matrix === undefined) return null;
      return {
        ...matrix,
        grantShapeDigest: profile.grantShapeDigest,
        profileId: profile.profileId,
      };
    },
  };
}

export type CmcRuntimeOwnerWiring = {
  /** Two distinct BSC endpoints are required by the concrete proof readers. */
  readonly rpcUrls?: readonly [string, string];
  readonly relayUrl?: string;
  /** Offline tests may inject the already reviewed owner seams. */
  readonly capability?: CmcCapabilityGate;
  readonly chain?: CmcOwnerStateReader;
  /** Defaults to the source-reviewed helper registry. */
  readonly profiles?: readonly CmcRuntimeReviewedProfile[];
  /** Live grant-shape source; without it the capability gate stays closed. */
  readonly sessionSpec?: CmcRuntimeSessionSpecReader;
};

export type CmcRuntimeWorkerWiring = {
  readonly refreshCapability?: (input: { target: CmcRuntimeTarget; nowMs: number }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly masterKey: Buffer;
  /**
   * This callback must reread current v2 settings, pause/global-kill state,
   * active key/generation/expiry and the payable wallet's current USDT balance
   * for the exact pinned amount before it returns ok.
   */
  readonly authorize: CmcRuntimeAuthorization;
  /** Required for the concrete SDK signer; never persisted by this module. */
  readonly sessionForAgent?: (agentId: string) => Promise<Session>;
  /** Offline tests can inject both low-level payment seams together. */
  readonly signer?: CmcPaymentSigner;
  readonly transport?: CmcTransport;
  readonly fetchImpl?: typeof fetch;
  readonly rpcUrls?: readonly [string, string];
  /** Offline tests may inject the reviewed capability gate; production derives it from rpcUrls. */
  readonly capability?: CmcCapabilityGate;
  readonly profiles?: readonly CmcRuntimeReviewedProfile[];
  /** Live grant-shape source; without it the capability gate stays closed. */
  readonly sessionSpec?: CmcRuntimeSessionSpecReader;
  readonly chargeReconciler?: CmcRpcChargeReconciler;
  /** Logs-capable endpoint used ONLY to locate a settle tx when the paid response carried no hint; proof stays on `rpcUrls`. */
  readonly discoveryRpcUrl?: string;
  readonly expiryReaders?: readonly [CmcExpiryReader, CmcExpiryReader];
  /** Optional durable enumeration hook used by the background reconciler. */
  readonly listPendingAttempts?: (input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
  }) => Promise<readonly string[]>;
  /** Current v2 opt-in targets; the worker owns this authoritative read. */
  readonly listTargets?: () => Promise<readonly CmcRuntimeTarget[]>;
  /** All agents with possible pending CMC attempts, including opted-out/paused agents. */
  readonly listReconciliationTargets?: () => Promise<readonly CmcRuntimeTarget[]>;
  readonly timers?: {
    readonly setInterval: (callback: () => void, delayMs: number) => unknown;
    readonly clearInterval: (handle: unknown) => void;
  };
};

export type CmcOwnerPreparedDto = {
  readonly operationId: string;
  readonly mode: "topup" | "rebind";
  readonly expectedGeneration: number;
  readonly incrementWei: string;
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  readonly sessionExpiry: number;
  readonly calls: readonly {
    readonly to: Address;
    readonly value: string;
    readonly data: Hex;
  }[];
  readonly budget: CmcBudgetView;
};

export function serializeCmcOwnerPrepared(
  prepared: CmcOwnerPrepared,
  optedIn = true,
): CmcOwnerPreparedDto {
  const operation = prepared.operation;
  return {
    operationId: operation.operationId,
    mode: operation.mode,
    expectedGeneration: operation.expectedGeneration,
    incrementWei: operation.incrementWei.toString(10),
    wallet: getAddress(operation.wallet),
    sessionPublicKey: operation.sessionPublicKey,
    sessionExpiry: operation.sessionExpiry,
    calls: prepared.calls.map((call: CmcOwnerCall) => ({
      to: getAddress(call.to), value: call.value.toString(10), data: call.data,
    })),
    budget: cmcBudgetView(prepared.budget, optedIn),
  };
}

export type CmcBudgetProjection = CmcBudgetView & {
  readonly rebindRequired: boolean;
  /** Data-service exposure reserved from payable wallet cash, separate from C. */
  readonly protectedExposureWei: string;
  readonly totalsPreserved: true;
};

/** Conservative remaining CMC allowance exposure used by trade cash gates. */
const CMC_EXPOSURE_UNAVAILABLE = (1n << 256n) - 1n;
export function cmcProtectedExposureWei(row: CmcBudgetRecord | null, pendingOwnerOperation: CmcOwnerOperationRecord | null = null): bigint {
  if (row === null || row.authorizedTotalWei <= 0n) return 0n;
  if (row.pendingOwnerOperationId !== null
    && (pendingOwnerOperation === null || pendingOwnerOperation.operationId !== row.pendingOwnerOperationId)) return CMC_EXPOSURE_UNAVAILABLE;
  const accounted = row.authorizedTotalWei > row.settledWei
    ? row.authorizedTotalWei - row.settledWei
    : 0n;
  const allowance = row.allowanceWei === null || row.allowanceWei < 0n ? accounted : row.allowanceWei;
  const current = allowance < accounted ? allowance : accounted;
  if (pendingOwnerOperation?.mode !== "topup" || pendingOwnerOperation.incrementWei <= 0n) return current;
  const prospective = pendingOwnerOperation.expectedAllowanceWei
    ?? ((row.allowanceWei ?? accounted) + pendingOwnerOperation.incrementWei);
  return prospective > current ? prospective : current;
}

function projectBudget(input: {
  readonly row: CmcBudgetRecord | null;
  readonly optedIn: boolean;
  readonly nextPriceWei?: bigint;
  readonly currentSession?: { readonly generation: number; readonly publicKey: Hex };
  readonly pendingOwnerOperation?: CmcOwnerOperationRecord | null;
}): CmcBudgetProjection {
  // CMC's ledger generation advances on setup/top-up/rebind. It is not the
  // trading session generation, so only the checker public key identifies a
  // rebind requirement here; the caller's generation is carried for its own
  // authoritative session read and is never compared with the ledger counter.
  const base = cmcBudgetView(input.row, input.optedIn, input.nextPriceWei ?? CMC_PRICE_ATOMIC);
  const rebindRequired = input.row !== null && input.currentSession !== undefined
    && (input.row.checkerSessionPublicKey === null
      || input.row.checkerSessionPublicKey.toLowerCase() !== input.currentSession.publicKey.toLowerCase());
  const view = rebindRequired && base.status !== "disabled"
    ? { ...base, status: "setup-required" as const, reason: "session_rebind_required" }
    : base;
  return { ...view, rebindRequired, protectedExposureWei: cmcProtectedExposureWei(input.row, input.pendingOwnerOperation).toString(10), totalsPreserved: true };
}

export type CmcReconciliationResult = {
  readonly operationId: string;
  readonly state: CmcAttemptState | "missing";
  readonly action: "settled" | "released" | "held" | "none";
  readonly reason: string | null;
};

export type CmcRuntimeOwner = {
  readonly service: CmcOwnerService | null;
  readonly capability: CmcCapabilityGate | null;
  readonly unavailableReason: string | null;
  readonly prepare: CmcOwnerService["prepare"] | null;
  readonly recordAttempt: CmcOwnerService["recordAttempt"] | null;
  readonly confirm: CmcOwnerService["confirm"] | null;
  readonly fail: (input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly expectedGeneration: number;
    readonly proof: CmcOwnerFailureProof;
    readonly nowMs?: number;
  }) => ReturnType<CmcBudgetStore["failOwnerOperation"]>;
  readonly resumePending: (input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly callsId: Hex;
    readonly nowMs?: number;
  }) => Promise<{ readonly operation: CmcOwnerOperationRecord | null; readonly reason: string | null }>;
  readonly budgetProjection: (input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly optedIn: boolean;
    readonly nextPriceWei?: bigint;
    readonly currentSession?: { readonly generation: number; readonly publicKey: Hex };
  }) => Promise<CmcBudgetProjection>;
  readonly protectedExposure: (input: { readonly agentId: string; readonly ownerAddress: Address }) => Promise<bigint>;
};

export type CmcRuntimeWorker = {
  readonly takeQueued: (agentId: string) => CmcRuntimeTarget | null;
  readonly news: CmcNewsService;
  /** Awaited trade hook: records the current target and returns without I/O. */
  readonly enqueue: (target: CmcRuntimeTarget) => void;
  readonly refresh: (target: CmcRuntimeTarget, nowMs?: number) => Promise<CmcNewsRefreshResult>;
  readonly getFreshContext: (input: {
    readonly target: CmcRuntimeTarget;
    readonly ticker: string;
    readonly nowMs?: number;
  }) => Promise<CmcNewsContext | null>;
  readonly reconcileAttempt: (input: {
    readonly target: CmcRuntimeTarget;
    readonly operationId: string;
    readonly nowMs?: number;
  }) => Promise<CmcReconciliationResult>;
  readonly reconcilePending: (input: {
    readonly target: CmcRuntimeTarget;
    readonly operationIds: readonly string[];
    readonly nowMs?: number;
  }) => Promise<readonly CmcReconciliationResult[]>;
  readonly scheduler: CmcRuntimeScheduler;
};

export type CmcRuntimeScheduler = {
  readonly intervalMs: number;
  readonly tick: () => Promise<readonly CmcNewsRefreshResult[]>;
  readonly start: () => void;
  readonly stop: () => void;
};

export type CmcRuntime = {
  readonly owner: CmcRuntimeOwner;
  readonly worker: CmcRuntimeWorker | null;
  readonly close: () => Promise<void>;
};

export type CmcSessionRestoreInput = {
  readonly walletAddress: Address;
  readonly agent: AgentAuthority;
  readonly sessionFacts: {
    readonly spec: RestoreSessionParams["spec"];
    readonly publicKey: Hex;
    readonly expiry: number;
  };
};

/**
 * Narrow adapter for the live Altana provider shape. The returned Session is
 * kept in memory for one signer call; no session serialization is performed.
 */
export function createCmcSessionAdapter(input: {
  readonly read: (agentId: string) => Promise<CmcSessionRestoreInput | null>;
  readonly restoreSession: (params: RestoreSessionParams) => SessionRef;
}): (agentId: string) => Promise<Session> {
  return async (agentId) => {
    const current = await input.read(agentId);
    if (current === null) throw new Error("CMC agent session is unavailable.");
    const ref = input.restoreSession({
      spec: current.sessionFacts.spec,
      agent: current.agent,
      walletAddress: current.walletAddress,
      publicKey: current.sessionFacts.publicKey,
      expiresAt: current.sessionFacts.expiry,
    });
    if (!sameAddress(ref.walletAddress, current.walletAddress)
      || ref.publicKey.toLowerCase() !== current.sessionFacts.publicKey.toLowerCase()
      || ref.chainId !== 56) throw new Error("CMC restored session identity changed.");
    const handle = ref.handle;
    if (!isAltanaSessionHandle(handle)) throw new Error("CMC restored session handle is unavailable.");
    const session = handle.session;
    if (!sameAddress(session.walletAddress, current.walletAddress)
      || session.publicKey.toLowerCase() !== current.sessionFacts.publicKey.toLowerCase()
      || session.expiry !== current.sessionFacts.expiry) throw new Error("CMC restored SDK session identity changed.");
    return session;
  };
}

function isAltanaSessionHandle(value: unknown): value is AltanaSessionHandle {
  if (typeof value !== "object" || value === null || !("session" in value)) return false;
  const session = (value as { readonly session?: unknown }).session;
  if (typeof session !== "object" || session === null) return false;
  const row = session as Record<string, unknown>;
  return typeof row["walletAddress"] === "string"
    && typeof row["publicKey"] === "string"
    && typeof row["expiry"] === "number";
}

function createRuntimeCapabilityGate(input: {
  readonly rpcUrl: string;
  readonly sessionSpec?: CmcRuntimeSessionSpecReader;
  readonly profiles?: readonly CmcRuntimeReviewedProfile[];
}): { readonly gate: CmcCapabilityGate; readonly unavailableReason: string | null } {
  const profiles = input.profiles ?? REVIEWED_PROFILES;
  const registry = createCmcRuntimeProfileRegistry(profiles);
  const sessionSpec = input.sessionSpec;
  const unavailableReason = registry.profiles.length === 0 ? "cmc-profile-unavailable"
    : sessionSpec === undefined ? "cmc-session-spec-unavailable" : null;
  if (sessionSpec === undefined) {
    // Fail closed: without a live grant shape the reader cannot compute the
    // digest the profile is matched on, so no capability can be proven.
    return { unavailableReason, gate: { async check() { return { available: false, reason: "cmc-session-spec-unavailable" }; } } };
  }
  const reader = createCmcRpcCapabilityReader({
    rpcUrl: input.rpcUrl,
    sessionSpec: (request) => sessionSpec(request),
    matrixTrace: async (request: CmcRuntimeProfileLookupRequest) => registry.find(request),
  });
  return { unavailableReason, gate: createCmcCapabilityGate({ reader, profiles: registry.profiles }) };
}

async function refreshRuntimeCapability(input: {
  readonly gate: CmcCapabilityGate;
  readonly store: CmcBudgetStore;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly wallet: Address;
  readonly generation: number;
  readonly sessionPublicKey: Hex;
  readonly sessionExpiry: number;
  readonly nowMs: number;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const row = await input.store.get(input.agentId, input.ownerAddress);
  if (row === null || !sameAddress(row.wallet, input.wallet) || row.generation !== input.generation
    || !row.setupProved || row.pendingOperationId !== null || row.pendingOwnerOperationId !== null) {
    return { ok: false, reason: "cmc-setup-or-generation-unavailable" };
  }
  let verdict: Awaited<ReturnType<CmcCapabilityGate["check"]>>;
  try {
    verdict = await input.gate.check({ agentId: input.agentId, wallet: input.wallet,
      sessionPublicKey: input.sessionPublicKey, generation: input.generation, nowMs: input.nowMs });
  } catch {
    verdict = { available: false, reason: "cmc-capability-read-failed" };
  }
  let available = verdict.available;
  let reason = verdict.available ? null : verdict.reason;
  if (verdict.available) {
    if (verdict.evidence.checkerApproved !== true) {
      available = false;
      reason = "cmc-checker-unapproved";
    }
  }
  if (available && verdict.available) {
    const evidence: CmcCapabilityEvidence = verdict.evidence;
    const setup = await input.store.setSetup({ agentId: input.agentId, ownerAddress: input.ownerAddress,
      wallet: input.wallet, generation: input.generation, sessionPublicKey: input.sessionPublicKey,
      sessionExpiry: input.sessionExpiry, allowanceWei: evidence.finiteAllowanceWei, nowMs: input.nowMs });
    if (setup === null) {
      available = false;
      reason = "cmc-allowance-or-session-changed";
    }
  }
  const saved = await input.store.setCapability({ agentId: input.agentId, ownerAddress: input.ownerAddress,
    generation: input.generation, available, reason, nowMs: input.nowMs });
  return saved === null
    ? { ok: false, reason: "cmc-capability-state-changed" }
    : available ? { ok: true } : { ok: false, reason: reason ?? "cmc-capability-unavailable" };
}

function unavailableOwner(input: {
  readonly store: CmcBudgetStore;
  readonly reason: string;
}): CmcRuntimeOwner {
  const fail = (request: Parameters<CmcBudgetStore["failOwnerOperation"]>[0]) => input.store.failOwnerOperation(request);
  return {
    service: null,
    capability: null,
    unavailableReason: input.reason,
    prepare: null,
    recordAttempt: null,
    confirm: null,
    fail,
    async resumePending(request) {
      const operation = await input.store.getOwnerOperation(request.agentId, request.ownerAddress, request.operationId);
      return { operation, reason: input.reason };
    },
    async budgetProjection(request) {
      const row = await input.store.get(request.agentId, request.ownerAddress);
      const pendingOwnerOperation = row?.pendingOwnerOperationId === null || row?.pendingOwnerOperationId === undefined
        ? null : await input.store.getOwnerOperation(request.agentId, request.ownerAddress, row.pendingOwnerOperationId);
      return projectBudget({ row, optedIn: request.optedIn,
        ...(request.nextPriceWei === undefined ? {} : { nextPriceWei: request.nextPriceWei }),
        ...(request.currentSession === undefined ? {} : { currentSession: request.currentSession }), pendingOwnerOperation });
    },
    async protectedExposure(request) {
      const row = await input.store.get(request.agentId, request.ownerAddress);
      const pendingOwnerOperation = row?.pendingOwnerOperationId === null || row?.pendingOwnerOperationId === undefined
        ? null : await input.store.getOwnerOperation(request.agentId, request.ownerAddress, row.pendingOwnerOperationId);
      return cmcProtectedExposureWei(row, pendingOwnerOperation);
    },
  };
}

function createOwnerRuntime(input: {
  readonly store: CmcBudgetStore;
  readonly owner?: CmcRuntimeOwnerWiring;
  readonly now: () => number;
}): CmcRuntimeOwner {
  const owner = input.owner;
  if (owner === undefined) return unavailableOwner({ store: input.store, reason: "cmc-owner-unavailable" });
  let capability = owner.capability;
  let chain = owner.chain;
  let registryReason: string | null = null;
  if (capability === undefined || chain === undefined) {
    if (owner.rpcUrls === undefined || owner.relayUrl === undefined) {
      return unavailableOwner({ store: input.store, reason: "cmc-owner-network-unavailable" });
    }
    const built = createRuntimeCapabilityGate({ rpcUrl: owner.rpcUrls[0],
      ...(owner.sessionSpec === undefined ? {} : { sessionSpec: owner.sessionSpec }),
      ...(owner.profiles === undefined ? {} : { profiles: owner.profiles }) });
    capability = built.gate;
    registryReason = built.unavailableReason;
    const resolver = createCmcRelayOwnerExecutionResolver({ relayUrl: owner.relayUrl, rpcUrls: owner.rpcUrls });
    chain = createCmcRpcOwnerStateReader({ rpcUrl: owner.rpcUrls[0], resolveOwnerExecution: (request) => resolver(request) });
  }
  if (capability === undefined || chain === undefined) {
    return unavailableOwner({ store: input.store, reason: "cmc-owner-seams-unavailable" });
  }
  const service = createCmcOwnerService({ store: input.store, capability, chain, now: input.now });
  return {
    service,
    capability,
    unavailableReason: registryReason,
    prepare: service.prepare,
    recordAttempt: service.recordAttempt,
    confirm: async (request) => {
      const confirmed = await service.confirm(request);
      if (confirmed === null || capability === undefined) return confirmed;
      await refreshRuntimeCapability({ gate: capability, store: input.store,
        agentId: confirmed.operation.agentId, ownerAddress: confirmed.operation.ownerAddress,
        wallet: confirmed.operation.wallet, generation: confirmed.budget.generation,
        sessionPublicKey: confirmed.operation.sessionPublicKey, sessionExpiry: confirmed.operation.sessionExpiry,
        nowMs: request.nowMs ?? input.now() });
      const budget = await input.store.get(confirmed.operation.agentId, confirmed.operation.ownerAddress);
      return { budget: budget ?? confirmed.budget, operation: confirmed.operation };
    },
    fail: service.fail,
    async resumePending(request) {
      const operation = await input.store.getOwnerOperation(request.agentId, request.ownerAddress, request.operationId);
      if (operation === null) return { operation: null, reason: "cmc-owner-operation-missing" };
      if (operation.state === "confirmed" || operation.state === "failed") return { operation, reason: null };
      // This path only confirms a previously recorded callsId. It never
      // prepares, signs, submits or creates a replacement owner operation.
      const confirmed = await service.confirm({ operationId: request.operationId, agentId: request.agentId,
        ownerAddress: request.ownerAddress, callsId: request.callsId,
        ...(request.nowMs === undefined ? {} : { nowMs: request.nowMs }) });
      return confirmed === null
        ? { operation: await input.store.getOwnerOperation(request.agentId, request.ownerAddress, request.operationId), reason: "cmc-owner-proof-unavailable" }
        : { operation: confirmed.operation, reason: null };
    },
    async budgetProjection(request) {
      const row = await input.store.get(request.agentId, request.ownerAddress);
      const pendingOwnerOperation = row?.pendingOwnerOperationId === null || row?.pendingOwnerOperationId === undefined
        ? null : await input.store.getOwnerOperation(request.agentId, request.ownerAddress, row.pendingOwnerOperationId);
      return projectBudget({ row, optedIn: request.optedIn,
        ...(request.nextPriceWei === undefined ? {} : { nextPriceWei: request.nextPriceWei }),
        ...(request.currentSession === undefined ? {} : { currentSession: request.currentSession }), pendingOwnerOperation });
    },
    async protectedExposure(request) {
      const row = await input.store.get(request.agentId, request.ownerAddress);
      const pendingOwnerOperation = row?.pendingOwnerOperationId === null || row?.pendingOwnerOperationId === undefined
        ? null : await input.store.getOwnerOperation(request.agentId, request.ownerAddress, row.pendingOwnerOperationId);
      return cmcProtectedExposureWei(row, pendingOwnerOperation);
    },
  };
}

function factsForAttempt(attempt: CmcAttemptRecord): CmcPaymentFacts | null {
  if (attempt.nonce === null || attempt.deadline === null || attempt.spender === null
    || attempt.payee === null || attempt.witnessTo === null || attempt.validAfter === null) return null;
  if (!sameAddress(attempt.payee, attempt.witnessTo)) return null;
  return { wallet: attempt.wallet, asset: attempt.asset, amountWei: attempt.amountWei,
    spender: attempt.spender, payee: attempt.payee, validAfter: attempt.validAfter,
    deadline: attempt.deadline, nonce: attempt.nonce };
}

function chargeProof(attempt: CmcAttemptRecord, txHash: Hex): CmcChargeProof | null {
  const facts = factsForAttempt(attempt);
  if (facts === null) return null;
  return { kind: "charge", chainId: 56, txHash, payer: facts.wallet, asset: facts.asset,
    amountWei: facts.amountWei, nonce: facts.nonce, deadline: facts.deadline,
    witnessTo: facts.payee, validAfter: facts.validAfter, attemptId: attempt.attemptId };
}

function targetMatchesAttempt(target: CmcRuntimeTarget, attempt: CmcAttemptRecord): boolean {
  return attempt.agentId === target.agentId && sameAddress(attempt.ownerAddress, target.ownerAddress)
    && sameAddress(attempt.wallet, target.wallet);
}

function createWorkerRuntime(input: {
  readonly store: CmcBudgetStore;
  readonly worker: CmcRuntimeWorkerWiring;
  readonly now: () => number;
}): CmcRuntimeWorker {
  const worker = input.worker;
  const timers = worker.timers ?? {
    setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let wiring: { readonly signer: CmcPaymentSigner; readonly transport: CmcTransport };
  if (worker.signer !== undefined || worker.transport !== undefined) {
    if (worker.signer === undefined || worker.transport === undefined) throw new Error("CMC payment wiring requires signer and transport together.");
    wiring = { signer: worker.signer, transport: worker.transport };
  } else {
    if (worker.sessionForAgent === undefined) throw new Error("CMC payment wiring requires a session adapter.");
    wiring = createCmcProductionPaymentWiring({ sessionForAgent: worker.sessionForAgent,
      ...(worker.fetchImpl === undefined ? {} : { fetchImpl: worker.fetchImpl }) });
  }
  const activeTargets = new Map<string, CmcRuntimeTarget>();
  const capability = worker.capability
    ?? (worker.rpcUrls === undefined ? null : createRuntimeCapabilityGate({ rpcUrl: worker.rpcUrls[0],
      ...(worker.sessionSpec === undefined ? {} : { sessionSpec: worker.sessionSpec }),
      ...(worker.profiles === undefined ? {} : { profiles: worker.profiles }) }).gate);
  const authorizeForCurrentTarget: CmcRuntimeAuthorization = async (request) => {
    const current = activeTargets.get(request.agentId);
    if (current === undefined) return worker.authorize(request);
    if (!sameAddress(current.ownerAddress, request.ownerAddress) || !sameAddress(current.wallet, request.wallet)
      || current.sessionPublicKey.toLowerCase() !== request.sessionPublicKey.toLowerCase()) {
      return { ok: false, reason: "cmc_runtime_target_identity_mismatch" };
    }
    return worker.authorize({ ...request, generation: current.sessionGeneration });
  };
  const basePayment = createCmcPaymentClient({ store: input.store, signer: wiring.signer,
    transport: wiring.transport, now: input.now, authorize: authorizeForCurrentTarget });
  const payment: CmcPaymentClient = {
    authorize: basePayment.authorize,
    fetchChallenge: basePayment.fetchChallenge,
    prepare: basePayment.prepare,
    transmit: basePayment.transmit,
    async reserve(request) {
      const target = activeTargets.get(request.agentId);
      if (target === undefined || !target.isTradfiV2 || !target.cmcNewsEnabled) return null;
      const authorized = await worker.authorize({ agentId: target.agentId, ownerAddress: target.ownerAddress,
        wallet: target.wallet, amountWei: request.amountWei, generation: target.sessionGeneration,
        sessionPublicKey: target.sessionPublicKey, sessionExpiry: target.sessionExpiry, operationId: request.operationId });
      if (!authorized.ok) return null;
      return basePayment.reserve(request);
    },
  };
  const news = createCmcNewsService({ store: input.store, payment, now: input.now });
  const chargeReconciler = worker.chargeReconciler
    ?? (worker.rpcUrls === undefined ? undefined : createCmcRpcChargeReconciler({ rpcUrls: worker.rpcUrls,
      ...(worker.discoveryRpcUrl === undefined ? {} : { discoveryRpcUrl: worker.discoveryRpcUrl }) }));
  const expiryReaders = worker.expiryReaders
    ?? (worker.rpcUrls === undefined ? undefined : createCmcRpcExpiryReaders({ rpcUrls: worker.rpcUrls }));
  const queuedTargets = new Map<string, CmcRuntimeTarget>();
  /**
   * TRADFI-LLM-CMC-REQUEST R2.1.2: a SEPARATE per-agent map, not
   * `queuedTargets` — `scheduler.tick`'s `queuedTargets.clear()` and its
   * listed/queued merge must never touch it. Key `ticker+skill`; first
   * arrival kept; bounded at 56 per agent (oldest `queuedAtMs` dropped beyond).
   */
  const pendingLlmRequests = new Map<string, Map<string, PendingLlmRequest>>();
  const PENDING_LLM_REQUESTS_MAX = 56;

  function pendingLlmRequestKey(ticker: string, skill: CmcLlmRequestSkill): string {
    return `${ticker}\u0000${skill}`;
  }

  /**
   * TRADFI-CMC-EQUITY H7/N2: the exit lane enqueues held tickers, then the
   * entry lane enqueues (held again, plus) the shortlist, seconds to tens of
   * seconds later in the same trade cycle. `Map.set` alone dropped whichever
   * list the earlier call carried the instant the later call landed, so a CMC
   * tick racing between the two saw only the shortlist. This merges: the
   * union of held/shortlisted tickers seen since the queue was last drained
   * is kept, never overwritten.
   */
  function enqueue(target: CmcRuntimeTarget): void {
    if (!target.isTradfiV2 || !target.cmcNewsEnabled) return;
    const existing = queuedTargets.get(target.agentId);
    if (existing === undefined) { queuedTargets.set(target.agentId, target); }
    else {
      queuedTargets.set(target.agentId, { ...target,
        heldTickers: [...new Set([...existing.heldTickers, ...target.heldTickers])],
        shortlistedTickers: [...new Set([...existing.shortlistedTickers, ...target.shortlistedTickers])] });
    }
    if (target.llmRequests === undefined || target.llmRequests.length === 0) return;
    let agentMap = pendingLlmRequests.get(target.agentId);
    if (agentMap === undefined) { agentMap = new Map(); pendingLlmRequests.set(target.agentId, agentMap); }
    for (const request of target.llmRequests) {
      const key = pendingLlmRequestKey(request.ticker, request.skill);
      if (agentMap.has(key)) continue; // R2.1.2: first arrival kept.
      if (agentMap.size >= PENDING_LLM_REQUESTS_MAX) {
        let oldestKey: string | null = null;
        let oldestAtMs = Infinity;
        for (const [candidateKey, candidate] of agentMap) {
          if (candidate.queuedAtMs < oldestAtMs) { oldestAtMs = candidate.queuedAtMs; oldestKey = candidateKey; }
        }
        if (oldestKey !== null) agentMap.delete(oldestKey);
      }
      agentMap.set(key, { ticker: request.ticker, skill: request.skill, reason: request.reason,
        source: request.source, model: request.model, queuedAtMs: input.now() });
    }
  }

  async function refresh(target: CmcRuntimeTarget, nowMs?: number): Promise<CmcNewsRefreshResult> {
    // R3.9: an agent that is no longer TradFi v2 or no longer opted into the
    // paid data budget drops its whole pending-LLM-request queue here.
    if (!target.isTradfiV2) { pendingLlmRequests.delete(target.agentId); return { ticker: null, state: "skipped", context: null, operationId: null, reason: "not_tradfi_v2" }; }
    if (!target.cmcNewsEnabled) { pendingLlmRequests.delete(target.agentId); return { ticker: null, state: "skipped", context: null, operationId: null, reason: "news_disabled" }; }
    activeTargets.set(target.agentId, target);
    try {
      const currentBudget = await input.store.get(target.agentId, target.ownerAddress);
      const lease = await input.store.getNewsLease(target.agentId, target.ownerAddress);
      const staleOrphan = currentBudget?.pendingOperationId !== null
        && lease?.inFlightOperationId !== null && lease?.inFlightOperationId !== undefined
        && lease.leaseExpiresAtMs !== null && lease.leaseExpiresAtMs !== undefined
        && (nowMs ?? input.now()) > lease.leaseExpiresAtMs;
      if ((currentBudget?.pendingOperationId !== null && !staleOrphan) || currentBudget?.reason === "reconciliation-required") {
        return { ticker: null, state: "skipped", context: null, operationId: null, reason: "reconciliation-required" };
      }
      if (staleOrphan) {
        const orphan = currentBudget?.pendingOperationId === null || currentBudget?.pendingOperationId === undefined
          ? null : await input.store.getAttempt(target.agentId, target.ownerAddress, currentBudget.pendingOperationId);
        if (orphan !== null && await reclaimStaleUndisclosed(target, orphan, nowMs ?? input.now())) {
          return { ticker: null, state: "skipped", context: null, operationId: null, reason: "stale_undisclosed_reclaimed" };
        }
        return { ticker: null, state: "skipped", context: null, operationId: null, reason: "reconciliation-required" };
      }
      if (capability === null && worker.refreshCapability === undefined) return { ticker: null, state: "skipped", context: null, operationId: null, reason: "cmc-capability-reader-unavailable" };
      const capabilityReady = worker.refreshCapability === undefined ? await refreshRuntimeCapability({ gate: capability!, store: input.store,
        agentId: target.agentId, ownerAddress: target.ownerAddress, wallet: target.wallet,
        generation: target.budgetGeneration, sessionPublicKey: target.sessionPublicKey,
        sessionExpiry: target.sessionExpiry, nowMs: nowMs ?? input.now() }) : await worker.refreshCapability({ target, nowMs: nowMs ?? input.now() });
      if (!capabilityReady.ok) return { ticker: null, state: "skipped", context: null, operationId: null, reason: capabilityReady.reason };
      const effectiveNowMs = nowMs ?? input.now();
      // R2.1.3/R2.1.5: drop any pending request whose 16:30-ET window has
      // already ended (dropped, never served/refused), then pass the rest,
      // oldest `queuedAtMs` first.
      const pending = pendingLlmRequests.get(target.agentId);
      let llmRequestsForCall: readonly PendingLlmRequest[] = [];
      if (pending !== undefined && pending.size > 0) {
        const currentWindowStart = planningWindowStartMs(effectiveNowMs);
        for (const [key, value] of [...pending]) {
          if (planningWindowStartMs(value.queuedAtMs) !== currentWindowStart) pending.delete(key);
        }
        llmRequestsForCall = [...pending.values()].sort((a, b) => a.queuedAtMs - b.queuedAtMs);
      }
      const result = await news.refresh({ agentId: target.agentId, ownerAddress: target.ownerAddress, wallet: target.wallet,
        sessionPublicKey: target.sessionPublicKey, sessionExpiry: target.sessionExpiry, generation: target.budgetGeneration,
        heldTickers: target.heldTickers, shortlistedTickers: target.shortlistedTickers,
        masterKey: worker.masterKey, ...(nowMs === undefined ? {} : { nowMs }),
        ...(llmRequestsForCall.length === 0 ? {} : { llmRequests: llmRequestsForCall }) });
      // R2.1.5: `refreshOne` reports which request was served or refused; the
      // runtime removes exactly those entries.
      if (pending !== undefined) {
        if (result.llmRequestServed !== undefined && result.llmRequestServed !== null) {
          pending.delete(pendingLlmRequestKey(result.llmRequestServed.ticker, result.llmRequestServed.skill));
        }
        for (const refusal of result.llmRequestsRefused ?? []) pending.delete(pendingLlmRequestKey(refusal.ticker, refusal.skill));
        if (pending.size === 0) pendingLlmRequests.delete(target.agentId);
      }
      return result;
    } finally {
      if (activeTargets.get(target.agentId) === target) activeTargets.delete(target.agentId);
    }
  }

  async function getFreshContext(request: { readonly target: CmcRuntimeTarget; readonly ticker: string; readonly nowMs?: number }): Promise<CmcNewsContext | null> {
    if (!request.target.isTradfiV2 || !request.target.cmcNewsEnabled) return null;
    const budget = await input.store.get(request.target.agentId, request.target.ownerAddress);
    if (budget === null || !budget.optedIn || !budget.setupProved || !budget.capabilityAvailable
      || budget.reason !== null || budget.generation !== request.target.budgetGeneration
      || !sameAddress(budget.wallet, request.target.wallet)
      || budget.checkerSessionPublicKey === null
      || budget.checkerSessionPublicKey.toLowerCase() !== request.target.sessionPublicKey.toLowerCase()) return null;
    return news.getFresh({ agentId: request.target.agentId, ownerAddress: request.target.ownerAddress,
      ticker: request.ticker, ...(request.nowMs === undefined ? {} : { nowMs: request.nowMs }) });
  }

  async function reclaimStaleUndisclosed(target: CmcRuntimeTarget, attempt: CmcAttemptRecord, nowMs: number): Promise<boolean> {
    if ((attempt.state !== "reserved" && attempt.state !== "prepared") || attempt.disclosurePossible) return false;
    const lease = await input.store.getNewsLease(target.agentId, target.ownerAddress);
    if (lease?.inFlightOperationId !== attempt.operationId || lease.leaseExpiresAtMs === null
      || lease.leaseExpiresAtMs === undefined || nowMs <= lease.leaseExpiresAtMs) return false;
    const recoveryOperationId = `cmc-recovery-${randomUUID()}`;
    if (!await input.store.claimNewsSlot({ agentId: target.agentId, ownerAddress: target.ownerAddress,
      operationId: recoveryOperationId, nowMs })) return false;
    await input.store.finishNewsSlot({ agentId: target.agentId, ownerAddress: target.ownerAddress,
      operationId: recoveryOperationId, nowMs });
    const after = await input.store.getAttempt(target.agentId, target.ownerAddress, attempt.operationId);
    return after?.state === "released";
  }

  async function reconcileAttempt(request: { readonly target: CmcRuntimeTarget; readonly operationId: string; readonly nowMs?: number }): Promise<CmcReconciliationResult> {
    const nowMs = request.nowMs ?? input.now();
    const attempt = await input.store.getAttempt(request.target.agentId, request.target.ownerAddress, request.operationId);
    if (attempt === null) return { operationId: request.operationId, state: "missing", action: "none", reason: "attempt_missing" };
    if (!targetMatchesAttempt(request.target, attempt)) return { operationId: request.operationId, state: attempt.state, action: "held", reason: "attempt_identity_mismatch" };
    if (attempt.state === "settled" || attempt.state === "released") return { operationId: request.operationId, state: attempt.state, action: "none", reason: null };
    if (await reclaimStaleUndisclosed(request.target, attempt, nowMs)) {
      return { operationId: request.operationId, state: "released", action: "released", reason: "stale_undisclosed_lease" };
    }
    const facts = factsForAttempt(attempt);
    if (attempt.settlementTxHint !== null && facts !== null && chargeReconciler !== undefined) {
      try {
        const verified = await chargeReconciler.reconcile({ txHash: attempt.settlementTxHint, facts });
        if (verified.ok) {
          const proof = chargeProof(attempt, attempt.settlementTxHint);
          if (proof !== null) {
            const settled = await input.store.settle({ agentId: request.target.agentId, ownerAddress: request.target.ownerAddress,
              operationId: request.operationId, generation: attempt.generation, txHash: attempt.settlementTxHint, proof, nowMs });
            if (settled !== null) return { operationId: request.operationId, state: "settled", action: "settled", reason: null };
          }
        }
      } catch {
        // A reader outage is inconclusive evidence. The attempt remains held;
        // the bounded expiry proof below may still release it after deadline.
      }
    }
    // MEASURED 2026-09-20 (G2): CMC's paid 200 carried no PAYMENT-RESPONSE, so a
    // charge that DID settle on chain stayed `unknown` for good (a used nonce can
    // never pass the expiry-unused release). Locate the settle tx from chain
    // logs, then run the SAME exact two-RPC proof the hint path runs.
    if (attempt.settlementTxHint === null && facts !== null && chargeReconciler?.discover !== undefined
      && (attempt.state === "unknown" || attempt.state === "transmitting")) {
      try {
        const discovered = await chargeReconciler.discover({ facts,
          notBeforeSec: BigInt(Math.max(0, Math.floor(attempt.createdAt / 1_000) - 120)), notAfterSec: facts.deadline + 900n });
        if (discovered !== null) {
          const verified = await chargeReconciler.reconcile({ txHash: discovered, facts });
          const proof = verified.ok ? chargeProof(attempt, discovered) : null;
          if (proof !== null) {
            const settled = await input.store.settle({ agentId: request.target.agentId, ownerAddress: request.target.ownerAddress,
              operationId: request.operationId, generation: attempt.generation, txHash: discovered, proof, nowMs });
            if (settled !== null) return { operationId: request.operationId, state: "settled", action: "settled", reason: null };
          }
        }
      } catch {
        // Discovery is best-effort; an outage leaves the attempt held exactly as before.
      }
    }
    const deadline = attempt.deadline;
    if (deadline === null || attempt.nonce === null || BigInt(Math.max(0, Math.floor(nowMs / 1_000))) < deadline || expiryReaders === undefined) {
      return { operationId: request.operationId, state: attempt.state, action: "held", reason: attempt.settlementTxHint === null ? "awaiting_settlement_hint" : "settlement_unverified" };
    }
    let current = attempt;
    if (current.state === "transmitting") {
      const unknown = await input.store.markUnknown({ agentId: request.target.agentId, ownerAddress: request.target.ownerAddress,
        operationId: request.operationId, generation: current.generation, nowMs });
      if (unknown === null) return { operationId: request.operationId, state: current.state, action: "held", reason: "unknown_transition_refused" };
      current = unknown;
    }
    if (current.state !== "unknown") return { operationId: request.operationId, state: current.state, action: "held", reason: "disclosure_state_not_reconcilable" };
    const expiry = await verifyCmcExpiryUnused({ attemptId: current.attemptId, payer: current.wallet,
      nonce: current.nonce ?? attempt.nonce, deadline, readers: expiryReaders, nowMs });
    if (!expiry.ok) return { operationId: request.operationId, state: current.state, action: "held", reason: expiry.reason };
    const released = await input.store.release({ agentId: request.target.agentId, ownerAddress: request.target.ownerAddress,
      operationId: request.operationId, generation: current.generation, proof: expiry.proof, nowMs });
    return released === null
      ? { operationId: request.operationId, state: current.state, action: "held", reason: "expiry_release_refused" }
      : { operationId: request.operationId, state: "released", action: "released", reason: null };
  }

  async function reconcilePending(request: { readonly target: CmcRuntimeTarget; readonly operationIds: readonly string[]; readonly nowMs?: number }): Promise<readonly CmcReconciliationResult[]> {
    const results: CmcReconciliationResult[] = [];
    for (const operationId of request.operationIds) results.push(await reconcileAttempt({ ...request, operationId }));
    return results;
  }

  async function pendingOperationIds(target: CmcRuntimeTarget): Promise<readonly string[]> {
    if (worker.listPendingAttempts !== undefined) {
      return worker.listPendingAttempts({ agentId: target.agentId, ownerAddress: target.ownerAddress });
    }
    if (input.store.listPendingAttempts === undefined) return [];
    return (await input.store.listPendingAttempts(target.agentId, target.ownerAddress)).map((attempt) => attempt.operationId);
  }

  let intervalHandle: unknown = null;
  let ticking: Promise<readonly CmcNewsRefreshResult[]> | null = null;
  const scheduler: CmcRuntimeScheduler = {
    intervalMs: CMC_SCHEDULER_INTERVAL_MS,
    async tick() {
      if (ticking !== null) return ticking;
      const work = (async () => {
        const queued = [...queuedTargets.values()];
        queuedTargets.clear();
        const listed = worker.listTargets === undefined ? [] : await worker.listTargets();
        const reconciliationListed = worker.listReconciliationTargets === undefined ? [] : await worker.listReconciliationTargets();
        const refreshByAgent = new Map<string, CmcRuntimeTarget>();
        for (const target of queued) refreshByAgent.set(target.agentId, target);
        for (const listedTarget of listed) {
          const queuedTarget = refreshByAgent.get(listedTarget.agentId);
          if (queuedTarget === undefined) {
            refreshByAgent.set(listedTarget.agentId, listedTarget);
            continue;
          }
          const queuedHasTickers = queuedTarget.heldTickers.length > 0 || queuedTarget.shortlistedTickers.length > 0;
          refreshByAgent.set(listedTarget.agentId, queuedHasTickers
            ? { ...listedTarget, heldTickers: queuedTarget.heldTickers, shortlistedTickers: queuedTarget.shortlistedTickers }
            : listedTarget);
        }
        // R3.9: an agent with pending LLM requests that is neither queued nor
        // listed this tick is no longer eligible (paused/revoked/opted out) —
        // drop its whole pending queue rather than leave it to idle forever.
        for (const agentId of [...pendingLlmRequests.keys()]) {
          if (!refreshByAgent.has(agentId)) pendingLlmRequests.delete(agentId);
        }
        const reconciliationByAgent = new Map<string, CmcRuntimeTarget>();
        for (const target of reconciliationListed) reconciliationByAgent.set(target.agentId, target);
        for (const target of refreshByAgent.values()) reconciliationByAgent.set(target.agentId, target);
        const results: CmcNewsRefreshResult[] = [];
        for (const target of refreshByAgent.values()) {
          const refreshed = await refresh(target);
          results.push(refreshed);
          const ids = new Set<string>();
          if (refreshed.operationId !== null) ids.add(refreshed.operationId);
          for (const operationId of await pendingOperationIds(target)) ids.add(operationId);
          if (ids.size > 0) await reconcilePending({ target, operationIds: [...ids] });
        }
        for (const target of reconciliationByAgent.values()) {
          if (refreshByAgent.has(target.agentId)) continue;
          const ids = await pendingOperationIds(target);
          if (ids.length > 0) await reconcilePending({ target, operationIds: ids });
        }
        return results;
      })();
      ticking = work;
      try { return await work; }
      finally { if (ticking === work) ticking = null; }
    },
    start() {
      if (intervalHandle !== null) return;
      intervalHandle = timers.setInterval(() => { void scheduler.tick().catch(() => undefined); }, CMC_SCHEDULER_INTERVAL_MS);
    },
    stop() {
      if (intervalHandle === null) return;
      timers.clearInterval(intervalHandle);
      intervalHandle = null;
    },
  };
  return { news, enqueue, refresh, getFreshContext, reconcileAttempt, reconcilePending, scheduler,
    takeQueued(agentId) { const target = queuedTargets.get(agentId) ?? null; queuedTargets.delete(agentId); return target; } };
}

export function createCmcRuntime(input: {
  readonly store: CmcBudgetStore;
  readonly owner?: CmcRuntimeOwnerWiring;
  readonly worker?: CmcRuntimeWorkerWiring;
  readonly now?: () => number;
}): CmcRuntime {
  const now = input.now ?? (() => Date.now());
  const owner = input.owner === undefined
    ? createOwnerRuntime({ store: input.store, now })
    : createOwnerRuntime({ store: input.store, owner: input.owner, now });
  const worker = input.worker === undefined ? null : createWorkerRuntime({ store: input.store, worker: input.worker, now });
  return { owner, worker, async close() { worker?.scheduler.stop(); } };
}
