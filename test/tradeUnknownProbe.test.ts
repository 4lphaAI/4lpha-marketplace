import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { custom, decodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi,
  toFunctionSelector, toHex, type Hex } from "viem";
import type { prepareCalls } from "porto/viem/RelayActions";
import type { WalletCall } from "../src/core/types.js";
import { validateSessionSpec } from "../src/core/session.js";
import { encodeLpFinalCallsV1, fingerprintLpFinalCallsV1, canonicalPreparedIntentIdentityV1,
  PORTO_INTENT_SCHEME, PORTO_NATIVE_FEE_TOKEN, PORTO_V055_CALL_TYPE, PORTO_V055_DECODER,
  PORTO_V055_INTENT_TYPE, PORTO_V055_ORCHESTRATOR, PORTO_V055_VERSION } from "../src/lp/preparedIntent.js";
import { APPROVE_SELECTOR, tradeSessionSpec } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, UNISWAP_V3_ROUTER02_56 } from "../src/ops/venues.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { parseArgs, prepareShape, runProbe, type ProbeAgent, type ProbeReads } from "../scripts/trade-unknown-probe.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const NOW = Date.now();
const spec = { allowedCalls: [{ to: WALLET }], spendCaps: [{ limit: 1n, period: "day" as const }],
  expiresAt: Math.floor(NOW / 1_000) + 3_600 };
const facts = { spec, permissions: validateSessionSpec(spec, { minSessionSeconds: 0 }),
  publicKey: `0x04${"33".repeat(64)}` as Hex, expiry: spec.expiresAt };
const agent: ProbeAgent = { id: "agent", ownerAddress: OWNER, walletAddress: WALLET,
  status: "armed", sessionFacts: facts };

it("P1 probe --agent prints eligibility and nonce gate through read-only ports", async () => {
  const journal = new MemoryExecutionJournal(() => NOW - 300_000);
  const fp = fingerprintLpFinalCallsV1([{ to: WALLET, data: "0x" }]);
  const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME,
    decoder: PORTO_V055_DECODER, chainId: "56", eoa: WALLET.toLowerCase() as typeof WALLET,
    orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: PORTO_V055_VERSION,
    nonce: "9", expiry: "0", executionDataHash: fp.value.executionDataHash,
    keyHash: `0x${"44".repeat(32)}` as Hex });
  await journal.begin({ idempotencyKey: "k", agentId: "agent", ownerAddress: OWNER, kind: "trade",
    finalCallsFingerprint: fp.canonical, finalCallsFingerprintHash: fp.hash });
  await journal.bindPreparedIntent("k", { canonicalIdentity: identity.canonical, identityHash: identity.hash,
    expectedBindingVersion: 0 });
  await journal.markUnknown("k", "ambiguous");
  const reads: ProbeReads = {
    async readAgent() { return agent; }, async listTradfiAgents() { throw new Error("wrong mode"); },
    async listUnsettledKeys() { return ["k"]; }, readJournal: (key) => journal.get(key),
  };
  const lines: string[] = [];
  await runProbe({ args: parseArgs(["--agent", "agent"]), reads, print: (line) => lines.push(line), nowMs: NOW,
    chain: { async finalizedBlock() { return { number: 1_100n, hash: `0x${"55".repeat(32)}` as Hex }; },
      async accountNonce() { return 9n; }, async blockAtOrBefore() { throw new Error("must not read"); },
      async intentExecutedTxHashes() { throw new Error("must not scan"); },
      async readFinalized() { throw new Error("must not read"); } } });
  assert.ok(lines.some((line) => line.startsWith("nonce gate:")));
  assert.ok(lines.some((line) => line.includes("nonce-unconsumed")));
  const source = readFileSync(new URL("../scripts/trade-unknown-probe.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(signCalls|sendPreparedCalls|readExecutingSession|putAgentSessionKey)\b/u);
  assert.doesNotMatch(source, /\b(insert into|update agents|delete from)\b/iu);
});

it("P2 --check-sessions flags permissions and expiry mismatches", async () => {
  const agents: ProbeAgent[] = [agent,
    { ...agent, id: "bad-permissions", sessionFacts: { ...facts, permissions: { calls: [], spend: [] } } },
    { ...agent, id: "bad-expiry", sessionFacts: { ...facts, expiry: facts.expiry + 1 } }];
  const reads: ProbeReads = { async readAgent() { throw new Error("wrong mode"); },
    async listTradfiAgents() { return agents; }, async listUnsettledKeys() { throw new Error("wrong mode"); },
    async readJournal() { throw new Error("wrong mode"); } };
  const lines: string[] = [];
  await runProbe({ args: parseArgs(["--check-sessions"]), reads, print: (line) => lines.push(line) });
  assert.deepEqual(lines, ["agent: permissions=PASS expiry=PASS",
    "bad-permissions: permissions=FAIL expiry=PASS", "bad-expiry: permissions=PASS expiry=FAIL"]);
  assert.deepEqual(parseArgs(["--prepare-shape", "--agent", "agent"]), { kind: "prepare-shape", agentId: "agent" });
});

