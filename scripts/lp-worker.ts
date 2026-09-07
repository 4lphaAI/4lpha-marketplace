/**
 * The LP worker daemon (PHASE3-SPEC "Worker"): evaluates the deterministic
 * triggers for every persisted LP position and drives at most one saga per
 * position per cycle through `runLpWorkerOnce`.
 *
 * BOOT POSTURE — refuse, never hold: `resolveLpWorkerBootConfig` throws when
 * `LP_ENABLED` is not "true" or any manipulation-rail variable is missing or
 * malformed. A route can hold per request; a worker whose only job is held
 * forever is an outage pretending to run.
 *
 * WHAT IT NEVER DOES: it holds no owner key and cannot widen anything — every
 * step it drives runs under the standing on-chain session + kill switch,
 * exactly the /execute crux. `--dry-run` logs the full decision (trigger
 * reason, would-be steps) and performs ZERO provider calls; `--once` runs one
 * cycle and exits — both exist because the live test needs them.
 *
 * USAGE
 *   npm run lp-worker                       # daemon, LP_WORKER_INTERVAL_SEC (default 60s, clamped 30s..10min)
 *   npm run lp-worker -- --once             # one cycle
 *   npm run lp-worker -- --once --dry-run   # one cycle, decisions only
 *   npm run lp-worker -- --interval-sec 45  # override the interval (still clamped)
 *
 * Unknown flags REFUSE the boot (audit A6): the worker is live by default, so
 * a misspelled `--dry-run` silently ignored would spend where the operator
 * meant to rehearse.
 *
 * ─── OPERATIONAL INVARIANT: RUN EXACTLY ONE LP WORKER PER DATABASE ─────────
 *
 * Nothing here enforces it. Since PHASE3.2 the trigger observation — the
 * hysteresis counter that gates every protect and every rotate — is a row in
 * `lp_observations`, one per position. Two workers against one database would
 * race that upsert and each could read a stale previous observation. The
 * one-non-terminal-sequence-per-position unique index bounds the damage to at
 * most one saga per position, so the cost is a delayed confirmation and not a
 * double exit — but it is still a cost nobody chose. ONE worker per database.
 *
 * ─── WHAT `--once` CAN AND CANNOT PROVE (PHASE3.2 Decision 3) ──────────────
 *
 * Since PHASE3.2 the observation is DURABLE, so two `--once` invocations at
 * least one interval apart DO confirm a protect — that is the fix for FINDINGS
 * (ae), and it is the thing that was impossible before. But ONE `--once` run
 * against a fresh position still cannot fire a protect: one cycle cannot
 * produce two observations. The cycle prints exactly that when it records a
 * first observation, including the timestamp at which a second run becomes
 * eligible. "Wait one interval" also means "wait for a new FINALIZED block" —
 * never binding on BSC at 60 s, but it is the other half of the comparison, so
 * an operator debugging a hold knows to look at `blockNumber` too.
 */
import { createLpFeeEventStore } from "../src/store/lpFeeEvents.js";

import { getAddress, type Address } from "viem";
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import { createAgentStore } from "../src/store/agents.js";
import {
  createJournal,
  reconcile,
  assertReconcileGuardCoversSubmitWindow,
} from "../src/store/journal.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { createLpSequenceStore } from "../src/store/lpSequences.js";
import { createLpSettingsStore } from "../src/store/lpSettings.js";
import { createLpObservationStore } from "../src/store/lpObservations.js";
import { createLpGridCycleStore } from "../src/store/gridCycles.js";
import { resolveVenues } from "../src/ops/venues.js";
import { resolveLpRelayFeePerSubmitWei } from "../src/ops/policy.js";
import {
  createLpChainReaders,
  resolveLpAddresses,
  resolveLpRpcUrls,
} from "../src/lp/readers.js";
import {
  clampLpWorkerIntervalMs,
  createLpWorkerState,
  resolveLpWorkerBootConfig,
  runLpWorkerOnce,
  sleepUntilNextCycle,
  type LpWorkerDeps,
  type LpWorkerPositionOutcome,
} from "../src/lp/worker.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { createLpBrainTransport } from "../src/lp/brain.js";
import { acquireWorkerSingleton } from "../src/deployment/workerSingleton.js";

