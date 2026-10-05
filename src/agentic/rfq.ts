/**
 * AGENTIC-RFQ-STOCKS E7: the Agentic-only quote source of the trade worker. It is what Binance will execute for this wallet and exactly the source the executor re-checks
 * (`executeAgenticTrade`: `market-order quote`, then `AGENTIC_QUOTE_BELOW_MIN`), so the worker's `minOut` and the executor's check agree. Flash quotes are for the guard as taker and cannot
 * be executed from an Agentic Wallet; a dust pool is not the RFQ price.
 *
 * Every command runs under the wallet fence (acquire, renew, conditional release) and nothing here writes a position, an order or a journal row.
 */
import type { Address } from "viem";
import { isTradfiAiSettings } from "../trade/settings.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../trade/guard.js";
import type { TradfiFlashQuote } from "../trade/dataPlaneReads.js";
import { RFQ_RANKING_NOTIONAL_WEI, type RfqQuoteInput, type RfqQuoteResult, type RfqStocksDeps } from "../trade/rfq.js";
import { USDT_56 } from "../trade/settlement.js";
import { agenticAddress, agenticDecimal, agenticQuoteRaw, agenticUiString, type AgenticHireFacts } from "./domain.js";
import { type AgenticExecutionDeps, recordAgenticConnection } from "./execute.js";
import { acquireAgenticFence } from "./obligations.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";

/** The DCA lane's per-process throttle precedent (`DCA_THROTTLE_MS`): a 429 or 503 answer skips this agent's RFQ commands for 300 000 ms. */
export const RFQ_THROTTLE_MS = 300_000;
const E18 = 10n ** 18n;
/** The seven non-transport names of the CLI error set: a quote refused under one of them is Binance refusing, not the network failing. Same set as `QUOTE_REFUSAL_NAMES` in `src/agentic/execute.ts` (a test pins the equality; that file stays untouched). */
const QUOTE_REFUSAL_NAMES: ReadonlySet<string> = new Set(["SERVICE_ERROR", "ORDER_API_ERROR", "APP_CONFIRMATION_REQUIRED", "INSUFFICIENT_BALANCE", "INSUFFICIENT_GAS", "INVALID_TOKEN", "INVALID_PARAMETER"]);
const THROTTLES = new WeakMap<AgenticStore, Map<string, number>>();
const throttleOf = (store: AgenticStore): Map<string, number> => { let map = THROTTLES.get(store); if (map === undefined) { map = new Map(); THROTTLES.set(store, map); } return map; };

type QuoteDeps = Pick<AgenticExecutionDeps, "store" | "runner" | "chain" | "instance" | "masterKey">;

