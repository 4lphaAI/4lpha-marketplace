import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import {
  encodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  keccak256,
  padHex,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type {
  BillingAccountKeyV1,
  BillingBscObservationV1,
  BillingCanExecuteCheckV1,
  BillingSessionRefV1,
  BillingSpendInfoV1,
  Hex32,
} from "./custody.js";
import type { OracleObservation } from "./oracles.js";
import {
  runtimeCodehash,
  validatePlatformBalanceEvidence,
  validatePostdeployEvidence,
  validateProductionOracleEvidence,
  validateRpcCapabilityEvidence,
  type BaseBalanceObservationV1,
  type PostdeployRpcObservationV1,
  type RpcFinalizedObservationV1,
} from "./productionEvidence.js";
import { ALTANA_KEYSTORE, type BillingProductionManifestV2, type FeedV1 } from "./productionManifest.js";
import {
  resolveBillingOriginPins,
  type BillingDestinationPin,
  type LookupAll,
} from "./transport.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../wallet/abis.js";
import {
  parseBillingSessionOwnerParamsBytes,
  type BillingSessionActionV1,
  type BillingSessionChainObservationV1,
} from "./sessionGenerations.js";

const MAX_RPC_BYTES = 8 * 1024 * 1024;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/u;
const HEX32 = /^0x[0-9a-f]{64}$/u;
const ALLOWED_RPC_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBalance", "eth_call",
  "eth_getCode", "eth_getTransactionByHash", "eth_getTransactionReceipt",
]);

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

export type ReadOnlyRpcClient = Readonly<{
  rpc(origin: string, method: string, params: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}>;

export type ReadOnlyPreflightEvidenceV1 = Readonly<{
  schema: "4lpha.billing-read-only-preflight.v1";
  observedAt: number;
  manifestSha256: string;
  bundleSha256: string;
  bscSelectedBlock: string;
  baseSelectedBlock: string;
  arbitrumSelectedBlock: string;
  collectorRuntimeCodehash: Hex;
  collectorTreasury: Address;
  baseNativeBalanceWei: string;
  baseUsdcBalanceAtomic: string;
  liveUsdcExposureAtomic: string;
  result: "pass";
}>;

function row(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is malformed.`);
  return value as Record<string, unknown>;
}

function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) throw new Error(`${field} is not a canonical RPC quantity.`);
  return BigInt(value);
}

function bytes(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) throw new Error(`${field} is not canonical RPC bytes.`);
  return value as Hex;
}

function hash(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) throw new Error(`${field} is not lowercase bytes32.`);
  return value as Hex;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || value !== value.toLowerCase() || !isAddress(value, { strict: false })) {
    throw new Error(`${field} is not a lowercase address.`);
  }
  return value as Address;
}

function safeSecond(value: bigint, field: string): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} is outside safe Unix seconds.`);
  return Number(value);
}

function blockTag(value: bigint): Hex {
  return toHex(value);
}

async function head(client: ReadOnlyRpcClient, origin: string, chainId: 56 | 8453 | 42161): Promise<bigint> {
  const [actualChain, latest] = await Promise.all([
    client.rpc(origin, "eth_chainId", []),
    client.rpc(origin, "eth_blockNumber", []),
  ]);
  if (quantity(actualChain, "RPC chain ID") !== BigInt(chainId)) throw new Error("RPC chain identity drifted.");
  return quantity(latest, "RPC latest block");
}

async function block(client: ReadOnlyRpcClient, origin: string, number: bigint): Promise<Readonly<{ hash: Hex; timestamp: number }>> {
  const value = row(await client.rpc(origin, "eth_getBlockByNumber", [blockTag(number), false]), "RPC block");
  if (quantity(value["number"], "RPC block number") !== number) throw new Error("RPC returned a different block number.");
  return { hash: hash(value["hash"], "RPC block hash"), timestamp: safeSecond(quantity(value["timestamp"], "RPC block timestamp"), "RPC block timestamp") };
}

