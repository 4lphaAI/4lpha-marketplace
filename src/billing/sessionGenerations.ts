import { getAddress, isAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { paramsHash as ownerActionParamsHash } from "../auth/canonical.js";
import { decodeJsonb, encodeJsonbParam } from "../store/codec.js";
import type { SqlClient } from "../store/sql.js";
import type { BillingStoreSnapshot } from "./store.js";
import { livePayerExposureAtomic } from "./payerBalances.js";
import { billingAccountCustodyKind, type BillingAccount } from "./types.js";

export const BILLING_PRODUCTION_MIGRATION = "006_phase5_production_enablement.sql" as const;

export const BILLING_SESSION_GENERATIONS_DDL = `
  alter table phase5_billing_accounts
    alter column encrypted_session_key drop not null,
    add column if not exists session_kms_key_arn text,
    add column if not exists session_generation bigint,
    add column if not exists session_public_key text,
    add column if not exists session_state_version bigint,
    add column if not exists billing_status text;

  update phase5_billing_accounts
    set billing_status = record->>'status'
    where billing_status is null;
  alter table phase5_billing_accounts
    alter column billing_status set not null;

  create table if not exists phase5_billing_session_generations (
    account_id text not null references phase5_billing_accounts(account_id),
    generation bigint not null check (generation between 1 and 9223372036854775807),
    kms_key_arn text not null unique,
    public_key text not null,
    session_facts_bytes text not null,
    session_facts_hash text not null,
    expires_at bigint not null,
    state text not null check (state in
      ('prepared','grant_pending','active_pending_old_revoke','active','retired','abandoned')),
    version bigint not null check (version >= 1),
    created_at bigint not null,
    updated_at bigint not null,
    primary key (account_id,generation)
  );
  create unique index if not exists phase5_billing_session_one_active_uq
    on phase5_billing_session_generations(account_id) where state='active';
  create unique index if not exists phase5_billing_session_one_pending_uq
    on phase5_billing_session_generations(account_id)
    where state in ('grant_pending','active_pending_old_revoke');

  create table if not exists phase5_billing_session_actions (
    action_id text primary key,
    account_id text not null,
    generation bigint not null,
    kind text not null check (kind in ('grant','revoke')),
    target_generation bigint not null,
    target_key_id text not null,
    nonce text not null unique,
    owner_action_idempotency_key text not null unique,
    owner_params_bytes text not null,
    owner_params_hash text not null,
    state text not null check (state in
      ('prepared','owner_refused','submitted','unknown','confirmed','failed')),
    calls_id text unique,
    transaction_hash text unique,
    proof_hash text,
    version bigint not null check (version >= 1),
    created_at bigint not null,
    updated_at bigint not null,
    foreign key (account_id,generation)
      references phase5_billing_session_generations(account_id,generation)
  )
`;

export type BillingSessionGenerationState =
  | "prepared"
  | "grant_pending"
  | "active_pending_old_revoke"
  | "active"
  | "retired"
  | "abandoned";

export type BillingSessionActionState =
  | "prepared"
  | "owner_refused"
  | "submitted"
  | "unknown"
  | "confirmed"
  | "failed";

export type BillingEnablementExposureSnapshotV1 = Readonly<{
  migrationVersion: typeof BILLING_PRODUCTION_MIGRATION;
  liveUsdcExposureAtomic: bigint;
  census: readonly BillingSessionOnCensusEntryV1[];
}>;

export type BillingSessionGenerationV1 = Readonly<{
  accountId: string;
  generation: bigint;
  kmsKeyArn: string;
  publicKey: Hex;
  sessionFactsBytes: string;
  sessionFactsHash: Hex;
  expiresAt: number;
  state: BillingSessionGenerationState;
  version: bigint;
  createdAt: number;
  updatedAt: number;
}>;

export type CanonicalBillingSessionFactsV1 = Readonly<{
  collector: Address;
  publicKey: Hex;
  expiry: number;
  dayCapWei: bigint;
}>;

export type BillingSessionActionV1 = Readonly<{
  actionId: Hex;
  accountId: string;
  generation: bigint;
  kind: "grant" | "revoke";
  targetGeneration: bigint;
  targetKeyId: Hex;
  nonce: Hex;
  ownerActionIdempotencyKey: Hex;
  ownerParamsBytes: string;
  ownerParamsHash: Hex;
  state: BillingSessionActionState;
  callsId?: Hex;
  transactionHash?: Hex;
  proofHash?: Hex;
  version: bigint;
  createdAt: number;
  updatedAt: number;
}>;

const HASH = /^0x[0-9a-f]{64}$/u;
const KMS_ARN = /^arn:aws:kms:[\x21-\x7e]{8,2036}$/u;

function second(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be integer Unix seconds.`);
  return value;
}

function hash(value: string, field: string): asserts value is Hex {
  if (!HASH.test(value)) throw new Error(`${field} must be lowercase bytes32.`);
}

function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).join("|") !== keys.join("|")) {
    throw new Error(`${field} member census is malformed.`);
  }
  return value as Record<string, unknown>;
}

function decimal(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/u.test(value)) {
    throw new Error(`${field} must be canonical decimal.`);
  }
  return BigInt(value);
}

/** Decode the one canonical collector/DAY-cap policy carried by an immutable generation. */
export function canonicalBillingSessionFacts(row: BillingSessionGenerationV1): CanonicalBillingSessionFactsV1 {
  validateBillingSessionGeneration(row);
  const bytes = Buffer.from(row.sessionFactsBytes, "base64");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Session facts are not UTF-8."); }
  let decoded: unknown;
  try { decoded = JSON.parse(text) as unknown; }
  catch { throw new Error("Session facts JSON is malformed."); }
  if (JSON.stringify(decoded) !== text) throw new Error("Session facts JSON is not canonical.");
  const root = exactRecord(decoded, ["version", "spec", "permissions", "publicKey", "expiry"], "Session facts");
  if (root["version"] !== "billing-session-facts-v1") throw new Error("Session facts version is unsupported.");
  const spec = exactRecord(root["spec"], ["allowedCalls", "spendCaps", "expiresAt"], "Session spec");
  const allowedCalls = spec["allowedCalls"];
  const spendCaps = spec["spendCaps"];
  if (!Array.isArray(allowedCalls) || allowedCalls.length !== 1 || !Array.isArray(spendCaps) || spendCaps.length !== 1) {
    throw new Error("Session policy cardinality is invalid.");
  }
  const call = exactRecord(allowedCalls[0], ["to", "selector"], "Session call");
  if (typeof call["to"] !== "string" || call["selector"] !== "payInvoice(bytes32,uint64)") {
    throw new Error("Session call is not the exact collector selector.");
  }
  const collector = canonicalAddress(call["to"], "Session collector");
  if (call["to"] !== collector) throw new Error("Session collector is not canonical lowercase.");
  const cap = exactRecord(spendCaps[0], ["limit", "period"], "Session cap");
  const dayCapWei = decimal(cap["limit"], "Session cap");
  if (dayCapWei < 1n || cap["period"] !== "day") throw new Error("Session cap is not positive DAY authority.");
  const permissions = exactRecord(root["permissions"], ["calls", "spend"], "Session permissions");
  const permissionCalls = permissions["calls"];
  const permissionSpend = permissions["spend"];
  if (!Array.isArray(permissionCalls) || permissionCalls.length !== 1 ||
      !Array.isArray(permissionSpend) || permissionSpend.length !== 1) {
    throw new Error("Session permission cardinality is invalid.");
  }
  const permissionCall = exactRecord(permissionCalls[0], ["signature", "to"], "Session permission call");
  if (permissionCall["signature"] !== "payInvoice(bytes32,uint64)" || permissionCall["to"] !== collector) {
    throw new Error("Session permission call differs from the spec.");
  }
  const permissionCap = exactRecord(permissionSpend[0], ["limit", "period"], "Session permission cap");
  const uint = exactRecord(permissionCap["limit"], ["$uint"], "Session permission uint");
  if (decimal(uint["$uint"], "Session permission limit") !== dayCapWei || permissionCap["period"] !== "day") {
    throw new Error("Session permission cap differs from the spec.");
  }
  if (!Number.isSafeInteger(spec["expiresAt"]) || !Number.isSafeInteger(root["expiry"]) ||
      spec["expiresAt"] !== root["expiry"] || root["expiry"] !== row.expiresAt) {
    throw new Error("Session expiry differs from the generation.");
  }
  if (root["publicKey"] !== row.publicKey) throw new Error("Session public key differs from the generation.");
  return { collector, publicKey: row.publicKey, expiry: row.expiresAt, dayCapWei };
}

export function validateBillingSessionGeneration(row: BillingSessionGenerationV1): void {
  if (row.accountId.length < 1 || row.accountId.length > 256) throw new Error("Session account ID is malformed.");
  if (row.generation < 1n || row.generation > 9_223_372_036_854_775_807n) throw new Error("Session generation is out of range.");
  if (!KMS_ARN.test(row.kmsKeyArn)) throw new Error("Session KMS ARN is malformed.");
  if (!/^0x04[0-9a-f]{128}$/u.test(row.publicKey)) throw new Error("Session public key is not uncompressed SEC1.");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row.sessionFactsBytes) ||
      Buffer.from(row.sessionFactsBytes, "base64").toString("base64") !== row.sessionFactsBytes) {
    throw new Error("Session facts bytes are not canonical base64.");
  }
  if (Buffer.from(row.sessionFactsBytes, "base64").length > 32 * 1024) throw new Error("Session facts exceed 32 KiB.");
  hash(row.sessionFactsHash, "Session facts hash");
  if (keccak256(Buffer.from(row.sessionFactsBytes, "base64")) !== row.sessionFactsHash) {
    throw new Error("Session facts hash mismatch.");
  }
  second(row.expiresAt, "Session expiry");
  second(row.createdAt, "Session creation");
  second(row.updatedAt, "Session update");
  if (!GENERATION_STATES.has(row.state) || row.version < 1n || row.updatedAt < row.createdAt) {
    throw new Error("Session state/version/timestamps are malformed.");
  }
}

export function validateBillingSessionAction(row: BillingSessionActionV1): void {
  if (row.accountId.length < 1 || row.accountId.length > 256) throw new Error("Session action account ID is malformed.");
  for (const [label, value] of [
    ["action ID", row.actionId], ["target key ID", row.targetKeyId], ["nonce", row.nonce],
    ["owner idempotency key", row.ownerActionIdempotencyKey], ["owner params hash", row.ownerParamsHash],
  ] as const) hash(value, label);
  const ownerParams = parseBillingSessionOwnerParamsBytes(row.ownerParamsBytes);
  if (ownerParams.action !== row.kind || ownerParams.accountId !== row.accountId ||
      BigInt(ownerParams.newGeneration) !== row.generation || ownerParams.keyId !== row.targetKeyId ||
      ownerParams.nonce !== row.nonce ||
      ownerActionParamsHash(row.kind === "grant" ? "billingSessionGrant" : "billingSessionRevoke", ownerParams) !== row.ownerParamsHash) {
    throw new Error("Session action owner parameters do not bind the durable action row.");
  }
  if (row.callsId !== undefined) hash(row.callsId, "calls ID");
  if (row.transactionHash !== undefined) hash(row.transactionHash, "transaction hash");
  if (row.proofHash !== undefined) hash(row.proofHash, "proof hash");
  if (!ACTION_STATES.has(row.state) || row.generation < 1n || row.targetGeneration < 1n || row.version < 1n) {
    throw new Error("Session action state/generation/version is malformed.");
  }
  second(row.createdAt, "Action creation");
  second(row.updatedAt, "Action update");
  if (row.updatedAt < row.createdAt) throw new Error("Session action timestamps are malformed.");
  if (row.kind === "grant" && row.generation !== row.targetGeneration) {
    throw new Error("Grant action must target its own generation.");
  }
  if (row.kind === "revoke" && row.generation === row.targetGeneration) {
    throw new Error("Replacement revoke must target the old generation.");
  }
  if ((row.state === "prepared" || row.state === "owner_refused") &&
      (row.callsId !== undefined || row.transactionHash !== undefined || row.proofHash !== undefined)) {
    throw new Error("Uncontacted session action cannot carry chain identity.");
  }
  if ((row.state === "submitted" || row.state === "unknown" || row.state === "confirmed" || row.state === "failed") && row.callsId === undefined) {
    throw new Error("Contacted session action requires a calls ID.");
  }
  if (row.state === "confirmed" && (row.transactionHash === undefined || row.proofHash === undefined)) {
    throw new Error("Confirmed session action requires finalized proof.");
  }
  if (row.state === "failed" && row.transactionHash === undefined) {
    throw new Error("Failed session action requires its terminal transaction hash.");
  }
}

const ACTION_TRANSITIONS: Readonly<Record<BillingSessionActionState, readonly BillingSessionActionState[]>> = {
  prepared: ["owner_refused", "submitted"],
  owner_refused: [],
  submitted: ["unknown", "confirmed", "failed"],
  unknown: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
};

export function transitionBillingSessionAction(
  row: BillingSessionActionV1,
  expectedVersion: bigint,
  next: BillingSessionActionState,
  evidence: Readonly<{ callsId?: Hex; transactionHash?: Hex; proofHash?: Hex }>,
  now: number,
): BillingSessionActionV1 {
  validateBillingSessionAction(row);
  if (row.version !== expectedVersion || !ACTION_TRANSITIONS[row.state].includes(next)) {
    throw new Error("Session action CAS transition refused.");
  }
  for (const field of ["callsId", "transactionHash", "proofHash"] as const) {
    if (row[field] !== undefined && evidence[field] !== undefined && row[field] !== evidence[field]) {
      throw new Error(`Session action ${field} is immutable.`);
    }
  }
  const updated = {
    ...row,
    state: next,
    ...evidence,
    version: row.version + 1n,
    updatedAt: second(now, "Action update"),
  } satisfies BillingSessionActionV1;
  validateBillingSessionAction(updated);
  return updated;
}

export type BillingSessionOwnerParamsV1 = Readonly<{
  domain: "4lpha.billing-session-owner-action.v1";
  action: "grant" | "revoke";
  accountId: string;
  wallet: string;
  oldGeneration: string;
  newGeneration: string;
  kmsPublicKey: Hex;
  keyId: Hex;
  sessionFactsHash: Hex;
  chainId: 56;
  keyStore: "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a";
  collector: string;
  dayCapWei: string;
  expiry: number;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}>;

export function canonicalBillingSessionOwnerParams(input: Readonly<{
  action: "grant" | "revoke";
  accountId: string;
  wallet: string;
  oldGeneration: bigint;
  newGeneration: bigint;
  kmsPublicKey: Hex;
  keyId: Hex;
  sessionFactsHash: Hex;
  collector: string;
  dayCapWei: bigint;
  expiry: number;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}>): Readonly<{ params: BillingSessionOwnerParamsV1; canonical: string; paramsHash: Hex }> {
  if (!isAddress(input.wallet, { strict: false }) || !isAddress(input.collector, { strict: false })) throw new Error("Owner session action address is malformed.");
  if (input.accountId.length < 1 || input.accountId.length > 256 ||
      !/^0x04[0-9a-f]{128}$/u.test(input.kmsPublicKey) || keccak256(input.kmsPublicKey) !== input.keyId ||
      input.oldGeneration < 0n || input.newGeneration < 1n || input.newGeneration <= input.oldGeneration ||
      (input.action === "revoke" && input.oldGeneration === 0n) || input.dayCapWei < 1n || input.expiry < 1) {
    throw new Error("Owner session action identity or policy is malformed.");
  }
  if (input.expiresAt > input.issuedAt + 300 || input.expiresAt <= input.issuedAt) throw new Error("Owner session action window is invalid.");
  hash(input.keyId, "key ID"); hash(input.sessionFactsHash, "facts hash"); hash(input.nonce, "nonce");
  const params: BillingSessionOwnerParamsV1 = Object.freeze({
    domain: "4lpha.billing-session-owner-action.v1",
    action: input.action,
    accountId: input.accountId,
    wallet: getAddress(input.wallet).toLowerCase(),
    oldGeneration: input.oldGeneration.toString(10),
    newGeneration: input.newGeneration.toString(10),
    kmsPublicKey: input.kmsPublicKey,
    keyId: input.keyId,
    sessionFactsHash: input.sessionFactsHash,
    chainId: 56,
    keyStore: "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a",
    collector: getAddress(input.collector).toLowerCase(),
    dayCapWei: input.dayCapWei.toString(10),
    expiry: input.expiry,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
  const canonical = JSON.stringify(params);
  if (Buffer.byteLength(canonical, "utf8") > 4_096) throw new Error("Owner session action exceeds 4 KiB.");
  return {
    params,
    canonical,
    paramsHash: ownerActionParamsHash(
      input.action === "grant" ? "billingSessionGrant" : "billingSessionRevoke",
      params,
    ),
  };
}

export function parseBillingSessionOwnerParamsBytes(bytes: string): BillingSessionOwnerParamsV1 {
  if (Buffer.byteLength(bytes, "utf8") > 4_096 || bytes.startsWith("\uFEFF")) {
    throw new Error("Owner session action bytes exceed the canonical envelope.");
  }
  let value: unknown;
  try { value = JSON.parse(bytes) as unknown; } catch { throw new Error("Owner session action bytes are invalid JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Owner session action bytes must contain one object.");
  }
  const record = value as Record<string, unknown>;
  const expected = ["domain", "action", "accountId", "wallet", "oldGeneration", "newGeneration", "kmsPublicKey",
    "keyId", "sessionFactsHash", "chainId", "keyStore", "collector", "dayCapWei", "expiry", "nonce", "issuedAt", "expiresAt"];
  if (Object.keys(record).some((key, index) => key !== expected[index]) || Object.keys(record).length !== expected.length ||
      record["domain"] !== "4lpha.billing-session-owner-action.v1" ||
      (record["action"] !== "grant" && record["action"] !== "revoke") || typeof record["accountId"] !== "string" ||
      typeof record["wallet"] !== "string" || typeof record["oldGeneration"] !== "string" ||
      typeof record["newGeneration"] !== "string" || typeof record["kmsPublicKey"] !== "string" ||
      typeof record["keyId"] !== "string" || typeof record["sessionFactsHash"] !== "string" || record["chainId"] !== 56 ||
      record["keyStore"] !== "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" || typeof record["collector"] !== "string" ||
      typeof record["dayCapWei"] !== "string" || typeof record["expiry"] !== "number" || typeof record["nonce"] !== "string" ||
      typeof record["issuedAt"] !== "number" || typeof record["expiresAt"] !== "number") {
    throw new Error("Owner session action fields are not exact.");
  }
  let rebuilt: ReturnType<typeof canonicalBillingSessionOwnerParams>;
  try {
    rebuilt = canonicalBillingSessionOwnerParams({
      action: record["action"], accountId: record["accountId"], wallet: record["wallet"],
      oldGeneration: BigInt(record["oldGeneration"]), newGeneration: BigInt(record["newGeneration"]),
      kmsPublicKey: record["kmsPublicKey"] as Hex, keyId: record["keyId"] as Hex,
      sessionFactsHash: record["sessionFactsHash"] as Hex, collector: record["collector"],
      dayCapWei: BigInt(record["dayCapWei"]), expiry: record["expiry"], nonce: record["nonce"] as Hex,
      issuedAt: record["issuedAt"], expiresAt: record["expiresAt"],
    });
  } catch { throw new Error("Owner session action fields are malformed."); }
  if (rebuilt.canonical !== bytes) throw new Error("Owner session action bytes are not canonical.");
  return rebuilt.params;
}

export type BillingSessionAccountProjectionV1 = Readonly<{
  accountId: string;
  walletAddress: Address;
  status: "active" | "paused";
  currentGeneration: bigint | null;
  version: bigint;
}>;

function assertBillingSessionActionPolicy(
  account: BillingSessionAccountProjectionV1,
  generations: readonly BillingSessionGenerationV1[],
  action: BillingSessionActionV1,
): void {
  const params = parseBillingSessionOwnerParamsBytes(action.ownerParamsBytes);
  const target = generations.find((row) => row.accountId === action.accountId && row.generation === action.targetGeneration);
  if (target === undefined) throw new Error("Session action target generation is missing.");
  const facts = canonicalBillingSessionFacts(target);
  const expectedOld = action.kind === "grant" ? account.currentGeneration ?? 0n : action.targetGeneration;
  if (canonicalAddress(params.wallet, "Owner session wallet") !== canonicalAddress(account.walletAddress, "Billing account wallet") ||
      BigInt(params.oldGeneration) !== expectedOld || BigInt(params.newGeneration) !== action.generation ||
      params.kmsPublicKey !== target.publicKey || params.keyId !== keccak256(target.publicKey) ||
      params.sessionFactsHash !== target.sessionFactsHash ||
      canonicalAddress(params.collector, "Owner session collector") !== facts.collector ||
      BigInt(params.dayCapWei) !== facts.dayCapWei || params.expiry !== facts.expiry) {
    throw new Error("Session owner policy differs from canonical generation facts.");
  }
}

export type BillingSessionChainObservationV1 = Readonly<{
  chainId: number;
  receiptStatus: "success" | "failed";
  action: "grant" | "revoke";
  wallet: Address;
  keyStore: Address;
  keyId: Hex;
  callsId: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  latestBlockNumber: bigint;
  stateBlockNumber: bigint;
  keyStoreValid: boolean;
  accountKeyAbsent: boolean;
  canPayCollector?: boolean;
  dayLimitWei?: bigint;
  currentSpentWei?: bigint;
}>;

export type BillingSessionGrantProofV1 = Readonly<{
  schema: "4lpha.billing-session-grant-proof.v1";
  actionId: Hex;
  callsId: Hex;
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  keyStoreValid: true;
  accountKeyAbsent: true;
  canPayCollector: true;
  dayLimitWei: string;
  currentSpentWei: string;
}>;

export type BillingSessionRevokeProofV1 = Readonly<{
  schema: "4lpha.billing-session-revoke-proof.v1";
  actionId: Hex;
  callsId: Hex;
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  keyStoreValid: false;
  accountKeyAbsent: true;
}>;

export type FinalizedBillingSessionProofV1 = BillingSessionGrantProofV1 | BillingSessionRevokeProofV1;

export type FinalizedBillingSessionProofResultV1 = Readonly<{
  proof: FinalizedBillingSessionProofV1;
  canonical: string;
  proofHash: Hex;
}>;

const GENERATION_STATES: ReadonlySet<BillingSessionGenerationState> = new Set([
  "prepared", "grant_pending", "active_pending_old_revoke", "active", "retired", "abandoned",
]);
const ACTION_STATES: ReadonlySet<BillingSessionActionState> = new Set([
  "prepared", "owner_refused", "submitted", "unknown", "confirmed", "failed",
]);

function canonicalAddress(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${field} is malformed.`);
  return getAddress(value).toLowerCase() as Address;
}

