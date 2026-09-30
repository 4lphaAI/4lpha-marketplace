/**
 * The cutover accepts exactly the terminal state that Grid's own recovery leaves for a COMMITTED journal without a
 * hash (`COMMITTED-hash/found`: the hash comes from the relay, is verified and settled, and the journal keeps none).
 * The state is produced here by the real `recoverUnsettledActions` on the real Postgres stores, in this test's own
 * temporary cluster. Nothing reads DATABASE_URL or an env file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { localPostgres } from "./support/localPostgres.js";
import { buildPair, encodeExecute, encodeIntent, intentExecutedLog, swapLog, transferLog } from "./support/quantReceipts.js";
import { applyCutover, runCensus, runPlanCheck, type CutoverPlan } from "../scripts/quant-claim-cutover.js";
import { buildPancakeTokenSwap } from "../src/ops/pancakeTokens.js";
import {
  QUANT_ROUTER_56, QUANT_STRATEGY_DEFAULTS, QUANT_U_56, QUANT_U_WBNB_PAIR_56, QUANT_WBNB_56, quantParamsDigest,
} from "../src/quant/config.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import { recoverUnsettledActions, type QuantReconcileDeps } from "../src/quant/reconcile.js";
import { INTENT_SUCCESS_ERR } from "../src/quant/receipt.js";
import type { WalletProvider } from "../src/core/types.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import { PostgresQuantJobStore } from "../src/store/quantJobs.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";

const U = 10n ** 18n;
const JOB = "quant-job-rec";
const KEY = "action-key";
const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
const PUBLIC_KEY = "0x043c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b13b306b0fe085665d8fc1b28ae1676cd3ad6e08eaeda225fe38d0da4de55703e0" as Hex;
const KEY_HASH = accountKeyHashForAddress(publicKeyToAddress(PUBLIC_KEY));
const DIGEST = `0x${"11".repeat(32)}` as Hex;
const TX = `0x${"ab".repeat(32)}` as Hex;
const AMOUNT_IN = 10n * U;
const MIN_OUT = 13_500_000_000_000_000n;
const FILL_OUT = 13_551_363_807_546_408n;
const PARAMS_JSON = JSON.stringify({
  paramsSchema: "r14", ...QUANT_STRATEGY_DEFAULTS, bandBps: 700,
  minClipUWei: QUANT_STRATEGY_DEFAULTS.minClipUWei.toString(10),
  relayFeePerSubmitWei: QUANT_STRATEGY_DEFAULTS.relayFeePerSubmitWei.toString(10),
  relayGasUnits: QUANT_STRATEGY_DEFAULTS.relayGasUnits.toString(10),
  relayFeePadBps: QUANT_STRATEGY_DEFAULTS.relayFeePadBps.toString(10),
});
const CALLS = buildPancakeTokenSwap({
  router: QUANT_ROUTER_56, tokenIn: QUANT_U_56, tokenOut: QUANT_WBNB_56,
  amountInWei: AMOUNT_IN, minOutWei: MIN_OUT, recipient: WALLET, deadline: 1_800_000_601n,
});

/** A confirmed swap transaction for the job's wallet, built from the encodings the chain uses. */
function goodPair() {
  const nonce = 42n;
  return buildPair({
    txHash: TX,
    input: encodeExecute([encodeIntent({ eoa: WALLET, nonce, keyHash: KEY_HASH, calls: CALLS })]),
    logs: [
      transferLog({ token: QUANT_U_56, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: AMOUNT_IN, logIndex: 0n }),
      transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: FILL_OUT, logIndex: 1n }),
      swapLog({ pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn: AMOUNT_IN, amountOut: FILL_OUT, inputIsToken0: true, logIndex: 2n }),
      intentExecutedLog({ eoa: WALLET, nonce, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 3n }),
    ],
  });
}

/**
 * One job with one buy that the relay confirmed: the journal is COMMITTED with no hash (`markCommitted` without
 * evidence), and the relay status read supplies the hash. Returns the outcome of the real recovery.
 */
