"use client";
import { accountHireStorage, accountSwitchRequiresContinue } from "@/lib/exec/account-hire-storage";

import * as React from "react";
import { formatEther, getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { FundsModal, type FundsWallet } from "@/components/FundsModal";
import { grantAgentSession, GrantAgentSessionError } from "@/lib/altana/client";
import { freshFundingGate, hireResumeStep, type HireFunding, type HireSessionView } from "@/lib/altana/hire-state";
import { credentialUsable, ensureHireReadCredential, HireReadRefused, pollStatusText, readHireSession, rememberedHireReadCredential, type HireReadCredential } from "@/lib/altana/hire-read-session";
import { cancelGridHire, cancellationMessage, cancellationRecorded, forgetHire, GridDeployRun, GridDeployStopped } from "@/lib/altana/grid-hire-recovery";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import { depositAmountBnb, depositAmountWei, requiredDepositWei, walletSharedWithLiveAgents } from "@/lib/altana/hire-funding";
import { parseBnbToWei } from "@/lib/grid/geometry";
import { buildLpSettings } from "@/lib/lp/settings";
import { explicitRangeFromPrices } from "@/lib/lp/range";
import type { OwnerActionEnvelope } from "@/lib/exec/owner-action";
import { nextFreeAgentId } from "./HireGridDeploy";
import { walletBlockerAgentId } from "@/lib/altana/hire-wallet-blocker";
import type { LivePool } from "./GridLiveDeploy";

const primaryBtn: React.CSSProperties = {
  cursor: "pointer",
  padding: "14px 22px",
  borderRadius: "var(--radius-sm)",
  background: "var(--cat-lp)",
  border: "none",
  color: "#08110c",
  font: "var(--weight-medium) var(--text-md)/1 var(--font-sans)",
};
const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "transparent",
  color: "var(--cat-lp)",
  border: "1px solid var(--cat-lp)",
};
const busyBtn = (busy: boolean, base: React.CSSProperties): React.CSSProperties =>
  busy ? { ...base, cursor: "wait", opacity: 0.6 } : base;

const HIRE_PROFILE = "lp-v1" as const;
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const LP_HIRE_STORAGE_KEY = "4lpha:lp-hire:v1";
export const LP_HIRE_ENVELOPE_STORAGE_PREFIX = `${LP_HIRE_STORAGE_KEY}:provision:`;
export const LP_ARM_OUTCOME_STORAGE_PREFIX = `${LP_HIRE_STORAGE_KEY}:arm-outcome:`;

function provisionEnvelopeKey(agentId: string): string {
  return `${LP_HIRE_ENVELOPE_STORAGE_PREFIX}${agentId}`;
}

type DurableArmOutcome = {
  readonly status: "held" | "rolled-back";
  readonly reason: string;
};

function armOutcomeKey(agentId: string): string {
  return `${LP_ARM_OUTCOME_STORAGE_PREFIX}${agentId}`;
}

function saveArmOutcome(storage: Storage, agentId: string, outcome: DurableArmOutcome): void {
  storage.setItem(armOutcomeKey(agentId), JSON.stringify(outcome));
}

