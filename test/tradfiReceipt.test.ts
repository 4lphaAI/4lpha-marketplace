import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  stringToBytes,
  toHex,
  custom,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { WalletCall } from "../src/core/types.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { buildTradfiApprove, buildTradfiPancakeV3Swap } from "../src/ops/tradfi.js";
import { buildTradfiGuardSwapCall, TRADFI_BINANCE_FLASH_ROUTER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { hashCalls } from "../src/http/wire.js";
import {
  TRADFI_RECEIPT_INTENT_EXECUTED_TOPIC,
  TRADFI_RECEIPT_INTENT_SUCCESS,
  TRADFI_RECEIPT_ORCHESTRATOR_56,
  TRADFI_RECEIPT_SWAP_EXECUTED_TOPIC,
  TRADFI_RECEIPT_TRANSFER_TOPIC,
  createTradfiV2ReceiptReader,
  type TradfiReceiptLog,
  type TradfiReceiptObservation,
  type TradfiV2ReceiptExpected,
  verifyTradfiV2Receipt,
} from "../src/trade/receipt.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import type { AgentRecord } from "../src/store/agents.js";
import { canonicalPreparedIntentIdentityV1, fingerprintLpFinalCallsV1, parsePreparedIntentIdentityV1,
  PORTO_INTENT_SCHEME, PORTO_V055_DECODER, PORTO_V055_ORCHESTRATOR, PORTO_V055_VERSION } from "../src/lp/preparedIntent.js";
import { decodePortoV055Transaction, pairPreparedIntentCandidate } from "../src/lp/intentDecoder.js";
import { assessTradeUnknown } from "../src/trade/unknownResolve.js";
import { netTransferDelta } from "../src/trade/simulate.js";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const PAIR = getAddress("0x4444444444444444444444444444444444444444");
const ROUTER = getAddress("0x7777777777777777777777777777777777777777");
const GUARD = getAddress("0x5555555555555555555555555555555555555555");
const TREASURY = getAddress("0x6666666666666666666666666666666666666666");
const PUBLIC_KEY = (`0x04${"11".repeat(64)}`) as Hex;
const SESSION_KEY_HASH = accountKeyHashForAddress(publicKeyToAddress(PUBLIC_KEY));
const TX_HASH = (`0x${"aa".repeat(32)}`) as Hex;
const BLOCK_HASH = (`0x${"bb".repeat(32)}`) as Hex;
const CALLS_ABI = [{
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
  components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  ],
}] as const;
const EVENT_ZERO = padHex(WALLET, { size: 32 });

function topic(address: Address): Hex { return padHex(address, { size: 32 }); }
function amount(value: bigint): Hex { return toHex(value, { size: 32 }); }

function transfer(token: Address, from: Address, to: Address, value: bigint, logIndex: bigint): TradfiReceiptLog {
  return { address: token, topics: [TRADFI_RECEIPT_TRANSFER_TOPIC, topic(from), topic(to)], data: amount(value), logIndex };
}

function intentEvent(wallet: Address, nonce: bigint, logIndex: bigint, success = true): TradfiReceiptLog {
  return {
    address: TRADFI_RECEIPT_ORCHESTRATOR_56,
    topics: [TRADFI_RECEIPT_INTENT_EXECUTED_TOPIC, topic(wallet), amount(nonce)],
    data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [success, success ? TRADFI_RECEIPT_INTENT_SUCCESS : "0xdeadbeef"]),
    logIndex,
  };
}

function guardEvent(wallet: Address, tokenIn: Address, tokenOut: Address, input: bigint, output: bigint, data: Hex, logIndex: bigint): TradfiReceiptLog {
  return {
    address: GUARD,
    topics: [TRADFI_RECEIPT_SWAP_EXECUTED_TOPIC, topic(wallet), topic(tokenIn), topic(tokenOut)],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [input, output, keccak256(data)]),
    logIndex,
  };
}

function executionData(calls: readonly WalletCall[]): Hex {
  return encodeAbiParameters(CALLS_PARAMETERS, [calls.map((call) => ({
    target: call.to, value: call.value ?? 0n, data: call.data ?? "0x",
  }))]);
}

