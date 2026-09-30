import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import { parseConfigBlock } from "../src/quant/termix.js";
import { parseSessionPlaintext, permissionsDigest, specDigest } from "../src/quant/admission.js";
import { admitRebalanceSession } from "../src/quant/rebalanceAdmission.js";
import { claimSelfTestFile, FileQuantTransport, serializeGrantedSession, writeSelfTestFile } from "../src/quant/selftest.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { QUANT_ENVELOPE_ALGORITHM, seal } from "../src/quant/envelope.js";
import { findCapabilityProfile, findExpandedConfigProfile, normalizeExpandedQuantConfig, QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES, resolveQuantRebalancingEnabled } from "../src/quant/rebalanceConfig.js";
import { G2_FILE_CAPABILITY_ID, G2_FILE_HIGH_TIER, G2_FILE_LOW_TIER, HIGH_TIER, LOW_TIER, g2PaymentWithinBudget, rebalancePolicyDigest, rebalanceTierForProfile, requiredNativeReserve } from "../src/quant/rebalancePolicy.js";
import { planRebalanceLeg } from "../src/quant/rebalancePortfolio.js";
import { g2PreSubmitRefusalField, previewG2Worker, readG2AccountKeys } from "../scripts/live-quant-rebalance.js";
import { buildQuantRebalanceWorkerDeps, type RebalanceRevalidationRefusal } from "../scripts/quantRebalanceWorkerDeps.js";
import { encodeLpFinalCallsV1 } from "../src/lp/preparedIntentWitness.js";
import { QUANT_ORCHESTRATOR_56 } from "../src/quant/receipt.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import type { QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import { runQuantRebalanceWorkerOnce, quantRebalanceImmutableWireDigest } from "../src/quant/rebalanceWorker.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";
import { MemoryQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { MemoryQuantRebalanceStore } from "../src/store/quantRebalance.js";
import type { ExecutionJournal } from "../src/store/journal.js";
import type { WalletProvider } from "../src/core/types.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import { brandVerifiedReceiptProof } from "../src/store/quantRebalanceProof.js";
import { buildQuantRebalanceReportPayload } from "../src/quant/rebalanceReporting.js";
import { rebalanceCanonicalEncode } from "../src/quant/rebalanceCanonical.js";
import { parseQuantRebalanceOperatorArgs } from "../src/quant/rebalanceOperatorCli.js";
import { closeG2GrantClaim, createG2GrantClaim, G2_CAPTURE_SHA256, G2_FINITE_JOB, G2_JOBS, g2ClaimPath, g2ProposedFileDigest, g2RiskCap, g2SessionSpec, g2SubmissionVerdict, loadG2FileProfiles, publishG2ReadyClaim, publishG2GrantedOutput, readG2GrantClaim, readG2ReadyFile, selectG2OwnerKey, type G2GrantClaim, type G2File } from "../src/quant/rebalanceSelftest.js";

test("G2 grant census accepts only an empty finalized virgin EOA", async () => {
  const hash = `0x${"ab".repeat(32)}` as Hex;
  const keyId = `0x${"cd".repeat(32)}` as Hex;
  let accountReads = 0;
  const input = (code: unknown, registered: readonly Hex[] = [], blockHash = hash) => ({
    readCode: async () => code,
    readRegistered: async () => registered,
    readAccount: async (): Promise<readonly [readonly { readonly publicKey: Hex; readonly isSuperAdmin: boolean; readonly expiry: number }[], readonly Hex[]]> => {
      accountReads += 1;
      return [[{ publicKey: keyId, isSuperAdmin: true, expiry: 1 }], [keyId]];
    },
    readBlockHash: async () => blockHash,
    finalizedHash: hash,
  });
  assert.deepEqual(await readG2AccountKeys(input("0x")), { accountKeys: [], accountHashes: [], registered: [], virgin: true });
  assert.equal(accountReads, 0);
  await assert.rejects(readG2AccountKeys(input("0x", [keyId])), /g2-virgin-keystore-nonempty/u);
  assert.equal(accountReads, 0);
  for (const code of [undefined, null, "0x0", "0xzz"] as const) {
    await assert.rejects(readG2AccountKeys(input(code)), /g2-account-code-unavailable/u);
  }
  await assert.rejects(readG2AccountKeys({ ...input("0x"), readCode: async () => { throw new Error("code-rpc-failed"); } }), /code-rpc-failed/u);
  await assert.rejects(readG2AccountKeys({ ...input("0x"), readRegistered: async () => { throw new Error("registry-rpc-failed"); } }), /registry-rpc-failed/u);
  await assert.rejects(readG2AccountKeys({ ...input("0x"), readBlockHash: async () => { throw new Error("block-rpc-failed"); } }), /block-rpc-failed/u);
  await assert.rejects(readG2AccountKeys(input("0x", [], keyId)), /g2-finalized-block-changed/u);
  const delegated = await readG2AccountKeys(input(`0xef0100${"11".repeat(20)}`, [keyId]));
  assert.equal(accountReads, 1);
  assert.deepEqual(delegated.registered, [keyId]);
  assert.deepEqual(delegated.accountHashes, [keyId]);
  assert.equal(delegated.virgin, false);
  await assert.rejects(readG2AccountKeys({ ...input(`0xef0100${"22".repeat(20)}`),
    readAccount: async () => { throw new Error("foreign-account-getKeys-reverted"); } }), /foreign-account-getKeys-reverted/u);
});

test("G2 preview returns before any SDK wallet registration, claim or grant", () => {
  const source = readFileSync(fileURLToPath(new URL("../scripts/live-quant-rebalance.ts", import.meta.url)), "utf8");
  const grant = source.slice(source.indexOf("async function runG2Grant("), source.indexOf("export async function previewG2Worker("));
  assert.ok(grant.startsWith("async function runG2Grant("));
  const positions = ["if (!yesLive) return;", "createG2GrantClaim(claim)", "claimSelfTestFile(runtime.file, placeholder)",
    "entered = true", "provider.resolveOwnerWallet({ owner })", "provider.grantSession({ wallet, owner, spec"]
    .map((text) => grant.indexOf(text));
  assert.ok(positions.every((position) => position >= 0), "all authority boundaries must remain explicit");
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(grant.slice(0, positions[0]).includes("new AltanaProvider("), false);
});

test("G2 revalidation reports fixed refusal reasons without changing its false result", async () => {
  const now = Date.now();
  const hash = `0x${"ab".repeat(32)}` as Hex;
  const zero = { $bigint: "0" };
  const job = { protectedBaselineJson: JSON.stringify({ USDC: zero, WBNB: zero, ETH: zero, CAKE: zero, USDT: zero }),
    managed: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n } } as unknown as QuantRebalanceJobRow;
  const fee = JSON.stringify({ feeQuoteExpiresAtSec: Math.floor(now / 1_000) + 60,
    feeQuoteObservedAtMs: now, feeQuoteCreatedAtMs: now, requiredNativeWei: "1" });
  const action = { quoteBlockNumber: 100n, quoteObservedAtMs: now, gasEvidenceJson: fee } as QuantRebalanceActionRow;
  const finalized = { number: 100n, hash, timestampSec: BigInt(Math.floor(now / 1_000)) };
  const reasons: RebalanceRevalidationRefusal[] = [];
  const config = { chainId: 56 as const, databaseUrl: "", envelopeKey: "", apiKey: "", agentId: "g2",
    strategyId: "self-test-rebalance-g2", apiBaseUrl: "https://offline.invalid",
    rpcUrls: ["https://offline.invalid"], intervalMs: 300_000 };
  const check = async (reader: QuantChainReader, changedAction = action, changedFinalized = finalized) => {
    reasons.length = 0;
    const deps = buildQuantRebalanceWorkerDeps({ config, capabilityProfile: loadG2FileProfiles().capability,
      store: {} as MemoryQuantRebalanceStore, claims: {} as MemoryQuantWalletClaimStore,
      journal: {} as ExecutionJournal, transport: {} as FileQuantTransport,
      reader, provider: {} as WalletProvider, keypair: {} as never,
      onRevalidationRefusal: (reason) => { reasons.push(reason); } });
    assert.equal(await deps.revalidatePlan({ job, action: changedAction, finalized: changedFinalized }), false);
    assert.equal(reasons.length, 1);
    return reasons[0];
  };
  assert.equal(await check({} as QuantChainReader), "reader-capability-unavailable");
  const reader = { tokenBalanceAtHash: async () => 0n } as unknown as QuantChainReader;
  assert.equal(await check(reader, action, { ...finalized, number: 141n }), "quote-block-lag");
  assert.equal(await check(reader, { ...action, quoteObservedAtMs: now - 31_000 }), "quote-age");
  assert.equal(await check(reader, { ...action, gasEvidenceJson: "not-json" }), "fee-evidence-invalid");
  assert.equal(await check(reader, { ...action, gasEvidenceJson: JSON.stringify({ ...JSON.parse(fee) as object,
    feeQuoteExpiresAtSec: Math.floor(now / 1_000) - 1 }) }), "fee-quote-expired");
  assert.equal(await check({ tokenBalanceAtHash: async () => { throw new Error("SECRET-DO-NOT-LOG"); } } as unknown as QuantChainReader), "read-error");
  assert.equal(reasons.join(" ").includes("SECRET"), false);
  assert.equal(await check({ tokenBalanceAtHash: async () => 1n } as unknown as QuantChainReader), "balance-mismatch");
});

test("G2 local CLI adds a fixed pre-submit reason only to price-moved output", () => {
  assert.deepEqual(g2PreSubmitRefusalField(["job:refused:price-moved"], "native-reserve-increased"),
    { preSubmitRefusal: "native-reserve-increased" });
  assert.deepEqual(g2PreSubmitRefusalField(["job:committed"], "native-reserve-increased"), {});
  assert.deepEqual(g2PreSubmitRefusalField(["job:refused:price-moved"], null), {});
});

