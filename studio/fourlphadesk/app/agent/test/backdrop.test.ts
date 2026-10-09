import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKDROP_MAX_USD, BACKDROP_URL, buyBackdrop, readBackdrop, type BuyFn } from "../src/desk/backdrop.js";
import { btcBnbJson, NOW, paidOk } from "./helpers.js";

describe("readBackdrop: finds BTC and BNB whatever the exact nesting", () => {
  it("reads quote as an array (v3) and as an object keyed by currency", () => {
    const a = readBackdrop(btcBnbJson());
    assert.deepEqual(a, [
      { symbol: "BTC", priceUsd: 65000.5, change24hPct: -1.25 },
      { symbol: "BNB", priceUsd: 612.4, change24hPct: 0.8 },
    ]);
  });
  it("finds the assets in an object keyed by id", () => {
    const a = readBackdrop({ data: { "1": { symbol: "BTC", quote: { USD: { price: 1, percent_change_24h: 2 } } } } });
    assert.deepEqual(a, [{ symbol: "BTC", priceUsd: 1, change24hPct: 2 }]);
  });
  it("ignores other symbols; a missing or non-positive price is null, never zero", () => {
    const a = readBackdrop({ data: [{ symbol: "ETH", quote: { USD: { price: 5 } } }, { symbol: "BTC", quote: { USD: { price: 0 } } }, { symbol: "BNB", quote: { USD: { price: "612" } } }] });
    assert.deepEqual(a.map((x) => [x.symbol, x.priceUsd]), [["BTC", null], ["BNB", null]]);
  });
  it("returns nothing for junk", () => {
    for (const x of [null, "x", 5, [], {}, { data: [] }]) assert.deepEqual(readBackdrop(x), []);
  });
  it("does not recurse without bound", () => {
    let deep: unknown = { symbol: "BTC", quote: { USD: { price: 1 } } };
    for (let i = 0; i < 40; i++) deep = { x: deep };
    assert.deepEqual(readBackdrop(deep), []);
  });
});

describe("buyBackdrop: the self-funding leg", () => {
  it("buys the pinned CoinMarketCap endpoint with the per-job cap and reports the payment", async () => {
    const seen: { url: string; max: number; method?: string }[] = [];
    const buy: BuyFn = async (url, max, method) => { seen.push({ url, max, method }); return paidOk(); };
    const b = await buyBackdrop(buy, () => NOW);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, BACKDROP_URL);
    assert.equal(new URL(BACKDROP_URL).hostname, "pro-api.coinmarketcap.com");
    assert.equal(seen[0]?.max, BACKDROP_MAX_USD);
    assert.ok(BACKDROP_MAX_USD <= 0.05);
    assert.equal(b.status, "paid");
    if (b.status === "paid") {
      assert.equal(b.paidUsd, 0.01);
      assert.equal(b.tx, `0x${"ab".repeat(32)}`);
      assert.equal(b.assets.length, 2);
      assert.equal(b.fetchedAt, NOW);
    }
  });
  it("a payment transaction that is not a 32-byte hash is dropped", async () => {
    const b = await buyBackdrop(async () => ({ ...paidOk(), settlement_tx: "0xnothash" }), () => NOW);
    assert.equal(b.status === "paid" && b.tx, null);
  });
  it("paid but unreadable data is reported as such (the payment is not hidden)", async () => {
    const b = await buyBackdrop(async () => paidOk({ data: "?" }), () => NOW);
    assert.equal(b.status, "unreadable");
    assert.equal(b.status === "unreadable" && b.paidUsd, 0.01);
  });
  it("a capped payment (budget or amount) is 'capped'", async () => {
    for (const error of ["X402BudgetExhaustedError", "X402AmountExceededError"]) {
      const b = await buyBackdrop(async () => ({ ok: false, error, message: "no" }), () => NOW);
      assert.equal(b.status, "capped", error);
      assert.equal(b.status === "capped" && b.reason, error);
    }
  });
  it("ambiguous outcomes are 'unknown', returned or thrown (review M2): the payment may have left the wallet", async () => {
    for (const error of ["X402PaymentOutcomeUnknownError", "X402RetryExhaustedError"]) {
      const ret = await buyBackdrop(async () => ({ ok: false, error, message: "sent" }), () => NOW);
      assert.deepEqual([ret.status, ret.status === "unknown" && ret.reason], ["unknown", error], error);
      const thrown = await buyBackdrop(async () => { throw Object.assign(new Error("sent"), { name: error }); }, () => NOW);
      assert.equal(thrown.status, "unknown", error);
    }
  });
  it("thrown SDK errors are classified by name: amount over the cap is capped, payee mismatch is failed", async () => {
    const over = await buyBackdrop(async () => { throw Object.assign(new Error("x"), { name: "X402AmountExceededError" }); }, () => NOW);
    assert.equal(over.status, "capped");
    const payee = await buyBackdrop(async () => { throw Object.assign(new Error("x"), { name: "X402RecipientMismatchError" }); }, () => NOW);
    assert.equal(payee.status, "failed");
    assert.equal(payee.status === "failed" && payee.reason, "X402RecipientMismatchError");
  });
  it("a payment is never started once the deadline has passed", async () => {
    let calls = 0;
    const ctl = new AbortController();
    ctl.abort();
    const b = await buyBackdrop(async () => { calls += 1; return paidOk(); }, () => NOW, ctl.signal);
    assert.deepEqual([b.status, b.status === "failed" && b.reason, calls], ["failed", "deadline", 0]);
  });
  it("any other failure is 'failed', whether returned or thrown", async () => {
    const r = await buyBackdrop(async () => ({ ok: false, error: "X402HostNotAllowedError", message: "x" }), () => NOW);
    assert.equal(r.status, "failed");
    const t = await buyBackdrop(async () => { throw new Error("wallet not unlocked"); }, () => NOW);
    assert.equal(t.status, "failed");
    assert.equal(t.status === "failed" && t.reason, "Error");
  });
});
