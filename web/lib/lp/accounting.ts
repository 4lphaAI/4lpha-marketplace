/** Display-only reads. Never supplies withdrawal floors or transaction inputs. */
import { parseAbi, type Address, type PublicClient } from "viem";
import type { OnChainPosition } from "@/lib/altana/position-reader";
import { poolAddressFor, WBNB_56 } from "@/lib/exec/pairs";
import { usdForWei, type DetailMetric } from "@/lib/exec/agent-detail";
import { formatTokenAmount } from "./dust";

const READ_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{name:"tokenId",type:"uint256"}], outputs:[{type:"address"}] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name:"owner",type:"address"}], outputs:[{type:"uint256"}] },
  { type: "function", name: "tokenOfOwnerByIndex", stateMutability: "view", inputs: [{name:"owner",type:"address"},{name:"index",type:"uint256"}], outputs:[{type:"uint256"}] },
] as const;
const POSITION_ABI = parseAbi(["function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"]);
const COLLECT_ABI = [{ type: "function", name: "collect", stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    {name:"tokenId",type:"uint256"}, {name:"recipient",type:"address"},
    {name:"amount0Max",type:"uint128"}, {name:"amount1Max",type:"uint128"},
  ] }], outputs: [{name:"amount0",type:"uint256"},{name:"amount1",type:"uint256"}],
}] as const;

export type LpAccountingRead = {
  readonly kind: "read"; readonly wallet: string; readonly pool: string;
  readonly position: OnChainPosition;
  readonly collectible0: bigint; readonly collectible1: bigint;
  readonly dust0: bigint; readonly dust1: bigint;
} | { readonly kind: "unavailable"; readonly reason: string };

export function selectLpAccountingPosition(positions: readonly OnChainPosition[]): OnChainPosition | null {
  const live = new Map(positions.filter(p => p.liquidity > 0n).map(p => [p.tokenId.toString(),p]));
  return live.size === 1 ? [...live.values()][0]! : null;
}

export async function readLpAccounting(
  client: Pick<PublicClient, "getChainId" | "readContract" | "simulateContract">,
  nfpm: Address, wallet: Address, position: OnChainPosition,
): Promise<LpAccountingRead> {
  const unavailable = (reason: string): LpAccountingRead => ({kind:"unavailable",reason});
  const pool = poolAddressFor(position.token0, position.token1, position.fee);
  if (!pool || !position.amountsAvailable || position.sqrtPriceX96 === null || position.liquidity <= 0n) return unavailable("no single live position to value");
  try {
    if (await client.getChainId() !== 56) return unavailable("wrong chain for LP accounting");
    const blockNumber = position.blockNumber;
    const owner = await client.readContract({ address: nfpm, abi: READ_ABI, functionName: "ownerOf", args: [position.tokenId], blockNumber });
    if (owner.toLowerCase() !== wallet.toLowerCase()) return unavailable("position is not held by this wallet");
    // The existing position-list UI tolerates partial enumeration. A total PNL
    // cannot: prove the complete same-block inventory before pricing one NFT.
    const count = await client.readContract({address:nfpm,abi:READ_ABI,functionName:"balanceOf",args:[wallet],blockNumber});
    if (count < 1n || count > 24n) return unavailable("complete LP inventory unavailable");
    const ids = await Promise.all(Array.from({length:Number(count)},(_,i) => client.readContract({address:nfpm,abi:READ_ABI,
      functionName:"tokenOfOwnerByIndex",args:[wallet,BigInt(i)],blockNumber})));
    if (!ids.includes(position.tokenId) || new Set(ids).size !== ids.length) return unavailable("inconsistent LP inventory");
    const others = await Promise.all(ids.filter(id=>id!==position.tokenId).map(id=>client.readContract({address:nfpm,abi:POSITION_ABI,
      functionName:"positions",args:[id],blockNumber})));
    if (others.some(p=>p[2].toLowerCase()===position.token0.toLowerCase() && p[3].toLowerCase()===position.token1.toLowerCase()
      && p[4]===position.fee && p[7]>0n)) return unavailable("multiple live LP positions");
    // eth_call simulation includes fee growth since the last NFT update.
    // positions().tokensOwed alone omits that growth. Nothing is submitted.
    const [fees, dust0, dust1] = await Promise.all([
      client.simulateContract({ address: nfpm, abi: COLLECT_ABI, functionName: "collect", account: wallet,
        args: [{tokenId:position.tokenId,recipient:wallet,amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}], blockNumber }),
      client.readContract({address:position.token0,abi:READ_ABI,functionName:"balanceOf",args:[wallet],blockNumber}),
      client.readContract({address:position.token1,abi:READ_ABI,functionName:"balanceOf",args:[wallet],blockNumber}),
    ]);
    const [collectible0, collectible1] = fees.result;
    if ([collectible0,collectible1,dust0,dust1].some(v => typeof v !== "bigint" || v < 0n)) return unavailable("invalid LP accounting amounts");
    return {kind:"read",wallet,pool,position,collectible0,collectible1,dust0,dust1};
  } catch { return unavailable("LP fees or wallet balances unavailable"); }
}

