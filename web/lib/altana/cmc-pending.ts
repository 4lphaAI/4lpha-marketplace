/**
 * CMC-HIRE-SETUP R4: the one pending-CMC-operation record, moved verbatim from
 * `TradeAgentDetail.tsx` so both the panel and the trade hire run can read and
 * write the same localStorage record. Same key format and validation.
 */
export type CmcPendingOperation = {
  readonly version: 1;
  readonly ownerAddress: string;
  readonly walletAddress: string;
  readonly agentId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly callsId: `0x${string}` | null;
  readonly mode: "topup" | "rebind";
  readonly expectedGeneration: number;
  readonly incrementWei: string;
  readonly sessionPublicKey: `0x${string}`;
  readonly sessionExpiry: number;
};

export function cmcPendingStorageKey(ownerAddress: string | undefined, walletAddress: string | null, agentId: string): string | null {
  if (ownerAddress === undefined || walletAddress === null) return null;
  return `4lpha:cmc-budget:${ownerAddress.toLowerCase()}:${walletAddress.toLowerCase()}:${agentId}`;
}

export function readCmcPending(key: string | null): CmcPendingOperation | null {
  if (key === null || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<CmcPendingOperation>;
    return value.version === 1 && typeof value.ownerAddress === "string" && typeof value.walletAddress === "string"
      && typeof value.agentId === "string" && typeof value.operationId === "string" && typeof value.attemptId === "string"
      && (value.callsId === null || typeof value.callsId === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value.callsId))
      && (value.mode === "topup" || value.mode === "rebind") && Number.isSafeInteger(value.expectedGeneration)
      && typeof value.incrementWei === "string" && /^\d+$/u.test(value.incrementWei)
      && typeof value.sessionPublicKey === "string" && /^0x[0-9a-fA-F]+$/u.test(value.sessionPublicKey)
      && Number.isSafeInteger(value.sessionExpiry)
      ? value as CmcPendingOperation : null;
  } catch { return null; }
}

export function writeCmcPending(key: string | null, value: CmcPendingOperation): void {
  if (key === null || typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function clearCmcPending(key: string | null): void {
  if (key === null || typeof window === "undefined") return;
  window.localStorage.removeItem(key);
}
