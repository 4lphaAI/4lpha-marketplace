/** Bounded, hourly CMC context refresh outside the trade entry/exit fence. */
import { randomUUID } from "node:crypto";
import { type Address, type Hex } from "viem";
import {
  CMC_EVENT_CALENDAR_ENABLED,
  CMC_GLOBAL_TOOL,
  CMC_LLM_REQUEST_CAP_PER_WINDOW,
  CMC_LLM_REQUEST_MIN_REMAINING_WEI,
  CMC_MAX_CONTEXT_CHARS,
  CMC_MAX_SSE_EVENTS,
  CMC_MAX_TICKER_CHARS,
  CMC_PRICE_ATOMIC,
  expectedCmcResource,
  hashCmcBody,
  cmcBudgetView,
  type CmcTarget,
} from "./cmc.js";
import {
  CMC_SKILL_EVENTS,
  CMC_SKILL_MACRO,
  CMC_SKILL_MACRO_RELEASE,
  CMC_SKILL_PLANNING,
  EVENTS_VALID_MS,
  compactEventCalendar,
  CMC_SKILL_SCANNER,
  CMC_SKILL_SECTOR,
  GLOBAL_VALID_MS,
  MACRO_ANCHOR_MINUTE,
  MACRO_VALID_MS,
  SECTOR_ANCHOR_MINUTE,
  SCANNER_ANCHOR_MINUTE,
  US_EQUITY_TICKER_CLASS,
  compactMacroUsEquity,
  compactPlanning,
  compactScanner,
  compactSectorRotation,
  dailyDue,
  isNyTradingDay,
  lastActivityMs,
  macroReleaseDue,
  planningValidForPrompt,
  planningWindowStartMs,
  readCompactMacro,
  readCompactPlanning,
  selectPlanningTicker,
  sectorScannerValidUntilMs,
  tickerClass,
  tradingDayDue,
  unmatchedMajorEvents,
  type PlanningRowInfo,
} from "./cmcUsEquity.js";
import { sanitizeMessage } from "../core/errors.js";
import { readCmcLlmRequestsLease, type CmcBudgetStore, type CmcContentState, type CmcNewsRecord } from "../store/tradeCmc.js";
import type { CmcPaymentClient } from "./cmcPayment.js";

/** TRADFI-LLM-CMC-REQUEST §2/§4: the closed two-skill enum for an LLM-requested paid call. */
export type CmcLlmRequestSkill = "planning" | "events";

/** R2.1.2: one request pending in the CMC runtime's per-agent queue. */
export type PendingLlmRequest = {
  readonly ticker: string;
  readonly skill: CmcLlmRequestSkill;
  readonly reason: string;
  readonly source: "entry" | "exit";
  readonly model: string;
  readonly queuedAtMs: number;
};

/** R2.3/R3.10: the refusal codes `selectTarget` decides for a pending request. */
export type LlmRequestRefusal = {
  readonly ticker: string;
  readonly skill: CmcLlmRequestSkill;
  readonly code: "fresh" | "attempted" | "disabled" | "cap" | "low-budget";
};

export type CmcNewsContext = {
  readonly ticker: string;
  readonly skill: string;
  readonly text: string;
  readonly sourceUrl: string | null;
  readonly publishedAtMs: number | null;
  readonly asOfMs: number;
  readonly expiresAtMs: number;
  readonly payloadHash: Hex;
};

export type CmcNewsRefreshResult = {
  readonly ticker: string | null;
  readonly state: CmcContentState | "skipped";
  readonly context: CmcNewsContext | null;
  readonly operationId: string | null;
  readonly reason: string | null;
  /**
   * N6/N9: bounded `observe`-shaped codes the caller may fold into its own run
   * log (`cmc:unmapped:<ticker>` when the planning/scanner ticker list is
   * built, `cmc:macro-unmatched:<event>` once per macro ingest).
   */
  readonly observations?: readonly string[];
  /** Failed paid calls only: which skill/tool failed, and the first 300 chars of the vendor response when one arrived (operator log, 2026-09-24). */
  readonly skill?: string;
  readonly responseExcerpt?: string;
  /**
   * TRADFI-LLM-CMC-REQUEST R2.1.5: which pending LLM request this tick served
   * (claim succeeded, paid or not) or refused, so the CMC runtime can remove
   * exactly those entries from its pending queue. Absent/empty ⇒ neither.
   */
  readonly llmRequestServed?: { readonly ticker: string; readonly skill: CmcLlmRequestSkill } | null;
  readonly llmRequestsRefused?: readonly LlmRequestRefusal[];
};

export type CmcNewsService = {
  refresh(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly sessionPublicKey: Hex;
    readonly sessionExpiry: number;
    readonly generation: number;
    readonly heldTickers: readonly string[];
    readonly shortlistedTickers: readonly string[];
    readonly masterKey: Buffer;
    readonly nowMs?: number;
    /** TRADFI-LLM-CMC-REQUEST R2.1.3: the agent's pending LLM requests, oldest `queuedAtMs` first. */
    readonly llmRequests?: readonly PendingLlmRequest[];
  }): Promise<CmcNewsRefreshResult>;
  getFresh(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly ticker: string;
    /** Defaults to the planning skill; pass another skill constant to read a different row. */
    readonly skill?: string;
    readonly nowMs?: number;
  }): Promise<CmcNewsContext | null>;
};

