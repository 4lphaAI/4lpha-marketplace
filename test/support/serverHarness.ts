/**
 * Offline harness for the HTTP layer.
 *
 * Everything the server touches is a double: memory stores, a fake wallet
 * provider that records what it was asked to submit, a fake data plane that
 * records every URL it was given, and a clock the test moves by hand. Nothing
 * here opens a socket or a database connection, so the whole API surface —
 * including the money path — is exercised deterministically.
 *
 * Owner signatures are REAL: they are produced locally with viem against
 * `buildOwnerActionDomain`, the same constructor the verifier uses. That is the
 * point — a test that stubbed the verifier would prove nothing about the thing
 * most likely to break.
 */
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { AsyncLocalStorage } from "node:async_hooks";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  OWNER_ACTION_TYPES,
  buildOwnerActionDomain,
  resolveDomainSalt,
  type OwnerActionStruct,
  type OwnerActionType,
} from "../../src/auth/ownerAuth.js";
import { paramsHash } from "../../src/auth/canonical.js";
import {
  createRuntimeAssertionClaims,
  encodeRuntimeAssertion,
  resolveRuntimeAuthConfig,
  runtimeRequestHash,
  type HttpRuntimeProfile,
} from "../../src/auth/runtimeAuth.js";
import { MemoryAgentStore, type AgentStore, type SessionFacts } from "../../src/store/agents.js";
import { MemoryExecutionJournal, type ExecutionJournal } from "../../src/store/journal.js";
import { MemoryNonceStore, type NonceStore } from "../../src/store/nonces.js";
import {
  MemoryRuntimeReplayStore,
  type RuntimeReplayStore,
} from "../../src/store/runtimeReplays.js";
import { MemoryKillSwitch, type KillSwitch } from "../../src/killswitch/killswitch.js";
import {
  NotImplementedError,
  type AgentWalletRef,
  type AwaitExecutionParams,
  type ExecuteViaSessionParams,
  type ExecutionReceipt,
  type FlapTokenState,
  type FourMemeQuote,
  type GetBalanceParams,
  type GetTokenBalanceParams,
  type GrantSessionParams,
  type IsSessionActiveParams,
  type OwnerRecoverParams,
  type OwnerRecoverTokensParams,
  type OwnerRevokeSessionParams,
  type OwnerRevokeSessionResult,
  type NativeDayMeterReading,
  type NativeDayMeterParams,
  type PreflightExecuteParams,
  type ProviderRegistry,
  type ReadFlapTokenStateParams,
  type ReadFourMemeQuoteParams,
  type CanSessionSellTokenParams,
  type ResolveOwnerWalletParams,
  type RestoreSessionParams,
  type RevokeSessionParams,
  type SessionRef,
  type SessionSpec,
  type WalletProvider,
} from "../../src/core/types.js";
import { createServer, type BillingOwnerServerDeps, type HireServerDeps, type LendingServerDeps, type LpServerDeps, type ServerConfig, type TradeAgentServerDeps, type VenusServerDeps } from "../../src/server.js";
import type { KeyStoreReader } from "../../src/account/keyStoreReader.js";
import { MAX_CALLS_PER_EXECUTE } from "../../src/wallet/altana.js";
import { parseExecuteRequest, parseTradeRequest } from "../../src/http/wire.js";
import type {
  DataPlaneClient,
  DataPlaneHealth,
  VenusReadResult,
  VenusTrackingResult,
} from "../../src/clients/dataPlane.js";
import type { VenueConfig } from "../../src/ops/venues.js";
import type { TradeRuntimeConfig } from "../../src/ops/config.js";
import { createNoFeePolicy } from "../../src/ops/fees.js";
import type { PortoStagedLpSubmit } from "../../src/lp/preparedIntent.js";

export const CHAIN_ID = 97;
export const NETWORK = "testnet";
export const EXEC_TOKEN = "exec-token-value";
export const OPERATOR_TOKEN = "operator-token-value";
export const KEY_STORE = getAddress("0x00000000000000000000000000000000000000ff");

/** Unix SECONDS the frozen clock starts at. */
export const NOW_SEC = 1_900_000_000;
export const RUNTIME_ENV_SALT = "offline-harness-runtime";
export const RUNTIME_ISSUER = "offline-test-runtime";
export const RUNTIME_KEY_ID = "test-ed25519-1";

const RUNTIME_KEY_PAIR = generateKeyPairSync("ed25519");
const RUNTIME_PUBLIC_KEY_RAW = (
  RUNTIME_KEY_PAIR.publicKey.export({ format: "der", type: "spki" }) as Buffer
).subarray(-32);

export const OWNER_PK = `0x${"11".repeat(32)}` as Hex;
export const OTHER_OWNER_PK = `0x${"22".repeat(32)}` as Hex;
/**
 * The agent's session key. A KNOWN, distinctive value: the secret-egress test
 * seeds this and then asserts the string appears in no response body and no log
 * line anywhere in the API.
 */
export const SESSION_KEY = `0x${"7d".repeat(32)}` as Hex;

export const ownerAccount = privateKeyToAccount(OWNER_PK);
export const otherOwnerAccount = privateKeyToAccount(OTHER_OWNER_PK);

export const AGENT_ID = "agent-1";
export const OTHER_AGENT_ID = "agent-2";
export const TARGET = getAddress("0x000000000000000000000000000000000000dEaD");

/* -------------------------------------------------------------------------- */
/* Fake wallet provider                                                       */
/* -------------------------------------------------------------------------- */

