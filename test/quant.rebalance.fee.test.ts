import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { QUANT_ORCHESTRATOR_56 } from "../src/quant/receipt.js";
import { verifyQuantPortoFeeQuote, verifyQuantPreparedPublicKey, type QuantPortoFeeQuote } from "../src/quant/rebalanceFee.js";
import { canonicalProviderPermissionsV1 } from "../src/lp/preparedIntentWitness.js";

const WALLET = getAddress(`0x${"11".repeat(20)}`);
const OTHER = getAddress(`0x${"22".repeat(20)}`);
const PUBLIC_KEY = `0x${"03"}${"44".repeat(32)}` as Hex;
const KEY_HASH = `0x${"55".repeat(32)}` as Hex;
const CALLS = "0x123456" as Hex;
const CALLS_HASH = keccak256(CALLS);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PERMISSIONS = { calls: [{ signature: "approve(address,uint256)", to: WALLET }],
  spend: [{ limit: 10n, period: "day" }] };

function quote(overrides: Partial<QuantPortoFeeQuote> = {}): QuantPortoFeeQuote {
  return {
    chainId: 56, orchestrator: QUANT_ORCHESTRATOR_56,
    intent: { eoa: WALLET, executionData: CALLS, expiry: 0n, keyHash: KEY_HASH,
      paymentToken: ZERO, payer: ZERO, paymentAmount: 30_000_000_000_000n, paymentMaxAmount: 40_000_000_000_000n },
    nativeFeeEstimate: { maxFeePerGas: 5n }, txGas: 100n, extraPayment: 0n, ttl: 1_030,
    ...overrides,
  };
}
function verify(value: QuantPortoFeeQuote | null) {
  return verifyQuantPortoFeeQuote({ quote: value, wallet: WALLET, expectedKeyHash: KEY_HASH,
    executionDataHash: CALLS_HASH, nowSec: 1_000, sessionExpirySec: 2_000,
    quotedAtMs: 1_000_000, receivedAtMs: 1_000_001 });
}

describe("Quant public Porto fee quote verification", () => {
  it("accepts only a fresh native quote bound to the exact wallet, key and calls", () => {
    const result = verify(quote());
    assert.equal(result?.paymentWei, 30_000_000_000_000n);
    assert.equal(result?.paymentMaxWei, 40_000_000_000_000n);
    assert.equal(result?.expiresAtSec, 1_030);
  });

  it("refuses malformed wallet, calls, orchestrator, fee token, payer, key, max and TTL", () => {
    const base = quote();
    const invalid = [
      quote({ intent: { ...base.intent, eoa: OTHER } }),
      quote({ intent: { ...base.intent, executionData: "0xabcdef" } }),
      quote({ orchestrator: OTHER }),
      quote({ intent: { ...base.intent, paymentToken: OTHER } }),
      quote({ intent: { ...base.intent, payer: OTHER } }),
      quote({ intent: { ...base.intent, keyHash: `0x${"66".repeat(32)}` } }),
      quote({ intent: { ...base.intent, paymentMaxAmount: 1n } }),
      quote({ intent: { ...base.intent, encodedPreCalls: ["0x1234"] } }),
      quote({ intent: { ...base.intent, encodedFundTransfers: ["0x1234"] } }),
      quote({ intent: { ...base.intent, funder: WALLET, funderSignature: "0x1234" } }),
      quote({ ttl: 1_000 }),
      quote({ ttl: 1_301 }),
      quote({ extraPayment: 1n }),
    ];
    for (const candidate of invalid) assert.equal(verify(candidate), null);
    assert.equal(verify(null), null);
    assert.equal(verifyQuantPortoFeeQuote({ quote: base, wallet: WALLET, expectedKeyHash: KEY_HASH,
      executionDataHash: CALLS_HASH, nowSec: 1_000, sessionExpirySec: 2_000,
      quotedAtMs: 1_000_000, receivedAtMs: 1_031_000 }), null, "a slow prepare round trip is refused");
  });

  it("binds the relay-returned session key to the stored permissions byte projection", () => {
    const key = { role: "session", publicKey: PUBLIC_KEY, expiry: 2_000, permissions: PERMISSIONS };
    assert.equal(verifyQuantPreparedPublicKey({ preparedKey: key, publicKey: PUBLIC_KEY, expiry: 2_000, permissions: PERMISSIONS }), true);
    const wrong = { ...key, permissions: { ...PERMISSIONS, spend: [{ limit: 9n, period: "day" }] } };
    assert.notEqual(canonicalProviderPermissionsV1(wrong.permissions), canonicalProviderPermissionsV1(PERMISSIONS));
    assert.equal(verifyQuantPreparedPublicKey({ preparedKey: wrong, publicKey: PUBLIC_KEY, expiry: 2_000, permissions: PERMISSIONS }), false);
    assert.equal(verifyQuantPreparedPublicKey({ preparedKey: key, publicKey: PUBLIC_KEY, expiry: 1_999, permissions: PERMISSIONS }), false);
  });
});
