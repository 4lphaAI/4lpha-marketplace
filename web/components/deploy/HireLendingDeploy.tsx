"use client";
import { accountHireStorage, accountSwitchRequiresContinue } from "@/lib/exec/account-hire-storage";

import * as React from "react";
import { formatEther, formatUnits, getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { FundsModal, type FundsWallet } from "@/components/FundsModal";
import { grantAgentSession, GrantAgentSessionError } from "@/lib/altana/client";
import { freshFundingGate, hireResumeStep, type HireFunding, type HireSessionView } from "@/lib/altana/hire-state";
import { credentialUsable, ensureHireReadCredential, HireReadRefused, pollStatusText, readHireSession, rememberedHireReadCredential, type HireReadCredential } from "@/lib/altana/hire-read-session";
import { cancelGridHire, cancellationMessage, cancellationRecorded, forgetHire, GridDeployRun, GridDeployStopped } from "@/lib/altana/grid-hire-recovery";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import { depositAmountBnb, depositAmountWei, requiredLendingDepositWei, walletSharedWithLiveAgents } from "@/lib/altana/hire-funding";
import { walletBlockerAgentId } from "@/lib/altana/hire-wallet-blocker";
import { parseBnbToWei } from "@/lib/grid/geometry";
import { WBNB_56 } from "@/lib/exec/pairs";
import { freshWbnbPriceMicros } from "@/lib/exec/agent-detail";
import type { OwnerActionEnvelope } from "@/lib/exec/owner-action";
import { nextFreeAgentId } from "./HireGridDeploy";
import {
  INVALID,
  LENDING_ACTIONS,
  parseLendingArmOutcome,
  parseLendingConfig,
  parseLendingGuardable,
  type LendingConfigView,
  type LendingGuardableView,
} from "@/lib/exec/lending-types";
import {
  LENDING_CUSTODY_COPY,
  LENDING_OWN_ACCOUNT_COPY,
  LENDING_REPAY_SOURCE_TEXT,
  buildLendingForm,
  derivedDailyRepayLimitWei,
  formatAtomicAmount,
  lendingCheckEveryText,
  lendingExposureLine,
  pinnableDebtMarkets,
  usdtDecimalsFrom,
  type LendingSettingsParams,
} from "@/lib/lending/form";
import { recoverLendingArmParams, type LendingArmValues } from "@/lib/lending/arm-recovery";
import { lendingUsdtCapRefusal, sameLendingArmValues, saveLendingUsdtRepay } from "@/lib/lending/prearm-settings";
import { suggestLendingRepay } from "@/lib/lending/repay-suggestion";
import { lendingUsdtGrantCap } from "@/lib/lending/grant-cap";
import { guardedAccountBlocker, guardedAccountReady, type GuardedAccountState } from "./GuardedAccountSection";

const primaryBtn: React.CSSProperties = {
  cursor: "pointer",
  padding: "14px 22px",
  borderRadius: "var(--radius-sm)",
  background: "var(--cat-health)",
  border: "none",
  color: "#08110c",
  font: "var(--weight-medium) var(--text-md)/1 var(--font-sans)",
};
const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "transparent",
  color: "var(--cat-health)",
  border: "1px solid var(--cat-health)",
};
const busyBtn = (busy: boolean, base: React.CSSProperties): React.CSSProperties =>
  busy ? { ...base, cursor: "wait", opacity: 0.6 } : base;

const HIRE_PROFILE = "lending-v1" as const;
const TTL_SEC = 604_800;

export const LENDING_HIRE_STORAGE_KEY = "4lpha:lending-hire:v1";
export const LENDING_HIRE_ENVELOPE_STORAGE_PREFIX = `${LENDING_HIRE_STORAGE_KEY}:provision:`;
export const LENDING_ARM_OUTCOME_STORAGE_PREFIX = `${LENDING_HIRE_STORAGE_KEY}:arm-outcome:`;
export const LENDING_ARM_PARAMS_STORAGE_PREFIX = `${LENDING_HIRE_STORAGE_KEY}:arm-params:`;

/**
 * The pointer is a BARE AGENT ID, not the trade run's JSON record.
 *
 * §9's parenthetical asks for "the trade shape", but `forgetHire` (and through
 * it `cancelGridHire` and `HireRecoveryActions`) releases a pointer by comparing
 * `storage.getItem(key) === agentId`. A JSON record never matches that
 * comparison, so a cancelled lending hire would keep its pointer forever. The LP
 * machine — which §9 also names as the base — stores the bare id and keeps the
 * signed envelope under a per-agent key beside it, and that is what this does.
 */
function provisionEnvelopeKey(agentId: string): string {
  return `${LENDING_HIRE_ENVELOPE_STORAGE_PREFIX}${agentId}`;
}

function armOutcomeKey(agentId: string): string {
  return `${LENDING_ARM_OUTCOME_STORAGE_PREFIX}${agentId}`;
}

function armParamsKey(agentId: string): string {
  return `${LENDING_ARM_PARAMS_STORAGE_PREFIX}${agentId}`;
}

/**
 * The values the owner signed AT S1, kept beside the provision envelope.
 *
 * AUDIT G-M1 / W1. The arm used to sign `form.settings` (a memo re-priced every
 * 30 s), `props.capitalBnb` and `props.reserveBps` — which after a RELOAD
 * between the grant and the arm are `DeployAgentScreen`'s DEFAULTS, because
 * nothing persisted them. A hire funded for 0.5 BNB then armed 0.05 BNB with
 * default thresholds, silently, and the plane cannot catch it: its arm route
 * checks the profile and `budget ≤ hire budget`, never the settings digest.
 *
 * So the hire's own numbers are persisted under the SAME per-agent, account-
 * scoped mechanism as the provision envelope, written only once the S1 POST has
 * been accepted, and cleared on every terminal outcome exactly like the pointer.
 * `reserveCapWei` rides along because it is the receipt-derived cap those
 * settings were sized against — a later surface comparing the two must not have
 * to re-read a receipt that has long expired.
 */
export type PersistedLendingArmParams = {
  readonly settings: LendingSettingsParams;
  readonly budgetWei: string;
  readonly reserveBps: number;
  readonly reserveCapWei: string;
};

function saveArmParams(storage: Storage, agentId: string, params: PersistedLendingArmParams): void {
  const encoded = JSON.stringify(params);
  storage.setItem(armParamsKey(agentId), encoded);
  if (storage.getItem(armParamsKey(agentId)) !== encoded) throw new Error("Could not save the verified arm settings in this browser. Retry before placing the reserve.");
}

