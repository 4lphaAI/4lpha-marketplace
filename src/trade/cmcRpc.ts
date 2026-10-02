/** Concrete BSC readers used by the CMC owner and settlement seams. */
import { createPublicClient, decodeAbiParameters, decodeFunctionData, getAddress, http, keccak256, parseAbi, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import {
  CMC_APPROVE_SIGNATURE, CMC_PERMIT2, CMC_REVIEWED_TOKEN_CLASSES, CmcProfileUnavailableError,
  grantShapeDigestV1, grantShapeDigestV2, type CmcCapabilityEvidence, type CmcCapabilityReader,
  type CmcGrantShapeSpec, type CmcReviewedTokenClass,
} from "./cmcCapability.js";
import { CMC_SPENDER } from "./cmc.js";
import { USDT_56 } from "./settlement.js";
import type { CmcOwnerStateReader } from "./cmcOwnerService.js";
import { CMC_SETTLE_SELECTOR, verifyCmcChargeProof, type CmcChargeProofResult, type CmcReceiptObservation, type CmcExpiryReader } from "./cmcProof.js";
import type { CmcOwnerExecutionProof, CmcOwnerOperationRecord, CmcStoredCall } from "../store/tradeCmc.js";
import { PORTO_V055_INTENT_PARAMETERS } from "../lp/intentDecoder.js";
import { PORTO_V055_ORCHESTRATOR } from "../lp/preparedIntent.js";
import { passkeyOwnerAddress } from "../auth/webauthnEnvelope.js";

const ERC20_ABI = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const ACCOUNT_ABI = [
  { type: "function", name: "approvedSignatureCheckers", stateMutability: "view", inputs: [{ name: "keyHash", type: "bytes32" }], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getKeys", stateMutability: "view", inputs: [], outputs: [{ name: "keys", type: "tuple[]", components: [{ name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" }, { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" }] }, { name: "keyHashes", type: "bytes32[]" }] },
] as const;
const PERMIT2_ABI = [{ type: "function", name: "nonceBitmap", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "word", type: "uint256" }], outputs: [{ type: "uint256" }] }] as const;
const EXECUTE_ABI = parseAbi(["function execute(bytes encodedIntent) payable returns(bytes4)", "function execute(bytes[] encodedIntents) payable returns(bytes4[])"]);
const INTENT_EXECUTED_TOPIC = "0x23a3c1343409f01965611c9c4c8b99e36d7b09ca22516507d5486ce0584379b8" as Hex;

type RpcClient = {
  getCode(input: { readonly address: Address; readonly blockNumber?: bigint }): Promise<Hex | undefined>;
  getStorageAt(input: { readonly address: Address; readonly slot: Hex; readonly blockNumber?: bigint }): Promise<Hex | undefined>;
  readContract(input: { readonly address: Address; readonly abi: readonly unknown[]; readonly functionName: string; readonly args: readonly unknown[]; readonly blockNumber?: bigint }): Promise<unknown>;
  getBlock(input: { readonly blockTag: "finalized" | "latest" } | { readonly blockHash: Hex } | { readonly blockNumber: bigint }): Promise<{ readonly number: bigint | null; readonly hash: Hex | null; readonly timestamp: bigint }>;
  getLogs(input: { readonly address: Address; readonly event: typeof TRANSFER_EVENT; readonly args: { readonly from: Address; readonly to: Address }; readonly fromBlock: bigint; readonly toBlock: bigint }): Promise<readonly { readonly transactionHash: Hex; readonly args: { readonly value?: bigint } }[]>;
  getChainId(): Promise<number>;
  getTransactionReceipt(input: { readonly hash: Hex }): Promise<{ readonly transactionHash: Hex; readonly blockHash: Hex; readonly blockNumber: bigint; readonly status: "success" | "reverted"; readonly logs: readonly { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex }[] }>;
  getTransaction(input: { readonly hash: Hex }): Promise<{ readonly from: Address; readonly to: Address | null; readonly input: Hex }>;
};

