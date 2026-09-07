/**
 * live-grid — the PHASE3.15 operator script for the two-range grid ping-pong.
 *
 * SUBCOMMANDS
 *   arm        PHASE3.16, and THE ENTRY PATH. Owner-sign ONE `gridArm`
 *              envelope carrying the COMPLETE settings plus a native
 *              `budgetWei`: the plane validates admission, persists the
 *              settings, creates the position row and mints the first level
 *              single-sided into the derived `buyRange`. The ranges come from a
 *              PRESET converted against the pool's own tick spacing and the
 *              CURRENT tick, optionally scaled by a spread factor — the
 *              operator picks an amount and a shape, never ticks. The preset
 *              NAME does not ride on the envelope (it has no chain
 *              counterpart); the auditable provenance is the derived ranges.
 *   settings   owner-sign `lpSettings` carrying the `grid` block, through the
 *              REAL route — so the whole admission surface runs: `gateLpPool`
 *              verbatim, the C1 cross-check of the SIGNED `wbnbIsToken0` and
 *              `tickSpacing` against the pool's own read, the LP_MAX_TICK_WIDTH
 *              ceiling, the first-arming idle gate, and (under a live level)
 *              C2's keep-one-range rule plus the re-run net-edge admission.
 *              MERGES over the STORED row, the `live-lp settings` discipline:
 *              a flag changes only the field it names.
 *   preview    read-only. `GET /agents/:id/lp/importable/:tokenId` plus the
 *              grid-specific verdict: which signed level this NFT IS, which
 *              side it charges, and what the flip would target.
 *   import     owner-sign `lpImport` for the hand-minted level. This is the
 *              grid's ONLY entry path — there is no grid open, because
 *              `/lp/open` refuses a single-sided out-of-range mint by design
 *              and a grid level is exactly that.
 *   status     read-only: the `grid` section of `GET /agents/:id/lp` —
 *              signed ranges, the live level as of the LAST OBSERVATION,
 *              the cross count, the quota lane, recorded cycles, the latency
 *              formula, and any blocking sequence with its remedy.
 *   flip       drive `runLpGridFlip` for one position, operator-initiated.
 *              There is no HTTP route for it by design (it is worker
 *              territory); this calls the runner with the same deps the worker
 *              builds, so every in-saga gate stays in force.
 *   close      owner-sign one manual exit, or `--all`: confirm pause, refresh,
 *              refuse blockers, then drive one existing `lpExit` saga per
 *              non-closed position serially.
 *
 * THE SPIKE-SCRIPT LESSON, ENFORCED: `arm`, `flip`, `import` and `close` REFUSE
 * without `--yes-live` after printing what they would spend. `settings` is
 * owner-signed and spends only gas-free bookkeeping, but it CHANGES what the
 * worker will do with money, so it is gated too. `preview` and `status` are the
 * read-only exceptions. `arm` is the only subcommand here that attaches NATIVE.
 *
 * WHAT THIS SCRIPT WILL ONLY OFFER, deliberately: WBNB-leg pools. The arm funds
 * a WBNB level, and the server's own refusal is meant to be the second net
 * rather than the first experience — the same product requirement holds for the
 * marketplace UI's pool picker.
 *
 * THE HAND-MINT PATH IS STILL HERE and still correct: `settings` + a
 * hand-minted single-sided range order + `import`. It is the door for an
 * operator who wants ticks they chose themselves, or who already holds a level.
 * After an abandon it is also free — the inventory is already the asset the
 * next level wants — but so is re-signing `arm`, which is now the shorter road.
 *
 * KEYS: the owner key is read via `readEnvValue` (process env, then `.env` /
 * `.env.local`, read-only), used to sign, and NEVER logged or persisted.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getAddress,
  isAddress,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { createServer, type ServerConfig } from "../src/server.js";
import { createAgentStore } from "../src/store/agents.js";
import { createJournal } from "../src/store/journal.js";
import { createNonceStore } from "../src/store/nonces.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { createProviderRegistry } from "../src/wallet/registry.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import { HttpDataPlaneClient } from "../src/clients/dataPlane.js";
import {
  resolveGridEnabled,
  resolveLpEnabled,
  resolveTradeConfig,
} from "../src/ops/config.js";
import { buildLpServerDeps, type BuiltLpServerDeps } from "../src/lp/wiring.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { runLpGridFlip, type LpGridFlipDeps } from "../src/lp/sagas.js";
import { runCloseAllWorkflow } from "./live-grid-close-all.js";
import {
  GRID_DUAL_SPLIT_BPS,
  gridDeriveDualRanges,
  gridDeriveRanges,
  gridDualSellSizeWei,
  gridDualSwapInWei,
  gridCycleSubmissions,
  gridLiveRole,
  gridNetEdge,
  gridLadderEconomics,
  gridLadderResilience,
  gridShiftEconomics,
  gridShiftDriftMotionsPerDay,
  gridNetEdgePair,
  gridPair,
  gridPresetMinEconomicSizeWei,
  gridQuantizeUpToSpacing,
  gridRangeList,
  gridRangeMidpointTick,
  gridRequoteDefaultClamp,
  gridRoleAtFor,
  gridTargetRange,
  gridTargetSide,
  LP_GRID_IDENTITY_MISSING_REASON,
} from "../src/lp/gridTriggers.js";
import {
  DEFAULT_GRID_MAX_REQUOTES_PER_DAY,
  DEFAULT_GRID_LADDER_DEPLOY_PCT_BPS,
  DEFAULT_GRID_SHIFT_DEPLOY_PCT_BPS,
  DEFAULT_GRID_SHIFT_DRIFT_PCT,
  DEFAULT_GRID_SHIFT_SHIFTS_PER_DAY,
  DEFAULT_GRID_LADDER_DRIFT_PCT,
  DEFAULT_GRID_LADDER_MAX_HEDGE_PCT_BPS,
  DEFAULT_GRID_LADDER_SETTLEMENTS_PER_DAY,
  DEFAULT_GRID_LADDER_DRIFT_MOVES_PER_DAY,
  ladderMotionCounts,
  ladderStrandedMinutes,
  type LpGridLadder,
  DEFAULT_GRID_REQUOTE_DRIFT_PCT,
  ladderMinMarkoutBps,
  DEFAULT_LP_SETTINGS,
  gridModeOf,
  type LpAutomationSettings,
  type LpGridRange,
  type LpGridSettings,
  type LpGridShift,
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
import { DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI } from "../src/ops/policy.js";
import { MAX_TICK, MIN_TICK } from "../src/lp/tickMath.js";
import { readEnvValue } from "./spike/env.js";

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

const IS_MAINNET = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
const NETWORK: NetworkConfig = IS_MAINNET ? BNB : BNB_TESTNET;
const NETWORK_LABEL = IS_MAINNET ? "mainnet" : "testnet";
const KEY_STORE = getAddress(NETWORK.keyStore);

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

export type Flags = Map<string, string>;

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

function booleanFlag(flags: Flags, name: string, fallback: boolean): boolean {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}

function rangeFlag(flags: Flags, name: string, fallback?: LpGridRange): LpGridRange {
  const raw = flags.get(name);
  if (raw === undefined || raw === "true") {
    if (fallback === undefined) throw new Error(`--${name} is required (lower:upper).`);
    return fallback;
  }
  const [lower, upper] = raw.split(":");
  if (lower === undefined || upper === undefined) {
    throw new Error(`--${name} must be written lower:upper, e.g. --${name} -101000:-100200`);
  }
  const tickLower = Number(lower);
  const tickUpper = Number(upper);
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) {
    throw new Error(`--${name} ticks must be integers.`);
  }
  return { tickLower, tickUpper };
}

/**
 * The never-casually-runnable gate, verbatim from `live-lp`. It prints what the
 * command WOULD do and refuses without the explicit flag — on testnet too,
 * because the habit is the protection.
 */
function requireYesLive(flags: Flags, wouldSpend: string): void {
  if (flags.get("yes-live") === "true") return;
  console.error(
    `\nREFUSED: this command acts for real on chain ${NETWORK.chainId} (${NETWORK_LABEL}).\n` +
      `It would: ${wouldSpend}\n` +
      `Re-run with --yes-live if that is what you want. Nothing was sent.`,
  );
  process.exitCode = 1;
  throw new Error("--yes-live not supplied");
}

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

/* -------------------------------------------------------------------------- */
/* Owner-action signing                                                       */
/* -------------------------------------------------------------------------- */

type SignedEnvelope = {
  readonly signed: Record<string, unknown>;
  readonly signature: Hex;
  readonly params: unknown;
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
    nonce: keccak256(stringToBytes(`live-grid-${randomUUID()}`)),
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
  };
}

/* -------------------------------------------------------------------------- */
/* The in-process stack                                                       */
/* -------------------------------------------------------------------------- */

type Stack = {
  readonly app: ReturnType<typeof createServer>;
  readonly execToken: string;
  readonly agentStore: Awaited<ReturnType<typeof createAgentStore>>;
  readonly journal: Awaited<ReturnType<typeof createJournal>>;
  readonly killswitch: Awaited<ReturnType<typeof createKillSwitch>>;
  readonly provider: AltanaProvider;
  readonly lp: BuiltLpServerDeps;
  close(): Promise<void>;
};

async function buildStack(): Promise<Stack> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required: live-grid drives the REAL persisted stores so the "
        + "server and worker see what it does. A memory store would vanish with this process.",
    );
  }
  if (!resolveLpEnabled(process.env)) {
    throw new Error('LP_ENABLED must be "true"; the grid rides the LP plane.');
  }
  // The L3 pair check lives in the resolver, so this ALSO refuses the
  // inconsistent configuration rather than producing a script that appears to
  // work while the worker skips every grid agent.
  if (!resolveGridEnabled(process.env)) {
    throw new Error(
      'GRID_ENABLED must be "true" for live-grid; it is the grid master switch, and '
        + "signing a grid block this runtime will not honour is refused by the route anyway.",
    );
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

  const execToken = `live-grid-${randomUUID()}`;
  const envSalt = process.env["EXECUTION_ENV_SALT"]?.trim();
  const config: ServerConfig = {
    chainId: NETWORK.chainId,
    network: NETWORK_LABEL,
    keyStore: KEY_STORE,
    execToken,
    operatorToken: `live-grid-op-${randomUUID()}`,
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
    async close(): Promise<void> {
      lp.evidence?.observer.stop();
      for (const closeable of [
        journal,
        nonceStore,
        killswitch,
        agentStore,
        lp.lp.store,
        lp.lp.settingsStore,
        ...(lp.gridCycles === undefined ? [] : [lp.gridCycles]),
      ]) {
        try {
          await closeable.close();
        } catch {
          /* independent closes */
        }
      }
    },
  };
}

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
  return readBody(response);
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
    body: JSON.stringify(envelope),
  });
  return readBody(response);
}

async function readBody(
  response: Response,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: { raw: text } };
  }
}

function show(label: string, value: unknown): void {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(value, null, 2));
}

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The stored settings, parsed — the MERGE BASE (`live-lp settings`' audit A5
 * discipline: a partial re-run must not silently un-sign a field it never
 * mentioned). Absent ⇒ the plane's own defaults.
 */
async function storedSettings(
  stack: Stack,
  agentId: string,
  ownerAddress: Address,
): Promise<LpAutomationSettings> {
  const row = await stack.lp.lp.settingsStore.get(ownerAddress, agentId);
  if (row === null) return DEFAULT_LP_SETTINGS;
  const parsed = parseLpSettingsParams(row.params);
  if (!parsed.ok) {
    throw new Error(
      `The stored settings row does not parse (${parsed.message}); refusing to merge over settings this build cannot read.`,
    );
  }
  return parsed.value;
}

