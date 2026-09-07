import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_GRANTED_TOKENS,
  maxGrantedTokens,
  TRADE_LLM_MODELS,
  TRADE_MODEL_PRESETS,
  checkBoundedText,
  checkTradeSizing,
  stopLossBpsFromPercent,
  stopLossBpsWhenEnabled,
  stopLossPercentFromBps,
  validateSkillMarkdown,
} from "./trade";

describe("trading UI wire constants", () => {
  it("matches the plane preset fixture byte-for-byte", () => {
    const fixture = readFileSync(new URL("./fixtures/trade-model-presets.json", import.meta.url), "utf8");
    expect(`${JSON.stringify(TRADE_MODEL_PRESETS, null, 2)}\n`).toBe(fixture);
  });

  it("keeps every shipped preset deployable with 25 granted tokens", () => {
    for (const preset of Object.values(TRADE_MODEL_PRESETS)) {
      expect(checkTradeSizing({
        capDayWei: BigInt(preset.capitalWei),
        entryWei: BigInt(preset.perTradeWei),
        maxOpenPositions: preset.maxPositions,
        grantedTokenCount: MAX_GRANTED_TOKENS,
        platformFeeBps: 500,
      }).ok).toBe(true);
    }
  });

  it("refuses an oversized markdown upload and reports its encoded byte count", () => {
    const text = "\"".repeat(3_072);
    const result = validateSkillMarkdown("doctrine.md", text);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBe(6_146);
    if (!result.ok) expect(result.message).toContain("received 6146");
  });

  it("accepts only markdown filenames and applies the same encoded bound to CJK instructions", () => {
    expect(validateSkillMarkdown("doctrine.txt", "safe").ok).toBe(false);
    expect(checkBoundedText("界".repeat(682), 2_048, "Instructions").ok).toBe(true);
    const over = checkBoundedText("界".repeat(683), 2_048, "Instructions");
    expect(over.ok).toBe(false);
    expect(over.bytes).toBe(2_051);
  });

  it("refuses deploy sizing below the R2 minimum", () => {
    const result = checkTradeSizing({
      capDayWei: 20_000_000_000_000_000n,
      entryWei: 20_000_000_000_000_000n,
      maxOpenPositions: 3,
      grantedTokenCount: 25,
      platformFeeBps: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.requiredWei).toBe(65_900_000_000_000_000n);
  });

  it("refuses the conflicting 1 BNB / 0.5 BNB / four-position tuple", () => {
    expect(checkTradeSizing({
      capDayWei: 1_000_000_000_000_000_000n,
      entryWei: 500_000_000_000_000_000n,
      maxOpenPositions: 4,
      grantedTokenCount: MAX_GRANTED_TOKENS,
      platformFeeBps: 500,
    }).ok).toBe(false);
  });

  it("round-trips a negative stop-loss display through the positive wire magnitude", () => {
    expect(stopLossPercentFromBps(5_000)).toBe(-50);
    expect(stopLossBpsFromPercent(-50)).toBe(5_000);
    expect(stopLossBpsWhenEnabled(false, -50)).toBeNull();
    expect(stopLossBpsWhenEnabled(true, -50)).toBe(5_000);
  });
});

describe("0G model catalogue", () => {
  it("matches the execution plane's list exactly", () => {
    const fixture: unknown = JSON.parse(readFileSync(new URL("./fixtures/trade-llm-models.json", import.meta.url), "utf8"));
    expect(TRADE_LLM_MODELS.map((model) => ({ id: model.id, label: model.label }))).toEqual(fixture);
  });

  it("offers no model the router answers 404 for", () => {
    const ids: readonly string[] = TRADE_LLM_MODELS.map((model) => model.id);
    for (const gone of ["llama-3.3-70b-instruct", "deepseek-r1", "qwen2.5-72b-instruct", "z-ai/glm-4-32b"]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("keeps the two pickers mutually exclusive by construction", () => {
    const ids = TRADE_LLM_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1);
  });
});

it("caps new grants at25 for every mode",()=>{
 for(const model of ["blue-chip","sigma","mid-cap","degen"] as const) expect(maxGrantedTokens(model)).toBe(25);
});
