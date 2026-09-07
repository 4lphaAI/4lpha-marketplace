import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function assertSource(text: string, pattern: RegExp, message: string): void {
  assert.equal(pattern.test(text), true, message);
}

test("second fix-review A2/A7: the core production factory owns collection submit and recovery", () => {
  const production = source("src/billing/production.ts");

  assertSource(
    production,
    /submitBillingInvoice\s*\(/,
    "the infrastructure plug-in still owns the money-moving submitInvoice implementation",
  );
  assertSource(
    production,
    /recoverBillingInvoiceCallsId\s*\(/,
    "the infrastructure plug-in still owns post-relay callsId recovery instead of the reviewed core",
  );
  assert.equal(
    /worker\s*:\s*\{\s*store\s*,\s*\.\.\.adapter\.worker\s*\}/.test(production),
    false,
    "production must not install arbitrary worker submit/reconcile functions by spread",
  );
});

test("second fix-review A12: oracle observations are bound to the boot-reviewed RPC origins", () => {
  const production = source("src/billing/production.ts");
  const worker = source("src/billing/worker.ts");

  assertSource(
    `${production}\n${worker}`,
    /bscRpcOrigins[\s\S]{0,2000}originA|originA[\s\S]{0,2000}bscRpcOrigins/,
    "distinct caller-supplied strings do not prove that BNB observations came from the two configured BSC RPCs",
  );
  assertSource(
    `${production}\n${worker}`,
    /arbitrumRpcOrigins[\s\S]{0,2000}originA|originA[\s\S]{0,2000}arbitrumRpcOrigins/,
    "0G/sequencer observations are not bound to the two configured Arbitrum RPCs",
  );
});

test("second fix-review A9: durable cross-page duplicate tracking has an explicit storage bound", () => {
  const store = source("src/billing/store.ts");
  const og = source("src/billing/og.ts");

  assertSource(
    `${store}\n${og}`,
    /MAX_[A-Z0-9_]*SEEN[A-Z0-9_]*HISTORY|seenHistoryIds\.length\s*>\s*[1-9][0-9]*/,
    "the reconciler now appends every history ID to the singleton JSONB row without any durable bound",
  );
});