async function commandSettings(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const stack = await buildStack();
  try {
    const owner = privateKeyToAccount(ownerKey()).address;
    const current = await storedSettings(stack, agentId, owner);

    if (flags.get("clear-grid") === "true") {
      const params = lpSettingsParamsView({ ...current, grid: null });
      requireYesLive(
        flags,
        `CLEAR the grid block for ${agentId}. The worker stops managing it as a grid; the level stays where it is.`,
      );
      const result = await postOwner(
        stack,
        `/agents/${agentId}/lp/settings`,
        await signOwnerAction("lpSettings", agentId, params),
      );
      show(`POST /lp/settings (${result.status})`, result.body);
      return;
    }

    const existing = current.grid;
    const pool = {
      token0: flags.has("token0")
        ? needAddress(flags, "token0")
        : existing?.pool.token0 ?? needAddress(flags, "token0"),
      token1: flags.has("token1")
        ? needAddress(flags, "token1")
        : existing?.pool.token1 ?? needAddress(flags, "token1"),
      fee: intFlag(flags, "fee", existing?.pool.fee ?? 2_500),
    };
    // The ORIENTATION and the SPACING are SIGNED (C1) and cross-checked at the
    // route against its own pool read. They are derived here for the operator's
    // convenience — `wbnbIsToken0` from the configured WBNB, the spacing from
    // the pool — but what reaches the signature is what the route verifies.
    const wbnb = stack.lp.lp.venue.wbnb.toLowerCase();
    const wbnbIsToken0 = pool.token0.toLowerCase() === wbnb;
    if (!wbnbIsToken0 && pool.token1.toLowerCase() !== wbnb) {
      throw new Error("Neither leg is the configured WBNB; v1 refuses pools without one.");
    }
    const poolAddress = await stack.lp.readers.getPool(pool.token0, pool.token1, pool.fee);
    if (poolAddress === null) {
      throw new Error("No pool exists for those legs and that fee tier.");
    }
    const state = await stack.lp.readers.poolState(poolAddress);

    const grid: LpGridSettings = {
      pool,
      wbnbIsToken0,
      tickSpacing: intFlag(flags, "tick-spacing", state.tickSpacing),
      buyRange: rangeFlag(flags, "buy-range", existing?.buyRange),
      sellRange: rangeFlag(flags, "sell-range", existing?.sellRange),
      maxFlipsPerDay: intFlag(flags, "max-flips-per-day", existing?.maxFlipsPerDay ?? 12),
      minNetEdgeBps: intFlag(flags, "min-net-edge-bps", existing?.minNetEdgeBps ?? 0),
      ...requoteBlockFrom(flags, {
        existing: existing ?? undefined,
        maxFlipsPerDay: intFlag(flags, "max-flips-per-day", existing?.maxFlipsPerDay ?? 12),
        minMinutesBetweenExits: current.minMinutesBetweenExits,
        policy:
          flags.get("policy-gap-ticks") === undefined
            ? undefined
            : {
                gapTicks: intFlag(flags, "policy-gap-ticks", 0),
                widthTicks: intFlag(flags, "policy-width-ticks", 0),
              },
      }).block,
    };

    // What the owner is about to sign, in the vocabulary the geometry is
    // actually decided in — POOL ORDER, never buy/sell alone. A side rule
    // written in role order inverts for roughly half of BSC's WBNB pools.
    console.log(
      `\nGRID, as it will be signed (pool ${poolAddress}, tick ${state.currentTick}):\n`
        + `  wbnbIsToken0 ${grid.wbnbIsToken0} (the quote is ${grid.wbnbIsToken0 ? "token0" : "token1"})\n`
        + `  tickSpacing  ${grid.tickSpacing} (the pool reports ${state.tickSpacing})\n`
        + `  buyRange     [${grid.buyRange.tickLower}, ${grid.buyRange.tickUpper})  — holds the QUOTE, `
        + `${grid.wbnbIsToken0 ? "ABOVE" : "BELOW"} the price\n`
        + `  sellRange    [${grid.sellRange.tickLower}, ${grid.sellRange.tickUpper})  — holds the BASE, `
        + `${grid.wbnbIsToken0 ? "BELOW" : "ABOVE"} the price\n`
        + `  maxFlipsPerDay ${grid.maxFlipsPerDay}  minNetEdgeBps ${grid.minNetEdgeBps}\n`
        + `  midpoints    buy ${gridRangeMidpointTick(grid.buyRange)}, sell ${gridRangeMidpointTick(grid.sellRange)}`,
    );
    console.log(
      `\n  CYCLE RATE: at minMinutesBetweenExits ${current.minMinutesBetweenExits} the agent-wide `
        + `spacing gate allows at most ${Math.floor(1440 / current.minMinutesBetweenExits)} sequences a day. `
        + `That gate — not maxFlipsPerDay — is what floors a grid's rate, and the settings validator refuses `
        + `a maxFlipsPerDay it makes unreachable.`,
    );
    console.log(
      requoteBlockFrom(flags, {
        existing: existing ?? undefined,
        maxFlipsPerDay: grid.maxFlipsPerDay,
        minMinutesBetweenExits: current.minMinutesBetweenExits,
        policy: grid.policy,
      }).transcript,
    );

    const params = lpSettingsParamsView({
      ...current,
      // A grid agent runs the ping-pong and nothing else; the validator refuses
      // the contradiction, so disarm them here rather than making the operator
      // discover it from a 400.
      autoRotate: false,
      autoHarvest: false,
      grid,
    });
    const shiftConfirmation = grid.shift === undefined
      ? null
      : shiftSettingsConfirmation(grid.shift);
    requireYesLive(
      flags,
      grid.shift === undefined
        ? `sign lpSettings for ${agentId} with a grid block. Automation armed under the previous digest refuses between steps and re-arms under this one.`
        : `sign lpSettings for ${agentId} with shift mode: cross settlement and clean drift may target two rungs (12 calls), `
          + `${grid.shift.driftPctOfGap === 0 ? "drift is disabled" : "mid-fill drift targets only the clean rung (7 calls)"}. `
          + shiftConfirmation,
    );
    const result = await postOwner(
      stack,
      `/agents/${agentId}/lp/settings`,
      await signOwnerAction("lpSettings", agentId, params),
    );
    show(`POST /lp/settings (${result.status})`, result.body);
  } finally {
    await stack.close();
  }
}

/* -------------------------------------------------------------------------- */
/* preview / import                                                           */
/* -------------------------------------------------------------------------- */

/** The grid verdict on a candidate NFT, computed READ-SIDE from one pool read. */
async function gridVerdict(
  stack: Stack,
  grid: LpGridSettings,
  tokenId: string,
): Promise<void> {
  const snapshot = await stack.lp.readers.positions(BigInt(tokenId));
  if (snapshot === "burned") {
    console.log("\nGRID VERDICT: the token does not exist or has been burned.");
    return;
  }
  const poolAddress = await stack.lp.readers.getPool(
    grid.pool.token0,
    grid.pool.token1,
    grid.pool.fee,
  );
  if (poolAddress === null) {
    console.log("\nGRID VERDICT: no pool for the signed legs and fee tier.");
    return;
  }
  const state = await stack.lp.readers.poolState(poolAddress);
  // PHASE3.18 R2.5: this is the IMPORT preview, and import is the fixed-mode
  // admission door. `gridLiveRole` stays the authority here BY DESIGN — policy
  // mode is non-restartable by import, so the honest answer is the mode
  // refusal, not a role read from columns a hand-minted NFT does not have.
  if (gridModeOf(grid) === "policy") {
    console.log(
      "\nGRID VERDICT: REFUSED. This grid is signed with mode \"policy\", where rungs float and import "
        + "admits only at a signed rung verbatim, so policy mode is non-restartable by import in v1. "
        + "Restart with: abandon -> re-sign coherent rungs at the current tick -> gridArm.",
    );
    return;
  }
  // PHASE3.17 R2.5: `{level, role}` against the up-to-four signed ranges.
  const roleAt = gridLiveRole(grid, snapshot);
  if (roleAt === null) {
    console.log(
      `\nGRID VERDICT: REFUSED. This position's range [${snapshot.tickLower}, ${snapshot.tickUpper}) `
        + `equals none of this grid's signed ranges (${gridRangeList(grid)}). A level must match one VERBATIM.`,
    );
    return;
  }
  const pair = gridPair(grid, roleAt.level);
  if (pair === null) {
    console.log("\nGRID VERDICT: REFUSED. The matched level has no signed pair.");
    return;
  }
  const role = roleAt.role;
  const live = role === "buy" ? pair.buyRange : pair.sellRange;
  const side = gridTargetSide(state.currentTick, live);
  const target = gridTargetRange(grid, roleAt.level, role);
  console.log(
    `\nGRID VERDICT: this NFT is LEVEL ${roleAt.level}'s ${role.toUpperCase()} rung.\n`
      + `  tick ${state.currentTick} is "${side ?? "INSIDE the level"}" of `
      + `[${live.tickLower}, ${live.tickUpper})\n`
      + `  a flip would settle it and mint single-sided into [${target.tickLower}, ${target.tickUpper})`,
  );
  if (side === undefined) {
    console.log(
      "  REFUSED at import: the price is INSIDE the level, so it is only partly converted "
        + "and holds both legs. A grid level is admitted single-sided and strictly out of range.",
    );
  }
}

async function commandPreview(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const tokenId = need(flags, "token-id");
  const stack = await buildStack();
  try {
    const owner = privateKeyToAccount(ownerKey()).address;
    const settings = await storedSettings(stack, agentId, owner);
    const result = await getOwnerRead(
      stack,
      agentId,
      `/agents/${agentId}/lp/importable/${tokenId}`,
    );
    show(`GET /lp/importable/${tokenId} (${result.status})`, result.body);
    if (settings.grid === null) {
      console.log(
        "\nThis agent has no signed grid block, so the import would be an ORDINARY LP import. "
          + "Run `live-grid settings` first if you meant to arm a grid.",
      );
      return;
    }
    await gridVerdict(stack, settings.grid, tokenId);
  } finally {
    await stack.close();
  }
}

async function commandImport(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const tokenId = need(flags, "token-id");
  const stack = await buildStack();
  try {
    const owner = privateKeyToAccount(ownerKey()).address;
    const settings = await storedSettings(stack, agentId, owner);
    if (settings.grid !== null) {
      await gridVerdict(stack, settings.grid, tokenId);
      // The economics, printed BEFORE the gate. The route runs the same check
      // and refuses on it; showing it here means the operator sees the numbers
      // before they sign rather than in a 400.
      const poolAddress = await stack.lp.readers.getPool(
        settings.grid.pool.token0,
        settings.grid.pool.token1,
        settings.grid.pool.fee,
      );
      if (poolAddress !== null) {
        const edge = gridNetEdge({
          // PHASE3.17 C2: the pair, never the whole grid. `preview`/`import`
          // reports level 1's spread; the ROUTE prices whichever pair the
          // imported level actually belongs to.
          pair: {
            buyRange: settings.grid.buyRange,
            sellRange: settings.grid.sellRange,
          },
          minNetEdgeBps: settings.grid.minNetEdgeBps,
          // Sized on the position's exit value at the route; here the operator
          // is shown the SPREAD alone, which is the half they control.
          sizeWei: 0n,
          relayFeePerSubmitWei:
            stack.lp.lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI,
        });
        console.log(
          `\n  spread ${edge.grossEdgeBps} bps between the range midpoints. The route sizes the gas `
            + `floor on this level's own exitValueWei and refuses if the spread does not cover it plus `
            + `your minNetEdgeBps ${settings.grid.minNetEdgeBps}. HONEST SCOPE: that bounds RELAY GAS ONLY, `
            + `at an unmeasured constant — it models neither adverse selection nor slippage.`,
        );
      }
    }
    requireYesLive(
      flags,
      `import NFPM tokenId ${tokenId} for ${agentId} with basisWei 0. Nothing moves on chain; the NFT stays in your wallet and a row is recorded.`,
    );
    const result = await postOwner(
      stack,
      `/agents/${agentId}/lp/import`,
      await signOwnerAction("lpImport", agentId, { tokenId, basisWei: "0" }),
    );
    show(`POST /lp/import (${result.status})`, result.body);
  } finally {
    await stack.close();
  }
}

/* -------------------------------------------------------------------------- */
/* arm (PHASE3.16)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * THE PRESET TABLE, and it lives HERE — client side — on purpose (R2.8 / ruling
 * Q6).
 *
 * A preset name has no chain counterpart, so a signed one would be a field no
 * check could verify and the plane would then ASSERT it on receipts as
 * provenance it cannot substantiate — the 3.15 C1 rule applied to a field
 * instead of a row. The auditable provenance is the DERIVED ranges, the tick
 * and the net-edge figures, all of which the arm's receipt carries and from
 * which a reader can recompute the preset. The reverse is not true.
 *
 * Figures are in BPS of price, which is what makes them spacing-independent
 * until they are quantized. One tick is ~1 bps (`1.0001^1`), so these read the
 * same as the tick figures the planning session recorded at spacing 1.
 */
const GRID_PRESETS = {
  tight: { gapBps: 15, widthBps: 15 },
  standard: { gapBps: 30, widthBps: 30 },
  wide: { gapBps: 75, widthBps: 50 },
  "very-wide": { gapBps: 150, widthBps: 100 },
} as const;

type GridPresetName = keyof typeof GRID_PRESETS;

/**
 * PHASE3.18 — the LADDER MODE and the requote block, from flags, with the C9
 * clamp and the sentences that make it honest.
 *
 * ─── THE C9 CLAMP, AND WHY IT IS CLIENT-SIDE ONLY ─────────────────────────
 *
 * The server's joint rule refuses
 * `maxFlipsPerDay + maxRequotesPerDay > floor(1440/minMinutesBetweenExits)`.
 * At the LP default spacing of 30 minutes the defaults fit (12 + 21 = 33 <= 48),
 * but the gate BINDS above 43 minutes: an agent signed at 60 has `reachable =
 * 24`, and the defaults would be refused with a message about a number the
 * owner never chose. So the CLIENT lowers its own DEFAULT to fit and SAYS SO.
 *
 * It clamps a default, never an explicit `--max-requotes-day`: a silently
 * lowered number the owner did type would be the (ae) shape, and the server
 * still refuses it — the clamp is a convenience, never an authority.
 */
