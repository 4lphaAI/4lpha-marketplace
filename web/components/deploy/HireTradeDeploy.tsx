"use client";
import { accountHireStorage, accountSwitchRequiresContinue, assertHireOwner } from "@/lib/exec/account-hire-storage";

import { walletBlockerAgentId } from "@/lib/altana/hire-wallet-blocker";

import * as React from "react";
import { formatEther, getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { FundsModal, type FundsWallet } from "@/components/FundsModal";
import { grantAgentSession, GrantAgentSessionError } from "@/lib/altana/client";
import { runCmcContinuation } from "@/lib/altana/cmc-continuation";
import { GridDeployRun, GridDeployStopped } from "@/lib/altana/grid-hire-recovery";
import { depositAmountWei, requiredTradeDepositWei } from "@/lib/altana/hire-funding";
import { tradfiV2FundingSnapshot, type TradfiV2FundingSnapshot } from "@/lib/altana/trade-funding";
import { freshFundingGate, type HireSessionView } from "@/lib/altana/hire-state";
import { rememberReadExpiry } from "@/lib/exec/read-session-window";
import { encodeReadHeader, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import { DEPLOYED_HOLD_MS, DeployRunModal, IDLE_DEPLOY_STEPS, type DeployStep, type DeployStepDef, type DeployStepKey, type DeployStepState } from "./DeployRunModal";
import {
  maxGrantedTokens,
  MAX_PLATFORM_FEE_BPS,
  MIN_TRADE_CAPITAL_WEI,
  checkTradeSizing,
  DCA_ERROR_COPY,
  PORTFOLIO_ERROR_COPY,
  dcaNativeReserveWei,
  formatMinimumBnb,
  parseTradeHirePreviewEnvelope,
  parseBnbToWei,
  scheduleBuysThisSession,
  tradfiScheduleNativeReserveWei,
  tradfiV2NativeReserveWei,
  tradfiPortfolioNativeReserveWei,
  type TradeExecutionModel,
  type TradeHirePreview,
  type TradeSettings,
} from "@/lib/trade";

const primaryBtn: React.CSSProperties = { cursor: "pointer", padding: "14px 22px", borderRadius: "var(--radius-sm)", background: "var(--cat-yield)", border: "none", color: "#08110c", font: "var(--weight-medium) var(--text-md)/1 var(--font-sans)" };
const secondaryBtn: React.CSSProperties = { ...primaryBtn, background: "transparent", color: "var(--cat-yield)", border: "1px solid var(--cat-yield)", padding: "10px 16px", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" };
const busyBtn = (busy: boolean, base: React.CSSProperties): React.CSSProperties => busy ? { ...base, cursor: "wait", opacity: 0.6 } : base;

/* The deploy popup's steps. A trade hire has no arm of its own: the plane arms
   it when the grant converges, so the last step is the hand-over (plus the CMC
   data-budget confirmation when the owner opted in). */
function tradeDeploySteps(cmc: boolean): readonly DeployStepDef[] {
  return [
    { key: "hire", title: "Sign the hire", hint: "One passkey signature creates the scoped session key" },
    { key: "fund", title: "Fund the agent wallet", hint: "Only when the wallet is short of capital, the registration fee or relay gas" },
    { key: "grant", title: "Grant the session on chain", hint: "Your passkey authorises the session; the relay submits it" },
    { key: "converge", title: "Verify the grant", hint: "Relay, account, KeyStore and owner binding must all agree" },
    { key: "arm", title: "Start the agent", hint: cmc
      ? "Your passkey confirms the CMC data budget once; the agent then trades from your signed settings"
      : "The agent trades from your signed settings — no further signature" },
  ];
}

const HIRE_STORAGE_KEY = "4lpha:trade-hire:v2";
const HIRE_REQUEST_TIMEOUT_MS = 35_000;
const PREVIEW_INCOMPATIBLE_MESSAGE = "Trading hire preview is incompatible. Restart or update the execution plane, then retry.";

type TradeHireParamsWire = {
  readonly walletAddress: string;
  readonly capDayWei: string;
  readonly ttlSec: number;
  readonly sizingPreset: "trade-v1";
  readonly executionModel: TradeExecutionModel;
  readonly hireRunId: string;
  readonly autoGrant: true;
  readonly settings: TradeSettings;
};

type TradeHireRecord = {
  readonly version: 2;
  readonly agentId: string;
  readonly hireRunId: string;
  readonly provisionEnvelope: OwnerActionEnvelope | null;
};

type TradeHireSeed = {
  readonly hireRunId: string;
  readonly params: TradeHireParamsWire;
  readonly startIndex: number;
};

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

function agentIdFromName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96);
  return slug === "" ? "trading-agent" : slug;
}

function candidateId(base: string, index: number): string {
  return index === 1 ? base : `${base}-${index}`;
}

function nextCandidateIndex(base: string, currentId: string): number {
  if (currentId === base) return 2;
  const suffix = currentId.startsWith(`${base}-`) ? currentId.slice(base.length + 1) : "";
  return /^\d+$/u.test(suffix) && Number.isSafeInteger(Number(suffix)) && Number(suffix) >= 2
    ? Number(suffix) + 1
    : 2;
}

function previewMinimumWei(preview: TradeHirePreview): bigint {
  const required = BigInt(preview.sizing.capitalRequiredWei);
  return required > MIN_TRADE_CAPITAL_WEI ? required : MIN_TRADE_CAPITAL_WEI;
}

function formatUsdtWei(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString(10).padStart(18, "0").replace(/0+$/u, "");
  return fraction === "" ? whole.toString(10) : `${whole}.${fraction}`;
}

function v2NativeReserveFromPreview(preview: TradeHirePreview): bigint {
  const sizing = preview.sizing as TradfiPreviewSizing;
  if (sizing.nativeReserveWei !== undefined) return BigInt(sizing.nativeReserveWei);
  return tradfiV2NativeReserveWei({ maxOpenPositions: sizing.maxOpenPositions, grantedTokenCount: sizing.grantedTokenCount, relayFeeWei: BigInt(sizing.tradeRelayFeePerSubmitWei) });
}

// R2.3 (MEDIUM-1): a failed preview must name the side that is actually short. Only the BNB
// relay reserve, never the USDT sentence, when nativeShortfallWei is positive and the USDT
// side (capitalShortfallWei) is zero.
function nativeReserveShortfallMessage(sizing: TradfiPreviewSizing): string | null {
  if (sizing.nativeShortfallWei === undefined || BigInt(sizing.nativeShortfallWei) <= 0n) return null;
  if (BigInt(sizing.capitalShortfallWei) > 0n) return null;
  if (sizing.tradeMode === "dca") return `BNB day cap is too small; Auto DCA needs ${formatEther(BigInt(sizing.nativeReserveWei ?? "0"))} BNB.`;
  if (sizing.tradeMode === "portfolio") return `Smart Portfolio needs a BNB day cap of at least ${formatEther(BigInt(sizing.nativeReserveWei ?? "0"))} BNB.`;
  return `BNB relay reserve is too small; the plane needs ${formatEther(BigInt(sizing.nativeReserveWei ?? "0"))} BNB for ${sizing.buysThisSession ?? 0} buys.`;
}

export function TradfiFundingSummary(props: { readonly funding: TradfiV2FundingSnapshot }): React.ReactElement {
  const { funding } = props;
  return <div data-testid="tradfi-v2-funding-summary" style={{ display: "grid", gap: 6 }}>
    <p data-testid="tradfi-bnb-funding">BNB target (registration + reserve): {formatEther(funding.nativeTargetWei)} BNB · balance {funding.nativeBalanceWei === null ? "unavailable" : formatEther(funding.nativeBalanceWei)} BNB · shortfall {formatEther(funding.nativeShortfallWei)} BNB.</p>
    <p data-testid="tradfi-usdt-funding">USDT target: {formatUsdtWei(funding.quoteRequiredWei)} USDT · balance {funding.quoteBalanceWei === null ? "unavailable" : formatUsdtWei(funding.quoteBalanceWei)} USDT · shortfall {formatUsdtWei(funding.quoteShortfallWei)} USDT.</p>
  </div>;
}

type TradfiPreviewSizing = TradeHirePreview["sizing"] & {
  readonly minEntryWei?: string;
  readonly capitalQuoteWei?: string;
  readonly cmcNewsEnabled?: boolean;
  readonly cmcTotalBudgetWei?: string;
  readonly tradeMode?: "schedule" | "dca" | "portfolio";
  readonly plannedBuys?: number;
  readonly buysThisSession?: number;
};

function errorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  return (payload as { error?: { code?: string } }).error?.code ?? null;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: { code?: string; message?: string } }).error;
  if (error?.code === "wallet_in_use") {
    return error.message ?? "Remove the existing agent before deploying Trading Agent.";
  }
  if (error?.code === "schedule_token_not_granted") {
    return error.message ?? "The selected bStock is no longer part of the granted list. Pick another token.";
  }
  if (error?.code === "schedule_token_unquotable") {
    return error.message ?? "The selected bStock no longer quotes at this amount. Lower the amount per buy or pick another token.";
  }
  if (error?.code === "schedule_first_buy_out_of_session") {
    return error.message ?? "First buy must fall inside the 7-day session.";
  }
  if (error?.code === "schedule_end_in_past") {
    return error.message ?? "The end date must be in the future.";
  }
  if (error?.code !== undefined && DCA_ERROR_COPY[error.code] !== undefined) return error.message ?? DCA_ERROR_COPY[error.code]!;
  if (error?.code !== undefined && PORTFOLIO_ERROR_COPY[error.code] !== undefined) return error.message ?? PORTFOLIO_ERROR_COPY[error.code]!;
  return error?.message ?? error?.code ?? fallback;
}


