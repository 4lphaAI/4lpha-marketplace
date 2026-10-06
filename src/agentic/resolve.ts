import { createPublicClient, http, keccak256, stringToBytes, parseAbi, decodeFunctionData, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { createTradfiV2ReceiptReader, type TradfiReceiptObservation } from "../trade/receipt.js";
import type { TradeReceiptFill } from "../trade/execute.js";
import type { ExecutionJournal, JournalResolutionEvidence } from "../store/journal.js";
import type { TradePositionStore } from "../store/tradePositions.js";
import { USDT_56 } from "../trade/settlement.js";
import { CMC_PERMIT2 } from "../trade/cmcCapability.js";
import { AGENTIC_RECEIPT_TAG, agenticAddress, type AgenticOrder, type AgenticFence } from "./domain.js";
import { type BawRunner, bawOrderId } from "./baw.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";
import { EARN_PRODUCTS, EARN_USDT, type EarnProtocol } from "./earnAdapter.js";
import { venusWei } from "./earn.js";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  "function symbol() view returns (string)", "function uiMultiplier() view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const TRANSFER = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const APPROVAL = keccak256(stringToBytes("Approval(address,address,uint256)"));
/** bStock companion event emitted with each bStock Transfer (3 topics, 2 data words), seen in buy tx 0x819312ad1a1df0b94411d74750ae895aaa7b9ea514d9504bd39631bddf040129 log 229. */
const BSTOCK_COMPANION_EVENT = "0x0226a2f5c1ae0e071aeec3d4ebafcefdc5c549be11f40ed27e76e802acccf374";
const V3_POOL = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)", "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)"]);
/** AGENTIC-EARN-SPEC 3.2: the supply-side reads of the two Earn products (vUSDT: balance x stored exchange rate; Aave aToken: balance), and the pin reads that name each receipt token's underlying and pool. */
const EARN_ABI = parseAbi(["function underlying() view returns (address)", "function UNDERLYING_ASSET_ADDRESS() view returns (address)", "function POOL() view returns (address)",
  "function exchangeRateStored() view returns (uint256)"]);
/** The Aave v3 `getReserveData` return struct; `aTokenAddress` is word 8 of the return data counted from zero (word 9 is the stable debt token). */
const AAVE_POOL = [{ type: "function", name: "getReserveData", stateMutability: "view", inputs: [{ name: "asset", type: "address" }],
  outputs: [{ type: "tuple", components: [{ name: "configuration", type: "uint256" }, { name: "liquidityIndex", type: "uint128" }, { name: "currentLiquidityRate", type: "uint128" },
    { name: "variableBorrowIndex", type: "uint128" }, { name: "currentVariableBorrowRate", type: "uint128" }, { name: "currentStableBorrowRate", type: "uint128" },
    { name: "lastUpdateTimestamp", type: "uint40" }, { name: "id", type: "uint16" }, { name: "aTokenAddress", type: "address" }, { name: "stableDebtTokenAddress", type: "address" },
    { name: "variableDebtTokenAddress", type: "address" }, { name: "interestRateStrategyAddress", type: "address" }, { name: "accruedToTreasury", type: "uint128" },
    { name: "unbacked", type: "uint128" }, { name: "isolationModeTotalDebt", type: "uint128" }] }] }] as const;
export type AgenticReceipt = { observation: TradfiReceiptObservation; from: Address; to: Address; input: Hex };
/** Both RPCs agreed on every value at one common finalized block (rule 8). */
export type AgenticEarnBalances = { block: bigint; usdt: bigint; vBalance: bigint; vRate: bigint; venusWei: bigint; aaveWei: bigint };
export type AgenticEarnPins = Readonly<Record<EarnProtocol, boolean>>;
/** A pinned Pancake V3 pool read on the two RPCs at their common finalized block (Agentic DCA, AGENTIC-DCA-SPEC 3.1). */
export type AgenticPoolState = { token0: Address; token1: Address; fee: number; tickSpacing: number; sqrtPriceX96: bigint; tick: number; block: bigint };
export type AgenticChain = {
  balance(W: Address, token: Address | null): Promise<bigint>;
  metadata(token: Address): Promise<{ decimals: number; symbol: string }>;
  multiplier(token: Address): Promise<bigint>;
  code(W: Address): Promise<Hex>;
  nonce(W: Address): Promise<bigint>;
  receipt(hash: Hex): Promise<AgenticReceipt | null>;
  /** Optional so the Agentic AI and Schedule fixtures stay valid; a missing method is a failed pool read for the DCA lane (fail closed). */
  poolState?(pool: Address): Promise<AgenticPoolState>;
  /** Optional for the same reason; a missing or throwing method is a failed read for Earn (no action, the sign-out waits). */
  earnBalances?(W: Address): Promise<AgenticEarnBalances>;
  earnPins?(): Promise<AgenticEarnPins>;
};

