/**
 * Register one agent whose owner is a PASSKEY and whose session was granted
 * SOMEWHERE ELSE.
 *
 * This is the row-creation seam Phase 1.5 needs, and without it the phase would
 * ship a verifier that authenticates passkey owners correctly and zero agent rows
 * it can ever match — every passkey owner action answered with the same generic
 * failure a forgery gets.
 *
 * WHY IT CANNOT BE `provision-agent.ts`. That script derives the owner from a
 * raw private key and gets its wallet from `resolveOwnerWallet`, which hardcodes
 * `ownerAddress = owner EOA` and `custodyModel: "self-eoa"` — both of the fields
 * that must vary here. Worse, its actual job is to GRANT the session on chain,
 * and for a passkey owner that grant must be signed by the passkey in the
 * browser (marketplace UI + Altana SDK), which this repo never sees.
 *
 * WHAT IT DOES
 *   1. derives `ownerAddress` from the credential public key `(x, y)` through
 *      the SHARED derivation — never typed by hand, because that address is the
 *      tenancy key and a hand-typed one silently orphans the row;
 *   2. rebuilds the session spec the UI granted, from the SAME `tradeSessionSpec`
 *      template and the granted `--expires-at`;
 *   3. runs the sizing invariant with the same refusal semantics as the EOA path;
 *   4. writes the row with `custodyModel: "passkey"` and stores the session key
 *      encrypted.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - NO on-chain grant, no transaction, no gas, no RPC. It never constructs a
 *     provider and never calls `resolveOwnerWallet`.
 *   - NO owner private key. There isn't one: a passkey owner's `ownerAddress` is
 *     an off-chain IDENTITY with no secp256k1 key behind it, and funds sent to
 *     it are burned. See the invariant on `AgentWalletRef.ownerAddress`.
 *   - NO session-key generation. The session was already granted to a specific
 *     key; minting a new one here would produce a row this service can never
 *     execute with. Use `--emit-session-key` FIRST (step 0 below).
 *   - NO in-memory store. A row written to memory dies with this process.
 *
 * USAGE
 *   # step 0, once, BEFORE the marketplace grants anything: mint the agent's
 *   # session key and print what the UI must delegate to.
 *   npm run register-passkey -- --agent-id my-agent --emit-session-key
 *
 *   # step 1, after the owner has signed the grant in the browser:
 *   npm run register-passkey -- --agent-id my-agent \
 *     --pubkey-x 0x... --pubkey-y 0x... \
 *     --wallet-address 0x... --session-public-key 0x04... \
 *     --expires-at 1893456000 --cap-day 0.05 --tokens 0xA,0xB
 */
import { getAddress, isAddress, isHex, parseEther, size, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { publicKeyToAddress } from "viem/utils";
import { passkeyOwnerAddress } from "../src/auth/webauthnEnvelope.js";
import { createAgentStore } from "../src/store/agents.js";
import {
  checkNativeCapSizing,
  exitReserveWei,
  maxOffChainDailyCapWei,
  tradeSessionSpec,
} from "../src/ops/policy.js";
import { resolveVenues } from "../src/ops/venues.js";
import { validateSessionSpec } from "../src/core/session.js";
import { readEnvValue, writeEnvValue } from "./spike/env.js";
import { IS_MAINNET, NETWORK, UNIT } from "./spike/network.js";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    map.set(arg.slice(2), next !== undefined && !next.startsWith("--") ? next : "true");
    if (next !== undefined && !next.startsWith("--")) i += 1;
  }
  return map;
}

