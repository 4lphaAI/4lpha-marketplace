import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Hex } from "viem";
import { billingEnablePreflightMain } from "../scripts/billing-enable-preflight.js";
import { billingExpiryProbeMain } from "../scripts/billing-expiry-probe.js";
import { billingPostdeployVerifyMain } from "../scripts/billing-postdeploy-verify.js";
import {
  classifyExpiryFixture,
  runOfflinePreflightCommand,
  validatePostdeployFixture,
  type LocalReadDeps,
} from "../src/billing/operatorCommands.js";
import {
  validatePlatformBalanceEvidence,
  validatePostdeployEvidence,
  validateProductionOracleEvidence,
  validateRpcCapabilityEvidence,
  type BaseBalanceObservationV1,
  type PostdeployRpcObservationV1,
  type RpcFinalizedObservationV1,
} from "../src/billing/productionEvidence.js";
import { canonicalProductionManifest, parseProductionManifest } from "../src/billing/productionManifest.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const encoder = new TextEncoder();
const goldenManifest = parseProductionManifest(encoder.encode(GOLDEN_PRODUCTION_MANIFEST_V2));
const H1 = `0x${"1".repeat(64)}` as Hex;
const H2 = `0x${"2".repeat(64)}` as Hex;
const INITCODE_HASH = `0x${"d".repeat(64)}` as Hex;

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function preflightFiles(): Readonly<{ files: Readonly<Record<string, Uint8Array>>; manifestBytes: Uint8Array }> {
  const bundle = encoder.encode("deterministic-adapter-bundle");
  const source = encoder.encode("reviewed-adapter-source");
  const lock = encoder.encode("reviewed-lock-bytes");
  const manifestBytes = encoder.encode(canonicalProductionManifest({
    ...goldenManifest,
    sourceSha256: sha(source),
    lockSha256: sha(lock),
    bundleSha256: sha(bundle),
  }));
  return { files: { manifest: manifestBytes, bundle, source, lock }, manifestBytes };
}

function localDeps(files: Readonly<Record<string, Uint8Array>>, overrides: Readonly<Record<string, Partial<Awaited<ReturnType<LocalReadDeps["stat"]>>>>> = {}): LocalReadDeps {
  return {
    platform: "linux",
    readFile: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error("missing fixture");
      return value;
    },
    stat: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error("missing fixture");
      return { isFile: true, isSymbolicLink: false, mode: 0o100600, size: value.byteLength, ...overrides[path] };
    },
  };
}

function rpc(origin: string, chainId: 56 | 8453 | 42161, latest: string, selected: string): RpcFinalizedObservationV1 {
  return { origin, chainId, latestBlockNumber: latest, selectedBlockNumber: selected, selectedBlockHash: H1, selectedBlockTimestamp: 950 };
}

function postdeploy(origin = goldenManifest.networks.bsc.origins[0]): PostdeployRpcObservationV1 {
  return {
    origin,
    chainId: 56,
    finalizedBlockNumber: "115",
    transactionHash: goldenManifest.collector.deploymentTxHash,
    transactionFrom: goldenManifest.collector.deployer,
    transactionNonce: goldenManifest.collector.nonce,
    transactionTo: null,
    initcodeHash: INITCODE_HASH,
    receiptStatus: 1,
    receiptContractAddress: goldenManifest.collector.address,
    receiptBlockNumber: goldenManifest.collector.deploymentBlock,
    receiptBlockHash: goldenManifest.collector.deploymentBlockHash,
    receiptBlockTimestamp: 900,
    runtimeCodehash: goldenManifest.collector.runtimeCodehash,
    treasury: goldenManifest.collector.treasury,
  };
}

function balance(origin = goldenManifest.networks.base.origins[0], latestBlockNumber = "120"): BaseBalanceObservationV1 {
  return {
    origin,
    chainId: 8453,
    latestBlockNumber,
    selectedBlockNumber: "100",
    blockHash: H2,
    blockTimestamp: 950,
    authorizer: goldenManifest.providers.x402Authorizer,
    usdcAddress: goldenManifest.networks.baseUsdc.address,
    nativeBalanceWei: goldenManifest.caps.minBaseGasReserveWei,
    usdcBalanceAtomic: "5",
  };
}

test("offline enablement preflight binds exact raw manifest, bundle, source, lock, and permissions", async () => {
  const { files, manifestBytes } = preflightFiles();
  const report = await runOfflinePreflightCommand(
    ["--offline", "--manifest", "manifest", "--bundle", "bundle", "--source", "source", "--lock", "lock"],
    localDeps(files),
  );
  assert.equal(report.ok, true);
  assert.equal(report.manifestSha256, sha(manifestBytes));
  await assert.rejects(
    runOfflinePreflightCommand(
      ["--offline", "--manifest", "manifest", "--bundle", "bundle", "--source", "source", "--lock", "lock"],
      localDeps({ ...files, bundle: encoder.encode("drift") }),
    ),
    /bundle SHA-256/u,
  );
  await assert.rejects(
    runOfflinePreflightCommand(
      ["--offline", "--manifest", "manifest", "--bundle", "bundle", "--source", "source", "--lock", "lock"],
      localDeps(files, { manifest: { mode: 0o100644 } }),
    ),
    /manifest-permissions-unverified/u,
  );
});

