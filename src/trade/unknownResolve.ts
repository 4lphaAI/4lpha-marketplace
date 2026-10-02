import { createPublicClient, getAddress, http, keccak256, parseAbi, stringToHex,
  type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import type { AgentRecord } from "../store/agents.js";
import { RECONCILE_MIN_ROW_AGE_MS, type JournalEntry, type JournalResolutionEvidence } from "../store/journal.js";
import { parsePreparedIntentIdentityV1, PORTO_V055_ORCHESTRATOR } from "../lp/preparedIntent.js";
import { decodeIntentExecutedV055, decodePortoV055Transaction, INTENT_EXECUTED_TOPIC,
  pairPreparedIntentCandidate } from "../lp/intentDecoder.js";
import { createTradfiV2ReceiptReader, TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES,
  TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES, TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES,
  type TradfiReceiptObservation } from "./receipt.js";

export const TRADE_UNKNOWN_MIN_AGE_MS = RECONCILE_MIN_ROW_AGE_MS;
export const TRADE_UNKNOWN_LOG_CHUNK_BLOCKS = 8_000n;
export const TRADE_UNKNOWN_MAX_SCAN_BLOCKS = 400_000n;
export const TRADE_UNKNOWN_LOWER_MARGIN_SEC = 120n;
const TRADE_INTENT_LIMITS = { memberBytes: TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES,
  executionDataBytes: TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES };

export type TradeUnknownReads = {
  finalizedBlock(): Promise<{ readonly number: bigint; readonly hash: Hex } | null>;
  accountNonce(wallet: Address, seqKey: bigint, blockNumber: bigint): Promise<bigint>;
  blockAtOrBefore(timestampSec: bigint): Promise<bigint>;
  intentExecutedTxHashes(eoa: Address, nonce: bigint, fromBlock: bigint, toBlock: bigint): Promise<readonly Hex[]>;
  readFinalized(txHash: Hex): Promise<TradfiReceiptObservation | null>;
};

export type TradeUnknownVerdict =
  | { readonly kind: "not-eligible"; readonly reason: string }
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "landed" | "landed-failed" | "superseded"; readonly txHash: Hex; readonly evidence: JournalResolutionEvidence };

const NONCE_ABI = parseAbi(["function getNonce(uint192 seqKey) view returns (uint256)"]);

