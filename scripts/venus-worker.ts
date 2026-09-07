/**
 * The Venus guard worker daemon (PHASE4-SPEC D6).
 *
 * Evaluates the durable hysteresis counter for every agent carrying Venus
 * settings and drives at most one action per agent per cycle through
 * `runVenusWorkerOnce`.
 *
 * BOOT POSTURE — refuse, never hold: it throws when `VENUS_ENABLED` is not
 * exactly `"true"`, when `DATABASE_URL` is missing, when the venue addresses
 * are absent, or when the interval is below its floor. A route can hold per
 * request; a worker whose only job is held forever is an outage pretending to
 * run.
 *
 * WHAT IT NEVER DOES: it holds no owner key and cannot widen anything. Every
 * submission runs under the standing on-chain session + kill switch, exactly
 * the `/execute` crux — and Phase 4 adds ZERO routes reachable with
 * `x-exec-token` alone, so this daemon is the only actor for the four money
 * actions.
 *
 * USAGE
 *   npm run venus-worker                        # daemon, VENUS_WORKER_INTERVAL_MS (default 30 000, floor 15 000)
 *   npm run venus-worker -- --once              # one cycle
 *   npm run venus-worker -- --once --dry-run    # one cycle, decisions only, ZERO writes
 *
 * Unknown flags REFUSE the boot: the worker is LIVE by default, so a
 * misspelled `--dry-run` silently ignored would spend where the operator meant
 * to rehearse.
 *
 * ─── RUN EXACTLY ONE VENUS WORKER PER DATABASE. THIS ONE IS A MONEY RULE ──
 *
 * The LP worker states the same invariant as a tidiness matter, because two LP
 * workers cost a confirmation cycle. Here two workers can each read a stale
 * previous observation, each reach two confirmations, and BOTH dispatch a
 * rescue out of one falling position — bounded by the on-chain caps, but a
 * double spend of the owner's rescue budget. v1 adds no lease; the lease is
 * named future work.
 *
 * ─── WHAT `--once` CAN AND CANNOT PROVE ───────────────────────────────────
 *
 * The counter is DURABLE from the first line, so two `--once` invocations at
 * least one interval apart DO confirm a rescue — that property is the
 * acceptance test that FINDINGS (ae)'s class is actually dead. But ONE `--once`
 * run against a fresh agent cannot fire: one cycle cannot produce two
 * observations, and the minimum spacing is enforced against the RECORDED STAMP
 * so two runs against one lagging node cannot manufacture a confirmation.
 */
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { type Address } from "viem";
import { AltanaProvider } from "../src/wallet/altana.js";
import { createAgentStore } from "../src/store/agents.js";
import { createJournal, reconcile } from "../src/store/journal.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { createVenusSettingsStore } from "../src/store/venusSettings.js";
import { createVenusObservationStore } from "../src/store/venusObservations.js";
import { createVenusActionStore } from "../src/store/venusActions.js";
import { HttpDataPlaneClient } from "../src/clients/dataPlane.js";
import {
  resolveVenusEnabled,
  resolveVenusRuntimeConfig,
} from "../src/ops/config.js";
import { venusMarketUniverse } from "../src/venus/wiring.js";
import {
  createVenusChainReaders,
  resolveVenusRpcUrls,
} from "../src/venus/readers.js";
import {
  runVenusWorkerOnce,
  sleepUntilNextVenusCycle,
  type VenusWorkerAgentOutcome,
  type VenusWorkerDeps,
} from "../src/venus/worker.js";
import { sanitizeMessage } from "../src/core/errors.js";

const KNOWN_BOOLEAN_FLAGS = new Set(["dry-run", "once"]);

