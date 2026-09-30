import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { keccak256, stringToBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { assessFiniteJournalHistory, deriveFiniteCloseoutState, deriveFiniteState, FINITE_STAGES,
  finiteIntendedMatchesStage, finiteJournalHistoryValid,
  type FiniteAction, type FiniteCheck } from "../src/quant/rebalanceFinite.js";
import { G2_FINITE_CAPABILITY_ID, G2_FINITE_MAX_GAS_PRICE_WEI,
  G2_FINITE_NATIVE_DAY_CAP_WEI, G2_FILE_HIGH_TIER, REBALANCE_TOKEN_ADDRESSES,
  finitePairedSellRequiredNativeWei, rebalancePolicyDigest, rebalancePolicyProjection, rebalanceTierForProfile } from "../src/quant/rebalancePolicy.js";
import { G2_FINITE_JOB, g2JobForFile, g2SessionSpec, loadG2FileProfiles } from "../src/quant/rebalanceSelftest.js";
import { serializeGrantedSession } from "../src/quant/selftest.js";
import { parseSessionPlaintext } from "../src/quant/admission.js";
import { admitRebalanceSession } from "../src/quant/rebalanceAdmission.js";
import { finiteExpiryWitnessValid, previewG2Worker, protectedG2PortfolioRead,
  verifyFiniteReceiptOwnership } from "../scripts/live-quant-rebalance.js";
import { reportFiniteEndedJobOnce, type QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import type { QuantRebalanceActionRow, QuantRebalanceCheckRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";
import type { SqlClient } from "../src/store/sql.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { G2GrantClaim } from "../src/quant/rebalanceSelftest.js";
import { checkQuantMeters } from "../src/quant/execute.js";
import type { WalletProvider } from "../src/core/types.js";
import { buildQuantRebalanceReportPayload } from "../src/quant/rebalanceReporting.js";
import type { ExecutionJournal } from "../src/store/journal.js";

const hash = (seed: string): Hex => keccak256(stringToBytes(seed));
const checks: FiniteCheck[] = [
  { checkId: "bootstrap", kind: "bootstrap", slot: 0 },
  ...Array.from({ length: 6 }, (_, index) => ({ checkId: `scheduled-${index}`,
    kind: "scheduled" as const, slot: index + 1 })),
];

function action(stage: number, state: FiniteAction["state"] = "settled", sequence = stage + 1): FiniteAction {
  const expected = FINITE_STAGES[stage]!;
  const forward = expected.asset === "CAKE"
    ? [REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES.WBNB, REBALANCE_TOKEN_ADDRESSES.CAKE]
    : [REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES[expected.asset]];
  const amountInWei = expected.side === "sell" ? 40n : 100n;
  return { checkId: stage < 3 ? "bootstrap" : `scheduled-${stage - 3}`, sequence: BigInt(sequence),
    side: expected.side, asset: expected.asset, path: expected.side === "buy" ? forward : [...forward].reverse(),
    state, amountInWei, preSubmitBlockNumber: state === "aborted" ? null : 1n,
    preSubmitBlockHash: state === "aborted" ? null : hash("presubmit"),
    txHash: state === "aborted" ? null : hash(`tx-${sequence}`),
    proofDigest: state === "settled" ? hash(`proof-${sequence}`) : null,
    fillInWei: state === "settled" ? amountInWei : null,
    fillOutWei: state === "settled" ? 200n : null, ambiguousCause: null,
    resolutionJson: state === "aborted" ? JSON.stringify({ recovery: "pre-submit-no-provider-entry",
      journalState: "absent", reasonCode: "price-moved" }) : null };
}

test("finite policy is exact high-75 only and leaves v1 projection unchanged", () => {
  assert.equal(rebalanceTierForProfile(75n * 10n ** 18n, G2_FINITE_CAPABILITY_ID).ok, true);
  assert.equal(rebalanceTierForProfile(30n * 10n ** 18n, G2_FINITE_CAPABILITY_ID).ok, false);
  const finite = rebalancePolicyProjection(G2_FINITE_CAPABILITY_ID);
  assert.equal(finite.finiteSchedule?.stageOrder.length, 9);
  assert.equal(finite.finiteSchedule?.submissionOuterCeiling, 30);
  assert.equal(finite.finiteSchedule?.nativeDayCapWei, G2_FINITE_NATIVE_DAY_CAP_WEI);
  assert.equal(finite.maxGasPriceWei, G2_FINITE_MAX_GAS_PRICE_WEI);
  assert.equal(rebalancePolicyProjection(null).finiteSchedule, undefined);
  assert.notEqual(rebalancePolicyDigest(G2_FINITE_CAPABILITY_ID), rebalancePolicyDigest(null));
});

test("finite file identity and grant cap are disjoint from the old high-75 profile", () => {
  assert.equal(g2JobForFile(G2_FINITE_JOB.file).mapping.job, G2_FINITE_JOB.job);
  assert.equal(loadG2FileProfiles(true).capability.id, G2_FINITE_CAPABILITY_ID);
  const spec = g2SessionSpec({ allocation: 75, finite: true,
    riskCaps: { WBNB: 1n, ETH: 1n, CAKE: 1n }, verifiedPreGrantPaymentMaxWei: null,
    expiresAt: 2_000_000_000, nowSeconds: 1_999_800_000,
    wallet: "0x000000000000000000000000000000000000dEaD" });
  assert.equal(spec.spendCaps.find((cap) => cap.token === undefined)?.limit, G2_FINITE_NATIVE_DAY_CAP_WEI);
});

test("finite admission binds exact native day cap, identity and ten-minute tail", () => {
  const nowMs = 1_999_800_000_000;
  const startedAtMs = nowMs;
  const endsAtMs = startedAtMs + 2 * 86_400_000;
  const expiresAt = endsAtMs / 1_000 + 600;
  const wallet = "0x000000000000000000000000000000000000dEaD" as const;
  const spec = g2SessionSpec({ allocation: 75, finite: true,
    riskCaps: { WBNB: 1n, ETH: 1n, CAKE: 1n }, verifiedPreGrantPaymentMaxWei: null,
    expiresAt, nowSeconds: nowMs / 1_000, wallet });
  const permissions = { calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
    ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
    spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
      limit: cap.limit, period: cap.period })) };
  const key = generatePrivateKey();
  const session = parseSessionPlaintext(serializeGrantedSession({ walletAddress: wallet,
    publicKey: privateKeyToAccount(key).publicKey, expiry: expiresAt, permissions, privateKey: key }));
  assert.equal(session.ok, true);
  if (!session.ok) return;
  const job = { id: G2_FINITE_JOB.job, status: "ACTIVE", strategyId: "self-test-rebalance-g2",
    tradingWalletAddress: wallet, allocationUWei: 75n * 10n ** 18n,
    dailyCapUWei: 150n * 10n ** 18n, termDays: 2, startedAtMs, endsAtMs,
    sessionExpiresAtMs: expiresAt * 1_000, revokedAtMs: null } as const;
  const profile = loadG2FileProfiles(true).capability;
  const accepted = admitRebalanceSession({ session: session.session, job, capabilityProfile: profile, nowMs });
  assert.equal(accepted.ok, true);
  assert.equal(admitRebalanceSession({ session: session.session, job: { ...job, id: "wrong-job" },
    capabilityProfile: profile, nowMs }).ok, false);
  assert.equal(admitRebalanceSession({ session: session.session, job: { ...job, sessionExpiresAtMs: job.sessionExpiresAtMs + 1_000 },
    capabilityProfile: profile, nowMs }).ok, false);
  const moreAuthority = { ...session.session, permissions: { ...session.session.permissions,
    spend: session.session.permissions.spend.map((cap) => cap.token === undefined
      ? { ...cap, limit: G2_FINITE_NATIVE_DAY_CAP_WEI + 1n } : cap) } };
  assert.equal(admitRebalanceSession({ session: moreAuthority, job,
    capabilityProfile: profile, nowMs }).ok, false);
});