function rpc(url: string): RpcClient {
  return createPublicClient({ chain: bsc, transport: http(url, { timeout: 45_000 }) }) as unknown as RpcClient;
}
function keyHash(publicKey: Hex): Hex { return accountKeyHashForAddress(publicKeyToAddress(publicKey)); }
function hasChecker(value: unknown): boolean { return Array.isArray(value) && value.some((item) => typeof item === "string" && item.toLowerCase() === CMC_PERMIT2.toLowerCase()); }
async function resolvedCodeHash(client: RpcClient, address: Address, blockNumber?: bigint): Promise<Hex | null> {
  const code = await client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) });
  if (code === undefined || code === "0x") return null;
  if (code.toLowerCase().startsWith("0xef0100") && code.length >= 48) {
    const implementation = getAddress(`0x${code.slice(8, 48)}`);
    const implementationCode = await client.getCode({ address: implementation, ...(blockNumber === undefined ? {} : { blockNumber }) });
    return implementationCode === undefined || implementationCode === "0x" ? null : keccak256(implementationCode);
  }
  return keccak256(code);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keyExpiry(value: unknown): bigint | null {
  if (!record(value)) return null;
  const expiry = value["expiry"];
  if (typeof expiry === "bigint" && expiry >= 0n) return expiry;
  if (typeof expiry === "number" && Number.isSafeInteger(expiry) && expiry >= 0) return BigInt(expiry);
  return null;
}

