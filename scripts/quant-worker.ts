/**
 * The TermiX Quant grid daemon (QUANT-GRID §7.2, R2.13, R3.8, R4.6).
 *
 * FLAG OFF ⇒ EXIT 0 WITH A MESSAGE, not a throw. That is a deliberate
 * departure from `scripts/lending-worker.ts`, whose throw forced its Railway
 * block into comments: with `restartPolicyType: "ALWAYS"` a service declared
 * before its flag is on crash-loops forever. R2.13 nonetheless keeps the
 * lending RULE — the Railway block is declared in the SAME change that turns
 * the flag on — because `ALWAYS` also restarts a CLEAN exit, so an early
 * declaration is a restart loop either way, just a quiet one.
 *
 * Boot refuses, in this order and before any cycle:
 *   chain 56 · reconcile guard covers the submit window · the TermiX config
 *   block matches the pinned venue · the pair address matches the factory ·
 *   OUR public key is the one TermiX has registered · the orchestrator pin
 *   equals the LP landing constant.
 *
 * The key-registration check matters more than it looks: a worker running
 * under the WRONG SEED would open nothing and look idle.
 */
import { BNB } from "@altananetwork/sdk";

import { sanitizeMessage } from "../src/core/errors.js";
import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import {
  resolveQuantEnabled,
  resolveQuantRuntimeConfig,
  quantEgressOrigins,
} from "../src/quant/config.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { createQuantChainReader } from "../src/quant/readers.js";
import { assertOrchestratorPin } from "../src/quant/receipt.js";
import { HttpQuantTransport, type QuantTransport } from "../src/quant/termix.js";
import { FileQuantTransport } from "../src/quant/selftest.js";
import { runQuantWorkerOnce } from "../src/quant/worker.js";
import { assertQuantBoot, buildWorkerDeps } from "./quantWorkerDeps.js";
import { createQuantJobStore } from "../src/store/quantJobs.js";
import {
  createJournal,
  reconcile,
} from "../src/store/journal.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import {
  acquireWorkerSingleton,
  createWorkerGracefulDrain,
  waitForWorkerDelay,
} from "../src/deployment/workerSingleton.js";

/** `--interval-sec` is REJECTED: `QUANT_WORKER_INTERVAL_MS` is the one source. */
const BOOLEAN_FLAGS = new Set(["once", "dry-run"]);

function parseArgs(argv: readonly string[]): {
  readonly once: boolean; readonly dryRun: boolean;
} {
  let once = false;
  let dryRun = false;
  for (const raw of argv) {
    if (!raw.startsWith("--")) throw new Error(`Unknown argument: ${raw}.`);
    const name = raw.slice(2);
    if (!BOOLEAN_FLAGS.has(name)) throw new Error(`Unknown flag: --${name}.`);
    if (name === "once") once = true;
    if (name === "dry-run") dryRun = true;
  }
  return { once, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!resolveQuantEnabled(process.env)) {
    console.log("[quant-worker] QUANT_ENABLED is off; exiting 0");
    return;
  }
  const config = resolveQuantRuntimeConfig(process.env, { publicRpcUrl: BNB.publicRpcUrl });
  if (BNB.chainId !== 56) throw new Error("quant-worker requires BNB mainnet chain 56.");

  // R8.1: ONE source for the orchestrator pin, asserted equal to the LP landing
  // constant at boot — a tautology today, a tripwire the day someone forks it.
  assertOrchestratorPin(PORTO_V055_ORCHESTRATOR);

  const reader = createQuantChainReader({ rpcUrls: config.rpcUrls });

  // R2.10: config already refused a process that has both a self-test file and
  // a TermiX bearer; whichever it has selects the transport.
  const transport: QuantTransport = config.selfTestFile === null
    ? new HttpQuantTransport({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey })
    : new FileQuantTransport(config.selfTestFile, { u: config.u, wbnb: config.wbnb, router: config.router });

  const keypair = quantKeypairFromSeed(config.envelopeKey);
  const provider = new AltanaProvider({ network: BNB, rpcUrls: [...config.rpcUrls] });
  // The SAME boot assertions the CLI `worker` runs (QUANT-SELFTEST R5).
  await assertQuantBoot({ transport, reader, config, keypair, provider });

  const store = await createQuantJobStore();
  const journal = await createJournal();

  const relayUrl = BNB.relayUrl ?? "";
  if (relayUrl === "") throw new Error("Boot refused: no Altana relay serves chain 56.");
  console.log(`[quant-worker] egress=${quantEgressOrigins(config, relayUrl).join(",")}`);

  const lease = await acquireWorkerSingleton({
    role: "quant-worker",
    databaseUrl: config.databaseUrl,
  });
  if (lease.kind !== "acquired") throw new Error("quant-worker singleton is already held.");
  const drain = createWorkerGracefulDrain({ label: "quant-worker" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { drain.requestStop(); });
  }

  const deps = await buildWorkerDeps(
    { config, store, journal, transport, reader, provider },
    lease.fence.signal,
  );

  await reconcile({
    provider,
    journal,
    // A quant job is NOT a marketplace agent: there is no `AgentStore` row to
    // resolve, and the only kinds this process writes resolve from `callsId`.
    resolveWallet: async () => null,
  });

  console.log(
    `[quant-worker] chain=56 interval=${config.intervalMs}ms `
    + `dry-run=${args.dryRun} once=${args.once} strategy=${config.strategyId}`,
  );

  for (;;) {
    const startedAt = Date.now();
    const runId = `quant:${startedAt}:${Math.floor(Math.random() * 1e6)}`;
    try {
      lease.fence.assertOpen();
      const report = await runQuantWorkerOnce(deps, { dryRun: args.dryRun });
      await store.recordRun({
        runId,
        startedAtMs: startedAt,
        finishedAtMs: Date.now(),
        jobsSeen: report.jobsSeen,
        actions: report.actions,
        holds: report.holds,
        errors: report.errors,
        dryRun: report.dryRun,
      });
      console.log(
        `[quant-worker] cycle jobs=${report.jobsSeen} actions=${report.actions} `
        + `holds=${report.holds} errors=${report.errors}`,
      );
    } catch (error) {
      console.error(
        `[quant-worker] cycle failed: ${sanitizeMessage(
          error instanceof Error ? error.message : "unknown error",
        )}`,
      );
      if (lease.fence.isFatal()) break;
    }
    if (args.once || drain.isStopping()) break;
    const waited = await waitForWorkerDelay({
      delayMs: Math.max(0, config.intervalMs - (Date.now() - startedAt)),
      fence: lease.fence,
      gracefulSignal: drain.signal,
    });
    if (waited === "stopped") break;
  }

  drain.complete();
  try { await lease.closeGracefully(); } catch { /* the lock dies with us */ }
  for (const closable of [store, journal]) {
    try { await closable.close(); } catch { /* independent close */ }
  }
}

main().catch((error: unknown) => {
  console.error(
    `quant-worker failed: ${sanitizeMessage(
      error instanceof Error ? error.message : "unknown error",
    )}`,
  );
  process.exitCode = 1;
});