export async function acquireRpcCapabilityPair(
  client: ReadOnlyRpcClient,
  origins: readonly [string, string],
  chainId: 56 | 8453 | 42161,
  depth: 15 | 20,
): Promise<readonly [RpcFinalizedObservationV1, RpcFinalizedObservationV1]> {
  const [latestA, latestB] = await Promise.all([head(client, origins[0], chainId), head(client, origins[1], chainId)]);
  const minimum = latestA < latestB ? latestA : latestB;
  if (minimum < BigInt(depth)) throw new Error("RPC head is below finalized depth.");
  const selected = minimum - BigInt(depth);
  const [blockA, blockB] = await Promise.all([block(client, origins[0], selected), block(client, origins[1], selected)]);
  if (blockA.hash !== blockB.hash || blockA.timestamp !== blockB.timestamp) throw new Error("RPC selected-block observations disagree.");
  return [
    { origin: origins[0], chainId, latestBlockNumber: latestA.toString(), selectedBlockNumber: selected.toString(), selectedBlockHash: blockA.hash, selectedBlockTimestamp: blockA.timestamp },
    { origin: origins[1], chainId, latestBlockNumber: latestB.toString(), selectedBlockNumber: selected.toString(), selectedBlockHash: blockB.hash, selectedBlockTimestamp: blockB.timestamp },
  ];
}

function accountKeyHash(publicKey: Hex): Hex32 {
  const publicKeyHash = keccak256(padHex(publicKeyToAddress(publicKey), { size: 32 }));
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }], [2n, publicKeyHash],
  )) as Hex32;
}

function canExecuteBytes(check: BillingCanExecuteCheckV1): Hex {
  if (check.kind === "selector" && Object.keys(check).join("|") === "kind") {
    return toFunctionSelector("payInvoice(bytes32,uint64)");
  }
  if (check.kind === "calldata" && Object.keys(check).join("|") === "kind|calldata" &&
      typeof check.calldata === "string" && HEX_BYTES.test(check.calldata)) return check.calldata;
  throw new Error("Billing canExecute boundary is malformed.");
}

/**
 * Acquires core-owned BSC authority at one dual-provider finalized block.
 * Every state read carries the explicit `min(headA,headB)-15` block tag.
 */
export async function acquireBillingAuthorityPair(input: Readonly<{
  client: ReadOnlyRpcClient;
  manifest: BillingProductionManifestV2;
  session: BillingSessionRefV1;
  canExecute: BillingCanExecuteCheckV1;
}>): Promise<readonly [BillingBscObservationV1, BillingBscObservationV1]> {
  const calldata = canExecuteBytes(input.canExecute);
  const capability = await acquireRpcCapabilityPair(input.client, input.manifest.networks.bsc.origins, 56, 15);
  const selected = BigInt(capability[0].selectedBlockNumber);
  const tag = blockTag(selected);
  const keyStoreId = keccak256(input.session.publicKey) as Hex32;
  const localKeyHash = accountKeyHash(input.session.publicKey);
  const calldataSha256 = createHash("sha256").update(Buffer.from(calldata.slice(2), "hex")).digest("hex");

  const observe = async (index: 0 | 1): Promise<BillingBscObservationV1> => {
    const origin = input.manifest.networks.bsc.origins[index];
    const call = async <abi extends readonly unknown[], name extends string>(
      address: Address,
      abi: abi,
      functionName: name,
      args?: readonly unknown[],
    ): Promise<Hex> => bytes(await input.client.rpc(origin, "eth_call", [{ to: address,
      data: encodeFunctionData({ abi, functionName, ...(args === undefined ? {} : { args }) } as never) }, tag]),
    `billing authority ${functionName}`);
    const [validRaw, keysRaw, canExecuteRaw, spendRaw, balanceRaw] = await Promise.all([
      call(ALTANA_KEYSTORE, KEYSTORE_ABI, "isValidKey", [input.session.wallet, keyStoreId]),
      call(input.session.wallet, ACCOUNT_ABI, "getKeys"),
      call(input.session.wallet, ACCOUNT_ABI, "canExecute",
        [localKeyHash, input.manifest.collector.address, calldata]),
      call(input.session.wallet, ACCOUNT_ABI, "spendInfos", [localKeyHash]),
      input.client.rpc(origin, "eth_getBalance", [input.session.wallet, tag]),
    ]);
    const keyStoreValid = decodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", data: validRaw });
    const [keys, keyHashes] = decodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "getKeys", data: keysRaw });
    const canPayCollector = decodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "canExecute", data: canExecuteRaw });
    const spendInfos = decodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "spendInfos", data: spendRaw });
    const accountKeys: BillingAccountKeyV1[] = keys.map((key) => ({ expiry: BigInt(key.expiry),
      keyType: key.keyType, isSuperAdmin: key.isSuperAdmin, publicKey: key.publicKey }));
    const meters: BillingSpendInfoV1[] = spendInfos.map((meter) => ({
      token: meter.token.toLowerCase() as Address, period: meter.period, limit: meter.limit,
      spent: meter.spent, lastUpdated: meter.lastUpdated, currentSpent: meter.currentSpent,
      current: meter.current,
    }));
    return { blockNumber: selected, blockHash: capability[index].selectedBlockHash as Hex32,
      blockTimestamp: capability[index].selectedBlockTimestamp, keyStoreValid, canPayCollector,
      canExecuteCalldataSha256: calldataSha256, accountKeys,
      accountKeyHashes: keyHashes as readonly Hex32[], spendInfos: meters,
      walletBalanceWei: quantity(balanceRaw, "billing wallet balance") };
  };
  return Promise.all([observe(0), observe(1)]);
}

