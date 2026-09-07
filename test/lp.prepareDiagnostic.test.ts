import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { BNB } from "@altananetwork/sdk";
import { custom, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareCalls } from "porto/viem/RelayActions";
import * as PortoKey from "porto/viem/Key";
import { validateSessionSpec } from "../src/core/session.js";
import { fingerprintLpFinalCallsV1 } from "../src/lp/preparedIntent.js";
import { canonicalProviderPermissionsV1, fingerprintLpFinalCallsV1 as witnessFingerprint } from "../src/lp/preparedIntentWitness.js";
import { admitLpPrepare } from "../src/lp/prepareAdmission.js";
import { forbiddenTokenAddresses } from "../src/ops/forbiddenTokens.js";
import { lpPrepareDiagnosticRevocation } from "../src/store/lpPrepareDiagnosticRead.js";
import { runLpPrepareDiagnosticBootstrap } from "../src/lp/prepareDiagnosticBootstrap.js";
import {
  PortoPrepareDiagnosticAdapter,
  lpPrepareDiagnosticAdmissionRefusal,
  lpPrepareDiagnosticBootstrapOutcome,
  printableLpPrepareDiagnosticOutcome,
} from "../src/lp/prepareDiagnostic.js";

const SESSION_KEY = `0x${"00".repeat(31)}01` as Hex;
const WALLET = `0x${"34".repeat(20)}` as Address;
const TARGET = `0x${"56".repeat(20)}` as Address;
const EXPIRY = Math.floor(Date.now() / 1_000) + 3_600;
const SPEC = { allowedCalls: [{ to: TARGET }],
  spendCaps: [{ limit: 1n, period: "hour" as const }], expiresAt: EXPIRY };
const PERMISSIONS = validateSessionSpec(SPEC, { minSessionSeconds: 0 });
const CALLS = [{ to: TARGET, value: 0n, data: "0x" as Hex }] as const;
const FINGERPRINT = fingerprintLpFinalCallsV1(CALLS);
const ACCOUNT = privateKeyToAccount(SESSION_KEY);

function base() {
  return {
    sessionPrivateKey: SESSION_KEY,
    walletAddress: WALLET,
    persistedSession: { spec: SPEC, permissions: PERMISSIONS, publicKey: ACCOUNT.publicKey, expiry: EXPIRY },
    restoredSessionPublicKey: ACCOUNT.publicKey,
    restoredSessionExpiry: EXPIRY,
    calls: CALLS,
    expectedExecutionDataHash: FINGERPRINT.value.executionDataHash,
  } as const;
}

function adapter(prepare: typeof prepareCalls): PortoPrepareDiagnosticAdapter {
  return new PortoPrepareDiagnosticAdapter({ network: BNB,
    transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }), prepare,
    prepareTimeoutMs: 20 });
}

