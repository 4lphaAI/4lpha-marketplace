/**
 * Offline tests for the single-use nonce store.
 *
 * The one property that matters is atomic single-use: under concurrency exactly
 * one `consume` for a pair wins. Run against both backends (memory, and Postgres
 * over the fake SQL client) so their semantics are proven identical without a
 * live database. Prune is checked for correctness and owner scoping for isolation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import {
  MemoryNonceStore,
  PostgresNonceStore,
  type NonceStore,
} from "../src/store/nonces.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER_A = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
const OWNER_B = getAddress("0x00000000000000000000000000000000000d3ad1");
const FAR = 9_999_999_999_999;

type Factory = { name: string; make: () => Promise<NonceStore> };
const FACTORIES: readonly Factory[] = [
  { name: "memory", make: async () => new MemoryNonceStore() },
  {
    name: "postgres(fake)",
    make: async () => PostgresNonceStore.create(new FakeSqlClient()),
  },
];

for (const factory of FACTORIES) {
  describe(`NonceStore — ${factory.name}`, () => {
    it("keeps one action-bound provision claim with stable timestamps", async () => {
      const store = await factory.make();
      const first = await store.withProvisionClaimLock(OWNER_A, "provision", async (lease) => {
        assert.deepEqual(await lease.read(), { kind: "absent" });
        assert.equal(await lease.insert({ actionId: "0xaction", state: "live",
          acceptedAtMs: 2_000, authorityExpiresAtMs: 9_000 }), true);
        return lease.read();
      });
      assert.deepEqual(first, { kind: "provision", claim: { actionId: "0xaction", state: "live",
        acceptedAtMs: 2_000, authorityExpiresAtMs: 9_000 } });
      const second = await store.withProvisionClaimLock(OWNER_A, "provision", (lease) => lease.read());
      assert.deepEqual(second, first);
      assert.equal(await store.consume(OWNER_A, "provision", FAR), false);
      await store.close();
    });

    it("serializes a held provision decision and persists terminal transitions", async () => {
      const store = await factory.make();
      let release = (): void => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered = false;
      const first = store.withProvisionClaimLock(OWNER_A, "held", async (lease) => {
        await lease.insert({ actionId: "0xheld", state: "live", acceptedAtMs: 1_000,
          authorityExpiresAtMs: 5_000 });
        entered = true;
        await held;
        await lease.transition("0xheld", "live", "committed");
        return "first";
      });
      while (!entered) await Promise.resolve();
      let secondEntered = false;
      const second = store.withProvisionClaimLock(OWNER_A, "held", async (lease) => {
        secondEntered = true;
        return lease.read();
      });
      await Promise.resolve();
      assert.equal(secondEntered, false);
      release();
      assert.equal(await first, "first");
      assert.deepEqual(await second, { kind: "provision", claim: { actionId: "0xheld",
        state: "committed", acceptedAtMs: 1_000, authorityExpiresAtMs: 5_000 } });
      await store.close();
    });

    it("keeps a failed materialization claim discoverable and prunes only after its full authority boundary", async () => {
      const store = await factory.make();
      await assert.rejects(store.withProvisionClaimLock(OWNER_A, "failed", async (lease) => {
        await lease.insert({ actionId: "0xfailed", state: "live", acceptedAtMs: 1_000,
          authorityExpiresAtMs: 5_000 });
        throw new Error("materialize failed");
      }), /materialize failed/u);
      assert.equal(await store.prune(5_000), 0);
      assert.equal(await store.prune(5_001), 1);
      await store.close();
    });

    it("consumes a nonce once: first true, second false", async () => {
      const store = await factory.make();
      assert.equal(await store.consume(OWNER_A, "n1", FAR), true);
      assert.equal(await store.consume(OWNER_A, "n1", FAR), false);
      await store.close();
    });

    it("resolves concurrent identical consumes to exactly one true", async () => {
      const store = await factory.make();
      const results = await Promise.all([
        store.consume(OWNER_A, "race", FAR),
        store.consume(OWNER_A, "race", FAR),
        store.consume(OWNER_A, "race", FAR),
      ]);
      assert.equal(results.filter((r) => r === true).length, 1);
      await store.close();
    });

    it("scopes nonces by owner: same nonce string, different owners both win", async () => {
      const store = await factory.make();
      assert.equal(await store.consume(OWNER_A, "shared", FAR), true);
      assert.equal(await store.consume(OWNER_B, "shared", FAR), true);
      await store.close();
    });

    it("treats owner casing as the same scope", async () => {
      const store = await factory.make();
      assert.equal(await store.consume(OWNER_A, "cased", FAR), true);
      assert.equal(
        await store.consume(OWNER_A.toLowerCase() as Address, "cased", FAR),
        false,
      );
      await store.close();
    });

    it("prunes expired nonces and leaves live ones", async () => {
      const store = await factory.make();
      await store.consume(OWNER_A, "old", 1_000);
      await store.consume(OWNER_A, "new", FAR);
      const removed = await store.prune(2_000);
      assert.equal(removed, 1);
      // The pruned nonce is free to consume again; the live one is still taken.
      assert.equal(await store.consume(OWNER_A, "old", FAR), true);
      assert.equal(await store.consume(OWNER_A, "new", FAR), false);
      await store.close();
    });
  });
}