function encodedIntent(input: {
  readonly wallet?: Address;
  readonly nonce?: bigint;
  readonly calls: readonly WalletCall[];
  readonly preCalls?: readonly Hex[];
}): Hex {
  const wallet = input.wallet ?? WALLET;
  const signature = (`0x${"00".repeat(8)}${SESSION_KEY_HASH.slice(2)}00`) as Hex;
  return encodeAbiParameters(INTENT_PARAMETERS, [{
    eoa: wallet, executionData: executionData(input.calls), nonce: input.nonce ?? 7n,
    payer: ZERO, paymentToken: ZERO, paymentMaxAmount: 0n, combinedGas: 0n,
    encodedPreCalls: input.preCalls ?? [], encodedFundTransfers: [], settler: ZERO, expiry: 0n,
    isMultichain: false, funder: ZERO, funderSignature: "0x", settlerContext: "0x",
    paymentAmount: 0n, paymentRecipient: ZERO, signature, paymentSignature: "0x", supportedAccountImplementation: ZERO,
  }]);
}

function transactionInput(members: readonly Hex[]): Hex {
  if (members.length === 1) return encodeFunctionData({ abi: CALLS_ABI, functionName: "execute", args: [members[0]!] });
  return encodeFunctionData({
    abi: [{ ...CALLS_ABI[0], inputs: [{ name: "encodedIntents", type: "bytes[]" }], outputs: [{ name: "errs", type: "bytes4[]" }] }] as const,
    functionName: "execute", args: [members],
  });
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function observation(input: Hex, logs: readonly TradfiReceiptLog[], status = 1n): TradfiReceiptObservation {
  const transaction = { hash: TX_HASH, to: TRADFI_RECEIPT_ORCHESTRATOR_56, input, blockNumber: 100n, blockHash: BLOCK_HASH, transactionIndex: 2n } as const;
  const receipt = { status, transactionHash: TX_HASH, blockNumber: 100n, blockHash: BLOCK_HASH, transactionIndex: 2n, logs } as const;
  return { chainId: 56, transaction, receipt, receiptBlock: { number: 100n, hash: BLOCK_HASH }, finalizedBlock: { number: 110n, hash: (`0x${"cc".repeat(32)}`) as Hex } };
}

function expected(side: "buy" | "sell", calls: readonly WalletCall[], overrides: Partial<TradfiV2ReceiptExpected> = {}): TradfiV2ReceiptExpected {
  const base = { wallet: WALLET, sessionPublicKey: PUBLIC_KEY, sessionGeneration: 3, callsHash: keccak256(stringToBytes("unused")), calls,
    side, token: TOKEN, amountInAtomic: 100n, minOutAtomic: 80n } satisfies TradfiV2ReceiptExpected;
  return { ...base, ...overrides, callsHash: overrides.callsHash ?? base.callsHash };
}

function withCalls(input: TradfiV2ReceiptExpected, calls: readonly WalletCall[]): TradfiV2ReceiptExpected {
  return { ...input, calls, callsHash: hashCalls(calls),
    ...(input.guard === undefined && input.directRoute === undefined
      ? { directRoute: { kind: "v2" as const, router: PAIR, pools: [PAIR], blockNumber: 100n, blockHash: BLOCK_HASH } }
      : {}) };
}

test("direct buy verifies exact intent, calls, fee, wallet legs and nullable basis", () => {
  const calls: readonly WalletCall[] = [
    { to: PAIR, data: "0x12345678", value: 0n },
  ];
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n, platformFeeAtomic: 5n, feeTreasury: TREASURY }), calls);
  const member = encodedIntent({ calls });
  const observed = observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n),
    transfer(USDT_56, WALLET, PAIR, 100n, 2n),
    transfer(USDT_56, WALLET, TREASURY, 5n, 3n),
    transfer(TOKEN, PAIR, WALLET, 90n, 4n),
  ]);
  const result = verifyTradfiV2Receipt({ observation: observed, expected: row });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.evidence.verifiedEntryAtomic, 105n);
    assert.equal(result.evidence.actualInputAtomic, 100n);
    assert.equal(result.evidence.actualOutputAtomic, 90n);
    assert.equal(netTransferDelta(observed.receipt.logs, TOKEN, WALLET), result.evidence.actualOutputAtomic);
    assert.equal(result.evidence.sessionGeneration, 3);
  }
});

test("direct sell verifies stock debit and USDT proceeds without a fee", () => {
  const calls: readonly WalletCall[] = [{ to: PAIR, data: "0x87654321", value: 0n }];
  const row = withCalls(expected("sell", calls, { amountInAtomic: 100n, minOutAtomic: 80n }), calls);
  const member = encodedIntent({ calls });
  const result = verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n), transfer(TOKEN, WALLET, PAIR, 100n, 2n), transfer(USDT_56, PAIR, WALLET, 88n, 3n),
  ]), expected: row });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.evidence.verifiedProceedsAtomic, 88n);
});

