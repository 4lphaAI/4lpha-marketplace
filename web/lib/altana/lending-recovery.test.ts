import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import {
  LENDING_RECOVERY_FEE_FLOOR_WEI,
  buildLendingRecoveryBatch,
  lendingRecoveryFeeFloorWei,
  lendingRecoveryShortfallBnb,
  lendingRecoveryShortfallWei,
  planLendingRecovery,
  readLendingReserve,
  type LendingReserveReading,
} from "./lending-recovery";
import { FIRST_ACTION_RESERVE_WEI, TOKEN_WITHDRAW_FEE_FLOOR_WEI } from "./withdraw";

const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255" as Address;
const USDT = "0x55d398326f99059fF775485246999027B3197955" as Address;
const ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14" as Address;
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address;
const WALLET = "0x2222222222222222222222222222222222222222" as Address;

const venue = { vUsdt: V_USDT, usdt: USDT, routerV3: ROUTER, wbnb: WBNB, swapFeeTier: 100 };

function reading(patch: Partial<LendingReserveReading> = {}): LendingReserveReading {
  return {
    kind: "read",
    blockNumber: 120_362_697n,
    readAtMs: 1_700_000_000_000,
    usdtBalance: 1_000_000_000_000_000_000n,          // 1 USDT idle
    vUsdtBalance: 140_000_000_000n,                    // vTokens (8 decimals)
    exchangeRateStored: 214_285_714_285_714_285_714_285_714n, // ~0.214e27 -> 30 USDT
    cash: 9_000_000_000_000_000_000_000n,              // deep pool
    nativeBalance: 10_000_000_000_000_000n,            // 0.01 BNB
    usdtAllowanceToRouter: 0n,
    walletHasCode: true,                               // B is registered
    ...patch,
  };
}

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;
const VTOKEN = [
  { type: "function", name: "redeemUnderlying", stateMutability: "nonpayable", inputs: [{ name: "redeemAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
const ROUTER_ABI = [
  {
    type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
] as const;

describe("planLendingRecovery", () => {
  it("values the supplied leg at the STORED rate — a lower bound, because xr only rises", () => {
    const plan = planLendingRecovery(reading());
    expect(plan.suppliedUsdtWei).toBe(29_999_999_999_999_999_999n);
    expect(plan.poolShort).toBe(false);
    expect(plan.remainderUsdtWei).toBe(0n);
  });

  // The pool bound is `getCash() - 1`, never `getCash()`: a redeem that asks for
  // exactly the cash is the one that reverts when another borrower lands in the
  // same block (§5.4).
  it("bounds the redeem by getCash() MINUS ONE, and reports the remainder", () => {
    const plan = planLendingRecovery(reading({ cash: 10_000_000_000_000_000_000n }));
    expect(plan.redeemAmountWei).toBe(9_999_999_999_999_999_999n);
    expect(plan.poolShort).toBe(true);
    expect(plan.remainderUsdtWei).toBe(20_000_000_000_000_000_000n);
    // The swap input is EXACT: idle + what was actually redeemed.
    expect(plan.swapInWei).toBe(1_000_000_000_000_000_000n + 9_999_999_999_999_999_999n);
  });

  it("an empty pool still recovers the idle leg", () => {
    const plan = planLendingRecovery(reading({ cash: 0n }));
    expect(plan.redeemAmountWei).toBe(0n);
    expect(plan.swapInWei).toBe(1_000_000_000_000_000_000n);
  });
});

describe("buildLendingRecoveryBatch", () => {
  const build = (patch: Partial<LendingReserveReading> = {}, minOutWei = 50_000_000_000_000_000n) =>
    buildLendingRecoveryBatch({
      reading: reading(patch), venue, wallet: WALLET, minOutWei, deadlineSec: 1_700_000_300n,
    });

  it("emits redeemUnderlying, the zero-reset, the EXACT approve and one router multicall", () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.calls).toHaveLength(4);

    const [redeem, zero, approve, router] = result.calls;
    expect(redeem!.to).toBe(V_USDT);
    expect(decodeFunctionData({ abi: VTOKEN, data: redeem!.data }).args)
      .toEqual([result.plan.redeemAmountWei]);

    // The zero-reset is UNCONDITIONAL — `buildPancakeV3Sell`'s own shape (R3.9).
    expect(zero!.to).toBe(USDT);
    expect(decodeFunctionData({ abi: ERC20, data: zero!.data }).args).toEqual([ROUTER, 0n]);

    // EXACT, never an upper bound: this is the approve the USDT day cap meters.
    expect(decodeFunctionData({ abi: ERC20, data: approve!.data }).args)
      .toEqual([ROUTER, result.plan.swapInWei]);

    expect(router!.to).toBe(ROUTER);
    expect(router!.value).toBe(0n);
    const outer = decodeFunctionData({ abi: ROUTER_ABI, data: router!.data });
    expect(outer.functionName).toBe("multicall");
    const inner = (outer.args as readonly (readonly Hex[])[])[0]!;
    expect(inner).toHaveLength(2);

    const swap = decodeFunctionData({ abi: ROUTER_ABI, data: inner[0]! });
    expect(swap.functionName).toBe("exactInputSingle");
    const params = (swap.args as readonly Record<string, unknown>[])[0]!;
    expect(params["tokenIn"]).toBe(USDT);
    expect(params["tokenOut"]).toBe(WBNB);
    expect(params["fee"]).toBe(100);
    // The ROUTER keeps the WBNB so `unwrapWETH9` can convert it. address(1)/(2)
    // are LITERAL recipients on this router and would strand the whole sell.
    expect(params["recipient"]).toBe(ROUTER);
    expect(params["amountIn"]).toBe(result.plan.swapInWei);
    expect(params["amountOutMinimum"]).toBe(50_000_000_000_000_000n);
    expect(params["sqrtPriceLimitX96"]).toBe(0n);
    expect(params["deadline"]).toBe(1_700_000_300n);

    const unwrap = decodeFunctionData({ abi: ROUTER_ABI, data: inner[1]! });
    expect(unwrap.functionName).toBe("unwrapWETH9");
    expect(unwrap.args).toEqual([50_000_000_000_000_000n, WALLET]);
  });

  it("omits redeemUnderlying entirely when the pool can pay nothing", () => {
    const result = build({ cash: 0n });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.calls).toHaveLength(3);
    expect(result.calls[0]!.to).toBe(USDT);
  });

  it("carries the POOL-SHORT partial rather than refusing (R3.12)", () => {
    const result = build({ cash: 10_000_000_000_000_000_000n });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.poolShort).toBe(true);
    expect(result.plan.remainderUsdtWei).toBe(20_000_000_000_000_000_000n);
  });

  it("refuses with no floor, with nothing to recover, and below the fee floor", () => {
    const noFloor = build({}, 0n);
    expect(noFloor.ok).toBe(false);
    if (!noFloor.ok) expect(noFloor.message).toContain("swap without a minimum");

    const empty = buildLendingRecoveryBatch({
      reading: reading({ usdtBalance: 0n, vUsdtBalance: 0n, cash: 0n }),
      venue, wallet: WALLET, minOutWei: 1n, deadlineSec: 1n,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain("nothing to recover");

    const broke = build({ nativeBalance: 1n });
    expect(broke.ok).toBe(false);
    if (!broke.ok) expect(broke.message).toContain("network fee");
  });

  // W4: the floor is IMPORTED from the withdrawal path, not restated. The old
  // local `3 × 60e12` was 3 × a fee nobody measured and refused recoveries a
  // real wallet could pay for.
  it("takes its fee floor from withdraw.ts, honours the unregistered tier, and states the shortfall in BNB", () => {
    expect(LENDING_RECOVERY_FEE_FLOOR_WEI).toBe(TOKEN_WITHDRAW_FEE_FLOOR_WEI);
    expect(LENDING_RECOVERY_FEE_FLOOR_WEI).toBe(3n * 38_800_000_000_000n);

    // Registered: three measured relay fees.
    expect(lendingRecoveryFeeFloorWei(true)).toBe(TOKEN_WITHDRAW_FEE_FLOOR_WEI);
    // Unregistered, AND unread — the first submission carries the 7702 setCode
    // preCall and the KeyStore registration, so both take the larger tier.
    expect(lendingRecoveryFeeFloorWei(false)).toBe(FIRST_ACTION_RESERVE_WEI);
    expect(lendingRecoveryFeeFloorWei(null)).toBe(FIRST_ACTION_RESERVE_WEI);

    expect(lendingRecoveryShortfallWei(0n, true)).toBe(TOKEN_WITHDRAW_FEE_FLOOR_WEI);
    expect(lendingRecoveryShortfallWei(TOKEN_WITHDRAW_FEE_FLOOR_WEI, true)).toBe(0n);
    expect(lendingRecoveryShortfallWei(10_000_000_000_000_000n, true)).toBe(0n);
    // A balance that clears the steady tier but NOT the first-action one.
    expect(lendingRecoveryShortfallWei(200_000_000_000_000n, false))
      .toBe(FIRST_ACTION_RESERVE_WEI - 200_000_000_000_000n);

    // BNB, never raw wei — this sentence exists so an owner knows what to send.
    expect(lendingRecoveryShortfallBnb(0n, true)).toBe("0.000116");
  });

  it("refuses an UNREGISTERED wallet that a registered one could pay for, and says both figures in BNB", () => {
    const registered = build({ nativeBalance: 500_000_000_000_000n, walletHasCode: true });
    expect(registered.ok).toBe(true);

    const unregistered = build({ nativeBalance: 500_000_000_000_000n, walletHasCode: false });
    expect(unregistered.ok).toBe(false);
    if (unregistered.ok) return;
    expect(unregistered.message).toContain("0.0015 BNB");
    expect(unregistered.message).toContain("first on-chain action costs more");
    expect(unregistered.message).toContain("holds 0.0005 BNB");
    expect(unregistered.message).toContain("Deposit 0.001 BNB");
    // Never raw wei.
    expect(unregistered.message).not.toContain("000000000000");
  });
});

// W9: R2.5 computes the whole plan from ONE pinned FINALIZED read. `latest` can
// be reorged out from under a batch about to spend the entire reserve, and legs
// read at different heights can ask to redeem more than the pool held.
describe("readLendingReserve", () => {
  const WALLET_B = WALLET;

  function fakeClient(overrides: Record<string, unknown> = {}) {
    const blockTags: unknown[] = [];
    const blocks: (bigint | undefined)[] = [];
    const client = {
      getBlock: async (args: { blockTag?: string }) => {
        blockTags.push(args.blockTag);
        return { number: 120_362_697n };
      },
      getBlockNumber: async () => { throw new Error("must not read an unpinned head"); },
      getCode: async (args: { blockNumber?: bigint }) => { blocks.push(args.blockNumber); return "0xef0100"; },
      getBalance: async (args: { blockNumber?: bigint }) => { blocks.push(args.blockNumber); return 10_000_000_000_000_000n; },
      readContract: async (args: { functionName: string; blockNumber?: bigint }) => {
        blocks.push(args.blockNumber);
        return args.functionName === "exchangeRateStored" ? 2n * 10n ** 26n : 1_000_000_000_000_000_000n;
      },
      ...overrides,
    } as unknown as Parameters<typeof readLendingReserve>[0];
    return { client, blockTags, blocks };
  }

  it("pins every leg to ONE finalized block", async () => {
    const { client, blockTags, blocks } = fakeClient();
    const read = await readLendingReserve(client, { wallet: WALLET_B, vUsdt: V_USDT, usdt: USDT, routerV3: ROUTER });
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(blockTags).toEqual(["finalized"]);
    expect(read.blockNumber).toBe(120_362_697n);
    // balance, allowance, exchangeRateStored, getCash, the vToken balance AND
    // the code read — all seven at the same height, none at `latest`.
    expect(blocks).toHaveLength(7);
    expect(new Set(blocks)).toEqual(new Set([120_362_697n]));
    expect(read.walletHasCode).toBe(true);
  });

  it("is unavailable — never silently latest — when the finalized block cannot be read", async () => {
    const { client } = fakeClient({ getBlock: async () => { throw new Error("no finalized tag"); } });
    const read = await readLendingReserve(client, { wallet: WALLET_B, vUsdt: V_USDT, usdt: USDT, routerV3: ROUTER });
    expect(read).toEqual({ kind: "unavailable", reason: "cannot read the finalized block" });
  });

  it("treats an unreadable code state as UNKNOWN, which takes the larger fee tier", async () => {
    const { client } = fakeClient({ getCode: async () => { throw new Error("no"); } });
    const read = await readLendingReserve(client, { wallet: WALLET_B, vUsdt: V_USDT, usdt: USDT, routerV3: ROUTER });
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.walletHasCode).toBeNull();
    expect(lendingRecoveryFeeFloorWei(read.walletHasCode)).toBe(FIRST_ACTION_RESERVE_WEI);
  });
});
