import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, padHex,
  parseAbi, stringToHex, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import type { AgentRecord } from "../src/store/agents.js";
import { MemoryExecutionJournal, type JournalEntry } from "../src/store/journal.js";
import { encodeLpFinalCallsV1, fingerprintLpFinalCallsV1, canonicalPreparedIntentIdentityV1,
  PORTO_INTENT_SCHEME, PORTO_V055_DECODER, PORTO_V055_ORCHESTRATOR, PORTO_V055_VERSION } from "../src/lp/preparedIntent.js";
import { decodePortoV055Transaction, INTENT_EXECUTED_TOPIC, PORTO_V055_INTENT_PARAMETERS } from "../src/lp/intentDecoder.js";
import { assessTradeUnknown, createTradeUnknownReads, TRADE_UNKNOWN_LOG_CHUNK_BLOCKS, TRADE_UNKNOWN_MAX_SCAN_BLOCKS,
  type TradeUnknownReads } from "../src/trade/unknownResolve.js";
import { TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES, TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES,
  TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES, type TradfiReceiptObservation } from "../src/trade/receipt.js";
import { USDT_56 } from "../src/trade/settlement.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const OTHER = getAddress("0x3333333333333333333333333333333333333333");
const TOKEN = getAddress("0x4444444444444444444444444444444444444444");
const TX = `0x${"aa".repeat(32)}` as Hex;
const TX2 = `0x${"bb".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"cc".repeat(32)}` as Hex;
const KEY_HASH = `0x${"dd".repeat(32)}` as Hex;
const NONCE = 9n;
const NOW = 1_900_000_000_000;
const calls = [{ to: TOKEN, data: "0x1234" as Hex }];
const fingerprint = fingerprintLpFinalCallsV1(calls);
const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME, decoder: PORTO_V055_DECODER,
  chainId: "56", eoa: WALLET.toLowerCase() as Address, orchestrator: PORTO_V055_ORCHESTRATOR,
  orchestratorVersion: PORTO_V055_VERSION, nonce: NONCE.toString(), expiry: "0",
  executionDataHash: fingerprint.value.executionDataHash, keyHash: KEY_HASH });
const agent = { id: "agent", ownerAddress: OWNER, walletAddress: WALLET } as AgentRecord;
const EXECUTE = parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)"]);

function member(input: { eoa?: Address; nonce?: bigint; executionData?: Hex; keyHash?: Hex } = {}): Hex {
  return encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{ eoa: input.eoa ?? WALLET,
    executionData: input.executionData ?? encodeLpFinalCallsV1(calls), nonce: input.nonce ?? NONCE,
    payer: WALLET, paymentToken: TOKEN, paymentMaxAmount: 1n, combinedGas: 1n,
    encodedPreCalls: [], encodedFundTransfers: [], settler: OWNER, expiry: 0n,
    isMultichain: false, funder: getAddress("0x0000000000000000000000000000000000000000"),
    funderSignature: "0x", settlerContext: "0x", paymentAmount: 0n, paymentRecipient: OWNER,
    signature: concatHex([`0x${"11".repeat(65)}` as Hex, input.keyHash ?? KEY_HASH, "0x00"]),
    paymentSignature: "0x", supportedAccountImplementation: OWNER }]);
}

function event(eoa = WALLET, nonce = NONCE, incremented = true, err: Hex = "0x00000000") {
  return { address: PORTO_V055_ORCHESTRATOR,
    topics: [INTENT_EXECUTED_TOPIC, padHex(eoa, { size: 32 }), toHex(nonce, { size: 32 })],
    data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [incremented, err]), logIndex: 0n };
}

function observation(input: { hash?: Hex; members?: readonly Hex[]; events?: ReturnType<typeof event>[];
  to?: Address; status?: bigint } = {}): TradfiReceiptObservation {
  const hash = input.hash ?? TX;
  const members = input.members ?? [member()];
  const data = members.length === 1
    ? encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [members[0]!] })
    : encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [members] });
  return { chainId: 56,
    transaction: { hash, to: input.to ?? PORTO_V055_ORCHESTRATOR, input: data,
      blockNumber: 1_001n, blockHash: BLOCK_HASH, transactionIndex: 0n },
    receipt: { status: input.status ?? 1n, transactionHash: hash, blockNumber: 1_001n,
      blockHash: BLOCK_HASH, transactionIndex: 0n, logs: input.events ?? [event()] },
    receiptBlock: { number: 1_001n, hash: BLOCK_HASH },
    finalizedBlock: { number: 1_100n, hash: BLOCK_HASH } };
}

