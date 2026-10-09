/**
 * Caller identity behind Railway + Cloudflare, and the order of the two quota buckets. Offline: headers are plain
 * objects, the quotas are the real sliding-window limiters configured through the environment.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { callerIdentityProblems, clientIp, isCloudflareIp, parseIp, UNKNOWN_CLIENT } from "../src/callerIdentity.js";
import { isCommerceRateLimitError, limitCommerceOperation, withTrustedCaller } from "../src/requestLimits.js";

const EDGE_V4 = "172.71.80.5"; // inside 172.64.0.0/13
const EDGE_V6 = "2606:4700:3030::6815:1234"; // inside 2606:4700::/32

describe("isCloudflareIp", () => {
  it("knows the published IPv4 and IPv6 ranges and their edges", () => {
    for (const ip of [EDGE_V4, EDGE_V6, "173.245.48.0", "173.245.63.255", "104.16.0.1", "131.0.72.9", "2a06:98c0::1", "2c0f:f248::1"]) assert.ok(isCloudflareIp(ip), ip);
    for (const ip of ["173.245.64.0", "8.8.8.8", "172.72.0.1", "2606:4701::1", "2a06:98c8::1", "not an ip", ""]) assert.ok(!isCloudflareIp(ip), ip);
  });
  it("reads an IPv4-mapped IPv6 address as the IPv4 one", () => {
    assert.ok(isCloudflareIp("::ffff:172.71.80.5"));
    assert.ok(!isCloudflareIp("::ffff:8.8.8.8"));
  });
});

describe("parseIp is strict", () => {
  it("rejects ports, zones, brackets, short or padded forms", () => {
    for (const bad of ["1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.4:80", "[::1]", "fe80::1%eth0", "::1::2", "12345::1", ":::", "1.2.3.4/24", "a.b.c.d"]) assert.equal(parseIp(bad), null, bad);
    for (const good of ["1.2.3.4", "::1", "::", "2001:db8::8a2e:370:7334", "::ffff:1.2.3.4"]) assert.notEqual(parseIp(good), null, good);
  });
});

describe("clientIp", () => {
  it("a Cloudflare edge in x-real-ip plus a valid cf-connecting-ip is the client", () => {
    assert.equal(clientIp({ "x-real-ip": EDGE_V4, "cf-connecting-ip": "203.0.113.9" }), "203.0.113.9");
    assert.equal(clientIp({ "x-real-ip": EDGE_V6, "cf-connecting-ip": "203.0.113.9" }), "203.0.113.9");
    assert.equal(clientIp({ "x-real-ip": EDGE_V4, "cf-connecting-ip": "2001:DB8::A" }), "2001:db8::/64");
  });
  it("a non-Cloudflare x-real-ip wins even when a cf-connecting-ip header is present (a forged header buys nothing)", () => {
    assert.equal(clientIp({ "x-real-ip": "198.51.100.7", "cf-connecting-ip": "203.0.113.9" }), "198.51.100.7");
    assert.equal(clientIp({ "x-real-ip": "2001:db8::7", "cf-connecting-ip": "203.0.113.9" }), "2001:db8::/64");
  });
  it("a Cloudflare edge with a missing or invalid cf-connecting-ip is keyed on the edge", () => {
    assert.equal(clientIp({ "x-real-ip": EDGE_V4 }), EDGE_V4);
    for (const forged of ["not an ip", "1.2.3", "203.0.113.9, 1.1.1.1", "x".repeat(200), ""]) assert.equal(clientIp({ "x-real-ip": EDGE_V4, "cf-connecting-ip": forged }), EDGE_V4, forged);
    assert.equal(clientIp({ "x-real-ip": EDGE_V4, "cf-connecting-ip": ["203.0.113.9"] }), EDGE_V4);
  });
  it("a missing or invalid x-real-ip is the one shared key, whatever else is sent", () => {
    for (const real of [undefined, "", "  ", "garbage", "1.2.3", "198.51.100.7, 10.0.0.1", "<script>", "a".repeat(100), ["198.51.100.7"], "198.51.100.7:8080"]) {
      assert.equal(clientIp({ "x-real-ip": real, "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" }), UNKNOWN_CLIENT, String(real));
    }
    assert.equal(clientIp({}), UNKNOWN_CLIENT);
  });
  it("only x-real-ip and cf-connecting-ip are read: x-forwarded-for never becomes an identity", () => {
    assert.equal(clientIp({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" }), "198.51.100.7");
  });
  it("normalises case and surrounding space", () => {
    assert.equal(clientIp({ "x-real-ip": " 2001:DB8::7 " }), "2001:db8::/64");
  });
});

describe("IPv6 clients are keyed on their /64", () => {
  const key = (ip: string, cf?: string): string => clientIp(cf === undefined ? { "x-real-ip": ip } : { "x-real-ip": ip, "cf-connecting-ip": cf });
  it("two addresses in the same /64 share a key, different /64s differ", () => {
    assert.equal(key("2001:db8:1:2::1"), "2001:db8:1:2::/64");
    assert.equal(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), key("2001:db8:1:2::1"));
    assert.notEqual(key("2001:db8:1:3::1"), key("2001:db8:1:2::1"));
    assert.notEqual(key("2001:db8:2:2::1"), key("2001:db8:1:2::1"));
    assert.notEqual(key("2001:db9:1:2::1"), key("2001:db8:1:2::1"));
  });
  it("compressed and expanded forms of the same /64 are one key, in either case", () => {
    const forms = ["2001:db8:1:2::", "2001:0db8:0001:0002:0000:0000:0000:0000", "2001:DB8:1:2:0:0:0:1", "2001:db8:1:2::ffff", "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff"];
    for (const f of forms) assert.equal(key(f), "2001:db8:1:2::/64", f);
  });
  it("zero words inside the prefix are compressed canonically", () => {
    assert.equal(key("2001:db8::1:0:0:5"), "2001:db8::/64");
    assert.equal(key("2001:db8:0:1::5"), "2001:db8:0:1::/64");
    assert.equal(key("2001:0:0:1::9"), "2001:0:0:1::/64");
    assert.equal(key("2001::5:6:7:8"), "2001::/64");
    assert.equal(key("0:0:1:2::9"), "0:0:1:2::/64");
    assert.equal(key("::1"), "::/64");
  });
  it("an IPv4-mapped IPv6 address is the plain IPv4 address, and IPv4 stays a full address", () => {
    assert.equal(key("::ffff:198.51.100.7"), "198.51.100.7");
    assert.equal(key("::ffff:198.51.100.7"), key("198.51.100.7"));
    assert.notEqual(key("198.51.100.7"), key("198.51.100.8"));
    assert.equal(key("0:0:0:0:0:ffff:c633:6407"), "198.51.100.7");
  });
  it("the Cloudflare trust check uses the full address, and a forwarded IPv6 visitor is keyed on its /64", () => {
    assert.equal(key(EDGE_V6, "2001:db8:1:2::77"), "2001:db8:1:2::/64");
    assert.equal(key(EDGE_V6, "2001:db8:1:2:9::1"), "2001:db8:1:2::/64");
    assert.equal(key(EDGE_V4, "::ffff:203.0.113.9"), "203.0.113.9");
    // a /64 neighbour of a Cloudflare edge is not Cloudflare: the forged header is ignored
    assert.equal(key("2606:4701:3030::1", "203.0.113.9"), "2606:4701:3030::/64");
  });
});

describe("callerIdentityProblems", () => {
  it("names variables only", () => {
    const p = callerIdentityProblems({ SELLER_CALLER_IDENTITY: "SENTINEL_X", SELLER_TRUSTED_CALLER_HEADER: "SENTINEL H!" }, true).join(" ");
    assert.ok(p.includes("SELLER_CALLER_IDENTITY") && p.includes("SELLER_TRUSTED_CALLER_HEADER"));
    assert.ok(!p.includes("SENTINEL"));
  });
  it("outside production only the conflicts are refused, not a missing source", () => {
    assert.deepEqual(callerIdentityProblems({}, false), []);
    assert.equal(callerIdentityProblems({}, true).length, 1);
  });
});

describe("the caller bucket is checked before the global bucket", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("SELLER_")) delete process.env[k];
    Object.assign(process.env, saved);
  });
  // a distinct window per test gives each its own limiter instance (the cache is keyed on the configuration)
  const configure = (windowSeconds: string, globalMax: string, callerMax: string, mode: string | null = "railway-client-ip"): void => {
    process.env.SELLER_RATE_LIMIT_WINDOW_SECONDS = windowSeconds;
    process.env.SELLER_RATE_LIMIT_GLOBAL_MAX_REQUESTS = globalMax;
    process.env.SELLER_RATE_LIMIT_CALLER_MAX_REQUESTS = callerMax;
    if (mode === null) delete process.env.SELLER_CALLER_IDENTITY;
    else process.env.SELLER_CALLER_IDENTITY = mode;
    delete process.env.SELLER_TRUSTED_CALLER_HEADER;
  };
  const hit = async (ip: string | undefined): Promise<"ok" | "limited"> => {
    try {
      await withTrustedCaller(ip === undefined ? {} : { "x-real-ip": ip }, () => limitCommerceOperation("negotiate"));
      return "ok";
    } catch (e) {
      assert.ok(isCommerceRateLimitError(e));
      return "limited";
    }
  };

  it("a caller over its own limit leaves the global count untouched", async () => {
    configure("301", "4", "2");
    const a = [];
    for (let i = 0; i < 6; i += 1) a.push(await hit("198.51.100.1"));
    assert.deepEqual(a, ["ok", "ok", "limited", "limited", "limited", "limited"]);
    // only A's two accepted requests used global slots: another caller still fits twice in the global budget of 4
    assert.deepEqual([await hit("198.51.100.2"), await hit("198.51.100.2")], ["ok", "ok"]);
    // and now the global bucket is what refuses a third caller
    assert.equal(await hit("198.51.100.3"), "limited");
  });
  it("requests with no valid x-real-ip share one caller bucket instead of bypassing it", async () => {
    configure("302", "100", "2");
    const r = [await hit(undefined), await hit("garbage"), await hit("1.2.3"), await hit(undefined)];
    assert.deepEqual(r, ["ok", "ok", "limited", "limited"]);
    assert.equal(await hit("198.51.100.9"), "ok", "a real client is a different bucket");
  });
  it("each Cloudflare visitor is its own bucket; a forged cf-connecting-ip from a direct caller is not", async () => {
    configure("303", "100", "1");
    const via = (visitor: string) => withTrustedCaller({ "x-real-ip": EDGE_V4, "cf-connecting-ip": visitor }, () => limitCommerceOperation("negotiate"));
    await via("203.0.113.1");
    await via("203.0.113.2");
    await assert.rejects(via("203.0.113.1"), isCommerceRateLimitError);
    const forged = (v: string) => withTrustedCaller({ "x-real-ip": "198.51.100.50", "cf-connecting-ip": v }, () => limitCommerceOperation("negotiate"));
    await forged("203.0.113.77");
    await assert.rejects(forged("203.0.113.78"), isCommerceRateLimitError);
  });
  it("without a caller identity configured only the global bucket applies, as before", async () => {
    configure("304", "3", "1", null);
    assert.deepEqual([await hit("198.51.100.1"), await hit("198.51.100.1"), await hit("198.51.100.1"), await hit("198.51.100.1")], ["ok", "ok", "ok", "limited"]);
  });
  it("the trusted-header mode is unchanged when the new mode is not set", async () => {
    configure("305", "100", "1", null);
    process.env.SELLER_TRUSTED_CALLER_HEADER = "x-edge-caller";
    const via = (id: string) => withTrustedCaller({ "x-edge-caller": id }, () => limitCommerceOperation("negotiate"));
    await via("u1");
    await via("u2");
    await assert.rejects(via("u1"), isCommerceRateLimitError);
  });
});
