/**
 * TRADFI-EXPIRY-KEEP-REMOVE §2.1 / §7 — the pure inert-submission predicate, its
 * durable disposition evidence, the recognition rule, and the reader timestamp.
 * One isolated vector per clause: every test changes exactly ONE thing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custom, decodeFunctionData, encodeFunctionResult, getAddress, keccak256, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { KEYSTORE_ABI } from "../src/wallet/abis.js";
import {
  createKeyStoreReader,
  readFinalizedSessionRevocation,
  type FinalizedSessionRevocationVerdict,
  type KeyStoreBlockReference,
  type KeyStoreReader,
} from "../src/account/keyStoreReader.js";
import type { SessionFacts } from "../src/store/agents.js";
import { MemoryExecutionJournal, type JournalEntry } from "../src/store/journal.js";
import { MemoryTradeIntentStore, type TradeIntentRecord } from "../src/store/tradeIntents.js";
import {
  INERT_EVIDENCE_MAX_BYTES,
  encodeInertEvidence,
  inertDispositionEvidence,
  isDisposedInertSubmission,
  isInertSubmissionCandidate,
  isInertTradeSubmission,
  parseInertEvidence,
  type InertEvidence,
  type InertSubmissionInput,
} from "../src/trade/inertSubmission.js";

const OWNER = getAddress("0x1000000000000000000000000000000000000001");
const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const OTHER_WALLET = getAddress("0x2000000000000000000000000000000000000003");
const KEYSTORE = getAddress("0x3000000000000000000000000000000000000003");
const OTHER_KEYSTORE = getAddress("0x3000000000000000000000000000000000000004");
const TOKEN = getAddress("0x4000000000000000000000000000000000000004");
const PUBLIC_KEY = `0x04${"51".repeat(64)}` as Hex;
const OTHER_PUBLIC_KEY = `0x04${"52".repeat(64)}` as Hex;
const KEY_ID = keccak256(PUBLIC_KEY);
const BLOCK_HASH = `0x${"61".repeat(32)}` as Hex;
const IDEMPOTENCY = `0x${"44".repeat(32)}` as Hex;
const OTHER_IDEMPOTENCY = `0x${"45".repeat(32)}` as Hex;
const TX = `0x${"55".repeat(32)}` as Hex;
/** The 2026-09-21 incident agent: expiry 1790617224 (2026-09-28T17:40:24Z), generation 0. */
const EXPIRY = 1_790_617_224;
const FINAL_TIME = EXPIRY + 3_000;

function sessionFacts(over: { readonly publicKey?: Hex; readonly expiry?: unknown; readonly generation?: number | undefined } = {}): SessionFacts {
  return {
    spec: {}, permissions: { calls: [], spend: [] },
    publicKey: over.publicKey ?? PUBLIC_KEY,
    expiry: (Object.hasOwn(over, "expiry") ? over.expiry : EXPIRY) as number,
    ...(over.generation === undefined ? {} : { generation: over.generation }),
  } as unknown as SessionFacts;
}

function agent(facts: SessionFacts | null = sessionFacts()): Pick<InertSubmissionInput["agent"], "walletAddress" | "sessionFacts"> {
  return { walletAddress: WALLET, sessionFacts: facts };
}

async function intentRow(over: { readonly side?: "buy" | "sell"; readonly scheduleSlot?: number; readonly portfolioSlot?: number;
  readonly idempotencyKey?: Hex } = {}): Promise<TradeIntentRecord> {
  const store = new MemoryTradeIntentStore(() => 1_000);
  return store.create({ decisionId: "decision-1", idempotencyKey: over.idempotencyKey ?? IDEMPOTENCY, agentId: "agent-1", ownerAddress: OWNER,
    side: over.side ?? "sell", token: TOKEN, route: { hops: [], fees: [] }, amountWei: 5n, entryWei: 5n,
    positionId: "position-1", closeReason: "llm",
    ...(over.scheduleSlot === undefined ? {} : { scheduleSlot: over.scheduleSlot }),
    ...(over.portfolioSlot === undefined ? {} : { portfolioSlot: over.portfolioSlot }) });
}

