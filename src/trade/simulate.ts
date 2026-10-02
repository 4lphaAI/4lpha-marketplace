import { encodeFunctionData, keccak256, parseAbi, stringToBytes, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { InfrastructureError } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import { encodeLpFinalCallsV1 } from "../lp/preparedIntentWitness.js";
import type { TradeSimulationActual, TradeSimulationInsert, TradeSimulationStore } from "../store/tradeSimulations.js";
import type { TradfiSimulateResult } from "./dataPlaneReads.js";

export const ERC7821_EXECUTE_SELECTOR: Hex = "0xe9ae5c53";
export const ERC7821_BATCH_MODE: Hex = "0x0100000000000000000000000000000000000000000000000000000000000000";
export const TRADFI_SIMULATE_MAX_MS = 2_000;
export const TRADFI_SIMULATE_MIN_MS = 300;
export const TRADFI_SIMULATE_GUARD_MARGIN_MS = 250;
export const TRADFI_SIMULATE_MAX_CALLS = 20;
export const TRADFI_SIMULATE_MAX_DATA_BYTES = 96 * 1024;
export const EVIDENCE_MAX_IN_FLIGHT = 8;
export const EXECUTION_REVERT_PREFIX = "execution reverted";
export const GUARD_DEADLINE_REASONS = Object.freeze([
  "execution reverted: 0xdccae4f5",
  "execution reverted: custom error 0xdccae4f5",
  "execution reverted: DeadlineOutOfBounds()",
]);
export type TradfiSimulationOutcome = TradeSimulationInsert["outcome"];
export type TradfiNotSimulatedReason = NonNullable<TradeSimulationInsert["reason"]>;
export type TradfiEvidenceWriter = {
  insert(row: TradeSimulationInsert): void;
  recordActual(input: TradeSimulationActual): void;
  shutdown(): Promise<void>;
};
export type TradfiPreflightDeps = {
  readonly simulate: (input: { readonly from: Address; readonly to: Address; readonly data: Hex; readonly signal: AbortSignal }) => Promise<TradfiSimulateResult>;
  readonly evidence: Pick<TradfiEvidenceWriter, "insert">;
  readonly log?: (line: string) => void;
  readonly monotonicMs?: () => number;
};
const EXECUTE_ABI = parseAbi(["function execute(bytes32 mode, bytes executionData)"]);

export function encodeTradfiSimulateTx(wallet: Address, calls: readonly WalletCall[]) {
  if (calls.length === 0 || calls.length > TRADFI_SIMULATE_MAX_CALLS || calls.some(call => (call.value ?? 0n) !== 0n)) return null;
  const data = encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [ERC7821_BATCH_MODE, encodeLpFinalCallsV1(calls)] });
  return (data.length - 2) / 2 > TRADFI_SIMULATE_MAX_DATA_BYTES ? null : { from: wallet, to: wallet, data };
}
export function tradfiSimulateBudgetMs(nowMs: number, guardDeadlineSec?: bigint): number | null {
  if (guardDeadlineSec === undefined) return TRADFI_SIMULATE_MAX_MS;
  const budget = Number(guardDeadlineSec) * 1_000 - nowMs - 6_000 - TRADFI_SIMULATE_GUARD_MARGIN_MS;
  return budget >= TRADFI_SIMULATE_MIN_MS ? Math.min(TRADFI_SIMULATE_MAX_MS, budget) : null;
}
export function predictedChange(result: TradfiSimulateResult, wallet: Address, token: Address): bigint | null {
  const matches = result.balanceChanges.filter(row => row.owner.toLowerCase() === wallet.toLowerCase() && row.token.toLowerCase() === token.toLowerCase());
  return matches.length === 1 ? matches[0]!.change : null;
}
export function isExecutionRevert(raw: string | null): boolean {
  return raw !== null && raw.startsWith(EXECUTION_REVERT_PREFIX);
}
export function classifySimulation(result: TradfiSimulateResult, route: TradeSimulationInsert["route"]) {
  const raw = result.failReason;
  const outcome: TradfiSimulationOutcome = result.status === "SUCCESS" ? "success"
    : !isExecutionRevert(raw) ? "failed-other"
    : route === "guard" && GUARD_DEADLINE_REASONS.includes(raw!) ? "guard-deadline" : "reverted";
  return { outcome, bareRevert: outcome === "reverted" && raw === "execution reverted" };
}

export function createTradfiEvidenceWriter(store: TradeSimulationStore, log: (line: string) => void): TradfiEvidenceWriter {
  const inFlight = new Set<Promise<void>>();
  let admitted = 0;
  let stopping = false;
  const safeLog = (line: string) => { try { log(line); } catch { /* Optional evidence cannot stop trading. */ } };
  const admit = (run: () => Promise<void>): void => {
    if (stopping || admitted >= EVIDENCE_MAX_IN_FLIGHT) { safeLog("[trade-worker] simulation evidence dropped"); return; }
    admitted += 1;
    try {
      const operation = run().catch(() => { safeLog("[trade-worker] simulation evidence write failed"); });
      inFlight.add(operation);
      void operation.then(() => { inFlight.delete(operation); admitted -= 1; });
    } catch { admitted -= 1; safeLog("[trade-worker] simulation evidence write failed"); }
  };
  return {
    insert: row => admit(() => store.insertSimulation(row)),
    recordActual: input => admit(() => store.insertActual(input)),
    async shutdown() {
      stopping = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(inFlight), new Promise<void>(resolve => { timer = setTimeout(resolve, 3_500); })]);
      clearTimeout(timer);
      if (inFlight.size > 0) safeLog(`[trade-worker] simulation evidence abandoned at shutdown: ${inFlight.size}`);
      try {
        const closed = store.close().catch(() => { safeLog("[trade-worker] simulation evidence store close abandoned"); });
        await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(() => { safeLog("[trade-worker] simulation evidence store close abandoned"); resolve(); }, 1_000); })]);
      } catch { safeLog("[trade-worker] simulation evidence store close abandoned"); }
      finally { clearTimeout(timer); }
    },
  };
}

