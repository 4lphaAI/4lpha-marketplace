/**
 * The quant operator CLI (QUANT-GRID §8, R2.10, R4.2, R6.1, R7.3).
 *
 * EVERY SPENDING PATH IS GATED ON `--yes-live`, and `worker` REHEARSES by
 * default (`--dry-run` is implied unless `--yes-live` is passed) — the
 * `live-lending` shape, for the same reason: the difference between a rehearsal
 * and a mainnet submission must be a word the operator typed, never a default.
 *
 * NOTHING here reads `.env.local`'s owner key except `self-test grant`, which
 * is an explicit per-run go under the existing memory rule
 * (`env-local-owner-wallet-live-lp-tests`).
 *
 * Subcommands:
 *   keypair              print OUR X25519 public key (no spend)
 *   register-key         POST it to TermiX                       §10 gate 2
 *   config-check         the §2.1 + §4.3 checks, with the diff
 *   status               jobs, levels, actions, holds, journal, indexer
 *   self-test            the mainnet proof, end to end            §10 gate 1
 *   seal                 our seal, the test-only twin of theirs
 *   worker               one cycle (rehearses unless --yes-live)
 *   pause / resume       store status only — the honest half
 *   resolve              --calls-id-read | --tx <hash>           evidence only
 *   retire-level         the ONLY release for an unresolvable action
 *   acknowledge-external rebase | retire, after `external-activity`
 *   report               send the term-end notes now
 */
import { BNB } from "@altananetwork/sdk";
import { getAddress, type Hex } from "viem";
import { sanitizeMessage } from "../src/core/errors.js";
import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import {
  resolveQuantEnabled,
  resolveQuantRuntimeConfig,
  type QuantRuntimeConfig,
} from "../src/quant/config.js";
import { seal, QUANT_ENVELOPE_ALGORITHM } from "../src/quant/envelope.js";
// R3.11 / BC11: a composition root imports NEITHER secret primitive. The
// wrapper lives in `src/quant/execute.ts`, one of the two files the capability
// scan permits to name `deriveKeypair`.
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { createQuantChainReader, type QuantChainReader } from "../src/quant/readers.js";
import { assertOrchestratorPin } from "../src/quant/receipt.js";
import { HttpQuantTransport, type QuantTransport } from "../src/quant/termix.js";
import {
  FileQuantTransport,
  QUANT_SELF_TEST_STRATEGY_ID,
  claimSelfTestFile,
  quantSelfTestSessionSpec,
  releaseSelfTestClaim,
  serializeGrantedSession,
  writeSelfTestFile,
  type QuantSelfTestFile,
} from "../src/quant/selftest.js";
import { armFloor, buildLadder, midFromReserves } from "../src/quant/grid.js";
import { assertQuantSessionAdmissible, parseSessionPlaintext, projectGrantedPermissions } from "../src/quant/admission.js";
import { agentAuthorityFromPrivateKey, ownerAuthorityFromPrivateKey } from "../src/wallet/altana.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync } from "node:fs";
import { retirementAllowed, verifyAndSettle, type QuantReconcileDeps } from "../src/quant/reconcile.js";
import { createQuantJobStore, type QuantJobStore } from "../src/store/quantJobs.js";
import { createJournal, type ExecutionJournal } from "../src/store/journal.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import { KEYSTORE_ABI } from "../src/wallet/abis.js";
import { createPublicClient, fallback, http } from "viem";
import { bsc } from "viem/chains";

type Args = {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
};

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith("--")) {
    throw new Error("A subcommand is required. Run `live-quant help`.");
  }
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index];
    if (raw === undefined || !raw.startsWith("--")) {
      throw new Error(`Unexpected argument: ${raw ?? ""}.`);
    }
    const equals = raw.indexOf("=");
    const name = raw.slice(2, equals < 0 ? undefined : equals);
    if (equals >= 0) { flags.set(name, raw.slice(equals + 1)); continue; }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) { flags.set(name, true); continue; }
    flags.set(name, next);
    index += 1;
  }
  return { command, flags };
}

function flagString(args: Args, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
}

function requireFlag(args: Args, name: string): string {
  const value = flagString(args, name);
  if (value === null) throw new Error(`--${name} is required.`);
  return value;
}

function yesLive(args: Args): boolean {
  return args.flags.get("yes-live") === true;
}

type Context = {
  readonly config: QuantRuntimeConfig;
  readonly store: QuantJobStore;
  readonly journal: ExecutionJournal;
  readonly transport: QuantTransport;
  readonly reader: QuantChainReader;
  readonly provider: AltanaProvider;
  close(): Promise<void>;
};

