import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  padHex,
  recoverAddress,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import {
  createAwsBillingAdapterFactory,
  type AwsBillingAdapterProtocols,
  type AwsBillingKmsProtocol,
  type PortoPreparedCollectionV1,
} from "../src/billing/awsBillingAdapter.js";
import type {
  BillingAdapterConfigV2,
  BillingBscObservationV1,
  BillingRelayPrepareV1,
  BillingSessionRefV1,
  Hex32,
} from "../src/billing/custody.js";
import { billingAdapterConfigFromProductionManifest,
  loadProductionBillingCustodyAndRelayPrimitives } from "../src/billing/custody.js";
import { parseProductionManifest } from "../src/billing/productionManifest.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const PRIVATE_KEY = `0x${"00".repeat(31)}01` as Hex;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const COLLECTOR = "0x3000000000000000000000000000000000000003" as Address;
const WALLET = "0x2000000000000000000000000000000000000002" as Address;
const ORCHESTRATOR = "0xaf140d0416a994aebb3fa6212b16ce6700f09751";
const KEYSTORE = "0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a";
const TICKET_ARN = "arn:aws:kms:us-east-1:123456789012:key/ticket-key";
const X402_ARN = "arn:aws:kms:us-east-1:123456789012:key/x402-key";
const SESSION_ARN = "arn:aws:kms:us-east-1:123456789012:key/session-key";
const INFERENCE_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:inference";
const MANAGEMENT_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:management";
const VERSION_A = "a".repeat(32);
const VERSION_B = "b".repeat(32);
const DIGEST = `0x${"11".repeat(32)}` as Hex32;
const TICKET_PUBLIC_DER = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
const PAY_INVOICE_ABI = [{ type: "function", name: "payInvoice", stateMutability: "payable",
  inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "quoteExpiresAt", type: "uint64" }],
  outputs: [] }] as const;

function secpSpki(publicKey: Hex): Uint8Array {
  return Uint8Array.from(Buffer.from(`3056301006072a8648ce3d020106052b8104000a034200${publicKey.slice(2)}`, "hex"));
}

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  if (Number.parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
  const body = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.from([0x02, body.byteLength]), body]);
}

function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Uint8Array.from(Buffer.concat([Buffer.from([0x30, body.byteLength]), body]));
}

async function highSDer(digest: Hex32): Promise<Uint8Array> {
  const signature = await ACCOUNT.sign({ hash: digest });
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const lowS = BigInt(`0x${signature.slice(66, 130)}`);
  return derSignature(r, N - lowS);
}

function keyHash(publicKey: Hex): Hex32 {
  const publicKeyHash = keccak256(padHex(publicKeyToAddress(publicKey), { size: 32 }));
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }], [2n, publicKeyHash],
  )) as Hex32;
}

function executionHash(input: BillingRelayPrepareV1): Hex32 {
  return keccak256(encodeAbiParameters([{
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  }], [[{ target: input.collector, value: input.valueWei, data: input.calldata }]])) as Hex32;
}

function config(): BillingAdapterConfigV2 {
  return {
    domain: "4lpha.billing-adapter-config.v2",
    awsRegion: "us-east-1",
    awsAccountId: "123456789012",
    runtimeRoleArn: "arn:aws:iam::123456789012:role/4lpha-billing",
    credential: { kind: "ecs-task-role-v1" },
    relayOrigin: "https://relay.altana.network",
    chainId: 56,
    orchestrator: ORCHESTRATOR,
    keyStore: KEYSTORE,
    ticketKeyArn: TICKET_ARN,
    ticketPublicKeySpkiBase64url: TICKET_PUBLIC_DER.toString("base64url"),
    x402KeyArn: X402_ARN,
    x402Authorizer: ACCOUNT.address.toLowerCase() as Address,
    x402Enabled: true,
    ogEnabled: true,
    ogPayerAccountId: "payer-1",
    ogInference: { secretArn: INFERENCE_ARN, versionId: VERSION_A },
    ogManagement: { secretArn: MANAGEMENT_ARN, versionId: VERSION_B },
  };
}

function session(expiresAt = 2_000): BillingSessionRefV1 {
  const facts = JSON.stringify({
    version: "billing-session-facts-v1",
    spec: {
      allowedCalls: [{ to: COLLECTOR, selector: "payInvoice(bytes32,uint64)" }],
      spendCaps: [{ limit: "1000", period: "day" }],
      expiresAt,
    },
    permissions: {
      calls: [{ signature: "payInvoice(bytes32,uint64)", to: COLLECTOR }],
      spend: [{ limit: { $uint: "1000" }, period: "day" }],
    },
    publicKey: ACCOUNT.publicKey,
    expiry: expiresAt,
  });
  return {
    domain: "4lpha.billing-session-ref.v1",
    accountId: "billing-account-1",
    wallet: WALLET,
    kmsKeyArn: SESSION_ARN,
    publicKey: ACCOUNT.publicKey,
    generation: 1n,
    expiresAt,
    sessionFactsBytes: Buffer.from(facts, "utf8").toString("base64"),
  };
}

