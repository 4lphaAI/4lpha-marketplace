import assert from "node:assert/strict";
import { it } from "node:test";
import type { QuantRebalanceActionRow } from "../src/quant/rebalanceTypes.js";
import { buildQuantRebalanceReportPayload } from "../src/quant/rebalanceReporting.js";

it("keeps verified fill quantities out of the TermiX report annotation payload", () => {
  const action = {
    state: "settled", txHash: `0x${"ab".repeat(32)}`, side: "buy", asset: "WBNB",
    fillInWei: 987_654_321_098_765_432_109n, fillOutWei: 123_456_789_012_345_678_901n,
  } as unknown as QuantRebalanceActionRow;
  const payload = buildQuantRebalanceReportPayload([action]);
  assert.deepEqual(payload.trades, [{ txHash: action.txHash, note: "buy:WBNB" }]);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /987654321098765432109|123456789012345678901/u);
});
