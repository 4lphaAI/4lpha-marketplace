/**
 * LP chain-reader unit tests — the PURE parts only, over a scripted viem
 * transport (no socket anywhere):
 *
 *   - `poolState` PINS the finalized tag: the block is fetched with
 *     `eth_getBlockByNumber("finalized")` and every state read carries THAT
 *     block number — asserted on the fake transport's recorded calls;
 *   - the burned-token revert maps to the literal `"burned"` (POSITIVE
 *     confirmation, Rev2 item 32) while a transport failure THROWS — an RPC
 *     outage must never read as "burned";
 *   - the three receipt parsers: minted tokenId from the NFPM's ERC-721
 *     Transfer-from-zero (4 topics, telling it apart from ERC-20), collect
 *     amounts from the NFPM Collect event, swap legs oriented by the pool the
 *     PANCAKE Swap topic locates — and every ambiguity THROWS;
 *   - `onChainNativeDailyCapWei` returns the zero-address DAY row (serialized
 *     period 2) and throws when the account holds none.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  getAddress,
  keccak256,
  padHex,
  stringToBytes,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  createLpChainReaders,
  resolveLpRpcUrls,
  SPEND_PERIOD_DAY,
} from "../src/lp/readers.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";

const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const FACTORY = getAddress("0xBBbBBBbbbBBbbbBbbBbbbbBBbBBbBbBbBbBBbBB1");
const QUOTER = getAddress("0xBBBbBbbBbbBBBbBbbbbBbBBbbBBBbbbBbBBbbBB2");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const WALLET = getAddress("0xDdDDdddDDDddDdDDDDDdDdDDdDDdDdDDDdDddDd1");
const TOKEN_IN = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN_OUT = getAddress("0x2222222222222222222222222222222222222222");

const SEL = {
  slot0: toFunctionSelector("slot0()"),
  liquidity: toFunctionSelector("liquidity()"),
  tickSpacing: toFunctionSelector("tickSpacing()"),
  observe: toFunctionSelector("observe(uint32[])"),
  positions: toFunctionSelector("positions(uint256)"),
  getPool: toFunctionSelector("getPool(address,address,uint24)"),
  collect: toFunctionSelector("collect((uint256,address,uint128,uint128))"),
  spendInfos: toFunctionSelector("spendInfos(bytes32)"),
} as const;

const TRANSFER_TOPIC = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const COLLECT_TOPIC = keccak256(stringToBytes("Collect(uint256,address,uint256,uint256)"));
const PANCAKE_SWAP_TOPIC = keccak256(
  stringToBytes(
    "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
  ),
);

const FINALIZED_NUMBER = 100n;
const FINALIZED_HEX = "0x64";

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
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    timestamp: "0x0",
    transactions: [],
    uncles: [],
    baseFeePerGas: null,
  };
}

type LogJson = {
  address: string;
  topics: readonly string[];
  data: string;
  [key: string]: unknown;
};

function logJson(address: Address, topics: readonly Hex[], data: Hex): LogJson {
  return {
    address,
    topics,
    data,
    blockNumber: FINALIZED_HEX,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"aa".repeat(32)}`,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

function receiptJson(logs: readonly LogJson[]): Record<string, unknown> {
  return {
    transactionHash: `0x${"aa".repeat(32)}`,
    transactionIndex: "0x0",
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: FINALIZED_HEX,
    from: WALLET,
    to: WALLET,
    cumulativeGasUsed: "0x0",
    gasUsed: "0x0",
    contractAddress: null,
    logs,
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    effectiveGasPrice: "0x0",
    type: "0x0",
  };
}

function pancakeSwapData(amount0: bigint, amount1: bigint): Hex {
  return encodeAbiParameters(
    [
      { type: "int256" },
      { type: "int256" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" },
      { type: "uint128" },
      { type: "uint128" },
    ],
    [amount0, amount1, 2n ** 96n, 1_000n, 0, 0n, 0n],
  );
}

type CallRecord = { method: string; params: unknown };

type HandlerOverrides = {
  /** Per-selector eth_call answers ("throw:<msg>" throws). */
  readonly calls?: Map<string, Hex | (() => Hex)>;
  readonly callError?: (selector: string) => Error | undefined;
  readonly receiptLogs?: readonly LogJson[];
};

