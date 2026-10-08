import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import type { AgentRecord, AgentStore, SessionFacts } from "../store/agents.js";
import type { TradeSettingsRecord, TradeSettingsStore, TradeWorkerSettingsPage } from "../store/tradeSettings.js";
import { parseTradeSettings, isTradfiAiSettings, isTradeDcaSettings, isTradePortfolioSettings, isTradeScheduleSettings, type TradeSettings } from "../trade/settings.js";
import { checkTradfiScheduleSizing } from "../trade/sizing.js";
import { MAX_UINT256, USDT_56 } from "../trade/settlement.js";

export const AGENTIC_RECEIPT_TAG = keccak256(stringToBytes("agentic-v1"));
export const AGENTIC_UNIT = 10n ** 18n;
export type AgenticState = "waiting" | "verified" | "paired" | "cleaning" | "hiring" | "bound" | "ending" | "ended" | "failed" | "expired";
export type AgenticFactsRead = {
  readAtMs: number; status: string; tradeAllTokens: boolean; abnormalTxnHandling: string;
  dailyLimit: number; quotaUsed: number; x402DailyLimit: number; x402QuotaUsed: number;
  signInMaxTimeMs: number | null; usdtWei: string; bnbWei: string;
  /** Set when only the two chain balances were re-read inside the Binance cache window. */
  balancesAtMs?: number;
};
export type AgenticHireParams = {
  pairingId: string; term: 7 | 30; termEndAction: "sell-all" | "keep"; executionModel: "tradfi";
  hireRunId: string; settings: TradeSettings; acceptedDedicatedWallet: true;
  /** AGENTIC-MEME-STOCKS-SPEC 9.1: present only on a paper meme hire (the 8-key body); inside the canonical params, so the agent id differs from any stock hire. */
  strategy?: "meme-stocks-paper";
  /** AGENTIC-EARN-SPEC 3.1: present only when the owner opted in at Deploy (the earn body); inside the canonical params, so the agent id differs from the same hire without it. */
  earn?: true;
};
export type AgenticHireFacts = {
  acceptedAtMs: number; termSec: number; termEndAction: "sell-all" | "keep"; hireEndMs: number;
  entryCutoffMs: number; signInMaxTimeMs: number; pinned: readonly Address[]; quoteDayCapWei: string;
  budgetWei: string; hireSizing: NonNullable<SessionFacts["hireSizing"]>; acceptedDedicatedWalletAtMs: number;
  /**
   * AGENTIC-RFQ-STOCKS 4.2: written once, in the same stage-gated write as the rest, and only by an Agentic AI hire taken with AGENTIC_RFQ_STOCKS_ENABLED on; absent on every other hire.
   * `costs` is the validated Flash proxy buy quote at 20 USDT, for ordering only; the binding price check of every RFQ trade is the Agentic quote.
   */
  rfq?: { v: 1; notionalWei: string; pooledCount: number; rfqOnly: readonly Address[]; costs: readonly { token: Address; costBps: number | null }[] };
  /** AGENTIC-MEME-STOCKS-SPEC 9.1 (PA2): written only by a paper meme hire; every meme branch keys on it, so a row without it takes today's paths. */
  meme?: { v: 1; mode: "paper" };
  /** AGENTIC-EARN-SPEC 3.1: written once at stage gated by an earn hire; every Earn branch keys on it, so a row without it takes today's paths. */
  earn?: { v: 1 };
};
/** One paper position of a meme hire (AGENTIC-MEME-STOCKS-SPEC 8.2, table `agentic_meme_paper`). Amounts are atomic USDT (or token) decimal strings. */
export type AgenticMemePaper = {
  positionId: string; agentId: string; walletAddress: Address; token: Address; symbol: string | null; quoteToken: Address; quoteSymbol: string | null;
  venueEntry: "flap-bonding" | "pancake-v2" | "fourmeme-bonding"; buyTaxBps: number; sellTaxBps: number; tokenVersion: number;
  entryUsdt: string; gasBuyUsdt: string; bnbUsdtE18: string; tokens: string; costBps: number; status: "open" | "closed";
  lastMarkUsdt: string | null; lastMarkAt: number | null; peakPnlBps: number | null; markSkips: number; markCount: number; closeRequestedAt: number | null;
  closeCode: "stop" | "trailing" | "dead-chart" | "smart-out" | "flow-flip" | "time" | "drain" | "ended" | null;
  exitUsdt: string | null; gasSellUsdt: string | null; pnlUsdt: string | null; closedAt: number | null; openedAt: number; version: number;
};
/** One decision-log row (AGENTIC-MEME-STOCKS-SPEC 8.6, table `agentic_meme_log`); `agentId` is null on the global `market` row. */
export type AgenticMemeLog = { id: string; agentId: string | null; kind: "market" | "cycle" | "signal" | "llm" | "entry" | "mark" | "exit" | "jev"; token: string | null; atMs: number; data: unknown };
export type AgenticWallet = {
  pairingId: string; state: AgenticState; walletAddress: Address | null; ownerAddress: Address | null;
  pairingSecretHash: string; qr: { qrCodeId: string; urlForWeb: string; expireAtMs: number } | null;
  codeHash: string; codeAttempts: number; codeMatchedAt: number | null; verifiedAt: number | null;
  continuationDeadline: number | null; sessionCiphertext: string | null; factsRead: AgenticFactsRead | null;
  hireOpId: Hex | null; agentId: string | null; hireParams: AgenticHireParams | null; hireStage: string | null;
  acceptedAt: number | null; hireFacts: AgenticHireFacts | null; hireEndMs: number | null; entryCutoffMs: number | null;
  termEndAction: "sell-all" | "keep" | null; drainRequestedAt: number | null;
  settingsHold: { code: string; atMs: number } | null;
  entriesStopped: { reason: "fill-below-minimum" | "dca-fill-above-level"; out: string; min: string; atMs: number } | null;
  probe: { lastAtMs: number; firstUAtMs: number | null; unreachableAtMs: number | null; keepAliveAtMs?: number } | null;
  endReason: "owner-signed-out" | "term-ended" | "stop-loss" | null;
  endBlockers: { atMs: number; settingsHold: boolean; paused: boolean; halted: boolean; heldObligations: number } | null;
  endStage: string | null; logout: { attempts: number; lastAtMs: number; lastResult: string } | null;
  cleanupReason: string | null; failure: string | null; version: number; createdAt: number; updatedAt: number;
};
export type AgenticOrder = {
  /** The last two kinds are written only by the retired limit-order build (legacy rows, AGENTIC-DCA-SPEC R3.8); nothing writes them now. */
  idempotencyKey: string; kind: "swap" | "x402-sign" | "limit-place" | "limit-cancel" | "earn-deposit" | "earn-redeem"; walletAddress: Address; agentId: string;
  decisionId: string | null; side: "buy" | "sell" | null; fromToken: Address | null; toToken: Address | null;
  amountAtomic: string | null; intendedRaw: string | null; fromQty: string | null; minOutAtomic: string | null;
  binanceQuoteOutAtomic: string | null; slippagePct: string | null; multiplierPre: string | null; multiplierUsed: string | null;
  listSnapshot: { takenAtMs: number; startTimeMs: number; ids: readonly string[] } | null;
  operationId: string | null; walletNoncePre: string | null; quoteAt: number | null;
  dispatch: "unclaimed" | "spawned" | "sealed" | "not-started"; claimedAt: number | null;
  claimant: string | null; fenceToken: string | null; claimDeadline: number | null;
  response: "accepted" | "rejected" | "no-response" | null; cliResult: string | null;
  returnedOrderId: string | null; listedOrderId: string | null; txHash: Hex | null; approveTxHash: Hex | null;
  outcome: "open" | "committed" | "rolled-back"; holdReason: string | null; evidence: unknown;
  fillCheck: "none" | "pending" | "ok" | "breached"; createdAt: number; updatedAt: number;
};
export type AgenticDcaRoundPhase = "starting" | "active" | "closing" | "settled" | "stopping" | "stopped" | "winding-down" | "ended" | "interrupted";
export type AgenticDcaCloseCause = "take-profit" | "stop-loss" | "term-end" | "owner-end";
/** One round of an Agentic DCA agent. Amounts are decimal strings (Postgres numeric); the lane converts with BigInt. */
export type AgenticDcaRound = {
  agentId: string; roundNo: number; walletAddress: Address; phase: AgenticDcaRoundPhase; baseOrderKey: string | null;
  p0UsdtWei: string | null; p0StockRaw: string | null; costUsdtWei: string; stockRaw: string; carriedCostWei: string; carriedStockRaw: string;
  soldStockRaw: string; proceedsUsdtWei: string; realizedPnlWei: string | null; markedPnlWei: string | null;
  stopCounter: { count: number; lastBlock: string | null; lastAtMs: number | null } | null; tpFilledAt: number | null; closeCause: AgenticDcaCloseCause | null;
  failStreak: number; backoffUntilMs: number | null; tpDueAt: number | null; openedAt: number; settledAt: number | null;
  rowVersion: number; createdAt: number; updatedAt: number;
};
export type AgenticDcaOrderState = "planned" | "placing" | "resting" | "triggered" | "cancelling" | "filled" | "cancelled" | "expired" | "failed" | "skipped" | "below-range" | "held";
export type AgenticDcaOrder = {
  orderKey: string; agentId: string; walletAddress: Address; roundNo: number; role: "level" | "tp"; levelNo: number | null; side: "buy" | "sell";
  priceNum: string; priceDen: string; triggerSent: string; qtySent: string; qtyAtomic: string; slippagePct: string;
  placeOrderKey: string | null; cancelOrderKey: string | null; strategyId: string | null; listStatus: string | null;
  unitQty: "raw" | "ui" | "ambiguous" | null; unitTrigger: "raw" | "ui" | "ambiguous" | null;
  state: AgenticDcaOrderState; closedBy: "plane" | "binance" | "external" | null; holdReason: string | null;
  txHash: Hex | null; fillUsdtWei: string | null; fillStockRaw: string | null; executor: "wallet" | "other" | null;
  rowVersion: number; createdAt: number; updatedAt: number;
};
export type AgenticFence = { walletAddress: Address; token: string; holder: string; leaseUntil: number };
export type AgenticInstance = {
  instanceId: string; service: "execution-api" | "trade-worker" | "agentic-gate"; host: string; pid: number;
  machineId: string | null; osBootMarker: string | null; railwayDeploymentId: string | null; railwayReplicaId: string | null;
  bootAt: number; heartbeatAt: number; retiredAt: number | null; retiredBy: "dispose" | "exit" | null;
};
export type AgenticGateRun = {
  runId: string; gate: "G0" | "G1" | "G2" | "G3" | "G4" | "DG1" | "DG2" | "DG3" | "DG4" | "DG5" | "DG6" | "RG1" | "RG2" | "RG3" | "RG4" | "EG1"; agentId: string; wallet: Address;
  side: "buy" | "sell" | "none" | "dca" | "earn"; maxDispatches: number; dispatches: number; maxNotionalUsdt: string;
  maxCmcPayments: number; cmcPayments: number; cmcOperationIds: readonly string[];
  deadlineMs: number; createdAt: number; closedAt: number | null;
};
export type AgenticSession = { v: 1; instanceId: string; sessionJson: string };
export type AgenticGateRow = { code: string; state: "PASS" | "FAIL" | "WARN"; fix: string };
export const AGENTIC_HIRE_REASONS: readonly string[] = ["gate-rows", "sizing", "pin-unavailable", "pinned-empty", "pin-error", "settings-unreadable", "wallet-busy", "pending-orders", "limit-orders",
  "schedule-token-not-granted", "schedule-token-unquotable", "schedule-capability-incomplete", "schedule-first-buy-past", "schedule-end-past",
  "portfolio-disabled", "portfolio-token-unsupported", "portfolio-token-unquotable", "portfolio-capability-incomplete",
  "dca-disabled", "dca-token-unsupported", "dca-capability-incomplete", "dca-pool-mismatch", "dca-token-unquotable",
  "earn-unavailable", "earn-wallet-has-supply"];

