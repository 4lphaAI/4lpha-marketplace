/**
 * Minimal ABI fragments used by the relay-independent recovery path.
 *
 * These are transcribed from the deployed contracts the Altana SDK targets
 * (`AltanaKeyStore`, and Porto's `IthacaAccount` which the wallet EOA delegates
 * to under EIP-7702). They exist so `ownerRecover` can run on nothing but a
 * public RPC endpoint and the owner's key — no Altana relay, no 4lpha server.
 */

/** `AltanaKeyStore` — the public registry of wallet/session keys. */
export const KEYSTORE_ABI = [
  {
    name: "revokeKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  /**
   * The registry's two VIEW functions, transcribed from the SDK's own
   * `dist/internal/keystore.js`. They are what makes "this owner controls this
   * wallet" a PROVABLE claim rather than a caller assertion — see
   * `src/account/keyStoreReader.ts`. `getPublicKey` returns the registered key
   * as raw bytes; a passkey owner key is a 64-byte FLAT P-256 `x || y`.
   */
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    name: "getPublicKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

/** The single live-fee view used by the marketplace hire funding estimate. */
export const KEYSTORE_CONTROLLER_ABI = [
  {
    name: "getRegistrationFeeInWei",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Minimal ERC-20 surface. `balanceOf` for Phase 2 token positions, and
 * `approve` — encoded only to PROBE `canExecute`, never submitted from here.
 */
export const ERC20_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * Four.Meme `TokenManagerHelper3` — the read-only routing oracle.
 *
 * This lives beside the KeyStore and ERC-20 fragments rather than in
 * `src/ops/abis.ts` because it is a PROVIDER read, in the same class as
 * `balanceOf` above: a `view` call on a BNB-Chain contract, made through the
 * chain-id-pinned public client, never a third-party HTTP API. `src/ops/`
 * holds the fragments this service WRITES with.
 *
 * ─── PROVENANCE ────────────────────────────────────────────────────────────
 *
 * Verified 2026-08-11 against BNB Chain mainnet (56) over a public RPC.
 *
 *   Helper (PINNED)  0xF251F83e40a78868FcfA3FA4599Dad6494E46034
 *
 * That address is an EIP-1967 PROXY: `eth_getStorageAt` on slot
 * 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc read back
 * 0x0cc78251cfc0356b2b513a9ed97be1e33ecb43c8, the implementation. The proxy's
 * own bytecode (1102 bytes) carries NONE of the three selectors below, so the
 * verification was done two ways, both of which passed:
 *
 *   1. each selector located in the IMPLEMENTATION's deployed bytecode
 *      (0x0cc78251…c8, 17770 bytes);
 *   2. a live `eth_call` against the PROXY:
 *      `getTokenInfo(0x0)` returned version = 2, tokenManager =
 *      0x5c952063c7fc8610FFDB798152D69F0B9550762b, quote = 0x0,
 *      tradingFeeRate = 100 (1%, the live venue fee).
 *
 * The PROXY is what gets pinned, never the implementation: the implementation
 * address changes under an upgrade and the proxy is the stable identity.
 *
 * Selectors, each recomputed locally with `toFunctionSelector` and matched
 * against the implementation's dispatcher:
 *
 *   0x1f69565f getTokenInfo(address)
 *   0xe21b103a tryBuy(address,uint256,uint256)
 *   0xc6f43e8c trySell(address,uint256)
 *
 * ─── THE ZERO-READ HAZARD (PHASE2.1 R2) ────────────────────────────────────
 *
 * VERIFIED, and it is why the caller may not treat "the read returned" as
 * "the token is tradeable": on a NON-Four.Meme address (WBNB, a random EOA)
 * all three functions return ALL ZEROS WITHOUT REVERTING, and
 * `getTokenInfo(0x0)` returns a fully-populated version-2 record. Fail-closed
 * therefore cannot rely on the call throwing — every money field is bounded
 * against the caller's own declared amount in `src/server.ts`.
 */
export const FOUR_MEME_HELPER_ABI = [
  {
    name: "getTokenInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "version", type: "uint256" },
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "lastPrice", type: "uint256" },
      { name: "tradingFeeRate", type: "uint256" },
      { name: "minTradingFee", type: "uint256" },
      { name: "launchTime", type: "uint256" },
      { name: "offers", type: "uint256" },
      { name: "maxOffers", type: "uint256" },
      { name: "funds", type: "uint256" },
      { name: "maxFunds", type: "uint256" },
      { name: "liquidityAdded", type: "bool" },
    ],
  },
  {
    name: "tryBuy",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "funds", type: "uint256" },
    ],
    outputs: [
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "estimatedAmount", type: "uint256" },
      { name: "estimatedCost", type: "uint256" },
      { name: "estimatedFee", type: "uint256" },
      { name: "amountMsgValue", type: "uint256" },
      { name: "amountApproval", type: "uint256" },
      { name: "amountFunds", type: "uint256" },
    ],
  },
  {
    name: "trySell",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "funds", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
] as const;

/**
 * `IthacaAccount` — the implementation the wallet EOA delegates to.
 *
 * `revoke` is gated by the account's `onlyThis` modifier. Under EIP-7702 the
 * account address IS the owner's EOA, so a transaction the owner sends to
 * their own address satisfies `msg.sender == address(this)` with no relay in
 * the loop.
 */
export const ACCOUNT_ABI = [
  {
    name: "revoke",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "keys",
        type: "tuple[]",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
      { name: "keyHashes", type: "bytes32[]" },
    ],
  },
  {
    /**
     * Whether a key may make a given call — the ALLOWLIST half of a session.
     *
     * Independent of the spend limits below, and the pair is not
     * interchangeable: a token given a limit but no allowlist entry reads as
     * authorised in `spendInfos` and still cannot be sold, because the sell's
     * `approve` is refused before any meter is consulted. Measured live.
     */
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    // Reverts `KeyDoesNotExist()` (0xe57b6304) for an ungranted key hash —
    // declared so viem decodes it by name; `grantEvidence.ts` maps it to
    // "cannot execute", which is the truthful answer before a grant.
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    /**
     * The spend limits the account is enforcing for a key RIGHT NOW.
     *
     * Not the same thing as the limits the grant recorded. `setSpendLimit` lets
     * the owner add or change a limit on a live session without re-granting
     * (FINDINGS (i)), and the granted `sessionFacts.spec` is not rewritten to
     * match — because it is forwarded to the relay as the key descriptor and
     * whether the relay enforces that is unsettled (FINDINGS (x)), NOT because
     * `restoreSession` needs it byte-exact, which was never true. So the two
     * diverge by design, and only this read is authoritative about what a
     * session may actually move.
     */
    name: "spendInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [
      {
        name: "results",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "period", type: "uint8" },
          { name: "limit", type: "uint256" },
          { name: "spent", type: "uint256" },
          { name: "lastUpdated", type: "uint256" },
          { name: "currentSpent", type: "uint256" },
          { name: "current", type: "uint256" },
        ],
      },
    ],
  },
] as const;
