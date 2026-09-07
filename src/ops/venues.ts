/**
 * Per-chain venue addresses.
 *
 * Addresses are configuration, not code: a wrong or upgraded deployment must be
 * a config change and a restart, never a release. So every field is
 * env-overridable and every override is validated AT BOOT — a malformed address
 * fails the process, never a trade.
 *
 * Two safety rules shape the type:
 *
 *   1. Every field is OPTIONAL. A chain with no known deployment gets
 *      `undefined`, and an unconfigured venue is a 400 at the route. It is never
 *      a call to the zero address, which on BNB Chain is an irreversible burn
 *      dressed up as a swap (PHASE2 R17).
 *   2. An override may not be the zero address and may not be the KeyStore. The
 *      KeyStore is the registry that bounds every session; a "venue" pointed at
 *      it would let a trade batch tamper with the thing that authorizes it.
 *
 * VERIFIED 2026-08-11 against BNB Chain mainnet (56) — see `src/ops/abis.ts` for
 * the full provenance note. Chain 97 (testnet) ships EMPTY: the PancakeSwap
 * testnet router quoted in circulation is unverified and effectively dead, and
 * Four.Meme has no public testnet deployment. Shipping a guess would be worse
 * than shipping nothing, because a guess submits.
 */
import { getAddress, isAddress, zeroAddress, type Address } from "viem";

/** The venue addresses one chain offers. Any field may be absent. */
export type VenueConfig = {
  readonly chainId: number;
  /** PancakeSwap V2 router. Required for either pancake side. */
  readonly pancakeRouterV2?: Address;
  /**
   * PancakeSwap V3 `SwapRouter`. Required for either `pancake_v3` side.
   *
   * The DEDICATED V3 router, deliberately not the SmartRouter: a
   * `{ to: <router> }` allowlist rule grants every function the target exposes,
   * and the SmartRouter additionally exposes V2 swaps, stable-swap entry
   * points, `wrapETH`, `approveMax` and `pull`. Routing across venue types is
   * also a market judgement this service does not make.
   */
  readonly pancakeRouterV3?: Address;
  /** Wrapped BNB, the intermediate hop on every pancake path. */
  readonly wbnb?: Address;
  /**
   * Four.Meme `TokenManager2`.
   *
   * NOT the manager a trade calls. That one comes from the on-chain
   * `getTokenInfo` read on every attempt (PHASE2.1 R3), because V1 and V2
   * tokens live behind different managers and hardcoding one mis-routes the
   * other. This constant exists for exactly two duller jobs: the canonical
   * session template allowlists it so the common case clears the on-chain
   * policy, and the `token` blacklist refuses a request that names it. It is
   * deliberately NOT env-overridable — an override here would look like a way
   * to choose the manager, and it is not one.
   */
  readonly fourMemeTokenManager?: Address;
  /**
   * Four.Meme `TokenManagerHelper3`, the read-only routing oracle.
   *
   * Presence of THIS address is what makes the fourmeme venue available on a
   * chain (PHASE2.1 R5): with no helper there is no way to learn a token's
   * manager or its exact `msg.value`, so the venue is a 400 rather than a
   * guess. The same value is pinned onto the provider, which is what actually
   * performs the read.
   */
  readonly fourMemeHelper?: Address;
  /**
   * flap.sh `Portal` — the bonding curve's single entry point (PHASE2.4).
   *
   * ONE address does three jobs here, unlike Four.Meme's helper/manager split:
   * it is the contract the pre-flight READS (`getTokenV5`), the contract the
   * swap CALLS, and the spender every sell approves. Presence of it is what
   * makes the venue available on a chain; absent, `flapVenue` answers `null`
   * and the route 400s rather than calling `0x0`.
   */
  readonly flapPortal?: Address;
};

/** PancakeSwap V2 router on BNB Chain 56. Verified: docs, BscScan, bytecode. */
export const PANCAKE_V2_ROUTER_56: Address = getAddress(
  "0x10ED43C718714eb63d5aA57B78B54704E256024E",
);

