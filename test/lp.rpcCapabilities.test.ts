import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as PortoKey from "porto/viem/Key";
import {
  prepareCalls as portoPrepareCalls,
  sendPreparedCalls as portoSendPreparedCalls,
  signCalls as portoSignCalls,
} from "porto/viem/RelayActions";

import {
  decodePortoV055TransactionInput,
  decodeIntentExecutedLog,
  encodeLpFinalCallsV1,
  INTENT_EXECUTED_TOPIC,
  measureLpRpcCandidate,
  PINNED_PORTO_ALTANA_SANITIZED_FIXTURE,
  LP_FINAL_CALLS_PARAMETERS,
  PORTO_V055_INTENT_PARAMETERS,
  publicBscRpcCandidates,
} from "../src/lp/rpcCapabilities.js";

const TX = `0x${"11".repeat(32)}`;
const ADDRESS = `0x${"22".repeat(20)}`;
const OTHER = `0x${"33".repeat(20)}`;
const TOPIC = `0x${"44".repeat(32)}`;
const BLOCK_HASH = `0x${"55".repeat(32)}`;
const SANITIZED_PORTO_INPUT = sanitizedPortoInput();

describe("Phase 3.9c-0 RPC capability measurement", () => {
  it("pins the public Porto staged exports and selected-key hash boundary", () => {
    assert.equal(typeof portoPrepareCalls, "function");
    assert.equal(typeof portoSignCalls, "function");
    assert.equal(typeof portoSendPreparedCalls, "function");
    const privateKey = `0x${"00".repeat(31)}01` as const;
    const account = privateKeyToAccount(privateKey);
    const selectedKey = PortoKey.fromSecp256k1({
      privateKey,
      role: "session",
      expiry: 123,
      permissions: {
        calls: [{ to: "0x0000000000000000000000000000000000000001" }],
      },
    });
    assert.equal(
      account.publicKey,
      "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
    );
    assert.equal(account.address.toLowerCase(), selectedKey.publicKey);
    assert.equal(selectedKey.publicKey, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    assert.equal(
      PortoKey.hash(selectedKey),
      "0xd523da3646afb69ef792be9d08b3988a3b81847c087cf9627c57417e45140f97",
    );

    const expectedPermissions: {
      readonly calls: readonly [{ readonly to: `0x${string}` }];
    } = {
      calls: [{ to: "0x0000000000000000000000000000000000000001" }],
    };
    const assertRestoredIdentity = (input: {
      readonly candidatePrivateKey: `0x${string}`;
      readonly persistedSec1: `0x${string}`;
      readonly restoredSec1: `0x${string}`;
      readonly selected: typeof selectedKey;
      readonly expectedExpiry: number;
      readonly expectedPermissions: typeof expectedPermissions;
    }): void => {
      const candidateAccount = privateKeyToAccount(input.candidatePrivateKey);
      assert.equal(candidateAccount.publicKey.toLowerCase(), input.persistedSec1.toLowerCase());
      assert.equal(candidateAccount.publicKey.toLowerCase(), input.restoredSec1.toLowerCase());
      assert.equal(candidateAccount.address.toLowerCase(), input.selected.publicKey.toLowerCase());
      assert.equal(input.selected.type, "secp256k1");
      assert.equal(input.selected.role, "session");
      assert.equal(input.selected.expiry, input.expectedExpiry);
      assert.deepEqual(input.selected.permissions, input.expectedPermissions);
    };
    const validIdentity = {
      candidatePrivateKey: privateKey,
      persistedSec1: account.publicKey,
      restoredSec1: account.publicKey,
      selected: selectedKey,
      expectedExpiry: 123,
      expectedPermissions,
    } as const;
    assert.doesNotThrow(() => assertRestoredIdentity(validIdentity));

    const otherPrivateKey = `0x${"00".repeat(31)}02` as const;
    const otherSelectedKey = PortoKey.fromSecp256k1({
      privateKey: otherPrivateKey,
      role: "session",
      expiry: 123,
      permissions: expectedPermissions,
    });
    const corruptedSec1 = `${account.publicKey.slice(0, -2)}00` as `0x${string}`;
    assert.throws(() => assertRestoredIdentity({ ...validIdentity, restoredSec1: corruptedSec1 }));
    assert.throws(() => assertRestoredIdentity({
      ...validIdentity,
      candidatePrivateKey: otherPrivateKey,
    }));
    assert.throws(() => assertRestoredIdentity({ ...validIdentity, selected: otherSelectedKey }));
    assert.throws(() => assertRestoredIdentity({ ...validIdentity, expectedExpiry: 124 }));
    assert.throws(() => assertRestoredIdentity({
      ...validIdentity,
      expectedPermissions: {
        calls: [{ to: "0x0000000000000000000000000000000000000002" }],
      },
    }));

    const callA = { to: "0x0000000000000000000000000000000000000001" } as const;
    const callB = {
      to: "0x0000000000000000000000000000000000000002",
      value: 7n,
      data: "0x1234",
    } as const;
    assert.equal(
      encodeLpFinalCallsV1([callA]),
      encodeLpFinalCallsV1([{ ...callA, value: 0n, data: "0x" }]),
      "omitted value/data must be exact zero/empty defaults",
    );
    assert.notEqual(
      encodeLpFinalCallsV1([callA, callB]),
      encodeLpFinalCallsV1([callB, callA]),
      "call order is committed and cannot be normalized",
    );
  });

  it("inventories multiple URLs without mistaking one operator's aliases for independence", () => {
    const candidates = publicBscRpcCandidates();
    assert.ok(candidates.length >= 8);
    assert.ok(new Set(candidates.map((candidate) => candidate.operator)).size >= 6);
    assert.ok(
      candidates.filter((candidate) => candidate.operator === "bnb-chain").length >= 2,
      "the inventory must demonstrate URL count != operator count",
    );
  });

  it("measures finalized, receipt, exact logs and ordered historical ranges", async () => {
    const calls: Array<{ readonly method: string; readonly params: readonly unknown[] }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        readonly id: number;
        readonly method: string;
        readonly params: readonly unknown[];
      };
      calls.push({ method: body.method, params: body.params });
      const result = responseFor(body.method, body.params);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };

    const report = await measureLpRpcCandidate({
      candidate: { label: "fixture", operator: "fixture-op", url: "https://fixture.invalid" },
      referenceTxHash: TX,
      logAddress: ADDRESS,
      rangeSpans: [10_000, 1, 100],
      sequentialChunkWidth: 10,
      sequentialChunkCount: 3,
      timeoutMs: 100,
      fetch,
      now: () => new Date("2026-08-19T00:00:00.000Z"),
    });

    assert.equal(report.chainId.ok && report.chainId.value, 56n);
    assert.equal(report.finalizedBlock.ok && report.finalizedBlock.value, 98n);
    assert.equal(report.finalizedBlockLogs.ok, true);
    assert.equal(report.receipt.ok && report.receipt.value.blockNumber, 90n);
    assert.equal(report.receipt.ok && report.receipt.value.status, 1n);
    assert.equal(report.receipt.ok && report.receipt.value.blockHash, BLOCK_HASH);
    assert.equal(report.receipt.ok && report.receipt.value.intentExecuted.length, 1);
    assert.equal(
      report.receipt.ok && report.receipt.value.intentExecuted[0]?.nonce,
      PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.nonce,
    );
    assert.equal(
      report.transaction.ok && report.transaction.value.portoIntentIdentities[0]?.keyHash,
      PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.keyHash,
    );
    assert.equal(
      report.referenceFullBlock.ok && report.referenceFullBlock.value.containsReferenceTx,
      true,
    );
    assert.equal(report.exactBlockContainsReceiptLogs, true);
    assert.deepEqual(report.ranges.map((range) => range.span), [1, 100, 10_000]);
    assert.deepEqual(
      report.ranges.map((range) => range.fromBlock),
      [90n, 0n, 0n],
    );
    assert.deepEqual(
      report.sequentialChunks.map((range) => [range.fromBlock, range.toBlock]),
      [[61n, 70n], [71n, 80n], [81n, 90n]],
    );
    assert.deepEqual(
      calls.filter((call) => call.method === "eth_getLogs").map((call) => call.params),
      [
        [{ address: ADDRESS, fromBlock: "0x62", toBlock: "0x62" }],
        [{ address: ADDRESS, fromBlock: "0x5a", toBlock: "0x5a" }],
        [{ address: ADDRESS, fromBlock: "0x0", toBlock: "0x5a" }],
        [{ address: ADDRESS, fromBlock: "0x0", toBlock: "0x5a" }],
        [{ address: ADDRESS, fromBlock: "0x3d", toBlock: "0x46" }],
        [{ address: ADDRESS, fromBlock: "0x47", toBlock: "0x50" }],
        [{ address: ADDRESS, fromBlock: "0x51", toBlock: "0x5a" }],
      ],
    );
  });

  it("records an RPC refusal per capability and continues without turning it into absence", async () => {
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        readonly id: number;
        readonly method: string;
        readonly params?: readonly unknown[];
      };
      if (body.method === "eth_getLogs") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32005, message: "limit exceeded at https://secret.invalid/token" },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "eth_chainId"
            ? "0x38"
            : body.method === "eth_blockNumber"
              ? "0x64"
              : body.method === "eth_getBlockByNumber" && body.params?.[1] === true
                ? fullBlock()
                : body.method === "eth_getBlockByNumber"
                  ? { number: "0x62" }
                : body.method === "eth_getTransactionReceipt"
                  ? receipt([])
                  : transaction(),
      });
    };

    const report = await measureLpRpcCandidate({
      candidate: { label: "fixture", operator: "fixture-op", url: "https://credential.invalid/key" },
      referenceTxHash: TX,
      logAddress: ADDRESS,
      rangeSpans: [1],
      timeoutMs: 100,
      fetch,
    });

    assert.equal(report.exactBlockLogs.ok, false);
    assert.equal(report.finalizedBlockLogs.ok, false);
    if (report.exactBlockLogs.ok) assert.fail("expected refusal");
    assert.doesNotMatch(report.exactBlockLogs.error, /secret\.invalid|credential\.invalid/u);
    assert.equal(report.exactBlockContainsReceiptLogs, null);
    assert.equal(report.ranges[0]?.result.ok, false);
  });

  it("does not call an empty receipt/log intersection complete", async () => {
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        readonly id: number;
        readonly method: string;
        readonly params: readonly unknown[];
      };
      const result =
        body.method === "eth_chainId"
          ? "0x38"
          : body.method === "eth_blockNumber"
            ? "0x64"
            : body.method === "eth_getBlockByNumber" && body.params[1] === true
              ? {
                  number: "0x5a",
                  hash: BLOCK_HASH,
                  timestamp: "0x65",
                  transactions: [transaction()],
                }
              : body.method === "eth_getBlockByNumber"
                ? { number: "0x62" }
                : body.method === "eth_getTransactionReceipt"
                  ? receipt([])
                  : body.method === "eth_getLogs"
                    ? []
                    : transaction();
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };

    const report = await measureLpRpcCandidate({
      candidate: { label: "fixture", operator: "fixture-op", url: "https://fixture.invalid" },
      referenceTxHash: TX,
      logAddress: ADDRESS,
      rangeSpans: [1],
      timeoutMs: 100,
      fetch,
    });
    assert.equal(report.receipt.ok && report.receipt.value.matchingLogIds.length, 0);
    assert.equal(report.exactBlockLogs.ok, true);
    assert.equal(report.exactBlockContainsReceiptLogs, null);
  });

  it("refuses malformed configuration before making a request", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      return Response.json({ result: "0x38" });
    };
    await assert.rejects(
      measureLpRpcCandidate({
        candidate: { label: "fixture", operator: "fixture-op", url: "https://fixture.invalid" },
        referenceTxHash: "not-a-hash",
        logAddress: ADDRESS,
        rangeSpans: [1],
        timeoutMs: 100,
        fetch,
      }),
      /referenceTxHash/u,
    );
    assert.equal(calls, 0);
  });

  it("decodes the Porto 0.5.5 layout from a synthetic decoder unit vector", () => {
    const [identity] = decodePortoV055TransactionInput(SANITIZED_PORTO_INPUT);
    assert.equal(identity?.eoa, PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.eoa);
    assert.equal(identity?.nonce, PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.nonce);
    assert.equal(identity?.expiry, PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.expiry);
    assert.equal(
      identity?.executionDataHash,
      PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.executionDataHash,
    );
    assert.equal(identity?.keyHash, PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.keyHash);
    assert.equal(
      identity?.signaturePrehash,
      PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.signaturePrehash,
    );
  });

  it("recomputes every claimed field from the pinned public transaction and receipt witness", () => {
    const fixture = PINNED_PORTO_ALTANA_SANITIZED_FIXTURE;
    const rawInput = fixture.rawTransactionInput;
    assert.equal(fixture.rawTransaction.hash, fixture.transactionHash);
    assert.equal(fixture.rawTransaction.to, fixture.orchestrator);
    assert.equal(BigInt(fixture.rawTransaction.blockNumber), fixture.blockNumber);
    assert.equal(fixture.rawTransaction.blockHash, fixture.blockHash);
    assert.equal(
      BigInt(fixture.rawTransaction.transactionIndex),
      fixture.transactionIndex,
    );
    assert.equal(BigInt(fixture.rawBlockTimestamp), fixture.blockTimestamp);
    assert.equal(rawInput.slice(0, 10), fixture.selector);
    assert.equal((rawInput.length - 2) / 2, fixture.rawInputBytes);
    assert.equal(keccak256(rawInput), fixture.rawInputHash);

    const decodedCall = decodeFunctionData({
      abi: parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4 err)"]),
      data: rawInput,
    });
    const encodedIntent = decodedCall.args[0];
    assert.equal((encodedIntent.length - 2) / 2, fixture.rawEncodedIntentBytes);
    assert.equal(keccak256(encodedIntent), fixture.rawEncodedIntentHash);
    const [rawIntent] = decodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, encodedIntent);
    assert.equal(rawIntent.eoa.toLowerCase(), fixture.eoa);
    assert.equal(rawIntent.nonce, fixture.nonce);
    assert.equal(rawIntent.expiry, fixture.expiry);
    assert.equal(rawIntent.executionData.toLowerCase(), fixture.sanitizedExecutionData);
    const [realCalls] = decodeAbiParameters(
      LP_FINAL_CALLS_PARAMETERS,
      rawIntent.executionData,
    );
    assert.equal(realCalls.length, 4);
    const reencodedCalls = encodeLpFinalCallsV1(realCalls.map((call) => ({
      to: call.target,
      value: call.value,
      data: call.data,
    })));
    assert.equal(reencodedCalls, rawIntent.executionData);
    assert.equal(keccak256(reencodedCalls), fixture.executionDataHash);

    const [identity] = decodePortoV055TransactionInput(rawInput);
    assert.equal(identity?.intentIndex, 0);
    assert.equal(identity?.encodedIntentHash, fixture.rawEncodedIntentHash);
    assert.equal(identity?.eoa, fixture.eoa);
    assert.equal(identity?.nonce, fixture.nonce);
    assert.equal(identity?.expiry, fixture.expiry);
    assert.equal(
      (fixture.sanitizedExecutionData.length - 2) / 2,
      fixture.executionDataBytes,
    );
    assert.equal(keccak256(fixture.sanitizedExecutionData), fixture.executionDataHash);
    assert.equal(identity?.executionDataHash, fixture.executionDataHash);
    assert.equal(identity?.keyHash, fixture.keyHash);
    assert.equal(identity?.signaturePrehash, fixture.signaturePrehash);

    const rawReceipt = fixture.rawReceipt;
    assert.equal(BigInt(rawReceipt.status), fixture.receiptStatus);
    assert.equal(BigInt(rawReceipt.blockNumber), fixture.blockNumber);
    assert.equal(rawReceipt.blockHash, fixture.blockHash);
    assert.equal(rawReceipt.transactionHash, fixture.transactionHash);
    assert.equal(BigInt(rawReceipt.transactionIndex), fixture.transactionIndex);

    const rawLog = fixture.rawReceiptLog;
    const [event] = decodeIntentExecutedLog({
      address: rawLog.address,
      blockNumber: BigInt(rawLog.blockNumber),
      blockHash: rawLog.blockHash,
      transactionHash: rawLog.transactionHash,
      transactionIndex: BigInt(rawLog.transactionIndex),
      logIndex: BigInt(rawLog.logIndex),
      topics: rawLog.topics,
      data: rawLog.data,
    });
    assert.equal(rawLog.address, fixture.orchestrator);
    assert.equal(rawLog.topics[0], INTENT_EXECUTED_TOPIC);
    assert.equal(rawLog.removed, false);
    assert.equal(event?.eoa, fixture.eoa);
    assert.equal(event?.nonce, fixture.nonce);
    assert.equal(event?.incremented, fixture.eventIncremented);
    assert.equal(event?.err, fixture.eventErr);
    assert.equal(event?.blockNumber, fixture.blockNumber);
    assert.equal(event?.blockHash, fixture.blockHash);
    assert.equal(event?.transactionHash, fixture.transactionHash);
    assert.equal(event?.transactionIndex, fixture.transactionIndex);
    assert.equal(event?.logIndex, fixture.eventLogIndex);
  });

  it("rejects unknown calldata selectors instead of guessing an intent layout", () => {
    assert.throws(
      () => decodePortoV055TransactionInput(`0xdeadbeef${"00".repeat(32)}`),
      /not Porto Orchestrator 0\.5\.5/u,
    );
  });

  it("decodes every member of the Porto execute(bytes[]) overload", () => {
    const singleAbi = parseAbi([
      "function execute(bytes encodedIntent) payable returns (bytes4 err)",
    ]);
    const single = decodeFunctionData({ abi: singleAbi, data: SANITIZED_PORTO_INPUT });
    const encodedIntent = single.args[0];
    const batch = encodeFunctionData({
      abi: parseAbi([
        "function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)",
      ]),
      functionName: "execute",
      args: [[encodedIntent, encodedIntent]],
    });
    assert.deepEqual(
      decodePortoV055TransactionInput(batch).map((identity) => identity.intentIndex),
      [0, 1],
    );
  });
});