// EIP-1967 beacon slot; CMC-TOKEN-CLASS-SPEC §2 F2: both reviewed classes
// return their beacon from this same slot.
const BEACON_PROXY_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const BEACON_ABI = [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** CMC-TOKEN-CLASS-SPEC R2.2: the lowercase `to` of every `approve` rule plus every cap token, minus USDT and native. */
export function cmcTokenClassCandidates(spec: CmcGrantShapeSpec): readonly Address[] {
  const candidates = new Map<string, Address>();
  for (const rule of spec.allowedCalls) {
    if (rule.to !== undefined && rule.selector === CMC_APPROVE_SIGNATURE) {
      const address = getAddress(rule.to);
      candidates.set(address.toLowerCase(), address);
    }
  }
  for (const cap of spec.spendCaps) {
    if (cap.token !== undefined) {
      const address = getAddress(cap.token);
      candidates.set(address.toLowerCase(), address);
    }
  }
  candidates.delete(USDT_56.toLowerCase());
  return [...candidates.values()];
}

/**
 * Matches candidate tokens against the reviewed proxy/beacon/implementation
 * classes (CMC-TOKEN-CLASS-SPEC R2.1). `client` is typed structurally so both
 * the reader's internal client and the probe's own viem `PublicClient` satisfy
 * it (Revision 2 M1). Any RPC error throws; a token matching no class is
 * simply absent from the returned map.
 */
export async function readCmcTokenClassMembers(
  client: Pick<RpcClient, "getCode" | "getStorageAt" | "readContract">,
  candidates: readonly Address[],
  blockNumber: bigint,
  classes: readonly CmcReviewedTokenClass[] = CMC_REVIEWED_TOKEN_CLASSES,
): Promise<ReadonlyMap<string, string>> {
  const members = new Map<string, string>();
  const beaconOkByClass = new Map<string, boolean>();
  for (const token of candidates) {
    const [code, beaconSlotValue] = await Promise.all([
      client.getCode({ address: token, blockNumber }),
      client.getStorageAt({ address: token, slot: BEACON_PROXY_SLOT, blockNumber }),
    ]);
    if (code === undefined || code === "0x" || beaconSlotValue === undefined) continue;
    const proxyCodeHash = keccak256(code);
    const beaconAddress = getAddress(`0x${beaconSlotValue.slice(-40)}`);
    for (const klass of classes) {
      if (proxyCodeHash.toLowerCase() !== klass.proxyCodeHash.toLowerCase()) continue;
      if (beaconAddress.toLowerCase() !== klass.beacon.toLowerCase()) continue;
      let beaconOk = beaconOkByClass.get(klass.classId);
      if (beaconOk === undefined) {
        const [beaconCode, implementationResult] = await Promise.all([
          client.getCode({ address: klass.beacon, blockNumber }),
          client.readContract({ address: klass.beacon, abi: BEACON_ABI, functionName: "implementation", args: [], blockNumber }),
        ]);
        const beaconCodeHash = beaconCode === undefined || beaconCode === "0x" ? null : keccak256(beaconCode);
        const implementationAddress = typeof implementationResult === "string" ? getAddress(implementationResult) : null;
        const implementationCode = implementationAddress === null ? undefined : await client.getCode({ address: implementationAddress, blockNumber });
        const implementationCodeHash = implementationCode === undefined || implementationCode === "0x" ? null : keccak256(implementationCode);
        beaconOk = beaconCodeHash !== null && beaconCodeHash.toLowerCase() === klass.beaconCodeHash.toLowerCase()
          && implementationAddress !== null && implementationAddress.toLowerCase() === klass.implementation.toLowerCase()
          && implementationCodeHash !== null && implementationCodeHash.toLowerCase() === klass.implementationCodeHash.toLowerCase();
        beaconOkByClass.set(klass.classId, beaconOk);
      }
      if (beaconOk) { members.set(token.toLowerCase(), klass.classId); break; }
    }
  }
  return members;
}

/** Reads the live owner allowance and account checker mapping from BSC. */
export function createCmcRpcOwnerStateReader(input: {
  readonly rpcUrl: string;
  readonly resolveOwnerExecution: (input: {
    readonly callsId: Hex;
    readonly operation: CmcOwnerOperationRecord;
    readonly calls: readonly CmcStoredCall[];
  }) => Promise<{ readonly finalized: boolean; readonly callsDigest: Hex; readonly sessionKeyHash: Hex; readonly executionProof: CmcOwnerExecutionProof }>;
}): CmcOwnerStateReader {
  const client = rpc(input.rpcUrl);
  return {
    async readState(request) {
      const currentHash = keyHash(request.sessionPublicKey);
      const allowance = await client.readContract({ address: USDT_56, abi: ERC20_ABI, functionName: "allowance", args: [request.wallet, CMC_PERMIT2] });
      const currentCheckers = await client.readContract({ address: request.wallet, abi: ACCOUNT_ABI, functionName: "approvedSignatureCheckers", args: [currentHash] });
      let oldCheckerKeyHash: Hex | null = null;
      if (request.previousSessionPublicKey !== undefined) {
        const oldHash = keyHash(request.previousSessionPublicKey);
        const oldCheckers = await client.readContract({ address: request.wallet, abi: ACCOUNT_ABI, functionName: "approvedSignatureCheckers", args: [oldHash] });
        if (hasChecker(oldCheckers)) oldCheckerKeyHash = oldHash;
      }
      return { allowanceWei: typeof allowance === "bigint" ? allowance : BigInt(String(allowance)), checkerApproved: hasChecker(currentCheckers), oldCheckerKeyHash };
    },
    async verifyOwnerExecution(request) {
      const evidence = await input.resolveOwnerExecution({ callsId: request.callsId, operation: request.operation, calls: request.calls });
      const state = await this.readState({ agentId: request.operation.agentId, wallet: request.operation.wallet, sessionPublicKey: request.operation.sessionPublicKey, nowSec: Math.floor(Date.now() / 1_000) });
      return { ...evidence, allowanceWei: state.allowanceWei, checkerApproved: state.checkerApproved, sessionKeyHash: evidence.sessionKeyHash };
    },
  };
}

type RelayClient = { request(input: { readonly method: string; readonly params: readonly unknown[] }): Promise<unknown> };

/**
 * Resolve an owner setup callsId into canonical chain execution evidence. The
 * relay id is only a lookup hint: adoption requires the finalized transaction
 * receipt, the exact owner call batch and one matching Porto IntentExecuted.
 */
export function createCmcRelayOwnerExecutionResolver(input: {
  readonly relayUrl: string;
  readonly rpcUrls: readonly [string, string];
}): (request: { readonly callsId: Hex; readonly operation: CmcOwnerOperationRecord; readonly calls: readonly CmcStoredCall[] }) => Promise<{
  readonly finalized: boolean;
  readonly callsDigest: Hex;
  readonly sessionKeyHash: Hex;
  readonly executionProof: CmcOwnerExecutionProof;
}> {
  const relay = createPublicClient({ chain: bsc, transport: http(input.relayUrl, { timeout: 45_000 }) }) as unknown as RelayClient;
  const clients = [rpc(input.rpcUrls[0]), rpc(input.rpcUrls[1])] as const;
  return async (request) => {
    const status = await relay.request({ method: "wallet_getCallsStatus", params: [request.callsId] });
    const txHash = relayTransactionHash(status);
    if (txHash === null) throw new Error("CMC owner relay status has no transaction hash.");
    const observations = await Promise.all(clients.map(async (client) => {
      const [receipt, transaction, chainId] = await Promise.all([client.getTransactionReceipt({ hash: txHash }), client.getTransaction({ hash: txHash }), client.getChainId()]);
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      const finalized = await client.getBlock({ blockTag: "finalized" });
      if (chainId !== 56 || canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
        || finalized.number === null || finalized.number < receipt.blockNumber) throw new Error("CMC owner transaction is not finalized on canonical BSC.");
      const keys = await client.readContract({ address: request.operation.wallet, abi: ACCOUNT_ABI, functionName: "getKeys", args: [], blockNumber: receipt.blockNumber });
      const decoded = decodeOwnerIntent(transaction.input, request.operation.wallet, request.calls);
      if (!activeOwnerAdminKeyAtBlock(keys, request.operation.wallet, canonical.timestamp, decoded.keyHash, request.operation.ownerAddress)) throw new Error("CMC owner execution signer is not the declared owner admin.");
      const executed = findIntentExecuted(receipt.logs, request.operation.wallet, decoded.nonce);
      if (executed === null || executed.incremented !== true || executed.err !== "0x00000000") throw new Error("CMC owner execution lacks the exact successful IntentExecuted proof.");
      return { receipt, transaction, keys, decoded, executed, blockTimestamp: canonical.timestamp };
    }));
    const first = observations[0]!;
    const second = observations[1]!;
    if (first.receipt.blockHash.toLowerCase() !== second.receipt.blockHash.toLowerCase()
      || first.receipt.blockNumber !== second.receipt.blockNumber
      || first.receipt.transactionHash.toLowerCase() !== second.receipt.transactionHash.toLowerCase()
      || first.receipt.status !== second.receipt.status
      || first.transaction.input.toLowerCase() !== second.transaction.input.toLowerCase()) throw new Error("CMC owner transaction RPC evidence disagrees.");
    if (first.receipt.status !== "success" || first.transaction.to?.toLowerCase() !== PORTO_V055_ORCHESTRATOR.toLowerCase()) throw new Error("CMC owner transaction is not a successful Porto execution.");
    if (first.decoded.nonce !== second.decoded.nonce || first.decoded.keyHash.toLowerCase() !== second.decoded.keyHash.toLowerCase()
      || first.decoded.intentBytes.toLowerCase() !== second.decoded.intentBytes.toLowerCase()
      || first.executed.incremented !== second.executed.incremented || first.executed.err.toLowerCase() !== second.executed.err.toLowerCase()) throw new Error("CMC owner intent or event evidence disagrees between RPCs.");
    const decoded = first.decoded;
    const proof: CmcOwnerExecutionProof = { chainId: 56, wallet: request.operation.wallet, txHash: first.receipt.transactionHash,
      blockHash: first.receipt.blockHash, blockNumber: first.receipt.blockNumber, blockTimestamp: first.blockTimestamp,
      intentId: keccak256(decoded.intentBytes), executionNonce: decoded.nonce };
    return { finalized: true, callsDigest: request.operation.callsDigest, sessionKeyHash: request.operation.keyHash, executionProof: proof };
  };
}

function relayTransactionHash(value: unknown): Hex | null {
  if (!record(value)) return null;
  const receipts = value["receipts"];
  if (!Array.isArray(receipts) || receipts.length !== 1 || !record(receipts[0])) return null;
  const direct = receipts[0]["transactionHash"];
  const nested = receipts[0]["transactionReceipt"];
  const hash = typeof direct === "string" ? direct : record(nested) ? nested["transactionHash"] : undefined;
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/u.test(hash) ? hash as Hex : null;
}

function decodeOwnerIntent(input: Hex, wallet: Address, expectedCalls: readonly CmcStoredCall[]): { readonly nonce: bigint; readonly intentBytes: Hex; readonly keyHash: Hex } {
  let decoded: ReturnType<typeof decodeFunctionData<typeof EXECUTE_ABI>>;
  try { decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: input }); } catch { throw new Error("CMC owner transaction calldata is not Porto execute."); }
  const argument = decoded.args[0];
  const members = Array.isArray(argument) ? argument : [argument];
  const matches: { nonce: bigint; intentBytes: Hex; keyHash: Hex }[] = [];
  for (const member of members) {
    let intent: ReturnType<typeof decodeAbiParameters<typeof PORTO_V055_INTENT_PARAMETERS>>[0];
    try { [intent] = decodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, member as Hex); } catch { continue; }
    if (getAddress(intent.eoa) !== getAddress(wallet)) continue;
    const signature = intent.signature;
    const keyHash = `0x${signature.slice(-66, -2)}`.toLowerCase();
    if (intent.encodedPreCalls.length !== 0 || intent.encodedFundTransfers.length !== 0
      || intent.funder !== "0x0000000000000000000000000000000000000000" || intent.funderSignature !== "0x") continue;
    const calls = decodeOwnerCalls(intent.executionData);
    if (calls === null || calls.length !== expectedCalls.length || calls.some((call, index) => call.to.toLowerCase() !== expectedCalls[index]!.to.toLowerCase() || call.value !== expectedCalls[index]!.value || call.data.toLowerCase() !== expectedCalls[index]!.data.toLowerCase())) continue;
    matches.push({ nonce: intent.nonce, intentBytes: member as Hex, keyHash: keyHash as Hex });
  }
  if (matches.length !== 1) throw new Error("CMC owner transaction does not contain one exact owner intent.");
  return matches[0]!;
}

