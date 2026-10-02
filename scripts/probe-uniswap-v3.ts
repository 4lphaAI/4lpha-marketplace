/** Read-only operator gate for the BSC Uniswap V3 deployment. */
import { createPublicClient, getAddress, http, type Address } from "viem";
import { bsc } from "viem/chains";

const ROUTER: Address = getAddress("0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2");
const QUOTER: Address = getAddress("0x78D78E420Da98ad378D7799bE8f4AF69033EB077");
const FACTORY: Address = getAddress("0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7");
const WBNB: Address = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const USDT: Address = getAddress("0x55d398326f99059fF775485246999027B3197955");
const REQUIRED_SELECTORS = ["04e45aaf", "b858183f", "5ae401dc", "49404b7c", "12210e8a"] as const;

const ROUTER_ABI = [
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const QUOTER_ABI = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ] }],
    outputs: [
      { name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** NVDAB (bStocks NVIDIA) on BSC — the data plane's static list entry; `NVDAB_ADDRESS` overrides for the probe only. */
const NVDAB_DEFAULT: Address = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");

async function main(): Promise<void> {
  const rpcUrl = process.env["G0_RPC_URL"]?.trim() || "https://bsc-dataseed.bnbchain.org";
  const rawNvdab = process.env["NVDAB_ADDRESS"]?.trim() ?? "";
  const nvdab = rawNvdab === "" ? NVDAB_DEFAULT : getAddress(rawNvdab);
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const bytecode = await client.getBytecode({ address: ROUTER });
  if (bytecode === undefined) throw new Error("SwapRouter02 has no bytecode.");
  const code = bytecode.toLowerCase();
  for (const selector of REQUIRED_SELECTORS) {
    if (!code.includes(selector)) throw new Error(`SwapRouter02 is missing selector 0x${selector}.`);
  }
  const routerWbnb = await client.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "WETH9" });
  if (getAddress(routerWbnb) !== WBNB) throw new Error("SwapRouter02 WETH9() is not the pinned WBNB.");
  const routerFactory = await client.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "factory" });
  if (getAddress(routerFactory) !== FACTORY) throw new Error("SwapRouter02 factory() is not the pinned factory.");
  const quoterFactory = await client.readContract({ address: QUOTER, abi: QUOTER_ABI, functionName: "factory" });
  if (getAddress(quoterFactory) !== FACTORY) throw new Error("QuoterV2 factory() does not match SwapRouter02.");
  const quote = await client.simulateContract({
    address: QUOTER,
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: nvdab, tokenOut: USDT, amountIn: 10n ** 18n, fee: 500, sqrtPriceLimitX96: 0n }],
  });
  if (quote.result[0] <= 0n) throw new Error("NVDAB/USDT tier 500 quoted zero output.");
  console.log("Uniswap V3 BSC read-only gate passed.");
}

main().catch((error: unknown) => {
  console.error(`Uniswap V3 read-only gate failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
