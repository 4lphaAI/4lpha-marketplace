/**
 * BATCHED public-chain balance reads, for the ACCOUNT read and nothing else.
 *
 * ─── WHY THIS IS A SEPARATE CLIENT ────────────────────────────────────────
 *
 * `GET /account/portfolio` measured at 10–15 s against the live plane, with
 * assets coming back `status: "unreadable"`. The cause was not the work — it is
 * ~20 trivial view calls — but the SHAPE of the work: `AltanaProvider` picks the
 * FIRST endpoint that serves `eth_chainId` and stays on it (`src/wallet/altana.ts`),
 * one JSON-RPC request per call, against public BSC dataseed nodes that throttle
 * bursts. Twenty unbatched round trips at ~411 ms each, in four sequential
 * phases, is the whole latency.
 *
 * The provider's client is NOT changed to fix that. It is the MONEY path: the LP
 * sagas' receipt and finality reads, every execute, every preflight. viem
 * transport batching there would change when a read observes a block relative to
 * a submit, which those sagas depend on. So the account read gets its OWN client,
 * built here, holding no key, submitting nothing, and reaching only `eth_call`
 * and `eth_getBalance`.
 *
 * Two mechanisms do the work:
 *
 *   `http(url, { batch: true })`  — JSON-RPC calls issued in the same tick are
 *                                   collapsed into ONE HTTP request.
 *   `batch: { multicall: true }`  — `readContract` calls in the same tick are
 *                                   aggregated through Multicall3, so N ERC-20
 *                                   `balanceOf` reads become ONE `eth_call`.
 *
 * Multicall3 sits at the canonical `0xcA11bde05977b3631167028862bE2a173976CA11`
 * on BSC and viem's own `bsc` chain definition already carries it
 * (`chain.contracts.multicall3`), so NOTHING is hardcoded here — a chain whose
 * definition lacks the deployment simply fails the read, and the caller falls
 * back to its per-call path.
 *
 * ─── THE CONTRACT ─────────────────────────────────────────────────────────
 *
 * Every method returns an array POSITIONALLY ALIGNED to its input, with `null`
 * for an entry this reader could not answer. `null` is "not read", never "zero":
 * the portfolio maps it to `status: "unreadable"`, exactly as a thrown
 * per-call read maps today. One failing token never loses the others — that is
 * what `allowFailure` buys, and it is why a bytes32-`symbol()` token still
 * yields its `decimals()`.
 */
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { ERC20_ABI } from "../wallet/abis.js";

/**
 * The ONE seam the account read takes its public balance answers through.
 * Injected exactly like {@link import("./keyStoreReader.js").KeyStoreReader} —
 * no route builds an RPC client, and an ABSENT reader is a supported
 * deployment: the portfolio then uses `deps.provider` unchanged.
 */
export type BalanceReader = {
  /** Native balance per address, aligned to input. `null` ⇒ not read. */
  nativeBalances(addresses: readonly Address[], signal?: AbortSignal): Promise<readonly (bigint | null)[]>;
  /** ERC-20 balance per (wallet, token), aligned to input. `null` ⇒ not read. */
  tokenBalances(pairs: readonly { readonly wallet: Address; readonly token: Address }[], signal?: AbortSignal): Promise<readonly (bigint | null)[]>;
  /**
   * `decimals()` / `symbol()` per token, aligned to input. OPTIONAL because it
   * is a convenience on the same batched client, not part of the balance
   * contract; absent ⇒ the portfolio reads metadata through `deps.provider`.
   * `decimals === null` ⇒ not read; a null `symbol` beside a real `decimals` is
   * the ordinary bytes32-symbol token and is NOT a failure.
   */
  tokenMetadata?(tokens: readonly Address[], signal?: AbortSignal): Promise<readonly { readonly decimals: number | null; readonly symbol: string | null }[]>;
};

export type CreateBalanceReaderOptions = {
  readonly network: {
    readonly chain: Chain;
    readonly chainId: number;
    readonly publicRpcUrl: string;
  };
  /**
   * Endpoint list — pass the SAME URLs the LP readers and the provider were
   * constructed with (`resolveLpRpcUrls`). NO env var of its own: this read has
   * no RPC posture separate from the rest of the plane and must not acquire one.
   * Unlike the KeyStore reader's first-that-answers pick, these are handed to
   * viem's `fallback` so a throttled endpoint is stepped over per REQUEST.
   */
  readonly rpcUrls?: readonly string[];
  /** Transport factory, injectable for offline tests. Defaults to batched `http`. */
  readonly transport?: (rpcUrl: string) => Transport;
};

/** Work bounds. A caller asking for more than this gets `null` for the excess. */
const MAX_ADDRESSES = 16;
const MAX_PAIRS = 128;
const MAX_TOKENS = 64;

