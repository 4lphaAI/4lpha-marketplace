/** Independent post-repair tests. Existing auditor files remain unchanged. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryQuantRebalanceStore } from "../src/store/quantRebalance.js";
import { MemoryQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { submitQuantRebalanceAction } from "../src/quant/execute.js";
import { buildRebalanceCalls } from "../src/quant/rebalanceRoutes.js";
import { E18, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import { HttpQuantTransport } from "../src/quant/termix.js";
import { expandedConfigVenueTargets, findExpandedConfigProfile, normalizeExpandedQuantConfig,
  QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES,
  type QuantExpandedConfigProfile } from "../src/quant/rebalanceConfig.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import type { QuantKeypair } from "../src/quant/envelope.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";

const HASH = `0x${"67".repeat(32)}` as Hex;
const WALLET = getAddress(`0x${"45".repeat(20)}`);
const NOW = 1_800_000_000_000;

async function staleSenderFixture() {
  const journal = new MemoryExecutionJournal(() => NOW);
  const claims = new MemoryQuantWalletClaimStore({ noAction: async () => true, terminalAndNoUnresolved: async () => false }, true);
  const store = new MemoryQuantRebalanceStore(claims, async (key) => {
    const row = await journal.get(key);
    return row === null ? null : { state: row.state, hasCallsId: row.externalRef.callsId !== undefined, txHash: row.externalRef.txHash ?? null };
  });
  const wire: QuantJobRecord = { id: "fix-review", strategyId: "fix-review", status: "ACTIVE", tradingWalletAddress: WALLET,
    allocationUWei: 10n * E18, dailyCapUWei: 20n * E18, termDays: 30, startedAtMs: NOW - 1_000,
    endsAtMs: NOW + 86_400_000, sessionExpiresAtMs: NOW + 86_400_000, revokedAtMs: null };
  const row = await store.discoverJob({ wire: { ...wire, envelope: null, wireDigest: HASH }, envelopeJson: null, envelopeId: null, nowMs: NOW });
  const attempt = { wallet: WALLET, strategyKind: "rebalance" as const, strategyId: wire.strategyId,
    jobId: wire.id, attemptId: "attempt", nowMs: NOW };
  const claim = await claims.claimProvisional(attempt); assert.equal(claim.kind, "acquired");
  if (claim.kind !== "acquired") throw new Error("fixture-claim");
  const promoted = await claims.promoteProvisional({ ...attempt, generation: claim.claim.generation }, async () => {
    const admitted = await store.admit({ jobId: wire.id, expectedRowVersion: row.rowVersion, attemptId: attempt.attemptId,
      claimGeneration: claim.claim.generation, policyJson: "{}", policyDigest: HASH, tier: "low",
      sessionPublicKey: `0x${"11".repeat(65)}`, sessionExpirySec: Math.floor(wire.sessionExpiresAtMs! / 1000),
      permissionsDigest: HASH, projectionDigest: HASH, descriptorJson: "{}", projectionJson: "{}", capRowsJson: "[]",
      baselineBlock: 1n, baselineHash: HASH, baselineAtMs: NOW,
      actualBaseline: { USDC: wire.allocationUWei, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
      protectedBaseline: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }, nowMs: NOW });
    return admitted.kind === "ok" ? admitted.record : null;
  });
  assert(promoted.value); const job = promoted.value;
  const check = (await store.listChecks(job.jobId))[0]!;
  const deadlineSec = Math.floor(NOW / 1000) + 600;
  const built = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: [REBALANCE_USDC, REBALANCE_WBNB],
    amountInWei: E18, quoteOutWei: E18, recipient: WALLET, deadlineSec, actionSequence: 1n });
  const inserted = await store.insertAction({ jobId: job.jobId, checkId: check.checkId, sequence: 1n,
    side: "buy", asset: "WBNB", tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB,
    path: [REBALANCE_USDC, REBALANCE_WBNB], pairAddresses: [WALLET], amountInWei: E18,
    quoteOutWei: E18, minOutWei: built.minOutWei, deadlineSec, callsJson: JSON.stringify(built.calls), callsDigest: HASH,
    policyDigest: HASH, permissionsDigest: HASH, projectionDigest: HASH, claimGeneration: job.claimGeneration!,
    quoteBlockNumber: 2n, quoteBlockHash: HASH, quoteObservedAtMs: NOW,
    referenceBlockNumber: 2n, referenceBlockHash: HASH, referenceObservedAtMs: NOW,
    referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
    expectedJobRevision: job.accountingRev, expectedCheckVersion: check.rowVersion, nowMs: NOW });
  assert.equal(inserted.kind, "ok"); if (inserted.kind !== "ok") throw new Error("fixture-action");
  return { store, journal, job: (await store.getJob(job.jobId))!, action: inserted.record, calls: built.calls };
}

test("fix audit: delayed lost-lease sender cannot recreate journal ambiguity after intended recovery", async () => {
  const f = await staleSenderFixture();
  const recovered = await f.store.abortIntendedAction({ actionId: f.action.actionId,
    expectedRowVersion: f.action.rowVersion, expectedJournalState: "absent", nowMs: NOW });
  assert.equal(recovered.kind, "ok");
  assert.equal((await f.store.getAction(f.action.actionId))?.state, "aborted");
  const controller = new AbortController(); controller.abort();
  await submitQuantRebalanceAction({ store: f.store, journal: f.journal,
    provider: {} as WalletProvider, reader: {} as QuantChainReader, keypair: {} as QuantKeypair,
    nowMs: () => NOW, signal: controller.signal, revalidatePlan: async () => true, readCurrentWire: async () => null },
  { job: f.job, action: f.action, calls: f.calls, requiredNativeWei: 1n });
  assert.equal((await f.store.getAction(f.action.actionId))?.state, "aborted");
  assert.equal(await f.journal.get(f.action.journalKey), null);
});

async function transported(raw: unknown) {
  let fetchCount = 0;
  const transport = new HttpQuantTransport({ baseUrl: "https://platform-backend.prod.termix.live", apiKey: "offline-placeholder",
    fetchImpl: async () => { fetchCount += 1; return new Response(JSON.stringify(raw), { headers: { "content-type": "application/json" } }); } });
  const result = await transport.config(); assert.equal(fetchCount, 1);
  return result;
}

test("fix audit: HTTP config adapter preserves exact aliases and refuses all row-field/multiplicity mutations", async () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/quant/contracts-customization-quant.json", import.meta.url), "utf8")) as {
    quant: { venueAllowlist: Record<string, unknown>[]; tradableTokens: Record<string, unknown>[] };
  };
  const response = await transported(raw); assert(response.ok);
  const normalized = normalizeExpandedQuantConfig(response.data); assert(normalized.ok);
  const profile: QuantExpandedConfigProfile = { id: "offline-alias-review", capturedEvidenceRef: "offline fixture",
    capturedEvidenceDigest: HASH, expected: normalized.projection, expectedVenueRowCount: 14, expectedUniqueVenueTargetCount: 12 };
  assert.equal(expandedConfigVenueTargets(normalized.projection, profile)?.length, 12);
  assert.equal(findExpandedConfigProfile(normalized.projection)?.id, "termix-quant-config-2026-09-27-v1");
  const { assertProductionRebalanceProfiles } = await import("../src/quant/rebalanceConfig.js");
  assert.deepEqual(QUANT_EXPANDED_CONFIG_PROFILES.map((entry) => entry.id), ["termix-quant-config-2026-09-27-v1"]);
  assert.deepEqual(QUANT_REBALANCE_CAPABILITY_PROFILES.map((entry) => entry.id), ["termix-rebalance-wizard-v1"]);
  assertProductionRebalanceProfiles(QUANT_EXPANDED_CONFIG_PROFILES[0]!, QUANT_REBALANCE_CAPABILITY_PROFILES[0]!);
  const mutations: Array<(rows: Record<string, unknown>[]) => void> = [
    (rows) => { rows[0]!.label = "changed"; }, (rows) => { rows[0]!.kind = "changed"; },
    (rows) => { rows[0]!.protocol = null; }, (rows) => { rows[0]!.verified = false; },
    (rows) => { rows[0]!.auditUrl = null; }, (rows) => { rows[0]!.officialUrl = null; },
    (rows) => { rows[0]!.address = WALLET; }, (rows) => { rows.push({ ...rows[1]! }); },
    (rows) => { rows.splice(rows.findIndex((row) => row.label === "vUSDC"), 1); },
    (rows) => { rows.find((row) => row.label === "vBTC")!.address = REBALANCE_USDC; },
    (rows) => { delete rows[0]!.verified; }, (rows) => { rows[0]!.extra = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(raw); mutate(changed.quant.venueAllowlist);
    const parsed = await transported(changed);
    if (!parsed.ok) continue;
    const projection = normalizeExpandedQuantConfig(parsed.data);
    if (!projection.ok) continue;
    assert.equal(findExpandedConfigProfile(projection.projection, [profile]), null);
  }
});
