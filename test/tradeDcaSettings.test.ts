/**
 * The Auto DCA signed-settings tuple (AUTO-DCA-SPEC §8, R2.16) and its flag
 * (§0.2). The legacy, AI-mode v2, Schedule and default digests stay pinned by
 * `test/tradeSettings.test.ts`, which this phase does not edit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_TRADE_SETTINGS,
  immutableTradeSettingChange,
  isTradeDcaSettings,
  isTradeScheduleSettings,
  parseTradeSettings,
  tradeSettingsDigest,
  type EffectiveTradeSettings,
} from "../src/trade/settings.js";
import { resolveDcaEnabled } from "../src/ops/config.js";

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const QQQB = "0x205812cdbed920aff76c6580abd681a46d11efc7";
const SPYB = "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8";

/** The mock's defaults as ruled (R2.16): base 15, order 10, max 4, step 1 %, TP 1.5 %. */
const DCA: Readonly<Record<string, unknown>> = {
  ...DEFAULT_TRADE_SETTINGS,
  name: "Auto DCA 01", executionModel: "tradfi", entryWei: "15000000000000000000",
  maxOpenPositions: 1, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
  breakEvenAfterTp: false, slippageBps: 100, crashProtection: false,
  settlementAsset: "USDT", minEntryWei: "15000000000000000000", capitalQuoteWei: "55000000000000000000",
  cmcNewsEnabled: false, tradeMode: "dca", dcaToken: NVDAB, dcaStepBps: 100, dcaStepMultiplierBps: 12000,
  dcaTakeProfitBps: 150, dcaOrderWei: "10000000000000000000", dcaMaxOrders: 4, dcaTriggerPriceE8: null,
  dcaRangeMinE8: null, dcaRangeMaxE8: null, dcaStopLossBps: null,
};

function refused(value: Record<string, unknown>): string {
  const parsed = parseTradeSettings(value);
  assert.equal(parsed.ok, false, "expected a refusal");
  return parsed.ok ? "" : parsed.message;
}

function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...DCA };
  delete copy[key];
  return copy;
}

function effective(value: Record<string, unknown>): EffectiveTradeSettings {
  const parsed = parseTradeSettings(value);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  return parsed.value.effective;
}

describe("the full tuple (§8.1)", () => {
  it("is accepted verbatim, keys on its one predicate, and has a literal digest", () => {
    const parsed = parseTradeSettings(DCA);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.value.raw, DCA);
    assert.equal(isTradeDcaSettings(parsed.value.raw), true);
    assert.equal(isTradeScheduleSettings(parsed.value.raw), false);
    assert.equal(parsed.value.effective.crashProtection, false);
    assert.equal(tradeSettingsDigest(parsed.value.raw), "0x134ca8114055330dc08c2fb692e8d2130fe32d5c1efd641a87c2a65141d83db0");
  });

  it("accepts the optional controls when set, and the edges of every range", () => {
    for (const patch of [
      { dcaTriggerPriceE8: "20000000000", dcaRangeMinE8: "15000000000", dcaRangeMaxE8: "20000000000", dcaStopLossBps: 1500 },
      { dcaStepBps: 1676 }, { dcaStepBps: 3000, dcaMaxOrders: 2, capitalQuoteWei: "35000000000000000000" },
      { dcaStepBps: 545, dcaMaxOrders: 8, capitalQuoteWei: "95000000000000000000" },
      { dcaTakeProfitBps: 100 }, { dcaTakeProfitBps: 10_000 }, { dcaStopLossBps: 100 }, { dcaStopLossBps: 9900 },
    ]) {
      const parsed = parseTradeSettings({ ...DCA, ...patch });
      assert.ok(parsed.ok, `${JSON.stringify(patch)}: ${parsed.ok ? "" : parsed.message}`);
    }
  });
});