async function openContext(): Promise<Context> {
  if (!resolveQuantEnabled(process.env)) {
    throw new Error("QUANT_ENABLED is off; this CLI drives the quant plane only when it is on.");
  }
  const config = resolveQuantRuntimeConfig(process.env, { publicRpcUrl: BNB.publicRpcUrl });
  const store = await createQuantJobStore();
  const journal = await createJournal();
  // R2.10: the self-test file transport and the production HTTPS transport are
  // selected by config, which already refused any process that has both.
  const transport: QuantTransport = config.selfTestFile === null
    ? new HttpQuantTransport({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey })
    : new FileQuantTransport(config.selfTestFile, { u: config.u, wbnb: config.wbnb, router: config.router });
  const reader = createQuantChainReader({ rpcUrls: config.rpcUrls });
  const provider = new AltanaProvider({ network: BNB, rpcUrls: [...config.rpcUrls] });
  return {
    config, store, journal, transport, reader, provider,
    async close() {
      for (const closable of [store, journal]) {
        try { await closable.close(); } catch { /* independent close */ }
      }
    },
  };
}

function reconcileDeps(context: Context): QuantReconcileDeps {
  return {
    store: context.store,
    journal: context.journal,
    provider: context.provider,
    reader: context.reader,
    params: context.config.params,
    venue: {
      router: context.config.router, u: context.config.u,
      wbnb: context.config.wbnb, pair: context.config.pair,
    },
    nowMs: Date.now,
  };
}

/* -------------------------------------------------------------------------- */
/* Subcommands                                                                */
/* -------------------------------------------------------------------------- */

async function commandKeypair(): Promise<void> {
  const seed = process.env["QUANT_ENVELOPE_KEY"]?.trim() ?? "";
  if (seed === "") throw new Error("QUANT_ENVELOPE_KEY is required.");
  const keypair = quantKeypairFromSeed(seed);
  // The PUBLIC half only. The seed is never echoed, by this command or any
  // other, and this line is the entire intended output of the subcommand.
  console.log(`encryptionPublicKey (base64): ${keypair.publicKey.toString("base64")}`);
  console.log(`algorithm:                    ${QUANT_ENVELOPE_ALGORITHM}`);
}

async function commandRegisterKey(args: Args, context: Context): Promise<void> {
  const agentId = flagString(args, "agent") ?? context.config.agentId;
  const keypair = quantKeypairFromSeed(context.config.envelopeKey);
  const local = context.config.selfTestFile !== null;
  console.log(
    (local
      ? `About to write our encryption key into the LOCAL self-test file for agent ${agentId} (NOT TermiX).\n`
      : `About to REGISTER our encryption key with TermiX for agent ${agentId}.\n`)
    + `  key:       ${keypair.publicKey.toString("base64")}\n`
    + `  algorithm: ${QUANT_ENVELOPE_ALGORITHM}\n`
    + (local
      ? "  Self-test mode: nothing leaves this machine."
      : "  This is §10 gate 2. It spends nothing on chain, and it is visible to TermiX."),
  );
  if (!yesLive(args)) {
    console.log("Rehearsal only. Pass --yes-live to register.");
    return;
  }
  const result = await context.transport.registerKey({
    agentId,
    encryptionPublicKey: keypair.publicKey.toString("base64"),
    algorithm: QUANT_ENVELOPE_ALGORITHM,
  });
  console.log(result.ok
    ? (context.config.selfTestFile === null ? "registered with TermiX" : `registered in the LOCAL self-test file ${context.config.selfTestFile} (not TermiX)`)
    : `refused: ${result.code}`);
}

async function commandConfigCheck(context: Context): Promise<void> {
  assertOrchestratorPin(PORTO_V055_ORCHESTRATOR);
  const block = await context.transport.config();
  if (!block.ok) { console.log(`config: unavailable (${block.code})`); return; }
  const lines = [
    `chainId          ${block.data.chainId} (expect 56)`,
    `U                ${block.data.u} (expect ${context.config.u})`,
    `tradable         ${block.data.tradableTokens.map((token) =>
      `${token.address}:${token.priceRoute}`).join(", ")} (expect ${context.config.wbnb}:direct)`,
    `venueAllowlist   ${block.data.venueAllowlist.join(", ")} (expect includes ${context.config.router})`,
  ];
  const pair = await context.reader.getPair(
    context.config.factory, context.config.u, context.config.wbnb,
  );
  lines.push(`factory getPair  ${pair} (expect ${context.config.pair})`);
  const chainId = await context.reader.chainId();
  lines.push(`rpc chainId      ${chainId} (expect 56)`);
  lines.push(`orchestrator     ${PORTO_V055_ORCHESTRATOR}`);
  lines.push(`paramsDigest     ${context.config.paramsDigest}`);
  for (const line of lines) console.log(line);
}

