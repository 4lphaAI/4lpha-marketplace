import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, zeroAddress, type Hex } from "viem";
import { bsc } from "viem/chains";
import * as PortoKey from "porto/viem/Key";
import { prepareCalls } from "porto/viem/RelayActions";
import { validateSessionSpec } from "../src/core/session.js";
import { createTradfiNativeCostOracle } from "../src/trade/cost.js";
import { encodeLpFinalCallsV1, PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import { WBNB_56 } from "../src/ops/venues.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { AgentRecord } from "../src/store/agents.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x3333333333333333333333333333333333333333");
const ROUTER = getAddress("0x2222222222222222222222222222222222222222");
const EXPIRY = Math.floor(Date.now() / 1_000) + 3_600;

function agent(): AgentRecord {
  const spec = { allowedCalls: [{ to: ROUTER }], spendCaps: [{ token: USDT_56, limit: 10n ** 18n, period: "day" as const }], expiresAt: EXPIRY };
  return {
    id: "cost-agent", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa",
    sessionFacts: { spec, permissions: validateSessionSpec(spec, { minSessionSeconds: 0 }), publicKey: ACCOUNT.publicKey, expiry: EXPIRY },
    sessionRevocation: null, caps: null, status: "armed", httpRuntimeProfile: "unbound-v1",
    erc8004AgentId: null, pendingGrant: null, rowVersion: 1, createdAt: Date.now(), updatedAt: Date.now(),
  } as AgentRecord;
}

test("TradFi cost oracle uses persisted SEC1 facts, normalized Porto address, and no session-key read", async () => {
  const calls = [{ to: ROUTER, value: 0n, data: "0x12345678" as Hex }];
  const executionData = encodeLpFinalCallsV1(calls);
  const currentAgent = agent();
  const facts = currentAgent.sessionFacts!;
  const normalizedKey = PortoKey.fromSecp256k1({ publicKey: facts.publicKey, role: "session", expiry: facts.expiry, permissions: facts.permissions });
  let intentKeyHash = PortoKey.hash(normalizedKey);
  const fakePrepare = (async () => ({
    key: { publicKey: ACCOUNT.address },
    capabilities: { quote: { ttl: Math.floor(Date.now() / 1_000) + 60, quotes: [{
      chainId: 56, orchestrator: PORTO_V055_ORCHESTRATOR, intent: {
        eoa: WALLET, executionData, keyHash: intentKeyHash, expiry: BigInt(EXPIRY),
        paymentToken: zeroAddress, payer: zeroAddress, paymentAmount: 123n, paymentMaxAmount: 123n,
      }, nativeFeeEstimate: { maxFeePerGas: 1n }, txGas: 1n, extraPayment: 0n,
    }] } },
  })) as unknown as typeof prepareCalls;
  let prepareCallsCount = 0;
  const oracle = createTradfiNativeCostOracle({
    network: { chain: bsc, relayUrl: "https://relay.invalid" },
    prepareCallsFn: async (...args) => { prepareCallsCount += 1; return fakePrepare(...args); },
    dataPlane: { tokensBatch: async () => [
      { address: WBNB_56, priceUsd: 600, marketCapUsd: null, volume24hUsd: null, holders: null, priceChange24hPct: null, asOf: Date.now(), source: "fixture", updatedFields: ["priceUsd"], staleness: "fresh" as const },
      { address: USDT_56, priceUsd: 1, marketCapUsd: null, volume24hUsd: null, holders: null, priceChange24hPct: null, asOf: Date.now(), source: "fixture", updatedFields: ["priceUsd"], staleness: "fresh" as const },
    ] },
  });
  assert.ok(oracle);
  const cost = await oracle({ agent: currentAgent, calls });
  assert.equal(cost, 73_800n);
  assert.equal(prepareCallsCount, 1);
  intentKeyHash = `0x${"ff".repeat(32)}` as Hex;
  assert.equal(await oracle({ agent: currentAgent, calls }), null);
  assert.equal(prepareCallsCount, 2);
});
