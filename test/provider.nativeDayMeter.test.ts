/**
 * `AltanaProvider.nativeDayMeter`, against a MOCKED viem transport.
 *
 * This is the read PHASE2.5 F1 refuses on and F4 reports, so the things worth
 * pinning are not "does it decode" but the three choices inside it that a
 * plausible-looking edit would get wrong and no other test would notice:
 *
 *   1. **`currentSpent`, never `spent`** (PHASE2.5-REVIEW M2). The tuple carries
 *      BOTH, they answer different questions, and every meter reader in this
 *      repo already uses `currentSpent` — `live-lp` even measures the relay fee
 *      as a delta between two of them. Reading `spent` would still typecheck,
 *      still return a number, and silently size the exit reserve against the
 *      wrong period.
 *   2. **The DAY row is selected BY PERIOD**, not by being the first native row.
 *      Provisioning writes TWO zero-address rows, day and minute
 *      (`scripts/provision-agent.ts`), so "the first native row" is already the
 *      wrong rule and happens to be right only by row order.
 *   3. **Ambiguity REFUSES.** Two day rows would mean the account is answering
 *      something this code does not model, and picking one of them is the silent
 *      wrong-period read again. A throw reaches the buy path as an unreadable
 *      meter, which fails closed.
 *
 * No socket is opened and none may be.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  getAddress,
  numberToHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { BNB_TESTNET } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import {
  ExecutionPlaneError,
  InfrastructureError,
  type NativeDayMeter,
} from "../src/core/types.js";

const WALLET = getAddress("0x00000000000000000000000000000000000000A1");
const TOKEN_A = getAddress("0x00000000000000000000000000000000000000AA");
const TOKEN_B = getAddress("0x00000000000000000000000000000000000000BB");

/** An uncompressed SEC1 key. Only its hash is used, to find the meter row. */
const PUBLIC_KEY: Hex = `0x04${"11".repeat(64)}`;

const SPEND_INFOS = toFunctionSelector("function spendInfos(bytes32)");

const PERIOD = { minute: 1, day: 2, week: 3 } as const;

const ROW_TUPLE = [
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
] as const;

type Row = {
  readonly token: Address;
  readonly period: number;
  readonly limit: bigint;
  /** The PREVIOUS period's total. Deliberately different from currentSpent. */
  readonly spent: bigint;
  readonly currentSpent: bigint;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    token: getAddress(zeroAddress),
    period: PERIOD.day,
    limit: 1_000n,
    spent: 999n,
    currentSpent: 100n,
    ...overrides,
  };
}

function encodeRows(rows: readonly Row[]): Hex {
  return encodeAbiParameters(ROW_TUPLE, [
    rows.map((r) => ({
      token: r.token,
      period: r.period,
      limit: r.limit,
      spent: r.spent,
      lastUpdated: 0n,
      currentSpent: r.currentSpent,
      current: 0n,
    })),
  ]);
}

class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code = -32000) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** A node whose call reverts with a message the policy classifier recognises. */
function revertingProvider(reason: string): AltanaProvider {
  const request = async ({ method }: { method: string }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
    throw new RpcError(`execution reverted: ${reason}`, 3);
  };
  const transport: (rpcUrl: string) => Transport = () => custom({ request });
  return new AltanaProvider({ network: BNB_TESTNET, transport });
}

/** A node whose `spendInfos` call reverts, the way a dead endpoint would. */
function failingProvider(): AltanaProvider {
  const request = async ({ method }: { method: string }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
    throw new RpcError("execution reverted");
  };
  const transport: (rpcUrl: string) => Transport = () => custom({ request });
  return new AltanaProvider({ network: BNB_TESTNET, transport });
}

function providerFor(rows: readonly Row[]): AltanaProvider {
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
    if (method === "eth_call") {
      const call = (params as readonly { to?: string; data?: string }[])[0];
      const data = call?.data ?? "";
      if (!data.startsWith(SPEND_INFOS)) {
        throw new RpcError(`unscripted eth_call ${data.slice(0, 10)}`);
      }
      return encodeRows(rows);
    }
    throw new RpcError(`unscripted method ${method}`, -32601);
  };
  const transport: (rpcUrl: string) => Transport = () => custom({ request });
  return new AltanaProvider({ network: BNB_TESTNET, transport });
}