export function createTradeUnknownReads(input: { readonly rpcUrls: readonly [string, string]; readonly logsRpcUrl: string }): TradeUnknownReads {
  if (input.rpcUrls[0] === input.rpcUrls[1]) throw new Error("Trade UNKNOWN reads require two distinct RPC endpoints.");
  const pair = input.rpcUrls.map((url) => createPublicClient({ chain: bsc, transport: http(url, { retryCount: 0 }) }));
  const logs = createPublicClient({ chain: bsc, transport: http(input.logsRpcUrl, { retryCount: 0 }) });
  const receipts = createTradfiV2ReceiptReader({ rpcUrls: input.rpcUrls });
  return {
    finalizedBlock: () => receipts.finalizedBlock(),
    readFinalized: (hash) => receipts.readFinalized(hash),
    async accountNonce(wallet, seqKey, blockNumber) {
      const values = await Promise.all(pair.map((client) => client.readContract({ address: wallet,
        abi: NONCE_ABI, functionName: "getNonce", args: [seqKey], blockNumber })));
      if (values[0] === undefined || values[1] === undefined || values[0] !== values[1]) {
        throw new Error("Trade UNKNOWN nonce RPC pair disagrees.");
      }
      return values[0];
    },
    async blockAtOrBefore(timestampSec) {
      const latest = await logs.getBlock({ blockTag: "latest" });
      const lowBound = latest.number > 2_000_000n ? latest.number - 2_000_000n : 0n;
      const lowBlock = await logs.getBlock({ blockNumber: lowBound });
      if (lowBlock.timestamp > timestampSec) throw new Error("window-unavailable");
      if (latest.timestamp <= timestampSec) return latest.number;
      let low = lowBound;
      let high = latest.number;
      while (low < high) {
        const mid = (low + high + 1n) / 2n;
        const block = await logs.getBlock({ blockNumber: mid });
        if (block.timestamp <= timestampSec) low = mid; else high = mid - 1n;
      }
      return low;
    },
    async intentExecutedTxHashes(eoa, nonce, fromBlock, toBlock) {
      if (toBlock < fromBlock || toBlock - fromBlock + 1n > TRADE_UNKNOWN_LOG_CHUNK_BLOCKS) {
        throw new Error("Trade UNKNOWN log window exceeds 8000 blocks.");
      }
      const rows = await logs.request({ method: "eth_getLogs", params: [{
        address: PORTO_V055_ORCHESTRATOR,
        fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`,
        topics: [INTENT_EXECUTED_TOPIC,
          `0x${eoa.toLowerCase().slice(2).padStart(64, "0")}`,
          `0x${nonce.toString(16).padStart(64, "0")}`],
      }] });
      return [...new Set(rows.map((row) => row.transactionHash as Hex))];
    },
  };
}

export async function assessTradeUnknown(input: {
  readonly agent: AgentRecord; readonly journal: JournalEntry; readonly reads: TradeUnknownReads;
  readonly nowMs: number; readonly signal?: AbortSignal;
}): Promise<TradeUnknownVerdict> {
  const { agent, journal, reads, nowMs, signal } = input;
  if (journal.kind !== "trade" || journal.state !== "UNKNOWN") return { kind: "not-eligible", reason: "row-state" };
  if (journal.externalRef.txHash !== undefined) return { kind: "not-eligible", reason: "tx-hash-present" };
  if (journal.preparedIntentIdentity === null || journal.preparedIntentIdentityHash === null) {
    return { kind: "not-eligible", reason: "identity-absent" };
  }
  let identity: ReturnType<typeof parsePreparedIntentIdentityV1>;
  try {
    identity = parsePreparedIntentIdentityV1(journal.preparedIntentIdentity);
    if (keccak256(stringToHex(journal.preparedIntentIdentity)) !== journal.preparedIntentIdentityHash) {
      return { kind: "not-eligible", reason: "identity-hash" };
    }
  } catch { return { kind: "not-eligible", reason: "identity-invalid" }; }
  if (identity.eoa !== agent.walletAddress.toLowerCase() || journal.agentId !== agent.id ||
      journal.ownerAddress.toLowerCase() !== agent.ownerAddress.toLowerCase()) {
    return { kind: "not-eligible", reason: "agent-mismatch" };
  }
  if (nowMs - journal.updatedAt < TRADE_UNKNOWN_MIN_AGE_MS) return { kind: "not-eligible", reason: "too-young" };
  signal?.throwIfAborted();
  let finalized: { readonly number: bigint; readonly hash: Hex } | null;
  try { finalized = await reads.finalizedBlock(); }
  catch { return { kind: "hold", reason: "finalized-unavailable" }; }
  if (finalized === null) return { kind: "hold", reason: "finalized-unavailable" };
  const nonce = BigInt(identity.nonce);
  let current: bigint;
  try { current = await reads.accountNonce(getAddress(agent.walletAddress), nonce >> 64n, finalized.number); }
  catch { return { kind: "hold", reason: "nonce-unavailable" }; }
  if (current <= nonce) return { kind: "hold", reason: "nonce-unconsumed" };
  let from: bigint;
  try { from = await reads.blockAtOrBefore(BigInt(Math.floor(journal.createdAt / 1_000)) - TRADE_UNKNOWN_LOWER_MARGIN_SEC); }
  catch { return { kind: "hold", reason: "window-unavailable" }; }
  const to = finalized.number;
  if (to < from) return { kind: "hold", reason: "window-empty" };
  const end = to < from + TRADE_UNKNOWN_MAX_SCAN_BLOCKS - 1n ? to : from + TRADE_UNKNOWN_MAX_SCAN_BLOCKS - 1n;
  let unverified = false;
  type Candidate = { readonly kind: "landed" | "landed-failed" | "superseded"; readonly txHash: Hex;
    readonly obs: TradfiReceiptObservation; readonly memberEqual: boolean; readonly err: Hex };
  let found: Candidate[] = [];
  for (let start = from; start <= end; start += TRADE_UNKNOWN_LOG_CHUNK_BLOCKS) {
    signal?.throwIfAborted();
    const chunkEnd = start + TRADE_UNKNOWN_LOG_CHUNK_BLOCKS - 1n < end ? start + TRADE_UNKNOWN_LOG_CHUNK_BLOCKS - 1n : end;
    let hashes: readonly Hex[];
    try { hashes = await reads.intentExecutedTxHashes(identity.eoa, nonce, start, chunkEnd); }
    catch { return { kind: "hold", reason: "logs-unavailable" }; }
    const candidates: Candidate[] = [];
    for (const txHash of new Set(hashes)) {
      let obs: TradfiReceiptObservation | null;
      try { obs = await reads.readFinalized(txHash); }
      catch { obs = null; }
      if (obs === null || obs.transaction.to?.toLowerCase() !== PORTO_V055_ORCHESTRATOR ||
          obs.receipt.status !== 1n || obs.transaction.hash.toLowerCase() !== txHash.toLowerCase() ||
          obs.receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() ||
          obs.transaction.blockNumber !== obs.receipt.blockNumber ||
          obs.transaction.blockHash.toLowerCase() !== obs.receipt.blockHash.toLowerCase() ||
          obs.transaction.transactionIndex !== obs.receipt.transactionIndex ||
          obs.receiptBlock.hash.toLowerCase() !== obs.receipt.blockHash.toLowerCase() ||
          obs.finalizedBlock.number < obs.receipt.blockNumber) { unverified = true; continue; }
      if ((obs.transaction.input.length - 2) / 2 > TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES) {
        unverified = true;
        continue;
      }
      try {
        const members = decodePortoV055Transaction(56, obs.transaction.to, obs.transaction.input, TRADE_INTENT_LIMITS);
        const events = obs.receipt.logs.flatMap((log) => {
          const event = decodeIntentExecutedV055(log);
          return event === null ? [] : [event];
        });
        const walletMembers = members.filter((member) => member.eoa === identity.eoa);
        const walletEvents = events.filter((event) => event.eoa === identity.eoa);
        const matchingMembers = walletMembers.filter((member) => member.nonce === nonce);
        const matchingEvents = walletEvents.filter((event) => event.nonce === nonce);
        if (walletMembers.length !== 1 || walletEvents.length !== 1 ||
            matchingMembers.length !== 1 || matchingEvents.length !== 1) { unverified = true; continue; }
        const member = matchingMembers[0]!;
        const event = matchingEvents[0]!;
        if (!event.incremented) continue;
        const memberEqual = member.executionDataHash === identity.executionDataHash && member.keyHash === identity.keyHash;
        if (memberEqual && event.err === "0x00000000" &&
            pairPreparedIntentCandidate(identity, obs.transaction as Parameters<typeof pairPreparedIntentCandidate>[1],
              obs.receipt, TRADE_INTENT_LIMITS).outcome !== "landed") { unverified = true; continue; }
        candidates.push({ kind: memberEqual ? (event.err === "0x00000000" ? "landed" : "landed-failed") : "superseded",
          txHash, obs, memberEqual, err: event.err });
      } catch { unverified = true; }
    }
    if (candidates.length > 0) { found = candidates; break; }
  }
  if (found.length === 0) return { kind: "hold", reason: unverified ? "candidate-unverified"
    : to > end ? "scan-window-exceeded" : "consuming-event-not-found" };
  if (new Set(found.map((candidate) => candidate.txHash.toLowerCase())).size !== 1) {
    return { kind: "hold", reason: "candidate-conflict" };
  }
  const selected = found[0]!;
  const disposition = selected.kind === "landed"
    ? "trade landed: advanced to COMMITTED from its verified orchestrator receipt"
    : selected.kind === "landed-failed"
      ? `trade landed and failed (err ${selected.err}): rolled back, nothing swapped`
      : `trade superseded: nonce ${nonce} consumed by ${selected.txHash}; this intent can never execute`;
  const evidence: JournalResolutionEvidence = {
    action: "resolveUnknown", at: nowMs, ownerAddress: agent.ownerAddress,
    observedBlock: finalized.number.toString(10), serverBlock: finalized.number.toString(10),
    checks: [
      { name: "nonce-gate", result: `${current} > ${nonce}` },
      { name: "window", result: `${from}..${to}` },
      { name: "candidate", result: `${selected.txHash} at ${selected.obs.receipt.blockNumber}` },
      { name: "member", result: `executionDataHash/keyHash equal: ${selected.memberEqual}` },
      { name: "event", result: `incremented=true, err=${selected.err}` },
    ], legs: [],
    logAbsence: { checked: false, detail: "positive evidence only: IntentExecuted(eoa, nonce) found and verified on the two-RPC pair" },
    disposition,
  };
  return { kind: selected.kind, txHash: selected.txHash, evidence };
}
