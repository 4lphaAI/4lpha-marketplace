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
  type VenueRow,
} from "../src/trade/dataPlaneReads.js";
import type { RwaFact } from "../src/trade/rwa.js";
import {
  MIN_PIN,
  ModelUnavailableError,
  PIN_MAX_READS,
  PinTooSmallError,
  PinUnreadableError,
  TRADE_READ_BUDGET,
  createTradeVerdictCache,
  isEntryExcludedToken,
  inModelBand,
  isUsEquityOpen,
  lanesFor,
  marketHoursByAddress,
  partitionPinnedCandidates,
  pinUniverse,
  rwaMarketClosed,
  rerankHeld,
  scheduleGrantList,
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
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => {
        const symbol = byAddress.get(address.toLowerCase())?.symbol;
        return { address, ...(symbol === undefined ? {} : { symbol }),
          priceUsd: 1, marketCapUsd: 1_000, volume24hUsd: 1, holders: 1, priceChange24hPct: 1 };
      }); },
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

  it("tracks Eastern Time through EST and DST boundaries", () => {
    const winter = (hour: number, minute: number) => Date.UTC(2026, 0, 15, hour, minute);
    assert.equal(isUsEquityOpen(winter(14, 29)), false);
    assert.equal(isUsEquityOpen(winter(14, 30)), true);
    assert.equal(isUsEquityOpen(winter(20, 59)), true);
    assert.equal(isUsEquityOpen(winter(21, 0)), false);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 2, 8, 13, 30)), false);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 2, 8, 14, 30)), false);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 10, 1, 13, 30)), false);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 10, 1, 14, 30)), false);
    assert.equal(isUsEquityOpen(Date.UTC(2026, 0, 17, 15, 0)), false);
    // R2.11: the Sunday vectors above prove only the weekend rule. These are
    // the trading weekdays straddling each 2026 DST transition (spring-forward
    // 2026-03-08, fall-back 2026-11-01), which is what actually proves DST awareness.
    assert.equal(isUsEquityOpen(Date.UTC(2026, 2, 6, 13, 30)), false, "Fri before spring-forward, still EST: 8:30am not yet open");
    assert.equal(isUsEquityOpen(Date.UTC(2026, 2, 6, 14, 30)), true, "Fri before spring-forward, still EST: 9:30am open");
    assert.equal(isUsEquityOpen(Date.UTC(2026, 2, 9, 13, 30)), true, "Mon after spring-forward, now EDT: 9:30am open");
    assert.equal(isUsEquityOpen(Date.UTC(2026, 2, 9, 20, 0)), false, "Mon after spring-forward, now EDT: 4:00pm closed");
    assert.equal(isUsEquityOpen(Date.UTC(2026, 9, 30, 13, 30)), true, "Fri before fall-back, still EDT: 9:30am open");
    assert.equal(isUsEquityOpen(Date.UTC(2026, 10, 2, 13, 30)), false, "Mon after fall-back, now EST: 8:30am not yet open");
    assert.equal(isUsEquityOpen(Date.UTC(2026, 10, 2, 14, 30)), true, "Mon after fall-back, now EST: 9:30am open");
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
      rwaAddresses: new Set<string>(),
      rwaFacts: new Map(),
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

  // 2026-09-15: a Sigma agent's run log said "13 skipped/refused" every cycle
  // while twelve of its twenty-five pinned tokens were dropped in silence by
  // `noReentry`. The partition is the selector's own first step, reported.
  it("reports what the owner's rules set aside before any read, once per token, re-entry first", async () => {
    const candidates = await pinUniverse("blue-chip", { dataPlane: fakeReads() });
    const [first, second, third, fourth] = candidates;
    assert.ok(first && second && third && fourth);
    const base = {
      candidates,
      pinnedAddresses: new Set(candidates.map((row) => row.address.toLowerCase())),
      previouslyEnteredAddresses: new Set([first.address.toLowerCase(), second.address.toLowerCase()]),
      // `second` is both traded-before and open: reported ONCE, as open.
      openPositionAddresses: new Set([second.address.toLowerCase(), third.address.toLowerCase()]),
      forbiddenAddresses: new Set([fourth.address.toLowerCase()]),
    };
    const on = partitionPinnedCandidates({ ...base, settings: { ...settings, noReentry: true } });
    assert.deepEqual(on.summary, {
      pinned: candidates.length,
      skippedReentry: [first.address],
      skippedOpen: 2,
      skippedForbidden: 1,
    });
    assert.equal(on.kept.length, candidates.length - 4);
    assert.equal(on.kept.some((row) => [first, second, third, fourth].includes(row)), false);

    // With the rule off, `first` flows through; `second` is still open.
    const off = partitionPinnedCandidates({ ...base, settings });
    assert.deepEqual(off.summary, { pinned: candidates.length, skippedReentry: [], skippedOpen: 2, skippedForbidden: 1 });
    assert.equal(off.kept.length, candidates.length - 3);

    // A token outside the pinned set is not part of the universe at all: not counted, not reported.
    const unpinned = partitionPinnedCandidates({ ...base, settings, pinnedAddresses: new Set([first.address.toLowerCase()]) });
    assert.deepEqual(unpinned.summary, { pinned: 1, skippedReentry: [], skippedOpen: 0, skippedForbidden: 0 });
    assert.deepEqual(unpinned.kept, [first]);

    // Review condition: the `.filter()` this replaced skipped array holes, so a
    // sparse candidate list still partitions instead of throwing before a read.
    const sparse = new Array<PinnedCandidate>(2);
    sparse[1] = first;
    const holes = partitionPinnedCandidates({ ...base, settings, candidates: sparse });
    assert.deepEqual(holes.kept, [first]);
    assert.equal(holes.summary.pinned, 1);
  });

  it("carries the prefilter summary on every result shape, including an abort", async () => {
    const base = await inputs(fakeReads());
    const [first] = base.candidates;
    assert.ok(first);
    const withReentry = { ...base, settings: { ...settings, noReentry: true }, previouslyEnteredAddresses: new Set([first.address.toLowerCase()]) };
    const selected = await selectEntryCandidates(withReentry);
    assert.equal(selected.prefilter.pinned, base.candidates.length);
    assert.deepEqual(selected.prefilter.skippedReentry, [first.address]);
    // A fresh verdict cache: the first call cached every scan, and a cached verdict never reads.
    const aborted = await selectEntryCandidates({ ...withReentry, verdictCache: createTradeVerdictCache(), dataPlane: fakeReads({ async security() { throw new Error("transport detail"); } }) });
    assert.equal(aborted.kind, "aborted");
    assert.deepEqual(aborted.prefilter.skippedReentry, [first.address]);
    // Everything set aside: no read is spent and the summary still says why.
    const nothingLeft = await selectEntryCandidates({ ...withReentry, previouslyEnteredAddresses: new Set(base.candidates.map((row) => row.address.toLowerCase())) });
    assert.equal(nothingLeft.kind, "selected");
    assert.equal(nothingLeft.reads, 0);
    assert.equal(nothingLeft.prefilter.skippedReentry.length, base.candidates.length);
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

describe("TradFi universe and RWA screening", () => {
  const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
  const nowMs = Date.UTC(2026, 8, 17, 14);

  function row(index: number, lane: "bstocks" | "ondo", ticker: string | null, liquidity: number, options: { readonly openState?: boolean; readonly reasonCode?: string; readonly venues?: readonly VenueRow[] } = {}): UniverseRow {
    const address = getAddress(`0x${index.toString(16).padStart(40, "0")}`);
    const venue: VenueRow = { dex: "uniswap", version: "v3", pool: getAddress(`0x${(index + 100).toString(16).padStart(40, "0")}`),
      feeTier: 500, quote: USDT, quoteSymbol: "USDT", priceUsd: 100, liquidityUsd: liquidity, volume24hUsd: 1, asOf: nowMs };
    const venues = options.venues ?? [venue];
    const rwa: RwaFact = { platform: lane === "bstocks" ? "bstock" : "ondo", underlyingTicker: ticker,
      tokenPriceUsd: 100, referencePriceUsd: 100, premiumBps: 0, openState: options.openState ?? true,
      marketStatus: null, reasonCode: options.reasonCode ?? "TRADING", staleness: "fresh", tokenToShareRatio: 1,
      onchainPriceUsd: 100, venues };
    return { address, symbol: `${lane}${index}`, lane, source: "fixture", rwa, venues };
  }

  it("pins TradFi lanes with admission, bStocks precedence, ticker dedupe, and deepest-venue ranking", async () => {
    // Liquidity in USD; the $10k floor (RWA_MIN_VENUE_LIQUIDITY_USD) admits only pools at or above it.
    const bNvda = row(1, "bstocks", " nvda ", 10_000);
    const oNvda = row(2, "ondo", "NVDA", 100_000);
    const oEemWeak = row(3, "ondo", "EEM", 50_000);
    const oEemDeep = row(4, "ondo", " eem ", 80_000);
    const oNullOne = row(5, "ondo", null, 20_000);
    const oNullTwo = row(6, "ondo", null, 30_000);
    const bAapl = row(7, "bstocks", "AAPL", 200_000);
    const invalid = [
      row(8, "ondo", "BAD1", 100_000, { venues: [] }),
      row(9, "ondo", "BAD2", 100_000, { openState: false }),
      row(10, "ondo", "BAD3", 100_000, { reasonCode: "UNSUPPORTED" }),
      row(11, "ondo", "THIN", 9_999),
    ];
    const all = [bNvda, oNvda, oEemWeak, oEemDeep, oNullOne, oNullTwo, bAapl, ...invalid];
    const reads: TradeDataPlaneReads = {
      async universe(lane) { return lane === "bstocks" ? [bNvda, bAapl] : lane === "ondo" ? [oNvda, oEemWeak, oEemDeep, oNullOne, oNullTwo, ...invalid] : []; },
      async tokensBatch(addresses) { return addresses.map((address) => {
        const symbol = all.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase())?.symbol;
        return { address, ...(symbol === undefined ? {} : { symbol }), priceUsd: 100, marketCapUsd: null,
          volume24hUsd: 1, holders: 1, priceChange24hPct: 0 };
      }); },
      async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "binance_rwa", source: "binance-rwa" as const, venue: null })); },
      async security() { return { riskLevel: "ok", flags: [] }; },
    };
    const pinned = await pinUniverse("tradfi", { dataPlane: reads });
    assert.deepEqual(pinned.map((candidate) => candidate.address), [bAapl.address, oEemDeep.address, oNullTwo.address, oNullOne.address, bNvda.address]);
    assert.equal(pinned.some((candidate) => candidate.address === oNvda.address), false);
    assert.equal(pinned.length, 5);
  });

  it("keeps the wrapper exception lane-bound and applies the RWA guard before token/eligibility reads", async () => {
    const wrapper = getAddress("0xa9eE28C80f960B889dFbd1902055218cBa016F75");
    assert.equal(isEntryExcludedToken(wrapper, "NVDAon"), true);
    assert.equal(isEntryExcludedToken(wrapper, "NVDAon", "ondo"), false);
    assert.deepEqual(lanesFor("tradfi"), ["bstocks", "ondo"]);
    assert.equal(inModelBand("tradfi", { address: wrapper, symbol: "NVDAon", lane: "ondo", source: "fixture" }, {
      address: wrapper, priceUsd: 1, marketCapUsd: null, volume24hUsd: null, holders: null, priceChange24hPct: null,
    }), true);
    assert.equal(rwaMarketClosed({ marketStatus: "overnight" } as RwaFact, nowMs), true);

    const candidate: PinnedCandidate = { address: wrapper, symbol: "NVDAon", lane: "ondo", marketCapUsd: null,
      priceUsd: null, volume24hUsd: null, priceChange24hPct: null, holders: null };
    let reads = 0;
    const result = await selectEntryCandidates({
      model: "tradfi", settings: { minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false },
      candidates: [candidate], pinnedAddresses: new Set([wrapper.toLowerCase()]), previouslyEnteredAddresses: new Set(),
      openPositionAddresses: new Set(), forbiddenAddresses: new Set(), rwaAddresses: new Set([wrapper.toLowerCase()]),
      rwaFacts: new Map([[wrapper.toLowerCase(), {
        platform: "ondo", underlyingTicker: "NVDA", tokenPriceUsd: 100, referencePriceUsd: 100, premiumBps: 151,
        openState: true, marketStatus: null, reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1,
        onchainPriceUsd: 101.51, venues: [{ dex: "uniswap", version: "v3", pool: getAddress("0x9999999999999999999999999999999999999999"),
          feeTier: 500, quote: USDT, quoteSymbol: "USDT", priceUsd: 101.51, liquidityUsd: 10_000, volume24hUsd: 1, asOf: nowMs }],
      } satisfies RwaFact]]),
      nowMs,
      dataPlane: {
        async tokensBatch() { reads += 1; return []; },
        async eligibilityBatch() { reads += 1; return []; },
        async security() { reads += 1; return null; },
      },
    });
    assert.equal(result.kind, "selected");
    assert.deepEqual(result.refusals, [{ address: wrapper, reason: "premium-too-high" }]);
    assert.equal(reads, 0);
  });

  function tokenReads(all: readonly UniverseRow[]): TradeDataPlaneReads {
    return {
      async universe(lane) { return lane === "bstocks" ? all.filter((r) => r.lane === "bstocks") : lane === "ondo" ? all.filter((r) => r.lane === "ondo") : []; },
      async tokensBatch(addresses) { return addresses.map((address) => {
        const symbol = all.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase())?.symbol;
        return { address, ...(symbol === undefined ? {} : { symbol }), priceUsd: 100, marketCapUsd: null,
          volume24hUsd: 1, holders: 1, priceChange24hPct: 0 };
      }); },
      async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "binance_rwa", source: "binance-rwa" as const, venue: null })); },
      async security() { return { riskLevel: "ok", flags: [] }; },
    };
  }

  it("G2: a schedule-mode pin (lanes: ['bstocks']) never contains an Ondo row; AI mode still reads both lanes", async () => {
    const bstocks = Array.from({ length: 5 }, (_, i) => row(i + 1, "bstocks", `B${i}`, 100_000));
    const ondo = Array.from({ length: 3 }, (_, i) => row(i + 51, "ondo", `O${i}`, 100_000));
    const reads = tokenReads([...bstocks, ...ondo]);

    const aiPin = await pinUniverse("tradfi", { dataPlane: reads });
    assert.ok(aiPin.some((candidate) => candidate.lane === "ondo"), "AI mode must still read both lanes");

    const schedulePin = await pinUniverse("tradfi", { dataPlane: reads }, { lanes: ["bstocks"] });
    assert.equal(schedulePin.some((candidate) => candidate.lane === "ondo"), false, "schedule mode must never admit an Ondo row");
    assert.equal(schedulePin.length, 5);
  });

  it("G3: with more than 28 priced candidates, a pool-less bStock that passes the probe reaches the uncut schedule-mode pin; the default (slice-28) pin never probes it", async () => {
    const priced = Array.from({ length: 29 }, (_, i) => row(i + 1, "bstocks", `T${i}`, 100_000 - i));
    const poolLess = row(9_000, "bstocks", "POOLLESS", 0, { venues: [] });
    const reads = tokenReads([...priced, poolLess]);
    // The probe stands in for the full production wrapper: an admitted-venue
    // candidate is always capable without a call (G5), and only the one
    // pool-less candidate here clears the (stand-in) Flash check.
    const probe = async (candidate: PinnedCandidate): Promise<boolean> =>
      (candidate.venues?.length ?? 0) > 0 || candidate.address.toLowerCase() === poolLess.address.toLowerCase();

    const defaultPin = await pinUniverse("tradfi", { dataPlane: reads, tradfiV2CapabilityProbe: probe });
    assert.equal(defaultPin.some((candidate) => candidate.address.toLowerCase() === poolLess.address.toLowerCase()), false,
      "without probeAll, a pool-less candidate sorted past position 28 is never probed");

    const schedulePin = await pinUniverse("tradfi", { dataPlane: reads, tradfiV2CapabilityProbe: probe }, { probeAll: true });
    assert.ok(schedulePin.some((candidate) => candidate.address.toLowerCase() === poolLess.address.toLowerCase()),
      "probeAll must reach and admit a passing pool-less candidate sorted past position 28");
    assert.ok(schedulePin.length > 28, "the schedule pin must not be cut to 28 (G3)");
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

  it("parses RWA facts and venues strictly while dropping unknown venue identities", async () => {
    const row = {
      address: "0x0000000000000000000000000000000000000011", symbol: "NVDAB", lane: "bstocks", source: "rwa",
      platform: "bstock", underlyingTicker: "NVDA", tokenPriceUsd: 100, referencePriceUsd: 100,
      premiumBps: 900, openState: true, marketStatus: "regular", reasonCode: "TRADING", tokenToShareRatio: 1,
      staleness: "fresh", venues: [
        { dex: "uniswap", version: "v9", pool: "0x0000000000000000000000000000000000000012" },
        { dex: "uniswap", version: "v3", pool: "0x0000000000000000000000000000000000000013", feeTier: 500,
          quote: { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT" },
          priceUsd: 100, liquidityUsd: 10_000, volume24hUsd: 1, asOf: 1_900_000_000_000 },
      ],
    };
    const client = new HttpTradeDataPlaneReads({ baseUrl: "https://data.example/", fetch: async () => Response.json({ data: [row, {
      address: "0x0000000000000000000000000000000000000014", symbol: "PLAIN", lane: "bstocks", source: "static",
    }] }) });
    const rows = await client.universe("bstocks");
    assert.equal(rows?.[0]?.rwa?.onchainPriceUsd, 100);
    assert.equal(rows?.[0]?.venues?.length, 1);
    assert.equal(Object.hasOwn(rows?.[1] ?? {}, "rwa"), false);

    const malformed = new HttpTradeDataPlaneReads({ baseUrl: "https://data.example/", fetch: async () => Response.json({ data: [{
      ...row, platform: 7,
    }] }) });
    await assert.rejects(malformed.universe("bstocks"), /malformed universe/u);
  });
});

describe("R2.3 (H2) scheduleGrantList", () => {
  function candidate(index: number): PinnedCandidate {
    return { address: getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`), symbol: `T${index}`,
      lane: "bstocks", marketCapUsd: null, priceUsd: null, volume24hUsd: null, priceChange24hPct: null, holders: null };
  }

  it("puts the chosen candidate first, drops its duplicate from the pin, and cuts to the tradfi cap", () => {
    const pinned = Array.from({ length: 40 }, (_, i) => candidate(i));
    const chosen = pinned[35]!; // sorted well past position 28
    const grantList = scheduleGrantList(pinned, chosen);
    assert.equal(grantList.length, 28, "must cut to maxGrantedTokens('tradfi')");
    assert.equal(grantList[0], chosen, "the chosen token must always be first");
    assert.equal(grantList.filter((c) => c.address === chosen.address).length, 1, "no duplicate of the chosen token");
  });

  it("keeps a short pin intact, chosen first", () => {
    const pinned = Array.from({ length: 5 }, (_, i) => candidate(i));
    const chosen = pinned[2]!;
    const grantList = scheduleGrantList(pinned, chosen);
    assert.equal(grantList.length, 5);
    assert.equal(grantList[0], chosen);
    assert.deepEqual(grantList.slice(1).map((c) => c.address), pinned.filter((c) => c !== chosen).map((c) => c.address));
  });
});
