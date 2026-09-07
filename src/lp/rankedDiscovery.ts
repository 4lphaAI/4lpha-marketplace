/**
 * The discovery half of PHASE3.10 Revision 2 items 5–7.
 *
 * An LP session is provisioned for one volatile token plus WBNB. The chain is
 * still the authority on whether that session may act NOW, but it exposes no
 * enumerable "all token grants" read. `best-apr` therefore discovers only the
 * canonical token persisted in the grant snapshot; an explicitly named pool
 * keeps the existing chain-widening fallback in `gateLpPool`.
 */
import { getAddress, isAddress, type Address } from "viem";
import type { SessionSpec } from "../core/types.js";
import { grantsTokenSell } from "../ops/policy.js";

export type LpRankedDiscovery =
  | { readonly ok: true; readonly token: Address }
  | { readonly ok: false; readonly candidateCount: number };

/**
 * Finds the ONE persisted non-WBNB token carrying BOTH halves of sell
 * authority. Deduplication is address-case-insensitive because two cap periods
 * for one token are still one discovery token.
 */
export function lpRankedDiscoveryToken(
  spec: SessionSpec,
  wbnb: Address,
): LpRankedDiscovery {
  const wbnbKey = wbnb.toLowerCase();
  const candidates = new Map<string, Address>();

  for (const cap of spec.spendCaps) {
    const raw = cap.token;
    if (raw === undefined || !isAddress(raw, { strict: false })) continue;
    const token = getAddress(raw);
    const key = token.toLowerCase();
    if (key === wbnbKey || candidates.has(key)) continue;
    if (grantsTokenSell(spec, token)) candidates.set(key, token);
  }

  const tokens = [...candidates.values()];
  const token = tokens[0];
  if (tokens.length !== 1 || token === undefined) {
    return { ok: false, candidateCount: tokens.length };
  }
  return { ok: true, token };
}