class ContinuationReadError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message);
    this.name = "ContinuationReadError";
  }
}

class HireRequestTimeoutError extends Error {
  constructor() {
    super("The execution plane did not answer in time. Continue deploy retries the exact saved hire; no new grant was submitted.");
    this.name = "HireRequestTimeoutError";
  }
}

class HireResponseJsonError extends Error {
  constructor(readonly status: number, readonly ok: boolean) {
    super("The execution plane returned an unreadable response.");
    this.name = "HireResponseJsonError";
  }
}

async function hireJson(input: RequestInfo | URL, init?: RequestInit): Promise<{
  readonly response: Response;
  readonly payload: unknown;
}> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HIRE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new HireResponseJsonError(response.status, response.ok);
    }
    return { response, payload };
  } catch (error) {
    if (timedOut) throw new HireRequestTimeoutError();
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

class PreviewCompatibilityError extends Error {
  constructor() {
    super(PREVIEW_INCOMPATIBLE_MESSAGE);
    this.name = "PreviewCompatibilityError";
  }
}

function writeHireRecord(record: TradeHireRecord, hireStorage: Storage): void {
  hireStorage.setItem(HIRE_STORAGE_KEY, JSON.stringify(record));
}

function readHireRecord(hireStorage: Storage): TradeHireRecord | null {
  const raw = hireStorage.getItem(HIRE_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<TradeHireRecord>;
    return value.version === 2 && typeof value.agentId === "string" && typeof value.hireRunId === "string"
      && (value.provisionEnvelope === null || typeof value.provisionEnvelope === "object")
      ? value as TradeHireRecord
      : null;
  } catch {
    return null;
  }
}

function envelopeParams(envelope: OwnerActionEnvelope): TradeHireParamsWire {
  return envelope.params as TradeHireParamsWire;
}

export function HireTradeDeploy(props: {
  readonly agentName: string;
  readonly executionModel: TradeExecutionModel;
  readonly capitalBnb: string;
  readonly settings: TradeSettings;
  readonly go: (route: string) => void;
  readonly blockedReason?: string | null;
  readonly showCrashProtection?: boolean;
  /** Opens the custody picker before a fresh hire; `proceed` runs the Altana deploy unchanged. */
  readonly chooseCustody?: (proceed: () => void) => void;
  /** Reports what currently blocks the Altana hire, so the custody picker can refuse that choice with its reason. */
  readonly onAltanaBlocked?: (reason: string | null) => void;
}) {
  const owner = useOwnerActions();
  const hireStorage = React.useMemo(() => accountHireStorage(typeof window === "undefined" ? undefined : window.localStorage, owner.ownerAddress), [owner.ownerAddress]);
  const { address: connectedAddress } = useAccount();
  const [record, setRecord] = React.useState<TradeHireRecord | null>(null);
  const [view, setView] = React.useState<HireSessionView | null>(null);
  const [preview, setPreview] = React.useState<TradeHirePreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  // While a changed setting re-prices the preview, the last one stays on screen
  // (dimmed) so the panel keeps its height instead of collapsing and regrowing.
  const [previewPending, setPreviewPending] = React.useState(false);
  const lastPreview = React.useRef<TradeHirePreview | null>(null);
  if (preview !== null) lastPreview.current = preview;
  const [working, setWorking] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [legacyAmbiguous, setLegacyAmbiguous] = React.useState(false);
  const [deposit, setDeposit] = React.useState(false);
  const [depositWei, setDepositWei] = React.useState<bigint | null>(null);
  const [depositAtomic, setDepositAtomic] = React.useState<bigint | null>(null);
  const [depositAsset, setDepositAsset] = React.useState<"BNB" | "USDT">("BNB");
  const [steps, setSteps] = React.useState<Record<DeployStepKey, DeployStep>>(IDLE_DEPLOY_STEPS);
  const [running, setRunning] = React.useState(false);
  const activeRun = React.useRef<GridDeployRun | null>(null);
  const mounted = React.useRef(true);
  const deployRef = React.useRef<() => Promise<void>>(async () => undefined);
  const resumed = React.useRef(false);
  const hireSettings = React.useMemo(() => props.settings.crashProtection === undefined
    ? { ...props.settings, crashProtection: true }
    : props.settings, [props.settings]);

  const isTradfiV2 = hireSettings.settlementAsset === "USDT" && props.executionModel === "tradfi";
  const isSchedule = isTradfiV2 && hireSettings.tradeMode === "schedule";
  const isDca = isTradfiV2 && hireSettings.tradeMode === "dca";
  const isPortfolio = isTradfiV2 && hireSettings.tradeMode === "portfolio";
  // R2.9: an Auto DCA hire signs `capDayWei = dcaNativeReserveWei(N)` from this mirror;
  // the provision route's check is the authority.
  const dcaOrders = hireSettings.dcaMaxOrders ?? 0;
  const dcaCapDayWei = isDca && Number.isInteger(dcaOrders) && dcaOrders >= 1 && dcaOrders <= 8 ? dcaNativeReserveWei(dcaOrders) : 0n;
  const portfolioCapDayWei = isPortfolio ? tradfiPortfolioNativeReserveWei({ tokenCount: hireSettings.portfolioTokens!.length,
    intervalSec: hireSettings.portfolioIntervalSec! }) : 0n;
  // The fee-ceiling figure sizes the first request; the preview comparison
  // recomputes at the plane's own fee (the DTO carries it) — at the ceiling a
  // budget-bound schedule never matches a 100-bps plane's plannedBuys.
  const schedulePlannedBuysAt = (feeBps: number): number => {
    const scheduleReservation = isSchedule ? BigInt(hireSettings.entryWei) + BigInt(hireSettings.entryWei) * BigInt(feeBps) / 10_000n : 0n;
    if (!isSchedule || scheduleReservation <= 0n) return 0;
    const capital = BigInt(hireSettings.capitalQuoteWei ?? "0");
    const raw = Number(capital / scheduleReservation);
    const bounded = Number.isSafeInteger(raw) ? raw : Number.MAX_SAFE_INTEGER;
    const byRuns = hireSettings.scheduleEndKind === "runs" ? Math.min(bounded, hireSettings.scheduleEndRuns ?? 0) : bounded;
    return hireSettings.scheduleEndKind === "date" && hireSettings.scheduleEndAtSec !== null && hireSettings.scheduleEndAtSec !== undefined
      ? Math.min(byRuns, Math.max(0, Math.floor((hireSettings.scheduleEndAtSec * 1_000 - (hireSettings.scheduleFirstAtSec ?? Math.floor(Date.now() / 1_000)) * 1_000 - 1) / ((hireSettings.scheduleIntervalSec ?? 86400) * 1_000)) + 1))
      : byRuns;
  };
  const schedulePlannedBuys = schedulePlannedBuysAt(MAX_PLATFORM_FEE_BPS);
  const conservativeNativeCapWei = isSchedule ? tradfiScheduleNativeReserveWei({ plannedBuys: schedulePlannedBuys, buysThisSession: scheduleBuysThisSession(604_800, hireSettings.scheduleIntervalSec!) })
    : isTradfiV2 ? tradfiV2NativeReserveWei({
    maxOpenPositions: Number.isInteger(hireSettings.maxOpenPositions) && hireSettings.maxOpenPositions >= 1 && hireSettings.maxOpenPositions <= 10 ? hireSettings.maxOpenPositions : 1,
    grantedTokenCount: maxGrantedTokens(props.executionModel),
  }) : null;
  const [v2NativeCapWei, setV2NativeCapWei] = React.useState<bigint | null>(null);
  const capDayWei = isPortfolio ? portfolioCapDayWei : isDca ? dcaCapDayWei : isTradfiV2 ? v2NativeCapWei ?? conservativeNativeCapWei ?? 0n : parseBnbToWei(props.capitalBnb);
  React.useEffect(() => {
    if (!isTradfiV2) setV2NativeCapWei(null);
  }, [isTradfiV2, hireSettings.maxOpenPositions, hireSettings.entryWei]);
  const conservativeSizing = isTradfiV2 ? null : checkTradeSizing({
      capDayWei,
      entryWei: BigInt(hireSettings.entryWei),
      maxOpenPositions: hireSettings.maxOpenPositions,
      grantedTokenCount: maxGrantedTokens(props.executionModel),
      platformFeeBps: MAX_PLATFORM_FEE_BPS,
    });
  const previewMatches = preview !== null
    && preview.capDayWei === capDayWei.toString(10)
    && preview.sizing.executionModel === props.executionModel
    && preview.sizing.entryWei === hireSettings.entryWei
    && preview.sizing.maxOpenPositions === hireSettings.maxOpenPositions
    && (!isTradfiV2 || ((preview.sizing as TradfiPreviewSizing).minEntryWei === hireSettings.minEntryWei
      && (preview.sizing as TradfiPreviewSizing).capitalQuoteWei === hireSettings.capitalQuoteWei
      // R2.10 (LOW-7): plannedBuys/buysThisSession are derived from scheduleIntervalSec,
      // scheduleEndKind/Runs/AtSec and scheduleFirstAtSec — an exact-value match against a
      // client recomputation AT THE PLANE'S FEE catches a change to the interval and to
      // the budget/runs/date bound; the response DTO does not otherwise echo them back.
      && (!isSchedule || ((preview.sizing as TradfiPreviewSizing).tradeMode === "schedule"
        && (preview.sizing as TradfiPreviewSizing).plannedBuys === schedulePlannedBuysAt((preview.sizing as TradfiPreviewSizing).platformFeeBps)
        && (preview.sizing as TradfiPreviewSizing).buysThisSession === scheduleBuysThisSession(604_800, hireSettings.scheduleIntervalSec!)))
      // The DCA preview echoes the mode, the one stock and the reserve for N; the step and TP only move its economics lines.
      && (!isDca || (preview.sizing.tradeMode === "dca" && preview.pin[0]?.address.toLowerCase() === hireSettings.dcaToken
        && preview.sizing.nativeReserveWei === dcaCapDayWei.toString(10)))
      && (!isPortfolio || (preview.sizing.tradeMode === "portfolio" && preview.sizing.nativeReserveWei === portfolioCapDayWei.toString(10)
        && preview.pin.map((token) => token.address.toLowerCase()).join(",") === hireSettings.portfolioTokens?.join(",")))));
  const sizingOk = previewMatches ? preview.sizing.ok : isTradfiV2 ? true : conservativeSizing?.ok === true;
  const minimumWei = previewMatches ? previewMinimumWei(preview) : conservativeSizing?.minimumCapWei ?? 0n;
  const sizingMessage = sizingOk ? null
    : isTradfiV2 && previewMatches
      ? nativeReserveShortfallMessage(preview.sizing as TradfiPreviewSizing)
        ?? `USDT capital is too small at the configured ${((preview.sizing.platformFeeBps ?? 0) / 100).toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "")}% buy fee. Raise it to at least ${formatUsdtWei(BigInt(preview.sizing.capitalRequiredWei))} USDT; BNB relay fees are separate.`
      : isTradfiV2 ? null : `Total capital is too small. Raise it to at least ${formatMinimumBnb(minimumWei)} BNB.`;
  const nativeCapBlock = isTradfiV2 && !isDca && !isPortfolio && v2NativeCapWei === null ? "Reading the live stock count to set the native relay reserve…" : null;
  const blocked = props.blockedReason ?? previewError ?? sizingMessage ?? nativeCapBlock;
  const { onAltanaBlocked } = props;
  React.useEffect(() => { onAltanaBlocked?.(blocked); }, [blocked, onAltanaBlocked]);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resumed.current = false;
      const detached = activeRun.current;
      activeRun.current = null;
      detached?.stop();
    };
  }, []);

  const mark = React.useCallback((key: DeployStepKey, state: DeployStepState, detail?: string): void => {
    setSteps((current) => ({ ...current, [key]: detail === undefined ? { state } : { state, detail } }));
  }, []);
  /** The step in flight fails with the reason; with none in flight, the first one not yet reached. */
  const failActive = React.useCallback((text: string): void => {
    setSteps((current) => {
      const keys = Object.keys(current) as DeployStepKey[];
      const key = keys.find((entry) => current[entry].state === "active")
        ?? keys.find((entry) => current[entry].state === "pending") ?? "hire";
      return { ...current, [key]: { state: "failed", detail: text } };
    });
  }, []);

  const assertRunActive = React.useCallback((run: GridDeployRun): void => {
    run.check();
    if (!mounted.current || activeRun.current !== run) throw new GridDeployStopped();
  }, []);

  const fetchPreview = React.useCallback(async (params: Pick<TradeHireParamsWire, "walletAddress" | "capDayWei" | "executionModel" | "settings">): Promise<TradeHirePreview> => {
    const query = new URLSearchParams({
      walletAddress: params.walletAddress,
      capDayWei: params.capDayWei,
      sizingPreset: "trade-v1",
      executionModel: params.executionModel,
      entryWei: params.settings.entryWei,
      maxOpenPositions: String(params.settings.maxOpenPositions),
      ...(params.settings.settlementAsset === "USDT" ? {
        settlementAsset: "USDT",
        minEntryWei: params.settings.minEntryWei ?? "0",
        capitalQuoteWei: params.settings.capitalQuoteWei ?? "0",
        cmcNewsEnabled: String(params.settings.cmcNewsEnabled === true),
        ...(params.settings.cmcTotalBudgetWei === undefined ? {} : { cmcTotalBudgetWei: params.settings.cmcTotalBudgetWei }),
        ...(params.settings.tradeMode === "schedule" ? {
          tradeMode: "schedule",
          scheduleIntervalSec: String(params.settings.scheduleIntervalSec),
          scheduleEndKind: params.settings.scheduleEndKind!,
          ...(params.settings.scheduleEndRuns === null ? {} : { scheduleEndRuns: String(params.settings.scheduleEndRuns) }),
          ...(params.settings.scheduleEndAtSec === null ? {} : { scheduleEndAtSec: String(params.settings.scheduleEndAtSec) }),
          ...(params.settings.scheduleFirstAtSec === null ? {} : { scheduleFirstAtSec: String(params.settings.scheduleFirstAtSec) }),
        } : params.settings.tradeMode === "dca" ? {
          tradeMode: "dca", dcaToken: params.settings.dcaToken ?? "", dcaStepBps: String(params.settings.dcaStepBps),
          dcaTakeProfitBps: String(params.settings.dcaTakeProfitBps), dcaOrderWei: params.settings.dcaOrderWei ?? "0", dcaMaxOrders: String(params.settings.dcaMaxOrders),
        } : params.settings.tradeMode === "portfolio" ? {
          tradeMode: "portfolio", portfolioTokens: params.settings.portfolioTokens?.join(",") ?? "",
          portfolioIntervalSec: String(params.settings.portfolioIntervalSec),
        } : {}),
      } : {}),
    });
    let response: Response;
    let payload: unknown;
    try {
      const result = await hireJson(`/api/agents/hire/preview?${query}`, { cache: "no-store" });
      response = result.response;
      payload = result.payload;
    } catch (error) {
      if (error instanceof HireResponseJsonError && !error.ok) throw new Error(`HTTP ${error.status}`);
      if (!(error instanceof HireResponseJsonError)) throw error;
      throw new PreviewCompatibilityError();
    }
    if (response.status === 404) throw new Error("Hire is not enabled on this execution plane.");
    if (!response.ok) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
    try {
      const data = parseTradeHirePreviewEnvelope(payload);
      if (data.capDayWei !== params.capDayWei
        || data.sizing.executionModel !== params.executionModel
        || data.sizing.entryWei !== params.settings.entryWei
        || data.sizing.maxOpenPositions !== params.settings.maxOpenPositions
        || (params.settings.settlementAsset === "USDT" && ((data.sizing as TradfiPreviewSizing).minEntryWei !== params.settings.minEntryWei
          || (data.sizing as TradfiPreviewSizing).capitalQuoteWei !== params.settings.capitalQuoteWei
          || params.settings.tradeMode === "schedule" && (data.sizing as TradfiPreviewSizing).tradeMode !== "schedule"
          || params.settings.tradeMode === "dca" && (data.sizing.tradeMode !== "dca" || data.pin[0]?.address.toLowerCase() !== params.settings.dcaToken)))) {
        throw new Error("Preview tuple mismatch.");
      }
      if (params.settings.tradeMode === "portfolio" && (data.sizing.tradeMode !== "portfolio"
        || data.sizing.nativeReserveWei !== params.capDayWei
        || data.pin.map((token) => token.address.toLowerCase()).join(",") !== params.settings.portfolioTokens?.join(","))) throw new Error("Preview tuple mismatch.");
      return data;
    } catch {
      throw new PreviewCompatibilityError();
    }
  }, []);

  const loadPreview = React.useCallback(async (params: Pick<TradeHireParamsWire, "walletAddress" | "capDayWei" | "executionModel" | "settings">): Promise<TradeHirePreview> => {
    const data = await fetchPreview(params);
    if (!data.sizing.ok) {
      if (params.settings.settlementAsset === "USDT") {
        const nativeMessage = nativeReserveShortfallMessage(data.sizing as TradfiPreviewSizing);
        if (nativeMessage !== null) throw new Error(nativeMessage);
        throw new Error(`USDT capital is below the required maximum-entry budget. Raise it to at least ${formatUsdtWei(BigInt(data.sizing.capitalRequiredWei))} USDT.`);
      }
      throw new Error(`Total capital must be at least ${formatMinimumBnb(previewMinimumWei(data))} BNB.`);
    }
    return data;
  }, [fetchPreview]);

  React.useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (owner.walletAddress === undefined
      || (props.blockedReason !== null && props.blockedReason !== undefined)) { setPreviewPending(false); return; }
    setPreviewPending(true);
    let current = true;
    void fetchPreview({
      walletAddress: owner.walletAddress,
      capDayWei: capDayWei.toString(10),
      executionModel: props.executionModel,
      settings: hireSettings,
    }).then((result) => {
      if (current) {
        if (isTradfiV2 && !isDca && !isPortfolio) {
          const exactNativeCapWei = v2NativeReserveFromPreview(result);
          // A schedule reserve scales with the plane's capable-token count, which
          // can move by one between previews (venue freshness); adopting the
          // exact figure then oscillates below the next reserve and blocks
          // Deploy. Never go below the conservative (max-granted) figure.
          const scheduleFloorWei = isSchedule ? conservativeNativeCapWei ?? 0n : 0n;
          const nextNativeCapWei = exactNativeCapWei > scheduleFloorWei ? exactNativeCapWei : scheduleFloorWei;
          if (v2NativeCapWei !== nextNativeCapWei) setV2NativeCapWei(nextNativeCapWei);
        }
        setPreview(result);
        setPreviewError(null);
        setPreviewPending(false);
      }
    }).catch((error: unknown) => {
      if (current) setPreviewPending(false);
      if (current && error instanceof PreviewCompatibilityError) {
        setPreview(null);
        setPreviewError(PREVIEW_INCOMPATIBLE_MESSAGE);
      }
    });
    return () => { current = false; };
  }, [capDayWei, fetchPreview, hireSettings, isDca, isPortfolio, isTradfiV2, owner.walletAddress, props.blockedReason, props.executionModel, v2NativeCapWei]);

  const readContinuation = React.useCallback(async (current: TradeHireRecord): Promise<HireSessionView> => {
    if (current.provisionEnvelope === null) throw new Error("The hire signature was not completed; press Sign hire again.");
    assertHireOwner(current.provisionEnvelope, owner.ownerAddress, owner.walletAddress);
    const { response, payload } = await hireJson(`/api/agents/${encodeURIComponent(current.agentId)}/session`, {
      headers: { "x-provision-action": encodeReadHeader(current.provisionEnvelope) },
      credentials: "omit",
      cache: "no-store",
    });
    const parsed = payload as { data?: HireSessionView };
    if (!response.ok || parsed.data === undefined) {
      throw new ContinuationReadError(response.status, errorMessage(payload, `HTTP ${response.status}`), errorCode(payload));
    }
    if (parsed.data.hireRunId !== current.hireRunId) {
      throw new ContinuationReadError(409, "The stored hire pointer does not match this agent.");
    }
    return parsed.data;
  }, [hireStorage, owner.ownerAddress, owner.walletAddress]);

  const submitSignedHire = React.useCallback(async (current: TradeHireRecord): Promise<HireSessionView> => {
    if (current.provisionEnvelope === null) throw new Error("The hire signature was not completed; press Sign hire again.");
    assertHireOwner(current.provisionEnvelope, owner.ownerAddress, owner.walletAddress);
    const { response, payload } = await hireJson(`/api/agents/${encodeURIComponent(current.agentId)}/session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(current.provisionEnvelope),
    });
    const parsed = payload as { data?: HireSessionView };
    if (!response.ok || parsed.data === undefined) {
      throw new ContinuationReadError(response.status, errorMessage(payload, `HTTP ${response.status}`), errorCode(payload));
    }
    if (parsed.data.hireRunId !== current.hireRunId) {
      throw new ContinuationReadError(409, "The signed hire response does not match this run.", "conflict");
    }
    if (parsed.data.readSession !== undefined) rememberReadExpiry(hireStorage, parsed.data.readSession.expiry * 1_000);
    return parsed.data;
  }, [hireStorage, owner.ownerAddress, owner.walletAddress]);

  /**
   * CMC-HIRE-SETUP R5: complete the owner's already-signed CMC opt-in as a
   * continuation of the `provisionAgent` signature, so a TradFi hire with CMC
   * on reaches READY without a second `tradeCmcBudget` signature. R-4: this
   * step never fails, blocks or rolls back the hire — every error is caught,
   * except a stopped run (R5.2).
   */
  const setupHireCmc = React.useCallback(async (
    run: GridDeployRun,
    agentId: string,
    envelope: OwnerActionEnvelope,
    signedParams: TradeHireParamsWire,
    current: HireSessionView,
  ): Promise<void> => {
    try {
      if (signedParams.settings.settlementAsset !== "USDT" || signedParams.settings.cmcNewsEnabled !== true
        || signedParams.settings.cmcTotalBudgetWei === undefined || current.status !== "armed"
        || current.agent?.session == null || owner.passkey === null) return;
      const wallet = getAddress(signedParams.walletAddress);
      if (getAddress(current.agent.walletAddress) !== wallet) return;
      await runCmcContinuation({
        agentId, header: { name: "x-provision-action", value: encodeReadHeader(envelope) }, expectedMode: "topup",
        ownerAddress: owner.ownerAddress, wallet, passkey: owner.passkey,
        sessionPublicKey: current.agent.session.publicKey, sessionExpiry: current.agent.session.expiresAt,
        incrementWei: signedParams.settings.cmcTotalBudgetWei, run, check: () => assertRunActive(run), requestJson: hireJson,
        preparing: () => {
          setWorking("Setting up the CMC data budget from your signed hire…");
          mark("arm", "active", "Setting up the CMC data budget from your signed hire…");
        },
        executing: () => {
          setWorking("Confirm the CMC data budget with your passkey…");
          mark("arm", "active", "Confirm the CMC data budget with your passkey…");
        },
      });
    } catch (error) {
      if (error instanceof GridDeployStopped) throw error;
    }
  }, [assertRunActive, mark, owner.ownerAddress, owner.passkey]);

  const startHire = React.useCallback(async (run: GridDeployRun, seed?: TradeHireSeed): Promise<{ readonly record: TradeHireRecord; readonly view: HireSessionView }> => {
    if (owner.passkey === null || owner.walletAddress === undefined) throw new Error("Create or recover your passkey wallet first.");
    if (seed === undefined && blocked !== null) throw new Error(blocked);
    const hireRunId = seed?.hireRunId ?? crypto.randomUUID().toLowerCase();
    const params: TradeHireParamsWire = seed?.params ?? {
      walletAddress: owner.walletAddress,
      capDayWei: capDayWei.toString(10),
      ttlSec: 604_800,
      sizingPreset: "trade-v1",
      executionModel: props.executionModel,
      hireRunId,
      autoGrant: true,
      settings: hireSettings,
    };
    if (getAddress(params.walletAddress) !== getAddress(owner.walletAddress)) {
      throw new Error("The saved hire belongs to a different passkey wallet.");
    }
    const base = agentIdFromName(params.settings.name);
    setWorking("Reading the live pinned tokens and funding estimate…");
    mark("hire", "active", "Reading the live pinned tokens and funding estimate…");
    const initialPreview = await run.guarded(() => loadPreview(params));
    assertRunActive(run);
    setPreview(initialPreview);
    setPreviewError(null);
    for (let index = seed?.startIndex ?? 1; index <= 100; index += 1) {
      assertRunActive(run);
      const agentId = candidateId(base, index);
      const pointer: TradeHireRecord = { version: 2, agentId, hireRunId, provisionEnvelope: null };
      writeHireRecord(pointer, hireStorage);
      setRecord(pointer);
      const prompt = index === 1
        ? "Confirm the hire signature with your passkey…"
        : `${candidateId(base, index - 1)} is taken. Confirm the signature for ${agentId}…`;
      setWorking(prompt);
      mark("hire", "active", prompt);
      const envelope = await run.guarded(() => owner.signEnvelope("provisionAgent", agentId, params));
      assertRunActive(run);
      const signed: TradeHireRecord = { ...pointer, provisionEnvelope: envelope };
      writeHireRecord(signed, hireStorage);
      setRecord(signed);
        try {
          const submitted = await run.guarded(() => submitSignedHire(signed));
          assertRunActive(run);
          return { record: signed, view: submitted };
      } catch (error) {
        if (!(error instanceof ContinuationReadError)
          || error.status !== 409 || error.code !== "agent_exists") throw error;
      }
      try {
        const existing = await run.guarded(() => readContinuation(signed));
        assertRunActive(run);
        if (existing.status === "provisioning" || existing.status === "armed" || existing.status === "paused") {
          return { record: signed, view: existing };
        }
      } catch (error) {
        if (!(error instanceof ContinuationReadError) || error.status !== 409) throw error;
        assertRunActive(run);
      }
    }
    throw new Error(`Every candidate name around "${base}" is already claimed. Rename the agent and try again.`);
  }, [assertRunActive, blocked, capDayWei, hireSettings, loadPreview, owner.passkey, owner.signEnvelope, owner.walletAddress,
    mark, props.agentName, props.executionModel, readContinuation, submitSignedHire]);

  const deployAll = React.useCallback(async (seed?: TradeHireRecord | null): Promise<void> => {
    if (activeRun.current !== null) return;
    const run = new GridDeployRun();
    activeRun.current = run;
    setMessage(null);
    setSteps(IDLE_DEPLOY_STEPS);
    setRunning(true);
    let resumedSignedRecord = false;
    try {
      if (owner.passkey === null || owner.walletAddress === undefined) {
        throw new Error("Create or recover your passkey wallet first.");
      }
      let currentRecord = seed === undefined ? record : seed;
      resumedSignedRecord = currentRecord?.provisionEnvelope !== null && currentRecord !== null;
      let current: HireSessionView;
      if (currentRecord?.provisionEnvelope === null) {
        hireStorage.removeItem(HIRE_STORAGE_KEY);
        currentRecord = null;
        setRecord(null);
      }
      if (currentRecord === null) {
        const hired = await startHire(run);
        currentRecord = hired.record;
        current = hired.view;
      } else {
        setWorking("Resuming the exact signed hire…");
        mark("hire", "active", "Resuming the exact signed hire…");
        try {
          current = await run.guarded(() => submitSignedHire(currentRecord!));
        } catch (error) {
          if (!(error instanceof ContinuationReadError)) throw error;
          if (error.status === 409 && error.code === "s1_ambiguous") {
            assertRunActive(run);
            setLegacyAmbiguous(true);
            setMessage("The previous signed hire cannot be proven. Restart hire to sign a fresh hire.");
            failActive("The previous signed hire cannot be proven. Restart hire to sign a fresh hire.");
            return;
          }
          if (error.status === 410 && error.code === "hire_no_evidence") {
            assertRunActive(run);
            hireStorage.removeItem(HIRE_STORAGE_KEY);
            setRecord(null);
            setMessage("The previous signature expired before the hire reached the execution plane. Press Sign hire to try again.");
            failActive("The previous signature expired before the hire reached the execution plane. Press Sign hire to try again.");
            return;
          }
          if (error.status !== 409 || (error.code !== "agent_exists" && error.code !== "conflict")) throw error;
          try {
            current = await run.guarded(() => readContinuation(currentRecord!));
          } catch (readError) {
            if (!(readError instanceof ContinuationReadError) || readError.status !== 409) throw readError;
            const priorParams = envelopeParams(currentRecord.provisionEnvelope!);
            const base = agentIdFromName(priorParams.settings.name);
            const hired = await startHire(run, {
              hireRunId: currentRecord.hireRunId,
              params: priorParams,
              startIndex: nextCandidateIndex(base, currentRecord.agentId),
            });
            currentRecord = hired.record;
            current = hired.view;
          }
        }
      }
      assertRunActive(run);
      setView(current);
      mark("hire", "done", `Session key created for ${currentRecord.agentId}`);
      const envelope = currentRecord.provisionEnvelope;
      if (envelope === null) throw new Error("The hire signature is unavailable.");
      const signedParams = envelopeParams(envelope);
      if (current.status === "armed" || current.status === "paused") {
        mark("fund", "skipped", "Already funded.");
        mark("grant", "skipped", "The session is already granted.");
        mark("converge", "done", "The session is live on chain.");
        mark("arm", "active", "Handing the session to the agent…");
        await setupHireCmc(run, currentRecord.agentId, envelope, signedParams, current);
        hireStorage.removeItem(HIRE_STORAGE_KEY);
        mark("arm", "done", current.status === "paused"
          ? "The agent is paused; resume it from its page."
          : "Live — the agent trades from your signed settings.");
        await run.wait(DEPLOYED_HOLD_MS);
        props.go(`/account/${currentRecord.agentId}`);
        return;
      }
      if (current.status === "revoked" || current.status === "retired") {
        hireStorage.removeItem(HIRE_STORAGE_KEY);
        setRecord(null);
        throw new Error(`This hire is already ${current.status}. Choose a new agent name to hire again.`);
      }
      if (current.activationError !== undefined) {
        hireStorage.removeItem(HIRE_STORAGE_KEY);
        setRecord(null);
        throw new Error(`This hire cannot activate (${current.activationError}).`);
      }
      if (current.cancelRequested === true) {
        hireStorage.removeItem(HIRE_STORAGE_KEY);
        setRecord(null);
        throw new Error("This hire has been cancelled and cannot submit another grant.");
      }

      if (current.grantAttempt === undefined) {
        setWorking("Refreshing the funding requirement…");
        mark("fund", "active", "Refreshing the funding requirement…");
        let funded = false;
        let fresh = await run.guarded(() => loadPreview(signedParams));
        assertRunActive(run);
        setPreview(fresh);
        setPreviewError(null);
        let freshness = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
        if (!freshness.ok && freshness.reason !== "short") {
          throw new Error("The live funding estimate is stale or unreadable; press Continue deploy to retry.");
        }
        if (signedParams.settings.settlementAsset === "USDT") {
          let v2Funding: TradfiV2FundingSnapshot = tradfiV2FundingSnapshot({ funding: fresh.funding, sizing: fresh.sizing, capDayWei: signedParams.capDayWei,
            capitalQuoteWei: signedParams.settings.capitalQuoteWei ?? "0", ...(signedParams.settings.cmcTotalBudgetWei === undefined ? {} : { cmcTotalBudgetWei: signedParams.settings.cmcTotalBudgetWei }) });
          const waitForNative = async (): Promise<void> => {
            const sendWei = depositAmountWei(v2Funding.nativeShortfallWei);
            const expectedAfter = (v2Funding.nativeBalanceWei ?? 0n) + sendWei;
            setDepositAsset("BNB"); setDepositWei(sendWei); setDepositAtomic(null); setDeposit(true);
            setWorking(`Confirm the ${formatEther(sendWei)} BNB registration and relay reserve deposit in your wallet…`);
            mark("fund", "active", `Sending ${formatEther(sendWei)} BNB for the registration and relay reserve — confirm in your wallet.`);
            funded = true;
            const deadline = Date.now() + 15 * 60_000;
            while (Date.now() < deadline) {
              await run.wait(6_000);
              fresh = await run.guarded(() => loadPreview(signedParams));
              assertRunActive(run); setPreview(fresh); setPreviewError(null);
              freshness = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
              v2Funding = tradfiV2FundingSnapshot({ funding: fresh.funding, sizing: fresh.sizing, capDayWei: signedParams.capDayWei,
                capitalQuoteWei: signedParams.settings.capitalQuoteWei ?? "0", ...(signedParams.settings.cmcTotalBudgetWei === undefined ? {} : { cmcTotalBudgetWei: signedParams.settings.cmcTotalBudgetWei }) });
              if (freshness.ok && v2Funding.nativeBalanceWei !== null && v2Funding.nativeBalanceWei >= expectedAfter) break;
            }
            if (!freshness.ok || v2Funding.nativeBalanceWei === null || v2Funding.nativeBalanceWei < expectedAfter) {
              throw new Error("The agent wallet is still short of its BNB registration and relay reserve target.");
            }
            setDeposit(false); setDepositWei(null); await run.wait(100);
          };
          const waitForQuote = async (): Promise<void> => {
            const expectedAfter = (v2Funding.quoteBalanceWei ?? 0n) + v2Funding.quoteShortfallWei;
            setDepositAsset("USDT"); setDepositWei(null); setDepositAtomic(v2Funding.quoteShortfallWei); setDeposit(true);
            setWorking(`Confirm the ${formatUsdtWei(v2Funding.quoteShortfallWei)} USDT strategy-capital deposit in your wallet…`);
            mark("fund", "active", `Sending ${formatUsdtWei(v2Funding.quoteShortfallWei)} USDT of strategy capital — confirm in your wallet.`);
            funded = true;
            const deadline = Date.now() + 15 * 60_000;
            while (Date.now() < deadline) {
              await run.wait(6_000);
              fresh = await run.guarded(() => loadPreview(signedParams));
              assertRunActive(run); setPreview(fresh); setPreviewError(null);
              freshness = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
              v2Funding = tradfiV2FundingSnapshot({ funding: fresh.funding, sizing: fresh.sizing, capDayWei: signedParams.capDayWei,
                capitalQuoteWei: signedParams.settings.capitalQuoteWei ?? "0", ...(signedParams.settings.cmcTotalBudgetWei === undefined ? {} : { cmcTotalBudgetWei: signedParams.settings.cmcTotalBudgetWei }) });
              if (freshness.ok && v2Funding.quoteBalanceWei !== null && v2Funding.quoteBalanceWei >= expectedAfter) break;
            }
            if (!freshness.ok || v2Funding.quoteBalanceWei === null || v2Funding.quoteBalanceWei < expectedAfter) {
              throw new Error("The agent wallet is still short of USDT strategy capital and data-budget funding.");
            }
            setDeposit(false); setDepositAtomic(null); await run.wait(100);
          };
          if (v2Funding.nativeShortfallWei > 0n) await waitForNative();
          if (v2Funding.quoteShortfallWei > 0n) await waitForQuote();
        } else {
          const need = requiredTradeDepositWei({ capDayWei: signedParams.capDayWei, funding: fresh.funding });
          if (need.depositShortfallWei > 0n) {
            const sendWei = depositAmountWei(need.depositShortfallWei);
            const balanceBefore = fresh.funding.balanceWei === null ? 0n : BigInt(fresh.funding.balanceWei);
            const expectedAfter = balanceBefore + sendWei;
            setDepositAsset("BNB"); setDepositWei(sendWei); setDepositAtomic(null); setDeposit(true);
            setWorking(`Confirm the ${formatEther(sendWei)} BNB deposit in your wallet…`);
            mark("fund", "active", `Sending ${formatEther(sendWei)} BNB from your wallet to the agent wallet — confirm in your wallet.`);
            funded = true;
            const deadline = Date.now() + 15 * 60_000;
            while (Date.now() < deadline) {
              await run.wait(6_000);
              fresh = await run.guarded(() => loadPreview(signedParams));
              assertRunActive(run); setPreview(fresh); setPreviewError(null);
              freshness = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
              if (freshness.ok && fresh.funding.balanceWei !== null && BigInt(fresh.funding.balanceWei) >= expectedAfter) break;
            }
            if (!freshness.ok || fresh.funding.balanceWei === null || BigInt(fresh.funding.balanceWei) < expectedAfter) {
              throw new Error("The agent wallet is still short of capital, registration fee, and grant gas.");
            }
            setDeposit(false); setDepositWei(null); await run.wait(100);
          }
        }

        mark("fund", funded ? "done" : "skipped", funded
          ? "The wallet covers the capital, the registration fee and the gas."
          : "The wallet already holds the capital, the registration fee and the gas.");
        setWorking("Claiming the durable grant attempt…");
        mark("grant", "active", "Claiming the durable grant attempt…");
        const { response: attemptResponse, payload: rawAttemptPayload } = await run.guarded(() =>
          hireJson(`/api/agents/${encodeURIComponent(currentRecord.agentId)}/session/grant-attempt`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
          }));
        assertRunActive(run);
        const attemptPayload = rawAttemptPayload as {
          data?: HireSessionView & { readonly attemptId?: `0x${string}`; readonly mayInvoke?: boolean };
        };
        if (!attemptResponse.ok || attemptPayload.data === undefined || attemptPayload.data.attemptId === undefined) {
          throw new Error(errorMessage(attemptPayload, `HTTP ${attemptResponse.status}`));
        }
        current = await run.guarded(() => readContinuation(currentRecord!));
        assertRunActive(run);
        setView(current);
        if (current.grantAttempt?.attemptId.toLowerCase() !== attemptPayload.data.attemptId.toLowerCase()) {
          throw new Error("The durable grant attempt changed before invocation.");
        }
        if (attemptPayload.data.mayInvoke === true) {
          if (current.permissions === undefined || current.sessionPublicKey === undefined
            || current.sessionAddress === undefined || current.expiresAt === undefined) {
            throw new Error("The plane has not published the session permissions.");
          }
          setWorking("Confirm the on-chain grant with your passkey…");
          mark("grant", "active", "Confirm the on-chain session grant with your passkey…");
          try {
            await run.guarded(() => grantAgentSession({
              record: owner.passkey!,
              walletAddress: getAddress(signedParams.walletAddress),
              permissions: {
                calls: current.permissions!.calls.map(grantCall),
                spend: current.permissions!.spend.map((spend) => ({
                  ...(spend.token === undefined ? {} : { token: getAddress(spend.token) }),
                  period: spend.period as "minute" | "hour" | "day" | "week" | "month" | "year",
                  limit: BigInt(spend.limit),
                })),
              },
              expiry: current.expiresAt!,
              sessionPublicKey: current.sessionPublicKey!,
              sessionAddress: getAddress(current.sessionAddress!),
            }));
          } catch (error) {
            assertRunActive(run);
            if (!(error instanceof GrantAgentSessionError)
              || !["grant_pending", "grant_unknown", "grant_failed"].includes(error.code)) throw error;
            // A swallowed grant outcome is still news the owner needs while the
            // evidence wait runs: a `grant_failed` never lands, and ten silent
            // minutes read as a hang (2026-09-21, second schedule hire).
            const cause = error.cause instanceof Error ? error.cause.message.replace(/\s+/gu, " ").slice(0, 200) : "";
            setMessage(`The grant reported ${error.code}${cause === "" ? "" : ` (${cause})`}. Waiting for chain evidence; if none arrives, reset the grant attempt and retry.`);
            mark("grant", "active", `${error.code}: checking chain evidence instead of re-granting…`);
          }
          mark("grant", "done", "Submitted. The relay carries it to chain.");
        } else {
          mark("grant", "done", "Already submitted; waiting for chain evidence.");
        }
      } else if (current.status === "provisioning" && Date.now() / 1_000 - current.grantAttempt.startedAtSec > 5 * 60) {
        // A resumed attempt this old never made it to the chain (a completed
        // grant converges in tens of seconds). Waiting another ten minutes
        // without re-prompting the passkey only looks like a hang: hand the
        // owner the reset door now.
        setView(current);
        mark("fund", "skipped", "Already funded.");
        throw new Error(`A grant attempt from ${Math.round((Date.now() / 1_000 - current.grantAttempt.startedAtSec) / 60)} minutes ago never reached the chain. Reset the stalled grant attempt, then Continue deploy to sign the grant again.`);
      } else {
        mark("fund", "skipped", "Already funded.");
        mark("grant", "skipped", "A grant attempt is already on its way.");
      }

      setWorking("Waiting for relay, account, KeyStore, and owner-binding evidence…");
      mark("converge", "active", "Waiting for relay, account, KeyStore and owner-binding evidence…");
      const deadline = Date.now() + 10 * 60_000;
      while (current.status !== "armed" && Date.now() < deadline) {
        if (current.activationError !== undefined) {
          hireStorage.removeItem(HIRE_STORAGE_KEY);
          setRecord(null);
          throw new Error(`This hire cannot activate (${current.activationError}).`);
        }
        if (current.status !== "provisioning" || current.cancelRequested === true) {
          hireStorage.removeItem(HIRE_STORAGE_KEY);
          setRecord(null);
          throw new Error(`This hire cannot continue (${current.status}).`);
        }
        await run.wait(5_000);
        current = await run.guarded(() => readContinuation(currentRecord!));
        assertRunActive(run);
        setView(current);
      }
      if (current.status !== "armed") {
        throw new Error("Grant evidence has not converged yet. Continue deploy only waits; it will not submit another grant.");
      }
      assertRunActive(run);
      mark("converge", "done", "The session is live on chain.");
      mark("arm", "active", "Handing the session to the agent…");
      await setupHireCmc(run, currentRecord.agentId, envelope, signedParams, current);
      hireStorage.removeItem(HIRE_STORAGE_KEY);
      mark("arm", "done", "Live — the agent trades from your signed settings.");
      await run.wait(DEPLOYED_HOLD_MS);
      props.go(`/account/${currentRecord.agentId}`);
    } catch (error) {
      if (mounted.current && activeRun.current === run && !(error instanceof GridDeployStopped)) {
        failActive(error instanceof Error ? error.message : "The deploy could not be completed.");
        if (resumedSignedRecord && error instanceof Error && /too small/u.test(error.message)) {
          // The signed cap and capital can never change; when the plane no longer
          // accepts them (a reserve formula moved under the saved record), resuming
          // would repeat the same refusal for ever. Drop the record; ask for a fresh signature.
          hireStorage.removeItem(HIRE_STORAGE_KEY);
          setRecord(null);
          setMessage(`The saved hire was signed with a funding requirement the plane no longer accepts (${error.message}) Press Sign hire to sign a fresh hire with the current form.`);
        } else setMessage(error instanceof Error ? error.message : "The deploy could not be completed.");
      }
    } finally {
      if (activeRun.current === run) {
        activeRun.current = null;
        if (mounted.current) { setWorking(null); setRunning(false); }
      }
    }
  }, [assertRunActive, failActive, loadPreview, mark, owner.passkey, owner.walletAddress, props.go, readContinuation,
    record, setupHireCmc, startHire, submitSignedHire]);

  React.useEffect(() => {
    if (resumed.current || owner.passkey === null) return;
    resumed.current = true;
    const saved = readHireRecord(hireStorage);
    if (saved === null || saved.provisionEnvelope === null) {
      if (saved !== null) hireStorage.removeItem(HIRE_STORAGE_KEY);
      return;
    }
    setRecord(saved);
    if (!accountSwitchRequiresContinue(hireStorage)) void deployAll(saved);
    else setMessage("Saved hire found for this account. Choose Continue deploy to resume.");
  }, [deployAll, owner.passkey]);

  const resetGrantAttempt = async (): Promise<void> => {
    if (record?.provisionEnvelope === null || record === null || view?.grantAttempt === undefined) return;
    setMessage(null);
    setWorking("Confirm the grant-attempt reset with your passkey…");
    try {
      const params = { attemptId: view.grantAttempt.attemptId } as const;
      const envelope = await owner.signEnvelope("resetGrantAttempt", record.agentId, params);
      const { response, payload: rawPayload } = await hireJson(`/api/agents/${encodeURIComponent(record.agentId)}/session/grant-attempt/reset`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
      });
      const payload = rawPayload as { data?: HireSessionView };
      if (!response.ok || payload.data === undefined) throw new Error(errorMessage(payload, `HTTP ${response.status}`));
      setView(payload.data);
      setWorking(null);
      await deployAll(record);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The grant attempt could not be reset.");
      setWorking(null);
    }
  };

  const restartAmbiguousHire = (): void => {
    if (!legacyAmbiguous || working !== null) return;
    hireStorage.removeItem(HIRE_STORAGE_KEY);
    setRecord(null);
    setView(null);
    setLegacyAmbiguous(false);
    setMessage(null);
    void deployAll(null);
  };

  const fundsWallet: FundsWallet | null = owner.walletAddress === undefined ? null : {
    address: owner.walletAddress,
    custodyModel: "passkey",
    depositable: true,
    source: "declared",
    availableUsdMicros: null,
    deployedUsdMicros: "0",
    deployedReason: "declared",
  };
  // The popup's stop: only while the run waits on the chain (deposit landing,
  // grant evidence) — never across a passkey prompt, where a grant could still
  // land after the owner pressed it. It ends this browser run; the hire stays,
  // and Continue deploy resumes from the durable row (never re-grants).
  const stoppable = running && (steps.fund.state === "active" || steps.converge.state === "active");
  const stopDeploy = (): void => {
    activeRun.current?.stop();
    setDeposit(false);
    setDepositWei(null);
    setDepositAtomic(null);
    const text = "Deploy stopped. Continue deploy when ready; nothing was cancelled.";
    failActive(text);
    setMessage(text);
  };
  const deployStepDefs = tradeDeploySteps(hireSettings.settlementAsset === "USDT" && hireSettings.cmcNewsEnabled === true);
  const fenced = view?.status === "provisioning" && view.grantAttempt !== undefined;
  const blockerAgentId = walletBlockerAgentId(message);
  const blockerHref = blockerAgentId === null ? null : `/account/${blockerAgentId}`;
  const shown = preview ?? (previewPending ? lastPreview.current : null);
  const v2Funding = shown !== null && isTradfiV2 ? tradfiV2FundingSnapshot({ funding: shown.funding, sizing: shown.sizing, capDayWei: capDayWei.toString(10),
    capitalQuoteWei: hireSettings.capitalQuoteWei ?? "0", ...(hireSettings.cmcTotalBudgetWei === undefined ? {} : { cmcTotalBudgetWei: hireSettings.cmcTotalBudgetWei }) }) : null;

  deployRef.current = deployAll;
  // The custody picker opens even while the Altana hire is blocked: the Agentic path has its own checks.
  const custodyPick = record === null && !legacyAmbiguous && props.chooseCustody !== undefined;
  return <div style={{ display: "grid", gap: 14, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
    <span className="fl-eyebrow">Hire the scoped agent session</span>
    {props.showCrashProtection === false ? null : <p>Crash protection: {hireSettings.crashProtection === true ? "ON" : "OFF"}.</p>}
    {shown ? <div aria-busy={preview === null} style={{ opacity: preview === null ? 0.55 : 1, transition: "opacity 120ms", display: "grid", gap: 6, color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      {isTradfiV2
        ? <>{isDca ? <>
            {/* §14.2 funding copy and review line; no pool or venue text (R1). */}
            <p>USDT principal {formatUsdtWei(BigInt(hireSettings.capitalQuoteWei ?? "0"))}. {formatEther(dcaCapDayWei)} BNB covers one busy round a day.</p>
            <p>This agent trades only {shown.pin[0]?.symbol ?? "the selected stock"}.</p>
            {/* R2.16: non-blocking economics lines. */}
            {shown.sizing.economics != null && BigInt(shown.sizing.economics.r0GrossUsdtWei) < BigInt(shown.sizing.economics.r0CostUsdtWei)
              ? <p data-testid="dca-hold-line">At today's gas this agent would wait before starting a round: {shown.pin[0]?.symbol} at TP {(hireSettings.dcaTakeProfitBps ?? 0) / 100} % needs gas below {shown.sizing.economics.holdEngagesAtGwei?.toFixed(4) ?? "—"} gwei.</p> : null}
            {shown.sizing.economics != null && BigInt(shown.sizing.economics.perFillNetUsdtWei) < 0n
              ? <p data-testid="dca-fill-line">At today's gas each DCA order fill on {shown.pin[0]?.symbol} at TP {(hireSettings.dcaTakeProfitBps ?? 0) / 100} % costs about {(Number(-BigInt(shown.sizing.economics.perFillNetUsdtWei)) / 1e18).toFixed(3)} USDT more than it earns.</p> : null}
          </> : isPortfolio ? <>
            <p>USDT principal: {formatUsdtWei(BigInt(hireSettings.capitalQuoteWei ?? "0"))} USDT. BNB relay reserve: {formatEther(portfolioCapDayWei)} BNB.</p>
            <p>This agent holds {hireSettings.portfolioTokens?.map((token, index) => `${shown.pin[index]?.symbol ?? token} ${(hireSettings.portfolioWeightsBps?.[index] ?? 0) / 100} %`).join(", ")} and rebalances when a weight drifts {(hireSettings.portfolioDriftBps ?? 0) / 100} % from target, checked every {({ 14400: "4 h", 28800: "8 h", 43200: "12 h", 86400: "day" } as Record<number, string>)[hireSettings.portfolioIntervalSec ?? 86400]}.</p>
          </> : <p>Principal: {formatUsdtWei(BigInt(hireSettings.capitalQuoteWei ?? "0"))} USDT. {isSchedule ? `The BNB relay reserve covers ${shown.sizing.buysThisSession ?? "the planned"} buys.` : "Trade fees use the live shown."}</p>}
          {/* R2.10 (LOW-7): the review step names the one bought token beside the full granted list. */}
          {isSchedule ? <p>This agent buys only {shown.pin.find((token) => token.address.toLowerCase() === hireSettings.scheduleToken?.toLowerCase())?.symbol ?? "the selected bStock"}.</p> : null}
          {v2Funding === null ? null : <TradfiFundingSummary funding={v2Funding} />}
          {hireSettings.cmcNewsEnabled === true ? <p>Data budget is included in the USDT target and paid from the agent wallet. Your passkey confirms the data budget once, right after the grant.</p> : null}</>
        : <p>Capital floor: {formatEther(previewMinimumWei(shown))} BNB, including entry fees and exit gas reserves.</p>}
    </div> : null}
    <button type="button" style={busyBtn(working !== null || (!custodyPick && blocked !== null), primaryBtn)}
      onClick={legacyAmbiguous ? restartAmbiguousHire : custodyPick
        ? () => props.chooseCustody!(() => void deployRef.current()) : () => void deployAll()}
      disabled={working !== null || (!custodyPick && blocked !== null)}>
      {legacyAmbiguous ? "Restart hire" : record === null ? "Sign hire and create the session key" : "Continue deploy"}
    </button>
    {blocked ? <p style={{ color: "var(--loss)" }}>{blocked}</p> : null}
    {working ? <p>{working}</p> : null}
    {message ? <p style={{ color: "var(--loss)" }}>{message}{blockerHref === null ? null : <>
      {" "}<a href={blockerHref} style={{ color: "inherit", textDecoration: "underline" }}
        onClick={(event) => { event.preventDefault(); props.go(blockerHref); }}>Open agent</a>
    </>}</p> : null}
    {fenced && working === null ? <button type="button" style={secondaryBtn}
      onClick={() => void resetGrantAttempt()}>Reset stalled grant attempt</button> : null}
    {deposit && (depositWei !== null || depositAtomic !== null) && fundsWallet ? <FundsModal key={`${depositAsset}:${depositWei?.toString() ?? ""}:${depositAtomic?.toString() ?? ""}`} open onClose={() => {
      activeRun.current?.stop();
      setDeposit(false);
      setDepositWei(null);
      setDepositAtomic(null);
      mark("fund", "failed", "Deposit closed. Continue deploy when ready.");
    }}
      wallet={fundsWallet} connectedAddress={connectedAddress} passkey={owner.passkey}
      ownerAddress={owner.ownerAddress} initialTab="deposit" fixedDepositWei={depositAsset === "BNB" ? depositWei ?? undefined : undefined}
      fixedDepositAtomic={depositAsset === "USDT" ? depositAtomic ?? undefined : undefined} fixedDepositAsset={depositAsset}
      autoSubmitDeposit
      onDepositSubmitted={() => { mark("fund", "active", "Deposit sent. Waiting for it to land in the agent wallet…"); setDeposit(false); }} /> : null}
    <DeployRunModal key="deploy-run" label="Trading Agent" color="var(--cat-yield)" agentId={record?.agentId ?? null}
      stepDefs={deployStepDefs} steps={steps} running={running} suspended={deposit} message={message} note={working}
      onStop={stoppable ? stopDeploy : null}
      onOpenAgent={record === null ? null : () => { const id = record.agentId; activeRun.current?.stop(); props.go(`/account/${id}`); }} />
  </div>;
}
