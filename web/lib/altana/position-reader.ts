/**
 * What the CHAIN says about a position, which is not always what the plane's
 * row says.
 *
 * The agent detail page used to render position state entirely from the owner
 * view. That is the plane's bookkeeping, and on 2026-09-03 it was wrong in the
 * worst possible direction: both rows of a dual arm read `closed` while NFT
 * 7316794 still held 198529011719679442645 of liquidity. The plane bug is
 * fixed, but a UI that can only repeat what the plane believes has no way to
 * notice the next disagreement — so this reader asks the NFT directly.
 */

import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from "viem";
import { poolAddressFor } from "@/lib/exec/pairs";
import { closeMinimums, positionAmounts, type PositionAmounts } from "./nfpm";
import type { DustRead } from "@/lib/lp/dust";

const POSITIONS_ABI = [{
  type: "function", name: "positions", stateMutability: "view",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [
    { name: "nonce", type: "uint96" }, { name: "operator", type: "address" },
    { name: "token0", type: "address" }, { name: "token1", type: "address" },
    { name: "fee", type: "uint24" }, { name: "tickLower", type: "int24" },
    { name: "tickUpper", type: "int24" }, { name: "liquidity", type: "uint128" },
    { name: "feeGrowthInside0LastX128", type: "uint256" }, { name: "feeGrowthInside1LastX128", type: "uint256" },
    { name: "tokensOwed0", type: "uint128" }, { name: "tokensOwed1", type: "uint128" },
  ],
}] as const;