function requoteBlockFrom(
  flags: Flags,
  input: {
    readonly existing: LpGridSettings | undefined;
    readonly maxFlipsPerDay: number;
    readonly minMinutesBetweenExits: number;
    readonly policy: { readonly gapTicks: number; readonly widthTicks: number } | undefined;
    /** PHASE3.19: the pool's own fee tier, for the markout floor's arithmetic. */
    readonly poolFee?: number;
    readonly maxSagaSlippageBps?: number;
  },
): {
  readonly block: {
    mode?: "fixed" | "policy" | "ladder" | "shift";
    policy?: { gapTicks: number; widthTicks: number };
    requote?: { driftPctOfGap: number; maxRequotesPerDay: number };
    ladder?: {
      gapTicks: number;
      widthTicks: number;
      deployPctBps: number;
      driftPctOfGap: number;
      /** PHASE3.20 D1 — the NEW form. The client never emits the legacy one. */
      settlementsPerDay: number;
      driftMovesPerDay: number;
      maxStrandedMinutes: number;
      hedge: { enabled: boolean; minMarkoutBps: number; maxHedgePctBps: number };
    };
    /** PHASE3.22 R1 — the ATOMIC ladder's five signed numbers. */
    shift?: {
      gapTicks: number;
      widthTicks: number;
      deployPctBps: number;
      driftPctOfGap: number;
      shiftsPerDay: number;
      driftGasBudgetWei?: bigint;
      driftPerMotionWei?: bigint;
    };
  };
  readonly transcript: string;
} {
  const raw = flags.get("mode") ?? (input.existing?.mode ?? "fixed");
  if (raw !== "fixed" && raw !== "policy" && raw !== "ladder" && raw !== "shift") {
    throw new Error('--mode must be "fixed", "policy", "ladder" or "shift".');
  }
  if (raw === "ladder") {
    return ladderBlockFrom(flags, input);
  }
  // PHASE3.22 R5.8 / D9 — the SHIFT block, in its own builder for the reason
  // the ladder's is in one: its transcript owes a NAMED `minBudgetWei` line at
  // the SIGNED cadence, printed BEFORE the signature — the only bound an owner
  // actually feels once decision 8 removed the policy cap.
  if (raw === "shift") {
    return shiftBlockFrom(flags, input);
  }
  if (raw === "fixed") {
    return {
      block: {},
      transcript:
        `\n  LADDER MODE: fixed — the four signed rungs never move. `
        + `Pass --mode policy to add drift-triggered re-centring of UNFILLED levels.`,
    };
  }
  const policy = input.policy
    ?? input.existing?.policy
    ?? (() => {
      throw new Error(
        "--mode policy needs the rung geometry: run `arm`, which derives and signs it from the preset, or pass --policy-gap-ticks and --policy-width-ticks on `settings`.",
      );
    })();
  const drift = intFlag(
    flags,
    "requote-drift-pct",
    input.existing?.requote?.driftPctOfGap ?? DEFAULT_GRID_REQUOTE_DRIFT_PCT,
  );
  const clamp = gridRequoteDefaultClamp({
    wanted: input.existing?.requote?.maxRequotesPerDay ?? DEFAULT_GRID_MAX_REQUOTES_PER_DAY,
    maxFlipsPerDay: input.maxFlipsPerDay,
    minMinutesBetweenExits: input.minMinutesBetweenExits,
  });
  const explicit = flags.get("max-requotes-day");
  const maxRequotesPerDay = intFlag(flags, "max-requotes-day", clamp.value);
  // MEASURED, not padded: FINDINGS (av) recorded 0.0000388 BNB per relay
  // submission over 10 real submissions, and a re-centre is TWO of them (the
  // sweep always skips). The reserve `checkLpNativeCapSizing` demands is sized
  // on the PADDED constant instead, which is why both numbers are printed —
  // the difference is what decides whether a small wallet can arm at all.
  const measuredPerMove = 2 * 0.0000388;
  const measuredPerDay = measuredPerMove * maxRequotesPerDay;
  const paddedReserve = ((input.maxFlipsPerDay + maxRequotesPerDay) * 3 * 1e14) / 1e18;
  return {
    block: {
      mode: "policy",
      policy: { gapTicks: policy.gapTicks, widthTicks: policy.widthTicks },
      requote: { driftPctOfGap: drift, maxRequotesPerDay },
    },
    transcript:
      `\n  LADDER MODE: policy — gap ${policy.gapTicks} ticks, width ${policy.widthTicks} ticks. An UNFILLED `
      + `level whose near edge drifts past gap x ${(100 + drift) / 100} re-centres on its OWN side (same asset, `
      + `no swap). A FILLED level still flips into its SIGNED counter-rung: the flip does NOT re-centre.\n`
      + `  requote      driftPctOfGap ${drift}, maxRequotesPerDay ${maxRequotesPerDay}`
      // C9: printed from the SAME function that computed it, so a clamp can
      // never happen silently.
      + (explicit === undefined && clamp.note !== null ? `  <- ${clamp.note}` : "")
      + `\n  COST: at the MEASURED 0.0000388 BNB/submission (FINDINGS (av)) a re-centre is 2 submissions = `
      + `${measuredPerMove.toFixed(7)} BNB, so the signed ceiling is ~${measuredPerDay.toFixed(5)} BNB/day. `
      + `The native-cap RESERVE is sized on the PADDED constant instead: (${input.maxFlipsPerDay} flips + `
      + `${maxRequotesPerDay} requotes) x 3 x 1e14 = ${paddedReserve.toFixed(4)} BNB. FOR WALLETS UNDER ~0.05 BNB, `
      + `recalibrate LP_RELAY_FEE_PER_SUBMIT_WEI to the measured figure BEFORE enabling requotes, or the reserve `
      + `alone will refuse an arm that is in fact affordable.\n`
      + `  RESTART: policy mode is NON-RESTARTABLE BY IMPORT (rungs float; import admits only at a signed rung `
      + `verbatim). A wedged level is recovered by abandon -> re-sign coherent rungs -> gridArm.`,
  };
}

/**
 * PHASE3.19 items 22/23/26/31 — the LADDER block, from flags, with every
 * sentence the work order requires the operator to read BEFORE signing.
 *
 * WHAT IT PINS AND WHY, each named:
 *
 *  - `maxFlipsPerDay: 1` (item 22). A ladder creates no `grid-flip` sequence
 *    EVER — a fill's motion IS the re-anchor — so any other value is a limit
 *    that bounds nothing while still consuming a slot in the three-way
 *    reachability budget. The client PINS it and PRINTS WHY, and the server
 *    refuses anything else.
 *  - `minMinutesBetweenExits: 5` by DEFAULT and REFUSED above 15 (item 23).
 *    The spacing gate is agent-wide and unfiltered, so a ladder's two rows
 *    COMPETE for it: one row's drift move blocks the other row's FILL RESPONSE
 *    for a whole interval. At the LP default of 30 minutes that is a
 *    half-hour-late settlement, which is not a ladder. The worst case is
 *    printed in minutes rather than described.
 *  - `stopLossPct`/`takeProfitPct` forced to zero (item 10). A rung holds only
 *    `deployPctBps` of one side's half, so a value-versus-basis stop measures
 *    the rung against the whole ladder's money; the server refuses a non-zero
 *    one and the client must not sign one by inheritance from a stored row.
 *  - `minMarkoutBps` defaulted to the pool's own EXECUTION cost (item 26), which
 *    is the server's floor: pool fee + the saga slippage rail.
 */
/**
 * PHASE3.22 R5.8 / C9 / D9 — THE SHIFT BLOCK AND ITS TRANSCRIPT.
 *
 * ─── WHAT THE TRANSCRIPT OWES, and why the budget line is NAMED ────────────
 *
 * Operator decision 8 removed the policy cap on `shiftsPerDay`: fees are the
 * user's choice. That makes the printed COST the real bound — the only thing
 * standing between an owner and a cadence their budget cannot fund — so D9
 * makes `minBudgetWei` AT THE SIGNED CADENCE a named transcript line rather
 * than an implication.
 *
 * It is computed by `gridShiftEconomics`, which is CALL SITE 3 OF 3 (the arm
 * route and C2's re-sign guard are the other two). That is the 3.13 F12
 * cannot-diverge rule: the floor an owner is shown here IS the floor the route
 * admits on, as a property rather than as a promise.
 *
 * ─── WIDTH DEFAULTS TO ONE TICK SPACING (§8, the single-bin finding) ───────
 *
 * The 40 h census found every observed placement carrying exactly ONE bin id,
 * so the client's default width is one spacing and `--width-ticks` is the
 * override. The GAP still comes from the preset table.
 */
export function shiftBlockFrom(
  flags: Flags,
  input: {
    readonly existing: LpGridSettings | undefined;
    readonly maxFlipsPerDay: number;
    readonly minMinutesBetweenExits: number;
    readonly policy: { readonly gapTicks: number; readonly widthTicks: number } | undefined;
    readonly poolFee?: number;
    readonly maxSagaSlippageBps?: number;
  },
): {
  readonly block: {
    mode?: "fixed" | "policy" | "ladder" | "shift";
    shift?: {
      gapTicks: number;
      widthTicks: number;
      deployPctBps: number;
      driftPctOfGap: number;
      shiftsPerDay: number;
      driftGasBudgetWei?: bigint;
      driftPerMotionWei?: bigint;
    };
  };
  readonly transcript: string;
} {
  const geometry = input.policy
    ?? input.existing?.shift
    ?? (() => {
      throw new Error(
        "--mode shift needs the rung geometry: run `arm`, which derives and signs it from the preset.",
      );
    })();
  const deployPctBps = intFlag(
    flags,
    "deploy-pct-bps",
    input.existing?.shift?.deployPctBps ?? DEFAULT_GRID_SHIFT_DEPLOY_PCT_BPS,
  );
  if (flags.has("drift-off") && flags.has("drift-pct")) {
    throw new Error("--drift-off conflicts with --drift-pct; choose disabled drift or an explicit threshold before signing.");
  }
  if (flags.has("drift-off") && flags.get("drift-off") !== "true") {
    throw new Error("--drift-off is a boolean flag and must be supplied without a value.");
  }
  const drift = flags.has("drift-off")
    ? 0
    : intFlag(
        flags,
        "drift-pct",
        input.existing?.shift?.driftPctOfGap ?? DEFAULT_GRID_SHIFT_DRIFT_PCT,
      );
  const shiftsPerDay = intFlag(
    flags,
    "shifts-day",
    input.existing?.shift?.shiftsPerDay ?? DEFAULT_GRID_SHIFT_SHIFTS_PER_DAY,
  );
  const budgetFlag = flags.get("drift-gas-budget-bnb");
  const priceFlag = flags.get("drift-per-motion-bnb");
  const storedBudget = input.existing?.shift?.driftGasBudgetWei;
  const storedPrice = input.existing?.shift?.driftPerMotionWei;
  if (
    storedBudget === undefined
    && storedPrice === undefined
    && ((budgetFlag === undefined) !== (priceFlag === undefined))
  ) {
    throw new Error(
      "A legacy shift block has no signed drift price pair; pass --drift-gas-budget-bnb and --drift-per-motion-bnb together.",
    );
  }
  const driftGasBudgetWei = budgetFlag === undefined
    ? storedBudget
    : decimalBnbWeiFlag(flags, "drift-gas-budget-bnb", true);
  const driftPerMotionWei = priceFlag === undefined
    ? storedPrice
    : decimalBnbWeiFlag(flags, "drift-per-motion-bnb", false);
  const block = {
    gapTicks: geometry.gapTicks,
    widthTicks: geometry.widthTicks,
    deployPctBps,
    driftPctOfGap: drift,
    shiftsPerDay,
    ...(driftGasBudgetWei === undefined ? {} : { driftGasBudgetWei }),
    ...(driftPerMotionWei === undefined ? {} : { driftPerMotionWei }),
  };
  // PHASE3.25 R2.8/R5.6: show the physical spacing ceiling and each independent
  // lane before signature. The server repeats this signed boundary.
  const reachable = Math.floor(1_440 / input.minMinutesBetweenExits);
  const spacingCapacity = Math.ceil(1_440 / input.minMinutesBetweenExits);
  const driftMotions = gridShiftDriftMotionsPerDay(block);
  const budgetBnb = driftGasBudgetWei === undefined ? "ABSENT" : formatBnb(driftGasBudgetWei);
  const budgetWei = driftGasBudgetWei === undefined ? "ABSENT" : driftGasBudgetWei.toString(10);
  const perMotionBnb = driftPerMotionWei === undefined ? "ABSENT" : formatBnb(driftPerMotionWei);
  const perMotionWei = driftPerMotionWei === undefined ? "ABSENT" : driftPerMotionWei.toString(10);
  return {
    block: { mode: "shift", shift: block },
    transcript:
      `\n  SHIFT MODE: the ATOMIC ladder — gap ${geometry.gapTicks} ticks, width `
      + `${geometry.widthTicks} ticks. Every motion is ONE all-or-nothing relay batch.\n`
      + `  cross        fill settlement targets BOTH rungs: 12 calls. Cross is never gated by mid-fill state.\n`
      + (drift === 0
        ? `  drift        DISABLED (--drift-off): no drift reading, counter or sibling readiness is consumed.\n`
        : `  clean drift  both live rungs outside targets BOTH rungs: 12 calls.\n`
          + `  mid-fill     exactly one live rung inside targets ONLY the clean rung: 7 calls (its exit pair, BOTH zero-reset approvals, one approve/approve/mint trio).\n`
          + `  stale peer   unknown sibling range relation HOLDS with no sequence or reservation.\n`)
      + `  deploy       ${deployPctBps / 100}% per side (so ${deployPctBps / 100}% of the WHOLE budget is `
      + `deployed, not double it) — the other ${(10_000 - deployPctBps) / 100}% stays IDLE in your own EOA, `
      + `two-sided, as WBNB + base. That buffer is what funds the next motion.\n`
      + `  motion       ${drift === 0 ? "drift disabled" : `driftPctOfGap ${drift}`}, shiftsPerDay ${shiftsPerDay} (SETTLEMENT only).\n`
      + `               Drift: ${budgetBnb} BNB at ${perMotionBnb} BNB/motion = ${driftMotions}/day,\n`
      + `               priced AT SIGNING. Physical capacity is S = ceil(1440/minMinutesBetweenExits)\n`
      + `               = ${spacingCapacity} motions a day across BOTH lanes; the signed settlement cadence is\n`
      + `               separately bounded by 1 + shiftsPerDay <= R, R = floor(1440/minMinutesBetweenExits)\n`
      + `               = ${reachable}.\n`
      + `  signed wei   driftGasBudgetWei ${budgetWei}; driftPerMotionWei ${perMotionWei}.\n`
      + `  cadence      1 (the arm) + ${shiftsPerDay} = ${1 + shiftsPerDay} sequences a day against `
      + `minMinutesBetweenExits ${input.minMinutesBetweenExits}, which allows ${reachable}. `
      + `${1 + shiftsPerDay <= reachable ? "Signable." : "UNREACHABLE — the server will refuse this."}\n`
      + `  one-sided    below a side's mint floor the motion PROCEEDS on the other side and closes the `
      + `depleted row; it re-opens by itself when a fill delivers that asset back to the buffer. Your own `
      + `priceStopLoss/priceTakeProfit are the risk control for depletion.\n`
      + `  buffer       the "idle buffer" is your WHOLE EOA balance of each token and is NOT partitioned `
      + `from your unrelated holdings, so deployPctBps prices a number that may include money you never `
      + `allocated to this agent.\n`
      + `  UNKNOWN      a shift has NO in-plane resolver: an UNKNOWN mid-motion freezes BOTH rungs and `
      + `disarms BOTH price stops until you sign the declared-ambiguity abandon, which closes both rows so `
      + `you can re-arm. Funds are always in your own wallet.\n`,
  };
}

