import { getAddress, type Hex } from "viem";
import { assertCollectability, type CollectionAuthorityBoundary, type PreparedCollection } from "./collection.js";
import type { EnabledBillingConfig } from "./config.js";
import type {
  BillingBscObservationV1,
  BillingCanExecuteCheckV1,
  BillingCustodyAndRelayPrimitives,
  BillingSessionRefV1,
  ProductionBillingCustodyAndRelayPrimitives,
} from "./custody.js";
import type { BillingProductionManifestV2 } from "./productionManifest.js";
import type { BillingStore } from "./store.js";
import { billingAccountCustodyKind, type BillingAccount } from "./types.js";

const PREPARE_KEYS = [
  "domain", "chainId", "wallet", "collector", "calldata", "value",
  "sessionGeneration", "maxExpiresAt",
] as const;

export type BillingBscAuthorityReader = (
  session: BillingSessionRefV1,
  canExecute: BillingCanExecuteCheckV1,
) => Promise<readonly [BillingBscObservationV1, BillingBscObservationV1]>;

export type ProductionCoreBridge = Readonly<{
  primitives: BillingCustodyAndRelayPrimitives;
  authority(account: BillingAccount): CollectionAuthorityBoundary;
  signX402Digest(digest: Hex): Promise<string>;
  verifyBootAccounts(accounts: readonly BillingAccount[]): Promise<void>;
}>;

function row(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is malformed.`);
  return value as Record<string, unknown>;
}

function canonicalDecimal(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${field} is malformed.`);
  return BigInt(value);
}

function sessionRef(account: BillingAccount): BillingSessionRefV1 {
  if (billingAccountCustodyKind(account) !== "kms" || account.sessionKmsKeyArn == null ||
      account.sessionGeneration == null || account.sessionPublicKey == null) {
    throw new Error("Production billing requires a finalized KMS session generation.");
  }
  return Object.freeze({
    domain: "4lpha.billing-session-ref.v1",
    accountId: account.accountId,
    wallet: getAddress(account.walletAddress),
    kmsKeyArn: account.sessionKmsKeyArn,
    publicKey: account.sessionPublicKey,
    generation: account.sessionGeneration,
    expiresAt: account.grantExpiresAt,
    sessionFactsBytes: account.sessionFactsBytes,
  });
}

function parsePrepare(bytes: Uint8Array): Readonly<{
  wallet: string;
  collector: string;
  calldata: Hex;
  valueWei: bigint;
  sessionGeneration: bigint;
  maxExpiresAt: number;
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error("Billing relay prepare bytes are malformed."); }
  const value = row(parsed, "Billing relay prepare");
  if (Object.keys(value).join("|") !== PREPARE_KEYS.join("|") ||
      value["domain"] !== "4lpha.billing-collection-prepare.v1" || value["chainId"] !== 56 ||
      typeof value["wallet"] !== "string" || typeof value["collector"] !== "string" ||
      typeof value["calldata"] !== "string" || !/^0x(?:[0-9a-f]{2})+$/u.test(value["calldata"]) ||
      !Number.isSafeInteger(value["maxExpiresAt"]) || (value["maxExpiresAt"] as number) <= 0) {
    throw new Error("Billing relay prepare bytes are outside the production contract.");
  }
  return {
    wallet: value["wallet"],
    collector: value["collector"],
    calldata: value["calldata"] as Hex,
    valueWei: canonicalDecimal(value["value"], "Billing relay value"),
    sessionGeneration: canonicalDecimal(value["sessionGeneration"], "Billing relay generation"),
    maxExpiresAt: value["maxExpiresAt"] as number,
  };
}

/**
 * Adapts the reviewed production ABI to the existing core state machines.
 * RPC observations remain core-owned; the bundle receives only closed facts.
 */
