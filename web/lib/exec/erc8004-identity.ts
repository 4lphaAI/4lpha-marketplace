const ERROR_CODES = [
  "invalid_identity", "invalid_config", "schema_missing", "not_found", "ineligible", "not_enrolled", "conflict", "lock_lost",
  "lock_busy", "nonce_conflict", "fee_limit", "insufficient_balance", "rpc_unavailable", "invalid_receipt", "reverted",
  "verification_failed", "intent_mismatch", "exclusive_required", "arguments_invalid", "other_job_pending",
] as const;
type IdentityErrorCode = (typeof ERROR_CODES)[number];
function errorCode(value: unknown): value is IdentityErrorCode {
  return typeof value === "string" && ERROR_CODES.some((code) => code === value);
}

/** Independent owner-view DTO; identity ownership conveys no execution authority. */
export type Erc8004Identity = {
  readonly version: 1;
  readonly publicRef: string;
  readonly revision: number;
  readonly category: "grid" | "trading" | "lp" | "lending";
  readonly status: "pending" | "registering" | "updating" | "registered" | "blocked";
  readonly agentId: string | null;
  readonly registrationTxHash: string | null;
  readonly uriUpdateTxHash: string | null;
  readonly errorCode: IdentityErrorCode | null;
} | { readonly status: "blocked"; readonly errorCode: "invalid_identity" };

const INVALID = { status: "blocked", errorCode: "invalid_identity" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const UINT256_MAX = (1n << 256n) - 1n;
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const FIELDS = new Set(["version", "publicRef", "revision", "category", "status", "agentId", "registrationTxHash", "uriUpdateTxHash", "errorCode"]);

function uint256(value: unknown): value is string {
  return typeof value === "string" && value.length <= 78
    && /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= UINT256_MAX;
}

/** Malformed identity must never hide the agent's ordinary owner controls. */
export function parseErc8004Identity(value: unknown): Erc8004Identity | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return INVALID;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !FIELDS.has(key))
    || raw["version"] !== 1 || typeof raw["publicRef"] !== "string" || !UUID.test(raw["publicRef"])
    || typeof raw["revision"] !== "number" || !Number.isSafeInteger(raw["revision"]) || raw["revision"] < 1
    || (raw["category"] !== "grid" && raw["category"] !== "trading" && raw["category"] !== "lp"
      && raw["category"] !== "lending")
    || (raw["status"] !== "pending" && raw["status"] !== "registering" && raw["status"] !== "updating"
      && raw["status"] !== "registered" && raw["status"] !== "blocked")
    || (raw["agentId"] !== null && !uint256(raw["agentId"]))
    || (raw["registrationTxHash"] !== null && (typeof raw["registrationTxHash"] !== "string" || !HASH.test(raw["registrationTxHash"])))
    || (raw["uriUpdateTxHash"] !== null && (typeof raw["uriUpdateTxHash"] !== "string" || !HASH.test(raw["uriUpdateTxHash"])))
    || (raw["errorCode"] !== null && !errorCode(raw["errorCode"]))) return INVALID;
  if ((raw["status"] === "blocked") !== (raw["errorCode"] !== null)) return INVALID;
  if (raw["agentId"] !== null && raw["registrationTxHash"] === null) return INVALID;
  if (raw["uriUpdateTxHash"] !== null && (raw["agentId"] === null || raw["registrationTxHash"] === null)) return INVALID;
  if (raw["status"] === "registered" && (raw["agentId"] === null || raw["registrationTxHash"] === null || raw["uriUpdateTxHash"] === null)) return INVALID;
  if (raw["status"] === "updating" && (raw["agentId"] === null || raw["registrationTxHash"] === null)) return INVALID;
  if ((raw["status"] === "pending" || raw["status"] === "registering")
    && (raw["agentId"] !== null || raw["uriUpdateTxHash"] !== null)) return INVALID;
  if (raw["status"] === "pending" && raw["registrationTxHash"] !== null) return INVALID;
  if (raw["status"] === "registering" && raw["registrationTxHash"] === null) return INVALID;
  return {
    version: 1, publicRef: raw["publicRef"], revision: raw["revision"], category: raw["category"], status: raw["status"],
    agentId: raw["agentId"], registrationTxHash: raw["registrationTxHash"], uriUpdateTxHash: raw["uriUpdateTxHash"], errorCode: raw["errorCode"],
  };
}

export function erc8004TokenUrl(identity: Erc8004Identity): string | null {
  const checked = parseErc8004Identity(identity);
  // 8004scan is the ERC-8004 registry explorer (agent page per BSC agent id);
  // the registry NFT itself remains visible on bscscan under REGISTRY.
  return checked?.status === "registered" ? `https://8004scan.io/agents/bsc/${checked.agentId}` : null;
}