function decodeOwnerCalls(executionData: Hex): readonly CmcStoredCall[] | null {
  try {
    const [calls] = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }] as const, executionData);
    return calls.map((call) => ({ to: getAddress(call.target), value: call.value, data: call.data }));
  } catch { return null; }
}

function activeOwnerAdminKeyAtBlock(value: unknown, wallet: Address, timestamp: bigint, expectedKeyHash?: Hex, ownerAddress: Address = wallet): boolean {
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[0]) || !Array.isArray(value[1]) || value[0].length !== value[1].length) return false;
  const hashes = value[1];
  const matches = hashes.map((hash, index) => ({ hash, key: value[0][index] })).filter((entry) => typeof entry.hash === "string" && (expectedKeyHash === undefined || entry.hash.toLowerCase() === expectedKeyHash.toLowerCase()));
  if (matches.length !== 1) return false;
  const key = matches[0]!.key;
  if (!record(key) || key["isSuperAdmin"] !== true) return false;
  const expiry = keyExpiry(key);
  if (expiry === null || (expiry !== 0n && expiry <= timestamp)) return false;
  const keyType = key["keyType"];
  const publicKey = key["publicKey"];
  if (typeof publicKey !== "string") return false;
  try {
    if (keyType === 2 && publicKey.length >= 42) return getAddress(`0x${publicKey.slice(-40)}`) === getAddress(ownerAddress);
    if ((keyType === 0 || keyType === 1) && publicKey.length === 130) return passkeyOwnerAddress(`0x${publicKey.slice(2, 66)}` as Hex, `0x${publicKey.slice(66)}` as Hex).toLowerCase() === ownerAddress.toLowerCase();
  } catch { return false; }
  return false;
}

