/** File-only G2 high-75 finite route proof. Never selected by production profiles. */
import { E18, G2_FINITE_SUBMISSION_CEILING, REBALANCE_TOKEN_ADDRESSES,
  type RebalanceAsset, type RebalanceRiskAsset } from "./rebalancePolicy.js";
import { rebalancePathKey } from "./rebalanceRoutes.js";
import type { PlannedRebalanceLeg } from "./rebalancePortfolio.js";
import type { QuantRebalanceActionRow, QuantRebalanceCheckRow, QuantRebalanceJobRow } from "./rebalanceTypes.js";
import type { ExecutionJournal } from "../store/journal.js";

export const FINITE_STAGES = [
  { side: "buy", asset: "WBNB" }, { side: "buy", asset: "ETH" }, { side: "buy", asset: "CAKE" },
  { side: "sell", asset: "WBNB" }, { side: "buy", asset: "WBNB" },
  { side: "sell", asset: "ETH" }, { side: "buy", asset: "ETH" },
  { side: "sell", asset: "CAKE" }, { side: "buy", asset: "CAKE" },
] as const;

export type FiniteState =
  | { readonly kind: "ready"; readonly stage: number; readonly aborted: number; readonly proceedsWei: bigint | null;
      readonly managed: Readonly<Record<RebalanceAsset, bigint>> }
  | { readonly kind: "complete"; readonly managed: Readonly<Record<RebalanceAsset, bigint>> }
  | { readonly kind: "stop"; readonly code: string };

export type FiniteCloseoutState = Exclude<FiniteState, { readonly kind: "stop" }>
  | { readonly kind: "incomplete"; readonly managed: Readonly<Record<RebalanceAsset, bigint>>;
      readonly cause: "submitted-failure" | "no-send-exhausted" | "unknown-settled";
      readonly terminalActionId: string }
  | { readonly kind: "invalid" };

export type FiniteAction = Pick<QuantRebalanceActionRow, "checkId" | "sequence" | "side" | "asset" | "path"
  | "state" | "amountInWei" | "preSubmitBlockNumber" | "preSubmitBlockHash" | "txHash" | "proofDigest" | "fillInWei" | "fillOutWei"
  | "ambiguousCause" | "resolutionJson">;
export type FiniteCheck = Pick<QuantRebalanceCheckRow, "checkId" | "kind" | "slot">;

function noSendResolution(raw: string | null): "absent" | "PENDING" | "ROLLED_BACK" | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).sort().join("|") !== "journalState|reasonCode|recovery"
      || value["recovery"] !== "pre-submit-no-provider-entry"
      || typeof value["reasonCode"] !== "string" || !/^[a-z0-9-]{1,64}$/u.test(value["reasonCode"])
      || value["journalState"] !== "absent" && value["journalState"] !== "PENDING"
        && value["journalState"] !== "ROLLED_BACK") return null;
    return value["journalState"];
  } catch { return null; }
}

function expectedPath(asset: RebalanceRiskAsset, side: "buy" | "sell"): string {
  const tokens = asset === "CAKE"
    ? [REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES.WBNB, REBALANCE_TOKEN_ADDRESSES.CAKE]
    : [REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES[asset]];
  return rebalancePathKey(side === "buy" ? tokens : [...tokens].reverse());
}

