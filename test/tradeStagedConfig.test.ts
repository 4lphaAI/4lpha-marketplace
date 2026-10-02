import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveTradeConfig } from "../src/ops/config.js";

it("C1 staged submit is off by default, exact true enables, garbage refuses", () => {
  assert.equal(resolveTradeConfig({}, { chainId: 56 }).stagedSubmit, false);
  assert.equal(resolveTradeConfig({ TRADE_STAGED_SUBMIT: "false" }, { chainId: 56 }).stagedSubmit, false);
  assert.equal(resolveTradeConfig({ TRADE_STAGED_SUBMIT: "true" }, { chainId: 56 }).stagedSubmit, true);
  assert.throws(() => resolveTradeConfig({ TRADE_STAGED_SUBMIT: "1" }, { chainId: 56 }), /TRADE_STAGED_SUBMIT/u);
});
