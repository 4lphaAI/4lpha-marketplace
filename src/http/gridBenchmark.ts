/** Reporting only: the original arm receipt, never a worker decision input. */
import { decodeAbiParameters, keccak256, stringToBytes, type Address, type Hex, type TransactionReceipt } from "viem";
import { getSqrtRatioAtTick, MIN_SQRT_RATIO, MAX_SQRT_RATIO, MIN_TICK, MAX_TICK } from "../lp/tickMath.js";
import type { LpPositionRecord, LpSequenceRecord } from "../store/lpSequences.js";
import type { LpSequenceStepOutcome } from "./lpWire.js";

export type GridArmBenchmarkInput = {
  readonly owner: Address; readonly agentId: string; readonly group: string;
  readonly txHash: Hex; readonly pool: Address; readonly wallet: Address;
  readonly token0: Address; readonly token1: Address; readonly wbnb: Address; readonly fee: number;
  readonly mintCount: 1 | 2; readonly capitalWei: string;
};
export type GridArmBenchmark = {
  readonly status: "ready"; readonly method: "arm-transaction-post-swap-v1";
  readonly txHash: Hex; readonly blockNumber: string; readonly blockHash: Hex;
  readonly armedAtMs: number; readonly pool: Address;
  readonly token0: Address; readonly token1: Address;
  readonly sqrtPriceX96: string; readonly capitalWei: string;
};
export type GridBenchmarkResult = GridArmBenchmark | {
  readonly status: "unavailable" | "pending"; readonly reason: string;
};
const unavailable = (reason: string): GridBenchmarkResult => ({ status: "unavailable", reason });
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,77}$/u;
const MAX_UINT256 = (1n << 256n) - 1n;
export const GRID_ARM_SWAP_TOPIC = keccak256(stringToBytes("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"));
const TRANSFER = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const topicAddress = (address: string): string => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function selectGridArmBenchmark(input: {
  readonly owner: Address; readonly agentId: string; readonly wallet: Address;
  readonly pool: Address; readonly token0: Address; readonly token1: Address; readonly wbnb: Address; readonly fee: number;
  readonly capitalWei: string | null;
  readonly positions: readonly Pick<LpPositionRecord, "agentId" | "ownerAddress" | "positionId" | "armGroupId" | "state" | "token0" | "token1" | "fee">[];
  readonly sequences: readonly Pick<LpSequenceRecord, "agentId" | "ownerAddress" | "positionId" | "kind" | "state" | "recoveryState" | "steps">[];
  readonly outcomes: ReadonlyMap<string, LpSequenceStepOutcome>;
  readonly nativeSpends: ReadonlyMap<string, bigint>;
}): GridArmBenchmarkInput | GridBenchmarkResult {
  const { capitalWei } = input;
  if (capitalWei === null || !DECIMAL.test(capitalWei) || BigInt(capitalWei) > MAX_UINT256) return unavailable("arm-capital-unavailable");
  const owned = input.positions.filter(p => p.agentId === input.agentId && same(p.ownerAddress, input.owner));
  const live = owned.filter(p => p.state !== "closed");
  if (live.length === 0) return unavailable("arm-unavailable");
  if (live.some(p => !same(p.token0, input.token0) || !same(p.token1, input.token1) || p.fee !== input.fee)) return unavailable("arm-pair-mismatch");
  const groups = new Set(live.map(p => p.armGroupId));
  if (groups.size !== 1 || (live[0]!.armGroupId === null && live.length !== 1)) return unavailable("arm-ambiguous");
  const group = live[0]!.armGroupId;
  const ancestors = new Set(owned.filter(p => group === null ? p.positionId === live[0]!.positionId : p.armGroupId === group).map(p => p.positionId));
  const arms = input.sequences.filter(s => s.agentId === input.agentId && same(s.ownerAddress, input.owner)
    && s.kind === "grid-arm" && ancestors.has(s.positionId));
  if (arms.length !== 1) return unavailable("arm-ambiguous");
  const arm = arms[0]!;
  if (arm.state !== "completed" || arm.recoveryState !== "none") return unavailable("arm-not-confirmed");
  const steps = arm.steps.filter(s => s.kind === "zap-in-mint");
  if (steps.some(s => { const o = input.outcomes.get(s.journalIdempotencyKey); return !o || o.unreadable || (o.state !== "COMMITTED" && o.state !== "ROLLED_BACK"); })) return unavailable("arm-not-confirmed");
  const committed = steps.filter(s => input.outcomes.get(s.journalIdempotencyKey)?.state === "COMMITTED");
  if (committed.length !== 1) return unavailable("arm-ambiguous");
  const key = committed[0]!.journalIdempotencyKey;
  const txHash = input.outcomes.get(key)?.txHash;
  if (!txHash || !HASH.test(txHash)) return unavailable("arm-not-confirmed");
  if (input.nativeSpends.get(key) !== BigInt(capitalWei)) return unavailable("arm-capital-mismatch");
  return { owner: input.owner, agentId: input.agentId, group: group ?? live[0]!.positionId,
    txHash: txHash as Hex, pool: input.pool, wallet: input.wallet, token0: input.token0,
    token1: input.token1, wbnb: input.wbnb, fee: input.fee, mintCount: group === null ? 1 : 2, capitalWei };
}

