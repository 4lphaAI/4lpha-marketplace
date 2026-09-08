/**
 * The SECOND-DEVICE arm: rebuilding the hire's own values from the plane.
 *
 * FIXREVIEW **F2** / residual 2. At S1 the owner signs the COMPLETE lending
 * settings; the plane keeps their digest on `PendingGrant.initialLendingHire`
 * and materialises `lending_settings` at convergence. The arm route (P19) then
 * refuses any arm whose settings digest, `budgetWei` or `reserveBps` differs
 * from what that hire carries — a continuation of the S1 signature, not a
 * second admission.
 *
 * W1 made the browser persist those S1 values in `localStorage` so the arm can
 * reproduce them. That record is per BROWSER and per ACCOUNT by construction,
 * so a hire granted on one device could not be armed from another AT ALL: W1
 * refuses (no record) and P19 would refuse anything rebuilt from this screen's
 * defaults. The dead end was the finding.
 *
 * The plane already holds every value P19 demands, behind `authorizeAccountRead`:
 *
 * - `GET /agents/:id/lending/view` returns `settings` (the stored row, re-rendered
 *   through `lendingSettingsView`) and `settingsDigest` — and the digest is
 *   served ONLY when the plane itself re-hashed the stored bytes and agreed
 *   (`digestTrusted`), so a `null` digest means "do not sign this", never "no
 *   settings";
 * - the same view's guard row carries `reserveBps`, the value materialised from
 *   `initialLendingHire`;
 * - `GET /agents/:id/session` carries `hireSizing.openNativeBudgetWei`, the
 *   budget the hire was SIZED and FUNDED for, which P19 requires by EQUALITY.
 *
 * The guard row's own `budgetWei` is deliberately NOT used: before the first arm
 * it is zero (the arm is what writes it), so the hire sizing is the only source.
 *
 * THE DIGEST IS RECOMPUTED LOCALLY AND MUST MATCH. The view echoes a re-rendered
 * settings object, not the stored bytes, so "the plane will accept this" is a
 * claim this module has to prove rather than assume: `paramsHash("lendingSettings",
 * rebuilt)` — the same encoder the envelope signs through — must equal the
 * view's `settingsDigest`. When it does not, nothing is signed and the refusal
 * says so, because a passkey prompt whose only possible answer is a 400 is worse
 * than no prompt.
 */
import { paramsHash } from "@/lib/exec/owner-action";
import {
  INVALID,
  parseLendingAgentView,
  type LendingGuardStatus,
  type LendingSettingsView,
} from "@/lib/exec/lending-types";
import type { LendingSettingsParams } from "./form";

/** The three values `lendingArm` signs, exactly as P19 compares them. */
export type LendingArmValues = {
  readonly settings: LendingSettingsParams;
  readonly budgetWei: string;
  readonly reserveBps: number;
};

export type LendingArmRecovery =
  | {
    readonly kind: "recovered";
    /** What the owner is shown, and then signs. Nothing else reaches the envelope. */
    readonly values: LendingArmValues;
    /** The digest this browser recomputed AND the plane already agreed with. */
    readonly digest: string;
    readonly guardStatus: LendingGuardStatus;
    readonly reserveCapWei: string;
  }
  | {
    /** The guard is past the arm: there is nothing to place, only a page to open. */
    readonly kind: "past-arm";
    readonly guardStatus: LendingGuardStatus;
    readonly reason: string;
  }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The settings PARAMS the stored digest binds, rebuilt from the view's echo.
 *
 * `notifyOnlyBelowHf` is OMITTED when the plane reports `null`: the view renders
 * an unset optional as `null`, while the plane's own parser refuses a null
 * mantissa and `canonicalEncode` hashes an absent key differently from a present
 * one. Sending the key back as `null` would fail both the digest comparison and
 * the route's parse.
 */
