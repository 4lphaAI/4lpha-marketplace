import assert from "node:assert/strict";
import { it } from "node:test";
import { BNB } from "@altananetwork/sdk";
import { custom, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData,
  padHex, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { prepareCalls, sendPreparedCalls, signCalls } from "porto/viem/RelayActions";
import type { ExecutionReceipt, AwaitExecutionParams, WalletCall, WalletProvider } from "../src/core/types.js";
import type { PortoStagedLpSubmit } from "../src/lp/preparedIntent.js";
import { canonicalPreparedIntentIdentityV1, encodeLpFinalCallsV1, PORTO_INTENT_SCHEME,
  PORTO_V055_DECODER, PORTO_V055_ORCHESTRATOR, PORTO_V055_VERSION, PortoStagedLpAdapter } from "../src/lp/preparedIntent.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { validateSessionSpec } from "../src/core/session.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal, PostgresExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { PORTO_V055_INTENT_PARAMETERS, INTENT_EXECUTED_TOPIC } from "../src/lp/intentDecoder.js";
import { assessTradeUnknown } from "../src/trade/unknownResolve.js";
import { executeTradeForAgent } from "../src/trade/execute.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { TradeRequest } from "../src/http/wire.js";
import { FakeWalletProvider, SESSION_KEY, tradeConfig } from "./support/serverHarness.js";
import { decodeAbiParameters, decodeFunctionData, keccak256 } from "viem";
import { createTradfiEvidenceWriter, type TradfiPreflightDeps } from "../src/trade/simulate.js";
import { MemoryTradeSimulationStore } from "../src/store/tradeSimulations.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const KEYSTORE = getAddress("0x5555555555555555555555555555555555555555");
const ID = `0x${"11".repeat(32)}` as Hex;
const CALLS_ID = `0x${"cc".repeat(32)}` as Hex;
const TX = `0x${"dd".repeat(32)}` as Hex;
const OTHER_TX = `0x${"ee".repeat(32)}` as Hex;
const NOW = Date.now();
const E = 10n ** 18n;
const VENUES = { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } as const;
const scanGate = { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) };

class StagedProvider extends FakeWalletProvider {
  submissions = 0;
  onSubmit?: (params: PortoStagedLpSubmit) => Promise<ExecutionReceipt>;
  onAwait?: (params: AwaitExecutionParams) => Promise<ExecutionReceipt>;
  async submitPreparedTrade(params: PortoStagedLpSubmit): Promise<ExecutionReceipt> {
    this.submissions += 1;
    if (this.onSubmit !== undefined) return this.onSubmit(params);
    const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME, decoder: PORTO_V055_DECODER,
      chainId: "56", eoa: WALLET, orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: PORTO_V055_VERSION,
      nonce: "1", expiry: "0", executionDataHash: params.expectedExecutionDataHash,
      keyHash: `0x${"aa".repeat(32)}` as Hex });
    const request = { journalIdempotencyKey: params.journalIdempotencyKey, canonicalIdentity: identity.canonical,
      identityHash: identity.hash, expectedBindingVersion: params.expectedBindingVersion,
      preparedHandle: Object.freeze({}), preparedDigest: `0x${"12".repeat(32)}` as Hex };
    await params.bind(request);
    return { status: "PENDING", callsId: CALLS_ID };
  }
  override async awaitExecution(params: AwaitExecutionParams): Promise<ExecutionReceipt> {
    return this.onAwait === undefined ? { status: "CONFIRMED", callsId: CALLS_ID, transactionHash: TX } : this.onAwait(params);
  }
}