async function commandStatus(args: Args, context: Context): Promise<void> {
  const only = flagString(args, "job");
  const jobs = await context.store.listJobs();
  for (const job of jobs) {
    if (only !== null && job.quantJobId !== only) continue;
    console.log(
      `\njob ${job.quantJobId}  status=${job.status}  hold=${job.holdCode ?? "-"}\n`
      + `  wallet=${job.tradingWallet} allocation=${job.allocationUWei} `
      + `dailyCap=${job.dailyCapUWei} levels=${job.levels} clip=${job.clipUWei} `
      + `idle=${job.idleUWei}\n`
      + `  P0=${job.p0E18} armBlock=${job.armBlock ?? "-"} `
      + `lastObserved=${job.lastObservedBlock ?? "-"} stale=${job.staleObservations}\n`
      + `  wbnbCapMin=${job.wbnbCapMinLimitWei} residualThreshold=${job.residualThresholdWei}`,
    );
    for (const level of await context.store.listLevels(job.quantJobId)) {
      console.log(
        `  level ${level.levelIndex} ${level.state}`
        + ` buy=${level.buyPriceE18} sell=${level.sellPriceE18}`
        + ` base=${level.baseWei} basis=${level.basisUWei}`
        + ` cycles=${level.cyclesClosed} realized=${level.realizedUWei}`
        + ` residual=${level.residualWei} hold=${level.holdCode ?? "-"}`,
      );
    }
    for (const action of await context.store.listActions(job.quantJobId)) {
      const entry = await context.journal.get(action.journalKey);
      console.log(
        `  action ${action.side} L${action.levelIndex}#${action.actionSeq}`
        + ` ${action.state} journal=${entry?.state ?? "-"}`
        + ` amountIn=${action.amountInWei} minOut=${action.minOutWei}`
        + ` tx=${action.txHash ?? "-"} code=${action.failureCode ?? "-"}`,
      );
    }
    // Three SEPARATE numbers, never merged (R2.4): ours, theirs, and gas.
    const indexer = await context.store.listIndexerTrades(job.quantJobId);
    console.log(`  indexer trades recorded (display only): ${indexer.length}`);
  }
  if (jobs.length === 0) console.log("no quant jobs");
}

async function commandWorker(args: Args, context: Context): Promise<void> {
  const live = yesLive(args);
  console.log(
    live
      ? "Running ONE LIVE cycle. This can submit a mainnet transaction from the client's wallet."
      : "Rehearsing one cycle (dry-run). Pass --yes-live to submit.",
  );
  // The CLI takes the SAME singleton role as the daemon, so "one replica" and
  // "no concurrent CLI" are one guarantee rather than two (R2.13).
  const { acquireWorkerSingleton } = await import("../src/deployment/workerSingleton.js");
  const lease = await acquireWorkerSingleton({
    role: "quant-worker", databaseUrl: context.config.databaseUrl,
  });
  if (lease.kind !== "acquired") throw new Error("the quant singleton is already held.");
  try {
    const { runQuantWorkerOnce } = await import("../src/quant/worker.js");
    const { assertQuantBoot, buildWorkerDeps } = await import("./quantWorkerDeps.js");
    // The SAME boot assertions the daemon runs (QUANT-SELFTEST R5).
    await assertQuantBoot({
      transport: context.transport, reader: context.reader, config: context.config,
      keypair: quantKeypairFromSeed(context.config.envelopeKey),
      provider: context.provider,
    });
    const deps = await buildWorkerDeps(context, lease.fence.signal);
    const report = await runQuantWorkerOnce(deps, { dryRun: !live });
    console.log(
      `jobs=${report.jobsSeen} actions=${report.actions} holds=${report.holds} `
      + `errors=${report.errors}\n${report.notes.join("\n")}`,
    );
  } finally {
    try { await lease.closeGracefully(); } catch { /* the lock dies with us */ }
  }
}

