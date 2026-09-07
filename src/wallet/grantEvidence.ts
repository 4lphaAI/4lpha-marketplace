/** Exact, bounded evidence for a browser-granted Altana session. */
import { BNB } from "@altananetwork/sdk";
import * as RelayActions from "porto/viem/RelayActions";
import {
  createClient,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  size,
  stringToBytes,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import type { ProviderPermissions } from "../core/session.js";
import type { FundingRequirement, PendingGrant } from "../store/agents.js";
import { MAX_KEYS_PER_WALLET, readSessionRegistration, verifyDeclaredWallet, type KeyStoreReader } from "../account/keyStoreReader.js";
import { ACCOUNT_ABI, KEYSTORE_CONTROLLER_ABI } from "./abis.js";

export const MAX_RELAY_KEYS = 32;
export const MAX_GRANT_PERMISSIONS = 64;
export const MAX_ACCOUNT_SPEND_ROWS = 64;
const ANY_SELECTOR = "0x32323232";
const ANY_TARGET = "0x3232323232323232323232323232323232323232";
const PERIODS = ["minute", "hour", "day", "week", "month", "year"] as const;

/**
 * Rules the SDK adds to EVERY session key on top of what the owner signed.
 *
 * Measured on mainnet 2026-09-02 (FINDINGS (bi)): the first browser-granted
 * hire landed 14 call rules for 13 signed — Porto appends
 * `{ to: orchestrator, selector: any }` to every session key
 * (`porto/src/viem/Key.ts` `toRelay`: `if (key.role === 'session' && orchestrator)`),
 * with the orchestrator address taken from the relay's capabilities at prepare
 * time. An exact comparison that ignores this can never arm. The address is
 * PINNED here rather than learned from the relay at S3, so a relay that starts
 * naming a different orchestrator turns into `permissions-differ` (fail closed)
 * instead of silently widening the expected set. Chain 56 only — the hire route
 * refuses to boot elsewhere.
 */
export const IMPLICIT_SESSION_CALL_RULES: Readonly<Record<number, readonly CanonicalCallPermission[]>> = {
  56: [{ to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", selector: "*" }],
};
const HIRE_CHAIN_ID = 56;

export type CanonicalCallPermission = { readonly to: string; readonly selector: string };
export type CanonicalSpendPermission = { readonly token: string; readonly period: string; readonly limit: string };
export type CanonicalGrantPermissions = {
  readonly calls: readonly CanonicalCallPermission[];
  readonly spend: readonly CanonicalSpendPermission[];
};

type PermissionSource =
  | { readonly kind: "persisted"; readonly value: ProviderPermissions }
  | { readonly kind: "relay"; readonly value: unknown }
  | { readonly kind: "account-spend"; readonly value: unknown };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed permission row.");
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) throw new Error("Malformed permission row.");
}

function optionalRows(value: Record<string, unknown>, key: string): readonly unknown[] {
  const rows = value[key];
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error("Malformed permission collection.");
  return rows;
}

function canonicalHexAddress(value: unknown, wildcard: boolean): string {
  if ((value === undefined || value === null || value === ANY_TARGET) && wildcard) return "*";
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error("Malformed call target.");
  return getAddress(value).toLowerCase();
}

function canonicalSelector(value: unknown, persisted: boolean): string {
  if (value === undefined || value === null || value === ANY_SELECTOR || value === "*") return "*";
  if (persisted) {
    if (typeof value !== "string") throw new Error("Malformed call signature.");
    return toFunctionSelector(value).toLowerCase();
  }
  if (typeof value !== "string" || !isHex(value) || size(value) !== 4) throw new Error("Malformed call selector.");
  return value.toLowerCase();
}

function canonicalToken(value: unknown): string {
  if (value === undefined || value === null || value === zeroAddress) return "native";
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error("Malformed spend token.");
  const token = getAddress(value);
  return token === zeroAddress ? "native" : token.toLowerCase();
}

function canonicalPeriod(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < PERIODS.length) return PERIODS[value]!;
  if (typeof value === "bigint" && value >= 0n && value < BigInt(PERIODS.length)) return PERIODS[Number(value)]!;
  if (typeof value === "string" && PERIODS.includes(value as (typeof PERIODS)[number])) return value;
  throw new Error("Malformed spend period.");
}

