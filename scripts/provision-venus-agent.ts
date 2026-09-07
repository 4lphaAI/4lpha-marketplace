/**
 * Provision one Venus guard agent: grant an on-chain session under
 * `venusSessionSpec()` and persist the row the worker reads (PHASE4-SPEC D10).
 *
 * The `provision-agent` shape, with three additions this phase requires:
 *
 *   1. **The routing census is re-read and the grant REFUSES on any move**
 *      (R3.12). The Core Comptroller is a Diamond and the vToken
 *      implementations are proxies, so a governance re-cut lands under a live
 *      `CallRule` and changes what a granted selector DOES. The grant pins
 *      selector+target, never semantics — so the only defence at grant time is
 *      to check the routing has not moved since the recorded census.
 *   2. **Per-token caps are SIZED, never defaulted** (R2.1). `--token-cap`
 *      is REQUIRED per granted underlying and `DEFAULT_TOKEN_CAP_LIMIT` is
 *      refused by name: a Venus token cap is the ONLY bound on a leaked
 *      session key's `approve`-spender drain, so it is a BUDGET, not a gate.
 *   3. **The exposure PRODUCT is printed**, `cap x periods`, never the
 *      per-period rate alone (FINDINGS (r), restated by R3.2). Under the 7-day
 *      ceiling a 0.05 BNB/day cap is 0.35 BNB of exposure, and the rate on its
 *      own is the number that hid that.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: repay, supply, claim, or move any value
 * beyond the grant's own gas; print a private key; run against the in-memory
 * store; or arm the guard — the owner-signed `POST /agents/:id/venus/settings`
 * does that, and it is where the tracking PUT is issued from.
 *
 * USAGE
 *   npm run provision-venus -- --agent-id guard-1 --cap-day 0.05 \
 *     --markets 0xvUSDT,0xvBNB --token-cap 0xUSDT=100 --ttl-sec 604800
 *
 * REVISION 4 (FINDINGS (at)): naming vBNB in --markets grants REPAY-ONLY —
 * the template no longer emits mint() on the native market, because an
 * EIP-7702 wallet cannot receive vBNB's 2300-gas .transfer() payout and a
 * native supply mints a one-way position. BNB-side COLLATERAL goes through
 * vWBNB (0x6bCa74586218db34cDB402295796b79663d816e9) as an ordinary ERC-20
 * market: --markets ...,0xvWBNB --token-cap 0xWBNB=<amount>.
 *   SPIKE_NETWORK=mainnet SPIKE_CONFIRM_MAINNET=i-understand-real-funds \
 *     npm run provision-venus -- ...
 */
import {
  getAddress,
  isAddress,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AltanaProvider, authorityFromPrivateKey } from "../src/wallet/altana.js";
import { createAgentStore } from "../src/store/agents.js";
import {
  DEFAULT_VENUS_RESCUE_RESERVE_COUNT,
  MAX_VENUS_SESSION_SECONDS,
  VENUS_GRANTED_SELECTORS,
  VENUS_REFUSED_SELECTORS,
  checkVenusNativeCapSizing,
  venusExposureProduct,
  venusSessionSpec,
  type VenusTokenGrant,
} from "../src/ops/policy.js";
import { validateSessionSpec } from "../src/core/session.js";
import {
  resolveVenusEnabled,
  resolveVenusVenue,
} from "../src/ops/config.js";
import {
  createVenusChainReaders,
  resolveVenusRpcUrls,
} from "../src/venus/readers.js";
import { VENUS_VTOKEN_ABI } from "../src/venus/abis.js";
import { readEnvValue, writeEnvValue } from "./spike/env.js";
import {
  IS_MAINNET,
  NETWORK,
  RPC_URLS,
  UNIT,
  assertMainnetConfirmed,
} from "./spike/network.js";
import { createPublicClient, http } from "viem";

type Args = {
  readonly agentId: string;
  readonly capDay: string;
  readonly markets: readonly Address[];
  /** underlying address -> cap, in the token's own units. */
  readonly tokenCaps: ReadonlyMap<string, string>;
  readonly ttlSec: number;
};

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry === undefined || !entry.startsWith("--")) continue;
    const eq = entry.indexOf("=");
    if (eq > 0) {
      values.set(entry.slice(2, eq), entry.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(entry.slice(2), next);
      i += 1;
    } else {
      values.set(entry.slice(2), "true");
    }
  }
  const agentId = values.get("agent-id");
  if (agentId === undefined || agentId.trim() === "") {
    throw new Error("--agent-id is required.");
  }
  const capDay = values.get("cap-day");
  if (capDay === undefined) throw new Error("--cap-day is required (in BNB).");
  const marketsRaw = values.get("markets") ?? "";
  const markets = marketsRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      if (!isAddress(entry, { strict: false })) {
        throw new Error(`--markets contains "${entry}", which is not an address.`);
      }
      return getAddress(entry);
    });
  if (markets.length === 0) {
    throw new Error(
      "--markets is required: a guard with no market it may pay is a promise the agent cannot keep.",
    );
  }
  const tokenCaps = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry !== "--token-cap" && !entry?.startsWith("--token-cap=")) continue;
    const raw = entry.startsWith("--token-cap=")
      ? entry.slice("--token-cap=".length)
      : (argv[i + 1] ?? "");
    const [token, amount] = raw.split("=");
    if (
      token === undefined
      || amount === undefined
      || !isAddress(token, { strict: false })
    ) {
      throw new Error(`--token-cap must be "<underlying>=<amount>"; got "${raw}".`);
    }
    tokenCaps.set(getAddress(token).toLowerCase(), amount);
  }
  const ttlSec = Number(values.get("ttl-sec") ?? String(MAX_VENUS_SESSION_SECONDS));
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
    throw new Error("--ttl-sec must be a positive integer number of seconds.");
  }
  return { agentId: agentId.trim(), capDay, markets, tokenCaps, ttlSec };
}

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

