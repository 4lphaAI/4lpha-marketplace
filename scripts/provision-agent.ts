/**
 * Provision one agent: grant an on-chain session and persist the row the trade
 * route reads.
 *
 * This is the missing link between "the service is built" and "a trade can
 * happen". Every route in `src/server.ts` operates on an agent that already
 * exists; nothing in the service creates one, because hiring an agent is the
 * marketplace's job and it needs the OWNER'S signature, which this service never
 * holds. So provisioning is an operator script, run by a human with the owner
 * key in front of them.
 *
 * WHAT IT DOES
 *   1. resolves the owner's wallet (counterfactual on Altana — no gas);
 *   2. takes or generates the agent's session key;
 *   3. grants a session under `tradeSessionSpec()` — THE OWNER SIGNS, and this
 *      costs gas paid by the owner's wallet;
 *   4. writes the agent row plus the byte-exact `sessionFacts`, and stores the
 *      session key encrypted.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - trade, transfer, or move any value beyond the grant's own gas;
 *   - print a private key, ever — not the owner's, not the session key's;
 *   - run against the in-memory store. A row written to memory dies with this
 *     process and the server would never see it, so `DATABASE_URL` is REQUIRED
 *     and its absence is a hard error rather than a silent no-op.
 *
 * USAGE
 *   npm run provision -- --agent-id my-agent --cap-day 0.05 --tokens 0xA,0xB
 *   SPIKE_NETWORK=mainnet SPIKE_CONFIRM_MAINNET=i-understand-real-funds \
 *     npm run provision -- --agent-id my-agent --cap-day 0.05 --tokens 0xA
 *
 * `--cap-day` is the ON-CHAIN rolling daily native cap. It funds gas as well as
 * trading: the relay reimburses itself in native out of the wallet and the
 * account meters that against this cap (PHASE2.4 R6), so the off-chain budget
 * this server enforces has to be strictly smaller. `--cap-day-offchain` names
 * it; omitted, it defaults to the largest value that still leaves room for the
 * fees and for one relay reimbursement per granted token. Provisioning REFUSES
 * when the two do not fit, because the failure it prevents is an agent that
 * spends its cap on buys and then cannot sell.
 *
 * `--tokens` is the universe the agent may trade. Each address gets an
 * `approve` rule AND a per-token spend cap, and WITHOUT one the trade route
 * refuses every buy of that token — because the sell would need an `approve`
 * with no limit to meter against and would fail silently (FINDINGS (h)).
 * A token that did not exist at grant time is added later by the owner with
 * `scripts/owner-add-spend-limit.ts` (FINDINGS (i)); that script is unchanged.
 *
 * The mainnet gate is the spike's, verbatim and for the same reason:
 * `SPIKE_NETWORK` alone is one stale shell export away from spending real money.
 */
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AltanaProvider, authorityFromPrivateKey } from "../src/wallet/altana.js";
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
import {
  IS_MAINNET,
  NETWORK,
  RPC_URLS,
  UNIT,
  assertMainnetConfirmed,
} from "./spike/network.js";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

type Args = {
  readonly agentId: string;
  /**
   * Rolling daily native cap granted ON CHAIN, in whole BNB.
   *
   * This meter funds MORE than trading. The Altana relay pays the gas for every
   * submission and then reimburses itself in native out of the wallet, and the
   * account meters that reimbursement against this cap — measured at ~1.58x the
   * raw gas on a live sell. So a cap set to exactly the intended trading budget
   * runs out early, and the trade it runs out on is usually the sell: an exit
   * needs headroom here even though it spends no native (PHASE2.4 R6).
   */
  readonly capDay: string;
  /**
   * The daily cap THIS SERVER enforces off-chain, in whole BNB.
   *
   * Defaults to the largest value that leaves room for the fees and the exit
   * reserve under `--cap-day`. Supply it to be explicit; provisioning REFUSES
   * if what you supply does not fit.
   */
  readonly capDayOffChain?: string;
  /** Optional per-trade native cap, in whole BNB. */
  readonly capTrade?: string;
  /** Session lifetime in seconds. Clamped to 7 days by the template. */
  readonly ttlSec: number;
  /**
   * ERC-20s this agent may trade. Each gets an `approve` rule AND a spend cap.
   *
   * WITHOUT A TOKEN HERE THE AGENT CANNOT BUY IT — the trade route refuses a
   * buy whose token has no cap (PHASE2.3 R1), because the matching sell would
   * have no limit to meter its `approve` against and would fail silently
   * (FINDINGS (h)). May legitimately be empty for a sell-only or probe agent.
   *
   * Caller-supplied on purpose (R8). An operator may paste a curated lane from
   * the data plane here; the template never makes that market judgement itself.
   */
  readonly tokens: readonly Address[];
};