export function createAgenticChain(rpcUrls: readonly string[]): AgenticChain {
  const urls = rpcUrls.slice(0, 2);
  if (new Set(urls).size !== 2) throw new Error("AGENTIC_RPC_REQUIREMENTS");
  const clients = urls.map(url => createPublicClient({ chain: bsc, transport: http(url, { timeout: 15_000, retryCount: 0 }) }));
  const reader = createTradfiV2ReceiptReader({ rpcUrls: urls });
  async function block(): Promise<bigint> {
    const ids = await Promise.all(clients.map(c => c.getChainId()));
    if (ids.some(id => id !== 56)) throw new Error("AGENTIC_RPC_DISAGREEMENT");
    const heads = await Promise.all(clients.map(c => c.getBlock({ blockTag: "finalized" })));
    if (heads.some(h => typeof h.number !== "bigint" || h.hash == null)) throw new Error("AGENTIC_RPC_DISAGREEMENT");
    const number = heads.reduce((n, h) => h.number! < n ? h.number! : n, heads[0]!.number!);
    const common = await Promise.all(clients.map(c => c.getBlock({ blockNumber: number })));
    if (common.some(b => b.number !== number || b.hash == null || b.hash !== common[0]!.hash)) throw new Error("AGENTIC_RPC_DISAGREEMENT");
    return number;
  }
  function agree<T extends string | number | bigint>(values: T[]): T {
    if (values.length !== 2 || values[0] !== values[1]) throw new Error("AGENTIC_RPC_DISAGREEMENT");
    return values[0]!;
  }
  return {
    async balance(W, token) { const n = await block(); return agree(await Promise.all(clients.map(c => token === null
      ? c.getBalance({ address: W, blockNumber: n }) : c.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [W], blockNumber: n })))); },
    async metadata(token) { const n = await block(); const decimals = agree(await Promise.all(clients.map(c => c.readContract({ address: token, abi: ERC20, functionName: "decimals", blockNumber: n }))));
      const symbol = agree(await Promise.all(clients.map(c => c.readContract({ address: token, abi: ERC20, functionName: "symbol", blockNumber: n })))); return { decimals, symbol }; },
    async multiplier(token) { const n = await block(); return agree(await Promise.all(clients.map(c => c.readContract({ address: token, abi: ERC20, functionName: "uiMultiplier", blockNumber: n })))); },
    async code(W) { const n = await block(); return agree(await Promise.all(clients.map(async c => await c.getCode({ address: W, blockNumber: n }) ?? "0x"))); },
    async nonce(W) { const n = await block(); return BigInt(agree(await Promise.all(clients.map(c => c.getTransactionCount({ address: W, blockNumber: n }))))); },
    async poolState(pool) {
      const n = await block();
      const read = async <T extends string | number | bigint>(work: (c: (typeof clients)[number]) => Promise<T>): Promise<T> => agree(await Promise.all(clients.map(work)));
      const slots = await Promise.all(clients.map(c => c.readContract({ address: pool, abi: V3_POOL, functionName: "slot0", blockNumber: n })));
      const sqrtPriceX96 = agree(slots.map(slot => slot[0])), tick = agree(slots.map(slot => Number(slot[1])));
      return { token0: agenticAddress(await read(c => c.readContract({ address: pool, abi: V3_POOL, functionName: "token0", blockNumber: n }))),
        token1: agenticAddress(await read(c => c.readContract({ address: pool, abi: V3_POOL, functionName: "token1", blockNumber: n }))),
        fee: await read(c => c.readContract({ address: pool, abi: V3_POOL, functionName: "fee", blockNumber: n })),
        tickSpacing: await read(c => c.readContract({ address: pool, abi: V3_POOL, functionName: "tickSpacing", blockNumber: n })),
        sqrtPriceX96, tick, block: n };
    },
    async earnBalances(W) {
      const n = await block();
      const venus = EARN_PRODUCTS.find(p => p.protocol === "venus")!.receiptToken, aave = EARN_PRODUCTS.find(p => p.protocol === "aave-v3")!.receiptToken;
      const read = async (address: Address, functionName: "balanceOf", args: [Address]): Promise<bigint> => agree(await Promise.all(clients.map(c =>
        c.readContract({ address, abi: ERC20, functionName, args, blockNumber: n }))));
      const usdt = await read(EARN_USDT, "balanceOf", [W]), vBalance = await read(venus, "balanceOf", [W]), aaveWei = await read(aave, "balanceOf", [W]);
      const vRate = agree(await Promise.all(clients.map(c => c.readContract({ address: venus, abi: EARN_ABI, functionName: "exchangeRateStored", blockNumber: n }))));
      return { block: n, usdt, vBalance, vRate, venusWei: venusWei(vBalance, vRate), aaveWei };
    },
    async earnPins() {
      const n = await block();
      const venus = EARN_PRODUCTS.find(p => p.protocol === "venus")!, aave = EARN_PRODUCTS.find(p => p.protocol === "aave-v3")!;
      const same = async (work: (c: (typeof clients)[number]) => Promise<string>): Promise<string | null> => {
        try { return agenticAddress(agree(await Promise.all(clients.map(work)))); } catch { return null; }
      };
      const venusOk = await same(c => c.readContract({ address: venus.receiptToken, abi: EARN_ABI, functionName: "underlying", blockNumber: n })) === EARN_USDT;
      const aaveOk = await same(c => c.readContract({ address: aave.receiptToken, abi: EARN_ABI, functionName: "UNDERLYING_ASSET_ADDRESS", blockNumber: n })) === EARN_USDT
        && await same(c => c.readContract({ address: aave.receiptToken, abi: EARN_ABI, functionName: "POOL", blockNumber: n })) === aave.pool
        && await same(async c => (await c.readContract({ address: aave.pool!, abi: AAVE_POOL, functionName: "getReserveData", args: [EARN_USDT], blockNumber: n })).aTokenAddress) === aave.receiptToken;
      return { venus: venusOk, "aave-v3": aaveOk };
    },
    async receipt(hash) {
      try {
        const observation = await reader.readFinalized(hash);
        if (observation === null) return null;
        const txs = await Promise.all(clients.map(c => c.getTransaction({ hash })));
        const first = txs[0]!;
        if (first.to === null || txs.some(t => t.from.toLowerCase() !== first.from.toLowerCase() || t.to?.toLowerCase() !== first.to?.toLowerCase()
          || t.input !== first.input || t.blockHash !== observation.receipt.blockHash || t.blockNumber !== observation.receipt.blockNumber
          || t.hash.toLowerCase() !== hash.toLowerCase())) return null;
        return { observation, from: agenticAddress(first.from), to: agenticAddress(first.to), input: first.input };
      } catch { return null; }
    },
  };
}