function observation(calldata?: Hex): BillingBscObservationV1 {
  const checkedBytes = calldata ?? toFunctionSelector("payInvoice(bytes32,uint64)");
  return {
    blockNumber: 100n,
    blockHash: `0x${"22".repeat(32)}`,
    blockTimestamp: 990,
    keyStoreValid: true,
    canPayCollector: true,
    canExecuteCalldataSha256: createHash("sha256")
      .update(Buffer.from(checkedBytes.slice(2), "hex")).digest("hex"),
    accountKeys: [],
    accountKeyHashes: [],
    spendInfos: [{ token: zeroAddress, period: 2, limit: 1000n, spent: 10n,
      lastUpdated: 900n, currentSpent: 10n, current: 10n }],
    walletBalanceWei: 5000n,
  };
}

type Harness = Readonly<{
  protocols: AwsBillingAdapterProtocols;
  setPrepared(make: (input: BillingRelayPrepareV1) => PortoPreparedCollectionV1): void;
  setStatus(value: unknown): void;
  counts: { kmsSign: number; portoSend: number; secretRead: number; portoPrepare: number };
}>;

function harness(): Harness {
  const counts = { kmsSign: 0, portoSend: 0, secretRead: 0, portoPrepare: 0 };
  let statusValue: unknown = null;
  let makePrepared = (input: BillingRelayPrepareV1): PortoPreparedCollectionV1 => ({
    opaque: Object.freeze({ request: "prepared" }),
    digest: DIGEST,
    chainId: 56,
    wallet: WALLET,
    orchestrator: ORCHESTRATOR,
    orchestratorVersion: "0.5.5",
    collector: COLLECTOR,
    calldata: input.calldata,
    valueWei: input.valueWei,
    keyPublicKey: ACCOUNT.publicKey,
    intent: { eoa: WALLET, nonce: "1", expiry: 1_100,
      executionDataHash: executionHash(input), keyHash: keyHash(ACCOUNT.publicKey) },
    relayQuoteExpiresAt: 1_120,
    capabilitiesPresent: true,
    contextPresent: true,
    typedDataPresent: true,
  });
  const kms: AwsBillingKmsProtocol = {
    async describeKey(keyArn) {
      const ticketKey = keyArn === TICKET_ARN;
      return { keyArn, keySpec: ticketKey ? "ECC_NIST_EDWARDS25519" : "ECC_SECG_P256K1",
        keyUsage: "SIGN_VERIFY", keyState: "Enabled", enabled: true,
        signingAlgorithms: [ticketKey ? "ED25519_SHA_512" : "ECDSA_SHA_256"] };
    },
    async getPublicKey(keyArn) {
      const ticketKey = keyArn === TICKET_ARN;
      return { keyArn, keySpec: ticketKey ? "ECC_NIST_EDWARDS25519" : "ECC_SECG_P256K1",
        keyUsage: "SIGN_VERIFY", signingAlgorithms: [ticketKey ? "ED25519_SHA_512" : "ECDSA_SHA_256"],
        spkiDer: ticketKey ? Uint8Array.from(TICKET_PUBLIC_DER) : secpSpki(ACCOUNT.publicKey) };
    },
    async sign(input) {
      counts.kmsSign += 1;
      if (input.algorithm === "ED25519_SHA_512") return new Uint8Array(64).fill(7);
      return highSDer(`0x${Buffer.from(input.message).toString("hex")}` as Hex32);
    },
  };
  return {
    counts,
    setPrepared(make) { makePrepared = make; },
    setStatus(value) { statusValue = value; },
    protocols: {
      kms,
      secrets: { async getSecretValue(ref) {
        counts.secretRead += 1;
        const inference = ref.secretArn === INFERENCE_ARN;
        return { secretString: JSON.stringify({ version: "4lpha-0g-credential-v1",
          bearerToken: inference ? "inference-secret-token" : "management-secret-token",
          apiKeyId: inference ? "inference-key" : "management-key", payerAccountId: "payer-1" }) };
      } },
      sts: { async getCallerIdentity() {
        return { account: "123456789012",
          arn: "arn:aws:sts::123456789012:assumed-role/4lpha-billing/task-1" };
      } },
      porto: {
        async prepare(input) {
          counts.portoPrepare += 1;
          const original: BillingRelayPrepareV1 = { domain: "4lpha.billing-collection-prepare.v1",
            session: session(), collector: input.calls[0].to, calldata: input.calls[0].data,
            valueWei: input.calls[0].value, maxExpiresAt: 1_130 };
          return makePrepared(original);
        },
        async send() { counts.portoSend += 1; return { id: `0x${"33".repeat(32)}` }; },
        async status() { return statusValue; },
      },
      now: () => 1_000,
    },
  };
}