test("offline preflight flags and local file shape fail closed", async () => {
  const { files } = preflightFiles();
  await assert.rejects(runOfflinePreflightCommand(["--offline"], localDeps(files)), /invalid-cli-flags/u);
  await assert.rejects(
    runOfflinePreflightCommand(
      ["--offline", "--offline", "--manifest", "manifest", "--bundle", "bundle", "--source", "source", "--lock", "lock"],
      localDeps(files),
    ),
    /invalid-cli-flags/u,
  );
  await assert.rejects(
    runOfflinePreflightCommand(
      ["--offline", "--manifest", "manifest", "--bundle", "bundle", "--source", "source", "--lock", "lock"],
      localDeps(files, { bundle: { isSymbolicLink: true } }),
    ),
    /non-symlink/u,
  );
});

test("RPC capability evidence requires exact dual observations and finality depth", () => {
  const bsc = rpc(goldenManifest.networks.bsc.origins[0], 56, "120", "105");
  const bsc2 = { ...bsc, origin: goldenManifest.networks.bsc.origins[1], latestBlockNumber: "123" };
  const base = rpc(goldenManifest.networks.base.origins[0], 8453, "120", "100");
  const base2 = { ...base, origin: goldenManifest.networks.base.origins[1], latestBlockNumber: "122" };
  const arbitrum = rpc(goldenManifest.networks.arbitrum.origins[0], 42161, "120", "100");
  const arbitrum2 = { ...arbitrum, origin: goldenManifest.networks.arbitrum.origins[1], latestBlockNumber: "121" };
  validateRpcCapabilityEvidence({ manifest: goldenManifest, now: 1_000, bsc: [bsc, bsc2], base: [base, base2], arbitrum: [arbitrum, arbitrum2] });
  assert.throws(
    () => validateRpcCapabilityEvidence({ manifest: goldenManifest, now: 1_000, bsc: [bsc, { ...bsc2, selectedBlockHash: H2 }], base: [base, base2], arbitrum: [arbitrum, arbitrum2] }),
    /disagrees/u,
  );
  assert.throws(
    () => validateRpcCapabilityEvidence({ manifest: goldenManifest, now: 1_000, bsc: [{ ...bsc, selectedBlockNumber: "106" }, { ...bsc2, selectedBlockNumber: "106" }], base: [base, base2], arbitrum: [arbitrum, arbitrum2] }),
    /finalized-depth/u,
  );
});

test("oracle evidence validates exact dual Chainlink observations", () => {
  const bnb = { chainId: 56n, proxy: goldenManifest.oracles.bnbUsd.proxy, description: "BNB / USD", decimals: 8, roundId: 10n, answer: 60_000_000_000n, startedAt: 99_970, updatedAt: 99_980, answeredInRound: 10n };
  const og = { chainId: 42_161n, proxy: goldenManifest.oracles.ogUsd.proxy, description: "0G / USD", decimals: 8, roundId: 11n, answer: 100_000_000n, startedAt: 90_000, updatedAt: 90_100, answeredInRound: 11n };
  const sequencer = { chainId: 42_161n, proxy: goldenManifest.oracles.arbitrumSequencer.proxy, description: "L2 Sequencer Uptime Status Feed", decimals: 0, roundId: 12n, answer: 0n, startedAt: 96_000, updatedAt: 99_990, answeredInRound: 12n };
  validateProductionOracleEvidence({
    manifest: goldenManifest,
    now: 100_000,
    bnbUsd: [{ origin: goldenManifest.networks.bsc.origins[0], observation: bnb }, { origin: goldenManifest.networks.bsc.origins[1], observation: { ...bnb } }],
    ogUsd: [{ origin: goldenManifest.networks.arbitrum.origins[0], observation: og }, { origin: goldenManifest.networks.arbitrum.origins[1], observation: { ...og } }],
    arbitrumSequencer: [{ origin: goldenManifest.networks.arbitrum.origins[0], observation: sequencer }, { origin: goldenManifest.networks.arbitrum.origins[1], observation: { ...sequencer } }],
  });
  assert.throws(
    () => validateProductionOracleEvidence({
      manifest: goldenManifest,
      now: 100_000,
      bnbUsd: [{ origin: goldenManifest.networks.bsc.origins[0], observation: bnb }, { origin: goldenManifest.networks.bsc.origins[1], observation: { ...bnb, answer: 0n } }],
      ogUsd: [{ origin: goldenManifest.networks.arbitrum.origins[0], observation: og }, { origin: goldenManifest.networks.arbitrum.origins[1], observation: { ...og } }],
      arbitrumSequencer: [{ origin: goldenManifest.networks.arbitrum.origins[0], observation: sequencer }, { origin: goldenManifest.networks.arbitrum.origins[1], observation: { ...sequencer } }],
    }),
    /ORACLE_UNAVAILABLE/u,
  );
});

