import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { getAddress, keccak256, padHex, stringToBytes, toHex, type Hex } from "viem";
import { tradeParamsHash } from "../src/http/wire.js";
import { tradeExecutionIdentity, tradeReceiptFill } from "../src/trade/execute.js";
import { tradeConfig } from "./support/serverHarness.js";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x2222222222222222222222222222222222222222");
const WBNB = getAddress("0x3333333333333333333333333333333333333333");
const HASH = `0x${"44".repeat(32)}` as Hex;
const transfer = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const withdrawal = keccak256(stringToBytes("Withdrawal(address,uint256)"));
const topicAddress = (address: string): Hex => padHex(address as Hex, { size: 32 });

function request(side: "buy" | "sell") {
  return { decisionId: "fill", venue: "pancake" as const, side, token: TOKEN,
    amountWei: 100n, minOutWei: 90n, quotedOutWei: 95n, route: { hops: [], fees: [] } };
}

describe("receipt-derived trade fills", () => {
  it("returns the exact token Transfer delta and request native debit for a buy", async () => {
    const fill = await tradeReceiptFill({ request: request("buy"), walletAddress: WALLET, nativeInWei: 101n,
      receipt: { status: "CONFIRMED", transactionHash: HASH }, wbnb: WBNB,
      reader: { async getReceipt() { return { logs: [{ address: TOKEN,
        topics: [transfer, topicAddress(WBNB), topicAddress(WALLET)], data: toHex(77n, { size: 32 }) }] }; } } });
    assert.deepEqual(fill, { side: "buy", entryWei: 101n, tokenAmount: 77n, fillStatus: "verified" });
  });

  it("returns unverified instead of a zero token fill when receipt evidence is absent", async () => {
    const fill = await tradeReceiptFill({ request: request("buy"), walletAddress: WALLET, nativeInWei: 101n,
      receipt: { status: "CONFIRMED", transactionHash: HASH }, wbnb: WBNB,
      reader: { async getReceipt() { throw new Error("receipt RPC failed"); } } });
    assert.deepEqual(fill, { side: "buy", entryWei: 101n, tokenAmount: null, fillStatus: "unverified" });
  });

  it("returns the exact WBNB Withdrawal amount for a sell", async () => {
    const fill = await tradeReceiptFill({ request: request("sell"), walletAddress: WALLET, nativeInWei: 0n,
      receipt: { status: "CONFIRMED", transactionHash: HASH }, wbnb: WBNB,
      reader: { async getReceipt() { return { logs: [{ address: WBNB,
        topics: [withdrawal, topicAddress(WALLET)], data: toHex(88n, { size: 32 }) }] }; } } });
    assert.deepEqual(fill, { side: "sell", exitWei: 88n, fillStatus: "verified" });
  });

  it("returns null proceeds instead of inventing zero when sell receipt evidence is absent", async () => {
    const fill = await tradeReceiptFill({ request: request("sell"), walletAddress: WALLET, nativeInWei: 0n,
      receipt: { status: "CONFIRMED", transactionHash: HASH }, wbnb: WBNB,
      reader: { async getReceipt() { throw new Error("receipt RPC failed"); } } });
    assert.deepEqual(fill, { side: "sell", exitWei: null, fillStatus: "unverified" });
  });

  it("uses the same params hash helper from the HTTP route and worker call sites", async () => {
    const trade = tradeConfig({ venues: { chainId: 56, pancakeRouterV2: WBNB, wbnb: WBNB } });
    const value = request("buy");
    const identity = tradeExecutionIdentity({ agentId: "agent-a", chainId: 56, request: value,
      trade, pancake: { router: WBNB, wbnb: WBNB }, pancakeV3: null, flapPortal: null });
    assert.equal(identity.paramsHash, tradeParamsHash({ chainId: 56, venue: value.venue, side: value.side,
      token: value.token, amountWei: value.amountWei, minOutWei: value.minOutWei,
      quotedOutWei: value.quotedOutWei, router: WBNB, wbnb: WBNB, route: value.route }));
    const [server, worker] = await Promise.all([
      readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
      readFile(new URL("../scripts/trade-worker.ts", import.meta.url), "utf8"),
    ]);
    assert.match(server, /tradeExecutionIdentity\(/u);
    assert.match(worker, /tradeExecutionIdentity\(/u);
  });
});
