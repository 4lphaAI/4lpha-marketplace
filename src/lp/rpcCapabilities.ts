/**
 * Read-only BSC RPC capability measurement for Phase 3.9c-0.
 *
 * This module is deliberately outside the runtime reader wiring. A benchmark
 * result is deployment evidence, never an authorization or recovery verdict.
 * Production recovery may consume only a separately reviewed evidence-source
 * contract; it must not infer safety from a URL merely appearing here.
 */

import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

export const BSC_MAINNET_CHAIN_ID = 56n;

export type LpRpcCandidate = {
  /** Stable public label. Never put a credential-bearing URL in this field. */
  readonly label: string;
  /** Operator family, used to avoid mistaking aliases for independent quorum. */
  readonly operator: string;
  readonly url: string;
};

export type LpRpcCallResult<T> =
  | { readonly ok: true; readonly latencyMs: number; readonly value: T }
  | { readonly ok: false; readonly latencyMs: number; readonly error: string };

export type LpRpcLogRangeResult = {
  readonly span: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly result: LpRpcCallResult<readonly LpRpcLog[]>;
};

export type LpRpcLog = {
  readonly address: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: bigint;
  readonly logIndex: bigint;
  readonly topics: readonly string[];
  readonly data: string;
};

export type PortoIntentIdentityMeasurement = {
  readonly intentIndex: number;
  readonly encodedIntentHash: string;
  readonly eoa: string;
  readonly nonce: bigint;
  readonly expiry: bigint;
  readonly executionDataHash: string;
  readonly keyHash: string;
  readonly signaturePrehash: number;
};

export type IntentExecutedMeasurement = {
  readonly eoa: string;
  readonly nonce: bigint;
  readonly incremented: boolean;
  readonly err: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: bigint;
  readonly logIndex: bigint;
};

export type LpRpcTransaction = {
  readonly hash: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionIndex: bigint;
  readonly from: string;
  readonly to: string | null;
  /** Retained in memory for the read-only decoder; the CLI never prints it. */
  readonly input: string;
  readonly inputHash: string;
  readonly inputBytes: number;
  readonly portoIntentIdentities: readonly PortoIntentIdentityMeasurement[];
};

export type LpRpcCapabilityReport = {
  readonly label: string;
  readonly operator: string;
  readonly measuredAt: string;
  readonly chainId: LpRpcCallResult<bigint>;
  readonly latestBlock: LpRpcCallResult<bigint>;
  readonly finalizedBlock: LpRpcCallResult<bigint>;
  readonly transaction: LpRpcCallResult<LpRpcTransaction>;
  readonly referenceFullBlock: LpRpcCallResult<{
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly timestamp: bigint;
    readonly transactionCount: number;
    readonly containsReferenceTx: boolean;
    readonly referenceTransaction: LpRpcTransaction | null;
  }>;
  readonly receipt: LpRpcCallResult<{
    readonly status: bigint;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly transactionHash: string;
    readonly transactionIndex: bigint;
    readonly matchingLogIds: readonly string[];
    readonly intentExecuted: readonly IntentExecutedMeasurement[];
  }>;
  /** Method availability near the endpoint's own finalized head. */
  readonly finalizedBlockLogs: LpRpcCallResult<readonly LpRpcLog[]>;
  readonly exactBlockLogs: LpRpcCallResult<readonly LpRpcLog[]>;
  readonly exactBlockContainsReceiptLogs: boolean | null;
  readonly ranges: readonly LpRpcLogRangeResult[];
  readonly sequentialChunks: readonly LpRpcLogRangeResult[];
};

export type MeasureLpRpcCandidateInput = {
  readonly candidate: LpRpcCandidate;
  readonly referenceTxHash: string;
  readonly logAddress: string;
  readonly rangeSpans: readonly number[];
  /** Optional adjacent historical chunks, used only by the capability probe. */
  readonly sequentialChunkWidth?: number;
  readonly sequentialChunkCount?: number;
  readonly timeoutMs: number;
  /** Optional polite pacing for public endpoints with a documented low quota. */
  readonly minimumIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};

