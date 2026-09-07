/**
 * Offline tests for the relay-independent recovery path.
 *
 * These two methods are the entire self-custody claim: if 4lpha and Altana both
 * vanish, `ownerRecover` gets the money out and `ownerRevokeSessionDirect`
 * kills the agent's key. They are also the two methods that cannot be
 * exercised in CI against a real chain — every run costs real BNB — so they are
 * driven here through an injected transport that scripts the RPC.
 *
 * What is being protected:
 *   - the sweep's value arithmetic. It sends `balance - fee`, so an
 *     over-budgeted fee donates the difference to the validator and an
 *     under-budgeted one strands the transaction;
 *   - the transaction hash. A rejected receipt wait means "unknown", not
 *     "did not happen"; dropping the hash leaves the user unable to check;
 *   - the revert narrowing. `KeyDoesNotExist()` is expected on Altana and
 *     tolerated. Any other revert must NOT be swallowed, or a failed kill
 *     switch reports as a fired one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  numberToHex,
  parseEther,
  parseTransaction,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB_TESTNET } from "@altananetwork/sdk";
import {
  AltanaProvider,
  ownerAuthorityFromPrivateKey,
} from "../src/wallet/altana.js";
import { REVERT_SELECTORS } from "../src/core/errors.js";
import type { AgentWalletRef } from "../src/core/types.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const OWNER_KEY = `0x${"11".repeat(32)}` as Hex;
const OWNER = ownerAuthorityFromPrivateKey(OWNER_KEY);
const WALLET_ADDRESS = getAddress(privateKeyToAccount(OWNER_KEY).address);

const DESTINATION = getAddress("0x000000000000000000000000000000000000dEaD");
const CONTRACT_DESTINATION = getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E");
const SESSION_ADDRESS = getAddress("0x00000000000000000000000000000000000d3ad1");
const SESSION_PUBLIC_KEY = `0x${"ab".repeat(64)}` as Hex;

const WALLET: AgentWalletRef = {
  address: WALLET_ADDRESS,
  chainId: BNB_TESTNET.chainId,
  ownerAddress: WALLET_ADDRESS,
  custodyModel: "self-eoa",
};

const IS_VALID_KEY = toFunctionSelector("isValidKey(address,bytes32)");
const REVOKE_KEY = toFunctionSelector("revokeKey(address,bytes32)");
const GET_KEYS = toFunctionSelector("getKeys()");
const ACCOUNT_REVOKE = toFunctionSelector("revoke(bytes32)");

const BOOL_TRUE = encodeAbiParameters([{ type: "bool" }], [true]);
const BOOL_FALSE = encodeAbiParameters([{ type: "bool" }], [false]);

/**
 * A JSON-RPC error carrying a numeric `code`, the way a real node answers.
 *
 * Without a code viem assumes the failure is transient and retries with
 * backoff — which is correct against a real endpoint and turns every scripted
 * failure here into a second of dead time.
 */
class RpcError extends Error {
  readonly code: number;

