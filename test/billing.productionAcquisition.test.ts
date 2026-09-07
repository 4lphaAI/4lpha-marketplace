import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  encodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  padHex,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import {
  acquireBillingAuthorityPair,
  acquirePostdeployPair,
  acquireReadOnlyPreflight,
  acquireRpcCapabilityPair,
  type ReadOnlyRpcClient,
} from "../src/billing/productionAcquisition.js";
import type { BillingCanExecuteCheckV1, BillingSessionRefV1, Hex32 } from "../src/billing/custody.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";
import { billingEnablePreflightMain } from "../scripts/billing-enable-preflight.js";
import { billingExpiryProbeMain } from "../scripts/billing-expiry-probe.js";
import { billingPostdeployVerifyMain } from "../scripts/billing-postdeploy-verify.js";
import {
  acquireExpiryEvidence,
  parseExpiryPrepareFixture,
} from "../src/billing/productionExpiryProbe.js";
import { canonicalProductionManifest, parseProductionManifest, type BillingProductionManifestV2 } from "../src/billing/productionManifest.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const encoder = new TextEncoder();
const golden = parseProductionManifest(encoder.encode(GOLDEN_PRODUCTION_MANIFEST_V2));
const RUNTIME = "0x6000" as Hex;
const SELECTED_HASH = `0x${"1".repeat(64)}` as Hex;
const SESSION_ACCOUNT = privateKeyToAccount(`0x${"00".repeat(31)}01` as Hex);
const SESSION_REF: BillingSessionRefV1 = { domain: "4lpha.billing-session-ref.v1",
  accountId: "billing-account-1", wallet: "0x2000000000000000000000000000000000000002",
  kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/session-key",
  publicKey: SESSION_ACCOUNT.publicKey, generation: 1n, expiresAt: 200_000,
  sessionFactsBytes: "e30=" };

const CHAINLINK_ABI = [
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
    { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
    { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" },
  ] },
] as const;
const ERC20_BALANCE_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const TREASURY_ABI = [{ type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;
const PROBE_PAY_INVOICE_ABI = [{ type: "function", name: "payInvoice", stateMutability: "payable",
  inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "maxExpiresAt", type: "uint64" }], outputs: [] }] as const;
const PROBE_CALLDATA = encodeFunctionData({ abi: PROBE_PAY_INVOICE_ABI, functionName: "payInvoice",
  args: [`0x${"44".repeat(32)}`, 1_100n] });

function manifestWithRuntime(): BillingProductionManifestV2 {
  return { ...golden, collector: { ...golden.collector, runtimeCodehash: keccak256(RUNTIME) } };
}

function rpcClient(handler: (origin: string, method: string, params: readonly unknown[]) => unknown | Promise<unknown>): ReadOnlyRpcClient {
  return { rpc: async (origin, method, params) => handler(origin, method, params), close: async () => undefined };
}

function chainFor(origin: string): 56 | 8453 | 42161 {
  if (origin.includes("bsc-")) return 56;
  if (origin.includes("base-")) return 8453;
  return 42161;
}

function headFor(origin: string): bigint {
  if (origin.includes("bsc-a")) return 130n;
  if (origin.includes("bsc-b")) return 132n;
  if (origin.includes("base-a")) return 140n;
  if (origin.includes("base-b")) return 145n;
  if (origin.includes("arb-a")) return 150n;
  return 151n;
}

function callRow(params: readonly unknown[]): Record<string, unknown> {
  const value = params[0];
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("bad call fixture");
  return value as Record<string, unknown>;
}

function preflightHandler(
  manifest: BillingProductionManifestV2,
  calls: Array<Readonly<{ origin: string; method: string; params: readonly unknown[] }>> = [],
): (origin: string, method: string, params: readonly unknown[]) => unknown {
  return (origin, method, params) => {
    calls.push({ origin, method, params });
    const chainId = chainFor(origin);
    if (method === "eth_chainId") return toHex(chainId);
    if (method === "eth_blockNumber") return toHex(headFor(origin));
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: SELECTED_HASH, timestamp: toHex(99_990) };
    if (method === "eth_getCode") return RUNTIME;
    if (method === "eth_getBalance") return toHex(BigInt(manifest.caps.minBaseGasReserveWei));
    if (method === "eth_call") {
      const call = callRow(params);
      if (call["to"] === manifest.collector.address) return encodeFunctionResult({ abi: TREASURY_ABI, functionName: "treasury", result: manifest.collector.treasury });
      if (call["to"] === manifest.networks.baseUsdc.address) return encodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", result: 5n });
      const feed = call["to"] === manifest.oracles.bnbUsd.proxy ? manifest.oracles.bnbUsd
        : call["to"] === manifest.oracles.ogUsd.proxy ? manifest.oracles.ogUsd : manifest.oracles.arbitrumSequencer;
      if (call["data"] === encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "description" })) {
        return encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "description", result: feed.description });
      }
      if (call["data"] === encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "decimals" })) {
        return encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "decimals", result: feed.decimals });
      }
      const sequencer = feed.decimals === 0;
      return encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "latestRoundData",
        result: [10n, sequencer ? 0n : 100_000_000n, sequencer ? 96_000n : 90_000n,
          sequencer ? 99_990n : feed.description === "BNB / USD" ? 99_980n : 90_100n, 10n] });
    }
    throw new Error(`unexpected method ${method}`);
  };
}