/** R2.1/N9: `_GLOBAL` rows carry the market-wide skills/tool; never a real ticker (the ticker regex rejects it). */
export const GLOBAL_TICKER = "_GLOBAL";

function ticker(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,31}$/u.test(normalized) ? normalized : null;
}

function targetTicker(target: CmcTarget): string { return target.kind === "tool" ? GLOBAL_TICKER : target.ticker; }
/** AUDIT HIGH-1: the STORE key, which may differ from the API's `uniqueName` (the "+1" call is filed separately). */
function targetSkill(target: CmcTarget): string { return target.kind === "tool" ? target.name : target.storeSkill ?? target.uniqueName; }

function bodyFor(target: CmcTarget, operationId: string): string {
  if (target.kind === "tool") {
    return JSON.stringify({ jsonrpc: "2.0", id: operationId, method: "tools/call", params: { name: target.name, arguments: {} } });
  }
  return JSON.stringify({ jsonrpc: "2.0", id: operationId, method: "tools/call", params: {
    name: "execute_skill", arguments: { unique_name: target.uniqueName, parameters: target.parameters ?? {} },
  } });
}

/** R2.3/M3: every mapped `stock` ticker in the static pin — the scanner's own params list (L5). */
const SCANNER_TICKERS = Object.entries(US_EQUITY_TICKER_CLASS).filter(([, cls]) => cls.kind === "stock").map(([symbol]) => symbol);

function planningRowInfo(row: CmcNewsRecord | null): PlanningRowInfo | null {
  if (row === null) return null;
  const compact = row.status === "available" && row.context !== null ? readCompactPlanning(row.context) : null;
  return { ticker: row.ticker, sessionDate: compact?.sessionDate ?? null, lastActivityMs: lastActivityMs(row), requestedBy: row.requestedBy ?? null };
}

/**
 * TRADFI-CMC-EQUITY Rev 2/2.1 N8: macro (daily, or +1 after a closed-set
 * release) -> global metrics (daily) -> sector -> scanner -> planning for
 * held tickers -> planning for shortlisted tickers. "Due" and "fresh" are
 * separate (R2.1): this only decides what is DUE for the next paid call.
 */
type TargetSelection = {
  readonly target: CmcTarget | null;
  readonly observations: readonly string[];
  /** TRADFI-LLM-CMC-REQUEST R2.1.4: non-null exactly when `target` came from an LLM request. */
  readonly llmRequest: { readonly ticker: string; readonly skill: CmcLlmRequestSkill; readonly reason: string } | null;
  readonly llmRequestsRefused: readonly LlmRequestRefusal[];
};

const noLlmSelection = { llmRequest: null, llmRequestsRefused: [] } as const;