function canonicalLimit(value: unknown): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,78}$/u.test(value)) return BigInt(value).toString(10);
  throw new Error("Malformed spend limit.");
}

function sortUnique<T>(rows: readonly T[], key: (row: T) => string): readonly T[] {
  const sorted = [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (key(sorted[index]!) === key(sorted[index - 1]!)) throw new Error("Duplicate canonical permission row.");
  }
  return sorted;
}

/** One normalizer for persisted, relay, and on-chain evidence. */
type PermissionBounds = { readonly combined: number; readonly spend: number };
const DEFAULT_BOUNDS: PermissionBounds = { combined: MAX_GRANT_PERMISSIONS, spend: MAX_ACCOUNT_SPEND_ROWS };
const TRADE_BOUNDS: PermissionBounds = { combined: 145, spend: 70 };
function evidenceBounds(pending: PendingGrant): PermissionBounds {
  return pending.sizing.sizingPreset === "trade-v1" ? TRADE_BOUNDS : DEFAULT_BOUNDS;
}

export function normalizeGrantPermissions(source: PermissionSource, bounds: PermissionBounds = DEFAULT_BOUNDS): CanonicalGrantPermissions {
  let callsRaw: readonly unknown[] = [];
  let spendRaw: readonly unknown[] = [];
  if (source.kind === "persisted") {
    callsRaw = source.value.calls;
    spendRaw = source.value.spend;
  } else if (source.kind === "relay") {
    const value = record(source.value);
    requireOnlyKeys(value, ["calls", "spend"]);
    callsRaw = optionalRows(value, "calls");
    spendRaw = optionalRows(value, "spend");
  } else {
    spendRaw = Array.isArray(source.value) ? source.value : (() => { throw new Error("Malformed account spend rows."); })();
  }
  if (callsRaw.length + spendRaw.length > bounds.combined || spendRaw.length > bounds.spend) {
    throw new Error("Permission evidence exceeds its work bound.");
  }
  const calls = callsRaw.map((entry) => {
    const row = record(entry);
    requireOnlyKeys(row, ["to", "signature"]);
    if (row["to"] === undefined && row["signature"] === undefined) throw new Error("Malformed call permission.");
    return {
      to: canonicalHexAddress(row["to"], true),
      selector: canonicalSelector(row["signature"], source.kind === "persisted"),
    };
  });
  const spend = spendRaw.map((entry) => {
    const row = record(entry);
    if (source.kind === "account-spend") {
      requireOnlyKeys(row, ["token", "period", "limit", "spent", "lastUpdated", "currentSpent", "current"]);
    } else {
      requireOnlyKeys(row, ["token", "period", "limit"]);
    }
    if (row["period"] === undefined || row["limit"] === undefined) throw new Error("Malformed spend permission.");
    return {
      token: canonicalToken(row["token"]),
      period: canonicalPeriod(row["period"]),
      limit: canonicalLimit(row["limit"]),
    };
  });
  return {
    calls: sortUnique(calls, (row) => `${row.to}|${row.selector}`),
    spend: sortUnique(spend, (row) => `${row.token}|${row.period}|${row.limit}`),
  };
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason ?? new Error("Evidence attempt timed out."));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted)).catch(() => undefined);
  });
}

/** The call set a correctly landed grant MUST show: the signed rules plus the SDK's implicit ones. */
export function expectedGrantCalls(persisted: ProviderPermissions, bounds: PermissionBounds = DEFAULT_BOUNDS): readonly CanonicalCallPermission[] {
  const signed = normalizeGrantPermissions({ kind: "persisted", value: persisted }, bounds).calls;
  const seen = new Set(signed.map((row) => `${row.to}|${row.selector}`));
  const implicit = (IMPLICIT_SESSION_CALL_RULES[HIRE_CHAIN_ID] ?? []).filter((row) => !seen.has(`${row.to}|${row.selector}`));
  return [...signed, ...implicit].sort((a, b) => `${a.to}|${a.selector}`.localeCompare(`${b.to}|${b.selector}`));
}

export function equalCanonicalPermissions(left: CanonicalGrantPermissions, right: CanonicalGrantPermissions): boolean {
  return canonicalEncode(left) === canonicalEncode(right);
}