async function journalRow(over: { readonly state?: "PENDING" | "IN_PROGRESS" | "COMMITTED" | "ROLLED_BACK" | "UNKNOWN"; readonly kind?: "trade" | "execute";
  readonly publicKey?: Hex | undefined | "absent"; readonly generation?: number; readonly txHash?: Hex; readonly idempotencyKey?: Hex } = {}): Promise<JournalEntry> {
  const journal = new MemoryExecutionJournal(() => 1_000);
  const key = over.idempotencyKey ?? IDEMPOTENCY;
  await journal.begin({ idempotencyKey: key, agentId: "agent-1", ownerAddress: OWNER, kind: over.kind ?? "trade", decisionId: "decision-1",
    externalRef: { paramsHash: `0x${"77".repeat(32)}` as Hex,
      ...(over.publicKey === "absent" ? {} : { publicKey: over.publicKey ?? PUBLIC_KEY }),
      ...(over.generation === undefined ? {} : { sessionGeneration: over.generation }) } });
  const state = over.state ?? "UNKNOWN";
  if (state === "UNKNOWN") await journal.markUnknown(key, "provider error -32602: please assign a tracer");
  else if (state === "IN_PROGRESS") await journal.markInProgress(key, { callsId: `0x${"88".repeat(32)}` as Hex });
  else if (state === "COMMITTED") await journal.markCommitted(key, over.txHash === undefined ? {} : { txHash: over.txHash });
  else if (state === "ROLLED_BACK") await journal.markRolledBack(key, "refused");
  return (await journal.get(key))!;
}

function withHash(row: JournalEntry): JournalEntry {
  return { ...row, externalRef: { ...row.externalRef, txHash: TX } };
}

function verdict(kind: "invalid" | "missing" = "invalid", over: {
  readonly blockTimeSec?: number; readonly walletAddress?: Address; readonly chainId?: number; readonly keyStoreAddress?: Address;
  readonly sessionPublicKey?: Hex; readonly keyId?: Hex } = {}): FinalizedSessionRevocationVerdict {
  return {
    kind,
    observation: { blockNumber: "101", blockHash: BLOCK_HASH, blockTimeSec: over.blockTimeSec ?? FINAL_TIME },
    evidence: { version: 1, chainId: over.chainId ?? 56, keyStoreAddress: over.keyStoreAddress ?? KEYSTORE,
      walletAddress: over.walletAddress ?? WALLET, keyId: over.keyId ?? KEY_ID, sessionPublicKey: over.sessionPublicKey ?? PUBLIC_KEY,
      verdict: kind, blockNumber: "101", blockHash: BLOCK_HASH, observedAtMs: 1 },
  };
}

async function input(over: Partial<InertSubmissionInput> = {}): Promise<InertSubmissionInput> {
  return { intent: await intentRow(), journal: await journalRow(), agent: agent(),
    expected: { wallet: WALLET, chainId: 56, registry: KEYSTORE }, evidence: verdict(), ...over };
}

