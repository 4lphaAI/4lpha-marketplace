/**
 * `AltanaProvider.readFourMemeQuote`, against a MOCKED viem transport.
 *
 * No socket is opened here and none may be: the whole point of moving the
 * Four.Meme quote onto the provider is that it rides the same chain-id-pinned
 * client every other read uses, and a test that reached a live RPC would prove
 * nothing about the pinning and would fail whenever BNB Chain hiccuped.
 *
 * The scripted node below answers `eth_call` by SELECTOR, and the selectors are
 * the same independently-computed, bytecode-verified literals recorded in
 * `src/wallet/abis.ts`:
 *
 *   0x1f69565f getTokenInfo(address)
 *   0xe21b103a tryBuy(address,uint256,uint256)
 *   0xc6f43e8c trySell(address,uint256)
 *
 * Return data is hand-encoded from the output types with `encodeAbiParameters`,
 * so a field reorder in the ABI fragment shows up as a wrong NUMBER rather than
 * as a decode failure — which is the failure mode that would actually cost
 * money.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  getAddress,
  numberToHex,
  zeroAddress,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { BNB_TESTNET } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import { ExecutionPlaneError, type FourMemeQuote } from "../src/core/types.js";

const HELPER = getAddress("0xF251F83e40a78868FcfA3FA4599Dad6494E46034");
/** A second, deliberately different helper: proves the PIN is what is used. */
const OTHER_HELPER = getAddress("0x00000000000000000000000000000000000de1be");
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
const MANAGER = getAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b");
const QUOTE_TOKEN = getAddress("0x55d398326f99059fF775485246999027B3197955");

const SELECTORS = {
  getTokenInfo: "0x1f69565f",
  tryBuy: "0xe21b103a",
  trySell: "0xc6f43e8c",
} as const;

const TOKEN_INFO_OUTPUTS = [
  { type: "uint256" },
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "bool" },
] as const;

const TRY_BUY_OUTPUTS = [
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
] as const;

const TRY_SELL_OUTPUTS = [
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
] as const;

type TokenInfoScript = {
  readonly version?: bigint;
  readonly tokenManager?: Address;
  readonly quote?: Address;
  readonly liquidityAdded?: boolean;
};

type TryBuyScript = {
  readonly tokenManager?: Address;
  readonly quote?: Address;
  readonly estimatedAmount?: bigint;
  readonly amountMsgValue?: bigint;
  readonly amountApproval?: bigint;
  readonly amountFunds?: bigint;
};

type TrySellScript = {
  readonly tokenManager?: Address;
  readonly quote?: Address;
  readonly funds?: bigint;
  readonly fee?: bigint;
};

function encodeTokenInfo(s: TokenInfoScript): Hex {
  return encodeAbiParameters(TOKEN_INFO_OUTPUTS, [
    s.version ?? 2n,
    s.tokenManager ?? MANAGER,
    s.quote ?? getAddress(zeroAddress),
    0n,
    100n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    s.liquidityAdded ?? false,
  ]);
}

function encodeTryBuy(s: TryBuyScript): Hex {
  return encodeAbiParameters(TRY_BUY_OUTPUTS, [
    s.tokenManager ?? MANAGER,
    s.quote ?? getAddress(zeroAddress),
    s.estimatedAmount ?? 4_000n,
    0n,
    0n,
    s.amountMsgValue ?? 1_010n,
    s.amountApproval ?? 0n,
    s.amountFunds ?? 1_000n,
  ]);
}

function encodeTrySell(s: TrySellScript): Hex {
  return encodeAbiParameters(TRY_SELL_OUTPUTS, [
    s.tokenManager ?? MANAGER,
    s.quote ?? getAddress(zeroAddress),
    s.funds ?? 777n,
    s.fee ?? 7n,
  ]);
}

/** A coded JSON-RPC error, so viem does not retry with slow backoff. */
class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code = -32000) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

