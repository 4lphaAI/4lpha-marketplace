/**
 * Offline tests for the WalletProvider v2 surface added in Phase 1a.
 *
 * Covers the seams that make the service durable and honest across restarts:
 *   - restoreSession rebuilds a session byte-exact, with no network;
 *   - a FAILED execute is classified (the SDK never throws for it);
 *   - awaitExecution maps relay status without re-submitting;
 *   - isSessionActive is truthful about expiry;
 *   - ownerRevokeSession returns the read-back verdict, not a receipt guess;
 *   - the token-recovery seam refuses cleanly until Phase 2.
 *
 * Every network touch is an injected transport or an injected SDK client, so
 * nothing here reaches a real chain or relay.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  getAddress,
  numberToHex,
  parseEther,
  toFunctionSelector,
  zeroAddress,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BNB_TESTNET,
  type Client as AltanaClient,
} from "@altananetwork/sdk";
import {
  AltanaProvider,
  agentAuthorityFromPrivateKey,
  ownerAuthorityFromPrivateKey,
  type AltanaSessionHandle,
} from "../src/wallet/altana.js";
import { createProviderRegistry } from "../src/wallet/registry.js";
import { validateSessionSpec } from "../src/core/session.js";
import type { AgentWalletRef, SessionSpec } from "../src/core/types.js";

const OWNER_KEY = `0x${"11".repeat(32)}` as Hex;
const AGENT_KEY = `0x${"22".repeat(32)}` as Hex;
const OWNER = ownerAuthorityFromPrivateKey(OWNER_KEY);
const AGENT = agentAuthorityFromPrivateKey(AGENT_KEY);
const WALLET_ADDRESS = getAddress(privateKeyToAccount(OWNER_KEY).address);
const SESSION_ADDRESS = getAddress(privateKeyToAccount(AGENT_KEY).address);
const ROUTER = getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const PUBLIC_KEY = `0x${"ab".repeat(64)}` as Hex;

const WALLET: AgentWalletRef = {
  address: WALLET_ADDRESS,
  chainId: BNB_TESTNET.chainId,
  ownerAddress: WALLET_ADDRESS,
  custodyModel: "self-eoa",
};

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    allowedCalls: [{ to: ROUTER }],
    spendCaps: [{ limit: parseEther("0.1"), period: "day" }],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

const IS_VALID_KEY = toFunctionSelector("isValidKey(address,bytes32)");
const BALANCE_OF = toFunctionSelector("balanceOf(address)");
const bool = (value: boolean): Hex =>
  encodeAbiParameters([{ type: "bool" }], [value]);

/* -------------------------------------------------------------------------- */
/* restoreSession                                                             */
/* -------------------------------------------------------------------------- */

describe("restoreSession", () => {
  it("rebuilds a session byte-exact from persisted facts, no network", () => {
    // A transport that throws if touched proves the rebuild is synchronous.
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: () =>
        custom({
          request: async () => {
            throw new Error("restoreSession must not touch the network");
          },
        }),
    });
    const s = spec();
    const restored = provider.restoreSession({
      spec: s,
      agent: AGENT,
      walletAddress: WALLET_ADDRESS,
      publicKey: PUBLIC_KEY,
      expiresAt: s.expiresAt,
    });

    const session = (restored.handle as AltanaSessionHandle).session;
    assert.equal(restored.publicKey, PUBLIC_KEY);
    assert.equal(session.publicKey, PUBLIC_KEY);
    assert.equal(session.expiry, s.expiresAt);
    assert.equal(session.walletAddress, WALLET_ADDRESS);
    // Permissions must equal what a grant would have registered, byte-for-byte.
    assert.deepEqual(
      session.permissions,
      validateSessionSpec(s, { minSessionSeconds: 0 }),
    );
    assert.equal(session.signer.address, SESSION_ADDRESS);
  });
});

/* -------------------------------------------------------------------------- */
/* failureCode classification                                                 */
/* -------------------------------------------------------------------------- */

