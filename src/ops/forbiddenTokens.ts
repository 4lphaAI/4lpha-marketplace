/** Pure token-role exclusion shared by normal LP admission and D1. */
import { zeroAddress, type Address } from "viem";
import type { VenueConfig } from "./venues.js";

export function forbiddenTokenAddresses(input: { readonly wallet: Address; readonly keyStore: Address;
  readonly venues: VenueConfig; readonly treasury?: Address }): ReadonlySet<string> {
  const out = new Set<string>([input.wallet.toLowerCase(), input.keyStore.toLowerCase(), zeroAddress.toLowerCase()]);
  for (const address of [input.venues.pancakeRouterV2, input.venues.pancakeRouterV3, input.venues.wbnb,
    input.venues.fourMemeTokenManager, input.venues.flapPortal, input.treasury]) {
    if (address !== undefined) out.add(address.toLowerCase());
  }
  return out;
}