test("finite stage proof requires all nine ordered settled actions in seven checks", () => {
  const rows = FINITE_STAGES.map((_, index) => action(index));
  for (let count = 0; count < rows.length; count += 1) {
    const state = deriveFiniteState(rows.slice(0, count), checks);
    assert.equal(state.kind, "ready");
    if (state.kind === "ready") assert.equal(state.stage, count);
  }
  const completed = deriveFiniteState(rows, checks);
  assert.equal(completed.kind, "complete");
  if (completed.kind === "complete") assert.equal(completed.managed.USDC, 75n * 10n ** 18n - 3n * 100n - 3n * 100n + 3n * 200n);
  assert.equal(deriveFiniteState([rows[1]!, rows[0]!], checks).kind, "ready");
  assert.equal(deriveFiniteState([rows[0]!, rows[2]!], checks).kind, "stop");
  assert.equal(deriveFiniteState(rows, checks.slice(0, -1)).kind, "stop");
  assert.equal(deriveFiniteState(rows, [...checks.slice(0, 6), { ...checks[6]!, slot: 5 }]).kind, "stop");
});

test("finite retry is durable, proven no-send only, and submitted failure poisons", () => {
  const first = action(0, "aborted", 1);
  const second = action(0, "aborted", 2);
  const retry = deriveFiniteState([first, second], checks);
  assert.equal(retry.kind, "ready");
  if (retry.kind === "ready") assert.equal(retry.aborted, 2);
  assert.equal(deriveFiniteState([first, second, action(0, "aborted", 3)], checks).kind, "stop");
  assert.equal(deriveFiniteState([{ ...first, preSubmitBlockNumber: 1n }], checks).kind, "stop");
  assert.equal(deriveFiniteState([{ ...first, txHash: hash("ambiguous") }], checks).kind, "stop");
  assert.equal(deriveFiniteState([action(0, "failed")], checks).kind, "stop");
  assert.equal(deriveFiniteState([action(0, "unknown")], checks).kind, "stop");
  assert.equal(deriveFiniteState([{ ...action(0), ambiguousCause: "relay-timeout" }], checks).kind, "stop");
  assert.equal(deriveFiniteState([{ ...action(0), ambiguousCause: "receipt-unverified" }], checks).kind, "ready");
  assert.equal(deriveFiniteState([action(0, "settled"), action(1, "settled", 1)], checks).kind, "stop");
});