function equalObservation(
  left: BillingSessionChainObservationV1,
  right: BillingSessionChainObservationV1,
): boolean {
  const comparable = (value: BillingSessionChainObservationV1) => JSON.stringify({
    chainId: value.chainId,
    receiptStatus: value.receiptStatus,
    action: value.action,
    wallet: value.wallet.toLowerCase(),
    keyStore: value.keyStore.toLowerCase(),
    keyId: value.keyId,
    callsId: value.callsId,
    transactionHash: value.transactionHash,
    blockNumber: value.blockNumber.toString(),
    blockHash: value.blockHash,
    stateBlockNumber: value.stateBlockNumber.toString(),
    keyStoreValid: value.keyStoreValid,
    accountKeyAbsent: value.accountKeyAbsent,
    canPayCollector: value.canPayCollector,
    dayLimitWei: value.dayLimitWei?.toString(),
    currentSpentWei: value.currentSpentWei?.toString(),
  });
  return comparable(left) === comparable(right);
}

/** Validate two independently obtained, finalized observations and hash the exact proof bytes. */
export function finalizedBillingSessionProof(input: Readonly<{
  action: BillingSessionActionV1;
  wallet: Address;
  keyStore: Address;
  finalityDepth: number;
  observations: readonly [BillingSessionChainObservationV1, BillingSessionChainObservationV1];
}>): FinalizedBillingSessionProofResultV1 {
  validateBillingSessionAction(input.action);
  if (input.action.state !== "submitted" && input.action.state !== "unknown") {
    throw new Error("Only a contacted session action may receive finalized proof.");
  }
  if (!Number.isSafeInteger(input.finalityDepth) || input.finalityDepth < 1) {
    throw new Error("Session proof finality depth is malformed.");
  }
  const wallet = canonicalAddress(input.wallet, "Session proof wallet");
  const keyStore = canonicalAddress(input.keyStore, "Session proof KeyStore");
  const [first, secondObservation] = input.observations;
  if (!equalObservation(first, secondObservation)) throw new Error("Session proof RPC observations disagree.");
  for (const observation of input.observations) {
    for (const [label, value] of [
      ["key ID", observation.keyId], ["calls ID", observation.callsId],
      ["transaction hash", observation.transactionHash], ["block hash", observation.blockHash],
    ] as const) hash(value, `Session proof ${label}`);
    if (observation.chainId !== 56 || observation.receiptStatus !== "success" ||
        observation.action !== input.action.kind ||
        canonicalAddress(observation.wallet, "Session proof wallet") !== wallet ||
        canonicalAddress(observation.keyStore, "Session proof KeyStore") !== keyStore ||
        observation.keyId !== input.action.targetKeyId || observation.callsId !== input.action.callsId ||
        observation.blockNumber < 0n || observation.stateBlockNumber !== observation.blockNumber ||
        observation.latestBlockNumber < observation.blockNumber + BigInt(input.finalityDepth)) {
      throw new Error("Session proof does not bind the finalized owner action.");
    }
    if (input.action.transactionHash !== undefined && observation.transactionHash !== input.action.transactionHash) {
      throw new Error("Session proof transaction hash disagrees with the action row.");
    }
  }
  let proof: FinalizedBillingSessionProofV1;
  if (input.action.kind === "grant") {
    const ownerDayCapWei = BigInt(parseBillingSessionOwnerParamsBytes(input.action.ownerParamsBytes).dayCapWei);
    if (first.keyStoreValid !== true || first.accountKeyAbsent !== true || first.canPayCollector !== true ||
        first.dayLimitWei === undefined || first.currentSpentWei === undefined ||
        first.dayLimitWei !== ownerDayCapWei || first.currentSpentWei < 0n || first.currentSpentWei > first.dayLimitWei) {
      throw new Error("Finalized grant proof does not establish the exact billing permission.");
    }
    proof = {
      schema: "4lpha.billing-session-grant-proof.v1",
      actionId: input.action.actionId,
      callsId: first.callsId,
      transactionHash: first.transactionHash,
      blockNumber: first.blockNumber.toString(10),
      blockHash: first.blockHash,
      keyStoreValid: true,
      accountKeyAbsent: true,
      canPayCollector: true,
      dayLimitWei: first.dayLimitWei.toString(10),
      currentSpentWei: first.currentSpentWei.toString(10),
    };
  } else {
    if (first.keyStoreValid !== false || first.accountKeyAbsent !== true ||
        first.canPayCollector !== undefined || first.dayLimitWei !== undefined || first.currentSpentWei !== undefined) {
      throw new Error("Finalized revoke proof does not establish removal of billing authority.");
    }
    proof = {
      schema: "4lpha.billing-session-revoke-proof.v1",
      actionId: input.action.actionId,
      callsId: first.callsId,
      transactionHash: first.transactionHash,
      blockNumber: first.blockNumber.toString(10),
      blockHash: first.blockHash,
      keyStoreValid: false,
      accountKeyAbsent: true,
    };
  }
  const canonical = JSON.stringify(proof);
  return { proof, canonical, proofHash: keccak256(stringToBytes(canonical)) };
}

