import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { RELAY_FEE_PER_EXIT_WEI, nativeReserveFloor } from "../src/ops/policy.js";
import {
  MAX_GRANTED_TOKENS,
  maxGrantedTokens,
  MIN_ENTRY_WEI,
  TRADE_MODEL_PRESETS,
  checkTradeSizing,
  nativeDayCapWei,
  sizeTradeBuy,
  TRADE_ENTRY_RELAY_HEADROOM_WEI,
} from "../src/trade/sizing.js";
import { createBpsFeePolicy, createNoFeePolicy, feeValueOf } from "../src/ops/fees.js";
import { evaluateTradeRules } from "../src/rules/engine.js";

describe("fee-inclusive worker entry sizing", () => {
  const address = "0x1111111111111111111111111111111111111111" as const;
  it("leaves buy/sell relay headroom at every supported fee rate and wei boundary", () => {
    for (let bps = 0; bps <= 500; bps += 1) {
      const policy = bps === 0 ? createNoFeePolicy() : createBpsFeePolicy({ treasury: address, bps });
      for (const cap of [TRADE_ENTRY_RELAY_HEADROOM_WEI + 2n, MIN_ENTRY_WEI - 1n, MIN_ENTRY_WEI, 10n ** 30n]) {
        const sized = sizeTradeBuy({ entryWei: cap, perTradeCapWei: cap, platformFeeBps: bps });
        assert(sized !== null);
        const fee = feeValueOf(policy({ agentId: "a", venue: "pancake", side: "buy",
          token: address, nativeInWei: sized.amountWei }));
        assert.equal(sized.feeWei, fee);
        assert(sized.amountWei + fee + TRADE_ENTRY_RELAY_HEADROOM_WEI <= cap);
        assert(sized.amountWei > 0n);
      }
    }
  });

  it("honours both owner ceilings and refuses invalid or exhausted budgets", () => {
    const input = { entryWei: MIN_ENTRY_WEI, perTradeCapWei: undefined, platformFeeBps: 100 };
    assert.equal(sizeTradeBuy(input)?.amountWei, 1_782_178_217_821_782n);
    assert.deepEqual(sizeTradeBuy({ ...input, perTradeCapWei: MIN_ENTRY_WEI * 2n }), sizeTradeBuy(input));
    assert.deepEqual(sizeTradeBuy({ ...input, perTradeCapWei: MIN_ENTRY_WEI / 2n }),
      sizeTradeBuy({ ...input, entryWei: MIN_ENTRY_WEI / 2n }));
    for (const cap of [-1n, 0n, TRADE_ENTRY_RELAY_HEADROOM_WEI]) {
      assert.equal(sizeTradeBuy({ ...input, perTradeCapWei: cap }), null);
    }
    for (const bps of [-1, 501, 0.5, NaN, Infinity]) {
      assert.equal(sizeTradeBuy({ ...input, platformFeeBps: bps }), null);
    }
  });

  it("supports repeated entries while the unchanged cumulative day cap still stops spending", () => {
    const sized = sizeTradeBuy({ entryWei: MIN_ENTRY_WEI, perTradeCapWei: MIN_ENTRY_WEI, platformFeeBps: 100 });
    assert(sized !== null);
    const charged = sized.amountWei + sized.feeWei;
    const caps = { perTradeNativeWei: MIN_ENTRY_WEI, dailyNativeWei: 20_000_000_000_000_000n };
    let spent = 0n;
    for (let cycle = 0; cycle < 11; cycle += 1) {
      assert.equal(evaluateTradeRules({ amountWei: sized.amountWei, nativeInWei: charged,
        minOutWei: 100n, quotedOutWei: 100n, maxSlippageBps: 300, caps, spentTodayWei: spent }).allowed, true);
      spent += charged;
    }
    assert.deepEqual(evaluateTradeRules({ amountWei: sized.amountWei, nativeInWei: charged,
      minOutWei: 100n, quotedOutWei: 100n, maxSlippageBps: 300, caps, spentTodayWei: spent }),
    { allowed: false, code: "DAILY_CAP" });
  });
});