export function grantDigest(input: {
  readonly permissions: ProviderPermissions;
  readonly expiresAt: number;
  readonly walletAddress: Address;
  readonly sessionAddress: Address;
}): Hex {
  return keccak256(stringToBytes(canonicalEncode(input)));
}

export function fundingRequirement(input: {
  readonly registrationFeeWei: bigint;
  readonly activeKeyIds: readonly Hex[];
  readonly relayGasHeadroomWei: bigint;
  readonly balanceWei: bigint;
  readonly observedAtSec: number;
}): FundingRequirement {
  if (input.registrationFeeWei < 0n || input.relayGasHeadroomWei < 0n || input.balanceWei < 0n
    || !Number.isInteger(input.observedAtSec) || input.observedAtSec < 0 || input.activeKeyIds.length > MAX_RELAY_KEYS) {
    throw new Error("Malformed funding evidence.");
  }
  const registrations = input.activeKeyIds.length === 0 ? 2 : 1;
  return {
    version: 1,
    observedAtSec: input.observedAtSec,
    registrationFeeWei: input.registrationFeeWei.toString(10),
    registrations,
    relayGasHeadroomWei: input.relayGasHeadroomWei.toString(10),
    requiredWei: (BigInt(registrations) * input.registrationFeeWei + input.relayGasHeadroomWei).toString(10),
    balanceWei: input.balanceWei.toString(10),
  };
}

export type GrantEvidenceSnapshot = {
  readonly relayKeys: readonly {
    readonly hash: Hex;
    readonly expiry: number;
    readonly role: string;
    readonly permissions: unknown;
  }[];
  readonly accountKey: { readonly expiry: number; readonly isSuperAdmin: boolean } | null;
  readonly accountSpend: readonly unknown[];
  readonly canExecute: readonly boolean[];
  readonly keyStore: Awaited<ReturnType<typeof readSessionRegistration>>;
  readonly ownerVerdict: Awaited<ReturnType<typeof verifyDeclaredWallet>>;
};

export type GrantEvidenceReader = {
  readFunding(wallet: Address, relayGasHeadroomWei: bigint, observedAtSec: number, signal?: AbortSignal): Promise<FundingRequirement>;
  readGrant(pending: PendingGrant, signal?: AbortSignal): Promise<GrantEvidenceSnapshot>;
};

export type ProvisioningMissing =
  | "account-key" | "permissions-differ" | "keystore-id" | "keystore-pubkey"
  | "wallet-not-registered" | "wallet-owner-mismatch" | "evidence-unreadable" | "expired";

/** `KeyDoesNotExist()` — the account's revert for a key hash it has never been granted. */
export const KEY_DOES_NOT_EXIST_SELECTOR = "0xe57b6304";

/**
 * True only for the account's own `KeyDoesNotExist()` revert, wherever viem
 * put it: the decoded error name when the ABI carries the error, the raw
 * four-byte signature when it does not, and either of those on any cause in
 * the chain. Everything else — other reverts, timeouts, a dead node — is NOT
 * this, and stays a failed read.
 */
export function isKeyDoesNotExistRevert(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { readonly signature?: unknown; readonly data?: unknown; readonly cause?: unknown; readonly message?: unknown };
    if (typeof record.signature === "string" && record.signature.toLowerCase() === KEY_DOES_NOT_EXIST_SELECTOR) return true;
    if (typeof record.data === "string" && record.data.toLowerCase().startsWith(KEY_DOES_NOT_EXIST_SELECTOR)) return true;
    const data = record.data as { readonly errorName?: unknown } | undefined;
    if (typeof data === "object" && data !== null && data.errorName === "KeyDoesNotExist") return true;
    if (typeof record.message === "string" && record.message.includes(KEY_DOES_NOT_EXIST_SELECTOR)) return true;
    current = record.cause;
  }
  return false;
}