/** Records what `executeViaSession` was actually handed, verbatim. */
export class FakeWalletProvider implements WalletProvider {
  readonly executeCalls: ExecuteViaSessionParams[] = [];
  readonly restoreCalls: RestoreSessionParams[] = [];
  /** Next receipt to return. Replace per test. */
  nextReceipt: ExecutionReceipt = {
    status: "CONFIRMED",
    callsId: `0x${"c1".repeat(32)}`,
    transactionHash: `0x${"7a".repeat(32)}`,
  };
  /** When set, `executeViaSession` throws this instead of returning. */
  nextError: Error | null = null;
  /**
   * When set, `executeViaSession` awaits this before returning — the test's
   * handle on the in-flight window, for races that need a submit held open
   * while a concurrent request runs.
   */
  holdExecution: Promise<void> | null = null;
  /** Every `readFourMemeQuote` this provider was asked for, verbatim. */
  readonly fourMemeReads: ReadFourMemeQuoteParams[] = [];
  /**
   * Merged onto the computed quote. A test that wants a V1 token, a graduated
   * curve, or a hostile `msgValueWei` sets exactly that field and leaves the
   * rest sized off the request, so the ordinary cases stay realistic.
   */
  fourMemeQuoteOverrides: Partial<FourMemeQuote> = {};
  /** When set, `readFourMemeQuote` throws this — the RPC-failure path. */
  fourMemeQuoteError: Error | null = null;

  /**
   * Every pre-flight this provider was asked for, and the knob that makes one
   * REFUSE (PHASE2.4 R3).
   *
   * Separate from `nextError` on purpose, because the two are the whole point of
   * the positional split: a `preflightError` provably never submitted and rolls
   * the row back, while a `nextError` from the submit is ambiguous and is held
   * as UNKNOWN. A test that wants one must not be able to get the other by
   * accident.
   */
  preflightError: Error | null = null;
  readonly preflightCalls: PreflightExecuteParams[] = [];

  /**
   * PHASE2.5 F1. The account's own daily NATIVE meter.
   *
   * `undefined` is the DEFAULT and answers `other-period` — today unmetered,
   * nothing gated — so every pre-2.5 fixture keeps its exact behaviour and the
   * gate is only exercised by tests that opt in. A provider that implements it
   * and THROWS is a different thing (an outage) and is fail-closed on the buy
   * side; a test reaches that with `nativeDayMeterError`.
   *
   * PHASE2.5-AUDIT A6: the "no day row" answer is no longer one value. A test
   * that means "this key has no native grant AT ALL" — which FINDINGS (h) says
   * cannot trade — sets `{ kind: "no-native-grant", grantedTokenCount: n }`
   * explicitly rather than getting it by default.
   */
  nativeDayMeterResult: NativeDayMeterReading | undefined = undefined;
  nativeDayMeterError: Error | null = null;
  readonly nativeDayMeterCalls: NativeDayMeterParams[] = [];

  async preflightExecute(params: PreflightExecuteParams): Promise<void> {
    this.preflightCalls.push(params);
    if (this.preflightError !== null) throw this.preflightError;
  }

  async nativeDayMeter(params: NativeDayMeterParams): Promise<NativeDayMeterReading> {
    this.nativeDayMeterCalls.push(params);
    if (this.nativeDayMeterError !== null) throw this.nativeDayMeterError;
    return (
      this.nativeDayMeterResult ?? { kind: "other-period", grantedTokenCount: 0 }
    );
  }

  restoreSession(params: RestoreSessionParams): SessionRef {
    this.restoreCalls.push(params);
    return {
      walletAddress: params.walletAddress,
      chainId: CHAIN_ID,
      publicKey: params.publicKey,
      spec: params.spec,
      handle: { fake: true },
    };
  }

  async executeViaSession(
    params: ExecuteViaSessionParams,
  ): Promise<ExecutionReceipt> {
    this.executeCalls.push(params);
    if (this.holdExecution !== null) await this.holdExecution;
    if (this.nextError !== null) throw this.nextError;
    return this.nextReceipt;
  }

  async submitPreparedLp(params: PortoStagedLpSubmit): Promise<ExecutionReceipt> {
    // Test-only public-boundary double: it preserves prepare -> bind -> send
    // ordering without pretending to validate Porto's production quote shape.
    const preparedHandle = Object.freeze({});
    const canonicalIdentity = JSON.stringify({
      scheme: "fake-porto-prepared-v1",
      executionDataHash: params.expectedExecutionDataHash,
    });
    const identityHash = keccak256(stringToBytes(canonicalIdentity));
    const preparedDigest = `0x${"dd".repeat(32)}` as Hex;
    const request = {
      journalIdempotencyKey: params.journalIdempotencyKey,
      canonicalIdentity,
      identityHash,
      expectedBindingVersion: params.expectedBindingVersion,
      preparedHandle,
      preparedDigest,
    } as const;
    const token = await params.bind(request);
    if (token.preparedHandle !== preparedHandle) {
      throw new Error("test prepared binding token substituted the prepared object");
    }
    return this.executeViaSession({
      session: {
        walletAddress: params.walletAddress,
        chainId: CHAIN_ID,
        publicKey: params.persistedSession.publicKey,
        spec: params.persistedSession.spec,
        handle: { fake: true },
      },
      calls: params.calls,
      bypassLocalPolicyCheck: false,
    });
  }

  async awaitExecution(_params: AwaitExecutionParams): Promise<ExecutionReceipt> {
    return { status: "PENDING" };
  }

  async isSessionActive(_params: IsSessionActiveParams): Promise<boolean> {
    return true;
  }

  async readFourMemeQuote(
    params: ReadFourMemeQuoteParams,
  ): Promise<FourMemeQuote> {
    this.fourMemeReads.push(params);
    if (this.fourMemeQuoteError !== null) throw this.fourMemeQuoteError;
    return { ...liveFourMemeQuote(params), ...this.fourMemeQuoteOverrides };
  }