type NodeScript = {
  /** Fixed chain id, or a getter when a test needs it to change mid-run. */
  readonly chainId?: number | (() => number);
  readonly info?: TokenInfoScript;
  readonly buy?: TryBuyScript;
  readonly sell?: TrySellScript;
  /** Make the helper reads revert, the way a dead endpoint would. */
  readonly failCalls?: boolean;
};

type ScriptedNode = {
  readonly transport: (rpcUrl: string) => Transport;
  /** Every `eth_call` the provider made: `{ to, data }`. */
  readonly calls: { readonly to: string; readonly data: string }[];
};

function scriptedNode(script: NodeScript = {}): ScriptedNode {
  const calls: { to: string; data: string }[] = [];
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    if (method === "eth_chainId") {
      const configured = script.chainId ?? BNB_TESTNET.chainId;
      return numberToHex(typeof configured === "function" ? configured() : configured);
    }
    if (method === "eth_call") {
      const call = (params as readonly { to?: string; data?: string }[])[0];
      const data = call?.data ?? "";
      calls.push({ to: call?.to ?? "", data });
      if (script.failCalls === true) {
        throw new RpcError("execution reverted");
      }
      if (data.startsWith(SELECTORS.getTokenInfo)) {
        return encodeTokenInfo(script.info ?? {});
      }
      if (data.startsWith(SELECTORS.tryBuy)) return encodeTryBuy(script.buy ?? {});
      if (data.startsWith(SELECTORS.trySell)) {
        return encodeTrySell(script.sell ?? {});
      }
      throw new RpcError(`unscripted eth_call ${data.slice(0, 10)}`);
    }
    throw new RpcError(`unscripted method ${method}`, -32601);
  };
  return { transport: () => custom({ request }), calls };
}

/** `null` means "constructed with NO pinned helper", which must refuse. */
function providerFor(node: ScriptedNode, helper: Address | null = HELPER): AltanaProvider {
  return new AltanaProvider({
    network: BNB_TESTNET,
    transport: node.transport,
    ...(helper === null ? {} : { fourMemeHelper: helper }),
  });
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

describe("readFourMemeQuote: the buy read", () => {
  it("decodes getTokenInfo and tryBuy, surfacing amountMsgValue", async () => {
    const node = scriptedNode({
      buy: {
        estimatedAmount: 4_242n,
        amountMsgValue: 1_010n,
        amountApproval: 5n,
        amountFunds: 1_000n,
      },
    });
    const quote = await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });

    assert.deepEqual(quote, {
      version: 2,
      tokenManager: MANAGER,
      quoteToken: null,
      liquidityAdded: false,
      estimatedOutWei: 4_242n,
      msgValueWei: 1_010n,
      approvalWei: 5n,
      fundsWei: 1_000n,
    });
    assert.ok(
      quote.msgValueWei !== undefined && quote.msgValueWei > 1_000n,
      "the venue fee is on top, so msgValue exceeds funds",
    );
  });

  it("makes exactly two calls, both to the PINNED helper", async () => {
    const node = scriptedNode();
    await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });
    assert.equal(node.calls.length, 2);
    for (const call of node.calls) {
      assert.equal(
        call.to.toLowerCase(),
        HELPER.toLowerCase(),
        "the helper address is pinned; nothing else may be read",
      );
    }
    assert.ok(node.calls[0]?.data.startsWith(SELECTORS.getTokenInfo));
    assert.ok(node.calls[1]?.data.startsWith(SELECTORS.tryBuy));
  });

  it("calls tryBuy with amount = 0 and funds = amountWei", async () => {
    // The AMAP ("spend these funds") sizing. `amount` must be zero: passing the
    // funds there would ask for that many TOKENS instead.
    const node = scriptedNode();
    await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 0x1234n,
    });
    const data = node.calls[1]?.data ?? "";
    assert.equal(data.slice(10, 10 + 64), TOKEN.slice(2).toLowerCase().padStart(64, "0"));
    assert.equal(data.slice(10 + 64, 10 + 128), "0".repeat(64), "amount must be 0");
    assert.equal(
      data.slice(10 + 128, 10 + 192),
      (0x1234n).toString(16).padStart(64, "0"),
      "funds must be the caller's amountWei",
    );
  });

  it("uses whichever helper address was pinned, and only that one", async () => {
    const node = scriptedNode();
    await providerFor(node, OTHER_HELPER).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1n,
    });
    for (const call of node.calls) {
      assert.equal(call.to.toLowerCase(), OTHER_HELPER.toLowerCase());
    }
  });
});