type JsonRpcResponse = {
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
};

type RpcReceipt = {
  readonly status: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: bigint;
  readonly logs: readonly LpRpcLog[];
};

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/iu;
const HEX_DATA = /^0x(?:[0-9a-f]{2})*$/iu;
const HASH = /^0x[0-9a-f]{64}$/iu;
const ADDRESS = /^0x[0-9a-f]{40}$/iu;

const PORTO_EXECUTE_ABI = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)",
]);

export const PORTO_V055_INTENT_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "eoa", type: "address" },
      { name: "executionData", type: "bytes" },
      { name: "nonce", type: "uint256" },
      { name: "payer", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "paymentMaxAmount", type: "uint256" },
      { name: "combinedGas", type: "uint256" },
      { name: "encodedPreCalls", type: "bytes[]" },
      { name: "encodedFundTransfers", type: "bytes[]" },
      { name: "settler", type: "address" },
      { name: "expiry", type: "uint256" },
      { name: "isMultichain", type: "bool" },
      { name: "funder", type: "address" },
      { name: "funderSignature", type: "bytes" },
      { name: "settlerContext", type: "bytes" },
      { name: "paymentAmount", type: "uint256" },
      { name: "paymentRecipient", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "paymentSignature", type: "bytes" },
      { name: "supportedAccountImplementation", type: "address" },
    ],
  },
] as const;

export const PORTO_V055_ORCHESTRATOR =
  "0xaf140d0416a994aebb3fa6212b16ce6700f09751";
export const INTENT_EXECUTED_TOPIC =
  "0x23a3c1343409f01965611c9c4c8b99e36d7b09ca22516507d5486ce0584379b8";

/** Revision 6's owned, opData-free ERC-7579 call encoding contract. */
export const LP_FINAL_CALLS_PARAMETERS = [{
  type: "tuple[]",
  components: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
}] as const;

export type LpFingerprintCall = {
  readonly to: Address;
  readonly value?: bigint;
  readonly data?: Hex;
};

/**
 * Research twin of the future C1 encoder. This owns the ABI instead of taking
 * a runtime dependency on viem's experimental ERC-7821 helper.
 */
export function encodeLpFinalCallsV1(
  calls: readonly LpFingerprintCall[],
): Hex {
  return encodeAbiParameters(LP_FINAL_CALLS_PARAMETERS, [calls.map((call) => ({
    target: call.to,
    value: call.value ?? 0n,
    data: call.data ?? "0x",
  }))]);
}

/**
 * Public witness derived from the pinned Porto/Altana BSC transaction.
 * The raw input and one receipt log are already public on chain and are retained
 * solely so offline tests can recompute every published hash and decoded field.
 * Runtime reports still redact the input and embedded public signature.
 */
