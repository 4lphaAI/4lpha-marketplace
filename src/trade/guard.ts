import {
  encodeFunctionData,
  getAddress,
  isHex,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { createHash } from "node:crypto";
import type { WalletCall } from "../core/types.js";

/** The current opaque Flash entry point pinned by the R3 wire probe. */
export const TRADFI_BINANCE_ROUTER_SELECTOR: Hex = "0xad43f73d";
/** Current reviewed Flash target and approval spender on chain 56. */
export const TRADFI_BINANCE_FLASH_ROUTER_56: Address = getAddress(
  "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5",
);
export const TRADFI_BINANCE_FLASH_SPENDER_56: Address = TRADFI_BINANCE_FLASH_ROUTER_56;
export const TRADFI_GUARD_CHAIN_ID = 56 as const;
/** Must match the guard's on-chain local quote-validity bound. */
export const TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC = 15n;
/** Maximum opaque provider calldata accepted by the proxy and worker seam. */
export const TRADFI_GUARD_MAX_CALLDATA_BYTES = 64 * 1024;

/**
 * Immutable slots emitted by solc 0.8.30 for this source and compiler
 * manifest. They are byte offsets in the deployed runtime template. The
 * source/runtime hashes in the build report pin the compiler shape that makes
 * these offsets meaningful.
 */
export const TRADFI_GUARD_RUNTIME_IMMUTABLE_REFERENCES = [
  { start: 173, length: 32 },
  { start: 258, length: 32 },
  { start: 297, length: 32 },
  { start: 471, length: 32 },
  { start: 1913, length: 32 },
  { start: 2656, length: 32 },
  { start: 2764, length: 32 },
] as const;
/** SHA-256 of the solc 0.8.30, optimizer-200, metadata-free runtime after every immutable word is zeroed. */
export const TRADFI_GUARD_MASKED_RUNTIME_SHA256 =
  "c8d4f8be9a16b817051fbb9bc4622369e50c5bd542e91a56d927fde5927ec05d" as const;
export const TRADFI_GUARD_RUNTIME_BYTES = 3_504;
const TRADFI_GUARD_ROUTER_REFS = [{ start: 297, length: 32 }, { start: 1913, length: 32 }] as const;
const TRADFI_GUARD_SPENDER_REFS = [{ start: 258, length: 32 }, { start: 2656, length: 32 }, { start: 2764, length: 32 }] as const;
const TRADFI_GUARD_USDT_REFS = [{ start: 173, length: 32 }, { start: 471, length: 32 }] as const;

/** The only guard method the worker/session may call. */
export const TRADFI_GUARD_SWAP_SIGNATURE =
  "swap(address,address,uint256,uint256,uint256,bytes)" as const;
/**
 * The hex selector for {@link TRADFI_GUARD_SWAP_SIGNATURE}. NOT the same
 * constant as `TRADFI_GUARD_SWAP_SELECTOR` in `ops/policy.ts` (the signature
 * STRING persisted specs and the worker compare rules against) — R2.3/H1: two
 * constants sharing one name silently broke every grant match.
 */
export const TRADFI_GUARD_SWAP_SELECTOR_HEX: Hex = toFunctionSelector(
  TRADFI_GUARD_SWAP_SIGNATURE,
) as Hex;

/**
 * Minimum time a Flash quote must still have before it is acceptable
 * (R2.9/C2 item 4). Below this margin the worker would race the contract's
 * own `deadline <= block.timestamp + 15` bound.
 */
export const TRADFI_GUARD_MIN_REMAINING_MS = 6_000;

/**
 * C9: memoize an async boolean check. A `false` result is retried after
 * {@link retryFalseAfterMs}, since a transient RPC blip must not wedge a
 * verification closed for the process lifetime; a `true` result, once
 * observed, is cached forever — the deployed runtime is immutable.
 */
export function cachedGuardVerification(
  check: () => Promise<boolean>,
  options: { readonly retryFalseAfterMs?: number; readonly now?: () => number } = {},
): () => Promise<boolean> {
  const retryFalseAfterMs = options.retryFalseAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  let cached: { readonly value: Promise<boolean>; readonly falseAtMs?: number } | undefined;
  return (): Promise<boolean> => {
    if (cached === undefined || (cached.falseAtMs !== undefined && now() - cached.falseAtMs >= retryFalseAfterMs)) {
      const value: Promise<boolean> = check().then((verified) => {
        if (!verified) cached = { value, falseAtMs: now() };
        return verified;
      });
      cached = { value };
    }
    return cached.value;
  };
}

/** R2.4 (H3): a capability quote either answers definitively or does not. */
export type TradfiCapabilityProbeResult = "capable" | "incapable" | "unknown";

/**
 * R2.4 (H3): the data-plane closed codes that mean a route genuinely does not
 * exist. `binance_no_route` and `binance_invalid_response` are answers, not
 * failures — an RFQ maker with nothing to offer or a proxy that rejected the
 * pair, both told us "no" definitively. Everything else (a throw with no
 * message, a network error, `binance_unavailable:*` including
 * `rate_budget_exhausted`, an aborted signal) is transient or infrastructural
 * and must not be cached as a permanent verdict.
 */
export function classifyTradfiFlashError(error: unknown): TradfiCapabilityProbeResult {
  if (!(error instanceof Error)) return "unknown";
  const code = error.message.split(":")[0];
  return code === "binance_no_route" || code === "binance_invalid_response" ? "incapable" : "unknown";
}

/**
 * G5/R2.4/R2.8 (H3/M3/L3): cache only DEFINITE capability answers, keyed by
 * the caller's own string (the guard-preference key is `token:minEntryAtomic`
 * — slippage is fixed at probe time, R2.8). `capable` is cached for 10 min,
 * `incapable` for 2 min; `unknown` (a rate-budget refusal, an abort, a
 * transient proxy failure) is never cached, so the very next call re-probes
 * it instead of excluding the token for 2 minutes on a blip (H3). In-flight
 * calls for the same key are deduped, the same pattern as
 * `schedulableInFlight`. A thrown probe is not cached or deduped past its own
 * call, and propagates to the caller.
 */
export function createTradfiCapabilityProbeCache(options: { readonly now?: () => number } = {}): {
  readonly probe: (key: string, run: () => Promise<TradfiCapabilityProbeResult>) => Promise<TradfiCapabilityProbeResult>;
} {
  const now = options.now ?? Date.now;
  const CAPABLE_TTL_MS = 10 * 60_000;
  const INCAPABLE_TTL_MS = 2 * 60_000;
  const cache = new Map<string, { readonly result: "capable" | "incapable"; readonly expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<TradfiCapabilityProbeResult>>();
  return {
    probe(key, run) {
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (cached.expiresAtMs > now()) return Promise.resolve(cached.result);
        cache.delete(key);
      }
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const work = (async () => {
        const result = await run();
        if (result === "capable") cache.set(key, { result, expiresAtMs: now() + CAPABLE_TTL_MS });
        else if (result === "incapable") cache.set(key, { result, expiresAtMs: now() + INCAPABLE_TTL_MS });
        // L3: evict expired entries on write — keys grow with every distinct amount.
        for (const [existingKey, entry] of cache) {
          if (entry.expiresAtMs <= now()) cache.delete(existingKey);
        }
        return result;
      })();
      inFlight.set(key, work);
      return work.finally(() => inFlight.delete(key));
    },
  };
}

/**
 * One Flash request shape, slippage-clamped at 300 bps (R2.4/H2):
 * `binanceQuoteAndSwap` rejects anything above 300 locally, but settings allow
 * up to 500 — every call site used the wider figure unclamped. Generic so it
 * passes through whatever extra fields (e.g. `signal`) the caller supplies.
 */
export function flashRequest<T extends { readonly slippageBps: number }>(input: T): T {
  return { ...input, slippageBps: Math.min(input.slippageBps, 300) };
}

/**
 * ABI for the deployed guard.  The router's nested bytes intentionally have
 * no ABI here: the provider's inner layout is not verified by this plane.
 */
export const TRADFI_SWAP_GUARD_ABI = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "router_", type: "address" },
      { name: "spender_", type: "address" },
      { name: "canonicalUSDT_", type: "address" },
    ],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "router",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "spender",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "canonicalUSDT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "PINNED_ROUTER_SELECTOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes4" }],
  },
  {
    type: "function",
    name: "MAX_DEADLINE_WINDOW",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "SwapExecuted",
    anonymous: false,
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: true },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "calldataHash", type: "bytes32", indexed: false },
    ],
  },
] as const satisfies Abi;