export function verifyCmcOwnerAdminKeyAtBlock(input: { readonly getKeysResult: unknown; readonly wallet: Address; readonly ownerAddress: Address; readonly signerKeyHash: Hex; readonly blockTimestamp: bigint }): boolean {
  return activeOwnerAdminKeyAtBlock(input.getKeysResult, input.wallet, input.blockTimestamp, input.signerKeyHash, input.ownerAddress);
}

function findIntentExecuted(logs: readonly { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex }[], wallet: Address, nonce: bigint): { readonly incremented: boolean; readonly err: Hex } | null {
  const matches = logs.filter((log) => log.address.toLowerCase() === PORTO_V055_ORCHESTRATOR.toLowerCase() && log.topics[0]?.toLowerCase() === INTENT_EXECUTED_TOPIC.toLowerCase() && log.topics.length === 3)
    .map((log) => { try { const [incremented, err] = decodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], log.data); return { wallet: getAddress(`0x${log.topics[1]!.slice(-40)}`), nonce: BigInt(log.topics[2]!), incremented, err: err.toLowerCase() as Hex }; } catch { return null; } })
    .filter((event): event is { wallet: Address; nonce: bigint; incremented: boolean; err: Hex } => event !== null && event.wallet.toLowerCase() === wallet.toLowerCase() && event.nonce === nonce);
  return matches.length === 1 ? matches[0]! : null;
}

/** The observed implementation identity a reviewed matrix is looked up by. */
export type CmcMatrixTraceRequest = {
  readonly accountCodeHash: Hex;
  readonly tokenCodeHash: Hex;
  readonly permit2CodeHash: Hex;
  readonly settlerCodeHash: Hex;
  readonly grantShapeDigest: Hex;
  readonly grantShapeVersion: 1 | 2;
};

export type CmcMatrixTrace = {
  readonly ownerApprovalPersists: true;
  readonly unrelatedTradingPreservesAllowance: true;
  readonly sessionApproveCannotIncreaseAllowance: true;
  readonly noTemporaryApproveConsumePath: true;
  readonly temporaryApproveCallbackReentryExcluded: true;
  readonly revokeExpiryRejectsPayment: true;
  readonly walletKeyExclusive: true;
  readonly additiveIncreaseAllowance: true;
  readonly proofDigests: readonly Hex[];
  readonly grantShapeDigest: Hex;
  readonly profileId: string;
};

/**
 * A live capability reader: code identities, the grant shape and the
 * allowance/checker facts come from this process's own reads, and only then is
 * a reviewed matrix profile looked up by that observed implementation
 * identity. The grant shape is computed from the agent's LIVE session spec,
 * never copied out of the profile — otherwise the profile/evidence comparison
 * would be a tautology. Without a spec or a trace this reader refuses.
 */
