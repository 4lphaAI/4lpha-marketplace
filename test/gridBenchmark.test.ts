import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { custom, encodeAbiParameters, formatTransactionReceipt, type Address, type Hex, type RpcTransactionReceipt } from "viem";
import { bsc } from "viem/chains";
import { createGridBenchmarkCache, parseGridArmBenchmark, selectGridArmBenchmark, type GridArmBenchmarkInput } from "../src/http/gridBenchmark.js";
import { createLpChainReaders } from "../src/lp/readers.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";

// Public on-chain receipt; no account credential or private input is stored.
const raw = (JSON.parse(readFileSync(new URL("./fixtures/grid-arm-receipt.json", import.meta.url), "utf8")) as { result: RpcTransactionReceipt }).result;
const receipt = formatTransactionReceipt(raw);
const NFPM = "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364" as Address;
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" as Address;
const BASE = "0x5c85d6c6825ab4032337f11ee92a72df936b46f6" as Address;
const POOL = "0x90a54475d512b8f3852351611c38fad30a513491" as Address;
const WALLET = "0xdfb9fe4922daf390349d5cfaf94185ea4cc02764" as Address;
const input: GridArmBenchmarkInput = { owner: WALLET, agentId: "grid-agent-01-2", group: "arm-1", wallet: WALLET,
  token0: BASE, token1: WBNB, wbnb: WBNB, fee: 2500, pool: POOL, mintCount: 2,
  txHash: receipt.transactionHash, capitalWei: "62700000000000000" };
const block = { number: 120346004n, hash: receipt.blockHash, timestamp: 1788717275n };
const parse = (r = receipt, b = block, final = block.number) => parseGridArmBenchmark(input, NFPM, r, b, final);
const evidence = parse();

describe("grid arm receipt benchmark", () => {
  it("recovers exact original arm price and timestamp from the real public receipt", () => {
    assert.equal(evidence.sqrtPriceX96, "513880076837086159948503475");
    assert.equal(evidence.armedAtMs, Date.parse("2026-09-06T17:54:35Z"));
    assert.equal(evidence.capitalWei, "62700000000000000");
  });
  for (const [name, change] of [
    ["failed receipt", () => parse({ ...receipt, status: "reverted" })],
    ["wrong tx", () => parse({ ...receipt, transactionHash: `0x${"11".repeat(32)}` })],
    ["wrong canonical hash", () => parse(receipt, { ...block, hash: `0x${"11".repeat(32)}` })],
    ["not finalized", () => parse(receipt, block, block.number - 1n)],
    ["bad timestamp", () => parse(receipt, { ...block, timestamp: -1n })],
    ["wrong wallet", () => parseGridArmBenchmark({ ...input, wallet: BASE }, NFPM, receipt, block, block.number)],
    ["wrong pool", () => parseGridArmBenchmark({ ...input, pool: BASE }, NFPM, receipt, block, block.number)],
    ["wrong NFPM", () => parseGridArmBenchmark(input, BASE, receipt, block, block.number)],
    ["wrong mint count", () => parseGridArmBenchmark({ ...input, mintCount: 1 }, NFPM, receipt, block, block.number)],
    ["duplicate log", () => parse({ ...receipt, logs: [...receipt.logs, receipt.logs[0]!] })],
    ["removed log", () => parse({ ...receipt, logs: receipt.logs.map((l, i) => i === 0 ? { ...l, removed: true } : l) })],
    ["log block mismatch", () => parse({ ...receipt, logs: receipt.logs.map((l, i) => i === 0 ? { ...l, blockNumber: 2n } : l) })],
    ["no swap", () => parse({ ...receipt, logs: receipt.logs.filter(l => !l.topics[0]?.startsWith("0x19b472")) })],
    ["wrong direction", () => parseGridArmBenchmark({ ...input, wbnb: BASE }, NFPM, receipt, block, block.number)],
  ] as const) it(`refuses ${name}`, () => assert.throws(change));

  it("supports the opposite quote orientation and checks sqrt/tick coherence", () => {
    const replace = (sqrt: bigint, tick: number) => ({ ...receipt, logs: receipt.logs.map(l => l.topics[0]?.startsWith("0x19b472")
      ? { ...l, data: encodeAbiParameters([{type:"int256"},{type:"int256"},{type:"uint160"},{type:"uint128"},{type:"int24"},{type:"uint128"},{type:"uint128"}], [1n,-1n,sqrt,1n,tick,0n,0n]) } : l) });
    const reverse = { ...input, token0: WBNB, token1: BASE };
    assert.equal(parseGridArmBenchmark(reverse, NFPM, replace(1n << 96n, 0), block, block.number).sqrtPriceX96, (1n << 96n).toString());
    assert.doesNotThrow(() => parseGridArmBenchmark(reverse, NFPM, replace(getSqrtRatioAtTick(1), 0), block, block.number));
    assert.throws(() => parseGridArmBenchmark(reverse, NFPM, replace(getSqrtRatioAtTick(1) + 1n, 0), block, block.number));
    assert.throws(() => parseGridArmBenchmark(reverse, NFPM, replace(0n, 0), block, block.number));
  });

  it("reader uses canonical receipt/block and factory, never historical slot0", async () => {
    const methods: string[] = [];
    const readers = createLpChainReaders({ network: { chainId: 56, chain: bsc, publicRpcUrl: "https://fixture.invalid" },
      nfpm: NFPM, factory: BASE, quoterV2: BASE, twapWindowSeconds: 60,
      transport: () => custom({ request: async ({ method }) => {
        methods.push(method);
        if (method === "eth_chainId") return "0x38";
        if (method === "eth_call") return encodeAbiParameters([{type:"address"}], [POOL]);
        if (method === "eth_getTransactionReceipt") return raw;
        if (method === "eth_getBlockByNumber") return { number: raw.blockNumber, hash: raw.blockHash, timestamp: "0x6a9da8db", transactions: [] };
        throw new Error("unexpected RPC");
      } }, { retryCount: 0 }),
    });
    assert.deepEqual(await readers.gridArmBenchmark!(input), evidence);
    assert.equal(methods.filter(m => m === "eth_call").length, 1);
    assert.equal(methods.filter(m => m === "eth_getBlockByNumber").length, 2);
  });
});

