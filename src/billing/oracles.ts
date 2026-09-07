import { getAddress, type Address } from "viem";
import type { OracleFeed, OracleSnapshot } from "./types.js";

export type OracleManifestEntry = Readonly<{
  feed: OracleFeed;
  chainId: bigint;
  proxy: Address;
  decimals: number;
  description: string;
  maxAgeSec?: number;
  sequencerGraceSec?: number;
}>;

export const ORACLE_MANIFEST: Readonly<Record<OracleFeed, OracleManifestEntry>> = Object.freeze({
  "0G_USD": {
    feed: "0G_USD",
    chainId: 42_161n,
    proxy: getAddress("0x47C38C695639aE97A00f57D6D9f5ece1DebB033C"),
    decimals: 8,
    description: "0G / USD",
    maxAgeSec: 90_000,
  },
  "BNB_USD": {
    feed: "BNB_USD",
    chainId: 56n,
    proxy: getAddress("0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE"),
    decimals: 8,
    description: "BNB / USD",
    maxAgeSec: 90,
  },
  "ARBITRUM_SEQUENCER": {
    feed: "ARBITRUM_SEQUENCER",
    chainId: 42_161n,
    proxy: getAddress("0xFdB631F5EE196F0ed6FAa767959853A9F217697D"),
    decimals: 0,
    description: "L2 Sequencer Uptime Status Feed",
    sequencerGraceSec: 3_600,
  },
});

export type OracleObservation = Readonly<{
  chainId: bigint;
  proxy: string;
  description: string;
  decimals: number;
  roundId: bigint;
  answer: bigint;
  startedAt: number;
  updatedAt: number;
  answeredInRound: bigint;
}>;

const oracleProvenance = new WeakMap<object, Readonly<{ origin: string; feed: OracleFeed }>>();

/**
 * Attach provenance only after reviewed transport code has reduced raw bytes
 * from the exact boot-pinned call. Worker code never trusts an origin label
 * carried by an observation itself.
 */
export function bindTransportOracleObservation(
  origin: string,
  feed: OracleFeed,
  observation: OracleObservation,
): OracleObservation {
  const bound = Object.freeze({ ...observation });
  oracleProvenance.set(bound, { origin, feed });
  return bound;
}

export function assertTransportOracleProvenance(
  observation: OracleObservation,
  origin: string,
  feed: OracleFeed,
): void {
  const provenance = oracleProvenance.get(observation);
  if (provenance?.origin !== origin || provenance.feed !== feed) {
    throw new Error("ORACLE_UNAVAILABLE");
  }
}

function sameObservation(a: OracleObservation, b: OracleObservation): boolean {
  return a.chainId === b.chainId &&
    a.proxy.toLowerCase() === b.proxy.toLowerCase() &&
    a.description === b.description &&
    a.decimals === b.decimals &&
    a.roundId === b.roundId &&
    a.answer === b.answer &&
    a.startedAt === b.startedAt &&
    a.updatedAt === b.updatedAt &&
    a.answeredInRound === b.answeredInRound;
}

/** Validate two independent RPC observations and reduce them to stored evidence. */
export function validateOraclePair(
  feed: OracleFeed,
  a: OracleObservation,
  b: OracleObservation,
  now: number,
): OracleSnapshot {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Oracle clock must be an integer Unix second.");
  const manifest = ORACLE_MANIFEST[feed];
  if (!sameObservation(a, b)) throw new Error("ORACLE_UNAVAILABLE");
  if (
    a.chainId !== manifest.chainId ||
    a.proxy.toLowerCase() !== manifest.proxy.toLowerCase() ||
    a.description !== manifest.description ||
    a.decimals !== manifest.decimals
  ) {
    throw new Error("ORACLE_UNAVAILABLE");
  }
  if (
    a.roundId < 0n ||
    a.answeredInRound < a.roundId ||
    !Number.isSafeInteger(a.startedAt) ||
    !Number.isSafeInteger(a.updatedAt) ||
    a.startedAt <= 0 ||
    a.updatedAt <= 0 ||
    a.startedAt > now + 5 ||
    a.updatedAt > now + 5
  ) {
    throw new Error("ORACLE_UNAVAILABLE");
  }

  if (feed === "ARBITRUM_SEQUENCER") {
    if (a.answer !== 0n) throw new Error("SEQUENCER_UNAVAILABLE");
    const grace = manifest.sequencerGraceSec;
    if (grace === undefined || now - a.startedAt < grace) throw new Error("SEQUENCER_UNAVAILABLE");
  } else {
    if (a.answer <= 0n) throw new Error("ORACLE_UNAVAILABLE");
    const maxAge = manifest.maxAgeSec;
    if (maxAge === undefined || now - a.updatedAt > maxAge) throw new Error("ORACLE_STALE");
  }

  return {
    feed,
    chainId: a.chainId,
    proxy: manifest.proxy.toLowerCase(),
    roundId: a.roundId,
    answer: a.answer,
    decimals: a.decimals,
    startedAt: a.startedAt,
    updatedAt: a.updatedAt,
    answeredInRound: a.answeredInRound,
  };
}

/** Revalidate a persisted snapshot against the reviewed feed manifest/time. */
export function assertOracleSnapshot(feed: OracleFeed, snapshot: OracleSnapshot, now: number): void {
  if (snapshot.feed !== feed) throw new Error("ORACLE_UNAVAILABLE");
  const observation: OracleObservation = {
    chainId: snapshot.chainId,
    proxy: snapshot.proxy,
    description: ORACLE_MANIFEST[feed].description,
    decimals: snapshot.decimals,
    roundId: snapshot.roundId,
    answer: snapshot.answer,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    answeredInRound: snapshot.answeredInRound,
  };
  const normalized = validateOraclePair(feed, observation, observation, now);
  if (JSON.stringify(normalized, bigintJson) !== JSON.stringify(snapshot, bigintJson)) {
    throw new Error("ORACLE_UNAVAILABLE");
  }
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function assertOracleQuoteSet(input: Readonly<{
  ogNeuron: bigint;
  bnb: OracleSnapshot;
  og?: OracleSnapshot;
  sequencer?: OracleSnapshot;
  quoteTimestamp: number;
}>): void {
  assertOracleSnapshot("BNB_USD", input.bnb, input.quoteTimestamp);
  if (input.ogNeuron === 0n) {
    if (input.og !== undefined || input.sequencer !== undefined) {
      throw new Error("USDC-only quotes must not bind 0G oracle evidence.");
    }
    return;
  }
  if (input.og === undefined || input.sequencer === undefined) throw new Error("ORACLE_UNAVAILABLE");
  assertOracleSnapshot("0G_USD", input.og, input.quoteTimestamp);
  assertOracleSnapshot("ARBITRUM_SEQUENCER", input.sequencer, input.quoteTimestamp);
  if (Math.abs(input.og.updatedAt - input.bnb.updatedAt) > 90_000) throw new Error("ORACLE_STALE");
}
