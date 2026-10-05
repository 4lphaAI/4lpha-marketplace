import { scheduleBuysThisSession, type TradeDcaOrderView, type TradeDcaView, type TradeSettings } from "./trade";

export const agenticEnabled = process.env.NEXT_PUBLIC_AGENTIC_WALLET_ENABLED === "true";
/** Agentic Auto DCA (build time, off by default): the DCA tile badge and the DCA case of the custody branch. */
export const agenticDcaEnabled = process.env.NEXT_PUBLIC_AGENTIC_DCA_ENABLED === "true";
const UNIT = 10n ** 18n;
export type AgenticFacts = { readAtMs: number; status: string; tradeAllTokens: boolean; abnormalTxnHandling: string;
  dailyLimit: number; quotaUsed: number; x402DailyLimit: number; x402QuotaUsed: number; signInMaxTimeMs: number | null; usdtWei: string; bnbWei: string; balancesAtMs?: number };
export type AgenticPairing = { state: string; walletAddress: string | null; codeAttemptsLeft: number; facts: AgenticFacts | null;
  continuationDeadlineMs: number | null; failure: string | null };
export type AgenticGateRow = { code: string; state: "PASS" | "FAIL" | "WARN"; fix: string };
export type AgenticHireReason = "gate-rows" | "sizing" | "pin-unavailable" | "pinned-empty" | "pin-error" | "settings-unreadable" | "wallet-busy" | "pending-orders" | "limit-orders"
  | "schedule-token-not-granted" | "schedule-token-unquotable" | "schedule-capability-incomplete" | "schedule-first-buy-past" | "schedule-end-past"
  | "portfolio-disabled" | "portfolio-token-unsupported" | "portfolio-token-unquotable" | "portfolio-capability-incomplete"
  | "dca-disabled" | "dca-token-unsupported" | "dca-capability-incomplete" | "dca-pool-mismatch" | "dca-token-unquotable";