/**
 * PancakeSwap V3 `SwapRouter` on BNB Chain 56.
 *
 * VERIFIED 2026-08-11 against mainnet (PHASE2.2 R1): a contract whose
 * dispatcher carries `exactInputSingle` 0x414bf389, `exactInput` 0xc04b8d59,
 * `multicall(bytes[])` 0xac9650d8, `refundETH()` 0x12210e8a and
 * `unwrapWETH9(uint256,address)` 0x49404b7c, and whose `WETH9()` reads back the
 * WBNB constant below. It carries NEITHER `multicall(uint256,bytes[])` nor
 * `swapExactTokensForTokens`, both of which the SmartRouter 0x13f4EA83… does —
 * which is how the two are told apart from bytecode alone.
 */
export const PANCAKE_V3_ROUTER_56: Address = getAddress(
  "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
);

/** WBNB on BNB Chain 56. Verified by reading `router.WETH()` back on-chain. */
export const WBNB_56: Address = getAddress(
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
);

/** Four.Meme `TokenManager2` proxy on BNB Chain 56. Verified on BscScan. */
export const FOUR_MEME_TOKEN_MANAGER_56: Address = getAddress(
  "0x5c952063c7fc8610FFDB798152D69F0B9550762b",
);

/**
 * Four.Meme `TokenManagerHelper3` on BNB Chain 56.
 *
 * VERIFIED 2026-08-11 against mainnet: an EIP-1967 proxy whose implementation
 * slot reads 0x0cc78251cfc0356b2b513a9ed97be1e33ecb43c8, and whose live
 * `getTokenInfo(0x0)` answers with version 2 and TokenManager2. The PROXY is
 * pinned, never the implementation, because the implementation moves under an
 * upgrade. Full evidence in `src/wallet/abis.ts`.
 */
export const FOUR_MEME_HELPER_56: Address = getAddress(
  "0xF251F83e40a78868FcfA3FA4599Dad6494E46034",
);

/**
 * flap.sh `Portal` on BNB Chain 56, v5.14.16.
 *
 * VERIFIED 2026-08-12 against mainnet: 2 882 bytes of proxy whose EIP-1967
 * implementation slot reads 0x4e360279232b4f9cC36f23c5726dE3f3dE477b0f, and
 * whose live `getTokenV5` answers a real curve token and REVERTS on WBNB. The
 * PROXY is pinned, never the implementation. The BNB *testnet* Portal
 * 0x5bEacaF7… has no code on this chain, which is what makes a copy-paste
 * between the docs' two headings a dead venue rather than a wrong one. Full
 * evidence in `src/ops/abis.ts`.
 */
export const FLAP_PORTAL_56: Address = getAddress(
  "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
);

/** Built-in defaults, per chain. Absent chain ⇒ nothing configured. */
const DEFAULTS: ReadonlyMap<number, VenueConfig> = new Map<number, VenueConfig>([
  [
    56,
    {
      chainId: 56,
      pancakeRouterV2: PANCAKE_V2_ROUTER_56,
      pancakeRouterV3: PANCAKE_V3_ROUTER_56,
      wbnb: WBNB_56,
      fourMemeTokenManager: FOUR_MEME_TOKEN_MANAGER_56,
      fourMemeHelper: FOUR_MEME_HELPER_56,
      flapPortal: FLAP_PORTAL_56,
    },
  ],
]);

/** Raw env overrides, exactly as read from the environment. */
export type VenueOverrides = {
  readonly pancakeRouterV2?: string;
  readonly pancakeRouterV3?: string;
  readonly wbnb?: string;
  readonly fourMemeHelper?: string;
  readonly flapPortal?: string;
};

export type ResolveVenuesInput = {
  readonly chainId: number;
  readonly overrides?: VenueOverrides;
  /**
   * The network's KeyStore. An override equal to it is refused: a session
   * allowed to call the key registry could register or revoke its own keys.
   */
  readonly keyStore?: Address;
};

/**
 * Validate one env-supplied venue address.
 *
 * `isAddress` in its default strict mode accepts an all-lowercase, an
 * all-uppercase or a correctly-checksummed spelling and rejects a corrupted
 * mixed-case one — which is exactly the typo class worth catching, because a
 * single flipped nibble in a router address is a total loss.
 */
function validateOverride(
  raw: string,
  field: string,
  keyStore: Address | undefined,
): Address {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) {
    throw new Error(`${field} is not a valid checksummed address.`);
  }
  const address = getAddress(trimmed);
  if (address === getAddress(zeroAddress)) {
    throw new Error(`${field} must not be the zero address.`);
  }
  if (keyStore !== undefined && address === getAddress(keyStore)) {
    throw new Error(`${field} must not be the key registry.`);
  }
  return address;
}

