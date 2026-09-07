import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paramsHash } from "../src/auth/canonical.js";
import { parseHireParams } from "../src/http/wire.js";
import { DEFAULT_TRADE_SETTINGS } from "../src/trade/settings.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";

describe("TRADING-AGENT R5/C29 hire wire", () => {
  it("keeps the shipped grid digest vector unchanged", () => {
    assert.equal(paramsHash("provisionAgent", {
      walletAddress: WALLET, token: TOKEN, capDayWei: "1053",
      openNativeBudgetWei: "1000", ttlSec: 3600, sizingPreset: "grid-v1",
    }), "0xfbdcee87d573991eac8797b97282dfd80c067af0f2268a9d7f9655308aea567b");
  });

  it("pins the strict trade-v1 digest vector", () => {
    const value = { walletAddress: WALLET, capDayWei: "30000000000000000",
      ttlSec: 604800, sizingPreset: "trade-v1", executionModel: "sigma",
      hireRunId: "11111111-1111-4111-8111-111111111111", autoGrant: true,
      settings: DEFAULT_TRADE_SETTINGS };
    assert.equal(parseHireParams(value).ok, true);
    assert.equal(paramsHash("provisionAgent", value),
      "0x99e963959b261dca90088cec859e2000d72b6e6908ae0b81a759da98aa64d736");
    assert.equal(parseHireParams({ ...value, template: "trade" }).ok, false);
  });
});
