import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import {
  HttpTradeDataPlaneReads,
  type EligibilityBatchRow,
  type TokenBatchRow,
  type TradeDataPlaneReads,
  type UniverseRow,
} from "../src/trade/dataPlaneReads.js";
import {
  MIN_PIN,
  ModelUnavailableError,
  PIN_MAX_READS,
  PinTooSmallError,
  PinUnreadableError,
  TRADE_READ_BUDGET,
  createTradeVerdictCache,
  isEntryExcludedToken,
  isUsEquityOpen,
  marketHoursByAddress,
  pinUniverse,
  rerankHeld,
  selectEntryCandidates,
  type PinnedCandidate,
} from "../src/trade/universe.js";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/trade/${name}`, import.meta.url), "utf8")) as T;
}

const universeEnvelope = fixture<{ readonly data: readonly UniverseRow[] }>("universe.bstocks.json");
const tokenEnvelope = fixture<{ readonly data: readonly TokenBatchRow[] }>("tokens.batch.json");
const eligibilityEnvelope = fixture<{ readonly data: readonly EligibilityBatchRow[] }>("eligibility.batch.json");

function fakeReads(overrides: Partial<TradeDataPlaneReads> = {}): TradeDataPlaneReads {
  return {
    async universe(lane) {
      if (lane === "allowlist") return null;
      return lane === "bstocks" ? universeEnvelope.data : [];
    },
    async tokensBatch(addresses) {
      const wanted = new Set(addresses.map((address) => address.toLowerCase()));
      return tokenEnvelope.data.filter((row) => wanted.has(row.address.toLowerCase()));
    },
    async eligibilityBatch(addresses) {
      const wanted = new Set(addresses.map((address) => address.toLowerCase()));
      return eligibilityEnvelope.data.filter((row) => wanted.has(row.address.toLowerCase()));
    },
    async security() {
      return { riskLevel: "ok", flags: [] };
    },
    ...overrides,
  };
}

describe("TRADING-AGENT R3 pin universe", () => {
  it("excludes stablecoins, BTCB and exact Ondo wrappers before refilling the pin", async () => {
    const excluded = [
      { address: getAddress("0x55d398326f99059fF775485246999027B3197955"), symbol: "USDT" },
      { address: getAddress("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"), symbol: "BTCB" },
      { address: getAddress("0xa9eE28C80f960B889dFbd1902055218cBa016F75"), symbol: "NVDAon" },
      { address: getAddress("0x9999999999999999999999999999999999999999"), symbol: " usdc " },
    ];
    const usable = Array.from({ length: MIN_PIN }, (_, index) => ({
      address: getAddress(`0x${(5_000 + index).toString(16).padStart(40, "0")}`),
      symbol: `VALID${index}`,
    }));
    const rows = [...excluded, ...usable].map(({ address, symbol }): UniverseRow => ({
      address, symbol, lane: "meme", source: "fixture",
    }));
    const byAddress = new Map(rows.map((row) => [row.address.toLowerCase(), row]));
    const pinned = await pinUniverse("degen", { dataPlane: fakeReads({
      async universe(lane) { return lane === "meme" ? rows : []; },
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({
        address,
        symbol: byAddress.get(address.toLowerCase())?.symbol,
        priceUsd: 1, marketCapUsd: 1_000, volume24hUsd: 1, holders: 1, priceChange24hPct: 1,
      })); },
    }) });
    assert.equal(pinned.length, MIN_PIN);
    assert.equal(pinned.some((row) => excluded.some((item) => item.address === row.address)), false);
    assert.equal(isEntryExcludedToken(excluded[0]!.address, excluded[0]!.symbol), true);
    assert.equal(isEntryExcludedToken(excluded[3]!.address, excluded[3]!.symbol), true);
    assert.equal(isEntryExcludedToken(usable[0]!.address), false);
  });

  it("admits bStocks when the allowlist lane is absent and ranks by volume", async () => {
    const pinned = await pinUniverse("blue-chip", { dataPlane: fakeReads() });
    assert.equal(pinned.length, 6);
    assert.deepEqual(pinned.map((row) => row.symbol), ["ONEB", "TWOB", "THREEB", "FOURB", "FIVEB", "SIXB"]);
    assert.ok(pinned.every((row) => row.marketHours === "us-equities"));
  });

  it("refuses Mid-Cap as model-unavailable when allowlist is absent", async () => {
    await assert.rejects(
      pinUniverse("mid-cap", { dataPlane: fakeReads() }),
      ModelUnavailableError,
    );
  });

  it("maps any lane or token transport failure to PinUnreadableError", async () => {
    await assert.rejects(pinUniverse("degen", {
      dataPlane: fakeReads({ async universe() { throw new Error("upstream secret"); } }),
    }), PinUnreadableError);
    await assert.rejects(pinUniverse("blue-chip", {
      dataPlane: fakeReads({ async tokensBatch() { throw new Error("upstream secret"); } }),
    }), PinUnreadableError);
  });

  it("refuses pins shorter than MIN_PIN", async () => {
    const rows = universeEnvelope.data.slice(0, MIN_PIN - 1);
    await assert.rejects(pinUniverse("blue-chip", {
      dataPlane: fakeReads({
        async universe(lane) { return lane === "bstocks" ? rows : null; },
      }),
    }), PinTooSmallError);
  });

  it("never exceeds 16 reads for a four-lane, 700-address Sigma universe", async () => {
    let reads = 0;
    const rows = Array.from({ length: 700 }, (_, index): UniverseRow => ({
      address: getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`),
      symbol: `T${index}`,
      lane: "meme",
      source: "fixture",
    }));
    const dataPlane = fakeReads({
      async universe(lane) {
        reads += 1;
        if (lane === "meme") return rows;
        return [];
      },
      async tokensBatch(addresses) {
        reads += 1;
        return addresses.map((address, index): TokenBatchRow => ({
          address,
          priceUsd: 1,
          marketCapUsd: 1_000,
          volume24hUsd: index,
          holders: 1,
          priceChange24hPct: 0,
        }));
      },
    });
    const pinned = await pinUniverse("sigma", { dataPlane });
    assert.equal(pinned.length, 25);
    assert.equal(reads, PIN_MAX_READS);
  });

  it("keeps the metadata pool at 600 addresses for one- and two-lane pins", async () => {
    const rows = Array.from({ length: 700 }, (_, index): UniverseRow => ({
      address: getAddress(`0x${(10_000 + index).toString(16).padStart(40, "0")}`),
      symbol: `T${index}`, lane: "meme", source: "fixture",
    }));
    const measure = async (model: "degen" | "blue-chip"): Promise<{ reads: number; maxBatch: number }> => {
      let reads = 0;
      let maxBatch = 0;
      const dataPlane = fakeReads({
        async universe(lane) {
          reads += 1;
          if (model === "degen") return lane === "meme" ? rows : [];
          return lane === "allowlist" ? rows.map((row) => ({ ...row, lane: "allowlist" as const })) : [];
        },
        async tokensBatch(addresses) {
          reads += 1;
          maxBatch = Math.max(maxBatch, addresses.length);
          return addresses.map((address, index): TokenBatchRow => ({
            address, symbol: `T${index}`, priceUsd: 1,
            marketCapUsd: model === "blue-chip" ? 2_000_000_000 : 1_000,
            volume24hUsd: index, holders: 1, priceChange24hPct: 0,
          }));
        },
      });
      const pinned = await pinUniverse(model, { dataPlane });
      assert.equal(pinned.length, 25);
      return { reads, maxBatch };
    };
    const degen = await measure("degen");
    const blueChip = await measure("blue-chip");
    assert.equal(degen.reads, 13);
    assert.equal(blueChip.reads, 14);
    assert.equal(degen.maxBatch, 50);
    assert.equal(blueChip.maxBatch, 50);
  });

  it("keeps a diversified bStock share in a 761-address Sigma union", async () => {
    const counts = { meme: 197, coins: 317, allowlist: 222, bstocks: 25 } as const;
    let next = 1;
    const byLane = Object.fromEntries(Object.entries(counts).map(([lane, count]) => [lane,
      Array.from({ length: count }, (): UniverseRow => ({
        address: getAddress(`0x${(next++).toString(16).padStart(40, "0")}`),
        symbol: lane, lane: lane as UniverseRow["lane"], source: "fixture",
        ...(lane === "bstocks" ? { marketHours: "us-equities" as const } : {}),
      }))])) as Record<UniverseRow["lane"], UniverseRow[]>;
    const bstocks = new Set(byLane.bstocks.map((row) => row.address.toLowerCase()));
    const dataPlane = fakeReads({
      async universe(lane) { return byLane[lane]; },
      async tokensBatch(addresses) { return addresses.map((address, index): TokenBatchRow => ({
        address, priceUsd: 1, marketCapUsd: 1_000,
        volume24hUsd: bstocks.has(address.toLowerCase()) ? 1_000_000 + index : index,
        holders: 1, priceChange24hPct: 0,
      })); },
    });
    const pinned = await pinUniverse("sigma", { dataPlane });
    assert.equal(pinned.filter((row) => bstocks.has(row.address.toLowerCase())).length, 8);
  });
});

