import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { hasProvisioningCancellation, type AgentRecord, type AgentStore, type PendingGrant, type PendingRenewal, type SessionFacts, type RenewalQuiescenceCheck } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import type { TradeIntentStore } from "../store/tradeIntents.js";
import { isTerminalLpSequence, type LpSequenceStore } from "../store/lpSequences.js";
import type { ExecutionJournal } from "../store/journal.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "./abis.js";
import {
  assessGrantEvidence,
  type GrantEvidenceReader,
  type GrantEvidenceSnapshot,
  type ProvisioningMissing,
} from "./grantEvidence.js";

export type PendingRevokeInstructions = {
  readonly state: "pending_owner_broadcast";
  readonly chainId: 56;
  readonly calls: readonly {
    readonly to: Address;
    readonly from: Address;
    readonly data: Hex;
    readonly note: string;
  }[];
};

export type ProvisioningConvergence = {
  readonly agent: AgentRecord | null;
  readonly missing: readonly ProvisioningMissing[];
  readonly revocationRequired: boolean;
  readonly onChainRevoke?: PendingRevokeInstructions;
  readonly activationError?: "wallet_in_use" | "settings_conflict";
};

export function authorityObserved(pending: PendingGrant | PendingRenewal, evidence: GrantEvidenceSnapshot): boolean {
  const account = evidence.accountKey !== null;
  const relay = evidence.relayKeys.some((key) => key.hash.toLowerCase() === pending.accountKeyHash.toLowerCase());
  const keyStore = evidence.keyStore.kind === "registered" || evidence.keyStore.kind === "invalid";
  return account || relay || keyStore;
}

export function buildPendingOnChainRevoke(pending: PendingGrant | PendingRenewal, keyStore: Address): PendingRevokeInstructions {
  const wallet = getAddress(pending.walletAddress);
  return {
    state: "pending_owner_broadcast",
    chainId: 56,
    calls: [
      {
        to: wallet,
        from: wallet,
        data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "revoke", args: [pending.accountKeyHash] }),
        note: "Account-level revoke. A KeyDoesNotExist() revert is expected when authority lives only in the KeyStore.",
      },
      {
        to: getAddress(keyStore),
        from: wallet,
        data: encodeFunctionData({ abi: KEYSTORE_ABI, functionName: "revokeKey", args: [wallet, pending.keyStoreKeyId] }),
        note: "KeyStore revoke. This removes the registered session authority.",
      },
    ],
  };
}

export type RenewalQuiescenceDeps = {
  readonly tradeIntents?: Pick<TradeIntentStore, "listUnsettled">;
  readonly lpSequences?: Pick<LpSequenceStore, "listSequences">;
  readonly journal?: Pick<ExecutionJournal, "listNonTerminal" | "listUnknownForAgent">;
};

/** The persisted-record inventory used at both renewal admission and swap. */
export async function assessRenewalQuiescence(
  agent: AgentRecord,
  deps: RenewalQuiescenceDeps,
): Promise<{ readonly quiescent: boolean; readonly reason?: string }> {
  const name = agent.sessionFacts?.hireSizing?.name;
  const tradeKind = name === "trade-v1" || name === undefined && agent.httpRuntimeProfile === "trade-v1";
  const lpKind = name === "grid-v1" || name === "grid-shift-v1" || name === "lp-v1"
    || name === undefined && agent.httpRuntimeProfile === "lp-v1";
  if (tradeKind) {
    if (deps.tradeIntents === undefined) return { quiescent: false, reason: "trade intents are unavailable" };
    const unsettled = await deps.tradeIntents.listUnsettled(agent.ownerAddress, agent.id);
    if (unsettled.length > 0) return { quiescent: false, reason: `finishing a trade intent ${unsettled[0]!.decisionId}` };
  }
  if (lpKind) {
    if (deps.lpSequences === undefined) return { quiescent: false, reason: "LP sequences are unavailable" };
    const sequences = await deps.lpSequences.listSequences(agent.ownerAddress, agent.id);
    const active = sequences.find((sequence) => !isTerminalLpSequence(sequence.state, sequence.recoveryState));
    if (active !== undefined) return { quiescent: false, reason: `finishing a rotate: ${active.sequenceId} (${active.state})` };
  }
  if (deps.journal !== undefined) {
    const pending = (await deps.journal.listNonTerminal()).find((row) => row.agentId === agent.id);
    if (pending !== undefined) return { quiescent: false, reason: `journal ${pending.state}: ${pending.idempotencyKey}` };
    const unknown = (await deps.journal.listUnknownForAgent(agent.id))[0];
    if (unknown !== undefined) return { quiescent: false, reason: `journal UNKNOWN: ${unknown.idempotencyKey}` };
  }
  const claim = agent.sessionFacts?.armPlan?.claim;
  if (claim !== null && claim !== undefined && claim.outcome === null) {
    return { quiescent: false, reason: `arm claim ${claim.actionId} is unfinished` };
  }
  return { quiescent: true };
}

