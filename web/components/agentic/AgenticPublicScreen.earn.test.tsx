// @vitest-environment happy-dom
/** The Earn tab of the Agentic public pages (AI Trade, Schedule, Auto DCA): it exists only for an earn hire, reads the plane's public Earn block, shows real figures, real activity and the real self-rescue commands. */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";
import { runLabel } from "@/components/trade/TradeRunLog";

vi.mock("wagmi", () => ({ usePublicClient: () => undefined, useAccount: () => ({}) }));
vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div data-testid="market-chart">Chart</div> }));
const NOW = 1_900_000_000_000, W = "0x1111111111111111111111111111111111111111", E = 10n ** 18n, NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", TOKEN = "0x2222222222222222222222222222222222222222";
const HASH = (n: number): string => `0x${n.toString(16).padStart(64, "a")}`;
const VENUS_RESCUE = "baw defi redeem --investmentId 5b77bfd8d8f7c18e9ee0d8f331c4d78f56744eed8addbe2e9970c0ef37e763cb --tokenAddress 0x55d398326f99059fF775485246999027B3197955 --ratio 1";
const AAVE_RESCUE = "baw defi redeem --investmentId 9e901e308ea48144dcce3d77f22be8fbc0dbeef09167174a5a5dbb3b05c6a5e8 --tokenAddress 0x55d398326f99059fF775485246999027B3197955 --ratio 1";
type Patch = Record<string, unknown>;
const w = (n: number): string => (BigInt(n) * E).toString();
const earn = (patch: Patch = {}): Patch => ({
  products: [{ protocol: "venus", valueWei: w(60), reason: null, selfRescue: VENUS_RESCUE }, { protocol: "aave-v3", valueWei: "0", reason: null, selfRescue: AAVE_RESCUE }],
  totalWei: w(60), liquidWei: w(30), rates: { venus: 345, "aave-v3": 306, atMs: NOW }, earnedWei: "1234000000000000",
  lastDeposit: { protocol: "venus", amountWei: w(70), atMs: NOW - 1000, txHash: HASH(1), apyBps: { venus: 345, "aave-v3": 306 } }, open: null, withdrawingBeforeSignOut: false,
  activity: [
    { action: "withdraw", protocol: "venus", atMs: NOW - 1000, amountWei: w(5), apyBps: null, otherApyBps: null, reason: "lane", txHash: HASH(3) },
    { action: "supply", protocol: "venus", atMs: NOW - 2000, amountWei: w(70), apyBps: 345, otherApyBps: 306, reason: "lane", txHash: HASH(2) },
  ], ...patch });
const dca = () => ({ token: NVDAB, symbol: "NVDAB", fee: 2500, usdtIsToken0: false, mark: { e8: "22300000000", block: "100" },
  settings: { stepBps: 100, takeProfitBps: 150, baseWei: w(25), orderWei: w(10), maxOrders: 5, triggerE8: null, rangeMinE8: null, rangeMaxE8: null, stopLossBps: 1500 },
  round: { roundNo: 2, phase: "active", closeCause: null, openedAt: NOW, p0E8: "22337000000", avgCostE8: "22400000000", tpTargetE8: "22736000000", costUsdtWei: w(35), stockHeldWei: (E / 10n).toString(), realizedPnlWei: null,
    levels: [{ levelNo: 1, levelPriceE8: "22113630000", state: "filled", priceE8: "22113630000", usdtWei: w(10), stockWei: (E / 50n).toString(), txHash: HASH(9), closedBy: null }],
    tp: { state: "resting", priceE8: "22736000000", usdtWei: "0", stockWei: (E / 10n).toString(), txHash: null, closedBy: null }, base: { usdtWei: w(25), stockWei: (E / 10n).toString(), txHash: HASH(9), atMs: NOW } },
  rounds: { settled: 0, realizedPnlWei: "0", markedPnlWei: "0", lastSettledAt: null, history: [] },
  equity: { equityWei: w(60), baselineWei: w(65), stopAtWei: w(55), markE8: "22300000000", readingBlock: "100" }, wallet: { usdtWei: w(20), stockWei: "1" }, walletReason: null, reason: null, heldOrders: 0,
  history: { fills: [] }, actions: [], keepAlive: { lastActivityAtMs: NOW, dueAtMs: NOW + 43_200_000, lastPaidAtMs: null } });
