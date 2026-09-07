/**
 * Server-side token-icon resolver. The data plane deliberately carries no
 * logoURI, so icons come from PancakeSwap's public token lists, fetched here
 * (BFF), cached in memory, and handed to the client as final image URLs only.
 */
if (typeof window !== "undefined") {
  throw new Error("lib/pools/token-icons.ts is server-only.");
}

const LISTS = [
  "https://tokens.pancakeswap.finance/pancakeswap-default.json",
  "https://tokens.pancakeswap.finance/pancakeswap-extended.json",
  "https://tokens.pancakeswap.finance/coingecko.json",
] as const;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type TokenListEntry = { address?: string; logoURI?: string; chainId?: number };

let cache: { readonly map: ReadonlyMap<string, string>; readonly at: number } | null = null;
let inflight: Promise<ReadonlyMap<string, string>> | null = null;

async function fetchLists(): Promise<ReadonlyMap<string, string>> {
  const map = new Map<string, string>();
  for (const url of LISTS) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        // Next fetch cache would also work, but the in-memory map below is
        // what the lookups hit; keep upstream fresh-ish.
        cache: "no-store",
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { tokens?: TokenListEntry[] };
      for (const token of payload.tokens ?? []) {
        if (token.chainId !== 56) continue;
        const address = token.address?.toLowerCase();
        if (!address || !token.logoURI || map.has(address)) continue;
        map.set(address, token.logoURI);
      }
    } catch {
      // A missing list degrades to fewer icons, never an error.
    }
  }
  return map;
}

export async function tokenIconMap(): Promise<ReadonlyMap<string, string>> {
  const now = Date.now();
  if (cache !== null && now - cache.at < CACHE_TTL_MS) return cache.map;
  if (inflight === null) {
    inflight = fetchLists().then((map) => {
      // Keep a stale non-empty cache over a fresh empty one (upstream outage).
      if (map.size > 0 || cache === null) cache = { map, at: Date.now() };
      inflight = null;
      return cache.map;
    });
  }
  return inflight;
}

export async function iconFor(address: string): Promise<string | null> {
  const map = await tokenIconMap();
  return tokenIconUrl(map, address);
}

/** The CDN also has assets absent from token lists (e.g. NVDAB, MUB, SNDKB).
 * This is cosmetic only; TokenIcon handles a CDN miss with a symbol badge.
 */
export function tokenIconUrl(map: ReadonlyMap<string, string>, address: string): string | null {
  if (!/^0x[\da-f]{40}$/iu.test(address)) return null;
  const listed = map.get(address.toLowerCase());
  if (listed !== undefined) {
    try { if (new URL(listed).protocol === "https:") return listed; } catch { /* Try the fixed CDN. */ }
  }
  return `https://tokens.pancakeswap.finance/images/${address.toLowerCase()}.png`;
}
