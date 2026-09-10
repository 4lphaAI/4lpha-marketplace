import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type Hex } from "viem";
import { IdentityError, newIdentity } from "../src/identity/types.js";
import { dailyLiability } from "../src/store/erc8004.js";
import { MemoryIdentityFence } from "../src/identity/fence.js";
import { IdentityService, previewIdentity, verifyIdentity } from "../src/identity/service.js";
import { CONFIG, fixture } from "./support/erc8004.js";

for (const backend of ["memory", "postgres"] as const) {
  test(`${backend}: a pre-preparation fee-limit block can retry after the explicit daily ceiling is raised`, async () => {
    const f = fixture(backend === "postgres", { ...CONFIG, maxDailyFee: 5_000n });
    await f.service.discover("agent");
    assert.deepEqual(await f.service.step("agent"), { status: "blocked", errorCode: "fee_limit" });
    assert.equal((await f.ledger.read()).transactions.length, 0);
    const retry = f.restart({ ...CONFIG, maxDailyFee: 50_000n });
    assert.deepEqual(await retry.step("agent"), { status: "registering" });
    assert.equal((await f.ledger.read()).transactions.length, 1);
  });

  test(`${backend}: one mint and one update survive every phase restart, ID zero, finalization time fixed`, async () => {
    const f = fixture(backend === "postgres"); await f.service.discover("agent");
    const preview = await previewIdentity(CONFIG, (await f.sources.get("agent"))!, f.ledger, f.gateway);
    assert.equal(preview.exact, true); assert.equal(f.gateway.signed.length, 0);
    assert.equal((await f.service.step("agent", 11_000n)).status, "registering");
    let state = await f.ledger.read(); const first = state.transactions[0]!;
    assert.equal(state.jobs[0]!.initialUri, "initialUri" in preview ? preview.initialUri : "missing");
    assert.equal(state.jobs[0]!.envelope, "10240"); assert.equal(state.jobs[0]!.effectiveCeiling, "11000");
    await f.gateway.land(first, state.jobs[0]!.initialUri);
    assert.equal((await f.restart().step("agent")).status, "updating");
    state = await f.ledger.read(); assert.equal(state.jobs[0]!.mintedId, "0"); assert.equal(state.transactions.length, 1);
    assert.equal((await f.restart().step("agent")).status, "updating");
    state = await f.ledger.read(); const update = state.transactions[1]!;
    assert.equal(update.intent.nonce, first.intent.nonce + 1); assert.equal(state.jobs[0]!.envelope, "10240");
    await f.gateway.land(update, state.jobs[0]!.finalUri!);
    assert.equal((await f.restart().step("agent")).status, "registered");
    const completed = (await f.ledger.read()).jobs[0]!.completedAt;
    f.setNow(3_000_000); await f.restart().discover(); await f.restart().step("agent");
    assert.equal((await f.ledger.read()).jobs[0]!.completedAt, completed);
    assert.equal(f.gateway.signed.length, 2); assert.equal(f.gateway.sent.length, 2);
    assert.equal((await verifyIdentity((await f.sources.get("agent"))!, f.ledger, f.gateway)).verified, true);
  });
  test(`${backend}: crash after durable preparation before broadcast reconstructs identical bytes`, async () => {
    const f = fixture(backend === "postgres"); await f.service.discover(); f.gateway.failBroadcast = true;
    await f.service.step("agent"); const prepared = (await f.ledger.read()).transactions[0]!;
    assert.ok(prepared); assert.equal(f.gateway.sent.length, 0); f.gateway.failBroadcast = false;
    await f.restart().step("agent"); await f.restart().step("agent");
    assert.equal((await f.ledger.read()).transactions.length, 1); assert.equal(f.gateway.sent.length, 2);
    assert.equal(f.gateway.sent[0], f.gateway.sent[1]); assert.equal(keccak256(f.gateway.sent[0]!), prepared.hash);
  });
  test(`${backend}: unknown prepared liabilities never age out, late completion starts fresh 24h hold`, async () => {
    const f = fixture(backend === "postgres"); await f.service.discover(); await f.service.step("agent");
    f.setNow(100_000_000); let state = await f.ledger.read(); assert.equal(dailyLiability(state, 100_000_000), 10_240n);
    await f.gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri); await f.restart().step("agent");
    await f.restart().step("agent"); state = await f.ledger.read(); await f.gateway.land(state.transactions[1]!, state.jobs[0]!.finalUri!); await f.restart().step("agent");
    state = await f.ledger.read(); assert.equal(dailyLiability(state, 100_000_001), 10_240n); assert.equal(dailyLiability(state, 186_400_000), 0n);
  });
  test(`${backend}: lost fence after signing rolls back job envelope, nonce and intent`, async () => {
    const f = fixture(backend === "postgres"); await f.service.discover(); f.gateway.afterSign = () => f.fence.close();
    await assert.rejects(f.service.step("agent"), (error: unknown) => error instanceof IdentityError && error.code === "lock_lost");
    const state = await f.ledger.read(); assert.equal(state.transactions.length, 0); assert.equal(state.nextNonce, null); assert.equal(state.jobs[0]!.envelope, null); assert.equal(f.gateway.sent.length, 0);
  });
}