export function assessGrantEvidence(pending: PendingGrant, evidence: GrantEvidenceSnapshot, nowSec: number): readonly ProvisioningMissing[] {
  if (nowSec >= pending.expiresAt) return ["expired"];
  try {
    if (evidence.relayKeys.length > MAX_RELAY_KEYS) return ["evidence-unreadable"];
    const relayMatches = evidence.relayKeys.filter((key) => key.hash.toLowerCase() === pending.accountKeyHash.toLowerCase());
    if (relayMatches.length > 1) return ["evidence-unreadable"];
    const missing: ProvisioningMissing[] = [];
    if (relayMatches.length === 0 || evidence.accountKey === null) missing.push("account-key");
    const expected = { ...normalizeGrantPermissions({ kind: "persisted", value: pending.permissions }, evidenceBounds(pending)), calls: expectedGrantCalls(pending.permissions, evidenceBounds(pending)) };
    const relayPermissions = relayMatches.length === 1
      ? normalizeGrantPermissions({ kind: "relay", value: relayMatches[0]!.permissions }, evidenceBounds(pending))
      : null;
    if (relayMatches.length === 1 && evidence.accountKey !== null && relayPermissions !== null) {
      const relay = relayMatches[0]!;
      const accountSpend = normalizeGrantPermissions({ kind: "account-spend", value: evidence.accountSpend }, evidenceBounds(pending));
      if (relay.expiry !== pending.expiresAt || relay.role === "admin" || evidence.accountKey.expiry !== pending.expiresAt
        || evidence.accountKey.isSuperAdmin || !equalCanonicalPermissions(expected, relayPermissions)
        || canonicalEncode(expected.spend) !== canonicalEncode(accountSpend.spend)
        || evidence.canExecute.length !== expected.calls.length || evidence.canExecute.some((allowed) => !allowed)) {
        missing.push("permissions-differ");
      }
    }
    if (evidence.keyStore.kind === "unreadable" || evidence.ownerVerdict === "unreadable") return ["evidence-unreadable"];
    if (evidence.keyStore.kind === "missing") missing.push("keystore-id");
    else if (evidence.keyStore.kind === "invalid" || evidence.keyStore.publicKey.toLowerCase() !== pending.sessionPublicKey.toLowerCase()) missing.push("keystore-pubkey");
    if (evidence.ownerVerdict === "not-registered") missing.push("wallet-not-registered");
    if (evidence.ownerVerdict === "no-matching-key") missing.push("wallet-owner-mismatch");
    return missing;
  } catch {
    return ["evidence-unreadable"];
  }
}