export function matchingLpAccounting(input: {
  readonly read: LpAccountingRead | undefined; readonly wallet: string | null;
  readonly pool: string | null; readonly tokenId: bigint | null; readonly nowMs: number;
}): Extract<LpAccountingRead, {kind:"read"}> | null {
  const r = input.read;
  return r?.kind === "read" && r.wallet.toLowerCase() === input.wallet?.toLowerCase()
    && r.pool.toLowerCase() === input.pool?.toLowerCase() && r.position.tokenId === input.tokenId
    && input.nowMs - r.position.readAtMs >= 0 && input.nowMs - r.position.readAtMs <= 60_000 ? r : null;
}

function inWbnb(read: Extract<LpAccountingRead, {kind:"read"}>, a: bigint, b: bigint): bigint | null {
  const p = read.position, sqrt = p.sqrtPriceX96;
  if (sqrt === null || sqrt <= 0n || !p.amountsAvailable) return null;
  const q = 1n << 192n, s2 = sqrt * sqrt;
  if (p.token0.toLowerCase() === WBNB_56) return a + b * q / s2;
  if (p.token1.toLowerCase() === WBNB_56) return b + a * s2 / q;
  return null;
}

export function lpAccountingPnl(read: Extract<LpAccountingRead, {kind:"read"}> | null, budgetWei: string | null, wbnbMicros: bigint | null): DetailMetric {
  if (read === null) return {value:null,reason:"waiting for matching position, fees and dust"};
  if (budgetWei === null || !/^[1-9]\d{0,77}$/u.test(budgetWei) || wbnbMicros === null || wbnbMicros <= 0n) return {value:null,reason:"armed capital or fresh BNB price unavailable"};
  const p = read.position;
  // Collectible replaces tokensOwed, not added to it. Collected historical
  // fees already reside in principal/dust and are never a second add-back.
  const holdings = inWbnb(read, p.amounts.amount0 + read.collectible0 + read.dust0,
    p.amounts.amount1 + read.collectible1 + read.dust1);
  if (holdings === null) return {value:null,reason:"position cannot be valued in BNB"};
  const capital = BigInt(budgetWei), delta = holdings - capital, magnitude = delta < 0n ? -delta : delta;
  const centsPct = magnitude * 10000n / capital, sign = delta < 0n ? "-" : delta > 0n ? "+" : "";
  return {value:`${delta > 0n ? "+" : ""}${usdForWei(delta.toString(),wbnbMicros)}`, rawWei:delta.toString(),reason:null,
    note:`${sign}${centsPct/100n}.${String(centsPct%100n).padStart(2,"0")}%`};
}

export function lpAccountingFees(read: Extract<LpAccountingRead, {kind:"read"}> | null, input: {
  readonly decimals0: number | null; readonly decimals1: number | null;
  readonly symbol0: string; readonly symbol1: string; readonly quoteIsToken0: boolean;
  readonly wbnbMicros: bigint | null;
}): DetailMetric {
  if (!read || input.decimals0 === null || input.decimals1 === null) return {value:null,reason:"full collectible fees unavailable"};
  const a = `${formatTokenAmount(read.collectible0,input.decimals0)} ${input.symbol0}`;
  const b = `${formatTokenAmount(read.collectible1,input.decimals1)} ${input.symbol1}`;
  const value = inWbnb(read, read.collectible0, read.collectible1);
  return {value:value === null || input.wbnbMicros === null ? null : usdForWei(value.toString(),input.wbnbMicros),
    reason:value === null || input.wbnbMicros === null ? "fresh BNB price unavailable" : null,
    tokenBreakdown:input.quoteIsToken0 ? `${a} / ${b}` : `${b} / ${a}`,
    note:`uncollected only · block ${read.position.blockNumber}`};
}
