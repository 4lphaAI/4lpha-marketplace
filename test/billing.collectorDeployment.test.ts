import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { keccak256, padHex, type Hex } from "viem";
import {
  BILLING_COLLECTOR_COMPILER_SETTINGS,
  billingCollectorBuildManifest,
  canonicalBillingCollectorBuildManifest,
  compileBillingCollector,
  type BillingCollectorArtifact,
  type BillingCollectorImmutableReferences,
} from "../src/billing/collectorCompiler.js";
import {
  billingCollectorDeploymentIntent,
  canonicalBillingCollectorDeploymentArtifacts,
  canonicalBillingCollectorDeploymentIntent,
  createBillingCollectorDeploymentArtifacts,
  parseBillingCollectorDeploymentIntent,
  parseCanonicalBillingCollectorDeploymentIntent,
  type BillingCollectorDeploymentArtifacts,
} from "../src/billing/collectorDeployment.js";

const TREASURY = "0x1111111111111111111111111111111111111111";
const OTHER_TREASURY = "0x2222222222222222222222222222222222222222";
const DEPLOYER = "0xdeadbeef00000000000000000000000000000000";

let artifact: BillingCollectorArtifact;

before(async () => {
  const source = await readFile(new URL("../contracts/BillingCollector.sol", import.meta.url), "utf8");
  artifact = await compileBillingCollector(source);
});

function intent(treasury = TREASURY, nonce = "0") {
  return billingCollectorDeploymentIntent({ chainId: 56, treasury, deployer: DEPLOYER, nonce });
}

function withReferences(immutableReferences: BillingCollectorImmutableReferences): BillingCollectorArtifact {
  return { ...artifact, immutableReferences };
}

test("BillingCollector compiler freezes the reviewed solc shape and complete immutable references", () => {
  assert.equal((artifact.creationBytecode.length - 2) / 2, 1_235);
  assert.equal((artifact.runtimeTemplate.length - 2) / 2, 1_016);
  assert.deepEqual(artifact.immutableReferences, {
    "4": [{ start: 96, length: 32 }, { start: 676, length: 32 }],
  });
  assert.equal(artifact.sourceSha256, "ff71ffc5e9baa3ff355bb9180a8964baf684294a6fd8b42649c2dfb0e883c02a");
  assert.equal(artifact.creationBytecodeHash, "0xa56786f49ee0e5df8d1b7edd9c7bf83a5bd8556208211a50136d37a185049a55");
  assert.equal(artifact.runtimeTemplateHash, "0xb9b1078140d2647f173333e4a2809c5733c90e78cec9c0ffa5f13eb1119122df");
  assert.equal(artifact.templateOnly, true);
  assert.equal(artifact.runtimeBytecode, artifact.runtimeTemplate);
  assert.equal(artifact.runtimeBytecodeHash, artifact.runtimeTemplateHash);
});

test("BillingCollector build manifest is canonical and labels the zero-slot runtime as template-only", () => {
  const manifest = billingCollectorBuildManifest(artifact);
  const json = canonicalBillingCollectorBuildManifest(manifest);
  assert.equal(JSON.stringify(JSON.parse(json)), json);
  assert.deepEqual(Object.keys(JSON.parse(json) as object), [
    "schema",
    "sourceSha256",
    "solcVersion",
    "compilerSettings",
    "abi",
    "creationBytecode",
    "creationBytecodeHash",
    "runtimeTemplate",
    "runtimeTemplateHash",
    "templateOnly",
    "immutableReferences",
  ]);
  assert.equal(manifest.templateOnly, true);
  assert.deepEqual(manifest.compilerSettings, BILLING_COLLECTOR_COMPILER_SETTINGS);
  assert.throws(() => canonicalBillingCollectorBuildManifest({
    ...manifest,
    runtimeTemplateHash: `0x${"00".repeat(32)}`,
  }), /hash mismatch/);
});

test("deployment intent is an exact canonical five-field chain-56 document", () => {
  const value = intent(TREASURY, "18446744073709551615");
  const json = canonicalBillingCollectorDeploymentIntent(value);
  assert.equal(json, `{"schema":"4lpha.billing-deployment-intent.v1","chainId":56,"treasury":"${TREASURY}","deployer":"${DEPLOYER}","nonce":"18446744073709551615"}`);
  assert.deepEqual(parseCanonicalBillingCollectorDeploymentIntent(json), value);
  assert.throws(() => parseCanonicalBillingCollectorDeploymentIntent(`${json}\n`), /canonical/);
  assert.throws(() => parseCanonicalBillingCollectorDeploymentIntent(`\uFEFF${json}`), /BOM/);
  assert.throws(() => parseBillingCollectorDeploymentIntent({
    chainId: 56,
    schema: "4lpha.billing-deployment-intent.v1",
    treasury: TREASURY,
    deployer: DEPLOYER,
    nonce: "0",
  }), /field order/);
  assert.throws(() => parseBillingCollectorDeploymentIntent({ ...value, broadcast: false }), /fields/);
});