async function fixture(stagedSubmit = true, v2 = true, suppliedJournal?: ExecutionJournal, withFee = false) {
  const agents = new MemoryAgentStore(undefined, () => NOW);
  const spec = tradeSessionSpec({ venues: VENUES, tokens: [{ token: TOKEN }], ...(withFee ? { treasury: OWNER } : {}), nativeCaps: [{ limit: E, period: "day" }],
    expiresAt: Math.floor(NOW / 1_000) + 86_400, nowSeconds: Math.floor(NOW / 1_000),
    ...(v2 ? { quoteToken: USDT_56, quoteDailyCapWei: 300n * E, quotePerTradeCapWei: 20n * E, platformFeeBps: 0 } : {}) });
  const agent = await agents.createAgent({ id: "staged", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey",
    status: "armed", caps: { dailyNativeWei: E, perTradeNativeWei: E / 10n },
    sessionFacts: { spec, permissions: validateSessionSpec(spec, { minSessionSeconds: 0, nowSeconds: Math.floor(NOW / 1_000) }),
      publicKey: privateKeyToAccount(SESSION_KEY).publicKey, expiry: spec.expiresAt,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        ...(v2 ? { settlementAsset: "USDT" as const, minEntryWei: (5n * E).toString(),
          entryWei: (20n * E).toString(), quotePerTradeWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString() } : {}) } } });
  await agents.putAgentSessionKey(OWNER, agent.id, SESSION_KEY);
  const journal = suppliedJournal ?? new MemoryExecutionJournal(() => NOW);
  const provider = new StagedProvider();
  const request: TradeRequest = { decisionId: "decision", venue: "pancake", side: "buy", token: TOKEN,
    amountWei: v2 ? 10n * E : 1_000n, quotedOutWei: v2 ? 10n * E : 1_000n,
    minOutWei: v2 ? 10n * E * 97n / 100n : 990n,
    ...(v2 ? { settlementAsset: "USDT" as const, platformFeeAtomic: withFee ? E / 10n : 0n } : {}) };
  const run = (wallet: WalletProvider = provider, preflight?: TradfiPreflightDeps) => executeTradeForAgent({ agent, request, idempotencyKey: ID,
    paramsHash: ID, scanGate, deps: { chainId: 56, keyStore: KEYSTORE, agentStore: agents, journal,
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => wallet }, ...(preflight === undefined ? {} : { preflight }), trade: tradeConfig({
        venues: VENUES, stagedSubmit, ...(withFee ? { feeBps: 100, feeTreasury: OWNER } : {}) }), pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 },
      pancakeV3: null, uniswapV3: null, flapPortal: null, nowMs: () => NOW } });
  return { agent, agents, journal, provider, request, run };
}

function realAdapter(mode: "valid" | "substituted" | "nonce" | "calls", counts: { bind: number; sign: number; send: number },
  onSend?: () => void) {
  return new PortoStagedLpAdapter({ network: BNB,
    transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
    functions: {
      prepare: (async (...[, request]: Parameters<typeof prepareCalls>) => {
        const account = request.account;
        if (typeof account !== "string") throw new Error("prepare account must be an address");
        const calls = (request.calls ?? []) as readonly WalletCall[];
        const intent = { eoa: account, executionData: encodeLpFinalCallsV1(calls), nonce: 1n,
          payer: WALLET, paymentToken: getAddress("0x0000000000000000000000000000000000000000"),
          paymentMaxAmount: 0n, combinedGas: 0n, encodedPreCalls: [], encodedFundTransfers: [],
          settler: getAddress("0x0000000000000000000000000000000000000000"), expiry: 0n,
          isMultichain: false, funder: getAddress("0x0000000000000000000000000000000000000000"),
          funderSignature: "0x" };
        const digest = mode === "substituted" ? TX : hashTypedData({
          domain: { name: "Orchestrator", version: "0.5.5", chainId: 56, verifyingContract: PORTO_V055_ORCHESTRATOR },
          types: { Intent: [
            { name: "multichain", type: "bool" }, { name: "eoa", type: "address" },
            { name: "calls", type: "Call[]" }, { name: "nonce", type: "uint256" },
            { name: "payer", type: "address" }, { name: "paymentToken", type: "address" },
            { name: "paymentMaxAmount", type: "uint256" }, { name: "combinedGas", type: "uint256" },
            { name: "encodedPreCalls", type: "bytes[]" }, { name: "encodedFundTransfers", type: "bytes[]" },
            { name: "settler", type: "address" }, { name: "expiry", type: "uint256" },
          ], Call: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] },
          primaryType: "Intent", message: { multichain: false, eoa: account,
            calls: (mode === "calls" ? calls.slice(1) : calls).map((call) => ({ to: call.to,
              value: call.value ?? 0n, data: call.data ?? "0x" })), nonce: mode === "nonce" ? 2n : 1n,
            payer: WALLET, paymentToken: intent.paymentToken, paymentMaxAmount: 0n, combinedGas: 0n,
            encodedPreCalls: [], encodedFundTransfers: [], settler: intent.settler, expiry: 0n },
        });
        return { capabilities: { quote: { quotes: [{ chainId: 56, orchestrator: PORTO_V055_ORCHESTRATOR, intent }] } },
          context: {}, key: request.key, digest, typedData: {} } as unknown as Awaited<ReturnType<typeof prepareCalls>>;
      }) as typeof prepareCalls,
      sign: (async () => { assert.equal(counts.bind, 1); counts.sign += 1;
        return `0x${"12".repeat(65)}` as Hex; }) as typeof signCalls,
      send: (async () => { counts.send += 1; onSend?.(); return { id: CALLS_ID }; }) as typeof sendPreparedCalls,
    },
  });
}