export async function preflightSimulate(deps: TradfiPreflightDeps, input: {
  readonly agent: { readonly id: string; readonly ownerAddress: Address; readonly walletAddress: Address };
  readonly idempotencyKey: Hex; readonly journalKind: "trade" | "dcaRange";
  readonly exposure: "increase" | "reduce"; readonly route: "guard" | "direct" | "none";
  readonly calls: readonly WalletCall[]; readonly outputToken: Address; readonly minOutAtomic: bigint | null;
  readonly guardDeadlineSec?: bigint | undefined; readonly nowMs: number; readonly signal?: AbortSignal;
}): Promise<{ block: false } | { block: true; failReason: string | null }> {
  let outcome: TradfiSimulationOutcome = "not-simulated", reason: TradeSimulationInsert["reason"] = "unavailable";
  let failReason: string | null = null, latencyMs: number | null = null, upstreamMs: number | null = null;
  let predictedOutAtomic: bigint | null = null, bareRevert = false;
  try {
    const tx = encodeTradfiSimulateTx(input.agent.walletAddress, input.calls);
    const budget = tradfiSimulateBudgetMs(input.nowMs, input.guardDeadlineSec);
    if (tx === null) reason = "shape";
    else if (budget === null) reason = "window";
    else {
      const controller = new AbortController();
      const signal = input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]);
      const clock = deps.monotonicMs ?? (() => performance.now());
      const start = clock();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = Promise.resolve().then(() => deps.simulate({ ...tx, signal }));
        void pending.catch(() => undefined);
        const result = await Promise.race([pending, new Promise<null>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve(null); }, budget);
        })]);
        if (result === null) reason = "timeout";
        else {
          ({ outcome, bareRevert } = classifySimulation(result, input.route));
          reason = null;
          failReason = outcome === "success" || result.failReason === null ? null : sanitizeMessage(result.failReason).slice(0, 160);
          upstreamMs = result.upstreamMs;
          predictedOutAtomic = outcome === "success" ? predictedChange(result, input.agent.walletAddress, input.outputToken) : null;
        }
      } catch (error) {
        const candidate = error instanceof InfrastructureError ? error.message.slice("simulate:".length) : "";
        reason = controller.signal.aborted ? "timeout" : error instanceof InfrastructureError && error.message === `simulate:${candidate}`
          && ["window", "shape", "timeout", "rate-limited", "auth", "credentials", "unavailable", "malformed", "upstream-error"].includes(candidate)
          ? candidate as TradfiNotSimulatedReason : "unavailable";
      } finally { clearTimeout(timer); latencyMs = Math.min(60_000, Math.max(0, Math.round(clock() - start))); }
    }
  } catch { outcome = "not-simulated"; reason = "unavailable"; failReason = null; predictedOutAtomic = null; bareRevert = false; }
  const blocked = outcome === "reverted" && input.exposure === "increase" && input.route !== "guard";
  try {
    deps.evidence.insert({ idempotencyKey: input.idempotencyKey, agentId: input.agent.id, ownerAddress: input.agent.ownerAddress,
      journalKind: input.journalKind, exposure: input.exposure, route: input.route, outcome, reason, blocked, bareRevert, failReason,
      latencyMs, upstreamMs, outputToken: input.outputToken, predictionKind: input.journalKind === "trade" ? "swap-output" : "net-wallet-delta",
      minOutAtomic: input.minOutAtomic, predictedOutAtomic, createdAtMs: input.nowMs });
  } catch { try { deps.log?.("[trade-worker] simulation evidence write failed"); } catch { /* Optional log. */ } }
  return blocked ? { block: true, failReason } : { block: false };
}

const TRANSFER_TOPIC = keccak256(stringToBytes("Transfer(address,address,uint256)"));
export function netTransferDelta(logs: readonly { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex }[], token: Address, wallet: Address): bigint | null {
  let delta = 0n;
  const topicWallet = wallet.toLowerCase().slice(2).padStart(64, "0");
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase() || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = log.topics[1]?.toLowerCase().slice(2) === topicWallet;
    const to = log.topics[2]?.toLowerCase().slice(2) === topicWallet;
    if (!from && !to) continue;
    if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/u.test(log.data)) return null;
    const amount = BigInt(log.data);
    if (from) delta -= amount;
    if (to) delta += amount;
  }
  return delta;
}
export function recordSimulationActual(writer: Pick<TradfiEvidenceWriter, "recordActual"> | undefined, input: {
  readonly idempotencyKey: Hex; readonly txHash: Hex; readonly token: Address; readonly wallet: Address;
  readonly logs: Parameters<typeof netTransferDelta>[0]; readonly atMs: number; readonly log?: (line: string) => void;
}): void {
  if (writer === undefined) return;
  try {
    const delta = netTransferDelta(input.logs, input.token, input.wallet);
    if (delta !== null) writer.recordActual({ idempotencyKey: input.idempotencyKey, txHash: input.txHash, actualOutAtomic: delta, atMs: input.atMs });
  } catch { try { input.log?.("[trade-worker] simulation evidence write failed"); } catch { /* Optional log. */ } }
}