async function read(rows: readonly Row[]) {
  return providerFor(rows).nativeDayMeter({
    walletAddress: WALLET,
    publicKey: PUBLIC_KEY,
  });
}

/** The DAY reading, or a failure naming what came back instead. */
async function readDay(rows: readonly Row[]): Promise<NativeDayMeter> {
  const reading = await read(rows);
  if (reading.kind !== "day") {
    throw new Error(`expected a DAY reading, got ${reading.kind}`);
  }
  return reading;
}

describe("AltanaProvider.nativeDayMeter", () => {
  it("reports currentSpent, NOT spent (REVIEW M2)", async () => {
    const meter = await readDay([row({ limit: 1_000n, spent: 999n, currentSpent: 100n })]);
    assert.equal(meter.currentSpentWei, 100n);
    assert.equal(meter.limitWei, 1_000n);
    // 900, not 1 — the difference between "today's headroom" and a number that
    // would have refused every buy for the rest of the day.
    assert.equal(meter.limitWei - meter.currentSpentWei, 900n);
  });

  it("selects the DAY row by PERIOD even when a minute row comes first", async () => {
    const meter = await readDay([
      row({ period: PERIOD.minute, limit: 5n, currentSpent: 4n }),
      row({ period: PERIOD.day, limit: 1_000n, currentSpent: 100n }),
    ]);
    assert.equal(meter.limitWei, 1_000n, "the minute row is not the day's budget");
    assert.equal(meter.currentSpentWei, 100n);
  });

  it("REFUSES rather than choosing when the account reports two day rows", async () => {
    // Fail closed: this reaches the buy path as an unreadable meter.
    await assert.rejects(
      read([
        row({ limit: 1_000n, currentSpent: 100n }),
        row({ limit: 7n, currentSpent: 6n }),
      ]),
      /more than one daily native spend row/,
    );
  });

  it("distinguishes a native grant at another period from NO native grant (AUDIT A6)", async () => {
    // These were one `null` and the owner view rendered the reassuring reading
    // for both. They are not the same account: the first is unmetered today, the
    // second cannot spend native at all — FINDINGS (h), the batch reverts in
    // the relay's simulation. The provider holds the array that tells them
    // apart, so it must not throw that away.
    assert.equal((await read([row({ period: PERIOD.week })])).kind, "other-period");
    assert.equal((await read([row({ period: PERIOD.minute })])).kind, "other-period");
    assert.equal((await read([])).kind, "no-native-grant");
    assert.equal(
      (await read([row({ token: TOKEN_A, period: PERIOD.day, limit: 5n })])).kind,
      "no-native-grant",
      "token rows are not a native grant",
    );
  });

  it("counts only the tokens this key can actually SELL", async () => {
    // The exit reserve is one relay reimbursement per sellable token, so a
    // zero-limit row is not one — and the native row is never a token.
    const meter = await readDay([
      row(),
      row({ token: TOKEN_A, period: PERIOD.day, limit: 5n }),
      row({ token: TOKEN_B, period: PERIOD.day, limit: 0n }),
    ]);
    assert.equal(meter.grantedTokenCount, 1);
  });

  it("counts a token grant at ANY period, not only the day", async () => {
    // The count answers "how many exits might this key still owe", which is not
    // a per-period question — a weekly token cap still buys an exit.
    const meter = await readDay([
      row(),
      row({ token: TOKEN_A, period: PERIOD.week, limit: 5n }),
    ]);
    assert.equal(meter.grantedTokenCount, 1);
  });

  it("counts DISTINCT TOKENS, not spendInfos rows (AUDIT A7)", async () => {
    // `spendInfos` returns one row per (token, period) pair, and
    // `owner-add-spend-limit` can add a second period for a token that already
    // has one. Counting rows doubled that token's share of the reserve — and,
    // worse, published the doubled number to the owner as "tokens this session
    // can sell", which is simply false.
    const meter = await readDay([
      row(),
      row({ token: TOKEN_A, period: PERIOD.day, limit: 5n }),
      row({ token: TOKEN_A, period: PERIOD.week, limit: 5n }),
      row({ token: TOKEN_B, period: PERIOD.day, limit: 9n }),
    ]);
    assert.equal(meter.grantedTokenCount, 2, "two tokens, three rows");
  });

  it("REJECTS on a node that never answers, as a transport failure (AUDIT A4)", { timeout: 2_000 }, async () => {
    // PHASE2.5-FIXREVIEW F3: the deadline was pinned by NOTHING. The reviewer
    // deleted `withDeadline` from the provider and the whole suite stayed green,
    // including the test whose name claimed to cover it. A bound is the only
    // thing between a slow node and a trade request held open above the submit.
    //
    // The timeout is injectable for exactly this: a five-second constant cannot
    // be pinned offline without a five-second test.
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: () =>
        custom({
          request: async ({ method }: { method: string }) => {
            if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
            // Never settles — the node that accepted the connection and then
            // went away, which is the case a timeout exists for.
            return new Promise(() => {});
          },
        }),
      chainReadTimeoutMs: 25,
    });

    await assert.rejects(
      provider.nativeDayMeter({ walletAddress: WALLET, publicKey: PUBLIC_KEY }),
      (error: unknown) => {
        assert.ok(error instanceof InfrastructureError, "a TRANSPORT class");
        assert.equal(error.code, "INFRASTRUCTURE_ERROR");
        return true;
      },
    );
  });

  it("bounds the CONNECT leg too, not just the read (FIXREVIEW2 G4)", { timeout: 2_000 }, async () => {
    // `#connect` probes each configured RPC URL with `getChainId()` and no
    // timeout of its own, and its promise is memoised — so the first caller in
    // a process pays the whole probe, and here that caller can be a trade
    // request sitting above a submit. The deadline used to start AFTER that.
    //
    // This node accepts the connection and never answers the chain-id probe,
    // so the read is never even reached.
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: () =>
        custom({
          request: async () => new Promise(() => {}),
        }),
      chainReadTimeoutMs: 25,
    });

    await assert.rejects(
      provider.nativeDayMeter({ walletAddress: WALLET, publicKey: PUBLIC_KEY }),
      (error: unknown) => {
        assert.ok(error instanceof InfrastructureError, "a TRANSPORT class");
        assert.equal(error.code, "INFRASTRUCTURE_ERROR");
        return true;
      },
    );
  });

  it("a failed read never carries a POLICY class (FIXREVIEW F4)", async () => {
    // `mapProviderError` classifies on revert evidence FIRST, so a node that
    // decoded `ExceededSpendLimit` out of this `view` call would hand back
    // `CAP_EXCEEDED` — and the route would emit `deniedBy: "transport"` carrying
    // a policy `failureCode`, which is the receipt shape A3 exists to prevent,
    // reached from the other end. A read is not the account refusing anything.
    const provider = revertingProvider("ExceededSpendLimit()");
    await assert.rejects(
      provider.nativeDayMeter({ walletAddress: WALLET, publicKey: PUBLIC_KEY }),
      (error: unknown) => {
        assert.ok(error instanceof ExecutionPlaneError);
        assert.equal(error.code, "PROVIDER_ERROR");
        return true;
      },
    );
  });

  it("classifies a failed read through mapProviderError (AUDIT A3)", async () => {
    // The read used to let a raw viem error escape, which the route then wrapped
    // as a generic PROVIDER_ERROR and rendered as a POLICY refusal — an outage
    // wearing a policy rejection's clothes, which REVIEW M4 made normative must
    // not happen. `mapProviderError` is the plane's ONE classifier.
    const provider = failingProvider();
    await assert.rejects(
      provider.nativeDayMeter({ walletAddress: WALLET, publicKey: PUBLIC_KEY }),
      (error: unknown) => {
        assert.ok(error instanceof ExecutionPlaneError, "a typed plane error");
        assert.notEqual(
          error.constructor.name,
          "Error",
          "and never the transport library's own error object",
        );
        return true;
      },
    );
  });
});
