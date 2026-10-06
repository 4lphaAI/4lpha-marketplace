/** AGENTIC-EARN-SPEC ET12 (+ R11.2, R11.7): `earn-once` (a dry run writes nothing; a live run needs gate EG1, side earn, an amount within the run's notional, --yes-live), the earn `dispose` branches with the attested waiver,
 *  and the E0 probe's one directory with a signout on success, on a refusal and on a throw. */
import assert from "node:assert/strict";
import test from "node:test";
import { BawRunner, type BawResult, type PreparedBaw } from "../src/agentic/baw.js";
import { runEarnOnce } from "../src/agentic/earnLane.js";
import { parseAgenticGateArgs, runAgenticGate, type AgenticGateContext } from "../scripts/agentic-gate.js";
import { runEarnProbe, type EarnProbeDeps } from "../scripts/agentic-earn-probe.js";
import type { AgenticGateRun } from "../src/agentic/domain.js";
import { E, MINUTE, NOW, W, earnWorld, tx, RECEIPT, USDT, POOL, ZERO, swapReceipt, type EarnWorld } from "./support/agenticEarn.js";

async function gate(w: EarnWorld, argv: string[], patch: Partial<AgenticGateContext> = {}, run: Partial<AgenticGateRun> = {}) {
  const created: AgenticGateRun = { runId: "run-1", gate: "EG1", agentId: w.f.agent.id, wallet: W, side: "earn", maxDispatches: 3, dispatches: 0, maxNotionalUsdt: "100", maxCmcPayments: 0, cmcPayments: 0,
    cmcOperationIds: [], deadlineMs: NOW + 3_600_000, createdAt: NOW, closedAt: null, ...run };
  if (await w.f.store.getRun("run-1") === null) await w.f.store.createRun(created);
  const printed: unknown[] = [];
  const context: AgenticGateContext = { store: w.f.store, agents: w.f.agents, journal: w.f.journal, positions: w.f.positions, killswitch: w.f.killswitch, runner: w.f.runner, chain: w.f.chain,
    masterKey: w.f.execution.masterKey, instance: w.f.instance, wallets: new Set([W]), cycle: async () => undefined, print: v => { printed.push(v); }, earnEnabled: true,
    async earnOnce(input) { return runEarnOnce({ ...w.stepDeps(), gateRunId: input.run.runId }, (await w.f.store.byAgent(input.agentId))!, input.once); }, ...patch };
  await runAgenticGate(parseAgenticGateArgs(argv), context);
  return printed;
}
const once = (extra: string[] = []) => ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "deposit", "--amount", "30", ...extra];

test("G1 earn-once: the options parse; an unknown option, a duplicate and a missing value are refused", () => {
  assert.deepEqual(parseAgenticGateArgs(once(["--yes-live"])).values, { run: "run-1", protocol: "venus", action: "deposit", amount: "30", "yes-live": "true" });
  assert.throws(() => parseAgenticGateArgs(["earn-once", "--agent", "x"]), /AGENTIC_GATE_ARGUMENT/u);
  assert.throws(() => parseAgenticGateArgs(["earn-once", "--run", "a", "--run", "b"]), /AGENTIC_GATE_ARGUMENT/u);
});

test("G2 a dry run reads the list and the preview and writes nothing; a live run dispatches the lane's own row under the run, bypassing only the sizing (the 20 USDT floor and the 24 h spacing)", async t => {
  const w = await earnWorld(t, { lane: "schedule", usdt: 40n * E });
  const dry = await gate(w, once(), {}, { maxDispatches: 10 });
  assert.equal((await w.rows()).length, 0, "nothing written");
  assert.equal(w.market.count("defi investment-list"), 1); assert.equal(w.market.count("defi preview"), 1); assert.equal(w.market.count("defi deposit"), 0);
  assert.equal((dry[0] as { result: { kind: string } }).result.kind, "dry");
  assert.equal((await w.f.store.getRun("run-1"))!.dispatches, 0);
  await gate(w, once(["--yes-live"]));
  const [row] = await w.rows();
  assert.deepEqual([row!.outcome, row!.amountAtomic, (row!.evidence as { reason: string }).reason], ["committed", (30n * E).toString(), "gate"]);
  assert.equal((await w.f.store.getRun("run-1"))!.dispatches, 1);
  await w.advance(MINUTE);
  await gate(w, ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "deposit", "--amount", "5", "--yes-live"]);
  assert.equal((await w.rows()).length, 2, "a 5 USDT deposit one minute later: the sizing floor and spacing are bypassed");
  await w.advance(MINUTE);
  await gate(w, ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "redeem", "--amount", "10", "--yes-live"]);
  await w.advance(MINUTE);
  await gate(w, ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "redeem-all", "--yes-live"]);
  assert.equal(w.state.venus, 0n);
  assert.deepEqual((await w.rows()).map(r => r.outcome), ["committed", "committed", "committed", "committed"]);
});

