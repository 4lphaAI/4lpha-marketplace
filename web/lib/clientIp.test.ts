import { describe, expect, it } from "vitest";

import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6, UNKNOWN_CLIENT, clientIp, isCloudflareIp, parseIp } from "./clientIp";

const h = (init: Record<string, string>): Headers => new Headers(init);

describe("clientIp", () => {
  it("behind Cloudflare (x-real-ip is an edge address), keys on cf-connecting-ip", () => {
    expect(clientIp(h({ "x-real-ip": "172.64.10.1", "cf-connecting-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(h({ "x-real-ip": "104.16.0.1", "cf-connecting-ip": " 203.0.113.5 " }))).toBe("203.0.113.5");
    expect(clientIp(h({ "x-real-ip": "172.64.10.1", "cf-connecting-ip": "2001:DB8::9" }))).toBe("2001:db8::9");
  });

  it("an IPv6 Cloudflare edge address is recognised too", () => {
    expect(clientIp(h({ "x-real-ip": "2606:4700:10::6814:1", "cf-connecting-ip": "198.51.100.8" }))).toBe("198.51.100.8");
    expect(clientIp(h({ "x-real-ip": "2a06:98c0:1::1", "cf-connecting-ip": "198.51.100.8" }))).toBe("198.51.100.8");
    expect(clientIp(h({ "x-real-ip": "::ffff:104.16.0.9", "cf-connecting-ip": "198.51.100.8" }))).toBe("198.51.100.8");
  });

  it("a forged cf-connecting-ip with a non-Cloudflare x-real-ip is ignored (no fresh bucket)", () => {
    expect(clientIp(h({ "x-real-ip": "203.0.113.9", "cf-connecting-ip": "198.51.100.7" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "x-real-ip": "2001:db8::1", "cf-connecting-ip": "198.51.100.7" }))).toBe("2001:db8::1");
    // Just outside two ranges.
    expect(clientIp(h({ "x-real-ip": "104.15.255.255", "cf-connecting-ip": "198.51.100.7" }))).toBe("104.15.255.255");
    expect(clientIp(h({ "x-real-ip": "172.63.255.255", "cf-connecting-ip": "198.51.100.7" }))).toBe("172.63.255.255");
  });

  it("a missing or malformed cf-connecting-ip falls back to the Cloudflare edge address", () => {
    expect(clientIp(h({ "x-real-ip": "172.64.10.1" }))).toBe("172.64.10.1");
    for (const bad of ["", "not an ip", "999.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.4:80", "[::1]", "::1::2", "2001:db8::g", "x".repeat(70), "198.51.100.7, 198.51.100.8"]) {
      expect(clientIp(h({ "x-real-ip": "172.64.10.1", "cf-connecting-ip": bad })), bad).toBe("172.64.10.1");
    }
  });

  it("keeps the shared unknown bucket for a missing or malformed x-real-ip, whatever cf-connecting-ip says", () => {
    expect(clientIp(h({}))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(h({ "cf-connecting-ip": "198.51.100.7" }))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(h({ "x-real-ip": "not an ip!", "cf-connecting-ip": "198.51.100.7" }))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(h({ "x-real-ip": "x".repeat(65) }))).toBe(UNKNOWN_CLIENT);
  });

  it("without Cloudflare in the path it is the plain x-real-ip, lower-cased and trimmed", () => {
    expect(clientIp(h({ "x-real-ip": " 2001:DB8::1 " }))).toBe("2001:db8::1");
    expect(clientIp(h({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });
});

describe("Cloudflare range matching", () => {
  it("covers the first and last address of every published IPv4 range", () => {
    const dotted = (n: bigint): string => [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".");
    for (const cidr of CLOUDFLARE_IPV4) {
      const [base, bits] = cidr.split("/") as [string, string];
      const first = parseIp(base)!.value;
      const size = 1n << (32n - BigInt(bits));
      expect(isCloudflareIp(dotted(first)), cidr).toBe(true);
      expect(isCloudflareIp(dotted(first + size - 1n)), cidr).toBe(true);
    }
    expect(isCloudflareIp("173.245.47.255")).toBe(false);
    expect(isCloudflareIp("173.245.64.0")).toBe(false);
    expect(isCloudflareIp("131.0.76.0")).toBe(false);
    expect(isCloudflareIp("8.8.8.8")).toBe(false);
    expect(isCloudflareIp("1.1.1.1")).toBe(false);
  });

  it("IPv6 ranges", () => {
    expect(CLOUDFLARE_IPV6.length).toBe(7);
    expect(isCloudflareIp("2400:cb00::1")).toBe(true);
    expect(isCloudflareIp("2400:cb01::1")).toBe(false);
    expect(isCloudflareIp("2a06:98c0::1")).toBe(true);
    expect(isCloudflareIp("2a06:98c7:ffff::1")).toBe(true);
    expect(isCloudflareIp("2a06:98c8::1")).toBe(false);
    expect(isCloudflareIp("2c0f:f248:0:0:0:0:0:1")).toBe(true);
    expect(isCloudflareIp("2001:db8::1")).toBe(false);
  });

  it("parses literals strictly", () => {
    expect(parseIp("::")).toEqual({ version: 6, value: 0n });
    expect(parseIp("::1")?.version).toBe(6);
    expect(parseIp("1:2:3:4:5:6:7:8")?.version).toBe(6);
    expect(parseIp("1:2:3:4:5:6:7")).toBeNull();
    expect(parseIp("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIp("1::2::3")).toBeNull();
    expect(parseIp("12345::1")).toBeNull();
    expect(parseIp("::ffff:1.2.3.4")).toEqual({ version: 4, value: 0x01020304n });
    expect(parseIp("1.2.3.4::")).toBeNull();
    expect(parseIp("256.1.1.1")).toBeNull();
    expect(parseIp("")).toBeNull();
  });
});