test("G2 capture is SHA-pinned and matches the exact 14-row/12-target multiset", () => {
  const bytes = readFileSync("test/fixtures/quant/contracts-customization-quant.json");
  assert.equal(createHash("sha256").update(bytes).digest("hex").toUpperCase(), G2_CAPTURE_SHA256);
  const { config, capability } = loadG2FileProfiles();
  assert.equal(config.expected.venueRows.length, 14);
  assert.equal(new Set(config.expected.venueRows.map((row) => row.address.toLowerCase())).size, 12);
  assert.equal(config.expected.tradableTokens.length, 7);
  assert.equal(findExpandedConfigProfile(config.expected, [config])?.id, config.id);
  assert.equal(capability.executionRoutes.length, 6);
  assert.equal(capability.referenceRoutes.length, 6);
  // The production registries hold exactly the reviewed G1 profiles; the file profiles never enter them.
  assert.deepEqual(QUANT_EXPANDED_CONFIG_PROFILES.map((profile) => profile.id), ["termix-quant-config-2026-09-27-v1"]);
  assert.deepEqual(QUANT_REBALANCE_CAPABILITY_PROFILES.map((profile) => profile.id), ["termix-rebalance-wizard-v1"]);
  assert.equal(findCapabilityProfile(capability.id), null);
  assert.equal(findExpandedConfigProfile(config.expected)?.id, "termix-quant-config-2026-09-27-v1");
  assert.notEqual(config.id, "termix-quant-config-2026-09-27-v1");
  assert.equal(resolveQuantRebalancingEnabled({}), false);
  assert.equal(resolveQuantRebalancingEnabled({ QUANT_REBALANCING_ENABLED: "true" }), true);
  assert.throws(() => resolveQuantRebalancingEnabled({ QUANT_REBALANCING_ENABLED: "yes" }));
  const parsed = parseConfigBlock(JSON.parse(bytes.toString("utf8")) as unknown);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const reordered = { ...parsed.data, venueRows: [...(parsed.data.venueRows ?? [])].reverse() };
  const normalized = normalizeExpandedQuantConfig(reordered);
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.equal(findExpandedConfigProfile(normalized.projection, [config])?.id, config.id);
  const mutated = { ...reordered, venueRows: reordered.venueRows?.map((row, index) => index === 0 ? { ...row, label: "changed" } : row) };
  const changed = normalizeExpandedQuantConfig(mutated);
  assert.equal(changed.ok, true);
  if (changed.ok) assert.equal(findExpandedConfigProfile(changed.projection, [config]), null);
  const venues = parsed.data.venueRows ?? [];
  for (const field of ["label", "kind", "protocol", "verified", "auditUrl", "officialUrl", "address"] as const) {
    const first = venues[0]!;
    const replacement = field === "verified" ? false : field === "address" ? getAddress("0x1111111111111111111111111111111111111111")
      : field === "protocol" ? "changed" : "changed";
    const altered = { ...first, [field]: replacement };
    const result = normalizeExpandedQuantConfig({ ...parsed.data, venueRows: [altered, ...venues.slice(1)] });
    assert.equal(result.ok, true, field);
    if (result.ok) assert.equal(findExpandedConfigProfile(result.projection, [config]), null, field);
  }
  const missingAlias = normalizeExpandedQuantConfig({ ...parsed.data, venueRows: venues.slice(0, -1) });
  assert.equal(missingAlias.ok, true);
  if (missingAlias.ok) assert.equal(findExpandedConfigProfile(missingAlias.projection, [config]), null);
  for (const field of ["decimals", "priceRoute", "address"] as const) {
    const token = parsed.data.tradableTokens[0]!;
    const replacement = field === "decimals" ? 8 : field === "address" ? getAddress("0x1111111111111111111111111111111111111111") : "via_wbnb";
    const result = normalizeExpandedQuantConfig({ ...parsed.data,
      tradableTokens: [{ ...token, [field]: replacement }, ...parsed.data.tradableTokens.slice(1)] });
    assert.equal(result.ok, true, field);
    if (result.ok) assert.equal(findExpandedConfigProfile(result.projection, [config]), null, field);
  }
  const wrongUsdcDecimals = normalizeExpandedQuantConfig({ ...parsed.data, uDecimals: 17 });
  assert.equal(wrongUsdcDecimals.ok, true);
  if (wrongUsdcDecimals.ok) assert.equal(findExpandedConfigProfile(wrongUsdcDecimals.projection, [config]), null);
});

test("G2 file cadence has a different digest without changing production tiers", () => {
  assert.equal(LOW_TIER.intervalMs, 86_400_000);
  assert.equal(LOW_TIER.driftBps, 1_000n);
  assert.equal(HIGH_TIER.intervalMs, 14_400_000);
  assert.equal(HIGH_TIER.driftBps, 300n);
  assert.equal(rebalanceTierForProfile(10n * 10n ** 18n, G2_FILE_CAPABILITY_ID).ok, true);
  assert.equal(G2_FILE_LOW_TIER.intervalMs, 300_000);
  assert.equal(G2_FILE_HIGH_TIER.driftBps, 10n);
  assert.notEqual(rebalancePolicyDigest(G2_FILE_CAPABILITY_ID), rebalancePolicyDigest("production"));
});

test("G2 closed CLI flags and grant-only selective env parsing", () => {
  assert.deepEqual(parseQuantRebalanceOperatorArgs(["prepare-self-test-db", "--allocation-usdc", "10", "--file", G2_JOBS[10].file]),
    { command: "prepare-self-test-db", allocation: 10, file: G2_JOBS[10].file, yesLive: false });
  assert.deepEqual(parseQuantRebalanceOperatorArgs(["self-test", "--allocation-usdc", "75", "--term-days", "2", "--file", G2_JOBS[75].file]),
    { command: "self-test", allocation: 75, termDays: 2, file: G2_JOBS[75].file, yesLive: false });
  assert.deepEqual(parseQuantRebalanceOperatorArgs(["worker", "--file", G2_JOBS[10].file, "--yes-live"]),
    { command: "worker", file: G2_JOBS[10].file, yesLive: true });
  for (const argv of [
    ["self-test", "--allocation-usdc", "11", "--term-days", "2", "--file", G2_JOBS[10].file],
    ["self-test", "--allocation-usdc", "10", "--term-days", "7", "--file", G2_JOBS[10].file],
    ["worker", "--file", G2_JOBS[10].file, "--file", G2_JOBS[10].file],
    ["status", "--yes-live"],
  ]) assert.throws(() => parseQuantRebalanceOperatorArgs(argv));
  const secret = `0x${randomBytes(32).toString("hex")}`;
  const text = `IGNORED_SETTING=ignored\nSELECTED_KEY=${secret}\n`;
  assert.equal(selectG2OwnerKey("SELECTED_KEY", text, {}), secret);
  assert.throws(() => selectG2OwnerKey("SELECTED_KEY", text, { SELECTED_KEY: secret }));
  assert.throws(() => selectG2OwnerKey("MISSING_KEY", text, {}));
});

test("G2 actual file CLI dispatch refuses before credentials without the dedicated env-file flag", () => {
  const script = fileURLToPath(new URL("../scripts/live-quant-rebalance.ts", import.meta.url));
  const run = spawnSync(process.execPath, ["--import", "tsx", script, "config-check", "--file", G2_JOBS[10].file],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", windowsHide: true,
      env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /live-quant-rebalance: g2-dedicated-env-required/u);
  assert.equal(run.stdout.trim(), "");
});

test("G2 cmd.exe runbook executable CLI lines match the closed parser and clear inherited values", () => {
  const book = readFileSync(new URL("../MD here/QUANT-REBALANCING-REHEARSAL-RUNBOOK.md", import.meta.url), "utf8");
  const required = ["QUANT_API_KEY", "QUANT_REBALANCE_STRATEGY_ID", "QUANT_SELF_TEST_FILE", "DATABASE_URL",
    "QUANT_ENVELOPE_KEY", "QUANT_RPC_URL", "EXECUTION_NETWORK", "QUANT_REBALANCING_ENABLED",
    "QUANT_REBALANCE_SELFTEST_OWNER_KEY_VAR", "USER1_PRIVATE_KEY"];
  let commands = 0;
  for (const match of book.matchAll(/```cmd\r?\n([\s\S]*?)```/gu)) {
    const block = match[1] ?? "";
    for (const line of block.split(/\r?\n/u)) {
      const prefix = "node --env-file=.env.rebalance-g2.local --import tsx scripts/live-quant-rebalance.ts ";
      if (!line.startsWith(prefix)) continue;
      commands += 1;
      for (const name of required) assert.ok(block.includes(`set "${name}="`), `${name} clear missing before ${line}`);
      assert.equal(line.includes("..."), false);
      const args = line.slice(prefix.length).replaceAll("%ACTION_ID%", `0x${"11".repeat(32)}`)
        .replaceAll("%TX_HASH%", `0x${"22".repeat(32)}`).split(/\s+/u);
      assert.doesNotThrow(() => parseQuantRebalanceOperatorArgs(args), line);
    }
  }
  assert.ok(commands >= 20);
});

