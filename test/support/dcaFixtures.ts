/**
 * Shared Auto DCA fixtures for the A2 suites: one NVDAB (stock = token0) agent
 * with a DCA grant, the signed DCA tuple, and a receipt builder that turns a
 * persisted plan into the orchestrator transaction and logs the chain would
 * produce for it (exits, swap, fee, mints), so a finish can be verified offline.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { WalletCall } from "../../src/core/types.js";
import { validateSessionSpec } from "../../src/core/session.js";
import { tradeSessionSpec } from "../../src/ops/policy.js";
import { NFPM_56 } from "../../src/ops/nfpm.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, WBNB_56 } from "../../src/ops/venues.js";
import { MemoryAgentStore, type AgentStatus } from "../../src/store/agents.js";
import { accountKeyHashForAddress } from "../../src/wallet/altana.js";
import { DEFAULT_TRADE_SETTINGS, parseTradeSettings, type EffectiveTradeSettings, type TradeSettings } from "../../src/trade/settings.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import { dcaPoolForToken, dcaPoolLegs, type DcaBatchPlan, type DcaPool } from "../../src/trade/dca.js";
import {
  DCA_NFPM_COLLECT_TOPIC,
  DCA_NFPM_DECREASE_TOPIC,
  DCA_NFPM_INCREASE_TOPIC,
  TRADFI_RECEIPT_INTENT_EXECUTED_TOPIC,
  TRADFI_RECEIPT_INTENT_SUCCESS,
  TRADFI_RECEIPT_ORCHESTRATOR_56,
  TRADFI_RECEIPT_SWAP_EXECUTED_TOPIC,
  TRADFI_RECEIPT_TRANSFER_TOPIC,
  type TradfiReceiptLog,
  type TradfiReceiptObservation,
} from "../../src/trade/receipt.js";
import { SESSION_KEY } from "./serverHarness.js";

export const E18 = 10n ** 18n;
export const OWNER: Address = getAddress("0x1111111111111111111111111111111111111111");
export const WALLET: Address = getAddress("0x2222222222222222222222222222222222222222");
export const GUARD: Address = getAddress("0x4444444444444444444444444444444444444444");
export const TREASURY: Address = getAddress("0x6666666666666666666666666666666666666666");
export const OUTSIDER: Address = getAddress("0x9999999999999999999999999999999999999999");
export const KEY = `0x04${"77".repeat(64)}` as Hex;
export const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
export const NV: DcaPool = dcaPoolForToken(NVDAB)!;
export const NV_TICK = 54_091;
export const AGENT_ID = "dca-agent";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** The mock's defaults as ruled (R2.16): base 15, order 10, max 4, step 1 %, TP 1.5 %, slippage 1 %. */
export function dcaSettings(patch: Partial<TradeSettings> = {}): TradeSettings {
  return {
    ...DEFAULT_TRADE_SETTINGS,
    name: "Auto DCA 01", executionModel: "tradfi", entryWei: "15000000000000000000",
    maxOpenPositions: 1, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
    breakEvenAfterTp: false, slippageBps: 100, crashProtection: false,
    settlementAsset: "USDT", minEntryWei: "15000000000000000000", capitalQuoteWei: "55000000000000000000",
    cmcNewsEnabled: false, tradeMode: "dca", dcaToken: NVDAB, dcaStepBps: 100, dcaStepMultiplierBps: 12000,
    dcaTakeProfitBps: 150, dcaOrderWei: "10000000000000000000", dcaMaxOrders: 4, dcaTriggerPriceE8: null,
    dcaRangeMinE8: null, dcaRangeMaxE8: null, dcaStopLossBps: null,
    ...patch,
  } as TradeSettings;
}

export function dcaEffective(patch: Partial<TradeSettings> = {}): EffectiveTradeSettings {
  const parsed = parseTradeSettings(dcaSettings(patch));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value.effective;
}

