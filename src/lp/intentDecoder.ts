/** Phase 3.9c C2/C3 exact Porto Orchestrator 0.5.5 decoder and pairing. */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  PORTO_V055_DECODER,
  PORTO_V055_ORCHESTRATOR,
  PORTO_V055_VERSION,
  type PreparedIntentIdentityV1,
} from "./preparedIntent.js";

export const INTENT_EXECUTED_TOPIC =
  "0x23a3c1343409f01965611c9c4c8b99e36d7b09ca22516507d5486ce0584379b8" as Hex;

const EXECUTE_ABI = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)",
]);

export const PORTO_V055_INTENT_PARAMETERS = [{
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
}] as const;

export type DecodedPortoIntentV055 = {
  readonly decoder: typeof PORTO_V055_DECODER;
  readonly orchestratorVersion: typeof PORTO_V055_VERSION;
  readonly memberIndex: number;
  readonly memberCount: number;
  readonly encodedIntentHash: Hex;
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly expiry: bigint;
  readonly executionDataHash: Hex;
  readonly keyHash: Hex;
  readonly prehash: number;
};

export type LandingTransaction = {
  readonly hash: Hex;
  readonly to: Address;
  readonly input: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
};

export type LandingReceiptLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly logIndex: bigint;
};

export type LandingReceipt = {
  readonly status: bigint;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly logs: readonly LandingReceiptLog[];
};

export type IntentExecutedV055 = {
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly incremented: boolean;
  readonly err: Hex;
  readonly logIndex: bigint;
  readonly topicsHash: Hex;
  readonly dataHash: Hex;
};

export type LandedIntentProof = {
  readonly txHash: Hex;
  readonly inputHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly intentIndex: number;
  readonly memberCount: number;
  readonly logIndex: bigint;
  readonly eventTopicsHash: Hex;
  readonly eventDataHash: Hex;
};

export type CandidatePairingResult =
  | { readonly outcome: "landed"; readonly proof: LandedIntentProof }
  | { readonly outcome: "ambiguous"; readonly reason: string };

export function decodePortoV055Transaction(
  chainId: number,
  orchestrator: Address,
  input: Hex,
): readonly DecodedPortoIntentV055[] {
  if (chainId !== 56 || orchestrator.toLowerCase() !== PORTO_V055_ORCHESTRATOR) {
    throw new Error("Unsupported Porto decoder registry key.");
  }
  let decoded: ReturnType<typeof decodeFunctionData<typeof EXECUTE_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: input });
  } catch {
    throw new Error("Orchestrator calldata is not exact execute(bytes|bytes[]).");
  }
  const argument = decoded.args[0];
  const members = Array.isArray(argument) ? argument : [argument];
  if (members.length === 0 || members.length > 32) {
    throw new Error("Orchestrator intent member count is outside 1..32.");
  }
  const reencoded = decoded.functionName === "execute"
    ? encodeFunctionData({
        abi: EXECUTE_ABI,
        functionName: "execute",
        args: [argument],
      })
    : "0x";
  if (reencoded.toLowerCase() !== input.toLowerCase()) {
    throw new Error("Orchestrator calldata is non-canonical or has trailing data.");
  }
  return members.map((member, index) => decodeMember(member, index, members.length));
}

function decodeMember(
  encoded: Hex,
  memberIndex: number,
  memberCount: number,
): DecodedPortoIntentV055 {
  if ((encoded.length - 2) / 2 > 4_096) throw new Error("Intent member exceeds 4096 bytes.");
  let intent: ReturnType<typeof decodeAbiParameters<typeof PORTO_V055_INTENT_PARAMETERS>>[0];
  try {
    [intent] = decodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, encoded);
  } catch {
    throw new Error(`Intent member ${memberIndex} is malformed for Orchestrator 0.5.5.`);
  }
  if ((intent.executionData.length - 2) / 2 > 4_096) {
    throw new Error(`Intent member ${memberIndex} executionData exceeds 4096 bytes.`);
  }
  const signatureBytes = (intent.signature.length - 2) / 2;
  if (signatureBytes < 33) throw new Error(`Intent member ${memberIndex} wrapper is too short.`);
  const prehash = Number.parseInt(intent.signature.slice(-2), 16);
  const keyHash = `0x${intent.signature.slice(-66, -2)}`.toLowerCase() as Hex;
  return {
    decoder: PORTO_V055_DECODER,
    orchestratorVersion: PORTO_V055_VERSION,
    memberIndex,
    memberCount,
    encodedIntentHash: keccak256(encoded),
    eoa: intent.eoa.toLowerCase() as Address,
    nonce: intent.nonce,
    expiry: intent.expiry,
    executionDataHash: keccak256(intent.executionData),
    keyHash,
    prehash,
  };
}