/** Boolean flags the worker knows. Everything else is refused (audit A6). */
const KNOWN_BOOLEAN_FLAGS = new Set(["dry-run", "once"]);
/** Value-taking flags the worker knows (`--name value` or `--name=value`). */
const KNOWN_VALUE_FLAGS = new Set(["interval-sec"]);

/**
 * AUDIT A6: unknown flags are refused LOUDLY before anything else runs. The
 * worker is live by default (`--dry-run` is the opt-OUT), so a typo'd
 * `--dry-ruN`/`--dryrun` silently ignored would run the daemon LIVE against
 * every armed agent's positions while the operator believes it is rehearsing.
 * A daemon must never guess what a flag meant.
 */
function assertKnownFlags(): void {
  const argv = process.argv.slice(2);
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry === undefined) continue;
    if (!entry.startsWith("--")) {
      unknown.push(entry);
      continue;
    }
    const eq = entry.indexOf("=");
    const name = eq > 0 ? entry.slice(2, eq) : entry.slice(2);
    if (KNOWN_BOOLEAN_FLAGS.has(name)) {
      if (eq > 0) unknown.push(entry); // `--dry-run=x` is not a shape we accept
      continue;
    }
    if (KNOWN_VALUE_FLAGS.has(name)) {
      // `--interval-sec 45` consumes the next token; `--interval-sec=45` is
      // self-contained either way.
      if (eq < 0) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) i += 1;
      }
      continue;
    }
    unknown.push(entry);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. Known flags: ` +
        `--dry-run, --once, --interval-sec <seconds>. Refusing to start — ` +
        `the worker runs LIVE by default, and a misspelled flag must never ` +
        `be silently ignored.`,
    );
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
      return undefined;
    }
    if (entry !== undefined && entry.startsWith(`--${name}=`)) {
      return entry.slice(name.length + 3);
    }
  }
  return undefined;
}

/**
 * A resumed sequence that is durably stuck (PHASE3.11 F1's stall latch: same
 * status/code, cycle after cycle, because the state machine has no path back
 * to `held` for it — see FINDINGS/operator notes 2026-09-03) would otherwise
 * print one identical multi-line block EVERY interval forever. On a daemon
 * that runs for days on Railway that is not signal, it is the log burying the
 * signal. Collapse an UNCHANGED resumed/held result to one line per repeat
 * window; ANY change in status, code, action or kind still prints in full
 * immediately, so this never hides a real transition or a new failure mode —
 * only a byte-identical repeat of the last one.
 */
const STALL_LOG_HEARTBEAT_CYCLES = 120; // ~1h at the default 30s interval
const stallLogState = new Map<string, { signature: string; repeats: number; firstSeenAtMs: number }>();

function throttledStallLine(outcome: LpWorkerPositionOutcome): boolean {
  const result = outcome.result;
  if (outcome.action !== "resumed" || result === undefined || result.status !== "held") {
    return false;
  }
  const key = `${outcome.agentId}:${outcome.positionId}`;
  const signature = `${outcome.kind ?? ""}:${result.status}:${result.code}`;
  const prior = stallLogState.get(key);
  if (prior === undefined || prior.signature !== signature) {
    stallLogState.set(key, { signature, repeats: 0, firstSeenAtMs: Date.now() });
    return false; // first sighting (or a real change) — log it in full, as always.
  }
  prior.repeats += 1;
  if (prior.repeats % STALL_LOG_HEARTBEAT_CYCLES === 0) {
    const stuckForMin = Math.round((Date.now() - prior.firstSeenAtMs) / 60_000);
    console.log(
      `[lp-worker] agent=${outcome.agentId} position=${outcome.positionId} ` +
        `sequence=${result.sequenceId} status=held code=${result.code} ` +
        `(unchanged for ${prior.repeats} cycles, ~${stuckForMin}m — repeated lines suppressed; ` +
        `this is the owner-signed-abandon door, see the position's blockedBySequence note)`,
    );
  }
  return true; // suppressed: an identical repeat of the last cycle's result.
}

