import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  issueAccountReadSession,
  parseAccountReadSessionSecret,
  verifyAccountReadSession,
  type AccountReadSessionConfig,
} from "../src/auth/accountReadSession.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const ENVIRONMENT = `0x${"22".repeat(32)}` as const;
const key = parseAccountReadSessionSecret("ab".repeat(32))!;

function config(environment = ENVIRONMENT): AccountReadSessionConfig {
  return { key, chainId: 56, environment };
}

describe("account read session", () => {
  it("rejects a valid-MAC token over 24 hours and never extends an older short token", () => {
    const issued = issueAccountReadSession({ owner: OWNER, nowSec: 1_000,
      signedIssuedAt: 995n, signedExpiry: 1_120n, config: config() });
    const raw = JSON.parse(Buffer.from(issued.token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const tokenWithExpiry = (expiry: number) => {
      const payload = Buffer.from(JSON.stringify({ ...raw, expiry }));
      const signature = createHmac("sha256", key).update("4lpha-account-read:v1.", "ascii").update(payload).digest("base64url");
      return `v1.${payload.toString("base64url")}.${signature}`;
    };
    assert.equal(verifyAccountReadSession(tokenWithExpiry(1_000 + 86_401), config(), 1_001), null);
    assert.equal(verifyAccountReadSession(tokenWithExpiry(1_900), config(), 1_899), OWNER);
    assert.equal(verifyAccountReadSession(tokenWithExpiry(1_900), config(), 1_900), null);
  });

  it("round-trips a scoped token and expires it", () => {
    const issued = issueAccountReadSession({
      owner: OWNER,
      nowSec: 1_000,
      signedIssuedAt: 995n,
      signedExpiry: 1_120n,
      config: config(),
    });
    assert.equal(issued.expiry, 995 + 86_400);
    assert.equal(verifyAccountReadSession(issued.token, config(), 1_001), OWNER);
    assert.equal(verifyAccountReadSession(issued.token, config(), 1_901), OWNER);
    assert.equal(verifyAccountReadSession(issued.token, config(), issued.expiry - 1), OWNER);
    assert.equal(verifyAccountReadSession(issued.token, config(), issued.expiry), null);
    assert.equal(verifyAccountReadSession(issued.token, config(), issued.expiry + 1), null);
  });

  it("rejects tampering and a different environment", () => {
    const issued = issueAccountReadSession({ owner: OWNER, nowSec: 2_000, signedIssuedAt: 1_995n, signedExpiry: 2_120n, config: config() });
    const parts = issued.token.split(".");
    const alteredMac = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
    assert.equal(verifyAccountReadSession(`${parts[0]}.${parts[1]}.${alteredMac}`, config(), 2_001), null);
    assert.equal(verifyAccountReadSession(issued.token, config(`0x${"33".repeat(32)}`), 2_001), null);
    assert.equal(verifyAccountReadSession(issued.token, { ...config(), key: parseAccountReadSessionSecret("ef".repeat(32))! }, 2_001), null);
  });

  it("rejects old rotation keys and non-canonical base64url aliases", () => {
    const oldConfig = config();
    const newConfig = { ...config(), key: parseAccountReadSessionSecret("ef".repeat(32))! };
    const oldIssued = issueAccountReadSession({ owner: OWNER, nowSec: 30_000, signedIssuedAt: 29_995n, signedExpiry: 30_120n, config: oldConfig });
    const newIssued = issueAccountReadSession({ owner: OWNER, nowSec: 30_000, signedIssuedAt: 29_995n, signedExpiry: 30_120n, config: newConfig });
    assert.equal(verifyAccountReadSession(oldIssued.token, newConfig, 30_001), null);
    assert.equal(verifyAccountReadSession(newIssued.token, newConfig, 30_001), OWNER);

    const [version, payload, signature] = newIssued.token.split(".") as [string, string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const decoded = Buffer.from(payload, "base64url");
    const alias = [...alphabet].map((candidate) => `${payload.slice(0, -1)}${candidate}`)
      .find((candidate) => candidate !== payload && Buffer.from(candidate, "base64url").equals(decoded));
    assert.ok(alias, "fixture must expose a non-canonical base64url alias");
    assert.equal(verifyAccountReadSession(`${version}.${alias}.${signature}`, newConfig, 30_001), null);
  });

  it("fails closed on malformed secret material", () => {
    assert.equal(parseAccountReadSessionSecret(""), null);
    assert.throws(() => parseAccountReadSessionSecret("AB".repeat(32)), /64 lowercase hex/u);
  });
});