function prepareInput(): BillingRelayPrepareV1 {
  return { domain: "4lpha.billing-collection-prepare.v1", session: session(), collector: COLLECTOR,
    calldata: encodeFunctionData({ abi: PAY_INVOICE_ABI, functionName: "payInvoice",
      args: [`0x${"44".repeat(32)}`, 1_130n] }), valueWei: 5n, maxExpiresAt: 1_130 };
}

test("AWS adapter enforces Ed25519 bounds and returns base64url", async () => {
  const fixture = harness();
  const adapter = await createAwsBillingAdapterFactory(fixture.protocols)(config());
  assert.equal((await adapter.signExecutionTicket({ keyArn: TICKET_ARN,
    bytes: new Uint8Array(4_096) })).length, 86);
  const signed = fixture.counts.kmsSign;
  await assert.rejects(adapter.signExecutionTicket({ keyArn: TICKET_ARN,
    bytes: new Uint8Array(4_097) }), /ticket signing input/);
  assert.equal(fixture.counts.kmsSign, signed);
});

test("AWS adapter converts high-s KMS DER to low-s Ethereum signature", async () => {
  const fixture = harness();
  const adapter = await createAwsBillingAdapterFactory(fixture.protocols)(config());
  const signature = await adapter.signX402({ keyArn: X402_ARN, digest: DIGEST });
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  assert.ok(s <= N / 2n);
  assert.equal((await recoverAddress({ hash: DIGEST, signature })).toLowerCase(), ACCOUNT.address.toLowerCase());
});

test("AWS adapter refuses expiry zero before signing/sending and consumes handles once", async () => {
  const fixture = harness();
  const valid = fixture.protocols.porto.prepare;
  fixture.setPrepared((input) => ({ ...makeValidPrepared(input), intent: {
    ...makeValidPrepared(input).intent, expiry: 0 } }));
  const adapter = await createAwsBillingAdapterFactory(fixture.protocols)(config());
  const before = fixture.counts.kmsSign;
  await assert.rejects(adapter.relayPrepare(prepareInput()), /prepared response/);
  assert.equal(fixture.counts.kmsSign, before);
  assert.equal(fixture.counts.portoSend, 0);

  fixture.setPrepared(makeValidPrepared);
  assert.equal(typeof valid, "function");
  const prepared = await adapter.relayPrepare(prepareInput());
  const result = await adapter.relaySend(prepared);
  assert.match(result.callsId ?? "", /^0x[0-9a-f]{64}$/u);
  const afterFirstSend = fixture.counts.kmsSign;
  await assert.rejects(adapter.relaySend(prepared), /handle is missing/);
  assert.equal(fixture.counts.kmsSign, afterFirstSend);
  assert.equal(fixture.counts.portoSend, 1);
});

test("AWS adapter validates dual BSC observations and exact selector bytes", async () => {
  const fixture = harness();
  const adapter = await createAwsBillingAdapterFactory(fixture.protocols)(config());
  const good = observation();
  assert.deepEqual(await adapter.readBillingMeter({ meter: { session: session(), meterPeriod: "DAY",
    meterToken: "native" }, canExecute: { kind: "selector" }, observations: [good, good], now: 1_000 }),
  { balanceWei: 5000n, remainingDayCapWei: 990n });
  const wrong = { ...good, canExecuteCalldataSha256: "00".repeat(32) };
  await assert.rejects(adapter.readBillingSession({ session: session(), canExecute: { kind: "selector" },
    observations: [wrong, wrong],
    now: 1_000 }), /stale or unauthorized/);
});

