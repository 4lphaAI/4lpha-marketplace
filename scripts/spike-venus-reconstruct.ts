/**
 * STEP ZERO (PHASE4-SPEC R2.16/R30, and the second review's standing
 * condition 5) — the read-only reconstruction spike that had to run BEFORE
 * the first Phase 4 store was written.
 *
 * It reads the full per-market finalized set for an owner over PUBLIC BSC RPC,
 * reconstructs `W` and `D` on BOTH bases with the R2.3 pairings through
 * `src/venus/risk.ts` (the same module the plane ships — the point is to prove
 * the SHIPPED pipeline, not a throwaway), and asserts EXACT equality of the
 * reconstructed `(liquidity, shortfall)` against `getAccountLiquidity` AND
 * `getBorrowingPower` at the same block.
 *
 * If equality fails the phase stops: "every number downstream is wrong and the
 * phase should stop there."
 *
 *   READ-ONLY. No keys, no `.env` secrets, no transaction, no signing. It
 *   constructs a public client against public endpoints and calls `view`
 *   functions only. `borrowBalanceCurrent`/`exchangeRateCurrent` are reached
 *   through `simulateContract`, which is `eth_call` — the same thing the
 *   read-only data plane does.
 *
 * Usage:  npm run spike-venus-reconstruct -- [--owner 0x…] [--rpc <url>]
 */
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { bsc } from "viem/chains";
import {
  VENUS_COMPTROLLER_ABI,
  VENUS_DBO_ABI,
  VENUS_ORACLE_ABI,
  VENUS_VAI_CONTROLLER_ABI,
  VENUS_VTOKEN_ABI,
} from "../src/venus/abis.js";
import {
  calculateVenusRisk,
  riskMatchesProtocol,
  type VenusRiskMarketInput,
} from "../src/venus/risk.js";

const COMPTROLLER: Address = getAddress("0xfd36e2c2a6789db23113685031d7f16329158384");
const DEFAULT_OWNER: Address = getAddress("0x561b561ef37874c8e61534be9bae52eb6261ddc4");
const DEFAULT_RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.bnbchain.org",
];

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function format(value: bigint, decimals = 18): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

