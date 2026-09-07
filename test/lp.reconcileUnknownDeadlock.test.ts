/**
 * PHASE3.14 — reconcile manufactures an UNRESOLVABLE UNKNOWN.
 *
 * The live defect, mainnet 2026-08-25 (agent `lp-test3-20260825`, harvest
 * `c9abb529…` step 1, position `7253434`): the BSC relay answered
 * `{"status":300,"receipts":[]}` — stably, for 30+ minutes —
 * `toCallsStatusReceipt` maps nothing but 200/CONFIRMED/SUCCESS and
 * >=400/FAILED/REVERTED, so 300 read as PENDING; `reconcile` turned that into
 * `UNKNOWN`; `reconcile`'s own query is `state in ('PENDING','IN_PROGRESS')`, so
 * it never looked again; and `resolveUnknown` refused the row for carrying the
 * very `callsId` that was supposed to make it reconcile's job. Four doors, all
 * closed, on a position whose liquidity was intact.
 *
 * Why 2 267 green tests never saw it: NO FAKE EMITS AN UNMAPPED RELAY STATUS.
 * Every relay double answered 100/200/4xx/5xx or porto's strings. So the
 * journeys below drive a REAL `AltanaProvider` over a scripted transport that
 * answers an unmapped numeric (`300`) and an unmapped string (`"QUEUED"`), which
 * is the only way this file can prove anything the old suite could not.
 *
 * The repair under test is R-A′ (`PHASE3.14-…-REVIEW.md` §5): delete the
 * `has_calls_id` refusal (F1 — PHASE3.3-AUDIT A9 had already narrowed it to
 * UNKNOWN rows, so narrowing it by state IS deletion), and add ONE bounded
 * single-shot relay read inside the owner-signed resolver (F2) that may advance
 * on CONFIRMED, abandon on FAILED, and may NEVER refuse on unavailability.
 *
 * Test ids below are the review's own B1–B12.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custom, getAddress, type Address, type Hex, type Transport } from "viem";
import { BNB_TESTNET } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import {
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  reconcile,
  type ExecutionJournal,
  type JournalEntry,
  type JournalResolutionEvidence,
} from "../src/store/journal.js";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  deriveLpSequenceProgress,
  isTerminalLpSequence,
  lpStepDecisionId,
  type LpSequenceKind,
  type LpSequenceStore,
  type LpStepKind,
} from "../src/store/lpSequences.js";
import {
  verifyLpResolveUnknown,
  type LpResolveInput,
  type LpResolveVerdict,
} from "../src/lp/resolveUnknown.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import type { WalletProvider } from "../src/core/types.js";

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

const OWNER = getAddress("0x00000000000000000000000000000000000000A1");
const AGENT = "agent-3-14";
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const POSITION_ID = "pos-3-14";
const TOKEN_ID = "7253434";
const CALLS_ID = `0x${"1c".repeat(32)}` as Hex;
const TX_COLLECT = `0x${"c0".repeat(32)}` as Hex;
const TX_SWEEP = `0x${"5e".repeat(32)}` as Hex;
const TX_RELAY = `0x${"7a".repeat(32)}` as Hex;

const NOW = 1_900_000_000_000;
const MIN_AGE_SEC = 1_800;
const DISCRIMINATING_BPS = 12_000;

/** The collect freed these; the sweep re-split them; the increase needed both. */
const COLLECT_WBNB = 1_000n;
const COLLECT_TOKEN = 5_000n;
const SWEEP_TOKEN_IN = 2_000n;
const SWEEP_WBNB_OUT = 500n;
const NEEDED_WBNB = COLLECT_WBNB + SWEEP_WBNB_OUT; // 1500
const NEEDED_TOKEN = COLLECT_TOKEN - SWEEP_TOKEN_IN; // 3000

/**
 * A relay transport that answers the SAME body on every poll.
 *
 * "Stable" is the point: the live relay did not flap, it settled on a status
 * this build does not map and stayed there, so `awaitExecution` polled to its
 * deadline and reported a well-formed PENDING.
 */
function stableRelay(body: unknown): (url: string) => Transport {
  return () =>
    custom({
      request: async ({ method }: { method: string }) => {
        if (method === "wallet_getCallsStatus") return body;
        throw new Error(`unscripted relay method ${method}`);
      },
    });
}

function relayProvider(body: unknown): AltanaProvider {
  return new AltanaProvider({
    network: BNB_TESTNET,
    transport: stableRelay(body),
    awaitPollIntervalMs: 1,
    awaitTimeoutMs: 5,
  });
}

type Backend = {
  readonly label: string;
  journal(now: () => number): Promise<ExecutionJournal>;
  store(now: () => number): Promise<LpSequenceStore>;
};

const BACKENDS: readonly Backend[] = [
  {
    label: "memory",
    journal: async (now) => new MemoryExecutionJournal(now),
    store: async (now) => new MemoryLpSequenceStore(now),
  },
  {
    // B12. The 08-25 `$4`-cast incident and PHASE3.11 LOW-4 are the standing
    // warning that a memory-only green is not evidence.
    label: "postgres(fake sql)",
    journal: (now) => PostgresExecutionJournal.create(new FakeSqlClient(), now),
    store: (now) => PostgresLpSequenceStore.create(new FakeSqlClient(), now),
  },
];