const schedule = () => ({ token: TOKEN, symbol: "NVDAB", decimals: 18, amountWei: w(5), intervalSec: 3600, anchorMs: NOW, nextDueAtMs: NOW + 3_600_000, currentSlot: 0, currentSlotTaken: true, fills: 1, postponed: 0, plannedBuys: 2,
  buysThisSession: 166, spentWei: w(5), remainingWei: w(5), finished: null, endKind: "runs", endAtSec: null, endRuns: 2, marketHoursOnly: false, maxPremiumBps: 150, firstAtSec: null, premiumBps: 42, premiumLimitBps: 150,
  nativeCapWei: null, nativeSpentWei: null, nativeBalanceWei: w(1), nativeBuysRefused: null, sessionExpiresAtSec: (NOW + 604_800_000) / 1_000,
  holding: { walletBalance: w(5), boughtAtomic: w(5), verifiedSpentWei: w(5), verifiedFills: 1, quoteWei: "51" + "0".repeat(17), quoteReason: null } });
const base = (patch: Patch = {}) => ({ wallet: W, custody: "binance-agentic", agent: { name: "Public agent", status: "running", holdCode: null, endReason: null, termDays: 7, termEndAction: "keep", hireStartedAtMs: NOW,
  entryCutoffAtMs: NOW + 597_600_000, hireEndsAtMs: NOW + 604_800_000, connection: "connected", lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false,
  settings: { executionModel: "tradfi", primaryModel: "qwen3.7-flash", capitalQuoteWei: w(100), entryWei: w(20), minEntryWei: w(5), maxOpenPositions: 5, slippageBps: 100, stopLossBps: null, takeProfitBps: null, maxHoldSec: null },
  cmc: { authorizedTotalWei: "0", settledWei: "0", remainingWei: "0", status: "disabled" }, summary: { openPositions: 0, maxOpenPositions: 5, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: "0", grossComplete: true },
  positions: [], runs: [{ id: "0123456789abcdef", dryRun: false, reason: "agentic-earn", candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: NOW, events: [{ stage: "earn", code: "earn-deposited", elapsedMs: 0 }] }],
  pinned: [], ...patch } });
const lane = { ai: (earnBlock?: unknown) => base(earnBlock === undefined ? {} : { earn: earnBlock }), schedule: (earnBlock?: unknown) => base({ schedule: schedule(), ...(earnBlock === undefined ? {} : { earn: earnBlock }) }),
  dca: (earnBlock?: unknown) => base({ dca: dca(), ...(earnBlock === undefined ? {} : { earn: earnBlock }) }) };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(data: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} }) : Response.json({ data })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgenticPublicScreen wallet={W} />));
  const click = async (label: string) => act(async () => { ([...host.querySelectorAll("button")].find(b => b.textContent === label) as HTMLElement).click(); });
  const buttons = (): string[] => [...host.querySelectorAll("button")].map(b => b.textContent ?? "");
  return { host, click, buttons, done: async () => { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; } };
}
const text = (host: HTMLElement): string => host.querySelector('[data-testid="earn-tab"]')?.textContent ?? "";

it("AI Trade: the Earn tab sits between Run log and CMC x402, only with an earn block; the old tile above the body is gone", async () => {
  const withEarn = await render(lane.ai(earn()));
  const tabs = [...withEarn.host.querySelectorAll(".fl-trade-tabs button")].map(b => b.textContent);
  expect(tabs).toEqual(["Open Positions", "Closed Positions", "Run log", "Earn", "CMC x402"]);
  expect(withEarn.host.querySelector('[data-testid="earn-tile"]')).toBeNull();
  expect(withEarn.host.querySelector('[data-testid="earn-tab"]')).toBeNull();
  await withEarn.click("Earn");
  expect(withEarn.host.querySelector('[data-testid="earn-tab"]')).not.toBeNull();
  await withEarn.done();
  const without = await render(lane.ai());
  expect([...without.host.querySelectorAll(".fl-trade-tabs button")].map(b => b.textContent)).toEqual(["Open Positions", "Closed Positions", "Run log", "CMC x402"]);
  await without.done();
});

