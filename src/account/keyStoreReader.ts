/**
 * PROVING a declared wallet belongs to the authenticated passkey owner.
 *
 * `GET /account/portfolio?wallets=` lets an authenticated owner name an Altana
 * wallet the plane owns no rows for — the fresh passkey user who funded their
 * wallet before hiring anything (`AccountPortfolioOptions`). Until this module
 * that entry TRUSTED the caller: it was a public-chain balance read requested
 * by an authenticated owner and asserted nothing about custody.
 *
 * ─── WHAT IS PROVEN ON MAINNET (2026-09-02, measured by hand) ──────────────
 *
 * Session authority lives in the Altana KEYSTORE REGISTRY, not the account's
 * own key list (CLAUDE.md, custody model). The registry answers two view
 * functions the SDK itself uses (`dist/internal/keystore.js`):
 *
 *   getKeys(address user)                  -> bytes32[]
 *   getPublicKey(address user, bytes32 id) -> bytes
 *
 * For the mainnet wallet `0xfab7ae2f…bee9`, `getKeys` returned exactly ONE
 * keyId and `getPublicKey` returned a 64-byte FLAT P-256 key (`x || y`, no
 * SEC1 `0x04` prefix — the leading byte of that particular x merely happens to
 * be 0x04). `passkeyOwnerAddress(x, y)` over its two halves reproduces the
 * authenticated passkey owner exactly. That is the whole mechanism, and it is
 * pinned as a golden vector in `test/accountPortfolio.test.ts`.
 *
 * ─── THE COUNTERFACTUAL, WHICH IS THE NORMAL CASE ─────────────────────────
 *
 * A wallet created by `createPasskeyWallet` has NO KeyStore entry until its
 * FIRST admin action LANDS. Measured the same day: a freshly funded wallet
 * answered `getKeys` with an EMPTY array until its first withdraw registered
 * it. So `"not-registered"` is the ordinary state of exactly the wallet this
 * feature exists for, and refusing it would re-break the bug the declared
 * wallet read was added to fix (deposit, then see nothing).
 *
 * Hence a VERDICT, never a boolean, and only ONE verdict refuses:
 * `"no-matching-key"` — an address that IS registered, to a key that is NOT
 * this owner's. That is the single case this plane can PROVE is not the
 * caller's wallet. `"not-registered"` and `"unreadable"` are reported on the
 * wire and the balances are still returned.
 *
 * This stays a READ-ONLY claim. A `"verified"` verdict says the KeyStore lists
 * a P-256 key deriving this owner's identity for that wallet; it is not
 * authority for any write, and nothing here may become one.
 */
import {
  createPublicClient,
  getAddress,
  http,
  isHex,
  size,
  slice,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { KEYSTORE_ABI } from "../wallet/abis.js";
import { passkeyOwnerAddress } from "../auth/webauthnEnvelope.js";

/**
 * The ONE seam the account read takes its KeyStore answers through. Injected
 * exactly like `LpChainReaders` — no route layer makes an RPC call itself.
 */
export type KeyStoreReader = {
  /** `getKeys(user)`. An EMPTY array is a real answer: not yet registered. */
  listKeys(wallet: Address, signal?: AbortSignal): Promise<readonly Hex[]>;
  /** `getPublicKey(user, keyId)`. Raw registry bytes, interpreted by the caller. */
  publicKeyFor(wallet: Address, keyId: Hex, signal?: AbortSignal): Promise<Hex>;
  /** Optional only for legacy injected tests; production always supplies it. */
  isValidKey?(wallet: Address, keyId: Hex, signal?: AbortSignal): Promise<boolean>;
  /** Finalized header acquisition; optional only for legacy/read-only fixtures. */
  finalizedBlock?(signal?: AbortSignal): Promise<KeyStoreBlockReference>;
  /** Canonical header re-read at one exact numeric height. */
  blockAt?(blockNumber: bigint, signal?: AbortSignal): Promise<KeyStoreBlockReference>;
  /** Numeric-height variants used only by durable revocation convergence. */
  listKeysAt?(wallet: Address, blockNumber: bigint, signal?: AbortSignal): Promise<readonly Hex[]>;
  publicKeyForAt?(wallet: Address, keyId: Hex, blockNumber: bigint, signal?: AbortSignal): Promise<Hex>;
  isValidKeyAt?(wallet: Address, keyId: Hex, blockNumber: bigint, signal?: AbortSignal): Promise<boolean>;
};

export type KeyStoreBlockReference = {
  readonly number: bigint | null;
  readonly hash: Hex | null;
};

/**
 * One coherent, finalized KeyStore fact. This is deliberately more verbose
 * than the responsive latest-head verdict: it is authority to destroy the old
 * execution key and release the wallet for a replacement agent.
 */
export type SessionRevocationEvidenceV1 = {
  readonly version: 1;
  readonly chainId: number;
  readonly keyStoreAddress: Address;
  readonly walletAddress: Address;
  readonly keyId: Hex;
  readonly sessionPublicKey: Hex;
  readonly verdict: "invalid" | "missing";
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly observedAtMs: number;
};

export type FinalizedKeyStoreObservation = {
  readonly blockNumber: string;
  readonly blockHash: Hex;
};

export type FinalizedSessionRevocationVerdict =
  | { readonly kind: "invalid" | "missing"; readonly evidence: SessionRevocationEvidenceV1; readonly observation: FinalizedKeyStoreObservation }
  | { readonly kind: "registered"; readonly observation: FinalizedKeyStoreObservation }
  | { readonly kind: "unreadable" };

export type SessionRegistrationVerdict =
  | { readonly kind: "registered"; readonly publicKey: Hex }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly publicKey: Hex }
  | { readonly kind: "unreadable" };