/**
 * Parse `--tokens 0xA,0xB` into checksummed addresses.
 *
 * Validated HERE rather than at the grant: a typo'd token would otherwise be
 * discovered by `validateSessionSpec` after the argument list has scrolled past,
 * or — worse — grant fine and simply never be tradeable.
 */
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

function parseArgs(argv: readonly string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      map.set(arg.slice(2), next !== undefined && !next.startsWith("--") ? next : "true");
      if (next !== undefined && !next.startsWith("--")) i += 1;
    }
  }
  const agentId = map.get("agent-id");
  if (agentId === undefined || agentId.trim() === "") {
    throw new Error("--agent-id is required.");
  }
  const capDay = map.get("cap-day") ?? "0.05";
  const ttlRaw = map.get("ttl-sec") ?? "86400";
  const ttlSec = Number.parseInt(ttlRaw, 10);
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    throw new Error("--ttl-sec must be a positive integer.");
  }
  const capTrade = map.get("cap-trade");
  const capDayOffChain = map.get("cap-day-offchain");
  return {
    agentId: agentId.trim(),
    capDay,
    ttlSec,
    tokens: parseTokens(map.get("tokens")),
    ...(capTrade === undefined ? {} : { capTrade }),
    ...(capDayOffChain === undefined ? {} : { capDayOffChain }),
  };
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The owner key, from the operator's own file.
 *
 * NEVER generated. A silently generated stand-in would produce a session grant
 * for a wallet nobody funded and nobody controls, which looks like success right
 * up until the first trade.
 */
function ownerKey(): Hex {
  const varName = IS_MAINNET
    ? (readEnvValue("SPIKE_OWNER_KEY_VAR") ?? "USER1_PRIVATE_KEY")
    : (readEnvValue("SPIKE_OWNER_KEY_VAR") ?? "OWNER_TEST_KEY");
  const value = readEnvValue(varName);
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `No owner key: ${varName} is unset. Put it in .env.local; this script never generates one.`,
    );
  }
  return value.trim() as Hex;
}

/**
 * The agent's session key, generated on first use and persisted to `.env`.
 *
 * Persisted because the grant delegates to THIS key: lose it and the session is
 * unusable (though the owner can still revoke it), and re-granting costs gas.
 * `writeEnvValue` refuses to overwrite an existing value without an explicit
 * `SPIKE_ROTATE_KEY`, for the same reason.
 */
