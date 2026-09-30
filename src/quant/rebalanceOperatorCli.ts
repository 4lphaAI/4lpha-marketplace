/** Closed parser, public DTO projection and proof-before-apply CLI dispatcher. */
import type { Hex } from "viem";

export class QuantRebalanceCliError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "QuantRebalanceCliError"; this.code = code; }
}

export type QuantRebalanceOperatorArgs =
  | { readonly command: "status"; readonly jobId: string | null; readonly file?: string }
  | { readonly command: "config-check"; readonly file?: string }
  | { readonly command: "wallet-census" }
  | { readonly command: "resolve"; readonly actionId: Hex; readonly proofMode: "calls-id-read" | "tx" | "not-executed"; readonly txHash?: Hex; readonly yesLive: boolean; readonly file?: string }
  | { readonly command: "retire"; readonly jobId: string; readonly yesLive: boolean; readonly file?: string }
  | { readonly command: "prepare-self-test-db"; readonly allocation: 10 | 30 | 75; readonly file: string; readonly yesLive: boolean }
  | { readonly command: "self-test"; readonly allocation: 10 | 30 | 75; readonly termDays: 2; readonly file: string; readonly yesLive: boolean }
  | { readonly command: "worker"; readonly file: string; readonly yesLive: boolean }
  | { readonly command: "closeout-report"; readonly file: string; readonly yesLive: boolean }
  | { readonly command: "close-grant-claim"; readonly file: string; readonly yesLive: boolean };

export type QuantRebalancePublicJob = Readonly<{
  jobId: string;
  strategyKind: "grid" | "rebalance";
  strategyId: string;
  wallet: `0x${string}`;
  status: string;
  rowVersion: number;
  admitted: boolean;
  allocationWei: string | null;
  endsAtMs: number | null;
  sessionExpiresAtMs: number | null;
  revokedAtMs: number | null;
  holdCode: string | null;
  claimMode: "free" | "provisional" | "active" | null;
  claimGeneration: string | null;
  accountingState: string | null;
  accountingRev: string | null;
  checkStates: readonly string[];
  actionStates: readonly string[];
  actionSetDigest: Hex | null;
  reportStatus: string | null;
  managedBalances: Readonly<{ USDC: string | null; WBNB: string | null; ETH: string | null; CAKE: string | null }>;
  bootstrapStatus: "bootstrap-partial" | "bootstrap-complete" | null;
  reportAttempts: number;
  reportPayloadDigest: Hex | null;
  reportResponseStatus: number | null;
  reportNotesApplied: number | null;
  realizedUsdcWei: string | null;
  markedValues: Readonly<{ USDC: string | null; WBNB: string | null; ETH: string | null; CAKE: string | null }>;
  markedPortfolioUsdcWei: string | null;
  residualUsdcWei: string | null;
  markBlock: string | null;
  markHash: Hex | null;
  partialReason: string | null;
  unresolvedReason: string | null;
  retiredAtMs: number | null;
  retainedClaimReason: "not-executed-journal-unknown" | null;
  retainedClaimRemedy: "use-separate-wallet-for-next-job" | null;
  actionDetails: readonly Readonly<{
    actionId: Hex | null; side: "buy" | "sell" | null; asset: "WBNB" | "ETH" | "CAKE" | null;
    state: string | null; amountInWei: string | null; fillInWei: string | null; fillOutWei: string | null;
    realizedDeltaUsdcWei: string | null; txHash: Hex | null; proofDigest: Hex | null;
    receiptBlockNumber: string | null; receiptBlockHash: Hex | null; failureCode: string | null; ambiguousCause: string | null;
  }>[];
}>;

export type QuantRebalanceStatusOutput = Readonly<{
  schema: "ready" | "migration-not-installed";
  jobs: readonly QuantRebalancePublicJob[];
  code: string | null;
}>;

export type QuantRebalanceConfigCheckOutput = Readonly<{
  chainId: 56 | null;
  ready: boolean;
  configProfileId: string | null;
  capabilityProfileId: string | null;
  configDigest: Hex | null;
  encryptionKeyRegistered: boolean | null;
  reasons: readonly string[];
}>;