async function commandPauseResume(args: Args, context: Context, paused: boolean): Promise<void> {
  const jobId = requireFlag(args, "job");
  const job = await context.store.getJob(jobId);
  if (job === null) throw new Error("no such job.");
  await context.store.setJobStatus({
    quantJobId: jobId,
    status: paused ? "paused" : (job.admittedAtMs === null ? "discovered" : "armed"),
    nowMs: Date.now(),
  });
  // The HONEST sentence: this is a server-side refusal. It stops INTENTS.
  // Reconciliation and the balance checks continue, and `resume` re-arms
  // nothing — levels keep their state (R2.5).
  console.log(
    paused
      ? "paused: no new intents. Reconciliation and balance checks continue. "
        + "This is a server-side refusal, not an on-chain stop — the client's own "
        + "revoke is the hard one."
      : "resumed: levels keep the state they had; nothing is re-armed.",
  );
}

async function commandResolve(args: Args, context: Context): Promise<void> {
  const journalKey = requireFlag(args, "action");
  const action = await context.store.getAction(journalKey);
  if (action === null) throw new Error("no such action.");
  const job = await context.store.getJob(action.quantJobId);
  if (job === null) throw new Error("no such job.");
  const deps = reconcileDeps(context);

  if (args.flags.get("calls-id-read") === true) {
    const entry = await context.journal.get(journalKey);
    const callsId = entry?.externalRef.callsId;
    if (callsId === undefined) { console.log("refused: the journal has no callsId."); return; }
    if (context.provider.readExecutionStatus === undefined) {
      console.log("refused: this provider cannot read a relay status."); return;
    }
    const reading = await context.provider.readExecutionStatus({ callsId });
    console.log(`relay status: ${reading.rawStatus}`);
    const txHash = reading.receipt.transactionHash;
    if (reading.receipt.status !== "CONFIRMED" || txHash === undefined) {
      // ONLY a CONFIRMED+hash answer proceeds. Everything else — an unmapped
      // status, an error, an absent reader — records what was seen and changes
      // nothing (PHASE3.14's rule, one layer up).
      console.log("refused: only a CONFIRMED answer with a transaction hash proceeds.");
      return;
    }
    const verdict = await verifyAndSettle(deps, job, action, txHash);
    console.log(verdict.ok ? `settled ${txHash}` : `refused: ${verdict.code}`);
    return;
  }

  const txFlag = flagString(args, "tx");
  if (txFlag !== null) {
    if (!/^0x[0-9a-fA-F]{64}$/u.test(txFlag)) throw new Error("--tx must be a 32-byte hash.");
    // R4.1 + R7.1: the receipt is accepted ONLY when the decoded intent's
    // calldata is BYTE-EQUAL to this action's and the orchestrator's own
    // `IntentExecuted` says it succeeded. The `minOut` tag and the per-level
    // deadline make that identity unique per intent by construction.
    const verdict = await verifyAndSettle(deps, job, action, txFlag.toLowerCase() as Hex);
    console.log(verdict.ok ? `settled ${txFlag}` : `refused: ${verdict.code}`);
    return;
  }
  throw new Error("resolve requires --calls-id-read or --tx <hash>.");
}

