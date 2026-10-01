import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryForHire, categoryForPreset, newIdentity, validIdentity, type IdentityJob } from "../src/identity/types.js";
import { metadataTemplate, metadataUri, metadataUriV2, metadataUriV3 } from "../src/identity/metadata.js";
import { validateLedger } from "../src/store/erc8004.js";
import { MemoryAgentStore, PostgresAgentStore, type SessionFacts } from "../src/store/agents.js";
import { PostgresIdentitySources } from "../src/store/erc8004Sources.js";
import { DEFAULT_TRADE_SETTINGS } from "../src/trade/settings.js";
import { validateSessionSpec } from "../src/core/session.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { pendingDraft, DRAFT_KEY } from "./support/provisioningDraft.js";
import { CONFIG, OWNER, fixture } from "./support/erc8004.js";

const REF = "00000000-0000-4000-8000-000000000001";
const WALLET = "0x3333333333333333333333333333333333333333" as const;
const MASTER = Buffer.alloc(32, 5);
const MODES = [
  ["tradfi-trade", "Trade", "An AI trading agent for tokenized US stocks on BNB Chain. It screens the listed stocks and opens positions when its model picks an entry. It sells on the owner's exit rules, and when the owner leaves take-profit, stop-loss or hold time open, the model can also decide to exit."],
  ["tradfi-schedule", "Schedule", "Buys one tokenized US stock with a fixed USDT amount on a recurring schedule on BNB Chain, and skips a buy when the on-chain price trades too far above the stock's reference price."],
  ["tradfi-dca", "DCA", "Auto DCA for one tokenized US stock on BNB Chain. It buys with USDT at set price steps below the start price and keeps a resting take-profit order above the average cost. Stock left unsold carries over, and a new round can start after the take-profit fills."],
  ["tradfi-portfolio", "Portfolio", "Holds a weighted basket of tokenized US stocks on BNB Chain. On the chosen interval it rebalances with USDT toward the owner's target weights when the drift reaches the owner's threshold."],
] as const;

test("TradFi hire derivation covers section 2 without changing any preset", () => {
  for (const [preset, category] of [["grid-v1", "grid"], ["grid-shift-v1", "grid"], ["trade-v1", "trading"], ["lp-v1", "lp"], ["lending-v1", "lending"]] as const) {
    assert.equal(categoryForPreset(preset), category);
    if (preset !== "trade-v1") assert.equal(categoryForHire(preset, { executionModel: "tradfi", tradeMode: "dca" }), category);
  }
  for (const [mode, category] of [[undefined, "tradfi-trade"], ["schedule", "tradfi-schedule"], ["dca", "tradfi-dca"], ["portfolio", "tradfi-portfolio"]] as const) {
    assert.equal(categoryForHire("trade-v1", { executionModel: "tradfi", ...(mode === undefined ? {} : { tradeMode: mode }) }), category);
  }
  for (const model of ["sigma", "degen", "mid-cap", "blue-chip"]) assert.equal(categoryForHire("trade-v1", { executionModel: model, tradeMode: "dca" }), "trading");
  assert.equal(categoryForHire("trade-v1", undefined), "trading");
  assert.equal(categoryForHire("unknown", { executionModel: "tradfi" }), null);
});

