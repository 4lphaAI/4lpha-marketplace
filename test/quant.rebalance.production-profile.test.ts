/** G1: the first reviewed production profiles and the guards that keep file profiles out of production. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, keccak256, type Hex } from "viem";
import { parseConfigBlock } from "../src/quant/termix.js";
import {
  assertProductionRebalanceProfiles, assertProductionRebalanceRegistries, findCapabilityProfile,
  findExpandedConfigProfile, normalizeExpandedQuantConfig, quantExpandedConfigDigest,
  QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES,
  type QuantExpandedConfigProfile, type QuantRebalanceCapabilityProfile,
} from "../src/quant/rebalanceConfig.js";
import {
  G1_EVIDENCE_DIGEST, PRODUCTION_EXPANDED_CONFIG_PROFILE, PRODUCTION_REBALANCE_CAPABILITY_PROFILE,
} from "../src/quant/rebalanceProductionProfiles.js";
import { G2_CAPTURE_SHA256, G2_FINITE_JOB, loadG2FileProfiles } from "../src/quant/rebalanceSelftest.js";
import {
  E18, G2_FILE_CAPABILITY_ID, G2_FINITE_CAPABILITY_ID, HIGH_TIER, LOW_TIER, REBALANCE_CAKE, REBALANCE_ETH,
  REBALANCE_MAX_GAS_PRICE_WEI, REBALANCE_NATIVE_FEE_PAD_BPS, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_USDT,
  REBALANCE_VERSION, REBALANCE_WBNB, BPS, ceilDiv, rebalanceJobPolicyDigest, rebalanceJobPolicyProjection,
  rebalancePolicyProjection, rebalanceTierForProfile, requiredNativeReserve,
} from "../src/quant/rebalancePolicy.js";
import { admitRebalanceSession } from "../src/quant/rebalanceAdmission.js";
import { parseSessionPlaintext } from "../src/quant/admission.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { seal } from "../src/quant/envelope.js";
import { runQuantRebalanceWorkerOnce, type QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import type { QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import { MemoryQuantRebalanceStore, type QuantRebalanceStore } from "../src/store/quantRebalance.js";
import { MemoryQuantWalletClaimStore, type QuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { encodeJsonbParam } from "../src/store/codec.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { ExecutionJournal } from "../src/store/journal.js";
import type { WalletProvider } from "../src/core/types.js";
import { main as daemonMain } from "../scripts/quant-rebalance-worker.js";
import { assertQuantRebalanceBoot } from "../scripts/quantRebalanceWorkerDeps.js";

const CONFIG_ID = "termix-quant-config-2026-09-27-v1";
const CAPABILITY_ID = "termix-rebalance-wizard-v1";
const FIXTURE = new URL("./fixtures/quant/contracts-customization-quant.json", import.meta.url);
const R146_FIXTURE = new URL("./fixtures/quant/termix-config-2026-09-30.json", import.meta.url);
const EVIDENCE = new URL("../MD here/QUANT-REBALANCING-G1-EVIDENCE.md", import.meta.url);
const HASH = `0x${"ab".repeat(32)}` as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

function projectionOf(bytes: Buffer) {
  const parsed = parseConfigBlock(JSON.parse(bytes.toString("utf8")) as unknown);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("fixture-parse");
  const normalized = normalizeExpandedQuantConfig(parsed.data);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) throw new Error("fixture-normalize");
  return normalized.projection;
}

describe("B1: the embedded config profile", () => {
  it("is the normalized projection of the SHA-pinned capture, written out literally", () => {
    const bytes = readFileSync(FIXTURE);
    assert.equal(createHash("sha256").update(bytes).digest("hex").toUpperCase(), G2_CAPTURE_SHA256);
    const projection = projectionOf(bytes);
    assert.deepEqual(PRODUCTION_EXPANDED_CONFIG_PROFILE.expected, projection);
    assert.equal(quantExpandedConfigDigest(PRODUCTION_EXPANDED_CONFIG_PROFILE.expected), quantExpandedConfigDigest(projection));
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.id, CONFIG_ID);
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.expectedVenueRowCount, 14);
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.expectedUniqueVenueTargetCount, 12);
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.capturedEvidenceDigest,
      "0xBF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46");
    assert.ok(PRODUCTION_EXPANDED_CONFIG_PROFILE.capturedEvidenceRef.includes(G2_CAPTURE_SHA256));
    assert.ok(PRODUCTION_EXPANDED_CONFIG_PROFILE.capturedEvidenceRef.includes(
      "BF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46"));
    assert.equal(findExpandedConfigProfile(projection), PRODUCTION_EXPANDED_CONFIG_PROFILE);
  });

  it("matches the 2026-09-30 live projection recorded by R14.6, once that fixture is in the tree", (t) => {
    if (!existsSync(R146_FIXTURE)) {
      t.skip("test/fixtures/quant/termix-config-2026-09-30.json is not in this tree; pending for the merge with R14.6");
      return;
    }
    assert.deepEqual(projectionOf(readFileSync(R146_FIXTURE)), PRODUCTION_EXPANDED_CONFIG_PROFILE.expected);
  });
});

describe("B2: the production capability profile", () => {
  it("holds exactly the reviewed shape, six routes and the relay gas-equivalent ceiling", () => {
    const profile = PRODUCTION_REBALANCE_CAPABILITY_PROFILE;
    assert.equal(profile.id, CAPABILITY_ID);
    assert.equal(profile.capturedConfigProfileId, CONFIG_ID);
    assert.equal(profile.wireVersion, "quant-job-v1");
    assert.deepEqual(profile.grantShapes, ["whole-contract"]);
    assert.deepEqual(profile.toleratedGrantTargets, []);
    assert.deepEqual(profile.duplicateWholeGrantTargets, [REBALANCE_USDC]);
    // Exactly the routes the G2 rehearsals executed, and the reference paths they were compared against.
    const rehearsed = loadG2FileProfiles().capability;
    assert.deepEqual(profile.executionRoutes, rehearsed.executionRoutes);
    assert.deepEqual(profile.referenceRoutes, rehearsed.referenceRoutes);
    assert.equal(profile.executionRoutes.length, 6);
    assert.equal(profile.referenceRoutes.length, 6);
    assert.equal(profile.maximumExitGasUnits, 700_000n);
    assert.equal(profile.indexingEvidenceDigest, G1_EVIDENCE_DIGEST);
    assert.equal(profile.reportEvidenceDigest, G1_EVIDENCE_DIGEST);
  });

  it("is registered, is not a file id, and receives the production tiers and policy", () => {
    assert.deepEqual(QUANT_EXPANDED_CONFIG_PROFILES, [PRODUCTION_EXPANDED_CONFIG_PROFILE]);
    assert.deepEqual(QUANT_REBALANCE_CAPABILITY_PROFILES, [PRODUCTION_REBALANCE_CAPABILITY_PROFILE]);
    assert.equal(findCapabilityProfile(CAPABILITY_ID), PRODUCTION_REBALANCE_CAPABILITY_PROFILE);
    assert.equal(CAPABILITY_ID.startsWith("g2-") || CAPABILITY_ID.startsWith("quant-rebalance-g2-"), false);
    for (const [allocation, tier] of [[10n, LOW_TIER], [74n, LOW_TIER], [75n, HIGH_TIER], [1_000n, HIGH_TIER]] as const) {
      const decision = rebalanceTierForProfile(allocation * E18, CAPABILITY_ID);
      assert.equal(decision.ok && decision.tier, tier);
    }
    const projection = rebalancePolicyProjection(CAPABILITY_ID);
    assert.equal(projection.version, REBALANCE_VERSION);
    assert.deepEqual(projection.tiers, [LOW_TIER, HIGH_TIER]);
    assert.equal(projection.maxGasPriceWei, REBALANCE_MAX_GAS_PRICE_WEI);
    assert.equal("finiteSchedule" in projection, false);
    assert.deepEqual({ ...projection, capabilityProfileId: null }, rebalancePolicyProjection(null));
    for (const id of [G2_FILE_CAPABILITY_ID, G2_FINITE_CAPABILITY_ID]) {
      assert.notDeepEqual(rebalancePolicyProjection(id).tiers, projection.tiers);
    }
  });

  it("admits only the whole-contract wizard shape, USDC at most twice, and no extra targets", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
    const wizard = JSON.parse(readFileSync(new URL("./fixtures/quant/wizard-session-shape.json", import.meta.url), "utf8")) as
      { permissions: { calls: { to: string }[]; spend: unknown[] } };
    const nowMs = (1_800_000_000 - 2 * 86_400) * 1_000;
    const session = (permissions: unknown) => {
      const result = parseSessionPlaintext(JSON.stringify({ ...fixture.session, permissions }));
      assert.equal(result.ok, true, result.ok ? "" : result.code);
      if (!result.ok) throw new Error("session");
      return result.session;
    };
    const record = (s: ReturnType<typeof session>, allocation: bigint): QuantJobRecord => ({
      id: "prod-admission", status: "ACTIVE", strategyId: "strategy-prod", tradingWalletAddress: getAddress(s.walletAddress),
      allocationUWei: allocation, dailyCapUWei: allocation, termDays: 30, startedAtMs: nowMs - 60_000,
      endsAtMs: s.expiry * 1_000, sessionExpiresAtMs: s.expiry * 1_000, revokedAtMs: null,
    });
    const admit = (permissions: unknown, allocation: bigint) => {
      const s = session(permissions);
      return admitRebalanceSession({ session: s, job: record(s, allocation), capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE, nowMs });
    };
    const clone = () => structuredClone(wizard.permissions) as { calls: { to: string; signature?: string }[]; spend: unknown[] };

    const low = admit(wizard.permissions, 10n * E18);
    assert.equal(low.ok, true, low.ok ? "" : low.code);
    if (low.ok) assert.equal(low.grantShape, "whole-contract");

    const thrice = clone(); thrice.calls.push({ to: REBALANCE_USDC });
    const duplicated = admit(thrice, 10n * E18);
    assert.equal(duplicated.ok, false); if (!duplicated.ok) assert.equal(duplicated.code, "session-grant-duplicate");

    const extra = clone(); extra.calls.push({ to: REBALANCE_USDT });
    const excess = admit(extra, 10n * E18);
    assert.equal(excess.ok, false); if (!excess.ok) assert.equal(excess.code, "session-grant-excess");

    const scoped = { calls: [
      { to: REBALANCE_ROUTER, signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" },
      { to: REBALANCE_USDC, signature: "approve(address,uint256)" },
      { to: REBALANCE_WBNB, signature: "approve(address,uint256)" },
    ], spend: wizard.permissions.spend };
    const selector = admit(scoped, 10n * E18);
    assert.equal(selector.ok, false); if (!selector.ok) assert.equal(selector.code, "capability-grant-shape-unconfirmed");

    const high = clone();
    high.calls.push({ to: REBALANCE_ETH }, { to: REBALANCE_CAKE });
    high.spend = [
      { token: REBALANCE_USDC, limit: { $bigint: (75n * E18).toString() }, period: "day" },
      { limit: { $bigint: "50000000000000000" }, period: "day" },
      { token: REBALANCE_WBNB, limit: { $bigint: (100n * E18).toString() }, period: "day" },
      { token: REBALANCE_ETH, limit: { $bigint: (100n * E18).toString() }, period: "day" },
      { token: REBALANCE_CAKE, limit: { $bigint: (100n * E18).toString() }, period: "day" },
    ];
    const admittedHigh = admit(high, 75n * E18);
    assert.equal(admittedHigh.ok, true, admittedHigh.ok ? "" : admittedHigh.code);
  });
});

describe("B3: the exit gas-equivalent ceiling", () => {
  it("rounds the observed two-hop maximum up and pins the reserve arithmetic and its floor boundary", () => {
    const observedTwoHopPaymentMax = 33_064_915_000_000n;
    const gasPrice = 50_000_000n;
    // 661,298.3 units: 661,298 is one unit short, 661,299 is the first integer that covers it.
    assert.ok(661_298n * gasPrice < observedTwoHopPaymentMax);
    assert.ok(661_299n * gasPrice >= observedTwoHopPaymentMax);
    const units = PRODUCTION_REBALANCE_CAPABILITY_PROFILE.maximumExitGasUnits;
    assert.ok(units > 661_299n);
    assert.equal(ceilDiv(observedTwoHopPaymentMax * REBALANCE_NATIVE_FEE_PAD_BPS, BPS), 49_597_372_500_000n);
    const reserve = (gasPriceWei: bigint) => requiredNativeReserve({ side: "buy", ownSolvencyWei: 49_597_372_500_000n,
      gasPriceWei, maximumExitGasUnits: units, managed: { WBNB: 1n, ETH: 0n, CAKE: 0n }, asset: "ETH", resultingQuantityWei: 1n });
    // One held position plus the new one: two future exits of 700,000 x 50,000,000 x 1.5 = 52.5e12 each.
    assert.equal(reserve(gasPrice), 49_597_372_500_000n + 2n * 52_500_000_000_000n);
    // The 3e13 floor binds at 28,571,428 wei/gas and is exceeded one wei of gas price later.
    assert.equal(reserve(28_571_428n), 49_597_372_500_000n + 2n * 30_000_000_000_000n);
    assert.equal(reserve(28_571_429n), 49_597_372_500_000n + 2n * 30_000_000_450_000n);
  });
});

describe("B4: evidence digests", () => {
  it("are the keccak256 of the committed evidence document, which is -text and labels its sections", () => {
    const bytes = readFileSync(EVIDENCE);
    assert.equal(bytes.includes(13), false, "the document must hold LF bytes only");
    const digest = keccak256(bytes);
    assert.equal(digest, G1_EVIDENCE_DIGEST);
    assert.equal(PRODUCTION_REBALANCE_CAPABILITY_PROFILE.indexingEvidenceDigest, digest);
    assert.equal(PRODUCTION_REBALANCE_CAPABILITY_PROFILE.reportEvidenceDigest, digest);
    assert.notEqual(digest, ZERO_HASH);
    const text = bytes.toString("utf8");
    assert.ok(text.includes("## (a) Operator-relayed TermiX answers, 2026-09-28"));
    assert.ok(text.includes("paraphrase relayed by the operator, not verbatim") || text.includes("Paraphrase relayed by the operator, not verbatim"));
    assert.ok(text.includes("## (b) Chain rehearsal evidence"));
    assert.ok(text.includes("## (c) Platform acceptance"));
    assert.ok(text.includes("pending — first pilot job (G3 amendment)"));
    const attributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
    assert.ok(/^\*\*\/QUANT-REBALANCING-G1-EVIDENCE\.md -text$/mu.test(attributes.replaceAll("\r\n", "\n")));
  });
});

describe("B5: the production validator", () => {
  const config = PRODUCTION_EXPANDED_CONFIG_PROFILE;
  const capability = PRODUCTION_REBALANCE_CAPABILITY_PROFILE;

  it("accepts the reviewed pair and both registries", () => {
    assert.doesNotThrow(() => assertProductionRebalanceProfiles(config, capability));
    assert.doesNotThrow(() => assertProductionRebalanceRegistries(QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES));
  });

  it("refuses each forbidden field", () => {
    const registries = (c: QuantExpandedConfigProfile, k: QuantRebalanceCapabilityProfile, extra: readonly QuantRebalanceCapabilityProfile[] = []) =>
      () => assertProductionRebalanceRegistries([c], [k, ...extra]);
    const withCapability = (patch: Partial<QuantRebalanceCapabilityProfile>): QuantRebalanceCapabilityProfile => ({ ...capability, ...patch });
    const reserved = ["g2-file-direct-wbnb-v1", "quant-rebalance-g2-high75-finite-v2", "g2-file-capture-bf3d32b1-v1",
      "g2-anything", "quant-rebalance-g2-anything", ""];
    for (const id of reserved) {
      assert.throws(registries(config, withCapability({ id })), /production-profile-id-reserved/u, id);
      assert.throws(() => assertProductionRebalanceRegistries([{ ...config, id }], []), /production-profile-id-reserved/u, id);
    }
    for (const field of ["indexingEvidenceDigest", "reportEvidenceDigest"] as const) {
      assert.throws(registries(config, withCapability({ [field]: ZERO_HASH })), /production-profile-digest-invalid/u, field);
      assert.throws(registries(config, withCapability({ [field]: "0x1234" as Hex })), /production-profile-digest-invalid/u, field);
    }
    assert.throws(() => assertProductionRebalanceRegistries([{ ...config, capturedEvidenceDigest: ZERO_HASH }], []), /production-profile-digest-invalid/u);
    assert.throws(registries(config, withCapability({ wireVersion: "quant-job-v1-file" })), /production-profile-wire-invalid/u);
    assert.throws(registries(config, withCapability({ wireVersion: "fixture-v1" })), /production-profile-wire-invalid/u);
    assert.throws(registries(config, withCapability({ capturedConfigProfileId: "another-config" })), /production-profile-config-mismatch/u);
    assert.throws(registries(config, withCapability({ executionRoutes: [] })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, withCapability({ referenceRoutes: [] })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, withCapability({ maximumExitGasUnits: 0n })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, withCapability({ maximumExitGasUnits: -1n })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, capability, [capability]), /production-profile-id-duplicate/u);
    assert.throws(() => assertProductionRebalanceRegistries([config, config], []), /production-profile-id-duplicate/u);
  });

  it("refuses any pair that is not reference-equal to the registry entries", () => {
    const file = loadG2FileProfiles();
    const finite = loadG2FileProfiles(true);
    assert.throws(() => assertProductionRebalanceProfiles(file.config, file.capability), /production-profile-id-reserved/u);
    assert.throws(() => assertProductionRebalanceProfiles(finite.config, finite.capability), /production-profile-id-reserved/u);
    // A renamed zero-sentinel file profile keeps a non-reserved id and is still refused by the sentinel and wire checks.
    const renamed = { ...file.capability, id: "renamed-production-looking", capturedConfigProfileId: config.id };
    assert.throws(() => assertProductionRebalanceProfiles(config, renamed), /production-profile-digest-invalid/u);
    const renamedWire = { ...renamed, indexingEvidenceDigest: HASH, reportEvidenceDigest: HASH };
    assert.throws(() => assertProductionRebalanceProfiles(config, renamedWire), /production-profile-wire-invalid/u);
    // Everything valid, but a copy: registered by value, not by reference.
    assert.throws(() => assertProductionRebalanceProfiles(config, { ...capability }), /production-profile-not-registered/u);
    assert.throws(() => assertProductionRebalanceProfiles({ ...config }, capability), /production-profile-not-registered/u);
  });

  it("keeps the file profiles loadable for the G2 CLI without entering the registries", () => {
    const file = loadG2FileProfiles();
    assert.equal(file.capability.wireVersion, "quant-job-v1-file");
    assert.equal(QUANT_EXPANDED_CONFIG_PROFILES.includes(file.config), false);
    assert.equal(QUANT_REBALANCE_CAPABILITY_PROFILES.includes(file.capability), false);
    assert.equal(findCapabilityProfile(file.capability.id), null);
    assert.equal(loadG2FileProfiles(true).capability.id, G2_FINITE_CAPABILITY_ID);
  });
});

function watchedEnv(values: Record<string, string> = {}) {
  const reads: string[] = [];
  const env = new Proxy(values, {
    get(target, key) { if (typeof key === "string") reads.push(key); return target[key as string]; },
  }) as Record<string, string | undefined>;
  return { env, reads };
}

describe("B5: the production daemon entry", () => {
  const file = loadG2FileProfiles();
  const finite = loadG2FileProfiles(true);
  const sentinel = { ...file.capability, id: "renamed-zero-sentinel", wireVersion: "quant-job-v1" };
  const invalid: readonly (readonly [string, QuantExpandedConfigProfile[], QuantRebalanceCapabilityProfile[]])[] = [
    ["G2 file profiles", [file.config], [file.capability]],
    ["G2 finite profiles", [finite.config], [finite.capability]],
    ["a file capability beside the production config", [PRODUCTION_EXPANDED_CONFIG_PROFILE], [PRODUCTION_REBALANCE_CAPABILITY_PROFILE, file.capability]],
    ["a renamed zero-sentinel profile", [{ ...PRODUCTION_EXPANDED_CONFIG_PROFILE }], [{ ...sentinel, capturedConfigProfileId: PRODUCTION_EXPANDED_CONFIG_PROFILE.id }]],
    // Audit finding 5: field-valid copies of the reviewed profiles are still not the registry entries.
    ["valid-looking unregistered copies of both reviewed profiles", QUANT_EXPANDED_CONFIG_PROFILES.map((profile) => ({ ...profile })),
      QUANT_REBALANCE_CAPABILITY_PROFILES.map((profile) => ({ ...profile }))],
    ["an unregistered copy of the capability profile only", [...QUANT_EXPANDED_CONFIG_PROFILES],
      QUANT_REBALANCE_CAPABILITY_PROFILES.map((profile) => ({ ...profile }))],
  ];

  for (const flag of ["true", "false"] as const) {
    it(`refuses an invalid registry before the flag (${flag}), any credential or any network`, async () => {
      for (const [label, configProfiles, capabilityProfiles] of invalid) {
        const { env, reads } = watchedEnv({ QUANT_REBALANCING_ENABLED: flag });
        await assert.rejects(daemonMain({ env, configProfiles, capabilityProfiles }), /production-profile-/u, label);
        assert.deepEqual(reads, [], `${label}: the environment must not be read before validation`);
      }
    });
  }

  for (const flag of ["true", "false"] as const) {
    it(`re-validates the registry entries at entry, before the flag (${flag}), even after a post-load mutation`, async () => {
      const mutable = PRODUCTION_REBALANCE_CAPABILITY_PROFILE as unknown as { indexingEvidenceDigest: Hex };
      const original = mutable.indexingEvidenceDigest;
      mutable.indexingEvidenceDigest = ZERO_HASH;
      try {
        const { env, reads } = watchedEnv({ QUANT_REBALANCING_ENABLED: flag });
        await assert.rejects(daemonMain({ env }), /production-profile-digest-invalid/u);
        assert.deepEqual(reads, []);
      } finally { mutable.indexingEvidenceDigest = original; }
    });
  }

  it("exits quietly with the flag OFF and reaches credentials only when the flag is ON", async (t) => {
    t.mock.method(console, "log", () => undefined);
    const off = watchedEnv({ QUANT_REBALANCING_ENABLED: "false" });
    await daemonMain({ env: off.env });
    assert.deepEqual([...new Set(off.reads)], ["QUANT_REBALANCING_ENABLED"]);
    const on = watchedEnv({ QUANT_REBALANCING_ENABLED: "true" });
    await assert.rejects(daemonMain({ env: on.env }), /EXECUTION_NETWORK=mainnet/u);
    assert.deepEqual([...new Set(on.reads)].sort(), ["EXECUTION_NETWORK", "QUANT_REBALANCING_ENABLED"]);
  });

  it("requires a registered pair at boot before any read, and keeps the G2 file branch explicit", async () => {
    const reachedReader = new Error("reader-reached");
    const ports = {
      config: { chainId: 56 }, transport: {}, provider: {}, keypair: {},
      reader: { chainId: async () => { throw reachedReader; } },
    } as unknown as Parameters<typeof assertQuantRebalanceBoot>[0];
    // Production composition: a file capability with no explicit config profile never reaches a read.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: file.capability }), /production-profile-not-registered/u);
    // A copy of the production capability is not a registry entry.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: { ...PRODUCTION_REBALANCE_CAPABILITY_PROFILE } }),
      /production-profile-not-registered/u);
    // A registered capability can never be paired with an override config.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE,
      configProfile: { ...PRODUCTION_EXPANDED_CONFIG_PROFILE } }), /production-profile-not-registered/u);
    // The production pair passes the guard and proceeds to its first read.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE }), (error) => error === reachedReader);
    // The G2 file branch (explicit config profile, file capability) is unchanged.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: file.capability, configProfile: file.config }), (error) => error === reachedReader);
  });
});

/* -------------------------------------------------------------------------- */
/* The worker boundary: R3.E                                                   */
/* -------------------------------------------------------------------------- */

