import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryAgentStore, PostgresAgentStore, type SessionFacts } from "../src/store/agents.js";
import { PostgresIdentitySources } from "../src/store/erc8004Sources.js";
import { MemoryIdentityFence } from "../src/identity/fence.js";
import { validIdentity, type IdentitySources } from "../src/identity/types.js";
import { agentOwnerView } from "../src/http/wire.js";
import { pendingDraft, DRAFT_KEY } from "./support/provisioningDraft.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { OWNER } from "./support/erc8004.js";
import { validateSessionSpec } from "../src/core/session.js";

const WALLET = "0x3333333333333333333333333333333333333333" as const;
const MASTER = Buffer.alloc(32, 5);
function memorySources(store: MemoryAgentStore): IdentitySources { return { get: (id) => store.identitySource(id), enrolled: (cursor) => store.identityOutbox(cursor), enroll: (id, category) => store.enrollIdentity(id, category), project: (source, next, fence) => store.projectIdentity(source, next, fence) }; }
for (const backend of ["memory", "postgres"] as const) {
  for (const preset of ["grid-v1", "grid-shift-v1", "trade-v1", "lp-v1"] as const) test(`${backend}: ${preset} S3 atomically enrolls once only after successful arm CAS`, async () => {
    const sql = new FakeSqlClient();
    const store = backend === "memory" ? new MemoryAgentStore(MASTER, () => 1000) : await PostgresAgentStore.create(sql, MASTER, () => 1000);
    const draft = pendingDraft(OWNER, WALLET, 1000);
    const pending = { ...draft, sizing: { ...draft.sizing, sizingPreset: preset } };
    const row = await store.createProvisioningAgent({ record: { id: "s3", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey" }, pendingGrant: pending, sessionKey: DRAFT_KEY });
    const facts: SessionFacts = { spec: pending.sessionSpec, permissions: pending.permissions, publicKey: pending.sessionPublicKey, expiry: pending.expiresAt, hireSizing: { name: preset, version: 1, openNativeBudgetWei: "0" } };
    const input = { agentId: "s3", ownerAddress: OWNER, expectedRowVersion: row.rowVersion, expectedGrantDigest: pending.grantDigest, sessionFacts: facts };
    assert.equal((await store.armProvisioningAgent({ ...input, expectedRowVersion: 999 })).updated, false);
    assert.equal((await store.getAgent(OWNER, "s3"))!.erc8004Identity ?? null, null);
    assert.equal((await store.armProvisioningAgent(input)).updated, true);
    const armed = (await store.getAgent(OWNER, "s3"))!; assert.ok(validIdentity(armed.erc8004Identity));
    assert.equal(armed.erc8004Identity.category, preset.startsWith("grid") ? "grid" : preset === "trade-v1" ? "trading" : "lp");
    assert.equal(armed.rowVersion, row.rowVersion + 1);
    assert.equal((await store.armProvisioningAgent(input)).updated, false);
    assert.deepEqual((await store.getAgent(OWNER, "s3"))!.erc8004Identity, armed.erc8004Identity);
    if (backend === "postgres") {
      const statement = sql.observedStatementsForTest().find((text) => text.includes("/* agents.armProvisioning */"))!;
      assert.match(statement, /erc8004_identity = case when erc8004_identity is null and erc8004_agent_id is null then \$7::jsonb else erc8004_identity end/);
      assert.match(statement, /row_version = row_version \+ 1/);
    }
  });
  test(`${backend}: explicit identity writes preserve owner authority CAS version and timestamp`, async () => {
    const sql = new FakeSqlClient(); const store = backend === "memory" ? new MemoryAgentStore(MASTER) : await PostgresAgentStore.create(sql, MASTER);
    const sources = store instanceof MemoryAgentStore ? memorySources(store) : new PostgresIdentitySources(sql);
    const draft = pendingDraft(OWNER, WALLET, 1000);
    const spec = { ...draft.sessionSpec, allowedCalls: [{ to: WALLET, selector: "swap()" }] };
    const facts: SessionFacts = { spec, permissions: validateSessionSpec(spec, { nowSeconds: 1000 }), publicKey: draft.sessionPublicKey, expiry: draft.expiresAt };
    const old = await store.createAgent({ id: "legacy", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa", status: "armed", httpRuntimeProfile: "lp-v1", sessionFacts: facts });
    assert.equal(old.erc8004Identity ?? null, null);
    const source = await sources.enroll("legacy", "grid"); assert.ok(validIdentity(source.identity));
    const summary = source.identity; const fence = new MemoryIdentityFence();
    assert.equal(await sources.project({ ...source, owner: WALLET }, { ...summary, revision: 2, status: "blocked", errorCode: "fee_limit" }, fence), false);
    assert.equal(await sources.project(source, { ...summary, revision: 2, status: "blocked", errorCode: "fee_limit" }, fence), true);
    const after = (await store.getAgent(OWNER, "legacy"))!; assert.equal(after.rowVersion, old.rowVersion); assert.equal(after.updatedAt, old.updatedAt);
    assert.deepEqual(after.sessionFacts, old.sessionFacts); assert.equal(after.walletAddress, old.walletAddress);
    const paused = await store.transitionAgentStatus({ ownerAddress: OWNER, agentId: "legacy", expectedStatus: "armed", expectedRowVersion: old.rowVersion, status: "paused" }); assert.equal(paused!.status, "paused");
    let current = (await sources.get("legacy"))!; assert.ok(validIdentity(current.identity));
    await sources.project(current, { ...current.identity, revision: current.identity.revision + 1 }, fence);
    const capped = await store.updateAgentCapsCas({ ownerAddress: OWNER, agentId: "legacy", expectedRowVersion: paused!.rowVersion, caps: { dailyNativeWei: 10n } }); assert.ok(capped);
    current = (await sources.get("legacy"))!; assert.ok(validIdentity(current.identity));
    await sources.project(current, { ...current.identity, revision: current.identity.revision + 1 }, fence);
    assert.equal((await store.transitionAgentStatus({ ownerAddress: OWNER, agentId: "legacy", expectedStatus: "paused", expectedRowVersion: capped.rowVersion, status: "revoked" }))!.status, "revoked");
    await assert.rejects(sources.enroll("legacy", "grid"));
    if (backend === "postgres") {
      const writes = sql.observedStatementsForTest().filter((text) => text.includes("/* erc8004.enroll */") || text.includes("/* erc8004.project */"));
      assert.ok(writes.length > 0); for (const write of writes) { assert.doesNotMatch(write, /row_version|updated_at/); assert.match(write, /owner_address=\$2/); }
    }
  });
}
test("malformed non-NULL SQL identity neither breaks normal reads nor reenrolls, even JSON null", async () => {
  for (const raw of ["null", '{"status":"registered","agentId":"0"}', '{"private":"poison"}']) {
    const sql = new FakeSqlClient(); const store = await PostgresAgentStore.create(sql, MASTER); const sources = new PostgresIdentitySources(sql);
    const draft = pendingDraft(OWNER, WALLET, 1000);
    await store.createAgent({ id: "bad", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa", status: "armed", sessionFacts: { spec: draft.sessionSpec, permissions: draft.permissions, publicKey: draft.sessionPublicKey, expiry: draft.expiresAt }, httpRuntimeProfile: "lp-v1" });
    sql.setAgentIdentityForTest("bad", raw);
    const row = (await store.getAgent(OWNER, "bad"))!; assert.deepEqual(row.erc8004Identity, { invalid: true });
    assert.deepEqual(agentOwnerView(row).erc8004Identity, { status: "blocked", errorCode: "invalid_identity" });
    await assert.rejects(sources.enroll("bad", "grid")); assert.equal((await store.updateAgentStatus(OWNER, "bad", "paused"))!.status, "paused");
  }
});
test("SQL failed S3 rolls back identity along with authority arm", async () => {
  const sql = new FakeSqlClient(); const store = await PostgresAgentStore.create(sql, MASTER);
  const pending = pendingDraft(OWNER, WALLET, 1000);
  const row = await store.createProvisioningAgent({ record: { id: "rollback", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey" }, pendingGrant: pending, sessionKey: DRAFT_KEY });
  sql.failNextQuery("agents.armProvisioning");
  await assert.rejects(store.armProvisioningAgent({ agentId: row.id, ownerAddress: OWNER, expectedRowVersion: row.rowVersion, expectedGrantDigest: pending.grantDigest, sessionFacts: { spec: pending.sessionSpec, permissions: pending.permissions, publicKey: pending.sessionPublicKey, expiry: pending.expiresAt } }));
  const after = (await store.getAgent(OWNER, row.id))!; assert.equal(after.status, "provisioning"); assert.equal(after.erc8004Identity ?? null, null);
});
for (const backend of ["memory", "postgres"] as const) test(`${backend}: cancelled arm never enrolls; missing/malformed verified session facts cannot legacy-enroll`, async () => {
  const sql = new FakeSqlClient(); const store = backend === "memory" ? new MemoryAgentStore(MASTER, () => 1_000_000) : await PostgresAgentStore.create(sql, MASTER, () => 1_000_000);
  const sources = store instanceof MemoryAgentStore ? memorySources(store) : new PostgresIdentitySources(sql);
  const pending = pendingDraft(OWNER, WALLET, 1000);
  const row = await store.createProvisioningAgent({ record: { id: "cancelled", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey" }, pendingGrant: pending, sessionKey: DRAFT_KEY });
  await store.cancelProvisioningAgent({ agentId: row.id, ownerAddress: OWNER, expectedRowVersion: row.rowVersion, expectedGrantDigest: pending.grantDigest, nowSec: 1000, cancelActionId: `0x${"ab".repeat(32)}` });
  const current = (await store.getAgent(OWNER, row.id))!;
  assert.equal((await store.armProvisioningAgent({ agentId: row.id, ownerAddress: OWNER, expectedRowVersion: current.rowVersion, expectedGrantDigest: pending.grantDigest, sessionFacts: { spec: pending.sessionSpec, permissions: pending.permissions, publicKey: pending.sessionPublicKey, expiry: pending.expiresAt } })).updated, false);
  assert.equal((await store.getAgent(OWNER, row.id))!.erc8004Identity ?? null, null);
  await store.createAgent({ id: "missing", ownerAddress: WALLET, walletAddress: OWNER, custodyModel: "self-eoa", status: "armed", httpRuntimeProfile: "lp-v1" });
  await assert.rejects(sources.enroll("missing", "grid"), /ineligible/);
  await store.updateAgentSessionFacts(WALLET, "missing", { spec: pending.sessionSpec, permissions: pending.permissions, publicKey: "0x00", expiry: pending.expiresAt });
  await assert.rejects(sources.enroll("missing", "grid"), /ineligible/);
});
