/**
 * The first reviewed production profiles for the Quant rebalancer (listing prep, G1).
 * Written out literally: nothing here is read from a file at runtime. Equality with
 * the pinned capture is proven by `test/quant.rebalance.production-profile.test.ts`.
 */
import { REBALANCE_CAKE, REBALANCE_ETH, REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB } from "./rebalancePolicy.js";
import { rebalancePathKey } from "./rebalanceRoutes.js";
import type { QuantExpandedConfigProfile, QuantRebalanceCapabilityProfile } from "./rebalanceConfig.js";

/**
 * keccak256 of `MD here/QUANT-REBALANCING-G1-EVIDENCE.md` (exact bytes, `-text` in
 * `.gitattributes`). It binds the capability profile to that document and to nothing
 * more: the document's section (c) records that platform acceptance is still pending,
 * so nothing may call this profile indexer-proven or report-accepted.
 */
export const G1_EVIDENCE_DIGEST = "0xc9277fbdc54c7112660e1e5c63e37c82270e392e6976efaffda30ae558ddf9d9" as const;

/** The 2026-09-27 TermiX config capture: 7 tradable tokens, 14 venue rows over 12 unique targets. */
export const PRODUCTION_EXPANDED_CONFIG_PROFILE: QuantExpandedConfigProfile = {
  id: "termix-quant-config-2026-09-27-v1",
  capturedEvidenceRef: "C:/Users/Pro/Downloads/contracts.customization BF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46; test/fixtures/quant/contracts-customization-quant.json 7A925003313951FC0480E5A4F6CCD11A9F37D709838D7D23C2D455AE9D76880F",
  capturedEvidenceDigest: "0xBF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46",
  expected: {
    chainId: 56,
    u: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    uDecimals: 18,
    tradableTokens: [
      { address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", decimals: 18, priceRoute: "via_wbnb" },
      { address: "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe", decimals: 18, priceRoute: "via_wbnb" },
      { address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8", decimals: 18, priceRoute: "via_wbnb" },
      { address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", decimals: 18, priceRoute: "via_wbnb" },
      { address: "0xba2ae424d960c26247dd6c32edc70b295c744c43", decimals: 8, priceRoute: "via_wbnb" },
      { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", decimals: 18, priceRoute: "direct" },
      { address: "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd", decimals: 18, priceRoute: "via_wbnb" },
    ],
    venueRows: [
      { label: "Cake", kind: "token", address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", protocol: null, verified: true, auditUrl: null, officialUrl: "https://pancakeswap.finance" },
      { label: "PancakeSwap V2 Router", kind: "venue", address: "0x10ed43c718714eb63d5aa57b78b54704e256024e", protocol: "PancakeSwap V2", verified: true, auditUrl: "https://docs.pancakeswap.finance/developers/audits", officialUrl: "https://pancakeswap.finance" },
      { label: "XRP", kind: "token", address: "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe", protocol: null, verified: true, auditUrl: null, officialUrl: "https://xrpl.org" },
      { label: "ETH", kind: "token", address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8", protocol: null, verified: true, auditUrl: null, officialUrl: "https://ethereum.org" },
      { label: "BTCB", kind: "token", address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", protocol: null, verified: true, auditUrl: null, officialUrl: "https://www.bnbchain.org" },
      { label: "vBTC", kind: "token", address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", protocol: null, verified: true, auditUrl: null, officialUrl: "https://app.venus.io/" },
      { label: "Venus vBTC", kind: "money-market", address: "0x882c173bc7ff3b7786ca16dfed3dfffb9ee7847b", protocol: "Venus Core Pool", verified: true, auditUrl: null, officialUrl: "https://app.venus.io/" },
      { label: "USDC token", kind: "token", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", protocol: null, verified: true, auditUrl: null, officialUrl: "https://www.circle.com/usdc" },
      { label: "vUSDC", kind: "token", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", protocol: null, verified: true, auditUrl: null, officialUrl: "https://app.venus.io/" },
      { label: "DOGE", kind: "token", address: "0xba2ae424d960c26247dd6c32edc70b295c744c43", protocol: null, verified: true, auditUrl: null, officialUrl: "https://dogecoin.com" },
      { label: "WBNB", kind: "token", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", protocol: null, verified: true, auditUrl: null, officialUrl: "https://www.bnbchain.org" },
      { label: "Venus vUSDC", kind: "money-market", address: "0xeca88125a5adbe82614ffc12d0db554e2e2867c8", protocol: "Venus Core Pool", verified: true, auditUrl: null, officialUrl: "https://app.venus.io/" },
      { label: "LINK", kind: "token", address: "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd", protocol: null, verified: true, auditUrl: null, officialUrl: "https://chain.link" },
      { label: "Venus Comptroller", kind: "venue", address: "0xfd36e2c2a6789db23113685031d7f16329158384", protocol: "Venus Core Pool", verified: true, auditUrl: "https://docs-v4.venus.io/links/security-and-audits", officialUrl: "https://venus.io" },
    ],
  },
  expectedVenueRowCount: 14,
  expectedUniqueVenueTargetCount: 12,
};

/**
 * The six rehearsed execution paths (U-W, W-U, U-ETH, ETH-U, U-W-CAKE, CAKE-W-U) and their
 * six USDT-referenced comparison paths. No USDT-intermediate execution route (operator ruling D2).
 */
export const PRODUCTION_REBALANCE_CAPABILITY_PROFILE: QuantRebalanceCapabilityProfile = {
  id: "termix-rebalance-wizard-v1",
  capturedConfigProfileId: PRODUCTION_EXPANDED_CONFIG_PROFILE.id,
  wireVersion: "quant-job-v1",
  grantShapes: ["whole-contract"],
  // The wizard grants every strategy token (WBNB, ETH, CAKE) to every job whatever its allocation
  // (R4 operator ruling 2026-09-30), so a low-tier job carries ETH and CAKE it never trades.
  toleratedGrantTargets: [REBALANCE_ETH, REBALANCE_CAKE],
  duplicateWholeGrantTargets: [REBALANCE_USDC],
  executionRoutes: [
    rebalancePathKey([REBALANCE_USDC, REBALANCE_WBNB]), rebalancePathKey([REBALANCE_WBNB, REBALANCE_USDC]),
    rebalancePathKey([REBALANCE_USDC, REBALANCE_ETH]), rebalancePathKey([REBALANCE_ETH, REBALANCE_USDC]),
    rebalancePathKey([REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE]), rebalancePathKey([REBALANCE_CAKE, REBALANCE_WBNB, REBALANCE_USDC]),
  ],
  referenceRoutes: [
    rebalancePathKey([REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB]), rebalancePathKey([REBALANCE_WBNB, REBALANCE_USDT, REBALANCE_USDC]),
    rebalancePathKey([REBALANCE_USDC, REBALANCE_USDT, REBALANCE_ETH]), rebalancePathKey([REBALANCE_ETH, REBALANCE_USDT, REBALANCE_USDC]),
    rebalancePathKey([REBALANCE_USDC, REBALANCE_USDT, REBALANCE_CAKE]), rebalancePathKey([REBALANCE_CAKE, REBALANCE_USDT, REBALANCE_USDC]),
  ],
  // Relay-billed gas-equivalent ceiling (paymentMax / gasPrice), not on-chain gasUsed. The highest
  // observed two-hop paymentMax, 33,064,915,000,000 wei at 50,000,000 wei/gas, is 661,298.3 units,
  // rounded up to 661,299; 700,000 leaves 5.85238 % headroom. The relay quote pad and the local
  // x1.5 solvency pad compound deliberately (52,500,000,000,000 wei per future exit at that price,
  // so the 3e13 floor does not bind). The whole-contract two-hop overhead is not yet measured:
  // the pilot job measures it. See the G1 evidence document, section b.3.
  maximumExitGasUnits: 700_000n,
  indexingEvidenceDigest: G1_EVIDENCE_DIGEST,
  reportEvidenceDigest: G1_EVIDENCE_DIGEST,
};