it("E3 staged simulated revert cannot bind, sign, send or await", async () => {
  const f = await fixture(); let awaited = 0;
  f.provider.onAwait = async () => { awaited += 1; throw new Error("unreachable"); };
  const result = await f.run(f.provider, { evidence: { insert: () => {} }, simulate: async () => ({ status: "FAILED", failReason: "execution reverted: STF", balanceChanges: [], otherChangeCount: 0, upstreamMs: 1 }) });
  assert.equal(result.kind, "rolled-back"); assert.equal(f.provider.submissions, 0); assert.equal(awaited, 0);
  assert.equal((await f.journal.get(ID))?.state, "ROLLED_BACK"); assert.equal(await f.journal.sumPendingQuoteSpendSince(f.agent.id, 0), 0n);
});

it("E6/R2.10 fee-bearing staged simulation matches the real adapter's independent hash", async () => {
  const f = await fixture(true, true, undefined, true), store = new MemoryTradeSimulationStore(), evidence = createTradfiEvidenceWriter(store, () => {});
  let executionData: Hex = "0x";
  const counts = { bind: 0, sign: 0, send: 0 }, adapter = realAdapter("valid", counts);
  f.provider.onSubmit = params => {
    assert.equal(keccak256(executionData), params.expectedExecutionDataHash);
    const [simulated] = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], executionData);
    assert.deepEqual(simulated.map(row => ({ to: row.target.toLowerCase(), value: row.value, data: row.data })), params.calls.map(call => ({ to: call.to.toLowerCase(), value: call.value ?? 0n, data: call.data ?? "0x" })));
    assert.equal(params.calls.at(-1)?.to.toLowerCase(), USDT_56.toLowerCase());
    return adapter.submit({ ...params, bind: async request => {
      const identity = JSON.parse(request.canonicalIdentity) as { executionDataHash: Hex };
      assert.equal(identity.executionDataHash, keccak256(executionData)); counts.bind += 1; return params.bind(request);
    } });
  };
  const result = await f.run(f.provider, { evidence, simulate: async tx => {
    executionData = decodeFunctionData({ abi: parseAbi(["function execute(bytes32,bytes)"]), data: tx.data }).args[1];
    return { status: "SUCCESS", failReason: null, balanceChanges: [], otherChangeCount: 0, upstreamMs: 0 };
  } });
  assert.equal(result.kind, "committed"); assert.equal(counts.send, 1); assert.equal(counts.sign, 1); await evidence.shutdown();
});

it("A3 executor activates real adapter signed-payload binding for valid and substituted digests", async () => {
  for (const mode of ["valid", "substituted", "nonce", "calls"] as const) {
    const f = await fixture();
    const counts = { bind: 0, sign: 0, send: 0 };
    const adapter = realAdapter(mode, counts);
    f.provider.onSubmit = (params) => adapter.submit({ ...params, bind: async (request) => {
      counts.bind += 1;
      return params.bind(request);
    } });
    const result = await f.run();
    const row = await f.journal.get(ID);
    if (mode === "valid") {
      assert.equal(result.kind, "committed");
      assert.equal(row?.state, "COMMITTED");
      assert.deepEqual(counts, { bind: 1, sign: 1, send: 1 });
    } else {
      assert.equal(result.kind, "rolled-back", mode);
      if (result.kind === "rolled-back") assert.equal(result.code, "RELAY_PREPARE_REFUSED");
      assert.equal(row?.state, "ROLLED_BACK");
      assert.deepEqual(counts, { bind: 0, sign: 0, send: 0 }, mode);
    }
  }
});