/** Bounded secp256k1 registration check; separate from the P-256 owner helper. */
export async function readSessionRegistration(input: {
  readonly wallet: Address;
  readonly keyId: Hex;
  readonly reader?: KeyStoreReader;
  readonly signal?: AbortSignal;
}): Promise<SessionRegistrationVerdict> {
  if (input.reader === undefined || input.reader.isValidKey === undefined) return { kind: "unreadable" };
  try {
    const ids = await input.reader.listKeys(input.wallet, input.signal);
    if (!Array.isArray(ids) || ids.length > MAX_KEYS_PER_WALLET) return { kind: "unreadable" };
    if (!ids.some((id) => id.toLowerCase() === input.keyId.toLowerCase())) return { kind: "missing" };
    const [publicKey, valid] = await Promise.all([
      input.reader.publicKeyFor(input.wallet, input.keyId, input.signal),
      input.reader.isValidKey(input.wallet, input.keyId, input.signal),
    ]);
    return valid ? { kind: "registered", publicKey } : { kind: "invalid", publicKey };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Read the exact session key at one finalized numeric block and then verify
 * that block's hash did not move. A stable absence is evidence for a locally
 * revoked, formerly-armed row; the store enforces that lifecycle binding.
 */
export async function readFinalizedSessionRevocation(input: {
  readonly chainId: number;
  readonly keyStoreAddress: Address;
  readonly wallet: Address;
  readonly keyId: Hex;
  readonly expectedPublicKey: Hex;
  readonly observedAtMs: number;
  readonly reader?: KeyStoreReader;
  readonly signal?: AbortSignal;
}): Promise<FinalizedSessionRevocationVerdict> {
  const reader = input.reader;
  if (reader?.finalizedBlock === undefined || reader.blockAt === undefined
    || reader.listKeysAt === undefined || reader.publicKeyForAt === undefined
    || reader.isValidKeyAt === undefined) return { kind: "unreadable" };
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1
    || !Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0
    || !isHex(input.keyId) || size(input.keyId) !== 32
    || !isHex(input.expectedPublicKey) || size(input.expectedPublicKey) === 0) {
    return { kind: "unreadable" };
  }
  try {
    input.signal?.throwIfAborted();
    const first = await reader.finalizedBlock(input.signal);
    if (first.number === null || first.number <= 0n || first.hash === null
      || !isHex(first.hash) || size(first.hash) !== 32) return { kind: "unreadable" };
    const keyIds = await reader.listKeysAt(input.wallet, first.number, input.signal);
    if (!Array.isArray(keyIds) || keyIds.length > MAX_KEYS_PER_WALLET) return { kind: "unreadable" };
    if (!keyIds.every((id) => isHex(id) && size(id) === 32)) return { kind: "unreadable" };
    const listed = keyIds.some((id) => id.toLowerCase() === input.keyId.toLowerCase());
    if (!listed) {
      const second = await reader.blockAt(first.number, input.signal);
      if (second.number !== first.number || second.hash === null
        || !isHex(second.hash) || size(second.hash) !== 32
        || second.hash.toLowerCase() !== first.hash.toLowerCase()) return { kind: "unreadable" };
      const observation = { blockNumber: first.number.toString(10), blockHash: first.hash } as const;
      return {
        kind: "missing",
        observation,
        evidence: {
          version: 1,
          chainId: input.chainId,
          keyStoreAddress: getAddress(input.keyStoreAddress),
          walletAddress: getAddress(input.wallet),
          keyId: input.keyId,
          sessionPublicKey: input.expectedPublicKey,
          verdict: "missing",
          blockNumber: observation.blockNumber,
          blockHash: first.hash,
          observedAtMs: input.observedAtMs,
        },
      };
    }
    const [publicKey, valid] = await Promise.all([
      reader.publicKeyForAt(input.wallet, input.keyId, first.number, input.signal),
      reader.isValidKeyAt(input.wallet, input.keyId, first.number, input.signal),
    ]);
    if (!isHex(publicKey) || publicKey.toLowerCase() !== input.expectedPublicKey.toLowerCase()) {
      return { kind: "unreadable" };
    }
    if (typeof valid !== "boolean") return { kind: "unreadable" };
    const second = await reader.blockAt(first.number, input.signal);
    if (second.number !== first.number || second.hash === null
      || !isHex(second.hash) || size(second.hash) !== 32
      || second.hash.toLowerCase() !== first.hash.toLowerCase()) return { kind: "unreadable" };
    const observation = { blockNumber: first.number.toString(10), blockHash: first.hash } as const;
    if (valid) return { kind: "registered", observation };
    return {
      kind: "invalid",
      observation,
      evidence: {
        version: 1,
        chainId: input.chainId,
        keyStoreAddress: getAddress(input.keyStoreAddress),
        walletAddress: getAddress(input.wallet),
        keyId: input.keyId,
        sessionPublicKey: publicKey,
        verdict: "invalid",
        blockNumber: observation.blockNumber,
        blockHash: first.hash,
        observedAtMs: input.observedAtMs,
      },
    };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * `"verified"`        — a registered P-256 key derives the authenticated owner.
 * `"not-registered"`  — `getKeys` is empty. NORMAL for a funded, unused wallet.
 * `"no-matching-key"` — registered, and no key derives this owner. REFUSED.
 * `"unreadable"`      — no reader configured, a read threw, or more keys than
 *                       {@link MAX_KEYS_PER_WALLET}. Never an accusation.
 */
export type DeclaredWalletVerdict =
  | "verified"
  | "not-registered"
  | "no-matching-key"
  | "unreadable";

/**
 * Work bound. A wallet listing more than this is treated as `"unreadable"`
 * rather than fanned out — an unbounded list on an owner-triggered read is a
 * request-amplification seam, and the honest answer to "too many to check" is
 * "could not check", not "not yours".
 */
export const MAX_KEYS_PER_WALLET = 10;

/** Thrown for the ONE verdict that refuses. The route maps it to 400. */
export class DeclaredWalletNotOwnedError extends Error {
  readonly wallet: string;
  constructor(wallet: string) {
    super("A declared wallet is registered to a different owner key.");
    this.name = "DeclaredWalletNotOwnedError";
    this.wallet = wallet;
  }
}

/**
 * The registry's answer for ONE wallet, as a verdict.
 *
 * An ABSENT reader is handled HERE and explicitly (`"unreadable"`), never by a
 * silent skip: "we did not check" and "we checked and it was fine" must not be
 * the same value on the wire.
 */
export async function verifyDeclaredWallet(input: {
  readonly owner: Address;
  readonly wallet: Address;
  readonly reader?: KeyStoreReader | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<DeclaredWalletVerdict> {
  const { owner, wallet, reader } = input;
  if (reader === undefined) return "unreadable";
  let keyIds: readonly Hex[];
  try {
    keyIds = await reader.listKeys(wallet, input.signal);
  } catch {
    return "unreadable";
  }
  if (!Array.isArray(keyIds)) return "unreadable";
  if (keyIds.length === 0) return "not-registered";
  if (keyIds.length > MAX_KEYS_PER_WALLET) return "unreadable";
  let expected: string;
  try {
    expected = getAddress(owner);
  } catch {
    return "unreadable";
  }
  let answered = false;
  for (const keyId of keyIds) {
    let publicKey: Hex;
    try {
      publicKey = await reader.publicKeyFor(wallet, keyId, input.signal);
    } catch {
      continue;
    }
    answered = true;
    // ONLY a 64-byte flat `x || y` is a P-256 owner key here. A secp256k1
    // session key, a SEC1-prefixed 65-byte blob or an empty answer is not a
    // candidate — it is skipped, never coerced into a derivation.
    if (!isHex(publicKey) || size(publicKey) !== 64) continue;
    let derived: string;
    try {
      derived = passkeyOwnerAddress(slice(publicKey, 0, 32), slice(publicKey, 32, 64));
    } catch {
      continue;
    }
    if (derived === expected) return "verified";
  }
  // Every key read threw ⇒ the registry did not answer, which is not evidence
  // about ownership. Only a registry that ANSWERED and named no matching key
  // earns the refusing verdict.
  return answered ? "no-matching-key" : "unreadable";
}

export type CreateKeyStoreReaderOptions = {
  readonly network: {
    readonly chain: Chain;
    readonly chainId: number;
    readonly publicRpcUrl: string;
  };
  /**
   * Endpoint list, tried in order with an `eth_chainId` check — pass the SAME
   * URLs the LP readers and the provider were constructed with
   * (`resolveLpRpcUrls`). NO new env var: this read has no RPC posture of its
   * own and must not acquire one.
   */
  readonly rpcUrls?: readonly string[];
  /** The chain's Altana KeyStore, resolved per chain by the SDK network config. */
  readonly keyStore: Address;
  /** Transport factory, injectable for offline tests. Defaults to `http`. */
  readonly transport?: (rpcUrl: string) => Transport;
};

/**
 * viem-backed {@link KeyStoreReader}, reproducing `createLpChainReaders`'
 * connect discipline: resolve the endpoint list once, verify `eth_chainId`
 * before trusting an endpoint, skip a wrong-chain endpoint rather than read
 * from it, and never cache a transient outage.
 */
export function createKeyStoreReader(options: CreateKeyStoreReaderOptions): KeyStoreReader {
  const { network } = options;
  const keyStore = getAddress(options.keyStore);
  const transport = options.transport ?? ((rpcUrl: string) => http(rpcUrl));
  const rpcUrls =
    options.rpcUrls !== undefined && options.rpcUrls.length > 0
      ? [...new Set(options.rpcUrls)]
      : [network.publicRpcUrl];
  let connection: Promise<PublicClient> | undefined;

  async function connect(): Promise<PublicClient> {
    const failures: string[] = [];
    for (const rpcUrl of rpcUrls) {
      const publicClient: PublicClient = createPublicClient({
        chain: network.chain,
        transport: transport(rpcUrl),
      });
      let chainId: number;
      try {
        chainId = await publicClient.getChainId();
      } catch {
        failures.push("unreachable");
        continue;
      }
      if (chainId !== network.chainId) {
        failures.push("served chain " + String(chainId));
        continue;
      }
      return publicClient;
    }
    throw new Error(
      "No configured RPC endpoint served chain " + String(network.chainId) +
        " (" + String(rpcUrls.length) + " tried: " + failures.join(", ") + ").",
    );
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
    async listKeys(wallet: Address): Promise<readonly Hex[]> {
      const publicClient = await connected();
      const keys = await publicClient.readContract({
        address: keyStore,
        abi: KEYSTORE_ABI,
        functionName: "getKeys",
        args: [getAddress(wallet)],
      });
      return keys as readonly Hex[];
    },
    async publicKeyFor(wallet: Address, keyId: Hex): Promise<Hex> {
      const publicClient = await connected();
      const value = await publicClient.readContract({
        address: keyStore,
        abi: KEYSTORE_ABI,
        functionName: "getPublicKey",
        args: [getAddress(wallet), keyId],
      });
      return value as Hex;
    },
    async isValidKey(wallet: Address, keyId: Hex): Promise<boolean> {
      const publicClient = await connected();
      return publicClient.readContract({
        address: keyStore,
        abi: KEYSTORE_ABI,
        functionName: "isValidKey",
        args: [getAddress(wallet), keyId],
      });
    },
    async finalizedBlock(signal?: AbortSignal): Promise<KeyStoreBlockReference> {
      signal?.throwIfAborted();
      const publicClient = await connected();
      const block = await publicClient.getBlock({ blockTag: "finalized", includeTransactions: false });
      signal?.throwIfAborted();
      return { number: block.number, hash: block.hash };
    },
    async blockAt(blockNumber: bigint, signal?: AbortSignal): Promise<KeyStoreBlockReference> {
      signal?.throwIfAborted();
      const publicClient = await connected();
      const block = await publicClient.getBlock({ blockNumber, includeTransactions: false });
      signal?.throwIfAborted();
      return { number: block.number, hash: block.hash };
    },
    async listKeysAt(wallet: Address, blockNumber: bigint, signal?: AbortSignal): Promise<readonly Hex[]> {
      signal?.throwIfAborted();
      const publicClient = await connected();
      const keys = await publicClient.readContract({
        address: keyStore,
        abi: KEYSTORE_ABI,
        functionName: "getKeys",
        args: [getAddress(wallet)],
        blockNumber,
      });
      signal?.throwIfAborted();
      return keys as readonly Hex[];
    },
    async publicKeyForAt(wallet: Address, keyId: Hex, blockNumber: bigint, signal?: AbortSignal): Promise<Hex> {
      signal?.throwIfAborted();
      const publicClient = await connected();
      const value = await publicClient.readContract({
        address: keyStore,
        abi: KEYSTORE_ABI,
        functionName: "getPublicKey",
        args: [getAddress(wallet), keyId],
        blockNumber,
      });
      signal?.throwIfAborted();
      return value as Hex;
    },
    async isValidKeyAt(wallet: Address, keyId: Hex, blockNumber: bigint, signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      const publicClient = await connected();
      const valid = await publicClient.readContract({
        address: keyStore,
        abi: KEYSTORE_ABI,
        functionName: "isValidKey",
        args: [getAddress(wallet), keyId],
        blockNumber,
      });
      signal?.throwIfAborted();
      return valid;
    },
  };
}
