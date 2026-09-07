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
  parseTradeSettings,
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
});
