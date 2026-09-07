/**
 * Altana implementation of `WalletProvider`.
 *
 * Thin by design: validate, translate, call the SDK, map errors. No policy.
 *
 * One deliberate exception to "thin": `ownerRecover` and
 * `ownerRevokeSessionDirect` bypass the Altana SDK entirely and talk to a
 * public RPC with viem. That is the point of those two methods — they are the
 * self-custody escape hatch and must keep working when every piece of
 * infrastructure other than the chain itself is gone.
 */
import {
  BNB_TESTNET,
  createClient as createAltanaClient,
  signerFromPrivateKey,
  type Client as AltanaClient,
  type NetworkConfig,
  type Session,
  type SessionPermissions,
  type Signer,
} from "@altananetwork/sdk";
import {
  createClient as createViemClient,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  padHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import {
  privateKeyToAccount,
  publicKeyToAddress,
  type PrivateKeyAccount,
} from "viem/accounts";
import {
  REVERT_SELECTORS,
  classifyFailureCode,
  mapProviderError,
  mentionsRevertSelector,
} from "../core/errors.js";
import {
  VALUE_MOVING_SELECTORS,
  isSessionExpired,
  structuralTargetRefusal,
  validateSessionSpec,
} from "../core/session.js";
import {
  ExecutionPlaneError,
  InfrastructureError,
  NotAllowedError,
  NotImplementedError,
  ProviderError,
  SessionExpiredError,
  type AgentWalletRef,
  type AwaitExecutionParams,
  type ExecuteViaSessionParams,
  type ExecutionReceipt,
  type ExecutionStatusReading,
  type GetBalanceParams,
  type GetTokenBalanceParams,
  type GetTokenMetadataParams,
  type GrantSessionParams,
  type IsSessionActiveParams,
  type KeyAuthority,
  type OwnerAuthority,
  type OwnerRecoverParams,
  type OwnerRecoverTokensParams,
  type OwnerRevokeSessionParams,
  type OwnerRevokeSessionResult,
  type FourMemeQuote,
  type FlapTokenState,
  type ReadFourMemeQuoteParams,
  type ReadFlapTokenStateParams,
  type CanSessionSellTokenParams,
  type NativeDayMeterReading,
  type NativeDayMeterParams,
  type PreflightExecuteParams,
  type ResolveOwnerWalletParams,
  type RestoreSessionParams,
  type RevokeSessionParams,
  type SessionRef,
  type WalletCall,
  type WalletProvider,
} from "../core/types.js";
import {
  ACCOUNT_ABI,
  ERC20_ABI,
  FOUR_MEME_HELPER_ABI,
  KEYSTORE_ABI,
} from "./abis.js";
// The one fragment this provider READS from `src/ops/`. It sits there because
// the same fragment is what the trade route WRITES with: flap's Portal is a
// single contract for the state read, the swap and the approval spender, and
// two transcriptions of one struct is exactly how a field order goes wrong.
import { FLAP_PORTAL_ABI } from "../ops/abis.js";
import {
  PortoStagedLpAdapter,
  isProvenPreBindStagedLpError,
  type PortoStagedLpSubmit,
} from "../lp/preparedIntent.js";

/**
 * What an `OwnerAuthority.handle` carries for this provider.
 *
 * `account` is present only for private-key owners. Passkey owners have no raw
 * key, so they cannot use the relay-independent recovery path — see
 * FINDINGS.md (b).
 */
export type AltanaOwnerHandle = {
  readonly signer: Signer;
  readonly account?: PrivateKeyAccount;
};

/** What a `SessionRef.handle` carries. The live SDK `Session`. */
export type AltanaSessionHandle = {
  readonly session: Session;
};

/** Upper bound on calls per execute. A batch this large is a bug, not a trade. */
export const MAX_CALLS_PER_EXECUTE = 20;

/**
 * ONE shared deadline for the pre-flight's chain fallback (PHASE2.4 R5).
 *
 * It bounds the whole refused subset, not each read, because the verdict is a
 * conjunction: a batch that has already spent five seconds waiting has nothing
 * to gain from a sixth. Expiry FAILS THE BATCH CLOSED — the fallback exists to
 * widen reach, and a slow endpoint must degrade reach, never safety.
 */
const PREFLIGHT_CHAIN_TIMEOUT_MS = 5_000;

/** Default ceiling on how long we wait for a receipt before reporting PENDING. */
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;

/** Default poll interval for `awaitExecution`'s relay status polling. */
const DEFAULT_AWAIT_POLL_MS = 2_000;

/**
 * Ceiling on ONE submission to the relay.
 *
 * 45s: long enough for a relay that is merely slow — grants have been measured
 * in the tens of seconds — and short enough that an operator learns the outcome
 * is unknown rather than watching a terminal forever. Exceeding it does NOT
 * mean the submission failed; see the call site.
 */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 45_000;

/**
 * The account's `period` enum value for DAY.
 *
 * Restated rather than imported: `src/lp/readers.ts` also names it, and the
 * wallet layer must not depend upward on the LP layer. The two are pinned equal
 * by a test.
 */
export const SPEND_PERIOD_DAY = 2;

/**
 * Ceiling on the gas a recovery sweep may budget for.
 *
 * `estimateGas` is answered by whatever RPC we happen to be talking to. A wrong
 * answer here does not fail loudly — it silently reprices the sweep, and since
 * the sweep sends `balance - gasBudget * gasPrice`, an absurd estimate donates
 * the difference to the validator.
 */
const MAX_RECOVERY_GAS = 500_000n;

/** A plain value transfer to an account with no code. */
const EOA_TRANSFER_GAS = 21_000n;

/**
 * Build an owner authority from a raw private key.
 *
 * The key never leaves this process and is never serialized onto an
 * `OwnerAuthority` field that anything else reads.
 */
export function authorityFromPrivateKey(privateKey: Hex): KeyAuthority {
  const signer = signerFromPrivateKey(privateKey);
  const account = privateKeyToAccount(privateKey);
  const handle: AltanaOwnerHandle = { signer, account };
  return { address: getAddress(signer.address), handle };
}

/** Alias that reads better at owner call sites. Same implementation. */
export const ownerAuthorityFromPrivateKey = authorityFromPrivateKey;

/** Alias that reads better at agent call sites. Same implementation. */
export const agentAuthorityFromPrivateKey = authorityFromPrivateKey;

function ownerHandle(owner: KeyAuthority): AltanaOwnerHandle {
  const handle = owner.handle;
  if (
    typeof handle !== "object" ||
    handle === null ||
    !("signer" in handle)
  ) {
    throw new ProviderError("Owner authority was not created by this provider.");
  }
  return handle as AltanaOwnerHandle;
}

function sessionHandle(session: SessionRef): Session {
  const handle = session.handle;
  if (
    typeof handle !== "object" ||
    handle === null ||
    !("session" in handle)
  ) {
    throw new ProviderError("Session handle was not created by this provider.");
  }
  return (handle as AltanaSessionHandle).session;
}

/**
 * Honour a caller's AbortSignal at an await boundary.
 *
 * The SDK accepts no signal, so this cannot tear down an in-flight HTTP
 * request; it stops the sequence before the next one starts.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ProviderError("Request aborted by caller.");
  }
}

/**
 * keyHash of a secp256k1 key as `IthacaAccount` stores it:
 * `keccak256(abi.encode(uint256(2), keccak256(bytes32(address))))`, where 2 is
 * the Secp256k1 member of the account's KeyType enum.
 */
export function accountKeyHashForAddress(address: Address): Hex {
  const publicKeyHash = keccak256(padHex(getAddress(address), { size: 32 }));
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [2n, publicKeyHash],
    ),
  );
}

export type AltanaProviderOptions = {
  /** Defaults to BNB testnet (chain 97). */
  readonly network?: NetworkConfig;
  /** Override the public RPC used for reads and for the recovery path. */
  readonly rpcUrl?: string;
  /**
   * Additional endpoints, tried in order when an earlier one is unreachable or
   * reports the wrong chain. The recovery path is the one thing that must work
   * when everything else is down, and a single hardcoded public RPC is a
   * single point of failure for it.
   */
  readonly rpcUrls?: readonly string[];
  /**
   * Transport factory. Defaults to `http`. Injectable so the recovery path —
   * which spends real money and cannot be exercised in CI — is still testable
   * offline against a scripted RPC.
   */
  readonly transport?: (rpcUrl: string) => Transport;
  /** How long to wait for a receipt before returning PENDING. */
  readonly receiptTimeoutMs?: number;
  /**
   * Deadline for the pre-flight-class chain READS, in ms. Defaults to
   * {@link PREFLIGHT_CHAIN_TIMEOUT_MS}.
   *
   * Injectable for ONE reason (PHASE2.5-FIXREVIEW F3): the deadline on
   * `nativeDayMeter` — the read that sits above the submit on the money path —
   * was pinned by nothing, and the reviewer proved it by deleting the wrapper
   * and watching the whole suite stay green. A bound cannot be tested offline
   * against a five-second constant without a five-second test, so the constant
   * becomes a default and a test supplies a small one.
   */
  readonly chainReadTimeoutMs?: number;
  /**
   * Injectable Altana SDK client.
   *
   * Defaults to a client built for this network. Overridable so the
   * session-execute path — whose FAILED-without-throw behaviour is the reason
   * `failureCode` exists — can be exercised offline against a scripted result.
   */
  readonly client?: AltanaClient;
  /** How long `awaitExecution` polls the relay before reporting PENDING. */
  /**
   * Ceiling on one `executeViaSession` submission. Exceeding it is reported as
   * AMBIGUOUS — the relay may have accepted the bundle — never as a failure.
   */
  readonly submitTimeoutMs?: number;
  /** How long `awaitExecution` polls the relay before reporting PENDING. */
  readonly awaitTimeoutMs?: number;
  /** Poll interval for `awaitExecution`. */
  readonly awaitPollIntervalMs?: number;
  /**
   * Four.Meme's `TokenManagerHelper3` for THIS chain (PHASE2.1 R4).
   *
   * PINNED, and pinned here rather than resolved per request on purpose: an
   * address supplied by a caller — or read back out of a previous quote — would
   * let a request name the contract that decides how much native leaves the
   * wallet. `readFourMemeQuote` uses this value and nothing else.
   *
   * Resolved and checksum-validated at BOOT (`VENUE_FOURMEME_HELPER`, per-chain
   * default in `src/ops/venues.ts`). A provider constructed WITHOUT it refuses
   * the read, which the trade route turns into `VENUE_UNSUPPORTED` — a chain
   * with no helper simply has no Four.Meme, and never a call to `0x0`.
   */
  readonly fourMemeHelper?: Address;
  /**
   * flap.sh's `Portal` for THIS chain (PHASE2.4).
   *
   * PINNED for the same reason as the Four.Meme helper, and with more at stake:
   * this ONE address is read for the token's state, called by the swap, and
   * approved as the spender on every sell. A caller-supplied Portal would be a
   * caller-supplied approval spender. Resolved and checksum-validated at BOOT
   * (`VENUE_FLAP_PORTAL`, per-chain default in `src/ops/venues.ts`); a provider
   * constructed WITHOUT it refuses the read, which the trade route turns into
   * `VENUE_UNSUPPORTED`.
   */
  readonly flapPortal?: Address;
};

