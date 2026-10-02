/** Read-only, receipt-verified fill details for Smart Portfolio history. */
import { getAddress, type Address, type Hex } from "viem";
import type { AgentRecord } from "../store/agents.js";
import type { JournalEntry } from "../store/journal.js";
import type { TradeIntentRecord } from "../store/tradeIntents.js";
import { hashCalls } from "../http/wire.js";
import { PANCAKE_V2_FACTORY_56 } from "../quant/config.js";
import { PANCAKE_V3_FACTORY_56 } from "../lp/readers.js";
import { UNISWAP_V3_ROUTER02_56 } from "../ops/venues.js";
import type { TradeRuntimeConfig } from "../ops/config.js";
import { USDT_56 } from "./settlement.js";
import { verifyTradfiV2Receipt, type TradfiV2ReceiptExpected, type TradfiV2ReceiptReader } from "./receipt.js";

const UNISWAP_V3_FACTORY_56: Address = getAddress("0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7");

export type PortfolioVerifiedFill = {
  readonly quantityAtomic: string;
  readonly quoteWei: string;
};

function storedWalletCalls(value: JournalEntry["externalRef"]["submittedCalls"]): TradfiV2ReceiptExpected["calls"] | null {
  if (value === undefined || value.length === 0) return null;
  try {
    return value.map((call) => {
      if (!/^\d{1,78}$/u.test(call.value) || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(call.data)) throw new Error("invalid submitted call");
      const amount = BigInt(call.value);
      if (amount < 0n || amount >= (1n << 256n)) throw new Error("invalid submitted call value");
      return { to: getAddress(call.to), value: amount, data: call.data };
    });
  } catch {
    return null;
  }
}