async function selectTarget(
  store: CmcBudgetStore,
  agentId: string,
  ownerAddress: Address,
  heldTickers: readonly string[],
  shortlistedTickers: readonly string[],
  nowMs: number,
  llmRequests: readonly PendingLlmRequest[] = [],
  llmRequestsAllowed = true,
): Promise<TargetSelection> {
  const macroRow = await store.getNews(agentId, ownerAddress, GLOBAL_TICKER, CMC_SKILL_MACRO);
  if (dailyDue(lastActivityMs(macroRow), nowMs, MACRO_ANCHOR_MINUTE)) {
    return { target: { kind: "skill", ticker: GLOBAL_TICKER, uniqueName: CMC_SKILL_MACRO, parameters: { preview: true, lookback_hours: 72 } }, observations: [], ...noLlmSelection };
  }
  if (macroRow !== null && macroRow.status === "available" && macroRow.context !== null) {
    const macro = readCompactMacro(macroRow.context);
    const releaseRow = await store.getNews(agentId, ownerAddress, GLOBAL_TICKER, CMC_SKILL_MACRO_RELEASE);
    // AUDIT HIGH-1: the "+1" call is the REAL `macro_news_aggregator` skill
    // (there is no such skill as "macro_news_aggregator:release" — the vendor
    // always refused it); only the store key is separate, via `storeSkill`.
    if (macroReleaseDue({ macro, macroRowAsOfMs: macroRow.asOfMs, releaseLastActivityMs: lastActivityMs(releaseRow), nowMs })) {
      return { target: { kind: "skill", ticker: GLOBAL_TICKER, uniqueName: CMC_SKILL_MACRO, storeSkill: CMC_SKILL_MACRO_RELEASE, parameters: { preview: true, lookback_hours: 72 } }, observations: [], ...noLlmSelection };
    }
  }
  const globalRow = await store.getNews(agentId, ownerAddress, GLOBAL_TICKER, CMC_GLOBAL_TOOL);
  if (dailyDue(lastActivityMs(globalRow), nowMs, MACRO_ANCHOR_MINUTE)) return { target: { kind: "tool", name: CMC_GLOBAL_TOOL }, observations: [], ...noLlmSelection };
  const sectorRow = await store.getNews(agentId, ownerAddress, GLOBAL_TICKER, CMC_SKILL_SECTOR);
  if (tradingDayDue(lastActivityMs(sectorRow), nowMs, SECTOR_ANCHOR_MINUTE)) {
    return { target: { kind: "skill", ticker: GLOBAL_TICKER, uniqueName: CMC_SKILL_SECTOR, parameters: { preview: true } }, observations: [], ...noLlmSelection };
  }
  const scannerRow = await store.getNews(agentId, ownerAddress, GLOBAL_TICKER, CMC_SKILL_SCANNER);
  if (tradingDayDue(lastActivityMs(scannerRow), nowMs, SCANNER_ANCHOR_MINUTE)) {
    return { target: { kind: "skill", ticker: GLOBAL_TICKER, uniqueName: CMC_SKILL_SCANNER, parameters: { tickers: SCANNER_TICKERS } }, observations: [], ...noLlmSelection };
  }
  // M7/R2.1: planning is not called on Saturday or Sunday either — it would
  // only return Friday's still-valid data (N1 covers the whole weekend). R3.3:
  // LLM requests are evaluated AFTER this return — a Friday-evening request
  // stays pending and is served Monday inside the same 16:30-ET window.
  if (!isNyTradingDay(nowMs)) return { target: null, observations: [], llmRequest: null, llmRequestsRefused: [] };
  const windowStart = planningWindowStartMs(nowMs);
  // TRADFI-LLM-CMC-REQUEST R2.3/R3.10: LLM requests sit after macro/release/
  // global/sector/scanner and before scheduled planning, oldest-queued first.
  const llmRefusals: LlmRequestRefusal[] = [];
  let selectedLlmRequest: { ticker: string; skill: CmcLlmRequestSkill; reason: string } | null = null;
  if (llmRequests.length > 0) {
    if (!llmRequestsAllowed) {
      // R3.10 M1: a low remaining protected data budget refuses every
      // pending request — never the scheduled macro/sector/scanner/planning lane.
      for (const pending of llmRequests) llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "low-budget" });
    } else {
      const leaseCounter = readCmcLlmRequestsLease(await store.getNewsLease(agentId, ownerAddress));
      const leaseCount = leaseCounter.windowStartMs === windowStart ? leaseCounter.count : 0;
      for (const pending of llmRequests) {
        // G0 follow-up (2026-09-25): `events` opens here explicitly, with its
        // own row, freshness and attempted rules; any other skill stays refused.
        if (pending.skill === "events") {
          if (!CMC_EVENT_CALENDAR_ENABLED) {
            llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "disabled" });
            continue;
          }
          const eventsRow = await store.getNews(agentId, ownerAddress, pending.ticker, CMC_SKILL_EVENTS);
          // R3.9: one events call per ticker per window. A row fetched (or
          // attempted) since the window opened is `fresh`/`attempted`.
          if (eventsRow !== null && eventsRow.status === "available" && eventsRow.asOfMs >= windowStart) {
            llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "fresh" });
            continue;
          }
          if (eventsRow !== null && lastActivityMs(eventsRow) >= windowStart) {
            llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "attempted" });
            continue;
          }
          if (leaseCount >= CMC_LLM_REQUEST_CAP_PER_WINDOW) {
            llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "cap" });
            continue;
          }
          if (selectedLlmRequest === null) selectedLlmRequest = { ticker: pending.ticker, skill: pending.skill, reason: pending.reason };
          continue;
        }
        if (pending.skill !== "planning") {
          llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "disabled" });
          continue;
        }
        const row = await store.getNews(agentId, ownerAddress, pending.ticker, CMC_SKILL_PLANNING);
        // R2.3/L7: a request's `fresh` gate is `planningValidForPrompt` (last
        // two sessions) — deliberately looser than the scheduled lane's
        // `planningDue` (latest session only), because the model asks only
        // when its own prompt line reads unknown. Do not "fix" this into the
        // scheduled rule — that would double-pay a ticker every window.
        const sessionDate = row?.status === "available" && row.context !== null ? readCompactPlanning(row.context)?.sessionDate ?? null : null;
        if (planningValidForPrompt(sessionDate, nowMs)) {
          llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "fresh" });
          continue;
        }
        if (row !== null && lastActivityMs(row) >= windowStart) {
          llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "attempted" });
          continue;
        }
        if (leaseCount >= CMC_LLM_REQUEST_CAP_PER_WINDOW) {
          llmRefusals.push({ ticker: pending.ticker, skill: pending.skill, code: "cap" });
          continue;
        }
        if (selectedLlmRequest === null) selectedLlmRequest = { ticker: pending.ticker, skill: pending.skill, reason: pending.reason };
      }
    }
  }
  // AUDIT M-2/R2.5/R3.9 G2: every runtime refusal becomes a bounded CMC
  // observation, exactly like `cmc:unmapped:<ticker>` below — the trade-worker's
  // `logCmcObservations` prints these (deduped per UTC day), which is the only
  // way G2 ("an 11th refused cap") is observable at all.
  const llmRefusalObservations = llmRefusals.map((refusal) => `cmc:llm-request-refused:${refusal.code}:${refusal.ticker}`);
  if (selectedLlmRequest !== null) {
    const chosen = selectedLlmRequest;
    return { target: { kind: "skill", ticker: chosen.ticker, uniqueName: chosen.skill === "events" ? CMC_SKILL_EVENTS : CMC_SKILL_PLANNING, parameters: { symbol: chosen.ticker } },
      observations: llmRefusalObservations, llmRequest: chosen, llmRequestsRefused: llmRefusals };
  }
  const heldValid = [...new Set(heldTickers.map((value) => ticker(value)).filter((value): value is string => value !== null))];
  const shortlistedValid = [...new Set(shortlistedTickers.map((value) => ticker(value)).filter((value): value is string => value !== null))];
  // N9: emitted here, where the planning/scanner ticker list is built.
  // N9: emitted here, where the planning/scanner ticker list is built.
  const observations = [
    ...llmRefusalObservations,
    ...[...new Set([...heldValid, ...shortlistedValid])]
      .filter((candidate) => tickerClass(candidate) === null)
      .map((candidate) => `cmc:unmapped:${candidate}`),
  ];
  const candidateTickers = [...new Set([...heldValid, ...shortlistedValid])];
  const candidateRows: PlanningRowInfo[] = [];
  for (const candidate of candidateTickers) {
    const info = planningRowInfo(await store.getNews(agentId, ownerAddress, candidate, CMC_SKILL_PLANNING));
    if (info !== null) candidateRows.push(info);
  }
  // AUDIT HIGH-2(b): always count every planning row served since the window
  // opened, from the full listing — never short-circuit to just today's
  // candidate rows. The cap must bound CALLS made in the window, not the
  // count of distinct tickers that happen to still be candidates.
  const windowRows = (await store.listNews(agentId, ownerAddress))
    .filter((row) => row.skill === CMC_SKILL_PLANNING && lastActivityMs(row) >= windowStart)
    .map((row) => planningRowInfo(row)).filter((row): row is PlanningRowInfo => row !== null);
  const mergedRows = [...new Map([...candidateRows, ...windowRows].map((row) => [row.ticker, row])).values()];
  const next = selectPlanningTicker({ heldTickers: heldValid, shortlistedTickers: shortlistedValid, rows: mergedRows, nowMs });
  return { target: next === null ? null : { kind: "skill", ticker: next, uniqueName: CMC_SKILL_PLANNING, parameters: { symbol: next } },
    observations, llmRequest: null, llmRequestsRefused: llmRefusals };
}