/** Result of the relay-independent revocation. */
export type OwnerRevokeSessionDirectResult = {
  /**
   * Whether the session is actually dead, read back from chain state rather
   * than inferred from transaction statuses.
   *
   * Callers MUST branch on this and never re-derive it: the two legs below can
   * each legitimately fail while the session still ends up revoked, and the
   * arithmetic for "which combination counts" belongs here, once.
   */
  readonly revoked: boolean;
  readonly accountRevoke: ExecutionReceipt;
  /**
   * `true` when the account-level `revoke` reverted `KeyDoesNotExist()`, i.e.
   * there was no account-level entry to strip. Expected on Altana, where
   * session authority lives in the KeyStore.
   */
  readonly accountKeyAbsent: boolean;
  readonly keyStoreRevoke?: ExecutionReceipt;
  /** `KeyStore.isValidKey` read AFTER the revocations. Expect `false`. */
  readonly keyStoreRegistered: boolean;
  /**
   * Whether the account's own key list still contains the session key hash.
   * Best effort: the read reverts on an account with no delegation, in which
   * case this is `undefined` and only the KeyStore read counts.
   */
  readonly accountKeyPresent?: boolean;
};

type Connection = {
  readonly publicClient: PublicClient;
  readonly rpcUrl: string;
};

export class AltanaProvider implements WalletProvider {
  readonly network: NetworkConfig;

  readonly #client: AltanaClient;
  readonly #rpcUrls: readonly string[];
  readonly #transport: (rpcUrl: string) => Transport;
  readonly #receiptTimeoutMs: number;
  readonly #chainReadTimeoutMs: number;
  readonly #submitTimeoutMs: number;
  /** The EFFECTIVE submit timeout, after options (PHASE3.7-AUDIT A5). */
  readonly submitTimeoutMs: number;
  readonly #awaitTimeoutMs: number;
  readonly #awaitPollIntervalMs: number;
  readonly #fourMemeHelper: Address | undefined;
  readonly #flapPortal: Address | undefined;
  readonly #stagedLp: PortoStagedLpAdapter | undefined;
  #connection: Promise<Connection> | undefined;

  constructor(options: AltanaProviderOptions = {}) {
    this.network = options.network ?? BNB_TESTNET;
    const urls = [
      ...(options.rpcUrl === undefined ? [] : [options.rpcUrl]),
      ...(options.rpcUrls ?? []),
    ];
    this.#rpcUrls = urls.length > 0 ? [...new Set(urls)] : [this.network.publicRpcUrl];
    this.#transport = options.transport ?? ((rpcUrl) => http(rpcUrl));
    this.#receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.#chainReadTimeoutMs = options.chainReadTimeoutMs ?? PREFLIGHT_CHAIN_TIMEOUT_MS;
    this.#submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
    // PHASE3.7-AUDIT A5. The boot check in `index-server.ts` used to compare
    // two module constants and call it "the provider's actual timeout", so a
    // registry entry passing `submitTimeoutMs: 300_000` booted clean with the
    // reconcile age guard no longer covering a submit window. It reads THIS.
    this.submitTimeoutMs = this.#submitTimeoutMs;
    this.#awaitTimeoutMs = options.awaitTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.#awaitPollIntervalMs = options.awaitPollIntervalMs ?? DEFAULT_AWAIT_POLL_MS;
    // Normalized once, at construction. There is no other assignment to this
    // field and no setter: the pinned helper cannot be moved at runtime.
    this.#fourMemeHelper =
      options.fourMemeHelper === undefined
        ? undefined
        : getAddress(options.fourMemeHelper);
    this.#flapPortal =
      options.flapPortal === undefined
        ? undefined
        : getAddress(options.flapPortal);
    this.#client = options.client ?? createAltanaClient({ chains: [this.network] });
    // C1 is deliberately registered only for the independently decoded BSC
    // Orchestrator 0.5.5 tuple. Other chains keep every non-LP capability and
    // fail closed if an LP caller somehow reaches the staged method.
    this.#stagedLp = this.network.chainId === 56
      ? new PortoStagedLpAdapter({ network: this.network, transport: this.#transport,
          submitTimeoutMs: this.#submitTimeoutMs })
      : undefined;
  }

  submitPreparedLp(params: PortoStagedLpSubmit): Promise<ExecutionReceipt> {
    if (this.#stagedLp === undefined) {
      throw new ProviderError(
        "Staged LP submission is unavailable for this chain/provider registry.",
      );
    }
    return this.#stagedLp.submit(params).catch((cause: unknown) => {
      // This is a positional proof owned by the staged adapter. Mapping it to
      // a generic provider error would erase the runner's no-submit evidence.
      if (isProvenPreBindStagedLpError(cause)) throw cause;
      throw mapProviderError(cause);
    });
  }