async function connect(urls: readonly string[]): Promise<PublicClient> {
  for (const url of urls) {
    try {
      const client = createPublicClient({ chain: bsc, transport: http(url) }) as PublicClient;
      const chainId = await client.getChainId();
      if (chainId !== 56) {
        console.error(`  skip ${url}: chainId ${chainId}, expected 56`);
        continue;
      }
      console.log(`RPC: ${url}`);
      return client;
    } catch (error) {
      console.error(`  skip ${url}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error("no usable BSC endpoint");
}

async function main(): Promise<void> {
  const owner = getAddress(argValue("--owner") ?? DEFAULT_OWNER);
  const rpcOverride = argValue("--rpc");
  const client = await connect(rpcOverride === undefined ? DEFAULT_RPCS : [rpcOverride]);

  // Pin the whole read set to ONE finalized block — the finality discipline
  // `src/lp/readers.ts` already establishes for trigger observations.
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const blockNumber = finalized.number;
  if (blockNumber === null) throw new Error("finalized block has no number");
  console.log(`owner: ${owner}`);
  console.log(`finalized block: ${blockNumber} (${finalized.hash})`);

  const [oracle, dbo, vaiController, markets] = await Promise.all([
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "oracle", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "deviationBoundedOracle", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "vaiController", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getAllMarkets", blockNumber }),
  ]);

  const [assetsIn, userPoolId, lastPoolId, vaiDebt, borrowingPower, accountLiquidity, snapshots] =
    await Promise.all([
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getAssetsIn", args: [owner], blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "userPoolId", args: [owner], blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "lastPoolId", blockNumber }),
      client.readContract({ address: vaiController as Address, abi: VENUS_VAI_CONTROLLER_ABI, functionName: "getVAIRepayAmount", args: [owner], blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getBorrowingPower", args: [owner], blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getAccountLiquidity", args: [owner], blockNumber }),
      Promise.all(markets.map(async (vToken) => ({
        vToken,
        snapshot: await client.readContract({
          address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "getAccountSnapshot", args: [owner], blockNumber,
        }),
      }))),
    ]);

  console.log(`userPoolId: ${userPoolId} (lastPoolId ${lastPoolId})`);
  console.log(`vaiDebt: ${format(vaiDebt)}`);

  const snapshotError = snapshots.find((entry) => entry.snapshot[0] !== 0n);
  if (snapshotError !== undefined) {
    throw new Error(`snapshot_error on ${snapshotError.vToken}`);
  }

  const memberSet = new Set(assetsIn.map((address) => address.toLowerCase()));
  const active = snapshots.filter((entry) =>
    entry.snapshot[1] !== 0n || entry.snapshot[2] !== 0n || memberSet.has(entry.vToken.toLowerCase()));
  console.log(`markets: ${markets.length} listed, ${active.length} active for this owner`);

  const inputs: VenusRiskMarketInput[] = [];
  for (const entry of active) {
    const [, vTokenBalance, borrowBalance, exchangeRate] = entry.snapshot;
    const [symbol, effectiveCf, effectiveLt, spot, bounded] = await Promise.all([
      client.readContract({ address: entry.vToken, abi: VENUS_VTOKEN_ABI, functionName: "symbol", blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getEffectiveLtvFactor", args: [owner, entry.vToken, 0], blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getEffectiveLtvFactor", args: [owner, entry.vToken, 1], blockNumber }),
      client.readContract({ address: oracle as Address, abi: VENUS_ORACLE_ABI, functionName: "getUnderlyingPrice", args: [entry.vToken], blockNumber }),
      client.readContract({ address: dbo as Address, abi: VENUS_DBO_ABI, functionName: "getBoundedPricesView", args: [entry.vToken], blockNumber }),
    ]);
    if (spot === 0n || bounded[0] === 0n || bounded[1] === 0n) {
      throw new Error(`invalid_oracle_price on ${symbol}`);
    }
    const collateralMember = memberSet.has(entry.vToken.toLowerCase());
    inputs.push({
      collateralMember,
      vTokenBalance,
      exchangeRate,
      borrowBalance,
      collateralFactor: effectiveCf,
      liquidationThreshold: effectiveLt,
      collateralPrice: bounded[0],
      debtPrice: bounded[1],
      spotPrice: spot,
    });
    console.log(
      `  ${symbol.padEnd(8)} member=${collateralMember ? "y" : "n"} ` +
      `vBal=${vTokenBalance} borrow=${borrowBalance} cf=${format(effectiveCf)} lt=${format(effectiveLt)}`,
    );
  }

  const stored = calculateVenusRisk(inputs, vaiDebt);

  const liquidationMatched = riskMatchesProtocol(
    stored.liquidationRisk, accountLiquidity[0], accountLiquidity[1], accountLiquidity[2],
  );
  const borrowingMatched = riskMatchesProtocol(
    stored.borrowingPower, borrowingPower[0], borrowingPower[1], borrowingPower[2],
  );

  const report = (
    label: string,
    reconstructed: typeof stored.liquidationRisk,
    protocolAnswer: readonly [bigint, bigint, bigint],
    matched: boolean,
  ): void => {
    console.log(`\n${label}`);
    console.log(`  W (collateral) : ${format(reconstructed.collateral)}`);
    console.log(`  D (debt)       : ${format(reconstructed.debt)}`);
    console.log(`  HF             : ${reconstructed.healthFactor === null ? "inf (no debt)" : format(reconstructed.healthFactor)}`);
    console.log(`  reconstructed  : liquidity=${reconstructed.liquidity} shortfall=${reconstructed.shortfall}`);
    console.log(`  protocol       : errorCode=${protocolAnswer[0]} liquidity=${protocolAnswer[1]} shortfall=${protocolAnswer[2]}`);
    console.log(`  EXACT MATCH    : ${matched ? "YES" : "NO"}`);
  };

  report("liquidation basis (LT weights, SPOT both legs) vs getAccountLiquidity",
    stored.liquidationRisk, accountLiquidity, liquidationMatched);
  report("borrowing-power basis (CF weights, bounded pair) vs getBorrowingPower",
    stored.borrowingPower, borrowingPower, borrowingMatched);

  if (!liquidationMatched || !borrowingMatched) {
    console.error("\nSTEP ZERO FAILED — reconstruction does not reproduce the protocol exactly.");
    console.error("STOP THE PHASE. Do not proceed on a smaller number.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nSTEP ZERO PASSED at block ${blockNumber}.`);
  console.log(`  liquidation   : (${accountLiquidity[1]}, ${accountLiquidity[2]})`);
  console.log(`  borrowingPower: (${borrowingPower[1]}, ${borrowingPower[2]})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