export function agenticAddress(value: string): Address {
  return `0x${getAddress(value).slice(2).toLowerCase()}`;
}

export function agenticBudgetWei(term: 7 | 30): bigint {
  return BigInt(term === 7 ? 2 : 8) * AGENTIC_UNIT;
}

/** 12 h without Binance activity before a paid keep-alive call (AGENTIC-PORTFOLIO-SPEC OQ-2). */
export const AGENTIC_PAID_KEEPALIVE_IDLE_MS = 43_200_000;

/** The keep-alive budget of a hire that pays one CMC x402 call per idle window: 14 calls fit 7 days and 60 calls fit 30 days, so 0.20 / 0.80 USDT. */
export function agenticKeepAliveBudgetWei(term: 7 | 30): bigint {
  return (term === 7 ? 20n : 80n) * 10n ** 16n;
}

/** Hires whose Binance session is kept alive by one paid CMC x402 call after AGENTIC_PAID_KEEPALIVE_IDLE_MS without Binance activity (AGENTIC-PORTFOLIO-SPEC R2.2). Agentic DCA joins here (AGENTIC-DCA-SPEC R2.1). */
export function agenticUsesPaidIdleKeepAlive(settings: TradeSettings): boolean {
  return isTradePortfolioSettings(settings) || isTradeDcaSettings(settings);
}