type StuckShape = {
  readonly kind?: LpSequenceKind;
  readonly steps?: readonly LpStepKind[];
  /** Confirmed tx per prior step index; `undefined` records a SKIP. */
  readonly txHashes?: readonly (Hex | undefined)[];
  /** Give the PRIOR committed steps a callsId (PHASE3.14 F3's discriminator). */
  readonly priorCallsId?: Hex;
  readonly callsId?: Hex | null;
  readonly positionState?: "open" | "closing";
  readonly stuckState?: "UNKNOWN" | "PENDING" | "IN_PROGRESS" | "COMMITTED";
};

type Seeded = {
  readonly journal: ExecutionJournal;
  readonly store: LpSequenceStore;
  readonly sequenceId: string;
  readonly stuckKey: string;
  readonly decisionId: string;
  readonly clock: { ms: number };
};

async function seed(backend: Backend, shape: StuckShape = {}): Promise<Seeded> {
  const clock = { ms: NOW };
  const journal = await backend.journal(() => clock.ms);
  const store = await backend.store(() => clock.ms);
  const kind = shape.kind ?? "harvest";
  const steps = shape.steps ?? ["collect-fees", "sweep-token", "zap-in-increase"];
  const txHashes = shape.txHashes ?? [TX_COLLECT, TX_SWEEP];

  await store.createPosition({
    positionId: POSITION_ID,
    agentId: AGENT,
    ownerAddress: OWNER,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    tokenId: TOKEN_ID,
    basisWei: 3_000_000_000_000_000n,
  });
  if (shape.positionState === "closing") {
    await store.setPositionState(OWNER, AGENT, POSITION_ID, "closing");
  }
  const sequence = await store.createSequence({
    agentId: AGENT,
    ownerAddress: OWNER,
    positionId: POSITION_ID,
    kind,
  });
  const sequenceId = sequence.sequenceId;

  let stuckKey = "";
  for (const [index, stepKind] of steps.entries()) {
    const key = `jk-${sequenceId}-${index}`;
    await store.appendStep(OWNER, AGENT, sequenceId, {
      kind: stepKind,
      journalIdempotencyKey: key,
    });
    const last = index === steps.length - 1;
    await journal.begin({
      idempotencyKey: key,
      agentId: AGENT,
      ownerAddress: OWNER,
      kind: "lp",
      decisionId: lpStepDecisionId(sequenceId, index),
      ...(last
        ? shape.callsId === null
          ? {}
          : { externalRef: { callsId: shape.callsId ?? CALLS_ID } }
        : shape.priorCallsId === undefined
          ? {}
          : { externalRef: { callsId: shape.priorCallsId } }),
    });
    if (!last) {
      const txHash = txHashes[index];
      await journal.markCommitted(key, txHash === undefined ? {} : { txHash });
      continue;
    }
    stuckKey = key;
    const state = shape.stuckState ?? "UNKNOWN";
    if (state === "COMMITTED") await journal.markCommitted(key);
    else if (state === "IN_PROGRESS") await journal.markInProgress(key, {});
    else if (state === "UNKNOWN") {
      await journal.markInProgress(key, {});
      await journal.markUnknown(key, "Execution still pending after await.");
    }
  }
  await store.setSequenceState(OWNER, AGENT, sequenceId, "held");
  await store.setRecoveryState(OWNER, AGENT, sequenceId, "pending-increase");
  // Past the age guard, exactly as the live row was (11.9 h; the guard's floor
  // is 30 min and it anchors on `updatedAt`, i.e. the moment reconcile gave up).
  clock.ms += (MIN_AGE_SEC + 60) * 1_000;

  return {
    journal,
    store,
    sequenceId,
    stuckKey,
    decisionId: lpStepDecisionId(sequenceId, steps.length - 1),
    clock,
  };
}

type VerifyOptions = {
  readonly relay?: LpResolveInput["readRelayStatus"];
  readonly walletWbnb?: bigint;
  readonly walletToken?: bigint;
  readonly liquidity?: bigint | "burned";
  readonly finalized?: boolean;
};

async function verify(
  seeded: Seeded,
  options: VerifyOptions = {},
): Promise<LpResolveVerdict> {
  const row = await seeded.journal.get(seeded.stuckKey);
  assert.notEqual(row, null);
  const sequence = await seeded.store.getSequence(OWNER, AGENT, seeded.sequenceId);
  const position = await seeded.store.getPosition(OWNER, AGENT, POSITION_ID);
  const liquidity = options.liquidity ?? 10n ** 18n;
  return verifyLpResolveUnknown({
    row: row as JournalEntry,
    sequence,
    position,
    wbnb: WBNB,
    nfpm: NFPM,
    observedBlock: 117_000_000n,
    nowMs: seeded.clock.ms,
    minAgeSec: MIN_AGE_SEC,
    discriminatingMultipleBps: DISCRIMINATING_BPS,
    readStepRow: (key) => seeded.journal.get(key),
    receipts: {
      collectAmounts: async (txHash) => {
        if (txHash === TX_COLLECT) {
          return { amount0Wei: COLLECT_WBNB, amount1Wei: COLLECT_TOKEN };
        }
        if (txHash === TX_RELAY) return { amount0Wei: 1n, amount1Wei: 1n };
        throw new Error(`no collect receipt for ${txHash}`);
      },
      swapAmounts: async (txHash) => {
        if (txHash === TX_SWEEP || txHash === TX_RELAY) {
          return {
            tokenIn: TOKEN,
            amountInWei: SWEEP_TOKEN_IN,
            tokenOut: WBNB,
            amountOutWei: SWEEP_WBNB_OUT,
          };
        }
        throw new Error(`no swap receipt for ${txHash}`);
      },
      mintedTokenId: async () => BigInt(TOKEN_ID),
    },
    positions: async () =>
      liquidity === "burned"
        ? "burned"
        : { liquidity, tickLower: -500, tickUpper: 500 },
    tokenBalance: async (token: Address) =>
      token.toLowerCase() === WBNB.toLowerCase()
        ? (options.walletWbnb ?? NEEDED_WBNB)
        : (options.walletToken ?? NEEDED_TOKEN),
    blockNumber: async () => 117_000_001n,
    ...(options.finalized === false
      ? {}
      : { finalizedBlockNumber: async () => 117_000_000n }),
    ...(options.relay === undefined ? {} : { readRelayStatus: options.relay }),
  });
}