it("shows the real figures: supplied, the wallet it came from, the rate it earns at, the interest earned, the liquid USDT, the bar shares, the best-rate badge and the rate note", async () => {
  const { host, click, done } = await render(lane.ai(earn()));
  await click("Earn");
  const t = text(host);
  expect(t).toContain("Earning on idle USDT");
  expect(t).toContain("60.00 USDT");
  expect(t).toContain("Supplied from 90.00 USDT in the Agentic Wallet");
  expect(t).toContain("3.45% APY");
  expect(t).toContain("On Venus");
  expect(t).toContain("Interest earned"); expect(t).toContain("+0.0012 USDT"); expect(t).toContain("Since the first supply, before gas"); expect(t).not.toContain("Est. per day");
  
  expect(t).toContain("30.00 USDT");
  expect(t).toContain("Ready for the next buys");
  expect(t).toContain("Kept in wallet");
  expect(t).toContain("60.00 USDT · 67%");
  expect(t).toContain("30.00 USDT · 33%");
  expect(t).toContain("Rates from the agent's last Binance read, " + new Date(NOW).toLocaleString());
  const venus = host.querySelector('[data-testid="earn-product-venus"]')!.textContent!, aave = host.querySelector('[data-testid="earn-product-aave-v3"]')!.textContent!;
  expect(venus).toContain("BEST RATE"); expect(venus).toContain("SUPPLYING"); expect(venus).toContain("3.45%"); expect(venus).toContain("100%");
  expect(aave).not.toContain("BEST RATE"); expect(aave).toContain("STANDBY"); expect(aave).toContain("3.06%");
  expect(t).not.toContain(String.fromCharCode(0x2014));
  await done();
});

it("activity: newest first, the reason copy, the amount and rate, the BscScan link; a ratio row without an amount shows a dash with all", async () => {
  const rows = [
    { action: "withdraw", protocol: "venus", atMs: NOW - 1000, amountWei: null, apyBps: null, otherApyBps: null, reason: "lane", txHash: HASH(5) },
    { action: "withdraw", protocol: "aave-v3", atMs: NOW - 2000, amountWei: w(3), apyBps: null, otherApyBps: null, reason: "redeem-all", txHash: HASH(4) },
    { action: "supply", protocol: "aave-v3", atMs: NOW - 3000, amountWei: w(5), apyBps: 306, otherApyBps: null, reason: "gate", txHash: HASH(3) },
    { action: "supply", protocol: "venus", atMs: NOW - 4000, amountWei: w(70), apyBps: 345, otherApyBps: 306, reason: "lane", txHash: HASH(2) },
    { action: "supply", protocol: "venus", atMs: NOW - 5000, amountWei: w(70), apyBps: 345, otherApyBps: null, reason: "lane", txHash: HASH(1) }];
  const { host, click, done } = await render(lane.ai(earn({ activity: rows })));
  await click("Earn");
  const lines = [...host.querySelectorAll('[data-testid="earn-activity-row"]')];
  expect(lines).toHaveLength(5);
  const cells = (i: number): string => lines[i]!.textContent ?? "";
  expect(cells(0)).toContain("Withdraw"); expect(cells(0)).toContain("Venus"); expect(cells(0)).toContain("- (all)"); expect(cells(0)).toContain("Cash for the next buys");
  expect(cells(1)).toContain("Aave v3"); expect(cells(1)).toContain("3.00 USDT"); expect(cells(1)).toContain("Withdrawing before 4lpha signs out");
  expect(cells(2)).toContain("Supply"); expect(cells(2)).toContain("5.00 USDT"); expect(cells(2)).toContain("3.06%"); expect(cells(2)).toContain("Operator test");
  expect(cells(3)).toContain("70.00 USDT"); expect(cells(3)).toContain("3.45%"); expect(cells(3)).toContain("Best rate (Aave v3 3.06%)");
  expect(cells(4)).toContain("Best rate"); expect(cells(4)).not.toContain("Best rate (");
  const link = lines[3]!.querySelector("a")!;
  expect([link.getAttribute("href"), link.getAttribute("target")]).toEqual([`https://bscscan.com/tx/${HASH(2)}`, "_blank"]);
  await done();
});