export async function verifyAgenticSwap(chain: AgenticChain, order: AgenticOrder, hash: Hex, partial = false): Promise<{
  fill: TradeReceiptFill; input: bigint; output: bigint; evidence: AgenticReceipt;
} | null> {
  const proof = await chain.receipt(hash);
  if (proof === null || agenticAddress(proof.from) !== agenticAddress(order.walletAddress) || proof.observation.receipt.status !== 1n || order.fromToken === null || order.toToken === null) return null;
  const fromToken = agenticAddress(order.fromToken), toToken = agenticAddress(order.toToken);
  const walletTopic = "0x" + order.walletAddress.slice(2).toLowerCase().padStart(64, "0");
  let input = 0n, output = 0n;
  let index: bigint | null = null;
  for (const log of proof.observation.receipt.logs) {
    if (!log.topics.some(t => t.toLowerCase() === walletTopic)) continue;
    const token = agenticAddress(log.address);
    if (log.removed === true || token !== fromToken && token !== toToken) return null;
    if (log.topics[0]?.toLowerCase() === BSTOCK_COMPANION_EVENT) {
      if (log.topics.length !== 3 || !/^0x[0-9a-f]{128}$/i.test(log.data)) return null;
      continue; // an accompanying record, never an input or an output
    }
    if (log.topics[0] !== TRANSFER && log.topics[0] !== APPROVAL || log.topics.length !== 3 || !/^0x[0-9a-f]{64}$/i.test(log.data)) return null;
    if (log.topics[0] !== TRANSFER) continue;
    const amount = BigInt(log.data);
    if (token === fromToken && log.topics[1]?.toLowerCase() === walletTopic) input += amount;
    if (token === toToken && log.topics[2]?.toLowerCase() === walletTopic) { output += amount; index ??= log.logIndex; }
  }
  const intended = BigInt(order.side === "sell" ? order.intendedRaw! : order.amountAtomic!);
  if (input <= 0n || output <= 0n || index === null || (!partial && input !== intended) || partial && input > intended) return null;
  const key = `56|${hash.toLowerCase()}|${order.walletAddress.toLowerCase()}|${index}|${AGENTIC_RECEIPT_TAG}`;
  return { input, output, evidence: proof, fill: order.side === "buy"
    ? { side: "buy", entryWei: input, tokenAmount: output, fillStatus: "verified", receiptAttributable: true, verifiedEntryAtomic: input, receiptOwnershipKey: key }
    : { side: "sell", exitWei: output, fillStatus: "verified", receiptOwnershipKey: key } };
}