test("deployment intent refuses noncanonical nonce, wrong chain, zero/equal/noncanonical roles", () => {
  for (const nonce of ["", "00", "01", "+1", "-1", "1.0", "18446744073709551616"]) {
    assert.throws(() => intent(TREASURY, nonce));
  }
  assert.throws(() => billingCollectorDeploymentIntent({ chainId: 1, treasury: TREASURY, deployer: DEPLOYER, nonce: "0" }), /chain 56/);
  assert.throws(() => billingCollectorDeploymentIntent({ chainId: 56, treasury: "0x0000000000000000000000000000000000000000", deployer: DEPLOYER, nonce: "0" }), /nonzero/);
  assert.throws(() => billingCollectorDeploymentIntent({ chainId: 56, treasury: TREASURY, deployer: TREASURY, nonce: "0" }), /distinct/);
  assert.throws(() => billingCollectorDeploymentIntent({ chainId: 56, treasury: TREASURY.toUpperCase(), deployer: DEPLOYER, nonce: "0" }), /lowercase/);
});

test("deployment artifacts deterministically encode constructor, initcode, CREATE address, and patched runtime", () => {
  const deployment = createBillingCollectorDeploymentArtifacts(artifact, intent());
  assert.equal(deployment.valueWei, "0");
  assert.equal(deployment.constructorArguments, padHex(TREASURY, { size: 32 }));
  assert.equal(deployment.initcode, `${artifact.creationBytecode}${deployment.constructorArguments.slice(2)}`);
  assert.equal(deployment.initcodeHash, "0xd492aa0d757026cb101f6849b14ffacb2080e2cd4da7c0769e03c2535537e59c");
  assert.equal(deployment.predictedCollector, "0xf2048c36a5536fea3bc71d49ed59f2c65c546eea");
  assert.equal(deployment.expectedRuntimeCodehash, "0x2a89558fb3f5232455c92a2ffc901996974c33fcb341a2b3f1f20242c17cb725");
  assert.notEqual(deployment.expectedRuntimeCodehash, deployment.runtimeTemplateHash);
  const word = padHex(TREASURY, { size: 32 }).slice(2);
  for (const offset of [96, 676]) {
    assert.equal(deployment.expectedRuntime.slice(2 + offset * 2, 2 + offset * 2 + 64), word);
  }
  const canonical = canonicalBillingCollectorDeploymentArtifacts(deployment);
  assert.equal(JSON.stringify(JSON.parse(canonical)), canonical);
});

test("treasury identity changes both immutable slots and the expected runtime codehash", () => {
  const first = createBillingCollectorDeploymentArtifacts(artifact, intent(TREASURY));
  const second = createBillingCollectorDeploymentArtifacts(artifact, intent(OTHER_TREASURY));
  assert.notEqual(first.expectedRuntime, second.expectedRuntime);
  assert.notEqual(first.expectedRuntimeCodehash, second.expectedRuntimeCodehash);
  for (const offset of [96, 676]) {
    assert.equal(second.expectedRuntime.slice(2 + offset * 2, 2 + offset * 2 + 64), padHex(OTHER_TREASURY, { size: 32 }).slice(2));
  }
});

test("deployment refuses missing, duplicate, overlapping, out-of-bounds, extra, or wrong-width immutable shapes", () => {
  const invalid: readonly BillingCollectorImmutableReferences[] = [
    {},
    { "4": [{ start: 96, length: 32 }] },
    { "4": [{ start: 96, length: 32 }, { start: 96, length: 32 }] },
    { "4": [{ start: 96, length: 32 }, { start: 110, length: 32 }] },
    { "4": [{ start: 96, length: 32 }, { start: 2_000, length: 32 }] },
    { "4": [{ start: 96, length: 20 }, { start: 676, length: 32 }] },
    { "4": [{ start: 96, length: 32 }, { start: 676, length: 32 }], "5": [] },
  ];
  for (const immutableReferences of invalid) {
    assert.throws(() => createBillingCollectorDeploymentArtifacts(withReferences(immutableReferences), intent()), /immutable/);
  }
});

test("deployment refuses nonzero template placeholders and inconsistent bytecode hashes", () => {
  const bytes = Buffer.from(artifact.runtimeTemplate.slice(2), "hex");
  bytes[96] = 1;
  const runtimeTemplate = `0x${bytes.toString("hex")}` as Hex;
  assert.throws(() => createBillingCollectorDeploymentArtifacts({
    ...artifact,
    runtimeTemplate,
    runtimeTemplateHash: keccak256(runtimeTemplate),
  }, intent()), /placeholder/);
  assert.throws(() => createBillingCollectorDeploymentArtifacts({
    ...artifact,
    creationBytecodeHash: `0x${"00".repeat(32)}`,
  }, intent()), /hash mismatch/);
});

test("deployment refuses predicted collector role collision and canonical output tampering", () => {
  assert.throws(() => createBillingCollectorDeploymentArtifacts(
    artifact,
    intent("0xf2048c36a5536fea3bc71d49ed59f2c65c546eea"),
  ), /collides/);
  const deployment = createBillingCollectorDeploymentArtifacts(artifact, intent());
  assert.throws(() => canonicalBillingCollectorDeploymentArtifacts({
    ...deployment,
    valueWei: "1",
  } as unknown as BillingCollectorDeploymentArtifacts), /value/);
  assert.throws(() => canonicalBillingCollectorDeploymentArtifacts({
    ...deployment,
    initcodeHash: `0x${"00".repeat(32)}`,
  }), /hash mismatch/);
});