export const PINNED_PORTO_ALTANA_SANITIZED_FIXTURE = {
  transactionHash: "0xbcda4671167080de46431cce6b90706149ba8988a60fdfe80c11258b3c1df4c0",
  blockNumber: 116_275_440n,
  blockHash: "0x786771ab3d2922fa69075d09bb9a09a6e01cad5efd1cd516dad8c6465fa4941e",
  blockTimestamp: 1_786_884_667n,
  transactionIndex: 105n,
  orchestrator: PORTO_V055_ORCHESTRATOR,
  orchestratorVersion: "0.5.5",
  selector: "0x09c5eabe",
  rawInputBytes: 2_852,
  rawInputHash: "0x05e60794f7813ed2bb30051c064ba04cc664866df07f49cc5c74d9d220353033",
  rawEncodedIntentBytes: 2_784,
  rawEncodedIntentHash: "0xcbeafac575becf6b181d9a2c93c34ad2c78e0642f4a80c45997a6eac3d1a44e0",
  rawTransactionInput: "0x09c5eabe00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000ae00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000561b561ef37874c8e61534be9bae52eb6261ddc40000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000000000002800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000067518a9480c00000000000000000000000000000000000000000000000000000000000179259000000000000000000000000000000000000000000000000000000000000098000000000000000000000000000000000000000000000000000000000000009a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009c000000000000000000000000000000000000000000000000000000000000009e000000000000000000000000000000000000000000000000000004f79cd0fc580000000000000000000000000af089b4eca94a4b2f51d8f5668cff244f2c6c4bc0000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000004b5d20cd8a3927b500540d9bccddc27385c9fa7900000000000000000000000000000000000000000000000000000000000006e00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000001b81d678ffb9c0263b24a97847620c99d213eb1400000000000000000000000000000000000000000000000000051837249ba00000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000204ac9650d800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000104414bf389000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c0000000000000000000000000e09fabb73bd3ade0a17ecc321fd13a19e81ce8200000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000561b561ef37874c8e61534be9bae52eb6261ddc4000000000000000000000000000000000000000000000000000000006a81b2b000000000000000000000000000000000000000000000000000051837249ba00000000000000000000000000000000000000000000000000008261a5e09e80e0d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000412210e8a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e09fabb73bd3ade0a17ecc321fd13a19e81ce82000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b300000000000000000000000046a15b0b27311cedf172ab29e4f4766fbe7f436400000000000000000000000000000000000000000000000008261a5e09e80e0d0000000000000000000000000000000000000000000000000000000000000000000000000000000046a15b0b27311cedf172ab29e4f4766fbe7f436400000000000000000000000000000000000000000000000000059044c9b7e00000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000164883164560000000000000000000000000e09fabb73bd3ade0a17ecc321fd13a19e81ce82000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00000000000000000000000000000000000000000000000000000000000009c4ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1280ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff166800000000000000000000000000000000000000000000000008261a5e09e80e0d00000000000000000000000000000000000000000000000000059044c9b7e00000000000000000000000000000000000000000000000000008113df1940c2264000000000000000000000000000000000000000000000000000572daddbfcfe5000000000000000000000000561b561ef37874c8e61534be9bae52eb6261ddc4000000000000000000000000000000000000000000000000000000006a81b2b00000000000000000000000000000000000000000000000000000000000000000000000000000000046a15b0b27311cedf172ab29e4f4766fbe7f436400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000412210e8a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006235db70f422083548d3e2833080412b27ecac329872ea60a4f37df9d42242565442ca884ee51e8a25ce5c954ea1c344239c4d9f7da1f5e42df76c115881250bd51b04b19abc4a94553e27ccf64290e5b2b588d562abdfbb46fa858e13abb5fef55a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  rawTransaction: {
    hash: "0xbcda4671167080de46431cce6b90706149ba8988a60fdfe80c11258b3c1df4c0",
    from: "0xde3136c489b3371de8180d4c94c0238150e2c5b4",
    to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
    blockNumber: "0x6ee38f0",
    blockHash: "0x786771ab3d2922fa69075d09bb9a09a6e01cad5efd1cd516dad8c6465fa4941e",
    transactionIndex: "0x69",
  },
  rawBlockTimestamp: "0x6a81b23b",
  rawReceipt: {
    status: "0x1",
    blockNumber: "0x6ee38f0",
    blockHash: "0x786771ab3d2922fa69075d09bb9a09a6e01cad5efd1cd516dad8c6465fa4941e",
    transactionHash: "0xbcda4671167080de46431cce6b90706149ba8988a60fdfe80c11258b3c1df4c0",
    transactionIndex: "0x69",
  },
  rawReceiptLog: {
    address: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
    topics: ["0x23a3c1343409f01965611c9c4c8b99e36d7b09ca22516507d5486ce0584379b8","0x000000000000000000000000561b561ef37874c8e61534be9bae52eb6261ddc4","0x0000000000000000000000000000000000000000000000000000000000000028"],
    data: "0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000",
    blockNumber: "0x6ee38f0",
    blockHash: "0x786771ab3d2922fa69075d09bb9a09a6e01cad5efd1cd516dad8c6465fa4941e",
    transactionHash: "0xbcda4671167080de46431cce6b90706149ba8988a60fdfe80c11258b3c1df4c0",
    transactionIndex: "0x69",
    logIndex: "0x27f",
    removed: false,
  },
  eoa: "0x561b561ef37874c8e61534be9bae52eb6261ddc4",
  nonce: 40n,
  expiry: 0n,
  executionDataBytes: 1_760,
  executionDataHash: "0xaaa38825ec61a68df2c2edaeb702a3f32d18401c394ad959a5cbe8cd8eac50bc",
  /** Exact public executionData; signatures and unrelated intent fields are omitted. */
  sanitizedExecutionData: "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000001b81d678ffb9c0263b24a97847620c99d213eb1400000000000000000000000000000000000000000000000000051837249ba00000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000204ac9650d800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000104414bf389000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c0000000000000000000000000e09fabb73bd3ade0a17ecc321fd13a19e81ce8200000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000561b561ef37874c8e61534be9bae52eb6261ddc4000000000000000000000000000000000000000000000000000000006a81b2b000000000000000000000000000000000000000000000000000051837249ba00000000000000000000000000000000000000000000000000008261a5e09e80e0d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000412210e8a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e09fabb73bd3ade0a17ecc321fd13a19e81ce82000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b300000000000000000000000046a15b0b27311cedf172ab29e4f4766fbe7f436400000000000000000000000000000000000000000000000008261a5e09e80e0d0000000000000000000000000000000000000000000000000000000000000000000000000000000046a15b0b27311cedf172ab29e4f4766fbe7f436400000000000000000000000000000000000000000000000000059044c9b7e00000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000164883164560000000000000000000000000e09fabb73bd3ade0a17ecc321fd13a19e81ce82000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00000000000000000000000000000000000000000000000000000000000009c4ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1280ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff166800000000000000000000000000000000000000000000000008261a5e09e80e0d00000000000000000000000000000000000000000000000000059044c9b7e00000000000000000000000000000000000000000000000000008113df1940c2264000000000000000000000000000000000000000000000000000572daddbfcfe5000000000000000000000000561b561ef37874c8e61534be9bae52eb6261ddc4000000000000000000000000000000000000000000000000000000006a81b2b00000000000000000000000000000000000000000000000000000000000000000000000000000000046a15b0b27311cedf172ab29e4f4766fbe7f436400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000412210e8a00000000000000000000000000000000000000000000000000000000",
  keyHash: "0x04b19abc4a94553e27ccf64290e5b2b588d562abdfbb46fa858e13abb5fef55a",
  signaturePrehash: 0,
  receiptStatus: 1n,
  eventLogIndex: 639n,
  eventIncremented: true,
  eventErr: "0x00000000",
} as const;

