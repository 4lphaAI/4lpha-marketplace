/**
 * `src/lending/readers.ts` — the reads themselves, through the `transport`
 * injection seam (AUDIT P5, closing A-H2).
 *
 * ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════
 *
 * The module had ZERO offline coverage: no test anywhere constructed
 * `createLendingChainReaders`, so four reader mutations survived the whole
 * suite — dropping either allowance read, unpinning the USDT balance from the
 * finalized block, and removing the `LENDING_MAX_MARKETS` bound. R2.24's
 * "dropping either allowance read fails a named test" was true of the BATCH
 * BUILDER's parameter and false of the read that supplies it.
 *
 * Everything here is scripted RPC: `custom({ request })` with `retryCount: 0`,
 * the same fixture shape `test/lp.readers.test.ts` uses. No network, no chain,
 * no key — every read in the module under test is answerable from public facts.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

import {
  createLendingChainReaders,
  LendingAccountTooComplexError,
  LENDING_SPEND_PERIOD_DAY,
  type LendingVenue,
} from "../src/lending/readers.js";
import { LENDING_MAX_MARKETS } from "../src/ops/policy.js";
import type { VenusAccountReading, VenusVenue } from "../src/venus/types.js";

const FINALIZED_HEX = "0x64";
const FINALIZED_NUMBER = 100n;

const WALLET = getAddress("0x00000000000000000000000000000000000000b1");
const ACCOUNT = getAddress("0x00000000000000000000000000000000000000a9");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const V_USDT = getAddress("0xfD5840Cd36d94D7229439859C0112a4185BC0255");
const V_BNB = getAddress("0xA07c5b74C9B40447a954e1466938b865b6BBea36");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const ROUTER = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const QUOTER = getAddress("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
const FACTORY = getAddress("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865");
const POOL = getAddress("0x36696169C63e42cd08ce11f5deeBbCeBae652050");
const COMPTROLLER = getAddress("0xfD36E2c2a6789Db23113685031d7F16329158384");
const TREASURY = getAddress("0x0000000000000000000000000000000000000dEa");

const VENUE: LendingVenue = {
  vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB, routerV3: ROUTER, wbnb: WBNB,
  quoterV2: QUOTER, factoryV3: FACTORY, swapPool: POOL, swapFeeTier: 100,
  treasury: TREASURY,
};

const VENUS_VENUE: VenusVenue = {
  comptroller: COMPTROLLER,
  vBnb: V_BNB,
  prime: getAddress("0x0000000000000000000000000000000000000f00"),
  treasury: TREASURY,
};

/** The first four bytes of a signature, the way the module's callers write it. */
function selector(signature: string): string {
  return keccak256(new TextEncoder().encode(signature)).slice(0, 10);
}

const SEL = {
  balanceOf: selector("balanceOf(address)"),
  allowance: selector("allowance(address,address)"),
  exchangeRateStored: selector("exchangeRateStored()"),
  exchangeRateCurrent: selector("exchangeRateCurrent()"),
  getCash: selector("getCash()"),
  slot0: selector("slot0()"),
  token0: selector("token0()"),
  liquidity: selector("liquidity()"),
  getPool: selector("getPool(address,address,uint24)"),
  getAssetsIn: selector("getAssetsIn(address)"),
  getAccountLiquidity: selector("getAccountLiquidity(address)"),
  borrowBalanceStored: selector("borrowBalanceStored(address)"),
  spendInfos: selector("spendInfos(bytes32)"),
  quoteExactInputSingle: selector(
    "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
  ),
} as const;