export function decodeIntentExecutedV055(
  log: LandingReceiptLog,
  orchestrator: Address = PORTO_V055_ORCHESTRATOR,
): IntentExecutedV055 | null {
  if (log.address.toLowerCase() !== orchestrator.toLowerCase()) return null;
  if (log.topics[0]?.toLowerCase() !== INTENT_EXECUTED_TOPIC) return null;
  if (log.topics.length !== 3 || (log.data.length - 2) / 2 !== 64) {
    throw new Error("IntentExecuted has a malformed exact topic/data shape.");
  }
  const eoaTopic = log.topics[1];
  const nonceTopic = log.topics[2];
  if (eoaTopic === undefined || nonceTopic === undefined) {
    throw new Error("IntentExecuted omitted its indexed identity.");
  }
  const [incremented, err] = decodeAbiParameters(
    [{ type: "bool" }, { type: "bytes4" }],
    log.data,
  );
  const topicsBytes = `0x${log.topics.map((topic) => topic.slice(2)).join("")}` as Hex;
  return {
    eoa: getAddress(`0x${eoaTopic.slice(-40)}`).toLowerCase() as Address,
    nonce: BigInt(nonceTopic),
    incremented,
    err: err.toLowerCase() as Hex,
    logIndex: log.logIndex,
    topicsHash: keccak256(topicsBytes),
    dataHash: keccak256(log.data),
  };
}

/**
 * Pair one complete transaction+receipt against the persisted prepared tuple.
 * Zero, duplicate, cross-member success and every receipt mismatch are
 * ambiguous; absence is a coverage-ledger decision, never made here.
 */
export function pairPreparedIntentCandidate(
  identity: PreparedIntentIdentityV1,
  transaction: LandingTransaction,
  receipt: LandingReceipt,
): CandidatePairingResult {
  if (transaction.to.toLowerCase() !== identity.orchestrator ||
      receipt.transactionHash.toLowerCase() !== transaction.hash.toLowerCase() ||
      receipt.blockNumber !== transaction.blockNumber ||
      receipt.blockHash.toLowerCase() !== transaction.blockHash.toLowerCase() ||
      receipt.transactionIndex !== transaction.transactionIndex || receipt.status !== 1n) {
    return { outcome: "ambiguous", reason: "transaction/receipt identity or status mismatch" };
  }
  let members: readonly DecodedPortoIntentV055[];
  try {
    members = decodePortoV055Transaction(56, transaction.to, transaction.input);
  } catch {
    return { outcome: "ambiguous", reason: "candidate decoder rejected calldata" };
  }
  const matching = members.filter((member) =>
    member.eoa === identity.eoa &&
    member.nonce.toString(10) === identity.nonce &&
    member.keyHash === identity.keyHash &&
    member.executionDataHash === identity.executionDataHash,
  );
  if (matching.length !== 1) {
    return { outcome: "ambiguous", reason: "candidate has zero or duplicate matching members" };
  }
  const member = matching[0];
  if (member === undefined) return { outcome: "ambiguous", reason: "missing selected member" };
  let events: IntentExecutedV055[];
  try {
    events = receipt.logs.flatMap((log) => {
      const event = decodeIntentExecutedV055(log, transaction.to);
      return event === null ? [] : [event];
    });
  } catch {
    return { outcome: "ambiguous", reason: "candidate has malformed IntentExecuted evidence" };
  }
  const matchingEvents = events.filter((event) =>
    event.eoa === identity.eoa && event.nonce.toString(10) === identity.nonce &&
    event.incremented && event.err === "0x00000000",
  );
  if (matchingEvents.length !== 1 || events.filter((event) =>
      event.eoa === identity.eoa && event.nonce.toString(10) === identity.nonce).length !== 1) {
    return { outcome: "ambiguous", reason: "candidate has zero, duplicate, or failed paired events" };
  }
  const event = matchingEvents[0];
  if (event === undefined) return { outcome: "ambiguous", reason: "missing selected event" };
  return {
    outcome: "landed",
    proof: {
      txHash: transaction.hash.toLowerCase() as Hex,
      inputHash: keccak256(transaction.input),
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash.toLowerCase() as Hex,
      transactionIndex: transaction.transactionIndex,
      intentIndex: member.memberIndex,
      memberCount: member.memberCount,
      logIndex: event.logIndex,
      eventTopicsHash: event.topicsHash,
      eventDataHash: event.dataHash,
    },
  };
}
