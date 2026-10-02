/**
 * The DCA receipt verifier (AUTO-DCA R2.3 "Anchor and receipt", R2.21
 * "Receipt"; REVIEW2 N12/N13, condition 11) and the ownership prefix it shares
 * with the v2 verifier (R2.3 item 5).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import type { WalletCall } from "../src/core/types.js";
import { hashCalls } from "../src/http/wire.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { buildTradfiApprove, buildTradfiPancakeV3Swap } from "../src/ops/tradfi.js";
import { PANCAKE_V3_ROUTER_56 } from "../src/ops/venues.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { buildTradfiGuardSwapCall, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { dcaBatchCalls, dcaPoolForToken, dcaPoolLegs, dcaPriceAtTick, planDcaFill, planDcaStart, type DcaBatchPlan, type DcaPool, type DcaSwapLeg } from "../src/trade/dca.js";
import {
  DCA_NFPM_COLLECT_TOPIC,
  DCA_NFPM_DECREASE_TOPIC,
  verifyDcaReceipt,
  verifyTradfiV2Receipt,
  verifyWalletIntentOwnership,
  type DcaReceiptExpected,
} from "../src/trade/receipt.js";
import { E18, GUARD, KEY, NV, NV_TICK, OUTSIDER, TREASURY, WALLET, dcaObservation, nfpmLog, nfpmMintLog, planLogs, transferLog } from "./support/dcaFixtures.js";

const READING = { block: 100n, tick: NV_TICK, sqrtPriceX96: getSqrtRatioAtTick(NV_TICK) };
const DEADLINE = 1_900_000_120n;
const CALLDATA = "0xad43f73d0000" as Hex;
const MIN_OUT = 66_000_000_000_000_000n;

function guardLeg(): DcaSwapLeg {
  const calls = [...buildTradfiApprove(USDT_56, GUARD, 15n * E18), buildTradfiGuardSwapCall({ guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56, tokenIn: USDT_56, tokenOut: NV.stock, amountInWei: 15n * E18,
    minOutWei: MIN_OUT, deadline: DEADLINE, calldata: CALLDATA })];
  return { side: "buy", amountInWei: 15n * E18, minOutWei: MIN_OUT, quotedOutWei: 67_000_000_000_000_000n, calls,
    guard: { address: GUARD, calldata: CALLDATA, deadlineSec: DEADLINE } };
}

function directLeg(): DcaSwapLeg {
  const calls = buildTradfiPancakeV3Swap({ router: PANCAKE_V3_ROUTER_56, tokenIn: USDT_56, tokenOut: NV.stock, amountInWei: 15n * E18,
    minOutWei: MIN_OUT, recipient: WALLET, deadline: DEADLINE, route: { hops: [], fees: [2500] } });
  return { side: "buy", amountInWei: 15n * E18, minOutWei: MIN_OUT, quotedOutWei: 67_000_000_000_000_000n, calls };
}

const LADDER = { stepBps: 100, maxOrders: 4, orderWei: 10n * E18, rangeMinE8: null };

function startPlan(swap: DcaSwapLeg): DcaBatchPlan {
  return planDcaStart({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE, swap, feeWei: 150_000_000_000_000_000n,
    carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "r1:tp:100", ladder: LADDER });
}

function expectedFor(plan: DcaBatchPlan, calls: readonly WalletCall[], stock = NV.stock, pool: DcaPool = NV): DcaReceiptExpected {
  const legs = dcaPoolLegs(pool);
  return { wallet: WALLET, sessionPublicKey: KEY, sessionGeneration: 0, callsHash: hashCalls(calls), calls, nfpm: NFPM_56, pool: pool.pool,
    token0: legs.token0, token1: legs.token1, stock, exits: plan.exits, mints: plan.mints, feeAtomic: plan.feeWei, feeTreasury: TREASURY,
    swap: plan.swap === null ? null : { side: plan.swap.side, amountInAtomic: plan.swap.amountInWei, minOutAtomic: plan.swap.minOutWei,
      ...(plan.swap.guard === undefined ? {} : { guard: { address: plan.swap.guard.address, calldata: plan.swap.guard.calldata } }) } };
}

function callsOf(plan: DcaBatchPlan, pool: DcaPool = NV): readonly WalletCall[] {
  return dcaBatchCalls(plan, { pool, nfpm: NFPM_56, wallet: WALLET, treasury: TREASURY });
}

describe("the DCA receipt verifier", () => {
  it("accepts a guard start: guard legs + fee + the TP mint, and derives P0 from the legs", () => {
    const plan = startPlan(guardLeg());
    const calls = callsOf(plan);
    const verdict = verifyDcaReceipt({ observation: dcaObservation(calls, planLogs(plan, NV, { firstTokenId: 7_001n, swapOutWei: 67_000_000_000_000_000n })),
      expected: expectedFor(plan, calls) });
    assert.ok(verdict.ok, verdict.ok ? "" : verdict.code);
    assert.deepEqual(verdict.evidence.swap, { inputAtomic: 15n * E18, outputAtomic: 67_000_000_000_000_000n });
    assert.equal(verdict.evidence.mints.length, 3, "R3.3: the TP and the two start levels");
    assert.equal(verdict.evidence.mints[0]!.tokenId, 7_001n);
    assert.equal(verdict.evidence.mints[0]!.amount0, MIN_OUT); // stock = token0 on NVDAB; the TP deposits minOut
  });

  it("accepts a direct-route start on the pinned pool: the swap and the TP deposit are told apart by direction", () => {
    const plan = startPlan(directLeg());
    assert.equal(plan.swap!.calls.length, 3, "the direct leg is the TradFi builder's three calls and nothing more (condition 11)");
    const calls = callsOf(plan);
    const verdict = verifyDcaReceipt({ observation: dcaObservation(calls, planLogs(plan, NV, { firstTokenId: 9n, swapOutWei: 70_000_000_000_000_000n })),
      expected: expectedFor(plan, calls) });
    assert.ok(verdict.ok, verdict.ok ? "" : verdict.code);
    assert.equal(verdict.evidence.swap!.outputAtomic, 70_000_000_000_000_000n);
  });

  it("refuses an unexplained USDT transfer touching the wallet (receipt-contaminated)", () => {
    const plan = startPlan(guardLeg());
    const calls = callsOf(plan);
    const logs = [...planLogs(plan, NV, { firstTokenId: 7_001n }), transferLog(USDT_56, WALLET, OUTSIDER, 1n)];
    const verdict = verifyDcaReceipt({ observation: dcaObservation(calls, logs), expected: expectedFor(plan, calls) });
    assert.deepEqual(verdict, { ok: false, code: "receipt-contaminated" });
  });

  it("keeps receipt-transfer-ambiguous for a malformed counted transfer", () => {
    const plan = startPlan(guardLeg());
    const calls = callsOf(plan);
    const logs = [...planLogs(plan, NV, { firstTokenId: 7_001n }), { ...transferLog(USDT_56, WALLET, OUTSIDER, 1n), data: "0x01" as Hex }];
    assert.deepEqual(verifyDcaReceipt({ observation: dcaObservation(calls, logs), expected: expectedFor(plan, calls) }),
      { ok: false, code: "receipt-transfer-ambiguous" });
  });

  it("refuses a stock equal to USDT", () => {
    const plan = startPlan(guardLeg());
    const calls = callsOf(plan);
    assert.deepEqual(verifyDcaReceipt({ observation: dcaObservation(calls, planLogs(plan, NV, { firstTokenId: 1n })), expected: expectedFor(plan, calls, USDT_56) }),
      { ok: false, code: "receipt-amount-mismatch" });
  });

  it("refuses a mint deposit that is not the planned single leg, and a missing mint", () => {
    const plan = startPlan(guardLeg());
    const calls = callsOf(plan);
    const logs = planLogs(plan, NV, { firstTokenId: 7_001n }).filter((log) => !(log.address === NFPM_56 && log.topics.length === 4));
    assert.deepEqual(verifyDcaReceipt({ observation: dcaObservation(calls, logs), expected: expectedFor(plan, calls) }),
      { ok: false, code: "receipt-legs-missing" });
  });

  it("M-4: an unnamed NFPM effect, a mint to a foreign address, and a swap output under minOut on either leg are refused", () => {
    const verdict = (plan: DcaBatchPlan, logs: ReturnType<typeof planLogs>) => {
      const calls = callsOf(plan);
      return verifyDcaReceipt({ observation: dcaObservation(calls, logs), expected: expectedFor(plan, calls) });
    };
    const guarded = startPlan(guardLeg());
    const good = planLogs(guarded, NV, { firstTokenId: 7_001n });
    assert.deepEqual(verdict(guarded, [...good, nfpmLog(DCA_NFPM_DECREASE_TOPIC, 42n, 1n, 0n, 0n)]), { ok: false, code: "receipt-contaminated" }); // V2
    assert.deepEqual(verdict(guarded, [...good, nfpmMintLog(7_002n, OUTSIDER)]), { ok: false, code: "receipt-contaminated" }); // V4
    assert.deepEqual(verdict(guarded, planLogs(guarded, NV, { firstTokenId: 7_001n, swapOutWei: MIN_OUT - 1n })), { ok: false, code: "receipt-guard-event-mismatch" }); // V5
    const direct = startPlan(directLeg());
    assert.deepEqual(verdict(direct, planLogs(direct, NV, { firstTokenId: 9n, swapOutWei: MIN_OUT - 1n })), { ok: false, code: "receipt-legs-missing" }); // V6
  });

  it("14. a start with [TP, L1, L2] verifies on the guard and the direct leg, both orientations, including B = D", () => {
    const SPY = dcaPoolForToken("0x7138b48df7d98d7e3cc221bfe7192d0a178182d8")!;
    for (const [pool, tick] of [[NV, NV_TICK], [SPY, -66_445]] as const) {
      const mid = dcaPriceAtTick(pool, tick);
      for (const amountInWei of [15n * E18, 10n * E18]) { // B = D = 10 on the second pass: three equal wallet → pool USDT transfers on the direct leg
        const quotedOutWei = amountInWei * mid.den / mid.num;
        const minOutWei = quotedOutWei * 99n / 100n;
        const direct = buildTradfiPancakeV3Swap({ router: PANCAKE_V3_ROUTER_56, tokenIn: USDT_56, tokenOut: pool.stock, amountInWei,
          minOutWei, recipient: WALLET, deadline: DEADLINE, route: { hops: [], fees: [pool.fee] } });
        const guarded = [...buildTradfiApprove(USDT_56, GUARD, amountInWei), buildTradfiGuardSwapCall({ guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56,
          spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56, tokenIn: USDT_56, tokenOut: pool.stock, amountInWei, minOutWei, deadline: DEADLINE, calldata: CALLDATA })];
        for (const leg of [{ side: "buy" as const, amountInWei, minOutWei, quotedOutWei, calls: direct },
          { side: "buy" as const, amountInWei, minOutWei, quotedOutWei, calls: guarded, guard: { address: GUARD, calldata: CALLDATA, deadlineSec: DEADLINE } }]) {
          const plan = planDcaStart({ pool, roundNo: 1, reading: { block: 100n, tick, sqrtPriceX96: getSqrtRatioAtTick(tick) }, deadlineSec: DEADLINE,
            swap: leg, feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "r1:tp:100", ladder: LADDER });
          assert.deepEqual(plan.mints.map((mint) => mint.role), ["tp", "level", "level"]);
          const calls = callsOf(plan, pool);
          const verdict = verifyDcaReceipt({ observation: dcaObservation(calls, planLogs(plan, pool, { firstTokenId: 40n, swapOutWei: minOutWei + 1n })),
            expected: expectedFor(plan, calls, pool.stock, pool) });
          assert.ok(verdict.ok, `${pool.symbol} B=${amountInWei} ${leg.calls === direct ? "direct" : "guard"}: ${verdict.ok ? "" : verdict.code}`);
          assert.deepEqual(verdict.evidence.mints.map((mint) => mint.tokenId), [40n, 41n, 42n]);
          assert.equal(verdict.evidence.swap!.outputAtomic, minOutWei + 1n);
        }
      }
    }
  });

  it("an exit must collect to the wallet: a foreign Collect recipient is refused", () => {
    const tp = { orderKey: "r1:tp:1", role: "tp" as const, levelNo: null, tokenId: 5n, tickLower: 54_400, tickUpper: 54_450,
      liquidity: 1_000_000_000_000_000n };
    const level = { orderKey: "r1:l1", role: "level" as const, levelNo: 1, tokenId: 6n, tickLower: 53_900, tickUpper: 53_950,
      liquidity: 2_000_000_000_000_000n, mintedUsdtWei: 10n * E18 };
    const filledReading = { block: 200n, tick: 53_880, sqrtPriceX96: getSqrtRatioAtTick(53_880) };
    const plan = planDcaFill({ pool: NV, roundNo: 1, reading: filledReading, deadlineSec: DEADLINE, filled: [level], oldTp: tp,
      ledger: { costUsdtWei: 15n * E18, stockAcquiredWei: MIN_OUT }, walletRoundStockWei: 0n, takeProfitBps: 150,
      tpOrderKey: "r1:tp:200", nextLevels: [], orderWei: 10n * E18 });
    const calls = callsOf(plan);
    const good = planLogs(plan, NV, { firstTokenId: 50n });
    const ok = verifyDcaReceipt({ observation: dcaObservation(calls, good), expected: expectedFor(plan, calls) });
    assert.ok(ok.ok, ok.ok ? "" : ok.code);
    assert.equal(ok.evidence.exits.length, 2);
    const foreign = good.map((log) => log.topics[0]?.toLowerCase() === DCA_NFPM_COLLECT_TOPIC && BigInt(log.topics[1]!) === 6n
      ? nfpmLog(DCA_NFPM_COLLECT_TOPIC, 6n, OUTSIDER, plan.exits[0]!.amount0Min, plan.exits[0]!.amount1Min) : log);
    assert.deepEqual(verifyDcaReceipt({ observation: dcaObservation(calls, foreign), expected: expectedFor(plan, calls) }),
      { ok: false, code: "receipt-legs-missing" });
  });
});

describe("verifyWalletIntentOwnership (the extracted v2 prefix)", () => {
  it("is the v2 verifier's prefix: the same code fires first, and the sizing check only when asked", () => {
    const plan = startPlan(guardLeg());
    const calls = callsOf(plan);
    const observation = dcaObservation(calls, planLogs(plan, NV, { firstTokenId: 1n }));
    const ownership = { wallet: WALLET, sessionPublicKey: KEY, sessionGeneration: 0, callsHash: hashCalls(calls), calls };
    const owned = verifyWalletIntentOwnership({ observation, expected: ownership });
    assert.ok(owned.ok);
    assert.equal(owned.intent.nonce, 7n);
    // The v2 verifier still refuses zero sizing where it always did: before the key and the calls.
    assert.deepEqual(verifyWalletIntentOwnership({ observation, expected: ownership, amounts: { amountInAtomic: 0n, minOutAtomic: 1n } }),
      { ok: false, code: "receipt-amount-mismatch" });
    assert.deepEqual(verifyTradfiV2Receipt({ observation, expected: { ...ownership, side: "buy", token: NV.stock, amountInAtomic: 0n, minOutAtomic: 1n } }),
      { ok: false, code: "receipt-amount-mismatch" });
    assert.deepEqual(verifyWalletIntentOwnership({ observation, expected: { ...ownership, callsHash: `0x${"11".repeat(32)}` } }),
      { ok: false, code: "receipt-calls-mismatch" });
  });
});