describe("isInertTradeSubmission — S1 identity, one field at a time", () => {
  it("the incident vector (hashless UNKNOWN sell, current generation-0 key, dead at a finalized block) is eligible", async () => {
    assert.equal(isInertTradeSubmission(await input()), true);
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("missing") })), true);
    assert.equal(isInertSubmissionCandidate(await input()), true);
  });

  const s1: readonly (readonly [string, () => Promise<Partial<InertSubmissionInput>>])[] = [
    ["a buy", async () => ({ intent: await intentRow({ side: "buy" }) })],
    ["a schedule slot", async () => ({ intent: await intentRow({ scheduleSlot: 0 }) })],
    ["a portfolio slot", async () => ({ intent: await intentRow({ portfolioSlot: 0 }) })],
    ["an intent tx hash", async () => ({ intent: { ...(await intentRow()), txHash: TX } })],
    ["a journal tx hash", async () => ({ journal: withHash(await journalRow()) })],
    ["a non-trade journal kind", async () => ({ journal: await journalRow({ kind: "execute" }) })],
    ["journal state PENDING", async () => ({ journal: await journalRow({ state: "PENDING" }) })],
    ["journal state IN_PROGRESS", async () => ({ journal: await journalRow({ state: "IN_PROGRESS" }) })],
    ["journal state COMMITTED", async () => ({ journal: await journalRow({ state: "COMMITTED" }) })],
    ["journal state ROLLED_BACK", async () => ({ journal: await journalRow({ state: "ROLLED_BACK" }) })],
    ["an idempotency mismatch", async () => ({ journal: await journalRow({ idempotencyKey: OTHER_IDEMPOTENCY }) })],
    ["a non-pending intent", async () => ({ intent: { ...(await intentRow()), state: "projected" as const } })],
    ["a rolled-back intent", async () => ({ intent: { ...(await intentRow()), state: "rolled-back" as const } })],
    ["a null journal", async () => ({ journal: null })],
    ["a missing journal public key", async () => ({ journal: await journalRow({ publicKey: "absent" }) })],
    ["a malformed journal public key", async () => ({ journal: await journalRow({ publicKey: "0x1234" as Hex }) })],
    ["a compressed journal public key", async () => ({ journal: await journalRow({ publicKey: `0x02${"51".repeat(32)}` as Hex }) })],
  ];
  for (const [name, build] of s1) {
    it(`refuses ${name}`, async () => {
      const changed = await input(await build());
      assert.equal(isInertTradeSubmission(changed), false);
      assert.equal(isInertSubmissionCandidate(changed), false);
    });
  }
});

describe("isInertTradeSubmission — S2 the submitting key is the CURRENT key and it is dead at a finalized block", () => {
  it("is true only for invalid and missing; registered and unreadable are false", async () => {
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid") })), true);
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("missing") })), true);
    assert.equal(isInertTradeSubmission(await input({ evidence: { kind: "registered", observation: { blockNumber: "101", blockHash: BLOCK_HASH, blockTimeSec: FINAL_TIME } } })), false);
    assert.equal(isInertTradeSubmission(await input({ evidence: { kind: "unreadable" } })), false);
  });

  it("finalized-before-grant-missing-does-not-dispose", async () => {
    // `missing` read at a block BEFORE the key's recorded expiry (e.g. before the grant landed) proves nothing.
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("missing", { blockTimeSec: EXPIRY - 3_600 }) })), false);
  });

  it("block-time-before-expiry-refuses (exact boundary: expiry - 1 false, expiry true)", async () => {
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { blockTimeSec: EXPIRY - 1 }) })), false);
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { blockTimeSec: EXPIRY }) })), true);
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { blockTimeSec: EXPIRY + 1 }) })), true);
  });

  it("expiry-missing-zero-malformed-refuses", async () => {
    for (const expiry of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1790617224"]) {
      assert.equal(isInertTradeSubmission(await input({ agent: agent(sessionFacts({ expiry })) })), false, String(expiry));
    }
    assert.equal(isInertTradeSubmission(await input({ agent: agent(null) })), false);
  });

  it("older-generation-without-submitting-key-proof-refuses", async () => {
    // The row was journalled under generation 0; the agent has since renewed to generation 1 (and a new key).
    assert.equal(isInertTradeSubmission(await input({ agent: agent(sessionFacts({ publicKey: OTHER_PUBLIC_KEY, generation: 1 })) })), false);
  });

  it("key-not-current-refuses", async () => {
    assert.equal(isInertTradeSubmission(await input({ agent: agent(sessionFacts({ publicKey: OTHER_PUBLIC_KEY })) })), false);
  });

  it("current-key-same-public-key-wrong-generation-refuses (changes ONLY the journal generation)", async () => {
    assert.equal(isInertTradeSubmission(await input({ journal: await journalRow({ generation: 1 }) })), false);
    assert.equal(isInertTradeSubmission(await input({ journal: await journalRow({ generation: 0 }) })), true);
    assert.equal(isInertTradeSubmission(await input({ agent: agent(sessionFacts({ generation: 2 })), journal: await journalRow({ generation: 2 }) })), true);
    // An absent generation reads as zero on both sides.
    assert.equal(isInertTradeSubmission(await input({ journal: await journalRow({}) , agent: agent(sessionFacts({})) })), true);
    assert.equal(isInertTradeSubmission(await input({ journal: await journalRow({}), agent: agent(sessionFacts({ generation: 1 })) })), false);
  });

  it("matches the journal key case-insensitively (the current key is compared lowercase)", async () => {
    const upper = `0x04${"AB".repeat(64)}` as Hex;
    const lower = upper.toLowerCase() as Hex;
    const id = keccak256(lower);
    const result = isInertTradeSubmission(await input({
      journal: await journalRow({ publicKey: upper }), agent: agent(sessionFacts({ publicKey: lower })),
      evidence: verdict("invalid", { sessionPublicKey: lower, keyId: id }) }));
    assert.equal(result, true);
  });
});