function ladderBlockFrom(
  flags: Flags,
  input: {
    readonly existing: LpGridSettings | undefined;
    readonly maxFlipsPerDay: number;
    readonly minMinutesBetweenExits: number;
    readonly policy: { readonly gapTicks: number; readonly widthTicks: number } | undefined;
    readonly poolFee?: number;
    readonly maxSagaSlippageBps?: number;
  },
): {
  readonly block: {
    mode?: "fixed" | "policy" | "ladder" | "shift";
    policy?: { gapTicks: number; widthTicks: number };
    requote?: { driftPctOfGap: number; maxRequotesPerDay: number };
    ladder?: {
      gapTicks: number;
      widthTicks: number;
      deployPctBps: number;
      driftPctOfGap: number;
      /** PHASE3.20 D1 — the NEW form. The client never emits the legacy one. */
      settlementsPerDay: number;
      driftMovesPerDay: number;
      maxStrandedMinutes: number;
      hedge: { enabled: boolean; minMarkoutBps: number; maxHedgePctBps: number };
    };
  };
  readonly transcript: string;
} {
  const geometry = input.policy
    ?? input.existing?.ladder
    ?? (() => {
      throw new Error(
        "--mode ladder needs the rung geometry: run `arm`, which derives and signs it from the preset.",
      );
    })();
  const deployPctBps = intFlag(
    flags,
    "deploy-pct-bps",
    input.existing?.ladder?.deployPctBps ?? DEFAULT_GRID_LADDER_DEPLOY_PCT_BPS,
  );
  const drift = intFlag(
    flags,
    "drift-pct",
    input.existing?.ladder?.driftPctOfGap ?? DEFAULT_GRID_LADDER_DRIFT_PCT,
  );
  // ─── PHASE3.20 D1 / item 29 — THE TWO LANES, AND THE LEGACY READING ───────
  //
  // The client only ever SIGNS the new form; `--max-moves-day` is still accepted
  // and is interpreted the way the server interprets a legacy signature
  // (`settlementsPerDay = maxMovesPerDay, driftMovesPerDay = 0`), so an operator
  // re-signing an existing ladder with the old flag gets exactly the behaviour
  // that ladder already has rather than a silent capability change.
  const legacyMoves = flags.get("max-moves-day");
  const settlementsPerDay = intFlag(
    flags,
    "settlements-day",
    legacyMoves !== undefined
      ? Number.parseInt(legacyMoves, 10)
      : (input.existing?.ladder?.settlementsPerDay
        ?? input.existing?.ladder?.maxMovesPerDay
        ?? DEFAULT_GRID_LADDER_SETTLEMENTS_PER_DAY),
  );
  const driftMovesPerDay = intFlag(
    flags,
    "drift-moves-day",
    legacyMoves !== undefined
      ? 0
      : (input.existing?.ladder?.driftMovesPerDay
        ?? (input.existing?.ladder?.maxMovesPerDay === undefined
          ? DEFAULT_GRID_LADDER_DRIFT_MOVES_PER_DAY
          : 0)),
  );
  const strandedBound = ladderStrandedMinutes(
    { maxStrandedMinutes: input.existing?.ladder?.maxStrandedMinutes } as LpGridLadder,
    input.minMinutesBetweenExits,
  );
  const maxStrandedMinutes = intFlag(
    flags,
    "max-stranded-minutes",
    strandedBound.value,
  );
  const hedgeEnabled = flags.get("no-hedge") !== "true";
  const floorBps = ladderMinMarkoutBps({
    poolFee: input.poolFee ?? 2_500,
    maxSagaSlippageBps: input.maxSagaSlippageBps ?? 50,
    signedMinMarkoutBps: 0,
  });
  const minMarkoutBps = intFlag(
    flags,
    "min-markout-bps",
    input.existing?.ladder?.hedge.minMarkoutBps ?? floorBps,
  );
  const maxHedgePctBps = intFlag(
    flags,
    "max-hedge-pct-bps",
    input.existing?.ladder?.hedge.maxHedgePctBps ?? DEFAULT_GRID_LADDER_MAX_HEDGE_PCT_BPS,
  );
  return {
    block: {
      mode: "ladder",
      ladder: {
        gapTicks: geometry.gapTicks,
        widthTicks: geometry.widthTicks,
        deployPctBps,
        driftPctOfGap: drift,
        settlementsPerDay,
        driftMovesPerDay,
        maxStrandedMinutes,
        hedge: { enabled: hedgeEnabled, minMarkoutBps, maxHedgePctBps },
      },
    },
    transcript:
      `\n  LADDER MODE: ladder — gap ${geometry.gapTicks} ticks, width ${geometry.widthTicks} ticks. `
      + `BOTH rungs re-anchor near the price: a FILL and a DRIFT produce the SAME motion, in ONE lane. `
      + `A fill's proceeds join the IDLE BUFFER and the same side is re-minted from it — no swap on the `
      + `motion itself.\n`
      + `  deploy       ${deployPctBps / 100}% per side (so ${deployPctBps / 100}% of the WHOLE budget is `
      + `deployed, not double it) — the other ${(10_000 - deployPctBps) / 100}% stays IDLE in your own EOA, `
      + `two-sided, as WBNB + base.\n`
      // PHASE3.20 D1 / item 29 — TWO LANES, and the legacy reading named where
      // an operator re-signing with the old flag will see it.
      + `  motion       driftPctOfGap ${drift}, settlementsPerDay ${settlementsPerDay} + driftMovesPerDay `
      + `${driftMovesPerDay} — TWO quota lanes, so a discretionary re-anchor can NEVER spend the capacity a `
      + `pending FILL settlement needs. That is the (az) defect, closed.\n`
      + (legacyMoves === undefined
        ? ``
        : `               --max-moves-day ${legacyMoves} was read the way the server reads a 3.19 signature: `
          + `settlementsPerDay ${settlementsPerDay}, driftMovesPerDay 0 (settle fills, never chase).\n`)
      + `  stranding    maxStrandedMinutes ${maxStrandedMinutes} (floor ${strandedBound.floor} = 2 x the spacing `
      + `gate): a rung that has held the WRONG asset that long is re-placed as a settlement regardless of its own `
      + `counters. ABSENT would mean ${strandedBound.defaultValue}; the bound is never silently disabled.\n`
      + `  hedge        ${hedgeEnabled ? "ON" : "OFF"} — minMarkoutBps ${minMarkoutBps} `
      + `(the server's floor for this pool is ${floorBps} = pool fee + the saga slippage rail; a hedge that `
      + `clears only its own fee is a fee paid twice), maxHedgePctBps ${maxHedgePctBps}\n`
      + (hedgeEnabled
        ? `               The hedge is THE ONLY thing that restores a side the market has drained. It trades `
          + `at market against a durable VWAP book of what this ladder actually paid.\n`
        : `               WITH THE HEDGE OFF a one-sided market parks a side until the market moves it back, `
          + `and the ladder degrades to a one-and-a-half-sided quoter. That is a legal configuration; the `
          + `funding hold says so when it happens.\n`)
      + `  RESTART: ladder mode is NON-RESTARTABLE BY IMPORT (rungs float). A wedged rung is recovered by `
      + `abandon -> gridArm again — CHEAPER than 3.15's, because the inventory is already in your own EOA as `
      + `the buffer and there is no hand-mint. The one exception is a mid-HEDGE UNKNOWN: the VWAP book is `
      + `advanced only from confirmed receipts, so an abandoned hedge leaves it stale until the next confirmed `
      + `motion corrects it, and a stale book hedges LESS eagerly.`,
  };
}

function presetFlag(flags: Flags): GridPresetName {
  const raw = flags.get("preset");
  if (raw === undefined || raw === "true") return "standard";
  if (!(raw in GRID_PRESETS)) {
    throw new Error(
      `--preset must be one of ${Object.keys(GRID_PRESETS).join(", ")}.`,
    );
  }
  return raw as GridPresetName;
}

function factorFlag(flags: Flags): number {
  const raw = flags.get("spread-factor");
  if (raw === undefined || raw === "true") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0.25 || parsed > 3) {
    throw new Error("--spread-factor must be a number between 0.25 and 3.");
  }
  return parsed;
}

/**
 * `--levels 2` for the dual arm; absent or `1` is 3.16's single-sided arm.
 *
 * The flag is a plain integer for the same reason the envelope field is (ruling
 * Q6): a future N>2 ladder reuses it, and a role-named boolean would re-import
 * the role-vs-pool-order confusion 3.15's own review caught.
 */
function levelsFlag(flags: Flags): 1 | 2 {
  const raw = flags.get("levels");
  if (raw === undefined || raw === "true" || raw === "1") return 1;
  if (raw === "2") return 2;
  throw new Error("--levels must be 1 or 2.");
}

/** `--budget 0.1` (BNB) as wei. Decimal string, 18 places, no float rounding. */
function budgetWeiFlag(flags: Flags): bigint {
  const raw = flags.get("budget");
  if (raw === undefined || raw === "true") {
    throw new Error("--budget is required, in BNB (e.g. --budget 0.1).");
  }
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) {
    throw new Error("--budget must be a decimal BNB amount with at most 18 places.");
  }
  const [whole, fraction = ""] = raw.split(".");
  const wei = BigInt(whole ?? "0") * 10n ** 18n
    + BigInt((fraction + "0".repeat(18)).slice(0, 18));
  if (wei <= 0n) throw new Error("--budget must be positive.");
  return wei;
}

/** PHASE3.25 R6.3 — decimal BNB to exact wei for either signed drift field. */
function decimalBnbWeiFlag(flags: Flags, name: string, allowZero: boolean): bigint {
  const raw = flags.get(name);
  if (raw === undefined || raw === "true") {
    throw new Error(`--${name} requires a decimal BNB amount.`);
  }
  if (!/^\d+(\.\d{1,18})?$/u.test(raw)) {
    throw new Error(`--${name} must be a decimal BNB amount with at most 18 places.`);
  }
  const [whole, fraction = ""] = raw.split(".");
  const wei = BigInt(whole ?? "0") * 10n ** 18n
    + BigInt((fraction + "0".repeat(18)).slice(0, 18));
  if (!allowZero && wei <= 0n) {
    throw new Error(`--${name} must be positive.`);
  }
  return wei;
}

function formatBnb(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/u, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}

/** PHASE3.25 R7.1/R10.2 — byte-contract T9, passed to stderr's live gate. */
export function shiftSettingsConfirmation(shift: LpGridShift): string {
  const budgetWei = shift.driftGasBudgetWei;
  const perMotionWei = shift.driftPerMotionWei;
  return `Cross settlement is capped at ${shift.shiftsPerDay}/day; drift is capped at ${gridShiftDriftMotionsPerDay(shift)}/day, derived from ${budgetWei === undefined ? "ABSENT" : formatBnb(budgetWei)} BNB (${budgetWei?.toString(10) ?? "ABSENT"} wei) priced at ${perMotionWei === undefined ? "ABSENT" : formatBnb(perMotionWei)} BNB (${perMotionWei?.toString(10) ?? "ABSENT"} wei) per motion AT SIGNING. The two allowances are separate; both lanes still share agent-wide spacing.`;
}

/** PHASE3.25 R7.1/R10.2 — byte-contract T11, passed to stderr's live gate. */
export function shiftArmConfirmation(input: {
  readonly agentId: string;
  readonly budgetWei: bigint;
  readonly swapInWei: bigint;
  readonly buyValueWei: bigint;
  readonly idleQuoteWei: bigint;
  readonly buyRange: LpGridRange;
  readonly sellRange: LpGridRange;
  readonly shift: LpGridShift;
}): string {
  return `sign gridArm (SHIFT, levels 2) for ${input.agentId}: persist these settings AND spend `
    + `${formatBnb(input.budgetWei)} BNB in ONE transaction — ${formatBnb(input.swapInWei)} BNB swapped to the base `
    + `token, ${formatBnb(input.buyValueWei)} BNB minted into [${input.buyRange.tickLower}, ${input.buyRange.tickUpper}), `
    + `the deployed share of the swap minted into [${input.sellRange.tickLower}, ${input.sellRange.tickUpper}), and `
    + `${formatBnb(input.idleQuoteWei)} BNB wrapped to WBNB and left IDLE in your own EOA. Two NFTs, or neither. `
    + `From then on cross settlement and clean drift may re-anchor two rungs in one batch, while `
    + `${input.shift.driftPctOfGap === 0 ? "drift is disabled" : "mid-fill drift moves only the clean rung in a seven-call batch"}, up to `
    + `${input.shift.shiftsPerDay} settlements and ${gridShiftDriftMotionsPerDay(input.shift)} drift motions a day, the latter derived from a ${input.shift.driftGasBudgetWei === undefined ? "ABSENT" : formatBnb(input.shift.driftGasBudgetWei)} BNB budget priced at signing; both lanes share agent-wide spacing.`;
}