/** The relay seam as the route wires it, over a real provider. */
function relayReader(provider: WalletProvider): LpResolveInput["readRelayStatus"] {
  return async (callsId: Hex) => {
    const reading = await provider.readExecutionStatus?.({ callsId });
    if (reading === undefined) throw new Error("no relay reader");
    return {
      status: reading.receipt.status,
      rawStatus: reading.rawStatus,
      ...(reading.receipt.transactionHash === undefined
        ? {}
        : { transactionHash: reading.receipt.transactionHash }),
    };
  };
}

/** A bigint-safe failure message. `JSON.stringify` cannot serialize a verdict. */
function refusalOf(verdict: LpResolveVerdict): string {
  return verdict.ok
    ? "accepted"
    : `refused ${verdict.code}: ${verdict.message} | checks: ${verdict.checks
        .map((check) => `${check.name}=${check.result}`)
        .join(" ;; ")}`;
}

function checkOf(verdict: LpResolveVerdict, name: string): string {
  return verdict.checks.find((check) => check.name === name)?.result ?? "";
}

function evidenceOf(verdict: LpResolveVerdict): JournalResolutionEvidence {
  return {
    action: "resolveUnknown",
    at: NOW,
    ownerAddress: OWNER,
    observedBlock: "117000000",
    serverBlock: verdict.serverBlock === null ? null : verdict.serverBlock.toString(10),
    checks: verdict.checks.map((check) => ({ name: check.name, result: check.result })),
    legs: verdict.legs.map((leg) => ({
      token: leg.token,
      neededWei: leg.neededWei.toString(10),
      walletWei: leg.walletWei.toString(10),
      discriminating: leg.discriminating,
    })),
    logAbsence: verdict.logAbsence,
    disposition: verdict.ok ? verdict.disposition.summary : `refused:${verdict.code}`,
  };
}

/**
 * Apply an accepted disposition in the route's own order (journal terminal
 * write, then the sequence latch, then the position transition).
 *
 * The ROUTE itself is pinned end-to-end by `test/audit.resolveUnknown.test.ts`
 * (including this phase's inverted `r4 (a)`, which drives a callsId row through
 * the HTTP surface to a terminal sequence). This helper exists so the SAME
 * journey can be run against the Postgres store and journal, which the server
 * harness does not wire.
 */
async function applyDisposition(
  seeded: Seeded,
  verdict: LpResolveVerdict,
): Promise<void> {
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  if (!verdict.disposition.reEntry) {
    if (verdict.disposition.action === "advance") {
      await seeded.journal.advanceUnknown(seeded.stuckKey, evidenceOf(verdict));
    } else {
      await seeded.journal.resolveUnknown(seeded.stuckKey, evidenceOf(verdict));
    }
  }
  if (verdict.disposition.action === "advance" && verdict.disposition.closePosition) {
    await seeded.store.setPositionState(OWNER, AGENT, POSITION_ID, "closed");
  }
  await seeded.store.setSequenceState(OWNER, AGENT, seeded.sequenceId, "rolled-back");
  if (verdict.disposition.restorePositionToOpen) {
    await seeded.store.setPositionState(OWNER, AGENT, POSITION_ID, "open");
  }
}

const noWallet = async (): Promise<null> => null;

/* -------------------------------------------------------------------------- */
/* B1 / B12 — the journey, both unmapped shapes, both backends                 */
/* -------------------------------------------------------------------------- */

const UNMAPPED_RELAY_ANSWERS: readonly {
  readonly label: string;
  readonly body: unknown;
  readonly raw: string;
}[] = [
  { label: "unmapped numeric 300", body: { status: 300, receipts: [] }, raw: "300" },
  { label: 'unmapped string "QUEUED"', body: { status: "QUEUED", receipts: [] }, raw: "QUEUED" },
];

const JOURNEYS: readonly {
  readonly label: string;
  readonly shape: StuckShape;
  readonly wallet: VerifyOptions;
}[] = [
  {
    label: "harvest stuck at zap-in-increase",
    shape: {},
    wallet: {},
  },
  {
    label: "exit stuck at sweep-token",
    shape: {
      kind: "manual-exit",
      steps: ["zap-out", "sweep-token"],
      txHashes: [TX_COLLECT],
      positionState: "closing",
    },
    // PHASE3.1: the exit swap sizes itself on `freed.tokenWei`, the confirmed
    // collect delta from step 0, and on nothing else.
    wallet: { walletToken: COLLECT_TOKEN },
  },
];