/** The CLI remains local-only until a reviewed G1 activation checker exists. */
export function localQuantRebalanceConfigCheck(input: {
  readonly chainId: number;
  readonly enabled: boolean;
  readonly flagValid: boolean;
  readonly configProfileCount: number;
  readonly capabilityProfileCount: number;
}): QuantRebalanceConfigCheckOutput {
  if (input.chainId !== 56) return { chainId: null, ready: false, configProfileId: null,
    capabilityProfileId: null, configDigest: null, encryptionKeyRegistered: null, reasons: ["chain-not-56"] };
  if (input.configProfileCount === 0 || input.capabilityProfileCount === 0) return { chainId: 56, ready: false,
    configProfileId: null, capabilityProfileId: null, configDigest: null, encryptionKeyRegistered: null,
    reasons: [...(!input.enabled ? ["rebalancing-disabled"] : []),
      ...(input.capabilityProfileCount === 0 ? ["production-capability-profile-missing"] : []),
      ...(input.configProfileCount === 0 ? ["platform-config-unreviewed"] : [])] };
  if (!input.flagValid) return { chainId: 56, ready: false, configProfileId: null,
    capabilityProfileId: null, configDigest: null, encryptionKeyRegistered: null, reasons: ["rebalancing-flag-invalid"] };
  return { chainId: 56, ready: false, configProfileId: null, capabilityProfileId: null,
    configDigest: null, encryptionKeyRegistered: null,
    reasons: ["activation-check-deferred", ...(input.enabled ? [] : ["rebalancing-disabled"]) ] };
}

export type QuantRebalanceCensusGroup = Readonly<{
  wallet: `0x${string}`;
  receiptOwnershipCount: number;
  jobs: readonly Readonly<{
    strategyKind: "grid" | "rebalance"; jobId: string; status: string; rowVersion: number; admitted: boolean;
    receiptOwnershipCount: number; sessionExpirySec: number | null; revokedAtMs: number | null;
    claimGeneration: string | null; accountingDigest: Hex; actionStates: readonly string[]; actionSetDigest: Hex;
  }>[];
  claimMode: "free" | "provisional" | "active" | null;
  claimGeneration: string | null;
  dispositionRequired: boolean;
  actionSetDigest: Hex;
}>;

export type QuantRebalanceWalletCensusOutput = Readonly<{
  schema: "ready" | "migration-not-installed";
  migrationInstalled: boolean;
  digest: Hex | null;
  groups: readonly QuantRebalanceCensusGroup[];
  code: string | null;
}>;

/** Only fields useful for operator proof review are printable. */
export type QuantRebalancePublicEvidence = Readonly<{
  actionId: Hex | null;
  jobId: string | null;
  txHash: Hex | null;
  proofDigest: Hex | null;
  blockNumber: string | null;
  blockHash: Hex | null;
  journalState: string | null;
  actionState: string | null;
  claimGeneration: string | null;
  code: string | null;
  keyDead: boolean | null;
  deadlinePassed: boolean | null;
  vectorDigest: Hex | null;
}>;

export type QuantRebalanceCliPublicResult =
  | Readonly<{ kind: "status"; data: QuantRebalanceStatusOutput }>
  | Readonly<{ kind: "config-check"; data: QuantRebalanceConfigCheckOutput }>
  | Readonly<{ kind: "wallet-census"; data: QuantRebalanceWalletCensusOutput }>
  | Readonly<{ kind: "resolve" | "retire"; verdict: "proven" | "refused" | "applied"; code: string; evidence: QuantRebalancePublicEvidence; writes: boolean }>;

function validId(value: string): boolean { return value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/u.test(value); }
function isHash(value: string): value is Hex { return /^0x[0-9a-fA-F]{64}$/u.test(value); }
function readValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) throw new QuantRebalanceCliError(`missing-${name}`);
  return value;
}