async function commandRetireLevel(args: Args, context: Context): Promise<void> {
  const jobId = requireFlag(args, "job");
  const levelIndex = Number(requireFlag(args, "level"));
  const job = await context.store.getJob(jobId);
  if (job === null) throw new Error("no such job.");
  const actions = await context.store.listNonTerminalActions(jobId);
  const blocking = actions.find((action) => action.levelIndex === levelIndex);
  if (blocking === undefined) {
    console.log("refused: this level has no unresolved action, so nothing needs retiring.");
    return;
  }
  const finalized = await context.reader.finalizedBlock();
  const publicClient = createPublicClient({
    chain: bsc, transport: fallback(context.config.rpcUrls.map((url) => http(url))),
  });
  const { publicKeyToAddress } = await import("viem/accounts");
  const { accountKeyHashForAddress } = await import("../src/wallet/altana.js");
  if (job.sessionPublicKey === null) throw new Error("the job has no admitted session key.");
  const keyHash = accountKeyHashForAddress(publicKeyToAddress(job.sessionPublicKey));
  const keyIsValid = await publicClient.readContract({
    address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI, functionName: "isValidKey",
    args: [getAddress(job.tradingWallet), keyHash],
  });
  const allowed = await retirementAllowed({
    action: blocking,
    keyIsValid,
    sessionExpiry: job.sessionExpiry,
    finalizedTimestampSec: finalized.timestampSec,
  });
  console.log(`precondition: ${allowed.reason}`);
  if (!allowed.allowed) {
    console.log(
      "refused. Retirement needs BOTH: the key dead on chain, and the action's router "
      + "deadline passed at a finalized block. Until then the level stays blocked — that "
      + "is the fail-closed price of not double-buying (R6.1).",
    );
    return;
  }
  if (!yesLive(args)) {
    console.log("Rehearsal only. Retirement is PERMANENT. Pass --yes-live to retire.");
    return;
  }
  const wallet = getAddress(job.tradingWallet);
  const [u, wbnb, native] = await Promise.all([
    context.reader.tokenBalanceAt(context.config.u, wallet, finalized.number),
    context.reader.tokenBalanceAt(context.config.wbnb, wallet, finalized.number),
    context.reader.nativeBalanceAt(wallet, finalized.number),
  ]);
  const level = (await context.store.listLevels(jobId))
    .find((row) => row.levelIndex === levelIndex);
  const result = await context.store.retireLevel({
    quantJobId: jobId,
    levelIndex,
    // HISTORY, never arithmetic: nothing here is added to any baseline (R7.3).
    retiredJson: JSON.stringify({
      v: 1,
      baseWei: (level?.baseWei ?? 0n).toString(10),
      basisUWei: (level?.basisUWei ?? 0n).toString(10),
      entryCostUWei: (level?.entryCostUWei ?? 0n).toString(10),
      unresolvedAmountInWei: blocking.amountInWei.toString(10),
      unresolvedJournalKey: blocking.journalKey,
      finalizedBlock: finalized.number.toString(10),
    }),
    epoch: {
      startedBlock: finalized.number,
      startedBlockHash: finalized.hash,
      baselineUWei: u,
      baselineWbnbWei: wbnb,
      baselineNativeWei: native,
      note: `retire-level:${levelIndex}`,
    },
    nowMs: Date.now(),
  });
  console.log(
    result.kind === "ok"
      ? `retired level ${levelIndex} at finalized block ${finalized.number}. `
        + "Its U reservation is held to deadline + 24 h; a later positive resolution "
        + "records the fill on the action row and changes nothing else."
      : "refused: the level moved under us.",
  );
}

async function commandAcknowledgeExternal(args: Args, context: Context): Promise<void> {
  const jobId = requireFlag(args, "job");
  const mode = requireFlag(args, "mode");
  if (mode !== "rebase" && mode !== "retire") {
    throw new Error("--mode must be `rebase` or `retire`.");
  }
  const job = await context.store.getJob(jobId);
  if (job === null) throw new Error("no such job.");
  if (mode === "retire") {
    if (!yesLive(args)) { console.log("Rehearsal only. Pass --yes-live to stop the job."); return; }
    await context.store.setJobStatus({ quantJobId: jobId, status: "paused", nowMs: Date.now() });
    console.log("job stopped: no new intents. Inventory stays in the client's wallet.");
    return;
  }
  const finalized = await context.reader.finalizedBlock();
  const wallet = getAddress(job.tradingWallet);
  const [u, wbnb, native] = await Promise.all([
    context.reader.tokenBalanceAt(context.config.u, wallet, finalized.number),
    context.reader.tokenBalanceAt(context.config.wbnb, wallet, finalized.number),
    context.reader.nativeBalanceAt(wallet, finalized.number),
  ]);
  console.log(
    `rebase at finalized block ${finalized.number}: U=${u} WBNB=${wbnb} native=${native}\n`
    + "Level ownership, base, basis, realized and unresolved reservations are UNTOUCHED "
    + "(R3.10); only the baseline the expected-balance check measures against moves.",
  );
  if (!yesLive(args)) { console.log("Rehearsal only. Pass --yes-live to open the epoch."); return; }
  const epoch = await context.store.openEpoch({
    quantJobId: jobId,
    startedBlock: finalized.number,
    startedBlockHash: finalized.hash,
    baselineUWei: u,
    baselineWbnbWei: wbnb,
    baselineNativeWei: native,
    note: "acknowledge-external:rebase",
    nowMs: Date.now(),
  });
  await context.store.setJobStatus({
    quantJobId: jobId, status: "armed", holdCode: null, nowMs: Date.now(),
  });
  console.log(`epoch ${epoch.epoch} opened.`);
}

