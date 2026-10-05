/** AGENTIC-RFQ-STOCKS offline fixtures: the 2026-10-04 production bStocks universe (50 rows), read through the production parser, and the corrected per-address rows. */
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { HttpTradeDataPlaneReads, type TradeDataPlaneReads, type UniverseRow } from "../../src/trade/dataPlaneReads.js";
import { createServer, type TradeAgentServerDeps } from "../../src/server.js";
import { MemoryAgentStore } from "../../src/store/agents.js";
import { MemoryExecutionJournal } from "../../src/store/journal.js";
import { MemoryNonceStore } from "../../src/store/nonces.js";
import { MemoryKillSwitch } from "../../src/killswitch/killswitch.js";
import { MemoryTradeSettingsStore } from "../../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../../src/store/tradeIntents.js";
import type { AgenticPairings } from "../../src/agentic/routes.js";
import type { TradeRuntimeConfig } from "../../src/ops/config.js";
import { CHAIN_ID, FakeDataPlane, FakeWalletProvider, KEY_STORE, NETWORK, EXEC_TOKEN, OPERATOR_TOKEN, tradeConfig } from "./serverHarness.js";

type Raw = { data: Record<string, unknown>[]; meta: Record<string, unknown> };
/** The lane asOf of the capture, 2026-10-04T17:26:41Z; venue rows carry asOf 1791135595256. */
export const RFQ_FIXTURE_AS_OF = 1_791_135_701_483;
/** The four per-address rows the data plane fills in D1 (on-chain `uiMultiplier() / 1e18`, spec 1.2). */
export const PER_ADDRESS_RATIOS: Readonly<Record<string, number>> = {
  PYPLB: 1.001771778813, AAPLB: 1.000603906076, COHRB: 1, CRDOB: 1,
};
export const PER_ADDRESS_SYMBOLS = Object.keys(PER_ADDRESS_RATIOS);

export function rawRfqUniverse(): Raw {
  return JSON.parse(readFileSync(new URL("../fixtures/agentic-rfq-universe-2026-10-04.json", import.meta.url), "utf8")) as Raw;
}

/** The corrected per-address rows (R3.8, R5.9, R4.5): ratio and decimals filled, `referencePriceUsd` the per-share price, `tokenPriceUsd` the fair token price, `premiumBps` the deepest priced venue against `referencePriceUsd x ratio`. */
export function correctedRfqUniverse(): Raw {
  const raw = rawRfqUniverse();
  raw.data = raw.data.map((row) => {
    const ratio = PER_ADDRESS_RATIOS[row["symbol"] as string];
    if (ratio === undefined) return row;
    const perShare = row["tokenPriceUsd"] as number;
    const venues = (row["venues"] as { priceUsd: number | null; liquidityUsd: number | null }[]).filter((venue) => venue.priceUsd !== null)
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    const premium = venues[0] === undefined ? null : Math.round((venues[0].priceUsd! / (perShare * ratio) - 1) * 10_000);
    return { ...row, decimals: 18, tokenToShareRatio: ratio, referencePriceUsd: perShare, tokenPriceUsd: perShare * ratio, premiumBps: premium };
  });
  return raw;
}

export async function loadRfqUniverse(corrected = false): Promise<readonly UniverseRow[]> {
  const body = corrected ? correctedRfqUniverse() : rawRfqUniverse();
  const reads = new HttpTradeDataPlaneReads({ baseUrl: "https://data-plane.test/", token: "t",
    fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }) });
  const rows = await reads.universe("bstocks");
  if (rows === null) throw new Error("fixture universe unreadable");
  return rows;
}

/** A fake data plane serving the fixture: the bstocks lane, an empty ondo lane, and rows for token and eligibility batches. */
export function rfqDataPlane(rows: readonly UniverseRow[], extra: Partial<TradeDataPlaneReads> = {}, clock: () => number = () => Date.now()): TradeDataPlaneReads {
  const symbols = new Map(rows.map((row) => [row.address.toLowerCase(), row.symbol]));
  return {
    universe: async (lane) => lane === "bstocks" ? rows : [],
    tokensBatch: async (addresses) => addresses.map((address) => ({ address, symbol: symbols.get(address.toLowerCase()) ?? "X", priceUsd: 1,
      marketCapUsd: 1_000_000_000, volume24hUsd: 10_000, holders: 100, priceChange24hPct: 0,
      asOf: clock(), source: "pancake-v3-slot0", staleness: "fresh" as const, updatedFields: ["priceUsd"] })),
    eligibilityBatch: async (addresses) => addresses.map((address) => ({ address, eligible: true, reason: "ok", source: "binance-rwa" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }),
    ...extra,
  } as TradeDataPlaneReads;
}

/** Registers the Agentic routes on a real server, so `pairings.pin` (and, once built, `pairings.rfqPin`) are the server's own closures. */
export function pinServer(input: { pairings: AgenticPairings; dataPlane: TradeDataPlaneReads; trade?: Partial<TradeRuntimeConfig>;
  guardVerified?: (guard: Address) => Promise<boolean>; probe?: TradeAgentServerDeps["tradfiV2CapabilityProbe"]; now?: () => number }): { provider: FakeWalletProvider } {
  const now = input.now ?? (() => Date.now());
  const provider = new FakeWalletProvider();
  const settingsStore = new MemoryTradeSettingsStore(new MemoryAgentStore(null, now), now);
  createServer({
    agentic: input.pairings, agentStore: new MemoryAgentStore(null, now), journal: new MemoryExecutionJournal(now), nonceStore: new MemoryNonceStore(),
    killswitch: new MemoryKillSwitch(now), providerRegistry: { get: () => provider }, dataPlane: new FakeDataPlane(),
    config: { chainId: CHAIN_ID, network: NETWORK, keyStore: KEY_STORE, execToken: EXEC_TOKEN, operatorToken: OPERATOR_TOKEN, now, trade: tradeConfig(input.trade) },
    tradeAgent: { settingsStore, positions: new MemoryTradePositionStore(now), intents: new MemoryTradeIntentStore(now), feeBps: 0,
      readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set<string>(), stop() {} },
      dataPlane: input.dataPlane, observer: { observe: async () => [] },
      ...(input.guardVerified === undefined ? {} : { guardVerified: input.guardVerified }),
      tradfiV2CapabilityProbe: input.probe ?? (async () => "capable" as const) },
  });
  return { provider };
}