  /** Every `readFlapTokenState` this provider was asked for, verbatim. */
  readonly flapReads: ReadFlapTokenStateParams[] = [];
  /**
   * Merged onto the default flap state. A test that wants a graduated token, an
   * ERC-20-quoted curve or an extension token sets exactly that field and
   * leaves the rest as a live Tradable token reads.
   */
  flapStateOverrides: Partial<FlapTokenState> = {};
  /** When set, `readFlapTokenState` throws — the RPC-failure / non-flap path. */
  flapStateError: Error | null = null;

  async readFlapTokenState(
    params: ReadFlapTokenStateParams,
  ): Promise<FlapTokenState> {
    this.flapReads.push(params);
    if (this.flapStateError !== null) throw this.flapStateError;
    return { ...liveFlapTokenState(), ...this.flapStateOverrides };
  }

  /**
   * Tokens the ACCOUNT will actually let this session SELL — both halves, the
   * allowlist entry and the spend limit. The owner may widen this after the
   * grant, so it is not the same set as the persisted spec's.
   * Lowercased addresses; tests push into this to simulate a post-grant
   * `setSpendLimit`.
   */
  readonly chainSellableTokens = new Set<string>();
  /**
   * Tokens carrying a spend LIMIT and no `approve` allowlist entry — the half
   * grant. They are not sellable, and exist as their own knob so a test can
   * state which half is missing rather than just omitting the token.
   */
  readonly chainCappedNotSellableTokens = new Set<string>();
  /** When set, the chain read throws — the route must fall back, not fail open. */
  spendCapReadError: Error | null = null;
  readonly spendCapReads: CanSessionSellTokenParams[] = [];

  async canSessionSellToken(
    params: CanSessionSellTokenParams,
  ): Promise<boolean> {
    this.spendCapReads.push(params);
    if (this.spendCapReadError !== null) throw this.spendCapReadError;
    const token = params.token.toLowerCase();
    if (this.chainCappedNotSellableTokens.has(token)) return false;
    return this.chainSellableTokens.has(token);
  }

  async resolveOwnerWallet(
    _params: ResolveOwnerWalletParams,
  ): Promise<AgentWalletRef> {
    throw new NotImplementedError("not used in these tests");
  }
  async grantSession(_params: GrantSessionParams): Promise<SessionRef> {
    throw new NotImplementedError("not used in these tests");
  }
  async revokeSession(_params: RevokeSessionParams): Promise<ExecutionReceipt> {
    throw new NotImplementedError("not used in these tests");
  }
  async ownerRevokeSession(
    _params: OwnerRevokeSessionParams,
  ): Promise<OwnerRevokeSessionResult> {
    throw new NotImplementedError("not used in these tests");
  }
  async getBalance(_params: GetBalanceParams): Promise<bigint> {
    throw new NotImplementedError("not used in these tests");
  }
  /**
   * ERC-20 balances the wallet is holding, keyed by lowercased token address.
   *
   * PHASE3.3's inputs-still-present check reads these, and the whole point of
   * that check is that it is only DISCRIMINATING when nothing else could have
   * put the token there — so a test states the balance explicitly. An
   * unseeded token reads `0n`, which is the fail-closed direction: a missing
   * leg refuses.
   */
  readonly tokenBalances = new Map<string, bigint>();
  readonly tokenBalanceReads: GetTokenBalanceParams[] = [];
  /** When set, `getTokenBalance` throws — the RPC-failure path. */
  tokenBalanceError: Error | null = null;

  async getTokenBalance(params: GetTokenBalanceParams): Promise<bigint> {
    this.tokenBalanceReads.push(params);
    if (this.tokenBalanceError !== null) throw this.tokenBalanceError;
    return this.tokenBalances.get(params.token.toLowerCase()) ?? 0n;
  }
  async ownerRecoverNative(
    _params: OwnerRecoverParams,
  ): Promise<ExecutionReceipt> {
    throw new NotImplementedError("not used in these tests");
  }
  async ownerRecoverTokens(
    _params: OwnerRecoverTokensParams,
  ): Promise<readonly ExecutionReceipt[]> {
    throw new NotImplementedError("not used in these tests");
  }
}

/**
 * Records every URL a data-plane call would have hit.
 *
 * There is deliberately NO `fourmeme` method here, and its absence is now an
 * assertion in its own right: Four.Meme quotes are chain state and travel over
 * the provider's pinned RPC, so a route that tried to ask the data plane for
 * one would not compile.
 */
export class FakeDataPlane implements DataPlaneClient {
  readonly requested: string[] = [];
  /** Payload `security()` returns. `null` makes the scan gate fail closed. */
  nextSecurity: unknown = null;
  /** When set, the matching read throws instead of returning. */
  securityError: Error | null = null;
  /** Payload `lpRankedPools()` returns. `null` models the 404 / missing seam. */
  nextRankedPools: unknown = null;
  /** When set, `lpRankedPools()` throws — the unreachable-data-plane path. */
  rankedPoolsError: Error | null = null;
  // MARKETPLACE-LP-AGENT BC4: the data plane has NO brain seam any more —
  // `lpBrainProposal` left the client interface, so the fake carries no
  // `nextBrainProposal` / `brainRequests`. A test that wants to prove the HTTP
  // plane never talks to a brain asserts on `requested` (no `lp/brain/*` path).

