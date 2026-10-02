/**
 * TRADFI-EXPIRY-KEEP-REMOVE §2 — a hashless UNKNOWN sell whose submitting key is
 * provably dead at a FINALIZED block is inert: nothing can land under it any more.
 *
 * Pure. No I/O: the caller supplies the finalized KeyStore read and the plane's
 * own expectations, so every provenance rule below is a comparison, not a fetch.
 * The journal row is never touched by any of this; only the trade intent is
 * disposed, and the disposition carries the evidence that lets admission
 * recognise it again after a restart or a renewal.
 */
import { keccak256, type Address, type Hex } from "viem";
import type { FinalizedSessionRevocationVerdict } from "../account/keyStoreReader.js";
import type { SessionFacts } from "../store/agents.js";
import type { JournalEntry } from "../store/journal.js";
import type { TradeIntentRecord } from "../store/tradeIntents.js";

/** The stored disposition never exceeds this many bytes (the full payload is 430). */
export const INERT_EVIDENCE_MAX_BYTES = 1_024;

const UNCOMPRESSED_PUBLIC_KEY = /^0x04[0-9a-fA-F]{128}$/u;
const HASH32 = /^0x[0-9a-fA-F]{64}$/u;

export type InertEvidence = {
  readonly v: 1;
  readonly kind: "inert-ambiguous-sell";
  /** The submitting key, lowercase. */
  readonly key: Hex;
  readonly verdict: "invalid" | "missing";
  readonly block: string;
  readonly blockHash: Hex;
  readonly blockTimeSec: number;
  readonly expirySec: number;
  readonly journalKey: string;
};

/** Only the fields the rules read, so a caller holding raw rows needs no full store record. */
export type InertIntentFacts = Pick<TradeIntentRecord, "side" | "state" | "txHash" | "scheduleSlot" | "portfolioSlot" | "idempotencyKey">;
export type InertJournalFacts = Pick<JournalEntry, "kind" | "idempotencyKey" | "state" | "externalRef">;

export type InertSubmissionInput = {
  readonly intent: InertIntentFacts;
  readonly journal: InertJournalFacts | null;
  /** The CURRENT session facts: the submitting key must be this key. */
  readonly agent: { readonly walletAddress: Address; readonly sessionFacts: Pick<SessionFacts, "publicKey" | "expiry" | "generation"> | null };
  /** What the plane itself expects the finalized read to be about. */
  readonly expected: { readonly wallet: Address; readonly chainId: number; readonly registry: Address };
  /** ONE finalized KeyStore read for the row's key, with its block timestamp. */
  readonly evidence: FinalizedSessionRevocationVerdict;
};

function submittingKey(journal: Pick<JournalEntry, "externalRef"> | null): Hex | null {
  const key = journal?.externalRef.publicKey;
  return key !== undefined && UNCOMPRESSED_PUBLIC_KEY.test(key) ? key.toLowerCase() as Hex : null;
}

/**
 * S1 — identity. Cheap and local: the chain read is issued only when this holds.
 * PENDING and IN_PROGRESS rows are NOT covered (they can be in flight or gain a
 * hash while a read runs); UNKNOWN moves only by an owner action.
 */
export function isInertSubmissionCandidate(input: { readonly intent: InertIntentFacts; readonly journal: InertJournalFacts | null }): boolean {
  const { intent, journal } = input;
  return intent.side === "sell"
    && intent.state === "pending"
    && intent.txHash === null
    && (intent.scheduleSlot === undefined || intent.scheduleSlot === null)
    && (intent.portfolioSlot === undefined || intent.portfolioSlot === null)
    && journal !== null
    && journal.kind === "trade"
    && journal.idempotencyKey === intent.idempotencyKey
    && journal.externalRef.txHash === undefined
    && journal.state === "UNKNOWN"
    && submittingKey(journal) !== null;
}