test("finite buy-back cannot exceed verified sell proceeds", () => {
  const rows = FINITE_STAGES.map((_, index) => action(index));
  rows[4] = { ...rows[4]!, amountInWei: 201n, fillInWei: 201n };
  assert.equal(deriveFiniteState(rows, checks).kind, "stop");
  rows[4] = action(4);
  rows[3] = { ...rows[3]!, amountInWei: 100n, fillInWei: 100n };
  assert.equal(deriveFiniteState(rows, checks).kind, "stop");
});

test("finite current intent cannot change a sell clip or rebuy proceeds at submit boundary", () => {
  const sellState = deriveFiniteState(FINITE_STAGES.slice(0, 3).map((_, index) => action(index)), checks);
  assert.equal(sellState.kind, "ready");
  if (sellState.kind !== "ready") return;
  assert.equal(finiteIntendedMatchesStage(sellState, action(3)), true);
  assert.equal(finiteIntendedMatchesStage(sellState, { ...action(3), amountInWei: 41n }), false);
  const buyState = deriveFiniteState(FINITE_STAGES.slice(0, 4).map((_, index) => action(index)), checks);
  assert.equal(buyState.kind, "ready");
  if (buyState.kind !== "ready") return;
  assert.equal(finiteIntendedMatchesStage(buyState, { ...action(4), amountInWei: 200n }), true);
  assert.equal(finiteIntendedMatchesStage(buyState, action(4)), false);
});

test("operator-only finite helper targets only v2 and previews before a live cycle", (t) => {
  // The helper is an operator-only live loop kept out of git (scripts/tmp is ignored).
  const helper = new URL("../scripts/tmp/g2-high75-finite-loop.cmd", import.meta.url);
  if (!existsSync(helper)) { t.skip("scripts/tmp/g2-high75-finite-loop.cmd is operator-local and absent in this checkout"); return; }
  const script = readFileSync(helper, "utf8");
  const command = "node --env-file=.env.rebalance-g2.local --import tsx scripts/live-quant-rebalance.ts worker";
  const lines = script.split(/\r?\n/u).filter((line) => line.startsWith(command));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.includes("--yes-live"), false);
  assert.equal(lines[1]?.includes("--yes-live"), true);
  assert.ok(lines.every((line) => line.includes(G2_FINITE_JOB.file.replaceAll("/", "\\"))
    || line.includes(G2_FINITE_JOB.file)));
  assert.ok(!script.includes("quant-rebalance-g2-high75.json"));
  assert.ok(!script.includes("g2-clear.cmd"));
  assert.ok(script.includes('set "QUANT_G2_HIGH75_FINITE_OWNER_KEY="'));
  assert.ok(script.includes("term-end-closeout"));
  assert.ok(script.includes("submissionStop"));
});

