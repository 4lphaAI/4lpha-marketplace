/**
 * LP-DEPLOY liquidity chart — `createLpChainReaders().tickLiquidity`.
 *
 * Offline, against a scripted viem `custom` transport that decodes the
 * `tickBitmap(int16)` / `ticks(int24)` ARGUMENTS (one selector, many answers),
 * and proves:
 *   - every read is pinned to the finalized block;
 *   - the profile is the active liquidity in the current bin, `+liquidityNet`
 *     crossing each initialized tick upward, `-liquidityNet` downward;
 *   - only initialized ticks are read, and only those inside the window;
 *   - the window clamps and the initialized-tick budget truncates honestly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  toFunctionSelector,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import {
  createLpChainReaders,
  MAX_LIQUIDITY_INITIALIZED_TICKS,
  MAX_LIQUIDITY_WINDOW_BINS,
} from "../src/lp/readers.js";

const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const FACTORY = getAddress("0xBBbBBBbbbBBbbbBbbBbbbbBBbBBbBbBbBbBBbBB1");
const QUOTER = getAddress("0xBBBbBbbBbbBBBbBbbbbBbBBbbBBBbbbBbBBbbBB2");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const FINALIZED = 4_242n;

const SEL = {
  slot0: toFunctionSelector("slot0()"),
  liquidity: toFunctionSelector("liquidity()"),
  tickSpacing: toFunctionSelector("tickSpacing()"),
  tickBitmap: toFunctionSelector("tickBitmap(int16)"),
  ticks: toFunctionSelector("ticks(int24)"),
} as const;

type Scenario = {
  readonly currentTick: number;
  readonly spacing: number;
  readonly liquidity: bigint;
  /** initialized tick → liquidityNet */
  readonly nets: ReadonlyMap<number, bigint>;
};