export type BillingSessionSagaSnapshotV1 = Readonly<{
  account: BillingSessionAccountProjectionV1;
  generations: readonly BillingSessionGenerationV1[];
  actions: readonly BillingSessionActionV1[];
}>;

function nextGenerationState(
  row: BillingSessionGenerationV1,
  state: BillingSessionGenerationState,
  now: number,
): BillingSessionGenerationV1 {
  const next = { ...row, state, version: row.version + 1n, updatedAt: second(now, "Session update") };
  validateBillingSessionGeneration(next);
  return next;
}

const GENERATION_TRANSITIONS: Readonly<Record<BillingSessionGenerationState, readonly BillingSessionGenerationState[]>> = {
  prepared: ["grant_pending", "abandoned"],
  grant_pending: ["active", "active_pending_old_revoke"],
  active_pending_old_revoke: ["active"],
  active: ["retired"],
  retired: [],
  abandoned: [],
};

export function transitionBillingSessionGeneration(
  row: BillingSessionGenerationV1,
  expectedVersion: bigint,
  next: BillingSessionGenerationState,
  now: number,
): BillingSessionGenerationV1 {
  validateBillingSessionGeneration(row);
  if (row.version !== expectedVersion || !GENERATION_TRANSITIONS[row.state].includes(next)) {
    throw new Error("Session generation CAS transition refused.");
  }
  return nextGenerationState(row, next, now);
}

