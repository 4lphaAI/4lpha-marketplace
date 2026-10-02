/**
 * Activation-phase gate tests for the implementation-scoped CMC profile.
 *
 * The shipped registry carries exactly one reviewed row, from the matrix run
 * recorded in the probe fixture (8/8 PASS at fork block 122 915 340). Every
 * other "available" case here is built from a TEST-LOCAL profile row whose
 * hashes come from that fixture, so the gate logic is exercised without
 * depending on the shipped row's own fields.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  CMC_PERMIT2, CMC_REVIEWED_PROFILES, CMC_REVIEWED_TOKEN_CLASSES, cmcCapabilityEvidenceDigest, createCmcCapabilityGate,
  evaluateCmcCapability, grantShapeDigestV1,
  type CmcCapabilityEvidence, type CmcMatrixFacts, type CmcReviewedProfile,
} from "../src/trade/cmcCapability.js";
import { createCmcRuntimeProfileRegistry } from "../src/trade/cmcRuntime.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/cmc-matrix-122915340.json", import.meta.url), "utf8")) as {
  readonly verdict: string;
  readonly accountCodeHash: Hex; readonly tokenCodeHash: Hex; readonly permit2CodeHash: Hex;
  readonly settlerCodeHash: Hex; readonly grantShapeDigest: Hex; readonly proofDigests: readonly Hex[];
  readonly traceVerdicts: readonly { readonly index: number; readonly fact: string; readonly verdict: string }[];
  readonly sessionApproveObservations: {
    readonly ownerAllowanceBefore: string; readonly ownerAllowanceAfterInCapApprove: string;
    readonly ownerValueRestored: boolean;
  };
};

const WALLET: Address = getAddress("0x27146E20c2fb2521c7DD73e97bE030C3147c9da6");
const KEY: Hex = "0x04a2984d57dad1209baae36f13ff1bf100a4c806e2e7a1d7ce74bf40843e44cc0d3951f50f557126d4079c9a61b94559d6e1b63c89d84a96b2e94a2bee4f125776";
const NOW_MS = 1_800_000_000_000;

const MATRIX: CmcMatrixFacts = {
  ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
  sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
  temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
  walletKeyExclusive: true, additiveIncreaseAllowance: true, proofDigests: FIXTURE.proofDigests,
};

function evidence(overrides: Partial<CmcCapabilityEvidence> = {}): CmcCapabilityEvidence {
  return {
    kind: "cmc-mainnet-capability-v1", source: "live-mainnet", chainId: 56, wallet: WALLET,
    accountCodeHash: FIXTURE.accountCodeHash, tokenCodeHash: FIXTURE.tokenCodeHash,
    permit2CodeHash: FIXTURE.permit2CodeHash, settlerCodeHash: FIXTURE.settlerCodeHash,
    sessionPublicKey: KEY, checker: CMC_PERMIT2, checkerApproved: true, finiteAllowanceWei: 2n * 10n ** 18n,
    grantShapeDigest: FIXTURE.grantShapeDigest, observedAtMs: NOW_MS, profileId: "altana-c0f16888-v2grant-v1",
    generation: 0, ...MATRIX, ...overrides,
  };
}

function profileFor(row: CmcCapabilityEvidence): CmcReviewedProfile {
  return {
    profileId: row.profileId, chainId: 56, accountCodeHash: row.accountCodeHash,
    tokenCodeHash: row.tokenCodeHash, permit2CodeHash: row.permit2CodeHash,
    settlerCodeHash: row.settlerCodeHash, checker: row.checker, grantShapeDigest: row.grantShapeDigest,
    evidenceDigest: cmcCapabilityEvidenceDigest(row), matrix: MATRIX,
  };
}

function verdict(row: CmcCapabilityEvidence, profiles: readonly CmcReviewedProfile[]): boolean {
  return evaluateCmcCapability({ evidence: row, profiles, wallet: row.wallet,
    sessionPublicKey: row.sessionPublicKey, generation: row.generation, nowMs: NOW_MS }).available;
}

// 2026-09-22 (0e0dcfd), 2026-09-23 (aggregator grant) and 2026-09-24 (token
// class, grant shape V2): every later row recomputes from its own probe fixture.
const LATER_ROWS = [
  { profileId: "altana-c0f16888-v3grant-v1", fixture: "./fixtures/cmc-matrix-123226705.json" },
  { profileId: "altana-c0f16888-aggregator-v1", fixture: "./fixtures/cmc-matrix-123599459.json" },
  { profileId: "altana-c0f16888-bstock-class-v1", fixture: "./fixtures/cmc-matrix-123610834.json" },
] as const;

test("every later reviewed row recomputes from its own 8/8-PASS probe fixture", () => {
  assert.deepEqual(CMC_REVIEWED_PROFILES.slice(1).map((row) => row.profileId), LATER_ROWS.map((row) => row.profileId));
  for (const expected of LATER_ROWS) {
    const probe = JSON.parse(readFileSync(new URL(expected.fixture, import.meta.url), "utf8")) as typeof FIXTURE & {
      readonly traces: readonly { readonly verdict: string }[]; readonly grantShapeDigestV2?: Hex;
      readonly tokenClassMembers?: Readonly<Record<string, string>> };
    const row = CMC_REVIEWED_PROFILES.find((candidate) => candidate.profileId === expected.profileId)!;
    // A V2 (token-class) row is matched on the probe's classed digest, and its
    // probe must have included a member of every reviewed class it stands for.
    const digest = row.grantShapeVersion === 2 ? probe.grantShapeDigestV2! : probe.grantShapeDigest;
    if (row.grantShapeVersion === 2) {
      const present = new Set(Object.values(probe.tokenClassMembers ?? {}));
      assert.deepEqual(CMC_REVIEWED_TOKEN_CLASSES.filter((klass) => !present.has(klass.classId)), []);
    }
    assert.equal(probe.verdict, "PASS");
    assert.equal(probe.traces.length, 8);
    assert.deepEqual(probe.traces.filter((trace) => trace.verdict !== "PASS"), []);
    assert.equal(row.grantShapeDigest, digest);
    assert.deepEqual(row.matrix.proofDigests, probe.proofDigests);
    assert.equal(row.evidenceDigest, cmcCapabilityEvidenceDigest({
      kind: "cmc-mainnet-capability-v1", source: "live-mainnet", chainId: 56,
      accountCodeHash: probe.accountCodeHash, tokenCodeHash: probe.tokenCodeHash,
      permit2CodeHash: probe.permit2CodeHash, settlerCodeHash: probe.settlerCodeHash,
      checker: CMC_PERMIT2, grantShapeDigest: digest, ...MATRIX, proofDigests: probe.proofDigests,
    }));
  }
});

test("the shipped CMC registry's first row is the one the original fixture proves", () => {
  assert.equal(CMC_REVIEWED_PROFILES.length, 1 + LATER_ROWS.length);
  const row = CMC_REVIEWED_PROFILES[0]!;
  assert.equal(row.profileId, "altana-c0f16888-v2grant-v1");
  assert.equal(row.chainId, 56);
  assert.equal(row.checker, CMC_PERMIT2);
  assert.equal(row.accountCodeHash, FIXTURE.accountCodeHash);
  assert.equal(row.tokenCodeHash, FIXTURE.tokenCodeHash);
  assert.equal(row.permit2CodeHash, FIXTURE.permit2CodeHash);
  assert.equal(row.settlerCodeHash, FIXTURE.settlerCodeHash);
  assert.equal(row.grantShapeDigest, FIXTURE.grantShapeDigest);
  assert.deepEqual(row.matrix.proofDigests, FIXTURE.proofDigests);
  // The shipped evidence digest recomputes from the fixture-backed fields.
  assert.equal(row.evidenceDigest, cmcCapabilityEvidenceDigest({
    kind: "cmc-mainnet-capability-v1", source: "live-mainnet", chainId: 56,
    accountCodeHash: FIXTURE.accountCodeHash, tokenCodeHash: FIXTURE.tokenCodeHash,
    permit2CodeHash: FIXTURE.permit2CodeHash, settlerCodeHash: FIXTURE.settlerCodeHash,
    checker: CMC_PERMIT2, grantShapeDigest: FIXTURE.grantShapeDigest, ...MATRIX,
  }));
  assert.equal(FIXTURE.verdict, "PASS");
  assert.deepEqual(FIXTURE.traceVerdicts.filter((trace) => trace.verdict !== "PASS"), []);
  // Fact #3 passes on the "cannot persist a HIGHER allowance" contract; the
  // in-cap approve ZEROED the owner value, which is the availability residual.
  assert.equal(FIXTURE.traceVerdicts.find((trace) => trace.fact === "sessionApproveCannotIncreaseAllowance")?.verdict, "PASS");
  assert.equal(FIXTURE.sessionApproveObservations.ownerValueRestored, false);
  assert.ok(BigInt(FIXTURE.sessionApproveObservations.ownerAllowanceAfterInCapApprove)
    <= BigInt(FIXTURE.sessionApproveObservations.ownerAllowanceBefore));
  assert.equal(createCmcRuntimeProfileRegistry().profiles.length, 1 + LATER_ROWS.length);
});

test("an implementation-scoped profile matches evidence built from the probe fixture, for ANY wallet", () => {
  const row = evidence();
  const profiles = [profileFor(row)];
  assert.equal(verdict(row, profiles), true);
  // The same reviewed implementation serves a second wallet without a new row.
  const other = getAddress("0x00000000000000000000000000000000000B0B01");
  assert.equal(verdict(evidence({ wallet: other }), profiles), true);
});

test("evidence stamped a little after the caller's clock is accepted; a minute ahead is not (G1 2026-09-20)", () => {
  // The owner prepare stamps nowMs BEFORE the live reader runs ~1 s of RPC reads.
  const row = evidence({ observedAtMs: NOW_MS + 900 });
  const profiles = [profileFor(row)];
  assert.equal(verdict(row, profiles), true);
  assert.equal(verdict(evidence({ observedAtMs: NOW_MS + 60_001 }), profiles), false);
  assert.equal(verdict(evidence({ observedAtMs: NOW_MS - 15 * 60_000 - 1 }), profiles), false);
});

test("a changed implementation hash, token hash or grant shape un-proves the profile", () => {
  const row = evidence();
  const profiles = [profileFor(row)];
  const other = `0x${"cd".repeat(32)}` as Hex;
  assert.equal(verdict(evidence({ accountCodeHash: other }), profiles), false);
  assert.equal(verdict(evidence({ tokenCodeHash: other }), profiles), false);
  assert.equal(verdict(evidence({ permit2CodeHash: other }), profiles), false);
  assert.equal(verdict(evidence({ settlerCodeHash: other }), profiles), false);
  assert.equal(verdict(evidence({ grantShapeDigest: other }), profiles), false);
});

test("the registry finds a profile by implementation identity and refuses anything else", () => {
  const row = evidence();
  const registry = createCmcRuntimeProfileRegistry([profileFor(row)]);
  const identity = {
    accountCodeHash: row.accountCodeHash, tokenCodeHash: row.tokenCodeHash,
    permit2CodeHash: row.permit2CodeHash, settlerCodeHash: row.settlerCodeHash,
    grantShapeDigest: row.grantShapeDigest, grantShapeVersion: 1 as const,
  };
  assert.equal(registry.find(identity)?.profileId, "altana-c0f16888-v2grant-v1");
  assert.deepEqual(registry.find(identity)?.proofDigests, FIXTURE.proofDigests);
  assert.equal(registry.find({ ...identity, grantShapeDigest: `0x${"cd".repeat(32)}` as Hex }), null);
  assert.equal(registry.find({ ...identity, accountCodeHash: `0x${"cd".repeat(32)}` as Hex }), null);
});

test("per-wallet live facts still refuse: generation, key identity and evidence age are not in the profile", () => {
  const row = evidence();
  const profiles = [profileFor(row)];
  // A zero allowance is fine — owner setup is exactly the state before the first grant.
  assert.equal(verdict(evidence({ finiteAllowanceWei: 0n, checkerApproved: false }), profiles), true);
  assert.equal(evaluateCmcCapability({ evidence: row, profiles, wallet: row.wallet,
    sessionPublicKey: row.sessionPublicKey, generation: 1, nowMs: NOW_MS }).available, false);
  assert.equal(evaluateCmcCapability({ evidence: row, profiles, wallet: row.wallet,
    sessionPublicKey: `0x04${"11".repeat(64)}` as Hex, generation: 0, nowMs: NOW_MS }).available, false);
  assert.equal(evaluateCmcCapability({ evidence: row, profiles, wallet: getAddress("0x00000000000000000000000000000000000B0B01"),
    sessionPublicKey: row.sessionPublicKey, generation: 0, nowMs: NOW_MS }).available, false);
  assert.equal(evaluateCmcCapability({ evidence: row, profiles, wallet: row.wallet,
    sessionPublicKey: row.sessionPublicKey, generation: 0, nowMs: NOW_MS + 16 * 60 * 1_000 }).available, false);
});

test("a reader that refuses the live facts keeps the gate closed even under a reviewed profile", async () => {
  const row = evidence();
  const profiles = [profileFor(row)];
  const closed = createCmcCapabilityGate({ reader: { read: async () => null }, profiles });
  assert.deepEqual(await closed.check({ agentId: "a", wallet: WALLET, sessionPublicKey: KEY, generation: 0, nowMs: NOW_MS }),
    { available: false, reason: "cmc-capability-matrix-unproven" });
  const threw = createCmcCapabilityGate({ reader: { read: async () => { throw new Error("rpc down"); } }, profiles });
  assert.deepEqual(await threw.check({ agentId: "a", wallet: WALLET, sessionPublicKey: KEY, generation: 0, nowMs: NOW_MS }),
    { available: false, reason: "cmc-capability-read-failed" });
});

test("grantShapeDigestV1 is order-independent and changes when a selector or capped token is added", () => {
  const rules = [
    { to: "0x55d398326f99059fF775485246999027B3197955", selector: "approve(address,uint256)" },
    { to: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", selector: "refundETH()" },
    { to: "0x10ED43C718714eb63d5aA57B78B54704E256024E" },
  ];
  const caps = [{ token: "0x55d398326f99059fF775485246999027B3197955" }, {}];
  const base = grantShapeDigestV1({ allowedCalls: rules, spendCaps: caps });
  assert.equal(grantShapeDigestV1({ allowedCalls: [...rules].reverse(), spendCaps: [...caps].reverse() }), base);
  // Checksummed vs lower-case spellings are the same shape.
  assert.equal(grantShapeDigestV1({ allowedCalls: rules.map((rule) => ({ ...rule, to: rule.to.toLowerCase() })), spendCaps: caps }), base);
  assert.notEqual(grantShapeDigestV1({ allowedCalls: [...rules,
    { to: "0x55d398326f99059fF775485246999027B3197955", selector: "transfer(address,uint256)" }], spendCaps: caps }), base);
  assert.notEqual(grantShapeDigestV1({ allowedCalls: rules,
    spendCaps: [...caps, { token: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436" }] }), base);
  // A rule that drops its target restriction is a different shape.
  assert.notEqual(grantShapeDigestV1({ allowedCalls: [{ selector: "approve(address,uint256)" }, rules[1]!, rules[2]!], spendCaps: caps }), base);
  assert.match(FIXTURE.grantShapeDigest, /^0x[0-9a-f]{64}$/u);
});

test("the evidence digest no longer binds a wallet, and a mismatched digest refuses", () => {
  const row = evidence();
  const otherWallet: CmcCapabilityEvidence = { ...row, wallet: getAddress("0x00000000000000000000000000000000000B0B01") };
  assert.equal(cmcCapabilityEvidenceDigest(row), cmcCapabilityEvidenceDigest(otherWallet));
  assert.notEqual(cmcCapabilityEvidenceDigest(row), cmcCapabilityEvidenceDigest({ ...row, accountCodeHash: `0x${"cd".repeat(32)}` as Hex }));
  assert.equal(verdict(row, [{ ...profileFor(row), evidenceDigest: `0x${"cd".repeat(32)}` as Hex }]), false);
});