function padded<T>(values: readonly T[], length: number, filler: T): readonly T[] {
  return values.length >= length ? values.slice(0, length) : [...values, ...Array.from({ length: length - values.length }, () => filler)];
}

export function createBalanceReader(options: CreateBalanceReaderOptions): BalanceReader {
  const { network } = options;
  const transport = options.transport ?? ((rpcUrl: string) => http(rpcUrl, { batch: true }));
  const rpcUrls =
    options.rpcUrls !== undefined && options.rpcUrls.length > 0
      ? [...new Set(options.rpcUrls)]
      : [network.publicRpcUrl];
  let connection: Promise<PublicClient> | undefined;

  async function connect(): Promise<PublicClient> {
    const client: PublicClient = createPublicClient({
      chain: network.chain,
      transport: fallback(rpcUrls.map((rpcUrl) => transport(rpcUrl))),
      batch: { multicall: true },
    });
    // Same discipline as `createKeyStoreReader`: never trust an endpoint set
    // that does not serve this chain. `fallback` already stepped over the dead
    // ones by the time this answers.
    const chainId = await client.getChainId();
    if (chainId !== network.chainId) {
      throw new Error("Configured RPC endpoints served chain " + String(chainId) + ", expected " + String(network.chainId) + ".");
    }
    return client;
  }

  async function connected(): Promise<PublicClient> {
    connection ??= connect();
    try {
      return await connection;
    } catch (cause) {
      connection = undefined; // never cache a transient outage
      throw cause;
    }
  }

  return {
    async nativeBalances(addresses, signal): Promise<readonly (bigint | null)[]> {
      void signal; // the whole read is bounded by the caller's own deadline
      const wanted = addresses.slice(0, MAX_ADDRESSES);
      let client: PublicClient;
      try { client = await connected(); } catch { return padded([], addresses.length, null); }
      // Issued in ONE tick, so the batched http transport collapses them into a
      // single HTTP request; a per-address rejection is that address's `null`.
      const results = await Promise.all(wanted.map(async (address) => {
        try { return await client.getBalance({ address: getAddress(address) }); } catch { return null; }
      }));
      return padded(results, addresses.length, null);
    },

    async tokenBalances(pairs, signal): Promise<readonly (bigint | null)[]> {
      void signal;
      const wanted = pairs.slice(0, MAX_PAIRS);
      if (wanted.length === 0) return padded([], pairs.length, null);
      let client: PublicClient;
      try { client = await connected(); } catch { return padded([], pairs.length, null); }
      try {
        const results = await client.multicall({
          allowFailure: true,
          contracts: wanted.map(({ wallet, token }) => ({
            address: getAddress(token),
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [getAddress(wallet)],
          })),
        }) as readonly ({ readonly status: "success"; readonly result: unknown } | { readonly status: "failure" })[];
        return padded(results.map((result) => (result.status === "success" && typeof result.result === "bigint" ? result.result : null)), pairs.length, null);
      } catch {
        return padded([], pairs.length, null);
      }
    },

    async tokenMetadata(tokens, signal): Promise<readonly { readonly decimals: number | null; readonly symbol: string | null }[]> {
      void signal;
      const wanted = tokens.slice(0, MAX_TOKENS);
      const absent = { decimals: null, symbol: null } as const;
      if (wanted.length === 0) return padded([], tokens.length, absent);
      let client: PublicClient;
      try { client = await connected(); } catch { return padded([], tokens.length, absent); }
      try {
        // decimals and symbol are SEPARATE entries, so a token whose `symbol()`
        // is a bytes32 (and fails the string decode) still yields the decimals
        // that make it valuable. This mirrors `AltanaProvider.getTokenMetadata`,
        // where the symbol read sits in its own try.
        // The two entries have different return types, so the tuple inference
        // viem does for a homogeneous list collapses. The results are read back
        // through an explicit runtime check below, which is the same discipline
        // the balance path uses.
        const results = await client.multicall({
          allowFailure: true,
          contracts: wanted.flatMap((token) => [
            { address: getAddress(token), abi: ERC20_ABI, functionName: "decimals" },
            { address: getAddress(token), abi: ERC20_ABI, functionName: "symbol" },
          ]),
        }) as readonly ({ readonly status: "success"; readonly result: unknown } | { readonly status: "failure" })[];
        const mapped = wanted.map((_token, index) => {
          const decimalsResult = results[index * 2];
          const symbolResult = results[index * 2 + 1];
          const decimals = decimalsResult?.status === "success" && typeof decimalsResult.result === "number" ? decimalsResult.result : null;
          let symbol: string | null = null;
          if (symbolResult?.status === "success" && typeof symbolResult.result === "string") {
            const trimmed = symbolResult.result.trim();
            if (trimmed.length > 0 && trimmed.length <= 32) symbol = trimmed;
          }
          return { decimals, symbol };
        });
        return padded(mapped, tokens.length, absent);
      } catch {
        return padded([], tokens.length, absent);
      }
    },
  };
}