function responseFor(method: string, params: readonly unknown[]): unknown {
  if (method === "eth_chainId") return "0x38";
  if (method === "eth_blockNumber") return "0x64";
  if (method === "eth_getBlockByNumber") {
    if (params[1] === true) {
      return {
        number: "0x5a",
        hash: BLOCK_HASH,
        timestamp: "0x65",
        transactions: [transaction()],
      };
    }
    return { number: "0x62" };
  }
  if (method === "eth_getTransactionByHash") return transaction();
  if (method === "eth_getTransactionReceipt") {
    return {
      status: "0x1",
      blockNumber: "0x5a",
      blockHash: BLOCK_HASH,
      transactionHash: TX,
      transactionIndex: "0x2",
      logs: [log(ADDRESS, 3n), log(OTHER, 4n), intentExecutedLog()],
    };
  }
  if (method === "eth_getLogs") {
    const filter = params[0] as { readonly fromBlock: string; readonly toBlock: string };
    assert.ok(filter.fromBlock.startsWith("0x"));
    assert.ok(filter.toBlock.startsWith("0x"));
    return [log(ADDRESS, 3n)];
  }
  throw new Error(`unexpected method ${method}`);
}

function log(address: string, index: bigint): unknown {
  return {
    address,
    blockNumber: "0x5a",
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    transactionIndex: "0x2",
    logIndex: `0x${index.toString(16)}`,
    topics: [TOPIC],
    data: "0x",
  };
}