/** Caller-independent public-evidence convergence shared by GET and the worker. */
export async function convergeProvisioning(input: {
  readonly store: AgentStore;
  readonly evidence: GrantEvidenceReader;
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly keyStore: Address;
  readonly nowSec: number;
  readonly tradeSettings?: Pick<TradeSettingsStore, "putInitialIfAbsentOrSameDigest">;
  /**
   * MARKETPLACE-LENDING-AGENT R3.3(3) — the lending materialization seam.
   *
   * `PendingGrant.initialLendingHire` carries the guarded account, the pinned
   * markets, the USDT cap, the reserve split and the signed settings; at
   * convergence they become a `lending_settings` row and a `lending_guards` row
   * in status `provisioning-guard`. `lendingArm` then UPDATES that row to
   * `arming` under CAS — "the guard row is created at arm" is dead.
   *
   * Absent collaborators with a present `initialLendingHire` is a
   * `settings_conflict` activation error, exactly as the trade path treats a
   * missing settings store: a hire whose durable intent cannot be materialized
   * must NOT be armed, because the session spec was built from data the plane
   * would then not hold.
   */
  readonly lendingSettings?: Pick<
    import("../store/venusSettings.js").VenusSettingsStore,
    "get" | "put"
  >;
  readonly lendingGuards?: Pick<
    import("../store/lendingGuards.js").LendingGuardStore,
    "putInitialIfAbsentOrSame"
  >;
  readonly signal?: AbortSignal;
}): Promise<ProvisioningConvergence> {
  const observed = await input.store.getAgent(input.ownerAddress, input.agentId);
  if (observed === null) return { agent: null, missing: [], revocationRequired: false };
  if (observed.status !== "provisioning" || observed.pendingGrant === null) {
    return { agent: observed, missing: [], revocationRequired: false };
  }
  const pending = observed.pendingGrant;
  if (input.nowSec >= pending.expiresAt) {
    if (pending.cancelRequestedAtSec !== undefined && pending.cancelActionId !== undefined) {
      await input.store.cancelProvisioningAgent({
        ownerAddress: observed.ownerAddress,
        agentId: observed.id,
        expectedRowVersion: observed.rowVersion,
        expectedGrantDigest: pending.grantDigest,
        nowSec: input.nowSec,
        cancelActionId: pending.cancelActionId,
      });
      const current = await input.store.getAgent(input.ownerAddress, input.agentId);
      return { agent: current, missing: current?.status === "retired" ? [] : ["expired"], revocationRequired: false };
    }
    return { agent: observed, missing: ["expired"], revocationRequired: false };
  }

  let snapshot: GrantEvidenceSnapshot;
  try {
    snapshot = await input.evidence.readGrant(pending, input.signal);
  } catch {
    return { agent: observed, missing: ["evidence-unreadable"], revocationRequired: false };
  }
  const missing = assessGrantEvidence(pending, snapshot, input.nowSec);
  if (hasProvisioningCancellation(pending)) {
    const revocationRequired = authorityObserved(pending, snapshot);
    return {
      agent: observed,
      missing,
      revocationRequired,
      ...(revocationRequired ? { onChainRevoke: buildPendingOnChainRevoke(pending, input.keyStore) } : {}),
    };
  }
  if (missing.length !== 0) return { agent: observed, missing, revocationRequired: false };

  if (pending.initialTradeSettings !== undefined) {
    if (input.tradeSettings === undefined) {
      return { agent: observed, missing: [], revocationRequired: false, activationError: "settings_conflict" };
    }
    const initial = await input.tradeSettings.putInitialIfAbsentOrSameDigest({
      agentId: observed.id,
      ownerAddress: observed.ownerAddress,
      params: pending.initialTradeSettings.params,
      digest: pending.initialTradeSettings.digest,
    });
    if (initial.kind === "conflict") {
      return { agent: observed, missing: [], revocationRequired: false, activationError: "settings_conflict" };
    }
  }

  if (pending.initialLendingHire !== undefined) {
    const hire = pending.initialLendingHire;
    if (input.lendingSettings === undefined || input.lendingGuards === undefined) {
      return { agent: observed, missing: [], revocationRequired: false, activationError: "settings_conflict" };
    }
    // ABSENT-OR-SAME, both rows. A converged agent may be re-converged by the
    // GET and by the sweep concurrently, and neither may overwrite the other's
    // work — nor accept a DIFFERENT settings object under the same hire.
    const existingSettings = await input.lendingSettings.get(
      observed.ownerAddress,
      observed.id,
    );
    if (existingSettings === null) {
      await input.lendingSettings.put({
        agentId: observed.id,
        ownerAddress: observed.ownerAddress,
        params: hire.params,
        digest: hire.digest,
      });
    } else if (existingSettings.digest.toLowerCase() !== hire.digest.toLowerCase()) {
      return { agent: observed, missing: [], revocationRequired: false, activationError: "settings_conflict" };
    }
    const guard = await input.lendingGuards.putInitialIfAbsentOrSame({
      agentId: observed.id,
      ownerAddress: observed.ownerAddress,
      guardedAccount: hire.guardedAccount,
      reserveToken: getAddress(pending.sessionSpec.spendCaps
        .find((cap) => cap.token !== undefined)?.token ?? hire.guardedAccount),
      debtMarkets: hire.debtMarkets,
      reserveCapWei: BigInt(hire.reserveCapWei),
      reserveBps: hire.reserveBps,
    });
    if (guard.kind === "conflict") {
      return { agent: observed, missing: [], revocationRequired: false, activationError: "settings_conflict" };
    }
  }

  const sessionFacts: SessionFacts = {
    spec: pending.sessionSpec,
    permissions: pending.permissions,
    publicKey: pending.sessionPublicKey,
    expiry: pending.expiresAt,
    hireSizing: {
      name: pending.sizing.sizingPreset,
      version: pending.sizing.sizingPresetVersion,
      openNativeBudgetWei: pending.sizing.openNativeBudgetWei,
    },
    provisionActionId: pending.provisionActionId,
    ...(pending.hireRunId === undefined ? {} : { hireRunId: pending.hireRunId }),
    ...(pending.initialArmPlan === undefined ? {} : {
      armPlan: { ...pending.initialArmPlan, claim: null },
    }),
  };
  const armed = await input.store.armProvisioningAgent({
    ownerAddress: observed.ownerAddress,
    agentId: observed.id,
    expectedRowVersion: observed.rowVersion,
    expectedGrantDigest: pending.grantDigest,
    sessionFacts,
  });
  const current = await input.store.getAgent(input.ownerAddress, input.agentId);
  return {
    agent: current,
    missing: [],
    revocationRequired: false,
    ...(armed.failure === "wallet_in_use" ? { activationError: "wallet_in_use" as const } : {}),
  };
}