function makeTransportFixture(overrides: HandlerOverrides = {}): {
  readers: ReturnType<typeof createLpChainReaders>;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];

  const defaults = new Map<string, Hex>([
    [
      SEL.slot0,
      encodeAbiParameters(
        [
          { type: "uint160" },
          { type: "int24" },
          { type: "uint16" },
          { type: "uint16" },
          { type: "uint16" },
          { type: "uint32" },
          { type: "bool" },
        ],
        [2n ** 96n, 42, 7, 500, 500, 0, true],
      ),
    ],
    [SEL.liquidity, encodeAbiParameters([{ type: "uint128" }], [10n ** 24n])],
    [SEL.tickSpacing, encodeAbiParameters([{ type: "int24" }], [50])],
    [
      SEL.observe,
      // secondsAgos [300, 0]: cumulative delta 30_000 over 300s ⇒ mean tick 100.
      encodeAbiParameters(
        [{ type: "int56[]" }, { type: "uint160[]" }],
        [[0n, 30_000n], [0n, 0n]],
      ),
    ],
    [
      SEL.positions,
      encodeAbiParameters(
        [
          { type: "uint96" },
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "int24" },
          { type: "uint128" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint128" },
          { type: "uint128" },
        ],
        [0n, zeroAddress, TOKEN_IN, TOKEN_OUT, 2500, -500, 500, 1_000n, 0n, 0n, 5n, 6n],
      ),
    ],
    [SEL.getPool, encodeAbiParameters([{ type: "address" }], [POOL])],
    [
      SEL.collect,
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [11n, 22n]),
    ],
  ]);

  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "eth_chainId") return "0x38"; // 56
    if (method === "eth_getBlockByNumber") return blockJson();
    if (method === "eth_getTransactionReceipt") {
      return receiptJson(overrides.receiptLogs ?? []);
    }
    if (method === "eth_call") {
      const [tx] = params as [{ to?: string; data?: string }];
      const selector = (tx.data ?? "0x").slice(0, 10).toLowerCase();
      const error = overrides.callError?.(selector);
      if (error !== undefined) throw error;
      const scripted = overrides.calls?.get(selector);
      if (scripted !== undefined) {
        return typeof scripted === "function" ? scripted() : scripted;
      }
      const answer = defaults.get(selector);
      if (answer === undefined) throw new Error(`unscripted eth_call selector ${selector}`);
      return answer;
    }
    throw new Error(`unscripted RPC method ${method}`);
  };

  const readers = createLpChainReaders({
    network: { chain: bsc, chainId: 56, publicRpcUrl: "http://scripted.invalid" },
    // retryCount 0: a scripted error is the answer, not a flake to retry.
    transport: () => custom({ request }, { retryCount: 0 }),
    nfpm: NFPM,
    factory: FACTORY,
    quoterV2: QUOTER,
    twapWindowSeconds: 300,
  });
  return { readers, calls };
}

/* -------------------------------------------------------------------------- */

describe("lp readers: finality discipline", () => {
  it("poolState pins every state read to the finalized block", async () => {
    const { readers, calls } = makeTransportFixture();
    const state = await readers.poolState(POOL);

    // The finalized TAG was asked for…
    const blockCalls = calls.filter((c) => c.method === "eth_getBlockByNumber");
    assert.equal(blockCalls.length, 1);
    assert.deepEqual(blockCalls[0]?.params, ["finalized", false]);

    // …and every eth_call the read issued is pinned to that height.
    const stateCalls = calls.filter((c) => c.method === "eth_call");
    assert.ok(stateCalls.length >= 4, "slot0, liquidity, tickSpacing, observe");
    for (const call of stateCalls) {
      const [, blockRef] = call.params as [unknown, string];
      assert.equal(blockRef, FINALIZED_HEX, "state read not pinned to finalized");
    }

    assert.equal(state.evidence.blockNumber, FINALIZED_NUMBER);
    assert.equal(state.evidence.finalizedBlockNumber, FINALIZED_NUMBER);
    assert.equal(state.currentTick, 42);
    assert.equal(state.tickSpacing, 50);
    assert.equal(state.evidence.observationCardinality, 500);
    // Mean tick 100 over the 300s window ⇒ the TWAP price is its sqrt ratio.
    assert.equal(state.evidence.twapSqrtPriceX96, getSqrtRatioAtTick(100));
  });

  it("pins UNKNOWN-resolution position evidence to the finalized height it read", async () => {
    const { readers, calls } = makeTransportFixture();
    const readFinalizedBlock = readers.finalizedBlockNumber;
    if (readFinalizedBlock === undefined) {
      assert.fail("production readers must expose the finalized-block seam");
    }
    const finalizedBlock = await readFinalizedBlock();
    await readers.positions(1n, finalizedBlock);

    assert.equal(finalizedBlock, FINALIZED_NUMBER);
    const positionCall = calls.find((call) => {
      if (call.method !== "eth_call") return false;
      const [tx] = call.params as [{ data?: string }];
      return tx.data?.slice(0, 10).toLowerCase() === SEL.positions;
    });
    assert.notEqual(positionCall, undefined);
    const [, blockRef] = positionCall?.params as [unknown, string];
    assert.equal(blockRef, FINALIZED_HEX);
  });
});