it("E1/E2 flag off and native requests use the legacy provider", async () => {
  for (const [flag, v2] of [[false, true], [true, false]] as const) {
    const f = await fixture(flag, v2);
    const result = await f.run();
    assert.equal(result.kind, "committed");
    assert.equal(f.provider.submissions, 0);
    assert.equal(f.provider.executeCalls.length, 1);
    assert.equal((await f.journal.get(ID))?.finalCallsFingerprint, null);
  }
});

it("E5/E6 staged CONFIRMED and FAILED complete under their callsId", async () => {
  for (const status of ["CONFIRMED", "FAILED"] as const) {
    const f = await fixture();
    f.provider.onAwait = async () => status === "CONFIRMED"
      ? { status, callsId: CALLS_ID, transactionHash: TX }
      : { status, callsId: CALLS_ID, failureCode: "PROVIDER_ERROR" };
    const result = await f.run();
    const row = await f.journal.get(ID);
    assert.equal(result.kind, "committed");
    assert.equal(row?.state, status === "CONFIRMED" ? "COMMITTED" : "ROLLED_BACK");
    assert.equal(row?.externalRef.callsId, CALLS_ID);
    assert.ok(row?.finalCallsFingerprint && row.preparedIntentIdentity);
    if (status === "CONFIRMED") assert.equal(row.externalRef.txHash, TX);
    else assert.equal(row?.lastError, "PROVIDER_ERROR");
  }
});

it("E7 PENDING, transport throw and absent callsId keep the correct ambiguous state", async () => {
  for (const mode of ["pending", "throw", "no-id"] as const) {
    const f = await fixture();
    if (mode === "no-id") f.provider.onSubmit = async (params) => {
      await new StagedProvider().submitPreparedTrade(params);
      return { status: "PENDING" };
    };
    else f.provider.onAwait = async () => mode === "pending" ? { status: "PENDING" } : Promise.reject(new Error("relay unavailable"));
    const result = await f.run();
    assert.equal(result.kind, "unknown");
    assert.equal((await f.journal.get(ID))?.state, mode === "no-id" ? "UNKNOWN" : "IN_PROGRESS");
  }
});

it("E7 hard 45 s race drops late CONFIRMED and FAILED results", async () => {
  for (const status of ["CONFIRMED", "FAILED"] as const) {
    const f = await fixture();
    let late: (value: ExecutionReceipt) => void = () => { throw new Error("await did not start"); };
    f.provider.onAwait = async () => new Promise<ExecutionReceipt>((resolve) => { late = resolve; });
    const originalSetTimeout = globalThis.setTimeout;
    let fire: (() => void) | undefined;
    globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number) => {
      assert.equal(delay, 45_000);
      fire = () => callback();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    try {
      const pending = f.run();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(fire);
      fire();
      assert.equal((await pending).kind, "unknown");
      late(status === "CONFIRMED" ? { status, callsId: CALLS_ID, transactionHash: TX }
        : { status, callsId: CALLS_ID, failureCode: "PROVIDER_ERROR" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await f.journal.get(ID))?.state, "IN_PROGRESS");
    } finally { globalThis.setTimeout = originalSetTimeout; }
  }
});

it("R4.1 competing terminal hash is never overwritten by the executor", async () => {
  const f = await fixture();
  f.provider.onAwait = async () => {
    await f.journal.markCommitted(ID, { txHash: OTHER_TX });
    return { status: "CONFIRMED", callsId: CALLS_ID, transactionHash: TX };
  };
  const result = await f.run();
  assert.equal(result.kind, "unknown");
  assert.equal((await f.journal.get(ID))?.externalRef.txHash, OTHER_TX);
});

