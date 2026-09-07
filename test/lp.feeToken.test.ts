/**
 * The relay bills gas in exactly ONE token on chain 56 and it is native BNB.
 *
 * `wallet_getCapabilities` reports `0x38 -> fees.tokens = [{ uid: "bnb",
 * address: 0x00..00, feeToken: true }]` and nothing else. Porto's
 * `prepareCalls` defaults an OMITTED `feeToken` to
 * `key.permissions.spend[0].token`, which for an LP session is the
 * lexicographically lowest granted ERC-20 — the pool token or WBNB, never
 * native, because `validateSessionSpec` sorts on the lowercased token address
 * and a native cap carries none (FIXREVIEW7 F7). Omitting the field therefore
 * made the relay refuse every staged LP prepare with `fee token not supported:
 * <that ERC-20>`, surfacing as a pre-bind rollback.
 *
 * Every existing staged-adapter test injects a `prepare` that IGNORES the
 * request's `feeToken`, which is why a full green suite still shipped a path
 * that could not open a position with any pair. These cases read the field.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BNB } from "@altananetwork/sdk";
import { custom, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { prepareCalls, sendPreparedCalls, signCalls } from "porto/viem/RelayActions";
import { validateSessionSpec } from "../src/core/session.js";
import {
  PORTO_NATIVE_FEE_TOKEN,
  PORTO_V055_ORCHESTRATOR,
  PortoStagedLpAdapter,
  encodeLpFinalCallsV1,
  fingerprintLpFinalCallsV1,
} from "../src/lp/preparedIntent.js";
import {
  PortoPrepareDiagnosticAdapter,
  printableLpPrepareDiagnosticOutcome,
} from "../src/lp/prepareDiagnostic.js";
import type { WalletCall } from "../src/core/types.js";

const SESSION_KEY = `0x${"00".repeat(31)}01` as Hex;
const WALLET = `0x${"34".repeat(20)}` as Address;
const TARGET = `0x${"56".repeat(20)}` as Address;
/** Stands in for the pool token: the value Porto would infer if we omitted. */
const POOL_TOKEN = `0x${"78".repeat(20)}` as Address;
const EXPIRY = Math.floor(Date.now() / 1_000) + 3_600;
const SPEC = {
  allowedCalls: [{ to: TARGET }],
  spendCaps: [{ token: POOL_TOKEN, limit: 10n ** 18n, period: "day" as const }],
  expiresAt: EXPIRY,
};
const PERMISSIONS = validateSessionSpec(SPEC, { minSessionSeconds: 0 });
const CALLS = [{ to: TARGET, value: 0n, data: "0x" as Hex }] as const;
const FINGERPRINT = fingerprintLpFinalCallsV1(CALLS);
const ACCOUNT = privateKeyToAccount(SESSION_KEY);

const NO_RPC = () => custom({ request: async () => { throw new Error("unexpected RPC"); } });

function baseInput() {
  return {
    journalIdempotencyKey: `0x${"11".repeat(32)}`,
    expectedBindingVersion: 0,
    sessionPrivateKey: SESSION_KEY,
    walletAddress: WALLET,
    persistedSession: {
      spec: SPEC,
      permissions: PERMISSIONS,
      publicKey: ACCOUNT.publicKey,
      expiry: EXPIRY,
    },
    restoredSessionPublicKey: ACCOUNT.publicKey,
    restoredSessionExpiry: EXPIRY,
    calls: CALLS,
    expectedExecutionDataHash: FINGERPRINT.value.executionDataHash,
  } as const;
}

/**
 * Captures the request the adapter hands Porto, then completes the flow.
 *
 * `intentExpiry` defaults to what the BSC relay actually returns — `0n` — so
 * these fakes stop flattering the code the way the older ones did.
 */
