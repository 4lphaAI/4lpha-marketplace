import { resolveLpAtomicRotate } from "../src/lp/wiring.js";
/**
 * live-lp — the PHASE3 live-verification operator script (spec body "Testing";
 * Revision 2 items 11–13; the live plan: provision → open → harvest → rotate →
 * protect/close, every tx hash destined for FINDINGS.md).
 *
 * SUBCOMMANDS
 *   provision  grant `lpSessionSpec` with the OWNER key and persist the agent
 *              row. Runs `checkLpNativeCapSizing` and REFUSES on shortfall
 *              (Rev2 items 11–12; `--expected-sequences-day` may only RAISE
 *              the derived floor). Refuses an already-existing `--agent-id`
 *              BEFORE the grant, so an id collision cannot burn the grant fee
 *              (audit A4).
 *   settings   owner-sign `lpSettings` through the real route (arms quotas,
 *              TP/SL, harvest floor — a live run usually wants
 *              `--min-minutes-between-exits 5` so harvest→rotate fits in one
 *              session). MERGES over the STORED row (audit A5): flags change
 *              only the fields they name; a partial re-run cannot silently
 *              disarm a standing stop-loss. Booleans disarm only with an
 *              explicit `--flag false`.
 *   open       owner-sign `lpOpen` through the real route (explicit range or
 *              the signed `server-fenced` delegation). Default budget 0.003
 *              BNB — the spec's 0.002–0.005 band.
 *   status     read-only: positions, sequences, per-step journal outcomes
 *              (callsId, tx hash, the exact resolving call), the on-chain
 *              native day meter. Needs no --yes-live.
 *   harvest    drive `runLpHarvest` for one position, operator-initiated.
 *   rotate     drive `runLpRotate` for one position, operator-initiated.
 *   close      owner-sign the manual exit (`lpExit`) through the real route.
 *   abandon      --agent-id <id> --sequence-id <uuid> --yes-live
 *                 Owner-signed. Stops a HELD sequence whose steps have all
 *                 settled from blocking the agent (PHASE3.8 F4a). Prints every
 *                 step and its journal state before the gate.
 *   resolve    owner-sign `resolveUnknown` for ONE stuck LP step row (PHASE3.3).
 *              Finalized direct evidence may advance a completed zap-out;
 *              otherwise the sequence is abandoned. Spends nothing on chain,
 *              retries no step, and prints the server's persisted evidence.
 *   resolve-landing owner-sign the Phase 3.9c finalized quorum resolver. It
 *              never submits and never accepts a caller-supplied tx hash.
 *
 * HOW IT RUNS: IN ONE PROCESS, AGAINST THE REAL SURFACE. The script builds the
 * REAL server app (`createServer`) over the Postgres stores, the real Altana
 * provider and the real chain readers, and calls the owner routes on it —
 * so `open`/`settings`/`close` exercise the full admission surface (gates,
 * rails, digest, journal), not a re-implementation. `harvest`/`rotate` have
 * no HTTP route by design (they are worker territory); here they call the
 * saga runners directly with the same deps the worker builds, which keeps
 * every in-saga gate (kill switch, rails, quota, floors, digest) in force
 * while making the run explicitly operator-initiated.
 *
 * THE SPIKE-SCRIPT LESSON, ENFORCED: every subcommand that can spend REFUSES
 * to run without `--yes-live`, after printing exactly what it would spend.
 * `status` is the one read-only exception.
 *
 * `--measure-relay-fee` (Rev2 item 12's DELIVERABLE): before and after each
 * money command the script reads the session's on-chain NATIVE DAY METER
 * (`spendInfos`) and prints the delta MINUS the native the command itself
 * attached, divided by the submissions it made — the relay's per-submission
 * reimbursement. Record the LARGEST observed value (mints cost several times
 * a swap) and set `LP_RELAY_FEE_PER_SUBMIT_WEI` to it, replacing the 0.0001
 * BNB placeholder in `src/ops/policy.ts`.
 *
 * KEYS: the owner key is read via `readEnvValue` (process env, then `.env` /
 * `.env.local`, read-only — the repo's standing convention), used to sign,
 * and NEVER logged or persisted anywhere. The agent session key follows
 * `provision-agent`'s `.env` handling verbatim.
 */
import { randomUUID } from "node:crypto";
import { humanPriceAtTick, tickAtHumanPrice } from "../src/lp/tickMath.js";
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { createServer, type ServerConfig } from "../src/server.js";
import { createAgentStore, type AgentRecord } from "../src/store/agents.js";
import { createJournal, type ExecutionJournal } from "../src/store/journal.js";
import { createNonceStore } from "../src/store/nonces.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { createProviderRegistry } from "../src/wallet/registry.js";
import {
  AltanaProvider,
  accountKeyHashForAddress,
  authorityFromPrivateKey,
} from "../src/wallet/altana.js";
import { ACCOUNT_ABI } from "../src/wallet/abis.js";
import { HttpDataPlaneClient } from "../src/clients/dataPlane.js";
import { validateSessionSpec } from "../src/core/session.js";
import {
  checkLpNativeCapSizing,
  lpSessionSpec,
  resolveLpRelayFeePerSubmitWei,
  MAX_SUBMISSIONS_PER_SEQUENCE,
  PROTECT_SUBMISSIONS_PER_POSITION,
} from "../src/ops/policy.js";
import {
  resolveLpEnabled,
  resolveTradeConfig,
} from "../src/ops/config.js";
import { buildLpServerDeps, type BuiltLpServerDeps } from "../src/lp/wiring.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { resolveLpRailConfig } from "../src/lp/rails.js";
import { verifyLpAbandonSequence } from "../src/lp/abandonSequence.js";
import {
  runLpHarvest,
  runLpRotate,
  type LpRotateDeps,
  type LpSagaDeps,
  type LpSagaRunResult,
} from "../src/lp/sagas.js";
import type { LpPriceTrigger } from "../src/lp/triggers.js";
import {
  DEFAULT_LP_SETTINGS,
  expectedPriceTriggerDirection,
  priceTriggerFires,
  type LpAutomationSettings,
  type LpRotateMode,
} from "../src/lp/triggers.js";
import {
  defaultLpSettingsParams,
  lpSettingsParamsView,
  parseLpSettingsParams,
} from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  OWNER_ACTION_TYPES,
  buildOwnerActionDomain,
  resolveDomainSalt,
  type OwnerActionStruct,
  type OwnerActionType,
} from "../src/auth/ownerAuth.js";
import {
  lpSequenceIdOfStepDecision,
  lpStepDecisionId,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";
import type { LpSettingsStore } from "../src/store/lpSettings.js";
import { publicKeyToAddress } from "viem/accounts";
import { readEnvValue, writeEnvValue } from "./spike/env.js";

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

const IS_MAINNET = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
const NETWORK: NetworkConfig = IS_MAINNET ? BNB : BNB_TESTNET;
const NETWORK_LABEL = IS_MAINNET ? "mainnet" : "testnet";
const UNIT = IS_MAINNET ? "BNB" : "tBNB";
const KEY_STORE = getAddress(NETWORK.keyStore);

function explorer(hash: string): string {
  return IS_MAINNET
    ? `https://bscscan.com/tx/${hash}`
    : `https://testnet.bscscan.com/tx/${hash}`;
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

type Flags = Map<string, string>;

function parseFlags(argv: readonly string[]): Flags {
  const map: Flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      map.set(arg.slice(2), next);
      i += 1;
    } else {
      map.set(arg.slice(2), "true");
    }
  }
  return map;
}

function need(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === "" || value === "true") {
    throw new Error(`--${name} is required.`);
  }
  return value.trim();
}

function needAddress(flags: Flags, name: string): Address {
  const raw = need(flags, name);
  if (!isAddress(raw)) throw new Error(`--${name} is not a valid address.`);
  return getAddress(raw);
}

function intFlag(flags: Flags, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined || raw === "true") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer.`);
  return parsed;
}

/**
 * Tri-state boolean flag: absent keeps `fallback` (for `settings`, the STORED
 * value — audit A5), bare `--flag` or `--flag true` arms, an explicit
 * `--flag false` disarms deliberately. Anything else is refused so a typo
 * cannot silently mean either state.
 */
function boolFlag(flags: Flags, name: string, fallback: boolean): boolean {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${name} must be "true" or "false" (or be omitted).`);
}

/**
 * PHASE3.13: `--rotate-mode swapped|swapless`, the owner-signed rotate shape.
 * Its own reader rather than `boolFlag`, because it is a two-literal string —
 * a boolean flag would accept `--rotate-mode true`.
 *
 * WHAT THE OWNER IS SIGNING, and `--help` says the same thing: `"swapless"`
 * skips the rotate's balancing swap and parks the prior width STRICTLY BESIDE
 * the price on the side the freed principal is already on. It saves one
 * submission, one pool fee and that leg's slippage — and it CHANGES EXPOSURE:
 * the position earns nothing until the price comes back, auto-harvest stays
 * inert for it while parked, it does NOT re-center, and the off-side leg (up to
 * 50 bps of the freed value) is left in the WALLET rather than re-deposited,
 * disclosed in the sequence note. `"swapped"` is the default and is today's
 * behaviour.
 */
function rotateModeFlag(flags: Flags, fallback: LpRotateMode): LpRotateMode {
  const raw = flags.get("rotate-mode");
  if (raw === undefined) return fallback;
  if (raw === "swapped" || raw === "swapless") return raw;
  throw new Error('--rotate-mode must be "swapped" or "swapless" (or be omitted).');
}

/**
 * The never-casually-runnable gate. Prints what the command WOULD spend and
 * refuses without the explicit flag — on testnet too, because the habit is
 * the protection.
 */
function requireYesLive(flags: Flags, wouldSpend: string): void {
  if (flags.get("yes-live") === "true") return;
  console.error(
    `\nREFUSED: this command submits real transactions on chain ${NETWORK.chainId} (${NETWORK_LABEL}).\n` +
      `It would spend: ${wouldSpend}\n` +
      `Re-run with --yes-live if that is what you want. Nothing was sent.`,
  );
  process.exitCode = 1;
  throw new Error("--yes-live not supplied");
}

