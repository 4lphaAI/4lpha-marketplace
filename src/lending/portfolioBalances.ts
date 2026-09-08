import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { VENUS_COMPTROLLER_ABI, VENUS_VAI_CONTROLLER_ABI, VENUS_VTOKEN_ABI } from "../venus/abis.js";

export type LendingPortfolioBalances = {
  readonly blockNumber: bigint;
  readonly observedAtMs: number;
  readonly positions: readonly {
    readonly vToken: Address;
    readonly suppliedWei: bigint;
    readonly borrowedWei: bigint;
  }[];
};

const INVENTORY_ABI = parseAbi(["function getAllMarkets() view returns (address[])"]);

/** Display-only balances. No session, key, transaction, or worker decision seam. */
export async function readLendingPortfolioBalances(
  client: PublicClient, comptroller: Address, accounts: readonly Address[], signal?: AbortSignal,
): Promise<LendingPortfolioBalances> {
  const check = () => signal?.throwIfAborted();
  const owners = [...new Set(accounts.map(account => getAddress(account)))];
  if (owners.length < 1 || owners.length > 2) throw new Error("Portfolio needs one or two accounts.");
  check();
  const block = await client.getBlock({ blockTag: "finalized" });
  if (block.number === null) throw new Error("Finalized block unavailable.");
  check();
  const [markets, vaiController] = await Promise.all([
    client.readContract({ address: comptroller, abi: INVENTORY_ABI, functionName: "getAllMarkets", blockNumber: block.number }),
    client.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "vaiController", blockNumber: block.number }),
  ]);
  check();
  if (markets.length === 0 || markets.length > 64 || new Set(markets.map(m => m.toLowerCase())).size !== markets.length) throw new Error("Core market inventory is unavailable.");
  const vai = await client.multicall({
    contracts: owners.map(owner => ({ address: vaiController, abi: VENUS_VAI_CONTROLLER_ABI, functionName: "getVAIRepayAmount" as const, args: [owner] as const })),
    blockNumber: block.number, allowFailure: false,
  });
  check();
  if (vai.some(debt => debt !== 0n)) throw new Error("Portfolio interest for VAI debt is unavailable.");
  const pairs = owners.flatMap(owner => markets.map(vToken => ({ owner, vToken })));
  const snapshots = await client.multicall({
    contracts: pairs.map(({ owner, vToken }) => ({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "getAccountSnapshot" as const, args: [owner] as const })),
    blockNumber: block.number, allowFailure: false, batchSize: 8_192,
  });
  check();
  if (snapshots.some(snapshot => snapshot[0] !== 0n)) throw new Error("A Core market balance is unreadable.");
  const active = pairs.flatMap((pair, index) => {
    const snapshot = snapshots[index]!;
    return snapshot[1] === 0n && snapshot[2] === 0n ? [] : [{ ...pair, vTokens: snapshot[1], borrow: snapshot[2] }];
  });
  const positions: { vToken: Address; suppliedWei: bigint; borrowedWei: bigint }[] = [];
  // Keep current-accrual eth_calls bounded even on accounts with many markets.
  for (let offset = 0; offset < active.length; offset += 4) {
    check();
    const chunk = await Promise.all(active.slice(offset, offset + 4).map(async entry => {
      const [exchange, borrow] = await Promise.all([
        entry.vTokens === 0n ? null : client.simulateContract({ address: entry.vToken, abi: VENUS_VTOKEN_ABI, functionName: "exchangeRateCurrent", blockNumber: block.number! }),
        entry.borrow === 0n ? null : client.simulateContract({ address: entry.vToken, abi: VENUS_VTOKEN_ABI, functionName: "borrowBalanceCurrent", args: [entry.owner], blockNumber: block.number! }),
      ]);
      return { vToken: entry.vToken, suppliedWei: exchange === null ? 0n : entry.vTokens * exchange.result / 10n ** 18n, borrowedWei: borrow?.result ?? 0n };
    }));
    check();
    positions.push(...chunk);
  }
  return { blockNumber: block.number, observedAtMs: Date.now(), positions };
}
