/**
 * PHASE4 — the durable stores, Memory and Postgres-over-FakeSql in parity
 * (R2.6, R2.9/R3.4, R3.5, R2.15/R18).
 *
 * Test obligations 2 and 4. The two decisions under test are the ones the
 * second review extracted one paragraph at a time:
 *
 * - **R3.4** — rescues are COUNTED and never refused. The LP protect precedent
 *   (`lpSequences.ts:1162-1178`) is that the exemption is from REFUSAL, not
 *   from accounting: "the gas-reserve derivation is honest only if every
 *   gas-drawing sequence is counted". A day of six rescues must leave the claim
 *   gate knowing the meter is six submissions lighter.
 * - **R3.5** — a `no-effect` claim KEEPS its quota slot. It submitted, it
 *   confirmed, it drew relay gas; refunding it would let a repeatedly-failing
 *   claim path burn the meter without bound, one refund per cycle.
 *
 * The observation store carries its own safety property, and it is NOT the LP
 * one: losing a row here DELAYS A RESCUE (R2.15/R18), so the parity matters.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import {
  MemoryVenusActionStore,
  PostgresVenusActionStore,
  VenusClaimQuotaError,
  VENUS_QUOTA_WINDOW_MS,
  type VenusActionStore,
} from "../src/store/venusActions.js";
import {
  MemoryVenusObservationStore,
  PostgresVenusObservationStore,
  type VenusObservation,
  type VenusObservationStore,
} from "../src/store/venusObservations.js";
import {
  MemoryVenusSettingsStore,
  PostgresVenusSettingsStore,
  type VenusSettingsStore,
} from "../src/store/venusSettings.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = getAddress("0x561b561ef37874c8e61534be9bae52eb6261ddc4");
const OTHER_OWNER = getAddress("0xc6deb0338869beed7cd6a18bb0458dbbd8b59506");
const AGENT = "venus-guard-1";
const DIGEST = (`0x${"ab".repeat(32)}`) as Hex;

function observation(overrides: Partial<VenusObservation> = {}): VenusObservation {
  return {
    blockNumber: 117_741_526n,
    evaluatedAtMs: 1_000_000,
    healthFactor: 1_200_000_000_000_000_000n,
    shortfall: false,
    breach: true,
    consecutive: 1,
    settingsDigest: DIGEST,
    collateral: 11_144_221_045_975_565_564n,
    debt: 8_000_690_811_010_020_618n,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The action store — R3.4 and R3.5                                           */
/* -------------------------------------------------------------------------- */

const actionBackends: readonly {
  readonly name: string;
  readonly make: (clock: () => number) => Promise<VenusActionStore>;
}[] = [
  {
    name: "memory",
    make: async (clock) => new MemoryVenusActionStore(clock),
  },
  {
    name: "postgres/fakeSql",
    make: async (clock) => PostgresVenusActionStore.create(new FakeSqlClient(), clock),
  },
];

