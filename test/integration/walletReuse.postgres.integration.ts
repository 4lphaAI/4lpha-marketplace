/**
 * Real-PostgreSQL wallet-fence proof for Grid -> finalized revoke -> Trading.
 * This starts only a temporary local PostgreSQL process. It never touches a
 * configured database, wallet, chain, environment file, or external service.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, keccak256, type Hex } from "viem";
import type { KeyStoreReader } from "../../src/account/keyStoreReader.js";
import { validateSessionSpec } from "../../src/core/session.js";
import type { GrantEvidenceReader } from "../../src/wallet/grantEvidence.js";
import {
  AgentWalletInUseError,
  PostgresAgentStore,
  agentSessionIntegrity,
  type SessionFacts,
} from "../../src/store/agents.js";
import { parseMasterKey } from "../../src/store/crypto.js";
import { encodeJsonbParam } from "../../src/store/codec.js";
import { provisioningView } from "../../src/http/wire.js";
import { CANCEL_ACTION, DRAFT_KEY, cancelDraft, pendingDraft } from "../support/provisioningDraft.js";
import { MemoryExecutionJournal } from "../../src/store/journal.js";
import { MemoryTradeIntentStore } from "../../src/store/tradeIntents.js";
import { MemoryTradePositionStore } from "../../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../../src/store/tradeSettings.js";
import { createPgSqlClient, type SqlClient } from "../../src/store/sql.js";
import type { TradeDataPlaneReads, UniverseLane, UniverseRow } from "../../src/trade/dataPlaneReads.js";
import type { TradeReadiness } from "../../src/trade/readiness.js";
import { DEFAULT_TRADE_SETTINGS } from "../../src/trade/settings.js";
import {
  EXEC_TOKEN,
  NOW_SEC,
  call,
  createHarness,
  ownerAccount,
  signOwnerAction,
  tradeConfig,
} from "../support/serverHarness.js";

const NOW_MS = Date.now();
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEYSTORE = getAddress("0x3333333333333333333333333333333333333333");
const TARGET = getAddress("0x4444444444444444444444444444444444444444");
const PRIVATE_KEY = `0x${"51".repeat(32)}` as Hex;
const PUBLIC_KEY = `0x04${"61".repeat(64)}` as Hex;
const MASTER_KEY = parseMasterKey(`0x${"71".repeat(32)}`);
const REVOCATION_CONTEXT = { chainId: 56, keyStoreAddress: KEYSTORE } as const;
const ROUTE_WALLETS = [
  getAddress("0x5222222222222222222222222222222222222222"),
  getAddress("0x6222222222222222222222222222222222222222"),
  getAddress("0x7222222222222222222222222222222222222222"),
] as const;
const ROUTE_PUBLIC_KEY = `0x04${"91".repeat(64)}` as Hex;
const ROUTE_VALID_PUBLIC_KEY = `0x04${"92".repeat(64)}` as Hex;
const ROUTE_FINALIZED_HASH = `0x${"93".repeat(32)}` as Hex;
const ROUTE_ROUTER_V2 = getAddress("0x5000000000000000000000000000000000000005");
const ROUTE_ROUTER_V3 = getAddress("0x5100000000000000000000000000000000000005");
const ROUTE_WBNB = getAddress("0x6000000000000000000000000000000000000006");
const ROUTE_NFPM = getAddress("0x4000000000000000000000000000000000000004");
const ROUTE_TREASURY = getAddress("0x7000000000000000000000000000000000000007");
const ROUTE_TOKENS = Array.from({ length: 6 }, (_, index) =>
  getAddress(`0x${(index + 201).toString(16).padStart(40, "0")}`));
const ROUTE_CAP = 30_000_000_000_000_000n;

function command(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${executable} exited ${code}: ${stderr}`)));
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

async function waitReady(executable: string, port: number, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`PostgreSQL exited ${process.exitCode} before ready.`);
    try {
      await command(executable, ["-h", "127.0.0.1", "-p", String(port)]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("PostgreSQL did not become ready.");
}

function facts(): SessionFacts {
  const spec = {
    allowedCalls: [{ to: TARGET }],
    spendCaps: [{ limit: 10n, period: "day" as const }],
    expiresAt: Math.floor(NOW_MS / 1_000) + 3_600,
  };
  return { spec, permissions: validateSessionSpec(spec), publicKey: PUBLIC_KEY, expiry: spec.expiresAt };
}

function routeFacts(publicKey: Hex): SessionFacts {
  const spec = {
    allowedCalls: [{ to: TARGET }],
    spendCaps: [{ limit: ROUTE_CAP, period: "day" as const }],
    expiresAt: NOW_SEC + 3_600,
  };
  return { spec, permissions: validateSessionSpec(spec, { nowSeconds: NOW_SEC }), publicKey, expiry: spec.expiresAt,
    hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "0" } };
}

function routeUniverse(lane: UniverseLane): readonly UniverseRow[] {
  return ROUTE_TOKENS.map((address, index) => ({ address, symbol: `R${index}`, lane, source: "test",
    ...(lane === "bstocks" ? { marketHours: "us-equities" as const } : {}) }));
}

function routeHireParams(walletAddress: typeof ROUTE_WALLETS[number], run: string) {
  return { walletAddress, capDayWei: ROUTE_CAP.toString(10), ttlSec: 3_600,
    sizingPreset: "trade-v1", executionModel: "sigma", hireRunId: run, autoGrant: true,
    settings: DEFAULT_TRADE_SETTINGS };
}

function pauseConfirmation(inner: SqlClient, tag = "/* agents.confirmRevocation */") {
  let release = (): void => {};
  let reached = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atUpdate = new Promise<void>((resolve) => { reached = resolve; });
  const wrap = (client: SqlClient): SqlClient => ({
    async query<Row>(text: string, params?: readonly unknown[], options?: Parameters<SqlClient["query"]>[2]) {
      if (text.includes(tag)) {
        reached();
        await gate;
      }
      return client.query<Row>(text, params, options);
    },
    transaction: <T>(fn: (tx: SqlClient) => Promise<T>) => client.transaction((tx) => fn(wrap(tx))),
    close: () => client.close(),
  });
  return { client: wrap(inner), atUpdate, release };
}

