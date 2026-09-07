import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { from as portoKeyFrom } from "porto/viem/Key";
import { billingExpiryProbeMain } from "../scripts/billing-expiry-probe.js";
import {
  parseExpiryPrepareFixture,
  validatePortoPrepareOnlyResult,
  type ExpiryPrepareFixtureV1,
} from "../src/billing/productionExpiryProbe.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const COLLECTOR = "0xc2bdfba7753416fa21e20b5f3dca54a00cff939c" as Address;
const ORCHESTRATOR = "0xaf140d0416a994aebb3fa6212b16ce6700f09751" as Address;
const ACCOUNT = privateKeyToAccount(`0x${"00".repeat(31)}01` as Hex);
const OTHER_ACCOUNT = privateKeyToAccount(`0x${"00".repeat(31)}02` as Hex);
const ABI = [{ type: "function", name: "payInvoice", stateMutability: "payable",
  inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "maxExpiresAt", type: "uint64" }],
  outputs: [] }] as const;
const CALLDATA = encodeFunctionData({ abi: ABI, functionName: "payInvoice",
  args: [`0x${"44".repeat(32)}`, 1_100n] });

const INPUT = Object.freeze({ wallet: WALLET, collector: COLLECTOR, calldata: CALLDATA,
  valueWei: 5n, sessionPublicKey: ACCOUNT.publicKey });

function executionData(collector = COLLECTOR, calldata: Hex = CALLDATA, valueWei = 5n): Hex {
  return encodeAbiParameters([{ type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ] }], [[{ target: collector, value: valueWei, data: calldata }]]);
}

function prepared(overrides: Readonly<{
  collector?: Address;
  calldata?: Hex;
  valueWei?: bigint;
  publicKey?: Hex;
  nonce?: unknown;
  wallet?: unknown;
  orchestrator?: unknown;
  version?: unknown;
  verifyingContract?: unknown;
  extraQuoteMember?: boolean;
  extraIntentMember?: boolean;
  quoteCount?: number;
}> = {}): unknown {
  const permissions = { calls: [{ signature: "payInvoice(bytes32,uint64)" as const, to: COLLECTOR }],
    spend: [{ limit: 100n, period: "day" as const }] };
  const key = portoKeyFrom({ expiry: 1_200, permissions,
    publicKey: overrides.publicKey ?? ACCOUNT.publicKey, role: "session", type: "secp256k1" });
  const typedData = { domain: { name: "Altana", version: overrides.version ?? "0.5.5", chainId: 56,
    verifyingContract: overrides.verifyingContract ?? ORCHESTRATOR }, message: { value: `0x${"11".repeat(32)}` },
    primaryType: "Intent", types: { Intent: [{ name: "value", type: "bytes32" }] } } as const;
  const intent = { eoa: overrides.wallet ?? WALLET, executionData: executionData(overrides.collector,
    overrides.calldata, overrides.valueWei), expiry: 1_070n, nonce: overrides.nonce ?? 1n,
    ...(overrides.extraIntentMember === true ? { unreviewedIntentMember: "refuse" } : {}) };
  const selected = { chainId: 56, orchestrator: overrides.orchestrator ?? ORCHESTRATOR, intent,
    ...(overrides.extraQuoteMember === true ? { unreviewedSelectedQuoteMember: "refuse" } : {}) };
  const quote = { ttl: 1_080,
    quotes: Array.from({ length: overrides.quoteCount ?? 1 }, () => selected) };
  return { capabilities: { quote }, context: { quote },
    digest: hashTypedData(typedData as unknown as Parameters<typeof hashTypedData>[0]), key, typedData };
}

function fixtureText(calldata: Hex = CALLDATA): string {
  return JSON.stringify({ schema: "4lpha.billing-expiry-prepare-fixture.v1",
    manifestSha256: "a".repeat(64), bundleSha256: "b".repeat(64), wallet: WALLET,
    collector: COLLECTOR, calldata, valueWei: "5", maxExpiresAt: 1_100,
    sessionPublicKey: ACCOUNT.publicKey, sessionExpiresAt: 1_200, sessionDayLimitWei: "100" });
}

