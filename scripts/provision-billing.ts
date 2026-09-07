/**
 * Preview or explicitly provision the account-wide Phase 5 billing session.
 *
 * Preview is the default and loads no owner/session key. `--yes-live` is the
 * only path that constructs authorities, grants the on-chain session, or
 * persists the encrypted platform session key.
 */
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { AltanaProvider, authorityFromPrivateKey } from "../src/wallet/altana.js";
import { BILLING_THRESHOLD_USD_MICROS } from "../src/billing/config.js";
import { createBillingStore } from "../src/billing/postgres.js";
import { billingAccountId } from "../src/billing/serviceSession.js";
import { billingSessionSpec } from "../src/billing/sessionPolicy.js";
import { encryptSecret, loadMasterKey } from "../src/store/crypto.js";
import { validateSessionSpec } from "../src/core/session.js";
import { readEnvValue } from "./spike/env.js";
import {
  IS_MAINNET,
  NETWORK,
  RPC_URLS,
  assertMainnetConfirmed,
} from "./spike/network.js";

type Args = Readonly<{
  owner: Address;
  wallet: Address;
  capDay: string;
  ttlSec: number;
  maxDailyUsdMicros: bigint;
  maxUnpaidUsdMicros: bigint;
  yesLive: boolean;
}>;

const VALUE_FLAGS = new Set([
  "owner", "wallet", "cap-day", "ttl-sec", "max-daily-usd-micros",
  "max-unpaid-usd-micros",
]);

function canonicalPositive(raw: string, name: string): bigint {
  if (!/^[1-9][0-9]{0,17}$/.test(raw)) {
    throw new Error(`--${name} must be a positive canonical decimal integer.`);
  }
  return BigInt(raw);
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let yesLive = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--yes-live") {
      if (yesLive) throw new Error("--yes-live may occur only once.");
      yesLive = true;
      continue;
    }
    if (raw === undefined || !raw.startsWith("--")) throw new Error(`Unknown argument: ${raw ?? ""}`);
    const separator = raw.indexOf("=");
    const name = separator > 0 ? raw.slice(2, separator) : raw.slice(2);
    if (!VALUE_FLAGS.has(name) || values.has(name)) throw new Error(`Unknown or duplicate argument: --${name}`);
    const value = separator > 0 ? raw.slice(separator + 1) : argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`--${name} requires a value.`);
    values.set(name, value);
    if (separator < 0) index += 1;
  }
  const ownerRaw = values.get("owner") ?? "";
  const walletRaw = values.get("wallet") ?? "";
  if (!isAddress(ownerRaw, { strict: false }) || !isAddress(walletRaw, { strict: false })) {
    throw new Error("--owner and --wallet must be valid EVM addresses.");
  }
  const ttlSec = Number(values.get("ttl-sec") ?? "604800");
  if (!Number.isSafeInteger(ttlSec) || ttlSec < 1 || ttlSec > 604800) {
    throw new Error("--ttl-sec must be an integer from 1 through 604800.");
  }
  const maxDailyUsdMicros = canonicalPositive(
    values.get("max-daily-usd-micros") ?? "10000000",
    "max-daily-usd-micros",
  );
  const maxUnpaidUsdMicros = canonicalPositive(
    values.get("max-unpaid-usd-micros") ?? "1000000",
    "max-unpaid-usd-micros",
  );
  if (maxUnpaidUsdMicros > maxDailyUsdMicros || maxDailyUsdMicros > 100_000_000n) {
    throw new Error("Billing USD limits exceed the reviewed account bounds.");
  }
  return {
    owner: getAddress(ownerRaw),
    wallet: getAddress(walletRaw),
    capDay: values.get("cap-day") ?? "0.01",
    ttlSec,
    maxDailyUsdMicros,
    maxUnpaidUsdMicros,
    yesLive,
  };
}

function requiredAddress(name: string): Address {
  const raw = readEnvValue(name)?.trim() ?? "";
  if (!isAddress(raw, { strict: false })) throw new Error(`${name} must be a valid EVM address.`);
  return getAddress(raw);
}