describe("every §8.3 message, exactly", () => {
  it("the tuple is all-or-nothing and never mixed with a schedule", () => {
    assert.equal(refused(without("dcaStopLossBps")), 'DCA settings are missing key "dcaStopLossBps".');
    assert.equal(refused(without("tradeMode")), 'DCA settings are missing key "tradeMode".');
    assert.equal(refused({ ...DCA, tradeMode: "grid" }), 'DCA settings require tradeMode="dca".');
    assert.equal(refused({ ...DCA, tradeMode: "schedule" }), "DCA and schedule settings cannot be combined.");
    assert.equal(refused({ ...DCA, scheduleToken: NVDAB }), "DCA and schedule settings cannot be combined.");
    const v1 = { ...DCA };
    for (const key of ["settlementAsset", "minEntryWei", "capitalQuoteWei", "cmcNewsEnabled"]) delete v1[key];
    assert.equal(refused(v1), "DCA settings require the TradFi v2 USDT tuple.");
    assert.equal(refused({ ...v1, executionModel: "sigma" }), "DCA settings require executionModel=tradfi.");
  });

  it("the stock, the ladder and the take profit", () => {
    assert.equal(refused({ ...DCA, dcaToken: "0x55d398326f99059ff775485246999027b3197955" }), "dcaToken must be one of the Auto DCA stocks.");
    assert.equal(refused({ ...DCA, dcaToken: NVDAB.toUpperCase().replace("0X", "0x") }), "dcaToken must be one of the Auto DCA stocks.");
    for (const step of [99, 3001, 150.5]) {
      assert.equal(refused({ ...DCA, dcaStepBps: step }), "dcaStepBps must be an integer from 100 through 3000.");
    }
    assert.equal(refused({ ...DCA, dcaStepBps: 1677 }),
      "With 4 DCA orders the price drop step can be at most 16.76 % (the deepest order must stay within 90 % of the base price).");
    assert.equal(refused({ ...DCA, dcaStepBps: 546, dcaMaxOrders: 8, capitalQuoteWei: "95000000000000000000" }),
      "With 8 DCA orders the price drop step can be at most 5.45 % (the deepest order must stay within 90 % of the base price).");
    assert.equal(refused({ ...DCA, dcaStepMultiplierBps: 10000 }), "dcaStepMultiplierBps must equal 12000.");
    assert.equal(refused({ ...DCA, dcaTakeProfitBps: 99 }), "dcaTakeProfitBps must be an integer from 100 through 10000.");
    // RV-1 (operator 2026-09-25): the fee-100 pools need a take profit of at least 1.5 %.
    for (const [symbol, token] of [["QQQB", QQQB], ["SPYB", SPYB]] as const) {
      assert.equal(refused({ ...DCA, dcaToken: token, dcaTakeProfitBps: 149 }), `On ${symbol} the take profit must be at least 1.5 %.`);
      assert.equal(parseTradeSettings({ ...DCA, dcaToken: token, dcaTakeProfitBps: 150 }).ok, true);
    }
    assert.equal(parseTradeSettings({ ...DCA, dcaTakeProfitBps: 100 }).ok, true, "a fee-2500 stock keeps the 1 % floor");
    for (const orders of [0, 9]) {
      assert.equal(refused({ ...DCA, dcaMaxOrders: orders }), "dcaMaxOrders must be an integer from 1 through 8.");
    }
  });

  it("the sizes (R2.16: base ≥ 15, order ≥ 10) and the capital identity", () => {
    const base14 = { ...DCA, entryWei: "14999999999999999999", minEntryWei: "14999999999999999999", capitalQuoteWei: "54999999999999999999" };
    assert.equal(refused(base14), "DCA entryWei must be at least 15 USDT and fit uint256.");
    for (const order of ["9999999999999999999", "010000000000000000000"]) {
      assert.equal(refused({ ...DCA, dcaOrderWei: order }), "dcaOrderWei must be at least 10 USDT and fit uint256.");
    }
    assert.equal(refused({ ...DCA, capitalQuoteWei: "56000000000000000000" }), "DCA capitalQuoteWei must equal entryWei + dcaMaxOrders × dcaOrderWei.");
    assert.equal(refused({ ...DCA, minEntryWei: "14000000000000000000" }), "DCA minEntryWei must equal entryWei.");
  });

  it("the existing keys a DCA agent pins (§8.2)", () => {
    assert.equal(refused({ ...DCA, maxOpenPositions: 2 }), "DCA maxOpenPositions must equal 1.");
    assert.equal(refused({ ...DCA, takeProfitBps: 100 }), "DCA exits must use dcaTakeProfitBps and dcaStopLossBps.");
    assert.equal(refused({ ...DCA, maxHoldSec: 600 }), "DCA exits must use dcaTakeProfitBps and dcaStopLossBps.");
    assert.equal(refused({ ...DCA, crashProtection: true }), "DCA crashProtection must be false.");
    assert.equal(refused(without("crashProtection")), "DCA crashProtection must be false.");
    assert.equal(refused({ ...DCA, cmcNewsEnabled: true, cmcTotalBudgetWei: "1000000000000000000" }), "DCA CMC news must be disabled.");
    for (const patch of [{ noReentry: true }, { breakEvenAfterTp: true }, { minMarketCapUsd: 1 }, { instructions: "x" }]) {
      assert.equal(refused({ ...DCA, ...patch }),
        "DCA settings require noReentry and breakEvenAfterTp false and null market caps, instructions and skillMarkdown.");
    }
  });

  it("the optional controls", () => {
    for (const trigger of ["0", "01", 5, "1".repeat(31)]) {
      assert.equal(refused({ ...DCA, dcaTriggerPriceE8: trigger }), "dcaTriggerPriceE8 must be null or a positive canonical decimal.");
    }
    for (const patch of [
      { dcaRangeMinE8: "15000000000" }, { dcaRangeMaxE8: "15000000000" },
      { dcaRangeMinE8: "20000000000", dcaRangeMaxE8: "20000000000" }, { dcaRangeMinE8: "0", dcaRangeMaxE8: "5" },
    ]) {
      assert.equal(refused({ ...DCA, ...patch }), "dcaRangeMinE8 and dcaRangeMaxE8 must both be null or both positive, with min below max.");
    }
    for (const stop of [99, 9901, 1500.5]) {
      assert.equal(refused({ ...DCA, dcaStopLossBps: stop }), "dcaStopLossBps must be null or an integer from 100 through 9900.");
    }
  });
});

