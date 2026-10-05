/** AGENTIC-RFQ-STOCKS 4.5 (E5): RFQ-aware screening in selectEntryCandidates. */
import assert from "node:assert/strict";
import test from "node:test";
import { admittedVenueRows, rwaEntryVerdict, type RwaFact } from "../src/trade/rwa.js";
import { TRADE_READ_BUDGET, TRADE_SHORTLIST_MAX, createTradeVerdictCache, pinUniverse, selectEntryCandidates, type PinnedCandidate, type SelectEntryCandidatesInput } from "../src/trade/universe.js";
import type { UniverseRow } from "../src/trade/dataPlaneReads.js";
import { RFQ_FIXTURE_AS_OF, loadRfqUniverse, rfqDataPlane } from "./support/agenticRfq.js";

const NOW = RFQ_FIXTURE_AS_OF + 60_000;
const settings = { minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, settlementAsset: "USDT" } as const;

async function screen(rows: readonly UniverseRow[], extra: Partial<SelectEntryCandidatesInput> = {}, reads: { security: number } = { security: 0 }) {
  const base = rfqDataPlane(rows);
  const dataPlane = { ...base, security: async (...args: Parameters<typeof base.security>) => { reads.security += 1; return base.security(...args); } };
  // Every row is a candidate in pooled-first order, as the Agentic RFQ pin lists them.
  const pinned = await pinUniverse("tradfi", { dataPlane: base, tradfiV2CapabilityProbe: async () => true }, { lanes: ["bstocks"], probeAll: true });
  const rfqOnly = new Set(pinned.filter((candidate) => admittedVenueRows(candidate.venues).length === 0).map((candidate) => candidate.address.toLowerCase()));
  const facts = new Map<string, RwaFact>(rows.flatMap((row) => row.rwa === undefined ? [] : [[row.address.toLowerCase(), row.rwa] as const]));
  const input: SelectEntryCandidatesInput = { model: "tradfi", settings, candidates: pinned, pinnedAddresses: new Set(pinned.map((c) => c.address.toLowerCase())), previouslyEnteredAddresses: new Set(),
    openPositionAddresses: new Set(), forbiddenAddresses: new Set(), rwaAddresses: new Set(rows.map((row) => row.address.toLowerCase())), rwaFacts: facts, dataPlane, nowMs: NOW,
    verdictCache: createTradeVerdictCache(), rfqOnly, ...extra };
  return { result: await selectEntryCandidates(input), rfqOnly, pinned: pinned as readonly PinnedCandidate[], input };
}
const symbolOf = (rows: readonly UniverseRow[], address: string): string => rows.find((row) => row.address.toLowerCase() === address.toLowerCase())!.symbol;

test("QNTB (+372 bps dust) and AMDB (-792 bps dust) are allowed as premium:deferred: the dust-pool premium is never read", async () => {
  const rows = await loadRfqUniverse(true);
  const { result } = await screen(rows);
  assert.equal(result.kind, "selected");
  const note = (symbol: string) => result.kind === "selected" ? result.candidates.find((c) => symbolOf(rows, c.address) === symbol)?.rwaNote : undefined;
  assert.equal(note("QNTB"), "premium:deferred");
  assert.equal(note("AMDB"), "premium:deferred");
  assert.equal(note("IBMB"), "premium:deferred");
  // Without the set the same rows run today's verdict path, which reads the dust premium: QNTB (+372) is refused, AMDB (-792) passes with a discount note.
  const fact = (symbol: string) => rows.find((row) => row.symbol === symbol)!.rwa;
  assert.deepEqual(rwaEntryVerdict(fact("QNTB"), NOW, { allowVenueMissing: true }), { kind: "refuse", reason: "premium-too-high" });
  assert.deepEqual(rwaEntryVerdict(fact("AMDB"), NOW, { allowVenueMissing: true }), { kind: "allow", note: "discount:7.9%" });
  const without = await screen(rows, { rfqOnly: undefined as unknown as ReadonlySet<string> });
  assert.equal(without.result.refusals.find((r) => symbolOf(rows, r.address) === "QNTB")?.reason, "premium-too-high", "the same pin without the set refuses QNTB on its dust premium");
});