export function parseQuantRebalanceOperatorArgs(argv: readonly string[]): QuantRebalanceOperatorArgs {
  const command = argv[0];
  if (command === undefined) throw new QuantRebalanceCliError("command-required");
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith("--")) throw new QuantRebalanceCliError("argument-invalid");
    if (flags.has(flag)) throw new QuantRebalanceCliError("flag-duplicate");
    flags.add(flag);
    if (["--job", "--action", "--tx", "--file", "--allocation-usdc", "--term-days"].includes(flag)) {
      values.set(flag, readValue(argv, index, flag.slice(2)));
      index += 1;
    }
  }
  const allowed = (list: readonly string[]) => [...flags].every((flag) => list.includes(flag));
  const file = values.get("--file");
  if (file !== undefined && (file.length === 0 || file.length > 260 || file.includes("\0"))) throw new QuantRebalanceCliError("file-path-invalid");
  if (command === "prepare-self-test-db" || command === "self-test") {
    if (!allowed(command === "self-test" ? ["--allocation-usdc", "--term-days", "--file", "--yes-live"]
      : ["--allocation-usdc", "--file", "--yes-live"])) throw new QuantRebalanceCliError("flag-unsupported");
    const allocationText = values.get("--allocation-usdc");
    if (allocationText !== "10" && allocationText !== "30" && allocationText !== "75") throw new QuantRebalanceCliError("allocation-invalid");
    if (file === undefined) throw new QuantRebalanceCliError("file-required");
    const allocation = Number(allocationText) as 10 | 30 | 75;
    if (command === "self-test") {
      if (values.get("--term-days") !== "2") throw new QuantRebalanceCliError("term-days-invalid");
      return { command, allocation, termDays: 2, file, yesLive: flags.has("--yes-live") };
    }
    return { command, allocation, file, yesLive: flags.has("--yes-live") };
  }
  if (command === "worker" || command === "closeout-report" || command === "close-grant-claim") {
    if (!allowed(["--file", "--yes-live"]) || file === undefined) throw new QuantRebalanceCliError("flag-unsupported");
    return { command, file, yesLive: flags.has("--yes-live") };
  }
  if (command === "status") {
    if (!allowed(["--job", "--file"])) throw new QuantRebalanceCliError("flag-unsupported");
    const jobId = values.get("--job") ?? null;
    if (jobId !== null && !validId(jobId)) throw new QuantRebalanceCliError("job-id-invalid");
    return { command, jobId, ...(file === undefined ? {} : { file }) };
  }
  if (command === "config-check") {
    if (!allowed(["--file"])) throw new QuantRebalanceCliError("flag-unsupported");
    return { command, ...(file === undefined ? {} : { file }) };
  }
  if (command === "wallet-census") {
    if (flags.size !== 0) throw new QuantRebalanceCliError("flag-unsupported");
    return { command };
  }
  if (command === "resolve") {
    if (!allowed(["--action", "--calls-id-read", "--tx", "--not-executed", "--yes-live", "--file"])) throw new QuantRebalanceCliError("flag-unsupported");
    const actionId = values.get("--action");
    if (actionId === undefined || !isHash(actionId)) throw new QuantRebalanceCliError("action-id-invalid");
    const modes = ["--calls-id-read", "--tx", "--not-executed"].filter((flag) => flags.has(flag));
    if (modes.length !== 1) throw new QuantRebalanceCliError("proof-mode-required");
    const mode = modes[0];
    if (mode === "--tx") {
      const txHash = values.get("--tx");
      if (txHash === undefined || !isHash(txHash)) throw new QuantRebalanceCliError("tx-hash-invalid");
      return { command, actionId, proofMode: "tx", txHash, yesLive: flags.has("--yes-live"), ...(file === undefined ? {} : { file }) };
    }
    if (values.has("--tx")) throw new QuantRebalanceCliError("flag-conflict");
    return { command, actionId, proofMode: mode === "--calls-id-read" ? "calls-id-read" : "not-executed", yesLive: flags.has("--yes-live"), ...(file === undefined ? {} : { file }) };
  }
  if (command === "retire") {
    if (!allowed(["--job", "--yes-live", "--file"])) throw new QuantRebalanceCliError("flag-unsupported");
    const jobId = values.get("--job");
    if (jobId === undefined || !validId(jobId)) throw new QuantRebalanceCliError("job-id-invalid");
    return { command, jobId, yesLive: flags.has("--yes-live"), ...(file === undefined ? {} : { file }) };
  }
  // No arbitrary grant, seal, trade, report, register-key, force or migration
  // command exists outside the closed G2 file rehearsal shapes above.
  throw new QuantRebalanceCliError("command-unsupported");
}

export type QuantRebalanceCliRehearsal = Readonly<{
  ok: boolean;
  code: string;
  evidence: unknown;
  /** The callback must rerun all evidence and use a fenced CAS. */
  apply: () => Promise<unknown>;
}>;