describe("isInertTradeSubmission — evidence provenance, one test per field (the predicate receives `expected`)", () => {
  it("evidence-wrong-wallet", async () => {
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { walletAddress: OTHER_WALLET }) })), false);
  });
  it("evidence-wrong-chain", async () => {
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { chainId: 97 }) })), false);
  });
  it("evidence-wrong-registry", async () => {
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { keyStoreAddress: OTHER_KEYSTORE }) })), false);
  });
  it("evidence-wrong-publicKey", async () => {
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { sessionPublicKey: OTHER_PUBLIC_KEY }) })), false);
  });
  it("evidence-wrong-keyId", async () => {
    assert.equal(isInertTradeSubmission(await input({ evidence: verdict("invalid", { keyId: keccak256(OTHER_PUBLIC_KEY) }) })), false);
  });
  it("the plane's own expected wallet / chain / registry are what the evidence is compared to", async () => {
    assert.equal(isInertTradeSubmission(await input({ expected: { wallet: OTHER_WALLET, chainId: 56, registry: KEYSTORE } })), false);
    assert.equal(isInertTradeSubmission(await input({ expected: { wallet: WALLET, chainId: 97, registry: KEYSTORE } })), false);
    assert.equal(isInertTradeSubmission(await input({ expected: { wallet: WALLET, chainId: 56, registry: OTHER_KEYSTORE } })), false);
  });
});

describe("the durable disposition evidence", () => {
  it("disposition-evidence-full-payload-roundtrips (430 bytes: 65-byte key, 32-byte hashes, both timestamps)", async () => {
    const built = await input({ evidence: { ...verdict("invalid"), observation: { blockNumber: "123456789", blockHash: BLOCK_HASH, blockTimeSec: 1_790_620_224 } } as FinalizedSessionRevocationVerdict });
    const text = inertDispositionEvidence(built);
    assert.equal(Buffer.byteLength(text, "utf8"), 430);
    assert.ok(Buffer.byteLength(text, "utf8") <= INERT_EVIDENCE_MAX_BYTES);
    assert.equal(INERT_EVIDENCE_MAX_BYTES, 1_024);
    const parsed = parseInertEvidence(text);
    assert.deepEqual(parsed, { v: 1, kind: "inert-ambiguous-sell", key: PUBLIC_KEY, verdict: "invalid", block: "123456789", blockHash: BLOCK_HASH,
      blockTimeSec: 1_790_620_224, expirySec: EXPIRY, journalKey: IDEMPOTENCY });
    assert.equal(text.startsWith('{"v":1,"kind":"inert-ambiguous-sell","key":"0x04'), true);
    const missing = inertDispositionEvidence(await input({ evidence: verdict("missing") }));
    assert.equal(parseInertEvidence(missing)?.verdict, "missing");
  });

  it("refuses to build a disposition for a submission that is not provably inert", async () => {
    await assert.rejects(async () => inertDispositionEvidence(await input({ evidence: { kind: "unreadable" } })), /not provably inert/u);
    await assert.rejects(async () => inertDispositionEvidence(await input({ evidence: verdict("invalid", { blockTimeSec: EXPIRY - 1 }) })), /not provably inert/u);
  });

  it("refuses an over-limit payload and rejects malformed, oversized and mis-versioned text", () => {
    const evidence: InertEvidence = { v: 1, kind: "inert-ambiguous-sell", key: PUBLIC_KEY, verdict: "invalid", block: "1", blockHash: BLOCK_HASH,
      blockTimeSec: 1, expirySec: 1, journalKey: "x".repeat(INERT_EVIDENCE_MAX_BYTES) };
    assert.throws(() => encodeInertEvidence(evidence), /too large/u);
    assert.equal(parseInertEvidence(JSON.stringify(evidence)), null);
    for (const bad of [null, undefined, "", "not json", "[]", "{}", JSON.stringify({ ...evidence, journalKey: "k", v: 2 }),
      JSON.stringify({ ...evidence, journalKey: "k", kind: "other" }), JSON.stringify({ ...evidence, journalKey: "k", verdict: "registered" }),
      JSON.stringify({ ...evidence, journalKey: "k", key: `0x04${"AB".repeat(64)}` }),
      JSON.stringify({ ...evidence, journalKey: "k", blockTimeSec: 0 }), JSON.stringify({ ...evidence, journalKey: "k", block: "0" })]) {
      assert.equal(parseInertEvidence(bad as string | null | undefined), null);
    }
    assert.notEqual(parseInertEvidence(JSON.stringify({ ...evidence, journalKey: "k" })), null);
  });
});

