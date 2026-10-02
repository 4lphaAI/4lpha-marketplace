import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { BNB } from "@altananetwork/sdk";
import { concatHex, custom, encodeAbiParameters, getAddress, hashTypedData, keccak256,
  parseAbiParameters, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { prepareCalls, sendPreparedCalls, signCalls } from "porto/viem/RelayActions";
import { validateSessionSpec } from "../src/core/session.js";
import { buildTradfiPancakeV2Swap, buildTradfiPlatformFee } from "../src/ops/tradfi.js";
import { PANCAKE_V2_ROUTER_56 } from "../src/ops/venues.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { WalletCall } from "../src/core/types.js";
import { assertPreparedSignedPayloadV1, encodeLpFinalCallsV1, fingerprintLpFinalCallsV1,
  isProvenPreBindStagedLpError, PORTO_NATIVE_FEE_TOKEN, PORTO_V055_CALL_TYPE,
  PORTO_V055_DOMAIN_TYPE, PORTO_V055_INTENT_TYPE, PORTO_V055_ORCHESTRATOR,
  PortoStagedLpAdapter } from "../src/lp/preparedIntent.js";

const PRIVATE = `0x${"00".repeat(31)}01` as Hex;
const WALLET = getAddress("0x3434343434343434343434343434343434343434");
const TARGET = getAddress("0x5656565656565656565656565656565656565656");
const ZERO = PORTO_NATIVE_FEE_TOKEN;
const EXPIRY = Math.floor(Date.now() / 1_000) + 3_600;
const SPEC = { allowedCalls: [{ to: TARGET }], spendCaps: [{ limit: 10n ** 18n, period: "day" as const }], expiresAt: EXPIRY };
const PERMISSIONS = validateSessionSpec(SPEC, { minSessionSeconds: 0 });
const CALLS: readonly WalletCall[] = [{ to: TARGET, data: "0x1234" }, { to: TARGET }];
const ACCOUNT = privateKeyToAccount(PRIVATE);
const HASH = (value: string): Hex => keccak256(toHex(value));
const EMPTY_HASH = keccak256("0x");

function quote(calls: readonly WalletCall[]) {
  return { eoa: WALLET, executionData: encodeLpFinalCallsV1(calls), nonce: 7n, payer: WALLET,
    paymentToken: ZERO, paymentMaxAmount: 10n, combinedGas: 300_000n, encodedPreCalls: [] as Hex[],
    encodedFundTransfers: [] as Hex[], settler: ZERO, expiry: 0n, isMultichain: false,
    funder: ZERO, funderSignature: "0x" as Hex };
}

function manualDigest(calls: readonly WalletCall[], intent = quote(calls)): Hex {
  const callHashes = calls.map((call) => keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,address,uint256,bytes32"),
    [HASH(PORTO_V055_CALL_TYPE), getAddress(call.to), call.value ?? 0n, keccak256(call.data ?? "0x")],
  )));
  const arrayHash = keccak256(concatHex(callHashes));
  const intentHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,bool,address,bytes32,uint256,address,address,uint256,uint256,bytes32,bytes32,address,uint256"),
    [HASH(PORTO_V055_INTENT_TYPE), false, intent.eoa, arrayHash, intent.nonce, intent.payer,
      intent.paymentToken, intent.paymentMaxAmount, intent.combinedGas, EMPTY_HASH, EMPTY_HASH,
      intent.settler, intent.expiry],
  ));
  const domain = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes32,uint256,address"),
    [HASH(PORTO_V055_DOMAIN_TYPE), HASH("Orchestrator"), HASH("0.5.5"), 56n, PORTO_V055_ORCHESTRATOR]));
  return keccak256(concatHex(["0x1901", domain, intentHash]));
}

it("R3.1 pins all three type hashes in the packaged orchestrator and manual digest", () => {
  const code = readFileSync(new URL("../node_modules/porto/dist/core/internal/_generated/contracts/Orchestrator.js", import.meta.url), "utf8").toLowerCase();
  for (const type of [PORTO_V055_INTENT_TYPE, PORTO_V055_CALL_TYPE, PORTO_V055_DOMAIN_TYPE]) {
    assert.ok(code.includes(HASH(type).slice(2)), type);
  }
  const intent = quote(CALLS);
  const viem = hashTypedData({ domain: { name: "Orchestrator", version: "0.5.5", chainId: 56,
    verifyingContract: PORTO_V055_ORCHESTRATOR },
    types: { Intent: [
      { name: "multichain", type: "bool" }, { name: "eoa", type: "address" }, { name: "calls", type: "Call[]" },
      { name: "nonce", type: "uint256" }, { name: "payer", type: "address" }, { name: "paymentToken", type: "address" },
      { name: "paymentMaxAmount", type: "uint256" }, { name: "combinedGas", type: "uint256" },
      { name: "encodedPreCalls", type: "bytes[]" }, { name: "encodedFundTransfers", type: "bytes[]" },
      { name: "settler", type: "address" }, { name: "expiry", type: "uint256" },
    ], Call: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] },
    primaryType: "Intent", message: { multichain: false, eoa: intent.eoa,
      calls: CALLS.map((call) => ({ to: call.to, value: call.value ?? 0n, data: call.data ?? "0x" })),
      nonce: intent.nonce, payer: intent.payer, paymentToken: intent.paymentToken,
      paymentMaxAmount: intent.paymentMaxAmount, combinedGas: intent.combinedGas,
      encodedPreCalls: [], encodedFundTransfers: [], settler: intent.settler, expiry: intent.expiry } });
  assert.equal(viem, manualDigest(CALLS, intent));
});