for (const backend of actionBackends) {
  describe(`venus action store (${backend.name}): counted, never refused`, () => {
    it("R3.4 — a rescue is ALWAYS charged, however many have fired today", () => {
      // The whole point: `maxClaimsPerDay` is 1, and ten rescues still land.
      // A daily cap that can refuse the last repay before liquidation is a
      // liquidation vector wearing a budget's name.
      return (async () => {
        let now = 10_000_000;
        const store = await backend.make(() => now);
        for (let index = 0; index < 10; index += 1) {
          now += 1_000;
          const row = await store.charge({
            ownerAddress: OWNER,
            agentId: AGENT,
            actionId: `rescue-${index}`,
            kind: "venusRepay",
            maxClaimsPerDay: 1,
          });
          assert.equal(row.kind, "venusRepay");
        }
        const usage = await store.usageSince(OWNER, AGENT, 0);
        assert.equal(usage.rescues, 10);
        assert.equal(usage.claims, 0);
        // And they are COUNTED, which is what the claim gate and the meter
        // reserve narrow on.
        assert.equal(usage.submissions, 10);
        assert.equal(usage.lastRescueAtMs, now);
        await store.close();
      })();
    });

    it("R3.4 — those counted rescues are visible to the claim side as submissions", () => {
      return (async () => {
        let now = 10_000_000;
        const store = await backend.make(() => now);
        for (const kind of ["venusRepay", "venusSupply", "venusRepay"] as const) {
          now += 1_000;
          await store.charge({
            ownerAddress: OWNER,
            agentId: AGENT,
            actionId: `${kind}-${now}`,
            kind,
            maxClaimsPerDay: 5,
          });
        }
        const usage = await store.usageSince(OWNER, AGENT, 0);
        assert.equal(usage.rescues, 3);
        assert.equal(usage.submissions, 3);
        assert.equal(usage.claims, 0);
        assert.equal(usage.lastClaimAtMs, null);
        await store.close();
      })();
    });

    it("a CLAIM over quota is refused — the cost bound that does bind", () => {
      return (async () => {
        let now = 10_000_000;
        const store = await backend.make(() => now);
        await store.charge({
          ownerAddress: OWNER,
          agentId: AGENT,
          actionId: "claim-1",
          kind: "venusClaim",
          maxClaimsPerDay: 1,
        });
        now += 1_000;
        await assert.rejects(
          store.charge({
            ownerAddress: OWNER,
            agentId: AGENT,
            actionId: "claim-2",
            kind: "venusClaim",
            maxClaimsPerDay: 1,
          }),
          (error: unknown) => {
            assert.ok(error instanceof VenusClaimQuotaError);
            assert.match(error.message, /Rescues are unaffected/u);
            return true;
          },
        );
        // A rescue still lands while the claim side is exhausted.
        const rescue = await store.charge({
          ownerAddress: OWNER,
          agentId: AGENT,
          actionId: "rescue-after-quota",
          kind: "venusRepay",
          maxClaimsPerDay: 1,
        });
        assert.equal(rescue.kind, "venusRepay");
        await store.close();
      })();
    });

    it("R3.5 — a charge is IDEMPOTENT by actionId and never re-checks quota", () => {
      // This is the shape that makes the no-effect rule safe: the row stands
      // for a submission that already happened, so a retry returns it
      // unchanged rather than either double-charging or refunding.
      return (async () => {
        let now = 10_000_000;
        const store = await backend.make(() => now);
        const first = await store.charge({
          ownerAddress: OWNER,
          agentId: AGENT,
          actionId: "claim-once",
          kind: "venusClaim",
          maxClaimsPerDay: 1,
        });
        now += 5_000;
        const again = await store.charge({
          ownerAddress: OWNER,
          agentId: AGENT,
          actionId: "claim-once",
          kind: "venusClaim",
          maxClaimsPerDay: 1,
        });
        assert.deepEqual(again, first);
        assert.equal(again.chargedAtMs, first.chargedAtMs);
        const usage = await store.usageSince(OWNER, AGENT, 0);
        assert.equal(usage.claims, 1);
        await store.close();
      })();
    });

    it("R3.5 — nothing in the store can RELEASE a charged row", () => {
      // The charged-row rule, structurally: there is no release/refund method
      // to call. A `no-effect` outcome keeps its slot because the store offers
      // no way to give it back.
      const store = new MemoryVenusActionStore(() => 0);
      const surface = new Set<string>();
      for (const key of Object.getOwnPropertyNames(
        Object.getPrototypeOf(store) as object,
      )) {
        surface.add(key);
      }
      for (const forbidden of ["release", "refund", "uncharge", "delete", "credit"]) {
        assert.ok(
          !surface.has(forbidden),
          `The action store exposes ${forbidden}(), which R3.5 forbids: a no-effect ` +
            "claim submitted and drew relay gas, and refunding it lets a failing " +
            "claim path burn the meter one refund per cycle.",
        );
      }
    });

    it("the window is rolling: rows outside it stop counting", () => {
      return (async () => {
        let now = 10_000_000;
        const store = await backend.make(() => now);
        await store.charge({
          ownerAddress: OWNER,
          agentId: AGENT,
          actionId: "old-claim",
          kind: "venusClaim",
          maxClaimsPerDay: 1,
        });
        now += VENUS_QUOTA_WINDOW_MS + 1;
        const usage = await store.usageSince(OWNER, AGENT, now - VENUS_QUOTA_WINDOW_MS);
        assert.equal(usage.claims, 0);
        // And the quota admits a new claim now that the old one aged out.
        const fresh = await store.charge({
          ownerAddress: OWNER,
          agentId: AGENT,
          actionId: "new-claim",
          kind: "venusClaim",
          maxClaimsPerDay: 1,
        });
        assert.equal(fresh.kind, "venusClaim");
        await store.close();
      })();
    });

    it("counts are owner-scoped AND agent-scoped — no cross-tenant leakage", () => {
      return (async () => {
        const store = await backend.make(() => 10_000_000);
        await store.charge({
          ownerAddress: OWNER,
          agentId: AGENT,
          actionId: "a",
          kind: "venusClaim",
          maxClaimsPerDay: 5,
        });
        const otherOwner = await store.usageSince(OTHER_OWNER, AGENT, 0);
        assert.equal(otherOwner.submissions, 0);
        const otherAgent = await store.usageSince(OWNER, "someone-elses-agent", 0);
        assert.equal(otherAgent.submissions, 0);
        await store.close();
      })();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The observation store — R2.6 durability and R2.15/R18 scoping              */
/* -------------------------------------------------------------------------- */

const observationBackends: readonly {
  readonly name: string;
  readonly make: () => Promise<VenusObservationStore>;
}[] = [
  { name: "memory", make: async () => new MemoryVenusObservationStore() },
  {
    name: "postgres/fakeSql",
    make: async () => PostgresVenusObservationStore.create(new FakeSqlClient()),
  },
];

for (const backend of observationBackends) {
  describe(`venus observation store (${backend.name})`, () => {
    it("round-trips every decision-bearing field, bigints included", () => {
      return (async () => {
        const store = await backend.make();
        const row = observation();
        await store.put({ ownerAddress: OWNER, agentId: AGENT, kind: "rescue", observation: row });
        const read = await store.get(OWNER, AGENT, "rescue");
        assert.deepEqual(read, row);
        await store.close();
      })();
    });

    it("survives a NEW STORE INSTANCE — the (ae) property, and the reason `--once` can fire", () => {
      return (async () => {
        // The Postgres backend shares one FakeSql client across both instances,
        // which is exactly the "process restarted, database did not" case.
        const sql = new FakeSqlClient();
        const first =
          backend.name === "memory"
            ? new MemoryVenusObservationStore()
            : await PostgresVenusObservationStore.create(sql);
        await first.put({
          ownerAddress: OWNER,
          agentId: AGENT,
          kind: "rescue",
          observation: observation({ consecutive: 1, breach: true }),
        });
        if (backend.name === "memory") {
          // A memory store cannot outlive its process, and the spec says so:
          // the durability claim is the POSTGRES one. Assert the honest thing.
          const read = await first.get(OWNER, AGENT, "rescue");
          assert.equal(read?.breach, true);
          await first.close();
          return;
        }
        const second = await PostgresVenusObservationStore.create(sql);
        const read = await second.get(OWNER, AGENT, "rescue");
        assert.equal(read?.breach, true);
        assert.equal(read?.consecutive, 1);
        await first.close();
        await second.close();
      })();
    });

    it("a replacement OVERWRITES rather than accumulating — one row per (agent, kind)", () => {
      return (async () => {
        const store = await backend.make();
        await store.put({
          ownerAddress: OWNER,
          agentId: AGENT,
          kind: "rescue",
          observation: observation({ consecutive: 1 }),
        });
        await store.put({
          ownerAddress: OWNER,
          agentId: AGENT,
          kind: "rescue",
          observation: observation({ consecutive: 2, evaluatedAtMs: 1_030_000 }),
        });
        const read = await store.get(OWNER, AGENT, "rescue");
        assert.equal(read?.consecutive, 2);
        assert.equal(read?.evaluatedAtMs, 1_030_000);
        await store.close();
      })();
    });

    it("another owner's read returns null — the cross-tenant answer is absence", () => {
      return (async () => {
        const store = await backend.make();
        await store.put({
          ownerAddress: OWNER,
          agentId: AGENT,
          kind: "rescue",
          observation: observation(),
        });
        assert.equal(await store.get(OTHER_OWNER, AGENT, "rescue"), null);
        await store.close();
      })();
    });

    it("an absent row is null, which the trigger treats as NO previous observation", () => {
      return (async () => {
        const store = await backend.make();
        assert.equal(await store.get(OWNER, "never-seen", "rescue"), null);
        await store.close();
      })();
    });

    it("delete makes the next cycle start over rather than acting on a stale count", () => {
      return (async () => {
        const store = await backend.make();
        await store.put({
          ownerAddress: OWNER,
          agentId: AGENT,
          kind: "rescue",
          observation: observation({ consecutive: 1 }),
        });
        await store.delete(OWNER, AGENT, "rescue");
        assert.equal(await store.get(OWNER, AGENT, "rescue"), null);
        await store.close();
      })();
    });

    it("a null health factor (no debt) round-trips as null, not as zero", () => {
      return (async () => {
        const store = await backend.make();
        await store.put({
          ownerAddress: OWNER,
          agentId: AGENT,
          kind: "rescue",
          observation: observation({ healthFactor: null, breach: false, consecutive: 0 }),
        });
        const read = await store.get(OWNER, AGENT, "rescue");
        assert.equal(read?.healthFactor, null);
        await store.close();
      })();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The settings store                                                         */
/* -------------------------------------------------------------------------- */

const settingsBackends: readonly {
  readonly name: string;
  readonly make: () => Promise<VenusSettingsStore>;
}[] = [
  { name: "memory", make: async () => new MemoryVenusSettingsStore() },
  {
    name: "postgres/fakeSql",
    make: async () => PostgresVenusSettingsStore.create(new FakeSqlClient()),
  },
];

for (const backend of settingsBackends) {
  describe(`venus settings store (${backend.name})`, () => {
    it("stores the owner-signed params VERBATIM beside the digest that binds them", () => {
      return (async () => {
        const store = await backend.make();
        const params = { triggerHf: "1300000000000000000", debtMarkets: ["0xabc"] };
        const row = await store.put({
          agentId: AGENT,
          ownerAddress: OWNER,
          params,
          digest: DIGEST,
        });
        assert.deepEqual(row.params, params);
        assert.equal(row.digest, DIGEST);
        const read = await store.get(OWNER, AGENT);
        assert.deepEqual(read?.params, params);
        await store.close();
      })();
    });

    it("a replace keeps one row and moves the digest — which invalidates the counter", () => {
      return (async () => {
        const store = await backend.make();
        await store.put({ agentId: AGENT, ownerAddress: OWNER, params: { a: 1 }, digest: DIGEST });
        const second = await store.put({
          agentId: AGENT,
          ownerAddress: OWNER,
          params: { a: 2 },
          digest: (`0x${"be".repeat(32)}`) as Hex,
        });
        assert.equal(second.digest, `0x${"be".repeat(32)}`);
        const read = await store.get(OWNER, AGENT);
        assert.equal(read?.digest, `0x${"be".repeat(32)}`);
        await store.close();
      })();
    });

    it("another owner reads null rather than someone else's thresholds", () => {
      return (async () => {
        const store = await backend.make();
        await store.put({ agentId: AGENT, ownerAddress: OWNER, params: { a: 1 }, digest: DIGEST });
        assert.equal(await store.get(OTHER_OWNER, AGENT), null);
        await store.close();
      })();
    });
  });
}
