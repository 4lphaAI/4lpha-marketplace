/**
 * The TermiX transport: non-throwing parsers, the wire's strictness, and the
 * egress rules (QUANT-GRID W7, R2.8, R2.10, R2.11, H11, BC35).
 *
 * Nothing here touches the network: the HTTPS client is driven through an
 * injected `fetch`, so the redirect refusal and the final-destination check are
 * exercised for real without one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  HttpQuantTransport,
  MemoryQuantTransport,
  parseConfigBlock,
  parseDecimalToWei,
  parseIndexerTrade,
  parseInboxItem,
  parseQuantJob,
} from "../src/quant/termix.js";
import { QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56 } from "../src/quant/config.js";

const JOB_WIRE = {
  id: "job-1",
  status: "ACTIVE",
  strategyId: "strategy-1",
  tradingWalletAddress: "0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111",
  allocationU: "30.5",
  dailyCapU: "40",
  termDays: 30,
  startedAt: "2026-09-10T00:00:00.000Z",
  endsAt: "2026-10-10T00:00:00.000Z",
  sessionExpiresAt: "2026-10-10T00:00:00.000Z",
  revokedAt: null,
};

describe("decimal → wei, strictly (R2.8)", () => {
  it("parses integers and fractions exactly, without a float round trip", () => {
    assert.equal(parseDecimalToWei("30.5", 18), 30_500_000_000_000_000_000n);
    assert.equal(parseDecimalToWei("10", 18), 10n * 10n ** 18n);
    assert.equal(parseDecimalToWei("0.000000000000000001", 18), 1n);
    // A number big enough that `Number` would lose it.
    assert.equal(parseDecimalToWei("123456789012345678901234", 18),
      123_456_789_012_345_678_901_234n * 10n ** 18n);
  });

  it("REFUSES anything that is not digits with at most one point", () => {
    for (const raw of [
      "", "  ", "-1", "1e18", "1.2.3", "0x10", "abc", null, undefined, {}, [],
      "1.0000000000000000001",
    ]) {
      assert.equal(parseDecimalToWei(raw, 18), null, `accepted ${String(raw)}`);
    }
  });
});

describe("job parsing", () => {
  it("parses a well-formed job", () => {
    const parsed = parseQuantJob(JOB_WIRE, 18);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.data.allocationUWei, 30_500_000_000_000_000_000n);
    assert.equal(parsed.data.dailyCapUWei, 40n * 10n ** 18n);
    assert.equal(parsed.data.tradingWalletAddress,
      getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111"));
    assert.equal(parsed.data.revokedAtMs, null);
  });

  it("names the FIELD it refused on, never the value", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["allocationU", "not a number"],
      ["dailyCapU", "1e18"],
      ["termDays", 0],
      ["tradingWalletAddress", "not-an-address"],
      ["endsAt", "the tenth of never"],
      ["sessionExpiresAt", "soon"],
      ["strategyId", ""],
    ];
    for (const [field, value] of cases) {
      const parsed = parseQuantJob({ ...JOB_WIRE, [field]: value }, 18);
      assert.equal(parsed.ok, false, `accepted ${field}`);
      if (parsed.ok) continue;
      assert.equal(parsed.code, "wire-invalid");
      assert.equal(parsed.detail, field);
    }
  });

  it("treats an ABSENT optional timestamp as null and a NaN one as invalid", () => {
    const absent = parseQuantJob({ ...JOB_WIRE, revokedAt: undefined }, 18);
    assert.equal(absent.ok, true);
    if (absent.ok) assert.equal(absent.data.revokedAtMs, null);
    const bad = parseQuantJob({ ...JOB_WIRE, revokedAt: "not a date" }, 18);
    assert.equal(bad.ok, false);
  });
});

describe("inbox and trade parsing", () => {
  it("requires every envelope field", () => {
    const item = {
      envelopeId: "e", quantJobId: "j", ephemeralPublicKey: "p",
      nonce: "n", ciphertext: "c", algorithm: "a",
    };
    assert.equal(parseInboxItem(item).ok, true);
    for (const field of Object.keys(item)) {
      const parsed = parseInboxItem({ ...item, [field]: "" });
      assert.equal(parsed.ok, false, `accepted an empty ${field}`);
      if (!parsed.ok) assert.equal(parsed.detail, field);
    }
  });

  it("requires a 32-byte txHash on an indexer trade", () => {
    assert.equal(parseIndexerTrade({ txHash: "0x1234", direction: "buy" }).ok, false);
    const parsed = parseIndexerTrade({
      txHash: `0x${"ab".repeat(32)}`, direction: "buy",
      amountIn: "1", amountOut: "2", blockTime: "2026-09-10T00:00:00.000Z",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.data.txHash, `0x${"ab".repeat(32)}`);
  });
});

describe("config block parsing (§2.1)", () => {
  const block = {
    quant: {
      chainId: 56,
      token: { address: QUANT_U_56, decimals: 18, symbol: "U" },
      tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "direct" }],
      venueAllowlist: [QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56],
    },
  };

  it("parses the measured mainnet block", () => {
    const parsed = parseConfigBlock(block);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.data.chainId, 56);
    assert.equal(parsed.data.u, QUANT_U_56);
    assert.equal(parsed.data.tradableTokens.length, 1);
    assert.equal(parsed.data.venueAllowlist.length, 3);
  });

  it("accepts a venue entry as an object OR a bare address", () => {
    const parsed = parseConfigBlock({
      quant: { ...block.quant, venueAllowlist: [{ address: QUANT_ROUTER_56 }] },
    });
    assert.equal(parsed.ok, true);
  });

  it("refuses a malformed token or venue rather than skipping it", () => {
    assert.equal(parseConfigBlock({ quant: { ...block.quant, chainId: "56" } }).ok, false);
    assert.equal(
      parseConfigBlock({ quant: { ...block.quant, tradableTokens: [{ address: "x" }] } }).ok,
      false,
    );
    assert.equal(
      parseConfigBlock({ quant: { ...block.quant, venueAllowlist: [{ nope: 1 }] } }).ok, false,
    );
  });
});

describe("HTTPS transport egress", () => {
  function transportWith(impl: typeof fetch): HttpQuantTransport {
    return new HttpQuantTransport({
      baseUrl: "https://platform-backend.prod.termix.live",
      apiKey: "secret-bearer",
      fetchImpl: impl,
    });
  }

  it("refuses a base URL outside the one-entry allowlist at CONSTRUCTION", () => {
    assert.throws(
      () => new HttpQuantTransport({ baseUrl: "https://evil.example", apiKey: "x" }),
      /allowlist/u,
    );
  });

  it("sets redirect:'error' — an allowlist a 302 can leave is not one", async () => {
    let seen: RequestInit | undefined;
    const transport = transportWith((async (_url: URL, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
    await transport.inbox("agent-1");
    assert.equal(seen?.redirect, "error");
  });

  it("REFUSES a response whose FINAL url left the allowlist", async () => {
    const transport = transportWith((async () => {
      const response = new Response("{}", { status: 200 });
      Object.defineProperty(response, "url", { value: "https://evil.example/x" });
      return response;
    }) as unknown as typeof fetch);
    const result = await transport.job("job-1");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "transport-refused");
    assert.equal(result.detail, "final-origin");
  });

  it("classifies 401/403 apart from any other refusal", async () => {
    for (const [status, code] of [[401, "transport-unauthorized"], [500, "transport-refused"]] as const) {
      const transport = transportWith((async () => new Response("{}", { status })) as unknown as typeof fetch);
      const result = await transport.job("job-1");
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.code, code);
    }
  });

  it("reports a THROWN transport as unavailable, never as a refusal", async () => {
    const transport = transportWith((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
    const result = await transport.config();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "transport-unavailable");
  });

  it("carries the bearer and never returns it", async () => {
    let headers: Record<string, string> = {};
    const transport = transportWith((async (_url: URL, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch);
    const result = await transport.inbox("agent-1");
    assert.equal(headers["authorization"], "Bearer secret-bearer");
    assert.equal(JSON.stringify(result).includes("secret-bearer"), false);
  });

  it("SKIPS one malformed inbox item rather than blanking the page", async () => {
    const transport = transportWith((async () => new Response(JSON.stringify({
      items: [
        { envelopeId: "", quantJobId: "j", ephemeralPublicKey: "p", nonce: "n", ciphertext: "c", algorithm: "a" },
        { envelopeId: "e2", quantJobId: "j2", ephemeralPublicKey: "p", nonce: "n", ciphertext: "c", algorithm: "a" },
      ],
    }), { status: 200 })) as unknown as typeof fetch);
    const result = await transport.inbox("agent-1");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0]?.envelopeId, "e2");
  });
});

describe("in-memory transport (R2.10 / BC36)", () => {
  it("answers with the SAME record types the HTTPS parsers produce", async () => {
    const parsed = parseQuantJob(JOB_WIRE, 18);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const transport = new MemoryQuantTransport({
      config: {
        chainId: 56, u: QUANT_U_56, uDecimals: 18,
        tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "direct" }],
        venueAllowlist: [QUANT_ROUTER_56],
      },
      agentKey: { encryptionPublicKey: "abc", algorithm: "x25519-hkdf-chacha20poly1305" },
      inbox: [],
      jobs: new Map([[parsed.data.id, parsed.data]]),
      trades: new Map(),
      reports: [],
    });
    const job = await transport.job("job-1");
    assert.equal(job.ok, true);
    if (!job.ok) return;
    assert.equal(job.data.allocationUWei, 30_500_000_000_000_000_000n);
  });

  it("can fail ONE endpoint, so a hold path is exercisable", async () => {
    const transport = new MemoryQuantTransport({
      config: {
        chainId: 56, u: QUANT_U_56, uDecimals: 18, tradableTokens: [], venueAllowlist: [],
      },
      agentKey: { encryptionPublicKey: null, algorithm: null },
      inbox: [], jobs: new Map(), trades: new Map(), reports: [],
      failing: new Set(["inbox"]),
    });
    const result = await transport.inbox();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "transport-unavailable");
    assert.equal((await transport.config()).ok, true);
  });

  it("records every report attempt", async () => {
    const state = {
      config: {
        chainId: 56, u: QUANT_U_56, uDecimals: 18, tradableTokens: [], venueAllowlist: [],
      },
      agentKey: { encryptionPublicKey: null, algorithm: null },
      inbox: [], jobs: new Map(), trades: new Map(),
      reports: [] as { quantJobId: string; payload: { trades: readonly { txHash: `0x${string}`; note: string }[] } }[],
    };
    const transport = new MemoryQuantTransport(state);
    await transport.report("job-1", { trades: [{ txHash: `0x${"ab".repeat(32)}`, note: "n" }] });
    assert.equal(state.reports.length, 1);
    assert.equal(state.reports[0]?.quantJobId, "job-1");
  });
});