/** A fake Altana client whose session-execute returns FAILED without throwing. */
function clientReturningFailed(reason: string): AltanaClient {
  return {
    execute: async () => ({
      status: "FAILED",
      callsId: `0x${"cc".repeat(32)}` as Hex,
      reason,
    }),
  } as unknown as AltanaClient;
}

/**
 * A relay that accepts the call and never answers — measured live on mainnet,
 * 2026-08-12: a trade sat on this await while the same process served /health in
 * 30ms. Every other wait in the provider had a ceiling; this one, the only wait
 * that costs money, had none.
 */
function clientThatNeverAnswers(): AltanaClient {
  return {
    execute: () => new Promise(() => {
      /* deliberately never settles */
    }),
  } as unknown as AltanaClient;
}

describe("executeViaSession submit timeout", () => {
  it("gives up on a relay that never answers, and says the outcome is UNKNOWN", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      client: clientThatNeverAnswers(),
      submitTimeoutMs: 25,
    });
    const session = provider.restoreSession({
      spec: spec(),
      agent: AGENT,
      walletAddress: WALLET_ADDRESS,
      publicKey: PUBLIC_KEY,
      expiresAt: spec().expiresAt,
    });

    await assert.rejects(
      provider.executeViaSession({
        session,
        calls: [{ to: ROUTER, value: 1n }],
        bypassLocalPolicyCheck: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // UNKNOWN, not failed: the relay may have accepted the bundle. The word
        // has to be in the message because the route's UNKNOWN note quotes it
        // and an operator reads that note before deciding whether to retry.
        assert.match(error.message, /UNKNOWN/);
        // And it must NOT read as a refusal, which is what would tempt a caller
        // — or a future implementer — into releasing the budget it holds.
        assert.doesNotMatch(error.message, /not allowed|refus/i);
        return true;
      },
    );
  });

  it("does not fire for a relay that answers inside the ceiling", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      client: {
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { status: "CONFIRMED", callsId: `0x${"ab".repeat(32)}` as Hex };
        },
      } as unknown as AltanaClient,
      submitTimeoutMs: 500,
    });
    const session = provider.restoreSession({
      spec: spec(),
      agent: AGENT,
      walletAddress: WALLET_ADDRESS,
      publicKey: PUBLIC_KEY,
      expiresAt: spec().expiresAt,
    });

    const receipt = await provider.executeViaSession({
      session,
      calls: [{ to: ROUTER, value: 1n }],
      bypassLocalPolicyCheck: true,
    });
    assert.equal(receipt.status, "CONFIRMED");
  });
});