export type TradfiGuardSwapCallParams = {
  readonly guard: Address;
  readonly router: Address;
  readonly spender: Address;
  readonly canonicalUSDT: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly deadline: bigint;
  readonly calldata: Hex;
};

function fail(message: string): never {
  throw new Error(`buildTradfiGuardSwapCall: ${message}`);
}

function normalizedAddress(value: Address, field: string): Address {
  let result: Address;
  try {
    result = getAddress(value);
  } catch {
    return fail(`${field} must be a valid address.`);
  }
  if (result === zeroAddress) return fail(`${field} must not be the zero address.`);
  return result;
}

function normalizedData(value: Hex): Hex {
  if (!isHex(value) || value.length < 10 || (value.length - 2) % 2 !== 0) {
    return fail("calldata must contain at least a four-byte selector.");
  }
  if ((value.length - 2) / 2 > TRADFI_GUARD_MAX_CALLDATA_BYTES) {
    return fail(`calldata must be at most ${TRADFI_GUARD_MAX_CALLDATA_BYTES} bytes.`);
  }
  if (value.slice(0, 10).toLowerCase() !== TRADFI_BINANCE_ROUTER_SELECTOR) {
    return fail(`calldata selector must be ${TRADFI_BINANCE_ROUTER_SELECTOR}.`);
  }
  return value;
}

