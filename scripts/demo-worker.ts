/**
 * The demo worker daemon.
 *
 *   npm run demo-worker            # daemon, DEMO_WORKER_INTERVAL_SEC (default 60s)
 *   npm run demo-worker -- --once  # one cycle, then exit
 *
 * It advances every running demo agent: reads each DISTINCT pool once, reads
 * one batched price list for every demo trade agent at once, steps the pure
 * engines and writes a rolling snapshot plus any fills. It holds no key, signs
 * nothing and submits nothing — there is no code path from this process to a
 * transaction.
 *
 * Exits 0 when demo mode is off, rather than failing: a deployment that runs
 * the worker unconditionally should not crash-loop because the flag is unset.
 */
import { buildDemoWiring } from "../src/demo/wiring.js";
import { runDemoCycle, startDemoWorker } from "../src/demo/worker.js";

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const wiring = await buildDemoWiring({
    env: process.env,
    ...(process.env["DATA_PLANE_URL"] === undefined
      ? {}
      : { dataPlaneUrl: process.env["DATA_PLANE_URL"] }),
    ...(process.env["DATA_PLANE_TOKEN"] === undefined
      ? {}
      : { dataPlaneToken: process.env["DATA_PLANE_TOKEN"] }),
  });
  if (wiring === null) {
    console.log("[demo-worker] DEMO_ENABLED is not \"true\"; nothing to run.");
    return;
  }

  const deps = {
    ...wiring.worker,
    onError: (agentId: string, error: unknown) => {
      console.error(`[demo-worker] ${agentId}: ${error instanceof Error ? error.message : "error"}`);
    },
  };

  if (once) {
    const report = await runDemoCycle(deps);
    console.log(`[demo-worker] ${JSON.stringify(report)}`);
    await wiring.close();
    return;
  }

  console.log(
    `[demo-worker] every ${wiring.config.workerIntervalMs / 1_000}s, `
    + `<=${wiring.config.maxAgentsPerCycle} agents per cycle, `
    + `TTL ${wiring.config.ttlDays}d, cap ${wiring.config.maxAgentsPerOwner}/owner.`,
  );
  const handle = startDemoWorker(deps);
  const stop = (): void => {
    handle.stop();
    void wiring.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Keep the process alive: the worker's own timer is unref'd on purpose.
  setInterval(() => undefined, 1 << 30);
}

await main();