/** Observe one already-contacted owner session action at its receipt block. */
export async function acquireBillingSessionActionObservationPair(input: Readonly<{
  client: ReadOnlyRpcClient;
  manifest: BillingProductionManifestV2;
  action: BillingSessionActionV1;
  transactionHash: Hex;
  wallet: Address;
}>): Promise<readonly [BillingSessionChainObservationV1, BillingSessionChainObservationV1] | null> {
  const params = parseBillingSessionOwnerParamsBytes(input.action.ownerParamsBytes);
  if (input.action.callsId === undefined || !HEX32.test(input.transactionHash) ||
      input.transactionHash !== input.transactionHash.toLowerCase() ||
      address(params.wallet, "session action wallet") !== input.wallet.toLowerCase() ||
      address(params.collector, "session action collector") !== input.manifest.collector.address) {
    throw new Error("Billing session action observation identity is malformed.");
  }
  const callsId = input.action.callsId;
  const [latestA, latestB, receiptA, receiptB] = await Promise.all([
    head(input.client, input.manifest.networks.bsc.origins[0], 56),
    head(input.client, input.manifest.networks.bsc.origins[1], 56),
    input.client.rpc(input.manifest.networks.bsc.origins[0], "eth_getTransactionReceipt", [input.transactionHash]),
    input.client.rpc(input.manifest.networks.bsc.origins[1], "eth_getTransactionReceipt", [input.transactionHash]),
  ]);
  if (receiptA === null || receiptB === null) return null;
  const receipts = [row(receiptA, "session action receipt"), row(receiptB, "session action receipt")] as const;
  const localKeyHash = accountKeyHash(params.kmsPublicKey);
  const selector = toFunctionSelector("payInvoice(bytes32,uint64)");
  const observe = async (index: 0 | 1, latest: bigint): Promise<BillingSessionChainObservationV1 | null> => {
    const receipt = receipts[index];
    const receiptBlock = quantity(receipt["blockNumber"], "session action receipt block");
    if (latest < receiptBlock + 15n) return null;
    const receiptHash = hash(receipt["blockHash"], "session action receipt block hash");
    if (hash(receipt["transactionHash"], "session action receipt transaction") !== input.transactionHash) {
      throw new Error("Billing session receipt transaction identity drifted.");
    }
    const origin = input.manifest.networks.bsc.origins[index];
    const tag = blockTag(receiptBlock);
    const call = async <abi extends readonly unknown[], name extends string>(
      target: Address, abi: abi, functionName: name, args?: readonly unknown[],
    ): Promise<Hex> => bytes(await input.client.rpc(origin, "eth_call", [{ to: target,
      data: encodeFunctionData({ abi, functionName, ...(args === undefined ? {} : { args }) } as never) }, tag]),
    `session action ${functionName}`);
    const [blockRaw, validRaw, keysRaw, canExecuteRaw, spendRaw] = await Promise.all([
      input.client.rpc(origin, "eth_getBlockByNumber", [tag, false]),
      call(ALTANA_KEYSTORE, KEYSTORE_ABI, "isValidKey", [input.wallet, input.action.targetKeyId]),
      call(input.wallet, ACCOUNT_ABI, "getKeys"),
      call(input.wallet, ACCOUNT_ABI, "canExecute", [localKeyHash, input.manifest.collector.address, selector]),
      call(input.wallet, ACCOUNT_ABI, "spendInfos", [localKeyHash]),
    ]);
    const receiptBlockRow = row(blockRaw, "session action receipt block");
    if (quantity(receiptBlockRow["number"], "session action block number") !== receiptBlock ||
        hash(receiptBlockRow["hash"], "session action looked-up block hash") !== receiptHash) {
      throw new Error("Billing session receipt block identity drifted.");
    }
    const keyStoreValid = decodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", data: validRaw });
    const [, keyHashes] = decodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "getKeys", data: keysRaw });
    const canPayCollector = decodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "canExecute", data: canExecuteRaw });
    const spend = decodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "spendInfos", data: spendRaw });
    const positive = spend.filter((meter) => meter.limit > 0n);
    const day = positive.length === 1 && positive[0]!.token.toLowerCase() === zeroAddress && positive[0]!.period === 2
      ? positive[0] : undefined;
    return {
      chainId: 56,
      receiptStatus: quantity(receipt["status"], "session action receipt status") === 1n ? "success" : "failed",
      action: input.action.kind,
      wallet: input.wallet.toLowerCase() as Address,
      keyStore: ALTANA_KEYSTORE.toLowerCase() as Address,
      keyId: input.action.targetKeyId,
      callsId,
      transactionHash: input.transactionHash,
      blockNumber: receiptBlock,
      blockHash: receiptHash,
      latestBlockNumber: latest,
      stateBlockNumber: receiptBlock,
      keyStoreValid,
      accountKeyAbsent: !(keyHashes as readonly Hex[]).includes(localKeyHash),
      ...(input.action.kind === "grant" ? {
        canPayCollector,
        dayLimitWei: day?.limit ?? 0n,
        currentSpentWei: day?.currentSpent ?? 0n,
      } : {}),
    };
  };
  const [first, second] = await Promise.all([observe(0, latestA), observe(1, latestB)]);
  if (first === null || second === null) return null;
  return [first, second];
}

