import { feeCoverage, sumFeeRows, type LpFeeEvent, type FeeCandidate } from "./store/lpFeeEvents.js";
import { createLendingPortfolioProjection, unavailableLendingPortfolio } from "./http/lendingPortfolio.js";
import { isFeeCollectionStep, sequenceAffectsPosition } from "./lp/feeRecorder.js";
/**
 * The HTTP exposure layer over the 1b-core authorization engine.
 *
 * This file adds NO new authority. Every decision it makes was already decided
 * and tested in `src/auth`, `src/killswitch` and `src/store`; what lives here is
 * the ORDER those decisions are asked in, and the discipline about what may
 * leave the process. Both of those are load-bearing enough to be worth stating
 * up front.
 *
 * ─── FOUR AUTH LAYERS, FOUR DIFFERENT QUESTIONS ────────────────────────────
 *
 *   1. `x-exec-token` — "is the caller one of our own services?" On EVERY route
 *      but `/health`. It authenticates a SERVICE (our agent runtime, our app
 *      backend). It is NOT tenant auth: holding it says nothing about which
 *      owner's agents you may touch.
 *   2. `x-runtime-assertion` — "which assigned agent/profile/request may this
 *      runtime perform?" On the autonomous runtime read, trade and enabled raw
 *      execute routes. Ed25519, short-lived, request-bound and replay-consumed.
 *   3. Owner EIP-712 — "which tenant is this, and did they really ask?" On every
 *      owner-authority action. The owner address comes from the RECOVERED signer
 *      and never from a body, query or path segment. A caller cannot name a
 *      tenant; it can only prove it is one.
 *   4. `x-operator-token` — "is this us, the operator?" On the GLOBAL halt and
 *      resume only. Those are cross-tenant by definition, and no single owner
 *      may be allowed to halt everybody, so they take a separate credential in a
 *      separate env var. Every use is audit-logged with an actor and a reason.
 *
 * ─── THE ONE ASYMMETRY WORTH UNDERSTANDING ─────────────────────────────────
 *
 * `POST /agents/:id/execute` takes NO owner signature. That is the whole point of
 * a scoped session: the owner authorized the agent once, on-chain, and the agent
 * then runs unattended. Requiring a signature per trade would defeat it. The
 * consequence is that the execute path has no signer to derive tenancy from — so
 * TENANCY COMES FROM THE PERSISTED ROW. The server loads the agent by id and
 * treats `row.ownerAddress` as authoritative for the session-key lookup, the
 * kill-switch scope and the journal. Nothing in the request can influence it.
 *
 * ─── WHAT A LEAKED `x-exec-token` CAN AND CANNOT DO ────────────────────────
 *
 * CAN: reach service-level and owner/operator routes, where the next authority
 * layer still decides. It cannot read a runtime agent view or enter trade/raw
 * with the bearer alone.
 * CANNOT: move funds outside an agent's on-chain policy (the account contract
 * refuses, and this server cannot bypass it — see `bypassLocalPolicyCheck`
 * below); pause, revoke, re-budget or read an owner's full view (all need the
 * owner's key); halt or resume globally (needs the operator credential); or
 * drain a full cap period in a burst (the throttle bounds the rate, and an
 * operator's halt or the owner's on-chain revoke stops it outright).
 *
 * ─── SECRETS ───────────────────────────────────────────────────────────────
 *
 * No route calls `getAgentSessionKey` except the execute path, which does so
 * inside {@link withSessionKey} and never returns, logs or journals the value.
 * Every error body is passed through `sanitizeMessage` as its final step, and
 * `journal.last_error` is sanitized on write.
 *
 * ─── NETWORK POSTURE ───────────────────────────────────────────────────────
 *
 * There is NO CORS handling here, deliberately. This service is PRIVATE-NETWORK
 * ONLY — the intended path is owner browser → the 4alpha app → this execution
 * plane. It must never be exposed to the internet, and a browser must never
 * reach it directly. Outbound, it speaks to exactly two things and no third:
 * the data plane (`src/clients/dataPlane.ts`) for third-party market judgement,
 * and — only through the wallet provider — a chain-id-pinned public RPC for
 * chain state. It contacts no market-data provider itself.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createDemoRoutes, type DemoServerDeps } from "./demo/routes.js";
import type { Context } from "hono";
import { encodeAbiParameters, encodeFunctionData, formatEther, getAddress, getCreate2Address, isAddress, keccak256, stringToBytes, zeroAddress } from "viem";
import { publicKeyToAddress } from "viem/utils";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  GLOBAL_AGENT_SENTINEL,
  OwnerAuthError,
  authorizeOwnerAction,
  classifyOwnerActionTime,
  verifyOwnerAction,
  type OwnerActionRequest,
  type OwnerActionType,
  type OwnerAuthResult,
  type Verifier,
} from "./auth/ownerAuth.js";
import {
  issueAccountReadSession,
  verifyAccountReadSession,
  type AccountReadSessionConfig,
} from "./auth/accountReadSession.js";
import { buildAccountPortfolio } from "./account/portfolio.js";
import {
  DeclaredWalletNotOwnedError,
  readFinalizedSessionRevocation,
  readSessionRegistration,
  verifyDeclaredWallet,
  type KeyStoreReader,
  type SessionRegistrationVerdict,
} from "./account/keyStoreReader.js";
import type { BalanceReader } from "./account/balanceReader.js";
import type { LpTickLiquidityReading } from "./lp/readers.js";
import { createGridBenchmarkCache, selectGridArmBenchmark, type GridArmBenchmarkInput, type GridArmBenchmark } from "./http/gridBenchmark.js";
import {
  PASSKEY_DISABLED,
  createDispatchingVerifier,
  type PasskeyConfig,
} from "./auth/passkeyVerifier.js";
import {
  httpRuntimeProfileAllows,
  httpRuntimeProfileHash,
  parseBindableHttpRuntimeProfile,
  runtimeRequestHash,
  verifyRuntimeAssertion,
  type RuntimeAuthConfig,
  type HttpRuntimeOperation,
  type BindableHttpRuntimeProfile,
} from "./auth/runtimeAuth.js";
import {
  authorizeExecute,
  executeIdempotencyKey,
  ownerActionIdempotencyKey,
} from "./auth/executeDecision.js";
import {
  executeTradeForAgent,
  tradeExecutionIdentity,
  type ExecuteTradeResult,
} from "./trade/execute.js";
import { sanitizeMessage } from "./core/errors.js";
import {
  ExecutionPlaneError,
  ProviderError,
  type ExecutionReceipt,
  type NativeDayMeterReading,
  type ProviderRegistry,
  type SessionRef,
  type WalletProvider,
} from "./core/types.js";
import type { KillSwitch } from "./killswitch/killswitch.js";
import {
  AgentExistsError,
  AgentWalletInUseError,
  agentOccupiesWallet,
  agentSessionIntegrity,
  validSessionRevocationProof,
  type AgentRecord,
  type AgentStatus,
  type AgentStore,
  type PendingGrant,
} from "./store/agents.js";
import type {
  ExecutionJournal,
  JournalEntry,
  JournalKind,
  JournalResolutionEvidence,
} from "./store/journal.js";
import type { NonceStore } from "./store/nonces.js";
import type { RuntimeReplayStore } from "./store/runtimeReplays.js";
import type { TradeSettingsStore } from "./store/tradeSettings.js";
import type { TradePositionStore } from "./store/tradePositions.js";
import type { TradeIntentStore } from "./store/tradeIntents.js";
import type { TradeDetailObserver } from "./trade/detail.js";
import {
  MAX_CALLS_PER_EXECUTE,
  accountKeyHashForAddress,
  agentAuthorityFromPrivateKey,
} from "./wallet/altana.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "./wallet/abis.js";
import type { DataPlaneClient } from "./clients/dataPlane.js";
import {
  DEFAULT_EXECUTE_THROTTLE,
  ExecuteThrottle,
  TokenBucketLimiter,
  type ExecuteThrottleOptions,
} from "./http/limits.js";
import {
  MAX_AGENT_ID_CHARS,
  agentOwnerView,
  agentRuntimeView,
  decodeOwnerActionHeader,
  type OwnerNativeMeterView,
  hashCalls,
  parseAdminRequest,
  parseBudgetParams,
  parseExecuteRequest,
  parseHireParams,
  parseOwnerActionEnvelope,
  parseTradeRequest,
  type TradeRequest,
  type HireParams,
  type LendingHireParams,
  provisioningView,
} from "./http/wire.js";
import {
  enforceLendingV1Profile,
  lendingSettingsDigest,
  lendingSettingsView,
  parseGuardableQuery,
  parseLendingArmParams,
  parseLendingRetireParams,
  parseLendingSettingsParams,
  parseLendingSettingsRequest,
  type LendingConfigView,
  type LendingGuardableView,
  type LendingQuoteView,
} from "./http/lendingWire.js";
import {
  flapVenue,
  pancakeV3Venue,
  pancakeVenue,
} from "./ops/venues.js";
import { createNoFeePolicy } from "./ops/fees.js";
import { forbiddenTokenAddresses } from "./ops/forbiddenTokens.js";
import {
  DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI,
  MAX_SUBMISSIONS_PER_GRID_SHIFT,
  DEFAULT_VENUS_RESCUE_RESERVE_COUNT,
  NATIVE_RESERVE_REMEDY,
  VENUS_SESSION_EXPIRING_SECONDS,
  WBNB_DEPOSIT_SELECTOR,
  checkLpNativeCapSizing,
  checkHireSizing,
  hireSizingPreview,
  lpSessionSpec,
  checkVenusNativeCapSizing,
  grantsTokenSell,
  grantsVenusMarket,
  nativeReserveFloor,
  tradeSessionSpec,
  venusMeterReserve,
  walletNativeFloorWei,
  LENDING_DUST_USDT_WEI,
  LENDING_MAX_MARKETS,
  RELAY_FEE_PER_EXIT_WEI,
  checkLendingSizing,
  lendingHireSizingPreview,
  lendingSessionSpec,
  type VenusRoutingCensus,
} from "./ops/policy.js";
import {
  buildLendingArmBatch,
  buildLendingRetireBatch,
} from "./lending/batches.js";
import {
  lendingOwnerActionDecisionId,
  submitLendingBatch,
} from "./lending/execute.js";
import { planLendingRetire, retireCleared } from "./lending/sizing.js";
import {
  createLendingPreviewCache,
  createLendingPreviewLimiter,
  issueLendingPreviewReceipt,
  verifyLendingPreviewReceipt,
} from "./lending/preview.js";
import {
  LendingAccountTooComplexError,
  type LendingChainReaders,
  type LendingVenue,
} from "./lending/readers.js";
import type { LendingGuardRecord, LendingGuardStore } from "./store/lendingGuards.js";
import type { LendingHold } from "./lending/types.js";
import { immutableTradeSettingChange, parseTradeSettings, tradeSettingsDigest } from "./trade/settings.js";
import { checkTradeSizing, nativeDayCapWei } from "./trade/sizing.js";
import {
  ModelUnavailableError,
  PinTooSmallError,
  PinUnreadableError,
  isUsEquityOpen,
  pinUniverse,
  rerankHeld,
  type PinnedCandidate,
} from "./trade/universe.js";
import type { TradeDataPlaneReads } from "./trade/dataPlaneReads.js";
import type { TradeReadiness } from "./trade/readiness.js";
import { pinnedTokens, positionView, runView, tradeSummary } from "./trade/view.js";
import { validateSessionSpec } from "./core/session.js";
import type { GrantEvidenceReader } from "./wallet/grantEvidence.js";
import { grantDigest } from "./wallet/grantEvidence.js";
import { convergeProvisioning } from "./wallet/provisioning.js";
import type { VenusSettingsStore } from "./store/venusSettings.js";
import type { VenusObservationStore } from "./store/venusObservations.js";
import {
  VENUS_QUOTA_WINDOW_MS,
  type VenusActionStore,
} from "./store/venusActions.js";
import type { VenusChainReaders } from "./venus/readers.js";
import {
  venusCondition,
  type VenusConditionReport,
  type VenusVenue,
} from "./venus/types.js";
import { venusBasisView } from "./venus/triggers.js";
import { venusRescueCapacity } from "./venus/sizing.js";
import { readVenusUnknownHold } from "./venus/worker.js";
import {
  maxPerActionFor,
  namesMarket,
  parseVenusSettingsParams,
} from "./http/venusWire.js";
import {
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_MAX_VENUE_FEE_BPS,
  DEFAULT_TRADE_DEADLINE_SEC,
  type LpRuntimeConfig,
  type TradeRuntimeConfig,
} from "./ops/config.js";
import { canonicalEncode, paramsHash } from "./auth/canonical.js";
import { sagaSwapMinOut, spotSwapOutput } from "./lp/rails.js";
import type { LpRailConfig, LpRailConfigResult, LpRailEvidence } from "./lp/rails.js";
import {
  centeredRotationRange,
  swaplessResidueWithinBound,
  SWAPLESS_MAX_RESIDUE_BPS,
} from "./lp/fence.js";
import {
  classifyLpRankingTimestamp,
  parsePoolsTopEnvelope,
  selectLpPool,
  type LpRankedPool,
} from "./lp/selectPool.js";
import { lpRankedDiscoveryToken } from "./lp/rankedDiscovery.js";
import { runLpOpen } from "./lp/open.js";
import {
  LpNoQuoteLegError,
  runLpManualExit,
  type LpPositionSnapshot,
  type LpPositionsReader,
  type LpQuoteReader,
  type LpQuoteWithPriceAfterReader,
  type LpReceiptReader,
  type LpSagaDeps,
  type LpSagaRunResult,
  type LpSagaVenue,
} from "./lp/sagas.js";
import {
  maxTokenAmountWei,
  probeLpExitImpact,
  valueLpPosition,
  type LpExitProbe,
} from "./lp/valuation.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "./lp/tickMath.js";
import {
  verifyLpResolveUnknown,
  type LpLogAbsenceProbe,
} from "./lp/resolveUnknown.js";
import { verifyLpAbandonSequence } from "./lp/abandonSequence.js";
import {
  resolveUnknownLandingV1,
  type LandingEvidenceProvider,
  type ResolveLandingV1Result,
} from "./lp/resolveLanding.js";
import {
  PRE_BIND_RETIREMENT_LEASE_MS,
  verifyPreBindRetirement,
  verifyPreBindRetirementClaim,
} from "./lp/retirePreBind.js";
import {
  MemoryPreBindRetirementFinalizer,
  preBindRetirementActionCompletionRef,
  preBindRetirementResult,
  type PreBindRetirementFinalizer,
} from "./lp/preBindRetirementFinalizer.js";
import {
  DEFAULT_LP_SETTINGS,
  alreadySatisfiedPriceTrigger,
  evaluateLpProtectBreach,
  gridModeOf,
  ladderMinMarkoutBps,
  ladderMotionCounts,
  ladderStrandedMinutes,
  priceTriggerMatchesPool,
  lpProtectionStatus,
  type LpAutomationSettings,
  type LpBlockingSequence,
  type LpGridLevelValue,
  type LpGridRoleValue,
  type LpGridSettings,
  type LpPriceTrigger,
  type LpTriggerObservation,
} from "./lp/triggers.js";
import {
  GRID_DUAL_SPLIT_BPS,
  gridDualSellClearanceOk,
  gridDualSellSizeWei,
  gridDualSwapInWei,
  gridIsDual,
  gridCycleSubmissions,
  gridEconomicsPair,
  gridLiveRole,
  gridRoleAtFor,
  gridNetEdge,
  gridIdentitySourceFor,
  gridLadderEconomics,
  gridLadderResilience,
  gridLadderBlockedBy,
  gridNetEdgePair,
  gridPair,
  gridRangeList,
  gridTargetRange,
  gridShiftEconomics,
  gridShiftDriftMotionsPerDay,
  gridShiftGroupLock,
  gridSideChargesQuote,
  lpGridImportModeRefusal,
  gridTargetSide,
  type LpGridRoleAt,
  lpGridArmRefusal,
  lpGridDualArmBuyRefusal,
  lpGridDualArmSellRefusal,
  lpGridModeChangeRefusal,
  lpGridNetEdgeRefusal,
  type LpGridShiftEconomics,
  type LpGridNetEdge,
} from "./lp/gridTriggers.js";
import {
  LpPositionNotFoundError,
  LpTokenIdInUseError,
  isTerminalLpSequence,
  lpSequenceIdOfStepDecision,
  lpStepDecisionId,
  type LpArmMeta,
  type LpPositionRecord,
  type LpQuotaUsage,
  type LpSequenceRecord,
  type LpSequenceStore,
} from "./store/lpSequences.js";
import type { LpSettingsStore } from "./store/lpSettings.js";
import type { LpObservationStore } from "./store/lpObservations.js";
import type { LpGridCycleRecord, LpGridCycleStore } from "./store/gridCycles.js";
import {
  LP_STEP_OUTCOME_UNREADABLE,
  defaultLpSettingsParams,
  lpPositionView,
  lpObservationView,
  lpProtectionView,
  lpSequenceView,
  lpSettingsResponseView,
  lpQuotaView,
  lpStepOutcome,
  isCanonicalUint256Decimal,
  parseLpArmParams,
  parseLpExitParams,
  parseLpGridArmParams,
  parseLpImportParams,
  parseLpOpenParams,
  parseLpAbandonParams,
  parseLpResolveParams,
  parseLpResolveLandingV1Params,
  parseLpRetirePreBindV1Params,
  parseLpSettingsParams,
  type LpArmRequest,
  type LpOpenRequest,
  type LpSequenceStepOutcome,
} from "./http/lpWire.js";
import type { LpEvidenceStore } from "./store/lpEvidence.js";
import type { LandingResolutionFinalizer } from "./lp/landingFinalizer.js";
import {
  DEFAULT_SCAN_TTL_SEC,
  createScanGate,
} from "./rules/scanGate.js";
import type { BillingStore } from "./billing/store.js";
import type {
  AgentBillingGrant,
  BillingAccount,
  PaidServiceSessionTicketV1,
  Usage,
} from "./billing/types.js";
import {
  parseBillingAccountActionParams,
  parseBillingGrantParams,
  parseBillingRotateParams,
  parsePaidServiceSessionParams,
} from "./billing/ownerWire.js";
import {
  assertBillingAgentBinding,
  billingOwnerView,
  grantAgentBilling,
  issueAgentPaidServiceSession,
  rotateAgentBillingIssuer,
} from "./billing/ownerService.js";

/* -------------------------------------------------------------------------- */
/* Configuration and dependencies                                             */
/* -------------------------------------------------------------------------- */

export type RateLimitConfig = {
  /** Burst allowance per source before throttling begins. */
  readonly capacity: number;
  /** Sustained requests per second per source. */
  readonly refillPerSecond: number;
};

/** Default IP/token bucket. Generous for a private-network service. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  capacity: 60,
  refillPerSecond: 10,
};

/** Default per-owner bucket, applied only after a signature has been recovered. */
export const DEFAULT_OWNER_RATE_LIMIT: RateLimitConfig = {
  capacity: 20,
  refillPerSecond: 2,
};

/** Default body cap. Generous for JSON, tiny compared to a memory problem. */
export const DEFAULT_MAX_BODY_BYTES = 16_384;

export type ServerConfig = {
  /** The chain owner signatures are accepted for, and providers resolved by. */
  readonly chainId: number;
  /** Network label folded into the EIP-712 domain salt. */
  readonly network?: string;
  /** Explicit domain-salt override (`EXECUTION_ENV_SALT`). */
  readonly envSalt?: string;
  /** AltanaKeyStore address, needed to build unsigned revoke instructions. */
  readonly keyStore: Address;
  /** Service credential (`EXECUTION_API_TOKEN`). Empty disables the layer. */
  readonly execToken: string;
  /** Operator credential (`EXECUTION_OPERATOR_TOKEN`). Empty disables admin routes. */
  readonly operatorToken: string;
  /** Injectable clock, epoch MILLISECONDS. Defaults to `Date.now`. */
  readonly now?: () => number;
  readonly maxBodyBytes?: number;
  readonly rateLimit?: RateLimitConfig;
  readonly ownerRateLimit?: RateLimitConfig;
  readonly throttle?: Omit<ExecuteThrottleOptions, "now">;
  /** Clock-skew tolerance for owner signatures, in seconds. */
  readonly skewSeconds?: number;
  /**
   * Signature backend seam.
   *
   * Defaults to the DISPATCHING verifier built from {@link passkey} — 65-byte
   * signatures to secp256k1 byte-for-byte as in 1b, anything else to the
   * WebAuthn backend (which refuses outright while passkeys are off). An
   * injected verifier still wins, so a test that supplies its own is unaffected.
   */
  readonly verifier?: Verifier;
  /**
   * Passkey owner-auth configuration (PHASE1.5). Defaults to DISABLED, and the
   * default is the point: a deployment that has never heard of passkeys behaves
   * exactly as Phase 1b did. Resolved at boot by `resolvePasskeyConfig`, which
   * fails the process rather than the request on a malformed value.
   */
  readonly passkey?: PasskeyConfig;
  /** Public-key verifier configuration for autonomous HTTP runtime routes. */
  readonly runtimeAuth?: RuntimeAuthConfig;
  /**
   * Whether `POST /agents/:id/execute` — the RAW calls route — is exposed.
   *
   * Defaults to FALSE, and the default is the point. That route submits
   * arbitrary calldata under the session key.
   *
   * PHASE2.3 R7 corrects what that costs, in the narrowing direction only. The
   * trade template no longer grants a bare-selector `approve`, so a leaked
   * `x-exec-token` can no longer reach every ERC-20 in the owner's EOA — but it
   * can still `approve(attacker, amount)` on any GRANTED token (the spender is
   * an argument no `CallRule` can constrain) and drain up to that token's cap,
   * which the deliberately generous default caps make effectively its balance.
   * NARROWED, NOT CLOSED. The raw route also bypasses the scan gate and the
   * rule engine, which the trade route does not, and that alone justifies the
   * default. Disabled, the route returns the same 404 as an unknown path — it
   * does not advertise that it exists and is switched off.
   */
  readonly executeRawEnabled?: boolean;
  /** Trade-route configuration. Defaults to no venues, no fee. */
  readonly trade?: TradeRuntimeConfig;
  /** Optional short-lived bearer accepted only by the Account portfolio read. */
  readonly accountReadSession?: AccountReadSessionConfig;
  /** WBNB is the native BNB price identity for Account valuation. */
  readonly accountPortfolioWbnb?: Address;
  /** Strict boot-resolved hire gate. False/absent registers no hire routes. */
  readonly hireEnabled?: boolean;
  /** Trading-agent owner surface; OFF/absent registers no routes. */
  readonly tradeAgentEnabled?: boolean;
};

/**
 * What one `slot0`/`observe` visit to a pool answers, read at/below the
 * FINALIZED block exactly as the trigger evaluator requires. The evidence half
 * is what the rails check; `priceImpactBps` inside it describes no particular
 * swap (the open re-derives impact for the leg it actually prices).
 */
export type LpPoolStateReading = {
  readonly pool: Address;
  /** From the factory/pool — never assumed (PHASE3 venue facts). */
  readonly tickSpacing: number;
  readonly currentTick: number;
  readonly evidence: LpRailEvidence;
};

/**
 * Chain reads the LP routes need, injected exactly as the sagas' readers are
 * (PHASE3: no RPC in the route layer; a fake serves the whole surface offline).
 */
export type LpChainReaders = {
  /** Optional, reporting-only receipt evidence; never used by execution. */
  readonly gridArmBenchmark?: (input: GridArmBenchmarkInput) => Promise<GridArmBenchmark>;
  /** Factory `getPool`, or `null` when no pool exists for the triple. */
  getPool(token0: Address, token1: Address, fee: number): Promise<Address | null>;
  /** Pool state + rail evidence. THROWS when the TWAP cannot be read. */
  poolState(pool: Address): Promise<LpPoolStateReading>;
  /**
   * LP-DEPLOY liquidity chart (2026-09-05): the pool's per-bin liquidity
   * profile at one finalized block. OPTIONAL, so every hand-built reader in
   * the tree still satisfies this type; the one route that serves it answers
   * 503 without it. Display data only — no decision reads it.
   */
  readonly tickLiquidity?: (
    pool: Address,
    input: { readonly windowBins: number },
  ) => Promise<LpTickLiquidityReading>;
  readonly positions: LpPositionsReader;
  readonly quote: LpQuoteReader;
  /**
   * PHASE3.17 R3.3 — the same QuoterV2 call plus the SIMULATED POST-SWAP price.
   *
   * OPTIONAL, so every hand-built reader object in the tree still satisfies this
   * type unchanged. The dual grid arm is the only caller; without it that route
   * refuses fail-closed rather than gating its sell rung on a pre-swap price the
   * batch's own swap is about to invalidate.
   */
  readonly quoteWithPriceAfter?: LpQuoteWithPriceAfterReader;
  /**
   * PHASE3.19 item 5 — the wallet's ERC-20 balance, for the LADDER's idle
   * buffer and for nothing else.
   *
   * OPTIONAL, so every hand-built reader object in the tree still satisfies this
   * type unchanged. The ladder saga refuses fail-closed without it and the
   * ladder trigger's funding conjunct holds without it — never "the buffer is
   * empty", which would be a claim rather than a reading.
   */
  readonly walletTokenBalance?: (token: Address, wallet: Address) => Promise<bigint>;
  /**
   * GRID-GAS-RESERVE P2 — the wallet's NATIVE balance, the pot the relay bills
   * every batch from. Read by the shift trigger's gas gate and mirrored into the
   * owner view's `buffer`, so the worker and the page hold the same figure.
   */
  readonly walletNativeBalance?: (wallet: Address) => Promise<bigint>;
  readonly receipts: LpReceiptReader;
  /**
   * NFPM `ownerOf(tokenId)` (PHASE3.4 Rev2 M6), or `"burned"` when the token
   * does not exist. REQUIRED, not optional, and the difference matters: this is
   * the admission check for `POST /lp/import` and the per-cycle gate that stops
   * a resumed harvest donating its carried legs into a stranger's position, so
   * a wiring that cannot answer it must not serve either.
   */
  readonly ownerOf: (tokenId: bigint) => Promise<Address | "burned">;
  /**
   * The exact uncollected fees, from a `collect(max,max)` SIMULATION
   * (PHASE3.4). Moved here from `LpWorkerChainReaders` because the import
   * routes value a position exactly as the worker does — decision 11's whole
   * argument — and the owner signs a `basisWei` against that number.
   */
  readonly positionFeesAt?: (tokenId: bigint, wallet: Address, blockNumber: bigint) => Promise<{ readonly amount0Wei: bigint; readonly amount1Wei: bigint } | "burned">;
  readonly positionFees: (
    tokenId: bigint,
    wallet: Address,
  ) => Promise<{ readonly amount0Wei: bigint; readonly amount1Wei: bigint } | "burned">;
  /**
   * The LIVE on-chain rolling daily NATIVE cap of the agent's session — the
   * chain's answer, not the persisted snapshot (Rev2 item 11, the dev-stack
   * A2 lesson). `POST /lp/settings` re-runs `checkLpNativeCapSizing` against
   * THIS and refuses a change that breaks it; a read failure refuses too.
   */
  onChainNativeDailyCapWei(agent: AgentRecord): Promise<bigint>;
  /**
   * The height the SERVER read at, for the resolution receipt (PHASE3.3 Rev2
   * item 17). OPTIONAL so a hand-built deps object (tests, the dev stack) need
   * not supply it; absent, the evidence records `serverBlock: unavailable`
   * rather than silently omitting it.
   */
  readonly blockNumber?: () => Promise<bigint>;
  /**
   * Finalized head passed as the explicit block argument to `positions`.
   * Optional only for legacy injected test deps; `createLpChainReaders`, the
   * production wiring, always provides it.
   */
  readonly finalizedBlockNumber?: () => Promise<bigint>;
  /**
   * The OPTIONAL, capability-probed log-absence evidence (Rev2 item 10(g)).
   *
   * Deliberately absent from every shipped wiring, and that absence is a
   * MEASUREMENT rather than an omission: `eth_getLogs` is refused at every
   * range — down to one block — by both endpoints `resolveLpRpcUrls` prefers,
   * and the one endpoint that serves it caps at 10 000 blocks (≈1 h 15 min at
   * the measured block time) while refusing `eth_getTransactionReceipt`, which
   * the inputs check needs. One reader instance can serve one or the other,
   * never both. The seam exists so a future archive endpoint is a wiring change;
   * nothing here may come to depend on it.
   */
  readonly logAbsence?: LpLogAbsenceProbe;
};

/**
 * Everything the LP routes need beyond the core deps. OPTIONAL on
 * {@link ServerDeps}: a deployment that does not wire it gets the same 404 an
 * unknown path gets — the `EXECUTE_RAW_ENABLED` posture, routes that do not
 * advertise that they exist and are switched off.
 */
export type LpServerDeps = {
  readonly store: LpSequenceStore;
  readonly settingsStore: LpSettingsStore;
  /**
   * The durable trigger observation store (PHASE3.2). The read side needs it
   * to answer "is this position's protection actually armed" — the question
   * FINDINGS (ae) proved nothing could answer.
   */
  readonly observations: LpObservationStore;
  /**
   * The cadence the WORKER runs on (`LP_WORKER_INTERVAL_SEC`, clamped). The
   * read side reports `confirmationEligibleAtMs` in terms of it, so it must be
   * the worker's own number and not a second default.
   */
  readonly workerIntervalMs: number;
  /**
   * PHASE3.22 R5.4 / D4(b) — the WORKER's stall-latch threshold
   * (`LP_STALL_LATCH_ATTEMPTS`), threaded through the deps for exactly the
   * reason {@link workerIntervalMs} is: this module does not import
   * `src/lp/worker.ts` and must not start, and `abandonSequence` is pure and
   * must not either. The wiring is the one place that knows both.
   *
   * It opens TIER 2 of the COMMITTED `grid-shift` abandon (R4.3) and nothing
   * else reads it. OPTIONAL, and absent means tier 2 NEVER OPENS — the
   * fail-closed direction, since tier 2 discards the plane's account of two
   * NFTs and a deployment that did not configure it has not asked for that.
   */
  readonly stallLatchAttempts?: number;
  /** `LP_MAX_OBSERVATION_AGE_MS`, lower-only, resolved at boot. */
  readonly maxObservationAgeMs?: number;
  /**
   * Resolved rail config, or its typed failure. Deliberately the RESULT: the
   * rails' contract is "missing ⇒ hold, never default-open", so an
   * unconfigured deployment refuses every open/exit with the failure's own
   * reason instead of failing the boot (`src/lp/rails.ts` module header).
   */
  readonly railsResult: LpRailConfigResult;
  readonly runtime: LpRuntimeConfig;
  /** NFPM + dedicated V3 router + WBNB, from resolved config, never a request. */
  readonly venue: LpSagaVenue;
  readonly readers: LpChainReaders;
  /**
   * `LP_RELAY_FEE_PER_SUBMIT_WEI` override for the sizing re-check AND for the
   * exit swap's dust floor.
   *
   * OPTIONAL, and PHASE3.1-AUDIT A10 names the consequence: `LpSagaDeps`
   * declares its counterpart REQUIRED "so a forgotten wiring is a compile
   * error", and this seam defaults it instead
   * ({@link DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI}). Left optional deliberately —
   * `buildLpServerDeps` always resolves it, the default IS the constant the
   * sizing arithmetic uses, and making it required would force every offline
   * server fixture to name a number that has exactly one correct value.
   */
  readonly relayFeePerSubmitWei?: bigint;
  /**
   * PHASE3.15 (C4) — `GRID_ENABLED`, resolved in `buildLpServerDeps` and
   * carried HERE rather than on a `GridServerDeps` of its own.
   *
   * There is no new route family: the grid's whole surface is the EXISTING
   * `lpSettings` route (which gains the block and its admission checks), the
   * EXISTING `/lp/import` route (which gains the grid-specific admission), the
   * EXISTING exit/abandon/resolve doors, and the EXISTING owner view (which
   * gains a section). Absent or false ⇒ a params object carrying `grid` is
   * REFUSED at the settings route, so nobody signs settings the runtime cannot
   * honour.
   */
  readonly gridEnabled?: boolean;
  /** PHASE3.15: the derived cycle ledger the owner view reports from. */
  readonly feeEvents?: import("./store/lpFeeEvents.js").LpFeeEventStore;
  readonly gridCycles?: LpGridCycleStore;
  /** The only capability permitted to terminalize a proved no-bind LP row. */
  readonly preBindRetirementFinalizer?: PreBindRetirementFinalizer;
  readonly landingEvidence?: {
    readonly store: LpEvidenceStore;
    readonly provider: LandingEvidenceProvider;
    readonly resolverLeaseMs: number;
    readonly finalizer?: LandingResolutionFinalizer;
  };
};

/**
 * Everything the two Venus routes need beyond the core deps. OPTIONAL on
 * {@link ServerDeps}, exactly like {@link LpServerDeps}: a deployment that does
 * not wire it gets the same 404 an unknown path gets, which is the
 * `EXECUTE_RAW_ENABLED` posture — routes that do not advertise that they exist
 * and are switched off. `VENUS_ENABLED` decides whether it is wired (D11).
 */
export type VenusServerDeps = {
  readonly settingsStore: VenusSettingsStore;
  /** The durable hysteresis counter the view reports armed-ness from. */
  readonly observations: VenusObservationStore;
  /** The charged-row ledger the quota block and the meter reserve read. */
  readonly actions: VenusActionStore;
  readonly readers: VenusChainReaders;
  /** The pinned Venus addresses — Comptroller, vBNB, Prime, treasury. */
  readonly venue: VenusVenue;
  /**
   * The cadence the WORKER runs on. The read side reports
   * `confirmationEligibleAtMs` in terms of it, so it must be the worker's own
   * number and not a second default — the two disagreeing is what makes an
   * "armed" answer meaningless.
   */
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  /**
   * vToken -> its market identity, keyed LOWERCASE. Resolved at boot from the
   * plane's own chain reads (never from the advisory cache), so the settings
   * route can tell which underlying a named market needs a ceiling for without
   * making a chain read inside `ownerMutation`'s journaled act.
   */
  readonly marketIndex: Readonly<Record<string, { readonly underlying: Address | null }>>;
};

/**
 * Everything the lending routes need beyond the core deps. OPTIONAL on
 * {@link ServerDeps}, exactly like {@link LpServerDeps} and
 * {@link VenusServerDeps}: a deployment that does not wire it gets the same 404
 * an unknown path gets. `LENDING_ENABLED` decides whether it is wired (§8.5).
 */
export type LendingServerDeps = {
  readonly guards: LendingGuardStore;
  readonly settingsStore: VenusSettingsStore;
  readonly observations: VenusObservationStore;
  readonly readers: LendingChainReaders;
  readonly venue: LendingVenue;
  /**
   * The cadence the WORKER runs on. The view reports snapshot staleness as
   * `2 x` this, so it must be the worker's own number and not a second default
   * — the two disagreeing is what makes a "fresh" answer meaningless.
   */
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  /** `rails.maxSagaSlippageBps` — the ONE slippage rail every leg floors on. */
  readonly maxSagaSlippageBps: number;
  /**
   * The preview-receipt key (R3.8). `null` is a supported, FAIL-CLOSED state:
   * `/lending/guardable` returns no receipt and S1 refuses
   * `preview-receipt-unavailable`.
   */
  readonly previewSecret: Uint8Array | null;
  /**
   * The boot-read Venus routing census (AUDIT A-M2). S1 passes it into
   * `lendingSessionSpec`, which asserts it — that assertion was structurally
   * unreachable on this path while nothing ever supplied one, and BUILD §4's
   * ERC-20 overpay caveat cites the census as live.
   */
  readonly routing?: VenusRoutingCensus;
};

/** Owner-facing Phase 5 billing controls. Absent means exact 404. */
export type BillingOwnerServerDeps = {
  readonly store: BillingStore;
  readonly executionTicketKeyId: string;
  readonly signExecutionTicket: (bytes: Uint8Array) => Promise<string>;
  /** Fresh authoritative expiry of the dedicated chain-56 billing session. */
  onChainSessionExpiresAt(agent: AgentRecord): Promise<number>;
  /** Fresh USD-micros valuation for only the supplied proven-actual usages. */
  actualUsdMicros(usages: readonly Usage[]): Promise<bigint>;
};

/** Browser-hire collaborators. Present only after the real-entry durability gate. */
export type HireServerDeps = {
  readonly evidence: GrantEvidenceReader;
  readonly nfpm: Address;
  readonly routerV3: Address;
  readonly wbnb: Address;
  readonly treasury: Address;
  readonly feeBps: number;
  readonly relayFeePerSubmitWei: bigint;
  readonly grantGasHeadroomWei: bigint;
};

export type TradeAgentServerDeps = {
  readonly settingsStore: TradeSettingsStore;
  readonly positions: TradePositionStore;
  readonly intents: TradeIntentStore;
  readonly observer: TradeDetailObserver;
  readonly dataPlane: TradeDataPlaneReads;
  readonly readiness: TradeReadiness;
  readonly feeBps: number;
};

/** Collaborators the HTTP layer reads from. Injected so the app stays testable. */
export interface ServerDeps {
  readonly agentStore: AgentStore;
  readonly journal: ExecutionJournal;
  readonly nonceStore: NonceStore;
  readonly runtimeReplayStore?: RuntimeReplayStore;
  readonly killswitch: KillSwitch;
  readonly providerRegistry: ProviderRegistry;
  readonly dataPlane: DataPlaneClient;
  readonly config: ServerConfig;
  /** LP routes (PHASE3). Absent ⇒ the LP paths answer 404, byte-identically. */
  readonly lp?: LpServerDeps;
  /** Venus routes (PHASE4). Absent ⇒ the Venus paths answer 404 (D11). */
  readonly venus?: VenusServerDeps;
  /** Lending routes. Absent ⇒ every `/lending/*` path answers 404 (§8.5). */
  readonly lending?: LendingServerDeps;
  /** Phase 5 owner billing surface. Absent/off/report means exact 404. */
  readonly billingOwner?: BillingOwnerServerDeps;
  /**
   * The Altana KeyStore read seam used to PROVE that a caller-declared wallet
   * on `GET /account/portfolio?wallets=` is controlled by the authenticated
   * owner (`src/account/keyStoreReader.ts`). Injected like every other chain
   * reader; absent is supported and reports `passkeyVerified: "unreadable"`.
   */
  readonly keyStoreReader?: KeyStoreReader;
  /**
   * The BATCHED public-chain balance reader for `GET /account/portfolio`
   * (`src/account/balanceReader.ts`). Read-only, holds no key, submits
   * nothing, and is DELIBERATELY not the provider — the provider's client is
   * the money path. Absent is supported: the account read falls back to the
   * provider one call at a time.
   */
  readonly balanceReader?: BalanceReader;
  readonly hire?: HireServerDeps;
  readonly tradeAgent?: TradeAgentServerDeps;
  /**
   * DEMO MODE. Absent ⇒ the `/demo/*` paths answer 404, byte-identically to a
   * deployment that never heard of them — the same posture `lp` and `venus`
   * take above.
   *
   * The mount is the ONLY line demo mode adds to this file, and it is
   * deliberate: a demo agent holds no key, no session and no authority, so its
   * routes carry no owner signature, no nonce and no runtime assertion, and
   * NOTHING in `src/demo/**` may import the money path (`src/demo/types.ts`
   * carries the ban list). Reaching for a demo flag anywhere else in this file
   * would be the branch-inside-the-money-path this design exists to avoid.
   */
  readonly demo?: DemoServerDeps;
}

function parseBillingParams<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new BadRequestError("Billing action parameters are invalid.");
  }
}

function billingAccountView(account: BillingAccount): Readonly<Record<string, string | number>> {
  return {
    accountId: account.accountId,
    ownerAddress: account.ownerAddress,
    walletAddress: account.walletAddress,
    status: account.status,
    maxDailyUsdMicros: account.maxDailyUsdMicros.toString(),
    maxUnpaidExposureUsdMicros: account.maxUnpaidExposureUsdMicros.toString(),
    thresholdUsdMicros: account.thresholdUsdMicros.toString(),
    grantExpiresAt: account.grantExpiresAt,
    ...(account.closeRequestId === undefined ? {} : { closeRequestId: account.closeRequestId }),
    ...(account.closeRequestedAt === undefined ? {} : { closeRequestedAt: account.closeRequestedAt }),
    ...(account.closedAt === undefined ? {} : { closedAt: account.closedAt }),
  };
}

function billingGrantView(grant: AgentBillingGrant): Readonly<Record<string, unknown>> {
  return {
    grantId: grant.grantId,
    generation: grant.generation.toString(),
    accountId: grant.accountId,
    agentId: grant.agentId,
    ownerAddress: grant.ownerAddress,
    walletAddress: grant.walletAddress,
    issuerKeyId: grant.issuerKeyId,
    issuerPublicKey: grant.issuerPublicKey,
    operations: grant.operations,
    templateIds: grant.templateIds,
    maxAtomic0gPerInference: grant.maxAtomic0gPerInference.toString(),
    maxUsdMicrosPerRequest: grant.maxUsdMicrosPerRequest.toString(),
    maxRolling24hUsdMicros: grant.maxRolling24hUsdMicros.toString(),
    ...(grant.maxTokensPerInference === undefined ? {} : { maxTokensPerInference: grant.maxTokensPerInference }),
    notBefore: grant.notBefore,
    expiresAt: grant.expiresAt,
    status: grant.status,
    ownerConsentHash: grant.ownerConsentHash,
  };
}

function billingTicketView(ticket: PaidServiceSessionTicketV1): Readonly<Record<string, unknown>> {
  return {
    ...ticket,
    generation: ticket.generation.toString(),
    maxSessionUsdMicros: ticket.maxSessionUsdMicros.toString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Error taxonomy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of error codes this service emits.
 *
 * Two of them carry a deliberate ambiguity that is the whole point:
 *   - `not_found` is returned BOTH for an agent that does not exist AND for one
 *     owned by somebody else, byte-identically. A `403` on the second case would
 *     confirm the agent exists, turning the endpoint into an enumeration oracle.
 *   - `owner_auth_failed` is the ONLY code any signature problem produces —
 *     forged, expired, replayed, wrong chain, wrong params, malformed. The
 *     verifier already collapses its internal reasons into one generic error;
 *     this keeps the HTTP layer from re-introducing the distinction.
 */
export type ErrorCode =
  | "unauthorized"
  | "owner_auth_failed"
  | "runtime_auth_failed"
  | "runtime_auth_unavailable"
  | "not_found"
  | "invalid_request"
  | "payload_too_large"
  | "rate_limited"
  | "throttled"
  | "conflict"
  | "agent_exists"
  | "s1_ambiguous"
  | "hire_no_evidence"
  | "wallet_in_use"
  | "session_integrity_corrupt"
  | "wallet_owner_mismatch"
  | "evidence_unreadable"
  | "model_unavailable"
  | "universe_too_small"
  | "capital_too_small"
  | "trade_not_ready"
  | "paused"
  | "halted"
  | "revoked"
  | "not_executable"
  | "internal_error";

/**
 * Why a trade was refused by a policy rather than by an error.
 *
 * Every one of these is a 200 carrying an `ExecutionReceipt` with
 * `status: "FAILED"` — see {@link tradeDenied}. `scan` denials additionally
 * carry `reasons`, drawn from the scan gate's CLOSED enum; no data-plane string
 * ever appears in a response.
 *
 * `session` (PHASE2.4 R4) is the SESSION itself refusing before submission — an
 * expired grant, a call the account would not permit — as distinct from a
 * judgement about the token, the size or the venue. It is the one member whose
 * `code` is an `ExecutionErrorCode` rather than a route-local string.
 */
/**
 * Why a trade was refused before the submit.
 *
 * `transport` is PHASE2.5-AUDIT A3 and is NOT a policy verdict: the plane could
 * not READ something it must read before authorising exposure, so it refused
 * without any party having said no. It exists because the other four all send a
 * reader to look at a DECISION — the scanner, the rules, the venue, the session
 * grant — and an RPC outage reported as one of those costs a diagnosis pass
 * looking at a session that is perfectly fine (PHASE2.4's "an outage wearing a
 * policy rejection's clothes", which PHASE3.1 then paid for again).
 */
export type TradeDenyBy = "scan" | "rules" | "venue" | "session" | "transport";

/**
 * Codes the venue-resolution step can refuse with.
 *
 * REUSED across venues rather than duplicated per venue (PHASE2.4 R8): a caller
 * re-routes on the same code whichever curve refused it.
 *
 *   - `VENUE_UNSUPPORTED`    the read failed, contradicted itself, described a
 *                            V1 token, came back as the all-zero record the
 *                            Four.Meme helper returns for a non-token, or —
 *                            on flap — named an extension token this phase
 *                            deliberately does not route (`swapExactInputV3`);
 *   - `VENUE_GRADUATED`      the curve is closed. On Four.Meme the venue itself
 *                            refuses; on flap the Portal would happily trade it
 *                            THROUGH A MIGRATED POOL this plane never quoted or
 *                            chose, which is a routing decision that belongs to
 *                            the caller. Either way: re-route to Pancake;
 *   - `VENUE_QUOTE_UNSUPPORTED` the token is bought with an ERC-20 rather than
 *                            native BNB (PHASE2.1, and flap's non-native quote
 *                            curves);
 *   - `VENUE_MSGVALUE_UNSAFE` the read's `msg.value` is out of band against the
 *                            caller's own `amountWei` (PHASE2.1 R1).
 */
export type VenueDenyCode =
  | "VENUE_UNSUPPORTED"
  | "VENUE_GRADUATED"
  | "VENUE_QUOTE_UNSUPPORTED"
  | "VENUE_MSGVALUE_UNSAFE";

/**
 * How many of `GET /agents/:id/lp`'s per-step journal reads may be in flight at
 * once (PHASE3.1-FIXREVIEW3 **H6**).
 *
 * The read COUNT is unbounded — `listSequences` has no LIMIT in either backend
 * and paging it is a route-shape change nobody has specified. The CONCURRENCY
 * must not be: on Postgres one owner dashboard GET issuing a `Promise.all` over
 * every step ever recorded is an unbounded number of simultaneous queries into
 * the pool `/execute`, `/trade` and the LP sagas share, so a read-only route
 * could delay a stop-loss. Small on purpose — these reads are single-row
 * primary-key lookups and the route is not latency-critical.
 */
export const LP_STEP_READ_CONCURRENCY = 8;
const PANCAKE_V3_POOL_DEPLOYER_56 = getAddress("0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9");
const PANCAKE_V3_POOL_INIT_CODE_HASH = (
  "0x6ce8eb472fa82df5469c6ab6d485f17c" + "3ad13c8cd7af59b3d4a8026c5ce0f7e2"
) as Hex;
const FEE_TO_TICK_SPACING = new Map<number, number>([
  [100, 1],
  [500, 10],
  [2_500, 50],
  [10_000, 200],
]);

function pancakeV3PoolAddress(token0: Address, token1: Address, fee: number): Address {
  const [first, second] = token0.toLowerCase() < token1.toLowerCase()
    ? [token0, token1]
    : [token1, token0];
  const salt = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    [first, second, fee],
  ));
  return getCreate2Address({
    from: PANCAKE_V3_POOL_DEPLOYER_56,
    salt,
    bytecodeHash: PANCAKE_V3_POOL_INIT_CODE_HASH,
  });
}

/**
 * The execution plane's own version, reported on `/health`.
 *
 * It exists so an OPERATOR SCRIPT CAN ASK THE SERVER instead of asserting
 * something about it from a constant of its own (PHASE2.4 R11). A post-2.4
 * `owner-add-spend-limit` run against a pre-2.4 server that printed "this token
 * works now" would be FINDINGS (u)'s "a half grant reported as success", one
 * level up — the script and the server are different processes and only one of
 * them knows whether the pre-flight will accept a post-hire token.
 *
 * Bump it when a phase changes behaviour an operator tool branches on.
 */
export const EXECUTION_PLANE_VERSION = "2.4.0";

/** The trade config a server runs with when none is supplied: nothing enabled. */
function defaultTradeConfig(chainId: number): TradeRuntimeConfig {
  return {
    venues: { chainId },
    feePolicy: createNoFeePolicy(),
    scanTtlSec: DEFAULT_SCAN_TTL_SEC,
    scanRequireVerdict: false,
    scanMode: "report",
    maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
    deadlineSec: DEFAULT_TRADE_DEADLINE_SEC,
    maxVenueFeeBps: DEFAULT_MAX_VENUE_FEE_BPS,
  };
}

/**
 * Addresses a `token` argument may never name.
 *
 * `token` is the one address a caller supplies that this server then builds
 * calls AGAINST — an `approve` on it, a swap path through it. Left unchecked,
 * `token = <the agent's own wallet>` emits `approve(spender, amount)` ON THE
 * ACCOUNT CONTRACT ITSELF, which is precisely the self-call escalation
 * `validateSessionSpec` exists to keep out of an allowlist, reached instead
 * through a request body. The KeyStore is the same attack against the key
 * registry. The venue addresses and the treasury are here for a duller reason:
 * a swap path that treats a router as an ERC-20 is a guaranteed loss, and the
 * zero address is a burn.
 *
 * Lowercased for comparison; the caller has already checksum-normalized.
 */

/**
 * Addresses that may never become an approval SPENDER.
 *
 * Applied to the Four.Meme manager that comes back from the on-chain
 * `getTokenInfo` read (PHASE2.1 R3): that address is chosen by a contract we do
 * not control, so it gets the same scrutiny as one chosen by the caller. The
 * routers are absent on purpose — a router IS a legitimate spender — and so is
 * the configured manager, since matching it is the expected case. This set is
 * UNCHANGED from Phase 2 (PHASE2.1 R6); the read-derived manager gets exactly
 * it, plus the explicit `manager === token` check at the call site.
 */
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PHASE3.25 R10.1 — the only structured error field. It arrives as bigint;
 * `fail` renders and projects it so no caller-provided sibling can escape.
 */
export type ErrorMeta = { readonly shortfallWei: bigint };

/**
 * Build an error response. `sanitizeMessage` runs here and only here, so there
 * is exactly one place text leaves. The second channel is one server-computed
 * bigint, validated and projected here rather than copied from its input.
 */
export function fail(
  c: Context,
  status: ErrorStatus,
  code: ErrorCode,
  message?: string,
  meta?: ErrorMeta,
): Response {
  if (
    meta !== undefined
    && (typeof meta.shortfallWei !== "bigint"
      || meta.shortfallWei < 0n
      || meta.shortfallWei.toString(10).length > 120)
  ) {
    return c.json({ error: { code: "internal_error" } }, 500);
  }
  const error = {
    code,
    ...(message === undefined ? {} : { message: sanitizeMessage(message) }),
  };
  return c.json(
    meta === undefined
      ? { error }
      : { error, meta: { shortfallWei: meta.shortfallWei.toString(10) } },
    status,
  );
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Constant-time credential comparison.
 *
 * Both sides are hashed first so the buffers handed to `timingSafeEqual` always
 * have equal length (it throws otherwise, and the throw itself would leak the
 * length of the provided value).
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Session key handling                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Fetch, use and drop the agent's session key inside the narrowest scope that
 * can possibly work.
 *
 * The key is a local `const` in this function. It is never returned, never
 * assigned to anything outside, never journalled and never logged — including on
 * the error path, where the `catch` deliberately re-throws without touching it.
 * The only thing that escapes is whatever `use` returns, and `use` receives an
 * opaque authority handle rather than the key material.
 */
async function withSessionKey<T>(
  store: AgentStore,
  agent: AgentRecord,
  use: (authority: ReturnType<typeof agentAuthorityFromPrivateKey>) => Promise<T>,
): Promise<T> {
  const sessionKey = await store.getAgentSessionKey(agent.ownerAddress, agent.id);
  if (sessionKey === null) {
    throw new ProviderError("Agent has no stored session key.");
  }
  return use(agentAuthorityFromPrivateKey(sessionKey));
}

/* -------------------------------------------------------------------------- */
/* The app                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the HTTP app. PURE: it never binds a port, never reads `process.env`,
 * and never starts a timer, so tests drive it with `app.request(...)` and a
 * frozen clock. `src/index-server.ts` is what turns it into a running process.
 */
/** PHASE3.23 R3.5 — restart-stable geometry from the route's existing rows. */
export function lpShiftPairGeometry(
  positions: readonly Pick<LpPositionRecord, "positionId" | "armGroupId">[],
  sequences: readonly Pick<
    LpSequenceRecord,
    | "kind"
    | "state"
    | "positionId"
    | "targetTickLower"
    | "targetTickUpper"
    | "targetSellTickLower"
    | "targetSellTickUpper"
    | "updatedAt"
  >[],
  currentArmGroupId: string | null,
): {
  readonly state: "symmetric" | "asymmetric-midfill";
  readonly movedRole?: "buy" | "sell";
  readonly since?: number;
  readonly reason?: string;
} {
  if (currentArmGroupId === null) return { state: "symmetric" };
  const positionIds = new Set(
    positions
      .filter((row) => row.armGroupId === currentArmGroupId)
      .map((row) => row.positionId),
  );
  const latest = sequences
    .filter(
      (row) =>
        row.kind === "grid-shift"
        && row.state === "completed"
        && positionIds.has(row.positionId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (latest === undefined) return { state: "symmetric" };
  const buy = latest.targetTickLower !== null && latest.targetTickUpper !== null;
  const sell = latest.targetSellTickLower !== null && latest.targetSellTickUpper !== null;
  if (buy === sell) return { state: "symmetric" };
  return {
    state: "asymmetric-midfill",
    movedRole: buy ? "buy" : "sell",
    since: latest.updatedAt,
    reason: "A drift shift moved only the clean rung while its sibling was mid-fill.",
  };
}

export function createServer(deps: ServerDeps): Hono {
  const { config } = deps;
  const nowMs = config.now ?? Date.now;
  const nowSec = (): number => Math.floor(nowMs() / 1000);
  const startedAt = nowMs();
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const runtimeAuth: RuntimeAuthConfig = config.runtimeAuth ?? { kind: "disabled" };
  if (runtimeAuth.kind === "enabled" && deps.runtimeReplayStore === undefined) {
    throw new Error("Enabled runtime authorization requires a runtime replay store.");
  }
  if (config.hireEnabled === true) {
    if (config.chainId !== 56 || config.passkey?.enabled !== true || deps.hire === undefined || !deps.agentStore.durable || !deps.agentStore.keyEncryptionConfigured) {
      throw new Error("HIRE_ENABLED requires chain 56, passkeys, encrypted durable Postgres, and complete hire wiring.");
    }
  }
  if (config.tradeAgentEnabled === true && (config.chainId !== 56 || config.hireEnabled !== true)) {
    throw new Error("TRADE_AGENT_ENABLED requires chain 56 and HIRE_ENABLED.");
  }

  const sourceLimiter = new TokenBucketLimiter({
    ...(config.rateLimit ?? DEFAULT_RATE_LIMIT),
    now: nowMs,
  });
  const ownerLimiter = new TokenBucketLimiter({
    ...(config.ownerRateLimit ?? DEFAULT_OWNER_RATE_LIMIT),
    now: nowMs,
  });
  // ONE throttle instance, shared by /execute and /trade. Two separate ones
  // would bound each route while leaving their SUM unbounded, and the thing
  // worth bounding is how fast an agent can spend, not how fast it can use a
  // particular URL.
  const executeThrottle = new ExecuteThrottle({
    ...(config.throttle ?? DEFAULT_EXECUTE_THROTTLE),
    now: nowMs,
  });

  // ONE verifier for the life of the server, built once. The default is the
  // dispatching one (PHASE1.5 D6): it routes 65-byte signatures to the 1b
  // secp256k1 path unchanged and everything else to the WebAuthn backend, which
  // refuses before parsing while `passkey` is disabled — the default. An
  // injected verifier still wins, so every existing test is unaffected.
  const verifier: Verifier =
    config.verifier ?? createDispatchingVerifier(config.passkey ?? PASSKEY_DISABLED);

  const trade = config.trade ?? defaultTradeConfig(config.chainId);
  const pinCache = new Map<string, { readonly at: number; readonly candidates: readonly PinnedCandidate[] }>();
  const cachedPin = async (
    model: import("./trade/settings.js").TradeExecutionModel,
    walletAddress: Address,
    signal?: AbortSignal,
  ): Promise<readonly PinnedCandidate[]> => {
    const tradeAgent = deps.tradeAgent;
    if (tradeAgent === undefined || !tradeAgent.readiness.ready) throw new TradeNotReadyError();
    if (model === "mid-cap" && !tradeAgent.readiness.allowlistAvailable) throw new ModelUnavailableError(model);
    const cached = pinCache.get(model);
    const candidates = cached !== undefined && nowMs() - cached.at < 60_000
      ? cached.candidates
      : await pinUniverse(model, { dataPlane: tradeAgent.dataPlane, ...(signal === undefined ? {} : { signal }) });
    if (cached === undefined || cached.candidates !== candidates) {
      pinCache.set(model, { at: nowMs(), candidates });
    }
    const provider = deps.providerRegistry.get(config.chainId);
    return rerankHeld(candidates, (token, requestSignal) => provider.getTokenBalance({
      wallet: { address: walletAddress, ownerAddress: walletAddress, custodyModel: "passkey", chainId: config.chainId },
      token,
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    }), signal);
  };

  // PHASE2.5-AUDIT A5 — the assertion `WalletProvider.nativeDayMeter`'s own
  // docstring had been promising while nothing anywhere made it.
  //
  // The method is OPTIONAL on the interface so that a provider which cannot
  // implement it is a knowable CAPABILITY fact rather than a per-request
  // failure. But the gate reads `provider.nativeDayMeter !== undefined`, so a
  // provider without it silently disables F1 for every agent on this chain —
  // no log, no refusal, and an owner view that says "not asked". A money-path
  // guarantee that can be switched off by a missing method must fail at BOOT,
  // where somebody is watching, and never mid-flight.
  //
  // WHY `config.trade !== undefined` IS THE RIGHT TRIGGER, and not merely the
  // convenient one (PHASE2.5-FIXREVIEW F2).
  //
  // The reviewer's observation is correct as stated: `/trade` is registered
  // UNCONDITIONALLY, on `defaultTradeConfig` when the field is absent, so route
  // and guard are gated on different expressions and that looks like a hole one
  // config field wide.
  //
  // It is not one, and the reason is worth writing down because the obvious
  // "fix" is worse. VENUES ONLY EVER ARRIVE INSIDE `config.trade`
  // (`defaultTradeConfig` names none, `:616-627`), and every venue branch of the
  // trade route refuses when its address is missing. So a server without the
  // field serves a route that cannot reach a builder, cannot attach native, and
  // cannot spend the meter this gate protects. Widening the condition to "or a
  // venue is configured" would be DEAD LOGIC that reads as load-bearing — the
  // exact defect class the audit filed A5 about.
  //
  // Pinned by `a server with no trade config cannot execute a trade at all`,
  // so the implication this argument rests on is a test rather than a claim.
  if (config.trade !== undefined) {
    let tradeProvider: WalletProvider | null = null;
    try {
      tradeProvider = deps.providerRegistry.get(config.chainId);
    } catch {
      // No provider for this chain is its own, louder failure and it is not
      // this check's business: every money route already refuses without one.
      tradeProvider = null;
    }
    if (tradeProvider !== null && tradeProvider.nativeDayMeter === undefined) {
      throw new Error(
        `The wallet provider for chain ${config.chainId} does not implement ` +
          `nativeDayMeter, so the PHASE2.5 exit-reserve gate would be silently ` +
          `inert on every buy. Refusing to start with the trade route configured.`,
      );
    }
  }

  const scanGate = createScanGate({
    dataPlane: deps.dataPlane,
    now: nowMs,
    ttlSec: trade.scanTtlSec,
    requireVerdict: trade.scanRequireVerdict,
    mode: trade.scanMode,
  });

  const app = new Hono();
  const lendingPortfolio = deps.lending?.readers.readPortfolioBalances === undefined ? undefined
    : createLendingPortfolioProjection({
      dataPlane: deps.dataPlane,
      readBalances: (accounts, signal) => deps.lending!.readers.readPortfolioBalances!(accounts, signal),
      now: nowMs,
    });

  async function authorizeHttpRuntime(
    c: Context,
    agentId: string,
    operation: HttpRuntimeOperation,
    params: unknown,
  ): Promise<
    | { readonly kind: "ok"; readonly agent: AgentRecord }
    | { readonly kind: "error"; readonly response: Response }
  > {
    if (runtimeAuth.kind === "disabled") {
      return { kind: "error", response: fail(c, 503, "runtime_auth_unavailable") };
    }

    let claims;
    try {
      claims = verifyRuntimeAssertion({
        header: c.req.header("x-runtime-assertion"),
        config: runtimeAuth,
        operation,
        requestHash: runtimeRequestHash(operation, agentId, params),
        nowSec: nowSec(),
      });
    } catch {
      return { kind: "error", response: fail(c, 401, "runtime_auth_failed") };
    }

    const agent = await deps.agentStore.getAgentById(agentId);
    if (agent === null) {
      return { kind: "error", response: fail(c, 404, "not_found") };
    }
    if (
      claims.agentId !== agentId ||
      claims.owner.toLowerCase() !== agent.ownerAddress.toLowerCase() ||
      claims.executionProfileHash.toLowerCase() !==
        httpRuntimeProfileHash(agent.httpRuntimeProfile).toLowerCase() ||
      !httpRuntimeProfileAllows(agent.httpRuntimeProfile, operation)
    ) {
      return { kind: "error", response: fail(c, 401, "runtime_auth_failed") };
    }

    try {
      const consumed = await deps.runtimeReplayStore!.consume({
        issuer: claims.issuer,
        keyId: claims.keyId,
        nonce: claims.nonce,
        expiry: claims.expiry,
        nowSec: nowSec(),
      });
      if (!consumed) {
        return { kind: "error", response: fail(c, 401, "runtime_auth_failed") };
      }
    } catch {
      return { kind: "error", response: fail(c, 503, "runtime_auth_unavailable") };
    }
    return { kind: "ok", agent };
  }

  /* ---- Layer 0: rate limit, then Layer 1: the service credential --------- */

  app.use("*", async (c, next) => {
    // `/health` is the platform's liveness probe. It is exempt from both the
    // credential and the limiter: a probe that gets 401'd or 429'd looks like an
    // outage and triggers a restart loop.
    if (c.req.path === "/health") return next();

    // Rate limiting comes FIRST because it is the cheapest possible rejection —
    // one map lookup — and because it must stand in front of anything expensive,
    // above all ecrecover on the owner routes.
    if (!sourceLimiter.tryConsume(sourceKey(c))) {
      return fail(c, 429, "rate_limited");
    }

    const expected = config.execToken;
    if (expected === "") {
      // An unset credential is a deployment mistake, not a dev convenience: this
      // service signs transactions. Refuse rather than run open.
      return fail(c, 401, "unauthorized");
    }
    if (!tokenMatches(c.req.header("x-exec-token") ?? "", expected)) {
      return fail(c, 401, "unauthorized");
    }
    return next();
  });

  /* ---- Health and status ------------------------------------------------ */

  app.get("/health", (c) =>
    c.json({
      data: {
        ok: true,
        uptimeSec: Math.floor((nowMs() - startedAt) / 1000),
        // Safe on an unauthenticated probe: it is a build identifier, not a
        // capability, and the route is already private-network only.
        version: EXECUTION_PLANE_VERSION,
      },
    }),
  );

  app.get("/status", async (c) => {
    const [halted, executors, dataPlane] = await Promise.all([
      deps.killswitch.isHalted(),
      deps.agentStore.getExecutorHealth(),
      deps.dataPlane.health(),
    ]);
    return c.json({
      data: {
        startedAt,
        uptimeSec: Math.floor((nowMs() - startedAt) / 1000),
        chainId: config.chainId,
        ...(config.network === undefined ? {} : { network: config.network }),
        halted,
        executors,
        dataPlane: dataPlane === null ? { reachable: false } : { reachable: true },
      },
    });
  });

  /* ---- Account read session + aggregate portfolio ----------------------- */

  if (config.accountReadSession !== undefined) {
    const accountReadSession = config.accountReadSession;
    app.post("/owner-read-session", async (c) => {
      const body = await readJsonBody(c, maxBodyBytes);
      if (body.kind === "error") return body.response;
      const parsed = parseOwnerActionEnvelope(body.value);
      if (!parsed.ok) return fail(c, 401, "owner_auth_failed");
      const envelope = parsed.value;
      if (requireBinding(envelope, "createAccountReadSession", GLOBAL_AGENT_SENTINEL) !== null) {
        return fail(c, 401, "owner_auth_failed");
      }
      const params = envelope.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)
        || Object.keys(params).length !== 0 || Object.getOwnPropertySymbols(params).length !== 0) {
        return fail(c, 401, "owner_auth_failed");
      }
      let owner: OwnerAuthResult;
      try {
        owner = await authorizeOwnerAction(envelope, {
          ...verifyOptions(),
          nonceStore: deps.nonceStore,
          beforeNonceConsume: (verified) => {
            if (!ownerLimiter.tryConsume(verified.ownerAddress.toLowerCase())) {
              throw new OwnerAuthError("owner rate limit exceeded");
            }
          },
        });
      } catch {
        return fail(c, 401, "owner_auth_failed");
      }
      const issued = issueAccountReadSession({
        owner: owner.ownerAddress,
        nowSec: nowSec(),
        signedIssuedAt: envelope.signed.issuedAt,
        signedExpiry: envelope.signed.expiry,
        config: accountReadSession,
      });
      return c.json({ data: { token: issued.token, expiry: issued.expiry } });
    });
  }

  if (config.accountPortfolioWbnb !== undefined) {
    const accountPortfolioWbnb = config.accountPortfolioWbnb;
    app.get("/account/portfolio", async (c) => {
      const auth = await authorizeAccountRead(c, GLOBAL_AGENT_SENTINEL);
      if (auth.kind !== "ok") return auth.response;
      const owner = auth.owner.ownerAddress;
      // DECLARED wallets. A passkey owner's Altana wallet exists and holds
      // funds before any agent is hired onto it, so it appears in no row this
      // plane owns and the read would otherwise report nothing. The caller may
      // name at most two; each is a PUBLIC-CHAIN BALANCE READ for an already
      // authenticated owner and asserts no custody (see
      // `AccountPortfolioOptions`). No new OwnerActionType — the auth on this
      // route is unchanged.
      const declaredWallets: Address[] = [];
      const walletsQuery = c.req.query("wallets");
      if (walletsQuery !== undefined) {
        const parts = walletsQuery.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
        if (parts.length === 0 || parts.length > 2) {
          return fail(c, 400, "invalid_request", "Name at most two wallet addresses.");
        }
        for (const part of parts) {
          let parsed: Address;
          try { parsed = getAddress(part); } catch { return fail(c, 400, "invalid_request", "Each wallet must be a 20-byte address."); }
          declaredWallets.push(parsed);
        }
      }
      const deadline = AbortSignal.timeout(12_000);
      const signal = AbortSignal.any([c.req.raw.signal, deadline]);
      const provider = deps.providerRegistry.get(config.chainId);
      let view;
      try {
        view = await buildAccountPortfolio(owner, {
          agents: deps.agentStore,
          provider,
          dataPlane: deps.dataPlane,
          chainId: config.chainId,
          wbnb: accountPortfolioWbnb,
          ...(deps.lp === undefined ? {} : { lp: {
            store: deps.lp.store,
            observations: deps.lp.observations,
            workerIntervalMs: deps.lp.workerIntervalMs,
          } }),
          ...(deps.keyStoreReader === undefined ? {} : { keyStoreReader: deps.keyStoreReader }),
          ...(deps.balanceReader === undefined ? {} : { balanceReader: deps.balanceReader }),
          now: nowMs,
        }, { declaredWallets }, signal);
      } catch (cause) {
        // The ONE declared-wallet verdict that refuses: the KeyStore answered,
        // and the address is registered to a key that does not derive this
        // owner. Every other verdict rides on the entry as `passkeyVerified`.
        if (cause instanceof DeclaredWalletNotOwnedError) {
          return fail(c, 400, "invalid_request", "A declared wallet is registered to a different owner key.");
        }
        throw cause;
      }
      const payload = JSON.stringify({ data: view });
      if (Buffer.byteLength(payload, "utf8") > 262_144) {
        return fail(c, 503, "internal_error");
      }
      return c.body(payload, 200, { "content-type": "application/json; charset=UTF-8", "cache-control": "private, no-store" });
    });
  }

  /* ---- Runtime read: service credential only ---------------------------- */

  app.get("/agents/:id", async (c) => {
    const id = c.req.param("id");
    if (id.length === 0 || id.length > MAX_AGENT_ID_CHARS) {
      return fail(c, 404, "not_found");
    }
    const auth = await authorizeHttpRuntime(c, id, "agentRead", {});
    if (auth.kind === "error") return auth.response;
    return c.json({ data: agentRuntimeView(auth.agent) });
  });

  /* ---- Owner reads: service credential + owner signature ---------------- */

  app.get("/agents", async (c) => {
    const auth = await authorizeRead(c, GLOBAL_AGENT_SENTINEL);
    if (auth.kind !== "ok") return auth.response;

    const agents = await deps.agentStore.listAgents(auth.owner.ownerAddress);
    // NO live meter here, deliberately (PHASE2.5 F4): this would be one chain
    // read PER AGENT on a list route, and one slow node would make the whole
    // dashboard hang. The single-agent view carries it; `nativeMeter` is absent
    // here rather than rendered as healthy.
    return c.json({
      data: agents.map((agent) => agentOwnerView(agent)),
      meta: { total: agents.length },
    });
  });

  app.get("/agents/:id/owner-view", async (c) => {
    const id = c.req.param("id");
    const auth = await authorizeAccountRead(c, id);
    if (auth.kind !== "ok") return auth.response;

    const agent = await deps.agentStore.getAgent(auth.owner.ownerAddress, id);
    // Unknown agent and someone else's agent are the SAME response.
    if (agent === null) return fail(c, 404, "not_found");
    // The client's signal, threaded (PHASE2.5-FIXREVIEW F1): an owner who closed
    // the dashboard tab should not leave a chain read running, and the parameter
    // was dead until this call passed one.
    const nativeMeter = await readOwnerNativeMeter(agent, c.req.raw.signal);
    // Add display-only portfolio facts here, not to the worker's decision
    // snapshot or lending/view's deliberately zero-chain-read route.
    let portfolio;
    if (agent.sessionFacts?.hireSizing?.name === "lending-v1" && deps.lending !== undefined) {
      try {
        const guard = await deps.lending.guards.get(agent.ownerAddress, agent.id);
        if (guard !== null) {
          portfolio = lendingPortfolio === undefined
            ? unavailableLendingPortfolio("Portfolio reader is unavailable.")
            : await lendingPortfolio([guard.guardedAccount, agent.walletAddress], c.req.raw.signal);
        }
      } catch { portfolio = unavailableLendingPortfolio("Current Venus portfolio data is unavailable."); }
    }
    return c.json({
      data: {
        ...(nativeMeter === undefined
          ? agentOwnerView(agent)
          : agentOwnerView(agent, nativeMeter)),
        ...(portfolio === undefined ? {} : { lendingPortfolio: portfolio }),
      },
    });
  });

  if (config.hireEnabled === true) {
    const hire = deps.hire!;
    const convergenceCache = new Map<string, { readonly at: number; readonly value: Awaited<ReturnType<typeof convergeProvisioning>> }>();
    const sessionRegistrationCache = new Map<string, {
      readonly at: number;
      readonly rowVersion: number;
      readonly value: SessionRegistrationVerdict;
    }>();
    const WALLET_CONVERGENCE_BUDGET_MS = 12_000;
    const WALLET_CONVERGENCE_READS = 4;

    function blockerKind(agent: AgentRecord): "Grid Agent" | "LP Agent" | "Trading Agent" | "Lending Agent" | "Agent" {
      const sizing = agent.pendingGrant?.sizing.sizingPreset ?? agent.sessionFacts?.hireSizing?.name;
      if (sizing === "grid-v1" || sizing === "grid-shift-v1") return "Grid Agent";
      if (sizing === "lp-v1") return "LP Agent";
      if (sizing === "trade-v1") return "Trading Agent";
      // R2.16 / R3.13: the guard is one more agent under the existing
      // one-live-passkey-agent-per-wallet rule, so it needs its own label on
      // BOTH sides of the message — as the blocker and as the thing being
      // deployed.
      if (sizing === "lending-v1") return "Lending Agent";
      return "Agent";
    }

    function walletBlockerMessage(
      agent: AgentRecord,
      deployingLabel: "Grid Agent" | "LP Agent" | "Trading Agent" | "Lending Agent" | "Agent" = blockerKind(agent),
    ): string {
      const label = blockerKind(agent);
      if (agent.status === "revoked") {
        return `Finish removing ${label} "${agent.id}" before deploying ${deployingLabel}.`;
      }
      if (agent.status === "provisioning") {
        const expiry = agent.pendingGrant?.expiresAt;
        const expiryMs = expiry === undefined ? null : expiry * 1_000;
        const suffix = expiry !== undefined && expiryMs !== null
          && Number.isSafeInteger(expiry) && expiry > 0 && Number.isSafeInteger(expiryMs)
          ? ` until ${new Date(expiryMs).toISOString()}`
          : "";
        return `${label} "${agent.id}" still has an unfinished session setup${suffix}. Cancel or finish that setup before deploying ${deployingLabel}.`;
      }
      return `Remove ${label} "${agent.id}" before deploying ${deployingLabel}.`;
    }

    /**
     * Converge only public, finalized revocation facts before a replacement S1.
     * Historical provisioning drafts are deliberately untouched: old Grid
     * clients had no grant-attempt checkpoint, so local absence is not proof
     * that a relay intent cannot still land.
     */
    async function convergeRevokedWalletOccupants(input: {
      readonly ownerAddress: Address;
      readonly walletAddress: Address;
      readonly requestSignal: AbortSignal;
    }): Promise<
      | { readonly kind: "clear"; readonly deadlineAt: number; readonly signal: AbortSignal }
      | { readonly kind: "blocked"; readonly message: string }
    > {
      const deadlineAt = nowMs() + WALLET_CONVERGENCE_BUDGET_MS;
      const timeout = AbortSignal.timeout(WALLET_CONVERGENCE_BUDGET_MS);
      const cancelled = new AbortController();
      const signal = AbortSignal.any([input.requestSignal, timeout, cancelled.signal]);
      const check = (): void => {
        signal.throwIfAborted();
        if (nowMs() >= deadlineAt) throw new HireEvidenceError();
      };
      const context = { chainId: config.chainId, keyStoreAddress: config.keyStore } as const;
      try {
        check();
        const first = await deps.agentStore.listAgentsBounded(input.ownerAddress, 32, signal);
        check();
        if (first.hasMore) throw new HireEvidenceError();
        const candidates = first.rows.filter((row) => row.custodyModel === "passkey"
          && row.walletAddress.toLowerCase() === input.walletAddress.toLowerCase()
          && row.status === "revoked" && row.sessionFacts !== null
          && !validSessionRevocationProof(row, context, nowMs()));
        const evidence = new Array<Awaited<ReturnType<typeof readFinalizedSessionRevocation>>>(candidates.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(WALLET_CONVERGENCE_READS, candidates.length) }, async () => {
          while (true) {
            check();
            const index = cursor;
            cursor += 1;
            const candidate = candidates[index];
            if (candidate === undefined || candidate.sessionFacts === null) return;
            const result = await readFinalizedSessionRevocation({
              chainId: config.chainId,
              keyStoreAddress: config.keyStore,
              wallet: candidate.walletAddress,
              keyId: keccak256(candidate.sessionFacts.publicKey),
              expectedPublicKey: candidate.sessionFacts.publicKey,
              observedAtMs: nowMs(),
              ...(deps.keyStoreReader === undefined ? {} : { reader: deps.keyStoreReader }),
              signal,
            });
            if (result.kind === "unreadable") throw new HireEvidenceError();
            evidence[index] = result;
          }
        });
        await Promise.all(workers);
        check();
        for (let index = 0; index < candidates.length; index += 1) {
          check();
          const candidate = candidates[index]!;
          const result = evidence[index];
          if (result === undefined || (result.kind !== "missing" && result.kind !== "invalid")) continue;
          const confirmed = await deps.agentStore.confirmSessionRevokedCas({
            ownerAddress: input.ownerAddress,
            agentId: candidate.id,
            expectedRowVersion: candidate.rowVersion,
            expectedPublicKey: candidate.sessionFacts!.publicKey,
            expectedChainId: config.chainId,
            expectedKeyStoreAddress: config.keyStore,
            evidence: result.evidence,
            signal,
          });
          check();
          // A concurrent confirmer is resolved by the bounded final relist below.
          // Avoid an extra unbounded read here: every operation in this path must
          // remain covered by the one request deadline.
          if (confirmed.kind === "conflict") continue;
        }
        check();
        const final = await deps.agentStore.listAgentsBounded(input.ownerAddress, 32, signal);
        check();
        if (final.hasMore) throw new HireEvidenceError();
        const blocker = [...final.rows]
          .filter((row) => row.custodyModel === "passkey"
            && row.walletAddress.toLowerCase() === input.walletAddress.toLowerCase()
            && agentOccupiesWallet(row, context, nowMs()))
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
        check();
        if (blocker !== undefined) {
          cancelled.abort();
          return { kind: "blocked", message: walletBlockerMessage(blocker, "Trading Agent") };
        }
        return { kind: "clear", deadlineAt, signal };
      } catch (error) {
        cancelled.abort();
        if (error instanceof HireEvidenceError) throw error;
        throw new HireEvidenceError();
      }
    }

    /** Exact accepted S1 is a narrow continuation capability, never account auth. */
    async function hireContinuation(
      id: string,
      rawEnvelope: unknown,
      alreadyParsed = false,
    ): Promise<
      | { readonly kind: "ok"; readonly agent: AgentRecord }
      | { readonly kind: "error"; readonly code: "owner_auth_failed" | "not_found" | "conflict" }
    > {
      const parsed = alreadyParsed
        ? { ok: true as const, value: rawEnvelope as OwnerActionRequest }
        : parseOwnerActionEnvelope(rawEnvelope);
      if (!parsed.ok || requireBinding(parsed.value, "provisionAgent", id) !== null
        || paramsHash(parsed.value.signed.action, parsed.value.params).toLowerCase()
          !== parsed.value.signed.paramsHash.toLowerCase()) {
        return { kind: "error", code: "owner_auth_failed" };
      }
      const params = parseHireParams(parsed.value.params);
      if (!params.ok || (params.value.sizingPreset !== "trade-v1"
        && params.value.sizingPreset !== "lp-v1" && params.value.sizingPreset !== "lending-v1")) {
        return { kind: "error", code: "owner_auth_failed" };
      }
      const agent = await deps.agentStore.getAgentById(id);
      if (agent === null) return { kind: "error", code: "not_found" };
      const actionId = ownerActionIdempotencyKey(parsed.value.signed);
      const durableActionId = agent.pendingGrant?.provisionActionId ?? agent.sessionFacts?.provisionActionId;
      const pending = agent.pendingGrant;
      if (durableActionId?.toLowerCase() !== actionId.toLowerCase()
        || agent.ownerAddress.toLowerCase() !== parsed.value.signed.owner.toLowerCase()) {
        return { kind: "error", code: "conflict" };
      }
      if (params.value.sizingPreset === "trade-v1") {
        const durableRunId = pending?.hireRunId ?? agent.sessionFacts?.hireRunId;
        if (durableRunId !== params.value.hireRunId
          || (pending !== null && (pending.autoGrant !== true
            || pending.initialTradeSettings?.digest.toLowerCase()
              !== tradeSettingsDigest(params.value.settings).toLowerCase()))) {
          return { kind: "error", code: "conflict" };
        }
      } else if (params.value.sizingPreset === "lending-v1") {
        // The lending continuation binds the same three envelope figures the LP
        // one does, PLUS the settings digest carried on `initialLendingHire` —
        // the trade rule, for the same reason: the guard row materialized at
        // convergence is built from those bytes, so a continuation presenting
        // different settings must not be answered as a retry of this hire.
        if (pending !== null && (pending.sizing.sizingPreset !== "lending-v1"
          || pending.sizing.openNativeBudgetWei !== params.value.openNativeBudgetWei.toString(10)
          || pending.sizing.capDayWei !== params.value.capDayWei.toString(10)
          || pending.initialLendingHire?.digest.toLowerCase()
            !== lendingSettingsDigest(params.value.settingsParams).toLowerCase())) {
          return { kind: "error", code: "conflict" };
        }
      } else if (pending !== null && (pending.sizing.sizingPreset !== "lp-v1"
        || pending.sizing.openNativeBudgetWei !== params.value.openNativeBudgetWei.toString(10)
        || pending.sizing.capDayWei !== params.value.capDayWei.toString(10))) {
        return { kind: "error", code: "conflict" };
      }
      return { kind: "ok", agent };
    }

    app.get("/agents/hire/preview", async (c) => {
      let wallet: Address;
      let openNativeBudgetWei: bigint | undefined;
      let capDayWei: bigint | undefined;
      let presetQuery: "grid-v1" | "grid-shift-v1" | "lp-v1" | "trade-v1" | "lending-v1";
      let executionModel: import("./trade/settings.js").TradeExecutionModel | undefined;
      let entryWei: bigint | undefined;
      let maxOpenPositions: number | undefined;
      try {
        wallet = getAddress(c.req.query("walletAddress") ?? "");
        const rawPreset = c.req.query("sizingPreset");
        if (
          rawPreset !== "grid-v1"
          && rawPreset !== "grid-shift-v1"
          && rawPreset !== "lp-v1"
          && rawPreset !== "trade-v1"
          && rawPreset !== "lending-v1"
        ) throw new Error("preset");
        presetQuery = rawPreset;
        if (presetQuery === "trade-v1") {
          const rawCap = c.req.query("capDayWei") ?? "";
          if (!/^\d{1,78}$/u.test(rawCap) || BigInt(rawCap) <= 0n) throw new Error("cap");
          capDayWei = BigInt(rawCap);
          const rawModel = c.req.query("executionModel");
          if (rawModel !== "blue-chip" && rawModel !== "mid-cap" && rawModel !== "degen" && rawModel !== "sigma") throw new Error("model");
          executionModel = rawModel;
          const rawEntry = c.req.query("entryWei") ?? "";
          if (!/^\d{1,78}$/u.test(rawEntry) || BigInt(rawEntry) <= 0n) throw new Error("entry");
          entryWei = BigInt(rawEntry);
          const rawMax = c.req.query("maxOpenPositions") ?? "";
          if (!/^\d{1,2}$/u.test(rawMax) || !Number.isInteger(Number(rawMax))) throw new Error("positions");
          maxOpenPositions = Number(rawMax);
        } else {
          const rawBudget = c.req.query("openNativeBudgetWei") ?? "";
          if (!/^\d{1,78}$/u.test(rawBudget) || BigInt(rawBudget) <= 0n) throw new Error("budget");
          openNativeBudgetWei = BigInt(rawBudget);
        }
      } catch {
        return fail(c, 400, "invalid_request", "Hire preview parameters are invalid.");
      }
      try {
        const observedAtSec = nowSec();
        const [funding, pin] = await Promise.all([
          hire.evidence.readFunding(wallet, hire.grantGasHeadroomWei, observedAtSec, c.req.raw.signal),
          presetQuery === "trade-v1" && executionModel !== undefined
            ? cachedPin(executionModel, wallet, c.req.raw.signal)
            : Promise.resolve(undefined),
        ]);
        // MARKETPLACE-LENDING-AGENT R2.15: the lending deposit is
        // `budget + registration + headroom + 3 x relayFee` — the
        // `requiredTradeDepositWei` SHAPE, with no `reserves.totalWei`, because
        // lending has no LP exit/protect lanes to reserve for. The FUNDING half
        // is what the browser needs here; the sizing floors come from
        // `/lending/guardable` in receipt mode, which is the only place they
        // can be quoted.
        const sizing = presetQuery === "trade-v1"
          ? hireSizingPreview({
              capDayWei: capDayWei!, executionModel: executionModel!, entryWei: entryWei!,
              maxOpenPositions: maxOpenPositions!, grantedTokenCount: pin?.length ?? 0,
              feeBps: hire.feeBps, relayFeePerSubmitWei: hire.relayFeePerSubmitWei,
              sizingPreset: "trade-v1",
            })
          : presetQuery === "lending-v1"
            ? {
                name: "lending-v1" as const,
                version: 1 as const,
                openNativeBudgetWei: openNativeBudgetWei!.toString(10),
                relayFeePerSubmitWei: RELAY_FEE_PER_EXIT_WEI.toString(10),
                armSubmissionPad: 3,
                note:
                  "The USDT day-cap floor and the minimum native cap are quoted by "
                  + "GET /lending/guardable in receipt mode; they need a live pool quote, "
                  + "which this preview deliberately does not take.",
              }
            : hireSizingPreview({ openNativeBudgetWei: openNativeBudgetWei!, feeBps: hire.feeBps,
                relayFeePerSubmitWei: hire.relayFeePerSubmitWei, sizingPreset: presetQuery });
        let responseCapDayWei: string;
        if (presetQuery === "trade-v1") {
          responseCapDayWei = capDayWei!.toString(10);
        } else if (presetQuery === "lending-v1") {
          // The lending cap is a SIGNED field derived from the receipt, not a
          // figure this route can compute; answering a number here would look
          // like a recommendation nobody sized.
          responseCapDayWei = "0";
        } else {
          if (!("minimumCapDayWei" in sizing)) throw new Error("Grid hire preview shape mismatch.");
          responseCapDayWei = sizing.minimumCapDayWei;
        }
        return c.json({ data: { sizing, funding, capDayWei: responseCapDayWei,
          ...(pin === undefined ? {} : { pin: pin.map(({ symbol, address }) => ({ symbol, address })), indicative: true }) } });
      } catch (error) {
        if (error instanceof TradeNotReadyError) return fail(c, 503, "trade_not_ready");
        if (error instanceof ModelUnavailableError) return fail(c, 400, "model_unavailable");
        if (error instanceof PinTooSmallError) return fail(c, 400, "universe_too_small");
        return fail(c, 503, "evidence_unreadable");
      }
    });

    app.post("/agents/:id/session", async (c) => {
      const id = c.req.param("id");
      const body = await readJsonBody(c, maxBodyBytes);
      if (body.kind === "error") return body.response;
      const parsedEnvelope = parseOwnerActionEnvelope(body.value);
      if (!parsedEnvelope.ok || requireBinding(parsedEnvelope.value, "provisionAgent", id) !== null) {
        return fail(c, 401, "owner_auth_failed");
      }
      const ownerAction = parsedEnvelope.value;
      const provisionActionId = ownerActionIdempotencyKey(ownerAction.signed);

      const earlyParams = parseHireParams(ownerAction.params);
      if (earlyParams.ok && earlyParams.value.sizingPreset === "trade-v1") {
        let classified;
        try {
          classified = await classifyOwnerActionTime(ownerAction, verifyOptions());
        } catch (error) {
          if (error instanceof OwnerAuthError) return fail(c, 401, "owner_auth_failed");
          throw error;
        }
        const tradeParams = earlyParams.value;
        const owner = classified.ownerAddress;
        const actionId = provisionActionId.toLowerCase();
        const exactRow = (row: AgentRecord | null): row is AgentRecord => {
          if (row === null || row.ownerAddress.toLowerCase() !== owner.toLowerCase()) return false;
          const durableAction = row.pendingGrant?.provisionActionId ?? row.sessionFacts?.provisionActionId;
          const durableRun = row.pendingGrant?.hireRunId ?? row.sessionFacts?.hireRunId;
          return durableAction?.toLowerCase() === actionId && durableRun === tradeParams.hireRunId
            && (row.pendingGrant === null || (row.pendingGrant.autoGrant === true
              && row.pendingGrant.initialTradeSettings?.digest.toLowerCase()
                === tradeSettingsDigest(tradeParams.settings).toLowerCase()));
        };

        try {
          return await deps.nonceStore.withProvisionClaimLock(owner, ownerAction.signed.nonce, async (lease) => {
          const claimState = await lease.read();
          const prior = await deps.journal.get(provisionActionId);
          const existing = await deps.agentStore.getAgentById(id);

          if (prior !== null || exactRow(existing)) {
            if (!exactRow(existing) || (prior !== null
              && (prior.agentId !== id || prior.ownerAddress.toLowerCase() !== owner.toLowerCase()))) {
              return fail(c, 409, "conflict");
            }
            if (claimState.kind === "provision"
              && claimState.claim.actionId.toLowerCase() !== actionId) return fail(c, 409, "conflict");
            if (claimState.kind === "absent") {
              const expiresAtSec = existing.pendingGrant?.expiresAt ?? existing.sessionFacts?.expiry;
              const acceptedAtMs = existing.pendingGrant === null ? existing.createdAt : existing.pendingGrant.createdAtSec * 1_000;
              if (expiresAtSec !== undefined) {
                await lease.insert({ actionId: provisionActionId, state: "committed", acceptedAtMs,
                  authorityExpiresAtMs: expiresAtSec * 1_000 });
              }
            } else if (claimState.kind === "provision" && claimState.claim.state === "live") {
              await lease.transition(provisionActionId, "live", "committed");
            }
            if (prior === null) {
              await deps.journal.begin({ idempotencyKey: provisionActionId, agentId: existing.id,
                ownerAddress: existing.ownerAddress, kind: "agentProvision",
                ...(existing.sessionFacts?.publicKey === undefined && existing.pendingGrant === null ? {}
                  : { externalRef: { publicKey: existing.pendingGrant?.sessionPublicKey ?? existing.sessionFacts!.publicKey } }) });
            }
            await deps.journal.markCommitted(provisionActionId);
            return c.json({ data: provisioningView(existing, nowSec()), meta: { durable: deps.agentStore.durable, replayed: true, repaired: prior === null } });
          }

          if (existing !== null) return fail(c, 409, "agent_exists");
          if (claimState.kind === "plain") return fail(c, 409, "s1_ambiguous");
          if (claimState.kind === "provision") {
            if (claimState.claim.actionId.toLowerCase() !== actionId) return fail(c, 409, "conflict");
            if (claimState.claim.state === "terminal") return fail(c, 410, "hire_no_evidence");
            if (claimState.claim.state === "committed") return fail(c, 503, "evidence_unreadable");
          }

          if (claimState.kind === "absent" && classified.time !== "fresh") {
            if (classified.time === "not-yet-valid") return fail(c, 401, "owner_auth_failed");
            // Signed expiry is whole seconds and remains valid for that entire
            // second. Retain the tombstone through its final millisecond so a
            // delayed pre-expiry request cannot materialize 999 ms too late.
            const terminalUntilBig = (ownerAction.signed.expiry + BigInt(tradeParams.ttlSec)) * 1_000n + 999n;
            if (terminalUntilBig > BigInt(Number.MAX_SAFE_INTEGER)) return fail(c, 401, "owner_auth_failed");
            await lease.insert({ actionId: provisionActionId, state: "terminal", acceptedAtMs: null,
              authorityExpiresAtMs: Number(terminalUntilBig) });
            return fail(c, 410, "hire_no_evidence");
          }

          let acceptedAtMs: number;
          let authorityExpiresAtMs: number;
          if (claimState.kind === "absent") {
            try {
              await verifyOwnerAction(ownerAction, verifyOptions());
            } catch (error) {
              if (error instanceof OwnerAuthError) return fail(c, 401, "owner_auth_failed");
              throw error;
            }
            if (!ownerLimiter.tryConsume(owner.toLowerCase())) return fail(c, 429, "rate_limited");
            acceptedAtMs = nowMs();
            authorityExpiresAtMs = acceptedAtMs + tradeParams.ttlSec * 1_000;
          } else {
            if (claimState.kind !== "provision" || claimState.claim.acceptedAtMs === null) {
              return fail(c, 409, "conflict");
            }
            acceptedAtMs = claimState.claim.acceptedAtMs;
            authorityExpiresAtMs = claimState.claim.authorityExpiresAtMs;
          }

          const observedAtSec = nowSec();
          if (nowMs() >= authorityExpiresAtMs) {
            if (claimState.kind === "provision") {
              await lease.transition(provisionActionId, "live", "terminal");
            } else {
              await lease.insert({ actionId: provisionActionId, state: "terminal", acceptedAtMs: null,
                authorityExpiresAtMs });
            }
            return fail(c, 410, "hire_no_evidence");
          }
          if (deps.tradeAgent === undefined || !deps.tradeAgent.readiness.ready) return fail(c, 503, "trade_not_ready");
          if (tradeParams.executionModel === "mid-cap" && !deps.tradeAgent.readiness.allowlistAvailable) {
            return fail(c, 400, "model_unavailable");
          }

          let ownerVerdict;
          let funding;
          let pinned;
          try {
            [ownerVerdict, funding, pinned] = await Promise.all([
              verifyDeclaredWallet({ owner, wallet: tradeParams.walletAddress,
                reader: deps.keyStoreReader, signal: c.req.raw.signal }),
              hire.evidence.readFunding(tradeParams.walletAddress, hire.grantGasHeadroomWei, observedAtSec, c.req.raw.signal),
              cachedPin(tradeParams.executionModel, tradeParams.walletAddress, c.req.raw.signal),
            ]);
          } catch (error) {
            if (error instanceof TradeNotReadyError || error instanceof ModelUnavailableError
              || error instanceof PinTooSmallError || error instanceof PinUnreadableError) throw error;
            return fail(c, 503, "evidence_unreadable");
          }
          if (ownerVerdict === "unreadable") return fail(c, 503, "evidence_unreadable");
          if (ownerVerdict === "no-matching-key") return fail(c, 403, "wallet_owner_mismatch");
          const sized = checkTradeSizing({ capDayWei: tradeParams.capDayWei,
            entryWei: BigInt(tradeParams.settings.entryWei),
            maxOpenPositions: tradeParams.settings.maxOpenPositions,
            grantedTokenCount: pinned.length, platformFeeBps: hire.feeBps });
          if (!sized.ok) return fail(c, 400, "capital_too_small",
            `Total capital must be at least ${formatEther(sized.minimumCapWei)} BNB.`);

          const occupancy = await convergeRevokedWalletOccupants({
            ownerAddress: owner,
            walletAddress: tradeParams.walletAddress,
            requestSignal: c.req.raw.signal,
          });
          if (occupancy.kind === "blocked") {
            return fail(c, 409, "wallet_in_use", occupancy.message);
          }
          const ensureConvergenceActive = (): void => {
            try {
              occupancy.signal.throwIfAborted();
            } catch {
              throw new HireEvidenceError();
            }
            if (nowMs() >= occupancy.deadlineAt) throw new HireEvidenceError();
          };

          if (claimState.kind === "absent") {
            ensureConvergenceActive();
            let inserted: boolean;
            try {
              inserted = await lease.insert({ actionId: provisionActionId, state: "live", acceptedAtMs,
                authorityExpiresAtMs }, occupancy.signal);
            } catch {
              throw new HireEvidenceError();
            }
            ensureConvergenceActive();
            if (!inserted) return fail(c, 409, "s1_ambiguous");
          }
          ensureConvergenceActive();
          if (nowMs() >= authorityExpiresAtMs) {
            await lease.transition(provisionActionId, "live", "terminal");
            return fail(c, 410, "hire_no_evidence");
          }

          const sessionKey = generatePrivateKey();
          const sessionAccount = privateKeyToAccount(sessionKey);
          const sessionPublicKey = sessionAccount.publicKey;
          const sessionAddress = sessionAccount.address;
          if (getAddress(publicKeyToAddress(sessionPublicKey)) !== getAddress(sessionAddress)) {
            return fail(c, 503, "evidence_unreadable");
          }
          const expiresAt = Math.floor(authorityExpiresAtMs / 1_000);
          const sessionSpec = tradeSessionSpec({ venues: trade.venues,
            ...(trade.feeTreasury === undefined ? {} : { treasury: trade.feeTreasury }),
            tokens: pinned.map(({ address }) => ({ token: address })),
            nativeCaps: [{ limit: tradeParams.capDayWei, period: "day" }], expiresAt, nowSeconds: observedAtSec });
          const nativeCaps = sessionSpec.spendCaps.filter((cap) => cap.token === undefined && cap.period === "day");
          if (nativeCaps.length !== 1) return fail(c, 503, "evidence_unreadable");
          let permissions;
          try {
            permissions = validateSessionSpec(sessionSpec, { nowSeconds: observedAtSec,
              walletAddress: tradeParams.walletAddress, keyStoreAddress: config.keyStore });
          } catch {
            return fail(c, 503, "evidence_unreadable");
          }
          const pending: PendingGrant = {
            version: 1, recoveredOwner: owner, walletAddress: tradeParams.walletAddress,
            sessionAddress, sessionPublicKey, accountKeyHash: accountKeyHashForAddress(sessionAddress),
            keyStoreKeyId: keccak256(sessionPublicKey), sessionSpec, permissions,
            grantDigest: grantDigest({ permissions, expiresAt, walletAddress: tradeParams.walletAddress, sessionAddress }),
            expiresAt, sizing: { openNativeBudgetWei: "0", capDayWei: tradeParams.capDayWei.toString(10),
              sizingPreset: "trade-v1", sizingPresetVersion: 1 }, funding,
            createdAtSec: Math.floor(acceptedAtMs / 1_000), keyStoreVerdictAtS1: ownerVerdict,
            provisionActionId, hireRunId: tradeParams.hireRunId, autoGrant: true,
            initialTradeSettings: { params: tradeParams.settings, digest: tradeSettingsDigest(tradeParams.settings) },
          };
          let row: AgentRecord;
          try {
            ensureConvergenceActive();
            row = await deps.agentStore.createProvisioningAgent({ record: {
              id, ownerAddress: owner, walletAddress: tradeParams.walletAddress, custodyModel: "passkey",
              caps: { dailyNativeWei: tradeParams.capDayWei,
                perTradeNativeWei: BigInt(tradeParams.settings.entryWei) }, httpRuntimeProfile: "unbound-v1",
            }, pendingGrant: pending, sessionKey, signal: occupancy.signal });
          } catch (error) {
            if (occupancy.signal.aborted || nowMs() >= occupancy.deadlineAt) throw new HireEvidenceError();
            if (error instanceof AgentWalletInUseError) {
              ensureConvergenceActive();
              const current = await deps.agentStore.listAgentsBounded(owner, 32, occupancy.signal);
              ensureConvergenceActive();
              if (current.hasMore) throw new HireEvidenceError();
              const blocker = current.rows.find((candidate) => candidate.id === error.agentId)
                ?? [...current.rows]
                  .filter((candidate) => candidate.custodyModel === "passkey"
                    && candidate.walletAddress.toLowerCase() === tradeParams.walletAddress.toLowerCase()
                    && agentOccupiesWallet(candidate, {
                      chainId: config.chainId,
                      keyStoreAddress: config.keyStore,
                    }, nowMs()))
                  .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
              return fail(c, 409, "wallet_in_use", blocker === undefined
                ? "Remove the existing agent before deploying Trading Agent."
                : walletBlockerMessage(blocker, "Trading Agent"));
            }
            if (!(error instanceof AgentExistsError)) throw error;
            const joined = await deps.agentStore.getAgentById(id);
            if (!exactRow(joined)) return fail(c, 409, "agent_exists");
            row = joined;
          }
          try {
            await deps.journal.begin({ idempotencyKey: provisionActionId, agentId: row.id,
              ownerAddress: row.ownerAddress, kind: "agentProvision",
              externalRef: { publicKey: row.pendingGrant?.sessionPublicKey ?? row.sessionFacts!.publicKey } });
            await deps.journal.markCommitted(provisionActionId);
          } catch {
            return fail(c, 503, "evidence_unreadable");
          }
          await lease.transition(provisionActionId, "live", "committed");
          return c.json({ data: provisioningView(row, nowSec()), meta: { durable: deps.agentStore.durable } });
          });
        } catch (error) {
          if (error instanceof TradeNotReadyError) return fail(c, 503, "trade_not_ready");
          if (error instanceof PinUnreadableError) return fail(c, 503, "evidence_unreadable");
          if (error instanceof PinTooSmallError) return fail(c, 400, "universe_too_small");
          if (error instanceof ModelUnavailableError) return fail(c, 400, "model_unavailable");
          if (error instanceof HireEvidenceError) return fail(c, 503, "evidence_unreadable");
          throw error;
        }
      }

      const prior = await deps.journal.get(provisionActionId);
      if (prior !== null) {
        const row = await deps.agentStore.getAgent(getAddress(prior.ownerAddress), prior.agentId);
        if (row === null || row.id !== id) return fail(c, 503, "evidence_unreadable");
        return c.json({ data: provisioningView(row, nowSec()), meta: { durable: deps.agentStore.durable, replayed: true } });
      }

      const partial = await deps.agentStore.getAgentById(id);
      const partialProvisionActionId = partial?.pendingGrant?.provisionActionId ?? partial?.sessionFacts?.provisionActionId;
      if (partial !== null && partialProvisionActionId?.toLowerCase() === provisionActionId.toLowerCase()) {
        try {
          const verified = await verifyOwnerAction(ownerAction, verifyOptions());
          if (verified.ownerAddress.toLowerCase() !== partial.ownerAddress.toLowerCase()) {
            return fail(c, 401, "owner_auth_failed");
          }
          await deps.journal.begin({
            idempotencyKey: provisionActionId,
            agentId: partial.id,
            ownerAddress: partial.ownerAddress,
            kind: "agentProvision",
            ...(partial.sessionFacts?.publicKey === undefined && partial.pendingGrant === null
              ? {}
              : { externalRef: { publicKey: partial.pendingGrant?.sessionPublicKey ?? partial.sessionFacts!.publicKey } }),
          });
          await deps.journal.markCommitted(provisionActionId);
          return c.json({ data: provisioningView(partial, nowSec()), meta: { durable: deps.agentStore.durable, replayed: true, repaired: true } });
        } catch {
          return fail(c, 401, "owner_auth_failed");
        }
      }

      let prepared: { readonly pending: PendingGrant; readonly sessionKey: Hex; readonly params: HireParams } | undefined;
      let rateLimited = false;
      try {
        await authorizeOwnerAction(ownerAction, {
          ...verifyOptions(),
          nonceStore: deps.nonceStore,
          beforeNonceConsume: async (verified) => {
            if (!ownerLimiter.tryConsume(verified.ownerAddress.toLowerCase())) {
              rateLimited = true;
              throw new OwnerAuthError("Per-owner rate limit exceeded.");
            }
            if (await deps.agentStore.getAgentById(id) !== null) throw new HireAgentExistsError();
            const params = parseHireParams(ownerAction.params);
            if (!params.ok) throw new BadRequestError(params.message);
            const observedAtSec = nowSec();
            if (params.value.sizingPreset === "trade-v1") {
              const tradeParams = params.value;
              if (deps.tradeAgent === undefined || !deps.tradeAgent.readiness.ready) throw new TradeNotReadyError();
              if (tradeParams.executionModel === "mid-cap" && !deps.tradeAgent.readiness.allowlistAvailable) {
                throw new ModelUnavailableError(tradeParams.executionModel);
              }
              const [ownerVerdict, funding, pinned] = await Promise.all([
                verifyDeclaredWallet({ owner: verified.ownerAddress, wallet: tradeParams.walletAddress,
                  reader: deps.keyStoreReader, signal: c.req.raw.signal }),
                hire.evidence.readFunding(tradeParams.walletAddress, hire.grantGasHeadroomWei, observedAtSec, c.req.raw.signal),
                cachedPin(tradeParams.executionModel, tradeParams.walletAddress, c.req.raw.signal),
              ]).catch((error: unknown) => {
                if (error instanceof TradeNotReadyError || error instanceof ModelUnavailableError
                  || error instanceof PinTooSmallError || error instanceof PinUnreadableError) throw error;
                throw new HireEvidenceError();
              });
              if (ownerVerdict === "unreadable") throw new HireEvidenceError();
              if (ownerVerdict === "no-matching-key") throw new HireWalletOwnerError();
              const sized = checkTradeSizing({ capDayWei: tradeParams.capDayWei,
                entryWei: BigInt(tradeParams.settings.entryWei),
                maxOpenPositions: tradeParams.settings.maxOpenPositions,
                grantedTokenCount: pinned.length, platformFeeBps: hire.feeBps });
              if (!sized.ok) throw new TradeCapitalTooSmallError(sized.minimumCapWei);

              const sessionKey = generatePrivateKey();
              const sessionAccount = privateKeyToAccount(sessionKey);
              const sessionPublicKey = sessionAccount.publicKey;
              const sessionAddress = sessionAccount.address;
              if (getAddress(publicKeyToAddress(sessionPublicKey)) !== getAddress(sessionAddress)) throw new HireEvidenceError();
              const expiresAt = observedAtSec + tradeParams.ttlSec;
              const sessionSpec = tradeSessionSpec({ venues: trade.venues,
                ...(trade.feeTreasury === undefined ? {} : { treasury: trade.feeTreasury }),
                tokens: pinned.map(({ address }) => ({ token: address })),
                nativeCaps: [{ limit: tradeParams.capDayWei, period: "day" }],
                expiresAt, nowSeconds: observedAtSec });
              const nativeCaps = sessionSpec.spendCaps.filter((cap) => cap.token === undefined && cap.period === "day");
              if (nativeCaps.length !== 1) throw new HireEvidenceError();
              const permissions = validateSessionSpec(sessionSpec, { nowSeconds: observedAtSec,
                walletAddress: tradeParams.walletAddress, keyStoreAddress: config.keyStore });
              const pending: PendingGrant = {
                version: 1, recoveredOwner: verified.ownerAddress, walletAddress: tradeParams.walletAddress,
                sessionAddress, sessionPublicKey, accountKeyHash: accountKeyHashForAddress(sessionAddress),
                keyStoreKeyId: keccak256(sessionPublicKey), sessionSpec, permissions,
                grantDigest: grantDigest({ permissions, expiresAt, walletAddress: tradeParams.walletAddress, sessionAddress }),
                expiresAt, sizing: { openNativeBudgetWei: "0", capDayWei: tradeParams.capDayWei.toString(10),
                  sizingPreset: "trade-v1", sizingPresetVersion: 1 }, funding, createdAtSec: observedAtSec,
                keyStoreVerdictAtS1: ownerVerdict, provisionActionId,
                hireRunId: tradeParams.hireRunId, autoGrant: true,
                initialTradeSettings: {
                  params: tradeParams.settings,
                  digest: tradeSettingsDigest(tradeParams.settings),
                },
              };
              prepared = { pending, sessionKey, params: tradeParams };
              return;
            }
            if (params.value.sizingPreset === "lending-v1") {
              const lendingParams: LendingHireParams = params.value;
              const lending = deps.lending;
              if (lending === undefined) {
                throw new BadRequestError(
                  "The lending guard is not enabled on this deployment.",
                );
              }
              // R3.8, FAIL-CLOSED. No secret ⇒ no receipt can be verified ⇒ the
              // hire refuses rather than trusting an unbound preview.
              if (lending.previewSecret === null) {
                throw new BadRequestError(
                  "preview-receipt-unavailable: this deployment cannot verify a guardable preview, so it will not accept a hire sized against one.",
                );
              }
              if (
                lendingParams.token.toLowerCase()
                !== lending.venue.usdt.toLowerCase()
              ) {
                throw new BadRequestError(
                  `"token" must be the reserve asset ${lending.venue.usdt}, derived at boot from vUSDT.underlying().`,
                );
              }
              for (const market of lendingParams.debtMarkets) {
                const known =
                  market.toLowerCase() === lending.venue.vUsdt.toLowerCase()
                  || market.toLowerCase() === lending.venue.vBnb.toLowerCase();
                if (!known) {
                  throw new BadRequestError(
                    `"debtMarkets" names ${market}, which is not a v1 guarded market (vUSDT or vBNB).`,
                  );
                }
              }

              // ═══ THE RECEIPT (R2.10, R3.3(b)) ═════════════════════════════
              //
              // It binds the ACCOUNT, the block its position was read at,
              // guardability, the debts, AND every sizing input — so a receipt
              // taken for one budget cannot be presented here for another
              // against a floor S1 has no quote of its own to recompute.
              const claims = verifyLendingPreviewReceipt(
                lendingParams.previewReceipt, lending.previewSecret, observedAtSec,
              );
              if (claims === null) {
                throw new BadRequestError(
                  "The guardable preview receipt is missing, malformed or older than 30 seconds. Re-read the guarded account and sign again.",
                );
              }
              if (
                claims.account.toLowerCase()
                !== lendingParams.guardedAccount.toLowerCase()
              ) {
                throw new BadRequestError(
                  "The preview receipt was issued for a different guarded account.",
                );
              }
              if (!claims.guardable) {
                throw new BadRequestError(
                  "The preview says this account cannot be guarded; the hire is refused before any nonce is consumed.",
                );
              }
              const signedUsdtCeiling =
                lendingParams.settings.maxPerAction.find(
                  (cap) =>
                    cap.token !== null
                    && cap.token.toLowerCase() === lending.venue.usdt.toLowerCase(),
                )?.maxWei ?? 0n;
              if (
                claims.budgetWei !== lendingParams.openNativeBudgetWei.toString(10)
                || claims.reserveBps !== lendingParams.reserveBps
                || claims.rescueReserveCount !== lendingParams.settings.rescueReserveCount
                || claims.maxPerActionUsdtWei !== signedUsdtCeiling.toString(10)
              ) {
                throw new BadRequestError(
                  "The signed hire does not match the sizing inputs the preview receipt was issued for. Re-read the preview with the values you intend to sign.",
                );
              }
              const previewDebts = new Set(
                claims.debts.map((debt) => debt.vToken.toLowerCase()),
              );
              for (const market of lendingParams.debtMarkets) {
                if (!previewDebts.has(market.toLowerCase())) {
                  throw new BadRequestError(
                    `"debtMarkets" names ${market}, which carried no debt in the preview. A guard pinned to a market with nothing to repay grants authority it cannot use.`,
                  );
                }
              }

              // ═══ EXACTLY THREE BOUNDED READS (R2.10, corrected by L1) ═════
              const [ownerVerdict, funding, facts] = await Promise.all([
                verifyDeclaredWallet({ owner: verified.ownerAddress,
                  wallet: lendingParams.walletAddress,
                  reader: deps.keyStoreReader, signal: c.req.raw.signal }),
                hire.evidence.readFunding(lendingParams.walletAddress,
                  hire.grantGasHeadroomWei, observedAtSec, c.req.raw.signal),
                lending.readers.readS1Facts(
                  lendingParams.guardedAccount, lendingParams.debtMarkets,
                ),
              ]).catch((error: unknown) => {
                if (error instanceof LendingAccountTooComplexError) {
                  throw new BadRequestError(
                    "The guarded account is in more markets than this guard can price.",
                  );
                }
                throw new HireEvidenceError();
              });
              if (ownerVerdict === "unreadable") throw new HireEvidenceError();
              if (ownerVerdict === "no-matching-key") throw new HireWalletOwnerError();
              if (facts.liquidityErrorCode !== 0n) {
                throw new BadRequestError(
                  `protocol-error: the Comptroller returned code ${facts.liquidityErrorCode} for the guarded account; the hire is refused rather than armed against numbers the plane cannot trust.`,
                );
              }
              for (const borrow of facts.borrows) {
                if (borrow.borrowWei === 0n) {
                  throw new BadRequestError(
                    `debt-market-not-held: the guarded account carries no borrow in ${borrow.vToken}. Pin only markets it actually owes in.`,
                  );
                }
              }
              if (facts.borrows.every((borrow) => borrow.borrowWei === 0n)) {
                throw new BadRequestError(
                  "guarded-no-debt: the guarded account owes nothing in any pinned market.",
                );
              }

              // The SIGNED settings, through the SAME check the preview ran —
              // possible only because the receipt binds the two quoted figures
              // the floor is derived from.
              const sized = checkLendingSizing({
                budgetWei: lendingParams.openNativeBudgetWei,
                reserveBps: lendingParams.reserveBps,
                capDayWei: lendingParams.capDayWei,
                reserveCapWei: lendingParams.reserveCapWei,
                mintUsdtWei: BigInt(claims.mintUsdtWei),
                tierBuyBackUsdtWei: BigInt(claims.tierBuyBackUsdtWei),
                rescueReserveCount: lendingParams.settings.rescueReserveCount,
              });
              if (!sized.ok) {
                // AUDIT A-M3: remedy first, figure structured. The check's own
                // prose is 500+ characters and `sanitizeMessage` caps a stored
                // refusal at 280, so the hire used to lose both the number and
                // the remedy to the truncation.
                if (sized.kind === "malformed") throw new BadRequestError(sized.message);
                throw new LpSizingShortfallError(
                  "lending-sizing-short: raise the daily caps you are granting, or lower "
                  + `the budget. Shortfall (wei): ${sized.shortfallWei}`,
                  sized.shortfallWei,
                );
              }

              const sessionKey = generatePrivateKey();
              const sessionAccount = privateKeyToAccount(sessionKey);
              const sessionPublicKey = sessionAccount.publicKey;
              const sessionAddress = sessionAccount.address;
              if (getAddress(publicKeyToAddress(sessionPublicKey)) !== getAddress(sessionAddress)) {
                throw new HireEvidenceError();
              }
              const expiresAt = observedAtSec + lendingParams.ttlSec;
              const guardsVBnb = lendingParams.debtMarkets.some(
                (market) => market.toLowerCase() === lending.venue.vBnb.toLowerCase(),
              );
              const sessionSpec = lendingSessionSpec({
                // A-M2: the boot-read census GATES the grant. Absent only in
                // the offline compositions that inject their own readers.
                ...(lending.routing === undefined ? {} : { routing: lending.routing }),
                vUsdt: lending.venue.vUsdt,
                usdt: lending.venue.usdt,
                // vBNB is granted ONLY when it is a pinned debt market: an
                // ungranted market is one fewer target a leaked key reaches.
                ...(guardsVBnb ? { vBnb: lending.venue.vBnb } : {}),
                routerV3: lending.venue.routerV3,
                treasury: lending.venue.treasury,
                walletAddress: lendingParams.walletAddress,
                keyStoreAddress: config.keyStore,
                nativeCaps: [{ limit: lendingParams.capDayWei, period: "day" }],
                usdtDailyCapWei: lendingParams.reserveCapWei,
                expiresAt,
                nowSeconds: observedAtSec,
              });
              const permissions = validateSessionSpec(sessionSpec, {
                nowSeconds: observedAtSec,
                walletAddress: lendingParams.walletAddress,
                keyStoreAddress: config.keyStore,
              });
              const pending: PendingGrant = {
                version: 1,
                recoveredOwner: verified.ownerAddress,
                walletAddress: lendingParams.walletAddress,
                sessionAddress,
                sessionPublicKey,
                accountKeyHash: accountKeyHashForAddress(sessionAddress),
                keyStoreKeyId: keccak256(sessionPublicKey),
                sessionSpec,
                permissions,
                grantDigest: grantDigest({ permissions, expiresAt,
                  walletAddress: lendingParams.walletAddress, sessionAddress }),
                expiresAt,
                sizing: {
                  openNativeBudgetWei: lendingParams.openNativeBudgetWei.toString(10),
                  capDayWei: lendingParams.capDayWei.toString(10),
                  sizingPreset: "lending-v1",
                  sizingPresetVersion: 1,
                },
                funding,
                createdAtSec: observedAtSec,
                keyStoreVerdictAtS1: ownerVerdict,
                provisionActionId,
                // R3.3(2): the money-authority data rides HERE and is written
                // INSIDE `createProvisioningAgent`'s CAS with the agent row and
                // the sealed key — one statement, no torn write.
                initialLendingHire: {
                  guardedAccount: lendingParams.guardedAccount,
                  debtMarkets: lendingParams.debtMarkets,
                  reserveCapWei: lendingParams.reserveCapWei.toString(10),
                  reserveBps: lendingParams.reserveBps,
                  params: lendingParams.settingsParams,
                  digest: lendingSettingsDigest(lendingParams.settingsParams),
                },
              };
              prepared = { pending, sessionKey, params: lendingParams };
              return;
            }
            const [ownerVerdict, funding] = await Promise.all([
              verifyDeclaredWallet({ owner: verified.ownerAddress, wallet: params.value.walletAddress, reader: deps.keyStoreReader, signal: c.req.raw.signal }),
              hire.evidence.readFunding(params.value.walletAddress, hire.grantGasHeadroomWei, observedAtSec, c.req.raw.signal),
            ]).catch(() => { throw new HireEvidenceError(); });
            if (ownerVerdict === "unreadable") throw new HireEvidenceError();
            if (ownerVerdict === "no-matching-key") throw new HireWalletOwnerError();
            const sized = checkHireSizing({
              capDayWei: params.value.capDayWei,
              openNativeBudgetWei: params.value.openNativeBudgetWei,
              feeBps: hire.feeBps,
              relayFeePerSubmitWei: hire.relayFeePerSubmitWei,
              sizingPreset: params.value.sizingPreset,
            });
            if (!sized.ok) throw new BadRequestError(sized.message);

            const sessionKey = generatePrivateKey();
            const sessionAccount = privateKeyToAccount(sessionKey);
            const sessionPublicKey = sessionAccount.publicKey;
            const sessionAddress = sessionAccount.address;
            if (getAddress(publicKeyToAddress(sessionPublicKey)) !== getAddress(sessionAddress)) {
              throw new HireEvidenceError();
            }
            const expiresAt = observedAtSec + params.value.ttlSec;
            const sessionSpec = lpSessionSpec({
              nfpm: hire.nfpm,
              routerV3: hire.routerV3,
              wbnb: { token: hire.wbnb },
              token: { token: params.value.token },
              treasury: hire.treasury,
              nativeCaps: [{ limit: params.value.capDayWei, period: "day" }],
              expiresAt,
              nowSeconds: observedAtSec,
            });
            const permissions = validateSessionSpec(sessionSpec, {
              nowSeconds: observedAtSec,
              walletAddress: params.value.walletAddress,
              keyStoreAddress: config.keyStore,
            });
            const pending: PendingGrant = {
              version: 1,
              recoveredOwner: verified.ownerAddress,
              walletAddress: params.value.walletAddress,
              sessionAddress,
              sessionPublicKey,
              accountKeyHash: accountKeyHashForAddress(sessionAddress),
              keyStoreKeyId: keccak256(sessionPublicKey),
              sessionSpec,
              permissions,
              grantDigest: grantDigest({ permissions, expiresAt, walletAddress: params.value.walletAddress, sessionAddress }),
              expiresAt,
              sizing: {
                openNativeBudgetWei: params.value.openNativeBudgetWei.toString(10),
                capDayWei: params.value.capDayWei.toString(10),
                sizingPreset: params.value.sizingPreset,
                sizingPresetVersion: 1,
              },
              funding,
              createdAtSec: observedAtSec,
              keyStoreVerdictAtS1: ownerVerdict,
              provisionActionId,
            };
            prepared = { pending, sessionKey, params: params.value };
          },
        });
      } catch (error) {
        if (rateLimited) return fail(c, 429, "rate_limited");
        if (error instanceof HireAgentExistsError) return fail(c, 409, "agent_exists");
        if (error instanceof HireWalletOwnerError) return fail(c, 403, "wallet_owner_mismatch");
        if (error instanceof HireEvidenceError) return fail(c, 503, "evidence_unreadable");
        if (error instanceof TradeNotReadyError) return fail(c, 503, "trade_not_ready");
        if (error instanceof PinUnreadableError) return fail(c, 503, "evidence_unreadable");
        if (error instanceof PinTooSmallError) return fail(c, 400, "universe_too_small");
        if (error instanceof ModelUnavailableError) return fail(c, 400, "model_unavailable");
        if (error instanceof TradeCapitalTooSmallError) {
          return fail(c, 400, "capital_too_small", `Total capital must be at least ${formatEther(error.minimumWei)} BNB.`);
        }
        // AUDIT A-M3: a sizing shortfall carries its figure as STRUCTURED
        // meta, not only as prose the 280-character cap can eat.
        if (error instanceof BadRequestError) return failBadRequest(c, error);
        if (error instanceof OwnerAuthError) return fail(c, 401, "owner_auth_failed");
        throw error;
      }
      if (prepared === undefined) return fail(c, 500, "internal_error");

      let row: AgentRecord;
      try {
        let httpRuntimeProfile: "unbound-v1" | "lp-v1";
        switch (prepared.params.sizingPreset) {
          case "trade-v1":
          // The lending guard has NO HTTP runtime route at all: its money is
          // moved by the worker holding the standing on-chain session, so
          // `unbound-v1` — which grants only `agentRead` — is both correct and
          // the narrowest thing available. The `venus-v1` profile stays what it
          // is for the Phase 4 EOA path.
          case "lending-v1":
            httpRuntimeProfile = "unbound-v1";
            break;
          case "grid-v1":
          case "grid-shift-v1":
          case "lp-v1":
            httpRuntimeProfile = "lp-v1";
            break;
          default:
            throw new Error("Unknown sizingPreset.");
        }
        row = await deps.agentStore.createProvisioningAgent({
          record: {
            id,
            ownerAddress: prepared.pending.recoveredOwner,
            walletAddress: prepared.params.walletAddress,
            custodyModel: "passkey",
            // MARKETPLACE-LENDING-AGENT R2.15 / L6: lending takes `capDayWei`
            // (the trade rule), because the arm's own msg.value AND a full
            // rescue both meter native BEYOND the budget. It is INERT here —
            // no lending path reads `agent.caps` — and it must NEVER become a
            // rescue gate: FINDINGS (ah), "a daily cap that can refuse the last
            // repay before liquidation is a liquidation vector wearing a
            // budget's name".
            caps: { dailyNativeWei: prepared.params.sizingPreset === "trade-v1"
              || prepared.params.sizingPreset === "lending-v1"
              ? prepared.params.capDayWei : prepared.params.openNativeBudgetWei,
              ...(prepared.params.sizingPreset === "trade-v1"
                ? { perTradeNativeWei: BigInt(prepared.params.settings.entryWei) }
                : {}) },
            httpRuntimeProfile,
          },
          pendingGrant: prepared.pending,
          sessionKey: prepared.sessionKey,
        });
      } catch (error) {
        if (error instanceof AgentExistsError) return fail(c, 409, "agent_exists");
        if (error instanceof AgentWalletInUseError) {
          // Match Trading's remedy, but never disclose another owner's agent.
          const blocker = error.agentId === null ? null
            : await deps.agentStore.getAgent(prepared.pending.recoveredOwner, error.agentId);
          // R2.16 / R3.13: the THIRD label. One live passkey agent per wallet
          // is inherited unchanged, so a user already running Grid, LP or
          // Trading on wallet B cannot also hire the guard onto it — and the
          // refusal must name what they were trying to deploy.
          const deploying = prepared.params.sizingPreset === "lp-v1"
            ? "LP Agent"
            : prepared.params.sizingPreset === "lending-v1"
              ? "Lending Agent"
              : "Grid Agent";
          return fail(c, 409, "wallet_in_use", blocker === null
            ? `Remove the existing agent before deploying ${deploying}.`
            : walletBlockerMessage(blocker, deploying));
        }
        throw error;
      }
      try {
        await deps.journal.begin({
          idempotencyKey: provisionActionId,
          agentId: row.id,
          ownerAddress: row.ownerAddress,
          kind: "agentProvision",
          externalRef: { publicKey: prepared.pending.sessionPublicKey },
        });
        await deps.journal.markCommitted(provisionActionId);
      } catch {
        return fail(c, 503, "evidence_unreadable");
      }
      return c.json({ data: provisioningView(row, nowSec()), meta: { durable: deps.agentStore.durable } });
    });

    app.post("/agents/:id/session/grant-attempt", async (c) => {
      const id = c.req.param("id");
      const body = await readJsonBody(c, maxBodyBytes);
      if (body.kind === "error") return body.response;
      const continuation = await hireContinuation(id, body.value);
      if (continuation.kind === "error") {
        return continuation.code === "not_found"
          ? fail(c, 404, "not_found")
          : continuation.code === "conflict"
            ? fail(c, 409, "conflict")
            : fail(c, 401, "owner_auth_failed");
      }
      const pending = continuation.agent.pendingGrant;
      if (continuation.agent.status === "armed") {
        return c.json({ data: { ...provisioningView(continuation.agent, nowSec()), mayInvoke: false } });
      }
      const grantPreset = pending?.sizing.sizingPreset;
      if (continuation.agent.status !== "provisioning" || pending === null
        || (grantPreset !== "trade-v1" && grantPreset !== "lp-v1" && grantPreset !== "lending-v1")
        || (grantPreset === "trade-v1" && pending.autoGrant !== true)
        || pending.cancelRequestedAtSec !== undefined) {
        return fail(c, 409, "conflict");
      }
      const attemptId = keccak256(stringToBytes(canonicalEncode({
        // Namespaced per preset so a captured attempt id from one hire family
        // can never be presented for another.
        purpose: grantPreset === "trade-v1"
          ? "tradeGrantAttempt/v1"
          : grantPreset === "lending-v1"
            ? "lendingGrantAttempt/v1"
            : "lpGrantAttempt/v1",
        provisionActionId: pending.provisionActionId,
        ...(pending.lastGrantAttemptReset === undefined
          ? {}
          : { resetActionId: pending.lastGrantAttemptReset.resetActionId }),
      })));
      const started = await deps.agentStore.startGrantAttemptCas({
        ownerAddress: continuation.agent.ownerAddress,
        agentId: continuation.agent.id,
        expectedGrantDigest: pending.grantDigest,
        attemptId,
        startedAtSec: nowSec(),
      });
      if (started.kind === "conflict" || started.kind === "not_found") return fail(c, 409, "conflict");
      return c.json({ data: {
        ...provisioningView(started.agent, nowSec()),
        attemptId,
        mayInvoke: started.kind === "created",
      } });
    });

    app.post("/agents/:id/session/grant-attempt/reset", async (c) => {
      const id = c.req.param("id");
      const body = await readJsonBody(c, maxBodyBytes);
      if (body.kind === "error") return body.response;
      const envelope = parseOwnerActionEnvelope(body.value);
      if (!envelope.ok || requireBinding(envelope.value, "resetGrantAttempt", id) !== null) {
        return fail(c, 401, "owner_auth_failed");
      }
      const params = envelope.value.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)
        || Object.keys(params).length !== 1 || !("attemptId" in params)
        || typeof params.attemptId !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(params.attemptId)) {
        return fail(c, 400, "invalid_request", "Grant-attempt reset params must contain exactly one bytes32 attemptId.");
      }
      const attemptId = params.attemptId as Hex;
      const resetActionId = ownerActionIdempotencyKey(envelope.value.signed) as Hex;

      const matchesDurableReset = (agent: AgentRecord): boolean =>
        agent.pendingGrant?.lastGrantAttemptReset?.resetActionId.toLowerCase() === resetActionId.toLowerCase()
        && agent.pendingGrant.lastGrantAttemptReset.clearedAttemptId.toLowerCase() === attemptId.toLowerCase();
      const verifiedRow = async (): Promise<AgentRecord | null> => {
        let verified: OwnerAuthResult;
        try {
          verified = await verifyOwnerAction(envelope.value, verifyOptions());
        } catch (error) {
          if (error instanceof OwnerAuthError) return null;
          throw error;
        }
        return deps.agentStore.getAgent(verified.ownerAddress, id);
      };
      const commitResetJournal = async (agent: AgentRecord): Promise<void> => {
        await deps.journal.begin({
          idempotencyKey: resetActionId,
          agentId: agent.id,
          ownerAddress: agent.ownerAddress,
          kind: "grantAttemptReset",
          ...(agent.sessionFacts === null ? {} : { externalRef: { publicKey: agent.sessionFacts.publicKey } }),
        });
        await deps.journal.markCommitted(resetActionId);
      };

      // A journal row can only be replayed after the exact envelope verifies.
      // In particular, the outer params are not trusted merely because their
      // signed struct hashes to a known action id.
      const prior = await deps.journal.get(resetActionId);
      if (prior !== null) {
        if (prior.kind !== "grantAttemptReset" || prior.agentId !== id
          || prior.state === "ROLLED_BACK" || prior.state === "UNKNOWN") {
          return fail(c, 409, "conflict");
        }
        const agent = await verifiedRow();
        if (agent === null || getAddress(prior.ownerAddress) !== getAddress(agent.ownerAddress)) {
          return fail(c, 401, "owner_auth_failed");
        }
        if (!matchesDurableReset(agent)) return fail(c, 409, "conflict");
        await deps.journal.markCommitted(resetActionId);
        return c.json({ data: provisioningView(agent, nowSec()),
          meta: { action: "resetGrantAttempt", agentId: id, replayed: true } });
      }

      // If the CAS landed and the process died before the local-only journal
      // write, the durable reset evidence is the repair authority. The exact
      // envelope is still verified, but its consumed nonce is not re-consumed.
      const repairCandidate = await verifiedRow();
      if (repairCandidate !== null && matchesDurableReset(repairCandidate)) {
        await commitResetJournal(repairCandidate);
        return c.json({ data: provisioningView(repairCandidate, nowSec()),
          meta: { action: "resetGrantAttempt", agentId: id, replayed: true, repaired: true } });
      }

      let owner: OwnerAuthResult;
      let rateLimited = false;
      try {
        owner = await authorizeOwnerAction(envelope.value, {
          ...verifyOptions(),
          nonceStore: deps.nonceStore,
          beforeNonceConsume: (result) => {
            if (!ownerLimiter.tryConsume(result.ownerAddress.toLowerCase())) {
              rateLimited = true;
              throw new OwnerAuthError("Per-owner rate limit exceeded.");
            }
          },
        });
      } catch (error) {
        if (rateLimited) return fail(c, 429, "rate_limited");
        if (error instanceof OwnerAuthError) return fail(c, 401, "owner_auth_failed");
        throw error;
      }

      const agent = await deps.agentStore.getAgent(owner.ownerAddress, id);
      if (agent === null) return fail(c, 404, "not_found");
      const pending = agent.pendingGrant;
      if (agent.status !== "provisioning" || pending === null
        || (pending.sizing.sizingPreset !== "trade-v1" && pending.sizing.sizingPreset !== "lp-v1"
          && pending.sizing.sizingPreset !== "lending-v1")) {
        return fail(c, 409, "conflict", "There is no grant attempt to reset.");
      }
      const reset = await deps.agentStore.resetGrantAttemptCas({
        ownerAddress: agent.ownerAddress,
        agentId: agent.id,
        expectedGrantDigest: pending.grantDigest,
        attemptId,
        resetActionId,
        resetAtSec: nowSec(),
      });
      if (reset.kind === "conflict" || reset.kind === "not_found") {
        return fail(c, 409, "conflict", "The grant attempt changed before reset.");
      }
      await commitResetJournal(reset.agent);
      return c.json({ data: { ...provisioningView(reset.agent, nowSec()), idempotencyKey: resetActionId },
        meta: { action: "resetGrantAttempt", agentId: id } });
    });

    app.get("/agents/:id/session", async (c) => {
      const id = c.req.param("id");
      const rawContinuation = c.req.header("x-provision-action");
      let accountReadAuthorized = false;
      let ownerAddress: Address;
      let initial: AgentRecord | null;
      if (rawContinuation !== undefined) {
        const decoded = decodeOwnerActionHeader(rawContinuation);
        if (!decoded.ok) return fail(c, 401, "owner_auth_failed");
        const continuation = await hireContinuation(id, decoded.value, true);
        if (continuation.kind === "error") {
          return continuation.code === "not_found"
            ? fail(c, 404, "not_found")
            : continuation.code === "conflict"
              ? fail(c, 409, "conflict")
              : fail(c, 401, "owner_auth_failed");
        }
        ownerAddress = continuation.agent.ownerAddress;
        initial = continuation.agent;
      } else {
        const auth = await authorizeAccountRead(c, id);
        if (auth.kind !== "ok") return auth.response;
        accountReadAuthorized = true;
        ownerAddress = auth.owner.ownerAddress;
        initial = await deps.agentStore.getAgent(ownerAddress, id);
      }
      if (initial === null) return fail(c, 404, "not_found");
      const evidenceSignal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(12_000)]);
      const cacheKey = `${ownerAddress.toLowerCase()}\0${id}`;
      if (["armed", "paused", "revoked"].includes(initial.status) && initial.sessionFacts !== null) {
        const cachedRegistration = sessionRegistrationCache.get(cacheKey);
        let registration: SessionRegistrationVerdict;
        let checkedAtMs: number;
        if (cachedRegistration !== undefined
          && nowMs() - cachedRegistration.at < 10_000
          && cachedRegistration.rowVersion === initial.rowVersion) {
          registration = cachedRegistration.value;
          checkedAtMs = cachedRegistration.at;
        } else {
          registration = await readSessionRegistration({
            wallet: initial.walletAddress,
            keyId: keccak256(initial.sessionFacts.publicKey),
            ...(deps.keyStoreReader === undefined ? {} : { reader: deps.keyStoreReader }),
            signal: evidenceSignal,
          });
          checkedAtMs = nowMs();
          sessionRegistrationCache.set(cacheKey, {
            at: checkedAtMs,
            rowVersion: initial.rowVersion,
            value: registration,
          });
        }
        let current = initial;
        let finalizedSessionRevocation:
          | {
            readonly kind: "invalid" | "registered" | "missing" | "unreadable";
            readonly checkedAtMs: number;
            readonly finalizedBlockNumber?: string;
            readonly finalizedBlockHash?: Hex;
          }
          | undefined;
        if (accountReadAuthorized && initial.status === "revoked"
          && initial.sessionRevocation === null) {
          const finalizedCheckedAtMs = nowMs();
          const finalized = await readFinalizedSessionRevocation({
            chainId: config.chainId,
            keyStoreAddress: config.keyStore,
            wallet: initial.walletAddress,
            keyId: keccak256(initial.sessionFacts.publicKey),
            expectedPublicKey: initial.sessionFacts.publicKey,
            observedAtMs: nowMs(),
            ...(deps.keyStoreReader === undefined ? {} : { reader: deps.keyStoreReader }),
            signal: evidenceSignal,
          });
          finalizedSessionRevocation = {
            kind: finalized.kind,
            checkedAtMs: finalized.kind === "invalid" || finalized.kind === "missing"
              ? finalized.evidence.observedAtMs
              : finalizedCheckedAtMs,
            ...(finalized.kind === "unreadable" ? {} : {
              finalizedBlockNumber: finalized.observation.blockNumber,
              finalizedBlockHash: finalized.observation.blockHash,
            }),
          };
          if (finalized.kind === "invalid" || finalized.kind === "missing") {
            const confirmed = await deps.agentStore.confirmSessionRevokedCas({
              ownerAddress,
              agentId: id,
              expectedRowVersion: initial.rowVersion,
              expectedPublicKey: initial.sessionFacts.publicKey,
              expectedChainId: config.chainId,
              expectedKeyStoreAddress: config.keyStore,
              evidence: finalized.evidence,
            });
            if (confirmed.kind === "confirmed" || confirmed.kind === "same") {
              current = confirmed.agent;
            } else if (confirmed.kind === "not_found") {
              return fail(c, 404, "not_found");
            } else {
              const observed = await deps.agentStore.getAgent(ownerAddress, id);
              const storedKeyPresent = observed !== null
                && await deps.agentStore.hasAgentSessionKey(ownerAddress, id);
              if (observed === null || !validSessionRevocationProof(observed, {
                chainId: config.chainId,
                keyStoreAddress: config.keyStore,
              }, nowMs()) || storedKeyPresent) {
                return fail(c, 409, "conflict", "The revocation evidence changed before it could be recorded.");
              }
              current = observed;
            }
          }
        } else if (accountReadAuthorized && initial.sessionRevocation !== null) {
          const storedKeyPresent = await deps.agentStore.hasAgentSessionKey(ownerAddress, id);
          const revocationContext = {
            chainId: config.chainId,
            keyStoreAddress: config.keyStore,
          } as const;
          const storedProofValid = validSessionRevocationProof(initial, revocationContext, nowMs());
          if (agentSessionIntegrity(initial, revocationContext, nowMs(), storedKeyPresent)
            === "proof_with_key") {
            return fail(c, 409, "session_integrity_corrupt",
              "The finalized revocation proof conflicts with a persisted session key.");
          }
          finalizedSessionRevocation = {
            kind: storedProofValid ? initial.sessionRevocation.verdict : "unreadable",
            // The proof block is immutable, but this response is freshly
            // revalidated against row integrity and key destruction above.
            // Age the read, not the historical transaction, so a durable
            // Removed state does not turn back into a retry button after 15s.
            checkedAtMs: nowMs(),
            ...(storedProofValid ? {
              finalizedBlockNumber: initial.sessionRevocation.blockNumber,
              finalizedBlockHash: initial.sessionRevocation.blockHash,
            } : {}),
          };
        }
        return c.json({
          data: {
            ...provisioningView(current, nowSec()),
            sessionRegistration: { kind: registration.kind, checkedAtMs },
            ...(finalizedSessionRevocation === undefined ? {} : { finalizedSessionRevocation }),
          },
        });
      }
      const cached = convergenceCache.get(cacheKey);
      let result;
      if (cached !== undefined && nowMs() - cached.at < 10_000
        && cached.value.agent?.rowVersion === initial.rowVersion) {
        result = cached.value;
      } else {
        try {
          result = await convergeProvisioning({
            store: deps.agentStore,
            evidence: hire.evidence,
            ownerAddress,
            agentId: id,
            keyStore: config.keyStore,
            nowSec: nowSec(),
            ...(deps.tradeAgent === undefined ? {} : { tradeSettings: deps.tradeAgent.settingsStore }),
            // MARKETPLACE-LENDING-AGENT R3.3(3): the lending materialization
            // collaborators. Absent with a present `initialLendingHire` is a
            // `settings_conflict` activation error, never a silent arm.
            ...(deps.lending === undefined
              ? {}
              : {
                  lendingSettings: deps.lending.settingsStore,
                  lendingGuards: deps.lending.guards,
                }),
            signal: evidenceSignal,
          });
          convergenceCache.set(cacheKey, { at: nowMs(), value: result });
        } catch {
          convergenceCache.delete(cacheKey);
          result = { agent: initial, missing: ["evidence-unreadable"] as const, revocationRequired: false };
        }
      }
      if (result.agent === null) return fail(c, 404, "not_found");
      return c.json({ data: provisioningView(result.agent, nowSec(), result.missing, {
        revocationRequired: result.revocationRequired,
        ...(result.activationError === undefined ? {} : { activationError: result.activationError }),
        ...(result.onChainRevoke === undefined ? {} : { onChainRevoke: result.onChainRevoke }),
      }) });
    });

    app.post("/agents/:id/session/cancel", (c) =>
      ownerMutation(c, c.req.param("id"), "cancelProvisioning", "agentProvisionCancel", async ({ agent, idempotencyKey }) => {
        if (agent.status !== "provisioning" || agent.pendingGrant === null) {
          throw new BadRequestError(`This action is unavailable while the agent is ${agent.status}.`);
        }
        const pending = agent.pendingGrant;
        const cancelled = await deps.agentStore.cancelProvisioningAgent({
          ownerAddress: agent.ownerAddress,
          agentId: agent.id,
          expectedRowVersion: agent.rowVersion,
          expectedGrantDigest: pending.grantDigest,
          nowSec: nowSec(),
          ...(deps.tradeAgent === undefined ? {} : { tradeSettings: deps.tradeAgent.settingsStore }),
          cancelActionId: idempotencyKey as Hex,
        });
        if (!cancelled.updated) throw new ConflictError("The agent changed while cancellation was being applied.");
        const converged = await convergeProvisioning({
          store: deps.agentStore,
          evidence: hire.evidence,
          ownerAddress: agent.ownerAddress,
          agentId: agent.id,
          keyStore: config.keyStore,
          nowSec: nowSec(),
          signal: c.req.raw.signal,
        });
        if (converged.agent === null) throw new NotFoundError();
        return {
          ...provisioningView(converged.agent, nowSec(), converged.missing, {
            revocationRequired: converged.revocationRequired,
            ...(converged.onChainRevoke === undefined ? {} : { onChainRevoke: converged.onChainRevoke }),
          }),
          ...(converged.revocationRequired ? { note: "the canceled agent will not activate; detected on-chain session authority still needs owner revocation" } : {}),
        };
      }),
    );
  }

  /* ---- Owner mutations: service credential + owner signature ------------ */

  function requireStatus(agent: AgentRecord, allowed: readonly AgentStatus[]): void {
    if (allowed.includes(agent.status)) return;
    if (agent.status === "provisioning") {
      throw new BadRequestError("This agent is still being hired. Finish the on-chain grant, or cancel the hire.");
    }
    throw new BadRequestError(`This action is unavailable while the agent is ${agent.status}.`);
  }

  app.post("/agents/:id/pause", (c) =>
    ownerMutation(c, c.req.param("id"), "pause", "pause", async ({ agent }) => {
      requireStatus(agent, ["armed"]);
      const updated = await deps.agentStore.transitionAgentStatus({
        ownerAddress: agent.ownerAddress, agentId: agent.id, expectedStatus: "armed",
        expectedRowVersion: agent.rowVersion, status: "paused",
      });
      if (updated === null) throw new ConflictError("The agent changed while this action was being applied.");
      await deps.killswitch.pauseAgent(agent.id, agent.ownerAddress);
      return { agent: agentOwnerView(updated) };
    }),
  );

  app.post("/agents/:id/unpause", (c) =>
    ownerMutation(c, c.req.param("id"), "unpause", "unpause", async ({ agent }) => {
      requireStatus(agent, ["paused"]);
      const updated = await deps.agentStore.transitionAgentStatus({
        ownerAddress: agent.ownerAddress, agentId: agent.id, expectedStatus: "paused",
        expectedRowVersion: agent.rowVersion, status: "armed",
      });
      if (updated === null) throw new ConflictError("The agent changed while this action was being applied.");
      await deps.killswitch.unpauseAgent(agent.id, agent.ownerAddress);
      return { agent: agentOwnerView(updated) };
    }),
  );

  app.post("/agents/:id/change-budget", (c) =>
    ownerMutation(
      c,
      c.req.param("id"),
      "changeBudget",
      "changeBudget",
      async ({ agent, params }) => {
        requireStatus(agent, ["armed", "paused"]);
        const caps = parseBudgetParams(params);
        if (!caps.ok) throw new BadRequestError(caps.message);

        const updated = await deps.agentStore.updateAgentCapsCas({
          ownerAddress: agent.ownerAddress, agentId: agent.id,
          expectedRowVersion: agent.rowVersion, caps: caps.value,
        });
        if (updated === null) throw new ConflictError("The agent changed while this action was being applied.");
        return {
          agent: agentOwnerView(updated ?? agent),
          // Said plainly because the alternative is a user who believes their
          // new cap is enforced by the chain when it is not.
          offChainOnly: true,
          note:
            "Recorded as the off-chain cap this server enforces. The on-chain " +
            "session's spend caps are unchanged; changing those requires the " +
            "owner's client to sign and broadcast a fresh grant.",
        };
      },
    ),
  );

  app.post("/agents/:id/runtime-profile", (c) =>
    ownerMutation(
      c,
      c.req.param("id"),
      "bindRuntimeProfile",
      "bindRuntimeProfile",
      async ({ agent, params }) => {
        requireStatus(agent, ["armed", "paused"]);
        const profile = parseRuntimeProfileBinding(params);
        if (profile === null) {
          throw new BadRequestError(
            '"profile" must be one of: trade-v1, lp-v1, venus-v1.',
          );
        }
        const result = await deps.agentStore.bindHttpRuntimeProfileCas({
          ownerAddress: agent.ownerAddress, agentId: agent.id,
          expectedRowVersion: agent.rowVersion, profile,
        });
        if (result.kind === "not_found") throw new NotFoundError();
        if (result.kind === "conflict") {
          throw new ConflictError("The HTTP runtime profile is already bound.");
        }
        return { agent: agentOwnerView(result.agent), profile: result.agent.httpRuntimeProfile };
      },
    ),
  );

  app.post("/agents/:id/revoke", (c) =>
    ownerMutation(c, c.req.param("id"), "revoke", "revoke", async ({ agent }) => {
      requireStatus(agent, ["armed", "paused"]);
      if (agent.sessionFacts?.hireSizing?.name === "trade-v1") {
        const tradeAgent = deps.tradeAgent;
        if (tradeAgent === undefined) throw new ConflictError("Trading agent state is unavailable.");
        const [settings, positions, unsettled] = await Promise.all([
          tradeAgent.settingsStore.get(agent.ownerAddress, agent.id),
          tradeAgent.positions.list(agent.ownerAddress, agent.id),
          tradeAgent.intents.listUnsettled(agent.ownerAddress, agent.id),
        ]);
        if (settings?.drainingAt === null || settings === null) {
          throw new ConflictError("Start Remove and drain this trading agent before revoking it.");
        }
        if (positions.some((position) => position.status !== "closed") || unsettled.length > 0) {
          throw new ConflictError("Trading positions or submitted trades are still settling.");
        }
        const fence = await tradeAgent.settingsStore.withEntryFence(agent.ownerAddress, agent.id, async () => true);
        if (fence.kind !== "draining") {
          throw new ConflictError("Trading entry gate is not closed.");
        }
      }
      // (a) The guaranteed half: this server stops submitting, now and after a
      // restart. Both the status and the kill switch are set, so neither a
      // status read nor `authorizeExecute` can miss it.
      const updated = await deps.agentStore.transitionAgentStatus({
        ownerAddress: agent.ownerAddress, agentId: agent.id, expectedStatus: agent.status,
        expectedRowVersion: agent.rowVersion, status: "revoked",
      });
      if (updated === null) throw new ConflictError("The agent changed while this action was being applied.");
      await deps.killswitch.pauseAgent(agent.id, agent.ownerAddress);
      // (c) The half this server CANNOT do, handed back as unsigned calls.
      return {
        agent: agentOwnerView(updated),
        onChainRevoke: buildOnChainRevoke(updated, config),
      };
    }),
  );

  /* ---- Raw money path: service + runtime assertion, no owner signature --- */

  app.post("/agents/:id/execute", async (c) => {
    // (0) The raw-calls gate. Byte-identical to the 404 an unknown path gets,
    // and returned before the body is read or the agent is looked up, so a
    // disabled deployment leaks nothing — not that the route exists, not
    // whether the agent does.
    if (config.executeRawEnabled !== true) return fail(c, 404, "not_found");

    if (runtimeAuth.kind === "disabled") {
      return fail(c, 503, "runtime_auth_unavailable");
    }

    const id = c.req.param("id");

    const body = await readJsonBody(c, maxBodyBytes);
    if (body.kind === "error") return body.response;

    const parsed = parseExecuteRequest(body.value, MAX_CALLS_PER_EXECUTE);
    if (!parsed.ok) return fail(c, 400, "invalid_request", parsed.message);
    const { decisionId, calls } = parsed.value;

    const runtimeAuthorization = await authorizeHttpRuntime(
      c,
      id,
      "executeRaw",
      parsed.value,
    );
    if (runtimeAuthorization.kind === "error") return runtimeAuthorization.response;
    const agent = runtimeAuthorization.agent;

    const callsHash = hashCalls(calls);
    const idempotencyKey = executeIdempotencyKey(agent.id, decisionId, callsHash);

    // (3) Journal FIRST, before any decision, key access or submission.
    const priorForDecision = await deps.journal.getByDecision(agent.id, decisionId);
    if (priorForDecision !== null) {
      if (priorForDecision.kind !== "execute") {
        // The decision id already means something on the OTHER money route.
        // `getByDecision` spans both on purpose, so one namespace covers both;
        // answering a raw execute with a trade's outcome would be a lie.
        return fail(
          c,
          409,
          "conflict",
          "This decisionId is already bound to a different operation.",
        );
      }
      const priorHash = priorForDecision.externalRef.callsHash;
      if (priorHash !== undefined && priorHash !== callsHash) {
        // Reporting the first trade's outcome for a second, different trade
        // would be a lie with money attached. Refuse instead.
        return fail(
          c,
          409,
          "conflict",
          "This decisionId is already bound to a different set of calls.",
        );
      }
      return c.json(storedExecuteOutcome(priorForDecision));
    }

    if (agent.status === "revoked" || agent.status === "retired") {
      return fail(c, 409, "revoked");
    }

    // (6) Throttle before any key access, so a burst costs nothing.
    const verdict = executeThrottle.tryAcquire(agent.id);
    if (!verdict.allowed) {
      c.header("retry-after", String(Math.ceil(verdict.retryAfterMs / 1000)));
      return fail(c, 429, "throttled");
    }

    // (4) First kill-switch check.
    const preDecision = await authorizeExecute({
      agent,
      killswitch: deps.killswitch,
      now: nowSec(),
    });
    if (!preDecision.allowed) return executeDenied(c, preDecision.code);

    const facts = agent.sessionFacts;
    if (facts === null) return fail(c, 409, "not_executable");

    const { entry: begun, created } = await deps.journal.beginWithSpend(
      {
        idempotencyKey,
        agentId: agent.id,
        ownerAddress: agent.ownerAddress,
        kind: "execute",
        decisionId,
        externalRef: { callsHash, publicKey: facts.publicKey },
        // Raw spends count against the off-chain daily cap too. Moot while the
        // route is disabled by default, cheap to record, and it keeps the cap
        // honest for any deployment that turns it back on.
        nativeSpendWei: calls.reduce((total, call) => total + (call.value ?? 0n), 0n),
      },
      nowMs(),
    );
    if (!created) {
      // The key already existed — a prior attempt OR a concurrent duplicate
      // whose row is still PENDING. Only the caller whose insert took may
      // submit; everyone else gets the stored (possibly still-PENDING) outcome.
      return c.json(storedExecuteOutcome(begun));
    }

    // (4, again) Re-checked after `begin` and immediately before submit: the
    // window between the first check and the submit is exactly where an operator
    // halt or an owner pause is most likely to land, and the later this runs the
    // smaller that window is.
    const lateDecision = await authorizeExecute({
      agent,
      killswitch: deps.killswitch,
      now: nowSec(),
    });
    if (!lateDecision.allowed) {
      await deps.journal.markRolledBack(
        idempotencyKey,
        sanitizeMessage(`Refused before submit: ${lateDecision.code}.`),
      );
      return executeDenied(c, lateDecision.code);
    }

    const provider: WalletProvider = deps.providerRegistry.get(config.chainId);

    // (5a) EVERYTHING BEFORE THE SUBMIT, in its own block (PHASE2.4 R3).
    //
    // The split is POSITIONAL, not taxonomic, and that is the whole safety
    // argument: nothing in this block has reached a relay, so a throw here is a
    // definite refusal and the row may be rolled back and its budget released.
    // Nothing in the block below can be classified that way. A rule keyed on the
    // error TYPE could not carry the property — `mapProviderError` relays our own
    // errors unchanged and the abort helper throws the same error on both sides
    // of the submit — and getting it wrong in that direction is a double spend.
    //
    // The key is fetched, used and dropped inside `withSessionKey`; what escapes
    // is the SessionRef, whose signer is an opaque provider handle and never the
    // key material.
    let session: SessionRef;
    try {
      session = await withSessionKey(deps.agentStore, agent, async (authority) =>
        provider.restoreSession({
          spec: facts.spec,
          agent: authority,
          walletAddress: agent.walletAddress,
          publicKey: facts.publicKey,
          expiresAt: facts.expiry,
        }),
      );
      await provider.preflightExecute({ session, calls });
    } catch (error) {
      const refusal = asPlaneError(error, "execute refused");
      await deps.journal.markRolledBack(
        idempotencyKey,
        sanitizeMessage(`Refused before submission: ${refusal.code}.`),
      );
      return c.json({
        data: {
          status: "FAILED",
          failureCode: refusal.code,
        } satisfies ExecutionReceipt,
        meta: {
          idempotencyKey,
          journalState: "ROLLED_BACK",
          note: "Refused before submission; nothing was sent.",
        },
      });
    }

    // (5b) THE SUBMIT. From here on, ambiguity is the rule.
    let receipt: ExecutionReceipt;
    try {
      receipt = await provider.executeViaSession({
        session,
        calls,
        // HARD-CODED. There is no request field, no config field and no
        // parameter anywhere on this path that can reach this flag. It exists
        // only for the Phase 0 spike's on-chain-rejection proof; letting a
        // caller set it would skip the local policy pre-flight and turn a free
        // local rejection into a paid on-chain one — and, worse, would let a
        // caller ask this server to submit calls it knows are out of scope.
        bypassLocalPolicyCheck: false,
      });
    } catch (error) {
      // We cannot prove the submit did NOT land — a transport error can follow a
      // request the relay already accepted. Journal invariant (b) applies:
      // ambiguous means UNKNOWN and HELD, never a guessed failure.
      //
      // UNKNOWN is TERMINAL (`journal.ts`: `listNonTerminal` returns PENDING and
      // IN_PROGRESS only), so reconcile never revisits this row — the missing
      // `callsId` is why it BECAME unknown, not why it stays. The budget it
      // holds is bounded by the 24 h window `sumNativeSpendSince` counts over.
      const mapped = asPlaneError(error, "execute failed");
      await deps.journal.markUnknown(idempotencyKey, sanitizeMessage(mapped.message));
      return c.json({
        data: { status: "PENDING" } satisfies ExecutionReceipt,
        meta: {
          idempotencyKey,
          journalState: "UNKNOWN",
          failureCode: mapped.code,
          note: "Submission outcome is unknown and is held for reconciliation.",
        },
      });
    }

    // (7) begin → markInProgress({callsId}) → markCommitted / markRolledBack.
    if (receipt.callsId !== undefined) {
      await deps.journal.markInProgress(idempotencyKey, { callsId: receipt.callsId });
    }
    if (receipt.status === "CONFIRMED") {
      await deps.journal.markCommitted(
        idempotencyKey,
        receipt.transactionHash === undefined
          ? {}
          : { txHash: receipt.transactionHash },
      );
    } else if (receipt.status === "FAILED") {
      await deps.journal.markRolledBack(
        idempotencyKey,
        sanitizeMessage(receipt.failureCode ?? "Execution reported FAILED."),
      );
    }
    // PENDING with a callsId stays IN_PROGRESS; reconcile resolves it.

    // (8) The receipt envelope, `failureCode` included on FAILED.
    return c.json({ data: receipt, meta: { idempotencyKey, decisionId } });
  });

  /* ---- Trade path: service + runtime assertion, no owner signature ------- */

  /**
   * The high-level trade route.
   *
   * Same auth as `/execute` and for the same reason: the owner authorized the
   * agent once, on-chain. What differs is how much of the transaction the CALLER
   * gets to choose. On `/execute` it supplies raw calldata; here it supplies
   * seven values and this server builds the calls. That is the whole security
   * argument for the route:
   *
   *   - the RECIPIENT is the persisted row's wallet, never a request field;
   *   - the SPENDER of every approval is a venue resolved from config or from
   *     the data-plane read, never a request field;
   *   - every trade passes the scan gate and the rule engine, which raw calls
   *     bypass entirely;
   *   - a BUY is refused unless the session already grants a per-token spend
   *     cap for the token, so no position can be opened that the same session
   *     could not later close (PHASE2.3 R1).
   *
   * ─── WHAT `route` WIDENS, STATED PLAINLY (PHASE2.2 R10) ──────────────────
   *
   * The `approve` blast radius is UNCHANGED: the spender is still the resolved
   * router, the amount is still exact, and no new approval exists. What did
   * change is the sell side. Before this phase a sell could only route through
   * the canonical `token/WBNB` pair; now a caller holding `x-exec-token` can
   * name an arbitrary intermediate, so a real position can be pushed through an
   * attacker-controlled pool in one call with the caller's own `minOutWei` /
   * `quotedOutWei` as the only floor. The scan gate does not run on sells (by
   * design) and does not evaluate hops at all.
   *
   * The bound is the same one that already bounds a garbage `token` on a buy:
   * this server holds the session key, the recipient is the row's wallet, and
   * the native spend caps bound native outflow. Say the last part precisely —
   * NATIVE CAPS DO NOT BOUND TOKEN OUTFLOW ON A SELL.
   *
   * The pipeline order below mirrors `/execute`'s proven skeleton and is
   * NORMATIVE. In particular the journal lookup precedes every decision, and the
   * authoritative daily-cap check runs AFTER `begin`, against a sum taken in the
   * same transaction — a read-then-act check lets two concurrent trades both
   * pass, which is the difference between a cap and a suggestion.
   */
  app.post("/agents/:id/trade", async (c) => {
    const id = c.req.param("id");

    if (runtimeAuth.kind === "disabled") {
      return fail(c, 503, "runtime_auth_unavailable");
    }

    // (1) Wire input. Unknown venue/side, bad address, non-positive amount: all
    // 400 before anything else runs.
    const body = await readJsonBody(c, maxBodyBytes);
    if (body.kind === "error") return body.response;

    const parsed = parseTradeRequest(body.value);
    if (!parsed.ok) return fail(c, 400, "invalid_request", parsed.message);
    const request: TradeRequest = parsed.value;

    const runtimeAuthorization = await authorizeHttpRuntime(
      c,
      id,
      "trade",
      request,
    );
    if (runtimeAuthorization.kind === "error") return runtimeAuthorization.response;
    const agent = runtimeAuthorization.agent;

    // (1, continued) The token-argument blacklist. Needs the row's wallet, so
    // it runs here — still before the journal, the throttle, the key and the
    // provider.
    const blacklistInput = {
      wallet: agent.walletAddress,
      keyStore: config.keyStore,
      venues: trade.venues,
      ...(trade.feeTreasury === undefined ? {} : { treasury: trade.feeTreasury }),
    };
    const forbiddenTokens = forbiddenTokenAddresses(blacklistInput);
    if (forbiddenTokens.has(request.token.toLowerCase())) {
      return fail(c, 400, "invalid_request", `"token" is not a tradeable address.`);
    }

    // Every intermediate hop runs the SAME blacklist as `token`, and for the
    // same reason: a hop is an address this server then builds a swap path
    // through. WBNB is in the set already — it is the implicit first leg, so
    // naming it again is a malformed path — and so are the routers, the
    // manager, the treasury, the zero address, the KeyStore and the agent's own
    // wallet, which is the escalation the blacklist exists for.
    for (const hop of request.route?.hops ?? []) {
      if (forbiddenTokens.has(hop.toLowerCase())) {
        return fail(c, 400, "invalid_request", `"route.hops" names a forbidden address.`);
      }
    }

    // (1, continued) BUY ⇒ SELLABLE (PHASE2.3 R1). The blacklist above is a
    // BLACKLIST, not a granted-token allowlist, and a Pancake buy needs no
    // `approve` — so without this an agent could open a position in any token
    // the blacklist happens not to name, and then never close it: the sell's
    // `approve` would have no per-token limit to meter against, GuardedExecutor
    // would decline, and the trade would return PENDING with no tx and no gas.
    // That is FINDINGS (h) reproduced per-token, still silent, after the phase
    // that exists to fix it.
    //
    // A SELL is deliberately NOT gated this way. A wallet may hold a token from
    // before the grant — it IS the owner's own EOA — and refusing its exit
    // would trap it, the same reasoning as the pause carve-out in FINDINGS (s).
    //
    // This is a safety refusal about what the session can EXECUTE, not a
    // judgement about the token, so it does not make a market decision. A null
    // `sessionFacts` is left to the 409 `not_executable` below, which is the
    // truer answer for an agent with no session at all.
    //
    // THE GRANT IS NOT THE AUTHORITY HERE. `sessionFacts.spec` records the caps
    // that existed at grant time and is not rewritten (FINDINGS (x) — the
    // reason is the relay descriptor, not `restoreSession`), while
    // `setSpendLimit` lets the owner authorise a new
    // token on a LIVE session (FINDINGS (i)), which is the documented way to
    // reach anything that did not exist at hire. The two diverge by design:
    // measured on the live mainnet wallet, the snapshot listed ONE cap while the
    // account enforced SEVEN. Gating on the snapshot alone would refuse exactly
    // the tokens an owner had just paid to authorise, and nothing they could do
    // would lift it.
    //
    // So the chain is asked, and the snapshot is the fallback when that read
    // fails. Union, not replacement: the snapshot is always a subset of what was
    // once granted, so trusting it can only ever permit something the owner did
    // sign for — an RPC blip degrades reach, never safety.
    //
    // BOTH HALVES, either way it is answered. A sell needs a spend cap AND an
    // `approve` allowlist entry, and the account checks the allowlist first, so
    // a cap alone reads as authorised in `spendInfos` and still cannot sell —
    // FINDINGS (u), which stranded a real position on mainnet. `grantsTokenSell`
    // and `canSessionSellToken` each answer the whole question, not the cap half.
    if (request.side === "buy" && agent.sessionFacts !== null) {
      const facts = agent.sessionFacts;
      let granted = grantsTokenSell(facts.spec, request.token);
      if (!granted) {
        try {
          granted = await deps.providerRegistry
            .get(config.chainId)
            .canSessionSellToken({
              wallet: {
                address: agent.walletAddress,
                chainId: config.chainId,
                ownerAddress: agent.ownerAddress,
                custodyModel: agent.custodyModel,
              },
              sessionPublicKey: facts.publicKey,
              token: request.token,
            });
        } catch {
          // Fall back to the snapshot verdict, which is already `false` here.
          // The error text is upstream prose and tells the caller nothing it
          // can act on.
        }
      }
      if (!granted) {
        return fail(
          c,
          400,
          "invalid_request",
          `"token" is not sellable by this agent's session — it needs both a spend cap and an approve allowlist entry — so a position in it could be opened and never closed.`,
        );
      }
    }

    // The venue this chain actually offers. An unconfigured venue is a 400 — it
    // is never a call to the zero address.
    const pancake = pancakeVenue(trade.venues);
    if (request.venue === "pancake" && pancake === null) {
      return fail(
        c,
        400,
        "invalid_request",
        "The pancake venue is not configured for this chain.",
      );
    }
    // PHASE2.2 R6: BOTH the router and WBNB, because every V3 path this server
    // builds begins or ends at WBNB and the two are independently optional.
    const pancakeV3 = pancakeV3Venue(trade.venues);
    if (request.venue === "pancake_v3" && pancakeV3 === null) {
      return fail(
        c,
        400,
        "invalid_request",
        "The pancake_v3 venue is not configured for this chain.",
      );
    }
    // PHASE2.1 R5: the chain-support gate for Four.Meme is the HELPER, not a
    // configured manager. The manager is no longer configuration at all — it
    // comes from the read — but without a helper there is nothing to read, so
    // the venue does not exist on this chain and says so at step 1, before the
    // journal, rather than failing later with a call to nowhere.
    if (request.venue === "fourmeme" && trade.venues.fourMemeHelper === undefined) {
      return fail(
        c,
        400,
        "invalid_request",
        "The fourmeme venue is not configured for this chain.",
      );
    }
    // PHASE2.4 R8: one address, and it must exist before anything is built —
    // the Portal is the read target, the swap target and the approval spender,
    // so an unconfigured chain is a 400 and never a call to `0x0`.
    const flapPortal = flapVenue(trade.venues);
    if (request.venue === "flap" && flapPortal === null) {
      return fail(
        c,
        400,
        "invalid_request",
        "The flap venue is not configured for this chain.",
      );
    }

    const { paramsHash, idempotencyKey } = tradeExecutionIdentity({
      agentId: agent.id, chainId: config.chainId, request, trade, pancake, pancakeV3, flapPortal,
    });

    // TRADING-AGENT R6: the extracted core owns `bypassLocalPolicyCheck: false`;
    // keeping the literal here also pins the route-level fail-closed audit invariant.
    const result: ExecuteTradeResult = await executeTradeForAgent({
      agent,
      request,
      scanGate,
      idempotencyKey,
      paramsHash,
      ...(c.req.raw.signal === undefined ? {} : { signal: c.req.raw.signal }),
      deps: {
        chainId: config.chainId,
        keyStore: config.keyStore,
        agentStore: deps.agentStore,
        journal: deps.journal,
        killswitch: deps.killswitch,
        providerRegistry: deps.providerRegistry,
        trade,
        pancake,
        pancakeV3,
        flapPortal,
        nowMs,
        routeThrottle: () => {
          const acquired = executeThrottle.tryAcquire(agent.id);
          return acquired.allowed
            ? { allowed: true }
            : { allowed: false, retryAfterSec: Math.ceil(acquired.retryAfterMs / 1_000) };
        },
      },
    });
    if (result.kind === "denied") {
      if (result.status === 429 && result.meta !== undefined) {
        c.header("retry-after", String(result.meta["retryAfterSec"]));
      }
      return fail(c, result.status, result.code as ErrorCode, result.message);
    }
    if (result.kind === "rolled-back") {
      return c.json({
        data: result.receipt ?? {
          status: "FAILED",
          failureCode: result.failureCode,
        } satisfies ExecutionReceipt,
        meta: result.meta,
      });
    }
    if (result.kind === "unknown") {
      return c.json({
        data: { status: "PENDING", ...(result.callsId === undefined ? {} : { callsId: result.callsId }) } satisfies ExecutionReceipt,
        meta: result.meta,
      });
    }
    return c.json({ data: result.receipt, meta: result.meta });

  });

  if (config.tradeAgentEnabled === true) {
    const tradeAgent = deps.tradeAgent;
    app.post("/agents/:id/trade/settings", async (c) => {
      if (tradeAgent === undefined || !tradeAgent.readiness.ready) return fail(c, 503, "trade_not_ready");
      return ownerMutation(c, c.req.param("id"), "tradeSettings", "tradeSettings", async ({ agent, params, idempotencyKey }) => {
        const parsed = parseTradeSettings(params);
        if (!parsed.ok) throw new BadRequestError(parsed.message);
        const existing = await tradeAgent.settingsStore.get(agent.ownerAddress, agent.id);
        if (existing !== null) {
          const current = parseTradeSettings(existing.params);
          if (!current.ok) throw new ConflictError("Stored trading settings are invalid.");
          const immutable = immutableTradeSettingChange(current.value, parsed.value);
          if (immutable !== null) throw new BadRequestError(`${immutable} cannot be changed after deploy.`);
          if (existing.drainingAt !== null) throw new ConflictError("Trade settings cannot change while the agent is draining.");
        }
        if (await deps.journal.hasPendingForAgent(agent.id, idempotencyKey)) {
          throw new ConflictError("Trade settings cannot change while an execution is pending.");
        }
        if (agent.sessionFacts === null) throw new TradeNotExecutableError();
        const capDayWei = nativeDayCapWei(agent.sessionFacts);
        if (capDayWei === null) throw new TradeNotExecutableError();
        const sized = checkTradeSizing({ capDayWei, entryWei: BigInt(parsed.value.entryWei),
          maxOpenPositions: parsed.value.maxOpenPositions,
          grantedTokenCount: pinnedTokens(agent.sessionFacts).length,
          platformFeeBps: tradeAgent.feeBps });
        if (!sized.ok) throw new TradeCapitalTooSmallError(sized.minimumCapWei);
        let stored;
        try {
          stored = await tradeAgent.settingsStore.put({ agentId: agent.id,
            ownerAddress: agent.ownerAddress, params: parsed.value, digest: tradeSettingsDigest(parsed.value) });
        } catch (error) {
          if (error instanceof Error && error.message.includes("draining")) {
            throw new ConflictError("Trade settings cannot change while the agent is draining.");
          }
          throw error;
        }
        return { settings: stored.params, digest: stored.digest, updatedAt: stored.updatedAt };
      });
    });

    app.post("/agents/:id/trade/drain", async (c) => {
      if (tradeAgent === undefined || !tradeAgent.readiness.ready) return fail(c, 503, "trade_not_ready");
      return ownerMutation(c, c.req.param("id"), "tradeDrain", "tradeDrain", async ({ agent, params }) => {
        if (!isRecord(params) || Object.keys(params).length !== 0) {
          throw new BadRequestError("tradeDrain params must be exactly an empty object.");
        }
        requireStatus(agent, ["armed", "paused"]);
        const settings = await tradeAgent.settingsStore.requestDrain(agent.ownerAddress, agent.id);
        if (settings === null) throw new NotFoundError();
        const open = await tradeAgent.positions.listOpen(agent.ownerAddress, agent.id);
        await Promise.all(open.map((position) => tradeAgent.positions.requestExit(agent.ownerAddress, agent.id, position.positionId)));
        return { drainingAt: settings.drainingAt, openPositions: open.length };
      });
    });

    app.post("/agents/:id/trade/positions/:positionId/exit", async (c) => {
      if (tradeAgent === undefined || !tradeAgent.readiness.ready) return fail(c, 503, "trade_not_ready");
      const positionId = c.req.param("positionId");
      return ownerMutation(c, c.req.param("id"), "tradeExit", "tradeExit", async ({ agent, params }) => {
        if (!isRecord(params) || Object.keys(params).length !== 1 || params["positionId"] !== positionId) {
          throw new BadRequestError("tradeExit params must contain exactly the route positionId.");
        }
        const row = await tradeAgent.positions.requestExit(agent.ownerAddress, agent.id, positionId);
        if (row === null) throw new NotFoundError();
        return { positionId: row.positionId, exitRequestedAt: row.exitRequestedAt };
      });
    });

    app.get("/agents/:id/trade/view", async (c) => {
      if (tradeAgent === undefined || !tradeAgent.readiness.ready) return fail(c, 503, "trade_not_ready");
      const id = c.req.param("id");
      const auth = await authorizeAccountRead(c, id);
      if (auth.kind !== "ok") return auth.response;
      const agent = await deps.agentStore.getAgent(auth.owner.ownerAddress, id);
      if (agent === null) return fail(c, 404, "not_found");
      const [settings, positions, runs, unsettled] = await Promise.all([
        tradeAgent.settingsStore.get(agent.ownerAddress, agent.id),
        tradeAgent.positions.list(agent.ownerAddress, agent.id),
        tradeAgent.positions.listRuns(agent.ownerAddress, agent.id, 10),
        tradeAgent.intents.listUnsettled(agent.ownerAddress, agent.id),
      ]);
      const observations = await tradeAgent.observer.observe(agent, positions, c.req.raw.signal);
      const observationById = new Map(observations.map((item) => [item.positionId, item]));
      const parsedStoredSettings = settings === null ? null : parseTradeSettings(settings.params);
      const maxOpenPositions = parsedStoredSettings?.ok === true ? parsedStoredSettings.value.maxOpenPositions : null;
      const marketHours = (token: Address): "us-equities" | null =>
        tradeAgent.readiness.bstocksAddresses.has(token.toLowerCase()) ? "us-equities" : null;
      const open = positions.filter((position) => position.status !== "closed");
      const closed = positions.filter((position) => position.status === "closed").slice(0, 50);
      return c.json({ data: {
        settings: settings?.params ?? null,
        open: open.map((position) => positionView(position, marketHours(position.token), observationById.get(position.positionId))),
        closed: closed.map((position) => positionView(position, marketHours(position.token), observationById.get(position.positionId))),
        runs: runs.map(runView),
        summary: tradeSummary(positions, observations, maxOpenPositions),
        lifecycle: { draining: settings?.drainingAt !== null && settings !== null, drainingAt: settings?.drainingAt ?? null },
        pendingIntents: unsettled.map((intent) => ({ decisionId: intent.decisionId, side: intent.side,
          token: intent.token, state: intent.state, txHash: intent.txHash, createdAt: intent.createdAt })),
        pinned: pinnedTokens(agent.sessionFacts).map((address) => ({ address,
          marketHours: marketHours(address) })),
        marketHours: { usEquitiesOpen: isUsEquityOpen(nowMs()), holidaysModeled: false },
      } });
    });
  }

  /* ---- LP routes (PHASE3): registered only when the deps are wired ------- */

  if (deps.lp !== undefined) {
    registerLpRoutes(deps.lp);
  }

  /* ---- Venus routes (PHASE4): registered only when the deps are wired ---- */

  if (deps.venus !== undefined) {
    registerVenusRoutes(deps.venus);
  }

  /* ---- Lending routes: registered only when the deps are wired ---------- */

  if (deps.lending !== undefined) {
    registerLendingRoutes(deps.lending);
  }

  if (deps.billingOwner !== undefined) {
    app.get("/agents/:id/billing", async (c) => {
      const id = c.req.param("id");
      const auth = await authorizeRead(c, id);
      if (auth.kind !== "ok") return auth.response;
      const agent = await deps.agentStore.getAgent(auth.owner.ownerAddress, id);
      if (agent === null) return fail(c, 404, "not_found");
      const account = await deps.billingOwner!.store.getAccountByWallet(agent.walletAddress);
      if (account === null || account.ownerAddress.toLowerCase() !== agent.ownerAddress.toLowerCase()) {
        return c.json({ data: null });
      }
      const usages = await deps.billingOwner!.store.listUsages(account.accountId);
      const actualUsdMicros = await deps.billingOwner!.actualUsdMicros(
        usages.filter((usage) => usage.state === "actual" || usage.state === "claimed"),
      );
      return c.json({ data: await billingOwnerView({ store: deps.billingOwner!.store, account, actualUsdMicros }) });
    });

    app.post("/agents/:id/billing/grant", (c) =>
      ownerMutation(c, c.req.param("id"), "billingGrant", "billingGrant", async ({ agent, params, ownerAction }) => {
        const parsed = parseBillingParams(parseBillingGrantParams, params);
        return {
          grant: billingGrantView(await grantAgentBilling({
            store: deps.billingOwner!.store,
            agent,
            params: parsed,
            ownerConsentHash: ownerAction.signed.paramsHash,
            now: nowSec(),
          })),
        };
      }),
    );

    app.post("/agents/:id/billing/issuer/rotate", (c) =>
      ownerMutation(c, c.req.param("id"), "billingIssuerRotate", "billingIssuerRotate", async ({ agent, params, ownerAction }) => {
        const parsed = parseBillingParams(parseBillingRotateParams, params);
        return {
          grant: billingGrantView(await rotateAgentBillingIssuer({
            store: deps.billingOwner!.store,
            agent,
            params: parsed,
            ownerConsentHash: ownerAction.signed.paramsHash,
            now: nowSec(),
          })),
        };
      }),
    );

    const accountMutation = (
      path: "pause" | "resume" | "revoke",
      action: "billingPause" | "billingResume" | "billingRevoke",
      kind: "billingPause" | "billingResume" | "billingRevoke",
      status: "paused" | "active" | "revoked",
    ) => app.post(`/agents/:id/billing/${path}`, (c) =>
      ownerMutation(c, c.req.param("id"), action, kind, async ({ agent, params }) => {
        const parsed = parseBillingParams(parseBillingAccountActionParams, params);
        assertBillingAgentBinding(agent, parsed);
        const account = await deps.billingOwner!.store.getAccount(parsed.accountId);
        if (account === null || account.ownerAddress.toLowerCase() !== agent.ownerAddress.toLowerCase() || account.walletAddress.toLowerCase() !== agent.walletAddress.toLowerCase()) {
          throw new NotFoundError();
        }
        if (status === "active") {
          const grants = await deps.billingOwner!.store.listGrants(account.accountId);
          if (!grants.some((grant) => grant.agentId === agent.id && grant.status === "active" && grant.expiresAt > nowSec())) {
            throw new ConflictError("A paused account cannot resume without an active unexpired grant.");
          }
        }
        const updated = await deps.billingOwner!.store.setAccountStatus(account.accountId, status, nowSec());
        return {
          account: billingAccountView(updated),
          ...(status === "revoked" ? { onChainRevokeRequired: true } : {}),
        };
      }),
    );
    accountMutation("pause", "billingPause", "billingPause", "paused");
    accountMutation("resume", "billingResume", "billingResume", "active");
    accountMutation("revoke", "billingRevoke", "billingRevoke", "revoked");

    app.post("/agents/:id/billing/close", (c) =>
      ownerMutation(c, c.req.param("id"), "billingClose", "billingClose", async ({ agent, params, idempotencyKey }) => {
        const parsed = parseBillingParams(parseBillingAccountActionParams, params);
        assertBillingAgentBinding(agent, parsed);
        const account = await deps.billingOwner!.store.getAccount(parsed.accountId);
        if (account === null || account.ownerAddress.toLowerCase() !== agent.ownerAddress.toLowerCase() || account.walletAddress.toLowerCase() !== agent.walletAddress.toLowerCase()) {
          throw new NotFoundError();
        }
        const closing = await deps.billingOwner!.store.beginAccountClose(account.accountId, idempotencyKey, nowSec());
        return { account: billingAccountView(closing), onChainRevokeRequired: true };
      }),
    );

    app.post("/agents/:id/billing/service-session", (c) =>
      ownerMutation(c, c.req.param("id"), "billingServiceSession", "billingServiceSession", async ({ agent, params, ownerAction }) => {
        const parsed = parseBillingParams(parsePaidServiceSessionParams, params);
        const outerIssuedAt = Number(ownerAction.signed.issuedAt);
        if (!Number.isSafeInteger(outerIssuedAt)) throw new BadRequestError("Owner action issuedAt is outside the supported range.");
        const ticket = await issueAgentPaidServiceSession({
          store: deps.billingOwner!.store,
          agent,
          params: parsed,
          ownerActionParamsHash: ownerAction.signed.paramsHash,
          outerIssuedAt,
          onChainSessionExpiresAt: await deps.billingOwner!.onChainSessionExpiresAt(agent),
          now: nowSec(),
          executionTicketKeyId: deps.billingOwner!.executionTicketKeyId,
          signExecutionTicket: deps.billingOwner!.signExecutionTicket,
        });
        return { sessionTicket: billingTicketView(ticket) };
      }),
    );
  }

  /* ---- Operator: global halt and resume --------------------------------- */

  app.post("/admin/halt", (c) => adminAction(c, "halt"));
  app.post("/admin/resume", (c) => adminAction(c, "resume"));

  /* ---- Demo mode -------------------------------------------------------- */

  // Mounted LAST and as a whole sub-app, so demo mode adds no line to any route
  // above it and can be deleted by deleting `src/demo/`. Absent deps ⇒ the
  // paths simply do not exist, which is the `lp`/`venus` posture.
  if (deps.demo !== undefined) app.route("/", createDemoRoutes(deps.demo));

  app.notFound((c) => fail(c, 404, "not_found"));

  app.onError((error, c) => {
    // The message is logged sanitized and is NOT echoed to the client: an
    // unexpected error is the most likely place for an internal detail to be in
    // the text, and the client has no use for it.
    console.error(`[server] unhandled_error: ${sanitizeMessage(error.message)}`);
    return fail(c, 500, "internal_error");
  });

  return app;

  /* ======================================================================== */
  /* Helpers, closed over deps                                                */
  /* ======================================================================== */

  /**
   * PHASE2.5 F4 — what the gate knows, told to the owner.
   *
   * An agent that has stopped taking buys because its on-chain native meter no
   * longer holds an exit's worth of headroom must SAY so on the owner's own
   * view, or this repeats PHASE3.3-AUDIT A3 for the fourth time: the worker
   * knowing something the dashboard does not. The numbers come from the SAME
   * seam the trade gate refuses on (`nativeReserveFloor`), so the two cannot
   * drift into disagreement.
   *
   * OWNER-SIGNED ROUTE ONLY (PHASE2.5-REVIEW M3). The spec put this on
   * `GET /agents/:id`, which is the RUNTIME view reachable with the shared exec
   * token; under the public multi-tenant posture that would be a new
   * cross-tenant channel for a per-tenant on-chain figure.
   *
   * NO SESSION KEY IS TOUCHED. `spendInfos` is identified by the session's
   * PUBLIC key and signs nothing, so this read never reaches
   * `getAgentSessionKey` — the SECRETS invariant at the top of this file holds
   * unchanged, and it is why `NativeDayMeterParams` takes public facts rather
   * than a restored `SessionRef`.
   *
   * `undefined` means NOT ASKED — no session on the record, or a provider with
   * no meter capability — and the field is then absent rather than rendered as
   * healthy.
   */
  async function readOwnerNativeMeter(
    agent: AgentRecord,
    signal?: AbortSignal,
  ): Promise<OwnerNativeMeterView | undefined> {
    const facts = agent.sessionFacts;
    if (facts === null) return undefined;
    let provider: WalletProvider;
    try {
      provider = deps.providerRegistry.get(config.chainId);
    } catch {
      // No provider configured for this chain. A deterministic capability fact
      // decided at boot, not an outage, so it reads as "not asked".
      return undefined;
    }
    if (provider.nativeDayMeter === undefined) return undefined;
    let meter: NativeDayMeterReading;
    try {
      meter = await provider.nativeDayMeter({
        walletAddress: agent.walletAddress,
        publicKey: facts.publicKey,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      // The gate fails CLOSED on an unreadable meter, so the honest report is
      // that buys are refused right now — and that the fix is the RPC, not the
      // cap. Saying "unknown" here would leave the owner raising a cap that was
      // never the problem. The error text itself is deliberately not echoed:
      // this is a read of someone's account, not a debugging channel.
      return {
        readable: false,
        buysRefused: true,
        note:
          "The on-chain native day meter could not be read, and an exposure-" +
          "increasing trade is refused while it cannot be measured. Buys resume " +
          "when the chain read succeeds again; no cap change is needed.",
      };
    }
    if (meter.kind !== "day") {
      // TWO accounts, not one (PHASE2.5-AUDIT A6). Both are unmetered TODAY and
      // both are ungated here, but only the first is good news — the second is
      // an account that cannot spend native at all, and it used to be rendered
      // with the reassuring sentence. FINDINGS (h) is the authority: no spend
      // row means the account finds no limit, so the batch reverts in the
      // relay's simulation rather than executing unmetered.
      const nativeGranted = meter.kind === "other-period";
      return {
        readable: true,
        metered: false,
        nativeGranted,
        buysRefused: false,
        note: nativeGranted
          ? // PHASE2.5-FIXREVIEW F5(2): this covers a native cap at ANY period
            // other than the day, and those are not equivalent. A minute cap
            // cannot trap an exit for long — it resets. A WEEK cap can trap one
            // for days, which is this phase's entire subject, and the exit
            // reserve does not model it. Say so rather than reassure.
            "This session's native spend limit is not set at the DAY period, so " +
            "the daily exit reserve does not apply and no trade is gated on it. " +
            "NOTE: a period LONGER than a day (a weekly cap) can still exhaust " +
            "and strand an exit, and this check does not model that — it reads " +
            "the day row only. Provisioning always writes a day row, so this " +
            "state means the session was granted by hand or elsewhere."
          : // PHASE2.5-FIXREVIEW F5(1): the mechanism is FINDINGS (h)'s; the
            // native case has never been observed on chain, and this repo does
            // not let a number move on an inference, so it must not let a
            // sentence to an owner move on one either.
            "This session has NO native spend grant at any period. That is not " +
            "the same as unlimited: by the mechanism FINDINGS (h) measured for " +
            "ERC-20 rows, the account finds no limit for the native a buy " +
            "spends and the batch reverts in the relay's simulation — the trade " +
            "comes back PENDING with no transaction and no gas. INFERRED, not " +
            "yet observed for the native row. This gate does not refuse it — " +
            "there is no meter to protect — but expect the buys to fail on " +
            "chain until the owner GRANTS a native day limit. A cap raise is " +
            "not the fix here; the grant is.",
      };
    }
    // A STANDING report, not a decision about a trade: `submissionNativeWei: 0n`
    // (PHASE2.5-AUDIT A1). `headroomForSubmissionWei` is what ties this view to
    // the gate — it is exactly the largest trade the gate would still authorise,
    // so a UI can say "buys up to X" instead of implying all of `remainingWei`
    // is spendable, which is the number the pre-A1 view published.
    const floor = nativeReserveFloor({ ...meter, submissionNativeWei: 0n });
    return {
      readable: true,
      metered: true,
      limitWei: meter.limitWei,
      currentSpentWei: meter.currentSpentWei,
      remainingWei: floor.remainingWei,
      overCap: floor.overCap,
      grantedTokenCount: meter.grantedTokenCount,
      reserveWei: floor.reserveWei,
      ownFeeWei: floor.ownFeeWei,
      requiredWei: floor.requiredWei,
      shortfallWei: floor.shortfallWei,
      headroomForSubmissionWei: floor.headroomForSubmissionWei,
      buysRefused: !floor.sufficient,
      ...(floor.sufficient ? {} : { note: NATIVE_RESERVE_REMEDY }),
    };
  }

  /** Map an execute denial onto its 409 code. Only reachable by trusted callers. */
  function executeDenied(
    c: Context,
    code: "NO_SESSION" | "SESSION_EXPIRED" | "AGENT_PAUSED" | "GLOBAL_HALT",
  ): Response {
    if (code === "GLOBAL_HALT") return fail(c, 409, "halted");
    if (code === "AGENT_PAUSED") return fail(c, 409, "paused");
    return fail(c, 409, "not_executable");
  }

  /**
   * Verify an owner READ.
   *
   * Reads take the same signed envelope as mutations but travel in a header
   * rather than a body, and they are VERIFIED WITHOUT CONSUMING A NONCE — see
   * `READ_ACTION_NONCE_POLICY` for why. The per-owner limiter still applies, and
   * still only after recovery, because "which owner" is not knowable before it.
   */
  async function authorizeRead(
    c: Context,
    expectedAgentId: string,
  ): Promise<
    | { readonly kind: "ok"; readonly owner: OwnerAuthResult }
    | { readonly kind: "error"; readonly response: Response }
  > {
    const envelope = decodeOwnerActionHeader(c.req.header("x-owner-action"));
    if (!envelope.ok) {
      return { kind: "error", response: fail(c, 401, "owner_auth_failed") };
    }
    const bound = requireBinding(envelope.value, "read", expectedAgentId);
    if (bound !== null) {
      return { kind: "error", response: fail(c, 401, "owner_auth_failed") };
    }

    let owner: OwnerAuthResult;
    try {
      owner = await verifyOwnerAction(envelope.value, verifyOptions());
    } catch {
      return { kind: "error", response: fail(c, 401, "owner_auth_failed") };
    }

    if (!ownerLimiter.tryConsume(owner.ownerAddress.toLowerCase())) {
      return { kind: "error", response: fail(c, 429, "rate_limited") };
    }
    return { kind: "ok", owner };
  }

  /**
   * The account-session capability is accepted only by the account/detail GET
   * allowlist, including Trading detail. Keeping it separate from `authorizeRead` makes it
   * structurally unavailable to every owner mutation and every other owner
   * read. Header presence is XOR, including empty or malformed raw values.
   */
  async function authorizeAccountRead(
    c: Context,
    expectedAgentId: string,
  ): Promise<
    | { readonly kind: "ok"; readonly owner: OwnerAuthResult }
    | { readonly kind: "error"; readonly response: Response }
  > {
    const ownerHeader = c.req.header("x-owner-action");
    const authorization = c.req.header("authorization");
    if ((ownerHeader === undefined) === (authorization === undefined)) {
      return { kind: "error", response: fail(c, 401, "owner_auth_failed") };
    }
    if (ownerHeader !== undefined) return authorizeRead(c, expectedAgentId);

    const match = /^Bearer ([A-Za-z0-9._-]+)$/u.exec(authorization ?? "");
    if (match === null || config.accountReadSession === undefined) {
      return { kind: "error", response: fail(c, 401, "owner_auth_failed") };
    }
    const ownerAddress = verifyAccountReadSession(
      match[1] as string,
      config.accountReadSession,
      nowSec(),
    );
    if (ownerAddress === null) {
      return { kind: "error", response: fail(c, 401, "owner_auth_failed") };
    }
    if (!ownerLimiter.tryConsume(ownerAddress.toLowerCase())) {
      return { kind: "error", response: fail(c, 429, "rate_limited") };
    }
    return {
      kind: "ok",
      owner: { ownerAddress, action: "read", agentId: expectedAgentId },
    };
  }

  /**
   * The owner-mutation pipeline, in the ONE order that is correct.
   *
   * The nonce↔idempotency contract from 1b-core, enforced here literally:
   *
   *   1. compute `ownerActionIdempotencyKey(signed)` — pure, no crypto needed;
   *   2. LOOK THE JOURNAL UP FIRST. A row means this exact signed action already
   *      arrived: return its stored outcome WITHOUT re-verifying and WITHOUT
   *      touching the nonce. This is the retry path, and it is why a client whose
   *      response was dropped can safely resend;
   *   3. only with no row, run `authorizeOwnerAction` — verify, then (via
   *      `beforeNonceConsume`) rate-limit the recovered owner, then consume the
   *      nonce;
   *   4. `journal.begin` under that same key, act, then mark the row terminal.
   *
   * A replay of a DIFFERENT signature carrying an ALREADY-CONSUMED nonce hashes
   * to a different key, finds no row at step 2, reaches step 3, and is rejected
   * by `consume` returning false. Retries and replays are told apart by which
   * step catches them, not by inspecting the request.
   */
  async function ownerMutation(
    c: Context,
    id: string,
    expectedAction: OwnerActionType,
    kind: JournalKind,
    act: (input: {
      readonly agent: AgentRecord;
      readonly params: unknown;
      readonly ownerAction: OwnerActionRequest;
      readonly idempotencyKey: string;
    }) => Promise<Record<string, unknown>>,
    /**
     * BEST-EFFORT work that must run AFTER the journaled act has committed
     * (PHASE4 R3.9).
     *
     * It exists for exactly one caller: the Venus settings route's tracking
     * PUT to the data plane. That call must not sit inside `act`, because a
     * data-plane outage would then fail an owner's settings write — and it
     * must not sit before the commit, because it would register a subject for
     * a settings row that never landed.
     *
     * A throw here is SWALLOWED and reported in `meta`, never surfaced as a
     * failed mutation: the mutation already succeeded, and the tracking
     * lifecycle has its own guaranteed convergence loop in the worker's
     * reconcile pass.
     */
    afterCommit?: (input: {
      readonly agent: AgentRecord;
    }) => Promise<Record<string, unknown>>,
  ): Promise<Response> {
    const body = await readJsonBody(c, maxBodyBytes);
    if (body.kind === "error") return body.response;

    const envelope = parseOwnerActionEnvelope(body.value);
    if (!envelope.ok) return fail(c, 401, "owner_auth_failed");
    if (requireBinding(envelope.value, expectedAction, id) !== null) {
      return fail(c, 401, "owner_auth_failed");
    }

    // (1) + (2)
    const idempotencyKey = ownerActionIdempotencyKey(envelope.value.signed);
    const prior = await deps.journal.get(idempotencyKey);
    if (prior !== null) {
      if (expectedAction === "cancelProvisioning") {
        const row = await deps.agentStore.getAgent(getAddress(prior.ownerAddress), prior.agentId);
        if (row === null) return fail(c, 503, "evidence_unreadable");
        return c.json({
          data: provisioningView(row, nowSec()),
          meta: { action: expectedAction, agentId: prior.agentId, replayed: true },
        });
      }
      return c.json({
        data: { idempotencyKey, state: prior.state, replayed: true },
        meta: { action: expectedAction, agentId: prior.agentId },
      });
    }

    // (3)
    let rateLimited = false;
    let owner: OwnerAuthResult;
    try {
      owner = await authorizeOwnerAction(envelope.value, {
        ...verifyOptions(),
        nonceStore: deps.nonceStore,
        beforeNonceConsume: (result) => {
          // Refusing HERE leaves the nonce unspent, so a rate-limited owner can
          // simply retry the same signed action later.
          if (!ownerLimiter.tryConsume(result.ownerAddress.toLowerCase())) {
            rateLimited = true;
            throw new OwnerAuthError("Per-owner rate limit exceeded.");
          }
        },
      });
    } catch (error) {
      if (rateLimited) return fail(c, 429, "rate_limited");
      if (error instanceof OwnerAuthError) return fail(c, 401, "owner_auth_failed");
      throw error;
    }

    const agent = await deps.agentStore.getAgent(owner.ownerAddress, id);
    if (agent === null) return fail(c, 404, "not_found");

    // (4)
    await deps.journal.begin({
      idempotencyKey,
      agentId: agent.id,
      ownerAddress: agent.ownerAddress,
      kind,
      ...(agent.sessionFacts === null
        ? {}
        : { externalRef: { publicKey: agent.sessionFacts.publicKey } }),
    });

    let data: Record<string, unknown>;
    try {
      data = await act({
        agent,
        params: envelope.value.params,
        ownerAction: envelope.value,
        idempotencyKey,
      });
    } catch (error) {
      await deps.journal.markRolledBack(
        idempotencyKey,
        sanitizeMessage(error instanceof Error ? error.message : "owner action failed"),
        // PHASE3.3-AUDIT A7: a refusal that HAS findings archives them on its
        // own row, where the 300-character `lastError` cannot hold them. Merged,
        // so the `publicKey` seeded at `begin` survives.
        error instanceof OwnerActionRefusal
          ? { resolution: error.evidence }
          : undefined,
      );
      if (error instanceof BadRequestError) return failBadRequest(c, error);
      if (error instanceof ConflictError) {
        return fail(c, 409, "conflict", error.message);
      }
      if (error instanceof TradeNotExecutableError) return fail(c, 409, "not_executable");
      if (error instanceof TradeCapitalTooSmallError) {
        return fail(c, 400, "capital_too_small", `Total capital must be at least ${formatEther(error.minimumWei)} BNB.`);
      }
      if (error instanceof NotFoundError) {
        // No message: the three not-found cases must be byte-identical.
        return fail(c, 404, "not_found");
      }
      if (error instanceof LpPositionNotFoundError) {
        // Same deliberate ambiguity as the agent lookup: an unknown position
        // and somebody else's position are byte-identical 404s.
        return fail(c, 404, "not_found");
      }
      if (error instanceof LpNoQuoteLegError) {
        // PHASE3.1-AUDIT A3. `runExitSaga` reads the pool's legs BEFORE any
        // sequence exists, and a pool with no configured-WBNB leg threw an
        // untyped error straight past this catch as a 500 — on the owner's
        // escape hatch, the one route that must never be unavailable.
        // Unreachable in v1 (`/lp/open` refuses such pools); typed anyway.
        return fail(c, 400, "invalid_request", error.message);
      }
      throw error;
    }

    await deps.journal.markCommitted(idempotencyKey);
    let after: Record<string, unknown> = {};
    if (afterCommit !== undefined) {
      try {
        after = await afterCommit({ agent });
      } catch {
        after = { afterCommit: "failed" };
      }
    }
    return c.json({
      data: { ...data, idempotencyKey },
      meta: { action: expectedAction, agentId: agent.id, ...after },
    });
  }

  /**
   * The LP surface (PHASE3-SPEC "API surface"; Revision 2 items 11, 16, 18–22,
   * 24, 26–27, 34–39). Same authz matrix discipline as `/trade` and the other
   * owner mutations: tenancy from the recovered signer and the persisted row,
   * wrong owner indistinguishable from missing (404), a replayed nonce refused
   * by `consume`, a byte-identical retry answered from the journal, and every
   * error body through `sanitizeMessage`.
   */
  function registerLpRoutes(lp: LpServerDeps): void {
    const gridBenchmarkCache = createGridBenchmarkCache();
    /** Digest an agent that never signed `lpSettings` runs under. */
    const defaultSettingsDigest = paramsHash("lpSettings", defaultLpSettingsParams());
    // Tests and the dev stack deliberately use the explicit snapshot
    // participant.  A durable deployment must inject the PostgreSQL
    // finalizer at boot; silently falling back to independent store writes
    // would recreate the recovery bug this capability prevents.
    const preBindRetirementFinalizer = lp.preBindRetirementFinalizer ??
      (deps.journal.snapshotLandingResolutionTransaction !== undefined &&
       deps.journal.restoreLandingResolutionTransaction !== undefined &&
       lp.store.snapshotLandingResolutionTransaction !== undefined &&
       lp.store.restoreLandingResolutionTransaction !== undefined
        ? new MemoryPreBindRetirementFinalizer({ journal: deps.journal, store: lp.store })
        : undefined);

    /**
     * MARKETPLACE-GRID-DEPLOY — the ONE public chain fact a browser needs
     * before it can sign a `gridArm`: the pool's current tick and spacing.
     *
     * WHY IT LIVES HERE rather than in the data plane. The signed grid rungs
     * are DERIVED from a tick, and `admitGridSettings` re-reads the pool and
     * refuses a signature whose `tickSpacing`/orientation disagrees with what
     * IT read. Serving the UI from `lp.readers.poolState` — the very reader
     * that cross-check uses — makes those two the same source by construction.
     * The data plane's `/pools/top` lane rows carry `tick: null` (its live
     * `slot0` path is short-circuited for any pool ON the lane, which is
     * exactly the top-TVL pools a grid wants), so deriving from it is not
     * merely a second source, it is an ABSENT one.
     *
     * PERIMETER, stated plainly: the shared `x-exec-token` and nothing else.
     * A pool tick is public chain data scoped to no owner, so there is no
     * owner signature, no session key, no agent row and no journal row on this
     * path — it reads one pool and answers. The cost it does carry is an RPC
     * read per call, bounded only by the global rate limiter.
     */
    app.get("/lp/pools/:address/state", async (c) => {
      const raw = c.req.param("address");
      if (!/^0x[0-9a-fA-F]{40}$/u.test(raw)) {
        return fail(c, 400, "invalid_request", "Not a pool address.");
      }
      let state: LpPoolStateReading;
      try {
        state = await lp.readers.poolState(getAddress(raw));
      } catch {
        // Unreadable pool or node: the caller must NOT proceed to derive a
        // geometry from a guess, so this is a refusal, never a default…
        //
        // …EXCEPT for the one failure that is not about the node (HOTFIX
        // 2026-09-05, operator): `poolState` reads the rails' TWAP via
        // `observe(window)`, which REVERTS on any pool whose observation history
        // is shorter than the window — every young or unpopular pool. The deploy
        // form only needs tick + spacing to DRAW a range, so fall back to the
        // profile reader's lighter slot0/spacing read (no TWAP) and say plainly
        // that the rails will refuse this pool at arm time. Nothing is signed or
        // spent off this answer; the arm route re-reads with the rails itself.
        if (lp.readers.tickLiquidity !== undefined) {
          try {
            const light = await lp.readers.tickLiquidity(getAddress(raw), { windowBins: 1 });
            return c.json({
              data: {
                pool: light.pool,
                currentTick: light.currentTick,
                tickSpacing: light.tickSpacing,
                blockNumber: light.blockNumber.toString(10),
                poolLiquidity: light.activeLiquidity.toString(10),
                observationCardinality: null,
                railsReady: false,
                railsReason:
                  "This pool's price history is too short for the manipulation rails (its TWAP cannot be read yet). The plane will refuse to open a position here until the pool has more observations; the range and liquidity shown are for reference only.",
              },
            });
          } catch {
            // fall through to the refusal below
          }
        }
        return fail(
          c,
          503,
          "internal_error",
          "The pool's state could not be read; no tick is available to derive a grid from.",
        );
      }
      return c.json({
        data: {
          pool: state.pool,
          currentTick: state.currentTick,
          tickSpacing: state.tickSpacing,
          // The height the tick was read at, so a caller can say how fresh the
          // geometry it signed actually was.
          blockNumber: state.evidence.blockNumber.toString(10),
          poolLiquidity: state.evidence.poolLiquidity.toString(10),
          observationCardinality: state.evidence.observationCardinality,
          railsReady: true,
          railsReason: null,
        },
      });
    });

    /**
     * LP-DEPLOY liquidity chart (2026-09-05): the pool's liquidity profile
     * around its current tick, one bin per spacing, at one finalized block.
     *
     * Same perimeter and same honesty as `/state` above: public chain data,
     * exec token only, no owner, no session, no journal — a read and an answer.
     * `window` is bins PER SIDE (default 60, at most 1000 — the chart's zoom-out ceiling). A wiring
     * without the reader answers 503, never an empty chart that reads as
     * "no liquidity". Bigints travel as decimal strings.
     */
    app.get("/lp/pools/:address/liquidity", async (c) => {
      const raw = c.req.param("address");
      if (!/^0x[0-9a-fA-F]{40}$/u.test(raw)) {
        return fail(c, 400, "invalid_request", "Not a pool address.");
      }
      const windowRaw = c.req.query("window");
      const windowBins = windowRaw === undefined ? 60 : Number(windowRaw);
      if (!Number.isInteger(windowBins) || windowBins < 1 || windowBins > 1000) {
        return fail(c, 400, "invalid_request", "window must be an integer number of bins in 1..1000.");
      }
      if (lp.readers.tickLiquidity === undefined) {
        return fail(c, 503, "internal_error", "This deployment has no tick-liquidity reader; the liquidity chart is unavailable.");
      }
      let reading: LpTickLiquidityReading;
      try {
        reading = await lp.readers.tickLiquidity(getAddress(raw), { windowBins });
      } catch {
        return fail(c, 503, "internal_error", "The pool's liquidity profile could not be read.");
      }
      return c.json({
        data: {
          pool: reading.pool,
          blockNumber: reading.blockNumber.toString(10),
          currentTick: reading.currentTick,
          tickSpacing: reading.tickSpacing,
          activeLiquidity: reading.activeLiquidity.toString(10),
          bins: reading.bins.map((bin) => ({
            tickLower: bin.tickLower,
            liquidity: bin.liquidity.toString(10),
          })),
          truncated: reading.truncated,
        },
      });
    });

    /** Stored settings, or the spec defaults — ONE digest source either way. */
    async function currentLpSettings(
      agent: AgentRecord,
    ): Promise<{ settings: LpAutomationSettings; digest: Hex }> {
      const stored = await lp.settingsStore.get(agent.ownerAddress, agent.id);
      if (stored === null) {
        return { settings: DEFAULT_LP_SETTINGS, digest: defaultSettingsDigest };
      }
      const parsed = parseLpSettingsParams(stored.params);
      if (!parsed.ok) {
        // A stored row this build cannot parse is corruption, and defaulting
        // over it would run automation under settings nobody signed.
        throw new Error("Stored LP settings are unreadable; refusing rather than defaulting.");
      }
      return { settings: parsed.value, digest: stored.digest };
    }

    function lpV1ProfileError(reason: string): never {
      throw new BadRequestError(
        `These LP settings exceed the immutable lp-v1 hire profile: ${reason}. ` +
          "Revoke the session on chain and hire again with a reviewed profile.",
      );
    }

    function enforceLpV1Profile(
      agent: AgentRecord,
      settings: LpAutomationSettings,
      budgetWei?: bigint,
    ): void {
      const hireSizing = agent.sessionFacts?.hireSizing;
      if (hireSizing?.name !== "lp-v1") return;
      if (settings.grid !== null) {
        lpV1ProfileError("grid is not supported on lp-v1 hires");
      }
      if (settings.autoRotate !== true) {
        lpV1ProfileError("autoRotate must stay true");
      }
      if (settings.maxExitSequencesPerDay > 4) {
        lpV1ProfileError("maxExitSequencesPerDay must be at most 4");
      }
      // Operator ruling 2026-09-06: floor lowered 5 → 3 minutes. Below that the
      // durable two-observation hysteresis (one worker interval apart) is the
      // effective bound anyway, so 3 is the smallest value that still means
      // something as a cooldown.
      if (settings.rotateMinHoldMinutes < 3) {
        lpV1ProfileError("rotateMinHoldMinutes must be at least 3");
      }
      if (settings.brainEnabled !== (settings.brain !== undefined)) {
        lpV1ProfileError("brainEnabled must exactly match whether a brain block is present");
      }
      if (budgetWei !== undefined && budgetWei > BigInt(hireSizing.openNativeBudgetWei)) {
        lpV1ProfileError("budgetWei exceeds the hire's openNativeBudgetWei");
      }
    }

    async function resolveLpArmPool(
      agent: AgentRecord,
      rails: LpRailConfig,
      settings: LpAutomationSettings,
      request: LpOpenRequest | LpArmRequest,
    ): Promise<{
      readonly candidate: { token0: Address; token1: Address; fee: number };
      readonly gate: Extract<LpGateResult, { ok: true }>;
      readonly selectionMeta?: LpArmMeta["selection"];
      readonly model: "custom" | "sigma";
    }> {
      if (request.pool !== undefined) {
        const result = await gateLpPool(agent, rails, request.pool);
        if (!result.ok) throw new BadRequestError(result.message);
        return {
          candidate: request.pool,
          gate: result,
          model: "custom",
        };
      }

      const rankBy =
        request.selectPool === "best-apr"
          ? "fee-apr"
          : request.selectPool?.by ?? "fee-apr";
      const orderBy = rankBy === "volume" ? "volume24hUsd" : "lpFeeApr24h";
      const discovery = lpRankedDiscoveryToken(agent.sessionFacts!.spec, lp.venue.wbnb);
      if (!discovery.ok) {
        throw new BadRequestError(
          'The persisted LP grant is not canonical enough to discover a ranking; pool selection requires exactly one sellable non-WBNB token.',
        );
      }

      const rankingNowMs = nowMs();
      const rankingMaxAgeMs = lp.runtime.rankingMaxAgeSec * 1000;
      let raw: unknown | null;
      try {
        raw = await deps.dataPlane.lpRankedPools(discovery.token, orderBy);
      } catch {
        raw = null;
      }
      const payload = raw === null ? null : parsePoolsTopEnvelope(raw, rankingNowMs);
      if (payload === null) {
        throw new BadRequestError(
          'The ranked-pools data is unavailable or malformed; deterministic selection is refused.',
        );
      }
      if (classifyLpRankingTimestamp(payload.laneAsOfMs, rankingNowMs, rankingMaxAgeMs) !== "fresh") {
        throw new BadRequestError(
          "The ranked-pools lane is stale; refusing to steer a deposit on stale market data.",
        );
      }

      const discoveryKey = discovery.token.toLowerCase();
      const wbnbKey = lp.venue.wbnb.toLowerCase();
      const universeRows = payload.pools.filter((ranked) => {
        const t0 = ranked.token0.toLowerCase();
        const t1 = ranked.token1.toLowerCase();
        return (
          (t0 === discoveryKey && t1 === wbnbKey) ||
          (t0 === wbnbKey && t1 === discoveryKey)
        );
      });
      const freshUniverseRows = universeRows.filter(
        (ranked) =>
          classifyLpRankingTimestamp(ranked.rowAsOfMs, rankingNowMs, rankingMaxAgeMs) === "fresh",
      );
      if (universeRows.length > 0 && freshUniverseRows.length === 0) {
        throw new BadRequestError(
          "Every ranked pool in the persisted token/WBNB universe is stale; refusing to steer a deposit on stale market data.",
        );
      }

      const candidates = freshUniverseRows.slice(0, lp.runtime.maxRankedCandidates);
      const gates = new Map<string, Extract<LpGateResult, { ok: true }>>();
      const passed = new Set<string>();
      const factoryBoundCandidates: LpRankedPool[] = [];
      for (const ranked of candidates) {
        const result = await gateLpPool(agent, rails, ranked, ranked.pool);
        if (!result.ok) continue;
        const key = result.pool.toLowerCase();
        gates.set(key, result);
        passed.add(key);
        factoryBoundCandidates.push({ ...ranked, pool: result.pool });
      }
      const selection = selectLpPool({
        pools: factoryBoundCandidates,
        minAprBps: settings.minAprBps,
        rankBy,
        gatesPassed: passed,
      });
      if (!selection.ok) throw new BadRequestError(selection.reason);
      const chosen = selection.head;
      const chosenGate = gates.get(chosen.pool.pool.toLowerCase());
      if (chosenGate === undefined) {
        throw new BadRequestError("The selected pool lost its admission state; refusing.");
      }
      return {
        candidate: {
          token0: chosen.pool.token0,
          token1: chosen.pool.token1,
          fee: chosen.pool.fee,
        },
        gate: chosenGate,
        model: "sigma",
        selectionMeta: {
          rankBy,
          orderBy,
          window: "24h",
          laneAsOfMs: payload.laneAsOfMs,
          source: payload.source,
          total: payload.total,
          matched: payload.matched,
          returned: payload.returned,
          cap: payload.cap,
          ingestOrder: payload.ingestOrder,
          rowDropCounts: {
            ...payload.rowDropCounts,
            outsideUniverse: payload.pools.length - universeRows.length,
            staleRow: universeRows.length - freshUniverseRows.length,
            candidateCapOmitted: freshUniverseRows.length - candidates.length,
          },
          survivors: selection.survivors.map((entry) => ({
            pool: entry.pool.pool,
            aprBps: entry.aprBps.toString(10),
            aprSource: entry.pool.aprSource,
            tvlUsdE6: entry.pool.tvlUsdE6.toString(10),
            volume24hUsdE6: entry.pool.volume24hUsdE6.toString(10),
            rowAsOfMs: entry.pool.rowAsOfMs,
          })),
          head: selection.head.pool.pool,
          chosen: chosen.pool.pool,
        },
      };
    }

    function resolveLpOpenRange(
      gateState: Extract<LpGateResult, { ok: true }>["state"],
      range: {
        readonly kind: "explicit";
        readonly tickLower: number;
        readonly tickUpper: number;
      } | { readonly kind: "server-fenced" },
    ): { readonly tickLower: number; readonly tickUpper: number } {
      const spacing = gateState.tickSpacing;
      const currentTick = gateState.currentTick;
      if (range.kind === "explicit") {
        const { tickLower: lo, tickUpper: hi } = range;
        if (lo % spacing !== 0 || hi % spacing !== 0) {
          throw new BadRequestError("The signed range is not snapped to the pool's tick spacing.");
        }
        if (lo < MIN_TICK || hi > MAX_TICK) {
          throw new BadRequestError("The signed range is outside the global tick bounds.");
        }
        const width = hi - lo;
        if (width < 2 * spacing || width > lp.runtime.maxTickWidth) {
          throw new BadRequestError(
            `The signed range width ${width} is outside [${2 * spacing}, ${lp.runtime.maxTickWidth}].`,
          );
        }
        if (!(lo <= currentTick && currentTick < hi)) {
          throw new BadRequestError(
            "v1 opens a two-sided in-range position; the signed range does not contain the current tick.",
          );
        }
        return { tickLower: lo, tickUpper: hi };
      }
      return centeredRotationRange({
        currentTick,
        priorWidthTicks: Math.max(2 * spacing, lp.runtime.defaultOpenWidthTicks),
        tickSpacing: spacing,
      });
    }

    async function ownerLandingMutation(
      c: Context,
      id: string,
      act: (input: {
        readonly agent: AgentRecord;
        readonly params: unknown;
        readonly idempotencyKey: string;
      }) => Promise<ResolveLandingV1Result>,
    ): Promise<Response> {
      const body = await readJsonBody(c, maxBodyBytes);
      if (body.kind === "error") return body.response;
      const envelope = parseOwnerActionEnvelope(body.value);
      if (!envelope.ok || requireBinding(envelope.value, "resolveUnknownLandingV1", id) !== null) {
        return fail(c, 401, "owner_auth_failed");
      }
      const idempotencyKey = ownerActionIdempotencyKey(envelope.value.signed);
      const prior = await deps.journal.get(idempotencyKey);
      if (prior?.externalRef.landingResult !== undefined) {
        return c.json({ data: prior.externalRef.landingResult,
          meta: { action: "resolveUnknownLandingV1", agentId: prior.agentId } });
      }

      let agent: AgentRecord | null;
      if (prior === null) {
        let rateLimited = false;
        let owner: OwnerAuthResult;
        try {
          owner = await authorizeOwnerAction(envelope.value, {
            ...verifyOptions(), nonceStore: deps.nonceStore,
            beforeNonceConsume: (result) => {
              if (!ownerLimiter.tryConsume(result.ownerAddress.toLowerCase())) {
                rateLimited = true;
                throw new OwnerAuthError("Per-owner rate limit exceeded.");
              }
            },
          });
        } catch (error) {
          if (rateLimited) return fail(c, 429, "rate_limited");
          if (error instanceof OwnerAuthError) return fail(c, 401, "owner_auth_failed");
          throw error;
        }
        agent = await deps.agentStore.getAgent(owner.ownerAddress, id);
        if (agent === null) return fail(c, 404, "not_found");
        await deps.journal.begin({ idempotencyKey, agentId: agent.id,
          ownerAddress: agent.ownerAddress, kind: "resolveUnknownLandingV1" });
      } else {
        if (prior.kind !== "resolveUnknownLandingV1" || prior.agentId !== id) {
          return fail(c, 409, "conflict");
        }
        agent = await deps.agentStore.getAgent(getAddress(prior.ownerAddress), id);
        if (agent === null) return fail(c, 404, "not_found");
      }

      try {
        const result = await act({ agent, params: envelope.value.params, idempotencyKey });
        if (result.kind === "in-progress") {
          const actionRow = await deps.journal.get(idempotencyKey);
          if (actionRow?.state === "PENDING") {
            await deps.journal.markInProgress(idempotencyKey, {
              landingAction: { scheme: "resolve-landing-action-v1",
                resolutionId: result.resolutionId, state: "IN_PROGRESS" },
            });
          }
          return c.json({ data: { decisionId: result.decisionId,
            resolutionId: result.resolutionId, state: "IN_PROGRESS", replayed: true },
            meta: { action: "resolveUnknownLandingV1", agentId: agent.id } }, 202);
        }
        await deps.journal.completeLandingAction(idempotencyKey, {
          landingAction: { scheme: "resolve-landing-action-v1",
            resolutionId: result.data.resolutionId, state: "TERMINAL",
            completionRole: result.completionRole },
          landingResult: result.data,
        });
        return c.json({ data: result.data,
          meta: { action: "resolveUnknownLandingV1", agentId: agent.id } });
      } catch (error) {
        const actionRow = await deps.journal.get(idempotencyKey);
        if (actionRow?.state === "PENDING") {
          await deps.journal.markRolledBack(idempotencyKey,
            sanitizeMessage(error instanceof Error ? error.message : "landing resolution failed"));
        }
        if (error instanceof BadRequestError) return fail(c, 400, "invalid_request", error.message);
        if (error instanceof NotFoundError || error instanceof LpPositionNotFoundError) {
          return fail(c, 404, "not_found");
        }
        throw error;
      }
    }

    /**
     * R11 (Rev2 item 24): the pool's non-WBNB leg runs the FULL trade
     * forbidden set PLUS the NFPM and the pinned V3 router. WBNB's own
     * presence in the trade set is exactly why the set is adapted here rather
     * than reused blind — the WBNB LEG is checked by identity instead.
     */
    function lpForbiddenTokens(agent: AgentRecord): ReadonlySet<string> {
      const out = new Set(
        forbiddenTokenAddresses({
          wallet: agent.walletAddress,
          keyStore: config.keyStore,
          venues: trade.venues,
          ...(trade.feeTreasury === undefined ? {} : { treasury: trade.feeTreasury }),
        }),
      );
      out.add(lp.venue.nfpm.toLowerCase());
      out.add(lp.venue.routerV3.toLowerCase());
      return out;
    }

    /**
     * Item 35, verbatim: the EXISTING predicates and no third one — the
     * persisted snapshot first (`grantsTokenSell`, free), the chain's own
     * answer on refusal (`canSessionSellToken`, FINDINGS (t)/(z)), union
     * semantics, an RPC blip degrading reach but never safety.
     */
    async function sessionCanSell(agent: AgentRecord, token: Address): Promise<boolean> {
      const facts = agent.sessionFacts;
      if (facts === null) return false;
      if (grantsTokenSell(facts.spec, token)) return true;
      try {
        return await deps.providerRegistry.get(config.chainId).canSessionSellToken({
          wallet: {
            address: agent.walletAddress,
            chainId: config.chainId,
            ownerAddress: agent.ownerAddress,
            custodyModel: agent.custodyModel,
          },
          sessionPublicKey: facts.publicKey,
          token,
        });
      } catch {
        return false;
      }
    }

    type LpGateResult =
      | {
          readonly ok: true;
          readonly pool: Address;
          readonly state: LpPoolStateReading;
          readonly token: Address;
        }
      | { readonly ok: false; readonly message: string };

    /**
     * What `admitGridSettings` hands back (PHASE3.16).
     *
     * `view` is the receipt evidence, exactly as before. `gate` and
     * `wbnbIsToken0` are carried so the ARM route can run its G-gate against
     * THE SAME POOL READ the admission already took (R2.6's one constraint) —
     * two reads in one request can disagree, and a route that admits on one
     * tick and refuses on another contradicts its own admission evidence.
     */
    type GridAdmission = {
      readonly view: Record<string, unknown>;
      readonly gate: Extract<LpGateResult, { ok: true }>;
      readonly wbnbIsToken0: boolean;
    };

    /**
     * The ONE admission surface (Rev2 item 34, NORMATIVE ordering): a pool is
     * a candidate only if it would be accepted when named explicitly. Runs
     * for the explicitly-named pool AND for every ranked candidate — rails
     * first, ranking second; `selectPool: "best-apr"` is a convenience over
     * an unchanged safety surface, never a second, softer admission path.
     */
    async function gateLpPool(
      agent: AgentRecord,
      rails: LpRailConfig,
      candidate: { readonly token0: Address; readonly token1: Address; readonly fee: number },
      expectedPool?: Address,
    ): Promise<LpGateResult> {
      const wbnb = lp.venue.wbnb.toLowerCase();
      const t0 = candidate.token0.toLowerCase();
      const t1 = candidate.token1.toLowerCase();
      if (t0 === t1) {
        return { ok: false, message: "The pool's legs must be two distinct tokens." };
      }
      // The WBNB leg is checked BY IDENTITY against the configured WBNB;
      // anything else claiming to be the WBNB leg is refused (R11).
      const wbnbLeg = t0 === wbnb ? 0 : t1 === wbnb ? 1 : null;
      if (wbnbLeg === null) {
        return {
          ok: false,
          message: "The pool has no WBNB leg; v1 refuses pools without one (fail-closed).",
        };
      }
      const token = wbnbLeg === 0 ? candidate.token1 : candidate.token0;
      if (lpForbiddenTokens(agent).has(token.toLowerCase())) {
        return { ok: false, message: `The pool's non-WBNB leg is not an LP-eligible token.` };
      }
      // open ⇒ exitable (item 35, the 2.3 R1 rule transposed) — BEFORE any
      // money, and for BOTH legs: a position whose session cannot move a leg
      // is FINDINGS (h)/(u) with an NFT attached.
      if (!(await sessionCanSell(agent, token))) {
        return {
          ok: false,
          message:
            "The session cannot sell the pool's token leg — it needs both a spend cap and an approve allowlist entry — so the position could be opened and never exited.",
        };
      }
      if (!(await sessionCanSell(agent, lp.venue.wbnb))) {
        return {
          ok: false,
          message:
            "The session cannot move WBNB — it needs both a spend cap and an approve allowlist entry — so the position could be opened and never exited.",
        };
      }
      let pool: Address | null;
      try {
        const resolved = await lp.readers.getPool(
          candidate.token0,
          candidate.token1,
          candidate.fee,
        );
        pool = resolved === null ? null : getAddress(resolved);
      } catch {
        pool = null;
      }
      if (pool === null) {
        return { ok: false, message: "No pool exists for these legs at this fee tier." };
      }
      // Phase 3.10 R6: ranked market evidence is about one concrete pool, not
      // merely a token tuple. Bind it to the factory answer before spending a
      // pool-state RPC. Explicit opens pass no expected address and preserve
      // their existing factory-authoritative behaviour.
      if (
        expectedPool !== undefined &&
        pool.toLowerCase() !== expectedPool.toLowerCase()
      ) {
        return {
          ok: false,
          message:
            "The ranked pool address does not match the factory pool for those legs and fee; the candidate is refused.",
        };
      }
      let state: LpPoolStateReading;
      try {
        state = await lp.readers.poolState(pool);
      } catch {
        // TWAP availability is an admission gate (item 34): a pool whose
        // observations cannot be read is a pool the automation cannot manage.
        return {
          ok: false,
          message: "The pool's TWAP observations could not be read; a position there would be unmanageable.",
        };
      }
      if (state.evidence.observationCardinality < rails.minObservationCardinality) {
        // R8 (Rev2 item 19): refused AT OPEN, with the permissionless remedy
        // named — on a cardinality-1 pool `observe()` "succeeds" by
        // extrapolating one stale observation, a TWAP in name only.
        return {
          ok: false,
          message:
            `Pool observation cardinality ${state.evidence.observationCardinality} is below the required minimum ` +
            `${rails.minObservationCardinality}; a position there would be permanently unmanageable by the automation. ` +
            `Anyone may call increaseObservationCardinalityNext on the pool (permissionless) and retry once the ring buffer grows.`,
        };
      }
      if (state.evidence.poolLiquidity < rails.minPoolLiquidity) {
        return { ok: false, message: "Pool liquidity is below the manipulation-rail minimum." };
      }
      if (state.evidence.twapSqrtPriceX96 <= 0n || state.evidence.spotSqrtPriceX96 <= 0n) {
        return { ok: false, message: "The pool reports no usable TWAP." };
      }
      return { ok: true, pool, state, token };
    }

    /** The saga deps for one position's pool, over the injected readers. */
    function lpSagaDeps(
      agent: AgentRecord,
      rails: LpRailConfig,
      settings: LpAutomationSettings,
      digest: Hex,
      pool: Address,
    ): LpSagaDeps {
      return {
        agent,
        agentStore: deps.agentStore,
        provider: deps.providerRegistry.get(config.chainId),
        journal: deps.journal,
        store: lp.store,
        ...(lp.feeEvents === undefined ? {} : { feeEvents: lp.feeEvents }),
        killswitch: deps.killswitch,
        rails,
        quota: {
          maxExitSequencesPerDay: settings.maxExitSequencesPerDay,
          minMinutesBetweenExits: settings.minMinutesBetweenExits,
        },
        market: async () => {
          const state = await lp.readers.poolState(pool);
          return { ...state.evidence, currentTick: state.currentTick };
        },
        positions: lp.readers.positions,
        quote: lp.readers.quote,
        // PHASE3.17 R3.3 — carried only when the wiring has it. The dual grid
        // arm's plan is the one consumer; every other saga ignores it.
        ...(lp.readers.quoteWithPriceAfter === undefined
          ? {}
          : { quoteWithPriceAfter: lp.readers.quoteWithPriceAfter }),
        receipts: lp.readers.receipts,
        expectedPool: pool,
        conversionCompatibleTokens: lp.runtime.conversionCompatibleTokens,
        settingsDigest: digest,
        currentSettingsDigest: async () => (await currentLpSettings(agent)).digest,
        // PHASE3.1 Rev2 item 8: from the owner's OWN settings, never a default.
        exitToQuote: settings.exitToQuote,
        // PHASE3.13 F12, same rule: the harvest range refusal's remedy is
        // conditional on the owner's own rotation flag, so the flag is a
        // required dep rather than a guess. `rotateMode` is deliberately NOT
        // here — the server dispatches no rotate, and it lives on
        // `LpRotateDeps` for exactly that reason (review F9).
        autoRotate: settings.autoRotate,
        // Item 17's dust floor. `LpServerDeps.relayFeePerSubmitWei` is optional
        // only so a hand-built deps object (tests) need not supply it;
        // `buildLpServerDeps` always resolves it from
        // `LP_RELAY_FEE_PER_SUBMIT_WEI`, so the fallback is unreachable in a
        // wired deployment.
        relayFeePerSubmitWei:
          lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI,
        venue: lp.venue,
        now: nowMs,
        deadlineSec: trade.deadlineSec,
      };
    }

    /**
     * The sizing invariant's BUDGET term (PHASE3.4 Rev2 M12 / decision 9(1)).
     *
     * `openNativeBudgetWei` models ONE real outflow: the open's `mint{value}`,
     * the only native any LP saga attaches (rotations and harvests pay their
     * principal in WBNB — PHASE3 Rev2 item 14). An IMPORTED position never ran
     * that step and never will, so summing its declared basis in would inflate
     * the required cap by a number describing no spending at all.
     *
     * That is not a rounding concern. `/lp/settings` is also how an owner turns
     * automation OFF, and it refuses on a shortfall — so a large declared basis
     * would lock the owner out of the off switch on the strength of a number
     * they merely asserted. Imported rows still count in `openPositionsCount`,
     * because an imported position's protect burns exactly the same relay gas.
     */
    function lpOpenNativeBudgetWei(
      positions: readonly LpPositionRecord[],
    ): bigint {
      return positions.reduce((total, position) => {
        switch (position.basisSource) {
          case "owner-budget":
            return total + position.basisWei;
          case "imported":
            // Nothing was metered: the import moves no money at all.
            return total;
          case "minted":
            /*
             * PHASE3.16 R2.5 / review H2 — AN EXPLICIT NAMED CASE, and it
             * exists to make a residual GREPPABLE rather than to change a
             * number. Falling through the old `!== "owner-budget"` branch would
             * have produced the identical zero silently.
             *
             * THE RESIDUAL, stated where it is created: the grid arm IS the
             * first grid operation that attaches native — 3.15 had none (the
             * entry was an import, which moves nothing, and the flip is
             * keep-WBNB and native-cap-neutral) — and it records `basisWei: 0n`
             * because a ping-pong's inventory alternates assets and a
             * lineage-basis TP/SL would misfire on it. So the arm spends
             * `budgetWei` against the on-chain rolling native meter while every
             * LATER `/lp/settings` or `/lp/import` sizing check on that agent
             * models the budget term as ZERO for the rest of the rolling 24 h
             * window, and can admit a settings change the meter cannot support.
             *
             * MITIGATION, and it is the whole of it: the ARM'S OWN sizing check
             * sees the budget (it passes `lpOpenNativeBudgetWei(existing) +
             * budgetWei`). Nothing after the arm does. Recording a non-zero
             * basis is NOT the fix — that would break 3.15's basis rule and
             * misfire the TP/SL — so the gap is named rather than papered over.
             *
             * PHASE3.17 R2.11 residual 1 — THE RESIDUAL NOW COVERS UP TO TWO
             * ARMED BUDGETS PER ROLLING 24 h, not one. A DUAL arm writes TWO
             * `"minted"` rows from ONE budget, and this case returns zero for
             * each of them; the magnitude of what later sizing checks cannot see
             * is unchanged per BUDGET (both rows come from the same one) but the
             * number of invisible ROWS doubles, and a restart-after-abandon
             * inside the same window can arm a second budget on top. The
             * mitigation is identical and so is its limit: the arm's own check
             * sees its own budget, and nothing after it sees any of them.
             */
            return total;
        }
      }, 0n);
    }

    /**
     * PHASE3.15 — the grid block's CHAIN-and-CONFIG admission, and nothing
     * else (R2.8's three-way split; the shape lives in `lpWire.ts`, the ranges
     * and their ordering in `validateLpSettings`).
     *
     * Returns the evidence for the receipt, or `null` when the params carry no
     * grid block. Every failure is a `BadRequestError` naming its remedy.
     *
     * SIX CHECKS, each with its reason:
     *
     *  1. `GRID_ENABLED` off ⇒ REFUSE the params outright, so nobody signs
     *     settings this runtime cannot honour (the F8/A1 shape: a flag that
     *     enables nothing while the server looks healthy).
     *  2. `gateLpPool` VERBATIM — the same admission an explicit-pool open and
     *     an import run: WBNB leg by identity, the LP forbidden set,
     *     `sessionCanSell` on BOTH legs, pool existence, TWAP readability,
     *     cardinality, liquidity.
     *  3. C1's CROSS-CHECK: the SIGNED `wbnbIsToken0` and `tickSpacing` are
     *     compared against this route's own pool read, and a mismatch names
     *     both values. They are signed rather than injected because
     *     `paramsHash` is recomputed over the caller's params — a field the
     *     route added before hashing would not verify — and they must be signed
     *     rather than absent because `validateLpSettings` is pure and cannot
     *     otherwise run the spacing and orientation checks R2.8 gives it.
     *  4. The `LP_MAX_TICK_WIDTH` ceiling, which is CONFIG and so cannot live
     *     in the pure validator.
     *  5. The IDLE GATE, at FIRST ARMING ONLY (M3): the transition INTO grid
     *     mode requires no live non-grid position and no non-terminal sequence.
     *     A later re-sign is deliberately allowed while sequences are in flight
     *     — moving the ranges is the most likely thing a live grid owner wants
     *     — and is handled by the EXISTING settings-digest mismatch refusal
     *     between saga steps.
     *  6. C2, the rule that guards the path (5) opens: while a grid position is
     *     LIVE, a re-sign is accepted only if one of the NEW ranges equals the
     *     live level's ticks EXACTLY (so the flip's target is always defined)
     *     AND the R2.10 net-edge admission passes at that position's current
     *     `exitValueWei` (so an owner cannot narrow the spread below the gas
     *     floor after an admission that only ever ran at import).
     *
     * ─── PHASE3.16 C1: THE CALL-PURPOSE DISCRIMINANT ────────────────────────
     *
     * `purpose: "arm"` runs checks 1–4 AND RETURNS. It runs neither the idle
     * gate (5) nor C2 (6), and the reason is not tidiness:
     *
     *  - C2 would evaluate `gridNetEdge` a SECOND time in one request, on the
     *    LIVE LEVEL's `exitValueWei` and worded "Grid re-sign refused" — on a
     *    request that is not a re-sign and whose actual defect is that the
     *    agent already holds a level. The owner would read a text about the
     *    wrong quantity and never be told the real remedy. Two texts for one
     *    quantity is the 3.13 cannot-diverge failure;
     *  - C2 would also make an on-chain `positions()` + `valueLpPosition` read
     *    pair the arm has no use for, whose FAILURE refuses the arm with "a
     *    grid re-sign that cannot be sized is refused";
     *  - the idle gate (5) is redundant under the arm's own, STRICTER gate, and
     *    it fires only on the `!alreadyGrid` shape, so relying on it would give
     *    the two stored-settings shapes two different remedies for one state.
     *
     * The arm's own gate (at the route) is therefore the SOLE idle authority
     * for the arm on BOTH stored-settings shapes. Checks 1–4 are never
     * duplicated at the route — that duplication is what this discriminant
     * exists to avoid.
     */
    async function admitGridSettings(
      agent: AgentRecord,
      grid: LpGridSettings | null,
      purpose: "settings" | "arm" = "settings",
    ): Promise<GridAdmission | null> {
      if (grid === null) return null;
      if (lp.gridEnabled !== true) {
        throw new BadRequestError(
          "This deployment has not enabled the grid agent (GRID_ENABLED). Signing a grid block the runtime cannot honour would arm nothing, so it is refused rather than stored.",
        );
      }
      const rails = requireRails();
      const gate = await gateLpPool(agent, rails, grid.pool);
      if (!gate.ok) throw new BadRequestError(gate.message);

      // C1's cross-check. The signed orientation and spacing decide EVERY later
      // comparison — the ordering constraint, the alignment check, the flip's
      // side rule — so a wrong one is a strategy inverted for half of BSC's
      // pools (the 3.13 F7 shape).
      const wbnbIsToken0 =
        grid.pool.token0.toLowerCase() === lp.venue.wbnb.toLowerCase();
      if (grid.wbnbIsToken0 !== wbnbIsToken0) {
        throw new BadRequestError(
          `The signed grid.wbnbIsToken0 (${grid.wbnbIsToken0}) does not match this pool: WBNB is ${wbnbIsToken0 ? "token0" : "token1"} here. Every side rule in the grid is decided by that flag, so it is cross-checked rather than trusted.`,
        );
      }
      if (grid.tickSpacing !== gate.state.tickSpacing) {
        throw new BadRequestError(
          `The signed grid.tickSpacing (${grid.tickSpacing}) does not match the pool's own (${gate.state.tickSpacing}); a range aligned to the wrong spacing would revert at the mint.`,
        );
      }
      // PHASE3.18 C10 — in POLICY mode the load-bearing width check is on the
      // POLICY, because every future rung the requote derives inherits it and
      // none of them passes through the four-rung loop above. That loop is the
      // INITIAL-PLACEMENT half of the same guarantee.
      //
      // The residual is named rather than fixed: a FIXED-mode DUAL grid still
      // has only 2 of its 4 rungs width-checked here (inherited from 3.17,
      // unchanged by this phase). It lives at the ROUTE and not in
      // `validateLpSettings` for the reason 3.15 put the rung ceiling here —
      // `LP_MAX_TICK_WIDTH` is deployment CONFIG the pure validator cannot see.
      //
      // IT RUNS FIRST, ahead of the rung loop below: under the R2.1 coherence
      // rule a coherent grid's rungs carry the policy width exactly, so both
      // checks would fire on the same input and the rung loop's message — which
      // names one rung and not the geometry that governs every future one —
      // would be the sentence an owner reads.
      if (grid.policy !== undefined && grid.policy.widthTicks > lp.runtime.maxTickWidth) {
        throw new BadRequestError(
          `grid.policy.widthTicks is ${grid.policy.widthTicks}, over this deployment's LP_MAX_TICK_WIDTH of ${lp.runtime.maxTickWidth}. In policy mode every rung the requote ever derives inherits this width, so it is checked on the policy and not only on the four signed rungs.`,
        );
      }
      for (const [name, range] of [
        ["buyRange", grid.buyRange],
        ["sellRange", grid.sellRange],
      ] as const) {
        const width = range.tickUpper - range.tickLower;
        if (width > lp.runtime.maxTickWidth) {
          throw new BadRequestError(
            `grid.${name} is ${width} ticks wide, over this deployment's LP_MAX_TICK_WIDTH of ${lp.runtime.maxTickWidth}.`,
          );
        }
      }

      // PHASE3.16 C1. Checks 1–4 are done; the arm stops HERE, deliberately
      // before any store read, so nothing below can execute on its behalf.
      if (purpose === "arm") {
        return {
          gate,
          wbnbIsToken0,
          view: {
            pool: gate.pool,
            wbnbIsToken0,
            tickSpacing: gate.state.tickSpacing,
            currentTick: gate.state.currentTick,
            armed: "arm",
          },
        };
      }

      const positions = await lp.store.listPositions(agent.ownerAddress, agent.id);
      const live = positions.filter((position) => position.state !== "closed");
      const stored = await lp.settingsStore.get(agent.ownerAddress, agent.id);
      const parsedStored =
        stored === null ? null : parseLpSettingsParams(stored.params);
      const alreadyGrid =
        parsedStored !== null && parsedStored.ok && parsedStored.value.grid !== null;

      if (!alreadyGrid) {
        // (5) FIRST ARMING ONLY. The gate is about STRATEGY COHERENCE, not
        // about the one-live-token index: that index is sound under a flip
        // because the row is REPLACED (`updatePositionTokenId`), not added, and
        // the mint→row-update window is protected by the IMPORT route's own
        // non-terminal-sequence refusal, which is unchanged (OQ8/C8). What this
        // gate buys is that there is no ambiguity about which position the grid
        // owns at the moment it starts owning one.
        if (live.length > 0) {
          throw new BadRequestError(
            // PHASE3.16 M3/C6: this text is reachable from the ARM route's own
            // pre-flight in earlier drafts and named a workflow the arm
            // replaces. The entry path is now POST /agents/:id/lp/grid/arm.
            `This agent holds ${live.length} live LP position(s) that predate the grid. Arming a grid on an agent whose positions it did not admit leaves no defined answer to "which position is the grid level"; exit or close them first, then sign gridArm (POST /agents/:id/lp/grid/arm), which places the first level itself. Hand-minting on PancakeSwap and importing remains a second door.`,
          );
        }
        const blocking = await lp.store.getAnyNonTerminalSequence(
          agent.ownerAddress,
          agent.id,
        );
        if (blocking !== null) {
          throw new BadRequestError(
            `This agent has a non-terminal ${blocking.kind} sequence (${blocking.sequenceId}); arming a grid is refused until it settles.`,
          );
        }
        return {
          gate,
          wbnbIsToken0,
          view: {
          pool: gate.pool,
          wbnbIsToken0,
          tickSpacing: gate.state.tickSpacing,
          currentTick: gate.state.currentTick,
          armed: "first",
          // PHASE3.16 M3: the entry path is the ARM. Hand-minting and importing
          // is still legal and still works — it is named second, as the door it
          // now is rather than as the only one.
          note:
            // PHASE3.18 R2.5: the import alternative is scoped to FIXED mode.
            // A policy-mode grid's rungs float, and import admits only at a
            // signed rung verbatim.
            `The grid is armed but holds no level yet. Sign gridArm (POST /agents/:id/lp/grid/arm) with a native budgetWei and the agent places the first level itself, single-sided into the signed buyRange, in one signature.${
              gridModeOf(grid) === "policy"
                ? " This grid is in policy mode, where rungs float, so gridArm is the ONLY door: import admits a position only at a signed rung verbatim."
                : " Alternatively mint a single-sided range order by hand on PancakeSwap at exactly one of the signed ranges and POST /agents/:id/lp/import it with basisWei 0."
            }`,
          },
        };
      }

      // (6) C2 — the guard on the re-sign path (5) deliberately opens.
      //
      // PHASE3.17 R3.1 (review2 N1): EVERY live grid position, never `find`-one,
      // and matched against the UP-TO-FOUR signed ranges rather than pair 1's
      // two. The old shape broke twice under a dual grid — it left level 2
      // unguarded (an `lpSettings` that moved or cleared `buyRange2`/
      // `sellRange2` while level 2 was live would pass, strand it with no flip
      // target, and leave it dead to automation until a manual exit: precisely
      // the state C2 exists to make unreachable), and if `listPositions`
      // happened to return level 2's row first it REFUSED a perfectly valid
      // re-sign with a text naming ranges that were never that level's.
      //
      // This is also the door through which a dual grid's owner MOVES ranges
      // after arming: the `levels` <=> pair-2 cross-rule is scoped to the
      // `gridArm` ROUTE only (an `lpSettings` envelope has no `levels` field),
      // so settings-only re-signs of a live dual grid are the supported path,
      // and this multi-level form is what keeps them safe.
      const gridPositions = live.filter(
        (position) =>
          position.token0.toLowerCase() === grid.pool.token0.toLowerCase()
          && position.token1.toLowerCase() === grid.pool.token1.toLowerCase()
          && position.fee === grid.pool.fee
          && position.tokenId !== null,
      );
      const gridPosition = gridPositions[0];
      if (gridPosition === undefined || gridPosition.tokenId === null) {
        // No live level: nothing to strand, and the import route will re-run
        // the whole admission when one arrives.
        return {
          gate,
          wbnbIsToken0,
          view: {
          pool: gate.pool,
          wbnbIsToken0,
          tickSpacing: gate.state.tickSpacing,
          currentTick: gate.state.currentTick,
          armed: "re-signed",
          // PHASE3.16 M3: this is the path a RESTART takes after an abandon
          // closed the row, so it is the text most likely to be read by an
          // owner deciding what to do next.
          note:
            // PHASE3.18 R2.5: same scoping — see the "armed: first" note above.
            `Re-signed with no live level. Sign gridArm (POST /agents/:id/lp/grid/arm) with a native budgetWei to place the next level automatically;${
              gridModeOf(grid) === "policy"
                ? " in policy mode that is the only door, because import admits only at a signed rung verbatim and this grid's rungs float."
                : " an import re-runs the full admission if you would rather mint it by hand."
            }`,
          },
        };
      }
      // ─── PHASE3.19 item 35 (review H5, OQ6) — THE MODE-CHANGE REFUSAL ────
      //
      // BEFORE the per-level loop, symmetric over all ordered pairs, and active
      // ONLY while a live level exists. A mode change with NO live level is and
      // must remain legal — that is the restart path.
      //
      // It is EXPLICIT rather than inherited because `ladder -> policy` PASSES
      // EVERY SHIPPED C2 CHECK on the level-1 row: identity resolves from the
      // durable columns, reproducibility holds if the owner signs the natural
      // matching width, the side rule holds by the ladder's own invariant, and
      // the net edge prices on a signed counter-rung that still exists. From
      // that instant the position is driven by a different machine, spending a
      // different lane, toward a target that may be far from the price — which
      // is FINDINGS (ax) reproduced by a settings change. `ladder -> fixed` is
      // already refused, but BY ACCIDENT (a floated rung matches no signed
      // rung), and an accident is not a guard.
      const storedMode =
        parsedStored !== null && parsedStored.ok && parsedStored.value.grid !== null
          ? gridModeOf(parsedStored.value.grid)
          : null;
      //
      // ─── DEVIATION D-1, DECLARED: THE GUARD IS SCOPED TO LADDER PAIRS ────
      //
      // Item 35's literal form ("symmetric over all six ordered pairs") would
      // also refuse `fixed -> policy` under a live level — and that transition is
      // a SHIPPED, TESTED MIGRATION: 3.18's M7 backfill exists precisely to run
      // at that moment, because it is the LAST INSTANT a live rung's identity is
      // provable by tick match. Implementing item 35 literally would silently
      // retire M7 and break two shipped 3.18 assertions, which §7's
      // compatibility guarantee forbids and which no normative layer asks for.
      //
      // H5's finding is entirely about LADDER: its walk is a live LADDER rung
      // passing every C2 check on the way into policy mode, and its note is that
      // `ladder -> fixed` is refused only by accident. So the guard covers every
      // ordered pair in which EITHER side is `"ladder"` — all four of them —
      // and leaves the `fixed <-> policy` pair to M7, which already governs it.
      // Recorded as a deviation in the build doc rather than resolved silently.
      //
      // ─── PHASE3.22 R2 / R2.18 — THE RULE IS EXTENDED BY ONE MODE ─────────
      //
      // "Mode changes under a live level are refused for any pair involving
      // `"shift"`" — the D-1 rule with the same reasoning, one mode later and
      // MORE forcefully. A shift's rungs float from its first motion, so no
      // signed rung ever matches one again; its rows are paired by
      // `arm_group_id` and moved by a saga that assumes both; and it is the
      // only mode whose sequence has no in-plane resolver. A live shift level
      // reinterpreted as a ladder rung — or a live ladder rung reinterpreted
      // as half a shift pair — is a position driven by a machine that was
      // never told about it.
      //
      // The `fixed <-> policy` pair is STILL left to 3.18's M7 backfill, for
      // the reason D-1 records: that transition is a shipped, tested migration
      // and refusing it would silently retire M7.
      const ladderPair = gridModeOf(grid) === "ladder" || storedMode === "ladder";
      const shiftPair = gridModeOf(grid) === "shift" || storedMode === "shift";
      if (
        storedMode !== null
        && gridModeOf(grid) !== storedMode
        && (ladderPair || shiftPair)
        && gridPositions.length > 0
      ) {
        throw new BadRequestError(
          lpGridModeChangeRefusal({
            liveLevels: gridPositions.length,
            storedMode,
            newMode: gridModeOf(grid),
          }),
        );
      }

      // EVERY live level, each matched and each priced on ITS OWN PAIR.
      const liveLevels: Record<string, unknown>[] = [];
      /** The 3.15/3.16 `liveLevel` shape, kept byte-identical for one level. */
      const legacyLevels: Record<string, unknown>[] = [];
      const edges: LpGridNetEdge[] = [];
      /** PHASE3.18 M7 — identity writes owed, applied only if EVERY level passes. */
      const backfills: {
        positionId: string;
        gridLevel: LpGridLevelValue;
        gridRole: LpGridRoleValue;
      }[] = [];
      for (const position of gridPositions) {
        const tokenId = position.tokenId;
        if (tokenId === null) continue;
        const snapshot = await lp.readers.positions(BigInt(tokenId));
        if (snapshot === "burned") {
          throw new BadRequestError(
            "A live grid level's NFT is burned on chain; close the position row before re-signing the grid.",
          );
        }
        // PHASE3.18 R2.7/C1 — C2's CHECK 1 in policy mode, and 3.17's exact-tick
        // rule in fixed mode. The identity comes from the durable columns under
        // policy, because a requoted rung equals no signed rung by design; the
        // resolver additionally refuses a level the NEW settings no longer
        // carry a pair for ("level within the signed count").
        // PHASE3.19 item 34: the MODE-AWARE identity source, through the ONE
        // exhaustive resolver rather than a `=== "policy"` boolean a fourth mode
        // would land in by accident. A LADDER rung floats from its first motion
        // onward exactly as a requoted rung does, so it takes the same branch —
        // and now by DECISION rather than by fall-through.
        const policyMode = gridIdentitySourceFor(gridModeOf(grid)) === "columns";
        // The signed geometry the FLOATING modes reproduce against: `grid.policy`
        // under policy mode, `grid.ladder` under ladder mode. C17 is why this is
        // a union and not a `grid.policy` read: under ladder mode `grid.policy`
        // DOES NOT EXIST, so reaching for it would read `undefined` and refuse
        // every ladder re-sign.
        // PHASE3.22 R2.18 — the SHIFT's geometry joins the floating set. A
        // shift grid's rungs float from its first motion (both of them, on
        // every motion), so `gridIdentitySourceFor` already answers `"columns"`
        // for it and it already takes the `policyMode` path above; without this
        // term it would reach that path with NO signed geometry and be refused
        // by check 2's own "floats its rungs but carries no signed geometry"
        // guard — a refusal that is technically fail-closed and completely
        // wrong about the cause. `??` chains in mode-precedence order; the
        // validator guarantees at most one block is present.
        const floatingGeometry = grid.policy ?? grid.ladder ?? grid.shift;
        // ─── M7: THE MIGRATION, at the one moment the match is provable ────
        //
        // A grid armed under 3.16/3.17 (or under `mode: "fixed"`) that is being
        // re-signed INTO policy mode has live rows whose identity columns may
        // be null. Right now every live rung still equals a signed rung
        // exactly, so `gridLiveRole` can answer; one requote later it cannot,
        // ever again. So the backfill happens HERE, and ANY live level that
        // fails to match REFUSES THE WHOLE RE-SIGN — a partially-labelled dual
        // grid is worse than an unchanged one, because the unlabelled level
        // would go dark the moment policy mode starts.
        //
        // The WRITE is deferred to after every level has passed every check
        // (below the loop), so a refused re-sign leaves no column touched.
        let migrated: LpGridRoleAt | null = null;
        if (policyMode && (position.gridLevel === null || position.gridRole === null)) {
          const byTick = gridLiveRole(grid, snapshot);
          if (byTick === null) {
            throw new BadRequestError(
              `Cannot switch this grid to policy mode: the live level [${snapshot.tickLower}, ${snapshot.tickUpper}) carries no grid_level/grid_role and equals none of the signed ranges (${gridRangeList(grid)}), so which rung it is cannot be established. This is the LAST moment that match is provable — a re-centred rung matches nothing — so the whole re-sign is refused rather than half-labelled. Exit that position, or re-sign rungs that still contain it.`,
            );
          }
          migrated = byTick;
          backfills.push({
            positionId: position.positionId,
            gridLevel: byTick.level,
            gridRole: byTick.role,
          });
        }
        const roleAt = gridRoleAtFor(grid, snapshot, {
          gridLevel: position.gridLevel ?? migrated?.level ?? null,
          gridRole: position.gridRole ?? migrated?.role ?? null,
        });
        if (roleAt === null) {
          throw new BadRequestError(
            policyMode
              ? `A live grid position carries no usable grid_level/grid_role for the NEW settings (row says level ${position.gridLevel ?? "null"}, role ${position.gridRole ?? "null"}). In policy mode identity is the durable column, not a tick match, and the plane will not guess. Exit that position, or re-sign a grid that still carries its level's pair.`
              : `The live level [${snapshot.tickLower}, ${snapshot.tickUpper}) equals none of the NEW signed ranges (${gridRangeList(grid)}), so its next flip would have no defined target. Keep one range equal to each live level, or exit that position first.`,
          );
        }
        // ─── C2's CHECKS 2 AND 3, POLICY MODE ONLY (R2.7) ──────────────────
        //
        // Exact-tick membership is meaningless once a rung floats, so it is
        // replaced by two STRICTLY WEAKER checks — and the weakening is stated
        // rather than hidden, because it IS the price of policy mode:
        //
        //  (2) the live range is REPRODUCIBLE from the signed policy — its
        //      width equals the policy width and both bounds are spacing
        //      multiples. That admits any rung the policy could have derived,
        //      and refuses a range no derivation of this policy produces.
        //  (3) the live level's SIDE, at THIS route's own pool read, is
        //      chargeable for its STORED role under the new orientation. A
        //      re-sign that inverts `wbnbIsToken0`, or that leaves a level on
        //      the wrong side, is refused here rather than at the first flip.
        if (policyMode) {
          const policy = floatingGeometry;
          if (policy === undefined) {
            throw new BadRequestError(
              'This grid mode floats its rungs but carries no signed geometry (grid.policy or grid.ladder); the live levels cannot be checked for reproducibility.',
            );
          }
          const width = snapshot.tickUpper - snapshot.tickLower;
          if (
            width !== policy.widthTicks
            || snapshot.tickLower % grid.tickSpacing !== 0
            || snapshot.tickUpper % grid.tickSpacing !== 0
          ) {
            throw new BadRequestError(
              // The POLICY-mode sentence is BYTE-IDENTICAL to 3.18's (a shipped
              // test pins "not reproducible from the NEW grid.policy"); the
              // ladder gets its own, naming the block that actually governs it.
              gridModeOf(grid) === "ladder"
                ? `The live level [${snapshot.tickLower}, ${snapshot.tickUpper}) is not reproducible from the NEW grid.ladder: its width is ${width} against the ladder's ${policy.widthTicks}, and both bounds must be multiples of tickSpacing ${grid.tickSpacing}. A re-sign that no derivation of the new geometry could have produced would leave this rung outside its own ladder.`
                : `The live level [${snapshot.tickLower}, ${snapshot.tickUpper}) is not reproducible from the NEW grid.policy: its width is ${width} against the policy's ${policy.widthTicks}, and both bounds must be multiples of tickSpacing ${grid.tickSpacing}. A re-sign that no derivation of the new policy could have produced would leave this level outside its own ladder.`,
            );
          }
          const side = gridTargetSide(gate.state.currentTick, {
            tickLower: snapshot.tickLower,
            tickUpper: snapshot.tickUpper,
          });
          if (
            side === undefined
            || gridSideChargesQuote(side, wbnbIsToken0) !== (roleAt.role === "buy")
          ) {
            throw new BadRequestError(
              `The live ${roleAt.role} level [${snapshot.tickLower}, ${snapshot.tickUpper}) is ${side === undefined ? "INSIDE the price" : `"${side}" of tick ${gate.state.currentTick}`}, which under the NEW settings does not charge the asset a ${roleAt.role} level holds. Re-signing the orientation or the rungs out from under a live level is refused; exit that position first.`,
            );
          }
        }
        // The R2.10 admission, RE-RUN at the live level's current value: without
        // it an owner could narrow the spread below the gas floor after an
        // admission that only ever ran at import, and the plane would keep
        // flipping into it. PHASE3.17 C2: once per PAIR, on the pair the level
        // actually belongs to.
        let valuation;
        try {
          valuation = await valueLpPosition(lp.readers, {
            tokenId: BigInt(tokenId),
            wallet: agent.walletAddress,
            fee: position.fee,
            token: gate.token,
            wbnb: lp.venue.wbnb,
            wbnbIsToken0,
            spotSqrtPriceX96: gate.state.evidence.spotSqrtPriceX96,
          });
        } catch {
          throw new BadRequestError(
            "A live grid level could not be valued, so the net-edge admission cannot be re-run; a grid re-sign that cannot be sized is refused.",
          );
        }
        if (valuation === "burned") {
          throw new BadRequestError(
            "A live grid level's NFT is burned on chain; close the position row before re-signing the grid.",
          );
        }
        // ─── C2's CHECK 4, "non-negotiable" (R2.7.4 as corrected by C2) ────
        //
        // The pair priced is *the LIVE rung in its stored role's slot, plus
        // that level's SIGNED counter-rung* — the pair the plane will actually
        // trade, because ruling Q5 keeps the FLIP's target on the signed
        // opposite rung in BOTH modes. The clearance REJECTED pricing a
        // policy-derived counter-rung: the policy derives rungs from a TICK and
        // never from another rung, so that quantity does not exist, and C2's
        // own charter sentence is that the plane "would keep FLIPPING into it".
        //
        // In FIXED mode the live rung IS the signed rung, so
        // `gridEconomicsPair` reduces to `gridNetEdgePair` exactly and the
        // 3.15-3.17 behaviour is byte-identical. ONE shared builder feeds this
        // and the requote's own gate, so they cannot diverge (3.13 F12).
        const pair = policyMode
          ? gridEconomicsPair(grid, roleAt.level, roleAt.role, {
              tickLower: snapshot.tickLower,
              tickUpper: snapshot.tickUpper,
            })
          : gridNetEdgePair(grid, roleAt.level);
        if (pair === null) {
          throw new BadRequestError("The matched grid level has no signed pair.");
        }
        const relayFee = lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
        // PHASE3.19 item 25, CALL SITE 2 OF 3. A ladder's re-sign is priced by
        // the SAME builder the arm and the client transcript use, with the LIVE
        // rung's pair and value passed as overrides — so this guard and the
        // admission can never disagree about `submissionsPerCycle`, which at
        // `maxMovesPerDay: 12` is the difference between 2 and 42.
        // PHASE3.22 R2.18 / R2.14, CALL SITE 2 OF 3 for `gridShiftEconomics`.
        // A shift's re-sign is priced by the SAME builder the arm route and the
        // client transcript use, with the LIVE pair and value passed as
        // overrides — so this guard and the admission can never disagree about
        // `submissionsPerCycle`, which at `shiftsPerDay: 24` is the difference
        // between 2 and 24.
        //
        // THE FLOATED-PAIR OVERRIDE IS ALWAYS TAKEN under shift mode (R2.18):
        // every live rung floats, so no signed counter-rung is ever priced —
        // `gridEconomicsPair` above already supplies the live-rung pair,
        // because `policyMode` is true for this mode.
        const edge =
          grid.shift !== undefined
            ? gridShiftEconomics({
                grid,
                shift: grid.shift,
                budgetWei: 0n,
                sizeWei: valuation.exitValueWei,
                pair,
                relayFeePerSubmitWei: relayFee,
              }).edge
            : grid.ladder === undefined
            ? gridNetEdge({
                pair,
                minNetEdgeBps: grid.minNetEdgeBps,
                sizeWei: valuation.exitValueWei,
                // R2.4's REQUOTE-INFLATED FLOOR: a cycle that carries up to R
                // re-centres pays `2 + 2R` submissions out of the SAME spread.
                // `gridCycleSubmissions` answers 2 for a fixed grid, so this
                // argument changes nothing outside policy mode.
                submissionsPerCycle: gridCycleSubmissions(grid),
                // C6: the DEPS field, not a bare constant — an operator override
                // must not be ignored by the one check that prices gas.
                relayFeePerSubmitWei: relayFee,
              })
            : gridLadderEconomics({
                grid,
                ladder: grid.ladder,
                budgetWei: 0n,
                sizeWei: valuation.exitValueWei,
                pair,
                relayFeePerSubmitWei: relayFee,
              }).edge;
        if (!edge.ok) {
          throw new BadRequestError(lpGridNetEdgeRefusal(edge, "Grid re-sign refused"));
        }
        edges.push(edge);
        liveLevels.push({
          positionId: position.positionId,
          tokenId,
          level: roleAt.level,
          role: roleAt.role,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
          netEdge: gridNetEdgeView(edge),
        });
        legacyLevels.push({
          positionId: position.positionId,
          tokenId,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
        });
      }
      // PHASE3.18 M7 — the backfill lands only now, with every level's four
      // checks passed. A refused re-sign has written nothing.
      for (const entry of backfills) {
        await lp.store.setGridIdentity(agent.ownerAddress, agent.id, entry.positionId, {
          gridLevel: entry.gridLevel,
          gridRole: entry.gridRole,
        });
      }
      const firstLevel = legacyLevels[0];
      const firstEdge = edges[0];
      return {
        gate,
        wbnbIsToken0,
        view: {
          pool: gate.pool,
          wbnbIsToken0,
          tickSpacing: gate.state.tickSpacing,
          currentTick: gate.state.currentTick,
          armed: "re-signed",
          // PHASE3.17: `liveLevel`/`netEdge` are kept as the SINGULAR fields
          // 3.15/3.16 receipts carry, so a one-level agent's receipt is
          // byte-identical; `liveLevels` is additive and carries every level.
          ...(firstLevel === undefined ? {} : { liveLevel: firstLevel }),
          ...(firstEdge === undefined ? {} : { netEdge: gridNetEdgeView(firstEdge) }),
          liveLevels,
        },
      };
    }

    /**
     * PHASE3.15 R2.1 — the GRID-SPECIFIC import admission, additive to the
     * route's existing surface and active only when the agent's settings carry
     * a grid block.
     *
     * FIVE checks, and every one is about ADMISSION rather than capability —
     * the import route already runs the full open-grade surface (legs and fee
     * from CHAIN, `ownerOf`, the staked-operator refusal, the outstanding
     * -approval refusal, `gateLpPool` verbatim, the exit-impact probe), and it
     * imposes no in-range and no two-sided requirement, which is what makes a
     * hand-minted single-sided range order importable at all.
     *
     *  1. the pool must be the SIGNED grid pool;
     *  2. the ticks must equal EXACTLY one of the two signed ranges — a
     *     near-miss is a refusal naming both pairs, because a level the flip
     *     cannot recognise has no defined target;
     *  3. M8's THREE CONJUNCTS, applied at admission: a side must EXIST (the
     *     tick strictly outside the level), the off-side residue must be within
     *     `SWAPLESS_MAX_RESIDUE_BPS`, and the leg that side implies must be the
     *     leg actually held, IN POOL ORDER. A level failing any of these is one
     *     whose first flip would refuse at the mint anyway; refusing here costs
     *     one signature instead of a held sequence;
     *  4. the R2.10 net-edge admission, sized on the position's own
     *     `exitValueWei` — the figure this route already computes, and the
     *     first moment a SIZE exists at all;
     *  5. `basisWei` must be 0: value-basis TP/SL is structurally disabled for
     *     a grid, because a ping-pong's inventory alternates assets by design
     *     and a lineage-basis comparison would misfire. The Phase 3.6 PRICE
     *     triggers remain available and protect regardless of the basis.
     *
     * The probe question B1(a) left open is ANSWERED and needs no branch (C5):
     * `probeLpExitImpact` short-circuits `amountInWei <= 0n` to a zero-impact,
     * within-rail result, so a pure-WBNB buy level (whose `tokenTotalWei` is
     * ~0) admits through the existing probe with no grid-specific skip.
     */
    async function admitGridImport(
      assessment: LpImportAssessment,
      settings: LpAutomationSettings,
      basisWei: bigint,
    ): Promise<Record<string, unknown> | null> {
      const grid = settings.grid;
      if (grid === null) return null;
      if (lp.gridEnabled !== true) {
        throw new BadRequestError(
          "This agent's settings carry a grid block but GRID_ENABLED is off on this deployment; importing a level the worker will skip is refused.",
        );
      }
      if (
        assessment.token0.toLowerCase() !== grid.pool.token0.toLowerCase()
        || assessment.token1.toLowerCase() !== grid.pool.token1.toLowerCase()
        || assessment.fee !== grid.pool.fee
      ) {
        throw new BadRequestError(
          `This position is in a different pool from the signed grid (${assessment.token0}/${assessment.token1} fee ${assessment.fee} vs ${grid.pool.token0}/${grid.pool.token1} fee ${grid.pool.fee}). A grid agent runs ONE ping-pong on ONE pool.`,
        );
      }
      // PHASE3.17 R2.5: `{level, role}` against the UP-TO-FOUR signed ranges, so
      // an import of a dual grid's level-2 rung resolves to level 2's own pair.
      // PHASE3.18 R2.5 — POLICY MODE IS NON-RESTARTABLE BY IMPORT, declared
      // rather than half-worked-around. `/lp/import` admits by EXACT-TICK match
      // against the signed rungs, and a requoted level's ticks match no signed
      // rung by design, so the door is closed for any policy-mode grid. The
      // refusal is the MODE refusal, not the tick-mismatch text (C1's list
      // names that distinction explicitly).
      //
      // Extending the admission to "reproducible from the signed policy" is
      // DEFERRED with its shape recorded: it is a SECOND admission surface and
      // owes its own PHASE3.4-A7 discharge, exactly as import itself did.
      // PHASE3.22 R2.22 / C6 — THROUGH THE EXHAUSTIVE HELPER, not a second
      // `||` literal. `lpGridImportModeRefusal` is `never`-bound, so a fifth
      // mode is a COMPILE ERROR here rather than a silent admission — and it
      // carries the fix for the gap C6 surfaced, where LADDER mode reached the
      // tick-mismatch text instead of a mode refusal. Each sentence still
      // spends the 280-char budget in the house order.
      const importModeRefusal = lpGridImportModeRefusal(gridModeOf(grid));
      if (importModeRefusal !== null) {
        throw new BadRequestError(importModeRefusal);
      }
      const roleAt = gridLiveRole(grid, assessment.snapshot);
      if (roleAt === null) {
        throw new BadRequestError(
          `This position's range [${assessment.snapshot.tickLower}, ${assessment.snapshot.tickUpper}) equals none of this grid's signed ranges (${gridRangeList(grid)}). A grid level must be one of the signed ranges VERBATIM, because the flip's target is chosen by which one the live level IS.`,
        );
      }
      const role = roleAt.role;
      const importPair = gridNetEdgePair(grid, roleAt.level);
      if (importPair === null) {
        // Unreachable: `gridLiveRole` only ever answers a level whose pair
        // exists. Fail closed rather than proceed on a pair that does not.
        throw new BadRequestError("The matched grid level has no signed pair.");
      }
      const liveRange =
        role === "buy" ? importPair.buyRange : importPair.sellRange;
      const side = gridTargetSide(assessment.poolState.currentTick, liveRange);
      if (side === undefined) {
        throw new BadRequestError(
          `Tick ${assessment.poolState.currentTick} is INSIDE this level [${liveRange.tickLower}, ${liveRange.tickUpper}), so the position is only partly converted and holds both legs. A grid level is admitted single-sided and strictly out of range; wait for the price to leave the range, or import the other level.`,
        );
      }
      const amount0 = assessment.wbnbIsToken0
        ? assessment.wbnbTotalWei
        : assessment.tokenTotalWei;
      const amount1 = assessment.wbnbIsToken0
        ? assessment.tokenTotalWei
        : assessment.wbnbTotalWei;
      const present = side === "above" ? amount0 : amount1;
      if (present <= 0n) {
        throw new BadRequestError(
          `The level's "${side}" side holds nothing: at tick ${assessment.poolState.currentTick} the range [${liveRange.tickLower}, ${liveRange.tickUpper}) charges ${side === "above" ? "token0" : "token1"}, and this position's pool-ordered legs are ${amount0}/${amount1}. The price has gapped THROUGH the level.`,
        );
      }
      const residue = swaplessResidueWithinBound({
        amount0,
        amount1,
        side,
        spotSqrtPriceX96: assessment.poolState.evidence.spotSqrtPriceX96,
      });
      if (!residue.within) {
        throw new BadRequestError(
          `This level is not cleanly single-sided: its off-side leg is ${residue.residueWei} wei, ${residue.residueBps} bps of the position's value, over the ${SWAPLESS_MAX_RESIDUE_BPS} bps a flip may strand. The first flip would refuse at its mint; withdraw and re-mint the level as a clean range order.`,
        );
      }
      // PHASE3.17 C2: priced on THIS LEVEL'S OWN PAIR. Under four rungs nothing
      // forces two signed pairs to carry equal spreads, so pricing a level-2
      // import on pair 1's rungs would wave through the one check standing
      // between the owner and a level that loses money on every cycle.
      const edge = gridNetEdge({
        pair: importPair,
        minNetEdgeBps: grid.minNetEdgeBps,
        sizeWei: assessment.exitValueWei,
        // C6: the DEPS field, so an operator's `LP_RELAY_FEE_PER_SUBMIT_WEI`
        // override reaches the one check that prices gas.
        relayFeePerSubmitWei:
          lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI,
      });
      if (!edge.ok) {
        throw new BadRequestError(lpGridNetEdgeRefusal(edge, "Grid import refused"));
      }
      if (basisWei !== 0n) {
        throw new BadRequestError(
          "A grid level must be imported with basisWei 0: a ping-pong's inventory alternates assets by design, so a lineage-basis stop-loss would compare across two different denominations. Price triggers (priceStopLoss / priceTakeProfit) protect a grid regardless of the basis and are the instrument to use.",
        );
      }
      const target = gridTargetRange(grid, roleAt.level, role);
      return {
        role,
        level: roleAt.level,
        side,
        liveRange: { tickLower: liveRange.tickLower, tickUpper: liveRange.tickUpper },
        targetRange: { tickLower: target.tickLower, tickUpper: target.tickUpper },
        residue: {
          residueWei: residue.residueWei.toString(10),
          residueBps: residue.residueBps.toString(10),
          maxBps: SWAPLESS_MAX_RESIDUE_BPS,
        },
        netEdge: gridNetEdgeView(edge),
        note:
          `Admitted as the ${role} level. The flip settles it and mints single-sided into [${target.tickLower}, ${target.tickUpper}) once the price has crossed fully beyond this level on two finalized evaluations at least one worker interval apart.`,
      };
    }

    /** The net-edge figures, rendered. Shared so every surface agrees. */
    function gridNetEdgeView(edge: LpGridNetEdge): Record<string, unknown> {
      return {
        grossEdgeBps: edge.grossEdgeBps.toString(10),
        costFloorBps: edge.costFloorBps.toString(10),
        minNetEdgeBps: edge.minNetEdgeBps.toString(10),
        sizeWei: edge.sizeWei.toString(10),
        relayFeePerSubmitWei: edge.relayFeePerSubmitWei.toString(10),
        ok: edge.ok,
        note:
          "Bounds RELAY GAS ONLY, at a per-submission constant that is still an unmeasured 4x pad on one sample. It models neither adverse selection (which a fully-crossed range order IS) nor slippage. Two submissions per flip: the sweep always skips.",
      };
    }

    function requireRails(): LpRailConfig {
      // The rails' own posture: missing ⇒ refuse (never default-open). The
      // failure's reason names the missing env keys, which is operator data,
      // not caller data — sanitized like everything else.
      if (!lp.railsResult.ok) throw new BadRequestError(lp.railsResult.failure.reason);
      return lp.railsResult.config;
    }

    /* ---- POST /agents/:id/lp/settings ------------------------------------ */

    app.post("/agents/:id/lp/settings", (c) =>
      ownerMutation(c, c.req.param("id"), "lpSettings", "lpSettings", async ({ agent, params }) => {
        const parsed = parseLpSettingsParams(params);
        if (!parsed.ok) throw new BadRequestError(parsed.message);
        enforceLpV1Profile(agent, parsed.value);

        // PHASE3.15: everything about the grid block that needs CHAIN or CONFIG
        // input. The shape is `lpWire`'s, the ranges and ordering are
        // `validateLpSettings`'s, and only these three classes of check live
        // here — the M4/M16 split, written down at each of the three sites.
        const gridAdmission = await admitGridSettings(agent, parsed.value.grid);

        // Rev2 item 11 (the dev-stack A2 lesson): the sizing re-check runs
        // against what the CHAIN currently holds, not what provisioning
        // remembered — an owner may have widened or narrowed the session
        // since. A cap that cannot be read cannot be sized: refuse.
        let liveCapWei: bigint;
        try {
          liveCapWei = await lp.readers.onChainNativeDailyCapWei(agent);
        } catch {
          throw new BadRequestError(
            "The session's live on-chain native cap could not be read; a settings change that cannot be sized is refused.",
          );
        }
        const positions = await lp.store.listPositions(agent.ownerAddress, agent.id);
        const openPositions = positions.filter(
          (position) => position.state !== "closed",
        );
        const openBudgetWei = lpOpenNativeBudgetWei(openPositions);
        const sizing = checkLpNativeCapSizing({
          onChainDailyCapWei: liveCapWei,
          openNativeBudgetWei: openBudgetWei,
          ...(trade.feeBps === undefined ? {} : { feeBps: trade.feeBps }),
          maxExitSequencesPerDay: parsed.value.maxExitSequencesPerDay,
          // Audit A3: quota-exempt protect/manual-exit gas is reserved per
          // LIVE open position, so the stop-loss keeps headroom even after
          // the rotate/harvest quota is spent.
          openPositionsCount: openPositions.length,
          // PHASE3.15 R2.7 / C7, call site 1 of 3 (PHASE3.16 H1 added the arm
          // and corrected this denominator rather than leaving it a lie).
          // A flip is quota-bound in its
          // OWN lane and still bills relay gas to the same on-chain meter, so
          // the reserve must carry the term or routine flips raid the protect
          // headroom.
          //
          // PHASE3.18 R2.11 UPDATES THIS NOTE: the requote lane is a THIRD
          // term at the same three sites, on the same argument — it is
          // quota-bound in its own lane and bills the same meter.
          ...(parsed.value.grid === null || gridModeOf(parsed.value.grid) === "shift"
            ? {}
            : { maxGridFlipsPerDay: parsed.value.grid.maxFlipsPerDay }),
          ...(parsed.value.grid?.requote === undefined
            ? {}
            : { maxRequotesPerDay: parsed.value.grid.requote.maxRequotesPerDay }),
          ...shiftNativeSizingTerm(parsed.value),
          ...(lp.relayFeePerSubmitWei === undefined
            ? {}
            : { lpRelayFeePerSubmitWei: lp.relayFeePerSubmitWei }),
        });
        if (!sizing.ok) {
          // PHASE3.1 Rev2 item 19: the exit reserve widened from one
          // submission per open position to two, so a settings change that
          // passed under Phase 3 may be refused here for the first time. That
          // is the check working — but `/lp/settings` is also how an owner
          // turns automation OFF, so the refusal must name the way out AND
          // say plainly that being stuck here does not mean being stuck in a
          // position.
          //
          // SHORTFALL FIRST, remedies second, and the order is load-bearing:
          // `sanitizeMessage` caps an error body at 280 characters, and the
          // sizing arithmetic alone already overruns it.
          //
          // PHASE3.1-AUDIT A9: appending `sizing.message` truncated away the
          // one number `owner-add-spend-limit` needs — the owner was told to
          // raise the cap and given no way to learn BY HOW MUCH, and the
          // journal's copy was truncated at the same point. The figure now
          // comes from `sizing.shortfallWei`, a STRUCTURED field on the sizing
          // result rather than prose, and leads the sentence so nothing that
          // matters can fall past the cap. The full arithmetic still lives in
          // `sizing.message`, which provisioning (`live-lp`, `provision-agent`)
          // prints untruncated.
          //
          // PHASE3.1-FIXREVIEW F5: this used to render `sizing.shortfallWei ??
          // 0n`, so a refusal that carried no shortfall would have told the
          // owner the cap was "short by 0 wei" — a false number that looks
          // actionable, which is A9's own failure class wearing A9's fix. The
          // union now makes the two failures distinguishable, so the figure is
          // printed only when there IS one and a malformed input says what it
          // actually is. Malformed is unreachable from here (every input is
          // validated upstream or comes from the store), which is why it may
          // simply carry its own short message.
          if (sizing.kind === "malformed") {
            throw new BadRequestError(`LP settings refused: ${sizing.message}`);
          }
          if (parsed.value.grid !== null && gridModeOf(parsed.value.grid) === "shift") {
            throw new LpSizingShortfallError(
              `LP settings refused: the on-chain daily native cap is too low. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, or raise the cap with owner-add-spend-limit. The EXIT path is unaffected: positions can still be closed. Shortfall (wei): ${sizing.shortfallWei}`,
              sizing.shortfallWei,
            );
          }
          throw new BadRequestError(
            `LP settings refused: the on-chain daily native cap is short by ` +
              `${sizing.shortfallWei} wei. Remedies: raise it with ` +
              `owner-add-spend-limit, lower maxExitSequencesPerDay, or close a ` +
              `position. The EXIT path is unaffected: every position can still ` +
              `be closed (it runs no sizing check).`,
          );
        }

        // Rev2 item 21: the digest IS `paramsHash("lpSettings", params)` — the
        // one shared encoder, over the exact bytes the owner signed. (The
        // verifier already proved `signed.paramsHash` equals this.)
        const digest = paramsHash("lpSettings", params);
        await lp.settingsStore.put({
          agentId: agent.id,
          ownerAddress: agent.ownerAddress,
          params,
          digest,
        });
        return {
          settingsDigest: digest,
          settings: lpSettingsResponseView(parsed.value),
          ...(gridAdmission === null ? {} : { grid: gridAdmission.view }),
          note:
            "Automation sequences armed under the previous digest refuse between " +
            "steps and re-arm under this one.",
        };
      }),
    );

    /* ---- POST /agents/:id/lp/arm ----------------------------------------- */

    app.post("/agents/:id/lp/arm", (c) =>
      ownerMutation(c, c.req.param("id"), "lpArm", "lpArm", async ({ agent, params }) => {
        const parsed = parseLpArmParams(params);
        if (!parsed.ok) throw new BadRequestError(parsed.message);
        const request = parsed.value;
        const rails = requireRails();
        if (agent.sessionFacts === null) {
          throw new BadRequestError(
            "Agent has no granted session; an open that could not later be exited is refused.",
          );
        }
        const hireSizing = agent.sessionFacts.hireSizing;
        if (hireSizing !== undefined && hireSizing.name !== "lp-v1") {
          throw new BadRequestError(
            `This agent was hired as ${hireSizing.name}; lpArm is for lp-v1 hires.`,
          );
        }
        enforceLpV1Profile(agent, request.settings, request.budgetWei);

        const admitted = await lp.store.withArmFence(agent.ownerAddress, agent.id, async (fence) => {
          const existing = (await fence.listPositions()).filter(
            (position) => position.state !== "closed",
          );
          if (existing.length > 0) {
            throw new BadRequestError(
              `This agent already holds ${existing.length} non-closed LP position row(s); an arm places a grid's levels and cannot add to a grid that already holds one. To move the ranges under a live level use live-grid settings; to stand the levels down use the exit or abandon doors, then arm again.`,
            );
          }
          const blocking = await fence.getAnyNonTerminalSequence();
          if (blocking !== null) {
            throw new BadRequestError(
              `This agent has a non-terminal ${blocking.kind} sequence (${blocking.sequenceId}); arming is refused until it settles. Wait for it, or settle it with the owner-signed abandon door.`,
            );
          }

          const resolved = await resolveLpArmPool(agent, rails, request.settings, request);
          const grantedToken = lpRankedDiscoveryToken(agent.sessionFacts!.spec, lp.venue.wbnb);
          if (!grantedToken.ok || resolved.gate.token.toLowerCase() !== grantedToken.token.toLowerCase()) {
            throw new BadRequestError("The selected pool's token is not the token this session was granted for.");
          }
          const { tickLower, tickUpper } = resolveLpOpenRange(resolved.gate.state, request.range);
          const armedPriceAtOpen = alreadySatisfiedPriceTrigger(
            request.settings,
            resolved.candidate,
            resolved.gate.state.currentTick,
          );
          if (armedPriceAtOpen !== null) {
            throw new BadRequestError(
              `A price ${armedPriceAtOpen.label === "stopLoss" ? "stop-loss" : "take-profit"} is armed for this pool and is ALREADY satisfied at tick ${resolved.gate.state.currentTick} (trigger: ${armedPriceAtOpen.trigger.when} ${armedPriceAtOpen.trigger.tick}); the position would be exited almost immediately. Clear or move the trigger first.`,
            );
          }

          let liveCapWei: bigint;
          try {
            liveCapWei = await lp.readers.onChainNativeDailyCapWei(agent);
          } catch {
            throw new BadRequestError(
              "The session's live on-chain native cap could not be read; a settings change that cannot be sized is refused.",
            );
          }
          const sizing = checkLpNativeCapSizing({
            onChainDailyCapWei: liveCapWei,
            openNativeBudgetWei: lpOpenNativeBudgetWei(existing) + request.budgetWei,
            ...(trade.feeBps === undefined ? {} : { feeBps: trade.feeBps }),
            maxExitSequencesPerDay: request.settings.maxExitSequencesPerDay,
            openPositionsCount: existing.length + 1,
            ...(lp.relayFeePerSubmitWei === undefined
              ? {}
              : { lpRelayFeePerSubmitWei: lp.relayFeePerSubmitWei }),
          });
          if (!sizing.ok) {
            if (sizing.kind === "malformed") {
              throw new BadRequestError(`LP settings refused: ${sizing.message}`);
            }
            throw new BadRequestError(
              `LP settings refused: the on-chain daily native cap is short by ` +
                `${sizing.shortfallWei} wei. Remedies: raise it with ` +
                `owner-add-spend-limit, lower maxExitSequencesPerDay, or close a ` +
                `position. The EXIT path is unaffected: every position can still ` +
                `be closed (it runs no sizing check).`,
            );
          }

          const digest = paramsHash("lpSettings", request.settingsParams);
          await fence.putSettings(lp.settingsStore, {
            agentId: agent.id,
            ownerAddress: agent.ownerAddress,
            params: request.settingsParams,
            digest,
          });
          const positionId = randomUUID();
          const armMeta: LpArmMeta = {
            action: "lpArm",
            model: resolved.model,
            range: {
              source: request.range.kind,
              tickLower,
              tickUpper,
            },
            selectPool: request.selectPool ?? null,
            selection: resolved.selectionMeta ?? null,
            budgetWei: request.budgetWei.toString(10),
          };
          await fence.createPosition({
            positionId,
            agentId: agent.id,
            ownerAddress: agent.ownerAddress,
            token0: resolved.candidate.token0,
            token1: resolved.candidate.token1,
            fee: resolved.candidate.fee,
            basisWei: request.budgetWei,
            quoteToken: lp.venue.wbnb,
            armMeta,
          });
          return { resolved, tickLower, tickUpper, digest, positionId };
        });
        const { resolved, tickLower, tickUpper, digest, positionId } = admitted;
        const result = await runLpOpen(
          lpSagaDeps(agent, rails, request.settings, digest, resolved.gate.pool),
          {
            mode: "two-sided-in-range",
            kind: "open",
            positionId,
            budgetWei: request.budgetWei,
            tickLower,
            tickUpper,
          },
        );
        const position = await lp.store.getPosition(agent.ownerAddress, agent.id, positionId);
        return {
          position: position === null ? null : lpPositionView(position),
          open: {
            sequenceId: result.sequenceId,
            status: result.status,
            code: result.code,
            reason: result.reason,
            ...(result.tokenId === undefined ? {} : { tokenId: result.tokenId }),
          },
          range: { tickLower, tickUpper, source: request.range.kind },
          ...(resolved.selectionMeta === undefined ? {} : { selection: resolved.selectionMeta }),
          settingsDigest: digest,
          model: resolved.model,
        };
      }),
    );

    /* ---- POST /agents/:id/lp/grid/arm (PHASE3.16) -------------------------- */

    /**
     * What an arm's outcome MEANS to the owner (PHASE3.16 R2.7 / review M7).
     *
     * The two non-completed outcomes are the ones that need saying, and both
     * used to be answered by texts telling the owner to hand-mint — the
     * workflow this route replaces.
     */
    function lpGridArmReceiptNote(
      status: LpSagaRunResult["status"],
      dual = false,
    ): string {
      if (status === "completed") {
        return dual
          ? "Both levels are live and the worker is watching each on its own pair. The first flip is floored by minMinutesBetweenExits, which is AGENT-WIDE — so two levels that fill together are staggered by at least that."
          : "The level is live and the worker is watching it. The first flip is floored by minMinutesBetweenExits, because the arm's own reservation moves the agent-wide spacing anchor.";
      }
      if (status === "rolled-back") {
        return dual
          ? "NOTHING WAS SPENT and BOTH position rows are closed — the arm is atomic, so two levels landed or neither did. The settings stay live, so the remedy is to sign gridArm again at the current price. Do NOT hand-mint on account of this refusal."
          : "NOTHING WAS SPENT and the position row is closed. The settings stay live — an armed grid that holds no level yet is a supported state — so the remedy is to sign gridArm again at the current price. Do NOT hand-mint on account of this refusal.";
      }
      // "held": the submit window was ambiguous.
      return dual
        // PHASE3.17 review2 N18: a late landing now strands TWO NFTs, and the
        // next arm's idle gate does not see them at all — so the restart advice
        // has to say that both must be dealt with, or a re-arm mints a third
        // and fourth level into a wallet already holding two.
        ? "The submission's outcome is UNKNOWN and is held; ambiguity never auto-replays. The operator door is the owner-signed abandon, which closes BOTH never-funded rows. If the mint LANDS LATE, TWO NFTs arrive in your own EOA, unmanaged — the PHASE3.14 phantom-open disclosure applies to both, and BOTH must be withdrawn or imported before you arm again, or the next arm mints a third and fourth level."
        : "The submission's outcome is UNKNOWN and is held; ambiguity never auto-replays. The operator door is the owner-signed abandon, which closes the never-funded row. If the mint LANDS LATE the NFT arrives in your own EOA, unmanaged — the PHASE3.14 phantom-open disclosure applies, and the level can be imported once it exists.";
    }

    /**
     * THE AUTONOMOUS GRID ARM: hire → BNB in → the agent places its own first
     * level, in ONE owner signature.
     *
     * Phase 3.15 shipped the whole ping-pong except its front door: the first
     * level had to be hand-minted on PancakeSwap and imported. This route
     * closes that gap in its smallest honest form — the owner signs `gridArm`
     * carrying the COMPLETE `lpSettings` params plus a native `budgetWei`, and
     * the plane validates admission, persists the settings, creates the
     * position row and runs a ONE-SUBMISSION saga that mints the WBNB-holding
     * level single-sided into the signed `buyRange`. From that moment 3.15's
     * worker and flip machinery — untouched — runs the strategy.
     *
     * NO SWAP: the armed level is the quote-charging side, so the budget funds
     * it directly. The 50/50 two-level shape is a separate phase (it would
     * break 3.15's one-live-position statement and the sizing invariant's
     * documented `P = 1`).
     *
     * ROUTE SHAPE (M2), and the reasoning is recorded rather than assumed: this
     * lives under the `/lp/` family and is registered UNCONDITIONALLY inside
     * `registerLpRoutes`, which is itself called only when `deps.lp` exists.
     * So `LP_ENABLED` off ⇒ 404, byte-identical to every other LP route; but
     * `GRID_ENABLED` off ⇒ 400, because `GRID_ENABLED` is a FIELD on live LP
     * deps rather than a dep object, and `admitGridSettings`'s existing flag
     * refusal NAMES ITS REMEDY. A bare 404 would be strictly less informative
     * at exactly equal security.
     *
     * THE PIPELINE, in order, with what each step buys:
     *
     *  0. parse; then refuse `settings.grid === null` with its OWN text (C4) —
     *     `admitGridSettings` returns `null` for a null grid BEFORE even its
     *     flag check, so a grid-less arm would otherwise pass admission
     *     entirely, not even be refused on a grid-disabled deployment, and
     *     reach the derivation with no `buyRange` to derive from;
     *  1. `admitGridSettings(..., "arm")` — checks 1–4 only (C1);
     *  2. THE ARM'S OWN GATE (R2.3, review B3): no non-closed position row, no
     *     non-terminal sequence. This is STRICTER than `admitGridSettings`'s
     *     first-arming gate, which is the safe direction, and it is the sole
     *     idle authority on BOTH stored-settings shapes. Without it a `gridArm`
     *     on a live grid agent would mint a SECOND position, breaking 3.15's
     *     one-live-position statement, the sizing invariant's `P` term and the
     *     flip's own target derivation. It also makes the restart-after-abandon
     *     case fall out with no new code: a CLOSED row is not a live one;
     *  3. the G-gate at the ROUTE seam, against admission's OWN pool read;
     *  4. ONE net-edge check, sized on `budgetWei` — strictly better than
     *     3.15's import-time check, because the size exists at signing;
     *  5. ONE sizing call and ONE cap read (C2), with R2.7's four arguments;
     *  6. persist the settings VERBATIM under the `lpSettings` digest;
     *  7. the position row (`basisWei: 0n`, `basisSource: "minted"`);
     *  8. the saga, under the digest step 6 JUST WROTE (C8) — the open route
     *     gets that free from `currentLpSettings`, and this route cannot copy
     *     it verbatim because it writes settings in the same request. Get the
     *     order wrong and EVERY arm rolls back SETTINGS_DIGEST_MISMATCH.
     *
     * A rolled-back arm leaves LIVE settings and a CLOSED row. That is a
     * SUPPORTED state — 3.15's "armed but holds no level yet" — and the next
     * `gridArm` takes the `alreadyGrid` path with step 2 protecting it.
     */
    app.post("/agents/:id/lp/grid/arm", (c) =>
      ownerMutation(c, c.req.param("id"), "gridArm", "lpGridArm", async ({ agent, params }) => {
        const parsed = parseLpGridArmParams(params);
        if (!parsed.ok) throw new BadRequestError(parsed.message);
        const request = parsed.value;
        const rails = requireRails();

        // (0) C4. Its own text, before and independent of `admitGridSettings`.
        const grid = request.settings.grid;
        if (grid === null) {
          throw new BadRequestError(
            "gridArm carries settings with no grid block, so there is no buyRange to fund and nothing to arm. Sign settings containing a grid block — the arm funds buyRange and only buyRange.",
          );
        }
        if (agent.sessionFacts === null) {
          throw new BadRequestError(
            "Agent has no granted session; an arm that could not later be exited is refused.",
          );
        }
        const hireSizing = agent.sessionFacts.hireSizing;
        if (hireSizing !== undefined) {
          let outsideProfile: boolean;
          switch (hireSizing.name) {
            case "grid-shift-v1":
              outsideProfile =
                gridModeOf(grid) !== "shift"
                || request.levels !== 2
                || request.settings.maxExitSequencesPerDay > 4
                || grid.requote !== undefined
                || (shiftNativeSizingTerm(request.settings).shiftMotionsPerDay ?? 0) > 16
                || request.budgetWei > BigInt(hireSizing.openNativeBudgetWei);
              break;
            case "grid-v1":
              outsideProfile =
                gridModeOf(grid) !== "fixed"
                || request.levels > 2
                || request.settings.maxExitSequencesPerDay > 4
                || grid.maxFlipsPerDay > 12
                || grid.requote !== undefined
                || request.budgetWei > BigInt(hireSizing.openNativeBudgetWei);
              break;
            case "lp-v1":
              throw new BadRequestError("An lp-v1 hire cannot arm a grid.");
            default:
              outsideProfile = true;
              break;
          }
          if (outsideProfile) {
            throw new BadRequestError(
              "These grid settings exceed the immutable " + hireSizing.name + " hire profile. Revoke the session on chain and hire again with a reviewed profile.",
            );
          }
        }

        // (0b) PHASE3.17 R2.2 — the `levels` <=> pair-2 CROSS-RULE, scoped to
        // THIS ROUTE (R3.1). `levels` rides the gridArm ENVELOPE beside
        // `budgetWei` and never enters persisted settings, so an `lpSettings`
        // envelope has no `levels` field at all — which is what keeps
        // settings-only re-signs of a live dual grid supported, guarded by C2's
        // multi-level form rather than by a rule that cannot apply there.
        //
        // v1 refuses MIXING in both directions. Arming one level of a
        // four-rung grid is a later product question, not this phase's: it
        // would leave two signed rungs no position will ever occupy and no
        // surface saying so.
        // PHASE3.19 item 37 — THE LADDER BRANCH of the `levels` cross-rule.
        //
        // A ladder is TWO ROWS ON ONE PAIR (R3.1/C2), so `levels: 2` on the
        // envelope means "two rows" and NOT "two pairs" — and `buyRange2`/
        // `sellRange2` are REFUSED under ladder mode (item 14), so the DUAL
        // branch's `gridIsDual` requirement would refuse every ladder arm if it
        // were left to apply.
        const ladder = gridModeOf(grid) === "ladder" ? grid.ladder : undefined;
        if (ladder !== undefined) {
          if (request.levels !== 2) {
            throw new BadRequestError(
              'grid.mode "ladder" arms TWO rows — one per side — from one budget in one submission, so it needs levels: 2. Arming one row of a ladder would leave the other side permanently unquoted and the buffer permanently one-sided.',
            );
          }
          if (agent.sessionFacts.spec.allowedCalls.every(
            (rule) =>
              rule.to?.toLowerCase() !== lp.venue.wbnb.toLowerCase()
              || rule.selector !== WBNB_DEPOSIT_SELECTOR,
          )) {
            // PHASE3.19 item 3 — THE RE-GRANT REQUIREMENT, refused at the ROUTE
            // rather than left to fail at the wrap.
            //
            // Item 3 says a ladder arm on a pre-3.19 session "fails at the wrap,
            // visibly" — and it does, at `preflightExecute`, as an allowlist
            // refusal. That is a correct outcome and a poor sentence: the owner
            // gets a provider code rather than "your session predates this mode".
            // Refusing here costs nothing (the persisted spec is already in
            // hand), names the remedy, and leaves the wrap's own refusal in place
            // as the backstop for a spec that disagrees with the chain.
            throw new BadRequestError(
              "This agent's session was granted before ladder mode and cannot wrap BNB into WBNB, which is how a ladder's idle buffer holds its quote half. Re-grant the session (npm run provision-agent) and arm again; nothing was spent.",
            );
          }
        }
        // PHASE3.22 R5 — the SHIFT arm, on the ladder's terms exactly. It is
        // TWO ROWS ON ONE PAIR, so `levels: 2` means "two rows" and not "two
        // pairs"; `buyRange2`/`sellRange2` are refused under shift mode by the
        // validator, so the DUAL branch's `gridIsDual` requirement would refuse
        // every shift arm if it were left to apply.
        const shiftBlock = gridModeOf(grid) === "shift" ? grid.shift : undefined;
        if (shiftBlock !== undefined) {
          if (request.levels !== 2) {
            throw new BadRequestError(
              'grid.mode "shift" arms TWO rows — one per side — from one budget in one submission, so it needs levels: 2. Arming one row would leave the other side permanently unquoted and every later shift permanently one-sided.',
            );
          }
          if (agent.sessionFacts.spec.allowedCalls.every(
            (rule) =>
              rule.to?.toLowerCase() !== lp.venue.wbnb.toLowerCase()
              || rule.selector !== WBNB_DEPOSIT_SELECTOR,
          )) {
            // The 3.19 item-3 RE-GRANT requirement, inherited with the arm's
            // plan: a shift arm wraps BNB into WBNB exactly as a ladder arm
            // does, because it IS the ladder arm. Refused at the ROUTE so the
            // owner reads "your session predates this mode" rather than a
            // provider allowlist code from `preflightExecute` — which stays in
            // place as the backstop for a spec that disagrees with the chain.
            throw new BadRequestError(
              "This agent's session was granted before shift mode and cannot wrap BNB into WBNB, which is how a shift ladder's idle buffer holds its quote half. Re-grant the session (npm run provision-agent) and arm again; nothing was spent.",
            );
          }
        }
        const dual =
          request.levels === 2 && ladder === undefined && shiftBlock === undefined;
        if (dual && !gridIsDual(grid)) {
          throw new BadRequestError(
            "levels: 2 needs the settings' grid block to carry buyRange2 and sellRange2 — level 2's own pair. A dual arm places two levels on FOUR rungs, so a two-rung grid has nothing for the second level to ping-pong between.",
          );
        }
        // PHASE3.22: shift mode joins the ladder's exemption — the validator
        // already refuses buyRange2/sellRange2 under it, so `gridIsDual` is
        // always false here and the conjunct is belt, stated for symmetry.
        if (
          !dual
          && ladder === undefined
          && shiftBlock === undefined
          && gridIsDual(grid)
        ) {
          throw new BadRequestError(
            "These settings carry a four-rung dual grid (buyRange2/sellRange2), so arming it needs levels: 2. Arming one level of a four-rung grid would leave two signed rungs no position will ever occupy; sign levels: 2, or re-sign the settings without the second pair.",
          );
        }

        // (1) chain-and-config admission, checks 1-4 (C1).
        const admission = await admitGridSettings(agent, grid, "arm");
        if (admission === null) {
          // Unreachable: the null-grid case is refused above. Fail closed
          // rather than proceed on an admission that did not happen.
          throw new BadRequestError("The grid block could not be admitted.");
        }
        const { gate, wbnbIsToken0 } = admission;

        // (2) THE ARM'S OWN GATE (R2.3 step 2). Unconditional, on BOTH
        // stored-settings shapes, and it is why C2's second net-edge
        // evaluation is unreachable from here: every live-level state is
        // already refused, so exactly ONE net-edge text exists per request.
        const existing = (
          await lp.store.listPositions(agent.ownerAddress, agent.id)
        ).filter((position) => position.state !== "closed");
        if (existing.length > 0) {
          throw new BadRequestError(
            // PHASE3.17 R2.6 (review M7): the GATE's logic is unchanged — it
            // still refuses on ANY non-closed row — but its sentence was
            // "a grid cannot have a second level", which 3.17 makes false. What
            // an arm cannot do is add levels to a grid that already holds some;
            // it places the WHOLE grid or nothing.
            `This agent already holds ${existing.length} non-closed LP position row(s); an arm places a grid's levels and cannot add to a grid that already holds one. To move the ranges under a live level use live-grid settings; to stand the levels down use the exit or abandon doors, then arm again.`,
          );
        }
        const blocking = await lp.store.getAnyNonTerminalSequence(
          agent.ownerAddress,
          agent.id,
        );
        if (blocking !== null) {
          throw new BadRequestError(
            `This agent has a non-terminal ${blocking.kind} sequence (${blocking.sequenceId}); arming is refused until it settles. Wait for it, or settle it with the owner-signed abandon door.`,
          );
        }

        // (3) THE G-GATE, route seam (R2.6). Against admission's OWN pool read
        // — never a second one, because two reads in one request can disagree
        // and a route that admits on one tick and refuses on another
        // contradicts its own evidence. The mint's `build` asks the same
        // question again on fresh evidence; ONE builder speaks for both.
        const currentTick = gate.state.currentTick;
        const armSide = gridTargetSide(currentTick, grid.buyRange);
        if (armSide === undefined || !gridSideChargesQuote(armSide, wbnbIsToken0)) {
          throw new BadRequestError(
            dual
              ? lpGridDualArmBuyRefusal({
                  where: "route",
                  currentTick,
                  buyRange: grid.buyRange,
                  side: armSide,
                  wbnbIsToken0,
                })
              : lpGridArmRefusal({
                  where: "route",
                  currentTick,
                  buyRange: grid.buyRange,
                  side: armSide,
                  wbnbIsToken0,
                }),
          );
        }

        const relayFeePerSubmitWei =
          lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
        // PHASE3.19 R4.2 — the LADDER's split, at the route seam, for the sell
        // gate and the base-cap pre-check. `swapInWei` is UNSCALED (the whole
        // base half is acquired at arm — N17), and only the MINTS are scaled by
        // `deployPctBps`.
        // PHASE3.22 R5 — a SHIFT arm splits and deploys exactly as a LADDER arm
        // does, because its plan IS the ladder arm's: swap the whole base half,
        // mint `deployPctBps` of each side, leave the rest idle as the
        // two-sided buffer that funds the NEXT motion. `armDeploy` is the one
        // place the two modes' shared number is read, so neither can drift.
        const armDeploy = ladder?.deployPctBps ?? shiftBlock?.deployPctBps;
        const swapInWei =
          dual || armDeploy !== undefined ? gridDualSwapInWei(request.budgetWei) : 0n;
        const quoteHalfWei = request.budgetWei - swapInWei;
        const buyValueWei =
          armDeploy === undefined
            ? request.budgetWei - swapInWei
            : (quoteHalfWei * BigInt(armDeploy)) / 10_000n;
        const idleQuoteWei = armDeploy === undefined ? 0n : quoteHalfWei - buyValueWei;

        /*
         * (3b) PHASE3.17 R3.3 — the DUAL arm's SELL-side gate, at the ROUTE
         * seam, against the QUOTED POST-SWAP price.
         *
         * The arm's own swap runs first inside the batch and moves the price
         * TOWARD the sell rung in both orientations, so a pre-swap verdict is
         * exactly the wrong evidence for this rung. Refusing here costs one
         * signature; not refusing costs a whole atomic batch reverting on gas,
         * systematically, whenever the clearance is thin — which at a zero gap
         * is every time.
         *
         * The quote is ONE read and it does three jobs: this gate, the C12
         * base-cap pre-check below, and the transcript's sell-side figure. The
         * net-edge SIZE deliberately does NOT come from it — see R3.2.
         */
        let quotedSellDesiredWei: bigint | null = null;
        // PHASE3.22: a SHIFT arm takes this gate on the LADDER's terms, because
        // its plan IS the ladder arm's — the same value-wrapped router swap
        // pushes the tick TOWARD the sell rung before the sell mint lands, so
        // the rung must be gated on the QUOTED POST-SWAP price and never on the
        // pre-swap tick.
        if (dual || armDeploy !== undefined) {
          // PHASE3.19: a LADDER's sell rung is `grid.sellRange` (its ONE pair's
          // base-charging side); a DUAL arm's is `sellRange2` (level 2's inner
          // rung). Same gate, same reader, different rung — and the ladder's swap
          // is LARGER relative to what it mints, so the clearance matters more.
          // PHASE3.22: a SHIFT's sell rung is `grid.sellRange` too, for the same
          // reason — one pair, base-charging side. Only a DUAL arm reaches for
          // level 2's inner rung.
          const sellPair =
            ladder === undefined && shiftBlock === undefined
              ? gridPair(grid, 2)
              : gridPair(grid, 1);
          const reader = lp.readers.quoteWithPriceAfter;
          if (sellPair === null) {
            throw new BadRequestError("levels: 2 needs level 2's signed pair.");
          }
          if (reader === undefined) {
            throw new BadRequestError(
              "This deployment's chain readers cannot quote a post-swap price, so a dual arm's sell rung cannot be gated against the price its own swap will create. The arm is refused rather than gated on evidence the batch invalidates.",
            );
          }
          let quoted;
          try {
            quoted = await reader({
              tokenIn: lp.venue.wbnb,
              tokenOut: gate.token,
              fee: grid.pool.fee,
              amountInWei: swapInWei,
            });
          } catch {
            throw new BadRequestError(
              "The dual arm's swap leg could not be quoted, so its sell rung cannot be gated; an arm that cannot be checked is refused.",
            );
          }
          if (
            !gridDualSellClearanceOk({
              sqrtPriceX96After: quoted.sqrtPriceX96After,
              sellRange2: sellPair.sellRange,
              tickSpacing: grid.tickSpacing,
              wbnbIsToken0,
            })
          ) {
            throw new BadRequestError(
              lpGridDualArmSellRefusal({
                where: "route",
                sellRange2: sellPair.sellRange,
                tickSpacing: grid.tickSpacing,
                wbnbIsToken0,
              }),
            );
          }
          // PHASE3.19 R4.2: the ladder approves only the DEPLOYED share of the
          // floor, because that is all its sell mint takes; the rest of the swap
          // output is the buffer's idle base and is never approved to anyone.
          const floorWei = sagaSwapMinOut(quoted.amountOutWei, rails.maxSagaSlippageBps);
          // PHASE3.22: a SHIFT arm shares the LADDER's deployed-share rule,
          // because it is the ladder's plan. A DUAL arm has no idle buffer and
          // therefore no share — it approves the whole floor, unchanged.
          const armDeployPctBps = ladder?.deployPctBps ?? shiftBlock?.deployPctBps;
          quotedSellDesiredWei =
            armDeployPctBps === undefined
              ? floorWei
              : (floorWei * BigInt(armDeployPctBps)) / 10_000n;
        }

        /*
         * (4) the net-edge check, ONCE PER PAIR (R3.2 / review2 N2), each on the
         * size the level it prices will ACTUALLY hold.
         *
         * The audited "exactly ONE net-edge text per request" comment is
         * REWRITTEN here to "exactly one net-edge evaluation per PAIR per
         * request": the invariant's spirit — never two texts about one quantity
         * — survives, and its COUNT changes with the product. Level 1's pair is
         * priced on the quote share; level 2's on the R3.2 lower bound, which is
         * <= its true size by construction, so this admission can only ever be
         * stricter than reality.
         */
        // ─── PHASE3.19 items 25/28 — THE LADDER'S OWN ADMISSION ─────────────
        //
        // ONE evaluation, through the ONE builder (item 25, CALL SITE 1 OF 3):
        // a ladder has ONE pair, so "once per pair" is once. It prices the
        // DEPLOYED rung size — never the budget — because that is what a motion
        // actually mints, and it prices it against `gridCycleSubmissions`'
        // ladder arm rather than the flip floor (H7).
        if (ladder !== undefined) {
          const economics = gridLadderEconomics({
            grid,
            ladder,
            budgetWei: request.budgetWei,
            relayFeePerSubmitWei,
          });
          // ITEM 28 — THE MINIMUM BUDGET, refused with BOTH relay figures and
          // the pad NAMED. M1's worked case put a `standard`-preset ladder near
          // 2 BNB at the shipped padded constant and near 0.8 at the measured
          // one, one to two orders of magnitude above the 0.06 BNB the (ax) live
          // run used — so an operator must be told this AT ARM TIME rather than
          // discovering it as a refusal. C10: the figure printed is for the
          // configuration ACTUALLY SIGNED (hedge on/off moves it by ~50%), never
          // M1's own number inherited as "the" minimum.
          if (economics.minBudgetWei === null) {
            throw new BadRequestError(
              `Grid arm refused: no budget clears this ladder's own minNetEdgeBps of ${grid.minNetEdgeBps} at a gross edge of ${economics.edge.grossEdgeBps} bps. Widening the budget cannot help; the geometry has to change.`,
            );
          }
          if (request.budgetWei < economics.minBudgetWei) {
            // C9's ordering, inside the 280-char ceiling: BOTH relay figures
            // lead (neither is reconstructible from anywhere else, and the gap
            // between them is what decides whether a small wallet can arm at
            // all), the signed budget follows, and the remedy is the tail. The
            // measured rate is 3.88e13 wei/submission (FINDINGS (av), 10 real
            // submissions), so the same geometry costs ~38.8% of the padded
            // figure — printed rather than described.
            throw new BadRequestError(
              `Grid arm refused: this ladder needs ${economics.minBudgetWei} wei at the `
                + `shipped ${relayFeePerSubmitWei} wei/submission pad `
                + `(${economics.submissionsPerCycle}/cycle), or `
                + `${(economics.minBudgetWei * 388n) / 1_000n} at the measured 38800000000000; `
                + `you signed ${request.budgetWei}. `
                + `Remedy: raise the budget, or recalibrate LP_RELAY_FEE_PER_SUBMIT_WEI.`,
            );
          }
          if (!economics.edge.ok) {
            throw new BadRequestError(
              lpGridNetEdgeRefusal(economics.edge, "Grid arm refused"),
            );
          }
          // ITEM 26 / OQ4 — the MARKOUT FLOOR, at the ROUTE because it needs the
          // deployment's saga-slippage rail (the M16 split's own criterion). The
          // GATE additionally takes the max, so a stored value below the floor
          // can never make the gate looser than this refusal claimed.
          const floorBps = ladderMinMarkoutBps({
            poolFee: grid.pool.fee,
            maxSagaSlippageBps: rails.maxSagaSlippageBps,
            signedMinMarkoutBps: 0,
          });
          if (ladder.hedge.minMarkoutBps < floorBps) {
            throw new BadRequestError(
              `Grid arm refused: grid.ladder.hedge.minMarkoutBps is ${ladder.hedge.minMarkoutBps}, under this pool's own execution cost of ${floorBps} bps (pool fee ${Math.floor(grid.pool.fee / 100)} + the ${rails.maxSagaSlippageBps} bps saga slippage rail). A hedge that clears only its own fee is a fee paid twice, not a profit. Sign ${floorBps} or more.`,
            );
          }
          // ITEM 24's floor also bounds the width check the four-rung loop above
          // does for the SIGNED rungs: every rung the ladder ever derives
          // inherits `ladder.widthTicks`, so it is checked on the GEOMETRY and
          // not only on the two rungs signed today — the C10 discipline 3.18
          // applied to `grid.policy`.
          if (ladder.widthTicks > lp.runtime.maxTickWidth) {
            throw new BadRequestError(
              `grid.ladder.widthTicks is ${ladder.widthTicks}, over this deployment's LP_MAX_TICK_WIDTH of ${lp.runtime.maxTickWidth}. In ladder mode every rung the re-anchor ever derives inherits this width, so it is checked on the geometry and not only on the two signed rungs.`,
            );
          }
        }
        const armPairs: { readonly pair: 1 | 2; readonly sizeWei: bigint }[] = dual
          ? [
              { pair: 1, sizeWei: buyValueWei },
              {
                pair: 2,
                sizeWei: gridDualSellSizeWei({
                  swapInWei,
                  poolFee: grid.pool.fee,
                  maxPriceImpactBps: rails.maxPriceImpactBps,
                  maxSagaSlippageBps: rails.maxSagaSlippageBps,
                }),
              },
            ]
          : [{ pair: 1, sizeWei: request.budgetWei }];
        const armEdges: LpGridNetEdge[] = [];
        // A LADDER's admission ran ABOVE, once, through `gridLadderEconomics` —
        // so this loop is skipped rather than run a SECOND net-edge evaluation
        // on the same pair with a different `submissionsPerCycle`. Exactly one
        // net-edge text per request survives, which is the audited invariant.
        // PHASE3.22: a SHIFT arm is priced by its own builder below, exactly as
        // a ladder is, so it takes no per-pair signed-rung pricing here.
        for (const entry of
          ladder === undefined && shiftBlock === undefined ? armPairs : []) {
          const pair = gridNetEdgePair(grid, entry.pair);
          if (pair === null) throw new BadRequestError("levels: 2 needs level 2's signed pair.");
          const pairEdge = gridNetEdge({
            pair,
            minNetEdgeBps: grid.minNetEdgeBps,
            sizeWei: entry.sizeWei,
            relayFeePerSubmitWei,
          });
          if (!pairEdge.ok) {
            throw new BadRequestError(lpGridNetEdgeRefusal(pairEdge, "Grid arm refused"));
          }
          armEdges.push(pairEdge);
        }
        // PHASE3.22 R2.14, CALL SITE 1 OF 3 — the ARM ROUTE. A shift arm is
        // admitted on the SAME builder the C2 re-sign guard and the client
        // transcript read, so the floor an owner is shown BEFORE signing is the
        // floor the route admits on — the 3.13 F12 cannot-diverge rule, which
        // is exactly what R2.14's "one builder, three call sites" buys.
        // PHASE3.25 R2.3 — the shift builder always returned the three
        // admission facts; the route previously discarded two and never acted
        // on the third. Keep one evaluation and apply the ladder's refusal
        // order so exactly one net-edge text survives.
        const shiftEconomics =
          shiftBlock === undefined
            ? undefined
            : gridShiftEconomics({
                grid,
                shift: shiftBlock,
                budgetWei: request.budgetWei,
                relayFeePerSubmitWei,
              });
        if (shiftEconomics !== undefined) {
          const refusal = shiftArmEconomicsRefusal({
            economics: shiftEconomics,
            minNetEdgeBps: grid.minNetEdgeBps,
            budgetWei: request.budgetWei,
            relayFeePerSubmitWei,
          });
          if (refusal !== null) throw new BadRequestError(refusal);
        }
        const edge =
          shiftEconomics !== undefined
            ? shiftEconomics.edge
            : ladder === undefined
            ? armEdges[0]
            : gridLadderEconomics({
                grid,
                ladder,
                budgetWei: request.budgetWei,
                relayFeePerSubmitWei,
              }).edge;
        if (edge === undefined) throw new BadRequestError("The grid has no signed pair to price.");

        /*
         * (4b) PHASE3.17 C12 — the BASE-TOKEN CAP, a metering this arm
         * INTRODUCES. 3.16's arm approves nothing at all.
         *
         * The dual batch's `approve(base, nfpm, sellDesired)` meters against the
         * base token's own session cap. An undersized cap reverts the WHOLE
         * atomic batch as an opaque relay failure — fail-closed, gas only, but
         * with no refusal, no remedy and nothing telling the owner which knob to
         * turn. So the route names it before any money.
         *
         * WHAT IS CHECKED, stated honestly: the GRANTED per-token cap from the
         * persisted session spec, not the rolling REMAINING allowance. Reading
         * the remaining ERC-20 allowance for the day would need a chain reader
         * this phase's edit list does not have, and the granted cap is a strict
         * UPPER BOUND on the remaining — so this catches the undersized-cap case
         * (the common one) and cannot produce a false refusal, while a cap
         * already spent down today still fails at the relay. Declared, not
         * papered over.
         */
        if (
          (dual || ladder !== undefined || shiftBlock !== undefined)
          && quotedSellDesiredWei !== null
        ) {
          const baseCap = agent.sessionFacts.spec.spendCaps.find(
            (cap) =>
              cap.token !== undefined
              && cap.token.toLowerCase() === gate.token.toLowerCase(),
          );
          if (baseCap === undefined || baseCap.limit < quotedSellDesiredWei) {
            // THE 280-CHAR BUDGET, spent in the house order: the token and the
            // number that must be raised lead (neither is reconstructible from
            // anywhere else), the consequence is one clause, and the remedy is
            // the tail that must survive. The `--token` VALUE is dropped from
            // the command because the address already leads the sentence.
            throw new BadRequestError(
              `Grid arm refused: the session cap for ${gate.token} is under the `
                + `${quotedSellDesiredWei} wei this ${ladder === undefined ? "dual" : "ladder"} arm `
                + `approves to mint the sell rung; the batch would revert at the relay. `
                + `Remedy: npm run add-spend-limit -- --cap <amount> for that token.`,
            );
          }
        }

        // (5) C2 — EXACTLY ONE `checkLpNativeCapSizing` call and ONE
        // `onChainNativeDailyCapWei` read per request. `/lp/open` runs no
        // sizing check at all; the model is `/lp/import`'s block, with the
        // arm's own two extra terms.
        let liveCapWei: bigint;
        try {
          liveCapWei = await lp.readers.onChainNativeDailyCapWei(agent);
        } catch {
          throw new BadRequestError(
            "The session's live on-chain native cap could not be read; an arm that cannot be sized is refused.",
          );
        }
        const sizing = checkLpNativeCapSizing({
          onChainDailyCapWei: liveCapWei,
          // The SUM, not `budgetWei` alone. Under the gate above the existing
          // term is zero today; writing the sum is what makes this check
          // survive a future two-level shape.
          openNativeBudgetWei: lpOpenNativeBudgetWei(existing) + request.budgetWei,
          ...(trade.feeBps === undefined ? {} : { feeBps: trade.feeBps }),
          maxExitSequencesPerDay: request.settings.maxExitSequencesPerDay,
          // The row(s) this call is about to create — TWO under a dual arm
          // (ruling Q4: `P = max(1, openPositionsCount)` feeds the A3 protect
          // reserve, and an armed level's protect burns the same gas whichever
          // level it is). `MAX_SUBMISSIONS_PER_GRID_FLIP` needs no change: it is
          // per flip, flips stay per level, and the grid lane is agent-wide.
          // PHASE3.19 R4.3/N18: a LADDER arm also places TWO rows, so it passes
          // the same `+2`. Restated explicitly because item 30 adds the moves
          // term and does not restate this one.
          // PHASE3.22: a SHIFT arm also places TWO rows, so it passes the same +2.
          openPositionsCount:
            existing.length
            + (dual || ladder !== undefined || shiftBlock !== undefined ? 2 : 1),
          // PHASE3.15 R2.7 / C7, call site 3 of 3; PHASE3.18 R2.11 adds the
          // requote term beside it, so an arm signed into policy mode reserves
          // for the re-centres the same signature authorizes.
          ...(gridModeOf(grid) === "shift"
            ? {}
            : { maxGridFlipsPerDay: grid.maxFlipsPerDay }),
          ...(grid.requote === undefined
            ? {}
            : { maxRequotesPerDay: grid.requote.maxRequotesPerDay }),
          // PHASE3.19 item 30 — the LADDER lane's own reserve, at FOUR
          // submissions a motion. Without it an armed ladder reserves ZERO
          // native for up to 24 motions a day and this check passes on a cap
          // that cannot pay the gas.
          // PHASE3.20 item 22: TWO named counts, through the ONE normalizer, so
          // a legacy `maxMovesPerDay` signature and a new-form one reserve the
          // same gas for the same number of motions and neither is refused as
          // malformed for a legal zero.
          ...(ladder === undefined
            ? {}
            : {
                settlementsPerDay: ladderMotionCounts(ladder).settlementsPerDay,
                driftMovesPerDay: ladderMotionCounts(ladder).driftMovesPerDay,
              }),
          ...shiftNativeSizingTerm(request.settings),
          ...(lp.relayFeePerSubmitWei === undefined
            ? {}
            : { lpRelayFeePerSubmitWei: lp.relayFeePerSubmitWei }),
        });
        if (!sizing.ok) {
          // The A9 shape: the actionable NUMBER leads, because
          // `sanitizeMessage` caps the body at 280 characters.
          if (sizing.kind === "malformed") {
            throw new BadRequestError(`Grid arm refused: ${sizing.message}`);
          }
          if (shiftBlock !== undefined) {
            throw new LpSizingShortfallError(
              `Grid arm refused: the on-chain daily native cap is too low once this arm's budget and the shift lane's gas are reserved. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, lower the budget, or raise the cap with owner-add-spend-limit. Shortfall (wei): ${sizing.shortfallWei}`,
              sizing.shortfallWei,
            );
          }
          throw new BadRequestError(
            `Grid arm refused: the on-chain daily native cap is short by ` +
              `${sizing.shortfallWei} wei once this arm's budget and the level's ` +
              `exit gas are reserved. Raise it with owner-add-spend-limit, lower ` +
              `the budget, lower maxFlipsPerDay, or lower maxExitSequencesPerDay.`,
          );
        }

        // (6) persist the settings, VERBATIM, under the lpSettings digest. The
        // stored digest hashes bytes the owner DID sign, under a different
        // action label — which is what keeps the worker's every-cycle recompute
        // (and therefore the "settings nobody provably signed" skip) intact
        // while the phase still promises ONE signature.
        const digest = paramsHash("lpSettings", request.settingsParams);
        await lp.settingsStore.put({
          agentId: agent.id,
          ownerAddress: agent.ownerAddress,
          params: request.settingsParams,
          digest,
        });

        // (7) the position row. `basisWei: 0n` because a ping-pong's inventory
        // alternates assets, so a lineage-basis TP/SL would misfire (3.15's
        // rule, unchanged); `basisSource: "minted"` because the plane DID mint
        // this one — "owner-budget" would claim a metered zero and "imported"
        // would claim a position the plane did not create.
        //
        // PHASE3.17 R2.3: a DUAL arm creates TWO rows in one call, both
        // carrying the SAME `arm_group_id`, so either reaches the other from
        // the paths that never see this request — the worker's resume,
        // `runLpOpen`'s rollback and the abandon route. The BUY row is level 1
        // and is the one the SEQUENCE names (R3.4, 3.16 continuity).
        const positionId = randomUUID();
        const siblingPositionId = randomUUID();
        // PHASE3.19 item 37: a LADDER arm is a two-row arm in ALL respects, so
        // it takes an `arm_group_id` for the same reason a dual arm does — the
        // rollback that closes BOTH never-funded rows, the `finish` that verifies
        // both mints before writing either tokenId, and the abandon that resolves
        // the sibling FROM THE ROW all run on paths that never see this request.
        // PHASE3.22: a SHIFT arm places TWO rows and every seam that resolves the
        // pair — the dispatcher's live-role snapshot, the group lock, the abandon
        // disposition, the saga's own row list — reads `arm_group_id`. Omitting
        // it here would leave the pair unpaired and the mode inert.
        const armGroupId =
          dual || ladder !== undefined || shiftBlock !== undefined
            ? randomUUID()
            : undefined;
        const rowInput = {
          agentId: agent.id,
          ownerAddress: agent.ownerAddress,
          token0: grid.pool.token0,
          token1: grid.pool.token1,
          fee: grid.pool.fee,
          basisWei: 0n,
          basisSource: "minted" as const,
          quoteToken: lp.venue.wbnb,
          ...(armGroupId === undefined ? {} : { armGroupId }),
        };
        // PHASE3.18 R2.6 — the DURABLE IDENTITY, written at row creation, which
        // is the only moment the plane knows which level and role it is
        // placing without asking geometry. The BUY row is level 1 (3.16
        // continuity, and the row the sequence names); a dual arm's sibling is
        // level 2's SELL rung. FIXED-mode grids carry the columns too and
        // simply never read them — writing them unconditionally is what makes a
        // later `mode: "policy"` re-sign possible at all, and it is what M7's
        // migration rule then verifies against the exact ticks.
        //
        // PHASE3.19 R3.1/C2 — A LADDER'S TWO ROWS BOTH CARRY `gridLevel: 1` and
        // are distinguished by `gridRole` ALONE. That is the N1 blocker's repair
        // and it is structural, not cosmetic: `gridRoleAtFor` refuses any level
        // whose `gridPair(grid, level)` is null, item 14 refuses
        // `buyRange2`/`sellRange2` under ladder mode, and so a `gridLevel: 2`
        // ladder row would resolve to `null` FOR EVER — the evaluator would hold
        // it permanently, the deps builders would throw, and C2 would refuse
        // every re-sign touching it. Half the ladder would be dead on arrival.
        // `levels: 2` on the ENVELOPE means "two rows, one pair".
        //
        // C4 — the BUY row is created FIRST and is therefore the group's BOOK
        // ANCHOR: `inventoryAnchor` initialises its two book columns to zero,
        // and the sibling's stay NULL for ever. "Which row is the anchor" is
        // answered durably by that, never by ordering two uuids.
        await lp.store.createPosition({
          ...rowInput,
          positionId,
          gridLevel: 1,
          gridRole: "buy",
          // PHASE3.22: NO `inventoryAnchor` for a shift arm. §10 makes the hedge
          // and the VWAP book explicit NON-GOALS for shift rows — the book
          // tables stay and shift mode writes nothing to them — so seeding an
          // anchor would create a number that goes stale with nothing to read
          // it. `seedLadderBook` excludes the mode for the same reason.
          ...(ladder === undefined ? {} : { inventoryAnchor: true }),
        });
        if (dual) {
          await lp.store.createPosition({
            ...rowInput,
            positionId: siblingPositionId,
            gridLevel: 2,
            gridRole: "sell",
          });
        }
        // PHASE3.22 R5 — the SHIFT arm's second row: same pair, same
        // `arm_group_id`, `gridLevel: 1`, split by role. Identical to the
        // ladder's except for the absent book anchor (§10). The BUY row was
        // created FIRST above, which is what makes it the pair's natural
        // dispatcher while it is live (R4.2.4).
        if (ladder !== undefined || shiftBlock !== undefined) {
          await lp.store.createPosition({
            ...rowInput,
            positionId: siblingPositionId,
            gridLevel: 1,
            gridRole: "sell",
          });
        }

        // (8) the saga, under the digest step (6) JUST wrote (C8).
        const sellPairForSaga = dual ? gridPair(grid, 2) : null;
        const result = await runLpOpen(
          lpSagaDeps(agent, rails, request.settings, digest, gate.pool),
          ladder !== undefined
            ? {
                mode: "grid-arm-ladder",
                kind: "grid-arm",
                positionId,
                siblingPositionId,
                budgetWei: request.budgetWei,
                tickLower: grid.buyRange.tickLower,
                tickUpper: grid.buyRange.tickUpper,
                // A ladder's sell rung is its ONE pair's base-charging side.
                sellTickLower: grid.sellRange.tickLower,
                sellTickUpper: grid.sellRange.tickUpper,
                tickSpacing: grid.tickSpacing,
                deployPctBps: ladder.deployPctBps,
              }
            // PHASE3.22 R5 — the SHIFT arm, field for field the ladder's,
            // because its plan IS the ladder's (`buildLpOpenPlan` delegates
            // `"grid-arm-shift"` straight to `buildGridArmLadderPlan`). Its own
            // branch rather than a shared one so that the day either mode gains
            // a field, the other's omission is a visible edit and not a silent
            // mis-supply.
            : shiftBlock !== undefined
            ? {
                mode: "grid-arm-shift",
                kind: "grid-arm",
                positionId,
                siblingPositionId,
                budgetWei: request.budgetWei,
                tickLower: grid.buyRange.tickLower,
                tickUpper: grid.buyRange.tickUpper,
                // R2.22: `buyRange`/`sellRange` REMAIN REQUIRED and are used by
                // the ARM ONLY — the first two rungs mint at them and no shift
                // ever targets them again. They are the arm's geometry, not
                // dead fields.
                sellTickLower: grid.sellRange.tickLower,
                sellTickUpper: grid.sellRange.tickUpper,
                tickSpacing: grid.tickSpacing,
                deployPctBps: shiftBlock.deployPctBps,
              }
            : dual && sellPairForSaga !== null
            ? {
                mode: "grid-arm-dual",
                kind: "grid-arm",
                positionId,
                siblingPositionId,
                budgetWei: request.budgetWei,
                tickLower: grid.buyRange.tickLower,
                tickUpper: grid.buyRange.tickUpper,
                sellTickLower: sellPairForSaga.sellRange.tickLower,
                sellTickUpper: sellPairForSaga.sellRange.tickUpper,
                tickSpacing: grid.tickSpacing,
              }
            : {
                mode: "grid-arm",
                kind: "grid-arm",
                positionId,
                budgetWei: request.budgetWei,
                tickLower: grid.buyRange.tickLower,
                tickUpper: grid.buyRange.tickUpper,
              },
        );
        const position = await lp.store.getPosition(
          agent.ownerAddress,
          agent.id,
          positionId,
        );
        const sibling =
          dual || ladder !== undefined
            ? await lp.store.getPosition(agent.ownerAddress, agent.id, siblingPositionId)
            : null;

        return {
          position: position === null ? null : lpPositionView(position),
          ...(sibling === null ? {} : { siblingPosition: lpPositionView(sibling) }),
          arm: {
            sequenceId: result.sequenceId,
            status: result.status,
            code: result.code,
            reason: result.reason,
            ...(result.tokenId === undefined ? {} : { tokenId: result.tokenId }),
            ...(result.siblingTokenId === undefined
              ? {}
              : { siblingTokenId: result.siblingTokenId }),
            note: lpGridArmReceiptNote(
              result.status,
              dual || ladder !== undefined || shiftBlock !== undefined,
            ),
          },
          settingsDigest: digest,
          // M8: SCOPED to what is meaningful at arm time — the derived range,
          // the side, the net-edge figures and the minted tokenId. Deliberately
          // NOT the full `gridOwnerView` assembly: its quota, cycle-ledger and
          // observation reads are all EMPTY at arm time, and its `restart`
          // branch is the text a rolled-back arm would then contradict.
          grid: {
            ...admission.view,
            levels:
              dual || ladder !== undefined || shiftBlock !== undefined ? 2 : 1,
            // PHASE3.19 D9 / M6 — THE DEPLOYED-VS-IDLE LINE, at the one moment
            // it is exact: the arm's own three values are what the batch is
            // about to attach, so at arm time this is arithmetic and not a
            // balance read. The OWNER VIEW's later figures are chain reads and
            // carry the M6 honest sentence; this one does not need it.
            ...(ladder === undefined
              ? {}
              : {
                  ladder: {
                    deployPctBps: ladder.deployPctBps,
                    idlePctBps: 10_000 - ladder.deployPctBps,
                    swapInWei: swapInWei.toString(10),
                    deployedBuyWei: buyValueWei.toString(10),
                    idleQuoteWei: idleQuoteWei.toString(10),
                    deployedSellFloorWei: (quotedSellDesiredWei ?? 0n).toString(10),
                    // PHASE3.20 D1: the two lanes as the owner signed them, read
                    // through the ONE normalizer so a legacy signature is
                    // reported the way it is ENFORCED (settlements = the legacy
                    // number, drift disabled until re-signed) rather than the
                    // way it was written.
                    settlementsPerDay: ladderMotionCounts(ladder).settlementsPerDay,
                    driftMovesPerDay: ladderMotionCounts(ladder).driftMovesPerDay,
                    legacyMaxMovesPerDay: ladder.maxMovesPerDay ?? null,
                    maxStrandedMinutes: ladderStrandedMinutes(
                      ladder,
                      request.settings.minMinutesBetweenExits,
                    ).value,
                    // PHASE3.20 R4.3/B3 — the ROUTE DISCLOSES, the CLIENT
                    // REFUSES. `admitGridSettings` is untouched: an arm-route
                    // refusal below the multiple would edit the admission of the
                    // arm, which D6 freezes and whose body R3.7 concedes is
                    // unread. The figure is here so an owner who armed at the
                    // printed minimum can read what it buys.
                    fundableFills: gridLadderResilience({
                      budgetWei: request.budgetWei,
                      minBudgetWei:
                        gridLadderEconomics({
                          grid,
                          ladder,
                          budgetWei: request.budgetWei,
                          relayFeePerSubmitWei,
                        }).minBudgetWei,
                      deployPctBps: ladder.deployPctBps,
                    }).fundableFills,
                    requiredBudgetMultipleBps: gridLadderResilience({
                      budgetWei: request.budgetWei,
                      minBudgetWei: null,
                      deployPctBps: ladder.deployPctBps,
                    }).requiredMultipleBps,
                    hedge: {
                      enabled: ladder.hedge.enabled,
                      minMarkoutBps: ladder.hedge.minMarkoutBps,
                      maxHedgePctBps: ladder.hedge.maxHedgePctBps,
                    },
                    note:
                      "deployPctBps applies ONCE PER SIDE to that side's half, so total deployed is deployPctBps of the whole budget (not double it) and the idle buffer is two-sided by construction. The idle quote half is WBNB in your own EOA; the idle base half is the part of the swap output the sell rung did not take.",
                  },
                }),
            armedRange: {
              tickLower: grid.buyRange.tickLower,
              tickUpper: grid.buyRange.tickUpper,
              role: "buy",
              side: armSide,
              chargesQuote: true,
            },
            // PHASE3.17 review2 N13: for a DUAL arm this receipt is the owner's
            // only in-product account of what was just placed, and the singular
            // `armedRange` above describes half of it. Every rung of every pair
            // is reported, with the size its own level was admitted on, so an
            // owner can see where each counter-order will land (C10).
            ...(dual
              ? {
                  armedLevels: [
                    {
                      level: 1,
                      role: "buy",
                      positionId,
                      chargesQuote: true,
                      armedRange: grid.buyRange,
                      counterRange: grid.sellRange,
                      sizeWei: buyValueWei.toString(10),
                    },
                    {
                      level: 2,
                      role: "sell",
                      positionId: siblingPositionId,
                      chargesQuote: false,
                      armedRange: gridPair(grid, 2)?.sellRange ?? null,
                      counterRange: gridPair(grid, 2)?.buyRange ?? null,
                      sizeWei: (armPairs[1]?.sizeWei ?? 0n).toString(10),
                      swapInWei: swapInWei.toString(10),
                      note:
                        "SMALLER than level 1 by the pool fee, the swap's price impact and the pre-commit floor haircut — the size shown is the conservative LOWER bound the admission used, not a promise.",
                    },
                  ],
                  splitBps: GRID_DUAL_SPLIT_BPS,
                  netEdges: armEdges.map((each) => gridNetEdgeView(each)),
                }
              : {}),
            netEdge: gridNetEdgeView(edge),
            firstFlipFloor:
              `The agent is live, but the FIRST flip cannot fire before ` +
              `minMinutesBetweenExits (${request.settings.minMinutesBetweenExits} min) ` +
              `has elapsed: the arm's own reservation moves the agent-wide spacing ` +
              `anchor, which counts quota-exempt rows too.` +
              // PHASE3.17 R2.6 (review M5): the PER-LEVEL number, because
              // `maxFlipsPerDay` is AGENT-WIDE and a dual grid therefore halves
              // each level's round trips — a figure the owner is signing for and
              // which the 3.16 text quietly described as if there were one level.
              (dual
                ? ` maxFlipsPerDay (${grid.maxFlipsPerDay}) is AGENT-WIDE and counts BOTH levels,`
                  + ` so each level gets about ${Math.floor(grid.maxFlipsPerDay / 2)} flips a day;`
                  + ` the spacing gate also staggers two same-observation flips by at least`
                  + ` ${request.settings.minMinutesBetweenExits} min.`
                : ""),
          },
        };
      }),
    );

    /* ---- POST /agents/:id/lp/open ----------------------------------------- */

    app.post("/agents/:id/lp/open", (c) =>
      ownerMutation(c, c.req.param("id"), "lpOpen", "lpOpen", async ({ agent, params }) => {
        const parsed = parseLpOpenParams(params);
        if (!parsed.ok) throw new BadRequestError(parsed.message);
        const request = parsed.value;
        const rails = requireRails();
        if (agent.sessionFacts === null) {
          throw new BadRequestError("Agent has no granted session; an open cannot be exited and is refused.");
        }
        const { settings, digest } = await currentLpSettings(agent);
        const resolved = await resolveLpArmPool(agent, rails, settings, request);
        const candidate = resolved.candidate;
        const gate = resolved.gate;
        const selectionMeta = resolved.selectionMeta;
        if (request.pool === undefined) {
          const grantedToken = lpRankedDiscoveryToken(agent.sessionFacts.spec, lp.venue.wbnb);
          if (!grantedToken.ok || gate.token.toLowerCase() !== grantedToken.token.toLowerCase()) {
            throw new BadRequestError("The selected pool's token is not the token this session was granted for.");
          }
        }

        /* ---- the range: owner-signed or server-fenced (item 27) ---------- */

        const { tickLower, tickUpper } = resolveLpOpenRange(gate.state, request.range);

        /* ---- position row, then the saga (spec ordering) ------------------ */

        // PHASE3.6 Rev2 M8(b): the same refusal at the OTHER admission
        // surface, through the same predicate. An armed trigger outlives the
        // position it was set for; without this the next open into that pool
        // is liquidated two cycles later by somebody else's threshold.
        const armedPriceAtOpen = alreadySatisfiedPriceTrigger(
          settings,
          candidate,
          gate.state.currentTick,
        );
        if (armedPriceAtOpen !== null) {
          throw new BadRequestError(
            `A price ${armedPriceAtOpen.label === "stopLoss" ? "stop-loss" : "take-profit"} is armed for this pool and is ALREADY satisfied at tick ${gate.state.currentTick} (trigger: ${armedPriceAtOpen.trigger.when} ${armedPriceAtOpen.trigger.tick}); the position would be exited almost immediately. Clear or move the trigger first.`,
          );
        }

        const positionId = randomUUID();
        await lp.store.createPosition({
          positionId,
          agentId: agent.id,
          ownerAddress: agent.ownerAddress,
          token0: candidate.token0,
          token1: candidate.token1,
          fee: candidate.fee,
          // Lineage basis = the owner-signed budget (R7, basisSource
          // "owner-budget" is the store's only v1 source).
          basisWei: request.budgetWei,
          // PHASE3.1-AUDIT A3. The record's quote asset is the DEPLOYMENT'S
          // configured WBNB, written here rather than left to
          // `createPosition`'s `DEFAULT_QUOTE_TOKEN` fallback — a hardcoded
          // BNB-Chain-56 literal that is simply WRONG on any other chain, and
          // whose wrongness was the entire justification for the exit keying
          // its swap off `venue.wbnb` instead of off this field. Authoring it
          // closes the silent-drift seam at its source: from here on the
          // persisted field and the pool's own quote leg agree by
          // construction, on mainnet and on testnet alike. The exit still
          // treats the POOL'S OWN WBNB leg as the authority (see
          // `runExitSaga`) — that deviation stands and is now an erratum to
          // Rev2 item 5, because `poolLegs` is fail-closed on a WBNB leg and
          // the two can no longer disagree.
          quoteToken: lp.venue.wbnb,
        });
        const result = await runLpOpen(
          lpSagaDeps(agent, rails, settings, digest, gate.pool),
          {
            // PHASE3.16 R2.4: `/lp/open` states its mode explicitly, like every
            // other caller. Nothing about this route's behaviour changes.
            mode: "two-sided-in-range",
            kind: "open",
            positionId,
            budgetWei: request.budgetWei,
            tickLower,
            tickUpper,
          },
        );
        const position = await lp.store.getPosition(agent.ownerAddress, agent.id, positionId);

        return {
          position: position === null ? null : lpPositionView(position),
          open: {
            sequenceId: result.sequenceId,
            status: result.status,
            code: result.code,
            reason: result.reason,
            ...(result.tokenId === undefined ? {} : { tokenId: result.tokenId }),
          },
          range: { tickLower, tickUpper, source: request.range.kind },
          ...(selectionMeta === undefined ? {} : { selection: selectionMeta }),
        };
      }),
    );

    /* ---- import: the ONE assessment both routes run (PHASE3.4) ------------- */

    /**
     * Everything `POST /lp/import` checks, run identically by
     * `GET /lp/importable/:tokenId` (decision 1).
     *
     * The preview is not a convenience: the owner must SIGN a `basisWei`, and
     * signing a number against a position whose legs, value and admissibility
     * they cannot see is the failure this pair exists to prevent. Because both
     * routes call this one function, a preview that says "importable" followed
     * by an import that refuses is a bug rather than a race — except through the
     * genuinely time-varying inputs (the quote, the pool state, the on-chain
     * cap), which the preview labels as read-at-a-block.
     *
     * NOTE what is NOT here: the breach check and the sizing check. Both need
     * the owner's declared `basisWei`, which the preview does not have — they
     * run in the route, on top of this.
     */
    type LpImportAssessment = {
      readonly token0: Address;
      readonly token1: Address;
      readonly fee: number;
      readonly pool: Address;
      readonly poolState: LpPoolStateReading;
      readonly token: Address;
      readonly wbnbIsToken0: boolean;
      readonly snapshot: LpPositionSnapshot;
      readonly exitValueWei: bigint;
      readonly freshFeesValueWei: bigint;
      readonly tokenTotalWei: bigint;
      readonly wbnbTotalWei: bigint;
      readonly probe: LpExitProbe;
      readonly worstCaseProbe: LpExitProbe;
      readonly existingOwnPosition: LpPositionRecord | null;
    };

    async function assessLpImport(
      agent: AgentRecord,
      rails: LpRailConfig,
      tokenId: string,
    ): Promise<LpImportAssessment> {
      // M12: EXPLICIT, and first. Deferring this to `gateLpPool`'s
      // `sessionCanSell` — which answers `false` on null facts — would refuse
      // truly while diagnosing falsely ("the session cannot sell the pool's
      // token leg" is not what happened). It is also mechanically forced: the
      // sizing check below reads the session's on-chain meter, which does not
      // exist without a session.
      if (agent.sessionFacts === null) {
        throw new BadRequestError(
          "The agent has no granted session, so an imported position could be watched but never rotated, protected or exited. Hire the agent first.",
        );
      }

      // M4: QUIESCENCE. Between a rotate's (or an open's) mint confirming and
      // its `after` hook writing the tokenId, that NFT exists, is owned by this
      // wallet, is funded, and is recorded NOWHERE — so it passes every check
      // below. Importing it there makes the SAGA's own `updatePositionTokenId`
      // the loser of the unique index: a throw inside a saga hook, repeated on
      // every resume, holding a rotate that PHASE3.3's resolution refuses by
      // kind. One agent-scoped read closes the window.
      // AUDIT A5: an indexed one-row probe, not a full load of the agent's
      // entire sequence history. The predicate is unchanged — the store's
      // partial index IS `isTerminalLpSequence` inverted — but this route is
      // reachable through a replayable signed `read` header, so an unbounded
      // table scan per call is the wrong shape for it.
      const blocking = await lp.store.getAnyNonTerminalSequence(
        agent.ownerAddress,
        agent.id,
      );
      if (blocking !== null) {
        throw new BadRequestError(
          `This agent has a non-terminal ${blocking.kind} sequence (${blocking.sequenceId}); an import is refused until it settles, because a saga that is about to record a freshly minted tokenId must not race this row.`,
        );
      }

      const tokenIdBig = BigInt(tokenId);
      const snapshot = await lp.readers.positions(tokenIdBig);
      if (snapshot === "burned") {
        throw new BadRequestError(
          "No such NFPM position: the token does not exist or has been burned.",
        );
      }
      if (
        snapshot.token0 === undefined
        || snapshot.token1 === undefined
        || snapshot.fee === undefined
      ) {
        // A reader that cannot answer the legs cannot admit a position: the
        // whole point is that the LEGS come from chain (decision 3).
        throw new BadRequestError(
          "The position's legs could not be read from the position manager; refusing to admit a position whose pool cannot be verified.",
        );
      }
      if (snapshot.liquidity <= 0n) {
        throw new BadRequestError(
          "The position holds no liquidity; there is nothing to manage. (A rotated-away or already-exited NFT stays in the wallet as an emptied token — this is what that looks like.)",
        );
      }

      // M6, and the FIRST ownership read this codebase has ever made.
      const owner = await lp.readers.ownerOf(tokenIdBig);
      if (owner === "burned") {
        throw new BadRequestError(
          "No such NFPM position: the token does not exist or has been burned.",
        );
      }
      if (owner.toLowerCase() !== agent.walletAddress.toLowerCase()) {
        // M10: the staked case is the COMMON one — MasterChefV3 holds tens of
        // thousands of these — so it gets its own sentence. "Not this wallet's
        // position" would be true and useless.
        const staked = lp.runtime.knownStakers.some(
          (staker) => staker.toLowerCase() === owner.toLowerCase(),
        );
        throw new BadRequestError(
          staked
            ? `This position is staked in a farm (${owner}) rather than held by the wallet. Unstake it on PancakeSwap and import again.`
            : "This position is not held by the agent's wallet.",
        );
      }

      // M13: the per-token operator, already decoded by the ABI and thrown away
      // until now. A nonzero one can move the NFT out from under the automation
      // at any moment. (A blanket `setApprovalForAll` is NOT visible to a
      // per-token read — stated as a residual, and handled after the fact by the
      // worker's ownership gate, which does not care what caused the loss.)
      // AUDIT A6: `undefined` refuses, exactly as an undefined leg does. The
      // field is optional on the type so hand-built test snapshots still
      // typecheck, and the first build read that optionality as "absent is
      // fine" — which made the ONE admission check for outstanding approvals
      // vanish for any wiring that omitted it, with no refusal and no failing
      // test. Present-but-defeatable is the shape this phase keeps meeting.
      if (snapshot.operator === undefined) {
        throw new BadRequestError(
          "The position's approval state could not be read from the position manager; refusing to admit a position whose outstanding approvals are unknown.",
        );
      }
      if (snapshot.operator.toLowerCase() !== zeroAddress.toLowerCase()) {
        throw new BadRequestError(
          `This position carries an outstanding approval to ${snapshot.operator}, which could move it out from under the automation. Revoke it and import again.`,
        );
      }

      // M5's pre-check. The index is the guarantee; this is the readable voice,
      // and there are exactly two of them — see the catch in the route.
      const existingOwnPosition = await lp.store.getPositionByTokenId(
        agent.ownerAddress,
        agent.id,
        tokenId,
      );
      if (existingOwnPosition !== null) {
        throw new BadRequestError(
          `This agent already manages NFPM tokenId ${tokenId} as position ${existingOwnPosition.positionId}; there is nothing to import.`,
        );
      }

      // Decision 3: the SAME admission surface an explicit-pool open runs —
      // WBNB leg by identity, the LP forbidden set, `sessionCanSell` on BOTH
      // legs, pool existence, TWAP readability, cardinality, liquidity.
      const gate = await gateLpPool(agent, rails, {
        token0: snapshot.token0,
        token1: snapshot.token1,
        fee: snapshot.fee,
      });
      if (!gate.ok) throw new BadRequestError(gate.message);

      const wbnbIsToken0 =
        snapshot.token0.toLowerCase() === lp.venue.wbnb.toLowerCase();

      // Decision 11: the ONE valuation, the same code the trigger will use.
      // A QuoterV2 revert is NOT caught (M9): a valuation that cannot price the
      // token leg has proved nothing, and the correct answer is to refuse.
      let valuation;
      try {
        valuation = await valueLpPosition(lp.readers, {
          tokenId: tokenIdBig,
          wallet: agent.walletAddress,
          fee: snapshot.fee,
          token: gate.token,
          wbnb: lp.venue.wbnb,
          wbnbIsToken0,
          spotSqrtPriceX96: gate.state.evidence.spotSqrtPriceX96,
        });
      } catch {
        throw new BadRequestError(
          "The position's token leg could not be quoted; a position whose exit value cannot be read is not admitted.",
        );
      }
      if (valuation === "burned") {
        throw new BadRequestError(
          "No such NFPM position: the token does not exist or has been burned.",
        );
      }

      // Decision 7 / M9: THE EXIT PROBE. This is what discharges
      // PHASE3.1-AUDIT A7's obligation for a second admission surface. It is the
      // EXIT's reading (pool fee deducted), not `/lp/open`'s stricter one, and
      // that asymmetry is principled: open prices the swap it is about to
      // EXECUTE, where strictness costs one signature; import prices the swap
      // the exit WOULD need, where refusing leaves a position the owner already
      // holds unmanaged, which protects nobody.
      const tokenIsToken0 = !wbnbIsToken0;
      let probe: LpExitProbe;
      let worstCaseProbe: LpExitProbe;
      try {
        probe = await probeLpExitImpact(lp.readers.quote, {
          amountInWei: valuation.tokenTotalWei,
          fee: snapshot.fee,
          token: gate.token,
          wbnb: lp.venue.wbnb,
          spotSqrtPriceX96: gate.state.evidence.spotSqrtPriceX96,
          tokenIsToken0,
          maxImpactBps: rails.maxPriceImpactBps,
        });
        // DISCLOSURE, never a refusal (M9). The probe above sizes today's mix;
        // a stop-loss fires after the price moved, by which point the position
        // has converged toward all-token — the largest swap the exit will ever
        // make, at worse depth. `/lp/open` has the identical blind spot, so the
        // refusal stays at the current-mix reading and the owner is TOLD about
        // the other one.
        worstCaseProbe = await probeLpExitImpact(lp.readers.quote, {
          amountInWei: maxTokenAmountWei({ snapshot, wbnbIsToken0 }),
          fee: snapshot.fee,
          token: gate.token,
          wbnb: lp.venue.wbnb,
          spotSqrtPriceX96: gate.state.evidence.spotSqrtPriceX96,
          tokenIsToken0,
          maxImpactBps: rails.maxPriceImpactBps,
        });
      } catch {
        throw new BadRequestError(
          "The exit-impact probe could not be quoted; a position whose exitability cannot be proved is not admitted.",
        );
      }
      if (!probe.withinRail) {
        throw new BadRequestError(
          `The position cannot be exited within the manipulation rail today: converting its ${valuation.tokenTotalWei} wei token leg quotes at ${probe.impactBps} bps against a ceiling of ${probe.maxImpactBps}.`,
        );
      }

      return {
        token0: snapshot.token0,
        token1: snapshot.token1,
        fee: snapshot.fee,
        pool: gate.pool,
        poolState: gate.state,
        token: gate.token,
        wbnbIsToken0,
        snapshot,
        exitValueWei: valuation.exitValueWei,
        freshFeesValueWei: valuation.freshFeesValueWei,
        tokenTotalWei: valuation.tokenTotalWei,
        wbnbTotalWei: valuation.wbnbTotalWei,
        probe,
        worstCaseProbe,
        existingOwnPosition,
      };
    }

    /** The assessment, rendered. Shared so preview and receipt cannot drift. */
    function lpImportAssessmentView(
      assessment: LpImportAssessment,
    ): Record<string, unknown> {
      return {
        pool: assessment.pool,
        token0: assessment.token0,
        token1: assessment.token1,
        fee: assessment.fee,
        quoteToken: lp.venue.wbnb,
        tickLower: assessment.snapshot.tickLower,
        tickUpper: assessment.snapshot.tickUpper,
        currentTick: assessment.poolState.currentTick,
        liquidity: assessment.snapshot.liquidity.toString(10),
        operator: assessment.snapshot.operator ?? null,
        blockNumber: assessment.poolState.evidence.blockNumber.toString(10),
        value: {
          exitValueWei: assessment.exitValueWei.toString(10),
          freshFeesValueWei: assessment.freshFeesValueWei.toString(10),
          wbnbLegWei: assessment.wbnbTotalWei.toString(10),
          tokenLegWei: assessment.tokenTotalWei.toString(10),
          note:
            "Read at one block. exitValueWei prices the token leg through QuoterV2, so it is a sellable value rather than a mid-price mark.",
        },
        exitProbe: {
          amountInWei: assessment.probe.amountInWei.toString(10),
          impactBps: assessment.probe.impactBps.toString(10),
          maxImpactBps: assessment.probe.maxImpactBps,
          withinRail: assessment.probe.withinRail,
        },
        // M9. The number that is NOT a refusal, and the sentence that says why
        // an owner should still read it.
        worstCaseConversion: {
          amountInWei: assessment.worstCaseProbe.amountInWei.toString(10),
          impactBps: assessment.worstCaseProbe.impactBps.toString(10),
          maxImpactBps: assessment.worstCaseProbe.maxImpactBps,
          withinRail: assessment.worstCaseProbe.withinRail,
          note:
            "A stop-loss fires at the worst mix: by then the position has converged to all-token, the largest swap an exit ever makes. If that conversion exceeds the rail on the day, the exit completes and returns the token leg as-is rather than BNB.",
        },
      };
    }

    /* ---- GET /agents/:id/lp/importable/:tokenId ---------------------------- */

    app.get("/agents/:id/lp/importable/:tokenId", async (c) => {
      const id = c.req.param("id");
      const auth = await authorizeRead(c, id);
      if (auth.kind !== "ok") return auth.response;
      const agent = await deps.agentStore.getAgent(auth.owner.ownerAddress, id);
      if (agent === null) return fail(c, 404, "not_found");
      const tokenId = c.req.param("tokenId");
      if (!isCanonicalUint256Decimal(tokenId)) {
        return fail(
          c,
          400,
          "invalid_request",
          "tokenId must be a uint256 in canonical decimal (no leading zeros, no sign, no hex).",
        );
      }
      if (!lp.railsResult.ok) {
        return fail(c, 400, "invalid_request", lp.railsResult.failure.reason);
      }
      try {
        const assessment = await assessLpImport(
          agent,
          lp.railsResult.config,
          tokenId,
        );
        return c.json({
          data: {
            tokenId,
            importable: true,
            assessment: lpImportAssessmentView(assessment),
            basis: {
              required: true,
              zeroIsLegal: true,
              note:
                "basisWei is YOUR declaration, not a measurement — this plane cannot know what you paid. It becomes the TP/SL anchor. Sign 0 to have the position rotated and compounded with no stop-loss and no take-profit.",
            },
            protection: {
              note:
                "A newly imported position holds no observation, so a protect cannot fire before two finalized evaluations at least one worker interval apart. GET /agents/:id/lp reports armed and confirmationEligibleAtMs.",
            },
          },
        });
      } catch (error) {
        if (error instanceof BadRequestError) {
          // A preview REFUSAL is the product, not an error: it is the answer to
          // "can I import this?", and the owner reads it before signing.
          return c.json({
            data: {
              tokenId,
              importable: false,
              reason: sanitizeMessage(error.message),
            },
          });
        }
        throw error;
      }
    });

    /* ---- POST /agents/:id/lp/import ---------------------------------------- */

    app.post("/agents/:id/lp/import", (c) =>
      ownerMutation(c, c.req.param("id"), "lpImport", "lpImport", async ({ agent, params }) => {
        const parsed = parseLpImportParams(params);
        if (!parsed.ok) throw new BadRequestError(parsed.message);
        const request = parsed.value;
        const rails = requireRails();
        const assessment = await assessLpImport(agent, rails, request.tokenId);
        const { settings } = await currentLpSettings(agent);

        // M11: the TRIGGER'S OWN comparison, not a second implementation of it.
        // An import that is already in breach would be liquidated within two
        // worker cycles of an action the owner took to put it UNDER management.
        // If that is really what they want, the exit route needs no import
        // first. Refusing costs one signature.
        const breach = evaluateLpProtectBreach({
          basisWei: request.basisWei,
          exitValueWei: assessment.exitValueWei,
          stopLossPct: settings.stopLossPct,
          takeProfitPct: settings.takeProfitPct,
        });
        if (breach !== null) {
          throw new BadRequestError(
            `The declared basis is already in ${breach.kind} breach (basis ${request.basisWei} wei, exit value ${assessment.exitValueWei} wei, threshold ${breach.thresholdBps} bps), so the automation would exit this position almost immediately. Exit it directly instead, or re-sign with basisWei 0 to manage it without a VALUE stop-loss (a price trigger, if one is armed for this pool, protects regardless of the basis — PHASE3.6).`,
          );
        }

        // PHASE3.6 Rev2 M8(a): an armed price trigger for THIS pool that is
        // already satisfied would liquidate this position within two worker
        // cycles of the import. Same shape and same site as the value refusal
        // above, through the ONE shared predicate.
        const armedPrice = alreadySatisfiedPriceTrigger(
          settings,
          { token0: assessment.token0, token1: assessment.token1, fee: assessment.fee },
          assessment.poolState.currentTick,
        );
        if (armedPrice !== null) {
          throw new BadRequestError(
            `A price ${armedPrice.label === "stopLoss" ? "stop-loss" : "take-profit"} is armed for this pool and is ALREADY satisfied at tick ${assessment.poolState.currentTick} (trigger: ${armedPrice.trigger.when} ${armedPrice.trigger.tick}), so the automation would exit this position almost immediately. Clear or move the trigger, or exit directly instead.`,
          );
        }

        // PHASE3.15 R2.1 — THE GRID'S ADMISSION, and it is the whole of the
        // grid's entry path. There is NO grid open: `/lp/open` refuses any
        // range that does not contain the tick and refuses a single-sided
        // deposit, both deliberately and both pre-money, and a grid level is
        // single-sided and out of range BY CONSTRUCTION. So the owner mints
        // their first level by hand on PancakeSwap — an ordinary range order in
        // that UI — and imports it here, which deletes a whole runner, deletes
        // the phase's only native-attaching surface, and (M7) makes the RESTART
        // path after an abandon fall out for free: the inventory is already the
        // asset the next level wants, so re-minting and re-importing needs no
        // currency conversion.
        const gridEdge = await admitGridImport(assessment, settings, request.basisWei);

        // Decision 9(2): the import SIZES, which `/lp/open` does not
        // (`checkLpNativeCapSizing`'s only production caller is
        // `POST /lp/settings`). An imported row adds a protect's worth of relay
        // gas to the reserve and nothing else — its declared basis is excluded
        // from the budget term by `lpOpenNativeBudgetWei`.
        let liveCapWei: bigint;
        try {
          liveCapWei = await lp.readers.onChainNativeDailyCapWei(agent);
        } catch {
          throw new BadRequestError(
            "The session's live on-chain native cap could not be read; an import that cannot be sized is refused.",
          );
        }
        const existing = (
          await lp.store.listPositions(agent.ownerAddress, agent.id)
        ).filter((position) => position.state !== "closed");
        const sizing = checkLpNativeCapSizing({
          onChainDailyCapWei: liveCapWei,
          openNativeBudgetWei: lpOpenNativeBudgetWei(existing),
          ...(trade.feeBps === undefined ? {} : { feeBps: trade.feeBps }),
          maxExitSequencesPerDay: settings.maxExitSequencesPerDay,
          // +1: the row this call is about to create.
          openPositionsCount: existing.length + 1,
          // PHASE3.15 R2.7 / C7, call site 2 of 3. Threading the term at one
          // site only would be a reserve that exists for a grid armed one way
          // and not the other. PHASE3.18 R2.11 adds the requote term here for
          // the identical reason.
          ...(settings.grid === null || gridModeOf(settings.grid) === "shift"
            ? {}
            : { maxGridFlipsPerDay: settings.grid.maxFlipsPerDay }),
          ...(settings.grid?.requote === undefined
            ? {}
            : { maxRequotesPerDay: settings.grid.requote.maxRequotesPerDay }),
          ...shiftNativeSizingTerm(settings),
          ...(lp.relayFeePerSubmitWei === undefined
            ? {}
            : { lpRelayFeePerSubmitWei: lp.relayFeePerSubmitWei }),
        });
        if (!sizing.ok) {
          // The A9 shape: the actionable NUMBER leads, because `sanitizeMessage`
          // caps the body at 280 characters and the arithmetic alone overruns.
          if (sizing.kind === "malformed") {
            throw new BadRequestError(`LP import refused: ${sizing.message}`);
          }
          if (settings.grid !== null && gridModeOf(settings.grid) === "shift") {
            throw new LpSizingShortfallError(
              `LP import refused: the on-chain daily native cap is too low once this position's protect gas and the shift lane's gas are reserved. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, or raise the cap. Shortfall (wei): ${sizing.shortfallWei}`,
              sizing.shortfallWei,
            );
          }
          throw new BadRequestError(
            `LP import refused: the on-chain daily native cap is short by ` +
              `${sizing.shortfallWei} wei once this position's protect gas is ` +
              `reserved. Raise it with owner-add-spend-limit, lower ` +
              `maxExitSequencesPerDay, or close a position. Importing spends ` +
              `nothing on chain; this reserve is the exit's gas.`,
          );
        }

        const positionId = randomUUID();
        let position: LpPositionRecord;
        try {
          position = await lp.store.createPosition({
            positionId,
            agentId: agent.id,
            ownerAddress: agent.ownerAddress,
            token0: assessment.token0,
            token1: assessment.token1,
            fee: assessment.fee,
            // From the CONFIRMED chain read, not from the caller (decision 3).
            tokenId: request.tokenId,
            basisWei: request.basisWei,
            // Decision 4: recorded as the DECLARATION it is. Writing
            // "owner-budget" here would claim a budget nothing ever metered.
            basisSource: "imported",
            quoteToken: lp.venue.wbnb,
          });
        } catch (error) {
          // M5: the race the pre-check cannot win. Two voices, and only two —
          // and the same typed error carries both, so the index and the
          // pre-check speak with one mouth.
          if (error instanceof LpTokenIdInUseError) {
            const own = await lp.store.getPositionByTokenId(
              agent.ownerAddress,
              agent.id,
              request.tokenId,
            );
            throw new BadRequestError(
              own !== null
                ? `This agent already manages NFPM tokenId ${request.tokenId} as position ${own.positionId}; there is nothing to import.`
                : "This position is already under management.",
            );
          }
          throw error;
        }

        return {
          position: lpPositionView(position),
          assessment: lpImportAssessmentView(assessment),
          ...(gridEdge === null ? {} : { grid: gridEdge }),
          basis: {
            basisWei: request.basisWei.toString(10),
            basisSource: "imported",
            protectConfigured:
              settings.stopLossPct > 0 || settings.takeProfitPct > 0,
            note:
              request.basisWei === 0n
                ? "basisWei is 0: this position will be rotated and compounded, and NO stop-loss or take-profit will ever fire for it. Re-import with a declared basis to arm protection."
                : "basisWei is your own declared number, recorded as a declaration (basisSource: imported) and never as a measured budget. It is the anchor TP/SL compares against.",
          },
          protection: {
            note:
              "Protection is configured now but cannot FIRE before two finalized evaluations at least one worker interval apart, because this position holds no observation yet. GET /agents/:id/lp reports confirmationEligibleAtMs.",
          },
          note:
            "Nothing moved. The NFT stays in your own wallet exactly where it was; this call recorded a row and nothing else.",
        };
      }),
    );

    /* ---- POST /agents/:id/lp/:positionId/exit ------------------------------ */

    app.post("/agents/:id/lp/:positionId/exit", (c) =>
      ownerMutation(c, c.req.param("id"), "lpExit", "lpExit", async ({ agent, params }) => {
        const parsed = parseLpExitParams(params);
        if (!parsed.ok) throw new BadRequestError(parsed.message);
        const positionId = c.req.param("positionId");
        if (parsed.value.positionId !== positionId) {
          // The signature binds a DIFFERENT position than the path names —
          // the same class of mismatch `requireBinding` refuses for agentId.
          throw new BadRequestError("The signed positionId does not match the path.");
        }
        const rails = requireRails();
        const position = await lp.store.getPosition(agent.ownerAddress, agent.id, positionId);
        if (position === null) throw new LpPositionNotFoundError(positionId);
        let pool: Address | null;
        try {
          pool = await lp.readers.getPool(position.token0, position.token1, position.fee);
        } catch {
          pool = null;
        }
        if (pool === null) {
          throw new BadRequestError(
            "The position's pool could not be resolved; the exit cannot derive its floors.",
          );
        }
        const { settings, digest } = await currentLpSettings(agent);
        // ─── PHASE3.22 R5.6 / D6(b) — THE SHIFT GROUP LOCK, AT THE ONE OWNER
        // DOOR THAT HAD NO ROUTE GATE ─────────────────────────────────────
        //
        // A shift is ONE sequence that moves TWO positions, and every other
        // guard in this plane is POSITION-scoped: `driveSequence`'s conflict
        // check looks up `getNonTerminalSequence` for THIS position, which
        // finds nothing for the sibling of a row whose shift is in flight.
        // REVIEW2's N8 enumerated the owner doors and found this the only one
        // with no route-level gate at all — so an owner-signed manual exit
        // against the sibling would dispatch a second saga into the very NFTs
        // the shift's twelve-call batch is about to move.
        //
        // The predicate is MODE FIRST (`gridShiftGroupLock`), so a LADDER pair
        // — which also carries `arm_group_id` — falls out at the first conjunct
        // and this route stays byte-identical for it. `driveSequence` is NOT
        // touched: D6 established the predicate is not even evaluable there,
        // and option (ii) keeps the position-scoped check identical for every
        // saga. The WORKER carries the group-scoped half a different way — it
        // folds the whole arm group into its RESUME PARTITION, which suppresses
        // the sibling's dispatch (protect included) while leaving its `ownerOf`
        // check and observation write running. Both halves exist; only this one
        // calls the predicate directly.
        if (
          gridShiftGroupLock({
            grid: settings.grid,
            armGroupId: position.armGroupId,
          })
        ) {
          const groupRows = (
            await lp.store.listPositions(agent.ownerAddress, agent.id)
          ).filter((row) => row.armGroupId === position.armGroupId);
          for (const row of groupRows) {
            const live = await lp.store.getNonTerminalSequence(
              agent.ownerAddress,
              agent.id,
              row.positionId,
            );
            if (live !== null && live.kind === "grid-shift") {
              throw new BadRequestError(
                `SEQUENCE_CONFLICT: this position's shift ladder has a grid-shift in flight on ${live.positionId === positionId ? "this rung" : "its other rung"}. A shift may target one or both rungs, and the pair remains group-locked while it settles. Wait for it to settle, or abandon it first.`,
              );
            }
          }
        }
        // The saga runs `manual-exit`: quota-EXEMPT by store construction
        // (Rev2 item 13) and exposure-REDUCING under pause (item 16) — the
        // route wires, the landed store/saga behaviour decides.
        const result = await runLpManualExit(
          lpSagaDeps(agent, rails, settings, digest, pool),
          positionId,
          parsed.value.inlineConvert,
        );
        // Retention (PHASE3.2 Rev2 item 12): an exit that CLOSED the lineage
        // retires its observation row with it, so the table does not
        // accumulate one dead row per closed lineage for ever. Derived state —
        // a failure here must never turn a completed exit into an error.
        try {
          const after = await lp.store.getPosition(
            agent.ownerAddress,
            agent.id,
            positionId,
          );
          if (after === null || after.state === "closed") {
            await lp.observations.delete(agent.ownerAddress, agent.id, positionId);
          }
        } catch {
          /* the row is derived; a failed sweep costs one dead row */
        }
        // PHASE3.1 Rev2 item 15: an exit that COMPLETED with its swap leg
        // skipped still owes the owner a sentence — they are holding an ERC-20
        // the plane no longer tracks. `null` on every ordinary exit.
        let note: string | null = null;
        let inlineConvert = false;
        let inlineResidueBaseWei: string | null = null;
        try {
          const sequence = await lp.store.getSequence(
            agent.ownerAddress,
            agent.id,
            result.sequenceId,
          );
          note = sequence?.note ?? null;
          inlineConvert = sequence?.inlineConvert ?? false;
          inlineResidueBaseWei = sequence?.inlineResidueBaseWei?.toString(10) ?? null;
        } catch {
          /* the note explains; it never decides */
        }
        return {
          exit: {
            sequenceId: result.sequenceId,
            status: result.status,
            code: result.code,
            reason: result.reason,
            confirmedSteps: result.confirmedSteps,
            note,
            inlineConvert,
            inlineResidueBaseWei,
            submissionModel:
              "Every submitted batch is atomic, but this position may take ONE OR TWO submissions.",
          },
        };
      }),
    );

    /* ---- POST /agents/:id/lp/sequences/:sequenceId/abandon --------------- */

    /**
     * PHASE3.8 F4a. The OTHER half of the stuck-sequence story.
     *
     * `resolveUnknown` is keyed on a journal row and asks a CHAIN question.
     * FINDINGS (aq) is a sequence with no row to name at all — a build refused
     * above `appendStep`, so nothing was recorded and nothing was submitted —
     * and the row-keyed resolver cannot express it. This asks the LOCAL
     * question instead, and the answer is provable: the plane always writes the
     * journal row before it submits, so a settled-or-absent row set means no
     * submission is outstanding.
     *
     * Registered inside `registerLpRoutes` for the same reason the resolve
     * route is: a deployment with no `ServerDeps.lp` must 404 rather than
     * advertise a capability it cannot exercise.
     */
    app.post("/agents/:id/lp/sequences/:sequenceId/abandon", (c) =>
      ownerMutation(
        c,
        c.req.param("id"),
        "abandonSequence",
        "abandonSequence",
        async ({ agent, params }) => {
          const parsed = parseLpAbandonParams(params);
          if (!parsed.ok) throw new BadRequestError(parsed.message);
          // Signed AND in the path, so `paramsHash` binds it and a mismatch is
          // the same class of refusal the resolve route makes for its decision
          // id.
          if (parsed.value.sequenceId !== c.req.param("sequenceId")) {
            throw new BadRequestError("The signed sequenceId does not match the path.");
          }

          const sequence = await lp.store.getSequence(
            agent.ownerAddress,
            agent.id,
            parsed.value.sequenceId,
          );
          if (sequence === null) {
            // Byte-identical to a wrong-owner sequence: a 404 must not be an
            // existence oracle for another owner's rows.
            throw new NotFoundError("Sequence not found.");
          }

          // PHASE3.8-FIXREVIEW N1. This is a STORE CAS, not a second read.
          // The exact HELD version is atomically moved to `abandoning`, a
          // non-terminal state excluded from the worker queue and from the
          // worker's legal `held -> active` transition. Whichever process wins
          // owns the sequence; the loser refuses before reading evidence or
          // touching the position.
          const claimId = randomUUID();
          const claimed = await lp.store.claimSequenceForAbandon(
            agent.ownerAddress,
            agent.id,
            sequence.sequenceId,
            {
              expectedUpdatedAt: sequence.updatedAt,
              claimId,
              nowMs: nowMs(),
              minIdleMs: lp.workerIntervalMs,
            },
          );
          if (claimed === null) {
            throw new BadRequestError(
              "The sequence changed while the abandon was being claimed. Stop the LP worker, wait one worker interval, refresh the sequence, and retry.",
            );
          }

          let dispositionStarted = false;
          try {
            // Gather every row only AFTER the claim. The worker can no longer
            // append or resume, so this is one stable local-state proof rather
            // than the stale snapshot N1 reproduced.
            const stepRows = new Map<string, JournalEntry | null>();
            for (const step of sequence.steps) {
              stepRows.set(
                step.journalIdempotencyKey,
                await deps.journal.get(step.journalIdempotencyKey),
              );
            }
            const nextIndexRow = await deps.journal.getByDecision(
              agent.id,
              lpStepDecisionId(sequence.sequenceId, sequence.steps.length),
            );

            const position = await lp.store.getPosition(
              agent.ownerAddress,
              agent.id,
              sequence.positionId,
            );
            if (position === null) {
              throw new NotFoundError("Sequence not found.");
            }

            // PHASE3.17 R2.3 — the dual arm's group, resolved FROM THE ROW.
            // This route has no request-side knowledge that the sequence was a
            // dual arm, which is exactly why the pairing had to be durable.
            const armGroupRows =
              position.armGroupId === null
                ? [position]
                : (await lp.store.listPositions(agent.ownerAddress, agent.id))
                    .filter((row) => row.armGroupId === position.armGroupId);
            const armGroupPositionIds = armGroupRows.map((row) => row.positionId);

            const verdict = verifyLpAbandonSequence({
              // Verify the exact snapshot the CAS matched. `claimed` differs
              // only by lease state/time; the evidence belongs to this version.
              sequence,
              stepRows,
              nextIndexRow,
              positionState: position.state,
              nowMs: nowMs(),
              minIdleMs: lp.workerIntervalMs,
              armGroupPositionIds,
              // PHASE3.22 R5.4 / D4(b): the worker's stall-latch threshold,
              // passed IN so `abandonSequence` stays pure and never imports the
              // worker. It is what opens tier 2 of the COMMITTED grid-shift
              // abandon, and nothing else reads it.
              // `exactOptionalPropertyTypes` is on, so an absent dep must be an
              // ABSENT key rather than an explicit `undefined` — which is also
              // the honest encoding of "this deployment did not configure it",
              // and keeps the fail-closed reading (tier 2 never opens).
              ...(lp.stallLatchAttempts === undefined
                ? {}
                : { stallLatchAttempts: lp.stallLatchAttempts }),
              // PHASE3.22 R3.2: the NFTs the declared-ambiguity note must name.
              // Positionally aligned with `armGroupPositionIds` by construction
              // — both are derived from `armGroupRows` in order.
              armGroupTokenIds: armGroupRows.map((row) => row.tokenId),
            });
            if (!verdict.ok) {
            // A plain refusal, NOT an `OwnerActionRefusal`.
            // `JournalResolutionEvidence` is shaped for a RESOLUTION —
            // `observedBlock`, `legs`, `logAbsence` — none of which this action
            // has, and widening it would reach the archived shape
            // PHASE3.7-REVIEW M8 already found under-specified. The action own
            // journal row records the refusal message, exactly as it does for
            // every other local-only owner action.
            // AUDIT A6: the full check list is truncated at 280 chars and
            // reached neither the operator nor the row — measured, zero of them
            // survived. The REFUSAL REASON is what an operator needs, and it is
            // already in `verdict.message`; only the last check adds anything,
            // because that is the one that failed.
              const failing = verdict.checks[verdict.checks.length - 1];
              throw new BadRequestError(
                `${verdict.code}: ${verdict.message}` +
                  (failing === undefined ? "" : ` (${failing.name})`),
              );
            }

            // Persist this boundary BEFORE the position write. A failure or
            // crash after it must leave `abandoning` in place for a stale-lease
            // re-sign, never return the sequence to a worker that could resume
            // against a partially-applied disposition.
            const begun = await lp.store.beginSequenceAbandonDisposition(
              agent.ownerAddress,
              agent.id,
              sequence.sequenceId,
              claimId,
            );
            if (begun === null) {
              throw new Error("The abandon claim was lost before disposition began.");
            }
            dispositionStarted = true;

          // ORDER — POSITION FIRST, SEQUENCE LAST, and AUDIT A1 is why.
          //
          // The previous order copied `resolveUnknown`'s and claimed the same
          // re-runnability. It did not have it. Both writes are individually
          // idempotent, but rolling the sequence back flips
          // `isTerminalLpSequence`, and check (a) refuses a terminal sequence —
          // so a crash between the two writes left the position `open` with its
          // original basis and made re-signing return 400 for ever. That is
          // verbatim the harm the old comment said re-runnability prevented.
          // `resolveUnknown` bought the property with an explicit re-entry
          // branch; this action gets it for free by writing the RECOVERABLE
          // thing first and the LATCH last.
          //
          // A crash after the position write and before the sequence write
          // leaves a re-signable action whose position write repeats as a no-op.
            //
            // PHASE3.17 R2.3: the disposition governs every row of the group —
            // but only for the kinds whose PLAN is group-wide, which is what
            // `positionScope` decides. A single-position sequence (every exit,
            // harvest, rotate and flip) governs its own row and nothing else:
            // closing a sibling it never touched is what left NFT 7316794 live
            // on chain under a `closed` row on 2026-09-03.
            const dispositionIds =
              verdict.positionScope === "group"
                ? armGroupPositionIds
                : [sequence.positionId];
            if (verdict.positionAction === "close") {
              for (const id of dispositionIds) {
                await lp.store.setPositionState(
                  agent.ownerAddress,
                  agent.id,
                  id,
                  "closed",
                );
              }
            } else if (verdict.positionAction === "restore-open") {
              // ─── PHASE3.22 R5.7 / REVIEW4 D7 — RESTORE-OPEN SKIPS CLOSED
              // ROWS, and the `close` arm above deliberately takes no such
              // filter ────────────────────────────────────────────────────
              //
              // D7's failure scenario, in full: a shift pair goes one-sided
              // (the buy row closed `shift-depleted`, R4.2.2). A later
              // `manual-exit` on the SURVIVOR is abandoned while its position
              // row is `closing`, so the disposition is `restore-open` — and
              // this loop, unfiltered, would re-open BOTH rows. The dormant one
              // would come back `state: "open"` holding the tokenId of an NFT
              // the shift already emptied: the worker dispatches it,
              // `ownerOf`/liquidity checks disagree, it takes two confirmations
              // a cycle apart to close again, and in the meantime the arm gate
              // (which refuses on ANY non-closed row) blocks a re-arm the owner
              // has no other way to reach.
              //
              // R5.7 chose the STATE filter over keying on `closeReason`,
              // which D7 offered as the alternative. The state is the property
              // that actually matters — "this row was already closed before the
              // abandon, so restoring it is inventing a position" — and it is
              // true of every cause of closure, not only depletion. Keying on
              // the reason would leave an ownership-closed row exposed to the
              // same resurrection.
              //
              // The `close` arm needs no filter because closing a closed row is
              // idempotent, and because closing is never the operation that
              // invents state.
              for (const row of armGroupRows) {
                if (!dispositionIds.includes(row.positionId)) continue;
                if (row.state === "closed") continue;
                await lp.store.setPositionState(
                  agent.ownerAddress,
                  agent.id,
                  row.positionId,
                  "open",
                );
              }
            }
            const completed = await lp.store.completeSequenceAbandon(
              agent.ownerAddress,
              agent.id,
              sequence.sequenceId,
              claimId,
            );
            if (completed === null) {
              throw new Error(
                "The abandon lease was lost after the position disposition; re-sign after one worker interval to finish it.",
              );
            }

            return {
              abandoned: {
                sequenceId: sequence.sequenceId,
                kind: sequence.kind,
                previousState: `${sequence.state}/${sequence.recoveryState}`,
                positionId: sequence.positionId,
                positionAction: verdict.positionAction,
                checks: verdict.checks,
              },
              // PHASE3.22 R3.2 — a verdict that OWES the owner a sentence
              // replaces the standing note; every other disposition keeps it
              // byte-identical. Only the two `grid-shift` arms produce one, and
              // they must: the standing note's "value stays where it went" is
              // true but useless when the plane can no longer say WHICH NFTs
              // hold that value, which is exactly the shift's ambiguous case.
              note:
                verdict.note ??
                "Nothing was submitted, retried or undone. Steps that already " +
                "COMMITTED moved value and that value stays where it went — the " +
                "checks above name each one. This action only stops the sequence " +
                "from blocking the agent.",
            };
          } catch (error) {
            if (!dispositionStarted) {
              // Best effort, but compare-and-set by claim id. A concurrent
              // stale reclaimer must never be released by this process. A
              // release outage must not hide the actual refusal either: the
              // safe residual state is `abandoning`, reclaimed after the lease.
              try {
                await lp.store.releaseSequenceAbandonClaim(
                  agent.ownerAddress,
                  agent.id,
                  sequence.sequenceId,
                  claimId,
                );
              } catch {
                /* fail closed in abandoning; preserve the original error */
              }
            }
            throw error;
          }
        },
      ),
    );

    /* ---- POST /agents/:id/journal/:decisionId/retire-pre-bind/v1 -------- */

    app.post("/agents/:id/journal/:decisionId/retire-pre-bind/v1", async (c) => {
      const body = await readJsonBody(c, maxBodyBytes);
      if (body.kind === "error") return body.response;
      const envelope = parseOwnerActionEnvelope(body.value);
      const id = c.req.param("id");
      if (!envelope.ok || requireBinding(envelope.value, "retireLpPreBindV1", id) !== null) {
        return fail(c, 401, "owner_auth_failed");
      }
      const parsed = parseLpRetirePreBindV1Params(envelope.value.params);
      if (!parsed.ok || parsed.value.decisionId !== c.req.param("decisionId")) {
        return fail(c, 400, "invalid_request", parsed.ok
          ? "The signed decisionId does not match the path."
          : parsed.message);
      }
      const actionKey = ownerActionIdempotencyKey(envelope.value.signed);
      let action = await deps.journal.get(actionKey);
      let agent: AgentRecord | null;
      if (action === null) {
        let rateLimited = false;
        let owner: OwnerAuthResult;
        try {
          owner = await authorizeOwnerAction(envelope.value, {
            ...verifyOptions(), nonceStore: deps.nonceStore,
            beforeNonceConsume: (result) => {
              if (!ownerLimiter.tryConsume(result.ownerAddress.toLowerCase())) {
                rateLimited = true;
                throw new OwnerAuthError("Per-owner rate limit exceeded.");
              }
            },
          });
        } catch (error) {
          if (rateLimited) return fail(c, 429, "rate_limited");
          if (error instanceof OwnerAuthError) return fail(c, 401, "owner_auth_failed");
          throw error;
        }
        agent = await deps.agentStore.getAgent(owner.ownerAddress, id);
        if (agent === null) return fail(c, 404, "not_found");
        const target = await deps.journal.getByDecision(agent.id, parsed.value.decisionId);
        if (target === null || target.kind !== "lp") return fail(c, 404, "not_found");
        const candidateSequenceId = lpSequenceIdOfStepDecision(parsed.value.decisionId);
        const candidateSequence = candidateSequenceId === null ? null : await lp.store.getSequence(
          agent.ownerAddress, agent.id, candidateSequenceId,
        );
        const candidatePosition = candidateSequence === null ? null : await lp.store.getPosition(
          agent.ownerAddress, agent.id, candidateSequence.positionId,
        );
        if (candidateSequence === null || candidatePosition === null) return fail(c, 404, "not_found");
        // Do not leave a PENDING action row for a candidate that cannot ever
        // claim.  A fresh action may also take over an expired, untouched
        // retirement lease: validate its *existing* fenced snapshot first so
        // the later reclaim CAS is reachable without widening first-claim
        // admission to a row that crossed the bind boundary.
        try {
          if (candidateSequence.state === "active" || candidateSequence.state === "held") {
            verifyPreBindRetirement(target, candidateSequence, candidatePosition);
          } else if (candidateSequence.state === "retiring-pre-bind") {
            verifyPreBindRetirementClaim(target, candidateSequence, candidatePosition);
            if (candidateSequence.retirementDispositionStarted ||
                candidateSequence.retirementLeaseUntil === null ||
                candidateSequence.retirementLeaseUntil > nowMs()) {
              throw new Error("The LP sequence is held by another retirement action.");
            }
          } else {
            throw new Error("The LP row is not a current pre-bind retirement candidate.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid pre-bind retirement candidate.";
          return fail(c, 400, "invalid_request", message);
        }
        action = await deps.journal.begin({
          idempotencyKey: actionKey, agentId: agent.id, ownerAddress: agent.ownerAddress,
          kind: "retireLpPreBindV1", externalRef: { retirementAction: {
            scheme: "retire-lp-pre-bind-action-v1", targetJournalKey: target.idempotencyKey,
            decisionId: parsed.value.decisionId, state: "PENDING",
          } },
        });
      } else {
        if (action.kind !== "retireLpPreBindV1" || action.agentId !== id) {
          return fail(c, 409, "conflict");
        }
        const result = action.externalRef.retirementResult;
        if (action.state === "COMMITTED" && result !== undefined) {
          return c.json({ data: result, meta: { action: "retireLpPreBindV1", agentId: id } });
        }
        agent = await deps.agentStore.getAgent(getAddress(action.ownerAddress), id);
        if (agent === null) return fail(c, 404, "not_found");
      }

      const actionDescriptor = action.externalRef.retirementAction;
      if (actionDescriptor === undefined || actionDescriptor.decisionId !== parsed.value.decisionId) {
        return fail(c, 409, "conflict");
      }
      const target = await deps.journal.get(actionDescriptor.targetJournalKey);
      const sequenceId = lpSequenceIdOfStepDecision(parsed.value.decisionId);
      const sequence = sequenceId === null ? null : await lp.store.getSequence(
        agent.ownerAddress, agent.id, sequenceId,
      );
      const position = sequence === null ? null : await lp.store.getPosition(
        agent.ownerAddress, agent.id, sequence.positionId,
      );
      if (target === null || sequence === null || position === null) return fail(c, 404, "not_found");

      // A stale action may have lost its lease to another authenticated action
      // which then finished the one no-submit disposition.  Its exact retry
      // must not remain an opaque PENDING row: the terminal target/position/
      // sequence facts are enough to complete only this local action with the
      // finalizer module's canonical result.  This branch cannot reach the
      // target's `UNKNOWN → ROLLED_BACK` edge.
      if (action.state === "PENDING" && target.state === "ROLLED_BACK" &&
          target.externalRef.retirementEvidence?.scheme === "retired-pre-bind-v1" &&
          sequence.state === "rolled-back" && position.state === "closed" &&
          position.basisWei === 0n && position.tokenId === null) {
        const result = preBindRetirementResult({ decisionId: parsed.value.decisionId,
          targetJournalKey: target.idempotencyKey, sequenceId: sequence.sequenceId,
          positionId: position.positionId });
        await deps.journal.completePreBindRetirementAction(actionKey,
          preBindRetirementActionCompletionRef({ decisionId: parsed.value.decisionId,
            targetJournalKey: target.idempotencyKey, sequenceId: sequence.sequenceId,
            positionId: position.positionId }, result));
        return c.json({ data: result, meta: { action: "retireLpPreBindV1", agentId: agent.id } });
      }

      try {
        let claimed = sequence;
        if (sequence.state === "active" || sequence.state === "held") {
          const admission = verifyPreBindRetirement(target, sequence, position);
          const claimedResult = await lp.store.claimSequenceForPreBindRetirement(
            agent.ownerAddress, agent.id, sequence.sequenceId, {
              expectedState: sequence.state, expectedRecoveryState: sequence.recoveryState,
              expectedUpdatedAt: sequence.updatedAt, expectedPositionId: position.positionId,
              expectedPositionVersion: position.rowVersion,
              expectedRetirementRowVersion: sequence.retirementRowVersion,
              targetJournalKey: admission.targetJournalKey, actionIdempotencyKey: actionKey,
              snapshotHash: admission.snapshotHash, leaseUntilMs: nowMs() + PRE_BIND_RETIREMENT_LEASE_MS,
            },
          );
          if (claimedResult === null) throw new BadRequestError("The LP sequence changed while retirement was being claimed.");
          claimed = claimedResult;
        } else if (sequence.state === "retiring-pre-bind") {
          verifyPreBindRetirementClaim(target, sequence, position);
          const leaseExpired = sequence.retirementLeaseUntil !== null &&
            sequence.retirementLeaseUntil <= nowMs();
          if (sequence.retirementActionIdempotencyKey !== actionKey) {
            if (sequence.retirementDispositionStarted || !leaseExpired) {
              throw new BadRequestError("The LP sequence is held by another retirement action.");
            }
            const reclaimed = await lp.store.reclaimSequenceForPreBindRetirement(
              agent.ownerAddress, agent.id, sequence.sequenceId, {
                targetJournalKey: target.idempotencyKey, expectedFence: sequence.retirementFence,
                expectedRetirementRowVersion: sequence.retirementRowVersion,
                actionIdempotencyKey: actionKey, snapshotHash: sequence.retirementSnapshotHash!,
                nowMs: nowMs(), leaseUntilMs: nowMs() + PRE_BIND_RETIREMENT_LEASE_MS,
              },
            );
            if (reclaimed === null) {
              throw new BadRequestError("The pre-bind retirement lease changed before it could be reclaimed.");
            }
            claimed = reclaimed;
          } else if (!sequence.retirementDispositionStarted && leaseExpired) {
            const renewed = await lp.store.reclaimSequenceForPreBindRetirement(
              agent.ownerAddress, agent.id, sequence.sequenceId, {
                targetJournalKey: target.idempotencyKey, expectedFence: sequence.retirementFence,
                expectedRetirementRowVersion: sequence.retirementRowVersion,
                actionIdempotencyKey: actionKey, snapshotHash: sequence.retirementSnapshotHash!,
                nowMs: nowMs(), leaseUntilMs: nowMs() + PRE_BIND_RETIREMENT_LEASE_MS,
              },
            );
            if (renewed === null) throw new BadRequestError("The pre-bind retirement lease changed before retry.");
            claimed = renewed;
          }
        }
        if (claimed.state !== "retiring-pre-bind" ||
            claimed.retirementTargetJournalKey !== target.idempotencyKey ||
            claimed.retirementActionIdempotencyKey !== actionKey) {
          throw new BadRequestError("The LP sequence is held by another retirement action.");
        }
        verifyPreBindRetirementClaim(target, claimed, position);
        if (preBindRetirementFinalizer === undefined) {
          throw new Error("PRE_BIND_RETIREMENT_FINALIZER_UNAVAILABLE");
        }
        const result = await preBindRetirementFinalizer.finalize({
          owner: agent.ownerAddress, agentId: agent.id, decisionId: parsed.value.decisionId,
          targetJournalKey: target.idempotencyKey, actionIdempotencyKey: actionKey,
          sequenceId: claimed.sequenceId, positionId: position.positionId,
          fence: claimed.retirementFence,
          expectedRetirementRowVersion: claimed.retirementRowVersion,
          expectedPositionVersion: position.rowVersion, now: nowMs(),
        });
        return c.json({ data: result, meta: { action: "retireLpPreBindV1", agentId: agent.id } });
      } catch (error) {
        if (error instanceof BadRequestError) return fail(c, 400, "invalid_request", error.message);
        if (error instanceof NotFoundError) return fail(c, 404, "not_found");
        throw error;
      }
    });

    /* ---- POST /agents/:id/journal/:decisionId/resolve-landing/v1 -------- */

    // Phase 3.9c is capability-hidden when the durable observer is not wired.
    // This mirrors the rest of the LP surface: an unwired production build
    // must not advertise an endpoint that can only answer "unavailable".
    if (lp.landingEvidence !== undefined) {
      const landingEvidence = lp.landingEvidence;
      app.post("/agents/:id/journal/:decisionId/resolve-landing/v1", (c) =>
        ownerLandingMutation(c, c.req.param("id"), async ({ agent, params, idempotencyKey }) => {
          const parsed = parseLpResolveLandingV1Params(params);
          if (!parsed.ok) throw new BadRequestError(parsed.message);
          if (parsed.value.decisionId !== c.req.param("decisionId")) {
            throw new BadRequestError("The signed decisionId does not match the path.");
          }

          const row = await deps.journal.getByDecision(agent.id, parsed.value.decisionId);
          if (row === null || row.kind !== "lp") throw new NotFoundError();
          const sequenceId = lpSequenceIdOfStepDecision(parsed.value.decisionId);
          const sequence = sequenceId === null ? null : await lp.store.getSequence(
            agent.ownerAddress, agent.id, sequenceId,
          );
          if (sequence === null) throw new NotFoundError();
          const position = await lp.store.getPosition(
            agent.ownerAddress, agent.id, sequence.positionId,
          );
          if (position === null) throw new NotFoundError();

          const currentStep = sequence.steps.findIndex(
            (step) => step.journalIdempotencyKey === row.idempotencyKey,
          );
          if (currentStep < 0) throw new NotFoundError();
          const priorRows: JournalEntry[] = [];
          for (const step of sequence.steps.slice(0, currentStep)) {
            const prior = await deps.journal.get(step.journalIdempotencyKey);
            if (prior === null) {
              throw new BadRequestError("The LP sequence journal history is incomplete.");
            }
            priorRows.push(prior);
          }

          return resolveUnknownLandingV1({
            decisionId: parsed.value.decisionId,
            row,
            sequence,
            position,
            priorRows,
            actionIdentity: {
              owner: agent.ownerAddress.toLowerCase(),
              agent: agent.id,
              kind: "resolveUnknownLandingV1",
              idempotencyKey,
            },
            deps: {
              journal: deps.journal,
              sequences: lp.store,
              evidenceStore: landingEvidence.store,
              evidenceProvider: landingEvidence.provider,
              receipts: lp.readers.receipts,
              positions: lp.readers.positions,
              now: nowMs,
              resolverLeaseMs: landingEvidence.resolverLeaseMs,
              ...(landingEvidence.finalizer === undefined ? {} : {
                finalizer: landingEvidence.finalizer,
              }),
            },
          });
        }),
      );
    }

    /* ---- POST /agents/:id/journal/:decisionId/resolve --------------------- */

    /**
     * The operator half of UNKNOWN (PHASE3.3; `PHASE3.3-REVIEW.md` Revision 2).
     *
     * REGISTERED HERE, INSIDE `registerLpRoutes`, and the path shape and the
     * registration site are answering two different questions (Rev2 item 8).
     * The PATH is generic because that is the right long-term home and costs
     * nothing. The REGISTRATION is LP-scoped because `registerLpRoutes` is
     * conditional: a deployment that does not wire `ServerDeps.lp` gets
     * byte-identical 404s on every LP path, and a journal route on the core
     * surface would EXIST on such a deployment while being able to do nothing
     * but refuse — advertising a generic capability that is 100% unavailable.
     * Where LP is wired, every request this route accepts is one it can
     * actually verify.
     *
     * The signature does not assert a fact. It authorizes the SERVER to check
     * one and act on what it finds; the row records the server's findings and
     * never the caller's claim, so a mistaken or coerced owner cannot corrupt
     * journal state.
     */
    app.post("/agents/:id/journal/:decisionId/resolve", (c) =>
      ownerMutation(
        c,
        c.req.param("id"),
        "resolveUnknown",
        "resolveUnknown",
        async ({ agent, params }) => {
          const parsed = parseLpResolveParams(params);
          if (!parsed.ok) throw new BadRequestError(parsed.message);
          // The decision id is in the SIGNED params (so `paramsHash` binds it)
          // AND in the path; a mismatch is the same class of refusal
          // `requireBinding` makes for agentId and the exit route makes for
          // positionId. Hono decodes the path segment, so the colons in
          // `lp:<uuid>:<n>` compare as themselves whether or not a client
          // percent-encoded them.
          const pathDecisionId = c.req.param("decisionId");
          if (parsed.value.decisionId !== pathDecisionId) {
            throw new BadRequestError("The signed decisionId does not match the path.");
          }

          // Agent-scoped by construction: a row under another agent answers
          // `null` here, exactly as an unknown one does.
          const row = await deps.journal.getByDecision(agent.id, parsed.value.decisionId);
          if (row === null) throw new NotFoundError();
          if (row.kind !== "lp") {
            // `no_verifier_for_kind`. `/execute` and `/trade` rows share the
            // decision-id namespace and this build has no verifier for either,
            // so they are never trusted — and the refusal is the SAME 404 an
            // unknown decision id gets, so the route leaks no row existence.
            throw new NotFoundError();
          }

          const sequenceId = lpSequenceIdOfStepDecision(parsed.value.decisionId);
          const sequence =
            sequenceId === null
              ? null
              : await lp.store.getSequence(agent.ownerAddress, agent.id, sequenceId);
          const position =
            sequence === null
              ? null
              : await lp.store.getPosition(
                  agent.ownerAddress,
                  agent.id,
                  sequence.positionId,
                );

          const provider = deps.providerRegistry.get(config.chainId);
          const verdict = await verifyLpResolveUnknown({
            row,
            sequence,
            position,
            wbnb: lp.venue.wbnb,
            nfpm: lp.venue.nfpm,
            observedBlock: parsed.value.observedBlock,
            nowMs: nowMs(),
            minAgeSec: lp.runtime.resolveMinAgeSec,
            discriminatingMultipleBps: lp.runtime.resolveDiscriminatingMultipleBps,
            // PHASE3.3-AUDIT A8. The ONE journal read on this path that is not
            // agent-scoped, and it is safe because of where the keys come from:
            // every key handed to it is a `sequence.steps[i].journalIdempotencyKey`
            // of the sequence fetched owner-AND-agent-scoped above, so a foreign
            // key cannot enter the loop. A refactor that ever sources these keys
            // from the request, or from an unscoped listing, turns this into a
            // cross-tenant read and must switch to `getByDecision(agent.id, …)`.
            readStepRow: (key) => deps.journal.get(key),
            // A1's re-entry guard. Called only on the re-entry path.
            readPositionNonTerminalSequenceId: async () => {
              if (sequence === null) return null;
              const held = await lp.store.getNonTerminalSequence(
                agent.ownerAddress,
                agent.id,
                sequence.positionId,
              );
              return held?.sequenceId ?? null;
            },
            receipts: lp.readers.receipts,
            positions: lp.readers.positions,
            tokenBalance: (token) =>
              provider.getTokenBalance({
                wallet: {
                  address: agent.walletAddress,
                  chainId: config.chainId,
                  ownerAddress: agent.ownerAddress,
                  custodyModel: agent.custodyModel,
                },
                token,
              }),
            ...(lp.readers.blockNumber === undefined
              ? {}
              : { blockNumber: lp.readers.blockNumber }),
            ...(lp.readers.finalizedBlockNumber === undefined
              ? {}
              : { finalizedBlockNumber: lp.readers.finalizedBlockNumber }),
            ...(lp.readers.logAbsence === undefined
              ? {}
              : { logAbsence: lp.readers.logAbsence }),
            // PHASE3.14 F2. ONE bounded relay status read, taken from the
            // provider exactly as `tokenBalance` above is — the relay is the
            // provider's, not `createLpChainReaders`'. `readExecutionStatus` is
            // OPTIONAL on the interface and an absent implementation is wired
            // as an absent reader, which the verifier records and falls through
            // on. `awaitExecution` is deliberately NOT used: it polls to a
            // 120 s deadline and would hold this owner-signed request open for
            // two minutes against a relay that is answering promptly with a
            // status this build does not map.
            ...(provider.readExecutionStatus === undefined
              ? {}
              : {
                  readRelayStatus: async (relayCallsId: Hex) => {
                    const reading = await provider.readExecutionStatus?.({
                      callsId: relayCallsId,
                    });
                    if (reading === undefined) {
                      throw new Error("the provider stopped serving relay status reads");
                    }
                    return {
                      status: reading.receipt.status,
                      rawStatus: reading.rawStatus,
                      ...(reading.receipt.transactionHash === undefined
                        ? {}
                        : { transactionHash: reading.receipt.transactionHash }),
                      ...(reading.receipt.failureCode === undefined
                        ? {}
                        : { failureCode: reading.receipt.failureCode }),
                    };
                  },
                }),
          });

          const evidenceOf = (disposition: string): JournalResolutionEvidence => ({
            action: "resolveUnknown",
            at: nowMs(),
            ownerAddress: agent.ownerAddress,
            observedBlock: parsed.value.observedBlock.toString(10),
            serverBlock:
              verdict.serverBlock === null ? null : verdict.serverBlock.toString(10),
            positionEvidenceBlock:
              verdict.positionEvidenceBlock === null
                ? null
                : verdict.positionEvidenceBlock.toString(10),
            checks: verdict.checks,
            legs: verdict.legs.map((leg) => ({
              token: leg.token,
              neededWei: leg.neededWei.toString(10),
              walletWei: leg.walletWei.toString(10),
              discriminating: leg.discriminating,
            })),
            logAbsence: verdict.logAbsence,
            disposition,
          });

          if (!verdict.ok) {
            // The refusal is recorded on the ACTION's own row; the UNKNOWN row
            // is untouched, which is the whole point of refusing.
            //
            // PHASE3.3-AUDIT A7: `ownerMutation` persists only a 300-character
            // `sanitizeMessage(error.message)`, so the full check list — the
            // interesting artefact when an operator is arguing about WHY the
            // server would not act — used to be returned to the caller and then
            // discarded. `OwnerActionRefusal` carries the bounded evidence
            // through the catch, which writes it onto that same row.
            throw new OwnerActionRefusal(
              `${verdict.code}: ${verdict.message}`,
              evidenceOf(`refused:${verdict.code}`),
            );
          }

          // These are three writes across TWO STORES with no transaction. The
          // journal is always first because its terminal state is the durable
          // discriminator re-entry uses: COMMITTED means advance, ROLLED_BACK
          // means abandon. Once that write lands, it is skipped on every re-sign
          // and the idempotent disposition writes finish forward.
          let resolvedRow: JournalEntry = row;
          if (!verdict.disposition.reEntry) {
            // PHASE3.9a: which write depends on which TRUTH the evidence
            // established. `advance` records COMMITTED because the step
            // provably happened — and recording it ROLLED_BACK would also
            // release a spend the chain actually made, since ROLLED_BACK is the
            // one state outside SPEND_COUNTING_STATES.
            if (verdict.disposition.action === "advance") {
              resolvedRow = await deps.journal.advanceUnknown(
                row.idempotencyKey,
                evidenceOf(verdict.disposition.summary),
              );
            } else {
              resolvedRow = await deps.journal.resolveUnknown(
                row.idempotencyKey,
                evidenceOf(verdict.disposition.summary),
              );
            }
          }

          if (verdict.disposition.action === "advance") {
            // PHASE3.9-FIXREVIEW N2: positive finalized evidence means the
            // liquidity is out. Close and zero the basis BEFORE releasing the
            // sequence lock; a failed position write therefore cannot create a
            // terminal-sequence/closing-position ghost. A failure of the final
            // sequence latch leaves a closed position and is safely re-signable.
            if (verdict.disposition.closePosition) {
              await lp.store.setPositionState(
                agent.ownerAddress,
                agent.id,
                verdict.disposition.positionId,
                "closed",
              );
            }
            await lp.store.setSequenceState(
              agent.ownerAddress,
              agent.id,
              verdict.disposition.sequenceId,
              "rolled-back",
            );
          } else {
            // The independently-audited abandon order remains journal →
            // terminal sequence → restore. Its inference says the withdrawal
            // did not land, so it has no position-closing write to front-load.
            await lp.store.setSequenceState(
              agent.ownerAddress,
              agent.id,
              verdict.disposition.sequenceId,
              "rolled-back",
            );
            if (verdict.disposition.restorePositionToOpen) {
              await lp.store.setPositionState(
                agent.ownerAddress,
                agent.id,
                verdict.disposition.positionId,
                "open",
              );
            }
          }

          if (
            verdict.disposition.action === "abandon" &&
            verdict.disposition.closePosition
          ) {
            // No current abandon verdict uses this branch. Keeping the generic
            // disposition contract complete preserves any future non-advance
            // close without weakening the advance-specific order above.
            // The liquidity is provably out. Leaving the row `closing` is the
            // permanent limbo PHASE3.3-AUDIT A2 named: skipped by the worker,
            // still counted in openPositionsCount, and no second exit will ever
            // finish it.
            await lp.store.setPositionState(
              agent.ownerAddress,
              agent.id,
              verdict.disposition.positionId,
              "closed",
            );
          }

          return {
            resolution: {
              decisionId: parsed.value.decisionId,
              // The journal terminal write returns the persisted row. On
              // re-entry `row` is that same persisted record, so this can never
              // contradict the action through a null-read fallback.
              journalState: resolvedRow.state,
              sequenceId: verdict.disposition.sequenceId,
              positionId: verdict.disposition.positionId,
              action: verdict.disposition.action,
              positionRestoredToOpen: verdict.disposition.restorePositionToOpen,
              // A1: TRUE when this call re-applied an interrupted resolution
              // rather than writing a new one. The row's evidence is the FIRST
              // attempt's, deliberately — one decision, recorded once.
              reEntry: verdict.disposition.reEntry,
              summary: verdict.disposition.summary,
              // Advance rests on direct finalized NFPM state; abandon remains
              // the conservative inference over retained inputs.
              inference: verdict.disposition.action === "abandon",
              observedBlock: parsed.value.observedBlock.toString(10),
              serverBlock:
                verdict.serverBlock === null ? null : verdict.serverBlock.toString(10),
              positionEvidenceBlock:
                verdict.positionEvidenceBlock === null
                  ? null
                  : verdict.positionEvidenceBlock.toString(10),
              checks: verdict.checks.map((check) => ({
                name: check.name,
                result: check.result,
              })),
              legs: verdict.legs.map((leg) => ({
                token: leg.token,
                neededWei: leg.neededWei.toString(10),
                walletWei: leg.walletWei.toString(10),
                discriminating: leg.discriminating,
              })),
              logAbsence: verdict.logAbsence,
              // PHASE3.14 F6: the note is computed WITH the disposition, so
              // the sentence written onto the row and the sentence returned to
              // the caller cannot drift — and so an abandon of a row that
              // reached the relay says the submission may still land, and what
              // that would mean for this step kind.
              note: verdict.disposition.note,
            },
          };
        },
      ),
    );

    /**
     * PHASE3.15 R2.11 — the grid section of the owner view.
     *
     * IT MAKES NO CHAIN READS AND MUST NOT START (L6). Every figure derives
     * from the last persisted OBSERVATION — stamped with its age, so "as of" is
     * honest and never "now" — or from persisted rows. The data plane is never
     * execution authority here, and the failure PHASE3.3-AUDIT A3 named is a
     * dashboard answering from stores while the worker knows better; the fix is
     * to make the worker WRITE what it knows, not to make this route read the
     * chain.
     *
     * THE CYCLE TABLE IS NOT PRESENTED AS COMPLETE (OQ7/L5). `grid_cycles` is
     * derived telemetry written outside the money path, so a crash between the
     * mint confirming and the write loses one row — and so does a pure resume
     * replay. Hence `completedFlips` comes from the SEQUENCE record (the
     * authority on what ran) while every money figure is labelled "over
     * recorded cycles".
     */
    /**
     * PHASE3.19 D9 / M6 — the LADDER's idle buffer and its VWAP book, for the
     * owner view.
     *
     * Returns `{}` for every non-ladder grid, for a deployment whose readers
     * cannot answer a balance, and for a read that FAILS — never a zero, which
     * would be a claim about inventory rather than a reading of it. The BOOK is
     * a store read of the arm group's ANCHOR row (C4): `null` when this ladder
     * has no anchor, which the markout gate refuses on rather than dividing by.
     */
    async function ladderBufferView(
      agent: AgentRecord,
      grid: LpGridSettings,
      positions: readonly LpPositionRecord[],
    ): Promise<{
      buffer?: {
        readonly quoteWei: bigint;
        readonly baseWei: bigint;
        readonly bookBaseWei: bigint | null;
        readonly bookCostWbnbWei: bigint | null;
        readonly nativeWei: bigint | null;
        readonly nextShiftGasWei: bigint | null;
      };
    }> {
      // PHASE3.22 §9: a SHIFT ladder's buffer is reported for the identical
      // reason a 3.19 ladder's is — it is what funds the next motion, and an
      // owner who cannot see it cannot tell a funding hold from a bug. The BOOK
      // columns stay null for a shift pair by construction (§10 makes the VWAP
      // book a non-goal and the arm seeds no anchor), which is the truth.
      if (grid.ladder === undefined && grid.shift === undefined) return {};
      const balanceOf = lp.readers.walletTokenBalance;
      if (balanceOf === undefined) return {};
      const wbnb = lp.venue.wbnb.toLowerCase();
      const base =
        grid.pool.token0.toLowerCase() === wbnb ? grid.pool.token1 : grid.pool.token0;
      try {
        const quoteWei = await balanceOf(lp.venue.wbnb, agent.walletAddress);
        const baseWei = await balanceOf(base, agent.walletAddress);
        const anchor = positions.find((row) => row.inventoryBaseWei !== null) ?? null;
        // GRID-GAS-RESERVE P2 — the SHIFT pair's gas pot and the figure the
        // worker's gate holds under, through the SAME reader and the SAME
        // constant, so the page and the worker never disagree ("keep the two
        // gates in step", `worker.ts`). `null` when unread or not a shift grid:
        // a dash with a reason, never a zero.
        let nativeWei: bigint | null = null;
        let nextShiftGasWei: bigint | null = null;
        if (grid.shift !== undefined) {
          const nativeOf = lp.readers.walletNativeBalance;
          if (nativeOf !== undefined) {
            try {
              nativeWei = await nativeOf(agent.walletAddress);
            } catch {
              nativeWei = null;
            }
          }
          nextShiftGasWei =
            BigInt(MAX_SUBMISSIONS_PER_GRID_SHIFT)
            * (lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI);
        }
        return {
          buffer: {
            quoteWei,
            baseWei,
            bookBaseWei: anchor?.inventoryBaseWei ?? null,
            bookCostWbnbWei: anchor?.inventoryCostWbnbWei ?? null,
            nativeWei,
            nextShiftGasWei,
          },
        };
      } catch {
        return {};
      }
    }

    function gridOwnerView(input: {
      readonly grid: LpGridSettings;
      readonly positions: readonly LpPositionRecord[];
      readonly sequences: readonly LpSequenceRecord[];
      readonly observations: readonly (LpTriggerObservation | null)[];
      readonly cycles: readonly LpGridCycleRecord[];
      readonly cyclesAvailable: boolean;
      readonly quota: LpQuotaUsage | null;
      /** The agent-wide spacing floor, which is what really bounds the rate. */
      readonly minMinutesBetweenExits: number;
      readonly nowMs: number;
      /**
       * PHASE3.19 D9 / M6 — the LADDER's idle buffer and its VWAP book.
       *
       * Supplied by the ROUTE, which is the only layer that may make a chain
       * read, and OPTIONAL so every non-ladder caller and every fixture is
       * unchanged. The balances are the WALLET's, not the store's, and the view
       * carries the honest sentence that says so.
       */
      readonly buffer?: {
        readonly quoteWei: bigint;
        readonly baseWei: bigint;
        readonly bookBaseWei: bigint | null;
        readonly bookCostWbnbWei: bigint | null;
        readonly nativeWei?: bigint | null;
        readonly nextShiftGasWei?: bigint | null;
      };
    }): Record<string, unknown> {
      const { grid } = input;
      const observedPoolAddresses = new Map<string, string>();
      for (const candidate of input.observations) {
        if (candidate !== null) {
          observedPoolAddresses.set(candidate.poolAddress.toLowerCase(), candidate.poolAddress);
        }
      }
      const observedPoolAddress = observedPoolAddresses.size === 1
        ? [...observedPoolAddresses.values()][0] ?? null
        : null;
      /*
       * PHASE3.17 R2.6 (review H2) — EVERY non-closed row, not `findIndex`-one.
       *
       * Three surfaces here assumed exactly one live level, and under a dual
       * grid each was wrong in its own way: the singular `level` made the second
       * one INVISIBLE; `blockedBySequence` was derived from that one row, so a
       * held flip on the OTHER level — including its disarm of that level's
       * price stop — was reported nowhere; and the PnL read one interleaved
       * `grid_cycles` ledger as one lineage, comparing level A's first flip
       * against level B's latest, which is a number about nothing.
       *
       * `observations` is index-paired with `positions` by the caller, so the
       * index is carried through rather than re-derived.
       */
      const liveEntries = input.positions
        .map((position, index) => ({ position, index }))
        .filter((entry) => entry.position.state !== "closed");
      const first = liveEntries[0] ?? null;
      const live = first?.position ?? null;
      const observation =
        first === null ? null : input.observations[first.index] ?? null;
      const observedTick = observation?.currentTick ?? null;
      const blockingOf = (positionId: string): LpSequenceRecord | null =>
        input.sequences.find(
          (sequence) =>
            sequence.positionId === positionId
            && !isTerminalLpSequence(sequence.state, sequence.recoveryState),
        ) ?? null;
      /*
       * ─── PHASE3.22 R2.4 / P7 (M10) — THE SIBLING'S BLOCKER, FROM THE ARM
       *     GROUP ────────────────────────────────────────────────────────────
       *
       * `blockingOf` is POSITION-scoped and finds NOTHING for the sibling of a
       * row whose shift is in flight — a shift is ONE sequence that moves TWO
       * positions, which no sequence before it did. Reported per row from the
       * row's own lookup alone, a held shift would show the anchor as blocked
       * and the sibling as perfectly free, while in fact BOTH rungs are frozen
       * and BOTH price stops are disarmed.
       *
       * That is TWICE THE 3.15 BLAST RADIUS and it is said explicitly rather
       * than left for an owner to discover: the resolution is derived from
       * `arm_group_id`, so a non-terminal `grid-shift` anywhere in the group is
       * reported on EVERY row of it.
       *
       * MODE-GATED through `gridShiftGroupLock` (mode first), so a LADDER pair
       * — which also carries `arm_group_id` — keeps its per-row lookup
       * byte-identical, and so does every fixed and policy grid.
       */
      const groupBlockingOf = (position: LpPositionRecord): LpSequenceRecord | null => {
        const own = blockingOf(position.positionId);
        if (own !== null) return own;
        if (!gridShiftGroupLock({ grid, armGroupId: position.armGroupId })) return null;
        return (
          input.positions
            .filter((row) => row.armGroupId === position.armGroupId)
            .map((row) => blockingOf(row.positionId))
            .find(
              (sequence): sequence is LpSequenceRecord =>
                sequence !== null && sequence.kind === "grid-shift",
            ) ?? null
        );
      };
      const blocking = live === null ? null : groupBlockingOf(live);
      const blockingNote =
        "While this sequence is non-terminal the position is resumed and never evaluated, so NO trigger fires — the price stop-loss included. If it is stalled, the owner-signed abandon (POST /agents/:id/lp/sequences/:id/abandon) is the door; a grid-flip has no owner-signed UNKNOWN resolver by design, because its principal is out of the position and a retry would risk a second mint.";

      const quoteIsToken0 = grid.wbnbIsToken0;
      const quoteOf = (amount0: bigint, amount1: bigint): bigint | null => {
        if (observedTick === null) return null;
        const sqrt = getSqrtRatioAtTick(observedTick);
        // The off-side leg is valued INTO the quote at the observation's own
        // price; the quote leg is face value. An ESTIMATE, and labelled one.
        return quoteIsToken0
          ? amount0
            + spotSwapOutput({
                amountInAfterFee: amount1,
                sqrtPriceX96: sqrt,
                tokenInIsToken0: false,
              })
          : amount1
            + spotSwapOutput({
                amountInAfterFee: amount0,
                sqrtPriceX96: sqrt,
                tokenInIsToken0: true,
              });
      };

      const cycles = input.cycles;
      const quoteLeg = (cycle: LpGridCycleRecord): bigint =>
        quoteIsToken0 ? cycle.mintedAmount0Wei : cycle.mintedAmount1Wei;
      /*
       * REALISED PnL FROM RECORDED FACTS ONLY, and the honest measure is a
       * QUOTE-LEG DELTA over completed round trips: a grid is only ever back in
       * a comparable state when it returns to the same side, so the figure
       * compares the quote leg minted by the FIRST recorded flip back into a buy
       * range against the LATEST one. It uses no price at all, which is why it
       * can be called realised.
       *
       * PHASE3.17 R2.6 (review H2): PARTITIONED BY `positionId`. `grid_cycles`
       * is ONE interleaved table, so with two levels writing into it an
       * unpartitioned delta compares level A's first flip against level B's
       * latest — a number about nothing, and `markToMarket`/`holdBenchmark`
       * inherit the same defect. Each level is its own ledger and its own
       * lineage; there is deliberately no cross-level total, because summing two
       * quote-leg deltas taken over different round-trip counts would be a
       * fourth number nobody could act on.
       */
      const pnlFor = (rows: readonly LpGridCycleRecord[]): {
        readonly realisedQuoteWei: bigint | null;
        readonly roundTrips: number;
        readonly markToMarket: bigint | null;
        readonly holdBenchmark: bigint | null;
      } => {
        const toBuy = rows.filter((cycle) => cycle.direction === "to-buy");
        const roundTrips = Math.max(0, toBuy.length - 1);
        const firstToBuy = toBuy[0];
        const lastToBuy = toBuy[toBuy.length - 1];
        const firstRow = rows[0] ?? null;
        const latestRow = rows[rows.length - 1] ?? null;
        return {
          realisedQuoteWei:
            roundTrips > 0 && firstToBuy !== undefined && lastToBuy !== undefined
              ? quoteLeg(lastToBuy) - quoteLeg(firstToBuy)
              : null,
          roundTrips,
          markToMarket:
            latestRow === null
              ? null
              : quoteOf(latestRow.mintedAmount0Wei, latestRow.mintedAmount1Wei),
          holdBenchmark:
            firstRow === null
              ? null
              : quoteOf(firstRow.freedAmount0Wei, firstRow.freedAmount1Wei),
        };
      };
      const overall = pnlFor(cycles);
      const roundTrips = overall.roundTrips;
      const realisedQuoteWei = overall.realisedQuoteWei;
      const markToMarket = overall.markToMarket;
      const holdBenchmark = overall.holdBenchmark;

      /*
       * PHASE3.17 R2.6 — ONE entry per non-closed row, each with its own
       * observation, its own blocking sequence and its own partitioned ledger.
       *
       * `level` (singular) stays beside it and keeps reporting the FIRST live
       * row, so a one-level agent's view is byte-identical to 3.15/3.16's; a
       * dual grid's second level is additive rather than a breaking rename.
       */
      const levelViews = liveEntries.map((entry) => {
        const each = entry.position;
        const eachObservation = input.observations[entry.index] ?? null;
        // PHASE3.22 R2.4/P7: GROUP-derived under shift mode, per-row everywhere
        // else. See `groupBlockingOf` for why the sibling needs it.
        const eachBlocking = groupBlockingOf(each);
        const eachCycles = cycles.filter(
          (cycle) => cycle.positionId === each.positionId,
        );
        const eachPnl = pnlFor(eachCycles);
        return {
          positionId: each.positionId,
          tokenId: each.tokenId,
          state: each.state,
          armGroupId: each.armGroupId,
          observedTick: eachObservation?.currentTick ?? null,
          observedAtMs: eachObservation?.evaluatedAtMs ?? null,
          observationAgeMs:
            eachObservation === null ? null : input.nowMs - eachObservation.evaluatedAtMs,
          crossConsecutive: eachObservation?.gridCrossConsecutive ?? 0,
          crossSide: eachObservation?.gridCrossSide ?? null,
          // PHASE3.18 R2.6/R2.8 — the DURABLE identity (which rung this row IS,
          // in policy mode the only authority there is) and the drift
          // hysteresis beside the cross hysteresis. Both are reported
          // unconditionally: a fixed-mode grid shows the columns it carries and
          // a zero drift count, which is the truth about it.
          gridLevel: each.gridLevel,
          gridRole: each.gridRole,
          /**
           * PHASE3.19 R4.3 / N18 — WHICH KEY PARTITIONS THIS VIEW.
           *
           * 3.17's `levels[]` is keyed by `gridLevel`, and under R3.1's
           * single-level ruling a LADDER's two rows both carry `gridLevel: 1` —
           * so a reader grouping by level would collapse them into one bucket
           * and report a two-sided ladder as one level. Under ladder mode the
           * partition key is the ROLE; under fixed/policy it stays the level.
           * The per-row `blockedBySequence` and `pnl` above are already per ROW
           * and therefore already per role, so only the KEY moves.
           */
          // PHASE3.22: a SHIFT pair's two rows also both carry `gridLevel: 1`
          // (two rows, ONE pair), so the partition key is the ROLE for it too —
          // otherwise a reader grouping by level collapses a two-sided shift
          // ladder into a single bucket and reports half of it.
          levelKey:
            gridModeOf(grid) === "ladder" || gridModeOf(grid) === "shift"
              ? (each.gridRole ?? "unassigned")
              : (each.gridLevel ?? 1),
          driftConsecutive: eachObservation?.gridDriftConsecutive ?? 0,
          driftSide: eachObservation?.gridDriftSide ?? null,
          // PER-LEVEL, which is the whole of H2's second finding: a held flip on
          // ONE level no longer hides the OTHER level's disarmed price stop.
          blockedBySequence:
            eachBlocking === null
              ? null
              : {
                  sequenceId: eachBlocking.sequenceId,
                  kind: eachBlocking.kind,
                  state: eachBlocking.state,
                  recoveryState: eachBlocking.recoveryState,
                  note: blockingNote,
                },
          // ─── PHASE3.22 §9 — THE SHIFT PAIR'S PER-SIDE FIELDS ───────────────
          //
          // Present only under shift mode, so every other view is byte-identical.
          //
          // `range` IS NULL AND CANNOT BE OTHERWISE, and that is a property of
          // the data rather than an omission: position rows carry no ticks
          // (3.17 R2.5) and this route takes no per-NFT chain read, so the live
          // range is not merely duplicative to recompute here — it is
          // unavailable. The SIGNED rungs are reported at the top of this view
          // and are the arm's geometry only; a shift's live rungs float from
          // its first motion, so they are deliberately not presented as if they
          // were this row's range. `live-lp status` reads the NFT.
          //
          // `mintedWei` is the quote leg of the LATEST recorded cycle for this
          // row — a derived LOWER BOUND from confirmed receipts, the 3.15
          // honesty note's own posture, and `null` before the first recorded
          // cycle.
          ...(gridModeOf(grid) !== "shift"
            ? {}
            : {
                shiftSide: {
                  role: each.gridRole,
                  tokenId: each.tokenId,
                  range: null,
                  rangeUnavailableBecause:
                    "position rows carry no ticks and this route takes no per-NFT chain read; a shift's rungs float from its first motion, so the signed rungs above are the ARM's geometry and not this row's live range",
                  mintedWei:
                    eachCycles.length === 0
                      ? null
                      : quoteLeg(eachCycles[eachCycles.length - 1] as LpGridCycleRecord)
                          .toString(10),
                },
              }),
          pnl: {
            realisedQuoteWei:
              eachPnl.realisedQuoteWei === null
                ? null
                : eachPnl.realisedQuoteWei.toString(10),
            overRoundTrips: eachPnl.roundTrips,
            recordedCycles: eachCycles.length,
            markToMarketQuoteWei:
              eachPnl.markToMarket === null ? null : eachPnl.markToMarket.toString(10),
            holdBenchmarkQuoteWei:
              eachPnl.holdBenchmark === null ? null : eachPnl.holdBenchmark.toString(10),
          },
        };
      });

      return {
        pool: grid.pool,
        // The signed grid identifies a pool by token0/token1/fee. The concrete
        // address is available only after the worker has observed it; deriving
        // this from observations already loaded keeps the detail page off RPC.
        poolAddress: observedPoolAddress,
        wbnbIsToken0: grid.wbnbIsToken0,
        tickSpacing: grid.tickSpacing,
        buyRange: grid.buyRange,
        sellRange: grid.sellRange,
        // PHASE3.17: present only on a dual grid, so a 3.15/3.16 view is
        // byte-identical.
        ...(grid.buyRange2 === undefined ? {} : { buyRange2: grid.buyRange2 }),
        ...(grid.sellRange2 === undefined ? {} : { sellRange2: grid.sellRange2 }),
        maxFlipsPerDay: grid.maxFlipsPerDay,
        minNetEdgeBps: grid.minNetEdgeBps,
        // PHASE3.18 R2.2/R2.1 — the ladder MODE and its geometry, present only
        // when signed (the same present-only-when-set discipline the wire uses,
        // so a 3.15-3.17 view is byte-identical).
        // PHASE3.19: the actual mode, not a literal — a `"ladder"` grid reported
        // as `"policy"` would be a view telling an owner about a machine that is
        // not driving their position.
        ...(gridModeOf(grid) === "fixed" ? {} : { mode: gridModeOf(grid) }),
        ...(grid.policy === undefined ? {} : { policy: grid.policy }),
        ...(grid.requote === undefined ? {} : { requote: grid.requote }),
        ...(grid.ladder === undefined ? {} : { ladder: grid.ladder }),
        ...(grid.shift === undefined
          ? {}
          : {
              // PHASE3.25 R3.5/R5.5 — no bigint crosses the JSON seam.
              shift: {
                gapTicks: grid.shift.gapTicks,
                widthTicks: grid.shift.widthTicks,
                deployPctBps: grid.shift.deployPctBps,
                driftPctOfGap: grid.shift.driftPctOfGap,
                shiftsPerDay: grid.shift.shiftsPerDay,
                ...(grid.shift.driftGasBudgetWei === undefined
                  ? {}
                  : { driftGasBudgetWei: grid.shift.driftGasBudgetWei.toString(10) }),
                ...(grid.shift.driftPerMotionWei === undefined
                  ? {}
                  : { driftPerMotionWei: grid.shift.driftPerMotionWei.toString(10) }),
              },
            }),
        // ─── PHASE3.22 §9 / R2.4 / R3.2 point 3 / C11 — THE SHIFT PAIR'S OWN
        //     BLOCK ────────────────────────────────────────────────────────
        //
        // Present only under shift mode, so every 3.15-3.20 view is
        // byte-identical. It carries the four things a shift owner cannot get
        // anywhere else, and each is here because a specific finding says the
        // owner must be able to read it off the dashboard:
        //
        //  - `lanes` — PHASE3.25's independent settlement/drift allowances,
        //    plus an all-shift dashboard total that is not an admission cap.
        //  - `twoSided` / `oneSidedSince` / `oneSidedCause` — R4.2.4 requires
        //    the view to say WHICH of three causes produced a one-sided pair.
        //  - `priceStopDisarmed` — R2.4/M10's "twice the 3.15 blast radius",
        //    said explicitly rather than left to inference.
        //  - `note` — R3.2 point 3's true sentence, in the THIRD of the three
        //    places it names (the client transcript and the abandon note are
        //    the other two).
        ...(grid.shift === undefined
          ? {}
          : (() => {
              const shift = grid.shift;
              const liveRoles = liveEntries
                .map((entry) => entry.position.gridRole)
                .filter((role): role is "buy" | "sell" => role !== null);
              const twoSided = liveRoles.includes("buy") && liveRoles.includes("sell");
              // The DORMANT row, if any: a closed member of the same arm group.
              // Its `updatedAt` is when it closed, which is the only durable
              // one-sided clock a shift pair has — there is no
              // `gridMismatchSinceMs` here, by R2.16's design.
              const groupId = live?.armGroupId ?? null;
              // PHASE3.23 R3.5: no new query. The route already loaded every
              // sequence; join its positionId through the CURRENT arm group,
              // then use the terminal updatedAt as the completion clock.
              const pairGeometry = lpShiftPairGeometry(
                input.positions,
                input.sequences,
                groupId,
              );
              const dormant =
                groupId === null
                  ? null
                  : input.positions.find(
                      (row) => row.armGroupId === groupId && row.state === "closed",
                    ) ?? null;
              // R4.2.4's THREE CAUSES, distinguished by the marker the closing
              // path wrote. `shift-depleted` is the funding case; an ownership
              // close records its own reason; an owner's single-rung manual
              // exit records none.
              const cause =
                twoSided || dormant === null
                  ? null
                  : dormant.closeReason === "shift-depleted"
                    ? ("depleted" as const)
                    : dormant.ownershipLostReason !== null
                      ? ("ownership-lost" as const)
                      : ("owner-exited" as const);
              const held =
                blocking !== null && blocking.kind === "grid-shift";
              return {
                shiftState: {
                  lanes: {
                    shiftsPerDay: shift.shiftsPerDay,
                    shiftsUsed: input.quota?.shiftSettleLiveCount ?? null,
                    driftGasBudgetWei: shift.driftGasBudgetWei?.toString(10) ?? null,
                    driftPerMotionWei: shift.driftPerMotionWei?.toString(10) ?? null,
                    driftLimit: gridShiftDriftMotionsPerDay(shift),
                    driftUsed: input.quota?.shiftDriftLiveCount ?? null,
                    shiftsLiveTotal: input.quota?.shiftLiveCount ?? null,
                    note:
                      "Settlement and drift are separate signed allowances but share agent-wide spacing. The drift allowance was priced at signing; it is not a measured gas total.",
                  },
                  pairGeometry,
                  twoSided,
                  ...(dormant === null || twoSided
                    ? {}
                    : {
                        oneSidedSince: dormant.updatedAt,
                        oneSidedForMinutes: Math.max(
                          0,
                          Math.floor((input.nowMs - dormant.updatedAt) / 60_000),
                        ),
                      }),
                  ...(cause === null ? {} : { oneSidedCause: cause }),
                  // R2.4 / M10 — TWICE the 3.15 blast radius, stated. A held
                  // shift freezes BOTH rungs and disarms BOTH price stops,
                  // because the worker RESUMES a position with a non-terminal
                  // sequence and never evaluates it — and the group lock means
                  // the sibling is suppressed too.
                  priceStopDisarmed: held,
                  ...(held
                    ? {
                        priceStopDisarmedNote:
                          "A held grid-shift disarms the price stop on BOTH rungs of this pair, not just the row the sequence names — twice the blast radius of a held grid-flip. The worker resumes a position with a non-terminal sequence and never evaluates it, and the pair's group lock suppresses the sibling's dispatch for the duration.",
                      }
                    : {}),
                  // ─── C11 — THE TWO REVERT PATHS READ DIFFERENTLY ─────────
                  //
                  // A bricked agent and a busy one must not look the same. A
                  // SUBMITTED-and-reverted shift carries a `callsId`, so its
                  // reservation is NOT releasable and it burned one slot in
                  // its persisted lane; a BUILD-TIME rollback (the G-gate, a
                  // funding recompute) submitted nothing and burned none. The
                  // lane count above is the evidence: slots consumed with no
                  // completed motion is the first case.
                  revertPaths: {
                    submittedAndRevertedSettle:
                      "burned ONE settlement slot — the reservation carries a callsId and is not releasable. Visible as shiftsUsed rising with no new tokenIds.",
                    submittedAndRevertedDrift:
                      "burned ONE drift motion — the reservation carries a callsId and is not releasable. Visible as driftUsed rising with no new tokenIds; shiftsUsed does NOT move.",
                    builtAndRolledBack:
                      "burned NOTHING — no submission and the reservation is released. The motion may re-trigger only while its signed lane allowance is nonzero; the cross/drift re-arm delay still applies. Visible as shiftsUsed and driftUsed unchanged.",
                  },
                  // R3.2 point 3 — THE TRUE SENTENCE, third of three places.
                  note:
                    "A shift has NO in-plane resolver by design: its single step both REMOVES and ADDS liquidity, and the resolver's verdict cannot write a tokenId. An UNKNOWN mid-shift therefore freezes BOTH rungs and disarms BOTH price stops until you sign the declared-ambiguity abandon (POST /agents/:id/lp/sequences/:id/abandon), which CLOSES both rows of the pair so you can re-arm and names both prior tokenIds. Every NFT it touched is in your own wallet throughout (EIP-7702: the plane never held them); close by hand on PancakeSwap whichever still hold liquidity, then sign gridArm again.",
                },
              };
            })()),
        // ─── PHASE3.20 D5 / items 26, M3 — IS THE LADDER TWO-SIDED, AND IF NOT
        //     FOR HOW LONG AND WHY ───────────────────────────────────────────
        //
        // (az) ran for three minutes producing rolled-back rows nobody could
        // interpret, and D3's pre-check REMOVES those rows — so these three
        // fields are not a nicety, they are the replacement audit trail (OQ4's
        // declared consequence).
        //
        // `twoSided` is read from the WORKER'S OWN persisted stranding stamps
        // rather than recomputed: position rows carry no ticks (3.17 R2.5), so a
        // recomputation here is not merely duplicative, it is impossible — and
        // reading the evidence the trigger wrote is what makes the dashboard
        // incapable of disagreeing with the gate (the A3 lesson).
        //
        // `oneSidedBlockedBy` comes from the SAME classifier the trigger's hold
        // uses (item 26). DECLARED: this route takes no pool-state read, so it
        // cannot price `minRungWei` against the buffer and passes `fundingOk`
        // ABSENT — a one-sided ladder whose lane and spacing gate are both open
        // therefore reports `"funding"`, which is the terminal state B1 names
        // and the only remaining explanation. A `null` quota (a failed read,
        // reported as null rather than 500ing the dashboard) is treated as both
        // gates OPEN and lands in the same residual arm.
        ...(grid.ladder === undefined
          ? {}
          : (() => {
              const counts = ladderMotionCounts(grid.ladder);
              const stamps = liveEntries
                .map((entry) => input.observations[entry.index]?.gridMismatchSinceMs)
                .filter((value): value is number => value !== undefined);
              const twoSided = stamps.length === 0;
              const oldest = stamps.length === 0 ? null : Math.min(...stamps);
              const inFlight = liveEntries.some(
                (entry) => blockingOf(entry.position.positionId) !== null,
              );
              const laneOpen =
                input.quota === null
                  ? true
                  : (input.quota.settlementLiveCount ?? 0) < counts.settlementsPerDay;
              const spacingOpen =
                input.quota === null || input.quota.latestReservedAtMs === null
                  ? true
                  : input.nowMs - input.quota.latestReservedAtMs
                    >= input.minMinutesBetweenExits * 60_000;
              return {
                twoSided,
                ...(oldest === null
                  ? {}
                  : {
                      oneSidedForMinutes: Math.max(
                        0,
                        Math.floor((input.nowMs - oldest) / 60_000),
                      ),
                    }),
                oneSidedBlockedBy: gridLadderBlockedBy({
                  twoSided,
                  inFlight,
                  laneOpen,
                  spacingOpen,
                }),
                maxStrandedMinutes: ladderStrandedMinutes(
                  grid.ladder,
                  input.minMinutesBetweenExits,
                ).value,
                lanes: {
                  settlementsPerDay: counts.settlementsPerDay,
                  driftMovesPerDay: counts.driftMovesPerDay,
                  settlementUsed: input.quota?.settlementLiveCount ?? null,
                  driftUsed: input.quota?.driftLiveCount ?? null,
                  // PHASE3.20 item 29: the legacy interpretation, stated where
                  // an owner can see it — a 3.19 signature is running with drift
                  // DISABLED until it re-signs, and a silent capability removal
                  // is worse than a refusal.
                  legacyForm: grid.ladder.maxMovesPerDay !== undefined,
                },
              };
            })()),
        // PHASE3.17 R2.6 — EVERY live level, each on its own row with its own
        // observation, its own blocking sequence and its own partitioned ledger.
        // PHASE3.19 R4.3/N18: WHICH key partitions them, stated rather than
        // inferred, because a ladder's two rows share `gridLevel: 1`.
        levelsPartitionedBy:
          gridModeOf(grid) === "ladder" || gridModeOf(grid) === "shift"
            ? ("role" as const)
            : ("level" as const),
        levels: levelViews,
        // PHASE3.19 D9 / M6 — THE IDLE BUFFER, WITH THE HONEST SENTENCE.
        //
        // These are CHAIN READS of the wallet's own balances, taken at the route
        // — they belong to no position row and this store never held them. The
        // plane CANNOT distinguish the ladder's working balance from any other
        // holding of the same two tokens in the same EOA, including dust from
        // unrelated activity and the bounded dust the arm's own pre-commit floor
        // leaves. That is a property of EIP-7702 custody — the EOA IS the vault —
        // and not a measurement error, and §4's "no new trust" sentence is true
        // about AUTHORITY and misleading about ACCOUNTING without it.
        ...(input.buffer === undefined
          ? {}
          : {
              buffer: {
                quoteWei: input.buffer.quoteWei.toString(10),
                baseWei: input.buffer.baseWei.toString(10),
                bookBaseWei:
                  input.buffer.bookBaseWei === null
                    ? null
                    : input.buffer.bookBaseWei.toString(10),
                bookCostWbnbWei:
                  input.buffer.bookCostWbnbWei === null
                    ? null
                    : input.buffer.bookCostWbnbWei.toString(10),
                // GRID-GAS-RESERVE P2 — present-only-when-read, like every
                // other buffer figure: a ladder pair never carries them.
                ...(input.buffer.nativeWei === undefined || input.buffer.nativeWei === null
                  ? {}
                  : { nativeWei: input.buffer.nativeWei.toString(10) }),
                ...(input.buffer.nextShiftGasWei === undefined || input.buffer.nextShiftGasWei === null
                  ? {}
                  : { nextShiftGasWei: input.buffer.nextShiftGasWei.toString(10) }),
                note:
                  "WBNB and BASE the WALLET holds, read from chain. The plane cannot tell the ladder's working balance apart from any other holding of the same tokens in the same EOA — that is EIP-7702 custody, not a measurement error. The inventory book is the ladder's own acquisition record and advances only from confirmed receipts.",
              },
            }),
        level:
          live === null
            ? null
            : {
                positionId: live.positionId,
                tokenId: live.tokenId,
                state: live.state,
                // The tick as of the LAST OBSERVATION, never "now".
                observedTick,
                observedAtMs: observation?.evaluatedAtMs ?? null,
                observationAgeMs:
                  observation === null ? null : input.nowMs - observation.evaluatedAtMs,
                crossConsecutive: observation?.gridCrossConsecutive ?? 0,
                crossSide: observation?.gridCrossSide ?? null,
              },
        // R2.4/H4, said plainly rather than claimed away: while a flip is
        // non-terminal the position is RESUMED and never evaluated, so no
        // trigger fires — including the price stop-loss, which is a grid's only
        // protection. `lpProtectionStatus` already reports `armed: false` with
        // `blockedBySequence`; this names the remedy.
        blockedBySequence:
          blocking === null
            ? null
            : {
                sequenceId: blocking.sequenceId,
                kind: blocking.kind,
                state: blocking.state,
                recoveryState: blocking.recoveryState,
                note: blockingNote,
              },
        latency: {
          workerIntervalMs: lp.workerIntervalMs,
          confirmationMs: 2 * lp.workerIntervalMs,
          minMinutesBetweenExits: input.minMinutesBetweenExits,
          note:
            "Fill-to-mint latency is at least 2 worker intervals for the two finalized confirmations, PLUS whatever minMinutesBetweenExits still owes since the last reservation. The spacing gate is agent-wide and unfiltered, so it — not maxFlipsPerDay — is what floors a grid's cycle rate.",
        },
        quota:
          input.quota === null
            ? null
            : {
                limit: grid.maxFlipsPerDay,
                used: input.quota.gridFlipLiveCount ?? 0,
                remaining: Math.max(
                  0,
                  grid.maxFlipsPerDay - (input.quota.gridFlipLiveCount ?? 0),
                ),
              },
        // PHASE3.18 C7 — the REQUOTE lane, reported separately because it is
        // refused separately. Present only under policy mode, so a 3.15-3.17
        // view is byte-identical.
        ...(grid.requote === undefined
          ? {}
          : {
              requoteQuota:
                input.quota === null
                  ? null
                  : {
                      limit: grid.requote.maxRequotesPerDay,
                      used: input.quota.requoteLiveCount ?? 0,
                      remaining: Math.max(
                        0,
                        grid.requote.maxRequotesPerDay
                          - (input.quota.requoteLiveCount ?? 0),
                      ),
                      note:
                        "Its OWN lane: re-centres never consume the flip quota, so a burst of drift can never starve the settlement of a fill that already happened.",
                    },
            }),
        cycles: {
          available: input.cyclesAvailable,
          recorded: cycles.length,
          roundTrips,
          rows: cycles.map((cycle) => ({
            sequenceId: cycle.sequenceId,
            positionId: cycle.positionId,
            direction: cycle.direction,
            from: { tickLower: cycle.fromTickLower, tickUpper: cycle.fromTickUpper },
            to: { tickLower: cycle.toTickLower, tickUpper: cycle.toTickUpper },
            freed0Wei: cycle.freedAmount0Wei.toString(10),
            freed1Wei: cycle.freedAmount1Wei.toString(10),
            minted0Wei: cycle.mintedAmount0Wei.toString(10),
            minted1Wei: cycle.mintedAmount1Wei.toString(10),
            residueWei: cycle.residueWei.toString(10),
            residueBps: cycle.residueBps.toString(10),
            fromTokenId: cycle.fromTokenId,
            toTokenId: cycle.toTokenId,
            completedAtMs: cycle.completedAtMs,
          })),
          note:
            "Derived telemetry: a row can be lost if the post-confirm write fails; counts are a lower bound.",
        },
        pnl: {
          realisedQuoteWei: realisedQuoteWei === null ? null : realisedQuoteWei.toString(10),
          overRoundTrips: roundTrips,
          note:
            // PHASE3.17 R2.6: with two levels writing into ONE `grid_cycles`
            // table, this aggregate spans both lineages and is NOT a per-level
            // result. `levels[].pnl` is the partitioned figure and is the one to
            // read on a dual grid; this stays for continuity of the one-level
            // view and says which it is.
            // PHASE3.18 M5 — the POLICY-MODE gap, DECLARED rather than
            // silently absorbed: a requoted level's placement moved, so the
            // "first vs latest flip into a buy range" delta compares two
            // different geometries and is SYSTEMATICALLY OPTIMISTIC (each
            // re-centre also paid two submissions this figure does not
            // subtract). Naming it is the honest fix available offline; a
            // placement-aware ledger is a later phase.
            `Over RECORDED cycles only, and it is a quote-leg delta between the first and latest recorded flip back into a buy range — no price is used, so nothing here is a mark. It EXCLUDES relay billing, which this plane still cannot measure (LP_RELAY_FEE_PER_SUBMIT_WEI is an unmeasured pad), and it excludes any residue left in the wallet. With MORE THAN ONE live level this figure spans both lineages and is not a per-level result: read levels[].pnl, which is partitioned by positionId.${
              gridModeOf(grid) === "policy"
                ? " POLICY MODE: this is over recorded cycles AT REQUOTED PLACEMENTS — the rungs moved between them, and each re-centre spent two submissions this figure does not subtract, so it reads systematically optimistic."
                : ""
            }`,
        },
        estimates: {
          markToMarketQuoteWei: markToMarket === null ? null : markToMarket.toString(10),
          holdBenchmarkQuoteWei: holdBenchmark === null ? null : holdBenchmark.toString(10),
          asOfTick: observedTick,
          asOfMs: observation?.evaluatedAtMs ?? null,
          note:
            "ESTIMATE. Both figures value RECORDED leg amounts at the LAST OBSERVATION's tick — not a fresh read; this route makes no chain call. The hold benchmark is what the level's original inventory would be worth at that same tick if it had never flipped. With more than one live level these span both lineages; levels[].pnl carries the partitioned figures.",
        },
        // PHASE3.17 R2.6 (review H2): "no live level" used to be BINARY, and
        // with two levels a grid can also be running on ONE — which is legal
        // (closing one level leaves a one-level grid running) and must not read
        // as either healthy or dead. The sentence now names the DARK side.
        ...(levelViews.length === 0
          ? {
              // PHASE3.16 M3: `gridOwnerView` is the owner's ONLY in-product
              // account of a grid with no level, so this is the sentence that
              // decides what they do next. The arm is the entry path; the
              // hand-mint route is still true and is named as the alternative.
              restart:
                // PHASE3.18 R2.5: the import half holds for FIXED mode only.
                `No live level. Sign gridArm (POST /agents/:id/lp/grid/arm) with a native budgetWei and the agent places the next level itself, single-sided into the signed buyRange.${
                  gridModeOf(grid) === "policy"
                    ? " This grid is in policy mode: its rungs float, import admits only at a signed rung verbatim, so gridArm is the only restart. Re-sign coherent rungs at the current tick first if the ladder has drifted."
                    : " Alternatively mint a single-sided range order by hand on PancakeSwap at exactly one of the signed ranges and POST /agents/:id/lp/import it with basisWei 0 — after an abandon the inventory is already sitting in your own EOA as the asset the next level wants, so no conversion is needed."
                }`,
            }
          : gridIsDual(grid) && levelViews.length === 1
            ? {
                restart:
                  `This grid was signed with FOUR rungs (two levels) and only ONE level is live: ${gridDarkSideNote(grid, levelViews)} It keeps ping-ponging on its own pair and nothing is wrong, but the grid is quoting one side less than it was signed for. gridArm cannot top it up — an arm places a grid's levels and refuses while any position is non-closed — ${
                    gridModeOf(grid) === "policy"
                      ? " In policy mode the hand-mint door is CLOSED (import admits only at a signed rung verbatim, and these rungs float), so the only route is to exit the live level and arm the whole grid again."
                      : " so the doors are to hand-mint the missing rung on PancakeSwap and POST /agents/:id/lp/import it with basisWei 0, or to exit the live level and arm the whole grid again."
                  }`,
              }
            : {}),
      };
    }

    /**
     * WHICH SIDE OF A DUAL GRID IS DARK (PHASE3.17 R2.6), stated within what
     * this view can actually prove.
     *
     * IT MAKES NO CHAIN READ, and that constraint (L6) is what bounds the
     * answer: a position ROW carries no ticks — the range is read from the NFT
     * every worker cycle and `gridLiveRole` matches on those — and no persisted
     * observation carries them either. So this view can prove that one level is
     * dark (a non-closed row count below the signed level count) and can name
     * every rung and the surviving level's own NFT, but it cannot name the dark
     * PAIR without asking the chain, which it must not do.
     *
     * The alternative was to resolve the level from `grid_cycles`' recorded
     * ticks — refused: that table is DERIVED TELEMETRY and documented as a lower
     * bound, so an armed-but-never-flipped level has no row there at all and the
     * answer would be confidently wrong exactly when the grid is youngest.
     */
    function gridDarkSideNote(
      grid: LpGridSettings,
      levelViews: readonly {
        readonly positionId: string;
        readonly tokenId: string | null;
      }[],
    ): string {
      const survivor = levelViews[0];
      return (
        `the signed rungs are ${gridRangeList(grid)}, and the live level is `
        + `${survivor === undefined ? "unidentified" : `position ${survivor.positionId} (NFT ${survivor.tokenId ?? "not yet recorded"})`}. `
        + `Which PAIR is dark is not named here because this view makes no chain read and a position row carries no ticks — `
        + `read the live NFT's range on chain, or run live-grid status, to see which pair survived.`
      );
    }

    /* ---- GET /agents/:id/lp ------------------------------------------------ */

    app.get("/agents/:id/lp", async (c) => {
      const id = c.req.param("id");
      const auth = await authorizeAccountRead(c, id);
      if (auth.kind !== "ok") return auth.response;
      const agent = await deps.agentStore.getAgent(auth.owner.ownerAddress, id);
      // Unknown agent and someone else's agent are the SAME response.
      if (agent === null) return fail(c, 404, "not_found");
      const [positions, stored] = await Promise.all([
        lp.store.listPositions(agent.ownerAddress, agent.id),
        lp.settingsStore.get(agent.ownerAddress, agent.id),
      ]);

      // PHASE3.2 Decision 4: the two checks the WORKER makes before it will
      // automate a position, made visible. An agent whose stored digest does
      // not recompute, or whose params no longer parse, is skipped every cycle
      // — silently, until now. Neither is an error here: the answer is
      // `armed: false` carrying the worker's own message.
      const digestVerified =
        stored === null
        || paramsHash("lpSettings", stored.params).toLowerCase()
          === stored.digest.toLowerCase();
      const parsedSettings =
        stored === null ? null : parseLpSettingsParams(stored.params);
      const settingsReadable = parsedSettings === null || parsedSettings.ok;
      const settings =
        stored === null
          ? DEFAULT_LP_SETTINGS
          : parsedSettings !== null && parsedSettings.ok
            ? parsedSettings.value
            : null;

      // PHASE3.5 decision 4. ONE bounded aggregate over the existing
      // (agent_id, reserved_at) index — the H6(a) cost lesson applies to this
      // route, so no fan-out. A read failure reports `null` rather than 500ing
      // an owner's dashboard, exactly as the observation reads below do.
      let quotaUsage: LpQuotaUsage | null = null;
      try {
        quotaUsage = await lp.store.quotaUsage(agent.ownerAddress, agent.id);
      } catch {
        quotaUsage = null;
      }
      // AUDIT A3. The first version of this comment claimed the worker falls
      // back to defaults on an unverified digest. It does not — it SKIPS the
      // position entirely, running no rotate, no harvest and no stop-loss
      // evaluation, because automation must never run under settings nobody
      // provably signed. So a quota block computed from that row would describe
      // a budget nothing is consuming, in the one phase whose stated purpose is
      // that this surface cannot disagree with the refusal.
      //
      // Two consequences, both here:
      //
      //   - the limits come from the digest-VERIFIED row or from the defaults,
      //     never from an unverified one;
      //   - the block says plainly when nothing is running against it. The
      //     actual fault is already reported per position as backtick-armed-false-backtick
      //     with the digest reason; this stops the quota numbers from implying
      //     otherwise.
      const settingsTrusted = digestVerified && settings !== null;
      const effectiveSettings = settingsTrusted ? settings : DEFAULT_LP_SETTINGS;

      const observations = await Promise.all(
        positions.map(async (position) => {
          try {
            return await lp.observations.get(
              agent.ownerAddress,
              agent.id,
              position.positionId,
            );
          } catch {
            // Derived telemetry: a read failure reports "no observation held",
            // never a 500 on an owner's dashboard.
            return null;
          }
        }),
      );
      const observedAtMs = nowMs();
      // Capture B first, then coverage inputs; never pair a newer collectible
      // observation with an earlier list that could omit an intervening step.
      const sequences = await lp.store.listSequences(agent.ownerAddress, agent.id);

      // PHASE3.3 Rev2 item 18. `driveSequence` refuses a protect against a
      // non-terminal sequence of another kind, so this is the input without
      // which the one surface built to answer "is protection armed" reports
      // `armed: true` about exactly the position FINDINGS (al) is about.
      // Derived from the sequence list already fetched — no extra store call,
      // and the same "one non-terminal sequence per position" the store
      // enforces.
      //
      // PHASE3.3-AUDIT A3: the exemption for a `protect` sequence is keyed on
      // whether that protect can still ADVANCE, not on its kind string. A
      // protect whose current step row is `UNKNOWN` is held every cycle for
      // ever — with no `callsId`, not even `reconcile` can settle it — so it
      // must disarm rather than report the stop-loss as real. That answer needs
      // one journal read, and only for a blocking `protect`: every other kind
      // already disarms whatever its step row says.
      // PHASE3.1-FIXREVIEW2 G4. One journal read per recorded step, so
      // `lpSequenceView` can say which entries SUBMITTED and which are the
      // provably-unsubmitted bookkeeping rows F2's retry budget persists.
      // Without it a single never-submitted exit conversion renders as five
      // identical `sweep-token` steps with no state — the (ae)/(al) shape
      // running the other way, making the system look like it did MORE than it
      // did (FINDINGS (an) is the measured case of a buried state change being
      // misread).
      //
      // Cost, stated rather than hidden: `listSequences` has no LIMIT and no
      // paging in either backend, so this is O(total recorded steps EVER
      // recorded for the agent) reads on a dashboard route. Each failure
      // degrades to `unreadable: true` rather than a 500, and the real bound —
      // paging `listSequences` — belongs to whoever gives this route a page
      // size.
      //
      // PHASE3.1-FIXREVIEW3 H6(a): the COUNT is deferred, the CONCURRENCY is
      // not. Issued as one `Promise.all` over every step, this route opened an
      // unbounded number of simultaneous queries into the same Postgres pool
      // the money path (`/execute`, `/trade`, `/lp/*`) draws from — an
      // owner-authenticated dashboard GET able to starve a stop-loss. Capping
      // the fan-out needs no route-shape change, which is why it is here and
      // paging is not. The derivation itself is `lpStepOutcome`'s, in ONE place
      // (H5: the route's private copy read `callsHash`, which is written before
      // every pre-submit refusal, and so claimed submissions that never
      // happened).
      // PHASE3.15: the cycle ledger. Derived telemetry on an owner's dashboard,
      // so a read failure reports an EMPTY history rather than 500ing — the
      // same posture the observation reads take above.
      let gridCycles: LpGridCycleRecord[] = [];
      let gridCyclesAvailable = false;
      if (effectiveSettings.grid !== null && lp.gridCycles !== undefined) {
        try {
          gridCycles = await lp.gridCycles.list(agent.ownerAddress, agent.id);
          gridCyclesAvailable = true;
        } catch {
          gridCycles = [];
        }
      }

      const stepKeys = sequences.flatMap((sequence) =>
        sequence.steps.map((step) => step.journalIdempotencyKey),
      );
      const stepOutcomes = new Map<string, LpSequenceStepOutcome>();
      const stepNativeSpends = new Map<string, bigint>();
      let nextStepKey = 0;
      const readStepOutcomes = async (): Promise<void> => {
        for (;;) {
          const key = stepKeys[nextStepKey];
          nextStepKey += 1;
          if (key === undefined) return;
          try {
            const journalRow = await deps.journal.get(key);
            stepOutcomes.set(key, lpStepOutcome(journalRow));
            if (journalRow?.state === "COMMITTED") stepNativeSpends.set(key, journalRow.nativeSpendWei);
          } catch {
            stepOutcomes.set(key, LP_STEP_OUTCOME_UNREADABLE);
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(LP_STEP_READ_CONCURRENCY, stepKeys.length) },
          () => readStepOutcomes(),
        ),
      );

      let feeLedger: LpFeeEvent[] | null = null;
      let feeStoreErrorClass = "Unavailable";
      try { feeLedger = lp.readers.receipts.feeEvents === undefined ? null : await lp.feeEvents?.snapshot(agent.ownerAddress, agent.id) ?? null; } catch (error) { feeStoreErrorClass = error instanceof Error && ["Error","TypeError","RangeError","AbortError"].includes(error.name) ? error.name : "UnknownError"; }
      const feeView = (position: LpPositionRecord, index: number) => {
        const boundary = observations[index]?.fees?.blockNumber;
        const expected: FeeCandidate[] = [];
        let unreadable = false;
        for (const sequence of sequences) {
          if (!sequenceAffectsPosition(sequence, position, positions.find(p => p.positionId === sequence.positionId))) continue;
          for (const step of sequence.steps) {
            if (!isFeeCollectionStep(sequence.kind, step.kind)) continue;
            const outcome = stepOutcomes.get(step.journalIdempotencyKey);
            if (!outcome || outcome.unreadable || outcome.state === "COMMITTED" && !outcome.txHash) { unreadable = true; continue; }
            if (outcome.state === "COMMITTED" && outcome.txHash) expected.push({ sequenceId: sequence.sequenceId, journalIdempotencyKey: step.journalIdempotencyKey, txHash: outcome.txHash as Hex });
          }
        }
        const unavailable = feeLedger === null || unreadable || boundary === undefined;
        const sum = feeLedger === null || boundary === undefined ? null : sumFeeRows(feeLedger, position.positionId, boundary);
        return {
          feeEvents: (feeLedger ?? []).filter(r => r.positionId === position.positionId).sort((a,b) => b.recordedAtMs - a.recordedAtMs).slice(0,200).map(r => ({ positionId:r.positionId, lineageId:r.lineageId, sequenceId:r.sequenceId,
            journalIdempotencyKey:r.journalIdempotencyKey, stepIndex:r.stepIndex, kind:r.kind, tokenId:r.tokenId, txHash:r.txHash,
            status:r.status, reason:r.reason, recordedAtMs:r.recordedAtMs,
            blockNumber: r.blockNumber.toString(), collected0Wei:r.collected0Wei.toString(), collected1Wei:r.collected1Wei.toString(),
            decreased0Wei:r.decreased0Wei.toString(), decreased1Wei:r.decreased1Wei.toString(), realised0Wei:r.realised0Wei.toString(), realised1Wei:r.realised1Wei.toString() })),
          feeSum: sum === null ? null : { ...sum, realised0Wei:sum.realised0Wei.toString(),realised1Wei:sum.realised1Wei.toString(),throughBlock:sum.throughBlock.toString() },
          feeCoverage: unavailable ? { status: "unavailable", missing: 0, gaps: 0, reason: lp.readers.receipts.feeEvents === undefined ? "fee receipt reader unwired" : feeLedger === null ? `fee store unavailable (${feeStoreErrorClass})` : unreadable ? "journal evidence unavailable" : "collectible boundary unavailable" }
            : position.basisSource === "imported" ? { status: "incomplete", missing: 0, gaps: 0, reason: "import fee history unavailable" } : feeCoverage(feeLedger!, expected, boundary!),
        };
      };

      const blockingSequences = new Map<string, LpBlockingSequence>();
      for (const sequence of sequences) {
        if (isTerminalLpSequence(sequence.state, sequence.recoveryState)) continue;
        let currentStepUnknown = false;
        if (sequence.kind === "protect") {
          const current = sequence.steps[sequence.steps.length - 1];
          if (current !== undefined) {
            try {
              const stepRow = await deps.journal.get(current.journalIdempotencyKey);
              currentStepUnknown = stepRow?.state === "UNKNOWN";
            } catch {
              // Derived telemetry on an owner's dashboard: a read failure
              // reports the pre-A3 reading, never a 500.
            }
          }
        }
        blockingSequences.set(sequence.positionId, {
          sequenceId: sequence.sequenceId,
          kind: sequence.kind,
          state: sequence.state,
          currentStepUnknown,
        });
      }

      const latestArmedEntry = positions
        .filter((position) => position.armMeta !== null)
        .sort((a, b) => b.createdAt - a.createdAt || b.positionId.localeCompare(a.positionId))[0] ?? null;
      const latestArmedObservation =
        latestArmedEntry === null
          ? null
          : observations[
            positions.findIndex((position) => position.positionId === latestArmedEntry.positionId)
          ] ?? null;
      const lpSettingsProjection = !settingsTrusted
        ? null
        : {
            autoRotate: effectiveSettings.autoRotate,
            rotateMode: effectiveSettings.rotateMode,
            rotateMinHoldMinutes: effectiveSettings.rotateMinHoldMinutes,
            autoHarvest: effectiveSettings.autoHarvest,
            harvestMinFeesWei: effectiveSettings.harvestMinFeesWei.toString(10),
            takeProfitPct: effectiveSettings.takeProfitPct,
            stopLossPct: effectiveSettings.stopLossPct,
            brain:
              effectiveSettings.brain === undefined
                ? null
                : {
                    primaryModel: effectiveSettings.brain.primaryModel,
                    fallbackModel: effectiveSettings.brain.fallbackModel,
                  },
          };
      const lpSettingsReason = !settingsTrusted
        ? "settings digest unverified; worker skips this agent"
        : effectiveSettings.brainEnabled && effectiveSettings.brain === undefined
          ? "brainEnabled without a model; deterministic ranges"
          : null;
      let liveRange: { readonly tickLower: number; readonly tickUpper: number; readonly asOfMs: number } | null = null;
      let liveRangeReason: string | null = null;
      if (latestArmedEntry !== null) {
        if (latestArmedEntry.state === "closed") {
          liveRangeReason = "position is closed";
        } else if (
          latestArmedObservation?.tickLower === undefined
          || latestArmedObservation.tickUpper === undefined
        ) {
          liveRangeReason = "no observation with ticks yet";
        } else if (
          latestArmedEntry.tokenId === null
          || latestArmedObservation.valuation === undefined
          || latestArmedObservation.valuation.tokenId !== latestArmedEntry.tokenId
        ) {
          liveRangeReason = "observation is for a prior position version";
        } else {
          liveRange = {
            tickLower: latestArmedObservation.tickLower,
            tickUpper: latestArmedObservation.tickUpper,
            asOfMs: latestArmedObservation.evaluatedAtMs,
          };
        }
      }
      const lpOwnerBlock =
        agent.sessionFacts?.hireSizing?.name !== "lp-v1"
          ? undefined
          : latestArmedEntry === null || latestArmedEntry.armMeta === null
          ? {
              workerIntervalMs: lp.workerIntervalMs,
              model: null,
              pool: null,
              range: null,
              rangeReason: "not armed yet",
              openingRange: null,
              settingsTrusted,
              settingsReason: lpSettingsReason,
              settings: lpSettingsProjection,
              budgetWei: agent.sessionFacts.hireSizing.openNativeBudgetWei,
              restart: "Sign lpArm again to open a new position.",
              reason: "not armed yet",
            }
          : {
              workerIntervalMs: lp.workerIntervalMs,
              model: latestArmedEntry.armMeta.model,
              pool: {
                token0: latestArmedEntry.token0,
                token1: latestArmedEntry.token1,
                fee: latestArmedEntry.fee,
                poolAddress: pancakeV3PoolAddress(
                  latestArmedEntry.token0,
                  latestArmedEntry.token1,
                  latestArmedEntry.fee,
                ),
                wbnbIsToken0: latestArmedEntry.token0.toLowerCase() === lp.venue.wbnb.toLowerCase(),
                tickSpacing: FEE_TO_TICK_SPACING.get(latestArmedEntry.fee) ?? null,
              },
              range: liveRange,
              rangeReason: liveRangeReason,
              openingRange: latestArmedEntry.armMeta.range,
              settingsTrusted,
              settingsReason: lpSettingsReason,
              settings: lpSettingsProjection,
              budgetWei: latestArmedEntry.armMeta.budgetWei,
              selection: latestArmedEntry.armMeta.selection,
              selectPool: latestArmedEntry.armMeta.selectPool,
              restart:
                latestArmedEntry.state === "closed"
                  ? "Sign lpArm again to open a new position."
                  : null,
            };

      return c.json({
        data: {
          positions: positions.map((position, index) => ({
            ...lpPositionView(position),
              ...feeView(position, index),
            observation: lpObservationView(observations[index] ?? null),
            protection: lpProtectionView(
              lpProtectionStatus({
                settings: digestVerified ? settings : null,
                settingsReadable,
                digestVerified,
                basisWei: position.basisWei,
                hasTokenId: position.tokenId !== null,
                // PHASE3.4 Rev2 M6, and note where it comes FROM: the position
                // row. This route makes ZERO chain reads and must not start —
                // the whole failure PHASE3.3-AUDIT A3 named is a dashboard
                // answering from stores while the worker knows better, and the
                // fix is to make the worker WRITE what it knows, not to make
                // the dashboard read the chain.
                pool: { token0: position.token0, token1: position.token1, fee: position.fee },
                ownershipMismatchCount: position.ownershipMismatchCount,
                ownershipLostReason: position.ownershipLostReason,
                observation: observations[index] ?? null,
                nowMs: observedAtMs,
                intervalMs: lp.workerIntervalMs,
                blockingSequence: blockingSequences.get(position.positionId) ?? null,
                ...(lp.maxObservationAgeMs === undefined
                  ? {}
                  : { maxObservationAgeMs: lp.maxObservationAgeMs }),
              }),
            ),
          })),
          sequences: sequences.map((sequence) => lpSequenceView(sequence, stepOutcomes)),
          // PHASE3.5 decision 4: ONE bounded aggregate over the existing
          // (agent_id, reserved_at) index — not a fan-out. A read failure
          // reports `null` rather than 500ing an owner's dashboard, the same
          // posture the observation reads take above.
          quota: quotaUsage === null
            ? null
            : lpQuotaView({
                usage: quotaUsage,
                maxExitSequencesPerDay: effectiveSettings.maxExitSequencesPerDay,
                minMinutesBetweenExits: effectiveSettings.minMinutesBetweenExits,
                automationRunning: settingsTrusted,
              }),
          // PHASE3.6 Rev2 M9: the configured triggers at AGENT level with a
          // matched-position count. ZERO MATCHES MUST BE VISIBLE — a trigger
          // for a pool this agent holds nothing in is otherwise reported
          // NOWHERE, which is the (ae) shape. Costs no store read: the
          // positions are already in hand.
          priceTriggers: [
            ["stopLoss", effectiveSettings.priceStopLoss],
            ["takeProfit", effectiveSettings.priceTakeProfit],
          ]
            .filter(([, trigger]) => trigger !== null)
            .map(([label, trigger]) => ({
              label,
              token0: (trigger as LpPriceTrigger).token0,
              token1: (trigger as LpPriceTrigger).token1,
              fee: (trigger as LpPriceTrigger).fee,
              tick: (trigger as LpPriceTrigger).tick,
              when: (trigger as LpPriceTrigger).when,
              matchedPositions: positions.filter(
                (position) =>
                  position.state !== "closed"
                  && priceTriggerMatchesPool(trigger as LpPriceTrigger, position),
              ).length,
            })),
          // PHASE3.15: present ONLY for a grid agent, so the view is inert for
          // every other one. Built from the digest-VERIFIED settings — an
          // unverified row is not automating anything, so a grid block read out
          // of it would describe a strategy nothing is running.
          ...(effectiveSettings.grid === null
            ? {}
            : {
                grid: { ...gridOwnerView({
                  grid: effectiveSettings.grid,
                  positions,
                  sequences,
                  observations,
                  cycles: gridCycles,
                  cyclesAvailable: gridCyclesAvailable,
                  quota: quotaUsage,
                  minMinutesBetweenExits: effectiveSettings.minMinutesBetweenExits,
                  nowMs: observedAtMs,
                  // PHASE3.19 D9/M6 — the LADDER's idle buffer and its book, read
                  // HERE because this is the layer allowed a chain call. Gated on
                  // ladder mode so nothing else pays for it; a failed read simply
                  // omits the block rather than reporting a zero balance, which
                  // would be a claim.
                  ...(await ladderBufferView(agent, effectiveSettings.grid, positions)),
                }), benchmark: (() => {
                  const grid = effectiveSettings.grid!;
                  const selected = selectGridArmBenchmark({
                    owner: agent.ownerAddress, agentId: agent.id, wallet: agent.walletAddress,
                    pool: pancakeV3PoolAddress(grid.pool.token0, grid.pool.token1, grid.pool.fee),
                    token0: grid.pool.token0, token1: grid.pool.token1, fee: grid.pool.fee, wbnb: lp.venue.wbnb,
                    capitalWei: agent.sessionFacts?.hireSizing?.openNativeBudgetWei ?? null,
                    positions, sequences, outcomes: stepOutcomes, nativeSpends: stepNativeSpends,
                  });
                  return "status" in selected ? selected : gridBenchmarkCache.getOrStart(selected, lp.readers.gridArmBenchmark);
                })() },
              }),
          ...(lpOwnerBlock === undefined ? {} : { lp: lpOwnerBlock }),
          settingsDigest: stored?.digest ?? defaultSettingsDigest,
        },
        meta: { positions: positions.length, sequences: sequences.length },
      });
    });
  }

  /**
   * The Venus guard surface (PHASE4-SPEC D10).
   *
   * TWO routes, BOTH owner-signed, and that is the whole surface. Phase 4 adds
   * ZERO routes reachable with `x-exec-token` alone: the four money actions are
   * driven by the WORKER — a daemon holding the standing on-chain session —
   * exactly as `/trade` is authorized by the standing session rather than by a
   * per-action owner signature. The shared-exec-token public-launch blocker is
   * neither widened nor fixed by this phase.
   *
   * Registered only when the deps are wired, so a deployment with
   * `VENUS_ENABLED` unset or `"false"` answers the same 404 an unknown path
   * gets — the `EXECUTE_RAW_ENABLED` posture: routes that do not advertise that
   * they exist and are switched off.
   */
  function registerVenusRoutes(venus: VenusServerDeps): void {
    /* ---- POST /agents/:id/venus/settings --------------------------------- */

    app.post("/agents/:id/venus/settings", (c) =>
      ownerMutation(
        c,
        c.req.param("id"),
        "venusSettings",
        "venusSettings",
        async ({ agent, params }) => {
          const parsed = parseVenusSettingsParams(params);
          if (!parsed.ok) throw new BadRequestError(parsed.message);
          const settings = parsed.value;

          // REVISION 4 (FINDINGS (at)): the native market is a ONE-WAY DOOR
          // for the EIP-7702 wallets this product runs on — vBNB pays out via
          // a 2300-gas `.transfer()` that reverts against delegation code, so
          // supplying it mints a position the owner cannot redeem normally.
          // Refused HERE, at the layer that admits markets, quoting the typed
          // condition (`native-collateral-trapped`, R4.6b: one name, both
          // roles). `debtMarkets` may still name vBNB: native REPAY sends
          // value INTO the contract and is measured safe including the
          // overpay case (V8 — CEther reverts loudly on value > debt for
          // every caller; no refund path exists).
          const nativeCollateral = settings.collateralMarkets.filter(
            (vToken) => vToken.toLowerCase() === venus.venue.vBnb.toLowerCase(),
          );
          if (nativeCollateral.length > 0) {
            // The remedy leads, because `ownerMutation` sanitizes stored error
            // prose to ~300 chars and a remedy that falls past the cap is a
            // remedy nobody receives (the PHASE3.3-A7 lesson, re-learned here
            // when this message's first draft truncated the vWBNB address off
            // the end).
            throw new BadRequestError(
              "`native-collateral-trapped`: use vWBNB " +
                "0x6bCa74586218db34cDB402295796b79663d816e9 (identical CORE-pool " +
                "factors) instead of vBNB in collateralMarkets. vBNB pays out via a " +
                "2300-gas `.transfer()` an EIP-7702 wallet cannot receive, so supplying " +
                "it mints a one-way position (FINDINGS (at)). vBNB stays valid in " +
                "debtMarkets: native repay is unaffected.",
            );
          }

          // THE MARKET-IN-GRANT CROSS-CHECK IS AN EARLY WARNING, and its
          // refusal text says so (R2.15/R20). It reads the PERSISTED
          // `sessionFacts.spec`, which goes stale the moment the owner widens
          // the session on chain — the identical relationship
          // `checkNativeCapSizing` has to `nativeReserveFloor`. The GUARANTEE
          // is `preflightExecute` at action time, because the chain is the
          // authority NOW (Phase 2.4); a market that passes here and fails
          // there is the typed refusal `market-not-in-grant`, not a crash.
          //
          // It reads the plane's OWN state, never the data plane: no outbound
          // call belongs inside `ownerMutation`'s journaled act, and a
          // data-plane outage must not be able to block a settings write.
          const spec = agent.sessionFacts?.spec ?? null;
          if (spec === null) {
            throw new BadRequestError(
              "This agent has no granted session, so no market it could name is payable.",
            );
          }
          const named = [...settings.debtMarkets, ...settings.collateralMarkets];
          const ungranted = named.filter(
            (vToken) => !grantsVenusMarket(spec, vToken),
          );
          if (ungranted.length > 0) {
            throw new BadRequestError(
              `The session grant does not name ${ungranted.join(", ")}. A market the ` +
                "session cannot pay is a promise the agent cannot keep. NOTE: this check " +
                "is an EARLY WARNING against the persisted grant snapshot — the chain is " +
                "the authority at action time, so widening the session on chain takes " +
                "effect there even while this check still refuses on the old snapshot.",
            );
          }

          // Every named market must also carry a per-action ceiling: R2.1 made
          // the per-token cap the sole bound on an approve-spender drain, so a
          // MISSING ceiling is never treated as unlimited.
          const uncapped = named.filter((vToken) => {
            const market = venus.marketIndex[vToken.toLowerCase()];
            if (market === undefined) return false;
            return maxPerActionFor(settings, market.underlying) === null;
          });
          if (uncapped.length > 0) {
            throw new BadRequestError(
              `No maxPerAction ceiling is set for ${uncapped.join(", ")}. Venus ceilings ` +
                "are SIZED, never defaulted — the per-token cap is the only bound on a " +
                "leaked session key's approve-spender drain.",
            );
          }

          const digest = paramsHash("venusSettings", params);
          const record = await venus.settingsStore.put({
            agentId: agent.id,
            ownerAddress: agent.ownerAddress,
            params,
            digest,
          });

          // The PROVISIONING sizing check, reported rather than enforced here.
          // It reserves per-submission arithmetic on the still-unmeasured
          // RELAY_FEE_PER_EXIT_WEI, and a rescue is never refused for want of
          // headroom — so refusing a settings write on it would refuse the
          // owner's ability to RAISE a ceiling on the strength of a guess.
          const sizing = checkVenusNativeCapSizing({
            onChainDailyCapWei: 0n,
            rescueReserveCount: settings.rescueReserveCount,
            maxClaimsPerDay: settings.maxClaimsPerDay,
            maxNativeActionWei: maxPerActionFor(settings, null) ?? 0n,
          });

          return {
            digest: record.digest,
            updatedAt: record.updatedAt,
            markets: {
              debt: settings.debtMarkets,
              collateral: settings.collateralMarkets,
            },
            sizingWarning: sizing.ok ? null : sanitizeMessage(sizing.message),
          };
        },
        // R3.9/S9 — the tracking seam BOTH flows pass through. The PUT is
        // issued from HERE, the one owner-signed Venus surface that self-serve
        // hire and the operator script both traverse, AFTER the journaled act
        // commits: post-commit, best-effort, never inside `act`, so a
        // data-plane outage cannot fail a settings write. The worker's
        // reconcile pass re-issues anything this misses.
        async ({ agent }) => {
          if (deps.dataPlane === undefined) return {};
          const result = await deps.dataPlane.venusTrackOwner(
            agent.ownerAddress,
            agent.id,
          );
          return { tracking: result.kind };
        },
      ),
    );

    /* ---- GET /agents/:id/venus/owner-view -------------------------------- */

    app.get("/agents/:id/venus/owner-view", async (c) => {
      const id = c.req.param("id");
      const auth = await authorizeRead(c, id);
      if (auth.kind !== "ok") return auth.response;
      const agent = await deps.agentStore.getAgent(auth.owner.ownerAddress, id);
      // Unknown agent and someone else's agent are the SAME response.
      if (agent === null) return fail(c, 404, "not_found");

      const stored = await venus.settingsStore.get(agent.ownerAddress, agent.id);
      const parsedSettings =
        stored === null ? null : parseVenusSettingsParams(stored.params);
      const digestVerified =
        stored === null
        || paramsHash("venusSettings", stored.params).toLowerCase()
          === stored.digest.toLowerCase();
      const settings =
        parsedSettings !== null && parsedSettings.ok ? parsedSettings.value : null;

      const conditions: VenusConditionReport[] = [];
      if (stored === null) {
        conditions.push(
          venusCondition("settings-absent", "This agent has no Venus settings."),
        );
      } else if (!digestVerified) {
        conditions.push(
          venusCondition(
            "settings-absent",
            "The stored settings digest does not recompute; the worker skips this agent " +
              "every cycle because automation must never run under settings nobody " +
              "provably signed.",
          ),
        );
      } else if (settings === null) {
        conditions.push(
          venusCondition("settings-absent", "The stored settings no longer parse."),
        );
      }

      // R2.15/R16 — expiry proximity as a FIRST-CLASS field, not raw seconds a
      // UI has to notice. A guard that will be dead tomorrow is a condition the
      // owner must see today, and `session-expired-or-revoked` fires only after
      // the fact.
      const facts = agent.sessionFacts;
      const expiresAt = facts?.expiry ?? null;
      const secondsLeft =
        expiresAt === null ? null : expiresAt - Math.floor(nowMs() / 1000);
      if (secondsLeft !== null && secondsLeft <= 0) {
        conditions.push(
          venusCondition("session-expired-or-revoked", "The session has expired."),
        );
      } else if (
        secondsLeft !== null
        && secondsLeft < VENUS_SESSION_EXPIRING_SECONDS
      ) {
        conditions.push(
          venusCondition(
            "session-expiring",
            `This guard stops guarding in ${Math.floor(secondsLeft / 3600)} hour(s). ` +
              "A guard session renews weekly with one owner signature.",
          ),
        );
      }

      // R3.7 — the guard-state field, not merely a row listing. The only
      // condition in this phase that changes the agent's behaviour gets a typed
      // name and a sentence the owner can act on.
      const hold = await readVenusUnknownHold(deps.journal, agent.id);
      if (hold.held) {
        conditions.push(
          venusCondition(
            "unknown-held",
            `Rescues are DEGRADED: supply and claim legs are disabled while ` +
              `${hold.keys.length} ambiguous submission(s) are UNKNOWN (callsIds: ` +
              `${hold.callsIds.join(", ") || "none recorded"}). venusRepay continues. ` +
              "v1 ships no Venus UNKNOWN resolver: an ambiguous submission degrades the " +
              "guard until the owner-signed venusResolveUnknown phase ships.",
          ),
        );
      }

      const usage = await venus.actions.usageSince(
        agent.ownerAddress,
        agent.id,
        nowMs() - VENUS_QUOTA_WINDOW_MS,
      );
      const observation = await venus.observations
        .get(agent.ownerAddress, agent.id, "rescue")
        .catch(() => null);

      // The CHAIN half. A failed read is `wakeRiskStatus: "unavailable"` — never
      // a guessed healthy — and never a 500 on the owner's dashboard.
      let chain: Record<string, unknown> | null = null;
      let wakeRiskStatus: "available" | "unavailable" = "unavailable";
      try {
        const reading = await venus.readers.readAccount(agent.ownerAddress);
        const view = venusBasisView(reading);
        wakeRiskStatus = "available";

        // REVISION 4.1 (V10, R4.3): the trap warning fires when the account
        // HOLDS native vToken collateral (however it got there — the guard
        // before R4, or the owner's own hand on venus.io, which no gate this
        // plane owns can prevent) OR when a STALE settings row still names
        // vBNB in collateralMarkets (a standing misconfiguration even at zero
        // balance: the worker refuses it every cycle). The trap stays a trap;
        // it stops being an unsigned one.
        const nativeMarket = reading.markets.find((entry) => entry.native);
        const staleNativeSettings =
          settings !== null &&
          settings.collateralMarkets.some(
            (vToken) => vToken.toLowerCase() === venus.venue.vBnb.toLowerCase(),
          );
        if ((nativeMarket !== undefined && nativeMarket.vTokenBalance > 0n) || staleNativeSettings) {
          conditions.push(
            venusCondition(
              "native-collateral-trapped",
              (nativeMarket !== undefined && nativeMarket.vTokenBalance > 0n
                ? `This account holds ${nativeMarket.vTokenBalance} vBNB. An EIP-7702 ` +
                  "wallet cannot receive vBNB's 2300-gas `.transfer()` payout, so a " +
                  "direct redeem REVERTS (FINDINGS (at)). ESCAPE: transfer the vBNB " +
                  "receipt (an ordinary ERC-20) to a plain, never-delegated EOA and " +
                  "redeem there — NEVER remove the delegation, which kills the live " +
                  "session. "
                : "") +
                (staleNativeSettings
                  ? "The stored settings still name vBNB in collateralMarkets (signed " +
                    "before Revision 4): the worker refuses it every cycle. Re-sign " +
                    "settings without it; supply WBNB to vWBNB " +
                    "(0x6bCa74586218db34cDB402295796b79663d816e9) for BNB-side collateral."
                  : ""),
              venus.venue.vBnb,
            ),
          );
        }
        // BOTH bases, UNCONDITIONALLY, each with its match flag (R2.15/R21).
        // The first draft promised "both bases once E-Mode evidence exists",
        // which is not a specification — nothing in the code can evaluate
        // "evidence exists".
        chain = {
          blockNumber: reading.blockNumber.toString(),
          userPoolId: reading.userPoolId.toString(),
          protocolPaused: reading.protocolPaused,
          liquidation: {
            collateral: view.pair.liquidationRisk.collateral.toString(),
            debt: view.pair.liquidationRisk.debt.toString(),
            healthFactor:
              view.pair.liquidationRisk.healthFactor === null
                ? null
                : view.pair.liquidationRisk.healthFactor.toString(),
            shortfall: view.pair.liquidationRisk.shortfall.toString(),
            matchesProtocol: view.liquidationMatched,
          },
          borrowingPower: {
            collateral: view.pair.borrowingPower.collateral.toString(),
            debt: view.pair.borrowingPower.debt.toString(),
            healthFactor:
              view.pair.borrowingPower.healthFactor === null
                ? null
                : view.pair.borrowingPower.healthFactor.toString(),
            shortfall: view.pair.borrowingPower.shortfall.toString(),
            matchesProtocol: view.borrowingPowerMatched,
          },
          markets: reading.markets.map((market) => ({
            vToken: market.vToken,
            symbol: market.vTokenSymbol,
            underlying: market.underlying,
            native: market.native,
            collateralMember: market.collateralMember,
            borrowCurrent: (market.borrowCurrent ?? market.borrowStored).toString(),
            walletBalance: market.walletBalance.toString(),
            // R2.1(2)/R2.16/R25: a residual allowance OUTLIVES the session's
            // expiry until it is spent or zeroed, so it is surfaced here until
            // it is.
            residualAllowance: market.allowance.toString(),
            mintPaused: market.mintPaused,
            repayPaused: market.repayPaused,
            supplyHeadroom: market.supplyHeadroom.toString(),
          })),
        };
        if (!view.liquidationMatched || !view.borrowingPowerMatched) {
          conditions.push(
            venusCondition(
              "protocol-mismatch",
              "The local reconstruction does not equal the protocol's own answer; the " +
                "guard fails closed rather than acting on a smaller number.",
            ),
          );
        }
        if (reading.userPoolId > reading.lastPoolId) {
          conditions.push(
            venusCondition(
              "emode-unverified",
              "The account sits in a pool configuration this plane cannot interpret.",
            ),
          );
        }
        if (reading.protocolPaused) {
          conditions.push(
            venusCondition("protocol-paused", "The Comptroller reports protocolPaused."),
          );
        }

        // RESCUE CAPACITY — "guard requires funded wallet", made visible. A
        // guard armed over an empty wallet refuses at the moment it matters,
        // and nothing else on this view says so.
        if (settings !== null && digestVerified) {
          const sizingMarkets = reading.markets.map((market) => ({
            vToken: market.vToken,
            underlying: market.underlying,
            native: market.native,
            listed: market.listed,
            borrowAllowed: market.borrowAllowed,
            mintPaused: market.mintPaused,
            repayPaused: market.repayPaused,
            supplyHeadroom: market.supplyHeadroom,
            borrowCurrent: market.borrowCurrent ?? market.borrowStored,
            walletBalance: market.walletBalance,
            // PHASE4-AUDIT A2: the view sizes on the same inputs the worker
            // dispatches on, allowance included, so the published rescue
            // capacity cannot silently disagree with what would be submitted.
            allowance: market.native ? 0n : market.allowance,
            maxPerActionWei: maxPerActionFor(settings, market.underlying),
            capRemainingWei: null,
            inGrant: facts === null ? false : grantsVenusMarket(facts.spec, market.vToken),
            inDebtSettings: namesMarket(settings.debtMarkets, market.vToken),
            inCollateralSettings: namesMarket(
              settings.collateralMarkets,
              market.vToken,
            ),
            collateralMember: market.collateralMember,
            vTokenBalance: market.vTokenBalance,
            exchangeRate: market.exchangeRateCurrent ?? market.exchangeRateStored,
            borrowBalance: market.borrowCurrent ?? market.borrowStored,
            collateralFactor: market.effectiveCf,
            liquidationThreshold: market.effectiveLt,
            collateralPrice: market.boundedCollateralPrice,
            debtPrice: market.boundedDebtPrice,
            spotPrice: market.spotPrice,
          }));
          const capacity = venusRescueCapacity(sizingMarkets, {
            basis: "liquidation",
            targetHf: settings.targetHf,
            vaiDebt: reading.vaiDebt,
            protocolPaused: reading.protocolPaused,
            walletNativeFloorWei: walletNativeFloorWei(),
            hasNativeGrant: facts !== null
              && facts.spec.spendCaps.some((cap) => cap.token === undefined),
          });
          chain["rescueCapacity"] = {
            currentHf:
              capacity.currentHf === null ? null : capacity.currentHf.toString(),
            bestAchievableHf:
              capacity.bestAchievableHf === null
                ? null
                : capacity.bestAchievableHf.toString(),
            perMarket: capacity.perMarket.map((entry) => ({
              vToken: entry.vToken,
              kind: entry.kind,
              amountWei: entry.amountWei.toString(),
              achievedHf:
                entry.achievedHf === null ? null : entry.achievedHf.toString(),
            })),
          };
          if (capacity.perMarket.length === 0) {
            conditions.push(
              venusCondition(
                "insufficient-wallet-balance",
                "No allowed market could currently fund a rescue. This guard needs a " +
                  "funded wallet: it repays and supplies from the owner's own balance.",
              ),
            );
          }
        }
      } catch {
        conditions.push(
          venusCondition(
            "transport",
            "The guard's own chain reads failed; monitoring is degraded and no health " +
              "factor is reported. This is NOT a healthy answer.",
          ),
        );
      }

      // THE METER FIGURES THE CLAIM GATE REFUSES ON — the Phase 2.5 F4 shared
      // seam pattern: the gate refuses on this answer and this view REPORTS it,
      // and both call the same function.
      let meter: Record<string, unknown> | null = null;
      const venusProvider = deps.providerRegistry.get(config.chainId);
      const readMeter = venusProvider.nativeDayMeter;
      if (facts !== null && readMeter !== undefined) {
        try {
          const reading = await readMeter.call(venusProvider, {
            walletAddress: agent.walletAddress,
            publicKey: facts.publicKey,
          });
          if (reading.kind === "day") {
            const reserve = venusMeterReserve({
              limitWei: reading.limitWei,
              currentSpentWei: reading.currentSpentWei,
              rescueReserveCount:
                settings?.rescueReserveCount ?? DEFAULT_VENUS_RESCUE_RESERVE_COUNT,
              rescuesChargedInWindow: usage.rescues,
              submissionNativeWei: 0n,
            });
            meter = {
              kind: "day",
              limitWei: reading.limitWei.toString(),
              currentSpentWei: reading.currentSpentWei.toString(),
              remainingWei: reserve.remainingWei.toString(),
              overCap: reserve.overCap,
              claimReserveWei: reserve.reserveWei.toString(),
              reservedSubmissions: reserve.reservedSubmissions,
              claimSufficient: reserve.sufficient,
              claimShortfallWei: reserve.shortfallWei.toString(),
            };
            if (!reserve.sufficient) {
              conditions.push(
                venusCondition(
                  "native-reserve",
                  `Claims are refused so the meter keeps ${reserve.reservedSubmissions} ` +
                    `rescue submission(s) of headroom (short by ${reserve.shortfallWei} ` +
                    "wei). Rescues are NEVER refused by this reserve. The remedy is an " +
                    "owner action on chain: raise the session's daily native cap.",
                ),
              );
            }
          } else {
            meter = { kind: reading.kind };
            if (reading.kind === "no-native-grant") {
              conditions.push(
                venusCondition(
                  "no-native-grant",
                  "This session has no native spend row, so it cannot attach msg.value at " +
                    "all: NATIVE repay and supply are refused at sizing time. ERC-20 " +
                    "rescues are unaffected.",
                ),
              );
            }
          }
        } catch {
          meter = null;
          conditions.push(
            venusCondition(
              "transport",
              "The native day meter could not be read. Claims fail CLOSED on this; " +
                "rescues are never gated by a reserve.",
            ),
          );
        }
      }

      return c.json({
        data: {
          agentId: agent.id,
          venusEnabled: true,
          wakeRiskStatus,
          settings:
            settings === null
              ? null
              : {
                  triggerHf: settings.triggerHf.toString(),
                  targetHf: settings.targetHf.toString(),
                  notifyOnlyBelowHf:
                    settings.notifyOnlyBelowHf === undefined
                      ? null
                      : settings.notifyOnlyBelowHf.toString(),
                  debtMarkets: settings.debtMarkets,
                  collateralMarkets: settings.collateralMarkets,
                  maxClaimsPerDay: settings.maxClaimsPerDay,
                  minSecondsBetweenActions: settings.minSecondsBetweenActions,
                  minClaimValueWei: settings.minClaimValueWei.toString(),
                  claimEnabled: settings.claimEnabled,
                  claimRepayEnabled: settings.claimRepayEnabled,
                  rescueReserveCount: settings.rescueReserveCount,
                },
          settingsDigestVerified: digestVerified,
          // R3.3 — WHICH BUDGETS BIND WHICH ACTIONS, said plainly, so a UI
          // reading `agent.caps` cannot imply a bound on rescues that does not
          // exist. Venus money rows record `nativeSpendWei` honestly; rescues
          // are NOT gated by `agent.caps` or by `maxClaimsPerDay`, and claims
          // are gated by both.
          budgets: {
            rescuesGatedByAgentCaps: false,
            rescuesGatedByDailyQuota: false,
            rescuesGovernedBy: ["minSecondsBetweenActions", "hysteresis"],
            claimsGatedByAgentCaps: true,
            claimsGatedByDailyQuota: true,
          },
          quota: {
            windowMs: VENUS_QUOTA_WINDOW_MS,
            rescuesCharged: usage.rescues,
            claimsCharged: usage.claims,
            maxClaimsPerDay: settings?.maxClaimsPerDay ?? null,
            lastRescueAtMs: usage.lastRescueAtMs,
            lastClaimAtMs: usage.lastClaimAtMs,
          },
          hysteresis:
            observation === null
              ? null
              : {
                  blockNumber: observation.blockNumber.toString(),
                  evaluatedAtMs: observation.evaluatedAtMs,
                  healthFactor:
                    observation.healthFactor === null
                      ? null
                      : observation.healthFactor.toString(),
                  breach: observation.breach,
                  consecutive: observation.consecutive,
                  shortfall: observation.shortfall,
                  settingsDigestMatches:
                    stored !== null
                    && observation.settingsDigest.toLowerCase()
                      === stored.digest.toLowerCase(),
                  confirmationEligibleAtMs:
                    observation.evaluatedAtMs + venus.intervalMs,
                  staleAfterMs:
                    observation.evaluatedAtMs + venus.maxObservationAgeMs,
                },
          session: {
            expiresAt,
            secondsRemaining: secondsLeft,
            renewalCadence:
              "A Venus guard session is capped at 7 days and renews with one owner " +
              "signature. The ceiling exists because Altana caps are rolling per period " +
              "with no lifetime ceiling, so session length multiplies real exposure — and " +
              "because the Core Comptroller is a Diamond whose selector routing is " +
              "governance-mutable under a live grant.",
          },
          meter,
          chain,
          // The honest latency claim (R2.14), stated where the owner reads it.
          latency: {
            workerIntervalMs: venus.intervalMs,
            floorFromBreachToRescueMs: 2 * venus.intervalMs + 10_000,
            note:
              "The guard's working range is 1.0 < HF < triggerHf. Below 1.0 the account " +
              "is already liquidatable and the single-confirmation carve-out races bots " +
              "reading `latest` and the mempool — a race this plane will usually LOSE. " +
              "Set triggerHf high enough that the band exceeds one worker interval of " +
              "plausible price movement.",
          },
          conditions,
        },
        meta: { agentId: agent.id },
      });
    });
  }

  /**
   * The lending guard surface (MARKETPLACE-LENDING-AGENT §3.2, §4, §6.1, §8.3,
   * R3.9).
   *
   * SEVEN routes: three owner-signed mutations, one owner READ behind
   * `authorizeAccountRead`, and three PERIMETER reads of public chain state.
   *
   * The perimeter reads are the deliberate widening this phase makes over Phase
   * 4's "ZERO routes reachable with `x-exec-token` alone", and the reason is
   * that the browser needs three things BEFORE any signature exists: A's
   * position (so a mistyped address is caught by eye rather than by a refusal
   * after funding — §0.5's whole safeguard), the venue addresses its passkey
   * recovery batch must be built against, and a QuoterV2 quote so its `minOut`
   * comes off THE SAME RAIL the plane uses. All three answer PUBLIC CHAIN DATA
   * and carry no owner data at all; `/lending/guardable` is metered per R2.11
   * because it is an RPC amplifier, and its receipt authorizes nothing.
   *
   * Registered only when the deps are wired, so a deployment with
   * `LENDING_ENABLED` unset or `"false"` answers the same 404 an unknown path
   * gets.
   */
  function registerLendingRoutes(lending: LendingServerDeps): void {
    const previewLimiter = createLendingPreviewLimiter(nowMs);
    const previewCache = createLendingPreviewCache<LendingGuardableView>(nowMs);

    const venueAddresses = {
      vUsdt: lending.venue.vUsdt,
      usdt: lending.venue.usdt,
      vBnb: lending.venue.vBnb,
      routerV3: lending.venue.routerV3,
      wbnb: lending.venue.wbnb,
      swapFeeTier: lending.venue.swapFeeTier,
    };

    /** The pinned market set, so a refusal can name which one is unsupported. */
    const supportedMarket = (vToken: Address): boolean =>
      vToken.toLowerCase() === lending.venue.vUsdt.toLowerCase()
      || vToken.toLowerCase() === lending.venue.vBnb.toLowerCase();

    /* ---- GET /lending/config (R3.9 / L4) --------------------------------- */

    app.get("/lending/config", (c) => {
      const view: LendingConfigView = {
        chainId: 56,
        vUsdt: lending.venue.vUsdt,
        usdt: lending.venue.usdt,
        vBnb: lending.venue.vBnb,
        routerV3: lending.venue.routerV3,
        wbnb: lending.venue.wbnb,
        quoterV2: lending.venue.quoterV2,
        swapFeeTier: lending.venue.swapFeeTier,
        maxSagaSlippageBps: lending.maxSagaSlippageBps,
        dustUsdtWei: LENDING_DUST_USDT_WEI.toString(10),
        maxMarkets: LENDING_MAX_MARKETS,
        // The RESOLVED cadence, from the same composed deps the worker takes.
        workerIntervalMs: lending.intervalMs,
      };
      return c.json({ data: view });
    });

    /* ---- GET /lending/quote (R3.9 / L4) ---------------------------------- */

    app.get("/lending/quote", async (c) => {
      const rawIn = c.req.query("tokenIn") ?? "";
      const rawOut = c.req.query("tokenOut") ?? "";
      const rawAmount = c.req.query("amountInWei") ?? "";
      if (!isAddress(rawIn, { strict: false }) || !isAddress(rawOut, { strict: false })) {
        return fail(c, 400, "invalid_request", "tokenIn and tokenOut must be addresses.");
      }
      if (!/^\d{1,78}$/u.test(rawAmount) || BigInt(rawAmount) <= 0n) {
        return fail(c, 400, "invalid_request", "amountInWei must be a positive decimal uint256.");
      }
      // A CLOSED pair set. The browser's recovery batch swaps USDT -> WBNB and
      // nothing else, and a general quoting proxy behind the perimeter token
      // would be an RPC amplifier for arbitrary pools.
      const tokenIn = getAddress(rawIn);
      const tokenOut = getAddress(rawOut);
      const pairOk =
        (tokenIn.toLowerCase() === lending.venue.usdt.toLowerCase()
          && tokenOut.toLowerCase() === lending.venue.wbnb.toLowerCase())
        || (tokenIn.toLowerCase() === lending.venue.wbnb.toLowerCase()
          && tokenOut.toLowerCase() === lending.venue.usdt.toLowerCase());
      if (!pairOk) {
        return fail(c, 400, "invalid_request",
          "Only the pinned WBNB/USDT pair is quotable here.");
      }
      // AUDIT B-M4 — the per-"account" bucket is keyed on the CLIENT, not on
      // `tokenIn`.
      //
      // `tokenIn` is one of exactly two constants here, so the per-account
      // bucket was a PLATFORM-WIDE ten-per-minute allowance per direction: one
      // browser refreshing a recovery screen could exhaust the quote route for
      // every other user. The forwarded client key is the only per-caller
      // identity this route has; when there is none the global bucket still
      // applies, which is the same posture `/lending/guardable` takes.
      const quoteClient = clientKey(c);
      if (!previewLimiter.tryConsume(quoteClient ?? "anonymous", quoteClient)) {
        return fail(c, 429, "rate_limited");
      }
      try {
        const quotedOutWei = await lending.readers.quote({
          tokenIn, tokenOut, amountInWei: BigInt(rawAmount),
        });
        if (quotedOutWei <= 0n) return fail(c, 503, "evidence_unreadable");
        const view: LendingQuoteView = {
          tokenIn, tokenOut, fee: lending.venue.swapFeeTier,
          amountInWei: rawAmount,
          quotedOutWei: quotedOutWei.toString(10),
          minOutWei: sagaSwapMinOut(quotedOutWei, lending.maxSagaSlippageBps).toString(10),
          maxSagaSlippageBps: lending.maxSagaSlippageBps,
        };
        return c.json({ data: view });
      } catch {
        return fail(c, 503, "evidence_unreadable");
      }
    });

    /* ---- GET /lending/guardable (§3.2, R2.10, R2.11, R3.3(5)) ------------ */

    app.get("/lending/guardable", async (c) => {
      const parsed = parseGuardableQuery({
        account: c.req.query("account"),
        budgetWei: c.req.query("budgetWei"),
        reserveBps: c.req.query("reserveBps"),
        maxPerActionUsdtWei: c.req.query("maxPerActionUsdtWei"),
        rescueReserveCount: c.req.query("rescueReserveCount"),
      });
      if (!parsed.ok) return fail(c, 400, "invalid_request", parsed.message);
      const { account, sizing } = parsed.value;
      if (!previewLimiter.tryConsume(account, clientKey(c))) {
        return fail(c, 429, "rate_limited");
      }

      // AUDIT B-M3 — THE CACHE IS CONSULTED BEFORE THE FAN-OUT.
      //
      // It used to be looked up AFTER `readAccount`, whose block number was
      // part of its key, so the lookup could only happen once the expensive
      // read it was meant to avoid had already happened: two identical calls
      // cost two fan-outs and the cache saved nothing but a rebuild of the
      // view object. DISPLAY MODE only — a receipt is a signed claim about a
      // block and is re-derived every time.
      if (sizing === null) {
        const recent = previewCache.getRecent(account);
        if (recent !== undefined) return c.json({ data: recent });
      }

      let readingA;
      try {
        readingA = await lending.readers.readAccount(account, [
          lending.venue.vUsdt,
          lending.venue.vBnb,
        ]);
      } catch (error) {
        if (error instanceof LendingAccountTooComplexError) {
          return c.json({ data: {
            account, blockNumber: "0",
            bases: { borrowingPower: { hf: null, matched: false },
              liquidation: { hf: null, matched: false } },
            markets: [], debts: [], guardable: false,
            refusal: "account-too-complex",
            note:
              "Your account is in more markets than this guard can price; the guard is "
              + "paused until it can.",
          } satisfies LendingGuardableView });
        }
        return fail(c, 503, "evidence_unreadable");
      }

      // The 30 s `(account, finalizedBlock)` cache. Keyed on the BLOCK too, so
      // an answer can never be served across a block boundary.
      const cached = sizing === null
        ? previewCache.get(account, readingA.blockNumber)
        : undefined;
      if (cached !== undefined) return c.json({ data: cached });

      const view = buildGuardableView({
        readingA, account, lending, supportedMarket,
      });
      if (sizing === null) {
        previewCache.set(account, readingA.blockNumber, view);
        return c.json({ data: view });
      }

      // RECEIPT MODE. The floor needs a quote of what `supplyNativeWei` buys and
      // of what the BNB tier could buy back, so it costs two quotes — which is
      // why the display mode does not take them.
      const reserveNativeWei =
        (sizing.budgetWei * BigInt(sizing.reserveBps)) / 10_000n;
      const supplyNativeWei = sizing.budgetWei - reserveNativeWei;
      let mintUsdtWei = 0n;
      let tierBuyBackUsdtWei = 0n;
      try {
        const [supplyQuote, tierQuote] = await Promise.all([
          lending.readers.quote({
            tokenIn: lending.venue.wbnb, tokenOut: lending.venue.usdt,
            amountInWei: supplyNativeWei,
          }),
          reserveNativeWei > 0n
            ? lending.readers.quote({
                tokenIn: lending.venue.wbnb, tokenOut: lending.venue.usdt,
                amountInWei: reserveNativeWei,
              })
            : Promise.resolve(0n),
        ]);
        mintUsdtWei =
          supplyQuote > 0n ? sagaSwapMinOut(supplyQuote, lending.maxSagaSlippageBps) : 0n;
        tierBuyBackUsdtWei =
          tierQuote > 0n ? sagaSwapMinOut(tierQuote, lending.maxSagaSlippageBps) : 0n;
      } catch {
        return fail(c, 503, "evidence_unreadable");
      }
      const preview = lendingHireSizingPreview({
        budgetWei: sizing.budgetWei,
        reserveBps: sizing.reserveBps,
        // The preview is a SIZING HINT: it reports the floor the hire must
        // clear, so it prices the caps at the floor itself rather than at a cap
        // the caller has not chosen yet.
        capDayWei: 0n,
        reserveCapWei: 0n,
        mintUsdtWei,
        tierBuyBackUsdtWei,
        rescueReserveCount: sizing.rescueReserveCount,
      });
      const withSizing: LendingGuardableView = {
        ...view,
        sizing: {
          reserveCapFloorWei: preview.reserveCapFloorWei,
          minimumCapDayWei: preview.minimumCapDayWei,
          mintUsdtWei: preview.mintUsdtWei,
          reserveNativeWei: preview.reserveNativeWei,
          supplyNativeWei: preview.supplyNativeWei,
          ok: view.guardable,
        },
      };
      if (lending.previewSecret === null) {
        // FAIL-CLOSED (R3.8): no secret ⇒ no receipt ⇒ S1 refuses. The preview
        // still answers, so the guarded-account stage keeps working and the
        // operator sees the misconfiguration at the hire rather than never.
        return c.json({ data: withSizing });
      }
      const issued = issueLendingPreviewReceipt({
        key: lending.previewSecret,
        nowSec: nowSec(),
        claims: {
          account,
          blockNumber: readingA.blockNumber.toString(10),
          guardable: view.guardable,
          debts: view.debts
            .filter((debt) => debt.supported)
            .map((debt) => ({ vToken: debt.vToken, borrowWei: debt.borrowWei })),
          budgetWei: sizing.budgetWei.toString(10),
          reserveBps: sizing.reserveBps,
          maxPerActionUsdtWei: sizing.maxPerActionUsdtWei.toString(10),
          rescueReserveCount: sizing.rescueReserveCount,
          mintUsdtWei: mintUsdtWei.toString(10),
          tierBuyBackUsdtWei: tierBuyBackUsdtWei.toString(10),
          reserveCapFloorWei: preview.reserveCapFloorWei,
          minimumCapDayWei: preview.minimumCapDayWei,
        },
      });
      return c.json({ data: {
        ...withSizing,
        previewReceipt: issued.token,
        expiresAtSec: issued.expiresAt,
      } satisfies LendingGuardableView });
    });

    /* ---- POST /agents/:id/lending/arm (§4.1, R2.1, R2.10, L12) ----------- */

    app.post("/agents/:id/lending/arm", (c) =>
      ownerMutation(c, c.req.param("id"), "lendingArm", "lendingArm",
        async ({ agent, params }) => {
          const parsed = parseLendingArmParams(params);
          if (!parsed.ok) throw new BadRequestError(parsed.message);
          const request = parsed.value;
          if (agent.sessionFacts === null) {
            throw new BadRequestError(
              "Agent has no granted session; an arm that could not later be retired is refused.",
            );
          }
          if (agent.sessionFacts.hireSizing?.name !== "lending-v1") {
            throw new BadRequestError(
              `This agent was hired as ${agent.sessionFacts.hireSizing?.name ?? "an older preset"}; lendingArm is for lending-v1 hires.`,
            );
          }
          const guard = await lending.guards.get(agent.ownerAddress, agent.id);
          if (guard === null) {
            throw new BadRequestError(
              "This agent has no lending guard row yet; the hire's convergence writes it. Reload and try again.",
            );
          }
          // L11: a re-arm after `retired` is REFUSED so two budgets can never
          // be summed across arms on one session. Renewal is retire + re-hire.
          if (guard.status === "retired") {
            throw new BadRequestError(
              "This guard has been retired. Renewal is retire + re-hire: a second arm on the same session would grant a second budget against the same daily caps.",
            );
          }
          if (guard.status !== "provisioning-guard" && guard.status !== "closed") {
            throw new BadRequestError(
              `This guard is ${guard.status}; a second arm is a second swap. Retire it, or wait for the worker to converge it.`,
            );
          }

          const profile = enforceLendingV1Profile(request.settings, {
            debtMarkets: guard.debtMarkets,
            usdt: lending.venue.usdt,
            vUsdt: lending.venue.vUsdt,
            vBnb: lending.venue.vBnb,
            grantedReserveCapWei: guard.reserveCapWei,
            grantedCapDayWei: agent.caps?.dailyNativeWei ?? 0n,
            hireBudgetWei: BigInt(agent.sessionFacts.hireSizing.openNativeBudgetWei),
          }, request.budgetWei);
          if (profile !== null) throw new BadRequestError(profile.message);

          // AUDIT P19 / G-M1 — THE ARM MUST CARRY THE SETTINGS THE OWNER SIGNED.
          //
          // S1 signs the COMPLETE lending settings (digest on
          // `PendingGrant.initialLendingHire`, materialized into
          // `lending_settings` at convergence). The arm then took a `settings`
          // object again and only ran the v1 profile over it, so a browser
          // reload between the grant and the arm — which loses the form state
          // and rebuilds it from defaults — armed DEFAULT thresholds against a
          // funded budget, silently, under a valid owner signature.
          //
          // The arm is therefore a CONTINUATION, not a second admission: its
          // settings must hash to what the owner already signed — either the
          // hire's digest, or the digest an owner-signed `lendingSettings`
          // update has since put in its place. Anything else is refused with
          // the two paths back, and NOTHING is submitted.
          //
          // Pure, and BEFORE the fence: this reads only what is already
          // persisted, so a refusal touches no durable state (B-M2's rule).
          const armDigest = lendingSettingsDigest(request.settingsParams);
          const storedSettings = await lending.settingsStore.get(
            agent.ownerAddress, agent.id,
          );
          // THE CURRENT DIGEST IS THE AUTHORITY, NOT A UNION THAT GROWS
          // (FIXREVIEW F2). The stored `lending_settings` row is materialized
          // from `initialLendingHire` at convergence, so on the ordinary path
          // the two ARE the same bytes. When they differ, the owner has signed
          // a `lendingSettings` update since — now reachable BEFORE the first
          // arm, which is the F2 fix — and the hire's superseded digest must
          // stop being admissible, or that update could be silently undone by
          // arming with the older signature.
          //
          // In practice the hire digest is already unreachable here:
          // `armProvisioningAgent` clears `pendingGrant` when the session is
          // granted, and this route requires `sessionFacts`. So this arm is
          // belt-and-braces on a branch no live agent takes, and the ONE test
          // that can see it is the `?? ` order itself. The fallback stays for
          // the case where there is nothing else to compare against: no
          // settings row at all.
          const hireDigest = agent.pendingGrant?.initialLendingHire?.digest;
          const acceptedDigests = [
            storedSettings?.digest ?? hireDigest,
          ].filter((value): value is Hex => value !== undefined)
            .map((value) => value.toLowerCase());
          if (!acceptedDigests.includes(armDigest.toLowerCase())) {
            throw new BadRequestError(
              "settings-digest-mismatch: sign lendingSettings first, or arm with the "
              + "settings you signed at hire. These are not the settings this hire "
              + "carries, and an arm never admits new ones.",
            );
          }
          // The same rule for the two figures the hire was SIZED on. Equality,
          // not a ceiling: a lower budget re-sizes the reserve split and the
          // mint floor against arithmetic S1 never performed, so it is a
          // post-v1 feature rather than a silently accepted variation.
          const hireBudgetWei = BigInt(agent.sessionFacts.hireSizing.openNativeBudgetWei);
          if (request.budgetWei !== hireBudgetWei) {
            throw new BadRequestError(
              `hire-budget-mismatch: arm with the budget this hire was sized and funded `
              + `for (${hireBudgetWei} wei), or retire and re-hire at the size you want. `
              + "Arming below the hire budget is not supported in v1.",
            );
          }
          if (request.reserveBps !== guard.reserveBps) {
            throw new BadRequestError(
              `reserve-bps-mismatch: arm with the reserve split this hire was sized for `
              + `(${guard.reserveBps} bps), or retire and re-hire at the split you want. `
              + "Changing it at arm time is not supported in v1.",
            );
          }

          // R2.10: A is re-read BEFORE the fence, and the cheap facts are
          // re-verified inside it. `readAccount` is the fan-out; holding an
          // advisory lock across it would serialize every other surface behind
          // a third party's market count.
          let readingA;
          try {
            readingA = await lending.readers.readAccount(
              guard.guardedAccount, guard.debtMarkets,
            );
          } catch (error) {
            if (error instanceof LendingAccountTooComplexError) {
              throw new BadRequestError(
                "The guarded account is in more markets than this guard can price; the arm is refused.",
              );
            }
            throw new BadRequestError(
              "The guarded account could not be read; the arm is refused rather than armed blind.",
            );
          }
          const hasDebt = guard.debtMarkets.some((vToken) => {
            const market = readingA.markets.find(
              (entry) => entry.vToken.toLowerCase() === vToken.toLowerCase(),
            );
            return (market?.borrowCurrent ?? market?.borrowStored ?? 0n) > 0n;
          });
          if (!hasDebt) {
            throw new BadRequestError(
              "The guarded account carries no debt in any pinned market; there is nothing for this guard to do.",
            );
          }

          const reserveNativeWei =
            (request.budgetWei * BigInt(request.reserveBps)) / 10_000n;
          const supplyNativeWei = request.budgetWei - reserveNativeWei;

          // L12: `mintUsdtWei` is RE-DERIVED at arm time from the BOOT fee
          // tier, and the response discloses the tier that was used — the
          // operator can move it between the preview quote and the arm, so the
          // number the owner was shown and the number that was used must never
          // be silently different.
          let mintUsdtWei: bigint;
          let tierBuyBackUsdtWei: bigint;
          try {
            const [supplyQuote, tierQuote] = await Promise.all([
              lending.readers.quote({
                tokenIn: lending.venue.wbnb, tokenOut: lending.venue.usdt,
                amountInWei: supplyNativeWei,
              }),
              reserveNativeWei > 0n
                ? lending.readers.quote({
                    tokenIn: lending.venue.wbnb, tokenOut: lending.venue.usdt,
                    amountInWei: reserveNativeWei,
                  })
                : Promise.resolve(0n),
            ]);
            if (supplyQuote <= 0n) {
              throw new BadRequestError(
                "The WBNB/USDT pool returned no quote for the supply leg; the arm is refused rather than swapped without a floor.",
              );
            }
            mintUsdtWei = sagaSwapMinOut(supplyQuote, lending.maxSagaSlippageBps);
            tierBuyBackUsdtWei =
              tierQuote > 0n ? sagaSwapMinOut(tierQuote, lending.maxSagaSlippageBps) : 0n;
          } catch (error) {
            if (error instanceof BadRequestError) throw error;
            throw new BadRequestError(
              "The arm's swap could not be quoted; refusing rather than arming against a stale price.",
            );
          }

          // The LIVE on-chain caps, not the hire's request: an owner may have
          // widened or narrowed them since.
          // AUDIT B-L8: A TRANSPORT FAULT IS NOT A SIZING SHORTFALL.
          //
          // An unreadable meter used to become `liveCapDayWei = 0n`, which made
          // `checkLendingSizing` refuse with "raise your daily cap" — a remedy
          // for a problem the owner does not have, on a cap that may be
          // perfectly adequate. The arm is an owner action with a retry, so it
          // refuses as `transport` and says to try again.
          let liveCapDayWei: bigint;
          try {
            const nativeMeter = await lending.readers.readTokenDayMeter({
              walletAddress: agent.walletAddress,
              publicKey: agent.sessionFacts.publicKey,
              token: null,
            });
            if (nativeMeter.kind === "unreadable") {
              throw new ConflictError(
                "transport: the session's native day meter could not be read, and the arm "
                + "sizes on it. Nothing was changed; try again shortly.",
              );
            }
            liveCapDayWei = nativeMeter.kind === "day" ? nativeMeter.limitWei : 0n;
          } catch (error) {
            if (error instanceof ConflictError) throw error;
            throw new ConflictError(
              "transport: the session's native day meter could not be read, and the arm "
              + "sizes on it. Nothing was changed; try again shortly.",
            );
          }
          const sized = checkLendingSizing({
            budgetWei: request.budgetWei,
            reserveBps: request.reserveBps,
            capDayWei: liveCapDayWei,
            reserveCapWei: guard.reserveCapWei,
            mintUsdtWei,
            tierBuyBackUsdtWei,
            rescueReserveCount: request.settings.rescueReserveCount,
          });
          if (!sized.ok) {
            // AUDIT A-M3 — REMEDY FIRST, AND THE FIGURE IS STRUCTURED.
            //
            // `sanitizeMessage` caps a stored refusal at 280 characters, and
            // this check's own prose is 500+: the owner was told the cap was
            // too small and the sentence that said BY HOW MUCH, and what to do,
            // fell past the cap. The shortfall now rides as `meta.shortfallWei`
            // — the PHASE3.1-AUDIT A9 shape — and the text leads with the
            // remedy. The full arithmetic still lives in `sized.message`, which
            // the operator scripts print untruncated.
            if (sized.kind === "malformed") {
              throw new BadRequestError(`Lending arm refused: ${sized.message}`);
            }
            throw new LpSizingShortfallError(
              "Lending arm refused: raise the session's daily caps with "
              + "owner-add-spend-limit, or lower the budget. Shortfall (wei): "
              + `${sized.shortfallWei}`,
              sized.shortfallWei,
            );
          }

          // L12: the wallet-floor re-check the S1 arithmetic cannot make. S1
          // sized a BUDGET; the grant's own gas may have eaten the headroom
          // since, and an arm that leaves B below the floor cannot pay for the
          // first rescue's relay fee.
          const reserve = await lending.readers.readReserve(agent.walletAddress);
          // AUDIT A-L6: TWO fees, not one — the ARM's own submission draws a
          // relay reimbursement out of this balance before the first rescue
          // ever runs, and the check reserved only the rescue's.
          const armFloorWei = walletNativeFloorWei() + 2n * RELAY_FEE_PER_EXIT_WEI;
          if (reserve.nativeBalance - supplyNativeWei < armFloorWei) {
            // Remedy first: the figures are useful, the fix is what the owner
            // needs inside the 280-character cap.
            throw new BadRequestError(
              "wallet-floor-short: deposit more BNB, or lower the budget. The arm would spend "
              + `${supplyNativeWei} of ${reserve.nativeBalance} wei, leaving less than the `
              + `${armFloorWei} wei needed for the arm's OWN relay fee and the first rescue's.`,
            );
          }

          // The digest is PURE; the WRITE happens inside the fence, below
          // (AUDIT B-M2): a refused arm used to have already replaced the
          // stored settings, so an admission the plane rejected still moved
          // the digest the worker's hysteresis counter is bound to.
          const digest = lendingSettingsDigest(request.settingsParams);

          // THE DECISION ID IS KEYED ON THE ROW VERSION THE CAS CONSUMES
          // (AUDIT B-H2), never on the PRE-fence read.
          //
          // Two owner-signed arms that both read `rowVersion: 1` outside the
          // fence used to derive the SAME key `…:arm:1`, and the second one —
          // admitted from `closed` after the first rolled back — reused the
          // first's ROLLED_BACK journal row: the swap and the mint landed,
          // `markInProgress` threw AFTER `executeViaSession`, and the arm door
          // then closed the guard as "arm-rolled-back — NOTHING WAS SPENT",
          // leaving a re-arm free to mint a SECOND budget on one session.
          //
          // `fresh.rowVersion` is unique per admission by construction: the CAS
          // asserts it and increments it, so no two admissions of this row can
          // ever observe the same value.
          let decisionId = "";
          let armJournalKey = "";
          const admitted = await lending.guards.withLendingFence(
            agent.ownerAddress, agent.id, async (fence) => {
              const fresh = await fence.get();
              if (fresh === null
                || (fresh.status !== "provisioning-guard" && fresh.status !== "closed")) {
                throw new ConflictError(
                  "The guard changed status between the read and the fence; re-sign to arm.",
                );
              }
              decisionId = lendingOwnerActionDecisionId(agent.id, "arm", fresh.rowVersion);
              armJournalKey = `${agent.id}:${decisionId}`;
              // FIXREVIEW F6 — THE ADMISSION CAS RUNS ON THE FENCE'S OWN
              // TRANSACTION, and the settings write follows it rather than
              // preceding it.
              //
              // B-M2 put the settings `put` inside the fence, after the idle
              // gate, so a refused arm leaves the digest alone. P12's residual
              // was the narrower case: the `put` ran BEFORE `armCas`, on the
              // pool, so a CAS that LOST left the digest moved anyway. Running
              // the CAS first closes that — nothing is written until the
              // admission is real — and running it on `tx` means an aborting
              // fence takes it back.
              //
              // The settings store is a DIFFERENT store over its own
              // `SqlClient` and cannot join this transaction; that residue is
              // named on `LendingGuardFence` and is benign, because the only
              // bytes that can land here are ones the owner signed and P19
              // already accepts.
              const admittedInFence = await fence.armCas({
                expectedRowVersion: fresh.rowVersion,
                budgetWei: request.budgetWei,
                reserveBps: request.reserveBps,
                supplyNativeWei,
                reserveNativeWei,
                mintUsdtWei,
                preArmVUsdtWei: reserve.vUsdtBalance,
                preArmExchangeRate: reserve.exchangeRateStored,
                armJournalKey,
              });
              if (admittedInFence.kind !== "ok") return admittedInFence;
              await lending.settingsStore.put({
                agentId: agent.id,
                ownerAddress: agent.ownerAddress,
                params: request.settingsParams,
                digest,
              });
              return admittedInFence;
            },
          );
          if (admitted.kind !== "ok") {
            throw new ConflictError("The guard row moved during admission; re-sign to arm.");
          }

          // OUTSIDE the fence: the batch, and the `"lending"` money row it opens
          // and settles INSIDE this `act` (R2.1). `ownerMutation` then commits
          // the LOCAL-ONLY `lendingArm` row as it always does, so an UNKNOWN arm
          // is an UNKNOWN `"lending"` row beside a COMMITTED `lendingArm` row.
          const calls = buildLendingArmBatch({
            venue: venueAddresses,
            wallet: agent.walletAddress,
            supplyNativeWei,
            mintUsdtWei,
            currentVUsdtAllowanceWei: reserve.usdtAllowanceToVUsdt,
            deadline: BigInt(nowSec()) + 300n,
          });
          const outcome = await submitLendingBatch(
            { agentStore: deps.agentStore, journal: deps.journal, provider: deps.providerRegistry.get(config.chainId) },
            { agent, decisionId, calls, nativeSpendWei: supplyNativeWei },
          );

          // FIXREVIEW F8 — THE CHARGE FOLLOWS THE SUBMISSION, AS IT DOES IN THE
          // WORKER.
          //
          // P6 moved the worker's `chargeAction` below its submit on the rule
          // that a submission which never reached a relay must not consume a
          // slot; the two owner routes still charged above it, so the same
          // refusal was counted differently depending on which surface made it.
          // The asymmetry was harmless ONLY because `usageSince` filters
          // `kind === "rescue"` — a fact nobody widening that query would
          // think to check. The rule is now the same on all three surfaces:
          // charge a submission that REACHED a relay, and nothing else. A
          // `relay-failed` rollback DID reach one and keeps its row.
          //
          // A throw from `submitLendingBatch` skips the charge for the same
          // reason, and leaves no row to reconcile against.
          if (!(outcome.status === "rolled-back" && outcome.code !== "relay-failed")) {
            await lending.guards.chargeAction({
              ownerAddress: agent.ownerAddress, agentId: agent.id,
              actionId: armJournalKey, kind: "arm", chargedAtMs: nowMs(),
            });
          }

          // R2.18: the arm's effect is a DELTA against the pre-submission read,
          // never `balanceOf > 0` (which is true of a wallet that already held
          // vUSDT) and never `balanceOf >= 0` (which is true of everything).
          let effect: "changed" | "no-effect" | "unverified" = "unverified";
          let idleUsdtWei: string | null = null;
          // AUDIT C-M2: `armBlock` is RECORDED. It was hardcoded `null` in both
          // writers, and `detectOwnerRecovery` refuses to fire on a null one —
          // so §6.2's passkey-recovery observation was unreachable in
          // production and the guard would sit `armed` over an empty reserve
          // forever.
          //
          // FIXREVIEW F7 — AND THE RECORD SAYS WHICH BLOCK IT IS. The relay
          // answers a txHash, not a block, so this route used to store the
          // finalized block of a read taken AFTER the arm — normally BEHIND the
          // block the arm landed in, under a field name that promised the
          // stronger figure. It now reads the transaction back when it can and
          // labels the fallback `post-arm-read`, so nothing downstream can
          // compare the weaker figure to a chain height by accident. Only the
          // null/non-null distinction is consumed today; the label is for the
          // next reader.
          let armBlock: bigint | null = null;
          let armBlockSource: "receipt" | "post-arm-read" | undefined;
          if (outcome.status === "completed") {
            if (
              outcome.txHash !== null
              && lending.readers.readTransactionBlock !== undefined
            ) {
              const landed = await lending.readers.readTransactionBlock(outcome.txHash);
              if (landed !== null) {
                armBlock = landed;
                armBlockSource = "receipt";
              }
            }
            try {
              const after = await lending.readers.readReserve(agent.walletAddress);
              if (armBlock === null) {
                armBlock = after.blockNumber;
                armBlockSource = "post-arm-read";
              }
              const expected =
                ((mintUsdtWei * 10n ** 18n) / (reserve.exchangeRateStored > 0n
                  ? reserve.exchangeRateStored : 10n ** 18n)) * 9_990n / 10_000n;
              effect =
                after.vUsdtBalance - reserve.vUsdtBalance >= expected
                  ? "changed" : "no-effect";
              // RECORDED, not checked: the slippage surplus above `mintUsdtWei`
              // stays idle in B and IS reserve.
              idleUsdtWei = after.usdtBalance.toString(10);
            } catch {
              effect = "unverified";
            }
          }

          const finished = await lending.guards.finishArm(
            outcome.status === "completed"
              ? {
                  ownerAddress: agent.ownerAddress, agentId: agent.id,
                  expectedRowVersion: admitted.record.rowVersion,
                  outcome: "armed", armBlock,
                  ...(armBlockSource === undefined ? {} : { armBlockSource }),
                  armTxHash: outcome.txHash,
                }
              : outcome.status === "held"
                ? {
                    ownerAddress: agent.ownerAddress, agentId: agent.id,
                    expectedRowVersion: admitted.record.rowVersion,
                    outcome: "held", hold: "arm-unknown",
                  }
                : {
                    ownerAddress: agent.ownerAddress, agentId: agent.id,
                    expectedRowVersion: admitted.record.rowVersion,
                    outcome: "closed", closeReason: "arm-rolled-back",
                  },
          );

          return {
            guard: finished.kind === "ok"
              ? lendingGuardView(finished.record)
              : lendingGuardView(admitted.record),
            arm: {
              status: outcome.status,
              code: outcome.code,
              reason: outcome.reason,
              txHash: outcome.txHash,
              effect,
              idleUsdtWei,
              mintUsdtWei: mintUsdtWei.toString(10),
              supplyNativeWei: supplyNativeWei.toString(10),
              reserveNativeWei: reserveNativeWei.toString(10),
              // L12's disclosure: the tier the arm actually used.
              swapFeeTier: lending.venue.swapFeeTier,
            },
            settingsDigest: digest,
            settings: lendingSettingsView(request.settings),
          };
        }),
    );

    /* ---- POST /agents/:id/lending/settings (§4.2) ------------------------ */

    app.post("/agents/:id/lending/settings", (c) =>
      ownerMutation(c, c.req.param("id"), "lendingSettings", "lendingSettings",
        async ({ agent, params }) => {
          const parsed = parseLendingSettingsRequest(params);
          if (!parsed.ok) throw new BadRequestError(parsed.message);
          const guard = await lending.guards.get(agent.ownerAddress, agent.id);
          if (guard === null) throw new NotFoundError();
          // FIXREVIEW F2 — REACHABLE BEFORE THE FIRST ARM.
          //
          // The gate accepted `armed | held` only, so a guard that had never
          // armed (`provisioning-guard`) could not have its settings replaced
          // at all — and P19's own refusal tells the owner to "sign
          // lendingSettings first", naming a route that answered 409. The union
          // of admissible arm digests was therefore frozen at the hire's, and a
          // hire granted on one device could not be armed from another at all.
          //
          // `closed` is accepted for the same reason on the re-arm path (a
          // never-submitted arm closes the row; the settings must be changeable
          // before the owner signs the next arm). `arming | retiring` are NOT:
          // a submission is in flight against the digest the observation was
          // taken under. `retired` is terminal.
          //
          // This route has NO money effect — it writes owner-signed bytes and
          // their digest — so widening it admits no spend, and the arm's own
          // P19 continuation check is what decides whether those bytes may fund
          // anything.
          if (
            guard.status !== "armed"
            && guard.status !== "held"
            && guard.status !== "provisioning-guard"
            && guard.status !== "closed"
          ) {
            throw new ConflictError(
              `Settings can only be replaced while the guard is provisioning, armed, held or closed; it is ${guard.status}.`,
            );
          }
          // §4.2 (SPEC.md:282, :694) — 409 WHILE ANY LENDING JOURNAL ROW IS
          // LIVE, which is PENDING, IN_PROGRESS **or** UNKNOWN.
          //
          // AUDIT B-L10 / FIXREVIEW: this checked UNKNOWN only, which was a
          // deviation from a NORMATIVE spec line carried as an erratum. The
          // erratum is now gone, because the code does what the spec says. The
          // reason the spec says it: a settings write mid-submission changes
          // the digest the observation was taken under while a rescue is in
          // flight against it, and a PENDING rescue is exactly as in-flight as
          // an UNKNOWN one — it simply has not been given up on yet.
          //
          // It reads through the TWO queries the journal already exposes rather
          // than adding a third: `listNonTerminal` is the PENDING/IN_PROGRESS
          // set (all agents, filtered here — the non-terminal set is small by
          // construction, since reconcile drains it every cycle), and
          // `listUnknownForAgent` is the UNKNOWN set. A new per-agent PENDING
          // query would be six hand-maintained sites across two backends plus
          // the fake, for a route an owner signs by hand.
          const [nonTerminal, unknown] = await Promise.all([
            deps.journal.listNonTerminal(),
            deps.journal.listUnknownForAgent(agent.id),
          ]);
          const live = [
            ...nonTerminal.filter((row) => row.agentId === agent.id),
            ...unknown,
          ].filter((row) => row.kind === "lending");
          if (live.length > 0) {
            throw new ConflictError(
              "A lending submission is unresolved; settings cannot be replaced until it settles.",
            );
          }
          if (agent.sessionFacts === null) throw new ConflictError("No granted session.");
          const profile = enforceLendingV1Profile(parsed.value.settings, {
            debtMarkets: guard.debtMarkets,
            usdt: lending.venue.usdt,
            vUsdt: lending.venue.vUsdt,
            vBnb: lending.venue.vBnb,
            grantedReserveCapWei: guard.reserveCapWei,
            grantedCapDayWei: agent.caps?.dailyNativeWei ?? 0n,
            hireBudgetWei: BigInt(agent.sessionFacts.hireSizing?.openNativeBudgetWei ?? "0"),
          });
          if (profile !== null) throw new BadRequestError(profile.message);

          const digest = lendingSettingsDigest(parsed.value.settingsParams);
          await lending.settingsStore.put({
            agentId: agent.id,
            ownerAddress: agent.ownerAddress,
            params: parsed.value.settingsParams,
            digest,
          });
          return {
            settingsDigest: digest,
            settings: lendingSettingsView(parsed.value.settings),
            note:
              "The confirmation counter is invalidated by the digest change: the next "
              + "breach needs two fresh observations one worker interval apart.",
          };
        }),
    );

    /* ---- POST /agents/:id/lending/retire (§6.1, R2.5, R3.1, R3.12) ------- */

    app.post("/agents/:id/lending/retire", (c) =>
      ownerMutation(c, c.req.param("id"), "lendingRetire", "lendingRetire",
        async ({ agent, params }) => {
          const parsed = parseLendingRetireParams(params);
          if (!parsed.ok) throw new BadRequestError(parsed.message);
          const guard = await lending.guards.get(agent.ownerAddress, agent.id);
          if (guard === null) throw new NotFoundError();
          // `retiring` IS accepted (AUDIT B-H1). A pool-short retire parks
          // there and its own refusal says "retire again when the pool
          // refills" — a remedy the gate used to refuse, which made `retiring`
          // a dead end with no owner door: the PHASE3.11 / PHASE3.14 wedge in
          // this enum.
          if (
            guard.status !== "armed"
            && guard.status !== "held"
            && guard.status !== "retiring"
          ) {
            throw new ConflictError(
              `Retire needs an armed, held or retiring guard; it is ${guard.status}.`,
            );
          }
          if (guard.hold === "retire-unknown") {
            throw new ConflictError(
              "A previous retire's outcome is UNKNOWN. Retire is blocked until it is understood; rescues continue on whatever the reserve still holds.",
            );
          }
          if (agent.sessionFacts === null) {
            throw new ConflictError(
              "No granted session. Recover the reserve with your passkey instead — the agent's key cannot block it.",
            );
          }

          const reserve = await lending.readers.readReserve(agent.walletAddress);

          // R3.1: the retire is NOT a rescue, so an unreadable meter is
          // FAIL-CLOSED here — this is the one place the omit-and-report rule
          // does not apply, because submitting a retire into an exhausted cap
          // surfaces as FINDINGS (h)'s silent PENDING rather than a refusal.
          const meter = await lending.readers.readTokenDayMeter({
            walletAddress: agent.walletAddress,
            publicKey: agent.sessionFacts.publicKey,
            token: lending.venue.usdt,
          });
          // AUDIT A-L5: `no-grant` and `other-period` fail closed HERE TOO.
          // The retire is not a rescue, so R3.5's omit-and-report rule does not
          // apply: a session with no rolling-DAY USDT row cannot be retired at
          // all, and submitting into one surfaces as FINDINGS (h)'s silent
          // PENDING rather than as a refusal the owner can act on.
          if (meter.kind !== "day") {
            throw new ConflictError(
              meter.kind === "unreadable"
                ? "transport: the USDT day meter could not be read, and a retire submitted into an exhausted cap surfaces as a silent PENDING rather than a refusal. Try again shortly."
                : "usdt-cap-unreadable: this session holds no rolling-DAY USDT cap, so the retire's approve cannot be sized against one. Recover the reserve with your passkey instead — the agent's key cannot block it.",
            );
          }

          const plan = planLendingRetire(reserve);
          if (plan.empty) {
            throw new BadRequestError(
              "There is nothing to retire: wallet B holds no idle USDT and the pool can redeem nothing.",
            );
          }
          if (plan.poolShort && parsed.value.acceptPartial !== true) {
            // THE REMEDY LEADS. `sanitizeMessage` caps stored refusal prose at
            // ~280 characters, and a remedy past the cap is a remedy nobody
            // receives — the PHASE3.3-A7 lesson, re-learned by PHASE3.13 F12-b.
            throw new BadRequestError(
              "pool-cash-short: retire again when the pool refills, or re-sign with "
              + "acceptPartial to take what it can pay now — the rest stays recoverable with "
              + `your passkey. vUSDT can pay out ${plan.redeemAmountWei} of ${plan.suppliedUsdtWei} `
              + `supplied; ${plan.remainderUsdtWei} would stay on Venus.`,
            );
          }
          if (meter.kind === "day" && meter.remainingWei < plan.swapInWei) {
            // Remedy first, figures after — the same cap this file's other
            // refusals are written against.
            throw new ConflictError(
              "usdt-cap-exhausted: retire once the rolling day rolls forward, and pause the "
              + "agent now so further rescues do not spend the rest of the cap. The retire "
              + `approves ${plan.swapInWei} USDT; ${meter.remainingWei} is left today.`,
            );
          }

          let minOutWei: bigint;
          try {
            const quoted = await lending.readers.quote({
              tokenIn: lending.venue.usdt, tokenOut: lending.venue.wbnb,
              amountInWei: plan.swapInWei,
            });
            if (quoted <= 0n) throw new Error("no quote");
            minOutWei = sagaSwapMinOut(quoted, lending.maxSagaSlippageBps);
          } catch {
            throw new ConflictError(
              "transport: the retire's swap could not be quoted; refusing rather than swapping without a floor.",
            );
          }

          // What a submission that spends NOTHING must put back (B-H1). A
          // retry that was ALREADY `retiring` has no earlier status to restore,
          // so its rollback simply leaves it there — which is now a status the
          // gate accepts and the worker watches.
          // AUDIT B-M1 — THE RETIRE TAKES THE R3.7 CLAIM, under the same fence
          // key the worker uses.
          //
          // Before this, ONLY the worker claimed: the fence serialized the two
          // decisions but nothing stopped the worker from claiming and
          // submitting a rescue in the seconds after a retire's fence closed,
          // so both submissions could be in flight against one reserve — and
          // the loser FAILED. The claim is the mutual exclusion that outlives
          // the fence, because the cooldown stamp is durable.
          //
          // The floor is the OWNER'S OWN `minSecondsBetweenActions`, read from
          // the settings the worker obeys, so the two agree by construction. A
          // retire refused by it is a 409 the owner can retry, never a wedge:
          // the guard is untouched, and §6.2's passkey recovery does not go
          // through this route at all.
          let retireFloorSec = 0;
          const storedSettings =
            await lending.settingsStore.get(agent.ownerAddress, agent.id);
          if (storedSettings !== null) {
            const parsedStored = parseLendingSettingsParams(storedSettings.params);
            if (parsedStored.ok) {
              retireFloorSec = parsedStored.value.minSecondsBetweenActions;
            }
          }
          let restoreTo: { status: "armed" | "held"; hold: LendingHold | null } | null = null;
          let claimedSeq: number | null = null;
          let previousActionAtMs: number | null = null;
          const began = await lending.guards.withLendingFence(
            agent.ownerAddress, agent.id, async (fence) => {
              const fresh = await fence.get();
              if (
                fresh === null
                || (fresh.status !== "armed"
                  && fresh.status !== "held"
                  && fresh.status !== "retiring")
              ) {
                throw new ConflictError("The guard changed status; re-sign to retire.");
              }
              const claim = await fence.claim({
                nowMs: nowMs(), minSecondsBetweenActions: retireFloorSec,
              });
              if (claim.kind !== "claimed") {
                throw new ConflictError(
                  claim.kind === "cooldown"
                    ? `cooldown: a rescue ran ${claim.elapsedSec}s ago and the guard's own `
                      + `${retireFloorSec}s floor keeps two submissions apart. Re-sign to `
                      + "retire once it passes; your passkey can recover the reserve at any time."
                    : "The guard row vanished between the read and the claim; re-sign to retire.",
                );
              }
              claimedSeq = claim.actionSeq;
              previousActionAtMs = fresh.lastActionAtMs;
              restoreTo =
                fresh.status === "retiring"
                  ? null
                  : { status: fresh.status, hold: fresh.hold };
              // The claim WRITES (it moves the stamp and the sequence), so the
              // row version the CAS must assert is the one AFTER it. Re-read
              // inside the same fence rather than assuming `+1`: the CAS is the
              // authority on what it consumed, and an assumed version is how a
              // conditional write quietly becomes an unconditional one.
              const claimed = await fence.get();
              if (claimed === null) {
                throw new ConflictError("The guard row vanished during admission.");
              }
              // FIXREVIEW F6: on the LOCK'S transaction, like the claim above
              // it — an aborting fence must not leave a `retiring` row standing
              // over a claim that rolled back.
              return fence.beginRetire({ expectedRowVersion: claimed.rowVersion });
            },
          );
          // The claim outlives the fence, so a `beginRetire` that lost its CAS
          // must give it back or the next worker cycle is starved by a retire
          // that never started (the AUDIT C-H1 rule, on this route).
          const giveBackRetireClaim = async (): Promise<void> => {
            if (claimedSeq === null) return;
            await lending.guards.restoreClaim({
              ownerAddress: agent.ownerAddress,
              agentId: agent.id,
              expectedActionSeq: claimedSeq,
              previousLastActionAtMs: previousActionAtMs,
            });
          };
          if (began.kind !== "ok") {
            await giveBackRetireClaim();
            throw new ConflictError("The guard row moved during admission; re-sign to retire.");
          }

          const decisionId = lendingOwnerActionDecisionId(
            agent.id, "retire", began.record.rowVersion,
          );
          const calls = buildLendingRetireBatch({
            venue: venueAddresses,
            wallet: agent.walletAddress,
            redeemAmountWei: plan.redeemAmountWei,
            swapInWei: plan.swapInWei,
            minOutWei,
            deadline: BigInt(nowSec()) + 300n,
          });
          const outcome = await submitLendingBatch(
            { agentStore: deps.agentStore, journal: deps.journal, provider: deps.providerRegistry.get(config.chainId) },
            { agent, decisionId, calls, nativeSpendWei: 0n },
          );
          // FIXREVIEW F8: the charge follows the submission here too — the same
          // rule the worker got from P6 and the arm got above. A retire refused
          // before the relay draws no gas and writes no charged row.
          //
          // The `retire-unknown` door reads this row back
          // (`lastActionId(owner, agent, "retire")`), and it still can: the
          // branch that skips the charge is the one where nothing was
          // submitted, so there is no ambiguous retire for it to be about.
          if (!(outcome.status === "rolled-back" && outcome.code !== "relay-failed")) {
            await lending.guards.chargeAction({
              ownerAddress: agent.ownerAddress, agentId: agent.id,
              actionId: `${agent.id}:${decisionId}`, kind: "retire", chargedAtMs: nowMs(),
            });
          }
          let cleared = false;
          let residueUsdtWei: string | null = null;
          if (outcome.status === "completed") {
            try {
              const after = await lending.readers.readReserve(agent.walletAddress);
              // R3.12: the residue is measured on the CURRENT rate when it is
              // readable, so the stored-vs-current gap is not counted as
              // leftover supply — and the bound is RELATIVE, so a large reserve
              // retired perfectly still reaches `retired`.
              const rate = after.exchangeRateCurrent ?? after.exchangeRateStored;
              const suppliedAfter = (after.vUsdtBalance * rate) / 10n ** 18n;
              residueUsdtWei = suppliedAfter.toString(10);
              cleared = retireCleared(
                suppliedAfter, plan.suppliedUsdtWei, LENDING_DUST_USDT_WEI,
              );
            } catch {
              cleared = false;
            }
          }

          // A ROLLED-BACK retire spent NOTHING (AUDIT B-H1): it was refused
          // above the submit, or the relay answered FAILED on an atomic batch.
          // Parking it at `retiring` said "a retire is in flight" about a
          // submission that never happened, and that status had no exit.
          const rolledBack = outcome.status === "rolled-back";
          const restore: { status: "armed" | "held"; hold: LendingHold | null } | null =
            restoreTo;
          const finished = await lending.guards.finishRetire(
            outcome.status === "held"
              ? {
                  ownerAddress: agent.ownerAddress, agentId: agent.id,
                  expectedRowVersion: began.record.rowVersion,
                  outcome: "held", hold: "retire-unknown",
                }
              : rolledBack && restore !== null
                ? {
                    ownerAddress: agent.ownerAddress, agentId: agent.id,
                    expectedRowVersion: began.record.rowVersion,
                    outcome: "rolled-back", restore,
                  }
                : cleared
                  ? {
                      ownerAddress: agent.ownerAddress, agentId: agent.id,
                      expectedRowVersion: began.record.rowVersion, outcome: "retired",
                    }
                  : {
                      ownerAddress: agent.ownerAddress, agentId: agent.id,
                      expectedRowVersion: began.record.rowVersion, outcome: "partial",
                    },
          );

          // A retire refused ABOVE the submit drew no relay gas: its cooldown
          // goes back, so the next rescue is not starved by a retire that never
          // happened (AUDIT C-H1's rule, this route's copy). It runs AFTER
          // `finishRetire` because the restore bumps `row_version`, and that
          // CAS asserts the version the fence handed it.
          if (outcome.status === "rolled-back" && outcome.code !== "relay-failed") {
            await giveBackRetireClaim();
          }

          return {
            guard: finished.kind === "ok"
              ? lendingGuardView(finished.record)
              : lendingGuardView(began.record),
            // HTTP 200 IS NOT "RETIRED". The outcome block is what says whether
            // the reserve came back, and the web must parse it.
            retire: {
              status: outcome.status,
              code: outcome.code,
              reason: outcome.reason,
              txHash: outcome.txHash,
              cleared,
              redeemAmountWei: plan.redeemAmountWei.toString(10),
              swapInWei: plan.swapInWei.toString(10),
              minOutWei: minOutWei.toString(10),
              poolShort: plan.poolShort,
              remainderUsdtWei: plan.remainderUsdtWei.toString(10),
              residueUsdtWei,
            },
          };
        }),
    );

    /* ---- GET /agents/:id/lending/view (§8.3, R2.18) ---------------------- */

    app.get("/agents/:id/lending/view", async (c) => {
      const id = c.req.param("id");
      const auth = await authorizeAccountRead(c, id);
      if (auth.kind !== "ok") return auth.response;
      const agent = await deps.agentStore.getAgent(auth.owner.ownerAddress, id);
      if (agent === null) return fail(c, 404, "not_found");
      const guard = await lending.guards.get(agent.ownerAddress, agent.id);
      if (guard === null) return fail(c, 404, "not_found");

      // ZERO CHAIN READS. The worker writes `lending_snapshots` LAST in every
      // cycle and this route serves it. A stale snapshot renders every account
      // tile as a dash WITH ITS REASON — the view never guesses, and the BFF
      // falls back to `/lending/guardable` for the account half, labelled "read
      // now, not by the agent".
      const [snapshot, settingsRow, rescues] = await Promise.all([
        lending.guards.getSnapshot(agent.ownerAddress, agent.id),
        lending.settingsStore.get(agent.ownerAddress, agent.id),
        lending.guards.listRescues(agent.ownerAddress, agent.id, 50),
      ]);
      const staleAfterMs = 2 * lending.intervalMs;
      const ageMs = snapshot === null ? null : nowMs() - snapshot.observedAtMs;
      const stale = snapshot === null || (ageMs !== null && ageMs > staleAfterMs);
      const parsedSettings =
        settingsRow === null ? null : parseLendingSettingsParams(settingsRow.params);
      const digestTrusted =
        settingsRow !== null
        && lendingSettingsDigest(settingsRow.params).toLowerCase()
          === settingsRow.digest.toLowerCase();

      return c.json({ data: {
        guard: lendingGuardView(guard),
        snapshot: {
          presentAt: snapshot?.observedAtMs ?? null,
          ageMs,
          staleAfterMs,
          stale,
          reason: stale
            ? snapshot === null
              ? "The worker has not reported for this guard yet."
              : `The worker has not reported since ${new Date(snapshot.observedAtMs).toISOString()}.`
            : null,
          workerIntervalMs: lending.intervalMs,
          payload: stale ? null : snapshot?.snapshot ?? null,
        },
        rescues: rescues.map((rescue) => ({
          rescueId: rescue.rescueId,
          market: rescue.market,
          amountWei: rescue.amountWei.toString(10),
          hfBefore: rescue.hfBefore === null ? null : rescue.hfBefore.toString(10),
          hfAfter: rescue.hfAfter === null ? null : rescue.hfAfter.toString(10),
          achievedHf: rescue.achievedHf === null ? null : rescue.achievedHf.toString(10),
          txHash: rescue.txHash,
          effect: rescue.effect,
          partial: rescue.partial,
          conditions: rescue.conditions,
          createdAtMs: rescue.createdAtMs,
        })),
        settings:
          parsedSettings !== null && parsedSettings.ok && digestTrusted
            ? lendingSettingsView(parsedSettings.value)
            : null,
        settingsDigest: digestTrusted ? settingsRow?.digest ?? null : null,
        session: {
          expiresAt: agent.sessionFacts?.expiry ?? null,
          expiring:
            agent.sessionFacts !== null
            && agent.sessionFacts.expiry - nowSec() < VENUS_SESSION_EXPIRING_SECONDS,
        },
        recovery: {
          // The sentence the detail page states next to the session countdown.
          note:
            "Your reserve is recoverable with your passkey at any time; the agent's key "
            + "cannot block it.",
        },
      }, meta: { agentId: agent.id } });
    });
  }

  /** The operator-only global switch. Both routes share every check. */
  async function adminAction(c: Context, mode: "halt" | "resume"): Promise<Response> {
    const expected = config.operatorToken;
    if (expected === "") return fail(c, 401, "unauthorized");
    if (!tokenMatches(c.req.header("x-operator-token") ?? "", expected)) {
      return fail(c, 401, "unauthorized");
    }

    const body = await readJsonBody(c, maxBodyBytes);
    if (body.kind === "error") return body.response;

    const parsed = parseAdminRequest(body.value);
    if (!parsed.ok) return fail(c, 400, "invalid_request", parsed.message);

    if (mode === "halt") {
      await deps.killswitch.halt(parsed.value.reason);
    } else {
      await deps.killswitch.resume();
    }

    // Audit trail: who, when, why. The credential itself is never logged, and
    // the operator-supplied strings go through the same sanitizer as everything
    // else in case one carries a URL or a long hex blob.
    console.log(
      `[admin] action=${mode} actor=${sanitizeMessage(parsed.value.actor)} ` +
        `at=${new Date(nowMs()).toISOString()} ` +
        `reason=${sanitizeMessage(parsed.value.reason ?? "none")}`,
    );

    return c.json({
      data: { halted: mode === "halt", actor: parsed.value.actor },
    });
  }

  /** Options shared by every owner-signature check on this server. */
  function verifyOptions(): {
    now: number;
    expectedChainId: number;
    network?: string;
    envSalt?: string;
    skewSeconds?: number;
    verifier: Verifier;
  } {
    return {
      now: nowSec(),
      expectedChainId: config.chainId,
      ...(config.network === undefined ? {} : { network: config.network }),
      ...(config.envSalt === undefined ? {} : { envSalt: config.envSalt }),
      ...(config.skewSeconds === undefined ? {} : { skewSeconds: config.skewSeconds }),
      verifier,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Free helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Thrown by an owner action whose PARAMS are malformed, after a valid signature. */
class BadRequestError extends Error {}
class HireAgentExistsError extends Error {}
class HireWalletOwnerError extends Error {}
class HireEvidenceError extends Error {}
class TradeCapitalTooSmallError extends Error {
  constructor(readonly minimumWei: bigint) { super("Trade capital is too small."); }
}
class TradeNotExecutableError extends Error {}
class TradeNotReadyError extends Error {}
/** PHASE3.25 R8.1.3/R10.1 — exact sizing evidence survives message clipping. */
/**
 * THE ONE PLACE A 400 IS BUILT FROM A `BadRequestError`, and the ONE producer
 * of `meta.shortfallWei` (PHASE3.25 R10.1, kept whole by AUDIT A-M3).
 *
 * The lending hire needed the same structured figure the owner routes already
 * carried, and copying the six-line ternary would have made TWO metadata
 * producers — which R10.1's own test forbids for the reason it exists: a
 * metadata channel with two authors is a channel nobody can audit by reading
 * one function.
 */
function failBadRequest(c: Context, error: BadRequestError): Response {
  return fail(
    c,
    400,
    "invalid_request",
    error.message,
    ...(error instanceof LpSizingShortfallError
      ? [{ shortfallWei: error.shortfallWei }]
      : []),
  );
}

class LpSizingShortfallError extends BadRequestError {
  readonly shortfallWei: bigint;

  constructor(message: string, shortfallWei: bigint) {
    super(message);
    this.shortfallWei = shortfallWei;
  }
}
class ConflictError extends Error {}

/** PHASE3.25 R6.1 — shared physical shift capacity for all three sizing seams. */
export function shiftNativeSizingTerm(
  settings: LpAutomationSettings,
): { readonly shiftMotionsPerDay: number } | Record<string, never> {
  const shift = settings.grid?.shift;
  if (shift === undefined) return {};
  const spacingCapacity = Math.ceil(1_440 / settings.minMinutesBetweenExits);
  const settlements = Math.min(shift.shiftsPerDay, spacingCapacity);
  return {
    shiftMotionsPerDay: Math.min(
      settlements + gridShiftDriftMotionsPerDay(shift),
      spacingCapacity,
    ),
  };
}

/** PHASE3.25 R2.3 — one ordered refusal ladder for the shift arm's economics. */
export function shiftArmEconomicsRefusal(input: {
  readonly economics: LpGridShiftEconomics;
  readonly minNetEdgeBps: number;
  readonly budgetWei: bigint;
  readonly relayFeePerSubmitWei: bigint;
}): string | null {
  if (input.economics.minBudgetWei === null) {
    return `Grid arm refused: no budget clears this shift ladder's own minNetEdgeBps of ${input.minNetEdgeBps} at a gross edge of ${input.economics.edge.grossEdgeBps} bps. Widening the budget cannot help; the geometry has to change.`;
  }
  if (input.budgetWei < input.economics.minBudgetWei) {
    return `Grid arm refused: this shift ladder needs ${input.economics.minBudgetWei} wei at the `
      + `shipped ${input.relayFeePerSubmitWei} wei/submission pad `
      + `(${input.economics.submissionsPerCycle}/cycle), or `
      + `${(input.economics.minBudgetWei * 388n) / 1_000n} at the measured 38800000000000; `
      + `you signed ${input.budgetWei}. `
      + `Remedy: raise the budget, or recalibrate LP_RELAY_FEE_PER_SUBMIT_WEI.`;
  }
  if (!input.economics.edge.ok) {
    return lpGridNetEdgeRefusal(input.economics.edge, "Grid arm refused");
  }
  return null;
}

function parseRuntimeProfileBinding(
  value: unknown,
): BindableHttpRuntimeProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record["profile"] !== "string") {
    return null;
  }
  return parseBindableHttpRuntimeProfile(record["profile"]);
}

/**
 * A `BadRequestError` that also carries the SERVER'S FINDINGS to archive on the
 * action's own journal row (PHASE3.3-AUDIT A7).
 *
 * Decision 6 promises the row records "each check and its result". On the accept
 * path it does; on the refuse path `ownerMutation` stored only
 * `sanitizeMessage(error.message)`, capped at 300 characters, and the full check
 * list was returned to the caller and then discarded — so the auditable-receipt
 * promise held only for the half that changes state. A refusal is a decision
 * too, and it is the one an operator is most likely to have to argue about.
 *
 * It is a subclass rather than a new branch so the HTTP behaviour is unchanged:
 * still a 400, still `invalid_request`, still the same message.
 */
class OwnerActionRefusal extends BadRequestError {
  readonly evidence: JournalResolutionEvidence;
  constructor(message: string, evidence: JournalResolutionEvidence) {
    super(message);
    this.evidence = evidence;
  }
}

/**
 * Thrown by an owner action that found nothing to act on, where "nothing" must
 * be indistinguishable from "not yours" (PHASE3.3 Rev2 item 9).
 *
 * Carries NO message on purpose: `fail(c, 404, "not_found")` is called without
 * one, so an unknown `decisionId`, one belonging to another agent, and one
 * whose kind this build has no verifier for produce BYTE-IDENTICAL responses.
 * The distinguishable refusals are the ones that fire only after ownership is
 * established, and those are `BadRequestError`s.
 */
class NotFoundError extends Error {}

/**
 * Narrow an unknown throw to one of our typed errors, sanitizing anything that
 * was not already ours.
 *
 * The code it yields is what both money routes report — as `failureCode` on a
 * pre-submission refusal and as `meta.failureCode` on an ambiguous submit — so
 * `SESSION_EXPIRED`, `NOT_ALLOWED` and `INVALID_SESSION_SPEC` survive to the
 * caller intact. That is the direct benefit of classifying by POSITION rather
 * than by type: a dedicated "refusal" error class would have had to pick one
 * code and collapse the distinction (PHASE2.4 R3 item 12).
 */
function asPlaneError(error: unknown, fallback: string): ExecutionPlaneError {
  if (error instanceof ExecutionPlaneError) return error;
  return new ProviderError(
    sanitizeMessage(error instanceof Error ? error.message : fallback),
  );
}

/** Basis-point denominator. */
function requireBinding(
  request: OwnerActionRequest,
  expectedAction: OwnerActionType,
  expectedAgentId: string,
): string | null {
  if (request.signed.action !== expectedAction) return "action";
  if (request.signed.agentId !== expectedAgentId) return "agentId";
  return null;
}

/**
 * A stable bucket key for the pre-auth limiter.
 *
 * `x-forwarded-for` is only trustworthy behind our own proxy, which — this being
 * a private-network service — is the only way a request should ever arrive. When
 * it is absent everything collapses onto one shared bucket, which is the safe
 * direction to fail: it limits more, not less.
 */
function sourceKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return c.req.header("x-real-ip")?.trim() ?? "unknown";
}

/**
 * The BFF-forwarded client address for the lending preview's per-client bucket
 * (R2.11), or `null` when nothing forwarded one.
 *
 * `null` rather than `"unknown"`: a shared fallback key would let one caller
 * behind a proxy that forwards nothing exhaust the bucket for every other such
 * caller, and the GLOBAL bucket already bounds the aggregate.
 */
function clientKey(c: Context): string | null {
  const key = sourceKey(c);
  return key === "unknown" ? null : key;
}

/** The guard row as the arm/retire responses and the detail view report it. */
function lendingGuardView(guard: LendingGuardRecord): Record<string, unknown> {
  return {
    status: guard.status,
    hold: guard.hold,
    guardedAccount: guard.guardedAccount,
    debtMarkets: guard.debtMarkets,
    reserveBps: guard.reserveBps,
    budgetWei: guard.budgetWei.toString(10),
    reserveCapWei: guard.reserveCapWei.toString(10),
    armTxHash: guard.armTxHash,
    armBlock: guard.armBlock === null ? null : guard.armBlock.toString(10),
    armBlockSource: guard.armBlockSource,
    closeReason: guard.closeReason,
    actionSeq: guard.actionSeq,
    lastActionAtMs: guard.lastActionAtMs,
    updatedAtMs: guard.updatedAtMs,
  };
}

/**
 * Project A's finalized reading into the guardable view (§3.2 as amended).
 *
 * PRICES ARE THE PROTOCOL ORACLE'S, never the data plane's: this is the same
 * reconstruction the trigger acts on, so a UI rendering it renders the number
 * the guard would decide against. The one exception the body allowed —
 * `reserveCapFloorWei` from a data-plane quote — is gone: R2.19 pins the pool
 * and the floor is quoted through the plane's own QuoterV2.
 */
function buildGuardableView(input: {
  readonly readingA: import("./venus/types.js").VenusAccountReading;
  readonly account: Address;
  readonly lending: LendingServerDeps;
  readonly supportedMarket: (vToken: Address) => boolean;
}): LendingGuardableView {
  const { readingA } = input;
  const view = venusBasisView(readingA);
  const markets = readingA.markets.map((market) => ({
    vToken: market.vToken,
    symbol: market.vTokenSymbol,
    underlying: market.underlying,
    underlyingDecimals: market.underlyingDecimals,
    supplyUnderlyingWei: (
      (market.vTokenBalance * market.exchangeRateStored) / 10n ** 18n
    ).toString(10),
    borrowWei: (market.borrowCurrent ?? market.borrowStored).toString(10),
    isCollateral: market.collateralMember,
    collateralFactor: market.effectiveCf.toString(10),
    liquidationThreshold: market.effectiveLt.toString(10),
    priceMantissa: market.boundedDebtPrice.toString(10),
  }));
  const debts = readingA.markets
    .filter((market) => (market.borrowCurrent ?? market.borrowStored) > 0n)
    .map((market) => {
      const borrow = market.borrowCurrent ?? market.borrowStored;
      const supported = input.supportedMarket(market.vToken);
      return {
        vToken: market.vToken,
        symbol: market.vTokenSymbol,
        borrowWei: borrow.toString(10),
        debtValueMantissa: ((borrow * market.boundedDebtPrice) / 10n ** 18n).toString(10),
        supported,
        ...(supported ? {} : { reason: "unsupported-in-v1" as const }),
      };
    });

  // The refusal ORDER is the fail-closed order, and each name is the one the
  // worker would report for the same state, so the hire screen and the running
  // guard never disagree about why.
  const zeroPriced = readingA.markets.find(
    (market) =>
      market.spotPrice === 0n
      || market.boundedCollateralPrice === 0n
      || market.boundedDebtPrice === 0n,
  );
  let refusal: LendingGuardableView["refusal"];
  let refusalMarket: Address | undefined;
  if (readingA.snapshotErrorMarket !== null) {
    refusal = "snapshot-error";
    refusalMarket = readingA.snapshotErrorMarket;
  } else if (readingA.accountLiquidity[0] !== 0n || readingA.borrowingPower[0] !== 0n) {
    refusal = "protocol-error";
  } else if (!view.liquidationMatched || !view.borrowingPowerMatched) {
    refusal = "protocol-mismatch";
  } else if (readingA.userPoolId > readingA.lastPoolId) {
    refusal = "emode-unverified";
  } else if (zeroPriced !== undefined) {
    refusal = "oracle-invalid";
    refusalMarket = zeroPriced.vToken;
  } else if (debts.length === 0) {
    refusal = "no-debt";
  } else if (!debts.some((debt) => debt.supported)) {
    refusal = "no-supported-debt";
  }

  return {
    account: input.account,
    blockNumber: readingA.blockNumber.toString(10),
    bases: {
      borrowingPower: {
        hf:
          view.pair.borrowingPower.healthFactor === null
            ? null
            : view.pair.borrowingPower.healthFactor.toString(10),
        matched: view.borrowingPowerMatched,
      },
      liquidation: {
        hf:
          view.pair.liquidationRisk.healthFactor === null
            ? null
            : view.pair.liquidationRisk.healthFactor.toString(10),
        matched: view.liquidationMatched,
      },
    },
    markets,
    debts,
    guardable: refusal === undefined,
    ...(refusal === undefined ? {} : { refusal }),
    ...(refusalMarket === undefined ? {} : { refusalMarket }),
    ...(refusal === "oracle-invalid" || refusal === "protocol-mismatch"
      ? {
          note:
            "Your account entered a market this guard cannot price; the guard is paused "
            + "until it can.",
        }
      : {}),
  };
}

type BodyResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "error"; readonly response: Response };

/**
 * Read and size-cap a JSON body.
 *
 * `content-length` is checked first so an oversized request is refused before it
 * is buffered, and the decoded byte length is checked again afterwards because a
 * chunked request may not declare one.
 */
async function readJsonBody(c: Context, maxBytes: number): Promise<BodyResult> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { kind: "error", response: fail(c, 413, "payload_too_large") };
  }

  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { kind: "error", response: fail(c, 400, "invalid_request") };
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { kind: "error", response: fail(c, 413, "payload_too_large") };
  }
  if (raw.trim() === "") {
    return { kind: "error", response: fail(c, 400, "invalid_request", "Body is required.") };
  }

  try {
    return { kind: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    return {
      kind: "error",
      response: fail(c, 400, "invalid_request", "Body must be valid JSON."),
    };
  }
}

/**
 * The stored outcome of an execute that already ran, mapped back onto a receipt.
 *
 * Derived from the journal row rather than remembered in memory, so it survives a
 * restart and so a retry after a crash gets the same answer as a retry before one.
 */
function storedExecuteOutcome(entry: JournalEntry): {
  data: ExecutionReceipt;
  meta: Record<string, unknown>;
} {
  const status: ExecutionReceipt["status"] =
    entry.state === "COMMITTED"
      ? "CONFIRMED"
      : entry.state === "ROLLED_BACK"
        ? "FAILED"
        : "PENDING";
  return {
    data: {
      status,
      ...(entry.externalRef.txHash === undefined
        ? {}
        : { transactionHash: entry.externalRef.txHash }),
      ...(entry.externalRef.callsId === undefined
        ? {}
        : { callsId: entry.externalRef.callsId }),
    },
    meta: {
      idempotencyKey: entry.idempotencyKey,
      journalState: entry.state,
      replayed: true,
      ...(entry.decisionId === null ? {} : { decisionId: entry.decisionId }),
    },
  };
}

/** The unsigned on-chain revoke a server that holds no owner key cannot perform. */
export type OnChainRevokeInstructions = {
  readonly state: "pending_owner_broadcast";
  readonly chainId: number;
  readonly note: string;
  readonly calls: readonly {
    readonly to: Address;
    readonly data: Hex;
    readonly from: Address;
    readonly note: string;
  }[];
};

/**
 * Build the transactions the OWNER'S CLIENT must sign and broadcast.
 *
 * Stated bluntly because the alternative is a user who thinks they are safe: this
 * server holds no owner key, so it CANNOT revoke on-chain. What it just did is
 * refuse to submit for this agent ever again — real, immediate, and durable
 * across restarts, but binding only on a server that is still asking us for
 * permission. An attacker who has the session key is not asking. Only the
 * on-chain revoke below strips the key's authority, and only the owner can send it.
 *
 * Two legs, mirroring `AltanaProvider.ownerRevokeSessionDirect`:
 *   1. `IthacaAccount.revoke(keyHash)` as a SELF-call from the wallet (the
 *      account's `onlyThis` gate means the sender must be the wallet itself);
 *   2. `AltanaKeyStore.revokeKey(wallet, keyId)` — the leg that actually strips
 *      session authority on Altana.
 */
function buildOnChainRevoke(
  agent: AgentRecord,
  config: ServerConfig,
): OnChainRevokeInstructions | null {
  const facts = agent.sessionFacts;
  if (facts === null) return null;

  const sessionAddress = publicKeyToAddress(facts.publicKey);
  const keyHash = accountKeyHashForAddress(sessionAddress);
  const keyId = keccak256(facts.publicKey);
  const wallet = getAddress(agent.walletAddress);

  return {
    state: "pending_owner_broadcast",
    chainId: config.chainId,
    note:
      "This server has stopped submitting for this agent. It holds no owner " +
      "key and has NOT revoked on-chain. Sign and broadcast the calls below " +
      "from the owner wallet to strip the session key's on-chain authority.",
    calls: [
      {
        to: wallet,
        from: wallet,
        data: encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "revoke",
          args: [keyHash],
        }),
        note:
          "Account-level revoke. A KeyDoesNotExist() revert here is expected on " +
          "Altana, where session authority lives in the KeyStore.",
      },
      {
        to: getAddress(config.keyStore),
        from: wallet,
        data: encodeFunctionData({
          abi: KEYSTORE_ABI,
          functionName: "revokeKey",
          args: [wallet, keyId],
        }),
        note: "KeyStore revoke. This is the leg that removes session authority.",
      },
    ],
  };
}