test("underfunded complete envelope refuses before first signature", async () => {
  for (const kind of ["balance", "instance", "daily", "run"] as const) {
    const config = { ...CONFIG, ...(kind === "instance" ? { maxInstanceFee: 10_239n } : {}), ...(kind === "daily" ? { maxDailyFee: 10_239n } : {}) };
    const f = fixture(false, config); if (kind === "balance") f.gateway.balance = 10_239n;
    await f.service.discover(); assert.equal((await f.service.step("agent", kind === "run" ? 10_239n : undefined)).status, "blocked");
    assert.equal(f.gateway.signed.length, 0); assert.equal((await f.ledger.read()).transactions.length, 0);
  }
});
test("external pending nonce refuses initialization and high-water mismatch refuses a later job", async () => {
  const f = fixture(); await f.service.discover(); f.gateway.pending++;
  assert.equal((await f.service.step("agent")).errorCode, "nonce_conflict"); assert.equal(f.gateway.signed.length, 0);
  const other = fixture(); await other.service.discover(); await other.service.step("agent"); let state = await other.ledger.read();
  await other.gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri); await other.service.step("agent");
  other.gateway.latest += 1; other.gateway.pending = other.gateway.latest;
  assert.equal((await other.restart().step("agent")).errorCode, "nonce_conflict"); assert.equal(other.gateway.signed.length, 1);
});
test("one-instance run refuses another job's outstanding work without signing it", async () => {
  const f = fixture(); f.sources.rows.set("other", { ...f.sources.rows.get("agent")!, id: "other", identity: newIdentity("lp") });
  await f.service.discover(); await f.service.step("agent"); const sent = f.gateway.sent.length;
  assert.equal((await f.service.step("other")).errorCode, "other_job_pending"); assert.equal(f.gateway.sent.length, sent);
});
test("lowered caps block signatures but still recover a subsequently available original mint receipt", async () => {
  const f = fixture(); await f.service.discover(); await f.service.step("agent");
  const state = await f.ledger.read(); const limited = f.restart({ ...CONFIG, maxInstanceFee: 1n });
  assert.equal((await limited.step("agent")).errorCode, "fee_limit"); assert.equal(f.gateway.signed.length, 1);
  await f.gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri);
  assert.equal((await limited.step("agent")).status, "blocked");
  assert.equal((await f.ledger.read()).jobs[0]!.mintedId, "0"); assert.equal((await f.ledger.read()).transactions[0]!.outcome, "success");
  await f.restart().step("agent"); assert.equal(f.gateway.signed.length, 1);
});
test("mint event id survives an unavailable ownership read without making a fresh mint", async () => {
  const f = fixture(); await f.service.discover(); await f.service.step("agent"); let state = await f.ledger.read();
  await f.gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri); f.gateway.failIdentity = true;
  await f.service.step("agent"); state = await f.ledger.read(); assert.equal(state.jobs[0]!.mintedId, "0"); assert.equal(state.transactions[0]!.finalizedAt, null);
  f.gateway.failIdentity = false; await f.restart().step("agent"); assert.equal(f.gateway.signed.length, 1);
});
test("wrong receipt, event, owner and URI each block without losing nonce or reminting", async () => {
  for (const kind of ["hash", "to", "owner", "uri", "event", "duplicate", "revert"] as const) {
    const f = fixture(); await f.service.discover(); await f.service.step("agent"); const state = await f.ledger.read(); const tx = state.transactions[0]!;
    await f.gateway.land(tx, state.jobs[0]!.initialUri, kind === "revert" ? "reverted" : "success");
    const receipt = f.gateway.receipts.get(tx.hash)!;
    if (kind === "hash") f.gateway.receipts.set(tx.hash, { ...receipt, transactionHash: `0x${"cc".repeat(32)}` });
    if (kind === "to") f.gateway.receipts.set(tx.hash, { ...receipt, to: CONFIG.minter });
    if (kind === "owner") f.gateway.owner = "0x3333333333333333333333333333333333333333";
    if (kind === "uri") f.gateway.uri = "poison";
    if (kind === "event") f.gateway.receipts.set(tx.hash, { ...receipt, logs: [] });
    if (kind === "duplicate") f.gateway.receipts.set(tx.hash, { ...receipt, logs: [...receipt.logs, ...receipt.logs] });
    assert.equal((await f.service.step("agent")).status, "blocked", kind);
    await f.restart().step("agent"); assert.equal(f.gateway.signed.length, 1, kind); assert.equal((await f.ledger.read()).transactions.length, 1);
  }
});
test("unfinalized and reorg receipts wait; receipt RPC unavailability never rebroadcasts", async () => {
  const f = fixture(); await f.service.discover(); await f.service.step("agent"); const state = await f.ledger.read(); const tx = state.transactions[0]!;
  await f.gateway.land(tx, state.jobs[0]!.initialUri); f.gateway.finalizedBlock = 89n;
  await f.service.step("agent"); assert.equal((await f.ledger.read()).jobs[0]!.mintedId, null);
  f.gateway.finalizedBlock = 100n; f.gateway.receipts.set(tx.hash, { ...f.gateway.receipts.get(tx.hash)!, blockHash: `0x${"bb".repeat(32)}` });
  await f.service.step("agent"); assert.equal((await f.ledger.read()).jobs[0]!.mintedId, null);
  f.gateway.failReceipt = true; await f.service.step("agent"); assert.equal(f.gateway.sent.length, 1);
});
test("finalized update survives failed source projection and retries only projection", async () => {
  const f = fixture(); await f.service.discover(); await f.service.step("agent"); let state = await f.ledger.read();
  await f.gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri); await f.service.step("agent"); await f.service.step("agent"); state = await f.ledger.read();
  await f.gateway.land(state.transactions[1]!, state.jobs[0]!.finalUri!); f.sources.projectionFails = true;
  assert.equal((await f.service.step("agent")).status, "blocked"); assert.equal((await f.ledger.read()).jobs[0]!.status, "registered");
  f.sources.projectionFails = false; await f.restart().discover(); assert.equal((await f.sources.get("agent"))!.existingId, "0");
  const revision = (await f.sources.get("agent"))!.identity;
  await f.restart().discover(); assert.deepEqual((await f.sources.get("agent"))!.identity, revision); assert.equal(f.gateway.signed.length, 2);
});
test("SQL crash during transaction insertion rolls back the envelope and nonce atomically", async () => {
  const f = fixture(true); await f.service.discover(); f.sql.failTag = "erc8004.txInsert";
  await f.service.step("agent"); const state = await f.ledger.read(); assert.equal(state.jobs[0]!.envelope, null); assert.equal(state.transactions.length, 0); assert.equal(state.nextNonce, null); assert.equal(f.gateway.sent.length, 0);
  await f.restart().step("agent"); assert.equal((await f.ledger.read()).transactions.length, 1);
});
test("corrupted stored calldata cannot be re-signed", async () => {
  const f = fixture(true); await f.service.discover(); await f.service.step("agent");
  const first = [...f.sql.txs.values()][0]!; first.intent = { ...(first.intent as object), data: "0x1234" as Hex };
  await assert.rejects(f.restart().step("agent"), /intent_mismatch/); assert.equal(f.gateway.signed.length, 1);
});
test("concurrent service preparations reserve one phase and one nonce", async () => {
  const f = fixture(); await f.service.discover();
  const second = new IdentityService(CONFIG, f.ledger, f.sources, f.gateway, new MemoryIdentityFence());
  await Promise.allSettled([f.service.step("agent"), second.step("agent")]);
  assert.equal((await f.ledger.read()).transactions.length, 1); assert.equal(f.gateway.signed.length, 1);
});
test("loss of minter lock after committed preparation preserves evidence and never broadcasts", async () => {
  const f = fixture(); await f.service.discover();
  const ledger = { read: () => f.ledger.read(), async atomic<T>(fence: Parameters<typeof f.ledger.atomic>[0], fn: (state: Awaited<ReturnType<typeof f.ledger.read>>) => T | Promise<T>) {
    const result = await f.ledger.atomic(fence, fn);
    if ((await f.ledger.read()).transactions.length > 0) await f.fence.close();
    return result;
  } };
  const service = new IdentityService(CONFIG, ledger, f.sources, f.gateway, f.fence);
  await assert.rejects(service.step("agent"), /lock_lost/);
  assert.equal((await f.ledger.read()).transactions.length, 1); assert.equal(f.gateway.sent.length, 0);
  await f.restart().step("agent"); assert.equal(f.gateway.sent.length, 1); assert.equal((await f.ledger.read()).transactions.length, 1);
});
test("full uint256 mint id is carried through exact update calldata without Number coercion", async () => {
  const f = fixture(); f.gateway.id = (2n ** 256n - 1n).toString(); await f.service.discover(); await f.service.step("agent");
  const state = await f.ledger.read(); await f.gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri); await f.service.step("agent"); await f.service.step("agent");
  assert.equal((await f.ledger.read()).jobs[0]!.mintedId, f.gateway.id); assert.equal(f.gateway.signed.length, 2);
});
test("Postgres ledger rejects corrupted terminal evidence, phases, envelopes and closed status fields", async () => {
  const f = fixture(true); await f.service.discover(); await f.service.step("agent"); let state = await f.ledger.read();
  await f.gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri); await f.service.step("agent"); await f.service.step("agent"); state = await f.ledger.read();
  await f.gateway.land(state.transactions[1]!, state.jobs[0]!.finalUri!); await f.service.step("agent");
  const jobs = structuredClone(f.sql.jobs); const txs = structuredClone(f.sql.txs);
  const mutators: ((job: Record<string, unknown>, tx: Record<string, unknown>) => void)[] = [
    (job) => { job.completedAt = null; },
    (_job, tx) => { tx.finalizedAt = null; tx.outcome = null; tx.blockNumber = null; tx.blockHash = null; },
    (_job, tx) => { tx.blockHash = "poison"; },
    (_job, tx) => { tx.blockNumber = "-1"; },
    (_job, tx) => { tx.outcome = "pending"; },
    (_job, tx) => { tx.intent = { ...(tx.intent as object), data: "0x1234" }; },
    (job) => { job.error = "secret-provider-message"; },
    (job) => { job.envelope = "10241"; },
    (job) => { job.status = "pending"; job.completedAt = null; },
    (job) => { job.status = "registering"; job.completedAt = null; },
  ];
  for (const mutate of mutators) {
    f.sql.jobs = structuredClone(jobs); f.sql.txs = structuredClone(txs);
    mutate([...f.sql.jobs.values()][0]!, [...f.sql.txs.values()][1]!);
    await assert.rejects(f.ledger.read(), /intent_mismatch/);
    await assert.rejects(f.restart().step("agent"), /intent_mismatch/);
    assert.equal(f.gateway.signed.length, 2);
  }
});
