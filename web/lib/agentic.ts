import { scheduleBuysThisSession, type TradeDcaOrderView, type TradeDcaView, type TradeSettings } from "./trade";

export const agenticEnabled = process.env.NEXT_PUBLIC_AGENTIC_WALLET_ENABLED === "true";
/** Agentic Auto DCA (build time, off by default): the DCA tile badge and the DCA case of the custody branch. */
export const agenticDcaEnabled = process.env.NEXT_PUBLIC_AGENTIC_DCA_ENABLED === "true";
/** Agentic meme stocks, paper mode (AGENTIC-MEME-STOCKS-SPEC 9.4; build time, off by default): the "Meme stocks (paper)" choice of AI Trade with Agentic custody. */
export const agenticMemeEnabled = process.env.NEXT_PUBLIC_AGENTIC_MEME_ENABLED === "true";
/** Agentic Earn on idle USDT (AGENTIC-EARN-SPEC 3.15; build time, off by default): the Deploy opt-in and the Earning tile. */
export const agenticEarnEnabled = process.env.NEXT_PUBLIC_AGENTIC_EARN_ENABLED === "true";
/** The mirror of the plane's two Earn products (earnAdapter.ts); the investment ids are the plane's P1 values (measured at E0 2026-10-06); with none configured the opt-in is never offered. */
export const AGENTIC_EARN_PRODUCTS: readonly { protocol: "venus" | "aave-v3"; label: string; investmentId: string | null }[] = [
  { protocol: "venus", label: "Venus", investmentId: "5b77bfd8d8f7c18e9ee0d8f331c4d78f56744eed8addbe2e9970c0ef37e763cb" },
  { protocol: "aave-v3", label: "Aave v3", investmentId: "9e901e308ea48144dcce3d77f22be8fbc0dbeef09167174a5a5dbb3b05c6a5e8" }];
const UNIT = 10n ** 18n;
export type AgenticFacts = { readAtMs: number; status: string; tradeAllTokens: boolean; abnormalTxnHandling: string;
  dailyLimit: number; quotaUsed: number; x402DailyLimit: number; x402QuotaUsed: number; signInMaxTimeMs: number | null; usdtWei: string; bnbWei: string; balancesAtMs?: number };
export type AgenticPairing = { state: string; walletAddress: string | null; codeAttemptsLeft: number; facts: AgenticFacts | null;
  continuationDeadlineMs: number | null; failure: string | null };
