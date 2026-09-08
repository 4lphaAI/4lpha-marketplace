import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, PublicClient } from "viem";
import type { VenusReadResult } from "../src/clients/dataPlane.js";
import { aggregateLendingPortfolio, createLendingPortfolioProjection } from "../src/http/lendingPortfolio.js";
import { readLendingPortfolioBalances } from "../src/lending/portfolioBalances.js";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const E18 = 10n ** 18n;
const balances = { blockNumber: 42n, observedAtMs: 120_000, positions: [{ vToken: TOKEN, suppliedWei: 100n * E18, borrowedWei: 50n * E18 }] };
function markets(asOf = 120_000, supply = 5, borrow = 8): VenusReadResult {
  return { kind: "ok", envelope: { data: { schemaVersion: 1, chainId: 56, pool: "core", markets: [
    { vToken: TOKEN, underlying: { decimals: 18 }, prices: { scaleKind: "venus_underlying_price", decimals: 18, spot: E18.toString() }, supplyApyPct: supply, borrowApyPct: borrow },
  ] }, meta: { asOf, staleness: "fresh" } } };
}
test("portfolio uses weighted base yield, all balances, and exact USD scaling", () => {
  const out = aggregateLendingPortfolio(balances, markets(), 120_000);
  assert.equal(out.status, "available");
  assert.equal(out.totalSupplyUsdMantissa, (100n * E18).toString());
  assert.equal(out.totalBorrowedUsdMantissa, (50n * E18).toString());
  assert.equal(out.netApyBps, "100");
  assert.equal(out.dailyEarningUsdMantissa, (E18 / 365n).toString());
  assert.equal(aggregateLendingPortfolio(balances, markets(120_000, 1, 8), 120_000).netApyBps, "-300");
});
test("six-decimal underlying uses Venus price scaling, not USDT assumptions", () => {
  const source = markets();
  assert.equal(source.kind, "ok");
  const changed: VenusReadResult = { kind: "ok", envelope: { data: { schemaVersion: 1, chainId: 56, pool: "core", markets: [
    { vToken: TOKEN, underlying: { decimals: 6 }, prices: { scaleKind: "venus_underlying_price", decimals: 30, spot: (10n ** 30n).toString() }, supplyApyPct: 5, borrowApyPct: 8 },
  ] }, meta: { asOf: 120_000, staleness: "fresh" } } };
  assert.equal(aggregateLendingPortfolio({ ...balances, positions: [{ vToken: TOKEN, suppliedWei: 100_000_000n, borrowedWei: 0n }] }, changed, 120_000).totalSupplyUsdMantissa, (100n * E18).toString());
});
test("missing market data and stale rates never become zero yield", () => {
  assert.equal(aggregateLendingPortfolio(balances, { kind: "pending" }, 120_000).status, "unavailable");
  assert.equal(aggregateLendingPortfolio(balances, markets(1), 120_002).status, "unavailable");
  assert.equal(aggregateLendingPortfolio({ ...balances, positions: [{ vToken: A, suppliedWei: E18, borrowedWei: 0n }] }, markets(), 120_000).status, "unavailable");
  assert.equal(aggregateLendingPortfolio({ ...balances, positions: [] }, markets(), 120_000).netApyBps, null);
});
test("cache deduplicates requests and does not extend rate freshness", async () => {
  let now = 120_000, reads = 0;
  const project = createLendingPortfolioProjection({
    now: () => now,
    readBalances: async () => { reads += 1; return { ...balances, observedAtMs: now }; },
    dataPlane: { venusMarkets: async () => markets(reads === 1 ? 1_000 : now) },
  });
  await Promise.all([project([A, B]), project([B, A])]);
  assert.equal(reads, 1);
  now = 131_000;
  const [fresh] = await Promise.all([project([A, B]), project([A, B]), project([A, B])]);
  assert.equal(reads, 2);
  assert.equal(fresh.status, "available");
  assert.equal(fresh.asOfMs, now);
});
test("read failures are confined to the portfolio projection", async () => {
  const project = createLendingPortfolioProjection({
    readBalances: async () => { throw new Error("RPC down"); },
    dataPlane: { venusMarkets: async () => markets() },
  });
  assert.equal((await project([A, B])).status, "unavailable");
});
test("chain reader scans all Core markets, deduplicates accounts and pins every read", async () => {
  const pinned: bigint[] = [];
  let snapshotCount = 0;
  const client = {
    getBlock: async () => ({ number: 42n }),
    readContract: async (input: { functionName: string; blockNumber: bigint }) => {
      pinned.push(input.blockNumber);
      if (input.functionName === "getAllMarkets") return [TOKEN];
      if (input.functionName === "vaiController") return A;
      throw new Error("unexpected read");
    },
    multicall: async (input: { blockNumber: bigint; contracts: { functionName: string }[] }) => {
      pinned.push(input.blockNumber);
      if (input.contracts[0]?.functionName === "getVAIRepayAmount") return input.contracts.map(() => 0n);
      snapshotCount += input.contracts.length;
      return input.contracts.map(() => [0n, 5n, 2n, E18]);
    },
    simulateContract: async (input: { functionName: string; blockNumber: bigint }) => {
      pinned.push(input.blockNumber);
      return { result: input.functionName === "exchangeRateCurrent" ? 2n * E18 : 3n };
    },
  } as unknown as PublicClient;
  const out = await readLendingPortfolioBalances(client, A, [B, B]);
  assert.equal(snapshotCount, 1);
  assert.deepEqual(out.positions, [{ vToken: TOKEN, suppliedWei: 10n, borrowedWei: 3n }]);
  assert.ok(pinned.every(block => block === 42n));
});
test("empty inventory is unavailable, not an empty portfolio", async () => {
  const client = { getBlock: async () => ({ number: 42n }), readContract: async (input: { functionName: string }) => input.functionName === "getAllMarkets" ? [] : A } as unknown as PublicClient;
  await assert.rejects(readLendingPortfolioBalances(client, A, [B]), /inventory/u);
});