function assertKnownFlags(): void {
  const unknown = process.argv
    .slice(2)
    .filter((entry) => !KNOWN_BOOLEAN_FLAGS.has(entry.replace(/^--/u, "")));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. Known flags: --dry-run, --once. ` +
        "Refusing to start — the worker runs LIVE by default, and a misspelled flag " +
        "must never be silently ignored.",
    );
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function logOutcome(outcome: VenusWorkerAgentOutcome): void {
  const parts = [
    `agent=${outcome.agentId}`,
    `action=${outcome.action}`,
    ...(outcome.condition === undefined ? [] : [`condition=${outcome.condition}`]),
    ...(outcome.kind === undefined ? [] : [`kind=${outcome.kind}`]),
    ...(outcome.vToken === undefined ? [] : [`market=${outcome.vToken}`]),
    ...(outcome.amountWei === undefined ? [] : [`amount=${outcome.amountWei}`]),
    ...(outcome.healthFactor === undefined
      ? []
      : [`hf=${outcome.healthFactor ?? "inf"}`]),
    ...(outcome.consecutive === undefined
      ? []
      : [`consecutive=${outcome.consecutive}`]),
    ...(outcome.effect === undefined ? [] : [`effect=${outcome.effect}`]),
  ];
  console.log(`[venus-worker] ${parts.join(" ")} reason=${sanitizeMessage(outcome.reason)}`);
  if (outcome.observationPersisted === false) {
    console.warn(
      "[venus-worker]   WARNING: the observation could NOT be persisted. The decision " +
        "above stands; the next cycle re-observes from scratch, which costs ONE extra " +
        "confirmation cycle — and for this guard that is a RESCUE DELAYED, not telemetry " +
        "lost.",
    );
  }
  if (outcome.effect === "no-effect") {
    console.warn(
      "[venus-worker]   WARNING: the receipt CONFIRMED and the on-chain effect was ZERO. " +
        "The Compound failOpaque pattern is live on these contracts, so this is a real " +
        "outcome, not a read error. The hysteresis counter was NOT reset and the " +
        "accounting row keeps its slot.",
    );
  }
  if (outcome.condition === "unknown-held") {
    console.warn(
      "[venus-worker]   WARNING: an ambiguous submission is UNKNOWN. v1 ships NO Venus " +
        "UNKNOWN resolver: supply and claim legs stay disabled for this agent until an " +
        "owner-signed venusResolveUnknown phase exists. venusRepay continues.",
    );
  }
}

async function main(): Promise<void> {
  assertKnownFlags();

  if (!resolveVenusEnabled(process.env)) {
    throw new Error(
      'VENUS_ENABLED is not "true"; the Venus worker refuses to start on a deployment ' +
        "that has not enabled the guard.",
    );
  }
  const runtime = resolveVenusRuntimeConfig(process.env);

  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required: the worker's queue is the persisted Venus settings " +
        "store, and a memory store here would be a different universe from the " +
        "server's — and could never prove the restart property the durable counter " +
        "exists for.",
    );
  }

  const isMainnet = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
  const network: NetworkConfig = isMainnet ? BNB : BNB_TESTNET;
  const readerNetwork = {
    chain: network.chain,
    chainId: network.chainId,
    publicRpcUrl: network.publicRpcUrl,
  };
  if (network.chainId !== 56) {
    // D11: Postgres and chain-56 only, like 3.9c. A guard whose selector census
    // was taken on mainnet has no meaning anywhere else.
    throw new Error(
      `The Venus guard is chain-56 only; this deployment resolves chain ${network.chainId}.`,
    );
  }
  const rpcUrls = resolveVenusRpcUrls(process.env, readerNetwork);

  const agentStore = await createAgentStore();
  const journal = await createJournal();
  const killswitch = await createKillSwitch();
  const settingsStore = await createVenusSettingsStore();
  const observations = await createVenusObservationStore();
  const actions = await createVenusActionStore();

  // PHASE4-FIXREVIEW F2: the market union comes from the SHARED seam, so the
  // worker and the server cannot drift about which markets a cycle reads. The
  // readers stay local because they need the worker's own rpcUrls.
  const markets = await venusMarketUniverse(settingsStore, runtime.venue);

  const readers = createVenusChainReaders({
    network: readerNetwork,
    rpcUrls,
    venue: runtime.venue,
    markets,
  });

  const provider = new AltanaProvider({ network, rpcUrls });

  const dataPlaneUrl = process.env["DATA_PLANE_URL"]?.trim() ?? "";
  const dataPlane =
    dataPlaneUrl === ""
      ? undefined
      : new HttpDataPlaneClient({
          baseUrl: dataPlaneUrl,
          ...(process.env["DATA_PLANE_TOKEN"]?.trim()
            ? { token: process.env["DATA_PLANE_TOKEN"]?.trim() ?? "" }
            : {}),
        });

  const dryRun = flag("dry-run");
  const once = flag("once");

  const deps: VenusWorkerDeps = {
    agentStore,
    journal,
    killswitch,
    provider,
    settingsStore,
    observations,
    actions,
    readers,
    venue: runtime.venue,
    ...(dataPlane === undefined ? {} : { dataPlane }),
    intervalMs: runtime.intervalMs,
    maxObservationAgeMs: runtime.maxObservationAgeMs,
    agentConcurrency: runtime.agentConcurrency,
    now: Date.now,
    dryRun,
    reconcile: async () => {
      await reconcile({
        provider,
        journal,
        resolveWallet: async (ownerAddress, agentId) => {
          const agent = await agentStore.getAgentById(agentId);
          if (agent === null) return null;
          if (agent.ownerAddress !== (ownerAddress as Address).toLowerCase()) return null;
          return {
            address: agent.walletAddress,
            chainId: network.chainId,
            ownerAddress: agent.ownerAddress,
            custodyModel: agent.custodyModel,
          };
        },
      });
    },
    log: logOutcome,
  };

  console.log(
    `[venus-worker] network=${isMainnet ? "MAINNET" : "testnet"} chain=${network.chainId} ` +
      `interval=${runtime.intervalMs}ms max-observation-age=${runtime.maxObservationAgeMs}ms ` +
      `markets=${markets.length} dry-run=${dryRun} once=${once} ` +
      `data-plane=${dataPlane === undefined ? "off" : "on (advisory)"}`,
  );
  console.log(
    "[venus-worker] OPERATIONAL INVARIANT: run EXACTLY ONE venus-worker per database. " +
      "Two workers can each read a stale observation, each reach two confirmations, and " +
      "BOTH dispatch a rescue — a double spend of the owner's rescue budget. This is a " +
      "MONEY invariant, not a tidiness one, and nothing here enforces it.",
  );
  if (dataPlane === undefined) {
    console.log(
      "[venus-worker] No DATA_PLANE_URL: tracked-owner references are NOT reconciled this " +
        "run. Disabled tracking leaks references BY DESIGN; run `live-venus untrack-sweep` " +
        "to clear them.",
    );
  }

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[venus-worker] ${signal} received; finishing the current cycle`);
      stopping = true;
    });
  }

  for (;;) {
    const startedAt = Date.now();
    try {
      const report = await runVenusWorkerOnce(deps);
      console.log(
        `[venus-worker] cycle done outcomes=${report.outcomes.length} ` +
          `tracking=${report.tracking.length} reconciled=${report.reconciled} ` +
          `dry-run=${report.dryRun}`,
      );
    } catch (error) {
      // A cycle failure is logged and the daemon lives: the next cycle re-reads
      // everything, and the journal means nothing was left half-decided.
      console.error(
        `[venus-worker] cycle failed: ${sanitizeMessage(
          error instanceof Error ? error.message : "unknown error",
        )}`,
      );
    }
    if (once || stopping) break;
    await sleepUntilNextVenusCycle({
      cycleStartedAtMs: startedAt,
      intervalMs: runtime.intervalMs,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      stopped: () => stopping,
    });
    if (stopping) break;
  }

  await Promise.all([
    agentStore.close(),
    journal.close(),
    killswitch.close(),
    settingsStore.close(),
    observations.close(),
    actions.close(),
  ]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