export type QuantRebalanceOperatorPorts = Readonly<{
  close?: () => Promise<void>;
  status: (jobId: string | null) => Promise<unknown>;
  configCheck: () => Promise<unknown>;
  walletCensus: () => Promise<unknown>;
  resolve: (input: Extract<QuantRebalanceOperatorArgs, { readonly command: "resolve" }>) => Promise<QuantRebalanceCliRehearsal>;
  retire: (input: Extract<QuantRebalanceOperatorArgs, { readonly command: "retire" }>) => Promise<QuantRebalanceCliRehearsal>;
}>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeText(value: unknown, pattern = /^[a-z0-9._:-]{1,200}$/iu): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}
function safeAddress(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value) ? value.toLowerCase() as `0x${string}` : null;
}
function safeHash(value: unknown): Hex | null { return typeof value === "string" && isHash(value) ? value.toLowerCase() as Hex : null; }
function safeDecimal(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString(10) : null;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
function safeSignedDecimal(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}
function safeMs(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeEnum(value: unknown, allowed: readonly string[]): string | null { return typeof value === "string" && allowed.includes(value) ? value : null; }
function safeStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeEnum(item, ["discovered", "admitted", "held", "paused", "ended", "ended-unresolved", "reported", "intended", "submitted", "committed-unverified", "unknown", "needs-operator", "settled", "failed", "aborted", "retired", "done", "rebalancing"])).filter((item): item is string => item !== null);
}