  async health(): Promise<DataPlaneHealth | null> {
    this.requested.push("health");
    return { ok: true, uptimeSec: 1 };
  }
  async token(address: string): Promise<unknown | null> {
    this.requested.push(`tokens/${address}`);
    return null;
  }
  async security(address: string): Promise<unknown | null> {
    this.requested.push(`security/${address}`);
    if (this.securityError !== null) throw this.securityError;
    return this.nextSecurity;
  }
  async lpRankedPools(
    discoveryToken: string,
    orderBy: "lpFeeApr24h" | "volume24hUsd",
  ): Promise<unknown | null> {
    this.requested.push(
      `pools/top?token=${encodeURIComponent(discoveryToken.toLowerCase())}` +
        `&orderBy=${orderBy}&aprField=lpFeeApr24h&limit=500`,
    );
    if (this.rankedPoolsError !== null) throw this.rankedPoolsError;
    const value = this.nextRankedPools;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    // The pre-3.10 auditor fixtures deliberately remain immutable. Adapt their
    // old never-deployed shape at the fake boundary so those adversarial route
    // assertions keep exercising the route through today's live wire contract.
    if ("data" in record || "meta" in record) return value;
    const asOfMs = record["asOfMs"];
    const pools = record["pools"];
    if (!Number.isSafeInteger(asOfMs) || !Array.isArray(pools)) return value;
    const data = pools.map((pool): unknown => {
      if (typeof pool !== "object" || pool === null || Array.isArray(pool)) {
        return pool;
      }
      const row = pool as Record<string, unknown>;
      const tvl = Number(row["tvlQuoteWei"]);
      const volume = Number(row["volume24hQuoteWei"]);
      const fee = row["fee"];
      const lpFeeApr24h =
        Number.isFinite(tvl) &&
        tvl > 0 &&
        Number.isFinite(volume) &&
        typeof fee === "number"
          ? (volume * fee * 365 * 100) / (1_000_000 * tvl)
          : null;
      return {
        protocol: "v3",
        source: "pancake",
        pool: row["pool"],
        token0: row["token0"],
        token1: row["token1"],
        fee,
        tvlUsd: tvl,
        volume24hUsd: volume,
        lpFeeApr24h,
        aprSources: ["lpFee"],
        asOf: asOfMs,
      };
    });
    return {
      data,
      meta: {
        asOf: asOfMs,
        source: "pancake",
        total: data.length,
        matched: data.length,
        returned: data.length,
        cap: 500,
        ingestOrder: "tvlUSD",
      },
    };
  }
  /* ---- PHASE4 Venus (advisory reads + the tracking lifecycle) ----------- */

  /** Answer `venusAccount()` gives. Default `untracked` — the honest default. */
  nextVenusAccount: VenusReadResult = { kind: "untracked" };
  nextVenusRewards: VenusReadResult = { kind: "untracked" };
  nextVenusMarkets: VenusReadResult = { kind: "untracked" };
  /** Answer both tracking mutations give. */
  nextVenusTracking: VenusTrackingResult = { kind: "ok" };
  /** When set, the tracking mutations throw — the outage path R3.9 tolerates. */
  venusTrackingError: Error | null = null;

  async venusAccount(owner: string): Promise<VenusReadResult> {
    this.requested.push(`venus/core/accounts/${owner.toLowerCase()}`);
    return this.nextVenusAccount;
  }
  async venusRewards(owner: string): Promise<VenusReadResult> {
    this.requested.push(`venus/core/rewards/${owner.toLowerCase()}`);
    return this.nextVenusRewards;
  }
  async venusMarkets(): Promise<VenusReadResult> {
    this.requested.push("venus/core/markets");
    return this.nextVenusMarkets;
  }
  async venusTrackOwner(
    owner: string,
    agentId: string,
  ): Promise<VenusTrackingResult> {
    this.requested.push(
      `PUT internal/venus/core/tracked-owners/${owner.toLowerCase()}/${agentId}`,
    );
    if (this.venusTrackingError !== null) throw this.venusTrackingError;
    return this.nextVenusTracking;
  }
  async venusUntrackOwner(
    owner: string,
    agentId: string,
  ): Promise<VenusTrackingResult> {
    this.requested.push(
      `DELETE internal/venus/core/tracked-owners/${owner.toLowerCase()}/${agentId}`,
    );
    if (this.venusTrackingError !== null) throw this.venusTrackingError;
    return this.nextVenusTracking;
  }
}

/* -------------------------------------------------------------------------- */
/* Trade fixtures                                                             */
/* -------------------------------------------------------------------------- */

/** Venue addresses the trade tests run against. Distinctive, not real. */
export const ROUTER = getAddress("0x1111111111111111111111111111111111111111");
export const WBNB = getAddress("0x2222222222222222222222222222222222222222");
export const MANAGER = getAddress("0x3333333333333333333333333333333333333333");
export const TREASURY = getAddress("0x4444444444444444444444444444444444444444");
export const TOKEN = getAddress("0x5555555555555555555555555555555555555555");
export const HELPER = getAddress("0x6666666666666666666666666666666666666666");
/** The V3 SwapRouter (PHASE2.2). Distinct from `ROUTER`, which is the V2 one. */
export const ROUTER_V3 = getAddress("0x7777777777777777777777777777777777777777");
/** An ordinary intermediate token a caller may route through. */
export const HOP = getAddress("0x8888888888888888888888888888888888888888");
/** A second one, so a two-hop route can be told apart from a reversed one. */
export const HOP_2 = getAddress("0x9999999999999999999999999999999999999999");

export const TEST_VENUES: VenueConfig = {
  chainId: CHAIN_ID,
  pancakeRouterV2: ROUTER,
  pancakeRouterV3: ROUTER_V3,
  wbnb: WBNB,
  fourMemeTokenManager: MANAGER,
  fourMemeHelper: HELPER,
};

/** A security payload every required field of which says "safe". */
export function safeSecurityPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    riskLevel: "ok",
    flags: [],
    scannedAt: NOW_SEC * 1000,
    source: "onchainos+gmgn",
    ...overrides,
  };
}