test("wallet reuse: proof, key deletion, replacement hire, and key writer share one real Postgres fence", {
  timeout: 120_000,
}, async (t) => {
  const postgresBin = process.env["PHASE5_POSTGRES_BIN"]
    ?? "C:\\Program Files\\PostgreSQL\\17\\bin";
  const initdb = join(postgresBin, process.platform === "win32" ? "initdb.exe" : "initdb");
  const postgres = join(postgresBin, process.platform === "win32" ? "postgres.exe" : "postgres");
  const pgCtl = join(postgresBin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  const pgIsReady = join(postgresBin, process.platform === "win32" ? "pg_isready.exe" : "pg_isready");
  try {
    await Promise.all([access(initdb), access(postgres), access(pgCtl), access(pgIsReady)]);
  } catch {
    t.skip(`PostgreSQL binaries are unavailable at ${postgresBin}`);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "4lpha-wallet-reuse-pg-"));
  const data = join(root, "data");
  const port = await freePort();
  let postgresProcess: ChildProcess | undefined;
  let postmasterPid: string | undefined;
  let releaseGate = (): void => {};
  const stores: PostgresAgentStore[] = [];
  try {
    await command(initdb, ["-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale",
      "--username=wallet_reuse_audit"]);
    postgresProcess = spawn(postgres, ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    await waitReady(pgIsReady, port, postgresProcess);
    postmasterPid = (await readFile(join(data, "postmaster.pid"), "utf8")).split(/\r?\n/u, 1)[0]?.trim();

    const url = `postgresql://wallet_reuse_audit@127.0.0.1:${port}/postgres`;
    const seed = await PostgresAgentStore.create(
      await createPgSqlClient(url), MASTER_KEY, () => NOW_MS, REVOCATION_CONTEXT,
    );
    stores.push(seed);
    const created = await seed.createAgent({ id: "grid-old", ownerAddress: OWNER, walletAddress: WALLET,
      custodyModel: "passkey", sessionFacts: facts(), status: "armed" });
    await seed.putAgentSessionKey(OWNER, created.id, PRIVATE_KEY);
    const withKey = await seed.getAgent(OWNER, created.id);
    const revoked = await seed.transitionAgentStatus({ ownerAddress: OWNER, agentId: created.id,
      expectedStatus: "armed", expectedRowVersion: withKey!.rowVersion, status: "revoked" });
    assert.notEqual(revoked, null);

    const paused = pauseConfirmation(await createPgSqlClient(url));
    releaseGate = paused.release;
    const confirmer = await PostgresAgentStore.create(
      paused.client, MASTER_KEY, () => NOW_MS, REVOCATION_CONTEXT,
    );
    const contender = await PostgresAgentStore.create(
      await createPgSqlClient(url), MASTER_KEY, () => NOW_MS, REVOCATION_CONTEXT,
    );
    stores.push(confirmer, contender);
    await assert.rejects(contender.createAgent({ id: "trade-too-early", ownerAddress: OWNER,
      walletAddress: WALLET, custodyModel: "passkey", status: "provisioning" }), AgentWalletInUseError);

    const proof = {
      version: 1 as const, chainId: 56, keyStoreAddress: KEYSTORE, walletAddress: WALLET,
      keyId: keccak256(PUBLIC_KEY), sessionPublicKey: PUBLIC_KEY, verdict: "missing" as const,
      blockNumber: "101", blockHash: `0x${"81".repeat(32)}` as Hex, observedAtMs: NOW_MS,
    };
    const confirming = confirmer.confirmSessionRevokedCas({ ownerAddress: OWNER, agentId: created.id,
      expectedRowVersion: revoked!.rowVersion, expectedPublicKey: PUBLIC_KEY, expectedChainId: 56,
      expectedKeyStoreAddress: KEYSTORE, evidence: proof });
    await paused.atUpdate;

    let createSettled = false;
    let keySettled = false;
    const replacement = contender.createAgent({ id: "trade-replacement", ownerAddress: OWNER,
      walletAddress: WALLET, custodyModel: "passkey", status: "provisioning" })
      .finally(() => { createSettled = true; });
    const keyRestore = contender.putAgentSessionKey(OWNER, created.id, PRIVATE_KEY)
      .then(() => null, (error: unknown) => error)
      .finally(() => { keySettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const createCrossedFence = createSettled;
    const keyCrossedFence = keySettled;
    paused.release();
    const outcomes = await Promise.allSettled([confirming, replacement, keyRestore]);
    const finalRow = await confirmer.getAgent(OWNER, created.id);
    const finalKeyPresent = await confirmer.hasAgentSessionKey(OWNER, created.id);
    const finalKey = await confirmer.getAgentSessionKey(OWNER, created.id);
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const confirmed = outcomes[0].status === "fulfilled" ? outcomes[0].value : null;
    const replaced = outcomes[1].status === "fulfilled" ? outcomes[1].value : null;
    const keyError = outcomes[2].status === "fulfilled" ? outcomes[2].value : null;
    assert.equal(createCrossedFence, false, "replacement crossed the held wallet fence");
    assert.equal(keyCrossedFence, false, "key writer crossed the held wallet fence");
    assert.equal(confirmed?.kind, "confirmed");
    assert.equal(replaced?.id, "trade-replacement");
    assert.match(String(keyError), /Refusing to restore a revoked agent session key/u);
    assert.deepEqual(finalRow?.sessionRevocation, proof);
    assert.equal(finalKeyPresent, false);
    assert.equal(finalKey, null);

    const corruptionSql = await createPgSqlClient(url);
    try {
      await corruptionSql.query(
        "update agents set session_key_ciphertext = $2 where id = $1",
        [created.id, "test-only-corrupt-ciphertext"],
      );
    } finally {
      await corruptionSql.close();
    }
    const corruptRow = await contender.getAgent(OWNER, created.id);
    assert.notEqual(corruptRow, null);
    assert.equal(await contender.hasAgentSessionKey(OWNER, created.id), true);
    assert.equal(agentSessionIntegrity(
      corruptRow!, REVOCATION_CONTEXT, NOW_MS, true,
    ), "proof_with_key");

    // Route-level R3 proof against the real Postgres adapter. Every chain/data
    // collaborator below is a deterministic read-only fake; no transaction is
    // signed or submitted.
    const routeStore = await PostgresAgentStore.create(
      await createPgSqlClient(url), MASTER_KEY, () => NOW_SEC * 1_000, REVOCATION_CONTEXT,
    );
    stores.push(routeStore);
    const venues = { chainId: 56, pancakeRouterV2: ROUTE_ROUTER_V2,
      pancakeRouterV3: ROUTE_ROUTER_V3, wbnb: ROUTE_WBNB };
    const dataPlane: TradeDataPlaneReads = {
      async universe(lane) { return routeUniverse(lane); },
      async tokensBatch(addresses) { return addresses.map((address, index) => ({ address,
        symbol: `R${index}`, priceUsd: 1, marketCapUsd: 2_000_000,
        volume24hUsd: 10_000 - index, holders: 100, priceChange24hPct: 1 })); },
      async eligibilityBatch() { return []; },
      async security() { return { data: {}, meta: {} }; },
    };
    const readiness: TradeReadiness = { ready: true, allowlistAvailable: true,
      bstocksAddresses: new Set(ROUTE_TOKENS.map((token) => token.toLowerCase())), stop() {} };
    const keyStoreReader: KeyStoreReader = {
      async listKeys() { return []; },
      async publicKeyFor() { return ROUTE_PUBLIC_KEY; },
      async isValidKey() { return false; },
      async finalizedBlock() { return { number: 101n, hash: ROUTE_FINALIZED_HASH }; },
      async blockAt(blockNumber) { return { number: blockNumber, hash: ROUTE_FINALIZED_HASH }; },
      async listKeysAt(wallet) { return wallet.toLowerCase() === ROUTE_WALLETS[2].toLowerCase()
        ? [keccak256(ROUTE_VALID_PUBLIC_KEY)] : []; },
      async publicKeyForAt() { return ROUTE_VALID_PUBLIC_KEY; },
      async isValidKeyAt() { return true; },
    };
    const evidenceReader: GrantEvidenceReader = {
      async readFunding(_wallet, relayGasHeadroomWei, observedAtSec) {
        return { version: 1, observedAtSec, registrationFeeWei: "2", registrations: 2,
          relayGasHeadroomWei: relayGasHeadroomWei.toString(10), requiredWei: "7",
          balanceWei: "1000000000000000000" };
      },
      async readGrant() { return { relayKeys: [], accountKey: null, accountSpend: [], canExecute: [],
        keyStore: { kind: "missing" }, ownerVerdict: "verified" }; },
    };
    const settings = new MemoryTradeSettingsStore(routeStore, () => NOW_SEC * 1_000);
    const routeHarness = await createHarness({ seedAgent: false, agentStore: routeStore,
      journal: new MemoryExecutionJournal(() => NOW_SEC * 1_000), keyStoreReader,
      tradeAgent: { settingsStore: settings, positions: new MemoryTradePositionStore(() => NOW_SEC * 1_000),
        intents: new MemoryTradeIntentStore(() => NOW_SEC * 1_000), dataPlane, readiness, feeBps: 0,
        observer: { async observe(_agent, rows) { return rows.map((row) => ({ positionId: row.positionId,
          symbol: null, decimals: null,
          recordedPositionAmount: row.tokenAmount === null ? null : row.tokenAmount.toString(10),
          liveWalletBalance: row.tokenAmount === null ? null : row.tokenAmount.toString(10),
          currentQuoteWei: null, pnlBps: null, quoteStatus: "unavailable" as const,
          reason: null, observedAt: NOW_SEC * 1_000 })); } } },
      config: { chainId: 56, network: "mainnet", keyStore: KEYSTORE, hireEnabled: true,
        tradeAgentEnabled: true, executeRawEnabled: false, trade: tradeConfig({ venues }),
        passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
      hire: { evidence: evidenceReader, nfpm: ROUTE_NFPM, routerV3: ROUTE_ROUTER_V3,
        wbnb: ROUTE_WBNB, treasury: ROUTE_TREASURY, feeBps: 0,
        relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n } });
    const postRoute = async (id: string, wallet: typeof ROUTE_WALLETS[number], run: string) => {
      const envelope = await signOwnerAction("provisionAgent", routeHireParams(wallet, run),
        { agentId: id, chainId: 56, network: "mainnet" });
      return call(routeHarness, `/agents/${id}/session`, { method: "POST", body: envelope,
        headers: { "x-exec-token": EXEC_TOKEN } });
    };

    const removed = await routeStore.createAgent({ id: "pg-route-removed-grid",
      ownerAddress: ownerAccount.address, walletAddress: ROUTE_WALLETS[0], custodyModel: "passkey",
      sessionFacts: routeFacts(ROUTE_PUBLIC_KEY), status: "armed" });
    await routeStore.putAgentSessionKey(ownerAccount.address, removed.id, PRIVATE_KEY);
    const removedWithKey = await routeStore.getAgent(ownerAccount.address, removed.id);
    await routeStore.transitionAgentStatus({ ownerAddress: ownerAccount.address, agentId: removed.id,
      expectedStatus: "armed", expectedRowVersion: removedWithKey!.rowVersion, status: "revoked" });
    const routeReplacement = await postRoute("pg-route-trading", ROUTE_WALLETS[0],
      "11111111-1111-4111-8111-111111111111");
    assert.equal(routeReplacement.status, 200, routeReplacement.text);
    assert.equal((await routeStore.getAgent(ownerAccount.address, removed.id))?.sessionRevocation?.verdict, "missing");
    assert.equal(await routeStore.hasAgentSessionKey(ownerAccount.address, removed.id), false);

    const draft = await postRoute("pg-route-draft", ROUTE_WALLETS[1],
      "22222222-2222-4222-8222-222222222222");
    assert.equal(draft.status, 200, draft.text);
    const draftBlocked = await postRoute("pg-route-after-draft", ROUTE_WALLETS[1],
      "33333333-3333-4333-8333-333333333333");
    assert.equal(draftBlocked.status, 409, draftBlocked.text);
    assert.match((draftBlocked.body as { error: { message: string } }).error.message,
      /Trading Agent "pg-route-draft" still has an unfinished session setup/u);
    const signedCancel = await signOwnerAction("cancelProvisioning", {},
      { agentId: "pg-route-draft", chainId: 56, network: "mainnet" });
    const canceledRoute = await call(routeHarness, "/agents/pg-route-draft/session/cancel", {
      method: "POST", body: signedCancel, headers: { "x-exec-token": EXEC_TOKEN },
    });
    assert.equal(canceledRoute.status, 200, canceledRoute.text);
    assert.equal((canceledRoute.body as { data: { cancelRequested: boolean } }).data.cancelRequested, true);
    const afterCancel = await postRoute("pg-route-after-cancel", ROUTE_WALLETS[1],
      "55555555-5555-4555-8555-555555555555");
    assert.equal(afterCancel.status, 200, afterCancel.text);
    assert.equal(await routeStore.hasAgentSessionKey(ownerAccount.address, "pg-route-draft"), true);
    assert.equal((await routeStore.getAgent(ownerAccount.address, "pg-route-draft"))?.sessionFacts, null);

    const valid = await routeStore.createAgent({ id: "pg-route-valid-grid",
      ownerAddress: ownerAccount.address, walletAddress: ROUTE_WALLETS[2], custodyModel: "passkey",
      sessionFacts: routeFacts(ROUTE_VALID_PUBLIC_KEY), status: "armed" });
    await routeStore.putAgentSessionKey(ownerAccount.address, valid.id, PRIVATE_KEY);
    const validWithKey = await routeStore.getAgent(ownerAccount.address, valid.id);
    await routeStore.transitionAgentStatus({ ownerAddress: ownerAccount.address, agentId: valid.id,
      expectedStatus: "armed", expectedRowVersion: validWithKey!.rowVersion, status: "revoked" });
    const validBlocked = await postRoute("pg-route-after-valid", ROUTE_WALLETS[2],
      "44444444-4444-4444-8444-444444444444");
    assert.equal(validBlocked.status, 409, validBlocked.text);
    assert.equal((validBlocked.body as { error: { message: string } }).error.message,
      'Finish removing Grid Agent "pg-route-valid-grid" before deploying Trading Agent.');

    // Pause at the actual UPDATE while holding the wallet advisory lock, so
    // both race orderings are proved across independent database connections.
    for (const cancelFirst of [true, false]) {
      const wallet = getAddress(cancelFirst ? "0x8222222222222222222222222222222222222222" : "0x9222222222222222222222222222222222222222");
      const nowSec = Math.floor(NOW_MS / 1_000);
      const pending = pendingDraft(OWNER, wallet, nowSec);
      const id = `pg-r5-${cancelFirst ? "cancel" : "arm"}`;
      const row = await seed.createProvisioningAgent({ record: { id, ownerAddress: OWNER, walletAddress: wallet, custodyModel: "passkey" },
        pendingGrant: pending, sessionKey: DRAFT_KEY });
      const pausedRace = pauseConfirmation(await createPgSqlClient(url), cancelFirst ? "/* agents.cancelProvisioning */" : "/* agents.armProvisioning */");
      releaseGate = pausedRace.release;
      const first = await PostgresAgentStore.create(pausedRace.client, MASTER_KEY, () => NOW_MS, REVOCATION_CONTEXT);
      stores.push(first);
      const arm = (store: PostgresAgentStore) => store.armProvisioningAgent({ ownerAddress: OWNER, agentId: id,
        expectedRowVersion: row.rowVersion, expectedGrantDigest: pending.grantDigest, sessionFacts: facts() });
      const cancel = (store: PostgresAgentStore) => store.cancelProvisioningAgent({ ownerAddress: OWNER, agentId: id,
        expectedRowVersion: row.rowVersion, expectedGrantDigest: pending.grantDigest, nowSec, cancelActionId: CANCEL_ACTION });
      const winning = cancelFirst ? cancel(first) : arm(first);
      await pausedRace.atUpdate;
      let competingSettled = false;
      const competing = (cancelFirst ? arm(contender) : cancel(contender)).finally(() => { competingSettled = true; });
      const replacements = Promise.allSettled(["a", "b"].map((suffix) => contender.createProvisioningAgent({
        record: { id: `${id}-${suffix}`, ownerAddress: OWNER, walletAddress: wallet, custodyModel: "passkey" },
        pendingGrant: pending, sessionKey: DRAFT_KEY,
      })));
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(competingSettled, false, "the competing CAS waits behind the wallet lock");
      pausedRace.release();
      assert.equal((await winning).updated, true);
      assert.equal((await competing).updated, false);
      const inserted = await replacements;
      assert.equal(inserted.filter((result) => result.status === "fulfilled").length, cancelFirst ? 1 : 0);
      for (const result of inserted) if (result.status === "rejected") assert(result.reason instanceof AgentWalletInUseError);
      if (cancelFirst) {
        assert.equal(await seed.updateAgentSessionFacts(OWNER, id, facts()), null);
        for (const status of ["armed", "paused", "retired"] as const) assert.equal(await seed.updateAgentStatus(OWNER, id, status), null);
        assert.equal((await seed.getAgent(OWNER, id))?.sessionFacts, null);
        assert.equal(await seed.hasAgentSessionKey(OWNER, id), true);
        assert.equal((await cancelDraft(seed, OWNER, id, pending.expiresAt)).retired, true);
        assert.equal(await seed.hasAgentSessionKey(OWNER, id), false);
      }
    }

    const corruptSql = await createPgSqlClient(url);
    const corruptStore = await PostgresAgentStore.create(corruptSql, MASTER_KEY, () => NOW_MS, REVOCATION_CONTEXT);
    stores.push(corruptStore);
    const corruptWallet = getAddress("0xa222222222222222222222222222222222222222");
    const nowSec = Math.floor(NOW_MS / 1_000);
    const corruptPending = pendingDraft(OWNER, corruptWallet, nowSec);
    await corruptStore.createProvisioningAgent({ record: { id: "pg-malformed", ownerAddress: OWNER,
      walletAddress: corruptWallet, custodyModel: "passkey" }, pendingGrant: corruptPending, sessionKey: DRAFT_KEY });
    for (const marker of [{ cancelRequestedAtSec: nowSec }, { cancelActionId: CANCEL_ACTION },
      { cancelRequestedAtSec: nowSec, cancelActionId: "0x" },
      { cancelRequestedAtSec: nowSec, cancelActionId: CANCEL_ACTION, expiresAt: "invalid" },
      { cancelRequestedAtSec: nowSec + 31, cancelActionId: CANCEL_ACTION }]) {
      await corruptSql.query("update agents set pending_grant = $1::jsonb where id = $2",
        [encodeJsonbParam({ ...corruptPending, ...marker }), "pg-malformed"]);
      const row = (await corruptStore.getAgent(OWNER, "pg-malformed"))!;
      assert.equal(provisioningView(row, nowSec)["cancelRequested"], false);
      await assert.rejects(corruptStore.createAgent({ id: "pg-malformed-replacement", ownerAddress: OWNER,
        walletAddress: corruptWallet, custodyModel: "passkey", status: "armed" }), AgentWalletInUseError);
      assert.equal((await corruptStore.armProvisioningAgent({ ownerAddress: OWNER, agentId: row.id,
        expectedRowVersion: row.rowVersion, expectedGrantDigest: corruptPending.grantDigest, sessionFacts: facts() })).updated, false);
      assert.equal(await corruptStore.updateAgentSessionFacts(OWNER, row.id, facts()), null);
      assert.equal(await corruptStore.updateAgentStatus(OWNER, row.id, "armed"), null);
      assert.equal((await corruptStore.startGrantAttemptCas({ ownerAddress: OWNER, agentId: row.id,
        expectedGrantDigest: corruptPending.grantDigest, attemptId: CANCEL_ACTION, startedAtSec: nowSec })).kind, "conflict");
      assert.equal((await corruptStore.resetGrantAttemptCas({ ownerAddress: OWNER, agentId: row.id,
        expectedGrantDigest: corruptPending.grantDigest, attemptId: CANCEL_ACTION, resetActionId: CANCEL_ACTION, resetAtSec: nowSec })).kind, "conflict");
    }
    for (const canceled of [false, true]) {
      await corruptSql.query("update agents set pending_grant = $1::jsonb where id = $2",
        [encodeJsonbParam({ ...corruptPending, ...(canceled ? { cancelRequestedAtSec: nowSec, cancelActionId: CANCEL_ACTION } : {}) }), "pg-malformed"]);
      for (const column of ["session_facts", "session_revocation"] as const) {
        for (const json of ["{}", "[]", "false", '"bad"', "0", "null"]) {
          // Closed test-only column names; JSONB literal null must differ from SQL NULL.
          await corruptSql.query(`update agents set ${column} = $1::jsonb where id = $2`, [json, "pg-malformed"]);
          const row = (await corruptStore.getAgent(OWNER, "pg-malformed"))!;
          assert.equal(provisioningView(row, nowSec)["cancelRequested"], false, `${column}: ${json}`);
          await assert.rejects(corruptStore.createAgent({ id: "pg-malformed-replacement", ownerAddress: OWNER,
            walletAddress: corruptWallet, custodyModel: "passkey", status: "armed" }), AgentWalletInUseError);
          await assert.rejects(corruptStore.createProvisioningAgent({ record: { id: "pg-malformed-draft", ownerAddress: OWNER,
            walletAddress: corruptWallet, custodyModel: "passkey" }, pendingGrant: corruptPending, sessionKey: DRAFT_KEY }), AgentWalletInUseError);
          assert.equal((await cancelDraft(corruptStore, OWNER, row.id, nowSec)).updated, false);
          assert.equal((await cancelDraft(corruptStore, OWNER, row.id, corruptPending.expiresAt)).updated, false);
          assert.deepEqual(await corruptStore.getAgent(OWNER, row.id), row);
          assert.equal(await corruptStore.getAgentSessionKey(OWNER, row.id), DRAFT_KEY);
          await corruptSql.query(`update agents set ${column} = NULL where id = $1`, [row.id]);
        }
      }
    }
  } finally {
    releaseGate();
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    const childExit = postgresProcess === undefined || postgresProcess.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => postgresProcess!.once("exit", () => resolve()));
    if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      await command(pgCtl, ["stop", "-D", data, "-m", "fast", "-w"]).catch(() => undefined);
      await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
    if (process.platform === "win32" && postmasterPid !== undefined && /^\d+$/u.test(postmasterPid)) {
      await command("C:\\Windows\\System32\\taskkill.exe", ["/PID", postmasterPid, "/T", "/F"])
        .catch(() => undefined);
    } else if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      postgresProcess.kill("SIGTERM");
    }
    await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
