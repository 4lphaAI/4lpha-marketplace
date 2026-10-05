/** Offline fixtures for the Agentic Smart Portfolio tests: a portfolio tuple and a bound portfolio hire over the Agentic Schedule fixture's memory stores and fake Binance runner. */
import { type TestContext } from "node:test";
import { keccak256, stringToBytes, type Address } from "viem";
import type { TradeSettings } from "../../src/trade/settings.js";
import type { AgenticHireFacts, AgenticWallet } from "../../src/agentic/domain.js";
import { createAgenticCmc } from "../../src/agentic/cmc.js";
import { executeAgenticTrade } from "../../src/agentic/execute.js";
import { agenticAddress, agenticUiString } from "../../src/agentic/domain.js";
import { CMC_CONFIG_ID, CMC_PAYEE, CMC_PRICE_ATOMIC, CMC_SIGNER, CMC_SPENDER } from "../../src/trade/cmc.js";
import type { CmcTransport } from "../../src/trade/cmcPayment.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import type { TradeWorkerDeps } from "../../src/trade/worker.js";
import { E, NOW, W, aiParams, fixture, type Fixture } from "./agenticSchedule.js";

export const SPYB = agenticAddress("0x7138b48df7d98d7e3cc221bfe7192d0a178182d8"), QQQB = agenticAddress("0x205812cdbed920aff76c6580abd681a46d11efc7");
const { cmcTotalBudgetWei: _budget, ...aiWithoutBudget } = aiParams;
/** The Smart Portfolio tuple the Deploy form sends: two stocks 50/50, drift 0.5 %, 4 h, capital 50 USDT. */
export const portfolioParams: TradeSettings = { ...aiWithoutBudget, name: "Agentic portfolio", minEntryWei: (E / 10n).toString(), entryWei: (50n * E).toString(),
  capitalQuoteWei: (50n * E).toString(), maxOpenPositions: 1, crashProtection: false, cmcNewsEnabled: false, tradeMode: "portfolio",
  portfolioTokens: [SPYB, QQQB], portfolioWeightsBps: [5_000, 5_000], portfolioDriftBps: 50, portfolioIntervalSec: 14_400 };

const STOCKS = [SPYB, QQQB, agenticAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436"), agenticAddress("0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1"), agenticAddress("0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec")];
/** The same tuple over the first N stocks with equal weights and the smallest legal capital (50 USDT + 25 per extra stock). */
export function portfolioParamsFor(count: 2 | 3 | 4 | 5): TradeSettings {
  const weights = count === 3 ? [3_400, 3_300, 3_300] : Array.from({ length: count }, () => 10_000 / count);
  const capital = (50n + 25n * BigInt(count - 2)) * E;
  return { ...portfolioParams, capitalQuoteWei: capital.toString(), entryWei: capital.toString(), portfolioTokens: STOCKS.slice(0, count), portfolioWeightsBps: weights };
}

export function portfolioHireFacts(settings: TradeSettings = portfolioParams, term: 7 | 30 = 7): AgenticHireFacts {
  const budget = term === 7 ? 2n * E / 10n : 8n * E / 10n, capital = BigInt(settings.capitalQuoteWei!), days = BigInt(term);
  return { acceptedAtMs: NOW, acceptedDedicatedWalletAtMs: NOW, termSec: term * 86_400, termEndAction: "keep", hireEndMs: NOW + Number(days) * 86_400_000,
    entryCutoffMs: NOW + Number(days) * 86_400_000 - 7_200_000, signInMaxTimeMs: NOW + 90 * 86_400_000, pinned: (settings.portfolioTokens ?? []).map(agenticAddress),
    quoteDayCapWei: (capital * 5n).toString(), budgetWei: budget.toString(),
    hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: settings.capitalQuoteWei!, entryWei: settings.entryWei,
      minEntryWei: settings.minEntryWei!, quotePerTradeWei: settings.entryWei, cmcNewsEnabled: true, cmcTotalBudgetWei: budget.toString() } };
}

/** A bound portfolio hire (the Agentic Schedule fixture with the portfolio tuple and the facts a real portfolio hire stores). */
export function portfolioFixture(t: TestContext, initial: Partial<AgenticWallet> = {}, sharedDeps?: (now: () => number) => Partial<TradeWorkerDeps>, settings: TradeSettings = portfolioParams): Promise<Fixture> {
  return fixture(t, { hireFacts: portfolioHireFacts(settings), ...initial }, settings, sharedDeps);
}

