/**
 * Add a per-token spend limit to a LIVE session, signed by the owner.
 *
 * WHY THIS EXISTS
 *
 * A session carries two independent grants: an allowlist of calls it may make,
 * and a spend limit per token it may move. `tradeSessionSpec` granted the first
 * for every token (a bare-selector `approve`) and the second for native BNB
 * only — which is incoherent, and on chain it means an agent can BUY and can
 * never SELL. A sell approves the router, `GuardedExecutor` counts an approve
 * as spending that token, finds no limit for it, and the batch reverts in
 * simulation, so the relay never submits it: `PENDING`, no gas, no trade.
 *
 * VERIFIED on BNB mainnet (2026-08-12) by simulation:
 *   - `setSpendLimit` called from the wallet itself SUCCEEDS;
 *   - the same call from any other sender REVERTS.
 *
 * Under EIP-7702 the wallet IS the owner's EOA, so the owner satisfies that
 * self-call with an ordinary transaction. That makes adding a cap far cheaper
 * than re-granting: no KeyStore registration fee, no relay, no new session, and
 * the agent's existing session keeps working.
 *
 * A session key CANNOT do this for itself — `GuardedExecutor` refuses a
 * self-call made through a key (`CannotSelfExecute`), which is exactly what
 * stops a session from widening its own authority. Only the owner can.
 *
 * STILL NEEDED AFTER PHASE2.3. `tradeSessionSpec` now grants both halves at
 * hire — an `approve` rule AND a cap per token named at hire — so the gap above
 * no longer opens by construction. It still opens for a token that DID NOT
 * EXIST at grant time (a launchpad token), whose address could not have been in
 * the grant. This script is the way to add one to a live session, unchanged.
 *
 * USAGE
 *   npx tsx scripts/owner-add-spend-limit.ts \
 *     --session-var AGENT_SESSION_KEY_TEST_2 \
 *     --tokens 0xaaa,0xbbb --limit 1 \
 *     --confirm i-understand-real-funds
 *
 *   npx tsx scripts/owner-add-spend-limit.ts \
 *     --session-var AGENT_SESSION_KEY_TEST_2 \
 *     --native-cap 0.05 \
 *     --confirm i-understand-real-funds
 *
 * `--native-cap <BNB>` (PHASE2.5) raises the NATIVE day cap on the live
 * session, and it is the ONLY remedy for a `NATIVE_RESERVE` refusal: F1 stops
 * taking buys once the meter no longer holds an exit's worth of headroom, and
 * only the owner can widen that meter. It writes the spend-limit leg alone —
 * see the note beside `--native-cap` in `main`.
 *
 * `--limit` is in whole tokens' smallest unit? No: it is a CAP, and the honest
 * default is generous, because a cap that is too small silently blocks an exit.
 * Pass `--limit max` (the default) for an effectively unbounded per-token cap,
 * or a raw integer for a specific one.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  padHex,
  parseEther,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB, BNB_TESTNET } from "@altananetwork/sdk";
import { bsc, bscTestnet } from "viem/chains";
import { readEnvValue } from "./spike/env.js";

const MAINNET_CONFIRMATION = "i-understand-real-funds";

/** Spend period enum on GuardedExecutor. 2 is what the trade template grants. */
const PERIOD_DAY = 2;

/** An effectively unbounded per-token cap: the account stores it as uint256. */
const UNBOUNDED = 2n ** 160n;

/** `approve(address,uint256)`, the one selector a sell needs on the token. */
const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)");