async function commandArm(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const stack = await buildStack();
  try {
    const owner = privateKeyToAccount(ownerKey()).address;
    const current = await storedSettings(stack, agentId, owner);

    const pool = {
      token0: needAddress(flags, "token0"),
      token1: needAddress(flags, "token1"),
      fee: intFlag(flags, "fee", 2_500),
    };
    const wbnb = stack.lp.lp.venue.wbnb.toLowerCase();
    const wbnbIsToken0 = pool.token0.toLowerCase() === wbnb;
    if (!wbnbIsToken0 && pool.token1.toLowerCase() !== wbnb) {
      // The PRODUCT requirement behind this: the marketplace pool picker and
      // this script must only OFFER WBNB-leg pools, so the server's own refusal
      // is a second net rather than the first experience.
      throw new Error("Neither leg is the configured WBNB; the grid arm funds a WBNB level and refuses pools without one.");
    }
    const poolAddress = await stack.lp.readers.getPool(pool.token0, pool.token1, pool.fee);
    if (poolAddress === null) {
      throw new Error("No pool exists for those legs and that fee tier.");
    }
    const state = await stack.lp.readers.poolState(poolAddress);
    const spacing = state.tickSpacing;

    const presetName = presetFlag(flags);
    const preset = GRID_PRESETS[presetName];
    const factor = factorFlag(flags);
    const gapRequested = flags.get("gap0") === "true" ? 0 : preset.gapBps * factor;
    const widthRequested = preset.widthBps * factor;
    // `--gap0` means "the levels touch at the next tick boundary", so it is the
    // one value allowed BELOW one spacing — clamping it would reintroduce the
    // gap the flag exists to remove. Width is never allowed below one spacing:
    // `validateLpSettings` refuses that outright.
    const gap = gapRequested === 0
      ? { ticks: 0, clamped: false }
      : gridQuantizeUpToSpacing(gapRequested, spacing);
    // ─── PHASE3.22 §8 — SHIFT MODE'S WIDTH DEFAULTS TO EXACTLY ONE SPACING ──
    //
    // The 40 h census of the operator's own HawkFi MM agent found EVERY
    // observed placement carrying exactly ONE bin id — 206 txs, 85 requote
    // sessions, no exception. A shift ladder is that agent's motion, so its
    // default rung is one tick spacing wide and the PRESET supplies the GAP
    // only. `--width-ticks` is the override, quantized UP like every other
    // tick value, and it never silently narrows below one spacing because
    // `validateLpSettings` refuses that outright.
    //
    // The `clamped` warning below is preserved for both paths: a default of
    // one spacing is never "clamped" (it IS the spacing), and an explicit
    // `--width-ticks` that spacing forces upward reports exactly as a preset
    // width does.
    const shiftModeForWidth =
      (flags.get("mode") ?? current.grid?.mode ?? "fixed") === "shift";
    const widthTicksFlag = flags.get("width-ticks");
    const width =
      widthTicksFlag !== undefined
        ? gridQuantizeUpToSpacing(Number.parseInt(widthTicksFlag, 10), spacing)
        : shiftModeForWidth
          ? { ticks: spacing, clamped: false }
          : gridQuantizeUpToSpacing(widthRequested, spacing);
    // PHASE3.17: `--levels 2` derives FOUR rungs at even pitch (C9) and signs
    // both pairs; without it the geometry, the envelope and the transcript are
    // 3.16's byte for byte.
    // PHASE3.19: `--mode ladder` arms TWO rows on ONE pair, so it implies
    // `levels: 2` on the envelope (R3.1/C2 — "two rows, one pair") while the
    // GEOMETRY stays the single derivation's two rungs. `--levels 2` WITHOUT
    // ladder mode is 3.17's four-rung dual arm, unchanged.
    const ladderMode = (flags.get("mode") ?? current.grid?.mode ?? "fixed") === "ladder";
    // PHASE3.22 R5 / §8 — `--mode shift` arms TWO rows on ONE pair, exactly as
    // `--mode ladder` does, so it implies `levels: 2` on the envelope while the
    // GEOMETRY stays the single derivation's two rungs.
    const shiftMode = (flags.get("mode") ?? current.grid?.mode ?? "fixed") === "shift";
    const pairMode = ladderMode || shiftMode;
    const levels = pairMode ? 2 : levelsFlag(flags);
    const dual = levels === 2 && !pairMode;
    if (pairMode && flags.get("levels") !== undefined && flags.get("levels") !== "2") {
      throw new Error(
        `--mode ${ladderMode ? "ladder" : "shift"} always arms both sides, so --levels must be 2 or omitted.`,
      );
    }
    if (shiftMode && gap.ticks === 0) {
      // The SAME structural fact as the ladder's, because a shift arm IS the
      // ladder arm: its own swap acquires the whole base half and moves the
      // price toward the sell rung, and the route requires one spacing of
      // post-swap clearance. R1 additionally refuses `gapTicks: 0` at signing
      // for the R2.25 reason, so this is the earlier and friendlier of two
      // refusals rather than the only one.
      throw new Error(
        "--gap0 cannot be combined with --mode shift: the arm's own swap moves the price toward the sell rung, and the route requires at least one tick spacing of post-swap clearance — which a zero gap can never provide. Shift mode also refuses gapTicks 0 at signing.",
      );
    }
    if (ladderMode && gap.ticks === 0) {
      // Same structural fact as the dual arm's, and it bites harder here: a
      // ladder's own swap acquires the WHOLE base half, so it moves the price
      // further toward the sell rung than a dual arm's does.
      throw new Error(
        "--gap0 cannot be combined with --mode ladder: the arm's own swap moves the price toward the sell rung, and the route requires at least one tick spacing of post-swap clearance — which a zero gap can never provide.",
      );
    }
    if (dual && gap.ticks === 0) {
      // R3.3/C8, said at the earliest possible moment: one spacing of clearance
      // to the sell rung is structurally unreachable at a zero gap, so the route
      // would refuse this envelope after the operator signed it.
      throw new Error(
        "--gap0 cannot be combined with --levels 2: a dual arm's own swap moves the price toward the sell rung, and the route requires at least one tick spacing of post-swap clearance — which a zero gap can never provide.",
      );
    }
    const derivation = {
      currentTick: state.currentTick,
      tickSpacing: spacing,
      gapTicks: gap.ticks,
      widthTicks: width.ticks,
      wbnbIsToken0,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    };
    // A LADDER derives the SINGLE pair (two rungs), like a 3.16 arm — its two
    // ROWS share that one pair. Only 3.17's dual arm derives four rungs.
    const dualRanges = dual ? gridDeriveDualRanges(derivation) : null;
    const singleRanges = dualRanges === null ? gridDeriveRanges(derivation) : null;
    const buyRange: LpGridRange =
      dualRanges?.buyRange ?? (singleRanges as { buyRange: LpGridRange }).buyRange;
    const sellRange: LpGridRange =
      dualRanges?.sellRange ?? (singleRanges as { sellRange: LpGridRange }).sellRange;
    const buyRange2 = dualRanges?.buyRange2;
    const sellRange2 = dualRanges?.sellRange2;

    const grid: LpGridSettings = {
      pool,
      wbnbIsToken0,
      tickSpacing: spacing,
      buyRange,
      sellRange,
      ...(buyRange2 === undefined ? {} : { buyRange2 }),
      ...(sellRange2 === undefined ? {} : { sellRange2 }),
      // PHASE3.19 item 22: PINNED at 1 under ladder mode, and the transcript
      // says why. A ladder creates no `grid-flip` sequence ever, so any other
      // value is a limit that bounds nothing while still consuming a slot in the
      // three-way reachability budget — and the server refuses it outright.
      maxFlipsPerDay: ladderMode
        ? 1
        : intFlag(flags, "max-flips-per-day", current.grid?.maxFlipsPerDay ?? 12),
      minNetEdgeBps: intFlag(flags, "min-net-edge-bps", current.grid?.minNetEdgeBps ?? 0),
      // PHASE3.18: the arm is the ONE place the policy is coherent by
      // construction — these are the QUANTIZED ticks the four rungs were just
      // derived from, so `gridPolicyCoherence` passes at the validator without
      // the operator having to reproduce the arithmetic.
      ...requoteBlockFrom(flags, {
        existing: current.grid ?? undefined,
        maxFlipsPerDay: ladderMode
          ? 1
          : intFlag(flags, "max-flips-per-day", current.grid?.maxFlipsPerDay ?? 12),
        minMinutesBetweenExits: current.minMinutesBetweenExits,
        policy: { gapTicks: gap.ticks, widthTicks: width.ticks },
        poolFee: pool.fee,
        maxSagaSlippageBps: stack.lp.railsResult.ok
          ? stack.lp.railsResult.config.maxSagaSlippageBps
          : 50,
      }).block,
    };
    // ─── PHASE3.19 item 23 — THE SPACING GATE, CHOSEN AND DISCLOSED ────────
    //
    // The gate is agent-wide and UNFILTERED, so a ladder's two rows compete for
    // it: one row's drift move blocks the other row's FILL RESPONSE for a whole
    // interval. The client DEFAULTS a ladder to the gate's floor of 5 minutes
    // and REFUSES above 15 — a half-hour-late settlement is not a ladder. It
    // never silently lowers a number the owner typed (the C9 rule).
    // PHASE3.22 R2.9/R3.4: a SHIFT grid takes the same client default and the
    // same ceiling, and its reason is if anything stronger — a shift's single
    // lane means the spacing gate is the ONLY thing between two motions, so a
    // wide gate directly floors the cadence the owner just paid to sign.
    const ladderSpacingMinutes = pairMode
      ? intFlag(flags, "min-minutes-between-exits", 5)
      : current.minMinutesBetweenExits;
    if (pairMode && ladderSpacingMinutes > 15) {
      throw new Error(
        `--mode ${ladderMode ? "ladder" : "shift"} refuses minMinutesBetweenExits ${ladderSpacingMinutes}: the spacing gate is agent-wide, so one rung's motion would block the other's FILL RESPONSE for up to ${ladderSpacingMinutes} minutes. Sign 15 or less (the client defaults to the gate's floor of 5).`,
      );
    }
    const budgetWei = budgetWeiFlag(flags);
    const relayFee =
      stack.lp.lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
    const railsForSizing = stack.lp.railsResult;
    if (!railsForSizing.ok) throw new Error(railsForSizing.failure.reason);
    // PHASE3.19 R4.2: the LADDER's swap is the WHOLE base half, UNSCALED — only
    // the two MINTS are scaled by `deployPctBps`. Scaling the swap would leave
    // the buffer with no idle base at all, which is (ax) mirrored onto the sell
    // side (N17).
    // PHASE3.22: a shift arm swaps the whole base half exactly as a ladder arm
    // does, because its plan IS the ladder arm's.
    const swapInWei = dual || pairMode ? gridDualSwapInWei(budgetWei) : 0n;
    const ladderBlock = grid.ladder;
    const buyValueWei =
      ladderBlock === undefined
        ? budgetWei - swapInWei
        : ((budgetWei - swapInWei) * BigInt(ladderBlock.deployPctBps)) / 10_000n;
    const idleQuoteWei =
      ladderBlock === undefined ? 0n : budgetWei - swapInWei - buyValueWei;
    // R3.2's bound, computed with the SAME function the route admits on — never
    // a second arithmetic that could disagree with the refusal.
    const sellSizeWei = dual
      ? gridDualSellSizeWei({
          swapInWei,
          poolFee: pool.fee,
          maxPriceImpactBps: railsForSizing.config.maxPriceImpactBps,
          maxSagaSlippageBps: railsForSizing.config.maxSagaSlippageBps,
        })
      : 0n;
    // The economics from the QUANTIZED ranges, through the same function the
    // route refuses on — never from the nominal preset bps. PHASE3.17 C2: ONCE
    // PER PAIR, each on the size its own level will hold.
    // PHASE3.19 item 25, CALL SITE 3 OF 3 — the LADDER's economics through the
    // SAME builder the route admits on and the C2 guard re-runs, so the
    // transcript can never say CLEARS about a geometry the route refuses. It
    // prices the DEPLOYED rung, and at `maxMovesPerDay: 12` with the hedge on
    // that is 42 submissions a cycle against a flip's 2.
    const ladderEconomics =
      ladderBlock === undefined
        ? null
        : gridLadderEconomics({
            grid,
            ladder: ladderBlock,
            budgetWei,
            relayFeePerSubmitWei: relayFee,
          });
    // ─── PHASE3.20 R4.3 / B3 — THE CLIENT REFUSES BELOW `1/(1-d)` ───────────
    //
    // R3.1(3) said the ARM "should refuse". The clearance decided WHERE, and it
    // is here: a route-level refusal would edit `admitGridSettings` and the C2
    // re-sign guard, which D6 freezes and whose bodies R3.7 concedes are unread.
    // The precedent is this file's own ladder spacing refusal a few dozen lines
    // above — a client-side ladder refusal the server does not make.
    //
    // The number is not a nicety: at exactly the printed minimum budget the
    // signed ladder settles ZERO fills, permanently, and the route only
    // DISCLOSES that. `--i-know-the-ladder-settles-nothing` is the override,
    // named so it cannot be typed by accident.
    if (ladderBlock !== undefined && ladderEconomics !== null) {
      const resilienceGate = gridLadderResilience({
        budgetWei,
        minBudgetWei: ladderEconomics.minBudgetWei,
        deployPctBps: ladderBlock.deployPctBps,
      });
      if (
        resilienceGate.minFundableBudgetWei !== null
        && budgetWei < resilienceGate.minFundableBudgetWei
        && flags.get("i-know-the-ladder-settles-nothing") !== "true"
      ) {
        throw new Error(
          `--budget ${formatBnb(budgetWei)} BNB is below `
            + `${(resilienceGate.requiredMultipleBps / 10_000).toFixed(2)}x this ladder's minimum budget `
            + `(${formatBnb(resilienceGate.minFundableBudgetWei)} BNB): it absorbs `
            + `${resilienceGate.fundableFills ?? 0} consecutive same-direction fills. A ladder settles a fill from `
            + `deployPctBps of the REMAINING idle buffer of the charged asset, so the buffer decays geometrically `
            + `and at the printed minimum the FIRST settlement is already unfundable — permanently, because the `
            + `hedge is blocked by its own markout floor in exactly that market. Raise --budget, lower `
            + `--deploy-pct-bps, or pass --i-know-the-ladder-settles-nothing=true.`,
        );
      }
    }
    // ─── PHASE3.22 R5.8 / D9 / C9, CALL SITE 3 OF 3 — THE NAMED BUDGET LINE ──
    //
    // PHASE3.25 R2.2/R2.3: capital is reusable, so the admission floor is one
    // round trip and is independent of both signed motion allowances. Keep its
    // `minBudgetWei` as a NAMED transcript line rather than an
    // implication — printed BEFORE the signature, and computed by the SAME
    // `gridShiftEconomics` the arm route admits on and the C2 guard re-runs, so
    // the transcript can never say CLEARS about a geometry the route refuses.
    const shiftBlockForArm = grid.shift;
    if (shiftBlockForArm !== undefined) {
      const shiftEconomics = gridShiftEconomics({
        grid,
        shift: shiftBlockForArm,
        budgetWei,
        relayFeePerSubmitWei: relayFee,
      });
      console.log(
        `\n  SHIFT CAPITAL FLOOR (CADENCE-INVARIANT ROUND TRIP)\n`
        + `  submissions  ${shiftEconomics.submissionsPerCycle} per cycle — one buy-side and one sell-side batch.\n`
        + `  minBudgetWei ${
          shiftEconomics.minBudgetWei === null
            ? "none — the spread never covers minNetEdgeBps at any size"
            : `${formatBnb(shiftEconomics.minBudgetWei)} BNB`
        } at this geometry. Your --budget is ${formatBnb(budgetWei)} BNB.\n`
        + `  absorbs      ${shiftEconomics.resilience.fundableFills ?? 0} consecutive same-direction motions `
        + `before the charged side falls below its mint floor. Above that floor the size decays geometrically `
        + `(deployPctBps of what REMAINS), which is the decay by design; below it the motion goes ONE-SIDED `
        + `rather than stopping.\n`
        + `  shiftsPerDay and the signed drift budget bound motion; neither raises this reusable-capital floor.\n`,
      );
      // The 3.20 R4.3/B3 refusal, inherited: at exactly the printed minimum
      // budget a buffer-funded ladder settles ZERO motions, permanently. The
      // shift ladder's own mitigation is that it goes one-sided rather than
      // dead, so the refusal names that difference and keeps the same override.
      const shiftResilience = gridLadderResilience({
        budgetWei,
        minBudgetWei: shiftEconomics.minBudgetWei,
        deployPctBps: shiftBlockForArm.deployPctBps,
      });
      if (
        shiftResilience.minFundableBudgetWei !== null
        && budgetWei < shiftResilience.minFundableBudgetWei
        && flags.get("i-know-the-ladder-settles-nothing") !== "true"
      ) {
        throw new Error(
          `--budget ${formatBnb(budgetWei)} BNB is below `
            + `${(shiftResilience.requiredMultipleBps / 10_000).toFixed(2)}x this shift ladder's minimum budget `
            + `(${formatBnb(shiftResilience.minFundableBudgetWei)} BNB): it absorbs `
            + `${shiftResilience.fundableFills ?? 0} consecutive same-direction motions. A shift funds each mint `
            + `from deployPctBps of the REMAINING buffer of that side's asset, so the buffer decays geometrically `
            + `and at the printed minimum the FIRST motion is already one-sided. Unlike a ladder it keeps `
            + `quoting the other side — but a one-sided grid is not the product you are signing. Raise `
            + `--budget, lower --deploy-pct-bps, or pass --i-know-the-ladder-settles-nothing=true.`,
        );
      }
    }
    const pairSizes: { readonly level: 1 | 2; readonly sizeWei: bigint }[] =
      ladderEconomics !== null
        ? [{ level: 1, sizeWei: ladderEconomics.rungSizeWei }]
        : dual
          ? [{ level: 1, sizeWei: buyValueWei }, { level: 2, sizeWei: sellSizeWei }]
          : [{ level: 1, sizeWei: budgetWei }];
    const edges = pairSizes.map((entry) => {
      const pair = gridNetEdgePair(grid, entry.level);
      if (pair === null) throw new Error(`Level ${entry.level} has no signed pair.`);
      return {
        level: entry.level,
        edge: gridNetEdge({
          pair,
          minNetEdgeBps: grid.minNetEdgeBps,
          sizeWei: entry.sizeWei,
          relayFeePerSubmitWei: relayFee,
          // PHASE3.18 R2.4: the SAME inflated floor the route admits on, so the
          // transcript can never say CLEARS about a pair the route refuses.
          // Answers 2 for a fixed grid, so a 3.16/3.17 arm is unchanged.
          submissionsPerCycle: gridCycleSubmissions(grid),
        }),
      };
    });
    const edge = ladderEconomics?.edge ?? edges[0]?.edge;
    if (edge === undefined) throw new Error("The grid has no signed pair to price.");
    const minSize = gridPresetMinEconomicSizeWei({
      grossEdgeBps: edge.grossEdgeBps,
      minNetEdgeBps: edge.minNetEdgeBps,
      relayFeePerSubmitWei: relayFee,
      submissionsPerCycle: gridCycleSubmissions(grid),
    });

    console.log(
      requoteBlockFrom(flags, {
        existing: current.grid ?? undefined,
        maxFlipsPerDay: grid.maxFlipsPerDay,
        minMinutesBetweenExits: ladderSpacingMinutes,
        policy: { gapTicks: gap.ticks, widthTicks: width.ticks },
        poolFee: pool.fee,
        maxSagaSlippageBps: railsForSizing.config.maxSagaSlippageBps,
      }).transcript,
    );
    console.log(
      `\nARM, as it will be signed (pool ${poolAddress}, tick ${state.currentTick}, spacing ${spacing}):\n`
        + `  preset       ${presetName} x${factor}  (gap ${preset.gapBps} bps, width ${preset.widthBps} bps nominal)\n`
        + `  quantized    gap ${gap.ticks} ticks, width ${width.ticks} ticks — each rounded UP to a spacing multiple\n`
        + `  levels       ${levels}${dual ? "  — TWO levels on FOUR rungs, one submission, both mint or neither does" : ""}\n`
        + `  wbnbIsToken0 ${wbnbIsToken0} (the quote is ${wbnbIsToken0 ? "token0" : "token1"})\n`
        + `  buyRange     [${buyRange.tickLower}, ${buyRange.tickUpper})  — LEVEL 1's BUY rung, holds the QUOTE, `
        + `${wbnbIsToken0 ? "ABOVE" : "BELOW"} the price\n`
        + `  sellRange    [${sellRange.tickLower}, ${sellRange.tickUpper})  — LEVEL 1's counter-order rung\n`
        + (dual && buyRange2 !== undefined && sellRange2 !== undefined
          ? `  sellRange2   [${sellRange2.tickLower}, ${sellRange2.tickUpper})  — LEVEL 2's SELL rung, holds the BASE, `
            + `${wbnbIsToken0 ? "BELOW" : "ABOVE"} the price\n`
            + `  buyRange2    [${buyRange2.tickLower}, ${buyRange2.tickUpper})  — LEVEL 2's counter-order rung\n`
            + `  budget       ${formatBnb(budgetWei)} BNB (${budgetWei} wei), split ${GRID_DUAL_SPLIT_BPS / 100}/`
            + `${100 - GRID_DUAL_SPLIT_BPS / 100} BY CONSTANT across TWO mints in ONE transaction:\n`
            + `                 level 1 (buy)  ${formatBnb(buyValueWei)} BNB as native, straight into the mint\n`
            + `                 level 2 (sell) ${formatBnb(swapInWei)} BNB swapped to the base token first;\n`
            + `                 it lands as AT LEAST ${formatBnb(sellSizeWei)} BNB of value — SMALLER than level 1 by\n`
            + `                 the pool fee (${pool.fee / 10_000}%), the swap's price impact (up to `
            + `${railsForSizing.config.maxPriceImpactBps} bps) and the\n`
            + `                 pre-commit floor haircut (up to ${railsForSizing.config.maxSagaSlippageBps} bps, `
            + `this deployment's LP_MAX_SAGA_SLIPPAGE_BPS).\n`
            + `                 The overage above the floor stays in your wallet as bounded dust.\n`
            + `  midpoints    L1 buy ${gridRangeMidpointTick(buyRange)} / sell ${gridRangeMidpointTick(sellRange)}, `
            + `L2 buy ${gridRangeMidpointTick(buyRange2)} / sell ${gridRangeMidpointTick(sellRange2)}`
          : `  budget       ${formatBnb(budgetWei)} BNB (${budgetWei} wei), attached to ONE single-sided mint\n`
            + `  midpoints    buy ${gridRangeMidpointTick(buyRange)}, sell ${gridRangeMidpointTick(sellRange)}`),
    );
    if (dual) {
      console.log(
        `\n  WHERE EACH COUNTER-ORDER LANDS (C10): both levels quote the price-nearest rungs AT ARM TIME `
          + `only. After a level fills, its counter-order is minted on its OWN pair's OUTER rung — two rungs `
          + `plus the corridor away — so the inner rungs go periodically vacant and the nearest quote on one `
          + `side can sit three rungs from the price. That is the ladder working, not a fault.`
          + `\n  Level 1 ping-pongs [${buyRange.tickLower}, ${buyRange.tickUpper}) <-> `
          + `[${sellRange.tickLower}, ${sellRange.tickUpper}); level 2 ping-pongs `
          + `[${sellRange2?.tickLower}, ${sellRange2?.tickUpper}) <-> `
          + `[${buyRange2?.tickLower}, ${buyRange2?.tickUpper}). They never share a rung.`,
      );
    }
    if (gap.clamped || width.clamped) {
      console.log(
        `\n  CLAMPED: this pool's tick spacing is ${spacing}, so `
          + `${gap.clamped ? "the gap" : ""}${gap.clamped && width.clamped ? " and " : ""}`
          + `${width.clamped ? "the width" : ""} could not be as narrow as the preset asked and `
          + `${gap.clamped && width.clamped ? "were" : "was"} raised to one spacing. `
          + `The geometry you are signing is WIDER than the preset's name suggests.`,
      );
    }
    for (const entry of edges) {
      console.log(
        `\n  ECONOMICS, PAIR ${entry.level}${dual ? ` (level ${entry.level}, size ${formatBnb(entry.edge.sizeWei)} BNB)` : ""}: `
          + `gross edge ${entry.edge.grossEdgeBps} bps between the QUANTIZED midpoints, `
          // PHASE3.19 — the 3.18 TRANSCRIPT DEFECT, fixed in this commit: this
          // label read "2 submissions" as a hardcoded literal while the FLOOR it
          // described was `gridCycleSubmissions`' answer, so a policy grid's
          // transcript printed a 28-submission floor and called it two. The
          // figure now comes from the verdict itself and therefore cannot lie.
          + `gas floor ${entry.edge.costFloorBps} bps (${entry.edge.submissionsPerCycle} submissions x ${relayFee} wei), your minimum `
          + `${entry.edge.minNetEdgeBps} bps. ${entry.edge.ok ? "CLEARS." : "DOES NOT CLEAR — the route will refuse."}`,
      );
    }
    if (ladderEconomics !== null && ladderBlock !== undefined) {
      // ─── PHASE3.19 items 22/23/28/31 + L2 + C10 — the LADDER TRANSCRIPT ──
      //
      // Everything an owner must be able to read BEFORE signing, and each line
      // is a work-order item rather than decoration.
      const measuredPerSubmit = 0.0000388;
      const perMotionMeasured = 3 * measuredPerSubmit;
      // PHASE3.20 item 25 / C10: through the ONE normalizer, so the transcript
      // and the route's own gas reserve are sized on the same pair of numbers.
      const motionCounts = ladderMotionCounts(ladderBlock);
      const movesPerDay =
        motionCounts.settlementsPerDay + motionCounts.driftMovesPerDay;
      const reserveBnb = (movesPerDay * 4 * 1e14) / 1e18;
      // ─── PHASE3.20 R3.1 / C2 / C3 — THE RESILIENCE NUMBER ─────────────────
      const resilience = gridLadderResilience({
        budgetWei,
        minBudgetWei: ladderEconomics.minBudgetWei,
        deployPctBps: ladderBlock.deployPctBps,
      });
      // ITEM 31 — the PER-TOKEN CAP ARITHMETIC, in BOTH tokens, with the hedge
      // legs included and multiplied by the ROW count. The zap-out consumes no
      // cap (the NFPM pays out); the re-mint's approve→transferFrom does, so a
      // motion is counted ONCE for its mint, and the hedge adds its own leg.
      const rungBnb = Number(ladderEconomics.rungSizeWei) / 1e18;
      const hedgeShare = ladderBlock.hedge.enabled
        ? ladderBlock.hedge.maxHedgePctBps / 10_000
        : 0;
      const perTokenPerDay = movesPerDay * rungBnb * (1 + hedgeShare) * 2;
      console.log(
        `\n  LADDER, WHAT THE BUDGET BUYS (R4.2's split, exactly):\n`
          + `    swap        ${formatBnb(swapInWei)} BNB -> base, UNSCALED (the WHOLE base half is acquired at arm)\n`
          + `    buy rung    ${formatBnb(buyValueWei)} BNB minted as native (deployPctBps of the quote half)\n`
          + `    idle quote  ${formatBnb(idleQuoteWei)} BNB wrapped to WBNB and LEFT IN YOUR EOA\n`
          + `    idle base   whatever the swap returned above the sell rung's deployed share\n`
          + `    -> the three attached values sum to EXACTLY ${formatBnb(budgetWei)} BNB.\n`
          + `\n  MINIMUM BUDGET (item 28, L2 — the BUDGET, not the rung): `
          + `${ladderEconomics.minBudgetWei === null ? "none — the spread never covers minNetEdgeBps at any size" : `${formatBnb(ladderEconomics.minBudgetWei)} BNB`} `
          + `at the SHIPPED padded constant (${relayFee} wei/submission), for the configuration you are ACTUALLY `
          + `signing (${ladderEconomics.submissionsPerCycle} submissions a cycle: settlementsPerDay `
          + `${motionCounts.settlementsPerDay} + driftMovesPerDay ${motionCounts.driftMovesPerDay}, hedge `
          + `${ladderBlock.hedge.enabled ? "ON" : "OFF"} — turning the hedge `
          + `off moves this figure by about a third). At the MEASURED ${measuredPerSubmit} BNB/submission `
          + `(FINDINGS (av), 10 real submissions) the same geometry needs roughly `
          + `${ladderEconomics.minBudgetWei === null ? "n/a" : formatBnb((ladderEconomics.minBudgetWei * 388n) / 1000n)} BNB. `
          + `The pad is a DECISION, not a measurement: recalibrating LP_RELAY_FEE_PER_SUBMIT_WEI is a separate `
          + `reviewed change, because that constant prices every LP agent's exit reserve.\n`
          // ─── PHASE3.20 R3.1 / C2 / C3 — WHAT THE MINIMUM BUDGET DOES *NOT*
          //     BUY, printed BESIDE it because that is where an operator reads
          //     the number they are about to size on ─────────────────────────
          + `\n  RESILIENCE (R3.1 — the number the minimum budget hides): a ladder settles a fill by re-minting `
          + `deployPctBps of what REMAINS in the idle buffer of the charged asset, and a fill frees the OTHER `
          + `asset — so the buffer decays geometrically and a monotone run exhausts it after a FINITE number of `
          + `fills: N = floor(ln(budget/minBudget) / ln(1/(1-d))). At the printed MINIMUM budget N is ZERO — that `
          + `ladder cannot settle its FIRST fill, ever, because the hedge that would restore the side is blocked `
          + `by its own markout floor in exactly the market that drained it. You need at least `
          + `${(resilience.requiredMultipleBps / 10_000).toFixed(2)}x the minimum `
          + `(${resilience.minFundableBudgetWei === null ? "n/a" : `${formatBnb(resilience.minFundableBudgetWei)} BNB`}) `
          + `for ONE. YOUR budget of ${formatBnb(budgetWei)} BNB absorbs `
          + `${resilience.fundableFills === null ? "n/a" : resilience.fundableFills} consecutive same-direction `
          + `fills. RAISING deployPctBps LOWERS the printed minimum BY THINNING THE BUFFER, so it lowers N too: `
          + `the cheaper-looking configuration is the more fragile one. HONEST CAVEAT (FINDINGS (ay)): the buffer `
          + `is your whole EOA balance of that token and is NOT partitioned from your own holdings of it.\n`
          + `\n  COST: one motion is up to 3 submissions (zap-out + hedge + mint) = `
          + `${perMotionMeasured.toFixed(7)} BNB at the measured rate. The native-cap RESERVE is sized on the `
          + `PADDED constant and on FOUR submissions a motion (3 real + 1 pad, because a ladder's middle step can `
          + `FIRE where a flip's always skips): ${movesPerDay} x 4 x 1e14 = `
          + `${reserveBnb.toFixed(4)} BNB of headroom.\n`
          + `\n  PER-TOKEN CAPS (item 31): each motion re-approves the leg it mints, and the hedge pulls its own `
          + `leg through the router. Over a day, per token, that is about `
          + `${perTokenPerDay.toFixed(6)} BNB-equivalent (${movesPerDay} motions x `
          + `${rungBnb.toFixed(6)} BNB/rung x (1 + ${hedgeShare}) hedge share x 2 rows) — on BOTH WBNB and the `
          + `base token. NOTE: the DEFAULT per-token cap is 2^160/day, so in the default configuration these `
          + `caps bind NOTHING; the figure matters only if you narrowed them.\n`
          + `\n  maxFlipsPerDay PINNED AT 1 (item 22): a ladder creates no grid-flip sequence EVER — a fill's `
          + `motion IS the re-anchor — so any other value is a limit that bounds nothing while still costing a `
          + `slot in the spacing gate's budget. 1 is the minimum the type admits and it is inert.\n`
          + `\n  SPACING (item 23): minMinutesBetweenExits ${ladderSpacingMinutes} min. The gate is AGENT-WIDE and `
          + `unfiltered, and a ladder has TWO rows, so the WORST-CASE FILL-RESPONSE LATENCY you are signing is `
          + `${ladderSpacingMinutes} minutes: one rung's drift move can block the other rung's fill response for `
          + `a whole interval. At ${ladderSpacingMinutes} min the FOUR lanes together can deliver `
          // PHASE3.20 item 25 / L4 — THE FOUR-WAY SUM, which the server now
          // enforces: maxFlipsPerDay (PINNED at 1 under ladder mode) +
          // maxRequotesPerDay (0 — a requote block is refused here) +
          // settlementsPerDay + driftMovesPerDay. The line printed `1 + moves`
          // and became wrong the moment the lane split landed.
          + `${Math.floor(1440 / ladderSpacingMinutes)} sequences a day, against the `
          + `1 + 0 + ${motionCounts.settlementsPerDay} + ${motionCounts.driftMovesPerDay} = `
          + `${1 + movesPerDay} this signature reserves.`,
      );
    }
    console.log(
      `\n  MINIMUM ECONOMIC SIZE for pair 1's geometry: `
        + `${minSize === null ? "none — the spread never covers minNetEdgeBps at any size" : `${formatBnb(minSize)} BNB`}. `
        + `HONEST SCOPE: that bounds RELAY GAS ONLY, at an unmeasured 4x-padded constant; it models neither `
        + `adverse selection (which a fully-crossed range order IS) nor slippage.\n`
        // PHASE3.17 R2.9 / L4: the 2026-08-27 mainnet measurement is cited as a
        // MEASUREMENT and nothing more. `DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI`
        // prices every LP agent's exit reserve, so changing it is its own
        // reviewed decision and this phase deliberately does not take it.
        + `  MEASURED, NOT CHANGED: real relay gas over 10 past LP submissions peaked at 0.0000388 BNB per `
        + `submission (FINDINGS (av), 2026-08-27), so the constant above is a ~2.6x pad rather than the 4x it `
        + `was believed to be. The constant is unchanged by decision — it prices every LP agent's exit reserve.`,
    );
    console.log(
      `\n  FIRST FLIP: the agent is live the moment the mint confirms, but the first flip cannot fire before `
        + `minMinutesBetweenExits (${current.minMinutesBetweenExits} min) has elapsed — the arm's own reservation `
        + `moves the agent-wide spacing anchor, which counts quota-exempt rows too.`
        // R2.6 / M5: the PER-LEVEL budget, because `maxFlipsPerDay` is agent-wide.
        + (dual
          ? `\n  PER-LEVEL FLIP BUDGET: maxFlipsPerDay (${grid.maxFlipsPerDay}) is AGENT-WIDE and counts BOTH `
            + `levels, so each level gets about ${Math.floor(grid.maxFlipsPerDay / 2)} round trips a day. Two `
            + `levels that fill on the SAME observation are staggered by at least minMinutesBetweenExits `
            + `(${current.minMinutesBetweenExits} min) — the spacing gate is unfiltered and counts every reservation.`
          : ""),
    );

    // The COMPLETE settings object, merged over the stored row exactly as
    // `live-grid settings` does — including forcing the standard automation
    // off, which `validateLpSettings` refuses alongside a grid block anyway.
    // The route persists these bytes VERBATIM under
    // `paramsHash("lpSettings", ...)`, so what the worker recomputes every
    // cycle is what the owner signed here.
    const settings = lpSettingsParamsView({
      ...current,
      autoRotate: false,
      autoHarvest: false,
      // PHASE3.19 items 10/23: a LADDER's value-versus-basis thresholds are
      // forced to ZERO (a rung holds only `deployPctBps` of one side's half, so
      // a basis stop measures it against the whole ladder's money and the server
      // refuses a non-zero one), and its spacing is the ladder default rather
      // than whatever a stored row happened to carry. Neither is inherited by
      // accident from `current`.
      ...(ladderMode
        ? {
            stopLossPct: 0,
            takeProfitPct: 0,
            minMinutesBetweenExits: ladderSpacingMinutes,
          }
        : {}),
      grid,
    });
    requireYesLive(
      flags,
      shiftMode
        ? shiftArmConfirmation({
            agentId,
            budgetWei,
            swapInWei,
            buyValueWei,
            idleQuoteWei,
            buyRange,
            sellRange,
            shift: grid.shift!,
          })
        : ladderMode
        ? `sign gridArm (LADDER, levels 2) for ${agentId}: persist these settings AND spend `
          + `${formatBnb(budgetWei)} BNB in ONE transaction — ${formatBnb(swapInWei)} BNB swapped to the base `
          + `token, ${formatBnb(buyValueWei)} BNB minted into [${buyRange.tickLower}, ${buyRange.tickUpper}), `
          + `the deployed share of the swap minted into [${sellRange.tickLower}, ${sellRange.tickUpper}), and `
          + `${formatBnb(idleQuoteWei)} BNB wrapped to WBNB and left IDLE in your own EOA. Two NFTs, or neither.`
        : dual
        ? `sign gridArm (levels 2) for ${agentId}: persist these settings AND spend `
          + `${formatBnb(budgetWei)} BNB in ONE transaction — ${formatBnb(swapInWei)} BNB swapped to the `
          + `base token and minted into [${sellRange2?.tickLower}, ${sellRange2?.tickUpper}), and `
          + `${formatBnb(buyValueWei)} BNB minted into [${buyRange.tickLower}, ${buyRange.tickUpper}). `
          + `Two NFTs, or neither.`
        : `sign gridArm for ${agentId}: persist these settings AND spend ${formatBnb(budgetWei)} BNB `
          + `minting the first level single-sided into [${buyRange.tickLower}, ${buyRange.tickUpper}).`,
    );
    const result = await postOwner(
      stack,
      `/agents/${agentId}/lp/grid/arm`,
      // Q6: the preset NAME and the spread factor do NOT ride on the envelope.
      // They are printed above and belong to this transcript; the signed,
      // server-checkable provenance is the derived ranges themselves.
      // `levels` DOES ride it (R2.2): it changes what the budget buys, and it is
      // server-checkable against the settings' own pair-2 keys.
      await signOwnerAction("gridArm", agentId, {
        settings,
        budgetWei: budgetWei.toString(10),
        // PHASE3.19: a LADDER always arms both sides, so `levels: 2` rides the
        // envelope for it too — meaning "two ROWS on one pair" (R3.1/C2), which
        // the route's own ladder branch of the cross-rule enforces.
        ...(dual || pairMode ? { levels: 2 } : {}),
      }),
    );
    show(`POST /lp/grid/arm (${result.status})`, result.body);
  } finally {
    await stack.close();
  }
}