export function parseGridArmBenchmark(
  input: GridArmBenchmarkInput, nfpm: Address, receipt: TransactionReceipt,
  block: { readonly number: bigint; readonly hash: Hex; readonly timestamp: bigint }, finalized: bigint,
): GridArmBenchmark {
  const refuse = (): never => { throw new Error("arm-receipt-invalid"); };
  if (receipt.status !== "success" || !same(receipt.transactionHash, input.txHash)
    || !HASH.test(receipt.blockHash) || receipt.blockNumber < 0n || receipt.blockNumber > finalized
    || block.number !== receipt.blockNumber || !same(block.hash, receipt.blockHash)
    || block.timestamp < 0n || block.timestamp > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) refuse();
  if (same(input.token0, input.token1) || (same(input.token0, input.wbnb) === same(input.token1, input.wbnb))) refuse();
  const indices = new Set<number>();
  for (const log of receipt.logs) {
    if (log.removed || log.blockNumber !== receipt.blockNumber || log.blockHash === null || !same(log.blockHash, receipt.blockHash)
      || log.transactionHash === null || !same(log.transactionHash, input.txHash)
      || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || indices.has(log.logIndex)) refuse();
    indices.add(log.logIndex);
  }
  const mints = receipt.logs.filter(l => same(l.address, nfpm) && l.topics[0] === TRANSFER && l.topics[1] === ZERO_TOPIC);
  if (mints.length !== input.mintCount || mints.some(l => l.topics.length !== 4 || l.topics[2]?.toLowerCase() !== topicAddress(input.wallet)
    || !HASH.test(l.topics[3] ?? "") || BigInt(l.topics[3]!) <= 0n || l.data !== "0x")
    || new Set(mints.map(l => l.topics[3])).size !== mints.length) refuse();
  const swaps = receipt.logs.filter(l => l.topics[0] === GRID_ARM_SWAP_TOPIC);
  if (swaps.length !== 1) refuse();
  const swap = swaps[0]!;
  if (!same(swap.address, input.pool) || swap.topics.length !== 3 || !HASH.test(swap.topics[1] ?? "") || !HASH.test(swap.topics[2] ?? "")
    || swap.data.length !== 2 + 64 * 7 || mints.some(l => l.logIndex! <= swap.logIndex!)) refuse();
  const [amount0, amount1, sqrt, , tick] = decodeAbiParameters(
    [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint128" }, { type: "uint128" }], swap.data);
  if (sqrt < MIN_SQRT_RATIO || sqrt >= MAX_SQRT_RATIO || tick < MIN_TICK || tick >= MAX_TICK
    || sqrt < getSqrtRatioAtTick(tick) || sqrt > getSqrtRatioAtTick(tick + 1)
    || (same(input.token0, input.wbnb) ? amount0 <= 0n || amount1 >= 0n : amount1 <= 0n || amount0 >= 0n)) refuse();
  return { status: "ready", method: "arm-transaction-post-swap-v1", txHash: input.txHash,
    blockNumber: block.number.toString(), blockHash: block.hash, armedAtMs: Number(block.timestamp) * 1000,
    pool: input.pool, token0: input.token0, token1: input.token1, sqrtPriceX96: sqrt.toString(), capitalWei: input.capitalWei };
}

/** Pending work is retained, not repeatedly timed out and relaunched by polls. */
export function createGridBenchmarkCache(now: () => number = Date.now) {
  type Entry = { result: GridBenchmarkResult; pending: boolean; expires: number };
  const cache = new Map<string, Entry>();
  let active = 0;
  return {
    getOrStart(input: GridArmBenchmarkInput, read: ((input: GridArmBenchmarkInput) => Promise<GridArmBenchmark>) | undefined): GridBenchmarkResult {
      if (!read) return unavailable("arm-reader-unavailable");
      const key = JSON.stringify(input);
      const existing = cache.get(key);
      if (existing && (existing.pending || existing.expires > now())) return existing.result;
      if (existing) cache.delete(key);
      if (active >= 4) return { status: "pending", reason: "arm-evidence-loading" };
      if (cache.size >= 128) {
        const victim = [...cache].find(([, e]) => !e.pending);
        if (!victim) return { status: "pending", reason: "arm-evidence-loading" };
        cache.delete(victim[0]);
      }
      const entry: Entry = { result: { status: "pending", reason: "arm-evidence-loading" }, pending: true, expires: Infinity };
      cache.set(key, entry); active++;
      void Promise.resolve().then(() => read(input)).then(result => {
        entry.result = result; entry.expires = now() + 300_000;
      }, () => {
        entry.result = unavailable("arm-receipt-unavailable"); entry.expires = now() + 15_000;
      }).finally(() => { entry.pending = false; active--; });
      return entry.result;
    },
  };
}