export function createCmcNewsService(input: {
  readonly store: CmcBudgetStore;
  readonly payment: CmcPaymentClient;
  readonly now?: () => number;
}): CmcNewsService {
  const clock = input.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<CmcNewsRefreshResult>>();
  return {
    async refresh(request) {
      const existing = inFlight.get(request.agentId);
      if (existing !== undefined) return existing;
      const work = refreshOne(request, input.store, input.payment, clock);
      inFlight.set(request.agentId, work);
      try { return await work; }
      finally { if (inFlight.get(request.agentId) === work) inFlight.delete(request.agentId); }
    },
    async getFresh(request) {
      const row = await input.store.getNews(request.agentId, request.ownerAddress, request.ticker.toUpperCase(), request.skill ?? CMC_SKILL_PLANNING);
      const budget = await input.store.get(request.agentId, request.ownerAddress);
      if (budget === null || !budget.optedIn || row === null || row.status !== "available" || row.context === null || row.expiresAtMs <= (request.nowMs ?? clock())) return null;
      return toContext(row);
    },
  };
}

/** Ingest validity ceiling stored on the row (R2.1/N7); planning's fine-grained N1 rule is re-checked by the reader against the compacted `sessionDate`. */
function expiresAtMsFor(target: CmcTarget, nowMs: number): number {
  const skill = targetSkill(target);
  if (target.kind === "tool") return nowMs + GLOBAL_VALID_MS;
  if (skill === CMC_SKILL_MACRO || skill === CMC_SKILL_MACRO_RELEASE) return nowMs + MACRO_VALID_MS;
  if (skill === CMC_SKILL_SECTOR) return sectorScannerValidUntilMs(nowMs, SECTOR_ANCHOR_MINUTE);
  if (skill === CMC_SKILL_SCANNER) return sectorScannerValidUntilMs(nowMs, SCANNER_ANCHOR_MINUTE);
  if (skill === CMC_SKILL_EVENTS) return nowMs + EVENTS_VALID_MS;
  // Planning: N1 replaces a fixed cap with "one of the last two completed
  // sessions"; this ceiling is a generous upper bound only (4 days covers a
  // long weekend), the real gate is `planningValidForPrompt` on read.
  return nowMs + 4 * 24 * 60 * 60_000;
}

/** R3.5: an internal-only override seam. `forceTarget` bypasses `selectTarget`; `onRawBody` is the probe's raw-body capture (both used only by `refreshProbeOnce`). */
type RefreshOneOverrides = { readonly forceTarget?: CmcTarget; readonly onRawBody?: (body: string) => void };