const OWNER_GRANT_ABI = [
  {
    /**
     * The keys the account carries. Read first, so a stale `--session-var`
     * costs a call and not two transactions.
     */
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "keys",
        type: "tuple[]",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
      { name: "keyHashes", type: "bytes32[]" },
    ],
  },
  {
    /**
     * The allowlist half. `setSpendLimit` does NOT imply it — see the loop in
     * `main` for why granting only the limit leaves the position stuck.
     */
    name: "setCanExecute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "fnSel", type: "bytes4" },
      { name: "can", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "setSpendLimit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "period", type: "uint8" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "spendInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [
      {
        name: "results",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "period", type: "uint8" },
          { name: "limit", type: "uint256" },
          { name: "spent", type: "uint256" },
          { name: "lastUpdated", type: "uint256" },
          { name: "currentSpent", type: "uint256" },
          { name: "current", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/** keccak256(abi.encode(uint256(2), keccak256(bytes32(address)))) — secp256k1. */
function accountKeyHash(address: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [2n, keccak256(padHex(getAddress(address), { size: 32 }))],
    ),
  );
}

function arg(name: string, fallback?: string): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry === `--${name}`) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("--") ? next : "true";
    }
    if (entry?.startsWith(`--${name}=`) === true) return entry.slice(name.length + 3);
  }
  if (fallback === undefined) throw new Error(`--${name} is required.`);
  return fallback;
}