function sessionKeyFor(agentId: string): {
  key: Hex;
  varName: string;
  generated: boolean;
} {
  const varName = `AGENT_SESSION_KEY_${agentId.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`;
  const existing = readEnvValue(varName);
  if (existing !== undefined && existing.trim() !== "") {
    return { key: existing.trim() as Hex, varName, generated: false };
  }
  const key = generatePrivateKey();
  writeEnvValue(varName, key);
  return { key, varName, generated: true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (IS_MAINNET) assertMainnetConfirmed();

  if (!resolveVenusEnabled(process.env)) {
    throw new Error(
      'VENUS_ENABLED is not "true"; provisioning refuses on a deployment that has not enabled the guard.',
    );
  }
  if (NETWORK.chainId !== 56) {
    throw new Error(
      `The Venus guard is chain-56 only; this run resolves chain ${NETWORK.chainId}.`,
    );
  }
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required: an agent written to the in-memory store would vanish " +
        "when this script exits, and the running service would still 404.",
    );
  }
  if ((process.env["EXECUTION_MASTER_KEY"] ?? "").trim() === "") {
    throw new Error(
      "EXECUTION_MASTER_KEY is required: the Postgres store refuses to persist a " +
        "session key without encryption configured.",
    );
  }

  const venue = resolveVenusVenue(process.env);
  const readerNetwork = {
    chain: NETWORK.chain,
    chainId: NETWORK.chainId,
    publicRpcUrl: NETWORK.publicRpcUrl,
  };
  const rpcUrls = resolveVenusRpcUrls(process.env, readerNetwork);
  const readers = createVenusChainReaders({
    network: readerNetwork,
    rpcUrls,
    venue,
    markets: args.markets,
  });

  // vBNB is PINNED BY ADDRESS and validated against the chain here (R2.15/R15):
  // "is this market native" is a local constant, never a `symbol()` match in an
  // advisory cache, because it decides the CALLDATA SHAPE.
  const client = createPublicClient({
    chain: NETWORK.chain,
    transport: http(rpcUrls[0] ?? NETWORK.publicRpcUrl),
  });
  const vBnbSymbol = await client.readContract({
    address: venue.vBnb,
    abi: VENUS_VTOKEN_ABI,
    functionName: "symbol",
  });
  if (vBnbSymbol !== "vBNB") {
    throw new Error(
      `VENUS_VBNB_ADDRESS ${venue.vBnb} reports symbol "${vBnbSymbol}", not "vBNB". ` +
        "The native market decides the calldata shape; refusing to guess.",
    );
  }

  // Split the markets into the native one and the ERC-20 ones, and read each
  // ERC-20 market's own `underlying()` — never a cached symbol-derived flag.
  const vTokens: Address[] = [];
  let includeVBnb = false;
  const tokens: VenusTokenGrant[] = [];
  for (const market of args.markets) {
    if (market.toLowerCase() === venue.vBnb.toLowerCase()) {
      includeVBnb = true;
      continue;
    }
    vTokens.push(market);
    const underlying = getAddress(
      await client.readContract({
        address: market,
        abi: VENUS_VTOKEN_ABI,
        functionName: "underlying",
      }),
    );
    const decimals = await client.readContract({
      address: underlying,
      abi: [
        { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
      ] as const,
      functionName: "decimals",
    });
    const capRaw = args.tokenCaps.get(underlying.toLowerCase());
    if (capRaw === undefined) {
      throw new Error(
        `No --token-cap for ${underlying} (the underlying of ${market}). Venus per-token ` +
          "caps are SIZED, never defaulted: the cap is the ONLY bound on a leaked session " +
          "key's approve-spender drain, because CallRule cannot constrain the spender. " +
          `Pass --token-cap ${underlying}=<amount>.`,
      );
    }
    tokens.push({
      token: underlying,
      vToken: market,
      dailyCapWei: parseUnits(capRaw, decimals),
    });
  }

  // R3.12 — the routing census, re-read and enforced BEFORE the grant.
  const routing = await readers.readRoutingCensus(vTokens);

  const onChainDailyCapWei = parseEther(args.capDay);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const spec = venusSessionSpec({
    comptroller: venue.comptroller,
    prime: venue.prime,
    ...(includeVBnb ? { vBnb: venue.vBnb } : {}),
    vTokens,
    tokens,
    treasury: venue.treasury,
    nativeCaps: [{ limit: onChainDailyCapWei, period: "day" }],
    expiresAt: nowSeconds + args.ttlSec,
    nowSeconds,
    routing,
  });

  const provider = new AltanaProvider({ network: NETWORK, rpcUrls: [...RPC_URLS] });
  const owner = authorityFromPrivateKey(ownerKey());
  const wallet = await provider.resolveOwnerWallet({ owner });
  const balance = await provider.getBalance({ address: wallet.address });

  const exposure = venusExposureProduct({
    nativeDailyCapWei: onChainDailyCapWei,
    tokens,
    sessionSeconds: spec.expiresAt - nowSeconds,
  });

  console.log(`network        : ${NETWORK.chainId} (${IS_MAINNET ? "MAINNET" : "testnet"})`);
  console.log(`owner wallet   : ${wallet.address}`);
  console.log(`balance        : ${balance} wei ${UNIT}`);
  console.log(`agent id       : ${args.agentId}`);
  console.log(`session expires: ${new Date(spec.expiresAt * 1000).toISOString()}`);
  console.log(`routing census : claimVenus facet ${routing.claimVenusFacet}`);
  console.log(`                 Prime impl      ${routing.primeImplementation}`);
  for (const [vToken, implementation] of routing.vTokenImplementations) {
    console.log(`                 ${vToken} -> ${implementation}`);
  }
  console.log("                 UNCHANGED since the recorded census; the grant proceeds.");
  console.log(`allowlist      : ${spec.allowedCalls.length} rules`);
  for (const rule of spec.allowedCalls) {
    console.log(`  - ${rule.to ?? "(any target)"}${rule.selector ? ` :: ${rule.selector}` : ""}`);
  }
  console.log(`granted set    : ${VENUS_GRANTED_SELECTORS.join(", ")}`);
  if (includeVBnb) {
    console.log(
      "NOTE           : vBNB is granted REPAY-ONLY (Revision 4 / FINDINGS (at)) — " +
        "no mint(): a native supply mints a position an EIP-7702 wallet cannot redeem. " +
        "Use vWBNB for BNB-side collateral.",
    );
  }
  console.log(`REFUSED set    : ${VENUS_REFUSED_SELECTORS.join(", ")}`);

  // FINDINGS (r), restated by R3.2: the PRODUCT, never the rate alone.
  console.log(
    `EXPOSURE       : native ${onChainDailyCapWei} wei/day x ${exposure.periods} periods ` +
      `= ${exposure.nativeProductWei} wei over this session`,
  );
  for (const entry of exposure.tokenProducts) {
    console.log(
      `                 ${entry.token} cap x ${exposure.periods} periods = ${entry.productWei} base units`,
    );
  }
  console.log(
    "                 A leaked session key reaches `approve` on each of those underlyings " +
      "with an UNCONSTRAINED SPENDER, bounded ONLY by that cap for the period. The cap is " +
      "a BUDGET, not a gate. Altana caps are rolling per period with no lifetime ceiling, " +
      "which is why the product above is the number that matters.",
  );

  const sizing = checkVenusNativeCapSizing({
    onChainDailyCapWei,
    rescueReserveCount: DEFAULT_VENUS_RESCUE_RESERVE_COUNT,
    maxClaimsPerDay: 4,
    maxNativeActionWei: includeVBnb ? onChainDailyCapWei / 4n : 0n,
  });
  console.log(
    `sizing         : ${sizing.ok ? "ok" : `WARNING — ${sizing.message}`}`,
  );
  console.log(
    "                 This is an EARLY WARNING and not a guarantee: it reserves " +
      "per-submission arithmetic on RELAY_FEE_PER_EXIT_WEI, still a 4x-padded guess on ONE " +
      "mainnet sample, and a rescue is NEVER refused for want of headroom.",
  );

  if (balance === 0n) {
    console.error(
      `\nRefusing to grant: ${wallet.address} holds no ${UNIT}. ` +
        "The grant costs gas paid by this wallet. Fund it and re-run.",
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
      httpRuntimeProfile: "venus-v1",
      id: args.agentId,
      ownerAddress: wallet.ownerAddress,
      walletAddress: wallet.address,
      custodyModel: wallet.custodyModel,
      sessionFacts: {
        spec,
        permissions: validateSessionSpec(spec),
        publicKey: granted.publicKey,
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
    "\nNEXT: the guard is NOT armed yet. Arm it with the owner-signed " +
      "`POST /agents/:id/venus/settings` (thresholds, market lists, per-action ceilings) " +
      "— that route is also where the data-plane tracking PUT is issued from, so both " +
      "self-serve hire and this script converge on the same seam.",
  );
  console.log(
    "NOTE: `agent.caps` is deliberately NOT set here. Venus RESCUES are not gated by the " +
      "off-chain daily cap (a guard that can rescue once per day is not a guard); claims " +
      "are. The owner view states which budgets bind which actions.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