function logOutcome(outcome: LpWorkerPositionOutcome): void {
  if (throttledStallLine(outcome)) return;

  const parts = [
    `agent=${outcome.agentId}`,
    `position=${outcome.positionId}`,
    `action=${outcome.action}`,
    ...(outcome.kind === undefined ? [] : [`kind=${outcome.kind}`]),
    ...(outcome.decision === undefined ? [] : [`decision=${outcome.decision}`]),
    ...(outcome.result === undefined
      ? []
      : [
          `sequence=${outcome.result.sequenceId}`,
          `status=${outcome.result.status}`,
          `code=${outcome.result.code}`,
        ]),
    ...(outcome.plannedSteps === undefined
      ? []
      : [`would-run=[${outcome.plannedSteps.join(" -> ")}]`]),
  ];
  console.log(`[lp-worker] ${parts.join(" ")} reason=${sanitizeMessage(outcome.reason)}`);
  if (outcome.triggerReason !== undefined) {
    // The full audit record for the decision, one line, sanitized fields only.
    console.log(`[lp-worker]   trigger=${JSON.stringify(outcome.triggerReason)}`);
  }
  if (outcome.observationPersisted === false) {
    console.warn(
      `[lp-worker]   WARNING: the trigger observation could NOT be persisted. ` +
        `The decision above stands; the next cycle will re-observe from scratch, ` +
        `which costs ONE extra confirmation cycle before a protect can fire.`,
    );
  }
  const protection = outcome.protection;
  if (protection !== undefined) {
    // PHASE3.2 Decision 3/4: "is protection armed", from the ONE definition
    // the HTTP read side calls. Printed on every cycle, because a dashboard —
    // or a log — that says "SL: 5%" while the counter can never reach two is
    // the whole of FINDINGS (ae).
    console.log(
      `[lp-worker]   protection armed=${protection.armed} ` +
        `stop-loss=${protection.stopLossPct ?? "n/a"}% ` +
        `take-profit=${protection.takeProfitPct ?? "n/a"}% ` +
        `observation-held=${protection.observationHeldAtMs ?? "none"} ` +
        `age=${protection.observationAgeMs ?? "n/a"}ms ` +
        `stale=${protection.observationStale} ` +
        `protect-consecutive=${protection.protectConsecutive} ` +
        `confirm-eligible-at=${protection.confirmationEligibleAtMs ?? "n/a"} ` +
        `max-age=${protection.maxObservationAgeMs}ms ` +
        `reason=${sanitizeMessage(protection.reason)}`,
    );
    if (protection.protectConsecutive === 1 && protection.confirmationEligibleAtMs !== null) {
      // Decision 3, stated rather than discovered: ONE cycle can never produce
      // TWO observations. A single `--once` against a fresh position cannot
      // fire a protect, and that is correct, not a bug to debug.
      console.log(
        `[lp-worker]   this is a FIRST observation — confirmation requires a subsequent ` +
          `run at least one interval later (at ${new Date(protection.confirmationEligibleAtMs).toISOString()}) ` +
          `AND a newer FINALIZED block. A stop-loss cannot be tested with one invocation.`,
      );
    }
  }
}