test("G3 every refusal happens before a command: wrong gate or side, an amount above the notional, a closed or expired run, a flag-off deposit, a bad protocol or action, redeem-all with an amount, an unconfigured product", async t => {
  const refusals: [string, string[], Partial<AgenticGateRun>?, Partial<AgenticGateContext>?][] = [
    ["wrong side", once(), { side: "buy" }], ["wrong gate", once(), { gate: "G0" }], ["above the notional", once(), { maxNotionalUsdt: "29.99" }],
    ["closed", once(), { closedAt: NOW }], ["expired", once(), { deadlineMs: NOW }], ["no dispatches left", once(), { maxDispatches: 0 }],
    ["bad protocol", ["earn-once", "--run", "run-1", "--protocol", "compound", "--action", "deposit", "--amount", "3"]],
    ["bad action", ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "supply", "--amount", "3"]],
    ["redeem-all with an amount", ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "redeem-all", "--amount", "3"]],
    ["zero amount", ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "deposit", "--amount", "0"]],
    ["flag-off deposit", once(), {}, { earnEnabled: false }], ["no run", ["earn-once", "--protocol", "venus", "--action", "deposit", "--amount", "3"]],
  ];
  for (const [label, argv, run, patch] of refusals) {
    const w = await earnWorld(t, { lane: "schedule", usdt: 40n * E });
    await assert.rejects(gate(w, [...argv, "--yes-live"], patch ?? {}, run ?? {}), /AGENTIC_GATE|agentic/u, label);
    assert.equal(w.market.calls.filter(c => c[0] === "defi").length, 0, label);
    assert.equal((await w.rows()).length, 0, label);
  }
  const plain = await earnWorld(t, { lane: "schedule", earn: false });
  await assert.rejects(gate(plain, [...once(), "--yes-live"]), /AGENTIC_GATE_EARN_NOT_ACTIVE/u);
  const unconfigured = await earnWorld(t, { lane: "schedule", products: [] });
  await assert.rejects(gate(unconfigured, [...once(), "--yes-live"]), /AGENTIC_GATE_EARN_PRODUCT/u);
  const redeemFlagOff = await earnWorld(t, { lane: "schedule", flag: false });
  redeemFlagOff.state.venus = 20n * E;
  await gate(redeemFlagOff, ["earn-once", "--run", "run-1", "--protocol", "venus", "--action", "redeem-all", "--yes-live"], { earnEnabled: false });
  assert.equal(redeemFlagOff.state.venus, 0n, "a redeem does not need the flag");
});

function planted(w: EarnWorld, patch: Partial<Awaited<ReturnType<EarnWorld["rows"]>>[number]> = {}) {
  return w.f.store.createOrder({ idempotencyKey: "earn:agentic-fixture:1", kind: "earn-deposit", walletAddress: W, agentId: w.f.agent.id, decisionId: null, side: null, fromToken: null, toToken: null, amountAtomic: (60n * E).toString(),
    intendedRaw: null, fromQty: "60", minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: null, walletNoncePre: "0",
    quoteAt: null, dispatch: "spawned", claimedAt: NOW, claimant: w.f.instance.row.instanceId, fenceToken: "1", claimDeadline: null, response: "no-response", cliResult: "timeout", returnedOrderId: null, listedOrderId: null,
    txHash: null, approveTxHash: null, outcome: "open", holdReason: "no-response", evidence: { v: 1, protocol: "venus", investmentId: "venus-usdt", receiptToken: RECEIPT.venus, reason: "lane", apyBps: null,
      pre: { block: "1", usdt: (100n * E).toString(), valueWei: "0", bnb: "0" } }, fillCheck: "none", createdAt: NOW, updatedAt: NOW, ...patch });
}
const dispose = (w: EarnWorld, extra: string[]) => gate(w, ["dispose", "--order", "earn:agentic-fixture:1", "--yes-live", ...extra], {}, {});