describe("readFourMemeQuote: the sell read", () => {
  it("decodes getTokenInfo and trySell", async () => {
    const node = scriptedNode({ sell: { funds: 999n } });
    const quote: FourMemeQuote = await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "sell",
      amountWei: 5_000n,
    });
    assert.equal(quote.msgValueWei, undefined, "a sell carries no money-in field");
    assert.deepEqual(quote, {
      version: 2,
      tokenManager: MANAGER,
      quoteToken: null,
      liquidityAdded: false,
      estimatedFundsOutWei: 999n,
    });
    assert.ok(node.calls[1]?.data.startsWith(SELECTORS.trySell));
    assert.equal(
      node.calls.filter((c) => c.data.startsWith(SELECTORS.tryBuy)).length,
      0,
      "a sell must never ask what a buy would cost",
    );
  });
});

describe("readFourMemeQuote: what getTokenInfo is authoritative for", () => {
  it("passes the version through as a number", async () => {
    const node = scriptedNode({ info: { version: 1n } });
    const quote = await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });
    assert.equal(quote.version, 1);
  });

  it("passes the graduation flag through", async () => {
    const node = scriptedNode({ info: { liquidityAdded: true } });
    const quote = await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });
    assert.equal(quote.liquidityAdded, true);
  });

  it("reports a non-native quote currency as an address, not as null", async () => {
    const node = scriptedNode({
      info: { quote: QUOTE_TOKEN },
      buy: { quote: QUOTE_TOKEN },
    });
    const quote = await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });
    assert.equal(quote.quoteToken, QUOTE_TOKEN);
  });

  it("normalizes the zero quote address to null", async () => {
    const node = scriptedNode({ info: { quote: getAddress(zeroAddress) } });
    const quote = await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });
    assert.equal(quote.quoteToken, null);
  });

  it("returns the all-zero non-token record rather than inventing a failure", async () => {
    // VERIFIED on mainnet: the helper answers WBNB or a random EOA with all
    // zeros and does NOT revert. The provider must report exactly that, so the
    // route's bounds — not a guess made here — are what refuse the trade.
    const node = scriptedNode({
      info: { version: 0n, tokenManager: getAddress(zeroAddress) },
      buy: {
        tokenManager: getAddress(zeroAddress),
        estimatedAmount: 0n,
        amountMsgValue: 0n,
        amountFunds: 0n,
      },
    });
    const quote = await providerFor(node).readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });
    assert.equal(quote.version, 0);
    assert.equal(quote.tokenManager, getAddress(zeroAddress));
    assert.equal(quote.msgValueWei, 0n);
    assert.equal(quote.fundsWei, 0n);
    assert.equal(quote.estimatedOutWei, 0n);
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-closed                                                                */
/* -------------------------------------------------------------------------- */

