/**
 * SERVER-ONLY helpers shared by the lending BFF routes.
 *
 * `execServiceRead` carries `x-exec-token`, so nothing in this module may be
 * imported from a client component. It lives beside `client.ts`, which throws
 * if it ever reaches a browser bundle.
 */
import { execServiceRead } from "./client";
import { INVALID, parseLendingGuardable, type LendingGuardableView } from "./lending-types";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const DECIMAL = /^\d{1,78}$/u;

export type GuardableQuery = {
  readonly account: string;
  /**
   * Receipt mode. ALL FOUR or none — the plane refuses a partial set, because a
   * receipt that bound only some of its inputs would verify at S1 for a budget
   * it never priced.
   */
  readonly sizing?: {
    readonly budgetWei: string;
    readonly reserveBps: string;
    readonly maxPerActionUsdtWei: string;
    readonly rescueReserveCount: string;
  };
};

export type GuardableResult =
  | { readonly kind: "ok"; readonly view: LendingGuardableView }
  | { readonly kind: "disabled" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "invalid-request"; readonly message: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Validate the caller's inputs BEFORE spending an upstream call, then
 * RE-VALIDATE the payload before anything renders it.
 *
 * `/lending/guardable` is an RPC amplifier the plane meters per account and per
 * client; refusing a malformed address here keeps a typo from consuming a
 * bucket the real read needs (the `/api/pool-range` precedent).
 */
export function validateGuardableInputs(raw: {
  readonly account: string | null;
  readonly budgetWei: string | null;
  readonly reserveBps: string | null;
  readonly maxPerActionUsdtWei: string | null;
  readonly rescueReserveCount: string | null;
}): GuardableQuery | { readonly error: string } {
  const account = raw.account ?? "";
  if (!ADDRESS.test(account)) return { error: "account must be a 20-byte hex address." };
  const present = [raw.budgetWei, raw.reserveBps, raw.maxPerActionUsdtWei, raw.rescueReserveCount]
    .filter((entry) => entry !== null && entry !== "");
  if (present.length === 0) return { account };
  if (present.length !== 4) {
    return {
      error: "Receipt mode requires budgetWei, reserveBps, maxPerActionUsdtWei and rescueReserveCount together.",
    };
  }
  const budgetWei = raw.budgetWei ?? "";
  const maxPerActionUsdtWei = raw.maxPerActionUsdtWei ?? "";
  const reserveBps = raw.reserveBps ?? "";
  const rescueReserveCount = raw.rescueReserveCount ?? "";
  if (!DECIMAL.test(budgetWei) || BigInt(budgetWei) <= 0n) {
    return { error: "budgetWei must be a positive decimal uint256 string." };
  }
  // `0` is legal: a vBNB-only guard names no USDT ceiling, and S1 then expects
  // the receipt to have bound zero.
  if (!DECIMAL.test(maxPerActionUsdtWei)) {
    return { error: "maxPerActionUsdtWei must be a decimal uint256 string." };
  }
  if (!/^\d{1,5}$/u.test(reserveBps) || Number(reserveBps) < 1_000 || Number(reserveBps) > 5_000) {
    return { error: "reserveBps must be an integer in 1000..5000." };
  }
  if (!/^\d{1,2}$/u.test(rescueReserveCount)
    || Number(rescueReserveCount) < 1 || Number(rescueReserveCount) > 24) {
    return { error: "rescueReserveCount must be an integer in 1..24." };
  }
  return { account, sizing: { budgetWei, reserveBps, maxPerActionUsdtWei, rescueReserveCount } };
}

export async function readGuardable(query: GuardableQuery): Promise<GuardableResult> {
  const params = new URLSearchParams({ account: query.account });
  if (query.sizing !== undefined) {
    params.set("budgetWei", query.sizing.budgetWei);
    params.set("reserveBps", query.sizing.reserveBps);
    params.set("maxPerActionUsdtWei", query.sizing.maxPerActionUsdtWei);
    params.set("rescueReserveCount", query.sizing.rescueReserveCount);
  }
  let upstream;
  try {
    upstream = await execServiceRead(`/lending/guardable?${params.toString()}`);
  } catch {
    return { kind: "unavailable", reason: "the execution plane is unreachable" };
  }
  if (upstream.status === 404) return { kind: "disabled" };
  if (upstream.status === 429) return { kind: "rate-limited" };
  if (upstream.status === 400) {
    return { kind: "invalid-request", message: "The execution plane refused these inputs." };
  }
  if (upstream.status !== 200) {
    return { kind: "unavailable", reason: `the guarded account could not be read (HTTP ${upstream.status})` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(upstream.body) as unknown;
  } catch {
    return { kind: "unavailable", reason: "the execution plane returned an unreadable body" };
  }
  const view = parseLendingGuardable((payload as { data?: unknown } | null)?.data ?? payload);
  if (view === INVALID) {
    return { kind: "unavailable", reason: "the execution plane returned a shape this page cannot map" };
  }
  return { kind: "ok", view };
}