let sequence = 0;
/** One executor call over a fixture's projected session. The first pinned token is the default; every call gets its own decision and idempotency key. */
export async function runTrade(f: Fixture, patch: { side: "buy" | "sell"; token?: Address; amountWei?: bigint; minOutWei?: bigint; quotedOutWei?: bigint; replay?: number; execution?: Parameters<typeof executeAgenticTrade>[1] }) {
  sequence += 1;
  const id = patch.replay ?? sequence, key = keccak256(stringToBytes("portfolio-test-" + id)), amountWei = patch.amountWei ?? 5n * E;
  const input = { agent: { ...f.agent, sessionFacts: f.projected() }, idempotencyKey: key, paramsHash: key,
    request: { decisionId: "decision-" + id, venue: "pancake" as const, side: patch.side, token: patch.token ?? f.row.hireFacts!.pinned[0]!, amountWei,
      minOutWei: patch.minOutWei ?? amountWei * 99n / 100n, quotedOutWei: patch.quotedOutWei ?? amountWei, settlementAsset: "USDT" as const, platformFeeAtomic: 0n, route: { hops: [], fees: [] } },
    scanGate: { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) }, deps: f.executorDeps };
  return executeAgenticTrade(input as unknown as Parameters<typeof executeAgenticTrade>[0], patch.execution ?? f.execution);
}
export const lastSequence = (): number => sequence;

/** A wallet holding `held` raw of a bStock that Binance reports as `ui` (default floor(held x multiplier)), a quote that always clears the minimum and a swap that never answers (no list wait). */
export function sellWorld(f: Fixture, token: Address, held: bigint, multiplier = "1", ui?: string): void {
  const [whole, fraction = ""] = multiplier.split("."), scale = 10n ** BigInt(fraction.length);
  const shown = ui ?? agenticUiString(held * BigInt(whole + fraction) / scale);
  f.chain.balance = async (_wallet, asset) => asset === null ? f.balances.native : asset.toLowerCase() === token.toLowerCase() ? held : f.balances.usdt;
  f.runner.replies.set("wallet balance", { kind: "ok", sessionPresent: true,
    data: [{ symbol: "STOCK", address: token, binanceChainId: "56", balance: shown, price: "1", value: "1" }],
    rwaTokens: { updatedAt: NOW, tokens: [{ chainId: "56", contractAddress: token, multiplier, kind: "bstock" }] } });
  f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "STOCK", fromCoinAmount: "1", toCoinSymbol: "USDT", toCoinAmount: "1000", slippage: "0" } });
  f.runner.replies.set("market-order swap", { kind: "no-response", code: "no-response", sessionPresent: true });
}

/** A CMC runtime over the fixture with a transport that answers the x402 challenge and counts what it saw: `paid` counts requests that carried a payment header. */
export async function payingCmc(f: Fixture, extra: { gateRunId?: string } = {}) {
  const seen = { challenges: 0, paid: 0 };
  const transport: CmcTransport = { async request(request) {
    if (request.headers === undefined) {
      seen.challenges += 1;
      const body = JSON.parse(request.body) as { params: { name: string } };
      const challenge = { x402Version: 2, resource: { url: "X402_" + body.params.name }, accepts: [{ scheme: "exact", network: "eip155:56", asset: USDT_56,
        amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE, maxTimeoutSeconds: 500,
        extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER, x402PaymentConfigId: CMC_CONFIG_ID } }] };
      return { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") }, body: "" };
    }
    seen.paid += 1; return { status: 200, headers: {}, body: JSON.stringify({ result: { content: [] } }) };
  } };
  // The setup the hire's cmc-initialized stage performs (the fixture only creates the budget row and its capability).
  const budget = (await f.cmcStore.get(f.agent.id, W))!;
  await f.cmcStore.setSetup({ agentId: f.agent.id, ownerAddress: W, wallet: W, generation: budget.generation, sessionPublicKey: f.projected().publicKey,
    sessionExpiry: Math.floor(f.row.hireEndMs! / 1_000), allowanceWei: budget.authorizedTotalWei });
  const cmc = createAgenticCmc({ ...f.execution, agents: f.agents, settings: f.settings, cmc: f.cmcStore, journal: f.journal, killswitch: f.killswitch,
    rpcUrls: ["offline://1", "offline://2", "offline://3"], transport, ...extra });
  return { cmc, seen };
}
