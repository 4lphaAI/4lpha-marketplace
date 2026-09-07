/**
 * Offline tests for the kill switch.
 *
 * The behaviours that matter: a paused agent is blocked; a global halt overrides
 * everything including a per-agent unpause; the state is durable (a fresh
 * Postgres instance over the same store still reports the halt); and pauses are
 * owner-scoped so one owner cannot clear another's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  MemoryKillSwitch,
  PostgresKillSwitch,
  type KillSwitch,
} from "../src/killswitch/killswitch.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER_A = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
const OWNER_B = getAddress("0x00000000000000000000000000000000000d3ad1");

type Factory = { name: string; make: () => Promise<KillSwitch> };
const FACTORIES: readonly Factory[] = [
  { name: "memory", make: async () => new MemoryKillSwitch() },
  {
    name: "postgres(fake)",
    make: async () => PostgresKillSwitch.create(new FakeSqlClient()),
  },
];

for (const factory of FACTORIES) {
  describe(`KillSwitch — ${factory.name}`, () => {
    it("blocks a paused agent and clears on unpause by the same owner", async () => {
      const ks = await factory.make();
      assert.equal(await ks.isBlocked("agent-1", OWNER_A), false);
      await ks.pauseAgent("agent-1", OWNER_A);
      assert.equal(await ks.isBlocked("agent-1", OWNER_A), true);
      await ks.unpauseAgent("agent-1", OWNER_A);
      assert.equal(await ks.isBlocked("agent-1", OWNER_A), false);
      await ks.close();
    });

    it("blocks every agent under a global halt and resumes on lift", async () => {
      const ks = await factory.make();
      await ks.halt("incident");
      assert.equal(await ks.isHalted(), true);
      assert.equal(await ks.isBlocked("any-agent", OWNER_A), true);
      await ks.resume();
      assert.equal(await ks.isHalted(), false);
      assert.equal(await ks.isBlocked("any-agent", OWNER_A), false);
      await ks.close();
    });

    it("global halt overrides a per-agent unpause", async () => {
      const ks = await factory.make();
      await ks.pauseAgent("agent-1", OWNER_A);
      await ks.halt();
      await ks.unpauseAgent("agent-1", OWNER_A); // clears the pause...
      assert.equal(await ks.isAgentPaused("agent-1", OWNER_A), false);
      // ...but the global halt still blocks it.
      assert.equal(await ks.isBlocked("agent-1", OWNER_A), true);
      await ks.close();
    });

    it("scopes pauses by owner: a different owner cannot unpause", async () => {
      const ks = await factory.make();
      await ks.pauseAgent("agent-1", OWNER_A);
      await ks.unpauseAgent("agent-1", OWNER_B); // wrong owner: no-op
      assert.equal(await ks.isBlocked("agent-1", OWNER_A), true);
      assert.equal(await ks.isAgentPaused("agent-1", OWNER_B), false);
      await ks.close();
    });
  });
}

describe("KillSwitch — persistence across a fresh instance", () => {
  it("still reports a halt after a new Postgres instance over the same store", async () => {
    const sql = new FakeSqlClient();
    const first = await PostgresKillSwitch.create(sql);
    await first.halt("power cycle");

    // A brand-new instance over the SAME backing store: the halt survives.
    const second = await PostgresKillSwitch.create(sql);
    assert.equal(await second.isHalted(), true);
    assert.equal(await second.isBlocked("agent-9", OWNER_A), true);
    await sql.close();
  });

  it("still reports a per-agent pause after a fresh instance", async () => {
    const sql = new FakeSqlClient();
    const first = await PostgresKillSwitch.create(sql);
    await first.pauseAgent("agent-1", OWNER_A);

    const second = await PostgresKillSwitch.create(sql);
    assert.equal(await second.isAgentPaused("agent-1", OWNER_A), true);
    await sql.close();
  });
});