it("with nothing supplied the best known rate is shown with its note; unknown rates and an unreadable wallet are n/a and dashes with a reason, never numbers", async () => {
  const idle = await render(lane.ai(earn({ totalWei: "0", products: [{ protocol: "venus", valueWei: "0", reason: null, selfRescue: null }, { protocol: "aave-v3", valueWei: "0", reason: null, selfRescue: null }] })));
  await idle.click("Earn");
  expect(text(idle.host)).toContain("3.45% APY"); expect(text(idle.host)).toContain("Nothing supplied right now (best rate: Venus)"); expect(text(idle.host)).toContain("+0.0012 USDT");
  await idle.done();
  const blind = await render(lane.ai(earn({ totalWei: null, liquidWei: null, rates: { venus: null, "aave-v3": null, atMs: null }, activity: [],
    products: [{ protocol: "venus", valueWei: null, reason: "chain-unreadable", selfRescue: null }, { protocol: "aave-v3", valueWei: null, reason: "chain-unreadable", selfRescue: null }] })));
  await blind.click("Earn");
  const t = text(blind.host);
  expect(t).toContain("Supplied amount unavailable: the chain read failed.");
  expect(t).toContain("Wallet balance unavailable"); expect(t).toContain("chain unreadable"); expect(t).toContain("n/a"); expect(t).toContain("No rate known yet");
  expect(t).not.toContain("Rates from the agent"); expect(t).not.toContain("BEST RATE"); expect(t).not.toMatch(/0\.00 USDT/u); expect(t).toContain("No earn activity yet.");
  await blind.done();
  const noRates = await render(lane.ai(earn({ rates: { venus: null, "aave-v3": null, atMs: null } })));
  await noRates.click("Earn");
  expect(text(noRates.host)).toContain("60.00 USDT"); expect(text(noRates.host)).toContain("n/a"); expect(text(noRates.host)).not.toContain("BEST RATE");
  await noRates.done();
});

it("one known rate is used for the estimate but earns no BEST RATE badge (nothing to compare it with)", async () => {
  const { host, click, done } = await render(lane.ai(earn({ rates: { venus: 345, "aave-v3": null, atMs: NOW } })));
  await click("Earn");
  expect(text(host)).toContain("+0.0012 USDT"); expect(text(host)).not.toContain("BEST RATE");
  await done();
});

it("the held and withdrawing banners use the existing copy; the self-rescue shows the plane's real commands and never an invented one", async () => {
  const { host, click, done } = await render(lane.ai(earn({ open: { kind: "redeem", held: true, holdReason: "chain-verification" }, withdrawingBeforeSignOut: true })));
  await click("Earn");
  expect(host.querySelector('[data-testid="earn-held"]')!.textContent).toContain("Held for review: an operation did not match its receipt and is held for review. The agent does nothing else with this wallet until it is resolved.");
  expect(text(host)).toContain("Withdrawing everything before 4lpha signs out.");
  const rescue = host.querySelector('[data-testid="earn-rescue"]')!;
  expect([...rescue.querySelectorAll("code")].map(c => c.textContent)).toEqual([VENUS_RESCUE, AAVE_RESCUE]);
  expect(text(host)).not.toContain("agentic-wallet earn withdraw");
  await done();
  const none = await render(lane.ai(earn({ products: [{ protocol: "venus", valueWei: w(1), reason: null, selfRescue: null }, { protocol: "aave-v3", valueWei: w(1), reason: null, selfRescue: null }] })));
  await none.click("Earn");
  expect(none.host.querySelector('[data-testid="earn-rescue"]')).toBeNull();
  await none.done();
});

it("a malformed block keeps the tab and says unavailable inside it; malformed new fields degrade to unavailable and never throw", async () => {
  const bad = await render(lane.ai({ products: "x" }));
  expect([...bad.host.querySelectorAll(".fl-trade-tabs button")].map(b => b.textContent)).toContain("Earn");
  await bad.click("Earn");
  expect(bad.host.textContent).toContain("Earn data unavailable."); expect(bad.host.querySelector('[data-testid="earn-tab"]')).toBeNull();
  await bad.done();
  const junk = await render(lane.ai(earn({ liquidWei: 30, rates: "fast", activity: [null, "row", { action: "swap" }, { action: "supply", protocol: "venus", atMs: NOW, amountWei: "x", apyBps: 3.4, otherApyBps: "1", reason: "lane", txHash: "0x12" },
    { action: "supply", protocol: "venus", atMs: NOW, amountWei: 5, apyBps: 99_999, otherApyBps: null, reason: "lane", txHash: HASH(8) }] })));
  await junk.click("Earn");
  const t = text(junk.host);
  expect(t).toContain("60.00 USDT"); expect(t).toContain("Wallet balance unavailable"); expect(t).toContain("n/a"); expect(t).not.toContain("Rates from the agent");
  expect(junk.host.querySelectorAll('[data-testid="earn-activity-row"]')).toHaveLength(1);
  expect(junk.host.querySelector('[data-testid="earn-activity-row"]')!.textContent).toContain("- (all)");
  await junk.done();
  const old = await render(lane.ai({ ...earn(), liquidWei: undefined, rates: undefined, activity: undefined }));
  await old.click("Earn");
  expect(text(old.host)).toContain("60.00 USDT"); expect(text(old.host)).toContain("No earn activity yet.");
  await old.done();
});

