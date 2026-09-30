import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalEncode } from "../src/auth/canonical.js";
import { rebalanceCanonicalEncode } from "../src/quant/rebalanceCanonical.js";
import {
  HIGH_TIER, rebalanceJobPolicyDigest, rebalanceJobPolicyProjection,
  rebalancePolicyDigest, rebalancePolicyProjection,
} from "../src/quant/rebalancePolicy.js";

describe("Quant-local canonical digest compatibility", () => {
  it("matches the established encoder byte-for-byte over primitive and nested vectors", () => {
    const values: readonly unknown[] = [
      null, false, 0, -1.25, 1n, "text",
      "0x8AC76a51cc950d9822D68b83F1Ad97B32Cd580d",
      { z: [1n, "x"], a: { address: "0x8AC76a51cc950d9822D68b83F1Ad97B32Cd580d", omitted: undefined } },
      ["a", { n: 4_000, value: 10n ** 77n }],
    ];
    for (const value of values) assert.equal(rebalanceCanonicalEncode(value), canonicalEncode(value));
  });

  it("matches the established encoder on the full process and job policy projections", () => {
    const process = rebalancePolicyProjection("offline-profile");
    const job = rebalanceJobPolicyProjection({
      capabilityProfileId: "offline-profile", jobId: "job-vector", strategyId: "strategy-vector",
      allocationWei: 75n * 10n ** 18n, tier: HIGH_TIER,
      startedAtMs: 1_700_000_000_000, endsAtMs: 1_702_592_000_000,
      sessionExpiresAtMs: 1_702_592_000_000,
    });
    assert.equal(rebalanceCanonicalEncode(process), canonicalEncode(process));
    assert.equal(rebalanceCanonicalEncode(job), canonicalEncode(job));
    assert.equal(rebalancePolicyDigest("offline-profile"), "0x754b18932bc9b549cea646758fa98f55e76e2e9477b25bd41b48d824b9f42979");
    assert.equal(rebalanceJobPolicyDigest({
      capabilityProfileId: "offline-profile", jobId: "job-vector", strategyId: "strategy-vector",
      allocationWei: 75n * 10n ** 18n, tier: HIGH_TIER,
      startedAtMs: 1_700_000_000_000, endsAtMs: 1_702_592_000_000,
      sessionExpiresAtMs: 1_702_592_000_000,
    }), "0xe8a7ac304830694485f52c071a8a68e8309de179cddcdedf3a857e31ea32cd6f");
  });
});
