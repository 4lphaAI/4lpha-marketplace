import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paramsHash } from "../src/auth/canonical.js";
import { DEFAULT_MAX_BODY_BYTES } from "../src/server.js";
import {
  DEFAULT_TRADE_SETTINGS,
  DEFAULT_TRADE_SETTINGS_DIGEST,
  MAX_INSTRUCTIONS_ENCODED_BYTES,
  MAX_SKILL_MARKDOWN_ENCODED_BYTES,
  encodedJsonStringBytes,
  immutableTradeSettingChange,
  parseTradeSettings,
  tradeSettingsDigest,
} from "../src/trade/settings.js";

describe("trade settings codec", () => {
  it("pins the complete default object to one literal digest", () => {
    assert.equal(
      paramsHash("tradeSettings", DEFAULT_TRADE_SETTINGS),
      DEFAULT_TRADE_SETTINGS_DIGEST,
    );
  });

  it("requires every key and uses null, never absence, for unset fields", () => {
    assert.equal(parseTradeSettings(DEFAULT_TRADE_SETTINGS).ok, true);
    const { skillMarkdown: _omitted, ...missing } = DEFAULT_TRADE_SETTINGS;
    const parsed = parseTradeSettings(missing);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.message, /missing key "skillMarkdown"/u);
  });

  it("folds a 40-hex skill string identically across address casing", () => {
    const lower = { ...DEFAULT_TRADE_SETTINGS, skillMarkdown: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" };
    const upper = { ...DEFAULT_TRADE_SETTINGS, skillMarkdown: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD" };
    assert.equal(paramsHash("tradeSettings", lower), paramsHash("tradeSettings", upper));
  });

  it("measures CJK instructions in JSON-encoded UTF-8 bytes at the boundary", () => {
    const legal = "界".repeat(682);
    assert.equal(encodedJsonStringBytes(legal), MAX_INSTRUCTIONS_ENCODED_BYTES);
    assert.equal(parseTradeSettings({ ...DEFAULT_TRADE_SETTINGS, instructions: legal }).ok, true);
    assert.equal(parseTradeSettings({ ...DEFAULT_TRADE_SETTINGS, instructions: `${legal}界` }).ok, false);
  });

  it("measures quote/backslash-only skill text after JSON escaping", () => {
    const legal = "\"\\".repeat(1_535) + "\"";
    assert.equal(encodedJsonStringBytes(legal), MAX_SKILL_MARKDOWN_ENCODED_BYTES);
    assert.equal(parseTradeSettings({ ...DEFAULT_TRADE_SETTINGS, skillMarkdown: legal }).ok, true);
    assert.equal(parseTradeSettings({ ...DEFAULT_TRADE_SETTINGS, skillMarkdown: `${legal}\\` }).ok, false);
  });

  it("keeps a maximal settings JSON body below the server's 16 KiB default", () => {
    const instructions = "界".repeat(682);
    const skillMarkdown = "\"\\".repeat(1_535) + "\"";
    const body = JSON.stringify({ ...DEFAULT_TRADE_SETTINGS, instructions, skillMarkdown });
    assert.ok(Buffer.byteLength(body, "utf8") < DEFAULT_MAX_BODY_BYTES);
    assert.equal(parseTradeSettings(JSON.parse(body)).ok, true);
  });

  it("enforces the money, count, exit and slippage ranges", () => {
    const cases: readonly [keyof typeof DEFAULT_TRADE_SETTINGS, unknown][] = [
      ["entryWei", "1999999999999999"],
      ["maxOpenPositions", 0],
      ["maxOpenPositions", 11],
      ["slippageBps", 49],
      ["slippageBps", 501],
      ["takeProfitBps", 10_001],
      ["stopLossBps", -1],
      ["maxHoldSec", 59],
      ["maxHoldSec", 604_801],
    ];
    for (const [key, value] of cases) {
      assert.equal(parseTradeSettings({ ...DEFAULT_TRADE_SETTINGS, [key]: value }).ok, false, key);
    }
  });

  it("keeps raw and effective settings separate, with absent crash protection off", () => {
    const { crashProtection: _removed, ...legacy } = DEFAULT_TRADE_SETTINGS;
    const parsed = parseTradeSettings(legacy);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(Object.hasOwn(parsed.value.raw, "crashProtection"), false);
    assert.equal(parsed.value.effective.crashProtection, false);
    assert.equal(tradeSettingsDigest(parsed.value.raw), "0x7cafe05bfc722149e95a810584313332b3ea28f774cb98b0234747cd03ba9f63");
    assert.equal(tradeSettingsDigest(DEFAULT_TRADE_SETTINGS), "0xffc2f80941f258f3964d75961094b5e82759dd33211c61a86f033c62b5fe01ef");
    assert.notEqual(tradeSettingsDigest(parsed.value.raw), tradeSettingsDigest(DEFAULT_TRADE_SETTINGS));
    assert.equal(immutableTradeSettingChange(parsed.value.effective, { ...parsed.value.effective, crashProtection: true }), null);
  });

  it("rejects a present non-boolean crash protection field", () => {
    assert.equal(parseTradeSettings({ ...DEFAULT_TRADE_SETTINGS, crashProtection: "on" }).ok, false);
  });

  it("accepts the closed schedule tuple and rejects its safety bounds", () => {
    const schedule = {
      ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi" as const, entryWei: "10000000000000000000", maxOpenPositions: 1,
      takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, noReentry: false,
      settlementAsset: "USDT" as const, minEntryWei: "10000000000000000000", capitalQuoteWei: "21000000000000000000", cmcNewsEnabled: false,
      tradeMode: "schedule" as const, scheduleToken: "0x1111111111111111111111111111111111111111", scheduleIntervalSec: 86400 as const,
      scheduleFirstAtSec: null, scheduleEndKind: "runs" as const, scheduleEndAtSec: null, scheduleEndRuns: 2, scheduleMarketHoursOnly: true, scheduleMaxPremiumBps: 150,
    };
    assert.equal(parseTradeSettings(schedule).ok, true);
    assert.equal(parseTradeSettings({ ...schedule, scheduleIntervalSec: 604800 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, scheduleMaxPremiumBps: 49 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, scheduleToken: "0x111111111111111111111111111111111111111A" }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, minEntryWei: "9000000000000000000" }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, scheduleEndRuns: 0 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, scheduleEndKind: "date", scheduleEndRuns: null }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, maxOpenPositions: 2 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, stopLossBps: 100 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, takeProfitBps: 100 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, maxHoldSec: 3_600 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, cmcNewsEnabled: true, cmcTotalBudgetWei: "1" }).ok, false);
    const { tradeMode: _missingMode, ...withoutMode } = schedule;
    assert.equal(parseTradeSettings(withoutMode).ok, false);
    // Every remaining §3 rejection: premium's other bound, both runs-count
    // boundaries (missing and above 1000), the model that never carries the
    // v2 tuple, a tradfi hire missing the v2 tuple outright, a same-length
    // but uppercase token, and an entryWei just under the 5 USDT floor.
    assert.equal(parseTradeSettings({ ...schedule, scheduleMaxPremiumBps: 151 }).ok, false);
    const { scheduleEndRuns: _missingRuns, ...withoutRuns } = schedule;
    assert.equal(parseTradeSettings(withoutRuns).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, scheduleEndRuns: 1_001 }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, executionModel: "sigma" as const }).ok, false);
    const { settlementAsset: _sa, minEntryWei: _me, capitalQuoteWei: _cq, cmcNewsEnabled: _cn, ...withoutV2Tuple } = schedule;
    assert.equal(parseTradeSettings(withoutV2Tuple).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, scheduleToken: `0x${"1".repeat(39)}A` }).ok, false);
    assert.equal(parseTradeSettings({ ...schedule, entryWei: "4999000000000000000", minEntryWei: "4999000000000000000" }).ok, false);
    const vector = { ...schedule, name: "Schedule Agent", slippageBps: 100, capitalQuoteWei: "21000000000000000000" };
    assert.equal(tradeSettingsDigest(vector), "0xb97380173c0c44609b4bd72f83c896097d2c947f63a6df9aeb20e4c7a0aa8349");
  });

  it("allows only the schedule edit set and never changes its mode", () => {
    const schedule = {
      ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi" as const, entryWei: "10000000000000000000", maxOpenPositions: 1,
      takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, noReentry: false,
      settlementAsset: "USDT" as const, minEntryWei: "10000000000000000000", capitalQuoteWei: "21000000000000000000", cmcNewsEnabled: false,
      tradeMode: "schedule" as const, scheduleToken: "0x1111111111111111111111111111111111111111", scheduleIntervalSec: 86400 as const,
      scheduleFirstAtSec: null, scheduleEndKind: "runs" as const, scheduleEndAtSec: null, scheduleEndRuns: 2, scheduleMarketHoursOnly: true, scheduleMaxPremiumBps: 150,
    };
    const parsed = parseTradeSettings(schedule);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(immutableTradeSettingChange(parsed.value.effective, { ...parsed.value.effective, scheduleMaxPremiumBps: 100 }), null);
    assert.equal(immutableTradeSettingChange(parsed.value.effective, { ...parsed.value.effective, scheduleIntervalSec: 3600 }), null);
    assert.equal(immutableTradeSettingChange(parsed.value.effective, { ...parsed.value.effective, scheduleToken: "0x2222222222222222222222222222222222222222" }), "scheduleToken");
    const legacy = parseTradeSettings(DEFAULT_TRADE_SETTINGS);
    assert.equal(legacy.ok, true);
    if (legacy.ok) assert.equal(immutableTradeSettingChange(parsed.value.effective, legacy.value.effective), "tradeMode");
  });
});
