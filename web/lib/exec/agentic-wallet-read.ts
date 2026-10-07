/**
 * The ONE read of a public Agentic wallet (`GET /agentic/wallets/<addr>` on the execution plane), shared by the
 * agentic BFF (the `/agentic/<wallet>` page) and the public MCP `agent_status` tool, so the page and the MCP together
 * cause at most one execution read per wallet per 15 s. Extracted from the BFF unchanged: same 15 s window, only a
 * 2xx answer is cached, same key (the lowercased path), same 30 s timeout; env and fetch are read at call time.
 * Concurrent misses for one wallet share a single flight. State is held on `globalThis` so two route bundles that
 * both include this module still share one cache.
 */
export const AGENTIC_WALLET_TTL_MS = 15_000;
const TIMEOUT_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;

export type AgenticWalletRead = { readonly status: number; readonly body: string };
type Slot = { entries: Map<string, { at: number; read: AgenticWalletRead }>; flights: Map<string, Promise<AgenticWalletRead>> };
const SLOT = "__4lphaAgenticWalletRead";
function slot(): Slot {
  const holder = globalThis as unknown as Record<string, Slot | undefined>;
  return (holder[SLOT] ??= { entries: new Map(), flights: new Map() });
}

async function fetchRead(path: string): Promise<AgenticWalletRead> {
  const url = process.env["EXECUTION_URL"]?.trim(), token = process.env["EXECUTION_API_TOKEN"]?.trim();
  if (!url || !token) throw new Error("execution_unavailable");
  const upstream = await fetch(url.replace(/\/$/, "") + "/agentic/" + path, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json", "x-exec-token": token } });
  const envelope = JSON.parse(await upstream.text()) as unknown;
  return { status: upstream.status, body: JSON.stringify(envelope) };
}

/** `path` is `wallets/0x...`; the caller has already validated it. Throws on any transport or parse failure. */
export async function readAgenticWallet(path: string): Promise<AgenticWalletRead> {
  const { entries, flights } = slot(), key = path.toLowerCase();
  const saved = entries.get(key);
  if (saved !== undefined && Date.now() - saved.at < AGENTIC_WALLET_TTL_MS) return saved.read;
  const flying = flights.get(key);
  if (flying !== undefined) return flying;
  const flight = (async () => {
    try {
      const read = await fetchRead(path);
      if (read.status >= 200 && read.status < 300) {
        const now = Date.now();
        for (const [k, entry] of entries) if (now - entry.at >= AGENTIC_WALLET_TTL_MS) entries.delete(k);
        for (const k of entries.keys()) { if (entries.size < MAX_CACHE_ENTRIES) break; entries.delete(k); }
        entries.set(key, { at: now, read });
      }
      return read;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight;
}

/** Test seam. */
export function resetAgenticWalletRead(): void {
  const { entries, flights } = slot();
  entries.clear();
  flights.clear();
}
