import { keccak256, type Address, type Hex } from "viem";
import { validateOraclePair, type OracleObservation } from "./oracles.js";
import { BASE_USDC, type BillingProductionManifestV2 } from "./productionManifest.js";

const HEX32 = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

const RPC_KEYS = ["origin", "chainId", "latestBlockNumber", "selectedBlockNumber", "selectedBlockHash", "selectedBlockTimestamp"] as const;
const POSTDEPLOY_KEYS = [
  "origin", "chainId", "finalizedBlockNumber", "transactionHash", "transactionFrom", "transactionNonce", "transactionTo",
  "initcodeHash", "receiptStatus", "receiptContractAddress", "receiptBlockNumber", "receiptBlockHash",
  "receiptBlockTimestamp", "runtimeCodehash", "treasury",
] as const;
const BALANCE_KEYS = [
  "origin", "chainId", "latestBlockNumber", "selectedBlockNumber", "blockHash", "blockTimestamp", "authorizer",
  "usdcAddress", "nativeBalanceWei", "usdcBalanceAtomic",
] as const;
const ORACLE_EVIDENCE_KEYS = ["origin", "observation"] as const;
const ORACLE_OBSERVATION_KEYS = [
  "chainId", "proxy", "description", "decimals", "roundId", "answer", "startedAt", "updatedAt", "answeredInRound",
] as const;

export type RpcFinalizedObservationV1 = Readonly<{
  origin: string;
  chainId: 56 | 8453 | 42161;
  latestBlockNumber: string;
  selectedBlockNumber: string;
  selectedBlockHash: Hex;
  selectedBlockTimestamp: number;
}>;

export type PostdeployRpcObservationV1 = Readonly<{
  origin: string;
  chainId: 56;
  finalizedBlockNumber: string;
  transactionHash: Hex;
  transactionFrom: Address;
  transactionNonce: string;
  transactionTo: null;
  initcodeHash: Hex;
  receiptStatus: 1;
  receiptContractAddress: Address;
  receiptBlockNumber: string;
  receiptBlockHash: Hex;
  receiptBlockTimestamp: number;
  runtimeCodehash: Hex;
  treasury: Address;
}>;

export type BaseBalanceObservationV1 = Readonly<{
  origin: string;
  chainId: 8453;
  latestBlockNumber: string;
  selectedBlockNumber: string;
  blockHash: Hex;
  blockTimestamp: number;
  authorizer: Address;
  usdcAddress: Address;
  nativeBalanceWei: string;
  usdcBalanceAtomic: string;
}>;

export type OracleEvidenceObservationV1 = Readonly<{
  origin: string;
  observation: OracleObservation;
}>;

function decimal(value: string, field: string): bigint {
  if (!DECIMAL.test(value)) throw new Error(`${field} must be a canonical unsigned decimal.`);
  return BigInt(value);
}

function hex32(value: string, field: string): string {
  if (!HEX32.test(value)) throw new Error(`${field} must be lowercase bytes32.`);
  return value;
}

function address(value: string, field: string): string {
  if (!ADDRESS.test(value)) throw new Error(`${field} must be a lowercase EVM address.`);
  return value;
}

function exactObject(value: unknown, keys: readonly string[], field: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${field} members drifted.`);
  }
}

function exactPair(value: readonly unknown[], field: string): void {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${field} must contain exactly two observations.`);
}

function sameExceptOrigin(a: unknown, b: unknown): boolean {
  const withoutOrigin = (value: unknown): string => JSON.stringify(value, (key, nested) => key === "origin" ? undefined : nested);
  return withoutOrigin(a) === withoutOrigin(b);
}

function sameSelectedBlock(a: RpcFinalizedObservationV1, b: RpcFinalizedObservationV1): boolean {
  return a.selectedBlockNumber === b.selectedBlockNumber && a.selectedBlockHash === b.selectedBlockHash &&
    a.selectedBlockTimestamp === b.selectedBlockTimestamp;
}

