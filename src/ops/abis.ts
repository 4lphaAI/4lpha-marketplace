/**
 * Minimal ABI fragments for the trade venues.
 *
 * Mirrors `src/wallet/abis.ts`: hand-transcribed fragments rather than a vendored
 * artifact, so what this service can encode is exactly what is written here and
 * auditable in one screen.
 *
 * INVARIANT (PHASE2 R6): each exported fragment contains AT MOST ONE entry per
 * function name. Both venues overload their entry points — `sellToken` has a
 * 2-arg form with NO slippage floor and `buyTokenAMAP` has a 4-arg form with a
 * caller-supplied recipient — and viem resolves `functionName: "sellToken"`
 * against whichever entry it finds. Keeping one entry per name means a builder
 * cannot silently encode the wrong overload; `test/ops.builders.test.ts` asserts
 * the no-duplicate property so a later edit cannot reintroduce the ambiguity.
 *
 * ─── PROVENANCE ────────────────────────────────────────────────────────────
 *
 * Verified 2026-08-11 against DEPLOYED BYTECODE on BNB Chain (56), which is a
 * stronger check than a block-explorer source page: each signature below was
 * hashed to its 4-byte selector and located in the dispatcher of the live code.
 *
 *   PancakeSwap V2 router  0x10ED43C718714eb63d5aA57B78B54704E256024E
 *     0xb6f9de95 swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)
 *     0x791ac947 swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)
 *     `router.WETH()` read back as 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,
 *     confirming the WBNB constant in `src/ops/venues.ts`.
 *
 *   PancakeSwap V3 SwapRouter 0x1b81D678ffb9C0263b24A97847620C99d213eB14
 *     0x414bf389 exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
 *     0xc04b8d59 exactInput((bytes,address,uint256,uint256,uint256))
 *     0xac9650d8 multicall(bytes[])
 *     0x12210e8a refundETH()
 *     0x49404b7c unwrapWETH9(uint256,address)
 *     `router.WETH9()` read back as 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c.
 *     Re-verified 2026-08-11 (PHASE2.2 R1): 0x5ae401dc `multicall(uint256,bytes[])`
 *     and 0x1f0464d1 `multicall(bytes32,bytes[])` are ABSENT from this dispatcher
 *     — they belong to the SmartRouter — so the deadline lives INSIDE each swap
 *     struct here and encoding the SmartRouter's shape would revert with empty
 *     returndata, which classifies as an opaque provider failure rather than as
 *     the coding error it is. This is the DEDICATED V3 router, deliberately not
 *     the SmartRouter 0x13f4EA83…: the SmartRouter additionally dispatches
 *     `swapExactTokensForTokens` (0x472b43f3, verified present there and absent
 *     here), stable-swap and `pull`/`approveMax` entry points, all of which a
 *     single `{ to: <router> }` allowlist rule would grant at once.
 *
 *   flap.sh Portal 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0 (2 882 bytes)
 *     Verified 2026-08-12. An EIP-1967 proxy: slot
 *     0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc reads
 *     back 0x4e360279232b4f9cC36f23c5726dE3f3dE477b0f (19 842 bytes), and all
 *     three selectors below live in the IMPLEMENTATION's dispatcher, not the
 *     proxy's. The PROXY is what gets pinned; an upgrade moves the other one.
 *       0xef7ec2e7 swapExactInput((address,address,uint256,uint256,bytes))
 *       0xfc847c2b quoteExactInput((address,address,uint256))
 *       0x5c4bc504 getTokenV5(address)
 *     `docs.flap.sh/flap/developers/deployed-contract-addresses` lists it under
 *     "Mainnet / BNB Chain" as v5.14.16 and the BNB TESTNET Portal
 *     0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9 under "Testnet". The docs are
 *     right; the on-chain check was still worth doing, and it is what shows the
 *     testnet address has NO CODE AT ALL on chain 56 — a copy-paste between the
 *     two headings would have produced a venue that calls an empty address.
 *
 *     STRUCT FIELD ORDER IS THE THING A SELECTOR CANNOT PROVE, and it is what
 *     rejected PHASE2.2. `ExactInputParams` is confirmed TWICE: the published
 *     `IPortalTradeV2` struct, and a simulated buy that SUCCEEDS at
 *     `value == inputAmount` and reverts 0x3ebbc337 at `value == 0`.
 *
 *     FAIL-CLOSED READS, the OPPOSITE of Four.Meme's zero-read hazard below: a
 *     non-flap address REVERTS rather than answering zeros. Measured —
 *       getTokenV5(WBNB)                     REVERT 0xde6137d1<address>
 *       quoteExactInput(0x0 -> WBNB, 1e15)   REVERT 0x6e8698f2<address>
 *     — two DIFFERENT selectors; an earlier draft recorded `0xde6137d1` for
 *     both. Both are fail-closed, so no bounding of zeros is needed here and
 *     imitating the Four.Meme path would be cargo cult.
 *
 *     TokenStatus { Invalid=0, Tradable=1, InDuel=2, Killed=3, DEX=4, Staged=5 }.
 *     `status` and `tokenVersion` are declared `uint8` below rather than as
 *     enums: Solidity encodes an enum as uint8 anyway, and a future variant
 *     (Staged was added after V5 shipped) must not turn a decode into a revert.
 *
 *   Four.Meme TokenManager2 0x5c952063c7fc8610FFDB798152D69F0B9550762b
 *     (EIP-1967 proxy; implementation 0x12570c761d444a7985b4e651f629e3e94a1670e8)
 *     0x87f27655 buyTokenAMAP(address,uint256,uint256)
 *     0x06e7b98f sellToken(uint256,address,uint256,uint256,uint256,address)
 *     Cross-checked against the official `TokenManager2.lite.abi` distribution
 *     for `stateMutability` and parameter NAMES (bytecode proves the types and
 *     their order; only the ABI file names them).
 */