export function createGrantEvidenceReader(options: {
  readonly network: { readonly chain: Chain; readonly chainId: number; readonly publicRpcUrl: string; readonly keyStoreController: Address };
  readonly rpcUrls?: readonly string[];
  readonly keyStoreReader: KeyStoreReader;
  readonly transport?: (url: string) => Transport;
}): GrantEvidenceReader {
  if (options.network.chainId !== 56 || BNB.relayUrl === undefined) throw new Error("Hire evidence requires the chain-56 Altana relay.");
  const transport = options.transport ?? ((url: string) => http(url));
  const relayClient = createClient({ chain: BNB.chain, transport: http(BNB.relayUrl, { timeout: 60_000 }) });
  const urls = options.rpcUrls?.length ? [...new Set(options.rpcUrls)] : [options.network.publicRpcUrl];
  let connection: Promise<PublicClient> | undefined;
  async function connected(): Promise<PublicClient> {
    connection ??= (async () => {
      for (const url of urls) {
        const client: PublicClient = createPublicClient({ chain: options.network.chain, transport: transport(url) });
        try { if (await client.getChainId() === options.network.chainId) return client; } catch { /* try next */ }
      }
      throw new Error("No chain-56 RPC endpoint is readable.");
    })();
    try { return await connection; } catch (cause) { connection = undefined; throw cause; }
  }
  return {
    async readFunding(wallet, relayGasHeadroomWei, observedAtSec, signal) {
      const client = await withAbort(connected(), signal);
      const [activeKeyIds, registrationFeeWei, balanceWei] = await withAbort(Promise.all([
        options.keyStoreReader.listKeys(wallet),
        client.readContract({ address: options.network.keyStoreController, abi: KEYSTORE_CONTROLLER_ABI, functionName: "getRegistrationFeeInWei" }),
        client.getBalance({ address: wallet }),
      ]), signal);
      if (activeKeyIds.length > MAX_KEYS_PER_WALLET) throw new Error("Active KeyStore registry exceeds its work bound.");
      return fundingRequirement({ registrationFeeWei, activeKeyIds, relayGasHeadroomWei, balanceWei, observedAtSec });
    },
    async readGrant(pending, signal) {
      signal?.throwIfAborted();
      const client = await withAbort(connected(), signal);
      const expected = { calls: expectedGrantCalls(pending.permissions, evidenceBounds(pending)) };
      // FIRST-GRANT WALLETS (2026-09-06, live: owner 0x8cbe…, wallet 0xdc1d…).
      // A passkey wallet is a plain address with NO code until its first grant
      // performs the EIP-7702 delegation. Every account read below is an
      // `eth_call` against that address; with no code it answers `0x`, viem
      // cannot decode it, the Promise.all rejects, and the route reports
      // `evidence-unreadable` — which the web waits 40 s on and then gives up,
      // so a brand-new wallet could never reach the grant step at all. No code
      // means no key can exist on the account, so the honest answer is the
      // same one an ungranted deployed wallet gives: no account key, no spend
      // rows, nothing executable. Relay and KeyStore reads still run — they
      // do not depend on the wallet's code — so the verdict stays complete.
      const code = await withAbort(client.getCode({ address: pending.walletAddress }), signal);
      const undelegated = code === undefined || code === "0x";
      const relayPromise = RelayActions.getKeys(relayClient, { account: pending.walletAddress, chainIds: [56] });
      const accountPromise = undelegated
        ? Promise.resolve([[], []] as const)
        : client.readContract({ address: pending.walletAddress, abi: ACCOUNT_ABI, functionName: "getKeys" });
      const spendPromise = undelegated
        ? Promise.resolve([] as const)
        : client.readContract({ address: pending.walletAddress, abi: ACCOUNT_ABI, functionName: "spendInfos", args: [pending.accountKeyHash] });
      // `canExecute` on the Altana account REVERTS `KeyDoesNotExist()` for a
      // key that has not been granted yet (measured live on wallet
      // 0x2714…9da6, 2026-09-03: `getKeys` and `spendInfos` answer, every
      // `canExecute` probe reverts `0xe57b6304`). Before the grant that is the
      // ordinary state of every hire, and `assessGrantEvidence` consults these
      // probes only once the key exists — so the revert is the answer "no key",
      // not an unreadable chain. Letting it escape turned every fresh hire into
      // `evidence-unreadable`, which `hireResumeStep` maps to `poll`, and a hire
      // in `poll` is never offered the grant: the row sat there until expiry.
      // Any OTHER revert or transport failure still throws, still unreadable.
      const canExecutePromise = undelegated
        ? Promise.resolve(expected.calls.map(() => false))
        : Promise.all(expected.calls.map((call) => client.readContract({
        address: pending.walletAddress, abi: ACCOUNT_ABI, functionName: "canExecute",
        args: [pending.accountKeyHash, call.to === "*" ? zeroAddress : getAddress(call.to), call.selector === "*" ? "0x" : call.selector as Hex],
      }).catch((error: unknown) => {
        if (isKeyDoesNotExistRevert(error)) return false;
        throw error;
      })));
      const [relay, account, accountSpend, canExecute, keyStore, ownerVerdict] = await withAbort(Promise.all([
        relayPromise, accountPromise, spendPromise, canExecutePromise,
        readSessionRegistration({ wallet: pending.walletAddress, keyId: pending.keyStoreKeyId, reader: options.keyStoreReader, ...(signal === undefined ? {} : { signal }) }),
        verifyDeclaredWallet({ owner: pending.recoveredOwner, wallet: pending.walletAddress, reader: options.keyStoreReader, ...(signal === undefined ? {} : { signal }) }),
      ]), signal);
      if (relay.length > MAX_RELAY_KEYS) throw new Error("Relay key bound exceeded.");
      const [accountRows, hashes] = account;
      const index = hashes.findIndex((hash) => hash.toLowerCase() === pending.accountKeyHash.toLowerCase());
      return {
        relayKeys: relay.map((key) => ({ hash: key.hash as Hex, expiry: key.expiry, role: key.role, permissions: key.permissions ?? {} })),
        accountKey: index < 0 ? null : { expiry: Number(accountRows[index]!.expiry), isSuperAdmin: accountRows[index]!.isSuperAdmin },
        accountSpend,
        canExecute,
        keyStore,
        ownerVerdict,
      };
    },
  };
}