export function createCmcRpcCapabilityReader(input: {
  readonly rpcUrl: string;
  readonly sessionSpec: (request: { readonly agentId: string; readonly wallet: Address; readonly sessionPublicKey: Hex; readonly generation: number }) => Promise<CmcGrantShapeSpec | null>;
  readonly matrixTrace: (request: CmcMatrixTraceRequest) => Promise<CmcMatrixTrace | null>;
}): CmcCapabilityReader {
  const client = rpc(input.rpcUrl);
  return {
    async read(request): Promise<CmcCapabilityEvidence | null> {
      if (await client.getChainId() !== 56) return null;
      const spec = await input.sessionSpec(request);
      if (spec === null) return null;
      const v1Digest = grantShapeDigestV1(spec);
      const finalized = await client.getBlock({ blockTag: "finalized" });
      if (finalized.number === null || finalized.timestamp < 0n) return null;
      const finalizedNumber = finalized.number;
      const [accountHash, tokenHash, permit2Hash, settlerHash, allowance, checkers, keys] = await Promise.all([
        resolvedCodeHash(client, request.wallet, finalizedNumber), resolvedCodeHash(client, USDT_56, finalizedNumber),
        resolvedCodeHash(client, CMC_PERMIT2, finalizedNumber), resolvedCodeHash(client, CMC_SPENDER, finalizedNumber),
        client.readContract({ address: USDT_56, abi: ERC20_ABI, functionName: "allowance", args: [request.wallet, CMC_PERMIT2], blockNumber: finalizedNumber }),
        client.readContract({ address: request.wallet, abi: ACCOUNT_ABI, functionName: "approvedSignatureCheckers", args: [keyHash(request.sessionPublicKey)], blockNumber: finalizedNumber }),
        client.readContract({ address: request.wallet, abi: ACCOUNT_ABI, functionName: "getKeys", args: [], blockNumber: finalizedNumber }),
      ]);
      const currentHash = keyHash(request.sessionPublicKey);
      if (!Array.isArray(keys) || keys.length !== 2 || !Array.isArray(keys[0]) || !Array.isArray(keys[1]) || keys[1].length === 0) return null;
      const keyRows = keys[0];
      const keyHashes = keys[1];
      if (keyRows.length !== keyHashes.length) return null;
      const currentIndex = keyHashes.findIndex((candidate) => typeof candidate === "string" && candidate.toLowerCase() === currentHash.toLowerCase());
      if (currentIndex < 0) return null;
      const currentRow = keyRows[currentIndex];
      const currentExpiry = keyExpiry(currentRow);
      if (!record(currentRow) || currentRow["isSuperAdmin"] !== false || currentExpiry === null || currentExpiry <= finalized.timestamp) return null;
      for (let index = 0; index < keyRows.length; index += 1) {
        const row = keyRows[index];
        const expiry = keyExpiry(row);
        if (!record(row) || typeof row["isSuperAdmin"] !== "boolean" || expiry === null) return null;
        // Porto's non-expiring owner-admin sentinel is expiry=0. A current
        // session key must be finite and live; only a live foreign session key
        // can invalidate exclusivity. Expiry comparisons use the finalized
        // chain timestamp, never this process's wall clock.
        if (index === currentIndex) continue;
        if (row["isSuperAdmin"] === true) continue;
        if (expiry === 0n || expiry > finalized.timestamp) return null;
      }
      const otherHashes = keyHashes.filter((candidate, index): candidate is Hex => {
        const row = keyRows[index];
        const expiry = keyExpiry(row);
        return typeof candidate === "string" && candidate.toLowerCase() !== currentHash.toLowerCase()
          && record(row) && row["isSuperAdmin"] === false && expiry !== null && expiry > finalized.timestamp;
      });
      const otherCheckerFlags = await Promise.all(otherHashes.map((candidate) => client.readContract({ address: request.wallet, abi: ACCOUNT_ABI, functionName: "approvedSignatureCheckers", args: [candidate], blockNumber: finalizedNumber })));
      const exclusive = otherCheckerFlags.every((candidate) => !hasChecker(candidate));
      if (accountHash === null || tokenHash === null || permit2Hash === null || settlerHash === null || !exclusive) return null;
      // R-2: the existing V1 path is unchanged — a V1 hit is used exactly as before.
      const v1Trace = await input.matrixTrace({ accountCodeHash: accountHash, tokenCodeHash: tokenHash,
        permit2CodeHash: permit2Hash, settlerCodeHash: settlerHash, grantShapeDigest: v1Digest, grantShapeVersion: 1 });
      let trace = v1Trace;
      let grantShapeDigest = v1Digest;
      if (trace === null) {
        // CMC-TOKEN-CLASS-SPEC R2.3: a V1 miss falls back to the reviewed-token-class
        // shape. The class reads run only here, so a pre-aggregator agent that still
        // matches its exact row makes no extra reads.
        const candidates = cmcTokenClassCandidates(spec);
        const members = await readCmcTokenClassMembers(client, candidates, finalizedNumber);
        grantShapeDigest = grantShapeDigestV2(spec, new Set(members.keys()));
        const v2Trace = await input.matrixTrace({ accountCodeHash: accountHash, tokenCodeHash: tokenHash,
          permit2CodeHash: permit2Hash, settlerCodeHash: settlerHash, grantShapeDigest, grantShapeVersion: 2 });
        // The class digest is freshly computed from this process's own reads, so
        // (unlike the pre-existing V1 path) a returned trace is checked against it
        // before use — a defensive check the exact-match V1 registry lookup already
        // satisfies by construction.
        if (v2Trace !== null && v2Trace.grantShapeDigest.toLowerCase() !== grantShapeDigest.toLowerCase()) return null;
        trace = v2Trace;
      }
      if (trace === null) throw new CmcProfileUnavailableError();
      return {
        kind: "cmc-mainnet-capability-v1", source: "live-mainnet", chainId: 56, wallet: request.wallet,
        accountCodeHash: accountHash, tokenCodeHash: tokenHash, permit2CodeHash: permit2Hash, settlerCodeHash: settlerHash,
        sessionPublicKey: request.sessionPublicKey, checker: CMC_PERMIT2, checkerApproved: hasChecker(checkers), finiteAllowanceWei: typeof allowance === "bigint" ? allowance : BigInt(String(allowance)),
        grantShapeDigest, ownerApprovalPersists: trace.ownerApprovalPersists,
        unrelatedTradingPreservesAllowance: trace.unrelatedTradingPreservesAllowance, sessionApproveCannotIncreaseAllowance: trace.sessionApproveCannotIncreaseAllowance,
        noTemporaryApproveConsumePath: trace.noTemporaryApproveConsumePath, revokeExpiryRejectsPayment: trace.revokeExpiryRejectsPayment,
        temporaryApproveCallbackReentryExcluded: trace.temporaryApproveCallbackReentryExcluded,
        walletKeyExclusive: trace.walletKeyExclusive, additiveIncreaseAllowance: trace.additiveIncreaseAllowance,
        proofDigests: trace.proofDigests, observedAtMs: Date.now(), profileId: trace.profileId, generation: request.generation,
      };
    },
  };
}

