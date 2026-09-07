import { getAddress, zeroAddress, type Address } from "viem";
import { validateSessionSpec } from "../core/session.js";
import type { SessionSpec } from "../core/types.js";
import { MAX_BILLING_DAY_CAP_WEI } from "./config.js";

export const BILLING_COLLECTOR_SELECTOR = "payInvoice(bytes32,uint64)";
export const MAX_BILLING_SESSION_SECONDS = 7 * 24 * 60 * 60;

export type BillingSessionSpecInput = Readonly<{
  collector: Address;
  treasury: Address;
  wallet: Address;
  keyStore: Address;
  dayCapWei: bigint;
  now: number;
  expiresAt: number;
}>;

/** Build the one-call, native-DAY-only billing session. */
export function billingSessionSpec(input: BillingSessionSpecInput): SessionSpec {
  const collector = getAddress(input.collector);
  const treasury = getAddress(input.treasury);
  const wallet = getAddress(input.wallet);
  const keyStore = getAddress(input.keyStore);
  const roles = [collector, treasury, wallet, keyStore].map((entry) => entry.toLowerCase());
  if (roles.some((entry) => entry === zeroAddress) || new Set(roles).size !== roles.length) {
    throw new Error("Billing collector, treasury, wallet, and KeyStore roles must be nonzero and distinct.");
  }
  if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now) {
    throw new Error("Billing session expiry must be a future integer Unix second.");
  }
  if (input.expiresAt > input.now + MAX_BILLING_SESSION_SECONDS) {
    throw new Error("Billing session expiry exceeds seven days.");
  }
  if (input.dayCapWei <= 0n || input.dayCapWei > MAX_BILLING_DAY_CAP_WEI) {
    throw new Error("Billing native DAY cap must be positive and no greater than 0.1 BNB.");
  }
  const spec: SessionSpec = {
    allowedCalls: [{ to: collector, selector: BILLING_COLLECTOR_SELECTOR }],
    spendCaps: [{ limit: input.dayCapWei, period: "day" }],
    expiresAt: input.expiresAt,
  };
  validateSessionSpec(spec, { nowSeconds: input.now, maxSessionSeconds: MAX_BILLING_SESSION_SECONDS });
  return spec;
}

export function isExactBillingSession(spec: SessionSpec, input: BillingSessionSpecInput): boolean {
  try {
    const expected = billingSessionSpec(input);
    return JSON.stringify({
      allowedCalls: spec.allowedCalls,
      spendCaps: spec.spendCaps.map((cap) => ({ ...cap, limit: cap.limit.toString() })),
      expiresAt: spec.expiresAt,
    }) === JSON.stringify({
      allowedCalls: expected.allowedCalls,
      spendCaps: expected.spendCaps.map((cap) => ({ ...cap, limit: cap.limit.toString() })),
      expiresAt: expected.expiresAt,
    });
  } catch {
    return false;
  }
}