async function main(): Promise<void> {
  // Unknown flags refuse BEFORE anything else (audit A6): live is the
  // default, so a typo'd `--dry-run` must fail the boot, not spend.
  assertKnownFlags();

  // Rails resolved ONCE at boot; missing ⇒ this throws and the process exits.
  const boot = resolveLpWorkerBootConfig(process.env);

  const isMainnet = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
  const network: NetworkConfig = isMainnet ? BNB : BNB_TESTNET;
  const keyStore = getAddress(network.keyStore);

  // A worker on the memory stores would poll a universe that dies with it and
  // can never contain the server's positions. Refuse rather than idle.
  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required: the worker's queue is the persisted position store, " +
        "and a memory store here would be a different universe from the server's. " +
        "(For an all-in-one memory stack use `npm run dev-stack -- --lp-worker`.)",
    );
  }
  const singleton = await acquireWorkerSingleton({
    role: "lp-worker",
    databaseUrl,
  });
  if (singleton.kind !== "acquired") {
    throw new Error("lp-worker singleton acquisition failed.");
  }

  const venues = resolveVenues({
    chainId: network.chainId,
    overrides: {
      pancakeRouterV3: process.env["VENUE_PANCAKE_ROUTER_V3"] ?? "",
      wbnb: process.env["VENUE_WBNB"] ?? "",
    },
    keyStore,
  });
  const addresses = resolveLpAddresses(process.env, {
    chainId: network.chainId,
    keyStore,
    ...(venues.pancakeRouterV3 === undefined ? {} : { routerV3: venues.pancakeRouterV3 }),
    ...(venues.wbnb === undefined ? {} : { wbnb: venues.wbnb }),
  });

  const readerNetwork = {
    chain: network.chain,
    chainId: network.chainId,
    publicRpcUrl: network.publicRpcUrl,
  };
  // The endpoint list every other operator script already passes. Defaulting
  // to `network.publicRpcUrl` here is what made the worker unable to read a
  // mint receipt on mainnet — see `resolveLpRpcUrls`.
  const rpcUrls = resolveLpRpcUrls(process.env, readerNetwork);

  const readers = createLpChainReaders({
    network: readerNetwork,
    workerFence: singleton.fence,
    rpcUrls,
    nfpm: addresses.nfpm,
    factory: addresses.factory,
    quoterV2: addresses.quoterV2,
    twapWindowSeconds: boot.rails.twapWindowSeconds,
  });

  const provider = new AltanaProvider({ network, rpcUrls });
  // FIXREVIEW N7. This process reconciles every cycle and is the one that
  // reproduced FINDINGS (ap-1); it must refuse to start on the same terms the
  // server does.
  assertReconcileGuardCoversSubmitWindow(provider);
  const agentStore = await createAgentStore();
  const journal = await createJournal();
  const killswitch = await createKillSwitch();
  const store = await createLpSequenceStore();
  const settingsStore = await createLpSettingsStore();
  const observations = await createLpObservationStore();
  // PHASE3.15: the derived cycle ledger, built only when the grid is enabled —
  // a deployment that never enabled it does not create the table.
  const feeEvents = await createLpFeeEventStore();
  const gridCycles = boot.gridEnabled ? await createLpGridCycleStore() : undefined;

  const llmKey = (process.env["TRADE_LLM_API_KEY"]?.trim() || process.env["OPENROUTER_API_KEY"]?.trim() || "");
  const llmBaseUrl = process.env["TRADE_LLM_BASE_URL"]?.trim() ?? "";
  const llmModel = process.env["TRADE_LLM_MODEL"]?.trim() ?? "";
  const brainTransport =
    llmKey === ""
      ? undefined
      : createLpBrainTransport({
          readKey: () => llmKey,
          ...(llmBaseUrl === "" ? {} : { baseUrl: llmBaseUrl }),
          ...(llmModel === "" ? {} : { modelOverride: llmModel }),
        });

  const dryRun = flag("dry-run");
  const once = flag("once");
  const intervalOverride = flagValue("interval-sec");
  const intervalMs =
    intervalOverride === undefined
      ? boot.intervalMs
      : clampLpWorkerIntervalMs(Number(intervalOverride) * 1000);

  const deps: LpWorkerDeps = {
    feeEvents,
    feeWorkerFence: singleton.fence,
    agentStore,
    journal,
    killswitch,
    store,
    settingsStore,
    observations,
    provider,
    readers,
    rails: boot.rails,
    atomicRotate: boot.atomicRotate,
    maxTickWidth: boot.runtime.maxTickWidth,
    conversionCompatibleTokens: boot.runtime.conversionCompatibleTokens,
    // PHASE3.15. `GRID_ENABLED` is resolved by `resolveLpWorkerBootConfig`, at
    // the same boot that already refuses to start without `LP_ENABLED` — so the
    // L3 pair is covered here by that existing throw. Without this line the
    // flag would be unreachable in the daemon and every grid agent would be
    // skipped on a deployment that had enabled the grid: the PHASE4-AUDIT A1
    // shape, which is exactly what the flag exists to avoid.
    gridEnabled: boot.gridEnabled,
    ...(gridCycles === undefined ? {} : { gridCycles }),
    // PHASE3.1 Rev2 item 17: the exit swap's dust floor is the SAME
    // `LP_RELAY_FEE_PER_SUBMIT_WEI` the reserve is sized on, so the two move
    // together when a live run replaces the placeholder.
    relayFeePerSubmitWei: resolveLpRelayFeePerSubmitWei(process.env),
    venue: {
      nfpm: addresses.nfpm,
      routerV3: addresses.routerV3,
      wbnb: addresses.wbnb,
    },
    ...(brainTransport === undefined
      ? {}
      : {
          brainTransport,
        }),
    reconcile: () =>
      reconcile({
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
      }),
    now: Date.now,
    intervalMs,
    ...(boot.maxObservationAgeMs === undefined
      ? {}
      : { maxObservationAgeMs: boot.maxObservationAgeMs }),
    dryRun,
    log: logOutcome,
  };

  console.log(
    `[lp-worker] network=${isMainnet ? "MAINNET" : "testnet"} chain=${network.chainId} ` +
      `interval=${intervalMs}ms dry-run=${dryRun} once=${once} ` +
      `brain=${brainTransport === undefined ? "off (no TRADE_LLM_API_KEY/OPENROUTER_API_KEY)" : "worker-llm"}`,
  );

  const state = createLpWorkerState();
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[lp-worker] ${signal} received; finishing the current cycle`);
      stopping = true;
    });
  }

  for (;;) {
    const startedAt = Date.now();
    try {
      const report = await runLpWorkerOnce(deps, state);
      console.log(
        `[lp-worker] cycle done outcomes=${report.outcomes.length} ` +
          `reconciled=${report.reconciled} dry-run=${report.dryRun}`,
      );
    } catch (error) {
      // A cycle failure is logged and the daemon lives: the next cycle
      // re-reads everything, and the sagas' own journaling means nothing was
      // left half-decided by the crash of a DECISION loop.
      console.error(
        `[lp-worker] cycle failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`,
      );
    }
    if (once || stopping) break;
    // Anchored on this cycle's START and RE-CHECKED (PHASE3.2 Rev2 item 3):
    // `setTimeout` is not contractually late-only, and a 1 ms early fire would
    // put two stamps under `intervalMs` apart and cost the protect a third
    // cycle — (af) at 1 ms. An overrunning cycle waits zero and the next starts
    // immediately; cycle STARTS are therefore never closer than `intervalMs`
    // and no catch-up burst is possible.
    await sleepUntilNextCycle({
      cycleStartedAtMs: startedAt,
      intervalMs,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      stopped: () => stopping,
    });
    if (stopping) break;
  }

  for (const closeable of [journal, killswitch, agentStore, store, settingsStore, observations, feeEvents, ...(gridCycles ? [gridCycles] : [])]) {
    try {
      await closeable.close();
    } catch {
      /* independent closes; one failure must not strand the others */
    }
  }
  try {
    await singleton.closeGracefully();
  } catch {
    /* lock loss already latched the fatal path */
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nlp-worker failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