/** Display only: the raw bStock quantity a COMMITTED swap moved, re-read from the receipt stored with it (the Transfer logs
 *  `verifyAgenticSwap` summed): received for a buy, sent for a sell. Null when the order is not committed or carries no receipt. */
export function agenticExecutedQuantity(order: AgenticOrder | undefined): bigint | null {
  if (order?.outcome !== "committed" || order.fromToken === null || order.toToken === null || order.side === null) return null;
  // A resolver commit stores the receipt itself; an operator disposition (scripts/agentic-gate.ts dispose) stores it under `proof`.
  type Stored = { observation?: { receipt?: { logs?: unknown } } };
  const evidence = order.evidence as (Stored & { proof?: Stored }) | null;
  const logs = (evidence?.observation ?? evidence?.proof?.observation)?.receipt?.logs;
  if (!Array.isArray(logs)) return null;
  const token = order.side === "buy" ? order.toToken : order.fromToken;
  const walletTopic = "0x" + order.walletAddress.slice(2).toLowerCase().padStart(64, "0");
  let quantity = 0n;
  for (const log of logs as ({ address?: unknown; topics?: unknown; data?: unknown; removed?: unknown } | null)[]) {
    if (log === null || typeof log !== "object" || log.removed === true || typeof log.address !== "string" || !Array.isArray(log.topics) || log.topics.length !== 3 || typeof log.data !== "string"
      || !/^0x[0-9a-f]{64}$/iu.test(log.data) || String(log.topics[0]).toLowerCase() !== TRANSFER.toLowerCase() || log.address.toLowerCase() !== token.toLowerCase()) continue;
    if (String(log.topics[order.side === "buy" ? 2 : 1]).toLowerCase() === walletTopic) quantity += BigInt(log.data);
  }
  return quantity > 0n ? quantity : null;
}

export async function verifyAgenticApproval(chain: AgenticChain, W: Address, hash: Hex): Promise<AgenticReceipt | null> {
  const proof = await chain.receipt(hash);
  if (proof === null || agenticAddress(proof.from) !== agenticAddress(W) || agenticAddress(proof.to) !== agenticAddress(USDT_56) || ![0n, 1n].includes(proof.observation.receipt.status)) return null;
  try { const decoded = decodeFunctionData({ abi: ERC20, data: proof.input });
    return decoded.functionName === "approve" && agenticAddress(decoded.args[0] as Address) === agenticAddress(CMC_PERMIT2) ? proof : null;
  } catch { return null; }
}

export function agenticResolutionEvidence(order: AgenticOrder, at: number, disposition: string, proof?: AgenticReceipt): JournalResolutionEvidence {
  return { action: "resolveUnknown", at, ownerAddress: order.walletAddress,
    observedBlock: proof?.observation.receipt.blockNumber.toString() ?? "0", serverBlock: proof?.observation.finalizedBlock.number.toString() ?? null,
    checks: [{ name: "agentic-dispatch", result: disposition }, ...(proof === undefined ? [] : [
      { name: "finalized-two-rpc", result: proof.observation.receipt.blockHash }, { name: "sender", result: proof.from }])],
    legs: [], logAbsence: { checked: false, detail: "not-used" }, disposition };
}