async function commandReport(args: Args, context: Context): Promise<void> {
  const jobId = requireFlag(args, "job");
  const actions = await context.store.listActions(jobId);
  const trades = actions
    .filter((action) => action.state === "settled" && action.txHash !== null)
    .map((action) => ({ txHash: action.txHash as Hex, note: action.note.slice(0, 2_000) }));
  console.log(`about to report ${trades.length} settled trades for ${jobId}.`);
  if (!yesLive(args)) { console.log("Rehearsal only. Pass --yes-live to send."); return; }
  const response = await context.transport.report(jobId, { trades });
  console.log(response.ok ? `accepted: ${response.data.status}` : `refused: ${response.code}`);
  await context.store.recordReport({
    quantJobId: jobId,
    payloadDigest: `0x${"0".repeat(64)}` as Hex,
    responseStatus: response.ok ? 200 : 0,
    notesApplied: response.ok ? response.data.notesApplied : null,
    nowMs: Date.now(),
  });
}

async function commandSeal(args: Args): Promise<void> {
  const recipient = requireFlag(args, "recipient");
  const { readFile, writeFile } = await import("node:fs/promises");
  const input = requireFlag(args, "in");
  const output = requireFlag(args, "out");
  const plaintext = await readFile(input, "utf8");
  const envelope = seal(plaintext, Buffer.from(recipient, "base64"));
  await writeFile(output, JSON.stringify(envelope, null, 2), "utf8");
  console.log(`sealed to ${output}`);
}

/* -------------------------------------------------------------------------- */
/* Gate 1 — the mainnet self-test (R2.10 / R3.7)                              */
/* -------------------------------------------------------------------------- */

/**
 * `self-test --allocation-u <U> [--term-days 2] [--yes-live]`
 *
 * Grants a session in the WIZARD'S SHAPE from the operator wallet to a fresh
 * throwaway agent key, serializes it IN MEMORY in the SDK's shape, seals it to
 * OUR public key, and writes only the CIPHERTEXT plus the public job record to
 * `QUANT_SELF_TEST_FILE`. The worker then discovers it exactly as it would a
 * TermiX envelope. No forced observation exists anywhere on this path (R3.7):
 * the buy and the sell wait for the real price.
 *
 * The owner key is read from the env var named by `QUANT_SELFTEST_OWNER_KEY_VAR`
 * (default `USER1_PRIVATE_KEY`, the live-lp convention). It signs the grant and
 * nothing else; it is never echoed. The throwaway agent key exists only inside
 * this call: it goes into the plaintext, the plaintext is sealed, and both are
 * dropped.
 */
