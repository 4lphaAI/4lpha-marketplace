/** AGENTIC-DCA 3.1: the real `createAgenticChain(...).poolState` over two loopback JSON-RPC stubs (no network): the decode, the common finalized block and the two-RPC agreement. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { encodeAbiParameters, toFunctionSelector, type Address } from "viem";
import { createAgenticChain } from "../src/agentic/resolve.js";

const POOL = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN0 = "0x55d398326f99059ff775485246999027b3197955" as Address;
const TOKEN1 = "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8" as Address;
const SELECTORS = {
  slot0: toFunctionSelector("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)"),
  token0: toFunctionSelector("function token0() view returns (address)"), token1: toFunctionSelector("function token1() view returns (address)"),
  fee: toFunctionSelector("function fee() view returns (uint24)"), tickSpacing: toFunctionSelector("function tickSpacing() view returns (int24)"),
};
type Stub = { chainId: number; head: number; tick: number; sqrt: bigint; fee: number; spacing: number; token0: Address };
const block = (n: number) => ({ number: "0x" + n.toString(16), hash: "0x" + n.toString(16).padStart(64, "0"), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32),
  logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), difficulty: "0x0",
  totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1", gasUsed: "0x0", timestamp: "0x1", transactions: [], uncles: [] });
function answer(stub: Stub, method: string, params: unknown[]): unknown {
  if (method === "eth_chainId") return "0x" + stub.chainId.toString(16);
  if (method === "eth_getBlockByNumber") return block(params[0] === "finalized" ? stub.head : parseInt(String(params[0]), 16));
  if (method === "eth_call") {
    const call = params[0] as { data?: string; input?: string }, data = (call.data ?? call.input ?? "").slice(0, 10);
    if (data === SELECTORS.slot0) return encodeAbiParameters([{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bool" }], [stub.sqrt, stub.tick, 0, 1, 1, 0, true]);
    if (data === SELECTORS.token0) return encodeAbiParameters([{ type: "address" }], [stub.token0]);
    if (data === SELECTORS.token1) return encodeAbiParameters([{ type: "address" }], [TOKEN1]);
    if (data === SELECTORS.fee) return encodeAbiParameters([{ type: "uint24" }], [stub.fee]);
    if (data === SELECTORS.tickSpacing) return encodeAbiParameters([{ type: "int24" }], [stub.spacing]);
  }
  throw new Error("unexpected " + method);
}
async function serve(stub: Stub): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      try { response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: answer(stub, call.method, call.params ?? []) })); }
      catch { response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "unsupported" } })); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const base = (patch: Partial<Stub> = {}): Stub => ({ chainId: 56, head: 100, tick: -23_028, sqrt: 79_228_162_514_264_337_593_543_950_336n, fee: 100, spacing: 1, token0: TOKEN0, ...patch });

test("CH1 poolState decodes slot0 and the immutables at the common finalized block", async t => {
  const a = await serve(base()), b = await serve(base());
  t.after(() => { a.server.close(); b.server.close(); });
  const state = await createAgenticChain([a.url, b.url]).poolState!(POOL);
  assert.deepEqual(state, { token0: TOKEN0, token1: TOKEN1, fee: 100, tickSpacing: 1, sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n, tick: -23_028, block: 100n });
});

test("CH2 two RPCs that disagree on the price, the pool shape or the chain fail closed; differing finalized heads read at the lower common block", async t => {
  for (const [patch, label] of [[{ tick: 5 }, "tick"], [{ sqrt: 1n }, "price"], [{ fee: 2500 }, "fee"], [{ spacing: 50 }, "spacing"], [{ token0: TOKEN1 }, "token order"], [{ chainId: 1 }, "chain"]] as const) {
    const a = await serve(base()), b = await serve(base(patch));
    try {
      await assert.rejects(createAgenticChain([a.url, b.url]).poolState!(POOL), /AGENTIC_RPC_DISAGREEMENT/u, label);
    } finally { a.server.close(); b.server.close(); }
  }
  const a = await serve(base()), b = await serve(base({ head: 101 }));
  t.after(() => { a.server.close(); b.server.close(); });
  assert.equal((await createAgenticChain([a.url, b.url]).poolState!(POOL)).block, 100n);
});

test("CH3 the chain refuses fewer than two distinct endpoints", () => {
  assert.throws(() => createAgenticChain(["http://127.0.0.1:1"]), /AGENTIC_RPC_REQUIREMENTS/u);
  assert.throws(() => createAgenticChain(["http://127.0.0.1:1", "http://127.0.0.1:1"]), /AGENTIC_RPC_REQUIREMENTS/u);
});