function authorityKeyHash(): Hex32 {
  const inner = keccak256(padHex(publicKeyToAddress(SESSION_REF.publicKey), { size: 32 }));
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, inner])) as Hex32;
}

function authorityHandler(
  canExecuteData: Hex,
  calls: Array<Readonly<{ origin: string; method: string; params: readonly unknown[] }>>,
  blockHash: (origin: string) => Hex = () => SELECTED_HASH,
): (origin: string, method: string, params: readonly unknown[]) => unknown {
  const keyStoreId = keccak256(SESSION_REF.publicKey);
  const keyHash = authorityKeyHash();
  return (origin, method, params) => {
    calls.push({ origin, method, params });
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return origin.includes("bsc-a") ? "0x82" : "0x84";
    if (method === "eth_getBlockByNumber") {
      return { number: params[0], hash: blockHash(origin), timestamp: "0x18696" };
    }
    if (method === "eth_getBalance") return "0x1388";
    if (method === "eth_call") {
      const call = callRow(params);
      const data = call["data"];
      if (data === encodeFunctionData({ abi: KEYSTORE_ABI, functionName: "isValidKey",
        args: [SESSION_REF.wallet, keyStoreId] })) {
        return encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", result: true });
      }
      if (data === encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "getKeys" })) {
        return encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "getKeys",
          result: [[{ expiry: 0, keyType: 2, isSuperAdmin: true, publicKey: "0x1234" }],
            [`0x${"77".repeat(32)}`]] });
      }
      if (data === encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "canExecute",
        args: [keyHash, golden.collector.address, canExecuteData] })) {
        return encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "canExecute", result: true });
      }
      if (data === encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "spendInfos", args: [keyHash] })) {
        return encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "spendInfos", result: [{
          token: zeroAddress, period: 2, limit: 1000n, spent: 10n, lastUpdated: 90_000n,
          currentSpent: 10n, current: 10n,
        }] });
      }
    }
    throw new Error(`unexpected authority RPC ${origin} ${method} ${JSON.stringify(params)}`);
  };
}

test("billing authority acquisition pins every read to min dual head minus 15", async () => {
  const calls: Array<Readonly<{ origin: string; method: string; params: readonly unknown[] }>> = [];
  const selector = toFunctionSelector("payInvoice(bytes32,uint64)");
  const observations = await acquireBillingAuthorityPair({ client: rpcClient(authorityHandler(selector, calls)),
    manifest: golden, session: SESSION_REF, canExecute: { kind: "selector" } });
  assert.equal(observations[0].blockNumber, 115n);
  assert.equal(observations[1].blockNumber, 115n);
  assert.equal(observations[0].blockHash, SELECTED_HASH);
  assert.deepEqual(observations[0], observations[1]);
  assert.equal(observations[0].keyStoreValid, true);
  assert.equal(observations[0].canPayCollector, true);
  assert.equal(observations[0].walletBalanceWei, 5000n);
  assert.equal(observations[0].canExecuteCalldataSha256,
    createHash("sha256").update(Buffer.from(selector.slice(2), "hex")).digest("hex"));
  const stateCalls = calls.filter((call) => call.method === "eth_call" || call.method === "eth_getBalance");
  assert.equal(stateCalls.length, 10);
  assert.equal(stateCalls.every((call) => call.params[1] === "0x73"), true);
});