const WALLET = getAddress("0x1000000000000000000000000000000000000001");
const NOW = 1_900_000_000_000;
const PROD_STRATEGY = "strategy-prod";

function storedRow(input: { readonly jobId: string; readonly profileId: string; readonly status: QuantRebalanceJobRow["status"];
  readonly allocationWei?: bigint; readonly startOffsetMs?: number; readonly strategyId?: string; readonly digestOf?: string }): QuantRebalanceJobRow {
  const allocationWei = input.allocationWei ?? 10n * E18;
  const decision = rebalanceTierForProfile(allocationWei, input.profileId);
  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error("tier");
  const startedAtMs = NOW - 3_600_000 - (input.startOffsetMs ?? 0);
  const endsAtMs = startedAtMs + 30 * 86_400_000;
  const strategyId = input.strategyId ?? PROD_STRATEGY;
  const facts = { capabilityProfileId: input.profileId, jobId: input.jobId, strategyId, allocationWei, tier: decision.tier,
    startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs };
  const projection = rebalanceJobPolicyProjection(facts);
  const digest = rebalanceJobPolicyDigest(input.digestOf === undefined ? facts : { ...facts, jobId: input.digestOf });
  return {
    jobId: input.jobId, strategyId, tradingWallet: WALLET, allocationWei, dailyCapWei: allocationWei, termDays: 30,
    startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs, revokedAtMs: null, platformStatus: "ACTIVE", status: input.status,
    wireJson: "{}", wireDigest: HASH, envelopeJson: null, envelopeId: "env", admittedAtMs: startedAtMs,
    policyJson: encodeJsonbParam(projection), policyDigest: digest, tier: decision.tier.id, sessionPublicKey: `0x${"1".repeat(130)}` as Hex,
    sessionExpirySec: Math.floor(endsAtMs / 1_000), permissionsDigest: HASH, projectionDigest: HASH, descriptorJson: "{}",
    projectionJson: "{}", capRowsJson: "[]", claimGeneration: 1n, baselineBlock: 1n, baselineHash: HASH, baselineAtMs: startedAtMs,
    actualBaselineJson: null, protectedBaselineJson: null, managed: { USDC: allocationWei, WBNB: 0n, ETH: 0n, CAKE: 0n },
    costBasis: { WBNB: 0n, ETH: 0n, CAKE: 0n }, accountingRev: 1n, checkRev: 1n, nextEligibleSlot: 0, actionSequence: 0n,
    lastDeadlineSec: 0, bootstrapComplete: false, externalActivity: false, holdCode: null, holdEvidenceJson: null,
    reportAttempts: 0, reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null, reportedAtMs: null,
    retiredAtMs: null, retirementEvidenceJson: null, rowVersion: 3, createdAtMs: startedAtMs, updatedAtMs: NOW,
  };
}