it("A1 G0b prepares public-only direct and guard grants through the shared validator", async () => {
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const publicKey = "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8" as Hex;
  const stock = getAddress("0x3333333333333333333333333333333333333333");
  const guard = getAddress("0x4444444444444444444444444444444444444444");
  const cases = [
    { name: "Pancake V2", venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56 }, expected: PANCAKE_V2_ROUTER_56 },
    { name: "Pancake V3", venues: { chainId: 56, pancakeRouterV3: PANCAKE_V3_ROUTER_56 }, expected: PANCAKE_V3_ROUTER_56 },
    { name: "Uniswap V3", venues: { chainId: 56, uniswapRouterV3: UNISWAP_V3_ROUTER02_56 }, expected: UNISWAP_V3_ROUTER02_56 },
    { name: "guard", venues: { chainId: 56 }, expected: guard, aggregatorGuard: guard },
  ] as const;
  for (const item of cases) {
    const sessionSpec = tradeSessionSpec({ venues: item.venues, tokens: [{ token: stock }],
      nativeCaps: [{ limit: 10n ** 18n, period: "day" }], expiresAt: expiry,
      nowSeconds: Math.floor(Date.now() / 1_000), quoteToken: USDT_56,
      quoteDailyCapWei: 100n * 10n ** 18n, quotePerTradeCapWei: 10n * 10n ** 18n,
      ...(item.name === "guard" ? { aggregatorGuard: guard } : {}) });
    const permissions = validateSessionSpec(sessionSpec, { minSessionSeconds: 0 });
    const current: ProbeAgent = { id: item.name, ownerAddress: OWNER, walletAddress: WALLET, status: "armed",
      sessionFacts: { spec: sessionSpec, permissions, publicKey, expiry: sessionSpec.expiresAt } };
    const lines: string[] = [];
    let prepares = 0;
    let calls = 0;
    let corruptDigest = false;
    const prepare = (async (...[, request]: Parameters<typeof prepareCalls>) => {
      prepares += 1;
      const account = request.account;
      if (typeof account !== "string") throw new Error("prepare account must be an address");
      assert.equal(request.feeToken, PORTO_NATIVE_FEE_TOKEN);
      assert.equal((request.key as { readonly privateKey?: unknown }).privateKey, undefined);
      const selectedCalls = request.calls as readonly WalletCall[];
      assert.equal(selectedCalls.length, 1);
      const approval = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: selectedCalls[0]!.data! });
      assert.equal(approval.args[0].toLowerCase(), item.expected.toLowerCase());
      assert.equal(approval.args[1], 0n);
      assert.equal(selectedCalls[0]?.to.toLowerCase(), USDT_56.toLowerCase());
      const intent = { eoa: account, executionData: encodeLpFinalCallsV1(selectedCalls), nonce: 1n,
        payer: WALLET, paymentToken: PORTO_NATIVE_FEE_TOKEN, paymentMaxAmount: 0n, combinedGas: 0n,
        encodedPreCalls: [], encodedFundTransfers: [], settler: PORTO_NATIVE_FEE_TOKEN,
        expiry: 0n, isMultichain: false, funder: PORTO_NATIVE_FEE_TOKEN, funderSignature: "0x" };
      const digest = hashTypedData({ domain: { name: "Orchestrator", version: "0.5.5", chainId: 56,
        verifyingContract: PORTO_V055_ORCHESTRATOR }, types: {
        Intent: [{ name: "multichain", type: "bool" }, { name: "eoa", type: "address" },
          { name: "calls", type: "Call[]" }, { name: "nonce", type: "uint256" },
          { name: "payer", type: "address" }, { name: "paymentToken", type: "address" },
          { name: "paymentMaxAmount", type: "uint256" }, { name: "combinedGas", type: "uint256" },
          { name: "encodedPreCalls", type: "bytes[]" }, { name: "encodedFundTransfers", type: "bytes[]" },
          { name: "settler", type: "address" }, { name: "expiry", type: "uint256" }],
        Call: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
      }, primaryType: "Intent", message: { multichain: false, eoa: account,
        calls: selectedCalls.map((call) => ({ to: call.to, value: call.value ?? 0n, data: call.data ?? "0x" })),
        nonce: 1n, payer: WALLET, paymentToken: PORTO_NATIVE_FEE_TOKEN, paymentMaxAmount: 0n,
        combinedGas: 0n, encodedPreCalls: [], encodedFundTransfers: [], settler: PORTO_NATIVE_FEE_TOKEN,
        expiry: 0n } });
      return { capabilities: { quote: { quotes: [{ chainId: 56, orchestrator: PORTO_V055_ORCHESTRATOR, intent }] } },
        context: {}, key: request.key, digest: corruptDigest ? `0x${"44".repeat(32)}` : digest,
        typedData: {} } as unknown as Awaited<ReturnType<typeof prepareCalls>>;
    }) as typeof prepareCalls;
    const transport = () => custom({ request: async ({ method, params }) => {
      calls += 1;
      assert.equal(method, "eth_call");
      const data = (params as readonly [{ readonly data: Hex }])[0].data;
      if (data.startsWith(toFunctionSelector("INTENT_TYPEHASH()"))) return keccak256(toHex(PORTO_V055_INTENT_TYPE));
      if (data.startsWith(toFunctionSelector("CALL_TYPEHASH()"))) return keccak256(toHex(PORTO_V055_CALL_TYPE));
      throw new Error("optional domain read unavailable");
    } });
    await prepareShape(current, "http://offline.invalid", (line) => lines.push(line), { prepare, transport });
    assert.equal(prepares, 1, item.name);
    assert.ok(calls >= 3, item.name);
    assert.ok(lines.includes("prepare-shape: PASS"), item.name);
    assert.ok(lines.includes("INTENT_TYPEHASH: PASS"), item.name);
    assert.ok(lines.includes("CALL_TYPEHASH: PASS"), item.name);
    if (item.name === "Pancake V2") {
      corruptDigest = true;
      await assert.rejects(prepareShape(current, "http://offline.invalid", (line) => lines.push(line),
        { prepare, transport }), /digest differs/u);
      assert.ok(lines.some((line) => line.startsWith("prepare-shape: FAIL")));
    }
  }
  const noVenue = tradeSessionSpec({ venues: { chainId: 56 }, tokens: [{ token: stock }],
    nativeCaps: [{ limit: 10n ** 18n, period: "day" }], expiresAt: expiry,
    nowSeconds: Math.floor(Date.now() / 1_000), quoteToken: USDT_56,
    quoteDailyCapWei: 100n * 10n ** 18n, quotePerTradeCapWei: 10n * 10n ** 18n });
  await assert.rejects(prepareShape({ ...agent, sessionFacts: { spec: noVenue,
    permissions: validateSessionSpec(noVenue, { minSessionSeconds: 0 }), publicKey,
    expiry: noVenue.expiresAt } }, "http://offline.invalid", () => {}),
  /No granted Pancake, Uniswap or aggregator guard target/u);
});