function slot0(tick: number): Hex {
  return encodeAbiParameters(
    [
      { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" },
      { type: "uint16" }, { type: "uint32" }, { type: "bool" },
    ],
    [2n ** 96n, tick, 0, 100, 100, 0, true],
  );
}

function ticksRow(net: bigint): Hex {
  return encodeAbiParameters(
    [
      { type: "uint128" }, { type: "int128" }, { type: "uint256" }, { type: "uint256" },
      { type: "int56" }, { type: "uint160" }, { type: "uint32" }, { type: "bool" },
    ],
    [net < 0n ? -net : net, net, 0n, 0n, 0n, 0n, 0, true],
  );
}

function bitmapFor(scenario: Scenario, word: number): bigint {
  let bits = 0n;
  for (const tick of scenario.nets.keys()) {
    const compressed = tick / scenario.spacing;
    if (Math.floor(compressed / 256) !== word) continue;
    const bit = compressed - word * 256;
    bits |= 1n << BigInt(bit);
  }
  return bits;
}

function fixture(scenario: Scenario) {
  const calls: { method: string; block?: string; selector?: string; arg?: number }[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    if (method === "eth_chainId") { calls.push({ method }); return "0x38"; }
    if (method === "eth_getBlockByNumber") {
      calls.push({ method });
      return { number: `0x${FINALIZED.toString(16)}`, hash: `0x${"11".repeat(32)}`, timestamp: "0x1", parentHash: `0x${"22".repeat(32)}`, transactions: [] };
    }
    if (method === "eth_call") {
      const [tx, block] = params as [{ to?: string; data?: string }, string];
      const data = (tx.data ?? "0x") as Hex;
      const selector = data.slice(0, 10).toLowerCase();
      const argsHex = `0x${data.slice(10)}` as Hex;
      if (selector === SEL.slot0) { calls.push({ method, block, selector }); return slot0(scenario.currentTick); }
      if (selector === SEL.liquidity) { calls.push({ method, block, selector }); return encodeAbiParameters([{ type: "uint128" }], [scenario.liquidity]); }
      if (selector === SEL.tickSpacing) { calls.push({ method, block, selector }); return encodeAbiParameters([{ type: "int24" }], [scenario.spacing]); }
      if (selector === SEL.tickBitmap) {
        const [word] = decodeAbiParameters([{ type: "int16" }], argsHex);
        calls.push({ method, block, selector, arg: word });
        return encodeAbiParameters([{ type: "uint256" }], [bitmapFor(scenario, word)]);
      }
      if (selector === SEL.ticks) {
        const [tick] = decodeAbiParameters([{ type: "int24" }], argsHex);
        calls.push({ method, block, selector, arg: tick });
        const net = scenario.nets.get(tick);
        if (net === undefined) throw new Error(`ticks() asked for an uninitialized tick ${tick}`);
        return ticksRow(net);
      }
      throw new Error(`unscripted eth_call selector ${selector}`);
    }
    throw new Error(`unscripted RPC method ${method}`);
  };
  const readers = createLpChainReaders({
    network: { chain: bsc, chainId: 56, publicRpcUrl: "http://scripted.invalid" },
    transport: () => custom({ request }, { retryCount: 0 }),
    nfpm: NFPM,
    factory: FACTORY,
    quoterV2: QUOTER,
    twapWindowSeconds: 300,
  });
  return { readers, calls };
}

describe("tickLiquidity — the pool's per-bin liquidity profile", () => {
  it("walks liquidityNet up and down from the active bin, at the finalized block", async () => {
    // spacing 10, current tick 23 ⇒ active bin [20, 30). Initialized ticks:
    //   0 (+300), 20 (+500, already crossed: inside L), 40 (−200), 60 (+100).
    const scenario: Scenario = {
      currentTick: 23,
      spacing: 10,
      liquidity: 1_000n,
      nets: new Map([[0, 300n], [20, 500n], [40, -200n], [60, 100n]]),
    };
    const { readers, calls } = fixture(scenario);
    assert.ok(readers.tickLiquidity);
    const reading = await readers.tickLiquidity(POOL, { windowBins: 5 });

    assert.equal(reading.currentTick, 23);
    assert.equal(reading.tickSpacing, 10);
    assert.equal(reading.activeLiquidity, 1_000n);
    assert.equal(reading.blockNumber, FINALIZED);
    assert.equal(reading.truncated, false);
    const at = new Map(reading.bins.map((bin) => [bin.tickLower, bin.liquidity]));
    // window: bins −30 … 70
    assert.equal(reading.bins.length, 11);
    assert.equal(at.get(20), 1_000n, "the active bin carries L exactly");
    assert.equal(at.get(30), 1_000n, "no initialized tick at 30");
    assert.equal(at.get(40), 800n, "crossing 40 upward adds −200");
    assert.equal(at.get(50), 800n);
    assert.equal(at.get(60), 900n, "crossing 60 upward adds +100");
    assert.equal(at.get(70), 900n);
    assert.equal(at.get(10), 500n, "leaving [20,30) downward crosses tick 20: 1000 − 500");
    assert.equal(at.get(0), 500n, "no initialized tick at 10");
    assert.equal(at.get(-10), 200n, "crossing 0 downward: 500 − 300");
    assert.equal(at.get(-20), 200n);
    assert.equal(at.get(-30), 200n);

    // Every eth_call pinned to the finalized height; `ticks()` asked only for
    // initialized ticks inside the window.
    const ethCalls = calls.filter((call) => call.method === "eth_call");
    assert.ok(ethCalls.length > 0);
    for (const call of ethCalls) assert.equal(call.block, `0x${FINALIZED.toString(16)}`);
    const tickReads = ethCalls.filter((call) => call.selector === SEL.ticks).map((call) => call.arg).sort((a, b) => (a as number) - (b as number));
    assert.deepEqual(tickReads, [0, 20, 40, 60]);
  });

  it("reads every bitmap word the window touches and ignores initialized ticks outside it", async () => {
    // spacing 1 ⇒ 256 ticks per word; window ±150 around tick 300 is [150, 450],
    // which spans words 0 and 1. Ticks −100 and 900 are initialized but OUTSIDE.
    const scenario: Scenario = {
      currentTick: 300,
      spacing: 1,
      liquidity: 50n,
      nets: new Map([[-100, 10n], [250, -20n], [900, 7n]]),
    };
    const { readers, calls } = fixture(scenario);
    const reading = await readers.tickLiquidity!(POOL, { windowBins: 150 });
    const words = calls.filter((call) => call.selector === SEL.tickBitmap).map((call) => call.arg).sort((a, b) => (a as number) - (b as number));
    assert.deepEqual(words, [0, 1]);
    const tickReads = calls.filter((call) => call.selector === SEL.ticks).map((call) => call.arg);
    assert.deepEqual(tickReads, [250]);
    assert.equal(reading.bins.length, 301);
    const at = new Map(reading.bins.map((bin) => [bin.tickLower, bin.liquidity]));
    assert.equal(at.get(300), 50n);
    assert.equal(at.get(450), 50n, "nothing initialized above the current tick inside the window");
    assert.equal(at.get(250), 50n, "the bin AT tick 250 still sits above the crossing");
    assert.equal(at.get(249), 70n, "leaving bin 250 downward crosses tick 250: 50 − (−20)");
    assert.equal(at.get(150), 70n);
  });

  it("reconstructs NEGATIVE initialized ticks from the bitmap with a non-1 spacing", async () => {
    // spacing 10, current tick −66415 (a live USDT/WBNB reading). Initialized
    // ticks −66500 (+40), −66420 (+60, already inside L), −66300 (−25).
    // Compressed ticks −6650 / −6642 / −6630 all live in word −26 (floor(−6650/256));
    // the window's low edge −66620 (compressed −6662) touches word −27 as well.
    const scenario: Scenario = {
      currentTick: -66_415,
      spacing: 10,
      liquidity: 500n,
      nets: new Map([[-66_500, 40n], [-66_420, 60n], [-66_300, -25n]]),
    };
    const { readers, calls } = fixture(scenario);
    const reading = await readers.tickLiquidity!(POOL, { windowBins: 20 });
    const words = calls.filter((call) => call.selector === SEL.tickBitmap).map((call) => call.arg);
    assert.deepEqual([...new Set(words)].sort((a, b) => (a as number) - (b as number)), [-27, -26]);
    const tickReads = calls.filter((call) => call.selector === SEL.ticks).map((call) => call.arg).sort((a, b) => (a as number) - (b as number));
    assert.deepEqual(tickReads, [-66_500, -66_420, -66_300]);
    const at = new Map(reading.bins.map((bin) => [bin.tickLower, bin.liquidity]));
    assert.equal(at.get(-66_420), 500n, "the active bin [−66420, −66410) carries L");
    assert.equal(at.get(-66_300), 475n, "crossing −66300 upward adds −25");
    assert.equal(at.get(-66_430), 440n, "leaving the active bin downward crosses −66420: 500 − 60");
    assert.equal(at.get(-66_500), 440n, "the bin AT −66500 is still above that crossing");
    assert.equal(at.get(-66_510), 400n, "crossing −66500 downward: 440 − 40");
  });

  it("reconstructs initialized ticks on BOTH sides of a bitmap word boundary (negative, spacing 10)", async () => {
    // spacing 10: compressed tick −6656 is exactly word −26 bit 0 (−6656/256 = −26);
    // compressed −6657 is word −27 bit 255. Ticks −66560 and −66570 therefore sit
    // on either side of the boundary, with the current tick between them and
    // the next word up.
    const scenario: Scenario = {
      currentTick: -66_540,
      spacing: 10,
      liquidity: 900n,
      nets: new Map([[-66_570, 70n], [-66_560, 30n], [-66_500, -100n]]),
    };
    const { readers, calls } = fixture(scenario);
    const reading = await readers.tickLiquidity!(POOL, { windowBins: 10 });
    const words = [...new Set(calls.filter((call) => call.selector === SEL.tickBitmap).map((call) => call.arg))].sort((a, b) => (a as number) - (b as number));
    assert.deepEqual(words, [-27, -26]);
    const tickReads = calls.filter((call) => call.selector === SEL.ticks).map((call) => call.arg).sort((a, b) => (a as number) - (b as number));
    assert.deepEqual(tickReads, [-66_570, -66_560, -66_500]);
    const at = new Map(reading.bins.map((bin) => [bin.tickLower, bin.liquidity]));
    assert.equal(at.get(-66_540), 900n, "active bin");
    assert.equal(at.get(-66_500), 800n, "crossing −66500 upward adds −100");
    assert.equal(at.get(-66_560), 900n, "the bin AT −66560 is still above that crossing");
    assert.equal(at.get(-66_570), 870n, "crossing −66560 downward: 900 − 30 (word −26 bit 0)");
    assert.equal(at.get(-66_580), 800n, "crossing −66570 downward: 870 − 70 (word −27 bit 255)");
  });

  it("clamps the window and never returns a negative bin", async () => {
    const scenario: Scenario = {
      currentTick: 0,
      spacing: 10,
      liquidity: 5n,
      nets: new Map([[10, -50n]]), // an impossible net for L=5, still must not go below zero
    };
    const { readers } = fixture(scenario);
    const reading = await readers.tickLiquidity!(POOL, { windowBins: 10_000 });
    assert.equal(reading.bins.length, 2 * MAX_LIQUIDITY_WINDOW_BINS + 1);
    for (const bin of reading.bins) assert.ok(bin.liquidity >= 0n);
    assert.equal(reading.bins.find((bin) => bin.tickLower === 10)?.liquidity, 0n);
  });

  it("truncates the far edges when a word holds more initialized ticks than the budget", async () => {
    // spacing 1, every tick from −400 to 400 initialized ⇒ 801 > budget.
    const nets = new Map<number, bigint>();
    for (let tick = -400; tick <= 400; tick += 1) nets.set(tick, 1n);
    const scenario: Scenario = { currentTick: 0, spacing: 1, liquidity: 1_000n, nets };
    const { readers, calls } = fixture(scenario);
    const reading = await readers.tickLiquidity!(POOL, { windowBins: 400 });
    assert.equal(reading.truncated, true);
    const tickReads = calls.filter((call) => call.selector === SEL.ticks).length;
    assert.equal(tickReads, MAX_LIQUIDITY_INITIALIZED_TICKS);
    assert.ok(reading.bins.length < 801);
    // The kept ticks are the nearest ones, so the active bin is always present.
    assert.ok(reading.bins.some((bin) => bin.tickLower === 0));
  });
});