test("G2 proposed low and high selector grants pass the production admission predicate", () => {
  const wallet = getAddress("0x1111111111111111111111111111111111111111");
  const nowMs = 1_800_000_000_000;
  const key = generatePrivateKey();
  const publicKey = privateKeyToAccount(key).publicKey;
  for (const allocation of [10, 75] as const) {
    const expiresAt = Math.floor(nowMs / 1_000) + 2 * 86_400 + 600;
    const spec = g2SessionSpec({ allocation,
      riskCaps: { WBNB: 77_812_751_323_115_598n, ETH: 22_489_204_384_706_574n, CAKE: 10_797_745_644_275_311_173n },
      verifiedPreGrantPaymentMaxWei: null, expiresAt, nowSeconds: Math.floor(nowMs / 1_000), wallet });
    assert.equal(spec.allowedCalls.length, allocation === 75 ? 5 : 3);
    assert.equal(spec.spendCaps.length, allocation === 75 ? 5 : 3);
    const serialized = serializeGrantedSession({ walletAddress: wallet, publicKey, expiry: expiresAt,
      permissions: {
        calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
          ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
        spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }), limit: cap.limit, period: cap.period })),
      }, privateKey: key });
    const parsed = parseSessionPlaintext(serialized);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    const capability = loadG2FileProfiles().capability;
    const admitted = admitRebalanceSession({ session: parsed.session,
      job: { id: G2_JOBS[allocation].job, status: "ACTIVE", strategyId: "self-test-rebalance-g2",
        tradingWalletAddress: wallet, allocationUWei: BigInt(allocation) * 10n ** 18n,
        dailyCapUWei: BigInt(allocation) * 2n * 10n ** 18n, termDays: 2, startedAtMs: nowMs - 1000,
        endsAtMs: nowMs + 2 * 86_400_000, sessionExpiresAtMs: expiresAt * 1000, revokedAtMs: null },
      capabilityProfile: capability, nowMs });
    assert.equal(admitted.ok, true, admitted.ok ? "" : admitted.code);
    if (admitted.ok) assert.equal(admitted.tier.intervalMs, 300_000);
  }
});

test("G2 fixed integer reserve vectors and fee-induced planner correction", () => {
  const usdcWbnb = [155472285400000000000000n, 200171300000000000000n] as const;
  const usdcEth = [146222452200000000000000n, 54411600000000000000n] as const;
  const wbnbCake = [14678177600000000000000n, 4083479026600000000000000n] as const;
  const quote = (input: bigint, reserveIn: bigint, reserveOut: bigint) =>
    input * 9975n * reserveOut / (reserveIn * 10000n + input * 9975n);
  const vectors = [
    { input: 5n, output: 6421223759128592n, reverse: 4974712474673830321n, pair: usdcWbnb },
    { input: 15n, output: 19262435451788583n, reverse: 14922225139677116166n, pair: usdcWbnb },
    { input: 30n, output: 38521164021344355n, reverse: 29838715263677901962n, pair: usdcWbnb },
    { input: 30n, output: 11133269497379492n, reverse: 29837989842180664248n, pair: usdcEth },
  ] as const;
  for (const item of vectors) {
    const output = quote(item.input * 10n ** 18n, item.pair[0], item.pair[1]);
    assert.equal(output, item.output);
    assert.equal(quote(output, item.pair[1], item.pair[0]), item.reverse);
  }
  const wbnb = quote(15n * 10n ** 18n, usdcWbnb[0], usdcWbnb[1]);
  const cake = quote(wbnb, wbnbCake[0], wbnbCake[1]);
  assert.equal(cake, 5345418635779857016n);
  const reverseWbnb = quote(cake, wbnbCake[1], wbnbCake[0]);
  assert.equal(quote(reverseWbnb, usdcWbnb[1], usdcWbnb[0]), 14847675574376005798n);
  assert.equal(g2RiskCap(6421223759128592n), 12970871993439756n);
  assert.equal(g2RiskCap(38521164021344355n), 77812751323115598n);
  assert.equal(g2RiskCap(11133269497379492n), 22489204384706574n);
  assert.equal(g2RiskCap(5345418635779857016n), 10797745644275311173n);
  assert.throws(() => g2RiskCap((1n << 256n) - 1n));
  assert.equal(600_000n * 50_000_000n * 15_000n / 10_000n, 45_000_000_000_000n);
  assert.equal(g2PaymentWithinBudget(45_000_000_000_000n, 2), true);
  assert.equal(g2PaymentWithinBudget(45_000_000_000_001n, 2), false);
  assert.equal(g2PaymentWithinBudget(90_000_000_000_000n, 3), true);
  assert.equal(g2PaymentWithinBudget(90_000_000_000_001n, 3), false);
  assert.equal(g2PaymentWithinBudget(27_752_075_000_000n, 2), true);
  assert.equal(g2PaymentWithinBudget(0n, 2), false);
  const planned = planRebalanceLeg({
    managed: { USDC: 5n * 10n ** 18n, WBNB: vectors[0]!.output, ETH: 0n, CAKE: 0n },
    values: { USDC: 5n * 10n ** 18n, WBNB: vectors[0]!.reverse, ETH: 0n, CAKE: 0n },
    tier: G2_FILE_LOW_TIER, takenAssets: new Set(), checkMode: "candidate",
  });
  assert.deepEqual(planned, { kind: "buy", asset: "WBNB", amountInWei: 12643762663084839n,
    targetDeficitValueWei: 12643762663084839n });
});

