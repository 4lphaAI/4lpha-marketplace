/**
 * Provider-agnostic contract for the 4lpha execution plane.
 *
 * This module is the adapter seam. Nothing here imports a wallet SDK, so a
 * second provider (or a vault-fallback design) can be dropped in behind the
 * same interface without touching callers.
 *
 * Terminology used throughout:
 *   - OWNER   the end user. Holds the admin authority for a wallet. Never the
 *             server.
 *   - AGENT   a hired automation. Holds only a session key, which is scoped
 *             on-chain by an allowlist, spend caps, and an expiry.
 *   - SESSION the on-chain delegation from owner authority to an agent key.
 */
import type { Address, Hex } from "viem";
import type { PortoStagedLpSubmit } from "../lp/preparedIntent.js";

/* -------------------------------------------------------------------------- */
/* Session policy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Rolling window a spend cap is measured over.
 *
 * NOTE (verified against @altananetwork/sdk 0.7.0): Altana expresses caps ONLY
 * as a limit per rolling period per token. There is no lifetime/total cap
 * primitive. See FINDINGS.md answer (d).
 */
export type SpendPeriod =
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

/**
 * One spending cap. Caps are per-token: a session with no cap for a given
 * token is uncapped for that token, so a policy must enumerate every token an
 * agent may move.
 */
export type SpendCap = {
  /** Cap in the token's smallest unit (wei for native BNB). */
  readonly limit: bigint;
  /** Rolling window the limit resets over. */
  readonly period: SpendPeriod;
  /** ERC-20 address. Omit for the chain's native token. */
  readonly token?: Address;
};

/**
 * A single allowed-call rule. Fields combine with AND semantics: a rule with
 * both `to` and `selector` permits that function on that contract only.
 */
export type CallRule = {
  /** Contract the agent may call. Omit to allow the function on any target. */
  readonly to?: Address;
  /**
   * Human-readable function signature, e.g. `"transfer(address,uint256)"`.
   * Omit to allow any function on `to`.
   */
  readonly selector?: string;
};

/**
 * The policy a user attaches to a hired agent.
 *
 * DEVIATION from the Phase 0 brief's sketch (`capTotalWei`): a single total cap
 * is not expressible on Altana. `spendCaps` is the faithful shape. A total cap
 * must be emulated off-chain by the execution plane, or by funding the wallet
 * with only the amount the agent may spend.
 */
