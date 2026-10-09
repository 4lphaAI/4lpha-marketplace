/**
 * The one file that spends: x402Buyer.ts. The runtime's fetchWithPayment is replaced by stubs that throw the
 * runtime's own error classes, so the mapping of every outcome (paid, capped, refused, ambiguous, payee
 * mismatch) and the per-request clamp are pinned. One test also drives the REAL runtime with a stub fetch to
 * show an unlisted host is refused before any request.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  X402AmountExceededError,
  X402BudgetExhaustedError,
  X402BuyerPolicy,
  X402HostNotAllowedError,
  X402PaymentOutcomeUnknownError,
  X402RecipientMismatchError,
  X402RetryExhaustedError,
} from "@bnbagent/studio-runtime/x402";
import * as buyerModule from "../src/x402Buyer.js";
import { buyWithX402, type BuyDeps } from "../src/x402Buyer.js";

const policy = (maxPerRequest: number) => () =>
  X402BuyerPolicy.fromToml({
    payments: { x402: { max_per_request_usd: maxPerRequest, merchants: { cmc: { domain: "pro-api.coinmarketcap.com", pay_to: "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA", per_call_cap_usd: 0.02, verified: true } } } },
  });

interface Seen {
  url: string;
  opts: Record<string, unknown>;
}

function stub(result: () => unknown): { deps: BuyDeps; seen: Seen[] } {
  const seen: Seen[] = [];
  const deps: BuyDeps = {
    policy: policy(0.05),
    wallet: () => ({ address: "0x0000000000000000000000000000000000000001" }) as never,
    fetchWithPayment: (async (url: string, opts: Record<string, unknown>) => {
      seen.push({ url, opts });
      return result();
    }) as never,
  };
  return { deps, seen };
}

const fetchResult = { statusCode: 200, json: { data: [] }, paidUsd: 0.01, settlement: { transaction: `0x${"cd".repeat(32)}`, network: "eip155:56" } };

describe("buyWithX402: outcomes", () => {
  it("paid: returns the data, the amount and the settlement transaction", async () => {
    const { deps, seen } = stub(() => fetchResult);
    const r = await buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps);
    assert.deepEqual(r, { ok: true, status: 200, json: { data: [] }, paid_usd: 0.01, settlement_tx: `0x${"cd".repeat(32)}` });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.opts.method, "GET");
  });
  it("paid without a settlement header: tx is null", async () => {
    const { deps } = stub(() => ({ ...fetchResult, settlement: undefined }));
    const r = await buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps);
    assert.equal(r.settlement_tx, null);
  });
  it("capped: a spent daily budget comes back by name", async () => {
    const { deps } = stub(() => { throw new X402BudgetExhaustedError("cap"); });
    const r = await buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps);
    assert.deepEqual([r.ok, r.error], [false, "X402BudgetExhaustedError"]);
  });
  it("capped: an amount over the cap is an SDK error, rethrown with its name for the caller to classify", async () => {
    const { deps } = stub(() => { throw new X402AmountExceededError("over"); });
    await assert.rejects(buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps), (e: Error) => e.name === "X402AmountExceededError");
  });
  it("refused: a host that is not allowed", async () => {
    const { deps } = stub(() => { throw new X402HostNotAllowedError("host"); });
    const r = await buyWithX402("https://evil.example/x", 0.05, "GET", deps);
    assert.deepEqual([r.ok, r.error], [false, "X402HostNotAllowedError"]);
  });
  it("payee mismatch: the pinned recipient differs from the 402 (SDK error, rethrown with its name; nothing is paid)", async () => {
    const { deps, seen } = stub(() => { throw new X402RecipientMismatchError("payee"); });
    await assert.rejects(buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps), (e: Error) => e.name === "X402RecipientMismatchError");
    assert.equal(seen.length, 1);
  });
  it("ambiguous: payment sent, outcome unknown or retries exhausted", async () => {
    for (const E of [X402PaymentOutcomeUnknownError, X402RetryExhaustedError]) {
      const { deps } = stub(() => { throw new E("sent"); });
      const r = await buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps);
      assert.deepEqual([r.ok, r.error], [false, E.name]);
    }
  });
  it("anything that is not an x402 error is rethrown (the caller classifies it as failed)", async () => {
    const { deps } = stub(() => { throw new Error("boom"); });
    await assert.rejects(buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps), /boom/);
  });
});

describe("buyWithX402: caps and allowlist are config, not parameters", () => {
  it("the per-request config cap clamps whatever the caller passes", async () => {
    const { deps, seen } = stub(() => fetchResult);
    await buyWithX402("https://pro-api.coinmarketcap.com/x", 5, "GET", deps);
    assert.equal(seen[0]?.opts.maxUsd, 0.05);
    const tight = stub(() => fetchResult);
    await buyWithX402("https://pro-api.coinmarketcap.com/x", 5, "GET", { ...tight.deps, policy: policy(0.03) });
    assert.equal(tight.seen[0]?.opts.maxUsd, 0.03);
    await buyWithX402("https://pro-api.coinmarketcap.com/x", 0.01, "GET", { ...tight.deps, policy: policy(0.03) });
    assert.equal(tight.seen[1]?.opts.maxUsd, 0.01);
  });
  it("the allowlist is the policy's (trusted merchants), never the caller's", async () => {
    const { deps, seen } = stub(() => fetchResult);
    await buyWithX402("https://pro-api.coinmarketcap.com/x", 0.05, "GET", deps);
    assert.deepEqual(seen[0]?.opts.allowedHosts, ["pro-api.coinmarketcap.com"]);
  });
  it("the module exports only buyWithX402: no payment tool exists for the model", () => {
    assert.deepEqual(Object.keys(buyerModule).sort(), ["buyWithX402"]);
  });
});

describe("buyWithX402 against the real runtime", () => {
  it("an unlisted host is refused before any request is made", async () => {
    let requests = 0;
    const fetchImpl = (async () => { requests += 1; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const r = await buyWithX402("https://evil.example/x", 0.01, "GET", {
      policy: policy(0.05),
      wallet: () => ({ address: "0x0000000000000000000000000000000000000001" }) as never,
      fetchImpl,
    });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /X402(HostNotAllowed|RecipientRequired)Error/);
    assert.equal(requests, 0);
  });
});