describe("executeViaSession failureCode", () => {
  async function failureCodeFor(reason: string): Promise<string | undefined> {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      client: clientReturningFailed(reason),
    });
    const session = provider.restoreSession({
      spec: spec(),
      agent: AGENT,
      walletAddress: WALLET_ADDRESS,
      publicKey: PUBLIC_KEY,
      expiresAt: spec().expiresAt,
    });
    const receipt = await provider.executeViaSession({
      session,
      calls: [{ to: ROUTER, value: 1n }],
      bypassLocalPolicyCheck: true,
    });
    assert.equal(receipt.status, "FAILED");
    return receipt.failureCode;
  }

  it("classifies an over-cap FAILED body as CAP_EXCEEDED", async () => {
    assert.equal(
      await failureCodeFor("execution reverted: ExceededSpendLimit()"),
      "CAP_EXCEEDED",
    );
  });

  it("classifies an off-allowlist FAILED body as NOT_ALLOWED", async () => {
    assert.equal(
      await failureCodeFor("execution reverted: UnauthorizedCall()"),
      "NOT_ALLOWED",
    );
  });

  it("classifies a relay-outage FAILED body as INFRASTRUCTURE_ERROR", async () => {
    assert.equal(
      await failureCodeFor("HTTP request failed. Status: 503 Service Unavailable"),
      "INFRASTRUCTURE_ERROR",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* awaitExecution                                                             */
/* -------------------------------------------------------------------------- */

function relayTransport(statuses: readonly unknown[]): (url: string) => Transport {
  let index = 0;
  return () =>
    custom({
      request: async ({ method }: { method: string }) => {
        if (method === "wallet_getCallsStatus") {
          const answer = statuses[Math.min(index, statuses.length - 1)];
          index += 1;
          return answer;
        }
        throw new Error(`unscripted relay method ${method}`);
      },
    });
}

describe("awaitExecution", () => {
  it("maps a confirmed relay status, carrying the tx hash", async () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: relayTransport([
        { status: 200, receipts: [{ transactionHash: txHash }] },
      ]),
    });
    const receipt = await provider.awaitExecution({
      callsId: `0x${"cc".repeat(32)}` as Hex,
    });
    assert.equal(receipt.status, "CONFIRMED");
    assert.equal(receipt.transactionHash, txHash);
  });

  it("maps a failed relay status", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: relayTransport([{ status: 500 }]),
    });
    const receipt = await provider.awaitExecution({
      callsId: `0x${"cc".repeat(32)}` as Hex,
    });
    assert.equal(receipt.status, "FAILED");
  });

  it("polls past a pending status until it confirms", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      awaitPollIntervalMs: 1,
      awaitTimeoutMs: 500,
      transport: relayTransport([
        { status: 100 },
        { status: 200, receipts: [] },
      ]),
    });
    const receipt = await provider.awaitExecution({
      callsId: `0x${"cc".repeat(32)}` as Hex,
    });
    assert.equal(receipt.status, "CONFIRMED");
  });

  it("returns PENDING rather than hanging when the relay never resolves", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      awaitPollIntervalMs: 1,
      awaitTimeoutMs: 10,
      transport: relayTransport([{ status: 100 }]),
    });
    const receipt = await provider.awaitExecution({
      callsId: `0x${"cc".repeat(32)}` as Hex,
    });
    assert.equal(receipt.status, "PENDING");
  });
});

/* -------------------------------------------------------------------------- */
/* isSessionActive                                                            */
/* -------------------------------------------------------------------------- */

function keyStoreTransport(isValid: boolean): (url: string) => Transport {
  return () =>
    custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
        if (method === "eth_call") {
          const call = (params as readonly { data?: Hex }[])[0];
          if (call?.data?.startsWith(IS_VALID_KEY)) return bool(isValid);
          if (call?.data?.startsWith(BALANCE_OF)) {
            return encodeAbiParameters([{ type: "uint256" }], [parseEther("5")]);
          }
        }
        throw new Error(`unscripted method ${method}`);
      },
    });
}

describe("isSessionActive", () => {
  it("is false for an expired session without any network read", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: () =>
        custom({
          request: async () => {
            throw new Error("expired check must not read the chain");
          },
        }),
    });
    const active = await provider.isSessionActive({
      wallet: WALLET,
      publicKey: PUBLIC_KEY,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    assert.equal(active, false);
  });

  it("is true when registered and not expired", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: keyStoreTransport(true),
    });
    const active = await provider.isSessionActive({
      wallet: WALLET,
      publicKey: PUBLIC_KEY,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    assert.equal(active, true);
  });

  it("is false when the key is not registered", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: keyStoreTransport(false),
    });
    const active = await provider.isSessionActive({
      wallet: WALLET,
      publicKey: PUBLIC_KEY,
    });
    assert.equal(active, false);
  });
});

/* -------------------------------------------------------------------------- */
/* getTokenBalance                                                            */
/* -------------------------------------------------------------------------- */

describe("getTokenBalance", () => {
  it("reads ERC-20 balanceOf for the wallet", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: keyStoreTransport(true),
    });
    const balance = await provider.getTokenBalance({ wallet: WALLET, token: USDT });
    assert.equal(balance, parseEther("5"));
  });
});

/* -------------------------------------------------------------------------- */
/* ownerRevokeSession                                                         */
/* -------------------------------------------------------------------------- */

/** A coded JSON-RPC error, so viem does not retry with slow backoff. */
class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code = -32601) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

