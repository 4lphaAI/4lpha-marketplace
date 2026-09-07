import type { Address, Hex } from "viem";
import type { AgentStore, PendingGrant, SessionFacts } from "../../src/store/agents.js";

/** Offline draft fixture; every key is a fixed synthetic test value. */
export function pendingDraft(owner: Address, wallet: Address, nowSec: number, facts?: SessionFacts): PendingGrant {
  const expiresAt = facts?.expiry ?? nowSec + 3_600;
  return {
    version: 1, recoveredOwner: owner, walletAddress: wallet, sessionAddress: wallet,
    sessionPublicKey: facts?.publicKey ?? `0x04${"51".repeat(64)}`,
    accountKeyHash: `0x${"52".repeat(32)}`, keyStoreKeyId: `0x${"53".repeat(32)}`,
    sessionSpec: facts?.spec ?? { allowedCalls: [{ to: wallet, selector: "approve(address,uint256)" }],
      spendCaps: [{ limit: 10n, period: "day" }], expiresAt },
    permissions: facts?.permissions ?? { calls: [], spend: [] },
    grantDigest: `0x${"54".repeat(32)}`, expiresAt, createdAtSec: nowSec - 10,
    sizing: { openNativeBudgetWei: "0", capDayWei: "100", sizingPreset: "trade-v1", sizingPresetVersion: 1 },
    funding: { version: 1, observedAtSec: nowSec, registrationFeeWei: "1", registrations: 1,
      relayGasHeadroomWei: "1", requiredWei: "2", balanceWei: "100" },
    keyStoreVerdictAtS1: "verified", provisionActionId: `0x${"55".repeat(32)}`, autoGrant: true,
  };
}

export const DRAFT_KEY: Hex = `0x${"56".repeat(32)}`;
export const CANCEL_ACTION: Hex = `0x${"57".repeat(32)}`;

export async function cancelDraft(store: AgentStore, owner: Address, id: string, nowSec: number) {
  const row = await store.getAgent(owner, id);
  if (row?.pendingGrant === undefined || row.pendingGrant === null) throw new Error("Missing test draft.");
  return store.cancelProvisioningAgent({ ownerAddress: owner, agentId: id, expectedRowVersion: row.rowVersion,
    expectedGrantDigest: row.pendingGrant.grantDigest, nowSec, cancelActionId: CANCEL_ACTION });
}
