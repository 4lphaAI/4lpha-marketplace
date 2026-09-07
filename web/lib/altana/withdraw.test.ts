/**
 * The two ways a withdrawal loses money without any chain error: emptying the
 * wallet below what its next action costs, and sending somewhere unspendable.
 * Both are pure functions, so both are pinned here.
 */
import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import {
  FIRST_ACTION_RESERVE_BNB,
  FIRST_ACTION_RESERVE_WEI,
  STEADY_RESERVE_BNB,
  STEADY_RESERVE_WEI,
  withdrawReserveNote,
  withdrawReserveWei,
  ZERO_ADDRESS,
  canWithdraw,
  formatAtomic,
  formatBnb,
  maxTokenWithdrawAtomic,
  maxWbnbWithdrawWei,
  maxWithdrawWei,
  MEASURED_RELAY_FEE_WEI,
  parseTokenAddress,
  TOKEN_WITHDRAW_FEE_FLOOR_WEI,
  tokenWithdrawShortfallWei,
  validateAmount,
  validateDestination,
  validateTokenAmount,
  validateWbnbAmount,
} from "./withdraw";

const OWNER_IDENTITY = "0xBBD8DB1b3Ed8E84f2b1F14B5A7b034632eD76aaE";
const WALLET_A = "0x4444444444444444444444444444444444444444";

describe("the gas reserve", () => {
  it("is at least three times the measured mainnet relay fee per submission", () => {
    // LP_RELAY_FEE_PER_SUBMIT_WEI, measured over 10 real submissions.
    expect(FIRST_ACTION_RESERVE_WEI).toBeGreaterThanOrEqual(3n * 38_800_000_000_000n);
  });

  it("also covers the first action's on-chain KeyStore registration (~0.001 BNB)", () => {
    expect(FIRST_ACTION_RESERVE_WEI).toBeGreaterThanOrEqual(parseEther("0.001"));
  });

  it("states the same number in the UI as it enforces, in both tiers", () => {
    expect(parseEther(FIRST_ACTION_RESERVE_BNB)).toBe(FIRST_ACTION_RESERVE_WEI);
    expect(parseEther(STEADY_RESERVE_BNB)).toBe(STEADY_RESERVE_WEI);
  });

  it("keeps the steady tier above the measured relay submit and below the first-action tier", () => {
    expect(STEADY_RESERVE_WEI).toBeGreaterThanOrEqual(3n * 38_800_000_000_000n);
    expect(STEADY_RESERVE_WEI).toBeLessThan(FIRST_ACTION_RESERVE_WEI);
  });

  it("resolves an unknown registration state to the LARGER reserve, never the smaller", () => {
    expect(withdrawReserveWei({ registered: true })).toBe(STEADY_RESERVE_WEI);
    expect(withdrawReserveWei({ registered: false })).toBe(FIRST_ACTION_RESERVE_WEI);
    expect(withdrawReserveWei({ registered: null })).toBe(FIRST_ACTION_RESERVE_WEI);
    expect(withdrawReserveWei({})).toBe(FIRST_ACTION_RESERVE_WEI);
    expect(withdrawReserveWei()).toBe(FIRST_ACTION_RESERVE_WEI);
  });

  it("names the tier it is charging for", () => {
    expect(withdrawReserveNote({ registered: true })).toBe(`keeps ${STEADY_RESERVE_BNB} BNB for network fees`);
    expect(withdrawReserveNote({ registered: null })).toBe(`keeps ${FIRST_ACTION_RESERVE_BNB} BNB for the first-time network fee`);
  });
});

describe("maxWithdrawWei", () => {
  it("leaves the reserve behind", () => {
    expect(maxWithdrawWei(parseEther("1"))).toBe(parseEther("1") - FIRST_ACTION_RESERVE_WEI);
  });

  it("floors at zero rather than going negative", () => {
    expect(maxWithdrawWei(0n)).toBe(0n);
    expect(maxWithdrawWei(FIRST_ACTION_RESERVE_WEI - 1n)).toBe(0n);
    expect(maxWithdrawWei(FIRST_ACTION_RESERVE_WEI)).toBe(0n);
    expect(canWithdraw(FIRST_ACTION_RESERVE_WEI)).toBe(false);
    expect(canWithdraw(FIRST_ACTION_RESERVE_WEI + 1n)).toBe(true);
  });

  it("leaves the smaller reserve once the wallet has code", () => {
    expect(maxWithdrawWei(parseEther("1"), { registered: true })).toBe(parseEther("1") - STEADY_RESERVE_WEI);
    // A balance between the two tiers is withdrawable only for a registered
    // wallet — and the unknown state takes the strict answer.
    const between = STEADY_RESERVE_WEI + 1n;
    expect(canWithdraw(between, { registered: true })).toBe(true);
    expect(canWithdraw(between, { registered: false })).toBe(false);
    expect(canWithdraw(between, { registered: null })).toBe(false);
  });
});

