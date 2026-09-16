/**
 * Phase 0: drive every non-terminal action to the truth, BEFORE any decision
 * (QUANT-GRID R2.2, R3.3, R5.2, R6.1, R7.3, R7.4).
 *
 * ─── THE INVARIANT THIS FILE EXISTS FOR ────────────────────────────────────
 *
 * A level with ANY non-terminal action is BLOCKED and cannot receive a new
 * intent. So a COMMITTED buy whose level update was lost is found HERE, by its
 * journal state, and settled before any new decision is made. That is what
 * kills the double buy — not a heuristic, and not a timeout.
 *
 * ─── THERE IS NO ABSENCE PROOF IN v1 (R6.1) ────────────────────────────────
 *
 * `resolve --invalidated` and the `eth_getLogs` invalidation scan are DELETED.
 * Silence, elapsed time and unchanged balances never release a possibly
 * submitted action. An action that is `submitted` with a journal row that never
 * obtained a `callsId` has exactly two exits:
 *
 *   - POSITIVE EVIDENCE — `resolve --calls-id-read` (the journal later learns a
 *     callsId) or `resolve --tx <hash>` under R7.1 identity, which SETTLES it;
 *   - RETIREMENT — after the key is dead on-chain AND the router deadline has
 *     passed at a finalized block, `live-quant retire-level`, which is
 *     PERMANENT.
 *
 * Disclosed consequence: a lost relay response can idle one level until the
 * session expires. That is the fail-closed price of not double-buying. Funds
 * never leave the client's wallet either way.
 *
 * ─── THE JOURNAL API RULE (R3.3, second half) ──────────────────────────────
 *
 * NO code path here calls `markRolledBack` or `markCommitted` on an UNKNOWN
 * journal row: the transition table forbids it and PHASE3.14 deliberately left
 * it so. Evidence-based resolution moves the ACTION and the LEVEL only; the
 * journal row stays UNKNOWN with `quant_actions.resolution_json` as the record,
 * and `status` shows both.
 */
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import type { ExecutionJournal, JournalEntry } from "../store/journal.js";
import type {
  QuantActionRow,
  QuantEpochRow,
  QuantJobRow,
  QuantJobStore,
} from "../store/quantJobs.js";
import type { WalletProvider, WalletCall } from "../core/types.js";
import type { QuantChainReader } from "./readers.js";
import { verifyQuantFill, type VerifiedFill } from "./receipt.js";
import {
  exitShares, historicalFeeEstInU, partitionExit,
} from "./grid.js";
import {
  bandBpsForAllocation,
  b2ScalarParamsDigest,
  canonicalQuantBandTiers,
  parseQuantBandTiers,
  quantParamsDigest,
  type QuantAdmittedParams,
  type QuantHistoricalParams,
  type QuantStrategyParams,
} from "./config.js";

export type QuantReconcileDeps = {
  readonly store: QuantJobStore;
  readonly journal: ExecutionJournal;
  readonly provider: WalletProvider;
  readonly reader: QuantChainReader;
  readonly params: QuantStrategyParams | QuantHistoricalParams;
  readonly venue: {
    readonly router: Address;
    readonly u: Address;
    readonly wbnb: Address;
    readonly pair: Address;
  };
  readonly nowMs: () => number;
};

export type QuantReconcileOutcome = {
  readonly journalKey: string;
  /** The R3.3 cell that decided, named, so `status` can show it verbatim. */
  readonly cell: string;
  readonly settled: boolean;
  readonly released: boolean;
};

export type QuantAccountingClassification = "non-entry" | "covered" | "unresolved" | "out-of-scope";

export type QuantExecutionInterval = {
  readonly kind: "covered" | "unresolved" | "out-of-scope" | "structure";
  readonly lower: bigint | null;
  readonly upper: bigint | null;
  /** Equality at the epoch timestamp stays unresolved but has no applied hypothesis. */
  readonly emptyUnresolved?: boolean;
};

/** R13.1's half-open/closed interval normalization, before subset enumeration. */
export function normalizeExecutionInterval(input: {
  readonly action: QuantActionRow;
  readonly epochBlock: bigint;
  readonly epochTimestampSec?: bigint;
  readonly observationBlock: bigint;
  readonly deadlineBlock?: bigint;
  readonly ancestorCanonical?: boolean;
}): QuantExecutionInterval {
  if (input.action.state === "intended") return { kind: "covered", lower: null, upper: null };
  if (input.action.submitFinalizedNumber === null || input.action.submitFinalizedHash === null) {
    return { kind: "structure", lower: null, upper: null };
  }
  if (input.ancestorCanonical === false) return { kind: "structure", lower: null, upper: null };
  if (input.action.submitFinalizedNumber >= input.observationBlock) {
    return { kind: "out-of-scope", lower: null, upper: null };
  }
  const lower = input.action.submitFinalizedNumber > input.epochBlock
    ? input.action.submitFinalizedNumber : input.epochBlock;
  const deadline = input.deadlineBlock ?? input.observationBlock;
  const upper = deadline < input.observationBlock ? deadline : input.observationBlock;
  if (lower >= upper) {
    // R13.1 keeps deadline equality conservative. The interval is empty for
    // enumeration, but the action is not reclassified as proven covered
    // merely because the two timestamps happen to compare equal.
    if (input.epochTimestampSec !== undefined
      && BigInt(input.action.deadlineSec) === input.epochTimestampSec
      && input.action.submitFinalizedNumber < input.observationBlock) {
      return { kind: "unresolved", lower, upper, emptyUnresolved: true };
    }
    return { kind: "out-of-scope", lower, upper };
  }
  return { kind: "unresolved", lower, upper };
}