async function row(): Promise<JournalEntry> {
  const journal = new MemoryExecutionJournal(() => NOW - 300_000);
  await journal.begin({ idempotencyKey: "k", agentId: agent.id, ownerAddress: OWNER, kind: "trade",
    finalCallsFingerprint: fingerprint.canonical, finalCallsFingerprintHash: fingerprint.hash });
  await journal.bindPreparedIntent("k", { canonicalIdentity: identity.canonical, identityHash: identity.hash,
    expectedBindingVersion: 0 });
  await journal.markUnknown("k", "ambiguous");
  return (await journal.get("k"))!;
}

function reads(overrides: Partial<TradeUnknownReads> = {}, range = { from: 1_000n, to: 1_100n }) {
  const calls = { nonce: 0, logs: [] as Array<readonly [bigint, bigint]>, receipts: 0 };
  const value: TradeUnknownReads = {
    async finalizedBlock() { return { number: range.to, hash: BLOCK_HASH }; },
    async accountNonce() { calls.nonce += 1; return NONCE + 1n; },
    async blockAtOrBefore() { return range.from; },
    async intentExecutedTxHashes(_eoa, _nonce, from, to) { calls.logs.push([from, to]); return [TX]; },
    async readFinalized() { calls.receipts += 1; return observation(); },
    ...overrides,
  };
  return { value, calls };
}

async function assess(overrides: Partial<TradeUnknownReads> = {}, journal?: JournalEntry) {
  return assessTradeUnknown({ agent, journal: journal ?? await row(), reads: reads(overrides).value, nowMs: NOW });
}

it("R1 each eligibility boundary refuses before chain reads", async () => {
  const base = await row();
  const changes: JournalEntry[] = [
    { ...base, kind: "lp" }, { ...base, state: "COMMITTED" },
    { ...base, externalRef: { ...base.externalRef, txHash: TX } },
    { ...base, preparedIntentIdentity: null }, { ...base, preparedIntentIdentityHash: TX },
    { ...base, agentId: "wrong" }, { ...base, ownerAddress: OTHER },
    { ...base, updatedAt: NOW - 1 },
  ];
  for (const journal of changes) {
    const r = reads({ finalizedBlock: async () => { throw new Error("must not read"); } });
    assert.equal((await assessTradeUnknown({ agent, journal, reads: r.value, nowMs: NOW })).kind, "not-eligible");
  }
});

it("R2 nonce current <= bound nonce holds without a log read", async () => {
  for (const current of [NONCE - 1n, NONCE]) {
    const r = reads({ accountNonce: async () => current });
    assert.deepEqual(await assessTradeUnknown({ agent, journal: await row(), reads: r.value, nowMs: NOW }),
      { kind: "hold", reason: "nonce-unconsumed" });
    assert.equal(r.calls.logs.length, 0);
  }
});

it("R3-R5 landed, landed-failed and both supersession differences", async () => {
  const landed = await assess();
  assert.equal(landed.kind, "landed");
  if (landed.kind === "landed") assert.equal(landed.evidence.logAbsence.checked, false);
  assert.equal((await assess({ readFinalized: async () => observation({ events: [event(WALLET, NONCE, true, "0x00000001")] }) })).kind, "landed-failed");
  assert.equal((await assess({ readFinalized: async () => observation({ members: [member({ executionData: "0x1234" })] }) })).kind, "superseded");
  assert.equal((await assess({ readFinalized: async () => observation({ members: [member({ keyHash: TX2 })] }) })).kind, "superseded");
});

it("R6 incremented false does not consume the bound nonce", async () => {
  assert.deepEqual(await assess({ readFinalized: async () => observation({ events: [event(WALLET, NONCE, false)] }) }),
    { kind: "hold", reason: "consuming-event-not-found" });
});

it("R7 missing, wrong target, failed receipt, duplicate wallet members or events hold", async () => {
  const cases: Array<TradeUnknownReads["readFinalized"]> = [
    async () => null,
    async () => observation({ to: OTHER }),
    async () => observation({ status: 0n }),
    async () => observation({ members: [member(), member()] }),
    async () => observation({ events: [event(), event()] }),
  ];
  for (const readFinalized of cases) {
    assert.deepEqual(await assess({ readFinalized }), { kind: "hold", reason: "candidate-unverified" });
  }
});

it("R2.5 other-wallet batch is eligible; same-wallet second member holds", async () => {
  assert.equal((await assess({ readFinalized: async () => observation({ members: [member(), member({ eoa: OTHER, nonce: 3n })],
    events: [event(), event(OTHER, 3n)] }) })).kind, "landed");
  assert.deepEqual(await assess({ readFinalized: async () => observation({ members: [member(), member({ nonce: 3n })],
    events: [event(), event(WALLET, 3n)] }) }), { kind: "hold", reason: "candidate-unverified" });
});