  constructor(message: string, code = -32000) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** A signed transaction the scripted node accepted. */
type SentTransaction = {
  readonly to: Address | undefined;
  readonly value: bigint;
  readonly gas: bigint;
  readonly gasPrice: bigint;
  readonly data: Hex | undefined;
};

type NodeScript = {
  /** Wallet balance for `eth_getBalance`. */
  readonly balance?: bigint;
  readonly gasPrice?: bigint;
  readonly estimatedGas?: bigint;
  /** Bytecode at the sweep destination. `0x` means an EOA. */
  readonly destinationCode?: Hex;
  readonly chainId?: number;
  /** Thrown from `eth_sendRawTransaction` for the nth send (0-based). */
  readonly sendErrors?: Readonly<Record<number, Error>>;
  /** `isValidKey` answers, consumed in order. Last value repeats. */
  readonly isValidKey?: readonly boolean[];
  /** Key hashes `getKeys()` reports. `undefined` makes the read revert. */
  readonly accountKeyHashes?: readonly Hex[] | undefined;
  /** Never return a receipt, forcing the wait to time out. */
  readonly withholdReceipt?: boolean;
  readonly receiptStatus?: "0x1" | "0x0";
};

type ScriptedNode = {
  readonly transport: (rpcUrl: string) => Transport;
  readonly sent: SentTransaction[];
  readonly calls: string[];
};

/**
 * A scripted JSON-RPC endpoint.
 *
 * Deliberately literal rather than a mocking framework: the assertions are
 * about exact wei amounts and exact gas limits, so the test has to be able to
 * decode the signed transaction the provider actually broadcast.
 */
function scriptedNode(script: NodeScript = {}): ScriptedNode {
  const sent: SentTransaction[] = [];
  const calls: string[] = [];
  let validKeyIndex = 0;

  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    calls.push(method);
    const args = (params ?? []) as readonly unknown[];

    switch (method) {
      case "eth_chainId":
        return numberToHex(script.chainId ?? BNB_TESTNET.chainId);
      case "eth_getBalance":
        return numberToHex(script.balance ?? parseEther("1"));
      case "eth_gasPrice":
        return numberToHex(script.gasPrice ?? 3_000_000_000n);
      case "eth_estimateGas":
        return numberToHex(script.estimatedGas ?? 21_000n);
      case "eth_getCode":
        return script.destinationCode ?? "0x";
      case "eth_getTransactionCount":
        return numberToHex(7);
      case "eth_blockNumber":
        return numberToHex(1_000_000);
      case "eth_getBlockByNumber":
        // No `baseFeePerGas`: BSC transactions are priced the legacy way, and
        // the sweep sets `gasPrice` explicitly for exactly that reason.
        return {
          number: numberToHex(1_000_000),
          hash: `0x${"ee".repeat(32)}`,
          parentHash: `0x${"ff".repeat(32)}`,
          timestamp: numberToHex(1_700_000_000),
          gasLimit: numberToHex(30_000_000),
          gasUsed: "0x0",
          miner: zeroAddress,
          transactions: [],
          nonce: "0x0000000000000000",
          difficulty: "0x0",
          extraData: "0x",
          logsBloom: `0x${"00".repeat(256)}`,
          size: "0x0",
        };
      case "eth_call": {
        const call = args[0] as { data?: Hex; to?: Address };
        const data = call.data ?? "0x";
        if (data.startsWith(IS_VALID_KEY)) {
          const answers = script.isValidKey ?? [false];
          const answer =
            answers[Math.min(validKeyIndex, answers.length - 1)] ?? false;
          validKeyIndex += 1;
          return answer ? BOOL_TRUE : BOOL_FALSE;
        }
        if (data.startsWith(GET_KEYS)) {
          if (script.accountKeyHashes === undefined) {
            throw new RpcError("execution reverted");
          }
          return encodeAbiParameters(
            [
              {
                type: "tuple[]",
                components: [
                  { type: "uint40" },
                  { type: "uint8" },
                  { type: "bool" },
                  { type: "bytes" },
                ],
              },
              { type: "bytes32[]" },
            ],
            [[], script.accountKeyHashes],
          );
        }
        throw new RpcError(`unscripted eth_call ${data.slice(0, 10)}`);
      }
      case "eth_sendRawTransaction": {
        const failure = script.sendErrors?.[sent.length];
        if (failure !== undefined) {
          // Record nothing: a rejected broadcast is not a sent transaction,
          // but it DOES advance the index the script keys errors by.
          sent.push({ to: undefined, value: 0n, gas: 0n, gasPrice: 0n, data: undefined });
          throw failure;
        }
        const parsed = parseTransaction(args[0] as Hex);
        sent.push({
          to: parsed.to === null ? undefined : parsed.to,
          value: parsed.value ?? 0n,
          gas: parsed.gas ?? 0n,
          gasPrice: "gasPrice" in parsed ? (parsed.gasPrice ?? 0n) : 0n,
          data: parsed.data,
        });
        return `0x${(sent.length).toString(16).padStart(64, "0")}`;
      }
      case "eth_getTransactionReceipt": {
        if (script.withholdReceipt === true) return null;
        return {
          transactionHash: args[0],
          blockNumber: numberToHex(1_000_000),
          blockHash: `0x${"cd".repeat(32)}`,
          transactionIndex: "0x0",
          status: script.receiptStatus ?? "0x1",
          from: WALLET_ADDRESS,
          to: DESTINATION,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          contractAddress: null,
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          effectiveGasPrice: "0x1",
          type: "0x0",
        };
      }
      default:
        // -32601: the node does not implement it. viem probes optional
        // methods such as `eth_fillTransaction` and has to be told "no"
        // rather than "try again in a moment".
        throw new RpcError(`unscripted RPC method ${method}`, -32601);
    }
  };

  return {
    transport: () => custom({ request }),
    sent,
    calls,
  };
}

function providerFor(node: ScriptedNode, receiptTimeoutMs = 5_000): AltanaProvider {
  return new AltanaProvider({
    network: BNB_TESTNET,
    rpcUrls: ["mock://node"],
    transport: node.transport,
    receiptTimeoutMs,
  });
}

