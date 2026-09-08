import { describe, expect, it } from "vitest";
import type { LendingGuardableView } from "@/lib/exec/lending-types";
import { suggestLendingRepay } from "./repay-suggestion";

const ACCOUNT = "0x3333333333333333333333333333333333333333";
const E18 = 10n ** 18n;
const view = {
  account: ACCOUNT, guardable: true,
  debts: [
    { supported: true, borrowWei: (8n * E18).toString(), debtValueMantissa: "8000490000000000000" },
    { supported: false, borrowWei: E18.toString(), debtValueMantissa: (900n * E18).toString() },
  ],
} as unknown as LendingGuardableView;
const base = { account: ACCOUNT, view, loading: false, capitalWei: 2n * 10n ** 16n, priceMicros: 750_000_000n };

describe("repay suggestion from supported debt and capital", () => {
  it("floors the smaller supported debt to cents", () => {
    expect(suggestLendingRepay(base)).toBe("8.00");
  });
  it("uses total capital when it is smaller, with correct BNB/USD units", () => {
    expect(suggestLendingRepay({ ...base, capitalWei: 5n * 10n ** 15n })).toBe("3.75");
  });
  it("adds supported positive debts, not zero-borrow rows", () => {
    expect(suggestLendingRepay({ ...base, view: { ...view, debts: [...view.debts, { ...view.debts[0]!, debtValueMantissa: (2n * E18).toString() }, { ...view.debts[0]!, borrowWei: "0" }] } })).toBe("10.00");
  });
  it("provides no fixed fallback for unavailable or mismatched facts", () => {
    for (const patch of [{ view: null }, { loading: true }, { priceMicros: null }, { capitalWei: 0n }, { account: "other" }, { view: { ...view, guardable: false } }]) {
      expect(suggestLendingRepay({ ...base, ...patch })).toBeNull();
    }
  });
  it("does not round dust up or invent supported debt", () => {
    expect(suggestLendingRepay({ ...base, capitalWei: 1n })).toBeNull();
    expect(suggestLendingRepay({ ...base, view: { ...view, debts: [] } })).toBeNull();
  });
});