describe("isDisposedInertSubmission — the durable recognition rule (§2.3), each binding isolated", () => {
  async function disposed(over: { readonly evidence?: Partial<InertEvidence> | string | null; readonly intent?: Partial<TradeIntentRecord> | null; readonly journal?: JournalEntry } = {}) {
    const journal = over.journal ?? await journalRow();
    const base: InertEvidence = { v: 1, kind: "inert-ambiguous-sell", key: PUBLIC_KEY, verdict: "invalid", block: "101", blockHash: BLOCK_HASH,
      blockTimeSec: FINAL_TIME, expirySec: EXPIRY, journalKey: IDEMPOTENCY };
    const evidence = over.evidence === null ? undefined : typeof over.evidence === "string" ? over.evidence : encodeInertEvidence({ ...base, ...over.evidence });
    const intent = over.intent === null ? null : { ...(await intentRow()), state: "rolled-back" as const,
      ...(evidence === undefined ? {} : { dispositionEvidence: evidence }), ...over.intent } as TradeIntentRecord;
    return { intent, journal };
  }

  it("passes the disposed incident row", async () => {
    assert.equal(isDisposedInertSubmission(await disposed()), true);
  });

  const refusals: readonly (readonly [string, () => Promise<{ intent: TradeIntentRecord | null; journal: JournalEntry }>])[] = [
    ["a missing intent", () => disposed({ intent: null })],
    ["an ordinary rollback without evidence", () => disposed({ evidence: null })],
    ["exemption-non-rolled-back-with-valid-evidence-refuses (a projected intent with otherwise valid evidence)", () => disposed({ intent: { state: "projected" } })],
    ["a pending intent with valid evidence", () => disposed({ intent: { state: "pending" } })],
    ["evidence version wrong", () => disposed({ evidence: JSON.stringify({ v: 2 }) })],
    ["evidence kind wrong", () => disposed({ evidence: { kind: "other" as never } })],
    ["evidence key differs from the journal key", () => disposed({ evidence: { key: OTHER_PUBLIC_KEY } })],
    ["evidence journalKey differs from the journal key", () => disposed({ evidence: { journalKey: OTHER_IDEMPOTENCY } })],
    ["exemption-intent-journal-idempotency-mismatch-refuses (the intent's own key differs)", () => disposed({ intent: { idempotencyKey: OTHER_IDEMPOTENCY } })],
    ["a journal WITH a hash", async () => disposed({ journal: withHash(await journalRow()) })],
    ["a journal in PENDING", async () => disposed({ journal: await journalRow({ state: "PENDING" }) })],
    ["a journal in IN_PROGRESS", async () => disposed({ journal: await journalRow({ state: "IN_PROGRESS" }) })],
    ["another journal kind", async () => disposed({ journal: await journalRow({ kind: "execute" }) })],
    ["a journal without a public key", async () => disposed({ journal: await journalRow({ publicKey: "absent" }) })],
  ];
  for (const [name, build] of refusals) {
    it(`refuses ${name}`, async () => {
      assert.equal(isDisposedInertSubmission(await build()), false);
    });
  }
});