function capturingPrepare(
  sink: { request?: Parameters<typeof prepareCalls>[1] },
  intentExpiry = 0n,
) {
  return (async (...[, request]: Parameters<typeof prepareCalls>) => {
    sink.request = request;
    return {
      capabilities: {
        quote: {
          quotes: [{
            chainId: 56,
            orchestrator: PORTO_V055_ORCHESTRATOR,
            intent: {
              eoa: request.account,
              executionData: encodeLpFinalCallsV1((request.calls ?? []) as readonly WalletCall[]),
              nonce: 1n,
              expiry: intentExpiry,
            },
          }],
        },
      },
      context: {},
      digest: `0x${"21".repeat(32)}` as Hex,
      key: request.key,
      typedData: {},
    } as unknown as Awaited<ReturnType<typeof prepareCalls>>;
  }) as typeof prepareCalls;
}

describe("PHASE3.9C: the staged LP prepare names its fee token", () => {
  it("is the native zero address, never an inferred session token", () => {
    assert.equal(PORTO_NATIVE_FEE_TOKEN, "0x0000000000000000000000000000000000000000");
  });

  it("sends feeToken on the submit path so the relay can price the intent", async () => {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    const adapter = new PortoStagedLpAdapter({
      network: BNB,
      transport: NO_RPC,
      functions: {
        prepare: capturingPrepare(sink),
        sign: (async () => `0x${"22".repeat(65)}` as Hex) as typeof signCalls,
        send: (async () => ({ id: `0x${"23".repeat(32)}` as Hex })) as typeof sendPreparedCalls,
      },
      submitTimeoutMs: 1_000,
    });

    const receipt = await adapter.submit({
      ...baseInput(),
      bind: async (request) => ({ ...request, boundBindingVersion: 1 }),
    });

    assert.equal(receipt.status, "PENDING");
    assert.equal(sink.request?.feeToken, PORTO_NATIVE_FEE_TOKEN);
  });

  it("does not let the pool token become the fee token by omission", async () => {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    const adapter = new PortoStagedLpAdapter({
      network: BNB,
      transport: NO_RPC,
      functions: {
        prepare: capturingPrepare(sink),
        sign: (async () => `0x${"22".repeat(65)}` as Hex) as typeof signCalls,
        send: (async () => ({ id: `0x${"23".repeat(32)}` as Hex })) as typeof sendPreparedCalls,
      },
      submitTimeoutMs: 1_000,
    });

    await adapter.submit({
      ...baseInput(),
      bind: async (request) => ({ ...request, boundBindingVersion: 1 }),
    });

    // The value Porto would have inferred from `spend[0].token`. Seeing it
    // here means the relay is being asked to bill gas in the LP leg.
    assert.notEqual(sink.request?.feeToken?.toLowerCase(), POOL_TOKEN.toLowerCase());
    assert.notEqual(sink.request?.feeToken, undefined);
  });

  it("has the D1 diagnostic send the SAME fee token it is meant to reproduce", async () => {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    const diagnostic = new PortoPrepareDiagnosticAdapter({
      network: BNB,
      transport: NO_RPC,
      prepare: capturingPrepare(sink),
      prepareTimeoutMs: 1_000,
    });

    await diagnostic.prepare({
      sessionPrivateKey: SESSION_KEY,
      walletAddress: WALLET,
      persistedSession: {
        spec: SPEC,
        permissions: PERMISSIONS,
        publicKey: ACCOUNT.publicKey,
        expiry: EXPIRY,
      },
      restoredSessionPublicKey: ACCOUNT.publicKey,
      restoredSessionExpiry: EXPIRY,
      calls: CALLS,
      expectedExecutionDataHash: FINGERPRINT.value.executionDataHash,
    });

    // A diagnostic that prepared differently from the submit path would clear
    // a route that still refuses, which is worse than no diagnostic at all.
    assert.equal(sink.request?.feeToken, PORTO_NATIVE_FEE_TOKEN);
  });
});

/**
 * The relay carries no deadline on the intent itself: every BSC quote comes
 * back with `expiry: 0`, the prepared object is governed by the quote TTL, and
 * the session key's expiry is enforced on chain by the KeyStore. Demanding
 * equality with the session expiry — as the staged path originally did —
 * refuses every real submit.
 */