export type QuantAccountingVerdict = {
  readonly admissible: boolean;
  readonly expectedUWei: bigint;
  readonly expectedWbnbWei: bigint;
  readonly pending: readonly string[];
  readonly classification: ReadonlyMap<string, QuantAccountingClassification>;
  readonly reason?: "reconcile-structure" | "reconcile-stale";
};

/**
 * R12/R13's unresolved-action accounting, kept pure so the memory and PG
 * workers consume the same subset enumeration. Inputs are already canonical
 * reads; this function never guesses from a quote or from a journal timeout.
 */
export function reconcileAccounting(input: {
  readonly epoch: QuantEpochRow;
  readonly epochTimestampSec: bigint;
  readonly observationBlock: bigint;
  readonly observationAtSec: bigint;
  readonly actualUWei: bigint;
  readonly actualWbnbWei: bigint;
  readonly actions: readonly QuantActionRow[];
  readonly maxPending?: number;
  readonly deadlineBlocks?: ReadonlyMap<string, bigint>;
  readonly canonicalAncestors?: ReadonlyMap<string, boolean>;
  readonly dustWei?: bigint;
}): QuantAccountingVerdict {
  const dust = input.dustWei ?? 1_000_000_000_000n;
  const classification = new Map<string, QuantAccountingClassification>();
  const pending: QuantActionRow[] = [];
  let expectedUWei = input.epoch.baselineUWei;
  let expectedWbnbWei = input.epoch.baselineWbnbWei;
  for (const action of input.actions) {
    if (action.state === "settled" && (action.fillInWei === null || action.fillOutWei === null
      || action.executedBlock === null || action.executedAtSec === null)) {
      return {
        admissible: false, expectedUWei, expectedWbnbWei,
        pending: pending.map((row) => row.journalKey), classification,
        reason: "reconcile-structure",
      };
    }
    if (action.state === "settled" && action.executedBlock !== null
      && action.executedBlock > input.epoch.startedBlock
      && action.executedBlock <= input.observationBlock
      && action.fillInWei !== null && action.fillOutWei !== null) {
      if (action.side === "buy") {
        expectedUWei -= action.fillInWei;
        expectedWbnbWei += action.fillOutWei;
      } else {
        expectedUWei += action.fillOutWei;
        expectedWbnbWei -= action.fillInWei;
      }
      continue;
    }
    if (action.state === "intended") {
      classification.set(action.journalKey, "non-entry");
      continue;
    }
    if (action.state === "settled" || action.state === "failed" || action.state === "aborted") continue;
    if (action.submitFinalizedNumber === null || action.submitFinalizedHash === null) {
      classification.set(action.journalKey, "unresolved");
      return {
        admissible: false, expectedUWei, expectedWbnbWei,
        pending: pending.map((row) => row.journalKey), classification,
        reason: "reconcile-structure",
      };
    }
    const interval = normalizeExecutionInterval({
      action, epochBlock: input.epoch.startedBlock,
      epochTimestampSec: input.epochTimestampSec,
      observationBlock: input.observationBlock,
      ...(input.deadlineBlocks?.get(action.journalKey) === undefined ? {} : {
        deadlineBlock: input.deadlineBlocks.get(action.journalKey)!,
      }),
      ...(input.canonicalAncestors?.get(action.journalKey) === undefined ? {} : {
        ancestorCanonical: input.canonicalAncestors.get(action.journalKey)!,
      }),
    });
    if (interval.kind === "structure") {
      return {
        admissible: false, expectedUWei, expectedWbnbWei,
        pending: pending.map((row) => row.journalKey), classification,
        reason: "reconcile-structure",
      };
    }
    if (interval.kind === "out-of-scope") {
      classification.set(action.journalKey,
        action.submitFinalizedNumber >= input.observationBlock
          ? "out-of-scope"
          : BigInt(action.deadlineSec) < input.epochTimestampSec ? "covered" : "out-of-scope");
      continue;
    }
    const deadlineAtEpoch = BigInt(action.deadlineSec) < input.epochTimestampSec;
    if (deadlineAtEpoch) {
      classification.set(action.journalKey, "covered");
      continue;
    }
    classification.set(action.journalKey, "unresolved");
    pending.push(action);
  }
  const maxPending = input.maxPending ?? 3;
  const nonTerminal = input.actions.filter((action) =>
    action.state !== "settled" && action.state !== "failed" && action.state !== "aborted");
  if (nonTerminal.length > maxPending || pending.length > maxPending) {
    return { admissible: false, expectedUWei, expectedWbnbWei, pending: pending.map((a) => a.journalKey), classification, reason: "reconcile-structure" };
  }
  const subsetCount = 1 << pending.length;
  for (let mask = 0; mask < subsetCount; mask += 1) {
    let uLow = expectedUWei;
    let wLow = expectedWbnbWei;
    let uExact = true;
    let wExact = true;
    for (let index = 0; index < pending.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const action = pending[index]!;
      if (action.side === "buy") {
        uLow -= action.amountInWei;
        wLow += action.minOutWei;
        wExact = false;
      } else {
        uLow += action.minOutWei;
        wLow -= action.amountInWei;
        uExact = false;
      }
    }
    const uOk = uExact ? abs(input.actualUWei - uLow) <= dust : input.actualUWei >= uLow - dust;
    const wOk = wExact ? abs(input.actualWbnbWei - wLow) <= dust : input.actualWbnbWei >= wLow - dust;
    if (uOk && wOk) return {
      admissible: true, expectedUWei, expectedWbnbWei,
      pending: pending.map((a) => a.journalKey), classification,
    };
  }
  return {
    admissible: false, expectedUWei, expectedWbnbWei,
    pending: pending.map((a) => a.journalKey), classification,
  };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Two full submit windows plus margin, the journal's own guard, restated. */
const SUBMIT_TIMEOUT_MS = 45_000;

function parseCalls(callsJson: string): readonly WalletCall[] {
  const parsed: unknown = JSON.parse(callsJson);
  if (!Array.isArray(parsed)) throw new Error("Persisted calls are malformed.");
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      to: getAddress(String(record["to"])),
      ...(record["value"] === undefined || record["value"] === null
        ? {}
        : { value: BigInt(String(record["value"])) }),
      ...(record["data"] === undefined || record["data"] === null
        ? {}
        : { data: String(record["data"]) as Hex }),
    };
  });
}