function blockJson(): Record<string, unknown> {
  return {
    number: FINALIZED_HEX,
    hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"22".repeat(32)}`,
    nonce: `0x${"00".repeat(8)}`,
    sha3Uncles: `0x${"33".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"44".repeat(32)}`,
    stateRoot: `0x${"55".repeat(32)}`,
    receiptsRoot: `0x${"66".repeat(32)}`,
    miner: WALLET,
    mixHash: `0x${"77".repeat(32)}`,
    difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
    size: "0x0", gasLimit: "0x0", gasUsed: "0x0", timestamp: "0x0",
    transactions: [], uncles: [], baseFeePerGas: null,
  };
}

const uint = (value: bigint): Hex =>
  encodeAbiParameters([{ type: "uint256" }], [value]);
const addressWord = (value: Address): Hex =>
  encodeAbiParameters([{ type: "address" }], [value]);

/** The spender argument of an `allowance(owner, spender)` calldata. */
function spenderOf(data: string): string {
  return `0x${data.slice(10 + 64 + 24, 10 + 128)}`.toLowerCase();
}

type Call = { readonly to: string; readonly data: string; readonly block: unknown };

type Fixture = {
  readonly allowanceToVUsdt?: bigint;
  readonly allowanceToRouter?: bigint;
  readonly assetsIn?: readonly Address[];
  readonly spendInfos?: readonly {
    token: Address; period: number; limit: bigint; currentSpent: bigint;
  }[];
  readonly spendInfosThrows?: boolean;
  readonly chainIdThrows?: boolean;
};

function fixture(overrides: Fixture = {}) {
  const calls: Call[] = [];
  const venusReadCalls: Address[][] = [];

  const request = async (
    { method, params }: { method: string; params?: unknown },
  ): Promise<unknown> => {
    if (method === "eth_chainId") {
      if (overrides.chainIdThrows === true) throw new Error("unreachable");
      return "0x38";
    }
    if (method === "eth_getBlockByNumber") return blockJson();
    if (method === "eth_getBalance") {
      const [, block] = params as [string, unknown];
      calls.push({ to: "balance", data: "0x", block });
      return toHex(7n * 10n ** 16n);
    }
    if (method === "eth_call") {
      const [tx, block] = params as [{ to?: string; data?: string }, unknown];
      const to = (tx.to ?? "").toLowerCase();
      const data = tx.data ?? "0x";
      calls.push({ to, data, block });
      const sel = data.slice(0, 10).toLowerCase();
      if (sel === SEL.balanceOf) return uint(to === USDT.toLowerCase() ? 11n : 22n);
      if (sel === SEL.allowance) {
        return uint(
          spenderOf(data) === V_USDT.toLowerCase()
            ? (overrides.allowanceToVUsdt ?? 1_234n)
            : (overrides.allowanceToRouter ?? 5_678n),
        );
      }
      if (sel === SEL.exchangeRateStored) return uint(2n * 10n ** 26n);
      if (sel === SEL.exchangeRateCurrent) return uint(3n * 10n ** 26n);
      if (sel === SEL.getCash) return uint(999n);
      if (sel === SEL.slot0) {
        return encodeAbiParameters(
          [
            { type: "uint160" }, { type: "int24" }, { type: "uint16" },
            { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bool" },
          ],
          [2n ** 96n, 0, 0, 1, 1, 0, true],
        );
      }
      if (sel === SEL.token0) return addressWord(WBNB);
      if (sel === SEL.liquidity) {
        return encodeAbiParameters([{ type: "uint128" }], [10n ** 24n]);
      }
      if (sel === SEL.getPool) return addressWord(POOL);
      if (sel === SEL.getAssetsIn) {
        return encodeAbiParameters(
          [{ type: "address[]" }],
          [[...(overrides.assetsIn ?? [V_USDT, V_BNB])]],
        );
      }
      if (sel === SEL.getAccountLiquidity) {
        return encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
          [0n, 5n, 0n],
        );
      }
      if (sel === SEL.borrowBalanceStored) return uint(42n);
      if (sel === SEL.spendInfos) {
        if (overrides.spendInfosThrows === true) throw new Error("scripted read failure");
        return encodeAbiParameters(
          [
            {
              type: "tuple[]",
              components: [
                { name: "token", type: "address" },
                { name: "period", type: "uint8" },
                { name: "limit", type: "uint256" },
                { name: "spent", type: "uint256" },
                { name: "lastUpdated", type: "uint256" },
                { name: "currentSpent", type: "uint256" },
                { name: "current", type: "uint256" },
              ],
            },
          ],
          [
            (overrides.spendInfos ?? []).map((info) => ({
              token: info.token,
              period: info.period,
              limit: info.limit,
              spent: info.currentSpent,
              lastUpdated: 0n,
              currentSpent: info.currentSpent,
              current: 0n,
            })),
          ],
        );
      }
      if (sel === SEL.quoteExactInputSingle) {
        return encodeAbiParameters(
          [
            { type: "uint256" }, { type: "uint160" },
            { type: "uint32" }, { type: "uint256" },
          ],
          [3_000n, 2n ** 96n, 0, 0n],
        );
      }
      throw new Error(`unscripted eth_call selector ${sel}`);
    }
    throw new Error(`unscripted RPC method ${method}`);
  };

  const readers = createLendingChainReaders({
    network: { chain: bsc, chainId: 56, publicRpcUrl: "http://scripted.invalid" },
    transport: () => custom({ request }, { retryCount: 0 }),
    venue: VENUE,
    venusVenue: VENUS_VENUE,
    makeVenusReaders: (markets) => {
      venusReadCalls.push([...markets]);
      return {
        async readAccount(): Promise<VenusAccountReading> {
          return {
            account: ACCOUNT,
            blockNumber: FINALIZED_NUMBER,
            markets: [],
            accountLiquidity: [0n, 0n, 0n],
            borrowingPower: [0n, 0n, 0n],
            vaiDebt: 0n,
            protocolPaused: false,
          } as unknown as VenusAccountReading;
        },
      } as never;
    },
  });
  return { readers, calls, venusReadCalls };
}

describe("readReserve — one pinned finalized block, and BOTH allowances", () => {
  it("reads both allowances and tells them apart by SPENDER", async () => {
    const { readers } = fixture({ allowanceToVUsdt: 111n, allowanceToRouter: 222n });
    const reserve = await readers.readReserve(WALLET);
    // The mutation this kills: dropping either read, or reading one twice.
    assert.equal(reserve.usdtAllowanceToVUsdt, 111n);
    assert.equal(reserve.usdtAllowanceToRouter, 222n);
    assert.notEqual(
      reserve.usdtAllowanceToVUsdt, reserve.usdtAllowanceToRouter,
      "two DISTINCT values: a fixture with one value cannot see a dropped read",
    );
  });

  it("issues exactly two allowance calls, to vUSDT and to the router", async () => {
    const { readers, calls } = fixture();
    await readers.readReserve(WALLET);
    const allowances = calls.filter((call) => call.data.startsWith(SEL.allowance));
    assert.equal(allowances.length, 2);
    assert.deepEqual(
      allowances.map((call) => spenderOf(call.data)).sort(),
      [V_USDT.toLowerCase(), ROUTER.toLowerCase()].sort(),
    );
  });

  it("PINS every read to the finalized block it asked for", async () => {
    const { readers, calls } = fixture();
    const reserve = await readers.readReserve(WALLET);
    assert.equal(reserve.blockNumber, FINALIZED_NUMBER);
    // The mutation this kills: unpinning the USDT balance (or any other read),
    // which would mix a fresh balance into a stale debt's sizing.
    const pinned = calls.filter(
      (call) => call.data !== "0x" || call.to === "balance",
    );
    assert.ok(pinned.length >= 7, "balances, rate, cash, two allowances, slot0, token0");
    for (const call of pinned) {
      if (call.data.startsWith(SEL.exchangeRateCurrent)) continue; // simulate
      assert.equal(
        call.block, FINALIZED_HEX,
        `a read at ${call.data.slice(0, 10)} was not pinned to the finalized block`,
      );
    }
  });

  it("carries the solver's seed price and the pool's token order", async () => {
    const { readers } = fixture();
    const reserve = await readers.readReserve(WALLET);
    assert.equal(reserve.poolSqrtPriceX96, 2n ** 96n);
    assert.equal(reserve.poolWbnbIsToken0, true);
    assert.equal(reserve.exchangeRateCurrent, 3n * 10n ** 26n, "current, by simulation");
    assert.equal(reserve.exchangeRateStored, 2n * 10n ** 26n);
    assert.equal(reserve.cash, 999n);
  });
});

describe("readAccount — the LENDING_MAX_MARKETS bound (R3.11)", () => {
  const filler = (count: number): Address[] =>
    Array.from({ length: count }, (_, index) =>
      getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`));

  it(`admits a universe of exactly ${LENDING_MAX_MARKETS}`, async () => {
    const assets = filler(LENDING_MAX_MARKETS - 1);
    const { readers, venusReadCalls } = fixture({ assetsIn: assets });
    await readers.readAccount(ACCOUNT, [V_USDT]);
    assert.equal(
      venusReadCalls[0]?.length, LENDING_MAX_MARKETS,
      "the union of getAssetsIn(A) and the pinned debt markets",
    );
  });

  it(`REFUSES a universe of ${LENDING_MAX_MARKETS + 1}, and never fans out`, async () => {
    const assets = filler(LENDING_MAX_MARKETS);
    const { readers, venusReadCalls } = fixture({ assetsIn: assets });
    await assert.rejects(
      readers.readAccount(ACCOUNT, [V_USDT]),
      (error: unknown) =>
        error instanceof LendingAccountTooComplexError
        && error.marketCount === LENDING_MAX_MARKETS + 1,
    );
    assert.equal(
      venusReadCalls.length, 0,
      "the bound is the ONLY thing between a third party's market count and the cycle's read budget",
    );
  });

  it("the bound applies to the S1 path too, at one pinned block", async () => {
    const { readers, calls } = fixture();
    const facts = await readers.readS1Facts(ACCOUNT, [V_USDT, V_BNB]);
    assert.equal(facts.blockNumber, FINALIZED_NUMBER);
    assert.equal(facts.liquidityErrorCode, 0n);
    assert.deepEqual(facts.borrows.map((entry) => entry.borrowWei), [42n, 42n]);
    // EXACTLY THREE bounded reads: one liquidity call plus one per market.
    const s1 = calls.filter(
      (call) =>
        call.data.startsWith(SEL.getAccountLiquidity)
        || call.data.startsWith(SEL.borrowBalanceStored),
    );
    assert.equal(s1.length, 3);
    for (const call of s1) assert.equal(call.block, FINALIZED_HEX);
  });
});