/* -------------------------------------------------------------------------- */
/* status                                                                     */
/* -------------------------------------------------------------------------- */

async function commandStatus(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const stack = await buildStack();
  try {
    const result = await getOwnerRead(stack, agentId, `/agents/${agentId}/lp`);
    const data = (result.body["data"] ?? {}) as Record<string, unknown>;
    const grid = data["grid"];
    if (grid === undefined) {
      console.log(
        "\nNo grid section: this agent has no signed grid block (or its stored digest does not verify).",
      );
      show(`GET /agents/${agentId}/lp (${result.status})`, result.body);
      return;
    }
    show("GRID", grid);
    show("positions", data["positions"]);
    show("sequences", data["sequences"]);
    console.log(
      "\nEvery figure above is AS OF THE LAST OBSERVATION — this route makes no chain read. "
        + "`observationAgeMs` is how stale it is.",
    );
  } finally {
    await stack.close();
  }
}

/* -------------------------------------------------------------------------- */
/* flip                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The operator-initiated flip. There is no HTTP route by design — a flip is
 * worker territory — so this builds the SAME deps the worker builds and calls
 * the runner directly, which keeps every in-saga gate in force: the kill
 * switch, the settings digest, the rails, the quota lane, the server-derived
 * floors, and G2's three conjuncts at the mint.
 */
