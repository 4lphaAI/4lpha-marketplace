import type { Address } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { AgentStore } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import type { GrantEvidenceReader } from "./grantEvidence.js";
import { convergeProvisioning } from "./provisioning.js";

export const PROVISIONING_WORKER_LIMIT = 32;
export const PROVISIONING_EVIDENCE_TIMEOUT_MS = 10_000;

export function createProvisioningWorker(input: {
  readonly store: AgentStore;
  readonly evidence: GrantEvidenceReader;
  readonly keyStore: Address;
  readonly tradeSettings?: Pick<TradeSettingsStore, "putInitialIfAbsentOrSameDigest">;
  readonly nowSec?: () => number;
  readonly onError?: (message: string) => void;
}) {
  let afterId: string | null = null;
  const nowSec = input.nowSec ?? (() => Math.floor(Date.now() / 1000));
  return {
    async sweep(): Promise<{ readonly processed: number; readonly hasMore: boolean }> {
      let page = await input.store.listProvisioningAgentsForWorker({ afterId, limit: PROVISIONING_WORKER_LIMIT });
      if (page.rows.length === 0 && afterId !== null) {
        afterId = null;
        page = await input.store.listProvisioningAgentsForWorker({ afterId: null, limit: PROVISIONING_WORKER_LIMIT });
      }
      for (const agent of page.rows) {
        afterId = agent.id;
        try {
          await convergeProvisioning({
            store: input.store,
            evidence: input.evidence,
            ownerAddress: agent.ownerAddress,
            agentId: agent.id,
            keyStore: input.keyStore,
            nowSec: nowSec(),
            ...(input.tradeSettings === undefined ? {} : { tradeSettings: input.tradeSettings }),
            signal: AbortSignal.timeout(PROVISIONING_EVIDENCE_TIMEOUT_MS),
          });
        } catch (error) {
          input.onError?.(sanitizeMessage(error instanceof Error ? error.message : "provisioning convergence failed"));
        }
      }
      return { processed: page.rows.length, hasMore: page.hasMore };
    },
    cursor(): string | null { return afterId; },
  };
}
