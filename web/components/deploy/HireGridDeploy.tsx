"use client";
import { accountHireStorage, accountSwitchRequiresContinue } from "@/lib/exec/account-hire-storage";

import { walletBlockerAgentId } from "@/lib/altana/hire-wallet-blocker";

import * as React from "react";
import { formatEther, getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { FundsModal, type FundsWallet } from "@/components/FundsModal";
import { grantAgentSession, GrantAgentSessionError } from "@/lib/altana/client";
import { freshFundingGate, hireResumeStep, type HireFunding, type HireSessionView } from "@/lib/altana/hire-state";
import { credentialUsable, ensureHireReadCredential, HireReadRefused, pollStatusText, readHireSession, rememberedHireReadCredential, type HireReadCredential } from "@/lib/altana/hire-read-session";
import { cancelGridHire, cancellationMessage, cancellationRecorded, forgetGridHire, GridDeployRun, GridDeployStopped } from "@/lib/altana/grid-hire-recovery";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import { parseBnbToWei } from "@/lib/grid/geometry";
import { depositAmountBnb, depositAmountWei, requiredDepositWei, walletSharedWithLiveAgents } from "@/lib/altana/hire-funding";
import { armGridAgent, GridDeployActions, type LivePool } from "./GridLiveDeploy";

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
  { key: "hire", title: "Sign the hire", hint: "One passkey signature creates the scoped session key" },
  { key: "fund", title: "Fund the agent wallet", hint: "Only when the wallet cannot cover the registration fee" },
  { key: "grant", title: "Grant the session on chain", hint: "Your passkey authorises the session; the relay submits it" },
  { key: "converge", title: "Verify the grant", hint: "Relay, account, KeyStore and owner binding must all agree" },
  { key: "arm", title: "Arm the grid", hint: "Wraps your budget and mints both rungs in one transaction" },
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
  if (props.mode === "Demo") return <GridDeployActions {...props} />;
  return <HireGridDeployLive {...props} />;
}