/**
 * PancakeSwap V2 router — the two fee-on-transfer swap entry points.
 *
 * The `SupportingFeeOnTransferTokens` variants are deliberate: meme tokens
 * routinely tax transfers, and the plain `swapExactETHForTokens` reverts on
 * them (it asserts the exact output amount the pair quoted, which a transfer
 * tax makes unreachable).
 */
export const PANCAKE_V2_ROUTER_ABI = [
  {
    name: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * PancakeSwap V3 `SwapRouter` — the five entry points a caller-routed swap needs.
 *
 * Two shapes here are easy to get wrong in a way no offline test would catch,
 * so both are pinned deliberately (PHASE2.2 R1):
 *
 *   1. `deadline` lives INSIDE `ExactInputSingleParams` and `ExactInputParams`.
 *      Pancake's SmartRouter dropped it in favour of a
 *      `multicall(uint256 deadline, bytes[])` overload, and a draft written
 *      against that shape encodes a selector this contract does not dispatch.
 *   2. There is EXACTLY ONE `multicall` here, `multicall(bytes[])`. The R6
 *      one-entry-per-name rule matters more than usual for this name: viem
 *      resolves `functionName: "multicall"` against whichever entry it finds,
 *      and the wrong overload is a revert with empty returndata.
 *
 * `sqrtPriceLimitX96` is declared but this codebase always passes zero — a price
 * limit is a second slippage control the caller did not ask for, and a non-zero
 * value silently turns a full fill into a partial one. `amountOutMinimum` is the
 * only floor, and it is the caller's `minOutWei`.
 */
export const PANCAKE_V3_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "exactInput",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    name: "refundETH",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "unwrapWETH9",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
] as const;

/**
 * PancakeSwap NonfungiblePositionManager (NFPM) — the eight entry points the
 * LP sagas call, and DELIBERATELY nothing else.
 *
 * Verified 2026-08-13 against DEPLOYED BYTECODE on BNB Chain 56 at
 * 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364 (24 466 bytes, not an EIP-1967
 * proxy — implementation slot empty). Each signature below was hashed locally
 * with `toFunctionSelector` and LOCATED in the live dispatcher
 * (PHASE3-REVIEW.md, on-chain facts):
 *
 *   0x88316456 mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))
 *   0x219f5d17 increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))
 *   0x0c49ccbe decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
 *   0xfc6f7865 collect((uint256,address,uint128,uint128))
 *   0x42966c68 burn(uint256)
 *   0x12210e8a refundETH()
 *   0x49404b7c unwrapWETH9(uint256,address)
 *   0xdf2ab5bb sweepToken(address,uint256,address)
 *
 * `NFPM.WETH9()` reads back 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c and
 * `NFPM.factory()` reads back 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865,
 * agreeing with the venue constants. The SmartRouter-style
 * `multicall(uint256,bytes[])` 0x5ae401dc is ABSENT from this dispatcher —
 * the same finding as the 2.2 router.
 *
 * ─── WHAT IS MISSING FROM THIS FRAGMENT IS THE POINT (PHASE3 R2) ───────────
 *
 * The deployed dispatcher carries MORE than the eight entries above, and the
 * omissions here are load-bearing, not incomplete transcription:
 *
 *   - NO `multicall(bytes[])` (0xac9650d8 — PRESENT in the bytecode). The
 *     NFPM's Multicall delegatecalls to self, so the inner calls are invisible
 *     to the account's allowlist: the outer selector is all `canExecute` sees.
 *     A multicall grant — or a builder that encodes one — is a target-only
 *     grant in disguise, and the SAME dispatcher carries the NFT-authority
 *     surface below. Leaving the entry out of this fragment means no builder
 *     can even encode it: viem throws on an unknown `functionName`. Batching
 *     happens where it already does for every other venue — multiple
 *     `WalletCall`s in ONE atomic ERC-7821 execute batch.
 *   - NO `setApprovalForAll` (0xa22cb465), NO ERC-721 `approve` (0x095ea7b3),
 *     NO `safeTransferFrom` (0x42842e0e), NO `transferFrom` (0x23b872dd) —
 *     all four PRESENT in the deployed dispatcher, and together they are the
 *     theft surface for a position NFT. "No NFT approvals are granted to
 *     anyone, ever" (PHASE3 custody model) holds because the grant in
 *     `lpSessionSpec` is selector-scoped, this fragment cannot encode an
 *     approval, and `EXECUTE_RAW_ENABLED` defaults OFF — a property of this
 *     design, not of EIP-7702.
 *
 * Every entry is `payable`: the periphery inherits PeripheryPayments and
 * declares each external write payable. Only the OPEN's mint actually attaches
 * value (PHASE3 Rev2 item 14); the builders enforce that, not this fragment.
 */
export const NONFUNGIBLE_POSITION_MANAGER_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "increaseLiquidity",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "decreaseLiquidity",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "collect",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "burn",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "refundETH",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "unwrapWETH9",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "sweepToken",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
] as const;