export async function agenticRfqQuote(deps: QuoteDeps, input: RfqQuoteInput): Promise<RfqQuoteResult> {
  const { store } = deps;
  const throttles = throttleOf(store);
  // 1. a recent SERVICE_UNAVAILABLE answer: no command at all until the window has passed (299 999 ms still skips, 300 000 ms resumes).
  if ((throttles.get(input.agent.id) ?? 0) > await store.now()) return { ok: false, code: "rfq-throttled" };
  // 2. the wallet row must be bound, and the stock representable (18 decimals, uiMultiplier at least 1e18, two RPCs agreeing).
  const row = await store.byAgent(input.agent.id);
  if (row === null || row.state !== "bound" || row.walletAddress === null || row.sessionCiphertext === null) return { ok: false, code: "rfq-unreachable" };
  const token = agenticAddress(input.token), usdt = agenticAddress(USDT_56);
  let multiplier: bigint;
  try {
    multiplier = await deps.chain.multiplier(token);
    if ((await deps.chain.metadata(token)).decimals !== 18 || multiplier < E18) return { ok: false, code: "rfq-unrepresentable" };
  } catch { return { ok: false, code: "rfq-unrepresentable" }; }
  // 3. the UI quantity: a buy spends USDT as is; a sell converts the raw balance to the UI amount (the executor computes the exact sell quantity again before any swap).
  const buy = input.side === "buy";
  const fromQty = buy ? agenticUiString(input.amountAtomic) : agenticUiString(input.amountAtomic * multiplier / E18);
  // 4. fence, command, connection signal, conditional release.
  let fence = await acquireAgenticFence(store, row.walletAddress, deps.instance.row.instanceId);
  if (fence === null) return { ok: false, code: "rfq-wallet-busy" };
  try {
    const renewed = await store.renewFence(fence);
    if (renewed === null) return { ok: false, code: "rfq-wallet-busy" };
    fence = renewed;
    const result = await deps.runner.run(["market-order", "quote", "--fromToken", buy ? usdt : token, "--toToken", buy ? token : usdt, "--fromTokenQty", fromQty, "--binanceChainId", "56"],
      decryptAgenticSession(row, deps.masterKey));
    await recordAgenticConnection(store, input.agent.id, result);
    // 5. output.
    if (result.kind === "cli-error") {
      if (result.name === "SERVICE_UNAVAILABLE") throttles.set(input.agent.id, await store.now() + RFQ_THROTTLE_MS);
      return { ok: false, code: QUOTE_REFUSAL_NAMES.has(result.name) ? `rfq-refused:${result.name}` : "rfq-unreachable" };
    }
    if (result.kind !== "ok") return { ok: false, code: "rfq-unreachable" };
    const out = typeof result.data === "object" && result.data !== null ? (result.data as Record<string, unknown>)["toCoinAmount"] : null;
    const quoted = typeof out !== "string" ? null : buy ? agenticQuoteRaw(out, agenticUiString(multiplier)) : agenticDecimal(out);
    return quoted === null || quoted <= 0n ? { ok: false, code: "rfq-unparseable" } : { ok: true, outAtomic: quoted };
  } finally { await store.releaseFence(fence); }
}