/**
 * Verify a candidate transaction against ONE action, and settle it if it holds.
 *
 * `settleAction` accepts ONLY a fill produced here (M1 / R2.4): no indexer row
 * and no bare operator hash can reach inventory, and a boundary test asserts
 * this module never imports the indexer parser.
 */
export async function verifyAndSettle(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  txHash: Hex,
): Promise<{ readonly ok: true; readonly fill: VerifiedFill } | { readonly ok: false; readonly code: string }> {
  if (job.sessionPublicKey === null) return { ok: false, code: "session-unknown" };
  const [transaction, receipt] = await Promise.all([
    deps.reader.getTransaction(txHash),
    deps.reader.getReceipt(txHash),
  ]);
  if (transaction === null || receipt === null) return { ok: false, code: "receipt-absent" };
  // R7.4: a positive receipt is accepted at any canonical block from the
  // persisted finalized ancestor through the action's deadline block. There is
  // no other cutoff; Revision 2's 200-block window is withdrawn.
  if (action.submitFinalizedNumber !== null
    && receipt.blockNumber < action.submitFinalizedNumber) {
    return { ok: false, code: "receipt-before-anchor" };
  }
  if (action.submitFinalizedNumber === null || action.submitFinalizedHash === null) {
    return { ok: false, code: "ancestor-missing" };
  }
  let receiptBlock: { readonly number: bigint; readonly hash: Hex; readonly timestampSec: bigint } | undefined;
  if (deps.reader.reservesAtHash !== undefined
    && typeof deps.reader.finalizedBlock === "function" && typeof deps.reader.blockAt === "function") {
    const finalized = await deps.reader.finalizedBlock();
    if (receipt.blockNumber > finalized.number) return { ok: false, code: "receipt-unfinalized" };
    const ancestorBlock = await deps.reader.blockAt(action.submitFinalizedNumber);
    receiptBlock = await deps.reader.blockAt(receipt.blockNumber);
    if (receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
      || receiptBlock.hash.toLowerCase() !== transaction.blockHash.toLowerCase()) {
      return { ok: false, code: "receipt-noncanonical" };
    }
    if (ancestorBlock.hash.toLowerCase() !== action.submitFinalizedHash.toLowerCase()) {
      return { ok: false, code: "ancestor-noncanonical" };
    }
    if (receiptBlock.timestampSec > BigInt(action.deadlineSec)) {
      return { ok: false, code: "receipt-after-deadline" };
    }
  }
  let calls: readonly WalletCall[];
  try {
    calls = parseCalls(action.callsJson);
  } catch {
    return { ok: false, code: "calls-malformed" };
  }
  const { keyHash } = sessionIdentity(job);
  const verdict = verifyQuantFill({
    transaction,
    receipt,
    tradingWallet: getAddress(job.tradingWallet),
    sessionKeyHash: keyHash,
    calls,
    pair: deps.venue.pair,
    tokenIn: action.side === "buy" ? deps.venue.u : deps.venue.wbnb,
    tokenOut: action.side === "buy" ? deps.venue.wbnb : deps.venue.u,
    amountInWei: action.amountInWei,
    minOutWei: action.minOutWei,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code };
  const params = admittedParams(job, deps.params);
  if (params === null) return { ok: false, code: "params-unreadable" };
  if (isR14Params(params)
    && (action.feeEstWei === null || action.gasPriceWei === null
      || action.feeEstWei <= 0n || action.gasPriceWei <= 0n)) {
    return { ok: false, code: "params-unreadable" };
  }
  const feeDeltaWei = await settlementFeeDelta(deps, job, action, receiptBlock);
  const settled = await settleVerified(
    deps, job, action, verdict.fill, params, receiptBlock, feeDeltaWei,
  );
  return settled ? { ok: true, fill: verdict.fill } : { ok: false, code: "settle-conflict" };
}

const LEGACY_REQUIRED_KEYS = [
  "strategyVersion", "bandBps", "maxLevels", "minClipUWei", "minNetEdgeBps",
  "entryTolBps", "exitTolBps", "maxImpactBps", "cooldownSec",
  "maxQuoteLagBlocks", "relayFeePerSubmitWei",
] as const;

const B2_REQUIRED_KEYS = [
  "strategyVersion", "seedMode", "seedWindowCycles", "bandBps", "maxLevels",
  "minClipUWei", "minNetEdgeBps", "entryTolBps", "exitTolBps", "maxImpactBps",
  "cooldownSec", "maxQuoteLagBlocks", "relayFeePerSubmitWei", "recenterMode",
  "recenterCooldownSec", "recenterBudgetDays", "minTermDays",
] as const;

const R14_REQUIRED_KEYS = [
  "paramsSchema", "strategyVersion", "seedMode", "seedWindowCycles", "bandTiers",
  "bandBps", "maxLevels", "minClipUWei", "minNetEdgeBps", "entryTolBps",
  "exitTolBps", "maxImpactBps", "cooldownSec", "maxQuoteLagBlocks",
  "relayFeePerSubmitWei", "relayGasUnits", "relayFeePadBps", "recenterMode",
  "recenterCooldownSec", "recenterBudgetDays", "minTermDays",
] as const;

const R14_ONLY_KEYS = ["paramsSchema", "bandTiers", "relayGasUnits", "relayFeePadBps"] as const;
const B2_ONLY_KEYS = [
  "seedMode", "seedWindowCycles", "recenterMode", "recenterCooldownSec",
  "recenterBudgetDays", "minTermDays",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAny(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => key in raw);
}

function historicalNumber(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function historicalBigint(raw: Record<string, unknown>, key: string): bigint | null {
  const value = raw[key];
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function allKeysPresent(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => key in raw);
}

function parseHistoricalParams(raw: Record<string, unknown>): QuantHistoricalParams | null {
  if (!allKeysPresent(raw, LEGACY_REQUIRED_KEYS)) return null;
  const strategyVersion = raw["strategyVersion"];
  const bandBps = historicalNumber(raw, "bandBps");
  const maxLevels = historicalNumber(raw, "maxLevels");
  const minClipUWei = historicalBigint(raw, "minClipUWei");
  const minNetEdgeBps = historicalNumber(raw, "minNetEdgeBps");
  const entryTolBps = historicalNumber(raw, "entryTolBps");
  const exitTolBps = historicalNumber(raw, "exitTolBps");
  const maxImpactBps = historicalNumber(raw, "maxImpactBps");
  const cooldownSec = historicalNumber(raw, "cooldownSec");
  const maxQuoteLagBlocks = historicalNumber(raw, "maxQuoteLagBlocks");
  const relayFeePerSubmitWei = historicalBigint(raw, "relayFeePerSubmitWei");
  if (typeof strategyVersion !== "string" || bandBps === null || maxLevels === null
    || minClipUWei === null || minNetEdgeBps === null || entryTolBps === null
    || exitTolBps === null || maxImpactBps === null || cooldownSec === null
    || maxQuoteLagBlocks === null || relayFeePerSubmitWei === null) return null;
  return {
    strategyVersion: strategyVersion as QuantHistoricalParams["strategyVersion"],
    seedMode: "none", seedWindowCycles: 9, bandBps, maxLevels, minClipUWei,
    minNetEdgeBps, entryTolBps, exitTolBps, maxImpactBps, cooldownSec,
    maxQuoteLagBlocks, relayFeePerSubmitWei, recenterMode: "none",
    recenterCooldownSec: 86_400, recenterBudgetDays: 1, minTermDays: 7,
  };
}

function parseB2Params(raw: Record<string, unknown>): QuantHistoricalParams | null {
  if (!allKeysPresent(raw, B2_REQUIRED_KEYS)) return null;
  const parsed = parseHistoricalParams(raw);
  if (parsed === null) return null;
  const seedMode = raw["seedMode"];
  const seedWindowCycles = historicalNumber(raw, "seedWindowCycles");
  const recenterMode = raw["recenterMode"];
  const recenterCooldownSec = historicalNumber(raw, "recenterCooldownSec");
  const recenterBudgetDays = historicalNumber(raw, "recenterBudgetDays");
  const minTermDays = historicalNumber(raw, "minTermDays");
  if ((seedMode !== "none" && seedMode !== "symmetric")
    || seedWindowCycles === null || recenterMode !== "none" && recenterMode !== "both"
    || recenterCooldownSec === null || recenterBudgetDays === null || minTermDays === null) {
    return null;
  }
  return {
    ...parsed, seedMode, seedWindowCycles, recenterMode,
    recenterCooldownSec, recenterBudgetDays, minTermDays,
  };
}

function parseR14Params(
  raw: Record<string, unknown>, job: QuantJobRow,
): QuantAdmittedParams | null {
  if (raw["paramsSchema"] !== "r14" || !allKeysPresent(raw, R14_REQUIRED_KEYS)) return null;
  const seedMode = raw["seedMode"];
  const recenterMode = raw["recenterMode"];
  const bandTiers = raw["bandTiers"];
  const bandBps = historicalNumber(raw, "bandBps");
  const seedWindowCycles = historicalNumber(raw, "seedWindowCycles");
  const maxLevels = historicalNumber(raw, "maxLevels");
  const minClipUWei = historicalBigint(raw, "minClipUWei");
  const minNetEdgeBps = historicalNumber(raw, "minNetEdgeBps");
  const entryTolBps = historicalNumber(raw, "entryTolBps");
  const exitTolBps = historicalNumber(raw, "exitTolBps");
  const maxImpactBps = historicalNumber(raw, "maxImpactBps");
  const cooldownSec = historicalNumber(raw, "cooldownSec");
  const maxQuoteLagBlocks = historicalNumber(raw, "maxQuoteLagBlocks");
  const relayFeePerSubmitWei = historicalBigint(raw, "relayFeePerSubmitWei");
  const relayGasUnits = historicalBigint(raw, "relayGasUnits");
  const relayFeePadBps = historicalBigint(raw, "relayFeePadBps");
  const recenterCooldownSec = historicalNumber(raw, "recenterCooldownSec");
  const recenterBudgetDays = historicalNumber(raw, "recenterBudgetDays");
  const minTermDays = historicalNumber(raw, "minTermDays");
  if ((seedMode !== "none" && seedMode !== "symmetric")
    || (recenterMode !== "none" && recenterMode !== "both")
    || typeof bandTiers !== "string" || bandBps === null || seedWindowCycles === null
    || maxLevels === null || minClipUWei === null || minNetEdgeBps === null
    || entryTolBps === null || exitTolBps === null || maxImpactBps === null
    || cooldownSec === null || maxQuoteLagBlocks === null || relayFeePerSubmitWei === null
    || relayGasUnits === null || relayFeePadBps === null || recenterCooldownSec === null
    || recenterBudgetDays === null || minTermDays === null) return null;
  let canonicalTiers: string;
  try {
    canonicalTiers = canonicalQuantBandTiers(parseQuantBandTiers(bandTiers));
  } catch {
    return null;
  }
  if (canonicalTiers !== bandTiers) return null;
  if (raw["strategyVersion"] !== "grid-v2-quant:1"
    || seedWindowCycles < 3 || seedWindowCycles > 30
    || maxLevels < (seedMode === "symmetric" ? 2 : 1)
    || maxLevels > (seedMode === "symmetric" ? 3 : 5)
    || minClipUWei < 5n * 10n ** 18n
    || minNetEdgeBps < 25 || minNetEdgeBps > 500
    || entryTolBps < 10 || entryTolBps > 300
    || exitTolBps < 10 || exitTolBps > 300
    || maxImpactBps < 5 || maxImpactBps > 300
    || cooldownSec < 60 || cooldownSec > 86_400
    || maxQuoteLagBlocks < 1 || maxQuoteLagBlocks > 200
    || relayFeePerSubmitWei < 10_000_000_000_000n
    || relayFeePerSubmitWei > 10_000_000_000_000_000n
    || relayGasUnits < 200_000n || relayGasUnits > 1_000_000n
    || relayFeePadBps < 10_000n || relayFeePadBps > 30_000n
    || recenterCooldownSec < 86_400 || recenterCooldownSec > 604_800
    || recenterBudgetDays < 1 || recenterBudgetDays > 90
    || minTermDays < 7 || minTermDays > 90
    || recenterMode === "both" && seedMode !== "symmetric") return null;
  const fixedFloor = 50 + entryTolBps + exitTolBps + minNetEdgeBps;
  const parsedTiers = parseQuantBandTiers(bandTiers);
  if (parsedTiers.some((tier) => tier.bandBps <= fixedFloor)
    || parsedTiers[0]!.minAllocationUWei < (seedMode === "symmetric"
      ? 2n * minClipUWei : minClipUWei)) return null;
  const params: QuantAdmittedParams = {
    paramsSchema: "r14", strategyVersion: raw["strategyVersion"] as QuantAdmittedParams["strategyVersion"],
    seedMode, seedWindowCycles, bandTiers, bandBps, maxLevels, minClipUWei,
    minNetEdgeBps, entryTolBps, exitTolBps, maxImpactBps, cooldownSec,
    maxQuoteLagBlocks, relayFeePerSubmitWei, relayGasUnits, relayFeePadBps,
    recenterMode, recenterCooldownSec, recenterBudgetDays, minTermDays,
  };
  if (typeof raw["strategyVersion"] !== "string"
    || quantParamsDigest(params).toLowerCase() !== job.paramsDigest?.toLowerCase()) return null;
  const selected = bandBpsForAllocation(params, job.allocationUWei);
  if (!selected.ok || selected.bandBps !== bandBps) return null;
  return params;
}

export function admittedParams(
  job: QuantJobRow, _fallback: QuantStrategyParams | QuantHistoricalParams,
): QuantAdmittedParams | QuantHistoricalParams | null {
  if (job.paramsJson === null || job.paramsDigest === null) return null;
  try {
    const parsed: unknown = JSON.parse(job.paramsJson);
    if (!isRecord(parsed)) return null;
    const raw = parsed;
    if (hasAny(raw, R14_ONLY_KEYS)) return parseR14Params(raw, job);
    if (hasAny(raw, B2_ONLY_KEYS)) {
      const params = parseB2Params(raw);
      return params !== null && b2ScalarParamsDigest(params).toLowerCase() === job.paramsDigest.toLowerCase()
        ? params : null;
    }
    const params = parseHistoricalParams(raw);
    return params !== null && legacyParamsDigest(raw).toLowerCase() === job.paramsDigest.toLowerCase()
      ? params : null;
  } catch {
    return null;
  }
}

function isR14Params(params: QuantAdmittedParams | QuantHistoricalParams): params is QuantAdmittedParams {
  return "bandTiers" in params;
}

async function settlementFeeDelta(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  receiptBlock: { readonly number: bigint; readonly hash: Hex; readonly timestampSec: bigint } | undefined,
): Promise<bigint | null> {
  if (action.preNativeWei <= 0n || receiptBlock === undefined
    || deps.reader.nativeBalanceAtHash === undefined) return null;
  try {
    const after = await deps.reader.nativeBalanceAtHash(job.tradingWallet, receiptBlock.hash);
    return action.preNativeWei - after;
  } catch {
    return null;
  }
}

function legacyParamsDigest(raw: Record<string, unknown>): Hex {
  return keccak256(stringToHex(JSON.stringify({
    strategyVersion: String(raw["strategyVersion"]),
    bandBps: Number(raw["bandBps"]), maxLevels: Number(raw["maxLevels"]),
    minClipUWei: String(raw["minClipUWei"]), minNetEdgeBps: Number(raw["minNetEdgeBps"]),
    entryTolBps: Number(raw["entryTolBps"]), exitTolBps: Number(raw["exitTolBps"]),
    maxImpactBps: Number(raw["maxImpactBps"]), cooldownSec: Number(raw["cooldownSec"]),
    maxQuoteLagBlocks: Number(raw["maxQuoteLagBlocks"]),
    relayFeePerSubmitWei: String(raw["relayFeePerSubmitWei"]),
  })));
}

/** The account key hash for the job's ADMITTED public key. No key is opened. */
function sessionIdentity(job: QuantJobRow): { readonly keyHash: Hex } {
  if (job.sessionPublicKey === null) throw new Error("The job has no admitted session key.");
  return { keyHash: accountKeyHashForAddress(publicKeyToAddress(job.sessionPublicKey)) };
}

/**
 * Move inventory. ONE CAS, idempotent on `action.state`, and the only place in
 * this plane that changes what a level owns.
 */
async function settleVerified(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  fill: VerifiedFill,
  params: QuantAdmittedParams | QuantHistoricalParams,
  finalized?: { readonly number: bigint; readonly hash: Hex; readonly timestampSec: bigint },
  feeDeltaWei: bigint | null = null,
): Promise<boolean> {
  const levels = await deps.store.listLevels(job.quantJobId);
  const level = levels.find((row) => row.levelIndex === action.levelIndex);
  if (level === undefined) return false;
  const nowMs = deps.nowMs();
  if (action.side === "buy") {
    // The buy's cycle opens: the exact WBNB the later sells will spend, and
    // the exact U it cost. `entryCostUWei` is ONE fee estimate (R5.6) valued at
    // the fill's own price, and it is charged to the cycle, never measured.
    const midE18 = fill.fillOutWei === 0n
      ? 0n
      : (fill.fillInWei * 10n ** 18n) / fill.fillOutWei;
    const entryCostUWei = isR14Params(params)
      ? (action.feeEstWei! * midE18) / 10n ** 18n
      : historicalFeeEstInU(params, midE18);
    const plan = job.wbnbCapMinLimitWei > 0n
      ? partitionExit(fill.fillOutWei, job.wbnbCapMinLimitWei)
      : [fill.fillOutWei];
    const result = await deps.store.settleAction({
      journalKey: action.journalKey,
      quantJobId: job.quantJobId,
      levelIndex: action.levelIndex,
      txHash: fill.txHash,
      swapLogIndex: fill.swapLogIndex,
      fillInWei: fill.fillInWei,
      fillOutWei: fill.fillOutWei,
      feeDeltaWei,
      entryCostUWei,
      nextLevelState: "holding-base",
      nextBaseWei: fill.fillOutWei,
      nextBaseAtCycleStartWei: fill.fillOutWei,
      nextBasisUWei: fill.fillInWei,
      cyclesClosedDelta: 0,
      realizedDeltaUWei: 0n,
      residualDeltaWei: 0n,
      executedBlock: finalized?.number ?? fill.blockNumber,
      executedAtSec: finalized?.timestampSec ?? null,
      // BC29: the plan is a SNAPSHOT of the partition, not of the floors. Every
      // chunk's floor is recomputed with the CURRENT fee valuation before every
      // intent, so a stale valuation can never admit a sell that no longer
      // covers its own gas.
      exitPlanJson: JSON.stringify({
        chunks: plan.map((chunk) => chunk.toString(10)),
        capLimitWei: job.wbnbCapMinLimitWei.toString(10),
      }),
      nowMs,
    });
    return result.kind === "ok";
  }
  const remaining = level.baseWei > action.amountInWei
    ? level.baseWei - action.amountInWei
    : 0n;
  let shares: ReturnType<typeof exitShares>;
  try {
    shares = exitShares({
      amountWei: action.amountInWei,
      baseWei: level.baseWei,
      baseAtCycleStartWei: level.baseAtCycleStartWei || level.baseWei,
      basisUWei: level.basisUWei,
      entryCostUWei: level.entryCostUWei,
    });
  } catch {
    return false;
  }
  const closes = shares.closes;
  // The realized delta is the cycle's PROCEEDS minus the share of basis this
  // chunk carried. The final chunk carries the rounding residual, so the sum of
  // the shares equals the basis exactly (R4.4).
  const basisShare = shares.basisShareUWei;
  const result = await deps.store.settleAction({
    journalKey: action.journalKey,
    quantJobId: job.quantJobId,
    levelIndex: action.levelIndex,
    txHash: fill.txHash,
    swapLogIndex: fill.swapLogIndex,
    fillInWei: fill.fillInWei,
    fillOutWei: fill.fillOutWei,
    feeDeltaWei,
    entryCostUWei: closes ? 0n : level.entryCostUWei,
    nextLevelState: closes ? "armed-quote" : "holding-base",
    nextBaseWei: closes ? 0n : remaining,
    nextBaseAtCycleStartWei: closes ? 0n : level.baseAtCycleStartWei,
    nextBasisUWei: closes ? 0n : level.basisUWei - basisShare,
    cyclesClosedDelta: closes ? 1 : 0,
    realizedDeltaUWei: fill.fillOutWei - basisShare,
    // A cycle that closes with an unsold remainder records it as RESIDUAL, and
    // the level keeps it as unattributed inventory (R7.2). Nothing is dropped.
    residualDeltaWei: closes ? remaining : 0n,
    executedBlock: finalized?.number ?? fill.blockNumber,
    executedAtSec: finalized?.timestampSec ?? null,
    exitPlanJson: closes ? null : level.exitPlanJson,
    nowMs,
  });
  return result.kind === "ok";
}

/**
 * The R3.3 table, driven for every non-terminal action of one job.
 *
 * ONE bounded read per action per cycle. No polling loop, no `awaitExecution`.
 */
export async function recoverUnsettledActions(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
): Promise<readonly QuantReconcileOutcome[]> {
  const actions = await deps.store.listNonTerminalActions(job.quantJobId);
  const outcomes: QuantReconcileOutcome[] = [];
  for (const action of actions) {
    outcomes.push(await recoverOne(deps, job, action));
  }
  return outcomes;
}

async function recoverOne(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
): Promise<QuantReconcileOutcome> {
  const entry = await deps.journal.get(action.journalKey);
  const nowMs = deps.nowMs();

  /* journal: none */
  if (entry === null) {
    if (action.state === "intended") {
      // R5.2: the abort is a CAS on the SAME row and version the sender's
      // `intended → submitted` CAS uses, so exactly one of the two wins. Only a
      // recovery that WON may touch the journal; one that lost does nothing.
      const aborted = await deps.store.abortIntent({
        journalKey: action.journalKey,
        expectedRowVersion: action.rowVersion,
        nowMs,
      });
      return {
        journalKey: action.journalKey,
        cell: "none/intended",
        settled: false,
        released: aborted.kind === "ok",
      };
    }
    // A `submitted` action with no journal row is impossible by construction
    // (the CAS runs after `begin`), so it is an operator matter, not a guess.
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "needs-operator",
      failureCode: `none/${action.state}`, nowMs,
    });
    return {
      journalKey: action.journalKey, cell: `none/${action.state}`,
      settled: false, released: false,
    };
  }

  switch (entry.state) {
    case "PENDING":
      return recoverPending(deps, job, action, entry, nowMs);
    case "IN_PROGRESS":
      return recoverInProgress(deps, job, action, entry, nowMs);
    case "COMMITTED":
      return recoverCommitted(deps, job, action, entry, nowMs);
    case "ROLLED_BACK":
      await deps.store.setActionState({
        journalKey: action.journalKey, state: "failed",
        failureCode: entry.lastError ?? "rolled-back", restoreLevel: true, nowMs,
      });
      return {
        journalKey: action.journalKey, cell: "ROLLED_BACK/*",
        settled: false, released: true,
      };
    case "UNKNOWN":
      return recoverUnknown(deps, job, action, entry, nowMs);
    default:
      return {
        journalKey: action.journalKey, cell: `${entry.state}/${action.state}`,
        settled: false, released: false,
      };
  }
}