test("finite preview cannot call broken balance evidence routes-complete", async () => {
  const rows = FINITE_STAGES.map((_, index) => ({ ...action(index), actionId: `action-${index}` })) as
    unknown as QuantRebalanceActionRow[];
  const doneChecks = checks.map((check) => ({ ...check, state: "done",
    takenAssets: check.kind === "bootstrap" ? ["WBNB", "ETH", "CAKE"]
      : [FINITE_STAGES[check.slot + 2]!.asset] })) as unknown as QuantRebalanceCheckRow[];
  const job = { jobId: G2_FINITE_JOB.job, allocationWei: 75n * 10n ** 18n,
    startedAtMs: 1_000, endsAtMs: 1_000_000, bootstrapComplete: true,
    managed: { USDC: 75n * 10n ** 18n, WBNB: 360n, ETH: 360n, CAKE: 360n },
    protectedBaselineJson: null, nextEligibleSlot: 7 } as unknown as QuantRebalanceJobRow;
  const deps = { capabilityProfile: loadG2FileProfiles(true).capability, nowMs: () => 500_000,
    readPortfolio: async () => ({ ok: false as const, code: "external-activity" }) } as unknown as QuantRebalanceWorkerDeps;
  const output = await previewG2Worker({ jobId: job.jobId, job, actions: rows, allocation: 75,
    finite: true, finiteJournalValid: true, finiteOwnershipValid: true,
    deps, listChecks: async () => doneChecks, nowMs: 500_000 });
  assert.equal(output["submissionStop"], "finite-portfolio-unverified");
});

test("finite receipt ownership must match each settled swap log", async () => {
  const wallet = "0x000000000000000000000000000000000000dEaD" as const;
  const settled = { ...action(0), journalKey: "finite-0", pairAddresses: [wallet],
    swapLogIndices: [3n] } as unknown as QuantRebalanceActionRow;
  const job = { tradingWallet: wallet } as unknown as QuantRebalanceJobRow;
  const ownership = { tx_hash: settled.txHash!.toLowerCase(), trading_wallet: wallet.toLowerCase(),
    swap_log_index: "3", journal_key: "finite-0" };
  const sql = (rows: readonly Record<string, unknown>[]) => ({ query: async () => ({ rows }) }) as unknown as SqlClient;
  assert.equal(await verifyFiniteReceiptOwnership(sql([ownership]), job, [settled]), true);
  assert.equal(await verifyFiniteReceiptOwnership(sql([]), job, [settled]), false);
  assert.equal(await verifyFiniteReceiptOwnership(sql([{ ...ownership, journal_key: "wrong" }]), job, [settled]), false);
});

test("preview and live protected portfolio wrapper rejects U or native baseline loss", async () => {
  const wallet = "0x000000000000000000000000000000000000dEaD" as const;
  const job = { tradingWallet: wallet } as unknown as QuantRebalanceJobRow;
  const claim = { protectedBaseline: { BNB: "9", U: "5" } } as G2GrantClaim;
  let nativeBalanceWei = 10n;
  let protectedU = 5n;
  const base = { readPortfolio: async () => ({ ok: true as const, observation: {
    nativeBalanceWei, blockHash: hash("block") } }) } as unknown as QuantRebalanceWorkerDeps;
  const reader = { tokenBalanceAtHash: async () => protectedU } as unknown as QuantChainReader;
  const guarded = protectedG2PortfolioRead(base, reader, claim);
  assert.equal((await guarded({ job, tier: G2_FILE_HIGH_TIER, nowMs: 0 })).ok, true);
  protectedU = 4n;
  assert.equal((await guarded({ job, tier: G2_FILE_HIGH_TIER, nowMs: 0 })).ok, false);
  protectedU = 5n; nativeBalanceWei = 8n;
  assert.equal((await guarded({ job, tier: G2_FILE_HIGH_TIER, nowMs: 0 })).ok, false);
});

