import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";

test("Agentic isolation: the hidden extra row is indistinguishable from one 32-row settings page", async () => {
  const pages = [];
  const extraCustodies = [];
  for (const hidden of [false, true]) {
    const agents = new MemoryAgentStore(null, () => 1_900_000_000_000);
    const settings = new MemoryTradeSettingsStore(agents, () => 1_900_000_000_000);
    const owner = getAddress("0x1111111111111111111111111111111111111111");
    for (let index = 0; index < 33; index += 1) {
      const id = index < 32 ? `a${index.toString().padStart(2, "0")}` : "agentic-00000000000000000000";
      await agents.createAgent({ id, ownerAddress: owner, walletAddress: getAddress(`0x${(index + 100).toString(16).padStart(40, "0")}`),
        custodyModel: hidden && index === 32 ? "binance-agentic" : "passkey", status: "armed" });
      await settings.put({ agentId: id, ownerAddress: owner, params: DEFAULT_TRADE_SETTINGS,
        digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    }
    const page = await settings.listTradeAgentsForWorker({ limit: 32, cursor: null });
    assert.equal(page.rows.length, 32);
    assert.equal(page.hasMore, true);
    assert.equal(page.cursor, "a31");
    pages.push(page);
    const extra = await settings.listTradeAgentsForWorker({ limit: 32, cursor: page.cursor });
    extraCustodies.push((await agents.getAgentById(extra.rows[0]!.agentId))?.custodyModel);
    await assert.rejects(settings.listTradeAgentsForWorker({ limit: 33, cursor: null }), /1\.\.32/);
  }
  assert.deepEqual(pages[0], pages[1]);
  assert.deepEqual(extraCustodies, ["passkey", "binance-agentic"]);
});