/** Every port throws except the two the production row check may use; a call is recorded, never absorbed. */
function guardedDeps(input: { readonly rows: QuantRebalanceJobRow[]; readonly profile: QuantRebalanceCapabilityProfile | null;
  readonly inbox?: readonly string[]; readonly freeRecovery?: boolean }) {
  const calls: string[] = []; const holdWrites: { jobId: string; code: string }[] = [];
  const trap = (name: string) => async (): Promise<never> => { calls.push(name); throw new Error(`port-${name}`); };
  const store = {
    async listWorkableJobs() { return input.rows; },
    async setHold(args: { readonly jobId: string; readonly code: string }) {
      holdWrites.push({ jobId: args.jobId, code: args.code });
      const index = input.rows.findIndex((row) => row.jobId === args.jobId);
      const row = input.rows[index];
      if (row !== undefined) input.rows[index] = { ...row, status: row.status === "discovered" ? "discovered" : "held", holdCode: args.code };
    },
    listUnresolvedActions: input.freeRecovery === true ? async () => [] : trap("store.listUnresolvedActions"),
    discoverJob: trap("store.discoverJob"), getJob: trap("store.getJob"), listActions: trap("store.listActions"),
    listChecks: trap("store.listChecks"), markEnded: trap("store.markEnded"), insertAction: trap("store.insertAction"),
  } as unknown as QuantRebalanceStore;
  const deps = {
    store, claims: { migrationInstalled: async () => true, releaseTerminal: trap("claims.releaseTerminal"),
      claimProvisional: trap("claims.claimProvisional") } as unknown as QuantWalletClaimStore,
    journal: {} as ExecutionJournal, provider: {} as WalletProvider, reader: {} as QuantChainReader,
    keypair: quantKeypairFromSeed(`0x${"77".repeat(32)}`), strategyId: PROD_STRATEGY, agentId: "agent-1",
    capabilityProfile: input.profile, nowMs: () => NOW, intervalMs: 60_000,
    transport: {
      async inbox() { return { ok: true, data: { items: (input.inbox ?? []).map((id) => ({ quantJobId: id, envelopeId: `env-${id}` })), nextCursor: null } }; },
      async job(id: string) { calls.push(`transport.job:${id}`); return { ok: false, code: "unavailable" }; },
      config: trap("transport.config"), agentKey: trap("transport.agentKey"), registerKey: trap("transport.registerKey"),
      trades: trap("transport.trades"), report: trap("transport.report"),
    },
    admitChain: trap("admitChain"), readPortfolio: trap("readPortfolio"), priceLeg: trap("priceLeg"),
    revalidatePlan: trap("revalidatePlan"), readCurrentWire: trap("readCurrentWire"),
    recoverAction: trap("recoverAction"), reportJob: trap("reportJob"),
  } as unknown as QuantRebalanceWorkerDeps;
  return { deps, calls, holdWrites };
}