test("finite paired-sell reserve and native meter have exact one-wei fences", async () => {
  const direct = finitePairedSellRequiredNativeWei({ sellOwnSolvencyWei: 67_500_000_000_000n,
    routeLength: 2, gasPriceWei: G2_FINITE_MAX_GAS_PRICE_WEI, maximumExitGasUnits: 600_000n });
  assert.equal(direct, 495_000_000_000_000n);
  const twoHop = finitePairedSellRequiredNativeWei({ sellOwnSolvencyWei: 135_000_000_000_000n,
    routeLength: 3, gasPriceWei: G2_FINITE_MAX_GAS_PRICE_WEI, maximumExitGasUnits: 600_000n });
  assert.equal(twoHop, 630_000_000_000_000n);
  assert.throws(() => finitePairedSellRequiredNativeWei({ sellOwnSolvencyWei: 1n, routeLength: 2,
    gasPriceWei: G2_FINITE_MAX_GAS_PRICE_WEI + 1n, maximumExitGasUnits: 600_000n }));
  const wallet = "0x000000000000000000000000000000000000dEaD" as const;
  const publicKey = `0x04${"11".repeat(64)}` as Hex;
  const provider = (remaining: bigint) => ({ readSpendInfos: async () => [
    { token: null, period: "day", limitWei: G2_FINITE_NATIVE_DAY_CAP_WEI,
      currentSpentWei: G2_FINITE_NATIVE_DAY_CAP_WEI - remaining },
    { token: REBALANCE_TOKEN_ADDRESSES.WBNB, period: "day", limitWei: 1_000n, currentSpentWei: 0n },
  ] }) as unknown as WalletProvider;
  const input = { walletAddress: wallet, publicKey, tokenIn: REBALANCE_TOKEN_ADDRESSES.WBNB,
    amountInWei: 1n, requiredNativeWei: direct };
  assert.equal((await checkQuantMeters({ ...input, provider: provider(direct) })).ok, true);
  assert.equal((await checkQuantMeters({ ...input, provider: provider(direct - 1n) })).ok, false);
});

test("finite closeout accepts only a validated terminal poisoned prefix", () => {
  const bootstrap = FINITE_STAGES.slice(0, 3).map((_, index) => ({ ...action(index),
    actionId: `bootstrap-${index}`, journalKey: `journal-${index}` })) as unknown as QuantRebalanceActionRow[];
  const failed = { ...action(3, "failed"), actionId: "failed-3", journalKey: "journal-failed",
    failureCode: "submitted-failed-proven", resolutionJson: null } as unknown as QuantRebalanceActionRow;
  assert.equal(deriveFiniteCloseoutState([...bootstrap, failed], checks).kind, "incomplete");
  assert.equal(deriveFiniteCloseoutState([...bootstrap, { ...failed, txHash: null }], checks).kind, "invalid");
  const noSend = [4, 5, 6].map((sequence) => ({ ...action(3, "aborted", sequence),
    actionId: `aborted-${sequence}`, journalKey: `journal-${sequence}`,
    failureCode: null })) as unknown as QuantRebalanceActionRow[];
  assert.equal(deriveFiniteCloseoutState([...bootstrap, ...noSend], checks).kind, "incomplete");
  assert.equal(deriveFiniteCloseoutState([...bootstrap, ...noSend.slice(0, 2),
    { ...noSend[2]!, resolutionJson: "not-executed" }], checks).kind, "invalid");
  const unknownSettled = { ...action(3), actionId: "unknown-settled", journalKey: "journal-unknown",
    ambiguousCause: "relay-timeout", failureCode: null, resolutionJson: null } as unknown as QuantRebalanceActionRow;
  assert.equal(deriveFiniteCloseoutState([...bootstrap, unknownSettled], checks).kind, "incomplete");
  assert.equal(deriveFiniteCloseoutState([...bootstrap, unknownSettled,
    { ...action(4, "aborted", 5), actionId: "late", journalKey: "journal-late" } as QuantRebalanceActionRow], checks).kind, "invalid");
});

test("a crash-lost action UNKNOWN is still poisoned by durable journal resolution", async () => {
  const first = { ...action(0), actionId: "first", journalKey: "journal-first" } as unknown as QuantRebalanceActionRow;
  const second = { ...action(1, "settled", 2), actionId: "second", journalKey: "journal-second" } as unknown as QuantRebalanceActionRow;
  const journal = { get: async (key: string) => ({ state: "COMMITTED", externalRef: {
    txHash: key === first.journalKey ? first.txHash : second.txHash,
    ...(key === first.journalKey ? { resolution: { action: "resolveUnknown",
      disposition: "receipt-proof-verified", checks: [{ name: "quant-rebalance-receipt", result: first.actionId }] } } : {}),
  } }) } as unknown as ExecutionJournal;
  const assessment = await assessFiniteJournalHistory([first], journal);
  assert.equal(assessment.valid, true);
  assert.equal(assessment.recoveredUnknownActionIds.has(first.actionId), true);
  assert.equal(await finiteJournalHistoryValid([first], journal), false);
  assert.equal(deriveFiniteCloseoutState([first], checks, assessment.recoveredUnknownActionIds).kind, "incomplete");
  assert.equal(deriveFiniteCloseoutState([first, second], checks, assessment.recoveredUnknownActionIds).kind, "invalid");
});