test("G2 admission accepts an unsimulatable future exit but checks route, quote, authorization and remaining sell cap", async () => {
  const wallet = getAddress("0x1111111111111111111111111111111111111111");
  const nowMs = Date.now();
  const expiry = Math.floor(nowMs / 1_000) + 2 * 86_400 + 600;
  const publicKey = privateKeyToAccount(generatePrivateKey()).publicKey;
  const spec = g2SessionSpec({ allocation: 10, riskCaps: { WBNB: 11n * 10n ** 18n },
    verifiedPreGrantPaymentMaxWei: null, expiresAt: expiry, nowSeconds: Math.floor(nowMs / 1_000), wallet });
  const session = { version: 1, walletAddress: wallet, publicKey, expiry, permissions: {
    calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
      ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
    spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
      limit: cap.limit, period: cap.period })),
  } };
  const profile = loadG2FileProfiles().capability;
  const job = { id: G2_JOBS[10].job, strategyId: "self-test-rebalance-g2", status: "ACTIVE" as const,
    tradingWalletAddress: wallet, allocationUWei: 10n * 10n ** 18n, dailyCapUWei: 20n * 10n ** 18n,
    termDays: 2, startedAtMs: nowMs - 1_000, endsAtMs: nowMs + 2 * 86_400_000,
    sessionExpiresAtMs: expiry * 1_000, revokedAtMs: null };
  const USDC = getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
  const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
  const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
  const tokens = [USDC, WBNB, USDT];
  const pairRows = new Map<string, { address: `0x${string}`; token0: `0x${string}`; token1: `0x${string}` }>();
  for (let i = 0; i < tokens.length; i += 1) for (let j = i + 1; j < tokens.length; j += 1) {
    const key = [tokens[i]!, tokens[j]!].sort().join(":").toLowerCase();
    pairRows.set(key, { address: getAddress(`0x${String(i * 3 + j).repeat(40)}`),
      token0: tokens[i]!, token1: tokens[j]! });
  }
  const priorFetch = globalThis.fetch;
  try {
    for (const refusal of ["none", "route", "pair", "reference", "quote", "canExecute",
      "cap-exact", "cap-short", "cap-exhausted"] as const) {
      let buyPrepares = 0; let exitPrepares = 0;
      globalThis.fetch = async (_request, init) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string;
          params: [{ data?: Hex; calls?: { to: `0x${string}`; data: Hex; value: Hex }[] }] };
        let result: unknown;
        if (body.method === "eth_call") {
          const data = body.params[0].data!;
          try {
            const decoded = decodeFunctionData({ abi: KEYSTORE_ABI, data });
            assert.equal(decoded.functionName, "isValidKey");
            result = encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", result: true });
          } catch {
            const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data });
            if (decoded.functionName === "getKeys") result = encodeFunctionResult({ abi: ACCOUNT_ABI,
              functionName: "getKeys", result: [[{ expiry, keyType: 0, isSuperAdmin: false, publicKey }],
                [accountKeyHashForAddress(publicKeyToAddress(publicKey))]] });
            else {
              assert.equal(decoded.functionName, "canExecute");
              result = encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "canExecute",
                result: refusal !== "canExecute" || decoded.args[1].toLowerCase() !== WBNB.toLowerCase() });
            }
          }
        } else if (body.method === "wallet_getCapabilities") {
          const contract = { address: QUANT_ORCHESTRATOR_56 };
          result = { "0x38": { contracts: { accountImplementation: contract, accountProxy: contract,
            legacyAccountImplementations: [], legacyOrchestrators: [], orchestrator: contract, simulator: contract },
            fees: { quoteConfig: { rateTtl: 120, ttl: 120 }, recipient: wallet, tokens: [] } } };
        } else {
          assert.equal(body.method, "wallet_prepareCalls");
          const calls = body.params[0].calls!;
          const sell = calls[0]?.to.toLowerCase() === WBNB.toLowerCase();
          if (sell) { exitPrepares += 1; throw new Error("zero WBNB balance"); }
          buyPrepares += 1;
          result = { capabilities: {}, context: { quote: { hash: `0x${"12".repeat(32)}`,
            r: `0x${"13".repeat(32)}`, s: `0x${"14".repeat(32)}`,
            ttl: Math.floor(Date.now() / 1_000) + 120,
            quotes: [{ chainId: "0x38", ethPrice: "0x1", extraPayment: "0x0", feeTokenDeficit: "0x0",
              intent: { combinedGas: "0x1", encodedFundTransfers: [], encodedPreCalls: [], eoa: wallet,
                executionData: encodeLpFinalCallsV1(calls.map((call) => ({ to: call.to, data: call.data,
                  value: BigInt(call.value) }))), expiry: "0x0", funder: "0x0000000000000000000000000000000000000000", funderSignature: "0x",
                isMultichain: false, nonce: "0x1", payer: wallet, paymentAmount: "0x193d889278c0",
                paymentMaxAmount: "0x193d889278c0", paymentRecipient: wallet, paymentSignature: "0x",
                paymentToken: "0x0000000000000000000000000000000000000000", settler: wallet,
                settlerContext: "0x", signature: "0x", supportedAccountImplementation: wallet },
              nativeFeeEstimate: { maxFeePerGas: "0x2faf080", maxPriorityFeePerGas: "0x1" },
              orchestrator: QUANT_ORCHESTRATOR_56, paymentTokenDecimals: 18, txGas: "0x683cb" }] } },
            digest: `0x${"15".repeat(32)}`, key: null, signature: "0x",
            typedData: { domain: {}, message: {}, primaryType: "Intent", types: {} } };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
          { headers: { "content-type": "application/json" } });
      };
      const reader = { chainId: async () => 56,
        finalizedBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` as Hex,
          timestampSec: BigInt(Math.floor(Date.now() / 1_000)) }),
        tokenBalanceAtHash: async (token: `0x${string}`) => token.toLowerCase() === USDC.toLowerCase() ? 10n * 10n ** 18n : 0n,
        nativeBalanceAtHash: async () => 10n ** 16n, gasPriceWei: async () => 50_000_000n,
        getPair: async (_factory: `0x${string}`, from: `0x${string}`, to: `0x${string}`) => {
          if (refusal === "pair" && from.toLowerCase() === WBNB.toLowerCase()
            && to.toLowerCase() === USDC.toLowerCase()) return "0x0000000000000000000000000000000000000000";
          if (refusal === "reference" && from.toLowerCase() === WBNB.toLowerCase()
            && to.toLowerCase() === USDT.toLowerCase()) return "0x0000000000000000000000000000000000000000";
          return pairRows.get([from, to].sort().join(":").toLowerCase())!.address;
        },
        pairToken1: async (address: `0x${string}`) => [...pairRows.values()].find((pair) => pair.address === address)!.token1,
        reservesAtHash: async (address: `0x${string}`, blockHash: Hex) => {
          const pair = [...pairRows.values()].find((item) => item.address === address)!;
          return { token0: pair.token0, reserve0: 1_000_000n * 10n ** 18n,
            reserve1: 1_000_000n * 10n ** 18n, blockHash };
        },
        quoteV2AmountsAtHash: async (_router: `0x${string}`, path: readonly `0x${string}`[], amount: bigint) => {
          if (refusal === "quote" && path[0]?.toLowerCase() === WBNB.toLowerCase()) throw new Error("sell quote unavailable");
          return path.map(() => amount);
        },
      } as unknown as QuantChainReader;
      const provider = { readSpendInfos: async () => session.permissions.spend.map((cap) => ({
        token: "token" in cap ? cap.token : null, period: cap.period, periodCode: 2,
        limitWei: cap.limit,
        currentSpentWei: "token" in cap && cap.token?.toLowerCase() === WBNB.toLowerCase()
          ? refusal === "cap-exhausted" ? cap.limit
            : refusal === "cap-exact" ? cap.limit - 5n * 10n ** 18n
              : refusal === "cap-short" ? cap.limit - 5n * 10n ** 18n + 1n : 0n
          : 0n })) } as unknown as WalletProvider;
      const deps = buildQuantRebalanceWorkerDeps({ config: { chainId: 56, databaseUrl: "", envelopeKey: "",
        apiKey: "", agentId: "g2", strategyId: job.strategyId, apiBaseUrl: "https://offline.invalid",
        rpcUrls: ["https://offline.invalid"], intervalMs: 300_000 },
        capabilityProfile: refusal === "route" ? { ...profile, executionRoutes: profile.executionRoutes.filter((route) =>
          !route.startsWith(WBNB.toLowerCase())) } : profile,
        store: {} as MemoryQuantRebalanceStore, claims: {} as MemoryQuantWalletClaimStore,
        journal: {} as ExecutionJournal, transport: {} as FileQuantTransport,
        reader, provider, keypair: {} as never });
      const result = await deps.admitChain({ job, session, grantShape: "selector-scoped",
        tier: G2_FILE_LOW_TIER, capabilityProfile: deps.capabilityProfile! });
      assert.equal(buyPrepares, refusal === "route" || refusal === "canExecute" ? 0 : 1, refusal);
      assert.equal(exitPrepares, 0, refusal);
      assert.equal(result.ok, refusal === "none" || refusal === "cap-exact",
        `${refusal}: ${result.ok ? "ok" : result.code}, buyPrepares=${buyPrepares}`);
      if (refusal === "none") {
        const evidence = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
          typeof item === "bigint" ? { $bigint: item.toString(10) } : item);
        const zero = { USDC: { $bigint: "0" }, WBNB: { $bigint: "0" }, ETH: { $bigint: "0" },
          CAKE: { $bigint: "0" }, USDT: { $bigint: "0" } };
        const quoteMax = BigInt("0x193d889278c0");
        const ownSolvency = (quoteMax * 15_000n + 9_999n) / 10_000n;
        const amount = 1n * 10n ** 18n;
        const managed = { USDC: 10n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n };
        const freshRequired = requiredNativeReserve({ side: "buy", ownSolvencyWei: ownSolvency,
          gasPriceWei: 50_000_000n, maximumExitGasUnits: 600_000n,
          managed, asset: "WBNB", resultingQuantityWei: amount });
        const clock = Date.now();
        const jobForCheck = { tradingWallet: wallet, descriptorJson: evidence(session.permissions),
          projectionJson: evidence(spec), sessionPublicKey: publicKey, sessionExpirySec: expiry,
          permissionsDigest: permissionsDigest(session.permissions), projectionDigest: specDigest(spec),
          protectedBaselineJson: JSON.stringify(zero), managed } as unknown as QuantRebalanceJobRow;
        const actionForCheck = { asset: "WBNB", side: "buy", sequence: 1n, path: [USDC, WBNB],
          amountInWei: amount, minOutWei: 0n, deadlineSec: Math.floor(clock / 1_000) + 600,
          quoteBlockNumber: 100n, quoteObservedAtMs: clock,
          gasEvidenceJson: JSON.stringify({ feeQuoteExpiresAtSec: Math.floor(clock / 1_000) + 60,
            feeQuoteObservedAtMs: clock, feeQuoteCreatedAtMs: clock,
            requiredNativeWei: freshRequired.toString(10) }) } as unknown as QuantRebalanceActionRow;
        const revalidationReasons: RebalanceRevalidationRefusal[] = [];
        const readerForCheck = { ...reader, blockAt: async () => ({ number: 100n,
          hash: `0x${"ab".repeat(32)}` as Hex, timestampSec: BigInt(Math.floor(clock / 1_000)) }) } as QuantChainReader;
        const depsForCheck = buildQuantRebalanceWorkerDeps({ config: { chainId: 56, databaseUrl: "", envelopeKey: "",
          apiKey: "", agentId: "g2", strategyId: job.strategyId, apiBaseUrl: "https://offline.invalid",
          rpcUrls: ["https://offline.invalid"], intervalMs: 300_000 }, capabilityProfile: profile,
          store: {} as MemoryQuantRebalanceStore, claims: {} as MemoryQuantWalletClaimStore,
          journal: {} as ExecutionJournal, transport: {} as FileQuantTransport,
          reader: readerForCheck, provider, keypair: {} as never,
          onRevalidationRefusal: (reason) => { revalidationReasons.push(reason); } });
        const finalized = { number: 100n, hash: `0x${"ab".repeat(32)}` as Hex,
          timestampSec: BigInt(Math.floor(clock / 1_000)) };
        assert.equal(await depsForCheck.revalidatePlan({ job: jobForCheck, action: actionForCheck, finalized }), true,
          revalidationReasons.join(","));
        assert.deepEqual(revalidationReasons, []);
        assert.equal(await depsForCheck.revalidatePlan({ job: jobForCheck,
          action: { ...actionForCheck, gasEvidenceJson: JSON.stringify({ ...JSON.parse(actionForCheck.gasEvidenceJson) as object,
            requiredNativeWei: (freshRequired - 1n).toString(10) }) }, finalized }), false);
        assert.deepEqual(revalidationReasons, ["native-reserve-increased"]);
        const throwingDeps = buildQuantRebalanceWorkerDeps({ config: { chainId: 56, databaseUrl: "", envelopeKey: "",
          apiKey: "", agentId: "g2", strategyId: job.strategyId, apiBaseUrl: "https://offline.invalid",
          rpcUrls: ["https://offline.invalid"], intervalMs: 300_000 }, capabilityProfile: profile,
          store: {} as MemoryQuantRebalanceStore, claims: {} as MemoryQuantWalletClaimStore,
          journal: {} as ExecutionJournal, transport: {} as FileQuantTransport,
          reader: readerForCheck, provider, keypair: {} as never,
          onRevalidationRefusal: () => { throw new Error("diagnostic-callback-error"); } });
        assert.equal(await throwingDeps.revalidatePlan({ job: jobForCheck,
          action: { ...actionForCheck, gasEvidenceJson: JSON.stringify({ ...JSON.parse(actionForCheck.gasEvidenceJson) as object,
            requiredNativeWei: (freshRequired - 1n).toString(10) }) }, finalized }), false);
      }
    }
  } finally { globalThis.fetch = priorFetch; }
});

test("G2 durable grant-plus-send budget and completed-route stop", () => {
  const path = [getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
    getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c")];
  const action = (sequence: bigint, state: "failed" | "unknown" | "retired" | "settled",
    side: "buy" | "sell" = "buy") => ({ preSubmitBlockNumber: 1n, state, side,
      asset: "WBNB" as const, path: side === "buy" ? path : [...path].reverse(), sequence });
  const charged = Array.from({ length: 18 }, (_, index) => action(BigInt(index + 1),
    index % 3 === 0 ? "failed" : index % 3 === 1 ? "unknown" : "retired"));
  assert.deepEqual(g2SubmissionVerdict(charged, 10), { used: 19, remaining: 1, stop: null });
  assert.deepEqual(g2SubmissionVerdict([...charged, action(19n, "failed")], 10),
    { used: 20, remaining: 0, stop: "budget" });
  assert.deepEqual(g2SubmissionVerdict([...charged, action(19n, "failed"), action(20n, "unknown")], 10),
    { used: 21, remaining: 0, stop: "budget" });
  assert.deepEqual(g2SubmissionVerdict([action(1n, "settled", "buy"), action(2n, "settled", "sell"),
    action(3n, "settled", "buy")], 10), { used: 4, remaining: 16, stop: "routes-complete" });
  const usdc = path[0]!; const wbnb = path[1]!;
  const eth = getAddress("0x2170Ed0880ac9A755fd29B2688956BD959F933F8");
  const cake = getAddress("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82");
  const pair = (asset: "WBNB" | "ETH" | "CAKE", buyPath: readonly `0x${string}`[], sequence: bigint,
    side: "buy" | "sell") => ({ preSubmitBlockNumber: 1n, state: "settled" as const,
      side, asset, path: side === "buy" ? buyPath : [...buyPath].reverse(), sequence });
  const high = [pair("WBNB", [usdc, wbnb], 1n, "sell"), pair("WBNB", [usdc, wbnb], 2n, "buy"),
    pair("ETH", [usdc, eth], 3n, "sell"), pair("ETH", [usdc, eth], 4n, "buy"),
    pair("CAKE", [usdc, wbnb, cake], 5n, "sell"), pair("CAKE", [usdc, wbnb, cake], 6n, "buy")];
  assert.equal(g2SubmissionVerdict(high, 75).stop, "routes-complete");
  assert.equal(g2SubmissionVerdict([...high.slice(0, -2),
    pair("CAKE", [usdc, cake], 5n, "sell"), pair("CAKE", [usdc, cake], 6n, "buy")], 75).stop, null);
  assert.equal(g2SubmissionVerdict([{ ...action(1n, "failed"), preSubmitBlockNumber: null }], 10).used, 1);
  assert.equal(g2SubmissionVerdict([{ ...action(1n, "failed"), preSubmitBlockNumber: undefined } as unknown as
    Parameters<typeof g2SubmissionVerdict>[0][number]], 10).stop,
    "ledger-unreadable");
});

test("G2 worker previews discovery, pending recovery, a read-only plan and actual term end", async () => {
  const nowMs = 1_900_000_000_000;
  let writes = 0; let plans = 0;
  const forbidden = () => { writes += 1; throw new Error("write-or-sign-forbidden"); };
  const wallet = getAddress("0x1111111111111111111111111111111111111111");
  const job = { jobId: G2_JOBS[10].job, allocationWei: 10n * 10n ** 18n,
    startedAtMs: nowMs - 1000, endsAtMs: nowMs + 2 * 86_400_000,
    bootstrapComplete: false, managed: { USDC: 10n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n },
    nextEligibleSlot: 0, tradingWallet: wallet } as unknown as QuantRebalanceJobRow;
  const deps = { capabilityProfile: loadG2FileProfiles().capability, nowMs: () => nowMs,
    store: { setHold: forbidden, beginCheck: forbidden, insertAction: forbidden },
    provider: { grantSession: forbidden, executeViaSession: forbidden },
    transport: { report: forbidden },
    async readPortfolio() { return { ok: true as const, observation: {
      blockNumber: 1n, blockHash: `0x${"ab".repeat(32)}` as Hex, observedAtMs: nowMs,
      actualBalances: { USDC: 10n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
      values: { USDC: 10n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n }, marks: [],
      nativeBalanceWei: 10n ** 16n, gasPriceWei: 50_000_000n } }; },
    async priceLeg() { plans += 1; return { action: { path: [getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
      getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c")], quoteOutWei: 1n,
      gasEvidenceJson: JSON.stringify({ paymentMaxWei: "1" }) } }; },
  } as unknown as QuantRebalanceWorkerDeps;
  const listChecks = async () => { throw new Error("unexpected-check-read"); };
  const discovery = await previewG2Worker({ jobId: job.jobId, job: null, actions: [], allocation: 10,
    deps, listChecks, nowMs });
  assert.equal(discovery["phase"], "discovery-and-admission");
  const pending = await previewG2Worker({ jobId: job.jobId, job, actions: [{ state: "unknown", actionId: "pending" } as QuantRebalanceActionRow],
    allocation: 10, deps, listChecks, nowMs });
  assert.equal(pending["phase"], "recovery");
  const term = await previewG2Worker({ jobId: job.jobId, job: { ...job, endsAtMs: nowMs }, actions: [],
    allocation: 10, deps, listChecks, nowMs });
  assert.equal(term["phase"], "term-end-report");
  const budgetedTerm = await previewG2Worker({ jobId: job.jobId, job: { ...job, endsAtMs: nowMs }, actions: [],
    allocation: 10, deps, listChecks, nowMs, grantCostExcess: true });
  assert.equal(budgetedTerm["phase"], "term-end-report");
  assert.equal(budgetedTerm["submissionStop"], "grant-budget");
  const normal = await previewG2Worker({ jobId: job.jobId, job, actions: [], allocation: 10,
    deps, listChecks: async () => [], nowMs });
  assert.equal(normal["phase"], "bootstrap");
  assert.equal((normal["plan"] as { kind: string }).kind, "buy");
  assert.equal(plans, 1);
  assert.equal(writes, 0);
  const markAtMs = nowMs + 1_879;
  let pricedAtMs = 0;
  const holdingJob = { ...job, managed: { USDC: 5n * 10n ** 18n, WBNB: 1n * 10n ** 18n,
    ETH: 0n, CAKE: 0n } };
  const laterDeps = { ...deps, nowMs: () => markAtMs,
    async readPortfolio() { return { ok: true as const, observation: {
      blockNumber: 1n, blockHash: `0x${"ab".repeat(32)}` as Hex, observedAtMs: nowMs,
      actualBalances: { USDC: 5n * 10n ** 18n, WBNB: 1n * 10n ** 18n, ETH: 0n, CAKE: 0n, USDT: 0n },
      values: { USDC: 5n * 10n ** 18n, WBNB: 4n * 10n ** 18n, ETH: 0n, CAKE: 0n },
      marks: [{ asset: "WBNB" as const, quantityWei: 1n * 10n ** 18n, usdcOutWei: 4n * 10n ** 18n,
        path: [getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
          getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d")],
        blockNumber: 1n, blockHash: `0x${"ab".repeat(32)}` as Hex, observedAtMs: markAtMs,
        pairAddresses: [getAddress("0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b")],
        referenceEvidenceDigest: `0x${"cd".repeat(32)}` as Hex }],
      nativeBalanceWei: 10n ** 16n, gasPriceWei: 50_000_000n } }; },
    async priceLeg({ nowMs: pricedNow }: { readonly nowMs: number }) {
      pricedAtMs = pricedNow;
      return { action: { path: [], quoteOutWei: 1n, gasEvidenceJson: "{}" } };
    },
  } as unknown as QuantRebalanceWorkerDeps;
  const later = await previewG2Worker({ jobId: job.jobId, job: holdingJob, actions: [], allocation: 10,
    deps: laterDeps, listChecks: async () => [], nowMs });
  assert.equal((later["plan"] as { kind: string }).kind, "buy");
  assert.equal(pricedAtMs, markAtMs);
});

test("G2 claim blocks a second provider entry and archives only the exact ready claim", () => {
  const before = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "quant-g2-claim-"));
  try {
    process.chdir(directory);
    mkdirSync("scripts/tmp", { recursive: true });
    const wallet = getAddress("0x1111111111111111111111111111111111111111");
    const claim: G2GrantClaim = {
      version: 1, chainId: 56, wallet, database: G2_JOBS[10].db, role: G2_JOBS[10].db,
      server: "127.0.0.1:5432", jobId: G2_JOBS[10].job, file: resolve(G2_JOBS[10].file),
      fileFactsDigest: g2ProposedFileDigest(10, G2_JOBS[10].file), publicKey: `0x04${"34".repeat(64)}` as Hex,
      keyId: keccak256(`0x04${"34".repeat(64)}` as Hex), permissionsDigest: `0x${"78".repeat(32)}` as Hex,
      expirySec: 2_000_000_000, state: "claiming", outputDigest: null, grantNativeDebitWei: null,
      baselineBlock: "1", baselineHash: `0x${"ab".repeat(32)}` as Hex,
      actualBaseline: { USDC: (100n * 10n ** 18n).toString(10), WBNB: "0", ETH: "0", CAKE: "0", USDT: "0", U: "59", BNB: "100" },
      protectedBaseline: { USDC: (90n * 10n ** 18n).toString(10), WBNB: "0", ETH: "0", CAKE: "0", USDT: "0", U: "59", BNB: "0" },
      approvedNativeFloatWei: "100",
    };
    createG2GrantClaim(claim);
    assert.equal(readG2GrantClaim(wallet).state, "claiming");
    assert.throws(() => createG2GrantClaim({ ...claim, database: G2_JOBS[75].db, role: G2_JOBS[75].db,
      jobId: G2_JOBS[75].job, file: resolve(G2_JOBS[75].file),
      fileFactsDigest: g2ProposedFileDigest(75, G2_JOBS[75].file) }));
    assert.equal(readG2GrantClaim(wallet).jobId, claim.jobId);
    assert.equal(g2ClaimPath(wallet).includes("quant-rebalance-g2-grant-56-"), true);
    const ready = publishG2ReadyClaim(claim, `0x${"90".repeat(32)}` as Hex, 1n);
    assert.equal(readG2GrantClaim(wallet).state, "ready");
    const dead = { blockNumber: "2", blockHash: `0x${"cd".repeat(32)}` as Hex,
      timestampSec: ready.expirySec, keyId: ready.keyId, expired: true as const };
    assert.throws(() => closeG2GrantClaim(ready, { ...dead, timestampSec: ready.expirySec - 1 }));
    const archive = closeG2GrantClaim(ready, dead);
    assert.equal(JSON.parse(readFileSync(archive, "utf8") as string).jobId, claim.jobId);
    assert.equal(JSON.parse(readFileSync(`${archive}.complete`, "utf8") as string).proof.keyId, ready.keyId);
    assert.equal(readFileSync(`${archive}.released`, "utf8").trim().startsWith("0x"), true);
    assert.throws(() => readG2GrantClaim(wallet));
    assert.throws(() => closeG2GrantClaim(ready, dead));
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
});

function inClaimDirectory(run: () => void): void {
  const before = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "quant-g2-r3-"));
  try {
    process.chdir(directory);
    mkdirSync("scripts/tmp", { recursive: true });
    run();
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
}

function r3Claim(allocation: 10 | 75): G2GrantClaim {
  const map = G2_JOBS[allocation];
  return { version: 1, chainId: 56, wallet: getAddress("0x2222222222222222222222222222222222222222"),
    database: map.db, role: map.db, server: "127.0.0.1:5432", jobId: map.job, file: resolve(map.file),
    fileFactsDigest: g2ProposedFileDigest(allocation, map.file), publicKey: `0x04${"34".repeat(64)}` as Hex,
    keyId: keccak256(`0x04${"34".repeat(64)}` as Hex), permissionsDigest: `0x${"78".repeat(32)}` as Hex,
    expirySec: 2_000_000_000, state: "claiming", outputDigest: null, grantNativeDebitWei: null,
    baselineBlock: "1", baselineHash: `0x${"ab".repeat(32)}` as Hex,
    actualBaseline: { USDC: (100n * 10n ** 18n).toString(10), WBNB: "0", ETH: "0", CAKE: "0", USDT: "0", U: "59", BNB: "100" },
    protectedBaseline: { USDC: (BigInt(100 - allocation) * 10n ** 18n).toString(10),
      WBNB: "0", ETH: "0", CAKE: "0", USDT: "0", U: "59", BNB: "0" },
    approvedNativeFloatWei: "100" };
}

function r3Ready(claim: G2GrantClaim): G2GrantClaim {
  createG2GrantClaim(claim);
  return publishG2ReadyClaim(claim, `0x${"90".repeat(32)}` as Hex, 1n);
}

function r3Dead(claim: G2GrantClaim) {
  return { blockNumber: "2", blockHash: `0x${"cd".repeat(32)}` as Hex,
    timestampSec: claim.expirySec, keyId: claim.keyId, expired: true as const };
}

test("finite high-75 claim requires a virgin wallet with no archived predecessor", () => inClaimDirectory(() => {
  const old = r3Ready(r3Claim(10));
  closeG2GrantClaim(old, r3Dead(old));
  const base = r3Claim(75);
  const finite: G2GrantClaim = { ...base, database: G2_FINITE_JOB.db, role: G2_FINITE_JOB.db,
    jobId: G2_FINITE_JOB.job, file: resolve(G2_FINITE_JOB.file),
    fileFactsDigest: g2ProposedFileDigest(75, G2_FINITE_JOB.file),
    freshWalletProof: { wallet: base.wallet, blockNumber: base.baselineBlock,
      blockHash: base.baselineHash, code: "0x", registryKeys: 0 } };
  assert.throws(() => createG2GrantClaim(finite));
}));

test("finite high-75 fresh claim rejects absent virgin proof", () => inClaimDirectory(() => {
  const base = r3Claim(75);
  const finite: G2GrantClaim = { ...base, database: G2_FINITE_JOB.db, role: G2_FINITE_JOB.db,
    jobId: G2_FINITE_JOB.job, file: resolve(G2_FINITE_JOB.file),
    fileFactsDigest: g2ProposedFileDigest(75, G2_FINITE_JOB.file) };
  assert.throws(() => createG2GrantClaim(finite));
  createG2GrantClaim({ ...finite, freshWalletProof: { wallet: base.wallet,
    blockNumber: base.baselineBlock, blockHash: base.baselineHash, code: "0x", registryKeys: 0 } });
  assert.equal(readG2GrantClaim(base.wallet).jobId, G2_FINITE_JOB.job);
}));

test("R3 two closers cannot archive a successor after the first clean close", () => inClaimDirectory(() => {
  const old = r3Ready(r3Claim(10));
  closeG2GrantClaim(old, r3Dead(old));
  const successor = r3Claim(75);
  createG2GrantClaim(successor);
  assert.throws(() => closeG2GrantClaim(old, r3Dead(old)));
  assert.equal(readG2GrantClaim(successor.wallet).jobId, successor.jobId);
}));

test("R3 close serializes with claim creation and ready publication across jobs", () => inClaimDirectory(() => {
  const old = r3Ready(r3Claim(10));
  const successor = r3Claim(75);
  let providerEntries = 0;
  closeG2GrantClaim(old, r3Dead(old), (boundary) => {
    if (boundary === "guard-acquired") {
      assert.throws(() => { createG2GrantClaim(successor); providerEntries += 1; });
    }
  });
  createG2GrantClaim(successor);
  providerEntries += 1;
  assert.throws(() => publishG2ReadyClaim(successor, `0x${"91".repeat(32)}` as Hex, 1n,
    (boundary) => { if (boundary === "guard-acquired") closeG2GrantClaim(old, r3Dead(old)); }));
  assert.equal(providerEntries, 1);
  assert.equal(readG2GrantClaim(successor.wallet).jobId, successor.jobId);
}));

test("R3 stale close preserves successor and existing archive destination", () => inClaimDirectory(() => {
  const old = r3Ready(r3Claim(10));
  const archive = closeG2GrantClaim(old, r3Dead(old));
  const archived = readFileSync(archive, "utf8");
  createG2GrantClaim(r3Claim(75));
  assert.throws(() => closeG2GrantClaim(old, r3Dead(old)));
  assert.equal(readFileSync(archive, "utf8"), archived);
  assert.equal(readG2GrantClaim(old.wallet).jobId, G2_JOBS[75].job);
}));

test("R3 crash boundaries retain claim or guard; only a released witness permits next grant", () => {
  for (const boundary of ["guard-acquired", "archive-written", "canonical-removed", "complete-written", "guard-released", "release-recorded"] as const) {
    inClaimDirectory(() => {
      const old = r3Ready(r3Claim(10));
      let providerEntries = 1;
      assert.throws(() => closeG2GrantClaim(old, r3Dead(old), (point) => {
        if (point === boundary) throw new Error("injected-crash");
      }));
      const next = r3Claim(75);
      if (boundary === "release-recorded") {
        createG2GrantClaim(next); providerEntries += 1;
        assert.equal(providerEntries, 2);
      } else {
        assert.throws(() => { createG2GrantClaim(next); providerEntries += 1; });
        assert.equal(providerEntries, 1);
        assert.equal(existsSync(g2ClaimPath(old.wallet)) || existsSync(`${g2ClaimPath(old.wallet)}.guard`)
          || readdirSync("scripts/tmp").some((name) => name.endsWith(".archive")), true);
      }
    });
  }
});

test("R3 a fully clean close permits exactly one sequential provider entry", () => inClaimDirectory(() => {
  const old = r3Ready(r3Claim(10));
  const archive = closeG2GrantClaim(old, r3Dead(old));
  assert.equal(existsSync(`${archive}.released`), true);
  const successor = r3Claim(75);
  let providerEntries = 0;
  createG2GrantClaim(successor); providerEntries += 1;
  assert.throws(() => { createG2GrantClaim(successor); providerEntries += 1; });
  assert.equal(providerEntries, 1);
}));

test("G2 high-75 admits a distinct fresh wallet while retaining its own claim exclusion", () => inClaimDirectory(() => {
  const base = r3Claim(75);
  assert.throws(() => createG2GrantClaim(base), /g2-wallet-already-claimed/u);
  const high: G2GrantClaim = { ...base, freshWalletProof: { wallet: base.wallet, blockNumber: base.baselineBlock,
    blockHash: base.baselineHash, code: "0x", registryKeys: 0 } };
  assert.throws(() => createG2GrantClaim({ ...high, freshWalletProof: { ...high.freshWalletProof!,
    wallet: getAddress("0x3333333333333333333333333333333333333333") } }), /g2-claim-invalid/u);
  assert.throws(() => createG2GrantClaim({ ...high, freshWalletProof: { ...high.freshWalletProof!,
    blockHash: `0x${"cd".repeat(32)}` as Hex } }), /g2-claim-invalid/u);
  createG2GrantClaim(high);
  assert.equal(readG2GrantClaim(high.wallet).jobId, G2_JOBS[75].job);
  assert.throws(() => createG2GrantClaim(high), /g2-wallet-already-claimed/u);
  assert.throws(() => createG2GrantClaim(r3Claim(10)), /g2-wallet-already-claimed/u);
  assert.equal(readG2GrantClaim(high.wallet).state, "claiming");
}));

test("G2 a changed protected baseline makes the public claim unreadable and blocks reuse", () => inClaimDirectory(() => {
  const ready = r3Ready(r3Claim(10));
  const altered = { ...ready, protectedBaseline: { ...ready.protectedBaseline,
    USDC: (BigInt(ready.protectedBaseline.USDC) + 1n).toString(10) } };
  writeFileSync(g2ClaimPath(ready.wallet), `${JSON.stringify(altered)}\n`);
  assert.throws(() => readG2GrantClaim(ready.wallet));
  assert.throws(() => createG2GrantClaim(r3Claim(75)));
}));

test("R2.4 every pre/post-provider publication crash retains a wallet exclusion", () => {
  const capture = loadG2FileProfiles().block;
  for (const boundary of ["guard-acquired", "claim-created", "provider-returned", "serialized", "sealed",
    "output-temp-written", "output-published", "ready-temp-written", "ready-published"] as const) {
    inClaimDirectory(() => {
      const privateKey = generatePrivateKey();
      const publicKey = privateKeyToAccount(privateKey).publicKey;
      const keypair = quantKeypairFromSeed(`0x${randomBytes(32).toString("hex")}`);
      const first = r3Claim(10);
      const spec = g2SessionSpec({ allocation: 10, riskCaps: { WBNB: 20n * 10n ** 18n },
        verifiedPreGrantPaymentMaxWei: null, expiresAt: first.expirySec, nowSeconds: first.expirySec - 2 * 86_400,
        wallet: first.wallet });
      const permissions = { calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
          ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
        spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
          limit: cap.limit, period: cap.period })) };
      const parsed = parseSessionPlaintext(serializeGrantedSession({ walletAddress: first.wallet, publicKey,
        expiry: first.expirySec, permissions, privateKey }));
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      const claim = { ...first, publicKey, keyId: keccak256(publicKey),
        permissionsDigest: permissionsDigest(parsed.session.permissions) };
      let providerEntries = 0;
      if (boundary === "guard-acquired" || boundary === "claim-created") {
        assert.throws(() => createG2GrantClaim(claim, (point) => { if (point === boundary) throw new Error("injected"); }));
      } else {
        createG2GrantClaim(claim);
        const placeholder: G2File = { version: 1, config: capture,
          agentKey: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
          inbox: [], jobs: [], reports: [], grantState: "claiming" };
        claimSelfTestFile(claim.file, placeholder);
        providerEntries += 1;
        assert.throws(() => publishG2GrantedOutput({ claim, publicKey, permissions, privateKey, keypair,
          config: placeholder.config, job: { id: claim.jobId, status: "ACTIVE", strategyId: "self-test-rebalance-g2",
            tradingWalletAddress: claim.wallet, allocationUWei: (10n * 10n ** 18n).toString(10),
            dailyCapUWei: (20n * 10n ** 18n).toString(10), termDays: 2, startedAtMs: 1_000,
            endsAtMs: 1_000 + 2 * 86_400_000, sessionExpiresAtMs: claim.expirySec * 1000, revokedAtMs: null },
          grantNativeDebitWei: 1n, fault: (point) => { if (point === boundary) throw new Error("injected"); } }));
      }
      assert.throws(() => { createG2GrantClaim({ ...claim, file: resolve(G2_JOBS[75].file),
        database: G2_JOBS[75].db, role: G2_JOBS[75].db, jobId: G2_JOBS[75].job,
        fileFactsDigest: g2ProposedFileDigest(75, G2_JOBS[75].file) }); providerEntries += 1; });
      assert.ok(providerEntries <= 1);
      assert.ok(existsSync(g2ClaimPath(claim.wallet)) || existsSync(`${g2ClaimPath(claim.wallet)}.guard`));
    });
  }
});

test("G2 successful publication persists ciphertext-only facts and report append keeps ready digest", async () => {
  const capture = loadG2FileProfiles().block;
  const before = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "quant-g2-publication-"));
  try {
    process.chdir(directory);
    mkdirSync("scripts/tmp", { recursive: true });
    const privateKey = generatePrivateKey();
    const publicKey = privateKeyToAccount(privateKey).publicKey;
    const keypair = quantKeypairFromSeed(`0x${randomBytes(32).toString("hex")}`);
    const first = r3Claim(10);
    const spec = g2SessionSpec({ allocation: 10, riskCaps: { WBNB: 20n * 10n ** 18n },
      verifiedPreGrantPaymentMaxWei: null, expiresAt: first.expirySec, nowSeconds: first.expirySec - 2 * 86_400,
      wallet: first.wallet });
    const permissions = { calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
      ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
      spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
        limit: cap.limit, period: cap.period })) };
    const parsed = parseSessionPlaintext(serializeGrantedSession({ walletAddress: first.wallet, publicKey,
      expiry: first.expirySec, permissions, privateKey }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const claim = { ...first, publicKey, keyId: keccak256(publicKey),
      permissionsDigest: permissionsDigest(parsed.session.permissions) };
    createG2GrantClaim(claim);
    claimSelfTestFile(claim.file, { version: 1, config: capture,
      agentKey: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
      inbox: [], jobs: [], reports: [], grantState: "claiming" } as G2File);
    const ready = publishG2GrantedOutput({ claim, publicKey, permissions, privateKey, keypair,
      config: capture, job: { id: claim.jobId, status: "ACTIVE", strategyId: "self-test-rebalance-g2",
        tradingWalletAddress: claim.wallet, allocationUWei: (10n * 10n ** 18n).toString(10),
        dailyCapUWei: (20n * 10n ** 18n).toString(10), termDays: 2, startedAtMs: 1_000,
        endsAtMs: 1_000 + 2 * 86_400_000, sessionExpiresAtMs: claim.expirySec * 1000, revokedAtMs: null },
      grantNativeDebitWei: 1n });
    const bytes = readFileSync(claim.file, "utf8");
    assert.equal(bytes.includes(privateKey), false);
    assert.equal(bytes.includes('"signer"'), false);
    assert.equal(readG2ReadyFile(claim.file, 10, keypair).reports.length, 0);
    const transport = new FileQuantTransport(claim.file,
      { u: getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
        wbnb: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
        router: getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E") }, capture);
    const payload = { trades: [{ txHash: `0x${"ab".repeat(32)}` as Hex, note: "buy:WBNB" }] };
    const report = await transport.report(claim.jobId, payload);
    assert.equal(report.ok, true);
    assert.equal(readG2ReadyFile(claim.file, 10, keypair).reports.length, 1);
    await transport.report(claim.jobId, payload);
    const retried = readG2ReadyFile(claim.file, 10, keypair);
    assert.equal(retried.reports.length, 2);
    assert.deepEqual(retried.reports[0]?.payload, retried.reports[1]?.payload);
    assert.equal(readG2GrantClaim(claim.wallet).outputDigest, ready.outputDigest);
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("G2 file transport reaches production discovery, admission and one bootstrap submit", async () => {
  const capture = loadG2FileProfiles();
  const before = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "quant-g2-worker-"));
  try {
    process.chdir(directory);
    mkdirSync("scripts/tmp", { recursive: true });
    const privateKey = generatePrivateKey();
    const publicKey = privateKeyToAccount(privateKey).publicKey;
    const keypair = quantKeypairFromSeed(`0x${randomBytes(32).toString("hex")}`);
    const base = r3Claim(10);
    const nowMs = (base.expirySec - 2 * 86_400) * 1000;
    const spec = g2SessionSpec({ allocation: 10, riskCaps: { WBNB: 20n * 10n ** 18n },
      verifiedPreGrantPaymentMaxWei: null, expiresAt: base.expirySec,
      nowSeconds: Math.floor(nowMs / 1000), wallet: base.wallet });
    const permissions = { calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
      ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
      spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
        limit: cap.limit, period: cap.period })) };
    const proposed = parseSessionPlaintext(serializeGrantedSession({ walletAddress: base.wallet,
      publicKey, expiry: base.expirySec, permissions, privateKey }));
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const claim = { ...base, publicKey, keyId: keccak256(publicKey),
      permissionsDigest: permissionsDigest(proposed.session.permissions) };
    createG2GrantClaim(claim);
    claimSelfTestFile(claim.file, { version: 1, config: capture.block,
      agentKey: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
      inbox: [], jobs: [], reports: [], grantState: "claiming" } as G2File);
    publishG2GrantedOutput({ claim, publicKey, permissions, privateKey, keypair, config: capture.block,
      job: { id: claim.jobId, status: "ACTIVE", strategyId: "self-test-rebalance-g2",
        tradingWalletAddress: claim.wallet, allocationUWei: (10n * 10n ** 18n).toString(10),
        dailyCapUWei: (20n * 10n ** 18n).toString(10), termDays: 2,
        startedAtMs: nowMs - 1000, endsAtMs: nowMs + 2 * 86_400_000,
        sessionExpiresAtMs: base.expirySec * 1000, revokedAtMs: null }, grantNativeDebitWei: 1n });
    const transport = new FileQuantTransport(claim.file,
      { u: getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
        wbnb: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
        router: getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E") }, capture.block);
    const claims = new MemoryQuantWalletClaimStore(undefined, true);
    const store = new MemoryQuantRebalanceStore(claims);
    let submits = 0; let reports = 0; let currentNow = nowMs;
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const actual = { USDC: 100n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n };
    const protectedBalances = { ...actual, USDC: 90n * 10n ** 18n };
    const deps: QuantRebalanceWorkerDeps = { store, claims, journal: {} as ExecutionJournal,
      transport, provider: {} as WalletProvider, reader: {} as QuantChainReader, keypair,
      strategyId: "self-test-rebalance-g2", agentId: "self-test-rebalance-g2",
      capabilityProfile: capture.capability, nowMs: () => currentNow, intervalMs: 300_000,
      async admitChain() { return { ok: true, baselineBlock: 100n, baselineHash: hash, baselineAtMs: nowMs,
        actualBalances: actual, protectedBalances }; },
      async readPortfolio() { return { ok: true, observation: { blockNumber: 100n, blockHash: hash,
        observedAtMs: nowMs, actualBalances: actual,
        values: { USDC: 10n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n }, marks: [],
        nativeBalanceWei: 10n ** 16n, gasPriceWei: 50_000_000n } }; },
      async priceLeg({ job, check, leg }) {
        assert.equal(leg.kind, "buy");
        return { calls: [], requiredNativeWei: 1n, action: { jobId: job.jobId, checkId: check.checkId,
          sequence: job.actionSequence + 1n, side: "buy", asset: "WBNB", tokenIn: getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
          tokenOut: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
          path: [getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
            getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c")],
          pairAddresses: [getAddress("0xd99c7f6c65857ac913a8f880a4cb84032ab2fc5b")],
          amountInWei: leg.amountInWei, minOutWei: 1n, quoteOutWei: 1n,
          deadlineSec: Math.floor(nowMs / 1000) + 300, callsJson: "[]", callsDigest: hash,
          policyDigest: job.policyDigest!, permissionsDigest: job.permissionsDigest!, projectionDigest: job.projectionDigest!,
          claimGeneration: job.claimGeneration!, quoteBlockNumber: 100n, quoteBlockHash: hash, quoteObservedAtMs: nowMs,
          referenceBlockNumber: 100n, referenceBlockHash: hash, referenceObservedAtMs: nowMs,
          referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: leg.amountInWei } };
      },
      async revalidatePlan() { return true; }, async recoverAction() { return { kind: "waiting" }; },
      async readCurrentWire(job) { const answer = await transport.job(job.jobId); return answer.ok ? answer.data : null; },
      async reportJob() { reports += 1; return { ok: true, payloadDigest: hash, responseStatus: 200, notesApplied: 0 }; },
      async submitAction() { submits += 1; return { kind: "committed", receipt: { status: "CONFIRMED" } }; },
    };
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(report.jobsSeen, 1);
    assert.equal(report.actions, 1);
    assert.equal(submits, 1);
    const wire = await transport.job(claim.jobId);
    assert.equal(wire.ok, true);
    if (wire.ok) assert.equal((await store.getJob(claim.jobId))?.wireDigest, quantRebalanceImmutableWireDigest(wire.data));
    assert.equal((await store.listActions(claim.jobId)).length, 1);
    await runQuantRebalanceWorkerOnce({ ...deps });
    assert.equal(submits, 1, "restart may recover but cannot create a second submit while the prior action is unresolved");
    currentNow = nowMs + 2 * 86_400_000 + 1;
    await runQuantRebalanceWorkerOnce({ ...deps });
    assert.equal((await store.getJob(claim.jobId))?.status, "ended-unresolved");
    assert.equal(reports, 0);
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("G2 file transport completes a settled buy, sell, later buy, restart and trades-only term report", async () => {
  const capture = loadG2FileProfiles();
  const before = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "quant-g2-cycle-"));
  try {
    process.chdir(directory);
    mkdirSync("scripts/tmp", { recursive: true });
    const wallet = getAddress("0x1111111111111111111111111111111111111111");
    const usdc = getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
    const wbnb = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
    const pair = getAddress("0xd99c7f6c65857ac913a8f880a4cb84032ab2fc5b");
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const keypair = quantKeypairFromSeed(`0x${randomBytes(32).toString("hex")}`);
    const privateKey = generatePrivateKey();
    const publicKey = privateKeyToAccount(privateKey).publicKey;
    let clock = 1_900_000_000_000;
    let spot = 1000n;
    const endsAtMs = clock + 2 * 86_400_000;
    const expiry = Math.floor(endsAtMs / 1000) + 600;
    const spec = g2SessionSpec({ allocation: 10, riskCaps: { WBNB: 20n * 10n ** 18n },
      verifiedPreGrantPaymentMaxWei: null, expiresAt: expiry, nowSeconds: Math.floor(clock / 1000), wallet });
    const session = serializeGrantedSession({ walletAddress: wallet, publicKey, expiry, privateKey,
      permissions: { calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
        ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
        spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
          limit: cap.limit, period: cap.period })) } });
    const envelope = seal(session, keypair.publicKey);
    const filePath = resolve(G2_JOBS[10].file);
    writeSelfTestFile(filePath, { version: 1, config: capture.block,
      agentKey: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
      inbox: [{ envelopeId: "env-low10", quantJobId: G2_JOBS[10].job, ...envelope }],
      jobs: [{ id: G2_JOBS[10].job, status: "ACTIVE", strategyId: "self-test-rebalance-g2",
        tradingWalletAddress: wallet, allocationUWei: (10n * 10n ** 18n).toString(10),
        dailyCapUWei: (20n * 10n ** 18n).toString(10), termDays: 2, startedAtMs: clock - 1000,
        endsAtMs, sessionExpiresAtMs: expiry * 1000, revokedAtMs: null }], reports: [] });
    const transport = new FileQuantTransport(filePath,
      { u: usdc, wbnb, router: getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E") }, capture.block);
    const claims = new MemoryQuantWalletClaimStore(undefined, true);
    const store = new MemoryQuantRebalanceStore(claims);
    let submits = 0; let reportCalls = 0; let reportAvailable = false;
    const deps: QuantRebalanceWorkerDeps = { store, claims, journal: {} as ExecutionJournal, transport,
      provider: {} as WalletProvider, reader: {} as QuantChainReader, keypair,
      strategyId: "self-test-rebalance-g2", agentId: "self-test-rebalance-g2",
      capabilityProfile: capture.capability, nowMs: () => clock, intervalMs: 300_000,
      async admitChain() { return { ok: true, baselineBlock: 100n, baselineHash: hash, baselineAtMs: clock,
        actualBalances: { USDC: 100n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
        protectedBalances: { USDC: 90n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n } }; },
      async readPortfolio({ job }) {
        const managed = job.managed ?? { USDC: 10n * 10n ** 18n, WBNB: 0n, ETH: 0n, CAKE: 0n };
        const wbnbValue = managed.WBNB * spot;
        const actualBalances = { USDC: 90n * 10n ** 18n + managed.USDC, WBNB: managed.WBNB,
          ETH: 0n, CAKE: 0n, USDT: 0n };
        return { ok: true, observation: { blockNumber: 100n, blockHash: hash, observedAtMs: clock,
          actualBalances, values: { USDC: managed.USDC, WBNB: wbnbValue, ETH: 0n, CAKE: 0n },
          marks: managed.WBNB === 0n ? [] : [{ asset: "WBNB" as const, quantityWei: managed.WBNB,
            usdcOutWei: wbnbValue, path: [wbnb, usdc], blockNumber: 100n, blockHash: hash,
            observedAtMs: clock, pairAddresses: [pair], referenceEvidenceDigest: hash }],
          nativeBalanceWei: 10n ** 16n, gasPriceWei: 50_000_000n } };
      },
      async priceLeg({ job, check, leg }) {
        assert.ok(leg.kind === "buy" || leg.kind === "sell");
        const output = leg.kind === "buy" ? leg.amountInWei / spot : leg.amountInWei * spot;
        return { calls: [], requiredNativeWei: 1n, action: { jobId: job.jobId, checkId: check.checkId,
          sequence: job.actionSequence + 1n, side: leg.kind, asset: "WBNB", tokenIn: leg.kind === "buy" ? usdc : wbnb,
          tokenOut: leg.kind === "buy" ? wbnb : usdc, path: leg.kind === "buy" ? [usdc, wbnb] : [wbnb, usdc],
          pairAddresses: [pair], amountInWei: leg.amountInWei, minOutWei: 1n, quoteOutWei: output,
          deadlineSec: Math.floor(clock / 1000) + 300, callsJson: "[]", callsDigest: hash,
          policyDigest: job.policyDigest!, permissionsDigest: job.permissionsDigest!, projectionDigest: job.projectionDigest!,
          claimGeneration: job.claimGeneration!, quoteBlockNumber: 100n, quoteBlockHash: hash, quoteObservedAtMs: clock,
          referenceBlockNumber: 100n, referenceBlockHash: hash, referenceObservedAtMs: clock,
          referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: leg.amountInWei } };
      },
      async revalidatePlan() { return true; },
      async readCurrentWire(job) { const result = await transport.job(job.jobId); return result.ok ? result.data : null; },
      async submitAction({ action }) {
        const marked = await store.markSubmitted({ actionId: action.actionId, expectedRowVersion: action.rowVersion,
          claimGeneration: action.claimGeneration, blockNumber: action.quoteBlockNumber,
          blockHash: action.quoteBlockHash, nowMs: clock, revalidate: async () => true });
        assert.equal(marked.kind, "ok");
        submits += 1;
        return { kind: "pending", receipt: { status: "PENDING", callsId: hash } };
      },
      async recoverAction(_job, action) {
        const txHash = `0x${action.sequence.toString(16).padStart(64, "0")}` as Hex;
        const proof = brandVerifiedReceiptProof({ chainId: 56, txHash, blockNumber: action.quoteBlockNumber + 1n,
          blockHash: hash, transactionIndex: 0n, wallet, nonce: action.sequence, keyHash: hash,
          fillInWei: action.amountInWei, fillOutWei: action.quoteOutWei,
          swapLogIndices: [0n], proofDigest: keccak256(stringToBytes(action.actionId)) });
        const settled = await store.settleAction({ actionId: action.actionId, expectedRowVersion: action.rowVersion,
          proof, ownership: [{ txHash, wallet, swapLogIndex: 0n, journalKey: action.journalKey }], nowMs: clock });
        return settled.kind === "ok" ? { kind: "settled" } : { kind: "waiting" };
      },
      async reportJob(job, actions) {
        reportCalls += 1;
        const payload = buildQuantRebalanceReportPayload(actions);
        const payloadDigest = keccak256(stringToBytes(rebalanceCanonicalEncode(payload)));
        if (!reportAvailable) return { ok: false, code: "report-unavailable", payloadDigest,
          responseStatus: 0, notesApplied: null };
        const ack = await transport.report(job.jobId, payload);
        return ack.ok ? { ok: true, payloadDigest, responseStatus: 200, notesApplied: ack.data.notesApplied }
          : { ok: false, code: "report-unavailable", payloadDigest, responseStatus: 0, notesApplied: null };
      },
    };
    const tick = async () => runQuantRebalanceWorkerOnce(deps);
    await tick();
    assert.equal(submits, 1);
    clock += 1000; await tick();
    spot = 1500n; clock += 300_000; await tick();
    assert.equal(submits, 2);
    clock += 1000; await tick();
    spot = 500n; clock += 300_000; await tick();
    assert.equal(submits, 3);
    clock += 1000; await tick();
    const actions = await store.listActions(G2_JOBS[10].job);
    assert.equal(actions.filter((action) => action.state === "settled").length, 3);
    assert.equal(g2SubmissionVerdict(actions, 10).stop, "routes-complete");
    clock = endsAtMs + 1; await tick();
    assert.equal(reportCalls, 1);
    assert.equal((await store.getJob(G2_JOBS[10].job))?.reportedAtMs, null);
    assert.equal((JSON.parse(readFileSync(filePath, "utf8") as string) as G2File).reports.length, 0);
    reportAvailable = true; await tick();
    assert.equal(reportCalls, 2);
    assert.equal((await store.getJob(G2_JOBS[10].job))?.status, "reported");
    assert.deepEqual(readFileSync(filePath, "utf8").includes('"signer"'), false);
    const reports = JSON.parse(readFileSync(filePath, "utf8") as string) as G2File;
    assert.equal(reports.reports.length, 1);
    assert.deepEqual(reports.reports[0]?.payload.trades.map((trade) => trade.note),
      ["buy:WBNB", "sell:WBNB", "buy:WBNB"]);
    await tick();
    assert.equal(reportCalls, 2);
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
});