/** Binance calls that count as activity for the keep-alive clocks:
 *  "swap-quote"   a swap order row of this agent whose `market-order quote` answered (`quoteAt` is set): MEASURED to reset the 48 h timer;
 *  "x402-settled" a CMC x402 attempt of this agent in state "settled" (its `createdAt`): EXPECTED to reset it, unmeasured.
 */
export type AgenticActivityKind = "swap-quote" | "x402-settled";

export function agenticLastActivityMs(input: { acceptedAt: number; agentId: string; orders: readonly AgenticOrder[]; settledAttemptsCreatedAt: readonly number[] },
  kinds: readonly AgenticActivityKind[]): number {
  const swaps = kinds.includes("swap-quote") ? input.orders.filter(o => o.kind === "swap" && o.agentId === input.agentId && o.quoteAt !== null).map(o => o.quoteAt!) : [];
  return Math.max(input.acceptedAt, ...swaps, ...(kinds.includes("x402-settled") ? input.settledAttemptsCreatedAt : []));
}

/** A Schedule hire has no CMC data budget (no x402 payment, no budget row); an AI hire always has one; a portfolio hire has a small keep-alive budget. */
export function agenticHasCmc(settings: TradeSettings): boolean {
  return isTradfiAiSettings(settings) || agenticUsesPaidIdleKeepAlive(settings);
}

