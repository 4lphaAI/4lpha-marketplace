/**
 * Browser-side port of the execution plane's owner-action signing seam.
 *
 * CONSENSUS-CRITICAL DUPLICATE (spec §9 risk 1): `canonicalEncode` and
 * `paramsHash` here must reproduce `src/auth/canonical.ts` byte for byte, and
 * the EIP-712 domain must reproduce `src/auth/ownerAuth.ts`. Golden vectors in
 * `owner-action.test.ts` pin the encoding; any divergence surfaces as a
 * generic 401 `owner_auth_failed` from the plane.
 */
import { getAddress, isAddress, keccak256, stringToBytes, toBytes } from "viem";
import type { Hex } from "viem";

// ── canonical encoding (port of src/auth/canonical.ts) ──────────────────────

function normalizeString(value: string): string {
  if (!isAddress(value, { strict: false })) return value;
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export function canonicalEncode(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "bigint") return `#${(value as bigint).toString(10)}`;
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalEncode: non-finite number is not encodable.");
    }
    return `n${value}`;
  }
  if (type === "string") return JSON.stringify(normalizeString(value as string));
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalEncode(item)).join(",")}]`;
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalEncode(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalEncode: unsupported value of type ${type}.`);
}

/** U+001F unit separator — same byte as the plane's ACTION_PARAM_SEPARATOR. */
const ACTION_PARAM_SEPARATOR = "";

export function paramsHash(action: string, params: unknown): Hex {
  const encoded = `${action}${ACTION_PARAM_SEPARATOR}${canonicalEncode(params)}`;
  return keccak256(stringToBytes(encoded));
}

// ── EIP-712 domain + types (port of src/auth/ownerAuth.ts) ──────────────────

export const OWNER_ACTION_TYPES = {
  OwnerAction: [
    { name: "owner", type: "address" },
    { name: "agentId", type: "string" },
    { name: "action", type: "string" },
    { name: "paramsHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export type ExecDomainConfig = {
  readonly chainId: number;
  readonly network: string;
  /** Must match the server's EXECUTION_ENV_SALT when that is set. */
  readonly envSalt?: string | undefined;
};

export function execDomainConfigFromEnv(): ExecDomainConfig {
  const chainId = Number(process.env["NEXT_PUBLIC_EXEC_CHAIN_ID"] ?? "56");
  const network = process.env["NEXT_PUBLIC_EXEC_NETWORK"] ?? "mainnet";
  const envSalt = process.env["NEXT_PUBLIC_EXEC_ENV_SALT"]?.trim();
  return { chainId, network, ...(envSalt ? { envSalt } : {}) };
}

export function ownerActionDomain(config: ExecDomainConfig) {
  const base = config.envSalt && config.envSalt.length > 0
    ? config.envSalt
    : `${config.network}:${config.chainId}`;
  const salt = keccak256(toBytes(`4lpha-execution/1/${base}`));
  // chainId is part of the plane's domain (buildOwnerActionDomain) — omitting
  // it diverges the typed-data hash; caught by the offline cross-check.
  return { name: "4lpha-execution", version: "1", chainId: config.chainId, salt } as const;
}

// ── envelope builders (wire shapes of src/http/wire.ts) ─────────────────────

export type SignedOwnerAction = {
  readonly owner: Hex;
  readonly agentId: string;
  readonly action: string;
  readonly paramsHash: Hex;
  readonly nonce: Hex;
  /** Decimal seconds, as strings on the wire; signed as uint64. */
  readonly issuedAt: string;
  readonly expiry: string;
};

export type OwnerActionEnvelope = {
  readonly signed: SignedOwnerAction;
  readonly signature: Hex;
  readonly params: unknown;
};

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/**
 * Everything to sign for one owner action. `issuedAt = now-5` absorbs client
 * clock skew; `expiry = now+120` stays inside the plane's 300 s window.
 */
export function buildOwnerAction(input: {
  readonly owner: Hex;
  readonly agentId: string;
  readonly action: string;
  readonly params: unknown;
  readonly domain: ExecDomainConfig;
}): {
  readonly signed: SignedOwnerAction;
  readonly typedData: {
    readonly domain: ReturnType<typeof ownerActionDomain>;
    readonly types: typeof OWNER_ACTION_TYPES;
    readonly primaryType: "OwnerAction";
    readonly message: {
      readonly owner: Hex;
      readonly agentId: string;
      readonly action: string;
      readonly paramsHash: Hex;
      readonly nonce: Hex;
      readonly issuedAt: bigint;
      readonly expiry: bigint;
    };
  };
} {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = BigInt(now - 5);
  const expiry = BigInt(now + 120);
  const nonce = randomNonce();
  const hash = paramsHash(input.action, input.params);
  const signed: SignedOwnerAction = {
    owner: input.owner,
    agentId: input.agentId,
    action: input.action,
    paramsHash: hash,
    nonce,
    issuedAt: issuedAt.toString(10),
    expiry: expiry.toString(10),
  };
  return {
    signed,
    typedData: {
      domain: ownerActionDomain(input.domain),
      types: OWNER_ACTION_TYPES,
      primaryType: "OwnerAction",
      message: {
        owner: input.owner,
        agentId: input.agentId,
        action: input.action,
        paramsHash: hash,
        nonce,
        issuedAt,
        expiry,
      },
    },
  };
}

/** Read envelopes travel base64url-encoded in the `x-owner-action` header. */
export function encodeReadHeader(envelope: OwnerActionEnvelope): string {
  const json = JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
