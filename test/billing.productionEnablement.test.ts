import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PLATFORM_OG_NEURON,
  MAX_PLATFORM_USDC_ATOMIC,
  canonicalProductionManifest,
  parseProductionManifest,
  productionManifestSha256,
} from "../src/billing/productionManifest.js";
import {
  buildExpiryEvidence,
  canonicalExpiryEvidence,
  canonicalExpiryProbeInput,
  expiryProbeInputSha256,
  type ExpiryClass,
} from "../src/billing/productionOps.js";
import {
  GOLDEN_PRODUCTION_MANIFEST_SHA256,
  GOLDEN_PRODUCTION_MANIFEST_V2,
} from "./fixtures/billing/productionManifestV2.js";

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function manifestObject(): Record<string, unknown> {
  return JSON.parse(GOLDEN_PRODUCTION_MANIFEST_V2) as Record<string, unknown>;
}

function nested(root: Record<string, unknown>, name: string): Record<string, unknown> {
  return record(root[name]);
}

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("Phase 5 production manifest", () => {
  it("pins one canonical golden manifest and its SHA-256", () => {
    const bytes = Buffer.from(GOLDEN_PRODUCTION_MANIFEST_V2, "utf8");
    const parsed = parseProductionManifest(bytes);
    assert.equal(parsed.schema, "4lpha.billing-production-manifest.v2");
    assert.deepEqual(parsed.aws.credential, { kind: "ecs-task-role-v1" });
    assert.equal(parsed.networks.bsc.finalityDepth, 15);
    assert.equal(parsed.networks.base.finalityDepth, 20);
    assert.equal(parsed.networks.arbitrum.finalityDepth, 20);
    assert.equal(parsed.providers.ogEnabled, false);
    assert.equal(parsed.providers.ogBalanceWireFixtureSha256, null);
    assert.equal(canonicalProductionManifest(JSON.parse(GOLDEN_PRODUCTION_MANIFEST_V2)), GOLDEN_PRODUCTION_MANIFEST_V2);
    assert.equal(productionManifestSha256(bytes), GOLDEN_PRODUCTION_MANIFEST_SHA256);
  });

  it("accepts only the complete ordered AWS credential union", () => {
    const rolesAnywhere = manifestObject();
    const aws = nested(rolesAnywhere, "aws");
    rolesAnywhere["aws"] = {
      region: aws["region"], accountId: aws["accountId"], runtimeRoleArn: aws["runtimeRoleArn"],
      credential: { kind: "roles-anywhere-x509-v1",
        trustAnchorArn: "arn:aws:rolesanywhere:us-east-1:123456789012:trust-anchor/anchor-1",
        profileArn: "arn:aws:rolesanywhere:us-east-1:123456789012:profile/profile-1",
        certificateSha256: "d".repeat(64), certificateSubjectCn: "railway-billing",
        certificateIssuerCn: "4lpha-ca", helperVersion: "1.8.4", helperBytes: "12094568",
        helperSha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9" },
      ticketKeyId: aws["ticketKeyId"], ticketKeyArn: aws["ticketKeyArn"], x402KeyArn: aws["x402KeyArn"],
      ogInference: aws["ogInference"], ogManagement: aws["ogManagement"],
    };
    assert.equal(parseProductionManifest(canonicalBytes(rolesAnywhere)).aws.credential.kind,
      "roles-anywhere-x509-v1");
    const drift = structuredClone(rolesAnywhere);
    nested(nested(drift, "aws"), "credential")["helperBytes"] = "12094569";
    assert.throws(() => parseProductionManifest(canonicalBytes(drift)), /helper identity drifted/);
    const extra = structuredClone(rolesAnywhere);
    nested(nested(extra, "aws"), "credential")["endpoint"] = "https://example.com";
    assert.throws(() => parseProductionManifest(canonicalBytes(extra)), /missing, unknown, or reordered/);
  });

  it("refuses whitespace, BOM, missing, unknown, and reordered members", () => {
    assert.throws(() => parseProductionManifest(Buffer.from(`${GOLDEN_PRODUCTION_MANIFEST_V2}\n`)), /not canonical/);
    assert.throws(() => parseProductionManifest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(GOLDEN_PRODUCTION_MANIFEST_V2)])));

    const missing = manifestObject();
    delete missing["buildCommit"];
    assert.throws(() => parseProductionManifest(canonicalBytes(missing)), /missing, unknown, or reordered/);

    const unknown = manifestObject();
    unknown["extra"] = true;
    assert.throws(() => parseProductionManifest(canonicalBytes(unknown)), /missing, unknown, or reordered/);

    const ordered = Object.entries(manifestObject());
    [ordered[0], ordered[1]] = [ordered[1]!, ordered[0]!];
    assert.throws(() => parseProductionManifest(canonicalBytes(Object.fromEntries(ordered))), /reordered/);

    const nestedOrder = manifestObject();
    const providerEntries = Object.entries(nested(nestedOrder, "providers"));
    [providerEntries[0], providerEntries[1]] = [providerEntries[1]!, providerEntries[0]!];
    nestedOrder["providers"] = Object.fromEntries(providerEntries);
    assert.throws(() => parseProductionManifest(canonicalBytes(nestedOrder)), /reordered/);

    const v1 = manifestObject();
    v1["schema"] = "4lpha.billing-production-manifest.v1";
    assert.throws(() => parseProductionManifest(canonicalBytes(v1)), /unsupported/);

    const deprecatedRole = manifestObject();
    const aws = nested(deprecatedRole, "aws");
    const entries = Object.entries(aws).map(([key, value]) =>
      key === "runtimeRoleArn" ? ["ecsRoleArn", value] : [key, value]);
    deprecatedRole["aws"] = Object.fromEntries(entries);
    assert.throws(() => parseProductionManifest(canonicalBytes(deprecatedRole)), /missing, unknown, or reordered/);
  });

  it("enforces literal identities, finality, attestation, and role separation", () => {
    const mutations: readonly ((root: Record<string, unknown>) => void)[] = [
      (root) => { nested(nested(root, "networks"), "base")["finalityDepth"] = 15; },
      (root) => { nested(nested(root, "networks"), "baseUsdc")["address"] = "0x5555555555555555555555555555555555555555"; },
      (root) => { nested(nested(root, "oracles"), "bnbUsd")["description"] = "BNB/USD"; },
      (root) => { nested(root, "oracles")["maxSkewSec"] = "90001"; },
      (root) => { nested(root, "collector")["attestationSha256"] = "f".repeat(64); },
      (root) => { nested(root, "providers")["x402Authorizer"] = nested(root, "collector")["address"]; },
      (root) => {
        const networks = nested(root, "networks");
        const bscOrigins = nested(networks, "bsc")["origins"] as unknown[];
        const baseOrigins = nested(networks, "base")["origins"] as unknown[];
        baseOrigins[0] = bscOrigins[0];
      },
    ];
    for (const mutate of mutations) {
      const candidate = manifestObject();
      mutate(candidate);
      assert.throws(() => parseProductionManifest(canonicalBytes(candidate)));
    }
  });

  it("enforces exact cap maxima, provider minimums, and the fail-closed 0G gate", () => {
    const usdcOver = manifestObject();
    nested(usdcOver, "caps")["platformUsdcAtomic"] = (MAX_PLATFORM_USDC_ATOMIC + 1n).toString();
    assert.throws(() => parseProductionManifest(canonicalBytes(usdcOver)), /reviewed bound/);

    const ogOver = manifestObject();
    nested(ogOver, "caps")["platformOgNeuron"] = (MAX_PLATFORM_OG_NEURON + 1n).toString();
    assert.throws(() => parseProductionManifest(canonicalBytes(ogOver)), /reviewed bound/);

    const minimumOver = manifestObject();
    nested(minimumOver, "providers")["minUsdcAtomic"] = "100000001";
    assert.throws(() => parseProductionManifest(canonicalBytes(minimumOver)));

    const bothOff = manifestObject();
    nested(bothOff, "providers")["x402Enabled"] = false;
    assert.throws(() => parseProductionManifest(canonicalBytes(bothOff)), /At least one/);

    const strayFixture = manifestObject();
    nested(strayFixture, "providers")["ogBalanceWireFixtureSha256"] = "d".repeat(64);
    assert.throws(() => parseProductionManifest(canonicalBytes(strayFixture)), /enablement must match/);

    const unreviewedOg = manifestObject();
    const unreviewedProviders = nested(unreviewedOg, "providers");
    unreviewedProviders["ogEnabled"] = true;
    unreviewedProviders["ogBalanceWireFixtureSha256"] = "d".repeat(64);
    assert.throws(() => parseProductionManifest(canonicalBytes(unreviewedOg)), /not reviewed/);

    const equality = manifestObject();
    nested(equality, "caps")["platformUsdcAtomic"] = "1";
    nested(equality, "providers")["minUsdcAtomic"] = "1";
    assert.doesNotThrow(() => canonicalProductionManifest(equality));
  });
});

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const OBSERVED = 1_000;
const MAX_EXPIRY = 1_060;

