import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { hasProvisioningCancellation, type AgentRecord, type AgentStore, type PendingGrant, type SessionFacts } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
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

function authorityObserved(pending: PendingGrant, evidence: GrantEvidenceSnapshot): boolean {
  const account = evidence.accountKey !== null;
  const relay = evidence.relayKeys.some((key) => key.hash.toLowerCase() === pending.accountKeyHash.toLowerCase());
  const keyStore = evidence.keyStore.kind === "registered" || evidence.keyStore.kind === "invalid";
  return account || relay || keyStore;
}

export function buildPendingOnChainRevoke(pending: PendingGrant, keyStore: Address): PendingRevokeInstructions {
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

/** Caller-independent public-evidence convergence shared by GET and the worker. */
export async function convergeProvisioning(input: {
  readonly store: AgentStore;
  readonly evidence: GrantEvidenceReader;
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly keyStore: Address;
  readonly nowSec: number;
  readonly tradeSettings?: Pick<TradeSettingsStore, "putInitialIfAbsentOrSameDigest">;
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