describe("TRADING-AGENT C24 held re-rank and C25 hours", () => {
  it("promotes positive balances with concurrency-bounded reads", async () => {
    let active = 0;
    let peak = 0;
    const result = await rerankHeld(
      tokenEnvelope.data.map((token, index): PinnedCandidate => ({
        ...token,
        symbol: token.symbol ?? `T${index}`,
        lane: "bstocks",
      })),
      async (address) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return address.toLowerCase().endsWith("6") ? 1n : 0n;
      },
    );
    assert.equal(result[0]?.address.toLowerCase().endsWith("6"), true);
    assert.ok(peak <= 4);
  });

  it("returns the original volume order when any balance read fails", async () => {
    const candidates = (await pinUniverse("blue-chip", { dataPlane: fakeReads() }));
    const result = await rerankHeld(candidates, async (address) => {
      if (address === candidates[2]?.address) throw new Error("rpc down");
      return 1n;
    });
    assert.strictEqual(result, candidates);
  });

  it("resolves hours by address and uses Mon-Fri [13:30,20:00) UTC", () => {
    const hours = marketHoursByAddress(universeEnvelope.data);
    assert.equal(hours.has(universeEnvelope.data[0]?.address.toLowerCase() ?? ""), true);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 8, 7, 13, 29)), false);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 8, 7, 13, 30)), true);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 8, 7, 19, 59)), true);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 8, 7, 20, 0)), false);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 8, 6, 14, 0)), false);
  });
});