export type AgenticGateRow = { code: string; state: "PASS" | "FAIL" | "WARN"; fix: string };
export type AgenticHireReason = "gate-rows" | "sizing" | "pin-unavailable" | "pinned-empty" | "pin-error" | "settings-unreadable" | "wallet-busy" | "pending-orders" | "limit-orders"
  | "schedule-token-not-granted" | "schedule-token-unquotable" | "schedule-capability-incomplete" | "schedule-first-buy-past" | "schedule-end-past"
  | "portfolio-disabled" | "portfolio-token-unsupported" | "portfolio-token-unquotable" | "portfolio-capability-incomplete"
  | "dca-disabled" | "dca-token-unsupported" | "dca-capability-incomplete" | "dca-pool-mismatch" | "dca-token-unquotable"
  | "earn-unavailable" | "earn-wallet-has-supply";
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
  "earn-unavailable": "Hire refused: Earn on idle USDT is not available right now. Deploy without it, or try again later.",
  "earn-wallet-has-supply": "Hire refused: this wallet already supplies USDT to Venus or Aave. Withdraw it first, or deploy without Earn.",
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
  quoteDayCapWei?: bigint; schedule?: AgenticScheduleInput; portfolio?: { tokenCount: number }; dca?: { maxOrders: number }; meme?: "paper"; earn?: true }) {
  const f = input.facts;
  const end = Math.min(input.nowMs + input.termSec * 1_000, (f.signInMaxTimeMs ?? 0) - 3_600_000);
  const daily = agenticDecimal(f.dailyLimit), used = agenticDecimal(f.quotaUsed), x402 = agenticDecimal(f.x402DailyLimit);
  const usdt = /^\d+$/.test(f.usdtWei) ? BigInt(f.usdtWei) : -1n, bnb = /^\d+$/.test(f.bnbWei) ? BigInt(f.bnbWei) : -1n;
  const s = input.schedule;
  const counts = s === undefined ? null : agenticScheduleCounts({ ...s, capitalQuoteWei: input.capitalQuoteWei, entryWei: input.entryWei, ttlSec: Math.floor((end - input.nowMs) / 1_000), nowMs: input.nowMs });
  const dailyNeed = (input.quoteDayCapWei ?? input.capitalQuoteWei * 5n) * 2n;
  const usdtNeed = input.capitalQuoteWei + input.budgetWei;
  const bnbNeed = BigInt(input.dca !== undefined ? agenticDcaBnbSlots(input.dca.maxOrders) : input.portfolio !== undefined ? 2 * input.portfolio.tokenCount + 2
    : input.maxOpenPositions + 2 + (counts === null ? 0 : Math.min(counts.plannedBuys, counts.buysThisSession))) * 400_000_000_000_000n
    + (input.earn === true ? 800_000_000_000_000n : 0n);
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
  // The plane's paper meme gate (AGENTIC-MEME-STOCKS-SPEC 9.1, review R2-H2): four rows, Trade all tokens a WARN, no USDT, BNB or x402 row.
  if (input.meme !== "paper") return { hireEndMs: end, entryCutoffMs, rows };
  return { hireEndMs: end, entryCutoffMs, rows: rows.filter(r => ["status", "trade-all-tokens", "sign-in-time", "sizing"].includes(r.code)).map(r => r.code !== "trade-all-tokens" ? r
    : { code: r.code, state: f.tradeAllTokens === true ? "PASS" as const : "WARN" as const, fix: "Not needed for paper trading. A live agent will need Trade all tokens." }) };
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

/** Earn needs a configured product, and a lane that may opt in: AI Trade (not the paper meme strategy), Schedule, and Auto DCA with at least 5 levels (never Smart Portfolio). */
export function agenticEarnOffered(input: { tradeMode: string | undefined; dcaMaxOrders?: number | null | undefined; meme?: boolean }, enabled: boolean = agenticEarnEnabled, products: readonly { investmentId: string | null }[] = AGENTIC_EARN_PRODUCTS): boolean {
  if (!enabled || input.meme === true || !products.some(p => p.investmentId !== null)) return false;
  if (input.tradeMode === "portfolio") return false;
  return input.tradeMode === "dca" ? (input.dcaMaxOrders ?? 0) >= 5 : true;
}
/** The first Earn decision for the settings on screen, by the lane's own rule (AGENTIC-EARN-SPEC 3.5 and rule 15 at the start of a hire, funded with exactly the
 *  capital): it keeps `keepWei` liquid (AI: two entries; Schedule: the next day of buys + 2; DCA: the base + 3 levels) and lends min(60 % of capital, capital - keep)
 *  when that is at least 20 USDT, else nothing. `minCapitalWei` is the smallest capital that lends anything (null for DCA, where levels and order size decide). */
export function agenticEarnEstimate(i: { mode: "ai"; capitalWei: bigint; entryWei: bigint; maxOpenPositions: number }
  | { mode: "schedule"; capitalWei: bigint; entryWei: bigint; intervalSec: number; plannedBuys: number; buysThisSession: number }
  | { mode: "dca"; capitalWei: bigint; baseWei: bigint; orderWei: bigint; maxOrders: number }): { lendWei: bigint; keepWei: bigint; minCapitalWei: bigint | null } {
  const FLOOR = 20n * 10n ** 18n, MIN_BY_CAP = (FLOOR * 10_000n + 5_999n) / 6_000n;
  const lend = (keep: bigint): bigint => { const room = i.capitalWei - keep, cap = i.capitalWei * 6_000n / 10_000n, value = room < cap ? room : cap; return value >= FLOOR ? value : 0n; };
  const atLeast = (keep: bigint): bigint => keep + FLOOR > MIN_BY_CAP ? keep + FLOOR : MIN_BY_CAP;
  if (i.mode === "ai") { const keep = i.entryWei * BigInt(Math.min(Math.max(i.maxOpenPositions, 0), 2)); return { lendWei: lend(keep), keepWei: keep, minCapitalWei: atLeast(keep) }; }
  if (i.mode === "schedule") {
    // Buys left = min(capital / entry, the run or date limit, the session's buys); the run or date limit shows as plannedBuys below capital / entry.
    const perDay = Math.floor(86_400 / i.intervalSec) + 2, byCapital = i.entryWei <= 0n ? 0 : Number(i.capitalWei / i.entryWei);
    const limit = i.plannedBuys < byCapital ? i.plannedBuys : Number.POSITIVE_INFINITY;
    const keep = i.entryWei * BigInt(Math.min(byCapital, limit, i.buysThisSession, perDay));
    return { lendWei: lend(keep), keepWei: keep, minCapitalWei: atLeast(i.entryWei * BigInt(Math.min(perDay, i.buysThisSession, limit))) };
  }
  const keep = i.baseWei + i.orderWei * BigInt(Math.min(i.maxOrders, i.maxOrders >= 4 ? 3 : 2));
  return { lendWei: lend(keep), keepWei: keep, minCapitalWei: null };
}
/** AGENTIC-EARN-SPEC rule 44 and R11.6: the Deploy disclosure (operator 2026-10-06: short and visual; the same facts, the sign-out details folded). */
export const AGENTIC_EARN_COPY = {
  label: "Earn on idle USDT (optional)",
  summary: "Spare USDT earns in Venus or Aave v3 (best rate) until a buy needs it.",
  points: [
    "Up to 60 % of capital, at least 20 USDT.",
    "All of it back 2 hours before the end.",
    "Small BNB fee per move; third-party protocols.",
  ],
  held: { "no-response": "an operation is waiting for confirmation", "receipt-missing": "an operation has no confirmed receipt yet", "chain-verification": "an operation did not match its receipt and is held for review",
    "redeem-delayed": "a withdrawal is delayed by the protocol", other: "an operation is held for review" },
} as const;
/** The public `agent.earn` block (AGENTIC-EARN-SPEC 3.15), read through this guard, never cast. */
export type AgenticEarnDto = { products: { protocol: string; valueWei: string | null; reason: string | null; selfRescue: string | null }[]; totalWei: string | null;
  lastDeposit: null | { protocol: string; amountWei: string | null; atMs: number; txHash: string | null; apyBps: { venus: number | null; "aave-v3": number | null } };
  open: null | { kind: "deposit" | "redeem"; held: boolean; holdReason: string | null }; withdrawingBeforeSignOut: boolean;
  /** The Earn tab's additive fields (a plane without them omits them); read through agenticEarnTabData, never cast. */
  liquidWei?: unknown; rates?: unknown; activity?: unknown };
export function isAgenticEarnDto(value: unknown): value is AgenticEarnDto {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  return record(value) && Array.isArray(value["products"]) && value["products"].every(p => record(p) && typeof p["protocol"] === "string")
    && (value["totalWei"] === null || typeof value["totalWei"] === "string") && (value["lastDeposit"] === null || record(value["lastDeposit"]))
    && (value["open"] === null || record(value["open"])) && typeof value["withdrawingBeforeSignOut"] === "boolean";
}

export type AgenticEarnActivity = { action: "supply" | "withdraw"; protocol: "venus" | "aave-v3"; atMs: number; amountWei: bigint | null; apyBps: number | null; otherApyBps: number | null; reason: string; txHash: string };
/**
 * The Earn tab's new fields, read defensively: a malformed field is treated as unavailable (null or dropped), never thrown over.
 * `liquidWei` is the wallet's USDT from the plane's own chain read; `rates` are the newest APYs the agent read from Binance (not live); `activity` is the newest committed operations, newest first.
 */
export function agenticEarnTabData(earn: AgenticEarnDto): { liquidWei: bigint | null; rates: { venus: number | null; "aave-v3": number | null; atMs: number | null }; activity: AgenticEarnActivity[] } {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const wei = (v: unknown): bigint | null => typeof v === "string" && /^[0-9]+$/u.test(v) ? BigInt(v) : null;
  const bps = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 5_000 ? v : null;
  const protocol = (v: unknown): "venus" | "aave-v3" | null => v === "venus" || v === "aave-v3" ? v : null;
  const r = record(earn.rates) ? earn.rates : {};
  const rows = Array.isArray(earn.activity) ? earn.activity : [];
  return { liquidWei: wei(earn.liquidWei), rates: { venus: bps(r["venus"]), "aave-v3": bps(r["aave-v3"]), atMs: typeof r["atMs"] === "number" && Number.isSafeInteger(r["atMs"]) ? r["atMs"] : null },
    activity: rows.flatMap((row: unknown): AgenticEarnActivity[] => {
      if (!record(row)) return [];
      const p = protocol(row["protocol"]);
      if (p === null || (row["action"] !== "supply" && row["action"] !== "withdraw") || typeof row["atMs"] !== "number" || !Number.isSafeInteger(row["atMs"])
        || typeof row["reason"] !== "string" || typeof row["txHash"] !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(row["txHash"])) return [];
      return [{ action: row["action"], protocol: p, atMs: row["atMs"], amountWei: wei(row["amountWei"]), apyBps: bps(row["apyBps"]), otherApyBps: bps(row["otherApyBps"]), reason: row["reason"], txHash: row["txHash"] }];
    }) };
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
/** Owner-facing copy of the paper meme hire (AGENTIC-MEME-STOCKS-SPEC 9.4, review R2-M9). */
export const AGENTIC_MEME_COPY = {
  paper: "Paper trading: this agent places no orders and spends nothing. It reads live Binance prices through your Agentic Wallet sign-in and records what it would have bought and sold, after fees, taxes and gas. This agent has no fixed token list. Every 60 seconds it picks from the live list of Flap meme stocks, so you cannot see or limit in advance which tokens it chooses. At term end it closes every paper position. Capital and per-trade amounts are only the paper sizing budget: no USDT and no BNB are needed. While this agent runs, this Binance account cannot run another 4lpha agent. Signing 4lpha out in the Binance App, or signing in anywhere else, ends the agent.",
  law1: "I understand this agent uses my Agentic Wallet sign-in only to read prices, and that this Binance account runs no other 4lpha agent meanwhile.",
  noFunding: "No funding needed: no USDT and no BNB",
  banner: "Paper trading (no real orders)",
  noTokenList: "This agent has no fixed token list. Every 60 seconds it picks from the live list of Flap meme stocks, so you cannot see or limit in advance which tokens it chooses.",
} as const;
/** The paper meme hire's settings (9.1): the form's models, the three sizing inputs, and every other field fixed by the plane's parser (no CMC, no owner exits or text, slippage 500). */
export function agenticMemeSettings(settings: TradeSettings, sizing: { entryWei: bigint; maxOpenPositions: number; capitalQuoteWei: bigint }): TradeSettings {
  const { cmcTotalBudgetWei: _budget, ...rest } = settings;
  return { ...rest, cmcNewsEnabled: false, minEntryWei: (10n * UNIT).toString(), entryWei: sizing.entryWei.toString(), maxOpenPositions: sizing.maxOpenPositions,
    capitalQuoteWei: sizing.capitalQuoteWei.toString(), slippageBps: 500, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, instructions: null, skillMarkdown: null };
}
/** The public `agent.meme` block (9.3), read through this guard, never cast. */
export type AgenticMemeDto = { mode: "paper"; tokens: { address: string; symbol: string | null; quoteSymbol: string | null }[];
  paper: { summary: { open: number; closed: number; wins: number; pnlUsdtWei: string | null; winRateBps: number | null };
    positions: { ref: string; token: string; symbol: string | null; quoteSymbol: string | null; venue: string; status: string; openedAt: number; closedAt: number | null;
      entryUsdtWei: string; exitUsdtWei: string | null; markUsdtWei: string | null; markAtMs: number | null; pnlBps: number | null; closeCode: string | null }[] } };
export function isAgenticMemeDto(value: unknown): value is AgenticMemeDto {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  return record(value) && value["mode"] === "paper" && Array.isArray(value["tokens"]) && record(value["paper"]) && record(value["paper"]["summary"]) && Array.isArray(value["paper"]["positions"]);
}
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