function transaction(): unknown {
  return {
    hash: TX,
    blockNumber: "0x5a",
    blockHash: BLOCK_HASH,
    transactionIndex: "0x2",
    from: OTHER,
    to: PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.orchestrator,
    input: SANITIZED_PORTO_INPUT,
  };
}

function fullBlock(): unknown {
  return {
    number: "0x5a",
    hash: BLOCK_HASH,
    timestamp: "0x65",
    transactions: [transaction()],
  };
}

function receipt(logs: readonly unknown[]): unknown {
  return {
    status: "0x1",
    blockNumber: "0x5a",
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    transactionIndex: "0x2",
    logs,
  };
}

function intentExecutedLog(): unknown {
  return {
    address: PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.orchestrator,
    blockNumber: "0x5a",
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    transactionIndex: "0x2",
    logIndex: "0x5",
    topics: [
      INTENT_EXECUTED_TOPIC,
      `0x${PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.eoa.slice(2).padStart(64, "0")}`,
      `0x${PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.nonce.toString(16).padStart(64, "0")}`,
    ],
    data: encodeAbiParameters(
      [{ type: "bool" }, { type: "bytes4" }],
      [true, "0x00000000"],
    ),
  };
}

function sanitizedPortoInput(): `0x${string}` {
  const encodedIntent = encodeAbiParameters(
    [{
      type: "tuple",
      components: [
        { name: "eoa", type: "address" },
        { name: "executionData", type: "bytes" },
        { name: "nonce", type: "uint256" },
        { name: "payer", type: "address" },
        { name: "paymentToken", type: "address" },
        { name: "paymentMaxAmount", type: "uint256" },
        { name: "combinedGas", type: "uint256" },
        { name: "encodedPreCalls", type: "bytes[]" },
        { name: "encodedFundTransfers", type: "bytes[]" },
        { name: "settler", type: "address" },
        { name: "expiry", type: "uint256" },
        { name: "isMultichain", type: "bool" },
        { name: "funder", type: "address" },
        { name: "funderSignature", type: "bytes" },
        { name: "settlerContext", type: "bytes" },
        { name: "paymentAmount", type: "uint256" },
        { name: "paymentRecipient", type: "address" },
        { name: "signature", type: "bytes" },
        { name: "paymentSignature", type: "bytes" },
        { name: "supportedAccountImplementation", type: "address" },
      ],
    }],
    [{
      eoa: PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.eoa,
      executionData: PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.sanitizedExecutionData,
      nonce: PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.nonce,
      payer: "0x0000000000000000000000000000000000000000",
      paymentToken: "0x0000000000000000000000000000000000000000",
      paymentMaxAmount: 0n,
      combinedGas: 1n,
      encodedPreCalls: [],
      encodedFundTransfers: [],
      settler: "0x0000000000000000000000000000000000000000",
      expiry: PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.expiry,
      isMultichain: false,
      funder: "0x0000000000000000000000000000000000000000",
      funderSignature: "0x",
      settlerContext: "0x",
      paymentAmount: 0n,
      paymentRecipient: "0x0000000000000000000000000000000000000000",
      signature: `0x${"00".repeat(65)}${PINNED_PORTO_ALTANA_SANITIZED_FIXTURE.keyHash.slice(2)}00`,
      paymentSignature: "0x",
      supportedAccountImplementation: "0x0000000000000000000000000000000000000000",
    }],
  );
  return encodeFunctionData({
    abi: parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4 err)"]),
    functionName: "execute",
    args: [encodedIntent],
  });
}
