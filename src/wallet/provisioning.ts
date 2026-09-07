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