export function publicBscRpcCandidates(): readonly LpRpcCandidate[] {
  return [
    { label: "bnbchain-primary", operator: "bnb-chain", url: "https://bsc-dataseed.bnbchain.org" },
    { label: "bnbchain-public", operator: "bnb-chain", url: "https://bsc-dataseed-public.bnbchain.org" },
    { label: "nariox", operator: "nariox", url: "https://bsc-dataseed.nariox.org" },
    { label: "defibit", operator: "defibit", url: "https://bsc-dataseed.defibit.io" },
    { label: "ninicoin", operator: "ninicoin", url: "https://bsc-dataseed.ninicoin.io" },
    { label: "nodereal-public", operator: "nodereal", url: "https://bsc.nodereal.io" },
    { label: "subquery-public", operator: "subquery", url: "https://bnb.rpc.subquery.network/public" },
    { label: "publicnode", operator: "allnodes-publicnode", url: "https://bsc-rpc.publicnode.com" },
    { label: "ankr-public", operator: "ankr", url: "https://rpc.ankr.com/bsc" },
    { label: "drpc-public", operator: "drpc", url: "https://bsc.drpc.org" },
    { label: "1rpc-public", operator: "automata-1rpc", url: "https://public.1rpc.io/bnb" },
    { label: "nodies-pokt", operator: "nodies-pokt", url: "https://bsc-pokt.nodies.app" },
    { label: "onfinality-public", operator: "onfinality", url: "https://bnb.api.onfinality.io/public" },
  ];
}