export function agenticHireBudgetWei(settings: TradeSettings, term: 7 | 30): bigint {
  return isTradfiAiSettings(settings) ? agenticBudgetWei(term) : agenticUsesPaidIdleKeepAlive(settings) ? agenticKeepAliveBudgetWei(term) : 0n;
}

/** The USDT day cap of the projected session: Schedule keeps its own cap (the capital), AI keeps five entries' worth. */
export function agenticQuoteDayCapWei(settings: TradeSettings): bigint {
  return isTradeScheduleSettings(settings) ? BigInt(settings.capitalQuoteWei!) : BigInt(settings.capitalQuoteWei!) * 5n;
}

export function agenticDecimal(value: unknown): bigint | null {
  if (typeof value === "number") {
    // Binance reports quotas as long floats (measured 2026-10-03). The shortest printed form is the exact decimal Binance meant;
    // an exponent form (such as 1e-7) falls back to toFixed(18), which never uses exponent form below 1e21.
    if (!Number.isFinite(value) || value < 0 || value > 1e12) return null;
    value = /^\d+(\.\d{1,18})?$/.test(String(value)) ? String(value) : value.toFixed(18);
  }
  if (typeof value !== "string" || !/^\d+(\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * AGENTIC_UNIT + BigInt(fraction.padEnd(18, "0"));
}

export function agenticUiString(value: bigint): string {
  if (value < 0n) throw new Error("AGENTIC_AMOUNT_UNREPRESENTABLE");
  const fraction = (value % AGENTIC_UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return (value / AGENTIC_UNIT).toString() + (fraction === "" ? "" : "." + fraction);
}

/** `heldRaw` is the wallet's whole chain balance when a partial sell (a portfolio leg) is priced; the UI balance Binance reports covers all of it. */
export function agenticSellAmount(raw: bigint, multiplier: string, balance: string, heldRaw: bigint = raw): string | null {
  if (raw <= 0n || !/^\d+(\.\d+)?$/.test(multiplier)) return null;
  const [whole, fraction = ""] = multiplier.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const m = BigInt(whole! + fraction);
  if (m < scale) return null;
  const u0 = raw * m / scale;
  if (agenticDecimal(balance) !== heldRaw * m / scale) return null;
  for (const u of [u0, u0 + 1n, u0 + 2n]) {
    const numerator = u * scale * 100n;
    const q20 = (numerator * 2n + m) / (2n * m);
    if (raw * 100n - 100n < q20 && q20 <= raw * 100n) return agenticUiString(u);
  }
  return null;
}

export function agenticQuoteRaw(ui: string, multiplier: string): bigint | null {
  const value = agenticDecimal(ui);
  if (value === null || !/^\d+(\.\d+)?$/.test(multiplier)) return null;
  const [whole, fraction = ""] = multiplier.split(".");
  const m = BigInt(whole! + fraction);
  return m === 0n ? null : value * 10n ** BigInt(fraction.length) / m;
}

export function agenticSlippage(quote: bigint, minimum: bigint, settingsBps: number): string | null {
  if (quote <= 0n || minimum <= 0n || quote < minimum || !Number.isInteger(settingsBps)) return null;
  const headroom = (quote - minimum) * 10_000n / quote;
  const bps = headroom < BigInt(settingsBps) ? headroom : BigInt(settingsBps);
  if (bps <= 0n) return null;
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}`.replace(/\.?0+$/, "");
}

export type AgenticScheduleGate = { intervalSec: 3600 | 14400 | 28800 | 43200 | 86400; endKind: "budget" | "date" | "runs";
  endRuns: number | null; endAtSec: number | null; firstAtSec: number | null };
export type AgenticGateInput = { facts: AgenticFactsRead; wallet?: string; capitalQuoteWei: bigint; maxOpenPositions: number;
  entryWei: bigint; termSec: number; nowMs: number; budgetWei: bigint; quoteDayCapWei?: bigint; schedule?: AgenticScheduleGate; portfolio?: { tokenCount: number }; dca?: { maxOrders: number };
  /** AGENTIC-MEME-STOCKS-SPEC 9.1: a paper meme hire, which swaps nothing and pays nothing. */ meme?: "paper";
  /** AGENTIC-EARN-SPEC 3.10: an earn hire keeps two more operation reserves of BNB (a deposit and a redeem). */ earn?: true };
/** The paper gate's rows (review R2-H2): `trade-all-tokens` is a WARN, never a FAIL, while U11 has not shown that quotes need it. */
const MEME_PAPER_ROWS: ReadonlySet<string> = new Set(["status", "trade-all-tokens", "sign-in-time", "sizing"]);

export function agenticGate(input: AgenticGateInput): { rows: AgenticGateRow[]; hireEndMs: number; entryCutoffMs: number } {
  const f = input.facts;
  const end = Math.min(input.nowMs + input.termSec * 1_000, (f.signInMaxTimeMs ?? 0) - 3_600_000);
  const daily = agenticDecimal(f.dailyLimit);
  const used = agenticDecimal(f.quotaUsed);
  const x402 = agenticDecimal(f.x402DailyLimit);
  const usdt = /^\d+$/.test(f.usdtWei) ? BigInt(f.usdtWei) : -1n;
  const bnb = /^\d+$/.test(f.bnbWei) ? BigInt(f.bnbWei) : -1n;
  const s = input.schedule;
  // Schedule buys never sell, so the executor floor counts one token; the gate adds one 0.0004 BNB per buy the term can run.
  const counts = s === undefined ? null : checkTradfiScheduleSizing({ capDayWei: MAX_UINT256, entryWei: input.entryWei, capitalQuoteWei: input.capitalQuoteWei, platformFeeBps: 0,
    grantedTokenCount: 1, intervalSec: s.intervalSec, ttlSec: Math.floor((end - input.nowMs) / 1_000), endKind: s.endKind, endRuns: s.endRuns, endAtSec: s.endAtSec,
    anchorAtSec: s.firstAtSec ?? Math.floor(input.nowMs / 1_000) });
  const dailyNeed = (input.quoteDayCapWei ?? input.capitalQuoteWei * 5n) * 2n;
  const usdtNeed = input.capitalQuoteWei + input.budgetWei;
  // A portfolio buys through every stock: the executor floor is (N + 2) x 0.0004 BNB and the gate adds one 0.0004 per first-basket buy.
  // A DCA hire pays one swap per fill (R3.7): two rounds of base, N levels and a take profit, (2N + 4) x 0.0004 BNB.
  const bnbNeed = BigInt(input.dca !== undefined ? 2 * input.dca.maxOrders + 4 : input.portfolio !== undefined ? 2 * input.portfolio.tokenCount + 2
    : input.maxOpenPositions + 2 + (counts === null ? 0 : Math.min(counts.plannedBuys, counts.buysThisSession))) * 400_000_000_000_000n
    + (input.earn === true ? 800_000_000_000_000n : 0n);
  const sizingNeed = BigInt(input.maxOpenPositions) * input.entryWei;
  const entryCutoffMs = end - Math.min(7_200_000, (end - input.nowMs) / 2);
  const nowSec = Math.floor(input.nowMs / 1_000);
  const scheduleRows: AgenticGateRow[] = s === undefined ? [] : [
    { code: "schedule-first-buy", state: s.firstAtSec === null || (s.firstAtSec >= nowSec - 300 && s.firstAtSec <= Math.min(Math.floor(entryCutoffMs / 1_000), nowSec + 604_800 - 7_200)) ? "PASS" : "FAIL",
      fix: `Choose a first buy within the next 7 days and before ${new Date(entryCutoffMs).toISOString()}.` },
    { code: "schedule-end-date", state: s.endAtSec === null || s.endAtSec * 1_000 > input.nowMs ? "PASS" : "FAIL", fix: "Choose an end date in the future." },
  ];
  const x402Rows: AgenticGateRow[] = s !== undefined ? [] : [
    { code: "x402-limit", state: x402 !== null && x402 >= AGENTIC_UNIT / 2n ? "PASS" : "FAIL", fix: "Raise x402 Daily limit to 0.50 USDT." },
  ];
  const rows: AgenticGateRow[] = [
    { code: "status", state: f.status === "CONNECTED" ? "PASS" : "FAIL", fix: "Connect in the Binance App." },
    { code: "trade-all-tokens", state: f.tradeAllTokens === true ? "PASS" : "FAIL", fix: "Enable Trade all tokens in the Binance App." },
    { code: "abnormal-handling", state: f.abnormalTxnHandling === "AutoReject" ? "PASS" : "FAIL", fix: "Choose AutoReject in the Binance App." },
    { code: "sign-in-time", state: Number.isSafeInteger(f.signInMaxTimeMs) && end >= input.nowMs + input.termSec * 1_000 - 86_400_000 ? "PASS" : "FAIL", fix: "Raise Max sign-in duration in the Binance App, or choose 7 days." },
    { code: "daily-limit", state: daily !== null && daily >= dailyNeed ? "PASS" : "FAIL", fix: `Raise Daily limit to ${agenticUiString(dailyNeed)} USDT.` },
    ...x402Rows,
    { code: "usdt", state: usdt >= usdtNeed ? "PASS" : "FAIL", fix: usdt < 0n ? "USDT balance unavailable; refresh checks." : `Have ${agenticUiString(usdt)} USDT, need ${agenticUiString(usdtNeed)} USDT: add ${agenticUiString(usdt < usdtNeed ? usdtNeed - usdt : 0n)} USDT to ${input.wallet ?? "the Agentic Wallet"}.` },
    { code: "bnb", state: bnb >= bnbNeed ? "PASS" : "FAIL", fix: bnb < 0n ? "BNB balance unavailable; refresh checks." : `Have ${agenticUiString(bnb)} BNB, need ${agenticUiString(bnbNeed)} BNB: add ${agenticUiString(bnb < bnbNeed ? bnbNeed - bnb : 0n)} BNB to ${input.wallet ?? "the Agentic Wallet"}.` },
    { code: "quota-today", state: daily !== null && used !== null && daily - used >= input.entryWei ? "PASS" : "WARN", fix: "Wait for the Binance daily quota to reset." },
    { code: "sizing", state: input.capitalQuoteWei >= sizingNeed ? "PASS" : "FAIL", fix: `Capital ${agenticUiString(input.capitalQuoteWei)} USDT is below ${input.maxOpenPositions} positions x ${agenticUiString(input.entryWei)} USDT = ${agenticUiString(sizingNeed)} USDT; raise capital or lower the entry size.` },
    ...scheduleRows,
  ];
  if (input.meme !== "paper") return { hireEndMs: end, entryCutoffMs, rows };
  return { hireEndMs: end, entryCutoffMs, rows: rows.filter(r => MEME_PAPER_ROWS.has(r.code)).map(r => r.code !== "trade-all-tokens" ? r
    : { code: r.code, state: f.tradeAllTokens === true ? "PASS" : "WARN", fix: "Not needed for paper trading. A live agent will need Trade all tokens." }) };
}

/** The paper meme hire's fixed settings bounds (AGENTIC-MEME-STOCKS-SPEC 9.1, D4, D14): 10 USDT minimum, 10..50 per trade, 1..3 open, no CMC, no owner exits or text, sell-all. */
function memePaperSettingsOk(s: TradeSettings, termEndAction: unknown): boolean {
  const entry = BigInt(s.entryWei);
  return isTradfiAiSettings(s) && s.cmcNewsEnabled === false && s.cmcTotalBudgetWei === undefined && s.minEntryWei === (10n * AGENTIC_UNIT).toString()
    && entry >= 10n * AGENTIC_UNIT && entry <= 50n * AGENTIC_UNIT && s.maxOpenPositions >= 1 && s.maxOpenPositions <= 3
    && BigInt(s.capitalQuoteWei!) >= BigInt(s.maxOpenPositions) * entry && s.slippageBps === 500
    && s.takeProfitBps === null && s.stopLossBps === null && s.maxHoldSec === null && s.instructions === null && s.skillMarkdown === null && termEndAction === "sell-all";
}

export function parseAgenticHireParams(value: unknown, options: { meme?: boolean; earn?: boolean } = {}): AgenticHireParams | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  // AGENTIC-MEME-STOCKS-SPEC 9.1: the 8-key paper body exists only when the caller's flag is on; every other body keeps exactly today's 7 keys.
  const meme = options.meme === true && Object.hasOwn(p, "strategy");
  // AGENTIC-EARN-SPEC 3.1: the optional `earn: true` key exists only when the caller's flag is on; with it off, such a body is the wrong key count and refused.
  const earn = options.earn === true && Object.hasOwn(p, "earn");
  const keys = ["pairingId", "term", "termEndAction", "executionModel", "hireRunId", "settings", "acceptedDedicatedWallet", ...(meme ? ["strategy"] : []), ...(earn ? ["earn"] : [])];
  if (meme && p["strategy"] !== "meme-stocks-paper") return null;
  if (earn && p["earn"] !== true) return null;
  if (Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k))
    || typeof p["pairingId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p["pairingId"])
    || (p["term"] !== 7 && p["term"] !== 30) || (p["termEndAction"] !== "keep" && p["termEndAction"] !== "sell-all")
    || p["executionModel"] !== "tradfi" || p["acceptedDedicatedWallet"] !== true
    || typeof p["hireRunId"] !== "string" || !/^[0-9a-f-]{36}$/i.test(p["hireRunId"])) return null;
  const settings = parseTradeSettings(p["settings"]);
  if (!settings.ok) return null;
  const effective = settings.value.effective;
  if (meme) {
    if (earn || !memePaperSettingsOk(effective, p["termEndAction"])) return null;
    return { pairingId: p["pairingId"], term: p["term"], termEndAction: p["termEndAction"], executionModel: "tradfi",
      hireRunId: p["hireRunId"], settings: p["settings"] as TradeSettings, acceptedDedicatedWallet: true, strategy: "meme-stocks-paper" };
  }
  // AI keeps its CMC budget; Schedule and portfolio (the parser already forbids CMC and exits) must keep holdings at term end.
  if (!(isTradfiAiSettings(effective) && effective.cmcNewsEnabled === true && effective.cmcTotalBudgetWei === agenticBudgetWei(p["term"]).toString())
    && !(isTradeScheduleSettings(effective) && p["termEndAction"] === "keep")
    && !(isTradePortfolioSettings(effective) && p["termEndAction"] === "keep")
    && !(isTradeDcaSettings(effective) && p["termEndAction"] === "keep")) return null;
  // Earn: AI, Schedule, and DCA with N >= 5 levels; never a portfolio.
  if (earn && (isTradePortfolioSettings(effective) || isTradeDcaSettings(effective) && (effective.dcaMaxOrders ?? 0) < 5)) return null;
  return { pairingId: p["pairingId"], term: p["term"], termEndAction: p["termEndAction"], executionModel: "tradfi",
    hireRunId: p["hireRunId"], settings: p["settings"] as TradeSettings, acceptedDedicatedWallet: true, ...(earn ? { earn: true as const } : {}) };
}

/** The ONE builder of the gate input from a stored hire body, so stage `gated`, the refusal response and the pre-check cannot disagree. */
export function agenticGateInput(p: AgenticHireParams, facts: AgenticFactsRead, wallet: string | undefined, nowMs: number): AgenticGateInput {
  const s = p.settings;
  return { facts, ...(wallet === undefined ? {} : { wallet }), capitalQuoteWei: BigInt(s.capitalQuoteWei!), maxOpenPositions: s.maxOpenPositions,
    entryWei: BigInt(s.entryWei), termSec: p.term * 86_400, nowMs, budgetWei: agenticHireBudgetWei(s, p.term), quoteDayCapWei: agenticQuoteDayCapWei(s),
    ...(!isTradeScheduleSettings(s) ? {} : { schedule: { intervalSec: s.scheduleIntervalSec!, endKind: s.scheduleEndKind!, endRuns: s.scheduleEndRuns!,
      endAtSec: s.scheduleEndAtSec!, firstAtSec: s.scheduleFirstAtSec! } }),
    ...(!isTradePortfolioSettings(s) ? {} : { portfolio: { tokenCount: s.portfolioTokens!.length } }),
    ...(!isTradeDcaSettings(s) ? {} : { dca: { maxOrders: s.dcaMaxOrders! } }),
    ...(p.strategy === undefined ? {} : { meme: "paper" as const }), ...(p.earn === true ? { earn: true as const } : {}) };
}

export function agenticHireIdentity(params: AgenticHireParams): { paramsDigest: Hex; hireOpId: Hex; agentId: string } {
  const paramsDigest = keccak256(stringToBytes(canonicalEncode(params)));
  const hireOpId = keccak256(stringToBytes(canonicalEncode({ pairingId: params.pairingId, paramsDigest })));
  return { paramsDigest, hireOpId, agentId: "agentic-" + hireOpId.slice(2, 22) };
}

export function projectAgenticSessionFacts(row: AgenticWallet): SessionFacts {
  if (row.agentId === null || row.walletAddress === null || row.hireFacts === null) throw new Error("AGENTIC_HIRE_FACTS");
  const f = row.hireFacts;
  const expiry = Math.floor(f.hireEndMs / 1_000);
  return { publicKey: keccak256(stringToBytes("4lpha-agentic-identity-v1:" + row.agentId + ":" + row.walletAddress)),
    spec: { allowedCalls: [...f.pinned, USDT_56].map(to => ({ to, selector: "approve(address,uint256)" })),
      spendCaps: [{ token: USDT_56, limit: BigInt(f.quoteDayCapWei), period: "day" }], expiresAt: expiry },
    permissions: { calls: [], spend: [] }, expiry, hireSizing: f.hireSizing, generation: 1,
    grantedAtSec: Math.floor(f.acceptedAtMs / 1_000) };
}

export function excludeCustody(store: TradeSettingsStore, agents: Pick<AgentStore, "getAgentById">): TradeSettingsStore {
  return new Proxy(store, { get(target, property, receiver): unknown {
    if (property === "listTradeAgentsForWorker" || property === "listTradeAgentsForProjection") {
      return async (input: { limit: number; cursor: string | null }): Promise<TradeWorkerSettingsPage> => {
        const rows: TradeSettingsRecord[] = [];
        let cursor = input.cursor;
        for (;;) {
          const page = await target[property]({ limit: input.limit, cursor });
          for (const row of page.rows) {
            if ((await agents.getAgentById(row.agentId))?.custodyModel !== "binance-agentic") rows.push(row);
            if (rows.length > input.limit) break;
          }
          if (rows.length > input.limit || !page.hasMore) break;
          if (page.cursor === null || page.cursor === cursor) throw new Error("Trade settings cursor did not advance.");
          cursor = page.cursor;
        }
        const hasMore = rows.length > input.limit;
        const returned = rows.slice(0, input.limit);
        return { rows: returned, hasMore, cursor: hasMore ? returned.at(-1)!.agentId : null };
      };
    }
    const value: unknown = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export function altanaAgentStore(store: AgentStore): AgentStore {
  const visible = (row: AgentRecord | null): AgentRecord | null => row?.custodyModel === "binance-agentic" ? null : row;
  return new Proxy(store, { get(target, property, receiver): unknown {
    if (property === "getAgent") return async (owner: Address, id: string) => visible(await target.getAgent(owner, id));
    if (property === "getAgentById") return async (id: string) => visible(await target.getAgentById(id));
    if (property === "listAgents") return async (owner: Address) => (await target.listAgents(owner)).filter(row => visible(row) !== null);
    if (property === "listAgentsBounded") return async (owner: Address, limit: number, signal?: AbortSignal) => {
      const page = await target.listAgentsBounded(owner, limit, signal);
      if (!page.hasMore && page.rows.every(row => visible(row) !== null)) return page;
      const rows = (await target.listAgents(owner)).filter(row => visible(row) !== null).sort((a, b) => a.id.localeCompare(b.id));
      if (page.rows.every(row => visible(row) !== null)) return { rows: page.rows, hasMore: rows.length > limit };
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    };
    if (property === "getAgentSessionKey" || property === "readExecutingSession" || property === "hasAgentSessionKey") {
      return async (owner: Address, id: string) => (await target.getAgent(owner, id))?.custodyModel === "binance-agentic"
        ? property === "hasAgentSessionKey" ? false : null : target[property](owner, id);
    }
    if (property === "listProvisioningAgentsForWorker" || property === "listPendingRenewals") {
      return async (input: { afterId: string | null; limit: number; signal?: AbortSignal }) => {
        const rows: AgentRecord[] = [];
        let afterId = input.afterId;
        for (;;) {
          const page = await target[property]({ ...input, afterId });
          rows.push(...page.rows.filter(row => visible(row) !== null));
          if (rows.length > input.limit || !page.hasMore) break;
          const next = page.rows.at(-1)?.id;
          if (next === undefined || next === afterId) throw new Error("Agent cursor did not advance.");
          afterId = next;
        }
        return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
      };
    }
    const value: unknown = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