/** A full ordered history is required; settled-only filtering hides poisoned stages. */
export function deriveFiniteState(actions: readonly FiniteAction[], checks: readonly FiniteCheck[]): FiniteState {
  const byCheck = new Map(checks.map((check) => [check.checkId, check]));
  if (byCheck.size !== checks.length) return { kind: "stop", code: "finite-check-duplicate" };
  const ordered = [...actions].sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
  if (ordered.some((action, index) => index > 0 && ordered[index - 1]!.sequence >= action.sequence)) {
    return { kind: "stop", code: "finite-sequence-invalid" };
  }
  let stage = 0;
  let aborted = 0;
  let lastSellProceeds: bigint | null = null;
  let lastScheduledSlot = -1;
  const holdings: Record<RebalanceRiskAsset, bigint> = { WBNB: 0n, ETH: 0n, CAKE: 0n };
  let cash = 75n * E18;
  const seenReceipt = new Set<string>();
  for (const action of ordered) {
    const expected = FINITE_STAGES[stage];
    const check = byCheck.get(action.checkId);
    if (expected === undefined || check === undefined || action.side !== expected.side || action.asset !== expected.asset
      || rebalancePathKey(action.path) !== expectedPath(expected.asset, expected.side)
      || stage < 3 && check.kind !== "bootstrap" || stage >= 3 && check.kind !== "scheduled"
      || stage >= 3 && check.slot <= lastScheduledSlot) return { kind: "stop", code: "finite-history-invalid" };
    if (action.state === "aborted") {
      if (action.preSubmitBlockNumber !== null || action.preSubmitBlockHash !== null
        || action.txHash !== null || action.ambiguousCause !== null
        || action.proofDigest !== null || action.fillInWei !== null || action.fillOutWei !== null
        || noSendResolution(action.resolutionJson) === null) {
        return { kind: "stop", code: "finite-abort-ambiguous" };
      }
      aborted += 1;
      if (aborted > 2) return { kind: "stop", code: "finite-reprice-exhausted" };
      continue;
    }
    if (action.state === "failed" || action.state === "retired" || action.state === "unknown"
      || action.state === "needs-operator") return { kind: "stop", code: "finite-submission-failed" };
    if (action.state !== "settled") return { kind: "stop", code: "finite-action-unresolved" };
    if (action.preSubmitBlockNumber === null || action.preSubmitBlockHash === null
      || action.txHash === null || action.proofDigest === null
      // The normal CONFIRMED path is temporarily named receipt-unverified;
      // it becomes eligible only after the settled proof below, a matching
      // COMMITTED journal, and fresh portfolio parity at the worker boundary.
      || action.ambiguousCause !== null && action.ambiguousCause !== "receipt-unverified"
      || action.fillInWei === null || action.fillInWei <= 0n || action.fillOutWei === null || action.fillOutWei <= 0n
      || action.fillInWei !== action.amountInWei
      || seenReceipt.has(action.txHash.toLowerCase())) return { kind: "stop", code: "finite-settlement-invalid" };
    seenReceipt.add(action.txHash.toLowerCase());
    if (stage >= 3) lastScheduledSlot = check.slot;
    if (expected.side === "sell") {
      if (action.fillInWei !== holdings[expected.asset] * 2_000n / 10_000n) {
        return { kind: "stop", code: "finite-sell-clip-invalid" };
      }
      holdings[expected.asset] -= action.fillInWei;
      cash += action.fillOutWei;
      lastSellProceeds = action.fillOutWei;
    } else {
      if (cash < action.fillInWei) return { kind: "stop", code: "finite-cash-overdraw" };
      cash -= action.fillInWei;
      holdings[expected.asset] += action.fillOutWei;
    }
    if (stage >= 4 && expected.side === "buy" && action.fillInWei > (lastSellProceeds ?? 0n)) {
      return { kind: "stop", code: "finite-rebuy-exceeds-proceeds" };
    }
    stage += 1;
    aborted = 0;
  }
  const managed = { USDC: cash, ...holdings };
  if (stage === FINITE_STAGES.length) return { kind: "complete", managed };
  if (1 + ordered.filter((action) => action.preSubmitBlockNumber !== null).length >= G2_FINITE_SUBMISSION_CEILING) {
    return { kind: "stop", code: "finite-submission-budget" };
  }
  return { kind: "ready", stage, aborted, proceedsWei: lastSellProceeds, managed };
}