async function oracle(
  client: ReadOnlyRpcClient,
  origin: string,
  chainId: 56 | 42161,
  feed: FeedV1,
  selectedBlock: string,
): Promise<OracleObservation> {
  const tag = blockTag(BigInt(selectedBlock));
  const call = async (functionName: "description" | "decimals" | "latestRoundData"): Promise<Hex> => bytes(await client.rpc(origin, "eth_call", [{ to: feed.proxy, data: encodeFunctionData({ abi: CHAINLINK_ABI, functionName }) }, tag]), `oracle ${functionName}`);
  const [descriptionRaw, decimalsRaw, roundRaw] = await Promise.all([call("description"), call("decimals"), call("latestRoundData")]);
  const description = decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "description", data: descriptionRaw });
  const decimals = decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "decimals", data: decimalsRaw });
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "latestRoundData", data: roundRaw });
  return { chainId: BigInt(chainId), proxy: feed.proxy, description, decimals, roundId, answer,
    startedAt: safeSecond(startedAt, "oracle startedAt"), updatedAt: safeSecond(updatedAt, "oracle updatedAt"), answeredInRound };
}

async function collectorIdentity(
  client: ReadOnlyRpcClient,
  origin: string,
  manifest: BillingProductionManifestV2,
  selectedBlock: string,
): Promise<Readonly<{ runtimeCodehash: Hex; treasury: Address }>> {
  const tag = blockTag(BigInt(selectedBlock));
  const [runtime, treasuryRaw] = await Promise.all([
    client.rpc(origin, "eth_getCode", [manifest.collector.address, tag]),
    client.rpc(origin, "eth_call", [{ to: manifest.collector.address, data: encodeFunctionData({ abi: TREASURY_ABI, functionName: "treasury" }) }, tag]),
  ]);
  const runtimeBytes = bytes(runtime, "collector runtime");
  if (runtimeBytes === "0x") throw new Error("Collector runtime is empty.");
  const treasury = decodeFunctionResult({ abi: TREASURY_ABI, functionName: "treasury", data: bytes(treasuryRaw, "collector treasury") }).toLowerCase() as Address;
  return { runtimeCodehash: runtimeCodehash(runtimeBytes), treasury };
}

