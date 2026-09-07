/**
 * Phase 3.9c-0 read-only RPC capability probe.
 *
 * This script sends JSON-RPC READS only. It never loads `.env`, never signs,
 * and never submits a transaction. Output intentionally contains endpoint
 * labels rather than URLs so a future credential-bearing candidate cannot be
 * copied into a report or log.
 */

import {
  BSC_MAINNET_CHAIN_ID,
  measureLpRpcCandidate,
  publicBscRpcCandidates,
  type LpRpcCallResult,
  type LpRpcCapabilityReport,
  type LpRpcTransaction,
} from "../src/lp/rpcCapabilities.js";

const PANCAKE_V3_NFPM = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";
const REFERENCE_MINT_TX = "0xbcda4671167080de46431cce6b90706149ba8988a60fdfe80c11258b3c1df4c0";
const RANGE_SPANS = [1, 50, 1_000, 10_000] as const;
const SEQUENTIAL_CHUNK_WIDTH = 50;
const SEQUENTIAL_CHUNK_COUNT = 3;
const TIMEOUT_MS = 12_000;

const selectedLabel = readOption("--label=");
const minimumIntervalMs = readIntegerOption("--min-interval-ms=") ?? 0;
const candidates = publicBscRpcCandidates().filter(
  (candidate) => selectedLabel === undefined || candidate.label === selectedLabel,
);
if (candidates.length === 0) {
  throw new Error(`No RPC candidate matches label ${selectedLabel ?? "(missing)"}.`);
}

const reports: LpRpcCapabilityReport[] = await Promise.all(
  candidates.map(async (candidate) =>
    measureLpRpcCandidate({
      candidate,
      referenceTxHash: REFERENCE_MINT_TX,
      logAddress: PANCAKE_V3_NFPM,
      rangeSpans: RANGE_SPANS,
      sequentialChunkWidth: SEQUENTIAL_CHUNK_WIDTH,
      sequentialChunkCount: SEQUENTIAL_CHUNK_COUNT,
      timeoutMs: TIMEOUT_MS,
      minimumIntervalMs,
    }),
  ),
);

const output = {
  schema: "4lpha-lp-rpc-capabilities/v2",
  safety: "read-only; not a runtime verdict or quorum configuration",
  chainIdExpected: BSC_MAINNET_CHAIN_ID.toString(10),
  referenceTxHash: REFERENCE_MINT_TX,
  logAddress: PANCAKE_V3_NFPM.toLowerCase(),
  rangeSpans: RANGE_SPANS,
  reports: reports.map(serializeReport),
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function serializeReport(report: LpRpcCapabilityReport): unknown {
  return {
    ...report,
    chainId: serializeCall(report.chainId),
    latestBlock: serializeCall(report.latestBlock),
    finalizedBlock: serializeCall(report.finalizedBlock),
    transaction: serializeTransactionCall(report.transaction),
    referenceFullBlock: serializeFullBlockCall(report.referenceFullBlock),
    receipt: serializeCall(report.receipt),
    finalizedBlockLogs: serializeLogCall(report.finalizedBlockLogs),
    exactBlockLogs: serializeLogCall(report.exactBlockLogs),
    ranges: report.ranges.map((range) => ({
      ...range,
      fromBlock: range.fromBlock.toString(10),
      toBlock: range.toBlock.toString(10),
      result: serializeLogCall(range.result),
    })),
    sequentialChunks: report.sequentialChunks.map((range) => ({
      ...range,
      fromBlock: range.fromBlock.toString(10),
      toBlock: range.toBlock.toString(10),
      result: serializeLogCall(range.result),
    })),
  };
}

function serializeTransactionCall(
  result: LpRpcCallResult<LpRpcTransaction>,
): unknown {
  if (!result.ok) return result;
  const { input: _rawInput, ...safe } = result.value;
  return { ok: true, latencyMs: result.latencyMs, value: stringifyBigints(safe) };
}

function serializeFullBlockCall(
  result: LpRpcCapabilityReport["referenceFullBlock"],
): unknown {
  if (!result.ok) return result;
  const referenceTransaction = result.value.referenceTransaction;
  const safeReference = referenceTransaction === null
    ? null
    : (({ input: _rawInput, ...safe }) => safe)(referenceTransaction);
  return {
    ok: true,
    latencyMs: result.latencyMs,
    value: stringifyBigints({ ...result.value, referenceTransaction: safeReference }),
  };
}

function serializeLogCall(
  result: LpRpcCallResult<readonly { readonly transactionHash: string; readonly logIndex: bigint }[]>,
): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    latencyMs: result.latencyMs,
    count: result.value.length,
    ids: result.value.map(
      (log) => `${log.transactionHash}:${log.logIndex.toString(10)}`,
    ),
  };
}

function serializeCall<T>(result: LpRpcCallResult<T>): unknown {
  if (!result.ok) return result;
  return { ...result, value: stringifyBigints(result.value) };
}

function stringifyBigints(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(stringifyBigints);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stringifyBigints(item)]),
    );
  }
  return value;
}

function readOption(prefix: string): string | undefined {
  const argument = process.argv.slice(2).find((candidate) => candidate.startsWith(prefix));
  if (argument === undefined) return undefined;
  const value = argument.slice(prefix.length).trim();
  if (value === "") throw new Error(`${prefix} requires a value.`);
  return value;
}

function readIntegerOption(prefix: string): number | undefined {
  const value = readOption(prefix);
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${prefix} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${prefix} is too large.`);
  return parsed;
}
