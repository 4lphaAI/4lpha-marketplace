import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { quantRebalanceReceiptWithinSubmitWindow } from "../scripts/quantRebalanceWorkerDeps.js";

const HASH_A = `0x${"aa".repeat(32)}` as Hex;
const HASH_B = `0x${"bb".repeat(32)}` as Hex;

describe("Quant rebalancing receipt execution window", () => {
  it("requires the persisted canonical submit ancestor and includes the deadline boundary", () => {
    const action = { preSubmitBlockNumber: 100n, preSubmitBlockHash: HASH_A, deadlineSec: 1_800_000_100 };
    const base = { action, receiptBlockNumber: 101n, receiptTimestampSec: 1_800_000_100n,
      submitAncestorNumber: 100n, submitAncestorHash: HASH_A };
    assert.equal(quantRebalanceReceiptWithinSubmitWindow(base), true);
    assert.equal(quantRebalanceReceiptWithinSubmitWindow({ ...base, receiptTimestampSec: 1_800_000_101n }), false);
    assert.equal(quantRebalanceReceiptWithinSubmitWindow({ ...base, receiptBlockNumber: 99n }), false);
    assert.equal(quantRebalanceReceiptWithinSubmitWindow({ ...base, submitAncestorHash: HASH_B }), false);
    assert.equal(quantRebalanceReceiptWithinSubmitWindow({ ...base, submitAncestorNumber: 99n }), false);
    assert.equal(quantRebalanceReceiptWithinSubmitWindow({ ...base,
      action: { ...action, preSubmitBlockNumber: null } }), false);
  });
});