const SLOT0_ABI = [{
  type: "function", name: "slot0", stateMutability: "view", inputs: [],
  outputs: [
    { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
    { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
    { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint32" },
    { name: "unlocked", type: "bool" },
  ],
}] as const;

export type OnChainPosition = {
  readonly kind: "position";
  readonly blockNumber: bigint;
  readonly readAtMs: number;
  readonly sqrtPriceX96: bigint | null;
  readonly amountsAvailable: boolean;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  /** What a full withdrawal returns at the price just read. */
  readonly amounts: PositionAmounts;
  /** The floors to submit with it — never zero while the amounts are known. */
  readonly minimums: PositionAmounts;
  /** Fees the NFT has already accrued and not collected, at the same block. */
  readonly owed: PositionAmounts;
};

export type OnChainPositionRead = OnChainPosition | { kind: "burned"; tokenId: bigint } | { kind: "unreadable"; tokenId: bigint; reason: string };

/** A single pinned principal snapshot. Arbitrary reverts never prove absence. */
export async function readOnChainPosition(client: PublicClient, nfpm: Address, tokenId: bigint): Promise<OnChainPositionRead> {
  const unreadable = (reason: string): OnChainPositionRead => ({ kind: "unreadable", tokenId, reason });
  let blockNumber: bigint;
  try { blockNumber = await client.getBlockNumber({ cacheTime: 0 }); }
  catch { return unreadable("cannot read snapshot block"); }
  let position: readonly unknown[];
  try {
    position = await client.readContract({ address: nfpm, abi: POSITIONS_ABI, functionName: "positions", args: [tokenId], blockNumber });
  } catch (error) {
    const revert = error instanceof BaseError ? error.walk(e => e instanceof ContractFunctionRevertedError) : error;
    if (revert instanceof ContractFunctionRevertedError && revert.reason === "Invalid token ID") return { kind: "burned", tokenId };
    return unreadable("position not readable on chain");
  }
  try {
    const token0 = position[2] as Address, token1 = position[3] as Address;
    const fee = Number(position[4]), tickLower = Number(position[5]), tickUpper = Number(position[6]);
    const liquidity = BigInt(position[7] as bigint);
    if (!/^0x[0-9a-f]{40}$/iu.test(token0) || !/^0x[0-9a-f]{40}$/iu.test(token1) || liquidity < 0n
      || !Number.isSafeInteger(tickLower) || !Number.isSafeInteger(tickUpper) || tickLower >= tickUpper) return unreadable("invalid position snapshot");
    const owed0 = BigInt(position[10] as bigint), owed1 = BigInt(position[11] as bigint);
    if (owed0 < 0n || owed1 < 0n) return unreadable("invalid position snapshot");
    const base: OnChainPosition = { kind: "position", tokenId, liquidity, token0, token1, fee, tickLower, tickUpper,
      blockNumber, readAtMs: Date.now(), sqrtPriceX96: null, amountsAvailable: liquidity === 0n,
      amounts: { amount0: 0n, amount1: 0n }, minimums: { amount0: 0n, amount1: 0n },
      owed: { amount0: owed0, amount1: owed1 } };
    if (liquidity === 0n) return base;
    const pool = poolAddressFor(token0, token1, fee);
    if (pool === null) return base;
    try {
      const slot0 = await client.readContract({ address: pool as Address, abi: SLOT0_ABI, functionName: "slot0", blockNumber });
      const sqrtPriceX96 = slot0[0];
      if (sqrtPriceX96 <= 0n) return base;
      const amounts = positionAmounts({ liquidity, sqrtPriceX96, tickLower, tickUpper });
      return { ...base, readAtMs: Date.now(), sqrtPriceX96, amountsAvailable: true, amounts, minimums: closeMinimums(amounts) };
    } catch { return base; }
  } catch { return unreadable("invalid position snapshot"); }
}

const ENUMERABLE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "tokenOfOwnerByIndex", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "index", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/**
 * Every NFPM token the wallet holds RIGHT NOW, from ERC-721 enumeration.
 *
 * The plane records a re-quote's new NFTs only once the relay confirms the
 * batch (140-145 s of `wallet_getCallsStatus` lag, then a worker cycle), so a
 * page that lists only the plane's rows shows the OLD rungs for minutes after a
 * fill. Asking the NFPM who the wallet's tokens are closes that gap: the new
 * rungs exist on chain the moment the batch lands. Bounded at `maxTokens`, so a
 * wallet with a long history costs a known number of reads.
 */
export async function listWalletPositionIds(
  client: PublicClient,
  nfpm: Address,
  wallet: Address,
  maxTokens = 24,
): Promise<readonly bigint[]> {
  let count: bigint;
  try {
    count = await client.readContract({ address: nfpm, abi: ENUMERABLE_ABI, functionName: "balanceOf", args: [wallet] }) as bigint;
  } catch {
    return [];
  }
  const total = Number(count);
  if (!Number.isSafeInteger(total) || total <= 0) return [];
  // Newest tokens sit at the END of the enumeration; read from the end.
  const start = Math.max(0, total - maxTokens);
  const indexes = Array.from({ length: total - start }, (_, i) => BigInt(start + i));
  const ids = await Promise.all(indexes.map(async (index) => {
    try {
      return await client.readContract({ address: nfpm, abi: ENUMERABLE_ABI, functionName: "tokenOfOwnerByIndex", args: [wallet, index] }) as bigint;
    } catch {
      return null;
    }
  }));
  return ids.filter((id): id is bigint => id !== null);
}

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/**
 * The agent wallet's balance of BOTH pool legs, at ONE pinned block.
 *
 * This is the Dust tile's only source: what a rebalance handed back sits in the
 * wallet, not in the position, and no owner-view projection reports it (the LP
 * read route makes zero chain reads by design, PHASE3.4 Rev2 M6). A failure
 * returns its reason rather than zeroes, because "0" and "unreadable" mean
 * opposite things to someone deciding whether to re-arm.
 *
 * Native BNB is deliberately NOT read: it is the gas reserve, not dust.
 */
export async function readWalletLegBalances(
  client: PublicClient,
  wallet: Address,
  token0: Address,
  token1: Address,
): Promise<DustRead> {
  const unavailable = (reason: string): DustRead => ({ kind: "unavailable", reason });
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  } catch {
    return unavailable("cannot read snapshot block");
  }
  try {
    const [token0Wei, token1Wei] = await Promise.all([
      client.readContract({ address: token0, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [wallet], blockNumber }),
      client.readContract({ address: token1, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [wallet], blockNumber }),
    ]);
    if (typeof token0Wei !== "bigint" || typeof token1Wei !== "bigint" || token0Wei < 0n || token1Wei < 0n) {
      return unavailable("wallet balances not readable");
    }
    return { kind: "read", token0Wei, token1Wei, blockNumber, readAtMs: Date.now() };
  } catch {
    return unavailable("wallet balances not readable");
  }
}