test("direct output from an unrelated donor is contamination even at the exact amount", () => {
  const calls: readonly WalletCall[] = [{ to: PAIR, data: "0x87654321", value: 0n }];
  const row = withCalls(expected("sell", calls, { amountInAtomic: 100n, minOutAtomic: 80n }), calls);
  const member = encodedIntent({ calls });
  const result = verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n), transfer(TOKEN, WALLET, PAIR, 100n, 2n), transfer(USDT_56, OTHER_WALLET, WALLET, 88n, 3n),
  ]), expected: row });
  assert.equal(result.ok, false);
});

test("direct V3 input is attributed to the first finalized pool callback counterparty", () => {
  const calls = buildTradfiPancakeV3Swap({ router: ROUTER, tokenIn: USDT_56, tokenOut: TOKEN, amountInWei: 100n,
    minOutWei: 80n, recipient: WALLET, deadline: 1_000n, route: { hops: [], fees: [2500] } });
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n,
    directRoute: { kind: "v3", router: ROUTER, pools: [PAIR], blockNumber: 100n, blockHash: BLOCK_HASH } }), calls);
  const member = encodedIntent({ calls });
  const result = verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n), transfer(USDT_56, WALLET, PAIR, 100n, 2n), transfer(TOKEN, PAIR, WALLET, 90n, 3n),
  ]), expected: row });
  assert.equal(result.ok, true);
});

test("guard buy records requested input separately from refunded and actual input", () => {
  const opaque = (`0xad43f73d${"12".repeat(20)}`) as Hex;
  const calls = [...buildTradfiApprove(USDT_56, GUARD, 100n), buildTradfiGuardSwapCall({ guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_ROUTER_56, canonicalUSDT: USDT_56, tokenIn: USDT_56, tokenOut: TOKEN,
    amountInWei: 100n, minOutWei: 80n, deadline: 1_000n, calldata: opaque })];
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n, platformFeeAtomic: 3n, feeTreasury: TREASURY,
    guard: { address: GUARD, calldata: opaque } }), calls);
  const member = encodedIntent({ calls });
  const result = verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n), guardEvent(WALLET, USDT_56, TOKEN, 97n, 90n, opaque, 2n),
    transfer(USDT_56, WALLET, GUARD, 100n, 3n), transfer(USDT_56, GUARD, WALLET, 3n, 4n),
    transfer(USDT_56, WALLET, TREASURY, 3n, 5n), transfer(TOKEN, GUARD, WALLET, 90n, 6n),
  ]), expected: row });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.evidence.actualInputAtomic, 97n); assert.equal(result.evidence.verifiedEntryAtomic, 100n); }
});

test("guard accepts the reviewed 64 KiB opaque call but refuses an oversized intent envelope", () => {
  const opaque = (`0xad43f73d${"56".repeat(64 * 1024 - 4)}`) as Hex;
  const calls = [...buildTradfiApprove(USDT_56, GUARD, 100n), buildTradfiGuardSwapCall({ guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_ROUTER_56, canonicalUSDT: USDT_56, tokenIn: USDT_56, tokenOut: TOKEN,
    amountInWei: 100n, minOutWei: 80n, deadline: 1_000n, calldata: opaque })];
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n, guard: { address: GUARD, calldata: opaque } }), calls);
  const member = encodedIntent({ calls });
  const good = verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n), guardEvent(WALLET, USDT_56, TOKEN, 100n, 90n, opaque, 2n),
    transfer(USDT_56, WALLET, GUARD, 100n, 3n), transfer(TOKEN, GUARD, WALLET, 90n, 4n),
  ]), expected: row });
  assert.equal(good.ok, true);

  const tooLarge = (`0xad43f73d${"78".repeat(128 * 1024 - 3)}`) as Hex;
  const oversizedCalls: readonly WalletCall[] = [{ to: GUARD, data: tooLarge, value: 0n }];
  const oversizedExpected = withCalls(expected("buy", oversizedCalls, { amountInAtomic: 100n, minOutAtomic: 80n,
    guard: { address: GUARD, calldata: tooLarge } }), oversizedCalls);
  const oversizedMember = encodedIntent({ calls: oversizedCalls });
  const refused = verifyTradfiV2Receipt({ observation: observation(transactionInput([oversizedMember]), [
    intentEvent(WALLET, 7n, 1n), guardEvent(WALLET, USDT_56, TOKEN, 100n, 90n, tooLarge, 2n),
    transfer(USDT_56, WALLET, GUARD, 100n, 3n), transfer(TOKEN, GUARD, WALLET, 90n, 4n),
  ]), expected: oversizedExpected });
  assert.equal(refused.ok, false);
});

