/** The position page PancakeSwap shows for a V3 NFT — the same link the LP detail and the DCA detail use. */
export function pancakePositionUrl(tokenId: string): string {
  return `https://pancakeswap.finance/liquidity/${tokenId}`;
}