function revokeTransport(isValidSequence: readonly boolean[]): (url: string) => Transport {
  let sends = 0;
  let validIndex = 0;
  const getKeys = toFunctionSelector("getKeys()");
  return () =>
    custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        switch (method) {
          case "eth_chainId":
            return numberToHex(BNB_TESTNET.chainId);
          case "eth_getTransactionCount":
            return numberToHex(1);
          case "eth_gasPrice":
            return numberToHex(1_000_000_000);
          case "eth_estimateGas":
            return numberToHex(60_000);
          case "eth_blockNumber":
            return numberToHex(1_000_000);
          case "eth_getBlockByNumber":
            // Legacy (no baseFeePerGas): BSC prices the old way.
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
          case "eth_sendRawTransaction": {
            sends += 1;
            return `0x${sends.toString(16).padStart(64, "0")}`;
          }
          case "eth_getTransactionReceipt":
            return {
              transactionHash: (params as readonly Hex[])[0],
              blockNumber: numberToHex(1_000_000),
              blockHash: `0x${"cd".repeat(32)}`,
              transactionIndex: "0x0",
              status: "0x1",
              from: WALLET_ADDRESS,
              to: BNB_TESTNET.keyStore,
              cumulativeGasUsed: "0x5208",
              gasUsed: "0x5208",
              contractAddress: null,
              logs: [],
              logsBloom: `0x${"00".repeat(256)}`,
              effectiveGasPrice: "0x1",
              type: "0x0",
            };
          case "eth_call": {
            const data = (params as readonly { data?: Hex }[])[0]?.data ?? "0x";
            if (data.startsWith(IS_VALID_KEY)) {
              const answer =
                isValidSequence[Math.min(validIndex, isValidSequence.length - 1)] ??
                false;
              validIndex += 1;
              return bool(answer);
            }
            if (data.startsWith(getKeys)) {
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
                [[], []],
              );
            }
            throw new RpcError(`unscripted eth_call ${data.slice(0, 10)}`, -32000);
          }
          default:
            throw new RpcError(`unscripted method ${method}`);
        }
      },
    });
}

describe("ownerRevokeSession", () => {
  it("returns the read-back revoked verdict and every receipt", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: revokeTransport([true, false]),
    });
    const result = await provider.ownerRevokeSession({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: PUBLIC_KEY,
    });
    assert.equal(result.revoked, true);
    // account-level revoke + keystore revoke.
    assert.equal(result.receipts.length, 2);
    assert.ok(result.receipts.every((receipt) => receipt.status === "CONFIRMED"));
  });

  it("reports revoked=false when the key survives, ignoring receipt success", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: revokeTransport([true, true]),
    });
    const result = await provider.ownerRevokeSession({
      wallet: WALLET,
      owner: OWNER,
      sessionAddress: SESSION_ADDRESS,
      sessionPublicKey: PUBLIC_KEY,
    });
    assert.equal(result.revoked, false);
  });
});

/* -------------------------------------------------------------------------- */
/* ownerRecoverTokens + registry                                              */
/* -------------------------------------------------------------------------- */

describe("ownerRecoverTokens", () => {
  it("refuses clearly until Phase 2 rather than silently no-oping", async () => {
    const provider = new AltanaProvider({ network: BNB_TESTNET });
    await assert.rejects(
      provider.ownerRecoverTokens({
        wallet: WALLET,
        owner: OWNER,
        to: WALLET_ADDRESS,
        tokens: [USDT],
      }),
      (error: unknown) =>
        error instanceof Error && error.name === "NotImplementedError",
    );
  });
});

describe("createProviderRegistry", () => {
  it("resolves the provider for a configured chain", () => {
    const registry = createProviderRegistry([{ network: BNB_TESTNET }]);
    const provider = registry.get(BNB_TESTNET.chainId);
    assert.ok(provider instanceof AltanaProvider);
  });

  it("throws for an unconfigured chain", () => {
    const registry = createProviderRegistry([{ network: BNB_TESTNET }]);
    assert.throws(() => registry.get(1), /No wallet provider is configured/);
  });

  it("rejects duplicate chain entries", () => {
    assert.throws(
      () =>
        createProviderRegistry([
          { network: BNB_TESTNET },
          { network: BNB_TESTNET },
        ]),
      /Duplicate provider registry entry/,
    );
  });
});