function evidence(quoteExpiresAt: unknown, intentExpiresAt: unknown = undefined) {
  return buildExpiryEvidence({
    observedAt: OBSERVED,
    maxExpiresAt: MAX_EXPIRY,
    quoteExpiresAt,
    intentExpiresAt,
    manifestSha256: H1,
    bundleSha256: H2,
    probeInputSha256: H3,
  });
}

describe("Phase 5 expiry evidence", () => {
  it("partitions every quote expiry class with exact deltas", () => {
    const cases: readonly Readonly<{ value: unknown; kind: ExpiryClass; delta: string | null }>[] = [
      { value: undefined, kind: "missing", delta: null },
      { value: -1, kind: "negative", delta: "-1001" },
      { value: 1_030.5, kind: "fractional", delta: null },
      { value: "1030", kind: "fractional", delta: null },
      { value: 0, kind: "zero", delta: "-1000" },
      { value: 1_000, kind: "expired", delta: "0" },
      { value: 1_029, kind: "too-short", delta: "29" },
      { value: 1_030, kind: "finite-bounded", delta: "30" },
      { value: 1_060, kind: "finite-bounded", delta: "60" },
      { value: 1_061, kind: "too-long", delta: "61" },
    ];
    for (const item of cases) {
      const result = evidence(item.value);
      assert.equal(result.quoteExpiryClass, item.kind);
      assert.equal(result.quoteDeltaSec, item.delta);
      assert.equal(result.result, "blocked");
    }
  });

  it("partitions intent separately and rejects intent-after-quote ordering", () => {
    const ordered = evidence(1_060, 1_030);
    assert.equal(ordered.quoteExpiryClass, "finite-bounded");
    assert.equal(ordered.intentExpiryClass, "finite-bounded");
    assert.equal(ordered.intentToQuoteDeltaSec, "-30");
    assert.equal(ordered.result, "finite-candidate");

    const equality = evidence(1_060, 1_060);
    assert.equal(equality.intentToQuoteDeltaSec, "0");
    assert.equal(equality.result, "finite-candidate");

    const reversed = evidence(1_040, 1_050);
    assert.equal(reversed.intentExpiryClass, "too-long");
    assert.equal(reversed.intentToQuoteDeltaSec, "10");
    assert.equal(reversed.result, "blocked");

    const tooShort = evidence(1_060, 1_029);
    assert.equal(tooShort.intentExpiryClass, "too-short");
    assert.equal(tooShort.result, "blocked");
  });

  it("builds a closed probe-input hash without retaining calldata", () => {
    const input = {
      manifestSha256: H1,
      bundleSha256: H2,
      collector: "0x1111111111111111111111111111111111111111",
      calldata: "0x1234",
      valueWei: "1000000000000",
      maxExpiresAt: MAX_EXPIRY,
    } as const;
    const canonical = canonicalExpiryProbeInput(input);
    assert.equal(canonical.includes("0x1234"), false);
    assert.match(canonical, /"calldataSha256":"[0-9a-f]{64}"/);
    assert.equal(expiryProbeInputSha256(input), "20dc713cd1a6f21feacdcaf6d6bba53d4e3b682eaac8985458f99cf98162855c");
  });

  it("canonicalizes evidence and refuses inconsistent class, delta, ordering, or result", () => {
    const valid = evidence(1_060, 1_030);
    assert.equal(canonicalExpiryEvidence(valid), JSON.stringify(valid));

    assert.throws(() => canonicalExpiryEvidence({ ...valid, quoteExpiryClass: "too-short" }), /class/);
    assert.throws(() => canonicalExpiryEvidence({ ...valid, intentToQuoteDeltaSec: "-29" }), /inconsistent/);
    assert.throws(() => canonicalExpiryEvidence({ ...valid, result: "blocked" }), /result/);
    assert.throws(() => canonicalExpiryEvidence({ ...valid, maxExpiresAtDeltaSec: "061" }), /canonical/);
    assert.throws(() => canonicalExpiryEvidence({ ...valid, extra: true } as typeof valid), /unknown/);

    const missing = evidence(undefined, undefined);
    assert.equal(canonicalExpiryEvidence(missing), JSON.stringify(missing));
    const fractional = evidence(1_030.5, 1_030.5);
    assert.equal(canonicalExpiryEvidence(fractional), JSON.stringify(fractional));
  });
});
