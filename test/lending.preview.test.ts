/**
 * The guardable preview's receipt, cache and limiter
 * (MARKETPLACE-LENDING-AGENT R2.10, R2.11, R3.8; REVIEW2 M4).
 *
 * The receipt AUTHORIZES NOTHING — §0.5 lets anyone guard any address — so
 * these tests are about FRESHNESS and BINDING: a receipt must not verify for
 * inputs it was not issued for, and it must not verify after 30 seconds.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  LENDING_PREVIEW_CACHE_MS,
  LENDING_PREVIEW_PER_ACCOUNT_PER_MIN,
  LENDING_PREVIEW_TTL_SEC,
  createLendingPreviewCache,
  createLendingPreviewLimiter,
  issueLendingPreviewReceipt,
  parseLendingPreviewSecret,
  verifyLendingPreviewReceipt,
} from "../src/lending/preview.js";

const KEY = parseLendingPreviewSecret("ab".repeat(32))!;
const OTHER = parseLendingPreviewSecret("cd".repeat(32))!;
const ACCOUNT = getAddress("0x00000000000000000000000000000000000000a9");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const NOW = 1_900_000_000;

const CLAIMS = {
  account: ACCOUNT,
  blockNumber: "120000000",
  guardable: true,
  debts: [{ vToken: V_USDT, borrowWei: "700000000000000000000" }],
  budgetWei: "500000000000000000",
  reserveBps: 2_000,
  maxPerActionUsdtWei: "100000000000000000000",
  rescueReserveCount: 6,
  mintUsdtWei: "237600000000000000000",
  tierBuyBackUsdtWei: "59400000000000000000",
  reserveCapFloorWei: "558360000000000000000",
  minimumCapDayWei: "900000800000000000",
} as const;

describe("parseLendingPreviewSecret — its OWN secret, on the accountReadSession pattern", () => {
  it("accepts exactly 64 lowercase hex characters", () => {
    assert.equal(parseLendingPreviewSecret("ab".repeat(32))?.length, 32);
  });
  it("answers null for absent or empty, which is the FAIL-CLOSED state", () => {
    assert.equal(parseLendingPreviewSecret(undefined), null);
    assert.equal(parseLendingPreviewSecret("   "), null);
  });
  it("THROWS on a malformed secret — a boot failure, never a per-request refusal", () => {
    assert.throws(() => parseLendingPreviewSecret("AB".repeat(32)), /64 lowercase hex/u);
    assert.throws(() => parseLendingPreviewSecret("ab"), /64 lowercase hex/u);
  });
});

describe("the receipt", () => {
  it("round-trips every bound field", () => {
    const { token, expiresAt } = issueLendingPreviewReceipt({
      key: KEY, nowSec: NOW, claims: CLAIMS,
    });
    assert.equal(expiresAt, NOW + LENDING_PREVIEW_TTL_SEC);
    const verified = verifyLendingPreviewReceipt(token, KEY, NOW);
    assert.ok(verified !== null);
    assert.equal(verified.account, ACCOUNT);
    assert.equal(verified.budgetWei, CLAIMS.budgetWei);
    assert.equal(verified.reserveBps, CLAIMS.reserveBps);
    assert.equal(verified.maxPerActionUsdtWei, CLAIMS.maxPerActionUsdtWei);
    assert.equal(verified.rescueReserveCount, CLAIMS.rescueReserveCount);
    assert.equal(verified.mintUsdtWei, CLAIMS.mintUsdtWei);
    assert.equal(verified.tierBuyBackUsdtWei, CLAIMS.tierBuyBackUsdtWei);
    assert.equal(verified.debts[0]?.vToken, V_USDT);
  });

  it("is refused by ANOTHER key", () => {
    const { token } = issueLendingPreviewReceipt({ key: KEY, nowSec: NOW, claims: CLAIMS });
    assert.equal(verifyLendingPreviewReceipt(token, OTHER, NOW), null);
  });

  it("expires after exactly 30 seconds", () => {
    const { token } = issueLendingPreviewReceipt({ key: KEY, nowSec: NOW, claims: CLAIMS });
    assert.ok(verifyLendingPreviewReceipt(token, KEY, NOW + LENDING_PREVIEW_TTL_SEC - 1) !== null);
    assert.equal(verifyLendingPreviewReceipt(token, KEY, NOW + LENDING_PREVIEW_TTL_SEC), null);
  });

  it("is refused when its payload is TAMPERED — every field is under the MAC", () => {
    const { token } = issueLendingPreviewReceipt({ key: KEY, nowSec: NOW, claims: CLAIMS });
    const [version, payload, mac] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8"));
    decoded.budgetWei = "5000000000000000000";
    const forged = `${version}.${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${mac}`;
    assert.equal(verifyLendingPreviewReceipt(forged, KEY, NOW), null);
  });

  it("is refused for every malformed shape, indistinguishably", () => {
    for (const bad of [
      "", "v1", "v1.a.b", "v2." + "a".repeat(40) + "." + "b".repeat(43),
      "v1.".padEnd(2_000, "a"),
    ]) {
      assert.equal(verifyLendingPreviewReceipt(bad, KEY, NOW), null);
    }
  });

  it("is refused when a field the codec does not know is added", () => {
    const { token } = issueLendingPreviewReceipt({ key: KEY, nowSec: NOW, claims: CLAIMS });
    const [version, payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8"));
    decoded.extra = 1;
    const bytes = Buffer.from(JSON.stringify(decoded), "utf8");
    // Re-MAC it with the real key: even a correctly signed receipt whose SHAPE
    // is unexpected is refused, because the key set is compared literally.
    const mac = createHmac("sha256", KEY)
      .update("4lpha-lending-preview:v1.", "ascii").update(bytes).digest().toString("base64url");
    const forged = `${version}.${bytes.toString("base64url")}.${mac}`;
    assert.equal(verifyLendingPreviewReceipt(forged, KEY, NOW), null);
  });
});

describe("the limiter and the cache (R2.11)", () => {
  it("bounds ONE account at ten per minute", () => {
    let now = 0;
    const limiter = createLendingPreviewLimiter(() => now);
    const results: boolean[] = [];
    for (let index = 0; index < LENDING_PREVIEW_PER_ACCOUNT_PER_MIN + 2; index += 1) {
      results.push(limiter.tryConsume(ACCOUNT, "1.2.3.4"));
    }
    assert.equal(results.filter(Boolean).length, LENDING_PREVIEW_PER_ACCOUNT_PER_MIN);
    now += 60_001;
    assert.equal(limiter.tryConsume(ACCOUNT, "1.2.3.4"), true, "the bucket refills");
  });

  it("bounds the GLOBAL rate across all accounts", () => {
    let now = 0;
    const limiter = createLendingPreviewLimiter(() => now);
    let allowed = 0;
    for (let index = 0; index < 100; index += 1) {
      const account = getAddress(`0x${index.toString(16).padStart(40, "0")}`);
      if (limiter.tryConsume(account, null)) allowed += 1;
    }
    assert.equal(allowed, 60, "the global bucket is the aggregate bound");
  });

  it("the cache is keyed on the BLOCK too, so an answer never crosses a boundary", () => {
    let now = 0;
    const cache = createLendingPreviewCache<string>(() => now);
    cache.set(ACCOUNT, 100n, "at-100");
    assert.equal(cache.get(ACCOUNT, 100n), "at-100");
    assert.equal(
      cache.get(ACCOUNT, 101n), undefined,
      "the position it describes is a fact about ONE height",
    );
    now += LENDING_PREVIEW_CACHE_MS + 1;
    assert.equal(cache.get(ACCOUNT, 100n), undefined, "and it expires");
  });
});