test("real no-provider-entry recovery evidence binds the journal state", async () => {
  const aborted = { ...action(0, "aborted"), actionId: "aborted", journalKey: "journal-aborted",
    resolutionJson: JSON.stringify({ recovery: "pre-submit-no-provider-entry",
      journalState: "PENDING", reasonCode: "price-moved" }) } as unknown as QuantRebalanceActionRow;
  const rolledBack = { get: async () => ({ state: "ROLLED_BACK", externalRef: {} }) } as unknown as ExecutionJournal;
  const absent = { get: async () => null } as unknown as ExecutionJournal;
  assert.equal((await assessFiniteJournalHistory([aborted], rolledBack)).valid, true);
  assert.equal((await assessFiniteJournalHistory([aborted], absent)).valid, false);
  assert.equal(deriveFiniteState([aborted], checks).kind, "ready");
});

test("INCOMPLETE closeout cannot report before session expiry", async () => {
  const bootstrap = FINITE_STAGES.slice(0, 3).map((_, index) => ({ ...action(index),
    actionId: `bootstrap-${index}`, journalKey: `journal-bootstrap-${index}` })) as unknown as QuantRebalanceActionRow[];
  const noSend = [4, 5, 6].map((sequence) => ({ ...action(3, "aborted", sequence),
    actionId: `aborted-${sequence}`, journalKey: `journal-aborted-${sequence}`,
    failureCode: null })) as unknown as QuantRebalanceActionRow[];
  const rows = [...bootstrap, ...noSend];
  assert.equal(buildQuantRebalanceReportPayload(rows).trades.length, 3);
  const history = deriveFiniteCloseoutState(rows, checks);
  assert.equal(history.kind, "incomplete");
  if (history.kind !== "incomplete") return;
  const job = { jobId: G2_FINITE_JOB.job, status: "ended", reportedAtMs: null,
    sessionExpiresAtMs: 1_000, managed: history.managed } as unknown as QuantRebalanceJobRow;
  let reports = 0;
  const deps = { capabilityProfile: loadG2FileProfiles(true).capability, nowMs: () => 999,
    store: { getJob: async () => job, listActions: async () => rows, listChecks: async () => checks },
    journal: { get: async (key: string) => {
      const row = bootstrap.find((item) => item.journalKey === key);
      return row === undefined ? null : { state: "COMMITTED", externalRef: { txHash: row.txHash } };
    } }, verifyFiniteOwnership: async () => true,
    reportJob: async () => { reports += 1; throw new Error("must-not-report"); } } as unknown as QuantRebalanceWorkerDeps;
  await assert.rejects(() => reportFiniteEndedJobOnce(deps, job.jobId), /finite-incomplete-before-expiry/u);
  assert.equal(reports, 0);
});

test("INCOMPLETE expiry needs the same finalized block and invalid exact KeyStore key", () => {
  const wallet = "0x000000000000000000000000000000000000dEaD" as const;
  const job = { tradingWallet: wallet, sessionExpiresAtMs: 1_000_000 } as unknown as QuantRebalanceJobRow;
  const claim = { wallet, expirySec: 1_000 } as unknown as G2GrantClaim;
  const blockHash = hash("finalized");
  const base = { job, claim, finalizedTimestampSec: 1_000n,
    finalizedHash: blockHash, canonicalHash: blockHash, keyValid: false };
  assert.equal(finiteExpiryWitnessValid(base), true);
  assert.equal(finiteExpiryWitnessValid({ ...base, finalizedTimestampSec: 999n }), false);
  assert.equal(finiteExpiryWitnessValid({ ...base, canonicalHash: hash("fork") }), false);
  assert.equal(finiteExpiryWitnessValid({ ...base, keyValid: true }), false);
});