/**
 * The ERC-20 write a sell needs, and nothing else.
 *
 * Sells approve an EXACT amount, never `type(uint256).max`: an infinite
 * allowance outlives the trade and the session, and the whole point of this
 * layer is that authority expires.
 */
/**
 * PHASE3.19 item 4 — WBNB's payable zero-arg wrap.
 *
 * `deposit()` on the canonical WETH9-shaped WBNB contract: it credits
 * `msg.sender` with `msg.value` worth of WBNB and returns nothing. The matching
 * `withdraw(uint256)` is DELIBERATELY ABSENT from this repo — nothing in the LP
 * plane unwraps that way, `lpSessionSpec` grants no such rule, and an ABI nobody
 * can reach is one fewer selector for a later phase to reach for by accident.
 */
export const WBNB_DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

export const ERC20_APPROVE_ABI = [
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
 * flap.sh Portal — the one write this service makes and the two reads that
 * decide whether it may.
 *
 * `swapExactInput` is the whole venue: flap is a bonding curve, not a router,
 * so there are no hops, no fee tiers and no `route`. Direction is expressed by
 * which side of the struct holds `address(0)` — the native asset — so a BUY is
 * `0x0 -> token` with `value == inputAmount` and a SELL is `token -> 0x0` with
 * `value == 0`.
 *
 * `permitData` IS ALWAYS EMPTY, and that is not laziness. ERC-2612 `permit`
 * recovers a signature against the TOKEN HOLDER's key. The holder is the
 * wallet; the only signer available at execute time is the SESSION key, which
 * is a different key, so a permit signed there recovers to the session address
 * and fails. The `approve(0)` / `approve(amount)` pair is the only route, and
 * it is the same pair every other sell builder here emits.
 *
 * `quoteExactInput` is `nonpayable`, so it is an `eth_call`/simulate rather
 * than a `view` read. It is declared here for the OPERATOR quote path in
 * `scripts/live-trade.ts`; the service itself never quotes — the caller
 * supplies `quotedOutWei` and `minOutWei`, exactly as on every other venue.
 *
 * `getTokenV5` is the pre-flight read. V5 rather than the newer V8: it is the
 * version the pinned v5.14.16 Portal was verified against on chain, and it
 * already carries every field the refusals need.
 */
export const FLAP_PORTAL_ABI = [
  {
    name: "swapExactInput",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "inputToken", type: "address" },
          { name: "outputToken", type: "address" },
          { name: "inputAmount", type: "uint256" },
          { name: "minOutputAmount", type: "uint256" },
          { name: "permitData", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "outputAmount", type: "uint256" }],
  },
  {
    name: "quoteExactInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "inputToken", type: "address" },
          { name: "outputToken", type: "address" },
          { name: "inputAmount", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "outputAmount", type: "uint256" }],
  },
  {
    name: "getTokenV5",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "reserve", type: "uint256" },
          { name: "circulatingSupply", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "tokenVersion", type: "uint8" },
          { name: "r", type: "uint256" },
          { name: "h", type: "uint256" },
          { name: "k", type: "uint256" },
          { name: "dexSupplyThresh", type: "uint256" },
          { name: "quoteTokenAddress", type: "address" },
          { name: "nativeToQuoteSwapEnabled", type: "bool" },
          { name: "extensionID", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

/**
 * Four.Meme `TokenManager2` — the bonding-curve entry points.
 *
 * `sellToken` here is the SIX-argument overload. The 2-argument
 * `sellToken(address,uint256)` is FORBIDDEN in this codebase (PHASE2 R6): it
 * carries no `minFunds`, so a `minOutWei` the wire required and the rule engine
 * checked would be discarded before it ever reached the chain — slippage
 * discipline that exists only in our logs.
 *
 * `feeRate` and `feeRecipient` are DELIBERATELY unused (zero / zero address,
 * see PHASE2 R19): the fee seam in `src/ops/fees.ts` is the only fee mechanism
 * this service operates, and routing a second one through the venue would make
 * the total unauditable from the batch alone.
 */
export const FOUR_MEME_TOKEN_MANAGER_ABI = [
  {
    name: "buyTokenAMAP",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "funds", type: "uint256" },
      { name: "minAmount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "sellToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "origin", type: "uint256" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minFunds", type: "uint256" },
      { name: "feeRate", type: "uint256" },
      { name: "feeRecipient", type: "address" },
    ],
    outputs: [],
  },
] as const;