describe("LP prepare-only diagnostic", () => {
  it("refuses malformed proof data and the forbidden proof+ciphertext pair", () => {
    assert.throws(() => lpPrepareDiagnosticRevocation({ verdict: "invalid" }, false),
      /revocation proof is malformed/u);
    const proof = {
      version: 1 as const,
      chainId: 56,
      keyStoreAddress: WALLET,
      walletAddress: WALLET,
      keyId: `0x${"31".repeat(32)}` as Hex,
      sessionPublicKey: ACCOUNT.publicKey,
      verdict: "invalid" as const,
      blockNumber: "101",
      blockHash: `0x${"32".repeat(32)}` as Hex,
      observedAtMs: Date.now(),
    };
    assert.throws(() => lpPrepareDiagnosticRevocation(proof, true),
      /revocation proof and session key coexist/u);
    assert.deepEqual(lpPrepareDiagnosticRevocation(proof, false), proof);
  });

  it("keeps the diagnostic module graph off the staged submit capability", async () => {
    const source = await readFile(new URL("../src/lp/prepareDiagnostic.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*preparedIntent\.js/);
    assert.doesNotMatch(source, /sendPreparedCalls|signCalls|executeViaSession|PreparedIntentBinder/);
  });

  it("routes the live-lp subcommand through the isolated read-only entry", async () => {
    const source = await readFile(new URL("../scripts/live-lp-prepare-diagnostic.ts", import.meta.url), "utf8");
    const entry = await readFile(new URL("../scripts/live-lp-entry.ts", import.meta.url), "utf8");
    assert.match(entry, /prepare-diagnostic/);
    assert.doesNotMatch(source, /live-lp\.ts|server\.js|wallet\/altana|preparedIntent|executeViaSession|sendPreparedCalls|signCalls|writeEnvValue|sessionKeyFor|createAgentStore/);
    assert.match(source, /lpPrepareDiagnosticBootstrapOutcome\(bootstrapFamily\)/);
    assert.match(source, /bootstrapFamily = "read-session"/);
    assert.match(source, /bootstrapFamily = "read-only-infrastructure"/);
  });

  it("contains the descriptor failure before prepare and rejects forged printable results", async () => {
    let prepares = 0;
    const result = await adapter((async () => { prepares += 1; throw new Error("unexpected"); }) as typeof prepareCalls)
      .prepare({ ...base(), restoredSessionExpiry: EXPIRY + 1 });
    assert.equal(prepares, 0, "a bad descriptor must not contact prepare");
    assert.deepEqual(printableLpPrepareDiagnosticOutcome(result), {
      stage: "descriptor", reason: "session-descriptor-invalid",
    });
    assert.throws(() => printableLpPrepareDiagnosticOutcome({
      stage: "descriptor", reason: "session-descriptor-invalid",
    }));
  });

  it("renders pre-prepare admission refusal as closed telemetry", () => {
    assert.deepEqual(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticAdmissionRefusal()), {
      stage: "descriptor", reason: "admission-refused",
    });
  });

  it("renders bootstrap failure families without raw bootstrap details", () => {
    assert.deepEqual(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticBootstrapOutcome("config")),
      { stage: "descriptor", reason: "bootstrap-config-invalid" });
    assert.deepEqual(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticBootstrapOutcome("read-session")),
      { stage: "descriptor", reason: "bootstrap-read-session-failed" });
    assert.deepEqual(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticBootstrapOutcome("read-only-infrastructure")),
      { stage: "descriptor", reason: "bootstrap-read-only-infrastructure-failed" });
  });

  it("orchestrates hostile bootstrap errors to exact closed stdout with zero prepare", async () => {
    for (const failed of ["config", "readSession", "infrastructure"] as const) {
      const stdout: string[] = []; let prepares = 0;
      await runLpPrepareDiagnosticBootstrap({
        config: async () => { if (failed === "config") throw new Error("https://secret.example/key"); },
        readSession: async () => { if (failed === "readSession") throw new Error("private key"); },
        infrastructure: async () => { if (failed === "infrastructure") throw new Error("raw response"); },
        prepare: async () => { prepares += 1; }, write: (line) => stdout.push(line),
      });
      assert.equal(prepares, 0); assert.equal(stdout.length, 1);
      assert.match(stdout[0]!, /^\{"stage":"descriptor","reason":"bootstrap-/);
      assert.doesNotMatch(stdout[0]!, /secret|key|response/);
    }
  });

  it("has only prepare capability and never signs, sends, binds, or writes", async () => {
    const order: string[] = [];
    const prepared = {
      capabilities: { quote: { quotes: [{ chainId: 56,
        orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
        intent: { eoa: WALLET, executionData: "0x", nonce: 1n, expiry: BigInt(EXPIRY) },
      }] } },
      context: {}, digest: `0x${"11".repeat(32)}` as Hex,
      key: PortoKey.fromSecp256k1({ privateKey: SESSION_KEY, role: "session", expiry: EXPIRY,
        permissions: PERMISSIONS }), typedData: {},
    };
    const result = await adapter((async () => {
      order.push("prepare");
      return prepared as unknown as Awaited<ReturnType<typeof prepareCalls>>;
    }) as typeof prepareCalls).prepare(base());
    assert.deepEqual(order, ["prepare"]);
    assert.deepEqual(printableLpPrepareDiagnosticOutcome(result), {
      stage: "prepared-response", reason: "quote-invalid",
    });
  });

  it("classifies a bounded prepare timeout without exposing relay details", async () => {
    const result = await adapter((async () => await new Promise<never>(() => undefined)) as typeof prepareCalls)
      .prepare(base());
    assert.deepEqual(printableLpPrepareDiagnosticOutcome(result), {
      stage: "prepare", reason: "relay-prepare-timeout",
    });
  });

  it("contains hostile relay response shapes inside the closed printable outcome", async () => {
    for (const response of [null, 7, { capabilities: { quote: { quotes: [{ chainId: 56,
      orchestrator: { toLowerCase: () => { throw new Error("hostile getter"); } } }] } } }]) {
      const result = await adapter((async () => response as unknown as Awaited<ReturnType<typeof prepareCalls>>) as typeof prepareCalls)
        .prepare(base());
      assert.deepEqual(printableLpPrepareDiagnosticOutcome(result), {
        stage: "prepared-response", reason: "quote-invalid",
      });
    }
  });

  it("shares staged witnesses across reordered permissions and nontrivial calls", () => {
    const calls = [...CALLS, { to: WALLET, value: 4n, data: "0x1234" as Hex }];
    assert.deepEqual(witnessFingerprint(calls), fingerprintLpFinalCallsV1(calls));
    assert.equal(canonicalProviderPermissionsV1(PERMISSIONS), canonicalProviderPermissionsV1({
      spend: PERMISSIONS.spend, calls: PERMISSIONS.calls,
    }));
  });

  it("admits a persisted grant or the read-only chain fallback, then preflights exact calls", async () => {
    const calls = [...CALLS, { to: WALLET, value: 0n, data: "0x" as Hex }];
    const agent = { id: "diagnostic", ownerAddress: WALLET, walletAddress: WALLET, custodyModel: "self-eoa" as const,
      sessionFacts: { spec: SPEC, permissions: PERMISSIONS, publicKey: ACCOUNT.publicKey, expiry: EXPIRY }, sessionRevocation: null, caps: null,
      status: "armed" as const, httpRuntimeProfile: "lp-v1" as const, erc8004AgentId: null, pendingGrant: null, rowVersion: 1, createdAt: 0, updatedAt: 0 };
    const seen: readonly unknown[] = [];
    const run = async (chainAllows: boolean, forbidden = false): Promise<void> => {
      await admitLpPrepare({ agent, token0: TARGET, token1: WALLET, fee: 500, calls, wbnb: WALLET,
        forbiddenTokenAddresses: forbidden ? new Set([TARGET.toLowerCase()]) : new Set(),
        rails: { maxPriceImpactBps: 100, maxSpotTwapDeviationBps: 100, minObservationCardinality: 2,
          minPoolLiquidity: 1n, twapWindowSeconds: 60, maxSagaSlippageBps: 100 },
        canSessionSellToken: async () => chainAllows,
        getPool: async () => WALLET,
        poolState: async () => ({ currentTick: 1, tickSpacing: 10, evidence: { blockNumber: 1n,
          finalizedBlockNumber: 1n, observationCardinality: 2, poolLiquidity: 1n, priceImpactBps: 0n,
          spotSqrtPriceX96: 1n, twapSqrtPriceX96: 1n } }),
        preflightExecute: async (exact) => { (seen as unknown[]).push(exact); },
      });
    };
    await run(true);
    assert.equal(seen[0], calls, "preflight receives the exact execution-derived calls");
    await assert.rejects(run(false, true));
    await assert.rejects(admitLpPrepare({ agent: { ...agent, sessionFacts: { ...agent.sessionFacts,
      spec: { ...SPEC, allowedCalls: [], spendCaps: [], expiresAt: EXPIRY } } }, token0: TARGET, token1: WALLET,
      fee: 500, calls, wbnb: WALLET, forbiddenTokenAddresses: new Set(), rails: { maxPriceImpactBps: 100,
      maxSpotTwapDeviationBps: 100, minObservationCardinality: 2, minPoolLiquidity: 1n, twapWindowSeconds: 60,
      maxSagaSlippageBps: 100 }, canSessionSellToken: async () => false, getPool: async () => WALLET,
      poolState: async () => ({ currentTick: 1, tickSpacing: 10, evidence: { blockNumber: 1n, finalizedBlockNumber: 1n,
        observationCardinality: 2, poolLiquidity: 1n, priceImpactBps: 0n, spotSqrtPriceX96: 1n, twapSqrtPriceX96: 1n } }),
      preflightExecute: async () => { throw new Error("must not preflight after leg refusal"); } }));
  });

  it("forbids every non-token LP role before any chain admission read", async () => {
    const roles = [WALLET, TARGET, `0x${"57".repeat(20)}` as Address, `0x${"58".repeat(20)}` as Address,
      `0x${"59".repeat(20)}` as Address, `0x${"5a".repeat(20)}` as Address, `0x${"5b".repeat(20)}` as Address,
      `0x${"5c".repeat(20)}` as Address, `0x${"5d".repeat(20)}` as Address];
    const forbidden = new Set([...forbiddenTokenAddresses({ wallet: roles[0]!, keyStore: roles[1]!, treasury: roles[8]!,
      venues: { chainId: 56, wbnb: roles[2]!, pancakeRouterV2: roles[3]!, pancakeRouterV3: roles[4]!,
        fourMemeTokenManager: roles[6]!, flapPortal: roles[7]! } }), roles[5]!.toLowerCase()]);
    for (const role of [...roles, `0x${"00".repeat(20)}` as Address]) {
      assert.equal(forbidden.has(role.toLowerCase()), true);
    }
  });

  it("every forbidden category stops before pool, planner-derived preflight, or prepare", async () => {
    const roles = [WALLET, TARGET, `0x${"57".repeat(20)}` as Address, `0x${"58".repeat(20)}` as Address,
      `0x${"59".repeat(20)}` as Address, `0x${"5a".repeat(20)}` as Address, `0x${"5b".repeat(20)}` as Address,
      `0x${"5c".repeat(20)}` as Address, `0x${"5d".repeat(20)}` as Address, `0x${"00".repeat(20)}` as Address];
    const blocked = new Set([...forbiddenTokenAddresses({ wallet: roles[0]!, keyStore: roles[1]!, treasury: roles[8]!,
      venues: { chainId: 56, wbnb: roles[2]!, pancakeRouterV2: roles[3]!, pancakeRouterV3: roles[4]!,
        fourMemeTokenManager: roles[6]!, flapPortal: roles[7]! } }), roles[5]!.toLowerCase()]);
    const agent = { id: "blocked", ownerAddress: WALLET, walletAddress: WALLET, custodyModel: "self-eoa" as const,
      sessionFacts: { spec: SPEC, permissions: PERMISSIONS, publicKey: ACCOUNT.publicKey, expiry: EXPIRY }, sessionRevocation: null, caps: null,
      status: "armed" as const, httpRuntimeProfile: "lp-v1" as const, erc8004AgentId: null, pendingGrant: null, rowVersion: 1, createdAt: 0, updatedAt: 0 };
    for (const token0 of roles) {
      let downstream = 0;
      await assert.rejects(admitLpPrepare({ agent, token0, token1: WALLET, fee: 500, calls: CALLS, wbnb: WALLET,
        forbiddenTokenAddresses: blocked, rails: { maxPriceImpactBps: 100, maxSpotTwapDeviationBps: 100,
          minObservationCardinality: 2, minPoolLiquidity: 1n, twapWindowSeconds: 60, maxSagaSlippageBps: 100 },
        canSessionSellToken: async () => { downstream += 1; return true; },
        getPool: async () => { downstream += 1; return WALLET; },
        poolState: async () => { downstream += 1; throw new Error("must not read"); },
        preflightExecute: async () => { downstream += 1; },
      }));
      assert.equal(downstream, 0, token0);
    }
  });

  it("uses one admitted snapshot for the plan boundary; no later state can reach prepare", async () => {
    let stateReads = 0;
    const agent = { id: "snapshot", ownerAddress: WALLET, walletAddress: WALLET, custodyModel: "self-eoa" as const,
      sessionFacts: { spec: SPEC, permissions: PERMISSIONS, publicKey: ACCOUNT.publicKey, expiry: EXPIRY }, sessionRevocation: null, caps: null,
      status: "armed" as const, httpRuntimeProfile: "lp-v1" as const, erc8004AgentId: null, pendingGrant: null, rowVersion: 1, createdAt: 0, updatedAt: 0 };
    await admitLpPrepare({ agent, token0: TARGET, token1: WALLET, fee: 500, calls: CALLS, wbnb: WALLET,
      forbiddenTokenAddresses: new Set(), rails: { maxPriceImpactBps: 100, maxSpotTwapDeviationBps: 100,
        minObservationCardinality: 2, minPoolLiquidity: 1n, twapWindowSeconds: 60, maxSagaSlippageBps: 100 },
      canSessionSellToken: async () => true, getPool: async () => WALLET,
      poolState: async () => { stateReads += 1; if (stateReads > 1) throw new Error("changed snapshot"); return {
        currentTick: 1, tickSpacing: 10, evidence: { blockNumber: 1n, finalizedBlockNumber: 1n,
          observationCardinality: 2, poolLiquidity: 1n, priceImpactBps: 0n, spotSqrtPriceX96: 1n, twapSqrtPriceX96: 1n } }; },
      preflightExecute: async () => {},
    });
    assert.equal(stateReads, 1);
  });
});