function expiryReader(client: RpcClient): CmcExpiryReader {
  return {
    async readChainId() { return client.getChainId(); },
    async readFinalizedBlock() {
      const block = await client.getBlock({ blockTag: "finalized" });
      if (block.number === null || block.hash === null) throw new Error("CMC finalized block is incomplete.");
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    async readNonceBitmap(request) {
      const value = await client.readContract({ address: CMC_PERMIT2, abi: PERMIT2_ABI, functionName: "nonceBitmap", args: [request.payer, request.word], blockNumber: request.blockNumber });
      return typeof value === "bigint" ? value : BigInt(String(value));
    },
  };
}

export function createCmcRpcExpiryReaders(input: { readonly rpcUrls: readonly [string, string] }): readonly [CmcExpiryReader, CmcExpiryReader] {
  if (input.rpcUrls[0] === input.rpcUrls[1]) throw new Error("CMC expiry readers must use distinct RPC endpoints.");
  return [expiryReader(rpc(input.rpcUrls[0])), expiryReader(rpc(input.rpcUrls[1]))];
}

/**
 * MEASURED 2026-09-20 (G2): live receipt logs carry BigInt fields
 * (`blockNumber`, `logIndex`), so `JSON.stringify(logs)` threw on every real
 * receipt and the runtime read the throw as "inconclusive" — the first paid
 * charge could never settle. Compare the fields that identify a log instead.
 */
function logsIdentity(logs: readonly { readonly address: string; readonly topics: readonly string[]; readonly data: string; readonly logIndex?: number | bigint; readonly removed?: boolean }[]): string {
  return logs.map((log) => [log.address.toLowerCase(), log.topics.map((topic) => topic.toLowerCase()).join(","), log.data.toLowerCase(),
    log.logIndex === undefined ? "" : String(log.logIndex), log.removed === true ? "removed" : ""].join("|")).join("\n");
}

export type CmcRpcChargeReconciler = {
  reconcile(input: { readonly txHash: Hex; readonly facts: import("./cmcProof.js").CmcPaymentFacts }): Promise<CmcChargeProofResult>;
  /** Locate the settle tx for these facts within a time window; `null` when none or more than one candidate. Never a proof by itself. */
  discover?(input: { readonly facts: import("./cmcProof.js").CmcPaymentFacts; readonly notBeforeSec: bigint; readonly notAfterSec: bigint }): Promise<Hex | null>;
};

const SETTLE_DISCOVERY_ABI = parseAbi(["function settle(((address,uint256),uint256,uint256),address,(address,uint256),bytes)"]);
const TRANSFER_EVENT = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])[0];