export type SessionSpec = {
  /**
   * Contracts/functions the agent may call. MUST be non-empty: an empty rule
   * list is rejected here because the underlying SDK treats "no rules" as
   * "every target allowed", which is the opposite of a safe default.
   */
  readonly allowedCalls: readonly CallRule[];
  /** Per-token, per-period spending caps. MUST be non-empty. */
  readonly spendCaps: readonly SpendCap[];
  /** Unix epoch SECONDS at which the session stops being valid on-chain. */
  readonly expiresAt: number;
  /**
   * Opt in to rules that carry a `selector` but no `to`.
   *
   * Such a rule permits that function on EVERY contract on the chain.
   * Validation rejects it unless this flag is explicitly `true`, so the
   * over-grant has to be a decision rather than an omission.
   *
   * The flag CANNOT excuse a value-moving function. `transfer`, `transferFrom`,
   * `approve` and `increaseAllowance` with no `to` are rejected regardless
   * (PHASE2.3 R2): no spend cap can bound a token that cannot be enumerated,
   * and that combination is FINDINGS (h) — a session that can buy and can never
   * sell. Non-value-moving bare selectors (`harvest()`, `compound()`) are what
   * this flag is for.
   */
  readonly allowUnrestrictedSelector?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Handles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An opaque handle to the authority that controls a wallet.
 *
 * The execution plane never serializes this. For the Altana adapter it wraps a
 * secp256k1 or passkey signer; the private material stays inside the adapter.
 */
export type KeyAuthority = {
  /** Address that holds the key. */
  readonly address: Address;
  /** Opaque provider-specific handle. Never logged, never persisted. */
  readonly handle: unknown;
};

/** The admin authority over a wallet. Held by the user, never by the server. */
export type OwnerAuthority = KeyAuthority;

/**
 * An agent's session key. Structurally identical to an owner authority — the
 * difference is entirely in what the chain lets it do.
 */
export type AgentAuthority = KeyAuthority;

/**
 * How the authority over a wallet is held.
 *
 *   - `self-eoa`    the wallet address IS the owner's own EOA, upgraded in place
 *                   under EIP-7702. What Altana returns. The owner's key alone
 *                   is enough for recovery.
 *   - `passkey`     admin authority is a device-bound P256 passkey; there is no
 *                   raw key, so the relay-independent recovery path is
 *                   unavailable (FINDINGS.md (b)).
 *   - `hd-derived`  the wallet is derived from a service-held seed. Reserved for
 *                   the hard-isolation option (FINDINGS.md (g)); not used yet.
 */
export type CustodyModel = "self-eoa" | "passkey" | "hd-derived";

/** A wallet the execution plane can act on. */
export type AgentWalletRef = {
  readonly address: Address;
  readonly chainId: number;
  /**
   * Address holding admin authority over this wallet — for `self-eoa` custody.
   * An off-chain IDENTITY, and nothing more, for `passkey` custody.
   *
   * VERIFIED for `custodyModel === "self-eoa"`: on Altana this always equals
   * `address` for private-key owners — the wallet IS the owner's
   * EIP-7702-delegated EOA. See FINDINGS.md (a). That equality holds for
   * `self-eoa` ONLY.
   *
   * WHEN `custodyModel === "passkey"` (PHASE1.5), this field is an off-chain
   * IDENTITY derived from a P256 credential public key
   * (`passkeyOwnerAddress`, `src/auth/webauthnEnvelope.ts`). It holds NO
   * on-chain authority — the passkey does, as a P256 key in the KeyStore — it is
   * NOT equal to `address` (FINDINGS (a): the passkey wallet's address belongs to
   * a discarded throwaway EOA), and NO secp256k1 key exists for it. Any code
   * that treats it as a payable destination, a transaction sender, or an
   * on-chain admin address is WRONG, and FUNDS SENT TO IT ARE BURNED.
   *
   * Consequences already enforced, so this comment is a description and not a
   * hope: `ownerRecoverNative` refuses passkey custody outright, and
   * `ownerRecoverTokens` — when it is implemented — MUST take an explicit
   * owner-signed destination and MUST NOT default to this address.
   */
  readonly ownerAddress: Address;
  /**
   * The custody topology this wallet was provisioned under. Persisted so a
   * later phase can refuse recovery paths a given model cannot satisfy without
   * re-deriving it from provider internals.
   */
  readonly custodyModel: CustodyModel;
};

/**
 * A granted session. Persist this whole object.
 *
 * `permissions` and `expiresAt` are reproduced exactly at execution time. NOT
 * because the on-chain key hash depends on them — it does not; porto's
 * `Key.hash` is `keccak256(keyType, keccak256(publicKey))` and excludes
 * permissions — but because the SDK forwards them to the relay as the key
 * descriptor, and whether the relay enforces that descriptor is unsettled
 * (FINDINGS (x)). Reproducing them is the position that is safe either way.
 */
export type SessionRef = {
  readonly walletAddress: Address;
  readonly chainId: number;
  /** SEC1-encoded session public key. The identifier used to revoke. */
  readonly publicKey: Hex;
  /** The policy this session was granted under. */
  readonly spec: SessionSpec;
  /** Opaque provider handle carrying the session signer. Never persisted raw. */
  readonly handle: unknown;
};

/** A call the execution plane asks a wallet to make. */
export type WalletCall = {
  readonly to: Address;
  readonly value?: bigint;
  readonly data?: Hex;
};

/** Outcome of a state-changing operation. */
export type ExecutionReceipt = {
  readonly status: "CONFIRMED" | "FAILED" | "PENDING";
  /** Present once the operation lands on-chain. Safe to log. */
  readonly transactionHash?: Hex;
  /** Provider-side batch identifier, for polling a PENDING result. */
  readonly callsId?: Hex;
  /**
   * Set ONLY when `status` is `FAILED`. Classifies WHY the call failed, using
   * the same matchers as the throw path.
   *
   * This exists because the SDK's session-execute path reports a policy
   * rejection as `status: "FAILED"` WITHOUT throwing (FINDINGS.md (f)), so such
   * a failure never passes through `mapProviderError`. Without this field a
   * caller cannot tell an `ExceededSpendLimit` from a relay outage, and would
   * treat both the same.
   */
  readonly failureCode?: ExecutionErrorCode;
};

/* -------------------------------------------------------------------------- */
/* The provider interface                                                     */
/* -------------------------------------------------------------------------- */

/** Options every network-touching method accepts. */
export type RequestOptions = {
  /**
   * Cooperative cancellation.
   *
   * NOTE: @altananetwork/sdk 0.7.0 exposes no cancellation hook, so the adapter
   * can only check the signal at await boundaries; an in-flight HTTP request is
   * not torn down. Documented in FINDINGS.md (f).
   */
  readonly signal?: AbortSignal;
};

export type ResolveOwnerWalletParams = RequestOptions & {
  /** The authority that will own the wallet. */
  readonly owner: OwnerAuthority;
};

export type GrantSessionParams = RequestOptions & {
  readonly wallet: AgentWalletRef;
  /** Owner authority. Signs the grant. */
  readonly owner: OwnerAuthority;
  readonly spec: SessionSpec;
  /**
   * The agent key to delegate to. REQUIRED.
   *
   * A provider-generated key would exist only in the returned object, so a
   * process restart would lose it and the on-chain session would become
   * unusable (though still revocable by the owner). A durable service must own
   * the key it grants, so the caller always supplies it and persists it.
   */
  readonly agent: AgentAuthority;
};

/**
 * The persisted facts needed to rebuild a live session after a restart, with
 * NO gas and NO network.
 *
 * `spec` yields the byte-exact canonical permissions; `publicKey` and
 * `expiresAt` are the on-chain identity the grant established; `agent` carries
 * the session signer. Rebuilding from these — rather than re-granting — is what
 * makes the service durable across restarts without paying to re-delegate.
 */
export type RestoreSessionParams = {
  readonly spec: SessionSpec;
  /** The agent authority holding the session signer. */
  readonly agent: AgentAuthority;
  readonly walletAddress: Address;
  /** SEC1-encoded session public key, as persisted from the original grant. */
  readonly publicKey: Hex;
  /** Unix epoch seconds the session expires, as persisted from the grant. */
  readonly expiresAt: number;
};

export type AwaitExecutionParams = RequestOptions & {
  /** The provider-side batch identifier returned by a prior execute. */
  readonly callsId: Hex;
};

/**
 * One BOUNDED look at the relay's answer for a `callsId` (PHASE3.14 F2).
 *
 * `awaitExecution` POLLS to its own deadline (120 s by default) and returns
 * PENDING at the end of it, which is right for `reconcile` — a background pass
 * with nobody waiting — and wrong for an owner-signed HTTP action, which would
 * hang for two minutes on a relay that is answering perfectly well with a
 * status this build does not map.
 *
 * `rawStatus` is carried alongside the mapped receipt rather than folded into
 * it because the mapping is LOSSY on purpose: an unmapped status becomes
 * PENDING (`toCallsStatusReceipt`, and PHASE3.14 R-C is blocked on Altana
 * documenting what 300 means), so the operator's evidence must still be able to
 * say WHICH unmapped status the relay gave.
 */
export type ExecutionStatusReading = {
  readonly receipt: ExecutionReceipt;
  /** The relay's own `status` field, stringified. Evidence, never a decision. */
  readonly rawStatus: string;
};

export type IsSessionActiveParams = RequestOptions & {
  readonly wallet: AgentWalletRef;
  /** SEC1-encoded session public key to check. */
  readonly publicKey: Hex;
  /**
   * When supplied, `isSessionActive` also enforces `now < expiresAt` off-chain,
   * so the answer means "registered AND not expired". Omit to check on-chain
   * registration ONLY — see the method's contract for why that is weaker.
   */
  readonly expiresAt?: number;
};

export type ExecuteViaSessionParams = RequestOptions & {
  readonly session: SessionRef;
  readonly calls: readonly WalletCall[];
  /**
   * Skip the adapter's local expiry/allowlist pre-flight and submit anyway.
   *
   * Exists for ONE purpose: proving that the chain — not our own client-side
   * copy of the policy — is what rejects an out-of-scope call. The Phase 0
   * spike sets it for exactly that. Product code must not: a local rejection
   * is free, and an on-chain one costs a relay round trip.
   */
  readonly bypassLocalPolicyCheck?: boolean;
};

/**
 * Everything {@link WalletProvider.preflightExecute} needs. Deliberately the
 * same shape as an execute minus `bypassLocalPolicyCheck`: the pre-flight has no
 * bypass, because a caller that wanted one would simply not call it.
 */
export type PreflightExecuteParams = RequestOptions & {
  readonly session: SessionRef;
  readonly calls: readonly WalletCall[];
};

/**
 * Everything {@link WalletProvider.nativeDayMeter} needs — and NOT a
 * {@link SessionRef}, deliberately.
 *
 * The read is `spendInfos(keyHash)` on the account: it identifies the meter by
 * the session's PUBLIC key and signs nothing. Taking a `SessionRef` would have
 * forced every caller through `restoreSession`, which needs the session PRIVATE
 * key — and PHASE2.5 F4 puts this read on an owner-signed READ route, where
 * decrypting a signing key would break the invariant stated at the top of
 * `src/server.ts`: no route calls `getAgentSessionKey` except the execute path.
 *
 * A read that needs no key must not ask for one.
 */
export type NativeDayMeterParams = RequestOptions & {
  /** The EIP-7702 account whose meter is read — the owner's own EOA. */
  readonly walletAddress: Address;
  /** SEC1-encoded session public key. The account hashes this to find the row. */
  readonly publicKey: Hex;
};

/**
 * The account's own answer about today's native budget for one session key.
 *
 * Both numbers come from the SAME read, so they cannot disagree with each
 * other — which matters, because the whole defect PHASE2.5 exists to fix is the
 * off-chain sum and the on-chain meter disagreeing.
 */
export type NativeDayMeter = {
  readonly kind: "day";
  readonly limitWei: bigint;
  /** The CURRENT period's usage — `currentSpent`, never `spent`. */
  readonly currentSpentWei: bigint;
  /**
   * DISTINCT tokens (excluding native) for which this key has a POSITIVE spend
   * limit — the count the exit reserve is sized on, read from the same call
   * rather than from the grant the plane remembers.
   *
   * PHASE2.5-AUDIT A7: distinct TOKENS, not `spendInfos` rows. One token granted
   * at two periods is one exit to pay for, not two.
   */
  readonly grantedTokenCount: number;
};

/**
 * What the account answers when there is no DAY row for this key, split by the
 * two very different accounts that produce it (PHASE2.5-AUDIT A6).
 *
 * They were one `null` and F4 reported the reassuring reading for both.
 *
 *   - `other-period` — a native limit exists at another period (provisioning
 *     writes a minute row too). Today is genuinely unmetered: there is no
 *     native headroom to run out of, so nothing is gated on it.
 *   - `no-native-grant` — this key has NO native spend row at any period. Per
 *     FINDINGS (h) that is not "unlimited": `GuardedExecutor` finds no limit for
 *     the native the buy spends and the batch reverts in the relay's
 *     simulation — `PENDING`, no transaction, no gas, which reads like a slow
 *     relay rather than a refusal. The remedy is a GRANT, not a cap raise.
 */
export type NativeDayMeterAbsent = {
  readonly kind: "other-period" | "no-native-grant";
  readonly grantedTokenCount: number;
};

/** Every answer {@link WalletProvider.nativeDayMeter} can give. */
export type NativeDayMeterReading = NativeDayMeter | NativeDayMeterAbsent;

/** A session, or just the public key that identifies it on-chain. */
export type SessionIdentifier = SessionRef | Hex;

export type RevokeSessionParams = RequestOptions & {
  readonly wallet: AgentWalletRef;
  readonly owner: OwnerAuthority;
  /** The session, or just its public key. */
  readonly session: SessionIdentifier;
};

export type OwnerRevokeSessionParams = RequestOptions & {
  readonly wallet: AgentWalletRef;
  readonly owner: OwnerAuthority;
  /** EOA address of the session key — what the account hashes for revocation. */
  readonly sessionAddress: Address;
  /** SEC1-encoded session public key — what the KeyStore indexes by. */
  readonly sessionPublicKey: Hex;
};

/**
 * Outcome of the relay-independent revoke.
 *
 * `revoked` is read back from chain state, never inferred from receipt status:
 * a CONFIRMED transaction that stripped the wrong key hash looks identical to a
 * successful revocation from the outside. Callers MUST branch on `revoked`.
 */
export type OwnerRevokeSessionResult = {
  readonly revoked: boolean;
  /** Every receipt the revoke produced: account-level then keystore-level. */
  readonly receipts: readonly ExecutionReceipt[];
};

export type GetBalanceParams = RequestOptions & {
  readonly address: Address;
};

export type GetTokenBalanceParams = RequestOptions & {
  readonly wallet: AgentWalletRef;
  /** ERC-20 contract to read `balanceOf` on. */
  readonly token: Address;
};

export type GetTokenMetadataParams = RequestOptions & {
  readonly token: Address;
};

export type TokenMetadata = {
  readonly decimals: number;
  readonly symbol: string | null;
};

export type OwnerRecoverParams = RequestOptions & {
  readonly wallet: AgentWalletRef;
  readonly owner: OwnerAuthority;
  /** Where the swept funds go. */
  readonly to: Address;
};

export type ReadFourMemeQuoteParams = RequestOptions & {
  /** The Four.Meme token being traded. */
  readonly token: Address;
  readonly side: "buy" | "sell";
  /** Buy: native funds in. Sell: token amount in. */
  readonly amountWei: bigint;
};

export type CanSessionSellTokenParams = RequestOptions & {
  readonly wallet: AgentWalletRef;
  /**
   * SEC1 session public key, as persisted at grant time. The account indexes
   * both grants by a hash of the key's ADDRESS, which is derived from this.
   */
  readonly sessionPublicKey: Hex;
  /** The ERC-20 the caller is about to open a position in. */
  readonly token: Address;
};

/**
 * What Four.Meme's own on-chain helper says about a token and a proposed trade.
 *
 * Two reads back this (PHASE2.1 R3), and which field comes from which is part
 * of the contract, not an implementation detail:
 *
 *   - `version`, `tokenManager`, `quoteToken`, `liquidityAdded` are
 *     authoritative from `getTokenInfo`;
 *   - the money fields come from `tryBuy` / `trySell`.
 *
 * A helper that disagrees with itself about the manager or the quote currency
 * between the two reads fails the whole method closed.
 *
 * TREAT EVERY FIELD AS UNTRUSTED INPUT. Chain-id pinning authenticates the
 * ENDPOINT at connect time; it says nothing about an individual `eth_call`
 * result, and these values decide how much native leaves a wallet. The route
 * bounds them against what the caller itself declared.
 */
export type FourMemeQuote = {
  /** `Number(getTokenInfo.version)`. Only 2 is supported. */
  readonly version: number;
  /** The manager THIS token trades through — never a configured default. */
  readonly tokenManager: Address;
  /** `getTokenInfo.quote`; `null` when the token is bought with native BNB. */
  readonly quoteToken: Address | null;
  /** `true` once the curve has closed and the token moved to PancakeSwap V2. */
  readonly liquidityAdded: boolean;
  /** `tryBuy.amountMsgValue` — the EXACT native value the buy must send. */
  readonly msgValueWei?: bigint;
  /** `tryBuy.amountFunds` — what enters the curve. */
  readonly fundsWei?: bigint;
  /** `tryBuy.estimatedAmount`. Observability only; never gated on (R10). */
  readonly estimatedOutWei?: bigint;
  /** `tryBuy.amountApproval` — quote-token approval size, when non-native. */
  readonly approvalWei?: bigint;
  /** `trySell.funds` — estimated native out. Observability only. */
  readonly estimatedFundsOutWei?: bigint;
};

export type ReadFlapTokenStateParams = RequestOptions & {
  /** The flap token being traded. */
  readonly token: Address;
};

/**
 * What flap.sh's Portal says about one token, `getTokenV5` reduced to the
 * fields this plane acts on.
 *
 * UNLIKE {@link FourMemeQuote}, a successful return here IS evidence that the
 * address is a flap token: the read REVERTS on a non-flap address rather than
 * answering all zeros, so it is fail-closed on its own and needs no bounding of
 * zeros. That difference is measured, not assumed — see `src/ops/abis.ts`.
 *
 * No money field is carried, deliberately. `quoteExactInput` is `nonpayable`
 * and quoting is the CALLER's job on every venue (PHASE2): the caller supplies
 * `quotedOutWei` and `minOutWei` and this service validates the floor against
 * them. These fields answer one question only — may this trade be built at all.
 */
export type FlapTokenState = {
  /** `TokenStatus`: 0 Invalid, 1 Tradable, 2 InDuel, 3 Killed, 4 DEX, 5 Staged. */
  readonly status: number;
  /** Quote currency; `null` when the curve is quoted in native BNB. */
  readonly quoteToken: Address | null;
  /** `true` when the Portal would route a native buy through an internal swap. */
  readonly nativeToQuoteSwapEnabled: boolean;
  /** `bytes32(0)` when the token uses no extension hooks. */
  readonly extensionId: Hex;
  /** Circulating supply at which the token migrates to a DEX. */
  readonly dexSupplyThresh: bigint;
  readonly circulatingSupply: bigint;
};

export type OwnerRecoverTokensParams = OwnerRecoverParams & {
  /** ERC-20 tokens to sweep, in order. */
  readonly tokens: readonly Address[];
};

/**
 * The seam. One implementation per custody provider.
 *
 * Implementations MUST be thin: no policy decisions, no retries with side
 * effects, no business logic. Policy lives in the execution plane above.
 */
export interface WalletProvider {
  /**
   * Resolve the wallet controlled by `owner`.
   *
   * On Altana this is counterfactual — no on-chain transaction and no gas. The
   * delegation lands as a pre-call on the wallet's first execute.
   */
  resolveOwnerWallet(params: ResolveOwnerWalletParams): Promise<AgentWalletRef>;

  /**
   * Delegate scoped authority to the supplied agent key.
   *
   * Costs gas, paid by the wallet. Returns the session the agent runtime uses.
   */
  grantSession(params: GrantSessionParams): Promise<SessionRef>;

  /**
   * Rebuild a live session from persisted facts, SYNCHRONOUSLY, with no gas and
   * no network.
   *
   * This is what makes the service durable across restarts: the on-chain grant
   * still stands, so the session only has to be reconstructed in memory — the
   * canonical permissions from `spec`, the session signer from `agent`, and the
   * persisted `publicKey`/`expiresAt`. Re-granting would pay gas to re-delegate
   * authority the wallet already has.
   */
  restoreSession(params: RestoreSessionParams): SessionRef;

  /**
   * Answer "would this batch be refused before submission?" — and submit
   * NOTHING (PHASE2.4 R3).
   *
   * Throws a typed {@link ExecutionPlaneError} on a refusal and resolves on a
   * pass. It exists so a caller can classify a failure POSITIONALLY rather than
   * by error type: everything this method throws provably never reached a relay,
   * so the caller may roll its journal row back and release the budget, while
   * everything the submit throws is ambiguous and must be held as UNKNOWN.
   *
   * A type-based rule cannot carry that property. `mapProviderError` relays any
   * `ExecutionPlaneError` unchanged, and the abort helper throws the same error
   * before AND after the submit — so a "roll back on this type" rule would one
   * day release budget for a trade the relay had already accepted, which is a
   * double spend.
   *
   * IDEMPOTENT and side-effect free, so `executeViaSession` may repeat the whole
   * check as defence in depth without the caller paying twice for the common
   * case: the checks are local, and only a batch the local snapshot REFUSES
   * costs a chain read.
   */
  preflightExecute(params: PreflightExecuteParams): Promise<void>;

  /**
   * Phase 3.9c C1 staged LP-only submit. Optional at the provider abstraction
   * because non-Porto providers can still serve non-LP routes; LP boot and the
   * saga fail closed when it is absent. The callback durably binds the prepared
   * identity before this method is permitted to sign or send.
   */
  submitPreparedLp?(params: PortoStagedLpSubmit): Promise<ExecutionReceipt>;

  /**
   * The session's DAILY NATIVE meter as the ACCOUNT currently reports it
   * (PHASE2.5 F1) — or, when there is no DAY row, WHICH of the two very
   * different accounts that is ({@link NativeDayMeterAbsent}).
   *
   * ONE chain read, and PHASE2.5-REVIEW M1 is why that sentence is here rather
   * than a claim that some existing read covers it: `preflightExecute` consults
   * the chain ONLY when the granted snapshot refuses a call
   * (`if (refused.length === 0) return;`), so the ordinary path makes no chain
   * read at all. This adds one, deliberately, and only on the
   * exposure-increasing side — the exit keeps its zero-read property, because
   * the exit must never acquire a new way to fail.
   *
   * `currentSpent`, NOT `spent`: the tuple carries both and they are different
   * questions. Every meter reader in this repo — `live-lp`,
   * `owner-add-spend-limit`, and the mainnet observation recorded in
   * `src/ops/policy.ts` — uses `currentSpent`, which is the CURRENT PERIOD's
   * usage and therefore the one that answers "how much of today is left".
   *
   * THROWS on a failed read, classified through `mapProviderError` like every
   * other chain read here, and under `PREFLIGHT_CHAIN_TIMEOUT_MS` — a slow node
   * must not hold a trade request or an owner's dashboard open (PHASE2.5-AUDIT
   * A3/A4).
   *
   * OPTIONAL on the interface, and the distinction is deliberate. A provider
   * that does not implement this at all is a CAPABILITY fact, knowable at boot
   * — and `createServer` ASSERTS it there when a trade runtime is configured
   * (`assertTradeProviderCapabilities`), because a silently missing method
   * disables F1 for every agent with no log and no refusal. PHASE2.5-AUDIT A5
   * was this clause describing an assertion that did not exist; it exists now.
   * A provider that implements it and whose READ FAILS is an outage, and that is
   * fail-closed per request on the exposure-increasing side. Conflating the two
   * would either churn every test double or let an outage pass as "not
   * applicable".
   */
  nativeDayMeter?(params: NativeDayMeterParams): Promise<NativeDayMeterReading>;

  /**
   * Run calls under a session. The owner authority is NOT involved.
   *
   * Calls outside the session's allowlist or over its caps are rejected by the
   * account contract at validation time — surfaced as `status: "FAILED"` with a
   * `failureCode`, NOT as a throw.
   */
  executeViaSession(params: ExecuteViaSessionParams): Promise<ExecutionReceipt>;

  /**
   * Resolve the outcome of a previously submitted execute by its `callsId`.
   *
   * Poll-only: it NEVER submits anything. A crash mid-execute is resolved by
   * calling this rather than re-submitting and risking a double spend.
   */
  awaitExecution(params: AwaitExecutionParams): Promise<ExecutionReceipt>;

  /**
   * ONE relay status read for a `callsId`, with no polling loop (PHASE3.14 F2).
   *
   * OPTIONAL, and the optionality is the contract: the one caller — the
   * owner-signed `resolveUnknown` verifier — treats an absent method exactly as
   * it treats a thrown transport error or an unmapped status, by recording that
   * it could not learn anything and falling through to the audited
   * direct-evidence path. Relay unavailability MUST NEVER produce a refusal
   * there; refusing on it would reinstate the very deadlock PHASE3.14 closes,
   * one layer up.
   *
   * Poll-free and submit-free: like {@link awaitExecution} it only reads.
   */
  readExecutionStatus?(params: AwaitExecutionParams): Promise<ExecutionStatusReading>;

  /**
   * Whether a session key is still usable.
   *
   * On-chain registration in the KeyStore is necessary but NOT sufficient: a
   * registered key can still be past its expiry, which the account enforces
   * separately. When `expiresAt` is supplied this method returns
   * `registered AND now < expiresAt`; when it is omitted it returns registration
   * only, and the caller must treat that as the weaker claim it is.
   */
  isSessionActive(params: IsSessionActiveParams): Promise<boolean>;

  /**
   * Kill a session via the provider relay. Owner authority only — the agent key
   * is not needed and cannot block it. Revocation is monotonic.
   *
   * This is the fast path. It depends on the relay being up; when durability of
   * the kill switch matters more than speed, use `ownerRevokeSession`, which
   * needs nothing but the owner key and a public RPC.
   */
  revokeSession(params: RevokeSessionParams): Promise<ExecutionReceipt>;

  /**
   * Kill a session using the owner key and a public RPC ONLY — no provider
   * relay, no 4lpha server, no agent key.
   *
   * The primary, infrastructure-independent kill switch. `revoked` is read back
   * from chain state; see {@link OwnerRevokeSessionResult}.
   */
  ownerRevokeSession(
    params: OwnerRevokeSessionParams,
  ): Promise<OwnerRevokeSessionResult>;

  /** Native-token balance in wei. */
  getBalance(params: GetBalanceParams): Promise<bigint>;

  /** ERC-20 `balanceOf` for the wallet, in the token's smallest unit. */
  getTokenBalance(params: GetTokenBalanceParams): Promise<bigint>;

  /** Optional read-only ERC-20 identity seam used by account valuation. */
  getTokenMetadata?(params: GetTokenMetadataParams): Promise<TokenMetadata>;

  /**
   * Read Four.Meme's `TokenManagerHelper3` for a token and a proposed trade.
   *
   * CHAIN STATE, not market data. This is a `view` call on a BNB-Chain contract
   * made through the same chain-id-pinned client as {@link getTokenBalance},
   * and it belongs on the provider for the same reason that one does: the
   * provider is the only component that holds an RPC client, verifies the
   * endpoint's chain id before trusting it, and rotates dead endpoints. The
   * data plane remains the ONLY source of third-party market judgement.
   *
   * THROWS a typed {@link ExecutionPlaneError} on any RPC failure, on a helper
   * that contradicts itself between its two reads, or on a provider with no
   * pinned helper address — so a caller's existing try/catch fails closed. It
   * returns a value only when the read succeeded against a verified chain id.
   *
   * A successful return is NOT evidence that the token is tradeable: the helper
   * answers a non-token with all zeros and does not revert. Callers MUST bound
   * every returned amount against their own request.
   */
  readFourMemeQuote(params: ReadFourMemeQuoteParams): Promise<FourMemeQuote>;

  /**
   * Read flap.sh's Portal for one token (PHASE2.4).
   *
   * Chain state over the same pinned, chain-id-verified client as
   * {@link readFourMemeQuote}, and on the provider for the same reason: the
   * provider is the only component that holds an RPC client and validates the
   * endpoint before trusting it.
   *
   * THROWS a typed {@link ExecutionPlaneError} on any RPC failure, on a
   * non-flap address (the Portal reverts), or on a provider with no pinned
   * Portal — so a caller's existing try/catch fails closed. Unlike the
   * Four.Meme read there is no zero-answer hazard to bound: this read cannot
   * succeed for an address that is not a flap token.
   */
  readFlapTokenState(params: ReadFlapTokenStateParams): Promise<FlapTokenState>;

  /**
   * The ERC-20s this session may currently move, read from the account.
   *
   * The granted `SessionSpec` records the caps that existed AT GRANT TIME and
   * is not rewritten — not because `restoreSession` needs it byte-exact (that
   * claim was FALSE; porto's `Key.hash` excludes permissions entirely) but
   * because the SDK forwards it to the RELAY as the key descriptor, and whether
   * the relay enforces that descriptor is an open assumption. FINDINGS (x). The
   * owner may add a cap to a live session anyway (`setSpendLimit`, FINDINGS (i)),
   * which is the documented way to authorise a token that did not exist at hire.
   * The two therefore diverge by design, and a decision that asks "may this
   * session sell that token" must read the chain rather than the snapshot: on a
   * live mainnet wallet the snapshot listed one cap while the account enforced
   * seven.
   *
   * Returns lowercased token addresses with a non-zero limit. The native entry
   * is excluded — it is not a token and callers ask about ERC-20s.
   */
  canSessionSellToken(params: CanSessionSellTokenParams): Promise<boolean>;

  /**
   * Sweep every remaining native token from the wallet back to `to`, using the
   * owner authority ALONE.
   *
   * This is the self-custody escape hatch. Implementations MUST NOT depend on
   * any 4lpha server, any agent key, or any provider-operated relay: if our
   * infrastructure disappears, this must still work from the owner's key and a
   * public RPC endpoint.
   */
  ownerRecoverNative(params: OwnerRecoverParams): Promise<ExecutionReceipt>;

  /**
   * Sweep ERC-20 balances back to `to`, using the owner authority alone.
   *
   * Same self-custody contract as {@link ownerRecoverNative}. Returns one
   * receipt per token swept. Phase 2 fills this in; a provider MAY throw a
   * clearly-typed not-implemented error until token positions exist.
   *
   * DESTINATION INVARIANT, when it IS implemented (PHASE1.5 D1): `to` is an
   * explicit, owner-signed parameter and MUST NOT default to
   * `wallet.ownerAddress`. Under passkey custody that field is a derived
   * identity with no secp256k1 key behind it, so a sweep aimed at it burns
   * everything it moves. The same applies to `ownerRecoverNative`, which refuses
   * passkey custody rather than guessing.
   */
  ownerRecoverTokens(
    params: OwnerRecoverTokensParams,
  ): Promise<readonly ExecutionReceipt[]>;
}

/**
 * A provider per chain. The seam for a multi-chain execution plane: Phase 1 has
 * a single BNB entry, but callers resolve by chainId so nothing has to change
 * when a second chain is added.
 */
export interface ProviderRegistry {
  /** The provider for `chainId`, or throws if none is configured. */
  get(chainId: number): WalletProvider;
}

/* -------------------------------------------------------------------------- */
/* Typed errors                                                               */
/* -------------------------------------------------------------------------- */

/** Stable machine-readable error codes. */
export type ExecutionErrorCode =
  | "SESSION_EXPIRED"
  | "CAP_EXCEEDED"
  | "NOT_ALLOWED"
  | "INVALID_SESSION_SPEC"
  | "INFRASTRUCTURE_ERROR"
  | "NOT_IMPLEMENTED"
  | "PROVIDER_ERROR";

/**
 * Base class for every error the execution plane raises.
 *
 * `message` is always sanitized and safe to surface to a client or a log sink:
 * adapters route upstream failures through `mapProviderError` before throwing.
 */
export class ExecutionPlaneError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The session's expiry has passed, or the chain rejected it as expired. */
export class SessionExpiredError extends ExecutionPlaneError {
  constructor(message = "Session has expired.") {
    super("SESSION_EXPIRED", message);
  }
}

/** The call would exceed a granted spending cap. */
export class CapExceededError extends ExecutionPlaneError {
  constructor(message = "Call exceeds the session spending cap.") {
    super("CAP_EXCEEDED", message);
  }
}

/** The call target or function is outside the session allowlist. */
export class NotAllowedError extends ExecutionPlaneError {
  constructor(message = "Call is not permitted by the session policy.") {
    super("NOT_ALLOWED", message);
  }
}

/**
 * The relay, the RPC endpoint, or something else in the transport path failed.
 *
 * Kept strictly separate from the policy codes above: an HTTP 429 from the
 * relay and an on-chain `ExceededSpendLimit()` are both "the call did not
 * happen", but only one of them means the user's policy said no. Retrying is
 * reasonable here and meaningless for a policy rejection.
 */
export class InfrastructureError extends ExecutionPlaneError {
  constructor(message = "Wallet provider infrastructure is unavailable.") {
    super("INFRASTRUCTURE_ERROR", message);
  }
}

/** The requested policy is malformed and was rejected before any network call. */
export class InvalidSessionSpecError extends ExecutionPlaneError {
  constructor(message: string) {
    super("INVALID_SESSION_SPEC", message);
  }
}

/** A capability the interface declares but this provider does not yet support. */
export class NotImplementedError extends ExecutionPlaneError {
  constructor(message: string) {
    super("NOT_IMPLEMENTED", message);
  }
}

/** Anything else that went wrong upstream. Message is sanitized. */
export class ProviderError extends ExecutionPlaneError {
  constructor(message = "Wallet provider request failed.") {
    super("PROVIDER_ERROR", message);
  }
}
