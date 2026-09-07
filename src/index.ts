/**
 * Public surface of the 4lpha execution plane.
 *
 * Phase 0 ships the wallet/session layer only. Trading, LP, and Venus
 * operations arrive in later phases behind the same `WalletProvider` seam.
 */
export type {
  AgentAuthority,
  AgentWalletRef,
  AwaitExecutionParams,
  CallRule,
  CustodyModel,
  KeyAuthority,
  ExecuteViaSessionParams,
  ExecutionErrorCode,
  ExecutionReceipt,
  GetBalanceParams,
  GetTokenBalanceParams,
  GrantSessionParams,
  IsSessionActiveParams,
  OwnerAuthority,
  OwnerRecoverParams,
  OwnerRecoverTokensParams,
  OwnerRevokeSessionParams,
  OwnerRevokeSessionResult,
  ProviderRegistry,
  RequestOptions,
  ResolveOwnerWalletParams,
  RestoreSessionParams,
  RevokeSessionParams,
  SessionIdentifier,
  SessionRef,
  SessionSpec,
  SpendCap,
  SpendPeriod,
  WalletCall,
  WalletProvider,
} from "./core/types.js";

export {
  CapExceededError,
  ExecutionPlaneError,
  InfrastructureError,
  InvalidSessionSpecError,
  NotAllowedError,
  NotImplementedError,
  ProviderError,
  SessionExpiredError,
} from "./core/types.js";

export {
  REVERT_SELECTORS,
  classifyFailureCode,
  errorStrings,
  mapProviderError,
  mentionsRevertSelector,
  sanitizeMessage,
} from "./core/errors.js";

export {
  DEFAULT_MAX_SESSION_SECONDS,
  MIN_SESSION_SECONDS,
  isSessionExpired,
  validateSessionSpec,
} from "./core/session.js";
export type {
  ProviderCallPermission,
  ProviderPermissions,
  ProviderSpendPermission,
  ValidateOptions,
} from "./core/session.js";

export {
  AltanaProvider,
  MAX_CALLS_PER_EXECUTE,
  accountKeyHashForAddress,
  agentAuthorityFromPrivateKey,
  authorityFromPrivateKey,
  ownerAuthorityFromPrivateKey,
} from "./wallet/altana.js";
export type {
  AltanaOwnerHandle,
  AltanaProviderOptions,
  AltanaSessionHandle,
  OwnerRevokeSessionDirectResult,
} from "./wallet/altana.js";

export { createProviderRegistry } from "./wallet/registry.js";
export type {
  ProviderRegistryEntry,
} from "./wallet/registry.js";

/* -------------------------------------------------------------------------- */
/* Storage substrate (Phase 1a)                                               */
/* -------------------------------------------------------------------------- */

export {
  MemoryAgentStore,
  PostgresAgentStore,
  createAgentStore,
} from "./store/agents.js";
export type {
  AgentCaps,
  AgentRecord,
  AgentStatus,
  AgentStore,
  CreateAgentInput,
  ExecutorHealth,
  SessionFacts,
} from "./store/agents.js";

export {
  LOCAL_ONLY_KINDS,
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  createJournal,
  reconcile,
} from "./store/journal.js";
export type {
  ExecutionJournal,
  JournalBeginInput,
  JournalEntry,
  JournalExternalRef,
  JournalKind,
  JournalState,
  ReconcileInput,
  ReconcileSummary,
} from "./store/journal.js";

export type { SqlClient } from "./store/sql.js";
export { createPgSqlClient } from "./store/sql.js";

/* -------------------------------------------------------------------------- */
/* Owner authorization, kill switch, execute decision (Phase 1b-core)         */
/* -------------------------------------------------------------------------- */

export { canonicalEncode, paramsHash } from "./auth/canonical.js";

export {
  MAX_RUNTIME_ASSERTION_HEADER_CHARS,
  MAX_RUNTIME_ASSERTION_SECONDS,
  RUNTIME_ASSERTION_SKEW_SECONDS,
  RUNTIME_ASSERTION_VERSION,
  RuntimeAuthError,
  assertRuntimeVerifierOnlyEnvironment,
  createRuntimeAssertionClaims,
  createRuntimeAssertionNonce,
  encodeRuntimeAssertion,
  httpRuntimeProfileAllows,
  httpRuntimeProfileHash,
  parseBindableHttpRuntimeProfile,
  parseHttpRuntimeProfile,
  resolveRuntimeAuthConfig,
  runtimeAssertionPrivateKeyFromBase64Url,
  runtimeAudience,
  runtimeRequestHash,
  verifyRuntimeAssertion,
} from "./auth/runtimeAuth.js";
export type {
  BindableHttpRuntimeProfile,
  EnabledRuntimeAuthConfig,
  HttpRuntimeOperation,
  HttpRuntimeProfile,
  RuntimeAssertionClaims,
  RuntimeAuthConfig,
  RuntimeAuthEnvironment,
} from "./auth/runtimeAuth.js";

export {
  MemoryRuntimeReplayStore,
  PostgresRuntimeReplayStore,
  createRuntimeReplayStore,
} from "./store/runtimeReplays.js";
export type { RuntimeReplay, RuntimeReplayStore } from "./store/runtimeReplays.js";

export {
  DEFAULT_SKEW_SECONDS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  GLOBAL_AGENT_SENTINEL,
  MAX_ACTION_WINDOW_SECONDS,
  OWNER_ACTION_TYPES,
  OwnerAuthError,
  READ_ACTION_NONCE_POLICY,
  authorizeOwnerAction,
  // THE domain constructor. A signing client MUST build its EIP-712 domain with
  // this, never by hand: the verifier uses the same function, so the two cannot
  // drift into producing signatures that recover to different addresses.
  buildOwnerActionDomain,
  isMutatingOwnerAction,
  resolveDomainSalt,
  secp256k1Verifier,
  verifyOwnerAction,
} from "./auth/ownerAuth.js";
export type {
  AuthorizeOwnerActionOptions,
  DomainSaltInput,
  OwnerActionRequest,
  OwnerActionStruct,
  OwnerActionType,
  OwnerAuthResult,
  RecoverInput,
  Verifier,
  VerifyOwnerActionOptions,
} from "./auth/ownerAuth.js";

