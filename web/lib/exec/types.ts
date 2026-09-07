/**
 * Hand-written DTOs for the execution-plane routes the marketplace UI uses.
 * `web/` never imports from `../src/` — these mirror the wire, nothing more.
 */

export type ExecErrorEnvelope = {
  readonly error: { readonly code: string; readonly message?: string };
};

export type AccountCoverage = {
  readonly state: "complete" | "partial" | "empty" | "unavailable";
  readonly reasons: readonly AccountCoverageReason[];
};

export type AccountCoverageReason = "none" | "capacity" | "dependency" | "stale" | "unpriced" | "unreadable" | "identity-conflict" | "unsupported-profile" | "zero-basis" | "missing-mark" | "held" | "declared";

export type AccountPortfolio = {
  readonly generatedAt: number;
  readonly asOf: number | null;
  /**
   * The owner IDENTITY, and nothing else. Under `passkey` custody it is
   * derived from a P256 credential, holds no on-chain authority, and is NOT
   * payable — funds sent to it are burned (execution plane
   * `src/core/types.ts:154-166`). NEVER render it as an address and NEVER use
   * it as a deposit target; deposits go to `wallets[].address`.
   */
  readonly ownerAddress: string;
  /** The agent wallets — the only depositable addresses on this view. */
  readonly wallets: readonly {
    readonly address: string;
    readonly custodyModel: "self-eoa" | "passkey" | "hd-derived";
    readonly depositable: true;
    /**
     * Where the entry came from. `"agents"` — the plane owns rows on it.
     * `"declared"` — this request named the address and the plane read its
     * public balances; no agents run there, so `deployedUsdMicros` is `"0"` by
     * absence and `deployedReason` is `"declared"`.
     */
    readonly source: "agents" | "declared";
    /** Liquid native + known ERC-20 value on this wallet. */
    readonly availableUsdMicros: string | null;
    /** LP marks of positions held by agents running on this wallet. */
    readonly deployedUsdMicros: string | null;
    /** Why the deployed figure is what it is — `"none"` when fully measured. */
    readonly deployedReason: AccountCoverageReason;
    /**
     * DECLARED entries only — the Altana KeyStore's answer to "does this owner
     * control this address".
     *
     * `"verified"` — a registered P-256 key derives the owner identity.
     * `"not-registered"` — the KeyStore lists no key yet. This is the NORMAL
     * state of a funded passkey wallet whose first admin action has not landed,
     * so it is not a warning.
     * `"unreadable"` — the plane could not check right now.
     * `"no-matching-key"` — registered to someone else's key. The plane REFUSES
     * that request with a 400, so it never arrives on a successful read; it is
     * in the union because the wire vocabulary is the plane's, not the UI's.
     *
     * Absent on an `"agents"` entry: there the custody claim is the plane's own
     * row, not a caller declaration.
     */
    readonly passkeyVerified?: "verified" | "not-registered" | "no-matching-key" | "unreadable";
  }[];
  readonly totals: {
    readonly walletUsdMicros: string | null;
    readonly deployedUsdMicros: string | null;
    readonly totalUsdMicros: string | null;
    readonly grossLpPnlUsdMicros: string | null;
    readonly grossLpPnlBps: string | null;
    readonly eligibleLpBasisNativeWei: string | null;
  };
  readonly agents: readonly {
    readonly id: string;
    readonly status: "provisioning" | "armed" | "paused" | "revoked" | "retired";
    readonly httpRuntimeProfile: "unbound-v1" | "trade-v1" | "raw-v1" | "lp-v1" | "venus-v1";
    readonly walletAddress: string;
    readonly attention: "none" | "paused" | "provisioning" | "partial-data";
    readonly holdings: {
      readonly method: "wallet-native-v1" | "wallet-known-erc20-v1" | "sellable-lp-exit-v1" | "owner-wide-venus-stored-net-v1" | "none";
      readonly state: "complete" | "partial" | "empty" | "unavailable";
      readonly reason: AccountCoverageReason;
      readonly valueUsdMicros: string | null;
      readonly venusReference: "owner-wide" | null;
      readonly held: boolean;
    };
    readonly pnl: {
      readonly method: "gross-lp-mark-to-declared-basis-v1" | "none";
      readonly coverage: "full" | "partial" | "unsupported" | "unavailable";
      readonly reason: AccountCoverageReason;
      readonly eligibleBasisNativeWei: string | null;
      readonly markNativeWei: string | null;
      readonly pnlNativeWei: string | null;
      readonly pnlUsdMicros: string | null;
      readonly pnlBps: string | null;
      readonly basisSources: readonly ("owner-budget" | "imported")[];
      readonly excluded: readonly ("relay-and-gas" | "wallet-residue" | "closed-lineages" | "prior-exits" | "external-cashflows" | "zero-basis-lineages")[];
    };
  }[];
  readonly assets: readonly {
    readonly kind: "native" | "erc20";
    readonly walletAddress: string;
    readonly tokenAddress: string | null;
    readonly symbol: string | null;
    readonly decimals: number | null;
    readonly balanceAtomic: string | null;
    readonly priceUsdMicros: string | null;
    readonly pricedAt: number | null;
    readonly valueUsdMicros: string | null;
    readonly status: "priced" | "zero" | "unpriced" | "unreadable";
    readonly method: "wallet-native-v1" | "wallet-known-erc20-v1";
  }[];
  readonly venus: null | {
    readonly reference: "owner-wide";
    readonly method: "owner-wide-venus-stored-net-v1";
    readonly observedAt: number;
    readonly supplyUsdMicros: string;
    readonly borrowUsdMicros: string;
    readonly netUsdMicros: string;
  };
  readonly coverage: {
    readonly universe: "known-assets";
    readonly wallet: AccountCoverage;
    readonly deployed: AccountCoverage;
    readonly total: AccountCoverage;
    readonly pnl: AccountCoverage;
    readonly truncated: { readonly agents: boolean; readonly wallets: boolean; readonly tokens: boolean; readonly walletTokenPairs: boolean; readonly positions: boolean };
  };
};