test("guard sell records a stock refund and actual USDT proceeds", () => {
  const opaque = (`0xad43f73d${"34".repeat(20)}`) as Hex;
  const calls = [...buildTradfiApprove(TOKEN, GUARD, 100n), buildTradfiGuardSwapCall({ guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_ROUTER_56, canonicalUSDT: USDT_56, tokenIn: TOKEN, tokenOut: USDT_56,
    amountInWei: 100n, minOutWei: 75n, deadline: 1_000n, calldata: opaque })];
  const row = withCalls(expected("sell", calls, { amountInAtomic: 100n, minOutAtomic: 75n, guard: { address: GUARD, calldata: opaque } }), calls);
  const member = encodedIntent({ calls });
  const result = verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n), guardEvent(WALLET, TOKEN, USDT_56, 96n, 82n, opaque, 2n),
    transfer(TOKEN, WALLET, GUARD, 100n, 3n), transfer(TOKEN, GUARD, WALLET, 4n, 4n), transfer(USDT_56, GUARD, WALLET, 82n, 5n),
  ]), expected: row });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.evidence.actualInputAtomic, 96n); assert.equal(result.evidence.verifiedProceedsAtomic, 82n); }
});

test("a different wallet in the same batch cannot contribute to target deltas", () => {
  const calls: readonly WalletCall[] = [{ to: PAIR, data: "0x12345678", value: 0n }];
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n }), calls);
  const member = encodedIntent({ calls });
  const otherMember = encodedIntent({ wallet: OTHER_WALLET, calls });
  const result = verifyTradfiV2Receipt({ observation: observation(transactionInput([member, otherMember]), [
    intentEvent(WALLET, 7n, 1n), intentEvent(OTHER_WALLET, 8n, 2n),
    transfer(USDT_56, WALLET, PAIR, 100n, 3n), transfer(TOKEN, PAIR, WALLET, 90n, 4n),
    transfer(USDT_56, OTHER_WALLET, PAIR, 500n, 5n), transfer(TOKEN, PAIR, OTHER_WALLET, 450n, 6n),
  ]), expected: row });
  assert.equal(result.ok, true);
});

test("A2 receipt-verified 5000-byte guard trade resolves LANDED while LP defaults still refuse it", async () => {
  const opaque = (`0xad43f73d${"56".repeat(5_000 - 4)}`) as Hex;
  const calls = [...buildTradfiApprove(USDT_56, GUARD, 100n), buildTradfiGuardSwapCall({
    guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_ROUTER_56, canonicalUSDT: USDT_56,
    tokenIn: USDT_56, tokenOut: TOKEN, amountInWei: 100n, minOutWei: 80n,
    deadline: 1_000n, calldata: opaque,
  })];
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n,
    guard: { address: GUARD, calldata: opaque } }), calls);
  const member = encodedIntent({ calls });
  assert.ok((member.length - 2) / 2 > 4_096);
  const observed = observation(transactionInput([member]), [
    intentEvent(WALLET, 7n, 1n), guardEvent(WALLET, USDT_56, TOKEN, 100n, 90n, opaque, 2n),
    transfer(USDT_56, WALLET, GUARD, 100n, 3n), transfer(TOKEN, GUARD, WALLET, 90n, 4n),
  ]);
  assert.equal(verifyTradfiV2Receipt({ observation: observed, expected: row }).ok, true);
  assert.throws(() => decodePortoV055Transaction(56, PORTO_V055_ORCHESTRATOR, observed.transaction.input), /4096/u);
  const fingerprint = fingerprintLpFinalCallsV1(calls);
  const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME,
    decoder: PORTO_V055_DECODER, chainId: "56", eoa: WALLET.toLowerCase() as Address,
    orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: PORTO_V055_VERSION,
    nonce: "7", expiry: "0", executionDataHash: fingerprint.value.executionDataHash,
    keyHash: SESSION_KEY_HASH.toLowerCase() as Hex });
  assert.equal(pairPreparedIntentCandidate(parsePreparedIntentIdentityV1(identity.canonical), observed.transaction as Parameters<typeof pairPreparedIntentCandidate>[1],
    observed.receipt).outcome, "ambiguous");
  const journal = new MemoryExecutionJournal(() => 0);
  await journal.begin({ idempotencyKey: "large-guard", agentId: "guard-agent", ownerAddress: WALLET,
    kind: "trade", finalCallsFingerprint: fingerprint.canonical, finalCallsFingerprintHash: fingerprint.hash });
  await journal.bindPreparedIntent("large-guard", { canonicalIdentity: identity.canonical,
    identityHash: identity.hash, expectedBindingVersion: 0 });
  await journal.markUnknown("large-guard", "relay reply lost");
  const verdict = await assessTradeUnknown({ agent: { id: "guard-agent", ownerAddress: WALLET,
    walletAddress: WALLET } as AgentRecord, journal: (await journal.get("large-guard"))!, nowMs: 300_000,
    reads: { async finalizedBlock() { return { number: 110n, hash: observed.finalizedBlock.hash }; },
      async accountNonce() { return 8n; }, async blockAtOrBefore() { return 90n; },
      async intentExecutedTxHashes() { return [TX_HASH]; }, async readFinalized() { return observed; } } });
  assert.equal(verdict.kind, "landed");
});