describe("lp readers: burned-revert mapping", () => {
  it("maps the burned-token revert to 'burned' — positive confirmation", async () => {
    const { readers } = makeTransportFixture({
      callError: (selector) =>
        selector === SEL.positions
          ? new Error("execution reverted: Invalid token ID")
          : undefined,
    });
    assert.equal(await readers.positions(1n), "burned");
  });

  it("a transport failure THROWS — an outage never reads as burned", async () => {
    const { readers } = makeTransportFixture({
      callError: (selector) =>
        selector === SEL.positions ? new Error("fetch failed") : undefined,
    });
    await assert.rejects(readers.positions(1n));
  });

  it("positionFees simulates collect(max,max) and maps the burned revert too", async () => {
    const { readers } = makeTransportFixture();
    assert.deepEqual(await readers.positionFees(1n, WALLET), {
      amount0Wei: 11n,
      amount1Wei: 22n,
    });
    const burned = makeTransportFixture({
      callError: (selector) =>
        selector === SEL.collect
          ? new Error("execution reverted: Invalid token ID")
          : undefined,
    });
    assert.equal(await burned.readers.positionFees(1n, WALLET), "burned");
  });
});

/* -------------------------------------------------------------------------- */

const TX = `0x${"aa".repeat(32)}` as Hex;

function addressTopic(address: Address): Hex {
  return padHex(address, { size: 32 });
}

