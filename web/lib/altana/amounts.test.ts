import { describe, expect, it } from "vitest";
import {
  DEPOSIT_FEE_MARGIN_BPS,
  NATIVE_TRANSFER_GAS,
  halfOfWei,
  maxDepositWei,
  transferFeeWei,
} from "./amounts";

const GWEI = 1_000_000_000n;

describe("deposit quick amounts", () => {
  it("prices a native transfer at 21000 gas with the margin applied", () => {
    const bare = GWEI * NATIVE_TRANSFER_GAS;
    expect(transferFeeWei({ gasPriceWei: GWEI, marginBps: 0n })).toBe(bare);
    expect(transferFeeWei({ gasPriceWei: GWEI })).toBe((bare * (10_000n + DEPOSIT_FEE_MARGIN_BPS)) / 10_000n);
    // The margin is real money, not a rounding artefact.
    expect(transferFeeWei({ gasPriceWei: GWEI })).toBeGreaterThan(bare);
  });

  it("leaves the fee behind so the transfer can actually pay for itself", () => {
    const balance = 10n ** 18n;
    const max = maxDepositWei({ balanceWei: balance, gasPriceWei: GWEI });
    expect(max).toBe(balance - transferFeeWei({ gasPriceWei: GWEI }));
    expect(max + transferFeeWei({ gasPriceWei: GWEI })).toBeLessThanOrEqual(balance);
  });

  it("never goes below zero when the balance cannot cover the fee", () => {
    expect(maxDepositWei({ balanceWei: 0n, gasPriceWei: GWEI })).toBe(0n);
    expect(maxDepositWei({ balanceWei: 1n, gasPriceWei: GWEI })).toBe(0n);
    expect(maxDepositWei({ balanceWei: 10n ** 18n, gasPriceWei: 10n ** 18n })).toBe(0n);
  });

  it("honours an explicit gas limit", () => {
    expect(transferFeeWei({ gasPriceWei: GWEI, gasLimit: 42_000n, marginBps: 0n }))
      .toBe(2n * transferFeeWei({ gasPriceWei: GWEI, gasLimit: NATIVE_TRANSFER_GAS, marginBps: 0n }));
  });

  it("halves a max and floors it", () => {
    expect(halfOfWei(10n ** 18n)).toBe(5n * 10n ** 17n);
    expect(halfOfWei(3n)).toBe(1n);
    expect(halfOfWei(0n)).toBe(0n);
    expect(halfOfWei(-5n)).toBe(0n);
  });
});
