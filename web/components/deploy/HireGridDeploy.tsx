"use client";
import { accountHireStorage, accountSwitchRequiresContinue, assertHireOwner } from "@/lib/exec/account-hire-storage";

import { walletBlockerAgentId } from "@/lib/altana/hire-wallet-blocker";

import * as React from "react";
import { formatEther, getAddress, keccak256, stringToBytes, type Address } from "viem";
import { useAccount } from "wagmi";
import { FundsModal, type FundsWallet } from "@/components/FundsModal";
import { grantAgentSession, GrantAgentSessionError } from "@/lib/altana/client";
import { freshFundingGate, hireResumeStep, type HireFunding, type HireSessionView } from "@/lib/altana/hire-state";
import { credentialUsable, ensureHireReadCredential, HireReadRefused, pollStatusText, readHireSession, rememberedHireReadCredential, type HireReadCredential } from "@/lib/altana/hire-read-session";
import { rememberReadExpiry } from "@/lib/exec/read-session-window";
import { cancelGridHire, cancellationMessage, cancellationRecorded, forgetGridHire, GRID_HIRE_CHOICES_STORAGE_KEY, GridDeployRun, GridDeployStopped, type GridHireChoices } from "@/lib/altana/grid-hire-recovery";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import { deriveGridFromPreset, FEE_TO_TICK_SPACING, parseBnbToWei } from "@/lib/grid/geometry";
import { buildShiftGridSettings } from "@/lib/grid/settings";
import { canonicalEncode, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import { depositAmountBnb, depositAmountWei, requiredDepositWei } from "@/lib/altana/hire-funding";
import { armGridAgent, GridDeployActions, UI_PRESET_TO_GEOMETRY, type LivePool } from "./GridLiveDeploy";

/** Same primitive as GridLiveDeploy's deploy button, so Live mode keeps one visual language. */
const primaryBtn: React.CSSProperties = { cursor: "pointer", padding: "14px 22px", borderRadius: "var(--radius-sm)", background: "var(--cat-grid)", border: "none", color: "#08110c", font: "var(--weight-medium) var(--text-md)/1 var(--font-sans)" };
const secondaryBtn: React.CSSProperties = { ...primaryBtn, background: "transparent", color: "var(--cat-grid)", border: "1px solid var(--cat-grid)" };
const busyBtn = (busy: boolean, base: React.CSSProperties): React.CSSProperties => (busy ? { ...base, cursor: "wait", opacity: 0.6 } : base);

/** The reviewed hire profile this UI signs: the PHASE3.22/3.25 shift grid. */
const HIRE_PROFILE = "grid-shift-v1" as const;

type Preview = {
  readonly capDayWei: string;
  readonly sizing: {
    readonly name: "grid-v1" | "grid-shift-v1" | "lp-v1";
    readonly version: 1;
    readonly openNativeBudgetWei: string;
    readonly feeWei: string;
    readonly relayFeePerSubmitWei: string;
    readonly reserves: { readonly exitWei: string; readonly protectWei: string; readonly gridFlipWei: string; readonly totalWei: string };
  };
  readonly funding: HireFunding;
};

function agentIdFromName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96);
  return slug === "" ? "grid-agent" : slug;
}

/**
 * The id a NEW hire is provisioned under: the readable slug, then `-2`, `-3`,
 * … for as long as the owner already holds one.
 *
 * WHY IT NUMBERS: an agent id is permanent and owner-scoped, so the bare slug
 * made "Grid Agent 01" hireable exactly ONCE. Hiring again after revoking — the
 * ordinary thing to do when a grid finishes — collided with the retired row,
 * and because a 409 carries no status the screen resumed a dead session and
 * showed "This hire cannot continue (revoked)" over a form the owner had just
 * filled in. A random suffix would also have avoided that, at the cost of ids
 * nobody can read; numbering keeps `grid-agent-01`, `grid-agent-01-2` legible
 * and is what an owner running several of the same model expects to see.
 *
 * `taken` is the owner's OWN agent list, which includes revoked and retired
 * rows — an id stays claimed after the session ends, and that is precisely the
 * case this exists for.
 */
export function nextFreeAgentId(base: string, taken: readonly string[]): string {
  const claimed = new Set(taken);
  if (!claimed.has(base)) return base;
  for (let n = 2; n <= 999; n += 1) {
    const candidate = `${base}-${n}`;
    if (!claimed.has(candidate)) return candidate;
  }
  throw new Error("Too many agents share this name; rename this one.");
}

function poolToken(pool: LivePool): Address {
  return getAddress(pool.wbnbIsToken0 ? pool.token1 : pool.token0);
}

function armPlanDigest(plan: Record<string, unknown>): `0x${string}` {
  return keccak256(stringToBytes(canonicalEncode(plan)));
}

