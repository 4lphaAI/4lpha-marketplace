import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(path: string): string {
  return readFileSync(resolve(executionRoot, path), "utf8");
}

function assertSource(text: string, pattern: RegExp, message: string): void {
  assert.equal(pattern.test(text), true, message);
}

test("fix-review A2: production ON mode has a concrete reviewed runtime composition", () => {
  const billingSources = readdirSync(resolve(executionRoot, "src", "billing"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "runtime.ts")
    .map((entry) => source(`src/billing/${entry.name}`))
    .join("\n");

  assertSource(
    billingSources,
    /export\s+(?:async\s+)?function\s+createBillingProductionRuntime\s*\(/,
    "a deployment-owned module contract is not the Phase 5 production adapter required by the spec",
  );
  assertSource(
    billingSources,
    /createBillingInternalGateway\s*\(/,
    "the concrete runtime must compose the reviewed internal gateway rather than supply an arbitrary Hono app",
  );
});

test("fix-review A3: PostgreSQL structurally enforces every permanent provider debit identity", () => {
  const postgres = source("src/billing/postgres.ts");

  assertSource(postgres, /router_payer_account_id/i, "0G payer identity is still present only inside the JSONB snapshot");
  assertSource(postgres, /router_request_id/i, "0G request identity is still present only inside the JSONB snapshot");
  assertSource(
    postgres,
    /unique\s*\([^)]*router_payer_account_id[^)]*router_request_id[^)]*\)/i,
    "PostgreSQL must permanently reject a duplicate (router payer account, Router request ID)",
  );
});

test("fix-review A3: PostgreSQL owns active leases, invoice claims, and the paid ledger", () => {
  const postgres = source("src/billing/postgres.ts");

  assertSource(postgres, /phase5_billing_(?:attempt_)?leases/i, "active attempt leases have no structured PostgreSQL relation");
  assertSource(postgres, /create\s+unique\s+index[\s\S]{0,500}\bwhere\b/i, "the required partial unique active-lease constraint is absent");
  assertSource(postgres, /phase5_billing_invoice_(?:members|claims)/i, "nonterminal invoice membership has no structured PostgreSQL constraint");
  assertSource(postgres, /phase5_billing_(?:spend_)?ledger/i, "paid rolling-window ledger entries have no structured PostgreSQL identity");
});

test("fix-review A7: the submitting boundary persists the complete prepared witness", () => {
  const store = source("src/billing/store.ts");
  const intent = /export type PreparedInvoiceIntent[\s\S]*?\n\};/.exec(store)?.[0] ?? "";

  for (const field of ["chainId", "wallet", "collector", "calldata", "valueWei", "sessionGeneration"]) {
    assertSource(intent, new RegExp(`\\b${field}\\b`), `PreparedInvoiceIntent omits ${field} from the durable ambiguity-boundary witness`);
  }
  assertSource(
    store,
    /markInvoiceSubmitting[\s\S]{0,300}bindingToken/i,
    "markInvoiceSubmitting does not return the specified one-use prepared-object binding token",
  );
});

test("fix-review A12: core derives every invoice oracle snapshot from two raw RPC observations", () => {
  const worker = source("src/billing/worker.ts");

  assertSource(
    worker,
    /readQuoteOracles[\s\S]{0,500}OracleObservation/,
    "the worker trust boundary accepts already-reduced OracleSnapshot values with no two-RPC provenance",
  );
  assertSource(
    worker,
    /validateOraclePair\s*\(/,
    "the reviewed core never compares the two independent RPC observations used by an invoice",
  );
});