/** A payload carrying a fatal, sellability-defeating flag. */
export function honeypotSecurityPayload(): Record<string, unknown> {
  return safeSecurityPayload({ riskLevel: "danger", flags: ["honeypot"] });
}

/**
 * What the real helper would answer for a live V2 token, sized off the request.
 *
 * Modelled on the mainnet reading taken 2026-08-11: the venue fee is 100 bps,
 * charged ON TOP of `funds`, so `amountMsgValue > amountFunds`. Deriving it
 * from `params` rather than fixing constants is what lets every existing test's
 * amount keep working while the route's bounds are checked against a realistic
 * shape.
 */
export function liveFourMemeQuote(params: ReadFourMemeQuoteParams): FourMemeQuote {
  const base = {
    version: 2,
    tokenManager: MANAGER,
    quoteToken: null,
    liquidityAdded: false,
  } as const;
  if (params.side === "buy") {
    return {
      ...base,
      fundsWei: params.amountWei,
      msgValueWei: params.amountWei + params.amountWei / 100n,
      estimatedOutWei: params.amountWei * 2n,
      approvalWei: 0n,
    };
  }
  return { ...base, estimatedFundsOutWei: params.amountWei / 2n };
}

/**
 * What the real Portal answers for a live, tradable, native-quoted curve token.
 *
 * Modelled on the mainnet reading of 0xDd9B…7777 taken 2026-08-12: status 1,
 * quote 0x0, no extension, and a circulating supply comfortably below the DEX
 * threshold. Fixed rather than derived from the request, because none of these
 * fields depends on the trade size.
 */
export function liveFlapTokenState(): FlapTokenState {
  return {
    status: 1,
    quoteToken: null,
    nativeToQuoteSwapEnabled: false,
    extensionId: `0x${"00".repeat(32)}`,
    dexSupplyThresh: 800_000_000n * 10n ** 18n,
    circulatingSupply: 449_155_977n * 10n ** 18n,
  };
}

/** A trade config with venues wired and no fee. Override per test. */
export function tradeConfig(
  overrides: Partial<TradeRuntimeConfig> = {},
): TradeRuntimeConfig {
  return {
    venues: TEST_VENUES,
    feePolicy: createNoFeePolicy(),
    scanTtlSec: 300,
    scanRequireVerdict: false,
    // Matches the production default deliberately: a harness that diverges
    // from what ships is a harness that can hide a regression in what ships.
    // Tests that exercise refusal opt into `block` explicitly.
    scanMode: "report",
    maxSlippageBps: 500,
    deadlineSec: 120,
    maxVenueFeeBps: 300,
    ...overrides,
  };
}

/** A trade body with sane defaults. Override per test. */
export function tradeBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decisionId: "d-trade-1",
    venue: "pancake",
    side: "buy",
    token: TOKEN,
    amountWei: "1000000000000000000",
    minOutWei: "990",
    quotedOutWei: "1000",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

export type Harness = {
  readonly app: ReturnType<typeof createServer>;
  readonly agentStore: AgentStore;
  readonly journal: ExecutionJournal;
  readonly nonceStore: NonceStore;
  readonly killswitch: KillSwitch;
  readonly provider: FakeWalletProvider;
  readonly dataPlane: FakeDataPlane;
  readonly runtimePrivateKey: KeyObject;
  readonly runtimeIssuer: string;
  readonly runtimeAudience: string;
  readonly runtimeKeyId: string;
  readonly defaultHttpRuntimeProfile: HttpRuntimeProfile;
  /**
   * Compatibility seam for pre-Phase-1.6 tests which used one default fixture
   * for both mutually exclusive money routes. Explicit profile tests never use
   * it; the request context exposes only the profile required by that route.
   */
  readonly legacyRuntimeProfileContext?: AsyncLocalStorage<HttpRuntimeProfile>;
  /** Move the frozen clock. Milliseconds. */
  advance(ms: number): void;
  nowSec(): number;
};

/**
 * The seeded agent's session.
 *
 * PHASE2.3: `TOKEN` — the token `tradeBody` trades by default — carries a
 * TARGET-BOUND approve rule AND a per-token spend cap, exactly the pair
 * `tradeSessionSpec` now emits per token. The cap is what the trade route reads
 * to enforce `buy => sellable` (R1); without it every buy in the suite would be
 * a 400 and the pipeline below it would go untested. The cap's magnitude is the
 * template's default gate (`2^160`), not a budget — the budget is the native
 * cap above it.
 */
export function sessionSpec(expiresAt: number): SessionSpec {
  return {
    allowedCalls: [
      { to: TARGET },
      { to: TOKEN, selector: "approve(address,uint256)" },
    ],
    spendCaps: [
      { limit: 10n ** 18n, period: "day" },
      { limit: 2n ** 160n, period: "day", token: TOKEN },
    ],
    expiresAt,
  };
}

export function sessionFacts(expiresAt: number): SessionFacts {
  return {
    spec: sessionSpec(expiresAt),
    permissions: { calls: [], spend: [] },
    // A well-formed uncompressed SEC1 key, so the revoke route can derive an
    // address from it the same way production does.
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: expiresAt,
  };
}