/** S1 and S2: the submitting key is the agent's CURRENT key and it is dead at a finalized block. */
export function isInertTradeSubmission(input: InertSubmissionInput): boolean {
  const { intent, journal, agent, expected, evidence } = input;
  if (!isInertSubmissionCandidate({ intent, journal })) return false;
  const key = submittingKey(journal);
  const facts = agent.sessionFacts;
  if (key === null || facts === null) return false;
  // (a) exact identity with the current key; there is no historical path.
  if (key !== facts.publicKey.toLowerCase()) return false;
  if ((journal!.externalRef.sessionGeneration ?? 0) !== (facts.generation ?? 0)) return false;
  // (b) the finalized block is at or after the key's recorded expiry.
  if (!Number.isSafeInteger(facts.expiry) || facts.expiry <= 0) return false;
  // (c) the registry agrees, at that same block.
  if (evidence.kind !== "invalid" && evidence.kind !== "missing") return false;
  if (evidence.observation.blockTimeSec < facts.expiry) return false;
  // (d) the evidence is about this wallet, chain, registry and key.
  const proof = evidence.evidence;
  return proof.walletAddress.toLowerCase() === expected.wallet.toLowerCase()
    && proof.chainId === expected.chainId
    && proof.keyStoreAddress.toLowerCase() === expected.registry.toLowerCase()
    && proof.sessionPublicKey.toLowerCase() === key
    && proof.keyId.toLowerCase() === keccak256(key).toLowerCase();
}

/** The durable disposition text for an intent the predicate accepted. Over the limit ⇒ refuse. */
export function inertDispositionEvidence(input: InertSubmissionInput): string {
  const { journal, agent, evidence } = input;
  if (!isInertTradeSubmission(input) || evidence.kind === "registered" || evidence.kind === "unreadable") {
    throw new Error("The submission is not provably inert.");
  }
  const payload: InertEvidence = {
    v: 1, kind: "inert-ambiguous-sell", key: submittingKey(journal)!, verdict: evidence.kind,
    block: evidence.observation.blockNumber, blockHash: evidence.observation.blockHash,
    blockTimeSec: evidence.observation.blockTimeSec, expirySec: agent.sessionFacts!.expiry,
    journalKey: journal!.idempotencyKey,
  };
  return encodeInertEvidence(payload);
}

export function encodeInertEvidence(evidence: InertEvidence): string {
  const text = JSON.stringify(evidence);
  if (Buffer.byteLength(text, "utf8") > INERT_EVIDENCE_MAX_BYTES) throw new Error("Disposition evidence is too large.");
  return text;
}

export function parseInertEvidence(text: string | null | undefined): InertEvidence | null {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > INERT_EVIDENCE_MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row["v"] !== 1 || row["kind"] !== "inert-ambiguous-sell") return null;
  const { key, verdict, block, blockHash, blockTimeSec, expirySec, journalKey } = row;
  if (typeof key !== "string" || !UNCOMPRESSED_PUBLIC_KEY.test(key) || key !== key.toLowerCase()
    || (verdict !== "invalid" && verdict !== "missing")
    || typeof block !== "string" || !/^[1-9][0-9]*$/u.test(block)
    || typeof blockHash !== "string" || !HASH32.test(blockHash)
    || typeof blockTimeSec !== "number" || !Number.isSafeInteger(blockTimeSec) || blockTimeSec <= 0
    || typeof expirySec !== "number" || !Number.isSafeInteger(expirySec) || expirySec <= 0
    || typeof journalKey !== "string") return null;
  return { v: 1, kind: "inert-ambiguous-sell", key: key as Hex, verdict, block, blockHash: blockHash as Hex, blockTimeSec, expirySec, journalKey };
}

/**
 * §2.3 recognition of an ALREADY disposed row, from durable facts only: the
 * journal row stays UNKNOWN, and its intent is `rolled-back` WITH evidence bound
 * to that very row and key. An ordinary rollback never carries evidence.
 */
export function isDisposedInertSubmission(input: { readonly intent: TradeIntentRecord | null; readonly journal: JournalEntry }): boolean {
  const { intent, journal } = input;
  if (intent === null || journal.kind !== "trade" || journal.state !== "UNKNOWN" || journal.externalRef.txHash !== undefined) return false;
  const key = submittingKey(journal);
  if (key === null || intent.state !== "rolled-back" || intent.idempotencyKey !== journal.idempotencyKey) return false;
  const evidence = parseInertEvidence(intent.dispositionEvidence);
  return evidence !== null && evidence.key === key && evidence.journalKey === journal.idempotencyKey;
}