describe("TRADING-AGENT R3.4/C26 entry pipeline", () => {
  const settings = {
    minMarketCapUsd: null,
    maxMarketCapUsd: null,
    noReentry: false,
  } as const;

  async function inputs(dataPlane: TradeDataPlaneReads) {
    const candidates = await pinUniverse("blue-chip", { dataPlane: fakeReads() });
    return {
      model: "blue-chip" as const,
      settings,
      candidates,
      pinnedAddresses: new Set(candidates.map((row) => row.address.toLowerCase())),
      previouslyEnteredAddresses: new Set<string>(),
      openPositionAddresses: new Set<string>(),
      forbiddenAddresses: new Set<string>(),
      usEquityAddresses: new Set<string>(),
      dataPlane,
      signal: new AbortController().signal,
      nowMs: Date.UTC(2026, 8, 7, 14),
      verdictCache: createTradeVerdictCache(),
    };
  }

  it("branches on all four eligibility sources, ranks before scanning, and records token refusals", async () => {
    const scanned: string[] = [];
    const dataPlane = fakeReads({
      async security(address) {
        scanned.push(address.toLowerCase());
        return address.toLowerCase().endsWith("4")
          ? null
          : { riskLevel: "ok", flags: [] };
      },
    });
    const result = await selectEntryCandidates(await inputs(dataPlane));
    assert.equal(result.kind, "selected");
    if (result.kind !== "selected") return;
    assert.deepEqual(result.candidates.map((row) => row.routeKind), [
      "pancake-discovery", "pancake-discovery", "fourmeme", "pancake-v2",
    ]);
    assert.equal(result.refusals.some((row) => row.reason === "chain_unavailable"), true);
    assert.equal(result.refusals.some((row) => row.reason === "scan_unavailable"), true);
    assert.equal(scanned.some((address) => address.endsWith("5")), false);
    assert.ok(result.reads <= TRADE_READ_BUDGET);
  });

  it("aborts the whole cycle when security throws", async () => {
    const result = await selectEntryCandidates(await inputs(fakeReads({
      async security(address) {
        if (address.toLowerCase().endsWith("3")) throw new Error("transport detail");
        return { riskLevel: "ok", flags: [] };
      },
    })));
    assert.deepEqual(result.kind === "aborted" ? result.reason : null, "data-plane-unavailable");
  });

  it("caches scan verdicts for 300 seconds", async () => {
    let scans = 0;
    const cache = createTradeVerdictCache();
    const dataPlane = fakeReads({ async security() { scans += 1; return { riskLevel: "ok", flags: [] }; } });
    const first = { ...(await inputs(dataPlane)), verdictCache: cache };
    await selectEntryCandidates(first);
    const afterFirst = scans;
    await selectEntryCandidates({ ...first, nowMs: first.nowMs + 299_000 });
    assert.equal(scans, afterFirst);
    await selectEntryCandidates({ ...first, nowMs: first.nowMs + 300_001 });
    assert.ok(scans > afterFirst);
  });
});

describe("trade data-plane recorded envelopes", () => {
  it("reads the real envelope shapes and sends the existing x-dp-token header", async () => {
    const seen: Array<{ readonly url: string; readonly token: string | null }> = [];
    const client = new HttpTradeDataPlaneReads({
      baseUrl: "https://data.example/internal/",
      token: "test-token",
      fetch: async (url, init) => {
        seen.push({ url, token: new Headers(init?.headers).get("x-dp-token") });
        if (url.includes("universe")) return Response.json(universeEnvelope);
        if (url.includes("eligibility")) return Response.json(eligibilityEnvelope);
        if (url.includes("tokens")) return Response.json(tokenEnvelope);
        return Response.json({ data: { riskLevel: "ok", flags: [] } });
      },
    });
    assert.equal((await client.universe("bstocks"))?.length, 6);
    const addresses = universeEnvelope.data.map((row) => row.address);
    assert.equal((await client.tokensBatch(addresses)).length, 6);
    assert.equal((await client.eligibilityBatch(addresses)).length, 6);
    assert.equal((await client.security(addresses[0] as Address)) !== null, true);
    assert.ok(seen.every((row) => row.url.startsWith("https://data.example/internal/")));
    assert.ok(seen.every((row) => row.token === "test-token"));
  });

  it("maps only allowlist invalid_lane to an absent lane", async () => {
    const client = new HttpTradeDataPlaneReads({
      baseUrl: "https://data.example/",
      fetch: async () => Response.json({ error: { code: "invalid_lane" } }, { status: 400 }),
    });
    assert.equal(await client.universe("allowlist"), null);
    await assert.rejects(client.universe("coins"), /status 400/u);
  });
});
