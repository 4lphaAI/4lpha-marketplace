/** The Agentic public view carries the ERC-8004 owner summary the Altana owner routes already show; absent until the pairing sweep enrolls the agent. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { MemoryIdentityFence } from "../src/identity/fence.js";
import { NOW, W, fixture } from "./support/agenticSchedule.js";

const HASH_A = `0x${"a1".repeat(32)}` as const, HASH_B = `0x${"b2".repeat(32)}` as const;

async function world(t: TestContext) {
  t.mock.method(Date, "now", () => NOW);
  const f = await fixture(t);
  const view = createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore,
    killswitch: f.killswitch, observer: { observe: async () => [] } });
  return { f, agent: async () => (await view(W)).agent! };
}

test("an Agentic hire with no enrolled identity carries no erc8004Identity key", async (t) => {
  const w = await world(t);
  assert.equal("erc8004Identity" in await w.agent(), false);
});

test("a pending mark is shown as pending, with no agent id and no hashes", async (t) => {
  const w = await world(t);
  await w.f.agents.enrollAgenticIdentity({ ownerAddress: W, agentId: w.f.agent.id, category: "agentic-schedule" });
  const identity = (await w.agent()).erc8004Identity;
  assert.ok(identity !== undefined && "category" in identity);
  assert.equal(identity.category, "agentic-schedule");
  assert.equal(identity.status, "pending");
  assert.equal(identity.agentId, null);
  assert.equal(identity.registrationTxHash, null);
  assert.equal(identity.uriUpdateTxHash, null);
});

test("a registered identity is shown with its agent id and both transaction hashes, exactly as the owner view projects it", async (t) => {
  const w = await world(t);
  await w.f.agents.enrollAgenticIdentity({ ownerAddress: W, agentId: w.f.agent.id, category: "agentic-trade" });
  const source = (await w.f.agents.identitySource(w.f.agent.id))!;
  assert.ok(source.identity !== null && !("invalid" in source.identity));
  const next = { ...source.identity, revision: source.identity.revision + 1, status: "registered" as const, agentId: "364199", registrationTxHash: HASH_A, uriUpdateTxHash: HASH_B };
  assert.equal(await w.f.agents.projectIdentity(source, next, new MemoryIdentityFence()), true);
  assert.deepEqual((await w.agent()).erc8004Identity, next);
});
