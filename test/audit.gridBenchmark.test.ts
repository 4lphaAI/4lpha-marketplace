import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { formatTransactionReceipt, type Address, type RpcTransactionReceipt } from "viem";
import { createGridBenchmarkCache, GRID_ARM_SWAP_TOPIC, parseGridArmBenchmark, type GridArmBenchmarkInput } from "../src/http/gridBenchmark.js";

const receipt = formatTransactionReceipt((JSON.parse(readFileSync(new URL("./fixtures/grid-arm-receipt.json", import.meta.url), "utf8")) as { result: RpcTransactionReceipt }).result);
const nfpm = "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364" as Address;
const wallet = "0xdfb9fe4922daf390349d5cfaf94185ea4cc02764" as Address;
const input: GridArmBenchmarkInput = {
  owner: wallet, wallet, agentId: "audit", group: "original-arm", txHash: receipt.transactionHash,
  token0: "0x5c85d6c6825ab4032337f11ee92a72df936b46f6", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  wbnb: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", pool: "0x90a54475d512b8f3852351611c38fad30a513491",
  fee: 2500, mintCount: 2, capitalWei: "62700000000000000",
};
const block = { number: receipt.blockNumber, hash: receipt.blockHash, timestamp: 1788717275n };
const parse = (r = receipt) => parseGridArmBenchmark(input, nfpm, r, block, block.number);
const evidence = parse();
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe("independent grid benchmark receipt audit", () => {
  it("refuses a second Swap even when its emitter is the same pool", () => {
    const swap = receipt.logs.find(l => l.topics[0] === GRID_ARM_SWAP_TOPIC)!;
    assert.throws(() => parse({ ...receipt, logs: [...receipt.logs, { ...swap, logIndex: 999999 }] }));
  });
  it("refuses mints before the baseline Swap and transaction-mismatched logs", () => {
    assert.throws(() => parse({ ...receipt, logs: receipt.logs.map(l => l.topics[0] === GRID_ARM_SWAP_TOPIC ? { ...l, logIndex: 999999 } : l) }));
    assert.throws(() => parse({ ...receipt, logs: receipt.logs.map((l, i) => i === 0 ? { ...l, transactionHash: `0x${"ab".repeat(32)}` } : l) }));
  });
  it("refuses malformed Swap payload and timestamp overflow", () => {
    assert.throws(() => parse({ ...receipt, logs: receipt.logs.map(l => l.topics[0] === GRID_ARM_SWAP_TOPIC ? { ...l, data: "0x" } : l) }));
    assert.throws(() => parseGridArmBenchmark(input, nfpm, receipt, { ...block, timestamp: BigInt(Number.MAX_SAFE_INTEGER) }, block.number));
  });
});

describe("independent grid benchmark cache audit", () => {
  it("retains in-flight work beyond cache TTL, catches synchronous throws, and expires failures from settlement", async () => {
    let now = 0, reads = 0;
    const cache = createGridBenchmarkCache(() => now);
    let reject!: (error: Error) => void;
    const reader = () => { reads++; return new Promise<typeof evidence>((_, fail) => { reject = fail; }); };
    assert.equal(cache.getOrStart(input, reader).status, "pending");
    await settle();
    now = 1_000_000;
    assert.equal(cache.getOrStart(input, reader).status, "pending");
    assert.equal(reads, 1);
    reject(new Error("secret transport diagnostic"));
    await settle();
    now += 14_999;
    assert.equal(cache.getOrStart(input, reader).status, "unavailable");
    now += 1;
    assert.equal(cache.getOrStart(input, () => { throw new Error("sync failure"); }).status, "pending");
    await settle();
    assert.deepEqual(cache.getOrStart(input, reader), { status: "unavailable", reason: "arm-receipt-unavailable" });
  });
  it("evicts settled capacity without displacing a live job and isolates wallet/capital identities", async () => {
    const cache = createGridBenchmarkCache(() => 0);
    let pendingReads = 0;
    const pending = () => { pendingReads++; return new Promise<typeof evidence>(() => {}); };
    cache.getOrStart(input, pending);
    await settle();
    for (let i = 0; i < 140; i++) {
      const distinct = { ...input, agentId: `settled-${i}` };
      assert.equal(cache.getOrStart(distinct, async () => evidence).status, "pending");
      await settle();
    }
    assert.equal(cache.getOrStart(input, pending).status, "pending");
    assert.equal(pendingReads, 1);
    let isolatedReads = 0;
    cache.getOrStart({ ...input, wallet: nfpm }, async () => { isolatedReads++; return evidence; });
    cache.getOrStart({ ...input, capitalWei: "1" }, async () => { isolatedReads++; return evidence; });
    await settle();
    assert.equal(isolatedReads, 2);
    assert.equal(cache.getOrStart({ ...input, agentId: "settled-0" }, async () => evidence).status, "pending");
    await settle();
  });
});