export function lendingArmSettingsFromView(
  settings: LendingSettingsView,
): LendingSettingsParams {
  const rebuilt: Record<string, unknown> = {
    triggerHf: settings.triggerHf,
    targetHf: settings.targetHf,
    maxPerAction: settings.maxPerAction.map((cap) => ({ token: cap.token, maxWei: cap.maxWei })),
    minSecondsBetweenActions: settings.minSecondsBetweenActions,
    rescueReserveCount: settings.rescueReserveCount,
  };
  if (settings.notifyOnlyBelowHf !== null) {
    rebuilt["notifyOnlyBelowHf"] = settings.notifyOnlyBelowHf;
  }
  return rebuilt as unknown as LendingSettingsParams;
}

/** `0x1234abcd…9f0e` — enough of a digest to compare two of them by eye. */
export function shortDigest(digest: string): string {
  return digest.length <= 20 ? digest : `${digest.slice(0, 10)}…${digest.slice(-6)}`;
}

/** Why a guard that is not `provisioning-guard` or `closed` cannot be armed. */
const PAST_ARM_REASON: Record<LendingGuardStatus, string | null> = {
  "provisioning-guard": null,
  closed: null,
  arming: "the plane is already placing this reserve",
  armed: "this guard is already armed and holding its reserve",
  held: "the reserve placement is held — the relay's answer was ambiguous, so a second arm is blocked",
  retiring: "this guard is retiring",
  retired: "this guard has been retired",
};

/**
 * Read the plane's own record of this hire and rebuild the arm's three values.
 *
 * NOTHING is signed here, and nothing is written: this is a read plus a hash.
 */
export async function recoverLendingArmParams(input: {
  readonly agentId: string;
  /** `hireSizing.openNativeBudgetWei` from `GET /agents/:id/session`. */
  readonly hireBudgetWei: string | null | undefined;
  readonly headers?: Record<string, string>;
  readonly fetcher?: typeof fetch;
}): Promise<LendingArmRecovery> {
  const refused = (reason: string): LendingArmRecovery => ({ kind: "refused", reason });
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(
      `/api/agents/${encodeURIComponent(input.agentId)}/lending/view`,
      { headers: input.headers ?? {}, cache: "no-store" },
    );
  } catch {
    return refused("the execution plane could not be reached");
  }
  let payload: unknown = null;
  try {
    payload = await response.json() as unknown;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const code = (payload as { error?: { code?: string } } | null)?.error?.code;
    if (response.status === 401) return refused("this account is not authorised to read that agent");
    if (response.status === 404) return refused("the plane has no lending guard for this agent yet");
    return refused(`the guard view could not be read (${code ?? `HTTP ${response.status}`})`);
  }
  const view = parseLendingAgentView(payload);
  if (view === INVALID) return refused("the guard view returned a shape this page cannot map");

  const pastArm = PAST_ARM_REASON[view.guard.status];
  if (pastArm !== null) {
    return { kind: "past-arm", guardStatus: view.guard.status, reason: pastArm };
  }
  if (view.settings === null || view.settingsDigest === null) {
    return refused(
      "the plane holds no settings record it trusts for this hire, so there is nothing to rebuild",
    );
  }
  if (typeof input.hireBudgetWei !== "string" || !/^\d+$/u.test(input.hireBudgetWei)
    || BigInt(input.hireBudgetWei) <= 0n) {
    return refused("the budget this hire was funded for is not on the plane's session record");
  }
  const settings = lendingArmSettingsFromView(view.settings);
  const digest = paramsHash("lendingSettings", settings);
  if (digest.toLowerCase() !== view.settingsDigest.toLowerCase()) {
    return refused(
      `the settings this browser rebuilt hash to ${shortDigest(digest)}, but the hire you signed `
      + `carries ${shortDigest(view.settingsDigest)}, so the plane would refuse them`,
    );
  }
  return {
    kind: "recovered",
    values: { settings, budgetWei: input.hireBudgetWei, reserveBps: view.guard.reserveBps },
    digest,
    guardStatus: view.guard.status,
    reserveCapWei: view.guard.reserveCapWei,
  };
}