async function commandSelfTest(args: Args, context: Context): Promise<void> {
  const { config } = context;
  if (config.selfTestFile === null) {
    throw new Error("self-test needs QUANT_SELF_TEST_FILE set (and QUANT_API_KEY unset).");
  }
  const allocationU = flagString(args, "allocation-u") ?? "10";
  if (!/^[0-9]+(\.[0-9]{1,18})?$/u.test(allocationU)) {
    throw new Error("--allocation-u must be a decimal U amount.");
  }
  const [whole, frac = ""] = allocationU.split(".");
  const allocationUWei =
    BigInt(whole ?? "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
  if (allocationUWei < config.params.minClipUWei) {
    throw new Error("--allocation-u is below the minimum clip.");
  }
  const termDays = Number(flagString(args, "term-days") ?? "2");
  if (!Number.isInteger(termDays) || termDays < 1 || termDays > 7) {
    throw new Error("--term-days must be an integer 1..7.");
  }
  if (existsSync(config.selfTestFile)) {
    throw new Error("The self-test file already exists; refusing to overwrite a job that may be live.");
  }

  const ownerVar = process.env["QUANT_SELFTEST_OWNER_KEY_VAR"]?.trim() || "USER1_PRIVATE_KEY";
  const ownerKey = process.env[ownerVar]?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/u.test(ownerKey)) {
    throw new Error(`No owner key: ${ownerVar} is unset or malformed. This command never generates one.`);
  }
  const owner = ownerAuthorityFromPrivateKey(ownerKey as Hex);
  const wallet = await context.provider.resolveOwnerWallet({ owner });

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expiresAt = nowSeconds + termDays * 86_400;
  const fee = config.params.relayFeePerSubmitWei;
  // Caps in the wizard's shape. U: the allocation (at most one day of buys).
  // WBNB: four times the worst-case base at the deepest level, so R5.4's
  // chunk inequality is comfortably met. Native: twelve padded relay fees.
  const latest = await context.reader.latestBlockNumber();
  const reserves = await context.reader.reservesAt(config.pair, latest);
  const wbnbIsToken0 = getAddress(reserves.token0) === getAddress(config.wbnb);
  const mid = midFromReserves(
    wbnbIsToken0 ? reserves.reserve1 : reserves.reserve0,
    wbnbIsToken0 ? reserves.reserve0 : reserves.reserve1,
  );
  // The REAL ladder (compounded, actual level count), not a linear guess.
  const ladderResult = buildLadder({ allocationUWei, p0E18: mid, params: config.params });
  if (!ladderResult.ok) throw new Error(`The ladder cannot be built: ${ladderResult.code}.`);
  const ladder = ladderResult.ladder;
  const deepest = ladder.buyPrice[ladder.levels] ?? 0n;
  if (deepest <= 0n) throw new Error("The ladder would reach a zero price; lower maxLevels or the band.");
  const worstBase = (ladder.clipUWei * 10n ** 18n) / deepest;
  const wbnbDayCapWei = worstBase * 4n;
  const nativeDayCapWei = fee * 3n * 12n;
  // The arm floor at impact 0 (the worker measures impact itself at arm).
  const floor = armFloor({ clipUWei: ladder.clipUWei, midE18: mid, impactBps: 0n, params: config.params });
  const spec = quantSelfTestSessionSpec({
    router: config.router, u: config.u, wbnb: config.wbnb,
    uDayCapWei: allocationUWei, wbnbDayCapWei, nativeDayCapWei,
    expiresAt, nowSeconds, walletAddress: wallet.address,
  });
  const keypair = quantKeypairFromSeed(config.envelopeKey);
  const jobId = `selftest-${nowSeconds}`;
  // R3: the throwaway agent key is generated BEFORE the rehearsal so the exact
  // session the grant would produce can be projected and ADMITTED by the
  // production predicate first. It lives only in this call.
  const agentKey = generatePrivateKey();
  const agent = agentAuthorityFromPrivateKey(agentKey);
  const rehearsal = parseSessionPlaintext(serializeGrantedSession({
    walletAddress: wallet.address,
    publicKey: privateKeyToAccount(agentKey).publicKey,
    expiry: expiresAt,
    permissions: {
      calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }), ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
      spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }), limit: cap.limit, period: cap.period })),
    },
    privateKey: agentKey,
  }));
  if (!rehearsal.ok) throw new Error(`The proposed session does not parse: ${rehearsal.code}.`);
  const projection = projectGrantedPermissions(rehearsal.session.permissions, {
    expiry: expiresAt, nowSeconds, termDays, walletAddress: wallet.address,
  });
  if (!projection.ok) throw new Error(`The proposed session does not project: ${projection.code}.`);
  const admission = assertQuantSessionAdmissible({
    session: rehearsal.session, spec: projection.spec,
    job: { tradingWalletAddress: wallet.address, sessionExpiresAtMs: expiresAt * 1_000 },
    router: config.router, u: config.u, wbnb: config.wbnb, params: config.params,
    ladder: { ...ladder, midE18: mid }, nowSeconds,
  });
  console.log(
    "About to GRANT a self-test session from the operator wallet (costs gas).\n"
    + `  wallet:      ${wallet.address}\n`
    + `  allocation:  ${allocationU} U · daily cap ${allocationU} U · term ${termDays} d\n`
    + `  mid:         ${mid.toString(10)} (U wei per WBNB)\n`
    + `  caps/day:    U ${allocationUWei.toString(10)} · WBNB ${wbnbDayCapWei.toString(10)} · native ${nativeDayCapWei.toString(10)} wei\n`
    + `  ladder:      ${ladder.levels} level(s), clip ${ladder.clipUWei.toString(10)} U wei, buy[1] ${(ladder.buyPrice[1] ?? 0n).toString(10)}, sell[1] ${(ladder.sellPrice[1] ?? 0n).toString(10)}\n`
    + `  arm floor:   required ${floor.requiredBps} bps (gas ${floor.gasBps}) vs band ${config.params.bandBps} → ${floor.economic ? "economic" : "NOT economic"}\n`
    + `  admission:   ${admission.ok ? "ADMISSIBLE" : `REFUSED ${admission.code}`}\n`
    + `  file:        ${config.selfTestFile}\n`
    + `  job id:      ${jobId}`,
  );
  if (!floor.economic) throw new Error("Refusing to grant: the arm floor is not economic at this mid.");
  if (!admission.ok) throw new Error(`Refusing to grant: the session would not be admitted (${admission.code}).`);
  if (!yesLive(args)) { console.log("Rehearsal only. Pass --yes-live to grant."); return; }

  // R4: claim the file EXCLUSIVELY before any gas is spent.
  claimSelfTestFile(config.selfTestFile, {
    version: 1,
    config: { chainId: 56, u: config.u, uDecimals: 18, tradableTokens: [{ address: config.wbnb, decimals: 18, priceRoute: "direct" }], venueAllowlist: [config.router, config.u, config.wbnb] },
    agentKey: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
    inbox: [], jobs: [], reports: [],
  });
  let granted: Awaited<ReturnType<typeof context.provider.grantSession>>;
  try {
    granted = await context.provider.grantSession({ wallet, owner, spec, agent });
  } catch (error) {
    releaseSelfTestClaim(config.selfTestFile);
    throw error;
  }
  const sdkSession = (granted.handle as { session: { permissions: unknown } }).session;
  const plaintext = serializeGrantedSession({
    walletAddress: wallet.address,
    publicKey: granted.publicKey,
    expiry: expiresAt,
    permissions: sdkSession.permissions as Parameters<typeof serializeGrantedSession>[0]["permissions"],
    privateKey: agentKey,
  });
  const envelope = seal(plaintext, keypair.publicKey);
  const nowMs = Date.now();
  const file: QuantSelfTestFile = {
    version: 1,
    config: {
      chainId: 56,
      u: config.u,
      uDecimals: 18,
      tradableTokens: [{ address: config.wbnb, decimals: 18, priceRoute: "direct" }],
      venueAllowlist: [config.router, config.u, config.wbnb],
    },
    agentKey: {
      encryptionPublicKey: keypair.publicKey.toString("base64"),
      algorithm: QUANT_ENVELOPE_ALGORITHM,
    },
    inbox: [{ envelopeId: `env-${jobId}`, quantJobId: jobId, ...envelope }],
    jobs: [{
      id: jobId,
      status: "ACTIVE",
      strategyId: QUANT_SELF_TEST_STRATEGY_ID,
      tradingWalletAddress: wallet.address,
      allocationUWei: allocationUWei.toString(10),
      dailyCapUWei: allocationUWei.toString(10),
      termDays,
      startedAtMs: nowMs,
      endsAtMs: nowMs + termDays * 86_400_000,
      sessionExpiresAtMs: expiresAt * 1_000,
      revokedAtMs: null,
    }],
    reports: [],
  };
  writeSelfTestFile(config.selfTestFile, file);
  console.log(
    `granted: session publicKey ${granted.publicKey}. Ciphertext and the public job record `
    + `are in ${config.selfTestFile}. Next: \`worker --yes-live\` on the interval, then \`status\`.`,
  );
}