const position = { agentId: input.agentId, ownerAddress: WALLET, positionId: "original", armGroupId: "arm-1", state: "closed" as const, token0: BASE, token1: WBNB, fee: 2500 };
const step = { index: 0, kind: "zap-in-mint" as const, journalIdempotencyKey: "arm", journalDecisionId: "arm" };
const selection: Parameters<typeof selectGridArmBenchmark>[0] = { ...input,
  positions: [position, { ...position, positionId: "replacement", state: "open" }],
  sequences: [{ agentId: input.agentId, ownerAddress: WALLET, positionId: "original", kind: "grid-arm", state: "completed", recoveryState: "none", steps: [step] }],
  outcomes: new Map([["arm", { state: "COMMITTED", txHash: input.txHash, submitted: true, unreadable: false }]]),
  nativeSpends: new Map([["arm", BigInt(input.capitalWei)]]),
};
describe("grid arm ancestry", () => {
  it("keeps the original group after replacement NFTs", () => assert.deepEqual(selectGridArmBenchmark(selection), input));
  it("ignores rolled-back attempts", () => {
    const s = { ...selection, sequences: [{ ...selection.sequences[0]!, steps: [{ ...step, journalIdempotencyKey: "retry" }, step] }],
      outcomes: new Map([...selection.outcomes, ["retry", { state: "ROLLED_BACK" as const, txHash: null, submitted: false, unreadable: false }]]) };
    assert.deepEqual(selectGridArmBenchmark(s), input);
  });
  for (const [name, override] of [
    ["different current group", { positions: [position, { ...position, positionId: "new-arm", armGroupId: "other", state: "open" as const }] }],
    ["mixed null and grouped", { positions: [...selection.positions, { ...position, positionId: "null", armGroupId: null, state: "open" as const }] }],
    ["multiple original arms", { sequences: [...selection.sequences, ...selection.sequences] }],
    ["other owner", { owner: BASE }],
    ["missing outcome", { outcomes: new Map() }],
    ["different capital", { capitalWei: "1" }],
    ["missing spend", { nativeSpends: new Map() }],
    ["uncompleted arm", { sequences: [{ ...selection.sequences[0]!, state: "active" as const }] }],
  ] as const) it(`refuses ${name}`, () => assert.equal((selectGridArmBenchmark({ ...selection, ...override }) as { status: string }).status, "unavailable"));
});

describe("bounded reporting cache", () => {
  it("returns immediately, deduplicates, catches failures and retries after settlement TTL", async () => {
    let now = 0, calls = 0;
    const cache = createGridBenchmarkCache(() => now);
    const fail = async () => { calls++; throw new Error("private RPC detail"); };
    assert.equal(cache.getOrStart(input, fail).status, "pending");
    cache.getOrStart(input, fail);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.deepEqual(cache.getOrStart(input, fail), { status: "unavailable", reason: "arm-receipt-unavailable" });
    now = 15001;
    assert.equal(cache.getOrStart(input, async () => evidence).status, "pending");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(cache.getOrStart(input, fail), evidence);
    now += 300001;
    assert.equal(cache.getOrStart(input, fail).status, "pending");
    await new Promise(resolve => setImmediate(resolve));
  });
  it("never launches more than four jobs even as 128 distinct owners poll", async () => {
    const cache = createGridBenchmarkCache(); let calls = 0;
    const read = () => { calls++; return new Promise<typeof evidence>(() => {}); };
    for (let i = 0; i < 256; i++) cache.getOrStart({ ...input, agentId: String(i) }, read);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 4);
    for (let i = 0; i < 256; i++) cache.getOrStart({ ...input, agentId: String(i) }, read);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 4);
  });
});