export async function terminalizeAgenticOrder(store: AgenticStore, journal: ExecutionJournal, row: AgenticOrder): Promise<AgenticOrder | null> {
  if (row.outcome !== "open" || !["sealed", "not-started"].includes(row.dispatch)) return row;
  if (row.kind === "swap") {
    const entry = await journal.get(row.idempotencyKey);
    if (entry === null) throw new Error("AGENTIC_JOURNAL_MISSING");
    if (entry.state === "COMMITTED") { console.error("agentic_sealed_but_committed", row.idempotencyKey); return store.patchOrder(row, { holdReason: "sealed-but-committed" }); }
    if (entry.state === "UNKNOWN") await journal.resolveUnknown(row.idempotencyKey, agenticResolutionEvidence(row, await store.now(), "dispatch-" + row.dispatch));
    else if (entry.state !== "ROLLED_BACK") await journal.markRolledBack(row.idempotencyKey, "dispatch-" + row.dispatch);
  }
  return store.patchOrder(row, { outcome: "rolled-back" });
}

export async function agenticList(runner: BawRunner, store: AgenticStore, master: Buffer, agentId: string, f: AgenticFence,
  args: readonly string[]): Promise<{ rows: Record<string, unknown>[]; total: number } | null> {
  const wallet = await store.byAgent(agentId);
  if (wallet === null || !["bound", "ending", "hiring"].includes(wallet.state) || wallet.sessionCiphertext === null) return null;
  const rows: Record<string, unknown>[] = [];
  let total = 0;
  for (let page = 1; page <= 5; page += 1) {
    if (await store.renewFence(f) === null) return null;
    const result = await runner.run(["market-order", "list", ...args, "--binanceChainId", "56", "--page", String(page), "--pageSize", "100"], decryptAgenticSession(wallet, master));
    if (result.kind !== "ok" || typeof result.data !== "object" || result.data === null) return null;
    const data = result.data as { total: number; page: number; pageSize: number; list: Record<string, unknown>[] };
    if (data.total > 500 || data.page !== page || data.pageSize !== 100) return null;
    total = data.total; rows.push(...data.list);
    if (page * 100 >= total) return rows.length >= total ? { rows, total } : null;
  }
  return null;
}