async function recoverPending(
  deps: QuantReconcileDeps,
  _job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  if (action.state === "intended") {
    // R5.2 again: the CAS decides, and only the winner may move the journal.
    // `PENDING → ROLLED_BACK` is a legal transition, and "never-submitted" is
    // TRUE here — the `submitted` CAS provably never ran.
    const aborted = await deps.store.abortIntent({
      journalKey: action.journalKey,
      expectedRowVersion: action.rowVersion,
      nowMs,
    });
    if (aborted.kind === "ok") {
      await deps.journal.markRolledBack(action.journalKey, "never-submitted");
    }
    return {
      journalKey: action.journalKey, cell: "PENDING/intended",
      settled: false, released: aborted.kind === "ok",
    };
  }
  if (entry.externalRef.callsId === undefined
    && nowMs - entry.updatedAt < 2 * SUBMIT_TIMEOUT_MS) {
    return {
      journalKey: action.journalKey, cell: "PENDING/submitted(wait)",
      settled: false, released: false,
    };
  }
  // Older than two submit windows with no callsId: the boot reconcile parks it
  // UNKNOWN. Until then, WAIT — never guess.
  return {
    journalKey: action.journalKey, cell: "PENDING/submitted",
    settled: false, released: false,
  };
}

async function recoverInProgress(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  const callsId = entry.externalRef.callsId;
  if (callsId === undefined || deps.provider.readExecutionStatus === undefined) {
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/no-read",
      settled: false, released: false,
    };
  }
  let txHash: Hex | undefined;
  let status: "CONFIRMED" | "FAILED" | "PENDING";
  try {
    const reading = await deps.provider.readExecutionStatus({ callsId });
    status = reading.receipt.status;
    txHash = reading.receipt.transactionHash;
  } catch {
    // Relay unavailability NEVER produces a verdict here (PHASE3.14's rule one
    // layer up): the action keeps its state and the next cycle asks again.
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/unreadable",
      settled: false, released: false,
    };
  }
  if (status === "CONFIRMED" && txHash !== undefined) {
    await deps.journal.markCommitted(action.journalKey, { txHash });
    const verdict = await verifyAndSettle(deps, job, action, txHash);
    if (verdict.ok) {
      return {
        journalKey: action.journalKey, cell: "IN_PROGRESS/confirmed",
        settled: true, released: true,
      };
    }
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "committed-unverified",
      failureCode: verdict.code, txHash, nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/unverified",
      settled: false, released: false,
    };
  }
  if (status === "FAILED") {
    await deps.journal.markRolledBack(action.journalKey, "relay reported FAILED");
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "failed",
      failureCode: "relay-failed", restoreLevel: true, nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/failed",
      settled: false, released: true,
    };
  }
  return {
    journalKey: action.journalKey, cell: "IN_PROGRESS/pending",
    settled: false, released: false,
  };
}

