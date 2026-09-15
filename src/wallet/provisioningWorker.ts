import type { Address } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { AgentStore, RenewalQuiescenceCheck } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import type { GrantEvidenceReader } from "./grantEvidence.js";
import { convergeProvisioning, convergeRenewal } from "./provisioning.js";

export const PROVISIONING_WORKER_LIMIT = 32;
export const PROVISIONING_EVIDENCE_TIMEOUT_MS = 10_000;

export function createProvisioningWorker(input: {
  readonly store: AgentStore;
  readonly evidence: GrantEvidenceReader;
  readonly keyStore: Address;
  readonly tradeSettings?: Pick<TradeSettingsStore, "putInitialIfAbsentOrSameDigest">;
  /** MARKETPLACE-LENDING-AGENT R3.3(3) — the 60 s sweep's half of the seam. */
  readonly lendingSettings?: Pick<
    import("../store/venusSettings.js").VenusSettingsStore,
    "get" | "put"
  >;
  readonly lendingGuards?: Pick<
    import("../store/lendingGuards.js").LendingGuardStore,
    "putInitialIfAbsentOrSame"
  >;
  readonly renewalQuiescence?: (agent: import("../store/agents.js").AgentRecord) => Promise<Awaited<ReturnType<RenewalQuiescenceCheck>>>;
  readonly renewalCoverage?: (agent: import("../store/agents.js").AgentRecord, pending: import("../store/agents.js").PendingRenewal) => Promise<{ readonly ok: boolean; readonly token?: import("viem").Address }>;
  readonly rebaseTradeEvidence?: (ownerAddress: import("viem").Address, agentId: string, generation: number) => Promise<boolean>;
  readonly clearRenewalMarkers?: (agent: import("../store/agents.js").AgentRecord) => Promise<boolean>;
  readonly readK2Revocation?: (pending: import("../store/agents.js").PendingRenewal) => Promise<"invalid" | "missing" | "registered" | "unreadable">;
  readonly nowSec?: () => number;
  readonly onError?: (message: string) => void;
}) {
  let afterId: string | null = null;
  let renewalAfterId: string | null = null;
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
            ...(input.lendingSettings === undefined ? {} : { lendingSettings: input.lendingSettings }),
            ...(input.lendingGuards === undefined ? {} : { lendingGuards: input.lendingGuards }),
            signal: AbortSignal.timeout(PROVISIONING_EVIDENCE_TIMEOUT_MS),
          });
        } catch (error) {
          input.onError?.(sanitizeMessage(error instanceof Error ? error.message : "provisioning convergence failed"));
        }
      }
      let renewalPage = await input.store.listPendingRenewals({ afterId: renewalAfterId, limit: PROVISIONING_WORKER_LIMIT });
      if (renewalPage.rows.length === 0 && renewalAfterId !== null) {
        renewalAfterId = null;
        renewalPage = await input.store.listPendingRenewals({ afterId: null, limit: PROVISIONING_WORKER_LIMIT });
      }
      for (const agent of renewalPage.rows) {
        renewalAfterId = agent.id;
        try {
          const converged = await convergeRenewal({
            store: input.store, evidence: input.evidence, ownerAddress: agent.ownerAddress, agentId: agent.id,
            keyStore: input.keyStore, nowSec: nowSec(),
            ...(input.renewalQuiescence === undefined ? {} : { checkQuiescent: async () => {
              const latest = await input.store.getAgent(agent.ownerAddress, agent.id);
              return latest === null ? { quiescent: false, reason: "agent disappeared" } : input.renewalQuiescence!(latest);
            } }),
            ...(input.renewalCoverage === undefined ? {} : { checkCoverage: (pending: import("../store/agents.js").PendingRenewal) => input.renewalCoverage!(agent, pending) }),
            ...(input.rebaseTradeEvidence === undefined ? {} : { rebaseTradeEvidence: input.rebaseTradeEvidence }),
            ...(input.readK2Revocation === undefined ? {} : { readK2Revocation: input.readK2Revocation }),
            signal: AbortSignal.timeout(PROVISIONING_EVIDENCE_TIMEOUT_MS),
          });
          if (converged.phase === "done" && converged.agent?.renewalCleanupPending === true) {
            const markersCleared = input.clearRenewalMarkers === undefined
              ? true
              : await input.clearRenewalMarkers(converged.agent);
            if (markersCleared) {
              await input.store.clearRenewalCleanup({
                ownerAddress: converged.agent.ownerAddress,
                agentId: converged.agent.id,
                expectedRowVersion: converged.agent.rowVersion,
              });
            }
          }
        } catch (error) {
          input.onError?.(sanitizeMessage(error instanceof Error ? error.message : "renewal convergence failed"));
        }
      }
      return { processed: page.rows.length + renewalPage.rows.length, hasMore: page.hasMore || renewalPage.hasMore };
    },
    cursor(): string | null { return afterId; },
  };
}