export async function measureLpRpcCandidate(
  input: MeasureLpRpcCandidateInput,
): Promise<LpRpcCapabilityReport> {
  const fetchFn = input.fetch ?? fetch;
  const measuredAt = (input.now ?? (() => new Date()))().toISOString();
  const address = normalizeAddress(input.logAddress);
  if (!HASH.test(input.referenceTxHash)) {
    throw new Error("referenceTxHash must be a 32-byte 0x-prefixed hash.");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  const spans = normalizeSpans(input.rangeSpans);
  const sequential = normalizeSequentialChunks(
    input.sequentialChunkWidth,
    input.sequentialChunkCount,
  );
  let id = 0;
  let nextRequestAt = 0;

  const call = async <T>(
    method: string,
    params: readonly unknown[],
    decode: (value: unknown) => T,
  ): Promise<LpRpcCallResult<T>> => {
    const minimumIntervalMs = input.minimumIntervalMs ?? 0;
    if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("minimumIntervalMs must be a non-negative integer.");
    }
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await delay(waitMs);
    nextRequestAt = Date.now() + minimumIntervalMs;
    const started = performance.now();
    try {
      const response = await fetchFn(input.candidate.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = asJsonRpcResponse(await response.json());
      if (body.error !== undefined) {
        const code = typeof body.error.code === "number" ? ` ${body.error.code}` : "";
        const message = typeof body.error.message === "string" ? body.error.message : "RPC error";
        throw new Error(`RPC${code}: ${message}`);
      }
      if (!("result" in body)) throw new Error("RPC response omitted result.");
      return { ok: true, latencyMs: elapsedMs(started), value: decode(body.result) };
    } catch (error) {
      return {
        ok: false,
        latencyMs: elapsedMs(started),
        error: sanitizeError(error),
      };
    }
  };

  const chainId = await call("eth_chainId", [], decodeQuantity);
  const latestBlock = await call("eth_blockNumber", [], decodeQuantity);
  const finalizedBlock = await call(
    "eth_getBlockByNumber",
    ["finalized", false],
    decodeBlockNumber,
  );
  const transaction = await call(
    "eth_getTransactionByHash",
    [input.referenceTxHash],
    decodeTransaction,
  );
  const referenceBlockFromTransaction = transaction.ok
    ? transaction.value.blockNumber
    : null;
  const referenceFullBlock =
    referenceBlockFromTransaction === null
      ? unavailable<{
          readonly blockNumber: bigint;
          readonly blockHash: string;
          readonly timestamp: bigint;
          readonly transactionCount: number;
          readonly containsReferenceTx: boolean;
          readonly referenceTransaction: LpRpcTransaction | null;
        }>("Reference transaction block is unavailable.")
      : await call(
          "eth_getBlockByNumber",
          [toQuantity(referenceBlockFromTransaction), true],
          (value) => decodeFullBlock(value, input.referenceTxHash),
        );
  const receipt = await call(
    "eth_getTransactionReceipt",
    [input.referenceTxHash],
    (value) => {
      const decoded = decodeReceipt(value);
      return {
        status: decoded.status,
        blockNumber: decoded.blockNumber,
        blockHash: decoded.blockHash,
        transactionHash: decoded.transactionHash,
        transactionIndex: decoded.transactionIndex,
        matchingLogIds: matchingLogs(decoded.logs, address).map(logId),
        intentExecuted: transaction.ok
          ? decoded.logs.flatMap((log) =>
              log.address === transaction.value.to
                ? decodeIntentExecutedLog(log)
                : [],
            )
          : [],
      };
    },
  );

  const finalizedBlockLogs = finalizedBlock.ok
    ? await getLogs(call, address, finalizedBlock.value, finalizedBlock.value)
    : unavailable<readonly LpRpcLog[]>("Finalized block is unavailable.");

  const referenceBlock = receipt.ok
    ? receipt.value.blockNumber
    : transaction.ok
      ? transaction.value.blockNumber
      : null;

  let exactBlockLogs: LpRpcCallResult<readonly LpRpcLog[]>;
  const ranges: LpRpcLogRangeResult[] = [];
  const sequentialChunks: LpRpcLogRangeResult[] = [];
  if (referenceBlock === null) {
    exactBlockLogs = unavailable("Reference transaction block is unavailable.");
  } else {
    exactBlockLogs = await getLogs(call, address, referenceBlock, referenceBlock);
    for (const span of spans) {
      const width = BigInt(span - 1);
      const fromBlock = referenceBlock > width ? referenceBlock - width : 0n;
      ranges.push({
        span,
        fromBlock,
        toBlock: referenceBlock,
        result:
          span === 1
            ? exactBlockLogs
            : await getLogs(call, address, fromBlock, referenceBlock),
      });
    }
    if (sequential !== null) {
      for (let index = 0; index < sequential.count; index += 1) {
        const reverseIndex = sequential.count - 1 - index;
        const offset = BigInt(reverseIndex * sequential.width);
        if (offset > referenceBlock) continue;
        const toBlock = referenceBlock - offset;
        const width = BigInt(sequential.width - 1);
        const fromBlock = toBlock > width ? toBlock - width : 0n;
        sequentialChunks.push({
          span: sequential.width,
          fromBlock,
          toBlock,
          result: await getLogs(call, address, fromBlock, toBlock),
        });
      }
    }
  }

  const exactBlockContainsReceiptLogs =
    receipt.ok &&
    receipt.value.matchingLogIds.length > 0 &&
    exactBlockLogs.ok
      ? receipt.value.matchingLogIds.every((expected) =>
          exactBlockLogs.value.some((log) => logId(log) === expected),
        )
      : null;

  return {
    label: input.candidate.label,
    operator: input.candidate.operator,
    measuredAt,
    chainId,
    latestBlock,
    finalizedBlock,
    transaction,
    referenceFullBlock,
    receipt,
    finalizedBlockLogs,
    exactBlockLogs,
    exactBlockContainsReceiptLogs,
    ranges,
    sequentialChunks,
  };
}

async function getLogs(
  call: <T>(
    method: string,
    params: readonly unknown[],
    decode: (value: unknown) => T,
  ) => Promise<LpRpcCallResult<T>>,
  address: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<LpRpcCallResult<readonly LpRpcLog[]>> {
  return call(
    "eth_getLogs",
    [{ address, fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock) }],
    decodeLogs,
  );
}

function decodeTransaction(value: unknown, requirePinnedPorto = true): LpRpcTransaction {
  const record = asRecord(value, "transaction");
  const input = decodeData(record["input"], "transaction.input");
  const to = record["to"] === null ? null : normalizeAddress(record["to"]);
  let portoIntentIdentities: readonly PortoIntentIdentityMeasurement[] = [];
  if (to === PORTO_V055_ORCHESTRATOR) {
    try {
      portoIntentIdentities = decodePortoV055TransactionInput(input);
    } catch (error) {
      if (requirePinnedPorto || input.startsWith("0x09c5eabe") || input.startsWith("0x44471415")) {
        throw error;
      }
    }
  } else if (requirePinnedPorto) {
    throw new Error("reference transaction does not target the pinned Porto Orchestrator.");
  }
  return {
    hash: decodeHash(record["hash"], "transaction.hash"),
    blockNumber: decodeQuantity(record["blockNumber"]),
    blockHash: decodeHash(record["blockHash"], "transaction.blockHash"),
    transactionIndex: decodeQuantity(record["transactionIndex"]),
    from: normalizeAddress(record["from"]),
    to,
    input,
    inputHash: keccak256(input as Hex),
    inputBytes: (input.length - 2) / 2,
    portoIntentIdentities,
  };
}

function decodeFullBlock(
  value: unknown,
  referenceTxHash: string,
): {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly timestamp: bigint;
  readonly transactionCount: number;
  readonly containsReferenceTx: boolean;
  readonly referenceTransaction: LpRpcTransaction | null;
} {
  const record = asRecord(value, "full block");
  const hash = record["hash"];
  const transactions = record["transactions"];
  if (typeof hash !== "string" || !HASH.test(hash)) {
    throw new Error("full block hash is invalid.");
  }
  if (!Array.isArray(transactions)) throw new Error("full block transactions must be an array.");
  const decodedTransactions = transactions.map((transaction) =>
    decodeTransaction(transaction, false),
  );
  const referenceTransaction =
    decodedTransactions.find(
      (transaction) => transaction.hash === referenceTxHash.toLowerCase(),
    ) ?? null;
  return {
    blockNumber: decodeQuantity(record["number"]),
    blockHash: hash.toLowerCase(),
    timestamp: decodeQuantity(record["timestamp"]),
    transactionCount: decodedTransactions.length,
    containsReferenceTx: referenceTransaction !== null,
    referenceTransaction,
  };
}

function decodeReceipt(value: unknown): RpcReceipt {
  const record = asRecord(value, "receipt");
  const rawLogs = record["logs"];
  if (!Array.isArray(rawLogs)) throw new Error("receipt.logs must be an array.");
  return {
    status: decodeQuantity(record["status"]),
    blockNumber: decodeQuantity(record["blockNumber"]),
    blockHash: decodeHash(record["blockHash"], "receipt.blockHash"),
    transactionHash: decodeHash(record["transactionHash"], "receipt.transactionHash"),
    transactionIndex: decodeQuantity(record["transactionIndex"]),
    logs: rawLogs.map(decodeLog),
  };
}

function decodeBlockNumber(value: unknown): bigint {
  const record = asRecord(value, "block");
  return decodeQuantity(record["number"]);
}

function decodeLogs(value: unknown): readonly LpRpcLog[] {
  if (!Array.isArray(value)) throw new Error("eth_getLogs result must be an array.");
  return value.map(decodeLog);
}

function decodeLog(value: unknown): LpRpcLog {
  const record = asRecord(value, "log");
  const rawTopics = record["topics"];
  if (!Array.isArray(rawTopics) || !rawTopics.every((topic) => typeof topic === "string" && HASH.test(topic))) {
    throw new Error("log.topics must contain 32-byte hashes.");
  }
  const data = record["data"];
  const transactionHash = record["transactionHash"];
  if (typeof data !== "string" || !HEX_DATA.test(data)) throw new Error("log.data is invalid.");
  if (typeof transactionHash !== "string" || !HASH.test(transactionHash)) {
    throw new Error("log.transactionHash is invalid.");
  }
  return {
    address: normalizeAddress(record["address"]),
    blockNumber: decodeQuantity(record["blockNumber"]),
    blockHash: decodeHash(record["blockHash"], "log.blockHash"),
    transactionHash: transactionHash.toLowerCase(),
    transactionIndex: decodeQuantity(record["transactionIndex"]),
    logIndex: decodeQuantity(record["logIndex"]),
    topics: rawTopics.map((topic) => topic.toLowerCase()),
    data: data.toLowerCase(),
  };
}

/**
 * Decoder registry entry for the measured BSC Orchestrator 0.5.5 layout.
 * Unknown selectors/layouts are rejected rather than heuristically parsed.
 */
export function decodePortoV055TransactionInput(
  input: string,
): readonly PortoIntentIdentityMeasurement[] {
  const data = decodeData(input, "transaction.input") as Hex;
  let decoded: ReturnType<typeof decodeFunctionData<typeof PORTO_EXECUTE_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: PORTO_EXECUTE_ABI, data });
  } catch {
    throw new Error("transaction.input is not Porto Orchestrator 0.5.5 execute calldata.");
  }
  const argument = decoded.args[0];
  const encodedIntents = Array.isArray(argument) ? argument : [argument];
  return encodedIntents.map((encodedIntent, intentIndex) =>
    decodePortoV055Intent(encodedIntent, intentIndex),
  );
}

