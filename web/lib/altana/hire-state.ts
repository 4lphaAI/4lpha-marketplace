export type HireMissing =
  | "account-key" | "permissions-differ" | "keystore-id" | "keystore-pubkey"
  | "wallet-not-registered" | "wallet-owner-mismatch" | "evidence-unreadable" | "expired";

export type HireFunding = {
  readonly version: 1;
  readonly observedAtSec: number;
  readonly registrationFeeWei: string;
  readonly registrations: 1 | 2;
  readonly relayGasHeadroomWei: string;
  readonly requiredWei: string;
  readonly balanceWei: string | null;
};

export type HireSessionView = {
  readonly status: "provisioning" | "armed" | "paused" | "revoked" | "retired";
  readonly sessionAddress?: string;
  readonly sessionPublicKey?: `0x${string}`;
  readonly permissions?: {
    readonly calls: readonly ({ readonly to?: string; readonly signature?: string })[];
    readonly spend: readonly ({ readonly token?: string; readonly period: string; readonly limit: string })[];
  };
  readonly expiresAt?: number;
  readonly funding?: HireFunding;
  readonly sizing?: {
    readonly sizingPreset: "grid-v1" | "grid-shift-v1" | "lp-v1" | "trade-v1" | "lending-v1";
    readonly capDayWei: string;
    readonly openNativeBudgetWei: string;
    readonly sizingPresetVersion: 1;
  };
  readonly missing?: readonly HireMissing[];
  readonly cancelRequested?: boolean;
  readonly revocationRequired?: boolean;
  readonly hireRunId?: string;
  readonly grantAttempt?: { readonly version: 1; readonly attemptId: `0x${string}`; readonly startedAtSec: number };
  readonly activationError?: "wallet_in_use" | "settings_conflict";
  /** Present once armed: the immutable hire profile the grid arm must stay inside. */
  readonly hireSizing?: { readonly name: "grid-v1" | "grid-shift-v1" | "lp-v1" | "trade-v1" | "lending-v1"; readonly version: 1; readonly openNativeBudgetWei: string } | null;
};

export type HireResumeStep = "s1" | "fund-and-grant" | "converge" | "poll" | "arm" | "terminal";

/** Reload matrix: never interprets a partial landing as permission to re-grant. */
export function hireResumeStep(view: HireSessionView | null): HireResumeStep {
  if (view === null) return "s1";
  if (view.status === "armed") return "arm";
  if (view.status !== "provisioning") return "terminal";
  if (view.activationError !== undefined) return "terminal";
  if (view.cancelRequested === true) return "poll";
  const missing = new Set(view.missing ?? []);
  if (missing.has("expired") || missing.has("permissions-differ") || missing.has("wallet-owner-mismatch") || missing.has("keystore-pubkey")) return "terminal";
  if (missing.size === 0 || (missing.has("account-key") && missing.has("keystore-id"))) {
    return view.grantAttempt === undefined ? "fund-and-grant" : "converge";
  }
  return "poll";
}

export function freshFundingGate(funding: HireFunding, nowSec: number): { readonly ok: true } | { readonly ok: false; readonly reason: "stale" | "unreadable" | "short" } {
  if (!Number.isInteger(nowSec) || nowSec < funding.observedAtSec || nowSec - funding.observedAtSec > 30) return { ok: false, reason: "stale" };
  if (funding.balanceWei === null) return { ok: false, reason: "unreadable" };
  if (!/^\d+$/u.test(funding.balanceWei) || !/^\d+$/u.test(funding.requiredWei)) return { ok: false, reason: "unreadable" };
  return BigInt(funding.balanceWei) >= BigInt(funding.requiredWei) ? { ok: true } : { ok: false, reason: "short" };
}