/* -------------------------------------------------------------------------- */
/* Keys (never logged)                                                        */
/* -------------------------------------------------------------------------- */

function ownerKey(): Hex {
  const varName =
    readEnvValue("SPIKE_OWNER_KEY_VAR") ??
    (IS_MAINNET ? "USER1_PRIVATE_KEY" : "OWNER_TEST_KEY");
  const value = readEnvValue(varName);
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `No owner key: ${varName} is unset. Put it in .env.local; this script never generates one.`,
    );
  }
  return value.trim() as Hex;
}

/** provision-agent's session-key convention, verbatim. */
function sessionKeyFor(agentId: string): { key: Hex; varName: string; generated: boolean } {
  const varName = `AGENT_SESSION_KEY_${agentId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const existing = readEnvValue(varName);
  if (existing !== undefined && existing.trim() !== "") {
    return { key: existing.trim() as Hex, varName, generated: false };
  }
  const key = generatePrivateKey();
  writeEnvValue(varName, key);
  return { key, varName, generated: true };
}

/* -------------------------------------------------------------------------- */
/* Owner-action signing (the harness's shape, production domain constructor)  */
/* -------------------------------------------------------------------------- */

type SignedEnvelope = {
  readonly signed: Record<string, unknown>;
  readonly signature: Hex;
  readonly params: unknown;
  /**
   * The typed struct the wire form was rendered from, so a caller can derive
   * `ownerActionIdempotencyKey` — the journal key of the ACTION'S OWN row —
   * without re-parsing `signed`. `resolve` reads a refused action's archived
   * evidence off that row (PHASE3.3-AUDIT A7).
   */
  readonly struct: OwnerActionStruct;
};

async function signOwnerAction(
  action: OwnerActionType,
  agentId: string,
  params: unknown,
): Promise<SignedEnvelope> {
  const account = privateKeyToAccount(ownerKey());
  const nowSec = Math.floor(Date.now() / 1000);
  const envSalt = process.env["EXECUTION_ENV_SALT"]?.trim();
  const message: OwnerActionStruct = {
    owner: account.address,
    agentId,
    action,
    paramsHash: paramsHash(action, params),
    nonce: keccak256(stringToBytes(`live-lp-${randomUUID()}`)),
    issuedAt: BigInt(nowSec - 5),
    expiry: BigInt(nowSec + 120),
  };
  const signature = await account.signTypedData({
    domain: buildOwnerActionDomain(
      NETWORK.chainId,
      resolveDomainSalt({
        chainId: NETWORK.chainId,
        network: NETWORK_LABEL,
        ...(envSalt === undefined || envSalt === "" ? {} : { envSalt }),
      }),
    ),
    types: OWNER_ACTION_TYPES,
    primaryType: "OwnerAction",
    message,
  });
  return {
    signed: {
      owner: message.owner,
      agentId: message.agentId,
      action: message.action,
      paramsHash: message.paramsHash,
      nonce: message.nonce,
      issuedAt: message.issuedAt.toString(10),
      expiry: message.expiry.toString(10),
    },
    signature,
    params,
    struct: message,
  };
}

/* -------------------------------------------------------------------------- */
/* The in-process stack                                                       */
/* -------------------------------------------------------------------------- */

type Stack = {
  readonly app: ReturnType<typeof createServer>;
  readonly execToken: string;
  readonly agentStore: Awaited<ReturnType<typeof createAgentStore>>;
  readonly journal: ExecutionJournal;
  readonly killswitch: Awaited<ReturnType<typeof createKillSwitch>>;
  readonly provider: AltanaProvider;
  readonly lp: BuiltLpServerDeps;
  readonly lpStore: LpSequenceStore;
  readonly settingsStore: LpSettingsStore;
  close(): Promise<void>;
};

async function buildStack(): Promise<Stack> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required: live-lp drives the REAL persisted stores so the " +
        "server and worker see what it does. A memory store would vanish with this process.",
    );
  }
  if (!resolveLpEnabled(process.env)) {
    throw new Error('LP_ENABLED must be "true" for live-lp; it is the LP master switch.');
  }
  const dataPlaneUrl = process.env["DATA_PLANE_URL"]?.trim() ?? "";
  if (dataPlaneUrl === "") {
    throw new Error("DATA_PLANE_URL is required (the server dependency; .env carries it).");
  }

  const tradeConfig = resolveTradeConfig(process.env, {
    chainId: NETWORK.chainId,
    keyStore: KEY_STORE,
  });
  const readerNetwork = {
    chain: NETWORK.chain,
    chainId: NETWORK.chainId,
    publicRpcUrl: NETWORK.publicRpcUrl,
  };
  // Every pre-existing operator script passes this list; the Phase 3 scripts
  // did not, and the SDK's default endpoint cannot read a receipt on chain 56.
  const rpcUrls = resolveLpRpcUrls(process.env, readerNetwork);

  const lp = await buildLpServerDeps({
    env: process.env,
    network: readerNetwork,
    rpcUrls,
    keyStore: KEY_STORE,
    venues: tradeConfig.venues,
  });

  const agentStore = await createAgentStore();
  const journal = await createJournal();
  const nonceStore = await createNonceStore();
  const killswitch = await createKillSwitch();
  const provider = new AltanaProvider({ network: NETWORK, rpcUrls });
  const providerRegistry = createProviderRegistry([
    { network: NETWORK, options: { rpcUrls } },
  ]);

  // Ephemeral service credentials: this app lives and dies inside this
  // process; nothing else can reach it, and nothing here is persisted.
  const execToken = `live-lp-${randomUUID()}`;
  const envSalt = process.env["EXECUTION_ENV_SALT"]?.trim();
  const config: ServerConfig = {
    chainId: NETWORK.chainId,
    network: NETWORK_LABEL,
    keyStore: KEY_STORE,
    execToken,
    operatorToken: `live-lp-op-${randomUUID()}`,
    trade: tradeConfig,
    ...(envSalt === undefined || envSalt === "" ? {} : { envSalt }),
  };

  const app = createServer({
    agentStore,
    journal,
    nonceStore,
    killswitch,
    providerRegistry,
    dataPlane: new HttpDataPlaneClient({
      baseUrl: dataPlaneUrl,
      ...(process.env["DATA_PLANE_TOKEN"]?.trim()
        ? { token: process.env["DATA_PLANE_TOKEN"]?.trim() ?? "" }
        : {}),
    }),
    lp: lp.lp,
    config,
  });

  return {
    app,
    execToken,
    agentStore,
    journal,
    killswitch,
    provider,
    lp,
    lpStore: lp.lp.store,
    settingsStore: lp.lp.settingsStore,
    async close(): Promise<void> {
      lp.evidence?.observer.stop();
      for (const closeable of [journal, nonceStore, killswitch, agentStore,
        lp.lp.store, lp.lp.settingsStore,
        ...(lp.evidence === undefined ? [] : [lp.evidence.store, lp.evidence.coverageStore,
          ...(lp.evidence.finalizer === undefined ? [] : [lp.evidence.finalizer])])]) {
        try {
          await closeable.close();
        } catch {
          /* independent closes */
        }
      }
    },
  };
}

/**
 * A signed owner READ. The envelope rides base64url in `x-owner-action`
 * (`decodeOwnerActionHeader`), and `read` is verified but NOT nonce-consumed —
 * so this is safe to retry and safe to run casually, unlike everything else in
 * this file.
 */
async function getOwnerRead(
  stack: Stack,
  agentId: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction("read", agentId, {});
  const header = Buffer.from(
    JSON.stringify({
      signed: envelope.signed,
      signature: envelope.signature,
      params: envelope.params,
    }),
    "utf8",
  ).toString("base64url");
  const response = await stack.app.request(path, {
    method: "GET",
    headers: { "x-owner-action": header, "x-exec-token": stack.execToken },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function postOwner(
  stack: Stack,
  path: string,
  envelope: SignedEnvelope,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await stack.app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-exec-token": stack.execToken,
    },
    // Only the three WIRE fields. `struct` is a local convenience (and holds
    // bigints, which `JSON.stringify` refuses); the envelope parser rejects any
    // key it does not know.
    body: JSON.stringify({
      signed: envelope.signed,
      signature: envelope.signature,
      params: envelope.params,
    }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

/* -------------------------------------------------------------------------- */
/* Printing: sequences, journal outcomes, the resolving call                  */
/* -------------------------------------------------------------------------- */

async function printSequence(
  stack: Stack,
  owner: Address,
  agentId: string,
  sequenceId: string,
): Promise<void> {
  if (sequenceId === "") return;
  const sequence = await stack.lpStore.getSequence(owner, agentId, sequenceId);
  if (sequence === null) {
    console.log(`  sequence ${sequenceId}: not found for this owner`);
    return;
  }
  console.log(
    `  sequence ${sequence.sequenceId}: kind=${sequence.kind} state=${sequence.state} recovery=${sequence.recoveryState}`,
  );
  if (sequence.note !== null) {
    // PHASE3.1 Rev2 item 15: why a COMPLETED exit still handed back the token.
    console.log(`    note    : ${sequence.note}`);
  }
  for (const step of sequence.steps) {
    const row = await stack.journal.get(step.journalIdempotencyKey);
    const state = row?.state ?? "(no journal row)";
    const callsId = row?.externalRef.callsId;
    const txHash = row?.externalRef.txHash;
    console.log(`    step ${step.index} ${step.kind}: journal=${state}`);
    if (txHash !== undefined) console.log(`      tx      : ${explorer(txHash)}`);
    if (callsId !== undefined) {
      console.log(`      callsId : ${callsId}`);
      // A PENDING with a handle is a question that can still be answered —
      // the exact call that resolves it, verbatim (live-trade's convention).
      const body = `{"jsonrpc":"2.0","id":1,"method":"wallet_getCallsStatus","params":["${callsId}"]}`;
      console.log(
        `      resolve : curl -s -X POST -H 'content-type: application/json' --data '${body}' ${NETWORK.relayUrl ?? "<relay url>"}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The native day meter (--measure-relay-fee, Rev2 item 12)                   */
/* -------------------------------------------------------------------------- */

type MeterRow = { limit: bigint; spent: bigint; currentSpent: bigint };

const meterClient = createPublicClient({
  chain: NETWORK.chain,
  transport: http(NETWORK.publicRpcUrl),
});

async function readNativeDayMeter(agent: AgentRecord): Promise<MeterRow | null> {
  const facts = agent.sessionFacts;
  if (facts === null) return null;
  const keyHash = accountKeyHashForAddress(publicKeyToAddress(facts.publicKey));
  const infos = await meterClient.readContract({
    address: agent.walletAddress,
    abi: ACCOUNT_ABI,
    functionName: "spendInfos",
    args: [keyHash],
  });
  const day = infos.find((info) => info.token === zeroAddress && Number(info.period) === 2);
  if (day === undefined) return null;
  return { limit: day.limit, spent: day.spent, currentSpent: day.currentSpent };
}

/**
 * Print the meter delta attributable to the RELAY's per-submission gas
 * reimbursement: (meter delta − native the command itself attached) ÷
 * submissions. This is Rev2 item 12's measured constant.
 */
function reportMeterDelta(
  before: MeterRow | null,
  after: MeterRow | null,
  attachedNativeWei: bigint,
  submissions: number,
): void {
  if (before === null || after === null) {
    console.log(
      "  meter    : (unreadable — no daily native spendInfos row; cannot measure the relay fee)",
    );
    return;
  }
  const delta = after.currentSpent - before.currentSpent;
  console.log(
    `  meter    : currentSpent ${before.currentSpent} -> ${after.currentSpent} wei (delta ${delta})`,
  );
  if (submissions <= 0) return;
  const relayTotal = delta - attachedNativeWei;
  const perSubmit = relayTotal > 0n ? relayTotal / BigInt(submissions) : 0n;
  console.log(
    `  relay fee: ~${perSubmit} wei/submission over ${submissions} submission(s) ` +
      `(delta ${delta} - attached ${attachedNativeWei})`,
  );
  if (submissions > 1) {
    // PHASE3.1 Rev2 item 26: an exit now spans TWO submissions of DIFFERENT
    // shapes (a zap-out batch and a router swap batch), and one meter read
    // either side of the whole command can only average them. Say so, or the
    // second data point promised for FINDINGS (ac) is an average of two
    // different step kinds recorded as one.
    console.log(
      `             CAVEAT: this is an AVERAGE across ${submissions} submissions of ` +
        `different shapes — the meter is read once before and once after the whole ` +
        `command. For a per-step figure, read the meter between steps or price each ` +
        `tx hash above from its own receipt.`,
    );
  }
  console.log(
    `             record the LARGEST value observed across step kinds and set ` +
      `LP_RELAY_FEE_PER_SUBMIT_WEI=<wei> to replace the 0.0001 BNB placeholder ` +
      `(Rev2 item 12 deliverable; mints cost several times a swap).`,
  );
}

/** Count the submissions a saga result's sequence actually journalled. */
async function countSubmissions(
  stack: Stack,
  owner: Address,
  agentId: string,
  sequenceId: string,
): Promise<number> {
  if (sequenceId === "") return 0;
  const sequence = await stack.lpStore.getSequence(owner, agentId, sequenceId);
  if (sequence === null) return 0;
  let count = 0;
  for (const step of sequence.steps) {
    const row = await stack.journal.get(step.journalIdempotencyKey);
    if (row?.externalRef.txHash !== undefined || row?.externalRef.callsId !== undefined) {
      count += 1;
    }
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* Saga deps for the operator-driven harvest/rotate                           */
/* -------------------------------------------------------------------------- */

async function operatorSagaDeps(
  stack: Stack,
  agent: AgentRecord,
  positionId: string,
): Promise<{ base: LpSagaDeps; rotate: () => Promise<LpRotateDeps> }> {
  const railsResult = resolveLpRailConfig(process.env);
  if (!railsResult.ok) {
    throw new Error(`Refusing: ${railsResult.failure.reason}`);
  }
  const rails = railsResult.config;
  const stored = await stack.settingsStore.get(agent.ownerAddress, agent.id);
  const defaultDigest = paramsHash("lpSettings", defaultLpSettingsParams());
  let settings: LpAutomationSettings = DEFAULT_LP_SETTINGS;
  let digest = defaultDigest;
  if (stored !== null) {
    // AUDIT A7: recompute-and-refuse, borrowed from the worker
    // (`loadPositionContext` in `src/lp/worker.ts`). The saga's between-step
    // gate compares the deps digest against the store's — which is
    // self-comparison if `stored.digest` is taken on faith here. A tampered
    // row (params edited, digest left) must refuse, not drive quota/TP-SL
    // values the owner never signed.
    const recomputed = paramsHash("lpSettings", stored.params);
    if (recomputed.toLowerCase() !== stored.digest.toLowerCase()) {
      throw new Error(
        "Stored LP settings digest does not recompute from the stored params; " +
          "refusing to drive a saga under unverified settings.",
      );
    }
    const parsed = parseLpSettingsParams(stored.params);
    if (!parsed.ok) throw new Error(`Stored LP settings are unreadable: ${parsed.message}`);
    settings = parsed.value;
    digest = stored.digest;
  }
  const position = await stack.lpStore.getPosition(agent.ownerAddress, agent.id, positionId);
  if (position === null) throw new Error(`Position "${positionId}" not found for this owner.`);
  const pool = await stack.lp.readers.getPool(position.token0, position.token1, position.fee);
  if (pool === null) throw new Error("The position's pool could not be resolved.");

  const base: LpSagaDeps = {
    agent,
    agentStore: stack.agentStore,
    provider: stack.provider,
    journal: stack.journal,
    store: stack.lpStore,
    killswitch: stack.killswitch,
    rails,
    quota: {
      maxExitSequencesPerDay: settings.maxExitSequencesPerDay,
      minMinutesBetweenExits: settings.minMinutesBetweenExits,
    },
    market: async () => {
      const state = await stack.lp.readers.poolState(pool);
      return { ...state.evidence, currentTick: state.currentTick };
    },
    positions: stack.lp.readers.positions,
    quote: stack.lp.readers.quote,
    receipts: stack.lp.readers.receipts,
    expectedPool: pool,
    conversionCompatibleTokens: stack.lp.lp.runtime.conversionCompatibleTokens,
    settingsDigest: digest,
    currentSettingsDigest: async () => {
      const row = await stack.settingsStore.get(agent.ownerAddress, agent.id);
      return row === null ? defaultDigest : row.digest;
    },
    // PHASE3.1 Rev2 items 8/17: the owner's own verified setting, and the same
    // dust-floor constant the sizing reserve uses.
    exitToQuote: settings.exitToQuote,
    // PHASE3.13 F12: the harvest range refusal's conditional remedy.
    autoRotate: settings.autoRotate,
    relayFeePerSubmitWei: resolveLpRelayFeePerSubmitWei(process.env),
    venue: stack.lp.lp.venue,
    now: Date.now,
  };
  return {
    base,
    rotate: async (): Promise<LpRotateDeps> => {
      const state = await stack.lp.readers.poolState(pool);
      // Deliberately NO proposeRange here: an operator-forced rotate is a
      // deterministic verification step; the brain path belongs to the worker.
      return {
        ...base,
        tickSpacing: state.tickSpacing,
        maxTickWidth: stack.lp.lp.runtime.maxTickWidth,
        // PHASE3.13: an operator-forced rotate runs the mode the OWNER signed.
        // The operator surface does not get to choose the shape — that is a
        // strategy decision and it lives in the signed settings row.
        rotateMode: settings.rotateMode,
        atomicRotate: resolveLpAtomicRotate(process.env),
        ...(stack.lp.readers.quoteWithPriceAfter === undefined ? {} : { quoteWithPriceAfter: stack.lp.readers.quoteWithPriceAfter }),
      };
    },
  };
}

async function requireAgent(stack: Stack, agentId: string): Promise<AgentRecord> {
  const agent = await stack.agentStore.getAgentById(agentId);
  if (agent === null) throw new Error(`Agent "${agentId}" not found.`);
  return agent;
}

function reportSagaResult(label: string, result: LpSagaRunResult): void {
  console.log(`\n${label}: ${result.status} (${result.code})`);
  console.log(`  reason   : ${result.reason}`);
  // Plan positions confirmed, SKIPPED ones included — a skipped step is a
  // completed plan position. The exit is two of them from PHASE3.1 on.
  console.log(`  steps ok : ${result.confirmedSteps} (plan positions, skips included)`);
}

/* -------------------------------------------------------------------------- */
/* Subcommands                                                                */
/* -------------------------------------------------------------------------- */

async function cmdProvision(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const token = needAddress(flags, "token");
  const capDay = flags.get("cap-day") ?? "0.02";
  const openBudget = flags.get("open-budget") ?? "0.003";
  const maxExitSequencesPerDay = intFlag(
    flags,
    "max-exit-sequences-day",
    DEFAULT_LP_SETTINGS.maxExitSequencesPerDay,
  );
  const expectedRaw = flags.get("expected-sequences-day");
  const expectedSequencesPerDay =
    expectedRaw === undefined || expectedRaw === "true" ? undefined : Number(expectedRaw);
  const ttlSec = intFlag(flags, "ttl-sec", 86_400);

  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new Error("DATABASE_URL is required (the agent row must outlive this process).");
  }
  if ((process.env["EXECUTION_MASTER_KEY"] ?? "").trim() === "") {
    throw new Error("EXECUTION_MASTER_KEY is required to persist the encrypted session key.");
  }
  const treasuryRaw = process.env["FEE_TREASURY_ADDRESS"]?.trim() ?? "";
  if (treasuryRaw === "" || !isAddress(treasuryRaw)) {
    throw new Error(
      "FEE_TREASURY_ADDRESS is required: lpSessionSpec grants the treasury even in " +
        "fee-free v1 (Rev2 item 30 — a later fee must be a config change, never a re-grant).",
    );
  }

  const tradeConfig = resolveTradeConfig(process.env, {
    chainId: NETWORK.chainId,
    keyStore: KEY_STORE,
  });
  const lpBuilt = await buildLpServerDeps({
    env: process.env,
    network: {
      chain: NETWORK.chain,
      chainId: NETWORK.chainId,
      publicRpcUrl: NETWORK.publicRpcUrl,
    },
    keyStore: KEY_STORE,
    venues: tradeConfig.venues,
  });
  const { addresses } = lpBuilt;

  const onChainDailyCapWei = parseEther(capDay);
  const openNativeBudgetWei = parseEther(openBudget);

  // THE LP SIZING INVARIANT (Rev2 items 11–12) — refused, not warned about.
  const sizing = checkLpNativeCapSizing({
    onChainDailyCapWei,
    openNativeBudgetWei,
    maxExitSequencesPerDay,
    ...(expectedSequencesPerDay === undefined ? {} : { expectedSequencesPerDay }),
    lpRelayFeePerSubmitWei: resolveLpRelayFeePerSubmitWei(process.env),
  });
  if (!sizing.ok) throw new Error(sizing.message);

  // AUDIT A4: verify the agent id is available BEFORE the on-chain grant.
  // `createAgent` throws on a duplicate id, and discovering that AFTER
  // `grantSession` burns the grant gas + KeyStore registration fee and orphans
  // the freshly-granted session (its embedded expiry/nowSeconds are lost with
  // this process; recovery is an owner revoke). The store is opened here and
  // reused for the post-grant persist, so the row check and the insert see the
  // same database.
  const store = await createAgentStore();
  try {
    const collided = await store.getAgentById(agentId);
    if (collided !== null) {
      throw new Error(
        `Agent "${agentId}" already exists (owner ${collided.ownerAddress}). ` +
          `Refusing BEFORE the on-chain grant so no gas is spent: pick a fresh ` +
          `--agent-id, or revoke and remove the existing agent first.`,
      );
    }
    await cmdProvisionGrant(flags, store, {
      agentId,
      token,
      capDay,
      openBudget,
      onChainDailyCapWei,
      openNativeBudgetWei,
      maxExitSequencesPerDay,
      expectedSequencesPerDay,
      ttlSec,
      treasury: getAddress(treasuryRaw),
      addresses,
    });
  } finally {
    await store.close();
  }
}

type ProvisionGrantInput = {
  readonly agentId: string;
  readonly token: Address;
  readonly capDay: string;
  readonly openBudget: string;
  readonly onChainDailyCapWei: bigint;
  readonly openNativeBudgetWei: bigint;
  readonly maxExitSequencesPerDay: number;
  readonly expectedSequencesPerDay: number | undefined;
  readonly ttlSec: number;
  readonly treasury: Address;
  readonly addresses: BuiltLpServerDeps["addresses"];
};

/** The grant + persist tail of `provision`, entered only with a free agent id. */
async function cmdProvisionGrant(
  flags: Flags,
  store: Awaited<ReturnType<typeof createAgentStore>>,
  input: ProvisionGrantInput,
): Promise<void> {
  const {
    agentId,
    token,
    capDay,
    openBudget,
    onChainDailyCapWei,
    openNativeBudgetWei,
    maxExitSequencesPerDay,
    expectedSequencesPerDay,
    ttlSec,
    addresses,
  } = input;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const spec = lpSessionSpec({
    nfpm: addresses.nfpm,
    routerV3: addresses.routerV3,
    wbnb: { token: addresses.wbnb },
    token: { token },
    treasury: input.treasury,
    nativeCaps: [{ limit: onChainDailyCapWei, period: "day" }],
    expiresAt: nowSeconds + ttlSec,
    nowSeconds,
  });

  console.log(`network        : ${NETWORK.chainId} (${NETWORK_LABEL})`);
  console.log(`agent id       : ${agentId}`);
  console.log(`pool legs      : WBNB ${addresses.wbnb} / TOKEN ${token}`);
  console.log(`on-chain cap   : ${onChainDailyCapWei} wei/day (${capDay} ${UNIT})`);
  console.log(`open budget    : ${openNativeBudgetWei} wei (${openBudget} ${UNIT})`);
  console.log(
    `gas reserve    : N=${Math.max(maxExitSequencesPerDay, expectedSequencesPerDay ?? 0)} x ` +
      `${MAX_SUBMISSIONS_PER_SEQUENCE} submissions x LP_RELAY_FEE_PER_SUBMIT_WEI ` +
      `+ protect headroom P=1 x ${PROTECT_SUBMISSIONS_PER_POSITION} submissions ` +
      `(audit A3, widened to the PHASE3.1 two-step exit) ` +
      `(a FLOOR until live-lp measures the constant — Rev2 item 12)`,
  );
  console.log(`allowlist      : ${spec.allowedCalls.length} rules`);
  for (const rule of spec.allowedCalls) {
    console.log(`  - ${rule.to ?? "(any target)"}${rule.selector ? ` :: ${rule.selector}` : ""}`);
  }
  console.log(`session expires: ${new Date(spec.expiresAt * 1000).toISOString()}`);

  requireYesLive(
    flags,
    `the session-grant gas + KeyStore registration fee (~0.001 ${UNIT}), paid by the owner wallet`,
  );

  const provider = new AltanaProvider({
    network: NETWORK,
    rpcUrls: resolveLpRpcUrls(process.env, {
      chain: NETWORK.chain,
      chainId: NETWORK.chainId,
      publicRpcUrl: NETWORK.publicRpcUrl,
    }),
  });
  const owner = authorityFromPrivateKey(ownerKey());
  const wallet = await provider.resolveOwnerWallet({ owner });
  const balance = await provider.getBalance({ address: wallet.address });
  console.log(`owner wallet   : ${wallet.address} balance ${formatEther(balance)} ${UNIT}`);
  if (balance === 0n) {
    throw new Error(`Refusing to grant: ${wallet.address} holds no ${UNIT}.`);
  }

  const session = sessionKeyFor(agentId);
  const agentAuthority = authorityFromPrivateKey(session.key);
  console.log(
    `session key    : ${privateKeyToAccount(session.key).address} ` +
      `(${session.generated ? "generated, saved to .env as" : "reused from"} ${session.varName})`,
  );

  console.log("\ngranting the LP session — this signs with the OWNER key and costs gas...");
  const granted = await provider.grantSession({
    wallet,
    owner,
    spec,
    agent: agentAuthority,
  });
  console.log(`granted        : publicKey ${granted.publicKey}`);

  // Persist on the SAME store the pre-grant availability check ran against
  // (audit A4): the id was verified free before any gas was spent above.
  const record = await store.createAgent({
    httpRuntimeProfile: "lp-v1",
    id: agentId,
    ownerAddress: wallet.ownerAddress,
    walletAddress: wallet.address,
    custodyModel: wallet.custodyModel,
    // The off-chain daily native cap = the open budget: the open's
    // mint{value} is the ONLY native an LP saga attaches (Rev2 item 14).
    caps: { dailyNativeWei: openNativeBudgetWei },
    sessionFacts: {
      spec,
      permissions: validateSessionSpec(spec),
      publicKey: granted.publicKey,
      expiry: spec.expiresAt,
    },
    status: "armed",
  });
  await store.putAgentSessionKey(record.ownerAddress, record.id, session.key);
  console.log(`persisted      : agent "${record.id}" owner ${record.ownerAddress} status ${record.status}`);
  console.log(
    `\nDone. Next: npm run live-lp -- settings --agent-id ${agentId} --min-minutes-between-exits 5 --auto-harvest --auto-rotate --yes-live` +
      `\nthen: npm run live-lp -- open --agent-id ${agentId} --token ${token} --budget ${openBudget} --yes-live`,
  );
}

/**
 * Turn `--stop-loss-price 603.21 --stop-loss-when at-or-above --pool 0x…` into
 * the tuple that gets SIGNED (PHASE3.6 Rev2 M10/M11/M12).
 *
 * THE DERIVATION LIVES HERE, and saying so is the point. Decision 1 says the
 * PLANE never infers a direction from pool orientation; it does not say the
 * inference vanishes. It moves to the one place that can PRINT its reasoning
 * and be checked before a signature — which is the whole improvement over
 * FINDINGS (ao), where the inference happened in a human's head and nothing
 * showed its working.
 *
 * So: `--…-when` is REQUIRED beside a price, this function derives the
 * direction independently, and REFUSES with a diff when the two disagree.
 */
function resolvePriceTriggerFlag(
  flags: Flags,
  which: "stop-loss" | "take-profit",
  stored: LpPriceTrigger | null,
): LpPriceTrigger | null {
  // AUDIT A1, and it is worth stating what was wrong because the shape recurs.
  // The first version "derived" the direction from the ROUNDING side — but the
  // rounding side IS `when`, so the comparison was `when` against itself,
  // XOR'd with `inverted`. Measured: every `--…-price-inverted` call was
  // refused (including the FINDINGS (ao) owner's own stop, which the code calls
  // "the common one"), and every non-inverted call was accepted whatever the
  // direction. A guard that compiles and checks nothing on the path it permits.
  //
  // FIXREVIEW N1 restores M10's derivation, this time from a signal that is
  // genuinely independent of `when`: the operator's INTENT. A stop-loss fires
  // when the thing you hold gets cheaper; a take-profit when it gets dearer.
  // Which tick direction that is depends only on WHICH LEG the quoted price is
  // about — never on the rounding, and never on `when` itself:
  //
  //   not inverted (price = token1 per token0, i.e. the price OF token0)
  //     stop-loss   -> token0 falls -> tick FALLS -> at-or-below
  //     take-profit -> token0 rises -> tick RISES -> at-or-above
  //   inverted (price = token0 per token1, i.e. the price OF token1)
  //     stop-loss   -> token1 falls -> tick RISES -> at-or-above
  //     take-profit -> token1 rises -> tick FALLS -> at-or-below
  //
  // Without it, `620 / inverted / at-or-below` above a 603 market signs
  // silently: not already satisfied, so the market read below waves it through,
  // and yet it can only ever fire on a move in the owner's FAVOUR — a stop that
  // protects nothing. Measured by the fix review.
  //
  // The market read stays as well; the two catch different mistakes.
  const priceRaw = flags.get(`${which}-price`);
  if (priceRaw === undefined || priceRaw === "true") return stored;
  if (priceRaw === "none") return null;

  const price = Number(priceRaw);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`--${which}-price must be a positive number, or "none" to clear it.`);
  }
  const when = flags.get(`${which}-when`);
  if (when !== "at-or-below" && when !== "at-or-above") {
    throw new Error(
      `--${which}-when is REQUIRED beside --${which}-price and must be ` +
        `"at-or-below" or "at-or-above". It is required because the direction ` +
        `is what FINDINGS (ao) got wrong: for a stable/volatile pool, a FALL in ` +
        `the token's price moves the tick UP.`,
    );
  }
  const token0 = needAddress(flags, "trigger-token0");
  const token1 = needAddress(flags, "trigger-token1");
  const fee = intFlag(flags, "trigger-fee", 0);
  if (token0.toLowerCase() >= token1.toLowerCase()) {
    throw new Error("--trigger-token0 must sort below --trigger-token1 (pool order).");
  }
  const decimals0 = intFlag(flags, "trigger-decimals0", 18);
  const decimals1 = intFlag(flags, "trigger-decimals1", 18);

  // M11: the decimals term is NOT decoration. Nothing in this repo reads
  // `decimals()`, so an operator on a non-18/18 pair must state them and this
  // refuses rather than emitting a wrong tick from a silent assumption.
  if (decimals0 !== 18 || decimals1 !== 18) {
    console.log(
      `decimals       : ${decimals0}/${decimals1} (supplied) — the conversion carries 10^(d0-d1)`,
    );
  }

  // The price the operator typed is "how many token1 per whole token0"? NO —
  // operators think in the QUOTE they read on a chart. `--…-price-inverted`
  // says the number is token0-per-token1 (e.g. USDT per BNB when USDT is
  // token0), which is the (ao) case and the common one.
  const inverted = flags.get(`${which}-price-inverted`) === "true";
  const humanPrice = inverted ? 1 / price : price;

  // M12: round so the signed tick is never MORE aggressive than the request.
  const round = when === "at-or-below" ? "down" : "up";
  const tick = tickAtHumanPrice({ humanPrice, decimals0, decimals1, round });

  const exact = humanPriceAtTick(tick, decimals0, decimals1);
  const neighbour = humanPriceAtTick(
    when === "at-or-below" ? tick - 1 : tick + 1,
    decimals0,
    decimals1,
  );
  const show = (v: number): string => (inverted ? 1 / v : v).toFixed(6);

  // M10: the sentence is generated from the ASSEMBLED tuple, never from the
  // operator's input, so it can never describe something other than what is
  // about to be signed.
  const assembled: LpPriceTrigger = { token0, token1, fee, tick, when };
  console.log(
    `\n${which} price trigger (about to be SIGNED):\n` +
      `  pool         : ${assembled.token0} / ${assembled.token1} fee ${assembled.fee}\n` +
      `  requested    : ${price}${inverted ? " (token0 per token1)" : " (token1 per token0)"}\n` +
      `  signed tick  : ${assembled.tick}  exact price ${show(exact)}\n` +
      `  next tick    : ${show(neighbour)}  (the real boundary is between these)\n` +
      `  fires WHEN   : the pool's tick is ${assembled.when} ${assembled.tick}\n` +
      `  which means  : ${describeDirection(assembled, inverted)}`,
  );

  const expected = expectedPriceTriggerDirection(which, inverted);
  if (assembled.when !== expected) {
    throw new Error(
      `--${which}-when says "${assembled.when}", but a ${which} on a price quoted ` +
        `as ${inverted ? "token0 per token1" : "token1 per token0"} fires when the ` +
        `tick moves ${expected === "at-or-below" ? "DOWN" : "UP"}, i.e. "${expected}". ` +
        `As signed, this trigger could only fire on a move in your FAVOUR. ` +
        `This is the FINDINGS (ao) mistake and it is refused rather than signed.\n` +
        `  If the direction was the slip: pass --${which}-when ${expected} (same tick ${assembled.tick}).\n` +
        `  If the QUOTE was the slip: ${
          inverted
            ? `drop --${which}-price-inverted`
            : `add --${which}-price-inverted`
        } — but note that moves the tick, it does not keep it.`,
    );
  }
  return assembled;
}

