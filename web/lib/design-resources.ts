/**
 * The design export referenced its bundled images through `window.__resources`
 * (see `ext_resources.json` in the export). That global was never defined by the
 * exported page, so every reference fell through to a relative `../../assets/…`
 * path that resolved to nothing. The images are real and shipped with the
 * export, so they are restored here under `public/design/`, keyed by the same
 * resource ids the design used.
 */
export const RESOURCES = {
  brandLogo: "/design/brand-logo.png",
  lpRebalanceUponly: "/design/lp-rebalance-uponly.png",
  lpRebalanceDownonly: "/design/lp-rebalance-downonly.png",
  lpRebalanceBothways: "/design/lp-rebalance-bothways.png",
  lpRebalanceSchedule: "/design/lp-rebalance-schedule.png",
  lpRebalanceSwapless: "/design/lp-rebalance-swapless.png",
  lpCompound: "/design/lp-compound.png",
  bnbChain: "/design/protocols/bnb-chain.png",
  erc8004: "/design/erc8004.png",
  altana: "/design/altana.png",
  zeroG: "/design/0g.svg",
} as const;