/** A viem-shaped error carrying a revert selector in its details. */
function revertError(selector: Hex): Error {
  return new RpcError(`execution reverted, unrecognized custom error ${selector}`);
}

/* -------------------------------------------------------------------------- */
/* ownerRecover                                                               */
/* -------------------------------------------------------------------------- */

describe("ownerRecover", () => {
  it("sweeps balance minus the exact fee it budgeted", async () => {
    const node = scriptedNode({
      balance: parseEther("1"),
      gasPrice: 3_000_000_000n,
    });

    const receipt = await providerFor(node).ownerRecoverNative({
      wallet: WALLET,
      owner: OWNER,
      to: DESTINATION,
    });

    assert.equal(receipt.status, "CONFIRMED");
    const tx = node.sent[0];
    assert.ok(tx !== undefined);
    // 25% price headroom, 21000 intrinsic gas for a codeless destination.
    const expectedGasPrice = (3_000_000_000n * 125n) / 100n;
    assert.equal(tx.gasPrice, expectedGasPrice);
    assert.equal(tx.gas, 21_000n);
    assert.equal(tx.value, parseEther("1") - 21_000n * expectedGasPrice);
    assert.equal(tx.to?.toLowerCase(), DESTINATION.toLowerCase());
  });

  it("clamps gas to the intrinsic cost when the destination has no code", async () => {
    // An RPC that over-estimates a plain transfer would otherwise silently
    // hand the difference to the validator.
    const node = scriptedNode({ estimatedGas: 900_000n, destinationCode: "0x" });

    await providerFor(node).ownerRecoverNative({
      wallet: WALLET,
      owner: OWNER,
      to: DESTINATION,
    });

    assert.equal(node.sent[0]?.gas, 21_000n);
    assert.equal(node.calls.includes("eth_estimateGas"), false);
  });

  it("estimates with headroom for a destination that has code", async () => {
    const node = scriptedNode({
      destinationCode: "0x6080604052",
      estimatedGas: 40_000n,
    });

    await providerFor(node).ownerRecoverNative({
      wallet: WALLET,
      owner: OWNER,
      to: CONTRACT_DESTINATION,
    });

    assert.equal(node.sent[0]?.gas, (40_000n * 125n) / 100n);
  });

  it("refuses an absurd gas estimate rather than overpaying", async () => {
    const node = scriptedNode({
      destinationCode: "0x6080604052",
      estimatedGas: 10_000_000n,
    });

    await assert.rejects(
      providerFor(node).ownerRecoverNative({
        wallet: WALLET,
        owner: OWNER,
        to: CONTRACT_DESTINATION,
      }),
      /exceeds the .* ceiling/,
    );
    assert.equal(node.sent.length, 0);
  });

  it("throws when the balance cannot cover the fee", async () => {
    const node = scriptedNode({ balance: 1_000n, gasPrice: 3_000_000_000n });

    await assert.rejects(
      providerFor(node).ownerRecoverNative({ wallet: WALLET, owner: OWNER, to: DESTINATION }),
      /does not cover the gas/i,
    );
    assert.equal(node.sent.length, 0);
  });

  it("throws when the balance exactly equals the fee, rather than sending zero", async () => {
    const gasPrice = 2_000_000_000n;
    const fee = 21_000n * ((gasPrice * 125n) / 100n);
    const node = scriptedNode({ balance: fee, gasPrice });

    await assert.rejects(
      providerFor(node).ownerRecoverNative({ wallet: WALLET, owner: OWNER, to: DESTINATION }),
      /does not cover the gas/i,
    );
  });

  it("rejects the zero address as a destination", async () => {
    const node = scriptedNode();

    await assert.rejects(
      providerFor(node).ownerRecoverNative({ wallet: WALLET, owner: OWNER, to: zeroAddress }),
      /zero address/i,
    );
    assert.equal(node.calls.length, 0);
  });

  it("refuses passkey custody ON CUSTODY, before it can look like a missing key", async () => {
    // PHASE1.5 R2c. Under passkey custody there is no secp256k1 owner key to
    // originate a sweep with, and `wallet.ownerAddress` is a DERIVED IDENTITY
    // that cannot receive funds — so a sweep aimed at it would be burned. The
    // refusal names custody rather than falling through to "requires a
    // private-key owner authority", which is true and useless: it reads as
    // "supply a key" for a model in which no key exists.
    const node = scriptedNode();

    await assert.rejects(
      providerFor(node).ownerRecoverNative({
        wallet: { ...WALLET, custodyModel: "passkey" },
        owner: OWNER,
        to: DESTINATION,
      }),
      /passkey custody/i,
    );
    assert.equal(node.calls.length, 0, "refused before any RPC");
    assert.equal(node.sent.length, 0);
  });

  it("rejects an owner that does not control the wallet", async () => {
    const node = scriptedNode();

    await assert.rejects(
      providerFor(node).ownerRecoverNative({
        wallet: { ...WALLET, address: DESTINATION },
        owner: OWNER,
        to: CONTRACT_DESTINATION,
      }),
      /does not control the wallet/i,
    );
  });

  it("returns PENDING with the hash when the receipt wait fails", async () => {
    // The transaction is signed and broadcast. Losing the hash here would
    // leave the user unable to look it up or safely decide to retry.
    const node = scriptedNode({ withholdReceipt: true });

    const receipt = await providerFor(node, 30).ownerRecoverNative({
      wallet: WALLET,
      owner: OWNER,
      to: DESTINATION,
    });

    assert.equal(receipt.status, "PENDING");
    assert.match(receipt.transactionHash ?? "", /^0x[0-9a-f]{64}$/);
  });

  it("reports a reverted sweep as FAILED, with the hash", async () => {
    const node = scriptedNode({ receiptStatus: "0x0" });

    const receipt = await providerFor(node).ownerRecoverNative({
      wallet: WALLET,
      owner: OWNER,
      to: DESTINATION,
    });

    assert.equal(receipt.status, "FAILED");
    assert.ok(receipt.transactionHash !== undefined);
  });

  it("refuses to act when no endpoint serves the configured chain", async () => {
    // A mainnet RPC under a testnet config would sign testnet-shaped
    // transactions and broadcast them to mainnet.
    const node = scriptedNode({ chainId: 56 });

    await assert.rejects(
      providerFor(node).ownerRecoverNative({ wallet: WALLET, owner: OWNER, to: DESTINATION }),
      /No configured RPC endpoint served chain 97/,
    );
    assert.equal(node.sent.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* ownerRevokeSessionDirect                                                   */
/* -------------------------------------------------------------------------- */

describe("ownerRevokeSessionDirect", () => {
  it("revokes through the KeyStore and reads the post-condition back", async () => {
    const node = scriptedNode({
      // registered before, gone after
      isValidKey: [true, false],
      accountKeyHashes: [],
    });

    const result = await providerFor(node).ownerRevokeSessionDirect({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });

    assert.equal(result.revoked, true);
    assert.equal(result.keyStoreRegistered, false);
    assert.equal(result.keyStoreRevoke?.status, "CONFIRMED");
    assert.equal(result.accountKeyPresent, false);

    const accountTx = node.sent[0];
    const keyStoreTx = node.sent[1];
    assert.ok(accountTx?.data?.startsWith(ACCOUNT_REVOKE));
    assert.ok(keyStoreTx?.data?.startsWith(REVOKE_KEY));
    assert.equal(
      keyStoreTx?.to?.toLowerCase(),
      BNB_TESTNET.keyStore.toLowerCase(),
    );
  });

  it("tolerates KeyDoesNotExist from the account-level revoke", async () => {
    // Expected on Altana: session authority lives in the KeyStore, so the
    // account has no entry to strip.
    const node = scriptedNode({
      sendErrors: { 0: revertError(REVERT_SELECTORS.KeyDoesNotExist) },
      isValidKey: [true, false],
      accountKeyHashes: undefined,
    });

    const result = await providerFor(node).ownerRevokeSessionDirect({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });

    assert.equal(result.accountKeyAbsent, true);
    assert.equal(result.accountRevoke.status, "FAILED");
    assert.equal(result.revoked, true);
    assert.equal(result.accountKeyPresent, undefined);
  });

  it("rethrows any OTHER revert instead of swallowing it", async () => {
    // The bare `catch {}` this replaced treated every failure as "no
    // account-level key entry", so a genuinely broken kill switch reported as
    // a fired one.
    const node = scriptedNode({
      sendErrors: { 0: revertError(REVERT_SELECTORS.Unauthorized) },
      isValidKey: [true],
    });

    await assert.rejects(
      providerFor(node).ownerRevokeSessionDirect({
        wallet: WALLET,
        owner: OWNER,
        sessionAddress: SESSION_ADDRESS,
        sessionPublicKey: SESSION_PUBLIC_KEY,
      }),
      (error: unknown) =>
        error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("rethrows a non-revert send failure", async () => {
    const node = scriptedNode({
      sendErrors: {
        0: new RpcError("HTTP request failed. Status: 503 Service Unavailable"),
      },
    });

    await assert.rejects(
      providerFor(node).ownerRevokeSessionDirect({
        wallet: WALLET,
        owner: OWNER,
        sessionAddress: SESSION_ADDRESS,
        sessionPublicKey: SESSION_PUBLIC_KEY,
      }),
      (error: unknown) =>
        error instanceof Error && error.name === "InfrastructureError",
    );
  });

  it("reports revoked=false when the key survives the revocation", async () => {
    const node = scriptedNode({ isValidKey: [true, true], accountKeyHashes: [] });

    const result = await providerFor(node).ownerRevokeSessionDirect({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });

    assert.equal(result.keyStoreRevoke?.status, "CONFIRMED");
    // A CONFIRMED transaction is not proof: it may have revoked another key.
    assert.equal(result.revoked, false);
  });

  it("skips the KeyStore leg when the key was never registered", async () => {
    const node = scriptedNode({ isValidKey: [false], accountKeyHashes: [] });

    const result = await providerFor(node).ownerRevokeSessionDirect({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });

    assert.equal(result.keyStoreRevoke, undefined);
    assert.equal(result.revoked, true);
    assert.equal(node.sent.length, 1);
  });

  it("returns PENDING with the hash when the KeyStore receipt wait fails", async () => {
    const node = scriptedNode({ isValidKey: [true, false], withholdReceipt: true });

    const result = await providerFor(node, 30).ownerRevokeSessionDirect({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });

    assert.equal(result.keyStoreRevoke?.status, "PENDING");
    assert.match(result.keyStoreRevoke?.transactionHash ?? "", /^0x[0-9a-f]{64}$/);
    assert.equal(result.accountRevoke.status, "PENDING");
    assert.ok(result.accountRevoke.transactionHash !== undefined);
  });

  it("rejects an owner that does not control the wallet", async () => {
    // The account-level leg is a self-call; from any other sender it is a
    // guaranteed revert that would still be reported as an attempt.
    const node = scriptedNode();

    await assert.rejects(
      providerFor(node).ownerRevokeSessionDirect({
        wallet: { ...WALLET, address: DESTINATION },
        owner: OWNER,
        sessionAddress: SESSION_ADDRESS,
        sessionPublicKey: SESSION_PUBLIC_KEY,
      }),
      /does not control the wallet/i,
    );
    assert.equal(node.calls.length, 0);
  });

  it("still reports revoked=false when the account key list retains the hash", async () => {
    const { accountKeyHashForAddress } = await import("../src/wallet/altana.js");
    const node = scriptedNode({
      isValidKey: [true, false],
      accountKeyHashes: [accountKeyHashForAddress(SESSION_ADDRESS)],
    });

    const result = await providerFor(node).ownerRevokeSessionDirect({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });

    assert.equal(result.accountKeyPresent, true);
    assert.equal(result.revoked, false);
  });
});

/* -------------------------------------------------------------------------- */
/* Endpoint rotation                                                          */
/* -------------------------------------------------------------------------- */

describe("RPC endpoint rotation", () => {
  it("moves past an unreachable endpoint", async () => {
    const healthy = scriptedNode();
    let attempted = 0;
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      rpcUrls: ["mock://dead", "mock://healthy"],
      transport: (rpcUrl) => {
        attempted += 1;
        if (rpcUrl === "mock://dead") {
          return custom({
            request: async () => {
              throw new RpcError("fetch failed", -32601);
            },
          });
        }
        return healthy.transport(rpcUrl);
      },
    });

    const balance = await provider.getBalance({ address: WALLET_ADDRESS });

    assert.equal(balance, parseEther("1"));
    assert.equal(attempted, 2);
  });

  it("probes the chain id only once per provider instance", async () => {
    const node = scriptedNode();
    const provider = providerFor(node);

    await provider.getBalance({ address: WALLET_ADDRESS });
    await provider.getBalance({ address: WALLET_ADDRESS });

    assert.equal(node.calls.filter((method) => method === "eth_chainId").length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Encoded call shape                                                         */
/* -------------------------------------------------------------------------- */

describe("revocation calldata", () => {
  it("targets the KeyStore with keccak256(publicKey) as the key id", async () => {
    const node = scriptedNode({ isValidKey: [true, false], accountKeyHashes: [] });

    await providerFor(node).ownerRevokeSessionDirect({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });

    const { keccak256 } = await import("viem");
    const expected = encodeFunctionData({
      abi: [
        {
          name: "revokeKey",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "user", type: "address" },
            { name: "keyId", type: "bytes32" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "revokeKey",
      args: [WALLET_ADDRESS, keccak256(SESSION_PUBLIC_KEY)],
    });

    assert.equal(node.sent[1]?.data, expected);
  });
});