/** One sentence, generated from the tuple that will be signed. */
function describeDirection(trigger: LpPriceTrigger, inverted: boolean): string {
  const rising = trigger.when === "at-or-above";
  const quoted = inverted ? "token0 per token1" : "token1 per token0";
  return rising
    ? `the tick RISES to ${trigger.tick} or beyond, i.e. ${quoted} ${inverted ? "FALLS" : "RISES"} to the signed level`
    : `the tick FALLS to ${trigger.tick} or below, i.e. ${quoted} ${inverted ? "RISES" : "FALLS"} to the signed level`;
}

/**
 * Refuse a trigger that the market has ALREADY satisfied (audit A1).
 *
 * This is the check M10 wanted and the first build did not have: an independent
 * signal, read from the chain rather than re-derived from the operator's own
 * input. It catches the FINDINGS (ao) mistake in its most concrete form — a
 * stop-loss placed on the side the market has already reached fires on its
 * second observation, which is never what "stop me out IF" means.
 *
 * It is also exactly the predicate `/lp/open` and `/lp/import` refuse on
 * (`alreadySatisfiedPriceTrigger`), so the CLI refuses at signing time what the
 * routes would refuse at admission.
 */
async function assertPriceTriggerNotAlreadySatisfied(
  stack: Stack,
  label: string,
  trigger: LpPriceTrigger,
): Promise<void> {
  let currentTick: number;
  try {
    const pool = await stack.lp.readers.getPool(
      trigger.token0,
      trigger.token1,
      trigger.fee,
    );
    if (pool === null) {
      console.log(`${label}: no pool for this triple — cannot check the direction`);
      return;
    }
    currentTick = (await stack.lp.readers.poolState(pool)).currentTick;
  } catch (error) {
    // A read failure must not block an owner from signing; it blocks only the
    // CHECK, and it says so rather than passing silently.
    console.log(
      `${label}: pool state unreadable (${error instanceof Error ? error.message : "unknown"}) — direction NOT verified`,
    );
    return;
  }
  // FIXREVIEW N5: the SHARED predicate, not a second copy of the comparison.
  const fires = priceTriggerFires(trigger, currentTick);
  console.log(
    `${label}: pool tick is ${currentTick}; trigger is ${trigger.when} ${trigger.tick} => ` +
      `${fires ? "ALREADY SATISFIED" : `${Math.abs(trigger.tick - currentTick)} ticks away`}`,
  );
  if (fires) {
    throw new Error(
      `${label} is ALREADY satisfied at the current tick ${currentTick}: signing it ` +
        `would exit the position on its second observation. If the direction is ` +
        `what you meant, exit directly instead; if not, this is the FINDINGS (ao) ` +
        `mistake — for a stable/volatile pool a FALL in the token's price moves ` +
        `the tick UP.`,
    );
  }
}