/**
 * Zero compiler-marked immutable slots before comparing a deployed runtime
 * with the pinned template. The caller separately checks the three immutable
 * getters against the expected router/spender/USDT addresses; this helper
 * avoids treating constructor-patched bytes as a different implementation.
 */
export function maskTradfiGuardRuntimeImmutables(runtime: Hex): Hex {
  if (!isHex(runtime) || (runtime.length - 2) % 2 !== 0) {
    throw new Error("TradFi guard runtime must be even-length hex.");
  }
  let masked = runtime.slice(2);
  for (const reference of TRADFI_GUARD_RUNTIME_IMMUTABLE_REFERENCES) {
    const start = reference.start * 2;
    const end = (reference.start + reference.length) * 2;
    if (end > masked.length) throw new Error("TradFi guard runtime is shorter than its immutable manifest.");
    masked = `${masked.slice(0, start)}${"0".repeat(end - start)}${masked.slice(end)}`;
  }
  return `0x${masked}` as Hex;
}

/** Throw unless two runtimes have the same non-immutable implementation bytes. */
export function assertTradfiGuardRuntimeTemplate(
  runtimeTemplate: Hex,
  deployedRuntime: Hex,
): void {
  if (maskTradfiGuardRuntimeImmutables(runtimeTemplate).toLowerCase()
    !== maskTradfiGuardRuntimeImmutables(deployedRuntime).toLowerCase()) {
    throw new Error("TradFi guard runtime template mismatch.");
  }
}

function runtimeSha256(runtime: Hex): string {
  return createHash("sha256").update(Buffer.from(runtime.slice(2), "hex")).digest("hex");
}

function wordAt(runtime: Hex, start: number, length: number): string {
  const body = runtime.slice(2);
  const begin = start * 2;
  const end = (start + length) * 2;
  if (end > body.length) throw new Error("TradFi guard runtime is shorter than the reviewed immutable map.");
  return body.slice(begin, end).toLowerCase();
}

function addressWord(value: Address): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

/**
 * Validate the exact reviewed runtime and every compiler immutable occurrence.
 * Getter values alone are insufficient: a malicious runtime can return the
 * expected values while routing through a different internal immutable word.
 */
export function assertTradfiGuardRuntimeExact(input: {
  readonly deployedRuntime: Hex;
  readonly router: Address;
  readonly spender: Address;
  readonly canonicalUSDT: Address;
}): void {
  if (!isHex(input.deployedRuntime) || (input.deployedRuntime.length - 2) / 2 !== TRADFI_GUARD_RUNTIME_BYTES) {
    throw new Error("TradFi guard runtime length is not the reviewed deployment shape.");
  }
  const masked = maskTradfiGuardRuntimeImmutables(input.deployedRuntime);
  if (runtimeSha256(masked) !== TRADFI_GUARD_MASKED_RUNTIME_SHA256) {
    throw new Error("TradFi guard runtime implementation hash is not the reviewed template.");
  }
  const expected = [
    ...TRADFI_GUARD_ROUTER_REFS.map((ref) => [ref, addressWord(input.router)] as const),
    ...TRADFI_GUARD_SPENDER_REFS.map((ref) => [ref, addressWord(input.spender)] as const),
    ...TRADFI_GUARD_USDT_REFS.map((ref) => [ref, addressWord(input.canonicalUSDT)] as const),
  ];
  for (const [ref, word] of expected) {
    if (wordAt(input.deployedRuntime, ref.start, ref.length) !== word) {
      throw new Error(`TradFi guard immutable word mismatch at byte ${ref.start}.`);
    }
  }
}