/** The §9.1 DCA grant (one stock, USDT cap, guard, NFPM) and a trade-v1 USDT hire. */
export async function dcaAgent(input: {
  readonly nowMs: number;
  readonly status?: AgentStatus;
  readonly remainingSec?: number;
  readonly grantedAgoSec?: number;
  readonly quoteDailyCapWei?: bigint | null;
  readonly agents?: MemoryAgentStore;
}) {
  const agents = input.agents ?? new MemoryAgentStore();
  const nowSec = Math.floor(input.nowMs / 1_000);
  const spec = tradeSessionSpec({
    venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, pancakeRouterV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 },
    tokens: [{ token: NV.stock }], nativeCaps: [{ limit: E18, period: "day" }], treasury: TREASURY, aggregatorGuard: GUARD,
    ...(input.quoteDailyCapWei === null ? {} : { quoteToken: USDT_56, quoteDailyCapWei: input.quoteDailyCapWei ?? 275n * E18,
      quotePerTradeCapWei: 15_150_000_000_000_000_000n }),
    platformFeeBps: 100, nfpm: NFPM_56, nowSeconds: nowSec, expiresAt: nowSec + (input.remainingSec ?? 6 * 86_400),
  });
  const agent = await agents.createAgent({
    id: AGENT_ID, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: input.status ?? "armed",
    sessionFacts: {
      spec, permissions: validateSessionSpec(spec, { nowSeconds: nowSec, minSessionSeconds: 0 }), publicKey: KEY, expiry: spec.expiresAt,
      grantedAtSec: nowSec - (input.grantedAgoSec ?? 86_400),
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT",
        minEntryWei: (15n * E18).toString(), entryWei: (15n * E18).toString(), quotePerTradeWei: "15150000000000000000",
        capitalQuoteWei: (55n * E18).toString() },
    },
  });
  await agents.putAgentSessionKey(OWNER, agent.id, SESSION_KEY);
  return { agents, agent, spec };
}

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

const EXECUTE_ABI = [{
  type: "function", name: "execute", stateMutability: "payable",
  inputs: [{ name: "encodedIntent", type: "bytes" }], outputs: [{ name: "err", type: "bytes4" }],
}] as const;
const INTENT_PARAMETERS = [{
  type: "tuple",
  components: [
    { name: "eoa", type: "address" }, { name: "executionData", type: "bytes" }, { name: "nonce", type: "uint256" },
    { name: "payer", type: "address" }, { name: "paymentToken", type: "address" }, { name: "paymentMaxAmount", type: "uint256" },
    { name: "combinedGas", type: "uint256" }, { name: "encodedPreCalls", type: "bytes[]" }, { name: "encodedFundTransfers", type: "bytes[]" },
    { name: "settler", type: "address" }, { name: "expiry", type: "uint256" }, { name: "isMultichain", type: "bool" },
    { name: "funder", type: "address" }, { name: "funderSignature", type: "bytes" }, { name: "settlerContext", type: "bytes" },
    { name: "paymentAmount", type: "uint256" }, { name: "paymentRecipient", type: "address" }, { name: "signature", type: "bytes" },
    { name: "paymentSignature", type: "bytes" }, { name: "supportedAccountImplementation", type: "address" },
  ],
}] as const;
const CALLS_PARAMETERS = [{
  type: "tuple[]",
  components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
}] as const;

function topic(address: Address): Hex { return padHex(address, { size: 32 }); }
function word(value: bigint): Hex { return toHex(value, { size: 32 }); }

export function transferLog(token: Address, from: Address, to: Address, value: bigint): Omit<TradfiReceiptLog, "logIndex"> {
  return { address: token, topics: [TRADFI_RECEIPT_TRANSFER_TOPIC, topic(from), topic(to)], data: word(value) };
}

export function nfpmLog(eventTopic: Hex, tokenId: bigint, a: bigint | Address, b: bigint, c: bigint): Omit<TradfiReceiptLog, "logIndex"> {
  const first = typeof a === "string" ? padHex(a, { size: 32 }) : word(a);
  return { address: NFPM_56, topics: [eventTopic, word(tokenId)], data: `0x${first.slice(2)}${word(b).slice(2)}${word(c).slice(2)}` as Hex };
}

export function nfpmMintLog(tokenId: bigint, to: Address): Omit<TradfiReceiptLog, "logIndex"> {
  return { address: NFPM_56, topics: [TRADFI_RECEIPT_TRANSFER_TOPIC, topic(ZERO), topic(to), word(tokenId)], data: "0x" };
}

export function guardLog(tokenIn: Address, tokenOut: Address, input: bigint, output: bigint, calldata: Hex): Omit<TradfiReceiptLog, "logIndex"> {
  return { address: GUARD, topics: [TRADFI_RECEIPT_SWAP_EXECUTED_TOPIC, topic(WALLET), topic(tokenIn), topic(tokenOut)],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [input, output, keccak256(calldata)]) };
}