describe("trade sizing", () => {
  it("runs every model preset and keeps exactly one relay-fee margin on the last fresh buy", () => {
    for (const preset of Object.values(TRADE_MODEL_PRESETS)) {
      const sizing = checkTradeSizing({
        capDayWei: preset.capital,
        entryWei: preset.perTrade,
        maxOpenPositions: preset.maxPositions,
        grantedTokenCount: MAX_GRANTED_TOKENS,
        platformFeeBps: 500,
      });
      assert.equal(sizing.ok, true);
      const priorBuys = BigInt(preset.maxPositions - 1);
      const floor = nativeReserveFloor({
        limitWei: sizing.requiredWei,
        currentSpentWei: priorBuys * (preset.perTrade + sizing.platformFeePerEntryWei + RELAY_FEE_PER_EXIT_WEI),
        grantedTokenCount: MAX_GRANTED_TOKENS,
        submissionNativeWei: preset.perTrade + sizing.platformFeePerEntryWei,
      });
      assert.equal(floor.remainingWei - floor.requiredWei, RELAY_FEE_PER_EXIT_WEI);
    }
  });

  it("implements the exact inclusive cap predicate and range gates", () => {
    const input = { entryWei: MIN_ENTRY_WEI, maxOpenPositions: 1, grantedTokenCount: 25, platformFeeBps: 500 };
    const sized = checkTradeSizing({ ...input, capDayWei: 0n });
    assert.equal(checkTradeSizing({ ...input, capDayWei: sized.minimumCapWei }).ok, true);
    assert.equal(checkTradeSizing({ ...input, capDayWei: sized.minimumCapWei - 1n }).ok, false);
    assert.equal(checkTradeSizing({ ...input, entryWei: MIN_ENTRY_WEI - 1n, capDayWei: sized.minimumCapWei }).ok, false);
    assert.equal(checkTradeSizing({ ...input, maxOpenPositions: 11, capDayWei: 1_000_000_000_000_000_000n }).ok, false);
    assert.equal(checkTradeSizing({
      capDayWei: 1_000_000_000_000_000_000n,
      entryWei: 500_000_000_000_000_000n,
      maxOpenPositions: 4,
      grantedTokenCount: 25,
      platformFeeBps: 500,
    }).ok, false);
  });

  it("reads the sole untokened native spend cap", () => {
    const spec = {
      allowedCalls: [],
      spendCaps: [
        { token: "0x1111111111111111111111111111111111111111" as const, limit: 2n, period: "day" as const },
        { limit: 7n, period: "day" as const },
      ],
      expiresAt: 1,
    };
    assert.equal(nativeDayCapWei({ spec }), 7n);
    // R4 C28: total — zero, two, or a native cap at another period all answer null.
    assert.equal(nativeDayCapWei({ spec: { ...spec, spendCaps: [] } }), null);
    assert.equal(nativeDayCapWei({ spec: { ...spec, spendCaps: [...spec.spendCaps, { limit: 9n, period: "day" as const }] } }), null);
    assert.equal(nativeDayCapWei({ spec: { ...spec, spendCaps: [{ limit: 7n, period: "hour" as const }] } }), null);
  });

  it("deep-equals the browser preset fixture", async () => {
    const fixture = JSON.parse(await readFile(new URL("../web/lib/fixtures/trade-model-presets.json", import.meta.url), "utf8")) as unknown;
    const normalized = Object.fromEntries(Object.entries(TRADE_MODEL_PRESETS).map(([name, preset]) => [name, {
      perTradeWei: preset.perTrade.toString(10), maxPositions: preset.maxPositions,
      capitalWei: preset.capital.toString(10), minConfidence: preset.minConfidence,
    }]));
    assert.deepEqual(normalized, fixture);
  });
});

it("69 permissions retain actual reserve and refuse the unchanged default capital",()=>{
  const input={capDayWei:10_000_000_000_000_000n,entryWei:2_000_000_000_000_000n,maxOpenPositions:3,grantedTokenCount:69,platformFeeBps:500};
  const sized=checkTradeSizing(input);assert.equal(sized.ok,false);
  assert.equal(BigInt(input.grantedTokenCount)*100_000_000_000_000n,6_900_000_000_000_000n);
  assert.equal(sized.minimumCapWei,13_600_000_000_000_000n);
  assert.equal(checkTradeSizing({...input,capDayWei:sized.minimumCapWei}).ok,true);
  assert.equal(maxGrantedTokens("mid-cap"),25);assert.equal(maxGrantedTokens("degen"),25);
});

it("new grants cap every mode at25",()=>{
  for(const model of ["blue-chip","sigma","mid-cap","degen"] as const) assert.equal(maxGrantedTokens(model),25);
});