/** Apply a proven success to an immutable snapshot; callers persist the returned rows atomically by CAS. */
export function reconcileFinalizedBillingSessionAction(input: Readonly<{
  snapshot: BillingSessionSagaSnapshotV1;
  actionId: Hex;
  proof: FinalizedBillingSessionProofResultV1;
  now: number;
}>): BillingSessionSagaSnapshotV1 {
  const action = input.snapshot.actions.find((row) => row.actionId === input.actionId);
  if (action === undefined || input.snapshot.account.accountId !== action.accountId ||
      input.snapshot.generations.some((row) => row.accountId !== action.accountId) ||
      input.snapshot.actions.some((row) => row.accountId !== action.accountId) ||
      input.proof.proof.actionId !== action.actionId ||
      input.proof.proof.callsId !== action.callsId || input.proof.proofHash !== keccak256(stringToBytes(input.proof.canonical)) ||
      JSON.stringify(input.proof.proof) !== input.proof.canonical) {
    throw new Error("Session proof does not match the action snapshot.");
  }
  if (input.proof.proof.transactionHash !== input.proof.proof.transactionHash.toLowerCase()) {
    throw new Error("Session proof is not canonical lowercase hex.");
  }
  const confirmed = transitionBillingSessionAction(action, action.version, "confirmed", {
    transactionHash: input.proof.proof.transactionHash,
    proofHash: input.proof.proofHash,
  }, input.now);
  const generations = [...input.snapshot.generations];
  let account = input.snapshot.account;
  if (action.kind === "grant") {
    if (input.proof.proof.schema !== "4lpha.billing-session-grant-proof.v1") throw new Error("Grant action requires grant proof.");
    const targetIndex = generations.findIndex((row) => row.generation === action.targetGeneration);
    const target = generations[targetIndex];
    if (target === undefined || target.accountId !== action.accountId || target.state !== "grant_pending") {
      throw new Error("Grant target generation is not pending.");
    }
    const oldActive = generations.filter((row) => row.accountId === action.accountId && row.state === "active" && row.generation !== target.generation);
    if (oldActive.length > 1) throw new Error("Session snapshot has multiple active generations.");
    if ((oldActive.length === 0 && account.currentGeneration !== null) ||
        (oldActive.length === 1 && (account.status !== "paused" || account.currentGeneration !== oldActive[0]?.generation))) {
      throw new Error("Session account projection does not match the grant lifecycle.");
    }
    generations[targetIndex] = nextGenerationState(target, oldActive.length === 0 ? "active" : "active_pending_old_revoke", input.now);
    account = {
      ...account,
      status: oldActive.length === 0 ? "active" : "paused",
      currentGeneration: oldActive.length === 0 ? target.generation : oldActive[0]?.generation ?? null,
      version: account.version + 1n,
    };
  } else {
    if (input.proof.proof.schema !== "4lpha.billing-session-revoke-proof.v1") throw new Error("Revoke action requires revoke proof.");
    const newIndex = generations.findIndex((row) => row.generation === action.generation);
    const oldIndex = generations.findIndex((row) => row.generation === action.targetGeneration);
    const replacement = generations[newIndex];
    const old = generations[oldIndex];
    if (replacement === undefined || old === undefined || replacement.accountId !== action.accountId || old.accountId !== action.accountId ||
        replacement.state !== "active_pending_old_revoke" || old.state !== "active" ||
        account.status !== "paused" || account.currentGeneration !== old.generation) {
      throw new Error("Replacement revoke snapshot is not ready for promotion.");
    }
    generations[oldIndex] = nextGenerationState(old, "retired", input.now);
    generations[newIndex] = nextGenerationState(replacement, "active", input.now);
    account = { ...account, status: "active", currentGeneration: replacement.generation, version: account.version + 1n };
  }
  return {
    account,
    generations,
    actions: input.snapshot.actions.map((row) => row.actionId === action.actionId ? confirmed : row),
  };
}

export interface BillingSessionGenerationRepository {
  snapshot(accountId: string): Promise<BillingSessionSagaSnapshotV1 | null>;
  pauseForReplacement(accountId: string, expectedVersion: bigint): Promise<BillingSessionAccountProjectionV1>;
  insertGeneration(row: BillingSessionGenerationV1): Promise<BillingSessionGenerationV1>;
  insertAction(row: BillingSessionActionV1): Promise<BillingSessionActionV1>;
  acceptPreparedAction(actionId: Hex, expectedActionVersion: bigint, expectedGenerationVersion: bigint,
    callsId: Hex, now: number): Promise<Readonly<{ action: BillingSessionActionV1; generation: BillingSessionGenerationV1 }>>;
  refusePreparedAction(actionId: Hex, expectedActionVersion: bigint, expectedGenerationVersion: bigint,
    now: number): Promise<Readonly<{ action: BillingSessionActionV1; generation: BillingSessionGenerationV1 }>>;
  transitionAction(actionId: Hex, expectedVersion: bigint, next: BillingSessionActionState,
    evidence: Readonly<{ callsId?: Hex; transactionHash?: Hex; proofHash?: Hex }>, now: number): Promise<BillingSessionActionV1>;
  finalizeAction(input: Readonly<{
    actionId: Hex;
    expectedActionVersion: bigint;
    expectedAccountVersion: bigint;
    expectedGenerationVersions: Readonly<Record<string, bigint>>;
    wallet: Address;
    keyStore: Address;
    finalityDepth: number;
    observations: readonly [BillingSessionChainObservationV1, BillingSessionChainObservationV1];
    now: number;
  }>): Promise<BillingSessionSagaSnapshotV1>;
}

function sameRow(left: unknown, right: unknown): boolean {
  const encode = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
  return encode(left) === encode(right);
}

/** Deterministic repository used by offline tests; every mutation is synchronous before its Promise resolves. */
export class MemoryBillingSessionGenerationRepository implements BillingSessionGenerationRepository {
  readonly #accounts = new Map<string, BillingSessionAccountProjectionV1>();
  readonly #generations = new Map<string, BillingSessionGenerationV1>();
  readonly #actions = new Map<Hex, BillingSessionActionV1>();