it("R4.1 a competing hash between await and completion wins on both journal stores", async () => {
  for (const base of [new MemoryExecutionJournal(() => NOW),
    await PostgresExecutionJournal.create(new FakeSqlClient(), () => NOW)] as ExecutionJournal[]) {
    let guarded = 0;
    const journal = new Proxy(base, { get(target, property) {
      if (property === "completeStagedTrade") return async (...args: Parameters<ExecutionJournal["completeStagedTrade"]>) => {
        guarded += 1;
        await target.markCommitted(ID, { txHash: OTHER_TX });
        return target.completeStagedTrade(...args);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const f = await fixture(true, true, journal);
    const result = await f.run();
    assert.equal(guarded, 1);
    assert.equal(result.kind, "unknown");
    assert.equal((await base.get(ID))?.externalRef.txHash, OTHER_TX);
    assert.equal((await base.get(ID))?.state, "COMMITTED");
    await base.close();
  }
});

it("R4.5 d2 real adapter signs and sends while serialized reconciliation waits behind the binder", async () => {
  const inner = new FakeSqlClient();
  let enteredBind: () => void = () => {};
  let releaseBind: () => void = () => {};
  let enteredTransition: () => void = () => {};
  let releaseTransition: () => void = () => {};
  let sent: () => void = () => {};
  const bindEntered = new Promise<void>((resolve) => { enteredBind = resolve; });
  const bindHeld = new Promise<void>((resolve) => { releaseBind = resolve; });
  const transitionEntered = new Promise<void>((resolve) => { enteredTransition = resolve; });
  const transitionHeld = new Promise<void>((resolve) => { releaseTransition = resolve; });
  const sendDone = new Promise<void>((resolve) => { sent = resolve; });
  let transitionGated = false;
  const sql: SqlClient = {
    async query<R = Record<string, unknown>>(query: string, params: readonly unknown[] = []): Promise<SqlResult<R>> {
      const result = await inner.query<R>(query, params);
      if (query.includes("journal.bindPreparedUpdate")) { enteredBind(); await bindHeld; }
      if (query.includes("journal.transitionSelect") && !transitionGated) {
        transitionGated = true;
        enteredTransition();
        await transitionHeld;
      }
      return result;
    },
    transaction: (work) => inner.transaction(async () => work(sql)),
    close: () => inner.close(),
  };
  const journal = await PostgresExecutionJournal.create(sql, () => NOW);
  const f = await fixture(true, true, journal);
  const counts = { bind: 0, sign: 0, send: 0 };
  const adapter = realAdapter("valid", counts, () => sent());
  f.provider.onSubmit = (params) => adapter.submit({ ...params, bind: async (request) => {
    counts.bind += 1;
    return params.bind(request);
  } });
  const running = f.run();
  await bindEntered;
  let reconciled = false;
  const reconcile = journal.markUnknown(ID, "stale reconcile").then(() => { reconciled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reconciled, false);
  releaseBind();
  await transitionEntered;
  await sendDone;
  assert.deepEqual(counts, { bind: 1, sign: 1, send: 1 });
  assert.equal(reconciled, false);
  releaseTransition();
  await reconcile;
  assert.equal((await running).kind, "unknown");
  const row = await journal.get(ID);
  assert.equal(row?.state, "UNKNOWN");
  assert.ok(row?.preparedIntentIdentity);
  await journal.close();
});

it("R3.2 d1 reconcile abandons before the real adapter binder locks either journal store", async () => {
  for (const journal of [new MemoryExecutionJournal(() => NOW),
    await PostgresExecutionJournal.create(new FakeSqlClient(), () => NOW)] as ExecutionJournal[]) {
    const f = await fixture(true, true, journal);
    const counts = { bind: 0, sign: 0, send: 0 };
    const adapter = realAdapter("valid", counts);
    let enteredBind: () => void = () => {};
    let releaseBind: () => void = () => {};
    const binderEntered = new Promise<void>((resolve) => { enteredBind = resolve; });
    const binderHeld = new Promise<void>((resolve) => { releaseBind = resolve; });
    f.provider.onSubmit = (params) => adapter.submit({ ...params, bind: async (request) => {
      counts.bind += 1;
      enteredBind();
      await binderHeld;
      return params.bind(request);
    } });
    const running = f.run();
    await binderEntered;
    await journal.markUnknown(ID, "stale reconcile before bind");
    releaseBind();
    const result = await running;
    assert.equal(result.kind, "unknown");
    assert.deepEqual(counts, { bind: 1, sign: 0, send: 0 });
    const row = await journal.get(ID);
    assert.equal(row?.state, "UNKNOWN");
    assert.equal(row?.preparedIntentIdentity, null);
    await journal.close();
  }
});

it("R2.3 post-bind reconciliation to UNKNOWN is tolerated and retains identity", async () => {
  const f = await fixture();
  let submittedCalls: readonly WalletCall[] = [];
  f.provider.onSubmit = async (params) => {
    submittedCalls = params.calls;
    const base = new StagedProvider();
    await base.submitPreparedTrade(params);
    await f.journal.markUnknown(ID, "stale reconcile");
    return { status: "PENDING", callsId: CALLS_ID };
  };
  assert.equal((await f.run()).kind, "unknown");
  const row = await f.journal.get(ID);
  assert.equal(row?.state, "UNKNOWN");
  assert.ok(row?.preparedIntentIdentity);
  const encoded = encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{ eoa: WALLET,
    executionData: encodeLpFinalCallsV1(submittedCalls), nonce: 1n, payer: WALLET,
    paymentToken: getAddress("0x0000000000000000000000000000000000000000"), paymentMaxAmount: 0n,
    combinedGas: 0n, encodedPreCalls: [], encodedFundTransfers: [], settler: OWNER, expiry: 0n,
    isMultichain: false, funder: getAddress("0x0000000000000000000000000000000000000000"),
    funderSignature: "0x", settlerContext: "0x", paymentAmount: 0n, paymentRecipient: OWNER,
    signature: `0x${"11".repeat(65)}${"aa".repeat(32)}00` as Hex,
    paymentSignature: "0x", supportedAccountImplementation: OWNER }]);
  const blockHash = `0x${"bb".repeat(32)}` as Hex;
  const observed = { chainId: 56 as const,
    transaction: { hash: TX, to: PORTO_V055_ORCHESTRATOR,
      input: encodeFunctionData({ abi: parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4 err)"]),
        functionName: "execute", args: [encoded] }), blockNumber: 100n, blockHash, transactionIndex: 0n },
    receipt: { status: 1n, transactionHash: TX, blockNumber: 100n, blockHash, transactionIndex: 0n,
      logs: [{ address: PORTO_V055_ORCHESTRATOR,
        topics: [INTENT_EXECUTED_TOPIC, padHex(WALLET, { size: 32 }), toHex(1n, { size: 32 })],
        data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, "0x00000000"]), logIndex: 0n }] },
    receiptBlock: { number: 100n, hash: blockHash }, finalizedBlock: { number: 110n, hash: OTHER_TX } };
  const verdict = await assessTradeUnknown({ agent: f.agent, journal: row!, nowMs: NOW + 300_000,
    reads: { async finalizedBlock() { return { number: 110n, hash: OTHER_TX }; },
      async accountNonce() { return 2n; }, async blockAtOrBefore() { return 90n; },
      async intentExecutedTxHashes() { return [TX]; }, async readFinalized() { return observed; } } });
  assert.equal(verdict.kind, "landed");
  if (verdict.kind === "landed") await f.journal.advanceUnknown(ID, verdict.evidence, { txHash: verdict.txHash });
  assert.equal((await f.journal.get(ID))?.state, "COMMITTED");
});