async function refreshOne(
  request: Parameters<CmcNewsService["refresh"]>[0],
  store: CmcBudgetStore,
  payment: CmcPaymentClient,
  clock: () => number,
  overrides: RefreshOneOverrides = {},
): Promise<CmcNewsRefreshResult> {
  const nowMs = request.nowMs ?? clock();
  const budget = await store.get(request.agentId, request.ownerAddress);
  if (budget === null) return skipped("budget_missing");
  const view = cmcBudgetView(budget, budget.optedIn);
  const lease = await store.getNewsLease(request.agentId, request.ownerAddress);
  const staleUndisclosedLease = lease?.inFlightOperationId !== null && lease?.inFlightOperationId !== undefined
    && lease.leaseExpiresAtMs !== null && lease.leaseExpiresAtMs !== undefined && nowMs > lease.leaseExpiresAtMs
    && budget.pendingOperationId !== null;
  if (view.status !== "ready" && !staleUndisclosedLease) return skipped(view.reason ?? view.status);
  // R3.10 M1: computed from the SAME budget view `refreshOne` already read —
  // never a second store read, never the exported/exposed `protectedExposureWei`.
  const llmRequestsAllowed = BigInt(view.remainingWei) >= CMC_LLM_REQUEST_MIN_REMAINING_WEI;
  const selection = overrides.forceTarget !== undefined
    ? { target: overrides.forceTarget, observations: [], llmRequest: null, llmRequestsRefused: [] }
    : await selectTarget(store, request.agentId, request.ownerAddress, request.heldTickers,
      request.shortlistedTickers, nowMs, request.llmRequests ?? [], llmRequestsAllowed);
  const { target, observations, llmRequest, llmRequestsRefused } = selection;
  if (target === null) return skipped("context_fresh", observations, { llmRequestsRefused });
  const operationId = randomUUID();
  const claimInput = { agentId: request.agentId, ownerAddress: request.ownerAddress, operationId, nowMs,
    ...(llmRequest === null ? {} : { llmRequest: { windowStartMs: planningWindowStartMs(nowMs), cap: CMC_LLM_REQUEST_CAP_PER_WINDOW } }) };
  if (!(await store.claimNewsSlot(claimInput))) return skipped("hourly_slot_unavailable", observations, { llmRequestsRefused });
  // R2.1.5: the claim succeeded, so this request is SERVED from here on
  // (paid or not) — every return past this point carries it.
  const servedLlmRequest = llmRequest === null ? null : { ticker: llmRequest.ticker, skill: llmRequest.skill };
  const afterClaim = await store.get(request.agentId, request.ownerAddress);
  if (afterClaim === null || cmcBudgetView(afterClaim, afterClaim.optedIn).status !== "ready") {
    await store.finishNewsSlot({ agentId: request.agentId, ownerAddress: request.ownerAddress, operationId, nowMs });
    return skipped(afterClaim === null ? "budget_missing" : cmcBudgetView(afterClaim, afterClaim.optedIn).reason ?? cmcBudgetView(afterClaim, afterClaim.optedIn).status,
      observations, { llmRequestServed: servedLlmRequest, llmRequestsRefused });
  }
  const tickerValue = targetTicker(target);
  const skillValue = targetSkill(target);
  const attemptId = randomUUID();
  // TRADFI-LLM-CMC-REQUEST R3.2: `requestedBy`/`requestReason` describe the
  // LATEST attempt, never inherited from a prior write — a scheduled retry of
  // a ticker an LLM request bought earlier must clear the label.
  const requestedBy: "llm" | null = llmRequest === null ? null : "llm";
  const requestReason = llmRequest === null ? null : sanitizeMessage(llmRequest.reason).slice(0, 160);
  // M5: a failed attempt records `lastAttemptAtMs` so "due" moves past this
  // window, but never overwrites a still-`available` row's content.
  // AUDIT L3: a recognized skill whose response shape did not parse (or came
  // back over the compacted-size cap) is `invalid`, per §4/H6/L3 — never
  // `service-error`, which is reserved for a real transport/auth/payment failure.
  const fail = async (reason: string, state: "service-error" | "invalid" = "service-error", responseBody?: string): Promise<CmcNewsRefreshResult> => {
    const existing = await store.getNews(request.agentId, request.ownerAddress, tickerValue, skillValue);
    if (existing !== null && existing.status === "available") {
      // AUDIT L2: `null` (not this failed attempt's operationId) so the owner
      // log never misattributes the still-available content to the operation
      // that just failed; `putNews`'s lease-ownership check only fires for a
      // non-null id, so this also sidesteps it correctly (no new content was written).
      await store.putNews({ ...existing, lastAttemptAtMs: nowMs, paymentOperationId: null, requestedBy, requestReason });
    } else {
      await store.putNews({ agentId: request.agentId, ownerAddress: request.ownerAddress, ticker: tickerValue,
        skill: skillValue, generation: request.generation, status: state, context: null,
        sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: operationId,
        asOfMs: nowMs, expiresAtMs: expiresAtMsFor(target, nowMs), lastAttemptAtMs: nowMs, requestedBy, requestReason });
    }
    return { ...failed(tickerValue, operationId, reason, state, observations, { llmRequestServed: servedLlmRequest, llmRequestsRefused }), skill: skillValue,
      ...(responseBody === undefined ? {} : { responseExcerpt: responseExcerpt(responseBody) }) };
  };
  try {
    const body = bodyFor(target, operationId);
    const authorized = await payment.authorize({ agentId: request.agentId, ownerAddress: request.ownerAddress,
      wallet: request.wallet, amountWei: CMC_PRICE_ATOMIC, generation: request.generation, sessionPublicKey: request.sessionPublicKey, sessionExpiry: request.sessionExpiry });
    if (!authorized.ok) return await fail(authorized.reason);
    const expectedResource = expectedCmcResource(target);
    const challenge = await payment.fetchChallenge({ body, expectedResource });
    if (challenge.amountWei !== CMC_PRICE_ATOMIC || challenge.resource !== expectedResource) return await fail("challenge_mismatch");
    const reserved = await payment.reserve({ agentId: request.agentId, ownerAddress: request.ownerAddress,
      wallet: request.wallet, operationId, attemptId, amountWei: challenge.amountWei, nowMs });
    if (reserved === null) return await fail("budget_reservation_refused");
    const current = await store.get(request.agentId, request.ownerAddress);
    if (current === null || !current.optedIn || !current.capabilityAvailable || current.reason !== null) {
      await store.release({ agentId: request.agentId, ownerAddress: request.ownerAddress, operationId, generation: reserved.attempt.generation, proof: { kind: "no-disclosure" }, nowMs });
      return await fail("budget_changed");
    }
    const prepared = await payment.prepare({ agentId: request.agentId, ownerAddress: request.ownerAddress, wallet: request.wallet,
      operationId, attemptId, body, requestDigest: hashCmcBody(body), challenge,
      sessionPublicKey: request.sessionPublicKey, sessionExpiry: request.sessionExpiry,
      generation: request.generation, masterKey: request.masterKey, nowMs });
    if (prepared === null) {
      await store.release({ agentId: request.agentId, ownerAddress: request.ownerAddress, operationId, generation: reserved.attempt.generation, proof: { kind: "no-disclosure" }, nowMs });
      return await fail("payment_prepare_refused");
    }
    const response = await payment.transmit({ agentId: request.agentId, ownerAddress: request.ownerAddress,
      wallet: request.wallet, operationId, body, generation: request.generation, masterKey: request.masterKey });
    // R3.10 M2: the UNTRANSFORMED transport body, before any parsing/compaction/cap.
    overrides.onRawBody?.(response.body);
    const parsed = parseCmcResponse(response.body, target, nowMs);
    await store.markContent({ agentId: request.agentId, ownerAddress: request.ownerAddress,
      operationId, generation: request.generation, state: parsed.state, nowMs });
    // HTTP success is not chain settlement proof; hold the charge UNKNOWN until
    // exact receipt reconciliation adopts it.
    await store.markUnknown({ agentId: request.agentId, ownerAddress: request.ownerAddress, operationId, generation: request.generation, nowMs });
    if (parsed.context !== null) {
      await store.putNews({ ...parsed.context, agentId: request.agentId, ownerAddress: request.ownerAddress,
        generation: request.generation, status: parsed.state, context: parsed.context.text, paymentOperationId: operationId, lastAttemptAtMs: nowMs, requestedBy, requestReason });
      // N6: emitted once per macro ingest, bounded, from the row just written.
      const macroObservations = skillValue === CMC_SKILL_MACRO || skillValue === CMC_SKILL_MACRO_RELEASE
        ? (readCompactMacro(parsed.context.text) === null ? [] : unmatchedMajorEvents(readCompactMacro(parsed.context.text)!).map((event) => `cmc:macro-unmatched:${event}`))
        : [];
      return { ticker: tickerValue, state: parsed.state, context: parsed.context, operationId, reason: parsed.reason, observations: [...observations, ...macroObservations],
        ...(servedLlmRequest === null ? {} : { llmRequestServed: servedLlmRequest }), ...(llmRequestsRefused.length === 0 ? {} : { llmRequestsRefused }) };
    }
    // An unparseable/empty response is a failure: bookkeep it (M5) rather than
    // silently dropping it, so the next hourly slot moves on. AUDIT L3: keep the
    // parser's own state (`invalid` vs `service-error`) instead of collapsing both to service-error.
    return await fail(parsed.reason ?? "missing_text", parsed.state === "invalid" ? "invalid" : "service-error", response.body);
  } catch (error) {
    const attempt = await store.getAttempt(request.agentId, request.ownerAddress, operationId);
    if (attempt !== null && attempt.state === "transmitting") await store.markUnknown({ agentId: request.agentId, ownerAddress: request.ownerAddress, operationId, generation: request.generation, nowMs });
    return await fail(error instanceof Error ? error.message.slice(0, 120) : "cmc_request_failed");
  } finally {
    await store.finishNewsSlot({ agentId: request.agentId, ownerAddress: request.ownerAddress, operationId, nowMs: clock() });
  }
}

