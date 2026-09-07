import type { Usage } from "./types.js";

const UINT256_MAX = (1n << 256n) - 1n;

function uint256(value: bigint, field: string): bigint {
  if (value < 0n || value > UINT256_MAX) throw new Error(`${field} is outside uint256.`);
  return value;
}

function add256(left: bigint, right: bigint, field: string): bigint {
  const sum = left + right;
  return uint256(sum, field);
}

/**
 * Atomic exposure already includes the candidate Usage: pre-admission runs
 * after reservation. Adding it again would make the funding gate stricter than
 * the durable ledger and could strand an otherwise collectible request.
 */
export function livePayerExposureAtomic(
  usages: readonly Usage[],
  asset: Usage["asset"],
  payerIdentity: string,
): bigint {
  let total = 0n;
  for (const usage of usages) {
    if (usage.asset !== asset || usage.payerIdentity !== payerIdentity) continue;
    let amount: bigint;
    switch (usage.state) {
      case "prepared":
      case "transmitting":
      case "unknown":
        amount = usage.reservedAtomic;
        break;
      case "actual":
      case "claimed":
        if (usage.actualAtomic === undefined) {
          throw new Error("Actual billing exposure is missing its atomic debit.");
        }
        amount = usage.actualAtomic;
        break;
      case "released":
      case "invoiced":
        amount = 0n;
        break;
    }
    total = add256(total, uint256(amount, "Billing exposure"), "Billing exposure sum");
  }
  return total;
}

export function assertBasePayerFunded(input: Readonly<{
  nativeBalanceWei: bigint;
  minimumGasReserveWei: bigint;
  usdcBalanceAtomic: bigint;
  liveUsdcExposureAtomic: bigint;
  minimumUsdcAtomic: bigint;
}>): void {
  const native = uint256(input.nativeBalanceWei, "Base native balance");
  const gas = uint256(input.minimumGasReserveWei, "Base gas reserve");
  const usdc = uint256(input.usdcBalanceAtomic, "Base USDC balance");
  const exposure = uint256(input.liveUsdcExposureAtomic, "Base USDC exposure");
  const minimum = uint256(input.minimumUsdcAtomic, "Base USDC minimum");
  if (gas === 0n || minimum === 0n) throw new Error("Platform payer funding thresholds must be positive.");
  if (native < gas || usdc < exposure || usdc < minimum) {
    throw new Error("PLATFORM_PAYER_UNFUNDED");
  }
}

export function assertOgPayerFunded(input: Readonly<{
  totalBalanceNeuron: bigint;
  liveExposureNeuron: bigint;
  minimumNeuron: bigint;
}>): void {
  const balance = uint256(input.totalBalanceNeuron, "0G payer balance");
  const exposure = uint256(input.liveExposureNeuron, "0G payer exposure");
  const minimum = uint256(input.minimumNeuron, "0G payer minimum");
  if (minimum === 0n) throw new Error("Platform payer funding thresholds must be positive.");
  if (balance < exposure || balance < minimum) throw new Error("PLATFORM_PAYER_UNFUNDED");
}