test("adapter boot binds KMS identities and disabled 0G performs zero secret reads", async () => {
  const mismatchFixture = harness();
  const mismatched = { ...config(),
    x402Authorizer: "0x1000000000000000000000000000000000000001" as Address };
  await assert.rejects(createAwsBillingAdapterFactory(mismatchFixture.protocols)(mismatched),
    /KMS public identity/);
  assert.equal(mismatchFixture.counts.secretRead, 0);
  assert.equal(mismatchFixture.counts.portoPrepare, 0);

  const ticketMismatchFixture = harness();
  const ticketMismatch = { ...config(),
    ticketPublicKeySpkiBase64url: generateKeyPairSync("ed25519").publicKey
      .export({ format: "der", type: "spki" }).toString("base64url") };
  await assert.rejects(createAwsBillingAdapterFactory(ticketMismatchFixture.protocols)(ticketMismatch),
    /KMS public identity/);
  assert.equal(ticketMismatchFixture.counts.secretRead, 0);

  const disabledFixture = harness();
  const disabled = { ...config(), ogEnabled: false };
  const adapter = await createAwsBillingAdapterFactory(disabledFixture.protocols)(disabled);
  assert.equal(disabledFixture.counts.secretRead, 0);
  await assert.rejects(adapter.loadOgCredential(disabled.ogInference), /0G provider is disabled/);
  assert.equal(disabledFixture.counts.secretRead, 0);
});

test("manifest bridge carries every provider and expected-public-identity gate", () => {
  const manifest = parseProductionManifest(Buffer.from(GOLDEN_PRODUCTION_MANIFEST_V2));
  const bridged = billingAdapterConfigFromProductionManifest({ manifest,
    ticketPublicKeySpkiBase64url: TICKET_PUBLIC_DER.toString("base64url") });
  assert.deepEqual(Object.keys(bridged), ["domain", "awsRegion", "awsAccountId", "runtimeRoleArn", "credential",
    "relayOrigin", "chainId", "orchestrator", "keyStore", "ticketKeyArn",
    "ticketPublicKeySpkiBase64url", "x402KeyArn", "x402Authorizer", "x402Enabled", "ogEnabled",
    "ogPayerAccountId", "ogInference", "ogManagement"]);
  assert.equal(bridged.x402Authorizer, manifest.providers.x402Authorizer);
  assert.equal(bridged.x402Enabled, manifest.providers.x402Enabled);
  assert.equal(bridged.ogEnabled, manifest.providers.ogEnabled);
  assert.equal(bridged.ogPayerAccountId, manifest.providers.ogPayerAccountId);
  assert.equal(bridged.ticketPublicKeySpkiBase64url, TICKET_PUBLIC_DER.toString("base64url"));
});

test("invoice boundaries require the exact full payInvoice calldata hash", async () => {
  const fixture = harness();
  const adapter = await createAwsBillingAdapterFactory(fixture.protocols)(config());
  const input = prepareInput();
  const full = observation(input.calldata);
  assert.deepEqual(await adapter.readBillingSession({ session: session(),
    canExecute: { kind: "calldata", calldata: input.calldata }, observations: [full, full], now: 1_000 }),
  { generation: 1n, expiresAt: 2_000 });

  const selectorOnly = observation();
  await assert.rejects(adapter.readBillingSession({ session: session(),
    canExecute: { kind: "calldata", calldata: input.calldata },
    observations: [selectorOnly, selectorOnly], now: 1_000 }), /stale or unauthorized/);
  await assert.rejects(adapter.readBillingSession({ session: session(),
    canExecute: { kind: "calldata", calldata: "0x1234" },
    observations: [selectorOnly, selectorOnly], now: 1_000 }), /not payInvoice/);

  const prepareCalls = fixture.counts.portoPrepare;
  await assert.rejects(adapter.relayPrepare({ ...input,
    calldata: toFunctionSelector("payInvoice(bytes32,uint64)") }), /not payInvoice/);
  await assert.rejects(adapter.relayPrepare({ ...input, maxExpiresAt: 1_131 }), /arguments are invalid/);
  assert.equal(fixture.counts.portoPrepare, prepareCalls);
});