it("N2 a valid venue grant without USDT approve refuses before prepare or transport", async () => {
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const built = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56 },
    tokens: [{ token: getAddress("0x3333333333333333333333333333333333333333") }],
    nativeCaps: [{ limit: 10n ** 18n, period: "day" }], expiresAt: expiry,
    nowSeconds: Math.floor(Date.now() / 1_000), quoteToken: USDT_56,
    quoteDailyCapWei: 100n * 10n ** 18n, quotePerTradeCapWei: 10n * 10n ** 18n });
  const spec = { ...built, allowedCalls: built.allowedCalls.filter((rule) =>
    !(rule.to?.toLowerCase() === USDT_56.toLowerCase() && rule.selector === APPROVE_SELECTOR)) };
  assert.ok(spec.allowedCalls.some((rule) => rule.to?.toLowerCase() === PANCAKE_V2_ROUTER_56.toLowerCase()));
  const publicKey = "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8" as Hex;
  let prepares = 0;
  let transports = 0;
  await assert.rejects(prepareShape({ ...agent, sessionFacts: { spec,
    permissions: validateSessionSpec(spec, { minSessionSeconds: 0 }), publicKey,
    expiry: spec.expiresAt } }, "http://offline.invalid", () => {}, {
    prepare: (async () => { prepares += 1; throw new Error("prepare unexpectedly called"); }) as typeof prepareCalls,
    transport: () => { transports += 1; return custom({ request: async () => { throw new Error("transport unexpectedly used"); } }); },
  }), /does not grant USDT approve/u);
  assert.equal(prepares, 0);
  assert.equal(transports, 0);
});
