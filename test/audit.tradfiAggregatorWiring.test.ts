/**
 * R2.9/R3.7 — every Flash call site is wired through the shared helpers.
 *
 * A source-text scan, in the pattern of `test/demo.plane.test.ts`'s import
 * boundary: it does not re-derive correctness, only that the mechanical
 * wiring cannot silently regress. Every `binanceQuoteAndSwap(` call — in
 * `worker.ts` and the two server-side sites R3.7/N7 named — must pass its
 * request through `flashRequest(` (the R2.4 slippage clamp). `worker.ts`'s
 * eight sites must additionally resolve through `acceptFlashQuote(` before
 * the result is used, so a future call site cannot skip the C2 checks.
 *
 * L5 (audit): this is an `audit.*` source test on purpose — moved out of
 * `tradfiAggregatorActivation.test.ts` so it lives in the auditor-protected
 * class the spec asked for, rather than a file a builder may edit freely.
 */
import assert from "node:assert/strict";
import test from "node:test";

async function readSource(relativePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function countOccurrences(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

test("R2.4/R2.9: every binanceQuoteAndSwap( call in worker.ts is wrapped in flashRequest( and resolves through acceptFlashQuote(", async () => {
  const source = await readSource("src/trade/worker.ts");
  const callSites = countOccurrences(source, /\.binanceQuoteAndSwap!?\(/gu);
  assert.equal(callSites, 8, "worker.ts's Flash call-site count changed — update this pin deliberately");
  const wrappedSites = countOccurrences(source, /\.binanceQuoteAndSwap!?\(flashRequest\(/gu);
  assert.equal(wrappedSites, callSites, "a worker.ts Flash call site is not wrapped in flashRequest(");
  // Every call site's local variable is fed to acceptFlashQuote( somewhere in
  // the same file (a per-site "did it flow through" proof would need an AST,
  // but the helper has exactly one call shape and the count below pins that
  // every accepted quote — buy and sell, both branches at each of the four
  // logical sites — is checked once).
  const acceptCalls = countOccurrences(source, /acceptFlashQuote\(\{/gu);
  assert.equal(acceptCalls, 8, "a worker.ts Flash call site no longer resolves through acceptFlashQuote(");
});

test("R2.4/R3.7: the schedulable probe (server.ts) and the capability probe (index-server.ts) clamp with flashRequest(", async () => {
  const serverSource = await readSource("src/server.ts");
  assert.match(serverSource, /tradeAgent\.dataPlane\.binanceQuoteAndSwap!\(flashRequest\(/u);
  const indexServerSource = await readSource("src/index-server.ts");
  const probeCallSites = countOccurrences(indexServerSource, /await flash\(flashRequest\(/gu);
  assert.equal(probeCallSites, 2, "index-server.ts's two capability-probe Flash calls must both clamp with flashRequest(");
});

// R2.7/R2.9 (guard-preference): P-a replaced the net-price ranking at every
// TradFi selection site with "Binance wins whenever usable". A mutation that
// restores `rankTradfiOffers(` or its `ranked-out` observation at any of the
// three sites must fail this test.
test("R2.7/R2.9: worker.ts no longer ranks Binance against direct — no rankTradfiOffers( call and no ranked-out observation", async () => {
  const source = await readSource("src/trade/worker.ts");
  assert.equal(countOccurrences(source, /rankTradfiOffers\(/gu), 0,
    "worker.ts must not call rankTradfiOffers( — G1 replaced ranking with usable-Binance-wins");
  assert.equal(countOccurrences(source, /"ranked-out"/gu), 0,
    "worker.ts must not record a ranked-out refusal — that observation belonged to the removed ranking");
});

// AUDIT MEDIUM-2 (M18): index-server.ts's capability probe is boot code with
// no unit-test seam. A mutation lowering either Flash call's slippage below
// the 300 bps maximum (R2.8) would let capability drift from the caller's own
// owner-set slippage, which the probe is deliberately independent of.
test("AUDIT M18/R2.8: both capability-probe Flash calls request slippageBps: 300", async () => {
  const source = await readSource("src/index-server.ts");
  const probeLines = source.split(/\r?\n/u).filter((line) => line.includes("await flash(flashRequest("));
  assert.equal(probeLines.length, 2, "index-server.ts's capability-probe Flash call-site count changed — update this pin deliberately");
  for (const line of probeLines) {
    assert.match(line, /slippageBps: 300\b/u, `expected slippageBps: 300 in ${line}`);
  }
});

// AUDIT MEDIUM-2 (M19/L2): the pin cache key must include `mode` even when no
// v2 probe is configured, or a schedule-mode and an AI-mode tradfi pin (both
// reachable with no v2 settings) would share one cache entry.
test("AUDIT M19/L2: the pin cache key includes mode for a tradfi pin even with no v2 probe", async () => {
  const source = await readSource("src/server.ts");
  assert.match(source, /v2Probe === undefined \? `\$\{model\}:\$\{mode\}`/u,
    "the no-v2-probe branch of the pin cache key must still key on mode, not just model");
});

// 2026-09-23 live finding: `const flash = tradeDataPlane.binanceQuoteAndSwap;`
// detached the HTTP client's method from its instance; its private fields made
// every call throw a TypeError before any request, so every pool-less
// capability probe answered "unknown" and Schedule listed none. Fakes in the
// offline suites are plain functions and could not show it.
test("no src/ file holds binanceQuoteAndSwap as a detached (unbound) reference", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(new URL("../src/", import.meta.url), { recursive: true }))
    .filter((name) => name.endsWith(".ts"));
  for (const file of files) {
    const source = await readSource(`src/${file.split("\\").join("/")}`);
    assert.doesNotMatch(source, /=\s*[\w.]+\.binanceQuoteAndSwap\s*;/u, `detached binanceQuoteAndSwap in src/${file}`);
  }
});