describe("formatBnb", () => {
  it("writes plain decimals, never exponents", () => {
    expect(formatBnb(parseEther("1.5"))).toBe("1.5");
    expect(formatBnb(parseEther("0.0015"))).toBe("0.0015");
    expect(formatBnb(0n)).toBe("0");
    expect(formatBnb(parseEther("12345"))).toBe("12345");
  });

  it("truncates rather than rounds up, so a rendered max is never over the max", () => {
    const max = maxWithdrawWei(parseEther("1"));
    expect(parseEther(formatBnb(max))).toBeLessThanOrEqual(max);
    expect(formatBnb(1n)).toBe("0");
  });
});

describe("validateDestination", () => {
  it("accepts and checksums a normal address", () => {
    const result = validateDestination({ to: WALLET_A.toLowerCase() });
    expect(result).toEqual({ value: WALLET_A });
  });

  it("refuses an empty, malformed, or zero destination", () => {
    expect(validateDestination({ to: "   " })).toHaveProperty("error");
    expect(validateDestination({ to: "not-an-address" })).toHaveProperty("error");
    const zero = validateDestination({ to: ZERO_ADDRESS });
    expect("error" in zero && zero.error).toMatch(/burns funds/u);
  });

  it("refuses the passkey owner identity by name, in any case", () => {
    for (const form of [OWNER_IDENTITY, OWNER_IDENTITY.toLowerCase()]) {
      const result = validateDestination({ to: form, passkeyOwnerAddress: OWNER_IDENTITY });
      expect("error" in result && result.error).toMatch(/owner identity/u);
    }
  });

  it("allows the agent wallet itself — pointless, not destructive", () => {
    const wallet = "0x3333333333333333333333333333333333333333";
    expect(validateDestination({ to: wallet, walletAddress: wallet, passkeyOwnerAddress: OWNER_IDENTITY }))
      .toEqual({ value: wallet });
  });
});

describe("validateAmount", () => {
  const available = parseEther("1");

  it("accepts an amount inside the max", () => {
    expect(validateAmount({ raw: "0.5", availableWei: available })).toEqual({ value: parseEther("0.5") });
  });

  it("accepts exactly the max and refuses one wei more", () => {
    const max = maxWithdrawWei(available);
    expect(validateAmount({ raw: formatBnb(max, 18), availableWei: available })).toEqual({ value: max });
    const over = validateAmount({ raw: formatBnb(max + 1n, 18), availableWei: available });
    expect("error" in over && over.error).toMatch(/most you can withdraw/u);
  });

  it("refuses the whole balance, which is what would strand the wallet", () => {
    const all = validateAmount({ raw: "1", availableWei: available });
    expect("error" in all && all.error).toMatch(/network fees/u);
  });

  it("refuses empty, malformed, and non-positive amounts", () => {
    expect(validateAmount({ raw: "", availableWei: available })).toHaveProperty("error");
    expect(validateAmount({ raw: "1,5", availableWei: available })).toHaveProperty("error");
    expect(validateAmount({ raw: "1e18", availableWei: available })).toHaveProperty("error");
    expect(validateAmount({ raw: "0", availableWei: available })).toHaveProperty("error");
  });

  it("says there is nothing to withdraw when the balance is under the reserve", () => {
    const result = validateAmount({ raw: "0.0001", availableWei: FIRST_ACTION_RESERVE_WEI });
    expect("error" in result && result.error).toMatch(/nothing to withdraw/u);
  });
});

describe("withdrawing WBNB", () => {
  // The live 2026-09-03 wallet: 0.0073 BNB native, 0.007 WBNB left by an exit.
  const nativeWei = 7_342_775_080_500_685n;
  const wbnbWei = 7_000_000_000_000_000n;

  it("is bounded by the WBNB balance alone once native covers the fee reserve", () => {
    expect(maxWbnbWithdrawWei({ wbnbWei, nativeWei, registered: true })).toBe(wbnbWei);
    expect(validateWbnbAmount({ raw: "0.007", wbnbWei, nativeWei, registered: true })).toEqual({ value: wbnbWei });
  });

  it("refuses when the wallet cannot pay for the unwrap in BNB, whatever WBNB it holds", () => {
    expect(maxWbnbWithdrawWei({ wbnbWei, nativeWei: TOKEN_WITHDRAW_FEE_FLOOR_WEI - 1n, registered: true })).toBe(0n);
    const refused = validateWbnbAmount({ raw: "0.001", wbnbWei, nativeWei: 0n, registered: true });
    expect("error" in refused && refused.error).toContain("network fee");
    // An unregistered wallet is charged the first-action tier: its first submission
    // really does carry the setCode preCall and the KeyStore registration.
    expect(maxWbnbWithdrawWei({ wbnbWei, nativeWei: STEADY_RESERVE_WEI, registered: null })).toBe(0n);
  });

  it("refuses more than the wallet holds and a wallet with no WBNB at all", () => {
    const over = validateWbnbAmount({ raw: "0.0071", wbnbWei, nativeWei, registered: true });
    expect("error" in over && over.error).toContain("0.007 WBNB");
    const none = validateWbnbAmount({ raw: "0.001", wbnbWei: 0n, nativeWei, registered: true });
    expect("error" in none && none.error).toContain("no WBNB");
  });
});

