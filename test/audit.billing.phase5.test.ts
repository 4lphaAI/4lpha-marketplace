import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ogRoot = resolve(executionRoot, "..", "4lpha-0G");

function source(root: string, path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function assertSource(text: string, pattern: RegExp, message?: string): void {
  assert.equal(pattern.test(text), true, message ?? `missing source invariant ${pattern}`);
}

test("audit Phase 5: a paid public caller is bound to the ticket wallet before its issuer signs", () => {
  const route = source(ogRoot, "app/api/copilot/chat/route.ts");
  const gateway = source(ogRoot, "lib/billing/gateway.ts");

  assertSource(
    route,
    /callerWalletAddress\s*:\s*parsed\.data\.wallet\.address/,
    "the authenticated public wallet must be passed across the paid bridge",
  );
  assertSource(
    gateway,
    /callerWalletAddress[\s\S]{0,1600}ticket\.walletAddress|ticket\.walletAddress[\s\S]{0,1600}callerWalletAddress/,
    "the per-agent issuer must refuse to sign unless caller wallet equals the ticket wallet",
  );
});

test("audit Phase 5: the worker owns every recoverable pre-contact/quoted lifecycle", () => {
  const worker = source(executionRoot, "src/billing/worker.ts");

  assertSource(worker, /\.reclaimPreparedLease\s*\(/, "expired never-contacted attempts otherwise wedge the account forever");
  assertSource(worker, /\.expireQuotedInvoice\s*\(/, "expired never-bound quotes otherwise wedge collection/close forever");
  assertSource(worker, /reconcileX402Usage/, "x402 UNKNOWN needs its specified authorization/receipt reconciler, not only 0G reconciliation");
});

test("audit Phase 5: live 0G catalog facts are fully compared before paid Router contact", () => {
  const gateway = source(executionRoot, "src/billing/http.ts");

  assertSource(gateway, /assertLiveOgModelMatches\s*\(/);
  assertSource(gateway, /LiveOgModelFacts/);
});

test("audit Phase 5: PostgreSQL, not only a JSON snapshot, enforces permanent monetary identities", () => {
  const postgres = source(executionRoot, "src/billing/postgres.ts");

  assertSource(postgres, /insert\s+into\s+phase5_billing_usage_identities/i);
  assertSource(postgres, /grant_id[\s\S]{0,500}generation[\s\S]{0,500}operation[\s\S]{0,500}logical_request_id/i);
  assertSource(postgres, /unique[\s\S]{0,200}grant_id[\s\S]{0,200}generation[\s\S]{0,200}operation[\s\S]{0,200}logical_request_id/i);
});

test("audit Phase 5: account close owns one durable flush claim and releases it only on safe retry paths", () => {
  const store = source(executionRoot, "src/billing/store.ts");

  assertSource(store, /claimInvoice[\s\S]{0,5000}closeFlushInvoiceId/);
  assertSource(store, /expireQuotedInvoice[\s\S]{0,2500}closeFlushInvoiceId/);
  assertSource(store, /projectInvoiceRolledBack[\s\S]{0,2500}closeFlushInvoiceId/);
});
