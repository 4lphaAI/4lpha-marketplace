/** Offline world for the Agentic Earn tests: a bound earn hire (AI, Schedule or DCA) over the Agentic Schedule fixture's memory stores, a fake Binance that answers the six `defi` commands and moves a
 *  chain state the lane reads back (two-RPC earn balances, nonce, receipts). Products are configured through the lane's test seam; production constants stay null. */
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { type TestContext } from "node:test";
import { USDT_56 } from "../../src/trade/settlement.js";
import { DEFAULT_TRADE_SETTINGS, type TradeSettings } from "../../src/trade/settings.js";
import type { AgenticHireFacts, AgenticWallet } from "../../src/agentic/domain.js";
import { agenticAddress, agenticDecimal } from "../../src/agentic/domain.js";
import type { BawResult } from "../../src/agentic/baw.js";
import type { AgenticChain, AgenticReceipt } from "../../src/agentic/resolve.js";
import { runAgenticCycle } from "../../src/agentic/worker.js";
import { runAgenticEarnStep, type AgenticEarnStepDeps } from "../../src/agentic/earnLane.js";
import { EARN_BINANCE_PROTOCOL, EARN_PRODUCTS, type EarnProduct, type EarnProtocol } from "../../src/agentic/earnAdapter.js";
import { E, NOW, W, aiParams, fixture, scheduleParams, TOKEN, type Fixture } from "./agenticSchedule.js";
import { dcaHireFacts, dcaParams, swapReceipt } from "./agenticDca.js";