test("prepare-only identity validator binds exact billing execution and session key", () => {
  assert.deepEqual(validatePortoPrepareOnlyResult(INPUT, prepared()), {
    quoteExpiresAt: 1_080, intentExpiresAt: 1_070,
  });
  const mutations = [
    prepared({ collector: "0x2222222222222222222222222222222222222222" }),
    prepared({ calldata: encodeFunctionData({ abi: ABI, functionName: "payInvoice",
      args: [`0x${"55".repeat(32)}`, 1_100n] }) }),
    prepared({ valueWei: 6n }),
    prepared({ publicKey: OTHER_ACCOUNT.publicKey }),
    prepared({ nonce: "01" }),
    prepared({ wallet: "0x2222222222222222222222222222222222222222" }),
    prepared({ orchestrator: "0x2222222222222222222222222222222222222222" }),
    prepared({ version: "0.5.6" }),
    prepared({ verifyingContract: "0x2222222222222222222222222222222222222222" }),
    prepared({ extraQuoteMember: true }),
    prepared({ extraIntentMember: true }),
    prepared({ quoteCount: 2 }),
  ];
  for (const mutation of mutations) {
    assert.throws(() => validatePortoPrepareOnlyResult(INPUT, mutation), /identity drifted|ambiguous/);
  }
});

test("expiry fixture requires canonical payInvoice with maxExpiresAt bound", () => {
  assert.equal(parseExpiryPrepareFixture(Buffer.from(fixtureText())).calldata, CALLDATA);
  assert.throws(() => parseExpiryPrepareFixture(Buffer.from(fixtureText("0x1234"))), /payInvoice/);
  const wrongExpiry = encodeFunctionData({ abi: ABI, functionName: "payInvoice",
    args: [`0x${"44".repeat(32)}`, 1_101n] });
  assert.throws(() => parseExpiryPrepareFixture(Buffer.from(fixtureText(wrongExpiry))), /arguments are invalid/);
});

test("expiry CLI emits one constant refusal for sensitive external failures", async () => {
  const secret = "https://relay.altana.network body={token:super-secret} request-id=aws-sensitive";
  let stderr = "";
  let writes = 0;
  const exit = await billingExpiryProbeMain(["--yes-prepare-only", "--input", "fixture", "--out", "out"], {
    async readInput() { return Buffer.from(fixtureText()); },
    async assertNewOutput() { /* new output */ },
    async writeNewOutput() { writes += 1; },
    createPrepareOnly: () => ({ now: () => 1_000,
      async prepare() { throw new Error(secret); }, async close() { /* no-op */ } }),
    writeStderr(value) { stderr += value; },
  });
  assert.equal(exit, 1);
  assert.equal(writes, 0);
  assert.equal(stderr, '{"error":"expiry-probe-refused"}\n');
  assert.equal(stderr.includes("super-secret"), false);
  assert.equal(stderr.includes("request-id"), false);
  assert.equal(stderr.includes("relay.altana.network"), false);
});

test("expiry CLI also sanitizes a sensitive close failure", async () => {
  let stderr = "";
  const fixture = parseExpiryPrepareFixture(Buffer.from(fixtureText())) as ExpiryPrepareFixtureV1;
  assert.equal(fixture.maxExpiresAt, 1_100);
  const exit = await billingExpiryProbeMain(["--yes-prepare-only", "--input", "fixture", "--out", "out"], {
    async readInput() { return Buffer.from(fixtureText()); }, async assertNewOutput() { /* new output */ },
    async writeNewOutput() { throw new Error("should not write"); },
    createPrepareOnly: () => ({ now: () => 1_000,
      async prepare() { return { quoteExpiresAt: 1_080, intentExpiresAt: 1_070 }; },
      async close() { throw new Error("provider-body-sensitive"); } }),
    writeStderr(value) { stderr += value; },
  });
  assert.equal(exit, 1);
  assert.equal(stderr, '{"error":"expiry-probe-refused"}\n');
  assert.equal(stderr.includes("provider-body-sensitive"), false);
});