function ownerKey(): Hex {
  const variable = readEnvValue("SPIKE_OWNER_KEY_VAR") ??
    (IS_MAINNET ? "USER1_PRIVATE_KEY" : "OWNER_TEST_KEY");
  const key = readEnvValue(variable)?.trim();
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${variable} must hold the explicitly selected owner private key.`);
  }
  return key as Hex;
}

function canonicalSessionFacts(input: Readonly<{
  spec: ReturnType<typeof billingSessionSpec>;
  permissions: ReturnType<typeof validateSessionSpec>;
  publicKey: Hex;
}>): string {
  const bytes = JSON.stringify({
    version: "billing-session-facts-v1",
    spec: input.spec,
    permissions: input.permissions,
    publicKey: input.publicKey.toLowerCase(),
    expiry: input.spec.expiresAt,
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value);
  return Buffer.from(bytes, "utf8").toString("base64");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = Math.floor(Date.now() / 1_000);
  const collector = requiredAddress("BILLING_COLLECTOR_ADDRESS");
  const treasury = requiredAddress("BILLING_TREASURY_ADDRESS");
  const dayCapWei = parseEther(args.capDay);
  const spec = billingSessionSpec({
    collector,
    treasury,
    wallet: args.wallet,
    keyStore: getAddress(NETWORK.keyStore),
    dayCapWei,
    now,
    expiresAt: now + args.ttlSec,
  });
  const accountId = billingAccountId(args.owner, args.wallet);
  const preview = {
    mode: args.yesLive ? "LIVE" : "PREVIEW",
    chainId: NETWORK.chainId,
    accountId,
    ownerAddress: args.owner.toLowerCase(),
    walletAddress: args.wallet.toLowerCase(),
    session: {
      allowedCalls: spec.allowedCalls,
      spendCaps: spec.spendCaps.map((cap) => ({ limit: cap.limit.toString(10), period: cap.period })),
      expiresAt: spec.expiresAt,
    },
    accountLimits: {
      maxDailyUsdMicros: args.maxDailyUsdMicros.toString(10),
      maxUnpaidExposureUsdMicros: args.maxUnpaidUsdMicros.toString(10),
      thresholdUsdMicros: BILLING_THRESHOLD_USD_MICROS.toString(10),
    },
  };
  console.log(JSON.stringify(preview, null, 2));
  if (!args.yesLive) {
    console.log("Preview only: no key loaded, no network call, no signature, and no persistence.");
    return;
  }

  if (IS_MAINNET) assertMainnetConfirmed();
  if ((process.env["DATABASE_URL"] ?? "").trim() === "") {
    throw new Error("DATABASE_URL is required for live billing provisioning.");
  }
  const masterKey = loadMasterKey(process.env);
  if (masterKey === null) throw new Error("EXECUTION_MASTER_KEY is required for live billing provisioning.");

  const store = await createBillingStore(process.env);
  try {
    if (await store.getAccountByWallet(args.wallet) !== null) {
      throw new Error("This wallet already has a permanent Phase 5 billing identity.");
    }
    const provider = new AltanaProvider({ network: NETWORK, rpcUrls: RPC_URLS });
    const owner = authorityFromPrivateKey(ownerKey());
    if (owner.address.toLowerCase() !== args.owner.toLowerCase()) {
      throw new Error("The selected owner key does not match --owner.");
    }
    const wallet = await provider.resolveOwnerWallet({ owner });
    if (wallet.address.toLowerCase() !== args.wallet.toLowerCase()) {
      throw new Error("Altana resolved a wallet different from --wallet.");
    }
    if (await provider.getBalance({ address: wallet.address }) === 0n) {
      throw new Error("The Altana wallet has no native balance to pay the session-grant transaction.");
    }

    const sessionPrivateKey = generatePrivateKey();
    const sessionAuthority = authorityFromPrivateKey(sessionPrivateKey);
    const granted = await provider.grantSession({ wallet, owner, spec, agent: sessionAuthority });
    const permissions = validateSessionSpec(spec, {
      walletAddress: wallet.address,
      keyStoreAddress: NETWORK.keyStore,
    });
    await store.createAccount({
      accountId,
      ownerAddress: args.owner.toLowerCase(),
      walletAddress: args.wallet.toLowerCase(),
      status: "active",
      sessionFactsBytes: canonicalSessionFacts({ spec, permissions, publicKey: granted.publicKey }),
      encryptedSessionKey: encryptSecret(sessionPrivateKey, masterKey),
      maxDailyUsdMicros: args.maxDailyUsdMicros,
      maxUnpaidExposureUsdMicros: args.maxUnpaidUsdMicros,
      thresholdUsdMicros: BILLING_THRESHOLD_USD_MICROS,
      grantExpiresAt: spec.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    console.log(JSON.stringify({ accountId, status: "active", sessionPublicKey: granted.publicKey }));
  } finally {
    await store.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Billing provisioning failed.");
  process.exitCode = 1;
});