test("G4 dispose --commit-tx runs the lane's receipt verifier; a band-only failure needs --attest; --attest never waives the allowlist, the sender or the receipt token; --rollback needs --attest", async t => {
  const stranded = async (attest: boolean) => {
    const w = await earnWorld(t, { lane: "schedule" });
    await planted(w);
    w.state.venus = 30n * E; w.state.usdt = 40n * E; w.state.nonce = 1n;
    w.market.receipts.set(tx(7), swapReceipt(tx(7), [[USDT, W, POOL, 60n * E], [RECEIPT.venus, ZERO, W, 30n * E]]));
    const claimant = (await w.f.store.getOrder("earn:agentic-fixture:1"))!.claimant!;
    await w.f.store.retire(claimant, "exit");
    return { w, run: () => dispose(w, ["--commit-tx", tx(7), ...(attest ? ["--attest", "measured: debit 60, value 30"] : [])]) };
  };
  const strict = await stranded(false);
  await assert.rejects(strict.run(), /AGENTIC_EARN_UNVERIFIED/u, "the stranding band applies without --attest");
  const attested = await stranded(true);
  await attested.run();
  const row = (await attested.w.f.store.getOrder("earn:agentic-fixture:1"))!;
  assert.deepEqual([row.outcome, row.txHash, (row.evidence as { disposition: string }).disposition], ["committed", tx(7), "operator-commit"]);
  const bad = await earnWorld(t, { lane: "schedule" });
  await planted(bad);
  bad.market.receipts.set(tx(8), swapReceipt(tx(8), [[USDT, W, POOL, 60n * E], [RECEIPT.venus, POOL, bad.f.agent.id as never, 1n]]));
  await bad.f.store.retire((await bad.f.store.getOrder("earn:agentic-fixture:1"))!.claimant!, "exit");
  await assert.rejects(dispose(bad, ["--commit-tx", tx(8), "--attest", "x"]), /AGENTIC_EARN_UNVERIFIED/u, "no receipt token into the wallet: --attest does not waive it");
  const rb = await earnWorld(t, { lane: "schedule" });
  await planted(rb);
  await rb.f.store.retire((await rb.f.store.getOrder("earn:agentic-fixture:1"))!.claimant!, "exit");
  await assert.rejects(dispose(rb, ["--rollback"]), /AGENTIC_ATTESTATION_REQUIRED/u);
  await dispose(rb, ["--rollback", "--attest", "checked on chain"]);
  assert.equal((await rb.f.store.getOrder("earn:agentic-fixture:1"))!.outcome, "rolled-back");
  assert.equal(await rb.f.store.walletObligations(W), false);
});

class SpyRunner extends BawRunner {
  prepared: { directory: string; args: string[] }[] = [];
  closes = 0;
  failOn: string | null = null;
  address = "0x1111111111111111111111111111111111111111";
  constructor() { super("/never.cjs"); }
  override async prepare(args: readonly string[]): Promise<PreparedBaw> { return this.make("/tmp/earn-probe-dir", args, "ab".repeat(32)); }
  override async prepareInDirectory(directory: string, args: readonly string[], instanceId: string): Promise<PreparedBaw> { return this.make(directory, args, instanceId); }
  private make(directory: string, args: readonly string[], instanceId: string): PreparedBaw {
    this.prepared.push({ directory, args: [...args] });
    const start = async (): Promise<BawResult> => {
      const command = args.slice(0, 2).join(" ");
      if (this.failOn === command) throw new Error("boom");
      const ok = (data: unknown): BawResult => ({ kind: "ok", data, sessionPresent: true, rwaTokens: null });
      if (command === "auth signin") return ok({ qrCodeId: "qr", expireAt: String(Date.now() + 300_000), urlForWeb: "https://example.test/qr", pairingCode: "abcdef" });
      if (command === "auth verify") return ok({ status: "SUCCESS" });
      if (command === "wallet address") return ok({ addresses: [{ binanceChainId: "56", chainName: "BSC", address: this.address }] });
      if (command === "defi investment-list") return ok({ list: [{ investmentId: "venus-usdt", defiProtocolId: "venus", apyDisplay: "3.02%" }] });
      return ok({ answered: command });
    };
    return { directory, environment: { BINANCE_INSTANCE_ID: instanceId }, start, close: async () => { this.closes += 1; }, cancel: () => undefined };
  }
}
function probe(runner: SpyRunner, patch: Partial<EarnProbeDeps> = {}) {
  const printed: unknown[] = [], removed: string[] = [];
  const deps: EarnProbeDeps = { runner, hasLiveHire: async () => false, chain: { earnBalances: async () => ({ block: 1n, usdt: 0n, vBalance: 0n, vRate: E, venusWei: 0n, aaveWei: 0n }), earnPins: async () => ({ venus: true, "aave-v3": true }) },
    print: v => { printed.push(v); }, remove: async d => { removed.push(d); }, ...patch };
  return { deps, printed, removed };
}
const W1 = "0x1111111111111111111111111111111111111111" as const;
const signouts = (r: SpyRunner) => r.prepared.filter(p => p.args.join(" ") === "auth signout").length;