describe("R3.E: the production worker refuses rows it did not derive", () => {
  const production = PRODUCTION_REBALANCE_CAPABILITY_PROFILE;

  it("holds ended, unresolved, reserved-identity and tampered rows with one write each and no other effect", async () => {
    const rows = [
      storedRow({ jobId: "prod-ended-file", profileId: G2_FILE_CAPABILITY_ID, status: "ended" }),
      storedRow({ jobId: "prod-unresolved-finite", profileId: G2_FINITE_CAPABILITY_ID, status: "admitted", allocationWei: 75n * E18 }),
      storedRow({ jobId: G2_FINITE_JOB.job, profileId: CAPABILITY_ID, status: "admitted" }),
      storedRow({ jobId: "prod-tampered", profileId: CAPABILITY_ID, status: "admitted", digestOf: "another-job" }),
      storedRow({ jobId: "prod-strategy", profileId: CAPABILITY_ID, status: "discovered", strategyId: "self-test-rebalance-g2" }),
    ];
    const { deps, calls, holdWrites } = guardedDeps({ rows, profile: production });
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(calls, [], "no per-job network, key, recovery, report or money port may be reached");
    assert.deepEqual(holdWrites.map((write) => write.jobId).sort(), rows.map((row) => row.jobId).sort());
    assert.ok(holdWrites.every((write) => write.code === "production-profile-mismatch"));
    assert.equal(report.jobsSeen, 5); assert.equal(report.holds, 5); assert.equal(report.errors, 0);
    // The hold is written once: a second cycle finds it and writes nothing.
    await runQuantRebalanceWorkerOnce(deps);
    assert.equal(holdWrites.length, 5);
    assert.deepEqual(calls, []);
  });

  it("lets two distinct admitted production jobs, with their own correct digests, reach the normal path", async () => {
    const first = storedRow({ jobId: "prod-job-a", profileId: CAPABILITY_ID, status: "admitted" });
    const second = storedRow({ jobId: "prod-job-b", profileId: CAPABILITY_ID, status: "admitted", allocationWei: 75n * E18, startOffsetMs: 7_200_000 });
    assert.notEqual(first.policyDigest, second.policyDigest);
    assert.equal(second.tier, "high");
    const { deps, calls, holdWrites } = guardedDeps({ rows: [first, second], profile: production, freeRecovery: true });
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(holdWrites, []);
    // The first per-job network read is the TermiX wire refresh; the fake answers "unavailable".
    assert.deepEqual([...calls].sort(), ["transport.job:prod-job-a", "transport.job:prod-job-b"]);
    assert.equal(report.errors, 0);
  });

  it("does not apply to the G2 file composition", async () => {
    const file = loadG2FileProfiles().capability;
    const rows = [storedRow({ jobId: "file-job", profileId: G2_FILE_CAPABILITY_ID, status: "admitted" })];
    const { deps, calls, holdWrites } = guardedDeps({ rows, profile: file, freeRecovery: true });
    await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(holdWrites, []);
    assert.deepEqual(calls, ["transport.job:file-job"]);
  });

  it("skips a reserved inbox job before any network read, and reads an ordinary one", async () => {
    const { deps, calls } = guardedDeps({ rows: [], profile: production, inbox: [G2_FINITE_JOB.job, "self-test-rebalance-g2-low10", "ordinary-job"] });
    await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(calls, ["transport.job:ordinary-job"]);
    const file = guardedDeps({ rows: [], profile: loadG2FileProfiles().capability, inbox: ["self-test-rebalance-g2-low10"] });
    await runQuantRebalanceWorkerOnce(file.deps);
    assert.deepEqual(file.calls, ["transport.job:self-test-rebalance-g2-low10"]);
  });

  it("admits a discovered production job through the normal path and derives its production policy", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
    const wizard = JSON.parse(readFileSync(new URL("./fixtures/quant/wizard-session-shape.json", import.meta.url), "utf8")) as { permissions: unknown };
    const session: Record<string, unknown> = { ...fixture.session, permissions: wizard.permissions };
    const keypair = quantKeypairFromSeed(`0x${"77".repeat(32)}`);
    const envelope = seal(JSON.stringify(session), keypair.publicKey);
    const expiry = Number(session["expiry"]);
    const now = (expiry - 2 * 86_400) * 1_000;
    const allocation = 10n * E18;
    const wire: QuantJobRecord = { id: "prod-discovered", status: "ACTIVE", strategyId: PROD_STRATEGY,
      tradingWalletAddress: getAddress(String(session["walletAddress"])), allocationUWei: allocation, dailyCapUWei: 40n * E18,
      termDays: 30, startedAtMs: now - 1_000, endsAtMs: expiry * 1_000, sessionExpiresAtMs: expiry * 1_000, revokedAtMs: null };
    const claims = new MemoryQuantWalletClaimStore(undefined, true);
    const store = new MemoryQuantRebalanceStore(claims);
    const balances = { USDC: allocation, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n };
    const deps = {
      store, claims, journal: {} as ExecutionJournal, provider: {} as WalletProvider, reader: {} as QuantChainReader, keypair,
      strategyId: PROD_STRATEGY, agentId: "agent-1", capabilityProfile: production, nowMs: () => now, intervalMs: 60_000,
      transport: {
        async inbox() { return { ok: true, data: { items: [{ ...envelope, envelopeId: "env-prod", quantJobId: wire.id }], nextCursor: null } }; },
        async job() { return { ok: true, data: wire }; },
      },
      async admitChain() { return { ok: true, baselineBlock: 100n, baselineHash: HASH, baselineAtMs: now, actualBalances: balances,
        protectedBalances: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n } }; },
      async readPortfolio() { return { ok: false, code: "portfolio-read-unavailable" }; },
    } as unknown as QuantRebalanceWorkerDeps;
    await runQuantRebalanceWorkerOnce(deps);
    const admitted = await store.getJob(wire.id);
    assert.equal(admitted?.status, "admitted");
    assert.equal(admitted?.tier, "low");
    const expected = rebalanceJobPolicyDigest({ capabilityProfileId: CAPABILITY_ID, jobId: wire.id, strategyId: PROD_STRATEGY,
      allocationWei: allocation, tier: LOW_TIER, startedAtMs: wire.startedAtMs!, endsAtMs: wire.endsAtMs!, sessionExpiresAtMs: wire.sessionExpiresAtMs! });
    assert.equal(admitted?.policyDigest, expected);
    // The next cycle sees its own row as production-conformant: no mismatch hold.
    await runQuantRebalanceWorkerOnce(deps);
    assert.notEqual((await store.getJob(wire.id))?.holdCode, "production-profile-mismatch");
  });
});