describe("readTokenDayMeter — four TYPED outcomes, none of which refuses", () => {
  const PUBLIC_KEY =
    ("0x04" + "11".repeat(64)) as Hex;

  it("`day` when the token has a rolling-DAY row", async () => {
    const { readers } = fixture({
      spendInfos: [
        { token: USDT, period: LENDING_SPEND_PERIOD_DAY, limit: 100n, currentSpent: 40n },
      ],
    });
    const meter = await readers.readTokenDayMeter({
      walletAddress: WALLET, publicKey: PUBLIC_KEY, token: USDT,
    });
    assert.deepEqual(meter, {
      kind: "day", limitWei: 100n, currentSpentWei: 40n, remainingWei: 60n,
    });
  });

  it("`day` with remaining CLAMPED at zero when the cap is overspent", async () => {
    const { readers } = fixture({
      spendInfos: [
        { token: USDT, period: LENDING_SPEND_PERIOD_DAY, limit: 100n, currentSpent: 500n },
      ],
    });
    const meter = await readers.readTokenDayMeter({
      walletAddress: WALLET, publicKey: PUBLIC_KEY, token: USDT,
    });
    assert.equal(meter.kind === "day" ? meter.remainingWei : -1n, 0n);
  });

  it("`no-grant` when the session holds no row for that token", async () => {
    const { readers } = fixture({ spendInfos: [] });
    const meter = await readers.readTokenDayMeter({
      walletAddress: WALLET, publicKey: PUBLIC_KEY, token: USDT,
    });
    assert.equal(meter.kind, "no-grant");
  });

  it("`other-period` when the cap is not a rolling DAY", async () => {
    const { readers } = fixture({
      spendInfos: [
        { token: USDT, period: LENDING_SPEND_PERIOD_DAY + 1, limit: 100n, currentSpent: 0n },
      ],
    });
    const meter = await readers.readTokenDayMeter({
      walletAddress: WALLET, publicKey: PUBLIC_KEY, token: USDT,
    });
    assert.equal(meter.kind, "other-period");
  });

  it("`unreadable` — with a detail — when the read itself fails", async () => {
    const { readers } = fixture({ spendInfosThrows: true });
    const meter = await readers.readTokenDayMeter({
      walletAddress: WALLET, publicKey: PUBLIC_KEY, token: USDT,
    });
    assert.equal(meter.kind, "unreadable");
    assert.ok(meter.kind === "unreadable" && meter.detail.length > 0);
  });

  it("`unreadable` when the transport itself is down — never a throw", async () => {
    const { readers } = fixture({ chainIdThrows: true });
    const meter = await readers.readTokenDayMeter({
      walletAddress: WALLET, publicKey: PUBLIC_KEY, token: null,
    });
    assert.equal(meter.kind, "unreadable", "an unreadable meter NEVER refuses a rescue");
  });

  it("`token: null` reads the NATIVE meter, at the zero address", async () => {
    const { readers } = fixture({
      spendInfos: [
        {
          token: getAddress("0x0000000000000000000000000000000000000000"),
          period: LENDING_SPEND_PERIOD_DAY, limit: 8n, currentSpent: 3n,
        },
      ],
    });
    const meter = await readers.readTokenDayMeter({
      walletAddress: WALLET, publicKey: PUBLIC_KEY, token: null,
    });
    assert.equal(meter.kind === "day" ? meter.remainingWei : -1n, 5n);
  });
});

describe("readSwapPool and quote", () => {
  it("proves the pinned pool and reports its liquidity and token order", async () => {
    const { readers } = fixture();
    const pool = await readers.readSwapPool();
    assert.equal(pool.pool, POOL);
    assert.equal(pool.token0, WBNB);
    assert.ok(pool.liquidity > 0n);
  });

  it("quotes through the QuoterV2 struct form on the venue's fee tier", async () => {
    const { readers, calls } = fixture();
    const out = await readers.quote({ tokenIn: WBNB, tokenOut: USDT, amountInWei: 1n });
    assert.equal(out, 3_000n);
    const quoted = calls.filter((call) => call.data.startsWith(SEL.quoteExactInputSingle));
    assert.equal(quoted.length, 1);
    assert.equal(quoted[0]?.to, QUOTER.toLowerCase());
  });
});