  /**
   * Resolve a usable RPC endpoint, once per provider instance.
   *
   * The chain-id check is not ceremony: `NetworkConfig.chain` and the RPC URL
   * are configured independently, so a copy-pasted mainnet endpoint under a
   * testnet config produces a provider that signs testnet-shaped transactions
   * and broadcasts them to mainnet. Verifying costs one `eth_chainId`.
   */
  async #connect(): Promise<Connection> {
    const failures: string[] = [];
    for (const rpcUrl of this.#rpcUrls) {
      const publicClient: PublicClient = createPublicClient({
        chain: this.network.chain,
        transport: this.#transport(rpcUrl),
      });
      let chainId: number;
      try {
        chainId = await publicClient.getChainId();
      } catch {
        // Endpoint identities are not printed: they end up in error messages
        // that reach logs, and RPC URLs routinely carry API keys.
        failures.push("unreachable");
        continue;
      }
      if (chainId !== this.network.chainId) {
        failures.push(`served chain ${chainId}`);
        continue;
      }
      return { publicClient, rpcUrl };
    }
    throw new ProviderError(
      `No configured RPC endpoint served chain ${this.network.chainId} (${this.#rpcUrls.length} tried: ${failures.join(", ")}).`,
    );
  }

  async #connected(): Promise<Connection> {
    this.#connection ??= this.#connect();
    try {
      return await this.#connection;
    } catch (cause) {
      // Do not cache a failure: the next call should re-probe rather than
      // inherit a transient outage forever.
      this.#connection = undefined;
      throw cause;
    }
  }

  #walletClient(account: PrivateKeyAccount, rpcUrl: string) {
    return createWalletClient({
      account,
      chain: this.network.chain,
      transport: this.#transport(rpcUrl),
    });
  }

  /**
   * Wait for a receipt, and NEVER lose the hash.
   *
   * A rejected wait means "we do not know yet", not "it did not happen" — the
   * transaction is signed, broadcast, and quite possibly mining. Discarding
   * the hash here would leave the caller unable to check, retry safely, or
   * even tell the user what to look up.
   */
  async #awaitReceipt(
    publicClient: PublicClient,
    transactionHash: Hex,
  ): Promise<ExecutionReceipt> {
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash,
        timeout: this.#receiptTimeoutMs,
      });
      return {
        status: receipt.status === "success" ? "CONFIRMED" : "FAILED",
        transactionHash,
      };
    } catch {
      return { status: "PENDING", transactionHash };
    }
  }

  /**
   * Provision the owner's wallet.
   *
   * VERIFIED against SDK 0.7.0: the returned address always equals the owner's
   * EOA address, because an Altana wallet is that EOA delegated under EIP-7702.
   * There is no separate "root owner" parameter — custody follows the signer.
   */
  async resolveOwnerWallet(
    params: ResolveOwnerWalletParams,
  ): Promise<AgentWalletRef> {
    throwIfAborted(params.signal);
    const { signer } = ownerHandle(params.owner);
    try {
      const wallet = await this.#client.createWallet({ signer });
      throwIfAborted(params.signal);
      return {
        address: getAddress(wallet.address),
        chainId: this.network.chainId,
        ownerAddress: getAddress(params.owner.address),
        // On Altana the wallet IS the owner's EOA under EIP-7702 (FINDINGS.md a).
        custodyModel: "self-eoa",
      };
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Rebuild a live session from persisted facts. Synchronous: no gas, no
   * network.
   *
   * The permissions are re-derived from the spec through the SAME
   * `validateSessionSpec` the grant used, so they are byte-identical to what
   * was registered. NOTHING ON CHAIN DEPENDS ON THAT (PHASE2.4 R7): porto's
   * `Key.hash` is `keccak256(keyType, keccak256(publicKey))`, permissions
   * excluded, and this method derives no on-chain identity from the spec at
   * all — it only builds a local `SessionPermissions`. What DOES consume them
   * is the relay, which the SDK hands the descriptor on every execute, and
   * whether it enforces that is unsettled (FINDINGS (x)). Reproducing them
   * exactly is the position that is safe either way. `minSessionSeconds`
   * is relaxed to zero because a persisted session may be legitimately close to
   * its expiry, and restoring it must not be refused for being short-lived.
   */
  restoreSession(params: RestoreSessionParams): SessionRef {
    const permissions: SessionPermissions = validateSessionSpec(params.spec, {
      minSessionSeconds: 0,
    });
    const { signer } = ownerHandle(params.agent);
    const session: Session = {
      walletAddress: getAddress(params.walletAddress),
      signer,
      publicKey: params.publicKey,
      permissions,
      expiry: params.expiresAt,
    };
    return {
      walletAddress: getAddress(params.walletAddress),
      chainId: this.network.chainId,
      publicKey: params.publicKey,
      spec: params.spec,
      handle: { session } satisfies AltanaSessionHandle,
    };
  }

  /** Grant a scoped session. Costs gas, charged to the wallet. */
  async grantSession(params: GrantSessionParams): Promise<SessionRef> {
    throwIfAborted(params.signal);
    // Validation throws InvalidSessionSpecError before any network call. The
    // wallet and registry addresses are passed so a policy cannot allowlist a
    // call back into the account's own admin surface.
    const permissions: SessionPermissions = validateSessionSpec(params.spec, {
      walletAddress: params.wallet.address,
      keyStoreAddress: this.network.keyStore,
    });
    const { signer } = ownerHandle(params.owner);
    const sessionSigner = ownerHandle(params.agent).signer;

    try {
      const session = await this.#client.grantSession({
        wallet: { address: params.wallet.address },
        signer,
        permissions,
        expiry: params.spec.expiresAt,
        sessionSigner,
      });
      throwIfAborted(params.signal);
      return {
        walletAddress: getAddress(session.walletAddress),
        chainId: this.network.chainId,
        publicKey: session.publicKey,
        spec: params.spec,
        handle: { session } satisfies AltanaSessionHandle,
      };
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Every check `executeViaSession` runs BEFORE it submits, as a method a
   * caller can run on its own (PHASE2.4 R3). Submits nothing; idempotent.
   *
   * Order is load-bearing, cheapest and most absolute first:
   *
   *   1. batch shape — a batch this size is a bug, not a trade;
   *   2. EXPIRY, locally. An expired session is refused without asking anyone,
   *      because expiry is enforced on chain and a round trip would only pay to
   *      be told so;
   *   3. R1's two STRUCTURAL refusals — a call back into the wallet or into the
   *      KeyStore — which are 4lpha's own policy and are NEVER eligible for the
   *      fallback below;
   *   4. the granted snapshot, per call. When it passes, nothing else runs and
   *      nothing costs a round trip: that is the common case, a token named at
   *      hire;
   *   5. only for the calls the snapshot REFUSED, the chain.
   *
   * ─── WHY STEP 5 EXISTS ─────────────────────────────────────────────────────
   *
   * `sessionFacts.spec` records what was authorised AT GRANT TIME. `setSpendLimit`
   * and `setCanExecute` let the owner widen a LIVE session with no re-grant
   * (FINDINGS (i)), which is the documented — and only — route to a token that
   * did not exist at hire. Measured on mainnet (FINDINGS (v)): both on-chain
   * halves granted, every account-side gate open, and this service refused
   * anyway from a snapshot that is by construction incapable of ever agreeing.
   * The position could be opened and not closed, and no action available to the
   * owner could lift it.
   *
   * UNION, never replacement, exactly as FINDINGS (t) established for the buy
   * gate: the snapshot alone can only widen, the chain can only widen further,
   * and neither narrows what the other allows.
   *
   * ─── WHAT THIS COSTS, STATED HONESTLY (PHASE2.4 R1 item 3) ─────────────────
   *
   * It is a widening, and the draft's "a leaked exec token gains nothing it
   * could not already do" was false. After this, a leaked `x-exec-token` reaches
   * the UNION OF EVERY TARGET ANY OWNER HAS EVER AUTHORISED ON CHAIN FOR THIS
   * KEY — strictly more than the snapshot, and a set that grows with every
   * `owner-add-spend-limit` and shrinks only on revoke. It remains bounded by
   * the on-chain caps, the on-chain allowlist, expiry, the two unconditional
   * refusals in step 3, and the per-agent throttle.
   */
  async preflightExecute(params: PreflightExecuteParams): Promise<void> {
    const { session, calls } = params;
    if (calls.length === 0) {
      throw new ProviderError("executeViaSession requires at least one call.");
    }
    if (calls.length > MAX_CALLS_PER_EXECUTE) {
      throw new ProviderError(
        `executeViaSession accepts at most ${MAX_CALLS_PER_EXECUTE} calls per batch; got ${calls.length}.`,
      );
    }
    if (isSessionExpired(session.spec)) {
      throw new SessionExpiredError(
        "Session expired before submission; a new session must be granted.",
      );
    }

    // (3) UNCONDITIONAL. The same predicate `validateSessionSpec` refuses a RULE
    // with, applied to a CALL, and deliberately ahead of both the snapshot and
    // the fallback: `canExecute` is the ACCOUNT's allowlist and has no opinion
    // about 4lpha's policy, so consulting it here would let one owner self-call
    // hand the session a route into the registry that bounds it.
    for (const call of calls) {
      const refusal = structuralTargetRefusal(call.to, {
        walletAddress: session.walletAddress,
        keyStoreAddress: this.network.keyStore,
      });
      if (refusal !== null) throw new NotAllowedError(refusal);
    }

    const refused = calls.filter((call) => !snapshotAllows(session, call));
    if (refused.length === 0) return;

    const fallback = await this.#chainWouldAllow(session, refused, params.signal);
    if (fallback.kind === "allowed") return;
    // PHASE3.1-FIXREVIEW F1 (second half). Both remaining verdicts REFUSE — the
    // fail-closed property below is untouched, and nothing is submitted either
    // way. What changed is only WHICH REFUSAL we tell the caller about.
    //
    // `undetermined` means the account was never asked: the RPC failed, or
    // `withDeadline` expired. Reporting that as `NOT_ALLOWED` was an outage
    // wearing a policy rejection's clothes — the exact lie this module's header
    // exists to prevent — and it happened UPSTREAM of `mapProviderError`, where
    // no classifier could ever see it. So the transport failure is re-thrown
    // with its own class, which is the truth and is the class every caller that
    // retries transient failures already keys on.
    //
    // Only an INFRASTRUCTURE-class cause is substituted. Anything else the read
    // could throw is not evidence of an outage, so it keeps the allowlist
    // refusal it has always had — narrow on purpose, so this cannot become a
    // route by which an unrecognised failure stops looking like a refusal.
    //
    // This is one of the two literal `INFRASTRUCTURE_ERROR` comparisons in
    // `src/`, and it sits ABOVE every submit — nothing has been sent when
    // `preflightExecute` runs. PHASE3.1-SPEC's erratum **E9 item 2** makes its
    // accepted residue conditional on exactly that position, so both the set of
    // comparison sites and their being above a submit are pinned by
    // `test/errors.test.ts`'s "E9 item 2's tripwire" (PHASE3.1-FIXREVIEW3 H1).
    // A new branch on this class BELOW a submit sends you to E9 first.
    if (
      fallback.kind === "undetermined" &&
      fallback.cause.code === "INFRASTRUCTURE_ERROR"
    ) {
      throw fallback.cause;
    }
    throw new NotAllowedError(
      `Call target ${getAddress(refused[0]?.to ?? zeroAddress)} is not in the session allowlist; rejected before submission.`,
    );
  }

  /**
   * Would the ACCOUNT permit every one of these calls, right now?
   *
   * FAILS CLOSED on everything: an RPC failure, a timeout, an abort, a key the
   * account does not hold, a super-admin key, a missing spend limit. Anything
   * but `allowed` refuses the execute — "we could not establish that it would"
   * is not "it said yes". The fallback exists to widen reach, and degraded
   * reach is the only acceptable degradation.
   *
   * PHASE3.1-FIXREVIEW F1: the answer is a TRI-STATE rather than a boolean, and
   * the third state is the whole point. Collapsing "the account said no" and
   * "we could not ask" into one `false` was lossy in a way no downstream
   * classifier could repair, because the caller then minted a `NotAllowedError`
   * out of an RPC outage — a permanent-looking policy verdict standing in for a
   * blip. The refusal is unchanged; only the class it carries is now true.
   * `refused` still covers every DETERMINATE no (a key the account does not
   * hold, a super-admin key, a missing spend limit, an abort), because those
   * really are the account declining to vouch for the call.
   *
   * Three rules, each with a reason that cost something to learn:
   *
   *   - **The verdict is VOID for a super-admin key** (FINDINGS (o),
   *     `SuperAdminCanExecuteEverything`). Such a key makes `canExecute` return
   *     `true` for literally everything, so trusting it would not widen the
   *     pre-flight — it would delete it. `grantSession` should never produce
   *     one; this is defence in depth and must not depend on that.
   *   - **Per call, against the REAL calldata** (D1 rule 3). `canExecute` takes
   *     `data`, so the selector is part of the question; probing a different
   *     payload would answer a question nobody posed.
   *   - **BOTH halves for a value-moving selector** (R5). A session grants an
   *     allowlist AND a per-token spend meter, the account checks the allowlist
   *     FIRST, and either alone is a trap — FINDINGS (u), which stranded a real
   *     position. Checking only `canExecute` here would move the silent
   *     `PENDING`/no-tx/no-gas decline one layer out and re-create (u) as the
   *     fix for (v). `spendInfos` is per-KEY, so it is ONE extra read for the
   *     whole batch rather than one per call.
   *
   * Reads run in parallel over the refused subset only — bounded by
   * `MAX_CALLS_PER_EXECUTE`, under one shared deadline. NO multicall: a
   * third-party aggregator answering a security question about our own account
   * is a bad trade for latency `Promise.all` already gives. NO cache: caching an
   * allowlist verdict caches AUTHORITY, and a revoked grant would keep reading
   * "allowed" until the entry aged out.
   */
  async #chainWouldAllow(
    session: SessionRef,
    refused: readonly WalletCall[],
    signal: AbortSignal | undefined,
  ): Promise<ChainFallbackVerdict> {
    // An abort means REFUSE, and ONLY here (PHASE2.4 R3 item 11): nothing has
    // been submitted, so "we stopped asking" is honestly a refusal. The same
    // reasoning does NOT extend to the submit path, where an abort cannot prove
    // the in-flight request did not land.
    if (signal?.aborted === true) return { kind: "refused" };
    try {
      const verdict = await withDeadline(
        this.#chainVerdict(session, refused),
        PREFLIGHT_CHAIN_TIMEOUT_MS,
      );
      return verdict ? { kind: "allowed" } : { kind: "refused" };
    } catch (cause) {
      // The account was never asked. `mapProviderError` — the plane's ONE
      // classifier — decides what kind of "never asked" this was; the caller
      // refuses either way and only reports the class differently.
      return { kind: "undetermined", cause: mapProviderError(cause) };
    }
  }

  /**
   * PHASE2.5 F1. The account's own DAILY NATIVE meter for this session key.
   *
   * One `spendInfos` read, and it answers BOTH questions the reserve needs —
   * today's remaining native, and how many tokens this key can actually sell —
   * from the SAME call, so the two can never disagree with each other.
   *
   * Reading `grantedTokenCount` from the CHAIN rather than from the grant the
   * plane remembers is the PHASE2.4 posture: the chain is the authority on what
   * a session may do NOW, and an owner who widened a session on chain must not
   * be sized against a stale snapshot.
   */
  async nativeDayMeter(params: NativeDayMeterParams): Promise<NativeDayMeterReading> {
    throwIfAborted(params.signal);
    const wallet = getAddress(params.walletAddress);
    const keyHash = accountKeyHashForAddress(
      publicKeyToAddress(params.publicKey),
    );
    // PHASE2.5-AUDIT A3 + A4. TWO things this read did not do and
    // `#chainWouldAllow` two hundred lines up already did:
    //
    //   - a DEADLINE. Since F1 this sits on the money path above the submit AND
    //     on the owner's dashboard route, so an unbounded read is a slow node
    //     holding a trade request open and a worried owner staring at a
    //     spinner. `withDeadline` rejects as an `InfrastructureError`, which is
    //     the honest class for "the node did not answer";
    //   - `mapProviderError`, the plane's ONE classifier. Letting a raw viem
    //     error escape meant the route wrapped it as `PROVIDER_ERROR` and
    //     rendered it as a POLICY refusal — an outage wearing a policy
    //     rejection's clothes, which PHASE2.4 already paid for once and
    //     PHASE2.5-REVIEW M4 made normative that this must not repeat.
    let infos: readonly {
      token: Address;
      period: number;
      limit: bigint;
      currentSpent: bigint;
    }[];
    try {
      // ONE SHARED DEADLINE OVER BOTH LEGS (PHASE2.5-FIXREVIEW2 G4), the same
      // idiom `#chainWouldAllow` uses.
      //
      // `#connected()` was outside it, and it is not free: `#connect` probes
      // each configured RPC URL with `getChainId()` and no timeout of its own,
      // and its promise is MEMOISED — so the first caller in a process pays the
      // whole probe, and on this path that first caller can be a trade request
      // sitting above a submit. Bounding the read while leaving the connect
      // unbounded is a bound in name only.
      //
      // Worst case is therefore ONE timeout for both legs, not one each.
      infos = await withDeadline(
        (async () => {
          const { publicClient } = await this.#connected();
          return publicClient.readContract({
            address: wallet,
            abi: ACCOUNT_ABI,
            functionName: "spendInfos",
            args: [keyHash],
          });
        })(),
        this.#chainReadTimeoutMs,
      );
    } catch (cause) {
      // PHASE2.5-FIXREVIEW F4. `mapProviderError` classifies on REVERT EVIDENCE
      // first, so a node that decodes `UnauthorizedCall` or `ExceededSpendLimit`
      // out of this read would hand back a POLICY class — and the route would
      // then emit `deniedBy: "transport"` carrying `NOT_ALLOWED`, which is the
      // receipt shape A3 exists to prevent, reached from the other end.
      //
      // A `view` call is not the account refusing anything. It either answered
      // or it did not, so the only honest classes here are the transport ones:
      // an `InfrastructureError` survives (a timeout, a dead endpoint) and
      // everything else is a failed read.
      const mapped = mapProviderError(cause);
      throw mapped instanceof InfrastructureError
        ? mapped
        : new ProviderError(mapped.message);
    }
    const days = infos.filter(
      (info) =>
        info.token === zeroAddress && Number(info.period) === SPEND_PERIOD_DAY,
    );
    // PHASE2.5-REVIEW M2, second half: select the DAY row BY PERIOD and refuse
    // on ambiguity rather than taking the first match. Provisioning writes two
    // zero-address rows (day AND minute), so "the first native row" is already
    // the wrong rule; two DAY rows would mean the account is answering something
    // this code does not model, and sizing an exit on a guess between them is
    // exactly the silent wrong-period read this phase exists to prevent. A throw
    // reaches the buy path as an unreadable meter, which fails CLOSED.
    if (days.length > 1) {
      throw new ProviderError(
        "The account reports more than one daily native spend row for this key.",
      );
    }
    // PHASE2.5-AUDIT A7: DISTINCT TOKENS, not rows. `spendInfos` returns one row
    // per (token, period) pair and `validateSessionSpec` dedups caps by
    // `token:period`, so a token granted at two periods appeared twice and
    // doubled its share of the reserve. The direction was fail-safe, but the
    // count is also PUBLISHED to the owner as "tokens this session can sell",
    // where a doubled number is simply false.
    const grantedTokenCount = new Set(
      infos
        .filter((info) => info.token !== zeroAddress && info.limit > 0n)
        .map((info) => info.token.toLowerCase()),
    ).size;
    const day = days[0];
    if (day === undefined) {
      // PHASE2.5-AUDIT A6. `null` used to mean both of these, and F4 rendered
      // the reassuring one for both. They are not the same account:
      //
      //   - a native row at ANOTHER period (provisioning writes a minute row
      //     too) means today is genuinely unmetered — nothing to run out of;
      //   - NO native row at all means, per FINDINGS (h), that `GuardedExecutor`
      //     finds no limit for the native this buy spends and the batch REVERTS
      //     in the relay's simulation: `PENDING`, no transaction, no gas. The
      //     account cannot buy at all, and the fix is a GRANT, not a cap raise.
      //
      // The provider holds the array that tells them apart, so it says which.
      const nativeAtOtherPeriod = infos.some((info) => info.token === zeroAddress);
      return {
        kind: nativeAtOtherPeriod ? "other-period" : "no-native-grant",
        grantedTokenCount,
      };
    }
    return {
      kind: "day",
      limitWei: day.limit,
      // `currentSpent`, never `spent` — the tuple carries both and they answer
      // different questions (PHASE2.5-REVIEW M2).
      currentSpentWei: day.currentSpent,
      grantedTokenCount,
    };
  }

  async #chainVerdict(
    session: SessionRef,
    refused: readonly WalletCall[],
  ): Promise<boolean> {
    const { publicClient } = await this.#connected();
    const wallet = getAddress(session.walletAddress);
    const keyHash = accountKeyHashForAddress(
      publicKeyToAddress(session.publicKey),
    );

    const [keys, keyHashes] = await publicClient.readContract({
      address: wallet,
      abi: ACCOUNT_ABI,
      functionName: "getKeys",
    });
    const index = keyHashes.findIndex(
      (candidate) => candidate.toLowerCase() === keyHash.toLowerCase(),
    );
    // Not on the account at all, or super-admin: no usable verdict either way.
    if (index < 0 || keys[index]?.isSuperAdmin !== false) return false;

    const [infos, verdicts] = await Promise.all([
      publicClient.readContract({
        address: wallet,
        abi: ACCOUNT_ABI,
        functionName: "spendInfos",
        args: [keyHash],
      }),
      Promise.all(
        refused.map((call) =>
          publicClient.readContract({
            address: wallet,
            abi: ACCOUNT_ABI,
            functionName: "canExecute",
            args: [keyHash, call.to, call.data ?? "0x"],
          }),
        ),
      ),
    ]);

    if (verdicts.some((allowed) => !allowed)) return false;
    for (const call of refused) {
      const selector = callSelector(call.data);
      if (selector === undefined || !VALUE_MOVING_SELECTORS.has(selector)) {
        continue;
      }
      if (!hasSpendLimitFor(infos, call.to)) return false;
    }
    return true;
  }

  /**
   * Execute under a session key. The owner authority is not involved.
   *
   * A policy violation surfaces as `status: "FAILED"` rather than a throw, so
   * callers must inspect the status — see FINDINGS.md (f).
   *
   * The pre-flight below is a cost control, not a security control: the chain
   * is what enforces the policy. It exists because every rejected execute
   * still costs a relay round trip, and an expired session fails after tens of
   * seconds of polling rather than immediately.
   *
   * It runs HERE as well as at the route (PHASE2.4 R3 item 10), deliberately.
   * The route's call is what makes a refusal classifiable as pre-submission;
   * this one is what keeps the provider safe for any future caller that forgets.
   * The duplicate costs nothing in the common case — a granted batch never
   * leaves the process — and one extra chain read in the case that was already
   * paying for one.
   */
  async executeViaSession(
    params: ExecuteViaSessionParams,
  ): Promise<ExecutionReceipt> {
    throwIfAborted(params.signal);
    if (params.bypassLocalPolicyCheck !== true) {
      await this.preflightExecute({
        session: params.session,
        calls: params.calls,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
      });
    } else if (params.calls.length === 0) {
      // The batch-shape guards are not policy and are not bypassable: an empty
      // or oversized batch is malformed however the caller feels about the
      // allowlist.
      throw new ProviderError("executeViaSession requires at least one call.");
    } else if (params.calls.length > MAX_CALLS_PER_EXECUTE) {
      throw new ProviderError(
        `executeViaSession accepts at most ${MAX_CALLS_PER_EXECUTE} calls per batch; got ${params.calls.length}.`,
      );
    }

    // UNCONDITIONAL, bypass or not (PHASE2.4 R1 item 1, audit A4). The bypass
    // exists to skip the ALLOWLIST — a snapshot that may lag the chain — and the
    // two targets below are not an allowlist question. A call into the wallet's
    // own admin surface or into the KeyStore that bounds this very session is
    // the one escalation this service refuses on its own account, so it cannot
    // be conditional on a flag whose whole purpose is to relax a different
    // check. `bypassLocalPolicyCheck` remains unreachable from any request
    // field; this makes the word "unconditionally" true of what ships. Under a
    // non-bypassed call `preflightExecute` has already applied the identical
    // predicate, so this is a repeat, and a repeat of a pure comparison is the
    // cheapest kind of defence in depth there is.
    for (const call of params.calls) {
      const refusal = structuralTargetRefusal(call.to, {
        walletAddress: params.session.walletAddress,
        keyStoreAddress: this.network.keyStore,
      });
      if (refusal !== null) throw new NotAllowedError(refusal);
    }

    const session = sessionHandle(params.session);
    try {
      // BOUNDED. Every other wait in this file has a ceiling — the data-plane
      // client 5s, `#awaitReceipt` 120s, `awaitExecution` its own deadline — and
      // this one, the only wait that costs money, had none. Measured live: a
      // trade sat on this await indefinitely while the same process answered
      // `/health` in 30ms and refused an unauthorised token in 0.5s, so the
      // operator saw a client that printed a quote and then nothing, forever.
      //
      // A TIMEOUT HERE IS AMBIGUOUS, NEVER A FAILURE. The relay may have
      // accepted the bundle and simply not answered us, so the throw lands in
      // the catch below and the route journals UNKNOWN and HOLDS the spend —
      // journal invariant (b). It must stay INSIDE this try for that reason:
      // hoisting it above would make it a pre-submission refusal under PHASE2.4
      // R3's positional rule, which would release budget for a trade that may
      // be mining. That is the double spend, arriving through the fix.
      const result = await withTimeout(
        this.#client.execute({
          session,
          calls: params.calls.map((call) => ({
            to: call.to,
            ...(call.value === undefined ? {} : { value: call.value }),
            ...(call.data === undefined ? {} : { data: call.data }),
          })),
        }),
        this.#submitTimeoutMs,
        `The relay did not answer within ${this.#submitTimeoutMs}ms. Whether it accepted the submission is UNKNOWN.`,
      );
      throwIfAborted(params.signal);
      const receipt = toReceipt(result);
      // The session path reports a policy rejection as FAILED WITHOUT throwing,
      // so it never reaches the catch below. Classify it here, off the returned
      // body, using the same matchers the throw path uses.
      if (receipt.status === "FAILED") {
        return { ...receipt, failureCode: classifyFailureCode(result) };
      }
      return receipt;
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Resolve a submitted execute by its `callsId`, polling the relay's
   * EIP-5792 `wallet_getCallsStatus`. Never submits anything.
   */
  async awaitExecution(
    params: AwaitExecutionParams,
  ): Promise<ExecutionReceipt> {
    throwIfAborted(params.signal);
    const relayUrl = this.network.relayUrl;
    if (relayUrl === undefined) {
      throw new ProviderError(
        `No Altana relay serves chain ${this.network.chainId}; a submitted call cannot be polled.`,
      );
    }
    const client = createViemClient({
      chain: this.network.chain,
      transport: this.#transport(relayUrl),
    }) as unknown as RelayRequestClient;
    const deadline = Date.now() + this.#awaitTimeoutMs;
    try {
      for (;;) {
        throwIfAborted(params.signal);
        const status = await client.request({
          method: "wallet_getCallsStatus",
          params: [params.callsId],
        });
        const receipt = toCallsStatusReceipt(params.callsId, status);
        if (receipt.status !== "PENDING") return receipt;
        if (Date.now() >= deadline) return receipt;
        await delay(this.#awaitPollIntervalMs, params.signal);
      }
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * ONE relay status read, no polling loop (PHASE3.14 F2).
   *
   * `awaitExecution` above is the right shape for `reconcile` and the wrong
   * shape for an owner-signed HTTP action: it polls to `#awaitTimeoutMs` and
   * only THEN reports PENDING, so a relay stably answering an unmapped status
   * — the live 08-25 incident's `{"status":300,"receipts":[]}` — would hold the
   * request open for two minutes before saying nothing. This asks once and
   * returns, carrying the relay's own status field alongside the mapped receipt
   * so the operator's evidence can name the status the mapping discarded.
   *
   * `toCallsStatusReceipt` is reused VERBATIM and deliberately not changed:
   * PHASE3.14 R-C (mapping 300) stays blocked until Altana documents it, and
   * this seam is what makes the system honest without that answer.
   */
  async readExecutionStatus(
    params: AwaitExecutionParams,
  ): Promise<ExecutionStatusReading> {
    throwIfAborted(params.signal);
    const relayUrl = this.network.relayUrl;
    if (relayUrl === undefined) {
      throw new ProviderError(
        `No Altana relay serves chain ${this.network.chainId}; a submitted call cannot be polled.`,
      );
    }
    const client = createViemClient({
      chain: this.network.chain,
      transport: this.#transport(relayUrl),
    }) as unknown as RelayRequestClient;
    try {
      const status = await client.request({
        method: "wallet_getCallsStatus",
        params: [params.callsId],
      });
      return {
        receipt: toCallsStatusReceipt(params.callsId, status),
        rawStatus: rawCallsStatus(status),
      };
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /** Revoke via the Altana relay. Requires owner authority only. */
  async revokeSession(params: RevokeSessionParams): Promise<ExecutionReceipt> {
    throwIfAborted(params.signal);
    const { signer } = ownerHandle(params.owner);
    const session =
      typeof params.session === "string"
        ? params.session
        : sessionHandle(params.session);
    try {
      const result = await this.#client.revokeSession({
        wallet: { address: params.wallet.address },
        signer,
        session,
      });
      throwIfAborted(params.signal);
      return toReceipt(result);
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  async getBalance(params: GetBalanceParams): Promise<bigint> {
    throwIfAborted(params.signal);
    try {
      const { publicClient } = await this.#connected();
      return await publicClient.getBalance({ address: params.address });
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /** ERC-20 `balanceOf` for the wallet. */
  async getTokenBalance(params: GetTokenBalanceParams): Promise<bigint> {
    throwIfAborted(params.signal);
    try {
      const { publicClient } = await this.#connected();
      return await publicClient.readContract({
        address: params.token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [params.wallet.address],
      });
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  async getTokenMetadata(
    params: GetTokenMetadataParams,
  ): Promise<{ decimals: number; symbol: string | null }> {
    throwIfAborted(params.signal);
    try {
      const { publicClient } = await this.#connected();
      const decimals = await publicClient.readContract({
        address: params.token,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      let symbol: string | null = null;
      try {
        const value = await publicClient.readContract({
          address: params.token,
          abi: ERC20_ABI,
          functionName: "symbol",
        });
        const trimmed = value.trim();
        if (trimmed.length > 0 && trimmed.length <= 32) symbol = trimmed;
      } catch {
        // Symbol is presentation only; decimals remain enough to value a token.
      }
      return { decimals, symbol };
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Read Four.Meme's `TokenManagerHelper3` for one token and one proposed trade.
   *
   * TWO reads, always (PHASE2.1 R3): `getTokenInfo` unconditionally, plus
   * `tryBuy` for a buy or `trySell` for a sell. `getTokenInfo` is authoritative
   * for the version, the manager, the quote currency and the graduation flag;
   * `tryBuy`/`trySell` are authoritative for the money. When the two disagree
   * about the manager or about the quote currency this throws instead of
   * picking a winner — a helper contradicting itself is not a helper whose
   * numbers should decide a transfer.
   *
   * Chain state, over the pinned client, exactly like `getTokenBalance`. It is
   * emphatically not a market-data call: no third party is asked anything, and
   * `estimatedOutWei` is carried for observability and never gated on.
   */
  async readFourMemeQuote(
    params: ReadFourMemeQuoteParams,
  ): Promise<FourMemeQuote> {
    throwIfAborted(params.signal);
    const helper = this.#fourMemeHelper;
    if (helper === undefined) {
      throw new ProviderError(
        `No Four.Meme helper is configured for chain ${this.network.chainId}; the venue is unavailable here.`,
      );
    }
    try {
      const { publicClient } = await this.#connected();
      const info = await publicClient.readContract({
        address: helper,
        abi: FOUR_MEME_HELPER_ABI,
        functionName: "getTokenInfo",
        args: [params.token],
      });
      throwIfAborted(params.signal);

      const tokenManager = getAddress(info[1]);
      const quoteRaw = getAddress(info[2]);
      const quoteToken = quoteRaw === zeroAddress ? null : quoteRaw;
      const base = {
        version: Number(info[0]),
        tokenManager,
        quoteToken,
        liquidityAdded: info[11],
      } as const;

      if (params.side === "buy") {
        // `amount = 0, funds = amountWei` is the AMAP ("spend these funds")
        // sizing the reference implementation uses, and the only one whose
        // `amountMsgValue` answers the question we are asking.
        const buy = await publicClient.readContract({
          address: helper,
          abi: FOUR_MEME_HELPER_ABI,
          functionName: "tryBuy",
          args: [params.token, 0n, params.amountWei],
        });
        this.#assertQuoteAgrees(base, buy[0], buy[1]);
        return {
          ...base,
          estimatedOutWei: buy[2],
          msgValueWei: buy[5],
          approvalWei: buy[6],
          fundsWei: buy[7],
        };
      }

      const sell = await publicClient.readContract({
        address: helper,
        abi: FOUR_MEME_HELPER_ABI,
        functionName: "trySell",
        args: [params.token, params.amountWei],
      });
      this.#assertQuoteAgrees(base, sell[0], sell[1]);
      return { ...base, estimatedFundsOutWei: sell[2] };
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Read flap.sh's Portal for one token.
   *
   * ONE read, `getTokenV5`, over the pinned Portal — not two as the Four.Meme
   * path needs, because there is no money field to cross-check: flap quoting is
   * the caller's job (`quoteExactInput` is `nonpayable`, so it is a simulate,
   * and the caller already supplies `quotedOutWei`/`minOutWei` on every venue).
   *
   * FAIL-CLOSED WITHOUT ANY HELP FROM US, which is the opposite of the
   * Four.Meme "zero-read hazard": the Portal REVERTS `0xde6137d1<address>` for
   * an address it does not know, so a successful return already means "this is
   * a flap token". Copying the zero-bounding from the other venue would be
   * cargo cult; the route's refusals here are about what SHAPE of flap token it
   * is, not whether it is one.
   */
  async readFlapTokenState(
    params: ReadFlapTokenStateParams,
  ): Promise<FlapTokenState> {
    throwIfAborted(params.signal);
    const portal = this.#flapPortal;
    if (portal === undefined) {
      throw new ProviderError(
        `No flap Portal is configured for chain ${this.network.chainId}; the venue is unavailable here.`,
      );
    }
    try {
      const { publicClient } = await this.#connected();
      const state = await publicClient.readContract({
        address: portal,
        abi: FLAP_PORTAL_ABI,
        functionName: "getTokenV5",
        args: [params.token],
      });
      const quoteRaw = getAddress(state.quoteTokenAddress);
      return {
        status: Number(state.status),
        quoteToken: quoteRaw === zeroAddress ? null : quoteRaw,
        nativeToQuoteSwapEnabled: state.nativeToQuoteSwapEnabled,
        extensionId: state.extensionID,
        dexSupplyThresh: state.dexSupplyThresh,
        circulatingSupply: state.circulatingSupply,
      };
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * The cross-check between the helper's two answers (PHASE2.1 R3).
   *
   * A mismatch is not a rounding disagreement — it means one of the two reads
   * describes a different token, a different manager, or a different currency
   * than the other. Approving the manager from one read and sending value
   * computed by the other would be building a trade out of two unrelated
   * facts, so this refuses rather than choosing. Addresses only: the amounts
   * have no counterpart to compare against and are bounded by the caller.
   */
  #assertQuoteAgrees(
    info: { readonly tokenManager: Address; readonly quoteToken: Address | null },
    manager: Address,
    quote: Address,
  ): void {
    if (getAddress(manager) !== info.tokenManager) {
      throw new ProviderError(
        "Four.Meme helper reported two different token managers for one token; refusing to trade on a contradiction.",
      );
    }
    const quoted = getAddress(quote);
    const asInfo = info.quoteToken ?? zeroAddress;
    if (quoted !== getAddress(asInfo)) {
      throw new ProviderError(
        "Four.Meme helper reported two different quote currencies for one token; refusing to trade on a contradiction.",
      );
    }
  }

  /**
   * The ERC-20s this session may currently move, read from the account.
   *
   * Authoritative where the granted spec is not. `setSpendLimit` changes a live
   * session's limits without a re-grant (FINDINGS (i)), so the snapshot drifts
   * behind the chain by design. Measured on the live mainnet wallet: the
   * snapshot recorded one cap while the account enforced seven.
   *
   * WHY THE PERSISTED SPEC IS NOT SIMPLY REWRITTEN TO CATCH UP (PHASE2.4 R7).
   * This comment used to say `restoreSession` needs it byte-exact. That is FALSE
   * as stated and was never verified: `restoreSession` derives nothing
   * on-chain-identifying from the spec — the key hash is
   * `keccak256(keyType, keccak256(publicKey))` with permissions EXCLUDED (porto
   * `Key.hash`), and the spec only rebuilds a local `SessionPermissions`. The
   * accurate reason is one layer further out: the SDK forwards the granted
   * permissions to the RELAY as the key descriptor on every execute, and whether
   * the relay enforces that descriptor is an OPEN ASSUMPTION — see FINDINGS (x).
   * Until it is settled, a widened spec is a change whose failure mode is a
   * relay that silently declines to submit, so the spec stays as granted and the
   * chain is asked instead.
   */
  async canSessionSellToken(
    params: CanSessionSellTokenParams,
  ): Promise<boolean> {
    throwIfAborted(params.signal);
    try {
      const { publicClient } = await this.#connected();
      const keyHash = accountKeyHashForAddress(
        publicKeyToAddress(params.sessionPublicKey),
      );

      // BOTH halves, because either one alone is a trap. A token with a spend
      // limit and no allowlist entry passes every list an operator is likely to
      // read and still cannot be sold — measured live: `owner-add-spend-limit`
      // granted the limit, `spendInfos` showed it, and `canExecute(approve)`
      // returned false, so the sell never submitted and the position stuck.
      const approveProbe = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        // Arguments are irrelevant to the check: the account matches on target
        // and selector only. The wallet is used as a harmless stand-in spender.
        args: [params.wallet.address, 1n],
      });

      const [infos, canApprove] = await Promise.all([
        publicClient.readContract({
          address: params.wallet.address,
          abi: ACCOUNT_ABI,
          functionName: "spendInfos",
          args: [keyHash],
        }),
        publicClient.readContract({
          address: params.wallet.address,
          abi: ACCOUNT_ABI,
          functionName: "canExecute",
          args: [keyHash, params.token, approveProbe],
        }),
      ]);

      if (!canApprove) return false;
      return hasSpendLimitFor(infos, params.token);
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Sweep the wallet's entire native balance to `to`, using the owner key and
   * a public RPC only.
   *
   * No Altana relay, no 4lpha server, no agent key. The wallet address IS the
   * owner's EOA, so this is an ordinary signed transaction: an EIP-7702
   * delegation constrains what happens when the account is CALLED, never the
   * account's own ability to originate transactions.
   *
   * That whole argument is a `self-eoa` argument, and PHASE1.5 makes the other
   * case explicit rather than leaving it to be discovered.
   */
  async ownerRecoverNative(
    params: OwnerRecoverParams,
  ): Promise<ExecutionReceipt> {
    throwIfAborted(params.signal);
    // REFUSED ON CUSTODY, not on a missing handle, and the distinction is the
    // point: under passkey custody there is no secp256k1 owner key to originate
    // a transaction with, the wallet address is a discarded throwaway EOA's
    // (FINDINGS (a)), and `wallet.ownerAddress` is a derived IDENTITY that
    // cannot receive funds. Falling through to the handle check below would
    // report this as "no private-key authority", which is true and useless.
    if (params.wallet.custodyModel === "passkey") {
      throw new ProviderError(
        "Relay-independent native recovery is not available under passkey custody: " +
          "there is no owner private key, and the owner address is a derived identity " +
          "that cannot hold or receive funds.",
      );
    }
    const { account } = ownerHandle(params.owner);
    if (account === undefined) {
      throw new ProviderError(
        "Relay-independent recovery requires a private-key owner authority.",
      );
    }
    if (getAddress(account.address) !== getAddress(params.wallet.address)) {
      throw new ProviderError(
        "Owner authority does not control the wallet address.",
      );
    }
    if (getAddress(params.to) === zeroAddress) {
      throw new ProviderError(
        "Recovery destination is the zero address; the sweep would burn the balance.",
      );
    }

    try {
      const { publicClient, rpcUrl } = await this.#connected();
      const walletClient = this.#walletClient(account, rpcUrl);

      const balance = await publicClient.getBalance({
        address: params.wallet.address,
      });
      const gasPrice = await publicClient.getGasPrice();
      const gasBudget = await this.#recoveryGasBudget(
        publicClient,
        account,
        params.to,
      );
      // 25% headroom on price as well as limit: a sweep sends everything but
      // the fee, so if the price rises between estimation and inclusion there
      // is no balance left to absorb it and the transaction simply stalls.
      const gasPriceBudget = (gasPrice * 125n) / 100n;
      const fee = gasBudget * gasPriceBudget;

      if (balance <= fee) {
        throw new ProviderError(
          "Wallet balance does not cover the gas required to sweep it.",
        );
      }

      throwIfAborted(params.signal);
      const transactionHash = await walletClient.sendTransaction({
        to: params.to,
        value: balance - fee,
        gas: gasBudget,
        gasPrice: gasPriceBudget,
      });
      return await this.#awaitReceipt(publicClient, transactionHash);
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Sweep ERC-20 balances back to `to` using the owner key alone.
   *
   * Not implemented yet: no automated flow holds token positions until Phase 2,
   * and shipping a half-built token sweep that silently no-ops would be worse
   * than a clear refusal. The signature is on the interface now so the seam
   * does not have to be reopened later. The native sweep above is unaffected.
   *
   * DESTINATION INVARIANT for whoever implements it (PHASE1.5 D1): `params.to`
   * is the explicit, owner-signed destination and MUST NOT be defaulted to
   * `params.wallet.ownerAddress`. Under passkey custody that address is derived
   * from a P256 credential and no secp256k1 key exists for it — a sweep sent
   * there is burned, silently and irreversibly. The same refusal
   * `ownerRecoverNative` makes for passkey custody belongs here too.
   */
  async ownerRecoverTokens(
    params: OwnerRecoverTokensParams,
  ): Promise<readonly ExecutionReceipt[]> {
    throwIfAborted(params.signal);
    throw new NotImplementedError(
      `ownerRecoverTokens is not available until Phase 2 (requested sweep of ${params.tokens.length} token(s)); use ownerRecoverNative for the native balance.`,
    );
  }

  /**
   * Gas to budget for the sweep.
   *
   * A destination with no code can only ever cost the 21000 intrinsic — no
   * estimate, no headroom, no room for an RPC to be wrong about it. Contracts
   * get an estimate plus headroom, bounded, because a receive hook's cost is
   * genuinely unknowable ahead of time.
   */
  async #recoveryGasBudget(
    publicClient: PublicClient,
    account: PrivateKeyAccount,
    to: Address,
  ): Promise<bigint> {
    const code = await publicClient.getCode({ address: to });
    if (code === undefined || code === "0x") return EOA_TRANSFER_GAS;

    const gasLimit = await publicClient.estimateGas({ account, to, value: 1n });
    const gasBudget = (gasLimit * 125n) / 100n;
    if (gasBudget > MAX_RECOVERY_GAS) {
      throw new ProviderError(
        `Recovery gas estimate of ${gasBudget} exceeds the ${MAX_RECOVERY_GAS} ceiling; the endpoint is misreporting or the destination is not a plain recipient. Refusing to sweep and hand the difference to the validator.`,
      );
    }
    return gasBudget < EOA_TRANSFER_GAS ? EOA_TRANSFER_GAS : gasBudget;
  }

  /**
   * Revoke a session using the owner key and a public RPC only.
   *
   * Two transactions, both originated by the owner's EOA:
   *   1. a self-call to `IthacaAccount.revoke(keyHash)`. On Altana this
   *      normally reverts `KeyDoesNotExist()`, because session authority lives
   *      in the KeyStore and the account's own key list holds only the admin
   *      key (FINDINGS.md, mainnet addendum). That ONE revert is tolerated;
   *      any other is fatal, because "some revert happened" is not evidence
   *      that a kill switch fired.
   *   2. `AltanaKeyStore.revokeKey(wallet, keyId)` — the leg that actually
   *      strips session authority. Sent only if the key is registered, since
   *      revoking an absent key reverts.
   *
   * The verdict is read back from chain state and returned as `revoked`.
   *
   * `sessionAddress` is the EOA address of the session key, which is what the
   * account hashes for secp256k1 keys. `sessionPublicKey` is the SEC1 key the
   * KeyStore indexes by.
   */
  async ownerRevokeSessionDirect(params: {
    readonly wallet: AgentWalletRef;
    readonly owner: OwnerAuthority;
    readonly sessionAddress: Address;
    readonly sessionPublicKey: Hex;
    readonly signal?: AbortSignal;
  }): Promise<OwnerRevokeSessionDirectResult> {
    throwIfAborted(params.signal);
    const { account } = ownerHandle(params.owner);
    if (account === undefined) {
      throw new ProviderError(
        "Relay-independent revocation requires a private-key owner authority.",
      );
    }
    // The account-level leg is a SELF-call: it only satisfies the account's
    // `onlyThis` gate when the sender is the wallet. Sending it from an owner
    // key that is not this wallet burns gas on a guaranteed revert and, worse,
    // reports it as a revocation attempt that "was made".
    if (getAddress(account.address) !== getAddress(params.wallet.address)) {
      throw new ProviderError(
        "Owner authority does not control the wallet address.",
      );
    }

    try {
      const { publicClient, rpcUrl } = await this.#connected();
      const walletClient = this.#walletClient(account, rpcUrl);
      const keyHash = accountKeyHashForAddress(params.sessionAddress);

      let accountKeyAbsent = false;
      let accountRevokeHash: Hex | undefined;
      try {
        accountRevokeHash = await walletClient.sendTransaction({
          to: params.wallet.address,
          data: encodeFunctionData({
            abi: ACCOUNT_ABI,
            functionName: "revoke",
            args: [keyHash],
          }),
        });
      } catch (cause) {
        if (
          !mentionsRevertSelector(cause, REVERT_SELECTORS.KeyDoesNotExist)
        ) {
          throw mapProviderError(cause);
        }
        accountKeyAbsent = true;
      }

      const accountRevoke: ExecutionReceipt =
        accountRevokeHash === undefined
          ? { status: "FAILED" }
          : await this.#awaitReceipt(publicClient, accountRevokeHash);

      throwIfAborted(params.signal);
      const keyId = keccak256(params.sessionPublicKey);
      const registered = await publicClient.readContract({
        address: this.network.keyStore,
        abi: KEYSTORE_ABI,
        functionName: "isValidKey",
        args: [params.wallet.address, keyId],
      });

      let keyStoreRevoke: ExecutionReceipt | undefined;
      if (registered) {
        const keyStoreHash = await walletClient.sendTransaction({
          to: this.network.keyStore,
          data: encodeFunctionData({
            abi: KEYSTORE_ABI,
            functionName: "revokeKey",
            args: [params.wallet.address, keyId],
          }),
        });
        keyStoreRevoke = await this.#awaitReceipt(publicClient, keyStoreHash);
      }

      // Post-condition, read from the chain. Never inferred from the receipts:
      // a CONFIRMED transaction that revoked the wrong key hash looks exactly
      // like a successful revocation from the outside.
      const keyStoreRegistered = await publicClient.readContract({
        address: this.network.keyStore,
        abi: KEYSTORE_ABI,
        functionName: "isValidKey",
        args: [params.wallet.address, keyId],
      });
      const accountKeyPresent = await this.#accountKeyPresent(
        publicClient,
        params.wallet.address,
        keyHash,
      );

      return {
        revoked: !keyStoreRegistered && accountKeyPresent !== true,
        accountRevoke,
        accountKeyAbsent,
        ...(keyStoreRevoke === undefined ? {} : { keyStoreRevoke }),
        keyStoreRegistered,
        ...(accountKeyPresent === undefined ? {} : { accountKeyPresent }),
      };
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }

  /**
   * Whether the account's own key list still holds `keyHash`.
   *
   * Best effort by design: `getKeys()` reverts on an EOA that carries no
   * delegation, which is a perfectly normal state here and not a failure of
   * the revocation.
   */
  async #accountKeyPresent(
    publicClient: PublicClient,
    wallet: Address,
    keyHash: Hex,
  ): Promise<boolean | undefined> {
    try {
      const [, keyHashes] = await publicClient.readContract({
        address: wallet,
        abi: ACCOUNT_ABI,
        functionName: "getKeys",
      });
      return keyHashes.some(
        (candidate) => candidate.toLowerCase() === keyHash.toLowerCase(),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * The primary, relay-independent kill switch.
   *
   * Wraps {@link ownerRevokeSessionDirect}, collapsing its rich diagnostic
   * result into the interface shape: the read-back `revoked` verdict, and every
   * receipt the revoke produced (account-level first, then keystore-level). The
   * `revoked` boolean is passed through untouched — it is read from chain state,
   * never re-derived from the receipts here.
   */
  async ownerRevokeSession(
    params: OwnerRevokeSessionParams,
  ): Promise<OwnerRevokeSessionResult> {
    const direct = await this.ownerRevokeSessionDirect({
      wallet: params.wallet,
      owner: params.owner,
      sessionAddress: params.sessionAddress,
      sessionPublicKey: params.sessionPublicKey,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    const receipts: ExecutionReceipt[] = [direct.accountRevoke];
    if (direct.keyStoreRevoke !== undefined) receipts.push(direct.keyStoreRevoke);
    return { revoked: direct.revoked, receipts };
  }

  /**
   * Whether a session key is still usable.
   *
   * KeyStore registration proves the key EXISTS on-chain, not that it is still
   * within its expiry — the account enforces expiry separately, so a registered
   * key can be expired. When `expiresAt` is supplied this returns
   * `registered AND now < expiresAt` (and short-circuits to `false` without a
   * network read once the clock is past expiry). When it is omitted this returns
   * registration only; document that at the call site.
   */
  async isSessionActive(params: IsSessionActiveParams): Promise<boolean> {
    throwIfAborted(params.signal);
    if (
      params.expiresAt !== undefined &&
      Math.floor(Date.now() / 1000) >= params.expiresAt
    ) {
      return false;
    }
    return this.#isKeyRegistered(params.wallet.address, params.publicKey);
  }

  /** Read the public KeyStore registry. Used to prove a key exists on-chain. */
  async #isKeyRegistered(wallet: Address, publicKey: Hex): Promise<boolean> {
    try {
      const { publicClient } = await this.#connected();
      return await publicClient.readContract({
        address: this.network.keyStore,
        abi: KEYSTORE_ABI,
        functionName: "isValidKey",
        args: [wallet, keccak256(publicKey)],
      });
    } catch (cause) {
      throw mapProviderError(cause);
    }
  }
}

/**
 * The 4-byte selector a call's calldata invokes, or `undefined` for a call that
 * carries none (a plain value transfer).
 */
function callSelector(data: Hex | undefined): Hex | undefined {
  if (data === undefined || data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase() as Hex;
}

/**
 * Whether one rule permits one call.
 *
 * The three shapes, per `CallRule`'s AND semantics:
 *   - `to` only        — any function on that contract;
 *   - `to` + selector  — that function on that contract;
 *   - selector only    — that function on ANY contract (the opt-in over-grant).
 *
 * A malformed selector string matches NOTHING. `validateSessionSpec` rejects
 * those at grant time, so reaching one here means the persisted spec is corrupt,
 * and a rule nobody can parse must not be the reason a call is permitted.
 */
function ruleAllows(
  rule: { readonly to?: Address; readonly selector?: string },
  call: { readonly to: Address; readonly data?: Hex },
): boolean {
  if (rule.to !== undefined && rule.to.toLowerCase() !== call.to.toLowerCase()) {
    return false;
  }
  if (rule.selector === undefined) {
    // No function constraint: a target-bound rule permits everything on it.
    return rule.to !== undefined;
  }
  const selector = callSelector(call.data);
  if (selector === undefined) return false;
  let expected: Hex;
  try {
    expected = toFunctionSelector(rule.selector);
  } catch {
    return false;
  }
  return expected.toLowerCase() === selector;
}

/**
 * Whether the GRANTED SNAPSHOT permits one call, on its own.
 *
 * This is a cost control, not a security control — the account contract is what
 * enforces the policy — but it used to be neither. The previous version bailed
 * out entirely the moment ANY rule lacked a `to`, so a single bare-selector
 * rule (`approve(address,uint256)` on the trade template, say) switched the whole
 * pre-flight off and let a call to an arbitrary target through to the relay. It
 * also never matched selector rules against calldata at all, so those rules could
 * only ever weaken the check and never satisfy it.
 *
 * Now each call is evaluated on its own: it passes if SOME rule permits it, and a
 * bare-selector rule permits only the calls whose first four bytes it names.
 *
 * A `false` here is NOT the final verdict (PHASE2.4 D1). It means the grant does
 * not name this call, which is a different claim from "the owner never
 * authorised it" — the caller asks the chain about the remainder.
 */
function snapshotAllows(
  session: SessionRef,
  call: { readonly to: Address; readonly data?: Hex },
): boolean {
  return session.spec.allowedCalls.some((rule) => ruleAllows(rule, call));
}

/** One `spendInfos` row, as `ACCOUNT_ABI` decodes it. */
type SpendInfo = {
  readonly token: Address;
  readonly limit: bigint;
};

/**
 * Whether the account is enforcing a POSITIVE spend limit for `token` on this
 * key — the meter half of a session, the half `canExecute` says nothing about.
 *
 * ONE implementation, shared by the buy gate (`canSessionSellToken`) and by the
 * execute pre-flight's chain fallback, because they are asking the same
 * question and FINDINGS (u) is what a second, subtly different answer costs.
 * The zero-address row is the NATIVE meter and is deliberately not matchable: a
 * caller asking about `0x0` is asking about a token that is not one.
 */
function hasSpendLimitFor(
  infos: readonly SpendInfo[],
  token: Address,
): boolean {
  const target = token.toLowerCase();
  return infos.some(
    (info) =>
      info.token !== zeroAddress &&
      info.limit > 0n &&
      info.token.toLowerCase() === target,
  );
}

/**
 * What the chain-side pre-flight fallback could establish.
 *
 * `refused` and `undetermined` BOTH refuse the execute — the difference is only
 * what the caller is told, and PHASE3.1-FIXREVIEW F1 is the finding that the
 * difference was being thrown away. See `#chainWouldAllow`.
 */
type ChainFallbackVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused" }
  | { readonly kind: "undetermined"; readonly cause: ExecutionPlaneError };

/**
 * Resolve `promise`, or reject once `ms` has passed.
 *
 * The loser is left running rather than cancelled, because there is nothing to
 * cancel: viem's read is already in flight and the SDK takes no signal. What
 * matters is that the CALLER stops waiting, and that the timeout path is a
 * rejection — every rejection in the pre-flight's fallback fails closed.
 *
 * The rejection is an {@link InfrastructureError}, not a `ProviderError`
 * (PHASE3.1-FIXREVIEW F1). A deadline expiring is the definition of a transport
 * failure, and typing it as the generic "something upstream went wrong" left
 * the one caller that classifies this — `#chainWouldAllow` — unable to tell a
 * dead endpoint from an unrecognised one.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new InfrastructureError("Chain pre-flight read timed out."));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

function toReceipt(result: {
  status: "PENDING" | "CONFIRMED" | "FAILED";
  transactionHash?: Hex;
  callsId: Hex;
}): ExecutionReceipt {
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash === undefined
      ? {}
      : { transactionHash: result.transactionHash }),
  };
}

/** Narrow request surface `awaitExecution` needs from a viem relay client. */
type RelayRequestClient = {
  request(args: {
    readonly method: "wallet_getCallsStatus";
    readonly params: readonly [Hex];
  }): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Map an EIP-5792 `wallet_getCallsStatus` response to a receipt.
 *
 * The relay reports the status either numerically (per EIP-5792: 100 pending,
 * 200 confirmed, 4xx/5xx failed) or as porto's `"CONFIRMED"`/`"FAILED"` string.
 * Both are handled; anything else is treated as still pending.
 */
function toCallsStatusReceipt(callsId: Hex, status: unknown): ExecutionReceipt {
  const record = isRecord(status) ? status : {};
  const code = record["status"];
  const transactionHash = firstReceiptHash(record["receipts"]);
  const base: ExecutionReceipt = { status: "PENDING", callsId };

  const confirmed =
    code === 200 ||
    code === "CONFIRMED" ||
    (typeof code === "string" && code.toUpperCase() === "SUCCESS");
  if (confirmed) {
    return {
      ...base,
      status: "CONFIRMED",
      ...(transactionHash === undefined ? {} : { transactionHash }),
    };
  }

  const failed =
    code === 500 ||
    (typeof code === "number" && code >= 400) ||
    code === "FAILED" ||
    (typeof code === "string" && code.toUpperCase() === "REVERTED");
  if (failed) {
    return {
      ...base,
      status: "FAILED",
      ...(transactionHash === undefined ? {} : { transactionHash }),
    };
  }

  return base;
}

/**
 * The relay's own `status` field, stringified, for operator EVIDENCE only
 * (PHASE3.14 F2).
 *
 * Separate from {@link toCallsStatusReceipt} so that mapping stays untouched:
 * this reports what was said, that one decides what it means, and the whole
 * point of the pair is that an unmapped status is visible instead of silently
 * becoming PENDING.
 */
function rawCallsStatus(status: unknown): string {
  const record = isRecord(status) ? status : {};
  const code = record["status"];
  if (code === undefined) return "absent";
  return typeof code === "string" ? code : String(code);
}

function firstReceiptHash(receipts: unknown): Hex | undefined {
  if (!Array.isArray(receipts)) return undefined;
  const first = receipts[0];
  if (!isRecord(first)) return undefined;
  const hash = first["transactionHash"];
  return typeof hash === "string" ? (hash as Hex) : undefined;
}

/** Sleep that resolves early on abort rather than after the full interval. */
/**
 * Bound a promise that has no timeout of its own.
 *
 * The underlying work is NOT cancelled — it cannot be, the SDK takes no signal —
 * so the caller must treat a timeout as "outcome unknown" rather than "did not
 * happen". The timer is cleared on either settlement so a resolved call does not
 * hold the process open.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