/** Rebuild the verifier input only from the immutable intent and matching journal. */
export async function verifyPortfolioFill(input: {
  readonly agent: AgentRecord;
  readonly intent: TradeIntentRecord;
  readonly journalEntry: JournalEntry;
  readonly txHash: Hex;
  readonly reader: TradfiV2ReceiptReader;
  readonly trade: TradeRuntimeConfig;
}): Promise<PortfolioVerifiedFill | null> {
  const { agent, intent, journalEntry, txHash, reader, trade } = input;
  if (journalEntry.state !== "COMMITTED" || intent.portfolioSlot == null || intent.settlementAsset !== "USDT"
    || journalEntry.ownerAddress.toLowerCase() !== intent.ownerAddress.toLowerCase()
    || journalEntry.agentId !== intent.agentId || journalEntry.decisionId !== intent.decisionId
    || journalEntry.externalRef.txHash?.toLowerCase() !== txHash.toLowerCase()) return null;

  const calls = storedWalletCalls(journalEntry.externalRef.submittedCalls);
  const callsHash = journalEntry.externalRef.callsHash;
  const sessionPublicKey = journalEntry.externalRef.publicKey;
  const sessionGeneration = journalEntry.externalRef.sessionGeneration;
  const minOutAtomic = intent.minOutAtomic;
  if (calls === null || callsHash === undefined || sessionPublicKey === undefined
    || sessionGeneration === undefined || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0
    || minOutAtomic === undefined || minOutAtomic === null
    || hashCalls(calls).toLowerCase() !== callsHash.toLowerCase()) return null;

  try {
    const observation = await reader.readFinalized(txHash);
    if (observation === null) return null;
    const base = {
      wallet: getAddress(agent.walletAddress), sessionPublicKey, sessionGeneration,
      callsHash, calls, side: intent.side, token: getAddress(intent.token), amountInAtomic: intent.amountWei,
      minOutAtomic, ...(intent.platformFeeAtomic == null ? {} : { platformFeeAtomic: intent.platformFeeAtomic }),
      ...(trade.feeTreasury === undefined ? {} : { feeTreasury: trade.feeTreasury }),
    } satisfies Omit<TradfiV2ReceiptExpected, "guard" | "directRoute">;

    let expected: TradfiV2ReceiptExpected;
    if (journalEntry.externalRef.guardQuote !== undefined) {
      expected = { ...base, guard: journalEntry.externalRef.guardQuote };
    } else {
      const venue = intent.venue;
      if (venue !== "pancake_v2" && venue !== "pancake_v3" && venue !== "uniswap_v3") return null;
      const router = venue === "pancake_v2" ? trade.venues.pancakeRouterV2
        : venue === "pancake_v3" ? trade.venues.pancakeRouterV3 : trade.venues.uniswapRouterV3;
      if (router === undefined || venue === "uniswap_v3" && router.toLowerCase() !== UNISWAP_V3_ROUTER02_56.toLowerCase()) return null;
      const path = intent.side === "buy" ? [USDT_56, ...intent.route.hops, intent.token] : [intent.token, ...intent.route.hops, USDT_56];
      const poolReadBlock = observation.finalizedBlock.number;
      const pools = venue === "pancake_v2"
        ? await reader.readV2Pools(PANCAKE_V2_FACTORY_56, path, poolReadBlock)
        : await reader.readV3Pools(venue === "pancake_v3" ? PANCAKE_V3_FACTORY_56 : UNISWAP_V3_FACTORY_56,
          path, intent.route.fees, poolReadBlock);
      if (pools === null) return null;
      expected = { ...base, directRoute: {
        kind: venue === "pancake_v2" ? "v2" : "v3", router, pools,
        blockNumber: observation.receipt.blockNumber, blockHash: observation.receipt.blockHash,
      } };
    }

    const result = verifyTradfiV2Receipt({ observation, expected });
    if (!result.ok) return null;
    const { actualInputAtomic, actualOutputAtomic, verifiedEntryAtomic, verifiedProceedsAtomic } = result.evidence;
    const quantityAtomic = intent.side === "buy" ? actualOutputAtomic : actualInputAtomic;
    const quoteWei = intent.side === "buy" ? verifiedEntryAtomic : verifiedProceedsAtomic;
    return quantityAtomic > 0n && quoteWei !== null && quoteWei > 0n
      ? { quantityAtomic: quantityAtomic.toString(10), quoteWei: quoteWei.toString(10) }
      : null;
  } catch {
    return null;
  }
}

type CacheEntry = { readonly expiresAtMs: number; readonly value: PortfolioVerifiedFill | null };

/** Single-flight cache with bounded RPC concurrency for the polled detail route. */
export function createPortfolioFillCache(options: {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly unavailableTtlMs?: number;
  readonly maxEntries?: number;
  readonly maxConcurrent?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const unavailableTtlMs = options.unavailableTtlMs ?? 10_000;
  const maxEntries = options.maxEntries ?? 512;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const cached = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<PortfolioVerifiedFill | null>>();
  const waiters: Array<() => void> = [];
  let active = 0;

  async function runBounded(load: () => Promise<PortfolioVerifiedFill | null>): Promise<PortfolioVerifiedFill | null> {
    if (active >= maxConcurrent) await new Promise<void>((resolve) => waiters.push(resolve));
    else active += 1;
    try { return await load(); }
    finally {
      const next = waiters.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  }

  return {
    async resolve(key: string, load: () => Promise<PortfolioVerifiedFill | null>): Promise<PortfolioVerifiedFill | null> {
      const at = now();
      const hit = cached.get(key);
      if (hit !== undefined && hit.expiresAtMs > at) {
        cached.delete(key);
        cached.set(key, hit);
        return hit.value;
      }
      if (hit !== undefined) cached.delete(key);
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const task = runBounded(load).catch(() => null).then((value) => {
        while (cached.size >= maxEntries && !cached.has(key)) {
          const oldest = cached.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          cached.delete(oldest);
        }
        cached.set(key, { value, expiresAtMs: now() + (value === null ? unavailableTtlMs : ttlMs) });
        return value;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, task);
      return task;
    },
  };
}