test("billing authority acquisition binds exact invoice calldata and refuses dual-block disagreement", async () => {
  const calldata = encodeFunctionData({ abi: [{ type: "function", name: "payInvoice",
    stateMutability: "payable", inputs: [{ name: "invoiceId", type: "bytes32" },
      { name: "quoteExpiresAt", type: "uint64" }], outputs: [] }] as const,
  functionName: "payInvoice", args: [`0x${"44".repeat(32)}`, 120_000n] });
  const check: BillingCanExecuteCheckV1 = { kind: "calldata", calldata };
  const calls: Array<Readonly<{ origin: string; method: string; params: readonly unknown[] }>> = [];
  const observations = await acquireBillingAuthorityPair({ client: rpcClient(authorityHandler(calldata, calls)),
    manifest: golden, session: SESSION_REF, canExecute: check });
  assert.equal(observations[0].canExecuteCalldataSha256,
    createHash("sha256").update(Buffer.from(calldata.slice(2), "hex")).digest("hex"));
  assert.equal(calls.filter((call) => call.method === "eth_call" &&
    (callRow(call.params)["data"] as string).includes(calldata.slice(2))).length, 2);

  let stateCalls = 0;
  const disagreement = rpcClient((origin, method, params) => {
    if (method === "eth_call" || method === "eth_getBalance") stateCalls += 1;
    return authorityHandler(calldata, [], (source) => source.includes("bsc-a")
      ? SELECTED_HASH : `0x${"2".repeat(64)}` as Hex)(origin, method, params);
  });
  await assert.rejects(acquireBillingAuthorityPair({ client: disagreement, manifest: golden,
    session: SESSION_REF, canExecute: check }), /selected-block observations disagree/);
  assert.equal(stateCalls, 0);
});

test("billing authority acquisition rejects malformed boundary before any RPC", async () => {
  let calls = 0;
  const client = rpcClient(() => { calls += 1; throw new Error("unreachable"); });
  await assert.rejects(acquireBillingAuthorityPair({ client, manifest: golden, session: SESSION_REF,
    canExecute: { kind: "calldata", calldata: "0x1" as Hex } }), /boundary is malformed/);
  assert.equal(calls, 0);
});

function canonicalManifestArtifacts(bundle: Uint8Array, source: Uint8Array, lock: Uint8Array): Readonly<{
  text: string;
  manifest: BillingProductionManifestV2;
}> {
  const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
  const collector = { ...golden.collector, runtimeCodehash: keccak256(RUNTIME), attestationSha256: "" };
  collector.attestationSha256 = createHash("sha256").update(JSON.stringify({ schema: "4lpha.billing-collector-attestation.v1",
    chainId: 56, address: collector.address, treasury: collector.treasury, deployer: collector.deployer, nonce: collector.nonce,
    deploymentTxHash: collector.deploymentTxHash, deploymentBlock: collector.deploymentBlock,
    deploymentBlockHash: collector.deploymentBlockHash, runtimeCodehash: collector.runtimeCodehash })).digest("hex");
  const text = canonicalProductionManifest({ ...golden, sourceSha256: digest(source), lockSha256: digest(lock),
    bundleSha256: digest(bundle), collector });
  return { text, manifest: parseProductionManifest(encoder.encode(text)) };
}

function postdeployHandler(manifest: BillingProductionManifestV2, initcode: Hex): (origin: string, method: string, params: readonly unknown[]) => unknown {
  return (origin, method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return origin.endsWith("a.example.com") ? "0x82" : "0x84";
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "0x73") return { number: "0x73", hash: SELECTED_HASH, timestamp: toHex(99_990) };
      return { number: "0x64", hash: manifest.collector.deploymentBlockHash, timestamp: toHex(90_000) };
    }
    if (method === "eth_getTransactionByHash") return { hash: manifest.collector.deploymentTxHash,
      from: manifest.collector.deployer, nonce: "0x1", to: null, input: initcode };
    if (method === "eth_getTransactionReceipt") return { status: "0x1", contractAddress: manifest.collector.address,
      blockNumber: "0x64", blockHash: manifest.collector.deploymentBlockHash };
    if (method === "eth_getCode") return RUNTIME;
    if (method === "eth_call") return encodeFunctionResult({ abi: TREASURY_ABI, functionName: "treasury", result: manifest.collector.treasury });
    throw new Error(`unexpected ${method}`);
  };
}