/** Terminal failures may be reported, never used to advance the trading schedule. */
export function deriveFiniteCloseoutState(actions: readonly QuantRebalanceActionRow[],
  checks: readonly FiniteCheck[], recoveredUnknownActionIds: ReadonlySet<string> = new Set()): FiniteCloseoutState {
  if (actions.some((action, index) => index > 0 && actions[index - 1]!.sequence >= action.sequence)) {
    return { kind: "invalid" };
  }
  if (recoveredUnknownActionIds.size > 0 && (recoveredUnknownActionIds.size !== 1
    || !recoveredUnknownActionIds.has(actions.at(-1)?.actionId ?? ""))) return { kind: "invalid" };
  const ordinary = deriveFiniteState(actions, checks);
  if (ordinary.kind !== "stop") {
    if (recoveredUnknownActionIds.size === 0) return ordinary;
    const terminal = actions.at(-1);
    if (recoveredUnknownActionIds.size !== 1 || terminal?.state !== "settled"
      || !recoveredUnknownActionIds.has(terminal.actionId)) return { kind: "invalid" };
    return { kind: "incomplete", managed: ordinary.managed,
      cause: "unknown-settled", terminalActionId: terminal.actionId };
  }
  const terminal = actions.at(-1);
  if (terminal === undefined) return { kind: "invalid" };
  const prefix = deriveFiniteState(actions.slice(0, -1), checks);
  if (prefix.kind !== "ready" || !finiteIntendedMatchesStage(prefix, terminal)) return { kind: "invalid" };
  const terminalCheck = checks.find((check) => check.checkId === terminal.checkId);
  const lastCompletedSlot = actions.slice(0, -1).filter((action) => action.state === "settled")
    .map((action) => checks.find((check) => check.checkId === action.checkId))
    .filter((check): check is FiniteCheck => check !== undefined && check.kind === "scheduled")
    .reduce((slot, check) => check.slot > slot ? check.slot : slot, -1);
  if (terminalCheck === undefined || prefix.stage < 3 && terminalCheck.kind !== "bootstrap"
    || prefix.stage >= 3 && (terminalCheck.kind !== "scheduled" || terminalCheck.slot <= lastCompletedSlot)) {
    return { kind: "invalid" };
  }
  if (terminal.state === "failed") {
    if (terminal.failureCode !== "submitted-failed-proven" || terminal.preSubmitBlockNumber === null
      || terminal.txHash === null || terminal.fillInWei !== null || terminal.fillOutWei !== null
      || terminal.proofDigest !== null) return { kind: "invalid" };
    return { kind: "incomplete", managed: prefix.managed,
      cause: "submitted-failure", terminalActionId: terminal.actionId };
  }
  if (terminal.state === "aborted") {
    if (prefix.aborted !== 2 || terminal.preSubmitBlockNumber !== null || terminal.preSubmitBlockHash !== null
      || terminal.txHash !== null
      || terminal.ambiguousCause !== null || noSendResolution(terminal.resolutionJson) === null
      || terminal.proofDigest !== null || terminal.fillInWei !== null || terminal.fillOutWei !== null) {
      return { kind: "invalid" };
    }
    return { kind: "incomplete", managed: prefix.managed,
      cause: "no-send-exhausted", terminalActionId: terminal.actionId };
  }
  if (terminal.state === "settled" && terminal.ambiguousCause !== null
    && terminal.ambiguousCause !== "receipt-unverified") {
    const structurallySettled = deriveFiniteState([...actions.slice(0, -1),
      { ...terminal, ambiguousCause: "receipt-unverified" }], checks);
    if (structurallySettled.kind === "stop") return { kind: "invalid" };
    return { kind: "incomplete", managed: structurallySettled.managed,
      cause: "unknown-settled", terminalActionId: terminal.actionId };
  }
  return { kind: "invalid" };
}