it("R3.3 execution attribution survives an other-wallet USDT transfer into this wallet", async () => {
  const transfer = { address: USDT_56, topics: [keccak256(stringToHex("Transfer(address,address,uint256)")),
    padHex(OTHER, { size: 32 }), padHex(WALLET, { size: 32 })], data: toHex(1n, { size: 32 }), logIndex: 3n };
  const verdict = await assess({ readFinalized: async () => observation({ members: [member(), member({ eoa: OTHER, nonce: 3n })],
    events: [event(), event(OTHER, 3n), transfer] }) });
  assert.equal(verdict.kind, "landed");
});

it("N1 an oversized aggregate transaction holds for landed, failed and superseded candidates", async () => {
  const otherData = `0x${"12".repeat(110_000)}` as Hex;
  const others = Array.from({ length: 5 }, (_, index) => member({ eoa: OTHER,
    nonce: BigInt(index + 2), executionData: otherData }));
  for (const [target, receiptEvents] of [
    [member(), [event()]],
    [member(), [event(WALLET, NONCE, true, "0x00000001")]],
    [member({ keyHash: TX2 }), [event()]],
  ] as const) {
    const members = [target, ...others];
    assert.ok(members.every((encoded) => (encoded.length - 2) / 2 <= TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES));
    const obs = observation({ members, events: [...receiptEvents] });
    assert.ok((obs.transaction.input.length - 2) / 2 > TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES);
    assert.equal(decodePortoV055Transaction(56, PORTO_V055_ORCHESTRATOR, obs.transaction.input,
      { memberBytes: TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES,
        executionDataBytes: TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES }).length, 6);
    assert.deepEqual(await assess({ readFinalized: async () => obs }),
      { kind: "hold", reason: "candidate-unverified" });
  }
});

it("N1 exact transaction byte cap reaches decode and one byte over stops before decode", async () => {
  const base = observation();
  const originalBytes = (base.transaction.input.length - 2) / 2;
  for (const bytes of [TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES,
    TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES + 1]) {
    const padded = `${base.transaction.input}${"00".repeat(bytes - originalBytes)}` as Hex;
    let inputReads = 0;
    const obs: TradfiReceiptObservation = { ...base, transaction: { ...base.transaction,
      get input() { inputReads += 1; return padded; } } };
    assert.deepEqual(await assess({ readFinalized: async () => obs }),
      { kind: "hold", reason: "candidate-unverified" });
    assert.equal(inputReads, bytes === TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES ? 2 : 1);
  }
});

it("trade member boundary decodes at 128 KiB and holds one raw member byte over", async () => {
  const encoded = member({ executionData: `0x${"12".repeat(130_048)}` as Hex });
  assert.equal((encoded.length - 2) / 2, TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES);
  const exact = await assess({ readFinalized: async () => observation({ members: [encoded] }) });
  assert.equal(exact.kind, "superseded");
  const over = `${encoded}12` as Hex;
  assert.equal((over.length - 2) / 2, TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES + 1);
  assert.deepEqual(await assess({ readFinalized: async () => observation({ members: [over] }) }),
    { kind: "hold", reason: "candidate-unverified" });
});

it("decoder executionData boundary is exact with an independently widened member envelope", () => {
  const limits = { memberBytes: 2 * TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES,
    executionDataBytes: TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES };
  const atLimit = observation({ members: [member({ executionData:
    `0x${"12".repeat(TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES)}` as Hex })] });
  assert.equal(decodePortoV055Transaction(56, PORTO_V055_ORCHESTRATOR,
    atLimit.transaction.input, limits).length, 1);
  const overLimit = observation({ members: [member({ executionData:
    `0x${"12".repeat(TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES + 1)}` as Hex })] });
  assert.throws(() => decodePortoV055Transaction(56, PORTO_V055_ORCHESTRATOR,
    overLimit.transaction.input, limits), /executionData exceeds 131072 bytes/u);
});

it("R8 conflicting consuming transactions in one chunk hold", async () => {
  const r = reads({ intentExecutedTxHashes: async () => [TX, TX2],
    readFinalized: async (hash) => observation({ hash }) });
  assert.deepEqual(await assessTradeUnknown({ agent, journal: await row(), reads: r.value, nowMs: NOW }),
    { kind: "hold", reason: "candidate-conflict" });
});

it("R9 failed logs and empty logs never resolve", async () => {
  assert.deepEqual(await assess({ intentExecutedTxHashes: async () => { throw new Error("offline"); } }),
    { kind: "hold", reason: "logs-unavailable" });
  assert.deepEqual(await assess({ intentExecutedTxHashes: async () => [] }),
    { kind: "hold", reason: "consuming-event-not-found" });
});