test("read-only preflight acquires closed DNS/RPC-facing evidence at min-head finalized blocks", async () => {
  const manifest = manifestWithRuntime();
  const calls: Array<Readonly<{ origin: string; method: string; params: readonly unknown[] }>> = [];
  const client = rpcClient(preflightHandler(manifest, calls));
  const report = await acquireReadOnlyPreflight({ client, manifest, now: 100_000, liveUsdcExposureAtomic: "5",
    manifestSha256: "a".repeat(64), bundleSha256: "b".repeat(64) });
  assert.equal(report.result, "pass");
  assert.equal(report.bscSelectedBlock, "115");
  assert.equal(report.baseSelectedBlock, "120");
  assert.equal(report.arbitrumSelectedBlock, "130");
  const baseBalanceTags = calls.filter((call) => call.origin.includes("base-") && (call.method === "eth_getBalance" || call.method === "eth_call"))
    .map((call) => call.method === "eth_getBalance" ? call.params[1] : call.params[1]);
  assert.deepEqual(baseBalanceTags, ["0x78", "0x78", "0x78", "0x78"]);
  assert.equal(calls.some((call) => !["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getBalance", "eth_call"].includes(call.method)), false);
});

test("billing-enable-preflight read-only command validates local artifacts before constructing acquisition", async () => {
  const bundle = encoder.encode("bundle");
  const source = encoder.encode("source");
  const lock = encoder.encode("lock");
  const built = canonicalManifestArtifacts(bundle, source, lock);
  const manifest = built.manifest;
  const files: Readonly<Record<string, Uint8Array>> = { manifest: encoder.encode(built.text), bundle, source, lock };
  let clients = 0;
  let exposureReads = 0;
  let written = "";
  const exit = await billingEnablePreflightMain(["--read-only", "--yes-read-only", "--manifest", "manifest", "--bundle", "bundle",
    "--source", "source", "--lock", "lock", "--database-url-file", "database-url", "--out", "out"], {
    files: { platform: "linux", readFile: async (path) => files[path]!, stat: async (path) => ({ isFile: true,
      isSymbolicLink: false, mode: 0o100600, size: files[path]!.byteLength }) },
    now: () => 100_000,
    async readExposure(_path, input) { exposureReads += 1; assert.equal(input.migrationVersion, "006_phase5_production_enablement.sql");
      assert.equal(input.x402Authorizer, manifest.providers.x402Authorizer); return 5n; },
    async createRpcClient() { clients += 1; return rpcClient(preflightHandler(manifest)); },
    async assertNewOutput() { /* new path fixture */ },
    async writeNewOutput(_path, bytes) { written = new TextDecoder().decode(bytes); },
  });
  assert.equal(exit, 0);
  assert.equal(clients, 1);
  assert.equal(exposureReads, 1);
  assert.equal(JSON.parse(written).result, "pass");
});

test("read-only preflight cannot accept caller exposure and performs zero RPC when PostgreSQL census refuses", async () => {
  let clients = 0;
  const exit = await billingEnablePreflightMain(["--read-only", "--yes-read-only", "--manifest", "manifest", "--bundle", "bundle",
    "--source", "source", "--lock", "lock", "--live-usdc-exposure", "0", "--out", "out"], {
    files: { platform: "linux", readFile: async () => new Uint8Array(), stat: async () => ({ isFile: true, isSymbolicLink: false, mode: 0o100600, size: 0 }) },
    now: () => 100_000, async readExposure() { throw new Error("must not reach"); },
    async createRpcClient() { clients += 1; throw new Error("must not reach"); }, async assertNewOutput() { /* no-op */ },
    async writeNewOutput() { throw new Error("must not reach"); },
  });
  assert.equal(exit, 2);
  assert.equal(clients, 0);
});

test("RPC acquisition accepts skewed heads but rejects selected-block disagreement", async () => {
  const origins = golden.networks.bsc.origins;
  const good = rpcClient((origin, method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return origin === origins[0] ? "0x82" : "0x84";
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: SELECTED_HASH, timestamp: "0x18696" };
    throw new Error("unexpected");
  });
  const pair = await acquireRpcCapabilityPair(good, origins, 56, 15);
  assert.equal(pair[0].selectedBlockNumber, "115");
  assert.equal(pair[1].latestBlockNumber, "132");
  const bad = rpcClient((origin, method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return origin === origins[0] ? "0x82" : "0x84";
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: origin === origins[0] ? SELECTED_HASH : `0x${"2".repeat(64)}`, timestamp: "0x18696" };
    throw new Error("unexpected");
  });
  await assert.rejects(acquireRpcCapabilityPair(bad, origins, 56, 15), /selected-block observations disagree/u);
});

test("postdeploy acquisition performs dual finalized BSC reads and binds receipt-block code", async () => {
  const manifest = manifestWithRuntime();
  const initcode = "0x60006000" as Hex;
  const client = rpcClient(postdeployHandler(manifest, initcode));
  const observations = await acquirePostdeployPair({ client, manifest, expectedInitcodeHash: keccak256(initcode), now: 100_000 });
  assert.equal(observations[0].finalizedBlockNumber, "115");
  assert.equal(observations[1].runtimeCodehash, manifest.collector.runtimeCodehash);
});