function safeTime(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe Unix second.`);
  return value;
}

export function validateRpcCapabilityEvidence(input: Readonly<{
  manifest: BillingProductionManifestV2;
  now: number;
  bsc: readonly [RpcFinalizedObservationV1, RpcFinalizedObservationV1];
  base: readonly [RpcFinalizedObservationV1, RpcFinalizedObservationV1];
  arbitrum: readonly [RpcFinalizedObservationV1, RpcFinalizedObservationV1];
}>): void {
  safeTime(input.now, "now");
  const checks = [
    [input.bsc, 56, input.manifest.networks.bsc.finalityDepth, input.manifest.networks.bsc.origins],
    [input.base, 8453, input.manifest.networks.base.finalityDepth, input.manifest.networks.base.origins],
    [input.arbitrum, 42161, input.manifest.networks.arbitrum.finalityDepth, input.manifest.networks.arbitrum.origins],
  ] as const;
  for (const [pair, chainId, depth, origins] of checks) {
    exactPair(pair, "RPC capability pair");
    const [a, b] = pair;
    exactObject(a, RPC_KEYS, "RPC capability observation");
    exactObject(b, RPC_KEYS, "RPC capability observation");
    if (a.origin !== origins[0] || b.origin !== origins[1] || a.chainId !== chainId || b.chainId !== chainId || !sameSelectedBlock(a, b)) {
      throw new Error("RPC capability pair disagrees.");
    }
    const latestA = decimal(a.latestBlockNumber, "latestBlockNumber");
    const latestB = decimal(b.latestBlockNumber, "latestBlockNumber");
    const selected = decimal(a.selectedBlockNumber, "selectedBlockNumber");
    const minimumHead = latestA < latestB ? latestA : latestB;
    if (minimumHead < BigInt(depth) || selected !== minimumHead - BigInt(depth)) throw new Error("RPC finalized-depth selection is invalid.");
    hex32(a.selectedBlockHash, "selectedBlockHash");
    safeTime(a.selectedBlockTimestamp, "selectedBlockTimestamp");
    if (a.selectedBlockTimestamp > input.now + 5 || input.now - a.selectedBlockTimestamp > 120) {
      throw new Error("RPC selected block is stale or from the future.");
    }
  }
}

export function validateProductionOracleEvidence(input: Readonly<{
  manifest: BillingProductionManifestV2;
  now: number;
  bnbUsd: readonly [OracleEvidenceObservationV1, OracleEvidenceObservationV1];
  ogUsd: readonly [OracleEvidenceObservationV1, OracleEvidenceObservationV1];
  arbitrumSequencer: readonly [OracleEvidenceObservationV1, OracleEvidenceObservationV1];
}>): void {
  if (
    input.manifest.oracles.bnbUsd.description !== "BNB / USD" ||
    input.manifest.oracles.ogUsd.description !== "0G / USD" ||
    input.manifest.oracles.arbitrumSequencer.description !== "L2 Sequencer Uptime Status Feed"
  ) throw new Error("Oracle manifest identity drifted.");
  const checks = [
    [input.bnbUsd, input.manifest.networks.bsc.origins, "BNB_USD"],
    [input.ogUsd, input.manifest.networks.arbitrum.origins, "0G_USD"],
    [input.arbitrumSequencer, input.manifest.networks.arbitrum.origins, "ARBITRUM_SEQUENCER"],
  ] as const;
  for (const [pair, origins, feed] of checks) {
    exactPair(pair, `${feed} oracle pair`);
    exactObject(pair[0], ORACLE_EVIDENCE_KEYS, `${feed} oracle evidence`);
    exactObject(pair[1], ORACLE_EVIDENCE_KEYS, `${feed} oracle evidence`);
    exactObject(pair[0].observation, ORACLE_OBSERVATION_KEYS, `${feed} oracle observation`);
    exactObject(pair[1].observation, ORACLE_OBSERVATION_KEYS, `${feed} oracle observation`);
    if (pair[0].origin !== origins[0] || pair[1].origin !== origins[1]) throw new Error("Oracle evidence origin pair drifted.");
    validateOraclePair(feed, pair[0].observation, pair[1].observation, input.now);
  }
}

export function validatePostdeployEvidence(input: Readonly<{
  manifest: BillingProductionManifestV2;
  expectedInitcodeHash: Hex;
  observations: readonly [PostdeployRpcObservationV1, PostdeployRpcObservationV1];
}>): Readonly<{ transactionHash: Hex; runtimeCodehash: Hex }> {
  hex32(input.expectedInitcodeHash, "expectedInitcodeHash");
  exactPair(input.observations, "Postdeploy RPC pair");
  const [a, b] = input.observations;
  exactObject(a, POSTDEPLOY_KEYS, "Postdeploy RPC observation");
  exactObject(b, POSTDEPLOY_KEYS, "Postdeploy RPC observation");
  if (
    a.origin !== input.manifest.networks.bsc.origins[0] || b.origin !== input.manifest.networks.bsc.origins[1] ||
    !sameExceptOrigin(a, b)
  ) throw new Error("Postdeploy RPC observations disagree.");
  const collector = input.manifest.collector;
  const finalized = decimal(a.finalizedBlockNumber, "finalizedBlockNumber");
  const receiptBlock = decimal(a.receiptBlockNumber, "receiptBlockNumber");
  if (
    a.chainId !== 56 || a.receiptStatus !== 1 || a.transactionTo !== null ||
    a.transactionHash !== collector.deploymentTxHash || a.transactionFrom !== collector.deployer ||
    a.transactionNonce !== collector.nonce || a.initcodeHash !== input.expectedInitcodeHash ||
    a.receiptContractAddress !== collector.address || a.receiptBlockNumber !== collector.deploymentBlock ||
    a.receiptBlockHash !== collector.deploymentBlockHash || a.runtimeCodehash !== collector.runtimeCodehash ||
    a.treasury !== collector.treasury || finalized < receiptBlock + BigInt(input.manifest.networks.bsc.finalityDepth)
  ) throw new Error("Postdeploy evidence does not match the production manifest.");
  safeTime(a.receiptBlockTimestamp, "receiptBlockTimestamp");
  hex32(a.transactionHash, "transactionHash");
  address(a.transactionFrom, "transactionFrom");
  hex32(a.initcodeHash, "initcodeHash");
  address(a.receiptContractAddress, "receiptContractAddress");
  hex32(a.receiptBlockHash, "receiptBlockHash");
  hex32(a.runtimeCodehash, "runtimeCodehash");
  address(a.treasury, "treasury");
  return Object.freeze({ transactionHash: a.transactionHash, runtimeCodehash: a.runtimeCodehash });
}

export function validatePlatformBalanceEvidence(input: Readonly<{
  manifest: BillingProductionManifestV2;
  now: number;
  liveUsdcExposureAtomic: string;
  observations: readonly [BaseBalanceObservationV1, BaseBalanceObservationV1];
}>): Readonly<{ nativeBalanceWei: bigint; usdcBalanceAtomic: bigint }> {
  if (!input.manifest.providers.x402Enabled) throw new Error("x402 is disabled in the production manifest.");
  safeTime(input.now, "now");
  exactPair(input.observations, "Base balance RPC pair");
  const [a, b] = input.observations;
  exactObject(a, BALANCE_KEYS, "Base balance observation");
  exactObject(b, BALANCE_KEYS, "Base balance observation");
  const latestA = decimal(a.latestBlockNumber, "latestBlockNumber");
  const latestB = decimal(b.latestBlockNumber, "latestBlockNumber");
  const selectedA = decimal(a.selectedBlockNumber, "selectedBlockNumber");
  const selectedB = decimal(b.selectedBlockNumber, "selectedBlockNumber");
  const minimumHead = latestA < latestB ? latestA : latestB;
  if (
    a.origin !== input.manifest.networks.base.origins[0] || b.origin !== input.manifest.networks.base.origins[1] ||
    selectedA !== selectedB || selectedA !== minimumHead - BigInt(input.manifest.networks.base.finalityDepth) ||
    a.blockHash !== b.blockHash || a.blockTimestamp !== b.blockTimestamp || a.chainId !== b.chainId ||
    a.authorizer !== b.authorizer || a.usdcAddress !== b.usdcAddress || a.nativeBalanceWei !== b.nativeBalanceWei ||
    a.usdcBalanceAtomic !== b.usdcBalanceAtomic
  ) throw new Error("Base balance RPC observations disagree or do not prove finalized selection.");
  if (
    a.chainId !== 8453 || a.authorizer !== input.manifest.providers.x402Authorizer ||
    a.usdcAddress !== BASE_USDC
  ) throw new Error("Base balance identity drifted.");
  hex32(a.blockHash, "blockHash");
  address(a.authorizer, "authorizer");
  address(a.usdcAddress, "usdcAddress");
  safeTime(a.blockTimestamp, "blockTimestamp");
  if (a.blockTimestamp > input.now + 5 || input.now - a.blockTimestamp > 120) throw new Error("Base balance observation is stale.");
  const nativeBalanceWei = decimal(a.nativeBalanceWei, "nativeBalanceWei");
  const usdcBalanceAtomic = decimal(a.usdcBalanceAtomic, "usdcBalanceAtomic");
  const exposure = decimal(input.liveUsdcExposureAtomic, "liveUsdcExposureAtomic");
  const requiredUsdc = exposure > BigInt(input.manifest.providers.minUsdcAtomic)
    ? exposure
    : BigInt(input.manifest.providers.minUsdcAtomic);
  if (nativeBalanceWei < BigInt(input.manifest.caps.minBaseGasReserveWei) || usdcBalanceAtomic < requiredUsdc) {
    throw new Error("Platform payer balance is insufficient.");
  }
  return Object.freeze({ nativeBalanceWei, usdcBalanceAtomic });
}

export function runtimeCodehash(runtimeBytes: Hex): Hex {
  return keccak256(runtimeBytes);
}