/** Non-throwing, and STRICT: a record this cannot map is no record at all. */
function loadArmParams(storage: Storage, agentId: string): PersistedLendingArmParams | null {
  const raw = storage.getItem(armParamsKey(agentId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const settings = value["settings"] as LendingSettingsParams | undefined;
    const budgetWei = value["budgetWei"];
    const reserveBps = value["reserveBps"];
    const reserveCapWei = value["reserveCapWei"];
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
    const row = settings as unknown as Record<string, unknown>;
    if (typeof row["triggerHf"] !== "string" || typeof row["targetHf"] !== "string"
      || !Array.isArray(row["maxPerAction"])
      || typeof row["minSecondsBetweenActions"] !== "number"
      || typeof row["rescueReserveCount"] !== "number") return null;
    if (typeof budgetWei !== "string" || !/^\d+$/u.test(budgetWei) || BigInt(budgetWei) <= 0n) return null;
    if (typeof reserveBps !== "number" || !Number.isInteger(reserveBps)) return null;
    if (typeof reserveCapWei !== "string" || !/^\d+$/u.test(reserveCapWei)) return null;
    return { settings, budgetWei, reserveBps, reserveCapWei };
  } catch {
    return null;
  }
}

/**
 * What the page says when the S1 record is gone. It NEVER falls back to the
 * live form: arming defaults against a wallet funded for something else is the
 * exact failure W1 exists to stop.
 *
 * FIXREVIEW F2: this is no longer the FIRST answer to a missing record. A
 * second device — or the same device after `localStorage` was cleared — now
 * rebuilds the hire's own values from `GET /agents/:id/lending/view` and shows
 * them for confirmation. This copy is what remains when even that cannot be
 * done, and it names the reason rather than leaving the owner at a dead end.
 */
export const LENDING_ARM_PARAMS_MISSING_COPY =
  "The values you signed when you hired this agent (capital, reserve split and thresholds) are not saved in this browser, so arming now could place a different reserve than the one you funded. Nothing was signed. Continue on the device and browser you hired from, or cancel this hire safely and start again.";

/** The same refusal, naming what stopped the plane's own record from standing in. */
export function lendingArmRecoveryRefusal(reason: string): string {
  return "The values you signed when you hired this agent (capital, reserve split and thresholds) "
    + "are not saved in this browser, and this device could not rebuild them from the execution "
    + `plane: ${reason}. Nothing was signed. Continue on the device and browser you hired from, `
    + "or cancel this hire safely and start again.";
}

/** Shown ABOVE the confirm button, because these values are what gets signed. */
export const LENDING_ARM_RECOVERED_COPY =
  "These are the current signed settings and funded capital read from the execution plane. "
  + "Review them before confirming the reserve placement. Nothing has been signed yet.";

type DurableArmOutcome = { readonly status: "held" | "rolled-back"; readonly reason: string };

function saveArmOutcome(storage: Storage, agentId: string, outcome: DurableArmOutcome): void {
  storage.setItem(armOutcomeKey(agentId), JSON.stringify(outcome));
}

function loadArmOutcome(storage: Storage, agentId: string): DurableArmOutcome | null {
  const raw = storage.getItem(armOutcomeKey(agentId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return (value["status"] === "held" || value["status"] === "rolled-back") && typeof value["reason"] === "string"
      ? { status: value["status"], reason: value["reason"] }
      : null;
  } catch {
    return null;
  }
}

function saveProvisionEnvelope(storage: Storage, agentId: string, envelope: OwnerActionEnvelope): void {
  storage.setItem(provisionEnvelopeKey(agentId), JSON.stringify(envelope));
}

function loadProvisionEnvelope(storage: Storage, agentId: string): OwnerActionEnvelope | null {
  const raw = storage.getItem(provisionEnvelopeKey(agentId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as OwnerActionEnvelope
      : null;
  } catch {
    return null;
  }
}

function forgetLendingHire(storage: Storage, agentId: string): void {
  forgetHire(storage, agentId, LENDING_HIRE_STORAGE_KEY);
  storage.removeItem(provisionEnvelopeKey(agentId));
  storage.removeItem(armOutcomeKey(agentId));
  storage.removeItem(armParamsKey(agentId));
}

/** The FUNDING half of `/agents/hire/preview` for a lending hire. */
type LendingPreview = {
  readonly sizing: {
    readonly name: "lending-v1";
    readonly openNativeBudgetWei: string;
    readonly relayFeePerSubmitWei: string;
    readonly note?: string;
  };
  readonly funding: HireFunding;
};

type GrantCallPermission =
  | { readonly to: Address; readonly signature: string }
  | { readonly to: Address }
  | { readonly signature: string };

type DeployStepKey = "hire" | "fund" | "grant" | "converge" | "arm";
type DeployStepState = "pending" | "active" | "done" | "failed" | "skipped";
type DeployStep = { readonly state: DeployStepState; readonly detail?: string };

const DEPLOY_STEPS: readonly { readonly key: DeployStepKey; readonly title: string; readonly hint: string }[] = [
  { key: "hire", title: "Sign the hire", hint: "One passkey signature creates the scoped session key" },
  { key: "fund", title: "Fund the agent wallet", hint: "The reserve, the registration fee and the relay gas" },
  { key: "grant", title: "Grant the session on chain", hint: "Your passkey authorises the session; the relay submits it" },
  { key: "converge", title: "Verify the grant", hint: "Relay, account, KeyStore and owner binding must all agree" },
  { key: "arm", title: "Place the reserve", hint: "Signs lendingArm: one batch swaps BNB to USDT and supplies it to Venus" },
];

const STEP_MARK: Record<DeployStepState, string> = {
  pending: "○", active: "◐", done: "●", failed: "✕", skipped: "–",
};

const IDLE_STEPS: Record<DeployStepKey, DeployStep> = {
  hire: { state: "pending" }, fund: { state: "pending" }, grant: { state: "pending" },
  converge: { state: "pending" }, arm: { state: "pending" },
};

function DeployProgress({ steps }: { readonly steps: Record<DeployStepKey, DeployStep> }) {
  return (
    <div style={{ display: "grid", gap: 2, padding: 12, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      {DEPLOY_STEPS.map(({ key, title, hint }, index) => {
        const step = steps[key];
        const colour = step.state === "done" ? "var(--profit)"
          : step.state === "failed" ? "var(--loss)"
            : step.state === "active" ? "var(--cat-health)" : "var(--text-subtle)";
        return (
          <div key={key} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 6px" }}>
            <span style={{ color: colour, font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-mono)", width: 44, flex: "0 0 auto" }}>
              {STEP_MARK[step.state]} {index + 1}
            </span>
            <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <span style={{ font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", color: step.state === "pending" ? "var(--text-subtle)" : "var(--ink-1)" }}>{title}</span>
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: step.state === "failed" ? "var(--loss)" : "var(--text-subtle)", overflowWrap: "anywhere" }}>
                {step.detail ?? hint}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function agentIdFromName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96);
  return slug === "" ? "lending-agent" : slug;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: { code?: string; message?: string } }).error;
  return error?.message ?? error?.code ?? fallback;
}

function grantCall(call: { readonly to?: string; readonly signature?: string }): GrantCallPermission {
  if (call.to !== undefined && call.signature !== undefined) return { to: getAddress(call.to), signature: call.signature };
  if (call.to !== undefined) return { to: getAddress(call.to) };
  if (call.signature !== undefined) return { signature: call.signature };
  throw new Error("The plane returned an empty call permission.");
}

/** A `held` or `rolled-back` arm: the recovery path, never a silent success. */
export class LendingArmOutcomeError extends Error {
  readonly status: "held" | "rolled-back";
  constructor(status: "held" | "rolled-back", reason: string) {
    super(reason);
    this.name = "LendingArmOutcomeError";
    this.status = status;
  }
}

/** R3.13: the wallet already carries a live agent. Refused BEFORE any signature. */
export class LendingWalletBlockedError extends Error {
  readonly blockerId: string | null;
  constructor(blockerId: string | null) {
    super(
      `${blockerId === null
        ? "This wallet already carries a live agent."
        : `This wallet already carries a live agent ("${blockerId}").`} ${LENDING_OWN_ACCOUNT_COPY}`,
    );
    this.name = "LendingWalletBlockedError";
    this.blockerId = blockerId;
  }
}

/* -------------------------------------------------------------------------- */
/* The arm                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sign `lendingArm` and read its OUTCOME, which an HTTP 200 does not give.
 *
 * The arm's relay batch is atomic (swap → approve → mint) and can come back
 * `held` — an ambiguous submission, after which a SECOND ARM IS BLOCKED FOREVER
 * because re-swapping on an ambiguous swap is how a reserve gets spent twice —
 * or `rolled-back`, which never funded and is safe to retry. `replayed: true`
 * means this exact envelope already ran; the caller re-reads the view rather
 * than inferring anything (L9).
 */
export async function armLendingAgent(input: {
  readonly agentId: string;
  readonly settings: LendingSettingsParams;
  readonly budgetWei: bigint;
  readonly reserveBps: number;
  readonly signEnvelope: (action: string, agentId: string, params: unknown) => Promise<unknown>;
  readonly onNote?: (note: string) => void;
}): Promise<{ readonly replayed: boolean; readonly data: Record<string, unknown> }> {
  const params = {
    settings: input.settings,
    budgetWei: input.budgetWei.toString(10),
    reserveBps: input.reserveBps,
  };
  const envelope = await input.signEnvelope(LENDING_ACTIONS.arm, input.agentId, params);
  input.onNote?.("Submitting lendingArm to the execution plane…");
  const response = await fetch(`/api/agents/${encodeURIComponent(input.agentId)}/lending/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const payload = await response.json() as { data?: Record<string, unknown>; error?: { code: string; message?: string } };
  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ? `${payload.error.code}: ${payload.error.message}` : payload.error?.code ?? `HTTP ${response.status}`);
  }
  // L9: a replay carries no outcome block at all — the plane returns the prior
  // journal state. The truth is the view, so the caller re-reads it.
  if (payload.data["replayed"] === true) return { replayed: true, data: payload.data };
  const outcome = parseLendingArmOutcome(payload);
  if (outcome === INVALID) {
    throw new Error("The execution plane returned a lending arm result this page cannot map.");
  }
  if (outcome.status === "held" || outcome.status === "rolled-back") {
    throw new LendingArmOutcomeError(
      outcome.status,
      outcome.reason !== undefined && outcome.reason.length > 0
        ? outcome.reason
        : outcome.status === "held"
          ? "The reserve placement is held: the relay's answer was ambiguous. A second arm is blocked; continue from the agent page."
          : "The reserve placement rolled back before anything moved. Retry the arm.",
    );
  }
  input.onNote?.(
    outcome.effect === "changed"
      ? `Reserve placed: ${outcome.mintUsdtWei} USDT wei supplied on Venus, ${outcome.reserveNativeWei} wei kept as BNB.`
      : `Submitted, but the supply could not be verified yet (${outcome.effect}). The agent page shows what the worker sees.`,
  );
  return { replayed: false, data: payload.data };
}

/* -------------------------------------------------------------------------- */
/* The component                                                              */
/* -------------------------------------------------------------------------- */

export type HireLendingDeployProps = {
  /**
   * The screen's toggle emits "Demo" | "Live" (`DeployAgentScreen`'s
   * `SegmentedToggle`), and grid and LP both type it that way. This component
   * said "Paper", so `mode === "Paper"` was never true and picking Demo on the
   * lending form fell through to the LIVE passkey hire. `DeployAgentScreen` is
   * `@ts-nocheck`, so no typecheck caught the mismatch.
   */
  readonly mode: "Demo" | "Live";
  readonly agentName: string;
  readonly capitalBnb: string;
  readonly guarded: GuardedAccountState | null | undefined;
  readonly triggerHf: string;
  readonly targetHf: string;
  readonly maxRepayUsd: string;
  readonly rescueReserveCount: number;
  readonly cooldownSeconds: number;
  readonly reserveBps: number;
  /** The form's own refusal, surfaced BEFORE any passkey prompt. */
  readonly blockedReason?: string | null;
  readonly onRepaySuggestion?: (amountUsd: string | null) => void;
  readonly go?: (route: string) => void;
};

export function HireLendingDeploy(props: HireLendingDeployProps) {
  const owner = useOwnerActions();
  const ownerIdentity = `${owner.ownerAddress ?? ""}:${owner.walletAddress ?? ""}`.toLowerCase();
  const currentOwnerIdentity = React.useRef(ownerIdentity);
  currentOwnerIdentity.current = ownerIdentity;
  const hireStorage = React.useMemo(
    () => accountHireStorage(typeof window === "undefined" ? undefined : window.localStorage, owner.ownerAddress),
    [owner.ownerAddress],
  );
  const { address: connectedAddress } = useAccount();
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<HireSessionView | null>(null);
  const [preview, setPreview] = React.useState<LendingPreview | null>(null);
  const [config, setConfig] = React.useState<LendingConfigView | null>(null);
  const [configReason, setConfigReason] = React.useState<string | null>(null);
  const [wbnbMicros, setWbnbMicros] = React.useState<bigint | null>(null);
  const [sizing, setSizing] = React.useState<LendingGuardableView | null>(null);
  const [sizingReason, setSizingReason] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [walletBlocked, setWalletBlocked] = React.useState<string | null>(null);
  const blockerId = walletBlockerAgentId(message);
  const blockerHref = blockerId === null ? null : `/account/${encodeURIComponent(blockerId)}`;
  const [armOutcome, setArmOutcome] = React.useState<DurableArmOutcome | null>(null);
  /**
   * FIXREVIEW F2 — the values rebuilt from the plane, awaiting the owner's eye.
   *
   * They are NOT signed when they are found: the arm run stops here, the panel
   * renders them, and only the owner's explicit confirmation (which lands in
   * `confirmedArm`) lets the next run reach the passkey prompt.
   */
  const [armRecovered, setArmRecovered] = React.useState<
    { readonly agentId: string; readonly values: LendingArmValues } | null
  >(null);
  /** The guard is past the arm: there is nothing to place, only a page to open. */
  const [armPastArm, setArmPastArm] = React.useState<string | null>(null);
  const confirmedArm = React.useRef<{ readonly agentId: string; readonly values: LendingArmValues } | null>(null);
  const [deposit, setDeposit] = React.useState(false);
  const [depositWei, setDepositWei] = React.useState<bigint | null>(null);
  const autoContinued = React.useRef(false);
  const [steps, setSteps] = React.useState<Record<DeployStepKey, DeployStep>>(IDLE_STEPS);
  const [running, setRunning] = React.useState(false);
  const pollTimer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const resumed = React.useRef(false);
  const activeRun = React.useRef<GridDeployRun | null>(null);
  const pollGeneration = React.useRef(0);
  const mounted = React.useRef(true);
  const cancelling = React.useRef(false);
  const readCredential = React.useRef<HireReadCredential | null>(null);
  const provisionEnvelope = React.useRef<OwnerActionEnvelope | null>(null);

  /* ---- venue config + the fresh BNB price (both needed BEFORE signing) ---- */

  React.useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/lending/config", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { data?: unknown; error?: { code?: string } };
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setConfigReason(response.status === 404
            ? "The lending guard is not enabled on this execution plane."
            : `The lending venue could not be read (${payload.error?.code ?? response.status}).`);
          return;
        }
        const parsed = parseLendingConfig(payload.data);
        if (parsed === INVALID) {
          setConfigReason("The lending venue read returned a shape this page cannot map.");
          return;
        }
        setConfig(parsed);
        setConfigReason(null);
      })
      .catch(() => { if (!controller.signal.aborted) setConfigReason("The lending venue could not be read."); });
    return () => controller.abort();
  }, []);

  // A BNB ceiling is signed for seven days, so it is converted through a FRESH
  // price or not at all (`freshWbnbPriceMicros` returns null past 60 s).
  React.useEffect(() => {
    let alive = true;
    let priceExpiry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void fetch(`/api/market-data/tokens/${WBNB_56}`, { cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<unknown> : null)
        .then((payload) => {
          if (!alive) return;
          clearTimeout(priceExpiry);
          const price = payload === null ? null : freshWbnbPriceMicros(payload);
          setWbnbMicros(price);
          if (price !== null) {
            // freshWbnbPriceMicros validated this timestamp. Expire the scalar
            // even if the next network read hangs beyond the freshness window.
            const asOf = (payload as { meta: { asOf: number } }).meta.asOf;
            priceExpiry = setTimeout(() => { if (alive) setWbnbMicros(null); }, Math.max(0, asOf + 60_001 - Date.now()));
          }
        })
        .catch(() => { if (alive) setWbnbMicros(null); });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); clearTimeout(priceExpiry); };
  }, []);

  const budgetWei = React.useMemo(() => {
    try {
      return parseBnbToWei(props.capitalBnb);
    } catch {
      return 0n;
    }
  }, [props.capitalBnb]);

  const repaySuggestion = React.useMemo(() => suggestLendingRepay({
    account: props.guarded?.account ?? "", view: props.guarded?.view ?? null,
    loading: props.guarded?.loading ?? false, capitalWei: budgetWei, priceMicros: wbnbMicros,
  }), [props.guarded?.account, props.guarded?.view, props.guarded?.loading, budgetWei, wbnbMicros]);
  React.useEffect(() => { props.onRepaySuggestion?.(repaySuggestion); }, [props.onRepaySuggestion, repaySuggestion]);

  const debtMarkets = React.useMemo(
    () => pinnableDebtMarkets(props.guarded?.view ?? null),
    [props.guarded?.view],
  );
  const usdtDecimals = usdtDecimalsFrom(props.guarded?.view ?? null, config?.vUsdt ?? null);

  const form = React.useMemo(() => {
    if (config === null) return null;
    return buildLendingForm({
      triggerHf: props.triggerHf,
      targetHf: props.targetHf,
      maxRepayUsd: props.maxRepayUsd,
      rescueReserveCount: props.rescueReserveCount,
      cooldownSeconds: props.cooldownSeconds,
      reserveBps: props.reserveBps,
      debtMarkets,
      vUsdt: config.vUsdt,
      vBnb: config.vBnb,
      usdt: config.usdt,
      usdtDecimals,
      wbnbPriceMicros: wbnbMicros,
    });
  }, [config, debtMarkets, props.cooldownSeconds, props.maxRepayUsd, props.rescueReserveCount,
    props.reserveBps, props.targetHf, props.triggerHf, usdtDecimals, wbnbMicros]);

  /* ---- the receipt-mode sizing read (the exposure line's only source) ----- */

  const account = props.guarded?.account ?? "";
  const usdtCeilingWei = form !== null && form.ok ? form.usdtCeilingWei : null;
  const sizingKey = form !== null && form.ok && budgetWei > 0n && guardedAccountReady(props.guarded)
    ? `${account}|${budgetWei}|${props.reserveBps}|${usdtCeilingWei ?? 0n}|${props.rescueReserveCount}`
    : "";
  React.useEffect(() => {
    if (sizingKey === "") { setSizing(null); setSizingReason(null); return; }
    const controller = new AbortController();
    // Debounced: `/lending/guardable` is metered 10/min per account, and the
    // owner is still typing. One read per settled form, not one per keystroke.
    const timer = setTimeout(() => {
      const [readAccount, budget, bps, ceiling, count] = sizingKey.split("|");
      const query = new URLSearchParams({
        account: readAccount ?? "",
        budgetWei: budget ?? "0",
        reserveBps: bps ?? "0",
        maxPerActionUsdtWei: ceiling ?? "0",
        rescueReserveCount: count ?? "0",
      });
      void fetch(`/api/lending/guardable?${query.toString()}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const payload = await response.json() as { data?: unknown; error?: { message?: string; code?: string } };
          if (controller.signal.aborted) return;
          if (!response.ok) {
            setSizing(null);
            setSizingReason(payload.error?.message ?? payload.error?.code ?? `sizing read HTTP ${response.status}`);
            return;
          }
          const parsed = parseLendingGuardable(payload.data);
          if (parsed === INVALID || parsed.sizing === undefined) {
            setSizing(null);
            setSizingReason("the plane returned no sizing floors for these inputs");
            return;
          }
          setSizing(parsed);
          setSizingReason(null);
        })
        .catch(() => { if (!controller.signal.aborted) setSizingReason("the sizing floors could not be read"); });
    }, 1_200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [sizingKey]);

  /* ---- hire session plumbing (the LP machine, unchanged in shape) --------- */

  const stopPolling = React.useCallback(() => {
    pollGeneration.current += 1;
    if (pollTimer.current !== null) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const readWithCredential = React.useCallback(async (id: string, longLived = false): Promise<HireSessionView> => {
    const attempt = async (): Promise<HireSessionView> => {
      const nowMs = Date.now();
      let credential = readCredential.current;
      if (!credentialUsable(credential, nowMs)) {
        credential = rememberedHireReadCredential(hireStorage, nowMs)
          ?? (longLived
            ? await ensureHireReadCredential({ current: null, signEnvelope: owner.signEnvelope, storage: hireStorage, nowMs })
            : { mode: "signed", header: await owner.signReadHeader(id), expiryMs: nowMs + 120_000 });
        readCredential.current = credential;
      }
      if (credential === null) throw new Error("No read credential.");
      return readHireSession({ agentId: id, credential });
    };
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof HireReadRefused)) throw error;
      readCredential.current = null;
      try { hireStorage.removeItem("4lpha:account-read-expiry:v1"); } catch { /* private window */ }
      return await attempt();
    }
  }, [hireStorage, owner.signEnvelope, owner.signReadHeader]);

  /**
   * The owner-read credential, as HEADERS, for a read that is not `/session`.
   *
   * Same rule as `readWithCredential`: a live cookie window sends NO header (the
   * BFF forwards the HttpOnly bearer), and only a browser without one signs the
   * 120 s `read` envelope. FIXREVIEW F2's view read is the only caller.
   */
  const viewReadHeaders = React.useCallback(async (id: string): Promise<Record<string, string>> => {
    const nowMs = Date.now();
    let credential = readCredential.current;
    if (!credentialUsable(credential, nowMs)) {
      credential = rememberedHireReadCredential(hireStorage, nowMs)
        ?? { mode: "signed", header: await owner.signReadHeader(id), expiryMs: nowMs + 120_000 };
      readCredential.current = credential;
    }
    return credential !== null && credential.mode === "signed"
      ? { "x-owner-action": credential.header }
      : {};
  }, [hireStorage, owner.signReadHeader]);

  const beginPolling = React.useCallback(async (id: string) => {
    stopPolling();
    const generation = pollGeneration.current;
    const once = async () => {
      if (generation !== pollGeneration.current) throw new GridDeployStopped();
      const data = await readWithCredential(id);
      if (generation !== pollGeneration.current) throw new GridDeployStopped();
      setView(data);
      const step = hireResumeStep(data);
      if (step === "arm" || step === "terminal" || step === "fund-and-grant" || cancellationRecorded(data)) stopPolling();
      return data;
    };
    const current = await once();
    if (generation === pollGeneration.current
      && (hireResumeStep(current) === "poll" || hireResumeStep(current) === "converge")
      && !cancellationRecorded(current)) {
      pollTimer.current = setInterval(() => {
        void once().catch((error: unknown) => {
          if (generation !== pollGeneration.current) return;
          stopPolling();
          setMessage(error instanceof Error ? error.message : "Hire status is unavailable.");
        });
      }, 5_000);
    }
    return current;
  }, [readWithCredential, stopPolling]);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; resumed.current = false; activeRun.current?.stop(); stopPolling(); };
  }, [stopPolling]);

  React.useEffect(() => {
    if (resumed.current || owner.passkey === null) return;
    resumed.current = true;
    const saved = hireStorage.getItem(LENDING_HIRE_STORAGE_KEY);
    if (saved === null) return;
    const savedArmOutcome = loadArmOutcome(hireStorage, saved);
    setArmOutcome(savedArmOutcome);
    provisionEnvelope.current = loadProvisionEnvelope(hireStorage, saved);
    setAgentId(saved);
    setWorking("Checking the durable hire state before offering another grant…");
    void beginPolling(saved).then((resumedView) => {
      if (!mounted.current) return;
      if (!accountSwitchRequiresContinue(hireStorage) && resumedView !== undefined
        && hireResumeStep(resumedView) === "arm" && savedArmOutcome === null
        && !cancellationRecorded(resumedView) && !autoContinued.current) {
        autoContinued.current = true;
        void deployAll({ id: saved, view: resumedView });
      }
      if (resumedView !== undefined && (resumedView.status === "revoked" || resumedView.status === "retired")) {
        forgetLendingHire(hireStorage, saved);
        setAgentId(null);
        setView(null);
        setMessage(`The previous session (${saved}) is ${resumedView.status}. Starting a fresh hire.`);
      } else if (cancellationRecorded(resumedView)) {
        forgetLendingHire(hireStorage, saved);
      }
    }).catch((error: unknown) => {
      if (!mounted.current || error instanceof GridDeployStopped) return;
      setMessage(error instanceof Error ? error.message : "Hire status is unavailable.");
    }).finally(() => { if (mounted.current) setWorking(null); });
  }, [beginPolling, owner.passkey]);

  const mark = (key: DeployStepKey, state: DeployStepState, detail?: string): void => {
    setSteps((current) => ({ ...current, [key]: detail === undefined ? { state } : { state, detail } }));
  };

  const readSession = async (id: string, run: GridDeployRun): Promise<HireSessionView> => {
    const data = await run.guarded(() => readWithCredential(id, true));
    run.check();
    setView(data);
    return data;
  };

  const checkArmOwner = (run: GridDeployRun): void => {
    run.check();
    if (currentOwnerIdentity.current !== ownerIdentity) {
      run.stop();
      throw new GridDeployStopped();
    }
  };

  const readCurrentArm = async (id: string, run: GridDeployRun) => {
    checkArmOwner(run);
    const session = await run.guarded(() => readWithCredential(id, true));
    checkArmOwner(run);
    setView(session);
    if (hireResumeStep(session) !== "arm" || cancellationRecorded(session)) {
      throw new Error("This session is no longer ready to place a reserve. Refresh its agent page.");
    }
    const headers = await run.guarded(() => viewReadHeaders(id));
    checkArmOwner(run);
    const recovered = await run.guarded(() => recoverLendingArmParams({
      agentId: id, hireBudgetWei: session.hireSizing?.openNativeBudgetWei, headers,
    }));
    checkArmOwner(run);
    return recovered;
  };

  const loadPreview = async (): Promise<LendingPreview> => {
    if (owner.passkey === null || owner.walletAddress === undefined) {
      throw new Error("Create or recover your passkey wallet first.");
    }
    if (budgetWei <= 0n) throw new Error("Total capital must be positive.");
    const query = new URLSearchParams({
      walletAddress: owner.walletAddress,
      openNativeBudgetWei: budgetWei.toString(10),
      sizingPreset: HIRE_PROFILE,
    });
    const response = await fetch(`/api/agents/hire/preview?${query}`, { cache: "no-store" });
    const payload = await response.json() as { data?: LendingPreview };
    if (response.status === 404) {
      throw new Error("Hire is not enabled on this execution plane: start it with HIRE_ENABLED=true (requires PASSKEY_ENABLED, DATABASE_URL and EXECUTION_MASTER_KEY).");
    }
    if (!response.ok || payload.data === undefined) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
    return payload.data;
  };

  /**
   * The receipt, taken ≤30 s before S1 (R3.3(5)).
   *
   * It binds the account, the block, guardability, the debts AND every sizing
   * input, so S1 can verify that the hire it was handed equals the one the
   * floors were computed from. It is FRESH here, never the debounced copy the
   * exposure line renders — that one may be minutes old.
   */
  const loadReceipt = async (usdtCeiling: bigint): Promise<LendingGuardableView> => {
    const query = new URLSearchParams({
      account,
      budgetWei: budgetWei.toString(10),
      reserveBps: String(props.reserveBps),
      maxPerActionUsdtWei: usdtCeiling.toString(10),
      rescueReserveCount: String(props.rescueReserveCount),
    });
    const response = await fetch(`/api/lending/guardable?${query}`, { cache: "no-store" });
    const payload = await response.json() as { data?: unknown; error?: { message?: string; code?: string } };
    if (!response.ok) throw new Error(errorMessage(payload, `The guarded account could not be re-read (HTTP ${response.status}).`));
    const parsed = parseLendingGuardable(payload.data);
    if (parsed === INVALID) throw new Error("The guarded account read returned a shape this page cannot map.");
    if (!parsed.guardable) throw new Error("The guarded account is no longer guardable; nothing was signed.");
    if (parsed.sizing === undefined) throw new Error("The plane returned no sizing floors for this hire.");
    if (parsed.previewReceipt === undefined) {
      throw new Error("The execution plane issued no preview receipt (LENDING_PREVIEW_SECRET is not configured). A lending hire cannot be signed without it.");
    }
    return parsed;
  };

  /**
   * R3.13 — the PRE-SIGNATURE wallet gate.
   *
   * A guard hired onto a wallet that already carries a live agent is refused by
   * the plane's `walletConflict`, and by then the owner has signed a hire and
   * possibly funded a wallet. So the browser asks first, and refuses BEFORE the
   * `provisionAgent` signature and before any passkey wallet is created.
   */
  const assertWalletFree = async (run: GridDeployRun, base: string): Promise<readonly string[]> => {
    const taken: string[] = [];
    const header = await run.guarded(() => owner.signReadHeader("*"));
    const listed = await fetch("/api/agents", { headers: { "x-owner-action": header }, cache: "no-store" });
    type ListedAgent = { id: string; status?: unknown; walletAddress?: unknown };
    const rows = await listed.json() as { data?: { agents?: ListedAgent[] } | ListedAgent[] };
    if (!listed.ok) {
      throw new Error("Your agent list could not be read, so this wallet's occupancy is unknown. Nothing was signed.");
    }
    const agents = Array.isArray(rows.data) ? rows.data : rows.data?.agents ?? [];
    taken.push(...agents.map((agent) => agent.id));
    if (owner.walletAddress !== undefined
      && walletSharedWithLiveAgents({ agents, walletAddress: owner.walletAddress, excludingId: base })) {
      const neighbour = agents.find((agent) =>
        typeof agent.walletAddress === "string"
        && agent.walletAddress.toLowerCase() === owner.walletAddress?.toLowerCase()
        && agent.id !== base) ?? null;
      throw new LendingWalletBlockedError(neighbour === null ? null : neighbour.id);
    }
    return taken;
  };

  const startHire = async (run: GridDeployRun): Promise<{ readonly id: string; readonly view: HireSessionView } | null> => {
    setMessage(null);
    setWalletBlocked(null);
    setWorking("Reading the live funding estimate…");
    try {
      if (config === null) throw new Error(configReason ?? "The lending venue is not configured on this deployment.");
      if (form === null || !form.ok) throw new Error(form === null ? "The lending venue is not configured yet." : form.message);
      const fresh = await run.guarded(loadPreview);
      setPreview(fresh);
      const base = agentIdFromName(props.agentName);

      // BEFORE the hire signature, and before any wallet ceremony.
      setWorking("Checking that this wallet is free for its own guard…");
      const taken = [...await run.guarded(() => assertWalletFree(run, base))];

      setWorking("Re-reading the guarded account and taking the plane's sizing receipt…");
      /**
       * The receipt, and its AGE.
       *
       * W9: S1 refuses a receipt older than 30 s, and the id-collision loop
       * below can burn far more than that (a passkey prompt per attempt, plus
       * a hire-state read for the agent already holding the name). The receipt
       * is therefore re-taken inside the loop whenever it is older than 25 s —
       * five seconds of margin against the plane's own bound — rather than
       * signing an envelope that is certain to be refused.
       */
      const RECEIPT_MAX_AGE_MS = 25_000;
      let receipt = await run.guarded(() => loadReceipt(form.usdtCeilingWei));
      setSizing(receipt);
      let receiptAtMs = Date.now();
      const paramsFor = () => {
        const receiptSizing = receipt.sizing;
        if (receiptSizing === undefined) throw new Error("The plane returned no sizing floors for this hire.");
        if (!receiptSizing.ok) {
          throw new Error(receiptSizing.refusal ?? "The plane refused this hire's sizing.");
        }
        const grantCap = lendingUsdtGrantCap(receiptSizing.reserveCapFloorWei);
        if (grantCap === null) throw new Error("The USDT grant cap could not be calculated. Nothing was signed.");
        const capRefusal = lendingUsdtCapRefusal({ settings: form.settings, budgetWei: budgetWei.toString(10), reserveBps: props.reserveBps }, config.usdt, grantCap.toString(10), usdtDecimals);
        if (capRefusal !== null) throw new Error(`Max repay per event exceeds the proposed session cap of ${formatAtomicAmount(grantCap, usdtDecimals, usdtDecimals)} USDT. Lower it before hiring.`);
        return {
          walletAddress: owner.walletAddress!,
          token: config.usdt,
          capDayWei: receiptSizing.minimumCapDayWei,
          openNativeBudgetWei: budgetWei.toString(10),
          ttlSec: TTL_SEC,
          sizingPreset: HIRE_PROFILE,
          guardedAccount: receipt.account,
          debtMarkets,
          reserveCapWei: grantCap.toString(10),
          reserveBps: props.reserveBps,
          settings: form.settings,
          previewReceipt: receipt.previewReceipt!,
        };
      };
      let params = paramsFor();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        run.check();
        const id = nextFreeAgentId(base, taken);
        if (Date.now() - receiptAtMs > RECEIPT_MAX_AGE_MS) {
          setWorking("The plane's sizing receipt expired while this hire waited — taking a fresh one…");
          receipt = await run.guarded(() => loadReceipt(form.usdtCeilingWei));
          setSizing(receipt);
          receiptAtMs = Date.now();
          params = paramsFor();
        }
        const signatureNote = attempt === 0
          ? "Confirm the one off-chain hire signature with your passkey…"
          : `${taken[taken.length - 1] ?? base} is taken. Confirm the signature again to hire ${id}…`;
        setWorking(`${signatureNote} USDT daily cap: ${formatAtomicAmount(params.reserveCapWei, usdtDecimals, usdtDecimals)} USDT, including 10% quote headroom.`);
        const envelope = await run.guarded(() => owner.signEnvelope("provisionAgent", id, params));
        provisionEnvelope.current = envelope;
        saveProvisionEnvelope(hireStorage, id, envelope);
        hireStorage.setItem(LENDING_HIRE_STORAGE_KEY, id);
        const response = await fetch(`/api/agents/${encodeURIComponent(id)}/session`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
        });
        const payload = await response.json() as { data?: HireSessionView };
        if (response.ok && payload.data !== undefined) {
          const saved = hireStorage.getItem(LENDING_HIRE_STORAGE_KEY);
          if (!run.stopped || saved === null || saved === id) hireStorage.setItem(LENDING_HIRE_STORAGE_KEY, id);
        }
        run.check();
        // Only an id collision is "taken". `wallet_in_use`, `s1_ambiguous` and
        // every other 409 is a real refusal and must be SHOWN — retrying one
        // under the next name turns "wallet in use" into "every name is taken".
        const code = (payload as { error?: { code?: string } }).error?.code;
        if (response.status === 409 && code !== undefined && code !== "agent_exists") {
          throw new Error(errorMessage(payload, `HTTP ${response.status}`));
        }
        if (response.status === 409) {
          hireStorage.removeItem(provisionEnvelopeKey(id));
          provisionEnvelope.current = null;
          setWorking("An agent with this id already exists — reading its hire state…");
          let existing: HireSessionView;
          try {
            existing = await beginPolling(id);
          } catch (error) {
            if (error instanceof GridDeployStopped) throw error;
            const text = error instanceof Error ? error.message : "";
            if (!/not_found|HTTP 404/iu.test(text)) throw error;
            stopPolling();
            setView(null);
            setAgentId(null);
            taken.push(id);
            continue;
          }
          run.check();
          if (existing.status !== "revoked" && existing.status !== "retired") {
            hireStorage.setItem(LENDING_HIRE_STORAGE_KEY, id);
            setAgentId(id);
            return { id, view: existing };
          }
          stopPolling();
          setView(null);
          setAgentId(null);
          taken.push(id);
          continue;
        }
        if (!response.ok || payload.data === undefined) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
        hireStorage.setItem(LENDING_HIRE_STORAGE_KEY, id);
        // W1: the ACCEPTED hire's own numbers, persisted before anything is
        // funded. Written here and not before the POST so an id collision (the
        // `agent_exists` branch above) can never clobber the record belonging to
        // the agent that already holds that name.
        saveArmParams(hireStorage, id, {
          settings: params.settings,
          budgetWei: params.openNativeBudgetWei,
          reserveBps: params.reserveBps,
          reserveCapWei: params.reserveCapWei,
        });
        setAgentId(id);
        setView(payload.data);
        return { id, view: payload.data };
      }
      throw new Error(`Every candidate name around "${base}" is already claimed. Rename the agent and try again.`);
    } catch (error) {
      if (mounted.current && !run.stopped) {
        if (error instanceof LendingWalletBlockedError) setWalletBlocked(error.message);
        setMessage(error instanceof Error ? error.message : "The hire could not be prepared.");
      }
      throw error;
    } finally {
      if (mounted.current && !run.stopped) setWorking(null);
    }
  };

  const cancelHire = async () => {
    if (agentId === null || cancelling.current) return;
    cancelling.current = true;
    activeRun.current?.stop();
    stopPolling();
    setDeposit(false);
    setMessage(null);
    setWorking("Confirm the off-chain cancellation request with your passkey…");
    try {
      const cancelled = await cancelGridHire({
        agentId, signEnvelope: owner.signEnvelope, storage: hireStorage, storageKey: LENDING_HIRE_STORAGE_KEY,
      });
      hireStorage.removeItem(provisionEnvelopeKey(agentId));
      hireStorage.removeItem(armParamsKey(agentId));
      provisionEnvelope.current = null;
      confirmedArm.current = null;
      if (mounted.current) { setArmRecovered(null); setArmPastArm(null); }
      if (mounted.current) {
        setView(cancelled);
        setMessage(cancellationMessage(cancelled));
      }
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : "The cancellation request could not be recorded.");
    } finally {
      cancelling.current = false;
      if (mounted.current) setWorking(null);
    }
  };

  const guardBlocker = guardedAccountBlocker(props.guarded);
  const formBlocker = form === null
    ? configReason ?? "Reading the lending venue…"
    : form.ok ? null : form.message;
  const blocked = props.blockedReason
    ?? guardBlocker
    ?? formBlocker
    ?? (budgetWei <= 0n ? "Total capital must be positive." : null)
    ?? walletBlocked;

  const deployAll = async (seed?: { readonly id: string; readonly view: HireSessionView }): Promise<void> => {
    if (activeRun.current !== null || cancelling.current || (working !== null && seed === undefined)) return;
    if (blocked !== null) return;
    const run = new GridDeployRun();
    activeRun.current = run;
    stopPolling();
    setMessage(null);
    setRunning(true);
    setSteps(IDLE_STEPS);
    let id = seed?.id ?? agentId;
    try {
      if (owner.passkey === null || owner.walletAddress === undefined) {
        throw new Error("Create or recover your passkey wallet first.");
      }
      if (config === null || form === null || !form.ok) {
        throw new Error(configReason ?? "The lending form is not ready.");
      }

      let current = seed?.view ?? view;
      if (id === null || current === null) {
        mark("hire", "active", "Confirm the hire signature with your passkey…");
        const hired = await run.guarded(() => startHire(run));
        if (hired === null) throw new Error("The hire could not be prepared.");
        id = hired.id;
        current = hired.view;
      }
      mark("hire", "done", `Session key created for ${id}`);

      if (hireResumeStep(current) !== "arm") current = await readSession(id, run);
      if (current.cancelRequested === true) throw new Error(cancellationMessage(current));

      for (let tries = 0; tries < 8 && (current.missing ?? []).includes("evidence-unreadable") && current.cancelRequested !== true; tries += 1) {
        mark("hire", "active", `Session key created for ${id}. The relay or chain could not be read — retrying (${tries + 1}/8)…`);
        await run.wait(5_000);
        current = await readSession(id, run);
      }
      if ((current.missing ?? []).includes("evidence-unreadable")) {
        throw new Error("The relay or chain could not be read for 40 s. Nothing was granted; press Continue deploy to try again.");
      }
      mark("hire", "done", `Session key created for ${id}`);

      if (hireResumeStep(current) === "fund-and-grant") {
        let fresh = await run.guarded(loadPreview);
        setPreview(fresh);
        let gate = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
        const shortOf = (entry: LendingPreview): bigint => requiredLendingDepositWei({
          budgetWei: entry.sizing.openNativeBudgetWei,
          relayFeePerSubmitWei: entry.sizing.relayFeePerSubmitWei,
          funding: entry.funding,
        }).shortfallWei;
        if ((!gate.ok && gate.reason === "short") || (gate.ok && shortOf(fresh) > 0n)) {
          const need = shortOf(fresh);
          const sendWei = depositAmountWei(need);
          setDepositWei(sendWei);
          mark("fund", "active", `Sending ${depositAmountBnb(need)} BNB from your wallet to the agent wallet — confirm in your wallet.`);
          setDeposit(true);
          const balanceBefore = fresh.funding.balanceWei === null ? 0n : BigInt(fresh.funding.balanceWei);
          const expectedAfter = balanceBefore + sendWei;
          const landed = (entry: LendingPreview): boolean =>
            entry.funding.balanceWei !== null && BigInt(entry.funding.balanceWei) >= expectedAfter;
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            await run.wait(6_000);
            fresh = await run.guarded(loadPreview);
            setPreview(fresh);
            gate = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
            if (gate.ok && landed(fresh)) break;
          }
          if (!gate.ok || !landed(fresh)) {
            throw new Error("The agent wallet is still short of what the hire needs (reserve + registration + gas).");
          }
          setDeposit(false);
          setDepositWei(null);
          mark("fund", "done", "The wallet covers the reserve and the registration estimate.");
        } else if (!gate.ok) {
          throw new Error("The live funding estimate is stale or unreadable; press deploy again.");
        } else {
          mark("fund", "skipped", "The wallet already holds the reserve, the registration fee and the gas.");
        }

        const savedEnvelope = provisionEnvelope.current ?? loadProvisionEnvelope(hireStorage, id);
        if (savedEnvelope === null) {
          throw new Error("The original signed hire is unavailable. Cancel this hire safely and start again; no grant was submitted.");
        }
        provisionEnvelope.current = savedEnvelope;
        setWorking("Claiming the durable grant attempt...");
        const attemptResponse = await fetch(`/api/agents/${encodeURIComponent(id)}/session/grant-attempt`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(savedEnvelope),
        });
        const rawAttemptPayload = await attemptResponse.json() as unknown;
        const attemptPayload = rawAttemptPayload as {
          data?: HireSessionView & { readonly attemptId?: `0x${string}`; readonly mayInvoke?: boolean };
        };
        if (!attemptResponse.ok || attemptPayload.data === undefined || attemptPayload.data.attemptId === undefined) {
          throw new Error(errorMessage(rawAttemptPayload, `HTTP ${attemptResponse.status}`));
        }
        current = await readSession(id, run);
        if (current.grantAttempt?.attemptId.toLowerCase() !== attemptPayload.data.attemptId.toLowerCase()) {
          throw new Error("The durable grant attempt changed before invocation.");
        }
        if (attemptPayload.data.mayInvoke === true) {
          if (current.permissions === undefined || current.sessionPublicKey === undefined
            || current.sessionAddress === undefined || current.expiresAt === undefined) {
            throw new Error("The plane has not published the session permissions yet; press deploy again.");
          }
          mark("grant", "active", "Confirm the on-chain session grant with your passkey…");
          run.check();
          const grantStartedMs = Date.now();
          const grantClock = setInterval(() => {
            if (run.stopped || !mounted.current) return;
            const elapsed = Math.round((Date.now() - grantStartedMs) / 1000);
            if (elapsed >= 8) mark("grant", "active", `Grant submitted; the relay is carrying it to chain (${elapsed}s — this usually takes 1–3 minutes)…`);
          }, 2_000);
          try {
            const GRANT_CEILING_MS = 4 * 60_000;
            await run.guarded(() => Promise.race([
              grantAgentSession({
                record: owner.passkey!,
                walletAddress: owner.walletAddress!,
                permissions: {
                  calls: current!.permissions!.calls.map(grantCall),
                  spend: current!.permissions!.spend.map((spend) => ({
                    ...(spend.token === undefined ? {} : { token: getAddress(spend.token) }),
                    period: spend.period as "minute" | "hour" | "day" | "week" | "month" | "year",
                    limit: BigInt(spend.limit),
                  })),
                },
                expiry: current!.expiresAt!,
                sessionPublicKey: current!.sessionPublicKey!,
                sessionAddress: getAddress(current!.sessionAddress!),
              }),
              new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new GrantAgentSessionError("grant_pending")), GRANT_CEILING_MS);
              }),
            ]));
          } catch (error) {
            run.check();
            if (!(error instanceof GrantAgentSessionError) || !["grant_pending", "grant_unknown", "grant_failed"].includes(error.code)) throw error;
            mark("grant", "active", `${error.code}: checking chain evidence instead of re-granting…`);
          } finally {
            clearInterval(grantClock);
          }
          run.check();
          mark("grant", "done", "Submitted. The relay carries it to chain.");
        } else {
          mark("grant", "skipped", "A durable grant attempt already exists; checking evidence without re-granting.");
        }
      } else {
        mark("fund", "skipped", "Already funded.");
        mark("grant", "skipped", current.grantAttempt === undefined
          ? "The session is already granted."
          : "A durable grant attempt exists; checking evidence without re-granting.");
      }

      mark("converge", "active", "Waiting for relay, account, KeyStore and owner-binding evidence…");
      const convergeDeadline = Date.now() + 10 * 60_000;
      while (hireResumeStep(current) !== "arm" && Date.now() < convergeDeadline) {
        if (current.cancelRequested === true) throw new Error(cancellationMessage(current));
        if (hireResumeStep(current) === "terminal") {
          throw new Error(`This hire cannot continue (${current.missing?.join(", ") ?? current.status}).`);
        }
        await run.wait(5_000);
        current = await readSession(id, run);
      }
      if (hireResumeStep(current) !== "arm") {
        throw new Error("The grant evidence has not converged yet. Press deploy again to keep waiting; nothing is re-granted.");
      }
      mark("converge", "done", "The session is live on chain.");

      mark("arm", "active", "Swapping the reserve to USDT and supplying it to Venus…");
      // W1 / AUDIT G-M1: the arm signs THE VALUES S1 SIGNED, read back from
      // durable storage — never `form`/`props`, which after a reload are this
      // screen's defaults rather than the hire the owner funded.
      const persisted = loadArmParams(hireStorage, id);
      const confirmed = confirmedArm.current;
      const armParams: LendingArmValues | null = confirmed !== null && confirmed.agentId === id ? confirmed.values : persisted === null ? null : {
        settings: persisted.settings,
        budgetWei: persisted.budgetWei,
        reserveBps: persisted.reserveBps,
      };
      // The server's current signed settings supersede an old same-browser S1 cache too.
      const recovery = await readCurrentArm(id, run);
      if (recovery.kind === "past-arm") {
        setArmPastArm(recovery.reason);
        mark("arm", "skipped", recovery.reason);
        return;
      }
      if (recovery.kind === "refused") throw new Error(lendingArmRecoveryRefusal(recovery.reason));
      const capRefusal = lendingUsdtCapRefusal(recovery.values, config.usdt, recovery.reserveCapWei, usdtDecimals);
      if (capRefusal !== null) throw new Error(capRefusal);
      if (armParams === null || !sameLendingArmValues(armParams, recovery.values)) {
        confirmedArm.current = null;
        setArmRecovered({ agentId: id, values: recovery.values });
        mark("arm", "active", "Review the current signed settings, then confirm to place the reserve.");
        return;
      }
      const armValues = recovery.values;
      const armed = await run.guarded(() => armLendingAgent({
        agentId: id!,
        settings: armValues.settings,
        budgetWei: BigInt(armValues.budgetWei),
        reserveBps: armValues.reserveBps,
        signEnvelope: async (action, targetId, params) => {
          checkArmOwner(run);
          const signed = await run.guarded(() => owner.signEnvelope(action, targetId, params));
          checkArmOwner(run);
          return signed;
        },
        onNote: (note) => { if (!run.stopped && mounted.current && currentOwnerIdentity.current === ownerIdentity) mark("arm", "active", note); },
      }));
      checkArmOwner(run);
      // L9: a replayed envelope carries NO outcome. Nothing here may infer one —
      // the navigation below lands on the agent page, which re-reads
      // `GET /lending/view` and renders whatever the plane actually recorded.
      mark("arm", "done", armed.replayed
        ? "This arm was already submitted. Opening the agent page to read what the plane recorded…"
        : "Reserve placed.");

      forgetLendingHire(hireStorage, id);
      confirmedArm.current = null;
      if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!mounted.current || run.stopped || currentOwnerIdentity.current !== ownerIdentity) return;
      const text = error instanceof Error ? error.message : "The deploy could not be completed.";
      if (error instanceof LendingArmOutcomeError && id !== null) {
        const outcome = { status: error.status, reason: text } as const;
        saveArmOutcome(hireStorage, id, outcome);
        setArmOutcome(outcome);
        // A HELD arm is an AMBIGUOUS submission: a second arm is blocked
        // forever, so the owner belongs on the agent page where the guard's own
        // state is shown — not here with a retry that cannot run.
        if (error.status === "held") {
          if (mounted.current) setRunning(false);
          if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`);
          return;
        }
      }
      setSteps((current) => {
        const active = DEPLOY_STEPS.find(({ key }) => current[key].state === "active")?.key ?? "hire";
        return { ...current, [active]: { state: "failed", detail: text } };
      });
      setMessage(text);
    } finally {
      if (activeRun.current === run) activeRun.current = null;
      if (mounted.current && currentOwnerIdentity.current === ownerIdentity) {
        setRunning(false);
        if (!cancelling.current) setWorking(null);
      }
    }
  };

  const saveMaxRepay = async (): Promise<void> => {
    if (agentId === null || config === null || blocked !== null || working !== null || activeRun.current !== null || cancelling.current) return;
    const run = new GridDeployRun();
    activeRun.current = run;
    autoContinued.current = true;
    stopPolling();
    setRunning(true);
    setMessage("Reading the signed settings before saving your USDT max repay…");
    try {
      const saved = await saveLendingUsdtRepay({
        agentId, amountUsd: props.maxRepayUsd, usdt: config.usdt, decimals: usdtDecimals,
        readCurrent: () => readCurrentArm(agentId, run),
        signEnvelope: (action, id, params) => run.guarded(() => owner.signEnvelope(action, id, params)),
        check: () => checkArmOwner(run),
      });
      checkArmOwner(run);
      saveArmParams(hireStorage, agentId, { ...saved.values, reserveCapWei: saved.reserveCapWei });
      confirmedArm.current = null;
      setArmRecovered(null);
      hireStorage.removeItem(armOutcomeKey(agentId));
      setArmOutcome(null);
      setSteps(IDLE_STEPS);
      const ceiling = saved.values.settings.maxPerAction.find(cap => cap.token?.toLowerCase() === config.usdt.toLowerCase());
      setMessage(`Saved USDT max repay: ${formatAtomicAmount(ceiling!.maxWei, usdtDecimals, usdtDecimals)} USDT. Other signed settings are unchanged. You can now place the reserve.`);
    } catch (error) {
      if (mounted.current && !run.stopped && currentOwnerIdentity.current === ownerIdentity) setMessage(error instanceof Error ? error.message : "The settings could not be saved. No reserve was placed.");
    } finally {
      if (activeRun.current === run) activeRun.current = null;
      if (mounted.current && currentOwnerIdentity.current === ownerIdentity) setRunning(false);
    }
  };

  const resetGrantAttempt = async (): Promise<void> => {
    if (agentId === null || view?.grantAttempt === undefined || working !== null || running) return;
    setMessage(null);
    setWorking("Confirm the grant-attempt reset with your passkey...");
    try {
      const params = { attemptId: view.grantAttempt.attemptId } as const;
      const envelope = await owner.signEnvelope("resetGrantAttempt", agentId, params);
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/session/grant-attempt/reset`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
      });
      const payload = await response.json() as { data?: HireSessionView };
      if (!response.ok || payload.data === undefined) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
      setView(payload.data);
      setWorking(null);
      await deployAll({ id: agentId, view: payload.data });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The grant attempt could not be reset.");
      setWorking(null);
    }
  };

  const resetHire = () => {
    if (activeRun.current !== null || cancelling.current) return;
    stopPolling();
    if (agentId !== null) forgetLendingHire(hireStorage, agentId);
    provisionEnvelope.current = null;
    setAgentId(null);
    setView(null);
    setPreview(null);
    setArmOutcome(null);
    setMessage(null);
    setSteps(IDLE_STEPS);
    confirmedArm.current = null;
    setArmRecovered(null);
    setArmPastArm(null);
  };

  if (props.mode === "Demo") {
    return <div style={{ display: "grid", gap: 12, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
      <button type="button" style={primaryBtn} onClick={() => setMessage("Demo engine coming soon.")}>Deploy Lending Agent</button>
      {message ? <p style={{ color: "var(--text-subtle)", margin: 0 }}>{message}</p> : null}
    </div>;
  }

  const step = hireResumeStep(view);

  /* ---- the derived, read-only figures the owner sees BEFORE signing ------- */

  const receiptSizing = sizing?.sizing ?? null;
  const proposedGrantCap = receiptSizing === null ? null : lendingUsdtGrantCap(receiptSizing.reserveCapFloorWei);
  const dailyLimitWei = derivedDailyRepayLimitWei(props.rescueReserveCount, usdtCeilingWei);
  const exposure = receiptSizing === null || proposedGrantCap === null
    ? null
    : lendingExposureLine({
      reserveCapWei: proposedGrantCap,
      capDayWei: BigInt(receiptSizing.minimumCapDayWei),
      usdtDecimals,
    });

  const derived = <div data-testid="lending-derived" style={{ display: "grid", gap: 8, padding: 14, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", font: "var(--type-body-sm)", color: "var(--text-muted)" }}>
    <span><strong>Lending market</strong> · Venus</span>
    <span><strong>Repay from</strong> · {LENDING_REPAY_SOURCE_TEXT}</span>
    <span data-testid="lending-check-every"><strong>Check every</strong> · {lendingCheckEveryText(config?.workerIntervalMs)}</span>
    <span data-testid="lending-grant-cap"><strong>Estimated USDT daily cap</strong> · {proposedGrantCap === null ? "— waiting for a quote" : `${formatAtomicAmount(proposedGrantCap, usdtDecimals, usdtDecimals)} USDT · includes 10% quote headroom`}</span>
    {proposedGrantCap === null || receiptSizing === null ? null : <span data-testid="lending-grant-total"><strong>Seven-day cap total</strong> · {formatAtomicAmount(proposedGrantCap * 7n, usdtDecimals, usdtDecimals)} USDT + {formatEther(BigInt(receiptSizing.minimumCapDayWei) * 7n)} BNB</span>}
    <span>
      <strong>Daily repay limit (derived)</strong> ·{" "}
      {dailyLimitWei === null
        ? "— set Max repay per event and Rescues to reserve gas for"
        : `${formatAtomicAmount(dailyLimitWei, usdtDecimals, 2)} USDT — Rescues to reserve gas for × Max repay per event`}
    </span>
    <span data-testid="lending-exposure">
      <strong>Session exposure</strong> ·{" "}
      {exposure ?? `— ${sizingReason ?? "the plane has not quoted this hire's caps yet"}`}
    </span>
    <span style={{ color: "var(--text-subtle)" }}>{LENDING_CUSTODY_COPY}</span>
  </div>;

  if (step === "arm" && agentId !== null) {
    const openAgent = (id: string): void => { if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`); };
    const retryArm = (): void => {
      hireStorage.removeItem(armOutcomeKey(agentId));
      setArmOutcome(null);
      setMessage(null);
      void deployAll();
    };
    // FIXREVIEW F2: the values the plane holds for this hire, waiting to be
    // read by the owner. Confirming them is what authorises the passkey prompt.
    const recovered = armRecovered !== null && armRecovered.agentId === agentId ? armRecovered.values : null;
    const confirmRecoveredArm = (): void => {
      if (recovered === null) return;
      confirmedArm.current = { agentId, values: recovered };
      setArmRecovered(null);
      setMessage(null);
      void deployAll();
    };
    return <div style={{ display: "grid", gap: 12 }}>
      <p style={{ color: "var(--text-muted)", font: "var(--type-body-sm)", margin: 0 }}>
        {armOutcome?.status === "held"
          ? <>The reserve placement is held: the relay&apos;s answer was ambiguous, so a second arm is blocked. Continue from the agent page.</>
          : armPastArm !== null
            ? <>There is nothing left to place here: {armPastArm}. Open the agent page to see what the plane recorded.</>
            : armOutcome?.status === "rolled-back"
              ? <>The reserve placement rolled back before anything moved. The hire pointer is preserved and the arm can be retried.</>
              : <>Session <code>{agentId}</code> is live on chain. One step left: place the reserve with <code>lendingArm</code>. <strong>Until it is placed the guard holds nothing and can repay nothing.</strong></>}
      </p>
      {armOutcome !== null ? <p style={{ color: "var(--loss)", margin: 0 }}>{armOutcome.reason}</p> : null}
      {armOutcome?.status === "held" || armPastArm !== null ? null : <div style={{ display: "grid", gap: 8 }}>
        <span style={{ color: "var(--text-muted)", font: "var(--type-body-sm)" }}>Editing the form does not change the signed hire. Save the USDT max repay below first; all other signed settings, including any BNB ceiling, funded capital and reserve split, stay unchanged.</span>
        <div><button type="button" style={secondaryBtn} disabled={running || blocked !== null || working !== null} title={blocked ?? working ?? undefined} onClick={() => void saveMaxRepay()}>Save USDT max repay: {props.maxRepayUsd}</button></div>
      </div>}
      {recovered === null ? null : <div data-testid="lending-arm-recovered" style={{ display: "grid", gap: 8, padding: 14, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", font: "var(--type-body-sm)", color: "var(--text-muted)" }}>
        <span>{LENDING_ARM_RECOVERED_COPY}</span>
        <span><strong>Total capital</strong> · {formatEther(BigInt(recovered.budgetWei))} BNB</span>
        <span><strong>Reserve kept as BNB</strong> · {recovered.reserveBps / 100}%</span>
        <span><strong>Act below health factor</strong> · {formatUnits(BigInt(recovered.settings.triggerHf), 18)}</span>
        <span><strong>Restore health factor to</strong> · {formatUnits(BigInt(recovered.settings.targetHf), 18)}</span>
        <span><strong>Max repay per event</strong> · {recovered.settings.maxPerAction.map((cap) => cap.token === null
          ? `${formatAtomicAmount(cap.maxWei, 18, 4)} BNB`
          : `${formatAtomicAmount(cap.maxWei, usdtDecimals, 2)} USDT`).join(" · ")}</span>
        <span><strong>Cooldown between repays</strong> · {recovered.settings.minSecondsBetweenActions} s</span>
        <span><strong>Rescues to reserve gas for</strong> · {recovered.settings.rescueReserveCount}</span>
      </div>}
      <div>
        {armOutcome?.status === "held"
          ? <button type="button" style={primaryBtn} onClick={() => openAgent(agentId)}>Continue from the agent page</button>
          : armPastArm !== null
            ? <button type="button" style={primaryBtn} onClick={() => openAgent(agentId)}>Open the agent page</button>
            : <button type="button" style={{ ...busyBtn(running, primaryBtn), ...(blocked !== null ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}
              onClick={recovered !== null ? confirmRecoveredArm : armOutcome?.status === "rolled-back" ? retryArm : () => void deployAll()}
              disabled={running || blocked !== null} title={blocked ?? undefined}>
              {recovered !== null
                ? "Confirm these values and place the reserve"
                : armOutcome?.status === "rolled-back" ? "Retry placing the reserve" : "Place the reserve"}
            </button>}
      </div>
      {blocked !== null && armOutcome?.status !== "held" && armPastArm === null ? <p role="status" style={{ color: "var(--warn)", margin: 0 }}>{blocked}</p> : null}
      {running || Object.values(steps).some((entry) => entry.state !== "pending") ? <DeployProgress steps={steps} /> : null}
      {message && message !== armOutcome?.reason ? <p style={{ color: "var(--loss)" }}>{message}</p> : null}
      {armOutcome?.status === "held" || armPastArm !== null ? null : <div><button type="button" style={{ ...secondaryBtn, padding: "10px 16px", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" }} onClick={() => openAgent(agentId)}>Open the agent page without placing the reserve</button></div>}
    </div>;
  }

  const funding = preview?.funding ?? view?.funding;
  const fundsWallet: FundsWallet | null = owner.walletAddress === undefined ? null : {
    address: owner.walletAddress,
    custodyModel: "passkey",
    depositable: true,
    source: "declared",
    availableUsdMicros: null,
    deployedUsdMicros: "0",
    deployedReason: "declared",
  };

  return <div style={{ display: "grid", gap: 14, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
    <span className="fl-eyebrow">Hire the scoped agent session</span>
    {agentId !== null ? <p style={{ margin: 0 }}>Setup for <strong>{agentId}</strong></p> : null}
    {derived}
    {view?.permissions ? <div style={{ display: "grid", gap: 6, color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      <p>This session may call {view.permissions.calls.length} reviewed contract permission{view.permissions.calls.length === 1 ? "" : "s"}.</p>
      <p>The session expires {view.expiresAt ? new Date(view.expiresAt * 1_000).toLocaleString() : "after seven days"}. You can revoke it at any time.</p>
    </div> : null}
    {funding ? <div style={{ color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      <p>The current estimate is {formatEther(BigInt(funding.requiredWei))} BNB: {funding.registrations} registration{funding.registrations === 1 ? "" : "s"} at {formatEther(BigInt(funding.registrationFeeWei))} BNB, plus {formatEther(BigInt(funding.relayGasHeadroomWei))} BNB headroom — on top of the reserve itself.</p>
      <p>Wallet balance at {new Date(funding.observedAtSec * 1_000).toLocaleTimeString()}: {funding.balanceWei === null ? "unreadable" : `${formatEther(BigInt(funding.balanceWei))} BNB`}. This is an estimate, not a guaranteed fee.</p>
    </div> : null}
    {step === "s1" || step === "fund-and-grant" || step === "converge" || (step === "poll" && view?.cancelRequested !== true) ? <div style={{ display: "grid", gap: 12 }}>
      <button type="button" style={busyBtn(running || working !== null || blocked !== null, primaryBtn)} onClick={() => void deployAll()} disabled={running || working !== null || blocked !== null}>
        {running ? "Deploying…" : step === "s1" ? "Deploy Lending Agent" : "Continue deploy"}
      </button>
      {blocked !== null ? <p role="alert" style={{ color: "var(--loss)", margin: 0 }}>{blocked}</p> : null}
      {walletBlocked !== null ? <p role="alert" style={{ color: "var(--loss)", margin: 0 }}>
        {walletBlocked}{" "}
        <a href="/account" style={{ color: "inherit", textDecoration: "underline" }} onClick={(event) => { if (props.go) { event.preventDefault(); props.go("/account"); } }}>Create account</a>
      </p> : null}
      {running || Object.values(steps).some((entry) => entry.state !== "pending") ? <DeployProgress steps={steps} /> : null}
    </div> : null}
    {(step === "poll" || step === "converge") && view !== null ? <p>{view.cancelRequested === true ? cancellationMessage(view) : pollStatusText(view)}</p> : null}
    {view?.status === "provisioning" && view.cancelRequested !== true ? <button type="button" style={busyBtn(working !== null && !running, secondaryBtn)} onClick={() => void cancelHire()} disabled={working !== null && !running}>Cancel hire safely</button> : null}
    {cancellationRecorded(view) && step !== "terminal" ? <button type="button" style={secondaryBtn} disabled={running || working !== null} onClick={resetHire}>Start a new hire</button> : null}
    {step === "converge" && view?.grantAttempt !== undefined && working === null && !running ? <button type="button" style={secondaryBtn}
      onClick={() => void resetGrantAttempt()}>Reset stalled grant attempt</button> : null}
    {(step === "poll" || step === "converge") && view?.cancelRequested !== true ? <button type="button" style={secondaryBtn} disabled={running || working !== null} onClick={() => {
      if (agentId === null) return;
      setWorking("Checking hire status…");
      void beginPolling(agentId).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Hire status is unavailable.")).finally(() => setWorking(null));
    }}>Check hire status</button> : null}
    {step === "terminal" ? <div style={{ display: "grid", gap: 10, justifyItems: "start" }}>
      <p style={{ margin: 0 }}>{view?.missing?.includes("permissions-differ") ? "The permissions differ: revoke the session on chain and hire again." : `This hire cannot continue (${view?.missing?.join(", ") ?? view?.status}).`}</p>
      <button type="button" style={secondaryBtn} disabled={running || working !== null} onClick={resetHire}>Start a new hire</button>
    </div> : null}
    {working ? <p>{working}</p> : null}
    {message && message !== walletBlocked ? <p style={{ color: "var(--loss)" }}>{message}{blockerHref === null ? null : <> {" "}<a href={blockerHref} style={{ color: "inherit", textDecoration: "underline" }} onClick={(event) => { if (props.go) { event.preventDefault(); props.go(blockerHref); } }}>Open agent</a></>}</p> : null}
    {deposit && fundsWallet ? <FundsModal open onClose={() => {
      activeRun.current?.stop();
      setDeposit(false);
      setDepositWei(null);
      setMessage("Deposit closed. Continue deploy when ready, or cancel the hire.");
    }} wallet={fundsWallet} connectedAddress={connectedAddress} passkey={owner.passkey} ownerAddress={owner.ownerAddress} initialTab="deposit"
      {...(depositWei === null ? {} : { fixedDepositWei: depositWei, autoSubmitDeposit: true })}
      onDepositSubmitted={() => { mark("fund", "active", "Deposit sent. Waiting for it to land in the agent wallet…"); setDeposit(false); }} /> : null}
  </div>;
}