export type AgentListRow = {
  readonly id: string;
  readonly ownerAddress: string;
  readonly status: string;
  readonly walletAddress?: string;
  readonly httpRuntimeProfile?: string;
  readonly custodyModel?: string;
  readonly sessionFacts?: unknown;
  readonly [key: string]: unknown;
};

export type GridArmResult = {
  readonly position?: unknown;
  readonly siblingPosition?: unknown;
  readonly arm?: {
    readonly sequenceId: string;
    readonly status: string;
    readonly code?: string;
    readonly reason?: string;
    readonly tokenId?: string;
    readonly siblingTokenId?: string;
    readonly note?: string;
  };
  readonly settingsDigest?: string;
  readonly [key: string]: unknown;
};

export type LpOwnerBlock = {
  readonly model: "custom" | "sigma" | null;
  readonly pool: null | {
    readonly token0: string;
    readonly token1: string;
    readonly fee: number;
    readonly poolAddress: string | null;
    readonly wbnbIsToken0: boolean;
    readonly tickSpacing: number | null;
  };
  readonly range: null | {
    readonly tickLower: number;
    readonly tickUpper: number;
    readonly asOfMs: number;
  };
  readonly rangeReason: string | null;
  readonly openingRange: null | {
    readonly source: "explicit" | "server-fenced";
    readonly tickLower: number;
    readonly tickUpper: number;
  };
  readonly settingsTrusted: boolean;
  readonly settingsReason: string | null;
  readonly settings: null | {
    readonly autoRotate: boolean;
    readonly rotateMode: "swapped" | "swapless";
    readonly rotateMinHoldMinutes: number;
    readonly autoHarvest: boolean;
    readonly harvestMinFeesWei: string;
    readonly takeProfitPct: number | null;
    readonly stopLossPct: number | null;
    readonly brain: null | {
      readonly primaryModel: string;
      readonly fallbackModel: string;
    };
  };
  readonly budgetWei: string;
  readonly selection?: unknown;
  readonly selectPool?: { readonly by: "fee-apr" | "volume"; readonly window: "24h" } | null;
  readonly restart?: string | null;
  readonly reason?: string;
};

export type LpOwnerView = {
  readonly positions: readonly Record<string, unknown>[];
  readonly sequences: readonly Record<string, unknown>[];
  readonly quota: unknown;
  readonly lp?: LpOwnerBlock;
  readonly grid?: unknown;
  readonly [key: string]: unknown;
};
