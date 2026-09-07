import {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  isAddress,
  isHex,
  keccak256,
  padHex,
  type Address,
  type Hex,
} from "viem";
import {
  BILLING_COLLECTOR_CREATION_BYTES,
  BILLING_COLLECTOR_RUNTIME_TEMPLATE_BYTES,
  BILLING_COLLECTOR_TREASURY_AST_ID,
  BILLING_COLLECTOR_TREASURY_OFFSETS,
  assertBillingCollectorArtifactShape,
  type BillingCollectorArtifact,
} from "./collectorCompiler.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_NONCE = (1n << 64n) - 1n;
const CANONICAL_NONCE = /^(?:0|[1-9][0-9]*)$/;
const LOWERCASE_ADDRESS = /^0x[0-9a-f]{40}$/;

export type BillingCollectorDeploymentIntentV1 = Readonly<{
  schema: "4lpha.billing-deployment-intent.v1";
  chainId: 56;
  treasury: Address;
  deployer: Address;
  nonce: string;
}>;

export type BillingCollectorDeploymentArtifacts = Readonly<{
  intent: BillingCollectorDeploymentIntentV1;
  valueWei: "0";
  constructorArguments: Hex;
  initcode: Hex;
  initcodeHash: Hex;
  predictedCollector: Address;
  expectedRuntime: Hex;
  expectedRuntimeCodehash: Hex;
  runtimeTemplateHash: Hex;
}>;

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} fields or field order are invalid.`);
  }
}

function canonicalAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !LOWERCASE_ADDRESS.test(value) ||
      !isAddress(value, { strict: true }) || value === ZERO_ADDRESS) {
    throw new Error(`${field} must be a nonzero lowercase EVM address.`);
  }
  return value as Address;
}

function canonicalNonce(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_NONCE.test(value)) {
    throw new Error("nonce must be a canonical decimal string.");
  }
  if (BigInt(value) > MAX_NONCE) throw new Error("nonce exceeds uint64.");
  return value;
}

function checkedHex(value: unknown, field: string, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value !== value.toLowerCase() ||
      (bytes !== undefined && value.length !== 2 + bytes * 2)) {
    throw new Error(`${field} must be canonical lowercase hex${bytes === undefined ? "" : ` of ${bytes} bytes`}.`);
  }
  return value as Hex;
}

export function billingCollectorDeploymentIntent(input: Readonly<{
  chainId: number;
  treasury: string;
  deployer: string;
  nonce: string;
}>): BillingCollectorDeploymentIntentV1 {
  if (input.chainId !== 56) throw new Error("BillingCollector deployment requires chain 56.");
  const treasury = canonicalAddress(input.treasury, "treasury");
  const deployer = canonicalAddress(input.deployer, "deployer");
  if (treasury === deployer) throw new Error("treasury and deployer must be distinct.");
  return Object.freeze({
    schema: "4lpha.billing-deployment-intent.v1",
    chainId: 56,
    treasury,
    deployer,
    nonce: canonicalNonce(input.nonce),
  });
}

export function parseBillingCollectorDeploymentIntent(
  value: unknown,
): BillingCollectorDeploymentIntentV1 {
  const record = plainRecord(value, "deployment intent");
  exactKeys(record, ["schema", "chainId", "treasury", "deployer", "nonce"], "deployment intent");
  if (record["schema"] !== "4lpha.billing-deployment-intent.v1") {
    throw new Error("Invalid BillingCollector deployment-intent schema.");
  }
  return billingCollectorDeploymentIntent({
    chainId: typeof record["chainId"] === "number" ? record["chainId"] : Number.NaN,
    treasury: typeof record["treasury"] === "string" ? record["treasury"] : "",
    deployer: typeof record["deployer"] === "string" ? record["deployer"] : "",
    nonce: typeof record["nonce"] === "string" ? record["nonce"] : "",
  });
}

export function canonicalBillingCollectorDeploymentIntent(
  intent: BillingCollectorDeploymentIntentV1,
): string {
  return JSON.stringify(parseBillingCollectorDeploymentIntent(intent));
}

export function parseCanonicalBillingCollectorDeploymentIntent(
  json: string,
): BillingCollectorDeploymentIntentV1 {
  if (json.startsWith("\uFEFF")) throw new Error("Deployment intent must not contain a BOM.");
  const parsed = parseBillingCollectorDeploymentIntent(JSON.parse(json) as unknown);
  if (JSON.stringify(parsed) !== json) throw new Error("Deployment intent is not canonical JSON.");
  return parsed;
}

function patchRuntimeTemplate(artifact: BillingCollectorArtifact, treasury: Address): Hex {
  assertBillingCollectorArtifactShape(artifact);
  const runtime = Buffer.from(artifact.runtimeTemplate.slice(2), "hex");
  const treasuryWord = Buffer.from(padHex(treasury, { size: 32 }).slice(2), "hex");
  const references = artifact.immutableReferences[BILLING_COLLECTOR_TREASURY_AST_ID];
  if (references === undefined || references.length !== 2) {
    throw new Error("BillingCollector treasury immutable references are missing.");
  }
  for (const row of references) treasuryWord.copy(runtime, row.start);
  return `0x${runtime.toString("hex")}`;
}

function validateArtifactHashes(artifact: BillingCollectorArtifact): void {
  if (keccak256(artifact.creationBytecode) !== artifact.creationBytecodeHash) {
    throw new Error("BillingCollector creation-bytecode hash mismatch.");
  }
  if (keccak256(artifact.runtimeTemplate) !== artifact.runtimeTemplateHash) {
    throw new Error("BillingCollector runtime-template hash mismatch.");
  }
}

/** Pure unsigned derivation. It has no signer, RPC, fee, funding or broadcast seam. */
export function createBillingCollectorDeploymentArtifacts(
  artifact: BillingCollectorArtifact,
  intent: BillingCollectorDeploymentIntentV1,
): BillingCollectorDeploymentArtifacts {
  const checkedIntent = parseBillingCollectorDeploymentIntent(intent);
  assertBillingCollectorArtifactShape(artifact);
  validateArtifactHashes(artifact);
  const constructorArguments = encodeAbiParameters([{ type: "address" }], [checkedIntent.treasury]);
  const initcode = concatHex([artifact.creationBytecode, constructorArguments]);
  const expectedRuntime = patchRuntimeTemplate(artifact, checkedIntent.treasury);
  const expectedRuntimeCodehash = keccak256(expectedRuntime);
  if (expectedRuntimeCodehash === artifact.runtimeTemplateHash) {
    throw new Error("BillingCollector deployed runtime cannot equal the zero-slot template.");
  }
  const predictedCollector = getContractAddress({
    from: checkedIntent.deployer,
    nonce: BigInt(checkedIntent.nonce),
  }).toLowerCase() as Address;
  if (predictedCollector === checkedIntent.treasury || predictedCollector === checkedIntent.deployer) {
    throw new Error("Predicted BillingCollector collides with a deployment role.");
  }
  return Object.freeze({
    intent: checkedIntent,
    valueWei: "0",
    constructorArguments,
    initcode,
    initcodeHash: keccak256(initcode),
    predictedCollector,
    expectedRuntime,
    expectedRuntimeCodehash,
    runtimeTemplateHash: artifact.runtimeTemplateHash,
  });
}

export function canonicalBillingCollectorDeploymentArtifacts(
  artifacts: BillingCollectorDeploymentArtifacts,
): string {
  const intent = parseBillingCollectorDeploymentIntent(artifacts.intent);
  if (artifacts.valueWei !== "0") throw new Error("BillingCollector deployment value must be zero.");
  const constructorArguments = checkedHex(artifacts.constructorArguments, "constructorArguments", 32);
  const initcode = checkedHex(artifacts.initcode, "initcode");
  const initcodeHash = checkedHex(artifacts.initcodeHash, "initcodeHash", 32);
  const predictedCollector = canonicalAddress(artifacts.predictedCollector, "predictedCollector");
  const expectedRuntime = checkedHex(artifacts.expectedRuntime, "expectedRuntime", BILLING_COLLECTOR_RUNTIME_TEMPLATE_BYTES);
  const expectedRuntimeCodehash = checkedHex(artifacts.expectedRuntimeCodehash, "expectedRuntimeCodehash", 32);
  const runtimeTemplateHash = checkedHex(artifacts.runtimeTemplateHash, "runtimeTemplateHash", 32);
  const creationBytecode = initcode.slice(0, -(constructorArguments.length - 2)) as Hex;
  if ((creationBytecode.length - 2) / 2 !== BILLING_COLLECTOR_CREATION_BYTES ||
      !initcode.endsWith(constructorArguments.slice(2))) {
    throw new Error("BillingCollector initcode constructor boundary is invalid.");
  }
  if (keccak256(initcode) !== initcodeHash || keccak256(expectedRuntime) !== expectedRuntimeCodehash) {
    throw new Error("BillingCollector deployment artifact hash mismatch.");
  }
  const expectedConstructor = encodeAbiParameters([{ type: "address" }], [intent.treasury]);
  if (constructorArguments !== expectedConstructor) throw new Error("BillingCollector constructor arguments mismatch.");
  const expectedAddress = getContractAddress({ from: intent.deployer, nonce: BigInt(intent.nonce) }).toLowerCase();
  if (predictedCollector !== expectedAddress) throw new Error("BillingCollector CREATE address mismatch.");
  if (expectedRuntimeCodehash === runtimeTemplateHash) {
    throw new Error("BillingCollector runtime codehash equals the template hash.");
  }
  const treasuryWord = padHex(intent.treasury, { size: 32 }).slice(2);
  for (const offset of BILLING_COLLECTOR_TREASURY_OFFSETS) {
    const start = 2 + offset * 2;
    if (expectedRuntime.slice(start, start + 64) !== treasuryWord) {
      throw new Error("BillingCollector expected runtime treasury patch mismatch.");
    }
  }
  return JSON.stringify({
    intent,
    valueWei: "0",
    constructorArguments,
    initcode,
    initcodeHash,
    predictedCollector,
    expectedRuntime,
    expectedRuntimeCodehash,
    runtimeTemplateHash,
  });
}
