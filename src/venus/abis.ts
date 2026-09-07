/**
 * Venus Core ABIs — the READ set this plane needs plus the four write
 * selectors Phase 4 grants.
 *
 * The read fragments are copied deliberately, shape for shape, from the data
 * plane's `src/adapters/venusAbis.ts` (`D:\4lphaDATA-marketplace`), because
 * PHASE4-SPEC R2.2 requires this plane to reproduce `calculateVenusRisk`'s
 * answer EXACTLY and a differently-decoded tuple is a silently different
 * number. Copied, not imported: the two planes are separate repos and the
 * data plane is reached only over HTTP (`CLAUDE.md`, network posture).
 *
 * The WRITE fragments carry only the selectors PHASE4-SPEC R2.7's measured
 * census grants — each one located in deployed bytecode at block 117738703
 * (`.agents/HANDOFF.md`, 2026-08-24):
 *
 *   0x4e4d9fea repayBorrow()             vBNB bytecode
 *   0x1249c58b mint()                    vBNB bytecode
 *   0x0e752702 repayBorrow(uint256)      VBep20 impl 0xCDfe…941e
 *   0xa0712d68 mint(uint256)             VBep20 impl 0xCDfe…941e
 *   0x095ea7b3 approve(address,uint256)  underlying (standard ERC-20)
 *   0x86df31ee claimVenus(address,address[])  Comptroller facet 0x9e0C…416f
 *   0xba437c68 claimInterest(address,address) Prime impl 0x18cb…3a1b
 *
 * REFUSED, and named here so the refusal is auditable rather than incidental:
 * `borrow` 0xc5ebeaec, `redeem` 0xdb006a75, `redeemUnderlying` 0x852a12e3,
 * `enterMarkets` 0xc2998238, `exitMarket` 0xede4edd0, every VAI selector, and
 * `multicall`. They exist on the deployed contracts (likewise located), which
 * is what makes refusing them meaningful.
 */

export const VENUS_COMPTROLLER_ABI = [
  { type: "function", name: "getAllMarkets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getAssetsIn", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address[]" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "deviationBoundedOracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "vaiController", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getXVSAddress", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "prime", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "protocolPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "lastPoolId", stateMutability: "view", inputs: [], outputs: [{ type: "uint96" }] },
  { type: "function", name: "userPoolId", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint96" }] },
  {
    type: "function", name: "markets", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [
      { name: "isListed", type: "bool" }, { name: "collateralFactorMantissa", type: "uint256" },
      { name: "isVenus", type: "bool" }, { name: "liquidationThresholdMantissa", type: "uint256" },
      { name: "liquidationIncentiveMantissa", type: "uint256" }, { name: "poolId", type: "uint96" },
      { name: "isBorrowAllowed", type: "bool" },
    ],
  },
  {
    type: "function", name: "getEffectiveLtvFactor", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint8" }], outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "getBorrowingPower", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "getAccountLiquidity", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "supplyCaps", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "actionPaused", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint8" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "venusAccrued", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "claimVenus", stateMutability: "nonpayable",
    inputs: [{ name: "holder", type: "address" }, { name: "vTokens", type: "address[]" }], outputs: [],
  },
] as const;

/** The Diamond loupe fragment R3.12 re-censuses `claimVenus`'s routing with. */
export const DIAMOND_LOUPE_ABI = [
  { type: "function", name: "facetAddress", stateMutability: "view", inputs: [{ name: "selector", type: "bytes4" }], outputs: [{ type: "address" }] },
] as const;

export const VENUS_VTOKEN_ABI = [
  {
    type: "function", name: "getAccountSnapshot", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
  { type: "function", name: "borrowBalanceCurrent", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "exchangeRateCurrent", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "exchangeRateStored", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const VENUS_ORACLE_ABI = [
  { type: "function", name: "getUnderlyingPrice", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const VENUS_DBO_ABI = [
  {
    type: "function", name: "getBoundedPricesView", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ name: "collateralPrice", type: "uint256" }, { name: "debtPrice", type: "uint256" }],
  },
] as const;

export const VENUS_VAI_CONTROLLER_ABI = [
  { type: "function", name: "getVAIRepayAmount", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const VENUS_ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }],
  },
] as const;

export const VENUS_PRIME_ABI = [
  { type: "function", name: "isUserPrimeHolder", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "getPendingRewardsStatic", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ name: "pendingRewards", type: "tuple[]", components: [
      { name: "vToken", type: "address" }, { name: "rewardToken", type: "address" }, { name: "amount", type: "uint256" },
    ] }],
  },
  {
    type: "function", name: "claimInterest", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }],
  },
] as const;

/** vBEP-20 write surface: the two granted selectors, nothing else. */
export const VENUS_VBEP20_WRITE_ABI = [
  { type: "function", name: "repayBorrow", stateMutability: "nonpayable", inputs: [{ name: "repayAmount", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "mintAmount", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

/** vBNB write surface: both payable, the amount IS `msg.value` (R2.16/R29). */
export const VENUS_VBNB_WRITE_ABI = [
  { type: "function", name: "repayBorrow", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "mint", stateMutability: "payable", inputs: [], outputs: [] },
] as const;