it("E8/E9 absent capability and preflight refusal stop before staged submit", async () => {
  const unavailable = await fixture();
  const result = await unavailable.run(new FakeWalletProvider());
  assert.equal(result.kind, "rolled-back");
  if (result.kind === "rolled-back") assert.equal(result.code, "STAGED_SUBMIT_UNAVAILABLE");
  const refused = await fixture();
  refused.provider.preflightError = new Error("structural target refusal");
  assert.equal((await refused.run()).kind, "rolled-back");
  assert.equal(refused.provider.submissions, 0);
});

it("E3 genuine adapter-owned prepare error rolls back with the cause", async () => {
  const f = await fixture();
  const adapter = new PortoStagedLpAdapter({ network: BNB,
    transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
    functions: { prepare: (async () => { throw new Error("quote refused"); }) as typeof prepareCalls,
      sign: (async () => { throw new Error("must not sign"); }) as typeof signCalls,
      send: (async () => { throw new Error("must not send"); }) as typeof sendPreparedCalls } });
  f.provider.onSubmit = (params) => adapter.submit(params);
  const result = await f.run();
  assert.equal(result.kind, "rolled-back");
  if (result.kind === "rolled-back") {
    assert.equal(result.code, "RELAY_PREPARE_REFUSED");
    assert.equal(result.meta.deniedBy, "transport");
  }
  assert.match((await f.journal.get(ID))?.lastError ?? "", /^Refused before submission: RELAY_PREPARE_REFUSED\. quote refused/u);
});