function sanitizePublicJob(value: unknown): QuantRebalancePublicJob | null {
  const raw = record(value);
  const jobId = safeText(raw["jobId"]);
  const wallet = safeAddress(raw["wallet"]);
  const strategyKind = raw["strategyKind"] === "grid" || raw["strategyKind"] === "rebalance" ? raw["strategyKind"] : null;
  const strategyId = safeText(raw["strategyId"]);
  const status = safeEnum(raw["status"], ["discovered", "admitted", "held", "paused", "ended", "ended-unresolved", "reported", "armed"]);
  const rowVersion = raw["rowVersion"];
  if (jobId === null || wallet === null || strategyKind === null || strategyId === null || status === null
    || typeof rowVersion !== "number" || !Number.isSafeInteger(rowVersion) || rowVersion < 0) return null;
  const claim = safeEnum(raw["claimMode"], ["free", "provisional", "active"]);
  const managedRaw = record(raw["managedBalances"]);
  const reportAttempts = raw["reportAttempts"];
  const reportResponseStatus = raw["reportResponseStatus"];
  const reportNotesApplied = raw["reportNotesApplied"];
  const markedRaw = record(raw["markedValues"]);
  const actionDetails: NonNullable<QuantRebalancePublicJob["actionDetails"]>[number][] = [];
  if (Array.isArray(raw["actionDetails"])) for (const item of raw["actionDetails"]) {
    const action = record(item);
    const side = action["side"] === "buy" || action["side"] === "sell" ? action["side"] : null;
    const asset = action["asset"] === "WBNB" || action["asset"] === "ETH" || action["asset"] === "CAKE" ? action["asset"] : null;
    actionDetails.push({ actionId: safeHash(action["actionId"]), side, asset,
      state: safeEnum(action["state"], ["intended", "submitted", "committed-unverified", "unknown", "needs-operator", "settled", "failed", "aborted", "retired"]),
      amountInWei: safeDecimal(action["amountInWei"]), fillInWei: safeDecimal(action["fillInWei"]),
      fillOutWei: safeDecimal(action["fillOutWei"]), realizedDeltaUsdcWei: safeSignedDecimal(action["realizedDeltaUsdcWei"]),
      txHash: safeHash(action["txHash"]), proofDigest: safeHash(action["proofDigest"]),
      receiptBlockNumber: safeDecimal(action["receiptBlockNumber"]), receiptBlockHash: safeHash(action["receiptBlockHash"]),
      failureCode: safeText(action["failureCode"], /^[a-z0-9-]{1,64}$/u),
      ambiguousCause: safeText(action["ambiguousCause"], /^[a-z0-9-]{1,64}$/u) });
  }
  return {
    jobId, strategyKind, strategyId, wallet, status, rowVersion,
    admitted: raw["admitted"] === true,
    allocationWei: safeDecimal(raw["allocationWei"]), endsAtMs: safeMs(raw["endsAtMs"]),
    sessionExpiresAtMs: safeMs(raw["sessionExpiresAtMs"]), revokedAtMs: raw["revokedAtMs"] === null ? null : safeMs(raw["revokedAtMs"]),
    holdCode: safeText(raw["holdCode"], /^[a-z0-9-]{1,64}$/u), claimMode: claim as QuantRebalancePublicJob["claimMode"],
    claimGeneration: safeDecimal(raw["claimGeneration"]),
    accountingState: safeEnum(raw["accountingState"], ["unverified", "verified", "held", "unknown", "not-applicable"]),
    accountingRev: safeDecimal(raw["accountingRev"]),
    checkStates: safeStrings(raw["checkStates"]), actionStates: safeStrings(raw["actionStates"]),
    actionSetDigest: safeHash(raw["actionSetDigest"]),
    reportStatus: safeEnum(raw["reportStatus"], ["pending", "reported", "unavailable", "exhausted", "not-applicable"]),
    managedBalances: { USDC: safeDecimal(managedRaw["USDC"]), WBNB: safeDecimal(managedRaw["WBNB"]),
      ETH: safeDecimal(managedRaw["ETH"]), CAKE: safeDecimal(managedRaw["CAKE"]) },
    bootstrapStatus: safeEnum(raw["bootstrapStatus"], ["bootstrap-partial", "bootstrap-complete"]) as QuantRebalancePublicJob["bootstrapStatus"],
    reportAttempts: typeof reportAttempts === "number" && Number.isSafeInteger(reportAttempts) && reportAttempts >= 0 ? reportAttempts : 0,
    reportPayloadDigest: safeHash(raw["reportPayloadDigest"]),
    reportResponseStatus: typeof reportResponseStatus === "number" && Number.isSafeInteger(reportResponseStatus)
      && reportResponseStatus >= 0 && reportResponseStatus <= 599 ? reportResponseStatus : null,
    reportNotesApplied: typeof reportNotesApplied === "number" && Number.isSafeInteger(reportNotesApplied)
      && reportNotesApplied >= 0 ? reportNotesApplied : null,
    realizedUsdcWei: safeSignedDecimal(raw["realizedUsdcWei"]),
    markedValues: { USDC: safeDecimal(markedRaw["USDC"]), WBNB: safeDecimal(markedRaw["WBNB"]),
      ETH: safeDecimal(markedRaw["ETH"]), CAKE: safeDecimal(markedRaw["CAKE"]) },
    markedPortfolioUsdcWei: safeDecimal(raw["markedPortfolioUsdcWei"]),
    residualUsdcWei: safeDecimal(raw["residualUsdcWei"]), markBlock: safeDecimal(raw["markBlock"]),
    markHash: safeHash(raw["markHash"]), partialReason: safeText(raw["partialReason"], /^[a-z0-9-]{1,64}$/u),
    unresolvedReason: safeText(raw["unresolvedReason"], /^[a-z0-9-]{1,64}$/u),
    retiredAtMs: safeMs(raw["retiredAtMs"]),
    retainedClaimReason: raw["retainedClaimReason"] === "not-executed-journal-unknown" ? "not-executed-journal-unknown" : null,
    retainedClaimRemedy: raw["retainedClaimRemedy"] === "use-separate-wallet-for-next-job" ? "use-separate-wallet-for-next-job" : null,
    actionDetails,
  };
}

export function sanitizeQuantRebalanceStatus(value: unknown): QuantRebalanceStatusOutput {
  const raw = record(value);
  const jobs = Array.isArray(raw["jobs"]) ? raw["jobs"].map(sanitizePublicJob).filter((job): job is QuantRebalancePublicJob => job !== null) : [];
  return { schema: raw["schema"] === "ready" ? "ready" : "migration-not-installed", jobs,
    code: safeText(raw["code"], /^[a-z0-9-]{1,64}$/u) };
}

export function sanitizeQuantRebalanceConfigCheck(value: unknown): QuantRebalanceConfigCheckOutput {
  const raw = record(value);
  const reasons = Array.isArray(raw["reasons"])
    ? raw["reasons"].map((item) => safeText(item, /^[a-z0-9-]{1,64}$/u)).filter((item): item is string => item !== null) : [];
  return { chainId: raw["chainId"] === 56 ? 56 : null, ready: raw["ready"] === true,
    configProfileId: safeText(raw["configProfileId"]), capabilityProfileId: safeText(raw["capabilityProfileId"]),
    configDigest: safeHash(raw["configDigest"]), encryptionKeyRegistered: typeof raw["encryptionKeyRegistered"] === "boolean" ? raw["encryptionKeyRegistered"] : null,
    reasons };
}

