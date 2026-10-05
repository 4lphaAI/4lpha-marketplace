import type { Address } from "viem";
import type { AgenticFence } from "./domain.js";
import type { AgenticStore } from "./store.js";
import type { AgenticInstanceManager } from "./instances.js";

export function walletObligations(store: AgenticStore, W: Address, exempt: { orderKey?: string; decisionId?: string; operationId?: string } = {}): Promise<boolean> {
  return store.walletObligations(W, exempt);
}

export async function acquireAgenticFence(store: AgenticStore, W: Address, holder: string): Promise<AgenticFence | null> {
  const start = process.hrtime.bigint();
  do {
    const fence = await store.acquireFence(W, holder);
    if (fence !== null) return fence;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  } while (Number(process.hrtime.bigint() - start) < 5_000_000_000);
  return null;
}

export async function agenticPayCheck(store: AgenticStore, instance: AgenticInstanceManager, f: AgenticFence,
  agentId: string, operationId?: string, orderKey?: string): Promise<boolean> {
  if (!instance.canClaim || await walletObligations(store, f.walletAddress, {
    ...(operationId === undefined ? {} : { operationId }), ...(orderKey === undefined ? {} : { orderKey }),
  })) return false;
  const tq = process.hrtime.bigint();
  const allowed = await store.payCheck(agentId, f, operationId, orderKey);
  return allowed && Number(process.hrtime.bigint() - tq) < 5_000_000_000;
}
