import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USDT_56, WBNB_56 } from "./pairs";
import { emptyRungPairs, liveRungValueWei, mapAgentDetail, ohlcvLimit, ohlcvRequestPath, reduceOhlcv, rungFillTick, rungHoldsWbnb, shiftFills } from "./agent-detail";
import { priceAtTick as priceAtTickRef } from "./pairs";

const NOW = 2_000_000_000_000;
const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";
const NOTE = "Derived telemetry: a row can be lost if the post-confirm write fails; counts are a lower bound.";
const TX = `0x${"ab".repeat(32)}`;

function owner(overrides: Record<string, unknown> = {}) {
  return { data: {
    id: "grid-live-1",
    walletAddress: "0x1111111111111111111111111111111111111111",
    status: "armed",
    session: {
      publicKey: `0x04${"11".repeat(64)}`,
      expiresAt: Math.floor(NOW / 1_000) + 600,
      spendCaps: [{ limit: "1000000000000000000", period: "day" }],
    },
    ...overrides,
  } };
}

function position(overrides: Record<string, unknown> = {}) {
  return {
    positionId: "p1",
    token0: USDT_56,
    token1: WBNB_56,
    tokenId: "7263905",
    quoteToken: WBNB_56,
    basisWei: "1000000000000000000",
    basisSource: "imported",
    state: "open",
    rowVersion: 7,
    createdAt: NOW - 180_000,
    observation: {
      blockNumber: "123",
      evaluatedAtMs: NOW - 30_000,
      currentTick: -65_532,
      poolAddress: POOL,
      valuation: {
        method: "sellable-exit-v1",
        exitValueWei: "1100000000000000000",
        quoteToken: WBNB_56,
        tokenId: "7263905",
        positionRowVersion: 7,
        blockNumber: "123",
        valuedAtMs: NOW - 31_000,
      },
    },
    ...overrides,
  };
}

function sequence(overrides: Record<string, unknown> = {}) {
  return {
    sequenceId: "s1",
    positionId: "p1",
    kind: "grid-flip",
    state: "completed",
    recoveryState: "none",
    recenterEvidence: null,
    note: null,
    steps: [{ kind: "zap-in-mint", unreadable: false, txHash: TX }],
    createdAt: NOW - 60_000,
    updatedAt: NOW - 50_000,
    ...overrides,
  };
}

function lp(overrides: Record<string, unknown> = {}) {
  return { data: {
    positions: [position()],
    sequences: [sequence()],
    grid: {
      pool: { token0: USDT_56, token1: WBNB_56, fee: 100 },
      poolAddress: POOL,
      wbnbIsToken0: false,
      tickSpacing: 1,
      buyRange: { tickLower: -65_560, tickUpper: -65_545 },
      sellRange: { tickLower: -65_533, tickUpper: -65_532 },
      levels: [{
        positionId: "p1",
        gridRole: "buy",
        observedTick: -65_532,
        observationAgeMs: 30_000,
        pnl: { realisedQuoteWei: "-10000000000000000", overRoundTrips: 1, recordedCycles: 2 },
      }],
      cycles: {
        available: true,
        recorded: 1,
        roundTrips: 0,
        rows: [{
          sequenceId: "s1",
          positionId: "p1",
          direction: "to-sell",
          from: { tickLower: -65_533, tickUpper: -65_532 },
          to: { tickLower: -65_560, tickUpper: -65_545 },
          freed0Wei: ((2n ** 53n) + 1n).toString(10),
          freed1Wei: "1000000000000000000",
          minted0Wei: "0",
          minted1Wei: "1",
          residueWei: "0",
          residueBps: "0",
          fromTokenId: "1",
          toTokenId: "2",
          completedAtMs: NOW - 50_000,
        }],
        note: NOTE,
      },
    },
    ...overrides,
  } };
}