async function commandFlip(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const positionId = need(flags, "position-id");
  const stack = await buildStack();
  try {
    const owner = privateKeyToAccount(ownerKey()).address;
    const agent = await stack.agentStore.getAgent(owner, agentId);
    if (agent === null) throw new Error(`No such agent "${agentId}" for this owner.`);
    const settings = await storedSettings(stack, agentId, owner);
    const grid = settings.grid;
    if (grid === null) {
      throw new Error(
        "This agent has no signed grid block, so a flip has no target range to mint into.",
      );
    }
    const position = await stack.lp.lp.store.getPosition(owner, agentId, positionId);
    if (position === null) throw new Error(`No such position "${positionId}".`);
    if (position.tokenId === null) throw new Error("The position has no recorded tokenId.");
    const snapshot = await stack.lp.readers.positions(BigInt(position.tokenId));
    if (snapshot === "burned") throw new Error("The level's NFT is burned on chain.");
    // PHASE3.18 C1: the fifth `gridLiveRole` seam. In POLICY mode a requoted
    // rung equals no signed rung, so identity comes from the durable columns —
    // and this client would otherwise print `null` for the role of a perfectly
    // healthy level.
    const roleAt = gridRoleAtFor(grid, snapshot, {
      gridLevel: position.gridLevel,
      gridRole: position.gridRole,
    });
    if (roleAt === null) {
      throw new Error(
        gridModeOf(grid) === "policy"
          ? LP_GRID_IDENTITY_MISSING_REASON
          : `The live level [${snapshot.tickLower}, ${snapshot.tickUpper}) matches none of this grid's `
            + `signed ranges (${gridRangeList(grid)}); re-sign the grid with one range equal to it, `
            + "or exit the position.",
      );
    }
    const role = roleAt.role;
    const target = gridTargetRange(grid, roleAt.level, role);
    const poolAddress = await stack.lp.readers.getPool(
      position.token0,
      position.token1,
      position.fee,
    );
    if (poolAddress === null) throw new Error("The position's pool could not be resolved.");
    const railsResult = stack.lp.railsResult;
    if (!railsResult.ok) throw new Error(railsResult.failure.reason);
    const stored = await stack.lp.lp.settingsStore.get(owner, agentId);
    const digest = stored?.digest ?? paramsHash("lpSettings", defaultLpSettingsParams());

    const deps: LpGridFlipDeps = {
      agent,
      agentStore: stack.agentStore,
      provider: stack.provider,
      journal: stack.journal,
      store: stack.lp.lp.store,
      killswitch: stack.killswitch,
      rails: railsResult.config,
      quota: {
        maxExitSequencesPerDay: settings.maxExitSequencesPerDay,
        minMinutesBetweenExits: settings.minMinutesBetweenExits,
        maxGridFlipsPerDay: grid.maxFlipsPerDay,
      },
      market: async () => {
        const state = await stack.lp.readers.poolState(poolAddress);
        return { ...state.evidence, currentTick: state.currentTick };
      },
      positions: stack.lp.readers.positions,
      quote: stack.lp.readers.quote,
      receipts: stack.lp.readers.receipts,
      expectedPool: poolAddress,
      conversionCompatibleTokens: stack.lp.lp.runtime.conversionCompatibleTokens,
      settingsDigest: digest,
      currentSettingsDigest: async () => {
        const row = await stack.lp.lp.settingsStore.get(owner, agentId);
        return row?.digest ?? paramsHash("lpSettings", defaultLpSettingsParams());
      },
      exitToQuote: settings.exitToQuote,
      autoRotate: settings.autoRotate,
      relayFeePerSubmitWei:
        stack.lp.lp.relayFeePerSubmitWei ?? DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI,
      venue: stack.lp.lp.venue,
      now: Date.now,
      targetRange: target,
      targetRole: role === "buy" ? "sell" : "buy",
      ...(stack.lp.gridCycles === undefined ? {} : { gridCycles: stack.lp.gridCycles }),
    };

    console.log(
      `\nFLIP: settle the ${role} level [${snapshot.tickLower}, ${snapshot.tickUpper}) and mint `
        + `single-sided into [${target.tickLower}, ${target.tickUpper}).\n`
        + "  TWO submissions: the zap-out and the mint. The sweep step is in the plan for shape "
        // PHASE3.19 L1: SCOPED. This command drives a FLIP, which exists only in
        // fixed and policy mode, and in those modes the sentence is true
        // verbatim. A ladder has no flip at all — its motion is the re-anchor,
        // and its middle step is a profit-gated hedge that can fire.
        + "parity and ALWAYS skips — a grid in fixed or policy mode never swaps to rebalance.\n"
        + "  If the price moves into or through the target between the two, the mint refuses into a "
        + "RECOVERABLE hold at pending-mint and the principal stays in your wallet.",
    );
    requireYesLive(
      flags,
      `drive ONE grid flip for position ${positionId}. It submits two on-chain batches and draws relay gas.`,
    );
    const result = await runLpGridFlip(deps, positionId);
    show("runLpGridFlip", result);
    if (result.status === "held") {
      console.log(
        "\nHELD. A grid-flip has no in-plane ambiguity door. Manually inspect the position and "
          + "any NFT the flip may have minted before taking custody action. PHASE 3.25 is the "
          + "separately reviewed grid-flip ambiguity-door work.",
      );
    }
  } finally {
    await stack.close();
  }
}