export async function acquireBaseBalancePair(input: Readonly<{
  client: ReadOnlyRpcClient;
  manifest: BillingProductionManifestV2;
  capability: readonly [RpcFinalizedObservationV1, RpcFinalizedObservationV1];
}>): Promise<readonly [BaseBalanceObservationV1, BaseBalanceObservationV1]> {
  const selected = input.capability[0].selectedBlockNumber;
  const tag = blockTag(BigInt(selected));
  const observe = async (index: 0 | 1): Promise<BaseBalanceObservationV1> => {
    const origin = input.manifest.networks.base.origins[index];
    const [nativeRaw, usdcRaw] = await Promise.all([
      input.client.rpc(origin, "eth_getBalance", [input.manifest.providers.x402Authorizer, tag]),
      input.client.rpc(origin, "eth_call", [{ to: input.manifest.networks.baseUsdc.address, data: encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [input.manifest.providers.x402Authorizer] }) }, tag]),
    ]);
    const usdc = decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", data: bytes(usdcRaw, "USDC balanceOf") });
    return { origin, chainId: 8453, latestBlockNumber: input.capability[index].latestBlockNumber,
      selectedBlockNumber: selected, blockHash: input.capability[index].selectedBlockHash,
      blockTimestamp: input.capability[index].selectedBlockTimestamp, authorizer: input.manifest.providers.x402Authorizer,
      usdcAddress: input.manifest.networks.baseUsdc.address, nativeBalanceWei: quantity(nativeRaw, "Base native balance").toString(),
      usdcBalanceAtomic: usdc.toString() };
  };
  return Promise.all([observe(0), observe(1)]);
}

export async function acquireReadOnlyPreflight(input: Readonly<{
  client: ReadOnlyRpcClient;
  manifest: BillingProductionManifestV2;
  now: number;
  liveUsdcExposureAtomic: string;
  manifestSha256: string;
  bundleSha256: string;
}>): Promise<ReadOnlyPreflightEvidenceV1> {
  const { manifest, client } = input;
  const [bsc, base, arbitrum] = await Promise.all([
    acquireRpcCapabilityPair(client, manifest.networks.bsc.origins, 56, 15),
    acquireRpcCapabilityPair(client, manifest.networks.base.origins, 8453, 20),
    acquireRpcCapabilityPair(client, manifest.networks.arbitrum.origins, 42161, 20),
  ]);
  validateRpcCapabilityEvidence({ manifest, now: input.now, bsc, base, arbitrum });
  const [bnbA, bnbB, ogA, ogB, sequencerA, sequencerB, collectorA, collectorB, balances] = await Promise.all([
    oracle(client, manifest.networks.bsc.origins[0], 56, manifest.oracles.bnbUsd, bsc[0].selectedBlockNumber),
    oracle(client, manifest.networks.bsc.origins[1], 56, manifest.oracles.bnbUsd, bsc[0].selectedBlockNumber),
    oracle(client, manifest.networks.arbitrum.origins[0], 42161, manifest.oracles.ogUsd, arbitrum[0].selectedBlockNumber),
    oracle(client, manifest.networks.arbitrum.origins[1], 42161, manifest.oracles.ogUsd, arbitrum[0].selectedBlockNumber),
    oracle(client, manifest.networks.arbitrum.origins[0], 42161, manifest.oracles.arbitrumSequencer, arbitrum[0].selectedBlockNumber),
    oracle(client, manifest.networks.arbitrum.origins[1], 42161, manifest.oracles.arbitrumSequencer, arbitrum[0].selectedBlockNumber),
    collectorIdentity(client, manifest.networks.bsc.origins[0], manifest, bsc[0].selectedBlockNumber),
    collectorIdentity(client, manifest.networks.bsc.origins[1], manifest, bsc[0].selectedBlockNumber),
    acquireBaseBalancePair({ client, manifest, capability: base }),
  ]);
  validateProductionOracleEvidence({ manifest, now: input.now,
    bnbUsd: [{ origin: manifest.networks.bsc.origins[0], observation: bnbA }, { origin: manifest.networks.bsc.origins[1], observation: bnbB }],
    ogUsd: [{ origin: manifest.networks.arbitrum.origins[0], observation: ogA }, { origin: manifest.networks.arbitrum.origins[1], observation: ogB }],
    arbitrumSequencer: [{ origin: manifest.networks.arbitrum.origins[0], observation: sequencerA }, { origin: manifest.networks.arbitrum.origins[1], observation: sequencerB }],
  });
  if (collectorA.runtimeCodehash !== collectorB.runtimeCodehash || collectorA.treasury !== collectorB.treasury ||
      collectorA.runtimeCodehash !== manifest.collector.runtimeCodehash || collectorA.treasury !== manifest.collector.treasury) {
    throw new Error("Collector identity evidence disagrees with the manifest.");
  }
  const balanceResult = validatePlatformBalanceEvidence({ manifest, now: input.now,
    liveUsdcExposureAtomic: input.liveUsdcExposureAtomic, observations: balances });
  return Object.freeze({ schema: "4lpha.billing-read-only-preflight.v1", observedAt: input.now,
    manifestSha256: input.manifestSha256, bundleSha256: input.bundleSha256,
    bscSelectedBlock: bsc[0].selectedBlockNumber, baseSelectedBlock: base[0].selectedBlockNumber,
    arbitrumSelectedBlock: arbitrum[0].selectedBlockNumber, collectorRuntimeCodehash: collectorA.runtimeCodehash,
    collectorTreasury: collectorA.treasury, baseNativeBalanceWei: balanceResult.nativeBalanceWei.toString(),
    baseUsdcBalanceAtomic: balanceResult.usdcBalanceAtomic.toString(), liveUsdcExposureAtomic: input.liveUsdcExposureAtomic,
    result: "pass" });
}