describe("strict agent-detail mapper", () => {
  it("carries optional identity through grid, unarmed, trade and LP owner mappings without gating controls", () => {
    const identity = { version: 1, publicRef: "bc3f7b92-4c65-4acf-aef4-338b084f7a13", revision: 1, category: "grid", status: "pending", agentId: null, registrationTxHash: null, uriUpdateTxHash: null, errorCode: null };
    for (const name of ["grid-v1", "grid-shift-v1", "trade-v1", "lp-v1"]) {
      for (const payload of [lp(), { data: { positions: [], sequences: [] } }]) {
        const base = { hireSizing: { name } };
        const legacy = mapAgentDetail(owner(base), payload, NOW);
        expect(legacy).not.toHaveProperty("erc8004Identity");
        expect(mapAgentDetail(owner({ ...base, erc8004Identity: identity }), payload, NOW).erc8004Identity).toEqual(identity);
        const malformed = mapAgentDetail(owner({ ...base, erc8004Identity: { status: "registered", agentId: "7" } }), payload, NOW);
        expect(malformed.erc8004Identity).toEqual({ status: "blocked", errorCode: "invalid_identity" });
        expect(malformed.status).toBe(legacy.status);
        expect(malformed.actionDisabledReason).toBe(legacy.actionDisabledReason);
      }
    }
  });
  it("renders a session-armed agent whose grid is not armed yet (live owner view, LP view without a grid block)", () => {
    const liveOwner = JSON.parse(readFileSync(new URL("../../../test/fixtures/marketplace-agent-detail/live-hire-grid-agent-01.owner.json", import.meta.url), "utf8")) as unknown;
    const noGrid = { data: { positions: [], sequences: [], quota: null, priceTriggers: [], settingsDigest: "0x" }, meta: { positions: 0, sequences: 0 } };
    const view = mapAgentDetail(liveOwner, noGrid, NOW);
    expect(view.status).toBe("armed");
    expect(view.grid.pool).toBeNull();
    expect(view.recordedCycleDelta.reason).toBe("— grid not armed yet");
    expect(view.recordedCycles.reason).toBe("— grid not armed yet");
    expect(view.grid.rangeUnavailableBecause).toBe("— grid not armed yet");
    expect(view.dailyNativeLimit.value).not.toBeNull();
    expect(view.cycleHistoryAvailable).toBe(false);
  });
  it("maps exact-id, native limit, negative delta, motions, valuation and NFT provenance", () => {
    const view = mapAgentDetail(owner(), lp(), NOW, {
      data: { address: WBNB_56, priceUsd: 700 },
      meta: { source: "fixture", asOf: NOW, staleness: "fresh" },
    });
    expect(view.id).toBe("grid-live-1");
    expect(view.dailyNativeLimit.value).toBe("1 BNB · $700.00");
    expect(view.dailyNativeLimit.note).toContain("period: day");
    expect(view.recordedCycleDelta.value).toBe("-0.01 WBNB");
    expect(view.recordedCycleDelta.note).toBe(NOTE);
    expect(view.recordedCycles.value).toBe("1 recorded · 1 round trips");
    expect(view.motions[0]).toMatchObject({
      classification: "settlement",
      label: "Buy rung filled",
      txHash: TX,
    });
    expect(view.motions[0]?.collected).toContain("USDT");
    expect(view.motions[0]?.collected).toContain("WBNB");
    expect(view.motions[0]?.price.value).toMatch(/ USDT\/BNB$/u);
    expect(view.positions[0]?.value.value).toBe("1.1 WBNB");
    expect(view.positions[0]?.unrealised.value).toBe("0.1 WBNB");
    expect(view.positions[0]?.fees.reason).toBe("— fees are counted in unrealised");
    expect(view.positions[0]?.nftUrl).toContain("/nft/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364/7263905");
    expect(view.grid.observationStale).toBe(false);
  });

  it("fails valuation closed on token rotation and same-token version change", () => {
    for (const changed of [
      position({ tokenId: "7263906" }),
      position({ rowVersion: 8 }),
      position({ quoteToken: "0x2222222222222222222222222222222222222222" }),
    ]) {
      const view = mapAgentDetail(owner(), lp({ positions: [changed] }), NOW);
      expect(view.positions[0]?.value.reason).toBe("— valuation is for a prior position version");
      expect(view.positions[0]?.unrealised.value).toBeNull();
    }
  });

  it("dashes agent-wide metrics for two lineages even when legacy cycles claim a round trip", () => {
    const grid = (lp().data.grid as Record<string, unknown>);
    const first = (grid.levels as Record<string, unknown>[])[0]!;
    const firstCycle = ((grid.cycles as Record<string, unknown>).rows as Record<string, unknown>[])[0]!;
    const view = mapAgentDetail(owner(), lp({ grid: {
      ...grid,
      levels: [
        { ...first, positionId: "p1", pnl: { realisedQuoteWei: null, overRoundTrips: 0, recordedCycles: 1 } },
        { ...first, positionId: "p2", pnl: { realisedQuoteWei: null, overRoundTrips: 0, recordedCycles: 1 } },
      ],
      cycles: {
        ...(grid.cycles as Record<string, unknown>),
        recorded: 2,
        roundTrips: 1,
        rows: [
          { ...firstCycle, positionId: "p1", direction: "to-buy" },
          { ...firstCycle, positionId: "p2", direction: "to-buy", sequenceId: "s2" },
        ],
      },
    }, sequences: [sequence(), sequence({ sequenceId: "s2" })] }), NOW);
    expect(view.recordedCycleDelta.reason).toBe("— no agent-wide total; see level rows");
    expect(view.recordedCycles.reason).toBe("— no agent-wide total; see level rows");
    expect(view.levels.map((level) => level.roundTrips)).toEqual([0, 0]);
    expect(view.motions.map((motion) => motion.label)).toEqual(["Sell rung filled", "Sell rung filled"]);
  });

  it("does not call a zero delta comparable before one complete round trip", () => {
    const grid = lp().data.grid as Record<string, unknown>;
    const first = (grid.levels as Record<string, unknown>[])[0]!;
    const before = mapAgentDetail(owner(), lp({ grid: { ...grid, levels: [{ ...first, pnl: { realisedQuoteWei: "0", overRoundTrips: 0, recordedCycles: 1 } }] } }), NOW);
    expect(before.recordedCycleDelta.reason).toBe("— no comparable round trip yet");
    const after = mapAgentDetail(owner(), lp({ grid: { ...grid, levels: [{ ...first, pnl: { realisedQuoteWei: "0", overRoundTrips: 1, recordedCycles: 2 } }] } }), NOW);
    expect(after.recordedCycleDelta.value).toBe("0 WBNB");
  });

  it("distinguishes drift, unreadable outcomes, unavailable cycles, and provisioning", () => {
    const grid = lp().data.grid as Record<string, unknown>;
    const driftSequence = sequence({ kind: "grid-recenter", recenterEvidence: "drift", steps: [{ kind: "zap-in-mint", unreadable: true, txHash: null }] });
    const view = mapAgentDetail(owner({ status: "provisioning" }), lp({
      sequences: [driftSequence],
      grid: { ...grid, cycles: { ...(grid.cycles as Record<string, unknown>), available: false, rows: [] } },
    }), NOW);
    expect(view.provisioning).toBe(true);
    expect(view.actionDisabledReason).toContain("still being hired");
    expect(view.recordedCycles.reason).toBe("— cycle history unavailable");
    expect(view.sequences[0]?.outcomeUnavailable).toBe(true);
    expect(view.motions).toEqual([]);

    const drift = mapAgentDetail(owner(), lp({ sequences: [driftSequence] }), NOW);
    expect(drift.motions[0]?.classification).toBe("drift");
    expect(drift.motions[0]?.label).toBe("Rung re-centred (drift)");
  });

  it("keeps a CLI armGroup-null row, null observation, and stale observation honest", () => {
    const grid = lp().data.grid as Record<string, unknown>;
    const noObservation = mapAgentDetail(owner(), lp({
      positions: [position({ armGroupId: null, observation: null })],
      sequences: [sequence({ steps: [{ kind: "zap-in-mint", submitted: true, unreadable: false, txHash: null }] })],
      grid: { ...grid, cycles: { ...(grid.cycles as Record<string, unknown>), recorded: 0, rows: [] } },
    }), NOW);
    expect(noObservation.armMs).toBe(NOW - 180_000);
    expect(noObservation.positions[0]?.value.reason).toBe("— not valued yet");
    expect(noObservation.sequences[0]?.txHashes).toEqual([]);
    const first = (grid.levels as Record<string, unknown>[])[0]!;
    const stale = mapAgentDetail(owner(), lp({ grid: { ...grid, levels: [{ ...first, observationAgeMs: 120_001 }] } }), NOW);
    expect(stale.grid.observationStale).toBe(true);
  });

  it("labels a day ceiling expired at the exact epoch-second boundary and dashes ambiguous native caps", () => {
    const atExpiry = mapAgentDetail(owner({ session: {
      publicKey: "0x04",
      expiresAt: Math.floor(NOW / 1_000),
      spendCaps: [{ limit: "1", period: "day" }],
    } }), lp(), NOW);
    expect(atExpiry.dailyNativeLimit.note).toContain("recorded expired ceiling");
    for (const spendCaps of [[], [{ limit: "0", period: "day" }], [{ limit: "1", period: "day" }, { limit: "2", period: "day" }]]) {
      const result = mapAgentDetail(owner({ session: { publicKey: "0x04", expiresAt: Math.floor(NOW / 1_000) + 10, spendCaps } }), lp(), NOW);
      expect(result.dailyNativeLimit.reason).toBe("— no native session cap on record");
    }
  });

  it("dashes unknown-decimals pairs and expired/non-day native ceilings", () => {
    const grid = lp().data.grid as Record<string, unknown>;
    const unknown = "0x2222222222222222222222222222222222222222";
    const view = mapAgentDetail(owner({ session: {
      publicKey: "0x04",
      expiresAt: Math.floor(NOW / 1_000) - 1,
      spendCaps: [{ limit: "1", period: "week" }],
    } }), lp({
      positions: [position({ token0: unknown })],
      grid: { ...grid, pool: { token0: unknown, token1: WBNB_56, fee: 100 } },
    }), NOW);
    expect(view.dailyNativeLimit.reason).toBe("— no native session cap on record");
    expect(view.motions[0]?.collected).toBe("— token decimals unavailable");
    expect(view.motions[0]?.price.reason).toBe("— token decimals unavailable");
  });

  it("omits USD unless the exact WBNB snapshot carries fresh provenance", () => {
    for (const snapshot of [
      { data: { address: WBNB_56, priceUsd: 700 }, meta: { source: "fixture", asOf: NOW, staleness: "stale" } },
      { data: { address: WBNB_56, priceUsd: 700 }, meta: { asOf: NOW, staleness: "fresh" } },
      { data: { address: WBNB_56, priceUsd: 700 }, meta: { source: "fixture", staleness: "fresh" } },
      { data: { address: USDT_56, priceUsd: 1 }, meta: { source: "fixture", asOf: NOW, staleness: "fresh" } },
    ]) {
      expect(mapAgentDetail(owner(), lp(), NOW, snapshot).dailyNativeLimit.value).toBe("1 BNB");
    }
  });
});