/** The orchestrator transaction for ONE wallet intent carrying exactly `calls`, and its receipt with `logs`. */
export function dcaObservation(calls: readonly WalletCall[], logs: readonly Omit<TradfiReceiptLog, "logIndex">[], txHash: Hex = `0x${"aa".repeat(32)}`): TradfiReceiptObservation {
  const signature = (`0x${"00".repeat(8)}${accountKeyHashForAddress(publicKeyToAddress(KEY)).slice(2)}00`) as Hex;
  const executionData = encodeAbiParameters(CALLS_PARAMETERS, [calls.map((call) => ({ target: call.to, value: call.value ?? 0n, data: call.data ?? "0x" }))]);
  const intent = encodeAbiParameters(INTENT_PARAMETERS, [{
    eoa: WALLET, executionData, nonce: 7n, payer: ZERO, paymentToken: ZERO, paymentMaxAmount: 0n, combinedGas: 0n,
    encodedPreCalls: [], encodedFundTransfers: [], settler: ZERO, expiry: 0n, isMultichain: false, funder: ZERO,
    funderSignature: "0x", settlerContext: "0x", paymentAmount: 0n, paymentRecipient: ZERO, signature, paymentSignature: "0x",
    supportedAccountImplementation: ZERO,
  }]);
  const input = encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [intent] });
  const blockHash = `0x${"bb".repeat(32)}` as Hex;
  const all = [...logs, { address: TRADFI_RECEIPT_ORCHESTRATOR_56, topics: [TRADFI_RECEIPT_INTENT_EXECUTED_TOPIC, topic(WALLET), word(7n)],
    data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, TRADFI_RECEIPT_INTENT_SUCCESS]) }]
    .map((log, index) => ({ ...log, logIndex: BigInt(index) }));
  return {
    chainId: 56,
    transaction: { hash: txHash, to: TRADFI_RECEIPT_ORCHESTRATOR_56, input, blockNumber: 100n, blockHash, transactionIndex: 2n },
    receipt: { status: 1n, transactionHash: txHash, blockNumber: 100n, blockHash, transactionIndex: 2n, logs: all },
    receiptBlock: { number: 100n, hash: blockHash },
    finalizedBlock: { number: 110n, hash: `0x${"cc".repeat(32)}` as Hex },
  };
}

/**
 * The logs a landed plan produces: each exit collects its floors, the swap
 * pays `amountInWei` and returns `swapOutWei` (through the guard when the leg
 * carries one, else through the pinned pool), the fee reaches the treasury,
 * and the i-th mint is id `firstTokenId + i` depositing its desired leg.
 */
export function planLogs(plan: DcaBatchPlan, pool: DcaPool, input: { readonly firstTokenId: bigint; readonly swapOutWei?: bigint }): Omit<TradfiReceiptLog, "logIndex">[] {
  const legs = dcaPoolLegs(pool);
  const logs: Omit<TradfiReceiptLog, "logIndex">[] = [];
  for (const exit of plan.exits) {
    logs.push(nfpmLog(DCA_NFPM_DECREASE_TOPIC, exit.tokenId, exit.liquidity, exit.amount0Min, exit.amount1Min));
    logs.push(nfpmLog(DCA_NFPM_COLLECT_TOPIC, exit.tokenId, WALLET, exit.amount0Min, exit.amount1Min));
    if (exit.amount0Min > 0n) logs.push(transferLog(legs.token0, pool.pool, WALLET, exit.amount0Min));
    if (exit.amount1Min > 0n) logs.push(transferLog(legs.token1, pool.pool, WALLET, exit.amount1Min));
  }
  if (plan.swap !== null) {
    const tokenIn = plan.swap.side === "buy" ? USDT_56 : pool.stock;
    const tokenOut = plan.swap.side === "buy" ? pool.stock : USDT_56;
    const out = input.swapOutWei ?? plan.swap.minOutWei;
    const via = plan.swap.guard === undefined ? pool.pool : plan.swap.guard.address;
    logs.push(transferLog(tokenIn, WALLET, via, plan.swap.amountInWei));
    if (plan.swap.guard !== undefined) logs.push(guardLog(tokenIn, tokenOut, plan.swap.amountInWei, out, plan.swap.guard.calldata));
    logs.push(transferLog(tokenOut, via, WALLET, out));
  }
  if (plan.feeWei > 0n) logs.push(transferLog(USDT_56, WALLET, TREASURY, plan.feeWei));
  for (const [index, mint] of plan.mints.entries()) {
    const tokenId = input.firstTokenId + BigInt(index);
    logs.push(nfpmMintLog(tokenId, WALLET));
    logs.push(nfpmLog(DCA_NFPM_INCREASE_TOPIC, tokenId, mint.liquidity, mint.amount0Desired, mint.amount1Desired));
    const onToken0 = mint.amount0Desired > 0n;
    logs.push(transferLog(onToken0 ? legs.token0 : legs.token1, WALLET, pool.pool, onToken0 ? mint.amount0Desired : mint.amount1Desired));
  }
  return logs;
}

/**
 * Audit H-2: a loopback JSON-RPC endpoint for `createDcaChainReads`. Every call
 * fails at the transport (HTTP 503), or, given `revertReason`, reverts with
 * that `Error(string)` as the NFPM does for a burned id.
 */
export async function dcaRpcEndpoint(t: TestContext, revertReason?: string): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (revertReason === undefined) { response.writeHead(503).end(); return; }
      const { id } = JSON.parse(body) as { readonly id: number };
      const data = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], errorName: "Error", args: [revertReason] });
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: 3, message: `execution reverted: ${revertReason}`, data } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