test("billing-postdeploy-verify command acquires dual BSC evidence instead of trusting a fixture", async () => {
  const built = canonicalManifestArtifacts(encoder.encode("bundle"), encoder.encode("source"), encoder.encode("lock"));
  const initcode = "0x60006000" as Hex;
  const initcodeBytes = Uint8Array.from(Buffer.from(initcode.slice(2), "hex"));
  let clients = 0;
  let output = "";
  const exit = await billingPostdeployVerifyMain(["--yes-read-only", "--manifest", "manifest", "--initcode", "initcode", "--out", "result"], {
    now: () => 100_000,
    async createRpcClient() { clients += 1; return rpcClient(postdeployHandler(built.manifest, initcode)); },
    async readInput(path) { return path === "manifest" ? encoder.encode(built.text) : initcodeBytes; },
    async assertNewOutput() { /* new path fixture */ },
    async writeNewOutput(_path, bytes) { output = new TextDecoder().decode(bytes); },
  });
  assert.equal(exit, 0);
  assert.equal(clients, 1);
  const result = JSON.parse(output);
  assert.equal(result.schema, "4lpha.billing-postdeploy-read-only-result.v1");
  assert.equal(result.observations.length, 2);
});

test("prepare-only expiry acquisition calls one injected prepare and emits redacted evidence", async () => {
  const fixtureText = JSON.stringify({ schema: "4lpha.billing-expiry-prepare-fixture.v1",
    manifestSha256: "a".repeat(64), bundleSha256: "b".repeat(64), wallet: "0x1111111111111111111111111111111111111111",
    collector: golden.collector.address, calldata: PROBE_CALLDATA, valueWei: "1", maxExpiresAt: 1_100,
    sessionPublicKey: `0x04${"1".repeat(128)}`, sessionExpiresAt: 1_200, sessionDayLimitWei: "100" });
  const fixture = parseExpiryPrepareFixture(encoder.encode(fixtureText));
  let prepares = 0;
  const evidence = await acquireExpiryEvidence(fixture, { now: () => 1_000,
    async prepare() { prepares += 1; return { quoteExpiresAt: 1_080, intentExpiresAt: 1_070 }; }, async close() { /* no-op */ } });
  assert.equal(prepares, 1);
  assert.equal(evidence.result, "finite-candidate");
  const encoded = JSON.stringify(evidence);
  assert.equal(encoded.includes(fixture.wallet), false);
  assert.equal(encoded.includes(fixture.sessionPublicKey), false);
  assert.equal(encoded.includes(fixture.calldata), false);
});

test("billing-expiry-probe command uses the prepare-only capability and writes only canonical evidence", async () => {
  const fixtureText = JSON.stringify({ schema: "4lpha.billing-expiry-prepare-fixture.v1",
    manifestSha256: "a".repeat(64), bundleSha256: "b".repeat(64), wallet: "0x1111111111111111111111111111111111111111",
    collector: golden.collector.address, calldata: PROBE_CALLDATA, valueWei: "1", maxExpiresAt: 1_100,
    sessionPublicKey: `0x04${"1".repeat(128)}`, sessionExpiresAt: 1_200, sessionDayLimitWei: "100" });
  let prepares = 0;
  let output = "";
  const exit = await billingExpiryProbeMain(["--yes-prepare-only", "--input", "fixture", "--out", "evidence"], {
    async readInput() { return encoder.encode(fixtureText); }, async assertNewOutput() { /* new path fixture */ },
    async writeNewOutput(_path, bytes) { output = new TextDecoder().decode(bytes); },
    createPrepareOnly: () => ({ now: () => 1_000, async prepare() { prepares += 1; return { quoteExpiresAt: 1_080, intentExpiresAt: 1_070 }; }, async close() { /* no-op */ } }),
  });
  assert.equal(exit, 0);
  assert.equal(prepares, 1);
  assert.equal(JSON.parse(output).result, "finite-candidate");
  assert.equal(output.includes("0x1111111111111111111111111111111111111111"), false);
});

test("production expiry probe has structurally no KMS, signing, binding, or send import", async () => {
  const source = await readFile("src/billing/productionExpiryProbe.ts", "utf8");
  assert.doesNotMatch(source, /client-kms|KMSClient|SignCommand|sendPreparedCalls|relaySend|consumePrepared/u);
  assert.match(source, /prepareCalls as portoPrepareCalls/u);
});
