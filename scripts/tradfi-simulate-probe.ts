import { pathToFileURL } from "node:url";
import { BNB } from "@altananetwork/sdk";
import { getAddress, parseUnits, type Address, type Hex } from "viem";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { MemoryTradeSimulationStore } from "../src/store/tradeSimulations.js";
import { classifySimulation, createTradfiEvidenceWriter, encodeTradfiSimulateTx, preflightSimulate, tradfiSimulateBudgetMs } from "../src/trade/simulate.js";
import { quoteBestTradfiBuy } from "../src/trade/route.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { buildTradfiApprove, buildTradfiPancakeV2Swap, buildTradfiPancakeV3Swap, buildTradfiUniswapV3Swap } from "../src/ops/tradfi.js";
import { buildTradfiGuardSwapCall, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { WalletCall } from "../src/core/types.js";

export function parseProbeArgs(argv: readonly string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !["--wallet", "--token", "--amount-usdt", "--case", "--guard-delay-ms"].includes(key) || value === undefined || key in values) throw new Error("Invalid probe argument.");
    values[key] = value;
  }
  const wallet = getAddress(values["--wallet"] ?? ""), token = getAddress(values["--token"] ?? "");
  const amount = values["--amount-usdt"] ?? "1";
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/u.test(amount)) throw new Error("Invalid amount.");
  const amountAtomic = parseUnits(amount, 18);
  if (amountAtomic <= 0n || amountAtomic > 25n * 10n ** 18n) throw new Error("Amount must be at most 25 USDT.");
  const probeCase = values["--case"];
  if (probeCase !== "direct" && probeCase !== "impossible-min-out" && probeCase !== "guard" && probeCase !== "guard-deadline") throw new Error("Invalid probe case.");
  const delayMs = Number(values["--guard-delay-ms"] ?? "0");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5_000) throw new Error("Invalid guard delay.");
  return { wallet, token, amountAtomic, probeCase, delayMs };
}

// Diagnostic only: expired bytes must reach the simulator without the production window gate.
export async function probeGuardDeadline(dataPlane: HttpTradeDataPlaneReads, wallet: Address, calls: readonly WalletCall[]) {
  const tx = encodeTradfiSimulateTx(wallet, calls);
  if (tx === null) throw new Error("Diagnostic batch invalid.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([dataPlane.binanceSimulate({ ...tx, signal: controller.signal }), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Diagnostic timeout.")); }, 2_000);
    })]);
    const classification = classifySimulation(result, "guard");
    return { rawFailReason: JSON.stringify(result.failReason), status: result.status, ...classification,
      decision: "PROCEED", upstreamMs: result.upstreamMs };
  } finally { clearTimeout(timer); }
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseProbeArgs(argv);
  const baseUrl = process.env["DATA_PLANE_URL"]?.trim();
  if (!baseUrl) throw new Error("DATA_PLANE_URL is required.");
  const dataPlane = new HttpTradeDataPlaneReads({ baseUrl, token: process.env["DATA_PLANE_TOKEN"]?.trim() ?? "" });
  let calls: readonly WalletCall[], minOutAtomic: bigint, guardDeadlineSec: bigint | undefined;
  const guardRoute = args.probeCase === "guard" || args.probeCase === "guard-deadline";
  if (guardRoute) {
    const guard = getAddress(process.env["TRADFI_BINANCE_GUARD_ADDRESS"] ?? "");
    const quote = await dataPlane.binanceQuoteAndSwap({ tokenIn: USDT_56, tokenOut: args.token, amountAtomic: args.amountAtomic.toString(), slippageBps: 100 });
    if (args.delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, args.delayMs));
    const nowSec = BigInt(Math.floor(Date.now() / 1_000));
    guardDeadlineSec = args.probeCase === "guard-deadline" ? nowSec - 60n : BigInt(Math.min(Math.floor(quote.expiresAt / 1_000), Number(nowSec + 14n)));
    minOutAtomic = BigInt(quote.minOutAtomic);
    calls = [...buildTradfiApprove(USDT_56, guard, args.amountAtomic), buildTradfiGuardSwapCall({ guard,
      router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56,
      tokenIn: USDT_56, tokenOut: args.token, amountInWei: args.amountAtomic, minOutWei: minOutAtomic,
      deadline: guardDeadlineSec, calldata: quote.calldata })];
  } else {
    const quote = await quoteBestTradfiBuy({ token: args.token, amountInAtomic: args.amountAtomic, slippageBps: 100, rpcUrls: resolveLpRpcUrls(process.env, BNB) });
    minOutAtomic = args.probeCase === "impossible-min-out" ? quote.quotedOutAtomic * 10n : quote.minOutAtomic;
    const build = quote.venue === "pancake_v2" ? buildTradfiPancakeV2Swap : quote.venue === "pancake_v3" ? buildTradfiPancakeV3Swap : buildTradfiUniswapV3Swap;
    calls = build({ router: quote.router, tokenIn: USDT_56, tokenOut: args.token, amountInWei: args.amountAtomic,
      minOutWei: minOutAtomic, recipient: args.wallet, deadline: BigInt(Math.floor(Date.now() / 1_000)) + 120n, route: quote.route });
  }
  if (args.probeCase === "guard-deadline") { console.log(JSON.stringify(await probeGuardDeadline(dataPlane, args.wallet, calls))); return; }
  const store = new MemoryTradeSimulationStore();
  const evidence = createTradfiEvidenceWriter(store, line => console.warn(line));
  let rawFailReason: string | null = null;
  const nowMs = Date.now();
  const verdict = await preflightSimulate({ evidence, simulate: async input => { const result = await dataPlane.binanceSimulate(input); rawFailReason = result.failReason; return result; } }, {
    agent: { id: "probe", ownerAddress: args.wallet, walletAddress: args.wallet }, idempotencyKey: `0x${"00".repeat(32)}` as Hex,
    journalKind: "trade", exposure: "increase", route: guardRoute ? "guard" : "direct", calls, outputToken: args.token,
    minOutAtomic, guardDeadlineSec, nowMs,
  });
  await evidence.shutdown();
  const row = [...store.simulations.values()][0];
  console.log(JSON.stringify({ ...row, rawFailReason: JSON.stringify(rawFailReason), decision: verdict.block ? "BLOCK" : "PROCEED",
    budgetMs: tradfiSimulateBudgetMs(nowMs, guardDeadlineSec), guardRemainingMs: guardDeadlineSec === undefined ? null : Number(guardDeadlineSec) * 1_000 - nowMs,
    headroomBps: row?.predictedOutAtomic === null || row === undefined ? null : (row.predictedOutAtomic - minOutAtomic) * 10_000n / minOutAtomic },
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error("Simulation probe unavailable."); process.exitCode = 2; });
}