function commandHelp(): void {
  console.log(
    "live-quant <command> [flags]\n\n"
    + "  keypair                                  print our X25519 public key\n"
    + "  register-key --agent <id> [--yes-live]   register it with TermiX (gate 2)\n"
    + "  config-check                             the §2.1/§4.3 checks with the diff\n"
    + "  status [--job <id>]                      jobs, levels, actions, holds\n"
    + "  worker [--yes-live]                      ONE cycle; rehearses by default\n"
    + "  pause --job <id> / resume --job <id>     server-side refusal only\n"
    + "  resolve --action <key> --calls-id-read\n"
    + "  resolve --action <key> --tx <hash>       positive evidence only\n"
    + "  retire-level --job <id> --level <n> [--yes-live]\n"
    + "  acknowledge-external --job <id> --mode rebase|retire [--yes-live]\n"
    + "  report --job <id> [--yes-live]\n"
    + "  seal --recipient <b64> --in <f> --out <f>\n"
    + "  self-test --allocation-u <U> [--term-days 2] [--yes-live]  gate 1: grant + seal into QUANT_SELF_TEST_FILE\n",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") { commandHelp(); return; }
  if (args.command === "keypair") { await commandKeypair(); return; }
  if (args.command === "seal") { await commandSeal(args); return; }

  const context = await openContext();
  try {
    switch (args.command) {
      case "register-key": await commandRegisterKey(args, context); break;
      case "config-check": await commandConfigCheck(context); break;
      case "status": await commandStatus(args, context); break;
      case "worker": await commandWorker(args, context); break;
      case "pause": await commandPauseResume(args, context, true); break;
      case "resume": await commandPauseResume(args, context, false); break;
      case "resolve": await commandResolve(args, context); break;
      case "retire-level": await commandRetireLevel(args, context); break;
      case "acknowledge-external": await commandAcknowledgeExternal(args, context); break;
      case "report": await commandReport(args, context); break;
      case "self-test": await commandSelfTest(args, context); break;
      default: throw new Error(`Unknown subcommand: ${args.command}.`);
    }
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `live-quant failed: ${sanitizeMessage(
      error instanceof Error ? error.message : "unknown error",
    )}`,
  );
  process.exitCode = 1;
});
