export type MetadataVersion = 1 | 2 | 3;
import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";

export const CHAIN_ID = 56 as const;
export const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export type IdentityCategory = "grid" | "trading" | "lp";
export const ERROR_CODES = ["invalid_identity", "invalid_config", "schema_missing", "not_found", "ineligible", "not_enrolled", "conflict", "lock_lost", "lock_busy", "nonce_conflict", "fee_limit", "insufficient_balance", "rpc_unavailable", "invalid_receipt", "reverted", "verification_failed", "intent_mismatch", "exclusive_required", "arguments_invalid", "other_job_pending"] as const;
export type IdentityErrorCode = typeof ERROR_CODES[number];
export class IdentityError extends Error {
  constructor(readonly code: IdentityErrorCode) { super(code); this.name = "IdentityError"; }
}
export function fail(code: IdentityErrorCode): never { throw new IdentityError(code); }
export function errorCode(error: unknown): IdentityErrorCode { return error instanceof IdentityError ? error.code : "rpc_unavailable"; }
export type IdentityStatus = "pending" | "registering" | "updating" | "registered" | "blocked";
export type Erc8004IdentitySummary = {
  readonly version: 1; readonly publicRef: string; readonly revision: number;
  readonly category: IdentityCategory; readonly status: IdentityStatus;
  readonly agentId: string | null; readonly registrationTxHash: Hex | null;
  readonly uriUpdateTxHash: Hex | null; readonly errorCode: IdentityErrorCode | null;
};
export type InvalidIdentity = { readonly invalid: true };
export type StoredIdentity = Erc8004IdentitySummary | InvalidIdentity | null;
export const INVALID_IDENTITY: InvalidIdentity = Object.freeze({ invalid: true });
export function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function validRef(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }
export function validId(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n; }
export function validHash(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value); }
export function validCategory(value: unknown): value is IdentityCategory { return value === "grid" || value === "trading" || value === "lp"; }
export function categoryForPreset(value: unknown): IdentityCategory | null {
  return value === "grid-v1" || value === "grid-shift-v1" ? "grid" : value === "trade-v1" ? "trading" : value === "lp-v1" ? "lp" : null;
}
/** Nonthrowing, including JSON literal null. SQL absence is a separate fact. */
export function decodeIdentity(value: unknown, sqlAbsent = value === undefined): StoredIdentity {
  if (sqlAbsent) return null;
  try {
    const v: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!isObject(v) || Object.keys(v).sort().join() !== "agentId,category,errorCode,publicRef,registrationTxHash,revision,status,uriUpdateTxHash,version"
      || v.version !== 1 || !validRef(v.publicRef) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1 || !validCategory(v.category)
      || !["pending", "registering", "updating", "registered", "blocked"].includes(String(v.status))
      || !(v.agentId === null || validId(v.agentId)) || !(v.registrationTxHash === null || validHash(v.registrationTxHash))
      || !(v.uriUpdateTxHash === null || validHash(v.uriUpdateTxHash))
      || !(v.errorCode === null || ERROR_CODES.includes(v.errorCode as IdentityErrorCode))) return INVALID_IDENTITY;
    if ((v.status === "blocked") !== (v.errorCode !== null)) return INVALID_IDENTITY;
    if (v.status === "pending" && (v.agentId !== null || v.registrationTxHash !== null || v.uriUpdateTxHash !== null)) return INVALID_IDENTITY;
    if (v.status === "registering" && (v.registrationTxHash === null || v.agentId !== null || v.uriUpdateTxHash !== null)) return INVALID_IDENTITY;
    if ((v.status === "updating" || v.status === "registered") && (v.agentId === null || v.registrationTxHash === null)) return INVALID_IDENTITY;
    if (v.status === "registered" && v.uriUpdateTxHash === null) return INVALID_IDENTITY;
    if (v.agentId !== null && v.registrationTxHash === null || v.uriUpdateTxHash !== null && (v.agentId === null || v.registrationTxHash === null)) return INVALID_IDENTITY;
    return v as Erc8004IdentitySummary;
  } catch { return INVALID_IDENTITY; }
}
export function validIdentity(value: StoredIdentity | undefined): value is Erc8004IdentitySummary { return value !== null && value !== undefined && !("invalid" in value); }
export function newIdentity(category: IdentityCategory): Erc8004IdentitySummary {
  return { version: 1, publicRef: randomUUID(), revision: 1, category, status: "pending", agentId: null, registrationTxHash: null, uriUpdateTxHash: null, errorCode: null };
}
export function identityOwnerView(value: StoredIdentity | undefined): Erc8004IdentitySummary | { readonly status: "blocked"; readonly errorCode: "invalid_identity" } | undefined {
  if (value === null || value === undefined) return undefined;
  const decoded = decodeIdentity(value, false);
  return validIdentity(decoded) ? decoded : { status: "blocked", errorCode: "invalid_identity" };
}

export type IdentitySource = { readonly id: string; readonly owner: Address; readonly identity: StoredIdentity; readonly existingId: string | null; readonly category: IdentityCategory | null; readonly eligible: boolean };
export type IdentityPhase = "register" | "update";
export type UnsignedIntent = { readonly chainId: 56; readonly minter: Address; readonly to: Address; readonly nonce: number; readonly value: "0"; readonly data: Hex; readonly gas: string; readonly gasPrice: string; readonly type: "legacy" };
export type IdentityTransaction = { readonly hash: Hex; readonly jobRef: string; readonly phase: IdentityPhase; readonly intent: UnsignedIntent; readonly preparedAt: number; readonly finalizedAt: number | null; readonly blockNumber: string | null; readonly blockHash: Hex | null; readonly outcome: "success" | "reverted" | null };
export type IdentityJob = {
  readonly publicRef: string; readonly sourceId: string; readonly owner: Address; readonly category: IdentityCategory;
  readonly displayNumber?: number; readonly metadataVersion?: MetadataVersion;
  readonly chainId: 56; readonly registry: Address; readonly minter: Address; readonly createdAt: number;
  readonly initialUri: string; readonly finalUri: string | null; readonly status: IdentityStatus;
  readonly mintedId: string | null; readonly registrationHash: Hex | null; readonly updateHash: Hex | null;
  readonly envelope: string | null; readonly effectiveCeiling: string | null; readonly updateGasCeiling: string | null; readonly updatePriceCeiling: string | null;
  readonly completedAt: number | null; readonly error: IdentityErrorCode | null;
};
export type LedgerState = { jobs: IdentityJob[]; transactions: IdentityTransaction[]; nextNonce: number | null };
export type IdentityBinding = { readonly chainId: 56; readonly registry: Address; readonly minter: Address };
export interface IdentityFence { check(): void; close(): Promise<void> }
export interface IdentitySources {
  get(id: string): Promise<IdentitySource | null>;
  enrolled(afterId?: string): Promise<readonly IdentitySource[]>;
  enroll(id: string, category?: IdentityCategory): Promise<IdentitySource>;
  project(source: IdentitySource, next: Erc8004IdentitySummary, fence: IdentityFence): Promise<boolean>;
}
