import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploySource = readFileSync(new URL("./DeployAgentScreen.tsx", import.meta.url), "utf8");
const tradeDetailSource = readFileSync(new URL("../trade/TradeAgentDetail.tsx", import.meta.url), "utf8");
const hireTradeSource = readFileSync(new URL("../deploy/HireTradeDeploy.tsx", import.meta.url), "utf8");
const configStart = deploySource.indexOf("const CONFIG = {");
const tradingPresets = deploySource.slice(deploySource.indexOf("  trading: ["), deploySource.indexOf("  lp: ["));
const tradingConfigStart = deploySource.indexOf("  trading: [", configStart);
const tradingConfig = deploySource.slice(tradingConfigStart, deploySource.indexOf("  lp: [", tradingConfigStart));

describe("Trading control presentation", () => {
  it("keeps the two trading models and wire break-even disabled", () => {
    expect(tradingPresets).not.toContain('executionModel: "mid-cap"');
    expect(tradingPresets).toContain('label: "Degen"');
    expect(tradingPresets).not.toContain('executionModel: "sigma"');
    expect(tradingPresets).toContain('label: "TradFi", executionModel: "tradfi"');
    expect(tradingPresets).not.toContain('executionModel: "blue-chip"');
    expect(tradingConfig).toContain("Move the stop to break-even");
    expect(deploySource).toContain("breakEvenAfterTp: false");
  });

  it("removes the marked helper and pinned-address copy without dropping pin validation", () => {
    expect(tradingConfig).not.toContain("Rolling daily spend limit for this agent");
    expect(tradingConfig).not.toContain("Fills up to one position every 2 minutes");
    expect(deploySource).toContain("Trades only the tokens pinned when you deploy (up to 25). New launches need a new agent.");
    expect(deploySource).not.toContain("shown in the preview");
  });

  it("renders the mockup's positive stop-loss values while retaining positive canonical BPS", () => {
    for (const value of ['stopLoss: "35"']) {
      expect(tradingPresets).toContain(value);
    }
    expect(tradingConfig).toContain("min: 0, max: 100");
    expect(deploySource).toContain("stopLossBpsWhenEnabled(!!values.stopLossOn, Number(values.stopLoss))");
    expect(tradeDetailSource).toContain("stopLossPercentFromBps(draft.stopLossBps ?? 5_000)");
    expect(tradeDetailSource).toContain("bps(-settings.stopLossBps)");
  });

  it("enables both deploy model catalogues with mutual exclusion", () => {
    expect(tradingConfig).toContain('label: "Primary model", type: "select", v: MODELS[0], options: MODELS, excludeValueOf: "fallback", showDisabledOption: true');
    expect(tradingConfig).toContain('label: "Fallback model", type: "select", v: MODELS[1], options: FALLBACKS, excludeValueOf: "primary", showDisabledOption: true');
    expect(tradingConfig).not.toContain("options: [MODELS[0]], disabled: true");
    expect(tradingConfig).not.toContain("options: [MODELS[1]], disabled: true");
  });

  it("uses the persisted TradFi v2 discriminator for USDT sizing and paid data", () => {
    expect(deploySource).toContain('settlementAsset: "USDT"');
    expect(deploySource).toContain("minEntryWei");
    expect(deploySource).toContain("capitalQuoteWei");
    expect(deploySource).toContain("cmcNewsEnabled");
    expect(deploySource).toContain("cmcTotalBudgetWei");
    expect(deploySource).toContain('capitalBnb={tradfiV2 ? ""');
    // The capital hint was dropped on operator ruling 2026-09-20 (TradFi deploy port).
    expect(deploySource).not.toContain("BNB relay fees are funded separately");
    expect(deploySource).not.toContain("platformFeeBps: 500");
    expect(hireTradeSource).not.toContain("platformFeeBps: 500");
    expect(hireTradeSource).toContain("preview.sizing.platformFeeBps");
  });
});
