"use client";
import { accountHireStorage, accountSwitchRequiresContinue, assertHireOwner } from "@/lib/exec/account-hire-storage";

import { walletBlockerAgentId } from "@/lib/altana/hire-wallet-blocker";

import * as React from "react";
import { formatEther, getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { FundsModal, type FundsWallet } from "@/components/FundsModal";
import { grantAgentSession, GrantAgentSessionError } from "@/lib/altana/client";
import { GridDeployRun, GridDeployStopped } from "@/lib/altana/grid-hire-recovery";
import { depositAmountWei, requiredTradeDepositWei } from "@/lib/altana/hire-funding";
import { freshFundingGate, type HireSessionView } from "@/lib/altana/hire-state";
import { encodeReadHeader, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import {
  maxGrantedTokens,
  MAX_PLATFORM_FEE_BPS,
  MIN_TRADE_CAPITAL_WEI,
  checkTradeSizing,
  formatMinimumBnb,
  parseTradeHirePreviewEnvelope,
  parseBnbToWei,
  type TradeExecutionModel,
  type TradeHirePreview,
  type TradeSettings,
} from "@/lib/trade";

const primaryBtn: React.CSSProperties = { cursor: "pointer", padding: "14px 22px", borderRadius: "var(--radius-sm)", background: "var(--cat-yield)", border: "none", color: "#08110c", font: "var(--weight-medium) var(--text-md)/1 var(--font-sans)" };
const secondaryBtn: React.CSSProperties = { ...primaryBtn, background: "transparent", color: "var(--cat-yield)", border: "1px solid var(--cat-yield)", padding: "10px 16px", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" };
const busyBtn = (busy: boolean, base: React.CSSProperties): React.CSSProperties => busy ? { ...base, cursor: "wait", opacity: 0.6 } : base;

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
}) {
  const owner = useOwnerActions();
  const hireStorage = React.useMemo(() => accountHireStorage(typeof window === "undefined" ? undefined : window.localStorage, owner.ownerAddress), [owner.ownerAddress]);
  const { address: connectedAddress } = useAccount();
  const [record, setRecord] = React.useState<TradeHireRecord | null>(null);
  const [view, setView] = React.useState<HireSessionView | null>(null);
  const [preview, setPreview] = React.useState<TradeHirePreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [legacyAmbiguous, setLegacyAmbiguous] = React.useState(false);
  const [deposit, setDeposit] = React.useState(false);
  const [depositWei, setDepositWei] = React.useState<bigint | null>(null);
  const activeRun = React.useRef<GridDeployRun | null>(null);
  const mounted = React.useRef(true);
  const resumed = React.useRef(false);

  const capDayWei = parseBnbToWei(props.capitalBnb);
  const conservativeSizing = checkTradeSizing({
    capDayWei,
    entryWei: BigInt(props.settings.entryWei),
    maxOpenPositions: props.settings.maxOpenPositions,
    grantedTokenCount: maxGrantedTokens(props.executionModel),
    platformFeeBps: MAX_PLATFORM_FEE_BPS,
  });
  const previewMatches = preview !== null
    && preview.capDayWei === capDayWei.toString(10)
    && preview.sizing.executionModel === props.executionModel
    && preview.sizing.entryWei === props.settings.entryWei
    && preview.sizing.maxOpenPositions === props.settings.maxOpenPositions;
  const sizingOk = previewMatches ? preview.sizing.ok : conservativeSizing.ok;
  const minimumWei = previewMatches ? previewMinimumWei(preview) : conservativeSizing.minimumCapWei;
  const sizingMessage = sizingOk ? null
    : `Total capital is too small. Raise it to at least ${formatMinimumBnb(minimumWei)} BNB.`;
  const blocked = props.blockedReason ?? previewError ?? sizingMessage;

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
        || data.sizing.maxOpenPositions !== params.settings.maxOpenPositions) {
        throw new Error("Preview tuple mismatch.");
      }
      return data;
    } catch {
      throw new PreviewCompatibilityError();
    }
  }, []);

  const loadPreview = React.useCallback(async (params: Pick<TradeHireParamsWire, "walletAddress" | "capDayWei" | "executionModel" | "settings">): Promise<TradeHirePreview> => {
    const data = await fetchPreview(params);
    if (!data.sizing.ok) {
      throw new Error(`Total capital must be at least ${formatMinimumBnb(previewMinimumWei(data))} BNB.`);
    }
    return data;
  }, [fetchPreview]);

  React.useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (owner.walletAddress === undefined
      || (props.blockedReason !== null && props.blockedReason !== undefined)) return;
    let current = true;
    void fetchPreview({
      walletAddress: owner.walletAddress,
      capDayWei: capDayWei.toString(10),
      executionModel: props.executionModel,
      settings: props.settings,
    }).then((result) => {
      if (current) {
        setPreview(result);
        setPreviewError(null);
      }
    }).catch((error: unknown) => {
      if (current && error instanceof PreviewCompatibilityError) {
        setPreview(null);
        setPreviewError(PREVIEW_INCOMPATIBLE_MESSAGE);
      }
    });
    return () => { current = false; };
  }, [capDayWei, fetchPreview, owner.walletAddress, props.blockedReason, props.executionModel, props.settings]);

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
  }, [owner.ownerAddress, owner.walletAddress]);

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
    return parsed.data;
  }, [owner.ownerAddress, owner.walletAddress]);

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
      settings: props.settings,
    };
    if (getAddress(params.walletAddress) !== getAddress(owner.walletAddress)) {
      throw new Error("The saved hire belongs to a different passkey wallet.");
    }
    const base = agentIdFromName(params.settings.name);
    setWorking("Reading the live pinned tokens and funding estimate…");
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
      setWorking(index === 1
        ? "Confirm the hire signature with your passkey…"
        : `${candidateId(base, index - 1)} is taken. Confirm the signature for ${agentId}…`);
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
  }, [assertRunActive, blocked, capDayWei, loadPreview, owner.passkey, owner.signEnvelope, owner.walletAddress,
    props.agentName, props.executionModel, props.settings, readContinuation, submitSignedHire]);

  const deployAll = React.useCallback(async (seed?: TradeHireRecord | null): Promise<void> => {
    if (activeRun.current !== null) return;
    const run = new GridDeployRun();
    activeRun.current = run;
    setMessage(null);
    try {
      if (owner.passkey === null || owner.walletAddress === undefined) {
        throw new Error("Create or recover your passkey wallet first.");
      }
      let currentRecord = seed === undefined ? record : seed;
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
        try {
          current = await run.guarded(() => submitSignedHire(currentRecord!));
        } catch (error) {
          if (!(error instanceof ContinuationReadError)) throw error;
          if (error.status === 409 && error.code === "s1_ambiguous") {
            assertRunActive(run);
            setLegacyAmbiguous(true);
            setMessage("The previous signed hire cannot be proven. Restart hire to sign a fresh hire.");
            return;
          }
          if (error.status === 410 && error.code === "hire_no_evidence") {
            assertRunActive(run);
            hireStorage.removeItem(HIRE_STORAGE_KEY);
            setRecord(null);
            setMessage("The previous signature expired before the hire reached the execution plane. Press Sign hire to try again.");
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
      const envelope = currentRecord.provisionEnvelope;
      if (envelope === null) throw new Error("The hire signature is unavailable.");
      const signedParams = envelopeParams(envelope);
      if (current.status === "armed" || current.status === "paused") {
        hireStorage.removeItem(HIRE_STORAGE_KEY);
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
        let fresh = await run.guarded(() => loadPreview(signedParams));
        assertRunActive(run);
        setPreview(fresh);
        setPreviewError(null);
        let freshness = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
        if (!freshness.ok && freshness.reason !== "short") {
          throw new Error("The live funding estimate is stale or unreadable; press Continue deploy to retry.");
        }
        const need = requiredTradeDepositWei({ capDayWei: signedParams.capDayWei, funding: fresh.funding });
        if (need.depositShortfallWei > 0n) {
          const sendWei = depositAmountWei(need.depositShortfallWei);
          const balanceBefore = fresh.funding.balanceWei === null ? 0n : BigInt(fresh.funding.balanceWei);
          const expectedAfter = balanceBefore + sendWei;
          setDepositWei(sendWei);
          setDeposit(true);
          setWorking(`Confirm the ${formatEther(sendWei)} BNB deposit in your wallet…`);
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            await run.wait(6_000);
            fresh = await run.guarded(() => loadPreview(signedParams));
            assertRunActive(run);
            setPreview(fresh);
            setPreviewError(null);
            freshness = freshFundingGate(fresh.funding, Math.floor(Date.now() / 1_000));
            if (freshness.ok && fresh.funding.balanceWei !== null
              && BigInt(fresh.funding.balanceWei) >= expectedAfter) break;
          }
          if (!freshness.ok || fresh.funding.balanceWei === null
            || BigInt(fresh.funding.balanceWei) < expectedAfter) {
            throw new Error("The agent wallet is still short of capital, registration fee, and grant gas.");
          }
          setDeposit(false);
          setDepositWei(null);
        }

        setWorking("Claiming the durable grant attempt…");
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
          }
        }
      }

      setWorking("Waiting for relay, account, KeyStore, and owner-binding evidence…");
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
      hireStorage.removeItem(HIRE_STORAGE_KEY);
      props.go(`/account/${currentRecord.agentId}`);
    } catch (error) {
      if (mounted.current && activeRun.current === run && !(error instanceof GridDeployStopped)) {
        setMessage(error instanceof Error ? error.message : "The deploy could not be completed.");
      }
    } finally {
      if (activeRun.current === run) {
        activeRun.current = null;
        if (mounted.current) setWorking(null);
      }
    }
  }, [assertRunActive, loadPreview, owner.passkey, owner.walletAddress, props.go, readContinuation,
    record, startHire, submitSignedHire]);

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
  const fenced = view?.status === "provisioning" && view.grantAttempt !== undefined;
  const blockerAgentId = walletBlockerAgentId(message);
  const blockerHref = blockerAgentId === null ? null : `/account/${blockerAgentId}`;

  return <div style={{ display: "grid", gap: 14, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
    <span className="fl-eyebrow">Hire the scoped agent session</span>
    {preview ? <div style={{ display: "grid", gap: 6, color: "var(--text-muted)", font: "var(--type-body-sm)" }}>
      <p>Capital floor: {formatEther(previewMinimumWei(preview))} BNB, including entry fees and exit gas reserves.</p>
    </div> : null}
    <button type="button" style={busyBtn(working !== null || blocked !== null, primaryBtn)}
      onClick={legacyAmbiguous ? restartAmbiguousHire : () => void deployAll()}
      disabled={working !== null || blocked !== null}>
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
    {deposit && depositWei !== null && fundsWallet ? <FundsModal open onClose={() => {
      activeRun.current?.stop();
      setDeposit(false);
      setDepositWei(null);
    }}
      wallet={fundsWallet} connectedAddress={connectedAddress} passkey={owner.passkey}
      ownerAddress={owner.ownerAddress} initialTab="deposit" fixedDepositWei={depositWei}
      autoSubmitDeposit /> : null}
  </div>;
}