for (const backend of BACKENDS) {
  for (const answer of UNMAPPED_RELAY_ANSWERS) {
    for (const journey of JOURNEYS) {
      describe(`B1/B12 (${backend.label}, ${answer.label}): ${journey.label} terminates`, () => {
        it("submits -> IN_PROGRESS -> reconcile writes UNKNOWN -> the owner-signed resolve reaches a TERMINAL state", async () => {
          const seeded = await seed(backend, {
            ...journey.shape,
            stuckState: "IN_PROGRESS",
          });
          const provider = relayProvider(answer.body);

          // Link 2/3: reconcile polls a relay that never says anything this
          // build maps, and converts "not confirmed, not failed" into UNKNOWN.
          const summary = await reconcile({
            provider: provider as unknown as WalletProvider,
            journal: seeded.journal,
            resolveWallet: noWallet,
            minRowAgeMs: 0,
            now: () => seeded.clock.ms,
          });
          assert.deepEqual(summary.held, [seeded.stuckKey]);
          assert.equal(
            (await seeded.journal.get(seeded.stuckKey))?.state,
            "UNKNOWN",
          );

          // Link 4: reconcile will never look at it again — its own query is
          // `state in ('PENDING','IN_PROGRESS')`.
          const second = await reconcile({
            provider: provider as unknown as WalletProvider,
            journal: seeded.journal,
            resolveWallet: noWallet,
            minRowAgeMs: 0,
            now: () => seeded.clock.ms,
          });
          assert.deepEqual(second.held, []);

          // PHASE3.14 F8: `updatedAt` is now the moment reconcile GAVE UP, and
          // it never moves again, so the age guard measures time since the row
          // was disowned. That is conservative and correct, and it is not
          // lowered for callsId rows. The live row was 11.9 h old here.
          seeded.clock.ms += (MIN_AGE_SEC + 60) * 1_000;

          // Link 5, repaired: the owner-signed resolver accepts the row, asks
          // the relay ONCE (which still says the unmapped thing), and decides
          // on the audited direct evidence.
          const verdict = await verify(seeded, {
            ...journey.wallet,
            relay: relayReader(provider),
          });
          assert.equal(verdict.ok, true, refusalOf(verdict));
          assert.match(checkOf(verdict, "relay-status"), /still PENDING/u);
          assert.match(checkOf(verdict, "relay-status"), new RegExp(answer.raw, "u"));

          await applyDisposition(seeded, verdict);

          const sequence = await seeded.store.getSequence(
            OWNER,
            AGENT,
            seeded.sequenceId,
          );
          assert.notEqual(sequence, null);
          assert.equal(
            isTerminalLpSequence(sequence!.state, sequence!.recoveryState),
            true,
            "the sequence must be terminal or the position stays locked out of every saga",
          );
          // And the position is evaluable again: no non-terminal sequence holds
          // it, and it is not stranded in `closing`.
          assert.equal(
            await seeded.store.getNonTerminalSequence(OWNER, AGENT, POSITION_ID),
            null,
          );
          const position = await seeded.store.getPosition(OWNER, AGENT, POSITION_ID);
          assert.notEqual(position?.state, "closing");
          await seeded.journal.close?.();
        });
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* B2 — the invariant the incident violated, table-driven                     */
/* -------------------------------------------------------------------------- */

/**
 * Every non-terminal state `reconcile` can WRITE is `UNKNOWN` (it writes
 * COMMITTED, ROLLED_BACK or UNKNOWN, and the first two are terminal). So the
 * table is over the REASONS, crossed with callsId present/absent.
 *
 * `resolveRow` produces UNKNOWN at four sites plus `reconcile`'s own catch. Two
 * of the five are reachable for an `lp` row; the rest belong to kinds this
 * phase's resolver does not verify, and that gap is DECLARED here by name
 * rather than left for a reader to discover — an UNKNOWN `grant`/`revoke`/
 * `venus*` row is held for an operator with no owner-signed surface, which
 * `CLAUDE.md` already records for Venus.
 */
const RECONCILE_UNKNOWN_OUTCOMES: readonly {
  readonly reason: string;
  readonly site: string;
  readonly lpReachable: boolean;
}[] = [
  {
    reason: "No callsId recorded; the submit window is ambiguous.",
    site: "journal.ts resolveRow, the lp/trade/venus branch with no callsId",
    lpReachable: true,
  },
  {
    reason: "Execution still pending after await.",
    site: "journal.ts resolveRow, the lp/trade/venus branch's unconditional tail",
    lpReachable: true,
  },
  {
    reason: "reconcile error",
    site: "journal.ts reconcile's catch — any throw from resolveRow",
    lpReachable: true,
  },
  {
    reason: "No session key or wallet to verify the session against.",
    site: "journal.ts resolveRow, grant/revoke",
    lpReachable: false,
  },
  {
    reason: "Grant not observed active on-chain.",
    site: "journal.ts resolveRow, grant",
    lpReachable: false,
  },
  {
    reason: "Session still active after revoke.",
    site: "journal.ts resolveRow, revoke",
    lpReachable: false,
  },
  {
    reason: "Unrecognized journal kind; held for an operator.",
    site: "journal.ts resolveRow, the unrecognized-kind tail",
    lpReachable: false,
  },
];

describe("B2 — every non-terminal state reconcile can write is accepted by some surface", () => {
  for (const outcome of RECONCILE_UNKNOWN_OUTCOMES.filter((row) => row.lpReachable)) {
    for (const callsId of [true, false]) {
      it(`accepts an UNKNOWN lp row written as "${outcome.reason}" (callsId: ${callsId})`, async () => {
        const seeded = await seed(BACKENDS[0]!, {
          ...(callsId ? {} : { callsId: null }),
        });
        // The reason is what reconcile stamped; the STATE is what matters.
        const row = await seeded.journal.get(seeded.stuckKey);
        assert.equal(row?.state, "UNKNOWN");
        const verdict = await verify(seeded);
        assert.equal(
          verdict.ok,
          true,
          `ORPHANED STATE: an UNKNOWN lp row reconcile wrote with reason "${outcome.reason}" (${outcome.site}, callsId ${callsId}) is accepted by NO surface — not reconcile's next pass (its query is PENDING/IN_PROGRESS only), not resolveUnknown (${
            verdict.ok ? "" : verdict.code
          }), not abandonSequence (which refuses step_not_settled on an UNKNOWN row). This is the PHASE3.14 deadlock, reopened.`,
        );
      });
    }
  }

  it("declares, by name, the outcomes this phase's resolver does NOT cover", () => {
    // Not a gap being papered over: an UNKNOWN grant/revoke/venus row has no
    // owner-signed resolver in this build, and `resolveUnknown` verifies `lp`
    // rows only (the route 404s every other kind). If a later phase makes one
    // of these lp-reachable, this list is what has to change with it.
    const uncovered = RECONCILE_UNKNOWN_OUTCOMES.filter((row) => !row.lpReachable);
    assert.deepEqual(
      uncovered.map((row) => row.reason),
      [
        "No session key or wallet to verify the session against.",
        "Grant not observed active on-chain.",
        "Session still active after revoke.",
        "Unrecognized journal kind; held for an operator.",
      ],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* B3 — relay CONFIRMED advances, and the disposition is KIND-AWARE           */
/* -------------------------------------------------------------------------- */

describe("B3 — a relay CONFIRMED at resolve time advances, closing only a liquidity-removing step", () => {
  it("a stuck zap-out advances and CLOSES the position", async () => {
    const seeded = await seed(BACKENDS[0]!, {
      kind: "manual-exit",
      steps: ["zap-out"],
      txHashes: [],
      positionState: "closing",
    });
    const provider = relayProvider({
      status: 200,
      receipts: [{ transactionHash: TX_RELAY }],
    });
    const verdict = await verify(seeded, { relay: relayReader(provider) });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.disposition.action, "advance");
    assert.equal(verdict.disposition.closePosition, true);
    assert.equal(verdict.disposition.restorePositionToOpen, false);
    await applyDisposition(seeded, verdict);
    assert.equal((await seeded.journal.get(seeded.stuckKey))?.state, "COMMITTED");
    assert.equal(
      (await seeded.store.getPosition(OWNER, AGENT, POSITION_ID))?.state,
      "closed",
    );
  });

  it("a stuck zap-in-increase advances and LEAVES THE POSITION OPEN (F2.3)", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const provider = relayProvider({
      status: 200,
      receipts: [{ transactionHash: TX_RELAY }],
    });
    const verdict = await verify(seeded, { relay: relayReader(provider) });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.disposition.action, "advance");
    assert.equal(
      verdict.disposition.closePosition,
      false,
      "an increase ADDS liquidity; closing the position would delete a funded row",
    );
    assert.match(verdict.disposition.summary, /position left OPEN/u);
    await applyDisposition(seeded, verdict);
    assert.equal(
      (await seeded.store.getPosition(OWNER, AGENT, POSITION_ID))?.state,
      "open",
    );
  });

  it("REFUSES to advance on a CONFIRMED that carries no transaction hash (F2.2 residual)", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const provider = relayProvider({ status: 200, receipts: [] });
    const verdict = await verify(seeded, { relay: relayReader(provider) });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "relay_confirmed_no_txhash");
    assert.match(verdict.message, /not the positive on-chain proof/u);
    // The row is untouched, which is the whole point of refusing.
    assert.equal((await seeded.journal.get(seeded.stuckKey))?.state, "UNKNOWN");
  });
});

/* -------------------------------------------------------------------------- */
/* B4 — relay FAILED abandons, on better evidence than inference              */
/* -------------------------------------------------------------------------- */

describe("B4 — a relay FAILED at resolve time abandons, and is recorded as the discriminating evidence", () => {
  it("abandons even when the wallet no longer holds the legs (which the inference path would refuse)", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const provider = relayProvider({ status: 500, receipts: [] });
    const verdict = await verify(seeded, {
      relay: relayReader(provider),
      // The legs are GONE. Without the relay this is `inputs_missing`.
      walletWbnb: 0n,
      walletToken: 0n,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.disposition.action, "abandon");
    assert.match(checkOf(verdict, "relay-status"), /FAILED \(raw status 500/u);
    assert.match(
      checkOf(verdict, "discriminating-evidence"),
      /the relay's own FAILED answer/u,
    );
    // F6: a FAILED submission did not land, so the later-landing disclosure
    // must NOT be attached — it would be false.
    assert.doesNotMatch(verdict.disposition.note, /MAY STILL LAND/u);
  });
});

/* -------------------------------------------------------------------------- */
/* B5 — unavailability NEVER refuses                                          */
/* -------------------------------------------------------------------------- */

describe("B5 — an unreachable, unmapped or still-pending relay falls through to the audited inference", () => {
  const cases: readonly {
    readonly label: string;
    readonly relay: LpResolveInput["readRelayStatus"];
    readonly expect: RegExp;
  }[] = [
    {
      label: "the reader throws (relay outage)",
      relay: async () => {
        throw new Error("HTTP request failed. Status: 503 Service Unavailable");
      },
      expect: /unreadable: HTTP request failed/u,
    },
    {
      label: "the relay answers an unmapped status",
      relay: relayReader(relayProvider({ status: 300, receipts: [] })),
      expect: /still PENDING \(raw status 300/u,
    },
    {
      label: "the relay answers an honest PENDING",
      relay: relayReader(relayProvider({ status: 100, receipts: [] })),
      expect: /still PENDING \(raw status 100/u,
    },
  ];

  for (const entry of cases) {
    it(`${entry.label}: the inference decides and no refusal is attributable to the relay`, async () => {
      const seeded = await seed(BACKENDS[0]!);
      const verdict = await verify(seeded, { relay: entry.relay });
      assert.equal(verdict.ok, true);
      assert.match(checkOf(verdict, "relay-status"), entry.expect);
      // The inference ran in full — the same checks a callsId-less row records.
      assert.match(checkOf(verdict, "inputs-still-present"), /all present/u);
      assert.match(checkOf(verdict, "discriminating-leg"), /of 2/u);
    });
  }

  it("records that it did NOT look when no reader is wired — declining to look is not the same as looking", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, true);
    assert.match(checkOf(verdict, "relay-status"), /no relay status reader is wired/u);
  });

  it("records that there was nothing to ask when the row carries no callsId", async () => {
    const seeded = await seed(BACKENDS[0]!, { callsId: null });
    const verdict = await verify(seeded, {
      relay: async () => {
        throw new Error("the relay must not be asked about a row with no callsId");
      },
    });
    assert.equal(verdict.ok, true);
    assert.match(checkOf(verdict, "relay-status"), /nothing to ask/u);
  });
});

/* -------------------------------------------------------------------------- */
/* B6 — the SURVIVING guard (PHASE3.3-AUDIT A9)                               */
/* -------------------------------------------------------------------------- */

describe("B6 — a row reconcile still OWNS is refused not_unknown, and the message does not name reconcile", () => {
  for (const state of ["PENDING", "IN_PROGRESS"] as const) {
    it(`refuses a ${state} row (which IS reconcile's, and which reconcile will resolve)`, async () => {
      const seeded = await seed(BACKENDS[0]!, { stuckState: state });
      const verdict = await verify(seeded, {
        relay: async () => {
          throw new Error("the relay must not be read before the state gate passes");
        },
      });
      assert.equal(verdict.ok, false);
      if (verdict.ok) return;
      assert.equal(verdict.code, "not_unknown");
      // A9: the refusal names the row's state, never a server restart.
      assert.doesNotMatch(verdict.message, /reconcile/u);
      // And the relay was never asked — the throw above would have surfaced.
      assert.equal(checkOf(verdict, "relay-status"), "");
    });
  }
});

/* -------------------------------------------------------------------------- */
/* B7 — F3: a reconcile-COMMITTED prior step is not a recorded SKIP           */
/* -------------------------------------------------------------------------- */

describe("B7 — a prior step COMMITTED with a callsId and no txHash is not read as a skip (F3)", () => {
  it("refuses inputs_missing, naming the receipt-less relay answer", async () => {
    const seeded = await seed(BACKENDS[0]!, {
      // Step 0 committed from a relay answer that carried `receipts: []`.
      txHashes: [undefined, TX_SWEEP],
      priorCallsId: `0x${"9a".repeat(32)}` as Hex,
    });
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "inputs_missing");
    assert.match(verdict.message, /NO transaction hash/u);
    assert.match(verdict.message, /receipts/u);
  });

  it("a skip with neither callsId nor txHash is skipped, not refused", async () => {
    const seeded = await seed(BACKENDS[0]!, {
      steps: ["collect-fees", "sweep-token", "zap-in-increase"],
      // The sweep was SKIPPED by the saga: committed, no submit, no callsId.
      txHashes: [TX_COLLECT, undefined],
    });
    const verdict = await verify(seeded, {
      // With the sweep skipped, the increase needed exactly what the collect
      // freed.
      walletWbnb: COLLECT_WBNB,
      walletToken: COLLECT_TOKEN,
    });
    assert.equal(verdict.ok, true);
    assert.match(checkOf(verdict, "inputs-still-present"), /all present/u);
  });
});

/* -------------------------------------------------------------------------- */
/* B8 — F5: a claimed 3.9c landing resolution owns the row                    */
/* -------------------------------------------------------------------------- */

describe("B8 — a row with a landingResolutionId is refused, naming the path that owns it", () => {
  it("refuses rather than rolling a sequence back underneath a fenced lease", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const row = (await seeded.journal.get(seeded.stuckKey)) as JournalEntry;
    // The 3.9c writers are gated off by default and chain-56-blocked; the guard
    // is pre-emptive, so the claimed row is constructed directly.
    const claimed: JournalEntry = { ...row, landingResolutionId: "lr-3-9c-1" };
    const sequence = await seeded.store.getSequence(OWNER, AGENT, seeded.sequenceId);
    const position = await seeded.store.getPosition(OWNER, AGENT, POSITION_ID);
    const verdict = await verifyLpResolveUnknown({
      row: claimed,
      sequence,
      position,
      wbnb: WBNB,
      nfpm: NFPM,
      observedBlock: 117_000_000n,
      nowMs: seeded.clock.ms,
      minAgeSec: MIN_AGE_SEC,
      discriminatingMultipleBps: DISCRIMINATING_BPS,
      readStepRow: (key) => seeded.journal.get(key),
      receipts: {
        collectAmounts: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
        swapAmounts: async () => {
          throw new Error("unused");
        },
        mintedTokenId: async () => 0n,
      },
      positions: async () => ({ liquidity: 1n, tickLower: -1, tickUpper: 1 }),
      tokenBalance: async () => 0n,
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "landing_resolution_claimed");
    assert.match(verdict.message, /fenced lease/u);
    assert.match(verdict.message, /lr-3-9c-1/u);
  });
});

/* -------------------------------------------------------------------------- */
/* B9 — idempotency: re-entry performs NO relay read                          */
/* -------------------------------------------------------------------------- */

describe("B9 — a second resolve of the same row re-applies the recorded decision", () => {
  it("is reEntry, writes no second journal record, and does NOT ask the relay again", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const provider = relayProvider({ status: 300, receipts: [] });
    const first = await verify(seeded, { relay: relayReader(provider) });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.disposition.reEntry, false);
    await applyDisposition(seeded, first);
    const afterFirst = await seeded.journal.get(seeded.stuckKey);
    assert.equal(afterFirst?.state, "ROLLED_BACK");

    let asked = 0;
    const second = await verify(seeded, {
      relay: async (callsId: Hex) => {
        asked += 1;
        return relayReader(provider)!(callsId);
      },
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.disposition.reEntry, true);
    assert.equal(
      asked,
      0,
      "a re-entry re-applies a decision already recorded; it must not make a new one from a chain that has moved",
    );
    assert.equal(second.disposition.action, first.disposition.action);
    // No second journal record: the row is already terminal and the route
    // skips write (1) on re-entry.
    const afterSecond = await seeded.journal.get(seeded.stuckKey);
    assert.equal(afterSecond?.updatedAt, afterFirst?.updatedAt);
  });
});

/* -------------------------------------------------------------------------- */
/* B10 — the 3.3 audited refusals, unchanged                                  */
/* -------------------------------------------------------------------------- */

describe("B10 — PHASE3.3's audited refusals still fire, on a row that now carries a callsId", () => {
  it("too_young", async () => {
    const seeded = await seed(BACKENDS[0]!);
    seeded.clock.ms = NOW; // back inside the floor
    const verdict = await verifyLpResolveUnknown({
      ...(await inputFor(seeded)),
      nowMs: NOW,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "too_young");
  });

  it("native_spend", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const base = await inputFor(seeded);
    const verdict = await verifyLpResolveUnknown({
      ...base,
      row: { ...base.row, nativeSpendWei: 10n ** 15n },
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "native_spend");
  });

  it("sequence_kind_unsupported, still naming out-of-band custody recovery", async () => {
    const seeded = await seed(BACKENDS[0]!, { kind: "rotate" });
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "sequence_kind_unsupported");
    assert.match(verdict.message, /out-of-band custody recovery/u);
  });

  it("step_not_current", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const base = await inputFor(seeded);
    const verdict = await verifyLpResolveUnknown({
      ...base,
      row: { ...base.row, idempotencyKey: "not-the-current-step" },
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "step_not_current");
  });

  it("sequence_terminal", async () => {
    const seeded = await seed(BACKENDS[0]!);
    await seeded.store.setSequenceState(OWNER, AGENT, seeded.sequenceId, "rolled-back");
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "sequence_terminal");
  });
});

async function inputFor(seeded: Seeded): Promise<LpResolveInput> {
  const row = (await seeded.journal.get(seeded.stuckKey)) as JournalEntry;
  return {
    row,
    sequence: await seeded.store.getSequence(OWNER, AGENT, seeded.sequenceId),
    position: await seeded.store.getPosition(OWNER, AGENT, POSITION_ID),
    wbnb: WBNB,
    nfpm: NFPM,
    observedBlock: 117_000_000n,
    nowMs: seeded.clock.ms,
    minAgeSec: MIN_AGE_SEC,
    discriminatingMultipleBps: DISCRIMINATING_BPS,
    readStepRow: (key) => seeded.journal.get(key),
    receipts: {
      collectAmounts: async () => ({
        amount0Wei: COLLECT_WBNB,
        amount1Wei: COLLECT_TOKEN,
      }),
      swapAmounts: async () => ({
        tokenIn: TOKEN,
        amountInWei: SWEEP_TOKEN_IN,
        tokenOut: WBNB,
        amountOutWei: SWEEP_WBNB_OUT,
      }),
      mintedTokenId: async () => BigInt(TOKEN_ID),
    },
    positions: async () => ({ liquidity: 10n ** 18n, tickLower: -500, tickUpper: 500 }),
    tokenBalance: async (token: Address) =>
      token.toLowerCase() === WBNB.toLowerCase() ? NEEDED_WBNB : NEEDED_TOKEN,
    finalizedBlockNumber: async () => 117_000_000n,
  };
}

/* -------------------------------------------------------------------------- */
/* B11 — F4: the operator's own diagnostic surface names the right tool       */
/* -------------------------------------------------------------------------- */

describe("B11 — the sequence view sends an UNKNOWN step to the resolver and a PENDING one to reconcile", () => {
  const sequence = {
    steps: [
      {
        index: 0,
        kind: "collect-fees" as LpStepKind,
        journalIdempotencyKey: "k0",
        journalDecisionId: "lp:seq-b11:0",
      },
      {
        index: 1,
        kind: "zap-in-increase" as LpStepKind,
        journalIdempotencyKey: "k1",
        journalDecisionId: "lp:seq-b11:1",
      },
    ],
  };

  it("UNKNOWN: names the owner-signed resolveUnknown and says reconcile has disowned it", () => {
    const progress = deriveLpSequenceProgress(
      sequence,
      new Map([
        ["k0", "COMMITTED" as const],
        ["k1", "UNKNOWN" as const],
      ]),
    );
    assert.equal(progress.disposition, "hold");
    assert.match(progress.reason, /resolveUnknown/u);
    assert.match(progress.reason, /disowned/u);
    assert.doesNotMatch(progress.reason, /held until reconcile resolves it/u);
  });

  for (const outcome of ["PENDING", "IN_PROGRESS"] as const) {
    it(`${outcome}: still says to wait for reconcile, because that is still true`, () => {
      const progress = deriveLpSequenceProgress(
        sequence,
        new Map([
          ["k0", "COMMITTED" as const],
          ["k1", outcome],
        ]),
      );
      assert.match(progress.reason, /held until reconcile resolves it/u);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* M9's pin — status 300 is NOT guessed into the FAILED branch (R-C blocked)   */
/* -------------------------------------------------------------------------- */

describe("R-C stays blocked: an unmapped relay status is PENDING, and the journey still terminates", () => {
  it("maps 300 to PENDING, not FAILED — guessing it would roll back a step the relay may yet land", async () => {
    const provider = relayProvider({ status: 300, receipts: [] });
    const receipt = await provider.awaitExecution({ callsId: CALLS_ID });
    assert.equal(
      receipt.status,
      "PENDING",
      "porto types `status` as a bare z.number() and no documentation states what 300 means; mapping it to FAILED would record a step as rolled back that the relay may still land, releasing budget for a spend the chain made.",
    );
    const single = await provider.readExecutionStatus({ callsId: CALLS_ID });
    assert.equal(single.receipt.status, "PENDING");
    assert.equal(single.rawStatus, "300");
  });

  it("and the deadlock is closed anyway, without knowing what 300 means", async () => {
    const seeded = await seed(BACKENDS[0]!, { stuckState: "IN_PROGRESS" });
    const provider = relayProvider({ status: 300, receipts: [] });
    await reconcile({
      provider: provider as unknown as WalletProvider,
      journal: seeded.journal,
      resolveWallet: noWallet,
      minRowAgeMs: 0,
      now: () => seeded.clock.ms,
    });
    assert.equal((await seeded.journal.get(seeded.stuckKey))?.state, "UNKNOWN");
    seeded.clock.ms += (MIN_AGE_SEC + 60) * 1_000;
    const verdict = await verify(seeded, { relay: relayReader(provider) });
    assert.equal(verdict.ok, true, refusalOf(verdict));
    await applyDisposition(seeded, verdict);
    const sequence = await seeded.store.getSequence(OWNER, AGENT, seeded.sequenceId);
    assert.equal(isTerminalLpSequence(sequence!.state, sequence!.recoveryState), true);
  });
});

/* -------------------------------------------------------------------------- */
/* F6 — the later-landing residual is priced and disclosed                    */
/* -------------------------------------------------------------------------- */

describe("F6 — an abandon of a row that reached the relay says so, per step kind", () => {
  it("harvest zap-in-increase: benign, and named as benign", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.match(verdict.disposition.note, /MAY STILL LAND/u);
    assert.match(verdict.disposition.note, /liquidity would grow/u);
    assert.match(verdict.disposition.note, /basisWei is written only at open\/import/u);
  });

  it("zap-out: the PHANTOM OPEN position is named as an OPEN RESIDUAL of the phase", async () => {
    const seeded = await seed(BACKENDS[0]!, {
      kind: "protect",
      steps: ["zap-out"],
      txHashes: [],
      positionState: "closing",
    });
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.disposition.restorePositionToOpen, true);
    assert.match(verdict.disposition.note, /PHANTOM OPEN position/u);
    assert.match(verdict.disposition.note, /OPEN RESIDUAL of PHASE3.14/u);
  });

  it("carries the sequence's recovery marker forward — the abandon retires the row that held it", async () => {
    const seeded = await seed(BACKENDS[0]!);
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.match(verdict.disposition.summary, /recovery marker at resolution: pending-increase/u);
  });

  it("a row with NO callsId carries no later-landing disclosure — it never reached a relay", async () => {
    const seeded = await seed(BACKENDS[0]!, { callsId: null });
    const verdict = await verify(seeded);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.doesNotMatch(verdict.disposition.note, /MAY STILL LAND/u);
  });
});