describe("PHASE3.9C: the staged LP prepare accepts the relay's intent expiry", () => {
  function stagedAdapter(sink: { request?: Parameters<typeof prepareCalls>[1] }, expiry: bigint) {
    return new PortoStagedLpAdapter({
      network: BNB,
      transport: NO_RPC,
      functions: {
        prepare: capturingPrepare(sink, expiry),
        sign: (async () => `0x${"22".repeat(65)}` as Hex) as typeof signCalls,
        send: (async () => ({ id: `0x${"23".repeat(32)}` as Hex })) as typeof sendPreparedCalls,
      },
      submitTimeoutMs: 1_000,
    });
  }

  const bind = async (request: Parameters<PortoStagedLpAdapter["submit"]>[0] extends never
    ? never : Parameters<Parameters<PortoStagedLpAdapter["submit"]>[0]["bind"]>[0]) =>
    ({ ...request, boundBindingVersion: 1 });

  it("submits when the relay reports no intent-level deadline", async () => {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    const receipt = await stagedAdapter(sink, 0n).submit({ ...baseInput(), bind });
    assert.equal(receipt.status, "PENDING");
  });

  it("still submits when a nonzero expiry TIGHTENS the window", async () => {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    const receipt = await stagedAdapter(sink, BigInt(EXPIRY) - 60n).submit({ ...baseInput(), bind });
    assert.equal(receipt.status, "PENDING");
  });

  it("refuses an intent that would outlive the session", async () => {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    await assert.rejects(
      stagedAdapter(sink, BigInt(EXPIRY) + 1n).submit({ ...baseInput(), bind }),
      /prepared intent does not match/i,
    );
  });

  // FIXREVIEW7 F6. The upper bound alone admitted `expiry: 1` — a deadline
  // eleven years past — which is refusable HERE, pre-bind, and otherwise
  // becomes a signed, sent, `IntentExpired`-reverting submission whose journal
  // row is an UNKNOWN needing the owner-signed resolver.
  it("refuses a nonzero intent expiry that is ALREADY IN THE PAST", async () => {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    await assert.rejects(
      stagedAdapter(sink, 1n).submit({ ...baseInput(), bind }),
      /prepared intent does not match/i,
    );
  });

  async function diagnose(expiry: bigint) {
    const sink: { request?: Parameters<typeof prepareCalls>[1] } = {};
    const diagnostic = new PortoPrepareDiagnosticAdapter({
      network: BNB,
      transport: NO_RPC,
      prepare: capturingPrepare(sink, expiry),
      prepareTimeoutMs: 1_000,
    });
    return await diagnostic.prepare({
      sessionPrivateKey: SESSION_KEY,
      walletAddress: WALLET,
      persistedSession: {
        spec: SPEC, permissions: PERMISSIONS, publicKey: ACCOUNT.publicKey, expiry: EXPIRY,
      },
      restoredSessionPublicKey: ACCOUNT.publicKey,
      restoredSessionExpiry: EXPIRY,
      calls: CALLS,
      expectedExecutionDataHash: FINGERPRINT.value.executionDataHash,
    });
  }

  it("has the D1 diagnostic clear the same expiry the submit path clears", async () => {
    // `null` is the diagnostic's only way of saying "prepare completed".
    assert.equal(await diagnose(0n), null);
  });

  // FIXREVIEW7 F5. The fee-token half of the mirror was pinned; this half was
  // not, and neutering the diagnostic's `acceptableIntentExpiry` to
  // `return true` survived the whole suite. A diagnostic that admits what the
  // submit path refuses clears a route that still refuses — worse than no
  // diagnostic at all.
  it("has the D1 diagnostic REFUSE the expiries the submit path refuses", async () => {
    assert.deepEqual(
      printableLpPrepareDiagnosticOutcome(await diagnose(BigInt(EXPIRY) + 1n)),
      { stage: "prepared-response", reason: "quote-invalid" },
    );
    // FIXREVIEW7 F6, mirrored: already in the past.
    assert.deepEqual(
      printableLpPrepareDiagnosticOutcome(await diagnose(1n)),
      { stage: "prepared-response", reason: "quote-invalid" },
    );
  });
});