for (const backend of ["memory", "postgres"] as const) {
  for (const executionModel of ["tradfi", "sigma"] as const) test(`${backend}: arm derives ${executionModel} identity from pending settings`, async () => {
    const sql = new FakeSqlClient();
    const store = backend === "memory" ? new MemoryAgentStore(MASTER, () => 1000) : await PostgresAgentStore.create(sql, MASTER, () => 1000);
    const draft = pendingDraft(OWNER, WALLET, 1000);
    const pending = { ...draft, initialTradeSettings: { params: { ...DEFAULT_TRADE_SETTINGS, executionModel, ...(executionModel === "tradfi" ? { tradeMode: "dca" as const, settlementAsset: "USDT" as const } : {}) }, digest: draft.grantDigest } };
    const row = await store.createProvisioningAgent({ record: { id: "arm", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey" }, pendingGrant: pending, sessionKey: DRAFT_KEY });
    const facts: SessionFacts = { spec: pending.sessionSpec, permissions: pending.permissions, publicKey: pending.sessionPublicKey, expiry: pending.expiresAt, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } };
    assert.equal((await store.armProvisioningAgent({ agentId: row.id, ownerAddress: OWNER, expectedRowVersion: row.rowVersion, expectedGrantDigest: pending.grantDigest, sessionFacts: facts })).updated, true);
    const armed = (await store.getAgent(OWNER, row.id))!;
    assert.ok(validIdentity(armed.erc8004Identity));
    assert.equal(armed.erc8004Identity.category, executionModel === "tradfi" ? "tradfi-dca" : "trading");
    if (backend === "postgres") assert.match(sql.observedStatementsForTest().find((text) => text.includes("/* agents.armProvisioning */"))!, /then \$7::jsonb else erc8004_identity end/);
  });
}

for (const [category, mode, description] of MODES) test(`${category}: v3 copy and preview, legacy versions refuse`, () => {
  const value: unknown = JSON.parse(Buffer.from(metadataUriV3(category, 1, REF).split(",")[1]!, "base64").toString("utf8"));
  assert.ok(value !== null && typeof value === "object");
  const record = value as Record<string, unknown>;
  assert.equal(record.name, `TradFi ${mode} Agent 1 by 4LPHA`);
  assert.equal(record.description, description);
  assert.equal((record.x4lpha as Record<string, unknown>).category, category);
  assert.equal(metadataTemplate(category).name, `4lpha TradFi ${mode}`);
  assert.equal(metadataTemplate(category).description, description);
  assert.throws(() => metadataUri(category, REF), /invalid_identity/);
  assert.throws(() => metadataUriV2(category, 1, REF), /invalid_identity/);
});

test("TradFi ledger jobs require metadataVersion 3, including when the version is absent", async () => {
  const f = fixture();
  f.sources.rows.set("agent", { id: "agent", owner: OWNER, identity: newIdentity("tradfi-dca"), existingId: null, category: "tradfi-dca", eligible: true });
  await f.service.discover("agent");
  const state = await f.ledger.read();
  for (const metadataVersion of [1, 2, undefined] as const) {
    const job: IdentityJob = { ...state.jobs[0]!, ...(metadataVersion === undefined ? {} : { metadataVersion }) };
    if (metadataVersion === undefined) delete (job as { metadataVersion?: number }).metadataVersion;
    assert.throws(() => validateLedger({ ...state, jobs: [job] }, CONFIG), /intent_mismatch/);
  }
});

for (const postgres of [false, true]) test(`${postgres ? "SQL fake" : "memory"}: TradFi DCA numbering starts at 1 beside an owner's trading job`, async () => {
  const f = fixture(postgres);
  for (const category of ["trading", "tradfi-dca"] as const) {
    f.sources.rows.set(category, { id: category, owner: OWNER, identity: newIdentity(category), existingId: null, category, eligible: true });
    await f.service.discover(category);
  }
  assert.equal((await f.ledger.read()).jobs.find((job) => job.category === "tradfi-dca")!.displayNumber, 1);
});

test("legacy enrollment refuses TradFi and reads settings only if the table exists", async () => {
  for (const present of [false, true]) {
    const fake = new FakeSqlClient();
    const store = await PostgresAgentStore.create(fake, MASTER);
    const draft = pendingDraft(OWNER, WALLET, 1000);
    const spec = { ...draft.sessionSpec, allowedCalls: [{ to: WALLET, selector: "swap()" }] };
    await store.createAgent({ id: "legacy", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa", status: "armed", httpRuntimeProfile: "trade-v1",
      sessionFacts: { spec, permissions: validateSessionSpec(spec, { nowSeconds: 1000 }), publicKey: draft.sessionPublicKey, expiry: draft.expiresAt, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } } });
    let settingsReads = 0;
    const sql: SqlClient = {
      async query<Row>(text: string, params?: readonly unknown[]): Promise<SqlResult<Row>> {
        if (text.includes("to_regclass('trade_settings')")) return { rows: [{ name: present ? "trade_settings" : null }] as Row[] };
        if (text.includes("select params from trade_settings")) {
          assert.ok(present); settingsReads++;
          assert.deepEqual(params, ["legacy", OWNER]);
          return { rows: [{ params: { executionModel: "tradfi" } }] as Row[] };
        }
        return fake.query<Row>(text, params);
      },
      transaction: (fn) => fn(sql), close: async () => {},
    };
    const sources = new PostgresIdentitySources(sql);
    if (present) await assert.rejects(sources.enroll("legacy", "trading"), /ineligible/);
    else assert.equal((await sources.enroll("legacy", "trading")).category, "trading");
    assert.equal(settingsReads, present ? 1 : 0);
  }
});
