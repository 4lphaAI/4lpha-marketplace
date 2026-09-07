/**
 * Sanitized reconciliation queue inspection. Live evidence polling remains
 * blocked by the same Phase 5 production gates as the worker.
 */
import { resolveBillingConfig } from "../src/billing/config.js";
import { openBillingStoreReadOnly } from "../src/billing/postgres.js";
import { loadBillingProductionRuntime } from "../src/billing/runtime.js";
import { runBillingWorkerOnce } from "../src/billing/worker.js";

function mode(argv: readonly string[]): "dry-run" | "once" {
  if (argv.length !== 1 || (argv[0] !== "--dry-run" && argv[0] !== "--once")) {
    throw new Error("Usage: npm run billing-reconcile -- --dry-run | --once");
  }
  return argv[0] === "--dry-run" ? "dry-run" : "once";
}

async function main(): Promise<void> {
  const selected = mode(process.argv.slice(2));
  const config = resolveBillingConfig(process.env);
  if (selected === "once") {
    if (config.mode !== "on") throw new Error("billing-reconcile --once requires BILLING_ENABLED=on.");
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
    throw new Error("billing-reconcile --dry-run requires BILLING_ENABLED=report.");
  }
  const store = await openBillingStoreReadOnly(process.env);
  try {
    for (const account of await store.listAccounts()) {
      const [usages, invoices] = await Promise.all([
        store.listUsages(account.accountId),
        store.listInvoices(account.accountId),
      ]);
      for (const usage of usages) if (usage.state === "unknown") {
        console.log(JSON.stringify({
          accountId: account.accountId,
          kind: "usage",
          usageId: usage.usageId,
          evidenceDigest: usage.evidenceDigest ?? null,
        }));
      }
      for (const invoice of invoices) if (invoice.state === "submitting" || invoice.state === "unknown") {
        console.log(JSON.stringify({
          accountId: account.accountId,
          kind: "invoice",
          invoiceId: invoice.invoiceId,
          callsId: invoice.callsId ?? null,
          preparedIntentDigest: invoice.preparedIntentDigest ?? null,
        }));
      }
    }
  } finally {
    await store.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Billing reconciliation failed.");
  process.exitCode = 1;
});
