/** Read-only, sanitized Phase 5 billing status for operators. */
import { resolveBillingConfig } from "../src/billing/config.js";
import { openBillingStoreReadOnly } from "../src/billing/postgres.js";

function accountFilter(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== "--account-id" ||
      argv[1] === undefined || !/^[\x21-\x7e]{1,128}$/.test(argv[1])) {
    throw new Error("Usage: npm run billing-status -- [--account-id <id>]");
  }
  return argv[1];
}

async function main(): Promise<void> {
  const selected = accountFilter(process.argv.slice(2));
  if (resolveBillingConfig(process.env).mode !== "report") {
    throw new Error("billing-status requires BILLING_ENABLED=report.");
  }
  const store = await openBillingStoreReadOnly(process.env);
  try {
    const accounts = (await store.listAccounts()).filter((row) =>
      selected === undefined || row.accountId === selected);
    for (const account of accounts) {
      const [usages, invoices] = await Promise.all([
        store.listUsages(account.accountId),
        store.listInvoices(account.accountId),
      ]);
      console.log(JSON.stringify({
        accountId: account.accountId,
        status: account.status,
        usages: usages.map((usage) => ({
          usageId: usage.usageId,
          state: usage.state,
          source: usage.source,
          provider: usage.provider,
          ...(usage.evidenceDigest === undefined ? {} : { evidenceDigest: usage.evidenceDigest }),
        })),
        invoices: invoices.map((invoice) => ({
          invoiceId: invoice.invoiceId,
          state: invoice.state,
          ...(invoice.callsId === undefined ? {} : { callsId: invoice.callsId }),
          ...(invoice.transactionHash === undefined ? {} : { transactionHash: invoice.transactionHash }),
        })),
      }));
    }
  } finally {
    await store.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Billing status failed.");
  process.exitCode = 1;
});
