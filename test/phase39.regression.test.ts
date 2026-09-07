/**
 * PHASE3.9-AUDIT A1/A2/A4 regressions.
 *
 * Kept outside `test/audit.*`: auditor-owned evidence is immutable. This file
 * injects the failure the original "interrupted ADVANCE" test only named, and
 * pins the finalized block argument that makes a position-closing read safe.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { MemoryLpSequenceStore, lpStepDecisionId } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import type { LpServerDeps } from "../src/server.js";
import {
  call,
  createHarness,
  ownerAccount,
  signOwnerAction,
  type Harness,
} from "./support/serverHarness.js";

const AGENT = "phase39-agent";
const POSITION = "phase39-position";
const TOKEN_ID = "7170374";
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x55d398326f99059fF775485246999027B3197955");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER = getAddress("0x0000000000000000000000000000000000000100");
const MIN_AGE_SEC = 1_800;
const FINALIZED_BLOCK = 116_391_690n;

type Fixture = {
  harness: Harness;
  readonly store: MemoryLpSequenceStore;
  readonly reads: Array<{ readonly tokenId: bigint; readonly blockNumber?: bigint }>;
  failSequenceWrite: boolean;
  failPositionWrite: boolean;
};

async function fixture(
  positionAnswer: LpPositionSnapshot | "burned",
  options: {
    readonly finalized?: "available" | "absent" | "throws";
    readonly strictReaderCapabilities?: boolean;
  } = {},
): Promise<Fixture> {
  const store = new MemoryLpSequenceStore();
  const state: Fixture = {
    harness: undefined as unknown as Harness,
    store,
    reads: [],
    failSequenceWrite: false,
    failPositionWrite: false,
  };
  const serverStore = new Proxy(store, {
    get(target, prop) {
      if (prop === "setSequenceState") {
        return async (...args: Parameters<MemoryLpSequenceStore["setSequenceState"]>) => {
          if (state.failSequenceWrite) {
            state.failSequenceWrite = false;
            throw new Error("sequence write failed after journal advance (injected)");
          }
          return target.setSequenceState(...args);
        };
      }
      if (prop === "setPositionState") {
        return async (...args: Parameters<MemoryLpSequenceStore["setPositionState"]>) => {
          if (state.failPositionWrite && args[3] === "closed") {
            state.failPositionWrite = false;
            throw new Error("position write failed after journal advance (injected)");
          }
          return target.setPositionState(...args);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lp = {
    store: serverStore,
    settingsStore: new MemoryLpSettingsStore(),
    observations: new MemoryLpObservationStore(),
    workerIntervalMs: 60_000,
    railsResult: { ok: false, message: "unused" },
    runtime: {
      maxTickWidth: 4_000,
      maxSlippageBps: 500,
      maxZapPriceImpactBps: 500,
      minPoolLiquidity: 1n,
      twapWindowSec: 300,
      minObservationCardinality: 2,
      maxTwapDeviationBps: 500,
      maxTickDivergence: 500,
      maxBuildAttempts: 1,
      maxTransientRetries: 1,
      resolveMinAgeSec: MIN_AGE_SEC,
      resolveDiscriminatingMultipleBps: 12_000,
      knownStakers: [],
      conversionCompatibleTokens: new Set(),
    },
    venue: { nfpm: NFPM, routerV3: ROUTER, wbnb: WBNB },
    readers: {
      positions: async (tokenId: bigint, blockNumber?: bigint) => {
        state.reads.push({
          tokenId,
          ...(blockNumber === undefined ? {} : { blockNumber }),
        });
        return positionAnswer;
      },
      ...(options.finalized === "absent"
        ? {}
        : {
            finalizedBlockNumber:
              options.finalized === "throws"
                ? async () => {
                    throw new Error("finalized head unavailable");
                  }
                : async () => FINALIZED_BLOCK,
          }),
      blockNumber: async () => FINALIZED_BLOCK + 10n,
      receipts: {},
    },
  } as unknown as LpServerDeps;
  state.harness = await createHarness({
    lp,
    ...(options.strictReaderCapabilities === undefined
      ? {}
      : { strictLpReaderCapabilities: options.strictReaderCapabilities }),
  });
  await state.harness.agentStore.createAgent({
    id: AGENT,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    status: "armed",
  });
  return state;
}

async function seed(
  fx: Fixture,
): Promise<{ decisionId: string; key: string; sequenceId: string }> {
  await fx.store.createPosition({
    positionId: POSITION,
    agentId: AGENT,
    ownerAddress: ownerAccount.address,
    token0: WBNB,
    token1: TOKEN,
    fee: 2500,
    tokenId: TOKEN_ID,
    basisWei: 5_000_000_000_000_000n,
  });
  await fx.store.setPositionState(
    ownerAccount.address,
    AGENT,
    POSITION,
    "closing",
  );
  const sequence = await fx.store.createSequence({
    agentId: AGENT,
    ownerAddress: ownerAccount.address,
    positionId: POSITION,
    kind: "manual-exit",
  });
  const key = `phase39:${sequence.sequenceId}:0`;
  const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
  await fx.store.appendStep(ownerAccount.address, AGENT, sequence.sequenceId, {
    kind: "zap-out",
    journalIdempotencyKey: key,
  });
  await fx.harness.journal.begin({
    idempotencyKey: key,
    agentId: AGENT,
    ownerAddress: ownerAccount.address,
    kind: "lp",
    decisionId,
  });
  await fx.harness.journal.markUnknown(key, "relay timeout");
  fx.harness.advance((MIN_AGE_SEC + 60) * 1_000);
  return { decisionId, key, sequenceId: sequence.sequenceId };
}

async function resolve(fx: Fixture, decisionId: string) {
  const issuedAt = fx.harness.nowSec();
  const envelope = await signOwnerAction(
    "resolveUnknown",
    { decisionId, observedBlock: "116391700" },
    { agentId: AGENT, issuedAt, expiry: issuedAt + 120 },
  );
  return call(fx.harness, `/agents/${AGENT}/journal/${decisionId}/resolve`, {
    method: "POST",
    body: envelope,
  });
}

function resolution(body: Record<string, unknown>): Record<string, unknown> {
  const data = body["data"] as Record<string, unknown> | undefined;
  return (data?.["resolution"] ?? {}) as Record<string, unknown>;
}

describe("PHASE3.9 audit regressions", () => {
  it("N2 window 1: a failed position close leaves the sequence non-terminal and re-signs without a chain reread", async () => {
    const fx = await fixture("burned");
    const seeded = await seed(fx);
    fx.failPositionWrite = true;

    const first = await resolve(fx, seeded.decisionId);
    assert.notEqual(first.status, 200, "the injected post-journal position failure surfaced");
    assert.equal((await fx.harness.journal.get(seeded.key))?.state, "COMMITTED");
    assert.equal(
      (await fx.store.getSequence(ownerAccount.address, AGENT, seeded.sequenceId))?.state,
      "active",
      "the terminal latch cannot precede the position close",
    );
    assert.equal(
      (await fx.store.getPosition(ownerAccount.address, AGENT, POSITION))?.state,
      "closing",
    );
    assert.equal(fx.reads.length, 1);

    const second = await resolve(fx, seeded.decisionId);
    assert.equal(second.status, 200);
    assert.equal(resolution(second.body)["action"], "advance");
    assert.equal(
      (await fx.store.getPosition(ownerAccount.address, AGENT, POSITION))?.state,
      "closed",
    );
    assert.equal(
      (await fx.store.getSequence(ownerAccount.address, AGENT, seeded.sequenceId))?.state,
      "rolled-back",
    );
    assert.equal(fx.reads.length, 1, "re-entry trusts the persisted COMMITTED verdict");
  });

  it("N2 window 2 and N3: a failed terminal latch leaves the position closed and re-enters as the same advance record", async () => {
    const fx = await fixture("burned");
    const seeded = await seed(fx);
    fx.failSequenceWrite = true;

    const first = await resolve(fx, seeded.decisionId);
    assert.notEqual(first.status, 200, "the injected post-journal failure surfaced");
    assert.equal((await fx.harness.journal.get(seeded.key))?.state, "COMMITTED");
    assert.equal(
      (await fx.store.getPosition(ownerAccount.address, AGENT, POSITION))?.state,
      "closed",
      "the position close precedes the terminal sequence latch",
    );
    assert.equal(
      (await fx.store.getSequence(ownerAccount.address, AGENT, seeded.sequenceId))?.state,
      "active",
    );
    assert.deepEqual(fx.reads, [
      { tokenId: BigInt(TOKEN_ID), blockNumber: FINALIZED_BLOCK },
    ]);

    const second = await resolve(fx, seeded.decisionId);
    assert.equal(second.status, 200);
    const result = resolution(second.body);
    assert.equal(result["action"], "advance");
    assert.equal(result["journalState"], "COMMITTED");
    assert.equal(result["inference"], false);
    assert.equal(result["positionEvidenceBlock"], FINALIZED_BLOCK.toString(10));
    assert.match(String(result["note"]), /recorded COMMITTED.*finalized/iu);
    assert.equal(result["reEntry"], true);
    assert.equal(
      (await fx.store.getPosition(ownerAccount.address, AGENT, POSITION))?.state,
      "closed",
    );
    const stored = await fx.harness.journal.get(seeded.key);
    assert.equal(stored?.state, "COMMITTED");
    assert.match(stored?.externalRef.resolution?.disposition ?? "", /^advanced /u);
    assert.equal(fx.reads.length, 1, "re-entry trusts recorded evidence and never re-reads chain");
  });

  it("N3/A4: funded evidence persists and reports the same inferred abandon", async () => {
    const fx = await fixture({ liquidity: 99n, tickLower: -100, tickUpper: 100 });
    const seeded = await seed(fx);
    const response = await resolve(fx, seeded.decisionId);
    assert.equal(response.status, 200);
    const result = resolution(response.body);
    assert.equal(result["action"], "abandon");
    assert.equal(result["journalState"], "ROLLED_BACK");
    assert.equal(result["inference"], true);
    assert.match(String(result["note"]), /abandoned, never retried/iu);
    assert.equal(result["positionEvidenceBlock"], FINALIZED_BLOCK.toString(10));
    const row = await fx.harness.journal.get(seeded.key);
    assert.equal(row?.state, "ROLLED_BACK");
    assert.match(row?.externalRef.resolution?.disposition ?? "", /^abandoned /u);
    assert.equal(
      row?.externalRef.resolution?.positionEvidenceBlock,
      FINALIZED_BLOCK.toString(10),
    );
    assert.deepEqual(fx.reads, [
      { tokenId: BigInt(TOKEN_ID), blockNumber: FINALIZED_BLOCK },
    ]);
  });

  for (const finalized of ["absent", "throws"] as const) {
    it(`N1: ${finalized} finalized seam refuses even when ordinary blockNumber works`, async () => {
      const fx = await fixture("burned", {
        finalized,
        strictReaderCapabilities: true,
      });
      const seeded = await seed(fx);
      const response = await resolve(fx, seeded.decisionId);

      assert.notEqual(response.status, 200);
      assert.equal(fx.reads.length, 0, "positions must not run without a finalized height");
      assert.equal((await fx.harness.journal.get(seeded.key))?.state, "UNKNOWN");
      assert.equal(
        (await fx.store.getPosition(ownerAccount.address, AGENT, POSITION))?.state,
        "closing",
      );
      assert.equal(
        (await fx.store.getSequence(ownerAccount.address, AGENT, seeded.sequenceId))?.state,
        "active",
      );
      assert.match(JSON.stringify(response.body), /finalized/iu);
    });
  }
});