function decodePortoV055Intent(
  encodedIntent: Hex,
  intentIndex: number,
): PortoIntentIdentityMeasurement {
  let intent: ReturnType<typeof decodeAbiParameters<typeof PORTO_V055_INTENT_PARAMETERS>>[0];
  try {
    [intent] = decodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, encodedIntent);
  } catch {
    throw new Error(`encoded intent ${intentIndex} is malformed for Orchestrator 0.5.5.`);
  }
  const signature = intent.signature;
  const signatureBytes = (signature.length - 2) / 2;
  if (signatureBytes < 33) {
    throw new Error(`encoded intent ${intentIndex} signature wrapper is too short.`);
  }
  const keyHashStart = signature.length - 66;
  return {
    intentIndex,
    encodedIntentHash: keccak256(encodedIntent),
    eoa: intent.eoa.toLowerCase(),
    nonce: intent.nonce,
    expiry: intent.expiry,
    executionDataHash: keccak256(intent.executionData),
    keyHash: `0x${signature.slice(keyHashStart, signature.length - 2)}`.toLowerCase(),
    signaturePrehash: Number.parseInt(signature.slice(-2), 16),
  };
}

export function decodeIntentExecutedLog(
  log: LpRpcLog,
): readonly IntentExecutedMeasurement[] {
  if (log.topics[0] !== INTENT_EXECUTED_TOPIC) return [];
  if (log.topics.length !== 3 || (log.data.length - 2) / 2 !== 64) {
    throw new Error("IntentExecuted log has a malformed topic/data shape.");
  }
  const eoaTopic = log.topics[1];
  const nonceTopic = log.topics[2];
  if (eoaTopic === undefined || nonceTopic === undefined) {
    throw new Error("IntentExecuted log omitted indexed identity fields.");
  }
  const eoa = normalizeAddress(`0x${eoaTopic.slice(-40)}`);
  const nonce = BigInt(nonceTopic);
  const [incremented, err] = decodeAbiParameters(
    [{ type: "bool" }, { type: "bytes4" }],
    log.data as Hex,
  );
  return [{
    eoa,
    nonce,
    incremented,
    err: err.toLowerCase(),
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  }];
}

function decodeQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) {
    throw new Error("RPC quantity is not canonical hexadecimal.");
  }
  return BigInt(value);
}

function decodeHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Error(`${name} must be a 32-byte hash.`);
  }
  return value.toLowerCase();
}

function decodeData(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_DATA.test(value)) {
    throw new Error(`${name} must be canonical hexadecimal data.`);
  }
  return value.toLowerCase();
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new Error("logAddress must be a 20-byte 0x-prefixed address.");
  }
  return value.toLowerCase();
}

function normalizeSpans(values: readonly number[]): readonly number[] {
  const normalized = [...new Set(values)];
  if (
    normalized.length === 0 ||
    normalized.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new Error("rangeSpans must contain positive safe integers.");
  }
  return normalized.sort((left, right) => left - right);
}

function normalizeSequentialChunks(
  width: number | undefined,
  count: number | undefined,
): { readonly width: number; readonly count: number } | null {
  if (width === undefined && count === undefined) return null;
  if (
    width === undefined ||
    count === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(count) ||
    width < 1 ||
    count < 1 ||
    width > 10_000 ||
    count > 100
  ) {
    throw new Error("sequential chunk width/count must be bounded positive safe integers.");
  }
  return { width, count };
}

function matchingLogs(logs: readonly LpRpcLog[], address: string): readonly LpRpcLog[] {
  return logs.filter((log) => log.address === address);
}

function logId(log: LpRpcLog): string {
  return `${log.transactionHash}:${log.logIndex.toString(10)}`;
}

function asJsonRpcResponse(value: unknown): JsonRpcResponse {
  const record = asRecord(value, "JSON-RPC response");
  const error = record["error"];
  if (error === undefined) return { result: record["result"] };
  const errorRecord = asRecord(error, "JSON-RPC error");
  return {
    result: record["result"],
    error: { code: errorRecord["code"], message: errorRecord["message"] },
  };
}

function asRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function toQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function unavailable<T>(error: string): LpRpcCallResult<T> {
  return { ok: false, latencyMs: 0, error };
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "request failed";
  return message.replace(/https?:\/\/\S+/giu, "[rpc-url]").slice(0, 240);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