test("production loader imports the reviewed bytes and rejects external imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "billing-production-loader-"));
  const source = `
export async function createBillingCustodyAndRelayPrimitives() {
  return {
    signExecutionTicket: async () => "", signX402: async () => "",
    loadOgCredential: async () => ({}), readBillingSession: async () => ({}),
    readBillingMeter: async () => ({}), relayPrepare: async () => ({}),
    relaySend: async () => ({}), relayStatus: async () => ({ state: "PENDING" }),
    close: async () => undefined,
  };
}`;
  try {
    const validPath = join(root, "valid.mjs");
    await writeFile(validPath, source, "utf8");
    const adapter = await loadProductionBillingCustodyAndRelayPrimitives({ config: config(),
      moduleUrl: pathToFileURL(validPath).href,
      moduleSha256: createHash("sha256").update(source).digest("hex") });
    assert.equal(typeof adapter.relaySend, "function");

    const external = `import "viem";\n${source}`;
    const externalPath = join(root, "external.mjs");
    await writeFile(externalPath, external, "utf8");
    await assert.rejects(loadProductionBillingCustodyAndRelayPrimitives({ config: config(),
      moduleUrl: pathToFileURL(externalPath).href,
      moduleSha256: createHash("sha256").update(external).digest("hex") }), /external runtime import/);

    const stringOnly = `${source}\nexport const diagnostic = 'import "viem"';`;
    const stringOnlyPath = join(root, "string-only.mjs");
    await writeFile(stringOnlyPath, stringOnly, "utf8");
    await loadProductionBillingCustodyAndRelayPrimitives({ config: config(),
      moduleUrl: pathToFileURL(stringOnlyPath).href,
      moduleSha256: createHash("sha256").update(stringOnly).digest("hex") });

    const importMeta = `${source}\nexport const artifactUrl = import.meta.url;`;
    const importMetaPath = join(root, "import-meta.mjs");
    await writeFile(importMetaPath, importMeta, "utf8");
    await loadProductionBillingCustodyAndRelayPrimitives({ config: config(),
      moduleUrl: pathToFileURL(importMetaPath).href,
      moduleSha256: createHash("sha256").update(importMeta).digest("hex") });

    const nonliteral = `${source}\nconst specifier = "node:fs"; import(specifier);`;
    const nonliteralPath = join(root, "nonliteral.mjs");
    await writeFile(nonliteralPath, nonliteral, "utf8");
    await assert.rejects(loadProductionBillingCustodyAndRelayPrimitives({ config: config(),
      moduleUrl: pathToFileURL(nonliteralPath).href,
      moduleSha256: createHash("sha256").update(nonliteral).digest("hex") }), /external runtime import/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Porto 0.2.37 sanitized fixtures retain their reviewed bytes", async () => {
  const expected = new Map([
    ["prepare-finite.json", "6d0e1379f6b429e302b18a4cbcc0793f00884d63f7161374ebfef3eb71208486"],
    ["prepare-zero-expiry.json", "d2135ebb54a2533e442164709dc3d76cd18cc14090612a2673c6f1c50a62215a"],
    ["status-200.json", "be58596815403479260a718aec9dc136ff377aa3bd83f20cf6c908619abe83e5"],
    ["status-300.json", "dec7970c2e760e686623a69a4be349b0699637f1fbab3ab7150403f094e8303c"],
  ]);
  for (const [name, hash] of expected) {
    const bytes = await readFile(new URL(`./fixtures/billing/porto-0.2.37/${name}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  }
});

test("relay status maps only closed terminal shapes", async () => {
  const fixture = harness();
  const adapter = await createAwsBillingAdapterFactory(fixture.protocols)(config());
  const callsId = `0x${"33".repeat(32)}` as Hex32;
  const confirmed = JSON.parse(await readFile(new URL(
    "./fixtures/billing/porto-0.2.37/status-200.json", import.meta.url), "utf8")) as unknown;
  fixture.setStatus(confirmed);
  assert.deepEqual(await adapter.relayStatus(callsId), {
    state: "CONFIRMED", transactionHash: `0x${"55".repeat(32)}`,
  });
  const undocumented = JSON.parse(await readFile(new URL(
    "./fixtures/billing/porto-0.2.37/status-300.json", import.meta.url), "utf8")) as unknown;
  fixture.setStatus(undocumented);
  assert.deepEqual(await adapter.relayStatus(callsId), { state: "PENDING" });
  fixture.setStatus({ id: callsId, status: 500, receipts: [] });
  assert.deepEqual(await adapter.relayStatus(callsId), { state: "PENDING" });
});

function makeValidPrepared(input: BillingRelayPrepareV1): PortoPreparedCollectionV1 {
  return {
    opaque: Object.freeze({ request: "prepared" }), digest: DIGEST, chainId: 56, wallet: WALLET,
    orchestrator: ORCHESTRATOR, orchestratorVersion: "0.5.5", collector: COLLECTOR,
    calldata: input.calldata, valueWei: input.valueWei, keyPublicKey: ACCOUNT.publicKey,
    intent: { eoa: WALLET, nonce: "1", expiry: 1_100,
      executionDataHash: executionHash(input), keyHash: keyHash(ACCOUNT.publicKey) },
    relayQuoteExpiresAt: 1_120, capabilitiesPresent: true, contextPresent: true,
    typedDataPresent: true,
  };
}