const PAIRING_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  pairing_code_attempts: "Code attempts exhausted. Start a new pairing.",
  pairing_code_expired: "Code expired. Start a new pairing.",
  pairing_not_ready: "Pairing is not ready.",
  "gate-rows": "Hire refused: Binance checks failed.", sizing: "Hire refused: capital does not cover the position sizes.",
  "pin-unavailable": "Hire refused: stock selection is unavailable.", "pinned-empty": "Hire refused: no eligible stocks were found.",
  "pin-error": "Hire refused: stock selection could not be read.", "settings-unreadable": "Hire refused: Binance settings could not be read.",
  "wallet-busy": "Hire refused: the wallet is busy.", "pending-orders": "Hire refused: the wallet has pending orders.",
  "limit-orders": "Hire refused: the wallet has active limit orders.",
  "schedule-token-not-granted": "Hire refused: this stock is not in the eligible list.",
  "schedule-token-unquotable": "Hire refused: this stock has no buy quote at this amount.",
  "schedule-capability-incomplete": "Hire refused: the stock check did not finish. Check the pairing status below, then try again.",
  "schedule-first-buy-past": "Hire refused: the first buy time is outside the allowed window. Choose a new time and deploy again.",
  "schedule-end-past": "Hire refused: the end date has passed. Choose a new end date and deploy again.",
  "portfolio-disabled": "Hire refused: Smart Portfolio is not enabled on this execution plane.",
  "portfolio-token-unsupported": "Hire refused: a selected stock cannot be traded from an Agentic Wallet.",
  "portfolio-token-unquotable": "Hire refused: one stock has no direct buy quote. Try again later.",
  "portfolio-capability-incomplete": "Hire refused: the stock check did not finish. Check the pairing status below, then try again.",
  "dca-disabled": "Hire refused: Agentic Auto DCA is not enabled on this execution plane.",
  "dca-token-unsupported": "Hire refused: this stock cannot be traded from an Agentic Wallet.",
  "dca-capability-incomplete": "Hire refused: the stock check did not finish. Check the pairing status below, then try again.",
  "dca-pool-mismatch": "Hire refused: this stock's price pool changed. Try again later.",
  "dca-token-unquotable": "Hire refused: Binance has no buy quote for this stock at this amount.",
};
export class AgenticRequestError extends Error {
  constructor(code: string, readonly gate: readonly AgenticGateRow[] = [], readonly reason: AgenticHireReason | null = null) { super(PAIRING_ERROR_MESSAGES[reason ?? code] ?? code); }
}
const DEPLOYED_WALLETS = "4lpha:agentic-wallets:v1";
export function agenticDeployedWallets(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DEPLOYED_WALLETS) ?? "[]");
    return Array.isArray(stored) ? [...new Set(stored.filter((value): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)).map(value => value.toLowerCase()))] : [];
  } catch { return []; }
}
export function rememberAgenticWallet(wallet: string): void {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet)) return;
  try { localStorage.setItem(DEPLOYED_WALLETS, JSON.stringify([...new Set([...agenticDeployedWallets(), wallet.toLowerCase()])])); } catch { /* Browser storage can be unavailable. */ }
}
export function agenticDecimal(value: unknown): bigint | null {
  if (typeof value === "number") { if (!Number.isFinite(value) || value < 0 || value > 1e12 || !/^\d+(\.\d{1,8})?$/.test(String(value))) return null; value = String(value); }
  if (typeof value !== "string" || !/^\d+(\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * UNIT + BigInt(fraction.padEnd(18, "0"));
}
export function agenticUiString(value: bigint): string {
  const fraction = (value % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return (value / UNIT).toString() + (fraction === "" ? "" : "." + fraction);
}
export type AgenticScheduleInput = { intervalSec: 3600 | 14400 | 28800 | 43200 | 86400; endKind: "budget" | "date" | "runs"; endRuns: number | null; endAtSec: number | null; firstAtSec: number | null };
/** The Schedule buy counts exactly as the plane's gate reads them (fee 0, the anchor is the first buy or now); not the Altana form's padded estimate. */
export function agenticScheduleCounts(i: AgenticScheduleInput & { capitalQuoteWei: bigint; entryWei: bigint; ttlSec: number; nowMs: number }): { plannedBuys: number; buysThisSession: number } {
  const raw = i.entryWei <= 0n ? 0 : Number(i.capitalQuoteWei / i.entryWei);
  let plannedBuys = Number.isSafeInteger(raw) ? raw : Number.MAX_SAFE_INTEGER;
  if (i.endKind === "runs" && i.endRuns !== null) plannedBuys = Math.min(plannedBuys, i.endRuns);
  if (i.endKind === "date" && i.endAtSec !== null) {
    const beforeEnd = i.endAtSec * 1_000 - (i.firstAtSec ?? Math.floor(i.nowMs / 1_000)) * 1_000 - 1;
    plannedBuys = Math.min(plannedBuys, beforeEnd < 0 ? 0 : Math.floor(beforeEnd / (i.intervalSec * 1_000)) + 1);
  }
  return { plannedBuys, buysThisSession: scheduleBuysThisSession(i.ttlSec, i.intervalSec) };
}
/** The paid keep-alive budget of a portfolio hire (the plane's agenticKeepAliveBudgetWei): 14 calls fit 7 days and 60 calls fit 30 days. */
export function agenticKeepAliveBudgetWei(term: 7 | 30): bigint { return (term === 7 ? 20n : 80n) * 10n ** 16n; }
/** Resting level buys an Agentic Auto DCA keeps alive at once (the plane's dcaAhead): one up to three orders, two from four. */
export function agenticDcaResting(maxOrders: number): 1 | 2 { return maxOrders <= 3 ? 1 : 2; }
/**
 * The hire gate's BNB slots for Agentic Auto DCA (AGENTIC-DCA-SPEC R3.7, plane parity): one swap per fill, two rounds of base, N levels and a take profit, 2N + 4, at 0.0004 BNB each. A count outside 1..8 is
 * read as 8, so a malformed tuple over-asks instead of throwing while the pop-up renders.
 */
export function agenticDcaBnbSlots(maxOrders: number): number {
  const n = Number.isInteger(maxOrders) && maxOrders >= 1 && maxOrders <= 8 ? maxOrders : 8;
  return 2 * n + 4;
}
export function agenticGate(input: { facts: AgenticFacts; wallet?: string; capitalQuoteWei: bigint; maxOpenPositions: number; entryWei: bigint; termSec: number; nowMs: number; budgetWei: bigint;
  quoteDayCapWei?: bigint; schedule?: AgenticScheduleInput; portfolio?: { tokenCount: number }; dca?: { maxOrders: number } }) {
  const f = input.facts;
  const end = Math.min(input.nowMs + input.termSec * 1_000, (f.signInMaxTimeMs ?? 0) - 3_600_000);
  const daily = agenticDecimal(f.dailyLimit), used = agenticDecimal(f.quotaUsed), x402 = agenticDecimal(f.x402DailyLimit);
  const usdt = /^\d+$/.test(f.usdtWei) ? BigInt(f.usdtWei) : -1n, bnb = /^\d+$/.test(f.bnbWei) ? BigInt(f.bnbWei) : -1n;
  const s = input.schedule;
  const counts = s === undefined ? null : agenticScheduleCounts({ ...s, capitalQuoteWei: input.capitalQuoteWei, entryWei: input.entryWei, ttlSec: Math.floor((end - input.nowMs) / 1_000), nowMs: input.nowMs });
  const dailyNeed = (input.quoteDayCapWei ?? input.capitalQuoteWei * 5n) * 2n;
  const usdtNeed = input.capitalQuoteWei + input.budgetWei;
  const bnbNeed = BigInt(input.dca !== undefined ? agenticDcaBnbSlots(input.dca.maxOrders) : input.portfolio !== undefined ? 2 * input.portfolio.tokenCount + 2
    : input.maxOpenPositions + 2 + (counts === null ? 0 : Math.min(counts.plannedBuys, counts.buysThisSession))) * 400_000_000_000_000n;
  const sizingNeed = BigInt(input.maxOpenPositions) * input.entryWei;
  const entryCutoffMs = end - Math.min(7_200_000, (end - input.nowMs) / 2);
  const nowSec = Math.floor(input.nowMs / 1_000);
  const scheduleRows: { code: string; state: "PASS" | "FAIL"; fix: string }[] = s === undefined ? [] : [
    { code: "schedule-first-buy", state: s.firstAtSec === null || (s.firstAtSec >= nowSec - 300 && s.firstAtSec <= Math.min(Math.floor(entryCutoffMs / 1_000), nowSec + 604_800 - 7_200)) ? "PASS" : "FAIL",
      fix: `Choose a first buy within the next 7 days and before ${new Date(entryCutoffMs).toISOString()}.` },
    { code: "schedule-end-date", state: s.endAtSec === null || s.endAtSec * 1_000 > input.nowMs ? "PASS" : "FAIL", fix: "Choose an end date in the future." },
  ];
  const x402Rows: { code: string; state: "PASS" | "FAIL"; fix: string }[] = s !== undefined ? [] : [
    { code: "x402-limit", state: x402 !== null && x402 >= UNIT / 2n ? "PASS" : "FAIL", fix: "Raise x402 Daily limit to 0.50 USDT." },
  ];
  return { hireEndMs: end, entryCutoffMs, rows: [
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
  ] };
}
export function agenticHireSettings(settings: TradeSettings, term: 7 | 30): TradeSettings {
  return { ...settings, cmcNewsEnabled: true, cmcTotalBudgetWei: (BigInt(term === 7 ? 2 : 8) * UNIT).toString() };
}
export async function agenticRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/agentic/" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const envelope = await response.json() as { data?: T; error?: { code?: string }; meta?: { gate?: AgenticGateRow[]; reason?: AgenticHireReason } };
  if (!response.ok || envelope.error || envelope.data === undefined) throw new AgenticRequestError(envelope.error?.code ?? "agentic_unavailable", envelope.meta?.gate, envelope.meta?.reason);
  return envelope.data;
}

/** Owner-facing copy of Agentic Auto DCA (AGENTIC-DCA-SPEC R3.10): the Deploy pop-up lines and the public page notes. The Agentic Wallet App has no swap and no limit UI, so no copy tells the owner to sell or cancel there. */
export const AGENTIC_DCA_COPY = {
  keepAlive: "CMC x402 keep-alive is required and locked on. Keep the x402 daily limit at 0.50 USDT or more: below it the agent stops trading until you raise it.",
  orders: (resting: 1 | 2): string => `The agent watches the pool price itself and trades with Binance market orders from your Agentic Wallet: the base order buys at once, then it watches one take-profit price and ${resting} buy level(s), and buys or sells at market when the price reaches them.`,
  stops: "Stop loss and term end stop the agent; nothing is sold. Your stock and USDT stay in the Agentic Wallet. The keep-alive pays one 0.01 USDT data call after 12 hours without a trade.",
  signOut: "To stop the agent, sign 4lpha out in the Binance App. Nothing waits at Binance: after that no order is placed.",
  fills: "Fills need 4lpha's worker running: a price touch that reverses within about a minute can be missed, and each fill is a market order that can execute up to 0.5 % worse than its quote.",
  stopLoss: "Stopped by stop loss: nothing was sold. Your stock and USDT stay in your Agentic Wallet.",
  termEnd: "Term ended: nothing was sold and your holdings stay in your Agentic Wallet.",
  ownerEnd: "Ended: you signed 4lpha out in the Binance App. 4lpha places no more orders; your holdings stay in your Agentic Wallet.",
  held: (n: number): string => `${n} order(s) are held for review; the agent places nothing new until an operator resolves them.`,
  settingUp: (resting: 1 | 2): string => `Setting up: the base order buys at market, then the agent watches the take profit and ${resting} buy level(s).`,
  keepAlivePanel: "Paid from a fixed USDT budget. After 12 hours without an order the agent makes one 0.01 USDT data call, only to keep the Binance session active. The agent never trades on that data.",
} as const;

type AgenticDcaOrderDto = { state: string; usdtWei: string; stockWei: string; priceE8?: string | null; txHash?: string | null; closedBy?: TradeDcaOrderView["closedBy"] };
type DcaRound = NonNullable<TradeDcaView["round"]>;
/**
 * The public wallet endpoint's `agent.dca` block (AGENTIC-DCA-SPEC 3.16). Prices are raw-unit USDT x 1e8. The keys the Altana view already
 * treats as optional, and the Agentic-only ones, may be absent: the adapter never throws over one.
 */
export type AgenticDcaDto = {
  token: string; symbol: string; fee: number; usdtIsToken0: boolean; mark?: TradeDcaView["mark"]; settings: TradeDcaView["settings"];
  round: null | { roundNo: number; phase: DcaRound["phase"]; closeCause?: string | null; openedAt: number; p0E8?: string | null; avgCostE8?: string | null; tpTargetE8?: string | null;
    costUsdtWei: string; stockHeldWei: string; realizedPnlWei?: string | null;
    levels?: readonly (AgenticDcaOrderDto & { levelNo: number; levelPriceE8?: string | null; state: DcaRound["levels"][number]["state"] })[];
    tp?: null | (AgenticDcaOrderDto & { priceE8: string }); base?: DcaRound["base"] };
  rounds: { settled: number; realizedPnlWei: string; lastSettledAt?: number | null; markedPnlWei?: string;
    history?: readonly { roundNo: number; closeCause?: string | null; openedAt: number; settledAt?: number | null; filledLevels: number; realizedPnlWei?: string | null; markedPnlWei?: string | null }[] };
  equity?: TradeDcaView["equity"]; wallet?: TradeDcaView["wallet"]; walletReason?: string | null; reason?: string | null; history?: TradeDcaView["history"]; actions?: TradeDcaView["actions"];
  heldOrders?: number; keepAlive?: TradeDcaView["keepAlive"];
};
/** The shape the public page needs before it hands a block to the adapter; anything else shows "unavailable". */
export function isAgenticDcaDto(value: unknown): value is AgenticDcaDto {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  return record(value) && typeof value["token"] === "string" && typeof value["symbol"] === "string" && typeof value["fee"] === "number" && typeof value["usdtIsToken0"] === "boolean"
    && record(value["settings"]) && record(value["rounds"]) && (value["round"] === null || record(value["round"]));
}
/**
 * The Altana DCA view as the shared DcaDetail reads it, from the Agentic public block. The NFPM-only fields are filled with their inert values
 * (never displayed under readOnly); a trigger has one price, so it stands for the order's edge and for the take profit's range (R2.10). The plane's reasons
 * `mark-unavailable` and `wallet-unreadable` both read as the existing `chain-unreadable` copy (R3.10, R31.3).
 */
export function agenticDcaView(dto: AgenticDcaDto): TradeDcaView {
  const order = (o: AgenticDcaOrderDto) => ({ tokenId: null, tickLower: 0, tickUpper: 0, closedBy: o.closedBy ?? null, usdtWei: o.usdtWei, stockWei: o.stockWei, txHash: o.txHash ?? null,
    edgePriceE8: o.priceE8 ?? null });
  const r = dto.round;
  const round: TradeDcaView["round"] = r === null ? null : { roundNo: r.roundNo, phase: r.phase, closeCause: r.closeCause ?? null, openedAt: r.openedAt, unreliable: false, p0E8: r.p0E8 ?? null,
    avgCostE8: r.avgCostE8 ?? null, tpTargetE8: r.tpTargetE8 ?? null, costUsdtWei: r.costUsdtWei, stockHeldWei: r.stockHeldWei, realizedPnlWei: r.realizedPnlWei ?? null,
    levels: (r.levels ?? []).map((level) => ({ ...order(level), levelNo: level.levelNo, levelPriceE8: level.levelPriceE8 ?? null, state: level.state })),
    tp: r.tp == null ? null : { ...order(r.tp), state: r.tp.state, rangeLowE8: r.tp.priceE8, rangeHighE8: r.tp.priceE8 },
    ...(r.base === undefined ? {} : { base: r.base }) };
  return { token: dto.token, symbol: dto.symbol, fee: dto.fee, usdtIsToken0: dto.usdtIsToken0, ...(dto.mark === undefined ? {} : { mark: dto.mark }), settings: dto.settings, round,
    rounds: { settled: dto.rounds.settled, realizedPnlWei: dto.rounds.realizedPnlWei, lastSettledAt: dto.rounds.lastSettledAt ?? null,
      ...(dto.rounds.markedPnlWei === undefined ? {} : { markedPnlWei: dto.rounds.markedPnlWei }),
      ...(dto.rounds.history === undefined ? {} : { history: dto.rounds.history.map((row) => ({ roundNo: row.roundNo, closeCause: row.closeCause ?? null, openedAt: row.openedAt, settledAt: row.settledAt ?? null,
        filledLevels: row.filledLevels, realizedPnlWei: row.realizedPnlWei ?? null, unreliable: false, ...(row.markedPnlWei === undefined ? {} : { markedPnlWei: row.markedPnlWei }) })) }) },
    equity: dto.equity ?? null, wallet: dto.wallet ?? null, reason: dto.reason === "mark-unavailable" || dto.reason == null && dto.walletReason === "wallet-unreadable" ? "chain-unreadable" : dto.reason ?? null, inFlight: null, unknownAction: null,
    ...(dto.history === undefined ? {} : { history: dto.history }), ...(dto.actions === undefined ? {} : { actions: dto.actions }),
    ...(dto.heldOrders === undefined ? {} : { heldOrders: dto.heldOrders }), ...(dto.keepAlive === undefined ? {} : { keepAlive: dto.keepAlive }) };
}
