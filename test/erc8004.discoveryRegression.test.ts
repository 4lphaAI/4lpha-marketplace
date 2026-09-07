import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity, type Erc8004IdentitySummary } from "../src/identity/types.js";
import { fixture, CONFIG } from "./support/erc8004.js";
import { REQUEST } from "./support/minterMigration.js";

for (const postgres of [false, true]) {
  const backend = postgres ? "SQL fake" : "memory";
  test(`${backend}: daemon skips old-minter projections across pages but discovers pending sources`, async () => {
    const f = fixture(postgres, { ...CONFIG, minter: REQUEST.newMinter }); f.sources.rows.clear();
    for (let i = 0; i < 105; i++) {
      const registered = i % 2 === 0;
      const identity: Erc8004IdentitySummary = { ...newIdentity("trading"), status: registered ? "registered" : "blocked",
        agentId: registered ? "42" : null, registrationTxHash: registered ? `0x${"ab".repeat(32)}` : null,
        uriUpdateTxHash: registered ? `0x${"cd".repeat(32)}` : null, errorCode: registered ? null : "nonce_conflict" };
      const id = `old-${i.toString().padStart(3, "0")}`;
      f.sources.rows.set(id, { id, owner: CONFIG.minter, identity, existingId: identity.agentId, category: "trading", eligible: true });
    }
    const pending = { id: "z-pending", owner: CONFIG.minter, identity: newIdentity("trading"), existingId: null, category: "trading" as const, eligible: true };
    f.sources.rows.set(pending.id, pending); const before = structuredClone(f.sources.rows);
    await f.service.discover(); await f.service.discover();
    assert.deepEqual(f.sources.rows, before);
    const state = await f.ledger.read(); assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0]!.publicRef, pending.identity.publicRef); assert.equal(state.jobs[0]!.minter, REQUEST.newMinter);
    for (const id of ["old-000", "old-001"]) await assert.rejects(f.service.discover(id), /invalid_identity/);
    assert.equal(f.gateway.signed.length, 0); assert.equal(f.gateway.sent.length, 0);
  });
  for (const mismatch of ["ref", "owner", "category", "source"] as const) {
    test(`${backend}: current-minter ${mismatch} mismatch remains fail-closed`, async () => {
      const f = fixture(postgres); await f.service.discover(); const before = await f.ledger.read();
      const source = f.sources.rows.get("agent")!;
      const identity = { ...(source.identity as Erc8004IdentitySummary), status: "blocked" as const, errorCode: "nonce_conflict" as const };
      f.sources.rows.clear();
      f.sources.rows.set("agent", { ...source, identity: { ...identity, ...(mismatch === "ref" ? { publicRef: newIdentity("grid").publicRef } : {}),
        ...(mismatch === "category" ? { category: "lp" as const } : {}) },
        ...(mismatch === "owner" ? { owner: REQUEST.newMinter } : {}), ...(mismatch === "source" ? { id: "other" } : {}) });
      await assert.rejects(f.service.discover(), /conflict/); assert.deepEqual(await f.ledger.read(), before);
      assert.equal(f.gateway.signed.length, 0);
    });
  }
  test(`${backend}: contradictory pending source is never silently skipped`, async () => {
    const f = fixture(postgres); const source = f.sources.rows.get("agent")!;
    f.sources.rows.set("agent", { ...source, existingId: "42" });
    await assert.rejects(f.service.discover(), /invalid_identity/); assert.equal((await f.ledger.read()).jobs.length, 0);
  });
}