/**
 * TRADFI-LLM-CMC-REQUEST R2.6/R3.5: an operator-only, ONE-SHOT probe of a
 * skill whose payload shape is not measured. NOT on the `CmcNewsService`
 * interface, and no production module may import it (unreachability test:
 * only `scripts/live-cmc-probe-skill.ts` may name it). Shares `refreshOne`'s
 * exact budget/claim/payment/ledger bookkeeping via the internal `forceTarget`
 * override — the only new behaviour is returning the untransformed transport
 * body (`rawBody`) alongside the normal result; the stored/compacted text
 * stays capped at `CMC_MAX_CONTEXT_CHARS` as usual.
 */
export async function refreshProbeOnce(
  store: CmcBudgetStore,
  payment: CmcPaymentClient,
  request: Parameters<CmcNewsService["refresh"]>[0],
  probeTarget: CmcTarget,
  clock: () => number,
): Promise<{ readonly result: CmcNewsRefreshResult; readonly rawBody: string | null }> {
  let rawBody: string | null = null;
  const result = await refreshOne(request, store, payment, clock, { forceTarget: probeTarget, onRawBody: (body) => { rawBody = body; } });
  return { result, rawBody };
}

/** 300 chars from the evidence block when present (SSE keep-alive pings fill the head of a slow skill's body), else from the start. */
export function responseExcerpt(body: string): string {
  // The evidence KEY (any escaping depth), not "evidence_pack" at the head.
  const key = /evidence\\*"\s*:/u.exec(body);
  if (key === null) return `no evidence key; ${body.slice(Math.max(0, body.indexOf("observation_as_of")), Math.max(0, body.indexOf("observation_as_of")) + 280)}`;
  return body.slice(key.index, key.index + 300);
}

