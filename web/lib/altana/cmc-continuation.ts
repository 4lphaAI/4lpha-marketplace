import type { Address, Hex } from "viem";
import type { StoredPasskey } from "@/lib/exec/passkey";
import { executeCmcBudgetCalls, validateCmcBudgetCallPlan } from "./cmc-budget";
import { cmcPendingStorageKey, readCmcPending, writeCmcPending, clearCmcPending } from "./cmc-pending";
import { GridDeployRun, GridDeployStopped } from "./grid-hire-recovery";

/** The hire's best-effort sequence, shared with the renewal continuation. */
export async function runCmcContinuation(input: {
  readonly agentId: string;
  readonly header: { readonly name: "x-provision-action" | "x-renew-action"; readonly value: string };
  readonly expectedMode: "topup" | "rebind";
  readonly ownerAddress: string | undefined;
  readonly wallet: Address;
  readonly passkey: StoredPasskey;
  readonly sessionPublicKey: Hex;
  readonly sessionExpiry: number;
  readonly incrementWei: string;
  readonly run: GridDeployRun;
  readonly signal?: AbortSignal;
  readonly check: () => void;
  readonly requestJson: (input: RequestInfo | URL, init?: RequestInit) => Promise<{ readonly response: Response; readonly payload: unknown }>;
  readonly preparing: () => void;
  readonly executing: () => void;
}): Promise<boolean> {
  const { agentId, run, wallet, sessionPublicKey, sessionExpiry, incrementWei } = input;
  try {
    const pendingKey = cmcPendingStorageKey(input.ownerAddress, wallet, agentId);
    const confirmLoop = async (operationId: string, callsId: Hex): Promise<boolean> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        input.check();
        let confirmed = false;
        try {
          const { response } = await run.guarded(() => input.requestJson(`/api/agents/${encodeURIComponent(agentId)}/trade/cmc-budget/confirm`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, callsId }),
          }));
          confirmed = response.ok;
        } catch { confirmed = false; }
        if (confirmed) { clearCmcPending(pendingKey); return true; }
        if (Date.now() >= deadline) return false;
        await run.wait(4_000);
      }
    };

    input.preparing();
    const prepareDeadline = Date.now() + 45_000;
    let prepared: Record<string, unknown> | null = null;
    for (;;) {
      input.check();
      const { response, payload } = await run.guarded(() => input.requestJson(`/api/agents/${encodeURIComponent(agentId)}/trade/cmc-budget`, {
        method: "POST", headers: { "content-type": "application/json", [input.header.name]: input.header.value }, body: "{}",
      }));
      if (response.ok) { prepared = (payload as { data?: Record<string, unknown> }).data ?? null; break; }
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      if (response.status === 409 && error?.code === "cmc_setup_unavailable") {
        // CMC-TOKEN-CLASS-SPEC R5: waiting cannot review a grant shape.
        if (error.message === "cmc-profile-unavailable") return false;
        if (Date.now() < prepareDeadline) { await run.wait(5_000); continue; }
      }
      return false;
    }
    if (prepared === null) return false;
    if (prepared["alreadyBound"] === true) return true;
    const operationId = prepared["operationId"] as string;
    const continuationAttemptId = prepared["continuationAttemptId"] as string;
    const state = prepared["state"] as string;
    if (state === "confirmed" || state === "failed") { clearCmcPending(pendingKey); return state === "confirmed"; }

    const local = readCmcPending(pendingKey);
    if (local !== null && local.operationId === operationId && local.callsId !== null) {
      return await confirmLoop(operationId, local.callsId);
    }
    if (state === "attempted" && (local === null || local.callsId === null)) return false;

    const expectedGeneration = input.expectedMode === "topup" ? 0 : (prepared["operation"] as { expectedGeneration: number }).expectedGeneration;
    const record = { version: 1 as const, ownerAddress: input.ownerAddress ?? "", walletAddress: wallet, agentId, operationId,
      attemptId: continuationAttemptId, callsId: null, mode: input.expectedMode, expectedGeneration, incrementWei, sessionPublicKey, sessionExpiry };
    writeCmcPending(pendingKey, record);
    const calls = validateCmcBudgetCallPlan({ prepared, operationId, mode: input.expectedMode, incrementWei,
      expectedGeneration, sessionPublicKey, wallet });

    const attemptResponse = await run.guarded(() => fetch(`/api/agents/${encodeURIComponent(agentId)}/trade/cmc-budget/attempt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, attemptId: continuationAttemptId }), cache: "no-store",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));
    input.check();
    // AUDIT (CMC-HIRE-SETUP): never execute without a durable attempt.
    if (!attemptResponse.ok) return false;

    input.executing();
    const result = await run.guarded(() => executeCmcBudgetCalls({ record: input.passkey, calls }));
    input.check();
    if (result.status === "FAILED") return false;
    const withCallsId = { ...record, callsId: result.callsId };
    writeCmcPending(pendingKey, withCallsId);
    try {
      await fetch(`/api/agents/${encodeURIComponent(agentId)}/trade/cmc-budget/attempt`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, attemptId: continuationAttemptId, callsId: result.callsId }), cache: "no-store",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch { /* R5.6: confirm still runs when the callsId hint fails. */ }
    return await confirmLoop(operationId, result.callsId);
  } catch (error) {
    if (error instanceof GridDeployStopped) throw error;
    return false;
  }
}