describe("reader-timestamp-missing-malformed-or-inconsistent-is-unreadable", () => {
  function reader(first: KeyStoreBlockReference, second: KeyStoreBlockReference, listed = false, valid = false): KeyStoreReader {
    return {
      async listKeys() { throw new Error("latest must not be used"); },
      async publicKeyFor() { throw new Error("latest must not be used"); },
      async finalizedBlock() { return first; },
      async blockAt(blockNumber) { return { ...second, number: blockNumber }; },
      async listKeysAt() { return listed ? [KEY_ID] : []; },
      async publicKeyForAt() { return PUBLIC_KEY; },
      async isValidKeyAt() { return valid; },
    };
  }
  async function read(first: KeyStoreBlockReference, second: KeyStoreBlockReference, listed = false, valid = false) {
    return readFinalizedSessionRevocation({ chainId: 56, keyStoreAddress: KEYSTORE, wallet: WALLET, keyId: KEY_ID,
      expectedPublicKey: PUBLIC_KEY, observedAtMs: 1, reader: reader(first, second, listed, valid) });
  }
  const at = (timestampSec?: bigint | null): KeyStoreBlockReference => ({ number: 101n, hash: BLOCK_HASH,
    ...(timestampSec === undefined ? {} : { timestampSec }) });

  it("returns the agreed timestamp, in whole seconds, on every verdict path", async () => {
    const missing = await read(at(1_700_000_000n), at(1_700_000_000n));
    assert.equal(missing.kind, "missing");
    if (missing.kind !== "missing") throw new Error("expected missing");
    assert.deepEqual(missing.observation, { blockNumber: "101", blockHash: BLOCK_HASH, blockTimeSec: 1_700_000_000 });
    const invalid = await read(at(1_700_000_001n), at(1_700_000_001n), true, false);
    assert.equal(invalid.kind, "invalid");
    if (invalid.kind === "invalid") assert.equal(invalid.observation.blockTimeSec, 1_700_000_001);
    const registered = await read(at(1_700_000_002n), at(1_700_000_002n), true, true);
    assert.equal(registered.kind, "registered");
    if (registered.kind === "registered") assert.equal(registered.observation.blockTimeSec, 1_700_000_002);
  });

  it("a missing, zero, negative, unsafe or differing timestamp is unreadable (both verdict paths)", async () => {
    for (const listed of [false, true]) {
      const cases: readonly (readonly [KeyStoreBlockReference, KeyStoreBlockReference])[] = [
        [at(), at(1_700_000_000n)],
        [at(1_700_000_000n), at()],
        [at(), at()],
        [at(null), at(null)],
        [at(0n), at(0n)],
        [at(-1n), at(-1n)],
        [at(BigInt(Number.MAX_SAFE_INTEGER) + 1n), at(BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
        [at(1_700_000_000n), at(1_700_000_001n)],
      ];
      for (const [first, second] of cases) {
        assert.deepEqual(await read(first, second, listed, false), { kind: "unreadable" });
      }
    }
  });

  it("still refuses a changed hash even when the timestamps agree", async () => {
    const changed = { ...at(1_700_000_000n), hash: `0x${"62".repeat(32)}` as Hex };
    assert.deepEqual(await read(at(1_700_000_000n), changed), { kind: "unreadable" });
  });
});

describe("production-reader-timestamp-propagation: createKeyStoreReader carries block.timestamp on BOTH header reads", () => {
  type Provider = { request(input: { readonly method: string; readonly params?: unknown }): Promise<unknown> };

  /** A JSON-RPC double behind viem's injectable transport: `finalized` and the numeric re-read are answered separately. */
  function provider(over: { readonly finalizedTime?: string | null; readonly secondTime?: string | null; readonly listed?: boolean; readonly valid?: boolean } = {}): Provider {
    const block = (number: string, timestamp: string | null | undefined): Record<string, unknown> => ({
      number, hash: BLOCK_HASH, parentHash: `0x${"60".repeat(32)}`, timestamp: timestamp === null ? undefined : timestamp ?? "0x6553f100",
      nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: `0x${"00".repeat(32)}`,
      stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, miner: `0x${"00".repeat(20)}`, difficulty: "0x0", totalDifficulty: "0x0",
      extraData: "0x", size: "0x1", gasLimit: "0x1", gasUsed: "0x0", uncles: [], transactions: [],
    });
    return {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x38";
        if (method === "eth_getBlockByNumber") {
          const tag = (params as readonly unknown[])[0];
          return tag === "finalized" ? block("0x65", over.finalizedTime) : block(String(tag), over.secondTime);
        }
        if (method === "eth_call") {
          const data = ((params as readonly { readonly data: Hex }[])[0]!).data;
          const call = decodeFunctionData({ abi: KEYSTORE_ABI, data });
          if (call.functionName === "getKeys") return encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "getKeys", result: over.listed === true ? [KEY_ID] : [] });
          if (call.functionName === "getPublicKey") return encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "getPublicKey", result: PUBLIC_KEY });
          if (call.functionName === "isValidKey") return encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", result: over.valid === true });
        }
        throw new Error(`unexpected rpc ${method}`);
      },
    };
  }

  async function read(over: Parameters<typeof provider>[0] = {}) {
    const reader = createKeyStoreReader({ network: { chain: bsc, chainId: 56, publicRpcUrl: "http://offline.invalid" }, rpcUrls: ["http://offline.invalid"],
      keyStore: KEYSTORE, transport: () => custom(provider(over), { retryCount: 0 }) });
    return readFinalizedSessionRevocation({ chainId: 56, keyStoreAddress: KEYSTORE, wallet: WALLET, keyId: KEY_ID, expectedPublicKey: PUBLIC_KEY, observedAtMs: 1, reader });
  }

  it("the agreed timestamp reaches the observation on the missing, invalid and registered paths", async () => {
    const time = 0x6553f100;
    const missing = await read();
    assert.equal(missing.kind, "missing");
    if (missing.kind === "missing") assert.deepEqual(missing.observation, { blockNumber: "101", blockHash: BLOCK_HASH, blockTimeSec: time });
    const invalid = await read({ listed: true, valid: false });
    assert.equal(invalid.kind, "invalid");
    if (invalid.kind === "invalid") assert.equal(invalid.observation.blockTimeSec, time);
    const registered = await read({ listed: true, valid: true });
    assert.equal(registered.kind, "registered");
    if (registered.kind === "registered") assert.equal(registered.observation.blockTimeSec, time);
  });

  it("a header without a timestamp, on EITHER read, is unreadable (each header's propagation is protected on its own)", async () => {
    for (const listed of [false, true]) {
      assert.deepEqual(await read({ listed, finalizedTime: null }), { kind: "unreadable" }, `finalized header without timestamp, listed=${listed}`);
      assert.deepEqual(await read({ listed, secondTime: null }), { kind: "unreadable" }, `numeric re-read without timestamp, listed=${listed}`);
    }
  });

  it("differing or non-positive timestamps between the two header reads are unreadable", async () => {
    for (const listed of [false, true]) {
      assert.deepEqual(await read({ listed, finalizedTime: "0x6553f100", secondTime: "0x6553f101" }), { kind: "unreadable" }, `differing, listed=${listed}`);
      assert.deepEqual(await read({ listed, finalizedTime: "0x0", secondTime: "0x0" }), { kind: "unreadable" }, `zero, listed=${listed}`);
    }
  });
});