function buildGridArmPlan(pool: LivePool, choices: GridDeployChoiceSnapshot): Record<string, unknown> | null {
  if (pool.fee === null || FEE_TO_TICK_SPACING[pool.fee] === undefined) {
    return null;
  }
  const tickSpacing = FEE_TO_TICK_SPACING[pool.fee];
  const derived = deriveGridFromPreset({
    presetId: UI_PRESET_TO_GEOMETRY[choices.uiPresetId] ?? "standard",
    spreadFactor: 1,
    currentTick: 0,
    tickSpacing,
    wbnbIsToken0: pool.wbnbIsToken0,
  });
  const settings = buildShiftGridSettings({
    pool: { token0: pool.token0, token1: pool.token1, fee: pool.fee },
    wbnbIsToken0: pool.wbnbIsToken0,
    tickSpacing,
    buyRange: derived.buyRange,
    sellRange: derived.sellRange,
    stopLossPct: choices.stopLossPct,
    takeProfitPct: choices.takeProfitPct,
    gapTicks: derived.gapTicks,
    widthTicks: derived.widthTicks,
    deployPctBps: choices.utilizationPct * 100,
    shiftsPerDay: choices.maxRequotesDaily,
  });
  const grid = settings["grid"];
  if (typeof grid !== "object" || grid === null || Array.isArray(grid)) throw new Error("The signed grid plan has no grid block.");
  const { buyRange: _buyRange, sellRange: _sellRange, ...planGrid } = grid as Record<string, unknown>;
  void _buyRange;
  void _sellRange;
  return {
    kind: "grid",
    settings: { ...settings, grid: planGrid },
    budgetWei: parseBnbToWei(choices.capitalBnb).toString(10),
    levels: 2,
  };
}

function gridContinuationMatches(
  envelope: OwnerActionEnvelope,
  view: HireSessionView,
  agentId: string,
  owner: string | undefined,
  wallet: string | undefined,
): boolean {
  try {
    assertHireOwner(envelope, owner, wallet);
    const params = envelope.params;
    if (envelope.signed.action !== "provisionAgent" || envelope.signed.agentId !== agentId
      || typeof params !== "object" || params === null || Array.isArray(params)) return false;
    const plan = (params as { readonly armPlan?: { readonly digest?: unknown; readonly params?: unknown } }).armPlan;
    if (plan === undefined || plan.digest !== view.armPlan?.digest) return false;
    return typeof plan.params === "object" && plan.params !== null && !Array.isArray(plan.params)
      && (plan.params as { readonly kind?: unknown }).kind === "grid";
  } catch {
    return false;
  }
}

function saveGridArmPlanFallback(storage: Storage, agentId: string): void {
  const raw = storage.getItem(GRID_HIRE_CHOICES_STORAGE_KEY);
  if (raw === null) return;
  try {
    const choices = JSON.parse(raw) as GridHireChoices;
    if (choices.version === 1 && choices.agentId === agentId) {
      storage.setItem(GRID_HIRE_CHOICES_STORAGE_KEY, JSON.stringify({ ...choices, armPlanFallback: "signed" } satisfies GridHireChoices));
    }
  } catch { /* malformed local state cannot authorize or select a continuation */ }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: { code?: string; message?: string } }).error;
  return error?.message ?? error?.code ?? fallback;
}

type GrantCallPermission =
  | { readonly to: Address; readonly signature: string }
  | { readonly to: Address }
  | { readonly signature: string };

function grantCall(call: { readonly to?: string; readonly signature?: string }): GrantCallPermission {
  if (call.to !== undefined && call.signature !== undefined) return { to: getAddress(call.to), signature: call.signature };
  if (call.to !== undefined) return { to: getAddress(call.to) };
  if (call.signature !== undefined) return { signature: call.signature };
  throw new Error("The plane returned an empty call permission.");
}


/* ── The one-press deploy: its steps, and the panel that shows them ──────── */

type DeployStepKey = "hire" | "fund" | "grant" | "converge" | "arm";
type DeployStepState = "pending" | "active" | "done" | "failed" | "skipped";
type DeployStep = { readonly state: DeployStepState; readonly detail?: string };

const DEPLOY_STEPS: readonly { readonly key: DeployStepKey; readonly title: string; readonly hint: string }[] = [
  { key: "hire", title: "Sign the hire", hint: "One passkey signature creates the scoped session key and read session" },
  { key: "fund", title: "Fund the agent wallet", hint: "Only when the wallet cannot cover the registration fee" },
  { key: "grant", title: "Grant the session on chain", hint: "Your passkey authorises the session; the relay submits it" },
  { key: "converge", title: "Verify the grant", hint: "Relay, account, KeyStore and owner binding must all agree" },
  { key: "arm", title: "Arm the grid", hint: "Placed from your signed plan — no further signature" },
];

const STEP_MARK: Record<DeployStepState, string> = {
  pending: "○", active: "◐", done: "●", failed: "✕", skipped: "–",
};