type LlmResultMeta = {
  readonly llmRequestServed?: { readonly ticker: string; readonly skill: CmcLlmRequestSkill } | null;
  readonly llmRequestsRefused?: readonly LlmRequestRefusal[];
};

function skipped(reason: string, observations: readonly string[] = [], meta: LlmResultMeta = {}): CmcNewsRefreshResult {
  return { ticker: null, state: "skipped", context: null, operationId: null, reason,
    ...(observations.length === 0 ? {} : { observations }),
    ...(meta.llmRequestServed === undefined || meta.llmRequestServed === null ? {} : { llmRequestServed: meta.llmRequestServed }),
    ...(meta.llmRequestsRefused === undefined || meta.llmRequestsRefused.length === 0 ? {} : { llmRequestsRefused: meta.llmRequestsRefused }) };
}
function failed(tickerValue: string, operationId: string, reason: string, state: "service-error" | "invalid" = "service-error", observations: readonly string[] = [], meta: LlmResultMeta = {}): CmcNewsRefreshResult {
  return { ticker: tickerValue, state, context: null, operationId, reason,
    ...(observations.length === 0 ? {} : { observations }),
    ...(meta.llmRequestServed === undefined || meta.llmRequestServed === null ? {} : { llmRequestServed: meta.llmRequestServed }),
    ...(meta.llmRequestsRefused === undefined || meta.llmRequestsRefused.length === 0 ? {} : { llmRequestsRefused: meta.llmRequestsRefused }) };
}