/** The dep `createAgenticWorkerDeps` hands the shared worker, flag on or off; `entries` is the trade-worker's own AGENTIC_RFQ_STOCKS_ENABLED. */
export function createAgenticRfqStocks(input: { execution: QuoteDeps; entries: boolean }): RfqStocksDeps {
  return {
    async active(agent) {
      const row = await input.execution.store.byAgent(agent.id);
      if (agent.custodyModel !== "binance-agentic" || row === null || row.state !== "bound" || row.hireFacts?.rfq?.v !== 1 || row.hireParams === null || !isTradfiAiSettings(row.hireParams.settings)) return null;
      return { entries: input.entries, rfqOnlyAtHire: new Set(row.hireFacts.rfq.rfqOnly.map((token) => token.toLowerCase())) };
    },
    quote: (quote) => agenticRfqQuote(input.execution, quote),
  };
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------ */
/* E3: the Agentic pin variant. The sweep itself runs in src/server.ts (it owns the data plane and the guard); the pure parts live here.             */
/* ------------------------------------------------------------------------------------------------------------------------------------------------ */

/** The ceiling applied after the hire filter (OQ-10): the issuer lists 87 BSC bStocks, the lane carries 50 today. It bounds the read budgets, it does not cut today's pin. */
export const AGENTIC_RFQ_PIN_MAX = 64;
export type AgenticRfqPin = {
  readonly pooled: readonly Address[]; readonly rfqOnly: readonly Address[];
  /** Validated Flash proxy buy quote at 20 USDT, for ordering only; the binding price check is the Agentic quote. */
  readonly costs: readonly { readonly token: Address; readonly costBps: number | null }[];
};

/**
 * R3.9: the ranking quote cannot use `acceptFlashQuote` (its first check needs the agent's session to grant the guard rule, and the pin is owner-independent), so it applies the
 * owner-independent pin-time set of `src/trade/schedulable.ts` plus acceptFlashQuote's request and identity checks. `null` means the quote ranks that stock last.
 */
export function validRankingOut(flash: TradfiFlashQuote, request: { readonly tokenIn: Address; readonly tokenOut: Address; readonly amountAtomic: string }, guard: Address, nowMs: number): bigint | null {
  try {
    if (flash.observedAt > nowMs || nowMs - flash.observedAt > 30_000 || flash.expiresAt <= nowMs
      || flash.amountInAtomic !== request.amountAtomic || flash.taker.toLowerCase() !== guard.toLowerCase()
      || flash.tokenIn.toLowerCase() !== request.tokenIn.toLowerCase() || flash.tokenOut.toLowerCase() !== request.tokenOut.toLowerCase()
      || flash.chainId !== 56 || flash.router.toLowerCase() !== TRADFI_BINANCE_FLASH_ROUTER_56.toLowerCase() || flash.spender.toLowerCase() !== TRADFI_BINANCE_FLASH_SPENDER_56.toLowerCase()) return null;
    const out = BigInt(flash.quotedOutAtomic), min = BigInt(flash.minOutAtomic);
    return out > 0n && min > 0n ? out : null;
  } catch { return null; }
}

/** R2 / R4.6: `round(((20 / out) / (referencePriceUsd x tokenToShareRatio) - 1) x 10 000)`, `out` in raw token units, USDT valued at 1; `referencePriceUsd` is the per-share price. */
export function rfqCostBps(input: { readonly outAtomic: bigint; readonly referencePriceUsd: number | null | undefined; readonly tokenToShareRatio: number | null | undefined }): number | null {
  const { referencePriceUsd: reference, tokenToShareRatio: ratio } = input;
  if (typeof reference !== "number" || typeof ratio !== "number" || !Number.isFinite(reference) || !Number.isFinite(ratio) || reference <= 0 || ratio <= 0 || input.outAtomic <= 0n) return null;
  const out = Number(input.outAtomic) / 1e18, notional = Number(RFQ_RANKING_NOTIONAL_WEI) / 1e18;
  const bps = Math.round(((notional / out) / (reference * ratio) - 1) * 10_000);
  return Number.isFinite(bps) ? bps : null;
}

/** R2 step 4: by cost ascending, `null` last, ties and nulls by address ascending. */
export function orderRfqOnly(rows: readonly { readonly token: Address; readonly costBps: number | null }[]): readonly { readonly token: Address; readonly costBps: number | null }[] {
  return [...rows].sort((a, b) => (a.costBps === null ? 1 : 0) - (b.costBps === null ? 1 : 0) || (a.costBps ?? 0) - (b.costBps ?? 0) || a.token.toLowerCase().localeCompare(b.token.toLowerCase()));
}

/** Order-preserving bounded concurrency (the hire's admission loop and the ranking sweep). */
export async function mapWithConcurrency<T, R>(values: readonly T[], limit: number, visit: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) { const index = next++; if (index >= values.length) return; output[index] = await visit(values[index]!, index); }
  }));
  return output;
}

/** 4.4: the `hire_facts.rfq` record of an RFQ-variant hire, from the pin and the list that survived the hire filter and the ceiling. */
export function agenticRfqFacts(pin: AgenticRfqPin, pinned: readonly Address[]): NonNullable<AgenticHireFacts["rfq"]> {
  const kept = new Set(pinned.map((token) => token.toLowerCase())), rfqOnly = new Set(pin.rfqOnly.map((token) => token.toLowerCase()));
  const rfqOnlyPinned = pinned.filter((token) => rfqOnly.has(token.toLowerCase()));
  return { v: 1, notionalWei: RFQ_RANKING_NOTIONAL_WEI.toString(10), pooledCount: pinned.length - rfqOnlyPinned.length, rfqOnly: rfqOnlyPinned,
    costs: pin.costs.filter((row) => kept.has(row.token.toLowerCase())).map((row) => ({ token: agenticAddress(row.token), costBps: row.costBps })) };
}