test("postdeploy evidence binds deployment, runtime, treasury, finality, and pair equality", () => {
  const observation = postdeploy();
  const second = postdeploy(goldenManifest.networks.bsc.origins[1]);
  assert.deepEqual(
    validatePostdeployEvidence({ manifest: goldenManifest, expectedInitcodeHash: INITCODE_HASH, observations: [observation, second] }),
    { transactionHash: goldenManifest.collector.deploymentTxHash, runtimeCodehash: goldenManifest.collector.runtimeCodehash },
  );
  assert.throws(
    () => validatePostdeployEvidence({ manifest: goldenManifest, expectedInitcodeHash: INITCODE_HASH, observations: [{ ...observation, finalizedBlockNumber: "114" }, { ...second, finalizedBlockNumber: "114" }] }),
    /does not match/u,
  );
  const extra = { ...observation, unexpected: true } as unknown as PostdeployRpcObservationV1;
  assert.throws(() => validatePostdeployEvidence({ manifest: goldenManifest, expectedInitcodeHash: INITCODE_HASH, observations: [extra, { ...second, unexpected: true } as unknown as PostdeployRpcObservationV1] }), /members drifted/u);
});

test("Base payer evidence enforces dual-source identity, freshness, reserve, and exposure", () => {
  const observation = balance();
  const second = balance(goldenManifest.networks.base.origins[1], "123");
  assert.deepEqual(
    validatePlatformBalanceEvidence({ manifest: goldenManifest, now: 1_000, liveUsdcExposureAtomic: "5", observations: [observation, second] }),
    { nativeBalanceWei: BigInt(observation.nativeBalanceWei), usdcBalanceAtomic: 5n },
  );
  assert.throws(
    () => validatePlatformBalanceEvidence({ manifest: goldenManifest, now: 1_000, liveUsdcExposureAtomic: "6", observations: [observation, second] }),
    /insufficient/u,
  );
  assert.throws(
    () => validatePlatformBalanceEvidence({ manifest: goldenManifest, now: 1_100, liveUsdcExposureAtomic: "5", observations: [observation, second] }),
    /stale/u,
  );
  assert.throws(
    () => validatePlatformBalanceEvidence({ manifest: goldenManifest, now: 1_000, liveUsdcExposureAtomic: "5",
      observations: [{ ...observation, selectedBlockNumber: "101" }, { ...second, selectedBlockNumber: "101" }] }),
    /finalized selection/u,
  );
});

test("expiry classify fixture is canonical, exhaustive, redacted evidence only", () => {
  const fixture = JSON.stringify({
    schema: "4lpha.billing-expiry-classify-input.v1",
    observedAt: 1_000,
    maxExpiresAt: 1_100,
    quoteExpiresAt: 1_080,
    intentExpiresAt: 1_070,
    manifestSha256: "a".repeat(64),
    bundleSha256: "b".repeat(64),
    probeInputSha256: "c".repeat(64),
  });
  const evidence = classifyExpiryFixture(encoder.encode(fixture));
  assert.equal(evidence.result, "finite-candidate");
  assert.equal(evidence.intentToQuoteDeltaSec, "-10");
  assert.equal(JSON.stringify(evidence).includes("quoteExpiresAt"), false);
  assert.throws(() => classifyExpiryFixture(encoder.encode(`\ufeff${fixture}`)), /BOM/u);
  assert.throws(() => classifyExpiryFixture(encoder.encode(`${fixture}\n`)), /canonical/u);
});

test("postdeploy CLI fixture is exact canonical local evidence", () => {
  const observation = postdeploy();
  const second = postdeploy(goldenManifest.networks.bsc.origins[1]);
  const fixture = JSON.stringify({ schema: "4lpha.billing-postdeploy-evidence.v1", expectedInitcodeHash: INITCODE_HASH, observations: [observation, second] });
  const result = validatePostdeployFixture({ manifestBytes: encoder.encode(GOLDEN_PRODUCTION_MANIFEST_V2), evidenceBytes: encoder.encode(fixture) });
  assert.equal(result.ok, true);
  const reordered = JSON.stringify({ expectedInitcodeHash: INITCODE_HASH, schema: "4lpha.billing-postdeploy-evidence.v1", observations: [observation, second] });
  assert.throws(() => validatePostdeployFixture({ manifestBytes: encoder.encode(GOLDEN_PRODUCTION_MANIFEST_V2), evidenceBytes: encoder.encode(reordered) }), /members drifted/u);
});

test("all operator command wrappers reject missing explicit flags with exit 2 before I/O", async () => {
  assert.equal(await billingEnablePreflightMain([]), 2);
  assert.equal(await billingExpiryProbeMain([]), 2);
  assert.equal(await billingPostdeployVerifyMain([]), 2);
});
