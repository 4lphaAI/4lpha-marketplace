/** Separate mainnet Quant rebalancing service entry; flag and reviewed profiles gate all work. */
import { BNB } from "@altananetwork/sdk";
import { pathToFileURL } from "node:url";
import { sanitizeMessage } from "../src/core/errors.js";
import { assertOrchestratorPin, QUANT_ORCHESTRATOR_56 } from "../src/quant/receipt.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { createQuantChainReader } from "../src/quant/readers.js";
import { HttpQuantTransport } from "../src/quant/termix.js";
import {
  assertProductionRebalanceRegistries, findCapabilityProfile, findExpandedConfigProfile,
  normalizeExpandedQuantConfig, QUANT_REBALANCE_CAPABILITY_PROFILES, QUANT_EXPANDED_CONFIG_PROFILES,
  resolveQuantRebalancingEnabled, resolveQuantRebalanceRuntimeConfig,
  type QuantExpandedConfigProfile, type QuantRebalanceCapabilityProfile,
} from "../src/quant/rebalanceConfig.js";
import { runQuantRebalanceWorkerOnce } from "../src/quant/rebalanceWorker.js";
import { createQuantRebalanceStore } from "../src/store/quantRebalance.js";
import { createQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import type { ExecutionJournal } from "../src/store/journal.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import {
  acquireWorkerSingleton, createWorkerGracefulDrain, waitForWorkerDelay,
} from "../src/deployment/workerSingleton.js";
import {
  assertQuantRebalanceBoot, buildQuantRebalanceWorkerDeps,
} from "./quantRebalanceWorkerDeps.js";

/**
 * The process entry passes nothing. The optional input is the offline test seam for the
 * ordering guarantee below; whatever it carries goes through the same production validator
 * and must consist of the registry entries themselves.
 */