  constructor(accounts: readonly BillingSessionAccountProjectionV1[]) {
    for (const account of accounts) {
      if (this.#accounts.has(account.accountId) || account.version < 1n ||
          !isAddress(account.walletAddress, { strict: false })) throw new Error("Duplicate or malformed session account projection.");
      this.#accounts.set(account.accountId, structuredClone(account));
    }
  }

  #generationKey(accountId: string, generation: bigint): string { return `${accountId}|${generation.toString()}`; }

  async snapshot(accountId: string): Promise<BillingSessionSagaSnapshotV1 | null> {
    const account = this.#accounts.get(accountId);
    if (account === undefined) return null;
    return structuredClone({
      account,
      generations: [...this.#generations.values()].filter((row) => row.accountId === accountId),
      actions: [...this.#actions.values()].filter((row) => row.accountId === accountId),
    });
  }

  async pauseForReplacement(accountId: string, expectedVersion: bigint): Promise<BillingSessionAccountProjectionV1> {
    const account = this.#accounts.get(accountId);
    if (account === undefined || account.version !== expectedVersion || account.status !== "active" || account.currentGeneration === null) {
      throw new Error("Session account replacement-pause CAS refused.");
    }
    const paused = { ...account, status: "paused" as const, version: account.version + 1n };
    this.#accounts.set(accountId, structuredClone(paused));
    return structuredClone(paused);
  }

  async insertGeneration(row: BillingSessionGenerationV1): Promise<BillingSessionGenerationV1> {
    validateBillingSessionGeneration(row);
    if (row.state !== "prepared" || !GENERATION_STATES.has(row.state) || !this.#accounts.has(row.accountId)) {
      throw new Error("New session generation is not a prepared row for a known account.");
    }
    const key = this.#generationKey(row.accountId, row.generation);
    const existing = this.#generations.get(key);
    if (existing !== undefined) {
      if (!sameRow(existing, row)) throw new Error("Session generation identity conflict.");
      return structuredClone(existing);
    }
    const rows = [...this.#generations.values()];
    if (rows.some((entry) => entry.kmsKeyArn === row.kmsKeyArn) ||
        rows.some((entry) => entry.accountId === row.accountId && entry.generation >= row.generation)) {
      throw new Error("Session generation KMS identity or monotonicity conflict.");
    }
    this.#generations.set(key, structuredClone(row));
    return structuredClone(row);
  }

  async insertAction(row: BillingSessionActionV1): Promise<BillingSessionActionV1> {
    validateBillingSessionAction(row);
    const owningGeneration = this.#generations.get(this.#generationKey(row.accountId, row.generation));
    const targetGeneration = this.#generations.get(this.#generationKey(row.accountId, row.targetGeneration));
    if (row.state !== "prepared" || !ACTION_STATES.has(row.state) || owningGeneration === undefined ||
        targetGeneration === undefined || keccak256(targetGeneration.publicKey) !== row.targetKeyId) {
      throw new Error("New session action is not prepared or has no generation.");
    }
    const account = this.#accounts.get(row.accountId);
    if (account === undefined) throw new Error("Session action account is missing.");
    assertBillingSessionActionPolicy(account, [...this.#generations.values()], row);
    const existing = this.#actions.get(row.actionId);
    if (existing !== undefined) {
      if (!sameRow(existing, row)) throw new Error("Session action identity conflict.");
      return structuredClone(existing);
    }
    const rows = [...this.#actions.values()];
    if (rows.some((entry) => entry.nonce === row.nonce || entry.ownerActionIdempotencyKey === row.ownerActionIdempotencyKey ||
        (row.callsId !== undefined && entry.callsId === row.callsId) ||
        (row.transactionHash !== undefined && entry.transactionHash === row.transactionHash))) {
      throw new Error("Session action unique identity conflict.");
    }
    this.#actions.set(row.actionId, structuredClone(row));
    return structuredClone(row);
  }

  async transitionAction(actionId: Hex, expectedVersion: bigint, next: BillingSessionActionState,
    evidence: Readonly<{ callsId?: Hex; transactionHash?: Hex; proofHash?: Hex }>, now: number): Promise<BillingSessionActionV1> {
    const row = this.#actions.get(actionId);
    if (row === undefined) throw new Error("Session action not found.");
    if (row.state === "prepared") throw new Error("Prepared session actions require the atomic accept/refuse CAS.");
    const updated = transitionBillingSessionAction(row, expectedVersion, next, evidence, now);
    for (const other of this.#actions.values()) {
      if (other.actionId !== actionId && ((updated.callsId !== undefined && other.callsId === updated.callsId) ||
          (updated.transactionHash !== undefined && other.transactionHash === updated.transactionHash))) {
        throw new Error("Session action chain identity conflict.");
      }
    }
    this.#actions.set(actionId, structuredClone(updated));
    return structuredClone(updated);
  }

  async acceptPreparedAction(
    actionId: Hex,
    expectedActionVersion: bigint,
    expectedGenerationVersion: bigint,
    callsId: Hex,
    now: number,
  ): Promise<Readonly<{ action: BillingSessionActionV1; generation: BillingSessionGenerationV1 }>> {
    const row = this.#actions.get(actionId);
    if (row === undefined || row.state !== "prepared") throw new Error("Prepared session action not found.");
    const generationKey = this.#generationKey(row.accountId, row.generation);
    const generation = this.#generations.get(generationKey);
    if (generation === undefined || generation.version !== expectedGenerationVersion) {
      throw new Error("Session generation accept CAS refused.");
    }
    for (const other of this.#actions.values()) {
      if (other.actionId !== actionId && other.callsId === callsId) throw new Error("Session action calls ID conflict.");
    }
    if (row.kind === "grant" && [...this.#generations.values()].some((other) =>
      other.accountId === row.accountId && other.generation !== generation.generation &&
      (other.state === "grant_pending" || other.state === "active_pending_old_revoke"))) {
      throw new Error("Session account already has a pending generation.");
    }
    const accepted = transitionBillingSessionAction(row, expectedActionVersion, "submitted", { callsId }, now);
    const pending = row.kind === "grant"
      ? transitionBillingSessionGeneration(generation, expectedGenerationVersion, "grant_pending", now)
      : generation;
    if (row.kind === "revoke" && generation.state !== "active_pending_old_revoke") {
      throw new Error("Replacement revoke generation is not awaiting old-key removal.");
    }
    this.#actions.set(actionId, structuredClone(accepted));
    this.#generations.set(generationKey, structuredClone(pending));
    return structuredClone({ action: accepted, generation: pending });
  }

  async refusePreparedAction(
    actionId: Hex,
    expectedActionVersion: bigint,
    expectedGenerationVersion: bigint,
    now: number,
  ): Promise<Readonly<{ action: BillingSessionActionV1; generation: BillingSessionGenerationV1 }>> {
    const row = this.#actions.get(actionId);
    if (row === undefined || row.state !== "prepared") throw new Error("Prepared session action not found.");
    const generationKey = this.#generationKey(row.accountId, row.generation);
    const generation = this.#generations.get(generationKey);
    if (generation === undefined || generation.version !== expectedGenerationVersion) {
      throw new Error("Session generation refusal CAS refused.");
    }
    const refused = transitionBillingSessionAction(row, expectedActionVersion, "owner_refused", {}, now);
    const abandoned = row.kind === "grant"
      ? transitionBillingSessionGeneration(generation, expectedGenerationVersion, "abandoned", now)
      : generation;
    this.#actions.set(actionId, structuredClone(refused));
    this.#generations.set(generationKey, structuredClone(abandoned));
    return structuredClone({ action: refused, generation: abandoned });
  }

  async finalizeAction(input: Readonly<{
    actionId: Hex; expectedActionVersion: bigint; expectedAccountVersion: bigint;
    expectedGenerationVersions: Readonly<Record<string, bigint>>; wallet: Address; keyStore: Address;
    finalityDepth: number; observations: readonly [BillingSessionChainObservationV1, BillingSessionChainObservationV1]; now: number;
  }>): Promise<BillingSessionSagaSnapshotV1> {
    const action = this.#actions.get(input.actionId);
    if (action === undefined || action.version !== input.expectedActionVersion) throw new Error("Session action finalize CAS refused.");
    const snapshot = await this.snapshot(action.accountId);
    if (snapshot === null || snapshot.account.version !== input.expectedAccountVersion) throw new Error("Session account finalize CAS refused.");
    assertBillingSessionActionPolicy(snapshot.account, snapshot.generations, action);
    for (const generation of snapshot.generations) {
      if (input.expectedGenerationVersions[generation.generation.toString()] !== generation.version) {
        throw new Error("Session generation finalize CAS refused.");
      }
    }
    if (Object.keys(input.expectedGenerationVersions).length !== snapshot.generations.length) {
      throw new Error("Session generation finalize CAS set is incomplete.");
    }
    const proof = finalizedBillingSessionProof({
      action, wallet: input.wallet, keyStore: input.keyStore,
      finalityDepth: input.finalityDepth, observations: input.observations,
    });
    const reconciled = reconcileFinalizedBillingSessionAction({ snapshot, actionId: action.actionId, proof, now: input.now });
    this.#accounts.set(action.accountId, structuredClone(reconciled.account));
    for (const generation of reconciled.generations) {
      this.#generations.set(this.#generationKey(generation.accountId, generation.generation), structuredClone(generation));
    }
    for (const updatedAction of reconciled.actions) this.#actions.set(updatedAction.actionId, structuredClone(updatedAction));
    return structuredClone(reconciled);
  }
}

type GenerationSqlRow = Readonly<{
  account_id: string;
  generation: string | number;
  kms_key_arn: string;
  public_key: Hex;
  session_facts_bytes: string;
  session_facts_hash: Hex;
  expires_at: string | number;
  state: BillingSessionGenerationState;
  version: string | number;
  created_at: string | number;
  updated_at: string | number;
}>;

type ActionSqlRow = Readonly<{
  action_id: Hex;
  account_id: string;
  generation: string | number;
  kind: "grant" | "revoke";
  target_generation: string | number;
  target_key_id: Hex;
  nonce: Hex;
  owner_action_idempotency_key: Hex;
  owner_params_bytes: string;
  owner_params_hash: Hex;
  state: BillingSessionActionState;
  calls_id: Hex | null;
  transaction_hash: Hex | null;
  proof_hash: Hex | null;
  version: string | number;
  created_at: string | number;
  updated_at: string | number;
}>;

type LoadedPostgresSaga = Readonly<{
  billingSnapshot: BillingStoreSnapshot;
  billingAccount: BillingAccount;
  saga: BillingSessionSagaSnapshotV1;
}>;

export type BillingSessionOnCensusEntryV1 = Readonly<{
  account: BillingAccount;
  generations: readonly BillingSessionGenerationV1[];
  actions: readonly BillingSessionActionV1[];
}>;

const GENERATION_COLUMNS =
  "account_id,generation,kms_key_arn,public_key,session_facts_bytes,session_facts_hash,expires_at,state,version,created_at,updated_at";
const ACTION_COLUMNS =
  "action_id,account_id,generation,kind,target_generation,target_key_id,nonce,owner_action_idempotency_key,owner_params_bytes,owner_params_hash,state,calls_id,transaction_hash,proof_hash,version,created_at,updated_at";

function safeInteger(value: string | number, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${field} is outside the safe integer range.`);
  return number;
}

function generationFromSql(row: GenerationSqlRow): BillingSessionGenerationV1 {
  const generation: BillingSessionGenerationV1 = {
    accountId: row.account_id,
    generation: BigInt(row.generation),
    kmsKeyArn: row.kms_key_arn,
    publicKey: row.public_key,
    sessionFactsBytes: row.session_facts_bytes,
    sessionFactsHash: row.session_facts_hash,
    expiresAt: safeInteger(row.expires_at, "Session expiry"),
    state: row.state,
    version: BigInt(row.version),
    createdAt: safeInteger(row.created_at, "Session creation"),
    updatedAt: safeInteger(row.updated_at, "Session update"),
  };
  validateBillingSessionGeneration(generation);
  return generation;
}

function actionFromSql(row: ActionSqlRow): BillingSessionActionV1 {
  const action: BillingSessionActionV1 = {
    actionId: row.action_id,
    accountId: row.account_id,
    generation: BigInt(row.generation),
    kind: row.kind,
    targetGeneration: BigInt(row.target_generation),
    targetKeyId: row.target_key_id,
    nonce: row.nonce,
    ownerActionIdempotencyKey: row.owner_action_idempotency_key,
    ownerParamsBytes: row.owner_params_bytes,
    ownerParamsHash: row.owner_params_hash,
    state: row.state,
    ...(row.calls_id === null ? {} : { callsId: row.calls_id }),
    ...(row.transaction_hash === null ? {} : { transactionHash: row.transaction_hash }),
    ...(row.proof_hash === null ? {} : { proofHash: row.proof_hash }),
    version: BigInt(row.version),
    createdAt: safeInteger(row.created_at, "Action creation"),
    updatedAt: safeInteger(row.updated_at, "Action update"),
  };
  validateBillingSessionAction(action);
  return action;
}

function kmsAccountProjection(account: BillingAccount): BillingSessionAccountProjectionV1 {
  if (billingAccountCustodyKind(account) !== "kms" || account.sessionStateVersion === undefined) {
    throw new Error("Billing session repository refuses legacy custody.");
  }
  if (account.status !== "active" && account.status !== "paused") {
    throw new Error("Billing session account is not in a mutable lifecycle state.");
  }
  return {
    accountId: account.accountId,
    walletAddress: canonicalAddress(account.walletAddress, "Billing account wallet"),
    status: account.status,
    currentGeneration: account.sessionGeneration ?? null,
    version: account.sessionStateVersion,
  };
}

function replaceBillingAccount(
  snapshot: BillingStoreSnapshot,
  account: BillingAccount,
): BillingStoreSnapshot {
  return {
    ...snapshot,
    accounts: snapshot.accounts.map(([accountId, current]) =>
      accountId === account.accountId ? [accountId, account] as const : [accountId, current] as const),
  };
}

/** Durable PostgreSQL repository. Every lifecycle mutation locks the canonical billing snapshot and both saga tables. */
export class PostgresBillingSessionGenerationRepository implements BillingSessionGenerationRepository {
  readonly #sql: SqlClient;

  private constructor(sql: SqlClient) { this.#sql = sql; }

  static async create(sql: SqlClient): Promise<PostgresBillingSessionGenerationRepository> {
    await sql.query(BILLING_SESSION_GENERATIONS_DDL);
    return new PostgresBillingSessionGenerationRepository(sql);
  }

  static attach(sql: SqlClient): PostgresBillingSessionGenerationRepository {
    return new PostgresBillingSessionGenerationRepository(sql);
  }

  async #censusSnapshot(tx: SqlClient, snapshot: BillingStoreSnapshot): Promise<readonly BillingSessionOnCensusEntryV1[]> {
    const selected = snapshot.accounts.map(([, account]) => account).filter((account) =>
      account.status === "active" || account.status === "paused" || account.status === "closing");
    const out: BillingSessionOnCensusEntryV1[] = [];
    for (const account of selected) {
      if (billingAccountCustodyKind(account) !== "kms") throw new Error("ON billing census refuses legacy or dual custody.");
      const generationRows = await tx.query<GenerationSqlRow>(
        `/* billing.session.censusGenerations */ select ${GENERATION_COLUMNS}
         from phase5_billing_session_generations where account_id=$1 order by generation`,
        [account.accountId],
      );
      const actionRows = await tx.query<ActionSqlRow>(
        `/* billing.session.censusActions */ select ${ACTION_COLUMNS}
         from phase5_billing_session_actions where account_id=$1 order by created_at,action_id`,
        [account.accountId],
      );
      const generations = generationRows.rows.map(generationFromSql);
      const actions = actionRows.rows.map(actionFromSql);
      const active = generations.filter((row) => row.state === "active");
      const pending = generations.filter((row) => row.state === "grant_pending" || row.state === "active_pending_old_revoke");
      if (active.length > 1 || pending.length > 1) throw new Error("ON billing census found non-unique session states.");
      if (account.sessionGeneration === null || account.sessionGeneration === undefined) {
        if (account.status !== "paused" || active.length !== 0 || account.sessionKmsKeyArn !== null || account.sessionPublicKey !== null) {
          throw new Error("ON billing census found an invalid empty KMS projection.");
        }
      } else {
        const current = active.find((row) => row.generation === account.sessionGeneration);
        if (current === undefined || current.kmsKeyArn !== account.sessionKmsKeyArn ||
            current.publicKey !== account.sessionPublicKey || current.sessionFactsBytes !== account.sessionFactsBytes ||
            current.expiresAt !== account.grantExpiresAt) {
          throw new Error("ON billing census current generation disagrees with durable history.");
        }
      }
      out.push({ account, generations, actions });
    }
    return out;
  }

  async #load(tx: SqlClient, accountId: string): Promise<LoadedPostgresSaga | null> {
    const state = await tx.query<{ payload: unknown }>(
      `/* billing.session.stateLock */ select payload from phase5_billing_state where singleton=true for update`,
    );
    const payload = state.rows[0]?.payload;
    if (payload === undefined) throw new Error("Billing state row is missing.");
    const billingSnapshot = decodeJsonb(payload) as BillingStoreSnapshot;
    const billingAccount = billingSnapshot.accounts.find(([id]) => id === accountId)?.[1];
    if (billingAccount === undefined) return null;
    const account = kmsAccountProjection(billingAccount);
    const [generationRows, actionRows] = await Promise.all([
      tx.query<GenerationSqlRow>(
        `/* billing.session.generationsLock */ select ${GENERATION_COLUMNS}
         from phase5_billing_session_generations where account_id=$1 order by generation for update`,
        [accountId],
      ),
      tx.query<ActionSqlRow>(
        `/* billing.session.actionsLock */ select ${ACTION_COLUMNS}
         from phase5_billing_session_actions where account_id=$1 order by created_at,action_id for update`,
        [accountId],
      ),
    ]);
    return {
      billingSnapshot,
      billingAccount,
      saga: {
        account,
        generations: generationRows.rows.map(generationFromSql),
        actions: actionRows.rows.map(actionFromSql),
      },
    };
  }

  async #actionAccountId(tx: SqlClient, actionId: Hex): Promise<string> {
    const result = await tx.query<{ account_id: string }>(
      `/* billing.session.actionAccount */ select account_id from phase5_billing_session_actions where action_id=$1`,
      [actionId],
    );
    const accountId = result.rows[0]?.account_id;
    if (accountId === undefined) throw new Error("Session action not found.");
    return accountId;
  }

  async #writeGeneration(
    tx: SqlClient,
    previous: BillingSessionGenerationV1,
    next: BillingSessionGenerationV1,
  ): Promise<void> {
    if (sameRow(previous, next)) return;
    const result = await tx.query<{ generation: string | number }>(
      `/* billing.session.generationCas */ update phase5_billing_session_generations
       set state=$4,version=$5,updated_at=$6 where account_id=$1 and generation=$2 and version=$3
       returning generation`,
      [next.accountId, next.generation.toString(), previous.version.toString(), next.state, next.version.toString(), next.updatedAt],
    );
    if (result.rows[0] === undefined) throw new Error("Session generation PostgreSQL CAS refused.");
  }

  async #writeAction(tx: SqlClient, previous: BillingSessionActionV1, next: BillingSessionActionV1): Promise<void> {
    if (sameRow(previous, next)) return;
    const result = await tx.query<{ action_id: string }>(
      `/* billing.session.actionCas */ update phase5_billing_session_actions
       set state=$3,calls_id=$4,transaction_hash=$5,proof_hash=$6,version=$7,updated_at=$8
       where action_id=$1 and version=$2 returning action_id`,
      [next.actionId, previous.version.toString(), next.state, next.callsId ?? null,
        next.transactionHash ?? null, next.proofHash ?? null, next.version.toString(), next.updatedAt],
    );
    if (result.rows[0] === undefined) throw new Error("Session action PostgreSQL CAS refused.");
  }

  async #writeBillingAccount(
    tx: SqlClient,
    loaded: LoadedPostgresSaga,
    projection: BillingSessionAccountProjectionV1,
    generations: readonly BillingSessionGenerationV1[],
    now: number,
  ): Promise<BillingAccount> {
    const current = projection.currentGeneration === null
      ? undefined
      : generations.find((row) => row.generation === projection.currentGeneration);
    if (projection.currentGeneration !== null && (current === undefined || current.state !== "active")) {
      throw new Error("Current BillingSession generation projection is not active.");
    }
    const account: BillingAccount = {
      ...loaded.billingAccount,
      status: projection.status,
      encryptedSessionKey: null,
      sessionKmsKeyArn: current?.kmsKeyArn ?? null,
      sessionGeneration: current?.generation ?? null,
      sessionPublicKey: current?.publicKey ?? null,
      sessionFactsBytes: current?.sessionFactsBytes ?? loaded.billingAccount.sessionFactsBytes,
      grantExpiresAt: current?.expiresAt ?? loaded.billingAccount.grantExpiresAt,
      sessionStateVersion: projection.version,
      updatedAt: second(now, "Billing account session update"),
    };
    billingAccountCustodyKind(account);
    const nextSnapshot = replaceBillingAccount(loaded.billingSnapshot, account);
    const stateWrite = await tx.query<{ singleton: boolean }>(
      `/* billing.session.stateCas */ update phase5_billing_state set payload=$1::jsonb where singleton=true returning singleton`,
      [encodeJsonbParam(nextSnapshot)],
    );
    if (stateWrite.rows[0] === undefined) throw new Error("Billing account snapshot CAS refused.");
    const projectionWrite = await tx.query<{ account_id: string }>(
      `/* billing.session.accountProjectionCas */ update phase5_billing_accounts set
       encrypted_session_key=null,record=$3::jsonb,billing_status=$4,session_kms_key_arn=$5,
       session_generation=$6,session_public_key=$7,session_state_version=$8
       where account_id=$1 and session_state_version=$2 returning account_id`,
      [account.accountId, loaded.billingAccount.sessionStateVersion?.toString() ?? null,
        encodeJsonbParam(account), account.status, account.sessionKmsKeyArn ?? null,
        account.sessionGeneration?.toString() ?? null, account.sessionPublicKey ?? null,
        account.sessionStateVersion?.toString() ?? null],
    );
    if (projectionWrite.rows[0] === undefined) throw new Error("Billing account projection CAS refused.");
    return account;
  }

  async snapshot(accountId: string): Promise<BillingSessionSagaSnapshotV1 | null> {
    return this.#sql.transaction(async (tx) => (await this.#load(tx, accountId))?.saga ?? null);
  }

  async pauseForReplacement(accountId: string, expectedVersion: bigint): Promise<BillingSessionAccountProjectionV1> {
    return this.#sql.transaction(async (tx) => {
      const loaded = await this.#load(tx, accountId);
      if (loaded === null || loaded.saga.account.version !== expectedVersion ||
          loaded.saga.account.status !== "active" || loaded.saga.account.currentGeneration === null) {
        throw new Error("Session account replacement-pause CAS refused.");
      }
      const paused = { ...loaded.saga.account, status: "paused" as const, version: expectedVersion + 1n };
      await this.#writeBillingAccount(tx, loaded, paused, loaded.saga.generations, loaded.billingAccount.updatedAt);
      return paused;
    });
  }

  async insertGeneration(row: BillingSessionGenerationV1): Promise<BillingSessionGenerationV1> {
    return this.#sql.transaction(async (tx) => {
      validateBillingSessionGeneration(row);
      if (row.state !== "prepared") throw new Error("New session generation must be prepared.");
      const loaded = await this.#load(tx, row.accountId);
      if (loaded === null) throw new Error("Session account not found.");
      const existing = loaded.saga.generations.find((entry) => entry.generation === row.generation);
      if (existing !== undefined) {
        if (!sameRow(existing, row)) throw new Error("Session generation identity conflict.");
        return existing;
      }
      if (loaded.saga.generations.some((entry) => entry.generation >= row.generation || entry.kmsKeyArn === row.kmsKeyArn)) {
        throw new Error("Session generation KMS identity or monotonicity conflict.");
      }
      const inserted = await tx.query<GenerationSqlRow>(
        `/* billing.session.generationInsert */ insert into phase5_billing_session_generations
         (${GENERATION_COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning ${GENERATION_COLUMNS}`,
        [row.accountId, row.generation.toString(), row.kmsKeyArn, row.publicKey, row.sessionFactsBytes,
          row.sessionFactsHash, row.expiresAt, row.state, row.version.toString(), row.createdAt, row.updatedAt],
      );
      const persisted = inserted.rows[0];
      if (persisted === undefined) throw new Error("Session generation insert failed.");
      return generationFromSql(persisted);
    });
  }

  async insertAction(row: BillingSessionActionV1): Promise<BillingSessionActionV1> {
    return this.#sql.transaction(async (tx) => {
      validateBillingSessionAction(row);
      if (row.state !== "prepared") throw new Error("New session action must be prepared.");
      const loaded = await this.#load(tx, row.accountId);
      if (loaded === null) throw new Error("Session account not found.");
      const existing = loaded.saga.actions.find((entry) => entry.actionId === row.actionId);
      if (existing !== undefined) {
        if (!sameRow(existing, row)) throw new Error("Session action identity conflict.");
        return existing;
      }
      const ownerGeneration = loaded.saga.generations.find((entry) => entry.generation === row.generation);
      const target = loaded.saga.generations.find((entry) => entry.generation === row.targetGeneration);
      if (ownerGeneration === undefined || target === undefined || keccak256(target.publicKey) !== row.targetKeyId) {
        throw new Error("Session action generation/key identity mismatch.");
      }
      assertBillingSessionActionPolicy(loaded.saga.account, loaded.saga.generations, row);
      const inserted = await tx.query<ActionSqlRow>(
        `/* billing.session.actionInsert */ insert into phase5_billing_session_actions
         (${ACTION_COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         returning ${ACTION_COLUMNS}`,
        [row.actionId, row.accountId, row.generation.toString(), row.kind, row.targetGeneration.toString(),
          row.targetKeyId, row.nonce, row.ownerActionIdempotencyKey, row.ownerParamsBytes, row.ownerParamsHash, row.state,
          row.callsId ?? null, row.transactionHash ?? null, row.proofHash ?? null,
          row.version.toString(), row.createdAt, row.updatedAt],
      );
      const persisted = inserted.rows[0];
      if (persisted === undefined) throw new Error("Session action insert failed.");
      return actionFromSql(persisted);
    });
  }

  async acceptPreparedAction(actionId: Hex, expectedActionVersion: bigint, expectedGenerationVersion: bigint,
    callsId: Hex, now: number): Promise<Readonly<{ action: BillingSessionActionV1; generation: BillingSessionGenerationV1 }>> {
    return this.#preparedDisposition(actionId, expectedActionVersion, expectedGenerationVersion, callsId, now, false);
  }

  async refusePreparedAction(actionId: Hex, expectedActionVersion: bigint, expectedGenerationVersion: bigint,
    now: number): Promise<Readonly<{ action: BillingSessionActionV1; generation: BillingSessionGenerationV1 }>> {
    return this.#preparedDisposition(actionId, expectedActionVersion, expectedGenerationVersion, undefined, now, true);
  }

  async #preparedDisposition(actionId: Hex, expectedActionVersion: bigint, expectedGenerationVersion: bigint,
    callsId: Hex | undefined, now: number, refused: boolean): Promise<Readonly<{ action: BillingSessionActionV1; generation: BillingSessionGenerationV1 }>> {
    return this.#sql.transaction(async (tx) => {
      const accountId = await this.#actionAccountId(tx, actionId);
      const loaded = await this.#load(tx, accountId);
      const action = loaded?.saga.actions.find((row) => row.actionId === actionId);
      const generation = loaded?.saga.generations.find((row) => row.generation === action?.generation);
      if (loaded === null || action === undefined || generation === undefined || action.state !== "prepared" ||
          generation.version !== expectedGenerationVersion) throw new Error("Prepared session action CAS refused.");
      if (!refused && callsId === undefined) throw new Error("Accepted session action requires a calls ID.");
      const nextAction = transitionBillingSessionAction(action, expectedActionVersion,
        refused ? "owner_refused" : "submitted", refused ? {} : { callsId: callsId as Hex }, now);
      let nextGeneration = generation;
      if (action.kind === "grant") {
        nextGeneration = transitionBillingSessionGeneration(generation, expectedGenerationVersion,
          refused ? "abandoned" : "grant_pending", now);
      } else if (generation.state !== "active_pending_old_revoke") {
        throw new Error("Replacement revoke generation is not awaiting old-key removal.");
      }
      await this.#writeGeneration(tx, generation, nextGeneration);
      await this.#writeAction(tx, action, nextAction);
      return { action: nextAction, generation: nextGeneration };
    });
  }

  async transitionAction(actionId: Hex, expectedVersion: bigint, next: BillingSessionActionState,
    evidence: Readonly<{ callsId?: Hex; transactionHash?: Hex; proofHash?: Hex }>, now: number): Promise<BillingSessionActionV1> {
    return this.#sql.transaction(async (tx) => {
      const accountId = await this.#actionAccountId(tx, actionId);
      const loaded = await this.#load(tx, accountId);
      const row = loaded?.saga.actions.find((entry) => entry.actionId === actionId);
      if (row === undefined || row.state === "prepared") throw new Error("Contacted session action not found.");
      const updated = transitionBillingSessionAction(row, expectedVersion, next, evidence, now);
      await this.#writeAction(tx, row, updated);
      return updated;
    });
  }

  async finalizeAction(input: Readonly<{
    actionId: Hex; expectedActionVersion: bigint; expectedAccountVersion: bigint;
    expectedGenerationVersions: Readonly<Record<string, bigint>>; wallet: Address; keyStore: Address;
    finalityDepth: number; observations: readonly [BillingSessionChainObservationV1, BillingSessionChainObservationV1]; now: number;
  }>): Promise<BillingSessionSagaSnapshotV1> {
    return this.#sql.transaction(async (tx) => {
      const accountId = await this.#actionAccountId(tx, input.actionId);
      const loaded = await this.#load(tx, accountId);
      const action = loaded?.saga.actions.find((row) => row.actionId === input.actionId);
      if (loaded === null || action === undefined || action.version !== input.expectedActionVersion ||
          loaded.saga.account.version !== input.expectedAccountVersion) throw new Error("Session finalize CAS refused.");
      assertBillingSessionActionPolicy(loaded.saga.account, loaded.saga.generations, action);
      for (const generation of loaded.saga.generations) {
        if (input.expectedGenerationVersions[generation.generation.toString()] !== generation.version) {
          throw new Error("Session generation finalize CAS refused.");
        }
      }
      if (Object.keys(input.expectedGenerationVersions).length !== loaded.saga.generations.length) {
        throw new Error("Session generation finalize CAS set is incomplete.");
      }
      const proof = finalizedBillingSessionProof({
        action, wallet: input.wallet, keyStore: input.keyStore,
        finalityDepth: input.finalityDepth, observations: input.observations,
      });
      const reconciled = reconcileFinalizedBillingSessionAction({
        snapshot: loaded.saga, actionId: action.actionId, proof, now: input.now,
      });
      for (const next of reconciled.generations) {
        const previous = loaded.saga.generations.find((row) => row.generation === next.generation);
        if (previous === undefined) throw new Error("Session finalize lost a generation row.");
        await this.#writeGeneration(tx, previous, next);
      }
      for (const next of reconciled.actions) {
        const previous = loaded.saga.actions.find((row) => row.actionId === next.actionId);
        if (previous === undefined) throw new Error("Session finalize lost an action row.");
        await this.#writeAction(tx, previous, next);
      }
      await this.#writeBillingAccount(tx, loaded, reconciled.account, reconciled.generations, input.now);
      return reconciled;
    });
  }

  /** Fail-closed ON census over every active/paused/closing account in the canonical billing snapshot. */
  async censusForOn(): Promise<readonly BillingSessionOnCensusEntryV1[]> {
    return this.#sql.transaction(async (tx) => {
      const state = await tx.query<{ payload: unknown }>(
        `/* billing.session.censusState */ select payload from phase5_billing_state where singleton=true for update`,
      );
      const payload = state.rows[0]?.payload;
      if (payload === undefined) throw new Error("Billing state row is missing.");
      const snapshot = decodeJsonb(payload) as BillingStoreSnapshot;
      return this.#censusSnapshot(tx, snapshot);
    });
  }

  /** One repeatable-read, read-only enablement snapshot: schema proof, KMS census and exact Usage exposure. */
  async readOnlyEnablementExposure(input: Readonly<{
    migrationVersion: string;
    x402Authorizer: string;
  }>): Promise<BillingEnablementExposureSnapshotV1> {
    if (input.migrationVersion !== BILLING_PRODUCTION_MIGRATION) throw new Error("Billing migration version drifted.");
    return this.#sql.transaction(async (tx) => {
      await tx.query("/* billing.session.enablementIsolation */ set transaction isolation level repeatable read read only");
      const migration = await tx.query<{
        state_table: boolean;
        accounts_table: boolean;
        generations_table: boolean;
        actions_table: boolean;
        encrypted_key_nullable: boolean;
        kms_projection_columns: boolean;
      }>(`/* billing.session.enablementMigration */ select
        to_regclass('phase5_billing_state') is not null as state_table,
        to_regclass('phase5_billing_accounts') is not null as accounts_table,
        to_regclass('phase5_billing_session_generations') is not null as generations_table,
        to_regclass('phase5_billing_session_actions') is not null as actions_table,
        exists(select 1 from information_schema.columns where table_schema=current_schema()
          and table_name='phase5_billing_accounts' and column_name='encrypted_session_key' and is_nullable='YES') as encrypted_key_nullable,
        (select count(*)=5 from information_schema.columns where table_schema=current_schema()
          and table_name='phase5_billing_accounts' and column_name in
          ('session_kms_key_arn','session_generation','session_public_key','session_state_version','billing_status')) as kms_projection_columns`);
      const shape = migration.rows[0];
      if (shape === undefined || !shape.state_table || !shape.accounts_table || !shape.generations_table ||
          !shape.actions_table || !shape.encrypted_key_nullable || !shape.kms_projection_columns) {
        throw new Error("Billing production migration is not installed exactly enough for enablement.");
      }
      const state = await tx.query<{ payload: unknown }>(
        "/* billing.session.enablementState */ select payload from phase5_billing_state where singleton=true",
      );
      const payload = state.rows[0]?.payload;
      if (payload === undefined) throw new Error("Billing state row is missing.");
      const snapshot = decodeJsonb(payload) as BillingStoreSnapshot;
      const census = await this.#censusSnapshot(tx, snapshot);
      const usages = snapshot.usages.map(([, usage]) => usage);
      return Object.freeze({ migrationVersion: BILLING_PRODUCTION_MIGRATION,
        liveUsdcExposureAtomic: livePayerExposureAtomic(usages, "USDC_BASE", input.x402Authorizer), census });
    });
  }
}