/**
 * Resolve the venue config for a chain: built-in defaults, then env overrides.
 *
 * THROWS on a malformed override. Called once at boot so the failure is a
 * process that refuses to start rather than a trade that refuses to submit —
 * or, worse, one that submits somewhere unintended.
 */
export function resolveVenues(input: ResolveVenuesInput): VenueConfig {
  const base = DEFAULTS.get(input.chainId) ?? { chainId: input.chainId };
  const overrides = input.overrides ?? {};

  const pancakeRouterV2 =
    overrides.pancakeRouterV2 === undefined || overrides.pancakeRouterV2.trim() === ""
      ? base.pancakeRouterV2
      : validateOverride(
          overrides.pancakeRouterV2,
          "VENUE_PANCAKE_ROUTER",
          input.keyStore,
        );

  const pancakeRouterV3 =
    overrides.pancakeRouterV3 === undefined || overrides.pancakeRouterV3.trim() === ""
      ? base.pancakeRouterV3
      : validateOverride(
          overrides.pancakeRouterV3,
          "VENUE_PANCAKE_ROUTER_V3",
          input.keyStore,
        );

  const wbnb =
    overrides.wbnb === undefined || overrides.wbnb.trim() === ""
      ? base.wbnb
      : validateOverride(overrides.wbnb, "VENUE_WBNB", input.keyStore);

  const fourMemeHelper =
    overrides.fourMemeHelper === undefined || overrides.fourMemeHelper.trim() === ""
      ? base.fourMemeHelper
      : validateOverride(
          overrides.fourMemeHelper,
          "VENUE_FOURMEME_HELPER",
          input.keyStore,
        );

  // Rule 2 applies to the flap override exactly as to the others: not the zero
  // address, not the KeyStore. The Portal is a swap target AND an approval
  // spender, so a mis-pointed one is both a burn and a live allowance.
  const flapPortal =
    overrides.flapPortal === undefined || overrides.flapPortal.trim() === ""
      ? base.flapPortal
      : validateOverride(overrides.flapPortal, "VENUE_FLAP_PORTAL", input.keyStore);

  const fourMemeTokenManager = base.fourMemeTokenManager;

  return {
    chainId: input.chainId,
    ...(pancakeRouterV2 === undefined ? {} : { pancakeRouterV2 }),
    ...(pancakeRouterV3 === undefined ? {} : { pancakeRouterV3 }),
    ...(wbnb === undefined ? {} : { wbnb }),
    ...(fourMemeTokenManager === undefined ? {} : { fourMemeTokenManager }),
    ...(fourMemeHelper === undefined ? {} : { fourMemeHelper }),
    ...(flapPortal === undefined ? {} : { flapPortal }),
  };
}

/** A resolved pancake venue: the router to call and the WBNB leg of the path. */
export type PancakeVenue = {
  readonly router: Address;
  readonly wbnb: Address;
};

/** The pancake pair, or `null` when this chain has no configured deployment. */
export function pancakeVenue(venues: VenueConfig): PancakeVenue | null {
  if (venues.pancakeRouterV2 === undefined || venues.wbnb === undefined) return null;
  return { router: venues.pancakeRouterV2, wbnb: venues.wbnb };
}

/**
 * The pancake V3 pair, or `null` when this chain has no usable deployment.
 *
 * BOTH addresses are required and the reason is not symmetry (PHASE2.2 R6):
 * every V3 path this service builds begins or ends at WBNB, and `wbnb` is
 * independently optional in the config. A router configured without WBNB would
 * otherwise pass the venue gate and then build a path through `undefined`.
 */
export function pancakeV3Venue(venues: VenueConfig): PancakeVenue | null {
  if (venues.pancakeRouterV3 === undefined || venues.wbnb === undefined) return null;
  return { router: venues.pancakeRouterV3, wbnb: venues.wbnb };
}

/**
 * The flap Portal, or `null` when this chain has no configured deployment.
 *
 * ONE address, and no WBNB: flap is a bonding curve quoted in the NATIVE asset,
 * so nothing here wraps. A chain with no Portal is a chain with no flap venue,
 * and the route answers 400 rather than building a call to nowhere (PHASE2 R17).
 */
export function flapVenue(venues: VenueConfig): Address | null {
  return venues.flapPortal ?? null;
}