function DeployProgress({ steps }: { readonly steps: Record<DeployStepKey, DeployStep> }) {
  return (
    <div style={{ display: "grid", gap: 2, padding: 12, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      {DEPLOY_STEPS.map(({ key, title, hint }, index) => {
        const step = steps[key];
        const colour = step.state === "done" ? "var(--profit)"
          : step.state === "failed" ? "var(--loss)"
            : step.state === "active" ? "var(--cat-grid)" : "var(--text-subtle)";
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

const IDLE_STEPS: Record<DeployStepKey, DeployStep> = {
  hire: { state: "pending" }, fund: { state: "pending" }, grant: { state: "pending" },
  converge: { state: "pending" }, arm: { state: "pending" },
};

/**
 * The Demo / Live SPLIT (fix-review finding 2).
 *
 * The live hire component registers resume effects — a durable pointer read, a
 * status poll, an auto-continue that can drive toward `armGridAgent` — on
 * MOUNT. Returning the Demo branch from inside it left every one of those
 * registered and running while Demo was on screen: with a remembered hire and
 * an expired read credential it could still reach `owner.signReadHeader`, and
 * a live continuation already in flight was not stopped by switching modes.
 *
 * Rules of hooks mean the guard cannot simply move above them, so the split is
 * STRUCTURAL: Demo renders a component that has no live hooks at all, and the
 * live one is UNMOUNTED — its cleanup running, its polling stopped, its active
 * run aborted — the moment the toggle moves.
 */
export function HireGridDeploy(props: React.ComponentProps<typeof HireGridDeployLive>) {
  if (props.mode === "Demo") {
    const { utilizationPct, maxRequotesDaily, onRestoreChoices, ...demoProps } = props;
    return <GridDeployActions {...demoProps} />;
  }
  return <HireGridDeployLive {...props} />;
}

type GridDeployChoiceSnapshot = Pick<GridHireChoices, "capitalBnb" | "uiPresetId" | "utilizationPct" | "maxRequotesDaily" | "takeProfitPct" | "stopLossPct">;

function HireGridDeployLive(props: {
  readonly mode: "Demo" | "Live";
  readonly agentName: string;
  readonly uiPresetId: string;
  readonly pool: LivePool | null;
  readonly capitalBnb: string;
  readonly utilizationPct: number;
  readonly maxRequotesDaily: number;
  readonly takeProfitPct: number;
  readonly stopLossPct: number;
  /** In-app router from KitApp. Routing is React state, not the URL, so a location change would 404. */
  readonly go?: (route: string) => void;
  /** Set when the form itself is invalid (capital under the pool's floor): the hire cannot start. */
  readonly blockedReason?: string | null;
  readonly onRestoreChoices?: (choices: GridHireChoices) => void;
}) {
  const owner = useOwnerActions();
  const hireStorage = React.useMemo(() => accountHireStorage(typeof window === "undefined" ? undefined : window.localStorage, owner.ownerAddress), [owner.ownerAddress]);
  const { address: connectedAddress } = useAccount();
  // GRID-GAS-RESERVE W1 — whether another live agent may share the agent wallet.
  // Defaults to TRUE and becomes false only after a fresh provision succeeds.
  // A resumed run keeps the conservative default because no new occupancy proof
  // is taken in this browser step.
  const sharedPot = React.useRef(true);
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<HireSessionView | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [deposit, setDeposit] = React.useState(false);
  const [depositWei, setDepositWei] = React.useState<bigint | null>(null);
  const [armPlanFallback, setArmPlanFallback] = React.useState(false);
  const autoContinued = React.useRef(false);
  // The one-press run: every step the owner would otherwise have clicked
  // through, driven in order and reported as it happens.
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

  const stopPolling = React.useCallback(() => {
    pollGeneration.current += 1;
    if (pollTimer.current !== null) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const clearReadCredential = React.useCallback(() => {
    readCredential.current = null;
    try { hireStorage.removeItem("4lpha:account-read-expiry:v1"); } catch { /* private window */ }
  }, [hireStorage]);

  const ensureLongLivedCredential = React.useCallback(async <T,>(
    run: GridDeployRun,
    target: "*" | string,
    read: (credential: HireReadCredential) => Promise<T>,
  ): Promise<T> => {
    const attempt = async (): Promise<T> => {
      run.check();
      const nowMs = Date.now();
      let credential = readCredential.current;
      if (!credentialUsable(credential, nowMs, target)) {
        credential = await run.guarded(() => ensureHireReadCredential({
          current: credential,
          target,
          signEnvelope: owner.signEnvelope,
          storage: hireStorage,
          nowMs,
        }));
        readCredential.current = credential;
      }
      if (credential === null) throw new Error("No read credential.");
      return run.guarded(() => read(credential));
    };
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof HireReadRefused) || error.status !== 401) throw error;
      clearReadCredential();
      if (!mounted.current) throw new GridDeployStopped();
      run.check();
      return attempt();
    }
  }, [clearReadCredential, hireStorage, owner.signEnvelope]);

  /**
   * Every hire read goes through here. Short-lived resume reads retain their
   * existing signed fallback; the deploy run uses the shared long-lived helper
   * so the list and convergence poll cannot establish different credentials.
   */
  const readWithCredential = React.useCallback(async (id: string, longLived = false, run?: GridDeployRun): Promise<HireSessionView> => {
    if (longLived && run !== undefined) {
      return ensureLongLivedCredential(run, id, (credential) => readHireSession({ agentId: id, credential }));
    }
    const attempt = async (): Promise<HireSessionView> => {
      const nowMs = Date.now();
      let credential = readCredential.current;
      if (!credentialUsable(credential, nowMs, id)) {
        credential = rememberedHireReadCredential(hireStorage, nowMs)
          ?? { mode: "signed", target: id, header: await owner.signReadHeader(id), expiryMs: nowMs + 120_000 };
        readCredential.current = credential;
      }
      if (credential === null) throw new Error("No read credential.");
      return readHireSession({ agentId: id, credential });
    };
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof HireReadRefused) || error.status !== 401) throw error;
      clearReadCredential();
      // FIX-REVIEW-2 FINDING 2: a late refusal must not open a prompt after
      // this component has unmounted.
      if (!mounted.current) throw new GridDeployStopped();
      return attempt();
    }
  }, [clearReadCredential, ensureLongLivedCredential, hireStorage, owner.signReadHeader]);

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
    if (generation === pollGeneration.current && hireResumeStep(current) === "poll" && !cancellationRecorded(current)) {
      pollTimer.current = setInterval(() => { void once().catch((error: unknown) => {
        if (generation !== pollGeneration.current) return;
        stopPolling();
        setMessage(error instanceof Error ? error.message : "Hire status is unavailable.");
      }); }, 5_000);
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
    const saved = hireStorage.getItem("4lpha:grid-hire:v1");
    if (saved === null) return;
    setAgentId(saved);
    setWorking("Checking the durable hire state before offering another grant…");
    let restoredChoices: GridHireChoices | null = null;
    const rawChoices = hireStorage.getItem(GRID_HIRE_CHOICES_STORAGE_KEY);
    if (rawChoices !== null) {
      try {
        const parsed: unknown = JSON.parse(rawChoices);
        if (parsed !== null && typeof parsed === "object") {
          const candidate = parsed as Partial<GridHireChoices>;
          if (candidate.version === 1 && candidate.agentId === saved
            && typeof candidate.uiPresetId === "string" && typeof candidate.capitalBnb === "string"
            && typeof candidate.utilizationPct === "number" && typeof candidate.maxRequotesDaily === "number"
            && typeof candidate.takeProfitPct === "number" && typeof candidate.stopLossPct === "number") {
            restoredChoices = candidate as GridHireChoices;
            setArmPlanFallback(restoredChoices.armPlanFallback === "signed");
            if (restoredChoices.provisionEnvelope !== undefined) {
              assertHireOwner(restoredChoices.provisionEnvelope, owner.ownerAddress, owner.walletAddress);
              provisionEnvelope.current = restoredChoices.provisionEnvelope;
            }
            props.onRestoreChoices?.(restoredChoices);
          }
        }
      } catch { /* A malformed snapshot cannot authorize a resumed arm. */ }
    }
    void beginPolling(saved).then((resumedView) => {
      if (!mounted.current) return;
      // A FINISHED session is not a broken hire: `revoked`/`retired` is the
      // lifecycle's own end, and the pointer in local storage is the only
      // reason it is still on screen. Drop it and offer a fresh hire, instead
      // of showing the last agent's tombstone above a form the owner just
      // filled in. Every other terminal state (permissions-differ, expired,
      // wallet-owner-mismatch) still needs the owner to act on THAT agent, so
      // it is left exactly where it is.
      if (!accountSwitchRequiresContinue(hireStorage) && restoredChoices !== null && props.pool !== null
        && resumedView !== undefined && hireResumeStep(resumedView) === "arm"
        && (resumedView.armPlan === undefined || resumedView.armPlan.claim === null)
        && !cancellationRecorded(resumedView) && !autoContinued.current) {
        autoContinued.current = true;
        void deployAll({ id: saved, view: resumedView, choices: restoredChoices });
      }
      if (resumedView !== undefined && (resumedView.status === "revoked" || resumedView.status === "retired")) {
        forgetGridHire(hireStorage, saved);
        setAgentId(null);
        setView(null);
        setMessage(`The previous session (${saved}) is ${resumedView.status}. Starting a fresh hire.`);
      } else if (cancellationRecorded(resumedView)) {
        forgetGridHire(hireStorage, saved);
      }
    }).catch((error: unknown) => {
      if (!mounted.current || error instanceof GridDeployStopped) return;
      setMessage(error instanceof Error ? error.message : "Hire status is unavailable.");
    }).finally(() => { if (mounted.current) setWorking(null); });
  }, [beginPolling, owner.passkey, props.onRestoreChoices, props.pool]);

  React.useEffect(() => {
    if (view?.status !== "armed" || preview !== null || props.pool === null || owner.walletAddress === undefined) return;
    let current = true;
    void loadPreview(props.capitalBnb).then((result) => { if (current) setPreview(result); }).catch(() => undefined);
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.status, preview, props.pool, owner.walletAddress]);

  const loadPreview = async (capitalBnb: string): Promise<Preview> => {
    if (owner.passkey === null || owner.walletAddress === undefined) throw new Error("Create or recover your passkey wallet first.");
    if (props.pool === null) throw new Error("Select a pool first.");
    const openNativeBudgetWei = parseBnbToWei(capitalBnb);
    if (openNativeBudgetWei <= 0n) throw new Error("Total capital must be positive.");
    const query = new URLSearchParams({ walletAddress: owner.walletAddress, openNativeBudgetWei: openNativeBudgetWei.toString(10), sizingPreset: HIRE_PROFILE });
    const response = await fetch(`/api/agents/hire/preview?${query}`, { cache: "no-store" });
    const payload = await response.json() as { data?: Preview };
    if (response.status === 404) {
      throw new Error("Hire is not enabled on this execution plane: start it with HIRE_ENABLED=true (requires PASSKEY_ENABLED, DATABASE_URL and EXECUTION_MASTER_KEY).");
    }
    if (!response.ok || payload.data === undefined) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
    return payload.data;
  };

  const startHire = async (run: GridDeployRun, chosen: GridDeployChoiceSnapshot, pool: LivePool, agentName: string): Promise<{ readonly id: string; readonly view: HireSessionView } | null> => {
    setMessage(null);
    setWorking("Reading the live cap and funding estimate…");
    try {
      const fresh = await run.guarded(() => loadPreview(chosen.capitalBnb));
      setPreview(fresh);
      // The first S1 uses the readable slug. A global-id 409 is handled below by
      // trying the next suffix; no owner list is needed before the hire.
      const base = agentIdFromName(agentName);
      const taken: string[] = [];
      const plan = buildGridArmPlan(pool, chosen);
      const params = {
        walletAddress: owner.walletAddress!,
        token: poolToken(pool),
        capDayWei: fresh.capDayWei,
        openNativeBudgetWei: fresh.sizing.openNativeBudgetWei,
        ttlSec: 604_800,
        sizingPreset: HIRE_PROFILE,
        ...(plan === null ? {} : { armPlan: { params: plan, digest: armPlanDigest(plan) } }),
      };
      // A 409 can race another owner, so take the NEXT number rather than
      // parking on the row that answered it. Three attempts keep the prompt
      // bounded.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        run.check();
        const id = nextFreeAgentId(base, taken);
        setWorking(attempt === 0
          ? "Confirm the one off-chain hire signature with your passkey…"
          : `${taken[taken.length - 1] ?? base} is taken. Confirm the signature again to hire ${id}…`);
        const envelope = await run.guarded(() => owner.signEnvelope("provisionAgent", id, params));
        const response = await fetch(`/api/agents/${encodeURIComponent(id)}/session`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
        });
        const payload = await response.json() as { data?: HireSessionView; error?: { code?: string; message?: string } };
        // Preserve a successful S1 even if navigation stopped this run while
        // the request was in flight; never continue from it into a grant.
        if (response.ok && payload.data !== undefined) {
          // A successful fresh passkey provision excludes another occupying row for this owner and wallet under walletConflict; the browser's deposit can credit its balance.
          sharedPot.current = false;
          provisionEnvelope.current = envelope;
          setArmPlanFallback(false);
          const saved = hireStorage.getItem("4lpha:grid-hire:v1");
          if (!run.stopped || saved === null || saved === id) {
            hireStorage.setItem("4lpha:grid-hire:v1", id);
            hireStorage.setItem(GRID_HIRE_CHOICES_STORAGE_KEY, JSON.stringify({ version: 1, agentId: id, ...chosen, provisionEnvelope: envelope } satisfies GridHireChoices));
            const expiry = payload.data.readSession?.expiry;
            if (typeof expiry === "number") rememberReadExpiry(hireStorage, expiry * 1_000);
          }
        }
        run.check();
        if (response.status === 409 && payload.error?.code === "agent_exists") {
          const owned = (payload as { readonly meta?: { readonly owned?: boolean } }).meta?.owned === true;
          if (!owned) {
            taken.push(id);
            continue;
          }
          const existing = payload.data;
          if (existing === undefined) {
            taken.push(id);
            continue;
          }
          if (existing.status === "revoked" || existing.status === "retired") {
            taken.push(id);
            continue;
          }
          hireStorage.setItem("4lpha:grid-hire:v1", id);
          const rawAccepted = hireStorage.getItem(GRID_HIRE_CHOICES_STORAGE_KEY);
          if (rawAccepted !== null) {
            try {
              const accepted = JSON.parse(rawAccepted) as GridHireChoices;
              if (accepted.version === 1 && accepted.agentId === id && accepted.provisionEnvelope !== undefined) {
                assertHireOwner(accepted.provisionEnvelope, owner.ownerAddress, owner.walletAddress);
                provisionEnvelope.current = accepted.provisionEnvelope;
                setArmPlanFallback(accepted.armPlanFallback === "signed");
                props.onRestoreChoices?.(accepted);
              }
            } catch { /* a missing or mismatched local record selects the signed door */ }
          }
          setAgentId(id);
          return { id, view: existing };
        }
        if (!response.ok || payload.data === undefined) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
        hireStorage.setItem("4lpha:grid-hire:v1", id);
        setAgentId(id);
        setView(payload.data);
        return { id, view: payload.data };
      }
      throw new Error(`Every candidate name around "${base}" is already claimed. Rename the agent and try again.`);
    } catch (error) {
      if (mounted.current && !run.stopped) setMessage(error instanceof Error ? error.message : "The hire could not be prepared.");
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
      const cancelled = await cancelGridHire({ agentId, signEnvelope: owner.signEnvelope, storage: hireStorage });
      if (mounted.current) { setView(cancelled); setMessage(cancellationMessage(cancelled)); }
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : "The cancellation request could not be recorded.");
    } finally {
      cancelling.current = false;
      if (mounted.current) setWorking(null);
    }
  };

  const mark = (key: DeployStepKey, state: DeployStepState, detail?: string): void => {
    setSteps((current) => ({ ...current, [key]: detail === undefined ? { state } : { state, detail } }));
  };

  /** One read of the hire row inside a run, on the shared credential. */
  const readSession = async (id: string, run: GridDeployRun): Promise<HireSessionView> => {
    const data = await run.guarded(() => readWithCredential(id, true, run));
    run.check();
    setView(data);
    return data;
  };

  /**
   * ONE PRESS, THE WHOLE HIRE.
   *
   * The steps have not changed — the plane still requires a provision, an
   * on-chain grant, independent convergence evidence and an arm — but a button
   * between each of them taught the owner nothing and lost people halfway: an
   * agent hired and never armed holds no position at all. This drives them in
   * order, asks for a passkey exactly where authority is required, opens the
   * deposit panel only when the wallet is genuinely short, and lands on the
   * agent page without a further click.
   *
   * RESUMABLE by construction: every step reads the durable row first, so
   * pressing deploy again after a failure continues rather than restarts, and
   * a submitted-but-unconfirmed grant is never re-signed.
   */
  const deployAll = async (seed?: { readonly id: string; readonly view: HireSessionView; readonly choices?: GridHireChoices }): Promise<void> => {
    if (activeRun.current !== null || cancelling.current || (working !== null && seed === undefined)) return;
    const chosen: GridDeployChoiceSnapshot = seed?.choices === undefined
      ? {
          capitalBnb: props.capitalBnb,
          uiPresetId: props.uiPresetId,
          utilizationPct: props.utilizationPct,
          maxRequotesDaily: props.maxRequotesDaily,
          takeProfitPct: props.takeProfitPct,
          stopLossPct: props.stopLossPct,
        }
      : {
          capitalBnb: seed.choices.capitalBnb,
          uiPresetId: seed.choices.uiPresetId,
          utilizationPct: seed.choices.utilizationPct,
          maxRequotesDaily: seed.choices.maxRequotesDaily,
          takeProfitPct: seed.choices.takeProfitPct,
          stopLossPct: seed.choices.stopLossPct,
        };
    const pool = props.pool;
    const agentName = props.agentName;
    const run = new GridDeployRun();
    activeRun.current = run;
    stopPolling();
    setMessage(null);
    setRunning(true);
    setSteps(IDLE_STEPS);
    try {
      if (owner.passkey === null || owner.walletAddress === undefined) {
        throw new Error("Create or recover your passkey wallet first.");
      }
      if (pool === null) throw new Error("Select a pool first.");

      // ── 1. The hire ───────────────────────────────────────────────────────
      let id = seed?.id ?? agentId;
      let current = seed?.view ?? view;
      if (id === null || current === null) {
        mark("hire", "active", "Confirm the hire signature with your passkey…");
        const hired = await run.guarded(() => startHire(run, chosen, pool, agentName));
        if (hired === null) throw new Error("The hire could not be prepared.");
        id = hired.id;
        current = hired.view;
      }
      mark("hire", "done", `Session key created for ${id}`);

      if (hireResumeStep(current) !== "arm") current = await readSession(id, run);
      if (current.cancelRequested === true) throw new Error(cancellationMessage(current));

      // A read the plane could not complete (`evidence-unreadable`: the relay
      // or an RPC did not answer) is not a state of the hire — it is a state
      // of the network. Ask again for a short while before deciding anything
      // from it; a row that has never been granted must come back as
      // fund-and-grant, not sit in "poll" forever.
      for (let tries = 0; tries < 8 && (current.missing ?? []).includes("evidence-unreadable") && current.cancelRequested !== true; tries += 1) {
        mark("hire", "active", `Session key created for ${id}. The relay or chain could not be read — retrying (${tries + 1}/8)…`);
        await run.wait(5_000);
        current = await readSession(id, run);
      }
      if ((current.missing ?? []).includes("evidence-unreadable")) {
        throw new Error("The relay or chain could not be read for 40 s. Nothing was granted; press Continue deploy to try again.");
      }
      mark("hire", "done", `Session key created for ${id}`);

      // ── 2. Funding, and 3. the grant ──────────────────────────────────────
      if (hireResumeStep(current) === "fund-and-grant") {
        let fresh = await run.guarded(() => loadPreview(chosen.capitalBnb));
        setPreview(fresh);
        let gate = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
        // The amount is COMPUTED, not asked for: budget + registration +
        // headroom + arm gas pad, minus what the wallet holds, rounded up —
        // and it is the BUDGET that decides, not the registration fee alone:
        // a wallet that can pay the fee but not the mint fails at step 5.
        const shortOf = (preview: Preview): bigint => requiredDepositWei({ sizing: preview.sizing, funding: preview.funding, sharedWithLiveAgents: sharedPot.current }).shortfallWei;
        if ((!gate.ok && gate.reason === "short") || (gate.ok && shortOf(fresh) > 0n)) {
          const need = requiredDepositWei({ sizing: fresh.sizing, funding: fresh.funding, sharedWithLiveAgents: sharedPot.current });
          const sendWei = depositAmountWei(need.shortfallWei);
          setDepositWei(sendWei);
          mark("fund", "active", `Sending ${depositAmountBnb(need.shortfallWei)} BNB from your wallet to the agent wallet — confirm in your wallet.`);
          setDeposit(true);
          // GRID-GAS-RESERVE W1: "landed" is the wallet holding what it held
          // plus what was sent. It is NOT `shortOf === 0n`: on a shared wallet
          // the shortfall credits no balance by design, so that test could
          // never pass and the run sat in "waiting" with the money already there
          // (grid-agent-01-6, 2026-09-04).
          const balanceBefore = fresh.funding.balanceWei === null ? 0n : BigInt(fresh.funding.balanceWei);
          const expectedAfter = balanceBefore + sendWei;
          const landed = (preview: Preview): boolean =>
            preview.funding.balanceWei !== null && BigInt(preview.funding.balanceWei) >= expectedAfter;
          // The owner's transfer is their own wallet's transaction; nothing
          // here can sign it for them, so this waits rather than failing.
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            await run.wait(6_000);
            fresh = await run.guarded(() => loadPreview(chosen.capitalBnb));
            setPreview(fresh);
            gate = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
            if (gate.ok && landed(fresh)) break;
          }
          if (!gate.ok || !landed(fresh)) throw new Error("The agent wallet is still short of what the hire needs (budget + registration + gas).");
          setDeposit(false);
          setDepositWei(null);
          mark("fund", "done", "The wallet covers the registration estimate.");
        } else if (!gate.ok) {
          throw new Error("The live funding estimate is stale or unreadable; press deploy again.");
        } else {
          mark("fund", "skipped", "The wallet already holds the budget, the registration fee and the gas.");
        }

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
            new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new GrantAgentSessionError("grant_pending")), GRANT_CEILING_MS); }),
          ]));
        } catch (error) {
          run.check();
          // A submitted-but-unconfirmed grant is NOT a reason to sign another:
          // the convergence poll below decides, and re-granting on its own is
          // exactly what this flow must never do.
          if (!(error instanceof GrantAgentSessionError)
            || !["grant_pending", "grant_unknown", "grant_failed"].includes(error.code)) throw error;
          mark("grant", "active", `${error.code}: checking chain evidence instead of re-granting…`);
        } finally {
          clearInterval(grantClock);
        }
        run.check();
        mark("grant", "done", "Submitted. The relay carries it to chain.");
      } else {
        mark("fund", "skipped", "Already funded.");
        mark("grant", "skipped", "The session is already granted.");
      }

      // ── 4. Convergence ────────────────────────────────────────────────────
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

      // ── 5. The arm — the step that actually places the money ──────────────
      mark("arm", "active", "Deriving the grid from the live tick…");
      const claimOutcome = current.armPlan?.claim?.outcome;
      if (claimOutcome?.status === "completed") {
        forgetGridHire(hireStorage, id);
        if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`);
        return;
      }
      if (claimOutcome?.status === "held" || claimOutcome?.status === "interrupted") {
        throw new Error(claimOutcome.message ?? "The arm is held; continue from the agent's settlement and recovery path.");
      }
      if (claimOutcome?.status === "rolled-back" && !armPlanFallback) {
        setArmPlanFallback(true);
        saveGridArmPlanFallback(hireStorage, id);
        throw new Error(claimOutcome.message ?? "The arm rolled back before funding. Press Arm to sign the arm at today's price.");
      }
      run.check();
      const hireSizing = current.hireSizing;
      const hireProfile = hireSizing?.name;
      if ((hireProfile !== "grid-v1" && hireProfile !== "grid-shift-v1") || hireSizing == null) {
        throw new Error(`This hire has an unexpected non-grid profile (${hireProfile ?? "missing"}).`);
      }
      const chosenBudgetWei = parseBnbToWei(chosen.capitalBnb);
      const hiredBudgetWei = BigInt(hireSizing.openNativeBudgetWei);
      if (chosenBudgetWei > hiredBudgetWei) {
        throw new Error(`Total capital ${chosen.capitalBnb} BNB exceeds this hire's budget of ${formatEther(hiredBudgetWei)} BNB. Lower it to that amount, or cancel this hire and start again.`);
      }
      const acceptedEnvelope = provisionEnvelope.current;
      const canContinue = !armPlanFallback && acceptedEnvelope !== null
        && current.armPlan?.claim === null
        && gridContinuationMatches(acceptedEnvelope, current, id, owner.ownerAddress, owner.walletAddress);
      const armed = await run.guarded(() => armGridAgent({
        agentId: id!,
        pool,
        uiPresetId: chosen.uiPresetId,
        capitalBnb: chosen.capitalBnb,
        stopLossPct: chosen.stopLossPct,
        takeProfitPct: chosen.takeProfitPct,
        deployPctBps: chosen.utilizationPct * 100,
        shiftsPerDay: chosen.maxRequotesDaily,
        signEnvelope: (action, targetId, params) => run.guarded(() => owner.signEnvelope(action, targetId, params)),
        hireProfile,
        ...(canContinue && acceptedEnvelope !== null ? { provisionEnvelope: acceptedEnvelope, armPlan: current.armPlan } : {}),
        ...(armPlanFallback ? { armPlanFallback: "signed" as const } : {}),
        onArmPlanFallback: () => {
          setArmPlanFallback(true);
          saveGridArmPlanFallback(hireStorage, id!);
        },
        onArmPlanOutcome: (plan) => setView({ ...current, armPlan: plan }),
        ...(preview?.sizing.relayFeePerSubmitWei === undefined ? {} : { relayFeePerSubmitWei: preview.sizing.relayFeePerSubmitWei }),
        onNote: (note) => { if (!run.stopped && mounted.current) mark("arm", "active", note); },
      }));
      run.check();
      const armBlock = armed["arm"] as { readonly tokenId?: unknown } | undefined;
      mark("arm", "done", typeof armBlock?.tokenId === "string" || typeof armBlock?.tokenId === "number"
        ? `Position NFT #${String(armBlock.tokenId)} minted.`
        : "Armed.");

      // ── 6. The agent page, without another click ──────────────────────────
      forgetGridHire(hireStorage, id);
      if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!mounted.current || run.stopped) return;
      const text = error instanceof Error ? error.message : "The deploy could not be completed.";
      setSteps((current) => {
        const active = DEPLOY_STEPS.find(({ key }) => current[key].state === "active")?.key ?? "hire";
        return { ...current, [active]: { state: "failed", detail: text } };
      });
      setMessage(text);
    } finally {
      if (activeRun.current === run) activeRun.current = null;
      if (mounted.current) {
        setRunning(false);
        if (!cancelling.current) setWorking(null);
      }
    }
  };

  const step = hireResumeStep(view);
  const resetHire = () => {
    if (activeRun.current !== null || cancelling.current) return;
    stopPolling();
    if (agentId !== null) forgetGridHire(hireStorage, agentId);
    setAgentId(null); setView(null); setPreview(null); setMessage(null); setSteps(IDLE_STEPS);
  };
  if (step === "arm" && agentId !== null) {
    const openAgent = (id: string): void => { if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`); };
    // STEP 2 OF 2, and the one that actually places money. The grant only
    // creates the scoped session; until `gridArm` mints the first level the
    // agent holds no position and the worker has nothing to manage — which
    // read as "hired but nothing happens" when this step sat under a
    // more prominent "View agent page" button.
    return <div style={{ display: "grid", gap: 12 }}>
      {armPlanFallback ? <p style={{ color: "var(--loss)", margin: 0 }}>The signed plan could not be placed at the current price. Arm again to sign today&apos;s price.</p> : null}
      <p style={{ color: "var(--text-muted)", font: "var(--type-body-sm)", margin: 0 }}>
        Session <code>{agentId}</code> is live on chain. One step left: arm the grid, which wraps your budget and mints both rungs. <strong>Until it is armed the agent holds no position and places no orders.</strong>
      </p>
      <div>
        <button type="button" style={busyBtn(running, primaryBtn)} onClick={() => void deployAll()} disabled={running}>
          {armPlanFallback ? "Arm the grid with a signature" : "Arm the grid"}
        </button>
      </div>
      {running || Object.values(steps).some((entry) => entry.state !== "pending") ? <DeployProgress steps={steps} /> : null}
      {message ? <p style={{ color: "var(--loss)" }}>{message}</p> : null}
      <div><button type="button" style={{ ...secondaryBtn, padding: "10px 16px", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" }} onClick={() => openAgent(agentId)}>Open the agent page without arming</button></div>
    </div>;
  }

  const blocked = props.blockedReason ?? null;
  const blockerId = walletBlockerAgentId(message);
  const blockerHref = blockerId === null ? null : `/account/${encodeURIComponent(blockerId)}`;
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
    {view?.permissions ? <div style={{ display: "grid", gap: 6, color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      <p>This session may call {view.permissions.calls.length} reviewed contract permission{view.permissions.calls.length === 1 ? "" : "s"}.</p>
      {view.permissions.spend.map((spend, index) => <p key={`${spend.token ?? "native"}-${spend.period}-${index}`}>{BigInt(spend.limit) >= (1n << 160n) ? `It may move token ${spend.token?.slice(0, 6)}…${spend.token?.slice(-4)} without a per-${spend.period} cap; the allowlist limits which contracts it can touch.` : `It may spend up to ${formatEther(BigInt(spend.limit))} ${spend.token === undefined ? "BNB" : `units of token ${spend.token?.slice(0, 6)}…${spend.token?.slice(-4)}`} per ${spend.period}.`}</p>)}
      <p>The session expires {view.expiresAt ? new Date(view.expiresAt * 1_000).toLocaleString() : "after seven days"}. You can revoke it at any time.</p>
    </div> : null}
    {funding ? <div style={{ color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      <p>The current estimate is {formatEther(BigInt(funding.requiredWei))} BNB: {funding.registrations} registration{funding.registrations === 1 ? "" : "s"} at {formatEther(BigInt(funding.registrationFeeWei))} BNB, plus {formatEther(BigInt(funding.relayGasHeadroomWei))} BNB headroom.</p>
      <p>Wallet balance at {new Date(funding.observedAtSec * 1_000).toLocaleTimeString()}: {funding.balanceWei === null ? "unreadable" : `${formatEther(BigInt(funding.balanceWei))} BNB`}. This is an estimate, not a guaranteed fee.</p>
    </div> : null}
    {/* ONE BUTTON. The hire, the funding gate, the grant, the convergence
        wait and the arm are five plane-level steps, but they are not five
        decisions: the owner already made the decision on the form above. The
        run reports each step as it happens and lands on the agent page. */}
    {step === "s1" || step === "fund-and-grant" || (step === "poll" && view?.cancelRequested !== true) ? <div style={{ display: "grid", gap: 12 }}>
      <button type="button" style={busyBtn(running || working !== null || blocked !== null, primaryBtn)} onClick={() => void deployAll()} disabled={running || working !== null || blocked !== null}>
        {running ? "Deploying…" : step === "s1" ? "Deploy grid agent" : "Continue deploy"}
      </button>
      {blocked !== null ? <p style={{ color: "var(--loss)", margin: 0 }}>{blocked}</p> : null}
      {running || Object.values(steps).some((entry) => entry.state !== "pending") ? <DeployProgress steps={steps} /> : null}
    </div> : null}
    {step === "poll" && view !== null ? <p>{view.cancelRequested === true
      ? cancellationMessage(view)
      : pollStatusText(view)}</p> : null}
    {view?.status === "provisioning" && view.cancelRequested !== true ? <button type="button" style={busyBtn(working !== null && !running, secondaryBtn)} onClick={() => void cancelHire()} disabled={working !== null && !running}>Cancel hire safely</button> : null}
    {cancellationRecorded(view) && step !== "terminal" ? <button type="button" style={secondaryBtn} disabled={running || working !== null} onClick={resetHire}>Start a new hire</button> : null}
    {step === "poll" && view?.cancelRequested !== true ? <button type="button" style={secondaryBtn} disabled={running || working !== null} onClick={() => {
      if (agentId === null) return;
      setWorking("Checking hire status…");
      void beginPolling(agentId).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Hire status is unavailable.")).finally(() => setWorking(null));
    }}>Check hire status</button> : null}
    {step === "terminal" ? <div style={{ display: "grid", gap: 10, justifyItems: "start" }}>
      <p style={{ margin: 0 }}>{view?.missing?.includes("permissions-differ") ? "The permissions differ: revoke the session on chain and hire again." : `This hire cannot continue (${view?.missing?.join(", ") ?? view?.status}).`}</p>
      {/* The dead end is a POINTER in local storage, not a state on chain: the
          owner must be able to leave it and hire again without clearing site
          data. Forgetting it grants nothing — the agent row is untouched. */}
      <button type="button" style={secondaryBtn} disabled={running || working !== null} onClick={resetHire}>Start a new hire</button>
    </div> : null}
    {working ? <p>{working}</p> : null}
    {message ? <p style={{ color: "var(--loss)" }}>{message}{blockerHref === null ? null : <> {" "}<a href={blockerHref} style={{ color: "inherit", textDecoration: "underline" }} onClick={(event) => { if (props.go) { event.preventDefault(); props.go(blockerHref); } }}>Open agent</a></>}</p> : null}
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