describe("editability (§8.4, D16)", () => {
  const current = effective(DCA);

  it("slippage and the stop loss may change; nothing else", () => {
    assert.equal(immutableTradeSettingChange(current, effective({ ...DCA, slippageBps: 200 })), null);
    assert.equal(immutableTradeSettingChange(current, effective({ ...DCA, dcaStopLossBps: 2000 })), null);
    for (const [key, value] of Object.entries(current)) {
      if (key === "slippageBps" || key === "dcaStopLossBps") continue;
      const changed = typeof value === "string" ? `${value}0` : typeof value === "number" ? value + 1
        : typeof value === "boolean" ? !value : 1;
      const next = { ...current, [key]: changed } as EffectiveTradeSettings;
      const expected = key === "tradeMode" || key === "executionModel" || key === "settlementAsset" ? "tradeMode" : key;
      assert.equal(immutableTradeSettingChange(current, next), expected, key);
    }
  });

  it("entryWei and minEntryWei stay immutable for DCA (the v2Mutable fall-through)", () => {
    assert.equal(immutableTradeSettingChange(current, { ...current, entryWei: "20000000000000000000" }), "entryWei");
    assert.equal(immutableTradeSettingChange(current, { ...current, minEntryWei: "10000000000000000000" }), "minEntryWei");
    assert.equal(immutableTradeSettingChange(current, { ...current, dcaTakeProfitBps: 200 }), "dcaTakeProfitBps");
  });

  it("adding, removing or switching the mode is refused", () => {
    const aiV2 = { ...current };
    for (const key of Object.keys(aiV2)) if (key === "tradeMode" || key.startsWith("dca")) delete (aiV2 as Record<string, unknown>)[key];
    assert.equal(immutableTradeSettingChange(current, aiV2 as EffectiveTradeSettings), "tradeMode");
    assert.equal(immutableTradeSettingChange(aiV2 as EffectiveTradeSettings, current), "tradeMode");
    assert.equal(immutableTradeSettingChange(current, { ...current, tradeMode: "schedule" }), "tradeMode");
  });
});

describe("DCA_ENABLED (§0.2), parsed like GRID_ENABLED", () => {
  it("is OFF by default and ON only for the exact string", () => {
    assert.equal(resolveDcaEnabled({}), false);
    assert.equal(resolveDcaEnabled({ DCA_ENABLED: "" }), false);
    assert.equal(resolveDcaEnabled({ DCA_ENABLED: "false" }), false);
    assert.equal(resolveDcaEnabled({ DCA_ENABLED: "true", TRADE_AGENT_ENABLED: "true" }), true);
  });

  it("a typo fails the boot", () => {
    for (const raw of ["1", "TRUE", "yes", "on"]) {
      assert.throws(() => resolveDcaEnabled({ DCA_ENABLED: raw, TRADE_AGENT_ENABLED: "true" }), /DCA_ENABLED must be exactly "true" or "false"/);
    }
  });

  it("ON without the trade agent fails the boot, naming both flags", () => {
    for (const trade of [undefined, "", "false"]) {
      assert.throws(() => resolveDcaEnabled({ DCA_ENABLED: "true", TRADE_AGENT_ENABLED: trade }), /DCA_ENABLED is "true" while TRADE_AGENT_ENABLED is not/);
    }
  });
});