/* -------------------------------------------------------------------------- */
/* close                                                                      */
/* -------------------------------------------------------------------------- */

async function commandClose(flags: Flags): Promise<void> {
  const agentId = need(flags, "agent-id");
  const closeAll = flags.get("all") === "true";
  const positionIdFlag = flags.get("position-id");
  if (closeAll === (positionIdFlag !== undefined)) {
    throw new Error("Choose exactly one of --all or --position-id <id>.");
  }
  const inlineConvert = booleanFlag(flags, "inline-convert", true);
  const stack = await buildStack();
  try {
    if (!closeAll) {
      const positionId = need(flags, "position-id");
      requireYesLive(
        flags,
        `owner-sign the manual exit of position ${positionId}. It makes a real on-chain position withdrawal.`,
      );
      const result = await postOwner(
        stack,
        `/agents/${agentId}/lp/${positionId}/exit`,
        await signOwnerAction("lpExit", agentId, { positionId, inlineConvert }),
      );
      show(`POST /lp/${positionId}/exit (${result.status})`, result.body);
      console.log(
        "Every submitted batch is atomic, but this position may take ONE OR TWO submissions.",
      );
      return;
    }

    const account = privateKeyToAccount(ownerKey());
    const agent = await stack.agentStore.getAgent(account.address, agentId);
    if (agent === null) throw new Error(`Agent ${agentId} was not found for this owner.`);
    // PHASE3.24 D-4/C4: this pre-pause LOCAL snapshot exists only so the live
    // confirmation can name a count before any owner mutation. It authorizes
    // nothing. The workflow's authoritative positions and sequences are read
    // again only after pause is confirmed below.
    const previewPositions = await stack.lp.lp.store.listPositions(account.address, agentId);
    const previewCount = previewPositions.filter((position) => position.state !== "closed").length;
    const balanceReader = stack.lp.readers.walletTokenBalance;
    if (balanceReader === undefined) {
      throw new Error("Final ERC-20 balances could not be observed; refusing to claim a complete report.");
    }
    await runCloseAllWorkflow({
      previewCount,
      agentId,
      walletAddress: agent.walletAddress,
      wbnb: stack.lp.lp.venue.wbnb,
      inlineConvert,
      confirm: () => requireYesLive(
        flags,
        `pause the agent, then run ${previewCount} real on-chain position withdrawal${previewCount === 1 ? "" : "s"}, one manual-exit saga at a time.`,
      ),
      post: async (request) => {
        if (request.kind === "pause") {
          return postOwner(
            stack,
            `/agents/${agentId}/pause`,
            await signOwnerAction("pause", agentId, {}),
          );
        }
        return postOwner(
          stack,
          `/agents/${agentId}/lp/${request.positionId}/exit`,
          await signOwnerAction("lpExit", agentId, {
            positionId: request.positionId,
            inlineConvert: request.inlineConvert,
          }),
        );
      },
      reportPostResult: (label, result) => show(label, result.body),
      // PHASE3.24 R2.11/C4: pause is confirmed before every authoritative read.
      isAgentPaused: () => stack.killswitch.isAgentPaused(agentId, account.address),
      listPositions: () => stack.lp.lp.store.listPositions(account.address, agentId),
      listSequences: () => stack.lp.lp.store.listSequences(account.address, agentId),
      getPosition: (positionId) => stack.lp.lp.store.getPosition(
        account.address,
        agentId,
        positionId,
      ),
      getNonTerminalSequence: (positionId) => stack.lp.lp.store.getNonTerminalSequence(
        account.address,
        agentId,
        positionId,
      ),
      readStepJournalState: async (idempotencyKey) =>
        (await stack.journal.get(idempotencyKey))?.state ?? null,
      readBalance: balanceReader,
      log: console.log,
      error: console.error,
      setExitCode: (code) => {
        process.exitCode = code;
      },
    });
  } finally {
    await stack.close();
  }
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

const USAGE = `
live-grid — the grid ping-pong operator script (through PHASE3.24).

  arm      --agent-id <id> --token0 <addr> --token1 <addr> [--fee 2500]
           [--preset tight|standard|wide|very-wide] [--spread-factor 1.0]
           --budget <BNB> [--levels 1|2] [--gap0] [--max-flips-per-day 12]
           [--min-net-edge-bps 0] --yes-live

  settings --agent-id <id> --token0 <addr> --token1 <addr> [--fee 2500]
           --buy-range <lower:upper> --sell-range <lower:upper>
           [--max-flips-per-day 12] [--min-net-edge-bps 0] [--tick-spacing <n>]
           shift mode: [--shifts-day N] [--drift-gas-budget-bnb BNB]
                       [--drift-per-motion-bnb BNB]
           --yes-live
  settings --agent-id <id> --clear-grid --yes-live

  arm      --agent-id <id> --token0 <addr> --token1 <addr> [--fee 2500]
           --budget <BNB>
           [--preset tight|standard|wide|very-wide] [--spread-factor 0.25..3]
           [--gap0] [--levels 1|2] [--max-flips-per-day 12] [--min-net-edge-bps 0]
           [--mode fixed|policy|ladder|shift] [--width-ticks N]
           policy mode:  [--requote-drift-pct 60] [--max-requotes-day 21]
           ladder mode:  [--deploy-pct-bps 3000] [--drift-pct 60]
                         [--max-moves-day 12] [--no-hedge]
                         [--min-markout-bps <n>] [--max-hedge-pct-bps 5000]
                         [--min-minutes-between-exits 5]
           shift mode:   [--deploy-pct-bps 3000] [--drift-pct 60 | --drift-off]
                         [--shifts-day 12] [--drift-gas-budget-bnb BNB]
                         [--drift-per-motion-bnb BNB]
           --yes-live

  preview  --agent-id <id> --token-id <nfpm tokenId>          (read-only)
  import   --agent-id <id> --token-id <nfpm tokenId> --yes-live
  status   --agent-id <id>                                    (read-only)
  flip     --agent-id <id> --position-id <uuid> --yes-live
  close    --agent-id <id> --position-id <uuid> [--inline-convert true|false] --yes-live
  close    --agent-id <id> --all [--inline-convert true|false] --yes-live

CLOSE ALL POSITIONS is pause-first and serial. Each position runs its own
manual-exit saga, serially. Every submitted batch is atomic, but a position may
take ONE OR TWO submissions; the command as a whole is not atomic and may
partially complete. It does not change settings; the existing manual
live-grid settings --agent-id <id> --clear-grid --yes-live command is outside
this phase's review.

ARM IS THE ENTRY PATH (PHASE3.16). ONE owner signature carries the complete
settings AND a native budget: the plane validates admission, persists the
settings, and mints the first level itself, single-sided into the derived
buyRange. The ranges come from a PRESET converted against this pool's own tick
spacing and the CURRENT tick — you pick an amount and a shape, not ticks.

\`--levels 2\` (PHASE3.17) ARMS BOTH SIDES from that one budget and one
signature: FOUR rungs at even pitch, TWO levels, ONE transaction. Half the
budget is swapped to the base token inside the same batch and minted as the
SELL rung; the other half stays quote and is minted as the BUY rung. Both mint
or neither does. The two levels CROSS — level 1 owns the inner-buy and
outer-sell rungs, level 2 the inner-sell and outer-buy — so they can never end
up on the same rung, which is what a shared pair would do to them after the
first fill. The sell level lands SMALLER than the buy level by the pool fee,
the swap's price impact and the pre-commit floor haircut; the transcript prints
the conservative lower bound it is admitted on. \`--gap0\` is REFUSED with
\`--levels 2\`: the arm's own swap moves the price toward the sell rung, and the
route requires at least one tick spacing of post-swap clearance.

\`--mode ladder\` (PHASE3.19) IS THE IDLE-BUFFER MARKET MAKER. It arms TWO rows
on ONE pair from one budget and one signature, and it changes the strategy:
BOTH rungs re-anchor near the price — a FILL and a DRIFT produce the SAME motion
— and only \`--deploy-pct-bps\` of each side is deployed, the rest staying IDLE
in your own EOA as WBNB + base. A fill's proceeds join that buffer and the same
side is re-minted FROM it, so the ladder survives fills instead of flying to a
counter-rung far from the price. A profit-gated HEDGE is the only thing that
restores a side the market has drained; it trades at market against a durable
VWAP book of what this ladder actually paid, and it waits when markout does not
clear.

THE HEADLINE INVARIANT IS SCOPED, NOT REVISED (PHASE3.19 L1): "a grid never
swaps to rebalance" stays TRUE VERBATIM for \`fixed\` and \`policy\` — their
sweep steps still skip by design. A LADDER swaps only to HEDGE filled
inventory, sized to the imbalance, and only at protected profit.

LADDER PRECONDITION: the session must grant WBNB \`deposit()\`, which sessions
granted before this phase do not. Re-grant (\`npm run provision-agent\`) first;
the arm refuses with that remedy rather than failing at the wrap.

HAND-MINTING STILL WORKS and is the second door: mint an ordinary single-sided
range order on PancakeSwap at EXACTLY one of two signed ranges (via
\`settings\`), then \`import\` it with basisWei 0. Use it when you want ticks you
chose yourself, or to adopt a level you already hold.

RANGES for \`settings\` are written lower:upper in the POOL'S OWN tick
coordinates, e.g.
  --buy-range -101000:-100200 --sell-range -99800:-99000
and which of them sits above the price depends on the pool's leg order, not on
the words buy and sell. Both subcommands print the orientation before you sign.
`;

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (subcommand) {
    case "settings":
      await commandSettings(flags);
      return;
    case "arm":
      await commandArm(flags);
      return;
    case "preview":
      await commandPreview(flags);
      return;
    case "import":
      await commandImport(flags);
      return;
    case "status":
      await commandStatus(flags);
      return;
    case "flip":
      await commandFlip(flags);
      return;
    case "close":
      await commandClose(flags);
      return;
    default:
      console.log(USAGE);
      if (subcommand !== undefined && subcommand !== "help") process.exitCode = 1;
      return;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "--yes-live not supplied") {
      console.error(`\nlive-grid failed: ${message}`);
      process.exitCode = 1;
    }
  });
}
