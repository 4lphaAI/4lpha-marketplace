/**
 * Mode fixtures for the agent_status tests. Portfolio is the real public view of a live Smart Portfolio hire (events, runs and the CMC log
 * removed, 2026-10-07). Schedule and DCA are built field by field from `scheduleView` and `agenticDcaPublicView` in `src/agentic/publicView.ts`,
 * each with probe fields the allowlist must drop.
 */
import realPortfolioAgent from "./fixtures/portfolio-agent.real.json";

const E = 10n ** 18n;
const HASH = `0x${"b".repeat(64)}`;
const NOW = 1_900_000_000_000;
export const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

export const LEAK_PROBES = { events: [{ stage: "buy", code: "committed", reason: "LLM reasoning leak" }], runs: [{ id: "run-id-leak", events: [] }], cmcLog: { news: [{ requestReason: "cmc leak" }] } };

export const portfolioAgent = (): Record<string, unknown> => ({ ...structuredClone(realPortfolioAgent) as Record<string, unknown>, ...LEAK_PROBES });

/** Every 0x...64-hex string in a value: the transaction hashes and the opaque ids a public MCP answer must never carry. */
export function hashesIn(value: unknown): string[] {
  return JSON.stringify(value).match(/0x[0-9a-fA-F]{64}/gu) ?? [];
}

const common = { holdCode: null, endReason: null, termDays: 7, termEndAction: "keep", hireStartedAtMs: NOW, entryCutoffAtMs: NOW + 597_600_000, hireEndsAtMs: NOW + 604_800_000, connection: "connected", lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false,
  limits: { quotaLeft: "1", dailyLimit: 1, secret: "limits leak" }, cmc: { remainingWei: "1" }, pinned: [{ address: NVDAB, symbol: "NVDAB" }], ...LEAK_PROBES, erc8004Identity: { status: "registered", agentId: "7", publicRef: "public-ref-leak" } };

export const scheduleAgent = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Public Schedule", status: "running", ...common,
  settings: { executionModel: "tradfi", primaryModel: "model-leak", capitalQuoteWei: (175n * E).toString(), entryWei: (25n * E).toString(), minEntryWei: "1", maxOpenPositions: 1, slippageBps: 100, stopLossBps: null, takeProfitBps: null, maxHoldSec: null },
  summary: { openPositions: 0, maxOpenPositions: 1, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: null, grossComplete: true },
  positions: [{ ref: "p0", symbol: "SCHEDPOSITION", entryTxHash: HASH }],
  schedule: {
    token: NVDAB, symbol: "NVDAB", decimals: 18, amountWei: (25n * E).toString(), intervalSec: 86_400, anchorMs: NOW, nextDueAtMs: NOW + 86_400_000, currentSlot: 2, currentSlotTaken: true,
    fills: 3, postponed: 0, plannedBuys: 7, buysThisSession: 7, spentWei: (75n * E).toString(), remainingWei: (100n * E).toString(), finished: null, endKind: "budget", endAtSec: null, endRuns: null,
    marketHoursOnly: true, maxPremiumBps: 150, firstAtSec: null, premiumBps: 35, premiumLimitBps: 150, nativeCapWei: null, nativeSpentWei: null, nativeBalanceWei: "4000000000000000", nativeBuysRefused: null,
    sessionExpiresAtSec: 1_900_604_800,
    holding: { walletBalance: "350000000000000000", boughtAtomic: "350000000000000000", verifiedSpentWei: (75n * E).toString(), verifiedFills: 3, quoteWei: (765n * E / 10n).toString(), quoteReason: null, internalId: "holding-id-leak" },
    internalId: "schedule-id-leak" },
  ...patch });

const level = (levelNo: number, state: string, e8: string, stockWei = "0") => ({ levelNo, levelPriceE8: e8, state, priceE8: e8, usdtWei: (10n * E).toString(), stockWei, txHash: state === "filled" ? HASH : null, closedBy: null });

export const dcaView = (patch: Record<string, unknown> = {}, round: Record<string, unknown> | null = {}): Record<string, unknown> => ({
  token: NVDAB, symbol: "NVDAB", fee: 2500, usdtIsToken0: false, mark: { e8: "22300000000", block: "100" },
  settings: { stepBps: 100, takeProfitBps: 150, baseWei: (25n * E).toString(), orderWei: (10n * E).toString(), maxOrders: 4, triggerE8: null, rangeMinE8: null, rangeMaxE8: null, stopLossBps: 1500 },
  round: round === null ? null : { roundNo: 2, phase: "active", closeCause: null, openedAt: NOW, p0E8: "22337000000", avgCostE8: "22400000000", tpTargetE8: "22736000000", costUsdtWei: (35n * E).toString(),
    stockHeldWei: (E / 10n).toString(), realizedPnlWei: null,
    levels: [level(1, "filled", "22113630000", (E / 50n).toString()), level(2, "resting", "21900000000"), level(3, "cancelled", "21700000000"), level(4, "held", "21500000000")],
    tp: { state: "resting", priceE8: "22736000000", usdtWei: "0", stockWei: (E / 10n).toString(), txHash: HASH, closedBy: null },
    base: { usdtWei: (25n * E).toString(), stockWei: (E / 10n).toString(), txHash: HASH, atMs: NOW }, ...round },
  rounds: { settled: 1, realizedPnlWei: E.toString(), markedPnlWei: E.toString(), lastSettledAt: NOW, history: [{ roundNo: 1, filledLevels: 1, realizedPnlWei: E.toString() }] },
  equity: { equityWei: (60n * E).toString(), baselineWei: (65n * E).toString(), stopAtWei: (55n * E).toString(), markE8: "22300000000", readingBlock: "100" },
  wallet: { usdtWei: (20n * E).toString(), stockWei: "1" }, walletReason: null, reason: null, heldOrders: 1,
  history: { fills: [{ atMs: NOW, roundNo: 2, kind: "base", txHash: HASH }] }, actions: [{ kind: "start", txHash: HASH }],
  keepAlive: { lastActivityAtMs: NOW, dueAtMs: NOW + 43_200_000, lastPaidAtMs: null }, ...patch });

export const dcaAgent = (block: unknown = dcaView()): Record<string, unknown> => ({
  name: "Public DCA", status: "running", ...common,
  settings: { executionModel: "tradfi", primaryModel: "model-leak", capitalQuoteWei: (65n * E).toString(), entryWei: (25n * E).toString(), minEntryWei: "1", maxOpenPositions: 1, slippageBps: 100, stopLossBps: null, takeProfitBps: null, maxHoldSec: null },
  summary: { openPositions: 0, maxOpenPositions: 1, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: null, grossComplete: true }, positions: [],
  dca: block });

export const earnView = () => ({ products: [{ protocol: "venus", valueWei: "1", selfRescue: "baw defi redeem secret-command" }], totalWei: (12345n * E / 100n).toString(), liquidWei: (5n * E).toString(), earnedWei: (E / 4n).toString(), rates: { venus: 500 },
  activity: [{ txHash: HASH }], lastDeposit: { txHash: HASH }, open: null, withdrawingBeforeSignOut: false });