async function recoverCommitted(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  const txHash = entry.externalRef.txHash ?? action.txHash;
  if (txHash === null || txHash === undefined) {
    // COMMITTED with no hash: ONE bounded read for it, then the operator.
    const callsId = entry.externalRef.callsId;
    if (callsId !== undefined && deps.provider.readExecutionStatus !== undefined) {
      try {
        const reading = await deps.provider.readExecutionStatus({ callsId });
        const found = reading.receipt.transactionHash;
        if (found !== undefined) {
          const verdict = await verifyAndSettle(deps, job, action, found);
          if (verdict.ok) {
            return {
              journalKey: action.journalKey, cell: "COMMITTED-hash/found",
              settled: true, released: true,
            };
          }
        }
      } catch {
        return {
          journalKey: action.journalKey, cell: "COMMITTED-hash/unreadable",
          settled: false, released: false,
        };
      }
    }
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "needs-operator",
      failureCode: "committed-without-hash", nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "COMMITTED-hash/absent",
      settled: false, released: false,
    };
  }
  const verdict = await verifyAndSettle(deps, job, action, txHash);
  if (verdict.ok) {
    return {
      journalKey: action.journalKey, cell: "COMMITTED+hash/verified",
      settled: true, released: true,
    };
  }
  // Unverifiable for 48 h ⇒ the operator. Before that, retry every cycle: a
  // reorg or a lagging node is a reason to ask again, not to decide.
  const stale = nowMs - action.createdAtMs > 48 * 60 * 60 * 1_000;
  await deps.store.setActionState({
    journalKey: action.journalKey,
    state: stale ? "needs-operator" : "committed-unverified",
    failureCode: verdict.code, txHash, nowMs,
  });
  return {
    journalKey: action.journalKey,
    cell: stale ? "COMMITTED+hash/needs-operator" : "COMMITTED+hash/unverified",
    settled: false, released: false,
  };
}