async function cmdSettings(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");

  // AUDIT A5: the base is the CURRENTLY STORED settings, never the defaults.
  // The previous shape rebuilt the whole object from DEFAULT_LP_SETTINGS plus
  // only THIS run's flags, so a partial re-run to tune one knob silently
  // signed stopLossPct/takeProfitPct back to 0 and autoHarvest/autoRotate
  // back to false — disarming protection the operator believed was standing.
  // Flags now override ONLY the fields they name; booleans take an explicit
  // `--flag false` to disarm deliberately (see `boolFlag`).
  const agent = await requireAgent(stack, agentId);
  const stored = await stack.settingsStore.get(agent.ownerAddress, agentId);
  let base: LpAutomationSettings = DEFAULT_LP_SETTINGS;
  if (stored !== null) {
    const parsed = parseLpSettingsParams(stored.params);
    if (!parsed.ok) {
      throw new Error(
        `Stored LP settings are unreadable (${parsed.message}); refusing to ` +
          `overwrite a row that cannot serve as the merge base.`,
      );
    }
    base = parsed.value;
  }
  console.log(
    `settings base  : ${stored === null ? "defaults (no stored row)" : `STORED row (digest ${stored.digest})`}`,
  );

  // PHASE3.6 Rev2 M4/M10/M12: the price triggers. Absent flags keep the
  // STORED trigger (the audit-A5 merge base — without this,
  // `live-lp settings --auto-harvest` would silently un-sign the stop);
  // `--clear-price-triggers` is the explicit removal M3's rollback procedure
  // depends on.
  const clearTriggers = flags.get("clear-price-triggers") === "true";
  const priceStopLoss = clearTriggers
    ? null
    : resolvePriceTriggerFlag(flags, "stop-loss", base.priceStopLoss);
  const priceTakeProfit = clearTriggers
    ? null
    : resolvePriceTriggerFlag(flags, "take-profit", base.priceTakeProfit);

  for (const [label, trigger] of [
    ["stop-loss price trigger", priceStopLoss],
    ["take-profit price trigger", priceTakeProfit],
  ] as const) {
    // Only a trigger this run is CHANGING is checked: re-signing an untouched
    // stored trigger must not start failing because the market moved.
    if (trigger === null) continue;
    const changed =
      trigger !== (label.startsWith("stop") ? base.priceStopLoss : base.priceTakeProfit);
    if (changed) await assertPriceTriggerNotAlreadySatisfied(stack, label, trigger);
  }

  const params: Record<string, unknown> = lpSettingsParamsView({
    ...base,
    priceStopLoss,
    priceTakeProfit,
    autoRotate: boolFlag(flags, "auto-rotate", base.autoRotate),
    autoHarvest: boolFlag(flags, "auto-harvest", base.autoHarvest),
    brainEnabled: boolFlag(flags, "brain", base.brainEnabled),
    // PHASE3.1 Rev2 item 22: tri-state through the SAME `boolFlag` as every
    // other boolean — absent keeps the STORED value (audit A5), `--exit-to-quote
    // false` turns the exit swap off deliberately.
    exitToQuote: boolFlag(flags, "exit-to-quote", base.exitToQuote),
    // PHASE3.13. Absent keeps the STORED mode (audit A5's merge-base rule).
    rotateMode: rotateModeFlag(flags, base.rotateMode),
    rotateBandBps: intFlag(flags, "rotate-band-bps", base.rotateBandBps),
    rotateMinHoldMinutes: intFlag(flags, "rotate-min-hold-minutes", base.rotateMinHoldMinutes),
    stopLossPct: intFlag(flags, "stop-loss-pct", base.stopLossPct),
    takeProfitPct: intFlag(flags, "take-profit-pct", base.takeProfitPct),
    maxExitSequencesPerDay: intFlag(flags, "max-exit-sequences-day", base.maxExitSequencesPerDay),
    minMinutesBetweenExits: intFlag(flags, "min-minutes-between-exits", base.minMinutesBetweenExits),
    harvestMinFeesWei:
      flags.get("harvest-min-fees-bnb") !== undefined && flags.get("harvest-min-fees-bnb") !== "true"
        ? parseEther(flags.get("harvest-min-fees-bnb") as string)
        : base.harvestMinFeesWei,
  });
  console.log(`settings params: ${JSON.stringify(params)} (full state being signed)`);
  const envelope = await signOwnerAction("lpSettings", agentId, params);
  const { status, body } = await postOwner(stack, `/agents/${agentId}/lp/settings`, envelope);
  console.log(`\nsettings -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  if (status !== 200) process.exitCode = 1;
}

/**
 * Raise (or lower) the OFF-CHAIN daily native cap, owner-signed.
 *
 * WHY THIS EXISTS — the live run, 2026-08-16. `provision` sets
 * `caps.dailyNativeWei` to the OPEN BUDGET, so an agent may open exactly one
 * position per DAY: after a stop-loss closed its position the agent could not
 * re-enter, `DAILY_CAP`, with 84% of its on-chain cap still free. The server
 * has always had the owner action for this (`POST /agents/:id/change-budget`);
 * nothing in the repo signed it. Note what it does NOT do — the on-chain
 * session caps are untouched, and only the owner's own client can widen those.
 */
async function cmdBudget(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const capDay = flags.get("cap-day");
  if (capDay === undefined || capDay === "true") {
    throw new Error("budget requires --cap-day <BNB>, e.g. --cap-day 0.02");
  }
  const dailyNativeWei = parseEther(capDay);
  if (dailyNativeWei <= 0n) throw new Error("--cap-day must be greater than zero.");

  const agent = await requireAgent(stack, agentId);
  console.log(
    `current off-chain cap : ${agent.caps?.dailyNativeWei ?? "unset"} wei/day`,
  );
  console.log(`new off-chain cap     : ${dailyNativeWei} wei/day (${capDay} ${UNIT})`);
  console.log(
    "note                  : off-chain only. The on-chain session caps are unchanged.",
  );

  const params: Record<string, unknown> = { dailyNativeWei: dailyNativeWei.toString() };
  const envelope = await signOwnerAction("changeBudget", agentId, params);
  const { status, body } = await postOwner(
    stack,
    `/agents/${agentId}/change-budget`,
    envelope,
  );
  console.log(`\nchange-budget -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  if (status !== 200) process.exitCode = 1;
}

/**
 * PHASE3.8 F4a. Abandon a sequence whose steps all SETTLED and which is
 * nonetheless non-terminal, so it blocks every other saga on the agent.
 *
 * The state is printed BEFORE the gate for the same reason `resolve` prints
 * its row first: what an operator needs in order to decide whether to sign is
 * which steps ran and how they ended, not a yes/no prompt.
 */
async function cmdAbandon(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const sequenceId = need(flags, "sequence-id");
  const agent = await requireAgent(stack, agentId);

  const sequence = await stack.lpStore.getSequence(agent.ownerAddress, agentId, sequenceId);
  if (sequence === null) {
    throw new Error(`No sequence ${sequenceId} for this agent.`);
  }
  console.log(`sequence       : ${sequence.kind} ${sequence.state}/${sequence.recoveryState}`);
  const position = await stack.lpStore.getPosition(
    agent.ownerAddress,
    agentId,
    sequence.positionId,
  );
  console.log(
    `position       : ${sequence.positionId} ` +
      (position === null
        ? "(missing)"
        : `state=${position.state} basisWei=${position.basisWei.toString(10)}`),
  );
  console.log(
    "worker         : STOP the LP worker first, then wait at least one full worker interval before signing",
  );
  const stepRows = new Map<string, Awaited<ReturnType<ExecutionJournal["get"]>>>();
  for (const [index, step] of sequence.steps.entries()) {
    const row = await stack.journal.get(step.journalIdempotencyKey);
    stepRows.set(step.journalIdempotencyKey, row);
    console.log(
      `  step ${index} ${step.kind}: journal=${row?.state ?? "(no row observed)"}` +
        `${row?.externalRef.txHash === undefined ? "" : ` tx=${row.externalRef.txHash}`}`,
    );
  }
  const nextIndexRow = await stack.journal.getByDecision(
    agentId,
    lpStepDecisionId(sequenceId, sequence.steps.length),
  );
  console.log(
    `  next index ${sequence.steps.length}: ` +
      `${nextIndexRow === null
          ? "absent — no row observed"
          : "PRESENT — a saga is mid-flight, this will refuse"
      }`,
  );
  if (position !== null) {
    const predicted = verifyLpAbandonSequence({
      sequence,
      stepRows,
      nextIndexRow,
      positionState: position.state,
      nowMs: Date.now(),
      minIdleMs: stack.lp.lp.workerIntervalMs,
    });
    console.log(
      `predicted      : ${predicted.ok ? predicted.positionAction : `REFUSE ${predicted.code}`}`,
    );
  }

  requireYesLive(
    flags,
    "nothing on-chain: no step is retried and no COMMITTED step is undone. It " +
      "consumes an owner nonce and marks the sequence rolled-back so it stops " +
      "blocking the agent. Value that already moved STAYS WHERE IT WENT. " +
      "AND, when a liquidity-removing step already COMMITTED OR the abandoned " +
      "sequence is an open, it CLOSES the position row and ZEROES its basis — " +
      "the TP/SL anchor is gone and a re-open is a fresh lineage (AUDIT A7)",
  );

  const envelope = await signOwnerAction("abandonSequence", agentId, { sequenceId });
  const { status, body } = await postOwner(
    stack,
    `/agents/${agentId}/lp/sequences/${sequenceId}/abandon`,
    envelope,
  );
  console.log(`\nabandon -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  if (status !== 200) process.exitCode = 1;
}

async function cmdResolve(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const decisionId = need(flags, "decision-id");
  const agent = await requireAgent(stack, agentId);

  // The height WE observed at, recorded on the row and never trusted by the
  // server — it re-reads its own. A read failure is not fatal: the server
  // records `serverBlock` itself and the param is evidence, not a condition.
  let observedBlock = 0n;
  try {
    observedBlock = await meterClient.getBlockNumber();
  } catch {
    console.log("observedBlock  : chain read failed; sending 0 (the server reads its own)");
  }

  const before = await stack.journal.getByDecision(agent.id, decisionId);
  console.log(`decisionId     : ${decisionId}`);
  console.log(
    `journal row    : ${
      before === null
        ? "(not found for this agent — the route will answer 404)"
        : `${before.state} kind=${before.kind} native=${before.nativeSpendWei} wei` +
          `${before.externalRef.callsId === undefined ? "" : ` callsId=${before.externalRef.callsId}`}` +
          `${before.externalRef.resolution === undefined ? "" : " (already carries a resolution: this is an A1 RE-ENTRY)"}`
    }`,
  );
  if (before !== null) {
    console.log(`last_error     : ${before.lastError ?? "(none)"}`);
    console.log(
      `row age        : ${Math.floor((Date.now() - before.updatedAt) / 1000)}s ` +
        `(RESOLVE_MIN_AGE_SEC ${stack.lp.lp.runtime.resolveMinAgeSec})`,
    );
  }
  console.log(`observedBlock  : ${observedBlock}`);
  requireYesLive(
    flags,
    "nothing on-chain: no step is ever retried. It consumes an owner nonce and " +
      "uses finalized evidence to choose one disposition: ADVANCE records the " +
      "step COMMITTED, rolls the sequence back without replay, and closes an exit " +
      "position; ABANDON records ROLLED_BACK and restores an exit position to open. " +
      "Any funds the stuck step freed STAY IN THE WALLET",
  );

  const params: Record<string, unknown> = {
    decisionId,
    observedBlock: observedBlock.toString(10),
  };
  const envelope = await signOwnerAction("resolveUnknown", agentId, params);
  const { status, body } = await postOwner(
    stack,
    `/agents/${agentId}/journal/${decisionId}/resolve`,
    envelope,
  );
  console.log(`\nresolve -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));

  // The server's OWN findings, laid out. Read back from the store rather than
  // re-stated from the response, because the persisted record is the receipt.
  const actionKey = ownerActionIdempotencyKey(envelope.struct);
  const stepRow = await stack.journal.getByDecision(agent.id, decisionId);
  const actionRow = await stack.journal.get(actionKey);
  const recorded =
    stepRow?.externalRef.resolution ?? actionRow?.externalRef.resolution ?? null;
  if (recorded === null) {
    console.log(
      "\nrecorded evidence: none. Either the route refused before ownership was " +
        "established (a byte-identical 404) or the row was never touched.",
    );
  } else {
    console.log(
      `\nrecorded evidence (${
        stepRow?.externalRef.resolution === undefined
          ? "the ACTION's own row — a REFUSAL, audit A7"
          : "the resolved step row"
      }):`,
    );
    console.log(`  owner        : ${recorded.ownerAddress}`);
    console.log(`  observedBlock: ${recorded.observedBlock} (the caller's claim)`);
    console.log(`  serverBlock  : ${recorded.serverBlock ?? "unavailable"}`);
    console.log(
      `  positionBlock: ${recorded.positionEvidenceBlock ?? "not used"} ` +
        "(finalized height for position evidence)",
    );
    console.log(`  disposition  : ${recorded.disposition}`);
    console.log("  checks       :");
    for (const check of recorded.checks) {
      console.log(`    - ${check.name}: ${check.result}`);
    }
    for (const leg of recorded.legs) {
      console.log(
        `    leg ${leg.token}: needs ${leg.neededWei}, wallet ${leg.walletWei}, ` +
          `discriminating=${leg.discriminating}`,
      );
    }
    console.log(
      `  logAbsence   : ${recorded.logAbsence.checked ? "checked" : "unavailable"} — ${recorded.logAbsence.detail}`,
    );
  }
  if (stepRow !== null) {
    console.log(
      `\nstep row now   : ${stepRow.state}; last_error ${
        stepRow.lastError === null ? "(none)" : "PRESERVED"
      }`,
    );
  }
  const sequenceId = lpSequenceIdOfStepDecision(decisionId);
  if (sequenceId !== null) {
    await printSequence(stack, agent.ownerAddress, agentId, sequenceId);
  }
  if (status !== 200) process.exitCode = 1;
}