async function recoverCommittedWithoutHash(sql: SqlClient) {
  const store = await PostgresQuantJobStore.create(sql);
  const journal = await PostgresExecutionJournal.create(sql);
  await store.discoverJob({ quantJobId: JOB, envelopeId: "e", envelopeJson: "{}", nowMs: 1_000 });
  await store.updateJobWire({
    quantJobId: JOB, strategyId: "s", tradingWallet: WALLET, allocationUWei: 30n * U, dailyCapUWei: 40n * U, termDays: 30,
    startedAtMs: 1_000, endsAtMs: 9_000_000, sessionExpiresAtMs: 9_000_000, revokedAtMs: null, nowMs: 1_100,
  });
  await store.admitJob({
    quantJobId: JOB, expectedRowVersion: (await store.getJob(JOB))!.rowVersion,
    sessionPublicKey: PUBLIC_KEY, sessionExpiry: 1_800_000, permissionsDigest: DIGEST, projectionDigest: DIGEST,
    wbnbCapMinLimitWei: 2n * 10n ** 17n, residualThresholdWei: 10n ** 15n,
    paramsJson: PARAMS_JSON, paramsDigest: quantParamsDigest(QUANT_STRATEGY_DEFAULTS), p0E18: 740n * U, armBlock: 100n,
    levels: [{ levelIndex: 1, buyPriceE18: 700n * U, sellPriceE18: 749n * U }],
    clipUWei: AMOUNT_IN, idleUWei: 0n, baselineUWei: 30n * U, baselineWbnbWei: 0n, baselineNativeWei: 10n ** 16n, nowMs: 1_200,
  });
  const level = (await store.listLevels(JOB))[0]!;
  await store.withQuantFence(JOB, async (fence) => fence.insertIntent({
    journalKey: KEY, quantJobId: JOB, levelIndex: 1, actionSeq: 1, side: "buy",
    priorLevelState: level.state, expectedLevelRowVersion: level.rowVersion,
    amountInWei: AMOUNT_IN, minOutWei: MIN_OUT, quoteOutWei: FILL_OUT, quoteBlock: 101n, triggerBlock1: 100n, triggerBlock2: 100n,
    deadlineSec: 1_800_000_601, callsJson: JSON.stringify(CALLS.map((call) => ({ to: call.to, value: "0", data: call.data }))),
    note: "{}", impactBps: 4, preUWei: 30n * U, preWbnbWei: 0n, preNativeWei: 10n ** 16n, basisUWei: 0n, baseAtCycleStartWei: 0n,
    gasPriceWei: 50_000_000n, feeEstWei: 30_000_000_000_000n, nowMs: 2_000,
  }));
  await journal.beginWithSpend({
    idempotencyKey: KEY, agentId: JOB, ownerAddress: WALLET, kind: "quantTrade", decisionId: KEY,
    externalRef: { publicKey: PUBLIC_KEY }, nativeSpendWei: 0n,
  }, 0);
  await store.markActionSubmitted({
    journalKey: KEY, expectedRowVersion: (await store.getAction(KEY))!.rowVersion,
    submitFinalizedNumber: 90n, submitFinalizedHash: `0x${"cc".repeat(32)}` as Hex, nowMs: 2_500,
  });
  await journal.markInProgress(KEY, { callsId: `0x${"c1".repeat(32)}` });
  await journal.markCommitted(KEY);

  const pair = goodPair();
  const reader = {
    getTransaction: async (hash: Hex) => hash.toLowerCase() === TX ? pair.transaction : null,
    getReceipt: async (hash: Hex) => hash.toLowerCase() === TX ? pair.receipt : null,
    finalizedBlock: async () => ({ number: 500n, hash: `0x${"bb".repeat(32)}` as Hex, timestampSec: 1_800_001_000n }),
  } as unknown as QuantChainReader;
  const provider = {
    readExecutionStatus: async () => ({ receipt: { status: "CONFIRMED", transactionHash: TX }, definitive: true }),
  } as unknown as WalletProvider;
  const deps: QuantReconcileDeps = {
    store, journal, provider, reader, params: QUANT_STRATEGY_DEFAULTS,
    venue: { router: QUANT_ROUTER_56, u: QUANT_U_56, wbnb: QUANT_WBNB_56, pair: QUANT_U_WBNB_PAIR_56 },
    nowMs: () => 3_000,
  };
  const outcome = await recoverUnsettledActions(deps, (await store.getJob(JOB))!);
  // The legacy production database predates the claim column.
  await sql.query("alter table quant_jobs drop column claim_generation");
  return { store, journal, outcome };
}