/** Largest block whose timestamp is <= `timestampSec`, by binary search over a bounded recent range. */
async function blockAtOrBefore(client: RpcClient, timestampSec: bigint): Promise<bigint> {
  const latest = await client.getBlock({ blockTag: "latest" });
  if (latest.number === null) throw new Error("latest block has no number");
  let low = latest.number > 2_000_000n ? latest.number - 2_000_000n : 0n;
  let high = latest.number;
  if (latest.timestamp <= timestampSec) return latest.number;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp <= timestampSec) low = mid; else high = mid - 1n;
  }
  return low;
}

export function createCmcRpcChargeReconciler(input: { readonly rpcUrls: readonly [string, string]; readonly discoveryRpcUrl?: string }): CmcRpcChargeReconciler {
  const clients = [rpc(input.rpcUrls[0]), rpc(input.rpcUrls[1])] as const;
  const discovery = input.discoveryRpcUrl === undefined ? undefined : rpc(input.discoveryRpcUrl);
  return {
    ...(discovery === undefined ? {} : { async discover(request): Promise<Hex | null> {
      if (request.notAfterSec <= request.notBeforeSec) return null;
      const [fromBlock, toBlock] = await Promise.all([blockAtOrBefore(discovery, request.notBeforeSec), blockAtOrBefore(discovery, request.notAfterSec)]);
      if (toBlock < fromBlock) return null;
      const logs = await discovery.getLogs({ address: getAddress(request.facts.asset), event: TRANSFER_EVENT,
        args: { from: getAddress(request.facts.wallet), to: getAddress(request.facts.payee) }, fromBlock, toBlock });
      const candidates: Hex[] = [];
      for (const log of logs) {
        if (log.args.value !== request.facts.amountWei) continue;
        // The pair, not the discovery endpoint, reads the transaction that will be proven.
        const tx = await clients[0].getTransaction({ hash: log.transactionHash });
        if (tx.to === null || tx.to.toLowerCase() !== request.facts.spender.toLowerCase() || tx.input.slice(0, 10).toLowerCase() !== CMC_SETTLE_SELECTOR) continue;
        let nonce: bigint;
        try { nonce = decodeFunctionData({ abi: SETTLE_DISCOVERY_ABI, data: tx.input }).args[0][1]; } catch { continue; }
        if (nonce !== request.facts.nonce) continue;
        if (!candidates.some((hash) => hash.toLowerCase() === log.transactionHash.toLowerCase())) candidates.push(log.transactionHash);
      }
      return candidates.length === 1 ? candidates[0]! : null;
    } }),
    async reconcile(request) {
      const observations: CmcReceiptObservation[] = [];
      for (const client of clients) {
        const [chainId, receipt, transaction, finalized] = await Promise.all([
          client.getChainId(), client.getTransactionReceipt({ hash: request.txHash }), client.getTransaction({ hash: request.txHash }), client.getBlock({ blockTag: "finalized" }),
        ]);
        const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
        observations.push({ chainId, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
          transactionHash: receipt.transactionHash, from: transaction.from, to: transaction.to, input: transaction.input, logs: receipt.logs,
          finalized: canonical.hash?.toLowerCase() === receipt.blockHash.toLowerCase() && finalized.number !== null && finalized.number >= receipt.blockNumber });
      }
      const first = observations[0]!;
      const second = observations[1]!;
      if (!first.finalized || !second.finalized || first.chainId !== 56 || second.chainId !== 56 || first.chainId !== second.chainId
        || first.blockNumber !== second.blockNumber || first.blockHash.toLowerCase() !== second.blockHash.toLowerCase()
        || first.transactionHash.toLowerCase() !== second.transactionHash.toLowerCase()
        || first.status !== second.status || first.from.toLowerCase() !== second.from.toLowerCase()
        || first.to?.toLowerCase() !== second.to?.toLowerCase() || first.input.toLowerCase() !== second.input.toLowerCase()
        || logsIdentity(first.logs) !== logsIdentity(second.logs)) return { ok: false, reason: "receipt-rpc-disagreement" };
      return verifyCmcChargeProof({ receipt: first, facts: request.facts });
    },
  };
}