test("a null ratio (PYPLB, COHRB, CRDOB before the data plane fill) or a null reference is refused premium-unknown; stale and closed issuers keep their reasons", async () => {
  const rows = await loadRfqUniverse(false);
  const facts = new Map<string, RwaFact>(rows.flatMap((row) => row.rwa === undefined ? [] : [[row.address.toLowerCase(), row.rwa] as const]));
  const change = (symbol: string, patch: Partial<RwaFact>) => { const row = rows.find((r) => r.symbol === symbol)!; facts.set(row.address.toLowerCase(), { ...row.rwa!, ...patch }); };
  change("KORUB", { referencePriceUsd: null }); change("ARMB", { staleness: "stale" }); change("NBISB", { openState: false });
  const { result } = await screen(rows, { rwaFacts: facts });
  assert.equal(result.kind, "selected");
  const reason = (symbol: string) => result.refusals.find((r) => symbolOf(rows, r.address) === symbol)?.reason;
  assert.deepEqual(["PYPLB", "COHRB", "CRDOB", "KORUB"].map(reason), ["premium-unknown", "premium-unknown", "premium-unknown", "premium-unknown"]);
  assert.equal(reason("ARMB"), "rwa-stale");
  assert.equal(reason("NBISB"), "issuer-not-trading");
  assert.equal(reason("AAPLB"), "premium-unknown", "a pooled row with a null ratio keeps today's refusal");
});

test("shortlist: the first 12 pooled plus every RFQ-only token in rank order; a cold cache uses 40 reads under the budget 24 + 26 (budget 24 would abort read-budget)", async () => {
  const rows = await loadRfqUniverse(true);
  const reads = { security: 0 };
  const { result, rfqOnly } = await screen(rows, {}, reads);
  assert.equal(result.kind, "selected");
  assert.equal(result.reads, 40, "2 token/eligibility batches + 12 pooled + 26 RFQ-only security reads");
  assert.equal(reads.security, 38);
  assert.equal(TRADE_SHORTLIST_MAX, 12);
  const pooled = result.kind === "selected" ? result.candidates.filter((c) => !rfqOnly.has(c.address.toLowerCase())) : [];
  const rfq = result.kind === "selected" ? result.candidates.filter((c) => rfqOnly.has(c.address.toLowerCase())) : [];
  assert.deepEqual([pooled.length, rfq.length], [12, 26]);
  assert.deepEqual(result.kind === "selected" ? result.candidates.map((c) => c.address) : [], [...pooled, ...rfq].map((c) => c.address), "pooled first, then RFQ-only, each in pin order");
  assert.ok(result.reads > TRADE_READ_BUDGET, "the extension is what lets this cycle finish");
  // Without the RFQ-only set the same cold call has a 12-slot shortlist and the base budget.
  const today = await screen(rows, { rfqOnly: undefined as unknown as ReadonlySet<string> });
  assert.equal(today.result.kind, "selected");
  assert.ok(today.result.kind === "selected" && today.result.candidates.length <= 12 && today.result.reads <= TRADE_READ_BUDGET);
});

test("an empty RFQ-only set changes nothing and keeps the budget at 24; a set with no member in the shortlist adds nothing", async () => {
  const rows = await loadRfqUniverse(true);
  const bare = await screen(rows, { rfqOnly: new Set<string>() });
  assert.equal(bare.result.kind, "selected");
  assert.ok(bare.result.reads <= TRADE_READ_BUDGET);
  const pooledOnly = rows.filter((row) => admittedVenueRows(row.venues).length > 0);
  const { result } = await screen(pooledOnly, { rfqOnly: new Set<string>() });
  assert.equal(result.kind === "selected" ? result.candidates.length : -1, 12);
});