describe("OHLCV request and HODL reducer", () => {
  function response(base = WBNB_56, quote = USDT_56, staleness = "fresh") {
    return {
      data: [
        { timestamp: NOW - 60_000, open: 700, high: 711, low: 699, close: 705, volume: 1 },
        { timestamp: NOW, open: 705, high: 721, low: 704, close: 720, volume: 2 },
      ],
      meta: { source: "fixture", asOf: NOW, staleness, base: { address: base }, quote: { address: quote } },
    };
  }

  it("uses the exact BFF query and integral capped limit", () => {
    expect(ohlcvLimit(NOW - 120_001, NOW)).toBe(8);
    expect(ohlcvLimit(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe(500);
    expect(ohlcvRequestPath(POOL, NOW - 120_001, NOW)).toBe(
      `/api/market-data/ohlcv?kind=pool&address=${POOL}&interval=1m&limit=8`,
    );
  });

  it("computes WBNB spot return from the same fresh series", () => {
    const result = reduceOhlcv(response(), NOW - 60_000, NOW);
    expect(result.priceNow).toBe(720);
    expect(result.hodl.value).toBe("2.13%");
    expect(result.hodl.note).toContain("if you had held BNB instead");
  });

  it("dashes when the first candle after arm is 61 seconds late", () => {
    const result = reduceOhlcv(response(), NOW - 121_000, NOW);
    expect(result.hodl.reason).toBe("— no candle at arm time");
  });

  it("accepts the first candle after arm when it is exactly 59 seconds late", () => {
    const result = reduceOhlcv(response(), NOW - 119_000, NOW);
    expect(result.hodl.value).toBe("2.13%");
    expect(result.hodl.reason).toBeNull();
  });

  // MEASURED against the data plane: the pool OHLCV feed prices `meta.base` in
  // USD (BTCB/WBNB closes near 77,100, not near 112), so there is no ratio to
  // invert. A series that prices the OTHER leg is refused instead of drawn.
  it("keeps the feed's own USD series and refuses one that prices the other leg", () => {
    const asIs = reduceOhlcv(response(USDT_56, WBNB_56), NOW - 60_000, NOW);
    expect(asIs.candles[0]).toMatchObject({ open: 700, high: 711, low: 699, close: 705 });
    const otherLeg = reduceOhlcv(response(USDT_56, WBNB_56), NOW - 60_000, NOW, { base: WBNB_56, quote: USDT_56, baseSymbol: "WBNB" });
    expect(otherLeg.candles).toEqual([]);
    expect(otherLeg.banner).toBe("chart prices the other leg, not WBNB");
  });

  it("accepts any reviewed pool the agent actually trades", () => {
    const BTCB = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
    const btcb = reduceOhlcv(response(BTCB, WBNB_56), NOW - 60_000, NOW, { base: BTCB, quote: WBNB_56, baseSymbol: "BTCB" });
    expect(btcb.candles).toHaveLength(2);
    expect(btcb.banner).toBeNull();
  });

  it("sorts candles before selecting the arm and latest points", () => {
    const payload = response();
    payload.data.reverse();
    const result = reduceOhlcv(payload, NOW - 60_000, NOW);
    expect(result.candles.map((candle) => candle.timestamp)).toEqual([NOW - 60_000, NOW]);
    expect(result.priceNow).toBe(720);
  });

  it("dashes for wrong/missing pair, old window, stale metadata, and old latest candle", () => {
    expect(reduceOhlcv(response(WBNB_56, "0x2222222222222222222222222222222222222222"), NOW - 60_000, NOW).hodl.reason).toBe("— pair mismatch");
    expect(reduceOhlcv(response(), NOW - 2 * 24 * 60 * 60_000, NOW).hodl.reason).toBe("— no candle at arm time");
    expect(reduceOhlcv(response(WBNB_56, USDT_56, "stale"), NOW - 60_000, NOW).hodl.reason).toBe("— chart data is stale");
    expect(reduceOhlcv(response(WBNB_56, USDT_56, "dead"), NOW - 60_000, NOW).hodl.reason).toBe("— chart data is stale");
    expect(reduceOhlcv(response(), NOW - 60_000, NOW + 121_000).hodl.reason).toBe("— chart data is stale");
    expect(() => reduceOhlcv({ ...response(), meta: { source: "fixture", asOf: NOW, base: { address: WBNB_56 }, quote: { address: USDT_56 } } }, NOW - 60_000, NOW)).toThrow(/staleness/u);
  });
});

describe("GRID-GAS-RESERVE W2: the gas block", () => {
  it("reads the shift buffer's native pot against the next shift's relay gas", () => {
    const view = mapAgentDetail(owner(), lp({ grid: { ...lp().data.grid, buffer: { quoteWei: "1", baseWei: "2", bookBaseWei: null, bookCostWbnbWei: null, nativeWei: "98693148720024", nextShiftGasWei: "155200000000000" } } }), NOW);
    expect(view.gas).toEqual({ nativeWei: "98693148720024", nextShiftWei: "155200000000000", low: true });
    const funded = mapAgentDetail(owner(), lp({ grid: { ...lp().data.grid, buffer: { quoteWei: "1", baseWei: "2", bookBaseWei: null, bookCostWbnbWei: null, nativeWei: "155200000000000", nextShiftGasWei: "155200000000000" } } }), NOW);
    expect(funded.gas?.low).toBe(false);
  });
  it("is null when the plane reports no gas figures — a dash, never a zero", () => {
    expect(mapAgentDetail(owner(), lp(), NOW).gas).toBeNull();
    const half = mapAgentDetail(owner(), lp({ grid: { ...lp().data.grid, buffer: { quoteWei: "1", baseWei: "2", bookBaseWei: null, bookCostWbnbWei: null, nativeWei: "5" } } }), NOW);
    expect(half.gas).toBeNull();
  });
});

describe("live tick (HANDOFF 2026-09-04 owed item a)", () => {
  it("a fresh live tick becomes the current tick, priced, and is labelled live", () => {
    const view = mapAgentDetail(owner(), lp(), NOW, undefined, undefined, { tick: -65_540, blockNumber: "200", readAtMs: NOW - 5_000 });
    expect(view.grid.observedTick).toBe(-65_540);
    expect(view.grid.tickSource).toBe("live");
    expect(view.grid.observationAgeMs).toBe(5_000);
    expect(view.grid.observationStale).toBe(false);
    expect(view.grid.observedPrice).not.toBeNull();
  });
  it("a stale live tick (> 60 s) yields to the worker's observation; none at all is null", () => {
    const view = mapAgentDetail(owner(), lp(), NOW, undefined, undefined, { tick: -65_540, blockNumber: "200", readAtMs: NOW - 61_000 });
    expect(view.grid.observedTick).toBe(-65_532);
    expect(view.grid.tickSource).toBe("worker");
    expect(mapAgentDetail(owner(), lp(), NOW).grid.tickSource).toBe("worker");
  });
});

describe("liveRungValueWei", () => {
  it("sums the WBNB leg with the base leg priced at the tick, in both pool orders", () => {
    // tick 0: price 1, so a base leg counts 1:1.
    expect(liveRungValueWei({ amount0: 5n, amount1: 7n, tick: 0, wbnbIsToken0: false })).toBe(12n);
    expect(liveRungValueWei({ amount0: 5n, amount1: 7n, tick: 0, wbnbIsToken0: true })).toBe(12n);
    // A one-sided WBNB rung is its WBNB leg exactly, whatever the tick.
    expect(liveRungValueWei({ amount0: 0n, amount1: 9_404_000_000_000_000n, tick: -100_909, wbnbIsToken0: false })).toBe(9_404_000_000_000_000n);
  });
});

describe("shiftFills", () => {
  const seq = (id: string, createdAt: number, buyLower: number) => ({
    sequenceId: id, positionId: "p1", kind: "grid-shift", state: "completed", recoveryState: "none", note: null, outcomeUnavailable: false,
    txHashes: [TX], steps: [], updatedAt: createdAt, createdAt, shiftCause: "cross",
    targetBuyRange: { tickLower: buyLower, tickUpper: buyLower + 50 }, targetSellRange: { tickLower: buyLower + 300, tickUpper: buyLower + 350 },
  });
  const pair = { chainId: 56 as const, token0: "0x5c85d6c6825ab4032337f11ee92a72df936b46f6", token1: WBNB_56, symbol0: "mubarak", symbol1: "WBNB", decimals0: 18, decimals1: 18, wbnbIsToken0: false };
  // mubarak/WBNB 2026-09-04: the arm's pair 7324342 (sell) / 7324343 (buy) was
  // emptied by the first cross; the plane's rows now point at 7324466/7324467.
  const empties = [
    { tokenId: 7324342n, tickLower: -100_500, tickUpper: -100_450 },
    { tokenId: 7324343n, tickLower: -100_800, tickUpper: -100_750 },
  ];
  it("emptyRungPairs pairs consecutive tokenIds newest-first and names sell/buy by ticks", () => {
    const pairs = emptyRungPairs([...empties, { tokenId: 7324466n, tickLower: -100_700, tickUpper: -100_650 }, { tokenId: 7324467n, tickLower: -101_000, tickUpper: -100_950 }], false);
    expect(pairs).toEqual([
      { buy: { tickLower: -101_000, tickUpper: -100_950 }, sell: { tickLower: -100_700, tickUpper: -100_650 } },
      { buy: { tickLower: -100_800, tickUpper: -100_750 }, sell: { tickLower: -100_500, tickUpper: -100_450 } },
    ]);
    expect(emptyRungPairs(empties, true)[0]).toEqual({ buy: { tickLower: -100_500, tickUpper: -100_450 }, sell: { tickLower: -100_800, tickUpper: -100_750 } });
    expect(emptyRungPairs([empties[0]!], false)).toHaveLength(0);
  });
  it("the live cross: pair moved DOWN ⇒ BID BUY at the old buy rung's lower edge", () => {
    const fills = shiftFills({ sequences: [seq("s1", 10, -101_000)], priorPairs: emptyRungPairs(empties, false), wbnbIsToken0: false, pair });
    expect(fills).toHaveLength(1);
    expect(fills[0]?.side).toBe("buy");
    expect(fills[0]?.price).toBe(priceAtTickRef(-100_800, pair));
    expect(fills[0]?.txHash).toBe(TX);
  });
  it("pair moved UP ⇒ ASK SELL at the old sell rung's upper edge; WBNB-as-token0 inverts", () => {
    const up = shiftFills({ sequences: [seq("s1", 10, -100_600)], priorPairs: emptyRungPairs(empties, false), wbnbIsToken0: false, pair });
    expect(up[0]?.side).toBe("sell");
    expect(up[0]?.price).toBe(priceAtTickRef(-100_450, pair));
    const inverted = shiftFills({ sequences: [seq("s1", 10, -100_400)], priorPairs: emptyRungPairs(empties, true), wbnbIsToken0: true, pair: { ...pair, wbnbIsToken0: true } });
    expect(inverted[0]?.side).toBe("buy");
  });
  it("two crosses pair with the two most recent emptied pairs, newest first", () => {
    const twoPairs = emptyRungPairs([...empties, { tokenId: 7324466n, tickLower: -100_700, tickUpper: -100_650 }, { tokenId: 7324467n, tickLower: -101_000, tickUpper: -100_950 }], false);
    const fills = shiftFills({ sequences: [seq("first", 10, -101_000), seq("second", 20, -100_700)], priorPairs: twoPairs, wbnbIsToken0: false, pair });
    expect(fills.map((fill) => [fill.sequenceId, fill.side])).toEqual([["second", "sell"], ["first", "buy"]]);
  });
  it("skips a cross with no visible prior pair, and ignores non-cross sequences", () => {
    expect(shiftFills({ sequences: [seq("s1", 10, -101_000)], priorPairs: [], wbnbIsToken0: false, pair })).toHaveLength(0);
    expect(shiftFills({ sequences: [{ ...seq("s1", 10, -101_000), shiftCause: "drift" }], priorPairs: emptyRungPairs(empties, false), wbnbIsToken0: false, pair })).toHaveLength(0);
  });
});


describe("rungHoldsWbnb / rungFillTick", () => {
  it("outside the range the side is positional; inside it the larger leg decides (the 2026-09-04 ask-read-as-bid case)", () => {
    const ask = { tickLower: -100_900, tickUpper: -100_850, amount0: 10n ** 18n, amount1: 0n };
    expect(rungHoldsWbnb({ ...ask, tick: -100_947, wbnbIsToken0: false })).toBe(false);
    // Tick inside: the position holds mostly base still ⇒ still an ask.
    expect(rungHoldsWbnb({ ...ask, amount1: 1n, tick: -100_880, wbnbIsToken0: false })).toBe(false);
    // Tick above the whole range: it has been taken and holds WBNB.
    expect(rungHoldsWbnb({ ...ask, amount0: 0n, amount1: 5n, tick: -100_800, wbnbIsToken0: false })).toBe(true);
    expect(rungFillTick({ tickLower: -100_900, tickUpper: -100_850, holdsWbnb: false, wbnbIsToken0: false })).toBe(-100_850);
    expect(rungFillTick({ tickLower: -100_900, tickUpper: -100_850, holdsWbnb: true, wbnbIsToken0: false })).toBe(-100_900);
    expect(rungFillTick({ tickLower: -100_900, tickUpper: -100_850, holdsWbnb: false, wbnbIsToken0: true })).toBe(-100_900);
  });
});