export function sanitizeQuantRebalanceWalletCensus(value: unknown): QuantRebalanceWalletCensusOutput {
  const raw = record(value);
  const groups: QuantRebalanceCensusGroup[] = [];
  if (Array.isArray(raw["groups"])) for (const entry of raw["groups"]) {
    const group = record(entry); const wallet = safeAddress(group["wallet"]); const digest = safeHash(group["actionSetDigest"]);
    if (wallet === null || digest === null) continue;
    const receiptOwnershipCount = group["receiptOwnershipCount"];
    if (typeof receiptOwnershipCount !== "number" || !Number.isSafeInteger(receiptOwnershipCount) || receiptOwnershipCount < 0) continue;
    const jobs: Array<QuantRebalanceCensusGroup["jobs"][number]> = [];
    if (Array.isArray(group["jobs"])) for (const item of group["jobs"]) {
      const job = record(item); const strategyKind = job["strategyKind"] === "grid" || job["strategyKind"] === "rebalance" ? job["strategyKind"] : null;
      const jobId = safeText(job["jobId"]); const status = safeEnum(job["status"], ["discovered", "admitted", "held", "paused", "ended", "ended-unresolved", "reported", "armed"]);
      const rowVersion = job["rowVersion"]; const receiptOwnershipCount = job["receiptOwnershipCount"];
      const sessionExpirySec = typeof job["sessionExpirySec"] === "number" && Number.isSafeInteger(job["sessionExpirySec"]) && job["sessionExpirySec"] >= 0 ? job["sessionExpirySec"] : null;
      const revokedAtMs = typeof job["revokedAtMs"] === "number" && Number.isSafeInteger(job["revokedAtMs"]) && job["revokedAtMs"] >= 0 ? job["revokedAtMs"] : null;
      const actionStates = Array.isArray(job["actionStates"]) ? job["actionStates"].map((state) => safeEnum(state,
        ["intended", "submitted", "committed-unverified", "unknown", "needs-operator", "settled", "failed", "aborted", "retired"])) : [];
      const actionSetDigest = safeHash(job["actionSetDigest"]); const accountingDigest = safeHash(job["accountingDigest"]);
      if (strategyKind !== null && jobId !== null && status !== null && typeof rowVersion === "number" && Number.isSafeInteger(rowVersion) && rowVersion >= 0
        && typeof receiptOwnershipCount === "number" && Number.isSafeInteger(receiptOwnershipCount) && receiptOwnershipCount >= 0
        && (job["sessionExpirySec"] === null || typeof job["sessionExpirySec"] === "number" && Number.isSafeInteger(job["sessionExpirySec"]))
        && (job["revokedAtMs"] === null || typeof job["revokedAtMs"] === "number" && Number.isSafeInteger(job["revokedAtMs"]))
        && (job["claimGeneration"] === null || safeDecimal(job["claimGeneration"]) !== null) && actionStates.every((state) => state !== null)
        && actionSetDigest !== null && accountingDigest !== null) {
        jobs.push({ strategyKind, jobId, status, rowVersion, admitted: job["admitted"] === true, receiptOwnershipCount,
          sessionExpirySec, revokedAtMs, claimGeneration: safeDecimal(job["claimGeneration"]),
          accountingDigest, actionStates: actionStates as string[], actionSetDigest });
      }
    }
    groups.push({ wallet, receiptOwnershipCount, jobs, claimMode: safeEnum(group["claimMode"], ["free", "provisional", "active"]) as QuantRebalanceCensusGroup["claimMode"],
      claimGeneration: safeDecimal(group["claimGeneration"]), dispositionRequired: group["dispositionRequired"] === true, actionSetDigest: digest });
  }
  return { schema: raw["schema"] === "ready" ? "ready" : "migration-not-installed", migrationInstalled: raw["migrationInstalled"] === true,
    digest: safeHash(raw["digest"]), groups,
    code: safeText(raw["code"], /^[a-z0-9-]{1,64}$/u) };
}

