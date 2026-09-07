import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertBasePayerFunded,
  assertOgPayerFunded,
  livePayerExposureAtomic,
} from "../src/billing/payerBalances.js";
import type { Usage, UsageState } from "../src/billing/types.js";

function usage(state: UsageState, reservedAtomic: bigint, actualAtomic?: bigint): Usage {
  return {
    usageId: `usage-${state}-${reservedAtomic}`,
    assertionNonce: "nonce", sessionTicketHash: `0x${"11".repeat(32)}`,
    accountId: "account", ownerAddress: `0x${"12".repeat(20)}`,
    walletAddress: `0x${"13".repeat(20)}`, agentId: "agent", grantId: "grant",
    generation: 1n, operation: "paid.cmc.quote", source: "x402", provider: "cmc",
    templateId: "template", logicalRequestId: "logical", requestDigest: `0x${"14".repeat(32)}`,
    payerIdentity: "payer", state, version: 1n, asset: "USDC_BASE", reservedAtomic,
    reservedUsdMicros: reservedAtomic, ...(actualAtomic === undefined ? {} : { actualAtomic }),
    createdAt: 1, updatedAt: 1,
  };
}

describe("production platform-payer equations", () => {
  it("counts each live state once and excludes released/invoiced", () => {
    const rows = [
      usage("prepared", 2n), usage("transmitting", 3n), usage("unknown", 5n),
      usage("actual", 99n, 7n), usage("claimed", 99n, 11n),
      usage("released", 13n), usage("invoiced", 17n),
    ];
    assert.equal(livePayerExposureAtomic(rows, "USDC_BASE", "payer"), 28n);
  });

  it("fails closed when an actual/claimed row lost its debit", () => {
    assert.throws(() => livePayerExposureAtomic([usage("actual", 1n)], "USDC_BASE", "payer"));
  });

  it("accepts exact Base and 0G funding boundaries", () => {
    assert.doesNotThrow(() => assertBasePayerFunded({
      nativeBalanceWei: 10n, minimumGasReserveWei: 10n,
      usdcBalanceAtomic: 20n, liveUsdcExposureAtomic: 20n, minimumUsdcAtomic: 20n,
    }));
    assert.doesNotThrow(() => assertOgPayerFunded({
      totalBalanceNeuron: 30n, liveExposureNeuron: 30n, minimumNeuron: 30n,
    }));
  });

  it("keeps native, USDC and neuron dimensions independent", () => {
    assert.throws(() => assertBasePayerFunded({
      nativeBalanceWei: 9n, minimumGasReserveWei: 10n,
      usdcBalanceAtomic: 1_000n, liveUsdcExposureAtomic: 1n, minimumUsdcAtomic: 1n,
    }), /PLATFORM_PAYER_UNFUNDED/);
    assert.throws(() => assertOgPayerFunded({
      totalBalanceNeuron: 29n, liveExposureNeuron: 30n, minimumNeuron: 1n,
    }), /PLATFORM_PAYER_UNFUNDED/);
  });

  it("refuses uint256 overflow instead of wrapping", () => {
    const max = (1n << 256n) - 1n;
    assert.throws(() => livePayerExposureAtomic([
      usage("prepared", max), usage("prepared", 1n),
    ], "USDC_BASE", "payer"), /uint256/);
  });
});
