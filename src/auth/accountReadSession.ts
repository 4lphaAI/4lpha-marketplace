import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";

export const ACCOUNT_READ_MAX_AGE_SEC = 24 * 60 * 60;

const TAG = "4lpha-account-read:v1.";
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{1,430})\.([A-Za-z0-9_-]{43})$/u;
const SECRET_PATTERN = /^[0-9a-f]{64}$/u;

export type AccountReadSessionConfig = {
  readonly key: Uint8Array;
  readonly chainId: number;
  readonly environment: Hex;
};

type Claims = {
  readonly v: 1;
  readonly owner: Address;
  readonly chainId: number;
  readonly environment: Hex;
  readonly issuedAt: number;
  readonly expiry: number;
  readonly tokenId: Hex;
};

export function parseAccountReadSessionSecret(value: string | undefined): Uint8Array | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (!SECRET_PATTERN.test(normalized)) {
    throw new Error("OWNER_READ_SESSION_SECRET must be exactly 64 lowercase hex characters.");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function encodeClaims(claims: Claims): Uint8Array {
  return Buffer.from(JSON.stringify({
    v: 1,
    owner: claims.owner.toLowerCase(),
    chainId: claims.chainId,
    environment: claims.environment.toLowerCase(),
    issuedAt: claims.issuedAt,
    expiry: claims.expiry,
    tokenId: claims.tokenId.toLowerCase(),
  }), "utf8");
}

function mac(key: Uint8Array, payload: Uint8Array): Buffer {
  return createHmac("sha256", key).update(TAG, "ascii").update(payload).digest();
}

export function issueAccountReadSession(input: {
  readonly owner: Address;
  readonly nowSec: number;
  readonly signedIssuedAt: bigint;
  readonly signedExpiry: bigint;
  readonly config: AccountReadSessionConfig;
}): { readonly token: string; readonly expiry: number } {
  const lifetime = ACCOUNT_READ_MAX_AGE_SEC;
  const expiry = Math.min(
    input.nowSec + lifetime,
    Number(input.signedExpiry) + lifetime,
    Number(input.signedIssuedAt) + lifetime,
  );
  const claims: Claims = {
    v: 1,
    owner: getAddress(input.owner),
    chainId: input.config.chainId,
    environment: input.config.environment,
    issuedAt: input.nowSec,
    expiry,
    tokenId: `0x${randomBytes(16).toString("hex")}`,
  };
  const payload = encodeClaims(claims);
  const payloadText = Buffer.from(payload).toString("base64url");
  return { token: `v1.${payloadText}.${mac(input.config.key, payload).toString("base64url")}`, expiry };
}

function isExactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function verifyAccountReadSession(
  token: string,
  config: AccountReadSessionConfig,
  nowSec: number,
): Address | null {
  if (token.length > 600) return null;
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) return null;
  let payload: Buffer;
  let supplied: Buffer;
  try {
    payload = Buffer.from(match[1]!, "base64url");
    supplied = Buffer.from(match[2]!, "base64url");
  } catch {
    return null;
  }
  if (payload.length > 320) return null;
  if (match[1] !== payload.toString("base64url")) return null;
  const expected = mac(config.key, payload);
  if (match[2] !== supplied.toString("base64url")) return null;
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let raw: unknown;
  try { raw = JSON.parse(payload.toString("utf8")); } catch { return null; }
  if (!isExactRecord(raw) || Object.keys(raw).join(",") !== "v,owner,chainId,environment,issuedAt,expiry,tokenId") return null;
  const { v, owner, chainId, environment, issuedAt, expiry, tokenId } = raw;
  if (v !== 1 || typeof owner !== "string" || typeof chainId !== "number"
    || typeof environment !== "string" || typeof issuedAt !== "number"
    || typeof expiry !== "number" || typeof tokenId !== "string") return null;
  if (!Number.isSafeInteger(chainId) || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiry)) return null;
  if (!/^0x[0-9a-f]{40}$/u.test(owner) || !/^0x[0-9a-f]{64}$/u.test(environment)
    || !/^0x[0-9a-f]{32}$/u.test(tokenId)) return null;
  if (chainId !== config.chainId || environment !== config.environment.toLowerCase()) return null;
  if (issuedAt > nowSec || expiry <= nowSec || expiry - issuedAt > ACCOUNT_READ_MAX_AGE_SEC) return null;
  try {
    const claims: Claims = { v: 1, owner: getAddress(owner), chainId, environment: environment as Hex, issuedAt, expiry, tokenId: tokenId as Hex };
    if (!timingSafeEqual(payload, Buffer.from(encodeClaims(claims)))) return null;
    return claims.owner;
  } catch {
    return null;
  }
}