describe("readFourMemeQuote: fails closed", () => {
  it("throws a typed error when the RPC call fails", async () => {
    const node = scriptedNode({ failCalls: true });
    await assert.rejects(
      providerFor(node).readFourMemeQuote({
        token: TOKEN,
        side: "buy",
        amountWei: 1_000n,
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof ExecutionPlaneError,
          "a raw viem error would bypass the route's typed handling",
        );
        return true;
      },
    );
  });

  it("throws when the endpoint serves the WRONG CHAIN", async () => {
    // The pinned client refuses the endpoint before any contract read happens,
    // so a mainnet RPC configured under a testnet network can never answer a
    // quote that a testnet-shaped transaction would then act on.
    const node = scriptedNode({ chainId: 56 });
    await assert.rejects(
      providerFor(node).readFourMemeQuote({
        token: TOKEN,
        side: "buy",
        amountWei: 1_000n,
      }),
      (error: unknown) => error instanceof ExecutionPlaneError,
    );
    assert.equal(node.calls.length, 0, "no contract read may happen off-chain-id");
  });

  it("throws when NO helper is pinned", async () => {
    const node = scriptedNode();
    await assert.rejects(
      providerFor(node, null).readFourMemeQuote({
        token: TOKEN,
        side: "buy",
        amountWei: 1_000n,
      }),
      (error: unknown) => error instanceof ExecutionPlaneError,
    );
    assert.equal(node.calls.length, 0, "and it reads nothing at all");
  });

  it("throws when tryBuy names a DIFFERENT manager than getTokenInfo", async () => {
    const node = scriptedNode({
      buy: { tokenManager: getAddress("0x000000000000000000000000000000000000BEEF") },
    });
    await assert.rejects(
      providerFor(node).readFourMemeQuote({
        token: TOKEN,
        side: "buy",
        amountWei: 1_000n,
      }),
      (error: unknown) =>
        error instanceof ExecutionPlaneError &&
        /different token managers/i.test(error.message),
    );
  });

  it("throws when trySell names a DIFFERENT manager than getTokenInfo", async () => {
    const node = scriptedNode({
      sell: { tokenManager: getAddress("0x000000000000000000000000000000000000BEEF") },
    });
    await assert.rejects(
      providerFor(node).readFourMemeQuote({
        token: TOKEN,
        side: "sell",
        amountWei: 1_000n,
      }),
      (error: unknown) => error instanceof ExecutionPlaneError,
    );
  });

  it("throws when the two reads disagree about the quote currency", async () => {
    // A helper that says "native" once and "USDT" once is a helper whose
    // numbers describe two different trades. Picking either would be a guess.
    const node = scriptedNode({ buy: { quote: QUOTE_TOKEN } });
    await assert.rejects(
      providerFor(node).readFourMemeQuote({
        token: TOKEN,
        side: "buy",
        amountWei: 1_000n,
      }),
      (error: unknown) =>
        error instanceof ExecutionPlaneError &&
        /different quote currencies/i.test(error.message),
    );
  });

  it("throws when getTokenInfo says quote-token and tryBuy says native", async () => {
    const node = scriptedNode({ info: { quote: QUOTE_TOKEN } });
    await assert.rejects(
      providerFor(node).readFourMemeQuote({
        token: TOKEN,
        side: "buy",
        amountWei: 1_000n,
      }),
      (error: unknown) =>
        error instanceof ExecutionPlaneError &&
        /different quote currencies/i.test(error.message),
    );
  });

  it("does not cache a failed connection", async () => {
    // A transient outage — or a briefly-misconfigured endpoint — must not
    // disable the venue for the lifetime of the process.
    let chainId = 56;
    const node = scriptedNode({ chainId: () => chainId });
    const provider = providerFor(node);
    await assert.rejects(
      provider.readFourMemeQuote({ token: TOKEN, side: "buy", amountWei: 1n }),
    );
    chainId = BNB_TESTNET.chainId;
    const quote = await provider.readFourMemeQuote({
      token: TOKEN,
      side: "buy",
      amountWei: 1_000n,
    });
    assert.equal(quote.version, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* The flap Portal read (PHASE2.4)                                            */
/* -------------------------------------------------------------------------- */

/**
 * The other pinned venue read, and it lives here for the same reason the
 * Four.Meme one does: both are `eth_call`s over the provider's chain-id-pinned
 * client, and both are mocked at the transport so no socket is ever opened.
 *
 * The return data is hand-encoded from `TokenStateV5`'s twelve fields, so a
 * REORDER in the ABI fragment surfaces as a wrong VALUE rather than as a decode
 * failure — which is the failure mode that would cost money, and the one that
 * rejected PHASE2.2.
 */
const FLAP_PORTAL = getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0");
const GET_TOKEN_V5 = "0x5c4bc504";

const TOKEN_STATE_V5_OUTPUT = [
  {
    type: "tuple",
    components: [
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "address" },
      { type: "bool" },
      { type: "bytes32" },
    ],
  },
] as const;

type FlapScript = {
  readonly status?: number;
  readonly circulatingSupply?: bigint;
  readonly dexSupplyThresh?: bigint;
  readonly quoteTokenAddress?: Address;
  readonly nativeToQuoteSwapEnabled?: boolean;
  readonly extensionID?: Hex;
  readonly revert?: boolean;
};

function flapNode(script: FlapScript = {}): (rpcUrl: string) => Transport {
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
    if (method === "eth_call") {
      const data = (params as readonly { data?: Hex }[])[0]?.data ?? "0x";
      if (!data.startsWith(GET_TOKEN_V5)) {
        throw new RpcError(`unscripted eth_call ${data.slice(0, 10)}`);
      }
      if (script.revert === true) {
        // What the Portal really answers for a non-flap address: a revert with
        // its own selector and the offending address, never a zero record.
        throw new RpcError("execution reverted: 0xde6137d1");
      }
      return encodeAbiParameters(TOKEN_STATE_V5_OUTPUT, [
        [
          script.status ?? 1,
          6_890_000_000_000_000_000n,
          script.circulatingSupply ?? 449_155_977n * 10n ** 18n,
          25_000_000_000n,
          5,
          6_141_000_000_000_000_000n,
          417_000_000_000_000_000_000_000n,
          105_000_000_000_000_000_000_000_000n,
          script.dexSupplyThresh ?? 800_000_000n * 10n ** 18n,
          script.quoteTokenAddress ?? getAddress(zeroAddress),
          script.nativeToQuoteSwapEnabled ?? false,
          script.extensionID ?? (`0x${"00".repeat(32)}` as Hex),
        ],
      ]);
    }
    throw new RpcError(`unscripted method ${method}`, -32601);
  };
  return () => custom({ request });
}

describe("readFlapTokenState", () => {
  it("decodes TokenStateV5 in the chain's field order", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: flapNode(),
      flapPortal: FLAP_PORTAL,
    });
    const state = await provider.readFlapTokenState({ token: TOKEN });
    assert.equal(state.status, 1);
    assert.equal(state.quoteToken, null, "0x0 means the curve is native-quoted");
    assert.equal(state.nativeToQuoteSwapEnabled, false);
    assert.equal(state.extensionId, `0x${"00".repeat(32)}`);
    assert.equal(state.dexSupplyThresh, 800_000_000n * 10n ** 18n);
    assert.equal(state.circulatingSupply, 449_155_977n * 10n ** 18n);
  });

  it("surfaces an ERC-20 quote token rather than flattening it to null", async () => {
    const quote = getAddress("0x205812CdBed920aFf76C6580abD681a46D11efc7");
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: flapNode({ quoteTokenAddress: quote }),
      flapPortal: FLAP_PORTAL,
    });
    assert.equal((await provider.readFlapTokenState({ token: TOKEN })).quoteToken, quote);
  });

  it("throws a sanitized typed error when the Portal reverts", async () => {
    // Fail-closed WITHOUT any help from us: unlike the Four.Meme helper, this
    // read cannot succeed for an address that is not a flap token.
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: flapNode({ revert: true }),
      flapPortal: FLAP_PORTAL,
    });
    await assert.rejects(
      provider.readFlapTokenState({ token: TOKEN }),
      (error: unknown) => error instanceof ExecutionPlaneError,
    );
  });

  it("refuses when no Portal is pinned, rather than calling 0x0", async () => {
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: flapNode(),
    });
    await assert.rejects(
      provider.readFlapTokenState({ token: TOKEN }),
      (error: unknown) =>
        error instanceof ExecutionPlaneError && /no flap portal/i.test(error.message),
    );
  });
});