test("R3.3 an other-wallet batch that sends USDT into this wallet has no attributable buy or sell accounting", async () => {
  const calls: readonly WalletCall[] = [{ to: PAIR, data: "0x12345678", value: 0n }];
  const members = [encodedIntent({ calls }), encodedIntent({ wallet: OTHER_WALLET, calls })];
  const events = [intentEvent(WALLET, 7n, 1n), intentEvent(OTHER_WALLET, 8n, 2n)];
  const donation = transfer(USDT_56, OTHER_WALLET, WALLET, 1n, 5n);
  const buy = verifyTradfiV2Receipt({ observation: observation(transactionInput(members), [
    ...events, transfer(USDT_56, WALLET, PAIR, 100n, 3n), transfer(TOKEN, PAIR, WALLET, 90n, 4n), donation,
  ]), expected: withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n }), calls) });
  assert.equal(buy.ok, false);
  const sell = verifyTradfiV2Receipt({ observation: observation(transactionInput(members), [
    ...events, transfer(TOKEN, WALLET, PAIR, 100n, 3n), transfer(USDT_56, PAIR, WALLET, 90n, 4n), donation,
  ]), expected: withCalls(expected("sell", calls, { amountInAtomic: 100n, minOutAtomic: 80n }), calls) });
  assert.equal(sell.ok, false);
  const positions = new MemoryTradePositionStore();
  await positions.open({ positionId: "contaminated-buy", agentId: "a", ownerAddress: WALLET,
    token: TOKEN, route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: null,
    fillStatus: "unverified", openedAt: Date.now(), settlementAsset: "USDT",
    requestedEntryAtomic: 100n, verifiedEntryAtomic: null });
  await positions.resolveFill({ ownerAddress: WALLET, agentId: "a", positionId: "contaminated-buy", tokenAmount: 90n });
  const recovered = await positions.get(WALLET, "a", "contaminated-buy");
  assert.equal(recovered?.fillStatus, "verified");
  assert.equal(recovered?.verifiedEntryAtomic, null);
  assert.equal(recovered?.receiptOwnershipKey ?? null, null);
  await positions.closePosition({ ownerAddress: WALLET, agentId: "a", positionId: "contaminated-buy",
    exitWei: 0n, reason: "balance-gone", exitFillStatus: "unverified" });
  const closed = await positions.get(WALLET, "a", "contaminated-buy");
  assert.equal(closed?.exitWei, 0n);
  assert.equal(closed?.exitReceiptOwnershipKey ?? null, null);
});

test("same-wallet duplicate intent, donation, failed main intent and pre-call all refuse", () => {
  const calls: readonly WalletCall[] = [{ to: PAIR, data: "0x12345678", value: 0n }];
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n }), calls);
  const member = encodedIntent({ calls });
  const logs = [intentEvent(WALLET, 7n, 1n), transfer(USDT_56, WALLET, PAIR, 100n, 2n), transfer(TOKEN, PAIR, WALLET, 90n, 3n)];
  assert.equal(verifyTradfiV2Receipt({ observation: observation(transactionInput([member, member]), logs), expected: row }).ok, false);
  assert.equal(verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [...logs, transfer(TOKEN, OTHER_WALLET, WALLET, 1n, 4n)]), expected: row }).ok, false);
  assert.equal(verifyTradfiV2Receipt({ observation: observation(transactionInput([member]), [intentEvent(WALLET, 7n, 1n, false), ...logs.slice(1)]), expected: row }).ok, false);
  const preCallMember = encodedIntent({ calls, preCalls: ["0x1234"] });
  assert.equal(verifyTradfiV2Receipt({ observation: observation(transactionInput([preCallMember]), logs), expected: row }).ok, false);
});