/** An action row alone cannot prove no-send or receipt ownership. */
export async function assessFiniteJournalHistory(actions: readonly QuantRebalanceActionRow[],
  journal: ExecutionJournal): Promise<{ readonly valid: boolean; readonly recoveredUnknownActionIds: ReadonlySet<string> }> {
  const invalid = { valid: false, recoveredUnknownActionIds: new Set<string>() } as const;
  const recoveredUnknownActionIds = new Set<string>();
  for (const action of actions) {
    const row = await journal.get(action.journalKey);
    if (action.state === "aborted") {
      const noSend = noSendResolution(action.resolutionJson);
      if (noSend === null || noSend === "absent" && row !== null
        || noSend !== "absent" && (row?.state !== "ROLLED_BACK"
          || row.externalRef.callsId !== undefined || row.externalRef.txHash !== undefined
          || row.externalRef.resolution !== undefined)) return invalid;
    } else if (action.state === "settled") {
      if (row?.state !== "COMMITTED" || action.txHash === null
        || row.externalRef.txHash?.toLowerCase() !== action.txHash.toLowerCase()) return invalid;
      const resolution = row.externalRef.resolution;
      if (resolution !== undefined) {
        if (resolution.action !== "resolveUnknown" || resolution.disposition !== "receipt-proof-verified"
          || !resolution.checks.some((check) => check.name === "quant-rebalance-receipt"
            && check.result === action.actionId)) return invalid;
        recoveredUnknownActionIds.add(action.actionId);
      }
    } else if (action.state === "failed") {
      if (action.failureCode === "submitted-failed-proven") {
        if (action.txHash === null || !(row?.state === "ROLLED_BACK" || row?.state === "COMMITTED")
          || row.externalRef.txHash?.toLowerCase() !== action.txHash.toLowerCase()) return invalid;
      } else if (row?.state !== "ROLLED_BACK" || row.externalRef.callsId !== undefined
        || row.externalRef.txHash !== undefined) return invalid;
    } else if (action.preSubmitBlockNumber !== null && row === null) return invalid;
  }
  return { valid: true, recoveredUnknownActionIds };
}

export async function finiteJournalHistoryValid(actions: readonly QuantRebalanceActionRow[],
  journal: ExecutionJournal): Promise<boolean> {
  const assessed = await assessFiniteJournalHistory(actions, journal);
  return assessed.valid && assessed.recoveredUnknownActionIds.size === 0;
}

export function planFiniteLeg(job: QuantRebalanceJobRow, state: Extract<FiniteState, { readonly kind: "ready" }>): PlannedRebalanceLeg {
  const stage = FINITE_STAGES[state.stage];
  if (stage === undefined || job.managed === null) return { kind: "hold", reason: "portfolio-empty" };
  if (stage.side === "sell") {
    const amountInWei = job.managed[stage.asset] * 2_000n / 10_000n;
    return amountInWei <= 0n ? { kind: "hold", reason: "rounds-to-zero" }
      : { kind: "sell", asset: stage.asset, amountInWei, targetExcessValueWei: 0n };
  }
  const amountInWei = state.stage < 3 ? 0n : state.proceedsWei ?? 0n;
  if (amountInWei <= 0n || amountInWei > job.managed.USDC) return { kind: "hold", reason: "rounds-to-zero" };
  return { kind: "buy", asset: stage.asset, amountInWei, targetDeficitValueWei: 0n };
}

export function finiteIntendedMatchesStage(state: Extract<FiniteState, { readonly kind: "ready" }>,
  action: Pick<QuantRebalanceActionRow, "side" | "asset" | "path" | "amountInWei">): boolean {
  const expected = FINITE_STAGES[state.stage];
  if (expected === undefined || action.side !== expected.side || action.asset !== expected.asset
    || rebalancePathKey(action.path) !== expectedPath(expected.asset, expected.side)
    || action.amountInWei <= 0n) return false;
  if (expected.side === "sell") return action.amountInWei === state.managed[expected.asset] * 2_000n / 10_000n;
  if (action.amountInWei > state.managed.USDC) return false;
  return state.stage < 3 || action.amountInWei === state.proceedsWei;
}