function sessionKeyFor(agentId: string): { key: Hex; varName: string; generated: boolean } {
  const varName = `AGENT_SESSION_KEY_${agentId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const existing = readEnvValue(varName);
  if (existing !== undefined && existing.trim() !== "") {
    return { key: existing.trim() as Hex, varName, generated: false };
  }
  const key = generatePrivateKey();
  writeEnvValue(varName, key);
  return { key, varName, generated: true };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (IS_MAINNET) assertMainnetConfirmed();

  // A row in the memory store dies with this process; the server would never
  // see it. Refuse rather than report a success the service cannot observe.
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

  // Built by name so an unset override is ABSENT rather than `undefined` —
  // `exactOptionalPropertyTypes` draws that distinction, and so does the
  // validator: an absent override falls back to the chain default, while an
  // explicitly-undefined one would not typecheck at all.
  const overrides: Record<string, string> = {};
  for (const [key, name] of [
    ["pancakeRouterV2", "VENUE_PANCAKE_ROUTER"],
    ["pancakeRouterV3", "VENUE_PANCAKE_ROUTER_V3"],
    ["wbnb", "VENUE_WBNB"],
    ["fourMemeHelper", "VENUE_FOURMEME_HELPER"],
  ] as const) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value !== "") overrides[key] = value;
  }

  const venues = resolveVenues({
    chainId: NETWORK.chainId,
    overrides,
    keyStore: NETWORK.keyStore as Address,
  });

  const treasuryRaw = process.env["FEE_TREASURY_ADDRESS"]?.trim();
  const nowSeconds = Math.floor(Date.now() / 1000);

  // NATIVE caps, and a list rather than one value: the rolling day cap is the
  // agent's real budget, and `--cap-trade` adds a per-trade ceiling on top of
  // it. Per-token caps are NOT here — they come from `--tokens`, which grants
  // the matching `approve` rule at the same time (PHASE2.3 R6).
  const onChainDailyCapWei = parseEther(args.capDay);
  const nativeCaps = [
    { limit: onChainDailyCapWei, period: "day" as const },
    ...(args.capTrade === undefined
      ? []
      : [{ limit: parseEther(args.capTrade), period: "minute" as const }]),
  ];

  // THE SIZING INVARIANT (PHASE2.4 R6). Refused, not warned about: the failure
  // it prevents is an agent that spends its on-chain native cap on buys and then
  // cannot sell, because the relay's gas reimbursement is metered against the
  // same cap the exit needs. Three layers have warned about this family of
  // failure and shipped it anyway.
  const feeBpsRaw = process.env["FEE_BPS"]?.trim();
  const feeBps =
    feeBpsRaw === undefined || feeBpsRaw === "" ? 0 : Number.parseInt(feeBpsRaw, 10);
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error("FEE_BPS must be a non-negative integer number of basis points.");
  }
  const sizing = { feeBps, grantedTokenCount: args.tokens.length };
  const defaultOffChain = maxOffChainDailyCapWei({ onChainDailyCapWei, ...sizing });
  if (args.capDayOffChain === undefined && defaultOffChain === null) {
    throw new Error(
      `--cap-day ${args.capDay} ${UNIT} does not even cover the exit reserve of ` +
        `${exitReserveWei(args.tokens.length)} wei. Raise it: with no headroom for the ` +
        `relay's gas reimbursement, this agent could open positions it can never close.`,
    );
  }
  const offChainDailyCapWei =
    args.capDayOffChain === undefined
      ? (defaultOffChain as bigint)
      : parseEther(args.capDayOffChain);
  const sized = checkNativeCapSizing({
    onChainDailyCapWei,
    offChainDailyCapWei,
    ...sizing,
  });
  if (!sized.ok) throw new Error(sized.message);

  const spec = tradeSessionSpec({
    venues,
    ...(treasuryRaw === undefined || treasuryRaw === ""
      ? {}
      : { treasury: treasuryRaw as Address }),
    tokens: args.tokens.map((token) => ({ token })),
    nativeCaps,
    expiresAt: nowSeconds + args.ttlSec,
    nowSeconds,
  });

  const provider = new AltanaProvider({ network: NETWORK, rpcUrls: RPC_URLS });
  const owner = authorityFromPrivateKey(ownerKey());
  const wallet = await provider.resolveOwnerWallet({ owner });

  const balance = await provider.getBalance({ address: wallet.address });
  console.log(`network        : ${NETWORK.chainId} (${IS_MAINNET ? "MAINNET" : "testnet"})`);
  console.log(`owner wallet   : ${wallet.address}`);
  console.log(`balance        : ${balance} wei ${UNIT}`);
  console.log(`agent id       : ${args.agentId}`);
  console.log(`session expires: ${new Date(spec.expiresAt * 1000).toISOString()}`);
  console.log(`allowlist      : ${spec.allowedCalls.length} rules`);
  for (const rule of spec.allowedCalls) {
    console.log(`  - ${rule.to ?? "(any target)"}${rule.selector ? ` :: ${rule.selector}` : ""}`);
  }
  console.log(
    `native caps    : ${nativeCaps.map((c) => `${c.limit} wei/${c.period}`).join(", ")}`,
  );
  // All four terms of the sizing invariant, printed whether or not it was the
  // operator who chose the off-chain number. The relay's reimbursement is the
  // term nobody expects, so it is named rather than folded into a total.
  console.log(
    `budget split   : on-chain ${onChainDailyCapWei} wei/day = off-chain ` +
      `${offChainDailyCapWei} + fee ${(offChainDailyCapWei * BigInt(feeBps)) / 10_000n} ` +
      `(${feeBps}bps) + exit reserve ${exitReserveWei(args.tokens.length)} ` +
      `(${Math.max(1, args.tokens.length)} x relay gas reimbursement) + headroom`,
  );
  // Same caveat, same reason (PHASE2.4 audit A1-P): the reserve counts TOKENS
  // and the relay counts SUBMISSIONS, so this is a floor and not a promise.
  console.log(
    `                 the reserve covers ~one exit per granted token and nothing for ` +
      `the buys' own reimbursements — a floor, not a guarantee.`,
  );
  // Printed even when empty, and loudly: an operator who forgot `--tokens` has
  // provisioned an agent that cannot buy anything, and should find that out
  // here rather than from a 400 on the first trade.
  console.log(
    `tradeable      : ${
      args.tokens.length === 0
        ? "(none) — every BUY will be refused; pass --tokens 0x...,0x..."
        : args.tokens.join(", ")
    }`,
  );
  console.log(
    `token caps     : ${args.tokens.length} x gate (2^160/day) — the spend budget is the native cap`,
  );

  if (balance === 0n) {
    console.error(
      `\nRefusing to grant: ${wallet.address} holds no ${UNIT}. ` +
        `The grant costs gas paid by this wallet. Fund it and re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  const session = sessionKeyFor(args.agentId);
  const agentAuthority = authorityFromPrivateKey(session.key);
  console.log(
    `session key    : ${privateKeyToAccount(session.key).address} ` +
      `(${session.generated ? "generated, saved to .env as" : "reused from"} ${session.varName})`,
  );

  console.log("\ngranting the session — this signs with the OWNER key and costs gas...");
  const granted = await provider.grantSession({
    wallet,
    owner,
    spec,
    agent: agentAuthority,
  });
  console.log(`granted        : publicKey ${granted.publicKey}`);

  const store = await createAgentStore();
  try {
    const record = await store.createAgent({
      httpRuntimeProfile: "trade-v1",
      id: args.agentId,
      ownerAddress: wallet.ownerAddress,
      walletAddress: wallet.address,
      custodyModel: wallet.custodyModel,
      // The off-chain half of the invariant checked above, persisted so the
      // route's `exceedsDailyCap` actually enforces the number provisioning
      // sized against. Written here rather than left to `change-budget`: an
      // agent with no off-chain cap is unbounded off-chain, which is the state
      // the sizing check exists to make impossible.
      caps: { dailyNativeWei: offChainDailyCapWei },
      // The canonical permissions are stored alongside the spec so a mismatch
      // between a re-derived shape and the granted one is detectable rather
      // than silent — `restoreSession` needs them byte-exact.
      sessionFacts: {
        spec,
        permissions: validateSessionSpec(spec),
        publicKey: granted.publicKey,
        expiry: spec.expiresAt,
      },
      status: "armed",
    });
    await store.putAgentSessionKey(record.ownerAddress, record.id, session.key);
    console.log(`\npersisted      : agent "${record.id}" owner ${record.ownerAddress} status ${record.status}`);
  } finally {
    await store.close();
  }

  console.log(
    `\nDone. The service can now serve POST /agents/${args.agentId}/trade ` +
      `until ${new Date(spec.expiresAt * 1000).toISOString()}.`,
  );
}

main().catch((error: unknown) => {
  // Never dump the error object: a provider error can carry request bodies.
  console.error(`\nprovision failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