export type RenewalConvergence = {
  readonly agent: AgentRecord | null;
  readonly phase: "granting" | "observed" | "quiescing" | "done" | "cancelled";
  readonly missing: readonly ProvisioningMissing[];
  readonly quiescing?: string;
  readonly revocationRequired: boolean;
  readonly retired?: boolean;
  readonly onChainRevoke?: PendingRevokeInstructions;
};

/** Caller-independent renewal convergence, shared by the owner read and sweep. */
export async function convergeRenewal(input: {
  readonly store: AgentStore;
  readonly evidence: GrantEvidenceReader;
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly keyStore: Address;
  readonly nowSec: number;
  readonly checkQuiescent?: RenewalQuiescenceCheck;
  readonly checkCoverage?: (pending: PendingRenewal) => Promise<{ readonly ok: boolean; readonly token?: import("viem").Address }>;
  readonly rebaseTradeEvidence?: (ownerAddress: Address, agentId: string, generation: number) => Promise<boolean>;
  readonly readK2Revocation?: (pending: PendingRenewal) => Promise<"invalid" | "missing" | "registered" | "unreadable">;
  readonly signal?: AbortSignal;
}): Promise<RenewalConvergence> {
  let agent = await input.store.getAgent(input.ownerAddress, input.agentId);
  if (agent === null) return { agent: null, phase: "granting", missing: [], revocationRequired: false };
  let pending = agent.pendingRenewal;
  if (pending === null || pending === undefined) return { agent, phase: "done", missing: [], revocationRequired: false };

  const revoke = (current: AgentRecord, observed: boolean): RenewalConvergence => ({
    agent: current,
    phase: "cancelled",
    missing: [],
    revocationRequired: observed,
    ...(observed ? { onChainRevoke: buildPendingOnChainRevoke(current.pendingRenewal!, input.keyStore) } : {}),
  });

  let snapshot: GrantEvidenceSnapshot | null = null;
  try {
    snapshot = await input.evidence.readGrant(pending as unknown as PendingGrant, input.signal);
  } catch {
    snapshot = null;
  }
  const observed = pending.authorityObserved === true
    || (snapshot !== null && authorityObserved(pending, snapshot));
  if (pending.cancelRequestedAtSec !== undefined) {
    if (observed && pending.authorityObserved !== true) {
      const marked = await input.store.markPendingRenewalPhaseCas({
        ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
        expectedGrantDigest: pending.grantDigest, phase: pending.phase, authorityObserved: true,
      });
      if (marked.kind === "updated" || marked.kind === "same") agent = marked.agent;
      pending = agent.pendingRenewal ?? pending;
    }
    const canReadRevocation = input.readK2Revocation !== undefined
      && (pending.authorityObserved === true || input.nowSec >= pending.expiresAt);
    if (canReadRevocation) {
      const verdict = await input.readK2Revocation!(pending);
      if (verdict === "invalid" || (verdict === "missing" && input.nowSec >= pending.expiresAt)) {
        const retired = await input.store.retirePendingRenewalCas({
          ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
          expectedGrantDigest: pending.grantDigest,
        });
        if (retired.kind === "updated" || retired.kind === "same") return { agent: retired.agent, phase: "cancelled", missing: [], revocationRequired: false, retired: true };
      }
    }
    return revoke(agent, pending.authorityObserved === true || observed);
  }

  if (input.nowSec >= pending.expiresAt) {
    const cancelled = await input.store.cancelPendingRenewalCas({
      ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
      expectedGrantDigest: pending.grantDigest, nowSec: input.nowSec, cancelActionId: pending.renewActionId,
      outcome: "expired", reason: "expired", authorityObserved: observed,
    });
    if (cancelled.kind === "updated" || cancelled.kind === "same") return revoke(cancelled.agent, observed);
    return revoke(agent, observed);
  }

  if (snapshot === null) return { agent, phase: pending.phase === "granting" ? "granting" : "observed", missing: ["evidence-unreadable"], revocationRequired: false };
  const missing = assessGrantEvidence(pending, snapshot, input.nowSec);
  if (observed && pending.authorityObserved !== true) {
    const marked = await input.store.markPendingRenewalPhaseCas({
      ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
      expectedGrantDigest: pending.grantDigest, phase: "observed", authorityObserved: true,
    });
    if (marked.kind === "updated" || marked.kind === "same") {
      agent = marked.agent;
      pending = agent.pendingRenewal ?? pending;
    }
  }
  if (missing.length !== 0) return { agent, phase: pending.phase === "observed" ? "observed" : "granting", missing, revocationRequired: false };

  const observedPhase = await input.store.markPendingRenewalPhaseCas({
    ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
    expectedGrantDigest: pending.grantDigest, phase: "observed",
  });
  if (observedPhase.kind === "updated" || observedPhase.kind === "same") {
    agent = observedPhase.agent;
    pending = agent.pendingRenewal ?? pending;
  }
  const quiescent = await input.checkQuiescent?.();
  if (quiescent !== undefined && !quiescent.quiescent) {
    const phase = await input.store.markPendingRenewalPhaseCas({
      ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
      expectedGrantDigest: pending.grantDigest, phase: "quiescing",
    });
    if (phase.kind === "updated" || phase.kind === "same") agent = phase.agent;
    return { agent, phase: "quiescing", missing: [], quiescing: quiescent.reason ?? "waiting for persisted work to settle", revocationRequired: false };
  }

  const ready = await input.store.markPendingRenewalPhaseCas({
    ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
    expectedGrantDigest: pending.grantDigest, phase: "ready",
  });
  if (ready.kind === "updated" || ready.kind === "same") {
    agent = ready.agent;
    pending = agent.pendingRenewal ?? pending;
  }
  const facts = agent.sessionFacts;
  if (facts === null) return { agent, phase: "quiescing", missing: ["evidence-unreadable"], revocationRequired: false };
  const generation = (facts.generation ?? 0) + 1;
  const history = [...(facts.renewalHistory ?? []), {
    renewActionId: pending.renewActionId, grantDigest: pending.grantDigest, completedAtSec: input.nowSec,
  }].slice(-8);
  const sessionFacts: SessionFacts = {
    spec: pending.sessionSpec,
    permissions: pending.permissions,
    publicKey: pending.sessionPublicKey,
    expiry: pending.expiresAt,
    ...(facts.hireSizing === undefined ? {} : { hireSizing: facts.hireSizing }),
    ...(facts.provisionActionId === undefined ? {} : { provisionActionId: facts.provisionActionId }),
    ...(facts.hireRunId === undefined ? {} : { hireRunId: facts.hireRunId }),
    generation,
    grantedAtSec: input.nowSec,
    renewActionId: pending.renewActionId,
    renewalHistory: history,
    renewals: (facts.renewals ?? history.length - 1) + 1,
    ...(facts.armPlan === undefined ? {} : { armPlan: facts.armPlan }),
  };
  const swapped = await input.store.swapSessionCas({
    ownerAddress: agent.ownerAddress, agentId: agent.id, expectedRowVersion: agent.rowVersion,
    expectedGrantDigest: pending.grantDigest, sessionFacts,
    ...(input.checkQuiescent === undefined ? {} : { checkQuiescent: input.checkQuiescent }),
    ...(input.checkCoverage === undefined ? {} : { checkCoverage: () => input.checkCoverage!(pending) }),
    ...(input.rebaseTradeEvidence === undefined || pending.sizing.sizingPreset !== "trade-v1" ? {} : {
      prepareEvidence: () => input.rebaseTradeEvidence!(agent.ownerAddress, agent.id, generation),
    }),
    nowSec: input.nowSec,
  });
  if (swapped.kind === "updated" || swapped.kind === "same") return { agent: swapped.agent, phase: "done", missing: [], revocationRequired: false };
  if (swapped.kind === "cancelled") {
    const cancelled = swapped.agent.pendingRenewal;
    return revoke(swapped.agent, cancelled?.authorityObserved === true || observed);
  }
  const current = await input.store.getAgent(input.ownerAddress, input.agentId);
  return { agent: current, phase: "quiescing", missing: [], quiescing: "the renewal changed concurrently; retrying", revocationRequired: false };
}
