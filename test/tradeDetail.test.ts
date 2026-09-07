import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { createTradeDetailObserver } from "../src/trade/detail.js";
import { positionView } from "../src/trade/view.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");

async function fixture(balance: () => bigint, token: Address = TOKEN, maxAgeMs = 0) {
  const agents = new MemoryAgentStore();
  const agent = await agents.createAgent({ id: "a1", ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed" });
  const positions = new MemoryTradePositionStore(() => 1_000);
  const first = await positions.open({ positionId: "p1", agentId: "a1", ownerAddress: OWNER,
    token, route: { hops: [], fees: [] }, entryWei: 50n, tokenAmount: 100n,
    fillStatus: "verified", openedAt: 500 });
  const observer = createTradeDetailObserver({
    provider: {
      async getTokenBalance() { return balance(); },
      async getTokenMetadata() { return { symbol: "TOK", decimals: 18 }; },
    },
    rpcUrls: [],
    routeReader: {
      async quoteV2(_path, amount) { return amount; },
      async quoteV3Single(_tokenIn, _tokenOut, _fee, amount) { return amount; },
      async quoteV3Path(_path, amount) { return amount; },
    },
    now: () => 2_000,
    maxAgeMs,
  });
  return { agent, positions, first, observer };
}

describe("trade detail observer attribution", () => {
  it("quotes only the exact, unique, verified recorded position amount", async () => {
    const exact = await fixture(() => 100n);
    const [quoted] = await exact.observer.observe(exact.agent, [exact.first]);
    assert.equal(quoted?.quoteStatus, "quoted");
    assert.equal(quoted?.currentQuoteWei, "100");
    assert.equal(quoted?.pnlBps, "10000");

    const extra = await fixture(() => 101n);
    const [unattributed] = await extra.observer.observe(extra.agent, [extra.first]);
    assert.equal(unattributed?.quoteStatus, "unattributed");
    assert.equal(unattributed?.currentQuoteWei, null);
  });

  it("refuses to split a wallet balance across two open rows for the same token", async () => {
    const f = await fixture(() => 100n);
    const second = await f.positions.open({ positionId: "p2", agentId: "a1", ownerAddress: OWNER,
      token: TOKEN, route: { hops: [], fees: [] }, entryWei: 50n, tokenAmount: 100n,
      fillStatus: "verified", openedAt: 600 });
    const values = await f.observer.observe(f.agent, [f.first, second]);
    assert.deepEqual(values.map((value) => value.quoteStatus), ["unattributed", "unattributed"]);
  });

  it("reads balance before quote-cache reuse and invalidates a changed holding", async () => {
    let live = 100n;
    const f = await fixture(() => live, TOKEN, 5_000);
    const [first] = await f.observer.observe(f.agent, [f.first]);
    live = 101n;
    const [second] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(first?.quoteStatus, "quoted");
    assert.equal(second?.quoteStatus, "unattributed");
    assert.equal(second?.liveWalletBalance, "101");
  });

  it("dashes realised PnL until basis, sold amount, and proceeds are all verified", async () => {
    const f = await fixture(() => 0n);
    await f.positions.closePosition({ ownerAddress: OWNER, agentId: "a1", positionId: "p1",
      exitWei: 75n, exitTxHash: `0x${"44".repeat(32)}`, soldTokenAmount: 100n,
      exitFillStatus: "unverified", reason: "owner-request" });
    const closed = await f.positions.get(OWNER, "a1", "p1");
    assert.equal(positionView(closed!, null)["pnlBps"], null);
  });
});