export async function acquirePostdeployPair(input: Readonly<{
  client: ReadOnlyRpcClient;
  manifest: BillingProductionManifestV2;
  expectedInitcodeHash: Hex;
  now: number;
}>): Promise<readonly [PostdeployRpcObservationV1, PostdeployRpcObservationV1]> {
  const capability = await acquireRpcCapabilityPair(input.client, input.manifest.networks.bsc.origins, 56, 15);
  if (capability[0].selectedBlockHash !== capability[1].selectedBlockHash ||
      capability[0].selectedBlockTimestamp !== capability[1].selectedBlockTimestamp ||
      capability[0].selectedBlockTimestamp > input.now + 5 || input.now - capability[0].selectedBlockTimestamp > 120) {
    throw new Error("Postdeploy finalized BSC observations disagree or are stale.");
  }
  const observe = async (index: 0 | 1): Promise<PostdeployRpcObservationV1> => {
    const origin = input.manifest.networks.bsc.origins[index];
    const [txRaw, receiptRaw] = await Promise.all([
      input.client.rpc(origin, "eth_getTransactionByHash", [input.manifest.collector.deploymentTxHash]),
      input.client.rpc(origin, "eth_getTransactionReceipt", [input.manifest.collector.deploymentTxHash]),
    ]);
    const tx = row(txRaw, "deployment transaction");
    const receipt = row(receiptRaw, "deployment receipt");
    const receiptBlock = quantity(receipt["blockNumber"], "deployment receipt block");
    const tag = blockTag(receiptBlock);
    const [receiptBlockRaw, runtimeRaw, treasuryRaw] = await Promise.all([
      input.client.rpc(origin, "eth_getBlockByNumber", [tag, false]),
      input.client.rpc(origin, "eth_getCode", [input.manifest.collector.address, tag]),
      input.client.rpc(origin, "eth_call", [{ to: input.manifest.collector.address, data: encodeFunctionData({ abi: TREASURY_ABI, functionName: "treasury" }) }, tag]),
    ]);
    const receiptBlockRow = row(receiptBlockRaw, "deployment receipt block");
    const transactionInput = bytes(tx["input"], "deployment initcode");
    const status = quantity(receipt["status"], "deployment receipt status");
    const receiptBlockHash = hash(receipt["blockHash"], "deployment receipt block hash");
    if (status !== 1n || tx["to"] !== null || quantity(receiptBlockRow["number"], "looked-up receipt block number") !== receiptBlock ||
        hash(receiptBlockRow["hash"], "looked-up receipt block hash") !== receiptBlockHash) {
      throw new Error("Deployment transaction or its receipt block identity is invalid.");
    }
    return { origin, chainId: 56, finalizedBlockNumber: capability[index].selectedBlockNumber,
      transactionHash: hash(tx["hash"], "deployment transaction hash"), transactionFrom: address(tx["from"], "deployment sender"),
      transactionNonce: quantity(tx["nonce"], "deployment nonce").toString(), transactionTo: null,
      initcodeHash: keccak256(transactionInput), receiptStatus: 1,
      receiptContractAddress: address(receipt["contractAddress"], "deployment contract address"),
      receiptBlockNumber: receiptBlock.toString(), receiptBlockHash,
      receiptBlockTimestamp: safeSecond(quantity(receiptBlockRow["timestamp"], "deployment receipt timestamp"), "deployment receipt timestamp"),
      runtimeCodehash: runtimeCodehash(bytes(runtimeRaw, "deployed runtime")),
      treasury: decodeFunctionResult({ abi: TREASURY_ABI, functionName: "treasury", data: bytes(treasuryRaw, "collector treasury") }).toLowerCase() as Address };
  };
  const observations = await Promise.all([observe(0), observe(1)]);
  validatePostdeployEvidence({ manifest: input.manifest, expectedInitcodeHash: input.expectedInitcodeHash, observations });
  return observations;
}

function responseHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) output[name] = typeof value === "string" ? value : value.join(", ");
  return output;
}

export async function createPinnedReadOnlyRpcClient(
  origins: readonly string[],
  lookupAll: LookupAll = dnsLookup as LookupAll,
): Promise<ReadOnlyRpcClient> {
  const pins = await resolveBillingOriginPins(origins, lookupAll);
  const byOrigin = new Map(pins.map((pin) => [pin.origin as string, pin]));
  const assertPin = async (pin: BillingDestinationPin): Promise<void> => {
    const [current] = await resolveBillingOriginPins([pin.origin], lookupAll);
    if (current === undefined || JSON.stringify(current.answerSet) !== JSON.stringify(pin.answerSet)) throw new Error("Billing origin DNS drifted after pinning.");
  };
  return {
    async rpc(origin, method, params) {
      if (!ALLOWED_RPC_METHODS.has(method)) throw new Error("Read-only acquisition refused an unreviewed RPC method.");
      const pin = byOrigin.get(origin);
      if (pin === undefined) throw new Error("Read-only acquisition refused an unpinned origin.");
      await assertPin(pin);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const request = httpsRequest({ protocol: "https:", hostname: pin.hostname, port: 443, path: "/", method: "POST",
          servername: pin.hostname, headers: { host: pin.hostname, accept: "application/json", "content-type": "application/json",
            "accept-encoding": "identity", "content-length": String(Buffer.byteLength(body)) },
          lookup: (_hostname, _options, callback) => callback(null, pin.address, pin.family) }, (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => { total += chunk.byteLength; if (total > MAX_RPC_BYTES) response.destroy(new Error("RPC response exceeded its byte bound.")); else chunks.push(chunk); });
          response.on("error", reject);
          response.on("end", () => {
            const headers = responseHeaders(response.headers);
            if (response.statusCode !== 200 || headers["content-encoding"] !== undefined) reject(new Error("RPC endpoint refused the closed request."));
            else resolve(Buffer.concat(chunks));
          });
        });
        request.setTimeout(15_000, () => request.destroy(new Error("RPC request timed out.")));
        request.on("error", reject);
        request.end(body);
      });
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown; }
      catch { throw new Error("RPC returned malformed JSON."); }
      const result = row(parsed, "RPC response");
      if (result["jsonrpc"] !== "2.0" || result["id"] !== 1 || result["error"] !== undefined || !("result" in result)) {
        throw new Error("RPC response identity is invalid.");
      }
      return result["result"];
    },
    async close() { /* Each request owns its socket. */ },
  };
}