async function main(): Promise<void> {
  const isMainnet = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
  const chain = isMainnet ? bsc : bscTestnet;
  const keyStore = getAddress((isMainnet ? BNB : BNB_TESTNET).keyStore);

  // Optional since `--venue` exists: a run may authorise a venue, tokens, or
  // both. A run that names neither is a mistake and says so rather than sending
  // nothing and reporting success.
  const tokens = arg("tokens", "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "" && t !== "true")
    .map((t) => getAddress(t));
  // PHASE2.5. The NATIVE day cap, which had no operator path at all.
  //
  // The on-chain call was always here — `setSpendLimit(keyHash, token, DAY,
  // limit)` — and the native meter is simply the zero-address row at the same
  // period. What was missing is a way to write ONLY that leg: the token loop
  // below grants a spend limit AND an `approve` allowlist together, and an
  // `approve` allowlist on the zero address is meaningless.
  //
  // It matters because PHASE2.5 F1 REFUSES a buy that would leave too little
  // native to pay for its own exit. A refusal an owner cannot act on is worse
  // than the trap it prevents, so the remedy ships with the gate.
  const nativeCapRaw = arg("native-cap", "");
  const nativeCapWei =
    nativeCapRaw === "" || nativeCapRaw === "true" ? null : parseEther(nativeCapRaw);
  const limitRaw = arg("limit", "max");
  const limit = limitRaw === "max" ? UNBOUNDED : BigInt(limitRaw);
  const sessionVar = arg("session-var");

  // `--venue 0x…` adds a VENUE to the session's allowlist. Optional, and the
  // default selector is flap's `swapExactInput`, which is the case this was
  // written for: a session granted before PHASE2.4 has every other venue but
  // not the Portal. Pass `--venue-signature` for a different one.
  const venueRaw = arg("venue", "");
  const venue = venueRaw === "" || venueRaw === "true" ? null : getAddress(venueRaw);
  const venueSignature = arg(
    "venue-signature",
    "swapExactInput((address,address,uint256,uint256,bytes))",
  );
  const venueSelector = toFunctionSelector(`function ${venueSignature}`);

  if (isMainnet && arg("confirm", "") !== MAINNET_CONFIRMATION) {
    throw new Error(
      `This signs a real transaction on chain ${chain.id}. ` +
        `Re-run with --confirm ${MAINNET_CONFIRMATION}.`,
    );
  }

  const ownerKeyVar = readEnvValue("SPIKE_OWNER_KEY_VAR") ?? "OWNER_TEST_KEY";
  const ownerKey = readEnvValue(ownerKeyVar);
  const sessionKey = readEnvValue(sessionVar);
  if (ownerKey === undefined || ownerKey.trim() === "") {
    throw new Error(`No owner key: ${ownerKeyVar} is unset.`);
  }
  if (sessionKey === undefined || sessionKey.trim() === "") {
    throw new Error(`No session key: ${sessionVar} is unset.`);
  }

  const owner = privateKeyToAccount(ownerKey.trim() as Hex);
  const wallet = owner.address; // EIP-7702: the wallet IS the owner's EOA.
  const keyHash = accountKeyHash(privateKeyToAccount(sessionKey.trim() as Hex).address);

  const rpc = isMainnet ? "https://bsc-dataseed.bnbchain.org" : chain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account: owner, chain, transport: http(rpc) });

  console.log(`network : ${chain.id} (${isMainnet ? "MAINNET" : "testnet"})`);
  console.log(`wallet  : ${wallet}`);
  console.log(`keyHash : ${keyHash}`);
  console.log(`limit   : ${limit}${limitRaw === "max" ? " (effectively unbounded)" : ""}`);
  console.log(`tokens  : ${tokens.length}`);

  // IS THIS KEY EVEN ON THE ACCOUNT? Ask before spending anything.
  //
  // `setSpendLimit` and `setCanExecute` do NOT check that the key exists — they
  // write storage for whatever hash they are handed. Point this script at a
  // stale `--session-var` (an old key, a testnet key, a session that was never
  // granted) and both legs land, cost real gas, and authorise a key that will
  // never sign anything. The failure only surfaced at the closing `canExecute`
  // report, which reverts `KeyDoesNotExist()` — after the money was spent, as a
  // raw decode error. Measured live: two writes, nothing authorised.
  const [, keyHashes] = await publicClient.readContract({
    address: wallet, abi: OWNER_GRANT_ABI, functionName: "getKeys",
  });
  if (!keyHashes.some((registered) => registered.toLowerCase() === keyHash.toLowerCase())) {
    throw new Error(
      `${sessionVar} is not a session on this wallet — its key hash ${keyHash} is not ` +
        `among the ${keyHashes.length} registered on ${wallet}. Writing to it would cost gas ` +
        `and authorise nothing. Check that the var names the session the agent is actually ` +
        `running (dev-stack prints the one it granted).`,
    );
  }

  if (tokens.length === 0 && venue === null && nativeCapWei === null) {
    throw new Error(
      `Nothing to grant: pass --tokens, --venue, --native-cap, or any combination.`,
    );
  }
  if (nativeCapWei !== null && nativeCapWei <= 0n) {
    throw new Error("--native-cap must be greater than zero.");
  }

  const before = await publicClient.readContract({
    address: wallet, abi: OWNER_GRANT_ABI, functionName: "spendInfos", args: [keyHash],
  });
  console.log(`existing spend permissions: ${before.length}`);

  // A VENUE, for a session granted before that venue existed.
  //
  // Tokens are only half of what a trade needs: the batch also calls the venue,
  // and a session granted before flap.sh shipped has no allowlist entry for the
  // Portal. Re-granting to add one costs a KeyStore registration fee; this is
  // the same owner self-call the token legs use, and since PHASE2.4 the server
  // honours what the chain says rather than only what the grant said, so it
  // takes effect without a new session.
  //
  // NO SPEND CAP HERE, deliberately: a venue is not a token, the native the
  // trade spends is already metered by the native cap, and a cap on a router
  // address would meter nothing. Same reasoning as the treasury rule (PHASE2.3
  // R10).
  //
  // The two targets the execution plane refuses unconditionally are refused
  // here too (PHASE2.4 R1). This script cannot be the way around a rule the
  // server enforces: granting the session a route into the wallet's own admin
  // surface, or into the KeyStore that bounds it, is the one escalation that
  // must stay owner-only.
  if (venue !== null) {
    if (venue.toLowerCase() === wallet.toLowerCase()) {
      throw new Error(`--venue is the wallet itself. That is the account's own admin surface.`);
    }
    if (venue.toLowerCase() === keyStore.toLowerCase()) {
      throw new Error(`--venue is the KeyStore that bounds this session. Refused.`);
    }
    console.log(`\nvenue   : ${venue}  selector ${venueSelector} (${venueSignature})`);
    await publicClient.simulateContract({
      address: wallet, abi: OWNER_GRANT_ABI, functionName: "setCanExecute",
      args: [keyHash, venue, venueSelector, true], account: owner,
    });
    const hash = await walletClient.writeContract({
      address: wallet, abi: OWNER_GRANT_ABI, functionName: "setCanExecute",
      args: [keyHash, venue, venueSelector, true],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `${venue}  venue allowlist   ${receipt.status}  gas ${receipt.gasUsed}  ` +
        `${isMainnet ? "https://bscscan.com/tx/" : "https://testnet.bscscan.com/tx/"}${hash}`,
    );
  }

  // THE NATIVE CAP, ALONE — one leg, deliberately.
  //
  // No `approve` allowlist: native is not a token, there is nothing to approve,
  // and bundling one would make this refuse for a reason that does not apply.
  if (nativeCapWei !== null) {
    // PHASE2.5-AUDIT A8 — `setSpendLimit` writes an ABSOLUTE limit, so this flag
    // can LOWER the cap it exists to raise. The owner reading a NATIVE_RESERVE
    // refusal is here to unblock an agent; a number below the current cap
    // tightens the meter, F1 refuses harder, and the same message points them
    // back at the same command. Refuse, and say what the current value is.
    const currentNativeDay = before.find(
      (info) => info.token === zeroAddress && Number(info.period) === PERIOD_DAY,
    );
    const lowering = arg("lower", "") === "true";
    if (
      currentNativeDay !== undefined &&
      nativeCapWei <= currentNativeDay.limit &&
      !lowering
    ) {
      throw new Error(
        `--native-cap ${nativeCapWei} wei is not above the current native day cap ` +
          `of ${currentNativeDay.limit} wei, so this would TIGHTEN the meter rather ` +
          `than raise it — and a tighter meter is what refused the buy. Pass a ` +
          `larger number, or --lower if you genuinely mean to reduce it.`,
      );
    }
    console.log(
      `\nnative day cap: ${nativeCapWei} wei — the zero-address row at period DAY, ` +
        `which is the meter PHASE2.5 F1 reads before every buy` +
        (currentNativeDay === undefined
          ? " (no native day row exists yet: this GRANTS one)"
          : ` (currently ${currentNativeDay.limit} wei, spent ${currentNativeDay.currentSpent})`),
    );
    await publicClient.simulateContract({
      address: wallet, abi: OWNER_GRANT_ABI, functionName: "setSpendLimit",
      args: [keyHash, zeroAddress, PERIOD_DAY, nativeCapWei], account: owner,
    });
    const hash = await walletClient.writeContract({
      address: wallet, abi: OWNER_GRANT_ABI, functionName: "setSpendLimit",
      args: [keyHash, zeroAddress, PERIOD_DAY, nativeCapWei],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `NATIVE BNB  day cap          ${receipt.status}  gas ${receipt.gasUsed}  ` +
        `${isMainnet ? "https://bscscan.com/tx/" : "https://testnet.bscscan.com/tx/"}${hash}`,
    );
  }

  for (const token of tokens) {
    // AUTHORISING A TOKEN TAKES TWO GRANTS, NOT ONE.
    //
    // A sell approves the venue, and the account checks that against BOTH an
    // allowlist entry and a spend limit. Until PHASE2.3 the template granted
    // `approve` as a bare selector — every token on the chain — so only the
    // limit was ever missing and this script only set that. 2.3 narrowed the
    // allowlist to one entry per token, which is the right security trade but
    // silently halved this remediation: measured on chain, a token given only a
    // limit reports `canExecute(approve) = false`, its sell never submits, and
    // the position is stuck exactly as if nothing had been authorised.
    //
    // So both halves are granted here, in one loop, and a token gets neither if
    // either simulation fails — a half-authorised token is the failure mode this
    // comment exists to prevent.
    const legs = [
      {
        name: "spend limit",
        args: [keyHash, token, PERIOD_DAY, limit] as const,
        functionName: "setSpendLimit" as const,
      },
      {
        name: "approve allowlist",
        args: [keyHash, token, APPROVE_SELECTOR, true] as const,
        functionName: "setCanExecute" as const,
      },
    ];

    let simulated = true;
    for (const leg of legs) {
      try {
        await publicClient.simulateContract({
          address: wallet,
          abi: OWNER_GRANT_ABI,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrowed by the literal union above
          functionName: leg.functionName,
          args: leg.args as never,
          account: owner,
        });
      } catch (error) {
        console.error(
          `\n${token}: ${leg.name} simulation failed, sending NEITHER leg — ` +
            `${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`,
        );
        simulated = false;
        break;
      }
    }
    if (!simulated) continue;

    for (const leg of legs) {
      const hash = await walletClient.writeContract({
        address: wallet,
        abi: OWNER_GRANT_ABI,
        functionName: leg.functionName,
        args: leg.args as never,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(
        `${token}  ${leg.name.padEnd(17)} ${receipt.status}  gas ${receipt.gasUsed}  ` +
          `${isMainnet ? "https://bscscan.com/tx/" : "https://testnet.bscscan.com/tx/"}${hash}`,
      );
    }
  }

  const after = await publicClient.readContract({
    address: wallet, abi: OWNER_GRANT_ABI, functionName: "spendInfos", args: [keyHash],
  });
  console.log(`\nspend permissions now: ${after.length}`);
  for (const info of after) {
    const label =
      info.token === "0x0000000000000000000000000000000000000000" ? "NATIVE BNB" : info.token;
    console.log(`  ${label}  period=${info.period}  limit=${info.limit}  spent=${info.currentSpent}`);
  }

  // Report BOTH halves, because a token with a limit and no allowlist entry
  // looks authorised in the list above and still cannot be sold. That gap is
  // what made a live position stick; printing it is how the next operator finds
  // out in a second rather than after a trade.
  console.log(`\ncan the session approve each token? (the OTHER half)`);
  const probeData = `0x095ea7b3${"0".repeat(24)}${wallet.slice(2).toLowerCase()}${"1".padStart(64, "0")}` as Hex;
  for (const token of tokens) {
    const can = await publicClient.readContract({
      address: wallet, abi: OWNER_GRANT_ABI, functionName: "canExecute",
      args: [keyHash, token, probeData],
    });
    console.log(`  ${token}  ${can ? "YES — sellable" : "NO  — the sell would never submit"}`);
  }

  await reportServerVerdict();
}

/**
 * AND THE THIRD LAYER: what the SERVER will do with this token.
 *
 * Both on-chain halves above can be granted and the execution plane can still
 * refuse — that is FINDINGS (v), and it made this whole script inert for a
 * newly-authorised token. Phase 2.4's pre-flight asks the chain when its own
 * snapshot refuses, so a token added here now works with no re-grant. On an
 * OLDER server it does not.
 *
 * The answer is READ FROM THE SERVER, never from a constant compiled in here.
 * A post-2.4 script telling an operator "this works now" about a pre-2.4 server
 * is FINDINGS (u)'s "a half grant reported as success" one level up: two
 * processes, one of which knows, and it is not this one. When the server cannot
 * be reached the honest output is the REQUIREMENT, not a guess.
 */
async function reportServerVerdict(): Promise<void> {
  const baseUrl = (process.env["EXECUTION_URL"] ?? "http://127.0.0.1:8090").replace(
    /\/$/,
    "",
  );
  const requirement =
    "requires execution plane >= 2.4; on an older build this token is still " +
    "refused by the local pre-flight even though the chain allows it";
  let version: string | undefined;
  try {
    // `/health` is deliberately credential-free, so this needs no exec token.
    // Timed out rather than left to hang (PHASE2.4 audit A7): this runs AFTER
    // the two grants have landed, so a server that accepts the connection and
    // never answers would strand an operator staring at a blank line with the
    // money already spent. Unknown is a fine answer here; hanging is not.
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
    const body = (await res.json()) as { data?: { version?: unknown } };
    const reported = body.data?.version;
    if (typeof reported === "string") version = reported;
  } catch {
    // Unreachable is not "old" and not "new". Say so.
  }

  console.log(`\nwill the SERVER submit a sell for these tokens?`);
  if (version === undefined) {
    console.log(`  unknown — ${baseUrl}/health did not answer. ${requirement}.`);
    return;
  }
  const [major = 0, minor = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const supported = major > 2 || (major === 2 && minor >= 4);
  console.log(
    supported
      ? `  YES — ${baseUrl} reports version ${version}: its pre-flight asks the chain ` +
          `when the granted snapshot refuses, so no re-grant is needed.`
      : `  NO — ${baseUrl} reports version ${version}. ${requirement}. Until it is ` +
          `upgraded, the only way to sell this token is a fresh session that lists it.`,
  );
}

main().catch((error: unknown) => {
  console.error(`\nfailed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