it("E3 a quoted native fee deficit refuses before the binder", async () => {
  const f = await fixture();
  let signs = 0;
  const adapter = new PortoStagedLpAdapter({ network: BNB,
    transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
    functions: {
      prepare: (async (...[, request]: Parameters<typeof prepareCalls>) => ({
        capabilities: { quote: { quotes: [{ chainId: 56, orchestrator: PORTO_V055_ORCHESTRATOR,
          feeTokenDeficit: 1n, intent: { eoa: request.account,
            executionData: encodeLpFinalCallsV1((request.calls ?? []) as readonly WalletCall[]), nonce: 1n, expiry: 0n } }] } },
        context: {}, key: request.key, digest: TX, typedData: {},
      } as unknown as Awaited<ReturnType<typeof prepareCalls>>)) as typeof prepareCalls,
      sign: (async () => { signs += 1; throw new Error("must not sign"); }) as typeof signCalls,
      send: (async () => { throw new Error("must not send"); }) as typeof sendPreparedCalls,
    } });
  f.provider.onSubmit = (params) => adapter.submit(params);
  const result = await f.run();
  assert.equal(result.kind, "rolled-back");
  assert.equal(signs, 0);
  assert.equal((await f.journal.get(ID))?.preparedIntentIdentity, null);
  assert.match((await f.journal.get(ID))?.lastError ?? "", /fee token short by 1 wei/u);
});

it("E4 binder commit then lost reply leaves bound UNKNOWN without signing", async () => {
  const f = await fixture();
  f.provider.onSubmit = async (params) => {
    const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME, decoder: PORTO_V055_DECODER,
      chainId: "56", eoa: WALLET, orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: PORTO_V055_VERSION,
      nonce: "1", expiry: "0", executionDataHash: params.expectedExecutionDataHash, keyHash: TX });
    await params.bind({ journalIdempotencyKey: params.journalIdempotencyKey,
      canonicalIdentity: identity.canonical, identityHash: identity.hash,
      expectedBindingVersion: 0, preparedHandle: {}, preparedDigest: TX });
    throw new Error("binder reply lost");
  };
  assert.equal((await f.run()).kind, "unknown");
  const row = await f.journal.get(ID);
  assert.equal(row?.state, "UNKNOWN");
  assert.equal(row?.preparedIntentIdentityHash !== null, true);
});

it("E4 sign or send failure after bind remains UNKNOWN even with a refusal-sounding message", async () => {
  for (const stage of ["sign", "send"] as const) {
    const f = await fixture();
    f.provider.onSubmit = async (params) => {
      const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME, decoder: PORTO_V055_DECODER,
        chainId: "56", eoa: WALLET, orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: PORTO_V055_VERSION,
        nonce: "1", expiry: "0", executionDataHash: params.expectedExecutionDataHash, keyHash: TX });
      await params.bind({ journalIdempotencyKey: params.journalIdempotencyKey,
        canonicalIdentity: identity.canonical, identityHash: identity.hash,
        expectedBindingVersion: 0, preparedHandle: {}, preparedDigest: TX });
      throw new Error(`${stage}: quote has asset deficits and is expected to fail`);
    };
    assert.equal((await f.run()).kind, "unknown");
    assert.equal((await f.journal.get(ID))?.state, "UNKNOWN");
    assert.ok((await f.journal.get(ID))?.preparedIntentIdentity);
  }
});