describe("withdrawing a token that is not BNB", () => {
  // The live 2026-09-03 wallet after Remove: the exit's freed BTCB leg plus an
  // older idle buffer, stranded because no session survives a revoked agent.
  const nativeWei = 7_342_775_080_500_685n;
  const btcb = { balanceAtomic: 88_852_141_410_136n, decimals: 18, symbol: "BTCB" };

  it("offers the whole token balance once BNB covers the fee, and refuses when it does not", () => {
    expect(maxTokenWithdrawAtomic({ ...btcb, nativeWei, registered: true })).toBe(btcb.balanceAtomic);
    expect(maxTokenWithdrawAtomic({ ...btcb, nativeWei: 0n, registered: true })).toBe(0n);
    expect(validateTokenAmount({ raw: "0.000088852141410136", ...btcb, nativeWei, registered: true })).toEqual({ value: btcb.balanceAtomic });
  });

  it("charges the FEE, not the standing reserve — the 2026-09-03 stranding", () => {
    // The wallet after withdrawing BNB and WBNB: 0.00015538 BNB left, which is
    // four relay submissions and was refused because it is under the 0.0002
    // reserve. A reserve is about the wallet's next action; a token transfer
    // only has to pay for THIS one.
    const stranded = 155_384_900_000_000n;
    expect(stranded).toBeLessThan(STEADY_RESERVE_WEI);
    expect(stranded / MEASURED_RELAY_FEE_WEI).toBeGreaterThanOrEqual(4n);
    expect(maxTokenWithdrawAtomic({ ...btcb, nativeWei: stranded, registered: true })).toBe(btcb.balanceAtomic);
    expect(tokenWithdrawShortfallWei({ nativeWei: stranded, registered: true })).toBe(0n);
    expect(validateTokenAmount({ raw: "0.00008", ...btcb, nativeWei: stranded, registered: true })).toEqual({ value: 80_000_000_000_000n });
    // The floor is still real, and the shortfall says exactly what to deposit.
    const short = TOKEN_WITHDRAW_FEE_FLOOR_WEI - 1n;
    expect(tokenWithdrawShortfallWei({ nativeWei: short, registered: true })).toBe(1n);
    expect(maxTokenWithdrawAtomic({ ...btcb, nativeWei: short, registered: true })).toBe(0n);
  });

  it("names the token in every refusal, and never rounds an amount the token cannot express", () => {
    const over = validateTokenAmount({ raw: "0.0001", ...btcb, nativeWei, registered: true });
    expect("error" in over && over.error).toContain("0.000088 BTCB");
    const empty = validateTokenAmount({ raw: "1", ...btcb, balanceAtomic: 0n, nativeWei, registered: true });
    expect("error" in empty && empty.error).toContain("no BTCB");
    const fee = validateTokenAmount({ raw: "0.00001", ...btcb, nativeWei: 0n, registered: true });
    expect("error" in fee && fee.error).toContain("deposit 0.0001164 BNB");
    // A 6-decimal token cannot carry 18 decimal places, and rounding it silently
    // would send a different amount than the one on screen.
    const tooPrecise = validateTokenAmount({ raw: "1.0000001", balanceAtomic: 10n ** 9n, decimals: 6, symbol: "USDT", nativeWei, registered: true });
    expect("error" in tooPrecise && tooPrecise.error).toContain("6 decimals");
    expect(validateTokenAmount({ raw: "1.000001", balanceAtomic: 10n ** 9n, decimals: 6, symbol: "USDT", nativeWei, registered: true })).toEqual({ value: 1_000_001n });
  });

  it("formats atomic balances at their own decimals", () => {
    expect(formatAtomic(1_000_001n, 6)).toBe("1.000001");
    expect(formatAtomic(88_852_141_410_136n, 18)).toBe("0.000088");
    expect(formatAtomic(88_852_141_410_136n, 18, 18)).toBe("0.000088852141410136");
    expect(formatAtomic(0n, 18)).toBe("0");
  });
});

describe("withdrawing a token by address", () => {
  it("accepts any checksummed BEP-20 address and refuses only what cannot be a token", () => {
    expect(parseTokenAddress("  0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c ")).toEqual({ value: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" });
    expect("error" in parseTokenAddress("")).toBe(true);
    expect("error" in parseTokenAddress("0xnope")).toBe(true);
    expect("error" in parseTokenAddress(ZERO_ADDRESS)).toBe(true);
  });
});