test("G5 the E0 probe holds one directory, never closes the signin command, signs out and removes the directory once on success; every command is on the runner allowlist and read-only", async () => {
  const runner = new SpyRunner(), { deps, printed, removed } = probe(runner);
  await runEarnProbe(deps, W1);
  assert.deepEqual([...new Set(runner.prepared.map(p => p.directory))], ["/tmp/earn-probe-dir"], "one directory for the whole run");
  assert.equal(runner.closes, 0, "no command closes (close removes the directory)");
  assert.deepEqual([signouts(runner), removed], [1, ["/tmp/earn-probe-dir"]]);
  const commands = runner.prepared.map(p => p.args.slice(0, 2).join(" "));
  for (const needed of ["auth signin", "auth verify", "wallet address", "wallet settings", "defi investment-list", "defi investment-info", "defi position", "defi preview", "auth signout"]) assert.ok(commands.includes(needed), needed);
  assert.ok(!commands.some(c => ["defi deposit", "defi redeem", "defi claim", "market-order swap", "x402-payment sign"].includes(c)), "read-only");
  const previews = runner.prepared.filter(p => p.args[1] === "preview").map(p => p.args.join(" "));
  assert.equal(previews.length, 3);
  assert.ok(previews.some(p => p.includes("--action deposit") && p.includes("--amount 1")) && previews.some(p => p.includes("--action redeem") && p.includes("--ratio 1")));
  assert.ok(printed.some(p => (p as { label?: string }).label === "chain pins (rule 6)"));
});

test("G6 the probe signs out on a refusal (a different paired address) and on a throw (a command fails), and refuses before any pairing when the wallet has a live hire", async () => {
  const mismatch = new SpyRunner(); mismatch.address = "0x2222222222222222222222222222222222222222";
  const a = probe(mismatch);
  await assert.rejects(runEarnProbe(a.deps, W1), /AGENTIC_PROBE_WALLET_MISMATCH/u);
  assert.deepEqual([signouts(mismatch), a.removed.length], [1, 1]);
  assert.ok(!mismatch.prepared.some(p => p.args[0] === "defi"), "nothing is read from a wallet that is not the one named");
  const throwing = new SpyRunner(); throwing.failOn = "defi position";
  const b = probe(throwing);
  await assert.rejects(runEarnProbe(b.deps, W1), /boom/u);
  assert.deepEqual([signouts(throwing), b.removed.length], [1, 1]);
  const live = new SpyRunner(), c = probe(live, { hasLiveHire: async () => true });
  await assert.rejects(runEarnProbe(c.deps, W1), /AGENTIC_PROBE_WALLET_IN_USE/u);
  assert.equal(live.prepared.length, 0, "no pairing, no command, nothing to sign out");
  assert.equal(c.removed.length, 0);
});

test("G7 audit M-2: earn-once deposit keeps rule 15's BNB floor (0.0012); a redeem needs none here", async t => {
  const low = await earnWorld(t, { lane: "schedule", usdt: 40n * E, bnb: 1_200_000_000_000_000n - 1n });
  await assert.rejects(gate(low, [...once(), "--yes-live"]), /AGENTIC_GATE_LOW_BNB/u);
  assert.equal(low.market.calls.filter(c => c[0] === "defi").length, 0);
  assert.equal((await low.rows()).length, 0);
  const ok = await earnWorld(t, { lane: "schedule", usdt: 40n * E, bnb: 1_200_000_000_000_000n });
  await gate(ok, [...once(), "--yes-live"]);
  assert.equal((await ok.rows()).length, 1);
});

test("AGENTIC-RECEIPT-WAIT-2 B: dispose resolves a receipt-missing earn row exactly as before", async t => {
  const parked = async () => {
    const w = await earnWorld(t, { lane: "schedule" });
    await planted(w, { response: "accepted", cliResult: "accepted", holdReason: "receipt-missing", txHash: tx(7) });
    w.state.venus = 30n * E; w.state.usdt = 40n * E; w.state.nonce = 1n;
    w.market.receipts.set(tx(7), swapReceipt(tx(7), [[USDT, W, POOL, 60n * E], [RECEIPT.venus, ZERO, W, 30n * E]]));
    return w;
  };
  const strict = await parked();
  await assert.rejects(dispose(strict, ["--commit-tx", tx(7)]), /AGENTIC_EARN_UNVERIFIED/u, "the stranding band applies without --attest");
  assert.equal((await strict.f.store.getOrder("earn:agentic-fixture:1"))!.holdReason, "receipt-missing");
  const attested = await parked();
  await dispose(attested, ["--commit-tx", tx(7), "--attest", "measured: debit 60, value 30"]);
  const row = (await attested.f.store.getOrder("earn:agentic-fixture:1"))!;
  assert.deepEqual([row.outcome, row.txHash, (row.evidence as { disposition: string }).disposition], ["committed", tx(7), "operator-commit"]);
  const rb = await parked();
  await dispose(rb, ["--rollback", "--attest", "checked on chain"]);
  assert.equal((await rb.f.store.getOrder("earn:agentic-fixture:1"))!.outcome, "rolled-back");
  assert.equal(await rb.f.store.walletObligations(W), false);
});