export function createProductionCoreBridge(input: Readonly<{
  config: EnabledBillingConfig;
  manifest: BillingProductionManifestV2;
  store: BillingStore;
  production: ProductionBillingCustodyAndRelayPrimitives;
  readAuthority: BillingBscAuthorityReader;
  now?: () => number;
}>): ProductionCoreBridge {
  const now = input.now ?? (() => Math.floor(Date.now() / 1_000));

  const account = async (accountId: string): Promise<BillingAccount> => {
    const found = await input.store.getAccount(accountId);
    if (found === null) throw new Error("Billing account is missing.");
    return found;
  };

  const readSession = async (value: BillingAccount, canExecute: BillingCanExecuteCheckV1) => {
    const session = sessionRef(value);
    return input.production.readBillingSession({
      session,
      canExecute,
      observations: await input.readAuthority(session, canExecute),
      now: now(),
    });
  };

  const readMeter = async (value: BillingAccount, canExecute: BillingCanExecuteCheckV1) => {
    const session = sessionRef(value);
    return input.production.readBillingMeter({
      meter: { session, meterPeriod: "DAY", meterToken: "native" },
      canExecute,
      observations: await input.readAuthority(session, canExecute),
      now: now(),
    });
  };

  const authority = (value: BillingAccount): CollectionAuthorityBoundary => {
    const exact = async (calldata: Hex, valueWei: bigint): Promise<void> => {
      const meter = await readMeter(value, { kind: "calldata", calldata });
      assertCollectability(meter.balanceWei, meter.remainingDayCapWei, valueWei);
    };
    return {
      beforePrepare: exact,
      beforeSign: (prepared: PreparedCollection) => exact(prepared.calldata, prepared.value),
      beforeSend: (prepared: PreparedCollection) => exact(prepared.calldata, prepared.value),
    };
  };

  const primitives: BillingCustodyAndRelayPrimitives = {
    async signExecutionTicket(keyId, bytes) {
      if (keyId !== input.config.executionTicketKeyId) throw new Error("Execution ticket key identity drifted.");
      return input.production.signExecutionTicket({ keyArn: input.manifest.aws.ticketKeyArn, bytes });
    },
    async signX402() {
      throw new Error("Production x402 accepts only the core-computed EIP-712 digest.");
    },
    async loadOgCredential(keyId) {
      const ref = keyId === input.config.ogInferenceKeyId ? input.manifest.aws.ogInference
        : keyId === input.config.ogManagementKeyId ? input.manifest.aws.ogManagement : undefined;
      if (ref === undefined) throw new Error("0G secret identity drifted.");
      return input.production.loadOgCredential(ref);
    },
    async readBillingSession(accountId) {
      return readSession(await account(accountId), { kind: "selector" });
    },
    async readBillingMeter(accountId) {
      return readMeter(await account(accountId), { kind: "selector" });
    },
    async relayPrepare(closedRequest) {
      const request = parsePrepare(closedRequest);
      const boundAccount = await input.store.getAccountByWallet(request.wallet);
      if (boundAccount === null || request.sessionGeneration !== boundAccount.sessionGeneration ||
          request.collector.toLowerCase() !== input.manifest.collector.address) {
        throw new Error("Billing relay prepare identity drifted.");
      }
      return input.production.relayPrepare({
        domain: "4lpha.billing-collection-prepare.v1",
        session: sessionRef(boundAccount),
        collector: getAddress(request.collector),
        calldata: request.calldata,
        valueWei: request.valueWei,
        maxExpiresAt: request.maxExpiresAt,
      });
    },
    relaySend: (prepared) => input.production.relaySend(prepared),
    relayStatus: (callsId) => input.production.relayStatus(callsId),
    close: () => input.production.close(),
  };

  return Object.freeze({
    primitives,
    authority,
    signX402Digest(digest) {
      return input.production.signX402({ keyArn: input.manifest.aws.x402KeyArn, digest });
    },
    async verifyBootAccounts(accounts) {
      for (const value of accounts) {
        if (value.status === "active" || value.status === "paused" || value.status === "closing") {
          // A first KMS generation is owner-visible while the account is paused,
          // before any on-chain key can truthfully be read as current.
          if (value.status === "paused" && value.sessionGeneration == null &&
              value.sessionKmsKeyArn == null && value.sessionPublicKey == null) continue;
          await readSession(value, { kind: "selector" });
        }
      }
    },
  });
}