export const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const USDT = agenticAddress(USDT_56);
export const POOL = "0x4444444444444444444444444444444444444444" as Address;
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const TARGETS: Readonly<Record<EarnProtocol, Address>> = { venus: "0x5555555555555555555555555555555555555555", "aave-v3": "0x6666666666666666666666666666666666666666" };
/** The fail-closed table: both products without an investment id and a preview target (what production shipped before E0). */
export const NULL_PRODUCTS: readonly EarnProduct[] = EARN_PRODUCTS.map(p => ({ ...p, investmentId: null, previewTargets: null }));
export const PRODUCTS: readonly EarnProduct[] = EARN_PRODUCTS.map(p => ({ ...p, investmentId: p.protocol === "venus" ? "venus-usdt" : "aave-usdt", previewTargets: [TARGETS[p.protocol]] }));
export const RECEIPT: Readonly<Record<EarnProtocol, Address>> = { venus: EARN_PRODUCTS[0]!.receiptToken, "aave-v3": EARN_PRODUCTS[1]!.receiptToken };
export const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, "e")}`;

export type EarnState = { usdt: bigint; bnb: bigint; venus: bigint; aave: bigint; nonce: bigint; block: bigint };
type Mode = "ok" | "refuse" | "lost" | "no-hash" | "land-no-hash" | "land-lost" | "client-error" | "service-error";
/** The fake Binance. A landed operation moves the chain state and stores its receipt; `land-lost` lands and then answers nothing. */
export class FakeDefi {
  calls: string[][] = [];
  apy: Readonly<Record<EarnProtocol, number>> = { venus: 302, "aave-v3": 250 };
  list: "ok" | "error" = "ok";
  preview: "ok" | "error" | "foreign" = "ok";
  deposit: Mode = "ok";
  redeem: Mode = "ok";
  delayDays: number[] | undefined;
  /** the deposit credits only this many bps of the amount (a stranding or fee model) */
  creditBps = 10_000n;
  sent = 0;
  receipts = new Map<string, AgenticReceipt>();
  constructor(readonly state: EarnState) {}
  count(command: string): number { return this.calls.filter(c => c.slice(0, 2).join(" ") === command).length; }
  private ok = (data: unknown): BawResult => ({ kind: "ok", data, sessionPresent: true, rwaTokens: null });
  private protocolOf(args: readonly string[]): EarnProtocol { return args[args.indexOf("--investmentId") + 1] === "venus-usdt" ? "venus" : "aave-v3"; }
  private land(protocol: EarnProtocol, deposit: boolean, amount: bigint): Hex {
    const s = this.state, key = protocol === "venus" ? "venus" : "aave", hash = tx(++this.sent);
    s.nonce += 1n; s.bnb -= 40_000_000_000_000n;
    const credit = deposit ? amount * this.creditBps / 10_000n : 0n;
    if (deposit) { s.usdt -= amount; s[key] += credit; } else { s.usdt += amount; s[key] -= amount; }
    this.receipts.set(hash, swapReceipt(hash, deposit ? [[USDT, W, POOL, amount], [RECEIPT[protocol], ZERO, W, credit]] : [[RECEIPT[protocol], W, ZERO, amount], [USDT, POOL, W, amount]]));
    return hash;
  }
  async run(args: readonly string[]): Promise<BawResult> {
    this.calls.push([...args]);
    const command = args.slice(0, 2).join(" "), arg = (name: string): string => args[args.indexOf(name) + 1]!;
    if (command === "wallet settings") return this.ok({ tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 100_000, quotaUsed: 0, x402DailyLimit: 20, x402QuotaUsed: 0,
      signInMaxTime: new Date(NOW + 90 * DAY).toISOString(), sessionExpireTime: null, inactiveSignOutTime: null, defiQuotaLeft: 50_000 });
    if (command === "wallet status") return this.ok({ status: "CONNECTED" });
    if (command === "auth signout") return this.ok({ status: "LOGGED_OUT" });
    if (command === "market-order list" || command === "limit-order list") return this.ok({ total: 0, page: 1, pageSize: 100, list: [] });
    if (command === "defi investment-list") {
      if (this.list === "error") return { kind: "cli-error", code: 1, name: "SERVICE_ERROR", orderId: null, sessionPresent: true };
      const want = args.includes("--defiProtocolId") ? arg("--defiProtocolId") : null;
      return this.ok({ total: 2, list: PRODUCTS.filter(p => want === null || EARN_BINANCE_PROTOCOL[p.protocol] === want).map(p => ({ investmentId: p.investmentId, defiProtocolId: EARN_BINANCE_PROTOCOL[p.protocol], apyBps: this.apy[p.protocol], apyDisplay: `${this.apy[p.protocol] / 100}%` })) });
    }
    if (command === "defi preview") {
      if (this.preview === "error") return { kind: "cli-error", code: 351763, name: "DEFI_TX_SIMULATION_FAILED", orderId: null, sessionPresent: true };
      return this.ok({ balanceChange: [], feeAndContract: { interactWith: { address: this.preview === "foreign" ? "0x7777777777777777777777777777777777777777" : TARGETS[this.protocolOf(args)] } } });
    }
    if (command === "defi deposit" || command === "defi redeem") {
      const deposit = command === "defi deposit", mode = deposit ? this.deposit : this.redeem, protocol = this.protocolOf(args);
      if (mode === "refuse") return { kind: "cli-error", code: 351766, name: "INSUFFICIENT_BALANCE", orderId: null, sessionPresent: true };
      if (mode === "service-error") return { kind: "cli-error", code: 1, name: "SERVICE_ERROR", orderId: null, sessionPresent: true };
      if (mode === "client-error") return { kind: "cli-error", code: 1, name: "INVALID_AMOUNT", orderId: null, sessionPresent: true };
      if (mode === "lost") return { kind: "no-response", code: "timeout", sessionPresent: true };
      if (mode === "no-hash") return this.ok({});
      const value = protocol === "venus" ? this.state.venus : this.state.aave;
      const amount = args.includes("--ratio") ? value : agenticDecimal(arg("--amount"))!;
      const hash = this.land(protocol, deposit, amount);
      if (mode === "land-lost") return { kind: "no-response", code: "timeout", sessionPresent: true };
      if (mode === "land-no-hash") return this.ok({});
      return this.ok({ txHash: hash, ...(this.delayDays === undefined ? {} : { redeemDelayDays: this.delayDays }) });
    }
    return { kind: "cli-error", code: 1, name: "SERVICE_ERROR", orderId: null, sessionPresent: true };
  }
}

export type EarnLane = "ai" | "schedule" | "dca";
export type EarnWorldOptions = { lane?: EarnLane; flag?: boolean; usdt?: bigint; bnb?: bigint; x?: bigint; settings?: Record<string, unknown>; term?: 7 | 30; initial?: Partial<AgenticWallet>; earn?: boolean; products?: readonly EarnProduct[] };
export const hireFacts = (stored: TradeSettings, lane: EarnLane, term: 7 | 30, earn: boolean): AgenticHireFacts => {
  const capital = BigInt(stored.capitalQuoteWei!), end = NOW + term * DAY;
  const base: AgenticHireFacts = lane === "dca" ? dcaHireFacts(stored, term)
    : { acceptedAtMs: NOW, acceptedDedicatedWalletAtMs: NOW, termSec: term * 86_400, termEndAction: "keep", hireEndMs: end, entryCutoffMs: end - 7_200_000, signInMaxTimeMs: NOW + 90 * DAY, pinned: [TOKEN],
      quoteDayCapWei: (lane === "schedule" ? capital : capital * 5n).toString(), budgetWei: lane === "schedule" ? "0" : (2n * E).toString(),
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: stored.capitalQuoteWei!, entryWei: stored.entryWei, minEntryWei: stored.minEntryWei!,
        quotePerTradeWei: stored.entryWei, cmcNewsEnabled: lane !== "schedule", ...(lane === "schedule" ? {} : { cmcTotalBudgetWei: (2n * E).toString() }) } };
  return { ...base, ...(earn ? { earn: { v: 1 as const } } : {}) };
};
export function earnSettings(lane: EarnLane, extra: Record<string, unknown> = {}): TradeSettings {
  const patch = extra as Partial<TradeSettings>;
  if (lane === "dca") return dcaParams({ dcaMaxOrders: 5, ...patch });
  if (lane === "schedule") return { ...scheduleParams, capitalQuoteWei: (100n * E).toString(), entryWei: (10n * E).toString(), minEntryWei: (10n * E).toString(), scheduleIntervalSec: 86_400, scheduleEndKind: "budget", scheduleEndRuns: null, ...patch } as TradeSettings;
  return { ...aiParams, capitalQuoteWei: (100n * E).toString(), entryWei: (20n * E).toString(), minEntryWei: (20n * E).toString(), maxOpenPositions: 5, ...patch } as TradeSettings;
}

export async function earnWorld(t: TestContext, o: EarnWorldOptions = {}) {
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  const lane = o.lane ?? "ai", term = o.term ?? 7, settings = earnSettings(lane, o.settings);
  const state: EarnState = { usdt: o.usdt ?? 100n * E, bnb: o.bnb ?? 5n * 10n ** 15n, venus: 0n, aave: 0n, nonce: 0n, block: 100n };
  const market = new FakeDefi(state);
  const f: Fixture = await fixture(t, { hireFacts: hireFacts(settings, lane, term, o.earn !== false), hireEndMs: NOW + term * DAY, entryCutoffMs: NOW + term * DAY - 7_200_000, ...o.initial }, settings);
  f.runner.run = (async (args: readonly string[]) => market.run(args)) as typeof f.runner.run;
  const chain = f.chain as AgenticChain;
  chain.balance = async (_wallet, token) => token === null ? state.bnb : state.usdt;
  chain.nonce = async () => state.nonce;
  chain.receipt = async hash => market.receipts.get(hash) ?? null;
  const failures = { balances: false, pins: false };
  chain.earnBalances = async () => { if (failures.balances) throw new Error("rpc"); return { block: state.block, usdt: state.usdt, vBalance: state.venus, vRate: E, venusWei: state.venus, aaveWei: state.aave }; };
  chain.earnPins = async () => { if (failures.pins) throw new Error("rpc"); return { venus: true, "aave-v3": true }; };
  let x = o.x ?? (lane === "ai" ? 2n * E : lane === "dca" ? E / 5n : 0n);
  const cmc = { ...f.cmc, protectedExposure: async () => { if (x < 0n) throw new Error("cmc"); return x; } };
  const earnEnabled = o.flag ?? true, products = o.products ?? PRODUCTS;
  const input = { ...f.lifecycle, cmc, earnEnabled, earnProducts: products, dcaEnabled: true } as unknown as Parameters<typeof runAgenticCycle>[0];
  const stepDeps = (extra: Partial<AgenticEarnStepDeps> = {}): AgenticEarnStepDeps => ({ store: f.store, positions: f.positions, runner: f.runner, masterKey: f.execution.masterKey, instance: f.instance, chain,
    worker: f.worker, cmc, earnEnabled, products, killswitch: f.killswitch, ...extra });
  const at = async (ms: number): Promise<void> => { clock = ms; f.setTime(ms); await f.instance.heartbeat(); };
  const advance = (ms: number): Promise<void> => at(clock + ms);
  const wallet = async (): Promise<AgenticWallet> => (await f.store.byAgent(f.agent.id))!;
  const step = async (extra?: Partial<AgenticEarnStepDeps>, options: Parameters<typeof runAgenticEarnStep>[2] = {}): Promise<AgenticWallet> => runAgenticEarnStep(stepDeps(extra), await wallet(), options);
  const tick = async (): Promise<void> => runAgenticCycle(input);
  const rows = async () => (await f.store.orders(W)).filter(o => o.kind === "earn-deposit" || o.kind === "earn-redeem").sort((a, b) => a.createdAt - b.createdAt || a.idempotencyKey.localeCompare(b.idempotencyKey));
  const runs = async () => await f.positions.listRuns(W, f.agent.id, 50);
  const codes = async (): Promise<string[]> => (await runs()).flatMap(r => (r.events ?? []).filter(e => e.stage === "earn").map(e => e.code));
  return { f, input, stepDeps, market, state, failures, at, advance, step, tick, rows, runs, codes, wallet, now: () => clock, settings, products, setX: (v: bigint) => { x = v; }, cmc };
}
export type EarnWorld = Awaited<ReturnType<typeof earnWorld>>;
export const topicOf = (a: string): Hex => ("0x" + a.slice(2).toLowerCase().padStart(64, "0")) as Hex;
export const TRANSFER = keccak256(stringToBytes("Transfer(address,address,uint256)"));
export const APPROVAL = keccak256(stringToBytes("Approval(address,address,uint256)"));
export { E, NOW, W, swapReceipt, DEFAULT_TRADE_SETTINGS };