it("Schedule: the toggle gains Earn only with an earn block (Buys | Run log | Earn), and the tab shows the same data", async () => {
  const withEarn = await render(lane.schedule(earn()));
  expect(withEarn.buttons().filter(label => ["Buys", "Run log", "Earn"].includes(label))).toEqual(["Buys", "Run log", "Earn"]);
  await withEarn.click("Earn");
  expect(text(withEarn.host)).toContain("Supplied from 90.00 USDT in the Agentic Wallet");
  expect(withEarn.host.textContent).not.toContain("Show chart");
  await withEarn.click("Buys");
  expect(withEarn.host.querySelector('[data-testid="earn-tab"]')).toBeNull();
  await withEarn.done();
  const without = await render(lane.schedule());
  expect(without.buttons()).not.toContain("Earn");
  expect(without.buttons().filter(label => ["Buys", "Run log"].includes(label))).toEqual(["Buys", "Run log"]);
  await without.done();
});

it("Auto DCA: Earn is appended to the tab row and the chart button is hidden on it; without an earn block the row is unchanged", async () => {
  const withEarn = await render(lane.dca(earn()));
  const row = (): string[] => [...withEarn.host.querySelectorAll(".fl-trade-tabs button")].map(b => b.textContent ?? "");
  expect(row()).toEqual(["Orders", "Ongoing", "Rounds", "Order history", "Holdings", "Run log", "Earn"]);
  expect(withEarn.buttons()).toContain("Show chart");
  await withEarn.click("Earn");
  expect(withEarn.buttons()).not.toContain("Show chart");
  expect(text(withEarn.host)).toContain("3.45% APY");
  await withEarn.click("Orders");
  expect(withEarn.buttons()).toContain("Show chart");
  expect(withEarn.host.querySelector('[data-testid="earn-tab"]')).toBeNull();
  await withEarn.done();
  const without = await render(lane.dca());
  expect([...without.host.querySelectorAll(".fl-trade-tabs button")].map(b => b.textContent)).toEqual(["Orders", "Ongoing", "Rounds", "Order history", "Holdings", "Run log"]);
  await without.done();
});

it("the run log labels the earn run", () => { expect(runLabel("agentic-earn")).toBe("Earn on idle USDT"); });

it("every Agentic detail page, with or without Earn, starts with the My agents back button, which goes to /account; without go no button is drawn", async () => {
  for (const data of [lane.ai(), lane.ai(earn()), lane.schedule(earn()), lane.dca(), base({ meme: { mode: "paper", tokens: [], paper: { summary: { open: 0, closed: 0, wins: 0, pnlUsdtWei: null, winRateBps: null }, positions: [] } } }),
    { wallet: W, custody: "binance-agentic", agent: null }]) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} }) : Response.json({ data })));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const go = vi.fn(), host = document.createElement("div"), root = createRoot(host);
    await act(async () => root.render(<AgenticPublicScreen wallet={W} go={go} />));
    const first = host.querySelector(".fl-shell")!.firstElementChild as HTMLElement;
    expect(first.tagName).toBe("BUTTON"); expect(first.textContent).toBe("My agents");
    await act(async () => first.click());
    expect(go).toHaveBeenCalledWith("/account");
    await act(async () => root.unmount());
    const bare = document.createElement("div"), bareRoot = createRoot(bare);
    await act(async () => bareRoot.render(<AgenticPublicScreen wallet={W} />));
    expect([...bare.querySelectorAll("button")].map(b => b.textContent)).not.toContain("My agents");
    await act(async () => bareRoot.unmount());
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("interest earned is the plane's figure: 6 decimals while below 0.0001, a minus sign when negative, and a dash with its reason when the plane has none", async () => {
  for (const [earnedWei, shown] of [["5000000000000", "+0.000005 USDT"], ["-100000000000000", "-0.0001 USDT"], ["0", "+0.0000 USDT"]] as const) {
    const { host, click, done } = await render(lane.ai(earn({ earnedWei })));
    await click("Earn");
    expect(text(host)).toContain(shown);
    await done();
  }
  const none = await render(lane.ai(earn({ earnedWei: null })));
  await none.click("Earn");
  expect(text(none.host)).toContain("Earned amount unavailable");
  await none.done();
  const fresh = await render(lane.ai(earn({ earnedWei: null, totalWei: "0", products: [{ protocol: "venus", valueWei: "0", reason: null, selfRescue: null }, { protocol: "aave-v3", valueWei: "0", reason: null, selfRescue: null }] })));
  await fresh.click("Earn");
  expect(text(fresh.host)).toContain("Nothing supplied yet");
  await fresh.done();
});