function parseCmcResponse(body: string, target: CmcTarget, nowMs: number): { readonly state: CmcContentState; readonly context: CmcNewsContext | null; readonly reason: string | null } {
  if (body.length > 256 * 1024) return { state: "invalid", context: null, reason: "response_too_large" };
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { return parseSse(body, target, nowMs); }
  const result = record(parsed) && record(parsed["result"]) ? parsed["result"] : null;
  if ((record(parsed) && parsed["isError"] === true) || (result !== null && result["isError"] === true)) {
    return { state: "service-error", context: null, reason: "mcp_error" };
  }
  const content = result !== null && Array.isArray(result["content"]) ? result["content"] : null;
  if (content === null) return { state: "invalid", context: null, reason: "unknown_mcp_shape" };
  return textContent(content, target, nowMs);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSse(body: string, target: CmcTarget, nowMs: number): { readonly state: CmcContentState; readonly context: CmcNewsContext | null; readonly reason: string | null } {
  const events = body.split(/\r?\n\r?\n/u).filter((part) => part.trim().length > 0);
  if (events.length > CMC_MAX_SSE_EVENTS) return { state: "invalid", context: null, reason: "sse_event_limit" };
  const content: unknown[] = [];
  for (const eventText of events) {
    const line = eventText.split(/\r?\n/u).find((part: string) => part.startsWith("data:"));
    if (line === undefined) continue;
    let parsedEvent: unknown;
    try { parsedEvent = JSON.parse(line.slice(5).trim()) as unknown; } catch { return { state: "invalid", context: null, reason: "sse_json" }; }
    if (record(parsedEvent) && (parsedEvent["isError"] === true
      || record(parsedEvent["result"]) && parsedEvent["result"]["isError"] === true)) return { state: "service-error", context: null, reason: "mcp_error" };
    if (record(parsedEvent) && record(parsedEvent["result"]) && Array.isArray(parsedEvent["result"]["content"])) content.push(...parsedEvent["result"]["content"]);
    else if (record(parsedEvent) && Array.isArray(parsedEvent["content"])) content.push(...parsedEvent["content"]);
    else content.push(parsedEvent);
  }
  return textContent(content, target, nowMs);
}

/** H6: the FULL response text is parsed and compacted first; the 3 000/12 000-char caps apply only to the compacted text (R2.2). */
function compactFor(target: CmcTarget, joined: string): string | null {
  const skill = targetSkill(target);
  if (skill === CMC_SKILL_MACRO || skill === CMC_SKILL_MACRO_RELEASE) return compactMacroUsEquity(joined);
  if (skill === CMC_SKILL_SECTOR) return compactSectorRotation(joined);
  if (skill === CMC_SKILL_SCANNER) return compactScanner(joined);
  if (skill === CMC_SKILL_PLANNING) return compactPlanning(joined);
  if (skill === CMC_SKILL_EVENTS) return compactEventCalendar(joined);
  return null; // the global tool (get_global_metrics_latest): ingest unchanged (Rev 2 re-review, N9).
}

/** R2.6/R3.5: reachable only through `refreshProbeOnce` (`scripts/live-cmc-probe-skill.ts`), never a production path. */
function isProbeTarget(target: CmcTarget): boolean {
  return target.kind === "skill" && targetSkill(target).endsWith(":probe");
}

function textContent(content: readonly unknown[], target: CmcTarget, nowMs: number): { readonly state: CmcContentState; readonly context: CmcNewsContext | null; readonly reason: string | null } {
  const texts: string[] = [];
  let sourceUrl: string | null = null;
  let publishedAtMs: number | null = null;
  for (const item of content) {
    if (!record(item) || item["type"] !== "text" || typeof item["text"] !== "string") continue;
    const text = item["text"].replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    // H6: never cut a raw item before compaction — every skill/tool text is one JSON document.
    if (text.length > 0) texts.push(text);
    const annotations = record(item["annotations"]) ? item["annotations"] : null;
    if (sourceUrl === null && annotations !== null && typeof annotations["url"] === "string" && /^https?:\/\//u.test(annotations["url"])) sourceUrl = annotations["url"];
    if (publishedAtMs === null && annotations !== null && typeof annotations["publishedAt"] === "string") { const parsed = Date.parse(annotations["publishedAt"]); if (Number.isFinite(parsed)) publishedAtMs = parsed; }
  }
  const joined = texts.join("\n");
  const compacted = compactFor(target, joined);
  // A recognized skill whose shape did not parse is `invalid`, not a raw dump
  // (R2.2/H6) — EXCEPT the one probe exception (R2.6/R3.5): a `:probe`
  // target's raw joined text is ingested unchanged, exactly like the global
  // tool, capped only by `CMC_MAX_CONTEXT_CHARS` below.
  if (compacted === null && target.kind === "skill" && !isProbeTarget(target)) return { state: "invalid", context: null, reason: "unrecognized_skill_shape" };
  // AUDIT HIGH-3: never slice compacted JSON — a mid-document cut destroys it.
  // Each compactor (cmcUsEquity.ts) bounds itself to <= CMC_MAX_TICKER_CHARS,
  // dropping lowest-priority events/candidates first; if it still comes back
  // over the cap (a compactor bug, not a data shape it could not fit), that is
  // `invalid`, never a truncated `available` row (R2.2/H6/L3).
  if (compacted !== null && compacted.length > CMC_MAX_TICKER_CHARS) return { state: "invalid", context: null, reason: "compacted_too_large" };
  // The global tool's ingest is unchanged (Rev 2 re-review N9): no compaction, no
  // per-item cap, only the overall context bound.
  const text = compacted ?? joined.slice(0, CMC_MAX_CONTEXT_CHARS);
  if (text.length === 0) return { state: "invalid", context: null, reason: "missing_text" };
  const payloadHash = hashCmcBody(text);
  const context: CmcNewsContext = { ticker: targetTicker(target), skill: targetSkill(target), text,
    sourceUrl, publishedAtMs, asOfMs: nowMs, expiresAtMs: expiresAtMsFor(target, nowMs), payloadHash };
  return { state: "available", context, reason: null };
}

function toContext(row: CmcNewsRecord): CmcNewsContext {
  return { ticker: row.ticker, skill: row.skill, text: row.context ?? "", sourceUrl: row.sourceUrl,
    publishedAtMs: row.publishedAtMs, asOfMs: row.asOfMs, expiresAtMs: row.expiresAtMs,
    payloadHash: row.payloadHash ?? hashCmcBody(row.context ?? "") };
}

/** One-minute scheduler wrapper; refresh remains outside trade entry/exit. */
export function createCmcNewsScheduler(input: { readonly service: CmcNewsService; readonly intervalMs?: number }): {
  readonly refresh: CmcNewsService["refresh"];
  readonly intervalMs: number;
} {
  return { refresh: input.service.refresh, intervalMs: input.intervalMs ?? 60_000 };
}
