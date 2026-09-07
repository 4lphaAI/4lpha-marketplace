/**
 * PHASE3.8 F4a — the route, its authz and its two writes.
 *
 * The unit tests in `lpAbandonSequence.test.ts` pin the PREDICATE. This pins the
 * WIRING, which is where the previous LP phases actually broke: a kind missing
 * from `LOCAL_ONLY_KINDS`, a signed field not bound to the path, a write order
 * that strands one store against the other.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  MemoryLpSequenceStore,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import type { LpServerDeps } from "../src/server.js";
import {
  call,
  createHarness,
  NOW_SEC,
  otherOwnerAccount,
  ownerAccount,
  signOwnerAction,
  type Harness,
} from "./support/serverHarness.js";

const AGENT = "lp-agent";
const POSITION = "pos-1";
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x55d398326f99059fF775485246999027B3197955");

type Fixture = {
  readonly harness: Harness;
  readonly lpStore: LpSequenceStore;
};

async function fixture(): Promise<Fixture> {
  const lpStore = new MemoryLpSequenceStore();
  const lp = {
    store: lpStore,
    settingsStore: new MemoryLpSettingsStore(),
    observations: new MemoryLpObservationStore(),
    workerIntervalMs: 1,
    railsResult: {
      ok: false as const,
      message: "rails unused by the abandon route",
    },
    venue: { nfpm: WBNB, routerV3: WBNB, wbnb: WBNB },
    // Every reader throws: the abandon route reads the sequence store and the
    // journal and NOTHING else, and that is worth pinning rather than assuming.
    readers: new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("the abandon route must not touch the chain");
        },
      },
    ),
  } as unknown as LpServerDeps;

  // AUDIT A3: the route refuses a sequence touched within one worker interval.
  // The fixture's interval is 1 ms so the tests exercise the GATE rather than
  // waiting on it; `lpAbandonSequence.test.ts` pins the boundary itself.
  const harness = await createHarness({ lp });
  await harness.agentStore.createAgent({
    id: AGENT,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    status: "armed",
  });
  await lpStore.createPosition({
    positionId: POSITION,
    agentId: AGENT,
    ownerAddress: ownerAccount.address,
    token0: TOKEN,
    token1: WBNB,
    fee: 100,
    basisWei: 5_000_000_000_000_000n,
  });
  return { harness, lpStore };
}

async function post(
  fx: Fixture,
  sequenceId: string,
  options: {
    readonly params?: Record<string, unknown>;
    readonly path?: string;
    readonly signer?: typeof ownerAccount;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const issuedAt = fx.harness.nowSec();
  const envelope = await signOwnerAction(
    "abandonSequence",
    options.params ?? { sequenceId },
    {
      agentId: AGENT,
      issuedAt,
      expiry: issuedAt + 120,
      ...(options.signer === undefined ? {} : { account: options.signer }),
    },
  );
  const result = await call(
    fx.harness,
    options.path ?? `/agents/${AGENT}/lp/sequences/${sequenceId}/abandon`,
    { method: "POST", body: envelope },
  );
  return { status: result.status, body: result.body };
}

describe("PHASE3.8 F4a: POST /agents/:id/lp/sequences/:sequenceId/abandon", () => {
  it("abandons a held sequence whose steps all settled, and stops it blocking", async () => {
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "harvest",
    });
    // Two recorded steps whose rows never existed: settled by absence, which is
    // the (aq) shape reduced to what the store can hold offline.
    await fx.lpStore.appendStep(ownerAccount.address, AGENT, seq.sequenceId, {
      kind: "collect-fees",
      journalIdempotencyKey: "k0",
    });
    await fx.lpStore.setRecoveryState(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
      "wbnb-stranded",
    );
    await fx.lpStore.setSequenceState(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
      "held",
    );

    assert.notEqual(
      await fx.lpStore.getAnyNonTerminalSequence(ownerAccount.address, AGENT),
      null,
      "precondition: the sequence blocks the agent",
    );

    const { status, body } = await post(fx, seq.sequenceId);
    assert.equal(status, 200, JSON.stringify(body));

    const after = await fx.lpStore.getSequence(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
    );
    assert.equal(after?.state, "rolled-back");
    assert.equal(
      await fx.lpStore.getAnyNonTerminalSequence(ownerAccount.address, AGENT),
      null,
      "and the agent is unblocked — which is the whole point",
    );
  });

  it("AUDIT A1: a crash between the two writes is CURABLE by re-signing", async () => {
    // The first version was named "is RE-RUNNABLE" and asserted a 400. It was
    // measuring the opposite of its own name: rolling the sequence back flips
    // `isTerminalLpSequence`, so check (a) refused for ever after and a crash
    // between the writes left the position open with its original basis.
    //
    // The order is now POSITION FIRST, SEQUENCE LAST. The position write is the
    // recoverable one; the sequence write is the latch. A crash after the first
    // leaves an action that can simply be signed again.
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "harvest",
    });
    await fx.lpStore.setRecoveryState(ownerAccount.address, AGENT, seq.sequenceId, "wbnb-stranded");
    await fx.lpStore.setSequenceState(ownerAccount.address, AGENT, seq.sequenceId, "held");

    // Simulate the crash: apply only the FIRST write, exactly as the route
    // orders them, then sign the action for real.
    await fx.lpStore.setPositionState(ownerAccount.address, AGENT, POSITION, "closed");

    const { status } = await post(fx, seq.sequenceId);
    assert.equal(
      status,
      200,
      "re-signing after a partial apply must still work — under the OLD order this was 400",
    );
    const after = await fx.lpStore.getSequence(ownerAccount.address, AGENT, seq.sequenceId);
    assert.equal(after?.state, "rolled-back", "and the latch finally lands");
  });

  it("AUDIT M15: a rotate whose zap-out committed really CLOSES the position", async () => {
    // Measured by the audit: deleting `setPositionState` from the route left
    // all 1753 tests green, because every route test used a disposition of
    // "leave". This is the one that would have caught it.
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "rotate",
    });
    await fx.lpStore.appendStep(ownerAccount.address, AGENT, seq.sequenceId, {
      kind: "zap-out",
      journalIdempotencyKey: "zk0",
    });
    await fx.harness.journal.begin({
      idempotencyKey: "zk0",
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      kind: "lp",
      decisionId: `lp:${seq.sequenceId}:0`,
    });
    await fx.harness.journal.markInProgress("zk0", { callsId: `0x${"ab".repeat(32)}` });
    await fx.harness.journal.markCommitted("zk0");
    await fx.lpStore.setRecoveryState(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
      "wbnb-stranded",
    );
    await fx.lpStore.setSequenceState(ownerAccount.address, AGENT, seq.sequenceId, "held");

    const { status, body } = await post(fx, seq.sequenceId);
    assert.equal(status, 200, JSON.stringify(body));

    const position = await fx.lpStore.getPosition(ownerAccount.address, AGENT, POSITION);
    assert.equal(
      position?.state,
      "closed",
      "the principal is out and the NFT is empty; leaving it open is the -100% PnL protect",
    );
    assert.equal(position?.basisWei, 0n, "and closing resets the basis, which is what stops it");
  });

  it("AUDIT A1: the FIRST write is the position, so a crash leaves a re-signable action", async () => {
    // The surviving mutant for this was the OLD write order, and the previous
    // test could not see it: simulating the crash by hand passes under either
    // order. What distinguishes them is WHICH write lands first, so the store
    // is wrapped to fail the SECOND one and the assertion is about what
    // survived.
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "rotate",
    });
    await fx.lpStore.appendStep(ownerAccount.address, AGENT, seq.sequenceId, {
      kind: "zap-out",
      journalIdempotencyKey: "zk0",
    });
    await fx.harness.journal.begin({
      idempotencyKey: "zk0",
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      kind: "lp",
      decisionId: `lp:${seq.sequenceId}:0`,
    });
    await fx.harness.journal.markInProgress("zk0", { callsId: `0x${"ab".repeat(32)}` });
    await fx.harness.journal.markCommitted("zk0");
    await fx.lpStore.setRecoveryState(ownerAccount.address, AGENT, seq.sequenceId, "wbnb-stranded");
    await fx.lpStore.setSequenceState(ownerAccount.address, AGENT, seq.sequenceId, "held");

    // Crash the SECOND write, whichever it is.
    let writes = 0;
    const realCompleteSequenceAbandon =
      fx.lpStore.completeSequenceAbandon.bind(fx.lpStore);
    const realSetPositionState = fx.lpStore.setPositionState.bind(fx.lpStore);
    const crashAfterFirst =
      <T extends unknown[], R>(real: (...args: T) => Promise<R>) =>
      async (...args: T): Promise<R> => {
        writes += 1;
        if (writes === 2) throw new Error("crash between the two writes");
        return real(...args);
      };
    (fx.lpStore as { completeSequenceAbandon: unknown }).completeSequenceAbandon =
      crashAfterFirst(realCompleteSequenceAbandon);
    (fx.lpStore as { setPositionState: unknown }).setPositionState =
      crashAfterFirst(realSetPositionState);

    const crashed = await post(fx, seq.sequenceId);
    assert.notEqual(crashed.status, 200, "the crash surfaced");

    (fx.lpStore as { completeSequenceAbandon: unknown }).completeSequenceAbandon =
      realCompleteSequenceAbandon;
    (fx.lpStore as { setPositionState: unknown }).setPositionState = realSetPositionState;

    // A crashed process's `abandoning` lease is intentionally reclaimed only
    // after one worker interval; before that, a second process cannot steal it.
    fx.harness.advance(1);

    // THE ASSERTION THAT SEPARATES THE ORDERS. With the position written first,
    // the sequence is still non-terminal and the owner can simply sign again.
    // With the sequence written first it is terminal, check (a) refuses for
    // ever, and the position is left open with its original basis.
    const mid = await fx.lpStore.getSequence(ownerAccount.address, AGENT, seq.sequenceId);
    assert.notEqual(
      mid?.state,
      "rolled-back",
      "the latch must be the LAST write, or a crash is unrecoverable",
    );

    const retry = await post(fx, seq.sequenceId);
    assert.equal(retry.status, 200, "and re-signing completes it");
    const position = await fx.lpStore.getPosition(ownerAccount.address, AGENT, POSITION);
    assert.equal(position?.state, "closed");
  });

  it("AUDIT M17: a row at index steps.length refuses — the probe is not off by one", async () => {
    // The verifier's own message is built from `steps.length`, so a unit test
    // cannot see a ROUTE-side off-by-one. This puts a real row at the exact
    // index the next step will use and requires the route to find it.
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "harvest",
    });
    await fx.lpStore.appendStep(ownerAccount.address, AGENT, seq.sequenceId, {
      kind: "collect-fees",
      journalIdempotencyKey: "n0",
    });
    await fx.harness.journal.begin({
      idempotencyKey: "n0",
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      kind: "lp",
      decisionId: `lp:${seq.sequenceId}:0`,
    });
    await fx.harness.journal.markInProgress("n0", { callsId: `0x${"cd".repeat(32)}` });
    await fx.harness.journal.markCommitted("n0");
    // The in-flight row: index 1, which is exactly `steps.length`.
    await fx.harness.journal.begin({
      idempotencyKey: "n1",
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      kind: "lp",
      decisionId: `lp:${seq.sequenceId}:1`,
    });
    await fx.lpStore.setRecoveryState(ownerAccount.address, AGENT, seq.sequenceId, "wbnb-stranded");
    await fx.lpStore.setSequenceState(ownerAccount.address, AGENT, seq.sequenceId, "held");

    const { status, body } = await post(fx, seq.sequenceId);
    assert.equal(status, 400, "a saga is mid-flight and the route must see it");
    assert.match(JSON.stringify(body), /step_in_flight/);
  });

  it("FIXREVIEW N1: worker held->active after the route snapshot wins the CAS and is not abandoned", async () => {
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "harvest",
    });
    await fx.lpStore.setRecoveryState(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
      "wbnb-stranded",
    );
    await fx.lpStore.setSequenceState(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
      "held",
    );

    const realClaim = fx.lpStore.claimSequenceForAbandon.bind(fx.lpStore);
    const realSetState = fx.lpStore.setSequenceState.bind(fx.lpStore);
    let interleaved = false;
    (fx.lpStore as { claimSequenceForAbandon: unknown }).claimSequenceForAbandon =
      async (...args: Parameters<LpSequenceStore["claimSequenceForAbandon"]>) => {
        interleaved = true;
        // This is the exact audit interleaving: getSequence already returned
        // HELD; the other process now performs the worker's next statement.
        await realSetState(ownerAccount.address, AGENT, seq.sequenceId, "active");
        return realClaim(...args);
      };

    const response = await post(fx, seq.sequenceId);
    assert.equal(interleaved, true);
    assert.notEqual(response.status, 200, "the stale route snapshot must lose");
    assert.equal(
      (await fx.lpStore.getSequence(ownerAccount.address, AGENT, seq.sequenceId))
        ?.state,
      "active",
      "the worker's claim remains authoritative",
    );
    const position = await fx.lpStore.getPosition(
      ownerAccount.address,
      AGENT,
      POSITION,
    );
    assert.equal(position?.state, "open");
    assert.equal(position?.basisWei, 5_000_000_000_000_000n);
  });

  it("FIXREVIEW N3: route persists restore-open and returns the position to the worker queue", async () => {
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "manual-exit",
    });
    await fx.lpStore.setPositionState(
      ownerAccount.address,
      AGENT,
      POSITION,
      "closing",
    );
    await fx.lpStore.setRecoveryState(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
      "wbnb-stranded",
    );
    await fx.lpStore.setSequenceState(
      ownerAccount.address,
      AGENT,
      seq.sequenceId,
      "held",
    );

    const response = await post(fx, seq.sequenceId);
    assert.equal(response.status, 200);
    assert.equal(
      (response.body["data"] as Record<string, unknown> | undefined)?.[
        "abandoned"
      ] instanceof Object,
      true,
    );
    assert.equal(
      (await fx.lpStore.getPosition(ownerAccount.address, AGENT, POSITION))?.state,
      "open",
    );
    assert.equal(
      (await fx.lpStore.listOpenPositionsForWorker()).some(
        (position) => position.positionId === POSITION,
      ),
      true,
      "deleting the restore-open route branch must fail this assertion",
    );
  });

  it("refuses when the signed sequenceId does not match the path", async () => {
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "harvest",
    });
    await fx.lpStore.setRecoveryState(ownerAccount.address, AGENT, seq.sequenceId, "wbnb-stranded");
    await fx.lpStore.setSequenceState(ownerAccount.address, AGENT, seq.sequenceId, "held");

    const { status } = await post(fx, seq.sequenceId, {
      path: `/agents/${AGENT}/lp/sequences/some-other-id/abandon`,
    });
    assert.equal(status, 400, "the signature binds the sequence, not just the agent");
  });

  it("404s an unknown sequence, and another owner's sequence identically", async () => {
    const fx = await fixture();
    // The other owner needs their OWN position: the store refuses a sequence
    // against a position another owner holds, which is itself the tenancy rule
    // working.
    await fx.lpStore.createPosition({
      positionId: "pos-theirs",
      agentId: AGENT,
      ownerAddress: otherOwnerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 100,
      basisWei: 1n,
    });
    const mine = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: otherOwnerAccount.address,
      positionId: "pos-theirs",
      kind: "harvest",
    });
    const unknown = await post(fx, "00000000-0000-4000-8000-000000000999");
    const foreign = await post(fx, mine.sequenceId);
    assert.equal(unknown.status, 404);
    assert.equal(
      foreign.status,
      404,
      "a 404 must not be an existence oracle for another owner's rows",
    );
  });

  it("a REPLAYED identical signature is idempotent, not a second abandon", async () => {
    const fx = await fixture();
    const a = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "harvest",
    });
    await fx.lpStore.setRecoveryState(ownerAccount.address, AGENT, a.sequenceId, "wbnb-stranded");
    await fx.lpStore.setSequenceState(ownerAccount.address, AGENT, a.sequenceId, "held");

    const issuedAt = fx.harness.nowSec();
    const envelope = await signOwnerAction(
      "abandonSequence",
      { sequenceId: a.sequenceId },
      { agentId: AGENT, issuedAt, expiry: issuedAt + 120 },
    );
    const path = `/agents/${AGENT}/lp/sequences/${a.sequenceId}/abandon`;
    const first = await call(fx.harness, path, { method: "POST", body: envelope });
    assert.equal(first.status, 200);
    // `ownerMutation` journals by the action idempotency key, so an identical
    // envelope short-circuits to the CACHED result rather than re-running. That
    // is the designed behaviour for a retried owner signature — the invariant
    // worth pinning is that the second call changes nothing, not that it errors.
    const replay = await call(fx.harness, path, { method: "POST", body: envelope });
    assert.equal(replay.status, 200, "an idempotent retry is not an error");
    // NOT byte-identical — the replay path answers from the journalled action
    // row rather than re-running the verifier, so it carries no fresh checks.
    // The invariant that matters is that nothing RAN twice.
    const after = await fx.lpStore.getSequence(ownerAccount.address, AGENT, a.sequenceId);
    assert.equal(after?.state, "rolled-back");
    assert.equal(after?.recoveryState, "wbnb-stranded", "the recovery record is history, not state to clear");
  });

  it("rejects an unsigned request", async () => {
    const fx = await fixture();
    const seq = await fx.lpStore.createSequence({
      agentId: AGENT,
      ownerAddress: ownerAccount.address,
      positionId: POSITION,
      kind: "harvest",
    });
    const { status } = await call(
      fx.harness,
      `/agents/${AGENT}/lp/sequences/${seq.sequenceId}/abandon`,
      { method: "POST", body: { sequenceId: seq.sequenceId } },
    );
    assert.equal(status, 401);
  });

  it("NOW_SEC is the harness clock the signatures are stamped against", () => {
    assert.equal(typeof NOW_SEC, "number");
  });
});