export function sanitizeQuantRebalanceEvidence(value: unknown): QuantRebalancePublicEvidence {
  const raw = record(value);
  return {
    actionId: safeHash(raw["actionId"]), jobId: safeText(raw["jobId"]), txHash: safeHash(raw["txHash"]),
    proofDigest: safeHash(raw["proofDigest"]), blockNumber: safeDecimal(raw["blockNumber"]), blockHash: safeHash(raw["blockHash"]),
    journalState: safeEnum(raw["journalState"], ["PENDING", "IN_PROGRESS", "COMMITTED", "ROLLED_BACK", "UNKNOWN"]),
    actionState: safeEnum(raw["actionState"], ["intended", "submitted", "committed-unverified", "unknown", "needs-operator", "settled", "failed", "aborted", "retired"]),
    claimGeneration: safeDecimal(raw["claimGeneration"]), code: safeText(raw["code"], /^[a-z0-9-]{1,64}$/u),
    keyDead: typeof raw["keyDead"] === "boolean" ? raw["keyDead"] : null,
    deadlinePassed: typeof raw["deadlinePassed"] === "boolean" ? raw["deadlinePassed"] : null,
    vectorDigest: safeHash(raw["vectorDigest"]),
  };
}

export async function runQuantRebalanceOperatorCommand(
  args: QuantRebalanceOperatorArgs,
  ports: QuantRebalanceOperatorPorts,
): Promise<{ readonly data: QuantRebalanceCliPublicResult; readonly error?: string }> {
  if (args.command === "prepare-self-test-db" || args.command === "self-test" || args.command === "worker"
    || args.command === "closeout-report"
    || args.command === "close-grant-claim" || "file" in args && args.file !== undefined) {
    throw new QuantRebalanceCliError("file-mode-requires-entry");
  }
  if (args.command === "status") return { data: { kind: "status", data: sanitizeQuantRebalanceStatus(await ports.status(args.jobId)) } };
  if (args.command === "config-check") return { data: { kind: "config-check", data: sanitizeQuantRebalanceConfigCheck(await ports.configCheck()) } };
  if (args.command === "wallet-census") return { data: { kind: "wallet-census", data: sanitizeQuantRebalanceWalletCensus(await ports.walletCensus()) } };
  const operation = args.command === "resolve" ? await ports.resolve(args) : await ports.retire(args);
  const code = safeText(operation.code, /^[a-z0-9-]{1,64}$/u) ?? "proof-refused";
  const evidence = sanitizeQuantRebalanceEvidence(operation.evidence);
  const rehearsal = { kind: args.command, verdict: operation.ok ? "proven" as const : "refused" as const,
    code, evidence, writes: false };
  if (!args.yesLive) return { data: rehearsal };
  if (!operation.ok) return { data: rehearsal, error: code };
  const applied = await operation.apply();
  return { data: { kind: args.command, verdict: "applied", code, evidence: sanitizeQuantRebalanceEvidence(applied), writes: true } };
}

/** Re-project even already-projected values at the stdout boundary. */
export function safeQuantRebalanceCliJson(value: unknown): string {
  const raw = record(value);
  const data = record(raw["data"]);
  const kind = data["kind"];
  let safe: QuantRebalanceCliPublicResult | { readonly error: string };
  if (kind === "status") safe = { kind, data: sanitizeQuantRebalanceStatus(data["data"]) };
  else if (kind === "config-check") safe = { kind, data: sanitizeQuantRebalanceConfigCheck(data["data"]) };
  else if (kind === "wallet-census") safe = { kind, data: sanitizeQuantRebalanceWalletCensus(data["data"]) };
  else if (kind === "resolve" || kind === "retire") {
    const verdict = safeEnum(data["verdict"], ["proven", "refused", "applied"]);
    safe = { kind, verdict: verdict === "proven" || verdict === "applied" ? verdict : "refused",
      code: safeText(data["code"], /^[a-z0-9-]{1,64}$/u) ?? "proof-refused",
      evidence: sanitizeQuantRebalanceEvidence(data["evidence"]), writes: data["writes"] === true };
  } else safe = { error: "output-invalid" };
  const error = safeText(raw["error"], /^[a-z0-9-]{1,64}$/u);
  const output = error === null ? safe : { data: safe, error };
  return JSON.stringify(output, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item, 2);
}