/* Passkey (WebAuthn/P256) owner auth — Phase 1.5. The envelope module is the
 * ONE implementation both this server and the marketplace UI client use. */
export {
  MAX_AUTHENTICATOR_DATA_BYTES,
  MAX_CLIENT_DATA_BYTES,
  MIN_WEBAUTHN_ENVELOPE_BYTES,
  OWNER_ACTION_CHALLENGE_TAG,
  PASSKEY_OWNER_TAG,
  WEBAUTHN_ENVELOPE_PARAMS,
  WebAuthnEnvelopeError,
  assembleOwnerActionSignature,
  buildOwnerActionAssertionRequest,
  decodeBase64UrlStrict,
  decodeWebAuthnEnvelope,
  derToP1363,
  encodeBase64Url,
  encodeWebAuthnEnvelope,
  ownerActionChallenge,
  ownerActionChallengeBytes,
  passkeyOwnerAddress,
} from "./auth/webauthnEnvelope.js";
export type {
  PasskeyAssertionRequest,
  PasskeyCredentialRecord,
  WebAuthnEnvelope,
  WebAuthnEnvelopeInput,
} from "./auth/webauthnEnvelope.js";

export {
  PASSKEY_DISABLED,
  createDispatchingVerifier,
  createWebAuthnVerifier,
  verifyWebAuthnAssertion,
} from "./auth/passkeyVerifier.js";
export type {
  EnabledPasskeyConfig,
  PasskeyAssertionResult,
  PasskeyConfig,
} from "./auth/passkeyVerifier.js";

export {
  MemoryNonceStore,
  PostgresNonceStore,
  createNonceStore,
} from "./store/nonces.js";
export type { NonceStore } from "./store/nonces.js";

export {
  MemoryKillSwitch,
  PostgresKillSwitch,
  createKillSwitch,
} from "./killswitch/killswitch.js";
export type { KillSwitch } from "./killswitch/killswitch.js";

export {
  NONCE_IDEMPOTENCY_CONTRACT,
  authorizeExecute,
  executeIdempotencyKey,
  ownerActionIdempotencyKey,
} from "./auth/executeDecision.js";
export type {
  AuthorizeExecuteInput,
  ExecuteDecision,
  ExecuteDenyCode,
} from "./auth/executeDecision.js";

/* -------------------------------------------------------------------------- */
/* HTTP exposure layer (Phase 1b-api)                                         */
/* -------------------------------------------------------------------------- */

export {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_OWNER_RATE_LIMIT,
  DEFAULT_RATE_LIMIT,
  createServer,
} from "./server.js";
export type {
  ErrorCode,
  OnChainRevokeInstructions,
  RateLimitConfig,
  ServerConfig,
  ServerDeps,
} from "./server.js";

/* -------------------------------------------------------------------------- */
/* Paid services (Phase 5; disabled by default)                               */
/* -------------------------------------------------------------------------- */

export * from "./billing/types.js";
export * from "./billing/config.js";
export * from "./billing/canonical.js";
export * from "./billing/models.js";
export * from "./billing/math.js";
export * from "./billing/oracles.js";
export * from "./billing/sessionPolicy.js";
export * from "./billing/collectorCompiler.js";
export * from "./billing/evidence.js";
export * from "./billing/store.js";
export * from "./billing/postgres.js";
export * from "./billing/serviceSession.js";
export * from "./billing/x402Registry.js";
export * from "./billing/x402.js";
export {
  matchOgHistory,
  parseOgHistoryPage,
  reconcileOgUsage,
  reconcileOgUsageFromHistory,
  ogReconcileDelaySeconds,
  startOgChatAttempt,
} from "./billing/og.js";
export type {
  OgAttemptInput,
  OgHistoryPage,
  OgInferenceCredential,
  OgManagementCredential,
  OgStartedAttempt,
} from "./billing/og.js";
export * from "./billing/collection.js";
export * from "./billing/errors.js";
export * from "./billing/wire.js";
export * from "./billing/http.js";
export * from "./billing/listener.js";
export * from "./billing/runtime.js";
export * from "./billing/worker.js";

export {
  DEFAULT_EXECUTE_THROTTLE,
  ExecuteThrottle,
  TokenBucketLimiter,
} from "./http/limits.js";
export type {
  ExecuteThrottleOptions,
  ThrottleVerdict,
  TokenBucketOptions,
} from "./http/limits.js";

export {
  MAX_AGENT_ID_CHARS,
  MAX_DECISION_ID_CHARS,
  MAX_OWNER_ENVELOPE_CHARS,
  agentOwnerView,
  agentRuntimeView,
  decodeOwnerActionHeader,
  hashCalls,
  parseAdminRequest,
  parseBudgetParams,
  parseExecuteRequest,
  parseOwnerActionEnvelope,
} from "./http/wire.js";
export type {
  AdminRequest,
  ExecuteRequest,
  OwnerNativeMeterView,
  ParseResult,
} from "./http/wire.js";

export { DEFAULT_TIMEOUT_MS, HttpDataPlaneClient } from "./clients/dataPlane.js";
export type {
  DataPlaneClient,
  DataPlaneClientOptions,
  DataPlaneEnvelope,
  DataPlaneHealth,
  FetchLike,
} from "./clients/dataPlane.js";
