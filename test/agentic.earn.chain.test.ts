/** AGENTIC-EARN-SPEC 3.2 and 3.3: the real `createAgenticChain(...).earnBalances` and `earnPins` over two loopback JSON-RPC stubs (no network): the two-RPC agreement at one finalized block, the Compound valuation,
 *  the Aave reserve word 8 and the fail-closed pin reads. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { toFunctionSelector, type Address, type Hex } from "viem";
import { createAgenticChain } from "../src/agentic/resolve.js";
import { EARN_PRODUCTS, EARN_USDT } from "../src/agentic/earnAdapter.js";

const W = "0x1111111111111111111111111111111111111111" as Address;
const [VENUS, AAVE] = [EARN_PRODUCTS[0]!.receiptToken, EARN_PRODUCTS[1]!.receiptToken], POOL = EARN_PRODUCTS[1]!.pool!;
const S = { balanceOf: toFunctionSelector("function balanceOf(address) view returns (uint256)"), rate: toFunctionSelector("function exchangeRateStored() view returns (uint256)"),
  underlying: toFunctionSelector("function underlying() view returns (address)"), aUnderlying: toFunctionSelector("function UNDERLYING_ASSET_ADDRESS() view returns (address)"),
  pool: toFunctionSelector("function POOL() view returns (address)"), reserve: toFunctionSelector("function getReserveData(address) view returns (uint256)") };
type Stub = { chainId: number; head: number; usdt: bigint; vBalance: bigint; aBalance: bigint; rate: bigint; underlying: Address; aUnderlying: Address; aPool: Address; reserveAToken: Address; fail?: string };
const block = (n: number) => ({ number: "0x" + n.toString(16), hash: "0x" + n.toString(16).padStart(64, "0"), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32),
  logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), difficulty: "0x0",
  totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1", gasUsed: "0x0", timestamp: "0x1", transactions: [], uncles: [] });
const word = (v: bigint): string => v.toString(16).padStart(64, "0"), addr = (a: string): string => word(BigInt(a));
function answer(stub: Stub, method: string, params: unknown[]): unknown {
  if (method === "eth_chainId") return "0x" + stub.chainId.toString(16);
  if (method === "eth_getBlockByNumber") return block(params[0] === "finalized" ? stub.head : parseInt(String(params[0]), 16));
  if (method === "eth_call") {
    const call = params[0] as { to: string; data?: string; input?: string }, data = (call.data ?? call.input ?? ""), selector = data.slice(0, 10), to = call.to.toLowerCase();
    if (selector === S.balanceOf) return "0x" + word(to === EARN_USDT ? stub.usdt : to === VENUS ? stub.vBalance : stub.aBalance);
    if (selector === S.rate) return "0x" + word(stub.rate);
    if (selector === S.underlying) return "0x" + addr(stub.underlying);
    if (selector === S.aUnderlying) return "0x" + addr(stub.aUnderlying);
    if (selector === S.pool) return "0x" + addr(stub.aPool);
    if (data.slice(0, 10) === toFunctionSelector("function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))")) {
      const words = Array.from({ length: 15 }, () => word(0n)); words[8] = addr(stub.reserveAToken); words[9] = addr("0x57e9d8d3c1b6e2a4f06d8a7c94ef5b8a1c2d3f64"); return "0x" + words.join("");
    }
  }
  throw new Error("unexpected " + method);
}
async function serve(stub: Stub): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      try { if (stub.fail === call.method) throw new Error("down"); response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: answer(stub, call.method, call.params ?? []) })); }
      catch { response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "unsupported" } })); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const base = (patch: Partial<Stub> = {}): Stub => ({ chainId: 56, head: 100, usdt: 40n * 10n ** 18n, vBalance: 2_000_000_000n, aBalance: 5n * 10n ** 18n, rate: 265_390_590_559_184_646_645_209_898n,
  underlying: EARN_USDT, aUnderlying: EARN_USDT, aPool: POOL, reserveAToken: AAVE, ...patch });
const pair = async (t: { after(fn: () => void): void }, a: Partial<Stub> = {}, b: Partial<Stub> = {}) => { const x = await serve(base(a)), y = await serve(base(b)); t.after(() => { x.server.close(); y.server.close(); }); return createAgenticChain([x.url, y.url]); };

test("EC1 earnBalances reads USDT, the vUSDT balance and stored exchange rate and the aToken balance at one finalized block; venus value = balance x rate / 1e18", async t => {
  const b = await (await pair(t)).earnBalances!(W);
  assert.deepEqual([b.block, b.usdt, b.vBalance, b.aaveWei], [100n, 40n * 10n ** 18n, 2_000_000_000n, 5n * 10n ** 18n]);
  assert.equal(b.venusWei, 2_000_000_000n * 265_390_590_559_184_646_645_209_898n / 10n ** 18n);
  assert.equal(b.venusWei, 530_781_181_118_369_293n, "about 0.53 USDT for 20 vUSDT (8 decimals) at the measured rate");
});

test("EC2 two RPCs that disagree on any value, or on the chain, fail closed; differing finalized heads read at the lower common block", async t => {
  for (const [patch, label] of [[{ usdt: 1n }, "usdt"], [{ vBalance: 1n }, "vBalance"], [{ aBalance: 1n }, "aave"], [{ rate: 1n }, "rate"], [{ chainId: 1 }, "chain"]] as const) {
    await assert.rejects((await pair(t, {}, patch)).earnBalances!(W), /AGENTIC_RPC_DISAGREEMENT/u, label);
  }
  assert.equal((await (await pair(t, { head: 100 }, { head: 105 })).earnBalances!(W)).block, 100n);
});

test("EC3 earnPins: both products pass on a matching chain; each failed identity check closes only its product; an unreachable RPC closes a product instead of throwing", async t => {
  assert.deepEqual(await (await pair(t)).earnPins!(), { venus: true, "aave-v3": true });
  const wrong = "0x3333333333333333333333333333333333333333" as Address;
  assert.deepEqual(await (await pair(t, { underlying: wrong }, { underlying: wrong })).earnPins!(), { venus: false, "aave-v3": true });
  assert.deepEqual(await (await pair(t, { aUnderlying: wrong }, { aUnderlying: wrong })).earnPins!(), { venus: true, "aave-v3": false });
  assert.deepEqual(await (await pair(t, { aPool: wrong }, { aPool: wrong })).earnPins!(), { venus: true, "aave-v3": false });
  assert.deepEqual(await (await pair(t, { reserveAToken: wrong }, { reserveAToken: wrong })).earnPins!(), { venus: true, "aave-v3": false }, "Pool.getReserveData(USDT) word 8 must be the aToken");
  assert.deepEqual(await (await pair(t, { underlying: wrong }, {})).earnPins!(), { venus: false, "aave-v3": true }, "the two RPCs disagree: closed");
  assert.deepEqual(await (await pair(t, { fail: "eth_call" }, { fail: "eth_call" })).earnPins!(), { venus: false, "aave-v3": false });
  void ({} as Hex);
});