export type HarnessOptions = {
  readonly config?: Partial<ServerConfig>;
  /** Durable-store seam for backend-parity HTTP tests. */
  readonly agentStore?: AgentStore;
  /** Durable journal seam for backend-parity HTTP tests. */
  readonly journal?: ExecutionJournal;
  /** Seed the default agent. Defaults to true. */
  readonly seedAgent?: boolean;
  /** Profile for both seeded agents. Defaults to the ordinary trade product. */
  readonly httpRuntimeProfile?: HttpRuntimeProfile;
  readonly runtimeReplayStore?: RuntimeReplayStore;
  /** Override the replay store for owner-action concurrency tests. */
  readonly nonceStore?: NonceStore;
  /**
   * Build the server with NO `trade` config at all, the way an LP-only or
   * read-only deployment would.
   *
   * A separate flag rather than `config: { trade: undefined }` because
   * `exactOptionalPropertyTypes` makes that unrepresentable — and the case
   * matters (PHASE2.5-FIXREVIEW F2): `/trade` is registered unconditionally, so
   * "a server without the field cannot execute a trade" is an implication worth
   * testing rather than asserting.
   */
  readonly omitTrade?: boolean;
  /**
   * The raw-execute gate. `"unset"` OMITS the key entirely, so `createServer`'s
   * own default is what answers — which is the thing worth testing, since a
   * deployment that never heard of the flag must get the closed behaviour.
   */
  readonly executeRaw?: boolean | "unset";
  /**
   * LP route deps (PHASE3). Omitted, the LP paths answer 404 — the production
   * default, and itself an assertion the LP suite makes.
   */
  readonly lp?: LpServerDeps;
  /**
   * Venus route deps (PHASE4). Omitted, the Venus paths answer 404 — the
   * production default when VENUS_ENABLED is unset, and the A1 regression
   * class: "enabled" and "reachable" must be the same word.
   */
  readonly venus?: VenusServerDeps;
  /** Lending routes. Omitted means every `/lending/*` path answers 404. */
  readonly lending?: LendingServerDeps;
  /** Phase 5 owner billing routes. Omitted means exact 404. */
  readonly billingOwner?: BillingOwnerServerDeps;
  readonly hire?: HireServerDeps;
  readonly tradeAgent?: TradeAgentServerDeps;
  /**
   * Preserve the injected LP reader capability set exactly. Defaults false for
   * legacy shared fixtures generally: before 3.9 they supplied one frozen,
   * deterministic `blockNumber` snapshot and had no separately-named finalized
   * seam. Every new capability-boundary regression must set this true;
   * production never uses this test harness or receives the compatibility alias.
   */
  readonly strictLpReaderCapabilities?: boolean;
  /**
   * The Altana KeyStore seam the declared-wallet proof reads through. Omitted,
   * every declared entry reports `passkeyVerified: "unreadable"` — the
   * unconfigured-deployment answer, and itself worth asserting.
   */
  readonly keyStoreReader?: KeyStoreReader;
};

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  let nowMs = NOW_SEC * 1000;
  const now = (): number => nowMs;

  const storedAgentStore = options.agentStore ?? new MemoryAgentStore(null, now);
  const legacyRuntimeProfileContext =
    options.agentStore === undefined &&
    options.httpRuntimeProfile === undefined &&
    options.executeRaw !== true
      ? new AsyncLocalStorage<HttpRuntimeProfile>()
      : undefined;
  const agentStore: AgentStore =
    legacyRuntimeProfileContext === undefined
      ? storedAgentStore
      : new Proxy(storedAgentStore, {
          get(target, property, receiver): unknown {
            if (property === "getAgentById") {
              return async (id: string) => {
                const record = await target.getAgentById(id);
                const profile = legacyRuntimeProfileContext.getStore();
                return record === null || profile === undefined
                  ? record
                  : { ...record, httpRuntimeProfile: profile };
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
  const journal = options.journal ?? new MemoryExecutionJournal(now);
  const nonceStore = options.nonceStore ?? new MemoryNonceStore();
  const killswitch = new MemoryKillSwitch(now);
  const provider = new FakeWalletProvider();
  const dataPlane = new FakeDataPlane();
  const runtimeReplayStore = options.runtimeReplayStore ?? new MemoryRuntimeReplayStore();

  const providerChainId = options.config?.chainId ?? CHAIN_ID;
  const providerRegistry: ProviderRegistry = {
    get(chainId: number): WalletProvider {
      if (chainId !== providerChainId) throw new Error(`no provider for chain ${chainId}`);
      return provider;
    },
  };

  if (options.seedAgent !== false) {
    await agentStore.createAgent({
      id: AGENT_ID,
      ownerAddress: ownerAccount.address,
      walletAddress: ownerAccount.address,
      custodyModel: "self-eoa",
      sessionFacts: sessionFacts(NOW_SEC + 3_600),
      status: "armed",
      httpRuntimeProfile:
        options.httpRuntimeProfile ?? (options.executeRaw === true ? "raw-v1" : "trade-v1"),
    });
    await agentStore.putAgentSessionKey(ownerAccount.address, AGENT_ID, SESSION_KEY);

    // A second agent under a DIFFERENT owner, so cross-tenant probes have a real
    // target rather than a missing one.
    await agentStore.createAgent({
      id: OTHER_AGENT_ID,
      ownerAddress: otherOwnerAccount.address,
      walletAddress: otherOwnerAccount.address,
      custodyModel: "self-eoa",
      sessionFacts: sessionFacts(NOW_SEC + 3_600),
      status: "armed",
      httpRuntimeProfile:
        options.httpRuntimeProfile ?? (options.executeRaw === true ? "raw-v1" : "trade-v1"),
    });
    await agentStore.putAgentSessionKey(
      otherOwnerAccount.address,
      OTHER_AGENT_ID,
      SESSION_KEY,
    );
  }

  let lp = options.lp;
  if (
    lp !== undefined &&
    options.strictLpReaderCapabilities !== true &&
    lp.readers.finalizedBlockNumber === undefined &&
    lp.readers.blockNumber !== undefined
  ) {
    lp = {
      ...lp,
      readers: {
        ...lp.readers,
        finalizedBlockNumber: lp.readers.blockNumber,
      },
    };
  }

  const baseConfig: ServerConfig = {
    chainId: CHAIN_ID,
    network: NETWORK,
    keyStore: KEY_STORE,
    execToken: EXEC_TOKEN,
    operatorToken: OPERATOR_TOKEN,
    now,
    throttle: { minIntervalMs: 0, maxPerWindow: 1_000, windowMs: 1_000 },
    ...(options.executeRaw === "unset"
      ? {}
      : { executeRawEnabled: options.executeRaw ?? true }),
    ...(options.omitTrade === true ? {} : { trade: tradeConfig() }),
    ...options.config,
  };
  const defaultRuntimeAuth = resolveRuntimeAuthConfig(
    {
      RUNTIME_ASSERTION_ISSUER: RUNTIME_ISSUER,
      RUNTIME_ASSERTION_PUBLIC_KEYS_JSON: JSON.stringify({
        [RUNTIME_KEY_ID]: RUNTIME_PUBLIC_KEY_RAW.toString("base64url"),
      }),
    },
    {
      chainId: baseConfig.chainId,
      envSalt: baseConfig.envSalt ?? RUNTIME_ENV_SALT,
    },
  );
  const serverConfig: ServerConfig = {
    ...baseConfig,
    runtimeAuth: options.config?.runtimeAuth ?? defaultRuntimeAuth,
  };

  const app = createServer({
    agentStore,
    journal,
    nonceStore,
    runtimeReplayStore,
    killswitch,
    providerRegistry,
    dataPlane,
    ...(lp === undefined ? {} : { lp }),
    ...(options.venus === undefined ? {} : { venus: options.venus }),
    ...(options.lending === undefined ? {} : { lending: options.lending }),
    ...(options.billingOwner === undefined ? {} : { billingOwner: options.billingOwner }),
    ...(options.hire === undefined ? {} : { hire: options.hire }),
    ...(options.tradeAgent === undefined ? {} : { tradeAgent: options.tradeAgent }),
    ...(options.keyStoreReader === undefined ? {} : { keyStoreReader: options.keyStoreReader }),
    config: serverConfig,
  });

  return {
    app,
    agentStore,
    journal,
    nonceStore,
    killswitch,
    provider,
    dataPlane,
    runtimePrivateKey: RUNTIME_KEY_PAIR.privateKey,
    runtimeIssuer: RUNTIME_ISSUER,
    runtimeAudience:
      defaultRuntimeAuth.kind === "enabled" ? defaultRuntimeAuth.audience : "unreachable",
    runtimeKeyId: RUNTIME_KEY_ID,
    defaultHttpRuntimeProfile:
      options.httpRuntimeProfile ?? (options.executeRaw === true ? "raw-v1" : "trade-v1"),
    ...(legacyRuntimeProfileContext === undefined
      ? {}
      : { legacyRuntimeProfileContext }),
    advance(ms: number): void {
      nowMs += ms;
    },
    nowSec(): number {
      return Math.floor(nowMs / 1000);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Signing                                                                    */
/* -------------------------------------------------------------------------- */

let nonceCounter = 0;

/** A fresh bytes32 nonce. Sequential so a test can predict nothing about it. */
export function freshNonce(): Hex {
  nonceCounter += 1;
  return keccak256(stringToBytes(`harness-nonce-${nonceCounter}`));
}

export type SignOptions = {
  readonly pk?: Hex;
  readonly agentId?: string;
  readonly nonce?: Hex;
  readonly issuedAt?: number;
  readonly expiry?: number;
  readonly chainId?: number;
  readonly network?: string;
  readonly envSalt?: string;
  /** Override the bound paramsHash, to test the binding directly. */
  readonly paramsHash?: Hex;
};

export type SignedEnvelope = {
  readonly signed: Record<string, unknown>;
  readonly signature: Hex;
  readonly params: unknown;
};

/**
 * Produce a real signed owner-action envelope in wire form.
 *
 * The domain comes from `buildOwnerActionDomain` — the same exported constructor
 * a production signing client is told to use — so this doubles as the test that
 * the exported constructor produces a domain the verifier accepts.
 */
export async function signOwnerAction(
  action: OwnerActionType,
  params: unknown,
  options: SignOptions = {},
): Promise<SignedEnvelope> {
  const pk = options.pk ?? OWNER_PK;
  const account = privateKeyToAccount(pk);
  const chainId = options.chainId ?? CHAIN_ID;
  const issuedAt = BigInt(options.issuedAt ?? NOW_SEC);
  const expiry = BigInt(options.expiry ?? NOW_SEC + 120);

  const message: OwnerActionStruct = {
    owner: account.address,
    agentId: options.agentId ?? AGENT_ID,
    action,
    paramsHash: options.paramsHash ?? paramsHash(action, params),
    nonce: options.nonce ?? freshNonce(),
    issuedAt,
    expiry,
  };

  const signature = await account.signTypedData({
    domain: buildOwnerActionDomain(
      chainId,
      resolveDomainSalt({
        chainId,
        network: options.network ?? NETWORK,
        ...(options.envSalt === undefined ? {} : { envSalt: options.envSalt }),
      }),
    ),
    types: OWNER_ACTION_TYPES,
    primaryType: "OwnerAction",
    message,
  });

  return {
    signed: {
      owner: message.owner,
      agentId: message.agentId,
      action: message.action,
      paramsHash: message.paramsHash,
      nonce: message.nonce,
      // Bigints cross the wire as decimal strings, exactly as a real client sends.
      issuedAt: message.issuedAt.toString(10),
      expiry: message.expiry.toString(10),
    },
    signature,
    params,
  };
}

/** Base64url-encode an envelope for the `x-owner-action` read header. */
export function toReadHeader(envelope: SignedEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                            */
/* -------------------------------------------------------------------------- */

export type RequestOptions = {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Omit the service credential entirely. */
  readonly noExecToken?: boolean;
  readonly execToken?: string;
  /** Omit the request-bound runtime assertion on autonomous routes. */
  readonly noRuntimeAssertion?: boolean;
  /** Exact assertion override for adversarial codec/auth tests. */
  readonly runtimeAssertion?: string;
};

export async function signRuntimeRequest(
  harness: Harness,
  agentId: string,
  operation: "agentRead" | "trade" | "executeRaw",
  params: unknown,
  overrides: {
    readonly nonce?: Hex;
    readonly issuedAt?: number;
    readonly expiry?: number;
    readonly requestHash?: Hex;
    readonly owner?: Address;
    readonly profile?: HttpRuntimeProfile;
    readonly issuer?: string;
    readonly audience?: string;
    readonly keyId?: string;
    readonly privateKey?: KeyObject;
  } = {},
): Promise<string> {
  const agent = await harness.agentStore.getAgentById(agentId);
  if (agent === null && (overrides.owner === undefined || overrides.profile === undefined)) {
    throw new Error("signRuntimeRequest needs an existing agent or explicit owner/profile.");
  }
  const issuedAt = overrides.issuedAt ?? harness.nowSec();
  return encodeRuntimeAssertion(
    createRuntimeAssertionClaims({
      issuer: overrides.issuer ?? harness.runtimeIssuer,
      audience: overrides.audience ?? harness.runtimeAudience,
      keyId: overrides.keyId ?? harness.runtimeKeyId,
      agentId,
      owner: overrides.owner ?? agent!.ownerAddress,
      httpRuntimeProfile: overrides.profile ?? agent!.httpRuntimeProfile,
      operation,
      requestHash: overrides.requestHash ?? runtimeRequestHash(operation, agentId, params),
      issuedAt,
      ...(overrides.nonce === undefined ? {} : { nonce: overrides.nonce }),
      ...(overrides.expiry === undefined ? {} : { expiry: overrides.expiry }),
    }),
    overrides.privateKey ?? harness.runtimePrivateKey,
  );
}

export async function call(
  harness: Harness,
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };
  if (options.noExecToken !== true) {
    headers["x-exec-token"] = options.execToken ?? EXEC_TOKEN;
  }

  const method = options.method ?? "GET";
  const runtimeTarget = runtimeRoute(path, method);
  const requestProfile =
    runtimeTarget?.operation === "trade"
      ? "trade-v1"
      : runtimeTarget?.operation === "executeRaw"
        ? "raw-v1"
        : undefined;
  const hasRuntimeHeader = Object.keys(headers).some(
    (key) => key.toLowerCase() === "x-runtime-assertion",
  );
  if (
    runtimeTarget !== null &&
    options.noRuntimeAssertion !== true &&
    !hasRuntimeHeader
  ) {
    if (options.runtimeAssertion !== undefined) {
      headers["x-runtime-assertion"] = options.runtimeAssertion;
    } else {
      const params = runtimeParams(runtimeTarget.operation, options.body);
      const agent = await harness.agentStore.getAgentById(runtimeTarget.agentId);
      if (params !== null) {
        headers["x-runtime-assertion"] = await signRuntimeRequest(
          harness,
          runtimeTarget.agentId,
          runtimeTarget.operation,
          params,
          agent === null
            ? {
                owner: OWNER_ADDRESS,
                profile: requestProfile ?? harness.defaultHttpRuntimeProfile,
              }
            : requestProfile !== undefined &&
                harness.legacyRuntimeProfileContext !== undefined
              ? { profile: requestProfile }
              : {},
        );
      }
    }
  }
  // `fetch` refuses a body on GET/HEAD, so the harness drops it rather than
  // letting a shared test table blow up on the read routes.
  const sendsBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit = {
    method,
    headers,
    ...(options.body === undefined || !sendsBody
      ? {}
      : {
          body:
            typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body),
        }),
  };

  const response =
    requestProfile === undefined || harness.legacyRuntimeProfileContext === undefined
      ? await harness.app.request(path, init)
      : await harness.legacyRuntimeProfileContext.run(
          requestProfile,
          async () => harness.app.request(path, init),
        );
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text !== "") {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return { status: response.status, body, text };
}

function runtimeRoute(
  path: string,
  method: string,
): { readonly agentId: string; readonly operation: "agentRead" | "trade" | "executeRaw" } | null {
  const pathname = path.split("?", 1)[0] ?? path;
  const match = /^\/agents\/([^/]+)(?:\/(trade|execute))?$/.exec(pathname);
  if (match === null) return null;
  const agentId = decodeURIComponent(match[1] ?? "");
  const suffix = match[2];
  if (method === "GET" && suffix === undefined) {
    return { agentId, operation: "agentRead" };
  }
  if (method === "POST" && suffix === "trade") {
    return { agentId, operation: "trade" };
  }
  if (method === "POST" && suffix === "execute") {
    return { agentId, operation: "executeRaw" };
  }
  return null;
}

function runtimeParams(
  operation: "agentRead" | "trade" | "executeRaw",
  body: unknown,
): unknown | null {
  if (operation === "agentRead") return {};
  let value = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = operation === "trade"
    ? parseTradeRequest(value)
    : parseExecuteRequest(value, MAX_CALLS_PER_EXECUTE);
  return parsed.ok ? parsed.value : null;
}

/** The `error.code` from a response body, or `undefined` when there is none. */
export function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body["error"];
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : undefined;
}

export const OWNER_ADDRESS: Address = ownerAccount.address;
export const OTHER_OWNER_ADDRESS: Address = otherOwnerAccount.address;