/**
 * Build one guard call.  Router/spender are explicit inputs so the caller can
 * compare them with independently read immutable values before submission.
 * The function never decodes the opaque provider bytes and always sets native
 * value to zero.
 */
export function buildTradfiGuardSwapCall(
  params: TradfiGuardSwapCallParams,
): WalletCall {
  const guard = normalizedAddress(params.guard, "guard");
  const router = normalizedAddress(params.router, "router");
  const spender = normalizedAddress(params.spender, "spender");
  const canonicalUSDT = normalizedAddress(params.canonicalUSDT, "canonicalUSDT");
  const tokenIn = normalizedAddress(params.tokenIn, "tokenIn");
  const tokenOut = normalizedAddress(params.tokenOut, "tokenOut");
  if (router === canonicalUSDT || spender === canonicalUSDT) {
    return fail("router and spender must differ from canonicalUSDT.");
  }
  if (tokenIn === tokenOut) return fail("tokenIn and tokenOut must differ.");
  if ((tokenIn === canonicalUSDT) === (tokenOut === canonicalUSDT)) {
    return fail("exactly one side of the pair must be canonicalUSDT.");
  }
  if (params.amountInWei <= 0n || params.minOutWei <= 0n) {
    return fail("amountInWei and minOutWei must be positive.");
  }
  if (params.deadline <= 0n) return fail("deadline must be positive.");
  const calldata = normalizedData(params.calldata);

  // `router` and `spender` are checked here as a pure identity assertion for
  // the planner; the guard itself enforces its immutable copy on chain.
  void router;
  void spender;
  return {
    to: guard,
    value: 0n,
    data: encodeFunctionData({
      abi: TRADFI_SWAP_GUARD_ABI,
      functionName: "swap",
      args: [
        tokenIn,
        tokenOut,
        params.amountInWei,
        params.minOutWei,
        params.deadline,
        calldata,
      ],
    }),
  };
}

/** Runtime quote fields that must agree with the immutable guard deployment. */
export type TradfiGuardIdentity = {
  readonly chainId: number;
  readonly guard: Address;
  readonly router: Address;
  readonly spender: Address;
  readonly canonicalUSDT: Address;
};

/**
 * Compare a trusted quote identity with a separately read deployment identity.
 * This is intentionally address-only; bytecode/source manifest comparison is
 * owned by the deployment verifier and is not inferred from provider JSON.
 */
export function assertTradfiGuardIdentity(
  expected: TradfiGuardIdentity,
  observed: TradfiGuardIdentity,
): void {
  if (expected.chainId !== TRADFI_GUARD_CHAIN_ID || observed.chainId !== TRADFI_GUARD_CHAIN_ID) {
    throw new Error("TradFi guard requires BNB Chain mainnet (chain 56).");
  }
  if (getAddress(expected.router) !== TRADFI_BINANCE_FLASH_ROUTER_56
    || getAddress(expected.spender) !== TRADFI_BINANCE_FLASH_SPENDER_56
    || getAddress(observed.router) !== TRADFI_BINANCE_FLASH_ROUTER_56
    || getAddress(observed.spender) !== TRADFI_BINANCE_FLASH_SPENDER_56) {
    throw new Error("TradFi guard router/spender is not the reviewed current Flash identity.");
  }
  const fields: readonly (keyof Omit<TradfiGuardIdentity, "chainId">)[] = [
    "guard", "router", "spender", "canonicalUSDT",
  ];
  for (const field of fields) {
    if (getAddress(expected[field]) !== getAddress(observed[field])) {
      throw new Error(`TradFi guard identity mismatch: ${field}.`);
    }
  }
}