it("R4.2 normalizes omitted value and data on the real builder call shape", () => {
  const built = [...buildTradfiPancakeV2Swap({ router: PANCAKE_V2_ROUTER_56, tokenIn: USDT_56,
    tokenOut: TARGET, amountInWei: 100n, minOutWei: 1n, recipient: WALLET, deadline: 1_000n,
    route: { hops: [], fees: [] } }),
    ...buildTradfiPlatformFee({ usdt: USDT_56, treasury: TARGET, amountWei: 1n })];
  assert.equal(built.length, 3);
  assert.ok(built.every((call) => call.value === undefined));
  assert.doesNotThrow(() => assertPreparedSignedPayloadV1({ digest: manualDigest(built), quoteIntent: quote(built), calls: built }));
  const omittedData: readonly WalletCall[] = [{ to: TARGET }];
  assert.doesNotThrow(() => assertPreparedSignedPayloadV1({ digest: manualDigest(omittedData),
    quoteIntent: quote(omittedData), calls: omittedData }));
});

type Override = (value: ReturnType<typeof quote>) => unknown;
async function submit(input: { readonly alter?: Override; readonly digest?: Hex; readonly preCall?: true; readonly deficit?: true;
  readonly trade?: true; readonly binderReplyLost?: true } = {}) {
  const counts = { bind: 0, sign: 0, send: 0 };
  const state = { bound: false };
  const preparedIntent = input.alter?.(quote(CALLS)) ?? quote(CALLS);
  const adapter = new PortoStagedLpAdapter({ network: BNB,
    transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
    functions: {
      prepare: (async (...[, request]: Parameters<typeof prepareCalls>) => ({
        capabilities: { quote: { quotes: [{ chainId: 56, orchestrator: PORTO_V055_ORCHESTRATOR,
          intent: preparedIntent, ...(input.deficit ? { feeTokenDeficit: 1n } : {}) }] } },
        context: input.preCall ? { preCall: {} } : {}, key: request.key,
        digest: input.digest ?? manualDigest(CALLS), typedData: {},
      } as unknown as Awaited<ReturnType<typeof prepareCalls>>)) as typeof prepareCalls,
      sign: (async () => { assert.equal(counts.bind, 1, "durable bind precedes signing"); counts.sign += 1; return `0x${"22".repeat(65)}` as Hex; }) as typeof signCalls,
      send: (async () => { counts.send += 1; return { id: `0x${"23".repeat(32)}` as Hex }; }) as typeof sendPreparedCalls,
    }, submitTimeoutMs: 1_000 });
  const work = adapter.submit({ journalIdempotencyKey: "k", expectedBindingVersion: 0,
    sessionPrivateKey: PRIVATE, walletAddress: WALLET,
    persistedSession: { spec: SPEC, permissions: PERMISSIONS, publicKey: ACCOUNT.publicKey, expiry: EXPIRY },
    restoredSessionPublicKey: ACCOUNT.publicKey, restoredSessionExpiry: EXPIRY,
    calls: CALLS, expectedExecutionDataHash: fingerprintLpFinalCallsV1(CALLS).value.executionDataHash,
    ...(input.trade ? { requireSignedPayloadBinding: true as const } : {}),
    bind: async (request) => { counts.bind += 1; state.bound = true;
      if (input.binderReplyLost) throw new Error("binder reply lost after commit");
      return { ...request, boundBindingVersion: 1 }; } });
  return { work, counts, state };
}

it("trade binds exactly once before sign and send; LP keeps its old digest rule", async () => {
  const trade = await submit({ trade: true });
  assert.equal((await trade.work).status, "PENDING");
  assert.deepEqual(trade.counts, { bind: 1, sign: 1, send: 1 });
  const lp = await submit({ digest: `0x${"44".repeat(32)}` as Hex });
  assert.equal((await lp.work).status, "PENDING");
});

it("R4.3 a binder commit with a lost reply never reaches sign or send", async () => {
  const lost = await submit({ trade: true, binderReplyLost: true });
  await assert.rejects(lost.work, (error: unknown) => !isProvenPreBindStagedLpError(error));
  assert.equal(lost.state.bound, true);
  assert.deepEqual(lost.counts, { bind: 1, sign: 0, send: 0 });
});

for (const [name, input] of [
  ["digest substitution", { digest: `0x${"44".repeat(32)}` as Hex }],
  ["nonce substitution", { alter: (value: ReturnType<typeof quote>) => ({ ...value, nonce: 8n }) }],
  ["multichain", { alter: (value: ReturnType<typeof quote>) => ({ ...value, isMultichain: true }) }],
  ["multichain prefix", { alter: (value: ReturnType<typeof quote>) => ({ ...value, nonce: 0xc1d0n << 240n }) }],
  ["pre-call extension", { alter: (value: ReturnType<typeof quote>) => ({ ...value, encodedPreCalls: ["0x12"] }) }],
  ["fund transfer", { alter: (value: ReturnType<typeof quote>) => ({ ...value, encodedFundTransfers: ["0x12"] }) }],
  ["funder", { alter: (value: ReturnType<typeof quote>) => ({ ...value, funder: TARGET }) }],
  ["funder signature", { alter: (value: ReturnType<typeof quote>) => ({ ...value, funderSignature: "0x12" }) }],
  ["preCall context", { preCall: true }],
  ["missing paymentMaxAmount", { alter: (value: ReturnType<typeof quote>) => { const { paymentMaxAmount: _missing, ...rest } = value; return rest; } }],
  ["quote deficit", { deficit: true }],
] as const) {
  it(`trade refuses ${name} before bind, sign and send`, async () => {
    const result = await submit({ ...input, trade: true });
    await assert.rejects(result.work, isProvenPreBindStagedLpError);
    assert.deepEqual(result.counts, { bind: 0, sign: 0, send: 0 });
  });
}