async function recoverUnknown(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  if (action.state === "intended") {
    // The submit CAS never ran, so NOTHING was sent — a durable proof of
    // non-entry, and the ONE case where an UNKNOWN journal row's action may be
    // released. The journal row itself stays UNKNOWN (R3.3, journal API rule).
    const aborted = await deps.store.abortIntent({
      journalKey: action.journalKey,
      expectedRowVersion: action.rowVersion,
      nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "UNKNOWN/intended",
      settled: false, released: aborted.kind === "ok",
    };
  }
  // Positive evidence only. A `callsId` that arrived late is exactly that.
  const callsId = entry.externalRef.callsId;
  if (callsId !== undefined && deps.provider.readExecutionStatus !== undefined) {
    try {
      const reading = await deps.provider.readExecutionStatus({ callsId });
      const txHash = reading.receipt.transactionHash;
      if (reading.receipt.status === "CONFIRMED" && txHash !== undefined) {
        const verdict = await verifyAndSettle(deps, job, action, txHash);
        if (verdict.ok) {
          return {
            journalKey: action.journalKey, cell: "UNKNOWN/settled",
            settled: true, released: true,
          };
        }
      }
    } catch {
      /* Unavailability is not evidence. Ask again next cycle. */
    }
  }
  if (action.state !== "unknown") {
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "unknown",
      failureCode: "journal-unknown", nowMs,
    });
  }
  return {
    journalKey: action.journalKey, cell: "UNKNOWN/blocked",
    settled: false, released: false,
  };
}

/**
 * Whether a level may be RETIRED — the only release for an action whose
 * outcome can never be established (R6.1).
 *
 * BOTH preconditions, on FINALIZED evidence:
 *   1. the key can no longer execute (`isValidKey` false, or expiry passed);
 *   2. the action's router deadline has passed at a finalized block, so any
 *      in-flight batch would revert.
 *
 * Until both hold the level stays blocked and `status` says why.
 */
export async function retirementAllowed(input: {
  readonly action: QuantActionRow;
  readonly keyIsValid: boolean;
  readonly sessionExpiry: number | null;
  readonly finalizedTimestampSec: bigint;
}): Promise<{ readonly allowed: boolean; readonly reason: string }> {
  const deadlinePassed = input.finalizedTimestampSec > BigInt(input.action.deadlineSec);
  const expired = input.sessionExpiry !== null
    && input.finalizedTimestampSec > BigInt(input.sessionExpiry);
  const keyDead = !input.keyIsValid || expired;
  if (!keyDead) return { allowed: false, reason: "session-still-valid" };
  if (!deadlinePassed) return { allowed: false, reason: "deadline-not-passed" };
  return { allowed: true, reason: "key-dead-and-deadline-passed" };
}
