import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import type { EnabledBillingConfig } from "./config.js";
import type { PreparedCollection } from "./collection.js";
import type { PreparedInvoiceBindingToken } from "./store.js";

export type ClosedRelayStatus = Readonly<{
  state: "PENDING" | "CONFIRMED" | "FAILED";
  transactionHash?: Hex;
}>;

/** The complete Revision 7 deployment boundary. No network/evidence callback is permitted. */
export type BillingCustodyAndRelayPrimitives = Readonly<{
  signExecutionTicket(keyId: string, bytes: Uint8Array): Promise<string>;
  signX402(keyId: string, filteredAuthorization: Uint8Array): Promise<string>;
  loadOgCredential(keyId: string): Promise<Readonly<{
    bearerToken: string;
    apiKeyId: string;
    payerAccountId: string;
  }>>;
  readBillingSession(accountId: string): Promise<Readonly<{
    generation: bigint;
    expiresAt: number;
  }>>;
  readBillingMeter(accountId: string): Promise<Readonly<{
    balanceWei: bigint;
    remainingDayCapWei: bigint;
  }>>;
  relayPrepare(closedRequest: Uint8Array): Promise<PreparedCollection>;
  relaySend(
    boundPrepared: PreparedCollection,
    token: PreparedInvoiceBindingToken,
  ): Promise<Readonly<{ callsId?: Hex }>>;
  relayStatus(callsId: Hex): Promise<ClosedRelayStatus>;
  close(): Promise<void>;
}>;

type InfrastructureModule = Readonly<{
  createBillingCustodyAndRelayPrimitives?: (input: Readonly<{
    config: EnabledBillingConfig;
    env: NodeJS.ProcessEnv;
  }>) => Promise<BillingCustodyAndRelayPrimitives>;
}>;

const PRIMITIVE_KEYS = new Set([
  "signExecutionTicket",
  "signX402",
  "loadOgCredential",
  "readBillingSession",
  "readBillingMeter",
  "relayPrepare",
  "relaySend",
  "relayStatus",
  "close",
]);

function localModuleUrl(env: NodeJS.ProcessEnv): URL {
  const raw = env["BILLING_INFRASTRUCTURE_MODULE"]?.trim() ?? "";
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("BILLING_INFRASTRUCTURE_MODULE must be an absolute local file URL."); }
  if (
    url.protocol !== "file:" || url.host !== "" || url.username !== "" ||
    url.password !== "" || url.search !== "" || url.hash !== ""
  ) {
    throw new Error("BILLING_INFRASTRUCTURE_MODULE must be an absolute local file URL with no network host.");
  }
  return url;
}

async function assertReviewedArtifact(url: URL, env: NodeJS.ProcessEnv): Promise<void> {
  const expected = env["BILLING_INFRASTRUCTURE_MODULE_SHA256"]?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/u.test(expected)) {
    throw new Error("BILLING_INFRASTRUCTURE_MODULE_SHA256 must pin the reviewed local artifact.");
  }
  const bytes = await readFile(fileURLToPath(url));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("The billing custody/relay artifact hash does not match the reviewed value.");
}

function assertClosedCensus(value: unknown): asserts value is BillingCustodyAndRelayPrimitives {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The billing custody/relay primitive adapter is malformed.");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== PRIMITIVE_KEYS.size || keys.some((key) => !PRIMITIVE_KEYS.has(key))) {
    throw new Error("The billing custody/relay module exported a callback outside the closed census.");
  }
  for (const key of PRIMITIVE_KEYS) {
    if (typeof row[key] !== "function") throw new Error(`The billing custody/relay primitive ${key} is missing.`);
  }
}

export async function loadBillingCustodyAndRelayPrimitives(
  config: EnabledBillingConfig,
  env: NodeJS.ProcessEnv,
): Promise<BillingCustodyAndRelayPrimitives> {
  const url = localModuleUrl(env);
  await assertReviewedArtifact(url, env);
  const loaded = await import(url.href) as InfrastructureModule;
  if (typeof loaded.createBillingCustodyAndRelayPrimitives !== "function") {
    throw new Error("The reviewed module must export createBillingCustodyAndRelayPrimitives.");
  }
  const primitives = await loaded.createBillingCustodyAndRelayPrimitives({ config, env });
  assertClosedCensus(primitives);
  return primitives;
}