export async function main(input: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configProfiles?: readonly QuantExpandedConfigProfile[];
  readonly capabilityProfiles?: readonly QuantRebalanceCapabilityProfile[];
} = {}): Promise<void> {
  const env = input.env ?? process.env;
  const configProfiles = input.configProfiles ?? QUANT_EXPANDED_CONFIG_PROFILES;
  const capabilityProfiles = input.capabilityProfiles ?? QUANT_REBALANCE_CAPABILITY_PROFILES;
  // G1: a file profile, a zero-evidence sentinel or a reserved id refuses here, before the flag
  // is read, before any credential is resolved and before any network or database is touched.
  assertProductionRebalanceRegistries(configProfiles, capabilityProfiles);
  // A valid-looking copy is not a reviewed profile: every supplied object must be a registry entry itself.
  if (!configProfiles.every((profile) => QUANT_EXPANDED_CONFIG_PROFILES.includes(profile))
    || !capabilityProfiles.every((profile) => QUANT_REBALANCE_CAPABILITY_PROFILES.includes(profile))) {
    throw new Error("production-profile-not-registered");
  }
  if (!resolveQuantRebalancingEnabled(env)) {
    console.log("[quant-rebalance-worker] QUANT_REBALANCING_ENABLED is off; exiting 0");
    return;
  }
  // Production registries are the activation boundary. Refuse before resolving
  // QUANT_API_KEY or constructing a transport that could send it to TermiX.
  if (configProfiles.length === 0 || capabilityProfiles.length === 0) {
    console.log("[quant-rebalance-worker] production-profile-unavailable; registries are empty");
    return;
  }

  if (BNB.chainId !== 56) throw new Error("quant-rebalance-worker requires BNB mainnet chain 56.");
  const config = resolveQuantRebalanceRuntimeConfig(env, { publicRpcUrl: BNB.publicRpcUrl });
  assertOrchestratorPin(QUANT_ORCHESTRATOR_56);
  const claims = await createQuantWalletClaimStore({ databaseUrl: config.databaseUrl });
  let store: Awaited<ReturnType<typeof createQuantRebalanceStore>> | undefined;
  let journal: ExecutionJournal | undefined;
  try {
    // The activation gate is read-only. Nothing below this point may create
    // tables, run a migration, or touch the inbox unless cutover already exists.
    if (!(await claims.schemaInstalled()) || !(await claims.migrationInstalled())) {
      console.log("[quant-rebalance-worker] wallet-claim-migration-not-installed; no inbox discovery or trade");
      return;
    }
    const gateSql = await createPgSqlClient(config.databaseUrl);
    try {
      const present = await gateSql.query<Record<string, unknown>>(
        `/* quantRebalance.runtimeSchemaGate */ select
         to_regclass('public.quant_jobs') is not null as grid_jobs,
         to_regclass('public.quant_epochs') is not null as grid_epochs,
         to_regclass('public.quant_actions') is not null as grid_actions,
         to_regclass('public.quant_rebalance_jobs') is not null as rebalance_jobs,
         to_regclass('public.quant_rebalance_checks') is not null as rebalance_checks,
         to_regclass('public.quant_rebalance_actions') is not null as rebalance_actions,
         to_regclass('public.quant_receipt_ownership') is not null as receipt_ownership,
         to_regclass('public.execution_journal') is not null as execution_journal`,
      );
      const schema = present.rows[0];
      if (schema === undefined || Object.values(schema).some((value) => value !== true)) {
        console.log("[quant-rebalance-worker] runtime-schema-not-installed; no inbox discovery or trade");
        return;
      }
    } finally { await gateSql.close(); }

    const transport = new HttpQuantTransport({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
    const reader = createQuantChainReader({ rpcUrls: config.rpcUrls });
    const provider = new AltanaProvider({ network: BNB, rpcUrls: [...config.rpcUrls] });
    const keypair = quantKeypairFromSeed(config.envelopeKey);
    const remoteConfig = await transport.config();
    if (!remoteConfig.ok) throw new Error("quant-rebalance-platform-config-unavailable");
    const normalized = normalizeExpandedQuantConfig(remoteConfig.data);
    if (!normalized.ok) throw new Error("quant-rebalance-platform-config-invalid");
    const configProfile = findExpandedConfigProfile(normalized.projection, configProfiles);
    if (configProfile === null) throw new Error("quant-rebalance-platform-config-unreviewed");
    const capabilityProfile = capabilityProfiles.find(
      (profile) => profile.capturedConfigProfileId === configProfile.id,
    ) ?? null;
    if (capabilityProfile === null || findCapabilityProfile(capabilityProfile.id) === null) {
      throw new Error("quant-rebalance-capability-profile-unavailable");
    }
    await assertQuantRebalanceBoot({ config, capabilityProfile, transport, reader, provider, keypair });

    store = await createQuantRebalanceStore({ databaseUrl: config.databaseUrl, claims });
    if (!(await store.schemaReady())) throw new Error("quant-rebalance-schema-not-installed");
    const journalSql = await createPgSqlClient(config.databaseUrl);
    try { journal = await PostgresExecutionJournal.attachExisting(journalSql); }
    catch (error) { await journalSql.close(); throw error; }

    const relayUrl = BNB.relayUrl ?? "";
    if (relayUrl === "") throw new Error("quant-rebalance-relay-unavailable");
    const lease = await acquireWorkerSingleton({ role: "quant-rebalance-worker", databaseUrl: config.databaseUrl });
    if (lease.kind !== "acquired") throw new Error("quant-rebalance-worker-singleton-already-held");
    const drain = createWorkerGracefulDrain({ label: "quant-rebalance-worker" });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => drain.requestStop());
    try {
      const deps = buildQuantRebalanceWorkerDeps({
        config, capabilityProfile, store, claims, journal, transport, reader, provider, keypair,
        signal: lease.fence.signal,
      });
      console.log(`[quant-rebalance-worker] chain=56 interval=${config.intervalMs}ms profile=${capabilityProfile.id}`);
      for (;;) {
        const startedAt = Date.now();
        try {
          lease.fence.assertOpen();
          const report = await runQuantRebalanceWorkerOnce(deps);
          console.log(`[quant-rebalance-worker] cycle jobs=${report.jobsSeen} actions=${report.actions} holds=${report.holds} errors=${report.errors}`);
          if ((report.holds > 0 || report.errors > 0) && report.notes.length > 0) {
            console.log(`[quant-rebalance-worker] notes ${sanitizeMessage(report.notes.join(" "))}`);
          }
        } catch {
          console.error("[quant-rebalance-worker] cycle failed: worker-error");
          if (lease.fence.isFatal()) break;
        }
        if (drain.isStopping()) break;
        const waited = await waitForWorkerDelay({ delayMs: Math.max(0, config.intervalMs - (Date.now() - startedAt)),
          fence: lease.fence, gracefulSignal: drain.signal });
        if (waited === "stopped") break;
      }
      drain.complete();
    } finally {
      try { await lease.closeGracefully(); } catch { /* lock connection dies with process */ }
    }
  } finally {
    if (journal !== undefined) try { await journal.close(); } catch { /* independent close */ }
    if (store !== undefined) try { await store.close(); } catch { /* independent close */ }
    try { await claims.close(); } catch { /* independent close */ }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const code = error instanceof Error && /^[a-z0-9-]{1,80}$/u.test(error.message) ? error.message : "worker-error";
    console.error(`[quant-rebalance-worker] failed: ${sanitizeMessage(code)}`);
    process.exitCode = 1;
  });
}