it("R10 inclusive chunks cover exactly 400000 and stop before 400001", async () => {
  assert.equal(TRADE_UNKNOWN_LOG_CHUNK_BLOCKS, 8_000n);
  const exact = reads({ intentExecutedTxHashes: async (_eoa, _nonce, from, to) => {
    exact.calls.logs.push([from, to]); return []; } }, { from: 1_000n, to: 1_000n + TRADE_UNKNOWN_MAX_SCAN_BLOCKS - 1n });
  assert.deepEqual(await assessTradeUnknown({ agent, journal: await row(), reads: exact.value, nowMs: NOW }),
    { kind: "hold", reason: "consuming-event-not-found" });
  assert.equal(exact.calls.logs.length, 50);
  assert.deepEqual(exact.calls.logs[0], [1_000n, 8_999n]);
  assert.deepEqual(exact.calls.logs.at(-1), [393_000n, 400_999n]);
  const oversized = reads({ intentExecutedTxHashes: async () => [] },
    { from: 1_000n, to: 1_000n + TRADE_UNKNOWN_MAX_SCAN_BLOCKS });
  assert.deepEqual(await assessTradeUnknown({ agent, journal: await row(), reads: oversized.value, nowMs: NOW }),
    { kind: "hold", reason: "scan-window-exceeded" });
  const inside = reads({ intentExecutedTxHashes: async (_eoa, _nonce, from) => from === 393_000n ? [TX] : [] },
    { from: 1_000n, to: 1_000n + TRADE_UNKNOWN_MAX_SCAN_BLOCKS });
  assert.equal((await assessTradeUnknown({ agent, journal: await row(), reads: inside.value, nowMs: NOW })).kind, "landed");
});

it("R2.8 an 8000-block window is one call and 8001 uses two contiguous calls", async () => {
  for (const [to, expected] of [[7_999n, [[0n, 7_999n]]],
    [8_000n, [[0n, 7_999n], [8_000n, 8_000n]]]] as const) {
    const ranges: Array<readonly [bigint, bigint]> = [];
    const r = reads({ intentExecutedTxHashes: async (_eoa, _nonce, from, end) => {
      ranges.push([from, end]); return []; } }, { from: 0n, to });
    await assessTradeUnknown({ agent, journal: await row(), reads: r.value, nowMs: NOW });
    assert.deepEqual(ranges, expected);
  }
});

it("R2.8 window timestamp bracket refusal holds", async () => {
  assert.deepEqual(await assess({ blockAtOrBefore: async () => { throw new Error("window-unavailable"); } }),
    { kind: "hold", reason: "window-unavailable" });
});

it("R11 accountNonce encodes getNonce(uint192) and requires two RPCs to agree", async () => {
  const captured: string[] = [];
  const sequences = [1n, 1n];
  const servers = sequences.map((_sequence, index) => createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const parsed = JSON.parse(body) as { readonly id: number; readonly method: string;
      readonly params: readonly [{ readonly data: string }] };
    if (parsed.method === "eth_call") captured.push(parsed.params[0].data);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: toHex((3n << 64n) | sequences[index]!, { size: 32 }) }));
  }));
  try {
    const urls: string[] = [];
    for (const server of servers) {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      urls.push(`http://127.0.0.1:${address.port}`);
    }
    const reads = createTradeUnknownReads({ rpcUrls: [urls[0]!, urls[1]!], logsRpcUrl: urls[0]! });
    assert.equal(await reads.accountNonce(WALLET, 3n, 1_000n), (3n << 64n) | 1n);
    assert.equal(captured.length, 2);
    assert.ok(captured.every((data) => data.startsWith(toFunctionSelector("getNonce(uint192)"))));
    sequences[1] = 2n;
    await assert.rejects(reads.accountNonce(WALLET, 3n, 1_000n), /disagrees/u);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

it("R2.8 factory refuses a timestamp older than its two-million-block bracket", async () => {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const parsed = JSON.parse(body) as { readonly id: number; readonly method: string; readonly params: readonly string[] };
    assert.equal(parsed.method, "eth_getBlockByNumber");
    const latest = parsed.params[0] === "latest";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {
      number: latest ? toHex(2_000_001n) : toHex(1n), hash: BLOCK_HASH,
      timestamp: latest ? toHex(1_000n) : toHex(100n),
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const reads = createTradeUnknownReads({ rpcUrls: ["http://127.0.0.1:1", "http://127.0.0.1:2"],
      logsRpcUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(reads.blockAtOrBefore(99n), /window-unavailable/u);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
