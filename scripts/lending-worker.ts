/**
 * The lending guard worker daemon (MARKETPLACE-LENDING-AGENT §5).
 *
 * Evaluates the durable hysteresis counter for every armed guard and drives at
 * most one rescue per guard per cycle through `runLendingWorkerOnce`.
 *
 * BOOT POSTURE — refuse, never hold: it throws when `LENDING_ENABLED` is not
 * exactly `"true"` (which itself requires `LP_ENABLED` and `HIRE_ENABLED`),
 * when `DATABASE_URL` is missing, when the venue addresses are absent, or when
 * the interval is below its floor. A route can hold per request; a worker whose
 * only job is held forever is an outage pretending to run.
 *
 * WHAT IT NEVER DOES: it holds no owner key and cannot widen anything. Every
 * submission runs under the standing on-chain session + kill switch, and PAUSE
 * STOPS THE GUARD (Phase 4 D4, inherited) — the owner's only stop control that
 * costs no signature and no gas means what it says here too.
 *
 * USAGE (no `package.json` entry yet — this build was scoped not to touch the
 * root manifest, so the operator invokes it directly; adding
 * `"lending-worker"` beside `"venus-worker"` is a one-line follow-up):
 *
 *   node --import tsx --env-file-if-exists=.env --env-file-if-exists=.env.local \
 *     scripts/lending-worker.ts                 # daemon, LENDING_WORKER_INTERVAL_MS (default 30 000, floor 15 000)
 *   ... scripts/lending-worker.ts --once        # one cycle
 *   ... scripts/lending-worker.ts --once --dry-run   # one cycle, decisions only, ZERO writes
 *
 * Unknown flags REFUSE the boot: the worker is LIVE by default, so a misspelled
 * `--dry-run` silently ignored would spend where the operator meant to
 * rehearse.
 *
 * ─── RUN EXACTLY ONE LENDING WORKER PER DATABASE. THIS IS A MONEY RULE ────
 *
 * Two workers can each read a stale observation, each reach two confirmations,
 * and BOTH dispatch a rescue out of one falling position — bounded by the
 * on-chain caps, but a double spend of the owner's reserve. Unlike the Venus
 * worker, this one HAS an enforcement: the agent-scoped advisory lock around
 * read -> decide -> claim plus the claim's own conditional CAS (R3.7). The
 * sentence stays anyway, because the lock bounds the damage to one submission
 * per interval and does not make two daemons a supported configuration.
 *
 * ─── WHAT `--once` CAN AND CANNOT PROVE ──────────────────────────────────
 *
 * The counter is DURABLE from the first line, so two `--once` invocations at
 * least one interval apart DO confirm a rescue. But ONE `--once` run against a
 * freshly armed guard cannot fire: one cycle cannot produce two observations,
 * and the minimum spacing is enforced against the RECORDED STAMP, so two runs
 * against one lagging node cannot manufacture a confirmation.
 */
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { type Address } from "viem";

import { AltanaProvider } from "../src/wallet/altana.js";
import { createAgentStore } from "../src/store/agents.js";
import { createJournal, reconcile } from "../src/store/journal.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { sanitizeMessage } from "../src/core/errors.js";
import {
  resolveLendingEnabled,
  resolveLendingRpcUrls,
  resolveLendingRuntimeConfig,
} from "../src/ops/config.js";
import { resolveVenues } from "../src/ops/venues.js";
import { resolveLpAddresses, resolveLpRpcUrls } from "../src/lp/readers.js";
import { resolveLpRailConfig } from "../src/lp/rails.js";
import { buildLendingServerDeps } from "../src/lending/wiring.js";
import {
  nextLendingCycleDelayMs,
  runLendingWorkerOnce,
  type LendingWorkerAgentOutcome,
  type LendingWorkerDeps,
} from "../src/lending/worker.js";

const KNOWN_BOOLEAN_FLAGS = new Set(["dry-run", "once"]);

