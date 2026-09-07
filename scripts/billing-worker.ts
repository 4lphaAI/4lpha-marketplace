/**
 * Phase 5 billing worker operator shell.
 *
 * `--dry-run` is read-only all the way down: it opens an existing PostgreSQL
 * state row without DDL, never constructs a signer/client/oracle, and the core
 * worker guarantees those injected seams are unreachable. `--once` loads the
 * deployment-owned reviewed custody/RPC adapter and executes one bounded pass.
 */
import { resolveBillingConfig } from "../src/billing/config.js";
import { openBillingStoreReadOnly } from "../src/billing/postgres.js";
import { runBillingWorkerOnce } from "../src/billing/worker.js";
import { loadBillingProductionRuntime } from "../src/billing/runtime.js";

function selectedMode(argv: readonly string[]): "dry-run" | "once" {
  if (argv.length !== 1 || (argv[0] !== "--dry-run" && argv[0] !== "--once")) {
    throw new Error("Usage: npm run billing-worker -- --dry-run | --once");
  }
  return argv[0] === "--dry-run" ? "dry-run" : "once";
}

async function main(): Promise<void> {
  const selected = selectedMode(process.argv.slice(2));
  const config = resolveBillingConfig(process.env);
  if (selected === "once") {
    if (config.mode !== "on") {
      throw new Error("billing-worker --once requires BILLING_ENABLED=on.");
    }
    const runtime = await loadBillingProductionRuntime(config, process.env);
    try {
      const results = await runBillingWorkerOnce(runtime.worker, false);
      for (const result of results) console.log(JSON.stringify(result));
    } finally {
      await runtime.close();
    }
    return;
  }
  if (config.mode !== "report") {
    throw new Error("billing-worker --dry-run requires BILLING_ENABLED=report.");
  }

  const store = await openBillingStoreReadOnly(process.env);
  const unreachable = async (): Promise<never> => {
    throw new Error("A billing dry-run attempted a prohibited external operation.");
  };
  try {
    const results = await runBillingWorkerOnce({
      store,
      now: () => Math.floor(Date.now() / 1_000),
      bscRpcOrigins: ["https://dry-run-a.invalid", "https://dry-run-b.invalid"],
      arbitrumRpcOrigins: ["https://dry-run-a.invalid", "https://dry-run-b.invalid"],
      readOracleObservation: unreachable,
      reconcileOgUsage: unreachable,
      reconcileX402Usage: unreachable,
      reconcileInvoice: unreachable,
      submitInvoice: unreachable,
    }, true);
    for (const result of results) {
      console.log(JSON.stringify({
        accountId: result.accountId,
        action: result.action,
        ...(result.invoiceId === undefined ? {} : { invoiceId: result.invoiceId }),
      }));
    }
  } finally {
    await store.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Billing worker failed.");
  process.exitCode = 1;
});