export async function resolveAgenticOrder(input: { store: AgenticStore; journal: ExecutionJournal; chain: AgenticChain;
  runner: BawRunner; masterKey: Buffer; order: AgenticOrder; fence: AgenticFence; positions: Pick<TradePositionStore, "insertRun"> }): Promise<TradeReceiptFill | null> {
  const { store, journal, chain, runner, masterKey, fence } = input;
  let row = await store.getOrder(input.order.idempotencyKey);
  if (row === null) return null;
  if (row.dispatch === "unclaimed" && (row.quoteAt === null || row.quoteAt < await store.now() - 30_000)) {
    row = await store.patchOrder(row, { dispatch: "sealed" });
  }
  if (row === null) return null;
  if (["sealed", "not-started"].includes(row.dispatch)) { await terminalizeAgenticOrder(store, journal, row); return null; }
  // AGENTIC-EARN-SPEC R11.9: an earn row is held and resolved only by the earn step (earnLane.ts); a stale unclaimed one was still sealed above.
  if (row.kind === "earn-deposit" || row.kind === "earn-redeem") return null;
  if (row.kind !== "swap") {
    if (row.outcome === "open" && row.dispatch === "spawned" && row.holdReason === null) await store.patchOrder(row, {
      holdReason: row.response === null || row.response === "no-response" ? "no-response" : "sign-recovery" });
    return null;
  }
  if (row.outcome === "rolled-back") return null;
  const journalEntry = await journal.get(row.idempotencyKey);
  const committedHash = row.txHash ?? journalEntry?.externalRef.txHash ?? null;
  if (journalEntry?.state === "COMMITTED" && committedHash !== null) {
    if ((await store.orders()).some(o => o.idempotencyKey !== row!.idempotencyKey && o.txHash === committedHash)) {
      await store.patchOrder(row, { holdReason: "tx-already-bound" }); return null;
    }
    if (row.outcome === "open" && (row.response === null || row.response === "no-response") && row.evidence === null) {
      await store.patchOrder(row, { holdReason: "disposition-repair" }); return null;
    }
    const partial = typeof row.evidence === "object" && row.evidence !== null && "disposition" in row.evidence && row.evidence.disposition === "commit-partial";
    const recovered = await verifyAgenticSwap(chain, row, committedHash, partial);
    if (recovered === null) return null;
    if (row.outcome !== "committed" || row.fillCheck === "pending") {
      const completed = await store.completeFill(row, row.evidence ?? recovered.evidence, recovered.output, committedHash);
      if (completed !== null && row.minOutAtomic !== null && recovered.output < BigInt(row.minOutAtomic)) await input.positions.insertRun({ agentId: row.agentId,
        ownerAddress: row.walletAddress, dryRun: false, reason: "agentic-fill-check", events: [{ stage: row.side === "buy" ? "buy" : "sell", code: "fill-below-minimum",
          elapsedMs: 0, token: row.side === "buy" ? row.toToken! : row.fromToken!, reason: `out=${recovered.output} min=${row.minOutAtomic}` }] });
    }
    return recovered.fill;
  }
  if (row.response === null || row.response === "no-response") { await store.patchOrder(row, { holdReason: "no-response" }); return null; }
  if (row.holdReason !== null && row.holdReason !== "no-list-row") return null;
  if (row.listSnapshot === null) return null;
  const listed = await agenticList(runner, store, masterKey, row.agentId, fence, ["--startTime", String(row.listSnapshot.startTimeMs), "--fromToken", row.fromToken!, "--toToken", row.toToken!]);
  if (listed === null) return null;
  const bound = (await store.orders(row.walletAddress)).filter(o => o.idempotencyKey !== row!.idempotencyKey).map(o => o.listedOrderId);
  const candidates = listed.rows.filter(r => !row!.listSnapshot!.ids.includes(bawOrderId(r["orderId"])!) && !bound.includes(bawOrderId(r["orderId"])));
  if (candidates.length === 0) { if (await store.now() - row.createdAt >= 1_800_000) await store.patchOrder(row, { holdReason: "no-list-row" }); return null; }
  if (candidates.length !== 1) { await store.patchOrder(row, { holdReason: "multiple-new-rows" }); return null; }
  const match = candidates[0]!;
  row = await store.patchOrder(row, { listedOrderId: bawOrderId(match["orderId"]), holdReason: null });
  if (row === null) return null;
  if (match["status"] === "PENDING") return null;
  const hash = typeof match["txHash"] === "string" && /^0x[0-9a-f]{64}$/i.test(match["txHash"]) ? match["txHash"].toLowerCase() as Hex : null;
  if (match["status"] === "FINISHED" && hash !== null) {
    if ((await store.orders()).some(o => o.idempotencyKey !== row!.idempotencyKey && o.txHash === hash)) { await store.patchOrder(row, { holdReason: "tx-already-bound" }); return null; }
    const fill = await verifyAgenticSwap(chain, row, hash);
    if (fill === null) {
      const partial = row.side === "sell" ? await verifyAgenticSwap(chain, row, hash, true) : null;
      await store.patchOrder(row, { holdReason: partial !== null && partial.input < BigInt(row.intendedRaw!) ? "partial-sell" : "chain-verification" }); return null;
    }
    const entry = await journal.get(row.idempotencyKey);
    if (entry?.state === "UNKNOWN") await journal.advanceUnknown(row.idempotencyKey, agenticResolutionEvidence(row, await store.now(), "chain-verified", fill.evidence), { txHash: hash });
    else if (entry?.state !== "COMMITTED") await journal.markCommitted(row.idempotencyKey, { txHash: hash });
    const completed = await store.completeFill(row, fill.evidence, fill.output, hash);
    if (completed === null) return null;
    if (row.minOutAtomic !== null && fill.output < BigInt(row.minOutAtomic)) await input.positions.insertRun({ agentId: row.agentId,
      ownerAddress: row.walletAddress, dryRun: false, reason: "agentic-fill-check", events: [{ stage: row.side === "buy" ? "buy" : "sell", code: "fill-below-minimum",
        elapsedMs: 0, token: row.side === "buy" ? row.toToken! : row.fromToken!, reason: `out=${fill.output} min=${row.minOutAtomic}` }] });
    return fill.fill;
  }
  if (match["status"] === "FAILED") {
    const proof = hash === null ? null : await chain.receipt(hash);
    const rollback = hash === null && row.response === "rejected" || proof !== null && proof.from === row.walletAddress && proof.observation.receipt.status === 0n;
    if (!rollback) { await store.patchOrder(row, { holdReason: "accepted-then-failed" }); return null; }
    const entry = await journal.get(row.idempotencyKey);
    if (entry?.state === "UNKNOWN") await journal.resolveUnknown(row.idempotencyKey, agenticResolutionEvidence(row, await store.now(), hash === null ? "binance-rejected" : "landed-reverted", proof ?? undefined));
    else if (entry?.state !== "ROLLED_BACK") await journal.markRolledBack(row.idempotencyKey, "binance-rejected");
    await store.patchOrder(row, { outcome: "rolled-back", evidence: proof ?? { code: "binance-rejected" } });
  }
  return null;
}