function required(map: Map<string, string>, name: string): string {
  const value = map.get(name)?.trim();
  if (value === undefined || value === "" || value === "true") {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

/** A bytes32 coordinate, validated here so a truncated paste cannot become an owner. */
function readCoordinate(map: Map<string, string>, name: string): Hex {
  const raw = required(map, name);
  if (!isHex(raw) || size(raw) !== 32) {
    throw new Error(`--${name} must be a 0x-prefixed 32-byte hex value.`);
  }
  return raw;
}

function readAddressArg(map: Map<string, string>, name: string): Address {
  const raw = required(map, name);
  if (!isAddress(raw)) throw new Error(`--${name} is not a valid address.`);
  return getAddress(raw);
}

/** Parse `--tokens 0xA,0xB` into checksummed addresses. Same rules as provisioning. */
function parseTokens(raw: string | undefined): readonly Address[] {
  if (raw === undefined || raw.trim() === "" || raw === "true") return [];
  const seen = new Set<string>();
  const tokens: Address[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    if (!isAddress(value)) {
      throw new Error(`--tokens contains "${value}", which is not a valid address.`);
    }
    const address = getAddress(value);
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    tokens.push(address);
  }
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                       */
/* -------------------------------------------------------------------------- */

function sessionKeyVarName(agentId: string): string {
  return `AGENT_SESSION_KEY_${agentId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * The agent's session key — REQUIRED to already exist, never generated here.
 *
 * The grant this row records was signed against ONE specific key. Generating a
 * fresh one at registration time would persist a row whose session key the chain
 * has never heard of: every execute would be refused by the account contract,
 * and the symptom would be a policy rejection rather than anything naming the
 * mistake.
 */
function existingSessionKey(agentId: string): { key: Hex; varName: string } {
  const varName = sessionKeyVarName(agentId);
  const existing = readEnvValue(varName);
  if (existing === undefined || existing.trim() === "") {
    throw new Error(
      `No session key: ${varName} is unset. The session was granted to a key this ` +
        `service must already hold — run with --emit-session-key first, hand the ` +
        `printed public key to the marketplace UI, grant, then re-run this.`,
    );
  }
  return { key: existing.trim() as Hex, varName };
}

/** Step 0: mint the key the UI will delegate to, print it, write nothing else. */
function emitSessionKey(agentId: string): void {
  const varName = sessionKeyVarName(agentId);
  const existing = readEnvValue(varName);
  const key = existing !== undefined && existing.trim() !== "" ? (existing.trim() as Hex) : generatePrivateKey();
  if (existing === undefined || existing.trim() === "") {
    // `writeEnvValue` refuses to overwrite without an explicit rotate flag, for
    // the same reason provisioning does: losing this key makes the granted
    // session unusable, and re-granting costs the owner gas.
    writeEnvValue(varName, key);
  }
  const account = privateKeyToAccount(key);
  console.log(`agent id           : ${agentId}`);
  console.log(`session key var    : ${varName} (${existing === undefined ? "generated" : "reused"})`);
  console.log(`session address    : ${account.address}`);
  console.log(`session public key : ${account.publicKey}`);
  console.log(
    `\nHand the PUBLIC key to the marketplace UI and let the owner sign the grant ` +
      `with their passkey. The private key never leaves this machine. Then re-run ` +
      `with --pubkey-x/--pubkey-y/--wallet-address/--session-public-key/--expires-at.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const agentId = required(args, "agent-id");

  if (args.get("emit-session-key") === "true") {
    emitSessionKey(agentId);
    return;
  }

  // There is no mainnet confirmation gate here, and its ABSENCE is deliberate:
  // this script sends no transaction and spends nothing. The network still
  // decides the venue addresses baked into the spec, so it is printed loudly.
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required: an agent written to the in-memory store would " +
        "vanish when this script exits, and the running service would still 404.",
    );
  }
  if ((process.env["EXECUTION_MASTER_KEY"] ?? "").trim() === "") {
    throw new Error(
      "EXECUTION_MASTER_KEY is required: the Postgres store refuses to persist a " +
        "session key without encryption configured.",
    );
  }

  const x = readCoordinate(args, "pubkey-x");
  const y = readCoordinate(args, "pubkey-y");
  // DERIVED, never typed. This address is the tenancy key for every owner-scoped
  // query, and the verifier derives the same value from the same credential on
  // every request — so it must come from the same function, not from a paste.
  const ownerAddress = passkeyOwnerAddress(x, y);

  const walletAddress = readAddressArg(args, "wallet-address");
  if (getAddress(walletAddress) === ownerAddress) {
    // FINDINGS (a): a passkey wallet's address belongs to a discarded throwaway
    // EOA and is never the derived identity. Equality here means somebody pasted
    // the owner address into `--wallet-address`, which would make every execute
    // target the wrong account.
    throw new Error(
      "--wallet-address equals the derived owner identity. Under passkey custody " +
        "these are never the same address; check which value was pasted.",
    );
  }

  const sessionPublicKey = required(args, "session-public-key");
  if (!isHex(sessionPublicKey) || size(sessionPublicKey) !== 65) {
    throw new Error(
      "--session-public-key must be the uncompressed SEC1 public key (0x04 + 64 bytes).",
    );
  }
  const expiresAtRaw = required(args, "expires-at");
  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("--expires-at must be the granted session's unix expiry in SECONDS.");
  }

  const session = existingSessionKey(agentId);
  const sessionAccount = privateKeyToAccount(session.key);
  // The one consistency check that keeps this seam from writing a row the chain
  // disagrees with: the key we hold must be the key that was granted.
  if (
    getAddress(publicKeyToAddress(sessionPublicKey)) !==
    getAddress(sessionAccount.address)
  ) {
    throw new Error(
      `--session-public-key does not belong to the key in ${session.varName}. ` +
        "This row would be unable to execute anything the chain granted.",
    );
  }

  const overrides: Record<string, string> = {};
  for (const [key, name] of [
    ["pancakeRouterV2", "VENUE_PANCAKE_ROUTER"],
    ["pancakeRouterV3", "VENUE_PANCAKE_ROUTER_V3"],
    ["wbnb", "VENUE_WBNB"],
    ["fourMemeHelper", "VENUE_FOURMEME_HELPER"],
    ["flapPortal", "VENUE_FLAP_PORTAL"],
  ] as const) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value !== "") overrides[key] = value;
  }
  const venues = resolveVenues({
    chainId: NETWORK.chainId,
    overrides,
    keyStore: NETWORK.keyStore as Address,
  });

  const tokens = parseTokens(args.get("tokens"));
  const onChainDailyCapWei = parseEther(args.get("cap-day")?.trim() ?? "0.05");
  const capTrade = args.get("cap-trade")?.trim();
  const nativeCaps = [
    { limit: onChainDailyCapWei, period: "day" as const },
    ...(capTrade === undefined || capTrade === "" || capTrade === "true"
      ? []
      : [{ limit: parseEther(capTrade), period: "minute" as const }]),
  ];

  // THE SIZING INVARIANT (PHASE2.4 R6), with the SAME refusal semantics as the
  // EOA path — it is a property of the granted session, not of how the owner
  // holds their key. The relay reimburses its gas out of the same on-chain
  // native meter an exit needs, so an under-sized cap produces an agent that can
  // open positions it can never close.
  const feeBpsRaw = process.env["FEE_BPS"]?.trim();
  const feeBps =
    feeBpsRaw === undefined || feeBpsRaw === "" ? 0 : Number.parseInt(feeBpsRaw, 10);
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error("FEE_BPS must be a non-negative integer number of basis points.");
  }
  const sizing = { feeBps, grantedTokenCount: tokens.length };
  const capDayOffChain = args.get("cap-day-offchain")?.trim();
  const defaultOffChain = maxOffChainDailyCapWei({ onChainDailyCapWei, ...sizing });
  if ((capDayOffChain === undefined || capDayOffChain === "") && defaultOffChain === null) {
    throw new Error(
      `--cap-day does not even cover the exit reserve of ${exitReserveWei(tokens.length)} wei. ` +
        "Raise it: with no headroom for the relay's gas reimbursement, this agent " +
        "could open positions it can never close.",
    );
  }
  const offChainDailyCapWei =
    capDayOffChain === undefined || capDayOffChain === "" || capDayOffChain === "true"
      ? (defaultOffChain as bigint)
      : parseEther(capDayOffChain);
  const sized = checkNativeCapSizing({
    onChainDailyCapWei,
    offChainDailyCapWei,
    ...sizing,
  });
  if (!sized.ok) throw new Error(sized.message);

  const treasuryRaw = process.env["FEE_TREASURY_ADDRESS"]?.trim();
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Rebuilt from the SAME template the UI was told to grant, with the granted
  // expiry supplied rather than re-derived from a ttl: `sessionFacts` is what
  // `restoreSession` replays to the relay, so it has to be the granted shape.
  const spec = tradeSessionSpec({
    venues,
    ...(treasuryRaw === undefined || treasuryRaw === ""
      ? {}
      : { treasury: treasuryRaw as Address }),
    tokens: tokens.map((token) => ({ token })),
    nativeCaps,
    expiresAt,
    nowSeconds,
  });
  if (spec.expiresAt !== expiresAt) {
    // The template clamps to `MAX_TRADE_SESSION_SECONDS`. A clamp here means the
    // spec we would persist is NOT the spec that was granted.
    throw new Error(
      `--expires-at ${expiresAt} was clamped to ${spec.expiresAt} by the session ` +
        "template; the persisted spec would not match the granted one.",
    );
  }

  console.log(`network        : ${NETWORK.chainId} (${IS_MAINNET ? "MAINNET" : "testnet"})`);
  console.log(`custody        : passkey (WebAuthn/P-256)`);
  console.log(`owner identity : ${ownerAddress}  <- DERIVED from the credential key`);
  console.log(
    `                 NOT an account: no secp256k1 key exists for it and funds sent there are burned.`,
  );
  console.log(`wallet         : ${walletAddress}`);
  console.log(`agent id       : ${agentId}`);
  console.log(`session expires: ${new Date(spec.expiresAt * 1000).toISOString()}`);
  console.log(`session key    : ${sessionAccount.address} (from ${session.varName})`);
  console.log(`allowlist      : ${spec.allowedCalls.length} rules`);
  for (const rule of spec.allowedCalls) {
    console.log(`  - ${rule.to ?? "(any target)"}${rule.selector ? ` :: ${rule.selector}` : ""}`);
  }
  console.log(
    `native caps    : ${nativeCaps.map((c) => `${c.limit} wei/${c.period}`).join(", ")} ${UNIT}`,
  );
  console.log(
    `budget split   : on-chain ${onChainDailyCapWei} wei/day = off-chain ` +
      `${offChainDailyCapWei} + fee ${(offChainDailyCapWei * BigInt(feeBps)) / 10_000n} ` +
      `(${feeBps}bps) + exit reserve ${exitReserveWei(tokens.length)} ` +
      `(${Math.max(1, tokens.length)} x relay gas reimbursement) + headroom`,
  );
  // Same caveat, same reason (PHASE2.4 audit A1-P): the reserve counts TOKENS
  // and the relay counts SUBMISSIONS, so this is a floor and not a promise.
  console.log(
    `                 the reserve covers ~one exit per granted token and nothing for ` +
      `the buys' own reimbursements — a floor, not a guarantee.`,
  );
  console.log(
    `tradeable      : ${
      tokens.length === 0
        ? "(none) — every BUY will be refused; pass --tokens 0x...,0x..."
        : tokens.join(", ")
    }`,
  );

  const store = await createAgentStore();
  try {
    const record = await store.createAgent({
      httpRuntimeProfile: "trade-v1",
      id: agentId,
      ownerAddress,
      walletAddress,
      // NEVER `self-eoa` for a P256-derived owner. The row is what every later
      // custody decision reads, and `ownerRecoverNative` refuses on this field.
      custodyModel: "passkey",
      caps: { dailyNativeWei: offChainDailyCapWei },
      sessionFacts: {
        spec,
        permissions: validateSessionSpec(spec),
        publicKey: sessionPublicKey,
        expiry: spec.expiresAt,
      },
      status: "armed",
    });
    await store.putAgentSessionKey(record.ownerAddress, record.id, session.key);
    console.log(
      `\npersisted      : agent "${record.id}" owner ${record.ownerAddress} status ${record.status}`,
    );
  } finally {
    await store.close();
  }

  console.log(
    `\nDone. The owner can now sign owner actions with their passkey, and the ` +
      `service can serve POST /agents/${agentId}/trade until ` +
      `${new Date(spec.expiresAt * 1000).toISOString()}.`,
  );
}

main().catch((error: unknown) => {
  // Never dump the error object: it can carry request bodies.
  console.error(
    `\nregister-passkey-agent failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