async function cmdResolveLanding(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const decisionId = need(flags, "decision-id");
  const agent = await requireAgent(stack, agentId);
  const before = await stack.journal.getByDecision(agent.id, decisionId);
  console.log(`decisionId     : ${decisionId}`);
  console.log(`journal row    : ${before === null ? "(not found)" : `${before.state} kind=${before.kind}`}`);
  console.log(`prepared bind  : ${before?.preparedIntentIdentityHash ?? "unavailable (legacy row)"}`);
  requireYesLive(flags,
    "nothing on-chain: consumes one owner nonce, reads the durable all-source finalized " +
    "coverage ledger, and either records the proven landing COMMITTED, records proven " +
    "post-expiry absence ROLLED_BACK, or leaves the target UNKNOWN. It has no submit capability");
  const envelope = await signOwnerAction("resolveUnknownLandingV1", agentId, {
    decisionId, evidenceVersion: "lp-landing-evidence-v1",
  });
  const { status, body } = await postOwner(stack,
    `/agents/${agentId}/journal/${decisionId}/resolve-landing/v1`, envelope);
  console.log(`\nresolve-landing -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  const data = (body["data"] ?? {}) as Record<string, unknown>;
  if (typeof data["evidenceDigest"] === "string") {
    console.log(`\nevidence digest: ${data["evidenceDigest"]}`);
    console.log(`retained until : ${String(data["evidenceRetainedUntil"] ?? "not terminal")}`);
  }
  if (status !== 200 && status !== 202) process.exitCode = 1;
}

/**
 * `preview` and `import` (PHASE3.4). PHASE3.3's audit had to point out that
 * its route shipped with no caller in `scripts/` — the phase built to end
 * "terminal-until-operator names an operator with no way to act" reproduced
 * that shape one layer up. These land in the same pass as the routes.
 *
 * `preview` is a READ: no nonce, no gate, no side effect. It is also the thing
 * an owner must see BEFORE signing, because the signature carries a
 * `basisWei` that becomes the TP/SL anchor.
 */
async function cmdPreview(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const tokenId = need(flags, "token-id");
  const agent = await requireAgent(stack, agentId);
  console.log(`agent          : ${agent.id} wallet ${agent.walletAddress}`);
  const { status, body } = await getOwnerRead(
    stack,
    agentId,
    `/agents/${agentId}/lp/importable/${tokenId}`,
  );
  console.log(`\npreview -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  if (status !== 200) process.exitCode = 1;
}

async function cmdImport(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const tokenId = need(flags, "token-id");
  const basisWei = flags.get("basis-wei") ?? parseEther(flags.get("basis-bnb") ?? "0").toString(10);
  const agent = await requireAgent(stack, agentId);
  console.log(`agent          : ${agent.id} wallet ${agent.walletAddress}`);
  console.log(`tokenId        : ${tokenId}`);
  console.log(
    `basisWei       : ${basisWei}${
      basisWei === "0"
        ? " (ZERO: the position will be rotated and compounded, and NO stop-loss or take-profit will EVER fire for it)"
        : " — YOUR declaration, not a measurement. This becomes the TP/SL anchor."
    }`,
  );

  // Print exactly what the server will check, BEFORE the gate — the same
  // assessment, through the same code, so the operator signs against what they
  // just read rather than against a number this script re-derived.
  const preview = await getOwnerRead(
    stack,
    agentId,
    `/agents/${agentId}/lp/importable/${tokenId}`,
  );
  console.log("\nserver assessment (the preview route, verbatim):");
  console.log(JSON.stringify(preview.body, null, 2));

  requireYesLive(
    flags,
    "nothing on-chain: the NFT does not move and no call is submitted. It " +
      "consumes an owner nonce and records ONE position row, after which the " +
      "worker may rotate, harvest, protect and exit this position",
  );

  const params: Record<string, unknown> = { tokenId, basisWei };
  const envelope = await signOwnerAction("lpImport", agentId, params);
  const { status, body } = await postOwner(stack, `/agents/${agentId}/lp/import`, envelope);
  console.log(`\nimport -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  if (status !== 200) process.exitCode = 1;
}

async function cmdOpen(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const token = needAddress(flags, "token");
  const fee = intFlag(flags, "fee", 2500);
  const budget = flags.get("budget") ?? "0.003";
  const budgetWei = parseEther(budget);
  const measure = flags.get("measure-relay-fee") === "true";

  const wbnb = stack.lp.addresses.wbnb;
  const [token0, token1] =
    wbnb.toLowerCase() < token.toLowerCase() ? [wbnb, token] : [token, wbnb];
  const lowerRaw = flags.get("range-lower");
  const upperRaw = flags.get("range-upper");
  const range =
    lowerRaw !== undefined && upperRaw !== undefined
      ? { tickLower: Number(lowerRaw), tickUpper: Number(upperRaw) }
      : ("server-fenced" as const);

  console.log(`open           : pool (${token0}, ${token1}, ${fee})`);
  console.log(`budget         : ${budgetWei} wei (${budget} ${UNIT})`);
  console.log(`range          : ${typeof range === "string" ? range : `[${range.tickLower}, ${range.tickUpper}]`}`);
  requireYesLive(
    flags,
    `${budget} ${UNIT} (the owner-signed open budget: swap leg + mint{value} + refund) plus relay gas`,
  );

  const agent = await requireAgent(stack, agentId);
  const before = measure ? await readNativeDayMeter(agent) : null;

  const envelope = await signOwnerAction("lpOpen", agentId, {
    pool: { token0, token1, fee },
    range,
    budgetWei: budgetWei.toString(10),
  });
  const { status, body } = await postOwner(stack, `/agents/${agentId}/lp/open`, envelope);
  console.log(`\nopen -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  const data = (body["data"] ?? {}) as Record<string, unknown>;
  const open = (data["open"] ?? {}) as Record<string, unknown>;
  const sequenceId = typeof open["sequenceId"] === "string" ? open["sequenceId"] : "";
  await printSequence(stack, agent.ownerAddress, agentId, sequenceId);
  if (measure) {
    const after = await readNativeDayMeter(agent);
    const submissions = await countSubmissions(stack, agent.ownerAddress, agentId, sequenceId);
    reportMeterDelta(before, after, budgetWei, Math.max(1, submissions));
  }
  if (status !== 200) process.exitCode = 1;
}

async function cmdStatus(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const agent = await requireAgent(stack, agentId);
  console.log(`agent          : ${agent.id} owner ${agent.ownerAddress} status ${agent.status}`);
  console.log(`wallet         : ${agent.walletAddress}`);
  const meter = await readNativeDayMeter(agent);
  if (meter !== null) {
    console.log(
      `native meter   : limit ${meter.limit} wei/day, currentSpent ${meter.currentSpent} wei`,
    );
  }
  const positions = await stack.lpStore.listPositions(agent.ownerAddress, agent.id);
  console.log(`positions      : ${positions.length}`);
  for (const position of positions) {
    console.log(
      `  ${position.positionId}: state=${position.state} tokenId=${position.tokenId ?? "(pending)"} ` +
        `fee=${position.fee} basis=${position.basisWei} wei lineage=${position.lineageId}`,
    );
  }
  const sequences = await stack.lpStore.listSequences(agent.ownerAddress, agent.id);
  console.log(`sequences      : ${sequences.length}`);
  for (const sequence of sequences) {
    await printSequence(stack, agent.ownerAddress, agent.id, sequence.sequenceId);
  }
}

async function cmdHarvest(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const positionId = need(flags, "position-id");
  const measure = flags.get("measure-relay-fee") === "true";
  requireYesLive(
    flags,
    `relay gas only (up to ${MAX_SUBMISSIONS_PER_SEQUENCE} submissions; the compounded principal moves as WBNB under exact approves)`,
  );
  const agent = await requireAgent(stack, agentId);
  const before = measure ? await readNativeDayMeter(agent) : null;
  const deps = await operatorSagaDeps(stack, agent, positionId);
  const result = await runLpHarvest(deps.base, positionId);
  reportSagaResult("HARVEST", result);
  await printSequence(stack, agent.ownerAddress, agentId, result.sequenceId);
  if (measure) {
    const after = await readNativeDayMeter(agent);
    const submissions = await countSubmissions(stack, agent.ownerAddress, agentId, result.sequenceId);
    reportMeterDelta(before, after, 0n, submissions);
  }
  if (result.status !== "completed") process.exitCode = 1;
}

async function cmdRotate(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const positionId = need(flags, "position-id");
  const measure = flags.get("measure-relay-fee") === "true";
  requireYesLive(
    flags,
    `relay gas only (up to ${MAX_SUBMISSIONS_PER_SEQUENCE} submissions; the re-minted principal moves as WBNB/token under exact approves)`,
  );
  const agent = await requireAgent(stack, agentId);
  const before = measure ? await readNativeDayMeter(agent) : null;
  const deps = await operatorSagaDeps(stack, agent, positionId);
  const result = await runLpRotate(await deps.rotate(), positionId);
  reportSagaResult("ROTATE", result);
  await printSequence(stack, agent.ownerAddress, agentId, result.sequenceId);
  if (measure) {
    const after = await readNativeDayMeter(agent);
    const submissions = await countSubmissions(stack, agent.ownerAddress, agentId, result.sequenceId);
    reportMeterDelta(before, after, 0n, submissions);
  }
  if (result.status !== "completed") process.exitCode = 1;
}

async function cmdClose(stack: Stack, flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const positionId = need(flags, "position-id");
  const measure = flags.get("measure-relay-fee") === "true";
  requireYesLive(
    flags,
    "relay gas for up to TWO submissions (zap-out, then the exit swap when " +
      "exitToQuote is on); the position's proceeds return to the wallet as native BNB",
  );
  const agent = await requireAgent(stack, agentId);
  const before = measure ? await readNativeDayMeter(agent) : null;
  const envelope = await signOwnerAction("lpExit", agentId, { positionId });
  const { status, body } = await postOwner(
    stack,
    `/agents/${agentId}/lp/${positionId}/exit`,
    envelope,
  );
  console.log(`\nclose -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  const data = (body["data"] ?? {}) as Record<string, unknown>;
  const exit = (data["exit"] ?? {}) as Record<string, unknown>;
  const sequenceId = typeof exit["sequenceId"] === "string" ? exit["sequenceId"] : "";
  await printSequence(stack, agent.ownerAddress, agentId, sequenceId);
  if (measure) {
    const after = await readNativeDayMeter(agent);
    const submissions = await countSubmissions(stack, agent.ownerAddress, agentId, sequenceId);
    reportMeterDelta(before, after, 0n, Math.max(1, submissions));
  }
  if (status !== 200) process.exitCode = 1;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

const USAGE = `usage: npm run live-lp -- <subcommand> [flags]

  provision --agent-id <id> --token 0x... [--cap-day 0.02] [--open-budget 0.003]
            [--expected-sequences-day N] [--max-exit-sequences-day 4] [--ttl-sec 86400] --yes-live
  settings  --agent-id <id> [--auto-rotate [true|false]] [--auto-harvest [true|false]] [--stop-loss-pct N]
            [--take-profit-pct N] [--harvest-min-fees-bnb 0.0001] [--min-minutes-between-exits 5]
            [--max-exit-sequences-day N] [--rotate-band-bps N] [--rotate-min-hold-minutes N]
            [--brain [true|false]] [--exit-to-quote [true|false]]
            [--rotate-mode swapped|swapless] --yes-live
              (PHASE3.13: "swapless" skips the rotate's balancing swap and parks the
               prior width BESIDE the price on the side the principal is already on.
               Cheaper by one submission, one pool fee and that leg's slippage — and it
               CHANGES EXPOSURE: the position earns nothing until price returns, does
               NOT re-center, auto-harvest stays inert while parked, and up to 50 bps of
               the freed value is left in the WALLET, disclosed in the sequence note.
               "swapped" is the default and is today's behaviour.)
            (merges over the STORED settings — flags change only the fields they
             name; pass an explicit "false" to disarm an armed boolean)
            [--stop-loss-price N --stop-loss-when at-or-below|at-or-above]
            [--take-profit-price N --take-profit-when …]
            [--stop-loss-price-inverted] [--take-profit-price-inverted]
            [--trigger-token0 0x… --trigger-token1 0x… --trigger-fee 100]
            [--trigger-decimals0 18 --trigger-decimals1 18]
            [--clear-price-triggers]
            (PHASE3.6 price triggers. The PRICE is a convenience: what gets
             SIGNED is a TICK plus a DIRECTION, and the command prints both,
             plus the tick's exact price and its neighbour, before signing.
             --…-price-inverted means the number you typed is token0-per-token1
             (USDT per BNB when USDT is token0) — the common case. A trigger the
             market has ALREADY satisfied is REFUSED, because signing it would
             exit on the second observation. --clear-price-triggers removes both
             and is REQUIRED before rolling back to a build without these keys:
             such a build cannot parse the settings row at all and will skip the
             position for ever — no rotate, no harvest, NO STOP-LOSS.)
  budget    --agent-id <id> --cap-day <BNB> --yes-live
            (the OFF-CHAIN daily native cap this server enforces; provision
             sets it to one open budget, so raise it to re-open in one day)
  open      --agent-id <id> --token 0x... [--fee 2500] [--budget 0.003]
            [--range-lower N --range-upper N] [--measure-relay-fee] --yes-live
  preview   --agent-id <id> --token-id <n>
            (a signed READ — no nonce, no gate. Answers whether an NFPM
             position you already hold can be put under automation, and shows
             the value, the exit-impact probe and the worst-case conversion the
             basis should be signed against)
  import    --agent-id <id> --token-id <n> [--basis-wei <n> | --basis-bnb 0.05] --yes-live
            (puts a position you minted BY HAND under automation. The NFT does
             not move and nothing is submitted on chain; basisWei is YOUR
             declaration and becomes the TP/SL anchor. 0 is legal and means
             rotate + compound with no VALUE stop-loss — a PRICE trigger, if one
             is armed for that pool, protects regardless of the basis)
  status    --agent-id <id>
  harvest   --agent-id <id> --position-id <uuid> [--measure-relay-fee] --yes-live
  rotate    --agent-id <id> --position-id <uuid> [--measure-relay-fee] --yes-live
  close     --agent-id <id> --position-id <uuid> [--measure-relay-fee] --yes-live
  abandon   --agent-id <id> --sequence-id <uuid> --yes-live
            (STOP the LP worker first. Prints the current position state and
             basisWei, every observed journal row, and the predicted close /
             restore-open / leave disposition before the confirmation gate.)
  resolve   --agent-id <id> --decision-id lp:<sequenceId>:<n> --yes-live
             (the operator half of UNKNOWN: owner-signs the resolution of ONE
              stuck LP step. Finalized direct evidence may ADVANCE a completed
              zap-out; otherwise it ABANDONS. It spends nothing on chain, retries
              no step, and prints every check plus the evidence block it stored.
              Re-running it after an interrupted attempt is SAFE and is the cure
             — see PHASE3.3-AUDIT A1)
  resolve-landing --agent-id <id> --decision-id lp:<sequenceId>:<n> --yes-live
             (Phase 3.9c v1. Reads only the durable, finalized all-required-
              source coverage ledger. It never accepts a tx hash, never retries
              a step and never submits. HTTP 202 means another fenced resolver
              owns the current lease; a retry is safe.)

Every spending subcommand REFUSES without --yes-live and prints what it would spend.`;

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  console.log(`live-lp        : chain ${NETWORK.chainId} (${NETWORK_LABEL})`);

  if (subcommand === "provision") {
    // Provision needs no server app — it is the grant + the row, like
    // provision-agent. Everything else runs against the in-process stack.
    await cmdProvision(flags);
    return;
  }

  if (
    subcommand !== "settings" &&
    subcommand !== "budget" &&
    subcommand !== "open" &&
    subcommand !== "status" &&
    subcommand !== "harvest" &&
    subcommand !== "rotate" &&
    subcommand !== "close" &&
    subcommand !== "resolve" &&
    subcommand !== "resolve-landing" &&
    subcommand !== "abandon" &&
    subcommand !== "preview" &&
    subcommand !== "import"
  ) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // `settings` consumes a nonce but spends nothing on-chain; it still goes
  // through the gate so that "ran a live-lp command casually" is impossible
  // by construction.
  if (subcommand === "settings") {
    requireYesLive(flags, "nothing on-chain (an owner-signed settings write)");
  }
  if (subcommand === "budget") {
    requireYesLive(flags, "nothing on-chain (an owner-signed off-chain cap change)");
  }

  const stack = await buildStack();
  try {
    if (subcommand === "settings") await cmdSettings(stack, flags);
    else if (subcommand === "budget") await cmdBudget(stack, flags);
    else if (subcommand === "open") await cmdOpen(stack, flags);
    else if (subcommand === "status") await cmdStatus(stack, flags);
    else if (subcommand === "harvest") await cmdHarvest(stack, flags);
    else if (subcommand === "rotate") await cmdRotate(stack, flags);
    // `resolve` gates INSIDE the command, after printing the row it would act
    // on: an operator must see the state, the age and the last error before the
    // gate, because those are what tell them whether to sign at all.
    else if (subcommand === "resolve") await cmdResolve(stack, flags);
    else if (subcommand === "resolve-landing") await cmdResolveLanding(stack, flags);
    else if (subcommand === "abandon") await cmdAbandon(stack, flags);
    else if (subcommand === "preview") await cmdPreview(stack, flags);
    // `import` gates INSIDE the command, after printing the server's own
    // assessment: an operator must see what they are signing a basis against.
    else if (subcommand === "import") await cmdImport(stack, flags);
    else await cmdClose(stack, flags);
  } finally {
    await stack.close();
  }
}

main().catch((error: unknown) => {
  // Never dump the error object: provider errors can carry request bodies.
  const message = error instanceof Error ? error.message : "unknown error";
  if (message !== "--yes-live not supplied") {
    console.error(`\nlive-lp failed: ${message}`);
  }
  process.exitCode = 1;
});