test("claim cutover: the state Grid recovery leaves for a COMMITTED journal without a hash is accepted, a conflicting hash is not", { timeout: 120_000 }, async (t) => {
  const cluster = await localPostgres();
  if (cluster === null) { t.skip("PostgreSQL 17 binaries are unavailable; DATABASE_URL is never read"); return; }
  const admin = await createPgSqlClient(cluster.url);
  const pools: SqlClient[] = [admin];
  const database = async (name: string) => {
    await admin.query(`create database ${name}`);
    const sql = await createPgSqlClient(cluster.url.replace(/\/postgres$/u, `/${name}`)); pools.push(sql);
    return { sql, url: cluster.url.replace(/\/postgres$/u, `/${name}`) };
  };
  try {
    await t.test("real recovery settles from the relay's hash and leaves the journal without one, and the cutover applies", async () => {
      const { sql, url } = await database("recovered_ok");
      const { store, journal, outcome } = await recoverCommittedWithoutHash(sql);
      assert.equal(outcome[0]?.cell, "COMMITTED-hash/found");
      assert.equal(outcome[0]?.settled, true);
      const action = await store.getAction(KEY);
      assert.equal(action?.state, "settled");
      assert.equal(action?.txHash, TX);
      const entry = await journal.get(KEY);
      assert.equal(entry?.state, "COMMITTED");
      assert.equal(entry?.externalRef.txHash, undefined, "the shape this test exists to pin: recovery does not write the hash back");
      const owners = (await sql.query("select tx_hash, lower(trading_wallet) as wallet, journal_key from quant_receipt_ownership")).rows;
      assert.deepEqual(owners, [{ tx_hash: TX, wallet: WALLET.toLowerCase(), journal_key: KEY }]);

      const census = await runCensus(sql) as unknown as { draftPlan: CutoverPlan; unresolved: string[] };
      assert.deepEqual(census.unresolved, []);
      const outcomeOfApply = await applyCutover({ databaseUrl: url, plan: census.draftPlan });
      assert.equal(outcomeOfApply.kind, "applied", JSON.stringify(outcomeOfApply));
    });

    await t.test("the same state with a conflicting journal hash is refused with no write", async () => {
      const { sql, url } = await database("recovered_conflict");
      await recoverCommittedWithoutHash(sql);
      await sql.query(`update execution_journal set external_ref = external_ref || jsonb_build_object('txHash', $1::text) where idempotency_key = $2`,
        [`0x${"cd".repeat(32)}`, KEY]);
      const census = await runCensus(sql) as unknown as { draftPlan: CutoverPlan; unresolved: string[] };
      assert.ok(census.unresolved.some((finding) => finding === `settled-action-evidence-mismatch:${JOB}:${KEY}`), census.unresolved.join(","));
      const check = await runPlanCheck(sql, census.draftPlan);
      assert.equal(check["ok"], false);
      const outcome = await applyCutover({ databaseUrl: url, plan: census.draftPlan });
      assert.equal(outcome.kind, "refused", JSON.stringify(outcome));
      if (outcome.kind === "refused") assert.equal(outcome.code, "plan-refused");
      assert.equal((await sql.query("select to_regclass('public.quant_wallet_claims') as a")).rows[0]?.["a"], null, "nothing was written");
    });
  } finally {
    for (const sql of pools.reverse()) await sql.close();
    await cluster.close();
  }
});