function HireGridDeployLive(props: {
  readonly mode: "Demo" | "Live";
  readonly agentName: string;
  readonly uiPresetId: string;
  readonly pool: LivePool | null;
  readonly capitalBnb: string;
  readonly takeProfitPct: number;
  readonly stopLossPct: number;
  /** In-app router from KitApp. Routing is React state, not the URL, so a location change would 404. */
  readonly go?: (route: string) => void;
  /** Set when the form itself is invalid (capital under the pool's floor): the hire cannot start. */
  readonly blockedReason?: string | null;
}) {
  const owner = useOwnerActions();
  const hireStorage = React.useMemo(() => accountHireStorage(typeof window === "undefined" ? undefined : window.localStorage, owner.ownerAddress), [owner.ownerAddress]);
  const { address: connectedAddress } = useAccount();
  // GRID-GAS-RESERVE W1 — whether ANOTHER live agent already sits on the agent
  // wallet, decided from the owner-signed list read below. Defaults to TRUE and
  // stays true on a resumed run (no list read): an unknown neighbour is a
  // neighbour, so none of the wallet's balance is credited to this deposit.
  const sharedPot = React.useRef(true);
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<HireSessionView | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [deposit, setDeposit] = React.useState(false);
  const [depositWei, setDepositWei] = React.useState<bigint | null>(null);
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

  const stopPolling = React.useCallback(() => {
    pollGeneration.current += 1;
    if (pollTimer.current !== null) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  /**
   * Every hire read goes through here. The credential is the 900 s account
   * read session (one passkey, shared with the agent page) with the 120 s
   * signed header as the fallback; a 401 means the window lapsed underneath
   * us and is answered by re-issuing once — never by showing the owner an
   * auth error for a hire that is doing nothing wrong.
   */
  const readWithCredential = React.useCallback(async (id: string, longLived = false): Promise<HireSessionView> => {
    const attempt = async (): Promise<HireSessionView> => {
      const nowMs = Date.now();
      let credential = readCredential.current;
      if (!credentialUsable(credential, nowMs)) {
        // A window the agent page already opened costs nothing. Otherwise a
        // LONG run (the deploy's ten-minute convergence wait) earns the 900 s
        // session, while a mount or a status check keeps the 120 s signed
        // read it always had — one signature, no request that is not a read.
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
      // FIX-REVIEW-2 FINDING 2. The retry re-issues a CREDENTIAL, which can mean
      // a wallet prompt — and a 401 that lands after the component is gone would
      // raise that prompt over whatever the owner is looking at now, including
      // the Demo screen they just switched to. The unmount check belongs here
      // rather than only at the call sites, because this is the line that can
      // ask for a signature.
      if (!mounted.current) throw new GridDeployStopped();
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
    void beginPolling(saved).then((resumedView) => {
      if (!mounted.current) return;
      // A FINISHED session is not a broken hire: `revoked`/`retired` is the
      // lifecycle's own end, and the pointer in local storage is the only
      // reason it is still on screen. Drop it and offer a fresh hire, instead
      // of showing the last agent's tombstone above a form the owner just
      // filled in. Every other terminal state (permissions-differ, expired,
      // wallet-owner-mismatch) still needs the owner to act on THAT agent, so
      // it is left exactly where it is.
      if (!accountSwitchRequiresContinue(hireStorage) && resumedView !== undefined && hireResumeStep(resumedView) === "arm" && !cancellationRecorded(resumedView) && !autoContinued.current) {
        autoContinued.current = true;
        void deployAll({ id: saved, view: resumedView });
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
  }, [beginPolling, owner.passkey]);

  React.useEffect(() => {
    if (view?.status !== "armed" || preview !== null || props.pool === null || owner.walletAddress === undefined) return;
    let current = true;
    void loadPreview().then((result) => { if (current) setPreview(result); }).catch(() => undefined);
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.status, preview, props.pool, owner.walletAddress]);

  const loadPreview = async (): Promise<Preview> => {
    if (owner.passkey === null || owner.walletAddress === undefined) throw new Error("Create or recover your passkey wallet first.");
    if (props.pool === null) throw new Error("Select a pool first.");
    const openNativeBudgetWei = parseBnbToWei(props.capitalBnb);
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

  const startHire = async (run: GridDeployRun): Promise<{ readonly id: string; readonly view: HireSessionView } | null> => {
    setMessage(null);
    setWorking("Reading the live cap and funding estimate…");
    try {
      const fresh = await run.guarded(loadPreview);
      setPreview(fresh);
      // ONE owner-signed list read decides the number: `grid-agent-01`, then
      // `-2`, `-3`. The list includes revoked and retired rows, which is what
      // makes re-hiring under the same name work. A list that cannot be read
      // falls back to the bare slug — the 409 branch below is the backstop.
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
          // GRID-GAS-RESERVE W1: the same list says whether the agent wallet is
          // already someone's gas pot. The id being hired is not yet in it.
          if (owner.walletAddress !== undefined) {
            sharedPot.current = walletSharedWithLiveAgents({ agents, walletAddress: owner.walletAddress, excludingId: base });
          }
        }
      } catch {
        run.check();
        // An unreadable list is not a reason to refuse: fall through on the
        // bare slug and let the 409 loop below find the free number.
      }
      const params = {
        walletAddress: owner.walletAddress!,
        token: poolToken(props.pool!),
        capDayWei: fresh.capDayWei,
        openNativeBudgetWei: fresh.sizing.openNativeBudgetWei,
        ttlSec: 604_800,
        sizingPreset: HIRE_PROFILE,
      };
      // The list can be stale or unreadable, so a 409 still has to be handled —
      // by taking the NEXT number, not by parking on the row that answered it.
      // Three attempts: a fourth would mean the list is lying systematically,
      // and silently signing forever is worse than saying so.
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
          const saved = hireStorage.getItem("4lpha:grid-hire:v1");
          if (!run.stopped || saved === null || saved === id) hireStorage.setItem("4lpha:grid-hire:v1", id);
        }
        run.check();
        if (response.status === 409 && payload.error?.code === "agent_exists") {
          // Agent ids are GLOBAL but the session read is owner-scoped. Resume
          // a row owned by this account; when another account owns the id, the
          // read deliberately answers not_found, which means this candidate is
          // taken and the next numbered suffix must be tried. LP and Trading
          // use the same rule.
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
            hireStorage.setItem("4lpha:grid-hire:v1", id);
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
    const data = await run.guarded(() => readWithCredential(id, true));
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
  const deployAll = async (seed?: { readonly id: string; readonly view: HireSessionView }): Promise<void> => {
    if (activeRun.current !== null || cancelling.current || (working !== null && seed === undefined)) return;
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
      if (props.pool === null) throw new Error("Select a pool first.");

      // ── 1. The hire ───────────────────────────────────────────────────────
      let id = seed?.id ?? agentId;
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
        let fresh = await run.guarded(loadPreview);
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
      run.check();
      const hireProfile = current.hireSizing?.name;
      if (hireProfile !== "grid-v1" && hireProfile !== "grid-shift-v1") {
        throw new Error(`This hire has an unexpected non-grid profile (${hireProfile ?? "missing"}).`);
      }
      const armed = await run.guarded(() => armGridAgent({
        agentId: id!,
        pool: props.pool!,
        uiPresetId: props.uiPresetId,
        capitalBnb: props.capitalBnb,
        stopLossPct: props.stopLossPct,
        takeProfitPct: props.takeProfitPct,
        signEnvelope: (action, targetId, params) => run.guarded(() => owner.signEnvelope(action, targetId, params)),
        hireProfile,
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
      <p style={{ color: "var(--text-muted)", font: "var(--type-body-sm)", margin: 0 }}>
        Session <code>{agentId}</code> is live on chain. One step left: arm the grid, which wraps your budget and mints both rungs. <strong>Until it is armed the agent holds no position and places no orders.</strong>
      </p>
      <div>
        <button type="button" style={busyBtn(running, primaryBtn)} onClick={() => void deployAll()} disabled={running}>
          Arm the grid
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