test("wrong key, calls hash, canonical block and finality never become a fill", () => {
  const calls: readonly WalletCall[] = [{ to: PAIR, data: "0x12345678", value: 0n }];
  const row = withCalls(expected("buy", calls, { amountInAtomic: 100n, minOutAtomic: 80n }), calls);
  const member = encodedIntent({ calls });
  const good = observation(transactionInput([member]), [intentEvent(WALLET, 7n, 1n), transfer(USDT_56, WALLET, PAIR, 100n, 2n), transfer(TOKEN, PAIR, WALLET, 90n, 3n)]);
  const wrongKey = { ...row, sessionPublicKey: (`0x04${"22".repeat(64)}`) as Hex };
  assert.equal(verifyTradfiV2Receipt({ observation: good, expected: wrongKey }).ok, false);
  assert.equal(verifyTradfiV2Receipt({ observation: good, expected: { ...row, callsHash: (`0x${"01".repeat(32)}`) as Hex } }).ok, false);
  assert.equal(verifyTradfiV2Receipt({ observation: { ...good, receiptBlock: { number: 100n, hash: (`0x${"dd".repeat(32)}`) as Hex } }, expected: row }).ok, false);
  assert.equal(verifyTradfiV2Receipt({ observation: { ...good, finalizedBlock: { number: 99n, hash: (`0x${"cc".repeat(32)}`) as Hex } }, expected: row }).ok, false);
});

test("fixture constants retain the exact zero success and transfer identities", () => {
  assert.equal(TRADFI_RECEIPT_INTENT_SUCCESS, "0x00000000");
  assert.equal(TRADFI_RECEIPT_TRANSFER_TOPIC, keccak256(stringToBytes("Transfer(address,address,uint256)")));
  assert.equal(EVENT_ZERO.length, 66);
  assert.equal(decodeAbiParameters([{ type: "uint256" }], amount(3n))[0], 3n);
});

function rpcBlock(number: bigint, hash: Hex): Record<string, unknown> {
  return { number: toHex(number), hash, parentHash: (`0x${"01".repeat(32)}`) as Hex, nonce: "0x0000000000000000",
    sha3Uncles: (`0x${"02".repeat(32)}`) as Hex, logsBloom: (`0x${"00".repeat(256)}`) as Hex,
    transactionsRoot: (`0x${"03".repeat(32)}`) as Hex, stateRoot: (`0x${"04".repeat(32)}`) as Hex,
    receiptsRoot: (`0x${"05".repeat(32)}`) as Hex, miner: WALLET, mixHash: (`0x${"06".repeat(32)}`) as Hex,
    difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: "0x0", gasUsed: "0x0",
    timestamp: "0x0", transactions: [], uncles: [], baseFeePerGas: null };
}

function mockReceiptReader(heads: readonly [bigint, bigint], commonHash: readonly [Hex, Hex]) {
  const transport = (url: string) => custom({ request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    const index = url.endsWith("-a") ? 0 : 1;
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_getBlockByNumber") {
      const tag = params?.[0];
      if (tag === "finalized") return rpcBlock(heads[index]!, (`0x${"10".repeat(32)}`) as Hex);
      const number = BigInt(String(tag));
      return rpcBlock(number, commonHash[index]!);
    }
    throw new Error(`unexpected ${method}`);
  } });
  return createTradfiV2ReceiptReader({ rpcUrls: ["https://fixture-a", "https://fixture-b"], transport });
}

test("reader uses the lowest common finalized height when endpoint heads differ", async () => {
  const hash = (`0x${"ab".repeat(32)}`) as Hex;
  const reader = mockReceiptReader([110n, 112n], [hash, hash]);
  assert.deepEqual(await reader.finalizedBlock(), { number: 110n, hash });
});

test("reader refuses a common-height finalized hash disagreement and duplicate RPC URLs", async () => {
  const reader = mockReceiptReader([110n, 112n], [(`0x${"ab".repeat(32)}`) as Hex, (`0x${"cd".repeat(32)}`) as Hex]);
  assert.equal(await reader.finalizedBlock(), null);
  assert.throws(() => createTradfiV2ReceiptReader({ rpcUrls: ["https://same", "https://same"] }), /two distinct/u);
});