describe("lp readers: receipt parsers", () => {
  it("mintedTokenId reads the NFPM's ERC-721 Transfer from the zero address", async () => {
    const { readers } = makeTransportFixture({
      receiptLogs: [
        // An ERC-20 Transfer (3 topics) that shares topic0 — must be ignored.
        logJson(
          TOKEN_IN,
          [TRANSFER_TOPIC, addressTopic(WALLET), addressTopic(POOL)],
          encodeAbiParameters([{ type: "uint256" }], [1n]),
        ),
        logJson(
          NFPM,
          [
            TRANSFER_TOPIC,
            addressTopic(zeroAddress),
            addressTopic(WALLET),
            padHex("0x309", { size: 32 }), // tokenId 777
          ],
          "0x",
        ),
      ],
    });
    assert.equal(await readers.receipts.mintedTokenId(TX), 777n);
  });

  it("mintedTokenId throws when no NFPM mint Transfer is present", async () => {
    const { readers } = makeTransportFixture({ receiptLogs: [] });
    await assert.rejects(readers.receipts.mintedTokenId(TX), /expected exactly one/u);
  });

  it("collectAmounts reads the one NFPM Collect event and refuses two", async () => {
    const collectLog = logJson(
      NFPM,
      [COLLECT_TOPIC, padHex("0x309", { size: 32 })],
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [NFPM, 123n, 456n],
      ),
    );
    const { readers } = makeTransportFixture({ receiptLogs: [collectLog] });
    assert.deepEqual(await readers.receipts.collectAmounts(TX), {
      amount0Wei: 123n,
      amount1Wei: 456n,
    });

    const two = makeTransportFixture({ receiptLogs: [collectLog, collectLog] });
    await assert.rejects(two.readers.receipts.collectAmounts(TX), /found 2/u);
  });

  it("swapAmounts orients the legs by the pool the Pancake Swap topic locates", async () => {
    const logs: LogJson[] = [
      // input: wallet -> pool of TOKEN_IN
      logJson(
        TOKEN_IN,
        [TRANSFER_TOPIC, addressTopic(WALLET), addressTopic(POOL)],
        encodeAbiParameters([{ type: "uint256" }], [1_000n]),
      ),
      // output: pool -> wallet of TOKEN_OUT
      logJson(
        TOKEN_OUT,
        [TRANSFER_TOPIC, addressTopic(POOL), addressTopic(WALLET)],
        encodeAbiParameters([{ type: "uint256" }], [990n]),
      ),
      // the pool's own Swap event (Pancake 9-field signature)
      logJson(
        POOL,
        [PANCAKE_SWAP_TOPIC, addressTopic(WALLET), addressTopic(WALLET)],
        "0x",
      ),
    ];
    const { readers } = makeTransportFixture({ receiptLogs: logs });
    assert.deepEqual(await readers.receipts.swapAmounts(TX), {
      tokenIn: TOKEN_IN,
      amountInWei: 1_000n,
      tokenOut: TOKEN_OUT,
      amountOutWei: 990n,
    });
  });

  it("swapAmounts refuses a receipt without exactly one Pancake pool Swap", async () => {
    const noSwap = makeTransportFixture({
      receiptLogs: [
        logJson(
          TOKEN_IN,
          [TRANSFER_TOPIC, addressTopic(WALLET), addressTopic(POOL)],
          encodeAbiParameters([{ type: "uint256" }], [1n]),
        ),
      ],
    });
    await assert.rejects(noSwap.readers.receipts.swapAmounts(TX), /found 0 emitter/u);

    const twoPools = makeTransportFixture({
      receiptLogs: [
        logJson(POOL, [PANCAKE_SWAP_TOPIC], "0x"),
        logJson(TOKEN_OUT, [PANCAKE_SWAP_TOPIC], "0x"),
      ],
    });
    await assert.rejects(twoPools.readers.receipts.swapAmounts(TX), /found 2 emitter/u);
  });

  it("PHASE3.24 C3: expectedPoolSwap implements the complete receipt truth table", async () => {
    const read = async (
      logs: readonly LogJson[],
      baseIsToken0 = true,
    ): Promise<{ amountInWei: bigint; amountOutWei: bigint } | null> => {
      const reader = makeTransportFixture({ receiptLogs: logs }).readers.receipts.expectedPoolSwap;
      assert.ok(reader !== undefined);
      return reader(TX, POOL, baseIsToken0);
    };
    const expected = (amount0: bigint, amount1: bigint): LogJson =>
      logJson(POOL, [PANCAKE_SWAP_TOPIC], pancakeSwapData(amount0, amount1));
    const wrongPool = (amount0: bigint, amount1: bigint): LogJson =>
      logJson(TOKEN_OUT, [PANCAKE_SWAP_TOPIC], pancakeSwapData(amount0, amount1));

    assert.equal(await read([]), null, "zero Swap logs is the collect fallback");
    assert.deepEqual(await read([expected(123n, -99n)]), {
      amountInWei: 123n,
      amountOutWei: 99n,
    });
    assert.deepEqual(await read([expected(-99n, 123n)], false), {
      amountInWei: 123n,
      amountOutWei: 99n,
    });

    await assert.rejects(read([expected(1n, -1n), expected(2n, -2n)]), /found 2/u);
    await assert.rejects(read([expected(1n, -1n), wrongPool(2n, -2n)]), /found 2/u);
    await assert.rejects(read([wrongPool(1n, -1n)]), /unexpected pool/u);
    await assert.rejects(read([expected(-1n, 1n)]), /signs/u);
    await assert.rejects(read([expected(0n, -1n)]), /signs/u);
    // AUDIT A6: zero output is not proof that the owner received WBNB.
    await assert.rejects(read([expected(1n, 0n)]), /signs/u);
    await assert.rejects(
      read([logJson(POOL, [PANCAKE_SWAP_TOPIC], "0x")]),
      /malformed/u,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("lp readers: the native day meter", () => {
  const SPEND_INFO_COMPONENTS = [
    { name: "token", type: "address" },
    { name: "period", type: "uint8" },
    { name: "limit", type: "uint256" },
    { name: "spent", type: "uint256" },
    { name: "lastUpdated", type: "uint256" },
    { name: "currentSpent", type: "uint256" },
    { name: "current", type: "uint256" },
  ] as const;

  function spendInfosData(
    rows: readonly {
      token: Address;
      period: number;
      limit: bigint;
    }[],
  ): Hex {
    return encodeAbiParameters(
      [{ type: "tuple[]", components: SPEND_INFO_COMPONENTS }],
      [
        rows.map((row) => ({
          token: row.token,
          period: row.period,
          limit: row.limit,
          spent: 0n,
          lastUpdated: 0n,
          currentSpent: 0n,
          current: 0n,
        })),
      ],
    );
  }

  async function lpAgent(): Promise<AgentRecord> {
    const store = new MemoryAgentStore(null);
    const account = privateKeyToAccount(`0x${"7d".repeat(32)}`);
    return store.createAgent({
      id: "meter-agent",
      ownerAddress: WALLET,
      walletAddress: WALLET,
      custodyModel: "self-eoa",
      sessionFacts: {
        spec: { allowedCalls: [{ to: POOL }], spendCaps: [{ limit: 1n, period: "day" }], expiresAt: 2_000_000_000 },
        permissions: { calls: [], spend: [] },
        publicKey: account.publicKey,
        expiry: 2_000_000_000,
      },
      status: "armed",
    });
  }

  it("returns the zero-address DAY row (serialized period 2)", async () => {
    assert.equal(SPEND_PERIOD_DAY, 2); // pinned from porto's toSerializedSpendPeriod
    const agent = await lpAgent();
    const { readers } = makeTransportFixture({
      calls: new Map([
        [
          SEL.spendInfos,
          spendInfosData([
            { token: zeroAddress, period: 0, limit: 5n }, // minute — not it
            { token: zeroAddress, period: 2, limit: 77n }, // the day meter
            { token: TOKEN_IN, period: 2, limit: 99n }, // a token cap — not native
          ]),
        ],
      ]),
    });
    assert.equal(await readers.onChainNativeDailyCapWei(agent), 77n);
  });

  it("throws when the account enforces no daily native limit", async () => {
    const agent = await lpAgent();
    const { readers } = makeTransportFixture({
      calls: new Map([
        [SEL.spendInfos, spendInfosData([{ token: zeroAddress, period: 0, limit: 5n }])],
      ]),
    });
    await assert.rejects(
      readers.onChainNativeDailyCapWei(agent),
      /no DAILY native spend limit/u,
    );
  });
});

/**
 * The endpoint list, found by the live mainnet run (see `resolveLpRpcUrls`).
 *
 * The defect these pin was not a wrong URL — it was an ABSENT argument: the
 * Phase 3 entry points let the readers fall back to `network.publicRpcUrl`,
 * which on chain 56 cannot answer `eth_getTransactionReceipt`, so the open
 * saga's tail could never learn its minted tokenId. The list must therefore
 * LEAD with the endpoints the repo has preferred since Phase 0 and keep the
 * SDK default only as a last resort.
 */
describe("resolveLpRpcUrls", () => {
  const mainnet = {
    chain: bsc,
    chainId: 56,
    publicRpcUrl: "https://bsc-rpc.publicnode.com",
  };

  it("leads with the dataseed endpoints and keeps the SDK default last", () => {
    assert.deepEqual(resolveLpRpcUrls({}, mainnet), [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-rpc.publicnode.com",
    ]);
  });

  it("puts an explicit LP_RPC_URL override first without dropping the fallbacks", () => {
    const urls = resolveLpRpcUrls({ LP_RPC_URL: "https://private.example" }, mainnet);
    assert.equal(urls[0], "https://private.example");
    assert.equal(urls.length, 4);
  });

  it("honours SPIKE_RPC_URL when LP_RPC_URL is unset — one override name per repo", () => {
    const urls = resolveLpRpcUrls({ SPIKE_RPC_URL: "https://spike.example" }, mainnet);
    assert.equal(urls[0], "https://spike.example");
  });

  it("prefers LP_RPC_URL over SPIKE_RPC_URL when both are set", () => {
    const urls = resolveLpRpcUrls(
      { LP_RPC_URL: "https://lp.example", SPIKE_RPC_URL: "https://spike.example" },
      mainnet,
    );
    assert.equal(urls[0], "https://lp.example");
  });

  it("ignores a blank override rather than passing an empty endpoint", () => {
    assert.deepEqual(resolveLpRpcUrls({ LP_RPC_URL: "   " }, mainnet), [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-rpc.publicnode.com",
    ]);
  });

  it("adds no chain-56 endpoint to another chain — the list is keyed on the RESOLVED chain id", () => {
    assert.deepEqual(
      resolveLpRpcUrls({}, { chain: bsc, chainId: 97, publicRpcUrl: "https://testnet.example" }),
      ["https://testnet.example"],
    );
  });

  it("never repeats an endpoint when the override equals a default", () => {
    const urls = resolveLpRpcUrls(
      { LP_RPC_URL: "https://bsc-dataseed.bnbchain.org" },
      mainnet,
    );
    assert.equal(new Set(urls).size, urls.length);
    assert.equal(urls[0], "https://bsc-dataseed.bnbchain.org");
  });
});
