/**
 * A bounded TTL cache with single-flight per key, shared by every public MCP read.
 *
 * State lives on `globalThis` so two route bundles that both include this module (or a dev HMR reload)
 * still share one cache; a duplicated module would otherwise double the upstream reads it exists to prevent.
 * A failed load is never cached and never poisons the key: every waiter of that flight sees the failure,
 * the next call tries again.
 */
export const MAX_CACHE_ENTRIES = 500;

type Entry = { at: number; value: unknown };
type Store = { entries: Map<string, Entry>; flights: Map<string, Promise<unknown>> };
const SLOT = "__4lphaMcpTtlCache";
function store(): Store {
  const holder = globalThis as unknown as Record<string, Store | undefined>;
  return (holder[SLOT] ??= { entries: new Map(), flights: new Map() });
}

function makeRoom(entries: Map<string, Entry>, now: number, ttlMs: number): void {
  if (entries.size < MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of entries) if (now - entry.at >= ttlMs) entries.delete(key);
  // Still full: drop the oldest insertions (Map keeps insertion order) so a key flood cannot grow the process.
  for (const key of entries.keys()) {
    if (entries.size < MAX_CACHE_ENTRIES) break;
    entries.delete(key);
  }
}

export async function cachedFlight<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const { entries, flights } = store();
  const hit = entries.get(key);
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value as T;
  const flying = flights.get(key);
  if (flying !== undefined) return flying as Promise<T>;
  const flight = (async () => {
    try {
      const value = await load();
      const now = Date.now();
      entries.delete(key);
      makeRoom(entries, now, ttlMs);
      entries.set(key, { at: now, value });
      return value;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight;
}

export function cacheSize(): number {
  return store().entries.size;
}

/** Test seam: forget every cached value and flight. */
export function resetTtlCache(): void {
  const { entries, flights } = store();
  entries.clear();
  flights.clear();
}