function loadArmOutcome(storage: Storage, agentId: string): DurableArmOutcome | null {
  const raw = storage.getItem(armOutcomeKey(agentId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return (value.status === "held" || value.status === "rolled-back") && typeof value.reason === "string"
      ? { status: value.status, reason: value.reason }
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

function forgetLpHire(storage: Storage, agentId: string): void {
  forgetHire(storage, agentId, LP_HIRE_STORAGE_KEY);
  storage.removeItem(provisionEnvelopeKey(agentId));
  storage.removeItem(armOutcomeKey(agentId));
}

type Preview = {
  readonly capDayWei: string;
  readonly sizing: {
    readonly name: "grid-v1" | "grid-shift-v1" | "lp-v1";
    readonly version: 1;
    readonly openNativeBudgetWei: string;
    readonly feeWei: string;
    readonly relayFeePerSubmitWei: string;
    readonly reserves: {
      readonly exitWei: string;
      readonly protectWei: string;
      readonly gridFlipWei: string;
      readonly totalWei: string;
    };
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
  { key: "fund", title: "Fund the agent wallet", hint: "Only when the wallet cannot cover the registration fee" },
  { key: "grant", title: "Grant the session on chain", hint: "Your passkey authorises the session; the relay submits it" },
  { key: "converge", title: "Verify the grant", hint: "Relay, account, KeyStore and owner binding must all agree" },
  { key: "arm", title: "Open the position", hint: "Signs lpArm and opens the first position" },
];

const STEP_MARK: Record<DeployStepState, string> = {
  pending: "○",
  active: "◐",
  done: "●",
  failed: "✕",
  skipped: "–",
};

const IDLE_STEPS: Record<DeployStepKey, DeployStep> = {
  hire: { state: "pending" },
  fund: { state: "pending" },
  grant: { state: "pending" },
  converge: { state: "pending" },
  arm: { state: "pending" },
};

function DeployProgress({ steps }: { readonly steps: Record<DeployStepKey, DeployStep> }) {
  return (
    <div style={{ display: "grid", gap: 2, padding: 12, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      {DEPLOY_STEPS.map(({ key, title, hint }, index) => {
        const step = steps[key];
        const colour = step.state === "done" ? "var(--profit)"
          : step.state === "failed" ? "var(--loss)"
            : step.state === "active" ? "var(--cat-lp)" : "var(--text-subtle)";
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
  return slug === "" ? "lp-agent" : slug;
}

function poolToken(pool: LivePool): Address {
  return getAddress(pool.wbnbIsToken0 ? pool.token1 : pool.token0);
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

type ExplicitPrices = {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly wbnbIsToken0: boolean;
  /**
   * Which leg the typed prices are quoted in (quote per base, the numeraire
   * rule of `poolQuote`). Optional so older callers keep the legacy reading
   * (quote = the non-WBNB leg).
   */
  readonly quoteIsToken0?: boolean;
  readonly poolAddress: string;
  readonly ready: boolean;
};

export class LpArmOutcomeError extends Error {
  readonly status: "held" | "rolled-back";

  constructor(status: "held" | "rolled-back", reason: string) {
    super(reason);
    this.name = "LpArmOutcomeError";
    this.status = status;
  }
}

export async function armLpAgent(input: {
  readonly agentId: string;
  readonly uiPresetId: string;
  readonly pool: LivePool | null;
  readonly capitalBnb: string;
  readonly routeBy: "fee-apr" | "volume";
  readonly takeProfitPct: number;
  readonly stopLossPct: number;
  readonly rotateMode: "swapped" | "swapless";
  readonly rotateMinHoldMinutes: number;
  readonly compoundOn: boolean;
  readonly minFees: number;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly instructions: string;
  readonly skillFile: { readonly name: string; readonly text: string } | null;
  readonly explicitPrices: ExplicitPrices | null;
  readonly signEnvelope: (action: string, agentId: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly onNote?: (note: string) => void;
}): Promise<Record<string, unknown>> {
  const budgetWei = parseBnbToWei(input.capitalBnb);
  if (budgetWei <= 0n) throw new Error("Total capital must be positive.");
  const settings = buildLpSettings({
    compoundOn: input.compoundOn,
    takeProfitPct: input.takeProfitPct,
    stopLossPct: input.stopLossPct,
    budgetWei,
    minFees: input.minFees,
    rotateMinHoldMinutes: input.rotateMinHoldMinutes,
    rotateMode: input.rotateMode,
    primaryModel: input.primaryModel,
    fallbackModel: input.fallbackModel,
    instructions: input.instructions,
    skillFile: input.skillFile,
  });

  let params: Record<string, unknown>;
  if (input.uiPresetId === "wide") {
    input.onNote?.("Signing the routed LP settings and server-fenced range…");
    params = {
      settings,
      budgetWei: budgetWei.toString(10),
      selectPool: { by: input.routeBy, window: "24h" },
      range: "server-fenced",
    };
  } else {
    if (input.pool === null) throw new Error("Select a pool first.");
    if (input.explicitPrices === null || input.explicitPrices.ready !== true) {
      throw new Error("Select a pool and wait for its live tick before signing the range.");
    }
    const signedPoolAddress = getAddress(input.pool.pool);
    if (getAddress(input.explicitPrices.poolAddress) !== signedPoolAddress) {
      throw new Error("The displayed range belongs to a different pool. Wait for the signed pool's live tick.");
    }
    const stateResponse = await fetch(`/api/pool-state?address=${signedPoolAddress.toLowerCase()}`, { cache: "no-store" });
    const statePayload = await stateResponse.json() as {
      data?: { readonly pool?: unknown; readonly currentTick?: unknown; readonly tickSpacing?: unknown };
      error?: { readonly code?: string; readonly message?: string };
    };
    if (!stateResponse.ok || statePayload.data === undefined) {
      throw new Error(statePayload.error?.message ?? statePayload.error?.code ?? "The signed pool's live state is unavailable.");
    }
    const state = statePayload.data;
    const token0IsWbnb = getAddress(input.pool.token0) === getAddress(WBNB);
    const token1IsWbnb = getAddress(input.pool.token1) === getAddress(WBNB);
    if (
      typeof state.pool !== "string"
      || getAddress(state.pool) !== signedPoolAddress
      || !Number.isInteger(state.currentTick)
      || !Number.isInteger(state.tickSpacing)
      || state.tickSpacing !== input.explicitPrices.tickSpacing
      || token0IsWbnb === token1IsWbnb
      || token0IsWbnb !== input.pool.wbnbIsToken0
      || token0IsWbnb !== input.explicitPrices.wbnbIsToken0
    ) {
      throw new Error("The signed pool's spacing or WBNB orientation changed. Refresh the displayed range before signing.");
    }
    // The owner signs PRICES, and a live pool's tick moves between the display
    // and the signature. The ticks are therefore derived from the typed prices
    // against the tick read RIGHT NOW: if the price is still inside the typed
    // band the signature is exactly what the owner asked for; if it has left
    // the band, `explicitRangeFromPrices` refuses with the straddle rule and the
    // owner re-reads the form — never a silent shift of the band.
    const liveTick = state.currentTick as number;
    const orientation = input.explicitPrices.quoteIsToken0 === undefined
      ? { wbnbIsToken0: input.explicitPrices.wbnbIsToken0 }
      : { quoteIsToken0: input.explicitPrices.quoteIsToken0 };
    const range = explicitRangeFromPrices({
      minPrice: input.explicitPrices.minPrice,
      maxPrice: input.explicitPrices.maxPrice,
      currentTick: liveTick,
      tickSpacing: input.explicitPrices.tickSpacing,
      ...orientation,
    });
    if (liveTick !== input.explicitPrices.currentTick) {
      input.onNote?.(`The pool moved from tick ${input.explicitPrices.currentTick} to ${liveTick} since the form loaded; your price band still contains it.`);
    }
    input.onNote?.(`Signing the explicit range [${range.tickLower}, ${range.tickUpper}) at tick ${liveTick}…`);
    params = {
      settings,
      budgetWei: budgetWei.toString(10),
      pool: { token0: input.pool.token0, token1: input.pool.token1, fee: input.pool.fee },
      range: { tickLower: range.tickLower, tickUpper: range.tickUpper },
    };
  }

  const envelope = await input.signEnvelope("lpArm", input.agentId, params);
  input.onNote?.("Submitting lpArm to the execution plane…");
  const response = await fetch(`/api/agents/${encodeURIComponent(input.agentId)}/lp/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const payload = (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message?: string } };
  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ? `${payload.error.code}: ${payload.error.message}` : payload.error?.code ?? `HTTP ${response.status}`);
  }
  const open = payload.data["open"];
  if (typeof open !== "object" || open === null || Array.isArray(open)) {
    throw new Error("The execution plane returned an invalid LP arm result.");
  }
  const openStatus = (open as Record<string, unknown>)["status"];
  if (openStatus === "held" || openStatus === "rolled-back") {
    const reason = (open as Record<string, unknown>)["reason"];
    throw new LpArmOutcomeError(
      openStatus,
      typeof reason === "string" && reason.length > 0
        ? reason
        : openStatus === "held"
          ? "The position open is held. Continue from the agent's recovery path."
          : "The position open rolled back before funding. Retry the arm.",
    );
  }
  if (openStatus !== "completed") {
    throw new Error("The execution plane returned an unknown LP arm status.");
  }
  return payload.data;
}

export function HireLpDeploy(props: {
  readonly mode: "Demo" | "Live";
  readonly agentName: string;
  readonly uiPresetId: string;
  readonly pool: LivePool | null;
  readonly capitalBnb: string;
  readonly routeBy: "fee-apr" | "volume";
  readonly takeProfitPct: number;
  readonly stopLossPct: number;
  readonly rotateMode: "swapped" | "swapless";
  readonly rotateMinHoldMinutes: number;
  readonly compoundOn: boolean;
  readonly minFees: number;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly instructions: string;
  readonly skillFile: { readonly name: string; readonly text: string } | null;
  readonly explicitPrices: ExplicitPrices | null;
  /**
   * The form's own refusal (a range problem, a capital floor). While set, the
   * Deploy button is disabled and shows it — the same rule the signing helper
   * enforces, surfaced BEFORE any passkey prompt (fix review, finding 1).
   */
  readonly blockedReason?: string | null;
  readonly go?: (route: string) => void;
}) {
  const owner = useOwnerActions();
  const hireStorage = React.useMemo(() => accountHireStorage(typeof window === "undefined" ? undefined : window.localStorage, owner.ownerAddress), [owner.ownerAddress]);
  const { address: connectedAddress } = useAccount();
  const sharedPot = React.useRef(true);
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<HireSessionView | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const blockerId = walletBlockerAgentId(message);
  const blockerHref = blockerId === null ? null : `/account/${encodeURIComponent(blockerId)}`;
  const [armOutcome, setArmOutcome] = React.useState<DurableArmOutcome | null>(null);
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
  }, [owner.signEnvelope, owner.signReadHeader]);

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
    const saved = hireStorage.getItem(LP_HIRE_STORAGE_KEY);
    if (saved === null) return;
    const savedArmOutcome = loadArmOutcome(hireStorage, saved);
    setArmOutcome(savedArmOutcome);
    provisionEnvelope.current = loadProvisionEnvelope(hireStorage, saved);
    setAgentId(saved);
    setWorking("Checking the durable hire state before offering another grant…");
    void beginPolling(saved).then((resumedView) => {
      if (!mounted.current) return;
      if (!accountSwitchRequiresContinue(hireStorage) && resumedView !== undefined && hireResumeStep(resumedView) === "arm" && savedArmOutcome === null && !cancellationRecorded(resumedView) && !autoContinued.current) {
        autoContinued.current = true;
        void deployAll({ id: saved, view: resumedView });
      }
      if (resumedView !== undefined && (resumedView.status === "revoked" || resumedView.status === "retired")) {
        forgetLpHire(hireStorage, saved);
        setAgentId(null);
        setView(null);
        setMessage(`The previous session (${saved}) is ${resumedView.status}. Starting a fresh hire.`);
      } else if (cancellationRecorded(resumedView)) {
        forgetLpHire(hireStorage, saved);
      }
    }).catch((error: unknown) => {
      if (!mounted.current || error instanceof GridDeployStopped) return;
      setMessage(error instanceof Error ? error.message : "Hire status is unavailable.");
    }).finally(() => { if (mounted.current) setWorking(null); });
  }, [beginPolling, owner.passkey]);

  React.useEffect(() => {
    if (view?.status !== "armed" || preview !== null || props.pool === null || owner.walletAddress === undefined) return;
    let current = true;
    void loadPreview().then((result) => { if (current) setPreview(result); }).catch(() => undefined);
    return () => { current = false; };
  }, [owner.walletAddress, preview, props.pool, view?.status]);

  const mark = (key: DeployStepKey, state: DeployStepState, detail?: string): void => {
    setSteps((current) => ({ ...current, [key]: detail === undefined ? { state } : { state, detail } }));
  };

  const readSession = async (id: string, run: GridDeployRun): Promise<HireSessionView> => {
    const data = await run.guarded(() => readWithCredential(id, true));
    run.check();
    setView(data);
    return data;
  };

  if (props.mode === "Demo") {
    return <div style={{ display: "grid", gap: 12, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
      <button type="button" style={primaryBtn} onClick={() => setMessage("Demo engine coming soon.")}>Deploy LP Agent</button>
      {message ? <p style={{ color: "var(--text-subtle)", margin: 0 }}>{message}</p> : null}
    </div>;
  }

  const loadPreview = async (): Promise<Preview> => {
    if (owner.passkey === null || owner.walletAddress === undefined) throw new Error("Create or recover your passkey wallet first.");
    if (props.pool === null) throw new Error("Select a routed pool first.");
    const openNativeBudgetWei = parseBnbToWei(props.capitalBnb);
    if (openNativeBudgetWei <= 0n) throw new Error("Total capital must be positive.");
    const query = new URLSearchParams({
      walletAddress: owner.walletAddress,
      openNativeBudgetWei: openNativeBudgetWei.toString(10),
      sizingPreset: HIRE_PROFILE,
    });
    const response = await fetch(`/api/agents/hire/preview?${query}`, { cache: "no-store" });
    const payload = await response.json() as { data?: Preview };
    if (response.status === 404) {
      throw new Error("Hire is not enabled on this execution plane: start it with HIRE_ENABLED=true (requires PASSKEY_ENABLED, DATABASE_URL and EXECUTION_MASTER_KEY).");
    }
    if (!response.ok || payload.data === undefined) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
    return payload.data;
  };

  const startHire = async (run: GridDeployRun): Promise<{ readonly id: string; readonly view: HireSessionView } | null> => {
    setMessage(null);
    setWorking("Reading the live cap and funding estimate…");
    try {
      const fresh = await run.guarded(loadPreview);
      setPreview(fresh);
      const base = agentIdFromName(props.agentName);
      const taken: string[] = [];
      try {
        setWorking("Checking which agent names you already hold…");
        const header = await run.guarded(() => owner.signReadHeader("*"));
        const listed = await fetch("/api/agents", { headers: { "x-owner-action": header }, cache: "no-store" });
        type ListedAgent = { id: string; status?: unknown; walletAddress?: unknown };
        const rows = await listed.json() as { data?: { agents?: ListedAgent[] } | ListedAgent[] };
        if (listed.ok) {
          const agents = Array.isArray(rows.data) ? rows.data : rows.data?.agents ?? [];
          taken.push(...agents.map((agent) => agent.id));
          if (owner.walletAddress !== undefined) {
            sharedPot.current = walletSharedWithLiveAgents({ agents, walletAddress: owner.walletAddress, excludingId: base });
          }
        }
      } catch {
        run.check();
      }
      const params = {
        walletAddress: owner.walletAddress!,
        token: poolToken(props.pool!),
        capDayWei: fresh.capDayWei,
        openNativeBudgetWei: fresh.sizing.openNativeBudgetWei,
        ttlSec: 604_800,
        sizingPreset: HIRE_PROFILE,
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        run.check();
        const id = nextFreeAgentId(base, taken);
        setWorking(attempt === 0
          ? "Confirm the one off-chain hire signature with your passkey…"
          : `${taken[taken.length - 1] ?? base} is taken. Confirm the signature again to hire ${id}…`);
        const envelope = await run.guarded(() => owner.signEnvelope("provisionAgent", id, params));
        provisionEnvelope.current = envelope;
        saveProvisionEnvelope(hireStorage, id, envelope);
        hireStorage.setItem(LP_HIRE_STORAGE_KEY, id);
        const response = await fetch(`/api/agents/${encodeURIComponent(id)}/session`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
        });
        const payload = await response.json() as { data?: HireSessionView };
        if (response.ok && payload.data !== undefined) {
          const saved = hireStorage.getItem(LP_HIRE_STORAGE_KEY);
          if (!run.stopped || saved === null || saved === id) hireStorage.setItem(LP_HIRE_STORAGE_KEY, id);
        }
        run.check();
        // Only an id collision is "taken" (the Grid hire's rule). Every other
        // 409 — `wallet_in_use` (this wallet already carries a live agent),
        // `s1_ambiguous`, `conflict` — is a real refusal and must be SHOWN, not
        // retried under the next name: retrying turned a "wallet in use"
        // into "every candidate name is claimed" (2026-09-06).
        const code = (payload as { error?: { code?: string } }).error?.code;
        if (response.status === 409 && code !== undefined && code !== "agent_exists") {
          throw new Error(errorMessage(payload, `HTTP ${response.status}`));
        }
        if (response.status === 409) {
          hireStorage.removeItem(provisionEnvelopeKey(id));
          provisionEnvelope.current = null;
          setWorking("An agent with this id already exists — reading its hire state…");
          // Agent ids are GLOBAL but the session read is owner-scoped: an id
          // held by ANOTHER owner answers 409 here and then `not_found` on
          // the read. That is "taken by someone else", not a failure — move
          // to the next candidate (2026-09-06: a fresh passkey account naming
          // its first agent `lp-agent-01` died on the previous owner's id).
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
            hireStorage.setItem(LP_HIRE_STORAGE_KEY, id);
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
        hireStorage.setItem(LP_HIRE_STORAGE_KEY, id);
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
      const cancelled = await cancelGridHire({
        agentId,
        signEnvelope: owner.signEnvelope,
        storage: hireStorage,
        storageKey: LP_HIRE_STORAGE_KEY,
      });
      hireStorage.removeItem(provisionEnvelopeKey(agentId));
      provisionEnvelope.current = null;
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

  const blocked = props.blockedReason ?? null;
  const deployAll = async (seed?: { readonly id: string; readonly view: HireSessionView }): Promise<void> => {
    if (activeRun.current !== null || cancelling.current || (working !== null && seed === undefined)) return;
    // A form-level refusal stops the run before the first passkey prompt; the
    // same condition would refuse at the signing helper, but the owner sees it
    // here instead of after a signature ceremony.
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
      if (props.pool === null) throw new Error("Select a routed pool first.");

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
        const shortOf = (entry: Preview): bigint =>
          requiredDepositWei({ sizing: entry.sizing, funding: entry.funding, sharedWithLiveAgents: sharedPot.current }).shortfallWei;
        if ((!gate.ok && gate.reason === "short") || (gate.ok && shortOf(fresh) > 0n)) {
          const need = requiredDepositWei({ sizing: fresh.sizing, funding: fresh.funding, sharedWithLiveAgents: sharedPot.current });
          const sendWei = depositAmountWei(need.shortfallWei);
          setDepositWei(sendWei);
          mark("fund", "active", `Sending ${depositAmountBnb(need.shortfallWei)} BNB from your wallet to the agent wallet — confirm in your wallet.`);
          setDeposit(true);
          const balanceBefore = fresh.funding.balanceWei === null ? 0n : BigInt(fresh.funding.balanceWei);
          const expectedAfter = balanceBefore + sendWei;
          const landed = (entry: Preview): boolean =>
            entry.funding.balanceWei !== null && BigInt(entry.funding.balanceWei) >= expectedAfter;
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            await run.wait(6_000);
            fresh = await run.guarded(loadPreview);
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

      mark("arm", "active", "Preparing the LP settings and range…");
      const opened = await run.guarded(() => armLpAgent({
        agentId: id!,
        uiPresetId: props.uiPresetId,
        pool: props.pool,
        capitalBnb: props.capitalBnb,
        routeBy: props.routeBy,
        takeProfitPct: props.takeProfitPct,
        stopLossPct: props.stopLossPct,
        rotateMode: props.rotateMode,
        rotateMinHoldMinutes: props.rotateMinHoldMinutes,
        compoundOn: props.compoundOn,
        minFees: props.minFees,
        primaryModel: props.primaryModel,
        fallbackModel: props.fallbackModel,
        instructions: props.instructions,
        skillFile: props.skillFile,
        explicitPrices: props.explicitPrices,
        signEnvelope: (action, targetId, params) => run.guarded(() => owner.signEnvelope(action, targetId, params)),
        onNote: (note) => { if (!run.stopped && mounted.current) mark("arm", "active", note); },
      }));
      const position = opened["position"] as { readonly tokenId?: unknown } | undefined;
      mark("arm", "done", typeof position?.tokenId === "string" || typeof position?.tokenId === "number"
        ? `Position NFT #${String(position.tokenId)} minted.`
        : "Position opened.");

      forgetLpHire(hireStorage, id);
      if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!mounted.current || run.stopped) return;
      const text = error instanceof Error ? error.message : "The deploy could not be completed.";
      if (error instanceof LpArmOutcomeError && id !== null) {
        const outcome = { status: error.status, reason: text } as const;
        saveArmOutcome(hireStorage, id, outcome);
        setArmOutcome(outcome);
        // A HELD open is a live sequence the plane is still driving (a
        // pending relay submission, resolved by reconcile) — the agent page is
        // where it is followed, so go there without another press (operator
        // request 2026-09-06). The hire pointer and the durable outcome stay,
        // so a reload lands on the same recovery path; only a ROLLED-BACK open
        // keeps the owner here with the explicit retry.
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
      if (mounted.current) {
        setRunning(false);
        if (!cancelling.current) setWorking(null);
      }
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

  const step = hireResumeStep(view);
  const resetHire = () => {
    if (activeRun.current !== null || cancelling.current) return;
    stopPolling();
    if (agentId !== null) forgetLpHire(hireStorage, agentId);
    provisionEnvelope.current = null;
    setAgentId(null);
    setView(null);
    setPreview(null);
    setArmOutcome(null);
    setMessage(null);
    setSteps(IDLE_STEPS);
  };

  if (step === "arm" && agentId !== null) {
    const openAgent = (id: string): void => { if (props.go) props.go(`/account/${id}`); else window.location.assign(`/account/${encodeURIComponent(id)}`); };
    const retryArm = (): void => {
      hireStorage.removeItem(armOutcomeKey(agentId));
      setArmOutcome(null);
      setMessage(null);
      void deployAll();
    };
    return <div style={{ display: "grid", gap: 12 }}>
      <p style={{ color: "var(--text-muted)", font: "var(--type-body-sm)", margin: 0 }}>
        {armOutcome?.status === "held"
          ? <>The position open is held. The durable position and hire pointer are preserved; continue from the agent recovery path.</>
          : armOutcome?.status === "rolled-back"
            ? <>The position open rolled back before funding. The hire pointer is preserved and the arm can be retried.</>
            : <>Session <code>{agentId}</code> is live on chain. One step left: open the position with <code>lpArm</code>. <strong>Until it is opened the agent holds no LP position.</strong></>}
      </p>
      {armOutcome !== null ? <p style={{ color: "var(--loss)", margin: 0 }}>{armOutcome.reason}</p> : null}
      <div>
        {armOutcome?.status === "held"
          ? <button type="button" style={primaryBtn} onClick={() => openAgent(agentId)}>Continue from the agent page</button>
          : <button type="button" style={busyBtn(running, primaryBtn)} onClick={armOutcome?.status === "rolled-back" ? retryArm : () => void deployAll()} disabled={running}>
            {armOutcome?.status === "rolled-back" ? "Retry opening position" : "Open the position"}
          </button>}
      </div>
      {running || Object.values(steps).some((entry) => entry.state !== "pending") ? <DeployProgress steps={steps} /> : null}
      {message && message !== armOutcome?.reason ? <p style={{ color: "var(--loss)" }}>{message}</p> : null}
      {armOutcome?.status === "held" ? null : <div><button type="button" style={{ ...secondaryBtn, padding: "10px 16px", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" }} onClick={() => openAgent(agentId)}>Open the agent page without opening a position</button></div>}
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
    {view?.permissions ? <div style={{ display: "grid", gap: 6, color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      <p>This session may call {view.permissions.calls.length} reviewed contract permission{view.permissions.calls.length === 1 ? "" : "s"}.</p>
      {view.permissions.spend.map((spend, index) => <p key={`${spend.token ?? "native"}-${spend.period}-${index}`}>{BigInt(spend.limit) >= (1n << 160n) ? `It may move token ${spend.token?.slice(0, 6)}…${spend.token?.slice(-4)} without a per-${spend.period} cap; the allowlist limits which contracts it can touch.` : `It may spend up to ${formatEther(BigInt(spend.limit))} ${spend.token === undefined ? "BNB" : `units of token ${spend.token?.slice(0, 6)}…${spend.token?.slice(-4)}`} per ${spend.period}.`}</p>)}
      <p>The session expires {view.expiresAt ? new Date(view.expiresAt * 1_000).toLocaleString() : "after seven days"}. You can revoke it at any time.</p>
    </div> : null}
    {funding ? <div style={{ color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      <p>The current estimate is {formatEther(BigInt(funding.requiredWei))} BNB: {funding.registrations} registration{funding.registrations === 1 ? "" : "s"} at {formatEther(BigInt(funding.registrationFeeWei))} BNB, plus {formatEther(BigInt(funding.relayGasHeadroomWei))} BNB headroom.</p>
      <p>Wallet balance at {new Date(funding.observedAtSec * 1_000).toLocaleTimeString()}: {funding.balanceWei === null ? "unreadable" : `${formatEther(BigInt(funding.balanceWei))} BNB`}. This is an estimate, not a guaranteed fee.</p>
    </div> : null}
    {step === "s1" || step === "fund-and-grant" || step === "converge" || (step === "poll" && view?.cancelRequested !== true) ? <div style={{ display: "grid", gap: 12 }}>
      <button type="button" style={busyBtn(running || working !== null || blocked !== null, primaryBtn)} onClick={() => void deployAll()} disabled={running || working !== null || blocked !== null}>
        {running ? "Deploying…" : step === "s1" ? "Deploy LP Agent" : "Continue deploy"}
      </button>
      {blocked !== null ? <p role="alert" style={{ color: "var(--loss)", margin: 0 }}>{blocked}</p> : null}
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