function assertKnownFlags(): void {
  const unknown = process.argv
    .slice(2)
    .filter((entry) => !KNOWN_BOOLEAN_FLAGS.has(entry.replace(/^--/u, "")));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. Known flags: --dry-run, --once. `
      + "Refusing to start — the worker runs LIVE by default, and a misspelled flag "
      + "must never be silently ignored.",
    );
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function logOutcome(outcome: LendingWorkerAgentOutcome): void {
  const parts = [
    `agent=${outcome.agentId}`,
    `action=${outcome.action}`,
    ...(outcome.condition === undefined ? [] : [`condition=${outcome.condition}`]),
    ...(outcome.market === undefined ? [] : [`market=${outcome.market}`]),
    ...(outcome.amountWei === undefined ? [] : [`amount=${outcome.amountWei}`]),
    ...(outcome.healthFactor === undefined ? [] : [`hf=${outcome.healthFactor ?? "inf"}`]),
    ...(outcome.consecutive === undefined ? [] : [`consecutive=${outcome.consecutive}`]),
    ...(outcome.effect === undefined ? [] : [`effect=${outcome.effect}`]),
  ];
  console.log(`[lending-worker] ${parts.join(" ")} reason=${sanitizeMessage(outcome.reason)}`);
  if (outcome.observationPersisted === false) {
    console.warn(
      "[lending-worker]   WARNING: the observation could NOT be persisted. The decision "
      + "above stands; the next cycle re-observes from scratch, which costs ONE extra "
      + "confirmation cycle — and for this guard that is a RESCUE DELAYED, not telemetry "
      + "lost.",
    );
  }
  if (outcome.snapshotPersisted === false) {
    console.warn(
      "[lending-worker]   NOTE: the view snapshot could not be written. The money work is "
      + "unaffected — the snapshot is written LAST and its failure is swallowed by design — "
      + "and the owner view will report the staleness rather than guess.",
    );
  }
  if (outcome.effect === "no-effect") {
    console.warn(
      "[lending-worker]   WARNING: the receipt CONFIRMED and the on-chain effect was ZERO. "
      + "The Compound failOpaque pattern is live on these contracts, so this is a real "
      + "outcome, not a read error. The hysteresis counter was NOT reset and the action row "
      + "keeps its slot because the submission drew relay gas.",
    );
  }
  if (outcome.condition === "unknown-held") {
    console.warn(
      "[lending-worker]   WARNING: an ambiguous submission is UNKNOWN. v1 ships NO lending "
      + "UNKNOWN resolver: a second arm and any retire stay blocked for this guard until an "
      + "owner-signed resolver exists. Rescues continue on what wallet B demonstrably holds.",
    );
  }
  if (outcome.condition === "account-too-complex") {
    console.warn(
      "[lending-worker]   NOTE: this is a DISARM THE OWNER DID NOT CAUSE. The guarded "
      + "account entered more markets than the guard can price; the guard is paused until "
      + "it can, and the owner view says so in those words.",
    );
  }
}

async function main(): Promise<void> {
  assertKnownFlags();

  if (!resolveLendingEnabled(process.env)) {
    throw new Error(
      'LENDING_ENABLED is not "true"; the lending worker refuses to start on a deployment '
      + "that has not enabled the guard.",
    );
  }
  // Resolved HERE too, so a malformed venue address or an out-of-range
  // interval fails this process's boot rather than only the server's.
  resolveLendingRuntimeConfig(process.env);

  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required: the worker's queue is the persisted lending_guards "
      + "table, and a memory store here would be a different universe from the server's — "
      + "and could never prove the restart property the durable counter exists for.",
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
    throw new Error(
      `The lending guard is chain-56 only; this deployment resolves chain ${network.chainId}.`,
    );
  }

  const venues = resolveVenues({
    chainId: network.chainId,
    overrides: {
      pancakeRouterV3: process.env["VENUE_PANCAKE_ROUTER_V3"] ?? "",
      wbnb: process.env["VENUE_WBNB"] ?? "",
    },
    keyStore: network.keyStore as Address,
  });
  const lpAddresses = resolveLpAddresses(process.env, {
    chainId: network.chainId,
    keyStore: network.keyStore as Address,
    ...(venues.pancakeRouterV3 === undefined ? {} : { routerV3: venues.pancakeRouterV3 }),
    ...(venues.wbnb === undefined ? {} : { wbnb: venues.wbnb }),
  });
  const rails = resolveLpRailConfig(process.env);
  if (!rails.ok) {
    throw new Error(
      "The LP manipulation rails are unset, so `maxSagaSlippageBps` — the ONE floor every "
      + `lending swap leg is derived from — has no value (${rails.failure.keys.join(", ")}). `
      + "A guard whose swaps have no slippage floor must not run.",
    );
  }

  const built = await buildLendingServerDeps({
    env: process.env,
    network: readerNetwork,
    lpVenue: {
      routerV3: lpAddresses.routerV3,
      wbnb: lpAddresses.wbnb,
      quoterV2: lpAddresses.quoterV2,
      factoryV3: lpAddresses.factory,
      maxSagaSlippageBps: rails.config.maxSagaSlippageBps,
    },
  });
  if (built === undefined) {
    throw new Error("The lending deps did not build; refusing to run a worker with no queue.");
  }

  const agentStore = await createAgentStore();
  const journal = await createJournal();
  const killswitch = await createKillSwitch();
  const provider = new AltanaProvider({
    network,
    rpcUrls: resolveLendingRpcUrls(process.env, network.publicRpcUrl),
  });
  void resolveLpRpcUrls;

  const dryRun = flag("dry-run");
  const once = flag("once");

  const deps: LendingWorkerDeps = {
    agentStore,
    journal,
    killswitch,
    provider,
    guards: built.guards,
    settingsStore: built.settingsStore,
    observations: built.observations,
    readers: built.readers,
    venue: built.venue,
    intervalMs: built.intervalMs,
    maxObservationAgeMs: built.maxObservationAgeMs,
    agentConcurrency: built.agentConcurrency,
    maxSagaSlippageBps: built.maxSagaSlippageBps,
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
    `[lending-worker] network=${isMainnet ? "MAINNET" : "testnet"} chain=${network.chainId} `
    + `interval=${built.intervalMs}ms max-observation-age=${built.maxObservationAgeMs}ms `
    + `vusdt=${built.venue.vUsdt} usdt=${built.venue.usdt} pool=${built.venue.swapPool} `
    + `fee=${built.venue.swapFeeTier} dry-run=${dryRun} once=${once}`,
  );
  console.log(
    "[lending-worker] OPERATIONAL INVARIANT: run EXACTLY ONE lending-worker per database. "
    + "The agent-scoped advisory lock and the claim CAS bound two racing workers to ONE "
    + "submission per interval, but two daemons are still not a supported configuration — "
    + "this is a MONEY invariant, not a tidiness one.",
  );
  if (dryRun) {
    console.log(
      "[lending-worker] DRY RUN: every branch reports what a live cycle WOULD record and "
      + "writes NOTHING — no observation, no claim, no action row, no snapshot, no journal "
      + "row and no submission.",
    );
  }

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[lending-worker] ${signal} received; finishing the current cycle`);
      stopping = true;
    });
  }

  for (;;) {
    const startedAt = Date.now();
    try {
      const report = await runLendingWorkerOnce(deps);
      console.log(
        `[lending-worker] cycle done outcomes=${report.outcomes.length} `
        + `reconciled=${report.reconciled} dry-run=${report.dryRun}`,
      );
    } catch (error) {
      // A cycle failure is logged and the daemon lives: the next cycle re-reads
      // everything, and the journal means nothing was left half-decided.
      console.error(
        `[lending-worker] cycle failed: ${sanitizeMessage(
          error instanceof Error ? error.message : "unknown error",
        )}`,
      );
    }
    if (once || stopping) break;
    const delay = nextLendingCycleDelayMs(startedAt, Date.now(), built.intervalMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (stopping) break;
  }

  await Promise.all([
    agentStore.close(),
    journal.close(),
    killswitch.close(),
    built.settingsStore.close(),
    built.observations.close(),
    built.guards.close_(),
  ]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
